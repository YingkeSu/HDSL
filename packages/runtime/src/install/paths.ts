/** Path containment helpers shared by extraction and staging. */
import { isAbsolute, relative, resolve } from 'node:path';
import { InstallFailure } from './failure.js';

export const isWithin = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
};

export const assertWithin = (root: string, candidate: string, label: string): string => {
  const resolved = resolve(candidate);
  if (!isWithin(root, resolved)) {
    throw new InstallFailure('INTERNAL_ERROR', `${label} escapes its destination`);
  }
  return resolved;
};
