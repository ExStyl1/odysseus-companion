/**
 * The last few steps of `before-quit`, kept where they can be tested.
 *
 * `before-quit` calls `event.preventDefault()` and then runs a long cleanup
 * chain — flush sessions, dispose the storage runtime and the dp broker,
 * destroy browser panes, stop model refresh, release the power blocker, release
 * the server lock — before finally telling the app to go. Two things about that
 * shape went wrong upstream, and both apply here:
 *
 *   * **Cleanup can eat the quit.** Only the session flush was guarded. A throw
 *     anywhere after it aborted the handler, so neither `app.quit()` nor
 *     `app.exit(0)` was ever reached: the app sat half-shut-down and, if an
 *     update was mid-handoff, it stayed *downloaded but never installed*.
 *     (Upstream v0.11.3: updates ended "downloaded-but-never-installed because
 *     quit cleanup interrupted the installer handoff".)
 *   * **A handoff that fails leaves nothing behind.** During an update we hand
 *     to electron-updater and return. If that never completes, the process
 *     lingers with its storage already disposed — no window, no server, no way
 *     forward. (Upstream: "a failed final handoff now restarts the app cleanly
 *     instead of continuing half-shut-down".)
 *
 * The quit is therefore unconditional, and the update path arms a fallback.
 */

/** How long to give electron-updater before treating the handoff as failed. */
export const UPDATE_HANDOFF_GRACE_MS = 15_000

export interface QuitFinalizerHost {
  /** Defer to electron-updater's own quit sequence. */
  quit: () => void
  /** Exit immediately. Not used on the update path — it breaks the NSIS installer. */
  exit: (code: number) => void
  /** Queue this process to start again after it exits. */
  relaunch: () => void
  /** `setTimeout`, injected so a test does not wait fifteen seconds. */
  schedule: (fn: () => void, ms: number) => { unref?: () => void }
  log: (message: string, detail?: unknown) => void
}

export interface QuitFinalizerInput {
  /** True when electron-updater owns the shutdown. */
  isUpdating: boolean
  /** What cleanup threw, if anything. The quit happens either way. */
  cleanupError?: unknown
}

/**
 * Finish the quit, whatever happened before it.
 *
 * Returns what it did, so the caller — and the test — can tell the two paths
 * apart without reading logs.
 */
export function finalizeQuit(
  input: QuitFinalizerInput,
  host: QuitFinalizerHost,
): 'updater-handoff' | 'exit' {
  if (input.cleanupError !== undefined) {
    // Reported, never rethrown: a failure to tidy up must not become a failure
    // to quit. This is the line that turns "the update silently never
    // installed" back into "the update installed, and we know cleanup failed".
    host.log('quit cleanup failed; quitting anyway', input.cleanupError)
  }

  if (!input.isUpdating) {
    host.exit(0)
    return 'exit'
  }

  host.log('update in progress, letting electron-updater handle quit')
  host.quit()

  // The fallback. If electron-updater had taken over, this process would be
  // gone well before the timer fires; a timer that DOES fire means the handoff
  // did not happen, and the app is sitting there disposed. Relaunch rather than
  // linger, so the user gets a working app back and the update can be retried.
  const timer = host.schedule(() => {
    host.log('update handoff did not complete; relaunching instead of lingering half-shut-down')
    host.relaunch()
    host.exit(0)
  }, UPDATE_HANDOFF_GRACE_MS)
  // Never hold the event loop open on the fallback's account — if everything
  // else has finished, the process should be free to end on its own.
  timer.unref?.()

  return 'updater-handoff'
}
