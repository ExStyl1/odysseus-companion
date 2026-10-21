/**
 * The splash overlay's lifecycle, as a pure phase machine.
 *
 * WHY THIS IS ITS OWN MODULE (regression, 2026-08-01): the splash used to leave
 * the screen by exactly one route — motion's `onAnimationComplete` on the exit
 * fade. That callback is driven by `requestAnimationFrame`, and a window that is
 * not being RENDERED has rAF suspended: hidden, minimized, or created with
 * `show: false` and still waiting for `ready-to-show`. In that state the
 * animation never advances, the callback never arrives, and the splash — a
 * `fixed inset-0` overlay with `pointer-events: auto` over an opaque background
 * — stays up forever with the whole app unreachable underneath it.
 *
 * Measured on the running app: with `appState === 'ready'`, `sessionsLoaded ===
 * true` and `splashExiting === true` (read off the React fiber), the overlay sat
 * at `opacity: 1` and inner `matrix(1.5, …)` — its INITIAL values, i.e. the
 * animation had not advanced by a single frame — while `document.visibilityState`
 * was `hidden` and rAF fired 0 times in 2 s. Reproduced deterministically by
 * suspending `requestAnimationFrame` over CDP before app scripts run: the splash
 * then stays mounted at opacity 1 indefinitely.
 *
 * So the exit gets a SECOND route: a deadline. `setTimeout` is throttled on a
 * non-rendered page (clamped to ~1s, and harder after five minutes) but it does
 * still FIRE, unlike rAF — that asymmetry is the whole reason the fallback
 * works. The animation callback remains the normal path; the deadline only ever
 * wins when the animation could not run.
 *
 * It is a pure module because the repo has no DOM/renderHook test lib (tests
 * render through `react-dom/server`), so effects and timers are untestable in
 * place. Everything that decides WHEN the splash goes away lives here, where a
 * test can drive it directly.
 */

/**
 * `visible` — splash up, app still booting.
 * `exiting`  — the app is ready; the fade-out is running (or would be).
 * `hidden`   — unmounted. Terminal: nothing puts the splash back.
 */
export type SplashPhase = 'visible' | 'exiting' | 'hidden'

/** The exit fade in `SplashScreen.tsx` (`transition={{ duration: 0.5 }}`). */
export const SPLASH_EXIT_ANIMATION_MS = 500

/**
 * How long to wait for the exit animation to report completion before
 * unmounting the splash anyway. Comfortably past the 500 ms fade — a rendering
 * window always reports first, so the deadline is invisible in normal use — and
 * short enough that a window which was NOT rendering is usable the moment it
 * comes back.
 */
export const SPLASH_EXIT_DEADLINE_MS = 1500

/**
 * `app-ready`               — readiness predicate flipped true.
 * `exit-animation-complete` — motion finished the fade (the normal route).
 * `exit-deadline`           — the fade did not report in time (the fallback).
 */
export type SplashSignal = 'app-ready' | 'exit-animation-complete' | 'exit-deadline'

/** Next phase for a signal. Unreachable transitions are identity, so a late or
 *  duplicated signal can never resurrect a dismissed splash. */
export function nextSplashPhase(phase: SplashPhase, signal: SplashSignal): SplashPhase {
  if (phase === 'hidden') return 'hidden'
  switch (signal) {
    case 'app-ready':
      return phase === 'visible' ? 'exiting' : phase
    case 'exit-animation-complete':
    case 'exit-deadline':
      // Both routes out of `exiting` end at the same place. `exit-animation-complete`
      // while still `visible` is not a thing motion can report, and if it ever
      // did, honouring it would tear the splash away mid-boot — so it is ignored.
      return phase === 'exiting' ? 'hidden' : phase
  }
}

/** Milliseconds to arm the fallback timer for, or `null` when no timer is
 *  needed. Only the `exiting` phase has a deadline: before it there is nothing
 *  to time out, after it the splash is already gone. */
export function splashExitDeadlineMs(phase: SplashPhase): number | null {
  return phase === 'exiting' ? SPLASH_EXIT_DEADLINE_MS : null
}

/** The splash element is mounted in every phase but the terminal one. */
export function isSplashMounted(phase: SplashPhase): boolean {
  return phase !== 'hidden'
}

/** The `isExiting` prop `SplashScreen` animates on. */
export function isSplashExiting(phase: SplashPhase): boolean {
  return phase === 'exiting'
}
