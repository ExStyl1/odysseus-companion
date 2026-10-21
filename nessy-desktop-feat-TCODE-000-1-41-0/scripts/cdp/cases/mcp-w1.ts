/**
 * MCP-W1 — the names a user sees, in the running app.
 *
 * The 2026-08-10 field incident in one picture: a marketplace plugin bundling
 * an MCP server named like an enabled built-in used to strip the bare name from
 * BOTH and then throw on every chat turn. This case drives the shipped app and
 * asks what a user actually sees now.
 *
 * Four claims, and each is read off a different surface so a single wrong
 * detector cannot carry the case:
 *
 *   1. the built-in `t-tracker` is ACTIVE and still carries its bare name;
 *   2. the plugin's same-named copy is DISABLED with `duplicates-builtin`, and
 *      the DETAIL page — not the row — renders a reason a human can read;
 *   3. the plugin's own components that referenced the stood-down server are
 *      named in the reason (`safeArgs.inertComponents`, G1/F2);
 *   4. the two awkward native names (`my server.v2`, `мой сервер`) resolve and
 *      CONNECT rather than being dropped (F3's sanitize + `server-<hash>`
 *      fallback; the minted names themselves are MCP-W2's business, because the
 *      renderer never displays a wire name — see the G5 deviation log).
 *
 * **What this case deliberately does NOT do:** derive its expectations from
 * `pluginMcpWireName`/`sanitizeMcpNameSegment`. Those literals live in
 * `fixtures/mcp-naming.ts`'s `EXPECTED`, written out by hand from `mcp.md:357`
 * and `:365`. A case that imports the mint it is testing passes whatever the
 * mint does, including a regression.
 */

import type { CdpSession } from '../lib/connect.ts'
import { EXPECTED, FIXTURE } from '../fixtures/mcp-naming.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  capabilityDiagnostics,
  catalogRows,
  ensureDarkTheme,
  fixtureWorkspaceId,
  mcpTools,
  requireTokens,
  type CatalogRow,
} from '../lib/mcp-fixture.ts'
import { activeSession, assertElectronApi, listSessions, selectorText, visibleElements, type SessionSummary } from '../lib/state.ts'

const ID = 'MCP-W1'
const TITLE = 'Built-in keeps its bare MCP name; the plugin copy stands down with a readable reason; awkward native names still connect'

const DEDUP_DIAGNOSTIC = 'capability.dedup.builtin-identity'

/**
 * The detail page's rendered strings, from `en.json`/`ru.json` verbatim, so the
 * checks are on the SENTENCE a user reads, not on a class name or a code. Both
 * locales, because the app's language is the operator's, not the case's.
 */
export const DETAIL_PAGE_TEXT = {
  /** `sourceInfo.unavailable.duplicatesBuiltin` — the claim. */
  reason: ['Duplicates a built-in server; the built-in is used', 'Дублирует встроенный сервер; используется встроенный'],
  /** `sourceInfo.failedToLoad` — `SourceInfoPage` when `getDetail` throws for the key it was handed. */
  failed: ['Failed to load source', 'Не удалось загрузить источник'],
  /** `capabilityDetail.metadata` — a section every LOADED detail page renders. */
  metadata: ['Metadata', 'Метаданные'],
} as const

/** What one detail page showed, read for ONE key — never for whichever page happens to be up. */
export type DetailPageReading = 'reason' | 'loaded-no-reason' | 'failed' | 'unsettled'

/**
 * Read a detail page's text for the capability it was navigated to.
 *
 * Both non-reason verdicts are bound to the key, because the pane keeps the
 * PREVIOUS page's text for a moment after a navigation: a failed page's header
 * is the raw key it could not load (`SourceInfoPage`: `displayName = summary ?
 * … : capabilityKey`), and a loaded plugin page's metadata names its own
 * `capabilityId` (`mcp.t-tracker`), which the built-in's page never does.
 */
export function readDetailPage(text: string, key: string, marker: string): DetailPageReading {
  if (DETAIL_PAGE_TEXT.reason.some(sentence => text.includes(sentence))) return 'reason'
  if (DETAIL_PAGE_TEXT.failed.some(sentence => text.includes(sentence)) && text.includes(key)) return 'failed'
  if (text.includes(marker) && DETAIL_PAGE_TEXT.metadata.some(title => text.includes(title))) return 'loaded-no-reason'
  return 'unsettled'
}

/** `plugin://…#<bundleHash>#<capabilityId>@<scope>` → `<capabilityId>`. */
export function capabilityIdOf(key: string): string {
  return key.slice(key.lastIndexOf('#') + 1, key.lastIndexOf('@'))
}

/**
 * The capability contexts the detail page might resolve a key in, most likely
 * first: the selected session's, then the workspace alone (what the page uses
 * with NO session selected — a fresh profile's case), then one session per
 * other distinct working directory, because a plugin key's scope is its
 * PROJECT and sessions sharing a directory share a key. `undefined` is the
 * workspace-only context. Bounded, so a real profile with hundreds of sessions
 * costs a handful of catalog reads, not hundreds.
 *
 * It reads EXISTING sessions and creates none: the first draft of this arm
 * created one with `freshSession()` to make the page's context known, and the
 * live drive on a fresh card-less fixture profile answered `no-sessions` — the
 * onboarding screen creates no session — so MCP-W1 would have gained a card as
 * a precondition it never had (F1.149, measured 2026-09-23).
 */
export function detailContextOrder(
  sessions: Pick<SessionSummary, 'id' | 'workingDirectory'>[],
  selectedId: string | undefined,
  cap = 8,
): Array<string | undefined> {
  const selected = sessions.find(s => s.id === selectedId)
  const order: Array<string | undefined> = selected ? [selected.id, undefined] : [undefined]
  const seen = new Set(selected ? [selected.workingDirectory ?? ''] : [])
  for (const s of sessions) {
    if (order.length >= cap) break
    const cwd = s.workingDirectory ?? ''
    if (seen.has(cwd)) continue
    seen.add(cwd)
    order.push(s.id)
  }
  return order
}

/** Navigate the way `handleSourceSelect` does — `sources/mcp/source/<encodeURIComponent(key)>`. */
async function openDetail(session: CdpSession, key: string): Promise<void> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', {
      detail: { route: 'sources/mcp/source/' + encodeURIComponent(${JSON.stringify(key)}) },
      bubbles: true,
    }))
    return null
  `)
}

/**
 * The onboarding's own button words, from `en.json`/`ru.json` verbatim:
 * `onboarding.welcome.getStarted` (the LAST button, matched EXACTLY — `Начать`
 * is too short to match as a substring) and `onboarding.providerSelect.nessyPiDesc`
 * (the one-click card's description, which no shell button carries — the
 * card's TITLE can also be a connection's name, so it is not used).
 */
export const ONBOARDING_TEXT = {
  getStarted: ['Get Started', 'Начать'],
  oneClickPi: ['Universal agent on the gateway. One-click sign-in.', 'Универсальный агент на gateway. Вход в один клик.'],
} as const

/**
 * Whether the app is still on its onboarding screen. While it is, the shell
 * does not exist and no route renders — measured 2026-09-23 on a fresh fixture
 * profile: every DOM arm read `Welcome to Nessy Desktop`, the built-in control
 * included, and the case scored three FAILs about a screen the product had
 * not reached.
 */
async function onboardingOnScreen(session: CdpSession): Promise<boolean> {
  return session.call<boolean>(`
    const done = ${JSON.stringify(ONBOARDING_TEXT.getStarted)}
    const card = ${JSON.stringify(ONBOARDING_TEXT.oneClickPi)}
    return Array.from(document.querySelectorAll('button')).some(el => {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return false
      const text = (el.innerText || '').replace(/\\s+/g, ' ').trim()
      return done.includes(text) || card.some(desc => text.includes(desc))
    })
  `)
}

async function pageText(session: CdpSession): Promise<string> {
  return (await selectorText(session, 'main, [role="main"], body').catch(() => [] as string[])).join(' ')
}

function findRow(rows: CatalogRow[], predicate: (row: CatalogRow) => boolean, what: string): CatalogRow {
  const found = rows.filter(predicate)
  if (found.length !== 1) {
    blocked(`fixture-not-installed: expected exactly one ${what} in the catalog, found ${found.length}. `
      + 'Build the fixture tree and install the probe plugins first (see the MCP-W row in docs/testing/cdp-live-checklist.md).')
  }
  return found[0]!
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  requireTokens()
  run.observe('theme', await ensureDarkTheme(session))

  const workspaceId = await fixtureWorkspaceId(session)
  const rows = await catalogRows(session, workspaceId)
  run.observe('catalog-mcp-rows', rows.filter(r => r.kind === 'mcp').length)

  // ---- 1. the built-in keeps the bare name --------------------------------
  const builtin = findRow(
    rows,
    r => r.kind === 'mcp' && r.origin === 'builtin' && r.logicalName === FIXTURE.builtinName,
    `built-in MCP row named ${FIXTURE.builtinName}`,
  )
  run.observe('builtin', { key: builtin.key, name: builtin.logicalName, state: builtin.state })
  run.check(
    `the built-in is ACTIVE under its bare name "${EXPECTED.builtinTracker}"`,
    builtin.state === 'active' && builtin.logicalName === EXPECTED.builtinTracker,
    `state=${builtin.state} name=${builtin.logicalName}`,
  )

  // ---- 2. the plugin copy stands down, with a reason -----------------------
  const pluginCopy = findRow(
    rows,
    r => r.kind === 'mcp' && r.origin === 'plugin' && r.logicalName === FIXTURE.trackerServerName,
    `plugin MCP row named ${FIXTURE.trackerServerName}`,
  )
  run.observe('plugin-copy', {
    key: pluginCopy.key.slice(0, 140),
    state: pluginCopy.state,
    reason: pluginCopy.unavailableReason,
  })
  run.check(
    'the plugin copy is DISABLED, not competing for the name',
    pluginCopy.state === 'disabled',
    `state=${pluginCopy.state}`,
  )
  run.check(
    'the reason is duplicates-builtin',
    pluginCopy.unavailableReason === 'duplicates-builtin',
    `unavailableReason=${String(pluginCopy.unavailableReason)}`,
  )

  const diagnostics = await capabilityDiagnostics(session, workspaceId, pluginCopy.key)
  const dedup = diagnostics.find(d => d.code === DEDUP_DIAGNOSTIC)
  run.observe('dedup-diagnostic', dedup ?? diagnostics)
  run.check(`the detail carries ${DEDUP_DIAGNOSTIC}`, Boolean(dedup))

  // ---- 3. what went inert WITH it (G1/F2) ---------------------------------
  // The fixture plugin ships one skill whose `allowed-tools` names the
  // stood-down server by bare name, which is precisely the input
  // `inertPluginComponentNames` scans for.
  const inert = dedup?.safeArgs?.inertComponents
  run.observe('inert-components', inert ?? '(absent)')
  run.check(
    'the reason names the plugin components that went inert with the server',
    typeof inert === 'string' && inert.includes('skill:'),
    inert
      ? `safeArgs.inertComponents=${inert}`
      : 'safeArgs.inertComponents is ABSENT although the fixture plugin ships a skill whose allowed-tools names this server',
  )

  // ---- the DETAIL page, in the DOM ----------------------------------------
  // The row itself renders no reason (by design — G5's deviation log); the
  // detail page's Metadata section header carries it. Reading the rendered
  // string is the difference between "the server composed a reason" and "a
  // user can read one".
  //
  // F1.149 (SIT-11 `P-SIT11CG-1`): the page resolves the key it is handed in
  // ITS OWN capability context — `capabilityContext(activeWorkspaceId,
  // session.selected)` in AppShell — and a PLUGIN capability's key carries the
  // scope it was resolved in (`scopeToken`, `plugins/projection-candidates.ts`:
  // `…#<capabilityId>@<kind>:<workspace>:<projectKey>`). This arm used to hand
  // it the key read under `{ workspaceId }` alone. Whenever the selected session
  // had a project, the two differed, `getDetail` threw and the page said "Failed
  // to load source" under the raw key — claude-gateway's reading, whose page
  // reached by a CLICK said `Scope project` — and whenever it had none they
  // matched — the pi driver's PASS on the same artefact. Built-in and native
  // keys carry no scope, which is why they always resolved. So the arm reads
  // the plugin copy's key in every context the page might be in
  // ({@link detailContextOrder}: the selected session's first, then the
  // workspace alone) and opens each until one LOADS, recording which it was.
  // By KEY, never by the row's name: the built-in and the plugin copy are both
  // `t-tracker`, and `mcp-server-row-t-tracker` is two rows.
  if (await onboardingOnScreen(session)) {
    blocked('the app is on its ONBOARDING screen, so no route renders and the DOM arms cannot be read. Complete it '
      + 'once — RS-32 does, with the product\'s own one-click "Nessy · Pi agent" card and "Get Started" — then re-run '
      + '(the MCP-W row of scripts/cdp/README.md). The catalog checks above stand.')
  }
  const sessions = (await listSessions(session)).filter(s => s.workspaceId === workspaceId)
  const selected = sessions.length > 0 ? await activeSession(session).catch(() => undefined) : undefined
  const contexts = detailContextOrder(sessions, selected?.sessionId)
  run.observe('detail-page-contexts', { sessions: sessions.length, selected: selected?.sessionId, via: selected?.via, tried: contexts.length })
  const candidates: string[] = []
  for (const sessionId of contexts) {
    const copy = sessionId === undefined
      ? pluginCopy
      : (await catalogRows(session, workspaceId, sessionId).catch(() => [] as CatalogRow[]))
        .find(r => r.kind === 'mcp' && r.origin === 'plugin' && r.logicalName === FIXTURE.trackerServerName)
    if (copy && !candidates.includes(copy.key)) candidates.push(copy.key)
  }
  run.observe('detail-page-candidate-scopes', candidates.map(k => k.slice(k.lastIndexOf('@') + 1)))

  // THE CONTROL the row names: the built-in's page resolves on the same route in
  // the same run, so a plugin-page failure below is about the plugin key and
  // never about the route mechanism. Opened FIRST, while no detail page is up.
  await openDetail(session, builtin.key)
  let builtinReading: 'loaded' | 'failed' | 'unsettled' = 'unsettled'
  for (let attempt = 0; attempt < 30 && builtinReading === 'unsettled'; attempt += 1) {
    await Bun.sleep(500)
    const text = await pageText(session)
    if (DETAIL_PAGE_TEXT.failed.some(s => text.includes(s)) && text.includes(builtin.key)) builtinReading = 'failed'
    else if (DETAIL_PAGE_TEXT.metadata.some(s => text.includes(s))) builtinReading = 'loaded'
  }
  run.check('the built-in\'s detail page resolves on the same route (the route control)', builtinReading === 'loaded',
    `builtin ${builtin.key}: ${builtinReading}`)

  const marker = capabilityIdOf(pluginCopy.key)
  const readings: Array<{ scope: string; reading: DetailPageReading }> = []
  let shownText = ''
  for (const key of candidates) {
    await openDetail(session, key)
    let reading: DetailPageReading = 'unsettled'
    let text = ''
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await Bun.sleep(500)
      text = await pageText(session)
      reading = readDetailPage(text, key, marker)
      if (reading === 'reason' || reading === 'failed') break
    }
    readings.push({ scope: key.slice(key.lastIndexOf('@') + 1), reading })
    if (reading === 'reason') { shownText = text; break }
    if (reading === 'loaded-no-reason') break
  }
  run.observe('detail-page-readings', readings)
  const shown = DETAIL_PAGE_TEXT.reason.find(sentence => shownText.includes(sentence))
  run.observe('detail-page-reason-text', shown ?? '(not found)')
  run.check(
    'the detail page renders the duplicate reason a user can read',
    Boolean(shown),
    shown ?? `no candidate key rendered the reason: ${JSON.stringify(readings)}`
      + (readings.at(-1)?.reading === 'loaded-no-reason'
        ? ' — the plugin copy\'s page LOADED without it, which is the product not rendering sourceInfo.unavailable.duplicatesBuiltin'
        : ''),
  )
  run.observe('detail-page-headings', (await visibleElements(session, 'h1, h2, h3')).map(e => e.text).slice(0, 12))

  // ---- 4. the two awkward native names -------------------------------------
  // F3's whole point: before the sanitize+fallback these two minted an
  // unparseable and an EMPTY wire name respectively, and the pool drops an
  // empty one outright. A live `tools/list` is the strongest available proof
  // short of a model turn (MCP-W2) that the server is not merely listed.
  for (const [label, logicalName] of [
    ['sanitized', FIXTURE.scopedSanitizedName],
    ['cyrillic', FIXTURE.scopedCyrillicName],
  ] as const) {
    const row = rows.find(r => r.kind === 'mcp' && r.origin === 'native' && r.logicalName === logicalName)
    run.check(`the native "${logicalName}" server resolves`, Boolean(row), row ? `state=${row.state}` : 'absent from the catalog')
    if (!row) continue
    const tools = await mcpTools(session, workspaceId, row.key)
    run.observe(`native-${label}-tools`, tools)
    run.check(
      `the native "${logicalName}" server CONNECTS and lists its tool`,
      tools.status === 'ok' && (tools.tools ?? []).some(t => t.name === FIXTURE.toolName),
      tools.status === 'ok' ? undefined : `listMcpTools refused: ${String(tools.reason)}`,
    )
  }

  // The panel the user reaches this from, for completeness: the row exists.
  // Cheap, and it is the affordance the reason hangs off.
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'sources/mcp' }, bubbles: true }))
    return null
  `)
  await Bun.sleep(1_500)
  const panelRows = await visibleElements(session, '[data-testid^="mcp-server-row-"]')
  run.observe('mcp-panel-rows', panelRows.map(r => r.text.slice(0, 60)))
  run.check('the MCP servers panel lists rows', panelRows.length > 0, `${panelRows.length} visible rows`)
  // Recorded, not clicked: the row test id is the server's NAME, so the
  // built-in and its stood-down plugin copy share one — this reading is why the
  // detail arm above routes by KEY (the SIT-11 critic's point on F1.149). It
  // used to click the first match and check nothing after.
  run.observe('rows-sharing-the-built-in-name',
    (await visibleElements(session, `[data-testid="mcp-server-row-${FIXTURE.builtinName}"]`)).length)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
