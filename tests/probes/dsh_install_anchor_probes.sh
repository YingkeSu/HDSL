#!/usr/bin/env bash
#
# Compare how two DSH installations anchor the `$DSH_HOME/profiles/node_modules`
# module fallback. This is the isolation question a launcher must answer: does an
# environment's runtime module resolution follow its own managed installation, or a
# shared/launcher-provided one?
#
# Safety: same as dsh_behavior_probes.sh — temporary HOME/DSH_HOME/CWD, scrubbed
# environment, telemetry disabled, placeholder API key. Only reaped-PID-safe signalling
# of self-owned processes.
#
# Required tools: node, python3.
#
# Usage:
#   DSH_BIN_A=/tmp/dsh-015/node_modules/@deepseek-ai/dsh/lib/bin.js DSH_INSTALL_ROOT_A=/tmp/dsh-015 \
#   DSH_BIN_B=/tmp/dsh-015b/node_modules/@deepseek-ai/dsh/lib/bin.js DSH_INSTALL_ROOT_B=/tmp/dsh-015b \
#     tests/probes/dsh_install_anchor_probes.sh
#
# Exit status: 0 when the version-independent invariants hold, 1 otherwise, 2 on missing prerequisites.

set -u

NODE="${DSH_NODE:-$(command -v node || true)}"
PYTHON="${DSH_PYTHON:-$(command -v python3 || true)}"
BIN_A="${DSH_BIN_A:?set DSH_BIN_A}"
ROOT_A="${DSH_INSTALL_ROOT_A:?set DSH_INSTALL_ROOT_A}"
BIN_B="${DSH_BIN_B:?set DSH_BIN_B}"
ROOT_B="${DSH_INSTALL_ROOT_B:?set DSH_INSTALL_ROOT_B}"

[[ -n "$NODE" && -x "$NODE" ]] || { echo "FATAL: node not found (set DSH_NODE)" >&2; exit 2; }
[[ -n "$PYTHON" ]] || { echo "FATAL: python3 not found (set DSH_PYTHON)" >&2; exit 2; }
for b in "$BIN_A" "$BIN_B"; do [[ -f "$b" ]] || { echo "FATAL: missing CLI bin $b" >&2; exit 2; }; done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hdsl-anchor.XXXXXX")"
FAKE_HOME="$WORK/fakehome"; CWD_DIR="$WORK/cwd"
mkdir -p "$FAKE_HOME" "$CWD_DIR"
PASSED=0; FAILED=0
LIVE_PIDS_FILE="$WORK/live-pids"
: >"$LIVE_PIDS_FILE"

say()  { printf '%s\n' "$*"; }
head1(){ printf '\n===== %s =====\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; PASSED=$((PASSED + 1)); }
bad()  { printf 'FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
note() { printf 'NOTE  %s\n' "$*"; }

register_pid() { printf '%s\n' "$1" >>"$LIVE_PIDS_FILE"; }
forget_pid() {
  grep -vx "$1" "$LIVE_PIDS_FILE" >"$LIVE_PIDS_FILE.tmp" 2>/dev/null || true
  mv "$LIVE_PIDS_FILE.tmp" "$LIVE_PIDS_FILE"
}
wait_pid() { local pid="$1" rc; wait "$pid" 2>/dev/null; rc=$?; forget_pid "$pid"; return $rc; }
cleanup() {
  local pid
  while IFS= read -r pid; do [[ -n "$pid" ]] || continue; kill -KILL "$pid" 2>/dev/null || true; done <"$LIVE_PIDS_FILE"
  rm -rf "$WORK"
}
trap cleanup EXIT

real() { "$PYTHON" -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$1"; }

# Boot web against $1=bin with $2=DSH_HOME, wait for readiness, then stop and reap.
boot_stop() {
  local bin="$1" home="$2" tag="$3"
  local out="$WORK/$tag.out" err="$WORK/$tag.err"
  ( cd "$CWD_DIR" && exec env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$FAKE_HOME" DSH_HOME="$home" \
      DSH_AGENTS_HOME="$WORK/agents" DSH_TELEMETRY_DISABLED=1 \
      DEEPSEEK_API_KEY=keyless-probe-no-call NODE_NO_WARNINGS=1 \
      "$NODE" "$bin" --profile web --host 127.0.0.1 --port 0 --no-open ) >"$out" 2>"$err" &
  local pid=$!; register_pid "$pid"
  local i
  for ((i = 0; i < 600; i++)); do
    grep -q 'dsh web: http' "$out" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || { kill -TERM "$pid" 2>/dev/null; wait_pid "$pid"; head -5 "$err" >&2; return 1; }
    sleep 0.1
  done
  grep -q 'dsh web: http' "$out" 2>/dev/null || { kill -TERM "$pid" 2>/dev/null; wait_pid "$pid"; head -5 "$err" >&2; return 1; }
  kill -TERM "$pid" 2>/dev/null; wait_pid "$pid"
  return 0
}

# Report the fallback's install anchor for $1=home, $2=expected install root.
# Prints: "absent - - -" or "present <real_target> <under_root:yes|no> <pkgversion>".
fallback_anchor() {
  local home="$1" root base target version under
  local mods="$home/profiles/node_modules"
  if [[ ! -d "$mods" ]]; then printf 'absent - - -\n'; return; fi
  root="$(real "$2")"
  base="$mods/@deepseek-ai/dsh-base"
  target="$(readlink "$base" 2>/dev/null || echo '')"
  version="$("$PYTHON" -c "import json;print(json.load(open('$base/package.json'))['version'])" 2>/dev/null || echo '?')"
  if [[ -z "$target" ]]; then printf 'present - unknown %s\n' "$version"; return; fi
  target="$(real "$target")"
  case "$target" in "$root"|"$root"/*) under=yes ;; *) under=no ;; esac
  printf 'present %s %s %s\n' "$target" "$under" "$version"
}

# Report whether every fallback package symlink resolves under $2.
fallback_all_under() {
  "$PYTHON" - "$1" "$2" <<'PY'
import os, sys
mods, root = sys.argv[1], os.path.realpath(sys.argv[2])
links, outside = 0, 0
for dirpath, dirnames, _ in os.walk(mods):
    for name in list(dirnames):
        path = os.path.join(dirpath, name)
        if os.path.islink(path):
            dirnames.remove(name); links += 1
            t = os.path.realpath(path)
            if not (t == root or t.startswith(root + os.sep)): outside += 1
for name in os.listdir(mods):
    path = os.path.join(mods, name)
    if os.path.islink(path):
        links += 1
        t = os.path.realpath(path)
        if not (t == root or t.startswith(root + os.sep)): outside += 1
print(f"{links} {outside}")
PY
}

installed_version() { "$NODE" "$1" --version 2>/dev/null || echo '?'; }

head1 "installations"
VER_A="$(installed_version "$BIN_A")"; VER_B="$(installed_version "$BIN_B")"
ROOT_A="$(real "$ROOT_A")"; ROOT_B="$(real "$ROOT_B")"
say "A: $BIN_A"
say "   version=$VER_A install_root=$ROOT_A"
say "B: $BIN_B"
say "   version=$VER_B install_root=$ROOT_B"

# --- Case 1: independent homes, one installation each -----------------------
head1 "case independent: home A <- install A ; home B <- install B"
HA="$WORK/hA"; HB="$WORK/hB"
boot_stop "$BIN_A" "$HA" a || bad "install A did not boot"
boot_stop "$BIN_B" "$HB" b || bad "install B did not boot"
read -r PA TA UA VA <<<"$(fallback_anchor "$HA" "$ROOT_A")"
read -r PB TB UB VB <<<"$(fallback_anchor "$HB" "$ROOT_B")"
say "home A fallback: present=$PA target=$TA under_root=$UA dsh-base=$VA"
say "home B fallback: present=$PB target=$TB under_root=$UB dsh-base=$VB"
if [[ "$PA" == present ]]; then
  read -r nA outA <<<"$(fallback_all_under "$HA/profiles/node_modules" "$ROOT_A")"
  [[ "$outA" == "0" ]] && ok "home A: all $nA fallback links under install A root" || bad "home A has $outA links outside install A root"
fi
if [[ "$PB" == present ]]; then
  read -r nB outB <<<"$(fallback_all_under "$HB/profiles/node_modules" "$ROOT_B")"
  [[ "$outB" == "0" ]] && ok "home B: all $nB fallback links under install B root" || bad "home B has $outB links outside install B root"
fi
if [[ "$PA" == present && "$PB" == present ]]; then
  if [[ "$UA" == yes && "$UB" == yes && "$ROOT_A" != "$ROOT_B" ]]; then
    ok "each environment anchors its fallback to its own installation directory"
  else
    bad "fallback anchors do not follow their own installations (A=$TA/$UA B=$TB/$UB)"
  fi
  if [[ "$VER_A" != "$VER_B" ]]; then
    [[ "$VA" == "$VER_A" && "$VB" == "$VER_B" ]] && ok "fallback dsh-base versions follow the installations ($VA vs $VB)" || bad "fallback dsh-base versions do not follow installations ($VA/$VB)"
  fi
fi

# --- Case 2: two environments sharing one installation ----------------------
head1 "case shared: two homes <- the same installation A"
HC="$WORK/hC"; HD="$WORK/hD"
boot_stop "$BIN_A" "$HC" c || bad "install A did not boot for home C"
boot_stop "$BIN_A" "$HD" d || bad "install A did not boot for home D"
read -r PC TC UC VC <<<"$(fallback_anchor "$HC" "$ROOT_A")"
read -r PD TD UD VD <<<"$(fallback_anchor "$HD" "$ROOT_A")"
say "home C fallback anchor: $TC (under A=$UC, dsh-base $VC)"
say "home D fallback anchor: $TD (under A=$UD, dsh-base $VD)"
if [[ "$PC" == present && "$PD" == present ]]; then
  if [[ "$UC" == yes && "$UD" == yes ]]; then
    ok "both environments resolve core modules from the one shared installation A"
    note "sharing one installation means core bundle modules are NOT isolated per environment"
  else
    bad "shared-installation homes did not both anchor to installation A ($TC / $TD)"
  fi
elif [[ "$PC" == absent && "$PD" == absent ]]; then
  note "this version writes no fallback links; isolation then depends on runtime resolution, not filesystem anchors"
fi

# --- Case 3: re-pointing an existing home at installation B -----------------
head1 "case reheal: home A re-booted with installation B"
if [[ "$PA" == present ]]; then
  boot_stop "$BIN_B" "$HA" reheal || bad "install B did not boot against home A"
  read -r PR TR UR VR <<<"$(fallback_anchor "$HA" "$ROOT_B")"
  say "home A after install B: present=$PR target=$TR under_B=$UR dsh-base=$VR"
  if [[ "$PB" == absent ]]; then
    # Installation B never writes fallback links, so it has nothing to re-anchor.
    note "installation B writes no fallback links; the prior on-disk anchor is left untouched"
    say "leftover on-disk fallback still points at: $TA (under_B=$UR)"
  elif [[ "$PR" == present ]]; then
    if [[ "$UR" == yes ]]; then
      ok "existing home's fallback re-anchored to the newly used installation B"
    else
      bad "existing home kept a stale fallback anchor ($TR), expected under $ROOT_B"
    fi
  else
    bad "installation B normally writes fallback links, but home A has none after the re-boot"
  fi
fi

# --- Case 4: credential boundary --------------------------------------------
head1 "case credentials: per-home document, no install-root or \$HOME copy"
for pair in "A:$HA" "B:$HB" "C:$HC" "D:$HD"; do
  name="${pair%%:*}"; home="${pair#*:}"
  cred="$home/.credentials.yaml"
  if [[ -f "$cred" ]]; then
    mode="$(stat -f '%Lp' "$cred")"
    [[ "$mode" == "600" ]] && ok "home $name credential document is mode 0600" || bad "home $name credential mode is $mode"
  else
    bad "home $name has no credential document"
  fi
done
if [[ ! -e "$ROOT_A/.credentials.yaml" && ! -e "$ROOT_B/.credentials.yaml" && ! -e "$FAKE_HOME/.credentials.yaml" ]]; then
  ok "no credential document outside the environments' DSH_HOMEs"
else
  bad "credential document escaped the DSH_HOME boundary"
fi

head1 "CWD side-effect check"
CWD_AFTER="$(cd "$CWD_DIR" && ls -A 2>/dev/null | sort | tr '\n' ' ')"
[[ -z "$CWD_AFTER" ]] && ok "probe working directory stayed empty" || bad "probe working directory received files: $CWD_AFTER"

head1 "SUMMARY"
say "A=$VER_A@$ROOT_A  B=$VER_B@$ROOT_B"
say "assertions: ${PASSED}/$((PASSED + FAILED)) passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] && exit 0 || exit 1
