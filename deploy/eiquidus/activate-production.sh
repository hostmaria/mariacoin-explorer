#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s nullglob
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/explorer-host.sh"
HOST=$(read_explorer_host)
MARKER=/var/lib/eiquidus/INDEX_VERIFIED.json
BACKUP_MARKER=/var/lib/eiquidus/BACKUP_VERIFIED.json
CURRENT=/opt/eiquidus/current
CERT=/etc/letsencrypt/live/$HOST/fullchain.pem
ROLLBACK_OVERRIDE=/etc/systemd/system/eiquidus-web.service.d/rollback-known-working.conf
[[ $EUID -eq 0 && -f $MARKER && -f $BACKUP_MARKER && -L $CURRENT && -f $CERT ]] || exit 1
release=$(basename "$(readlink -f "$CURRENT")")
[[ $release =~ ^[0-9a-f]{40}$ ]] || exit 1
NGINX_CONFIG=/etc/nginx/sites-available/maria-production-$release.conf
[[ -f $NGINX_CONFIG && ! -L $NGINX_CONFIG && $(stat -c %u "$NGINX_CONFIG") -eq 0 && $(stat -c %a "$NGINX_CONFIG") == 644 ]] || exit 1
/usr/local/bin/node /usr/local/libexec/eiquidus/verify-index.js --verify-marker
verified_backup=$(python3 - "$BACKUP_MARKER" "$CURRENT" <<'PY'
import datetime, hashlib, json, pathlib, re, stat, sys
marker, current = map(pathlib.Path, sys.argv[1:])
metadata = marker.lstat()
if marker.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0 or metadata.st_mode & 0o777 != 0o600:
    raise SystemExit('unsafe backup verification marker')
evidence = json.loads(marker.read_text())
if evidence.get('schemaVersion') != 1:
    raise SystemExit('unsupported backup verification marker schema')
verified_at = evidence.get('verifiedAt')
if not isinstance(verified_at, str):
    raise SystemExit('invalid backup verification time')
verified_time = datetime.datetime.fromisoformat(verified_at.replace('Z', '+00:00'))
if verified_time.tzinfo is None or verified_time.utcoffset() is None:
    raise SystemExit('backup verification time lacks a timezone')
backup_path = pathlib.Path(evidence['backup'])
if backup_path.is_symlink():
    raise SystemExit('verified backup path is a symlink')
backup = backup_path.resolve()
backup_root = pathlib.Path('/var/backups/mariacoin-explorer').resolve()
if pathlib.Path(evidence['release']) != current.resolve():
    raise SystemExit('backup was not verified for the current release')
if backup.parent != backup_root or re.fullmatch(r'20[0-9]{6}T[0-9]{6}Z', backup.name) is None or not backup.is_dir():
    raise SystemExit('verified backup path is unavailable')
manifest = backup / 'DATABASE-MANIFEST.json'
checksums = backup / 'SHA256SUMS'
archive = backup / 'mongodb.archive.gz'
for path, field in ((manifest, 'manifestSha256'), (checksums, 'checksumsSha256'), (archive, 'archiveSha256')):
    member = path.lstat()
    expected = evidence.get(field)
    if path.is_symlink() or not stat.S_ISREG(member.st_mode) or member.st_uid != 0 or member.st_gid != 0 or member.st_mode & 0o777 != 0o600:
        raise SystemExit(f'unsafe verified backup member: {path.name}')
    if not isinstance(expected, str) or re.fullmatch(r'[0-9a-f]{64}', expected) is None:
        raise SystemExit(f'invalid backup evidence field: {field}')
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise SystemExit(f'verified backup member changed: {path.name}')
print(backup)
PY
)
(cd "$verified_backup" && sha256sum -c SHA256SUMS >/dev/null)
openssl x509 -checkhost "$HOST" -noout -in "$CERT" >/dev/null
previous_nginx=$(readlink -f /etc/nginx/sites-enabled/maria.conf)
[[ $previous_nginx == /etc/nginx/sites-available/maria-maintenance-tls.conf \
  && -f $previous_nginx && ! -L $previous_nginx ]] || {
  echo 'activation must begin from authenticated TLS maintenance' >&2
  exit 1
}
systemctl daemon-reload
fragment_path=$(systemctl show eiquidus-web.service --property=FragmentPath --value)
[[ $fragment_path == /etc/systemd/system/eiquidus-web.service ]] || {
  echo "unapproved effective web base unit: $fragment_path" >&2
  exit 1
}
cmp -s "$CURRENT/deploy/systemd/eiquidus-web.service" /etc/systemd/system/eiquidus-web.service || {
  echo 'effective web base unit does not match the current immutable release' >&2
  exit 1
}
for dropin_dir in \
  /etc/systemd/system/eiquidus-web.service.d \
  /run/systemd/system/eiquidus-web.service.d \
  /usr/local/lib/systemd/system/eiquidus-web.service.d \
  /usr/lib/systemd/system/eiquidus-web.service.d \
  /lib/systemd/system/eiquidus-web.service.d; do
  for dropin in "$dropin_dir"/*.conf; do
    [[ $dropin == "$ROLLBACK_OVERRIDE" ]] || {
      echo "unapproved on-disk web service drop-in: $dropin" >&2
      exit 1
    }
  done
done
effective_dropins=$(systemctl show eiquidus-web.service --property=DropInPaths --value)
override_effective=false
for dropin in $effective_dropins; do
  if [[ $dropin == "$ROLLBACK_OVERRIDE" ]]; then
    override_effective=true
  else
    echo "unapproved effective web service drop-in: $dropin" >&2
    exit 1
  fi
done
activated=false
override_backup=''
override_removed=false
body=''
if [[ -e $ROLLBACK_OVERRIDE || -L $ROLLBACK_OVERRIDE ]]; then
  [[ -f $ROLLBACK_OVERRIDE && ! -L $ROLLBACK_OVERRIDE \
    && $(stat -c %u "$ROLLBACK_OVERRIDE") -eq 0 \
    && $(stat -c %g "$ROLLBACK_OVERRIDE") -eq 0 \
    && $(stat -c %a "$ROLLBACK_OVERRIDE") == 644 ]] || exit 1
  override_backup=$(mktemp)
  cp -a -- "$ROLLBACK_OVERRIDE" "$override_backup"
  [[ $override_effective == true ]] || { echo 'rollback override exists but is not effective' >&2; exit 1; }
elif [[ $override_effective == true ]]; then
  echo 'effective rollback override is not present on disk' >&2
  exit 1
fi
rollback(){
  rc=$?
  trap - EXIT
  set +e
  [[ -z $body ]] || rm -f -- "$body"
  if [[ $activated != true ]]; then
    ln -sfn "$previous_nginx" /etc/nginx/sites-enabled/maria.conf
    nginx -t && systemctl reload nginx || true
    systemctl disable --now eiquidus-web eiquidus-sync.timer eiquidus-backup.timer || true
    if [[ $override_removed == true && -n $override_backup ]]; then
      install -o root -g root -m 0644 "$override_backup" "$ROLLBACK_OVERRIDE"
      systemctl daemon-reload || true
    fi
  fi
  [[ -z $override_backup ]] || rm -f -- "$override_backup"
  exit "$rc"
}
trap rollback EXIT
if [[ -n $override_backup ]]; then
  rm -f -- "$ROLLBACK_OVERRIDE"
  override_removed=true
fi
systemctl daemon-reload
[[ -z $(systemctl show eiquidus-web.service --property=DropInPaths --value) ]] || {
  echo 'web service still has an effective drop-in after rollback-override removal' >&2
  exit 1
}
[[ $(systemctl show eiquidus-web.service --property=FragmentPath --value) \
  == /etc/systemd/system/eiquidus-web.service ]] || exit 1
cmp -s "$CURRENT/deploy/systemd/eiquidus-web.service" /etc/systemd/system/eiquidus-web.service
systemctl start eiquidus-web
systemctl is-active --quiet eiquidus-web
body=$(mktemp)
ready=false
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:3001/ -o "$body" && grep -Fq MariaCoin "$body"; then
    ready=true
    break
  fi
  sleep 1
done
[[ $ready == true ]]
ln -sfn "$NGINX_CONFIG" /etc/nginx/sites-enabled/maria.conf
nginx -t; systemctl reload nginx
ready=false
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$HOST/" -o "$body" && grep -Fq MariaCoin "$body"; then
    ready=true
    break
  fi
  sleep 1
done
[[ $ready == true ]]
systemctl enable eiquidus-web eiquidus-sync.timer eiquidus-backup.timer
systemctl start eiquidus-sync.timer eiquidus-backup.timer
rm -f -- "$body"
body=''
activated=true
trap - EXIT
[[ -z $override_backup ]] || rm -f -- "$override_backup" || true
