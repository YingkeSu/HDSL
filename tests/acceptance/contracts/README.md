# Contract boundary acceptance (`tests/acceptance/contracts`)

Black-box acceptance harness for the **public** `@hdsl/contracts` API on PR #21.
Current baseline: final candidate head
`12416b1cd14e39606cee62c2e39706f1c3171782` (previously `b1904ce`, frozen
`0cfbdbd72d9b01939e20a39c41ade6f927ebff20`, main `5a9d295`). It drives the
dispatcher through `createContractRuntime` with a controlled `ContractPort` and
asserts externally observable behavior only. Test doubles are imported from the
`@hdsl/contracts/testing` subpath.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm vitest run tests/acceptance/contracts
```

`contract-boundary.acceptance.test.ts` has three sections:

- `frozen contract behavior` — behavior the contract pins down and that already
  held on the frozen SHA; regression guards.
- `contract expectations` — 11 cases asserting required behavior. The original
  10 were intentionally red on `0cfbdbd` (issues #22–#27 and review F3); the
  `[#22/cancel guard]` case was red on `b1904ce`. All pass on `12416b1` with the
  **same** expectations. The suite must never be green *because* a defect
  exists; do not weaken, skip or `it.fails` these.
- `redaction increment` — the security re-review forms added by `12416b1`:
  `operations.get`/`operations.cancel` `phase`, nested `error.message`, and
  `.credentials.yaml` / JSON / `dsh-auth` secret assignments must not be echoed;
  `operation.updated` events must carry the sanitized `phase`.

Background and limitations for the guarded cases live with their issues
(#22 #23 #24 #25 #26 #27) and in `contract-boundary.acceptance.test.ts` itself.
Scope reminder: no desktop E2E; `@hdsl/contracts/testing` is a TEST/FIXTURE
port, not persistence.
