# Install integration QA (`tests/integration/install`)

Owner: **hdsl-18** (issue [#31](https://github.com/YingkeSu/HDSL/issues/31), T007a).
Baseline contract SHA: `3e76a49694f8dcf4c8bba5d32196a6665a2f394e`
(`contracts-v1.0.0`). This directory and
`docs/development/install-validation.md` are the only QA-owned paths; QA does
not modify production code and does not perform PR review.

## Status

| Item | State |
| --- | --- |
| Public calling surface (T004 / #4) | **Confirmed** by hdsl-15 (see below) |
| Fixture harness | **Done** — 9 self-checks green |
| Scenario suite | **Prepared, not executable** — `@hdsl/core`/`@hdsl/runtime` have no implementation yet |
| Real install execution | **Blocked** on a T004 candidate SHA |

The harness self-checks (`harness.test.ts`) are the only tests vitest runs from
this directory. The scenario functions in `scenarios/` are plain async
functions (not `*.test.ts`), so CI stays green while the launcher does not
exist. They will be wired to `it()` once T004 exports a runnable interface.

## Confirmed public calling surface

```ts
// @hdsl/runtime
const runtime = createRuntimePort({
  host, fetch, faults, urlRewrites, localArtifactDirectory,
  diskFreeBytes, limits, closureInstall, precheck,
});

// @hdsl/core
const install = await createManagedInstall({
  dataRoot, catalog, runtime, host, clock, faults, limits, fixtures,
});
const api = createContractRuntime({ port: install.port }); // dispatch only
```

Types are declared in `support/managed-install-api.ts`. Key confirmed behavior
(hdsl-15, 2026-09-20):

- create is asynchronous: `dispatch` returns `{ operationId }`; poll
  `operations.get` / `environments.list` with a bounded timeout.
- artifact download verifies the 64-hex SHA-256 from
  `catalog.artifactLocations.{node,dsh}.url`; interruption → `DOWNLOAD_FAILED`,
  bytes mismatch → `DIGEST_MISMATCH`. Both leave `state=error`,
  `activeGenerationId=null`.
- real installs run `npm ci --ignore-scripts` with the catalog's exact lock and
  record `<generation>/install-manifest.json`
  (`installMode: "npm-ci"`, closure lock SHA-256, package count, npm version,
  preflight checks).
- `service.readInstallManifest(environmentId)` is the public read surface.
- production create rejects an `artifacts-only` manifest with
  `INTERNAL_ERROR` and writes no active pointer. Only the explicit fixture path
  (`createManagedInstall({ fixtures: { allowArtifactsOnly: true } })` +
  `createRuntimePort({ closureInstall: false, precheck: 'none' })`) may commit
  an artifacts-only generation.

## Layout

```text
tests/integration/install/
  harness.test.ts            # fixture self-checks (vitest, green)
  scenarios/
    install-scenarios.ts     # executable-ready scenarios (not run yet)
  support/
    artifacts.ts             # deterministic tar.gz artifacts + hostile archive
    catalog-fixtures.ts      # local-endpoint-backed RuntimeCombinations
    composition.ts           # expected compositionDigest (frozen rule)
    disk-fault.ts            # labelled injected ENOSPC
    hash.ts                  # sha256 helpers
    local-endpoint.ts        # loopback HTTP endpoint (full/truncate/reset)
    managed-install-api.ts   # confirmed T004 surface + loaders
    manifest.ts              # install-manifest assertions
    scenario.ts              # dispatch/poll/require helpers
    tar.ts                   # deterministic tar.gz writer + parser
    temp-env.ts              # temp roots, HOME isolation, host-default snapshots
    tiny-volume.ts           # real ENOSPC via mounted HFS+ image (macOS)
```

## Run the fixture self-checks

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run tests/integration/install/harness.test.ts
```

## Wiring the scenarios (once T004 lands)

Create `tests/integration/install/install.integration.test.ts`:

```ts
import { loadCoreModule, loadRuntimeModule } from './support/managed-install-api.js';
import { scenarioTwoEnvironmentIsolation, /* ... */ } from './scenarios/install-scenarios.js';

const core = await loadCoreModule();
const runtime = await loadRuntimeModule();
// describe.skip is NOT acceptable for a real defect. If either module is
// missing, fail loudly: the dependency is not met, the task stops and reports.
if (core === undefined || runtime === undefined) {
  throw new Error('T004 public interface is not available yet');
}
```

Never substitute a mock port for a missing real one, never call a scenario green
because a fault flag was set, and never cite synthetic tarballs as proof that a
real DSH is runnable.

## Fault labeling

Every injected fault carries its label in the case id and is asserted only
through the public contract (terminal `operation.status`/`error.code` and
environment `state`):

- `forceDiskFull` → **injected**; `mounted tiny volume + minFreeBytes` → **real**.
- `truncate`/`reset` transport → **injected** download fault.
- `pauseBeforeCommit` → **injected** crash boundary.

Synthetic tarballs are **not** real Node/DSH artifacts. They prove download,
digest, journal, isolation, path-safety and host-HOME boundaries only. Real
`version`/`help` evidence requires the `npm-ci` closure with real artifacts.
