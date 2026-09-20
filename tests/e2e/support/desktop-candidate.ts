/**
 * Desktop candidate readiness detector.
 *
 * `#7` desktop E2E cannot run until `#6` actually wires the Electron main
 * process: a real window, the narrow preload bridge and main-side IPC handlers.
 * Today `apps/desktop/src/main/index.ts` still throws the T006 placeholder, so
 * every real-window scenario is `blocked` — and this module records *why* in a
 * structured, testable way instead of a comment that drifts.
 *
 * A detector is only useful if it is falsifiable. `assessDesktopCandidate` is a
 * pure function over a descriptor; `harness.test.ts` feeds it both a fully
 * wired descriptor (must report ready) and partially wired ones (must report
 * the exact missing capability). The real workspace probe is checked for
 * internal consistency (`ready` XOR `blockers.length > 0`) and never asserted
 * to a specific readiness value, so this file does not turn red merely because
 * `#6` merges.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file's location (`tests/e2e/support/`). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface DesktopCandidateDescriptor {
  /** `main/index.ts` creates the application `BrowserWindow`. */
  readonly windowBootstrap: boolean;
  /** `main/**` registers `ipcMain.handle`/`on` for the whitelisted methods. */
  readonly ipcHandlers: boolean;
  /** `preload/index.ts` exposes the narrow surface via `contextBridge`. */
  readonly preloadBridge: boolean;
  /** The T006 "not implemented" placeholder still present in the main entry. */
  readonly placeholderMarker: boolean;
}

export interface CandidateAssessment {
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

export const assessDesktopCandidate = (
  descriptor: DesktopCandidateDescriptor,
): CandidateAssessment => {
  const blockers: string[] = [];
  if (descriptor.placeholderMarker) {
    blockers.push('main entry still declares the T006 placeholder (bootstrapDesktop throws)');
  }
  if (!descriptor.windowBootstrap) {
    blockers.push('main entry does not create the application BrowserWindow');
  }
  if (!descriptor.ipcHandlers) {
    blockers.push('main entry registers no ipcMain handler for the whitelisted contract methods');
  }
  if (!descriptor.preloadBridge) {
    blockers.push('preload entry does not expose the narrow bridge via contextBridge');
  }
  return { ready: blockers.length === 0, blockers };
};

const readSource = (relPath: string): string => {
  const full = join(REPO_ROOT, relPath);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
};

export interface DesktopWorkspaceProbe {
  readonly descriptor: DesktopCandidateDescriptor;
  readonly assessment: CandidateAssessment;
  readonly electronVersion: string | null;
  readonly electronBinaryPresent: boolean;
  readonly appsDesktopMain: string;
}

export const probeDesktopCandidate = (): DesktopWorkspaceProbe => {
  const main = readSource('apps/desktop/src/main/index.ts');
  const mainDir = readSource('apps/desktop/src/main/contract.ts');
  const preload = readSource('apps/desktop/src/preload/index.ts');
  const descriptor: DesktopCandidateDescriptor = {
    windowBootstrap: /new\s+BrowserWindow\s*\(/.test(main),
    ipcHandlers: /ipcMain\.(handle|on)\s*\(/.test(`${main}\n${mainDir}`),
    preloadBridge: /contextBridge\.exposeInMainWorld\s*\(/.test(preload),
    placeholderMarker: /is not implemented yet/i.test(main),
  };
  return {
    descriptor,
    assessment: assessDesktopCandidate(descriptor),
    electronVersion: readElectronVersion(),
    electronBinaryPresent: existsSync(join(REPO_ROOT, 'apps/desktop/node_modules/electron/dist')),
    appsDesktopMain: 'apps/desktop/src/main/index.ts',
  };
};

/** Reads the pinned Electron version from `apps/desktop/package.json`. */
export const readElectronVersion = (): string | null => {
  const full = join(REPO_ROOT, 'apps/desktop/package.json');
  if (!existsSync(full)) {
    return null;
  }
  const parsed: unknown = JSON.parse(readFileSync(full, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as { devDependencies?: Record<string, unknown> };
  const value = record.devDependencies?.['electron'];
  return typeof value === 'string' ? value : null;
};

/** An exact pin has no range operator and no tag (`44.4.3`, never `^44.4.3`). */
export const isExactVersion = (version: string): boolean => /^\d+\.\d+\.\d+/.test(version);
