/**
 * Renderer entry (T006a).
 *
 * The renderer is mounted with an **explicitly injected** restricted client.
 * There is no default and no mock fallback: calling `renderRenderer` without a
 * client throws, so a production build can never silently render the developer
 * demo. The only mock client in this slice belongs to the static demo under
 * `demo/` and to `tests/renderer`.
 */
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import type { RendererContractClient } from './contract.js';
import {
  RendererController,
  type RendererControllerOptions,
  type RendererEventSource,
} from './controller.js';

export interface RendererEntryOptions {
  readonly demo?: boolean | undefined;
  readonly events?: RendererEventSource | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly createRequestId?: (() => string) | undefined;
  /** Notified with the opaque id whenever the selected environment changes. */
  readonly onSelectionChange?: ((environmentId: string) => void) | undefined;
}

/**
 * Builds a controller around the injected client. Kept separate from mounting so
 * tests and the dev harness can own the lifecycle.
 */
export function createRendererController(
  client: RendererContractClient,
  options: RendererEntryOptions = {},
): RendererController {
  if (client === undefined || client === null) {
    throw new Error(
      'createRendererController requires an explicit RendererContractClient; production must not fall back to a mock client.',
    );
  }
  return new RendererController({
    client,
    demo: options.demo ?? false,
    events: options.events,
    pollIntervalMs: options.pollIntervalMs,
    createRequestId: options.createRequestId,
  } satisfies RendererControllerOptions);
}

/**
 * Mounts the app into `container` and starts the initial load.
 *
 * Returns an async disposer that unmounts React and awaits every operation
 * subscription/timer being released, so tests and hand-off code can observe a
 * completed cleanup instead of a fire-and-forget promise.
 */
export function renderRenderer(
  container: Element,
  client: RendererContractClient,
  options: RendererEntryOptions = {},
): () => Promise<void> {
  const controller = createRendererController(client, options);
  const root = createRoot(container);
  root.render(<App controller={controller} />);
  let lastSelection = controller.getState().selectedEnvironmentId;
  const notifySelection = (): void => {
    const selection = controller.getState().selectedEnvironmentId;
    if (selection !== lastSelection) {
      lastSelection = selection;
      if (selection !== null) {
        options.onSelectionChange?.(selection);
      }
    }
  };
  const unsubscribeSelection = controller.subscribe(notifySelection);
  void controller.load();
  return async () => {
    unsubscribeSelection();
    root.unmount();
    await controller.dispose();
  };
}
