// Resolution hook for the A2 window-kill child: maps workspace bare specifiers
// and `.js`→`.ts` sibling specifiers so a plain `node` child can drive the real
// `@hdsl/core` / `@hdsl/runtime` sources.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKSPACE = {
  '@hdsl/contracts': new URL('../../../packages/contracts/src/index.ts', import.meta.url).href,
  '@hdsl/core': new URL('../../../packages/core/src/index.ts', import.meta.url).href,
  '@hdsl/runtime': new URL('../../../packages/runtime/src/index.ts', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const mapped = WORKSPACE[specifier];
  if (mapped !== undefined) {
    return nextResolve(mapped, context);
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}
