/**
 * G3-WIRE — an Anthropic-wire model answers through the Claude runtime.
 *
 * THE ACCEPTANCE OF LANE G. Everything else in G3 is arrangement; this is the
 * claim: a `claude-runtime` BYO connection pointed at llm-proxy can turn on a
 * model that speaks Anthropic Messages, and can turn on a chat-completions
 * model in the SAME session, each over its own wire.
 *
 * WHY THIS NEEDS A HUMAN AT THE KEYBOARD, stated so nobody tries to automate
 * it away: the only key entitled to `anthropic/*` is typed by the owner into
 * the form. No harness here ever sees, stores or forwards key material — the
 * case starts from a connection that ALREADY EXISTS and carries a stored
 * credential, and it BLOCKS with a clear reason rather than prompting for one.
 *
 * THE DISCRIMINATOR IS A NEGATIVE CONTROL ON THE SAME RIG, not a log line.
 * A turn that silently fell back to translation would still answer, so "the
 * model answered" proves nothing by itself. What makes it proof is that the
 * case FIRST probes the same model over chat-completions through the app's own
 * RPC and requires that to FAIL — measured 2026-08-14, llm-proxy returns
 * `400 unsupported endpoint` for every `anthropic/*` id there. A model that
 * cannot answer on chat-completions, answering in a live session, can only
 * have gone through the passthrough.
 *
 * TWO MORE WAYS THIS COULD PASS VACUOUSLY, both closed:
 * - a connection whose models are all chat-completions would turn happily and
 *   show nothing: the case REQUIRES a stored `wire: 'anthropic-messages'`;
 * - one working wire is not the claim: the mixed half sends a second turn on a
 *   chat-completions model in the SAME session and requires both to answer.
 *
 * Usage, at the sitting:
 *   bun run scripts/cdp/cases/g3-anthropic-wire.ts
 *   NESSY_G3_SLUG=<slug> bun run scripts/cdp/cases/g3-anthropic-wire.ts
 */

import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, sessionCommand, waitFor } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'

const ID = 'G3-WIRE'
const TITLE = 'An Anthropic-wire model turns through the Claude runtime, alongside a chat-completions one'

interface StoredModel {
  id: string
  wire?: string
}

interface StoredConnection {
  slug: string
  providerType?: string
  baseUrl?: string
  models?: Array<string | StoredModel>
}

/** Connections, read straight from the app — never from a fixture. */
async function connections(session: CdpSession): Promise<StoredConnection[]> {
  return session.call(`
    const res = await window.electronAPI.listLlmConnections()
    return (res?.connections ?? res ?? []).map(c => ({
      slug: c.slug,
      providerType: c.providerType,
      baseUrl: c.baseUrl ?? undefined,
      models: c.models ?? [],
    }))
  `)
}

const wireOf = (entry: string | StoredModel): string | undefined =>
  typeof entry === 'string' ? undefined : entry.wire

const idOf = (entry: string | StoredModel): string =>
  typeof entry === 'string' ? entry : entry.id

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const all = await connections(session)
  const wanted = process.env.NESSY_G3_SLUG
  const claudeRuntime = all.filter(c => c.providerType === 'claude-runtime')
  run.observe('claude-runtime connections', claudeRuntime.map(c => ({
    slug: c.slug,
    models: (c.models ?? []).map(m => `${idOf(m)}${wireOf(m) ? ` [${wireOf(m)}]` : ''}`),
  })))

  const candidates = claudeRuntime.filter(c =>
    (!wanted || c.slug === wanted)
    && (c.models ?? []).some(m => wireOf(m) === 'anthropic-messages'))

  if (candidates.length === 0) {
    blocked(
      'no claude-runtime connection carries a model stored with `wire: "anthropic-messages"`. '
      + 'That stamp is written by the form\'s probe on save, and the probe only sets it when '
      + '/v1/messages actually ANSWERS — which needs an entitled key. Run the form walk first: '
      + 'create a Claude Code connection on https://llm-proxy.t-tech.team with the entitled key, '
      + 'Fetch, pick an anthropic/* model AND a tgpt/* one, save.',
    )
  }

  const connection = candidates[0]!
  const wired = (connection.models ?? []).find(m => wireOf(m) === 'anthropic-messages')!
  const chatModel = (connection.models ?? []).find(m => wireOf(m) !== 'anthropic-messages')
  run.observe('connection under test', connection.slug)
  run.observe('anthropic-wire model', idOf(wired))
  run.observe('chat-completions model', chatModel ? idOf(chatModel) : null)

  // --- the negative control, first ----------------------------------------
  // Without this the case cannot tell passthrough from translation. It runs
  // through the app's own probe RPC, resolving the stored credential by slug —
  // no key is handled here.
  //
  // WHAT IT READS, and this took a wrong first version to get right: NOT the
  // verdict. Since G3 the probe deliberately ASKS `/v1/messages` when
  // chat-completions answers `unsupported endpoint`, so an anthropic model now
  // comes back `ok` — and reading that as "chat-completions served it" is
  // exactly backwards. The discriminator is the `wire` field: it is set ONLY
  // when the model answered on Anthropic Messages, which is the same thing as
  // saying chat-completions refused it. That is the control, and it is
  // stronger than the original because it is a positive fact rather than an
  // absence.
  const control = await session.call<{ verdict: string; wire?: string } | null>(`
    const r = await window.electronAPI.testLlmConnectionSetup({
      provider: 'anthropic', apiKey: '', slug: ${JSON.stringify(connection.slug)},
      baseUrl: ${JSON.stringify(connection.baseUrl ?? '')},
      customEndpoint: { api: 'openai-completions' },
      validateModels: [${JSON.stringify(idOf(wired))}],
    })
    const probe = (r.modelProbes ?? [])[0]
    return probe ? { verdict: probe.verdict, ...(probe.wire ? { wire: probe.wire } : {}) } : null
  `).catch(() => null)
  run.observe('probe verdict for the wired model', control)
  run.require(
    'the wired model answers ONLY on Anthropic Messages — the control that makes the turn meaningful',
    control?.wire === 'anthropic-messages',
    control
      ? `verdict=${control.verdict} wire=${control.wire ?? 'none'}`
      : 'probe failed',
  )

  // --- the turn itself -----------------------------------------------------
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', key)
  if (!key.fresh) {
    run.check('the case ran in a session it created', false, key.reason ?? 'unknown')
    return
  }

  await sessionCommand(session, key.sessionId, { type: 'setConnection', connectionSlug: connection.slug })
  const active = await waitFor(
    () => session.call<string | undefined>(`
      const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
      return s ? (s.llmConnection ?? undefined) : undefined
    `),
    value => value === connection.slug,
    { timeoutMs: 30_000, intervalMs: 1_000, label: `session to switch to ${connection.slug}` },
  ).catch(() => undefined)
  run.require(`the session runs on ${connection.slug}`, active === connection.slug, String(active))

  await selectModel(session, run, key.sessionId, key.workspaceId, idOf(wired))
  const first = await sendPrompt(session, key, 'Reply with exactly: WIRE-OK')
  const firstText = lastAssistantText(first.added)
  run.observe('answer on the anthropic wire', firstText.slice(0, 200))
  run.check('the anthropic-wire model produced a real answer', /WIRE-OK/i.test(firstText), firstText.slice(0, 160))

  // --- the mixed half ------------------------------------------------------
  if (!chatModel) {
    run.check(
      'mixed-wire routing was exercised',
      false,
      'this connection carries no chat-completions model — add a tgpt/* one and re-run',
    )
    return
  }

  await selectModel(session, run, key.sessionId, key.workspaceId, idOf(chatModel))
  const second = await sendPrompt(session, key, 'Reply with exactly: CHAT-OK')
  const secondText = lastAssistantText(second.added)
  run.observe('answer on the chat wire', secondText.slice(0, 200))
  run.check('the chat-completions model answered in the SAME session', /CHAT-OK/i.test(secondText), secondText.slice(0, 160))
  run.check(
    'both wires answered — the claim is routing, not one working wire',
    /WIRE-OK/i.test(firstText) && /CHAT-OK/i.test(secondText),
  )
}

/** Point the session at a model, then wait until the app agrees it is selected. */
async function selectModel(session: CdpSession, run: CaseRun, sessionId: string, workspaceId: string, model: string): Promise<void> {
  await session.call(`
    await window.electronAPI.setSessionModel(${JSON.stringify(sessionId)}, ${JSON.stringify(workspaceId)}, ${JSON.stringify(model)})
    return 1
  `)
  const settled = await waitFor(
    () => session.call<string | null>(`
      return (await window.electronAPI.getSessionModel(${JSON.stringify(sessionId)}, ${JSON.stringify(workspaceId)})) ?? null
    `),
    value => value === model,
    { timeoutMs: 20_000, intervalMs: 500, label: `session model becomes ${model}` },
  ).catch(() => null)
  // A prompt sent before the switch lands measures the OTHER model — AGT-10's
  // detector-3 lesson, and here it would measure the other WIRE.
  run.require(`the session is on ${model} before the turn`, settled === model, String(settled))
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
