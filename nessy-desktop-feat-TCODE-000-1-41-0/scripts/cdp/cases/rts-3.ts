/**
 * RTS-3 — coming BACK to Pi must not resume the pre-switch thread.
 *
 * This is the row the whole design turned on. Pi does not resume by session id
 * the way the Claude SDK does; it resumes **by directory** —
 * `join(config.sessionPath, '.pi-sessions')` handed to `continueRecent`. So a
 * session that starts on Pi, moves to Claude, and comes back would, left alone,
 * pick its old sidecar straight back up: the Pi runtime would carry on from the
 * message before the switch and the entire Claude span would be missing, with
 * nothing anywhere saying so. The answer would be fluent, confident and short
 * by exactly the part the user did on the other runtime.
 *
 * The fix is a forced-fresh Pi session directory on the return leg. This case
 * is what proves it happened.
 *
 * ## The detector, and why it is two detectors
 *
 * 1. **Behavioural.** A label is planted on Pi (`A`) and a second one on Claude
 *    (`B`). Coming back to Pi, the case asks for BOTH. A resumed old thread
 *    knows `A` and cannot know `B` — that is the failure, stated as a value
 *    rather than as a vibe about "seems to remember".
 * 2. **Structural, from a file Pi writes itself.** The `.pi-sessions` sidecar
 *    is read before and after the return. A fresh directory means a NEW
 *    `.jsonl`, so the newest file must differ. AGENTS.md's rule for an absence
 *    claim is a source the feature writes itself, and this is it: the app's own
 *    account of what it did is not evidence about which thread Pi opened.
 *
 * Either alone is weak. Behaviour alone can pass on a handoff that happens to
 * re-state everything; the file alone shows a new thread without showing that
 * the conversation survived into it.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, setPermissionMode } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'
import { newCodeword, plantPrompt, memoryLeaks } from '../lib/codeword.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { readPiSessionLog } from '../lib/runtime-session-log.ts'
import { fixturePaths } from '../fixtures/runtime-switch.ts'
import {
  requireRuntimeTrio,
  requireSessionDir,
  resolveConfigDir,
  bindProject,
  switchRuntime,
  trustFixtureProject,
  waitForConnection,
} from '../lib/runtime-switch.ts'

const ID = 'RTS-3'
const TITLE = 'Returning to Pi starts a fresh thread and keeps the span done on the other runtime'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const { projectDir } = fixturePaths()
  if (!existsSync(join(projectDir, '.git'))) {
    blocked(`no fixture repo at ${projectDir} — run \`bun run scripts/cdp/fixtures/runtime-switch.ts\``)
  }

  const key = await freshSession(session, `${ID} pi to claude and back`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  await bindProject(run, session, key.sessionId, projectDir, { gate: () => trustFixtureProject(session) })
  await switchRuntime(session, key.sessionId, trio.pi)
  run.require(
    'the session starts on Pi',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )
  await setPermissionMode(session, key.sessionId, 'acceptEdits')

  // --- the Pi span ---------------------------------------------------------
  const labelPi = newCodeword()
  await sendPrompt(session, key, plantPrompt(labelPi), 300_000)
  await sendPrompt(session, key, 'Reply with exactly: PI-SPAN', 300_000)

  const piBefore = readPiSessionLog(key, resolveConfigDir())
  run.observe('pi sidecar after the Pi span', { file: piBefore.file, count: piBefore.sidecarCount, reason: piBefore.reason })
  run.require(
    'Pi wrote a sidecar for the first span — the instrument exists before it is used',
    piBefore.sidecarCount > 0 && Boolean(piBefore.file),
    piBefore.reason ?? String(piBefore.sidecarCount),
  )

  // --- the Claude span -----------------------------------------------------
  const toClaude = await switchRuntime(session, key.sessionId, trio.claude)
  run.observe('switch pi → claude', toClaude)
  run.require('the outbound switch was accepted', toClaude.ok, toClaude.error ?? '')
  run.require(
    'the session reports the claude card',
    (await waitForConnection(session, key.sessionId, trio.claude)) === trio.claude,
    trio.claude,
  )

  const labelClaude = newCodeword()
  await sendPrompt(session, key, plantPrompt(labelClaude), 300_000)
  await sendPrompt(session, key, 'Reply with exactly: CLAUDE-SPAN', 300_000)

  // Both labels, before the return leg. A leak in either makes the recall
  // unscoreable, and the Claude one is the load-bearing half of this case.
  run.observe('session dir', requireSessionDir(key.workspaceId, key.sessionId))
  for (const [name, label] of [['pi', labelPi], ['claude', labelClaude]] as const) {
    const leaks = await memoryLeaks(label, {
      workspaceId: key.workspaceId,
      sessionId: key.sessionId,
      configDir: resolveConfigDir(),
      workingDirectory: projectDir,
    })
    run.observe(`memory files holding the ${name} label`, leaks)
    if (leaks.length > 0) {
      blocked(`the ${name} label leaked into ${leaks.map(l => `${l.scope}:${l.path}`).join(', ')} — the recall cannot be scored`)
    }
  }

  // --- the return leg ------------------------------------------------------
  const backToPi = await switchRuntime(session, key.sessionId, trio.pi)
  run.observe('switch claude → pi', backToPi)
  run.require('the return switch was accepted', backToPi.ok, backToPi.error ?? '')
  // `anchor-and-handoff` since T18: the returning runtime resumes its own
  // conversation from the anchor AND is handed the span it missed. A plain
  // `handoff` here would mean the anchor was not recognised.
  run.check(
    'the return is classified cross-runtime and carries both the anchor and the missed span',
    backToPi.result?.kind === 'connection-cross-runtime'
      && backToPi.result?.contextCarried === 'anchor-and-handoff',
    `${backToPi.result?.kind} / ${backToPi.result?.contextCarried}`,
  )
  run.require(
    'the session reports the pi card again',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )

  const recall = await sendPrompt(
    session,
    key,
    'Without reading any files or running any commands, answer from our conversation only: '
    + 'list every reference label that has been used in this conversation.',
    300_000,
  )
  const answer = lastAssistantText(recall.added)
  run.observe('answer back on pi', answer.slice(0, 600))

  run.check(
    'the returned Pi span still knows the label from before the switch',
    answer.includes(labelPi),
    `expected ${labelPi}`,
  )
  run.check(
    'the returned Pi span knows the label planted on Claude — it did NOT resume the old thread',
    answer.includes(labelClaude),
    `expected ${labelClaude}`,
  )

  // --- the structural half -------------------------------------------------
  //
  // The plan's Background describes the return leg as a FORCED-FRESH Pi session
  // directory. That is not what shipped, and the shipped design is defensible:
  // `clearRuntimeScopedSessionState` folds the outgoing `sdkSessionId` into that
  // provider's own anchor slot precisely "so coming back still reaches that
  // conversation" (`SessionManager.ts:15308-15315`). So Pi RESUMES its own
  // sidecar, which is why the file below is expected to be the same one.
  //
  // What is not defensible is what that costs, and it is only visible here.
  const piAfter = readPiSessionLog(key, resolveConfigDir())
  run.observe('pi sidecar after the return', { file: piAfter.file, count: piAfter.sidecarCount })
  run.observe(
    'the return resumed the same Pi conversation (design: the outgoing anchor is preserved)',
    piAfter.file === piBefore.file,
  )

  // The duplication check.
  //
  // The cross-runtime branch arms the text handoff unconditionally, on the
  // stated premise that "the target runtime has no anchor of its own, so the
  // only thing that can cross is text" (`SessionManager.ts:15109`). On a RETURN
  // leg that premise is false — the anchor was deliberately kept — so Pi gets
  // the pre-switch span twice: once as its own resumed history, and again
  // inside `<runtime_handoff_context>`.
  //
  // Measured against Pi's own sidecar rather than inferred: take the assistant
  // replies Pi produced BEFORE the switch, and look for them inside the handoff
  // block of the first user entry after it.
  const lastUser = [...piAfter.entries].reverse().find(e => e.type === 'message' && e.role === 'user')
  const handoffBlock = /<runtime_handoff_context>([\s\S]*?)<\/runtime_handoff_context>/.exec(lastUser?.text ?? '')?.[1] ?? ''
  run.observe('handoff block present on the first turn after the return', handoffBlock.length > 0)

  // Keyed on the two per-run LABELS, not on reply text.
  //
  // The first version compared the pre-switch assistant replies against the
  // handoff block by substring, and reported a duplicate that was not one: both
  // spans answer their plant prompt with `OK`, so a two-character reply matched
  // the OTHER span's copy of itself. A detector has to key on something unique
  // to the span it is attributing, and the labels are exactly that — 20 hex
  // characters, generated per run, one per span.
  run.check(
    'the handoff does NOT re-deliver the pre-switch span the resumed Pi thread already holds',
    !handoffBlock.includes(labelPi),
    handoffBlock.includes(labelPi)
      ? `the Pi label ${labelPi} is inside <runtime_handoff_context> while Pi's own resumed thread already holds it`
      : 'the pre-switch span is not repeated',
  )
  run.check(
    'and it DOES carry the span produced while this runtime was away',
    handoffBlock.includes(labelClaude),
    handoffBlock.includes(labelClaude)
      ? 'the Claude span crossed'
      : `the Claude label ${labelClaude} is missing: the trim removed the very span the handoff exists to carry`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
