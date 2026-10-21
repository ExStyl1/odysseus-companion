/**
 * `/subtask` forks: start one, wait for it, and read what it produced.
 *
 * A fork is NOT a turn. `waitForTurn` is the wrong wait for it and produced the
 * 2026-07-30 misread: submitting `/subtask …` adds the user message, spawns a
 * BACKGROUND child, and leaves the parent not processing — so "the transcript
 * grew and nothing is streaming" is true within a second, long before the fork
 * has done anything. The run then read the newest assistant message, which was
 * still the parent's own third-turn answer ("\n\n3"), and reported it as the
 * fork's.
 *
 * The three surfaces that actually carry a fork, and what each is for:
 *
 * | Surface | Read | Answers |
 * | --- | --- | --- |
 * | `childState.children` | `piRuntime()` | did a child register, and is it done |
 * | `read_child` control | `readChildTranscript()` | what the CHILD itself said |
 * | `subtask-<agentId>` tool pair | `forkEntries()` | what the PARENT recorded |
 *
 * The last one is the durable record. `SessionManager.recordForkResultInTranscript`
 * writes a `subagent` tool_start/tool_result pair with `toolUseId` =
 * `subtask-<agentId>` and `displayName` "Fork" when the child settles (c842b3c7).
 * The transient `Forked this conversation into …` info event is NOT part of that
 * contract — see the `fork_start_line` deviation note on `forkEntries`.
 */

import type { CdpSession } from './connect.ts'
import { sendPrompt, sendSlashCommand, type SlashTurnResult } from './chat.ts'
import {
  piChildren,
  piRuntime,
  readChildTranscript,
  requireReadablePiRuntime,
  transcript,
  waitFor,
  type PiChild,
  type SessionKey,
  type TranscriptMessage,
} from './state.ts'

/** The `toolUseId` prefix `recordForkResultInTranscript` mints. */
export const FORK_TOOL_USE_PREFIX = 'subtask-'

/** A child is settled once it leaves the two live statuses. */
const LIVE_STATUSES = /^(starting|running)$/

export interface ForkEntry {
  agentId: string
  toolUseId: string
  /** `toolResult` — the fork's answer, or the stated outcome when it failed. */
  result: string
  toolStatus?: string
  displayName?: string
}

/**
 * What the parent transcript records for each settled fork.
 *
 * **Recorded deviation — `fork_start_line`.** The `/subtask` START line is a
 * transient `info` event: it is emitted when the fork spawns and is not
 * persisted, so it is absent from `getSessionMessages` on any read that is not
 * racing the spawn. That is deliberate — `fork-transcript-entry.ts` says the
 * panel is the live surface and the transcript entry is the record — so a case
 * asserting "the session announced the fork" fails on documented behaviour.
 * `c842b3c7` is what the product guarantees now, and it is what this reads.
 */
export function forkEntries(messages: readonly TranscriptMessage[]): ForkEntry[] {
  return messages
    .filter(m => m.role === 'tool' && (m.toolUseId ?? '').startsWith(FORK_TOOL_USE_PREFIX) && m.toolResult !== undefined)
    .map(m => ({
      agentId: m.toolUseId!.slice(FORK_TOOL_USE_PREFIX.length),
      toolUseId: m.toolUseId!,
      result: m.toolResult ?? '',
      toolStatus: m.toolStatus,
      displayName: m.toolDisplayName,
    }))
}

/**
 * A fork needs a conversation to fork FROM.
 *
 * A session created by `freshSession()` has never run a turn, so it has no Pi
 * session file, and `/subtask` in it fails closed:
 *
 *   fork-not-started: this fork could not inherit the parent conversation, so it
 *   was NOT started … Pi branch preflight failed: no parent Pi session file found
 *   in …/.pi-sessions
 *
 * That refusal is correct product behaviour — it is the fail-closed half of
 * "a fork inherits everything", and it says so in plain words. It is also a
 * precondition every fork case has to satisfy for itself, which the first
 * fresh-session run of AGT-2 did not: it measured the panel's rendering of a
 * fork that the app had rightly refused to start.
 *
 * One completed turn is enough. The content is deliberately trivial for cases
 * that only need a forkable session; AGT-1 plants real history instead.
 */
export async function seedForkableConversation(session: CdpSession, key: SessionKey): Promise<void> {
  await sendPrompt(session, key, 'Reply with the single word READY.')
}

/**
 * The fail-closed refusal, when a fork never started at all.
 *
 * A refused fork still registers as a child with `status: 'failed'`, so
 * "children is non-empty" is true for one that never ran. Cases that go on to
 * steer or stop a fork must separate the two.
 */
export function forkStartFailure(child: PiChild | undefined): string | undefined {
  if (!child?.error) return undefined
  return /fork-not-started/.test(child.error) ? child.error : undefined
}

export interface StartedFork {
  selection: SlashTurnResult
  /** The registered child, or undefined when nothing ever registered. */
  child?: PiChild
  /** Every child seen at the moment registration was decided. */
  children: PiChild[]
}

/**
 * Select `/subtask` from the palette, submit `task`, and wait for a NEW child to
 * register.
 *
 * `noWait` is deliberate: there is no turn to wait for. Registration is the
 * first thing that can be true or false about a fork, and it is the thing that
 * was false on 2026-07-30's second run.
 *
 * "New" is load-bearing. `childState.children` accumulates every child the
 * session has ever had, so picking the first `fork` entry returns the OLDEST
 * one. A second `/subtask` in the same session then handed back the first fork —
 * already `completed` — and AGT-2 tried to press Stop on it.
 */
export async function startFork(
  session: CdpSession,
  key: SessionKey,
  task: string,
  options: { registerTimeoutMs?: number } = {},
): Promise<StartedFork> {
  // D1.265 — a BASELINE taken from a failed read is the worst of the three
  // outcomes: it is empty, so a child left over from an earlier prompt scores as
  // FRESH and the case reports a spawn that did not happen.
  const before = new Set((await piChildren(session, key, 'the fork baseline')).map(c => c.agentId))
  const selection = await sendSlashCommand(session, key, {
    token: 'subtask',
    match: /subtask/i,
    expectComposer: '/subtask ',
    argument: task,
    noWait: true,
  })
  const runtime = await waitFor(
    () => piRuntime(session, key),
    r => r.children.some(c => !before.has(c.agentId)),
    {
      timeoutMs: options.registerTimeoutMs ?? 90_000,
      intervalMs: 2_000,
      label: 'childState.children to gain a NEW fork',
    },
  ).catch(() => piRuntime(session, key))
  // D1.265 — the poll's own fallback read is where an unreadable snapshot
  // arrives as `{ children: [] }`, which every caller of this helper then
  // reports as "no fork registered".
  requireReadablePiRuntime(runtime, 'a NEW fork child in childState.children')
  const fresh = runtime.children.filter(c => !before.has(c.agentId))
  const child = fresh.find(c => /^fork$/i.test(c.agent)) ?? fresh[0]
  return { selection, ...(child ? { child } : {}), children: runtime.children }
}

/** Poll until the child leaves `starting`/`running`, or the deadline passes. */
export async function waitForForkSettled(
  session: CdpSession,
  key: SessionKey,
  agentId: string,
  timeoutMs = 300_000,
): Promise<PiChild | undefined> {
  const settled = await waitFor(
    async () => (await piRuntime(session, key)).children.find(c => c.agentId === agentId),
    child => child !== undefined && !LIVE_STATUSES.test(child.status),
    { timeoutMs, intervalMs: 3_000, label: `fork ${agentId} to settle` },
    // D1.265 — the fallback read after the deadline, guarded: without it an
    // unreadable snapshot answers `undefined` here and reads as "the fork never
    // settled", which is a different finding with a different owner.
  ).catch(async () => (await piChildren(session, key, `fork ${agentId} to settle`)).find(c => c.agentId === agentId))
  return settled
}

export interface ForkOutcome {
  child?: PiChild
  /** The parent's durable record for this fork, once it lands. */
  entry?: ForkEntry
  /** The child's own transcript, read through `read_child`. */
  childTranscript: string
  childTranscriptError?: string
}

/**
 * Wait for a fork to settle, then collect BOTH records of what it did.
 *
 * The child transcript is read first and unconditionally: `read_child` answers
 * for a child that failed or was stopped too, and a case that only ever reads
 * the happy path cannot tell "the fork said nothing" from "the fork never ran".
 */
export async function collectFork(
  session: CdpSession,
  key: SessionKey,
  agentId: string,
  options: { settleTimeoutMs?: number; entryTimeoutMs?: number } = {},
): Promise<ForkOutcome> {
  const child = await waitForForkSettled(session, key, agentId, options.settleTimeoutMs ?? 300_000)
  const read = await readChildTranscript(session, key, agentId)
  const entry = await waitFor(
    async () => forkEntries(await transcript(session, key)).find(e => e.agentId === agentId),
    value => value !== undefined,
    {
      timeoutMs: options.entryTimeoutMs ?? 60_000,
      intervalMs: 2_000,
      label: `the parent transcript to record fork ${agentId}`,
    },
  ).catch(() => undefined)
  return {
    ...(child ? { child } : {}),
    ...(entry ? { entry } : {}),
    childTranscript: read.output,
    ...(read.ok ? {} : { childTranscriptError: read.error ?? 'read_child returned ok:false' }),
  }
}
