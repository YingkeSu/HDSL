/**
 * Real-window iframe boundary QA (T007 follow-up; Refs #7 / #6).
 *
 * Independent QA. This lane uses the **production** Electron window and
 * constructs a real `<iframe>` inside the real renderer page, then observes the
 * actual subframe execution context, launcher-bridge visibility and what happens
 * to that frame's own `data:` navigation.
 *
 * What is observed at runtime:
 * - an `about:srcdoc` subframe **really executes** its own document (URL plus
 *   visible marker) and still has **no launcher bridge** (`window.hdsl`,
 *   `require`, `process`, `ipcRenderer`, `hdsl.call` all undefined), because the
 *   production preload is not injected into subframes;
 * - that frame's own `data:` navigation **fails**: the frame ends on the error
 *   document and the blocked document's marker never appears. This is stated as
 *   the observed fact (the navigation was rejected), attributed to this frame's
 *   own `data:` `src`; it does **not** claim a unique cause.
 *
 * Static configuration is reported separately, not as dynamic evidence: the
 * production renderer document ships a CSP meta with `default-src 'none'` and no
 * `frame-src`. That configuration is listed as a configuration fact; this lane
 * does not claim "the CSP layer was dynamically verified", and it never disables
 * the CSP or injects a fake sender.
 *
 * Main's `senderFrame`/`isMainFrame` rejection for a bridge-bearing subframe
 * stays *uncovered in the production window* (only the pure-function assertion
 * in `desktop.findings.real.test.ts` exists), because the production preload is
 * not injected into subframes.
 *
 * The layer verdict is computed by an exported pure classifier with its own
 * negative controls (always-on test below): a missing render, a non-`data:`
 * frame, or a `data:` document that actually rendered its own marker all fail.
 *
 * No new dependency, no production switch, no personal browser/keychain, no DSH
 * network install. Opt-in with `HDSL_E2E_IFRAME=1`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { appHarness, bootApp, cleanupAllHarnesses } from './support/app-harness.js';
import { callContract } from './support/desktop-ui.js';

const ENABLED = process.env['HDSL_E2E_IFRAME'] === '1';

/** Visible marker rendered by the srcdoc frame; used to prove real rendering. */
export const SRCDOC_MARKER = 'qa-frame';
/** URL the rejected data: navigation is left on (Chromium/Electron error doc). */
export const REJECTED_FRAME_URL = 'chrome-error://chromewebdata/';
/** Prefix of the data: document we ask the frame to navigate to. */
export const DATA_FRAME_SRC_PREFIX = 'data:text/html';
/** Visible marker the data: document would show if it had rendered. */
export const DATA_FRAME_MARKER = 'qa-data';

export interface FrameProbe {
  readonly srcdocLoaded: boolean;
  readonly srcdocContentWindow: boolean;
  readonly srcdocUrl: string;
  readonly srcdocText: string;
  readonly srcdocBridge: {
    readonly hasHdsl: string;
    readonly hasRequire: string;
    readonly hasProcess: string;
    readonly hasIpcRenderer: string;
    readonly callType: string;
    readonly text: string;
  } | null;
  readonly dataFramePresent: boolean;
  /** The `src` attribute actually set on the data frame. */
  readonly dataSrc: string;
  readonly dataUrl: string;
  readonly dataText: string;
}

export interface FrameLayerVerdict {
  /** The srcdoc frame really rendered its own document (URL + visible marker). */
  readonly srcdocRendered: boolean;
  /** This frame's own `data:` navigation did not produce the requested document. */
  readonly dataNavigationRejected: boolean;
}

const sameUrl = (left: string, right: string): boolean =>
  left.replace(/\/+$/, '') === right.replace(/\/+$/, '');

/**
 * Pure layer classifier. Each field must be justified by an observable fact, so
 * `about:blank` / no render / a non-`data:` frame / a `data:` document that
 * really rendered all fail (see `E2E-IFRAME-02`). The name says what was
 * observed (this frame's navigation was rejected); it does not assert a unique
 * cause.
 */
export const classifyFrameLayers = (
  probe: FrameProbe,
  marker: string = SRCDOC_MARKER,
): FrameLayerVerdict => ({
  srcdocRendered:
    probe.srcdocLoaded && probe.srcdocUrl === 'about:srcdoc' && probe.srcdocText.includes(marker),
  dataNavigationRejected:
    probe.dataFramePresent &&
    probe.dataSrc.startsWith(DATA_FRAME_SRC_PREFIX) &&
    sameUrl(probe.dataUrl, REJECTED_FRAME_URL) &&
    !probe.dataText.includes(DATA_FRAME_MARKER),
});

describe('desktop real-window iframe boundary', () => {
  // Always-on negative/positive controls for the pure classifier: a missing
  // render, a non-data: frame or a rendered data: document must not pass.
  it('E2E-IFRAME-02: the layer classifier fails closed on no-render / non-data / rendered-data fixtures', () => {
    const emptyProbe: FrameProbe = {
      srcdocLoaded: false,
      srcdocContentWindow: true,
      srcdocUrl: 'about:blank',
      srcdocText: '',
      srcdocBridge: null,
      dataFramePresent: true,
      dataSrc: '',
      dataUrl: 'about:blank',
      dataText: '',
    };
    const noRender = classifyFrameLayers(emptyProbe);
    expect(noRender.srcdocRendered).toBe(false);
    expect(noRender.dataNavigationRejected).toBe(false);

    // A srcdoc URL without the visible marker is not a render.
    const blankText = classifyFrameLayers({
      ...emptyProbe,
      srcdocLoaded: true,
      srcdocUrl: 'about:srcdoc',
      srcdocText: '',
    });
    expect(blankText.srcdocRendered).toBe(false);

    // The error document without this frame's data: src is not attribution.
    const notDataSrc = classifyFrameLayers({
      ...emptyProbe,
      dataSrc: 'about:blank',
      dataUrl: REJECTED_FRAME_URL,
    });
    expect(notDataSrc.dataNavigationRejected).toBe(false);

    // A data: src that actually rendered its own marker is not a rejection.
    const rendered = classifyFrameLayers({
      ...emptyProbe,
      dataSrc: 'data:text/html;charset=utf-8,<html><body>qa-data</body></html>',
      dataUrl: 'about:blank',
      dataText: 'qa-data',
    });
    expect(rendered.dataNavigationRejected).toBe(false);

    // A frame with no observable document cannot be attributed.
    const noDocument = classifyFrameLayers({ ...emptyProbe, dataFramePresent: false });
    expect(noDocument.dataNavigationRejected).toBe(false);

    // Positive fixture: both layers justified.
    const positive = classifyFrameLayers({
      srcdocLoaded: true,
      srcdocContentWindow: true,
      srcdocUrl: 'about:srcdoc',
      srcdocText: 'qa-frame',
      srcdocBridge: {
        hasHdsl: 'undefined',
        hasRequire: 'undefined',
        hasProcess: 'undefined',
        hasIpcRenderer: 'undefined',
        callType: 'undefined',
        text: 'qa-frame',
      },
      dataFramePresent: true,
      dataSrc: 'data:text/html;charset=utf-8,<html><body>qa-data</body></html>',
      dataUrl: REJECTED_FRAME_URL,
      dataText: '',
    });
    expect(positive.srcdocRendered).toBe(true);
    expect(positive.dataNavigationRejected).toBe(true);
  });

  describe.skipIf(!ENABLED)('real Electron window', () => {
    afterEach(cleanupAllHarnesses);

    it('E2E-IFRAME-01: a production-window subframe cannot reach the launcher bridge, and its data: navigation is rejected', async () => {
      const harness = appHarness();
      const { cdp } = await bootApp(harness, 'iframe01');

      const controlBefore = await callContract(cdp, 'catalog.list', {});
      expect(controlBefore.ok).toBe(true);

      // Static configuration fact, recorded separately from the runtime
      // observation (not claimed as dynamic CSP-layer verification).
      const csp = await cdp.evaluate<string>(
        "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content ?? ''",
      );
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('frame-src');

      const probe = await cdp.evaluate<FrameProbe>(
        `(async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const srcdocFrame = document.createElement('iframe');
          srcdocFrame.id = 'qa-frame-srcdoc';
          srcdocFrame.srcdoc = '<html><body id="inner">qa-frame</body></html>';
          document.body.appendChild(srcdocFrame);
          const dataFrame = document.createElement('iframe');
          dataFrame.id = 'qa-frame-data';
          dataFrame.src = 'data:text/html;charset=utf-8,<html><body>qa-data</body></html>';
          document.body.appendChild(dataFrame);
          await sleep(1500);
          const srcdocDoc = srcdocFrame.contentDocument;
          if (srcdocDoc === null) {
            return {
              srcdocLoaded: false,
              srcdocContentWindow: srcdocFrame.contentWindow !== null,
              srcdocUrl: '',
              srcdocText: '',
              srcdocBridge: null,
              dataFramePresent: dataFrame.contentDocument !== null,
              dataSrc: dataFrame.getAttribute('src') || '',
              dataUrl: dataFrame.contentDocument ? dataFrame.contentDocument.URL : '',
              dataText: dataFrame.contentDocument && dataFrame.contentDocument.body ? (dataFrame.contentDocument.body.textContent || '') : '',
            };
          }
          const win = srcdocFrame.contentWindow;
          const dataDoc = dataFrame.contentDocument;
          return {
            srcdocLoaded: true,
            srcdocContentWindow: win !== null,
            srcdocUrl: srcdocDoc.URL,
            srcdocText: (srcdocDoc.body && srcdocDoc.body.textContent) || '',
            srcdocBridge: {
              hasHdsl: typeof win.hdsl,
              hasRequire: typeof win.require,
              hasProcess: typeof win.process,
              hasIpcRenderer: typeof win.ipcRenderer,
              callType: typeof (win.hdsl && win.hdsl.call),
              text: (srcdocDoc.body && srcdocDoc.body.textContent) || '',
            },
            dataFramePresent: dataDoc !== null,
            dataSrc: dataFrame.getAttribute('src') || '',
            dataUrl: dataDoc ? dataDoc.URL : '',
            dataText: dataDoc && dataDoc.body ? (dataDoc.body.textContent || '') : '',
          };
        })()`,
        { awaitPromise: true },
      );

      const verdict = classifyFrameLayers(probe);

      // Record the observed layers (no secrets involved).
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          srcdocLoaded: probe.srcdocLoaded,
          srcdocUrl: probe.srcdocUrl,
          srcdocText: probe.srcdocText,
          dataFramePresent: probe.dataFramePresent,
          dataSrc: probe.dataSrc,
          dataUrl: probe.dataUrl,
          dataText: probe.dataText,
          verdict,
        }),
      );

      // H1: the srcdoc subframe really executed its own document...
      expect(probe.srcdocLoaded, `srcdoc frame did not execute: ${JSON.stringify(probe)}`).toBe(true);
      expect(probe.srcdocUrl).toBe('about:srcdoc');
      expect(probe.srcdocText).toContain(SRCDOC_MARKER);
      expect(verdict.srcdocRendered).toBe(true);
      // ...and it carries no launcher bridge and cannot call the contract channel.
      const bridge = probe.srcdocBridge;
      expect(bridge).not.toBeNull();
      expect(bridge?.hasHdsl).toBe('undefined');
      expect(bridge?.hasRequire).toBe('undefined');
      expect(bridge?.hasProcess).toBe('undefined');
      expect(bridge?.hasIpcRenderer).toBe('undefined');
      expect(bridge?.callType).toBe('undefined');

      // H2: that frame's own data: navigation did not produce the requested
      // document; attribution uses the frame's src and the resulting document.
      expect(
        probe.dataFramePresent,
        `data frame document was not observable: ${JSON.stringify(probe)}`,
      ).toBe(true);
      expect(probe.dataUrl, `data frame URL: ${probe.dataUrl}`).toBe(REJECTED_FRAME_URL);
      expect(probe.dataText).not.toContain(DATA_FRAME_MARKER);
      expect(verdict.dataNavigationRejected, `probe=${JSON.stringify(probe)}`).toBe(true);

      // The main frame is still the authorized, working context (control after).
      const controlAfter = await callContract(cdp, 'catalog.list', {});
      expect(controlAfter.ok).toBe(true);

      // Both frame elements exist in the DOM; the finding is about execution and
      // the bridge, not about element creation.
      const frames = await cdp.evaluate<number>("document.querySelectorAll('iframe').length");
      expect(frames).toBeGreaterThanOrEqual(2);
    }, 180_000);
  });
});
