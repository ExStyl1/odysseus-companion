/**
 * F1.696 — F1.659's coverage test compared the workspace root only AS WRITTEN, and its absolute
 * `read` keys were spelled as written too. Codex resolves its writable roots by real path but
 * matches an absolute key as spelled, so a workspace root reached through a symlink kept its
 * records writable to codex agent commands.
 *
 * ## The reading this rests on (shipped `codex-app-server` 0.159.3, 2026-10-09)
 *
 * `work/bk-10/f1696-probe.ts` (`buildCodexConfigToml`, `default`, sandbox switch off,
 * `command/exec`, rig under `$HOME`, 0 escalations asked). The workspace root as written is a
 * symlink OUTSIDE the added directory to a real folder INSIDE it:
 *
 * - no record keys (what F1.659 emitted here): the record write lands, through the link and
 *   through the real path alike;
 * - the records as absolute `read` keys spelled through the LINK: the write still lands
 *   (codex does not resolve the key);
 * - the same keys spelled by the REAL path: the write is refused through both spellings, the
 *   read works and a sibling write lands; a hard link to a record (into the cwd or the added
 *   directory), a rename of the record or of the workspace folder, and a write through a new
 *   symlink in the cwd are all refused `Operation not permitted`;
 * - the cwd at the added folder (nothing added): the same — lands with no key, refused with
 *   the real-path keys.
 *
 * So both sides are compared by real path as well as as written, and every key is emitted
 * under each spelling of the root (the real one is the one codex honours).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  spawn(): unknown { return { pid: 4696 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-f1696' } } : {}
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
    { port: 46696, close: async () => { /* nothing bound */ } }
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
const RECORDS = ['automations-history.jsonl', 'automations.json', 'hooks.json', 'permissions.json']

/** A real (non-symlinked) base, so the only link in the layout is the one each case makes. */
const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'f1696-')))
const STORE = join(BASE, 'store')
const REAL_ROOT = join(STORE, 'real-ws')
const LINKED_ROOT = join(BASE, 'link-ws')
const PROJECT = join(BASE, 'project')
const BESIDE = join(BASE, 'beside')
for (const dir of [REAL_ROOT, PROJECT, BESIDE]) mkdirSync(dir, { recursive: true })
symlinkSync(REAL_ROOT, LINKED_ROOT)

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

function agentConfig(workingDirectory: string, workspaceRoot: string): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-f1696',
      name: 'Test Workspace',
      rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot,
      sessionRootPath: `${workspaceRoot}/sessions`,
    } as never,
    session: { id: 'session-f1696', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory } as never,
    runtime: runtimeFor(),
  } as BackendConfig
}

type PrivateAgent = { ensureRuntime: () => Promise<void>; codexHome: string | null }

const live: Array<{ destroy: () => void }> = []
beforeEach(() => { live.length = 0; configuredRoots = [] })
afterEach(() => { for (const agent of live.splice(0)) agent.destroy() })
afterAll(() => { rmSync(BASE, { recursive: true, force: true }) })

async function bootedConfigText(workingDirectory: string, added: string[], workspaceRoot: string): Promise<string> {
  configuredRoots = added
  const agent = new CodexAgent(agentConfig(workingDirectory, workspaceRoot))
  live.push(agent)
  await (agent as unknown as PrivateAgent).ensureRuntime()
  const home = (agent as unknown as PrivateAgent).codexHome
  expect(typeof home).toBe('string')
  return readFileSync(join(home!, 'config.toml'), 'utf8')
}

const readEntry = (root: string, record: string): string => `"${root}/${record}" = "read"`
/** Every absolute `read`/`deny` line naming a record. */
const recordLines = (toml: string): string[] =>
  toml.split('\n').filter(line => /= "(deny|read)"$/.test(line) && line.startsWith('"/') && RECORDS.some(record => line.includes(`/${record}"`)))

describe('F1.696 — a workspace root reached through a symlink, its real folder under a codex writable root', () => {
  it('the added directory holds the real folder, the root is written through a link outside it: every record is read-only by its REAL path', async () => {
    const toml = await bootedConfigText(PROJECT, [STORE], LINKED_ROOT)
    expect(toml).toContain(`"${STORE}" = "write"`)
    for (const record of RECORDS) expect(toml).toContain(readEntry(REAL_ROOT, record))
  })

  it('the cwd is the folder holding the real root (nothing added): every record is read-only by its REAL path', async () => {
    const toml = await bootedConfigText(STORE, [], LINKED_ROOT)
    for (const record of RECORDS) expect(toml).toContain(readEntry(REAL_ROOT, record))
  })

  it('the added directory is spelled through a link and covers the root only by real path: the records still get their keys', async () => {
    const linkedStore = join(BASE, 'link-store')
    symlinkSync(STORE, linkedStore)
    const toml = await bootedConfigText(PROJECT, [linkedStore], REAL_ROOT)
    for (const record of RECORDS) expect(toml).toContain(readEntry(REAL_ROOT, record))
  })

  it('CONTROL — an added directory beside the workspace, by either spelling: no record key', async () => {
    const toml = await bootedConfigText(PROJECT, [BESIDE], LINKED_ROOT)
    expect(toml).toContain(`"${BESIDE}" = "write"`)
    expect(recordLines(toml)).toEqual([])
  })

  it('CONTROL — no symlink anywhere, the added directory holds the root: the keys are the plain path, once each', async () => {
    const toml = await bootedConfigText(PROJECT, [STORE], REAL_ROOT)
    expect(recordLines(toml).sort()).toEqual(RECORDS.map(record => readEntry(REAL_ROOT, record)).sort())
  })
})
