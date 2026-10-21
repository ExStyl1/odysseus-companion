/**
 * F1.659 — on a codex session whose ADDED directory (`additionalDirectories`) contains
 * the workspace root while the cwd does not, the workspace records the host guards
 * are refused to codex's own sandbox too.
 *
 * ## The reading this rests on (shipped `codex-app-server` 0.156.1, 2026-09-25)
 *
 * F1.200 and F1.653 carry `automations.json`, `automations-history.jsonl`,
 * `permissions.json` and `hooks.json` as `":workspace_roots"` `read` subpaths — and
 * codex resolves that table against the CWD only. Measured with the host-shaped
 * `default` config written by `buildCodexConfigToml` (sandbox master switch off, the
 * credential deny, the host's protected-path list, the added directory as the
 * `writablePaths` grant `codexAdditionalWritableRoots` hands over; `command/exec`,
 * rig under `$HOME`, cwd a project folder beside the workspace, 0 escalations asked):
 *
 * - an added directory BESIDE the workspace: the three writes refused (CONTROL);
 * - cwd = the workspace root with the home directory added: refused (CONTROL — the
 *   cwd's `read` entry is the more specific one);
 * - the home directory added, with the DEFAULT `~/.nessy-agent` or a moved config
 *   dir; the config dir added; its `workspaces` folder added; the workspace root
 *   itself added: in EVERY one of the five, all three writes exit 0 and the files
 *   change, unasked;
 * - the records as `":workspace_roots"` subpaths relative to the ADDED root: still
 *   land (the table is not applied under an added root);
 * - the records as ABSOLUTE `deny` keys (the carrier `deniedReadPaths` already is):
 *   refused, a sibling write inside the workspace still lands.
 *
 * So the records travel as absolute denied-read paths exactly when an added directory
 * covers them and the cwd does not. Hermetic rig, on the shape of
 * `codex-workspace-record-floor-ancestor-cwd.test.ts` plus the added-directory reader
 * mock of `codex-additional-directories.test.ts`.
 *
 * ## F1.720 — which of those layouts can still happen (after F1.693, `630f32976`)
 *
 * The rig's config folder (`CONFIG_DIR` below) is a FAKE one, not the host's data folder.
 * A real workspace root always lives at `<data folder>/workspaces/<id>`
 * (`getWorkspaceRootPath`), and since F1.693 an added directory INSIDE the data folder is
 * not granted to codex (the data folder itself was already refused, F1.664). So "its
 * `workspaces` folder added" and "the workspace root itself added" no longer reach codex;
 * the home directory added still does. The workspace-root arm therefore runs on the REAL
 * data folder and pins what a session now gets there: no write key, no record deny needed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as credentialsIndex from '../../credentials/index.ts'
import * as adapterPackage from '@nessy-agent/codex-responses-adapter'
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth'
import * as codexAgentServer from '@nessy-agent/codex-agent-server'
import * as additionalDirectories from '../additional-directories.ts'
import { CONFIG_DIR as DATA_FOLDER } from '../../config/paths.ts'
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter'
import type { LlmConnection } from '../../config/storage.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts'

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4659 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-f1659' } } : {}
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
    { port: 46659, close: async () => { /* nothing bound */ } }
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
const HOME = '/tmp/home-f1659'
const CONFIG_DIR = `${HOME}/.nessy-agent-1`
const WORKSPACE_ROOT = `${CONFIG_DIR}/workspaces/ws-f1659`
const PROJECT = `${HOME}/project-f1659`
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

function agentConfig(workingDirectory: string | undefined, workspaceRoot: string): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-f1659',
      name: 'Test Workspace',
      rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot,
      sessionRootPath: `${workspaceRoot}/sessions`,
    } as never,
    session: {
      id: 'session-f1659',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      ...(workingDirectory ? { workingDirectory } : {}),
    } as never,
    runtime: runtimeFor(),
  } as BackendConfig
}

type PrivateAgent = { ensureRuntime: () => Promise<void>; codexHome: string | null }

const live: Array<{ destroy: () => void }> = []
beforeEach(() => { live.length = 0; configuredRoots = [] })
afterEach(() => { for (const agent of live.splice(0)) agent.destroy() })

async function bootedConfigText(
  workingDirectory: string | undefined, added: string[], workspaceRoot = WORKSPACE_ROOT,
): Promise<string> {
  configuredRoots = added
  const agent = new CodexAgent(agentConfig(workingDirectory, workspaceRoot))
  live.push(agent)
  await (agent as unknown as PrivateAgent).ensureRuntime()
  const home = (agent as unknown as PrivateAgent).codexHome
  expect(typeof home).toBe('string')
  return readFileSync(join(home!, 'config.toml'), 'utf8')
}

// F1.670 — the records ride an absolute `read` key (writes refused, reads kept), no longer `deny`.
const absReadEntry = (record: string): string => `"${WORKSPACE_ROOT}/${record}" = "read"`
const denyEntry = (record: string): string => `"${WORKSPACE_ROOT}/${record}" = "deny"`
/** Every absolute line of the config that names a record under the workspace root, `read` or `deny`. */
const recordDenyLines = (toml: string): string[] =>
  toml.split('\n').filter(line => /= "(deny|read)"$/.test(line) && line.startsWith('"/') && RECORDS.some(record => line.includes(`/${record}"`)))
const grantEntry = (root: string): string => `"${root}" = "write"`

describe('F1.659 — the guarded workspace records on a codex session whose ADDED directory contains the workspace root', () => {
  it('the home directory added, cwd a project beside the workspace: every record is an absolute read-only path (F1.670), none denied', async () => {
    const toml = await bootedConfigText(PROJECT, [HOME])
    // Non-vacuity: the grant is really there. F1.1057 — the host's own credentials.enc deny
    // is no longer beside it (codex's own defaults); the record denies below still land.
    expect(toml).toContain(grantEntry(HOME))
    expect(toml).not.toMatch(/credentials\.enc" = "deny"/)
    for (const record of RECORDS) {
      expect(toml).toContain(absReadEntry(record))
      expect(toml).not.toContain(denyEntry(record))
    }
  })

  it('the workspace root itself added, where a real one lives (inside the data folder): not granted (F1.693), so no record needs a deny', async () => {
    const realRoot = join(DATA_FOLDER, 'workspaces', 'ws-f1659')
    const other = `${HOME}/other-f1659`
    const toml = await bootedConfigText(PROJECT, [realRoot, other], realRoot)
    // Same call, same instrument: the added directory outside the data folder IS granted.
    expect(toml).toContain(grantEntry(other))
    expect(toml).not.toContain(grantEntry(realRoot))
    expect(recordDenyLines(toml)).toEqual([])
  })

  it('CONTROL — an added directory beside the workspace: no record is denied (nothing grants them)', async () => {
    const other = `${HOME}/other-f1659`
    const toml = await bootedConfigText(PROJECT, [other])
    expect(toml).toContain(grantEntry(other))
    expect(recordDenyLines(toml)).toEqual([])
  })

  it('CONTROL — cwd = the workspace root with the home directory added: the records stay bare `read` names (reads kept), none denied', async () => {
    const toml = await bootedConfigText(undefined, [HOME])
    expect(toml).toContain(grantEntry(HOME))
    for (const record of RECORDS) expect(toml).toContain(`"${record}" = "read"`)
    expect(recordDenyLines(toml)).toEqual([])
  })

  it('CONTROL — cwd = the home directory with it also added: F1.653’s cwd-relative `read` subpaths carry them, none denied', async () => {
    const toml = await bootedConfigText(HOME, [HOME])
    for (const record of RECORDS) expect(toml).toContain(`".nessy-agent-1/workspaces/ws-f1659/${record}" = "read"`)
    expect(recordDenyLines(toml)).toEqual([])
  })
})

// UA12.8 follow-up (LF-2-fix, 2026-10-09) — the artifacts registry rides the same absolute `deny` as the
// records whenever an added directory covers the workspace root (the `":workspace_roots"` table resolves
// against the cwd only). Measured 2026-10-09 on 0.159.3: the absolute deny refuses the registry write and
// its read, a sibling write lands. See codex-workspace-record-floor.test.ts for why the file is guarded.
describe('UA12.8 — the artifacts registry when an ADDED directory contains the workspace root', () => {
  it('the home directory added, cwd a project beside the workspace: the registry is an absolute read-only path (F1.670)', async () => {
    const toml = await bootedConfigText(PROJECT, [HOME])
    expect(toml).toContain(grantEntry(HOME))
    expect(toml).toContain(absReadEntry('artifacts/registry.json'))
    expect(toml).not.toContain(denyEntry('artifacts/registry.json'))
  })

  it('CONTROL — an added directory beside the workspace: the registry is not denied', async () => {
    const other = `${HOME}/other-f1659`
    const toml = await bootedConfigText(PROJECT, [other])
    expect(toml).toContain(grantEntry(other))
    expect(toml).not.toContain('registry.json"')
  })
})
