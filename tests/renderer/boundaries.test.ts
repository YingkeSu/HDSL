/**
 * Renderer privilege/scope boundaries (T006a).
 *
 * The renderer must stay free of Node, Electron and arbitrary IPC, must not
 * fall back to a mock in production, and the shipped demo must be honestly
 * labeled and self-contained. This complements the workspace-wide boundary
 * test in `tests/engineering/workspace-boundaries.test.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rendererRoot = join(root, 'apps/desktop/src/renderer');

const sourceFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(path)) {
      files.push(path);
    }
  }
  return files;
};

describe('renderer privileges', () => {
  it('never reaches for Node, Electron, token URLs or arbitrary IPC', () => {
    const forbidden = [
      'ipcRenderer',
      'contextBridge',
      'require(',
      'process.',
      'shell.openExternal',
      'nodeIntegration',
      'tokenUrl',
      'localStorage',
    ];
    for (const file of sourceFiles(rendererRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        expect(source, `${file} must not contain ${needle}`).not.toContain(needle);
      }
    }
  });

  it('keeps the production entry free of mock and test helpers', () => {
    const entry = readFileSync(join(rendererRoot, 'index.tsx'), 'utf8');
    expect(entry).not.toMatch(/from '\.\/(demo|testing)\//);
    expect(entry).toContain('must not fall back to a mock client');
  });
});

describe('renderer demo', () => {
  it('is self-contained and clearly labeled as mock data', () => {
    const html = readFileSync(join(rendererRoot, 'demo/index.html'), 'utf8');
    expect(html).toContain('演示模式');
    expect(html).toContain('模拟数据');
    expect(html).toContain('不是真实 DSH');
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:\/\//i);
    expect(html).not.toContain('file://');
    const readme = readFileSync(join(rendererRoot, 'demo/README.md'), 'utf8');
    expect(readme).toContain('mock');
  });
});
