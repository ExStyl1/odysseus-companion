/**
 * RTS-1 — a Codex session survives a model change.
 *
 * Before T1 (`26bc740ee`) a model change on the Codex runtime went through
 * dispose-and-recreate: the app kept the transcript on screen while the Codex
 * app-server thread it was talking to was thrown away and a new one started
 * blank. Nothing failed, nothing was logged, and the next answer was simply
 * amnesiac. T1 added `CodexAgent.updateRuntimeConfig`, which applies a
 * MODEL-ONLY update in place and keeps the thread.
 *
 * The case plants a per-run label, spends three turns, changes the model, and
 * asks for the label back. A pre-T1 build cannot answer.
 *
 * ## What makes this a measurement rather than a vibe
 *
 * - **The label is per-run and the prompt forbids persisting it**
 *   (`lib/codeword.ts`). A remembered-into-MEMORY.md label would be recallable
 *   by an agent that inherited nothing, which is how a control in this repo was
 *   once scored PASS by a subagent that had grepped the file.
 * - **The leak scan runs anyway.** Asking nicely is defence one; reading the
 *   three files the memory layer loads is defence two. A leak makes the case
 *   BLOCKED, never PASS and never FAIL.
 * - **The connection must NOT change.** This is the model-only tier; if the
 *   session moved to a different card, the recall would prove something else
 *   entirely. Asserted before and after.
 * - **Positive control that the model really changed.** `getSessionModel` must
 *   report the new id before the recall turn. Without it a build that ignored
 *   the request would pass by never having changed anything.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'
import { newCodeword, plantPrompt, recallPrompt, memoryLeaks } from '../lib/codeword.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import {
  activeConnection,
  listConnections,
  requireRuntimeTrio,
  requireSessionDir,
  resolveConfigDir,
  selectModel,
  switchRuntime,
  waitForConnection,
} from '../lib/runtime-switch.ts'

const ID = 'RTS-1'
const TITLE = 'A Codex session keeps its thread across a model change'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const connections = await listConnections(session)
  const codex = connections.find(c => c.slug === trio.codex)!
  const models = (codex.models ?? []).map(m => m.id)
  run.observe('codex models', models)
  if (models.length < 2) {
    blocked(
      `the codex card "${trio.codex}" offers ${models.length} model(s) — this case needs two to change between. `
      + `Models: ${models.join(', ') || 'none'}`,
    )
  }

  const key = await freshSession(session, `${ID} codex model change`)
  run.observe('session', key)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')

  const outcome = await switchRuntime(session, key.sessionId, trio.codex)
  run.observe('switch onto codex', outcome)
  run.require('the session is on the codex card', outcome.ok, outcome.error ?? '')
  run.require(
    `the session reports ${trio.codex}`,
    (await waitForConnection(session, key.sessionId, trio.codex)) === trio.codex,
    String(await activeConnection(session, key.sessionId)),
  )

  const first = models[0]!
  const second = models[1]!
  const settledFirst = await selectModel(session, key, first)
  run.require(`the session starts on ${first}`, settledFirst === first, String(settledFirst))

  // --- three turns, the first of which plants the label --------------------
  const codeword = newCodeword()
  const plant = await sendPrompt(session, key, plantPrompt(codeword), 300_000)
  run.observe('turn 1', lastAssistantText(plant.added).slice(0, 120))
  for (const [index, prompt] of [
    'Reply with exactly: TURN-TWO',
    'Reply with exactly: TURN-THREE',
  ].entries()) {
    const turn = await sendPrompt(session, key, prompt, 300_000)
    run.observe(`turn ${index + 2}`, lastAssistantText(turn.added).slice(0, 120))
  }

  // The leak scan belongs BEFORE the recall: a leaked label makes the recall
  // unrunnable, and running it anyway produces a green row that proves nothing.
  // `requireSessionDir` first: it throws when the scan would be looking in the
  // wrong config dir, which is the difference between "no leak" and "no files".
  run.observe('session dir', requireSessionDir(key.workspaceId, key.sessionId))
  const leaks = await memoryLeaks(codeword, {
    workspaceId: key.workspaceId,
    sessionId: key.sessionId,
    configDir: resolveConfigDir(),
    ...(await workingDirectoryOf(session, key.sessionId)),
  })
  run.observe('memory files holding the label', leaks)
  if (leaks.length > 0) {
    blocked(
      `the label leaked into ${leaks.map(l => `${l.scope}:${l.path}`).join(', ')} — `
      + 'a recall from a file is not a recall from the thread, so this run cannot score the claim',
    )
  }

  // --- the model change, in place ------------------------------------------
  const settledSecond = await selectModel(session, key, second)
  run.require(`the session moved to ${second}`, settledSecond === second, String(settledSecond))
  run.require(
    'the CONNECTION did not change — this is the model-only tier',
    (await activeConnection(session, key.sessionId)) === trio.codex,
    String(await activeConnection(session, key.sessionId)),
  )

  // --- the recall ----------------------------------------------------------
  const recall = await sendPrompt(session, key, recallPrompt(), 300_000)
  const answer = lastAssistantText(recall.added)
  run.observe('recall answer', answer.slice(0, 300))
  run.check(
    'the reply after the model change names the label from before it — the thread survived',
    answer.includes(codeword),
    `expected ${codeword}`,
  )
}

async function workingDirectoryOf(session: CdpSession, sessionId: string): Promise<{ workingDirectory?: string }> {
  const dir = await session.call<string | undefined>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
    return s ? (s.workingDirectory ?? undefined) : undefined
  `).catch(() => undefined)
  return dir ? { workingDirectory: dir } : {}
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
