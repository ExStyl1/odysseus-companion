/**
 * The splash always leaves the screen (regression, 2026-08-01).
 *
 * The shipped defect: `App.tsx` unmounted the splash from exactly one place —
 * motion's `onAnimationComplete` on the exit fade. That callback is driven by
 * `requestAnimationFrame`, and a window that is not being RENDERED has rAF
 * suspended (hidden, minimized, or `show: false` still waiting for
 * `ready-to-show`). The fade never advanced a frame, the callback never came,
 * and the splash — `fixed inset-0`, `pointer-events: auto`, opaque background —
 * stayed up with the entire app unreachable underneath it.
 *
 * WHAT A TEST HERE CAN AND CANNOT DO. It cannot boot Electron, and it cannot
 * even mount `App`: this repo has no DOM or renderHook test library, so renderer
 * tests go through `react-dom/server` and never run an effect or a timer. The
 * live failure is therefore NOT reachable from `bun test`, and the honest
 * statement is that no unit test would have caught the original bug as a bug.
 *
 * What IS pinnable is the seam the fix introduced, and it is the seam that was
 * missing: a SECOND route out of `exiting` that does not depend on the animation
 * reporting anything. These arms drive that machine directly —
 *
 *   1. the deadline route exists and ends at `hidden` with no animation callback
 *      (the arm that goes red if the fallback is removed),
 *   2. the deadline is armed exactly while `exiting` — never before, never after,
 *      so it can neither tear the splash away mid-boot nor leak a timer,
 *   3. the animation route still wins in normal use and `hidden` is terminal.
 *
 * — plus a wiring arm that reads `App.tsx`, because a perfectly correct module
 * that the app has stopped calling is precisely how this regression comes back.
 * (The same shape `source-card.test.tsx` uses for panels bun cannot render.)
 *
 * Mutation probe, run 2026-08-01: make `nextSplashPhase` ignore `exit-deadline`
 * (return `phase` for that case). Arms 1 and the deadline half of 3 go red;
 * everything else stays green. Reported in the task.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SPLASH_EXIT_ANIMATION_MS,
  SPLASH_EXIT_DEADLINE_MS,
  isSplashExiting,
  isSplashMounted,
  nextSplashPhase,
  splashExitDeadlineMs,
  type SplashPhase,
} from '../splash-lifecycle'

const APP_TSX = join(import.meta.dir, '..', '..', 'App.tsx')

describe('splash lifecycle', () => {
  describe('the deadline route (the regression)', () => {
    it('unmounts the splash without the exit animation ever reporting', () => {
      // Exactly the measured state: ready, exiting, and no animation frame will
      // ever run, so `exit-animation-complete` is never delivered.
      const exiting = nextSplashPhase('visible', 'app-ready')
      expect(exiting).toBe('exiting')

      expect(nextSplashPhase(exiting, 'exit-deadline')).toBe('hidden')
      expect(isSplashMounted(nextSplashPhase(exiting, 'exit-deadline'))).toBe(false)
    })

    it('arms the deadline only while the exit is in flight', () => {
      expect(splashExitDeadlineMs('visible')).toBeNull()
      expect(splashExitDeadlineMs('exiting')).toBe(SPLASH_EXIT_DEADLINE_MS)
      expect(splashExitDeadlineMs('hidden')).toBeNull()
    })

    it('gives the animation more than its own duration to report first', () => {
      // A rendering window always reports before the deadline, so the fallback
      // is invisible in normal use rather than a second way to cut the fade off.
      expect(SPLASH_EXIT_DEADLINE_MS).toBeGreaterThan(SPLASH_EXIT_ANIMATION_MS)
    })
  })

  describe('the animation route still governs a rendering window', () => {
    it('boots visible, exits on ready, hides on the animation callback', () => {
      let phase: SplashPhase = 'visible'
      expect(isSplashMounted(phase)).toBe(true)
      expect(isSplashExiting(phase)).toBe(false)

      phase = nextSplashPhase(phase, 'app-ready')
      expect(phase).toBe('exiting')
      expect(isSplashMounted(phase)).toBe(true)
      expect(isSplashExiting(phase)).toBe(true)

      phase = nextSplashPhase(phase, 'exit-animation-complete')
      expect(phase).toBe('hidden')
      expect(isSplashMounted(phase)).toBe(false)
    })

    it('never resurrects a dismissed splash, whichever route dismissed it', () => {
      for (const signal of ['app-ready', 'exit-animation-complete', 'exit-deadline'] as const) {
        expect(nextSplashPhase('hidden', signal)).toBe('hidden')
      }
      // A repeated app-ready (the effect re-running) must not restart anything.
      expect(nextSplashPhase('exiting', 'app-ready')).toBe('exiting')
    })

    it('ignores an exit completion that arrives before the app is ready', () => {
      expect(nextSplashPhase('visible', 'exit-animation-complete')).toBe('visible')
      expect(nextSplashPhase('visible', 'exit-deadline')).toBe('visible')
    })
  })

  describe('App.tsx wiring', () => {
    // The module above is only worth anything if App.tsx routes through it. This
    // arm is the substitute for mounting App, which this repo cannot do.
    const source = readFileSync(APP_TSX, 'utf8')

    it('drives the splash from this module and arms the deadline timer', () => {
      expect(source).toContain("from '@/lib/splash-lifecycle'")
      expect(source).toContain('splashExitDeadlineMs(splashPhase)')
      expect(source).toContain("nextSplashPhase(phase, 'exit-deadline')")
      expect(source).toContain("nextSplashPhase(phase, 'exit-animation-complete')")
      expect(source).toContain('isSplashMounted(splashPhase)')
    })

    it('keeps no second, un-deadlined splash flag of its own', () => {
      // The pre-fix shape: `splashHidden` written only from onExitComplete.
      expect(source).not.toContain('setSplashHidden')
      expect(source).not.toContain('setSplashExiting')
    })
  })
})
