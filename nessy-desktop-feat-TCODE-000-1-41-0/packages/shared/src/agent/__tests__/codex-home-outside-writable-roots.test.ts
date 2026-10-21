/**
 * F1.652 — the per-session `CODEX_HOME` lies outside every root an agent command
 * can write, so an agent cannot rewrite the rules and hooks codex reads from it.
 *
 * ## The reading this rests on (shipped `codex-app-server` `rust-v0.156.1`, 2026-09-25)
 *
 * `CODEX_HOME` holds `rules/nessy.rules` (the user's durable Always-Deny grants,
 * projected as `forbidden` prefixes — the only place they are enforced on codex:
 * the host's approval-bridge floor carries the non-negotiable floors, not those
 * grants) and `config.toml` (the host `[hooks]` command and its `[hooks.state]`
 * trust). It used to be a `mkdtemp` under `$TMPDIR`, which codex's `:workspace`
 * profile lets an agent command write with no card. Measured by WJ-crit-e
 * (`work/wjcrite/f1652-probe.ts`, model-driven turns against a stub upstream,
 * config from `writeCodexConfig`, every approval accepted = a bypass session):
 *
 * - the agent's `rm -f rules/nessy.rules && printf … > rules/agent.rules` exits
 *   0 and `rules/` then holds only the agent's file;
 * - the running thread keeps its policy (codex holds it in memory — codex-rs
 *   `core/src/exec_policy.rs`, `ExecPolicyManager`, loaded once per thread);
 * - but after the host's own `thread/fork` (`applySelectedPluginSkillRuntimePolicy`
 *   — `thread_manager.rs` forks with no `inherited_exec_policy`, so `rules/*` is
 *   read from disk again) the previously `forbidden` `mkdir` RUNS.
 *
 * The same probe with the home under a host directory outside every writable
 * root (arm C): the tamper is refused, `nessy.rules` is intact, an ordinary cwd
 * write works and the deny still holds.
 *
 * ## What this file pins
 *
 * - the home the PRODUCT builds (`createRuntime` → `newCodexHome`) is under the
 *   host root, outside every root `codexAgentWritableRoots` names, at 0700, the
 *   teardown removes it, and a full rebuild mints a fresh one in the same place;
 * - when the host root lies inside such a root that nothing shields (since F1.680: the host root
 *   outside the config dir, or a writable root inside the config dir; REAL paths, so a symlink
 *   does not pass), the home falls back to `$TMPDIR` and the session SAYS so on the facts channel;
 * - LIVE, on the shipped binary with the config.toml the product wrote: an agent
 *   command's write into that home's `rules/` and `config.toml` fails, a write in
 *   the project folder works (CONTROL), and the same write into a `$TMPDIR` home
 *   lands (the defect's mechanism — if it ever stops landing, codex has stopped
 *   granting `$TMPDIR` and the fallback is worth re-reading, not deleting).
 *
 * The rig lives under `~/.cache` rather than `tmpdir()`: `$TMPDIR` is itself one
 * of the roots, so a rig under it could never answer the question.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as credentialsIndex from '../../credentials/index.ts'
import * as adapterPackage from '@nessy-agent/codex-responses-adapter'
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth'
import * as codexAgentServer from '@nessy-agent/codex-agent-server'
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter'
import type { LlmConnection } from '../../config/storage.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts'
import { AppServer } from '../../../../codex-responses-adapter/src/__tests__/app-server-rig.ts'

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4652 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    if (method === 'thread/fork') return { thread: { id: 'thread-f1652-fork' } } // F1.1076 — a branch's build forks
    return method === 'thread/start' ? { thread: { id: 'thread-f1652' } } : {}
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
    { port: 46652, close: async () => { /* nothing bound */ } }
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

const { CodexAgent } = await import('../codex-agent.ts')
const { codexDriver } = await import('../backend/internal/drivers/codex.ts')

const MODEL = 'tgpt/qwen35-397b-a17b-fp8'
const FACT = 'codex-home-location'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const BIN = join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', `${process.platform}-${process.arch}`, 'codex-app-server')
const HAVE_BIN = existsSync(BIN) && process.platform !== 'win32'

// Under `~/.cache`, never `tmpdir()` — see the header.
mkdirSync(join(homedir(), '.cache'), { recursive: true })
const RIG = realpathSync(mkdtempSync(join(homedir(), '.cache', 'nessy-f1652-')))
const PROJECT = join(RIG, 'proj')
const WORKSPACE_ROOT = join(RIG, 'config', 'workspaces', 'ws-f1652')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(WORKSPACE_ROOT, { recursive: true })

afterAll(() => { rmSync(RIG, { recursive: true, force: true }) })

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

function agentConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-f1652',
      name: 'Test Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: 'session-f1652', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: PROJECT } as never,
    runtime: runtimeFor(),
  } as BackendConfig
}

interface PrivateAgent {
  ensureRuntime: () => Promise<void>
  disposeForRestart: () => Promise<void>
  teardownRuntime: () => Promise<void>
  destroy: () => void
  codexHome: string | null
  codexHomeRoot: string
  sessionFacts: Map<string, string>
  codexAgentWritableRoots: () => string[]
}

const live: PrivateAgent[] = []
afterEach(async () => {
  for (const agent of live.splice(0)) {
    await agent.disposeForRestart().catch(() => { /* already gone */ })
    agent.destroy()
  }
})

/** Boot the product's runtime build with its host root pointed at `root`; the home it made. */
async function boot(root: string): Promise<{ agent: PrivateAgent; home: string }> {
  const agent = new CodexAgent(agentConfig()) as unknown as PrivateAgent
  live.push(agent)
  agent.codexHomeRoot = root
  await agent.ensureRuntime()
  expect(typeof agent.codexHome).toBe('string')
  return { agent, home: agent.codexHome! }
}

const inside = (path: string, root: string): boolean => {
  let base: string
  try { base = realpathSync(root) } catch { base = root }
  const real = realpathSync(path)
  return real === base || real.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

describe('F1.652 — where the product puts the per-session CODEX_HOME', () => {
  it('under the host root, outside every agent-writable root, private, and removed at teardown', async () => {
    const root = join(RIG, 'config', 'codex-home')
    const { agent, home } = await boot(root)
    const roots = agent.codexAgentWritableRoots()
    // Non-vacuity: the roots are the real ones — the project folder and `$TMPDIR` are among them.
    expect(roots).toContain(PROJECT)
    expect(roots).toContain(tmpdir())
    expect(inside(home, root)).toBe(true)
    for (const writable of roots) expect(`${home} inside ${writable}: ${inside(home, writable)}`).toBe(`${home} inside ${writable}: false`)
    expect(basename(home).startsWith('nessy-codex-home-')).toBe(true)
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(realpathSync(root)).mode & 0o777).toBe(0o700)
    expect(existsSync(join(home, 'config.toml'))).toBe(true)
    expect(agent.sessionFacts.has(FACT)).toBe(false)
    await agent.teardownRuntime()
    expect(existsSync(home)).toBe(false)
    // CONTROL — a full rebuild (teardown, then the next runtime build) mints a FRESH home, in the same place.
    await agent.ensureRuntime()
    const rebuilt = agent.codexHome!
    expect(rebuilt).not.toBe(home)
    expect(inside(rebuilt, root)).toBe(true)
    expect(existsSync(join(rebuilt, 'config.toml'))).toBe(true)
  })

  it('FALLBACK — a host root inside the project folder: the home goes to $TMPDIR and the session says why', async () => {
    const root = join(PROJECT, '.config-under-cwd', 'codex-home')
    const { agent, home } = await boot(root)
    expect(inside(home, tmpdir())).toBe(true)
    expect(dirname(realpathSync(home))).toBe(realpathSync(tmpdir()))
    expect(basename(home).startsWith('nessy-codex-home-')).toBe(true)
    expect(statSync(home).mode & 0o777).toBe(0o700)
    const fact = agent.sessionFacts.get(FACT) ?? ''
    expect(fact).toContain('F1.652')
    expect(fact).toContain(PROJECT)
  })

  it('BOUNDARY — a host root that is a SYMLINK into the project folder does not pass (real paths are compared)', async () => {
    const target = join(PROJECT, 'symlinked-home-root')
    mkdirSync(target, { recursive: true })
    const link = join(RIG, 'config', 'codex-home-link')
    symlinkSync(target, link)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    const { agent, home } = await boot(link)
    expect(inside(home, tmpdir())).toBe(true)
    expect(agent.sessionFacts.get(FACT) ?? '').toContain('F1.652')
  })
})

describe.if(HAVE_BIN)('F1.652 — LIVE: an agent command against the home the product built (shipped codex-app-server)', () => {
  let server: AppServer | null = null
  let child: ChildProcessWithoutNullStreams | null = null
  const tmpHomes: string[] = []

  afterEach(() => {
    server?.kill()
    server = null
    child = null
    for (const dir of tmpHomes.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function start(home: string): Promise<AppServer> {
    child = spawn(BIN, [], {
      cwd: PROJECT,
      env: { ...process.env, CODEX_HOME: home, COMPANY_LLM_API_KEY: 'loopback' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    server = new AppServer(child, { requestTimeoutMs: 120_000 })
    await server.request('initialize', {
      clientInfo: { name: 'nessy-f1652', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    server.notify('initialized')
    // A rejected profile fails OPEN and would make every refusal below meaningless.
    const listed = await server.request('permissionProfile/list', {}, 60_000) as { data?: { id?: string; allowed?: boolean }[] }
    expect(listed.data?.find(p => p.id === 'nessy_runtime')?.allowed).toBe(true)
    return server
  }

  const sh = async (s: AppServer, script: string): Promise<number | null> => {
    const r = await s.request('command/exec', { command: ['/bin/sh', '-c', script], cwd: PROJECT, timeoutMs: 15_000 }, 60_000) as {
      exitCode?: number | null
    }
    return r.exitCode ?? null
  }
  const q = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`

  it('the write into rules/ and config.toml is refused; a project write works (CONTROL)', async () => {
    const { home } = await boot(join(RIG, 'config', 'codex-home-live'))
    const configBefore = readFileSync(join(home, 'config.toml'), 'utf8')
    const s = await start(home)
    const rule = join(home, 'rules', 'agent.rules')
    const tamper = await sh(s, `mkdir -p ${q(join(home, 'rules'))} && printf '%s\\n' 'prefix_rule(pattern=["mkdir"], decision="allow")' > ${q(rule)}`)
    expect(tamper).not.toBe(0)
    expect(existsSync(rule)).toBe(false)
    const hooks = await sh(s, `printf '\\n[hooks]\\n' >> ${q(join(home, 'config.toml'))}`)
    expect(hooks).not.toBe(0)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(configBefore)
    expect(await sh(s, `printf ok > ${q(join(PROJECT, 'control-write'))}`)).toBe(0)
    expect(readFileSync(join(PROJECT, 'control-write'), 'utf8')).toBe('ok')
    expect(s.serverRequests).toEqual([])
  }, 240_000)

  it('the defect’s mechanism — the same write into a $TMPDIR home LANDS', async () => {
    const { home: productHome } = await boot(join(RIG, 'config', 'codex-home-mechanism'))
    const home = mkdtempSync(join(tmpdir(), 'nessy-codex-home-f1652-'))
    tmpHomes.push(home)
    writeFileSync(join(home, 'config.toml'), readFileSync(join(productHome, 'config.toml'), 'utf8'))
    const s = await start(home)
    const rule = join(home, 'rules', 'agent.rules')
    expect(await sh(s, `mkdir -p ${q(join(home, 'rules'))} && printf x > ${q(rule)}`)).toBe(0)
    expect(existsSync(rule)).toBe(true)
  }, 240_000)
})

describe('F1.652 — the live arm says when it did not run', () => {
  it('names the binary it looked for', () => {
    if (!HAVE_BIN) console.warn(`[f1652-live] SKIPPED: no codex binary at ${BIN} (or win32).`)
    expect(typeof HAVE_BIN).toBe('boolean')
  })
})

// ================================================================ F1.681 — a crashed host's home is swept

/** A pid no process holds: a child that has exited and been reaped. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>(resolve => child.on('exit', () => resolve()))
  return pid
}

describe('F1.681 — a runtime build sweeps the CODEX_HOMEs a host process no longer running left behind', () => {
  it('FAILING ARM: a dead host\'s home (rollout inside) is removed, and the new home is minted with this process\'s pid', async () => {
    const root = join(RIG, 'config-f1681', 'codex-home')
    const dead = join(root, `nessy-codex-home-${await deadPid()}-a1B2c3`)
    mkdirSync(join(dead, 'sessions', '2026', '09', '28'), { recursive: true })
    writeFileSync(join(dead, 'sessions', '2026', '09', '28', 'rollout-x.jsonl'), '{}\n')
    const { home } = await boot(root)
    expect(existsSync(dead)).toBe(false)
    expect(basename(home).startsWith(`nessy-codex-home-${process.pid}-`)).toBe(true)
  })

  it('BOUNDARY: a live pid\'s home, a pid-less name, a file and another prefix are kept', async () => {
    const root = join(RIG, 'config-f1681-keep', 'codex-home')
    const gone = await deadPid()
    const kept = [
      join(root, `nessy-codex-home-${process.pid}-live01`), // a sibling session of this host process
      join(root, `nessy-codex-home-${process.ppid}-live02`), // another live process
      join(root, 'nessy-codex-home-Zx9Qw1'), // a pre-row name: no pid, never parsed as one
      join(root, `other-prefix-${gone}-x`), // not a codex home
    ]
    for (const dir of kept) mkdirSync(dir, { recursive: true })
    const file = join(root, `nessy-codex-home-${gone}-file01`)
    writeFileSync(file, 'not a directory')
    await boot(root)
    for (const path of [...kept, file]) expect(`${basename(path)} ${existsSync(path)}`).toBe(`${basename(path)} true`)
  })
})

// ================================================================ F1.1074 — the session's rollouts outlive the build

describe('F1.1074 — each runtime build links the session\'s kept rollout tree into its fresh home', () => {
  it('FAILING ARM: sessions/ links to the session\'s kept tree (0700, beside the homes), which survives the teardown and the F1.681 sweep, and the rebuild links the same tree', async () => {
    const root = join(RIG, 'config-f1074', 'codex-home')
    const { agent, home } = await boot(root)
    const link = join(home, 'sessions')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    const kept = realpathSync(link)
    expect(dirname(kept)).toBe(realpathSync(root))
    expect(basename(kept)).toBe('nessy-codex-sessions-ws-f1652--session-f1652')
    expect(statSync(kept).mode & 0o777).toBe(0o700)
    for (const writable of agent.codexAgentWritableRoots()) expect(`${kept} inside ${writable}: ${inside(kept, writable)}`).toBe(`${kept} inside ${writable}: false`)
    // What codex writes through the link (the live shape: `codex-resume-after-rebuild-live.test.ts`).
    mkdirSync(join(kept, '2026', '09', '29'), { recursive: true })
    writeFileSync(join(kept, '2026', '09', '29', 'rollout-t.jsonl'), '{}\n')
    await agent.teardownRuntime()
    expect(existsSync(home)).toBe(false)
    expect(existsSync(join(kept, '2026', '09', '29', 'rollout-t.jsonl'))).toBe(true)
    // The rebuild sweeps (F1.681) and mints a fresh home, which links the SAME tree.
    await agent.ensureRuntime()
    const rebuilt = agent.codexHome!
    expect(rebuilt).not.toBe(home)
    expect(realpathSync(join(rebuilt, 'sessions'))).toBe(kept)
    expect(existsSync(join(rebuilt, 'sessions', '2026', '09', '29', 'rollout-t.jsonl'))).toBe(true)
  })

  it('BOUNDARY: another session links another tree, no session key links none, the $TMPDIR fallback links none, and removing one session\'s tree keeps the other', async () => {
    const { linkCodexKeptSessions, removeCodexKeptSessions } = await import('../backend/codex/host-owned-dirs.ts')
    const root = join(RIG, 'config-f1074-b', 'codex-home')
    const { home } = await boot(root)
    const other = new CodexAgent({ ...agentConfig(), session: { id: 'session-other', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: PROJECT } as never }) as unknown as PrivateAgent
    live.push(other)
    other.codexHomeRoot = root
    await other.ensureRuntime()
    const mine = realpathSync(join(home, 'sessions'))
    const theirs = realpathSync(join(other.codexHome!, 'sessions'))
    expect(theirs).not.toBe(mine)
    expect(basename(theirs)).toBe('nessy-codex-sessions-ws-f1652--session-other')
    // No session key: nothing is linked, and the home keeps codex's own sessions/.
    const bare = mkdtempSync(join(RIG, 'bare-home-'))
    expect(linkCodexKeptSessions(bare, root, { workspaceId: 'ws-f1652' })).toBe(null)
    expect(existsSync(join(bare, 'sessions'))).toBe(false)
    // The $TMPDIR fallback (F1.652) keeps nothing beside an agent-writable home.
    const fallback = await boot(join(PROJECT, '.config-under-cwd-f1074', 'codex-home'))
    expect(inside(fallback.home, tmpdir())).toBe(true)
    expect(existsSync(join(fallback.home, 'sessions'))).toBe(false)
    // Session deletion's call: one tree goes, the other stays.
    expect(removeCodexKeptSessions('ws-f1652', 'session-other', root)).toBe(true)
    expect(existsSync(theirs)).toBe(false)
    expect(existsSync(mine)).toBe(true)
  })
})

describe('F1.1181 — the kept-tree link is a junction on Windows', () => {
  // A Windows `'dir'` symlink needs SeCreateSymbolicLinkPrivilege or Developer Mode, so an ordinary user's link threw EPERM
  // and nothing was kept; a junction needs neither. Off Windows the type is ignored and the F1.1074 arms above link for real.
  it('FAILING ARM: win32 links with a junction', async () => {
    const { codexKeptSessionsLinkType } = await import('../backend/codex/host-owned-dirs.ts')
    expect(codexKeptSessionsLinkType('win32')).toBe('junction')
  })
  it('BOUNDARY: every other platform keeps the directory symlink, and the default reads this process\'s platform', async () => {
    const { codexKeptSessionsLinkType } = await import('../backend/codex/host-owned-dirs.ts')
    expect([codexKeptSessionsLinkType('darwin'), codexKeptSessionsLinkType('linux')]).toEqual(['dir', 'dir'])
    expect(codexKeptSessionsLinkType()).toBe(process.platform === 'win32' ? 'junction' : 'dir')
  })
})

describe('F1.1076 — a branch\'s kept folder is seeded with the parent session\'s rollout of the branched thread', () => {
  it('FAILING ARM: the child\'s build copies exactly that thread\'s rollout, at codex\'s own relative path, and leaves the parent\'s file', async () => {
    const root = join(RIG, 'config-f1076', 'codex-home')
    const parentKept = join(root, 'nessy-codex-sessions-ws-f1652--session-parent')
    const day = join('2026', '09', '29')
    mkdirSync(join(parentKept, day), { recursive: true })
    writeFileSync(join(parentKept, day, 'rollout-2026-09-29T01-00-00-thread-p1.jsonl'), '{"parent":1}\n')
    writeFileSync(join(parentKept, day, 'rollout-2026-09-29T01-05-00-thread-p2.jsonl'), '{"other":2}\n')
    const child = new CodexAgent({ ...agentConfig(), session: {
      id: 'session-branch', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: PROJECT,
      branchFrom: { parent: { workspaceId: 'ws-f1652', sessionId: 'session-parent' }, sdkSessionId: 'thread-p1' },
    } as never }) as unknown as PrivateAgent
    live.push(child)
    child.codexHomeRoot = root
    await child.ensureRuntime()
    const kept = realpathSync(join(child.codexHome!, 'sessions'))
    expect(basename(kept)).toBe('nessy-codex-sessions-ws-f1652--session-branch')
    expect(readFileSync(join(kept, day, 'rollout-2026-09-29T01-00-00-thread-p1.jsonl'), 'utf8')).toBe('{"parent":1}\n')
    expect(existsSync(join(kept, day, 'rollout-2026-09-29T01-05-00-thread-p2.jsonl'))).toBe(false)
    expect(existsSync(join(parentKept, day, 'rollout-2026-09-29T01-00-00-thread-p1.jsonl'))).toBe(true)
  })

  it('BOUNDARY: a second seed copies nothing, no parent key or the session\'s own folder copies nothing, and a parent with no rollout of the thread copies nothing', async () => {
    const { seedCodexBranchRollout } = await import('../backend/codex/host-owned-dirs.ts')
    const root = join(RIG, 'config-f1076-b', 'codex-home')
    const parentKept = join(root, 'nessy-codex-sessions-ws--parent')
    mkdirSync(join(parentKept, 'd'), { recursive: true })
    writeFileSync(join(parentKept, 'd', 'rollout-x-thread-q.jsonl'), '{}\n')
    const kept = join(root, 'nessy-codex-sessions-ws--child')
    mkdirSync(kept, { recursive: true })
    const anchor = { parent: { workspaceId: 'ws', sessionId: 'parent' }, sdkSessionId: 'thread-q' }
    expect(seedCodexBranchRollout(kept, root, anchor)).toBe(1)
    expect(seedCodexBranchRollout(kept, root, anchor)).toBe(0)
    expect(seedCodexBranchRollout(kept, root, undefined)).toBe(0)
    expect(seedCodexBranchRollout(kept, root, { sdkSessionId: 'thread-q' })).toBe(0)
    expect(seedCodexBranchRollout(parentKept, root, anchor)).toBe(0)
    const said: string[] = []
    expect(seedCodexBranchRollout(join(root, 'nessy-codex-sessions-ws--other'), root, { ...anchor, sdkSessionId: 'thread-none' }, line => said.push(line))).toBe(0)
    expect(said.join('\n')).toContain('holds no rollout of thread thread-none')
  })
})
