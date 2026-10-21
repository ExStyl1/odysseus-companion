/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/task-spec-form.ts
   (craft-agents-oss, Apache-2.0) by UA3.6, 2026-10-02. Adaptations, each named:
   1. `slugify` is a BYTE-IDENTICAL copy of `packages/shared/src/tasks/slug.ts` `slugify` (UA3.2: the non-Latin
      fallback `task-<6 hex>`, FNV-1a, deterministic per title) instead of upstream's ASCII-only one, which turned
      every Cyrillic title into `untitled-task` (spec §10 "Slugs"). The copy is pinned to its original by
      `__tests__/task-spec-form.test.ts` (source text AND outputs), so the two cannot drift silently.
   2. Permission modes are ours (`PermissionMode`, F1.1050 retired `safe`/`ask`/`allow-all`), and `buildSpec`
      CLAMPS the emitted `defaults.permissionMode` to `permissionModeCeiling` when one is given — the mode of the
      session an edit binds the spec onto, so a save never writes a mode the host would refuse to raise to
      (`SessionManager.bindManagedSessionToTask` clamps the session the same way; the yaml stays truthful).
   3. The folder is NEVER a path the editor writes. The folder the user picks is an issued project HANDLE and
      travels beside the yaml as `TaskCreateRequest.projectHandleId` ({@link buildTaskCreateRequest}); the only
      `cwd` the spec can carry is `preservedCwd`, the value an edit read back from the saved task.yaml, round-
      tripped verbatim (the host re-validates it through `validateProjectDirectory` + trust on every save).
   4. {@link buildTaskCreateRequest} is ours: the edit/create/adopt request shape upstream builds inline in
      `TaskEditor.tsx` `submit`, pure so the handle-not-path rule is unit-tested.
   5. UA4.6 — {@link resolveGeneratedResult} (v0.13.4 `TaskEditor.tsx` L714–L747, `applyGeneratedSpec`) and
      {@link createGenerateDraftTracker} (L678–L682, L764–L771, L780–L783, L869–L874: the draft's adopt, discard
      and post-create resolution) are the editor's Generate logic made pure, so `bun test` pins it. One adaptation:
      a generated `defaults.permissionMode` is clamped to the editor's ceiling like every other mode the editor
      writes (adaptation 2) — the generator is an agent, so its spec never lifts the task above what the user may
      pick here. Follow-up: closing the editor while a generation is still in flight deletes that pending draft
      too ({@link GenerateDraftTracker.discardOnClose}); upstream leaks it, but its draft is `hidden` — ours is a
      visible session (UA4.5), so a leaked one would sit in the session list for good; an ack that resolves after the
      close deletes its draft too ({@link GenerateDraftTracker.claimAck}). Follow-up 2: a folder picked after Generate
      is not dropped — upstream moves the adopted orchestrator's cwd on adoption, but our host never moves a folder on
      adopt (`rpc/tasks.ts` header), so the editor moves the held draft first through the canonical mover
      (`projects:setSessionProject`, {@link GenerateDraftTracker.folderMoveFor}); an untrusted pick is refused with the
      host's own `task-cwd-untrusted`, as a fresh create's folder is. Sending no draft id instead would have made the
      save a human one and skipped the run confirmation a generated plan owes (UA4.4). */
/**
 * Pure spec ↔ editor-form conversion for the Tasks DAG authoring surface.
 *
 * Extracted from `TaskEditor.tsx` so the round-trip (generated spec → editable rows →
 * spec sent to `tasks:create`) can be unit-tested without the React component tree.
 *
 * The critical invariant lives here: a node id authored by the generator (and referenced
 * by sibling prompts via `${nodes.<id>.output}`) must survive the round-trip unchanged,
 * otherwise those references dangle and `tasks:create` rejects the spec.
 */
import { PERMISSION_MODE_ORDER, clampPermissionModeToParent, type PermissionMode } from '@nessy-agent/shared/agent/modes'
import type { TaskCreateRequest } from '@nessy-agent/shared/protocol'

// Repair-attempt caps. The canonical source is `DEFAULT_REPAIR_ATTEMPTS` / `MAX_REPAIR_ATTEMPTS_CAP`
// in `packages/shared/src/tasks/schema.ts` (used by the runner + schema validation). The renderer
// can't import that module — its barrel pulls `storage.ts`, which uses `fs` — so these mirror the
// backend values for the editor's numeric control. Keep the two in sync if the backend caps change.
export const DEFAULT_REPAIR_ATTEMPTS = 3
export const MAX_REPAIR_ATTEMPTS_CAP = 10

let _uid = 0
/** Monotonic local row id (not the task node id). Shared so editor + conversions never collide. */
export const uid = (): string => `st-${++_uid}`

/**
 * Deterministic spec-node id for a quick-add child session adopted into a task's DAG:
 * `qa-<sessionId>`. The adoption linkage lives in the node id itself — no session
 * stamping, no title matching: the editor skips re-merging a child whose qa-id is
 * already a spec node, and the board binds that node row back to the original session
 * until a Conductor run supersedes it (a `taskNodeId` match wins). Session ids are
 * lowercase slug-safe (`260703-agile-moor`), so the result satisfies the schema's
 * node-id SLUG_RE.
 */
export const QUICK_ADD_NODE_PREFIX = 'qa-'
export const quickAddNodeId = (sessionId: string): string => `${QUICK_ADD_NODE_PREFIX}${sessionId}`
/** Inverse of {@link quickAddNodeId}: the adopted session id, or undefined for ordinary node ids. */
export const quickAddSessionId = (nodeId: string): string | undefined =>
  nodeId.startsWith(QUICK_ADD_NODE_PREFIX) ? nodeId.slice(QUICK_ADD_NODE_PREFIX.length) : undefined

/**
 * Map a quick-add child session onto an adopted DAG subtask row. Pure (the caller resolves `title`)
 * so the model/connection-preservation contract is unit-testable without the editor. Keeps
 * `model`/`llmConnection` only when the child had explicit ones (undefined → inherit the orchestrator
 * default), so adopting a custom-routed quick-add child doesn't silently drop its backend.
 */
export function quickAddChildToSubtask(child: {
  sessionId: string
  title: string
  model?: string
  llmConnection?: string
}): EditorSubtask {
  return {
    uid: uid(),
    nodeId: quickAddNodeId(child.sessionId),
    title: child.title,
    prompt: child.title,
    dependsOn: [],
    ...(child.model ? { model: child.model } : {}),
    ...(child.llmConnection ? { llmConnection: child.llmConnection } : {}),
  }
}

/**
 * Kebab-case a title into a task/node slug (max 48 chars). A title whose letters are all non-ASCII falls back to
 * `task-<6 hex>`, deterministic per title. A BYTE-IDENTICAL copy of `slugify` in
 * `packages/shared/src/tasks/slug.ts` (UA3.2, whose header explains the fallback): change both or neither —
 * `__tests__/task-spec-form.test.ts` compares the two function texts.
 */
export const slugify = (s: string): string => {
  const ascii = s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!/\p{L}/u.test(s) || /[a-zA-Z]/.test(s)) return ascii;
  let h = 0x811c9dc5;
  for (const ch of s.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `task-${(h >>> 8).toString(16).padStart(6, '0')}`;
};

/** A task's permission mode: ours (adaptation 2). */
export type TaskPermissionMode = PermissionMode

/**
 * NESSY (adaptation 2) — the modes the editor's picker offers: `modes` in their order, without any
 * mode broader than `ceiling` (the bound session's mode in edit mode; none in create mode).
 */
export function modesAtOrBelow(modes: readonly PermissionMode[], ceiling?: PermissionMode): PermissionMode[] {
  if (!ceiling) return [...modes]
  const top = PERMISSION_MODE_ORDER.indexOf(ceiling)
  return modes.filter((m) => PERMISSION_MODE_ORDER.indexOf(m) <= top)
}

/**
 * NESSY (UA3.6 follow-up, 2026-10-02) — the highest mode a CREATE offers and writes: `auto`, the mode below
 * `bypassPermissions`. `tasks:create` starts the orchestrator in the spec's mode without passing the one
 * first-activation responsibility gate (`lib/bypass-permissions-gate.ts`, raised only from App.tsx
 * `handleSessionOptionsChange`), and the plan's Review Focus 3 says "No `allow-all`" until UA4.2 rules on
 * `allow-all` children — so the editor offers no bypass a session does not already have.
 */
export const TASK_NEW_MODE_CEILING: PermissionMode = 'auto'

/**
 * The editor's mode ceiling: the bound session's own mode in edit mode (an edit activates nothing new, and
 * the host never raises it), else {@link TASK_NEW_MODE_CEILING}.
 */
export function taskEditorModeCeiling(boundSessionMode: PermissionMode | undefined): PermissionMode {
  return boundSessionMode ?? TASK_NEW_MODE_CEILING
}

export interface EditorSubtask {
  uid: string
  // Original node id from a generated/loaded spec, preserved across the editor round-trip so
  // AI-authored ${nodes.<id>.output} references embedded in sibling prompts keep resolving.
  // Undefined for subtasks added manually in the editor (their id is derived from the title).
  nodeId?: string
  title: string
  prompt: string
  // Explicit authored model. UNDEFINED = inherit the orchestrator default — buildSpec then emits no
  // `model`/`llmConnection` for the node, so a spec that inherited routing round-trips losslessly
  // instead of silently gaining a pinned model + recomputed connection.
  model?: string
  // Explicit connection serving `model`, preserved from the loaded spec. UNDEFINED = derive from an
  // explicit `model` (or inherit). Preserves a node whose authored connection ≠ the model's default.
  llmConnection?: string
  // All dependency edges of this node, as local uids (not node ids). Multi-dependency so a fan-in
  // node (depends_on: [A, B]) keeps every edge visible and editable. uids that no longer resolve to
  // a row (upstream deleted) are dropped by buildSpec, never emitted as a dangling ref.
  dependsOn: string[]
}

export interface SpecForm {
  title: string
  goal: string
  /** Checkable rubric the orchestrator grades the finished run against. Persisted to `acceptance_criteria`. */
  acceptanceCriteria?: string
  /** Max repair attempts on a FAIL verdict. Persisted to the spec's `max_iterations`. */
  maxRepairs?: number
  projectId: string
  orchModel: string
  /** Connection serving the orchestrator model; preserved from the loaded spec's `defaults` unless the
   *  user changes the model. Emitted to `defaults.llmConnection`. */
  orchConnection?: string
  /** Permission mode for the whole task family (orchestrator + children). Emitted to
   *  `defaults.permissionMode` so subtask autonomy is explicit + persisted, never a hidden default. */
  permissionMode?: TaskPermissionMode
  /** NESSY (adaptation 2): the highest mode the spec may carry — the current mode of the session an edit
   *  binds onto. `permissionMode` above it is emitted clamped to it. Unset in create mode. */
  permissionModeCeiling?: TaskPermissionMode
  /** The task's existing project binding (edit mode). Used as a floor so leaving the picker on
   *  "No Project" preserves the binding instead of silently dropping `project` from the spec — which
   *  would leave the still-bound orchestrator and its children (who read spec.project) disagreeing. */
  boundProjectId?: string
  subtasks: EditorSubtask[]
  /** NESSY (adaptation 3): the `cwd` an edit read back from the saved task.yaml, round-tripped verbatim.
   *  Never a folder the user picked in the editor — that travels as a project handle. */
  preservedCwd?: string
  /** Source slugs enabled on the orchestrator + every child session. Persisted to `sources`. */
  sourceSlugs?: string[]
  /** Skill slugs read as context before each child works. Persisted to `skills`. */
  skillSlugs?: string[]
  // Existing task slug to pin as the spec `id` (edit mode). buildSpec derives `id` from the title
  // by default; without this, editing an existing task's title would fork a new slug/folder and
  // orphan the bound orchestrator session. NESSY: create mode passes a `uniqueTaskSlug` here too
  // (the editor reads `tasks:list` first), so a second task with the same title never collides.
  fixedId?: string
}

/** A spec node as authored by the generator / loaded from disk (loose, renderer-facing shape). */
export interface SpecNode {
  id: string
  title?: string
  prompt?: string
  model?: string
  /** Connection serving `model`; read back into the row so an explicit connection round-trips. */
  llmConnection?: string
  depends_on?: string[]
}

export function buildSpec(form: SpecForm, modelToConnection: Map<string, string>): Record<string, unknown> {
  // Stable, unique node ids (uid → nodeId) so both depends_on AND free-text
  // ${nodes.<id>.output} references in prompts resolve.
  const used = new Set<string>()
  const nodeIdByUid = new Map<string, string>()
  const claim = (base: string): string => {
    let id = base
    let n = 2
    while (used.has(id)) id = `${base}-${n++}`
    used.add(id)
    return id
  }
  // Phase 1 — subtasks carrying a preserved id (from a generated/loaded spec) keep it, so any
  // ${nodes.<id>.output} reference an AI embedded in a sibling prompt still points at a real node.
  for (const st of form.subtasks) {
    if (st.nodeId) nodeIdByUid.set(st.uid, claim(st.nodeId))
  }
  // Phase 2 — manually added subtasks derive an id from their title.
  form.subtasks.forEach((st, i) => {
    if (nodeIdByUid.has(st.uid)) return
    nodeIdByUid.set(st.uid, claim(slugify(st.title) || `node-${i + 1}`))
  })

  const finalIds = new Set(nodeIdByUid.values())
  const nodes = form.subtasks.map((st) => {
    const selfId = nodeIdByUid.get(st.uid)!
    // Explicit connection (preserved from the loaded spec) wins; else derive from an explicit model;
    // else inherit — emit neither model nor connection so the node follows the orchestrator default.
    const conn = st.llmConnection ?? (st.model ? modelToConnection.get(st.model) : undefined)
    // depends_on = every edge mapped uid → node id, restricted to nodes that still exist and never
    // self-referential. A uid whose row was deleted misses the map and is dropped (not a dangling
    // ref). Dedup keeps the array clean.
    const deps = st.dependsOn.map((u) => nodeIdByUid.get(u)).filter((d): d is string => d != null)
    const depends_on = [...new Set(deps)].filter((d) => d !== selfId && finalIds.has(d))
    return {
      id: selfId,
      ...(st.title.trim() ? { title: st.title.trim() } : {}),
      ...(st.model ? { model: st.model } : {}),
      // Pin the connection that serves the model so non-default (pi/*) models resolve a backend.
      ...(conn ? { llmConnection: conn } : {}),
      ...(depends_on.length ? { depends_on } : {}),
      prompt: st.prompt,
    }
  })

  const orchConn = form.orchConnection ?? (form.orchModel ? modelToConnection.get(form.orchModel) : undefined)
  const cwd = form.preservedCwd?.trim()
  const acceptanceCriteria = form.acceptanceCriteria?.trim()
  // Task-family defaults: orchestrator model/connection + the explicit, persisted permission mode.
  const defaults: Record<string, unknown> = {}
  if (form.orchModel) defaults.model = form.orchModel
  if (orchConn) defaults.llmConnection = orchConn
  if (form.permissionMode) {
    defaults.permissionMode = form.permissionModeCeiling
      ? clampPermissionModeToParent(form.permissionMode, form.permissionModeCeiling)
      : form.permissionMode
  }
  // Leaving the picker on "No Project" for an already-bound task must NOT drop `project` (children read
  // spec.project) — fall back to the existing binding as a floor. A picked project overrides it.
  const project = form.projectId || form.boundProjectId
  return {
    id: form.fixedId || slugify(form.title) || 'untitled-task',
    title: form.title.trim() || 'Untitled task',
    goal: form.goal.trim() || form.title.trim() || 'Untitled task',
    ...(acceptanceCriteria ? { acceptance_criteria: acceptanceCriteria } : {}),
    // Persist max_iterations only when set to a non-default; omit lets the runner use its default.
    ...(form.maxRepairs !== undefined && Number.isFinite(form.maxRepairs)
      ? { max_iterations: Math.min(MAX_REPAIR_ATTEMPTS_CAP, Math.max(0, Math.floor(form.maxRepairs))) }
      : {}),
    ...(project ? { project } : {}),
    ...(cwd ? { cwd } : {}),
    // Empty selections are omitted (not persisted as []) so sessions keep workspace defaults.
    ...(form.sourceSlugs?.length ? { sources: form.sourceSlugs } : {}),
    ...(form.skillSlugs?.length ? { skills: form.skillSlugs } : {}),
    ...(Object.keys(defaults).length ? { defaults } : {}),
    nodes,
  }
}

/**
 * NESSY (adaptation 4) — the `tasks:create` request for a built spec. The spec is sent as JSON (a valid
 * YAML subset; the host re-serializes it to real YAML on save). Edit mode binds the spec onto the
 * tile's session and carries NO folder (attach never moves one — only `projects:setSessionProject`
 * does); create mode reuses a Generate draft when there is one and carries the folder the user picked
 * as its issued handle id, never its path. An edit that saves a plan Generate wrote keeps the draft id
 * beside the attach (UA4.6 follow-up 3): attach still wins on the host, which reads the id as "an agent
 * wrote these nodes" and records no human confirmation, so Save & Run asks first, as Create & Run does.
 */
export function buildTaskCreateRequest(
  spec: Record<string, unknown>,
  target: {
    attachToExistingSession?: string
    orchestratorSessionId?: string
    folder?: { id: string }
  },
): TaskCreateRequest {
  const yaml = JSON.stringify(spec, null, 2)
  if (target.attachToExistingSession) {
    return {
      yaml,
      attachToExistingSession: target.attachToExistingSession,
      ...(target.orchestratorSessionId ? { orchestratorSessionId: target.orchestratorSessionId } : {}),
    }
  }
  return {
    yaml,
    ...(target.orchestratorSessionId ? { orchestratorSessionId: target.orchestratorSessionId } : {}),
    ...(target.folder ? { projectHandleId: target.folder.id } : {}),
  }
}

/** Map authored TaskSpec nodes → the editor's multi-dependency subtask rows. */
export function specToSubtasks(nodes: SpecNode[], _fallbackModel?: string): EditorSubtask[] {
  const uidByNodeId = new Map<string, string>()
  for (const n of nodes) uidByNodeId.set(n.id, uid())
  return nodes.map((n) => ({
    uid: uidByNodeId.get(n.id)!,
    nodeId: n.id,
    title: n.title || n.id,
    prompt: n.prompt || '',
    // Keep model/connection OPTIONAL: a node that inherited the orchestrator default must round-trip
    // WITHOUT gaining an explicit model (which buildSpec would otherwise pin + re-route). The editor
    // computes an effective display model separately. `_fallbackModel` is kept for call-site compat.
    ...(n.model ? { model: n.model } : {}),
    ...(n.llmConnection ? { llmConnection: n.llmConnection } : {}),
    // Every edge mapped to a local uid. Edges pointing at ids absent from this spec are dangling
    // (the backend would reject them) so they're dropped rather than carried as raw ids.
    dependsOn: (n.depends_on ?? [])
      .map((id) => uidByNodeId.get(id))
      .filter((u): u is string => u != null),
  }))
}

/**
 * Whether `dependentUid` may add a dependency on `candidateUid` without forming a cycle.
 * False for self, and false when the candidate already (transitively) depends on the dependent —
 * adding the edge would close a loop. Row order is irrelevant: reachability is computed over the
 * actual dependsOn edges, so generator-authored forward edges are handled correctly.
 */
export function canDependOn(
  subtasks: EditorSubtask[],
  dependentUid: string,
  candidateUid: string,
): boolean {
  if (candidateUid === dependentUid) return false
  const byUid = new Map(subtasks.map((s) => [s.uid, s]))
  // Walk the candidate's dependency closure; if it reaches the dependent, the edge would cycle.
  const seen = new Set<string>()
  const stack = [candidateUid]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === dependentUid) return false
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const dep of byUid.get(cur)?.dependsOn ?? []) stack.push(dep)
  }
  return true
}

// ---------------------------------------------------------------------------
// UA4.6 — Generate (header adaptation 5)
// ---------------------------------------------------------------------------

/** A `tasks:generated` push as the editor reads it (`TaskGenerateResult`). */
export interface GeneratedTaskResult {
  orchestratorSessionId: string
  spec?: unknown
  validation: { valid: boolean; errors: Array<{ path: string; message: string }> }
  error?: string
}

/** The editor fields a valid generated spec fills (each only when the generator authored it). */
export interface GeneratedForm {
  title?: string
  goal?: string
  acceptanceCriteria: string
  maxRepairs: string
  model?: string
  llmConnection?: string
  permissionMode?: TaskPermissionMode
  subtasks: EditorSubtask[]
}

export type GeneratedOutcome =
  /** Generation failed before a spec existed: discard the draft, say why. */
  | { kind: 'failed'; discardDraftId: string; message: string }
  /** The spec is missing or invalid: discard the draft, name the first error. */
  | { kind: 'invalid'; discardDraftId: string; description?: string }
  /** Fill the editor, switch to Manual, and keep the draft to adopt on save. */
  | { kind: 'apply'; draftId: string; form: GeneratedForm }

/** What the editor does with a generated result (v0.13.4 `applyGeneratedSpec`, pure). */
export function resolveGeneratedResult(res: GeneratedTaskResult, permissionModeCeiling: PermissionMode | undefined): GeneratedOutcome {
  if (res.error) return { kind: 'failed', discardDraftId: res.orchestratorSessionId, message: res.error }
  const spec = res.spec as
    | { title?: string; goal?: string; acceptance_criteria?: string; max_iterations?: number; defaults?: { model?: string; llmConnection?: string; permissionMode?: TaskPermissionMode }; nodes?: SpecNode[] }
    | undefined
  if (!spec || !res.validation.valid) {
    const first = res.validation.errors[0]
    return { kind: 'invalid', discardDraftId: res.orchestratorSessionId, ...(first ? { description: `${first.path}: ${first.message}` } : {}) }
  }
  const mode = spec.defaults?.permissionMode
  return {
    kind: 'apply',
    draftId: res.orchestratorSessionId,
    form: {
      ...(spec.title ? { title: spec.title } : {}),
      ...(spec.goal ? { goal: spec.goal } : {}),
      acceptanceCriteria: spec.acceptance_criteria ?? '',
      maxRepairs: spec.max_iterations != null ? String(spec.max_iterations) : '',
      // Adopt the generator's routing only when it explicitly authored it — don't wipe the user's picks.
      ...(spec.defaults?.model ? { model: spec.defaults.model } : {}),
      ...(spec.defaults?.llmConnection ? { llmConnection: spec.defaults.llmConnection } : {}),
      ...(mode ? { permissionMode: permissionModeCeiling ? clampPermissionModeToParent(mode, permissionModeCeiling) : mode } : {}),
      subtasks: specToSubtasks(spec.nodes ?? []),
    },
  }
}

/**
 * The editor's one Generate draft (a visible `taskDraft` session, UA4.5): adopted by the next save, discarded when
 * the user regenerates or leaves without saving, and resolved after a create — the host adopts it in place, or (the
 * draft gone or rebound) creates a fresh orchestrator, and then the orphan is discarded.
 */
export interface GenerateDraftTracker {
  /** The draft a save would adopt, or null. */
  current(): string | null
  /** A generated spec was applied: its draft is the one to adopt; `folder` is where it authors (none: the default). */
  adopt(draftId: string, folder?: { displayPath: string }): void
  /** Delete a draft that will never be adopted (a failed or invalid result). */
  discardDraft(draftId: string): void
  /** Regenerate: the held draft, if any, is deleted. */
  discardCurrent(): void
  /** The editor closes: the held draft and the one still generating (`pendingId`), if any, are deleted. */
  discardOnClose(pendingId: string | null): void
  /** After a successful create: stop tracking; delete the draft when the host did not adopt it. */
  resolveAfterCreate(orchestratorSessionId: string): void
  /** The folder handle to move the held draft to before adoption, or null; throws `task-cwd-untrusted` (follow-up 2). */
  folderMoveFor(picked: { id: string; displayPath: string; trustState: string } | undefined): string | null
  /** A Generate ack arrived: true to track it; false (and the draft deleted) once the editor has closed. */
  claimAck(draftId: string): boolean
}

export function createGenerateDraftTracker(deleteSession: (sessionId: string) => void): GenerateDraftTracker {
  let draft: string | null = null
  let draftFolder: string | undefined
  let closed = false
  const discardCurrent = () => {
    const held = draft
    draft = null
    if (held) deleteSession(held)
  }
  return {
    current: () => draft,
    adopt: (draftId, folder) => {
      draft = draftId
      draftFolder = folder?.displayPath
    },
    discardDraft: (draftId) => { deleteSession(draftId) },
    discardCurrent,
    discardOnClose: (pendingId) => {
      closed = true
      discardCurrent()
      if (pendingId) deleteSession(pendingId)
    },
    resolveAfterCreate: (orchestratorSessionId) => {
      const held = draft
      draft = null
      if (held && orchestratorSessionId !== held) deleteSession(held)
    },
    folderMoveFor: (picked) => {
      if (!draft || !picked || picked.displayPath === draftFolder) return null
      if (picked.trustState !== 'trusted') throw new Error('task-cwd-untrusted')
      return picked.id
    },
    claimAck: (draftId) => {
      if (!closed) return true
      deleteSession(draftId)
      return false
    },
  }
}

/**
 * UA12.57 — the tasks:create / tasks:generate refusal codes, mapped to localized copy: raw, they
 * reached the editor's failure toasts as bare wire codes (`task-slug-taken:task-abc123`). Each
 * known code — the row's five, with their on-the-wire suffixes (`permission-mode-above-remote-ceiling:
 * "plan" (…)`) — maps to its `tasks.refusal.*` sentence (en+ru); the slug travels as `{{slug}}`.
 * A code that merely EXTENDS a bare one is deliberately not matched (the boundary arm pins
 * `task-cwd-untrusted-2` → raw), and an unknown error keeps the raw text, so a new host refusal
 * is never silently swallowed. UA12.189 adds `task-orchestrator-missing` (UA12.93's refusal of an
 * edit-mode Generate whose orchestrator was archived or deleted meanwhile).
 */
type Translate = (key: string, params?: Record<string, unknown>) => string

const REFUSAL_CODES: ReadonlyArray<readonly [code: string, key: string]> = [
  ['task-cwd-untrusted', 'tasks.refusal.taskCwdUntrusted'],
  ['project-handle-invalid', 'tasks.refusal.projectHandleInvalid'],
  ['task-attach-connection-locked', 'tasks.refusal.taskAttachConnectionLocked'],
  ['permission-mode-above-remote-ceiling', 'tasks.refusal.permissionModeAboveRemoteCeiling'],
  ['task-orchestrator-missing', 'tasks.refusal.taskOrchestratorMissing'],
]

export function taskRefusalDescription(message: string, t: Translate): string {
  const slugPrefix = 'task-slug-taken:'
  if (message.startsWith(slugPrefix)) return t('tasks.refusal.taskSlugTaken', { slug: message.slice(slugPrefix.length) })
  for (const [code, key] of REFUSAL_CODES) {
    if (message === code || message.startsWith(`${code}:`) || message.startsWith(`${code} `)) return t(key)
  }
  return message
}
