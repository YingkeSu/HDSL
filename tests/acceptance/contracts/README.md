# Contract boundary acceptance (`tests/acceptance/contracts`)

Black-box acceptance harness for the **public** `@hdsl/contracts` API on PR #21
(`0cfbdbd72d9b01939e20a39c41ade6f927ebff20`, main `5a9d295`). It drives the
dispatcher through `createContractRuntime` with a controlled `ContractPort` and
asserts externally observable behavior only.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm vitest run tests/acceptance/contracts
```

`contract-boundary.acceptance.test.ts` has two sections:

- `frozen contract behavior` — cases the contract text pins down and that pass;
  regression guards.
- `contract expectations not met` — cases that assert the behavior the contract
  requires. They **fail on the baseline SHA on purpose**: the suite must never
  be green *because* a defect exists. Each case links its issue and must pass
  unchanged once the fix lands; the expectation must not be weakened.

Deviations are tracked as issues #22–#27; see
`docs/development/contract-behavior-validation.md` for the full evidence,
environment, and limitations (no desktop E2E; `ReferenceContractPort` is a
TEST/FIXTURE port, not persistence).
