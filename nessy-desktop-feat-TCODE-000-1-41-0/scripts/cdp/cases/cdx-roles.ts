/**
 * CDX-ROLES — live proof that a Nessy agent DISPATCHES as a codex agent role.
 *
 * `7bf2c84d6` built the mechanism ([agents.<role>] + one role layer per agent)
 * and `b6501c093` wired it (`CodexAgent.createRuntime` passes
 * `piRuntimeAgentDefinitions`, `AGENT_DEFINITION_RUNTIMES` admits
 * `codex-runtime`). Both were proven against the shipped binary's CONFIG
 * surface only; nothing had shown a codex session actually spawning one of our
 * agents. This case is that gate, verbatim from VERIFICATION-STATE.md.
 *
 * ## The unfakeable observation
 *
 * The parent is asked to spawn `probe-role` and report the child's reply. The
 * child's codeword exists ONLY in the role layer this build wrote
 * (`<CODEX_HOME>/agent-roles/probe-role.toml`, sourced from
 * `<configDir>/agents/probe-role.md`); the parent model sees only
 * `Available roles:` with role DESCRIPTIONS, and the description does not
 * carry it. So a reply carrying the codeword proves the role file reached a
 * spawned child — unless the parent read it off disk, which is why the turn's
 * transcript is scanned for command/file rows touching the agents catalog or
 * the codex home, and why the prompt forbids reading files.
 *
 * ## The three controls (not decoration — the claim is void without them)
 *
 * - **A — the registry is real.** A spawn with a name nobody declared
 *   (`nessy-not-declared-7Q4X`) must be refused with codex's native
 *   `unknown agent_type` error. Without this, "codex accepted our name" means
 *   nothing: it would have accepted any.
 * - **B — deny-by-design works and its diagnostic is wired.** `probe-denied`
 *   declares `tools: [Read, Grep]`, which `buildCodexAgentRoles` must refuse
 *   (codex has no per-role tool policy), so the same `unknown agent_type`
 *   error — AND the session log must carry "is not declared as a codex agent
 *   role: it declares a tool grant". A missing line means the `onDiagnostic`
 *   half is dead.
 * - **C — the landmine did not fire.** A role-name collision with
 *   `agents.enabled` makes the app-server discard the ENTIRE config.toml and
 *   run on codex defaults with no model_provider — failing at the gateway, not
 *   at spawn. The log window must be free of `Invalid configuration; using
 *   defaults.` and `Ignoring malformed agent role definition`; the positive
 *   control for this absence is the turn completing against the gateway AND
 *   `[agents.probe-role]` sitting in the live config.toml.
 *
 * ## Secondary confirmation, while the session is alive
 *
 * CODEX_HOME is a `mkdtemp` under `<config>/codex-home` (F1.652; else the OS tmpdir), deleted on every teardown
 * path — so the live config.toml and `agent-roles/` listing are read DURING
 * the run: `[agents.probe-role]` present, `probe-denied` absent from both the
 * config and the role dir. Used to explain a failure, never instead of the
 * codeword.
 *
 * ## Preconditions (two markdown files, and they follow NESSY_CONFIG_DIR)
 *
 * - `<configDir>/agents/probe-role.md` — has a description, body carries a
 *   fresh `ZEPHYR-<8 hex>` codeword, and NO `tools:`/`disallowedTools:`/
 *   `permissionMode:` (each would deny the role by design).
 * - `<configDir>/agents/probe-denied.md` — same, WITH `tools: [Read, Grep]`.
 * - A codex-runtime connection, bound + trusted project, app launched with its
 *   stdout in `NESSY_CDP_APP_LOG` (default `/tmp/app.log`).
 *
 * `<configDir>` is `NESSY_CONFIG_DIR` or `~/.nessy-agent`, resolved the way
 * `packages/shared/src/config/paths.ts` resolves it. This case used to hardcode
 * the home path, so a run against a fixture config dir looked for the probes in
 * a directory the app under test was not reading. `bun run
 * scripts/cdp/fixtures/agent-surfaces.ts` writes both files, mints the codeword
 * and prints it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { bundleFiles, resolveAppUnderTest, symbolsIn } from '../lib/bundle.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { codexHomeRoots, listCodexHomes } from '../lib/codex-session-log.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  sessionCommand,
  transcript,
  waitFor,
  type TranscriptMessage,
} from '../lib/state.ts'

const ID = 'CDX-ROLES'
const TITLE = 'A Nessy agent dispatches as a codex agent role: the spawned child answers with the role file\'s codeword, under three controls'

/**
 * `<configDir>/agents` — and `configDir()` honours `NESSY_CONFIG_DIR`, exactly
 * as `packages/shared/src/config/paths.ts` does.
 *
 * This was `join(homedir(), '.nessy-agent', 'agents')`, which is the operator's
 * live dir and ONLY that. A run against a fixture config dir — the same
 * `NESSY_CONFIG_DIR=<root>/config` launch MCP-W1..3 and the RTS wave already
 * use — read the wrong directory and blocked on a file the app under test would
 * never have loaded anyway. The probe agents are two markdown files; put them
 * wherever the app was launched with.
 */
const AGENTS_DIR = join(configDir(), 'agents')
const APP_LOG = process.env.NESSY_CDP_APP_LOG ?? '/tmp/app.log'
const UNDECLARED = 'nessy-not-declared-7Q4X'

/** The wiring must be IN the bundle the app loaded — value strings, the
 * constant names do not survive esbuild. */
const WIRING_SYMBOLS = ['agent-roles', 'runtimeDispatchesAgentDefinitions', 'isForeignThreadNotification']

interface Probe {
  file: string
  frontmatter: string
  body: string
}

function readProbe(name: string): Probe {
  const file = join(AGENTS_DIR, `${name}.md`)
  if (!existsSync(file)) {
    blocked(`missing probe agent ${file} — create it per VERIFICATION-STATE.md § "Живое доказательство ролей агентов на Codex" before running`)
  }
  const text = readFileSync(file, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!match) blocked(`${file} has no frontmatter block`)
  return { file, frontmatter: match[1]!, body: match[2]! }
}

/** Every rollout-*.jsonl under `<home>/sessions/`, walked without fs.recursive. */
function rolloutFiles(home: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) files.push(path)
    }
  }
  walk(join(home, 'sessions'))
  return files.sort()
}

/** Newest codex homes created since `sinceMs`, searched where mkdtemp puts them (F1.652: the host root, then the temp dirs). */
function liveCodexHomes(sinceMs: number): string[] {
  const roots = [...new Set([...codexHomeRoots(), '/tmp'])]
  const homes: string[] = []
  for (const path of listCodexHomes(roots)) {
    try {
      if (statSync(path).mtimeMs >= sinceMs) homes.push(path)
    } catch { /* torn down between readdir and stat */ }
  }
  return homes
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const caseStart = Date.now()

  // ---- 0. the bundle the app loaded carries the wiring ----------------------
  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  const bundles = bundleFiles(app)
  const report = symbolsIn(bundles.main, WIRING_SYMBOLS)
  run.observe('bundle-freshness', report)
  if (report.missing.length > 0) {
    blocked(
      `stale bundle: ${report.bundle} at ${report.path} is missing ${JSON.stringify(report.missing)} — `
      + 'it predates b6501c093. `bun run electron:build`, relaunch, re-run.',
    )
  }

  // ---- 1. the probes are the shapes the gate specifies ----------------------
  const probeRole = readProbe('probe-role')
  const probeDenied = readProbe('probe-denied')
  const codeword = /ZEPHYR-[0-9a-f]{8}/.exec(probeRole.body)?.[0]
  if (!codeword) blocked(`${probeRole.file} body carries no ZEPHYR-<8 hex> codeword`)
  const disqualifiers = /^(tools|disallowedTools|permissionMode)\s*:/m
  if (disqualifiers.test(probeRole.frontmatter)) {
    blocked(`${probeRole.file} frontmatter carries a role-disqualifying key — the positive probe must have none`)
  }
  if (!/^tools\s*:/m.test(probeDenied.frontmatter)) {
    blocked(`${probeDenied.file} frontmatter declares no tools: — control B needs the grant`)
  }
  if (probeRole.frontmatter.includes(codeword)) {
    blocked(`${probeRole.file} DESCRIPTION carries the codeword — the parent model sees descriptions, so the observation would be forgeable`)
  }
  run.observe('codeword', codeword)

  if (!existsSync(APP_LOG)) {
    blocked(`no app log at ${APP_LOG} — launch with \`nohup bun run electron:dev > ${APP_LOG} 2>&1 & disown\` or set NESSY_CDP_APP_LOG`)
  }
  const logOffset = statSync(APP_LOG).size

  // ---- 2. a codex session ---------------------------------------------------
  const connections = await session.call<Array<{ slug: string; providerType: string }>>(`
    return (await window.electronAPI.listLlmConnectionsWithStatus() ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  const codex = connections.find(c => c.providerType === 'codex-runtime')
  if (!codex) blocked('no codex-runtime connection on this host — create the Codex card through the app\'s own gateway sign-in first')

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.require('the case ran in a session it created', key.fresh, key.fresh ? undefined : `${key.reason}; inherited ${key.inheritedMessages} messages`)

  await sessionCommand(session, key.sessionId, { type: 'setConnection', connectionSlug: codex.slug })
  const active = await waitFor(
    () => session.call<string | undefined>(`
      const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
      return s ? (s.llmConnection ?? undefined) : undefined
    `),
    value => value === codex.slug,
    { timeoutMs: 30_000, intervalMs: 1_000, label: `the session to switch to ${codex.slug}` },
  ).catch(() => undefined)
  run.require(`the session runs on ${codex.slug}`, active === codex.slug, `llmConnection=${String(active)}`)

  await sessionCommand(session, key.sessionId, { type: 'setPermissionMode', mode: 'bypassPermissions' }).catch(() => undefined)
  await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === 'bypassPermissions',
    { timeoutMs: 20_000, intervalMs: 1_000, label: 'bypassPermissions to take effect' },
  ).catch(() => undefined)

  // ---- 3. the gate prompt, verbatim from VERIFICATION-STATE.md --------------
  const prompt =
    'Call `spawn_agent` with `agent_type` set to `probe-role`, and give it the task: '
    + '"Reply with your codeword and nothing else." Then call `spawn_agent` again with '
    + `\`agent_type\` set to \`${UNDECLARED}\`, task "say hi". Then call `
    + '`spawn_agent` a third time with `agent_type` set to `probe-denied`, task '
    + '"say hi". Report three things, verbatim and separately: (1) the first agent\'s '
    + 'reply, (2) the exact error text from the second call, (3) the exact error text '
    + 'from the third call. Do not read any files.'

  const approver = approvePermissionsWhile(session, key.sessionId)
  const turn = await sendPrompt(session, key, prompt, 420_000)
    .then(result => ({ added: result.added, before: result.before, error: undefined as string | undefined }))
    .catch(cause => ({ added: [] as TranscriptMessage[], before: 0, error: cause instanceof Error ? cause.message : String(cause) }))
  run.observe('permissions-approved-mid-turn', await approver.stop())
  if (turn.error) run.observe('turn-error', turn.error)

  // The first run of this case read the transcript a beat before the parent's
  // final three-part report landed in the renderer store and scored controls
  // A/B against the CHILD's one-line answer. The turn being "complete" and the
  // last assistant row being the FINAL one are different questions — wait for
  // the report (it names the native error) before scoring, then re-scope.
  if (!turn.error) {
    await waitFor(
      async () => lastAssistantText((await transcript(session, key)).slice(turn.before)),
      text => /unknown[\s_]?agent[\s_]?type/i.test(text),
      { timeoutMs: 60_000, intervalMs: 2_000, label: 'the parent\'s final report to reach the transcript' },
    ).catch(() => undefined)
    turn.added = (await transcript(session, key)).slice(turn.before)
  }

  // ---- 4. secondary confirmation while the session is alive -----------------
  // Read BEFORE any assertion can end the case: the mkdtemp home dies with the
  // session, and a failure explained by the live config beats a bare failure.
  const homes = liveCodexHomes(caseStart)
  const confirmations = homes.map(home => {
    const configPath = join(home, 'config.toml')
    const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
    const roleDir = join(home, 'agent-roles')
    const roleFiles = existsSync(roleDir) ? readdirSync(roleDir).sort() : []
    return { home, roleFiles, hasProbeRole: config.includes('[agents.probe-role]'), hasProbeDenied: config.includes('[agents.probe-denied]') }
  })
  run.observe('live-codex-homes', confirmations)
  const live = confirmations.find(c => c.hasProbeRole)
  run.check(
    'the live config.toml declares [agents.probe-role]',
    Boolean(live),
    live ? `${live.home} roles=${JSON.stringify(live.roleFiles)}` : `no codex home since case start carries the block; searched ${codexHomeRoots().join(', ')} and /tmp`,
  )
  run.check(
    'probe-denied reached neither the config nor the role dir',
    Boolean(live) && !live!.hasProbeDenied && !live!.roleFiles.includes('probe-denied.toml'),
    live ? undefined : 'no live home to read',
  )
  const roleToml = live ? readFileSync(join(live.home, 'agent-roles', 'probe-role.toml'), 'utf8') : ''
  run.check(
    'the role layer carries the codeword the child must answer with',
    roleToml.includes(codeword),
    roleToml ? undefined : 'probe-role.toml unreadable',
  )

  // ---- 5. the observation and controls A/B ----------------------------------
  const reply = lastAssistantText(turn.added)
  run.observe('reply', reply.slice(0, 1500) || '(no assistant message)')

  run.check(
    'THE OBSERVATION: the spawned child answered with the role file\'s codeword',
    reply.includes(codeword),
    reply.includes(codeword) ? `codeword=${codeword}` : `reply does not carry ${codeword}`,
  )

  const unknownAgentType = /unknown[\s_]?agent[\s_]?type/i
  run.check(
    'control A: the undeclared name was refused with codex\'s native unknown agent_type error',
    reply.includes(UNDECLARED) && unknownAgentType.test(reply),
    `undeclared-name-mentioned=${reply.includes(UNDECLARED)} error-phrase=${unknownAgentType.test(reply)}`,
  )
  run.check(
    'control B (spawn half): probe-denied was refused the same way — the role was never created',
    reply.includes('probe-denied') && unknownAgentType.test(reply),
    `probe-denied-mentioned=${reply.includes('probe-denied')}`,
  )

  // ---- 5b. codex's OWN record of the three calls ----------------------------
  // The rollout files under `<CODEX_HOME>/sessions/` are written by
  // codex-app-server itself — the detector the product promises, not one we
  // hope is populated. The parent rollout must carry the three spawn_agent
  // function_calls and the two NATIVE error outputs verbatim; the child rollout
  // must show the role file's instructions arriving as its developer message.
  const rollouts = live ? rolloutFiles(live.home) : []
  const parsed = rollouts.map(file => ({
    file,
    lines: readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) as Record<string, unknown> } catch { return {} }
    }),
  }))
  const flat = (entry: { file: string; lines: Record<string, unknown>[] }): string => JSON.stringify(entry.lines)
  const parent = parsed.find(entry => flat(entry).includes('"spawn_agent"'))
  const child = parsed.find(entry => entry !== parent && flat(entry).includes(codeword))
  run.observe('rollouts', parsed.map(entry => ({ file: entry.file, isParent: entry === parent, isChild: entry === child })))

  const parentText = parent ? flat(parent) : ''
  run.check(
    'codex\'s own rollout records spawn_agent(probe-role) and the child\'s spawned thread',
    Boolean(parent) && parentText.includes('probe-role') && Boolean(child),
    parent ? undefined : 'no rollout carries a spawn_agent call',
  )
  run.check(
    'control A, native record: the rollout output is exactly unknown agent_type \'nessy-not-declared-7Q4X\'',
    parentText.includes(`unknown agent_type '${UNDECLARED}'`),
  )
  run.check(
    'control B, native record: the rollout output is exactly unknown agent_type \'probe-denied\'',
    parentText.includes("unknown agent_type 'probe-denied'"),
  )
  const childDeveloper = child
    ? child.lines.some(line => {
        const payload = (line as { payload?: { type?: string; role?: string; content?: Array<{ text?: string }> } }).payload
        return payload?.type === 'message' && payload.role === 'developer'
          && (payload.content ?? []).some(part => (part.text ?? '').includes(codeword))
      })
    : false
  run.check(
    'the role file\'s instructions arrived as the CHILD\'s developer message — the dispatch path, not a lucky echo',
    childDeveloper,
    child ? undefined : 'no child rollout carries the codeword',
  )
  const parentToolCalls = parent
    ? parent.lines.flatMap(line => {
        const payload = (line as { payload?: { type?: string; name?: string } }).payload
        return payload?.type === 'function_call' && payload.name ? [payload.name] : []
      })
    : []
  // Wire names as the rollout records them (`wait_agent` observed live 2026-08-13).
  const collabTools = new Set(['spawn_agent', 'wait_agent', 'wait', 'send_input', 'close_agent', 'resume_agent'])
  run.observe('parent-tool-calls', parentToolCalls)
  run.check(
    'the parent called ONLY collab tools — no shell or file tool could have carried the codeword',
    parentToolCalls.length > 0 && parentToolCalls.every(name => collabTools.has(name)),
    `calls=${JSON.stringify(parentToolCalls)}`,
  )

  // ---- 6. the codeword did not travel through a file read -------------------
  // Codex command executions and file changes DO surface as transcript rows
  // (event-adapter.ts maps commandExecution/fileChange), so a parent that
  // shelled the codeword out of the role file or the catalog is visible here.
  const pathMarkers = ['nessy-agent/agents', 'nessy-codex-home-', 'probe-role.md', 'probe-role.toml', 'agent-roles/']
  const leaks = turn.added.flatMap(m => {
    const surface = JSON.stringify({ content: m.content, toolName: m.toolName, toolInput: m.toolInput, toolResult: m.toolResult })
    return pathMarkers.filter(marker => surface.includes(marker)).map(marker => ({ id: m.id, role: m.role, tool: m.toolName, marker }))
  })
  run.observe('transcript-tool-rows', turn.added.filter(m => m.toolName).map(m => ({ tool: m.toolName, status: m.toolStatus })))
  run.check(
    'no transcript row touches the agents catalog or the codex home — the codeword came through the spawn',
    leaks.length === 0,
    leaks.length === 0 ? undefined : `leak surfaces: ${JSON.stringify(leaks)}`,
  )

  // ---- 7. the log window: control B's diagnostic, control C's absences ------
  const logWindow = readFileSync(APP_LOG, 'utf8').slice(logOffset)
  const denyLine = logWindow.split('\n').find(line =>
    line.includes('is not declared as a codex agent role') && line.includes('probe-denied'))
  run.check(
    'control B (diagnostic half): the session log names probe-denied\'s dropped grant',
    Boolean(denyLine) && denyLine!.includes('tool grant'),
    denyLine ? denyLine.trim().slice(0, 300) : 'no deny diagnostic in the log window — the onDiagnostic half is dead',
  )
  const mineTripped = ['Invalid configuration; using defaults.', 'Ignoring malformed agent role definition']
    .filter(marker => logWindow.includes(marker))
  run.check(
    'control C: the config landmine did not fire (positive control: the turn ran against the gateway and the config carries the role)',
    mineTripped.length === 0,
    mineTripped.length === 0 ? undefined : `log window carries ${JSON.stringify(mineTripped)}`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
