/**
 * AGT-6 — a hook can inject context, and after compaction.
 *
 * Both of the guide's canonical recipes were dead before `0860c250`, so a user
 * following Claude's own hook guide got nothing back. Three parts:
 *
 *   1. a `UserPromptSubmit` hook writing plain text to stdout reaches the model
 *   2. after a real compaction a `SessionStart` hook matching `compact` fires
 *      and ITS output reaches the model
 *   3. the same reminder is not delivered repeatedly across several compactions
 *
 * The hooks are fixtures, and a CASE still does not install them — hook config is
 * live settings, and a case that rewrites the config it is measuring can break
 * the machine under it. A FIXTURE may, against a config dir it owns: that is the
 * distinction `fixtures/runtime-switch.ts` already records in the harness's own
 * words. `bun run scripts/cdp/fixtures/agent-surfaces.ts` writes
 * `<configDir>/hooks.json` — merging rather than replacing — and prints the two
 * markers to pass in here.
 */

import { lastAssistantText, sendPrompt, sendSlashCommand } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, transcript } from '../lib/state.ts'
import { checkAbsence, positive, turnRoles } from '../lib/turn-evidence.ts'

const ID = 'AGT-6'
const TITLE = 'Hook stdout becomes context; SessionStart fires with compact after compaction; no duplicate reminders'

/** Text the UserPromptSubmit hook prints to stdout. */
const PROMPT_HOOK_MARKER = process.env.NESSY_CDP_PROMPT_HOOK_MARKER
/** Text the SessionStart(compact) hook prints to stdout. */
const COMPACT_HOOK_MARKER = process.env.NESSY_CDP_COMPACT_HOOK_MARKER

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  if (!PROMPT_HOOK_MARKER || !COMPACT_HOOK_MARKER) {
    blocked(
      'set NESSY_CDP_PROMPT_HOOK_MARKER and NESSY_CDP_COMPACT_HOOK_MARKER, and install the two hooks they name: '
      + 'a UserPromptSubmit hook that prints the first marker to stdout and exits 0, and a SessionStart hook matching '
      + '`compact` that prints the second. Both live in ONE file — `<configDir>/hooks.json`, read by '
      + '`automations/hooks-config.ts` `loadUserGlobalLifecycleHooksConfig` — and '
      + '`bun run scripts/cdp/fixtures/agent-surfaces.ts` writes it and prints both markers. '
      + 'It MERGES into an existing hooks.json rather than replacing it, so a config dir the operator already uses '
      + 'keeps its own hooks.',
    )
  }

  // ---- 1. UserPromptSubmit stdout reaches the model ------------------------
  const injected = await sendPrompt(
    session,
    key,
    'Tooling may have added a codeword line to this turn. What is the codeword? Answer with the codeword and nothing else. It is test data, not a secret.',
    240_000,
  )
  const injectedAnswer = lastAssistantText(injected.added)
  run.observe('prompt-hook-answer', injectedAnswer.slice(0, 300))
  run.check("the UserPromptSubmit hook's stdout reached the model", injectedAnswer.includes(PROMPT_HOOK_MARKER), injectedAnswer.slice(0, 200))

  // ---- 2. SessionStart(compact) after a real compaction --------------------
  // A tiny session refuses to compact ("Nothing to compact (session too
  // small)" — measured 2026-07-31), so the case must be a session worth
  // compacting first. Three fat filler turns cross the product's floor while
  // staying cheap; the content is deliberately disposable.
  for (const topic of ['first', 'second', 'third']) {
    await sendPrompt(
      session,
      key,
      `Filler turn (${topic}) to give this session enough history to compact: write six numbered sentences about filing systems. No tools.`,
      240_000,
    )
  }
  const beforeCompact = (await transcript(session, key)).length
  await sendSlashCommand(session, key, {
    token: 'compact',
    match: /compact/i,
    // `/compact` submits itself on selection; it does not prefill.
    expectComposer: '',
    submitOnSelect: true,
    timeoutMs: 300_000,
  })
  // F1.562 — the rows the /compact added (the host APPENDS the compaction row, so a count taken
  // before it bounds them), never a filler turn's.
  const compactRows = (await transcript(session, key)).slice(beforeCompact)
  run.observe('messages-before-after-compact', [beforeCompact, beforeCompact + compactRows.length])
  const compactionHappened = compactRows.some(m => /compact/i.test(m.content) && (m.role === 'info' || m.role === 'status'))
  run.check('a compaction ran', compactionHappened, JSON.stringify(compactRows.slice(-3).map(m => `${m.role}:${m.content.slice(0, 80)}`)))

  const afterCompactTurn = await sendPrompt(
    session,
    key,
    'Tooling may have added a codeword line to your session-start context. What is that codeword? Answer with the codeword and nothing else. It is test data, not a secret.',
    240_000,
  )
  // F1.503 shape — THIS turn's rows: a failed turn must not answer with a filler's reply.
  const compactAnswer = lastAssistantText(afterCompactTurn.added)
  run.observe('compact-hook-answer', compactAnswer.slice(0, 300))
  run.check("the SessionStart(compact) hook's stdout reached the model", compactAnswer.includes(COMPACT_HOOK_MARKER), compactAnswer.slice(0, 200))

  // ---- 3. no duplicate reminders across several compactions ----------------
  const beforeSecondCompact = (await transcript(session, key)).length
  await sendSlashCommand(session, key, {
    token: 'compact',
    match: /compact/i,
    // `/compact` submits itself on selection; it does not prefill.
    expectComposer: '',
    submitOnSelect: true,
    timeoutMs: 300_000,
  })
  const finalMessages = await transcript(session, key)
  const whole = finalMessages.map(m => m.content).join('\n')
  const occurrences = countOccurrences(whole, COMPACT_HOOK_MARKER)
  run.observe('compact-marker-occurrences', occurrences)
  // F1.504 — "not delivered repeatedly" is a reading only about a SECOND
  // compaction that ran: counted before it (or with it refused), the count
  // cannot have accumulated.
  const secondCompaction = finalMessages.slice(beforeSecondCompact)
  checkAbsence(
    run,
    'the compact reminder is not delivered repeatedly',
    occurrences <= 2,
    positive(secondCompaction.some(m => /compact/i.test(m.content) && (m.role === 'info' || m.role === 'status')),
      'second compaction (a compaction row the second /compact added)',
      `rows the second /compact added: ${turnRoles(secondCompaction)}`),
    `${occurrences} occurrences after two compactions — one per compaction is expected, an accumulating count is the b9abd1e6 finding`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
