/**
 * CRU-2 — after a compaction on Claude, the context badge agrees with the banner.
 *
 * The banner and the badge sit beside each other and used to contradict each
 * other. `SessionManager`'s `info` case appends the "Compacted Conversation" row
 * and, in the same breath, pushes a `usage_update` "so the context count badge
 * refreshes immediately after compaction" (`SessionManager.ts:20787`) — out of
 * `managed.tokenUsage.inputTokens`, which at that moment still held the
 * PRE-compaction number. So the app announced a compaction and displayed the
 * size of the conversation it had just thrown away.
 *
 * R14 fixed it by reading `compact_metadata.post_tokens` off the SDK's own
 * boundary message before the event adapter turns it into the banner and
 * discards the metadata (`claude-agent.ts:3039`), and by re-asserting that number
 * after the turn's own `complete` — because `complete` on the manual path carries
 * the compaction REQUEST's input, i.e. the whole pre-compaction conversation, and
 * `SessionManager` ASSIGNS it into the badge.
 *
 * ## The one instruction a future maintainer must not "fix"
 *
 * **This case reads the badge with NO further turn in between, and that is the
 * entire point.** The defect self-heals on the next turn: any prompt sent after
 * the compaction reports a fresh, correct `inputTokens` and paints the right
 * number over the wrong one. A case that sends a settling turn before reading —
 * which is exactly what `COMPACT-LIFE` has to do on Pi, for a different and real
 * reason ("the occupancy does not fall when the compaction does": Pi's counter is
 * the provider's last reported figure) — measures the self-heal and passes on a
 * build that never had the fix. The two runtimes need opposite instruments here.
 *
 * ## Three detectors that would each have been wrong
 *
 * - **`contextUsage.inputTokens`**, which is what `AGT-9` reads. That snapshot
 *   has one writer, `applyContextUsageSnapshot`, and it is the Pi path; on
 *   claude-runtime it is never filled. `ChatDisplay.usage-format.ts` records the
 *   measurement (2026-08-15): the Context row read `0 / 240,000 (0%)` on this
 *   runtime beside a correct `inputTokens`. Reading it here would report "no
 *   accounting" forever. The badge's own rule is mirrored instead —
 *   `resolveContextTokens`, where a 0 is the initialiser and falls through.
 * - **"the context went down"** alone. It goes down for many reasons, including
 *   the SDK abandoning a conversation after an upstream 400 and silently
 *   starting a fresh one — measured on this rig, and it looks exactly like a
 *   compaction. So the drop is scored against the runtime's OWN record, and the
 *   badge is compared to the runtime's OWN `postTokens` rather than to "lower".
 * - **the transcript's "Compacted" row as proof a compaction happened.** It is a
 *   marker in a file, and a marker in a reused session is history. This case
 *   creates its own session and counts the runtime's boundary entries before and
 *   after, so the record it reads cannot predate the run.
 *
 * ## The positive control
 *
 * The before-number, taken from the same reader as the after-number, and the
 * per-turn growth measured while seeding. "Materially lower" is defined against
 * that growth rather than against a constant: the drop must exceed the largest
 * single turn's own growth on this rig, so a context that merely ticked cannot
 * pass as a compaction.
 *
 * ## What is BLOCKED rather than failed
 *
 * A refusal ("not enough messages to compact") is a precondition this case
 * cannot manufacture beyond seeding more turns, and an absent `post_tokens` —
 * optional in the SDK's own type — means the runtime never reported a
 * post-compaction size, so there is nothing to agree with. R14 deliberately emits
 * nothing in that case, because "a fabricated context size would be worse than a
 * stale one".
 */

import { sendPrompt, sendSlashCommand } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { readClaudeSessionLog } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import {
  assertElectronApi,
  freshSession,
  transcript,
  waitFor,
  type SessionKey,
  type TranscriptMessage,
} from '../lib/state.ts'

const ID = 'CRU-2'
const TITLE = 'After a compaction on Claude the context badge reports the post-compaction size, not the pre'

/**
 * How many exchanges to lay down before compacting.
 *
 * The SDK refuses a conversation with less than two prior exchanges, and a
 * refusal is a BLOCKED here rather than a failure. Three is the smallest number
 * that clears that floor with a turn to spare; raise it when a rig refuses.
 */
const SEED_TURNS = Number(process.env.NESSY_CDP_CRU2_SEED_TURNS ?? 3)

const TURN_TIMEOUT_MS = 300_000
const COMPACT_TIMEOUT_MS = 600_000

/**
 * How long to let the post-compaction number arrive after the turn settles.
 *
 * R14's re-assertion is yielded AFTER the turn's own `complete`, and
 * `SessionManager` clears `isProcessing` on that `complete` — so the badge is
 * briefly still the pre-compaction number at the instant the turn is "finished".
 * Reading once at that instant is the README's sample-instead-of-wait mistake and
 * would report the defect on a build that fixed it. The wait cannot manufacture a
 * pass: when nothing arrives it times out and the final reading is asserted on
 * anyway, with both numbers in the failure detail.
 */
const BADGE_SETTLE_MS = 60_000

/**
 * The smallest drop this case will call material when the rig's own per-turn
 * growth is smaller than it. Below a thousand tokens a fall is not
 * distinguishable from ordinary turn-to-turn accounting.
 */
const MIN_MATERIAL_DROP_TOKENS = 1_000

/** What the runtime refuses with when there is nothing to compact. */
const REFUSAL_PATTERN = /not enough messages|nothing to compact|too small|cannot compact|unable to compact/i

/**
 * The number the context badge renders, read by the badge's own rule.
 *
 * Mirrors `ChatDisplay.usage-format.ts` — `formatContextUsage` prefers the
 * `contextUsage` snapshot and falls back to `resolveContextTokens`, in which a
 * zero is `ensureTokenUsage`'s initialiser rather than an observation and falls
 * through. Mirrored rather than approximated, because "the badge agrees with the
 * banner" is a claim about what the user sees, and a reader that computes a
 * different number answers a different question.
 */
interface BadgeReading {
  /** What the badge shows. `null` when nothing has observed a size yet. */
  tokens: number | null
  contextWindow: number | null
  /** The raw fields, for the record. */
  inputTokens: number | null
  contextTokensField: number | null
  /** Pi-only in practice; its presence here would change which branch renders. */
  contextUsagePresent: boolean
}

async function badge(session: CdpSession, key: SessionKey): Promise<BadgeReading> {
  return session.call<BadgeReading>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
    const usage = s && s.tokenUsage ? s.tokenUsage : null
    const snapshot = usage && usage.contextUsage ? usage.contextUsage : null
    const observed = value => (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : null
    const fallback = observed(usage ? usage.contextTokens : null) ?? observed(usage ? usage.inputTokens : null)
    return {
      tokens: snapshot ? (observed(snapshot.inputTokens) ?? null) : fallback,
      contextWindow: (snapshot && snapshot.contextWindow) ?? (usage ? (usage.contextWindow ?? null) : null),
      inputTokens: usage ? (usage.inputTokens ?? null) : null,
      contextTokensField: usage ? (usage.contextTokens ?? null) : null,
      contextUsagePresent: Boolean(snapshot),
    }
  `)
}

interface CompactionBoundary {
  trigger: unknown
  preTokens: number | null
  postTokens: number | null
}

interface CompactionRecord {
  count: number
  newest?: CompactionBoundary
  files: string[]
  reason?: string
}

/**
 * The compaction boundaries the RUNTIME wrote for itself.
 *
 * Narrowed to this session's own transcript directory — the SDK slugifies the
 * session's working directory, which for a Nessy session ends with the session
 * id — and every `.jsonl` inside it is read, because the SDK opens a new file
 * whenever it starts a fresh conversation and the boundary stays behind in the
 * old one.
 *
 * **Two spellings of one fact, and reading only one of them zeroes the
 * detector.** The SDK's stream message is snake_case (`compact_metadata`,
 * `post_tokens`) and that is what `claude-agent.ts` consumes; the transcript file
 * is camelCase (`compactMetadata`, `postTokens`, `preTokens`, `trigger`) —
 * measured on this profile, e.g. `{"trigger":"manual","preTokens":123816,
 * "postTokens":2092}`. Both are accepted here so a future alignment in either
 * direction does not silently report "no compaction".
 */
function compactionRecord(key: SessionKey): CompactionRecord {
  const log = readClaudeSessionLog(key.workspaceId, undefined, key.sessionId)
  if (log.reason) return { count: 0, files: [], reason: log.reason }
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const boundaries = log.entries.flatMap(entry => {
    const raw = entry.raw
    const metadataValue = raw.compactMetadata ?? raw.compact_metadata
    const isBoundary = entry.type === 'compact_boundary'
      || raw.subtype === 'compact_boundary'
      || metadataValue !== undefined
    if (!isBoundary) return []
    const metadata = (metadataValue && typeof metadataValue === 'object'
      ? metadataValue
      : {}) as Record<string, unknown>
    return [{
      trigger: metadata.trigger,
      preTokens: number(metadata.preTokens) ?? number(metadata.pre_tokens),
      postTokens: number(metadata.postTokens) ?? number(metadata.post_tokens),
    }]
  })
  return {
    count: boundaries.length,
    ...(boundaries.length > 0 ? { newest: boundaries[boundaries.length - 1]! } : {}),
    files: log.files ?? (log.file ? [log.file] : []),
  }
}

/** Rows the compaction turn added that read as a refusal rather than a result. */
function refusals(added: TranscriptMessage[]): string[] {
  return added
    .filter(message => message.role === 'error' || REFUSAL_PATTERN.test(message.content))
    .map(message => `${message.role}: ${message.content.slice(0, 240)}`)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const connections = await listConnections(session)
  const claude = connections.find(row => runtimeOf(row.providerType) === 'anthropic' && row.providerType === 'claude-runtime')
  run.observe('connections', connections.map(row => `${row.slug}(${row.providerType})`))
  if (!claude) {
    blocked(
      'this case needs a claude-runtime connection (the "Claude Code (Nessy Gateway)" card) — `compact_metadata` is '
      + 'the Claude SDK\'s own boundary message and no other runtime emits one. The host lists '
      + `${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  // A reused session is fatal to this case specifically: it counts the runtime's
  // compaction records, and an inherited conversation can arrive with records
  // already in it — the "a marker in a reused session is history" failure, which
  // has already cost one wrong verdict in this harness.
  run.require('the case ran in a session it created', key.fresh, key.reason ?? '')

  const outcome = await switchRuntime(session, key.sessionId, claude.slug)
  run.observe('switch onto the claude card', outcome)
  run.require('the session moved onto the claude-runtime card', outcome.ok, outcome.error ?? '')
  run.require(
    `the session reports ${claude.slug}`,
    (await waitForConnection(session, key.sessionId, claude.slug)) === claude.slug,
    String(await waitForConnection(session, key.sessionId, claude.slug)),
  )

  const atStart = compactionRecord(key)
  run.observe('compaction records before anything ran', atStart)

  // ---- seed a conversation worth compacting -------------------------------
  // The growth each turn adds is measured on the way, and it becomes the
  // threshold the drop has to beat. A constant would be a guess about a rig; this
  // is the rig answering for itself.
  const series: Array<number | null> = []
  for (let turn = 1; turn <= SEED_TURNS; turn += 1) {
    await sendPrompt(
      session,
      key,
      `Turn ${turn} of ${SEED_TURNS}: write roughly 250 words about how a long conversation consumes a model's `
      + 'context window, and what a summary of it can and cannot preserve. Do not use any tools.',
      TURN_TIMEOUT_MS,
    )
    const reading = await badge(session, key)
    series.push(reading.tokens)
    run.observe(`badge after seed turn ${turn}`, reading)
  }

  const growths = series.flatMap((value, index) => {
    const previous = index > 0 ? series[index - 1] : null
    return typeof value === 'number' && typeof previous === 'number' && value > previous ? [value - previous] : []
  })
  const maxTurnGrowth = growths.length > 0 ? Math.max(...growths) : 0
  const materialDrop = Math.max(MIN_MATERIAL_DROP_TOKENS, maxTurnGrowth)
  run.observe('per-turn growth while seeding', { growths, maxTurnGrowth, materialDrop })

  const beforeBadge = await badge(session, key)
  run.observe('badge before /compact — THE POSITIVE CONTROL', beforeBadge)
  // Recorded, never asserted on: `contextUsage` has one writer and it is the Pi
  // path, so its absence here is the expected shape rather than a finding. It is
  // observed because a case that read it instead of `inputTokens` would report a
  // session with no accounting at all.
  run.observe('contextUsage snapshot present (Pi-only in practice)', beforeBadge.contextUsagePresent)
  if (beforeBadge.tokens === null) {
    blocked(
      'the session reports no context size at all after '
      + `${SEED_TURNS} turns (tokenUsage.inputTokens=${String(beforeBadge.inputTokens)}), so there is no `
      + '"before" to compare a post-compaction number against. Nothing can be scored from here.',
    )
  }

  // ---- the compaction ------------------------------------------------------
  // The baseline is taken HERE, after seeding, not at the top. The SDK's own
  // auto-compaction can fire during the seed turns, and a baseline from before
  // them would let an automatic boundary satisfy "a new record appeared" — a
  // different compaction, on a path R14 deliberately does not pin the badge to.
  const before = compactionRecord(key)
  run.observe('compaction records after seeding, before /compact', before)

  // Through the palette, never as prose: `/compact` submits itself on selection
  // and leaves the composer empty, and a command typed without key events goes
  // out as an ordinary prompt — the retraction this harness is built around.
  const beforeCount = (await transcript(session, key)).length
  const compactTurn = await sendSlashCommand(session, key, {
    token: 'compact',
    match: /compact/i,
    expectComposer: '',
    submitOnSelect: true,
    timeoutMs: COMPACT_TIMEOUT_MS,
  })
  const added = (compactTurn.messages ?? await transcript(session, key)).slice(beforeCount)
  run.observe('rows the /compact turn added', added.map(m => `${m.role}: ${m.content.slice(0, 160)}`))

  // The reading taken the INSTANT the turn settles, kept for the record: R14's
  // re-assertion is yielded after the turn's own `complete`, so this one can
  // legitimately still be the pre-compaction number. It is evidence about
  // timing, not the value under test.
  const atSettle = await badge(session, key)
  run.observe('badge at the instant the turn settled', atSettle)

  const after = await waitFor(
    async () => compactionRecord(key),
    record => record.count > before.count,
    { timeoutMs: 60_000, intervalMs: 2_000, label: 'the runtime to write its own compaction record' },
  ).catch(() => compactionRecord(key))
  run.observe('compaction records after /compact', { ...after, sinceStart: after.count - atStart.count })

  if (after.count <= before.count) {
    const refused = refusals(added)
    if (refused.length > 0) {
      blocked(
        `the runtime refused the compaction: ${refused.join(' | ')}. The SDK needs at least two prior exchanges; `
        + `this run seeded ${SEED_TURNS}. Re-run with a larger NESSY_CDP_CRU2_SEED_TURNS.`,
      )
    }
    run.require(
      'the runtime actually compacted — its own transcript carries a new compact_boundary',
      false,
      `${before.count} → ${after.count} boundaries${after.reason ? ` (${after.reason})` : ''}; `
      + `files ${JSON.stringify(after.files)}. No refusal row either, so the command produced nothing at all.`,
    )
  }

  const newest = after.newest
  run.observe('the compaction the runtime recorded', newest)
  if (!newest || newest.postTokens === null) {
    blocked(
      'the runtime recorded a compaction but reported no post-compaction size '
      + `(${JSON.stringify(newest)}). \`post_tokens\` is optional in the SDK's own type, and R14 deliberately emits `
      + 'nothing without it — "a fabricated context size would be worse than a stale one, because it would look '
      + 'authoritative". With no figure from the runtime there is nothing for the badge to agree with, so this run '
      + 'cannot score the claim.',
    )
  }
  const postTokens = newest.postTokens

  // ---- the banner ----------------------------------------------------------
  // `SessionManager` persists the compaction row with `statusType:
  // 'compaction_complete'` and the content the event adapter produced,
  // 'Compacted Conversation' (`backend/claude/event-adapter.ts:859`); the
  // manager's own test for it is `event.message.startsWith('Compacted')`, so that
  // is what is matched here rather than the full string.
  const all = await transcript(session, key)
  const banner = all.filter(message => message.role === 'info' && /^Compacted/i.test(message.content.trim()))
  run.observe('compaction banner rows', banner.map(m => m.content.slice(0, 160)))
  run.check(
    'the conversation carries a "Compacted" banner',
    banner.length > 0,
    banner.length > 0 ? undefined : `info rows: ${JSON.stringify(all.filter(m => m.role === 'info').map(m => m.content.slice(0, 80)))}`,
  )

  // ---- the badge, read with NO further turn in between ---------------------
  const settled = await waitFor(
    () => badge(session, key),
    reading => typeof reading.tokens === 'number' && reading.tokens < beforeBadge.tokens!,
    { timeoutMs: BADGE_SETTLE_MS, intervalMs: 2_000, label: 'the post-compaction context size to reach the badge' },
  ).catch(() => badge(session, key))
  run.observe('badge after /compact', settled)
  run.observe('what the user is looking at', {
    banner: banner[0]?.content ?? '(none)',
    badgeBefore: beforeBadge.tokens,
    badgeAfter: settled.tokens,
    runtimePreTokens: newest.preTokens,
    runtimePostTokens: postTokens,
  })

  const dropped = typeof settled.tokens === 'number' ? beforeBadge.tokens! - settled.tokens : null
  run.check(
    'the badge fell by more than a whole turn\'s own growth — a measured drop, not a tick',
    dropped !== null && dropped > materialDrop,
    `${beforeBadge.tokens} → ${String(settled.tokens)} (dropped ${String(dropped)}, needed more than ${materialDrop})`,
  )

  // **The equality below is a claim about the MANUAL path only, and asserting it
  // on an automatic boundary would report a defect that is not one.** R14's
  // re-assertion is `manual`-only by design: on `auto` the boundary arrives
  // mid-turn and the turn CONTINUES, so the turn's own final figure is later than
  // the boundary and is the truth — an unconditional reassert under-reported by
  // 72% when it was measured in review. A `/compact` typed by a user is a manual
  // trigger; anything else here means the SDK compacted on its own initiative and
  // this run is looking at a different event than the one it drove.
  if (newest.trigger !== 'manual') {
    blocked(
      `the newest boundary is trigger ${JSON.stringify(newest.trigger)}, not "manual" — the SDK compacted on its own `
      + 'while this run was working, so the badge is legitimately a LATER reading than the boundary and equality with '
      + '`post_tokens` is not the contract on that path. The drop above still stands; the badge-equals-post_tokens '
      + 'claim needs a run where the only compaction is the one this case asked for.',
    )
  }

  // The claim in one line: the number beside the banner IS the number the runtime
  // reported for the conversation the banner is announcing. "Lower" alone is
  // satisfied by any refresh; equality is satisfied only by R14's path, which is
  // the only place a post-compaction size exists at all.
  run.check(
    'the badge is the runtime\'s own post-compaction figure, not the pre-compaction one',
    settled.tokens === postTokens,
    settled.tokens === postTokens
      ? undefined
      : `badge ${String(settled.tokens)} vs compact_metadata.post_tokens ${postTokens} `
        + `(pre ${String(newest.preTokens)}, trigger ${JSON.stringify(newest.trigger)}). `
        + (settled.tokens === newest.preTokens
          ? 'The badge is showing the PRE-compaction size — the banner and the badge contradict each other, which is '
            + 'the defect R14 exists to remove.'
          : 'Neither figure matches; something between the boundary message and the badge is re-writing it.'),
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
