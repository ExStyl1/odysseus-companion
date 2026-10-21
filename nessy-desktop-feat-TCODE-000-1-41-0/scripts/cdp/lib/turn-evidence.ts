/**
 * What ONE turn did, read off the rows that turn added — never off the whole
 * transcript, and never off the user's own row.
 *
 * `TurnResult.added` is `messages.slice(before)`, and the first row of it is the
 * USER's prompt (the host appends and flushes it before the turn starts —
 * F1.260, F1.491). So a check that joins `added` and tests it for a word can be
 * answered by the prompt that asked for the word: RS-99's D1.137 check tested
 * the joined rows for `NO FEEDBACK SHOWN` while its own prompt said "say the
 * words NO FEEDBACK SHOWN", and it could not pass on any run (F1.506). The
 * helpers here read the rows the turn's OWN producers wrote.
 */

import type { CaseRun } from './report.ts'
import type { TranscriptMessage } from './state.ts'

/** The rows THIS turn added that the user did not write. */
export function turnOwnRows(added: readonly TranscriptMessage[]): TranscriptMessage[] {
  return added.filter(row => row.role !== 'user')
}

/** The content of those rows, joined — the turn's own text, the prompt left out. */
export function turnOwnText(added: readonly TranscriptMessage[]): string {
  return turnOwnRows(added).map(row => row.content).join('\n')
}

/**
 * The turn's last non-empty assistant reply, `''` when it wrote none (F1.503).
 *
 * The whole-transcript form — `lastAssistantText` handed `turn.messages` —
 * answers a turn that FAILED with the reply of the turn before it: agt-9's "the
 * turn after compaction completes" read the previous filler's reply when the
 * post-compaction turn was the over-window error the check exists to catch.
 * (A ratchet in `turn-evidence.test.ts` counts that form as a CALL, which is
 * why this comment spells it in words.)
 */
export function turnReply(added: readonly TranscriptMessage[]): string {
  for (let index = added.length - 1; index >= 0; index -= 1) {
    const row = added[index]!
    if (row.role === 'assistant' && row.content.trim().length > 0) return row.content
  }
  return ''
}

/**
 * THIS turn's rows whether its send completed or THREW (F1.521, origin WJ-al P-WJ-al-1).
 *
 * A completed send hands them back (`TurnResult.added`). A send that threw — a
 * timeout, a turn that never started — hands back none, and the fallback twelve
 * cases carried read the WHOLE transcript whenever `added` came back empty, so an
 * earlier turn's tool rows and reply answered a check about this one. The
 * fallback is now the rows past `before`, the transcript length the caller read
 * BEFORE the send: what the failed turn did write (its prompt, a tool row, a
 * partial reply) and nothing older. (`turn-rows-since.test.ts` bans the old
 * fallback, which is why this comment describes it in words.)
 */
export async function turnRowsSince(
  read: () => Promise<TranscriptMessage[]>,
  added: readonly TranscriptMessage[],
  before: number,
): Promise<TranscriptMessage[]> {
  if (added.length > 0) return [...added]
  return (await read().catch(() => [] as TranscriptMessage[])).slice(before)
}

// ---- F1.504 — an ABSENCE is only evidence beside a same-turn POSITIVE -------

/**
 * Something the SAME turn did that an absence check needs before it can mean
 * anything: "no card", "no leak", "the file does not exist" are all true of a
 * turn that errored, refused or said nothing. `what` names the positive, and
 * `saw` says what was read, so an UNMEASURED line names what was missing.
 */
export interface SameTurnPositive {
  readonly ok: boolean
  readonly what: string
  readonly saw: string
}

/** A positive the case computed itself (a card rose, a tool call was recorded, a log grew). */
export function positive(ok: boolean, what: string, saw: string): SameTurnPositive {
  return { ok, what, saw }
}

/** `[user, tool, assistant]` — the shape of a turn, for a detail line. */
export function turnRoles(added: readonly TranscriptMessage[]): string {
  return `[${added.map(row => row.role).join(', ')}]`
}

/**
 * The turn ANSWERED: an assistant reply of at least `minChars` non-blank
 * characters and no `error` row. An erroring turn fails it even when some text
 * streamed before the error — a half-written turn is not the turn the absence
 * beside it is about.
 */
export function turnAnswered(added: readonly TranscriptMessage[], minChars = 1): SameTurnPositive {
  const reply = turnReply(added).trim()
  const errors = added.filter(row => row.role === 'error').map(row => row.content.slice(0, 120))
  return positive(
    reply.length >= minChars && errors.length === 0,
    'answer (a non-empty assistant reply and no error row)',
    `${reply.length} chars of reply; rows this turn added: ${turnRoles(added)}`
      + (errors.length > 0 ? `; errors: ${JSON.stringify(errors)}` : ''),
  )
}

/** The turn CALLED a tool — any tool row, or one `match` accepts. */
export function turnCalledTool(
  added: readonly TranscriptMessage[],
  match: (row: TranscriptMessage) => boolean = () => true,
  what = 'tool call',
): SameTurnPositive {
  const tools = added.filter(row => row.role === 'tool' || Boolean(row.toolName))
  const hits = tools.filter(match)
  return positive(
    hits.length > 0,
    what,
    `${hits.length} matching of ${tools.length} tool row(s): ${JSON.stringify(tools.map(row => `${row.toolName ?? '?'}:${row.toolStatus ?? '?'}`))}`,
  )
}

export type AbsenceRecorder = Pick<CaseRun, 'check' | 'require' | 'observe'>

function absenceVerdict(absent: boolean, same: SameTurnPositive, detail?: string): { ok: boolean; detail?: string } {
  if (!same.ok) {
    return {
      ok: false,
      detail: `UNMEASURED — the same turn shows no ${same.what} (${same.saw}). An absence read off a turn that did `
        + 'nothing observable — errored, refused or said nothing — is not evidence'
        + (absent ? '' : `; and the absence failed too: ${detail ?? '(no detail)'}`),
    }
  }
  return { ok: absent, ...(detail ? { detail } : {}) }
}

/**
 * Record an ABSENCE check that can only PASS beside its same-turn positive
 * (F1.504, origin WJ-ad P-WJ-ad-2; AGENTS.md: "An ABSENCE finding needs a
 * positive control on the same rig"). One check line, under the case's own
 * label: it passes when the positive holds AND the thing is absent; a turn that
 * did nothing observable FAILS it as UNMEASURED rather than passing it. The
 * positive is observed beside it either way, so a PASS line says what it stood
 * on. Every absence a case scores off a model turn goes through here — a
 * `run.check(label, <nothing happened>)` is the shape this replaces.
 */
export function checkAbsence(
  run: AbsenceRecorder,
  label: string,
  absent: boolean,
  same: SameTurnPositive,
  detail?: string,
): boolean {
  run.observe(`${label} — same-turn positive`, same)
  const verdict = absenceVerdict(absent, same, detail)
  return run.check(label, verdict.ok, verdict.detail)
}

/** `checkAbsence` that stops the case, for an absence the rest of the case stands on. */
export function requireAbsence(
  run: AbsenceRecorder,
  label: string,
  absent: boolean,
  same: SameTurnPositive,
  detail?: string,
): void {
  run.observe(`${label} — same-turn positive`, same)
  const verdict = absenceVerdict(absent, same, detail)
  run.require(label, verdict.ok, verdict.detail)
}
