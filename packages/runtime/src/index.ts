/**
 * `@hdsl/runtime` — managed runtime artifact installation, composition locks,
 * real DSH process lifecycle and upstream adaptation
 * (see docs/architecture/tdd.md and docs/research/dsh-compatibility.md).
 *
 * T002 scope: only the compiled workspace entry exists. Install, process,
 * reconciliation and credential wiring are owned by T004/T005
 * (`packages/runtime/src/{catalog,install,composition,process,reconcile,credentials}/**`).
 *
 * This package must not depend on Electron: it runs the managed Node/DSH
 * runtime, which is independent from the application runtime (ADR 0001).
 */
export {};
