/**
 * RS-105 - SIT-11 surface A: the BUILT-IN MCP servers, as a case file instead of
 * a hand drive (F1.148), with the `available: false` branch F1.157 found undriven.
 *
 * ## Why this case exists
 *
 * SIT-11 (2026-09-20, packaged 1.40.0) PASSED surface A on all three runtimes by
 * hand (`docs/testing/cdp-runs/2026-09-20-builtin-surfaces-sit-11.md`); every
 * reading there was typed into a console, so none of it can be re-taken on the
 * next artefact without re-inventing it. And its critic found one scope limit no
 * driver flagged (F1.157): the whole surface was measured with `dp` installed and
 * signed in, so what a machine WITHOUT dp shows was never looked at.
 *
 * ## The arms
 *
 * A1. **The set a user sees.** `getBuiltinDpMcpServers()` (the settings view) is
 *     read against the repository's own `BUILTIN_DP_MCP_SERVERS` - the
 *     DENOMINATOR, imported, never a list written here: every name, in order,
 *     with its `defaultEnabled`; every server the stored preference never touched
 *     sits at its default. The capability catalog is the second reader: one
 *     `builtin:mcp:<name>` row per definition, `active` exactly when the view says
 *     `enabled`.
 * F1.157. **The dp-less branch, where this machine can reach it.** The view's
 *     `available` is recorded. On a machine where it is `false` the arm checks the
 *     rows are all still listed beside the `builtin_dp_mcp.dp_not_found` sentence,
 *     that the switch still WRITES (it does not refuse - a preference is a
 *     preference), and whether the sentence reaches the DETAIL page a row opens -
 *     the place `McpServersPanel.tsx`'s docblock says it is rendered. **Read from
 *     source on 2026-09-23 it is not**: the detail page renders the SERVER's
 *     capability summary, and `builtinDpMcpCapabilityRecords` deliberately does no
 *     filesystem lookup, so the sentence rides the panel's row data and no DOM.
 *     That check is expected red on a dp-less machine until the proposed row
 *     lands. On a machine where `available` is `true` the arm is NOT drivable and
 *     says why rather than passing: the ladder's fallback rung `/usr/local/bin/dp`
 *     is unconditional - no environment variable reaches it
 *     (`builtin-dp-mcp-no-dp.test.ts` pins that, and drives the same branch
 *     in-process through the real ladder). `NESSY_CDP_RS105_EXPECT_NO_DP=1` makes
 *     the operator's claim "this machine has no dp" a requirement.
 * A2. **OFF by default stays off; the Settings write turns it on - twice.** For
 *     the called server (`dpGitlab`) AND a breadth control (`time`, F1.157's
 *     "second server enabled and connected"): `capabilities.listMcpTools` - a live
 *     connect plus `tools/list` - answers `refused` BEFORE and `ok` with tools
 *     AFTER `setBuiltinDpMcpServerEnabled(name, true)`, same key, same reader. The
 *     pairing is the control: a lone `ok` is equally true of a server that was
 *     always on. Both are restored in a `finally`.
 * A3+A4. **One fresh session per chosen runtime:** a REAL turn calls
 *     `dp_gitlab_whoami` (read-only) and the result comes back; then the session
 *     MCP server answers `automation_list`, `get_session_info` and `remember`
 *     (scope `session`, a per-run token) - `remember`'s detector is the FILE the
 *     tool names, read from disk, not its own sentence. On `pi` MCP tools are
 *     DEFERRED, so one selection turn loads them first (MCP-W2's shape, still valid
 *     since F1.803 made a loaded tool callable from the load's next step too).
 * A5. **Not drivable by construction** and recorded as such: the bundled
 *     `bridge-mcp-server` has no consumer on any runtime (F1.152).
 *
 * ## What it refuses to do
 *
 *  - **Print an identity.** `dp_gitlab_whoami` answers with the machine's GitLab
 *    login, name and e-mail. Only the result's SHAPE is recorded (a `stdout:`
 *    block, its length); the text never reaches an observation.
 *  - **Leave a server on.** Each server this case enables is set back to what
 *    the view said before the case, through the same Settings write.
 *  - **Touch a credential.** No token is read; `dp auth` is never run. Every dp
 *    subprocess authenticates itself, which is the product's own contract.
 *
 * `NESSY_CDP_RS105_FAMILIES` (comma list of `pi`, `claude`, `codex`) chooses the
 * runtime(s) for A3/A4; absent, the first of claude, codex, pi the profile offers.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { modelToolName } from '../fixtures/mcp-naming.ts'
import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import {
  assertElectronApi, freshSession, selectorText, transcript, waitFor, type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'
import { turnRowsSince } from '../lib/turn-evidence.ts'

const ID = 'RS-105'
const TITLE = 'the built-in MCP servers: the dp set listed off by default, one enabled and called by a real turn, '
  + 'the session MCP server answering, and what a machine without dp shows'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'F1.148',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: at least one card per runtime to be read, already signed in, and `dp` installed and signed in '
    + 'on the machine for A2/A3 (each dp subprocess authenticates itself; the case reads no token and never runs '
    + '`dp auth`). It switches two built-in servers on through the app\'s own Settings write and back off in a `finally`.',
} as const satisfies CaseMeta

/** The server a real turn calls, and its read-only tool. */
export const CALLED_SERVER = 'dpGitlab'
export const CALLED_TOOL = 'dp_gitlab_whoami'
/** F1.157's breadth control: a SECOND server enabled and connected. */
export const BREADTH_SERVER = process.env.NESSY_CDP_RS105_BREADTH_SERVER?.trim() || 'time'
/** `dp-binary.ts`'s fallback rung, the one no environment variable reaches. */
export const DP_FALLBACK_PATH = '/usr/local/bin/dp'
/** The three session-server tools SIT-11 drove on claude and codex. */
export const SESSION_TOOLS = ['automation_list', 'get_session_info', 'remember'] as const

export interface BuiltinDefinition { readonly name: string; readonly defaultEnabled: boolean }
export interface BuiltinViewRow { name: string; defaultEnabled: boolean; enabled: boolean }
export interface BuiltinView { available: boolean; diagnostics: Array<{ code: string; message: string }>; servers: BuiltinViewRow[] }

/** A1's comparison of the served list against the shipped definitions. */
export function compareBuiltinRoster(
  served: readonly BuiltinViewRow[],
  definitions: readonly BuiltinDefinition[],
  stored: Readonly<Record<string, unknown>> = {},
): { missing: string[]; extra: string[]; orderMatches: boolean; defaultMismatch: string[]; offDefault: string[] } {
  const servedNames = served.map(row => row.name)
  const definedNames = definitions.map(definition => definition.name)
  const byName = new Map(definitions.map(definition => [definition.name, definition] as const))
  return {
    missing: definedNames.filter(name => !servedNames.includes(name)),
    extra: servedNames.filter(name => !byName.has(name)),
    orderMatches: servedNames.join(',') === definedNames.join(','),
    defaultMismatch: served.filter(row => byName.has(row.name) && byName.get(row.name)!.defaultEnabled !== row.defaultEnabled)
      .map(row => row.name),
    // A server the user never touched must sit at its own default.
    offDefault: served.filter(row => typeof stored[row.name] !== 'boolean' && row.enabled !== row.defaultEnabled)
      .map(row => row.name),
  }
}

/** Whether this machine can show the dp-less branch, from what the app and the disk say. */
export function dpLessBranch(input: { available: boolean; fallbackExists: boolean; expectNoDp: boolean }):
  { verdict: 'drive' | 'not-drivable-here' | 'contradiction'; reason: string } {
  if (!input.available) return { verdict: 'drive', reason: 'the app reports the built-in set unavailable' }
  if (input.expectNoDp) {
    return {
      verdict: 'contradiction',
      reason: 'NESSY_CDP_RS105_EXPECT_NO_DP=1 says this machine has no dp, and the app found one - read which rung '
        + 'answered before trusting either',
    }
  }
  return {
    verdict: 'not-drivable-here',
    reason: input.fallbackExists
      ? `${DP_FALLBACK_PATH} exists, and the ladder's fallback rung is unconditional: no environment variable reaches `
        + 'it, so no launch of this app on this machine can show the dp-less branch (driven in-process instead, '
        + '`builtin-dp-mcp-no-dp.test.ts`)'
      : 'the app found dp on a rung other than the fallback (NESSY_DP, PATH, or a managed copy): unset or remove it '
        + 'for the launch, and re-run with NESSY_CDP_RS105_EXPECT_NO_DP=1',
  }
}

/** The first `words` words of a sentence, for finding it on a page that may wrap or truncate it. */
export function sentenceOpening(message: string, words = 8): string {
  return message.replace(/\s+/g, ' ').trim().split(' ').slice(0, words).join(' ')
}

/** A tool row for `tool`, however the runtime prefixes it (`mcp__session__x`, `x`, `srv__x`). */
export function toolRow(rows: readonly TranscriptMessage[], tool: string): TranscriptMessage | undefined {
  const pattern = new RegExp(`(^|__)${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  const matches = rows.filter(row => typeof row.toolName === 'string' && pattern.test(row.toolName))
  return matches.find(row => row.toolStatus === 'completed') ?? matches[matches.length - 1]
}

/** The path `remember` says it wrote, out of its own result sentence. */
export function savedMemoryPath(result: string | undefined): string | undefined {
  const match = /Saved memory to\s+(\S+MEMORY\.md)/.exec(result ?? '')
  return match?.[1]
}

/** What may be recorded about an identity-bearing result: its shape, never its text. */
export function resultShape(result: string | undefined): { length: number; hasStdout: boolean } {
  return { length: (result ?? '').length, hasStdout: /stdout:/.test(result ?? '') }
}

type Family = 'pi' | 'claude' | 'codex'

function familyOf(providerType: string): Family | undefined {
  const raw = runtimeOf(providerType)
  return raw === 'anthropic' ? 'claude' : raw === 'codex-runtime' ? 'codex' : raw === 'pi' ? 'pi' : undefined
}

async function readView(session: CdpSession): Promise<BuiltinView> {
  return session.call<BuiltinView>('return await window.electronAPI.getBuiltinDpMcpServers()')
}

async function setEnabled(session: CdpSession, name: string, enabled: boolean): Promise<unknown> {
  return session.call(`
    await window.electronAPI.setBuiltinDpMcpServerEnabled(${JSON.stringify(name)}, ${JSON.stringify(enabled)})
    return 'written'
  `).catch((cause: unknown) => ({ threw: String(cause).slice(0, 200) }))
}

async function workspaceOf(session: CdpSession): Promise<string> {
  const ids = await session.call<string[]>('return (await window.electronAPI.getWorkspaces()).map(w => w.id)')
  const pinned = process.env.NESSY_CDP_WORKSPACE_ID?.trim()
  const id = pinned && ids.includes(pinned) ? pinned : ids[0]
  if (!id) blocked('the app lists no workspace, so there is no capability catalog to read')
  return id
}

async function builtinCatalog(session: CdpSession, workspaceId: string): Promise<Array<{ name: string; state: string }>> {
  return session.call(`
    const cat = await window.electronAPI.capabilities.getCatalog({ workspaceId: ${JSON.stringify(workspaceId)} })
    return (cat.capabilities ?? [])
      .filter(c => c.origin === 'builtin' && c.kind === 'mcp')
      .map(c => ({ name: c.logicalName, state: c.state }))
  `)
}

async function listTools(session: CdpSession, workspaceId: string, name: string): Promise<{ status: string; tools?: unknown[]; reason?: string }> {
  return session.call<{ status: string; tools?: unknown[]; reason?: string }>(`
    return await window.electronAPI.capabilities.listMcpTools(
      { workspaceId: ${JSON.stringify(workspaceId)} }, ${JSON.stringify(`builtin:mcp:${name}`)})
  `).catch((cause: unknown) => ({ status: 'threw', reason: String(cause).slice(0, 200) }))
}

/**
 * One turn with the shared approver underneath (`lib/ask-user.ts`): `mcp__tool_load`
 * and every pool MCP call on pi ask even under `bypassPermissions`, and a card
 * nobody answers is a hang, not a verdict.
 */
async function turn(session: CdpSession, key: SessionKey, prompt: string, timeoutMs = 240_000): Promise<{ added: TranscriptMessage[]; error?: string; approved: number }> {
  const approver = approvePermissionsWhile(session, key.sessionId)
  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const result = await sendPrompt(session, key, prompt, timeoutMs)
    .then(done => ({ added: done.added }), (cause: unknown) => ({ added: [] as TranscriptMessage[], error: String(cause).slice(0, 300) }))
  const approved = await approver.stop()
  const added = await turnRowsSince(() => transcript(session, key), result.added, rowsBefore)
  return { ...result, added, approved }
}

/** One fresh session per family: the dp tool call (A3) and the session server (A4). */
async function sessionArms(run: CaseRun, session: CdpSession, family: Family, card: string, dpReachable: boolean): Promise<void> {
  const key = await freshSession(session, `CDP ${ID} ${family} ${new Date().toISOString().slice(11, 19)}`)
  if (!key.fresh) { run.check(`[${family}] a fresh session`, false, key.reason ?? 'not fresh'); return }
  const bound = await switchRuntime(session, key.sessionId, card)
  if (!bound.ok) { run.check(`[${family}] the session binds to ${card}`, false, bound.error ?? 'no reason'); return }

  const dpTool = modelToolName(CALLED_SERVER, family, CALLED_TOOL)
  // The name the model is handed on all three (SIT-11 A4); the HOST row differs on pi (bare), which `toolRow` absorbs.
  const sessionTool = (tool: string): string => `mcp__session__${tool}`
  if (family === 'pi') {
    // Pi defers every MCP tool: load here, call in the next message (F1.803 also allows the load's next step). The restriction
    // is phrased POSITIVELY - naming a tool and forbidding it trips the Guardian.
    const names = [...(dpReachable ? [dpTool] : []), ...SESSION_TOOLS.map(sessionTool)]
    const selection = await turn(session, key,
      'In this turn use only mcp__tool_search and mcp__tool_load, and no other tool. Step 1: if mcp__tool_load is not '
      + 'in your tool list, reply with exactly MCP-TOOLS-READY and stop. Step 2: call mcp__tool_load ONCE with its '
      + `"names" argument set to exactly these names: ${names.join(', ')}. Step 3: reply with exactly MCP-TOOLS-LOADED. `
      + 'Do not read any files.')
    run.observe(`[${family}] the selection turn`, { reply: lastAssistantText(selection.added).slice(0, 120), approved: selection.approved, error: selection.error })
  }

  // ---- A3: a REAL turn calls a REAL built-in dp tool ----------------------------
  if (dpReachable) {
    const call = await turn(session, key, `Call the tool ${dpTool} with no arguments and paste its raw result back verbatim.`)
    const row = toolRow(call.added, CALLED_TOOL)
    run.observe(`[${family}] A3: the dp tool row (shape only - it carries an identity)`, {
      asked: dpTool, row: row?.toolName, status: row?.toolStatus, result: resultShape(row?.toolResult), approved: call.approved, error: call.error,
    })
    run.check(`[${family}] A3 — a real turn called ${CALLED_SERVER}'s ${CALLED_TOOL} and a dp subprocess answered`,
      row?.toolStatus === 'completed' && resultShape(row.toolResult).hasStdout,
      `row ${String(row?.toolName)} status ${String(row?.toolStatus)}, result ${JSON.stringify(resultShape(row?.toolResult))} `
      + `(attempted: ${row ? 'yes' : 'no'}; cards answered: ${call.approved})`)
  }

  // ---- A4: the session MCP server ---------------------------------------------
  const token = `RS105-REMEMBER-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
  for (const tool of SESSION_TOOLS) {
    const prompt = tool === 'remember'
      ? `Call the tool ${sessionTool(tool)} with the memory argument set to the exact text ${token} and the scope argument `
        + 'set to session, and paste its raw result back verbatim.'
      : `Call the tool ${sessionTool(tool)} with no arguments and paste its raw result back verbatim.`
    const call = await turn(session, key, prompt)
    const row = toolRow(call.added, tool)
    run.observe(`[${family}] A4: ${tool}`, {
      row: row?.toolName, status: row?.toolStatus, result: (row?.toolResult ?? '').slice(0, 160), approved: call.approved, error: call.error,
    })
    run.check(`[${family}] A4 — the session MCP server answered ${tool}`, row?.toolStatus === 'completed',
      `row ${String(row?.toolName)} status ${String(row?.toolStatus)}; turn error ${String(call.error)}`)
    if (tool !== 'remember') continue
    // The DISK detector: the file the tool names, inside this profile, under this session.
    const written = savedMemoryPath(row?.toolResult)
    const path = written && isAbsolute(written) ? written : undefined
    const text = path && existsSync(path) ? readFileSync(path, 'utf8') : ''
    run.observe(`[${family}] A4: the MEMORY.md remember named`, { path, underProfile: path?.startsWith(resolve(configDir())), underSession: path?.includes(key.sessionId) })
    run.check(`[${family}] A4 — remember wrote its token into this session's MEMORY.md, read off disk`,
      text.includes(token) && path !== undefined && path.includes(key.sessionId) && path.startsWith(resolve(configDir())),
      `path ${String(path)}; token present on disk: ${text.includes(token)} - a session-scoped write lands under `
      + `<configDir>/…/${key.sessionId}/data/MEMORY.md`)
  }
}

/** The dp-less branch, on a machine that reaches it (F1.157). */
async function dpLessArm(run: CaseRun, session: CdpSession, view: BuiltinView, definitions: readonly BuiltinDefinition[]): Promise<void> {
  run.check('F1.157 — without dp every server is still listed', view.servers.length === definitions.length,
    `${view.servers.length} rows against ${definitions.length} definitions`)
  const diagnostic = view.diagnostics.find(entry => entry.code === 'builtin_dp_mcp.dp_not_found')
  run.check('F1.157 — the view names why nothing can start', diagnostic !== undefined, JSON.stringify(view.diagnostics))
  const first = view.servers[0]
  if (first) {
    await setEnabled(session, first.name, !first.enabled)
    const after = await readView(session)
    await setEnabled(session, first.name, first.enabled)
    run.check('F1.157 — the switch does not refuse: the write reads back with dp missing',
      after.servers.find(row => row.name === first.name)?.enabled === !first.enabled,
      `wrote ${String(!first.enabled)}, read ${String(after.servers.find(row => row.name === first.name)?.enabled)}`)
  }
  if (!diagnostic || !first) return
  const key = `builtin:mcp:${first.name}`
  await session.call(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', {
      detail: { route: 'sources/mcp/source/' + encodeURIComponent(${JSON.stringify(key)}) }, bubbles: true }))
    return null
  `)
  const opening = sentenceOpening(diagnostic.message)
  const text = await waitFor(
    async () => (await selectorText(session, 'main, [role="main"], body').catch(() => [] as string[])).join(' '),
    page => page.includes(first.name) && page.includes(opening),
    { timeoutMs: 15_000, intervalMs: 1_000, label: 'the detail page to render' },
  ).catch(async () => (await selectorText(session, 'main, [role="main"], body').catch(() => [] as string[])).join(' '))
  run.observe('F1.157 — the detail page a built-in row opens', { key, rendered: text.includes(first.name), opening })
  run.check('F1.157 — the detail page tells a user WITHOUT dp why the server cannot start',
    text.includes(opening),
    'the dp_not_found sentence is on no page this row opens: the panel carries it in row data only, and the detail '
    + 'page renders the server capability summary, which never looks for dp (proposed row, WJ-jj 2026-09-23)')
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the model turns this case drives')
  if (contaminated !== undefined) blocked(contaminated)

  // The DENOMINATOR - imported at run time so the harness's unit arms never pay the pool's module graph.
  const { BUILTIN_DP_MCP_SERVERS } = await import('@nessy-agent/shared/mcp')
  const definitions: BuiltinDefinition[] = BUILTIN_DP_MCP_SERVERS.map(entry => ({ name: entry.name, defaultEnabled: entry.defaultEnabled }))

  // ---- A1: the set, on two readers ------------------------------------------
  const view = await readView(session)
  let stored: Record<string, unknown> = {}
  try {
    stored = (JSON.parse(readFileSync(resolve(configDir(), 'config.json'), 'utf8')) as { builtinDpMcpServers?: { enabled?: Record<string, unknown> } })
      .builtinDpMcpServers?.enabled ?? {}
  } catch { /* no stored preference: every server is on its default */ }
  const roster = compareBuiltinRoster(view.servers, definitions, stored)
  run.observe('A1 — the view', { available: view.available, count: view.servers.length, enabled: view.servers.filter(row => row.enabled).map(row => row.name), stored })
  run.check(`A1 — the view lists exactly the ${definitions.length} shipped definitions, in order`,
    roster.missing.length === 0 && roster.extra.length === 0 && roster.orderMatches,
    `missing ${roster.missing.join(',') || '-'}; extra ${roster.extra.join(',') || '-'}; order matches ${roster.orderMatches}`)
  run.check('A1 — every defaultEnabled is the definition\'s', roster.defaultMismatch.length === 0, roster.defaultMismatch.join(','))
  run.check('A1 — every server the user never touched sits at its default', roster.offDefault.length === 0, roster.offDefault.join(','))
  run.observe('A1 — the shipped posture', { defaultEnabled: definitions.filter(entry => entry.defaultEnabled).map(entry => entry.name) })
  const workspaceId = await workspaceOf(session)
  const catalog = await builtinCatalog(session, workspaceId)
  const byName = new Map(catalog.map(row => [row.name, row.state] as const))
  const catalogDrift = view.servers.filter(row => (byName.get(row.name) === 'active') !== row.enabled).map(row => `${row.name}=${String(byName.get(row.name))}`)
  run.check('A1 — the capability catalog carries one builtin row per definition', definitions.every(entry => byName.has(entry.name)),
    `catalog builtin rows: ${catalog.length}`)
  run.check('A1 — the catalog\'s state agrees with the view\'s switch', catalogDrift.length === 0, catalogDrift.join(', '))

  // ---- F1.157: the dp-less branch -------------------------------------------
  const branch = dpLessBranch({ available: view.available, fallbackExists: existsSync(DP_FALLBACK_PATH), expectNoDp: process.env.NESSY_CDP_RS105_EXPECT_NO_DP === '1' })
  run.observe('F1.157 — the dp-less branch on this machine', branch)
  run.check('F1.157 — the operator\'s "no dp here" agrees with the app', branch.verdict !== 'contradiction', branch.reason)
  if (branch.verdict === 'drive') await dpLessArm(run, session, view, definitions)

  // ---- the cards ---------------------------------------------------------------
  const cards = new Map<Family, string>()
  for (const card of await listConnections(session)) {
    const family = familyOf(card.providerType)
    if (family && !cards.has(family)) cards.set(family, card.slug)
  }
  const wanted = (process.env.NESSY_CDP_RS105_FAMILIES ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
  const chosen: Family[] = wanted.length > 0
    ? wanted.filter((family): family is Family => cards.has(family as Family))
    : (['claude', 'codex', 'pi'] as const).filter(family => cards.has(family)).slice(0, 1)
  run.observe('the runtime(s) A3/A4 run on', { cards: Object.fromEntries(cards), chosen })
  if (chosen.length === 0) blocked('this profile lists no pi, claude-runtime or codex-runtime card for the turn arms')

  // ---- A2: off stays off; the Settings write turns it on - twice -----------------
  const servers = [CALLED_SERVER, BREADTH_SERVER]
  const before = new Map(servers.map(name => [name, view.servers.find(row => row.name === name)?.enabled] as const))
  const turnedOn: string[] = []
  let dpReachable = false
  try {
    if (view.available) {
      for (const name of servers) {
        if (before.get(name) !== false) {
          run.check(`A2 — ${name} starts OFF (the control needs a refusal to compare against)`, false,
            `the view says enabled=${String(before.get(name))}; switch it off in Settings and re-run`)
          continue
        }
        const refused = await listTools(session, workspaceId, name)
        await setEnabled(session, name, true)
        turnedOn.push(name)
        const answered = await waitFor(async () => listTools(session, workspaceId, name), result => result.status === 'ok',
          { timeoutMs: 90_000, intervalMs: 3_000, label: `${name} to connect` }).catch(async () => listTools(session, workspaceId, name))
        const catalogState = (await builtinCatalog(session, workspaceId)).find(row => row.name === name)?.state
        run.observe(`A2 — ${name}`, { before: refused, after: { status: answered.status, tools: answered.tools?.length, reason: answered.reason }, catalogState })
        run.check(`A2 — ${name}: refused while off, connected with tools after the Settings write`,
          refused.status !== 'ok' && answered.status === 'ok' && (answered.tools?.length ?? 0) > 0,
          `before ${JSON.stringify(refused)}; after ${answered.status} with ${String(answered.tools?.length)} tools`)
        if (name === CALLED_SERVER) dpReachable = answered.status === 'ok'
      }
    } else {
      run.observe('A2/A3 — not drivable', 'dp is not available on this machine; the connect and the call need it')
    }

    for (const family of chosen) await sessionArms(run, session, family, cards.get(family)!, dpReachable)
  } finally {
    for (const name of turnedOn) {
      run.observe(`cleanup — ${name} restored to ${String(before.get(name))}`, await setEnabled(session, name, before.get(name) ?? false))
    }
  }

  // ---- A5 ---------------------------------------------------------------------
  run.observe('A5 — the bundled bridge-mcp-server', 'NOT drivable by construction: no runtime consumes it (F1.152); '
    + 'codex\'s own host-callback bridge is exercised by every codex MCP call above')
}

if (import.meta.main) await main(ID, TITLE, drive)
