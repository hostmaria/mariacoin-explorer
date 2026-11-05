#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 0077

backup_root=/var/backups/mariacoin-explorer
lock=/run/lock/mariacoin-explorer-backup.lock
credential_file=/etc/eiquidus/mongodb-admin.json
keep_count=${BACKUP_KEEP_COUNT:-2}

exec 9>"$lock"
flock -n 9 || { echo 'another explorer backup is running' >&2; exit 1; }
[[ $keep_count =~ ^[1-9][0-9]*$ ]] || { echo 'invalid backup keep count' >&2; exit 1; }
[[ -f $credential_file && ! -L $credential_file ]] || { echo 'MongoDB administrator credentials unavailable' >&2; exit 1; }

install -d -o root -g root -m 0700 "$backup_root"
stage=
config=
trap 'rm -f "${config:-}"; if [[ -n ${stage:-} && -d $stage ]]; then rm -rf -- "$stage"; fi' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage=$(mktemp -d "$backup_root/.stage.${stamp}.XXXXXX")
target=$backup_root/$stamp
config=$(mktemp /run/mariacoin-backup-mongodb.XXXXXX.yml)
timer_was_active=false
web_was_active=false
nginx_restore_required=false
release=$(basename "$(readlink -f /opt/eiquidus/current)")
[[ $release =~ ^[0-9a-f]{40}$ ]] || { echo 'current release identity is invalid' >&2; exit 1; }
production_nginx=/etc/nginx/sites-available/maria-production-$release.conf
backup_inputs=(
  /etc/eiquidus/settings.json
  /etc/eiquidus/mongodb-admin.json
  /etc/eiquidus/mongodb-app.json
  /etc/mariacoin/maria.conf
  /etc/eiquidus/explorer-host
  "$production_nginx"
  /etc/nginx/sites-available/maria-maintenance.conf
  /etc/nginx/sites-available/maria-maintenance-tls.conf
  /var/www/maintenance/maintenance.html
  /var/www/maintenance/maria-logo.png
  /etc/systemd/system/mariacoind.service
  /etc/systemd/system/eiquidus-web.service
  /etc/systemd/system/eiquidus-sync.service
  /etc/systemd/system/eiquidus-sync.timer
  /etc/systemd/system/eiquidus-backup.service
  /etc/systemd/system/eiquidus-backup.timer
)
nginx_selector=/etc/nginx/sites-enabled/maria.conf
maintenance_tls=/etc/nginx/sites-available/maria-maintenance-tls.conf

select_nginx_target() {
  selected=$1
  temporary=$nginx_selector.backup.$$
  rm -f "$temporary"
  ln -s "$selected" "$temporary"
  mv -Tf "$temporary" "$nginx_selector"
  nginx -t
  systemctl reload nginx
}

# A oneshot sync run reports ActiveState=activating for its whole run, which
# `systemctl is-active` treats as not active. Only inactive or failed is idle.
unit_busy() {
  case "$(systemctl show --property=ActiveState --value "$1")" in
    inactive|failed) return 1 ;;
    *) return 0 ;;
  esac
}

wait_web_ready() {
  for _ in $(seq 1 30); do
    if systemctl is-active --quiet eiquidus-web.service \
      && curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3001/ >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restore_runtime() {
  failed=false
  if [[ $web_was_active == true ]]; then
    # Keep the public site out of maintenance after transient start failures:
    # retry for several minutes before giving up and failing loudly.
    for attempt in $(seq 1 10); do
      if systemctl start eiquidus-web.service && wait_web_ready; then web_was_active=false; break; fi
      echo "web restart attempt $attempt failed; retrying" >&2
      sleep 20
    done
    [[ $web_was_active == false ]] || failed=true
  fi
  if [[ $nginx_restore_required == true && $web_was_active == false ]]; then
    if select_nginx_target "$nginx_enabled_target"; then nginx_restore_required=false; else failed=true; fi
  fi
  if [[ $timer_was_active == true ]]; then
    if systemctl start eiquidus-sync.timer; then timer_was_active=false; else failed=true; fi
  fi
  [[ $failed == false ]]
}

cleanup() {
  status=$?
  trap - EXIT
  set +e
  cleanup_failed=false
  rm -f "$config" || cleanup_failed=true
  if [[ -d ${stage:-} ]]; then rm -rf "$stage" || cleanup_failed=true; fi
  restore_runtime || cleanup_failed=true
  if [[ $cleanup_failed == true ]]; then status=70; fi
  exit "$status"
}
trap cleanup EXIT

for path in "${backup_inputs[@]}"; do
  [[ -f $path && ! -L $path ]] || { echo "required backup input missing or unsafe: $path" >&2; exit 1; }
done
[[ -L $nginx_selector ]] || { echo 'enabled Nginx selector is missing or unsafe' >&2; exit 1; }
nginx_enabled_target=$(readlink -f "$nginx_selector")
case "$nginx_enabled_target" in
  "$production_nginx"|/etc/nginx/sites-available/maria-maintenance.conf|/etc/nginx/sites-available/maria-maintenance-tls.conf) ;;
  *) echo 'enabled Nginx selector target is not an authenticated release input' >&2; exit 1 ;;
esac
[[ -f $nginx_enabled_target && ! -L $nginx_enabled_target ]] || { echo 'enabled Nginx target is missing or unsafe' >&2; exit 1; }

if systemctl is-active --quiet eiquidus-web.service; then
  web_was_active=true
  if [[ $nginx_enabled_target != "$maintenance_tls" ]]; then
    nginx_restore_required=true
    select_nginx_target "$maintenance_tls"
  fi
  systemctl stop eiquidus-web.service
fi
! unit_busy eiquidus-web.service || { echo 'web writer did not quiesce for backup' >&2; exit 1; }

if systemctl is-active --quiet eiquidus-sync.timer; then
  timer_was_active=true
  systemctl stop eiquidus-sync.timer
fi
for _ in $(seq 1 120); do
  unit_busy eiquidus-sync.service || break
  sleep 5
done
! unit_busy eiquidus-sync.service || { echo 'index sync did not quiesce for backup' >&2; exit 1; }

python3 - "$credential_file" "$config" <<'PY'
import json, pathlib, sys
from urllib.parse import quote
source, output = map(pathlib.Path, sys.argv[1:])
c = json.loads(source.read_text())
for key in ('username', 'password'):
    if not c.get(key):
        raise SystemExit('incomplete MongoDB administrator credentials')
def q(value):
    return json.dumps(value)
output.write_text(
    f'uri: "mongodb://{quote(c["username"], safe="")}@127.0.0.1:27017/?authSource=admin&replicaSet=mariacoin-rs"\n'
    f'password: {q(c["password"])}\n'
)
output.chmod(0o600)
PY

cd /opt/eiquidus/current
/usr/local/bin/node - "$stage/DATABASE-MANIFEST.json" <<'NODE'
const fs=require('fs'),{MongoClient}=require('./node_modules/mongodb'),c=JSON.parse(fs.readFileSync('/etc/eiquidus/mongodb-admin.json'));
const output=process.argv[2],u=`mongodb://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@127.0.0.1:27017/admin?authSource=admin&replicaSet=mariacoin-rs`;
(async()=>{const m=new MongoClient(u);try{await m.connect();const d=m.db('mariacoin'),names=(await d.listCollections({}, {nameOnly:true}).toArray()).map(x=>x.name).sort(),counts={};for(const name of names)counts[name]=await d.collection(name).countDocuments();const statsRows=await d.collection('coinstats').find({coin:'MariaCoin'}).toArray();if(statsRows.length!==1)throw Error(`expected one MariaCoin stats document, found ${statsRows.length}`);const stats=statsRows[0];if(stats.txes!==counts.txes)throw Error(`backup transaction count mismatch: Stats=${stats.txes} Tx=${counts.txes}`);fs.writeFileSync(output,JSON.stringify({collections:names,counts,stats:{last:stats.last,txes:stats.txes}},null,2)+'\n',{mode:0o600})}finally{await m.close()}})().catch(e=>{console.error(e.message);process.exit(1)});
NODE
mongodump --config="$config" --db=mariacoin --archive="$stage/mongodb.archive.gz" --gzip
install -d -o root -g root -m 0700 "$stage/config"
for path in "${backup_inputs[@]}"; do
  install -D -o root -g root -m 0600 "$path" "$stage/config$path"
done
printf '%s\n' "$nginx_enabled_target" >"$stage/config/NGINX_ENABLED_TARGET"
readlink -f /opt/eiquidus/current >"$stage/RELEASE"
/usr/local/bin/maria-cli -conf=/etc/mariacoin/maria.conf -datadir=/var/lib/mariacoin getblockchaininfo >"$stage/BLOCKCHAIN.json"
(
  cd "$stage"
  sha256sum mongodb.archive.gz DATABASE-MANIFEST.json RELEASE BLOCKCHAIN.json $(find config -type f -print | sort) >SHA256SUMS
)
python3 /opt/eiquidus/current/deploy/eiquidus/publish-release.py "$stage" "$target"
stage=
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????Z' -printf '%f\n' | sort -r | tail -n +"$((keep_count + 1))" | while IFS= read -r old; do rm -rf -- "${backup_root:?}/$old"; done
rm -f "$config"
restore_runtime
trap - EXIT
printf 'BACKUP_CREATED=%s\n' "$target"
