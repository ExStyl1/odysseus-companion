/**
 * F1.1074 (DN-273, 2026-09-29) — the PRODUCT's restart-shaped rebuild on the shipped `codex-app-server`: a real
 * `CodexAgent` (the real `CodexRuntimeManager` and `AppServerClient`; only the model adapter is a loopback SSE stub
 * that records every request), one turn, `disposeForRestart()` — what `SessionManager` calls for the idle-agent
 * reaper, a live-agent-ceiling eviction and an app quit — then a NEW `CodexAgent` carrying the persisted thread id,
 * as the next send builds it.
 *
 * RED before F1.1074 (measured, 0 pass 1 fail): the old home was gone, the new one fresh, `thread/resume` by id
 * answered `no rollout found`, the session held `chat.codexNotice.threadResumeFailed`, a NEW thread id opened and the
 * model's next request carried none of the earlier turn. GREEN after it: each build links the session's kept
 * rollout tree into its home (`linkCodexKeptSessions`), so the rebuild resumes the same thread and the model sees
 * the conversation. The protocol half is pinned in `codex-resume-after-rebuild-live.test.ts`.
 *
 * Gated on the staged binary, like the other live-boot suites (`scripts/codex-live-suites.ts`).
 */
import { afterAll, describe, expect, it, mock } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as credentialsIndex from '../../credentials/index.ts'
import * as adapterPackage from '@nessy-agent/codex-responses-adapter'
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth'
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter'
import type { LlmConnection } from '../../config/storage.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts'

const MODEL = 'tgpt/qwen35-397b-a17b-fp8'
const MARK = 'heliotrope-quartz-1074'
const bodies: string[] = []
const stub = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    if (req.method !== 'POST' || !(req.url ?? '').replace(/\?.*$/, '').endsWith('/responses')) { res.writeHead(404); res.end('{}'); return }
    bodies.push(body)
    const id = `resp_${bodies.length}`
    const msg = { type: 'message', id: `msg_${id}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
    const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('response.created', { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model: 'm', output: [] } }))
    res.write(sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...msg, status: 'in_progress', content: [] } }))
    res.write(sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: msg.id, output_index: 0, content_index: 0, delta: 'ok' }))
    res.write(sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: msg }))
    res.end(sse('response.completed', { type: 'response.completed', response: { id, object: 'response', status: 'completed', model: 'm', output: [msg], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }))
  })
})
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const BIN = join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', `${process.platform}-${process.arch}`, 'codex-app-server')
const HAVE_BIN = existsSync(BIN) && process.platform !== 'win32'
const port = HAVE_BIN ? await new Promise<number>(resolve => stub.listen(0, '127.0.0.1', () => resolve((stub.address() as AddressInfo).port))) : 0

const realCredentials = { ...credentialsIndex }
const realAdapter = { ...adapterPackage }
const realNestorAuth = { ...nestorAuth }
mock.module('../../credentials/index.ts', () => ({ ...realCredentials, getCredentialManager: () => ({ getLlmApiKey: async () => null }) }))
mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (): Promise<AdapterHandle> => ({ port, close: async () => { /* the stub outlives each build */ } }),
}))
mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => ({
  ...realNestorAuth,
  readNestorJwt: () => 'jwt-not-a-real-token',
  readNestorCreds: () => ({ ok: true, jwt: 'jwt-not-a-real-token' }),
}))
afterAll(() => {
  mock.module('../../credentials/index.ts', () => realCredentials)
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter)
  mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => realNestorAuth)
  if (HAVE_BIN) stub.close()
})

const { CodexAgent } = await import('../codex-agent.ts')
const { codexDriver } = await import('../backend/internal/drivers/codex.ts')

mkdirSync(join(homedir(), '.cache'), { recursive: true })
const RIG = realpathSync(mkdtempSync(join(homedir(), '.cache', 'nessy-f1074-')))
const PROJECT = join(RIG, 'proj')
const WORKSPACE_ROOT = join(RIG, 'config', 'workspaces', 'ws-f1074')
const HOST_ROOT = join(RIG, 'config', 'codex-home')
mkdirSync(join(PROJECT, '.git'), { recursive: true })
writeFileSync(join(PROJECT, '.git', 'HEAD'), 'ref: refs/heads/main\n')
mkdirSync(WORKSPACE_ROOT, { recursive: true })
afterAll(() => { rmSync(RIG, { recursive: true, force: true }) })

function runtimeFor(): BackendRuntimePayload {
  return codexDriver.buildRuntime({
    context: {
      connection: {
        slug: 'nessy-codex', name: 'Nessy Codex', providerType: 'codex-runtime', authType: 'api_key_with_endpoint',
        baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1', defaultModel: MODEL, createdAt: Date.now(),
      } as LlmConnection,
      provider: 'codex-runtime', resolvedModel: MODEL, capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {} as never,
    hostRuntime: {} as never,
    resolvedPaths: { codexBinaryPath: BIN } as never,
  })
}

function agentConfig(sdkSessionId: string | undefined, published: string[], over: { sessionId?: string; branchFrom?: object } = {}): BackendConfig {
  return {
    provider: 'codex-runtime', providerType: 'codex-runtime', connectionSlug: 'nessy-codex', model: MODEL, isHeadless: true,
    projectTrusted: true,
    workspace: { id: 'ws-f1074', name: 'Test Workspace', rootPath: WORKSPACE_ROOT, workspaceRootPath: WORKSPACE_ROOT, sessionRootPath: `${WORKSPACE_ROOT}/sessions` } as never,
    session: { id: over.sessionId ?? 'session-f1074', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: PROJECT, ...(sdkSessionId ? { sdkSessionId } : {}), ...(over.branchFrom ? { branchFrom: over.branchFrom } : {}) } as never,
    runtime: runtimeFor(),
    onSdkSessionIdUpdate: (id: string) => { published.push(id) },
  } as BackendConfig
}

interface PrivateAgent {
  ensureRuntime: () => Promise<void>
  disposeForRestart: () => Promise<void>
  codexHome: string | null
  codexHomeRoot: string
  threadId: string | null
  client: { request: (method: string, params: unknown) => Promise<unknown> } | null
  pendingServerWarningNotices: string[]
  chat: (message: string) => AsyncGenerator<{ type: string }>
}

const walk = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
  : []
async function until(predicate: () => boolean, ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (predicate()) return true; await new Promise(r => setTimeout(r, 100)) }
  return predicate()
}

describe.if(HAVE_BIN)('F1.1074 · the product\'s rebuild, then the resume, on the shipped binary', () => {
  it('a restart-shaped rebuild resumes the persisted thread and the model sees the earlier turn', async () => {
    const published: string[] = []
    const a = new CodexAgent(agentConfig(undefined, published)) as unknown as PrivateAgent
    a.codexHomeRoot = HOST_ROOT
    await a.ensureRuntime()
    const threadA = a.threadId!
    const homeA = a.codexHome!
    expect(published).toContain(threadA)
    const before = bodies.length
    await a.client!.request('turn/start', { threadId: threadA, input: [{ type: 'text', text: `remember the word ${MARK}`, text_elements: [] }] })
    expect(await until(() => bodies.slice(before).some(b => b.includes(MARK)))).toBe(true)
    expect(await until(() => walk(join(homeA, 'sessions')).some(p => p.endsWith('.jsonl') && readFileSync(p, 'utf8').includes(MARK)))).toBe(true)
    await new Promise(r => setTimeout(r, 1500))
    await a.disposeForRestart()
    expect(existsSync(homeA)).toBe(false)

    const b = new CodexAgent(agentConfig(threadA, published)) as unknown as PrivateAgent
    b.codexHomeRoot = HOST_ROOT
    try {
      await b.ensureRuntime()
      expect(b.codexHome).not.toBe(homeA)
      const k = bodies.length
      await b.client!.request('turn/start', { threadId: b.threadId, input: [{ type: 'text', text: 'which word did I ask you to remember?', text_elements: [] }] })
      expect(await until(() => bodies.length > k)).toBe(true)
      expect(b.threadId).toBe(threadA)
      expect(bodies.slice(k).join('')).toContain(MARK)
      expect(b.pendingServerWarningNotices.some(n => n.includes(threadA))).toBe(false)
    } finally {
      await new Promise(r => setTimeout(r, 1000))
      await b.disposeForRestart().catch(() => {})
    }
  }, 240_000)

  /**
   * F1.1235 follow-up (CR-2, 2026-10-01) — `/clear` AFTER a rebuild that resumed the persisted thread. The agent is
   * built once with the stored id in `config.session.sdkSessionId`, and `/clear` tears the runtime down without
   * disposing the agent, so the next prompt reopens a thread through the same thread-open block. Measured red before
   * the fix: that block read the build-time id again, `thread/resume` reopened the cleared thread (its rollout is kept
   * for `/resume`), and the model saw the cleared turn. Positive control: the first test above (no `/clear`, resumed).
   */
  it('after a resumed rebuild, /clear starts a fresh thread and the model does not see the cleared turn', async () => {
    const MARK3 = 'cinnabar-sextant-1235'
    const published: string[] = []
    const a = new CodexAgent(agentConfig(undefined, published, { sessionId: 'session-f1235-clear' })) as unknown as PrivateAgent
    a.codexHomeRoot = HOST_ROOT
    await a.ensureRuntime()
    const threadA = a.threadId!
    const before = bodies.length
    await a.client!.request('turn/start', { threadId: threadA, input: [{ type: 'text', text: `remember the word ${MARK3}`, text_elements: [] }] })
    expect(await until(() => bodies.slice(before).some(b => b.includes(MARK3)))).toBe(true)
    expect(await until(() => walk(join(a.codexHome!, 'sessions')).some(p => p.endsWith('.jsonl') && readFileSync(p, 'utf8').includes(MARK3)))).toBe(true)
    await new Promise(r => setTimeout(r, 1500))
    await a.disposeForRestart()

    const b = new CodexAgent(agentConfig(threadA, published, { sessionId: 'session-f1235-clear' })) as unknown as PrivateAgent
    b.codexHomeRoot = HOST_ROOT
    try {
      await b.ensureRuntime()
      expect(b.threadId).toBe(threadA)
      for await (const _event of b.chat('/clear')) { /* drain the seam's events */ }
      expect(b.threadId).toBeNull()
      await b.ensureRuntime()
      const threadB = b.threadId
      expect(threadB).not.toBeNull()
      expect(threadB).not.toBe(threadA)
      const k = bodies.length
      await b.client!.request('turn/start', { threadId: threadB, input: [{ type: 'text', text: 'which word did I ask you to remember?', text_elements: [] }] })
      expect(await until(() => bodies.length > k)).toBe(true)
      expect(bodies.slice(k).join('')).not.toContain(MARK3)
      expect(b.pendingServerWarningNotices.some(n => n.includes(threadA))).toBe(false)
    } finally {
      await new Promise(r => setTimeout(r, 1000))
      await b.disposeForRestart().catch(() => {})
    }
  }, 240_000)

  /**
   * F1.1076 (DN-273, 2026-09-29) — a BRANCH: a new session whose `branchFrom` names the parent session and its codex
   * thread (P6.102). The child's build mints its own fresh home, linked to its OWN kept folder, so codex's
   * `thread/fork` by the parent's id found no rollout (measured red: the child held `threadForkFailed` and the model
   * saw none of the parent's turn). The child now seeds its folder with the parent's rollout of that thread.
   */
  it('a branch forks the parent session\'s thread: the child opens a new thread that carries the parent\'s turn, with no fork-failed notice', async () => {
    const MARK2 = 'verdigris-lantern-1076'
    const published: string[] = []
    const parent = new CodexAgent(agentConfig(undefined, published, { sessionId: 'session-f1076-parent' })) as unknown as PrivateAgent
    parent.codexHomeRoot = HOST_ROOT
    let child: PrivateAgent | null = null
    try {
      await parent.ensureRuntime()
      const threadP = parent.threadId!
      const before = bodies.length
      await parent.client!.request('turn/start', { threadId: threadP, input: [{ type: 'text', text: `remember the word ${MARK2}`, text_elements: [] }] })
      expect(await until(() => bodies.slice(before).some(b => b.includes(MARK2)))).toBe(true)
      expect(await until(() => walk(join(parent.codexHome!, 'sessions')).some(p => p.endsWith('.jsonl') && readFileSync(p, 'utf8').includes(MARK2)))).toBe(true)
      await new Promise(r => setTimeout(r, 1500))
      // The parent stays live, as it does when the user branches an open chat.
      child = new CodexAgent(agentConfig(undefined, published, {
        sessionId: 'session-f1076-child',
        branchFrom: { parent: { workspaceId: 'ws-f1074', sessionId: 'session-f1076-parent' }, sdkSessionId: threadP },
      })) as unknown as PrivateAgent
      child.codexHomeRoot = HOST_ROOT
      await child.ensureRuntime()
      expect(child.threadId).not.toBe(threadP)
      expect(child.pendingServerWarningNotices.filter(n => n.includes(threadP))).toEqual([])
      const k = bodies.length
      await child.client!.request('turn/start', { threadId: child.threadId, input: [{ type: 'text', text: 'which word did I ask you to remember?', text_elements: [] }] })
      expect(await until(() => bodies.length > k)).toBe(true)
      expect(bodies.slice(k).join('')).toContain(MARK2)
    } finally {
      await new Promise(r => setTimeout(r, 1000))
      await child?.disposeForRestart().catch(() => {})
      await parent.disposeForRestart().catch(() => {})
    }
  }, 240_000)

  /**
   * F1.1278 (FX-1, 2026-10-02) — `/clear` in a BRANCHED chat. `config.session.branchFrom` is built once per agent and
   * the fork arm reads it at EVERY thread open, while `/clear` keeps the agent and only tears the runtime down — so
   * the next open forked the parent's thread again and the model saw the history the user had cleared (SIT3-b, live on
   * RC #2). Measured red before the fix. Positive control: the branch arm above (no `/clear`, the fork carries the
   * parent's turn); the resumed-then-cleared arm above stays the non-branched boundary.
   */
  it('a branch, then /clear: the next thread is fresh (not a re-fork of the parent) and the model does not see the parent\'s turn', async () => {
    const MARK4 = 'malachite-astrolabe-1278'
    const published: string[] = []
    const parent = new CodexAgent(agentConfig(undefined, published, { sessionId: 'session-f1278-parent' })) as unknown as PrivateAgent
    parent.codexHomeRoot = HOST_ROOT
    let child: PrivateAgent | null = null
    try {
      await parent.ensureRuntime()
      const threadP = parent.threadId!
      const before = bodies.length
      await parent.client!.request('turn/start', { threadId: threadP, input: [{ type: 'text', text: `remember the word ${MARK4}`, text_elements: [] }] })
      expect(await until(() => bodies.slice(before).some(b => b.includes(MARK4)))).toBe(true)
      expect(await until(() => walk(join(parent.codexHome!, 'sessions')).some(p => p.endsWith('.jsonl') && readFileSync(p, 'utf8').includes(MARK4)))).toBe(true)
      await new Promise(r => setTimeout(r, 1500))
      child = new CodexAgent(agentConfig(undefined, published, {
        sessionId: 'session-f1278-child',
        branchFrom: { parent: { workspaceId: 'ws-f1074', sessionId: 'session-f1278-parent' }, sdkSessionId: threadP },
      })) as unknown as PrivateAgent
      child.codexHomeRoot = HOST_ROOT
      await child.ensureRuntime()
      const threadFork = child.threadId!
      expect(threadFork).not.toBe(threadP)
      for await (const _event of child.chat('/clear')) { /* drain the seam's events */ }
      expect(child.threadId).toBeNull()
      await child.ensureRuntime()
      const threadFresh = child.threadId
      expect(threadFresh).not.toBeNull()
      expect([threadP, threadFork]).not.toContain(threadFresh)
      const k = bodies.length
      await child.client!.request('turn/start', { threadId: threadFresh, input: [{ type: 'text', text: 'which word did I ask you to remember?', text_elements: [] }] })
      expect(await until(() => bodies.length > k)).toBe(true)
      expect(bodies.slice(k).join('')).not.toContain(MARK4)
      expect(child.pendingServerWarningNotices.filter(n => n.includes(threadP))).toEqual([])
    } finally {
      await new Promise(r => setTimeout(r, 1000))
      await child?.disposeForRestart().catch(() => {})
      await parent.disposeForRestart().catch(() => {})
    }
  }, 240_000)
})
