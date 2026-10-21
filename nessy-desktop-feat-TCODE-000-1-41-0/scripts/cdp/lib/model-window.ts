/**
 * The placeholder floor, READ from the product rather than restated here — P3.159.
 *
 * ## Why this module exists
 *
 * Two live cases asserted a model's stored `contextWindow` was "credible" by
 * comparing it against a hand-copied `4096`. `e3959bac5` (P3.91) deleted the
 * BYO fetcher's private `MIN_CREDIBLE_CONTEXT_WINDOW = 4096` and unified both
 * catalogue paths onto `MIN_PLAUSIBLE_CONTEXT_WINDOW = 1024`, deliberately
 * DOWNWARD: both floors reject the only placeholders anyone has observed (`0`
 * and `1`), so they can differ only on a genuinely small window — and there the
 * lower floor is strictly better, because a real 2048 kept compacts at 2048
 * while a real 2048 dropped leaves the row with no window at all.
 *
 * The harness did not follow, so a credible 2048-token window would have been
 * reported as incredible: **a live check that fails on correct behaviour, which
 * is worse than one that passes on broken behaviour, because it teaches people
 * to ignore the harness.**
 *
 * ## Why it reads the source instead of holding its own copy
 *
 * Restating the number is what went stale, and updating the restatement only
 * resets the clock. `scripts/refresh-nestor-model-windows.ts` already solved
 * this for the snapshot generator by parsing the constant out of the shared
 * source, with the rule written at the throw site: *"the placeholder floor moved
 * or was renamed, and guessing it here would ship a snapshot the runtime
 * disagrees with. Fix the pattern, do not hardcode the number."* Same rule, same
 * technique, one more consumer.
 *
 * A plain `import` is the obvious alternative and is the wrong one for the same
 * reason it was wrong there: a CDP case is a standalone `bun run` script and no
 * case in `scripts/cdp/` imports from `@nessy-agent/*`; dragging the shared
 * package into a harness process changes what the harness is.
 *
 * A missing pattern is BLOCKED, not FAIL: the product has not misbehaved, the
 * harness has become unrunnable, and those must not be scored the same way.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './bundle.ts'
import { blocked } from './report.ts'

/** The one file that declares the floor, relative to the repo root. */
export const FLOOR_SOURCE = 'packages/shared/src/auth/nestor.ts'

/**
 * Parse the floor out of the shared source. Exported for its own test — the
 * "what if the constant is renamed" arm cannot be exercised through the reader.
 */
export function parseMinPlausibleContextWindow(source: string): number | undefined {
  const match = /export const MIN_PLAUSIBLE_CONTEXT_WINDOW = (\d[\d_]*)/.exec(source)
  if (!match?.[1]) return undefined
  return Number(match[1].replaceAll('_', ''))
}

/**
 * The floor the product itself applies, as of this checkout.
 *
 * Both catalogue paths run through `sanitizeReportedContextWindow`, so a stored
 * window below this number cannot have come from a fetch — it is either a
 * placeholder that got past the guard or a hand-written config entry.
 *
 * `root` exists so the two refusal arms are reachable from a test; every caller
 * takes the default.
 */
export function minPlausibleContextWindow(root: string = repoRoot()): number {
  const path = join(root, FLOOR_SOURCE)
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    blocked(
      `cannot read ${FLOOR_SOURCE} — this case reads the product's placeholder floor rather than `
      + 'restating it, and a restated floor is what went stale last time. Run the case from a checkout.',
    )
  }
  const floor = parseMinPlausibleContextWindow(source)
  if (floor === undefined) {
    blocked(
      `no \`export const MIN_PLAUSIBLE_CONTEXT_WINDOW = <n>\` in ${FLOOR_SOURCE} — the placeholder floor `
      + 'moved or was renamed. Fix the pattern, do not hardcode the number: a harness that disagrees with '
      + 'the runtime flags correct behaviour as a defect.',
    )
  }
  return floor
}
