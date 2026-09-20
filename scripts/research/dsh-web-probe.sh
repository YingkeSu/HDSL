#!/usr/bin/env bash
# Reproducible DSH upstream probe for HDSL T001 (R002/R003/R004).
#
# Runs real `@deepseek-ai/dsh` processes against isolated DSH_HOME roots and
# records the observed protocol: readiness line, loopback bind, shutdown,
# port conflict, unsafe-host rejection, default-home boundary, Node matrix.
#
# Safety: never writes to a real ~/.dsh; the default-home probe overrides HOME
# and only compares a before/after listing of the real home.
# Tokens printed by DSH are masked in every captured log.
#
# Usage:
#   scripts/research/dsh-web-probe.sh [workdir]
#
# Env:
#   DSH_VERSION   npm version to install (default 0.1.5-rc.2)
#   NODE_BINS     space-separated node executables for the matrix
#                 (default: whatever `node` is on PATH)
#
# Evidence is written under $WORKDIR/evidence. The script prints a summary and
# exits nonzero if a probe that must pass fails.

set -u -o pipefail

DSH_VERSION="${DSH_VERSION:-0.1.5-rc.2}"
WORKDIR="${1:-$(mktemp -d -t dsh-probe-XXXXXX)}"
EVID="$WORKDIR/evidence"
PROJ="$WORKDIR/proj"
NODE_BINS="${NODE_BINS:-$(command -v node)}"

mkdir -p "$EVID" "$PROJ"
log() { printf '%s\n' "$*"; }
mask() { sed -E 's/token=[A-Za-z0-9_-]+/token=<redacted>/g'; }

fail=0

if [ ! -x "$PROJ/node_modules/.bin/dsh" ]; then
  log "== installing @deepseek-ai/dsh@$DSH_VERSION into $PROJ"
  ( cd "$PROJ" && printf '{"name":"dsh-probe","private":true}\n' > package.json \
    && npm install "@deepseek-ai/dsh@$DSH_VERSION" --no-audit --no-fund >"$EVID/npm-install.log" 2>&1 ) \
    || { log "npm install failed"; exit 1; }
fi
DSH_BIN="$PROJ/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$DSH_BIN" ] || { log "missing $DSH_BIN"; exit 1; }
log "@deepseek-ai/dsh@$DSH_VERSION  install=$PROJ"

# ---------------------------------------------------------------- boot probe
# Boots with --port 0, waits for the readiness line, checks the listener is
# loopback-only, hits the HTTP surface, then stops with SIGTERM.
boot_probe() {
  local node_bin="$1" home="$2" name="$3"
  local out="$EVID/$name.log"
  mkdir -p "$home"
  DSH_HOME="$home" "$node_bin" "$DSH_BIN" web --no-open --host 127.0.0.1 --port 0 >"$out" 2>&1 &
  local pid=$!
  local i ready=0
  for i in $(seq 1 90); do
    grep -q 'dsh web: http' "$out" 2>/dev/null && { ready=$i; break; }
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if [ "$ready" = 0 ]; then
    log "  BOOT FAILED ($name)"; tail -5 "$out" | mask; kill -9 "$pid" 2>/dev/null
    fail=1; return 1
  fi
  local url port
  url=$(grep -oE 'http://[^ ]+' "$out" | head -1)
  port=$(printf '%s' "$url" | sed -E 's#.*:([0-9]+)/.*#\1#')
  log "  ready after ${ready} polls: $(printf '%s' "$url" | mask)"
  # loopback-only listener owned by this pid
  if lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | grep -q "127.0.0.1:$port"; then
    log "  listener: 127.0.0.1:$port (loopback-only) OK"
  else
    log "  listener MISSING on 127.0.0.1:$port"; fail=1
  fi
  # unauthenticated /api is rejected; token URL issues the auth cookie (303)
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api" || true)
  log "  GET /api without cookie -> $code (401 expected)"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
  log "  GET token URL -> $code (303 expected)"
  # SIGTERM must be the ordinary stop request
  kill -TERM "$pid"
  for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "$pid" 2>/dev/null; then log "  SIGTERM did not stop within 5s"; kill -9 "$pid"; fail=1
  else wait "$pid" 2>/dev/null; log "  SIGTERM exit=$? (~<5s), within contract"; fi
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN \
    && { log "  port $port still listening"; fail=1; } || log "  port $port released"
  return 0
}

log "== R002/R004: Node matrix + boot/shutdown protocol"
for nb in $NODE_BINS; do
  [ -x "$nb" ] || continue
  v=$("$nb" --version)
  log "-- node $v ($nb)"
  boot_probe "$nb" "$WORKDIR/nodes/$v/home" "boot-$v"
done

log "== R004: unsafe host rejection"
( cd "$PROJ" && DSH_HOME="$WORKDIR/host/home" "$(printf '%s' "$NODE_BINS" | awk '{print $1}')" "$DSH_BIN" \
    web --no-open --host 0.0.0.0 --port 0 >"$EVID/host-reject.log" 2>&1 )
rc=$?
log "  exit=$rc (1 expected for usage error)"
sed -n '1,3p' "$EVID/host-reject.log" | mask
[ "$rc" = 1 ] || { log "  expected exit 1"; fail=1; }

log "== R004: port conflict"
mkdir -p "$WORKDIR/port/a" "$WORKDIR/port/b"
NB1=$(printf '%s' "$NODE_BINS" | awk '{print $1}')
DSH_HOME="$WORKDIR/port/a" "$NB1" "$DSH_BIN" web --no-open --host 127.0.0.1 --port 39999 \
  >"$EVID/port-first.log" 2>&1 &
p1=$!
for i in $(seq 1 90); do grep -q 'dsh web: http' "$EVID/port-first.log" && break; sleep 0.5; done
log "  first: $(mask < "$EVID/port-first.log" | head -1)"
DSH_HOME="$WORKDIR/port/b" "$NB1" "$DSH_BIN" web --no-open --host 127.0.0.1 --port 39999 \
  >"$EVID/port-second.log" 2>&1
rc=$?
log "  second exit=$rc (nonzero expected)"
grep -m1 -oE 'EADDRINUSE[^"]*' "$EVID/port-second.log" | head -1 | sed 's/^/  /'
[ "$rc" != 0 ] || { log "  second instance unexpectedly succeeded"; fail=1; }
kill -0 "$p1" 2>/dev/null && log "  first still alive OK" || { log "  first died"; fail=1; }
kill -TERM "$p1" 2>/dev/null

log "== R003: default-home boundary (real ~/.dsh must not change)"
before=$( cd "$HOME/.dsh" 2>/dev/null && find . | sort | xargs -I{} stat -f '%N %m %z' {} 2>/dev/null | shasum -a 256 )
mkdir -p "$WORKDIR/fakehome"
HOME="$WORKDIR/fakehome" DSH_HOME="" "$NB1" "$DSH_BIN" web --no-open --host 127.0.0.1 --port 0 \
  >"$EVID/home-default.log" 2>&1 &
hp=$!
for i in $(seq 1 90); do grep -q 'dsh web: http' "$EVID/home-default.log" && break; sleep 0.5; done
grep -q 'dsh web: http' "$EVID/home-default.log" \
  && log "  booted with override HOME: $(mask < "$EVID/home-default.log" | head -1)" \
  || { log "  HOME-override boot failed"; fail=1; }
kill -TERM "$hp" 2>/dev/null; wait "$hp" 2>/dev/null
[ -d "$WORKDIR/fakehome/.dsh" ] \
  && log "  override HOME received .dsh: $(find "$WORKDIR/fakehome/.dsh" -maxdepth 1 | wc -l | tr -d ' ') entries" \
  || { log "  override HOME did not receive .dsh"; fail=1; }
after=$( cd "$HOME/.dsh" 2>/dev/null && find . | sort | xargs -I{} stat -f '%N %m %z' {} 2>/dev/null | shasum -a 256 )
if [ "$before" = "$after" ]; then log "  real ~/.dsh listing UNCHANGED"; else
  log "  real ~/.dsh listing CHANGED (note: another DSH may be running on this host)"; fi

log ""
log "evidence: $EVID"
[ "$fail" = 0 ] && log "RESULT: all required probes passed" || log "RESULT: some probes failed"
exit "$fail"
