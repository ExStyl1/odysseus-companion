/**
 * UA4.5 — `tasks:generate` and its `tasks:generated` push (plan UA4.5 "Tests", spec §11 "Generate"), driven through
 * the registered handlers against a REAL SessionManager, ProjectHandleService and workspace root. Only the turn
 * machinery is replaced, as UA4.3's `tasks-run.test.ts` does: `sendMessage` records the call and acks (or not), and
 * the draft's turn ends when the test emits a completion on the SessionManager's own seam.
 *
 * Positive: a fenced YAML reply is extracted, validated and pushed with the draft's id; the draft is a visible,
 * announced `taskDraft` session (in `getSessions`, not hidden) authoring in `dontAsk` with a queue-mode send; nothing
 * is saved; `tasks:create` adopts it in place — the same id, off draft, bound to the slug, in the editor's mode (so a
 * board tile, `board-derive.ts`'s filter being `!isArchived && !hidden && !taskDraft`); an invalid first reply gets
 * one repair turn carrying the errors.
 * Negative: two invalid attempts push an invalid result and write no `task.yaml`; a turn with no final text reads as
 * empty — the previous turn's answer is never used (`getSessionFinalText` is not called); a request for bypass still
 * authors in `dontAsk`; a send not delivered, a send that fails and a timeout each push `error`; another session's
 * completion is ignored; a foreign caller and an untrusted folder are refused before any session exists; an empty
 * goal is refused; an adopted non-draft keeps the adopt lock (no raise).
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS, type TaskGenerateResult } from '@nessy-agent/shared/protocol'
import { listTaskSlugs, taskYamlPath } from '@nessy-agent/shared/tasks'
import {
  GENERATE_ATTEMPT_MAX_MS,
  GENERATE_CLIENT_GRACE_MS,
  GENERATE_CLIENT_TIMEOUT_MS,
  GENERATE_PERMISSION_MODE,
  MAX_GENERATE_ATTEMPTS,
} from '@nessy-agent/shared/tasks/generate-limits'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import type { SessionCompletionEvent, SessionManager } from '../../../sessions/SessionManager'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager.ts'
import { HANDLED_CHANNELS, registerTasksHandlers } from '../tasks'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
/** The first real `createSession` of a file pays cold module and store work: wait for the fact, bounded. */
const waitFor = async (fact: () => boolean) => { for (let i = 0; i < 400 && !fact(); i++) await new Promise(r => setTimeout(r, 5)) }

const emitOn = (manager: SessionManager, evt: SessionCompletionEvent) =>
  (manager as unknown as { emitSessionComplete(e: SessionCompletionEvent): void }).emitSessionComplete(evt)

type Send = { sessionId: string; message: string; options: unknown }

/** `timeoutMs` shortens one authoring turn's cap (UB2.9 `generateAttemptMaxMs`; UB12.92 — the pre-UB2.9
 *  `generateTimeoutMs` it used to set is read by nothing since 9e4e1354c). */
function rig(tag: string, opts: { ack?: boolean; reject?: Error; timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), `ua4-5-gen-${tag}-`))
  roots.push(root)
  const workspaceId = `ws-ua4-5-${tag}-${Math.random().toString(36).slice(2, 8)}`
  const workspaceService = {
    resolve: (id: string) => ({
      id,
      workspaceRootPath: join(root, 'workspaces', id),
      sessionRootPath: join(root, 'sessions', id),
      config: { id, name: id, createdAt: 1, updatedAt: 1 },
      lastAccessedAt: 1,
    }),
    listResolved: () => [],
  } as unknown as WorkspaceService
  const sm = createTestSessionManager({ workspaceService }) as SessionManager
  sm.setEventSink((() => undefined) as never)
  const sends: Send[] = []
  const announced: string[] = []
  let finalTextReads = 0
  const announce = sm.announceSessionCreated.bind(sm)
  Object.assign(sm, {
    sendMessage: (sessionId: string, message: string, _a: unknown, _b: unknown, options: unknown, _c: unknown, _d: unknown, onAck?: (id: string) => void) => {
      sends.push({ sessionId, message, options })
      if (opts.reject) return Promise.reject(opts.reject)
      if (opts.ack === false) return Promise.resolve() // resolved with no ack: a slash-command arm
      onAck?.('m')
      return new Promise<void>(() => {})
    },
    announceSessionCreated: (sessionId: string, wsId: string) => { announced.push(sessionId); announce(sessionId, wsId) },
    getSessionFinalText: () => { finalTextReads++; return 'PREVIOUS TURN ANSWER' },
  })
  const pushes: { channel: string; args: unknown[] }[] = []
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push(channel: string, _target: unknown, ...args: unknown[]) { pushes.push({ channel, args }) },
    async invokeClient() { return undefined },
    hasClientCapability() { return true },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  registerTasksHandlers(server, { sessionManager: sm, workspaceService, platform: {} } as unknown as HandlerDeps, {
    assertNodesHostable: async () => {},
    ...(opts.timeoutMs ? { generateAttemptMaxMs: opts.timeoutMs } : {}),
  })
  const ctx: RequestContext = { clientId: 'client-1', workspaceId, webContentsId: null }
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!(ctx, ...args) as T)
  const callAs = <T>(caller: string, channel: string, ...args: unknown[]): Promise<T> =>
    Promise.resolve(handlers.get(channel)!({ ...ctx, workspaceId: caller }, ...args) as T)
  const complete = (sessionId: string, finalText?: string) =>
    emitOn(sm, { sessionId, workspaceId, reason: 'complete', ...(finalText !== undefined ? { finalText } : {}) })
  const generated = () => pushes.filter(p => p.channel === RPC_CHANNELS.tasks.GENERATED).map(p => p.args[1] as TaskGenerateResult)
  const wsRoot = join(root, 'workspaces', workspaceId)
  const sessions = () => sm.getSessions(workspaceId)
  return { sm, workspaceId, wsRoot, call, callAs, complete, sends, announced, generated, sessions, finalTextReads: () => finalTextReads }
}

const SPEC = [
  'id: weekly-report',
  'title: Weekly report',
  'goal: write the weekly report',
  'defaults:',
  '  permissionMode: acceptEdits',
  'nodes:',
  '  - id: gather',
  '    prompt: gather the numbers',
  '  - id: write',
  '    depends_on: [gather]',
  '    prompt: "write it from ${nodes.gather.output}"',
  '',
].join('\n')
const DANGLING = 'id: weekly-report\ntitle: Weekly report\ngoal: g\nnodes:\n  - id: write\n    prompt: "from ${nodes.ghost.output}"\n'

async function generate(h: ReturnType<typeof rig>, req: Record<string, unknown> = {}) {
  const ack = await h.call<{ orchestratorSessionId: string }>(RPC_CHANNELS.tasks.GENERATE, h.workspaceId, { goal: 'write the weekly report', title: 'Weekly report', ...req })
  await waitFor(() => h.sends.length > 0 || h.generated().length > 0)
  return ack.orchestratorSessionId
}

describe('UA4.5 — the shared Generate limits', () => {
  // UB12.92 — re-derived from UB2.9 (9e4e1354c): the worst case is attempts × the per-turn cap (was × 180 s = 380 s).
  it('the client fallback is attempts × cap + 20 s = 620 s, and the draft mode is dontAsk', () => {
    expect([GENERATE_ATTEMPT_MAX_MS, MAX_GENERATE_ATTEMPTS, GENERATE_CLIENT_GRACE_MS]).toEqual([300_000, 2, 20_000])
    expect(GENERATE_CLIENT_TIMEOUT_MS).toBe(620_000)
    expect(GENERATE_PERMISSION_MODE).toBe('dontAsk')
  })
})

describe('UA4.5 — tasks:generate', () => {
  it('is a declared channel of the tasks module', () => {
    expect(HANDLED_CHANNELS as readonly string[]).toContain(RPC_CHANNELS.tasks.GENERATE)
  })

  it('POSITIVE: a fenced reply is extracted, validated and pushed; the draft is visible, announced, dontAsk, queued; nothing is saved; create adopts it in the editor\'s mode', async () => {
    const h = rig('positive')
    const draftId = await generate(h, { permissionMode: 'default' })

    const draft = h.sessions().find(s => s.id === draftId)
    expect(draft).toBeDefined() // in getSessions
    expect(draft).toMatchObject({ taskDraft: true, permissionMode: 'dontAsk', sessionStatus: 'todo', name: 'Weekly report' })
    expect(draft?.hidden).toBeFalsy()
    expect(h.announced).toEqual([draftId])
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]).toMatchObject({ sessionId: draftId, options: { midStreamOverride: 'queue' } })
    expect(h.sends[0]!.message).toContain('Goal: write the weekly report')
    // NESSY generator rule: the YAML in the message, no file and no command (the draft runs in dontAsk).
    expect(h.sends[0]!.message).toContain('Do not create or edit files and do not run commands')

    h.complete(draftId, `Here is the plan:\n\`\`\`yaml\n${SPEC}\`\`\`\nDone.`)
    await waitFor(() => h.generated().length > 0)
    const [result] = h.generated()
    expect(result).toMatchObject({ orchestratorSessionId: draftId, slug: 'weekly-report', validation: { valid: true } })
    expect(result!.yaml).toBe(SPEC.trim())
    expect((result!.spec as { nodes: unknown[] }).nodes).toHaveLength(2)
    expect(result!.error).toBeUndefined()
    // Nothing is saved by generate.
    expect(existsSync(taskYamlPath(h.wsRoot, 'weekly-report'))).toBe(false)
    expect(h.finalTextReads()).toBe(0)

    // Save adopts the draft in place: same id, bound, off draft, in the spec's (the editor's) mode.
    const created = await h.call<{ slug: string; orchestratorSessionId: string }>(RPC_CHANNELS.tasks.CREATE, h.workspaceId, { yaml: result!.yaml, orchestratorSessionId: draftId })
    expect(created).toMatchObject({ slug: 'weekly-report', orchestratorSessionId: draftId })
    const adopted = h.sessions().find(s => s.id === draftId)
    expect(adopted).toMatchObject({ taskDraft: false, taskSlug: 'weekly-report', permissionMode: 'acceptEdits' })
    expect(adopted?.hidden).toBeFalsy()
    expect(h.sessions().filter(s => s.taskSlug === 'weekly-report')).toHaveLength(1)
    expect(listTaskSlugs(h.wsRoot)).toEqual(['weekly-report'])
  })

  it('POSITIVE + NEGATIVE: an invalid reply gets one repair turn carrying its errors; two invalid attempts push an invalid result and save nothing', async () => {
    const h = rig('repair')
    const draftId = await generate(h)
    h.complete(draftId, DANGLING)
    await waitFor(() => h.sends.length > 1)
    expect(h.sends).toHaveLength(2)
    expect(h.sends[1]!.message).toContain('failed validation')
    expect(h.sends[1]!.message).toContain('ghost')
    expect(h.sends[1]).toMatchObject({ sessionId: draftId, options: { midStreamOverride: 'queue' } })
    h.complete(draftId, DANGLING)
    await waitFor(() => h.generated().length > 0)
    const [result] = h.generated()
    expect(result!.validation.valid).toBe(false)
    expect(result!.validation.errors.length).toBeGreaterThan(0)
    expect(result!.error).toBeUndefined() // upstream's shape: the editor discards an invalid result as it does an error
    expect(h.sends).toHaveLength(MAX_GENERATE_ATTEMPTS) // bounded: no third turn
    expect(listTaskSlugs(h.wsRoot)).toEqual([])
    expect(existsSync(taskYamlPath(h.wsRoot, 'weekly-report'))).toBe(false)
  })

  it('POSITIVE: a repaired second reply is pushed valid', async () => {
    const h = rig('repaired')
    const draftId = await generate(h)
    h.complete(draftId, DANGLING)
    await waitFor(() => h.sends.length > 1)
    h.complete(draftId, SPEC)
    await waitFor(() => h.generated().length > 0)
    expect(h.generated()[0]).toMatchObject({ slug: 'weekly-report', validation: { valid: true } })
  })

  it('NEGATIVE: a turn with no final text reads as empty — the previous turn\'s answer is never used', async () => {
    const h = rig('no-final')
    const draftId = await generate(h)
    h.complete(draftId) // an intermediate-only turn: no finalText
    await waitFor(() => h.sends.length > 1)
    h.complete(draftId)
    await waitFor(() => h.generated().length > 0)
    const [result] = h.generated()
    expect(result!.yaml).toBe('')
    expect(result!.validation.valid).toBe(false)
    expect(h.finalTextReads()).toBe(0)
  })

  it('NEGATIVE: a request for bypass still authors in dontAsk', async () => {
    const h = rig('bypass')
    const draftId = await generate(h, { permissionMode: 'bypassPermissions' })
    expect(h.sessions().find(s => s.id === draftId)?.permissionMode).toBe('dontAsk')
  })

  it('NEGATIVE: another session\'s completion is ignored', async () => {
    const h = rig('other')
    const draftId = await generate(h)
    h.complete('some-other-session', SPEC)
    await new Promise(r => setTimeout(r, 20))
    expect(h.generated()).toEqual([])
    h.complete(draftId, SPEC)
    await waitFor(() => h.generated().length > 0)
    expect(h.generated()).toHaveLength(1)
  })

  it('NEGATIVE: a send that is not delivered, a send that fails, and a timeout each push error', async () => {
    const undelivered = rig('undelivered', { ack: false })
    const a = await generate(undelivered)
    await waitFor(() => undelivered.generated().length > 0)
    expect(undelivered.generated()[0]).toMatchObject({ orchestratorSessionId: a, slug: '', error: 'prompt not delivered', validation: { valid: false } })

    const failed = rig('failed', { reject: new Error('backend unavailable') })
    await generate(failed)
    await waitFor(() => failed.generated().length > 0)
    expect(failed.generated()[0]!.error).toBe('backend unavailable')

    const slow = rig('timeout', { timeoutMs: 30 })
    await generate(slow)
    await waitFor(() => slow.generated().length > 0)
    expect(slow.generated()[0]!.error).toBe('Task generation timed out')
    for (const h of [undelivered, failed, slow]) expect(listTaskSlugs(h.wsRoot)).toEqual([])
  })

  it('NEGATIVE: a foreign caller, an untrusted folder and an empty goal are refused before any session exists', async () => {
    const h = rig('refusals')
    await expect(h.callAs('another-workspace', RPC_CHANNELS.tasks.GENERATE, h.workspaceId, { goal: 'g' })).rejects.toThrow('tasks-workspace-mismatch')
    await expect(h.call(RPC_CHANNELS.tasks.GENERATE, h.workspaceId, { goal: '   ' })).rejects.toThrow('task-goal-required')
    const folder = mkdtempSync(join(tmpdir(), 'ua4-5-folder-'))
    roots.push(folder)
    const issued = await h.sm.getProjectHandleService().validateProjectDirectory(h.workspaceId, folder)
    await expect(h.call(RPC_CHANNELS.tasks.GENERATE, h.workspaceId, { goal: 'g', projectHandleId: issued.id })).rejects.toThrow('task-cwd-untrusted')
    expect(h.sessions()).toEqual([])
    expect(h.sends).toEqual([])
    // Control: once trusted, the same handle becomes the draft's folder.
    await h.sm.getProjectHandleService().setProjectTrust({ workspaceId: h.workspaceId, projectHandleId: issued.id }, 'trusted')
    const draftId = await generate(h, { projectHandleId: issued.id })
    expect(h.sessions().find(s => s.id === draftId)?.workingDirectory).toBeDefined()
  })

  it('NEGATIVE: the mode lift is the draft\'s alone — a re-adopt of a bound orchestrator keeps the adopt lock', async () => {
    const h = rig('lock')
    const draftId = await generate(h)
    h.complete(draftId, SPEC.replace('acceptEdits', 'plan'))
    await waitFor(() => h.generated().length > 0)
    await h.call(RPC_CHANNELS.tasks.CREATE, h.workspaceId, { yaml: h.generated()[0]!.yaml, orchestratorSessionId: draftId })
    expect(h.sessions().find(s => s.id === draftId)?.permissionMode).toBe('plan')
    // The same save again (an idempotent re-adopt) with a higher mode: the session is no longer a draft, so no lift.
    await h.call(RPC_CHANNELS.tasks.CREATE, h.workspaceId, { yaml: SPEC, orchestratorSessionId: draftId })
    expect(h.sessions().find(s => s.id === draftId)).toMatchObject({ taskSlug: 'weekly-report', permissionMode: 'plan' })
  })
})

describe('UA12.93 — an edit-mode Generate draft authors in the task orchestrator\'s folder', () => {
  /** A trusted folder of this workspace: its issued handle id and its path. */
  const trustedFolder = async (h: ReturnType<typeof rig>, tag: string) => {
    // The issued handle canonicalises the path (macOS tmpdir is a /private symlink): compare against the real path.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `ua12-93-${tag}-`)))
    roots.push(dir)
    const issued = await h.sm.getProjectHandleService().validateProjectDirectory(h.workspaceId, dir)
    await h.sm.getProjectHandleService().setProjectTrust({ workspaceId: h.workspaceId, projectHandleId: issued.id }, 'trusted')
    return { dir, handleId: issued.id }
  }

  it('CONTROL (the row\'s control): naming the task\'s orchestrator, the draft runs in the orchestrator\'s folder', async () => {
    const h = rig('edit-folder')
    const f = await trustedFolder(h, 'task')
    const orch = await h.sm.createSession(h.workspaceId, { name: 'task-orch', projectHandleId: f.handleId })
    expect(h.sessions().find(s => s.id === orch.id)?.workingDirectory).toBe(f.dir)
    const draftId = await generate(h, { orchestratorSessionId: orch.id })
    expect(h.sessions().find(s => s.id === draftId)?.workingDirectory).toBe(f.dir)
  })

  it('BOUNDARY: the orchestrator\'s folder wins over a request handle — an edit cannot be steered elsewhere', async () => {
    const h = rig('precedence')
    const task = await trustedFolder(h, 'a')
    const other = await trustedFolder(h, 'b')
    const orch = await h.sm.createSession(h.workspaceId, { name: 'task-orch', projectHandleId: task.handleId })
    const draftId = await generate(h, { orchestratorSessionId: orch.id, projectHandleId: other.handleId })
    expect(h.sessions().find(s => s.id === draftId)?.workingDirectory).toBe(task.dir)
  })

  it('NEGATIVE: an unknown orchestrator id is refused before any session exists', async () => {
    const h = rig('unknown')
    const before = h.sessions().length
    await expect(h.call(RPC_CHANNELS.tasks.GENERATE, h.workspaceId, { goal: 'g', orchestratorSessionId: 'no-such-session' }))
      .rejects.toThrow('task-orchestrator-missing')
    expect(h.sessions().length).toBe(before)
    expect(h.sends).toEqual([])
  })

  it('NEGATIVE: an archived orchestrator is refused', async () => {
    const h = rig('archived')
    const f = await trustedFolder(h, 'arch')
    const orch = await h.sm.createSession(h.workspaceId, { name: 'task-orch', projectHandleId: f.handleId })
    await h.sm.archiveSession(orch.id, h.workspaceId)
    const before = h.sessions().length
    await expect(h.call(RPC_CHANNELS.tasks.GENERATE, h.workspaceId, { goal: 'g', orchestratorSessionId: orch.id }))
      .rejects.toThrow('task-orchestrator-missing')
    expect(h.sessions().length).toBe(before)
  })
})
