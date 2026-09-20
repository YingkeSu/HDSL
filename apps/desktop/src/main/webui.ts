/**
 * Main-only authenticated WebUI opener (T006 / issue #6).
 *
 * Extracted from the Electron entry so the success/failure binding can be unit
 * tested without Electron. The opener:
 * - requires the runtime's main-only `consumeWebUIBootstrap` capability; when it
 *   is absent it returns `WEBUI_UNAVAILABLE` instead of opening a token-free
 *   origin that would only 401;
 * - awaits the runtime call, which itself awaits the `openExternal` callback, so
 *   success is bound to the real open result (`opened: true` can never precede
 *   an async failure);
 * - passes the bootstrap URL only to the injected `openExternal` callback and
 *   never returns, logs or persists it.
 */
import { portOk, type ErrorCode, type OpenWebUIResult, type PortOutcome } from '@hdsl/contracts';
import type { VerifiedWebUiContext, VerifiedWebUiOpener } from './composition.js';

export type OpenExternal = (url: string) => Promise<void>;

const failure = (code: ErrorCode, message: string): PortOutcome<never> => ({
  ok: false,
  code,
  message,
});

export const createVerifiedWebUiOpener = (openExternal: OpenExternal): VerifiedWebUiOpener => {
  return async (context: VerifiedWebUiContext): Promise<PortOutcome<OpenWebUIResult>> => {
    const consume = context.webUiBootstrap?.consumeWebUIBootstrap;
    if (consume === undefined) {
      return failure(
        'WEBUI_UNAVAILABLE',
        'authenticated WebUI bootstrap is unavailable for this managed process',
      );
    }
    let callbackFailure = false;
    const outcome = await consume(context.environmentId, async (bootstrapUrl: string) => {
      try {
        await openExternal(bootstrapUrl);
      } catch (error) {
        callbackFailure = true;
        throw error;
      }
    });
    if (!outcome.ok) {
      return failure(outcome.code, outcome.message);
    }
    if (callbackFailure) {
      return failure('WEBUI_UNAVAILABLE', 'the authenticated WebUI could not be opened');
    }
    return portOk({ loopbackOrigin: context.loopbackOrigin });
  };
};
