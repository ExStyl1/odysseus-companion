/**
 * AGT-1 — a user can fork the conversation (`/subtask`).
 *
 * docs/testing/cdp-live-checklist.md, "Cases":
 *   1. a real conversation of at least three turns
 *   2. `/subtask` a question that requires the parent's history
 *   3. the NEGATIVE control — a named subagent given the same prompt cannot
 *      answer it
 *   4. the command is `/subtask` and NOT `/fork`
 *
 * Four harness defects were found in the 2026-07-30 runs, all of which made this
 * case measure something other than the feature. Each is fixed here and named
 * where the fix lives, because a checklist entry that keeps needing the same
 * repair is a checklist entry nobody trusts:
 *
 * 1. **It ran in the operator's own 86-message session.** Every read was a read
 *    of somebody else's history. `freshSession()` now creates and opens the
 *    session the case talks in, and `fresh` is asserted — a fallback run cannot
 *    pass quietly.
 * 2. **The codeword leaked into MEMORY.md.** "Remember this codeword" reached the
 *    memory tool, the control subagent read it back out of the file, and the
 *    control failed for the harness's reason. `lib/codeword.ts` generates a
 *    prefix-free token per run, asks for no persistence, and SCANS the three
 *    memory files before the control is scored.
 * 3. **"the session announced the fork" failed on documented behaviour.** The
 *    start line is a transient info event (`fork_start_line` deviation); the
 *    guarantee is the RESULT entry `c842b3c7` writes. That is what is asserted.
 * 4. **The fork's answer was read with `lastAssistantText`.** A fork adds no
 *    assistant message, so that returned the parent's third-turn reply. The
 *    answer is read from the child's own transcript and from the parent's
 *    `subtask-<agentId>` tool result — see `lib/fork.ts`.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import { memoryLeaks, newCodeword, plantPrompt, recallPrompt } from '../lib/codeword.ts'
import { peekPalette } from '../lib/composer.ts'
import { collectFork, startFork } from '../lib/fork.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, listSessions, transcript } from '../lib/state.ts'
import type { CdpSession } from '../lib/connect.ts'

const ID = 'AGT-1'
const TITLE = '/subtask inherits the parent conversation; a named subagent does not; /fork is absent'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.check(
    'the case ran in a session it created',
    key.fresh,
    key.fresh ? undefined : `inherited ${key.inheritedMessages} messages — every read below is of history this case did not plant`,
  )

  const codeword = newCodeword()
  run.observe('codeword-length', codeword.length)

  // ---- 4. the command is /subtask, not /fork -------------------------------
  const subtaskEntries = await peekPalette(session, 'subtask')
  run.check('the palette offers a Subtask entry', subtaskEntries.some(t => /subtask/i.test(t)), JSON.stringify(subtaskEntries))
  const forkEntries = await peekPalette(session, 'fork')
  // `fork` also matches Subtask's own description ("Fork this conversation into
  // …"), so the finding is a row whose LABEL is Fork, not merely a row
  // mentioning the word.
  const forkLabelled = forkEntries.filter(t => /^\/?fork\b/i.test(t))
  run.check('no /fork entry exists (it is a different feature we do not have)', forkLabelled.length === 0, JSON.stringify(forkEntries))

  // ---- 1. three real turns, planting a fact only this session knows ---------
  await sendPrompt(session, key, plantPrompt(codeword))
  await sendPrompt(session, key, 'Also note: I asked you to avoid the word "banana". Reply with the single word OK.')
  const third = await sendPrompt(session, key, 'How many things have I asked you to keep in mind so far? Answer with a digit.')
  run.observe('parent-third-turn', lastAssistantText(third.added).slice(0, 200))
  const historyLength = third.messages.length
  run.require('the parent conversation ran three turns', historyLength >= 6, `${historyLength} messages`)

  // ---- 2. /subtask, selected from the palette, asking the inherited fact ----
  const started = await startFork(session, key, recallPrompt())
  run.observe('palette-items', started.selection.selection.paletteItems)
  run.observe('key-sequence', started.selection.selection.keySequence)
  run.observe('composer-after-selection', started.selection.selection.composerAfter)
  run.observe('children', started.children)
  run.require(
    'the fork registered in childState.children',
    started.child !== undefined,
    // Only on failure: a passing line that reads "no child registered" is its own
    // small lie, and this file exists because of misleading evidence.
    started.child ? undefined : 'no child registered — nothing below can distinguish a fork from the parent answering',
  )
  run.check('the registered child is a fork running in the background', started.child!.agent === 'fork' && started.child!.background === true, JSON.stringify(started.child))

  const outcome = await collectFork(session, key, started.child!.agentId)
  run.observe('fork-child-final', outcome.child ?? null)
  run.observe('fork-child-transcript', outcome.childTranscript.slice(0, 600))
  if (outcome.childTranscriptError) run.observe('fork-child-transcript-error', outcome.childTranscriptError)

  // The `fork_start_line` deviation: the `/subtask` START line is a transient
  // info event and is deliberately not persisted, so asserting it fails on
  // documented behaviour. `c842b3c7` made the RESULT the durable record, and
  // that is what a reviewer reading the conversation afterwards actually needs.
  run.observe('fork-entry', outcome.entry ?? null)
  run.check(
    'the fork result is written into the parent transcript',
    outcome.entry !== undefined,
    outcome.entry ? undefined : 'no subtask-<agentId> tool result — c842b3c7 regressed, or the fork never settled',
  )

  // ---- THE question this case exists to answer -----------------------------
  // Read from the CHILD's own transcript and from the parent's record of it.
  // Never from the newest assistant message: a fork writes none, so that read
  // returns the parent's own last answer and looks like a pass.
  const forkAnswer = outcome.entry?.result ?? ''
  run.observe('fork-answer', forkAnswer.slice(0, 300))
  run.check(
    'the fork answered with the parent-only codeword',
    forkAnswer.includes(codeword),
    forkAnswer ? forkAnswer.slice(0, 200) : '(no fork result recorded)',
  )
  run.check(
    "the codeword is in the child's own transcript",
    outcome.childTranscript.includes(codeword),
    `${outcome.childTranscript.length} chars read through read_child`,
  )

  // ---- 3. the negative control ---------------------------------------------
  // A fork that inherits nothing looks identical to a working fork until
  // something that CANNOT inherit is asked the same question.
  const leaksBefore = await memoryLeaks(codeword, {
    workspaceId: key.workspaceId,
    sessionId: key.sessionId,
    ...(await workingDirectory(session, key.sessionId)),
  })
  run.observe('memory-leaks', leaksBefore)

  const before = (await transcript(session, key)).length
  const control = await sendPrompt(
    session,
    key,
    'Delegate this to a named subagent with a fresh context (do not answer it yourself): ' +
      `"${recallPrompt()}" Then report the subagent's answer verbatim.`,
    240_000,
  )
  const delegations = control.added.filter(m => m.role === 'tool' && /agent|task|subagent/i.test(m.toolName ?? ''))
  const usedSubagent = delegations.length > 0
  run.observe('control-tools', control.added.filter(m => m.role === 'tool').map(m => m.toolName))
  const controlAnswer = lastAssistantText(control.added)
  run.observe('control-answer', controlAnswer.slice(0, 300))

  // The confound this control has to survive: the PARENT composes the delegate's
  // prompt, and the parent knows the codeword. If it writes the answer into the
  // task, the subagent repeating it says nothing about isolation — it is the
  // parent's own knowledge coming back through a longer pipe. So read the
  // delegation's INPUT, not only its result, and let the two verdicts differ.
  const delegatedInput = JSON.stringify(delegations.map(m => m.toolInput ?? {}))
  const delegatedResults = delegations.map(m => m.toolResult ?? '').join('\n')
  run.observe('control-subagent-input', delegatedInput.slice(0, 500))
  run.observe('control-subagent-result', delegatedResults.slice(0, 300))
  const parentLeakedIntoPrompt = delegatedInput.includes(codeword)
  run.observe('control-parent-leaked-into-prompt', parentLeakedIntoPrompt)

  if (leaksBefore.length > 0) {
    blocked(
      'the negative control is VOID: the codeword is sitting in ' +
        leaksBefore.map(l => `${l.scope} memory (${l.path})`).join(', ') +
        '. A named subagent reads that file through its own prompt, so "it could not answer" would prove nothing either way. ' +
        'Remove the line and re-run; if the model wrote it despite being told not to, that is a product finding about memory ' +
        'persistence, not a fork finding.',
    )
  }
  if (!usedSubagent) {
    blocked(
      'the negative control never ran: no subagent tool call appeared in the transcript, so "the named subagent could not ' +
        `answer" is untested. Re-run with a named subagent available. (${control.messages.length - before} messages added)`,
    )
  }
  if (parentLeakedIntoPrompt) {
    blocked(
      'the negative control is VOID: the parent wrote the codeword into the subagent\'s own task input, so the subagent ' +
        'was TOLD the answer rather than having to know it. This is a limit of delegating through the model — the parent ' +
        'composes the delegate\'s prompt and it knows the secret. Distinguish it from a real isolation defect by the ' +
        '`control-subagent-input` observation: the codeword present there means the harness leaked it, absent there and ' +
        'present in `control-subagent-result` means the named subagent really did inherit the parent context.',
    )
  }
  // Score the DELEGATE's own result. The parent's narration is deliberately NOT
  // a check: the parent has always known the codeword, so it repeating one is a
  // fact about the model's honesty, not about child isolation. It stays in
  // `control-answer` as evidence and nothing is asserted on it.
  run.check(
    'a named subagent could NOT produce the codeword',
    !delegatedResults.includes(codeword),
    delegatedResults.slice(0, 200) || '(the subagent returned nothing)',
  )
}

/** The session's cwd, so the project-scope MEMORY.md is scanned too. */
async function workingDirectory(session: CdpSession, sessionId: string): Promise<{ workingDirectory?: string }> {
  const found = (await listSessions(session)).find(s => s.id === sessionId)?.workingDirectory
  return found ? { workingDirectory: found } : {}
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
