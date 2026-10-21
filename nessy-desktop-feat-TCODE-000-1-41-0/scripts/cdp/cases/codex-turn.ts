/**
 * CODEX-TURN (walk C) — the codex runtime's BYO path, live for the first time.
 *
 * `codex-custom` has only ever been proven structurally. Its gateway sibling
 * was live-proven in past releases; the BYO endpoint never was, which is the
 * gap this closes: a real turn through the Responses adapter against llm-proxy,
 * on a key that is not the gateway's.
 *
 * THREE ASSERTIONS, and each names its own instrument:
 *
 * 1. A REAL COMPLETION lands end to end. Not "no error" — the model is asked
 *    for a token and the token has to come back, because an empty assistant
 *    turn also produces no error.
 * 2. THE BEARER SURVIVED. Measured on the adapter's own outgoing request via
 *    `[codex-adapter] upstream auth: …`, read out of the session agent's stderr
 *    ring buffer. The gateway swaps `Authorization` for `Nestor-Token`; a BYO
 *    endpoint must not be swapped, or every request 401s. Reading
 *    `resolveUpstreamRequest` in the source is not this measurement, so the
 *    case BLOCKS rather than passing when the line is absent.
 * 3. SYNC ENROLLMENT. The saved connection carries `modelsSyncedAt` and a
 *    `contextWindow` on its models (E2/G2) — the same thing BYO-CATALOG checks,
 *    repeated here because walk C creates its own connection and an unenrolled
 *    one is a real defect rather than a substrate problem.
 *
 * BONUS, and it is the owner's own reason for the walk: on the CODEX arm the
 * `anthropic/*` models must read as unavailable with the «only on Claude Code»
 * reason (G3's per-arm projection). Asserted from the stored connection rather
 * than the screen — if an anthropic-wire model got SAVED on a codex connection,
 * the per-arm rule failed open and the picker's marks were decoration.
 *
 * NO KEY IS HANDLED HERE. The connection must already exist, created by the
 * owner in walk C; this case reads it and turns on it.
 *
 * Usage:
 *   NESSY_PROXY_AUTH_DEBUG=1 NESSY_CDP_PORT=9224 bun run electron:dev
 *   NESSY_CDP_PORT=9224 bun run scripts/cdp/cases/codex-turn.ts
 *   NESSY_CDP_PORT=9224 NESSY_CODEX_SLUG=<slug> bun run scripts/cdp/cases/codex-turn.ts
 */

import type { CdpSession } from '../lib/connect.ts'
import { minPlausibleContextWindow } from '../lib/model-window.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, sessionCommand, waitFor } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'

const ID = 'CODEX-TURN'
const TITLE = 'A codex-runtime BYO connection turns against llm-proxy, keeping its Bearer'

interface StoredModel {
  id: string
  contextWindow?: number
  wire?: string
}

interface StoredConnection {
  slug: string
  providerType?: string
  baseUrl?: string
  modelsSyncedAt?: number | null
  models?: Array<string | StoredModel>
}

const idOf = (m: string | StoredModel): string => (typeof m === 'string' ? m : m.id)

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const all = await session.call<StoredConnection[]>(`
    const res = await window.electronAPI.listLlmConnections()
    return (res?.connections ?? res ?? []).map(c => ({
      slug: c.slug, providerType: c.providerType, baseUrl: c.baseUrl ?? undefined,
      modelsSyncedAt: c.modelsSyncedAt ?? null, models: c.models ?? [],
    }))
  `)

  const wanted = process.env.NESSY_CODEX_SLUG
  const codex = all.filter(c =>
    c.providerType === 'codex-runtime'
    && (c.baseUrl ?? '').includes('llm-proxy.t-tech.team')
    && (!wanted || c.slug === wanted))
  run.observe('codex-runtime connections', all
    .filter(c => c.providerType === 'codex-runtime')
    .map(c => ({ slug: c.slug, baseUrl: c.baseUrl, models: (c.models ?? []).map(idOf) })))

  if (codex.length === 0) {
    blocked(
      'no codex-runtime connection on llm-proxy. Walk C creates it: Add Connection → own key → '
      + 'Codex arm → the qwen-entitled key → Fetch → pick an openai-wire model (tgpt/*) → save.',
    )
  }

  const connection = codex[0]!
  const models = connection.models ?? []
  const model = models.map(idOf)[0]
  if (!model) blocked(`${connection.slug} carries no models`)
  run.observe('connection', connection.slug)
  run.observe('model', model)

  // --- (3) sync enrollment, before anything else can muddy it --------------
  const objects = models.filter((m): m is StoredModel => typeof m !== 'string')
  run.check(
    'the saved connection is enrolled in the metadata sync (E2/G2)',
    typeof connection.modelsSyncedAt === 'number' && connection.modelsSyncedAt > 0,
    String(connection.modelsSyncedAt),
  )
  // The threshold is the product's own placeholder floor, read rather than
  // restated — the second site P3.159's sweep found holding a hand-copied 4096
  // after `e3959bac5` unified both catalogue paths onto 1024. It matters less
  // here than in BYO-CATALOG (this is `some`, and codex's models declare
  // six-figure windows), but a harness that carries a number the product has
  // moved is the defect regardless of whether today's data hides it.
  const floor = minPlausibleContextWindow()
  run.check(
    'its models carry a contextWindow',
    objects.some(m => typeof m.contextWindow === 'number' && m.contextWindow >= floor),
    objects.map(m => `${m.id}=${m.contextWindow ?? '—'}`).join(', ') || 'all stored as bare ids',
  )

  // --- bonus: the per-arm rule held at SAVE time ---------------------------
  const anthropicWire = objects.filter(m => m.wire === 'anthropic-messages')
  run.check(
    'no anthropic-wire model was saved on the codex arm — the per-arm rule did not fail open',
    anthropicWire.length === 0,
    anthropicWire.map(m => m.id).join(', ') || 'none',
  )
  run.observe(
    'anthropic ids present at all',
    models.map(idOf).filter(id => id.startsWith('anthropic/')),
  )

  // --- (1) the turn --------------------------------------------------------
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

  // No explicit model selection: the connection's default is what walk C
  // picked, and it is the model this case is about. If a future version does
  // select one, note the signature — `setSessionModel(sessionId, workspaceId,
  // model)`. Feeding the model into the workspaceId slot silently no-ops, and
  // it cost two false FAILs in the sitting before the argument order was read.
  const turn = await sendPrompt(session, key, 'Reply with exactly: CODEX-OK', 240_000)
  const text = lastAssistantText(turn.added)
  run.observe('assistant text', text.slice(0, 200))
  run.check('a real completion came back through the Responses adapter', /CODEX-OK/i.test(text), text.slice(0, 160))
  run.check(
    'the turn produced actual content — an empty answer errors just as quietly',
    text.trim().length > 0,
    `${text.trim().length} chars`,
  )

  // --- (2) the Bearer, from the adapter's own line -------------------------
  const stderr = await session.call<string>(`
    return await window.electronAPI.getSessionRecentStderr(
      ${JSON.stringify(key.sessionId)}, ${JSON.stringify(key.workspaceId)}) ?? ''
  `).catch(() => '')
  const lines = stderr.split('\n').filter(line => line.includes('[codex-adapter] upstream auth:'))
  run.observe('adapter auth lines', lines.slice(-6))

  if (lines.length === 0) {
    blocked(
      'no `[codex-adapter] upstream auth:` line in the agent\'s stderr buffer. Start the app with '
      + 'NESSY_PROXY_AUTH_DEBUG=1 and re-run. Assertion 2 is not something this case will infer from '
      + 'the source — the other assertions above ran and are recorded.',
    )
  }

  const bearer = lines.filter(l => l.trimEnd().endsWith('bearer')).length
  const nestor = lines.filter(l => l.trimEnd().endsWith('nestor-token')).length
  run.observe('scheme counts', { bearer, 'nestor-token': nestor })
  run.check('the BYO codex upstream kept its Bearer', bearer > 0, `${bearer} bearer / ${nestor} nestor-token`)
  run.check(
    'no Nestor-Token went to this BYO endpoint',
    nestor === 0,
    nestor === 0 ? 'none' : 'the gateway swap fired against a non-gateway upstream — a real defect',
  )
  run.check(
    'the buffer names schemes only — no credential reached it',
    !/upstream auth: (?!bearer$|nestor-token$|none$)/m.test(lines.join('\n')),
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
