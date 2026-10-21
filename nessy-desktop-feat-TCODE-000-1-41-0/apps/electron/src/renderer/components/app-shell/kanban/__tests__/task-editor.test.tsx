/**
 * UA3.6 — the Phase 3 TaskEditor (a staged copy of v0.13.4 `kanban/TaskEditor.tsx`) and its
 * model catalogue.
 *
 * - The editor is pinned through its SOURCE, the established fallback in this repo for a
 *   component the runner cannot mount (`__tests__/PendingAuthNotice.test.tsx`): its graph reaches
 *   `@nessy-agent/ui`, and loading it under `bun test` timed out the hook at 69.9 s on 2026-10-02
 *   (with the `pdfjs-dist` stubs in place) — the module graph, not an assertion. Each arm carries a
 *   control on the same instrument.
 *   - UA5.10 POSITIVE: the project picker is in (its keys exist, `useProjects` feeds it, a pick sets the
 *     project); NEGATIVE: "No project" is offered only while the task is unbound (the save floors a blank
 *     pick to the existing binding — `buildSpec`, pinned below).
 *   - UA4.6 POSITIVE: the Manual / Generate switch, the Generate pane and the draft's tracker are in.
 *   - UA4.4 POSITIVE: the run control, the Results tab and its panel are in, and the run goes through
 *     the run confirmation (`startTaskRun`); NEGATIVE: the editor never calls `runTask` itself.
 *   - POSITIVE: the Manual editor's keys all exist; the folder is OUR picker and its pick reaches
 *     `tasks:create` only as the handle (`buildTaskCreateRequest`, unit-tested in
 *     `task-spec-form.test.ts`).
 * - `buildModelCatalog`: one group per authenticated connection with its runtime, gateway models
 *   offered under their alias (`coder`, `fast`) — the list pinned to the task schema's own.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GATEWAY_MODEL_ALIASES } from '@nessy-agent/shared/tasks'
import { NESTOR_GATEWAY_CHAT_BASE_URL } from '@nessy-agent/shared/auth/nestor'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import { PERMISSION_MODE_PICKER_ORDER } from '@/lib/composer-permission-modes'
import {
  buildModelCatalog,
  checkedConnectionSlug,
  resolveCatalogDefaultModel,
  resolveDefaultConnectionSlug,
  TASK_GATEWAY_MODEL_ALIASES,
} from '../model-catalog'
import { buildSpec, modesAtOrBelow, specToSubtasks, taskEditorModeCeiling, TASK_NEW_MODE_CEILING } from '../task-spec-form'

const KANBAN_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(KANBAN_DIR, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>

/** TaskEditor.tsx with its comments stripped: what runs, not what the header says is withheld. */
const code = readFileSync(join(KANBAN_DIR, 'TaskEditor.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
/** Every literal `t('…')` key the editor asks for. */
const literalKeys = [...code.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map(m => m[1]!)

describe('UA3.6 — the Phase 3 TaskEditor', () => {
  it('UA5.10 — POSITIVE: the project picker is in; NEGATIVE: "No project" only while the task is unbound', () => {
    for (const key of ['tasks.project', 'tasks.noProject']) {
      expect(literalKeys).toContain(key)
      expect(en[key], key).toBeTruthy()
    }
    for (const call of ['useProjects(workspaceId)', 'setProjectId(p.config.id)', 'setProjectId(bound)', 'setProjectId(sessionProjectId)']) {
      expect(code).toContain(call)
    }
    // The "No project" item sits behind the unbound guard, and nothing else clears the pick.
    expect(code).toMatch(/\{!boundProjectId && \(\s*<DropdownMenuItem[^>]*onSelect=\{\(\) => setProjectId\(''\)\}/)
    expect(code.match(/setProjectId\(''\)/g)?.length).toBe(1)
    // The floor itself: a blank pick on a bound task keeps the binding; a pick overrides it.
    const map = new Map<string, string>()
    const base = { title: 'T', goal: 'g', orchModel: 'coder', subtasks: [] }
    expect((buildSpec({ ...base, projectId: '', boundProjectId: 'p1' }, map) as { project?: string }).project).toBe('p1')
    expect((buildSpec({ ...base, projectId: 'p2', boundProjectId: 'p1' }, map) as { project?: string }).project).toBe('p2')
    expect((buildSpec({ ...base, projectId: '', boundProjectId: '' }, map) as { project?: string }).project).toBeUndefined()
  })

  it('UA4.6 — POSITIVE: the Manual / Generate switch, the Generate pane and the draft tracker are in', () => {
    for (const key of ['tasks.modeGenerate', 'tasks.modeManual', 'tasks.generatePlan', 'tasks.generatingTitle', 'tasks.toastGenerateTimeout']) {
      expect(literalKeys).toContain(key)
    }
    for (const call of ['generateTask(', 'onTaskGenerated(', 'createGenerateDraftTracker(', 'resolveGeneratedResult(', 'resolveAfterCreate(']) {
      expect(code).toContain(call)
    }
  })

  it('UA4.4 — POSITIVE: Create & Run / Save & Run, the Results tab and its panel are in; NEGATIVE: no direct runTask', () => {
    for (const key of ['tasks.createAndRun', 'tasks.saveAndRun', 'tasks.tabResults', 'tasks.tabDefinition', 'tasks.resultsEmpty', 'tasks.toastStarted']) {
      expect(literalKeys).toContain(key)
    }
    for (const call of ['startTaskRun(', 'getTaskResults(', '<ResultsPanel', 'resolveNodeStatePill(', '<RunConfirmationDialog', 'resolveRunControls(']) {
      expect(code).toContain(call)
    }
    expect(code).not.toMatch(/\.runTask\(/)
  })

  it('CONTROL — the same scan reads the editor\'s own keys and calls (the absence arm can fail)', () => {
    for (const key of ['tasks.definition', 'tasks.editTask', 'common.create', 'common.save', 'tasks.toastCreated']) {
      expect(literalKeys).toContain(key)
    }
    for (const call of ['createTask(', 'listTasks(', 'getTask(', 'uniqueTaskSlug(']) expect(code).toContain(call)
  })

  it('POSITIVE — every literal key the editor reads exists in en.json', () => {
    expect(literalKeys.length).toBeGreaterThan(30)
    expect(literalKeys.filter(key => en[key] === undefined)).toEqual([])
  })

  it('POSITIVE — the folder is our CompactWorkingDirectorySelector and its pick goes to tasks:create as the handle', () => {
    expect(code).toContain('<CompactWorkingDirectorySelector')
    expect(code).toContain('onWorkingDirectoryChange={onChange}')
    // UA4.6: a create also carries the Generate draft to adopt (by id) beside the folder handle.
    expect(code).toMatch(/buildTaskCreateRequest\(\s*spec,[^;]*\{ folder, \.\.\.\(draftId \? \{ orchestratorSessionId: draftId \} : \{\}\) \}/)
    // UA4.6 follow-up 3: an edit carries the held draft too, so the host records no human confirmation of it.
    expect(code).toMatch(/buildTaskCreateRequest\(\s*spec,[^;]*\{ attachToExistingSession: editSessionId, \.\.\.\(draftId \? \{ orchestratorSessionId: draftId \} : \{\}\) \}/)
    // NEGATIVE: upstream's selector is gone, and the picked folder's path feeds ONLY the picker's own
    // display — no spec field, no request field.
    expect(code).not.toMatch(/\bWorkingDirectorySelector\b/)
    expect(code.match(/displayPath/g)).toEqual(['displayPath'])
    expect(code).toContain('workingDirectory={folder?.displayPath}')
  })
})

function connection(fields: Partial<LlmConnectionWithStatus> & Pick<LlmConnectionWithStatus, 'slug' | 'providerType'>): LlmConnectionWithStatus {
  return { name: fields.slug, isAuthenticated: true, createdAt: 0, ...fields } as LlmConnectionWithStatus
}

describe('UA3.6 — the editor\'s model catalogue', () => {
  const gateway = connection({
    slug: 'nessy-gateway',
    name: 'Nessy Gateway',
    providerType: 'pi',
    baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL,
    models: [
      { id: 'tgpt/rotating-flagship-0731', name: 'Flagship', shortName: 'coder' },
      { id: 'tgpt/rotating-small-0731', name: 'Small', shortName: 'fast' },
    ] as LlmConnectionWithStatus['models'],
    defaultModel: 'tgpt/rotating-flagship-0731',
  })
  const codex = connection({ slug: 'codex', name: 'Codex', providerType: 'codex-runtime', models: ['gpt-5.3-codex'] })
  const signedOut = connection({ slug: 'claude', name: 'Claude', providerType: 'claude-runtime', models: ['claude-x'], isAuthenticated: false })

  it('POSITIVE — one group per authenticated connection, each with its runtime', () => {
    const { groups, modelToConnection } = buildModelCatalog([gateway, codex, signedOut])
    expect(groups.map(g => [g.connectionSlug, g.label, g.runtime])).toEqual([
      ['nessy-gateway', 'Nessy Gateway', 'pi'],
      ['codex', 'Codex', 'codex-runtime'],
    ])
    expect(modelToConnection.get('gpt-5.3-codex')).toBe('codex')
  })

  it('POSITIVE — gateway models are offered under their alias; NEGATIVE — never under the rotating id', () => {
    const { groups, modelToConnection } = buildModelCatalog([gateway])
    expect(groups[0]!.models.map(m => m.id)).toEqual(['coder', 'fast'])
    expect(modelToConnection.get('coder')).toBe('nessy-gateway')
    expect(modelToConnection.has('tgpt/rotating-flagship-0731')).toBe(false)
    // The workspace default (stored as the id) resolves to its alias.
    expect(resolveCatalogDefaultModel([gateway], groups, 'nessy-gateway')).toBe('coder')
  })

  it('NEGATIVE — a non-gateway catalogue keeps its ids even where a model has a shortName', () => {
    const custom = connection({
      slug: 'custom',
      providerType: 'pi',
      baseUrl: 'https://llm.example.test/v1',
      models: [{ id: 'vendor/model-a', name: 'A', shortName: 'coder' }] as LlmConnectionWithStatus['models'],
    })
    expect(buildModelCatalog([custom]).groups[0]!.models.map(m => m.id)).toEqual(['vendor/model-a'])
  })

  it('CONTROL — the aliases are exactly the ones the task schema accepts as known models', () => {
    expect([...TASK_GATEWAY_MODEL_ALIASES]).toEqual([...GATEWAY_MODEL_ALIASES])
  })
})

describe('UA3.6 follow-up — a pick carries its connection when two gateway cards both offer `coder`', () => {
  // The default flags: "Nessy Gateway" (Pi) and "Claude Code (Nessy Gateway)" are both signed in, in that
  // order, and BOTH arrive through fetchNestorModels with the same aliases (nestor.ts `shortName: alias`).
  const gatewayModels = [
    { id: 'tgpt/rotating-flagship-0731', name: 'Flagship', shortName: 'coder' },
    { id: 'tgpt/rotating-small-0731', name: 'Small', shortName: 'fast' },
  ] as LlmConnectionWithStatus['models']
  const piGateway = connection({
    slug: 'nessy-gateway', name: 'Nessy Gateway', providerType: 'pi', baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL,
    models: gatewayModels, defaultModel: 'tgpt/rotating-flagship-0731', isDefault: true,
  })
  const claudeGateway = connection({
    slug: 'claude-gateway', name: 'Claude Code (Nessy Gateway)', providerType: 'claude-runtime', baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL,
    models: gatewayModels, defaultModel: 'tgpt/rotating-flagship-0731',
  })
  const conns = [piGateway, claudeGateway]
  const subtasks = specToSubtasks([{ id: 'a', title: 'A', prompt: 'p' }])
  const orchestratorConnection = (orchModel: string, orchConnection: string | undefined, map: Map<string, string>) =>
    (buildSpec({ title: 'T', goal: 'g', projectId: '', orchModel, orchConnection, subtasks }, map).defaults as { llmConnection?: string }).llmConnection

  it('POSITIVE — an untouched new task routes `coder` to the workspace default connection', () => {
    const preferred = resolveDefaultConnectionSlug(conns, undefined)
    expect(preferred).toBe('nessy-gateway')
    const { groups, modelToConnection } = buildModelCatalog(conns, preferred)
    const model = resolveCatalogDefaultModel(conns, groups, preferred)!
    expect(model).toBe('coder')
    expect(orchestratorConnection(model, undefined, modelToConnection)).toBe('nessy-gateway')
    // and the check mark sits under that group only
    expect(checkedConnectionSlug(groups, model, undefined)).toBe('nessy-gateway')
  })

  it('CONTROL — upstream\'s last-wins map over the same groups would route it to the other card', () => {
    const { groups, modelToConnection } = buildModelCatalog(conns, 'nessy-gateway')
    const lastWins = new Map<string, string>()
    for (const g of groups) for (const m of g.models) lastWins.set(m.id, g.connectionSlug)
    expect(lastWins.get('coder')).toBe('claude-gateway')
    expect(modelToConnection.get('coder')).not.toBe(lastWins.get('coder'))
  })

  it('POSITIVE — the workspace default, not the order, decides: a Claude-gateway default routes there and heads the list', () => {
    const { groups, modelToConnection } = buildModelCatalog(conns, 'claude-gateway')
    expect(groups.map(g => g.connectionSlug)).toEqual(['claude-gateway', 'nessy-gateway'])
    expect(modelToConnection.get('coder')).toBe('claude-gateway')
    expect(resolveCatalogDefaultModel(conns, groups, 'claude-gateway')).toBe('coder')
  })

  it('POSITIVE — a pick under a group is that group\'s connection; NEGATIVE — the check never shows in both groups', () => {
    const { groups, modelToConnection } = buildModelCatalog(conns, 'nessy-gateway')
    expect(orchestratorConnection('coder', 'claude-gateway', modelToConnection)).toBe('claude-gateway')
    expect(orchestratorConnection('coder', 'nessy-gateway', modelToConnection)).toBe('nessy-gateway')
    expect(checkedConnectionSlug(groups, 'coder', 'claude-gateway')).toBe('claude-gateway')
    // a stale connection that does not offer the model falls back to the routed group
    expect(checkedConnectionSlug(groups, 'coder', 'codex')).toBe('nessy-gateway')
    expect(checkedConnectionSlug(groups, 'not-offered', undefined)).toBeUndefined()
  })

  it('POSITIVE — every picker hands its group\'s connection on; NEGATIVE — no pick re-derives it from the id alone', () => {
    expect(code).toContain('onChange(m.id, g.connectionSlug)')
    expect(code).toContain('setOrchConnection(conn)')
    expect(code).toContain('onChange({ model: id, llmConnection: conn })')
    expect(code).not.toContain('modelToConnection.get(m)')
    expect(code).not.toContain('modelToConnection.get(id)')
    const tile = readFileSync(join(KANBAN_DIR, 'TaskTile.tsx'), 'utf8')
    expect(tile).toContain('onAdd(title, model, connectionSlug)')
    const container = readFileSync(join(KANBAN_DIR, 'KanbanBoardContainer.tsx'), 'utf8')
    expect(container).toContain('const llmConnection = connectionSlug ?? modelToConnection.get(model)')
  })
})

// UB14.6 retargeted this pair: the header (and its Edit task) moved from `ChatPage.tsx` into `chat-header/ChatHeader.tsx`
// (v0.15.1), which carries the same action; the page keeps no copy.
describe('UA3.6 — the chat header\'s "Edit task"', () => {
  const header = readFileSync(join(KANBAN_DIR, '..', 'chat-header', 'ChatHeader.tsx'), 'utf8')
  const page = readFileSync(join(KANBAN_DIR, '..', '..', '..', 'pages', 'ChatPage.tsx'), 'utf8')

  it('POSITIVE — a task orchestrator\'s header points the board\'s editor at it and opens the board', () => {
    expect(header).toContain("setKanbanEditorTarget({ mode: 'edit', sessionId, taskSlug, initialTitle: title })")
    expect(header).toContain('navigate(routes.view.board())')
    // P6.361's launcher still leads the actions, then Edit task (ChatPage's order, kept).
    expect(header).toMatch(/<WorkspaceActionsMenu [^>]*\/>\}\s*\{isTaskOrchestrator && \(/)
  })

  it('NEGATIVE — only a top-level session with a task slug gets the button, and the page keeps no copy', () => {
    expect(header).toContain('const isTaskOrchestrator = !!taskSlug && !item?.parentSessionId')
    expect(header).toContain('{isTaskOrchestrator && (')
    expect(page).not.toContain('setKanbanEditorTarget')
    expect(page).toContain('<ChatHeader') // control: the right file, and it mounts the header
  })
})

describe('UA12.69 — an empty catalogue names no model, never upstream’s DEFAULT_MODEL', () => {
  // The container's `defaultSubtaskModel` is undefined only for an empty catalogue
  // (`resolveCatalogDefaultModel`); at HEAD the prop still appended upstream's `DEFAULT_MODEL`
  // there, and the editor's fallback chain ended at the same Anthropic id — a save then wrote
  // `claude-opus-*` into a node no Nessy connection serves.
  const container = readFileSync(join(KANBAN_DIR, 'KanbanBoardContainer.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('NEGATIVE — the editor’s fallback chain and the container’s prop end at the empty sentinel', () => {
    // The chain itself is pinned, so deleting it cannot satisfy the absence arms.
    expect(code).toContain("const fallbackModel = defaultModel || groups[0]?.models[0]?.id || ''")
    expect(code).not.toContain('DEFAULT_MODEL')
    expect(container).toContain("defaultModel={defaultSubtaskModel ?? ''}")
    expect(container).not.toContain('DEFAULT_MODEL')
  })

  it('POSITIVE — a gateway default still reaches the save as coder (the control the absence arm must not lose)', () => {
    const spec = buildSpec(
      { title: 'T', goal: 'g', projectId: '', orchModel: 'coder', subtasks: [] },
      new Map([['coder', 'nessy-gateway']]),
    ) as { defaults?: { model?: string; llmConnection?: string } }
    expect(spec.defaults?.model).toBe('coder')
    expect(spec.defaults?.llmConnection).toBe('nessy-gateway')
  })

  it('POSITIVE — the empty sentinel saves a node with no model at all (buildSpec omits falsy orchModel)', () => {
    const spec = buildSpec(
      { title: 'T', goal: 'g', projectId: '', orchModel: '', subtasks: [] },
      new Map(),
    ) as { defaults?: Record<string, unknown> }
    expect(spec.defaults).toBeUndefined()
  })

  it('NEGATIVE — the Generate request carries model/connection only when one is named', () => {
    expect(code).toContain('const genConnection = orchConnection ?? modelToConnection.get(orchModel)')
    expect(code).toContain('...(orchModel ? { model: orchModel } : {})')
    expect(code).toContain('...(genConnection ? { llmConnection: genConnection } : {})')
    // The OLD unconditional request fields stood alone on their lines in the request literal; a line-anchored
    // needle (the inline `{ model: orchModel, llmConnection }` object the judge read builds must not trip it).
    expect(code).not.toMatch(/^\s+model: orchModel,$/m)
    expect(code).not.toMatch(/^\s+llmConnection: orchConnection/m)
  })

  it('POSITIVE — with nothing named the pickers show the existing None key, not an empty menu', () => {
    expect(en['tasks.noneSelected']).toBeTruthy()
    expect(code).toContain('if (!value && groups.length === 0)')
    expect(code).toContain("t('tasks.noneSelected')")
  })
})

describe("UA12.157 — the Permission-mode menu is capped to the bound session's live mode", () => {
  // SIT-A (2026-10-04, RC2): with the orchestrator in `default` (and again in `plan`) the menu offered
  // Auto | Manual | Accept edits | Plan — the ceiling fell back to TASK_NEW_MODE_CEILING (`auto`)
  // because the bound session's mode was read from the meta-map snapshot ONCE at mount, and a mode
  // change never writes the meta map (App.tsx routes `permission_mode_changed` into `sessionOptions`
  // only — the composer's own source for the same fact).
  const picker = [...PERMISSION_MODE_PICKER_ORDER]

  it("POSITIVE — the ceiling reads the live options map (the composer's own source), snapshot only as fallback", () => {
    expect(code).toContain('useAppShellContext()')
    expect(code).toMatch(/sessionOptions\.get\(editSessionId \?\? ''\)\?\.permissionMode \?\? editSession\?\.permissionMode/)
  })

  it('NEGATIVE — the one-shot meta-map snapshot no longer feeds the ceiling alone', () => {
    expect(code).not.toContain('taskEditorModeCeiling(asPermissionMode(editSession?.permissionMode))')
  })

  it('POSITIVE — a `default` session offers nothing above Manual/default; a `plan` session nothing above Plan', () => {
    expect(modesAtOrBelow(picker, taskEditorModeCeiling('default'))).toEqual(['default', 'plan'])
    expect(modesAtOrBelow(picker, taskEditorModeCeiling('plan'))).toEqual(['plan'])
  })

  it('POSITIVE — the widest mode (bypass) still offers everything; CONTROL — a create keeps the auto ceiling', () => {
    expect(modesAtOrBelow(picker, taskEditorModeCeiling('bypassPermissions'))).toEqual([...picker])
    // A create has no bound session: the workspace new-session default is the INITIAL PICK (clamped at
    // the create ceiling), and the menu offers nothing above `auto` (adaptation 2, UA3.6 follow-up —
    // unchanged by this row).
    expect(TASK_NEW_MODE_CEILING).toBe('auto')
    expect(modesAtOrBelow(picker, taskEditorModeCeiling(undefined))).toEqual(['auto', 'default', 'acceptEdits', 'plan'])
    expect(code).toContain('clampPermissionModeToParent(defaultPermissionMode, taskEditorModeCeiling(undefined))')
  })
})

describe('UA12.93 — an edit-mode Generate names the tile\'s orchestrator', () => {
  /** The generateTask(...) request literal the editor sends. */
  const request = (() => {
    const at = code.indexOf('generateTask(')
    return code.slice(at, code.indexOf('\n      })', at)) // the call's own closing line
  })()

  it('POSITIVE: the edit branch sends orchestratorSessionId: editSessionId, so the host authors the draft in the task\'s folder', () => {
    expect(request).toContain('...(isEdit && editSessionId ? { orchestratorSessionId: editSessionId } : {})')
  })

  it('NEGATIVE: the picked folder handle rides only a create (never an edit), and nothing sends a raw path', () => {
    expect(request).toContain('...(!isEdit && folder ? { projectHandleId: folder.id } : {})')
    expect(request).not.toMatch(/\bcwd\b/)
  })
})
