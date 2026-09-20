// Node module-resolution hook for the cross-process lock tests.
//
// The workspace uses NodeNext `.js` import specifiers that TypeScript resolves
// to `.ts` sources. Node's built-in type stripping runs `.ts` files but does not
// rewrite specifiers, so this hook maps a relative `./x.js` to its real `./x.ts`
// sibling when one exists.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}
