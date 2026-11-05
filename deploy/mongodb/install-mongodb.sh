#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MONGODB_VERSION="8.0.28"
[[ $EUID -eq 0 ]] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq; apt-get install -y ca-certificates curl gnupg
work=$(mktemp -d /var/tmp/mongodb.XXXXXX); trap 'rm -rf "$work"' EXIT
curl -fL --proto '=https' --tlsv1.2 https://pgp.mongodb.com/server-8.0.asc -o "$work/key.asc"
expected_fingerprint=4B0752C1BCA238C0B4EE14DC41DE058A4E7DCA05
actual_fingerprint=$(gpg --batch --show-keys --with-colons "$work/key.asc" | python3 -c 'import sys
for line in sys.stdin:
 fields=line.rstrip().split(":")
 if fields[0]=="fpr": print(fields[9]); break')
[[ $actual_fingerprint == "$expected_fingerprint" ]] || { echo 'MongoDB signing key mismatch' >&2; exit 1; }
gpg --batch --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg "$work/key.asc"
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse' >/etc/apt/sources.list.d/mongodb-org-8.0.list
apt-get update -qq; apt-get install -y \
  "mongodb-org=${MONGODB_VERSION}" \
  "mongodb-org-database=${MONGODB_VERSION}" \
  "mongodb-org-server=${MONGODB_VERSION}" \
  "mongodb-org-shell=${MONGODB_VERSION}" \
  "mongodb-org-mongos=${MONGODB_VERSION}" \
  "mongodb-org-tools=${MONGODB_VERSION}" \
  "mongodb-org-database-tools-extra=${MONGODB_VERSION}"
apt-mark hold mongodb-org mongodb-org-database mongodb-org-server mongodb-org-shell mongodb-org-mongos mongodb-org-tools mongodb-org-database-tools-extra
install -o root -g mongodb -m 0644 /tmp/mongod.conf /etc/mongod.conf
install -o root -g root -m 0644 /tmp/mongodb.logrotate /etc/logrotate.d/mongodb
openssl rand -base64 756 > /etc/mongodb-keyfile
chown mongodb:mongodb /etc/mongodb-keyfile; chmod 0400 /etc/mongodb-keyfile
getent group eiquidus >/dev/null || groupadd --system eiquidus
id eiquidus >/dev/null 2>&1 || useradd --system --gid eiquidus --home-dir /var/lib/eiquidus --shell /usr/sbin/nologin eiquidus
install -d -o root -g eiquidus -m 0750 /etc/eiquidus
umask 0077
python3 -c "import json,secrets,pathlib; pathlib.Path('/etc/eiquidus/mongodb-admin.json').write_text(json.dumps({'username':'siteRootAdmin','password':secrets.token_urlsafe(48)})); pathlib.Path('/etc/eiquidus/mongodb-app.json').write_text(json.dumps({'username':'eiquidus','password':secrets.token_urlsafe(48),'database':'mariacoin'}))"
chown root:root /etc/eiquidus/mongodb-admin.json; chmod 0600 /etc/eiquidus/mongodb-admin.json
chown root:eiquidus /etc/eiquidus/mongodb-app.json; chmod 0640 /etc/eiquidus/mongodb-app.json
systemctl enable --now mongod
until mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; do sleep 1; done
mongosh --quiet --eval "rs.replSetInitiate({_id:'mariacoin-rs',members:[{_id:0,host:'127.0.0.1:27017'}]})"
until mongosh --quiet --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; do sleep 1; done
mongosh --quiet /tmp/create-app.js
mongosh --quiet /tmp/verify-transaction.js
