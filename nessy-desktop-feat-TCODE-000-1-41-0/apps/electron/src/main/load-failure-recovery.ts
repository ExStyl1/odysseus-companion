/**
 * UA12.144 — what a `did-fail-load` may do to the window it fired on.
 *
 * ## The measurement (SIT-C, 2026-10-04; SITC-F1)
 *
 * A CSP-blocked SUBFRAME navigation inside the renderer — a page iframe
 * submitting `form.action='https://…'` or assigning `location.href`, both
 * CSP-refused — fires `did-fail-load` with `isMainFrame: false`. The window
 * manager's handler never read that flag and answered EVERY failure by
 * navigating the window (`loadFile(renderer/index.html)`, or the dev-server
 * retry), which reloads the whole renderer: the WS client disconnects, all
 * renderer state is lost. Deterministic 3/3 on the packaged sitting rig, and
 * page content can loop it at will — one such reload destroyed RS-112's F
 * window and all three C readings mid-case. Crash-class containment, not an
 * egress leak (every probe port stayed silent).
 *
 * ## The policy
 *
 * The recovery exists for MAIN-frame load failures alone — the renderer shell
 * itself could not load (stale path, disk error; #13) — and both of its arms
 * navigate the window, so neither may run for a subframe failure. A failed
 * subframe load is left to Chromium: the frame shows its failure, and the
 * window keeps its state. This is the same gate the main process already
 * applies to its own `did-fail-load` handlers
 * (`browser-pane-manager.ts`: `if (!isMainFrame) return`), extracted here so
 * the decision is testable without a `BrowserWindow`.
 */

/** The dev-server retry cap the handler ran before UA12.144, kept verbatim. */
export const LOAD_FAILURE_DEV_SERVER_RETRIES = 5

export type LoadFailureDecision =
  /** A subframe failed: the window must be left alone (UA12.144). */
  | { action: 'leave-alone' }
  /** Dev: the Vite server may not be ready yet; retry it. */
  | { action: 'retry-dev-server' }
  /** The renderer shell must be reloaded from the packaged index.html. */
  | { action: 'load-fallback' }

/**
 * Decide the recovery for one `did-fail-load`. Pure on purpose: the handler
 * in `window-manager.ts` owns the window, the counter and the timing — this
 * owns only the choice, so "isMainFrame:false triggers no reload path" is a
 * unit test here rather than a sitting.
 */
export function decideLoadFailureRecovery(input: {
  isMainFrame: boolean
  /** `VITE_DEV_SERVER_URL` when the window runs from the dev server. */
  devServerUrl: string | undefined
  /** How many dev-server retries already ran for this window. */
  retriesSoFar: number
}): LoadFailureDecision {
  if (!input.isMainFrame) return { action: 'leave-alone' }
  if (input.devServerUrl && input.retriesSoFar < LOAD_FAILURE_DEV_SERVER_RETRIES) {
    return { action: 'retry-dev-server' }
  }
  return { action: 'load-fallback' }
}
