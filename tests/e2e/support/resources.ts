/**
 * Registered QA resources for the desktop E2E slice (`tests/e2e`).
 *
 * Independent QA owns this directory (issue #64 / T007c, parent #7). Every temp
 * root lives under a **single run-scoped base directory** created lazily by the
 * registry, so cleanup and residue checks only ever touch this run's own tree.
 * The slice must never scan or delete the whole OS temp directory: parallel e2e
 * files, other sessions or unrelated processes may own roots there (review F4).
 *
 * The desktop E2E run spawns an Electron instance, real managed DSH child
 * processes and multiple temporary dataRoots. Every one of those is a resource
 * that MUST be torn down, and a teardown that throws MUST NOT be swallowed:
 * `CleanupReport.failed` is part of the result, not a log line. Cleanup only
 * disposes resources that were explicitly registered.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every temporary root created by this slice carries this prefix. */
export const E2E_TMP_PREFIX = 'hdsl-e2e-';

export interface CleanupFailure {
  readonly label: string;
  readonly message: string;
}

export interface CleanupReport {
  readonly disposed: readonly string[];
  readonly failed: readonly CleanupFailure[];
}

interface RegisteredResource {
  readonly label: string;
  readonly dispose: () => void | Promise<void>;
}

export class DuplicateResourceError extends Error {
  public constructor(label: string) {
    super(`resource label already registered: ${label}`);
    this.name = 'DuplicateResourceError';
  }
}

export class CleanupFailureError extends Error {
  public constructor(failed: readonly CleanupFailure[]) {
    super(
      `registered resource cleanup failed: ${failed
        .map((entry) => `${entry.label} (${entry.message})`)
        .join('; ')}`,
    );
    this.name = 'CleanupFailureError';
  }
}

export class RunResidueError extends Error {
  public constructor(path: string, entries: readonly string[]) {
    super(`run directory not cleaned: ${path} (${entries.join(', ') || 'still present'})`);
    this.name = 'RunResidueError';
  }
}

/**
 * Ordered registry of everything the current scenario must release.
 *
 * Disposal runs in reverse registration order so a process that depends on a
 * temp root is stopped before the root is deleted. A throwing disposer is
 * recorded and the remaining disposers still run.
 */
export class QaResourceRegistry {
  readonly #resources: RegisteredResource[] = [];
  readonly #labels = new Set<string>();
  #baseDirectory: string | undefined;

  /** Lazily creates and registers the run-scoped base directory. */
  public get baseDirectory(): string {
    if (this.#baseDirectory === undefined) {
      const path = mkdtempSync(join(tmpdir(), `${E2E_TMP_PREFIX}run-`));
      this.#baseDirectory = path;
      this.register('run-directory', () => {
        rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      });
    }
    return this.#baseDirectory;
  }

  public register(label: string, dispose: () => void | Promise<void>): void {
    if (this.#labels.has(label)) {
      throw new DuplicateResourceError(label);
    }
    this.#labels.add(label);
    this.#resources.push({ label, dispose });
  }

  /** Creates an OS temp root inside this run's base directory and registers it. */
  public registerTempRoot(label: string): string {
    const path = mkdtempSync(join(this.baseDirectory, `${label}-`));
    this.register(`temp-root:${label}`, () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    });
    return path;
  }

  public get registeredCount(): number {
    return this.#resources.length;
  }

  public async cleanup(): Promise<CleanupReport> {
    const disposed: string[] = [];
    const failed: CleanupFailure[] = [];
    for (const resource of [...this.#resources].reverse()) {
      try {
        await resource.dispose();
        disposed.push(resource.label);
      } catch (error) {
        failed.push({
          label: resource.label,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#resources.length = 0;
    this.#labels.clear();
    return { disposed, failed };
  }
}

/** Throws when any registered resource failed to release. Never a silent pass. */
export const assertCleanupSucceeded = (report: CleanupReport): void => {
  if (report.failed.length > 0) {
    throw new CleanupFailureError(report.failed);
  }
};

/** Throws when this run's own base directory was not removed. */
export const assertRunCleaned = (baseDirectory: string): void => {
  if (existsSync(baseDirectory)) {
    throw new RunResidueError(baseDirectory, readdirSync(baseDirectory).sort());
  }
};
