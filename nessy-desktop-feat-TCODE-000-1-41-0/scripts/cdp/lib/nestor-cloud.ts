/**
 * Shared reads for the NCA wave (`cases/nca-1.ts` … `nca-9.ts`) — the Nestor
 * Cloud remote agent on A2A 1.0 at `/api/v2/code-agent/a2a`.
 *
 * Everything here is a READ or a session creation. Nothing installs a plugin,
 * writes the operator's `config.json`, or touches `~/.nessy/dp_auth_creds.json`
 * (`scripts/cdp/README.md`). The one file any case in this wave writes is its
 * own probe file, into the session's own working directory, and it removes it.
 *
 * ## Three measured facts this module exists to encode
 *
 * **1. A remote connection cannot be SWITCHED into — it must be CREATED on.**
 * `switchSessionRuntime` refuses a `nestor-cloud-agent` target with
 * `CONNECTION_NOT_SWITCHABLE` ("Remote connections cannot be switched into an
 * existing session") and the picker filters it out of the target list, so
 * `sessionCommand(id, {type:'setConnection'})` — the door every other wave uses
 * — is closed here BY DESIGN. Creation is a separate, shipped door:
 * `CreateSessionOptions.llmConnection` rides the `sessions:create` RPC the
 * renderer's own New Chat uses. `q6-live.ts` learned this the expensive way (its
 * cloud control turned into a deterministic FAIL when the refusal landed) and
 * {@link createSessionOn} is that lesson, lifted.
 *
 * **2. The SCREEN is the `/quota` detector; the store is build-dependent.** On
 * 1.39.0 a successful render never reached `getSessionMessages`: `case 'info'`
 * kept only `Compacted…` and `level: 'warning'` rows, so a store read was
 * INVERTED (nothing on success, the auth failure on failure). Since the
 * `answersSessionCommand` marker (`BaseAgent.markSessionCommandAnswer`, kept by
 * `SessionManager` for a non-ephemeral session — the test
 * `session-command-answer-persistence.test.ts`) the answer IS stored: measured
 * 2026-09-23 on the packaged 1.40.0, the Pi card's `Quota: …` row was in the
 * store and on screen alike (F1.203's RS-39/RS-50 drives). The renderer appends
 * every `info` either way (`handleInfo`), so a case reads the pane — hence
 * {@link chatPaneText} — and may OBSERVE the store beside it, never gate on it.
 *
 * The same applies to `case 'status'`: the rate-limit retry lines
 * (`nestor-cloud/turn.ts`) are renderer-only and are dropped again on interrupt.
 *
 * **3. `this.debug` is an ALWAYS-ON log line, not a debug-mode one.**
 * `SessionManager` wires `agent.onDebug` to `sessionLog.info`
 * (`SessionManager.ts:16023,:16045`), so `NestorCloudAgent.postInit`'s two
 * fallback confessions reach the app log on any run that HAS an app log. A
 * packaged build has none (`apps/electron/src/main/logger.ts` turns both
 * transports off when `isDebugMode` is false), which is why {@link openAppLog}
 * blocks rather than reporting a clean window.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { CdpSession } from './connect.ts'
import { blocked, type CaseRun } from './report.ts'
import { listSessions, waitFor, type SessionKey } from './state.ts'

/** `providerTypeToAgentProvider` maps this one to itself — it is both. */
export const CLOUD_PROVIDER_TYPE = 'nestor-cloud-agent'

/** `packages/shared/src/auth/nestor.ts` symbol `NESTOR_CLI_BASE_PREFIX`, restated (the cdp tsconfig resolves no workspace aliases). */
export const NESTOR_CLI_BASE_PREFIX = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/'

/**
 * `backend/internal/drivers/upstream-target.ts` symbol `NESSY_GATEWAY_CHAT_BASE_URL`,
 * restated — the ONE connection URL the product treats as the Nessy Gateway.
 *
 * F1.6 (`f6987934f`) moved the `/quota` MENU gate onto it: `offersNestorQuota`
 * offers the row on `nestor-cloud-agent` or on a connection whose baseUrl is this
 * URL, WHOLE — never a host or a `…/api/v1/cli/` prefix match — whatever the
 * runtime. So a case that picks "the gateway card" by
 * {@link NESTOR_CLI_BASE_PREFIX} can pick a BYO card at a CLI-prefix subpath the
 * menu withholds. {@link isNessyGatewayChatBase} is the menu's own rule.
 */
export const NESSY_GATEWAY_CHAT_BASE_URL = `${NESTOR_CLI_BASE_PREFIX}openai-like/v1`

/** `isNessyGatewayBaseUrl`, restated: trailing slashes and surrounding space are not a different URL. */
export function isNessyGatewayChatBase(baseUrl?: string): boolean {
  const normalized = (baseUrl ?? '').trim().replace(/\/+$/, '')
  return normalized.length > 0 && normalized === NESSY_GATEWAY_CHAT_BASE_URL
}

/** `backend/internal/nestor-quota.ts:27` — the compiled-in default origin. */
export const NESTOR_DEFAULT_QUOTA_ORIGIN = 'https://code-completion-nestor.tcsbank.ru'

/**
 * Every literal `/quota` can produce, and which of them count as "a limit
 * rendered".
 *
 * The failure strings are listed so a case can REJECT them explicitly. A
 * detector that accepted "an info message appeared" would pass on a gateway
 * that answered HTTP 500, which is the vacuous pass this block is written
 * against.
 */
export const QUOTA_STRINGS = {
  /** Head of a successful render (`nestor-quota.ts:199-202`). */
  head: 'Quota:',
  /** A disabled limiter — honest, but NOT a limit (`:196`). */
  noLimits: 'No quota limits apply to your account.',
  /** Non-OK HTTP (`:181`) and the exception path (`:219`) share this prefix. */
  unavailablePrefix: 'Quota is unavailable:',
  /** The user's Stop landed on the read (`:207`). */
  cancelled: 'Quota read was cancelled.',
  /** `BaseAgent.describeQuota` — the seam's answer on a runtime without one. */
  notOnRuntime: 'Quota is not available on this runtime.',
} as const

/**
 * The bullet that starts one rendered limit, e.g. `- Daily [user] (allowed): 73% remaining`.
 *
 * **Not anchored to a line start, and that is measured rather than defensive.**
 * `describeNestorQuota` joins `Quota:` and its limits with `\n`, but the info row
 * renders as a bare `<span>{content}</span>` inside a `flex items-center` div
 * with no `white-space` override (`ChatDisplay.tsx`, the info arm), so CSS
 * collapses those newlines and `innerText` hands back ONE line:
 *
 *     Quota: - Daily [user] (allowed): 73% remaining - Monthly [user] (allowed): 91% remaining
 *
 * A `/^- /m` detector would score that as zero limit lines and report a failure
 * about a budget the user is looking at. `textContent` — the fallback
 * {@link chatPaneText} uses when `innerText` is blank — keeps the newlines, so
 * both spellings reach a case and the pattern must accept both.
 *
 * `formatNestorQuotaLimit` always emits `- <head>` and the head always carries
 * the title; the `(state)` clause is present whenever the backend sent one, and
 * `quota_handler.go:18` mandates that clients read `status` rather than deriving
 * availability, so a limit without it is a backend that sent no status — worth
 * observing, not worth failing on.
 */
export const QUOTA_LIMIT_BULLET = /(?:^|\s)- (?=\S)/

/**
 * The limits rendered under a `Quota:` head, in either whitespace spelling.
 *
 * Caveat, stated rather than hidden: the split is on the bullet marker, so a
 * backend `status.message` containing a literal `" - "` would be counted as two
 * limits. `formatNestorQuotaLimit` joins its own parts with an EM-dash (` — `),
 * never a hyphen, so nothing we produce triggers it — but the message text is
 * the gateway's to choose. A case should assert "at least one" and print what it
 * found, which is what NCA-7 and NCA-9 do.
 */
export function quotaLimitLines(delta: string): string[] {
  const head = delta.indexOf(QUOTA_STRINGS.head)
  if (head < 0) return []
  const body = delta.slice(head + QUOTA_STRINGS.head.length)
  return body
    .split(new RegExp(QUOTA_LIMIT_BULLET.source, 'g'))
    // F1.203 — a limit is ONE line (`formatNestorQuotaLimit`), so where the
    // render kept its newlines the first one ends it. Measured 2026-09-23 on the
    // packaged 1.40.0 (RS-39): the pane delta runs to the END of the pane, and
    // without this cut the last limit carried the composer's footer —
    // `… (resets …) Todo Info Press Shift + Return … Bypass DeepSeek V4 Flash Low
    // Branch` — which differs per card and would score one budget as two.
    .map(part => (part.trimStart().split('\n')[0] ?? '').replace(/\s+/g, ' ').trim())
    .filter(part => part.length > 0)
}

/** The two `nestor-cloud` codec warnings a live stream must not produce. */
export const CODEC_SKIP_WARNINGS = [
  'Unknown A2A stream envelope key',
  'Skipped A2A part with no recognised content key',
  'Skipped server_tool_status with an unknown state',
  'Skipped malformed server_tool_invocation part',
] as const

/**
 * The two confessions `NestorCloudAgent.postInit` writes when the AgentCard did
 * not supply the composer modes (`nestor-cloud-agent.ts:95,:101`).
 */
export const CARD_FALLBACK_CONFESSIONS = [
  'Nestor Cloud AgentCard did not advertise composer modes',
  'Nestor Cloud AgentCard unavailable',
] as const

/**
 * The static pair `resolveNestorCloudPermissions` falls back to
 * (`backend/composer-capabilities.ts:11-28`).
 *
 * Restated so a case can SAY what it cannot distinguish: `KNOWN_REMOTE_MODES`
 * maps a card's `plan`/`act` onto byte-identical options, so a card declaring
 * exactly those two is observationally identical to the fallback on this
 * surface. NCA-3 turns that into a BLOCK, not a pass.
 */
export const FALLBACK_REMOTE_MODE_IDS = ['plan', 'act'] as const

export interface CloudConnectionRow {
  slug: string
  name?: string
  providerType: string
  baseUrl?: string
  defaultModel?: string
  isAuthenticated?: boolean
}

/**
 * The app's own connection list, with the status flag the picker reads.
 *
 * `listLlmConnectionsWithStatus` rather than `listLlmConnections`: a card that
 * exists and is not signed in is a different precondition failure from a card
 * that is absent, and a case that cannot tell them apart tells the operator to
 * do the wrong thing.
 */
export async function listCloudCapableConnections(session: CdpSession): Promise<CloudConnectionRow[]> {
  return session.call<CloudConnectionRow[]>(`
    const rows = await window.electronAPI.listLlmConnectionsWithStatus()
    return (rows ?? []).map(c => ({
      slug: c.slug, name: c.name, providerType: c.providerType,
      baseUrl: c.baseUrl, defaultModel: c.defaultModel,
      isAuthenticated: c.isAuthenticated,
    }))
  `)
}

/** The remote-agent card, or BLOCKED naming what the host actually has. */
export async function requireCloudConnection(
  session: CdpSession,
  options: { pinnedSlug?: string; purpose?: string } = {},
): Promise<CloudConnectionRow> {
  const rows = await listCloudCapableConnections(session)
  const cloud = rows.filter(row => row.providerType === CLOUD_PROVIDER_TYPE)
  const pinned = options.pinnedSlug?.trim()
  const chosen = pinned ? cloud.find(row => row.slug === pinned) : cloud[0]
  if (!chosen) {
    blocked(
      `${options.purpose ?? 'this case'} needs a Nessy Cloud Agent connection (providerType `
      + `\`${CLOUD_PROVIDER_TYPE}\`, the built-in \`nessy-cloud-agent\` card)`
      + (pinned ? ` named ${pinned}` : '')
      + '. Add it through the app\'s own connection setup and complete the one-click dp sign-in. '
      + `The host lists: ${rows.map(r => `${r.slug}(${r.providerType})`).join(', ') || 'nothing'}`,
    )
  }
  if (chosen.isAuthenticated === false) {
    blocked(
      `the Nessy Cloud Agent card "${chosen.slug}" is not authenticated, so every turn in this case would measure `
      + 'the sign-in and not the wire. Sign it in through the app (one-click dp auth) and re-run.',
    )
  }
  return chosen
}

/** The workspace to create sessions in — the currently open session's own. */
export async function currentWorkspaceId(session: CdpSession): Promise<string> {
  const sessions = await listSessions(session)
  if (sessions.length === 0) {
    blocked('the app has no sessions, so there is no workspace to create one in. Open the app on a workspace first.')
  }
  const pinned = process.env.NESSY_CDP_WORKSPACE_ID?.trim()
  const ids = [...new Set(sessions.map(s => s.workspaceId))]
  if (pinned) {
    if (!ids.includes(pinned)) {
      blocked(`NESSY_CDP_WORKSPACE_ID=${pinned} is not one of the ${ids.length} workspaces the app has (${ids.join(', ')})`)
    }
    return pinned
  }
  const newest = [...sessions].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0]!
  return newest.workspaceId
}

/**
 * A session that EXISTS on a connection, created there rather than switched
 * onto it — see fact 1 in the module doc.
 *
 * `fresh` is not assumed: the read-back below is the "in EFFECT, not merely
 * requested" discipline the rest of the harness applies to a switch, against the
 * app's own `getSessions()`. A case that skipped it would send its prompt to
 * whatever runtime the session actually resolved and file the answer under this
 * one.
 */
export async function createSessionOn(
  run: CaseRun,
  session: CdpSession,
  options: { workspaceId: string; slug: string; label: string; caseId: string },
): Promise<SessionKey | undefined> {
  const name = `CDP ${options.caseId} ${options.label} ${new Date().toISOString().slice(11, 19)}`
  const created = await session.call<{ id?: string; workspaceId?: string; error?: string }>(`
    try {
      const s = await window.electronAPI.createSession(${JSON.stringify(options.workspaceId)}, {
        name: ${JSON.stringify(name)},
        llmConnection: ${JSON.stringify(options.slug)},
      })
      return { id: s && s.id, workspaceId: (s && s.workspaceId) || ${JSON.stringify(options.workspaceId)} }
    } catch (e) {
      return { error: String((e && e.message) || e) }
    }
  `)
  run.observe(`${options.label}-session`, created)
  if (!created.id) {
    run.check(`${options.label}: a session was created on ${options.slug}`, false, created.error ?? 'createSession returned no id')
    return undefined
  }
  const active = await waitFor(
    () => session.call<string | undefined>(`
      const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(created.id)})
      return s ? (s.llmConnection ?? undefined) : undefined
    `),
    value => value === options.slug,
    { timeoutMs: 30_000, intervalMs: 1_000, label: `the created session to report ${options.slug}` },
  ).catch(() => undefined)
  run.check(
    `${options.label}: the session runs on ${options.slug}`,
    active === options.slug,
    `llmConnection=${String(active)}`,
  )
  if (active !== options.slug) return undefined
  return { workspaceId: created.workspaceId ?? options.workspaceId, sessionId: created.id }
}

/**
 * Open a session in the UI and wait for the pane to follow.
 *
 * `createSessionOn` uses the RPC door, which does NOT move the renderer, and the
 * composer belongs to whichever session the PANE shows — `state.ts`
 * `freshSession` records what that costs: a case that types at the wrong moment
 * sends its prompt into another conversation and then waits out its own timeout
 * on an empty session.
 */
export async function openSessionInUi(session: CdpSession, key: SessionKey, timeoutMs = 30_000): Promise<boolean> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', {
      detail: { route: 'session/' + ${JSON.stringify(key.sessionId)} },
      bubbles: true,
    }))
    return null
  `).catch(() => undefined)
  const selected = await waitFor(
    () => session.call<string | null>(`
      const rows = document.querySelectorAll('.session-item[data-selected]')
      return rows.length === 1 ? rows[0].getAttribute('data-session-id') : null
    `),
    value => value === key.sessionId,
    { timeoutMs, intervalMs: 500, label: `session ${key.sessionId} to become the selected row` },
  ).catch(() => null)
  if (selected !== key.sessionId) return false
  // A session created seconds ago has no draft, so a composer still holding text
  // is the stale pane — a functional check on the surface about to be driven.
  return waitFor(
    () => session.call<string>(`
      const el = document.querySelector('div[data-tutorial="chat-input"][role="textbox"][aria-multiline="true"]')
      return el ? (el.innerText ?? el.textContent ?? '') : ''
    `),
    text => text.trim().length === 0,
    { timeoutMs: 10_000, intervalMs: 500, label: 'the pane to switch to the empty composer' },
  ).then(() => true).catch(() => false)
}

// ---------------------------------------------------------------------------
// The chat pane — where a TRANSIENT info or status can be read (fact 2)
// ---------------------------------------------------------------------------

/** `ChatDisplay.tsx` puts this on its own root; one per content panel. */
export const CHAT_ZONE_SELECTOR = '[data-focus-zone="chat"]'

/**
 * The rendered chat, as text.
 *
 * Refuses on a multi-panel layout for the same reason `focusComposer` does:
 * several panes put several transcripts on screen and a case must not guess
 * which one it meant.
 *
 * `innerText` first, `textContent` when it comes back blank — `state.ts`
 * `selectorText` records why that order and not the other: `innerText` is
 * layout-dependent and returns `''` (a real answer to the wrong question) for an
 * element inside a container that has not sized yet.
 */
export async function chatPaneText(session: CdpSession): Promise<string> {
  return session.call<string>(`
    const zones = document.querySelectorAll(${JSON.stringify(CHAT_ZONE_SELECTOR)})
    if (zones.length === 0) throw new Error('no-chat-pane: nothing matched ${CHAT_ZONE_SELECTOR}')
    if (zones.length > 1) throw new Error('ambiguous-chat-pane: ' + zones.length + ' chat panes on screen (multi-panel layout) — run the wave with a single content panel open')
    const el = zones[0]
    const rendered = el.innerText ?? ''
    return rendered.trim() ? rendered : (el.textContent ?? '')
  `)
}

/**
 * Poll the chat pane until it carries something, and say what it held when it
 * did not.
 *
 * Polling, not sampling: the README's "wait for the surface, do not sample it"
 * lesson cost three checks in the AGT wave, and a transient info row is the
 * strongest form of that hazard — it is appended by an event, not by a render
 * the harness can await.
 */
export async function waitForChatText(
  session: CdpSession,
  predicate: (text: string) => boolean,
  options: { label: string; timeoutMs?: number; intervalMs?: number },
): Promise<{ found: boolean; text: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000)
  let last = ''
  for (;;) {
    last = await chatPaneText(session).catch(() => last)
    if (predicate(last)) return { found: true, text: last }
    if (Date.now() >= deadline) return { found: false, text: last }
    await Bun.sleep(options.intervalMs ?? 1_000)
  }
}

/**
 * What the pane gained — the text after the two snapshots stop agreeing.
 *
 * The pane accumulates, so `after.includes('Quota:')` is also true for a
 * `/quota` run five minutes ago in the same session. Comparing against the
 * BEFORE snapshot is what makes a render THIS run's render, and it is the same
 * discipline `waitForTurn` applies to the transcript with `sinceCount`.
 */
export function paneDelta(before: string, after: string): string {
  if (!before) return after
  if (after.startsWith(before)) return after.slice(before.length)
  // The pane can also lose rows (a transient status is dropped, a virtualised
  // row scrolls out). Fall back to the longest common prefix rather than
  // pretending the whole pane is new.
  let i = 0
  while (i < before.length && i < after.length && before[i] === after[i]) i += 1
  return after.slice(i)
}

export type QuotaVerdict =
  | 'limits-rendered'
  | 'no-limits'
  | 'unavailable'
  | 'cancelled'
  | 'not-on-runtime'
  | 'nothing'

export interface QuotaRender {
  verdict: QuotaVerdict
  /** Only the text this run added to the pane. */
  delta: string
  /** The `- …` lines under the `Quota:` head. */
  limitLines: string[]
}

/**
 * Classify what `/quota` put on screen.
 *
 * The classification is the point. `describeNestorQuota` answers EVERY outcome
 * with an `info` — a rendered budget, an empty limiter, an HTTP 500, a cancelled
 * read — so "an info message appeared" is true in all of them, and a detector
 * built on it passes on a broken gateway. Only `limits-rendered` is the row's
 * claim; the other five are named so a failure says which one happened.
 */
export function classifyQuotaRender(delta: string): QuotaRender {
  const limitLines = quotaLimitLines(delta)
  if (delta.includes(QUOTA_STRINGS.head) && limitLines.length > 0) {
    return { verdict: 'limits-rendered', delta, limitLines }
  }
  if (delta.includes(QUOTA_STRINGS.noLimits)) return { verdict: 'no-limits', delta, limitLines }
  if (delta.includes(QUOTA_STRINGS.unavailablePrefix)) return { verdict: 'unavailable', delta, limitLines }
  if (delta.includes(QUOTA_STRINGS.cancelled)) return { verdict: 'cancelled', delta, limitLines }
  if (delta.includes(QUOTA_STRINGS.notOnRuntime)) return { verdict: 'not-on-runtime', delta, limitLines }
  return { verdict: 'nothing', delta, limitLines }
}

/**
 * A limit line with its one volatile figure taken out —
 * `Daily [user] (allowed): 73% remaining` becomes `Daily [user] (allowed): N% remaining`.
 *
 * The title, the scope, the backend's `state` verdict, any `status.message` and
 * the `(resets …)` stamp stay: those are what makes two renders the SAME budget.
 * The percentage is the one part that honestly moves between two reads a few
 * seconds apart, because the budget is per USER and anything else signed in as
 * that user can spend between them.
 */
export function quotaLimitShape(line: string): string {
  return boundedQuotaLimit(line).replace(/\b\d{1,3}% remaining\b/g, 'N% remaining')
}

/**
 * A limit line cut after its `(resets …)` stamp, which `formatNestorQuotaLimit`
 * always writes LAST — so in the collapsed-whitespace spelling, where
 * {@link quotaLimitLines} has no newline to cut at, whatever follows the stamp is
 * the pane and not the limit. A line with no stamp is returned whole: the
 * backend omits `reset_at` only when its storage is not behind the interface,
 * and then a collapsed render's last line can still carry the footer — stated
 * rather than guessed at, since no delimiter is left to find.
 */
export function boundedQuotaLimit(line: string): string {
  const stamp = /\(resets [^)]*\)/.exec(line)
  return stamp ? line.slice(0, stamp.index + stamp[0].length) : line
}

export interface SameBudgetVerdict {
  /** Both renders are a budget, and it is the same budget (every limit's shape equal). */
  same: boolean
  /** ...and the percentages agree too. Only meaningful when `same`. */
  exact: boolean
  detail: string
}

/**
 * F1.203 — is `subject` the SAME Nessy Gateway budget `control` rendered?
 *
 * F1.6 (`f6987934f`) has the claude and codex gateway cards read the budget
 * through the host-side read the Pi gateway card uses, so the claim is equality,
 * not "something quota-shaped appeared". Two rules keep that from being vacuous:
 *
 * - **Two non-budgets are never "the same".** Two `unavailable` renders (an
 *   expired sign-in on all three cards) or two `not-on-runtime` refusals agree
 *   with each other and prove nothing about a budget, so only `limits-rendered`
 *   and `no-limits` can compare equal.
 * - **The percentage is compared separately** ({@link quotaLimitShape}): `same`
 *   ignores it and `exact` does not, so a case can assert the first and record
 *   the second instead of failing on spend it did not cause.
 */
export function compareQuotaBudgets(control: QuotaRender, subject: QuotaRender): SameBudgetVerdict {
  const budget = (render: QuotaRender): boolean => render.verdict === 'limits-rendered' || render.verdict === 'no-limits'
  if (!budget(control)) {
    return { same: false, exact: false, detail: `the control is not a budget (verdict=${control.verdict}), so nothing can equal it` }
  }
  if (control.verdict !== subject.verdict) {
    return { same: false, exact: false, detail: `verdict ${subject.verdict}, the control's is ${control.verdict}` }
  }
  const shapes = (render: QuotaRender): string[] => render.limitLines.map(quotaLimitShape)
  const bounded = (render: QuotaRender): string[] => render.limitLines.map(boundedQuotaLimit)
  const same = JSON.stringify(shapes(control)) === JSON.stringify(shapes(subject))
  const exact = same && JSON.stringify(bounded(control)) === JSON.stringify(bounded(subject))
  return {
    same,
    exact,
    detail: same
      ? (exact ? 'the same limits, the same figures' : 'the same limits; the figures moved between the two reads')
      : `limits ${JSON.stringify(subject.limitLines)}, the control's are ${JSON.stringify(control.limitLines)}`,
  }
}

// ---------------------------------------------------------------------------
// Composer capabilities — the state the chips are rendered from
// ---------------------------------------------------------------------------

export interface CloudModeOption {
  mode: string
  label?: string
  shortLabel?: string
  description?: string
  iconMode?: string
  remoteModeId?: string
}

export interface ComposerCaps {
  activeRuntime?: string
  modes: string[]
  modeOptions: CloudModeOption[]
  excludedCommandIds: string[]
  commandIds: unknown
}

/**
 * `session.composerCapabilities`, the DTO field `resolveComposerCapabilities`
 * lands on (`protocol/dto.ts:258`). The same door `cru-4.ts` and `rts-7.ts` use.
 */
export async function composerCapabilities(session: CdpSession, sessionId: string): Promise<ComposerCaps> {
  return session.call<ComposerCaps>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
    const caps = s && s.composerCapabilities ? s.composerCapabilities : null
    const permissions = caps && caps.permissions ? caps.permissions : {}
    const slash = caps && caps.slash ? caps.slash : {}
    return {
      activeRuntime: caps && caps.connection ? caps.connection.activeRuntime : undefined,
      modes: Array.isArray(permissions.modes) ? permissions.modes : [],
      modeOptions: Array.isArray(permissions.modeOptions) ? permissions.modeOptions : [],
      excludedCommandIds: Array.isArray(slash.excludedCommandIds) ? slash.excludedCommandIds : [],
      commandIds: slash.commandIds,
    }
  `)
}

// ---------------------------------------------------------------------------
// The transcript, with the two fields `state.ts` does not carry
// ---------------------------------------------------------------------------

export interface CloudMessage {
  id: string
  role: string
  content: string
  /** The reasoning marker — `text_complete` with `isIntermediate` (fact: the
   * `data_type: 'reasoning'` branch is the only producer on this backend). */
  isIntermediate?: boolean
  infoLevel?: string
  statusType?: string
  toolName?: string
  toolUseId?: string
  toolResult?: string
  toolStatus?: string
  timestamp: number
}

/**
 * `getSessionMessages`, carrying `isIntermediate`, `infoLevel` and `statusType`.
 *
 * `state.ts` `transcript()` drops all three, and NCA-8's whole claim is one of
 * them. Read here rather than widened there: `state.ts` is shared with every
 * other wave and this block is not the place to move it.
 */
export async function cloudTranscript(session: CdpSession, key: SessionKey): Promise<CloudMessage[]> {
  return session.call<CloudMessage[]>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    if (!s) throw new Error('session-not-found: ' + ${JSON.stringify(key.sessionId)})
    return (s.messages ?? []).map(m => ({
      id: m.id,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      isIntermediate: m.isIntermediate === true,
      infoLevel: m.infoLevel,
      statusType: m.statusType,
      toolName: m.toolName,
      toolUseId: m.toolUseId,
      toolResult: typeof m.toolResult === 'string' ? m.toolResult : undefined,
      toolStatus: m.toolStatus,
      timestamp: m.timestamp,
    }))
  `)
}

// ---------------------------------------------------------------------------
// The filesystem: the session dir and the remote-agent sidecar
// ---------------------------------------------------------------------------

/**
 * The config dir the APP was launched with.
 *
 * Defaults to `~/.nessy-agent` — the operator's own — because every case in this
 * block runs against a live gateway on the operator's profile. It deliberately
 * does NOT default to any fixture tree: a wrong config dir makes every
 * filesystem detector here answer "absent" and turns NCA-5's central assertion
 * into a constant.
 */
export function cloudConfigDir(): string {
  return process.env.NESSY_CONFIG_DIR?.trim() || join(homedir(), '.nessy-agent')
}

/** `getSessionStoragePath(workspaceId, sessionId)`, restated (`workspaces/paths.ts:58`). */
export function sessionStorageDir(key: SessionKey): string {
  return join(cloudConfigDir(), 'sessions', key.workspaceId, key.sessionId)
}

/** `NestorCloudContextStore` — `<sessionPath>/meta/nestor-cloud-context.json` (`context-store.ts:52`). */
export function sidecarPath(key: SessionKey): string {
  return join(sessionStorageDir(key), 'meta', 'nestor-cloud-context.json')
}

/**
 * Proof the config dir is the one this session lives in.
 *
 * Loud, because the alternative is silent: an absent session directory makes
 * `sidecarPath` point into nothing, and "the sidecar is gone" then reads as a
 * pass for a case that measured a directory the app never wrote to.
 */
export function requireSessionDir(key: SessionKey): string {
  const dir = sessionStorageDir(key)
  if (!existsSync(dir)) {
    blocked(
      `config-dir-mismatch: no session directory at ${dir}. Every filesystem detector in this wave is scoped by `
      + 'NESSY_CONFIG_DIR, and a wrong one reports absence for everything — including the sidecar NCA-5 asserts is '
      + `gone. Export NESSY_CONFIG_DIR to the dir the app was launched with (currently ${cloudConfigDir()}).`,
    )
  }
  return dir
}

export interface SidecarRead {
  present: boolean
  path: string
  contextId?: string
  activeTaskId?: string
  activeTaskStatus?: string
  lastRemoteStatus?: string
  pendingTerminalTool?: { toolCallId?: string; name?: string }
  raw?: Record<string, unknown>
  parseError?: string
}

/** Read the remote-agent sidecar, reporting absence as absence rather than as `{}`. */
export function readSidecar(key: SessionKey): SidecarRead {
  const path = sidecarPath(key)
  if (!existsSync(path)) return { present: false, path }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return {
      present: true,
      path,
      contextId: typeof raw.contextId === 'string' ? raw.contextId : undefined,
      activeTaskId: typeof raw.activeTaskId === 'string' ? raw.activeTaskId : undefined,
      activeTaskStatus: typeof raw.activeTaskStatus === 'string' ? raw.activeTaskStatus : undefined,
      lastRemoteStatus: typeof raw.lastRemoteStatus === 'string' ? raw.lastRemoteStatus : undefined,
      pendingTerminalTool: raw.pendingTerminalTool as SidecarRead['pendingTerminalTool'],
      raw,
    }
  } catch (cause) {
    return { present: true, path, parseError: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Poll for a sidecar condition — it is written after the stream settles, not with it. */
export async function waitForSidecar(
  key: SessionKey,
  predicate: (read: SidecarRead) => boolean,
  timeoutMs = 30_000,
): Promise<SidecarRead> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const read = readSidecar(key)
    if (predicate(read)) return read
    if (Date.now() >= deadline) return read
    await Bun.sleep(1_000)
  }
}

// ---------------------------------------------------------------------------
// The app log — the only surface that carries the codec's own account
// ---------------------------------------------------------------------------

export interface AppLogWindow {
  path: string
  offset: number
}

/**
 * Open the app log and remember where this run starts reading.
 *
 * **A packaged build writes no application log at all** (`main/logger.ts` turns
 * both electron-log transports off whenever `isDebugMode` is false, which on a
 * packaged Electron build it always is) — so this blocks rather than handing a
 * case an empty file that reads as "no warnings". `cdx-roles.ts` states the same
 * precondition in the same words.
 */
export function openAppLog(purpose: string): AppLogWindow {
  const path = process.env.NESSY_CDP_APP_LOG ?? '/tmp/app.log'
  if (!existsSync(path)) {
    blocked(
      `no app log at ${path}, and ${purpose} is read out of the log rather than out of the reply. `
      + 'Launch with `nohup bun run electron:dev > /tmp/app.log 2>&1 & disown`, or set NESSY_CDP_APP_LOG to a file '
      + 'the app is writing. A PACKAGED build writes no application log outside debug mode '
      + '(`apps/electron/src/main/logger.ts`), so this case cannot be run against one.',
    )
  }
  return { path, offset: statSync(path).size }
}

/** Everything the app logged since the window opened. */
export function appLogSince(window: AppLogWindow): string {
  if (!existsSync(window.path)) return ''
  const size = statSync(window.path).size
  // A rotation or a relaunch truncates the file; reading from a stale offset
  // would return '' and score as "no warnings". Start over instead and say so
  // by returning the whole file — a case that then sees warnings from before its
  // own window fails loudly rather than passing quietly.
  const from = size < window.offset ? 0 : window.offset
  const handle = readFileSync(window.path)
  return handle.subarray(from).toString('utf8')
}

/** Count of each needle in a log window, in one pass. */
export function countIn(haystack: string, needles: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const needle of needles) {
    let count = 0
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      count += 1
      index = haystack.indexOf(needle, index + needle.length)
    }
    counts[needle] = count
  }
  return counts
}

/** The lines around a needle, for a failure message that can be acted on. */
export function linesContaining(haystack: string, needle: string, limit = 5): string[] {
  return haystack.split('\n').filter(line => line.includes(needle)).slice(0, limit)
}

// ---------------------------------------------------------------------------
// Probe tokens
// ---------------------------------------------------------------------------

/**
 * A per-run secret with no fixed prefix.
 *
 * `lib/codeword.ts` records why the prefix is absent: `ZARYA` appeared in this
 * repo's own checklist, so an agent with a shell could grep its way to a
 * plausible answer without having been told anything.
 */
export function probeToken(): string {
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** The session's own working directory, as the app reports it. */
export async function workingDirectoryOf(session: CdpSession, sessionId: string): Promise<string | undefined> {
  const sessions = await listSessions(session)
  return sessions.find(s => s.id === sessionId)?.workingDirectory
}
