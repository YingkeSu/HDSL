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
}

/**
 * Builds a controller around the injected client. Kept separate from mounting so
 * tests and the dev harness can own the lifecycle.
 */
export function createRendererController(
  client: RendererContractClient,
  options: RendererEntryOptions = {},
): RendererController {
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
 * Returns a disposer that unmounts React and releases every operation
 * subscription/timer.
 */
export function renderRenderer(
  container: Element,
  client: RendererContractClient,
  options: RendererEntryOptions = {},
): () => void {
  if (client === undefined || client === null) {
    throw new Error(
      'renderRenderer requires an explicit RendererContractClient; production must not fall back to a mock client.',
    );
  }
  const controller = createRendererController(client, options);
  const root = createRoot(container);
  root.render(<App controller={controller} />);
  void controller.load();
  return () => {
    root.unmount();
    void controller.dispose();
  };
}
