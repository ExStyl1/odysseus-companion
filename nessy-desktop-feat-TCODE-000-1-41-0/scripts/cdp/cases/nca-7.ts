/**
 * NCA-7 — `/quota` renders on the default gateway AND on a custom-baseUrl
 * connection, and the custom one is not answered by the default gateway's
 * numbers.
 *
 * `resolveNestorQuotaUrl` takes the ORIGIN from the connection and keeps the
 * path fixed (`backend/internal/nestor-quota.ts:41-47`), so the whole row is
 * about whether the request followed the connection it was issued from. Both
 * origins in ONE sitting, because a run that only exercised the default one
 * cannot distinguish "follows the connection" from "always the compiled-in URL".
 *
 * ## The detector, and the inverted one it replaces
 *
 * **A `/quota` success never reaches `getSessionMessages`.** `SessionManager`'s
 * `case 'info'` persists a message only when it starts with `Compacted` or
 * carries `level: 'warning'` (`SessionManager.ts:24074-24138`), and
 * `describeNestorQuota` yields the SUCCESS render as a plain `info` while
 * reserving `warning` for an AUTH FAILURE. So a transcript-shaped detector finds
 * nothing when the feature works and finds the failure when it does not — it is
 * exactly inverted. The render is read off the rendered pane
 * (`lib/nestor-cloud.ts` fact 2).
 *
 * **"An info message appeared" is not "a limit rendered".** Every outcome of
 * `describeNestorQuota` is an `info`: an HTTP 500, an empty limiter, a cancelled
 * read. `classifyQuotaRender` separates them and only `limits-rendered` counts;
 * the other verdicts are named in the failure so the reader knows which one
 * happened.
 *
 * ## What is a BLOCK and not a FAIL
 *
 * - no second connection with a custom baseUrl — the operator's to create;
 * - the custom baseUrl's origin equals the default's — then the two renders are
 *   legitimately identical and this run cannot show the request followed the
 *   connection. Blocking is the honest answer; passing would be the vacuous one.
 */

import { sendSlashCommand } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, type SessionKey } from '../lib/state.ts'
import {
  CLOUD_PROVIDER_TYPE,
  NESTOR_DEFAULT_QUOTA_ORIGIN,
  chatPaneText,
  classifyQuotaRender,
  composerCapabilities,
  createSessionOn,
  currentWorkspaceId,
  listCloudCapableConnections,
  openSessionInUi,
  paneDelta,
  QUOTA_STRINGS,
  requireCloudConnection,
  waitForChatText,
  type CloudConnectionRow,
  type QuotaRender,
} from '../lib/nestor-cloud.ts'

const ID = 'NCA-7'
const TITLE = '/quota renders a limit on the default gateway AND on a custom-baseUrl remote connection, and the two answers are not the same numbers'

async function quotaOn(
  run: CaseRun,
  session: CdpSession,
  key: SessionKey,
  label: string,
): Promise<QuotaRender> {
  const before = await chatPaneText(session)
  await sendSlashCommand(session, key, {
    token: 'quota',
    match: /quota/i,
    expectComposer: '',
    submitOnSelect: true,
    timeoutMs: 180_000,
  })
  const settled = await waitForChatText(
    session,
    text => {
      const delta = paneDelta(before, text)
      return classifyQuotaRender(delta).verdict !== 'nothing'
    },
    { label: `${label}: the /quota render`, timeoutMs: 90_000 },
  )
  const render = classifyQuotaRender(paneDelta(before, settled.text))
  run.observe(`${label} /quota verdict`, render.verdict)
  run.observe(`${label} /quota render`, render.delta.slice(0, 800))
  return render
}

async function sessionOnCard(
  run: CaseRun,
  session: CdpSession,
  workspaceId: string,
  card: CloudConnectionRow,
  label: string,
): Promise<SessionKey | undefined> {
  const key = await createSessionOn(run, session, { workspaceId, slug: card.slug, label, caseId: ID })
  if (!key) return undefined
  run.check(`${label}: the pane followed the new session`, await openSessionInUi(session, key), key.sessionId)
  const caps = await composerCapabilities(session, key.sessionId)
  run.check(
    `${label}: the session runs the remote agent`,
    caps.activeRuntime === CLOUD_PROVIDER_TYPE,
    `activeRuntime=${String(caps.activeRuntime)}`,
  )
  run.check(
    `${label}: the composer offers /quota`,
    !caps.excludedCommandIds.includes('quota'),
    `excludedCommandIds=${JSON.stringify(caps.excludedCommandIds)}`,
  )
  return caps.activeRuntime === CLOUD_PROVIDER_TYPE ? key : undefined
}

function originOf(baseUrl?: string): string | undefined {
  if (!baseUrl?.trim()) return undefined
  try {
    return new URL(baseUrl).origin
  } catch {
    return undefined
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const rows = await listCloudCapableConnections(session)
  const cloudRows = rows.filter(row => row.providerType === CLOUD_PROVIDER_TYPE)
  run.observe('remote-agent connections', cloudRows.map(r => ({ slug: r.slug, baseUrl: r.baseUrl ?? '(built-in)', auth: r.isAuthenticated })))

  const defaultCard = await requireCloudConnection(session, {
    pinnedSlug: process.env.NESSY_CDP_CLOUD_SLUG ?? cloudRows.find(r => !r.baseUrl?.trim())?.slug,
    purpose: 'NCA-7 arm A (the default gateway)',
  })
  const pinnedCustom = process.env.NESSY_CDP_NESTOR_CUSTOM_SLUG?.trim()
  const customCard = pinnedCustom
    ? cloudRows.find(row => row.slug === pinnedCustom)
    : cloudRows.find(row => row.slug !== defaultCard.slug && Boolean(originOf(row.baseUrl)))

  const workspaceId = await currentWorkspaceId(session)

  // --- arm A: the default gateway -----------------------------------------
  const defaultKey = await sessionOnCard(run, session, workspaceId, defaultCard, 'default')
  if (!defaultKey) blocked(`could not open a remote-agent session on ${defaultCard.slug}`)
  const defaultRender = await quotaOn(run, session, defaultKey, 'default')
  run.check(
    `arm A (${defaultCard.slug}): /quota rendered at least one limit line`,
    defaultRender.verdict === 'limits-rendered',
    defaultRender.verdict === 'limits-rendered'
      ? defaultRender.limitLines.join(' | ')
      : `verdict=${defaultRender.verdict} — ${describeVerdict(defaultRender)}`,
  )

  // --- arm B: a custom baseUrl --------------------------------------------
  if (!customCard) {
    blocked(
      'no SECOND remote-agent connection with a custom baseUrl, so this run cannot show that the quota request '
      + 'follows the connection\'s own origin rather than the compiled-in one — the whole claim of this row. Create '
      + 'one in Settings → AI pointed at a non-default Nestor origin, set NESSY_CDP_NESTOR_CUSTOM_SLUG to its slug, '
      + `and re-run. Remote-agent connections here: ${cloudRows.map(r => `${r.slug}(${r.baseUrl ?? 'built-in'})`).join(', ') || 'none'}. `
      + `Arm A rendered: ${defaultRender.verdict}.`,
    )
  }
  const customOrigin = originOf(customCard.baseUrl)
  run.observe('custom connection', { slug: customCard.slug, baseUrl: customCard.baseUrl, origin: customOrigin })
  if (!customOrigin) {
    blocked(
      `${customCard.slug} carries no parseable baseUrl (${JSON.stringify(customCard.baseUrl)}), so its quota read `
      + 'would fall back to the compiled-in URL by design (`resolveNestorQuotaUrl` returns the default on an '
      + 'unparseable value) and arm B would measure arm A again.',
    )
  }
  if (customOrigin === NESTOR_DEFAULT_QUOTA_ORIGIN) {
    blocked(
      `${customCard.slug} points at ${customOrigin}, which IS the default gateway origin. Its numbers would `
      + 'legitimately equal arm A\'s and this run could not distinguish "the read followed the connection" from '
      + '"the read always uses the compiled-in URL". Point it at a different Nestor origin and re-run.',
    )
  }

  const customKey = await sessionOnCard(run, session, workspaceId, customCard, 'custom')
  if (!customKey) blocked(`could not open a remote-agent session on ${customCard.slug}`)
  const customRender = await quotaOn(run, session, customKey, 'custom')
  run.check(
    `arm B (${customCard.slug}): /quota rendered at least one limit line`,
    customRender.verdict === 'limits-rendered',
    customRender.verdict === 'limits-rendered'
      ? customRender.limitLines.join(' | ')
      : `verdict=${customRender.verdict} — ${describeVerdict(customRender)}`,
  )

  // --- the claim the two arms exist for -----------------------------------
  const same = defaultRender.limitLines.join('\n') === customRender.limitLines.join('\n')
  run.check(
    'the custom-baseUrl connection was NOT answered by the default gateway\'s numbers',
    !same,
    same
      ? `both arms rendered ${JSON.stringify(defaultRender.limitLines)} — either the read ignored the connection's `
        + 'origin, or the two origins are serving the same limiter (check the baseUrls above before filing this)'
      : `A: ${JSON.stringify(defaultRender.limitLines)} vs B: ${JSON.stringify(customRender.limitLines)}`,
  )
}

/** Say which non-claim outcome happened, in the module's own words. */
function describeVerdict(render: QuotaRender): string {
  switch (render.verdict) {
    case 'no-limits':
      return `"${QUOTA_STRINGS.noLimits}" — a DISABLED limiter, which is the opposite of exhausted and is not a limit`
    case 'unavailable':
      return `"${QUOTA_STRINGS.unavailablePrefix} …" — the read failed: ${render.delta.slice(0, 300)}`
    case 'cancelled':
      return `"${QUOTA_STRINGS.cancelled}" — something aborted the read mid-flight`
    case 'not-on-runtime':
      return `"${QUOTA_STRINGS.notOnRuntime}" — the seam answered, so this session is not on the remote agent`
    default:
      return `nothing recognisable reached the pane: ${JSON.stringify(render.delta.slice(0, 300))}`
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
