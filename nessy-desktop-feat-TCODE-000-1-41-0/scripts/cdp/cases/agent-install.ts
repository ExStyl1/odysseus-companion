/**
 * AGENT-INSTALL — the agent-driven plugin install, end to end, on a real profile.
 *
 * This is D4's run turned into a case. D4 was driven by hand and found two
 * product defects that the UI channel's own tests could not: the agent path
 * ignored a listing's `structuredInstallSource` (`d18f2b34c`), and it entered
 * one layer BELOW the door that acquires dependencies (`4881e7f50`). Both are
 * divergences between the two install channels, and a divergence is only
 * visible when the second channel is actually driven.
 *
 * WHAT THIS CASE COSTS, AND WHY IT IS SHAPED THIS WAY
 *
 * It runs against whatever profile the app was launched on — a config dir
 * CREATED FOR THE RUN is the rig (D1.364; SIT-11 drove it that way) — and
 * `freshSession()` lands in the ACTIVE workspace regardless of
 * `NESSY_CDP_WORKSPACE_ID` (that env var only binds for cases calling
 * `fixtureWorkspaceId()`). This line used to say the fixture config dir was a
 * dead `custom-root-reset-required` gate; that was the fixture writing into the
 * dir before the app had booted it, fixed at the fixture (F1.146). The case is
 * still built as if the profile were someone's real one:
 *
 *   - it records the pre-state FIRST and refuses to run if its own artifacts
 *     are already present (a previous run that did not clean up);
 *   - it only ever installs the FIXTURE plugin from a FIXTURE registry;
 *   - it removes both through the agent's own tools, and then asserts the
 *     profile is byte-for-byte back to its pre-state. A case that leaves a
 *     plugin behind on someone's real profile is a bug, not a measurement.
 *
 * ROUTE FACTS, each one corrected BY measurement during D4:
 *
 *   1. A local PATH is not an install route. `plugin_plan_install` with a
 *      filesystem path answers `marketplace.repository.unsupported_url` — that
 *      is a security property (installs come from registries), not a bug to
 *      route around. The route is: add the fixture folder as a REGISTRY, then
 *      install the listing by `<registryId>:<pluginName>`.
 *   2. A registry folder needs a ROOT catalog manifest or `addRegistry()`
 *      accepts it and its catalog stays SILENTLY empty. `buildFixtures` writes
 *      `market-a/marketplace.json` for exactly this reason (`9b4452780`).
 *   3. Catalog delivery is ASYNC. There is a `marketplace.registry.fetch_pending`
 *      window after `addRegistry` resolves; installing inside it fails with a
 *      lookup error that looks like defect 1. Hence `waitForCatalog`.
 *   4. The model may DECLINE a probe-shaped prompt outright
 *      (`{"status":"blocked","reason":"appears to be a probe or test"}`, no
 *      tool_use at all). That measures the MODEL, not the install path — so the
 *      prompt is framed honestly and a refusal reports BLOCKED, never FAIL.
 *   5. A DEFERRED tool is reached by a LOAD, then a CALL (F1.145, SIT-11
 *      `P-SIT11-1`). With deferred MCP on, both install tools sit behind
 *      `mcp__tool_load`. Until F1.803 (`722c67605`) a loaded tool was callable
 *      only from the user's NEXT message; the case sent ONE prompt, so on `pi`
 *      the turn could only LOAD, and the model said so, verbatim, in the second
 *      of two BLOCKED runs: *"they only become callable on your **next**
 *      message — I can't execute them in this turn"* — while the block message
 *      blamed the model for declining. Since F1.803 a loaded tool is callable
 *      from the next step of the SAME request and stays selected afterwards
 *      (`deferred-mcp-tools.ts`), so the TWO requests ({@link loadThenCall})
 *      are no longer required; they are kept because they still hold: a
 *      deferral-aware load turn (`claude-gateway`, nothing deferred, answers
 *      `TOOLS-READY` and loads nothing), then the call. The load raises an
 *      `mcp_mutation` card `bypassPermissions` does not suppress (SIT-11 pi run
 *      1 parked on it for all 300 s), so `approvePermissionsWhile` runs
 *      underneath as a net. A miss is CLASSIFIED ({@link classifyInstallMiss})
 *      from the rows and the model's words, so *loaded but not callable*, *not
 *      in my toolset*, *parked on a card* and *declined* are four block
 *      sentences, and an install that RAN and left nothing on disk is a FAIL —
 *      as is *loaded but not callable* on a Pi bundle that carries F1.803, read
 *      off the loader's own answer ({@link piLoadContract}, F1.1007).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  assertElectronApi, freshSession, setPermissionMode, transcript, waitFor,
  type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'
import { approvePermissionsWhile, approverBlindnessNote, type PermissionApprover } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { buildFixtures, FIXTURE, proxyToolName } from '../fixtures/mcp-naming.ts'

const ID = 'AGENT-INSTALL'
const TITLE = 'An agent adds a registry, installs a plugin from it, calls its tool, and removes both — on a real profile'

/**
 * The shape of `plugins/installed.json`, READ OFF THE OPERATOR'S OWN FILE
 * rather than inferred from a type name.
 *
 * Worth stating because the obvious guess is wrong twice over: the file is
 * `{schemaVersion, updatedAt, active, plugins: [...]}` and not an array or a
 * map; and a capability is keyed `kind`, not `type`, with its payload nested
 * under a field named after the kind (`cap.mcp.serverName`, `cap.skill.path`).
 * A detector written from the guess reports "no mcp capability" against a
 * record that plainly has one.
 */
interface InstalledFile {
  plugins?: InstalledRow[]
}
interface InstalledRow {
  pluginId?: string
  pluginKey?: string
  manifest?: { capabilities?: Capability[] }
}
interface Capability {
  kind?: string
  id?: string
  mcp?: { serverName?: string }
  skill?: { path?: string }
}

function installedPath(): string {
  return join(configDir(), 'plugins', 'installed.json')
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/**
 * Installed plugins as the PRODUCT records them, read from disk.
 *
 * On disk rather than through the renderer, deliberately: `installed.json` is
 * what the installer writes, so it cannot agree with a broken installer the way
 * a UI query fed from the same in-memory state can.
 */
function installedRows(): InstalledRow[] {
  return readJson<InstalledFile>(installedPath(), {}).plugins ?? []
}

function installedPluginIds(): string[] {
  return installedRows().map(r => r?.pluginId).filter((id): id is string => typeof id === 'string').sort()
}

/** `plugins/marketplaces.json` is `{schemaVersion, updatedAt, registries: [{id, source, …}]}`. */
function registryIds(): string[] {
  const file = readJson<{ registries?: Array<{ id?: string }> }>(
    join(configDir(), 'plugins', 'marketplaces.json'), {},
  )
  return (file.registries ?? [])
    .map(r => r?.id)
    .filter((id): id is string => typeof id === 'string')
    .sort()
}

async function addRegistry(session: CdpSession, source: string): Promise<unknown> {
  return session.call(`
    return await window.electronAPI.marketplace.addRegistry({ source: ${JSON.stringify(source)} })
  `)
}

async function removeRegistry(session: CdpSession, marketplaceId: string): Promise<unknown> {
  return session.call(`
    return await window.electronAPI.marketplace.removeRegistry({ marketplaceId: ${JSON.stringify(marketplaceId)} })
  `)
}

/**
 * The listing ids the PRODUCT will actually serve for this registry.
 *
 * Asked through `marketplace.list`, not read off disk, and that correction cost
 * a run: `plugins/registry-catalogs/<id>.json` is NOT written for a local
 * folder registry — on the operator's profile every file in that directory
 * dates from the day its REMOTE registry was added, and the fixture registry
 * never got one at all. A case reading that path reports an empty catalog
 * forever and blames the fixture's `marketplace.json`, which is present and
 * correct. `marketplace.list` is the same door the Plugins page uses, so it
 * answers for whatever the product can really serve.
 *
 * `addRegistry` also RESOLVES BEFORE the catalog is queryable — the window is
 * reported as `marketplace.registry.fetch_pending`, and an install issued
 * inside it fails with a lookup error indistinguishable from "the agent path
 * cannot resolve BYO registries" (D2's defect). Hence the poll.
 */
async function catalogPluginNames(session: CdpSession, marketplaceId: string): Promise<string[]> {
  return session.call<string[]>(`
    const page = await window.electronAPI.marketplace.list({ kind: 'plugins', page: 1, pageSize: 100 })
    return (page?.items ?? [])
      .filter(item => item.marketplaceId === ${JSON.stringify(marketplaceId)})
      .map(item => item.name ?? item.id)
      .sort()
  `)
}

/**
 * Pi's deferred-MCP load tool, verbatim from `DEFERRED_MCP_TOOL_LOAD_NAME`
 * (`packages/pi-agent-server/src/deferred-mcp-tools.ts`). Not imported: this
 * harness drives the app from outside and must not link its subprocess bundle —
 * the reason MCP-W2 and MCP-AUTH give for spelling it out too.
 */
const DEFERRED_LOAD_TOOL = 'mcp__tool_load'

/**
 * The two session tools the install needs, by the names Pi's deferred catalogue
 * lists them under — SIT-11 pi run 1's `mcp__tool_search` answered
 * `mcp__session__plugin_plan_install [session, available, …]`.
 */
export const INSTALL_TOOLS = ['mcp__session__plugin_plan_install', 'mcp__session__plugin_install'] as const

/** One request's worth of transcript, or the reason it threw. A failed turn is data. */
export interface AgentTurn {
  added: TranscriptMessage[]
  error?: string
}

/**
 * TURN ONE of a deferral-aware call: load, never call.
 *
 * The restriction is POSITIVE ("use only …") and names no tool it forbids,
 * which is not a style choice: a prompt that names a tool and forbids calling
 * it in the same breath trips Pi's Guardian as an injection (MCP-W2's header
 * records the denial verbatim, AGENTS.md's trap list the rule). ONE LINE, like
 * every prompt here — the composer swallows a newline and `sendPrompt`'s
 * read-back then refuses the prompt with `composer-mismatch`.
 */
export function loadPrompt(names: readonly string[]): string {
  return 'This is an authorized live test on my own machine and profile. '
    + `In this turn use only ${DEFERRED_LOAD_TOOL}, and no other tool. `
    + `Step 1: if ${DEFERRED_LOAD_TOOL} is not in your tool list, reply with exactly TOOLS-READY and stop. `
    + `Step 2: call ${DEFERRED_LOAD_TOOL} once, with its "names" argument set to ${names.map(n => JSON.stringify(n)).join(' and ')}. `
    + 'Step 3: reply with exactly TOOLS-LOADED.'
}

/**
 * Reach a set of tools in a shape every Pi bundle allows: load them in one
 * request, call them in the NEXT (since F1.803 the load's own request would do).
 * `send` is the turn itself, injected so the order is a driven fact in
 * `harness.test.ts` rather than a reading of this file's source.
 */
export async function loadThenCall(
  send: (prompt: string) => Promise<AgentTurn>,
  names: readonly string[],
  callPrompt: string,
): Promise<{ load: AgentTurn; call: AgentTurn }> {
  const load = await send(loadPrompt(names))
  const call = await send(callPrompt)
  return { load, call }
}

function sendTurn(session: CdpSession, key: SessionKey): (prompt: string) => Promise<AgentTurn> {
  return prompt => sendPrompt(session, key, prompt, 300_000)
    .then(turn => ({ added: turn.added }))
    .catch((cause: unknown) => ({ added: [], error: cause instanceof Error ? cause.message : String(cause) }))
}

/** How an agent-driven install that left nothing on disk actually went. */
export type InstallMissKind =
  | 'install-ran'
  | 'plan-only'
  | 'load-parked'
  | 'loaded-not-callable'
  | 'tools-absent'
  | 'declined'

export interface InstallMiss {
  kind: InstallMissKind
  /**
   * AGENT-INSTALL's verdict on the miss: `fail` when it measures the PRODUCT (an
   * install that RAN, or `loaded-not-callable` on a Pi bundle that carries
   * F1.803 — F1.1007), `blocked` otherwise.
   */
  verdict: 'fail' | 'blocked'
  /** The sentence the case blocks (or fails) with. */
  reason: string
}

/** `plugin_install` on pi's rows, `mcp__session__plugin_install` on claude's. */
function isToolRow(message: TranscriptMessage, bare: string): boolean {
  return typeof message.toolName === 'string'
    && (message.toolName === bare || message.toolName.endsWith(`__${bare}`))
}

/**
 * The model's own words for *loaded, but not callable in this request*. Read
 * with markdown emphasis stripped, because the measured sentence bolds the one
 * word that matters (`**next**`) and a regex written against the plain form
 * would miss the only sentence it exists for.
 */
const SAYS_NEXT_MESSAGE = /\b(next|following) (user )?message\b|not callable in (this|the current) (request|turn)|(can['’]t|cannot|can not) (execute|call|run|use) (them|it|these|those)( tools?)? (in|during) this (turn|request)/i

/** The model's own words for *the tools are not on my surface at all* (SIT-11 codex, C2). */
const SAYS_NOT_IN_TOOLSET = /\bnot (available|present|listed) (in|on|among) my\b|\b(do not|don['’]t) have (access to )?(the |those |these |any )?(plugin )?tools?\b|\bno (such )?tool (named|called)\b/i

/**
 * F1.1007 — which load contract the Pi bundle ships, read off its OWN
 * `mcp__tool_load` answer. That answer is the one in-run self-report of it: this
 * harness drives the app from outside and never links the bundle. The openings
 * are verbatim from `deferred-mcp-tools.ts`'s history: F1.803 (`722c67605`)
 * answers "Tools loaded and callable from your next step …", 1.31.0
 * (`0a4a5d8b8`) answered "MCP tools loaded and available from the user's next
 * message …", and the bundle before it "MCP tools available on the next model
 * turn of this request …". A wording none of them matches reads `unknown`, which
 * BLOCKS, so a rewording costs a BLOCKED, never a false FAIL; and
 * `agent-install-miss.test.ts` pins the F1.803 opening against the loader's
 * source, so the FAIL arm cannot go dead unseen.
 */
export type PiLoadContract = 'carries-F1.803' | 'predates-F1.803' | 'unknown'

export const LOAD_ANSWER_F1_803 = 'Tools loaded and callable from your next step'
const LOAD_ANSWERS_BEFORE_F1_803 = [
  "MCP tools loaded and available from the user's next message",
  'MCP tools available on the next model turn of this request',
] as const

export function piLoadContract(messages: readonly TranscriptMessage[]): PiLoadContract {
  const answers = messages.filter(m => m.toolName === DEFERRED_LOAD_TOOL).map(m => m.toolResult ?? '')
  if (answers.some(text => text.includes(LOAD_ANSWER_F1_803))) return 'carries-F1.803'
  if (answers.some(text => LOAD_ANSWERS_BEFORE_F1_803.some(opening => text.includes(opening)))) return 'predates-F1.803'
  return 'unknown'
}

/** F1.1007 — how a `loaded-not-callable` miss ends, one sentence per bundle reading, so the reason says which. */
const LOADED_NOT_CALLABLE_VERDICT: Record<PiLoadContract, string> = {
  'carries-F1.803': 'FAIL: the Pi loader answered in F1.803\'s words ("callable from your next step"), so this bundle '
    + 'carries F1.803 (`722c67605`), under which a loaded tool is callable from the next step of the SAME request and '
    + 'stays selected — the product regressed (F1.1007)',
  'predates-F1.803': 'BLOCKED: the Pi loader answered in a pre-F1.803 wording ("next message" or "next model turn"), so '
    + 'this bundle predates F1.803 (`722c67605`), under which a loaded tool could stay uncallable; rebuild the Pi bundle '
    + '(`electron:build:servers`) before reading anything into it (F1.1007)',
  unknown: `BLOCKED: no ${DEFERRED_LOAD_TOOL} answer here carries a known wording (the loader is Pi's alone), so `
    + 'whether the bundle carries F1.803 is unread (F1.1007)',
}

/**
 * Classify a miss from the rows and the model's words — never from the absence
 * alone. The order is the evidence's strength: a plugin tool that RAN outranks
 * every reading of prose, and prose outranks a bare absence.
 *
 * Rows are read over BOTH requests; words only over the one that asked for the
 * CALL. A correct load turn may echo the deferral sentence (until F1.803 the
 * loader itself answered *"available from the user's next message"*), so
 * reading its prose would turn every later miss into `loaded-not-callable`.
 */
export function classifyInstallMiss(call: TranscriptMessage[], load: TranscriptMessage[] = []): InstallMiss {
  const messages = [...load, ...call]
  const installRows = messages.filter(m => isToolRow(m, 'plugin_install'))
  const planRows = messages.filter(m => isToolRow(m, 'plugin_plan_install'))
  const loadRows = messages.filter(m => m.toolName === DEFERRED_LOAD_TOOL)
  const said = call
    .filter(m => m.role === 'assistant')
    .map(m => m.content.replace(/[*_`]/g, ''))
    .join('\n')
  const quote = (pattern: RegExp): string => {
    const hit = pattern.exec(said)
    if (!hit) return ''
    const start = Math.max(0, said.lastIndexOf('\n', hit.index) + 1)
    return said.slice(start, start + 240).replace(/\s+/g, ' ').trim()
  }
  const toolNames = [...new Set(messages.map(m => m.toolName).filter((n): n is string => typeof n === 'string'))]

  if (installRows.length > 0) {
    const row = installRows.at(-1)!
    return {
      kind: 'install-ran',
      verdict: 'fail',
      reason: `plugin_install RAN (status=${row.toolStatus ?? 'unknown'}, result=${(row.toolResult ?? '(none)').slice(0, 240)}) `
        + 'and installed.json does not carry the plugin — the install path answered, so this is the PRODUCT\'s verdict, not the model\'s',
    }
  }
  if (planRows.length > 0) {
    const row = planRows.at(-1)!
    return {
      kind: 'plan-only',
      verdict: 'blocked',
      reason: `plugin_plan_install ran (status=${row.toolStatus ?? 'unknown'}, result=${(row.toolResult ?? '(none)').slice(0, 240)}) `
        + 'and plugin_install was never called — read the plan\'s own answer before reading anything into the miss',
    }
  }
  const parked = loadRows.find(m => m.toolStatus !== 'completed')
  if (parked) {
    return {
      kind: 'load-parked',
      verdict: 'blocked',
      reason: `${DEFERRED_LOAD_TOOL} was issued and never completed (status=${parked.toolStatus ?? 'unknown'}) — the measured `
        + 'cause is an `mcp_mutation` card nobody answered (SIT-11 pi run 1: parked for the whole 300 s window); '
        + 'read the approver\'s reads before reading this as the loader',
    }
  }
  if (SAYS_NEXT_MESSAGE.test(said)) {
    const contract = piLoadContract(loadRows)
    return {
      kind: 'loaded-not-callable',
      verdict: contract === 'carries-F1.803' ? 'fail' : 'blocked',
      reason: 'the tools were reached but NOT CALLABLE in the request that asked for the call, and the model said so: '
        + `"${quote(SAYS_NEXT_MESSAGE)}". This is a deferral reading, not the model refusing (F1.145). `
        + LOADED_NOT_CALLABLE_VERDICT[contract],
    }
  }
  if (SAYS_NOT_IN_TOOLSET.test(said)) {
    return {
      kind: 'tools-absent',
      verdict: 'blocked',
      reason: `the model reports the plugin tools absent from its toolset: "${quote(SAYS_NOT_IN_TOOLSET)}". On codex this `
        + 'is the documented null (`SESSION_TOOLS_REQUIRING_HOST_CALLBACK` keeps them off an external subprocess, SIT-11 '
        + 'codex C2); on pi or claude it is a surface question for `mcp__tool_search`, not a decline',
    }
  }
  return {
    kind: 'declined',
    verdict: 'blocked',
    reason: `the model issued no plugin tool call (tool rows seen: ${JSON.stringify(toolNames)}`
      + `${loadRows.length > 0 ? `; ${DEFERRED_LOAD_TOOL} completed, so the tools WERE loaded` : ''}) `
      + 'and said nothing about deferral — D4 measured the model declining a probe-shaped prompt outright '
      + '(`{"status":"blocked","reason":"appears to be a probe or test"}`, no tool_use at all). That measures the '
      + 'MODEL, not the install path; re-run before reading anything into it',
  }
}

/** The approver's reading, appended to a block sentence only when it has something to say. */
function approverNote(approver: PermissionApprover | undefined): string {
  const note = approver ? approverBlindnessNote(approver.reads) : undefined
  return note ? ` (${note})` : ''
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  // The registries only — never the config dir, which is the running app's (F1.146).
  const { paths } = await buildFixtures(undefined, { seedConfigDir: false })
  run.observe('fixture registry', paths.marketA)

  // ---- pre-state, and the refusal that protects a real profile -------------
  const pluginsBefore = installedPluginIds()
  const registriesBefore = registryIds()
  run.observe('plugins before', pluginsBefore)
  run.observe('registries before', registriesBefore)
  if (pluginsBefore.includes(FIXTURE.pluginEchoId)) {
    blocked(`${FIXTURE.pluginEchoId} is already installed — a previous run did not clean up. `
      + 'Remove it before measuring; this case must never install over existing state.')
  }

  // ---- the registry -------------------------------------------------------
  // Registered BEFORE the try, but everything that can fail after it lives
  // INSIDE — including the catalog wait. An earlier shape asserted the catalog
  // before entering the try, so when that assertion failed the registry was
  // left behind on the operator's real profile and had to be removed by hand.
  // A case that mutates a real profile owns its cleanup from the first
  // mutation, not from the first thing it happens to wrap.
  run.observe('addRegistry', await addRegistry(session, paths.marketA))
  const registryId = await waitFor(
    async () => registryIds().find(id => !registriesBefore.includes(id)),
    id => typeof id === 'string',
    { timeoutMs: 60_000, intervalMs: 1_000, label: 'the new registry appears in marketplaces.json' },
  ).catch(() => undefined)

  let approver: PermissionApprover | undefined
  try {
    run.require('the fixture registry is registered', typeof registryId === 'string', String(registryId))
    run.observe('registryId', registryId)

    // Route fact 3: the catalog becomes queryable after `addRegistry` resolves.
    const catalog = await waitFor(
      async () => catalogPluginNames(session, registryId!),
      names => names.includes(FIXTURE.pluginEchoId),
      { timeoutMs: 90_000, intervalMs: 3_000, label: 'the registry catalog delivers its listings' },
    ).catch(() => [] as string[])
    run.require('the registry catalog carries the fixture listing', catalog.includes(FIXTURE.pluginEchoId),
      `catalog=${catalog.join(',')} — an EMPTY catalog means the registry root has no marketplace.json`)

    // ---- the agent-driven install ----------------------------------------
    const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
    run.observe('session', key)
    await setPermissionMode(session, key.sessionId, 'bypassPermissions')
    await Bun.sleep(4_000)
    // Route fact 5: the load raises a card bypass does not suppress. A net,
    // stopped in `finally` so its clicks never land in a later turn's count.
    approver = approvePermissionsWhile(session, key.sessionId)
    const send = sendTurn(session, key)

    // Honest framing, single line. Route fact 4: a probe-shaped prompt gets
    // refused by the model itself, which is a measurement of the model. Route
    // fact 1: the id, never a path. Route fact 5: the call is the SECOND request.
    const itemId = `${registryId}:${FIXTURE.pluginEchoId}`
    const install = await loadThenCall(send, INSTALL_TOOLS,
      `This is an authorized live test on my own machine and profile. Use only your plugin tools: call plugin_plan_install with marketplaceItemId "${itemId}", then call plugin_install with the returned proposalId and scope "workspace". Reply with ONLY the raw JSON each tool returned.`)
    run.observe('install: load turn', {
      error: install.load.error,
      loadRows: install.load.added.filter(m => m.toolName === DEFERRED_LOAD_TOOL).map(m => m.toolStatus),
    })
    if (install.call.error) run.observe('install: call turn error', install.call.error)

    const installed = installedPluginIds()
    run.observe('plugins after install', installed)
    if (!installed.includes(FIXTURE.pluginEchoId)) {
      // Both turns, or the whole transcript when both threw — a widening that
      // is said, never silent.
      const bothEmpty = install.load.added.length === 0 && install.call.added.length === 0
      if (bothEmpty) run.observe('install miss: scan scope', 'whole transcript (neither turn produced messages)')
      const miss = bothEmpty
        ? classifyInstallMiss(await transcript(session, key))
        : classifyInstallMiss(install.call.added, install.load.added)
      run.observe('install miss', miss)
      // An install that RAN is the product answering: FAIL, never BLOCKED. The
      // label says what passing MEANS on this branch (F1.507): the plugin is not
      // on disk here, so a label claiming it is recorded a false PASS line.
      run.require('the missing plugin is not an install that RAN and left nothing on disk', miss.kind !== 'install-ran', miss.reason)
      // F1.1007 — nor a loaded tool left uncallable on a Pi bundle that carries F1.803: the product regressing, FAIL.
      run.require('the missing plugin is not a loaded tool left uncallable on a Pi bundle carrying F1.803', miss.verdict !== 'fail', miss.reason)
      blocked(`the plugin was not installed — ${miss.kind}: ${miss.reason}${approverNote(approver)}`)
    }
    run.check('the agent-driven install put the plugin on disk', true)

    // ---- obs 1: capability shapes, from the product's own record ----------
    const record = installedRows().find(r => r?.pluginId === FIXTURE.pluginEchoId)
    const caps = record?.manifest?.capabilities ?? []
    const mcpCaps = caps.filter(c => c.kind === 'mcp')
    run.observe('capabilities', caps.map(c => c.kind))
    run.check('the mcp capability carries the LOGICAL server name',
      mcpCaps.some(c => c.mcp?.serverName === FIXTURE.echoServerName),
      `serverNames=${mcpCaps.map(c => c.mcp?.serverName).join(',')} (expected the bare ${FIXTURE.echoServerName})`)

    // ---- obs 2: no wire names at rest ------------------------------------
    // `grep -a`: several files in this tree carry a NUL byte and plain grep
    // SKIPS such a file silently, which would turn "no hits" into a lie.
    // Scoped to the plugin RECORD on purpose — an unscoped sweep hit prompt
    // prose inside a session log during D4 and that never belonged to the claim.
    const recordText = readFileSync(installedPath(), 'utf-8')
    run.check('no minted wire name is persisted in the plugin record',
      !recordText.includes('wireName'),
      'wire names are minted at the session surface; a name at rest would be a second source of truth')

    // ---- obs 3: the minted name, live on the model's own surface ---------
    // Deferred too, on a runtime past the threshold — the SIT-11 pi hand-drive
    // loaded it in turn 3 and called it in turn 4.
    const wire = proxyToolName(`plugin_${FIXTURE.pluginEchoId}_${FIXTURE.echoServerName}`)
    // F1.562 — the rows since THIS step (the load and the call), so an earlier turn, or
    // an earlier run in a session that is not fresh, cannot answer for it.
    const beforeCall = (await transcript(session, key)).length
    await loadThenCall(send, [wire],
      `This is an authorized live test. Call the tool ${wire} with no arguments and reply with exactly what it returned.`)
    // Key on the tool ROW, not on turn completion: D4 measured the row present
    // while the turn had not closed inside 240 s. And on the row BY NAME: this
    // read used to stringify every message and search the blob for the wire
    // name, which the case's OWN prompt satisfies — the user row spells it — so
    // it could not fail (F1.154 is the same shape in PLUGIN-INSTALL-RUNTIMES).
    const rows = (await transcript(session, key)).slice(beforeCall)
    const calls = rows.filter(m => m.toolName === wire)
    run.check('the model can find and call the MINTED tool name', calls.length > 0,
      calls.length > 0 ? wire : `no ${wire} tool row; tool rows seen: ${JSON.stringify([...new Set(rows.map(m => m.toolName).filter(Boolean))])}`)
    // The per-call nonce the probe server mints into its RESULT — present in no
    // file, so only a server that really answered can put it there.
    const nonce = calls.map(m => /nonce=([0-9a-f]{12})/.exec(m.toolResult ?? '')?.[1]).find(Boolean)
    run.check('the minted tool\'s RESULT carried a fresh per-call nonce', Boolean(nonce),
      nonce ? `nonce=${nonce}` : 'no tool result carried a nonce — nothing proves a server answered')
  } finally {
    if (approver) {
      run.observe('permission cards answered', await approver.stop())
      run.observe('what the approver saw', approver.reads)
    }
    // ---- cleanup, and the assertion that it worked -----------------------
    // In `finally` so a failed assertion above still restores the profile.
    //
    // Uninstall keys on `pluginKey` — the opaque base64 `<registry>.<plugin>`
    // pair the product itself writes — NOT on `pluginId`. Read it back from the
    // record rather than reconstructing it: a hand-built key that does not match
    // silently uninstalls nothing and the case would then report a cleanup that
    // never happened.
    const pluginKey = installedRows().find(r => r?.pluginId === FIXTURE.pluginEchoId)?.pluginKey
    if (pluginKey) {
      await session.call(`
        return await window.electronAPI.plugin.manage({ pluginKey: ${JSON.stringify(pluginKey)}, action: 'uninstall' })
      `).catch(() => undefined)
    }
    if (typeof registryId === 'string') await removeRegistry(session, registryId).catch(() => undefined)

    const pluginsAfter = installedPluginIds()
    const registriesAfter = registryIds()
    run.observe('plugins after cleanup', pluginsAfter)
    run.observe('registries after cleanup', registriesAfter)
    run.check("the operator's profile is back to its pre-state — plugins",
      JSON.stringify(pluginsAfter) === JSON.stringify(pluginsBefore),
      `before=${pluginsBefore.join(',')} after=${pluginsAfter.join(',')}`)
    run.check("the operator's profile is back to its pre-state — registries",
      JSON.stringify(registriesAfter) === JSON.stringify(registriesBefore),
      `before=${registriesBefore.length} after=${registriesAfter.length}`)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
