/**
 * NCA-9 — `/quota` on the built-in Pi **Nessy Gateway** card renders a limit; a
 * **BYOK** Pi connection shows no `/quota` in the menu, and a typed one is told
 * so.
 *
 * T19's addendum, and the positive half is worth more than it looks: it is the
 * only live proof that `GET /api/v1/quota` answers for a CLI-PROXY-authenticated
 * user. Every unit test on that path stubs the transport
 * (`nestor-cloud-agent-quota.test.ts`, `pi-agent-quota.test.ts` — both inject a
 * fake `fetchImpl`), so nothing in the suite has ever spoken to the limiter with
 * a Pi card's credentials.
 *
 * ## The gate this case is measuring, and the two rules it now takes
 *
 * The MENU gate is `offersNestorQuota` in `agent/backend/composer-capabilities.ts`
 * (read it there by symbol — this docblock used to carry a copy of its OLD body
 * with a line anchor into that file, and both went stale at F1.6). Since F1.6
 * (`f6987934f`) it offers the row on the remote agent, or on a connection whose
 * baseUrl IS the Nessy Gateway chat base — a whole-URL match
 * (`isNessyGatewayBaseUrl`), whatever the runtime. The ANSWER on Pi is the
 * `describeQuota` override in `agent/pi-agent.ts`, which by DA1.10's written
 * decision still answers every baseUrl under the CLI prefix — so the menu offers
 * strictly less than the Pi seam serves, and a Pi card under the prefix but off
 * the chat base is withheld from the menu and still answered with a budget.
 *
 * The discriminator is therefore the **baseUrl**, not the providerType: two
 * `pi_compat` cards, one metered by the limiter and one not. The two arms are
 * picked so that BOTH rules agree about each, read off the app's own connection
 * list so a renamed card cannot fool it: the gateway arm by the menu's own
 * whole-URL rule (`isNessyGatewayChatBase`, `lib/nestor-cloud.ts`), and the BYOK
 * arm OUTSIDE the CLI prefix (`NESTOR_CLI_BASE_PREFIX`), where the menu withholds
 * the row and the seam refuses. A card between the two rules is picked for
 * neither arm, because each rule would score it differently.
 *
 * ## Three detectors for the negative half, because one is not enough
 *
 * 1. **State** — `composerCapabilities.slash.excludedCommandIds` contains
 *    `quota`. This is what the exclusion actually is.
 * 2. **Menu** — the palette, typed for real, offers no `quota` row. `peekPalette`
 *    drives the app's own filter; a state read alone would not catch a renderer
 *    that ignored the exclusion.
 * 3. **Seam** — a TYPED `/quota`, submitted as prose, is answered
 *    `Quota is not available on this runtime.` (`base-agent.ts` symbol `describeQuota`). The
 *    composer only decides what the MENU advertises; the seam answers on any
 *    runtime, and a user who types the command must be told rather than ignored.
 *
 * ## And the trap that makes the positive half read backwards
 *
 * On 1.39.0 a `/quota` success was an `info` `SessionManager` did not persist,
 * while an auth FAILURE (`level: 'warning'`) was — a store read was inverted.
 * Since the `answersSessionCommand` marker the success is stored too (fact 2 of
 * `lib/nestor-cloud.ts`); both halves still read the PANE. `classifyQuotaRender` then refuses to
 * count `No quota limits apply to your account.`, `Quota is unavailable: …` and
 * `Quota read was cancelled.` as "a limit rendered", because each of those is
 * also an `info` and each would otherwise pass.
 */

import { sendSlashCommand } from '../lib/chat.ts'
import {
  clearComposer,
  paletteState,
  peekPalette,
  submitComposer,
  typeIntoComposer,
} from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { pressKey } from '../lib/keys.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, transcript, waitForTurn, type SessionKey } from '../lib/state.ts'
import {
  NESSY_GATEWAY_CHAT_BASE_URL,
  NESTOR_CLI_BASE_PREFIX,
  QUOTA_STRINGS,
  chatPaneText,
  classifyQuotaRender,
  composerCapabilities,
  createSessionOn,
  currentWorkspaceId,
  isNessyGatewayChatBase,
  listCloudCapableConnections,
  openSessionInUi,
  paneDelta,
  waitForChatText,
  type CloudConnectionRow,
} from '../lib/nestor-cloud.ts'

const ID = 'NCA-9'
const TITLE = '/quota renders a limit on the built-in Pi Nessy Gateway card and is absent from a BYOK Pi connection\'s menu, which answers a typed one honestly'

/** `providerTypeToAgentProvider` collapses both onto the `pi` family. */
const PI_PROVIDER_TYPES = ['pi', 'pi_compat']

/** `isNestorCliBaseUrl` (`auth/nestor.ts`), restated — the Pi SEAM's rule, not the menu's. */
function isUnderCliPrefix(baseUrl?: string): boolean {
  return Boolean(baseUrl?.trim().startsWith(NESTOR_CLI_BASE_PREFIX))
}

async function openPiSession(
  run: CaseRun,
  session: CdpSession,
  workspaceId: string,
  card: CloudConnectionRow,
  label: string,
): Promise<SessionKey | undefined> {
  const key = await createSessionOn(run, session, { workspaceId, slug: card.slug, label, caseId: ID })
  if (!key) return undefined
  run.check(`${label}: the pane followed the new session`, await openSessionInUi(session, key), key.sessionId)
  return key
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const rows = await listCloudCapableConnections(session)
  const piRows = rows.filter(row => PI_PROVIDER_TYPES.includes(row.providerType))
  run.observe('pi-family connections', piRows.map(r => ({
    slug: r.slug, providerType: r.providerType, baseUrl: r.baseUrl,
    gateway: isNessyGatewayChatBase(r.baseUrl), underCliPrefix: isUnderCliPrefix(r.baseUrl), auth: r.isAuthenticated,
  })))

  const pinnedGateway = process.env.NESSY_CDP_PI_GATEWAY_SLUG?.trim()
  const pinnedByok = process.env.NESSY_CDP_PI_BYOK_SLUG?.trim()
  const gatewayCard = pinnedGateway
    ? piRows.find(r => r.slug === pinnedGateway)
    : piRows.find(r => isNessyGatewayChatBase(r.baseUrl))
  const byokCard = pinnedByok
    ? piRows.find(r => r.slug === pinnedByok)
    : piRows.find(r => !isUnderCliPrefix(r.baseUrl))

  if (!gatewayCard) {
    blocked(
      'no Pi connection whose baseUrl IS the Nessy Gateway chat base '
      + `(${NESSY_GATEWAY_CHAT_BASE_URL}), so the positive half has nothing to measure — and that half is the only live `
      + 'proof that GET /api/v1/quota answers for a CLI-proxy-authenticated user, which every unit test stubs. '
      + `Pi-family connections here: ${piRows.map(r => `${r.slug}(${r.baseUrl ?? 'no baseUrl'})`).join(', ') || 'none'}`,
    )
  }
  if (gatewayCard.isAuthenticated === false) {
    blocked(
      `the Pi gateway card "${gatewayCard.slug}" is not authenticated, so /quota would report an auth failure and `
      + 'this run would measure the sign-in. Sign it in through the app (one-click dp auth) and re-run.',
    )
  }
  run.observe('gateway card', { slug: gatewayCard.slug, baseUrl: gatewayCard.baseUrl })
  run.require(
    'the gateway card IS the Nessy Gateway chat base (the menu gate\'s whole-URL rule)',
    isNessyGatewayChatBase(gatewayCard.baseUrl),
    `${gatewayCard.slug} baseUrl=${String(gatewayCard.baseUrl)} — a card merely under the CLI prefix is withheld from `
    + 'the menu since F1.6, so the positive half would fail on the pick rather than on the product',
  )

  const workspaceId = await currentWorkspaceId(session)

  // === half 1 — the built-in Pi Nessy Gateway card ========================
  const gatewayKey = await openPiSession(run, session, workspaceId, gatewayCard, 'gateway')
  if (!gatewayKey) blocked(`could not open a session on ${gatewayCard.slug}`)

  const gatewayCaps = await composerCapabilities(session, gatewayKey.sessionId)
  run.observe('gateway composer capabilities', gatewayCaps)
  run.check(
    `the gateway card's composer does NOT exclude /quota`,
    !gatewayCaps.excludedCommandIds.includes('quota'),
    `excludedCommandIds=${JSON.stringify(gatewayCaps.excludedCommandIds)}`,
  )

  const beforeGateway = await chatPaneText(session)
  await sendSlashCommand(session, gatewayKey, {
    token: 'quota',
    match: /quota/i,
    expectComposer: '',
    submitOnSelect: true,
    timeoutMs: 180_000,
  })
  const gatewaySettled = await waitForChatText(
    session,
    text => classifyQuotaRender(paneDelta(beforeGateway, text)).verdict !== 'nothing',
    { label: 'the gateway /quota render', timeoutMs: 90_000 },
  )
  const gatewayRender = classifyQuotaRender(paneDelta(beforeGateway, gatewaySettled.text))
  run.observe('gateway /quota verdict', gatewayRender.verdict)
  run.observe('gateway /quota render', gatewayRender.delta.slice(0, 800))
  run.check(
    'the Pi gateway card renders at least one quota limit line',
    gatewayRender.verdict === 'limits-rendered',
    gatewayRender.verdict === 'limits-rendered'
      ? gatewayRender.limitLines.join(' | ')
      : `verdict=${gatewayRender.verdict} — this is NOT a rendered limit: ${JSON.stringify(gatewayRender.delta.slice(0, 300))}`,
  )
  // The three near-misses, named so a green cannot be read into one of them.
  run.check(
    'the render is a budget, not the empty-limiter or failure text',
    !gatewayRender.delta.includes(QUOTA_STRINGS.noLimits)
      && !gatewayRender.delta.includes(QUOTA_STRINGS.unavailablePrefix)
      && !gatewayRender.delta.includes(QUOTA_STRINGS.notOnRuntime),
    gatewayRender.delta.slice(0, 300),
  )

  // === half 2 — a BYOK Pi connection =====================================
  if (!byokCard) {
    blocked(
      'no BYOK Pi connection (a pi/pi_compat card whose baseUrl is outside the Nessy Gateway CLI prefix), so the '
      + 'negative half has nothing to measure. Without it this run shows that the gateway card offers /quota but not '
      + 'that anything is EXCLUDED — which is the half the row is about. Add a BYO endpoint connection, set '
      + `NESSY_CDP_PI_BYOK_SLUG to its slug, and re-run. The gateway half rendered: ${gatewayRender.verdict}.`,
    )
  }
  run.observe('byok card', { slug: byokCard.slug, baseUrl: byokCard.baseUrl })
  run.require(
    'the BYOK card is genuinely outside the gateway CLI prefix',
    !isUnderCliPrefix(byokCard.baseUrl),
    `${byokCard.slug} baseUrl=${String(byokCard.baseUrl)}`,
  )

  const byokKey = await openPiSession(run, session, workspaceId, byokCard, 'byok')
  if (!byokKey) blocked(`could not open a session on ${byokCard.slug}`)

  // detector 1 — the state
  const byokCaps = await composerCapabilities(session, byokKey.sessionId)
  run.observe('byok composer capabilities', byokCaps)
  run.check(
    'the BYOK connection excludes /quota from the composer',
    byokCaps.excludedCommandIds.includes('quota'),
    `excludedCommandIds=${JSON.stringify(byokCaps.excludedCommandIds)}`,
  )

  // detector 2 — the menu the user actually sees
  const entries = await peekPalette(session, 'quota')
  run.observe('palette entries offered for "quota" on the BYOK card', entries)
  run.check(
    'no /quota row is offered in the slash menu',
    !entries.some(text => /quota/i.test(text)),
    JSON.stringify(entries),
  )

  // detector 3 — the seam still answers a TYPED one
  const beforeTyped = await chatPaneText(session)
  const sinceCount = (await transcript(session, byokKey)).length
  await clearComposer(session)
  await typeIntoComposer(session, '/quota')
  // The palette may still be open on some other fuzzy match; Enter would select
  // a row instead of sending, and `submitComposer` refuses while it is open.
  if ((await paletteState(session)).open) await pressKey(session, 'Escape')
  await submitComposer(session)
  await waitForTurn(session, byokKey, sinceCount, 180_000).catch(() => undefined)
  const typedSettled = await waitForChatText(
    session,
    text => classifyQuotaRender(paneDelta(beforeTyped, text)).verdict !== 'nothing',
    { label: 'the typed /quota answer on the BYOK card', timeoutMs: 90_000 },
  )
  const typedRender = classifyQuotaRender(paneDelta(beforeTyped, typedSettled.text))
  run.observe('typed /quota verdict on the BYOK card', typedRender.verdict)
  run.observe('typed /quota answer', typedRender.delta.slice(0, 600))
  run.check(
    `a typed /quota on the BYOK card is answered "${QUOTA_STRINGS.notOnRuntime}"`,
    typedRender.verdict === 'not-on-runtime',
    typedRender.verdict === 'not-on-runtime'
      ? QUOTA_STRINGS.notOnRuntime
      : `verdict=${typedRender.verdict} — ${JSON.stringify(typedRender.delta.slice(0, 300))}`,
  )
  run.check(
    'the BYOK card did not answer with a budget it has no claim to',
    typedRender.verdict !== 'limits-rendered',
    typedRender.limitLines.join(' | ') || 'no limit lines',
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
