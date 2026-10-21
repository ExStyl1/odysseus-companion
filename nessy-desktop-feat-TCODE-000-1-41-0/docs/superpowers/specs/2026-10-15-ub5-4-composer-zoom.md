# UB5.4 result (PARTIAL — the CDP reading is owed to the END sitting wave) — composer at 150–200 % zoom: premise, upstream take-shape and the ready drive

Row: `UB5.4 `[renderer]` `[measure]`` of `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`
(H12). Prepared 2026-10-15 by lane L-P57a; the reading itself is the sitting ASK (below).

## Status and why

The row's named instrument is the CDP harness against the running app. Per the dispatch's sitting-wave
policy (drives run in the END sitting wave), this lane does not launch the app: `electron:dev` builds
bundles in the shared tree mid-wave (the CDP README itself refuses to trust a run on a stale/mixed build),
and a CDP reading taken now would measure other lanes' uncommitted renderer edits. What this file records:
the premise read, the upstream take-shape, the decision rule written BEFORE the reading, and a ready-to-run
drive (`work/l-p57a/ub5-4/cdp-drive.ts`) that turns the sitting drive into minutes.

## Premise read (our composer height, at HEAD)

- `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx:677`:
  `const [inputMaxHeight, setInputMaxHeight] = React.useState(540)`.
- `FreeFormInput.tsx:709-718`: `maxFromWindow = Math.floor(window.innerHeight * 0.66)`;
  `setInputMaxHeight(Math.min(maxFromWindow, 540))` on mount + window `resize`. The clamp is 66 % of
  `window.innerHeight` with a fixed 540 px cap, applied at `FreeFormInput.tsx:2450`
  (`style={{ maxHeight: inputMaxHeight }}`).
- Zoom is applied by the MAIN process: `webContents.setZoomFactor` (`apps/electron/src/main/handlers/system.ts:353-375`,
  `window-manager.ts:510`), stepped ±0.1 via the app's own RPC `menu.ZOOM_IN/OUT/RESET`, exposed to the
  renderer as `window.electronAPI.menuZoomIn/menuZoomOut/menuZoomReset`
  (`apps/electron/src/transport/channel-map.ts:473`; `DesktopAppMenu.tsx:46`), persisted in shared config
  and re-applied per window (`window-manager.ts:510`). Electron `^39.2.7`.

## The crux the measurement decides (written before the reading)

The clamp's correctness at zoom depends on WHICH semantics Electron 39's `setZoomFactor` has:

- **Layout-zoom semantics:** `window.innerHeight` (CSS px) SHRINKS as the factor grows (fewer CSS px fit
  the same physical window). Then `66 % · innerHeight` tracks the visible area and our clamp holds at any
  zoom — no overflow, nothing taken, F1.856-style record.
- **CSS-zoom semantics** (Chromium's newer browser-zoom implementation; upstream's module exists because
  of it): `window.innerHeight` stays in UNZOOMED px while every component renders in zoomed component px —
  `getRootCssZoom()` in upstream's module reads `getComputedStyle(document.documentElement).zoom` precisely
  because their zoom is CSS zoom and does NOT move `innerHeight`. Under this semantics our 540 px cap at
  200 % renders 1080 physical px in a 600 px window — the composer leaves the visible area BY CONSTRUCTION.

Which world we are in is decided by ONE observable the drive records at every arm: `window.innerHeight`
and `visualViewport.height` at zoom 1 vs 2 (zoom-invariant ⇒ CSS-zoom ⇒ overflow expected). The row's
rect-vs-viewport reading then measures the actual composer.

## Upstream take-shape (v0.15.1) — taken ONLY if an arm shows overflow

- NEW `apps/electron/src/renderer/lib/input-viewport.ts`: `getViewportRect` (VisualViewport dimensions —
  "VisualViewport and DOMRects share layout CSS pixels… never multiply/divide its dimensions by `scale` a
  second time"), `getRootCssZoom()`, `getInputAvailableHeight` (intersect physical bounds, convert once,
  reserve local UI space), `measureInputAvailableHeight` (stable panel bound
  `[data-focus-zone="chat"], [data-composer-bounds], #root`, minus badges/zone padding + a 16 px
  transcript gap), `subscribeViewportChanges` (resize/orientationchange + visualViewport resize/scroll).
- NEW `apps/electron/src/renderer/hooks/useInputAvailableHeight.ts`: rAF-coalesced measurement with a
  ResizeObserver on the stable bounds and the input zone.
- NEW `apps/electron/src/renderer/components/app-shell/input/composer-height.ts`:
  `getComposerMaxHeight(available, mode)` = freeform `min(584, ⌊0.66·available⌋)`, structured via
  `getStructuredInputMaxHeight` (`structured-height.ts`).
- Consumption: `FreeFormInput.tsx:614-615,1568` (`composerMaxHeight = maxHeight ?? getComposerMaxHeight(
  useInputAvailableHeight(containerRef), 'freeform')`), `InputContainer.tsx:10` (structured mode),
  `lib/scroll-focused-caret.ts:1` (caret scroll after zoom changes), tests
  `lib/__tests__/input-viewport.test.ts`. The row's Files list if taken: those modules, ported with the
  rebrand rules; the selectors `[data-focus-zone="chat"]`/`[data-composer-bounds]` must exist in OUR shell
  or be added by the take row.

## Decision rule (written before the reading, per the measure-row rule)

Take upstream's `input-viewport`/`composer-height` **IFF** an arm at 150 % or 200 % in 900 × 600 reads the
composer's `getBoundingClientRect().bottom` outside the visible area (`visualViewport.offsetTop +
height`), with BOTH controls green: (a) 100 % in 1400 × 900 reads inside (else the instrument is blind),
and (b) the oversized-maxHeight detection control (textarea `style.maxHeight = '2000px'` — the DOM-level
equivalent of the row's "deliberately oversized `inputMaxHeight` in a scratch build"; a scratch build is
the sitting lane's option if it prefers the build-level form) reads OUTSIDE (else the metric cannot see
overflow). A boundary arm or an all-inside reading → record and take nothing (F1.856-style).

## The sitting ASK

Drive: `NESSY_CDP_PORT` app up (packaged, env -u launcher), then
`NESSY_CDP_PORT=9223 bun work/l-p57a/ub5-4/cdp-drive.ts` with the window at 900 × 600 (resize via the
launcher flags or OS scripting before arm 1; `Browser.setWindowBounds` on the window target is the
in-drive option). Arms: 100 % baseline → ×5 `menuZoomIn` (150 %) → ×10 (200 %) → reset + 1400 × 900
control → maxHeight-2000 detection control. The script prints every reading, the verdict inputs and the
crux observable; paste its output into this file and close the row on the rule above.

## Residues

- webui is dormant (D(c)) — Electron only, as the row says.
- The draft is pasted, not typed (the harness's own paste path — `lib/composer.ts pasteIntoComposer`),
  so the composer's auto-growth path is exercised without key-event timing.
- The 540 px cap means the fixed-cap arm only bites above ~818 px innerHeight; at 200 % zoom under
  CSS-zoom semantics the overflow (if any) comes from the CAP, not the 66 % term — the drive's crux
  observable distinguishes which term is at fault.
