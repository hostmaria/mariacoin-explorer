# Sourced by deployment scripts. Each explorer server declares its own public hostname
# once, in a root-owned file, so one release archive can serve independent explorers.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EXPLORER_HOST_FILE=${EXPLORER_HOST_FILE:-/etc/eiquidus/explorer-host}

read_explorer_host() {
  local host
  [[ -f $EXPLORER_HOST_FILE && ! -L $EXPLORER_HOST_FILE ]] || { echo "explorer host file missing or unsafe: $EXPLORER_HOST_FILE" >&2; return 1; }
  [[ $(stat -c %u "$EXPLORER_HOST_FILE") -eq 0 ]] || { echo 'explorer host file must be root-owned' >&2; return 1; }
  [[ $(( 8#$(stat -c %a "$EXPLORER_HOST_FILE") & 8#022 )) -eq 0 ]] || { echo 'explorer host file must not be group or world writable' >&2; return 1; }
  host=$(tr -d '[:space:]' <"$EXPLORER_HOST_FILE")
  [[ $host =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || { echo "invalid explorer hostname: $host" >&2; return 1; }
  printf '%s\n' "$host"
}

render_explorer_template() {
  # render_explorer_template SOURCE DESTINATION HOST MODE
  local temporary
  temporary=$(mktemp "$2.render.XXXXXX")
  sed "s/@EXPLORER_HOST@/$3/g" "$1" >"$temporary"
  ! grep -q '@EXPLORER_HOST@' "$temporary" || { rm -f -- "$temporary"; echo "unrendered placeholder in $1" >&2; return 1; }
  chown root:root "$temporary"; chmod "$4" "$temporary"
  mv -f -- "$temporary" "$2"
}
