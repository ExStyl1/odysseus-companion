import type { ContextUsageSnapshot } from '@nessy-agent/shared/protocol/dto'

/**
 * F1.440 — a compaction boundary's context snapshot is ONE reading, and a later
 * turn that reports a different size supersedes it.
 *
 * Since F1.240 a claude `compact_boundary` writes the session's
 * `ContextUsageSnapshot` with the SDK's `post_tokens` (source
 * `estimated_after_compact`). Claude is a `fresh-local` provider, so the donut
 * and the usage overlay read ONLY that snapshot — and nothing but `/context`
 * ever replaced it. Every later turn's `complete` reported a growing context in
 * `tokenUsage` while the snapshot stayed at the boundary's number, unmarked, so
 * the donut drew a count that fell further behind every turn.
 *
 * The rule, the smallest one that is true: when a turn completes WITHOUT a
 * snapshot of its own, and its own context reading (`tokenUsage.contextTokens`
 * after the `complete` case assigned it) is a real count that DIFFERS from the
 * boundary snapshot's count, that snapshot is marked `stale`. The count is kept
 * — it is still what the boundary said — and the renderer (F1.426) labels a
 * stale snapshot instead of drawing it as current.
 *
 * What it deliberately does NOT touch:
 * - a turn that carries its own snapshot (Pi sends one with its `complete`):
 *   the `complete` case has just applied it, so there is nothing to supersede;
 * - the manual `/compact` turn itself: its `complete` carries R16's
 *   `contextTokens` equal to `post_tokens`, so the reading AGREES and the fresh
 *   boundary snapshot stays current;
 * - a remote agent's own report (`remote_reported`): the remote measures its
 *   own context, and our local turn reading is not the same instrument;
 * - a snapshot with no count (`unavailable`): there is nothing to go stale.
 *
 * F1.477 (P1) — DECIDED: the rule also covers a `/context` report
 * (`sdk_usage`). It is the same kind of point-in-time reading, and on claude
 * (`fresh-local`) nothing but the next `/context` replaces it, so after later
 * turns the donut drew the old report as today's occupancy — the defect this
 * rule exists for, one source over. Marking keeps the count AND the category
 * breakdown the user asked for; the renderer labels it stale (F1.426) and the
 * donut waits for a current reading. A runtime that reports its own snapshot
 * with every `complete` (Pi) is untouched by construction: `turnSnapshot` is
 * present. The name still says "compaction" because the boundary was the first
 * source; it is the call site's, and renaming it moves nothing.
 *
 * Returns the stale copy to store, or `undefined` when nothing changes.
 */
/** The snapshot sources a later turn's own reading can supersede (see above). */
const SUPERSEDABLE_SOURCES: ReadonlySet<ContextUsageSnapshot['source']> = new Set(['estimated_after_compact', 'sdk_usage'])

export function supersededCompactionSnapshot(
  current: ContextUsageSnapshot | undefined,
  turnSnapshot: ContextUsageSnapshot | undefined,
  turnContextTokens: number | null | undefined,
): ContextUsageSnapshot | undefined {
  if (!current || turnSnapshot) return undefined
  if (!SUPERSEDABLE_SOURCES.has(current.source) || current.stale === true) return undefined
  if (typeof turnContextTokens !== 'number' || !Number.isFinite(turnContextTokens) || turnContextTokens <= 0) return undefined
  if (turnContextTokens === current.inputTokens) return undefined
  return { ...current, stale: true }
}
