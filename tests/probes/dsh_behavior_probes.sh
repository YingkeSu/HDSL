#!/usr/bin/env bash
#
# Reproducible behavior probes against the real, official DeepSeek Harness (DSH) CLI.
#
# Scope: two isolated DSH homes, default `~/.dsh` resolution, loopback readiness and
# binding, occupied-port failure, and stopping a DSH process we own (graceful stop +
# process-tree survival of unrelated processes).
#
# Safety: every probe runs with an explicit temporary HOME and DSH_HOME under
# $TMPDIR, a scrubbed environment, telemetry disabled, and a non-secret placeholder
# API key. It never reads or writes the operator's real `~/.dsh`, settings, or
# credentials, and it only signals processes it spawned itself.
#
# Usage:
#   DSH_REPO=/path/to/deepseek-harness tests/probes/dsh_behavior_probes.sh
#
# Exit status: 0 when every assertion below holds, 1 otherwise.

set -u

DSH_REPO="${DSH_REPO:-/Users/suyingke/labs/ds/deepseek-harness}"
NODE="${DSH_NODE:-$(command -v node || true)}"
BIN="$DSH_REPO/apps/cli/lib/bin.js"
PYTHON="${DSH_PYTHON:-$(command -v python3 || true)}"

if [[ -z "$NODE" || ! -x "$NODE" ]]; then echo "FATAL: node not found (set DSH_NODE)" >&2; exit 2; fi
if [[ ! -f "$BIN" ]]; then echo "FATAL: built CLI not found at $BIN (set DSH_REPO)" >&2; exit 2; fi
if [[ -z "$PYTHON" ]]; then echo "FATAL: python3 not found (set DSH_PYTHON)" >&2; exit 2; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-probes.XXXXXX")"
FAKE_HOME="$WORK/fakehome"      # stands in for the operator home; default home would be $FAKE_HOME/.dsh
FAKE_AGENTS="$WORK/fake-agents"
mkdir -p "$FAKE_HOME" "$FAKE_AGENTS"

FAILURES=0
declare -a SPAWNED_PIDS=()

say()  { printf '%s\n' "$*"; }
head1(){ printf '\n===== %s =====\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
note() { printf 'NOTE  %s\n' "$*"; }

cleanup() {
  if [[ "${#SPAWNED_PIDS[@]}" -gt 0 ]]; then
    for pid in "${SPAWNED_PIDS[@]}"; do
      [[ -n "$pid" ]] || continue
      kill -KILL "$pid" 2>/dev/null || true
    done
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- helpers -----------------------------------------------------------------

# Launch the DSH CLI with a scrubbed environment and temporary home.
# $1 = DSH_HOME value ("@" means leave DSH_HOME unset -> default ~/.dsh)
# remaining args = CLI args. Prints the PID. stdout/stderr go to $OUT / $ERR.
dsh_pid=""
dsh_launch() {
  local home="$1"; shift
  local out="$1"; shift
  local err="$1"; shift
  local envargs=(
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin"
    "HOME=$FAKE_HOME"
    "DSH_AGENTS_HOME=$FAKE_AGENTS"
    "DSH_TELEMETRY_DISABLED=1"
    "DEEPSEEK_API_KEY=keyless-probe-no-call"
    "NODE_NO_WARNINGS=1"
  )
  [[ "$home" == "@" ]] || envargs+=("DSH_HOME=$home")
  env -i "${envargs[@]}" "$NODE" "$BIN" "$@" >"$out" 2>"$err" &
  dsh_pid=$!
  SPAWNED_PIDS+=("$dsh_pid")
}

# Wait until $1 (stdout log) contains the ready URL, or the process exits, or timeout.
# Returns 0 on readiness, 1 on early exit, 2 on timeout. Echoes the raw URL line.
wait_ready() {
  local out="$1" pid="$2" limit="${3:-60}"
  local i
  for ((i = 0; i < limit * 10; i++)); do
    if grep -qE 'dsh web: http://' "$out" 2>/dev/null; then
      grep -E 'dsh web: http://' "$out" | head -1
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then return 1; fi
    sleep 0.1
  done
  return 2
}

# HTTP status of a single request (redirects not followed); extra args pass to curl.
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

redact() { sed -E 's/(token=)[A-Za-z0-9_.-]+/\1<redacted>/Ig; s/(dsh-auth-[A-Za-z0-9_.-]+=)[^;[:space:]]+/\1<redacted>/g'; }

# Recursively list descendant PIDs of $1 (portable on macOS: pgrep -P).
descendants() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    printf '%s\n' "$child"
    descendants "$child"
  done
}

port_of_url() { sed -E 's#.*://[^:/]+:([0-9]+).*#\1#' <<<"$1"; }

# --- S0: provenance and version ---------------------------------------------

head1 "S0 provenance and version"
say "platform       : $(uname -srm)"
say "node           : $("$NODE" --version)"
say "cli path       : $BIN"
say "cli --version  : $("$NODE" "$BIN" --version)"
say "repo HEAD      : $(git -C "$DSH_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
say "repo describe  : $(git -C "$DSH_REPO" describe --tags --always 2>/dev/null || echo unknown)"
say "repo dirtiness : $(git -C "$DSH_REPO" status --porcelain 2>/dev/null | grep -vc '^??' | tr -d ' ') tracked modifications"

VER="$("$NODE" "$BIN" --version)"
if [[ "$VER" == "0.1.6-alpha.2" ]]; then ok "CLI reports 0.1.6-alpha.2"; else bad "unexpected CLI version: $VER"; fi

# --- S1: default home resolves to ~/.dsh ------------------------------------

head1 "S1 default home = \$HOME/.dsh (DSH_HOME unset)"
S1="$WORK/s1"; mkdir -p "$S1"
# Pre-create the default home so we can detect whether a boot writes there at all.
mkdir -p "$FAKE_HOME/.dsh"
dsh_launch "@" "$S1/out" "$S1/err" --profile web --host 127.0.0.1 --port 0 --no-open
S1_PID=$dsh_pid
if LINE="$(wait_ready "$S1/out" "$S1_PID" 60)"; then
  say "ready line : $(sed -E 's/(token=)[A-Za-z0-9_.-]+/\1<redacted>/' <<<"$LINE")"
  if [[ -f "$FAKE_HOME/.dsh/profiles/web/package.json" ]]; then
    ok "default home \$HOME/.dsh was initialized (profiles/web/package.json present)"
  else
    bad "default home \$HOME/.dsh/profiles/web/package.json missing"
  fi
  kill -TERM "$S1_PID" 2>/dev/null; wait "$S1_PID" 2>/dev/null; S1_RC=$?
  if [[ "$S1_RC" -eq 0 ]]; then ok "SIGTERM on default-home web exited 0"; else bad "SIGTERM exit was $S1_RC"; fi
else
  bad "default-home web did not become ready (see $S1/err)"; head -10 "$S1/err"
fi
say "default home tree (depth 3):"
find "$FAKE_HOME/.dsh" -maxdepth 3 2>/dev/null | sed "s#$FAKE_HOME#~#" | sort | head -20

# --- S2: explicit DSH_HOME wins; two environments stay isolated -------------

head1 "S2 explicit DSH_HOME wins; two isolated environments"
HOME_A="$WORK/homeA"; HOME_B="$WORK/homeB"; S2="$WORK/s2"; mkdir -p "$HOME_A" "$HOME_B" "$S2"
# Snapshot the default home so we can prove an explicit DSH_HOME never writes there.
DEF_BEFORE="$(find "$FAKE_HOME/.dsh" -type f -exec stat -f '%N %m %z' {} \; 2>/dev/null | sort)"

dsh_launch "$HOME_A" "$S2/a.out" "$S2/a.err" --profile web --host 127.0.0.1 --port 0 --no-open
A_PID=$dsh_pid
dsh_launch "$HOME_B" "$S2/b.out" "$S2/b.err" --profile web --host 127.0.0.1 --port 0 --no-open
B_PID=$dsh_pid

if A_LINE="$(wait_ready "$S2/a.out" "$A_PID" 60)"; then
  ok "env A ready on $(redact <<<"$A_LINE" | sed -E 's/.*(127\.0\.0\.1:[0-9]+).*/\1/')"
else
  bad "env A not ready"; head -10 "$S2/a.err"
fi
if B_LINE="$(wait_ready "$S2/b.out" "$B_PID" 60)"; then
  ok "env B ready on $(redact <<<"$B_LINE" | sed -E 's/.*(127\.0\.0\.1:[0-9]+).*/\1/')"
else
  bad "env B not ready"; head -10 "$S2/b.err"
fi

A_PORT="$(port_of_url "$A_LINE" 2>/dev/null || true)"
B_PORT="$(port_of_url "$B_LINE" 2>/dev/null || true)"
if [[ -n "$A_PORT" && -n "$B_PORT" && "$A_PORT" != "$B_PORT" ]]; then
  ok "each environment bound a distinct ephemeral port ($A_PORT vs $B_PORT)"
else
  bad "expected two distinct ports, got A=$A_PORT B=$B_PORT"
fi

for pair in "A:$HOME_A" "B:$HOME_B"; do
  name="${pair%%:*}"; home="${pair#*:}"
  if [[ -f "$home/profiles/web/package.json" && -f "$home/.credentials.yaml" ]]; then
    ok "env $name owns its profile and credential file under its own DSH_HOME"
  else
    bad "env $name missing profile/credential file under its own DSH_HOME"
  fi
done

# Cross-contamination check: neither home may contain the other's distinct marker file.
printf 'A-only\n' >"$HOME_A/probe-marker-a.txt"
if [[ ! -e "$HOME_B/probe-marker-a.txt" ]]; then ok "env B did not inherit env A's marker"; else bad "env B contains env A's marker"; fi
printf 'B-only\n' >"$HOME_B/probe-marker-b.txt"
if [[ ! -e "$HOME_A/probe-marker-b.txt" ]]; then ok "env A did not inherit env B's marker"; else bad "env A contains env B's marker"; fi

kill -TERM "$A_PID" 2>/dev/null; wait "$A_PID" 2>/dev/null; A_RC=$?
kill -TERM "$B_PID" 2>/dev/null; wait "$B_PID" 2>/dev/null; B_RC=$?
[[ "$A_RC" -eq 0 && "$B_RC" -eq 0 ]] && ok "both environments stopped with exit 0" || bad "stop exit codes A=$A_RC B=$B_RC"

DEF_AFTER="$(find "$FAKE_HOME/.dsh" -type f -exec stat -f '%N %m %z' {} \; 2>/dev/null | sort)"
if [[ "$DEF_BEFORE" == "$DEF_AFTER" ]]; then
  ok "default home \$HOME/.dsh unchanged while explicit DSH_HOME was used"
else
  bad "default home \$HOME/.dsh changed during explicit-DSH_HOME runs"
fi

# A blank or whitespace-only DSH_HOME must be ignored, never resolving to the CWD.
S2B="$WORK/s2b"; mkdir -p "$S2B/cwd"
( cd "$S2B/cwd" && env -i "PATH=/usr/bin:/bin:/usr/sbin:/sbin" "HOME=$FAKE_HOME" "DSH_HOME=   " "DSH_AGENTS_HOME=$FAKE_AGENTS" \
  "DSH_TELEMETRY_DISABLED=1" "DEEPSEEK_API_KEY=keyless-probe-no-call" "NODE_NO_WARNINGS=1" \
  "$NODE" "$BIN" --profile web --dump-config >"$S2B/out" 2>"$S2B/err" )
S2B_RC=$?
if [[ "$S2B_RC" -eq 0 ]] && [[ ! -e "$S2B/cwd/.dsh" ]]; then
  ok "whitespace-only DSH_HOME ignored; no .dsh created in CWD"
else
  bad "whitespace-only DSH_HOME handling unexpected (exit $S2B_RC, cwd .dsh=$([[ -e "$S2B/cwd/.dsh" ]] && echo present || echo absent))"
fi
say "dump-config rows: $(grep -c . "$S2B/out") lines, stderr: $(head -1 "$S2B/err")"

# --- S3: loopback readiness and binding -------------------------------------

head1 "S3 loopback readiness, token gate, and --host 0.0.0.0 rejection"
S3="$WORK/s3"; mkdir -p "$S3"
dsh_launch "$WORK/homeS3" "$S3/out" "$S3/err" --profile web --host 127.0.0.1 --port 0 --no-open
S3_PID=$dsh_pid
if S3_LINE="$(wait_ready "$S3/out" "$S3_PID" 60)"; then
  S3_URL="${S3_LINE#dsh web: }"
  S3_BASE="${S3_URL%%\?*}"
  S3_PORT="$(port_of_url "$S3_URL")"
  ok "ready line emitted: $(redact <<<"$S3_LINE")"
  # Auth gate: the printed URL is a one-shot bootstrap; the cookie carries the session.
  TOKEN_CODE="$(http_code "$S3_URL")"
  curl -s -D "$S3/hdr" -o /dev/null "$S3_URL"
  NOCOOKIE_CODE="$(http_code "$S3_BASE")"
  COOKIE_CODE="$(curl -s -L -c "$S3/jar" -b "$S3/jar" -o "$S3/body" -w '%{http_code}' "$S3_URL")"
  COOKIE_LEN="$(wc -c < "$S3/body" | tr -d ' ')"
  say "bootstrap URL   : HTTP $TOKEN_CODE"
  say "  location      : $(grep -i '^location:' "$S3/hdr" | tr -d '\r' | head -1)"
  say "  set-cookie    : $(grep -i '^set-cookie:' "$S3/hdr" | redact | tr -d '\r' | head -1)"
  say "without cookie : HTTP $NOCOOKIE_CODE"
  say "with cookie    : HTTP $COOKIE_CODE (${COOKIE_LEN} bytes)"
  [[ "$TOKEN_CODE" == "303" ]] && ok "token URL returns 303 (redirect to /)" || bad "expected 303 from token URL, got $TOKEN_CODE"
  grep -qi '^set-cookie: *dsh-auth-' "$S3/hdr" && ok "token URL sets a dsh-auth cookie" || bad "no dsh-auth cookie observed"
  [[ "$NOCOOKIE_CODE" == "401" ]] && ok "unauthenticated / is rejected with 401" || bad "expected 401 without cookie, got $NOCOOKIE_CODE"
  if [[ "$COOKIE_CODE" == "200" && "$COOKIE_LEN" -gt 1000 ]] && grep -qi '<html' "$S3/body"; then
    ok "authenticated request serves the Web app HTML"
  else
    bad "expected 200 HTML with cookie, got $COOKIE_CODE / ${COOKIE_LEN} bytes"
  fi
  LISTEN="$(lsof -nP -a -p "$S3_PID" -iTCP:"$S3_PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print $9}' | sort -u | tr '\n' ' ')"
  say "listener      : ${LISTEN:-<none found via lsof -p>}"
  if grep -q '127.0.0.1' <<<"$LISTEN"; then
    ok "listener is bound to 127.0.0.1 only"
  else
    bad "expected a 127.0.0.1 listener for pid $S3_PID, saw: ${LISTEN:-<none>}"
  fi
  if grep -qE '0\.0\.0\.0|\*:' <<<"$LISTEN"; then
    bad "listener appears bound to a wildcard address"
  else
    ok "no wildcard listener observed"
  fi
  kill -TERM "$S3_PID" 2>/dev/null; wait "$S3_PID" 2>/dev/null
  sleep 0.3
  if lsof -nP -iTCP:"$S3_PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
    bad "port $S3_PORT still listening after graceful stop"
  else
    ok "port released after graceful stop"
  fi
else
  bad "S3 web did not become ready"; head -10 "$S3/err"
fi

S3B="$WORK/s3b"; mkdir -p "$S3B"
dsh_launch "$WORK/homeS3b" "$S3B/out" "$S3B/err" --profile web --host 0.0.0.0 --port 0 --no-open
S3B_PID=$dsh_pid
wait "$S3B_PID" 2>/dev/null; S3B_RC=$?
say "0.0.0.0 exit   : $S3B_RC ; stderr: $(head -1 "$S3B/err")"
if [[ "$S3B_RC" -ne 0 ]] && grep -qi 'not supported' "$S3B/err"; then
  ok "--host 0.0.0.0 rejected with nonzero exit"
else
  bad "expected --host 0.0.0.0 rejection, got exit $S3B_RC"
fi

# --- S4: occupied port ------------------------------------------------------

head1 "S4 occupied port fails closed and writes diagnostics"
S4="$WORK/s4"; mkdir -p "$S4/home"
"$PYTHON" - "$S4/port" <<'PY' &
import socket, sys, time
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen(1)
with open(sys.argv[1], "w") as f:
    f.write(str(s.getsockname()[1]))
f = None
time.sleep(120)
PY
BLOCK_PID=$!
SPAWNED_PIDS+=("$BLOCK_PID")
for _ in $(seq 1 50); do [[ -s "$S4/port" ]] && break; sleep 0.1; done
BLOCK_PORT="$(cat "$S4/port" 2>/dev/null || echo '')"
say "blocked port   : $BLOCK_PORT"
dsh_launch "$S4/home" "$S4/out" "$S4/err" --profile web --host 127.0.0.1 --port "$BLOCK_PORT" --no-open
S4_PID=$dsh_pid
wait "$S4_PID" 2>/dev/null; S4_RC=$?
say "exit code      : $S4_RC"
say "stderr excerpt : $(grep -m1 -E 'startup failed|EADDRINUSE' "$S4/err" | tr -s ' ')"
DIAG="$(grep -oE 'Full diagnostics: .*' "$S4/err" | head -1)"
if [[ "$S4_RC" -ne 0 ]] && grep -q 'EADDRINUSE' "$S4/err"; then
  ok "occupied port produced nonzero exit and EADDRINUSE"
else
  bad "occupied port did not fail as expected (exit $S4_RC)"
fi
if [[ "$S4_RC" -ne 0 ]] && ! grep -q 'dsh web: http://' "$S4/out"; then
  ok "no ready URL printed on bind failure"
else
  bad "unexpected ready URL on bind failure"
fi
if [[ -n "$DIAG" ]]; then ok "startup diagnostics written: $(sed "s#$WORK#WORK#" <<<"$DIAG")"; else note "no 'Full diagnostics' line observed"; fi
if grep -q 'webserver (required)' "$S4/err"; then ok "failure names the required webserver plugin"; else note "webserver plugin not named in summary"; fi
kill -TERM "$BLOCK_PID" 2>/dev/null || true
wait "$BLOCK_PID" 2>/dev/null || true

# --- S5: stop the DSH process we own ----------------------------------------

head1 "S5 stop our own DSH process tree without touching unrelated processes"
S5="$WORK/s5"; mkdir -p "$S5"
# An unrelated process the probe owns; must survive the DSH stop.
sleep 300 &
BYSTANDER=$!
SPAWNED_PIDS+=("$BYSTANDER")

dsh_launch "$WORK/homeS5" "$S5/out" "$S5/err" --profile web --host 127.0.0.1 --port 0 --no-open
S5_PID=$dsh_pid
if S5_LINE="$(wait_ready "$S5/out" "$S5_PID" 60)"; then
  S5_PORT="$(port_of_url "${S5_LINE#dsh web: }")"
  BEFORE_KIDS=()
  while IFS= read -r kid; do [[ -n "$kid" ]] && BEFORE_KIDS+=("$kid"); done < <(descendants "$S5_PID")
  say "dsh pid        : $S5_PID"
  say "descendants    : ${BEFORE_KIDS[*]:-<none>}"
  kill -TERM "$S5_PID" 2>/dev/null
  wait "$S5_PID" 2>/dev/null; S5_RC=$?
  sleep 0.5
  if [[ "$S5_RC" -eq 0 ]]; then ok "SIGTERM exited 0"; else bad "SIGTERM exit was $S5_RC"; fi
  LEFTOVER=0
  if [[ "${#BEFORE_KIDS[@]}" -gt 0 ]]; then
    for kid in "${BEFORE_KIDS[@]}"; do
      if kill -0 "$kid" 2>/dev/null; then bad "owned child $kid still alive after stop"; LEFTOVER=1; fi
    done
  fi
  [[ "$LEFTOVER" -eq 0 ]] && ok "no owned descendant left running"
  if kill -0 "$BYSTANDER" 2>/dev/null; then ok "unrelated process survived (not signalled)"; else bad "unrelated process was killed"; fi
  if lsof -nP -iTCP:"$S5_PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then bad "owned port $S5_PORT still listening"; else ok "owned port released"; fi
else
  bad "S5 web did not become ready"; head -10 "$S5/err"
fi
kill -TERM "$BYSTANDER" 2>/dev/null || true
wait "$BYSTANDER" 2>/dev/null || true

# SIGINT must report 130.
dsh_launch "$WORK/homeS5b" "$S5/i.out" "$S5/i.err" --profile web --host 127.0.0.1 --port 0 --no-open
S5B_PID=$dsh_pid
if wait_ready "$S5/i.out" "$S5B_PID" 60 >/dev/null; then
  kill -INT "$S5B_PID" 2>/dev/null
  wait "$S5B_PID" 2>/dev/null; S5B_RC=$?
  if [[ "$S5B_RC" -eq 130 ]]; then ok "SIGINT exited 130"; else bad "SIGINT exit was $S5B_RC (expected 130)"; fi
else
  bad "S5b web did not become ready"; head -10 "$S5/i.err"
fi

# --- summary ----------------------------------------------------------------

head1 "SUMMARY"
if [[ "$FAILURES" -eq 0 ]]; then
  say "all probes passed"
else
  say "$FAILURES probe assertion(s) failed"
fi
say "workspace: $WORK (removed on exit unless the script was interrupted)"
exit $((FAILURES > 0 ? 1 : 0))
