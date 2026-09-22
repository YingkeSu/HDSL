#!/usr/bin/env bash
# Fixed-rc.2 profile-selection mechanism probe for ADR 0005 E10 / ADR 0006 (#76).
#
# Answers, on a fixed DSH 0.1.5-rc.2 install, offline and without running any
# third-party plugin bundle or calling a model:
#
#   P1. `--profile <name>` selects the profile directory `$DSH_HOME/profiles/<name>`.
#   P2. The composed bundle set comes from that profile's `package.json`
#       `dsh.profile.bundles`; changing it changes the dump.
#   P3. Two profile names under ONE shared DSH_HOME are independently selectable.
#
# It prints the observed bundle-layer headers. It does NOT prove that
# `--dump-config` equals the runtime-loaded set (that is E9, still open).
#
# The caller supplies an already-provisioned managed generation directory. The
# script copies it (clonefile where available) into a temp dir and only writes
# there; the supplied source is never modified. Requires network-free operation.
#
# Usage:
#   scripts/research/dsh-profile-mechanism-probe.sh <generation-directory>
#
# Expected generation dir layout: <dir>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
set -u -o pipefail

GENERATION="${1:-}"
EXPECTED_DSH_VERSION="0.1.5-rc.2"
EXPECTED_DSH_SHA256="f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480"

if [ -z "$GENERATION" ] || [ ! -d "$GENERATION" ]; then
  echo "usage: $0 <generation-directory>" >&2
  exit 2
fi

# --- identity / integrity gate ------------------------------------------------
MANIFEST="$GENERATION/install-manifest.json"
if [ ! -f "$MANIFEST" ]; then
  echo "REFUSE: $MANIFEST not found; cannot verify install identity" >&2
  exit 2
fi
python3 - "$MANIFEST" "$EXPECTED_DSH_VERSION" "$EXPECTED_DSH_SHA256" <<'PY'
import json, sys
manifest, expected_version, expected_sha = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(manifest))
dsh = data.get("dsh", {})
if dsh.get("version") != expected_version or dsh.get("sha256") != expected_sha:
    print(f"REFUSE: dsh identity mismatch {dsh.get('version')} {dsh.get('sha256')}", file=sys.stderr)
    raise SystemExit(2)
if data.get("installMode") != "npm-ci":
    print("REFUSE: not a real npm-ci managed install", file=sys.stderr)
    raise SystemExit(2)
print(f"identity OK: dsh {dsh['version']} sha256 {dsh['sha256'][:16]}… installMode=npm-ci")
PY
[ $? -eq 0 ] || exit 2

DSH_REL="dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ ! -f "$GENERATION/$DSH_REL" ]; then
  echo "REFUSE: $GENERATION/$DSH_REL not found" >&2
  exit 2
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "REFUSE: node not found on PATH" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-rc2-profile-XXXXXX")"
cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "$WORK"; }
trap cleanup EXIT

cp -Rc "$GENERATION/dsh" "$WORK/dsh" 2>/dev/null || cp -R "$GENERATION/dsh" "$WORK/dsh"
mkdir -p "$WORK/home"
DSH="$WORK/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"

run() { HOME="$WORK/home" DSH_HOME="$WORK/home" "$NODE_BIN" "$DSH" "$@"; }

echo "P1/P2: initialise profile web from the shipped template and dump it"
run --profile web --dump-config > "$WORK/web.txt"
grep -c '^# ==' "$WORK/web.txt" | sed 's/^/  web bundle-layer headers: /'

echo "P3: initialise a second profile genA from web in the SAME home"
run --profile genA --from-default-profile web --dump-config > "$WORK/genA-default.txt"
[ -f "$WORK/home/profiles/genA/package.json" ] \
  && echo "  genA created at \$DSH_HOME/profiles/genA" \
  || { echo "  FAIL: genA profile not created"; exit 1; }

echo "P2: rewrite genA bundles to base-only and re-dump"
python3 - "$WORK/home/profiles/genA/package.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data["dsh"]["profile"]["bundles"] = ["@deepseek-ai/dsh-base"]
json.dump(data, open(path, "w"), indent=2)
PY
run --profile genA --dump-config > "$WORK/genA-baseonly.txt"
run --profile web --dump-config > "$WORK/web-after.txt"

WEB_HEADERS=$(grep -c '^# ==' "$WORK/web.txt")
WEB_AFTER_HEADERS=$(grep -c '^# ==' "$WORK/web-after.txt")
GENA_HEADERS=$(grep -c '^# ==' "$WORK/genA-default.txt")
BASEONLY_HEADERS=$(grep -c '^# ==' "$WORK/genA-baseonly.txt")
echo "  web heads=$WEB_HEADERS genA-default=$GENA_HEADERS genA-baseonly=$BASEONLY_HEADERS web-after=$WEB_AFTER_HEADERS"

fail=0
[ "$WEB_HEADERS" -eq "$GENA_HEADERS" ] || { echo "FAIL: same bundles under two profile names should match"; fail=1; }
[ "$BASEONLY_HEADERS" -lt "$GENA_HEADERS" ] || { echo "FAIL: base-only bundles should shrink the dump"; fail=1; }
# Over-write check: changing genA must not change the web profile's composed tree.
if ! diff -q <(grep '^# ==' "$WORK/web.txt") <(grep '^# ==' "$WORK/web-after.txt") >/dev/null; then
  echo "FAIL: changing genA bundles changed the web profile dump"; fail=1
fi
if [ "$fail" -ne 0 ]; then exit 1; fi
echo "PASS: profile name selects the directory under \$DSH_HOME/profiles; bundle set comes from that profile's package.json;"
echo "      two profile directories coexist under one DSH_HOME and are each selected without affecting the other"
echo "NOTE: --dump-config output is config resolution, not proof of the runtime-loaded set (see"
echo "      dsh-profile-runtime-marker-probe.sh for real-boot marker evidence; E9 still open)."
