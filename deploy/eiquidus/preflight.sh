#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
conf=/etc/mariacoin/maria.conf
cli=(/usr/local/bin/maria-cli -conf="$conf" -datadir=/var/lib/mariacoin)
[[ -r /etc/eiquidus/settings.json && -r "$conf" ]]
[[ $("${cli[@]}" getblockhash 0) == 0000040cb60b26f13ffcd2f692d679e172da34096041efe215d8c50cd65dd9f9 ]]
"${cli[@]}" getrawtransaction 09fabd30b14d79ae7c4c687ad9e4517974223108474d468181d32ff8d588fdee 1 >/dev/null
/usr/local/bin/node /usr/local/libexec/eiquidus/mongodb-preflight.js
