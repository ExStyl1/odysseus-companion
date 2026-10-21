/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/__tests__/task-spec-form.test.ts
   (craft-agents-oss, Apache-2.0) by UA3.6, 2026-10-02. Adapted: our permission modes in the defaults round-trip
   (`default` for upstream's retired `ask`), and the NESSY block at the end — the clamp, the no-path folder rule,
   the non-Latin slug and the byte-identical `slugify` copy (task-spec-form.ts header, adaptations 1–4).
   UA4.6 adds the Generate arms at the end (adaptation 5): generate → manual, a discarded draft is deleted, and the
   editor's fallback is the shared constant (620 s since UB2.9; UB12.92 re-pinned it from 380 s). */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { slugify as sharedSlugify, uniqueTaskSlug } from '@nessy-agent/shared/tasks/slug'
import {
  GENERATE_ATTEMPT_MAX_MS,
  GENERATE_CLIENT_GRACE_MS,
  GENERATE_CLIENT_TIMEOUT_MS,
  MAX_GENERATE_ATTEMPTS,
} from '@nessy-agent/shared/tasks/generate-limits'
import {
  createGenerateDraftTracker,
  resolveGeneratedResult,
  buildSpec,
  buildTaskCreateRequest,
  specToSubtasks,
  canDependOn,
  modesAtOrBelow,
  taskEditorModeCeiling,
  TASK_NEW_MODE_CEILING,
  quickAddNodeId,
  quickAddSessionId,
  quickAddChildToSubtask,
  slugify,
  MAX_REPAIR_ATTEMPTS_CAP,
  type EditorSubtask,
  type SpecNode,
} from '../task-spec-form'

const noConn = new Map<string, string>()

describe('task-spec-form round-trip', () => {
  it('preserves generated node ids so ${nodes.<id>.output} references survive generate → edit → create', () => {
    // A generated spec where one node references another by its (non-title-slug) id.
    const generated: SpecNode[] = [
      { id: 'research-conductor', title: 'Research', prompt: 'Survey the landscape.' },
      {
        id: 'design-and-implement-the-chip',
        title: 'Design & implement the chip',
        prompt: 'Build it using ${nodes.research-conductor.output}',
        depends_on: ['research-conductor'],
      },
    ]

    const subtasks = specToSubtasks(generated, 'fallback-model')
    const spec = buildSpec(
      { title: 'My task', goal: 'g', projectId: '', orchModel: '', subtasks },
      noConn,
    )

    const nodes = spec.nodes as Array<{ id: string; prompt: string; depends_on?: string[] }>
    const ids = nodes.map((n) => n.id)
    // The referenced id is preserved verbatim — NOT re-derived from the title slug ('research').
    expect(ids).toContain('research-conductor')
    const dependent = nodes.find((n) => n.id === 'design-and-implement-the-chip')!
    expect(dependent.prompt).toBe('Build it using ${nodes.research-conductor.output}')
    expect(dependent.depends_on).toEqual(['research-conductor'])
  })

  it('emits task-level sources/skills when picked and omits them when empty', () => {
    const subtasks = specToSubtasks([{ id: 'a', title: 'A', prompt: 'p' }], 'm')
    const picked = buildSpec(
      { title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks, sourceSlugs: ['github'], skillSlugs: ['commit'] },
      noConn,
    )
    expect(picked.sources).toEqual(['github'])
    expect(picked.skills).toEqual(['commit'])

    const empty = buildSpec(
      { title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks, sourceSlugs: [], skillSlugs: [] },
      noConn,
    )
    // Empty selections stay absent (not []) so sessions keep workspace defaults.
    expect('sources' in empty).toBe(false)
    expect('skills' in empty).toBe(false)
  })

  it('preserves multi-dependency (fan-in) edges that the single-dependency editor would otherwise drop', () => {
    const generated: SpecNode[] = [
      { id: 'a', title: 'A', prompt: 'pa' },
      { id: 'b', title: 'B', prompt: 'pb' },
      // Pure ordering edges (no ${nodes.*.output} in the prompt) on BOTH upstreams.
      { id: 'synth', title: 'Synthesize', prompt: 'combine results', depends_on: ['a', 'b'] },
    ]
    const subtasks = specToSubtasks(generated, 'm')
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks }, noConn)
    const synth = (spec.nodes as Array<{ id: string; depends_on?: string[] }>).find((n) => n.id === 'synth')!
    expect(new Set(synth.depends_on)).toEqual(new Set(['a', 'b']))
  })

  it('drops edges to nodes that no longer exist instead of emitting a dangling depends_on', () => {
    // 'synth' depended on 'a' and 'b'; the user deletes the 'b' row in the editor. synth still
    // carries b's uid, which no longer maps to a node — it must be dropped, not emitted dangling.
    const subtasks = specToSubtasks(
      [
        { id: 'a', title: 'A', prompt: 'pa' },
        { id: 'b', title: 'B', prompt: 'pb' },
        { id: 'synth', title: 'Synthesize', prompt: 'p', depends_on: ['a', 'b'] },
      ],
      'm',
    ).filter((s) => s.nodeId !== 'b') // delete the 'b' upstream row
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks }, noConn)
    const synth = (spec.nodes as Array<{ id: string; depends_on?: string[] }>).find((n) => n.id === 'synth')!
    expect(synth.depends_on).toEqual(['a']) // 'b' filtered out, not emitted as a dangling ref
  })

  it('preserves qa- node ids so adopted quick-add subtasks survive edit → save round-trips', () => {
    const sessionId = '260703-agile-moor'
    const qaId = quickAddNodeId(sessionId)
    // An editor row merged from a quick-add child (nodeId pre-set, prompt = typed title).
    const subtasks: EditorSubtask[] = [
      { uid: 'a', nodeId: 'generate', title: 'Generate', prompt: 'p', model: 'm', dependsOn: [] },
      { uid: 'b', nodeId: qaId, title: 'Task 2', prompt: 'Task 2', model: 'm', dependsOn: [] },
    ]
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks }, noConn)
    const ids = (spec.nodes as Array<{ id: string }>).map((n) => n.id)
    // The qa id lands verbatim (never re-derived from the title), and it round-trips back
    // to the same session id — the adoption linkage the board + editor merges rely on.
    expect(ids).toEqual(['generate', qaId])
    expect(quickAddSessionId(qaId)).toBe(sessionId)
    expect(quickAddSessionId('generate')).toBeUndefined()
  })

  it('derives ids from titles for manually added subtasks and dedupes collisions', () => {
    const spec = buildSpec(
      {
        title: 'T',
        goal: 'g',
        projectId: '',
        orchModel: '',
        subtasks: [
          { uid: 'a', title: 'Same Title', prompt: 'p1', model: 'm', dependsOn: [] },
          { uid: 'b', title: 'Same Title', prompt: 'p2', model: 'm', dependsOn: ['a'] },
        ],
      },
      noConn,
    )
    const nodes = spec.nodes as Array<{ id: string; depends_on?: string[] }>
    expect(nodes.map((n) => n.id)).toEqual(['same-title', 'same-title-2'])
    // depends_on still resolves to the deduped id of the first node.
    expect(nodes[1]!.depends_on).toEqual(['same-title'])
  })

  it('emits acceptance_criteria and max_iterations when set, and clamps max_iterations to the cap', () => {
    const spec = buildSpec(
      {
        title: 'T',
        goal: 'g',
        acceptanceCriteria: '  Must pass all tests.  ',
        maxRepairs: MAX_REPAIR_ATTEMPTS_CAP + 5,
        projectId: '',
        orchModel: '',
        subtasks: [{ uid: 'a', title: 'A', prompt: 'p', model: 'm', dependsOn: [] }],
      },
      noConn,
    )
    expect(spec.acceptance_criteria).toBe('Must pass all tests.')
    expect(spec.max_iterations).toBe(MAX_REPAIR_ATTEMPTS_CAP)
  })

  it('omits acceptance_criteria and max_iterations when unset', () => {
    const spec = buildSpec(
      {
        title: 'T',
        goal: 'g',
        projectId: '',
        orchModel: '',
        subtasks: [{ uid: 'a', title: 'A', prompt: 'p', model: 'm', dependsOn: [] }],
      },
      noConn,
    )
    expect('acceptance_criteria' in spec).toBe(false)
    expect('max_iterations' in spec).toBe(false)
  })

  it('emits max_iterations: 0 (disables repairs) rather than omitting it', () => {
    const spec = buildSpec(
      {
        title: 'T',
        goal: 'g',
        maxRepairs: 0,
        projectId: '',
        orchModel: '',
        subtasks: [{ uid: 'a', title: 'A', prompt: 'p', model: 'm', dependsOn: [] }],
      },
      noConn,
    )
    expect(spec.max_iterations).toBe(0)
  })

  it('keeps a preserved id even when it collides with a manual subtask title slug', () => {
    const spec = buildSpec(
      {
        title: 'T',
        goal: 'g',
        projectId: '',
        orchModel: '',
        subtasks: [
          // Manual row whose title slugifies to 'audit'.
          { uid: 'm1', title: 'Audit', prompt: 'p', model: 'x', dependsOn: [] },
          // Generated row that already owns the id 'audit'.
          { uid: 'g1', nodeId: 'audit', title: 'Renamed audit', prompt: 'q', model: 'x', dependsOn: [] },
        ],
      },
      noConn,
    )
    const nodes = spec.nodes as Array<{ id: string }>
    const byUidOrder = nodes.map((n) => n.id)
    // Preserved id wins 'audit'; the manual row is bumped to 'audit-2'.
    expect(byUidOrder).toContain('audit')
    expect(byUidOrder).toContain('audit-2')
  })

  it('round-trips a fan-in generated spec (generate → edit → create) with both edges intact', () => {
    const generated: SpecNode[] = [
      { id: 'research-competitors', title: 'Research competitors', prompt: 'survey' },
      { id: 'audit-board', title: 'Audit board', prompt: 'audit' },
      {
        id: 'synthesize-brief',
        title: 'Synthesize brief',
        prompt: 'combine ${nodes.research-competitors.output} and ${nodes.audit-board.output}',
        depends_on: ['research-competitors', 'audit-board'],
      },
    ]
    const subtasks = specToSubtasks(generated, 'm')
    const synthRow = subtasks.find((s) => s.nodeId === 'synthesize-brief')!
    expect(synthRow.dependsOn).toHaveLength(2) // both edges visible/editable in the model
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks }, noConn)
    const synth = (spec.nodes as Array<{ id: string; depends_on?: string[] }>).find((n) => n.id === 'synthesize-brief')!
    expect(new Set(synth.depends_on)).toEqual(new Set(['research-competitors', 'audit-board']))
  })

  it('emits both edges after a second dependency is added to a node', () => {
    const subtasks = specToSubtasks(
      [
        { id: 'a', title: 'A', prompt: 'pa' },
        { id: 'b', title: 'B', prompt: 'pb' },
        { id: 'synth', title: 'Synth', prompt: 'p', depends_on: ['a'] },
      ],
      'm',
    )
    const aUid = subtasks.find((s) => s.nodeId === 'a')!.uid
    const bUid = subtasks.find((s) => s.nodeId === 'b')!.uid
    const synth = subtasks.find((s) => s.nodeId === 'synth')!
    synth.dependsOn = [aUid, bUid] // user adds the second dependency in the editor
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks }, noConn)
    const out = (spec.nodes as Array<{ id: string; depends_on?: string[] }>).find((n) => n.id === 'synth')!
    expect(new Set(out.depends_on)).toEqual(new Set(['a', 'b']))
  })

  it('emits only the remaining edge after one of two dependencies is removed', () => {
    const subtasks = specToSubtasks(
      [
        { id: 'a', title: 'A', prompt: 'pa' },
        { id: 'b', title: 'B', prompt: 'pb' },
        { id: 'synth', title: 'Synth', prompt: 'p', depends_on: ['a', 'b'] },
      ],
      'm',
    )
    const aUid = subtasks.find((s) => s.nodeId === 'a')!.uid
    const synth = subtasks.find((s) => s.nodeId === 'synth')!
    synth.dependsOn = synth.dependsOn.filter((d) => d === aUid) // user removes the 'b' chip
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks }, noConn)
    const out = (spec.nodes as Array<{ id: string; depends_on?: string[] }>).find((n) => n.id === 'synth')!
    expect(out.depends_on).toEqual(['a'])
  })
})

describe('model/connection round-trip + project floor (PR #415)', () => {
  // pi/glm is served by 'zai'; claude-x by 'anthropic'. Used to prove connections are derived from
  // the model only when not explicitly preserved.
  const conns = new Map<string, string>([
    ['pi/glm', 'zai'],
    ['claude-x', 'anthropic'],
  ])

  it('round-trips a node with no model without pinning one (it inherits the orchestrator default)', () => {
    const subtasks = specToSubtasks([{ id: 'a', title: 'A', prompt: 'p' }])
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks }, conns)
    const node = (spec.nodes as Array<{ id: string; model?: string; llmConnection?: string }>)[0]!
    expect('model' in node).toBe(false)
    expect('llmConnection' in node).toBe(false)
  })

  it('preserves an explicit node llmConnection instead of re-deriving it from the model', () => {
    const subtasks = specToSubtasks([
      { id: 'a', title: 'A', prompt: 'p', model: 'pi/glm', llmConnection: 'custom-relay' },
    ])
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks }, conns)
    const node = (spec.nodes as Array<{ model?: string; llmConnection?: string }>)[0]!
    expect(node.model).toBe('pi/glm')
    // The authored connection is kept verbatim — NOT overwritten by the model's default ('zai').
    expect(node.llmConnection).toBe('custom-relay')
  })

  it('round-trips task defaults (llmConnection + permissionMode) without rewriting them', () => {
    const spec = buildSpec(
      {
        title: 'T',
        goal: 'g',
        projectId: '',
        orchModel: 'pi/glm',
        orchConnection: 'custom-relay',
        permissionMode: 'default',
        subtasks: specToSubtasks([{ id: 'a', title: 'A', prompt: 'p' }]),
      },
      conns,
    )
    const defaults = spec.defaults as { model?: string; llmConnection?: string; permissionMode?: string }
    expect(defaults.model).toBe('pi/glm')
    expect(defaults.llmConnection).toBe('custom-relay') // preserved, not re-derived to 'zai'
    expect(defaults.permissionMode).toBe('default')
  })

  it('derives the connection from the model when none is preserved (a fresh model pick)', () => {
    const spec = buildSpec(
      {
        title: 'T',
        goal: 'g',
        projectId: '',
        orchModel: 'pi/glm',
        subtasks: [{ uid: 'a', title: 'A', prompt: 'p', model: 'claude-x', dependsOn: [] }],
      },
      conns,
    )
    const defaults = spec.defaults as { llmConnection?: string }
    const node = (spec.nodes as Array<{ llmConnection?: string }>)[0]!
    expect(defaults.llmConnection).toBe('zai') // orchModel pi/glm → zai
    expect(node.llmConnection).toBe('anthropic') // node model claude-x → anthropic
  })

  it('omits defaults.permissionMode when unset so hand-authored specs are untouched', () => {
    const spec = buildSpec(
      { title: 'T', goal: 'g', projectId: '', orchModel: 'claude-x', subtasks: specToSubtasks([{ id: 'a', prompt: 'p' }]) },
      conns,
    )
    const defaults = spec.defaults as { permissionMode?: string }
    expect('permissionMode' in defaults).toBe(false)
  })

  it('preserves an existing project binding when the picker is left on "No Project" (edit mode)', () => {
    const spec = buildSpec(
      {
        title: 'T',
        goal: 'g',
        projectId: '',
        boundProjectId: 'proj_abc',
        orchModel: '',
        subtasks: specToSubtasks([{ id: 'a', prompt: 'p' }]),
      },
      conns,
    )
    // Blank pick floored to the existing binding — the spec (and thus children) keep the project.
    expect(spec.project).toBe('proj_abc')
  })

  it('lets a picked project override the bound floor', () => {
    const spec = buildSpec(
      {
        title: 'T',
        goal: 'g',
        projectId: 'proj_new',
        boundProjectId: 'proj_abc',
        orchModel: '',
        subtasks: specToSubtasks([{ id: 'a', prompt: 'p' }]),
      },
      conns,
    )
    expect(spec.project).toBe('proj_new')
  })
})

describe('quickAddChildToSubtask (PR #415 follow-up)', () => {
  it('preserves an explicit model AND llmConnection from the child session', () => {
    const row = quickAddChildToSubtask({
      sessionId: '260703-agile-moor',
      title: 'Do X',
      model: 'pi/glm',
      llmConnection: 'custom-relay',
    })
    expect(row.nodeId).toBe(quickAddNodeId('260703-agile-moor'))
    expect(row.title).toBe('Do X')
    expect(row.prompt).toBe('Do X')
    expect(row.model).toBe('pi/glm')
    // The connection is carried over — a custom-routed quick-add child keeps its backend on adoption.
    expect(row.llmConnection).toBe('custom-relay')
  })

  it('omits model/llmConnection when the child inherits (node then inherits the orchestrator default)', () => {
    const row = quickAddChildToSubtask({ sessionId: 's1', title: 'Y' })
    expect('model' in row).toBe(false)
    expect('llmConnection' in row).toBe(false)
  })
})

describe('canDependOn cycle guard', () => {
  const rows = (edges: Record<string, string[]>) =>
    Object.entries(edges).map(([uid, dependsOn]) => ({ uid, title: uid, prompt: '', model: 'm', dependsOn }))

  it('forbids self-dependency', () => {
    expect(canDependOn(rows({ a: [] }), 'a', 'a')).toBe(false)
  })

  it('forbids an edge that would close a cycle (candidate transitively depends on the node)', () => {
    // a → c already exists (a depends on c). Offering a as a dependency of c would form c → a → c.
    expect(canDependOn(rows({ a: ['c'], c: [] }), 'c', 'a')).toBe(false)
  })

  it('allows a safe, unrelated dependency', () => {
    expect(canDependOn(rows({ a: [], b: [], c: [] }), 'c', 'a')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// NESSY (UA3.6) — task-spec-form.ts header, adaptations 1–4.
// ---------------------------------------------------------------------------

const oneNode = () => specToSubtasks([{ id: 'a', title: 'A', prompt: 'p' }])

describe('UA3.6 — the folder is a handle, never a path', () => {
  const picked = { id: 'ph_1f2e3d', displayPath: '/Users/someone/projects/alpha' }

  it('POSITIVE — a folder picked in create mode lands in the request as its handle id', () => {
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks: oneNode() }, noConn)
    const req = buildTaskCreateRequest(spec, { folder: picked })
    expect(req.projectHandleId).toBe('ph_1f2e3d')
    expect(JSON.parse(req.yaml).id).toBe('t')
  })

  it('NEGATIVE — neither the yaml nor the request carries the picked path, and the spec has no cwd', () => {
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks: oneNode() }, noConn)
    const req = buildTaskCreateRequest(spec, { folder: picked })
    expect(JSON.stringify(req)).not.toContain(picked.displayPath)
    expect('cwd' in spec).toBe(false)
    // CONTROL on the same instrument: a cwd an edit read back from task.yaml IS round-tripped, so the
    // absence above is the picker's, not a probe that can never see a path.
    const edited = buildSpec(
      { title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks: oneNode(), preservedCwd: '/srv/saved' },
      noConn,
    )
    expect(JSON.stringify(buildTaskCreateRequest(edited, { attachToExistingSession: 's1' }))).toContain('/srv/saved')
  })

  it('NEGATIVE — an edit (attach) never carries a folder, even when one was picked', () => {
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks: oneNode() }, noConn)
    const req = buildTaskCreateRequest(spec, { attachToExistingSession: 'sess-1', folder: picked })
    expect(req).toEqual({ yaml: req.yaml, attachToExistingSession: 'sess-1' })
  })

  it('POSITIVE (UA4.6 follow-up 3) — an edit that saves a Generate plan keeps the draft id beside the attach, still no folder', () => {
    // The host reads the draft id as "an agent wrote these nodes" and records no human confirmation, so Save & Run
    // asks first (board.md "Generate"); the arm above is the control — an edit with no draft carries none.
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks: oneNode() }, noConn)
    const req = buildTaskCreateRequest(spec, { attachToExistingSession: 'sess-1', orchestratorSessionId: 'draft-1', folder: picked })
    expect(req).toEqual({ yaml: req.yaml, attachToExistingSession: 'sess-1', orchestratorSessionId: 'draft-1' })
  })

  it('POSITIVE — create mode adopts a Generate draft by id', () => {
    const spec = buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks: oneNode() }, noConn)
    expect(buildTaskCreateRequest(spec, { orchestratorSessionId: 'draft-1' }).orchestratorSessionId).toBe('draft-1')
  })
})

describe('UA3.6 — a mode above the orchestrator\'s is clamped', () => {
  const build = (permissionMode: 'bypassPermissions' | 'plan' | 'acceptEdits', ceiling?: 'default' | 'auto') =>
    (buildSpec(
      { title: 'T', goal: 'g', projectId: '', orchModel: '', permissionMode, permissionModeCeiling: ceiling, subtasks: oneNode() },
      noConn,
    ).defaults as { permissionMode?: string }).permissionMode

  it('NEGATIVE — bypassPermissions under a default orchestrator is written as default', () => {
    expect(build('bypassPermissions', 'default')).toBe('default')
    expect(build('acceptEdits', 'default')).toBe('default')
  })

  it('POSITIVE — a stricter mode is kept as chosen; no ceiling (create) keeps the choice', () => {
    expect(build('plan', 'auto')).toBe('plan')
    expect(build('bypassPermissions')).toBe('bypassPermissions')
  })

  it('NEGATIVE — an edit offers no mode above the bound session\'s; create offers every workspace mode', () => {
    const picker = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'] as const
    expect(modesAtOrBelow(picker, 'default')).toEqual(['default', 'plan'])
    expect(modesAtOrBelow(picker)).toEqual([...picker])
  })
})

describe('UA3.6 — slugs', () => {
  it('POSITIVE — a Cyrillic title slugs to a non-empty ASCII id, not untitled-task', () => {
    const spec = buildSpec({ title: 'Задача', goal: '', projectId: '', orchModel: '', subtasks: oneNode() }, noConn)
    expect(spec.id).toMatch(/^task-[0-9a-f]{6}$/)
    // A Cyrillic node title gives a valid node id too.
    const nodes = buildSpec(
      { title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks: [{ uid: 'x', title: 'Сборка', prompt: 'p', dependsOn: [] }] },
      noConn,
    ).nodes as Array<{ id: string }>
    expect(nodes[0]!.id).toMatch(/^task-[0-9a-f]{6}$/)
  })

  it('NEGATIVE — two creates titled the same never share a slug once the first is taken (uniqueTaskSlug)', () => {
    const first = uniqueTaskSlug('Задача', new Set())
    const second = uniqueTaskSlug('Задача', new Set([first]))
    expect(second).not.toBe(first)
    const spec = buildSpec({ title: 'Задача', goal: '', projectId: '', orchModel: '', subtasks: oneNode(), fixedId: second }, noConn)
    expect(spec.id).toBe(second)
  })

  it('CONTROL — the editor copy of slugify is byte-identical to packages/shared/src/tasks/slug.ts', () => {
    const fn = (path: string) => {
      const text = readFileSync(path, 'utf8')
      const start = text.indexOf('export const slugify')
      const end = text.indexOf('\n};\n', start)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      return text.slice(start, end + 3)
    }
    const repo = join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..', '..')
    const copy = fn(join(import.meta.dir, '..', 'task-spec-form.ts'))
    const original = fn(join(repo, 'packages', 'shared', 'src', 'tasks', 'slug.ts'))
    expect(copy).toBe(original)
    for (const title of ['My Task', 'Задача', '任务', '!!!', '2026', ' Mixed Задача ']) {
      expect(slugify(title)).toBe(sharedSlugify(title))
    }
  })
})

describe('UA3.6 follow-up — the editor never starts a session in bypassPermissions', () => {
  // Review Focus 3 ("No `allow-all`", until UA4.2 rules on children) and the one responsibility gate
  // (`bypass-permissions-gate.ts`, raised only from App.tsx `handleSessionOptionsChange`): tasks:create
  // starts the orchestrator in the spec's mode without passing that gate, so a create never offers it.
  const picker = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'] as const
  const emitted = (permissionMode: 'bypassPermissions' | 'auto', sessionMode?: 'bypassPermissions' | 'default') =>
    (buildSpec(
      { title: 'T', goal: 'g', projectId: '', orchModel: '', permissionMode, permissionModeCeiling: taskEditorModeCeiling(sessionMode), subtasks: oneNode() },
      noConn,
    ).defaults as { permissionMode?: string }).permissionMode

  it('NEGATIVE — create (no bound session) offers no bypassPermissions and writes a bypass default as auto', () => {
    expect(TASK_NEW_MODE_CEILING).toBe('auto')
    expect(modesAtOrBelow(picker, taskEditorModeCeiling(undefined))).toEqual(['auto', 'default', 'acceptEdits', 'plan'])
    expect(emitted('bypassPermissions')).toBe('auto')
  })

  it('POSITIVE (boundary) — an edit of a session already in bypassPermissions keeps it: the editor activates nothing new', () => {
    expect(modesAtOrBelow(picker, taskEditorModeCeiling('bypassPermissions'))).toContain('bypassPermissions')
    expect(emitted('bypassPermissions', 'bypassPermissions')).toBe('bypassPermissions')
    // and an edit never raises: the bound session's own mode stays the ceiling
    expect(emitted('auto', 'default')).toBe('default')
  })
})

describe('UA4.6 — Generate (task-spec-form adaptation 5)', () => {
  const generated = {
    id: 'weekly-report',
    title: 'Weekly report',
    goal: 'Write it',
    acceptance_criteria: 'Lists every change',
    max_iterations: 2,
    defaults: { model: 'coder', llmConnection: 'gw', permissionMode: 'bypassPermissions' as const },
    nodes: [
      { id: 'gather', title: 'Gather', prompt: 'collect' },
      { id: 'write', title: 'Write', prompt: 'write from ${nodes.gather.output}', depends_on: ['gather'] },
    ],
  }

  it('POSITIVE — generate → manual: a valid result fills the form, keeps the node ids and holds the draft to adopt', () => {
    const outcome = resolveGeneratedResult({ orchestratorSessionId: 'draft-1', spec: generated, validation: { valid: true, errors: [] } }, TASK_NEW_MODE_CEILING)
    expect(outcome.kind).toBe('apply')
    if (outcome.kind !== 'apply') return
    expect(outcome.draftId).toBe('draft-1')
    expect(outcome.form).toMatchObject({ title: 'Weekly report', goal: 'Write it', acceptanceCriteria: 'Lists every change', maxRepairs: '2', model: 'coder', llmConnection: 'gw' })
    expect(outcome.form.subtasks.map(st => st.nodeId)).toEqual(['gather', 'write'])
    const spec = buildSpec({ title: 'Weekly report', goal: '', subtasks: outcome.form.subtasks } as Parameters<typeof buildSpec>[0], noConn) as { nodes: SpecNode[] }
    expect(spec.nodes.find(n => n.id === 'write')?.depends_on).toEqual(['gather'])
  })

  it('NEGATIVE — a generated mode above the editor\'s ceiling is clamped (the generator is an agent)', () => {
    const outcome = resolveGeneratedResult({ orchestratorSessionId: 'd', spec: generated, validation: { valid: true, errors: [] } }, TASK_NEW_MODE_CEILING)
    expect(outcome.kind === 'apply' && outcome.form.permissionMode).toBe(TASK_NEW_MODE_CEILING)
    const kept = resolveGeneratedResult({ orchestratorSessionId: 'd', spec: { ...generated, defaults: { permissionMode: 'plan' } }, validation: { valid: true, errors: [] } }, TASK_NEW_MODE_CEILING)
    expect(kept.kind === 'apply' && kept.form.permissionMode).toBe('plan')
  })

  it('NEGATIVE — a failed or invalid result discards its draft and fills nothing', () => {
    expect(resolveGeneratedResult({ orchestratorSessionId: 'd1', validation: { valid: false, errors: [] }, error: 'Task generation timed out' }, undefined))
      .toEqual({ kind: 'failed', discardDraftId: 'd1', message: 'Task generation timed out' })
    expect(resolveGeneratedResult({ orchestratorSessionId: 'd2', spec: generated, validation: { valid: false, errors: [{ path: 'nodes', message: 'cycle' }] } }, undefined))
      .toEqual({ kind: 'invalid', discardDraftId: 'd2', description: 'nodes: cycle' })
  })

  it('NEGATIVE — a discarded draft is deleted: regenerate/close, a failed result, and a create that did not adopt it', () => {
    const deleted: string[] = []
    const drafts = createGenerateDraftTracker(id => deleted.push(id))
    drafts.adopt('d1')
    drafts.discardCurrent() // regenerate or close
    expect(deleted).toEqual(['d1'])
    expect(drafts.current()).toBeNull()
    drafts.discardDraft('d2') // a failed result
    drafts.adopt('d3')
    drafts.resolveAfterCreate('fresh-orchestrator') // the host created a fresh one: the draft is an orphan
    expect(deleted).toEqual(['d1', 'd2', 'd3'])
  })

  it('POSITIVE — a draft the create adopted is never deleted, not even by the unmount cleanup', () => {
    const deleted: string[] = []
    const drafts = createGenerateDraftTracker(id => deleted.push(id))
    drafts.adopt('d1')
    expect(drafts.current()).toBe('d1') // the save sends it as orchestratorSessionId
    drafts.resolveAfterCreate('d1')
    drafts.discardCurrent()
    expect(deleted).toEqual([])
  })

  it('NEGATIVE — closing the editor while Generate is in flight deletes the pending draft (follow-up: a visible draft never orphans)', () => {
    const deleted: string[] = []
    const drafts = createGenerateDraftTracker(id => deleted.push(id))
    drafts.discardOnClose('pending-1') // "← Board" while the skeleton shows
    expect(deleted).toEqual(['pending-1'])
    drafts.adopt('d2')
    drafts.discardOnClose(null) // closed after Generate finished, unsaved
    expect(deleted).toEqual(['pending-1', 'd2'])
    const editor = readFileSync(join(import.meta.dir, '..', 'TaskEditor.tsx'), 'utf8')
    expect(editor).toContain('draftsRef.current.discardOnClose(pendingGenRef.current)')
  })

  it('POSITIVE — closing after a save that adopted the draft, with nothing in flight, deletes nothing', () => {
    const deleted: string[] = []
    const drafts = createGenerateDraftTracker(id => deleted.push(id))
    drafts.adopt('d1')
    drafts.resolveAfterCreate('d1')
    drafts.discardOnClose(null)
    expect(deleted).toEqual([])
  })

  it('NEGATIVE — a folder picked after Generate moves the held draft there before adoption (follow-up 2: never silently dropped)', () => {
    const drafts = createGenerateDraftTracker(() => {})
    expect(drafts.folderMoveFor({ id: 'hB', displayPath: '/b', trustState: 'trusted' })).toBeNull() // no draft held
    drafts.adopt('d1', undefined) // generated with no folder: the workspace default
    expect(drafts.folderMoveFor({ id: 'hB', displayPath: '/b', trustState: 'trusted' })).toBe('hB')
    drafts.adopt('d2', { displayPath: '/a' }) // generated in A, B picked after
    expect(drafts.folderMoveFor({ id: 'hB', displayPath: '/b', trustState: 'trusted' })).toBe('hB')
    expect(() => drafts.folderMoveFor({ id: 'hU', displayPath: '/u', trustState: 'untrusted' })).toThrow('task-cwd-untrusted')
    const editor = readFileSync(join(import.meta.dir, '..', 'TaskEditor.tsx'), 'utf8')
    expect(editor).toContain('draftsRef.current.folderMoveFor(folder)')
    expect(editor).toContain('window.electronAPI.setSessionProject({ session: { workspaceId, sessionId: draftId }, projectHandleId: moveTo })')
  })

  it('POSITIVE (boundary) — the folder the draft was generated in, re-picked under a new handle, moves nothing', () => {
    const drafts = createGenerateDraftTracker(() => {})
    drafts.adopt('d1', { displayPath: '/a' })
    expect(drafts.folderMoveFor({ id: 'hA2', displayPath: '/a', trustState: 'trusted' })).toBeNull()
    drafts.adopt('d2', undefined)
    expect(drafts.folderMoveFor(undefined)).toBeNull() // nothing picked: the draft stays where it authored
  })

  it('NEGATIVE — a Generate ack that resolves after the editor closed deletes its draft; before close it is claimed', () => {
    const deleted: string[] = []
    const drafts = createGenerateDraftTracker(id => deleted.push(id))
    expect(drafts.claimAck('d1')).toBe(true)
    expect(deleted).toEqual([])
    drafts.discardOnClose(null) // "← Board" while generateTask is still awaiting its ack
    expect(drafts.claimAck('late-1')).toBe(false)
    expect(deleted).toEqual(['late-1'])
    const editor = readFileSync(join(import.meta.dir, '..', 'TaskEditor.tsx'), 'utf8')
    expect(editor).toContain('if (!draftsRef.current.claimAck(ack.orchestratorSessionId)) return')
  })

  // UB12.92 — re-derived from UB2.9 (9e4e1354c), which moved the worst case to attempts × the per-turn cap.
  it('POSITIVE — the editor\'s fallback is the shared constant, 620 s = 2 × 300 s + 20 s; NEGATIVE — no literal timeout', () => {
    expect(GENERATE_CLIENT_TIMEOUT_MS).toBe(MAX_GENERATE_ATTEMPTS * GENERATE_ATTEMPT_MAX_MS + GENERATE_CLIENT_GRACE_MS)
    expect(GENERATE_CLIENT_TIMEOUT_MS).toBe(620_000)
    const editor = readFileSync(join(import.meta.dir, '..', 'TaskEditor.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(editor).toContain("import { GENERATE_CLIENT_TIMEOUT_MS } from '@nessy-agent/shared/tasks/generate-limits'")
    expect(editor).toMatch(/\}, GENERATE_CLIENT_TIMEOUT_MS\)/)
    expect(editor).not.toMatch(/\b(200_000|200000|380_000|380000|620_000|620000)\b/)
  })
})
