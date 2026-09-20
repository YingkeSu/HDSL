/**
 * Behavior checks for the pnpm settings that keep dependency versions pinned
 * and the toolchain enforced.
 *
 * An earlier revision only grepped `.npmrc` text, so it stayed green while
 * pnpm 11 ignored `save-exact`/`engine-strict` entirely and `pnpm add` kept
 * writing `^` ranges (PR #20 review F1/F3). These tests drive pnpm itself, so
 * moving the settings back to an ineffective source fails the suite.
 *
 * Only the mechanism is asserted; no business behavior exists yet (T003+).
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface PnpmResult {
  status: number;
  stdout: string;
  stderr: string;
}

const pnpm = (args: string[], cwd: string): PnpmResult => {
  try {
    const stdout = execFileSync('pnpm', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Ignore any developer/user-level npm config so the probe only sees
        // the workspace configuration under test.
        npm_config_userconfig: join(cwd, '.hdsl-no-user-npmrc'),
      },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
};

const writeFiles = (directory: string, files: Record<string, string>): void => {
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
};

const writeProbe = (
  directory: string,
  manifest: Record<string, unknown>,
  workspace: string,
): void => {
  writeFiles(directory, {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'pnpm-workspace.yaml': workspace,
  });
};

describe('pnpm settings are effective, not just present', () => {
  it('reports saveExact and engineStrict as active for this repository', () => {
    for (const key of ['save-exact', 'engine-strict']) {
      const result = pnpm(['config', 'get', key], root);
      expect(result.status, `${key}: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim(), key).toBe('true');
    }
  });

  it('writes an exact version when a dependency is added', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hdsl-save-exact-'));
    try {
      writeProbe(
        directory,
        { name: 'hdsl-save-exact-probe', private: true, version: '0.0.0' },
        'packages: []\nsaveExact: true\n',
      );
      const result = pnpm(['add', '--prefer-offline', '-D', 'typescript'], directory);
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        devDependencies?: Record<string, string>;
      };
      expect(manifest.devDependencies?.typescript).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts a supported Node engine and rejects an unsupported one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hdsl-engine-strict-'));
    try {
      const caseDirectory = (name: string, nodeRange: string): string => {
        const target = join(directory, name);
        mkdirSync(target);
        writeProbe(
          target,
          { name: `hdsl-${name}-probe`, private: true, version: '0.0.0', engines: { node: nodeRange } },
          'packages: []\nengineStrict: true\n',
        );
        return target;
      };
      const supported = pnpm(['install'], caseDirectory('supported', '>=22.19.0'));
      expect(supported.status, supported.stderr).toBe(0);

      const unsupported = pnpm(['install'], caseDirectory('unsupported', '>=99.0.0'));
      expect(unsupported.status).not.toBe(0);
      expect(`${unsupported.stdout}${unsupported.stderr}`).toContain(
        'ERR_PNPM_UNSUPPORTED_ENGINE',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
