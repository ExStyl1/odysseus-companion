/**
 * P3.369 — the user's added directories reach codex as WRITABLE roots.
 *
 * ## The gap
 *
 * `getConfiguredAdditionalDirectories` had five readers and `codex-agent.ts` was
 * none of them: the host permission gate says yes to a path under an added root
 * and the subprocess was never told, so a tool call the gate permitted fails
 * inside codex's own sandbox. The filed qualification — *"with the sandbox off
 * it emits danger-full-access, so the roots are moot"* — expired with
 * P3.315/P3.327: the Profiles syntax wins, so a `:workspace`-extending profile
 * is emitted for every real session and an added directory outside the
 * workspace is unwritable with no operator action available.
 *
 * The mechanism is NOT `sandbox_workspace_write.writable_roots` (the legacy
 * syntax the row proposed); it is the profile's own
 * `[permissions.nessy_runtime.filesystem]` map, which this writer already emits
 * and P3.315 measured winning. So the change is a caller wiring, and these cases
 * assert it off the config on disk rather than off an options capture.
 *
 * ## Why the filter cases are the important half
 *
 * Wiring the roots naively introduces three failures that could not fire while
 * the roots were ignored:
 *
 *  - a filesystem root makes `normalizeRuntimePaths` throw
 *    (`codex-writable-path-too-broad`) — the SESSION dies for a settings typo;
 *  - a path that is also a denied-read path makes
 *    `resolveCodexRuntimePathPolicy` throw (`codex-runtime-path-policy-conflict`);
 *  - a path that collides exactly with a credential-floor key makes
 *    `mapDeniedPathsToCodexFilesystemKeys` DROP THE FLOOR ENTRY
 *    (`conflicts-with-grant`), because `deny` beats `write` on codex's side.
 *    That precedence is correct for the host's own plugin data paths and wrong
 *    for a path a user typed, so for this family the floor wins.
 *
 * The third is a widening rather than a crash, which is why it has its own case
 * with a positive control that the floor entry is still there afterwards.
 *
 * Hermetic: credentials, the adapter launcher, the app-server subprocess and the
 * dp-creds reader are faked, and the configured roots are injected by mocking
 * the single reader module. Nothing opens a socket or spawns a process.
 *
 * ## C3.305 — one case here is a REFUTATION rather than a filter
 *
 * *"emits the same bytes whatever ORDER the roots arrive in"* pins that the
 * writer's `filesystem` table is order-independent, because `normalizeRuntimePaths`
 * sorts. It is the instrument that refuted C3.305's premise (applying
 * `orderAttachedRoots` here would have been dead code) and it fails the day the
 * writer starts honouring a caller's order — see that function's own docblock in
 * `packages/shared/src/config/primary-directory.ts` for the four candidate
 * readers and why each is refused.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import * as credentialsIndex from '../../credentials/index.ts'
import * as adapterPackage from '@nessy-agent/codex-responses-adapter'
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth'
import * as codexAgentServer from '@nessy-agent/codex-agent-server'
import * as additionalDirectories from '../additional-directories.ts'
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter'
import type { LlmConnection } from '../../config/storage.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts'

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4444 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-p3369' } } : {}
  }
  notify(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

const realCredentials = { ...credentialsIndex }
const realAdapter = { ...adapterPackage }
const realNestorAuth = { ...nestorAuth }
const realCodexAgentServer = { ...codexAgentServer }
const realAdditionalDirectories = { ...additionalDirectories }

/** Mutated per case; the mocked reader closes over it. */
let configuredRoots: string[] = []

mock.module('../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => ({ getLlmApiKey: async () => null }),
}))
mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (): Promise<AdapterHandle> => (
    { port: 46173, close: async () => { /* nothing bound */ } }
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
mock.module('../additional-directories.ts', () => ({
  ...realAdditionalDirectories,
  getConfiguredAdditionalDirectories: () => configuredRoots,
}))

afterAll(() => {
  mock.module('../../credentials/index.ts', () => realCredentials)
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter)
  mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => realNestorAuth)
  mock.module('@nessy-agent/codex-agent-server', () => realCodexAgentServer)
  mock.module('../additional-directories.ts', () => realAdditionalDirectories)
})

const { CodexAgent } = await import('../codex-agent.ts')
const { codexDriver } = await import('../backend/internal/drivers/codex.ts')

const MODEL = 'tgpt/qwen35-397b-a17b-fp8'
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'

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

function runtimeFor(): BackendRuntimePayload {
  return codexDriver.buildRuntime({
    context: {
      connection: connection(),
      provider: 'codex-runtime',
      resolvedModel: MODEL,
      capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {} as never,
    hostRuntime: {} as never,
    resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
  })
}

function agentConfig(ws = '/tmp/ws-p3369'): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-p3369',
      name: 'Test Workspace',
      rootPath: ws,
      workspaceRootPath: ws,
      sessionRootPath: join(ws, 'sessions'),
    } as never,
    session: {
      id: 'session-p3369',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: ws,
    } as never,
    runtime: runtimeFor(),
  } as BackendConfig
}

type PrivateAgent = { ensureRuntime: () => Promise<void>; codexHome: string | null }

const live: Array<{ destroy: () => void }> = []
const scratch: string[] = []
beforeEach(() => { live.length = 0; configuredRoots = [] })
afterEach(() => {
  for (const agent of live.splice(0)) agent.destroy()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p3369-root-'))
  scratch.push(dir)
  return dir
}

/** Boot the runtime and read the config.toml TEXT the app-server would be given. */
async function bootedConfigText(ws?: string): Promise<string> {
  const agent = new CodexAgent(agentConfig(ws))
  live.push(agent)
  await (agent as unknown as PrivateAgent).ensureRuntime()
  const home = (agent as unknown as PrivateAgent).codexHome
  expect(typeof home).toBe('string')
  return readFileSync(join(home!, 'config.toml'), 'utf8')
}

describe('P3.369 — an added directory is writable inside codex', () => {
  /**
   * THE ROW ITSELF. KILLS the shipped state, where this file read the setting in
   * zero lines and the profile carried no entry for it.
   */
  it('emits the added root as a `write` entry in the session permission profile', async () => {
    const root = scratchDir()
    configuredRoots = [root]
    const toml = await bootedConfigText()
    expect(toml).toContain('[permissions.nessy_runtime.filesystem]')
    expect(toml).toContain(`"${root}" = "write"`)
  })

  /**
   * NEGATIVE CONTROL on the same rig: with the setting empty, no grant appears.
   * Without it the case above would pass on a writer that granted everything.
   */
  it('grants nothing when the setting is empty', async () => {
    configuredRoots = []
    const toml = await bootedConfigText()
    expect(toml).not.toContain('= "write"')
  })

  /**
   * FAIL SHAPE 1. `normalizeRuntimePaths` throws `codex-writable-path-too-broad`
   * on a filesystem root, and that throw is inside `writeCodexConfig` — so
   * before this filter a settings typo would have killed the whole session.
   */
  it('drops a filesystem root instead of failing the session', async () => {
    const root = scratchDir()
    configuredRoots = [parse(root).root, root]
    const toml = await bootedConfigText()
    expect(toml).toContain(`"${root}" = "write"`)
    expect(toml).not.toContain(`"${parse(root).root}" = "write"`)
  })

  /**
   * C3.305 — the ROW THIS CASE REFUTES, pinned where the sort actually happens.
   *
   * W17-h proposed applying `orderAttachedRoots`
   * (`packages/shared/src/config/primary-directory.ts`) to
   * `codexAdditionalWritableRoots`, on the premise that it *"touches the codex
   * config writer's bytes"*. It does not: `normalizeRuntimePaths`
   * (`config-writer-permissions.ts`) ends in `.sort()`, so the writer's
   * `filesystem` table is alphabetical whatever order the caller hands it.
   *
   * Driven through the REAL writer rather than through that leaf, because the
   * claim being refuted is about the config on disk. Two roots whose basenames
   * sort the opposite way round to the order they are injected in; the second
   * arm injects the reverse and the two files must be byte-identical.
   *
   * Keep this case if the ordering ever looks attractive again: it is the
   * instrument that says whether it would do anything, and it fails the day the
   * writer starts honouring a caller's order.
   */
  it('emits the same bytes whatever ORDER the roots arrive in', async () => {
    const first = mkdtempSync(join(tmpdir(), 'p3369-zulu-'))
    const second = mkdtempSync(join(tmpdir(), 'p3369-alpha-'))
    scratch.push(first, second)

    configuredRoots = [first, second]
    const forward = await bootedConfigText()
    for (const agent of live.splice(0)) agent.destroy()

    configuredRoots = [second, first]
    const reverse = await bootedConfigText()

    // POSITIVE CONTROL first: both roots really are in the file, or "identical"
    // would be the identical absence of both.
    expect(forward).toContain(`"${first}" = "write"`)
    expect(forward).toContain(`"${second}" = "write"`)
    // The refutation. Not just the two lines — the whole config text.
    expect(reverse).toBe(forward)
    // And the table is SORTED, which is the mechanism behind it: `alpha` before
    // `zulu` in both arms, never the order either arm asked for.
    expect(forward.indexOf(`"${second}" = "write"`))
      .toBeLessThan(forward.indexOf(`"${first}" = "write"`))
  })

  /**
   * FAIL SHAPE 3, the widening one. The floor key must survive, and the grant
   * must not: `deny` beats `write` on codex's side, so emitting both would have
   * made `mapDeniedPathsToCodexFilesystemKeys` drop the FLOOR entry.
   */
  it('drops a root that collides with the credential floor, keeping the floor', async () => {
    // F1.1057 — the floor codex receives is the user's own deniedPaths (the shipped
    // one no longer reaches it), so the workspace names one, spelled like a shipped entry.
    const ws = scratchDir()
    writeFileSync(join(ws, 'permissions.json'), JSON.stringify({ deniedPaths: ['~/.ssh/**'] }))
    const agent = new CodexAgent(agentConfig(ws))
    live.push(agent)
    const patterns = (agent as unknown as { credentialFloorPatterns: () => string[] })
      .credentialFloorPatterns()
    agent.destroy()
    live.pop()
    const { mapDeniedPathsToCodexFilesystemKeys } = await import('@nessy-agent/codex-responses-adapter/config-writer')
    const [floorKey] = mapDeniedPathsToCodexFilesystemKeys(patterns, []).keys
    // The floor must be non-empty for this case to mean anything.
    expect(typeof floorKey).toBe('string')

    const home = process.env.HOME ?? ''
    const absoluteFloorKey = floorKey!.startsWith('~/') && home
      ? join(home, floorKey!.slice(2))
      : floorKey!
    configuredRoots = [absoluteFloorKey]
    const toml = await bootedConfigText(ws)
    expect(toml).not.toContain(`"${absoluteFloorKey}" = "write"`)
    // POSITIVE CONTROL: the floor entry it would have removed is still emitted.
    expect(toml).toContain(`"${floorKey}" = "deny"`)
  })

  it('F1.1057 — the floor handed to codex is the user\'s deniedPaths, never the shipped list', () => {
    const ws = scratchDir()
    writeFileSync(join(ws, 'permissions.json'), JSON.stringify({ deniedPaths: ['~/.ssh/**', '/srv/f1057/**'] }))
    const floorOf = (root: string) => {
      const agent = new CodexAgent(agentConfig(root))
      live.push(agent)
      return (agent as unknown as { credentialFloorPatterns: () => string[] }).credentialFloorPatterns()
    }
    // The user's two entries land, the one spelled like a shipped entry included.
    expect([...floorOf(ws)].sort()).toEqual(['/srv/f1057/**', '~/.ssh/**'])
    // A workspace with no file of its own gets nothing: the 24 shipped entries stay host-side.
    expect(floorOf(scratchDir())).toEqual([])
  })
})

/**
 * F1.671 — the thread signature recorded when the runtime opens its thread (the "seed" in
 * `createRuntime`) must describe the thread that exists, added roots included, or the FIRST turn
 * head's re-fork override (`applySelectedPluginSkillRuntimePolicy`, which carries the roots since
 * P3.369) reads a drift that is really the seed's omission and forks a thread for nothing.
 *
 * Driven through the real boot (`ensureRuntime` → `createRuntime`) and the real turn-head pair
 * (`resolveSelectedPluginSkillRuntimePolicy` → `applySelectedPluginSkillRuntimePolicy`), counting
 * the `thread/fork` requests the fake app-server receives.
 */
describe('F1.671 — the opened thread\'s signature carries the added roots', () => {
  type TurnHeadAgent = {
    client: { request: (method: string, ...rest: unknown[]) => Promise<unknown> }
    threadId: string | null
    resolveSelectedPluginSkillRuntimePolicy: () => unknown
    applySelectedPluginSkillRuntimePolicy: (policy: unknown) => Promise<void>
  }

  /** Boot a session, then count the forks each later turn head asks for. */
  async function bootCountingForks() {
    const agent = new CodexAgent(agentConfig())
    live.push(agent)
    await (agent as unknown as PrivateAgent).ensureRuntime()
    const home = (agent as unknown as PrivateAgent).codexHome!
    const turnHead = agent as unknown as TurnHeadAgent
    const booted = turnHead.client
    let forks = 0
    turnHead.client = {
      request: async (method: string, ...rest: unknown[]) => {
        if (method !== 'thread/fork') return booted.request(method, ...rest)
        forks += 1
        return { thread: { id: `thread-f1671-fork-${forks}` } }
      },
    }
    return {
      toml: readFileSync(join(home, 'config.toml'), 'utf8'),
      turn: () => turnHead.applySelectedPluginSkillRuntimePolicy(turnHead.resolveSelectedPluginSkillRuntimePolicy()),
      forks: () => forks,
      threadId: () => turnHead.threadId,
    }
  }

  it('a session with an added directory does not re-fork at its first turn', async () => {
    const root = scratchDir()
    configuredRoots = [root]
    const session = await bootCountingForks()
    // POSITIVE CONTROL: the root really is granted on the opened thread, so "no fork" is not vacuous.
    expect(session.toml).toContain(`"${root}" = "write"`)
    await session.turn()
    await session.turn()
    expect(session.forks()).toBe(0)
    expect(session.threadId()).toBe('thread-p3369')
  })

  it('CONTROL: a session without added directories does not re-fork either', async () => {
    configuredRoots = []
    const session = await bootCountingForks()
    expect(session.toml).not.toContain('= "write"')
    await session.turn()
    expect(session.forks()).toBe(0)
  })

  it('BOUNDARY: a directory added mid-session still re-forks once (P6.394), then settles', async () => {
    const root = scratchDir()
    const added = scratchDir()
    configuredRoots = [root]
    const session = await bootCountingForks()
    configuredRoots = [root, added]
    await session.turn()
    expect(session.forks()).toBe(1)
    expect(session.threadId()).toBe('thread-f1671-fork-1')
    await session.turn()
    expect(session.forks()).toBe(1)
  })
})
