/**
 * Composition-lock projection used by install scenarios.
 *
 * These are the *expected* values QA computes independently of the launcher so
 * the persisted `compositionDigest` is checked against the frozen rule
 * (`packages/contracts/src/digest.ts`, issue #15 N3): SHA-256 over the
 * canonical JSON of `schemaVersion` + node/dsh refs + sorted plugins, with
 * download URLs deliberately excluded.
 */
import {
  serializeCompositionDigestInput,
  type CompositionLock,
  type RuntimeCombination,
} from '@hdsl/contracts';

import { sha256Hex } from './hash.js';

export const lockFromCombination = (combination: RuntimeCombination): CompositionLock => ({
  schemaVersion: '1',
  node: combination.node,
  dsh: combination.dsh,
  plugins: [],
  sources: {
    node: {
      url: combination.artifactLocations.node.url,
      sha256: combination.artifactLocations.node.sha256,
    },
    dsh: {
      url: combination.artifactLocations.dsh.url,
      sha256: combination.artifactLocations.dsh.sha256,
    },
  },
});

export const expectedCompositionDigest = (combination: RuntimeCombination): string =>
  sha256Hex(serializeCompositionDigestInput(lockFromCombination(combination)));
