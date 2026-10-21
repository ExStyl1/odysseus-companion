/**
 * F1.1074 (DN-273, 2026-09-29) — what can resume a codex thread after a restart-shaped rebuild: a NEW
 * app-server on a FRESH `CODEX_HOME`, the old home deleted. That is every runtime build this host makes
 * after the first: `createRuntime` mints a fresh home (`newCodexHome`, F1.652/F1.681), the teardown
 * `rmSync`s the old one (`cleanupRuntimeResources`, P3.182), and P6.649's relaunch arm resumes by
 * `threadId` alone. The builds that follow a first one are an app restart, the idle-agent reaper
 * (30 minutes idle by default), a live-agent-ceiling eviction and every `disposeManagedAgentRuntime`
 * caller in `SessionManager`.
 *
 * SOURCE (github.com/openai/codex at rust-v0.156.1, the tag the shipped binary reports; strong tier):
 *
 * - `app-server-protocol/src/protocol/v2/thread.rs` `ThreadResumeParams` has `path`, marked
 *   `#[experimental("thread/resume.path")]` and "[UNSTABLE]"; the generated TS type in
 *   `packages/codex-protocol/generated/v2/ThreadResumeParams.ts` omits it (ts-rs skips experimental
 *   fields) and says "Prefer using thread_id whenever possible".
 * - `thread-store/src/local/read_thread.rs` `read_thread` (by id): the state DB's row first, used only
 *   when its `rollout_path` still loads that thread; otherwise `thread_rollout_resolver` searches THIS
 *   home's `sessions/` tree. `resolve_requested_rollout_path` (by path) accepts any existing file.
 *
 * MEASURED on the shipped 0.156.1 (the arms below; rig `DN-273/resume-probe.ts`): a fresh home answers
 * `no rollout found for thread id …` by id; `path` naming the old rollout OUTSIDE the running home is
 * refused with the same sentence (so codex's own `path` is not a way across homes at this tag); a fresh
 * home whose `sessions/` is a SYMLINK to a directory holding the old home's `sessions/` tree resumes by
 * id, the model's next request carries the earlier turn, and codex appends to the rollout THROUGH the
 * symlink; the teardown's own `rmSync` of such a home removes the link, not the directory it names.
 *
 * Gated on the staged binary, like the other live-boot suites (`scripts/codex-live-suites.ts`).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCodexConfigToml } from '@nessy-agent/codex-responses-adapter/config-writer'
import { AppServer } from '../../../../codex-responses-adapter/src/__tests__/app-server-rig.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const BIN = join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server')
const HAVE_BIN = existsSync(BIN) && process.platform !== 'win32'
const MODEL = 'tgpt/deepseek-v4-flash-0731'
/** A word in no fixture, prompt or config, so finding it in a model request proves the earlier turn is there. */
const MARK = 'heliotrope-quartz-1074'
/** Several boots of a ~185 MB binary; generous because lanes share this machine. */
const BUDGET_MS = 240_000

describe.if(HAVE_BIN)('F1.1074 · resuming a codex thread from a fresh CODEX_HOME, on the shipped binary', () => {
  const ROOT = HAVE_BIN ? realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1074-live-'))) : ''
  const bodies: string[] = []
  const stub = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.method !== 'POST' || !(req.url ?? '').replace(/\?.*$/, '').endsWith('/responses')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"stub"}')
        return
      }
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
  const listening = HAVE_BIN ? new Promise<number>(resolve => stub.listen(0, '127.0.0.1', () => resolve((stub.address() as AddressInfo).port))) : Promise.resolve(0)
  afterAll(() => {
    if (HAVE_BIN) stub.close()
    if (ROOT) rmSync(ROOT, { recursive: true, force: true })
  })

  const project = join(ROOT, 'proj')
  const userHome = join(ROOT, 'userhome')
  if (HAVE_BIN) {
    mkdirSync(join(project, '.git'), { recursive: true })
    writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(userHome, { recursive: true })
  }

  /** A home with the config.toml the product's writer emits (trusted project, the loopback adapter port). */
  async function home(name: string): Promise<string> {
    const dir = join(ROOT, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.toml'), buildCodexConfigToml({
      codexHome: dir, model: MODEL, adapterPort: await listening, projectRoot: project, projectTrusted: true,
    }))
    return dir
  }

  async function boot(codexHome: string): Promise<AppServer> {
    const child = spawn(BIN, [], {
      cwd: project,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userHome, CODEX_HOME: codexHome, COMPANY_LLM_API_KEY: 'loopback' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    const server = new AppServer(child)
    await server.request('initialize', {
      clientInfo: { name: 'nessy-f1074', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    server.notify('initialized')
    return server
  }

  /** One turn; the model request bodies it produced. */
  async function turn(server: AppServer, threadId: string, text: string): Promise<string> {
    const seen = server.notifications.length
    const before = bodies.length
    await server.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })
    expect(await server.waitFor(n => n.method === 'turn/completed' || n.method === 'turn/failed', 120_000)).toBe(true)
    expect(server.notifications.slice(seen).some(n => n.method === 'turn/failed')).toBe(false)
    return bodies.slice(before).join('\n')
  }

  const walk = (dir: string): string[] => existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
    : []

  /** The rollout under `sessions`, once codex's writer has flushed the marker into it. */
  async function rolloutWithMark(sessions: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const found = walk(sessions).find(p => p.endsWith('.jsonl') && readFileSync(p, 'utf8').includes(MARK))
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`no rollout carrying the marker under ${sessions}`)
  }

  let threadId = ''
  let savedSessions = ''
  let savedRollout = ''

  test('the host today: one turn in home A, A removed, a fresh home answers "no rollout found" by id — and by a path outside it', async () => {
    const homeA = await home('home-A')
    const a = await boot(homeA)
    try {
      const started = await a.request('thread/start', { cwd: project, model: MODEL }) as { thread: { id: string } }
      threadId = started.thread.id
      expect(await turn(a, threadId, `remember the word ${MARK}`)).toContain(MARK)
      const rollout = await rolloutWithMark(join(homeA, 'sessions'))
      expect(relative(homeA, rollout).split('/')[0]).toBe('sessions')
      expect(rollout).toContain(threadId)
    } finally {
      a.kill()
    }
    // What survives a teardown in this rig is a COPY taken first; the host keeps nothing.
    savedSessions = join(ROOT, 'saved-sessions')
    cpSync(join(homeA, 'sessions'), savedSessions, { recursive: true })
    savedRollout = walk(savedSessions).find(p => p.endsWith('.jsonl'))!
    rmSync(homeA, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

    const b = await boot(await home('home-B'))
    try {
      await expect(b.request('thread/resume', { threadId, cwd: project, model: MODEL }))
        .rejects.toThrow(`no rollout found for thread id ${threadId}`)
      // codex's own experimental `path`, naming the old rollout outside the running home: refused the same way.
      await expect(b.request('thread/resume', { threadId, cwd: project, model: MODEL, path: savedRollout }))
        .rejects.toThrow(`no rollout found for thread id ${threadId}`)
    } finally {
      b.kill()
    }
  }, BUDGET_MS)

  test('the mechanism a fix configures: a fresh home whose sessions/ links to the kept tree resumes by id, the model sees the earlier turn, and rmSync of the home leaves the tree', async () => {
    expect(threadId).not.toBe('')
    const durable = join(ROOT, 'durable-sessions')
    cpSync(savedSessions, durable, { recursive: true })
    const homeC = await home('home-C')
    symlinkSync(durable, join(homeC, 'sessions'))
    const c = await boot(homeC)
    try {
      const resumed = await c.request('thread/resume', { threadId, cwd: project, model: MODEL }) as { thread?: { id?: string } }
      expect(resumed.thread?.id).toBe(threadId)
      // The user-visible criterion: the model's next request carries the turn the old home held.
      expect(await turn(c, threadId, 'which word did I ask you to remember?')).toContain(MARK)
    } finally {
      c.kill()
    }
    // codex appended to the kept rollout THROUGH the link (one file, now longer than the saved copy).
    const kept = walk(durable).filter(p => p.endsWith('.jsonl'))
    expect(kept.map(p => relative(durable, p))).toEqual([relative(savedSessions, savedRollout)])
    expect(readFileSync(kept[0]!, 'utf8').length).toBeGreaterThan(readFileSync(savedRollout, 'utf8').length)
    // The teardown's own call (cleanupRuntimeResources): the home goes, the link with it, the tree stays.
    expect(lstatSync(join(homeC, 'sessions')).isSymbolicLink()).toBe(true)
    rmSync(homeC, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    expect(existsSync(homeC)).toBe(false)
    expect(walk(durable).map(p => relative(durable, p))).toEqual([relative(savedSessions, savedRollout)])
  }, BUDGET_MS)
})
