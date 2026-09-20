/**
 * Engineering-boundary tests for the T002 workspace.
 *
 * These assertions encode decisions from ADR 0001, docs/architecture/tdd.md and
 * docs/development/tooling.md: who may depend on whom, that tool versions are
 * pinned instead of floating, and that the renderer stays free of Node/Electron
 * privileges. They do not test business behavior — no environment, install or
 * process logic exists yet (T003+).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspaceNames = ['@hdsl/contracts', '@hdsl/core', '@hdsl/runtime', '@hdsl/desktop'];

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  packageManager?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, Record<string, string>>;
  files?: string[];
}

interface RootManifest extends PackageManifest {
  scripts?: Record<string, string>;
}

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as T;

const rootManifest = readJson<RootManifest>('package.json');
const manifests = new Map<string, PackageManifest>(
  [
    'packages/contracts/package.json',
    'packages/core/package.json',
    'packages/runtime/package.json',
    'apps/desktop/package.json',
  ].map((path) => {
    const manifest = readJson<PackageManifest>(path);
    return [manifest.name, manifest] as const;
  }),
);

const allDependencyGroups = (manifest: PackageManifest): Array<[string, string]> =>
  Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  });

const workspaceDependencies = (manifest: PackageManifest): string[] =>
  allDependencyGroups(manifest)
    .map(([name]) => name)
    .filter((name) => workspaceNames.includes(name))
    .sort();

const declaredSpecifiers = (manifest: PackageManifest): Array<[string, string]> =>
  allDependencyGroups(manifest).filter(([, specifier]) => specifier.startsWith('workspace:'));

describe('workspace layout', () => {
  it('declares the apps and packages globs and pins pnpm', () => {
    const workspaceYaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
    expect(workspaceYaml).toContain('apps/*');
    expect(workspaceYaml).toContain('packages/*');

    expect(rootManifest.packageManager).toBe('pnpm@11.7.0');
    expect(rootManifest.engines?.node).toBe('^22.19.0 || ^24.0.0 || >=26.0.0');
  });

  it('keeps every workspace manifest private and versioned together', () => {
    expect([...manifests.keys()].sort()).toEqual([...workspaceNames].sort());
    for (const manifest of manifests.values()) {
      expect(manifest.private).toBe(true);
      expect(manifest.version).toBe('0.0.0');
    }
  });

  it('ships only dist and points every export at the build output', () => {
    for (const manifest of manifests.values()) {
      expect(manifest.files).toContain('dist');
      expect(Object.keys(manifest.exports ?? {}).length).toBeGreaterThan(0);
      for (const entry of Object.values(manifest.exports ?? {})) {
        expect(entry.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
        expect(entry.default).toMatch(/^\.\/dist\/.+\.js$/);
        expect(entry.types?.replace(/\.d\.ts$/, '')).toBe(entry.default?.replace(/\.js$/, ''));
      }
    }
  });
});

describe('version locking', () => {
  it('pins every dependency to an exact version or a workspace link', () => {
    const floating = /[\^~><*]|\blatest\b/;
    for (const [packageName, manifest] of manifests.entries()) {
      for (const [dependency, specifier] of allDependencyGroups(manifest)) {
        expect(
          specifier.startsWith('workspace:') || !floating.test(specifier),
          `${packageName} depends on ${dependency}@${specifier}`,
        ).toBe(true);
      }
    }
    for (const [dependency, specifier] of allDependencyGroups(rootManifest)) {
      expect(specifier, `${dependency}@${specifier}`).not.toMatch(floating);
    }
  });

  it('pins pnpm and Node consistently in CI', () => {
    const workflow = readFileSync(
      join(root, '.github/workflows/engineering-checks.yml'),
      'utf8',
    );
    expect(workflow).toContain('pnpm/action-setup@v4');
    expect(workflow).toContain(`version: ${rootManifest.packageManager?.split('@')[1]}`);
    expect(workflow).toContain('node-version-file: .nvmrc');
    expect(readFileSync(join(root, '.nvmrc'), 'utf8').trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('module boundaries', () => {
  it('keeps Electron and React out of the domain packages', () => {
    for (const packageName of ['@hdsl/contracts', '@hdsl/core', '@hdsl/runtime']) {
      const manifest = manifests.get(packageName);
      const dependencies = allDependencyGroups(manifest as PackageManifest).map(([name]) => name);
      expect(dependencies, packageName).not.toContain('electron');
      expect(dependencies, packageName).not.toContain('react');
      expect(dependencies, packageName).not.toContain('react-dom');
    }
  });

  it('allows only apps/desktop to own Electron', () => {
    const withElectron = [...manifests.entries()]
      .filter(([, manifest]) => allDependencyGroups(manifest).some(([name]) => name === 'electron'))
      .map(([name]) => name);
    expect(withElectron).toEqual(['@hdsl/desktop']);
  });

  it('points every workspace dependency edge inward', () => {
    expect(workspaceDependencies(manifests.get('@hdsl/contracts') as PackageManifest)).toEqual([]);
    expect(workspaceDependencies(manifests.get('@hdsl/core') as PackageManifest)).toEqual([
      '@hdsl/contracts',
    ]);
    expect(workspaceDependencies(manifests.get('@hdsl/runtime') as PackageManifest)).toEqual([
      '@hdsl/contracts',
    ]);
    expect(workspaceDependencies(manifests.get('@hdsl/desktop') as PackageManifest)).toEqual([
      '@hdsl/contracts',
      '@hdsl/core',
      '@hdsl/runtime',
    ]);
  });

  it('links workspace dependencies with the workspace protocol', () => {
    for (const manifest of manifests.values()) {
      for (const [dependency, specifier] of declaredSpecifiers(manifest)) {
        expect(specifier, dependency).toBe('workspace:*');
      }
    }
  });

  it('keeps Node builtins, Electron and the domain runtime out of the renderer', () => {
    const rendererRoot = join(root, 'apps/desktop/src/renderer');
    const forbidden =
      /^(electron|node:.*|fs|path|child_process|@hdsl\/core|@hdsl\/runtime)$/;
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(path)) files.push(path);
      }
    };
    walk(rendererRoot);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(forbidden);
      }
    }
  });
});

describe('root scripts', () => {
  it('exposes the verified engineering commands', () => {
    expect(rootManifest.scripts?.typecheck).toBe('tsc -p tsconfig.json');
    expect(rootManifest.scripts?.build).toBe('tsc -b tsconfig.build.json');
    expect(rootManifest.scripts?.test).toBe('vitest run');
    expect(rootManifest.scripts?.['check:repository']).toBe(
      'python3 scripts/check_repository.py',
    );
  });
});
