#!/usr/bin/env bash
# Default-deny / isolated-allow sentinel on the frozen managed pnpm chain
# (ADR 0005 D14). Opt-in; no model, no credentials, no unknown scripts.
#
# Fixtures are OUR OWN reviewed packages: a root project and a git-hosted
# dependency whose preinstall/install/postinstall/prepare scripts write external
# marker files. The observation is the marker files (external side effect), not
# the executor's self-report.
#
#   deny  : `pnpm install --ignore-scripts`  -> NO markers (root or dependency)
#   allow : `pnpm install --ignore-scripts=false` + a precise
#           `allowBuilds: {"<name>@git+<url>#<sha>": true}` (test-only) -> markers
#           appear, proving the sentinel is not vacuous.
#
# The allow form is test-isolated and is NOT an S4 production authorization.
#
# Usage (needs the frozen artifact cache from the freeze step):
#   HDSL_PNPM_ENTRY=<.../extract/bin/pnpm.mjs> HDSL_NODE=<managed node> \
#     scripts/research/a2-pnpm-sentinel-probe.sh
set -u -o pipefail

NODE="${HDSL_NODE:-}"
PNPM="${HDSL_PNPM_ENTRY:-}"
if [ -z "$NODE" ] || [ -z "$PNPM" ] || [ ! -x "$NODE" ] || [ ! -f "$PNPM" ]; then
  echo "SKIP: set HDSL_NODE (managed node) and HDSL_PNPM_ENTRY (frozen bin/pnpm.mjs)" >&2
  exit 2
fi
echo "node: $("$NODE" --version)"; echo "pnpm: $PNPM"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-pnpm-sentinel-XXXXXX")"
cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "$WORK"; }
trap cleanup EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
mkdir -p "$WORK/dep" "$WORK/root" "$WORK/home" "$WORK/markers"

python3 - "$WORK/dep/package.json" "$WORK/markers" <<'PY'
import json, sys
path, markers = sys.argv[1], sys.argv[2]
def scr(name): return f"node -e \"require('fs').writeFileSync('{markers}/{name}','x')\""
json.dump({"name": "fixture-gitdep", "version": "1.0.0", "scripts": {
    "preinstall": scr("gitdep-preinstall"), "install": scr("gitdep-install"),
    "postinstall": scr("gitdep-postinstall"), "prepare": scr("gitdep-prepare")}}, open(path, "w"))
PY
(cd "$WORK/dep" && git init -q && git add -A && \
  git -c user.email=fixture@example.invalid -c user.name=fixture commit -qm fixture)
SHA="$(cd "$WORK/dep" && git rev-parse HEAD)"
python3 - "$WORK/root/package.json" "$WORK/dep" "$SHA" "$WORK/markers" <<'PY'
import json, sys
path, dep, sha, markers = sys.argv[1:5]
json.dump({"name": "fixture-root", "version": "1.0.0",
  "dependencies": {"fixture-gitdep": f"git+file://{dep}#{sha}"},
  "scripts": {"preinstall": f"node -e \"require('fs').writeFileSync('{markers}/root-preinstall','x')\""}},
  open(path, "w"))
PY
cd "$WORK/root"

markers() { find "$WORK/markers" -type f 2>/dev/null | wc -l | tr -d ' '; }
run() { HOME="$WORK/home" DSH_HOME="$WORK/home" "$NODE" "$PNPM" "$@" > "$WORK/run.log" 2>&1; echo $?; }

echo "deny: pnpm install --ignore-scripts"
DENY_EXIT="$(run install --ignore-scripts)"
DENY_MARKERS="$(markers)"
echo "  exit=$DENY_EXIT markers=$DENY_MARKERS"

rm -rf node_modules pnpm-lock.yaml; find "$WORK/markers" -type f -delete
cat > pnpm-workspace.yaml <<EOF
allowBuilds:
  fixture-gitdep@git+file://$WORK/dep#$SHA: true
EOF
echo "allow(test-only): pnpm install --ignore-scripts=false + precise allowBuilds"
ALLOW_EXIT="$(run install --ignore-scripts=false)"
ALLOW_MARKERS="$(markers)"
echo "  exit=$ALLOW_EXIT markers=$ALLOW_MARKERS: $(cd "$WORK/markers" && ls | tr '\n' ' ')"

fail=0
[ "$DENY_MARKERS" = "0" ] || { echo "FAIL: default deny executed scripts ($DENY_MARKERS markers)"; fail=1; }
[ "$ALLOW_MARKERS" -ge 5 ] || { echo "FAIL: isolated allow did not trigger the sentinel ($ALLOW_MARKERS markers)"; fail=1; }
[ "$fail" -eq 0 ] || { tail -8 "$WORK/run.log" | sed -E 's/token=[A-Za-z0-9_-]+/token=<redacted>/g'; exit 1; }
echo "RESULT: PASS — default deny wrote no markers; isolated allow triggered preinstall/install/postinstall/prepare + root"
echo "NOTE: the allow form is test-isolated; production default deny uses --ignore-scripts (never a global allow)."
