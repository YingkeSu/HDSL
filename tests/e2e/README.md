# Desktop main-flow E2E QA (`tests/e2e`)

Owner: **hdsl-25** (issue [#64](https://github.com/YingkeSu/HDSL/issues/64), T007c; parent [#7](https://github.com/YingkeSu/HDSL/issues/7)).
Baseline main: `cd8ca74bece8844f00f9988ec5494575f750e577`.
Owned paths: this directory and
[`docs/development/desktop-validation.md`](../../docs/development/desktop-validation.md).
QA only — no production changes, no `apps/desktop/**` edits, no PR review.

## Status

| Item | State |
| --- | --- |
| T006 desktop shell (#6) | **Absent** — `apps/desktop/src/main/index.ts` is still the T002/T006 placeholder (`bootstrapDesktop()` throws, no window, no IPC, no `contextBridge`); `ao/hdsl-24/root` has no commits ahead of `main` |
| Boundary freeze with #6 | **Requested** — Electron boot / isolated dataRoot / trusted window / progress observation / credential-import ownership sent to hdsl-24; no reply captured yet |
| Fixture harness | **Done** — 17 self-checks green |
| Scenario suite | **Not registered** — 24 planned cases, all `blocked` |

The harness proves the QA fixtures are real, deterministic and safe. It does
**not** validate the desktop app, Electron windows, preload IPC, credentials or
WebUI. The scenario catalogue lives in
[`scenarios/desktop-e2e-scenario-plan.ts`](scenarios/desktop-e2e-scenario-plan.ts);
the full plan, interface expectations and blockers are in
[`docs/development/desktop-validation.md`](../../docs/development/desktop-validation.md).

## Layout

```text
tests/e2e/
  harness.test.ts                        # fixture self-checks (real vitest, green)
  scenarios/
    desktop-e2e-scenario-plan.ts         # 24 planned QA cases (blocked until #6 lands)
  support/
    resources.ts                         # registered temp roots/resources; explicit cleanup failures; residue gate
    tree.ts                              # snapshot/diff used as the host-HOME guard
    canary.ts                            # canary planting/scanning + diagnostics exclusion and reference-config oracles
    gates.ts                             # deterministic file gate, bounded waitFor, ordering ledger
    desktop-candidate.ts                 # readiness detector (window / IPC / preload / placeholder)
    isolated-data-root.ts                # temp dataRoot + two isolated homes + host guard paths
```

## Run

```sh
export PATH=/Users/suyingke/tools/node-24.21.0/bin:$PATH
pnpm install --frozen-lockfile
pnpm exec vitest run tests/e2e/harness.test.ts
```

Never substitute a mock port or an SSR render for the missing real Electron
window, never `it.skip` the gap to look green, and never cite these fixture
checks as desktop acceptance. The real-window suite is opt-in once #6 lands and
will use a temporary dataRoot plus fixture canaries: no model call, no personal
keychain, no user `~/.dsh` / DSH instance.
