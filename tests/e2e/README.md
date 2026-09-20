# Desktop main-flow E2E QA (`tests/e2e`)

Owner: **hdsl-25** (issue [#64](https://github.com/YingkeSu/HDSL/issues/64), T007c; parent [#7](https://github.com/YingkeSu/HDSL/issues/7)).
Candidate: PR [#68](https://github.com/YingkeSu/HDSL/pull/68) head `2cdea54a9c65252b8d2809737723018ca5b2f801`
(previous frozen head `9b52364d8a999617e1537e6ce97c419fb1ebd04e`).
Owned paths: this directory and
[`docs/development/desktop-validation.md`](../../docs/development/desktop-validation.md).
QA only — no production changes, no `apps/desktop/**` edits, no root config or lockfile changes, no PR review.

## Status

| Item | State |
| --- | --- |
| Real Electron window / IPC / guards / locks / keyboard create | **Executed and passing on `2cdea54`** |
| GUI start/stop (production React, injected credential setup) | **Executed and passing on `2cdea54`** |
| Authorization exactness + production hook removal | **Verified on `2cdea54`**; the old prefix-authorization red is recorded for `9b52364` |
| Test-injection lane (`qa-entry`) diagnostics/credential | **Executed and passing** (injection lane, not the native menu/dialog) |
| Fixture harness | **17/17 green**, always on |
| Isolated real-browser authenticated page (injected opener) | **Executed and passing on `2cdea54`** — real Chrome + temp profile + CDP |
| Native menu+dialogs / real `shell.openExternal` / Windows x64 | **Blocked / manual** — see the validation doc |

Machine counts: all opt-ins `7 passed / 35 tests`; default (gated) `3 passed | 4 skipped; 19 passed | 16 skipped`.

`HDSL_E2E_DESKTOP=1` is the opt-in gate: the real matrix launches Electron, performs a
real managed install and uses the network, so it is not part of the default `pnpm run test`
run. The default CI runs the engineering checks plus the always-on fixture harness (17)
and the always-on Electron-binary probe (18 passed total); the 15 opt-in cases are skipped
there. The fixture harness is always on. Full results, lanes and blockers:
[`docs/development/desktop-validation.md`](../../docs/development/desktop-validation.md).

## Layout

```text
tests/e2e/
  harness.test.ts                        # fixture self-checks (always on, 17 green)
  desktop.real.test.ts                   # real window/IPC/guards/locks/keyboard create (opt-in)
  desktop.findings.real.test.ts          # auth exactness + production-hook removal (opt-in)
  desktop.injected.real.test.ts          # qa-entry test-injection lane (opt-in)
  desktop.browser.real.test.ts           # isolated real-browser authenticated page (opt-in)
  desktop.gui.real.test.ts               # production GUI start/stop (opt-in, injected credential setup)
  desktop.iframe.real.test.ts            # real-window iframe boundary + always-on layer-classifier negative control (opt-in real case; no CSP dynamic claim)
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
    resources.ts / tree.ts / canary.ts / gates.ts / isolated-data-root.ts
```

## Run

```sh
export PATH=/Users/suyingke/tools/node-24.21.0/bin:$PATH
pnpm install --frozen-lockfile
pnpm run build:desktop
pnpm exec vitest run tests/e2e/harness.test.ts          # always on
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.real.test.ts
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.findings.real.test.ts
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.injected.real.test.ts
HDSL_E2E_BROWSER=1 pnpm exec vitest run tests/e2e/desktop.browser.real.test.ts
HDSL_E2E_GUI=1 pnpm exec vitest run tests/e2e/desktop.gui.real.test.ts
HDSL_E2E_IFRAME=1 pnpm exec vitest run tests/e2e/desktop.iframe.real.test.ts
```

Never substitute a mock port or an SSR render for the real Electron window, never
`it.skip` a real scenario to look green, and never cite the fixture checks or a
composition-level script as desktop acceptance. Real runs use a registered
`hdsl-e2e-*` temp dataRoot/user-data pair: no model call, no personal keychain,
no user `~/.dsh` / DSH instance, no user browser profile.
