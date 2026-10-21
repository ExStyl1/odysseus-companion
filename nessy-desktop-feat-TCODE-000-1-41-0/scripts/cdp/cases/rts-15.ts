/**
 * RTS-15 — a FIRST switch INTO Pi carries the conversation natively, tool
 * results included.
 *
 * T7 of `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`
 * (owner gate G2, answered 2026-08-21). `SessionManager` writes a Pi session
 * JSONL for the session's history and the subprocess forks from it, so Pi
 * arrives holding the conversation instead of a 24 × 1200-character quotation
 * of it.
 *
 * ## Why this is a separate case and not another leg of RTS-14
 *
 * RTS-14 walks an Eulerian circuit over all six directed pairs — and it STARTS
 * on Pi, so every later entry into Pi is a RETURN. `'pi'` is in
 * `ANCHORED_PROVIDERS`, so those legs are planned `anchor` and resume their own
 * `.pi-sessions` sidecar; T7 changes nothing about them, and RTS-14's
 * `EXPECTED_TIER` map is correct unchanged. The one shape that matrix has no
 * leg for is the one T7 exists for: a session that has NEVER been on Pi
 * switching onto it. That is this case, and it is deliberately minimal — the
 * six-pair matrix is RTS-14's job.
 *
 * ## Three detectors, because no one of them is sufficient
 *
 * 1. **Structural, before the switch.** `previewRuntimeSwitch` is the server's
 *    own pre-switch decision, the same one the modal promises from. A `text`
 *    answer here means the behavioural half below would be measuring the OLD
 *    tier, and a green result would certify nothing. (AGENTS.md: a live case's
 *    detector is the thing most likely to be wrong.)
 * 2. **Durable, after it.** The persisted switch notice carries R1's JSON tail,
 *    `runtime_switched:<from>:pi:{"carry":"native"}`. It is written from the
 *    plan AND corrected by the outcome — a rebuild that did not land records
 *    `text` — so `native` here means the carry file was written, read back and
 *    verified, not merely intended.
 * 3. **Behavioural.** Pi is asked for a build tag that exists ONLY inside a
 *    tool result produced on the previous runtime. The codeword never appears
 *    in any prompt, so it cannot arrive by paraphrase; the text tier drops
 *    every `role: 'tool'` row, so it cannot arrive that way either.
 *
 * The memory sweep at the end is what stops detector 3 passing for the wrong
 * reason: a tag written to a memory file would be re-read on Pi with no carry
 * at all.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, setPermissionMode } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'
import { newCodeword, memoryLeaks } from '../lib/codeword.ts'
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

const ID = 'RTS-15'
const TITLE = 'A first switch into Pi carries the conversation natively, tool results included'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const connections = await listConnections(session)
  const claude = connections.find(c => c.slug === trio.claude)
  if (!claude || runtimeOf(claude.providerType) !== 'anthropic') {
    blocked(
      `no claude card at slug ${trio.claude}. Seen: `
      + connections.map(c => `${c.slug}(${c.providerType})`).join(', '),
    )
  }
  const pi = connections.find(c => c.slug === trio.pi)
  if (!pi || runtimeOf(pi.providerType) !== 'pi') {
    blocked(`no pi card at slug ${trio.pi}. Seen: ` + connections.map(c => `${c.slug}(${c.providerType})`).join(', '))
  }

  const { projectDir } = fixturePaths()
  if (!existsSync(join(projectDir, '.git'))) {
    blocked(`no fixture repo at ${projectDir} — run \`bun run scripts/cdp/fixtures/runtime-switch.ts\``)
  }

  const key = await freshSession(session, `${ID} first switch into pi`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  await bindProject(run, session, key.sessionId, projectDir, { gate: () => trustFixtureProject(session) })

  // The whole point of the case: the session starts on Claude and has NEVER
  // been on Pi, so the Pi anchor slot is empty and the carry is a first entry
  // rather than a resume.
  await switchRuntime(session, key.sessionId, trio.claude)
  run.require(
    'the session starts on Claude, never having been on Pi',
    (await waitForConnection(session, key.sessionId, trio.claude)) === trio.claude,
    trio.claude,
  )
  // The documented mode that does not ask — this case is about the carry, not
  // permission cards (RTS-5 owns mode enforcement across a switch).
  await setPermissionMode(session, key.sessionId, 'bypassPermissions')

  // --- the work on Claude: one prose label, one TOOL-ONLY fact -------------
  const prose = newCodeword()
  const tag = newCodeword()
  await sendPrompt(
    session,
    key,
    `For this conversation, the alpha label is ${prose}. `
    + 'Do not write it to memory or to any file — keep it in this conversation. Reply with the single word OK.',
    300_000,
  )
  // Written by the CASE, never named in a prompt: the only way this string can
  // reach Pi is inside a carried tool result.
  const infoFile = 'build-info-rts15.txt'
  writeFileSync(join(projectDir, infoFile), `build tag for stage 1: ${tag}\n`)
  // The instruction is emphatic on purpose. The first sitting of this case
  // used RTS-14's wording verbatim and the model answered `DONE` **without
  // running anything** — zero tool rows, and the case correctly refused to
  // score a carry that had nothing to carry. The reply is still pinned to one
  // word so the tag cannot leak into prose, which is what makes detector 3
  // about the tool row and not about the transcript.
  await sendPrompt(
    session,
    key,
    `Actually execute the shell command \`cat ${infoFile}\` with your shell tool, in the current project `
    + 'directory. Do not answer from memory and do not skip the command — running it is the whole task. '
    + 'Then, to keep the transcript short, reply with just the word DONE and nothing else.',
    300_000,
  )

  // The tool row really is in the transcript — without it there is nothing for
  // the carry to carry and detector 3 would be measuring nothing.
  const toolRows = await session.call<{ tools: number; carriesTag: boolean }>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    if (!s) throw new Error('session-not-found: ' + ${JSON.stringify(key.sessionId)})
    const rows = (s.messages ?? []).filter(m => m.role === 'tool')
    return {
      tools: rows.length,
      carriesTag: rows.some(m => JSON.stringify(m).includes(${JSON.stringify(tag)})),
    }
  `)
  run.observe('tool rows before the switch', toolRows)
  run.require(
    'a tool row holding the build tag exists before the switch',
    toolRows.carriesTag,
    `${toolRows.tools} tool row(s)`,
  )

  run.observe('session dir', requireSessionDir(key.workspaceId, key.sessionId))

  // --- detector 1: the server's own pre-switch decision --------------------
  const preview = await session.call<{ kind?: string; hasHistory?: boolean; historyCarry?: string } | null>(`
    try {
      return await window.electronAPI.sessionCommand(
        ${JSON.stringify(key.sessionId)},
        { type: 'previewRuntimeSwitch', connectionSlug: ${JSON.stringify(trio.pi)} },
      )
    } catch (e) { return { error: String(e && (e.code || e.message) || e) } }
  `)
  run.observe('previewRuntimeSwitch claude → pi', preview)
  run.check(
    'the server plans a NATIVE carry into Pi — a `text` plan means the recall below measures the old tier',
    preview?.kind === 'connection-cross-runtime' && preview?.historyCarry === 'native',
    `${preview?.kind} / ${preview?.historyCarry}`,
  )

  // --- the switch ----------------------------------------------------------
  const toPi = await switchRuntime(session, key.sessionId, trio.pi)
  run.observe('switch claude → pi', toPi)
  run.require('the switch was accepted', toPi.ok, toPi.error ?? '')
  run.require(
    'the session reports the pi card',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )
  run.check(
    'the switch is cross-runtime and arms a handoff',
    toPi.result?.kind === 'connection-cross-runtime' && toPi.result?.contextCarried === 'handoff',
    `${toPi.result?.kind} / ${toPi.result?.contextCarried}`,
  )

  // --- detector 2: the durable notice ---------------------------------------
  const marker = await session.call<string | null>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    const rows = (s?.messages ?? []).filter(m => typeof m.content === 'string' && m.content.startsWith('runtime_switched:'))
    return rows.length > 0 ? rows[rows.length - 1].content : null
  `)
  run.observe('runtime switch marker', marker)
  run.check(
    'the durable notice records a NATIVE carry — written from the plan and corrected by the outcome',
    typeof marker === 'string' && marker.includes(':pi:') && marker.includes('"carry":"native"'),
    marker ?? '(no marker row)',
  )

  // --- detector 3: can Pi see a fact only a tool result held? ---------------
  const recall = await sendPrompt(
    session,
    key,
    'From what has already happened in this conversation (no need to read files or run anything), '
    + 'answer as a numbered list: (1) the build tag for stage 1, from the cat of build-info-rts15.txt '
    + '(2) the alpha label.',
    600_000,
  )
  const answer = lastAssistantText(recall.added)
  run.observe('answer on pi', answer.slice(0, 500))
  run.check(
    'Pi knows the tool-only build tag — the text tier drops every tool row, so this can only be the native carry',
    answer.includes(tag),
    `expected ${tag}`,
  )
  run.check('Pi knows the prose label too', answer.includes(prose), `expected ${prose}`)

  // The tag must not have reached a memory file — a leak would let the recall
  // pass with no carry at all.
  const leaks = await memoryLeaks(tag, {
    workspaceId: key.workspaceId,
    sessionId: key.sessionId,
    configDir: resolveConfigDir(),
    workingDirectory: projectDir,
  })
  run.check(
    'the build tag did not leak into a memory file',
    leaks.length === 0,
    leaks.map(l => `${l.scope}:${l.path}`).join(', '),
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
