/**
 * F1.664 — the WHOLE Nessy config dir stays out of reach of codex agent commands
 * whenever a codex writable root contains it, not only the session's own records.
 *
 * ## The reading this rests on (shipped `codex-app-server` 0.156.1, 2026-09-25)
 *
 * `work/wjcritj/f1664-probe.ts` (host-shaped `buildCodexConfigToml`, `default`,
 * `command/exec`, rig under `$HOME`, every escalation refused, 0 asked). At HEAD the
 * global `hooks.json`, `mcp.json`, `config.json`, `permissions/default.json`, another
 * workspace's `permissions.json`/`hooks.json` and a NEW `skills/<x>/SKILL.md` were all
 * written with exit 0 when (a) the cwd is the home directory and the config dir is
 * moved (`~/.nessy-agent-1`), (b) the cwd IS the config dir (default name included),
 * (c) the home directory is an ADDED directory. CONTROLS refused: the default layout
 * (cwd home, `~/.nessy-agent`, on the directory floor) and a sibling project. The
 * rename-an-ancestor bypass does NOT land in any layout: `mv` of the workspace dir,
 * the `workspaces` dir, the config dir itself (parent writable) and the record file
 * all fail `Operation not permitted` — codex protects the ancestors of a read entry.
 * Carriers that close it, measured: a cwd-relative `":workspace_roots"` `read` subpath
 * (`.nessy-agent-1`, reads kept), `"." = "read"` when the cwd IS the config dir (an
 * absolute `read` on the cwd's own path LOSES to the cwd's write — measured), and an
 * absolute `deny` for a root other than the cwd (reads refused too — the stated cost;
 * a cwd INSIDE the config dir keeps writing under it, measured).
 *
 * Under `bun test` the config dir is a `mkdtemp` under `$TMPDIR`, which is itself a
 * codex writable root — so every boot here also carries the `$TMPDIR` arm's `deny`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CONFIG_DIR } from '../../config/paths.ts'
import * as credentialsIndex from '../../credentials/index.ts'
import * as adapterPackage from '@nessy-agent/codex-responses-adapter'
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth'
import * as codexAgentServer from '@nessy-agent/codex-agent-server'
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter'
import type { LlmConnection } from '../../config/storage.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts'

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4664 } }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-f1664' } } : {}
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
    { port: 46664, close: async () => { /* nothing bound */ } }
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

const { CodexAgent, codexConfigDirProjection } = await import('../codex-agent.ts')
const { codexDriver } = await import('../backend/internal/drivers/codex.ts')

const MODEL = 'tgpt/qwen35-397b-a17b-fp8'
const WORKSPACE_ROOT = join(CONFIG_DIR, 'workspaces', 'ws-f1664')

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
      id: 'ws-f1664',
      name: 'Test Workspace',
      rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot,
      sessionRootPath: `${workspaceRoot}/sessions`,
    } as never,
    session: {
      id: 'session-f1664',
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


const scopedRead = (subpath: string): string => `"${subpath}" = "read"`
const denyEntry = (path: string): string => `"${path}" = "deny"`
// F1.678 — the absolute key on the config dir is `read` (writes refused, reads kept), no longer `deny`.
const absReadEntry = (path: string): string => `"${path}" = "read"`
const SCOPED_HEADER = '[permissions.nessy_runtime.filesystem.":workspace_roots"]'
const scopedTable = (toml: string): string => toml.slice(toml.indexOf(SCOPED_HEADER))

describe('F1.664 — the config dir on a codex session whose writable roots contain it', () => {
  it('cwd = the config dir’s parent: the config dir is a cwd-relative `read` subpath, and `$TMPDIR` adds its absolute `read` key (F1.678)', async () => {
    const toml = await bootedConfigText(dirname(CONFIG_DIR))
    expect(scopedTable(toml)).toContain(scopedRead(basename(CONFIG_DIR)))
    expect(toml).toContain(absReadEntry(CONFIG_DIR))
    expect(toml).not.toContain(denyEntry(CONFIG_DIR))
  })

  it('cwd = the config dir itself: `"." = "read"` makes the whole cwd read-only', async () => {
    const toml = await bootedConfigText(CONFIG_DIR)
    expect(scopedTable(toml)).toContain(scopedRead('.'))
  })

  it('cwd = a project beside the config dir under `$TMPDIR`: the config dir is an absolute `read` key (the `$TMPDIR` root contains it; F1.678), and the session boots', async () => {
    const toml = await bootedConfigText(join(dirname(CONFIG_DIR), 'project-f1664'))
    expect(toml).toContain(absReadEntry(CONFIG_DIR))
    expect(toml).not.toContain(denyEntry(CONFIG_DIR))
    expect(scopedTable(toml)).not.toContain(scopedRead('.'))
  })
})

describe('F1.664 — codexConfigDirProjection, the pure rule (fake paths, nothing on disk)', () => {
  const H = '/nonexistent-f1664/home'
  const TMP = '/nonexistent-f1664/tmp'
  it('CONTROL — the default layout: `.nessy-agent` relative to home, nothing denied', () => {
    expect(codexConfigDirProjection(H, `${H}/.nessy-agent`, `${H}/.nessy-agent/workspaces/w`, [TMP]))
      .toEqual({ subpaths: ['.nessy-agent'], deny: [] })
  })
  it('a moved config dir under the home cwd: its own name, read-only', () => {
    expect(codexConfigDirProjection(H, `${H}/.nessy-agent-1`, `${H}/.nessy-agent-1/workspaces/w`, [TMP]))
      .toEqual({ subpaths: ['.nessy-agent-1'], deny: [] })
  })
  it('CONTROL — a project beside the config dir: nothing (codex asks there)', () => {
    expect(codexConfigDirProjection(`${H}/proj`, `${H}/.nessy-agent-1`, `${H}/.nessy-agent-1/workspaces/w`, [TMP]))
      .toEqual({ subpaths: [], deny: [] })
  })
  it('an ADDED directory containing the config dir: an absolute `deny`', () => {
    expect(codexConfigDirProjection(`${H}/proj`, `${H}/.nessy-agent-1`, `${H}/.nessy-agent-1/workspaces/w`, [TMP, H]))
      .toEqual({ subpaths: [], deny: [`${H}/.nessy-agent-1`] })
  })
  it('a config dir under `$TMPDIR` or `/tmp`: an absolute `deny`', () => {
    expect(codexConfigDirProjection(`${H}/proj`, `${TMP}/cfg`, `${TMP}/cfg/workspaces/w`, [TMP]))
      .toEqual({ subpaths: [], deny: [`${TMP}/cfg`] })
  })
  it('CONTROL — cwd = the workspace root or below it (F1.200 / F1.653 layouts): nothing added', () => {
    const cfg = `${H}/.nessy-agent-1`
    expect(codexConfigDirProjection(`${cfg}/workspaces/w`, cfg, `${cfg}/workspaces/w`, [TMP])).toEqual({ subpaths: [], deny: [] })
    expect(codexConfigDirProjection(`${cfg}/workspaces/w/sessions/s`, cfg, `${cfg}/workspaces/w`, [TMP])).toEqual({ subpaths: [], deny: [] })
  })
  it('cwd INSIDE the config dir but outside the session’s own workspace (e.g. its `workspaces` folder): the whole cwd is read-only', () => {
    const cfg = `${H}/.nessy-agent-1`
    expect(codexConfigDirProjection(`${cfg}/workspaces`, cfg, `${cfg}/workspaces/w`, [TMP])).toEqual({ subpaths: ['.'], deny: [] })
  })
  it('F1.1114 — a `~`-leading or whitespace-edged folder name travels verbatim as a cwd-relative `read` subpath (the writer’s F1.927 grammar), reads kept', () => {
    expect(codexConfigDirProjection(H, `${H}/~nessy`, `${H}/~nessy/workspaces/w`, [TMP])).toEqual({ subpaths: ['~nessy'], deny: [] })
    expect(codexConfigDirProjection(H, `${H}/ nessy`, `${H}/ nessy/workspaces/w`, [TMP])).toEqual({ subpaths: [' nessy'], deny: [] })
    expect(codexConfigDirProjection(H, `${H}/sub /nessy`, `${H}/sub /nessy/workspaces/w`, [TMP])).toEqual({ subpaths: ['sub /nessy'], deny: [] })
  })
  it('F1.1114 BOUNDARY — only a first folder named exactly `~` (codex reads `~/…` as a HOME path) falls back to the absolute `deny`', () => {
    expect(codexConfigDirProjection(H, `${H}/~/nessy`, `${H}/~/nessy/workspaces/w`, [TMP])).toEqual({ subpaths: [], deny: [`${H}/~/nessy`] })
    expect(codexConfigDirProjection(H, `${H}/~`, `${H}/~/workspaces/w`, [TMP])).toEqual({ subpaths: [], deny: [`${H}/~`] })
  })
  it('BOUNDARY — a glob character in the config dir path projects nothing (a stated residue) rather than failing the boot', () => {
    expect(codexConfigDirProjection(H, `${H}/n[1]`, `${H}/n[1]/workspaces/w`, [TMP, H])).toEqual({ subpaths: [], deny: [] })
  })
})
