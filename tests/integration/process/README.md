# Process lifecycle integration QA (`tests/integration/process`)

Owner: **hdsl-23** (issue [#45](https://github.com/YingkeSu/HDSL/issues/45), T007b).
Baseline main: `7fbdc1e2607f4f695e6389296f56b3ba2600fa43`.
Owned paths: this directory and
[`docs/development/process-validation.md`](../../../docs/development/process-validation.md).
QA only — no production changes, no PR review.

## Status

| Item | State |
| --- | --- |
| T005 public interface (#5) | **Absent** — no `packages/runtime/src/{process,reconcile,credentials}`, no PR |
| dataRoot lock interface (#43 / 会话 hdsl-20 / hdsl-21) | **Not frozen** — non-CAS three-party risk awaiting hdsl-21 revision + #5 design review |
| Credential resolver (#44) | **Candidate open** — mechanism layer PR #46 (session hdsl-22, OPEN, head `e67e114`, 2026-09-20), not merged; end-to-end still needs #5 |
| Fixture harness | **Done** — 13 self-checks green |
| Scenario suite | **Not registered** — 23 planned cases, all `blocked` |

The fixture harness proves the QA fixtures are real, deterministic and safe. It
does **not** validate process start/stop, ownership, locks or credentials. The
scenario catalogue lives in `scenarios/process-scenario-plan.ts`; the full plan,
interface expectations and blockers are in `docs/development/process-validation.md`.

## Layout

```text
tests/integration/process/
  harness.test.ts                  # fixture self-checks (real vitest, green)
  scenarios/
    process-scenario-plan.ts       # 23 planned QA cases (blocked until the candidate lands)
  support/
    fixture-process.mjs            # controlled parent/grandchild: hold/stubborn/crash/never-ready/bind
    spawn-fixture.ts               # FixtureProcess: ready gate, guarded kill, grandchild reaping
    identity.ts                    # PID identity: token + `ps lstart`; refuses unsafe kills
    loopback.ts                    # real loopback port allocation/occupation/probe/conflict
    data-root.ts                   # dual-instance shared dataRoot + dedicated canary + file gate
    lock-fixture.ts                # stale/foreign/pid-reuse/corrupt lock inputs + contention gate
    isolation.ts                   # temp roots, HOME/DSH_HOME isolation, host-HOME snapshot, bounded wait
```

## Run

```sh
# Fixture self-checks (no launcher involved; no network, no model call)
pnpm exec vitest run tests/integration/process/harness.test.ts
```

Never substitute a mock port for the missing real interface, never `it.skip`
the gap to look green, and never cite these fixture checks as process evidence.
Real DSH scenarios will be opt-in (`HDSL_QA_REAL_DSH=1`), use a managed install
plus a dedicated canary credential, and never call a model.
