# Desktop main-flow E2E QA (`tests/e2e`)

Owner: **hdsl-25** (issue [#64](https://github.com/YingkeSu/HDSL/issues/64), T007c; parent [#7](https://github.com/YingkeSu/HDSL/issues/7)).
Candidate: PR [#68](https://github.com/YingkeSu/HDSL/pull/68) head `33bfd1e32d0f121a640ba713a4fa165f906c8ffe`
(previous frozen head `9b52364d8a999617e1537e6ce97c419fb1ebd04e`).
Owned paths: this directory and
[`docs/development/desktop-validation.md`](../../docs/development/desktop-validation.md).
QA only — no production changes, no `apps/desktop/**` edits, no root config or lockfile changes, no PR review.

## Status

| Item | State |
| --- | --- |
| Real Electron window / IPC / guards / locks / keyboard create | **Executed and passing on `33bfd1e`** — 7 scenarios |
| Authorization exactness + production hook removal | **Verified on `33bfd1e`**; the old prefix-authorization red is recorded for `9b52364` |
| Test-injection lane (`qa-entry`) diagnostics/credential | **Executed and passing** (injection lane, not the native menu/dialog) |
| Fixture harness | **17/17 green**, always on |
| Isolated real-browser authenticated page (injected opener) | **Executed and passing on `33bfd1e`** — real Chrome + temp profile + CDP |
| Native menu+dialogs / real `shell.openExternal` / GUI start-stop | **Blocked / manual** — see the validation doc |

`HDSL_E2E_DESKTOP=1` is the opt-in gate: the real matrix launches Electron, performs a
real managed install and uses the network, so it is not part of the default `pnpm run test`
run. The fixture harness is always on. Full results, lanes and blockers:
[`docs/development/desktop-validation.md`](../../docs/development/desktop-validation.md).

## Layout

```text
tests/e2e/
  harness.test.ts                        # fixture self-checks (always on, 17 green)
  desktop.real.test.ts                   # real window/IPC/guards/locks/keyboard create (opt-in)
  desktop.findings.real.test.ts          # auth exactness + production-hook removal (opt-in)
  desktop.injected.real.test.ts          # qa-entry test-injection lane (opt-in)
  desktop.browser.real.test.ts           # isolated real-browser authenticated page (opt-in)
  scenarios/
    desktop-e2e-scenario-plan.ts         # 24 planned QA cases with lanes and observations
  support/
    app-harness.ts                       # launch + cleanup harness
    cdp.ts                               # built-in CDP client (WebSocket)
    electron-app.ts                      # real Electron launcher (production/qa entry)
    desktop-ui.ts                        # real DOM/contract helpers
    desktop-candidate.ts                 # readiness detector
    prepared-environment.ts              # one real install, cloned for injection tests
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
```

Never substitute a mock port or an SSR render for the real Electron window, never
`it.skip` a real scenario to look green, and never cite the fixture checks or a
composition-level script as desktop acceptance. Real runs use a registered
`hdsl-e2e-*` temp dataRoot/user-data pair: no model call, no personal keychain,
no user `~/.dsh` / DSH instance, no user browser profile.
