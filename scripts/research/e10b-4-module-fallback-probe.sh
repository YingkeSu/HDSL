#!/usr/bin/env bash
# E10b-4: `$DSH_HOME/profiles/node_modules` fallback behaviour when two
# generations use DIFFERENT DSH installs but share one DSH_HOME (ADR 0006, #76).
#
# The home-level fallback `$DSH_HOME/profiles/node_modules` is a set of symlinks
# into the running DSH install. This probe boots generation A with install copy
# A and generation B with install copy B (both provenance-verified rc.2 copies),
# and checks which install the shared fallback resolves to after each boot.
#
# Safety property under test: after booting a generation, the shared fallback
# resolves into THAT generation's install (healed per boot), so with the
# single-active-generation invariant the resolution is consistent.
#
# Own copies only; no third-party plugin code, no model, no credentials, no
# network. Usage:
#   scripts/research/e10b-4-module-fallback-probe.sh <generation-directory>
set -u -o pipefail

GENERATION="${1:-}"
EXPECTED_DSH_VERSION="0.1.5-rc.2"
EXPECTED_DSH_SHA256="f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480"
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-e10b4-XXXXXX")"
cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "$WORK"; }
trap cleanup EXIT
cp -Rc "$GENERATION/dsh" "$WORK/installA" 2>/dev/null || cp -R "$GENERATION/dsh" "$WORK/installA"
cp -Rc "$GENERATION/dsh" "$WORK/installB" 2>/dev/null || cp -R "$GENERATION/dsh" "$WORK/installB"
NODE="$(command -v node)"
mkdir -p "$WORK/home"
export HOME="$WORK/home" DSH_HOME="$WORK/home" DSH_TELEMETRY_DISABLED=1

init_profile() { "$NODE" "$WORK/$1/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile "$2" --from-default-profile web --dump-config >/dev/null; }

fallback_target() { readlink "$WORK/home/profiles/node_modules/@deepseek-ai/dsh" 2>/dev/null || echo "none"; }
profile_fallback_target() { readlink "$WORK/home/profiles/$1/.dsh-module-fallback/node_modules/@deepseek-ai/dsh" 2>/dev/null || echo "none"; }

boot() { # install profile
  local install="$1" profile="$2" log="$WORK/$2.log" pid i
  "$NODE" "$WORK/$install/node_modules/@deepseek-ai/dsh/lib/bin.js" \
    --profile "$profile" --no-open --host 127.0.0.1 --port 0 >"$log" 2>&1 &
  pid=$!
  for i in $(seq 1 "$READY_TIMEOUT"); do
    sleep 1
    grep -q "dsh web:" "$log" && break
    kill -0 "$pid" 2>/dev/null || break
  done
  kill "$pid" 2>/dev/null || true; sleep 1; kill -9 "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
}

init_profile installA genA
init_profile installB genB

boot installA genA
TARGET_A1="$(fallback_target)"
PA1="$(profile_fallback_target genA)"
echo "after boot genA (installA): home fallback -> ${TARGET_A1/#$WORK/<work>}"
echo "                            genA profile fallback -> ${PA1/#$WORK/<work>}"

boot installB genB
TARGET_B="$(fallback_target)"
PB1="$(profile_fallback_target genB)"
echo "after boot genB (installB): home fallback -> ${TARGET_B/#$WORK/<work>}"
echo "                            genB profile fallback -> ${PB1/#$WORK/<work>}"

boot installA genA
TARGET_A2="$(fallback_target)"
echo "after re-boot genA (installA): home fallback -> ${TARGET_A2/#$WORK/<work>}"

fail=0
case "$TARGET_A1" in *"/installA/"*) ;; *) echo "FAIL: after boot genA the shared fallback does not resolve into installA ($TARGET_A1)"; fail=1;; esac
case "$TARGET_B" in *"/installB/"*) ;; *) echo "FAIL: after boot genB the shared fallback does not resolve into installB ($TARGET_B)"; fail=1;; esac
case "$TARGET_A2" in *"/installA/"*) ;; *) echo "FAIL: shared fallback not healed back to installA on re-boot ($TARGET_A2)"; fail=1;; esac
[ "$fail" -eq 0 ] || { echo "RESULT: FAIL"; exit 1; }

echo "RESULT: PASS — the shared \$DSH_HOME/profiles/node_modules fallback is healed per boot"
echo "        to the currently booting generation's DSH install."
echo "NOTE: the fallback FLAPS between installs across boots; correctness depends on the"
echo "      single-active-generation invariant (HDSL already forbids concurrent start/change)."
echo "      Concurrent boots of two generations would race this shared path and are out of scope."
echo "NOTE: identity boundary (M2): the fallback symlinks are derived runtime state, not composition"
echo "      identity; composition digests must never be rebuilt from the live home."
