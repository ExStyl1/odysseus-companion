/**
 * RS-118 (F1.1289) — on a DIRECT Anthropic card, Opus 4.8 and Fable 5.1 run with their own 1M window and the user
 * sees the bare model id; an app launched with `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` reads 200K for the same turn.
 *
 * ## The row
 *
 * F1.1241 removed the Extended context (1M) switch: each model's own window decides, and a claude- id known at 1M or
 * more gets the `[1m]` selector at the spawn edge only (the bundled 2.1.274 holds native-1M models to 200K behind a
 * custom base URL without it), so the stored and displayed id stays bare (the owner's constraint, 2026-10-01). The
 * host no longer forces `CLAUDE_CODE_DISABLE_1M_CONTEXT`; an operator who exports it still gets 200K. SIT3-a drove
 * these arms BY HAND on RC #2 (2026-10-02: the meter's "1000k", `/context`'s "Window size 1,000,000", bare ids, and
 * 200K under the env var). F1.1289 is that hand drive as a case.
 *
 * ## What is read, and why there
 *
 * - **The window** is the `refreshContextUsage` session command's snapshot — the one `/context` and the meter's
 *   refresh read, filled from the live child's own `getContextUsage` (`ClaudeAgent.requestContextUsage`), i.e. the
 *   window the RUNTIME resolved, not one the host derived. The stored `tokenUsage` window is NOT read: F1.1283
 *   measured it at 200 000 after turn 1 of a fresh 1M child, a separate residue this case must not re-report.
 * - **The bare id** is `getSessionModel`, the turn's own rows and the page text: none may carry `[1m]`.
 * - **The launch** is read off THIS rig's app process (`ps eww`, scoped to its config dir, like `lib/app-env.ts`):
 *   the case cannot relaunch the app, so the sitting runs it twice — once as launched by the `env -u` launcher
 *   (`scripts/cdp/README.md`), once with `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` written after the `-u` list — and each
 *   run states which launch it measured. Under the variable only Opus 4.8 is driven (EC-1's step 3).
 *
 * A card is any `anthropic` providerType (a direct key, or a stub endpoint as SIT3-a used), never `claude-runtime`:
 * the loopback adapter's gateway window is its own row. `NESSY_CDP_RS118_CARD=<slug>` picks one.
 */

import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { sendPrompt } from '../lib/chat.ts'
import { appEnvBlockReason, appProcessPids, configDirScope, readAppEnvContamination } from '../lib/app-env.ts'
import { listConnections, selectModel, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, sessionCommandResult } from '../lib/state.ts'
import { turnAnswered } from '../lib/turn-evidence.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-118'
const TITLE = 'a direct Anthropic card runs Opus 4.8 and Fable 5.1 at their own 1M window with a bare model id, and a DISABLE_1M launch reads 200K'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'F1.1289',
  runtimes: ['claude'],
  credentials: 'owner: a direct Anthropic card (a key, or a stub endpoint). No key, token or credential file is read.',
} as const satisfies CaseMeta

/** The two models the row names, as `packages/shared/src/config/models.ts` spells them (pinned by the score test). */
export const RS118_MODELS = ['claude-opus-4-8', 'claude-fable-5-1'] as const

/** The operator's knob; the product never writes it since F1.1241. */
export const DISABLE_1M_ENV = 'CLAUDE_CODE_DISABLE_1M_CONTEXT'

export type LaunchReading = 'default' | 'disable-1m' | 'unread'

/**
 * Which launch the app's own environment shows. `unread` unless some process text carries `NESSY_CONFIG_DIR=` (the
 * read's positive control, as in `lib/app-env.ts`). The variable counts when its value is truthy the way the CLI
 * reads such switches (`1`, `true`, `yes`, `on`); `0` or an empty value is the default launch.
 */
export function launchFromPsText(texts: readonly string[]): LaunchReading {
  if (!texts.some(text => /(?:^|\s)NESSY_CONFIG_DIR=/.test(text))) return 'unread'
  const pattern = new RegExp(`(?:^|\\s)${DISABLE_1M_ENV}=(1|true|yes|on)(?=\\s|$)`, 'i')
  return texts.some(text => pattern.test(text)) ? 'disable-1m' : 'default'
}

/** The window each launch owes: the models' own 1M, or the CLI's 200K under the operator's variable. */
export function expectedWindow(launch: Exclude<LaunchReading, 'unread'>): number {
  return launch === 'disable-1m' ? 200_000 : 1_000_000
}

/** The models a launch drives: both by default, Opus 4.8 alone under the variable. */
export function modelsFor(launch: Exclude<LaunchReading, 'unread'>): readonly string[] {
  return launch === 'disable-1m' ? [RS118_MODELS[0]] : RS118_MODELS
}

/** Does this text show the spawn-edge selector the user must never see? */
export function carriesSelector(text: string): boolean {
  return /\[1m\]/i.test(text)
}

/** The window out of a `refreshContextUsage` answer, or `undefined` when it carries none. */
export function windowOf(result: unknown): number | undefined {
  const usage = (result as { success?: boolean, usage?: { contextWindow?: number | null } } | null | undefined)
  if (!usage || usage.success !== true) return undefined
  const window = usage.usage?.contextWindow
  return typeof window === 'number' && window > 0 ? window : undefined
}

function readLaunch(): LaunchReading {
  const texts = appProcessPids(configDirScope()).map(pid => {
    try {
      return Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString()
    } catch {
      return ''
    }
  })
  return launchFromPsText(texts)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const contamination = await readAppEnvContamination()
  const contaminated = appEnvBlockReason(contamination, 'the model and window this case reads')
  if (contaminated) blocked(contaminated)

  const launch = readLaunch()
  run.observe('the launch this run measures', launch)
  if (launch === 'unread') {
    blocked('the app process environment could not be read (no NESSY_CONFIG_DIR in it), so the case cannot say '
      + `whether ${DISABLE_1M_ENV} was set — export NESSY_CONFIG_DIR to the app's config dir and run again`)
  }

  const connections = await listConnections(session)
  const wanted = process.env.NESSY_CDP_RS118_CARD?.trim()
  const card = connections.find(row => row.providerType === 'anthropic' && (!wanted || row.slug === wanted))
  if (!card) {
    blocked(`no direct Anthropic card${wanted ? ` with slug ${wanted}` : ''} on this host (providerType "anthropic"; `
      + `listed: ${connections.map(row => `${row.slug}:${row.providerType}`).join(', ') || 'none'})`)
  }
  run.observe('the card under test', `${card.slug} (${card.providerType})`)
  run.observe('the card\'s models', card.models?.map(model => model.id) ?? '(none listed: the registry decides)')

  for (const model of modelsFor(launch)) {
    if (card.models && !card.models.some(row => row.id === model)) {
      run.check(`${model}: measured`, false, `UNMEASURED - the card does not offer ${model}; add it to the card and re-run`)
      continue
    }
    const key = await freshSession(session, `CDP ${ID} ${model} ${new Date().toISOString().slice(11, 19)}`)
    if (!key.fresh) blocked(`a fresh session could not be created: ${key.reason ?? 'unknown'}`)
    await switchRuntime(session, key.sessionId, card.slug)
    await waitForConnection(session, key.sessionId, card.slug)
    const selected = await selectModel(session, key, model)
    await focusWindow(session)
    const turn = await sendPrompt(session, key, 'Reply with the single word OK.', 240_000)
    const answered = turnAnswered(turn.added)
    run.check(`${model}: the turn answers on the card`, answered.ok, `UNMEASURED - ${answered.saw}`)

    const usage = await sessionCommandResult<unknown>(session, key.sessionId, { type: 'refreshContextUsage' })
      .catch(error => ({ success: false, error: String(error) }))
    const window = windowOf(usage)
    run.observe(`${model}: refreshContextUsage`, usage)
    run.check(
      `${model}: the runtime's resolved window is ${expectedWindow(launch)} (${launch} launch)`,
      window === expectedWindow(launch),
      window === undefined
        ? `UNMEASURED - refreshContextUsage carried no window: ${JSON.stringify(usage).slice(0, 300)}`
        : `read ${window}; F1.1241 owes ${expectedWindow(launch)} on a ${launch} launch`,
    )

    const shownModel = await session.call<string | null>(`
      return (await window.electronAPI.getSessionModel(
        ${JSON.stringify(key.sessionId)}, ${JSON.stringify(key.workspaceId)},
      )) ?? null
    `).catch(() => null)
    const pageText = await session.call<string>('return document.body.innerText').catch(() => '')
    const rowsText = JSON.stringify(turn.added)
    run.observe(`${model}: the ids the user sees`, { selected, sessionModel: shownModel })
    run.check(
      `${model}: the stored and displayed id is bare (no [1m] in the session model, the turn's rows or the page)`,
      shownModel === model && !carriesSelector(rowsText) && !carriesSelector(pageText),
      `session model ${JSON.stringify(shownModel)}; [1m] in rows: ${carriesSelector(rowsText)}, on the page: `
      + `${carriesSelector(pageText)} - the selector belongs at the spawn edge only (F1.1241, owner 2026-10-01)`,
    )
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
