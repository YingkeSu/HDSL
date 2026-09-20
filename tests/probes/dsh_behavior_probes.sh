#!/usr/bin/env bash
#
# Reproducible behavior probes against the real, official DeepSeek Harness (DSH) CLI.
#
# Scope: two isolated DSH homes, default `~/.dsh` resolution, loopback readiness and
# binding, occupied-port failure, stopping a DSH process we own, and the boundaries of
# two filesystem artifacts a launcher must reason about:
#   - the `$DSH_HOME/profiles/node_modules` module fallback and its install anchor
#   - the `$DSH_HOME/.credentials.yaml` temporary credential document
#
# Safety: every probe runs with an explicit temporary HOME, DSH_HOME, and working
# directory under $TMPDIR, a scrubbed environment, telemetry disabled, and a
# non-secret placeholder API key. It never reads or writes the operator's real
# `~/.dsh`, settings, or credentials. It only signals processes it spawned and that
# have not been reaped: a reaped PID is removed from the live set immediately, so a
# stale PID can never be signalled.
#
# The script is version-parameterized. Results are only meaningful per exact CLI
# version; never mix conclusions from two runs. Record DSH_LABEL/DSH_EXPECT_VERSION,
# and for a source checkout also DSH_EXPECT_COMMIT + DSH_EXPECT_NODE.
#
# Required tools: node, python3, curl, lsof, pgrep.
#
# Usage:
#   # Source-checkout build (0.1.6-alpha.2), pinned to a commit:
#   DSH_REPO=/path/to/deepseek-harness DSH_LABEL=0.1.6-alpha.2 \
#     DSH_EXPECT_VERSION=0.1.6-alpha.2 \
#     DSH_EXPECT_COMMIT=ddefc45fbc7f8e46dd73185e68295696d1297887 \
#     DSH_EXPECT_NODE=v25.6.1 tests/probes/dsh_behavior_probes.sh
#
#   # npm-installed release (0.1.5-rc.2):
#   DSH_BIN=/tmp/dsh-015/node_modules/@deepseek-ai/dsh/lib/bin.js \
#     DSH_INSTALL_ROOT=/tmp/dsh-015 DSH_LABEL=0.1.5-rc.2 \
#     DSH_EXPECT_VERSION=0.1.5-rc.2 DSH_EXPECT_NODE=v25.6.1 \
#     tests/probes/dsh_behavior_probes.sh
#
# Exit status: 0 when every assertion holds, 1 otherwise, 2 on missing prerequisites.

set -u

NODE="${DSH_NODE:-$(command -v node || true)}"
PYTHON="${DSH_PYTHON:-$(command -v python3 || true)}"
DSH_REPO="${DSH_REPO:-}"
BIN="${DSH_BIN:-${DSH_REPO:+$DSH_REPO/apps/cli/lib/bin.js}}"

if [[ -z "$BIN" ]]; then echo "FATAL: set DSH_BIN or DSH_REPO" >&2; exit 2; fi
if [[ -z "${DSH_INSTALL_ROOT:-}" ]]; then
  case "$BIN" in
    */node_modules/@deepseek-ai/dsh/lib/bin.js) DSH_INSTALL_ROOT="${BIN%/node_modules/@deepseek-ai/dsh/lib/bin.js}" ;;
    */apps/cli/lib/bin.js) DSH_INSTALL_ROOT="${BIN%/apps/cli/lib/bin.js}" ;;
    *) DSH_INSTALL_ROOT="$(cd "$(dirname "$BIN")/../../.." && pwd)" ;;
  esac
fi
DSH_INSTALL_ROOT="$(cd "$DSH_INSTALL_ROOT" 2>/dev/null && pwd || printf '%s' "$DSH_INSTALL_ROOT")"

if [[ -z "$NODE" || ! -x "$NODE" ]]; then echo "FATAL: node not found (set DSH_NODE)" >&2; exit 2; fi
if [[ ! -f "$BIN" ]]; then echo "FATAL: CLI bin not found at $BIN (set DSH_BIN or DSH_REPO)" >&2; exit 2; fi
if [[ -z "$PYTHON" ]]; then echo "FATAL: python3 not found (set DSH_PYTHON)" >&2; exit 2; fi
for tool in curl lsof pgrep; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: required tool '$tool' not found on PATH" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-probes.XXXXXX")"
FAKE_HOME="$WORK/fakehome"      # stands in for the operator home; default home would be $FAKE_HOME/.dsh
FAKE_AGENTS="$WORK/fake-agents"
CWD_DIR="$WORK/cwd"             # every DSH launch runs here, never in the caller's CWD
mkdir -p "$FAKE_HOME" "$FAKE_AGENTS" "$CWD_DIR"

PASSED=0
FAILED=0
LIVE_PIDS_FILE="$WORK/live-pids"
: >"$LIVE_PIDS_FILE"

say()  { printf '%s\n' "$*"; }
head1(){ printf '\n===== %s =====\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; PASSED=$((PASSED + 1)); }
bad()  { printf 'FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
note() { printf 'NOTE  %s\n' "$*"; }

register_pid() { printf '%s\n' "$1" >>"$LIVE_PIDS_FILE"; }
forget_pid() {
  local target="$1"
  grep -vx "$target" "$LIVE_PIDS_FILE" >"$LIVE_PIDS_FILE.tmp" 2>/dev/null || true
  mv "$LIVE_PIDS_FILE.tmp" "$LIVE_PIDS_FILE"
}
# Wait for a spawned PID and drop it from the live set so cleanup can never signal a stale PID.
wait_pid() {
  local pid="$1" rc
  wait "$pid" 2>/dev/null; rc=$?
  forget_pid "$pid"
  return $rc
}
cleanup() {
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill -KILL "$pid" 2>/dev/null || true
  done <"$LIVE_PIDS_FILE"
  # Only remove the work tree if it still belongs to us (it does unless the operator moved it).
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- helpers -----------------------------------------------------------------

# Launch the DSH CLI with a scrubbed environment, a temporary CWD, and temporary home.
# $1 = DSH_HOME value ("@" means leave DSH_HOME unset -> default ~/.dsh)
# $2 = stdout log, $3 = stderr log, remaining args = CLI args. Sets $dsh_pid.
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
  # The subshell execs into `env`, so $! is the final DSH PID and it inherits CWD_DIR.
  ( cd "$CWD_DIR" && exec env -i "${envargs[@]}" "$NODE" "$BIN" "$@" ) >"$out" 2>"$err" &
  dsh_pid=$!
  register_pid "$dsh_pid"
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

# Recursively list descendant PIDs of $1 (macOS: pgrep -P).
descendants() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    printf '%s\n' "$child"
    descendants "$child"
  done
}

port_of_url() { sed -E 's#.*://[^:/]+:([0-9]+).*#\1#' <<<"$1"; }

credential_secret() { grep -oE 'secret: .*' "$1" 2>/dev/null | awk '{print $2}'; }

# Walk the module fallback and report package symlinks outside the install root.
# $1 = modules dir, $2 = install root.
fallback_symlink_report() {
  "$PYTHON" - "$1" "$2" <<'PY'
import os, sys
mods, install_root = sys.argv[1], os.path.realpath(sys.argv[2])
links, outside = 0, []
for dirpath, dirnames, _ in os.walk(mods):
    for name in list(dirnames):
        path = os.path.join(dirpath, name)
        if os.path.islink(path):
            dirnames.remove(name)
            links += 1
            target = os.path.realpath(path)
            if not (target == install_root or target.startswith(install_root + os.sep)):
                outside.append((path, target))
for name in os.listdir(mods):
    path = os.path.join(mods, name)
    if os.path.islink(path):
        links += 1
        target = os.path.realpath(path)
        if not (target == install_root or target.startswith(install_root + os.sep)):
            outside.append((path, target))
print(f"package_symlinks={links} outside_install_root={len(outside)}")
for path, target in outside[:10]:
    print(f"OUTSIDE {path} -> {target}")
PY
}

# --- S0: provenance and version ---------------------------------------------

head1 "S0 provenance and version"
say "label          : ${DSH_LABEL:-<unset>}"
say "platform       : $(uname -srm)"
say "umask          : $(umask)"
say "node           : $("$NODE" --version)"
say "cli path       : $BIN"
say "install root   : $DSH_INSTALL_ROOT"
VER="$("$NODE" "$BIN" --version)"
say "cli --version  : $VER"
if [[ -n "${DSH_EXPECT_VERSION:-}" ]]; then
  [[ "$VER" == "$DSH_EXPECT_VERSION" ]] && ok "CLI reports expected version $DSH_EXPECT_VERSION" || bad "CLI reports $VER, expected $DSH_EXPECT_VERSION"
else
  note "DSH_EXPECT_VERSION unset; version not asserted"
fi
if [[ -n "${DSH_EXPECT_NODE:-}" ]]; then
  NODE_VER="$("$NODE" --version)"
  [[ "$NODE_VER" == "$DSH_EXPECT_NODE" ]] && ok "Node reports expected $DSH_EXPECT_NODE" || bad "Node reports $NODE_VER, expected $DSH_EXPECT_NODE"
else
  note "DSH_EXPECT_NODE unset; Node version not asserted"
fi
if [[ -n "${DSH_EXPECT_COMMIT:-}" ]]; then
  if [[ -d "$DSH_REPO/.git" ]]; then
    HEAD_SHA="$(git -C "$DSH_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
    DIRTY="$(git -C "$DSH_REPO" status --porcelain 2>/dev/null | grep -vc '^??' || true)"
    say "repo HEAD      : $HEAD_SHA"
    say "repo dirtiness : $DIRTY tracked modifications"
    [[ "$HEAD_SHA" == "$DSH_EXPECT_COMMIT" ]] && ok "source checkout is at expected commit $DSH_EXPECT_COMMIT" || bad "source HEAD $HEAD_SHA, expected $DSH_EXPECT_COMMIT"
    [[ "$DIRTY" == "0" ]] && ok "source checkout has no tracked modifications" || bad "source checkout has $DIRTY tracked modifications"
  else
    bad "DSH_EXPECT_COMMIT set but DSH_REPO ($DSH_REPO) has no .git"
  fi
elif [[ -d "${DSH_REPO:-/nonexistent}/.git" ]]; then
  say "repo HEAD      : $(git -C "$DSH_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
  note "DSH_EXPECT_COMMIT unset; source commit not asserted"
else
  note "no source checkout provided; commit not asserted (npm install)"
fi

# --- S1: default home resolves to ~/.dsh ------------------------------------

head1 "S1 default home = \$HOME/.dsh (DSH_HOME unset)"
S1="$WORK/s1"; mkdir -p "$S1"
# Pre-create the default home so we can detect whether a boot writes there at all.
mkdir -p "$FAKE_HOME/.dsh"
dsh_launch "@" "$S1/out" "$S1/err" --profile web --host 127.0.0.1 --port 0 --no-open
S1_PID=$dsh_pid
if LINE="$(wait_ready "$S1/out" "$S1_PID" 60)"; then
  say "ready line : $(redact <<<"$LINE")"
  if [[ -f "$FAKE_HOME/.dsh/profiles/web/package.json" ]]; then
    ok "default home \$HOME/.dsh was initialized (profiles/web/package.json present)"
  else
    bad "default home \$HOME/.dsh/profiles/web/package.json missing"
  fi
  kill -TERM "$S1_PID" 2>/dev/null; wait_pid "$S1_PID"; S1_RC=$?
  [[ "$S1_RC" -eq 0 ]] && ok "SIGTERM on default-home web exited 0" || bad "SIGTERM exit was $S1_RC"
else
  bad "default-home web did not become ready"; head -10 "$S1/err" | redact
fi

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
  bad "env A not ready"; head -10 "$S2/a.err" | redact
fi
if B_LINE="$(wait_ready "$S2/b.out" "$B_PID" 60)"; then
  ok "env B ready on $(redact <<<"$B_LINE" | sed -E 's/.*(127\.0\.0\.1:[0-9]+).*/\1/')"
else
  bad "env B not ready"; head -10 "$S2/b.err" | redact
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
    ok "env $name owns a DSH-generated profile and credential file under its own DSH_HOME"
  else
    bad "env $name missing DSH profile/credential file under its own DSH_HOME"
  fi
done

# Isolation evidence from DSH-generated state, not from files the probe writes itself:
# each launch mints its own browser-session secret, and each home keeps its own copy.
SECRET_A="$(credential_secret "$HOME_A/.credentials.yaml")"
SECRET_B="$(credential_secret "$HOME_B/.credentials.yaml")"
if [[ -n "$SECRET_A" && -n "$SECRET_B" && "$SECRET_A" != "$SECRET_B" ]]; then
  ok "env A and env B hold distinct DSH-generated credential secrets"
else
  bad "expected distinct DSH-generated credential secrets per environment"
fi
if [[ -f "$HOME_A/profiles/web/package.json" && -f "$HOME_B/profiles/web/package.json" ]]; then
  ok "each home carries its own profiles/web manifest (no shared profile directory)"
else
  bad "expected each home to carry its own profiles/web manifest"
fi

kill -TERM "$A_PID" 2>/dev/null; wait_pid "$A_PID"; A_RC=$?
kill -TERM "$B_PID" 2>/dev/null; wait_pid "$B_PID"; B_RC=$?
[[ "$A_RC" -eq 0 && "$B_RC" -eq 0 ]] && ok "both environments stopped with exit 0" || bad "stop exit codes A=$A_RC B=$B_RC"

DEF_AFTER="$(find "$FAKE_HOME/.dsh" -type f -exec stat -f '%N %m %z' {} \; 2>/dev/null | sort)"
[[ "$DEF_BEFORE" == "$DEF_AFTER" ]] && ok "default home \$HOME/.dsh unchanged while explicit DSH_HOME was used" || bad "default home \$HOME/.dsh changed during explicit-DSH_HOME runs"

# --- S2b: whitespace-only DSH_HOME is ignored -------------------------------

head1 "S2b whitespace-only DSH_HOME is ignored"
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
say "dump-config rows: $(grep -c . "$S2B/out") lines, stderr: $(head -1 "$S2B/err" | redact)"

# --- S3: loopback readiness, token gate, and binding ------------------------

head1 "S3 loopback readiness, token gate, and --host 0.0.0.0 rejection"
S3="$WORK/s3"; mkdir -p "$S3"
dsh_launch "$WORK/homeS3" "$S3/out" "$S3/err" --profile web --host 127.0.0.1 --port 0 --no-open
S3_PID=$dsh_pid
if S3_LINE="$(wait_ready "$S3/out" "$S3_PID" 60)"; then
  S3_URL="${S3_LINE#dsh web: }"
  S3_BASE="${S3_URL%%\?*}"
  S3_PORT="$(port_of_url "$S3_URL")"
  ok "ready line emitted: $(redact <<<"$S3_LINE")"
  # The printed URL carries a process-scoped bootstrap token (reusable for the life
  # of this DSH process, not one-shot); the dsh-auth cookie establishes the session.
  TOKEN_CODE="$(http_code "$S3_URL")"
  curl -s -D "$S3/hdr" -o /dev/null "$S3_URL"
  TOKEN_CODE_2="$(head -1 "$S3/hdr" | tr -d '\r' | awk '{print $2}')"
  NOCOOKIE_CODE="$(http_code "$S3_BASE")"
  COOKIE_CODE="$(curl -s -L -c "$S3/jar" -b "$S3/jar" -o "$S3/body" -w '%{http_code}' "$S3_URL")"
  COOKIE_LEN="$(wc -c < "$S3/body" | tr -d ' ')"
  say "bootstrap URL   : HTTP $TOKEN_CODE (repeat request HTTP $TOKEN_CODE_2)"
  say "  location      : $(grep -i '^location:' "$S3/hdr" | tr -d '\r' | head -1)"
  say "  set-cookie    : $(grep -i '^set-cookie:' "$S3/hdr" | redact | tr -d '\r' | head -1)"
  say "without cookie : HTTP $NOCOOKIE_CODE"
  say "with cookie    : HTTP $COOKIE_CODE (${COOKIE_LEN} bytes)"
  [[ "$TOKEN_CODE" == "303" ]] && ok "token URL returns 303 (redirect to /)" || bad "expected 303 from token URL, got $TOKEN_CODE"
  [[ "$TOKEN_CODE_2" == "303" ]] && ok "token is reusable within the process (repeat request also 303)" || bad "repeat token request returned $TOKEN_CODE_2, expected 303"
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
  kill -TERM "$S3_PID" 2>/dev/null; wait_pid "$S3_PID"
  sleep 0.3
  if lsof -nP -iTCP:"$S3_PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
    bad "port $S3_PORT still listening after graceful stop"
  else
    ok "port released after graceful stop"
  fi
else
  bad "S3 web did not become ready"; head -10 "$S3/err" | redact
fi

S3B="$WORK/s3b"; mkdir -p "$S3B"
dsh_launch "$WORK/homeS3b" "$S3B/out" "$S3B/err" --profile web --host 0.0.0.0 --port 0 --no-open
S3B_PID=$dsh_pid
wait_pid "$S3B_PID"; S3B_RC=$?
say "0.0.0.0 exit   : $S3B_RC ; stderr: $(head -1 "$S3B/err" | redact)"
if [[ "$S3B_RC" -ne 0 ]] && grep -qi 'not supported' "$S3B/err"; then
  ok "--host 0.0.0.0 rejected with nonzero exit"
else
  bad "expected --host 0.0.0.0 rejection, got exit $S3B_RC"
fi

# --- S4: occupied port ------------------------------------------------------

head1 "S4 occupied port fails closed"
S4="$WORK/s4"; mkdir -p "$S4/home"
"$PYTHON" - "$S4/port" <<'PY' &
import socket, sys, time
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen(1)
with open(sys.argv[1], "w") as f:
    f.write(str(s.getsockname()[1]))
time.sleep(120)
PY
BLOCK_PID=$!
register_pid "$BLOCK_PID"
for _ in $(seq 1 50); do [[ -s "$S4/port" ]] && break; sleep 0.1; done
BLOCK_PORT="$(cat "$S4/port" 2>/dev/null || echo '')"
say "blocked port   : $BLOCK_PORT"
dsh_launch "$S4/home" "$S4/out" "$S4/err" --profile web --host 127.0.0.1 --port "$BLOCK_PORT" --no-open
S4_PID=$dsh_pid
wait_pid "$S4_PID"; S4_RC=$?
say "exit code      : $S4_RC"
say "stderr excerpt : $(grep -m1 -E 'startup failed|EADDRINUSE' "$S4/err" | tr -s ' ' | redact)"
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
# Diagnostics differ by version: alpha.2 writes a structured report, rc.2 does not.
DIAG="$(grep -oE 'Full diagnostics: .*' "$S4/err" | head -1)"
if grep -q 'webserver (required)' "$S4/err"; then
  ok "failure names the required webserver plugin (structured diagnostics)"
elif [[ -n "$DIAG" ]]; then
  bad "diagnostics path present but webserver plugin not named"
else
  note "no structured diagnostics summary in this version's bind failure (raw stack only)"
fi
if [[ -n "$DIAG" ]]; then
  say "diagnostics    : $(sed "s#$WORK#WORK#" <<<"$DIAG")"
  DIAG_FILE="${DIAG#Full diagnostics: }"
  [[ -f "$DIAG_FILE" ]] && ok "diagnostics file exists on disk" || bad "diagnostics path reported but file missing: $DIAG_FILE"
else
  DIAG_DIR="$S4/home/logs"
  [[ -d "$DIAG_DIR" ]] && note "logs dir exists despite no summary line" || note "no \$DSH_HOME/logs created on bind failure in this version"
fi
kill -TERM "$BLOCK_PID" 2>/dev/null || true
wait_pid "$BLOCK_PID" || true

# --- S5: stop the DSH process we own ----------------------------------------

head1 "S5 stop our own DSH process tree without touching unrelated processes"
S5="$WORK/s5"; mkdir -p "$S5"
sleep 300 &
BYSTANDER=$!
register_pid "$BYSTANDER"

dsh_launch "$WORK/homeS5" "$S5/out" "$S5/err" --profile web --host 127.0.0.1 --port 0 --no-open
S5_PID=$dsh_pid
if S5_LINE="$(wait_ready "$S5/out" "$S5_PID" 60)"; then
  S5_PORT="$(port_of_url "${S5_LINE#dsh web: }")"
  BEFORE_KIDS=()
  while IFS= read -r kid; do [[ -n "$kid" ]] && BEFORE_KIDS+=("$kid"); done < <(descendants "$S5_PID")
  say "dsh pid        : $S5_PID"
  say "descendants    : ${BEFORE_KIDS[*]:-<none>}"
  kill -TERM "$S5_PID" 2>/dev/null
  wait_pid "$S5_PID"; S5_RC=$?
  sleep 0.5
  [[ "$S5_RC" -eq 0 ]] && ok "SIGTERM exited 0" || bad "SIGTERM exit was $S5_RC"
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
  bad "S5 web did not become ready"; head -10 "$S5/err" | redact
fi
kill -TERM "$BYSTANDER" 2>/dev/null || true
wait_pid "$BYSTANDER" || true

# SIGINT must report 130.
dsh_launch "$WORK/homeS5b" "$S5/i.out" "$S5/i.err" --profile web --host 127.0.0.1 --port 0 --no-open
S5B_PID=$dsh_pid
if wait_ready "$S5/i.out" "$S5B_PID" 60 >/dev/null; then
  kill -INT "$S5B_PID" 2>/dev/null
  wait_pid "$S5B_PID"; S5B_RC=$?
  [[ "$S5B_RC" -eq 130 ]] && ok "SIGINT exited 130" || bad "SIGINT exit was $S5B_RC (expected 130)"
else
  bad "S5b web did not become ready"; head -10 "$S5/i.err" | redact
fi

# --- S6: module fallback and credential artifact boundaries -----------------

head1 "S6 module fallback install anchor and credential file boundary"
S6="$WORK/s6"; mkdir -p "$S6/cwd"   # do NOT pre-create the homes; let DSH create them
# Prove DSH creates the home with its own mode rather than inheriting a shell mkdir mode.
dsh_launch "$S6/home" "$S6/o1" "$S6/e1" --profile web --host 127.0.0.1 --port 0 --no-open
S6_PID=$dsh_pid
if wait_ready "$S6/o1" "$S6_PID" 60 >/dev/null; then
  MODS="$S6/home/profiles/node_modules"
  if [[ -d "$MODS" ]]; then
    REPORT="$(fallback_symlink_report "$MODS" "$DSH_INSTALL_ROOT")"
    ok "module fallback created at \$DSH_HOME/profiles/node_modules"
    say "fallback        : $REPORT"
    LINKS="${REPORT#package_symlinks=}"; LINKS="${LINKS%% *}"
    OUTSIDE="${REPORT##*outside_install_root=}"; OUTSIDE="${OUTSIDE%%$'\n'*}"
    if [[ "$LINKS" -gt 0 && "$OUTSIDE" == "0" ]]; then
      ok "all $LINKS fallback package symlinks resolve inside the install root ($DSH_INSTALL_ROOT)"
    else
      bad "fallback symlinks not fully inside install root (links=$LINKS outside=$OUTSIDE)"
    fi
    BASE_PKG="$MODS/@deepseek-ai/dsh-base/package.json"
    if [[ -f "$BASE_PKG" ]]; then
      say "fallback dsh-base version: $("$PYTHON" -c "import json;print(json.load(open('$BASE_PKG'))['version'])" 2>/dev/null || echo '?')"
    fi
  else
    note "no \$DSH_HOME/profiles/node_modules created (runtime resolution in this version)"
  fi
  # Observable directory mode when DSH, not the shell, creates the home.
  HOME_MODE="$(stat -f '%Lp' "$S6/home" 2>/dev/null || echo '?')"
  say "DSH-created \$DSH_HOME mode: $HOME_MODE (umask $(umask); not an upstream documented guarantee)"
  kill -TERM "$S6_PID" 2>/dev/null; wait_pid "$S6_PID"
else
  bad "S6 first home did not become ready"; head -10 "$S6/e1" | redact
fi

dsh_launch "$S6/home2" "$S6/o2" "$S6/e2" --profile web --host 127.0.0.1 --port 0 --no-open
S6B_PID=$dsh_pid
if wait_ready "$S6/o2" "$S6B_PID" 60 >/dev/null; then
  kill -TERM "$S6B_PID" 2>/dev/null; wait_pid "$S6B_PID"
  CRED1="$S6/home/.credentials.yaml"; CRED2="$S6/home2/.credentials.yaml"
  if [[ -f "$CRED1" && -f "$CRED2" ]]; then
    M1="$(stat -f '%Lp' "$CRED1")"; M2="$(stat -f '%Lp' "$CRED2")"
    say "credential modes: home=$M1 home2=$M2"
    [[ "$M1" == "600" && "$M2" == "600" ]] && ok "both credential documents are mode 0600" || bad "credential mode not 0600 ($M1/$M2)"
    S1S="$(credential_secret "$CRED1")"; S2S="$(credential_secret "$CRED2")"
    if [[ -n "$S1S" && -n "$S2S" && "$S1S" != "$S2S" ]]; then
      ok "credential secret is distinct per environment"
    else
      bad "expected distinct credential secrets per environment"
    fi
    if [[ ! -e "$DSH_INSTALL_ROOT/.credentials.yaml" && ! -e "$S6/cwd/.credentials.yaml" && ! -e "$FAKE_HOME/.credentials.yaml" ]]; then
      ok "no credential document written to install root, CWD, or \$HOME"
    else
      bad "credential document escaped its DSH_HOME boundary"
    fi
    say "credential keys  : $(grep -oE '^  [a-z-]+/[a-z-]+:' "$CRED1" | tr -d ' ' | tr '\n' ',')"
  else
    bad "credential document missing under one of the two DSH_HOMEs"
  fi
  if [[ -e "$DSH_INSTALL_ROOT/.dsh" ]]; then bad "install root received a .dsh directory"; else ok "install root has no .dsh side effects"; fi
else
  bad "S6 second home did not become ready"; head -10 "$S6/e2" | redact
fi

# --- CWD side-effect check and summary --------------------------------------

head1 "CWD side-effect check"
CWD_AFTER="$(cd "$CWD_DIR" && ls -A 2>/dev/null | sort | tr '\n' ' ')"
if [[ -z "$CWD_AFTER" ]]; then
  ok "probe working directory stayed empty (no .dsh/.credentials/session side effects)"
else
  bad "probe working directory received files: $CWD_AFTER"
fi

head1 "SUMMARY"
say "label: ${DSH_LABEL:-<unset>}  version: $VER  install root: $DSH_INSTALL_ROOT"
say "assertions: ${PASSED}/$((PASSED + FAILED)) passed, ${FAILED} failed"
say "workspace: $WORK is removed on exit, including on SIGINT/SIGTERM; copy it first to keep evidence"
[[ "$FAILED" -eq 0 ]] && exit 0 || exit 1
