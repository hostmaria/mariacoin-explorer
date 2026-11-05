#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID -eq 0 ]] || exit 1
[[ -s /home/${SUDO_USER:?run through a key-authenticated sudo account}/.ssh/authorized_keys ]] || { echo 'verified SSH key required before hardening' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y ca-certificates curl unzip xz-utils python3 openssl ufw nginx certbot logrotate fail2ban
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
install -d -o root -g root -m 0755 /etc/fail2ban
cat >/etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
backend = systemd
banaction = ufw
bantime = 1h
findtime = 10m
maxretry = 5
bantime.increment = true
bantime.maxtime = 1w
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
port = ssh
mode = aggressive
EOF
fail2ban-client -t
systemctl enable fail2ban
systemctl restart fail2ban
install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' >/etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald
printf '%s\n' 'GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT zswap.enabled=1 zswap.compressor=lzo zswap.zpool=zsmalloc zswap.max_pool_percent=25"' >/etc/default/grub.d/99-zswap.cfg
update-grub
systemctl disable --now ModemManager.service multipathd.service multipathd.socket fwupd-refresh.timer 2>/dev/null || true
systemctl stop fwupd.service packagekit.service 2>/dev/null || true
# Mask fwupd only. packagekit is D-Bus activated on demand by an apt hook; masking it
# makes every apt run print a UnitMasked error, and it exits again when idle.
systemctl mask fwupd.service
