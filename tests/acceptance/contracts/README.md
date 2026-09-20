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
- `contract boundary deviations (expected fail)` — `it.fails` cases that
  reproduce contract/implementation mismatches. They are green while the
  deviation exists and turn red once fixed, so a fix must promote the case to
  the frozen section.

Deviations are tracked as issues #22–#27; see
`docs/development/contract-behavior-validation.md` for the full evidence,
environment, and limitations (no desktop E2E; `ReferenceContractPort` is a
TEST/FIXTURE port, not persistence).
