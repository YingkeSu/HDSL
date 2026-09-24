#!/usr/bin/env bash
# E1 (#116) bounded interface experiment: does removing an entry through a LEGAL,
# NON-EMPTY patch array unload the row in the SAME DSH PID?
#
# Background: #111 phase 2 ran a "removal" step by truncating the profile patch
# to 0 bytes. That is NOT a legal patch list (`parsePatchList` requires a
# top-level YAML array), so the write hit the swallowed-error path (G8) and the
# row stayed loaded. Removal was therefore never actually demonstrated. This
# probe re-runs ONLY that step with a legal top-level array that is still
# non-empty after the removal (it keeps a sibling fixture row).
#
# What it does, one experiment only:
#   1. init a custom profile offline via `--dump-config` (no downloads),
#   2. force `patchReload=live`,
#   3. install a self-built reversible fixture (node:fs markers only),
#   4. boot DSH, wait for the web-ready line,
#   5. write `- insert: [row-a, row-b]` (legal non-empty array), wait until BOTH
#      markers appear in the SAME PID,
#   6. rewrite the file to `- insert: [row-b]` (legal, non-empty, row-a removed),
#   7. observe row-a's dispose marker + marker file removal while row-b stays,
#      and assert the DSH PID never changed.
#
# Safety: own HOME/DSH_HOME/TMPDIR under mktemp, DSH_TELEMETRY_DISABLED=1, no
# network, no subprocess spawned by the fixture, no model, no personal
# credentials; the fixture reads/writes only its own temp directory. Bounded
# timeouts; finally SIGTERM then SIGKILL. This is interface research, NOT
# security certification, desktop acceptance, or an E9 equivalence proof.
#
# Usage:
#   scripts/research/e1-patch-removal-probe.sh <generation-directory>
#   HDSL_E1_DSH_PACKAGE=<...>/node_modules/@deepseek-ai/dsh \
#     HDSL_E1_NODE=/path/to/node scripts/research/e1-patch-removal-probe.sh
set -u -o pipefail

EXPECTED_DSH_VERSION="0.1.5-rc.2"
READY_TIMEOUT=90          # seconds to wait for the web ready line
LOAD_TIMEOUT=40           # seconds, polling, for both rows to load (covers warm-up)
UNLOAD_TIMEOUT=25         # seconds, polling, for the removed row to unload

GENERATION="${1:-}"
DSHPKG="${HDSL_E1_DSH_PACKAGE:-}"
NODE="${HDSL_E1_NODE:-}"
if [ -n "$GENERATION" ]; then
  [ -f "$GENERATION/dsh/node_modules/@deepseek-ai/dsh/package.json" ] || {
    echo "REFUSE: $GENERATION is not a provisioned generation (no managed dsh)" >&2; exit 2; }
  DSHPKG="$GENERATION/dsh/node_modules/@deepseek-ai/dsh"
  [ -x "$GENERATION/node/bin/node" ] && NODE="$GENERATION/node/bin/node"
fi
[ -n "$DSHPKG" ] && [ -f "$DSHPKG/package.json" ] || {
  echo "usage: $0 <generation-directory>  (or set HDSL_E1_DSH_PACKAGE)" >&2; exit 2; }
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE="$(command -v node || true)"
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "REFUSE: no node executable" >&2; exit 2; }

VERSION="$("$NODE" -e "process.stdout.write(require('$DSHPKG/package.json').version)")"
if [ "$VERSION" != "$EXPECTED_DSH_VERSION" ]; then
  echo "REFUSE: expected dsh $EXPECTED_DSH_VERSION, got $VERSION (per-version results)" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-e1-removal-XXXXXX")"
ROOT="$WORK/root"
HOME="$ROOT/home"; DSH_HOME="$ROOT/dsh-home"; TMPDIR="$ROOT/tmp"
mkdir -p "$HOME" "$DSH_HOME" "$TMPDIR" "$WORK/logs"
PROFILE="e1removalprobe"
PDIR="$DSH_HOME/profiles/$PROFILE"
FIX="$PDIR/node_modules/e1-removal-fixture"
PATCH="$PDIR/cordis.patch.yml"
MARKERS="$ROOT/markers"
EVENTS="$ROOT/events.log"
RESULT="$WORK/result.txt"
DSHPID=""
: > "$EVENTS"; mkdir -p "$MARKERS"
export HOME DSH_HOME TMPDIR DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 CI=1
export HDSL_E1_EVIDENCE_DIR="$ROOT"
# Keep the managed node first on PATH so any child resolution stays isolated.
export PATH="$(dirname "$NODE"):/usr/bin:/bin"

mask() { sed -E 's/token=[A-Za-z0-9_-]+/token=<redacted>/g'; }
say() { printf '%s\n' "$*" | tee -a "$WORK/console.txt"; }
step() { printf '\n### %s\n' "$*" | tee -a "$WORK/console.txt"; }

stop_dsh() {
  if [ -n "$DSHPID" ] && kill -0 "$DSHPID" 2>/dev/null; then
    kill -TERM "$DSHPID" 2>/dev/null
    for _ in $(seq 1 40); do kill -0 "$DSHPID" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$DSHPID" 2>/dev/null; then kill -KILL "$DSHPID" 2>/dev/null; echo "cleanup: SIGKILL used" >> "$WORK/console.txt"; fi
    wait "$DSHPID" 2>/dev/null
  fi
  DSHPID=""
}
cleanup() {
  stop_dsh
  if [ "${KEEP:-0}" = "1" ]; then echo "KEEP=1: evidence at $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT INT TERM

write_patch() { cat > "$PATCH"; sync; }
pid_of() { "$NODE" -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid))}catch{}" "$1" 2>/dev/null || true; }
wait_marker() { # $1=marker name  $2=present|absent  $3=seconds
  local i
  for i in $(seq 1 $(( $3 * 4 ))); do
    if [ "$2" = present ] && [ -f "$MARKERS/$1" ]; then return 0; fi
    if [ "$2" = absent ] && [ ! -f "$MARKERS/$1" ]; then return 0; fi
    sleep 0.25
  done
  return 1
}

step "0. identity"
say "- date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "- node: $("$NODE" -v)  dsh: $VERSION  cordis: $("$NODE" -e "process.stdout.write(require('$DSHPKG/../cordis/package.json').version)")"
say "- isolated HOME=$HOME DSH_HOME=$DSH_HOME (no credentials, telemetry disabled)"

step "1. init custom profile offline (--dump-config; does not evaluate !!js)"
"$NODE" "$DSHPKG/lib/bin.js" --profile "$PROFILE" --from-default-profile web --dump-config \
  > "$WORK/logs/dump-init.yml" 2> "$WORK/logs/dump-init.err"
DUMP_RC=$?
say "- dump exit=$DUMP_RC bytes=$(wc -c < "$WORK/logs/dump-init.yml" | tr -d ' ') stderr=$(wc -c < "$WORK/logs/dump-init.err" | tr -d ' ')"
[ "$DUMP_RC" -eq 0 ] || { say "RESULT: FAIL (profile init)"; cp "$WORK/console.txt" "$RESULT" 2>/dev/null; exit 1; }

"$NODE" -e '
const fs=require("fs");const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p,"utf8"));
m.dsh=m.dsh||{};m.dsh.profile=m.dsh.profile||{};m.dsh.profile.patchReload="live";
fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n");
process.stdout.write("bundles="+JSON.stringify(m.dsh.profile.bundles)+" patchReload="+m.dsh.profile.patchReload+"\n");
' "$PDIR/package.json" | tee -a "$WORK/console.txt"
printf '[]\n' > "$PATCH"   # legal empty array = "no overlay" (NOT a 0-byte file)

step "2. self-built reversible fixture (node:fs markers only; no network/subprocess/model)"
mkdir -p "$FIX"
cat > "$FIX/package.json" <<'JSON'
{ "name": "e1-removal-fixture", "version": "1.0.0", "type": "module", "main": "index.mjs", "exports": "./index.mjs" }
JSON
cat > "$FIX/index.mjs" <<'JS'
import { appendFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'e1-removal-fixture'
export function apply(ctx, config = {}) {
  const dir = process.env.HDSL_E1_EVIDENCE_DIR
  const marker = String(config.marker || 'default')
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const live = join(dir, 'markers', marker)
  writeFileSync(live, JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }) + '\n')
  appendFileSync(join(dir, 'events.log'), JSON.stringify({ event: 'load', marker, token, pid: process.pid }) + '\n')
  ctx.effect(() => () => {
    appendFileSync(join(dir, 'events.log'), JSON.stringify({ event: 'dispose', marker, token, pid: process.pid }) + '\n')
    try { if (JSON.parse(readFileSync(live, 'utf8')).token === token) rmSync(live, { force: true }) } catch {}
  })
}
JS
say "- fixture=$FIX (imports: node:fs, node:path)"

step "3. boot DSH (bounded ready wait)"
"$NODE" "$DSHPKG/lib/bin.js" --profile "$PROFILE" --no-open --port 0 \
  > "$WORK/logs/boot.out" 2> "$WORK/logs/boot.err" &
DSHPID=$!
READY=""
for _ in $(seq 1 $(( READY_TIMEOUT * 2 ))); do
  READY="$(grep -o 'dsh web: http://127\.0\.0\.1:[0-9]*' "$WORK/logs/boot.out" 2>/dev/null | head -1)"
  [ -n "$READY" ] && break
  kill -0 "$DSHPID" 2>/dev/null || break
  sleep 0.5
done
say "- spawned pid=$DSHPID"
say "- ready: ${READY:-<NONE>} (alive=$(kill -0 "$DSHPID" 2>/dev/null && echo yes || echo no)) stderr_lines=$(wc -l < "$WORK/logs/boot.err" | tr -d ' ')"
[ -n "$READY" ] || { say "RESULT: FAIL (no ready line)"; cp "$WORK/console.txt" "$RESULT"; stop_dsh; exit 1; }

step "4. write LEGAL NON-EMPTY array with two fixture rows; wait for both (past warm-up)"
LOAD_STARTED=$(date -u +%s)
first_write() { # legal non-empty array inserting row-a and row-b
  write_patch <<YAML
- insert:
    - id: e1-row-a
      name: e1-removal-fixture
      config:
        marker: a
    - id: e1-row-b
      name: e1-removal-fixture
      config:
        marker: b
YAML
}
first_write
DEADLINE=$(( LOAD_TIMEOUT * 4 )); ATTEMPTS=1
while [ "$DEADLINE" -gt 0 ]; do
  if [ -f "$MARKERS/a" ] && [ -f "$MARKERS/b" ]; then break; fi
  sleep 0.25; DEADLINE=$(( DEADLINE - 1 ))
  if [ $(( DEADLINE % 20 )) -eq 0 ]; then first_write; ATTEMPTS=$(( ATTEMPTS + 1 )); fi
done
PA="$(pid_of "$MARKERS/a")"; PB="$(pid_of "$MARKERS/b")"
LOAD_ELAPSED=$(( $(date -u +%s) - LOAD_STARTED ))
say "- load attempts=$ATTEMPTS elapsed=${LOAD_ELAPSED}s marker_a_pid=${PA:-<absent>} marker_b_pid=${PB:-<absent>}"
if [ ! -f "$MARKERS/a" ] || [ ! -f "$MARKERS/b" ]; then
  say "RESULT: FAIL (legal array did not load both rows)"
  cp "$WORK/console.txt" "$RESULT"; stop_dsh; exit 1
fi
say "- precondition OK: a=$PA b=$PB dsh_pid=$DSHPID same=$([ "$PA" = "$DSHPID" ] && [ "$PB" = "$DSHPID" ] && echo yes || echo no)"

step "5. rewrite to a LEGAL NON-EMPTY array that REMOVES row-a and keeps row-b"
write_patch <<YAML
- insert:
    - id: e1-row-b
      name: e1-removal-fixture
      config:
        marker: b
YAML
if wait_marker a absent "$UNLOAD_TIMEOUT"; then UNLOADED=yes; else UNLOADED=no; fi
sleep 2  # let any dispose event flush
A_STILL=$([ -f "$MARKERS/a" ] && echo yes || echo no)
B_STILL=$([ -f "$MARKERS/b" ] && echo yes || echo no)
PID_AFTER="$(pid_of "$MARKERS/b")"
ALIVE_AFTER=$(kill -0 "$DSHPID" 2>/dev/null && echo yes || echo no)
say "- row-a unloaded=$UNLOADED (marker_a_present=$A_STILL) ; row-b kept=$([ "$B_STILL" = yes ] && echo yes || echo no)"\
" ; marker_b_pid=${PID_AFTER:-<none>} dsh_pid=$DSHPID alive=$ALIVE_AFTER"

step "6. verdict"
SAME_PID=no
[ "$PID_AFTER" = "$DSHPID" ] && SAME_PID=yes
PASS=no
[ "$UNLOADED" = yes ] && [ "$A_STILL" = no ] && [ "$B_STILL" = yes ] && [ "$SAME_PID" = yes ] && PASS=yes
say "- same_pid=$SAME_PID"
say "- events (masked):"
while IFS= read -r line; do say "    $line"; done < "$EVENTS"
say "- patch file present=$([ -f "$PATCH" ] && echo yes) bytes=$(wc -c < "$PATCH" | tr -d ' ')"
say "- leftover probe dsh processes: $(pgrep -f "$PROFILE" 2>/dev/null | wc -l | tr -d ' ')"

stop_dsh
RESIDUAL="$(pgrep -f "$PROFILE" 2>/dev/null | wc -l | tr -d ' ')"
say "- after bounded stop, residual probe processes: $RESIDUAL"
cp "$WORK/console.txt" "$RESULT"
if [ "$PASS" = yes ] && [ "$RESIDUAL" = 0 ]; then
  echo "RESULT: PASS — a legal non-empty patch array removed row-a in the SAME DSH PID; row-b stayed loaded."
  exit 0
fi
echo "RESULT: FAIL — see $RESULT"
exit 1
