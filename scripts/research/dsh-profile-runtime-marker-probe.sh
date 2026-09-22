#!/usr/bin/env bash
# E10b runtime marker probe: does the SELECTED --profile actually determine the
# runtime-loaded bundle set, across two generations sharing one DSH_HOME?
#
# For ADR 0006 §2.3 / E10b (#76). Uses a fixed-integrity DSH 0.1.5-rc.2 managed
# install (own copy), one shared DSH_HOME, two profiles with different in-box
# bundle sets, and the web-app runtime readiness line as the marker:
#
#   "dsh web: http://127.0.0.1:<port>/?token=…"  (printed only after the Loader
#   tree settled, i.e. only when @deepseek-ai/dsh-web-app is actually loaded)
#
# It runs no third-party plugin code, no model and uses no personal credentials.
# Tokens are masked in captured output. The supplied generation directory is
# never modified (only copied with clonefile when available).
#
# What it proves: runtime binding of the selected profile's declared bundle set,
# profile independence under one home, and switch-back. What it does NOT prove:
# `--dump-config` equivalence (E9) is irrelevant here (this is real boot), but
# publish/switch atomicity + crash recovery are covered separately by
# `e10b-publish-crash-prototype.mjs`, and HDSL production wiring is still open.
#
# Usage:
#   scripts/research/dsh-profile-runtime-marker-probe.sh <generation-directory>
set -u -o pipefail

GENERATION="${1:-}"
EXPECTED_DSH_VERSION="0.1.5-rc.2"
EXPECTED_DSH_SHA256="f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480"
READY_TIMEOUT=25

if [ -z "$GENERATION" ] || [ ! -d "$GENERATION" ]; then
  echo "usage: $0 <generation-directory>" >&2
  exit 2
fi
if [ ! -f "$GENERATION/install-manifest.json" ] || [ ! -f "$GENERATION/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  echo "REFUSE: $GENERATION is not a provisioned generation directory" >&2
  exit 2
fi
python3 - "$GENERATION/install-manifest.json" "$EXPECTED_DSH_VERSION" "$EXPECTED_DSH_SHA256" <<'PY' || exit 2
import json, sys
data = json.load(open(sys.argv[1]))
dsh = data.get("dsh", {})
if dsh.get("version") != sys.argv[2] or dsh.get("sha256") != sys.argv[3]:
    print(f"REFUSE: dsh identity mismatch {dsh.get('version')} {dsh.get('sha256')}", file=sys.stderr)
    raise SystemExit(2)
if data.get("installMode") != "npm-ci":
    print("REFUSE: not a real npm-ci managed install", file=sys.stderr)
    raise SystemExit(2)
print(f"identity OK: dsh {dsh['version']} sha256 {dsh['sha256'][:16]}… installMode=npm-ci")
PY

mask() { sed -E 's/token=[A-Za-z0-9_-]+/token=<redacted>/g'; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-e10b-runtime-XXXXXX")"
cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "$WORK"; }
trap cleanup EXIT

cp -Rc "$GENERATION/dsh" "$WORK/dsh" 2>/dev/null || cp -R "$GENERATION/dsh" "$WORK/dsh"
NODE="$(command -v node)"
if [ -x "$GENERATION/node/bin/node" ]; then
  cp -Rc "$GENERATION/node" "$WORK/node" 2>/dev/null || cp -R "$GENERATION/node" "$WORK/node"
  NODE="$WORK/node/bin/node"
fi
mkdir -p "$WORK/home"
DSH="$WORK/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
export HOME="$WORK/home" DSH_HOME="$WORK/home" DSH_TELEMETRY_DISABLED=1

init_profile() { "$NODE" "$DSH" --profile "$1" --from-default-profile web --dump-config >/dev/null; }
set_bundles() { # profile json-list
  python3 - "$WORK/home/profiles/$1/package.json" "$2" <<'PY'
import json, sys
path, raw = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data["dsh"]["profile"]["bundles"] = json.loads(raw)
json.dump(data, open(path, "w"), indent=2)
PY
}
read_bundles() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['dsh']['profile']['bundles'])" "$WORK/home/profiles/$1/package.json"; }

# Bounded boot: prints "ready@<n>s", "exited@<n>s" or "no-ready".
boot() {
  local profile="$1" log="$WORK/$1.log" pid
  "$NODE" "$DSH" --profile "$profile" --no-open --host 127.0.0.1 --port 0 >"$log" 2>&1 &
  pid=$!
  local i result="no-ready"
  for i in $(seq 1 "$READY_TIMEOUT"); do
    sleep 1
    if grep -q "dsh web:" "$log"; then result="ready@${i}s"; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then result="exited@${i}s"; break; fi
  done
  kill "$pid" 2>/dev/null || true
  sleep 1
  kill -9 "$pid" 2>/dev/null || true
  printf '%s' "$result"
}

echo "generation A: base + web-app"
init_profile genA
BUNDLES_A="$(read_bundles genA)"
echo "  genA bundles=$BUNDLES_A"

echo "generation B: base-only"
init_profile genB
set_bundles genB '["@deepseek-ai/dsh-base"]'
BUNDLES_B="$(read_bundles genB)"
echo "  genB bundles=$BUNDLES_B"

A1="$(boot genA)"; echo "boot genA (web-app) -> $A1"
B1="$(boot genB)"; echo "boot genB (base-only) -> $B1"
A2="$(boot genA)"; echo "boot genA again (switch back) -> $A2"

A_AFTER="$(read_bundles genA)"
B_AFTER="$(read_bundles genB)"
PROFILE_FILES="$(ls "$WORK/home/profiles/genA" | tr '\n' ' ')"

fail=0
[ "$A1" != "no-ready" ] && [ "${A1#ready}" != "$A1" ] || { echo "FAIL: genA did not reach runtime readiness"; fail=1; }
case "$B1" in ready*) echo "FAIL: base-only genB reached web readiness (marker not bound to profile)"; fail=1;; esac
[ "${A2#ready}" != "$A2" ] || { echo "FAIL: switch-back to genA did not reach readiness"; fail=1; }
[ "$A_AFTER" = "$BUNDLES_A" ] || { echo "FAIL: genA bundles changed after genB boot"; fail=1; }
[ "$B_AFTER" = "$BUNDLES_B" ] || { echo "FAIL: genB bundles changed after genA boot"; fail=1; }
if [ "$fail" -ne 0 ]; then echo "RESULT: FAIL"; exit 1; fi

echo "RESULT: PASS — the selected --profile determines the runtime-loaded bundle set;"
echo "        two profiles in one DSH_HOME are independent and switchable."
echo "profile files after boot: $PROFILE_FILES"
echo "NOTE: DSH rewrites <profile>/cordis.yml on boot; a profile dir is mutable runtime state,"
echo "      so it belongs in the shared home, not inside an immutable committed generation dir."
echo "NOTE: publish/switch atomicity and crash recovery are NOT covered here (see e10b-publish-crash-prototype.mjs)."
echo "NOTE: HDSL production wiring (start argv --profile <genName>, commit ordering) is not implemented;"
echo "      E10b remains open until this mechanism is wired and the dual-generation seam is proven end to end."
