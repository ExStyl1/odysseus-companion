/**
 * F1.192 — the codex credential floor is anchored on the LATCHED home when the
 * codex child will expand `~` against a different one.
 *
 * ## The defect, measured before this file existed
 *
 * `CodexAgent.credentialFloorPatterns` hands the shipped `deniedPaths` to the
 * config writer as written — `~/.nessy/**`, `~/.ssh/**`, … — and the writer
 * emits them as `~/`-anchored keys (`"~/.nessy" = "deny"`). codex compiles such a
 * key with ITS OWN home: read at `rust-v0.154.0`, `AbsolutePathBuf::from_absolute_path`
 * (`codex-rs/utils/absolute-path/src/lib.rs`, `maybe_expand_home_directory`)
 * splices in `dirs::home_dir()`, the child's `HOME`. The app-server is spawned
 * with `{ ...process.env, … }`, so once `applyManagedEnv` writes a confirmed
 * administrator `HOME` the next spawn protects `<managed home>/.nessy` while the
 * gateway JWT stays under the latch (`getCredsPath`, P3.143).
 *
 * Measured 2026-09-23 with the VENDORED `codex-app-server` and fake creds files
 * (never the real one): `HOME=<managed>` with `"~/.nessy" = "deny"` →
 * `command/exec cat <latched>/.nessy/dp_auth_creds.json` exit 0, the fake token
 * printed; the absolute latched key → refused. The binary half is pinned by
 * `codex-responses-adapter`'s `credential-floor-managed-home-live.test.ts`; this
 * file pins the HOST half — that `CodexAgent` emits the absolute key.
 *
 * F1.1057 (owner decision 2026-09-28) — codex no longer receives the SHIPPED floor, so
 * the anchoring is driven by a workspace `deniedPaths` entry of the user's own, spelled
 * exactly like the shipped `~/.nessy/**` and `~/.ssh/**` (the by-layer reading keeps it);
 * the last case pins that without such an entry none of the shipped keys, and no
 * `credentials.enc` deny, reaches codex at all.
 *
 * Hermetic, on the shape of `codex-additional-directories.test.ts`: credentials,
 * the adapter launcher, the app-server and the dp-creds readers are faked, every
 * `mock.module` spreads the real namespace and is restored from the SAME snapshot.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CONFIG_DIR } from '../../config/paths.ts'
import * as credentialsIndex from '../../credentials/index.ts'
import * as adapterPackage from '@nessy-agent/codex-responses-adapter'
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth'
import * as codexAgentServer from '@nessy-agent/codex-agent-server'
import { latchedHomeDir, relatchHomeDirForTests } from '../../config/home-latch.ts'
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter'
import type { LlmConnection } from '../../config/storage.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts'

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4445 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-f1192' } } : {}
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
    { port: 46174, close: async () => { /* nothing bound */ } }
  ),
}))
// Both creds readers, from one literal — a spread isolates only the names it
// lists, and the un-stubbed sibling would read the developer's real file.
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
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'

function runtimeFor(): BackendRuntimePayload {
  return codexDriver.buildRuntime({
    context: {
      connection: {
        slug: 'nessy-codex',
        name: 'Nessy Codex',
        providerType: 'codex-runtime',
        authType: 'api_key_with_endpoint',
        baseUrl: GATEWAY_BASE_URL,
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

/** F1.1057 — a workspace whose own permissions.json repeats two shipped entries. */
const USER_WS = mkdtempSync(join(tmpdir(), 'f1192-ws-'))
writeFileSync(join(USER_WS, 'permissions.json'), JSON.stringify({ deniedPaths: ['~/.nessy/**', '~/.ssh/**'] }))
/** F1.1057 — a workspace with no permissions.json: only the shipped floor would apply. */
const BARE_WS = mkdtempSync(join(tmpdir(), 'f1192-bare-'))
afterAll(() => { for (const dir of [USER_WS, BARE_WS]) rmSync(dir, { recursive: true, force: true }) })

function agentConfig(ws: string = USER_WS): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-f1192',
      name: 'Test Workspace',
      rootPath: ws,
      workspaceRootPath: ws,
      sessionRootPath: join(ws, 'sessions'),
    } as never,
    session: {
      id: 'session-f1192',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: ws,
    } as never,
    runtime: runtimeFor(),
  } as BackendConfig
}

type PrivateAgent = { ensureRuntime: () => Promise<void>; codexHome: string | null }

/** A latched home that is NOT this process's `HOME` — nothing is read from it. */
const LATCHED = '/tmp/f1192-latched-home'
const MANAGED = '/tmp/f1192-managed-home'

const startupHome = process.env.HOME
const live: Array<{ destroy: () => void }> = []

/** `delete` before assign — AGENTS.md: an assigned slot can be invisible to a spread. */
function setChildHome(value: string | undefined): void {
  delete process.env.HOME
  if (value !== undefined) process.env.HOME = value
}

beforeEach(() => { live.length = 0 })
afterEach(() => {
  for (const agent of live.splice(0)) agent.destroy()
  setChildHome(startupHome)
  relatchHomeDirForTests()
})

async function bootedConfigText(ws?: string): Promise<string> {
  const agent = new CodexAgent(agentConfig(ws))
  live.push(agent)
  await (agent as unknown as PrivateAgent).ensureRuntime()
  const home = (agent as unknown as PrivateAgent).codexHome
  expect(typeof home).toBe('string')
  return readFileSync(join(home!, 'config.toml'), 'utf8')
}

describe('F1.192 — the codex credential floor follows the latched home, not the child HOME', () => {
  it('a moved HOME: the gateway-JWT floor key is the ABSOLUTE latched path', async () => {
    relatchHomeDirForTests(LATCHED)
    setChildHome(MANAGED)
    expect(latchedHomeDir()).toBe(LATCHED)
    const toml = await bootedConfigText()
    expect(toml).toContain(`"${LATCHED}/.nessy" = "deny"`)
    expect(toml).toContain(`"${LATCHED}/.ssh" = "deny"`)
    // The `~/` spelling codex would expand with the MANAGED home is gone.
    expect(toml).not.toContain('"~/.nessy" = "deny"')
    // Nothing is anchored on the managed home either.
    expect(toml).not.toContain(MANAGED)
  })

  it('CONTROL — HOME unmoved: the keys stay `~/`-anchored, exactly as before', async () => {
    relatchHomeDirForTests(LATCHED)
    setChildHome(LATCHED)
    const toml = await bootedConfigText()
    expect(toml).toContain('"~/.nessy" = "deny"')
    expect(toml).toContain('"~/.ssh" = "deny"')
    expect(toml).not.toContain(`"${LATCHED}/.nessy"`)
  })

  it('F1.1057 — without a user entry, no shipped floor key and no credentials.enc deny reaches codex', async () => {
    relatchHomeDirForTests(LATCHED)
    setChildHome(MANAGED)
    const toml = await bootedConfigText(BARE_WS)
    expect(toml).not.toContain('.nessy" = "deny"')
    expect(toml).not.toContain('.ssh" = "deny"')
    expect(toml).not.toContain('credentials.enc" = "deny"')
    // The only deny left is F1.664's projection of this suite's `$TMPDIR` config dir (a test
    // artefact: the real `~/.nessy-agent` is under no codex writable root), never a floor key.
    const denied = [...toml.matchAll(/^"([^"]+)" = "deny"$/gm)].map(m => basename(m[1]!))
    expect(denied.every(name => name === basename(CONFIG_DIR))).toBe(true)
    // CONTROL on the same instrument: the profile itself is still written.
    expect(toml).toContain('[permissions.nessy_runtime')
  })
})
