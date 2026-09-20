# Install integration QA (`tests/integration/install`)

Owner: **hdsl-18** (issue [#31](https://github.com/YingkeSu/HDSL/issues/31), T007a).
Baseline contract SHA: `3e76a49694f8dcf4c8bba5d32196a6665a2f394e`
(`contracts-v1.0.0`). This directory and
`docs/development/install-validation.md` are the only QA-owned paths; QA does
not modify production code and does not perform PR review.

## Status

| Item | State |
| --- | --- |
| Public calling surface (T004 / #4) | **Confirmed** and executed against candidate `ccaaeb9` |
| Fixture harness | **Done** — 9 self-checks green |
| Scenario suite | **Executable** — `install.integration.test.ts` registers 16 synthetic + 2 real opt-in cases |
| Result on `ccaaeb9` | synthetic 16 PASS; real opt-in 2 PASS; full suite 290 passed / 3 skipped |

`harness.test.ts` proves the fixtures; `install.integration.test.ts` drives the
real T004 public API. Both are real vitest suites. The only conditional cases
are a documented macOS platform gate (`INST-DISK-02`) and the network/`npm ci`
opt-in group (`HDSL_QA_REAL_INSTALL=1`). Results and limitations live in
`docs/development/install-validation.md`.

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
  harness.test.ts                  # fixture self-checks (vitest, green)
  install.integration.test.ts      # real executable scenarios over public T004 API
  scenarios/
    install-scenarios.ts           # scenario functions
  support/
    artifacts.ts                   # deterministic tar.gz artifacts + hostile archive
    catalog-fixtures.ts            # local-endpoint-backed RuntimeCombinations
    composition.ts                 # expected compositionDigest (frozen rule)
    disk-fault.ts                  # labelled injected ENOSPC
    hash.ts                        # sha256 helpers
    local-endpoint.ts              # loopback HTTP endpoint (full/truncate/reset/slow/fail-first)
    managed-install-api.ts         # re-exported T004 surface types
    manifest.ts                    # install-manifest assertions
    scenario.ts                    # dispatch/poll/journal-wait helpers
    tar.ts                         # deterministic tar.gz writer + parser
    temp-env.ts                    # temp roots, HOME isolation, host-default snapshots
    tiny-volume.ts                 # real ENOSPC via mounted HFS+ image (macOS)
```

## Run

```sh
pnpm install --frozen-lockfile

# Synthetic install boundary (16 cases, no skips except the macOS gate)
pnpm exec vitest run tests/integration/install/install.integration.test.ts

# Real closure (opt-in: network + npm ci)
HDSL_QA_REAL_INSTALL=1 pnpm exec vitest run tests/integration/install/install.integration.test.ts -t "install real closure"

# Fixture self-checks
pnpm exec vitest run tests/integration/install/harness.test.ts
```

Never substitute a mock port for a missing real one, never call a scenario green
because a fault flag was set, and never cite synthetic tarballs as proof that a
real DSH is runnable.

## Fault labeling

Every injected fault carries its label in the case id and is asserted only
through the public contract (terminal `operation.status`/`error.code` and
environment `state`):

- `forceDiskFull` → **injected**; `mounted tiny volume + minFreeBytes` → **real**.
- `truncate`/`reset` transport → **injected** download fault; `slow`/`fail-first` → forced interleaving / one failed side.
- `pauseBeforeCommit` → **injected** crash boundary.

Synthetic tarballs are **not** real Node/DSH artifacts. They prove download,
digest, journal, isolation, path-safety and host-HOME boundaries only. Real
`version`/`help` evidence requires the `npm-ci` closure with real artifacts.
