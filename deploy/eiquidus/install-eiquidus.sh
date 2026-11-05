#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID -eq 0 ]] || exit 1
exec 9>/run/lock/eiquidus-install.lock
flock -n 9 || { echo 'another eIquidus installation is active' >&2; exit 1; }
STAGING=/var/lib/eiquidus/staging
[[ -d $STAGING && $(stat -c %u "$STAGING") -eq 0 && $(stat -c %a "$STAGING") == 700 ]] || { echo 'root-only staging directory required' >&2; exit 1; }
ARCHIVE=$STAGING/eiquidus-release.tar.gz
SUM=$STAGING/eiquidus-release.sha256
ID=$STAGING/eiquidus-release.id
SETTINGS=$STAGING/settings.json
[[ -f $ARCHIVE && -f $SUM && -f $ID && -f $SETTINGS ]] || { echo 'stage release archive, checksum, id, and settings' >&2; exit 1; }
for staged_file in "$ARCHIVE" "$SUM" "$ID" "$SETTINGS"; do
  [[ ! -L $staged_file && $(stat -c %u "$staged_file") -eq 0 && $(stat -c %a "$staged_file") == 600 ]] || { echo 'staged files must be regular root-owned mode-0600 files' >&2; exit 1; }
done
[[ -f /etc/eiquidus/mongodb-app.json && ! -L /etc/eiquidus/mongodb-app.json \
  && $(stat -c %u /etc/eiquidus/mongodb-app.json) -eq 0 \
  && $(stat -c %a /etc/eiquidus/mongodb-app.json) == 640 ]] \
  || { echo 'safe MongoDB application credentials required' >&2; exit 1; }
release=$(tr -d '[:space:]' <"$ID")
expected=$(tr -d '[:space:]' <"$SUM")
[[ $release =~ ^[0-9a-f]{40}$ && $expected =~ ^[0-9a-f]{64}$ ]]
[[ $release == ${expected:0:40} ]] || { echo 'release id does not match archive checksum' >&2; exit 1; }
[[ $(sha256sum "$ARCHIVE" | cut -d' ' -f1) == "$expected" ]] || { echo 'release checksum mismatch' >&2; exit 1; }

# --- Authenticated extraction / re-execution boundary (addresses I-01) ---
# The initial invocation (which may be untrusted) may only validate the staged archive
# and extract + re-execute the installer from the verified payload. All mutations happen
# only after re-exec of the candidate that came from the checksum-verified archive.
if [[ -z "${EIQUIDUS_VERIFIED_ROOT:-}" ]]; then
  verification_stage=$(mktemp -d "$STAGING/.verified.XXXXXX")
  tar -xzf "$ARCHIVE" -C "$verification_stage" --strip-components=1 --no-same-owner --no-same-permissions
  candidate_installer="$verification_stage/deploy/eiquidus/install-eiquidus.sh"
  [[ -f "$candidate_installer" && -f "$verification_stage/package-lock.json" && -f "$verification_stage/deploy/eiquidus/publish-release.py" ]] || {
    echo 'verified extraction missing required payload (package-lock.json, publish-release.py, installer)' >&2
    rm -rf -- "$verification_stage" 2>/dev/null || true
    exit 1
  }
  # Re-execute *only* the installer that was part of the authenticated archive.
  exec env \
    -u EIQUIDUS_MONGODB_INDEX_MIGRATION \
    -u EIQUIDUS_MONGODB_CREDENTIALS \
    -u EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME \
    EIQUIDUS_VERIFIED_ROOT="$verification_stage" "$candidate_installer" "$@"
fi

# From this point we are executing the installer that was extracted from the verified archive.
self_path=$(readlink -f "$0" 2>/dev/null || echo "$0")
[[ "$self_path" == "$EIQUIDUS_VERIFIED_ROOT/deploy/eiquidus/install-eiquidus.sh" ]] || {
  echo 'refusing to run: executing installer is not the authenticated extracted candidate' >&2
  exit 1
}
unset EIQUIDUS_MONGODB_INDEX_MIGRATION EIQUIDUS_MONGODB_CREDENTIALS EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME

for unit in eiquidus-web.service eiquidus-sync.service eiquidus-sync.timer eiquidus-backup.service eiquidus-backup.timer; do
  ! systemctl is-active --quiet "$unit" || { echo "$unit must be inactive during installation" >&2; exit 1; }
done

target=/opt/eiquidus/releases/$release
nginx_config=/etc/nginx/sites-available/maria-production-$release.conf
[[ ! -e $target && ! -L $target ]] || { echo 'release target already exists' >&2; exit 1; }
[[ ! -e /opt/eiquidus/current || -L /opt/eiquidus/current ]] || { echo 'current must be absent or a symlink' >&2; exit 1; }

# Qualify the authenticated candidate before touching shared application files,
# CSS, systemd, nginx, the release pointer, or MongoDB. This invocation uses the
# ordinary read-only index policy and therefore also fails closed on a pending
# orphan-reconciliation fence. Privileged index migration is a separate,
# explicitly authorized maintenance operation, never an installer side effect.
(cd "$EIQUIDUS_VERIFIED_ROOT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
EIQUIDUS_RELEASE_ROOT="$EIQUIDUS_VERIFIED_ROOT" \
  EIQUIDUS_MONGODB_CREDENTIALS=/etc/eiquidus/mongodb-app.json \
  EIQUIDUS_MONGODB_INDEX_MIGRATION=0 \
  EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME=0 \
  /usr/local/bin/node "$EIQUIDUS_VERIFIED_ROOT/deploy/eiquidus/mongodb-preflight.js"

rollback_dir=$(mktemp -d /var/tmp/eiquidus-rollback.XXXXXX)
trap 'rm -rf -- "$rollback_dir"' EXIT
stage=''
previous_current=''
[[ -L /opt/eiquidus/current ]] && previous_current=$(readlink /opt/eiquidus/current)
published=false
committed=false
created_css=()
managed=(
  /etc/eiquidus/settings.json
  /usr/local/libexec/eiquidus/preflight.sh
  /usr/local/libexec/eiquidus/mongodb-preflight.js
  /usr/local/libexec/eiquidus/verify-index.js
  /usr/local/libexec/eiquidus/backup-eiquidus.sh
  /usr/local/libexec/eiquidus/verify-eiquidus-backup.sh
  /etc/systemd/system/eiquidus-web.service
  /etc/systemd/system/eiquidus-sync.service
  /etc/systemd/system/eiquidus-sync.timer
  /etc/systemd/system/eiquidus-backup.service
  /etc/systemd/system/eiquidus-backup.timer
  "$nginx_config"
  /etc/nginx/sites-available/maria-maintenance.conf
  /etc/nginx/sites-available/maria-maintenance-tls.conf
  /var/www/maintenance/maintenance.html
  /var/www/maintenance/maria-logo.png
)
for index in "${!managed[@]}"; do
  [[ ! -e ${managed[$index]} && ! -L ${managed[$index]} ]] || cp -a -- "${managed[$index]}" "$rollback_dir/$index"
done

directory_paths=(
  /opt/eiquidus
  /opt/eiquidus/releases
  /usr/local/libexec
  /usr/local/libexec/eiquidus
  /var/www
  /var/www/maintenance
  /var/backups
  /var/backups/mariacoin-explorer
  /var/lib/eiquidus
  /var/lib/eiquidus/tmp
  /var/lib/eiquidus/backups
  /var/lib/eiquidus/css
  /etc/eiquidus
)
declare -A directory_existed directory_uid directory_gid directory_mode
for index in "${!directory_paths[@]}"; do
  directory=${directory_paths[$index]}
  if [[ -d $directory && ! -L $directory ]]; then
    directory_existed[$index]=true
    directory_uid[$index]=$(stat -c %u "$directory")
    directory_gid[$index]=$(stat -c %g "$directory")
    directory_mode[$index]=$(stat -c %a "$directory")
  elif [[ ! -e $directory && ! -L $directory ]]; then
    directory_existed[$index]=false
  else
    echo "unsafe managed directory: $directory" >&2
    rm -rf -- "$rollback_dir"
    exit 1
  fi
done

rollback_install() {
  rc=$?
  trap - EXIT
  set +e
  if [[ $committed != true ]]; then
    if [[ -L /opt/eiquidus/current && $(readlink /opt/eiquidus/current) == "$target" ]]; then
      rm -f /opt/eiquidus/current
    fi
    if [[ -n $previous_current ]]; then
      ln -s "$previous_current" /opt/eiquidus/.current.rollback
      mv -Tf /opt/eiquidus/.current.rollback /opt/eiquidus/current
    fi
    for index in "${!managed[@]}"; do
      rm -rf -- "${managed[$index]}"
      [[ ! -e $rollback_dir/$index && ! -L $rollback_dir/$index ]] || cp -a -- "$rollback_dir/$index" "${managed[$index]}"
    done
    systemctl daemon-reload >/dev/null 2>&1 || true
    [[ $published != true ]] || rm -rf -- "$target"
    ((${#created_css[@]} == 0)) || rm -f -- "${created_css[@]}"
    for ((index=${#directory_paths[@]} - 1; index >= 0; index--)); do
      directory=${directory_paths[$index]}
      if [[ ${directory_existed[$index]} == true ]]; then
        chown "${directory_uid[$index]}:${directory_gid[$index]}" "$directory" || true
        chmod "${directory_mode[$index]}" "$directory" || true
      else
        rmdir -- "$directory" 2>/dev/null || true
      fi
    done
  fi
  [[ -z $stage ]] || rm -rf -- "$stage"
  [[ -z ${EIQUIDUS_VERIFIED_ROOT:-} ]] || rm -rf -- "$EIQUIDUS_VERIFIED_ROOT" || true
  rm -rf -- "$rollback_dir"
  exit "$rc"
}
trap rollback_install EXIT

[[ -d /opt/eiquidus/releases && ! -L /opt/eiquidus/releases \
  && $(stat -c %u /opt/eiquidus/releases) -eq 0 \
  && $(stat -c %g /opt/eiquidus/releases) -eq 0 \
  && $(stat -c %a /opt/eiquidus/releases) == 755 ]] \
  || { echo 'safe immutable release directory required' >&2; exit 1; }
stage=$(mktemp -d /opt/eiquidus/releases/.stage.XXXXXX)



# Source payload from the *authenticated* extracted candidate tree (EIQUIDUS_VERIFIED_ROOT).

# The archive was already validated + extracted before re-execution; we do not tar-extract it again.

cp -a "$EIQUIDUS_VERIFIED_ROOT"/. "$stage"/

[[ -f $stage/package-lock.json && -f $stage/deploy/eiquidus/publish-release.py ]] || { echo 'release payload incomplete' >&2; exit 1; }
rm -rf "$stage/tmp" "$stage/backups"
ln -s /var/lib/eiquidus/tmp "$stage/tmp"
ln -s /var/lib/eiquidus/backups "$stage/backups"
for generated_css in _theme-selector.scss style.min.css custom.min.css; do
  rm -f "$stage/public/css/$generated_css"
  ln -s "/var/lib/eiquidus/css/$generated_css" "$stage/public/css/$generated_css"
done
ln -s /etc/eiquidus/settings.json "$stage/settings.json"
chown -R root:root "$stage"
chmod -R u=rwX,go=rX "$stage"

# Revalidate the fully prepared candidate before publication. No shared CSS,
# application configuration, service, nginx, or database/index state has been
# changed at this point.
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$SETTINGS"
/usr/local/bin/maria-cli -conf=/etc/mariacoin/maria.conf -datadir=/var/lib/mariacoin getblockhash 0 | grep -Fx 0000040cb60b26f13ffcd2f692d679e172da34096041efe215d8c50cd65dd9f9
/usr/local/bin/maria-cli -conf=/etc/mariacoin/maria.conf -datadir=/var/lib/mariacoin getrawtransaction 09fabd30b14d79ae7c4c687ad9e4517974223108474d468181d32ff8d588fdee 1 >/dev/null
EIQUIDUS_RELEASE_ROOT="$stage" \
  EIQUIDUS_MONGODB_CREDENTIALS=/etc/eiquidus/mongodb-app.json \
  EIQUIDUS_MONGODB_INDEX_MIGRATION=0 \
  EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME=0 \
  /usr/local/bin/node "$stage/deploy/eiquidus/mongodb-preflight.js"
systemd-analyze verify \
  "$stage/deploy/systemd/eiquidus-web.service" \
  "$stage/deploy/systemd/eiquidus-sync.service" \
  "$stage/deploy/systemd/eiquidus-sync.timer" \
  "$stage/deploy/systemd/eiquidus-backup.service" \
  "$stage/deploy/systemd/eiquidus-backup.timer"

python3 "$stage/deploy/eiquidus/publish-release.py" "$stage" "$target"
published=true
new_current=/opt/eiquidus/.current.$$
ln -s "$target" "$new_current"
mv -Tf "$new_current" /opt/eiquidus/current

# Publication occurs while every application writer and public backend remains
# stopped in maintenance. Only now install rollback-protected shared state.
install -d -o root -g root -m 0755 /usr/local/libexec/eiquidus /var/www/maintenance
install -d -o root -g root -m 0700 /var/backups/mariacoin-explorer
install -d -o eiquidus -g eiquidus -m 0750 /var/lib/eiquidus/{tmp,backups,css}
install -d -o root -g eiquidus -m 0750 /etc/eiquidus
for generated_css in _theme-selector.scss style.min.css custom.min.css; do
  if [[ ! -e /var/lib/eiquidus/css/$generated_css ]]; then
    install -o eiquidus -g eiquidus -m 0640 /dev/null "/var/lib/eiquidus/css/$generated_css"
    created_css+=("/var/lib/eiquidus/css/$generated_css")
  fi
done
install -o root -g eiquidus -m 0640 "$SETTINGS" /etc/eiquidus/settings.json
chown root:eiquidus /etc/eiquidus/settings.json
install -o root -g root -m 0755 "$target/deploy/eiquidus/preflight.sh" /usr/local/libexec/eiquidus/preflight.sh
install -o root -g root -m 0644 "$target/deploy/eiquidus/mongodb-preflight.js" /usr/local/libexec/eiquidus/mongodb-preflight.js
install -o root -g root -m 0755 "$target/deploy/eiquidus/verify-index.js" /usr/local/libexec/eiquidus/verify-index.js
install -o root -g root -m 0755 "$target/deploy/eiquidus/backup-eiquidus.sh" /usr/local/libexec/eiquidus/backup-eiquidus.sh
install -o root -g root -m 0755 "$target/deploy/eiquidus/verify-eiquidus-backup.sh" /usr/local/libexec/eiquidus/verify-eiquidus-backup.sh
install -o root -g root -m 0644 "$target/deploy/nginx/production.conf" "$nginx_config"
install -o root -g root -m 0644 "$target/deploy/nginx/maintenance.conf" /etc/nginx/sites-available/maria-maintenance.conf
install -o root -g root -m 0644 "$target/deploy/nginx/maintenance-tls.conf" /etc/nginx/sites-available/maria-maintenance-tls.conf
install -o root -g root -m 0644 "$target/deploy/nginx/maintenance.html" /var/www/maintenance/maintenance.html
install -o root -g root -m 0644 "$target/public/img/maria-logo.png" /var/www/maintenance/maria-logo.png
install -o root -g root -m 0644 \
  "$target/deploy/systemd/eiquidus-web.service" \
  "$target/deploy/systemd/eiquidus-sync.service" \
  "$target/deploy/systemd/eiquidus-sync.timer" \
  "$target/deploy/systemd/eiquidus-backup.service" \
  "$target/deploy/systemd/eiquidus-backup.timer" \
  /etc/systemd/system/
python3 -c 'import json; json.load(open("/etc/eiquidus/settings.json"))'
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/eiquidus-{web,sync,backup}.service /etc/systemd/system/eiquidus-{sync,backup}.timer
/usr/local/libexec/eiquidus/preflight.sh

rm -f "$ARCHIVE" "$SUM" "$ID" "$SETTINGS"
[[ -z ${EIQUIDUS_VERIFIED_ROOT:-} ]] || rm -rf -- "$EIQUIDUS_VERIFIED_ROOT" || true
committed=true
trap - EXIT
rm -rf "$rollback_dir" || echo 'warning: rollback scratch cleanup failed' >&2
echo 'installed but not enabled; remain in maintenance until index verification'

