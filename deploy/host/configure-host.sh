#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID -eq 0 ]] || exit 1
[[ -s /home/${SUDO_USER:?run through a key-authenticated sudo account}/.ssh/authorized_keys ]] || { echo 'verified SSH key required before hardening' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y ca-certificates curl unzip xz-utils python3 openssl ufw nginx certbot logrotate
install -o root -g root -m 0644 /tmp/00-eiquidus-hardening.conf /etc/ssh/sshd_config.d/00-eiquidus-hardening.conf
sshd -t
systemctl reload ssh
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment SSH
ufw allow 80/tcp comment HTTP
ufw allow 443/tcp comment HTTPS
ufw allow 47773/tcp comment MariaCoin-P2P
ufw --force enable
