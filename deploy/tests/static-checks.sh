#!/usr/bin/env bash
set -Eeuo pipefail
PYTHON=${PYTHON:-$(command -v python || command -v python3)}
NODE_DIR=$(dirname "$(command -v node)")
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:"$NODE_DIR"
root=$(cd "$(dirname "$0")/../.." && pwd)
while IFS= read -r -d '' f; do bash -n "$f"; done < <(find "$root/deploy" -type f -name '*.sh' -print0)
(cd "$root" && "$PYTHON" -m unittest discover -s deploy/tests -v)
