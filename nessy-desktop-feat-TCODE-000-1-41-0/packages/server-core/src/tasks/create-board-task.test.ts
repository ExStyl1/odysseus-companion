/**
 * UA3.5 — the host side of `create_board_task` ({@link createBoardTaskForCaller}): the restrictions on the invoking
 * agent (folder, project, sources, connection, no mode) and upstream's creation-only behaviour (slug, warnings, one
 * `main` node). The handler arms (blank title, unavailable context) are `session-tools-core`'s
 * `handlers/create-board-task.test.ts`; the codex bridge arms are `shared`'s `codex/__tests__/board-task-bridge.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listTaskSlugs, loadTaskSpec, saveTaskSpec, type TaskSpec } from '@nessy-agent/shared/tasks'
import { createProject } from '@nessy-agent/shared/projects'
import { createBoardTaskForCaller, type BoardTaskCaller, type CreateBoardTaskPorts } from './create-board-task'

interface Created { id: string; options: Record<string, unknown> }

let root: string
let created: Created[]
let sourcesSet: Array<{ id: string; slugs: string[] }>
let sessions: Array<{ id: string; taskSlug?: string; isArchived?: boolean }>
let trustState: 'trusted' | 'untrusted' | 'unknown'
let hasFolder: boolean
let failCreate: boolean
let handlePersistence: 'stable' | 'process-only'

const CALLER_KEY = `p_${'c'.repeat(32)}`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ua3-5-board-task-'))
  created = []
  sourcesSet = []
  sessions = []
  trustState = 'trusted'
  hasFolder = true
  failCreate = false
  handlePersistence = 'stable'
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function ports(): CreateBoardTaskPorts {
  const sessionManager = {
    getSessions: () => sessions,
    createSession: async (_ws: string, options: Record<string, unknown>) => {
      if (failCreate) throw new Error('workspace-default-project-invalid')
      const id = `orch-${created.length + 1}`
      created.push({ id, options })
      sessions.push({ id, taskSlug: options.taskSlug as string })
      return { id }
    },
    applyTaskLabel: async () => ({ labelId: 'task' }),
    setSessionSources: async (id: string, slugs: string[]) => { sourcesSet.push({ id, slugs }) },
    announceSessionCreated: () => {}, // F1.873 — an ISessionManager member createTaskFromSpec now calls
  }
  return {
    sessionManager: sessionManager as never,
    handles: {
      resolveHandle: async () => hasFolder
        ? { id: 'handle-1', canonicalPath: '/private/work/proj', displayPath: '/work/proj', trustState, projectKey: CALLER_KEY, persistence: handlePersistence } as never
        : null,
    },
    workspaceSourceSlugs: () => ['github', 'jira', 'linear'],
    workspaceSkillSlugs: () => ['review'],
  }
}

/** The saved spec (`loadTaskSpec` answers the validation result with the spec beside it). */
const saved = (slug: string): TaskSpec | undefined => loadTaskSpec(root, slug)?.spec

const caller = (over: Partial<BoardTaskCaller> = {}): BoardTaskCaller => ({
  sessionId: 'caller',
  workspaceId: 'ws',
  workspaceRoot: root,
  projectId: 'proj-a',
  llmConnection: 'gateway-coder',
  permissionMode: 'acceptEdits',
  enabledSourceSlugs: ['github', 'jira'],
  ...over,
})

describe('UA3.5 — create_board_task host closure: creation only, upstream shape', () => {
  it('positive: returns slug, orchestrator id and warnings; one "main" node; todo; caller folder handle, mode and connection', async () => {
    const result = await createBoardTaskForCaller(ports(), caller(), {
      title: 'Fix login flow',
      description: 'Investigate the OAuth redirect loop',
      acceptanceCriteria: 'Login succeeds on first attempt',
    })
    expect(result).toEqual({ slug: 'fix-login-flow', orchestratorSessionId: 'orch-1', taskLabelId: 'task', warnings: [] })
    const spec = saved('fix-login-flow')!
    expect(spec.nodes.map(node => node.id)).toEqual(['main'])
    expect(spec.nodes[0]!.prompt).toBe('Investigate the OAuth redirect loop')
    expect(spec.goal).toBe('Investigate the OAuth redirect loop')
    expect(spec.acceptance_criteria).toBe('Login succeeds on first attempt')
    expect(spec.project).toBe('proj-a')
    expect(spec.defaults?.llmConnection).toBe('gateway-coder')
    // No permission mode reaches the yaml; the orchestrator takes the caller's.
    expect(spec.defaults?.permissionMode).toBeUndefined()
    expect(created).toHaveLength(1)
    expect(created[0]!.options).toMatchObject({
      sessionStatus: 'todo',
      taskSlug: 'fix-login-flow',
      projectHandleId: 'handle-1',
      permissionMode: 'acceptEdits',
      llmConnection: 'gateway-coder',
      projectId: 'proj-a',
    })
    // The folder enters as the handle only; no raw path is a createSession option.
    expect(JSON.stringify(created[0]!.options)).not.toContain('/work/proj')
  })

  it('positive: unset sources inherits the caller\'s enabled sources', async () => {
    await createBoardTaskForCaller(ports(), caller(), { title: 'T', description: 'D' })
    expect(saved('t')?.sources).toEqual(['github', 'jira'])
    expect(sourcesSet).toEqual([{ id: 'orch-1', slugs: ['github', 'jira'] }])
  })

  it('positive: unknown sources and skills come back as warnings; an unknown source is not kept in the spec', async () => {
    const result = await createBoardTaskForCaller(ports(), caller(), {
      title: 'T', description: 'D', sources: ['github', 'nope'], skills: ['review', 'ghost'],
    })
    expect(result.warnings).toEqual([
      'Unknown sources (not added to the task: they don\'t exist in this workspace): nope',
      'Unknown skills (kept in the spec, but they don\'t exist in this workspace): ghost',
    ])
    const spec = saved('t')!
    expect(spec.sources).toEqual(['github'])
    expect(spec.skills).toEqual(['review', 'ghost'])
  })

  it('negative: an existing slug yields -2, and the first task.yaml is untouched', async () => {
    saveTaskSpec(root, { id: 'fix-login', title: 'first', goal: 'g', runner: 'conduct', nodes: [{ id: 'main', prompt: 'p' }] } as unknown as TaskSpec)
    const result = await createBoardTaskForCaller(ports(), caller(), { title: 'Fix login', description: 'second' })
    expect(result.slug).toBe('fix-login-2')
    expect(saved('fix-login')?.title).toBe('first')
    // A slug a live session carries is taken too.
    sessions.push({ id: 'other', taskSlug: 'carried' })
    expect((await createBoardTaskForCaller(ports(), caller(), { title: 'Carried', description: 'd' })).slug).toBe('carried-2')
  })

  it('boundary: a refused createSession leaves no yaml and releases the slug (the retry takes the same slug)', async () => {
    failCreate = true
    await expect(createBoardTaskForCaller(ports(), caller(), { title: 'Retry me', description: 'd' })).rejects.toThrow('workspace-default-project-invalid')
    expect(listTaskSlugs(root)).toEqual([])
    failCreate = false
    expect((await createBoardTaskForCaller(ports(), caller(), { title: 'Retry me', description: 'd' })).slug).toBe('retry-me')
  })
})

describe('UA3.5 — create_board_task host closure: restrictions on the invoking agent (S19)', () => {
  async function refused(input: Parameters<typeof createBoardTaskForCaller>[2], over: Partial<BoardTaskCaller> = {}): Promise<string> {
    const error = await createBoardTaskForCaller(ports(), caller(over), input).then(() => null, (e: Error) => e)
    expect(error, 'expected a refusal').not.toBeNull()
    // Every refusal runs before anything exists.
    expect(created).toHaveLength(0)
    expect(listTaskSlugs(root)).toEqual([])
    return error!.message
  }

  it('negative: a blank title or description is refused', async () => {
    expect(await refused({ title: '   ', description: 'D' })).toBe('title is required.')
    expect(await refused({ title: 'T', description: '' })).toBe('description is required.')
  })

  it('negative: a foreign folder is refused with project-handle-required; the caller\'s own (canonical or display) passes', async () => {
    expect(await refused({ title: 'T', description: 'D', workingDirectory: '/etc' })).toStartWith('project-handle-required:')
    hasFolder = false
    expect(await refused({ title: 'T', description: 'D', workingDirectory: '/work/proj' })).toContain('this session has none')
    hasFolder = true
    const own = await createBoardTaskForCaller(ports(), caller(), { title: 'Own', description: 'D', workingDirectory: '/work/proj' })
    expect(own.slug).toBe('own')
    expect(saved('own')?.cwd).toBe('/private/work/proj')
  })

  it('negative: an untrusted caller folder is refused before anything exists', async () => {
    trustState = 'untrusted'
    expect(await refused({ title: 'T', description: 'D' })).toBe('task-cwd-untrusted')
  })

  it('negative: a foreign-folder projectId gives project-handle-required; the caller\'s own projectId passes', async () => {
    expect(await refused({ title: 'T', description: 'D', projectId: 'proj-other' })).toStartWith('project-handle-required:')
    await createBoardTaskForCaller(ports(), caller(), { title: 'Same', description: 'D', projectId: 'proj-a' })
    expect(saved('same')?.project).toBe('proj-a')
  })

  it('UA5.2 positive: a project bound to the caller\'s own folder (same stable projectKey) is accepted', async () => {
    const sibling = createProject(root, { name: 'Sibling' }, { displayPath: '/work/proj', projectKey: CALLER_KEY, persistence: 'stable' })
    await createBoardTaskForCaller(ports(), caller(), { title: 'Sibling task', description: 'D', projectId: sibling.id })
    expect(saved('sibling-task')?.project).toBe(sibling.id)
    // The task still runs in the caller's own folder handle, and the orchestrator is bound to the named project.
    expect(created[0]!.options).toMatchObject({ projectHandleId: 'handle-1', projectId: sibling.id })
  })

  it('UA5.2 negative: another folder, a folderless project, a process-only caller identity or no caller folder is refused', async () => {
    const other = createProject(root, { name: 'Other' }, { displayPath: '/work/other', projectKey: `p_${'d'.repeat(32)}`, persistence: 'stable' })
    const folderless = createProject(root, { name: 'Loose' })
    const sibling = createProject(root, { name: 'Sibling' }, { displayPath: '/work/proj', projectKey: CALLER_KEY, persistence: 'stable' })
    expect(await refused({ title: 'T', description: 'D', projectId: other.id })).toStartWith('project-handle-required:')
    expect(await refused({ title: 'T', description: 'D', projectId: folderless.id })).toStartWith('project-handle-required:')
    // A process-only caller key is never persisted anywhere, so it matches nothing — even the same raw key.
    handlePersistence = 'process-only'
    expect(await refused({ title: 'T', description: 'D', projectId: sibling.id })).toStartWith('project-handle-required:')
    handlePersistence = 'stable'
    hasFolder = false
    expect(await refused({ title: 'T', description: 'D', projectId: sibling.id })).toStartWith('project-handle-required:')
  })

  it('negative: a workspace source not enabled on the caller is refused', async () => {
    expect(await refused({ title: 'T', description: 'D', sources: ['github', 'linear'] }))
      .toStartWith('board-task-source-not-enabled:')
  })

  it('negative: another connection is refused; the caller\'s own named explicitly passes', async () => {
    expect(await refused({ title: 'T', description: 'D', llmConnection: 'claude-max' })).toStartWith('board-task-connection-refused:')
    await createBoardTaskForCaller(ports(), caller(), { title: 'Own conn', description: 'D', llmConnection: 'gateway-coder' })
    expect(saved('own-conn')?.defaults?.llmConnection).toBe('gateway-coder')
  })
})

describe('UA3.5 — the SHIPPED binding: SessionManager hands every runtime this closure', () => {
  // Read as TEXT (the agent-session-status-closure / claude-cron-port-binding precedent): the binding sits in
  // getOrCreateAgent's registry block, which cannot be driven without constructing an agent.
  it('createBoardTaskFn is bound once, to createBoardTaskForAgent, which calls createBoardTaskForCaller with the caller\'s facts', async () => {
    const source = await Bun.file(new URL('../sessions/SessionManager.ts', import.meta.url)).text()
    // Control: the block the binding sits in is the one the artifact pair is bound in.
    expect(source).toContain('publishArtifactFn: (input: PublishArtifactInput) => this.publishArtifactForAgent(managed, input),')
    expect(source.match(/createBoardTaskFn:/g)?.length).toBe(1)
    expect(source).toContain('createBoardTaskFn: (input: CreateBoardTaskInput) => this.createBoardTaskForAgent(managed, input),')
    const method = source.slice(source.indexOf('private createBoardTaskForAgent('), source.indexOf('private createBoardTaskForAgent(') + 1400)
    expect(method).toContain('return createBoardTaskForCaller({')
    for (const fact of ['sessionId: caller.id', 'projectId: caller.projectId', 'llmConnection: caller.llmConnection', 'permissionMode: caller.permissionMode', 'enabledSourceSlugs: caller.enabledSourceSlugs', 'handles: this.projectHandleService']) {
      expect(method, fact).toContain(fact)
    }
  })
})
