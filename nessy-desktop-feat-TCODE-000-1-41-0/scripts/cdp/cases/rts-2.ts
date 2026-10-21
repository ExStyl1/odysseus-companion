/**
 * RTS-2 — the cross-runtime handoff carries the conversation.
 *
 * Pi does real work in a real git repo, the session moves to the Claude
 * runtime, and the Claude side is asked what has been done. It has no Pi
 * transcript and no anchor of its own: Pi resumes by DIRECTORY
 * (`join(config.sessionPath, '.pi-sessions')` → `continueRecent`), the Claude
 * SDK resumes by id under a different root, and neither can read the other. The
 * only thing that can cross is the text T4 arms — `runtimeHandoffFrom` set on
 * the switch, handed over by `getRuntimeHandoffMessages` on the first turn
 * after it.
 *
 * ## Two checks, and the weaker one is the plan's
 *
 * The plan asks that the answer NAME THE FILES. That check is in, but on its
 * own it is confoundable: the session is bound to the repo, and a competent
 * agent can answer "what have we changed" by reading `git status` rather than
 * by remembering anything. So the case also plants a per-run label in the Pi
 * span and asks for it back after the switch. Nothing on disk holds it — the
 * leak scan proves that rather than assuming it — so recalling it is possible
 * only through the handoff.
 *
 * ## The positive control
 *
 * "The agent edited files" is asserted against `git status --porcelain` in the
 * fixture repo, not against the agent's own account of itself. A case that
 * believed the model's summary would score a PASS on a turn where nothing was
 * written, which is the same class of error as trusting a typed field that is
 * never filled.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, setPermissionMode } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'
import { newCodeword, plantPrompt, memoryLeaks } from '../lib/codeword.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
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

const ID = 'RTS-2'
const TITLE = 'A session moved from Pi to the Claude runtime can still say what it did on Pi'

/** Files the Pi span is asked to touch. Named here so both halves agree. */
const TARGETS = ['greeting.ts', 'counter.ts'] as const

export function gitStatus(cwd: string): string[] {
  const proc = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd })
  return new TextDecoder().decode(proc.stdout).split('\n').map(l => l.trim()).filter(Boolean)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const { projectDir } = fixturePaths()
  if (!existsSync(join(projectDir, '.git'))) {
    blocked(`no fixture repo at ${projectDir} — run \`bun run scripts/cdp/fixtures/runtime-switch.ts\``)
  }
  const dirtyBefore = gitStatus(projectDir)
  run.observe('git status before', dirtyBefore)

  const key = await freshSession(session, `${ID} pi to claude`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  // The trust modal owns the screen until it is answered, and an unanswered one
  // fails the case at its first keystroke with `composer-not-focusable`.
  await bindProject(run, session, key.sessionId, projectDir, { gate: () => trustFixtureProject(session) })
  await switchRuntime(session, key.sessionId, trio.pi)
  run.require(
    'the session starts on Pi',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )
  // Edits must land without a card in the way; the permission surface is
  // RTS-5's subject, not this one's.
  await setPermissionMode(session, key.sessionId, 'acceptEdits')

  // --- the Pi span ---------------------------------------------------------
  const codeword = newCodeword()
  await sendPrompt(session, key, plantPrompt(codeword), 300_000)

  const edit = await sendPrompt(
    session,
    key,
    `In this project, add an exported function \`farewell(name: string): string\` to ${TARGETS[0]} `
    + `returning \`Goodbye, \${name}!\`, and an exported function \`total(numbers: readonly number[]): number\` `
    + `to ${TARGETS[1]} returning their sum. Edit the files; do not create new ones.`,
    600_000,
  )
  run.observe('pi edit turn', lastAssistantText(edit.added).slice(0, 300))

  // The positive control: the repo, not the model's summary.
  const dirtyAfter = gitStatus(projectDir)
  run.observe('git status after', dirtyAfter)
  const touched = TARGETS.filter(file =>
    dirtyAfter.some(line => line.endsWith(file))
    && !dirtyBefore.some(line => line.endsWith(file)))
  run.require(
    'Pi actually edited both files — measured in the repo, not from the model',
    touched.length === TARGETS.length,
    `touched: ${touched.join(', ') || 'none'}`,
  )
  const wrote = TARGETS.every(file => {
    const text = readFileSync(join(projectDir, file), 'utf8')
    return /farewell|total/.test(text)
  })
  run.check('both files carry a new exported function', wrote)

  run.observe('session dir', requireSessionDir(key.workspaceId, key.sessionId))
  const leaks = await memoryLeaks(codeword, {
    workspaceId: key.workspaceId,
    sessionId: key.sessionId,
    configDir: resolveConfigDir(),
    workingDirectory: projectDir,
  })
  run.observe('memory files holding the label', leaks)
  if (leaks.length > 0) {
    blocked(`the label leaked into ${leaks.map(l => `${l.scope}:${l.path}`).join(', ')} — the recall cannot be scored`)
  }

  // --- the switch ----------------------------------------------------------
  const outcome = await switchRuntime(session, key.sessionId, trio.claude)
  run.observe('switch pi → claude', outcome)
  run.require('the switch was accepted', outcome.ok, outcome.error ?? '')
  run.check(
    'the app classified it as a cross-runtime switch',
    outcome.result?.kind === 'connection-cross-runtime',
    String(outcome.result?.kind),
  )
  run.check(
    'the app armed a context handoff — there was history to carry',
    outcome.result?.contextCarried === 'handoff',
    String(outcome.result?.contextCarried),
  )
  run.check(
    'the switch reports the two runtimes it moved between',
    outcome.result?.from === 'pi' && outcome.result?.to === 'anthropic',
    `${outcome.result?.from} → ${outcome.result?.to}`,
  )
  run.require(
    'the session reports the claude card',
    (await waitForConnection(session, key.sessionId, trio.claude)) === trio.claude,
    trio.claude,
  )

  // --- what the Claude side knows ------------------------------------------
  const recall = await sendPrompt(
    session,
    key,
    'Without reading any files or running any commands, answer from our conversation only: '
    + 'which files have we changed so far, and what is the reference label for this conversation?',
    600_000,
  )
  const answer = lastAssistantText(recall.added)
  run.observe('claude answer', answer.slice(0, 600))

  const named = TARGETS.filter(file => answer.includes(file))
  run.check(
    'the answer names the files edited on the other runtime',
    named.length === TARGETS.length,
    `named: ${named.join(', ') || 'none'}`,
  )
  run.check(
    'the answer carries the label planted on the other runtime — the check the repo cannot fake',
    answer.includes(codeword),
    `expected ${codeword}`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
