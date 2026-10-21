/**
 * PLUGIN-INSTALL-RUNTIMES — installing a plugin must work on claude AND on
 * codex (owner answer QL9, 2026-09-11), driven through the PRODUCT's own
 * install path.
 *
 * ## Why this is not `agent-install.ts`
 *
 * `AGENT-INSTALL` drives the AGENT channel — `plugin_plan_install` /
 * `plugin_install`, the model's own tools — and it exists because that channel
 * diverged from the UI's twice (`d18f2b34c`, `4881e7f50`). The owner's QL9
 * answer is about the other one: what a USER gets when they install a plugin,
 * which is `marketplace.addRegistry` → `marketplace.install`, the exact calls
 * the Plugins page makes. Two channels, two cases; a green result on one says
 * nothing about the other, which is the whole reason both exist.
 *
 * ## Why the per-runtime half is a separate reading from the install
 *
 * An install is global — a plugin lands in `plugins/installed.json` once,
 * whatever session happens to be open. The question QL9 asks is the one AFTER
 * that: does the installed thing REACH a claude session and a codex session.
 * Those two consume an MCP pool differently and therefore see different
 * names for the same tool. The HOST records `mcp__<wire>__<tool>` on claude and
 * `mcp__sources__<wire>__<tool>` on codex, because codex consumes the whole pool
 * through one `[mcp_servers.sources]` bridge (`fixtures/mcp-naming.ts`
 * `proxyToolName`). The codex MODEL is handed neither: it sees `<wire>__<tool>`
 * with every character outside `[A-Za-z0-9_]` as `_` — the product's own
 * `codexModelToolName`, which `modelToolName` calls (F1.277, F1.392; the hyphen
 * case measured by SIT-11 and F1.153). So the install is scored ONCE and the reach PER RUNTIME,
 * and each reach uses two names: the prompt asks for the name that runtime's
 * model can see, and the dispatch is checked against the name the host records.
 *
 * ## The reach detector reads the tool ROW, never the transcript as text (F1.154)
 *
 * It used to stringify every message and look for the wire name, and for any
 * `whoami` or `CDP-WHOAMI`. Both were satisfied by the case's OWN prompt — the
 * user row spells the name, whose suffix is `whoami` — so they could not fail:
 * SIT-11's one refuted PASS. The detector is now {@link readReach}: a tool row
 * whose `toolName` IS the host row name, and the per-call nonce the probe
 * server mints into that row's RESULT (`fixtures/echo-server.mjs`), present in
 * no file and in no prompt. With the fixture server stopped there is no nonce,
 * and the check goes red.
 *
 * ## What it refuses to do
 *
 *  - **Leave anything behind.** It runs on the operator's real profile, because
 *    `freshSession()` lands in the ACTIVE workspace regardless of any fixture
 *    config dir (`agent-install.ts` measured that). So it records the
 *    pre-state first, REFUSES to start if its own artifacts are already there,
 *    uninstalls and removes the registry in a `finally`, and asserts the
 *    profile is back to its pre-state.
 *  - **Score a model's refusal as a product failure.** The reach half asks a
 *    model to call one tool, and a miss is CLASSIFIED before it is scored
 *    ({@link classifyReachMiss}, built on `agent-install.ts`'s
 *    `classifyInstallMiss` — F1.262). A model that declines, a load parked on a
 *    card nobody answered, a tool the model says is callable only from the NEXT
 *    message on a Pi bundle older than F1.803 or unread, and a turn that errored
 *    before any reply (an upstream that would not answer) are BLOCKED with their
 *    reason, the other runtime's reach still driven. A miss that measures the
 *    PRODUCT stays FAIL: the tool reported absent from the model's toolset, the
 *    echo tool dispatched under any name but the host row name, that NEXT-message
 *    miss on a bundle that carries F1.803 (the classifier's own verdict,
 *    F1.1020), and a session that never binds to the card.
 *  - **Install anything but the fixture plugin from the fixture registry.**
 *
 * ## Running it
 *
 * ```sh
 * bun run scripts/cdp/cases/plugin-install-runtimes.ts
 * ```
 *
 * `NESSY_CDP_CLAUDE_CARD` / `NESSY_CDP_CODEX_CARD` name the cards by slug;
 * absent, the first card of each family the app lists is used. It is not in
 * `run.ts`'s wave: it mutates a real profile and wants to be asked for.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { classifyInstallMiss, type InstallMissKind } from './agent-install.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import { assertElectronApi, freshSession, setPermissionMode, transcript, waitFor, type TranscriptMessage } from '../lib/state.ts'
import { buildFixtures, FIXTURE, modelToolName, proxyToolName } from '../fixtures/mcp-naming.ts'

const ID = 'PLUGIN-INSTALL-RUNTIMES'
const TITLE = 'a plugin installed through the product\'s own path reaches a claude session and a codex session'

export const meta = {
  id: ID,
  title: TITLE,
  /**
   * The owner ANSWER this case exists for, not a plan row — QL9 (2026-09-11).
   * `harness.test.ts` pins `meta.row` against the plan for `rs-*.ts` only, and
   * this file is deliberately not one of those: it is not a `measure:` row of
   * the sitting, it is the owner's standing requirement that a plugin install
   * work on both runtimes.
   */
  row: 'QL9',
  runtimes: ['claude', 'codex'],
  credentials: 'owner: one claude-runtime card and one codex-runtime card, already signed in. '
    + 'No key is read, printed or written. The plugin and the registry are fixtures and both are removed.',
} as const satisfies CaseMeta

interface InstalledRow {
  pluginId?: string
  pluginKey?: string
  manifest?: { capabilities?: Array<{ kind?: string; mcp?: { serverName?: string } }> }
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T } catch { return fallback }
}

function installedRows(): InstalledRow[] {
  return readJson<{ plugins?: InstalledRow[] }>(join(configDir(), 'plugins', 'installed.json'), {}).plugins ?? []
}

function installedPluginIds(): string[] {
  return installedRows().map(r => r?.pluginId).filter((x): x is string => typeof x === 'string').sort()
}

function registryIds(): string[] {
  return (readJson<{ registries?: Array<{ id?: string }> }>(
    join(configDir(), 'plugins', 'marketplaces.json'), {},
  ).registries ?? []).map(r => r?.id).filter((x): x is string => typeof x === 'string').sort()
}

/**
 * The catalog, asked through the same door the Plugins page uses.
 *
 * `page` and `pageSize` are NOT optional in practice and leaving them off cost
 * this case its first run (2026-09-11): `marketplace.list({ kind: 'plugins' })`
 * came back with an empty `items`, and the case reported
 * `an EMPTY catalog means the registry root has no marketplace.json` — a
 * detector's own missing argument, phrased as a fact about the fixture. The
 * spelling here is `agent-install.ts`'s, which has been run against a real
 * profile and works.
 */
async function catalogPluginNames(session: CdpSession, marketplaceId: string): Promise<string[]> {
  return session.call<string[]>(`
    const page = await window.electronAPI.marketplace.list({ kind: 'plugins', page: 1, pageSize: 100 })
    return (page?.items ?? [])
      .filter(item => item.marketplaceId === ${JSON.stringify(marketplaceId)})
      .map(item => item.name ?? item.id)
      .filter(Boolean)
      .sort()
  `).catch(() => [])
}

/** The runtimes this case is about, resolved against what the app lists. */
async function cards(session: CdpSession): Promise<{ claude: string; codex: string }> {
  const rows = await listConnections(session)
  const wantClaude = process.env.NESSY_CDP_CLAUDE_CARD?.trim()
  const wantCodex = process.env.NESSY_CDP_CODEX_CARD?.trim()
  const claude = wantClaude ?? rows.find(r => runtimeOf(r.providerType) === 'anthropic')?.slug
  const codex = wantCodex ?? rows.find(r => runtimeOf(r.providerType) === 'codex-runtime')?.slug
  if (!claude || !codex) {
    blocked(
      'QL9 is about BOTH runtimes and refuses to answer for one: missing '
      + [!claude && 'a claude-runtime card', !codex && 'a codex-runtime card'].filter(Boolean).join(' and ')
      + `. The app lists ${rows.map(r => `${r.slug}(${r.providerType})`).join(', ') || 'nothing'}.`,
    )
  }
  return { claude, codex }
}

/** The fixture plugin's echo server, as the pool mints its wire name. */
const ECHO_WIRE = `plugin_${FIXTURE.pluginEchoId}_${FIXTURE.echoServerName}`

/** The two names one reach uses — see "Why the per-runtime half…" above. */
export function reachNames(family: 'claude' | 'codex'): { asked: string; hostRow: string } {
  return { asked: modelToolName(ECHO_WIRE, family), hostRow: proxyToolName(ECHO_WIRE, family) }
}

/** What the model is asked — ALWAYS the name that runtime's model is handed. */
export function reachPrompt(family: 'claude' | 'codex'): string {
  return 'This is an authorized live test on my own machine. '
    + `Call the tool ${reachNames(family).asked} with no arguments and reply with exactly what it returned.`
}

export interface ReachReading {
  /** At least one tool row whose `toolName` IS the host row name. */
  readonly called: boolean
  /** The per-call nonce the probe server put in one of THOSE rows' results. */
  readonly nonce: string | undefined
  /** Every tool name the transcript carries — the detail when `called` is false. */
  readonly toolRows: readonly string[]
}

/**
 * F1.154 — the reach, read off the tool ROW by its exact host name and the
 * nonce off that row's RESULT. Nothing else in the transcript is consulted:
 * the user row spells the asked name, and the model's reply can spell anything.
 */
export function readReach(rows: readonly TranscriptMessage[], hostRow: string): ReachReading {
  const calls = rows.filter(message => message.toolName === hostRow)
  return {
    called: calls.length > 0,
    nonce: calls.map(message => /nonce=([0-9a-f]{12})/.exec(message.toolResult ?? '')?.[1]).find(Boolean),
    toolRows: [...new Set(rows.map(message => message.toolName).filter((name): name is string => typeof name === 'string'))],
  }
}

/** How a reach that produced no host-named tool row actually went (F1.262). */
export interface ReachMiss {
  /** `blocked` measures the model or the turn; `fail` measures the product. */
  readonly verdict: 'blocked' | 'fail'
  readonly kind: InstallMissKind | 'turn-error' | 'misrouted'
  readonly reason: string
}

/** The echo tool under ANY spelling — hyphens and underscores are one family here. */
function isEchoTool(toolName: string): boolean {
  return toolName.replace(/-/g, '_').includes(`plugin_${FIXTURE.pluginEchoId.replace(/-/g, '_')}_`)
    && toolName.endsWith('__whoami')
}

/**
 * F1.262 — classify a reach miss before scoring it. The rows and the model's
 * words are read by AGENT-INSTALL's own classifier (`classifyInstallMiss`), so
 * `declined`, `load-parked` and `loaded-not-callable` mean here exactly what
 * they mean there, and keep its verdict (F1.1020): they BLOCK, each measuring
 * the model or the turn shape, not whether the installed server reaches the
 * session, except `loaded-not-callable` on a Pi bundle that carries F1.803,
 * which FAILS as it does there (F1.1007). This case drives claude and codex
 * only and `mcp__tool_load` is Pi's alone, so that bundle reads `unknown` here
 * and BLOCKS today; a Pi arm would inherit the FAIL with a reason that agrees.
 * Three more misses measure the product and FAIL: the echo tool dispatched
 * under a name that is not the host row name (`misrouted`, read FIRST — it
 * outranks any prose), the model
 * reporting the tool absent from its toolset (`tools-absent` — the classifier's
 * own sentence is about session tools on codex, so this one is worded here),
 * and an off-script plugin install. A turn that threw before any reply and
 * carries no tool row is the upstream, and blocks on its own error.
 */
export function classifyReachMiss(
  rows: readonly TranscriptMessage[],
  hostRow: string,
  turnError?: string,
): ReachMiss {
  const misrouted = [...new Set(rows
    .map(message => message.toolName)
    .filter((name): name is string => typeof name === 'string' && name !== hostRow && isEchoTool(name)))]
  if (misrouted.length > 0) {
    return {
      verdict: 'fail',
      kind: 'misrouted',
      reason: `the echo tool was dispatched as ${JSON.stringify(misrouted)}, never as the host row name ${hostRow} — `
        + 'the call reached the host under a name it did not map to the installed server',
    }
  }
  const replied = rows.some(message => message.role === 'assistant' && message.content.trim() !== '')
  const toolRows = rows.some(message => typeof message.toolName === 'string')
  if (turnError !== undefined && !replied && !toolRows) {
    return {
      verdict: 'blocked',
      kind: 'turn-error',
      reason: `the reach turn errored before any reply or tool row: ${turnError.slice(0, 300)} — the card's upstream, `
        + 'not the installed plugin',
    }
  }
  const miss = classifyInstallMiss([...rows])
  if (miss.kind === 'tools-absent') {
    return {
      verdict: 'fail',
      kind: 'tools-absent',
      reason: `${miss.reason.split(': "')[0]}: the plugin's tool is the one thing this reach asks about, so its absence is `
        + 'the answer — the roster did not carry it, or (claude, pi) it was deferred and the model never searched; '
        + 'read whether `mcp__tool_search` ran before reading this as a routing defect',
    }
  }
  if (miss.kind === 'install-ran' || miss.kind === 'plan-only') {
    return { verdict: 'fail', kind: miss.kind, reason: `the model went off-script and touched the install tools: ${miss.reason}` }
  }
  return { verdict: miss.verdict, kind: miss.kind, reason: miss.reason }
}

interface Reach extends ReachReading {
  readonly card: string
  readonly bound: string | undefined
  readonly asked: string
  readonly hostRow: string
  /** The model's final reply carried the nonce — observed; the RESULT row is the proof. */
  readonly replyCarriesNonce: boolean
  readonly note?: string
  /** Set when no host-named tool row was found: how the miss went (F1.262). */
  readonly miss?: ReachMiss
}

/**
 * Does the installed plugin's tool reach a session on this card.
 *
 * Returns an observation rather than throwing: a miss comes back CLASSIFIED
 * ({@link classifyReachMiss}), and the caller blocks on a model-shaped miss
 * only after every runtime has been driven. A session that never binds to the
 * card comes back as a `note` and fails — that is the product's switch.
 */
async function reach(
  session: CdpSession,
  run: CaseRun,
  family: 'claude' | 'codex',
  card: string,
): Promise<Reach> {
  const key = await freshSession(session, `CDP QL9 ${family} ${new Date().toISOString().slice(11, 19)}`)
  const outcome = await switchRuntime(session, key.sessionId, card)
  const bound = await waitForConnection(session, key.sessionId, card, outcome.ok ? 30_000 : 60_000)
  const { asked, hostRow } = reachNames(family)
  run.observe(`${family}-model-vs-host-name`, { asked, hostRow })
  if (bound !== card) {
    return { card, bound, asked, hostRow, called: false, nonce: undefined, toolRows: [], replyCarriesNonce: false,
      note: `the session never bound to ${card}: ${String(outcome.errorDetail?.message ?? outcome.error ?? 'no reason given')}` }
  }
  await setPermissionMode(session, key.sessionId, 'bypassPermissions').catch(() => undefined)
  await Bun.sleep(3_000)
  const rowsBefore = (await transcript(session, key)).length // F1.551: where THIS send's rows start
  const turnError = await sendPrompt(session, key, reachPrompt(family), 300_000)
    .then(() => undefined, (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)))
  if (turnError !== undefined) run.observe(`${family}: reach turn error`, turnError)
  // The tool ROW, not turn completion: AGENT-INSTALL measured the row present
  // while the turn had not closed inside 240 s — so the rows are read after the
  // send whether it settled or threw, but only the rows SINCE it (F1.551): the
  // whole transcript was this turn's alone only while the session stayed fresh.
  const rows = (await transcript(session, key)).slice(rowsBefore)
  run.observe(`${family}: rows since the send`, rows.length)
  const reading = readReach(rows, hostRow)
  const reply = rows.filter(message => message.role === 'assistant').map(message => message.content).join('\n')
  return {
    card, bound, asked, hostRow, ...reading,
    replyCarriesNonce: reading.nonce !== undefined && reply.includes(reading.nonce),
    ...(reading.called ? {} : { miss: classifyReachMiss(rows, hostRow, turnError) }),
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const pluginsBefore = installedPluginIds()
  const registriesBefore = registryIds()
  run.observe('profile before', { plugins: pluginsBefore.length, registries: registriesBefore.length })
  if (pluginsBefore.includes(FIXTURE.pluginEchoId)) {
    blocked(
      `${FIXTURE.pluginEchoId} is already installed — a previous run did not clean up. Remove it through the `
      + 'Plugins page before running this, or the pre-state assertion at the end would pass vacuously.',
    )
  }

  const picked = await cards(session)
  run.observe('cards', picked)

  // The registries only — never the config dir, which is the running app's (F1.146).
  const { paths } = await buildFixtures(undefined, { seedConfigDir: false })
  run.observe('fixture registry', paths.marketA)

  const added = await session.call(`
    return await window.electronAPI.marketplace.addRegistry({ source: ${JSON.stringify(paths.marketA)} })
  `).catch((e: unknown) => ({ error: String(e).slice(0, 200) }))
  run.observe('addRegistry — what the Plugins page calls', added)

  const registryId = await waitFor(
    async () => registryIds().find(id => !registriesBefore.includes(id)),
    id => typeof id === 'string',
    { timeoutMs: 60_000, intervalMs: 1_000, label: 'the new registry appears in marketplaces.json' },
  ).catch(() => undefined)

  try {
    run.require('the fixture registry is registered', typeof registryId === 'string', String(registryId))

    const catalog = await waitFor(
      async () => catalogPluginNames(session, registryId!),
      names => names.includes(FIXTURE.pluginEchoId),
      { timeoutMs: 90_000, intervalMs: 3_000, label: 'the registry catalog delivers its listings' },
    ).catch(() => [] as string[])
    run.require(
      'the registry catalog carries the fixture listing', catalog.includes(FIXTURE.pluginEchoId),
      `catalog=${catalog.join(',')} — an EMPTY catalog means the registry root has no marketplace.json`,
    )

    // ---- THE INSTALL, through the product's own door ----------------------
    // A registry listing id is `<marketplaceId>:<name>`, NOT the bare name, and
    // the product says so itself — this case's first run passed the bare
    // `cdp-echo-probe` and got back, verbatim: *Marketplace listing
    // "cdp-echo-probe" is not in the catalog of marketplace "registry-…".
    // Registry listing ids are "<marketplaceId>:<name>"; if this id has no
    // prefix it did not come from that catalog.* An error message that names the
    // shape it wanted is the reason this took one run rather than an afternoon.
    const listingId = `${registryId}:${FIXTURE.pluginEchoId}`
    // F1.462 (1): GLOBAL, the Plugins page's own default for a plugin listing
    // (`defaultInstallScope` → `user/global` → `{ kind: 'global' }`) — and what
    // every run measured, SIT-11's included, because the workspace branch this
    // replaced read the workspace LIST as an object and was always dead.
    const installResult = await session.call(`
      return await window.electronAPI.marketplace.install({
        source: {
          kind: 'listing',
          marketplaceId: ${JSON.stringify(registryId)},
          listingId: ${JSON.stringify(listingId)},
          listingKind: 'plugins',
        },
        activateIn: { kind: 'global' },
      })
    `).catch((e: unknown) => ({ error: String(e).slice(0, 300) }))
    run.observe('install — WHAT THE USER SEES', installResult)

    const installed = installedPluginIds()
    run.observe('plugins after install', installed)
    run.require(
      'the product install path put the plugin on disk', installed.includes(FIXTURE.pluginEchoId),
      `installed=${installed.join(',')}`,
    )

    const record = installedRows().find(r => r?.pluginId === FIXTURE.pluginEchoId)
    const caps = record?.manifest?.capabilities ?? []
    run.observe('capabilities the install recorded', caps.map(c => c.kind))
    run.check(
      'the mcp capability carries the LOGICAL server name',
      caps.some(c => c.kind === 'mcp' && c.mcp?.serverName === FIXTURE.echoServerName),
      `serverNames=${caps.filter(c => c.kind === 'mcp').map(c => c.mcp?.serverName).join(',')}`,
    )

    // ---- THE REACH, once per runtime -------------------------------------
    // A model-shaped miss BLOCKS — but only after both runtimes were driven, so
    // one runtime's declining model never hides the other runtime's answer.
    const blockedReaches: string[] = []
    for (const family of ['claude', 'codex'] as const) {
      const result = await reach(session, run, family, picked[family])
      run.observe(`${family}: reach`, result)
      if (result.note) {
        run.check(`${family}: the plugin's tool reaches the session`, false, result.note)
        continue
      }
      if (result.miss?.verdict === 'blocked') {
        blockedReaches.push(`${family} — ${result.miss.kind}: ${result.miss.reason}`)
        continue
      }
      run.check(
        `${family}: the plugin's tool is DISPATCHED under the host row name`,
        result.called,
        `no ${result.hostRow} tool row (the model was asked for ${result.asked}); tool rows seen: `
        + `${JSON.stringify(result.toolRows)} — ${result.miss?.kind ?? 'unclassified'}: ${result.miss?.reason ?? ''}`,
      )
      run.check(
        `${family}: the tool RESULT carried a fresh per-call nonce — a server answered`,
        result.nonce !== undefined,
        'no row by that name carried `nonce=` in its result — nothing proves the installed server answered '
        + '(a stopped fixture server reads exactly like this)',
      )
    }
    // QL9 refuses to answer for one runtime: a blocked reach blocks the case,
    // and a FAIL already recorded on the other runtime still makes it a FAIL.
    if (blockedReaches.length > 0) blocked(`the reach could not be measured on ${blockedReaches.join('; ')}`)
  } finally {
    // Uninstall keys on `pluginKey` — the opaque pair the product writes — never
    // on `pluginId`: a hand-built key silently uninstalls nothing and the
    // pre-state assertion below would then report a cleanup that never happened.
    const pluginKey = installedRows().find(r => r?.pluginId === FIXTURE.pluginEchoId)?.pluginKey
    // What each cleanup call ANSWERED is recorded, never swallowed: measured
    // 2026-09-23 (packaged 1.40.0, a codex session in the workspace) a single
    // read straight after these calls found the plugin still listed and the
    // profile clean moments later — a check that cannot tell "not yet" from
    // "never" reports a cleanup failure that did not happen, or hides one that did.
    if (pluginKey) {
      run.observe('cleanup — uninstall answered', await session.call(`
        return await window.electronAPI.plugin.manage({ pluginKey: ${JSON.stringify(pluginKey)}, action: 'uninstall' })
      `).catch((e: unknown) => ({ threw: String(e).slice(0, 300) })))
    }
    if (typeof registryId === 'string') {
      run.observe('cleanup — removeRegistry answered', await session.call(`
        return await window.electronAPI.marketplace.removeRegistry({ marketplaceId: ${JSON.stringify(registryId)} })
      `).catch((e: unknown) => ({ threw: String(e).slice(0, 300) })))
    }
    const settled = await waitFor(
      async () => ({ plugins: installedPluginIds(), registries: registryIds() }),
      now => JSON.stringify(now.plugins) === JSON.stringify(pluginsBefore)
        && JSON.stringify(now.registries) === JSON.stringify(registriesBefore),
      { timeoutMs: 30_000, intervalMs: 1_000, label: 'the profile to return to its pre-state' },
    ).catch(() => ({ plugins: installedPluginIds(), registries: registryIds() }))
    const pluginsAfter = settled.plugins
    const registriesAfter = settled.registries
    run.observe('profile after cleanup', { plugins: pluginsAfter.length, registries: registriesAfter.length })
    run.check(
      'the operator profile is back to its pre-state',
      JSON.stringify(pluginsAfter) === JSON.stringify(pluginsBefore)
      && JSON.stringify(registriesAfter) === JSON.stringify(registriesBefore),
      `plugins ${pluginsBefore.join(',')} -> ${pluginsAfter.join(',')}; `
      + `registries ${registriesBefore.length} -> ${registriesAfter.length}`,
    )
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
