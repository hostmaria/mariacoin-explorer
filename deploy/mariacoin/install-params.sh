#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SPEND_URL=https://download.z.cash/downloads/sapling-spend.params
OUTPUT_URL=https://download.z.cash/downloads/sapling-output.params
SPEND_SHA=8e48ffd23abb3a5fd9c5589204f32d9c31285a04b78096ba40a79b75677efc13
OUTPUT_SHA=2f0ebbcbb9bb0bcffe95a397e7eba89c29eb4dde6191c339db88570e3f3fb0e4
[[ $EUID -eq 0 ]] || exit 1
work=$(mktemp -d /var/tmp/maria-params.XXXXXX)
trap 'rm -rf "$work"' EXIT
curl -fL --retry 3 --proto '=https' --tlsv1.2 -o "$work/sapling-spend.params" "$SPEND_URL"
curl -fL --retry 3 --proto '=https' --tlsv1.2 -o "$work/sapling-output.params" "$OUTPUT_URL"
(
  cd "$work"
  printf '%s  %s\n%s  %s\n' "$SPEND_SHA" sapling-spend.params "$OUTPUT_SHA" sapling-output.params |
    sha256sum --check --strict
)
install -d -o root -g mariacoin -m 0750 /var/lib/mariacoin-params
install -o root -g mariacoin -m 0640 "$work/sapling-spend.params" /var/lib/mariacoin-params/sapling-spend.params
install -o root -g mariacoin -m 0640 "$work/sapling-output.params" /var/lib/mariacoin-params/sapling-output.params
