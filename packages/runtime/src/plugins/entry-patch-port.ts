/**
 * Runtime-owned adapter for the `entries.patch` contract method (#135, E1-T1).
 *
 * It reuses the E1a desired-config boundary verbatim
 * ({@link applyPatchOperation} / {@link PatchConfigDocument} /
 * {@link writePatchFileWithinRoot}) and only adapts the result to the frozen
 * `EntryPatchResult` DTO (dropping the local `patchPath`, which must never cross
 * the bridge).
 *
 * The write is anchored to the caller-provided home root, so a caller can never
 * turn this adapter into an arbitrary-path writer or write a generation's
 * immutable profile declaration source. `scope` is fixed to `patch-entry`, and
 * the result is always `saved: true` + `runtime: 'pending'` +
 * `runtimeVerification: 'unavailable'`; it is NEVER a runtime ACTIVE claim.
 */
import {
  portOk,
  sanitizeBoundedMessage,
  ENTRY_PATCH_DIAGNOSTICS_MAX,
  ENTRY_PATCH_ROWS_MAX,
  ENTRY_PATCH_ROW_ID_MAX,
  type EntryPatchDiagnostic,
  type EntryPatchResult,
  type EntryPatchRow,
  type PortOutcome,
} from '@hdsl/contracts';
import {
  applyPatchOperation,
  type PatchDiagnostic,
  type PatchEditOperation,
  type PatchReloadMode,
  type PatchRowView,
} from './patch-config.js';

export interface EntryPatchPortRequest {
  readonly operation: PatchEditOperation;
  /** Environment-shared `$DSH_HOME`; `patchPath` must be strictly inside. */
  readonly homeRoot: string;
  /** Absolute path of `<homeRoot>/cordis.patch.yml`. */
  readonly patchPath: string;
  /** Current patch text; `[]` when the file is absent. */
  readonly text: string;
  readonly reloadMode: PatchReloadMode;
}

/** Terminal home-patch result without the core-owned `environmentId`. */
export type EntryPatchPortResult = Omit<EntryPatchResult, 'environmentId'>;

export interface EntryPatchPort {
  applyPatch(request: EntryPatchPortRequest): PortOutcome<EntryPatchPortResult>;
}

const toRow = (row: PatchRowView): EntryPatchRow => ({
  id: sanitizeBoundedMessage(row.id, ENTRY_PATCH_ROW_ID_MAX),
  kind: row.kind,
  name: row.nameKnown && row.name !== undefined ? row.name.slice(0, 214) : null,
  nameKnown: row.nameKnown,
  disabled: row.disabled ?? null,
  hasConfig: row.hasConfig,
});

const toDiagnostic = (diagnostic: PatchDiagnostic): EntryPatchDiagnostic => ({
  code: diagnostic.code,
  line: diagnostic.line > 0 ? diagnostic.line : 1,
  detail: sanitizeBoundedMessage(diagnostic.detail, 512),
});

export const createEntryPatchPort = (): EntryPatchPort => ({
  applyPatch(request: EntryPatchPortRequest): PortOutcome<EntryPatchPortResult> {
    const outcome = applyPatchOperation({
      profileRoot: request.homeRoot,
      patchPath: request.patchPath,
      text: request.text,
      operation: request.operation,
      reloadMode: request.reloadMode,
      scope: 'patch-entry',
    });
    if (!outcome.ok) {
      return outcome;
    }
    const result = outcome.value;
    return portOk({
      operation: result.operation,
      saved: true,
      runtime: 'pending',
      runtimeVerification: 'unavailable',
      activation: result.activation,
      restartRequired: result.activation === 'restart-required',
      reloadMode: result.reloadMode,
      rows: result.rows.slice(0, ENTRY_PATCH_ROWS_MAX).map(toRow),
      diagnostics: result.diagnostics
        .slice(0, ENTRY_PATCH_DIAGNOSTICS_MAX)
        .map(toDiagnostic),
    });
  },
});
