# Contract boundary acceptance (`tests/acceptance/contracts`)

Black-box acceptance harness for the **public** `@hdsl/contracts` API on PR #21.
Current baseline: fixed head `b1904cec62ab022793d572c16f6fe10d639f7d08`
(previously frozen `0cfbdbd72d9b01939e20a39c41ade6f927ebff20`, main `5a9d295`).
It drives the dispatcher through `createContractRuntime` with a controlled
`ContractPort` and asserts externally observable behavior only. Test doubles are
imported from the `@hdsl/contracts/testing` subpath.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm vitest run tests/acceptance/contracts
```

`contract-boundary.acceptance.test.ts` has two sections:

- `frozen contract behavior` — behavior the contract pins down and that already
  held on the frozen SHA; regression guards.
- `contract expectations` — 10 cases that assert the behavior the contract
  requires. They were intentionally red on `0cfbdbd` (reproducing issues
  #22–#27 and review F3) and pass on `b1904ce` with the **same** expectations.
  The suite must never be green *because* a defect exists; do not weaken, skip
  or `it.fails` these.

See `docs/development/contract-behavior-validation.md` for the original
evidence, environment, and limitations (no desktop E2E;
`@hdsl/contracts/testing` is a TEST/FIXTURE port, not persistence).
