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
 * `frame-src` falls back to `'none'`. If a subframe cannot load at all, the
 * blocking layer is the **CSP**, and main's `senderFrame`/`isMainFrame`
 * rejection for a real subframe stays *unverified in the production window*
 * (it is only asserted at the pure-function boundary in
 * `desktop.findings.real.test.ts`). This file never disables the CSP, never
 * injects a fake sender, and never claims a production subframe called
 * high-privilege IPC when the frame never loaded.
 *
 * Two frame shapes are attempted:
 * - `srcdoc` (would inherit the parent origin, so it is inspectable if it
 *   loads): the primary probe;
 * - a `data:` URL (opaque origin, not inspectable by design): recorded as
 *   "loaded/opaque or CSP-blocked", never used to claim bridge inspection.
 *
 * The main frame's normal contract call is the running control before and after
 * the frame attempt. No new dependency, no production switch, no personal
 * browser/keychain, no DSH network install. Opt-in: `HDSL_E2E_IFRAME=1`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { appHarness, bootApp, cleanupAllHarnesses } from './support/app-harness.js';
import { callContract } from './support/desktop-ui.js';

const ENABLED = process.env['HDSL_E2E_IFRAME'] === '1';

interface FrameProbe {
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
  readonly dataUrl: string;
  readonly dataText: string;
}

describe.skipIf(!ENABLED)('desktop real-window iframe boundary', () => {
  afterEach(cleanupAllHarnesses);

  it('E2E-IFRAME-01: a production-window subframe cannot reach the launcher bridge; the blocking layer is recorded', async () => {
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
            dataUrl: dataFrame.contentDocument ? dataFrame.contentDocument.URL : '',
            dataText: dataFrame.contentDocument ? (dataFrame.contentDocument.body ? dataFrame.contentDocument.body.textContent || '' : '') : '',
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
          dataUrl: dataDoc ? dataDoc.URL : '',
          dataText: dataDoc && dataDoc.body ? (dataDoc.body.textContent || '') : '',
        };
      })()`,
      { awaitPromise: true },
    );

    const logText = cdp.consoleMessages().join('\n');
    const cspRefusal = /Content Security Policy|Refused to frame|frame-src|frame-ancestors/i.test(logText);

    // Record the actual layers before asserting anything.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        srcdocLoaded: probe.srcdocLoaded,
        srcdocUrl: probe.srcdocUrl,
        srcdocText: probe.srcdocText,
        dataFramePresent: probe.dataFramePresent,
        dataUrl: probe.dataUrl,
        dataText: probe.dataText,
        cspRefusal,
      }),
    );

    if (probe.srcdocLoaded) {
      // The frame executed a real document: the launcher bridge must be absent
      // and it must not be able to call the contract channel.
      const bridge = probe.srcdocBridge;
      expect(bridge).not.toBeNull();
      expect(bridge?.hasHdsl).toBe('undefined');
      expect(bridge?.hasRequire).toBe('undefined');
      expect(bridge?.hasProcess).toBe('undefined');
      expect(bridge?.hasIpcRenderer).toBe('undefined');
      expect(bridge?.callType).toBe('undefined');
    } else {
      // The srcdoc frame navigation did not produce a loaded document. Record
      // the layer: the CSP must refuse it observably; subframe IPC stays
      // uncovered in the production window.
      expect(cspRefusal, `expected an observable CSP refusal, log=${logText.slice(0, 400)}`).toBe(true);
    }

    // A data: frame must never expose the launcher bridge. If its document is
    // accessible it must be the blocked about:blank shell, not the frame's own
    // content and not a bridge-bearing document.
    if (probe.dataFramePresent) {
      expect(probe.dataText).not.toContain('qa-data');
      expect(probe.dataUrl).not.toContain('data:');
    }
    expect(cspRefusal).toBe(true);

    // The main frame is still the authorized, working context (control after).
    const controlAfter = await callContract(cdp, 'catalog.list', {});
    expect(controlAfter.ok).toBe(true);

    // Both frame elements exist in the DOM; the finding is about execution and
    // the bridge, not about element creation.
    const frames = await cdp.evaluate<number>("document.querySelectorAll('iframe').length");
    expect(frames).toBeGreaterThanOrEqual(2);
  }, 180_000);
});
