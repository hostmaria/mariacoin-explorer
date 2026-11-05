#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOST=explorer.mariacoin.com
EMAIL=${1:?usage: install-maintenance.sh admin-email}
[[ $EUID -eq 0 ]] || exit 1
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
install -d -o root -g root -m 0755 /var/www/acme/.well-known/acme-challenge /var/www/maintenance
install -o root -g root -m 0644 "$ROOT/deploy/nginx/maintenance.html" /var/www/maintenance/maintenance.html
install -o root -g root -m 0644 "$ROOT/public/img/maria-logo.png" /var/www/maintenance/maria-logo.png
install -o root -g root -m 0644 "$ROOT/deploy/nginx/maintenance.conf" /etc/nginx/sites-available/maria-maintenance.conf
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/maria-maintenance.conf /etc/nginx/sites-enabled/maria.conf
nginx -t; systemctl enable nginx; systemctl reload nginx
probe=$(openssl rand -hex 16); printf '%s' "$probe" >"/var/www/acme/.well-known/acme-challenge/$probe"
curl -fsS "http://$HOST/.well-known/acme-challenge/$probe" | grep -Fqx "$probe"
rm -f "/var/www/acme/.well-known/acme-challenge/$probe"
certbot certonly --webroot -w /var/www/acme -d "$HOST" --email "$EMAIL" --agree-tos --no-eff-email --non-interactive
install -o root -g root -m 0644 "$ROOT/deploy/nginx/maintenance-tls.conf" /etc/nginx/sites-available/maria-maintenance-tls.conf
install -o root -g root -m 0644 "$ROOT/deploy/nginx/production.conf" /etc/nginx/sites-available/maria-production.conf
ln -sfn /etc/nginx/sites-available/maria-maintenance-tls.conf /etc/nginx/sites-enabled/maria.conf
nginx -t; systemctl reload nginx
