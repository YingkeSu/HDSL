/**
 * Types for the macOS app-bundle checker in `verify-mac-package.mjs`.
 * The script itself stays plain ESM so the macOS workflow can run it with
 * `node` on the runner without a build step.
 */

/** @returns One message per problem; empty means the bundle is complete. */
export declare const inspectMacApp: (app: string) => string[];

/** @throws {Error} When the bundle is missing or carries forbidden content. */
export declare const verifyMacApp: (app: string) => void;
