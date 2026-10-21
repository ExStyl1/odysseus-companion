/**
 * Was the RENDERER still there when this case stopped answering? — C3.389.
 *
 * ## The measurement this exists for
 *
 * RV, 2026-09-12, on the packaged 1.37.0 build, after RS-37's second run:
 * `/json/list` returned **0 page targets** while `pgrep` showed the main, GPU
 * and network processes alive and `[SchedulerService] TICK` kept firing on time.
 * Nothing in `~/Library/Logs/DiagnosticReports`, and **a packaged build writes
 * no application log** — so a renderer that disappeared under a live main
 * process left no trace anywhere. It did not recur across the lane's remaining
 * ten runs, which is exactly why an instrument matters more than a fix: the next
 * occurrence is the one that has to be readable.
 *
 * ## What this can and cannot see, stated so a null is not over-read
 *
 * The DevTools HTTP endpoint is served by the MAIN process, and the page targets
 * it lists are the renderer's. So the two answers separate cleanly:
 *
 *  - the endpoint answers and lists a page → the renderer is there;
 *  - the endpoint answers and lists NO page → the main process is alive and
 *    serving, and its renderer is gone. This is RV's reading, and it is the one
 *    the product itself cannot report;
 *  - the endpoint does not answer at all → **unreadable**, not "the app died".
 *    A quit app, a crashed main process and a port that was never opened are the
 *    same silence from here, and this module refuses to choose between them.
 *
 * It is deliberately NOT a `CdpSession` method: when the renderer is gone the
 * session's socket is dead, so the instrument has to live outside it and speak
 * over HTTP.
 *
 * ## Where it is wired
 *
 * `lib/report.ts` symbol `runCase` reads it whenever a case does not PASS, into
 * the `##CDP-RESULT##` line. One instrument, every case, no case edits — and the
 * reading arrives beside the failure it explains rather than in a rerun nobody
 * will take. The PRODUCT half of PR-RV-4 (a `render-process-gone` line into
 * `<config dir>/logs/boot.log`, which already exists for boot-fatal errors) is
 * `apps/electron/src/main`'s and is a proposed row, not this file.
 */

import { listTargets, resolvePort, type CdpTarget } from './connect.ts'

export type RendererHealth = 'healthy' | 'renderer-gone' | 'devtools-unreachable'

export interface RendererHealthReading {
  health: RendererHealth
  /** How many `type: "page"` targets the endpoint listed; `null` when it did not answer. */
  pageTargets: number | null
  /** Every target type the endpoint listed, counted — a renderer loss leaves the others standing. */
  targetTypes: Record<string, number>
  /** What the reading means, in the words the next reader needs. */
  note: string
  /** The port the reading was taken on — a null read on the wrong port is not a finding. */
  port?: string
}

/**
 * The pure half — a target list (or `null` for "nothing answered") to a reading.
 */
export function classifyRendererHealth(targets: readonly CdpTarget[] | null): RendererHealthReading {
  if (targets === null) {
    return {
      health: 'devtools-unreachable',
      pageTargets: null,
      targetTypes: {},
      note: 'nothing answered /json/list — UNREADABLE, not evidence the app died. A quit app, a crashed '
        + 'main process and a debugging port that was never opened are the same silence from here.',
    }
  }
  const targetTypes: Record<string, number> = {}
  for (const target of targets) targetTypes[target.type] = (targetTypes[target.type] ?? 0) + 1
  const pageTargets = targetTypes.page ?? 0
  if (pageTargets > 0) {
    return { health: 'healthy', pageTargets, targetTypes, note: 'the renderer is there' }
  }
  return {
    health: 'renderer-gone',
    pageTargets: 0,
    targetTypes,
    note: 'the DevTools endpoint ANSWERED and listed no page target — the main process is alive and serving '
      + 'while its renderer is gone. This is the loss a packaged build cannot report (it writes no '
      + 'application log), measured once by RV on 1.37.0; every check above it is void.',
  }
}

/** Read it over HTTP, because a lost renderer takes the CDP socket with it. */
export async function readRendererHealth(port?: string | number): Promise<RendererHealthReading> {
  let targets: CdpTarget[] | null = null
  try {
    targets = await listTargets(port)
  } catch {
    // Swallowed on purpose: `listTargets` throws one error for a refused
    // connection and another for a non-200, and neither distinguishes the three
    // causes `devtools-unreachable` names. The reading says so in words.
    targets = null
  }
  return { ...classifyRendererHealth(targets), port: resolvePort(port) }
}
