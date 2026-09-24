/**
 * Types for the macOS DMG mount checker in `verify-mac-dmg.mjs`.
 * The script itself stays plain ESM so the macOS workflow can run it with
 * `node` on the runner without a build step.
 */

/** @returns `hdiutil attach` argument vector. */
export declare const attachArguments: (dmg: string, mountPoint: string) => string[];

/** @returns One message per problem; empty means the image is usable. */
export declare const inspectMountedImage: (mountPoint: string) => string[];
