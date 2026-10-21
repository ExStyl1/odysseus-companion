/**
 * The composer's single context indicator.
 *
 * There used to be two, side by side, and they disagreed because they divided by
 * different things: the donut showed a share of the WHOLE context window, the
 * warning badge a share of the AUTO-COMPACTION THRESHOLD. Two percentages an inch
 * apart, both labelled "context", is a reading puzzle rather than a readout — so
 * the badge's meaning was folded into the donut and the badge removed.
 *
 * This resolves what the one indicator should be; the component renders it.
 */

/** What the composer knows about the session's context, as far as this needs. */
export interface ContextMeterInput {
  /** Provider-reported context, from `ContextUsageSnapshot`. */
  readonly inputTokens?: number | null
  readonly contextWindow?: number | null
  /** The backend's own auto-compaction threshold, when it reports one. */
  readonly autoCompactionThreshold?: number | null
  readonly isCompacting?: boolean | null
  /**
   * Where this backend's threshold comes from, straight off the composer
   * capability. Absent means an older backend that never sent one, which is
   * exactly the population `legacy` describes.
   *
   * This used to be a boolean — `providerReportsFreshUsage` — and under it
   * codex and a pre-reporting provider were the SAME branch: both got a
   * threshold at 77.5% of the window that no backend was going to act on. A
   * warning nobody honours is worse than no warning, because the reader takes
   * it as a measurement.
   */
  readonly thresholdKind?: 'real' | 'formula-claude' | 'none' | 'legacy'
  /** The model catalogue's window, used only if the session has not reported one. */
  readonly catalogContextWindow?: number | null
  /** A turn is in flight, so `/compact` cannot be submitted yet. */
  readonly isProcessing: boolean
}

export interface ContextMeterState {
  /** Share of the whole window — what the donut has always drawn. */
  readonly windowPercent: number
  /** Share of the auto-compaction threshold, or `null` when there is no threshold. */
  readonly thresholdPercent: number | null
  /** At or past the point where compacting is worth offering. */
  readonly warning: boolean
  /** The indicator offers `/compact`; false while a turn is in flight. */
  readonly actionable: boolean
}

/**
 * The share of the threshold at which the old badge appeared. Kept as the point
 * where the donut turns, so the merge changes where the information lives and
 * not when it arrives.
 */
export const CONTEXT_WARNING_PERCENT = 80

/**
 * The pre-threshold-reporting fallback: 77.5% of the window. Only for providers
 * that do NOT report fresh usage — see `providerReportsFreshUsage`.
 */
export const LEGACY_THRESHOLD_FRACTION = 0.775

/**
 * What the Claude SDK subtracts from the window before it auto-compacts.
 *
 * Computed here rather than reported: the SDK never sends its threshold, but it
 * derives it from the context window — the window F2 now makes correct through
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — so the same subtraction reproduces the
 * number the subprocess will actually act on, instead of a fraction guessed at
 * from outside.
 *
 * The 20 000 arm is the SDK's `min(maxOutputTokens, 20 000)`, pinned to the
 * constant because this repo has NO source for the effective maxOutput and the
 * bundled SDK's default is at or above 20 000. If a max-output knob ever lands
 * here, this is the line that stops being a constant.
 */
const CLAUDE_OUTPUT_RESERVE = 20_000
const CLAUDE_COMPACT_BUFFER = 13_000

/**
 * Exported for one reason: the number itself is otherwise unreadable from
 * outside. `resolveContextMeterState` only ever returns a PERCENTAGE of this
 * threshold, rounded and capped at 99, and no probe of it can recover the
 * threshold exactly — so the cross-package test that pins this derivation
 * against the window F9 hands the SDK (`claude-compaction-threshold-lockstep`)
 * would have had to assert on a rounded percent, which is precisely the
 * resolution at which a drifting constant hides.
 */
export function resolveThreshold(input: ContextMeterInput, effectiveWindow: number): number | null {
  // A reported threshold always wins — it is the number the backend itself will
  // act on, whatever kind of backend it is.
  if (input.autoCompactionThreshold != null) return input.autoCompactionThreshold

  switch (input.thresholdKind) {
    case 'real':
      // It reports one or it has none. An absent value here is information.
      return null
    case 'none':
      return null
    case 'formula-claude': {
      const derived = effectiveWindow - CLAUDE_OUTPUT_RESERVE - CLAUDE_COMPACT_BUFFER
      return derived > 0 ? derived : null
    }
    case 'legacy':
    default:
      // Only where nothing better exists. Note this fabricates the THRESHOLD,
      // not the warning point: the donut turns at 80% of it, ≈62% of the window.
      return effectiveWindow ? Math.round(effectiveWindow * LEGACY_THRESHOLD_FRACTION) : null
  }
}

/**
 * The blank meter has TWO causes, and only one of them is "nothing to report".
 *
 * {@link resolveContextMeterState} returns `null` both for the ordinary opening
 * state — no turn has run, nothing has reported an occupancy — and for a session
 * that IS counting tokens against a window nobody knows. The second is not
 * nothing: it is the state where auto-compaction does not happen at all. P3.32
 * made that loud once, at session start ("No context window is recorded for
 * model X, so automatic context compaction is OFF for this session…"), and then
 * the composer showed empty space for the rest of the session — a second silence
 * with the same cause, on the surface the user actually looks at.
 *
 * True means: an occupancy is being counted, no window bounds it, and the
 * conversation will therefore keep growing without compacting.
 *
 * Three deliberate exclusions, each of which would make this fire on a session
 * that is fine:
 * - `inputTokens == null` — nothing has reported anything yet. A brand-new
 *   session must not open under a warning glyph; the blank there is honest.
 * - a usable `catalogContextWindow` — a window IS known for this model even
 *   though the session did not report one. That the donut does not draw it is a
 *   separate defect (the catalogue fallback is inert on the fresh-local path);
 *   claiming "unknown" would misreport it.
 * - a `contextWindow <= 0` still counts as unknown, matching the divide-by-zero
 *   guard below rather than drawing a share of nothing.
 *
 * What this must NOT be resolved to is a number. `windowPercent: 0` renders an
 * empty ring, which reads as "plenty of room left" — the exact opposite of what
 * is true — and a filled ring claims a measurement nobody made. Both are worse
 * than the blank they would replace, so the state stays a STATE and the
 * indicator draws it as indeterminate (`ContextMeterUnknownWindow`).
 */
export function isContextWindowUnknown(input: ContextMeterInput): boolean {
  if (input.inputTokens == null) return false
  const known = (value: number | null | undefined): boolean => value != null && value > 0
  return !known(input.contextWindow) && !known(input.catalogContextWindow)
}

export function resolveContextMeterState(input: ContextMeterInput): ContextMeterState | null {
  const { inputTokens, contextWindow } = input
  // The donut's own precondition, unchanged: without both numbers there is no
  // share of a window to draw, and a zero window would divide by zero.
  if (inputTokens == null || contextWindow == null || contextWindow <= 0) return null

  const effectiveWindow = contextWindow || input.catalogContextWindow || 0
  const threshold = resolveThreshold(input, effectiveWindow)

  // Capped at 99 as the badge capped it: a threshold that has been passed is
  // still "nearly there" to a reader, and 100% reads as "nothing left at all".
  const thresholdPercent = threshold
    ? Math.min(99, Math.round((inputTokens / threshold) * 100))
    : null

  // Not while a compaction is already running — the old badge hid then, and an
  // offer to compact during a compaction is an offer to do nothing.
  const warning = thresholdPercent !== null
    && thresholdPercent >= CONTEXT_WARNING_PERCENT
    && !input.isCompacting

  return {
    windowPercent: Math.round((inputTokens / contextWindow) * 100),
    thresholdPercent,
    warning,
    actionable: warning && !input.isProcessing,
  }
}
