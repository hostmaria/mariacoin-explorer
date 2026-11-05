#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
NODE_VERSION="24.18.0"
BASE="https://nodejs.org/dist/v${NODE_VERSION}"
ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
ARCHIVE_SHA="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
[[ $EUID -eq 0 ]] || exit 1
work=$(mktemp -d /var/tmp/node-install.XXXXXX); trap 'rm -rf "$work"' EXIT
curl -fL --retry 3 --proto '=https' --tlsv1.2 -o "$work/$ARCHIVE" "$BASE/$ARCHIVE"
(cd "$work" && printf '%s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE" | sha256sum --check --strict)
install -d -o root -g root -m 0755 "/opt/node/${NODE_VERSION}"
tar -xJf "$work/$ARCHIVE" -C "/opt/node/${NODE_VERSION}" --strip-components=1 --no-same-owner
ln -sfn "/opt/node/${NODE_VERSION}/bin/node" /usr/local/bin/node
ln -sfn "/opt/node/${NODE_VERSION}/bin/npm" /usr/local/bin/npm
[[ $(node --version) == "v${NODE_VERSION}" ]]
