/**
 * F1.546 (origin WJ-au P-WJau-2) — a real-server suite's clock has TWO phases,
 * and the first one is not the suite's to judge.
 *
 * Every real-server suite spawns `index.ts` and then waits for its answers. The
 * suites below this helper started ONE timer at SPAWN, so it covered the child's
 * BOOT (loading the whole module graph) and the answers the suite is actually
 * about. On 2026-09-24 a bare `index.ts` boot had not answered `ready` after
 * 600 s at ~1.4 s of cpu (the main thread sampled in `openat`, one `cat` of a
 * small file 0.36 s with an endpoint-security scanner active) — so a 120 s
 * answer budget expired inside the boot, and the red read as the behaviour under
 * test failing when nothing had been asked yet (AGENTS.md: a timeout with zero
 * assertion failures has more than one cause).
 *
 * The clock therefore starts at spawn with a BOOT budget, and at the child's
 * first `ready` it swaps to the suite's own ANSWER budget. The boot budget is the
 * one `ephemeral-query-routing-real-server.test.ts` measured and chose (F1.303,
 * `b23e9e4d7`), whose inline clock F1.607 folded into this one. On a quiet rig the
 * boot takes seconds and nothing here slows a green run; only a red one waits
 * longer before it says which phase it was in.
 */

/** How long the child may take to answer its FIRST `ready`. See the module docblock for the measurement. */
export const REAL_SERVER_BOOT_WAIT_MS = 900_000

/** Teardown allowance on top of boot + answers (shutdown, stub close, temp dirs). */
const TEARDOWN_MS = 60_000

/** A bun per-test budget that holds the whole two-phase clock: boot, then answers, then teardown. */
export function realServerTestBudget(answerWaitMs: number, bootWaitMs = REAL_SERVER_BOOT_WAIT_MS): number {
  return bootWaitMs + answerWaitMs + TEARDOWN_MS
}

export type RealServerClockPhase = 'boot' | 'answer'

export interface RealServerClock {
  /** Call on EVERY `ready` the child sends; only the first one moves the clock to the answer phase. */
  ready(): void
  /** Stop both phases (the run settled, or the caller rejected on its own). Idempotent. */
  clear(): void
  /** Which phase the clock is in now. */
  readonly phase: RealServerClockPhase
}

/**
 * Arm the two-phase clock. `onExpire` is called at most once, with the phase that
 * ran out and a sentence naming it — the caller appends its own evidence (stderr).
 */
export function startRealServerClock(options: {
  answerWaitMs: number
  onExpire: (phase: RealServerClockPhase, message: string) => void
  bootWaitMs?: number
}): RealServerClock {
  const bootWaitMs = options.bootWaitMs ?? REAL_SERVER_BOOT_WAIT_MS
  let phase: RealServerClockPhase = 'boot'
  let done = false
  // Unref'd: a clock a caller forgot to clear on an error path must not hold the test process open.
  let timer: ReturnType<typeof setTimeout> | undefined = unref(setTimeout(() => expire('boot'), bootWaitMs))
  function expire(which: RealServerClockPhase): void {
    if (done) return
    done = true
    timer = undefined
    options.onExpire(which, which === 'boot'
      ? `real server: no ready within ${bootWaitMs} ms of spawn (the boot, not the behaviour under test)`
      : `real server: no answer within ${options.answerWaitMs} ms of its first ready`)
  }
  return {
    ready() {
      if (done || phase === 'answer') return
      phase = 'answer'
      clearTimeout(timer)
      timer = unref(setTimeout(() => expire('answer'), options.answerWaitMs))
    },
    clear() {
      done = true
      clearTimeout(timer)
      timer = undefined
    },
    get phase() {
      return phase
    },
  }
}

function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}
