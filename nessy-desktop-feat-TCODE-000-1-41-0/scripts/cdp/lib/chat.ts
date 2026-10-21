/**
 * Turn-level flows: say something, run a slash command, wait for the reply.
 *
 * `sendSlashCommand` is the one that matters. It refuses to submit unless the
 * palette entry was selected and the app itself prefilled the composer, so the
 * "typed it as prose and called it a command" failure cannot recur silently.
 */

import type { CdpSession } from './connect.ts'
import { clearComposer, readComposer, selectSlashCommand, submitComposer, typeIntoComposer, type SelectSlashCommandResult } from './composer.ts'
import { turnBaseline, waitForTurn, type SessionKey, type TranscriptMessage, type TurnBaseline } from './state.ts'
import { typeText } from './keys.ts'

export interface TurnResult {
  before: number
  messages: TranscriptMessage[]
  added: TranscriptMessage[]
}

/**
 * Wait for the turn a send started, measured against the baseline read BEFORE
 * the send (F1.491) — `lastMessageAt` included, because a command answered
 * with no turn (`/heapdump`: one user row, no `isProcessing`, no reply) leaves
 * no other trace a poll can see.
 */
async function completeTurn(session: CdpSession, key: SessionKey, baseline: TurnBaseline, timeoutMs: number): Promise<TurnResult> {
  const messages = await waitForTurn(session, key, baseline, timeoutMs)
  return { before: baseline.count, messages, added: messages.slice(baseline.count) }
}

/** Type a plain prompt and wait for the turn to finish. */
export async function sendPrompt(session: CdpSession, key: SessionKey, text: string, timeoutMs = 180_000): Promise<TurnResult> {
  const baseline = await turnBaseline(session, key)
  await clearComposer(session)
  await typeIntoComposer(session, text)
  const typed = await readComposer(session)
  // `innerText` collapses the contenteditable's own whitespace, so compare on a
  // normalised form rather than failing a real run over a stray newline.
  const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim()
  if (normalise(typed) !== normalise(text)) {
    throw new Error(`composer-mismatch: meant to send ${JSON.stringify(text)}, composer holds ${JSON.stringify(typed)}`)
  }
  await submitComposer(session)
  return completeTurn(session, key, baseline, timeoutMs)
}

export interface SlashTurnOptions {
  token: string
  match: RegExp
  /** The app's own prefill after selection, e.g. `"/subtask "`. Asserted. */
  expectComposer: string
  /** Argument text typed AFTER the entry is selected. */
  argument?: string
  timeoutMs?: number
  /** Do not wait for a turn to complete (for commands that open UI instead). */
  noWait?: boolean
  /**
   * The command submits itself on selection rather than prefilling.
   * `slash-command-actions.ts` splits these: only `subtask` is a PREFILL_COMMAND;
   * `/compact`, `/clear`, `/help`, `/init` and the permission modes act
   * immediately, leaving the composer empty.
   */
  submitOnSelect?: boolean
}

export interface SlashTurnResult extends Partial<TurnResult> {
  selection: SelectSlashCommandResult
  submitted: string
}

/**
 * Select a slash command from the palette, type its argument, submit.
 *
 * Order matters: the palette closes the moment the caret leaves the slash-token,
 * so the entry must be committed before the argument is typed.
 */
export async function sendSlashCommand(session: CdpSession, key: SessionKey, options: SlashTurnOptions): Promise<SlashTurnResult> {
  const baseline = await turnBaseline(session, key)
  await clearComposer(session)
  const selection = await selectSlashCommand(session, {
    token: options.token,
    match: options.match,
    expectComposer: options.expectComposer,
  })
  if (options.submitOnSelect) {
    if (options.noWait) return { selection, submitted: options.expectComposer }
    const turn = await completeTurn(session, key, baseline, options.timeoutMs ?? 180_000)
    return { selection, submitted: options.expectComposer, ...turn }
  }
  if (options.argument) await typeText(session, options.argument, { charDelayMs: 8 })
  const submitted = await readComposer(session)
  if (!submitted.startsWith(options.expectComposer)) {
    throw new Error(`slash-command-lost: composer holds ${JSON.stringify(submitted)}, which does not start with the app's own ${JSON.stringify(options.expectComposer)}`)
  }
  await submitComposer(session)
  if (options.noWait) return { selection, submitted }
  const turn = await completeTurn(session, key, baseline, options.timeoutMs ?? 180_000)
  return { selection, submitted, ...turn }
}

export function lastAssistantText(messages: TranscriptMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role === 'assistant' && message.content.trim().length > 0) return message.content
  }
  return ''
}

export function infoTexts(messages: TranscriptMessage[]): string[] {
  return messages.filter(m => m.role === 'info' || m.role === 'status' || m.role === 'warning').map(m => m.content)
}
