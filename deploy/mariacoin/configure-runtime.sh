#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID -eq 0 ]] || exit 1
getent group maria-rpc >/dev/null || groupadd --system maria-rpc
getent group mariacoin >/dev/null || groupadd --system mariacoin
id mariacoin >/dev/null 2>&1 || useradd --system --gid mariacoin --groups maria-rpc --home-dir /var/lib/mariacoin --shell /usr/sbin/nologin mariacoin
usermod -a -G maria-rpc mariacoin
install -d -o root -g maria-rpc -m 0750 /etc/mariacoin
install -d -o mariacoin -g mariacoin -m 0750 /var/lib/mariacoin /var/log/mariacoin
umask 0077
RPC_USER=maria_rpc_$(openssl rand -hex 12); RPC_PASSWORD=$(openssl rand -base64 48 | tr -d '
')
sed -e "s/@RPC_USER@/$RPC_USER/" -e "s#@RPC_PASSWORD@#$RPC_PASSWORD#" /tmp/maria.conf.template >/etc/mariacoin/maria.conf
chown root:maria-rpc /etc/mariacoin/maria.conf; chmod 0640 /etc/mariacoin/maria.conf
install -o root -g root -m 0644 /tmp/mariacoind.service /etc/systemd/system/
install -o root -g root -m 0644 /tmp/mariacoin.logrotate /etc/logrotate.d/mariacoin
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/mariacoind.service
