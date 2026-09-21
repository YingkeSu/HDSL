# Renderer slice acceptance (`tests/acceptance/renderer`)

Independent black-box behavior QA for PR #34 (issue #30). Current baseline:
fix head `b9d47348251666e9eae1b9f30e888b4634e962ee` (reviewed
then-red `44e5b748ebd67e46319580162d3e91563bd22d28`). QA-only: this directory
does not modify `apps/desktop/src/renderer/**`, `tests/renderer/**` or root
config.

```bash
# 使用 .nvmrc 指定的 Node.js 和 packageManager 指定的 pnpm。
pnpm install --frozen-lockfile
pnpm exec vitest run tests/acceptance/renderer
```

## Files and results (23 passing on `b9d4734`)

- `controller.acceptance.test.ts` — drives the public `RendererController`
  with a controlled async `RendererContractClient` (deferred responses,
  failures, malformed envelopes).
  - 13 behavior scenarios pass: delayed load, selection preserved across a
    delayed refresh, repeated start clicks (distinct requestIds), create
    failure keeps the typed name, polling stops at terminal and refreshes,
    dispose releases subscription/timer/event source, non-loopback WebUI
    origin refused, loopback origin surfaced, version mismatch / malformed
    envelope fail closed, invalid outbound DTO rejected, pushed events
    monotonic + terminal, cancel freezes progress, client throw mapped to
    `INTERNAL_ERROR`.
  - R1–R4 (issue #36, reviewer hdsl-8 P2-1/P2-2/P3.1): **red on `44e5b74`,
    green on `b9d4734` with unchanged expectations** — stale cross-operation
    poll, post-dispose subscribe/state write, bounded poll retry, interleaved
    starts subscription residue.
  - R5–R6: bounded-retry pause + `retryTracking()` recovery to terminal; a
    subscribe that resolves after dispose is released and mutates no further
    state.
- `static-markup.acceptance.test.ts` — DOM-free **real React** render path
  (`renderAppView` -> `react-dom/server`): explicit empty state with no alert,
  failure state as `role="alert"`, native keyboard-operable controls
  (`button`/`label`/`select`/`progress`), and no invented percentage when
  progress is unknown.

## Static demo vs real React (scope boundary)

- `apps/desktop/src/renderer/demo/index.html` is a **self-contained vanilla
  mock**, not a React mount. A passing demo is **not** evidence for the React
  components or the controller.
- The real React entry `renderRenderer(container, client)` requires an
  explicitly injected `RendererContractClient`; T006b (Electron host / preload
  transport) is not wired, and this slice adds no browser bundle or DOM test
  dependency. **Interactive keyboard verification of the real React
  components is therefore NOT verifiable in this slice.** Only the DOM-free
  markup path above is exercised here.
- Browser observation (AO preview + `ao browser`, this session): the vanilla
  demo renders its initial state via JS and **keyboard activation works** when
  each action uses a fresh element ref: `空态` + Enter shows the empty state
  (`还没有环境…`), `加载失败` + Space shows the failure `role="alert"`, and
  typing a name then Enter in the textbox creates an environment. Note: refs
  are short-lived across re-renders — reusing a stale ref silently targets a
  different control, so take a fresh snapshot before each action. This
  verifies the demo only; the React components remain as described above.

## Untested / gaps

- Real Electron window, preload IPC transport, real DSH processes.
- Live keyboard interaction of the React components (no mount entry); only the
  DOM-free markup path is exercised here.
- The vanilla demo's progress/cancel/WebUI/export scenarios were not all
  re-run independently in this batch; empty/failure/keyboard-create were.

Defect consolidation: issue #36 (root cause P2-1/P2-2/P3.1).
