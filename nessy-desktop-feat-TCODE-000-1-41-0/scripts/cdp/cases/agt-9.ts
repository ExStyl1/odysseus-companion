/**
 * AGT-9 — the auto-compaction threshold leaves room for one more turn.
 *
 * The threshold is checked AFTER an assistant message, so whatever it leaves
 * unspent is the entire headroom for everything the NEXT turn adds. Pi's default
 * reserve is 16 384 tokens while the cap on a single MCP tool result is 25 000
 * (`mcp.md` § MCP output limits and warnings: "the default maximum is 25,000
 * tokens"). One permitted tool result could therefore exceed the whole headroom:
 * the session sits just under the threshold, one tool call lands, and the next
 * request goes out over the window with no check in between.
 *
 * Two parts, because they need different things from the operator:
 *
 *   1. HEADROOM — on an ordinary session, the live threshold plus one maximal
 *      tool result still fits inside the model's window. Needs nothing; this is
 *      the invariant the fix creates, read off a running app.
 *   2. FIRES — a session actually crosses its threshold, compacts, and the turn
 *      after that completes. Reaching a real 262 144-token window would take
 *      hours, so this half is gated on `NESSY_AUTO_COMPACT_WINDOW`, which
 *      narrows the capacity the policy is computed against
 *      (`config/auto-compaction-settings.ts`). Launch the app with it set to
 *      something above the session's BASE context and below what a few turns reach.
 *      90 000 puts the threshold at 60 000, which a fresh session (~46 000 of
 *      system prompt and capabilities) crosses in a handful of turns. Do not go
 *      much lower: at 30 000 the threshold is 13 616, below the base context
 *      itself, so the session compacts after every single turn and never drops
 *      under it — measured, twenty-seven compactions in one run.
 *
 * The Pi bundle is where this arithmetic lives, and dev loads it from
 * `packages/pi-agent-server/dist/index.js` (`runtime-resolver.ts`
 * `resolveServerPath`, the not-packaged branch). Rebuild that bundle before
 * measuring or this case reads whatever was built last.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, waitFor, type SessionKey } from '../lib/state.ts'

const ID = 'AGT-9'
const TITLE = 'Auto-compaction leaves room for one more turn, and fires before the window is exceeded'

/**
 * The documented default cap on a single MCP tool result. The reserve has to
 * cover at least this much or one permitted tool call can outgrow the headroom.
 */
const MCP_TOOL_RESULT_CAP = 25_000

/** Set at launch to shrink the capacity the threshold is computed against. */
const NARROWED_WINDOW = process.env.NESSY_AUTO_COMPACT_WINDOW

interface LiveUsage {
  found: boolean
  contextWindow?: number | null
  /**
   * `ContextUsageSnapshot.inputTokens` — the figure Pi's own accounting reports
   * and the one the threshold is compared against. NOT `TokenUsage.contextTokens`,
   * which is the host's session-level counter: reading that instead made a first
   * run of this case report a session sitting far over its threshold without
   * compacting, because the two count different things.
   */
  inputTokens?: number | null
  threshold?: number | null
  remainingBeforeAutoCompact?: number | null
  reserveTokens?: number | null
  autoCompactionEnabled?: boolean | null
  isCompacting?: boolean | null
  source?: string | null
  /**
   * Read and reported, never asserted on: measured empty across five real
   * compactions, so it is evidence that the field is unfilled rather than a
   * signal. See the detector note in part 2.
   */
  compactedAtLeastOnce: boolean
  tokensBefore?: number | null
}

/**
 * Read the session's own context accounting. `TokenUsage.contextUsage`
 * (`core/types/message.ts`) is the provider-neutral snapshot the backend fills
 * in; every field is optional by contract, so absence is reported rather than
 * defaulted — a zero here would read as "no headroom" and fail the case for the
 * wrong reason.
 */
async function liveUsage(session: CdpSession, key: SessionKey): Promise<LiveUsage> {
  return session.call<LiveUsage>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
    const usage = s && s.tokenUsage ? s.tokenUsage : null
    const cu = usage && usage.contextUsage ? usage.contextUsage : null
    if (!cu) return { found: false, compactedAtLeastOnce: false }
    return {
      found: true,
      contextWindow: cu.contextWindow ?? null,
      inputTokens: cu.inputTokens ?? null,
      threshold: cu.autoCompactionThreshold ?? null,
      remainingBeforeAutoCompact: cu.remainingBeforeAutoCompact ?? null,
      reserveTokens: cu.reserveTokens ?? null,
      autoCompactionEnabled: cu.autoCompactionEnabled ?? null,
      isCompacting: cu.isCompacting ?? null,
      source: cu.source ?? null,
      compactedAtLeastOnce: Boolean(cu.lastCompaction),
      tokensBefore: cu.lastCompaction ? (cu.lastCompaction.tokensBefore ?? null) : null,
    }
  `)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  run.observe('NESSY_AUTO_COMPACT_WINDOW', NARROWED_WINDOW ?? '(unset — part 2 skipped)')

  // ---- 1. headroom -------------------------------------------------------
  // A real turn first, then WAIT: a brand-new session has no accounting until a
  // provider has reported usage, and reading immediately after the turn returns
  // an empty snapshot on a cold session (it only looked reliable on warm ones).
  await sendPrompt(session, key, 'Reply with the single word: ready.')
  const usage = await waitFor(
    () => liveUsage(session, key),
    value => value.found && typeof value.threshold === 'number',
    { timeoutMs: 60_000, label: 'the first context-usage report' },
  ).catch(() => liveUsage(session, key))

  run.observe('context-usage', usage)
  run.check('the session reports its context accounting', usage.found, usage.found ? undefined : 'no contextUsage on tokenUsage')

  if (usage.found) {
    run.check(
      'auto-compaction is enabled on an ordinary session',
      usage.autoCompactionEnabled === true,
      `autoCompactionEnabled=${String(usage.autoCompactionEnabled)}`,
    )

    const window = usage.contextWindow
    const threshold = usage.threshold
    const known = typeof window === 'number' && window > 0 && typeof threshold === 'number' && threshold > 0
    run.check('the window and the threshold are both known', known, known ? undefined : `window=${String(window)} threshold=${String(threshold)}`)

    if (known) {
      // The invariant the fix exists for: a turn that STARTS at the threshold and
      // adds one maximal tool result must still land inside the window.
      run.observe('headroom', { window, threshold, headroom: window - threshold, needed: MCP_TOOL_RESULT_CAP })
      run.check(
        'one maximal MCP tool result still fits between the threshold and the window',
        threshold + MCP_TOOL_RESULT_CAP < window,
        `threshold ${threshold} + ${MCP_TOOL_RESULT_CAP} is not below window ${window}`,
      )
    }
  }

  // ---- 2. it actually fires ----------------------------------------------
  if (!NARROWED_WINDOW) {
    run.observe('part-2', 'skipped: launch with NESSY_AUTO_COMPACT_WINDOW set (e.g. 90000) to measure a real crossing')
    return
  }

  // Compaction is detected as GROWTH STOPPING, and that is the fourth detector
  // this case has had. The three before it each reported a product defect that
  // was not there:
  //
  //   * `ContextUsageSnapshot.lastCompaction` is never filled on this path. It
  //     reported "never compacted" through twenty-seven real compactions.
  //   * a `/compact`-style service message in the transcript (what AGT-6 uses)
  //     matched a message left by an EARLIER run in a reused session, so it
  //     reported a compaction that had not happened in this one.
  //   * a single large DROP in the context. Compaction does not produce that
  //     shape here: it fires repeatedly and holds the session on a plateau, so
  //     a "fell by 15%" test waits for something that never arrives.
  //
  // Growth stopping is what the product actually promises, it needs no field the
  // backend may not populate, and it cannot be satisfied by history from a
  // previous run. Ground truth for all four was the session's own
  // `.pi-sessions/*.jsonl`, which records a `compaction` entry per compaction.
  const MAX_TURNS = 20
  const PLATEAU_TURNS = 5
  /** Post-crossing growth must fall to a small fraction of the pre-crossing rate. */
  const PLATEAU_FRACTION = 0.35
  const series: number[] = []
  let crossedAt = 0
  let turns = 0

  while (turns < MAX_TURNS) {
    turns += 1
    await sendPrompt(
      session,
      key,
      `Turn ${turns}: write roughly 500 words about how a conversation consumes a context window. Do not use any tools.`,
    )
    const after = await liveUsage(session, key)
    const tokens = typeof after.inputTokens === 'number' ? after.inputTokens : 0
    const threshold = typeof after.threshold === 'number' ? after.threshold : 0
    series.push(tokens)
    if (crossedAt === 0 && threshold > 0 && tokens > threshold) crossedAt = turns

    run.observe(`turn-${turns}`, { inputTokens: tokens, threshold, remaining: after.remainingBeforeAutoCompact })

    // Stop as soon as the plateau is visible rather than after a fixed number of
    // turns. The plateau does NOT begin at the threshold: compaction keeps the
    // recent tail (`keepRecentTokens`) on top of the session's base context, so
    // the steady state settles ABOVE the threshold — measured at 66 000–73 000
    // for a 60 000 threshold, about five turns after the crossing. A fixed window of
    // five turns cut the run off while it was still climbing.
    if (crossedAt > 0 && turns >= crossedAt + PLATEAU_TURNS) {
      const recent = series.slice(-PLATEAU_TURNS)
      const rate = ((recent[recent.length - 1] ?? 0) - (recent[0] ?? 0)) / (recent.length - 1)
      const early = (series[crossedAt - 1] ?? 0) - (series[0] ?? 0)
      const earlyRate = crossedAt > 1 ? early / (crossedAt - 1) : 0
      if (earlyRate > 0 && rate < earlyRate * PLATEAU_FRACTION) break
    }
  }

  run.check(
    `the session crossed its auto-compaction threshold within ${MAX_TURNS} turns`,
    crossedAt > 0,
    crossedAt > 0 ? undefined : `peak ${Math.max(0, ...series)} never exceeded the threshold`,
  )
  if (crossedAt === 0) return

  // Compaction here does NOT show up as one big drop — it fires repeatedly and
  // holds the context on a plateau, so a "fell by X%" test looks for a shape the
  // product does not produce. What it promises, and what this measures, is that
  // the context stops running away. (This is the fourth detector this case has
  // had; the three before it each reported a product defect that was not there —
  // see the note above `LiveUsage`.)
  const at = (index: number): number => series[index] ?? 0
  const preRate = crossedAt > 1 ? (at(crossedAt - 1) - at(0)) / (crossedAt - 1) : 0
  const tail = series.slice(-PLATEAU_TURNS)
  const postRate = tail.length > 1 ? ((tail[tail.length - 1] ?? 0) - (tail[0] ?? 0)) / (tail.length - 1) : 0
  run.observe('growth-per-turn', { beforeCrossing: Math.round(preRate), afterCrossing: Math.round(postRate), crossedAt })
  run.check(
    'growth stops once the threshold is crossed — the context does not run away',
    preRate > 0 && postRate < preRate * PLATEAU_FRACTION,
    `before ${Math.round(preRate)}/turn, after ${Math.round(postRate)}/turn`,
  )

  // The whole point: the turn AFTER a compaction goes through. An over-window
  // request is what the reserve exists to prevent, and it surfaces as a failed
  // turn rather than a quiet one.
  const next = await sendPrompt(session, key, 'In one short sentence, say what we have been discussing.')
  // F1.503 — THIS turn's rows: over the whole transcript a failed turn read
  // the previous filler's reply, and passed as "completes".
  const reply = lastAssistantText(next.added)
  run.observe('post-compaction-turn', { text: reply.slice(0, 200) })
  const answered = reply.trim().length > 0
  run.check('the turn after compaction completes', answered, answered ? undefined : 'empty assistant reply after compaction')

  const final = await liveUsage(session, key)
  run.observe('final-usage', final)
  const within = typeof final.inputTokens === 'number' && typeof final.contextWindow === 'number'
    ? final.inputTokens < final.contextWindow
    : false
  run.check(
    'context stayed inside the window across the compaction',
    within,
    `inputTokens=${String(final.inputTokens)} contextWindow=${String(final.contextWindow)}`,
  )
}

// T21's audit found this file (and agt-10/agt-9) lacked the guard every other
// case carries: importing it would RUN the sitting.
if (import.meta.main) await main(ID, TITLE, drive)
