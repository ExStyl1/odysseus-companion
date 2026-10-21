/**
 * F1.200 — on a codex session with NO project, the workspace records the host
 * guards are read-only to codex's own sandbox.
 *
 * ## The reading this rests on (vendored `codex-app-server`, 2026-09-23)
 *
 * Codex writes never pass the host's `runPreToolUseChecks`, so F1.123's
 * `hooks.json` ask and D1.438's `automations.json`/`permissions.json` refusal
 * reach codex only through codex's own sandbox. Which sandbox that is depends on
 * the thread's cwd: `base-agent.ts` falls back to the WORKSPACE ROOT when a
 * session has no working directory, and codex's `:workspace` profile parent makes
 * the cwd a writable root. Measured with the host-shaped `acceptEdits` config and
 * `command/exec`:
 *
 * - cwd = a project folder: `printf >> <workspaceRoot>/hooks.json` → `Operation not
 *   permitted`, so codex has to escalate — i.e. it ASKS, and the ask reaches the
 *   host's approval card;
 * - cwd = the workspace root (a no-project session): the same write exits 0 and
 *   the file changes — the write lands UNASKED, no card anywhere;
 * - cwd = the workspace root with `hooks.json` as a `":workspace_roots"` `read`
 *   subpath: the write is refused, the read still works, a sibling file still
 *   writes — C3.343's mechanism holds for a FILE subpath too.
 *
 * So the build is the no-project half only: `CodexAgent` adds the guarded record
 * names to the `":workspace_roots"` `read` list exactly when its cwd IS the
 * workspace root. For `automations.json`, `automations-history.jsonl` and
 * `permissions.json` that is D1.438's own posture (refused). For `hooks.json` it
 * is a REFUSAL where Pi and claude ASK — codex's native mechanism has no ask for
 * a write inside a writable root — which is C3.343's stated asymmetry, attributed
 * on the diagnostic channel by `formatCodexProtectedPathFloorDiagnostics`.
 *
 * Hermetic rig, on the shape of `codex-additional-directories.test.ts`.
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
  spawn(): unknown { return { pid: 4446 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-f1200' } } : {}
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
    { port: 46175, close: async () => { /* nothing bound */ } }
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
const WORKSPACE_ROOT = '/tmp/ws-f1200'
const PROJECT = '/tmp/project-f1200'
// UA1.10: + the host-approvals ledger, which travels by its exact name like the D1.438 records.
const RECORDS = ['automations-history.jsonl', 'automations.json', 'host-approvals.json', 'hooks.json', 'permissions.json']

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

function agentConfig(workingDirectory: string | undefined): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-f1200',
      name: 'Test Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: 'session-f1200',
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

async function bootedConfigText(workingDirectory: string | undefined): Promise<string> {
  const agent = new CodexAgent(agentConfig(workingDirectory))
  live.push(agent)
  await (agent as unknown as PrivateAgent).ensureRuntime()
  const home = (agent as unknown as PrivateAgent).codexHome
  expect(typeof home).toBe('string')
  return readFileSync(join(home!, 'config.toml'), 'utf8')
}

const readEntry = (subpath: string): string => `"${subpath}" = "read"`

describe('F1.200 — the guarded workspace records on a codex session whose cwd is the workspace root', () => {
  it('no project: every guarded record is a `read` subpath of the workspace-roots table', async () => {
    const toml = await bootedConfigText(undefined)
    // Non-vacuity: the table exists and carries the directory floor it always did.
    expect(toml).toContain(readEntry('.git'))
    for (const record of RECORDS) expect(toml).toContain(readEntry(record))
  })

  it('CONTROL — a project session: the records are not projected (the workspace root is outside codex’s roots, so codex asks)', async () => {
    const toml = await bootedConfigText(PROJECT)
    expect(toml).toContain(readEntry('.git'))
    for (const record of RECORDS) expect(toml).not.toContain(readEntry(record))
  })

  it('UA1.10 — the PATTERN records never reach the profile: no projected subpath carries a glob character', async () => {
    // codex `rust-v0.159.3` `codex-rs/core/src/config/permissions.rs` refuses a glob
    // subpath with any access but `deny` ("filesystem glob subpath `{subpath}` only
    // supports `deny` access"), so a `pages/<slug>/page.json` pattern projected as a
    // `read` subpath would fail the config load. Stated residue: on codex the four
    // pattern records are carried by the ledger digest, not by this profile.
    const toml = await bootedConfigText(undefined)
    const readKeys = [...toml.matchAll(/^"([^"]+)" = "read"$/gm)].map(match => match[1]!)
    expect(readKeys).toContain('host-approvals.json')
    expect(readKeys.filter(key => /[*?[\]]/.test(key))).toEqual([])
  })
})

// UA12.8 follow-up (LF-2-fix, 2026-10-09) — the artifacts registry travels beside the records. The host
// trusts `<workspaceRoot>/artifacts/registry.json` for two decisions, one of them irreversible: an entry
// carrying `pendingDelete` is DELETED on the service with the user's token, no card, at the next Artifacts
// list or dp `ready` boundary (`retryOwedArtifactDeletes`, server-core `handlers/rpc/artifacts.ts`). At
// HEAD a no-project codex command could add that field. Measured 2026-10-09 on the shipped
// codex-app-server 0.159.3 (`default`, `command/exec`, cwd a fake workspace root under $HOME): the write,
// an unlink, a create and a rename of `artifacts/` all exit 0 without the subpath; with it all four fail
// `Operation not permitted`, while the read and a sibling `artifacts/other.txt` write still work.
describe('UA12.8 — the artifacts registry on a codex session whose cwd is the workspace root', () => {
  it('no project: `artifacts/registry.json` is a `read` subpath (write refused, read kept: no deny entry)', async () => {
    const toml = await bootedConfigText(undefined)
    expect(toml).toContain(readEntry('host-approvals.json'))
    expect(toml).toContain(readEntry('artifacts/registry.json'))
    expect(toml).not.toMatch(/registry\.json" = "deny"/)
  })

  it('CONTROL — a project session: the registry is not projected (outside codex’s roots, so codex asks)', async () => {
    const toml = await bootedConfigText(PROJECT)
    expect(toml).toContain(readEntry('.git'))
    expect(toml).not.toContain('registry.json"')
  })
})
