/**
 * What a settled `/subtask` fork leaves in the MAIN transcript (D17).
 *
 * `sub-agents.md:1019` — "The fork appears in a panel below your prompt and runs
 * in the background while you keep working." The panel is the LIVE surface and
 * stays that way; it is not a record. `/subtask` announced a fork with a
 * transient `info` event and then said nothing ever again, so anyone reading the
 * conversation afterwards — a reviewer, an incident review — saw a fork start
 * with no result attached, and after a reload not even that.
 *
 * Pure on purpose: `SessionManager` owns WHEN this is written (the child
 * service's exactly-once terminal observation) and WHERE it goes; everything
 * about WHICH records qualify and WHAT the entry says is decided here, where it
 * can be tested without standing up a session.
 */

import type { PiChildSessionRecordV1, PiChildStatusV1 } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import type { ToolStatus } from '@nessy-agent/core/types'

/** The transcript fields a settled fork contributes. */
export interface ForkTranscriptEntry {
  /** The fork's own task, so the entry reads on its own after a reload. */
  task: string
  /** The answer, or a stated outcome when there is none. NEVER empty. */
  result: string
  toolStatus: Extract<ToolStatus, 'completed' | 'error'>
  /**
   * The skill's name when this child was a `context: fork` SKILL fork rather
   * than a `/subtask` conversation fork. Absent for a conversation fork, which
   * keeps that entry byte-identical to what it was before skill forks existed.
   */
  skill?: string
}

const TERMINAL_STATUSES: ReadonlySet<PiChildStatusV1> = new Set(['completed', 'failed', 'stopped', 'interrupted'])

/**
 * The entry for one terminal child record, or null when the record is not a
 * user fork.
 *
 * Two conditions, both necessary:
 *
 * - `restrictions.fork` — the reserved fork type (`sub-agents.md:1010`), which
 *   `createPiChildSessionPort` already validates as the ONLY shape a fork
 *   request may take;
 * - no `ownerTaskId` — a fork the MODEL spawned through the `subagent` tool has
 *   one, and its result already reaches the transcript as that tool call's
 *   result. Writing a second entry for it would double-report the same run.
 *   `startSubtaskFork` passes no owner task, because `/subtask` is deliberately
 *   not a tool call (`:895`, `:1013`).
 *
 * Every terminal status produces an entry. A record that only logs successes is
 * worse than none for a review: silence after a failed or stopped fork is
 * indistinguishable from a fork still running.
 *
 * A `context: fork` SKILL fork qualifies too, under a third condition of its
 * own. `skills.md:571` — "The forked subagent runs in the background: you keep
 * working while it runs, and its result arrives in your conversation when it
 * completes" — is the whole reason: without an entry here, the DEFAULT dispatch
 * mode of a forked skill leaves nothing in the conversation at all. It is gated
 * on `record.background` because a `background: false` fork already returned its
 * result INTO the invoking turn (`:571`'s second sentence), so a second entry
 * would double-report the same answer.
 */
export function forkTranscriptEntry(record: PiChildSessionRecordV1): ForkTranscriptEntry | null {
  const skillFork = record.restrictions?.skillFork
  const skill = skillFork && record.background === true ? skillFork.name.trim() : undefined
  if (record.restrictions?.fork !== true && !skill) return null
  if (record.ownerTaskId !== undefined) return null
  if (!TERMINAL_STATUSES.has(record.status)) return null

  // A conversation fork's task is the short instruction the user typed. A skill
  // fork's is the whole SKILL BODY — up to 256 KiB of it — so the entry names
  // the skill instead of pasting the prompt back into the transcript.
  const task = skill ? `Forked skill: ${skill}` : record.task.trim()
  const subject = skill ? 'The forked skill' : 'The fork'
  const answer = (record.result || record.output || '').trim()
  const reason = (record.error || '').trim()

  if (record.status === 'completed') {
    return {
      task,
      // A fork that returned nothing is still a fact worth recording — the
      // alternative is an entry that reads as if the panel lost the answer.
      result: answer || `${subject} finished without returning a result.`,
      toolStatus: 'completed',
      ...(skill ? { skill } : {}),
    }
  }

  const outcome = record.status === 'failed'
    ? `${subject} failed${reason ? `: ${reason}` : '.'}`
    : record.status === 'stopped'
      ? `${subject} was stopped before it finished${reason ? `: ${reason}` : '.'}`
      : `${subject} was interrupted before it finished${reason ? `: ${reason}` : '.'}`
  // Partial work is the part an incident review actually wants; the outcome
  // line above says why it stops there.
  return {
    task,
    result: answer ? `${outcome}\n\n${answer}` : outcome,
    toolStatus: 'error',
    ...(skill ? { skill } : {}),
  }
}
