/**
 * MCP-R1 — P6.25's live half: does the closed `claude` binary ask an `sdk`-type
 * MCP server for its resources?
 *
 * ## What was already settled offline, so this case does not re-ask it
 *
 * P6.25 concluded `cannot-at-this-seam` from `CreateSdkMcpServerOptions`, which
 * declares only `name`, `version`, `instructions`, `tools`, `alwaysLoad`. W5-d
 * REFUTED that at the seam: the SDK's config type is
 * `McpSdkServerConfigWithInstance = McpSdkServerConfig & { instance: McpServer }`
 * — an arbitrary caller-built server — `Query.connectSdkMcpServer` calls
 * `instance.connect(transport)`, and the CLI reaches it through one
 * `subtype: "mcp_message"` control request that forwards whatever JSON-RPC
 * message it carries, with **no method allowlist anywhere**. So an instance we
 * built with resources registered would be asked and would answer.
 *
 * What stayed a NULL is the binary's own behaviour: whether it ISSUES
 * `resources/list` to an `sdk`-type server at all. That is not a read — the
 * binary is closed — so it is here.
 *
 * ## Why arm 1 blocks rather than fails, and what would unblock it
 *
 * The shipped artefact registers every source proxy through
 * `createSdkMcpServer` (`claude-agent.ts`, `createSourceProxyServers`), and that
 * factory cannot carry resources. So there is no `sdk`-type server in the
 * product declaring a resources capability for the binary to ask about, and an
 * absence measured against it would say nothing about the binary. **BLOCKED with
 * the precondition named** is the honest verdict, and the precondition is one
 * code change: build the `McpServer` directly and pass
 * `{ type: 'sdk', name, instance }`. An absence finding with no positive control
 * on the same rig is not evidence (AGENTS.md), and there is no control to have
 * until that instance exists.
 *
 * ## Arm 2 is the half that IS measurable today, and it is the residue P6.25
 * narrowed to
 *
 * On claude-runtime a resource is reachable by the USER — `@server:uri` mentions
 * and `custom:mcp:` prompts both run in `BaseAgent`, with no runtime check — and
 * never by the MODEL, because `list_mcp_resources` / `read_mcp_resource` are
 * `visibility: 'pi-only'` and the Claude backend asks `getSessionToolDefs` for no
 * projection. That is checkable on the shipped build from the runtime's own
 * transcript: ask for a resource listing and read what tool the child was
 * actually given. The SDK's own alias map names THREE native tools
 * (`ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool`), so
 * the arm records whether any of them appears as well — a native route we do not
 * supply would change the verdict and is exactly the thing a read cannot settle.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, exitCodeFor, runCase, type CaseRun } from '../lib/report.ts'
import { configDir, type RuntimeSessionEntry } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ID = 'MCP-R1'
const TITLE = 'Does the closed claude binary ask an sdk-type MCP server for resources?'

const TURN_TIMEOUT_MS = 300_000
const CDP_COMMAND_TIMEOUT_MS = 420_000

/** Ours (`session-tools-core`) and the SDK's own three native aliases. */
const RESOURCE_TOOL_NAMES = [
  'list_mcp_resources', 'read_mcp_resource',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
] as const

function readClaudeTranscriptsSince(workspaceId: string, sinceMs: number): { files: string[]; entries: RuntimeSessionEntry[] } {
  const root = join(configDir(), 'workspaces', workspaceId, 'claude-config', 'projects')
  if (!existsSync(root)) return { files: [], entries: [] }
  const files: string[] = []
  for (const dir of readdirSync(root)) {
    const child = join(root, dir)
    if (!statSync(child).isDirectory()) continue
    for (const name of readdirSync(child)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(child, name)
      if (statSync(file).mtimeMs >= sinceMs - 1_000) files.push(file)
    }
  }
  const entries: RuntimeSessionEntry[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { entries.push({ type: '', text: '', raw: JSON.parse(trimmed) as Record<string, unknown> }) } catch { /* partial line */ }
    }
  }
  return { files, entries }
}

/** `tool_use` blocks only — a substring match would hit this case's own prompt. */
function resourceToolUses(entries: RuntimeSessionEntry[]): string[] {
  const found: string[] = []
  for (const entry of entries) {
    const message = entry.raw.message as Record<string, unknown> | undefined
    const content = message && Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_use') continue
      const name = typeof b.name === 'string' ? b.name : ''
      if (RESOURCE_TOOL_NAMES.some(candidate => name.includes(candidate))) found.push(name)
    }
  }
  return found
}

async function body(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, via: app.via })
  if (app.kind !== 'packaged') {
    blocked(`this row is owed on the SHIPPED artefact; the CDP target is ${app.kind} (${app.targetUrl})`)
  }

  const connections = await listConnections(session)
  const claude = connections.find(row => runtimeOf(row.providerType) === 'anthropic')
  if (!claude) {
    blocked(
      'no claude-runtime connection in this config dir. '
      + `The app lists: ${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  const key = await freshSession(session, `${ID} mcp resources`)
  run.require('a fresh session was created', key.fresh, key.reason ?? '')
  const moved = await switchRuntime(session, key.sessionId, claude.slug)
  run.require(`the session moved onto ${claude.slug}`, moved.ok, moved.error ?? '')
  await waitForConnection(session, key.sessionId, claude.slug).catch(() => undefined)
  run.observe('connection', { slug: claude.slug, providerType: claude.providerType })

  // ---- arm 2, the measurable half ---------------------------------------
  const startedMs = Date.now()
  const turn = await sendPrompt(
    session,
    key,
    'List the MCP resources available to you, using whatever tool you have for that. '
    + 'If you have no tool that can list MCP resources, reply with exactly: NO-RESOURCE-TOOL',
    TURN_TIMEOUT_MS,
  )
  const reply = lastAssistantText(turn.added)
  const log = readClaudeTranscriptsSince(key.workspaceId, startedMs)
  const toolUses = resourceToolUses(log.entries)
  const hostRows = turn.added.filter(m => m.toolName && RESOURCE_TOOL_NAMES.some(n => m.toolName!.includes(n))).map(m => m.toolName)

  run.observe('arm 2 reading', {
    replyExcerpt: reply.slice(0, 300),
    sdkResourceToolUses: toolUses,
    hostResourceToolRows: hostRows,
    transcriptFiles: log.files.length,
    transcriptEntries: log.entries.length,
    allSdkToolUses: log.entries.length,
  })

  // The transcript existing at all is the positive control: without it, "no
  // resource tool_use" would be true of a turn that never reached the child.
  run.check(
    "the runtime's own transcript recorded this turn (the positive control)",
    log.entries.length > 0,
    `${log.entries.length} entries in ${log.files.length} file(s) — without these the absence below is vacuous`,
  )

  run.check(
    'no MCP-resource tool reached the model on claude-runtime (P6.25 residue, as measured offline)',
    toolUses.length === 0 && hostRows.length === 0,
    toolUses.length === 0 && hostRows.length === 0
      ? 'the model was offered no resource tool, which is what the pi-only visibility predicts'
      : `REFUTED live: ${JSON.stringify([...toolUses, ...hostRows])} — the model DOES have a resource route here, `
        + 'so the offline verdict is wrong and the SDK alias map is the place to look',
  )

  // ---- arm 1, the question the artefact cannot yet answer ----------------
  run.observe('arm 1 (does the binary ISSUE resources/list to an sdk-type server?)', 'not askable on this artefact')
  blocked(
    'ARM 1 UNRUNNABLE, precondition named: the shipped artefact registers every source proxy through '
    + '`createSdkMcpServer`, which cannot carry resources, so no `sdk`-type server declares a resources '
    + 'capability for the binary to ask about. An absence measured against that says nothing about the '
    + 'binary. Unblocked by ONE code change — build the `McpServer` directly and pass '
    + "`{ type: 'sdk', name, instance }` in `createSourceProxyServers` — after which this arm reads the "
    + 'instance\'s own request log for a `resources/list`. Arm 2 above ran and is recorded.',
  )
}

if (import.meta.main) {
  const result = await runCase(ID, TITLE, body, { timeoutMs: CDP_COMMAND_TIMEOUT_MS })
  process.exit(exitCodeFor(result.status))
}

export { ID, TITLE, body }
