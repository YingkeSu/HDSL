#!/usr/bin/env bash
# E1b (#116) bounded interface experiment: can HDSL observe, from OUTSIDE the
# DSH process, (a) when the live patch watcher is actually armed, (b) that an
# invalid patch failed, and (c) that a legal non-empty array removed a row?
#
# Background: E1a established that `saved` != ACTIVE and that the `dsh web:`
# ready line does not guarantee the patch watcher is armed. The official
# read-only Remote `pluginInventory/list` is Remote-only and needs a browser
# session (every Host RPC does). This probe measures the observable gap from
# the launcher's only public channel: the child process's stdout/stderr plus
# the profile patch file.
#
# One bounded run:
#   1. init a custom profile offline (`--dump-config`), force patchReload=live;
#   2. install a self-built reversible fixture (node:fs markers only);
#   3. boot DSH and wait for the `dsh web:` ready line (t0);
#   4. write a legal non-empty array with two fixture rows and poll, rewriting
#      every 5s, until BOTH load -> records the preheat window (t0 -> first
#      observed application) with NO acknowledgement emitted by DSH;
#   5. while warm, atomically write an invalid mapping-root patch (illegal:
#      `parsePatchList` requires a top-level array), wait bounded, and record
#      whether DSH surfaced any stdout/stderr error or left the row loaded
#      (error-swallow negative control); then restore the legal array;
#   6. write a legal NON-EMPTY array that REMOVES row-a while keeping row-b and
#      poll, rewriting every 5s, until row-a unloads in the SAME DSH PID.
#
# Safety: own HOME/DSH_HOME/TMPDIR under mktemp, DSH_TELEMETRY_DISABLED=1, no
# network, no subprocess spawned by the fixture, no model, no personal
# credentials; the fixture reads/writes only its own temp directory. Bounded
# timeouts; finally SIGTERM then SIGKILL. Interface research only -- NOT a
# security certification, desktop acceptance, or an E9 equivalence proof.
#
# Usage:
#   scripts/research/e1b-readiness-ack-probe.sh <generation-directory>
#   HDSL_E1_DSH_PACKAGE=<...>/node_modules/@deepseek-ai/dsh \
#     HDSL_E1_NODE=/path/to/node scripts/research/e1b-readiness-ack-probe.sh
set -u -o pipefail

EXPECTED_DSH_VERSION="0.1.5-rc.2"
READY_TIMEOUT="${HDSL_E1B_READY_TIMEOUT:-90}"
PREHEAT_TIMEOUT="${HDSL_E1B_PREHEAT_TIMEOUT:-60}"   # seconds, polling + rewrite, for both rows to load
SWALLOW_WAIT="${HDSL_E1B_SWALLOW_WAIT:-10}"          # seconds to observe an illegal-patch write
UNLOAD_TIMEOUT="${HDSL_E1B_UNLOAD_TIMEOUT:-60}"     # seconds, polling + rewrite, for row-a to unload

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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-e1b-ready-XXXXXX")"
ROOT="$WORK/root"
HOME="$ROOT/home"; DSH_HOME="$ROOT/dsh-home"; TMPDIR="$ROOT/tmp"
mkdir -p "$HOME" "$DSH_HOME" "$TMPDIR" "$WORK/logs"
PROFILE="e1breadyprobe"
PDIR="$DSH_HOME/profiles/$PROFILE"
FIX="$PDIR/node_modules/e1b-ready-fixture"
PATCH="$PDIR/cordis.patch.yml"
MARKERS="$ROOT/markers"
EVENTS="$ROOT/events.log"
DSHPID=""
: > "$EVENTS"; mkdir -p "$MARKERS"
export HOME DSH_HOME TMPDIR DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 CI=1
export HDSL_E1_EVIDENCE_DIR="$ROOT"
export PATH="$(dirname "$NODE"):/usr/bin:/bin"

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

write_patch() { local t="$PATCH.tmp.$$.$RANDOM"; cat > "$t"; sync; mv "$t" "$PATCH"; }  # atomic: temp + rename (never leave a truncated file for the watcher)
pid_of() { "$NODE" -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid))}catch{}" "$1" 2>/dev/null || true; }
err_bytes() { wc -c < "$WORK/logs/boot.err" | tr -d ' '; }
out_bytes() { wc -c < "$WORK/logs/boot.out" | tr -d ' '; }
wait_marker() { # $1=marker  $2=present|absent  $3=seconds
  local i
  for i in $(seq 1 $(( $3 * 4 ))); do
    if [ "$2" = present ] && [ -f "$MARKERS/$1" ]; then return 0; fi
    if [ "$2" = absent ] && [ ! -f "$MARKERS/$1" ]; then return 0; fi
    sleep 0.25
  done
  return 1
}
two_rows() {
  write_patch <<YAML
- insert:
    - id: e1b-row-a
      name: e1b-ready-fixture
      config:
        marker: a
    - id: e1b-row-b
      name: e1b-ready-fixture
      config:
        marker: b
YAML
}
one_row_b() {
  write_patch <<YAML
- insert:
    - id: e1b-row-b
      name: e1b-ready-fixture
      config:
        marker: b
YAML
}

step "0. identity"
say "- date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "- node: $("$NODE" -v)  dsh: $VERSION  cordis: $("$NODE" -e "process.stdout.write(require('$DSHPKG/../cordis/package.json').version)")  loader: $("$NODE" -e "process.stdout.write(require('$DSHPKG/../cordis-plugin-loader/package.json').version)")"
say "- isolated HOME=$HOME DSH_HOME=$DSH_HOME (no credentials, telemetry disabled)"

step "1. init custom profile offline (--dump-config)"
"$NODE" "$DSHPKG/lib/bin.js" --profile "$PROFILE" --from-default-profile web --dump-config \
  > "$WORK/logs/dump-init.yml" 2> "$WORK/logs/dump-init.err"
DUMP_RC=$?
say "- dump exit=$DUMP_RC bytes=$(wc -c < "$WORK/logs/dump-init.yml" | tr -d ' ') stderr=$(wc -c < "$WORK/logs/dump-init.err" | tr -d ' ')"
[ "$DUMP_RC" -eq 0 ] || { say "RESULT: FAIL (profile init)"; exit 1; }
"$NODE" -e '
const fs=require("fs");const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p,"utf8"));
m.dsh=m.dsh||{};m.dsh.profile=m.dsh.profile||{};m.dsh.profile.patchReload="live";
fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n");
process.stdout.write("bundles="+JSON.stringify(m.dsh.profile.bundles)+" patchReload="+m.dsh.profile.patchReload+"\n");
' "$PDIR/package.json" | tee -a "$WORK/console.txt"
printf '[]\n' > "$PATCH"

step "2. self-built reversible fixture (node:fs markers only)"
mkdir -p "$FIX"
cat > "$FIX/package.json" <<'JSON'
{ "name": "e1b-ready-fixture", "version": "1.0.0", "type": "module", "main": "index.mjs", "exports": "./index.mjs" }
JSON
cat > "$FIX/index.mjs" <<'JS'
import { appendFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'e1b-ready-fixture'
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
READY_EPOCH=$(date -u +%s)
say "- spawned pid=$DSHPID  ready: ${READY:-<NONE>}  stdout_bytes=$(out_bytes) stderr_bytes=$(err_bytes)"
[ -n "$READY" ] || { say "RESULT: FAIL (no ready line)"; stop_dsh; exit 1; }

step "4. PREHEAT: legal non-empty array, poll/rewrite until both rows load"
two_rows
DEADLINE=$(( PREHEAT_TIMEOUT * 4 )); ATTEMPTS=1
while [ "$DEADLINE" -gt 0 ]; do
  if [ -f "$MARKERS/a" ] && [ -f "$MARKERS/b" ]; then break; fi
  sleep 0.25; DEADLINE=$(( DEADLINE - 1 ))
  if [ $(( DEADLINE % 20 )) -eq 0 ]; then two_rows; ATTEMPTS=$(( ATTEMPTS + 1 )); fi
done
PA="$(pid_of "$MARKERS/a")"; PB="$(pid_of "$MARKERS/b")"
PREHEAT_SECONDS=$(( $(date -u +%s) - READY_EPOCH ))
say "- attempts=$ATTEMPTS  preheat_seconds=$PREHEAT_SECONDS  marker_a_pid=${PA:-<absent>}  marker_b_pid=${PB:-<absent>}"
say "- DSH stdout/stderr during preheat: stdout_bytes=$(out_bytes) stderr_bytes=$(err_bytes) (no readiness ack on any channel)"
if [ ! -f "$MARKERS/a" ] || [ ! -f "$MARKERS/b" ]; then
  say "RESULT: FAIL (valid array never loaded)"; stop_dsh; exit 1
fi

step "5. ERROR-SWALLOW NEGATIVE CONTROL: atomic write of an INVALID (mapping root) patch while warm"
OUT_BEFORE=$(out_bytes); ERR_BEFORE=$(err_bytes)
ILLEGAL_TMP="$PATCH.tmp.$$.$RANDOM"; printf 'foo: bar\n' > "$ILLEGAL_TMP"; sync; mv "$ILLEGAL_TMP" "$PATCH"
if wait_marker a absent "$SWALLOW_WAIT"; then ILLEGAL_UNLOADED=yes; else ILLEGAL_UNLOADED=no; fi
A_AFTER_ILLEGAL=$([ -f "$MARKERS/a" ] && echo yes || echo no)
OUT_DELTA=$(( $(out_bytes) - OUT_BEFORE )); ERR_DELTA=$(( $(err_bytes) - ERR_BEFORE ))
say "- invalid mapping-root patch: stdout_delta=$OUT_DELTA stderr_delta=$ERR_DELTA row_a_unloaded=$ILLEGAL_UNLOADED row_a_still_present=$A_AFTER_ILLEGAL"
say "- boot.stderr tail: $(tail -c 400 "$WORK/logs/boot.err" | tr '\n' ' ')"

step "6. restore legal array (two rows) and confirm still loaded"
two_rows
wait_marker a present 20 && RESTORED=yes || RESTORED=no
say "- restored=$RESTORED marker_a_pid=$(pid_of "$MARKERS/a")"

step "7. REMOVAL: legal NON-EMPTY array keeps row-b, removes row-a; poll/rewrite"
one_row_b
DEADLINE=$(( UNLOAD_TIMEOUT * 4 )); ATTEMPTS=1
while [ "$DEADLINE" -gt 0 ]; do
  if [ ! -f "$MARKERS/a" ]; then break; fi
  sleep 0.25; DEADLINE=$(( DEADLINE - 1 ))
  if [ $(( DEADLINE % 20 )) -eq 0 ]; then one_row_b; ATTEMPTS=$(( ATTEMPTS + 1 )); fi
done
sleep 2
UNLOADED=$([ -f "$MARKERS/a" ] && echo no || echo yes)
A_STILL=$([ -f "$MARKERS/a" ] && echo yes || echo no)
B_STILL=$([ -f "$MARKERS/b" ] && echo yes || echo no)
PID_AFTER="$(pid_of "$MARKERS/b")"
UNLOAD_SECONDS=$(( $(date -u +%s) - READY_EPOCH - PREHEAT_SECONDS ))
say "- removal attempts=$ATTEMPTS row_a_unloaded=$UNLOADED (present=$A_STILL) row_b_kept=$B_STILL marker_b_pid=${PID_AFTER:-<none>} dsh_pid=$DSHPID"

step "8. verdict"
SAME_PID=no; [ "$PID_AFTER" = "$DSHPID" ] && SAME_PID=yes
PASS=no
[ "$UNLOADED" = yes ] && [ "$A_STILL" = no ] && [ "$B_STILL" = yes ] && [ "$SAME_PID" = yes ] && PASS=yes
say "- same_pid=$SAME_PID"
say "- events (masked):"
while IFS= read -r line; do say "    $line"; done < "$EVENTS"
say "- final patch bytes=$(wc -c < "$PATCH" | tr -d ' ')  boot stderr_bytes=$(err_bytes)"

stop_dsh
RESIDUAL="$(pgrep -f "$PROFILE" 2>/dev/null | wc -l | tr -d ' ')"
say "- after bounded stop, residual probe processes: $RESIDUAL"
cp "$WORK/console.txt" "$WORK/result.txt"
if [ "$PASS" = yes ] && [ "$RESIDUAL" = 0 ]; then
  echo "RESULT: PASS — legal non-empty array removed row-a in the SAME DSH PID (preheat=${PREHEAT_SECONDS}s, attempts=${ATTEMPTS}); invalid mapping-root patch surfaced no error (out+${OUT_DELTA}/err+${ERR_DELTA}) and did not unload."
  exit 0
fi
echo "RESULT: FAIL — see $WORK/result.txt"
exit 1
