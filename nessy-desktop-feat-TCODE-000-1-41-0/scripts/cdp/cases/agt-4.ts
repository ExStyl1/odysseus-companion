/**
 * AGT-4 — a fork is inside the parent's scope; a named subagent is outside it.
 *
 * Three properties, each needing BOTH halves. Testing only the fork proves half
 * the rule, and the half it skips is the one that was wrong.
 *
 *   output style   fork follows it, named subagent does not
 *   rewind         rewinding the parent reverts the fork's edit, not the
 *                  subagent's
 *   session memory fork knows it, named subagent does not
 *
 * Two of the three need a fixture the harness must not invent for itself: a
 * custom output style with a recognisable instruction, and a memory entry with a
 * marker. Both are supplied through env vars, and the case BLOCKS — not passes,
 * not fails — when they are absent. `MemoryAppendScope` is `project | user`
 * only, so the memory half writes into the operator's own files and is opt-in.
 *
 * ## The rewind half is now DRIVEN, and what it used to be
 *
 * This case carried a hard-coded `run.check(…, false, 'not driven: …')` where
 * the file-level assertion belongs. That is worse than an honest block:
 * `lib/report.ts` `runCase` lets a failed check beat a `BlockedError`, so the
 * moment the two env vars arrived the row would have flipped from BLOCKED to
 * **FAIL** — a red about a half nobody had exercised.
 *
 * It is replaced by the real thing, and the mechanism it measures is explicit in
 * the product: `SessionManager.rewindToMessage` with `restoreFiles` reverts
 * every file checkpoint newer than the anchor in the PARENT's session path, and
 * then calls `revertForkChildCheckpoints`, which selects
 * `children.filter(child => child.restrictions.fork === true)` — forks, and only
 * forks. A named subagent's checkpoints live in its own child session path and
 * are deliberately not scanned. So:
 *
 *   the fork's file      must lose its token (its checkpoint is reverted)
 *   the subagent's file  must keep its token (its checkpoint is not)
 *
 * ## What stops this half from reporting a defect that is not there
 *
 * A model that declines to write, or a tool grant without a write tool, leaves
 * BOTH files missing — and "the fork's file no longer holds its token" is then
 * true for a run that measured nothing. So each arm's file is checked for
 * EXISTENCE before the rewind, and a missing one BLOCKS naming which arm failed
 * to write. The permission mode is moved to `acceptEdits` for the same reason a
 * fresh session's default `explore` would otherwise gate the write into a card
 * nobody answers.
 *
 * Programmatic surfaces used (no menu clicking):
 *   listOutputStyles / getOutputStyle / setOutputStyle   (ElectronAPI)
 *   sessionCommand { type: 'rewindToMessage', messageId, restoreFiles }
 *   sessionCommand { type: 'setPermissionMode', mode }
 */

import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { collectFork, forkStartFailure, seedForkableConversation, startFork } from '../lib/fork.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  piReadNote,
  piRuntime,
  readChildTranscript,
  sessionCommandResult,
  setPermissionMode,
  transcript,
  type SessionKey,
} from '../lib/state.ts'

const ID = 'AGT-4'
const TITLE = 'Output style, rewind and session memory each reach a fork and NOT a named subagent'

const STYLE_ID = process.env.NESSY_CDP_OUTPUT_STYLE_ID
const STYLE_MARKER = process.env.NESSY_CDP_OUTPUT_STYLE_MARKER
const MEMORY_MARKER = process.env.NESSY_CDP_MEMORY_MARKER

const SUBAGENT_PREAMBLE =
  'Delegate this to a named subagent with a fresh context and report its answer verbatim, without answering it yourself: '

/** `ConversationRewindResult`, restated — the cdp tsconfig resolves no aliases. */
interface RewindResult {
  success?: boolean
  error?: string
  restoredCheckpoints?: unknown[]
}

function probeToken(): string {
  return `AGT4-${randomBytes(5).toString('hex').toUpperCase()}`
}

/**
 * A fork's answer, read the only way it is actually recorded.
 *
 * `lastAssistantText` is wrong here for the same reason it was wrong in AGT-1: a
 * fork writes no assistant message, so it returns the PARENT's newest reply and
 * a style/memory assertion silently scores the parent instead of the fork.
 */
async function forkAnswer(run: CaseRun, session: CdpSession, key: SessionKey, label: string, task: string): Promise<string> {
  const started = await startFork(session, key, task)
  run.observe(`${label}-children`, started.children)
  if (!started.child) {
    run.check(`${label}: the fork registered`, false, 'no child registered — nothing below measures a fork')
    return ''
  }
  const refused = forkStartFailure(started.child)
  if (refused) {
    run.check(`${label}: the fork actually started`, false, refused)
    return ''
  }
  const outcome = await collectFork(session, key, started.child.agentId)
  run.observe(`${label}-child-final`, outcome.child ?? null)
  return outcome.entry?.result ?? ''
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  const styles = await session.call<Array<{ id?: string; name?: string }>>(`
    return await window.electronAPI.listOutputStyles(${JSON.stringify(key.workspaceId)})
  `)
  run.observe('output-styles', styles.map(s => s.id ?? s.name))

  if (!STYLE_ID || !STYLE_MARKER) {
    blocked(
      'set NESSY_CDP_OUTPUT_STYLE_ID and NESSY_CDP_OUTPUT_STYLE_MARKER first. The style must carry a distinctive instruction ' +
        '(e.g. "end every reply with the token OSTYLE-7788") and the marker is that token. A custom style is one markdown ' +
        'file in <configDir>/output-styles/, discovered as `custom:<slug>` (`prompts/output-styles.ts`); ' +
        '`bun run scripts/cdp/fixtures/agent-surfaces.ts` writes one and prints the id. Available styles: ' +
        JSON.stringify(styles.map(s => s.id ?? s.name)),
    )
  }

  // Every half of this case forks, and a fork needs a conversation to inherit.
  // After the fixture gate, so a BLOCKED run costs no model turn.
  await seedForkableConversation(session, key)

  // ---- 1. output style -----------------------------------------------------
  const applied = await session.call<{ success?: boolean; error?: string }>(`
    return await window.electronAPI.setOutputStyle(${JSON.stringify(STYLE_ID)})
  `)
  run.require('the custom output style applied', applied.success === true, JSON.stringify(applied))
  run.observe('output-style', await session.call<string>('return await window.electronAPI.getOutputStyle()'))

  const forkStyleAnswer = await forkAnswer(run, session, key, 'style', 'Reply with a one-sentence description of the weather on Mars.')
  run.observe('fork-styled-answer', forkStyleAnswer.slice(0, 300))
  run.check('the fork followed the output style', forkStyleAnswer.includes(STYLE_MARKER), forkStyleAnswer.slice(0, 200))

  const subagentStyle = await sendPrompt(
    session,
    key,
    `${SUBAGENT_PREAMBLE}"Reply with a one-sentence description of the weather on Venus."`,
    240_000,
  )
  const subagentStyleAnswer = lastAssistantText(subagentStyle.added)
  const delegated = subagentStyle.added.some(m => m.role === 'tool' && /agent|task|subagent/i.test(m.toolName ?? ''))
  run.observe('subagent-styled-answer', subagentStyleAnswer.slice(0, 300))
  run.observe('subagent-tools', subagentStyle.added.filter(m => m.role === 'tool').map(m => m.toolName))
  if (delegated) {
    // The negative half must read the CHILD's own words, never the parent's.
    // The parent's reply IS styled — output-styles.md:104 applies the style to
    // the main conversation — so its relay of the subagent's answer carries
    // the marker no matter what the child was composed with, and the previous
    // read (`lastAssistantText` of the parent transcript) filed a product
    // defect the composition seam did not have (2026-07-31 wave). `read_child`
    // returns the transcript composed under the child's OWN system prompt,
    // which is the surface the rule is about.
    const runtime = await piRuntime(session, key)
    const namedChildren = runtime.children.filter(child => child.agent !== 'fork')
    const namedChild = namedChildren[namedChildren.length - 1]
    // D1.310 — the read's own verdict travels with the list: an unreadable
    // snapshot answers `[]` for a session that HAS children, and without this
    // the observation reads as "no named child registered".
    run.observe('named-children', { ...piReadNote(runtime), children: namedChildren })
    if (!namedChild) {
      run.check('a named subagent did NOT follow the output style', false,
        runtime.readFailed === true
          ? 'a subagent tool ran and the runtime snapshot READ FAILED '
            + `(${runtime.unavailableReason ?? 'no reason reported'}) — whether a named child registered was not measured. `
            + 'See `rs-56.ts` for the packaged-build defect behind the failing read.'
          : 'a subagent tool ran but no named child registered — nothing to read')
    } else {
      const childRead = await readChildTranscript(session, key, namedChild.agentId)
      run.observe('subagent-own-answer', (childRead.output ?? '').slice(-300))
      run.check(
        'a named subagent did NOT follow the output style',
        childRead.ok === true && !childRead.output.includes(STYLE_MARKER),
        childRead.ok ? childRead.output.slice(-200) : `read_child failed: ${childRead.error ?? 'unknown'}`,
      )
    }
  } else {
    run.check('the named-subagent half ran', false, 'no subagent tool call appeared — the negative half is untested')
  }

  // ---- 2. rewind, at the FILE level ---------------------------------------
  const summary = (await listSessions(session)).find(s => s.id === key.sessionId)
  const cwd = summary?.workingDirectory
  run.observe('session working directory', cwd ?? '(none reported)')
  if (!cwd || !existsSync(cwd)) {
    blocked(
      `the session reports working directory ${JSON.stringify(cwd ?? null)}, which does not exist on this host, so `
      + 'neither arm has a place to write and the file-level rewind claim cannot be measured. Bind the session to a '
      + 'real directory (open a project in the app) before running this case.',
    )
  }

  const forkToken = probeToken()
  const namedToken = probeToken()
  const forkFile = join(cwd, `agt4-fork-${forkToken.slice(-8).toLowerCase()}.txt`)
  const namedFile = join(cwd, `agt4-named-${namedToken.slice(-8).toLowerCase()}.txt`)
  run.observe('probe files', { forkFile, namedFile })
  if (existsSync(forkFile) || existsSync(namedFile)) {
    blocked(`an artifact of this run's own name already exists in ${cwd} — refusing to measure over it`)
  }

  // The anchor has to predate both writes: `rewindToMessage` reverts only the
  // checkpoints whose `createdAt` is GREATER than the anchor message's
  // timestamp. Recorded here, before either arm runs.
  const beforeWrites = await transcript(session, key)
  const userMessages = beforeWrites.filter(m => m.role === 'user')
  const anchor = userMessages[userMessages.length - 1]
  run.require('there is a user message to rewind to', anchor !== undefined)
  run.observe('rewind anchor', { id: anchor!.id, at: anchor!.timestamp, text: anchor!.content.slice(0, 80) })

  // A fresh session lands in a mode that GATES a write (RTS-10 measured
  // `explore` letting a read-only tool through unasked and `default` asking).
  // `acceptEdits` is the mode whose whole meaning is "file edits do not ask";
  // the approver stays running underneath as a net for anything it misses.
  const previousMode = summary?.permissionMode
  await setPermissionMode(session, key.sessionId, 'acceptEdits')
  const approver = approvePermissionsWhile(session, key.sessionId)
  let rewind: RewindResult | undefined
  try {
    const forkWrite = await forkAnswer(
      run, session, key, 'rewind-fork',
      `Create a file at the absolute path ${forkFile} whose only line is exactly ${forkToken}. Then reply DONE.`,
    )
    run.observe('rewind-fork-answer', forkWrite.slice(0, 200))

    const namedWrite = await sendPrompt(
      session,
      key,
      `${SUBAGENT_PREAMBLE}"Create a file at the absolute path ${namedFile} whose only line is exactly ${namedToken}, then reply DONE."`,
      240_000,
    )
    run.observe('rewind-named-answer', lastAssistantText(namedWrite.added).slice(0, 200))

    const forkWrote = existsSync(forkFile) && (await readFile(forkFile, 'utf8').catch(() => '')).includes(forkToken)
    const namedWrote = existsSync(namedFile) && (await readFile(namedFile, 'utf8').catch(() => '')).includes(namedToken)
    run.observe('both arms wrote before the rewind', { forkWrote, namedWrote })
    if (!forkWrote || !namedWrote) {
      // NOT a check. A file that was never written is missing after the rewind
      // too, so scoring this run would report "the edit was reverted" about an
      // edit that never happened — the vacuous pass this half exists to avoid.
      blocked(
        `the rewind half was not exercised: the fork ${forkWrote ? 'wrote its file' : 'did NOT write ' + forkFile}, `
        + `the named subagent ${namedWrote ? 'wrote its file' : 'did NOT write ' + namedFile}. `
        + 'Separate the two causes before reading anything into it: the agent\'s tool grant may carry no write tool, '
        + 'or the model may have declined and answered in prose. Re-run; this is the model\'s choice, not a defect.',
      )
    }

    // ---- the rewind itself ------------------------------------------------
    rewind = await sessionCommandResult<RewindResult>(session, key.sessionId, {
      type: 'rewindToMessage', messageId: anchor!.id, restoreFiles: true,
    })
    run.observe('rewind result', {
      success: rewind?.success,
      error: rewind?.error,
      restoredCheckpoints: Array.isArray(rewind?.restoredCheckpoints) ? rewind.restoredCheckpoints.length : rewind?.restoredCheckpoints,
    })
    run.require('the rewind was accepted', rewind?.success !== false, rewind?.error ?? '')

    const afterRewind = (await transcript(session, key)).length
    run.observe('messages-before-after-rewind', [beforeWrites.length, afterRewind])
    run.check('the parent rewound', afterRewind < beforeWrites.length, `${beforeWrites.length} → ${afterRewind}`)

    const forkAfter = existsSync(forkFile) ? await readFile(forkFile, 'utf8').catch(() => '') : ''
    const namedAfter = existsSync(namedFile) ? await readFile(namedFile, 'utf8').catch(() => '') : ''
    run.observe('files after the rewind', {
      fork: existsSync(forkFile) ? `present, ${forkAfter.length} bytes` : 'gone',
      named: existsSync(namedFile) ? `present, ${namedAfter.length} bytes` : 'gone',
    })
    run.check(
      "the fork's edit was reverted by the parent's rewind",
      !forkAfter.includes(forkToken),
      forkAfter.includes(forkToken)
        ? `${forkFile} still carries ${forkToken} — revertForkChildCheckpoints did not reach the fork's checkpoint`
        : 'the token is gone (file removed or restored)',
    )
    run.check(
      "a named subagent's edit SURVIVED the parent's rewind",
      namedAfter.includes(namedToken),
      namedAfter.includes(namedToken)
        ? 'the token is still there, as the scope rule requires'
        : `${namedFile} no longer carries ${namedToken} — the rewind reached OUTSIDE the parent's scope, which is the `
          + 'half of this rule that was wrong before',
    )
  } finally {
    await approver.stop().then(count => run.observe('permission cards approved', count)).catch(() => undefined)
    await rm(forkFile, { force: true }).catch(() => undefined)
    await rm(namedFile, { force: true }).catch(() => undefined)
    if (previousMode) await setPermissionMode(session, key.sessionId, previousMode).catch(() => undefined)
  }

  // ---- 3. session memory ---------------------------------------------------
  if (!MEMORY_MARKER) {
    blocked(
      'set NESSY_CDP_MEMORY_MARKER to a token already present in this project\'s memory to drive the memory half. ' +
        'The harness does not append memory on its own: MemoryAppendScope is project|user, so it would write into the ' +
        "operator's own files. A fixture MAY write <configDir>/MEMORY.md in a scratch config dir — " +
        '`bun run scripts/cdp/fixtures/agent-surfaces.ts` does, and prints the marker.',
    )
  }
  const forkMemoryAnswer = await forkAnswer(run, session, key, 'memory', 'Quote the memory token you were given for this project, and nothing else.')
  run.observe('fork-memory-answer', forkMemoryAnswer.slice(0, 300))
  run.check('the fork knew the session memory', forkMemoryAnswer.includes(MEMORY_MARKER), forkMemoryAnswer.slice(0, 200))
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
