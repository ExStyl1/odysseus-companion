/**
 * F1.653 — on a codex session whose cwd is an ANCESTOR of the workspace root, the
 * workspace records the host guards are read-only to codex's own sandbox too.
 *
 * ## The reading this rests on (shipped `codex-app-server` 0.156.1, 2026-09-25)
 *
 * F1.200 projected `automations.json`, `automations-history.jsonl`,
 * `permissions.json` and `hooks.json` as `":workspace_roots"` `read` subpaths only
 * when the cwd EQUALS the workspace root. Measured with the host-shaped `default`
 * config written by `buildCodexConfigToml` (sandbox master switch off, the
 * credential deny, the host's protected-path list; `command/exec`, rig under
 * `$HOME`, every escalation refused, 0 asked):
 *
 * - cwd = the workspace root: the three writes fail `Operation not permitted`
 *   (CONTROL, F1.200);
 * - cwd = a project folder beside the workspace: refused (CONTROL — the workspace
 *   root is outside codex's writable roots);
 * - cwd = the home directory with the DEFAULT config dir: refused, but only
 *   because `.nessy-agent` is itself on the directory floor, which makes the whole
 *   config dir read-only;
 * - cwd = the home directory with a MOVED config dir (`NESSY_CONFIG_DIR`, e.g. the
 *   documented `~/.nessy-agent-1` instance layout): all three writes exit 0 and
 *   the files change, unasked;
 * - cwd = `<config dir>/workspaces`: the same, all three land;
 * - the same two with the records emitted RELATIVE to the cwd
 *   (`.nessy-agent-1/workspaces/<id>/permissions.json` = `read`): refused, a
 *   sibling write inside the workspace and a read of the record still work.
 *
 * A written `permissions.json` is a self-granted allow, so the build is the
 * general form: the records travel relative to the cwd whenever the workspace
 * root is at or below it. Hermetic rig, on the shape of
 * `codex-workspace-record-floor.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as credentialsIndex from '../../credentials/index.ts'
import * as adapterPackage from '@nessy-agent/codex-responses-adapter'
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth'
import * as codexAgentServer from '@nessy-agent/codex-agent-server'
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter'
import type { LlmConnection } from '../../config/storage.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts'

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4653 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-f1653' } } : {}
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
    { port: 46653, close: async () => { /* nothing bound */ } }
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
const HOME = '/tmp/home-f1653'
// A moved config dir: `.nessy-agent` is on the directory floor, this name is not.
const CONFIG_DIR = `${HOME}/.nessy-agent-1`
const WORKSPACE_ROOT = `${CONFIG_DIR}/workspaces/ws-f1653`
const RECORDS = ['automations-history.jsonl', 'automations.json', 'hooks.json', 'permissions.json']

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

function agentConfig(workingDirectory: string | undefined, workspaceRoot = WORKSPACE_ROOT): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-f1653',
      name: 'Test Workspace',
      rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot,
      sessionRootPath: `${workspaceRoot}/sessions`,
    } as never,
    session: {
      id: 'session-f1653',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      ...(workingDirectory ? { workingDirectory } : {}),
    } as never,
    runtime: runtimeFor(),
  } as BackendConfig
}

type PrivateAgent = { ensureRuntime: () => Promise<void>; codexHome: string | null }

const live: Array<{ destroy: () => void }> = []
beforeEach(() => { live.length = 0 })
afterEach(() => { for (const agent of live.splice(0)) agent.destroy() })

async function bootedConfigText(workingDirectory: string | undefined, workspaceRoot = WORKSPACE_ROOT): Promise<string> {
  const agent = new CodexAgent(agentConfig(workingDirectory, workspaceRoot))
  live.push(agent)
  await (agent as unknown as PrivateAgent).ensureRuntime()
  const home = (agent as unknown as PrivateAgent).codexHome
  expect(typeof home).toBe('string')
  return readFileSync(join(home!, 'config.toml'), 'utf8')
}

const readEntry = (subpath: string): string => `"${subpath}" = "read"`
/** Every `read` line of the `":workspace_roots"` table that names a record, whatever its prefix. */
const recordReadLines = (toml: string): string[] =>
  toml.split('\n').filter(line => line.endsWith('= "read"') && !line.startsWith('"/') && RECORDS.some(record => line.includes(`${record}"`))) // F1.670 — the absolute `read` keys are the flat map's, not this table's

describe('F1.653 — the guarded workspace records on a codex session whose cwd is an ancestor of the workspace root', () => {
  it('cwd = the home directory, config dir moved: every record is a cwd-relative `read` subpath', async () => {
    const toml = await bootedConfigText(HOME)
    // Non-vacuity: the table exists and carries the directory floor it always did.
    expect(toml).toContain(readEntry('.git'))
    for (const record of RECORDS) {
      expect(toml).toContain(readEntry(`.nessy-agent-1/workspaces/ws-f1653/${record}`))
    }
  })

  it('cwd = the config dir’s workspaces folder: every record is a cwd-relative `read` subpath', async () => {
    const toml = await bootedConfigText(`${CONFIG_DIR}/workspaces`)
    for (const record of RECORDS) expect(toml).toContain(readEntry(`ws-f1653/${record}`))
  })

  it('CONTROL — cwd = the workspace root: the records stay bare names (F1.200 unchanged)', async () => {
    const toml = await bootedConfigText(undefined)
    expect(recordReadLines(toml).sort()).toEqual(RECORDS.map(readEntry).sort())
  })

  it('CONTROL — a project folder beside the workspace: no record is projected (codex asks there)', async () => {
    const toml = await bootedConfigText(`${HOME}/project-f1653`)
    expect(toml).toContain(readEntry('.git'))
    expect(recordReadLines(toml)).toEqual([])
  })

  it('F1.927 — a folder whose name starts with `~` boots, and its records travel verbatim', async () => {
    const toml = await bootedConfigText(HOME, `${HOME}/~cfg/workspaces/ws-f1653`)
    for (const record of RECORDS) expect(toml).toContain(readEntry(`~cfg/workspaces/ws-f1653/${record}`))
  })

  it('F1.927 — a space-edged folder name is kept, never trimmed to a different path', async () => {
    const toml = await bootedConfigText(HOME, `${HOME}/ cfg/workspaces/ws-f1653`)
    for (const record of RECORDS) {
      expect(toml).toContain(readEntry(` cfg/workspaces/ws-f1653/${record}`))
      expect(toml).not.toContain(readEntry(`cfg/workspaces/ws-f1653/${record}`))
    }
  })

  it('F1.927 BOUNDARY — a folder named exactly `~` (codex reads `~/…` as home) boots, the records read-only as absolute paths (F1.670)', async () => {
    const root = `${HOME}/~/workspaces/ws-f1653`
    const toml = await bootedConfigText(HOME, root)
    expect(toml).toContain(readEntry('.git'))
    expect(recordReadLines(toml)).toEqual([])
    for (const record of RECORDS) {
      expect(toml).toContain(`"${root}/${record}" = "read"`)
      expect(toml).not.toContain(`"${root}/${record}" = "deny"`)
    }
  })

  it('BOUNDARY — a relative path codex cannot take as a subpath (a glob character) projects nothing and still boots', async () => {
    const odd = `${HOME}/odd[1]/workspaces/ws-f1653`
    const toml = await bootedConfigText(HOME, odd)
    expect(toml).toContain(readEntry('.git'))
    expect(recordReadLines(toml)).toEqual([])
  })
})
