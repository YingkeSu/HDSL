#!/usr/bin/env bash
# Reproducible cross-version DSH_HOME probe for HDSL T001 (R006 boundary).
#
# Boots two exact CLI versions in turn against one isolated DSH_HOME and
# records whether the same home stays bootable in both directions and which
# non-node_modules files change. It does not create sessions, so Session-log
# migration is covered by upstream source/docs evidence, not by this probe.
#
# Usage:
#   scripts/research/dsh-version-hop-probe.sh [workdir] [version-from] [version-to]
#
# Defaults: 0.1.5-rc.2 -> 0.1.6-alpha.2 (the two published candidates).
# Tokens in captured logs are masked.

set -u -o pipefail
FROM_V="${2:-0.1.5-rc.2}"
TO_V="${3:-0.1.6-alpha.2}"
WORKDIR="${1:-$(mktemp -d -t dsh-hop-XXXXXX)}"
HOME_DIR="$WORKDIR/home"
mkdir -p "$HOME_DIR"
mask() { sed -E 's/token=[A-Za-z0-9_-]+/token=<redacted>/g'; }

install() { # version -> dir
  local v="$1" d="$WORKDIR/install-$1"
  if [ ! -x "$d/node_modules/.bin/dsh" ]; then
    mkdir -p "$d"
    printf '{"name":"dsh-hop","private":true}\n' > "$d/package.json"
    ( cd "$d" && npm install "@deepseek-ai/dsh@$v" --no-audit --no-fund >"$d/install.log" 2>&1 ) \
      || { echo "install $v failed"; return 1; }
  fi
  printf '%s' "$d/node_modules/@deepseek-ai/dsh/lib/bin.js"
}

boot() { # version bin label -> 0 ok
  local v="$1" bin="$2" label="$3"
  local log="$WORKDIR/$label.log"
  DSH_HOME="$HOME_DIR" node "$bin" web --no-open --host 127.0.0.1 --port 0 >"$log" 2>&1 &
  local pid=$!
  local i
  for i in $(seq 1 120); do
    grep -q 'dsh web: http' "$log" && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if grep -q 'dsh web: http' "$log"; then
    echo "  [$label / dsh $v] ready: $(mask < "$log" | head -1)"
    kill -TERM "$pid"; wait "$pid" 2>/dev/null
    return 0
  fi
  echo "  [$label / dsh $v] BOOT FAILED"; tail -4 "$log" | mask; kill -9 "$pid" 2>/dev/null
  return 1
}

snapshot() { ( cd "$HOME_DIR" && find . -path '*/node_modules' -prune -o -type f -print | sort \
  | xargs -I{} shasum -a 256 {} 2>/dev/null | awk '{print $1, $2}' | shasum -a 256 ); }
filelist() { ( cd "$HOME_DIR" && find . -path '*/node_modules' -prune -o -type f -print | sort \
  | xargs -I{} shasum -a 256 {} 2>/dev/null | awk '{print $1, $2}' ); }

BIN_FROM="$(install "$FROM_V")" || exit 1
BIN_TO="$(install "$TO_V")" || exit 1
echo "workdir=$WORKDIR  from=$FROM_V to=$TO_V"

echo "== first boot ($FROM_V)"
boot "$FROM_V" "$BIN_FROM" "from-1" || exit 1
S1="$(snapshot)"; filelist > "$WORKDIR/files-from-1.txt"

echo "== hop to $TO_V on the same DSH_HOME"
boot "$TO_V" "$BIN_TO" "to-1" || exit 1
S2="$(snapshot)"; filelist > "$WORKDIR/files-to-1.txt"

echo "== hop back to $FROM_V (downgrade tolerance)"
boot "$FROM_V" "$BIN_FROM" "from-2" || exit 1
S3="$(snapshot)"; filelist > "$WORKDIR/files-from-2.txt"

echo "listing hash: from1=$S1"
echo "listing hash: to1  =$S2"
echo "listing hash: from2=$S3"
[ "$S1" = "$S2" ] && echo "from->to: file contents unchanged" \
                  || { echo "from->to: file contents changed"; diff "$WORKDIR/files-from-1.txt" "$WORKDIR/files-to-1.txt" || true; }
[ "$S2" = "$S3" ] && echo "to->from: file contents unchanged" \
                  || { echo "to->from: file contents changed"; diff "$WORKDIR/files-to-1.txt" "$WORKDIR/files-from-2.txt" || true; }

echo "== non-node_modules files"
( cd "$HOME_DIR" && find . -path '*/node_modules' -prune -o -type f -print | sort )
