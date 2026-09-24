# Desktop main-flow E2E QA (`tests/e2e`)

Owner: **hdsl-25** (issue [#64](https://github.com/YingkeSu/HDSL/issues/64), T007c; parent [#7](https://github.com/YingkeSu/HDSL/issues/7)).
Candidate: PR [#68](https://github.com/YingkeSu/HDSL/pull/68) head `2cdea54a9c65252b8d2809737723018ca5b2f801`
(previous frozen head `9b52364d8a999617e1537e6ce97c419fb1ebd04e`).
Owned paths: this directory and
[`docs/development/desktop-validation.md`](../../docs/development/desktop-validation.md).
QA only — no production changes, no `apps/desktop/**` edits, no root config or lockfile changes, no PR review.

> **Update (T007 residual QA, issue [#7](https://github.com/YingkeSu/HDSL/issues/7), execution head `fb5da940be2f1f5a043ff255a950255beb78517b`)**:
> PR [#120](https://github.com/YingkeSu/HDSL/pull/120) / ADR 0008 fixed [#108](https://github.com/YingkeSu/HDSL/issues/108)
> (main pushes `environment.updated` on a real process exit), so `E2E-FAULT-EXIT-01` now
> **asserts** the real renderer converges to `已停止` (it previously only recorded the
> stale label). A new `E2E-APP-CRASH-RESTART-01` SIGKILLs the launcher and proves the
> relaunched production app takes over the stale dataRoot lease, adopts the surviving
> detached DSH (same pid) through the real UI, and stops it. The candidate/matrix rows
> below that cite `2cdea54` / `3f51e06` stay pinned to those heads as history; the new
> evidence is bound to `fb5da94` only.

> **Update (T007 real-UI main flow, issue [#7](https://github.com/YingkeSu/HDSL/issues/7), execution head `6324d529089168b13fdf2eb60617ba4dd3dfa012`)**:
> `E2E-MAIN-FLOW-01` (`desktop.main-flow.real.test.ts`, gate `HDSL_E2E_MAIN_FLOW=1`) drives the
> first-slice journey as a **single** real-UI lane: keyboard create -> real managed install ->
> setup-injected credential reference -> real click start (`运行中`) -> real click stop (`已停止`),
> with the frozen contract state as the independent check. It closes the coverage-matrix
> "用户主流程" row that the piecewise `E2E-CREATE-01` / `E2E-GUI-START-STOP-01` lanes left open.
> Evidence `HDSL_T007_MAIN_FLOW_EVIDENCE`; result bound to `6324d52` only.

## Status

| Item | State |
| --- | --- |
| Real Electron window / IPC / guards / locks / keyboard create | **Executed and passing on `2cdea54`** |
| GUI start/stop (production React, injected credential setup) | **Executed and passing on `2cdea54`** |
| Authorization exactness + production hook removal | **Verified on `2cdea54`**; the old prefix-authorization red is recorded for `9b52364` |
| Test-injection lane (`qa-entry`) diagnostics/credential | **Executed and passing** (injection lane, not the native menu/dialog) |
| Fixture harness | **17/17 green**, always on |
| Isolated real-browser authenticated page (injected opener) | **Executed and passing on `2cdea54`** — real Chrome + temp profile + CDP |
| Real managed-process unexpected exit -> contract `stopped` | **Executed and passing** (`E2E-FAULT-EXIT-01`) |
| Renderer auto-refresh after an unexpected managed-process exit | **Executed and passing on `fb5da94`** — real UI converges to `已停止` (`E2E-FAULT-EXIT-01`; #108 fixed by PR #120 / ADR 0008) |
| Launcher crash / restart reconciliation | **Executed and passing on `fb5da94`** — `E2E-APP-CRASH-RESTART-01`: SIGKILL launcher, detached DSH adopted by the relaunched instance (same pid), stopped through the real UI |
| Real-UI main flow (create -> start -> stop, one journey) | **Executed and passing on `6324d52`** — `E2E-MAIN-FLOW-01`: UI create + real install, setup-injected credential reference, real start -> `运行中` -> real stop -> `已停止` |
| Native menu+dialogs / real `shell.openExternal` / Windows x64 | **Blocked / manual** — see the validation doc and issue #100 |

Machine counts (original matrix head `3f51e06`): default (gated) `20 passed | 21 skipped (41)`; the opt-in cases run
only under their gates (see Run). On the residual QA head `fb5da94` the default `tests/e2e`
count is `20 passed | 22 skipped (42)` and the real faults lane is `2 passed / 1 file (119.27s)`
(`HDSL_T007_FAULT_EXIT_EVIDENCE`, `HDSL_T007_RESTART_EVIDENCE`). On the main-flow head `6324d52` the
`tests/e2e` default count is `20 passed | 23 skipped (43)` (one added opt-in case) and the main-flow lane is
`1 passed / 1 file (50.7s)` (`HDSL_T007_MAIN_FLOW_EVIDENCE`).

`HDSL_E2E_DESKTOP=1` is the opt-in gate: the real matrix launches Electron, performs a
real managed install and uses the network, so it is not part of the default `pnpm run test`
run. The default CI runs the engineering checks plus the always-on fixture harness (17)
plus the always-on Electron-binary probe, the iframe layer-classifier negative control and
the sender-frame fixture check (20 passed total); the remaining opt-in cases (22 skipped at `fb5da94`) are skipped there. The fixture harness is always on. Full results, lanes and blockers:
[`docs/development/desktop-validation.md`](../../docs/development/desktop-validation.md).


## Real-model and native acceptance (one-off, user-assisted)

- **Real model E2E** (user-authorized temporary credential, now revoked): production core
  loader -> strict credential port -> real managed DSH -> real model answer, driven through
  the real DSH UI; two turns, assistant role bound and distinguished from the user echo;
  diagnostics/launch records/home logs contained no exact credential value. The endpoint was
  **not observed** (no capture) and the UI model label is not endpoint proof. This is a
  one-off evidence run; its scripts are intentionally not committed because they depend on a
  machine-local keychain reference and a one-time credential.
- **Workspace precondition**: DSH needs an existing workspace before the composer becomes
  editable. On macOS+loopback the picker backend resolves to `native`; a QA **setup** (not a
  product feature) can pre-register a workspace in an own managed home using the
  source-derived `dsh-workspace` schema. Two independent profiles then reached an editable,
  submittable composer (typed, not sent).
- **Native import/export**: the real menu/NSSave/NSOpenPanel steps were performed **by the
  user**; QA only verified the on-disk results (reference-only `credentials.json` 0600; export
  is the allowlisted bundle with no excluded files, managed paths, canary or credential shapes).
- **Still untested**: real `shell.openExternal` (personal default browser/profile), fully
  automated native panels (current-host permission/control limits; the `osascript` keystroke
  refusal is `error 1002` and its specific TCC category was **not independently confirmed**),
  Windows x64. `XCUITest` (needs Xcode) and an isolated macOS VM/account with pre-granted
  permission are *suggestions to verify*, not conclusions.

## Layout

```text
tests/e2e/
  harness.test.ts                        # fixture self-checks (always on, 17 green)
  desktop.real.test.ts                   # real window/IPC/guards/locks/keyboard create (opt-in)
  desktop.findings.real.test.ts          # auth exactness + production-hook removal (opt-in)
  desktop.injected.real.test.ts          # qa-entry test-injection lane (opt-in)
  desktop.browser.real.test.ts           # isolated real-browser authenticated page (opt-in)
  desktop.gui.real.test.ts               # production GUI start/stop (opt-in, injected credential setup)
  desktop.main-flow.real.test.ts         # real-UI main flow: UI create -> start -> stop on one journey (opt-in)
  desktop.faults.real.test.ts            # real managed-process exit -> contract+renderer stopped (#108); launcher crash/restart adoption -> UI stop (opt-in)
  desktop.iframe.real.test.ts            # real-window iframe boundary + always-on layer-classifier negative control (opt-in real case; no CSP dynamic claim)
  desktop.sender-frame.real.test.ts      # test-only host: real subframe IPC rejected by the production sender guard (opt-in)
  scenarios/
    desktop-e2e-scenario-plan.ts         # 24 planned QA cases with lanes and observations
  support/
    app-harness.ts                       # launch + cleanup harness
    cdp.ts                               # built-in CDP client (WebSocket)
    electron-app.ts                      # real Electron launcher (production/qa entry)
    desktop-ui.ts                        # real DOM/contract helpers
    desktop-candidate.ts                 # readiness detector
    prepared-environment.ts              # one real install, cloned for injection tests
    chrome.ts                            # installed-Chrome launcher for the browser lane
    sender-frame-host.mjs                # TEST-ONLY Electron host for the sender-frame lane
    fixtures/                            # test-host parent/child pages for that lane
    resources.ts / tree.ts / canary.ts / gates.ts / isolated-data-root.ts
```

## Run

```sh
# Use Node.js from .nvmrc and pnpm from packageManager.
pnpm install --frozen-lockfile
pnpm run build:desktop
pnpm exec vitest run tests/e2e/harness.test.ts          # always on
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.real.test.ts
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.findings.real.test.ts
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.injected.real.test.ts
HDSL_E2E_BROWSER=1 pnpm exec vitest run tests/e2e/desktop.browser.real.test.ts
HDSL_E2E_GUI=1 pnpm exec vitest run tests/e2e/desktop.gui.real.test.ts
HDSL_E2E_MAIN_FLOW=1 pnpm exec vitest run tests/e2e/desktop.main-flow.real.test.ts
HDSL_E2E_FAULTS=1 pnpm exec vitest run tests/e2e/desktop.faults.real.test.ts
HDSL_E2E_IFRAME=1 pnpm exec vitest run tests/e2e/desktop.iframe.real.test.ts
HDSL_E2E_SENDERFRAME=1 pnpm exec vitest run tests/e2e/desktop.sender-frame.real.test.ts
```

Never substitute a mock port or an SSR render for the real Electron window, never
`it.skip` a real scenario to look green, and never cite the fixture checks or a
composition-level script as desktop acceptance. Real runs use a registered
`hdsl-e2e-*` temp dataRoot/user-data pair: no model call, no personal keychain,
no user `~/.dsh` / DSH instance, no user browser profile.
