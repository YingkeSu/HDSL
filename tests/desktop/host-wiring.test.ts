/**
 * Production host-wiring negative controls (#107).
 *
 * A runtime resolver test cannot catch the real regression: the Electron
 * bootstrap simply did not pass `host` to `createDesktopComposition`, while
 * core/runtime silently fell back to darwin/arm64. These source-level checks
 * pin the production wiring so a future edit cannot drop the real host or
 * reintroduce a hardcoded darwin fallback.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (relativePath: string): string => readFileSync(join(root, relativePath), 'utf8');

describe('production desktop bootstrap reports the real host (#107)', () => {
  const app = source('apps/desktop/src/main/app.ts');
  const bootstrapStart = app.indexOf('const bootstrap = async');
  const bootstrapEnd = app.indexOf('const focusMainWindow');
  const bootstrap =
    bootstrapStart >= 0 && bootstrapEnd > bootstrapStart
      ? app.slice(bootstrapStart, bootstrapEnd)
      : '';

  it('resolves the host from process.platform / process.arch without a cast', () => {
    expect(bootstrap).toContain('resolveHostPlatform(process.platform, process.arch)');
    // The resolver returns a host or undefined; a blind `as` would hide the
    // unknown-platform case this fix must fail closed on.
    expect(bootstrap).not.toMatch(/resolveHostPlatform\([^)]*\)\s*as\b/);
  });

  it('refuses an unresolvable host before the composition side effect', () => {
    const guardIndex = bootstrap.indexOf('host === undefined');
    const quitIndex = bootstrap.indexOf('app.quit()');
    const dataRootIndex = bootstrap.indexOf('const dataRoot = resolveDataRoot');
    const composeIndex = bootstrap.indexOf('createDesktopComposition');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    // Guard → quit → (only then) data-root/composition work.
    expect(quitIndex).toBeGreaterThan(guardIndex);
    expect(dataRootIndex).toBeGreaterThan(quitIndex);
    expect(composeIndex).toBeGreaterThan(dataRootIndex);
  });

  it('passes the resolved host into createDesktopComposition', () => {
    const composeIndex = bootstrap.indexOf('createDesktopComposition({');
    expect(composeIndex).toBeGreaterThanOrEqual(0);
    const call = bootstrap.slice(composeIndex, composeIndex + 400);
    expect(call).toContain('host,');
    expect(call).toContain('appInfo:');
  });

  it('does not reintroduce a hardcoded darwin/arm64 host fallback', () => {
    expect(bootstrap).not.toMatch(/platform:\s*'darwin'/);
    expect(bootstrap).not.toMatch(/'darwin',\s*arch:\s*'arm64'/);
  });
});

describe('desktop composition forwards the host to every consumer (#107)', () => {
  const composition = source('apps/desktop/src/main/composition.ts');

  it('forwards the host into createRuntimePort instead of the bare production options', () => {
    const runtimeIndex = composition.indexOf('createRuntimePort({');
    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    const call = composition.slice(runtimeIndex, runtimeIndex + 300);
    expect(call).toContain('host: options.host');
    // The old bare call dropped the host entirely.
    expect(composition).not.toMatch(/createRuntimePort\(PRODUCTION_RUNTIME_OPTIONS\)/);
  });

  it('forwards the host to the service, the runner and the contract port', () => {
    const forwards = composition.match(/host: options\.host/g) ?? [];
    // runtime + EnvironmentService + createEnvironmentContractPort
    expect(forwards.length).toBeGreaterThanOrEqual(3);
  });
});

describe('core/runtime host fallbacks are removed (#107)', () => {
  it('no longer defaults EnvironmentService or RuntimePort to darwin/arm64', () => {
    const service = source('packages/core/src/creation-service.ts');
    const runtime = source('packages/runtime/src/install/runtime-port.ts');
    expect(service).not.toMatch(/options\.host \?\? \{ platform: 'darwin', arch: 'arm64' \}/);
    expect(runtime).not.toMatch(/options\.host \?\? \{ platform: 'darwin', arch: 'arm64' \}/);
  });
});
