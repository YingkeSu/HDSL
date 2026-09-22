#!/usr/bin/env bash
# A2 closed-loop probe on a fixed-integrity DSH 0.1.5-rc.2 install (own copy):
#   profileInit (exact args, isolated staging home) -> publish into an
#   environment-home profiles dir -> real managed process boots with
#   `--profile hdsl-<gen>` and reaches the web readiness line -> stop -> cleanup.
#
# This is REAL rc.2 process evidence for the profile-init/publish/--profile
# closure. It is NOT a real npm-ci installer run (the installer path is exercised
# by the runtime `executeCommand` adapter seam in CI) and it does not represent
# #76 as complete. No model requests, no credentials, no third-party plugins.
#
# Usage: scripts/research/a2-profile-init-boot-probe.sh <generation-directory>
#   The source install is read-only; only an own clone under $TMPDIR is modified.
set -u -o pipefail

GENERATION="${1:-}"
EXPECTED_DSH_VERSION="0.1.5-rc.2"
EXPECTED_DSH_SHA256="f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480"
PROFILE_NAME="hdsl-genprobe"
READY_TIMEOUT=30

if [ -z "$GENERATION" ] || [ ! -f "$GENERATION/install-manifest.json" ]; then
  echo "usage: $0 <generation-directory>" >&2
  exit 2
fi
python3 - "$GENERATION/install-manifest.json" "$EXPECTED_DSH_VERSION" "$EXPECTED_DSH_SHA256" <<'PY' || exit 2
import json, sys
data = json.load(open(sys.argv[1]))
dsh = data.get("dsh", {})
if dsh.get("version") != sys.argv[2] or dsh.get("sha256") != sys.argv[3] or data.get("installMode") != "npm-ci":
    print(f"REFUSE: identity mismatch {dsh.get('version')} {dsh.get('sha256')} {data.get('installMode')}", file=sys.stderr)
    raise SystemExit(2)
print(f"identity OK: dsh {dsh['version']} sha256 {dsh['sha256'][:16]}… installMode=npm-ci")
PY

mask() { sed -E 's/token=[A-Za-z0-9_-]+/token=<redacted>/g'; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-a2-loop-XXXXXX")"
cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "$WORK"; }
trap cleanup EXIT
cp -Rc "$GENERATION/dsh" "$WORK/dsh" 2>/dev/null || cp -R "$GENERATION/dsh" "$WORK/dsh"
NODE="$(command -v node)"
if [ -x "$GENERATION/node/bin/node" ]; then
  cp -Rc "$GENERATION/node" "$WORK/node" 2>/dev/null || cp -R "$GENERATION/node" "$WORK/node"
  NODE="$WORK/node/bin/node"
fi
echo "node identity: $("$NODE" --version)"
DSH="$WORK/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"

STAGED_HOME="$WORK/stage"
ENV_HOME="$WORK/env/home"
mkdir -p "$STAGED_HOME"

echo "profileInit: node $DSH --profile $PROFILE_NAME --from-default-profile web --dump-config"
HOME="$STAGED_HOME" DSH_HOME="$STAGED_HOME" DSH_TELEMETRY_DISABLED=1 \
  "$NODE" "$DSH" --profile "$PROFILE_NAME" --from-default-profile web --dump-config \
  > "$WORK/init.log" 2>&1
INIT_EXIT=$?
SOURCE="$STAGED_HOME/profiles/$PROFILE_NAME"
if [ "$INIT_EXIT" -ne 0 ] || [ ! -f "$SOURCE/package.json" ]; then
  echo "FAIL: profileInit did not produce a declaration source (exit $INIT_EXIT)"; tail -5 "$WORK/init.log" | mask; exit 1
fi
echo "  declaration source files: $(ls "$SOURCE" | tr '\n' ' ')"
LINK_OUTSIDE=""
find "$SOURCE" -type l > "$WORK/links.txt" 2>/dev/null || true
while read -r l; do
  [ -n "$l" ] || continue
  t="$(readlink "$l" || true)"
  if [ "${t#"$STAGED_HOME"/}" != "$t" ]; then LINK_OUTSIDE="$LINK_OUTSIDE$l -> $t\n"; fi
done < "$WORK/links.txt"
if [ -n "$LINK_OUTSIDE" ]; then echo "FAIL: staged profile links into the staging home: $LINK_OUTSIDE"; exit 1; fi
echo "  no internal links into the staging home"

echo "publish: move profile into the environment home and delete the staging home"
mkdir -p "$ENV_HOME/profiles"
mv "$SOURCE" "$ENV_HOME/profiles/$PROFILE_NAME"
rm -rf "$STAGED_HOME"
BROKEN=""
find "$ENV_HOME/profiles/$PROFILE_NAME" -type l > "$WORK/published-links.txt" 2>/dev/null || true
while read -r l; do
  [ -n "$l" ] || continue
  t="$(readlink "$l" || true)"
  if [ ! -e "$t" ]; then BROKEN="$BROKEN$l -> $t\n"; fi
done < "$WORK/published-links.txt"
if [ -n "$BROKEN" ]; then echo "FAIL: dangling link after publish: $BROKEN"; exit 1; fi
echo "  published profile intact, no dangling links"

echo "boot: real managed process with --profile $PROFILE_NAME"
HOME="$ENV_HOME" DSH_HOME="$ENV_HOME" DSH_TELEMETRY_DISABLED=1 \
  "$NODE" "$DSH" --profile "$PROFILE_NAME" --no-open --host 127.0.0.1 --port 0 \
  > "$WORK/boot.log" 2>&1 &
PID=$!
READY=no
for i in $(seq 1 "$READY_TIMEOUT"); do
  sleep 1
  if grep -q "dsh web:" "$WORK/boot.log"; then READY="ready@${i}s"; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then READY="exited@${i}s"; break; fi
done
if [ "$READY" = "no" ] || [ "${READY#ready}" = "$READY" ]; then
  echo "FAIL: profile $PROFILE_NAME did not reach web readiness ($READY)"; tail -5 "$WORK/boot.log" | mask; kill "$PID" 2>/dev/null || true; exit 1
fi
echo "  boot $READY; ready line: $(grep -o 'dsh web: http[^ ]*' "$WORK/boot.log" | mask | head -1)"
echo "  shared home runtime data: $(ls -a "$ENV_HOME" | tr '\n' ' ')"

kill "$PID" 2>/dev/null || true
for i in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$PID" 2>/dev/null; then kill -9 "$PID" 2>/dev/null || true; echo "  stopped with SIGKILL after grace"; else echo "  stopped with SIGTERM"; fi

echo "RESULT: PASS — real rc.2 profileInit -> publish -> --profile boot ready -> stop"
echo "NOTE: installer-path profileInit is adapter-seam evidence in CI; this probe uses an own copy of a fixed rc.2 install."
