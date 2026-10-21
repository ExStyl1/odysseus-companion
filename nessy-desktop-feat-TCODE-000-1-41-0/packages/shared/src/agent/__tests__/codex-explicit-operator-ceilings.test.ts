/**
 * P3.348 and P3.347 — the producer half of THREE host ceilings that bound on Pi
 * and claude and vanished on codex, and the one rule all three now follow: only
 * a value the operator set EXPLICITLY is forwarded.
 *
 * P3.348 is the tool-output ceiling reaching codex's own
 * `tool_output_token_limit`; P3.347 is the pair of subagent ceilings reaching
 * `[agents].max_concurrent_threads_per_session` and `[agents].max_depth`.
 *
 * The writer half has its own suite in the adapter package
 * (`config-writer-operator-ceilings.test.ts`). This one asserts the
 * chain an operator actually experiences: `NESSY_BASH_MAX_OUTPUT_LENGTH` (or its
 * documented compat spelling) → the projection → the config the app-server is
 * spawned against, read back OFF DISK from the real `CODEX_HOME` the agent
 * built. A capture of the options object would pass for an agent that never
 * passed the option on.
 *
 * ## The gap this closes, and the shape of the decision
 *
 * The ceiling binds on Pi (the `ProcessStore` ring) and on claude (the env
 * spelling the vendored binary reads) and bound on codex nowhere: the shell runs
 * inside the binary, and the per-session `CODEX_HOME` is a fresh mkdtemp with no
 * raw-TOML passthrough, so an operator had no route to it at all.
 *
 * The two knobs are NOT the same knob — ours is characters of one tool's
 * read-back window, codex's is tokens applied to every stored tool output — so
 * the projection fires only for an operator who set the host value EXPLICITLY.
 * That gate is the behaviour under test here, and it is why the default case
 * below is an assertion rather than an omission.
 *
 * Hermetic: credentials, the adapter launcher, the app-server subprocess and the
 * dp-creds reader are faked. Nothing opens a socket or spawns a process.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '../../config/paths.ts'
import { addLlmConnection, getLlmConnection } from '../../config/storage.ts'
import { CODEX_BEDROCK_MODEL_PROVIDER, resolveCodexModelProvider } from '../../config/llm-connections.ts'
import * as credentialsIndex from '../../credentials/index.ts'
import * as adapterPackage from '@nessy-agent/codex-responses-adapter'
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth'
import * as codexAgentServer from '@nessy-agent/codex-agent-server'
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter'
import type { LlmConnection } from '../../config/storage.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts'

// ============================================================
// Fakes
// ============================================================

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4343 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-p3348' } } : {}
  }
  notify(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

const realCredentials = { ...credentialsIndex }
const realAdapter = { ...adapterPackage }
const realNestorAuth = { ...nestorAuth }
const realCodexAgentServer = { ...codexAgentServer }

mock.module('../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => ({ getLlmApiKey: async () => null }),
}))

mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (): Promise<AdapterHandle> => (
    { port: 46172, close: async () => { /* nothing bound */ } }
  ),
}))

/**
 * DA1.29 — this stub covers BOTH readers of the creds file, not just the one
 * a past call graph used. `codex-agent.ts` imports `readNestorCreds` and no
 * longer imports `readNestorJwt` at all (DA1.12), and a spread isolates only
 * the names it lists: the un-stubbed sibling reads the developer's real
 * `~/.nessy/dp_auth_creds.json` (measured by WA-b, now AGENTS.md §Traps).
 * Both are derived from ONE literal so they cannot drift, and neither is
 * reachable on this suite's paths today — which is exactly why it must not
 * depend on that staying true.
 */
mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => ({
  ...realNestorAuth,
  readNestorJwt: () => 'jwt-not-a-real-token',
  readNestorCreds: () => ({ ok: true, jwt: 'jwt-not-a-real-token' }),
}))

mock.module('@nessy-agent/codex-agent-server', () => ({
  ...realCodexAgentServer,
  CodexRuntimeManager: FakeRuntimeManager,
  AppServerClient: FakeAppServerClient,
}))

afterAll(() => {
  mock.module('../../credentials/index.ts', () => realCredentials)
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter)
  mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => realNestorAuth)
  mock.module('@nessy-agent/codex-agent-server', () => realCodexAgentServer)
})

const { CodexAgent } = await import('../codex-agent.ts')
const { codexDriver } = await import('../backend/internal/drivers/codex.ts')

// ============================================================
// Fixtures
// ============================================================

const MODEL = 'tgpt/qwen35-397b-a17b-fp8'
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'

const NESSY_ENV = 'NESSY_BASH_MAX_OUTPUT_LENGTH'
const COMPAT_ENV = 'BASH_MAX_OUTPUT_LENGTH'
const CONCURRENCY_ENV = 'NESSY_MAX_CONCURRENT_SUBAGENTS'
const CONCURRENCY_COMPAT_ENV = 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'
const DEPTH_ENV = 'NESSY_MAX_SUBAGENT_SPAWN_DEPTH'
const DEPTH_COMPAT_ENV = 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH'
// P6.140 · the fourth lever in this family, same explicit-set-only rule.
const MCP_TOOL_TIMEOUT_ENV = 'NESSY_MCP_TOOL_TIMEOUT'
const MCP_TOOL_TIMEOUT_COMPAT_ENV = 'MCP_TOOL_TIMEOUT'
// P6.146 · the fifth, and the only one of the five that is NOT forwarded: codex
// has no per-command deadline to forward it to, so the lever produces a
// DIAGNOSTIC under the same explicit-set-only gate.
const BASH_TIMEOUT_ENV = 'NESSY_BASH_MAX_TIMEOUT_MS'
const BASH_TIMEOUT_COMPAT_ENV = 'BASH_MAX_TIMEOUT_MS'
// P6.368 · the sixth, and the only one with NO compat spelling: claude documents
// no plan-mode effort variable and its shipped binary carries none, so there is
// nothing to be compatible with. See `CodexConfigOptions.planModeThinkingLevel`.
const PLAN_MODE_EFFORT_ENV = 'NESSY_PLAN_MODE_EFFORT'
// P6.364 · the seventh, and the only one that lands on a key this writer ALREADY
// emits from another source — so it is the only one whose test has to assert a
// precedence rather than a presence.
const SUBAGENT_MODEL_ENV = 'NESSY_SUBAGENT_MODEL'
const SUBAGENT_MODEL_COMPAT_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL'
// P6.273 · the eighth and ninth, and the only pair that lands on the
// `[model_providers.*]` table rather than on a top-level key or an `[agents]`
// one. The idle deadline is the only lever in this family with NO compat
// spelling ON PURPOSE rather than for want of one: `CLAUDE_STREAM_IDLE_TIMEOUT_MS`
// belongs to the byte/stream watchdog family open row P6.115 owns, and claiming
// it here would assert a reading that row has not made.
const MAX_API_RETRIES_ENV = 'NESSY_MAX_API_RETRIES'
const MAX_API_RETRIES_COMPAT_ENV = 'CLAUDE_CODE_MAX_RETRIES'
const STREAM_IDLE_TIMEOUT_ENV = 'NESSY_STREAM_IDLE_TIMEOUT_MS'
const MANAGED_ENV_NAMES = [
  NESSY_ENV, COMPAT_ENV,
  CONCURRENCY_ENV, CONCURRENCY_COMPAT_ENV,
  DEPTH_ENV, DEPTH_COMPAT_ENV,
  MCP_TOOL_TIMEOUT_ENV, MCP_TOOL_TIMEOUT_COMPAT_ENV,
  BASH_TIMEOUT_ENV, BASH_TIMEOUT_COMPAT_ENV,
  PLAN_MODE_EFFORT_ENV,
  SUBAGENT_MODEL_ENV, SUBAGENT_MODEL_COMPAT_ENV,
  MAX_API_RETRIES_ENV, MAX_API_RETRIES_COMPAT_ENV, STREAM_IDLE_TIMEOUT_ENV,
] as const

/**
 * `delete` FIRST, then assign — AGENTS.md's measured Bun trap: a plain
 * assignment to a name Bun pre-created a slot for leaves it readable by property
 * and invisible to `{...process.env}`, and every subprocess env in this tree is
 * built by spreading. Unconditional rather than gated on a name list, because
 * that list cannot be complete. The restore path takes the same care.
 */
function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

const savedEnv = new Map<string, string | undefined>()
beforeEach(() => {
  for (const name of MANAGED_ENV_NAMES) {
    savedEnv.set(name, process.env[name])
    setEnv(name, undefined)
  }
})
afterEach(() => {
  for (const [name, value] of savedEnv) setEnv(name, value)
  savedEnv.clear()
})

function connection(): LlmConnection {
  return {
    slug: 'nessy-codex',
    name: 'Nessy Codex',
    providerType: 'codex-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_BASE_URL,
    defaultModel: MODEL,
    createdAt: Date.now(),
  } as LlmConnection
}

/**
 * C3.373 · the session on which codex CAN resolve what we project, and it is a
 * REAL stored connection rather than a stubbed predicate.
 *
 * `declaredCodexModelProvider` reads the STORE
 * (`getLlmConnection(connectionSlug)` → `resolveCodexModelProvider`), so
 * planting a connection drives the whole chain the production path walks.
 * `resolveCodexModelProvider` answers non-`undefined` for exactly one shape
 * today — `providerType: 'codex-runtime'` plus
 * `codexModelProvider: 'amazon-bedrock'` with the card on — so that is the
 * shape, not an invented one.
 *
 * A SECOND slug rather than the fixture's own: every other case in this file
 * boots `nessy-codex`, which resolves to nothing and is therefore the ordinary
 * loopback-pinned session. Re-pointing that one would have moved 59 passing
 * assertions off the session they were written for.
 */
const DECLARED_SLUG = 'nessy-codex-declared'

function declaredConnection(): LlmConnection {
  return {
    slug: DECLARED_SLUG,
    name: 'Nessy Codex (declared model provider)',
    providerType: 'codex-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_BASE_URL,
    defaultModel: MODEL,
    codexModelProvider: CODEX_BEDROCK_MODEL_PROVIDER,
    createdAt: Date.now(),
  } as LlmConnection
}

/**
 * Plant it once. The isolated config dir starts empty and `addLlmConnection`
 * refuses to create the file, so the fixture makes one — the same recipe
 * `codex-builtin-agent-tier.test.ts` uses, with the same positive control
 * beside it so an unwritten connection fails HERE rather than silently turning
 * every declared case back into the loopback one it is the control for.
 */
function plantDeclaredConnection(): void {
  if (getLlmConnection(DECLARED_SLUG)) return
  mkdirSync(CONFIG_DIR, { recursive: true })
  const configPath = join(CONFIG_DIR, 'config.json')
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      JSON.stringify({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null }),
      'utf-8',
    )
  }
  addLlmConnection(declaredConnection() as never)
}

function runtimeFor(conn: LlmConnection): BackendRuntimePayload {
  return codexDriver.buildRuntime({
    context: {
      connection: conn,
      provider: 'codex-runtime',
      resolvedModel: MODEL,
      capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {} as never,
    hostRuntime: {} as never,
    resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
  })
}

function agentConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-p3348',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-p3348',
      workspaceRootPath: '/tmp/ws-p3348',
      sessionRootPath: '/tmp/ws-p3348/sessions',
    } as never,
    session: {
      id: 'session-p3348',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-p3348',
    } as never,
    runtime: runtimeFor(connection()),
  } as BackendConfig
}

type PrivateAgent = { ensureRuntime: () => Promise<void>; codexHome: string | null }

const live: Array<{ destroy: () => void }> = []
afterEach(() => { for (const agent of live.splice(0)) agent.destroy() })
beforeEach(() => { live.length = 0 })

/** Boot the runtime and parse the config.toml the app-server would be given. */
async function bootedConfig(): Promise<Record<string, unknown>> {
  return (await bootedFile({})).config
}

/**
 * The same boot, keeping the TEXT beside the parse.
 *
 * P6.140 needs both: a parse cannot see that a bare key landed under the wrong
 * table header, which is the failure mode the `[agents]` placement test at the
 * bottom of this file exists for.
 *
 * The caller passes `poolServerUrl` when it wants the SECOND entry:
 * `[mcp_servers.sources]` is the aggregated loopback pool endpoint, so it is the
 * one entry where the host's own wall clock is also running, and it is what the
 * row's required guard is about. `bootedConfig` above passes nothing, so the
 * three suites that predate this one see exactly the file they saw before.
 */
async function bootedFile(
  extra: Partial<BackendConfig>,
): Promise<{ config: Record<string, unknown>; text: string }> {
  const agent = new CodexAgent({ ...agentConfig(), ...extra } as BackendConfig)
  live.push(agent)
  await (agent as unknown as PrivateAgent).ensureRuntime()
  const home = (agent as unknown as PrivateAgent).codexHome
  expect(typeof home).toBe('string')
  const text = readFileSync(join(home!, 'config.toml'), 'utf8')
  return { config: Bun.TOML.parse(text) as Record<string, unknown>, text }
}

/**
 * C3.373 · the same boot on a session whose connection DECLARED one of codex's
 * own model providers — the only session on which a projected
 * `[agents] default_subagent_model` is resolvable, and therefore the only one
 * on which the P6.155/P6.364 projection contract can be asserted at all.
 *
 * The runtime payload is deliberately the same one: `codexDriver.buildRuntime`
 * reads `baseUrl`/`customEndpoint` and never `codexModelProvider`, so building
 * a second payload would assert nothing and hide which field decides.
 */
async function bootedDeclaredFile(
  extra: Partial<BackendConfig>,
): Promise<{ config: Record<string, unknown>; text: string }> {
  plantDeclaredConnection()
  // POSITIVE CONTROL for the plant, on the real resolver rather than on a
  // belief about it: if this connection stopped declaring a provider, every
  // case below would silently become the loopback case it is contrasted with.
  expect(resolveCodexModelProvider(getLlmConnection(DECLARED_SLUG)!))
    .toBe(CODEX_BEDROCK_MODEL_PROVIDER)
  return bootedFile({ connectionSlug: DECLARED_SLUG, ...extra } as Partial<BackendConfig>)
}

/**
 * P6.146 · the same boot, keeping the DEBUG lines instead of the file.
 *
 * The fifth lever in this family produces no key — codex has nowhere to put one
 * — so the observable is the sentence, and the sentence has to be readable from
 * a test the same way the four keys are.
 */
async function bootedDebugLines(): Promise<string[]> {
  const agent = new CodexAgent(agentConfig())
  live.push(agent)
  const lines: string[] = []
  agent.onDebug = (message: string) => { lines.push(message) }
  await (agent as unknown as PrivateAgent).ensureRuntime()
  return lines
}

/** The two `[mcp_servers.*]` entries, as the app-server would read them. */
function mcpEntries(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (config.mcp_servers ?? {}) as Record<string, Record<string, unknown>>
}

// ============================================================

describe('P3.348 — the host output ceiling reaches codex only when an operator set it', () => {
  /**
   * THE DEFAULT POSITION, asserted rather than assumed. codex's own default here
   * is 10 000 BYTES (`model_info_from_slug`'s `truncation_policy` at
   * `rust-v0.148.0`); forwarding OUR default would apply a Bash-shaped character
   * budget to every stored tool output on this runtime, which is broader than
   * the knob promises.
   */
  it('writes no key at all when neither spelling is set', async () => {
    const config = await bootedConfig()
    expect(config.tool_output_token_limit).toBeUndefined()
    // POSITIVE CONTROL on the same rig: the config was really written and read.
    expect(config.model).toBe(MODEL)
  })

  it('projects an explicit value through codex’s own 4-bytes-per-token constant', async () => {
    setEnv(NESSY_ENV, '120000')
    const config = await bootedConfig()
    // 120 000 characters, clamped by the shared resolver to the documented
    // 150 000 ceiling (it is under it), divided by codex's own
    // APPROX_BYTES_PER_TOKEN = 4.
    expect(config.tool_output_token_limit).toBe(30_000)
  })

  it('honours the documented compat spelling', async () => {
    setEnv(COMPAT_ENV, '40000')
    const config = await bootedConfig()
    expect(config.tool_output_token_limit).toBe(10_000)
  })

  /**
   * The clamp stays in the shared resolver rather than being re-spelled here —
   * this asserts that it is still the thing doing the clamping.
   */
  it('clamps a value past the documented 150 000 ceiling before projecting it', async () => {
    setEnv(NESSY_ENV, '999999')
    const config = await bootedConfig()
    expect(config.tool_output_token_limit).toBe(37_500)
  })

  /**
   * P6.565 · the GENERAL spellings now reach codex, because they now reach the
   * host reader beside it.
   *
   * `BASH_MAX_OUTPUT_LENGTH`'s row in `env-vars.md` notes nothing about plain
   * digits, so `env-vars.md#variables`' general clause grants it scientific
   * notation and separators. Before this row `1e3` was refused HERE and — after
   * P6.440 — accepted by the vendored binary reading the same variable, so one
   * operator value meant two different things either side of a runtime switch.
   * 1000 characters / 4 bytes-per-token = 250.
   */
  for (const [raw, tokens] of [['1e3', 250], ['40_000', 10_000]] as const) {
    it(`forwards the general spelling ${JSON.stringify(raw)} as ${tokens} tokens`, async () => {
      setEnv(NESSY_ENV, raw)
      const config = await bootedConfig()
      expect(config.tool_output_token_limit).toBe(tokens)
    })
  }

  /**
   * NEGATIVE CONTROLS. "Anything else is ignored" is the documented parse
   * contract, and a typo must not do something on codex that it does on neither
   * other runtime — which is exactly what forwarding the fallback default would
   * be. `1e3` left this list in P6.565; every entry that remains is a spelling
   * the general rule itself refuses, plus the zero this family never honours.
   */
  for (const raw of ['abc', '', '  ', '3.5', '+30000', '0', '0x1', '4__0']) {
    it(`ignores a malformed or zero value (${JSON.stringify(raw)}) instead of forwarding the default`, async () => {
      setEnv(NESSY_ENV, raw)
      const config = await bootedConfig()
      expect(config.tool_output_token_limit).toBeUndefined()
    })
  }

  it('prefers the Nessy spelling when both are set, as every aliased pair here does', async () => {
    setEnv(NESSY_ENV, '40000')
    setEnv(COMPAT_ENV, '150000')
    const config = await bootedConfig()
    expect(config.tool_output_token_limit).toBe(10_000)
  })
})

describe('P3.347 / P6.486 — the concurrency ceiling waits for an operator; the depth does not', () => {
  /**
   * The default position, CHANGED by P6.486 on the depth axis only (owner
   * decision 2026-09-05, Q18 option (c)).
   *
   * codex's own defaults under the V1 backend that is in force are
   * `DEFAULT_AGENT_MAX_THREADS = Some(6)` and `DEFAULT_AGENT_MAX_DEPTH = 1`
   * (`core/src/config/mod.rs`, `rust-v0.150.1`); ours are 20 (RAM-narrowed) and
   * 3. The two axes are treated differently and the asymmetry is the decision:
   *
   * - **Depth is written always.** An unconfigured codex session nested ONE
   *   subagent level where an unconfigured Pi or claude session nests three, so a
   *   three-level workflow that worked before a switch stopped working after it
   *   with nothing said. That is a capability loss, not a resource choice.
   * - **Concurrency is not.** Forwarding a RAM-derived number would impose this
   *   machine's memory bound on a runtime whose subagent is a thread inside the
   *   child that already exists — P6.16's refutation, restated as an assertion.
   */
  it('writes the host depth default with no knob set, and STILL no concurrency ceiling', async () => {
    const config = await bootedConfig()
    expect((config.agents as Record<string, unknown> | undefined)?.max_concurrent_threads_per_session)
      .toBeUndefined()
    expect((config.agents as Record<string, number>).max_depth).toBe(3)
    // POSITIVE CONTROL that the file really was written and parsed.
    expect(config.model).toBe(MODEL)
  })

  it('forwards an explicit concurrency ceiling verbatim, beside the depth default', async () => {
    setEnv(CONCURRENCY_ENV, '4')
    const config = await bootedConfig()
    expect((config.agents as Record<string, number>).max_concurrent_threads_per_session).toBe(4)
    expect((config.agents as Record<string, number>).max_depth).toBe(3)
  })

  it('forwards an explicit depth ceiling verbatim, including the documented "nesting off" value', async () => {
    setEnv(DEPTH_ENV, '1')
    const config = await bootedConfig()
    expect((config.agents as Record<string, number>).max_depth).toBe(1)
  })

  it('honours both documented compat spellings', async () => {
    setEnv(CONCURRENCY_COMPAT_ENV, '9')
    setEnv(DEPTH_COMPAT_ENV, '2')
    const config = await bootedConfig()
    const agents = config.agents as Record<string, number>
    expect(agents.max_concurrent_threads_per_session).toBe(9)
    expect(agents.max_depth).toBe(2)
  })

  /**
   * NEGATIVE CONTROLS: "anything else is ignored" is the documented parse for
   * both pairs, and a typo must not start doing something on codex that it does
   * on neither other runtime.
   */
  for (const raw of ['abc', '0', '3.5', '1e3', '  ']) {
    it(`falls back to the documented default on a malformed or zero depth (${JSON.stringify(raw)})`, async () => {
      // "anything else is ignored" is the documented parse, and since P6.486 the
      // thing it falls back TO is written rather than omitted — so a typo gets
      // the same three levels a blank does, never codex's one.
      setEnv(DEPTH_ENV, raw)
      const config = await bootedConfig()
      expect((config.agents as Record<string, number>).max_depth).toBe(3)
    })
  }

  /**
   * PLACEMENT, and it is the thing that would break silently. Every key under
   * `[agents]` is a ROLE name (`AgentsToml.additionalProperties -> AgentRoleToml`),
   * so a bare assignment emitted after an `[agents.<role>]` header becomes
   * `agents.<role>.max_depth` — which `AgentRoleToml`, `additionalProperties:
   * false` over three fields, refuses. Asserted on the TEXT as well as the parse,
   * because a parse alone cannot see the ordering that makes it true.
   */
  it('emits the bare keys before any [agents.<role>] header', async () => {
    setEnv(CONCURRENCY_ENV, '5')
    setEnv(DEPTH_ENV, '2')
    const agent = new CodexAgent(agentConfig())
    live.push(agent)
    await (agent as unknown as PrivateAgent).ensureRuntime()
    const home = (agent as unknown as PrivateAgent).codexHome
    const text = readFileSync(join(home!, 'config.toml'), 'utf8')
    const agentsHeaderAt = text.indexOf('[agents]')
    expect(agentsHeaderAt).toBeGreaterThan(-1)
    // Nothing bare may follow this table, and nothing does: only role tables can.
    const afterHeader = text.slice(agentsHeaderAt + '[agents]'.length)
    const nextHeaderAt = afterHeader.search(/^\[/m)
    const between = nextHeaderAt === -1 ? afterHeader : afterHeader.slice(0, nextHeaderAt)
    expect(between).toContain('max_concurrent_threads_per_session = 5')
    expect(between).toContain('max_depth = 2')
    // The whole file still parses — a misplaced bare key is the failure that
    // takes the provider block and the sandbox mode down with it.
    const parsed = Bun.TOML.parse(text) as Record<string, unknown>
    expect(parsed.model_provider).toBe('nessy_gateway')
  })
})

/**
 * P6.140 — the MCP tool wall clock, the fourth ceiling in this family and the
 * first one with a RACE to lose.
 *
 * A hung MCP transport had no deadline at all on codex: the pinned
 * `config-schema.json` gives `RawMcpServerConfig` three transport deadlines
 * (`tool_timeout_sec`, `startup_timeout_sec`, `startup_timeout_ms`, all
 * `default: null`) and the writer emitted none of them on either entry, while
 * the same call is bounded on Pi and claude by `McpPool`'s `defaultToolTimeoutMs`
 * — read from this very lever.
 *
 * WHAT EACH TEST KILLS:
 *  - "writes no deadline when the lever is unset" is the whole reason the gate
 *    exists. `mcpDefaultToolTimeoutMsFromEnv` falls back to 100 000 000 ms, so a
 *    projection without the gate writes a ~100 001-second key into every session
 *    that asked for nothing. (Since UA12.24 this holds of `sources` only:
 *    `session` carries the card-window floor unconditionally, so a publish card
 *    answered inside its 110 s window reaches the model instead of a codex
 *    timeout — `config-writer-session-tool-timeout.test.ts` owns that floor.)
 *  - "carries the deadline on the lever's entry" dies if the projection drifts
 *    from the pool's reading of the same lever.
 *  - "is strictly looser than the host's own ceiling" is the row's REQUIRED
 *    guard. Equal is not looser: the host's abort names the server and the tool
 *    and codex's names neither, so a tie is a coin toss over which message the
 *    user gets.
 *  - the malformed arms die if a typo starts writing the 28-hour default, which
 *    is the failure the gate exists to prevent wearing the shape of a setting.
 *  - "honours the compat spelling" and "prefers the Nessy spelling" die if this
 *    reader disagrees with the POOL about which name won — they share
 *    `readMcpTimeoutEnv` precisely so they cannot.
 *  - "the key sits inside its own entry's table" dies on the placement failure
 *    the `[agents]` test below already records for the other family.
 */
describe('P6.140 — the MCP tool deadline: the operator lever on sources, the UA12.24 card-window floor on session', () => {
  /**
   * BOTH entries, which needs two things the three suites above do not: a
   * `poolServerUrl` for `[mcp_servers.sources]`, and a `sessionServer` path for
   * `[mcp_servers.session]` (`buildSessionMcpSpec` returns `undefined` without
   * one, so the entry is simply absent). Supplied HERE rather than in the shared
   * `runtimeFor`, so the suites that predate this one keep reading exactly the
   * file they read before.
   */
  const POOL: Partial<BackendConfig> = {
    poolServerUrl: 'http://127.0.0.1:45999/mcp',
    runtime: {
      ...runtimeFor(connection()),
      paths: {
        codexBinary: '/fake/codex-app-server',
        sessionServer: '/fake/session-mcp-server.js',
        node: '/fake/node',
      },
    } as BackendRuntimePayload,
  }

  it('writes the card-window floor on session when the lever is unset, and nothing on sources', async () => {
    const { config } = await bootedFile(POOL)
    const entries = mcpEntries(config)
    // POSITIVE CONTROL: both entries really are in the file, so the two
    // readings below are measurements rather than a missing table.
    expect(entries.session).toBeDefined()
    expect(entries.sources).toBeDefined()
    // UA12.24 — the floor is the point: a session tool call waits for a person
    // (the publish/archive/delete cards), and codex's own default deadline was
    // shorter than the card window, so the entry carries the floor even for a
    // user who asked for nothing.
    expect(entries.session?.tool_timeout_sec).toBe(121)
    expect(entries.sources?.tool_timeout_sec).toBeUndefined()
  })

  it('carries the deadline on sources when the operator set one, and never lets it tighten the session floor', async () => {
    setEnv(MCP_TOOL_TIMEOUT_ENV, '45000')
    const { config } = await bootedFile(POOL)
    const entries = mcpEntries(config)
    // 45 000 ms -> ceil(45) + 1 on `sources`; `session` keeps the UA12.24 floor,
    // because 46 s would cut a publish card off before its own 110 s window.
    expect(entries.session?.tool_timeout_sec).toBe(121)
    expect(entries.sources?.tool_timeout_sec).toBe(46)
  })

  it('is strictly looser than the host pool ceiling, at the documented floor too', async () => {
    // The floor is where a rounding-only projection ties: `ceil(1000 / 1000)` is
    // 1 s, exactly the host's 1 000 ms. The `+ 1` is what makes it a backstop.
    setEnv(MCP_TOOL_TIMEOUT_ENV, '1000')
    const { config } = await bootedFile(POOL)
    expect(mcpEntries(config).sources?.tool_timeout_sec).toBe(2)
  })

  it('rounds a sub-second remainder UP before adding the margin', async () => {
    // 45 500 ms is 45.5 s. Truncating would give 45 + 1 = 46, i.e. 500 ms of
    // slack; rounding up gives 46 + 1 = 47, which is looser on both readings.
    setEnv(MCP_TOOL_TIMEOUT_ENV, '45500')
    const { config } = await bootedFile(POOL)
    expect(mcpEntries(config).sources?.tool_timeout_sec).toBe(47)
  })

  it('honours the documented compat spelling', async () => {
    setEnv(MCP_TOOL_TIMEOUT_COMPAT_ENV, '30000')
    const { config } = await bootedFile(POOL)
    expect(mcpEntries(config).sources?.tool_timeout_sec).toBe(31)
  })

  it('prefers the Nessy spelling when both are set', async () => {
    setEnv(MCP_TOOL_TIMEOUT_ENV, '10000')
    setEnv(MCP_TOOL_TIMEOUT_COMPAT_ENV, '90000')
    const { config } = await bootedFile(POOL)
    expect(mcpEntries(config).sources?.tool_timeout_sec).toBe(11)
  })

  /**
   * NEGATIVE CONTROLS. A blank name counts as unset in `readMcpTimeoutEnv`, and
   * a malformed one resolves to the enormous documented default in
   * `mcpDefaultToolTimeoutMsFromEnv` — both must reach codex as silence rather
   * than as a 28-hour key. F1.1103 adds the setTimeout-overflow class DN-068
   * measured (2 147 483 648 ms and 3 000 000 000 ms make a Node timer fire
   * after ~1 ms): every value in that class is above the drop gate, so it can
   * only ever reach codex as silence — and codex's own timer is Rust-side, so
   * a written 100 001 s ceiling is native range, not an overflow.
   */
  for (const raw of ['', '   ', 'abc', '-5', '0', '100000000', '2147483648', '3000000000']) {
    it(`writes silence on sources, never the 28-hour key, and keeps the session floor (${JSON.stringify(raw)})`, async () => {
      setEnv(MCP_TOOL_TIMEOUT_ENV, raw)
      const { config } = await bootedFile(POOL)
      expect(mcpEntries(config).sources?.tool_timeout_sec).toBeUndefined()
      // UA12.24 — a broken lever must not resurrect the 60 s defect this family
      // exists to fix: the card-window floor survives every malformed value.
      expect(mcpEntries(config).session?.tool_timeout_sec).toBe(121)
    })
  }

  it('emits the key inside its own entry table, not after the next header', async () => {
    setEnv(MCP_TOOL_TIMEOUT_ENV, '45000')
    const { text } = await bootedFile(POOL)
    const expected = {
      '[mcp_servers.session]': 'tool_timeout_sec = 121',
      '[mcp_servers.sources]': 'tool_timeout_sec = 46',
    } as const
    for (const header of ['[mcp_servers.session]', '[mcp_servers.sources]'] as const) {
      const at = text.indexOf(header)
      expect(at).toBeGreaterThan(-1)
      const after = text.slice(at + header.length)
      const nextAt = after.search(/^\[/m)
      const between = nextAt === -1 ? after : after.slice(0, nextAt)
      expect(between).toContain(expected[header])
    }
  })
})

/**
 * P6.155 — the connection's served cheap model reaches codex's own
 * `[agents] default_subagent_model`.
 *
 * Codex has two of its own levers for cheap helpers and we wrote neither. This
 * is the GLOBAL one, and the row says to start with it: a real key of
 * `AgentsToml` in the pinned schema — "Default model for spawned subagents when
 * the spawn call does not select one." — in the table this writer already
 * emits, and known in this tree only as a reserved role name.
 *
 * ## What is measured on the shipped binary, and what is not
 *
 * Measured (`darwin-arm64` `codex-app-server`, `rust-v0.148.0`):
 * `default_subagent_model` occurs 9 times, positive controls `spawn_agent` 28
 * and `agent_type` 22, negative control `nessy_not_a_key` 0; and a config
 * carrying the key is ACCEPTED — a driven turn against a loopback Responses
 * provider reached that provider, which a config discarded as "Invalid
 * configuration; using defaults." could not have done.
 *
 * NOT measured: the spawned subagent's own first upstream request naming the
 * id. `spawn_agent` lives inside the `multi_agent_v1` NAMESPACE on the wire, and
 * five spellings of a canned `function_call` for it all came back "unsupported
 * call" from the binary, so the stub provider cannot dispatch a namespaced tool
 * as it stands. Recorded rather than implied.
 *
 * ## C3.426 — WHICH SESSION these nine cases now boot, and why that moved
 *
 * Every case below booted the file's default fixture until C3.373
 * (`22073a448`), whose `connectionSlug` resolves to nothing and is therefore
 * the LOOPBACK-pinned session — and on that session this key is no longer
 * written at all, because codex resolves it against its own cached OpenAI
 * preset catalogue and never against the provider serving the session. Six of
 * these nine went red on exactly that, and the honest repair is NOT to restate
 * them as "nothing is projected": that would delete the projection contract
 * this row exists for, and would leave four of the six asserting a value that
 * cannot be reached from either arm (a control whose two arms agree).
 *
 * So the nine MOVE to the session on which the contract still binds — a
 * connection that DECLARED one of codex's own model providers, planted for real
 * in the isolated config dir so the whole `getLlmConnection` →
 * `resolveCodexModelProvider` → projection chain runs — and the loopback arm is
 * asserted beneath, in its own describe, as the new contract rather than as the
 * absence of the old one.
 *
 * WHAT EACH TEST KILLS:
 *  - "projects the served cheap model" dies if the option is removed — the
 *    shipped state.
 *  - "omits it when the cheap model IS the session model" is the arm that
 *    matters as much: `getMiniModel(connection) ?? connection.defaultModel`
 *    makes those equal on a connection with no distinct cheap model, and
 *    writing it then restates codex's own documented default.
 *  - "writes nothing with no cheap model at all" covers the absent case.
 *  - the placement test dies on this table's own trap: a bare key emitted after
 *    an `[agents.<role>]` header becomes `agents.<role>.default_subagent_model`,
 *    which `AgentRoleToml` refuses. It is the ONLY assertion of that trap in the
 *    tree — `config-writer-operator-ceilings.test.ts` in the adapter package
 *    names `default_subagent_model` zero times — which is the second reason
 *    these cases had to keep a session that writes the key.
 */
describe('P6.155 — the cheap-helper model reaches codex only when the connection has one', () => {
  function withMini(mini: string | undefined): Partial<BackendConfig> {
    return mini === undefined ? {} : { miniModel: mini } as Partial<BackendConfig>
  }

  it('writes no [agents] key at all when the connection carries no cheap model', async () => {
    const { config } = await bootedDeclaredFile({})
    expect((config.agents as Record<string, unknown> | undefined)?.default_subagent_model).toBeUndefined()
    // POSITIVE CONTROL that a config was written and parsed.
    expect(config.model).toBe(MODEL)
  })

  it('projects the connection’s served cheap model', async () => {
    const { config } = await bootedDeclaredFile(withMini('tgpt/qwen35-mini-served'))
    expect((config.agents as Record<string, string>).default_subagent_model)
      .toBe('tgpt/qwen35-mini-served')
  })

  it('omits it when the resolved cheap model IS the session model', async () => {
    // `getMiniModel(connection) ?? connection.defaultModel` makes these equal on
    // a connection with no distinct cheap model, and codex's own `spawn_agent`
    // text already says "Spawned agents inherit your current model by default".
    const { config } = await bootedDeclaredFile(withMini(MODEL))
    expect((config.agents as Record<string, unknown> | undefined)?.default_subagent_model).toBeUndefined()
  })

  it('ignores a blank cheap model rather than writing an empty string', async () => {
    // A wrong-TYPED or empty value in this file is not an ignored key — it is
    // "Invalid configuration; using defaults.", which discards the WHOLE config.
    const { config } = await bootedDeclaredFile(withMini('   '))
    expect((config.agents as Record<string, unknown> | undefined)?.default_subagent_model).toBeUndefined()
    // The same positive control as before C3.426, reading the provider this
    // session actually declares: a discarded config could not carry it.
    expect(config.model_provider).toBe(CODEX_BEDROCK_MODEL_PROVIDER)
  })

  it('emits the key before any [agents.<role>] header', async () => {
    const { text } = await bootedDeclaredFile(withMini('tgpt/qwen35-mini-served'))
    const at = text.indexOf('[agents]')
    expect(at).toBeGreaterThan(-1)
    const after = text.slice(at + '[agents]'.length)
    const nextAt = after.search(/^\[/m)
    const between = nextAt === -1 ? after : after.slice(0, nextAt)
    expect(between).toContain('default_subagent_model = "tgpt/qwen35-mini-served"')
  })

  // P6.364 (K10) — the OPERATOR's own override, which reached codex not at all.
  it('lets the operator’s override outrank the connection’s cheap model', async () => {
    setEnv(SUBAGENT_MODEL_ENV, 'tgpt/qwen35-mini-declared')
    const { config } = await bootedDeclaredFile(withMini('tgpt/qwen35-mini-served'))
    expect((config.agents as Record<string, string>).default_subagent_model)
      .toBe('tgpt/qwen35-mini-declared')
  })

  it('binds through the compat spelling too, and with no connection cheap model at all', async () => {
    setEnv(SUBAGENT_MODEL_COMPAT_ENV, 'tgpt/qwen35-mini-declared')
    const { config } = await bootedDeclaredFile({})
    expect((config.agents as Record<string, string>).default_subagent_model)
      .toBe('tgpt/qwen35-mini-declared')
  })

  it('treats `inherit` as no override, leaving the connection’s cheap model in place', async () => {
    setEnv(SUBAGENT_MODEL_ENV, 'inherit')
    const { config } = await bootedDeclaredFile(withMini('tgpt/qwen35-mini-served'))
    expect((config.agents as Record<string, string>).default_subagent_model)
      .toBe('tgpt/qwen35-mini-served')
  })

  it('sits beside the two ceilings rather than replacing them', async () => {
    setEnv(CONCURRENCY_ENV, '4')
    setEnv(DEPTH_ENV, '2')
    const { config } = await bootedDeclaredFile(withMini('tgpt/qwen35-mini-served'))
    const agents = config.agents as Record<string, unknown>
    expect(agents.default_subagent_model).toBe('tgpt/qwen35-mini-served')
    expect(agents.max_concurrent_threads_per_session).toBe(4)
    expect(agents.max_depth).toBe(2)
  })
})

/**
 * C3.373 — and on the ORDINARY session the same key is projected not at all.
 *
 * The producer half of the guard has its own unit suite
 * (`codex-subagent-model-projection.test.ts`, which stubs the predicate). What
 * is asserted HERE is the thing that suite cannot see and the thing this file
 * exists for: the config.toml the app-server is actually spawned against, read
 * back off disk from the real `CODEX_HOME` the agent built.
 *
 * The session is this file's own default fixture — `connectionSlug:
 * 'nessy-codex'` resolving to nothing, which is what
 * `declaredCodexModelProvider` answers `undefined` for and what P6.532 calls
 * the loopback pin: every install that declared nothing, i.e. every gateway
 * install. So this describe, not the one above, is the shipped case.
 *
 * Read at the source (strong tier), `github.com/openai/codex` `rust-v0.150.1`,
 * `core/src/tools/handlers/multi_agents_common.rs`:
 * `apply_requested_spawn_agent_model_overrides` folds this key and the spawn
 * call's own `model` into ONE variable, and `find_spawn_agent_model_name`
 * resolves it against `models_manager.list_models(RefreshStrategy::Offline, …)`
 * — codex's own cached, auth-filtered OpenAI preset catalogue — so a gateway id
 * is refused at the first `spawn_agent` however well the gateway serves it.
 */
describe('C3.373 — nothing is projected onto a loopback-pinned session, and it says why', () => {
  const NOTICE = 'no `[agents] default_subagent_model` is projected on this session'

  it('POSITIVE — the connection’s served cheap model is NOT written', async () => {
    const { config } = await bootedFile({ miniModel: 'tgpt/qwen35-mini-served' } as Partial<BackendConfig>)
    expect((config.agents as Record<string, unknown> | undefined)?.default_subagent_model).toBeUndefined()
    // Positive control that this is the loopback session and a config was still
    // written: the gateway pin is what the declared arm above replaces.
    expect(config.model_provider).toBe('nessy_gateway')
  })

  it('POSITIVE — the OPERATOR’s own override is declined too, and the notice names it', async () => {
    // The safe direction rather than an override of the operator's choice: an
    // id codex's cache happens to hold from an earlier OpenAI-authenticated use
    // would PASS `find_spawn_agent_model_name` and then run the child against
    // `model_provider = nessy_gateway` with an id the gateway does not serve —
    // a worse failure, one step later.
    setEnv(SUBAGENT_MODEL_ENV, 'tgpt/qwen35-mini-declared')
    const lines = await bootedDebugLines()
    const notice = lines.find(line => line.includes(NOTICE))
    expect(notice).toBeDefined()
    expect(notice).toContain('tgpt/qwen35-mini-declared')
    // It must say what happens INSTEAD, or an absent key reads as a fault
    // rather than as codex's own documented default.
    expect(notice).toContain('inherit')
  })

  it('BOUNDARY — with nothing to project, nothing is said at all', async () => {
    // A notice about a decision nobody made is the noise that teaches a reader
    // to stop reading the channel.
    const lines = await bootedDebugLines()
    expect(lines.find(line => line.includes(NOTICE))).toBeUndefined()
    // Positive control that the channel was live for this boot.
    expect(lines.length).toBeGreaterThan(0)
  })

  it('CONTROL — the two subagent CEILINGS still land on the same session', async () => {
    // The guard is narrow: it withholds one key whose ids codex cannot resolve,
    // not the `[agents]` table. Without this arm a regression that suppressed
    // the whole table would read as the guard working.
    setEnv(CONCURRENCY_ENV, '4')
    setEnv(DEPTH_ENV, '2')
    const { config } = await bootedFile({ miniModel: 'tgpt/qwen35-mini-served' } as Partial<BackendConfig>)
    const agents = config.agents as Record<string, unknown>
    expect(agents.default_subagent_model).toBeUndefined()
    expect(agents.max_concurrent_threads_per_session).toBe(4)
    expect(agents.max_depth).toBe(2)
  })
})


describe('P6.146 — the Bash timeout ceiling codex does NOT honour says so, and only when it was set', () => {
  /**
   * THE ROW. The output ceiling binds on all three runtimes; the TIMEOUT ceiling
   * binds on two, because codex runs its shell inside the app-server and the
   * pinned `config-schema.json` exposes no per-command deadline — measured, and
   * the near-miss written out in the method's docblock:
   * `background_terminal_max_timeout` bounds the OUTPUT POLL WINDOW, not the
   * command, so adopting it would look like the knob had been honoured.
   */
  it('names the ceiling, its effective value and the runtime it does not reach', async () => {
    setEnv(BASH_TIMEOUT_ENV, '900000')
    const lines = await bootedDebugLines()

    const notice = lines.find(line => line.includes('NOT honoured on codex'))
    expect(notice).toBeDefined()
    expect(notice).toContain(`${BASH_TIMEOUT_ENV}=900000`)
    expect(notice).toContain('900000 ms')
    expect(notice).toContain('background_terminal_max_timeout')
  })

  it('honours the documented compat spelling', async () => {
    setEnv(BASH_TIMEOUT_COMPAT_ENV, '450000')
    const lines = await bootedDebugLines()

    expect(lines.find(line => line.includes('NOT honoured on codex')))
      .toContain(`${BASH_TIMEOUT_COMPAT_ENV}=450000`)
  })

  /**
   * THE GATE, and the assertion the row asked for by name. The resolver falls
   * back to the documented 600 000 ms, so an unconditional line would tell every
   * codex operator that a knob they never touched is not being honoured — which
   * trains a reader to skip the channel the other four levers report on.
   */
  it('says nothing when the operator set nothing, on a rig that proves the channel works', async () => {
    const lines = await bootedDebugLines()

    expect(lines.some(line => line.includes('NOT honoured on codex'))).toBe(false)
    // POSITIVE CONTROL: the debug channel really was captured on this boot.
    expect(lines.length).toBeGreaterThan(0)
  })

  it('says nothing for a present-but-blank value, the rule every lever here follows', async () => {
    setEnv(BASH_TIMEOUT_ENV, '   ')
    const lines = await bootedDebugLines()

    expect(lines.some(line => line.includes('NOT honoured on codex'))).toBe(false)
  })
})

/**
 * P6.368 — codex's own `plan_mode_reasoning_effort`, written by nothing before
 * this row: the key is top-level in the release `config-schema.json` (and again
 * under `ConfigProfile`) and `git grep -a plan_mode_reasoning_effort -- packages`
 * found only those two schema occurrences.
 *
 * The name of the lever is OURS, which is why the omitted case is asserted
 * rather than assumed: `env-vars.md` documents no plan-mode effort variable and
 * the shipped 2.1.247 binary scores 0 for `CLAUDE_CODE_PLAN_MODE_EFFORT` and 0
 * for `PLAN_MODE_EFFORT` — re-measured 2026-09-12 (C3.252), both instruments
 * named because they disagree on a minified artefact (C3.294): 0 lines / 0
 * occurrences each, control `CLAUDE_CODE_EFFORT_LEVEL` -> 10/19 (it read 17 at
 * 2.1.233, instrument unnamed), negative control `nessyNotARealSdkKey` 0/0. So
 * the NULL holds across the lift. Claude's
 * plan-mode lever is a MODEL alias, not an effort.
 */
describe('P6.368 — codex plans at its own effort, and only when an operator names one', () => {
  it('writes no plan-mode key when the lever is unset', async () => {
    const config = await bootedConfig()
    expect(config.plan_mode_reasoning_effort).toBeUndefined()
    // POSITIVE CONTROL that the file really was written and parsed, and that the
    // EXECUTION effort beside it is unaffected.
    expect(config.model).toBe(MODEL)
  })

  it('projects the operator’s level through the writer’s own effort table', async () => {
    setEnv(PLAN_MODE_EFFORT_ENV, 'xhigh')
    const config = await bootedConfig()
    expect(config.plan_mode_reasoning_effort).toBe('xhigh')
  })

  it('maps Nessy’s own `off` to codex’s `none`, the same pair the execution key uses', async () => {
    setEnv(PLAN_MODE_EFFORT_ENV, 'off')
    const config = await bootedConfig()
    expect(config.plan_mode_reasoning_effort).toBe('none')
  })

  for (const raw of ['abc', '', 'HIGHER', '3']) {
    it(`omits the key for an unrecognised level (${JSON.stringify(raw)}) rather than guessing`, async () => {
      // Deliberately NOT falling back to the session's execution effort: that
      // would emit this session's own level under a second name — a no-op
      // dressed as a setting — and codex's own plan-mode behaviour is the
      // honest thing to leave in place.
      setEnv(PLAN_MODE_EFFORT_ENV, raw)
      const config = await bootedConfig()
      expect(config.plan_mode_reasoning_effort).toBeUndefined()
    })
  }
})

/**
 * P6.273's codex READ half — the retry ceiling and the streaming idle deadline.
 *
 * The emit side landed first and was UNREACHED: `api-retry-env.ts`'s own "WHO
 * READS WHAT" note said so in as many words, precisely so that an exported
 * reader with no caller would not be mistaken for the parse-never-read defect
 * this plan hunts. This suite is what makes the chain observable end to end —
 * the operator's variable, through `codexProviderRetryOptions`, to the
 * `[model_providers.*]` table the app-server is actually spawned against.
 *
 * The keys and their meanings are read from the vendored
 * `codex-protocol/schema/config-schema.json`, generated from
 * `codex-rs/model-provider-info/src/lib.rs` (`struct ModelProviderInfo`, the
 * `request_max_retries`, `stream_max_retries` and `stream_idle_timeout_ms`
 * fields) at `rust-v0.150.1` — the tag shipped when this was read, so
 * STRONG tier by AGENTS.md's two-tier codex rule. P7.11: the path cited here
 * before 404s at every tag this repo has shipped.
 */
describe('P6.273 — the retry ceiling and idle deadline reach codex only when an operator set them', () => {
  function provider(config: Record<string, unknown>): Record<string, unknown> {
    const providers = (config.model_providers ?? {}) as Record<string, Record<string, unknown>>
    const entries = Object.values(providers)
    expect(entries.length).toBe(1)
    return entries[0]!
  }

  /**
   * THE GATE, and the row's own named control: "unset, both keep today's values
   * byte-identical". An unconfigured install must get the same four lines it got
   * before this row, so codex's own defaults stay in force.
   */
  it('writes none of the three keys when the operator set nothing', async () => {
    const entry = provider(await bootedConfig())

    expect(entry.request_max_retries).toBeUndefined()
    expect(entry.stream_max_retries).toBeUndefined()
    expect(entry.stream_idle_timeout_ms).toBeUndefined()
    // POSITIVE CONTROL: the provider block really was written on this boot, so
    // the three absences above are absences of KEYS and not of the table.
    expect(entry.wire_api).toBe('responses')
  })

  /**
   * ONE host value feeds BOTH counters — the writer's decision, recorded at
   * `CodexConfigOptions.providerMaxRetries`: the operator's question is "how
   * many times may a turn try again", and two names on codex alone would be a
   * divergence Pi and claude have no answer for.
   */
  it('projects the attempt ceiling onto both of codex own retry counters', async () => {
    setEnv(MAX_API_RETRIES_ENV, '7')
    const entry = provider(await bootedConfig())

    expect(entry.request_max_retries).toBe(7)
    expect(entry.stream_max_retries).toBe(7)
    expect(entry.stream_idle_timeout_ms).toBeUndefined()
  })

  it('honours the documented compat spelling for the attempt ceiling', async () => {
    setEnv(MAX_API_RETRIES_COMPAT_ENV, '4')
    const entry = provider(await bootedConfig())

    expect(entry.request_max_retries).toBe(4)
    expect(entry.stream_max_retries).toBe(4)
  })

  it('lets the Nessy spelling win when both are set, like every aliased pair here', async () => {
    setEnv(MAX_API_RETRIES_ENV, '7')
    setEnv(MAX_API_RETRIES_COMPAT_ENV, '4')
    const entry = provider(await bootedConfig())

    expect(entry.request_max_retries).toBe(7)
  })

  it('projects the idle deadline independently of the attempt ceiling', async () => {
    setEnv(STREAM_IDLE_TIMEOUT_ENV, '45000')
    const entry = provider(await bootedConfig())

    expect(entry.stream_idle_timeout_ms).toBe(45_000)
    expect(entry.request_max_retries).toBeUndefined()
  })

  it('reads the documented numeric spellings the whole family accepts', async () => {
    setEnv(STREAM_IDLE_TIMEOUT_ENV, ' 45_000 ')
    setEnv(MAX_API_RETRIES_ENV, '2e1')
    const entry = provider(await bootedConfig())

    expect(entry.stream_idle_timeout_ms).toBe(45_000)
    expect(entry.request_max_retries).toBe(20)
  })

  /**
   * The other half of the row's `done_means`: "a wrong-typed value is refused by
   * name rather than silently defaulted". The sentence belongs to
   * `resolveMaxApiRetries`; this asserts that it REACHES the operator, on the
   * same debug channel the five sibling levers report on, and that nothing was
   * written from it.
   */
  it('refuses a malformed value by name and writes nothing from it', async () => {
    setEnv(MAX_API_RETRIES_ENV, 'lots')
    setEnv(STREAM_IDLE_TIMEOUT_ENV, '5')
    const lines = await bootedDebugLines()

    expect(lines.some(line => line.includes(MAX_API_RETRIES_ENV))).toBe(true)
    expect(lines.some(line => line.includes(STREAM_IDLE_TIMEOUT_ENV))).toBe(true)

    setEnv(MAX_API_RETRIES_ENV, 'lots')
    setEnv(STREAM_IDLE_TIMEOUT_ENV, '5')
    const entry = provider(await bootedConfig())
    expect(entry.request_max_retries).toBeUndefined()
    expect(entry.stream_idle_timeout_ms).toBeUndefined()
  })
})
