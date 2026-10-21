/**
 * F1.680 — the per-session `CODEX_HOME` stays under the host root `<config dir>/codex-home`
 * when a writable root contains that root but F1.664's config-dir projection keeps agent
 * commands out of it; the `$TMPDIR` fallback (F1.652's, tamperable) is kept only where
 * neither holds.
 *
 * ## Why
 *
 * F1.652 (`newCodexHome`) accepted the host root only when it lay OUTSIDE every agent-writable
 * root, and otherwise fell back to a `$TMPDIR` home an agent command can rewrite with no card —
 * `rules/nessy.rules` (the durable Always-Deny grants) included, re-read at the host's next
 * `thread/fork`. That fallback was taken exactly when the project folder contains the config
 * dir (the home directory as the project), which is where F1.664 (`codexConfigDirProjection`)
 * now makes the whole config dir read-only to agent commands. So the fallback was the only
 * tamperable home left, in the layout the projection already protects.
 *
 * ## The reading this rests on (shipped `codex-app-server` `rust-v0.156.1`, 2026-09-25)
 *
 * `work/wjcritn/f1680-probe.ts` (WJ-crit-i's probe re-armed): config from `writeCodexConfig`
 * carrying the product's projection, a durable deny `mkdir`, model-driven turns against a stub
 * upstream, every approval ACCEPTED (a bypass session), home under `<config>/codex-home`:
 *
 * - home as the project, `~/.nessy-agent` and a relocated `~/.nessy-agent-sit` (the cwd's
 *   `read` subpath carrier): the agent's `rm rules/nessy.rules && printf … > rules/agent.rules`
 *   is refused and `nessy.rules` is intact, a cwd write works, the deny holds — and all three
 *   still hold after the host's own `thread/fork`;
 * - the project IS the config dir (`"." = "read"`): the tamper is refused and the deny holds
 *   (a cwd write is refused too — F1.664's stated posture for that layout);
 * - home ADDED as a directory, project beside (the absolute `deny` carrier, so agent commands
 *   cannot even read the home): commands still run — a cwd write works before and after the
 *   fork — the tamper is refused and the deny holds;
 * - CONTROL, the non-home layout: the resolver accepts the host root with no projection, and
 *   the same readings hold.
 *
 * ## What this file pins
 *
 * The home the PRODUCT builds (`createRuntime` → `newCodexHome`) in each carrier's layout, the
 * non-home CONTROL, the fallback where the projection does not reach the host root, and the pure
 * rule {@link codexConfigDirProjectionShields} over its boundaries. `CONFIG_DIR` is the isolate
 * preload's (under `$TMPDIR`), so the read-carrier arms point `TMPDIR` at a rig under `~/.cache`
 * for the runtime build — otherwise `$TMPDIR` would also carry the deny and the read carrier
 * could never be seen alone.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import * as credentialsIndex from '../../credentials/index.ts'
import * as adapterPackage from '@nessy-agent/codex-responses-adapter'
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth'
import * as codexAgentServer from '@nessy-agent/codex-agent-server'
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter'
import type { LlmConnection } from '../../config/storage.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts'
import { CONFIG_DIR } from '../../config/paths.ts'

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4680 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-f1680' } } : {}
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
    { port: 46680, close: async () => { /* nothing bound */ } }
  ),
}))
// Both creds readers, from one literal — a spread isolates only the names it lists.
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

const codexAgentModule = await import('../codex-agent.ts')
const { CodexAgent } = codexAgentModule
const { codexDriver } = await import('../backend/internal/drivers/codex.ts')

const MODEL = 'tgpt/qwen35-397b-a17b-fp8'
const FACT = 'codex-home-location'
const HOST_ROOT = join(CONFIG_DIR, 'codex-home')

/**
 * F1.59 CI (MR !49 rows 5–7) — the deny that `/tmp` ALONE earns for this run's config dir.
 * `/tmp` is a codex writable root the build cannot move (`codexAgentWritableRoots`: codex's
 * `:workspace` default, `exclude_slash_tmp` false), unlike `$TMPDIR`, which the read-carrier arms
 * point at the rig. On macOS the isolate preload's config dir is under `/var/folders/…`, so this is
 * `[]` and every arm below asserts exactly what it did before. On the Linux CI runner (`TMPDIR`
 * unset, so the preload's config dir is `/tmp/nessy-shared-tests-config-…`) `/tmp` itself contains
 * the config dir and the product CORRECTLY denies it (F1.664): the read carrier cannot be seen
 * alone there, so the read arms also ask the rule whether the product's own read entry, stripped of
 * that deny, shields the host root from the cwd — a claim that holds on every layout.
 */
const SLASH_TMP_DENY = codexAgentModule.codexConfigDirProjection('', CONFIG_DIR, undefined, ['/tmp']).deny
const shieldsRule = (codexAgentModule as Record<string, unknown>).codexConfigDirProjectionShields as (
  dir: string, root: string, workingDirectory: string, configDir: string,
  projection: { subpaths: readonly string[]; deny: readonly string[] },
) => boolean

// Under `~/.cache`, never `tmpdir()`: `$TMPDIR` is itself one of the roots.
mkdirSync(join(homedir(), '.cache'), { recursive: true })
const RIG = realpathSync(mkdtempSync(join(homedir(), '.cache', 'nessy-f1680-')))
const PROJECT = join(RIG, 'proj')
const RIG_TMP = join(RIG, 'tmp')
const WORKSPACE_ROOT = join(RIG, 'config', 'workspaces', 'ws-f1680')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(RIG_TMP, { recursive: true })
mkdirSync(WORKSPACE_ROOT, { recursive: true })
const scratch: string[] = []

afterAll(() => {
  rmSync(RIG, { recursive: true, force: true })
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function runtimeFor(): BackendRuntimePayload {
  return codexDriver.buildRuntime({
    context: {
      connection: {
        slug: 'nessy-codex',
        name: 'Nessy Codex',
        providerType: 'codex-runtime',
        authType: 'api_key_with_endpoint',
        baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
        defaultModel: MODEL,
        createdAt: Date.now(),
      } as LlmConnection,
      provider: 'codex-runtime',
      resolvedModel: MODEL,
      capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {} as never,
    hostRuntime: {} as never,
    resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
  })
}

function agentConfig(workingDirectory: string): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-f1680',
      name: 'Test Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: 'session-f1680', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory } as never,
    runtime: runtimeFor(),
  } as BackendConfig
}

interface PrivateAgent {
  ensureRuntime: () => Promise<void>
  disposeForRestart: () => Promise<void>
  destroy: () => void
  codexHome: string | null
  codexHomeRoot: string
  sessionFacts: Map<string, string>
  codexAgentWritableRoots: () => string[]
  configDirProjection: () => { subpaths: string[]; deny: string[] }
}

const live: PrivateAgent[] = []
afterEach(async () => {
  for (const agent of live.splice(0)) {
    await agent.disposeForRestart().catch(() => { /* already gone */ })
    agent.destroy()
  }
})

interface Booted {
  agent: PrivateAgent
  home: string
  /** Read DURING the build, under its `TMPDIR` — after it, `tmpdir()` answers the restored one. */
  roots: string[]
  projection: { subpaths: string[]; deny: string[] }
}

/**
 * Boot the product's runtime build with `cwd` as the project folder. `tmp` (when given) is the
 * `TMPDIR` for the build, restored after it; `root` (when given) moves the host root.
 */
async function boot(cwd: string, opts: { tmp?: string; root?: string } = {}): Promise<Booted> {
  const agent = new CodexAgent(agentConfig(cwd)) as unknown as PrivateAgent
  live.push(agent)
  if (opts.root) agent.codexHomeRoot = opts.root
  const saved = process.env.TMPDIR
  if (opts.tmp) process.env.TMPDIR = opts.tmp
  let roots: string[] = []
  let projection = { subpaths: [] as string[], deny: [] as string[] }
  try {
    if (opts.tmp) expect(tmpdir()).toBe(opts.tmp)
    await agent.ensureRuntime()
    roots = agent.codexAgentWritableRoots()
    projection = agent.configDirProjection()
  } finally {
    if (opts.tmp) {
      delete process.env.TMPDIR
      if (saved !== undefined) process.env.TMPDIR = saved
    }
  }
  expect(typeof agent.codexHome).toBe('string')
  return { agent, home: agent.codexHome!, roots, projection }
}

const inside = (path: string, root: string): boolean => {
  let base: string
  try { base = realpathSync(root) } catch { base = root }
  const real = realpathSync(path)
  return real === base || real.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/** The home is a fresh private `mkdtemp` under the host root, and the session records no fallback. */
function expectUnderHostRoot(agent: PrivateAgent, home: string): void {
  expect(`${home} under ${HOST_ROOT}: ${inside(home, HOST_ROOT)}`).toBe(`${home} under ${HOST_ROOT}: true`)
  expect(basename(home).startsWith('nessy-codex-home-')).toBe(true)
  expect(statSync(home).mode & 0o777).toBe(0o700)
  expect(existsSync(join(home, 'config.toml'))).toBe(true)
  expect(agent.sessionFacts.get(FACT) ?? '(no fact)').toBe('(no fact)')
}

describe('F1.680 — the product keeps CODEX_HOME under the host root when the config-dir projection covers it', () => {
  it('READ carrier — the project folder CONTAINS the config dir (home as the project, a relocated name)', async () => {
    const cwd = dirname(CONFIG_DIR)
    const { agent, home, roots, projection } = await boot(cwd, { tmp: RIG_TMP })
    // Non-vacuity: the cwd contains the host root (so F1.652's resolver alone withholds it), and
    // the projection carries ONLY the cwd-relative read entry here.
    expect(inside(HOST_ROOT, cwd)).toBe(true)
    expect(roots).toContain(cwd)
    expect(projection.subpaths).toEqual([basename(CONFIG_DIR)])
    expect(projection.deny).toEqual(SLASH_TMP_DENY)
    expect(shieldsRule(realpathSync(HOST_ROOT), cwd, cwd, CONFIG_DIR, { subpaths: projection.subpaths, deny: [] })).toBe(true)
    expectUnderHostRoot(agent, home)
  })

  it('READ carrier — the project folder IS the config dir ("." = "read")', async () => {
    const { agent, home, projection } = await boot(CONFIG_DIR, { tmp: RIG_TMP })
    expect(projection.subpaths).toEqual(['.'])
    expect(projection.deny).toEqual(SLASH_TMP_DENY)
    expect(shieldsRule(realpathSync(HOST_ROOT), CONFIG_DIR, CONFIG_DIR, CONFIG_DIR, { subpaths: projection.subpaths, deny: [] })).toBe(true)
    expectUnderHostRoot(agent, home)
  })

  it('DENY carrier — the config dir under $TMPDIR (another writable root): the absolute deny covers it', async () => {
    const { agent, home, roots, projection } = await boot(PROJECT)
    // A writable root other than the cwd holds the host root: `$TMPDIR` under the isolate preload,
    // or `/tmp` where the config dir was put there without `TMPDIR` pointing at it.
    expect(roots.filter(root => root !== PROJECT).some(root => inside(HOST_ROOT, root))).toBe(true)
    expect(projection.subpaths).toEqual([])
    expect(projection.deny.length).toBeGreaterThan(0)
    expectUnderHostRoot(agent, home)
  })

  it('CONTROL — the non-home layout: no root contains the host root, no projection, the home is there as before', async () => {
    const { agent, home, roots, projection } = await boot(PROJECT, { tmp: RIG_TMP })
    expect(roots).toContain(RIG_TMP)
    // `/tmp` holds the host root only where it holds the config dir (the Linux CI layout,
    // SLASH_TMP_DENY non-empty): there the non-home layout does not exist in-process, and this
    // arm reads as the `/tmp` deny carrier. Every other root must hold nothing, on every layout.
    const slashTmpHolds = SLASH_TMP_DENY.length > 0
    for (const root of roots) {
      const expected = root === '/tmp' && slashTmpHolds
      expect(`${root}: ${inside(HOST_ROOT, root)}`).toBe(`${root}: ${expected}`)
    }
    expect(projection).toEqual({ subpaths: [], deny: SLASH_TMP_DENY })
    expectUnderHostRoot(agent, home)
  })

  it('FALLBACK kept — a host root under the project folder but OUTSIDE the config dir: the read entry does not reach it', async () => {
    const cwd = dirname(CONFIG_DIR)
    const outside = mkdtempSync(join(cwd, 'nessy-f1680-not-config-'))
    scratch.push(outside)
    const { agent, home, projection } = await boot(cwd, { tmp: RIG_TMP, root: join(outside, 'codex-home') })
    expect(projection.subpaths).toEqual([basename(CONFIG_DIR)])
    expect(dirname(realpathSync(home))).toBe(realpathSync(RIG_TMP))
    expect(basename(home).startsWith('nessy-codex-home-')).toBe(true)
    const fact = agent.sessionFacts.get(FACT) ?? ''
    expect(fact).toContain('F1.652')
    expect(fact).toContain(cwd)
  })
})

describe('F1.680 — codexConfigDirProjectionShields, the rule', () => {
  const shields = (codexAgentModule as Record<string, unknown>).codexConfigDirProjectionShields as (
    dir: string, root: string, workingDirectory: string, configDir: string,
    projection: { subpaths: readonly string[]; deny: readonly string[] },
  ) => boolean
  const home = join(RIG, 'rule', 'home')
  const config = join(home, '.nessy-agent-sit')
  const dir = join(config, 'codex-home')
  const project = join(RIG, 'rule', 'proj')
  mkdirSync(dir, { recursive: true })
  mkdirSync(project, { recursive: true })

  it('is exported', () => {
    expect(typeof shields).toBe('function')
  })

  it('the cwd-relative read entry shields the host root from the cwd that contains the config dir', () => {
    expect(shields(dir, home, home, config, { subpaths: ['.nessy-agent-sit'], deny: [] })).toBe(true)
  })

  it('"." shields everything under the cwd', () => {
    expect(shields(dir, config, config, config, { subpaths: ['.'], deny: [] })).toBe(true)
  })

  it('BOUNDARY — a read entry never shields from a root that is not the cwd (codex resolves it against the cwd only)', () => {
    expect(shields(dir, home, project, config, { subpaths: ['.nessy-agent-sit'], deny: [] })).toBe(false)
  })

  it('BOUNDARY — a read entry for the config dir does not shield a host root outside it', () => {
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    expect(shields(elsewhere, home, home, config, { subpaths: ['.nessy-agent-sit'], deny: [] })).toBe(false)
  })

  it('an absolute deny strictly below the root shields the host root from that root', () => {
    expect(shields(dir, home, project, config, { subpaths: [], deny: [config] })).toBe(true)
  })

  it('BOUNDARY — a writable root INSIDE the denied path is more specific and wins', () => {
    expect(shields(dir, dir, project, config, { subpaths: [], deny: [config] })).toBe(false)
    expect(shields(dir, config, project, config, { subpaths: [], deny: [config] })).toBe(false)
  })

  it('CONTROL — an empty projection shields nothing', () => {
    expect(shields(dir, home, home, config, { subpaths: [], deny: [] })).toBe(false)
  })
})
