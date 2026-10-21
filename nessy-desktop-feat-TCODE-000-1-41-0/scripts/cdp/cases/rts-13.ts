/**
 * RTS-13 — a switch into Codex carries the WHOLE conversation, not its last
 * 24 messages.
 *
 * T1a of `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`.
 * Codex now takes the handoff as native model-visible history over
 * `thread/inject_items` instead of as a text block on the first user message,
 * and the delta that matters to a user is the bound: `buildRuntimeHandoffContext`
 * keeps `messages.slice(-24)` with each entry truncated at 1200 characters,
 * and the native path keeps everything.
 *
 * ## THIS CASE MUST FAIL ON A PRE-T1a BUILD, AND THAT IS THE POINT
 *
 * The gate T1a replaced ("plant a fact, switch, ask for it") **could not
 * fail**: any fact inside the 24-message window crosses on today's build too,
 * so the case would score green against the behaviour it was meant to prove was
 * new. So the label here is planted and then pushed BEYOND the window by
 * filler turns, and the recall is only satisfiable by a carry with no such
 * window.
 *
 * Run it on the previous packaged build first. If it passes there, the filler
 * did not push the label out of the text window and the case is certifying
 * nothing — raise `FILLER_TURNS` until it fails, then re-run on this build.
 *
 * ## Two detectors, because either alone is weak
 *
 * 1. **Structural, before the switch.** `previewRuntimeSwitch` is the server's
 *    own pre-switch decision, the same one the modal promises from. It must say
 *    `native` — if it says `text`, the behavioural half below is measuring the
 *    text tier and a green result would mean nothing. This is the detector
 *    check AGENTS.md demands: a live case's detector is the thing most likely
 *    to be wrong.
 * 2. **Behavioural, after it.** Codex is asked for a label it can only know if
 *    the pre-window span reached it.
 *
 * Neither is sufficient. The preview can promise `native` while the inject
 * silently fails (the agent then falls back to text in the same turn, and the
 * recall would still pass for the WRONG reason — which is why the recall
 * targets a label the text tier cannot carry). The recall can pass on a lucky
 * paraphrase without the plan ever having been `native`.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, setPermissionMode } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'
import { newCodeword, plantPrompt, memoryLeaks } from '../lib/codeword.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { fixturePaths } from '../fixtures/runtime-switch.ts'
import {
  listConnections,
  requireRuntimeTrio,
  requireSessionDir,
  resolveConfigDir,
  runtimeOf,
  bindProject,
  switchRuntime,
  trustFixtureProject,
  waitForConnection,
} from '../lib/runtime-switch.ts'

const ID = 'RTS-13'
const TITLE = 'Pi → Codex carries a fact from beyond the 24-message text window'

/**
 * Turns run AFTER the plant, before the switch.
 *
 * `buildRuntimeHandoffContext` keeps the last 24 non-intermediate user/assistant
 * rows. Each filler turn contributes two (the prompt and the reply), and the
 * plant itself is the first two, so 13 turns puts the plant at position 1 of 28
 * — three rows clear of the cut, which is deliberate slack: a runtime that
 * emits an extra row must not silently pull the label back inside the window
 * and turn this case green for the wrong reason.
 */
const FILLER_TURNS = 13

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const connections = await listConnections(session)
  const codex = connections.find(c => c.slug === trio.codex)
  if (!codex || runtimeOf(codex.providerType) !== 'codex-runtime') {
    blocked(
      `no codex-runtime card at slug ${trio.codex}. Seen: `
      + connections.map(c => `${c.slug}(${c.providerType})`).join(', '),
    )
  }

  const { projectDir } = fixturePaths()
  if (!existsSync(join(projectDir, '.git'))) {
    blocked(`no fixture repo at ${projectDir} — run \`bun run scripts/cdp/fixtures/runtime-switch.ts\``)
  }

  const key = await freshSession(session, `${ID} pi to codex beyond the text window`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  await bindProject(run, session, key.sessionId, projectDir, { gate: () => trustFixtureProject(session) })
  await switchRuntime(session, key.sessionId, trio.pi)
  run.require(
    'the session starts on Pi',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )
  await setPermissionMode(session, key.sessionId, 'acceptEdits')

  // --- the plant, then the burial -----------------------------------------
  const label = newCodeword()
  await sendPrompt(session, key, plantPrompt(label), 300_000)
  for (let i = 1; i <= FILLER_TURNS; i += 1) {
    await sendPrompt(session, key, `Reply with exactly: FILLER-${i}`, 300_000)
  }

  // How deep the label actually is, read from the transcript rather than
  // assumed from `FILLER_TURNS` — a runtime that emitted a row we did not count
  // would leave the label inside the window and this case would prove nothing.
  //
  // Read through the SAME projection `getRuntimeHandoffMessages` uses — roles
  // `user`/`assistant`, `isIntermediate` dropped — so the position measured
  // here is the position the 24-message slice would cut at.
  const depth = await session.call<{ total: number; labelAt: number }>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    if (!s) throw new Error('session-not-found: ' + ${JSON.stringify(key.sessionId)})
    const rows = (s.messages ?? [])
      .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.isIntermediate)
    return {
      total: rows.length,
      labelAt: rows.findIndex(m => typeof m.content === 'string' && m.content.includes(${JSON.stringify(label)})),
    }
  `)
  run.observe('conversation depth before the switch', depth)
  run.require(
    'the label really is beyond the 24-message text window — without this the case cannot fail on a pre-T1a build',
    depth.labelAt >= 0 && depth.total - depth.labelAt > 24,
    `label at ${depth.labelAt} of ${depth.total} rows`,
  )

  run.observe('session dir', requireSessionDir(key.workspaceId, key.sessionId))
  const leaks = await memoryLeaks(label, {
    workspaceId: key.workspaceId,
    sessionId: key.sessionId,
    configDir: resolveConfigDir(),
    workingDirectory: projectDir,
  })
  run.observe('memory files holding the label', leaks)
  if (leaks.length > 0) {
    blocked(`the label leaked into ${leaks.map(l => `${l.scope}:${l.path}`).join(', ')} — the recall cannot be scored`)
  }

  // --- detector 1: the server's own pre-switch decision --------------------
  const preview = await session.call<{ kind?: string; hasHistory?: boolean; historyCarry?: string } | null>(`
    try {
      return await window.electronAPI.sessionCommand(
        ${JSON.stringify(key.sessionId)},
        { type: 'previewRuntimeSwitch', connectionSlug: ${JSON.stringify(trio.codex)} },
      )
    } catch (e) { return { error: String(e && (e.code || e.message) || e) } }
  `)
  run.observe('previewRuntimeSwitch pi → codex', preview)
  run.check(
    'the server plans a NATIVE carry — a `text` plan here means the recall below is measuring the old tier',
    preview?.kind === 'connection-cross-runtime' && preview?.historyCarry === 'native',
    `${preview?.kind} / ${preview?.historyCarry}`,
  )

  // --- the switch ----------------------------------------------------------
  const toCodex = await switchRuntime(session, key.sessionId, trio.codex)
  run.observe('switch pi → codex', toCodex)
  run.require('the switch was accepted', toCodex.ok, toCodex.error ?? '')
  run.require(
    'the session reports the codex card',
    (await waitForConnection(session, key.sessionId, trio.codex)) === trio.codex,
    trio.codex,
  )
  // `contextCarried` is decided BEFORE any turn runs, and Codex's carry needs a
  // live thread, so the switch can only report that a handoff is armed. The
  // native delivery shows up in the session log as
  // `Runtime handoff context applied for <id> (context=native-inject)`, and in
  // the recall below.
  run.check(
    'the switch is cross-runtime and arms a handoff',
    toCodex.result?.kind === 'connection-cross-runtime' && toCodex.result?.contextCarried === 'handoff',
    `${toCodex.result?.kind} / ${toCodex.result?.contextCarried}`,
  )

  // --- detector 2: can Codex see past the window? --------------------------
  const recall = await sendPrompt(
    session,
    key,
    'Without reading any files or running any commands, answer from our conversation only: '
    + 'what reference label did I ask you to remember at the very beginning?',
    600_000,
  )
  const answer = lastAssistantText(recall.added)
  run.observe('answer on codex', answer.slice(0, 400))
  run.check(
    'Codex knows a label planted beyond the 24-message text window — only a native carry can deliver it',
    answer.includes(label),
    `expected ${label}`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
