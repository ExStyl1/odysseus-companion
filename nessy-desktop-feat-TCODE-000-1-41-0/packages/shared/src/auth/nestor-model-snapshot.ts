/**
 * GENERATED FILE — do not hand-edit.
 *
 * Rebuilt by `scripts/refresh-nestor-model-windows.ts`; see that script's header
 * for the fetch that produces it and the environment keys it reads.
 *
 * Read {@link NESTOR_MODEL_SNAPSHOT_META} for when this was harvested and from
 * where. It is the ONLY provenance statement for these numbers: a prose sentence
 * elsewhere claiming a date or a count is not evidence about this file, and this
 * repo has twice shipped a document asserting a stale count beside a correct one.
 */

/** When, from where, and over how many rows this snapshot was harvested. */
export const NESTOR_MODEL_SNAPSHOT_META = Object.freeze({
  /** ISO date of the harvest that produced the windows below. */
  snapshot: '2026-09-11',
  /** The endpoint the windows were read from. */
  source: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/models',
  /** Rows the endpoint returned. */
  rows: 2,
  /** Rows that carried a usable window (the rest are absent below, not zeroed). */
  windows: 2,
  /**
   * Rows whose reported window was at or below
   * `MIN_PLAUSIBLE_CONTEXT_WINDOW` — a "not filled in" placeholder rather than a
   * window, dropped rather than recorded.
   */
  rejectedAsPlaceholder: 0,
  /**
   * Rows whose window an `LLM_PROXY_API_KEY` cross-check disagreed with. The
   * smaller value is the one recorded; 0 means either no disagreement or no
   * cross-check key was supplied.
   */
  crossCheckLowered: 0,
});

/**
 * Gateway model id → context window, as the gateway itself reported it.
 *
 * This is the FALLBACK, not the design: `fetchNestorModels` prefers the window
 * the live `/cli/models` response carries, and this table covers what the live
 * path could not — a refresh that failed, a stored catalogue entry that lost its
 * window, a connection seeded before the first refresh.
 */
export const NESTOR_MODEL_SNAPSHOT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  'tgpt/deepseek-v4-flash-0731': 524000,
  'tgpt/qwen36-35b-a3b-fp8': 262000,
});
