import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source so unit tests do not require a build.
    alias: {
      '@hdsl/contracts': src('./packages/contracts/src/index.ts'),
      '@hdsl/core': src('./packages/core/src/index.ts'),
      '@hdsl/runtime': src('./packages/runtime/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // tests/probes holds manually executed upstream DSH evidence (shell/Python),
    // not HDSL acceptance or part of the engineering unit run.
    exclude: ['tests/probes/**', '**/node_modules/**'],
  },
});
