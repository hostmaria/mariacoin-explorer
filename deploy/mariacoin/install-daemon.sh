#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
URL="https://github.com/hostmaria/mariacoin/releases/download/v5.5.1/maria-5.5.1-ubuntu18-daemon.zip"
ARCHIVE_SHA="0d15861e7e0de787313464a5a35dc3e9cdda68a092b0104173b4daaa456b27ba"
MARIAD_SHA="db03a3dd390c74a7136a44b06b600fe525f181aaef5915273908cb6453ae2030"
VERSION=5.5.1
RELEASE_ROOT=/opt/mariacoin/5.5.1
[[ $EUID -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
[[ ! -e "$RELEASE_ROOT" ]] || { echo 'release exists' >&2; exit 1; }
work=$(mktemp -d /var/tmp/mariacoin.XXXXXX); trap 'rm -rf "$work"' EXIT
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 -o "$work/release.zip" "$URL"
printf '%s  %s
' "$ARCHIVE_SHA" "$work/release.zip" | sha256sum --check --strict
python3 -m zipfile -e "$work/release.zip" "$work/extracted"
printf '%s  %s
' "$MARIAD_SHA" "$work/extracted/mariad" | sha256sum --check --strict
install -d -o root -g root -m 0755 /opt/mariacoin "$RELEASE_ROOT"
for binary in mariad maria-cli maria-tx; do install -o root -g root -m 0755 "$work/extracted/$binary" "$RELEASE_ROOT/$binary"; done
ln -sfn "$RELEASE_ROOT/mariad" /usr/local/bin/mariad
ln -sfn "$RELEASE_ROOT/maria-cli" /usr/local/bin/maria-cli
ln -sfn "$RELEASE_ROOT/maria-tx" /usr/local/bin/maria-tx
