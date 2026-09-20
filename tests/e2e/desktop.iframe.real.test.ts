/**
 * Real-window iframe boundary QA (T007 follow-up; Refs #7 / #6).
 *
 * Independent QA. This lane uses the **production** Electron window and
 * constructs a real `<iframe>` inside the real renderer page, then observes the
 * actual subframe execution context, launcher-bridge visibility and the layer
 * that rejects the frame.
 *
 * Layering is the point: the production renderer document ships
 * `Content-Security-Policy: default-src 'none'; ...` with no `frame-src`, so
 * `frame-src` falls back to `'none'`. `about:srcdoc` frames are still executed
 * by Chromium (they are not governed by `frame-src`), which is exactly why the
 * srcdoc probe matters: it shows a real executing subframe that still has no
 * launcher bridge. A `data:` frame navigation is refused by the CSP and lands
 * on the error document. Main's `senderFrame`/`isMainFrame` rejection for a
 * bridge-bearing subframe stays *unverified in the production window* (it is
 * only asserted at the pure-function boundary in
 * `desktop.findings.real.test.ts`), because the production preload is not
 * injected into subframes. This file never disables the CSP, never injects a
 * fake sender, and never claims a production subframe called high-privilege
 * IPC.
 *
 * The layer verdict is computed by an exported pure classifier that has its own
 * negative controls (see the always-on test at the bottom): a missing render or
 * a refusal that cannot be attributed to this data URL does not pass.
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
/** URL the refused data: navigation is left on in Chromium/Electron. */
export const REFUSED_FRAME_URL = 'chrome-error://chromewebdata/';
/** The data: document we ask the frame to navigate to (never rendered). */
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
  /** The data: frame shows the refused-navigation error document. */
  readonly dataRefused: boolean;
  /**
   * The refusal is attributable to *this* frame's own `data:` navigation: the
   * element carried the data: src, the resulting document is the error document,
   * and the data: document's own marker never appeared.
   */
  readonly cspAttributable: boolean;
}

const sameUrl = (left: string, right: string): boolean =>
  left.replace(/\/+$/, '') === right.replace(/\/+$/, '');

/**
 * Pure layer classifier. Each field must be justified by an observable fact, so
 * `about:blank` / no render / an unattributable refusal all fail (see
 * `E2E-IFRAME-02`). Attribution does not rely on a console message: it uses the
 * frame's own src attribute, the resulting document URL and the absence of the
 * blocked document's marker.
 */
export const classifyFrameLayers = (
  probe: FrameProbe,
  marker: string = SRCDOC_MARKER,
): FrameLayerVerdict => ({
  srcdocRendered:
    probe.srcdocLoaded && probe.srcdocUrl === 'about:srcdoc' && probe.srcdocText.includes(marker),
  dataRefused:
    probe.dataFramePresent &&
    sameUrl(probe.dataUrl, REFUSED_FRAME_URL) &&
    !probe.dataText.includes(DATA_FRAME_MARKER),
  cspAttributable:
    probe.dataFramePresent &&
    probe.dataSrc.startsWith(DATA_FRAME_SRC_PREFIX) &&
    sameUrl(probe.dataUrl, REFUSED_FRAME_URL) &&
    !probe.dataText.includes(DATA_FRAME_MARKER),
});

describe('desktop real-window iframe boundary', () => {
  // Always-on negative/positive controls for the pure classifier: a missing
  // render or an unattributable refusal must not pass.
  it('E2E-IFRAME-02: the layer classifier fails closed on no-render / no-attribution fixtures', () => {
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
    expect(noRender.dataRefused).toBe(false);
    expect(noRender.cspAttributable).toBe(false);

    // A srcdoc URL without the visible marker is not a render.
    const blankText = classifyFrameLayers({
      ...emptyProbe,
      srcdocLoaded: true,
      srcdocUrl: 'about:srcdoc',
      srcdocText: '',
    });
    expect(blankText.srcdocRendered).toBe(false);

    // The error document without this frame's data: src is not attribution.
    const unattributed = classifyFrameLayers({
      ...emptyProbe,
      dataSrc: 'about:blank',
      dataUrl: REFUSED_FRAME_URL,
    });
    expect(unattributed.cspAttributable).toBe(false);

    // A data: src that actually rendered its own marker is not a refusal.
    const rendered = classifyFrameLayers({
      ...emptyProbe,
      dataSrc: 'data:text/html;charset=utf-8,<html><body>qa-data</body></html>',
      dataUrl: 'about:blank',
      dataText: 'qa-data',
    });
    expect(rendered.dataRefused).toBe(false);
    expect(rendered.cspAttributable).toBe(false);

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
      dataUrl: REFUSED_FRAME_URL,
      dataText: '',
    });
    expect(positive.srcdocRendered).toBe(true);
    expect(positive.dataRefused).toBe(true);
    expect(positive.cspAttributable).toBe(true);
  });

  describe.skipIf(!ENABLED)('real Electron window', () => {
    afterEach(cleanupAllHarnesses);

    it('E2E-IFRAME-01: a production-window subframe cannot reach the launcher bridge; the layers are asserted', async () => {
      const harness = appHarness();
      const { cdp } = await bootApp(harness, 'iframe01');

      // Collect console/log entries so a CSP refusal is observable evidence.
      await cdp.send('Log.enable');
      await cdp.send('Runtime.enable');

      const controlBefore = await callContract(cdp, 'catalog.list', {});
      expect(controlBefore.ok).toBe(true);

      const csp = await cdp.evaluate<string>(
        "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content ?? ''",
      );
      expect(csp).toContain("default-src 'none'");
      // No frame-src: the effective frame policy is default-src 'none'.
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

      const logText = cdp.consoleMessages().join('\n');
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

      // H2: the data: frame navigation was refused by the CSP, with the error
      // document as the actual URL, and the refusal is attributable to it.
      expect(
        probe.dataFramePresent,
        `data frame document was not observable: ${JSON.stringify(probe)}`,
      ).toBe(true);
      expect(probe.dataUrl, `data frame URL: ${probe.dataUrl}`).toBe(REFUSED_FRAME_URL);
      expect(probe.dataText).not.toContain('qa-data');
      expect(verdict.dataRefused).toBe(true);
      // Attribution uses this frame's own src + resulting error document +
      // absence of the blocked document's marker; the captured CSP meta warning
      // is recorded for context only.
      expect(verdict.cspAttributable, `probe=${JSON.stringify(probe)} cspLog=${logText.slice(0, 300)}`).toBe(true);

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
