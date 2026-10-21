# Task board, planning and projects

Status: accepted, implemented (1.42.0, plan
`docs/superpowers/plans/2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md`, Phases 2–5; spec
`docs/superpowers/specs/2026-09-23-upstream-0-13-4-board-planning-pages-design.md`). Ported from
craft-agents-oss v0.13.4 (Apache-2.0) and adapted to three runtimes through the host seam. Pages and the
t-artifacts publishing chain have their own record, `docs/architecture/pages.md`; this one names them where
they meet the board and projects.

The user- and model-facing guide is the shipped `apps/electron/resources/docs/board.md` (installed as
`DOC_REFS.board`); `CREATE_BOARD_TASK_GUIDANCE` (`packages/shared/src/prompts/system.ts`) names it on every
runtime that offers `create_board_task`.

## The pieces and where they live

| Piece | Where | Row |
| --- | --- | --- |
| The session fields (`kanbanColumn`, `projectId`, `parentSessionId`, `task*`) | `packages/shared/src/sessions/types.ts`, persisted through `sessions/storage.ts` | UA2.1, UA3.1 |
| Board columns, colours, drop-status mapping | `renderer/components/app-shell/kanban/status-column.ts`, `hooks/useKanbanColumnColors.ts`, `atoms/kanban.ts` (`nessy-kanban-*`) | UA2.3, UA2.4 |
| The board view (route, List⇄Board toggle, tiles, drag) | `renderer/components/app-shell/kanban/**` (`KanbanBoardContainer` mounts on the `board` route of `apps/electron/src/shared/routes.ts`); the pure derivation lives in `kanban/board-derive.ts` | UA2.2, UA2.4, UA2.5 |
| Tasks core (spec schema, validation, storage, slug) | `packages/shared/src/tasks/` (exported `./tasks`, `./tasks/slug`) | UA3.2 |
| Create core, bind/adopt, the tasks RPC | `packages/server-core/src/tasks/{create-task,index}.ts`, `handlers/rpc/tasks.ts` | UA3.4 |
| `create_board_task` | `session-tools-core/src/handlers/create-board-task.ts` over the registry slot `createBoardTaskFn`; codex bridge route `taskCreate` | UA3.5 |
| The editor | `renderer/components/app-shell/kanban/TaskEditor.tsx` (our folder picker, `ui/CompactWorkingDirectorySelector.tsx`) | UA3.6, UA4.4, UA4.6, UA5.10 |
| The Conductor | `server-core/src/tasks/TaskRunner.ts` over `tasks/conductor-host.ts` (`SessionConductorHost`) | UA4.1 |
| Run lifecycle, resume, interrupted | `handlers/rpc/tasks.ts` (`run`, `pause`, `resume`, `stop`, `getResults`) | UA4.3 |
| Run confirmation | the ledger digest in `rpc/tasks.ts` (`needsRunConfirmation`, `confirmedDigest`) and `kanban/RunConfirmationDialog.tsx` | UA4.4 |
| Generate | `rpc/tasks.ts` (`tasks:generate` → `tasks:generated`), `tasks/generator-prompt.ts` (Apache-2.0) | UA4.5, UA4.6 |
| Node hostability preflight | `tasks/node-hostability.ts` (`assertNodesHostable`) | UA1.7 |
| Orchestrator folder lifecycle | `tasks/orchestrator-folder.ts` (the delete cascade's ONE predicate) | UA3.8 |
| Projects entity, folder identity, context, assets | `packages/shared/src/projects/**` (`storage.ts`, `project-handle-service.ts`, `project-identity.ts`, `project-context.ts`) | UA5.2, UA5.4, UA5.5, UA5.6 |
| Project RPC, `projectId`, unbind cascade | `handlers/rpc/projects.ts` (`projects:*`), `sessions/storage.ts`, `SessionManager.setSessionProjectId` | UA5.3 |
| Projects UI, session grouping, per-project columns | `renderer/components/projects/**`, `app-shell/ProjectsListPanel.tsx`, `pages/ProjectInfoPage.tsx`, `kanban/KanbanProjectFilter.tsx`, `kanban/project-columns.ts` | UA5.8–UA5.10 |
| Statuses (the workspace's own status set) | `packages/shared/src/statuses/**` (ours since the fork; the board maps status→column through `statusToColumn`) | UA1.2, UA2.3 |
| Script automation action | `packages/shared/src/automations/script-executor.ts` (`runApprovedScript`), `automations/handlers/script-handler.ts` | UA8.1 |
| t-artifacts publishing (pages, chats, files) | `packages/shared/src/artifacts/**` (client, normaliser, registry, publish guard), `server-core/src/sessions/artifact-publishing.ts` (`runArtifactPublish`) | UA1.16–UA1.18 |

## One host seam, named twice

Every renderer channel above runs behind `assertCallerWorkspace`
(`server-core/src/handlers/rpc/caller-workspace.ts`, UA1.9 — ours; upstream has no counterpart): the caller's
workspace is the one its WINDOW is bound to when the request came from a window, and the transport's
`ctx.workspaceId` otherwise, each module keeping its own refusal string (`tasks-workspace-mismatch`,
`project-workspace-mismatch`, `pages-workspace-mismatch`, `artifacts-workspace-mismatch`).

The agent-facing half is the grouped host-closure registry
(`packages/shared/src/agent/session-scoped-tool-callback-registry.ts`): `setSessionStatusFn` and
`resolveStatusFn` (UA1.2/UA1.3), `createBoardTaskFn` (UA3.5), `publishArtifactFn` (UA1.18), the `pages` slot
bound by `SessionManager.pagesToolCallbacksForAgent` (UA6.2). Pi and Claude resolve a slot in process;
codex reaches the same closure over `HOST_CALLBACK_BRIDGE_ROUTES`
(`session-tools-core/src/host-callback-bridge.ts`: `taskCreate`, `artifactPublish`, `artifactList`, the six
`page*` routes), one route per callback member, the CALLER bound — a body names the tool's fields, never
whose session or workspace. A codex spawn without the bridge is not offered the tool at all (UA1.8's rule).

## The board

The board is a VIEW over sessions, not a separate store: a tile is a session (`board-derive.ts`), its column
the session's `kanbanColumn` (or the status mapping's default, `statusToColumn`), persisted by
`SessionManager.setKanbanColumn` and broadcast through `session_metadata_changed` so a second window moves a
card without reload (UA2.1). Archived, hidden, draft and child sessions are not tiles. The board route
(`board` in `shared/routes.ts`) and the List⇄Board toggle are the first user-visible entry (UA2.2); the
staged copy of Phase 2 rendered tiles with the editor, Play and project controls withheld, and each owning
row (UA3.6, UA4.4, UA5.10) removed its withheld range.

Per-project columns (UA5.10) are the project entity's `columns` (`shared/src/projects/types.ts`,
`KanbanColumnDef` from UA2.4, zod-validated in storage): the board's header filter picks one project, the
column editor edits THAT project's set, the last column cannot be removed, and a removed column's cards land
in the first remaining one (`kanban/project-columns.ts` — the rules lifted out as pure functions so `bun
test` pins them without mounting the container). "No project" is ours (`KANBAN_UNASSIGNED_PROJECT`): it
selects tiles with no project and tiles whose project no longer exists, the session list's rule
(`session-list-project-groups.ts`), and never binds a new task.

The needs-input badge, runtime chip and model chip come from the derivation's third argument (UA2.5): this
window's live permission cards and the workspace's connections, so the pure function stays testable. The
model chip is a stated divergence (UA12.46, reason (c)): upstream's `DEFAULT_MODEL` is an Anthropic model a
Nessy Gateway workspace does not serve, so a tile shows the model its session WILL run on
(`resolveSessionTaskModel`) or no chip.

## Durable tasks and the Conductor

A task is `{workspaceRoot}/tasks/<slug>/task.yaml` plus `runs/<runId>/` (run log, per-node outputs)
(`shared/src/tasks/storage.ts`). That root is disjoint from the Pi task-list root `CONFIG_DIR/tasks/` and a
test pins it, or the retention sweep would delete saved tasks. The spec schema is upstream's with our
adaptations: `js-yaml` for `yaml`, `parsePermissionMode` for modes, the non-Latin slug fallback
`task-<6hex>`, warnings for unknown kinds and nodes.

Creation has three doors, one shape: the editor (`tasks:create`), Generate's draft adoption, and the agent
tool `create_board_task` — all through `tasks/create-task.ts`, which refuses a taken slug
(`task-slug-taken:<slug>`), accepts a folder ONLY as a trusted handle (`resolveTaskFolderHandle` →
`task-cwd-untrusted`), and never raises a mode (`clampPermissionModeToParent`). An orchestrator is an
ordinary session carrying `taskSlug`; a Conductor child node carries `taskSlug` + `taskNodeId`, and its
`parentSessionId` is a permission-mode ceiling key (UA4.2 — the child's mode is clamped to the
orchestrator's, and lowering the orchestrator mid-run caps the node's next change).

The Conductor is the host, not a runtime (native-first, UA4.1): Claude `Workflow`, codex `spawn_agent` and
Pi `Workflow` each work inside ONE runtime and one session; none is cross-session, durable and
host-observable, so `TaskRunner` (upstream, adapted) drives a DAG of ordinary sessions through
`SessionConductorHost` (ours). The adapter's decisions are listed in its header: delivery is raced on the
send's ACK, not the turn's end (`midStreamOverride: 'queue'`); the child's folder is the orchestrator's
handle (`getSessionProjectHandleId` — `spec.cwd` never reaches `createSession`, and is re-validated per run
and resume); completion needs a SETTLED session (turn, supervised processes, children, pending cards, no
active goal, no cron or background task — `getBackendBackgroundActivity` adds a Claude background task and
a codex terminal, UA4.8, and `node-woke-after-done` records work that finished after the door); the verdict
turn parses `VERDICT: PASS` / `VERDICT: FAIL — nodes=a,b — reason` after the verify message. A node is an
ordinary session of the orchestrator's project: plugins come from the workspace+project enablement, the
orchestrator's session-scoped plugins do not pass, and node `sources` narrow workspace sources only —
plugin MCP servers follow activation alone (measured 2026-10-02).

A restart never lies: `getResults` derives `interrupted` for a run whose process went away, and
`TaskRunner.rehydrate` re-runs the run's OWN spec snapshot (`readRunSpecSnapshot`, re-validated) with the
params recorded at `run-started` — editing `task.yaml` between a restart and Resume does not change the DAG
(UA4.3).

**Run confirmation (UA4.4)** — the one safety row of Phase 4. A `tasks:run` on a spec the user did not save
(agent-created, Generate-drafted, or edited on disk) is refused with `run-confirmation-required` unless the
request carries the `confirmedDigest` equal to the host ledger's last confirmed one. The digest is a
`task-confirmation` entry in the MACed host-approvals ledger
(`packages/shared/src/approvals/host-approvals.ts`), so an agent cannot confirm its own spec by writing
the ledger. The dialog lists each node's runtime, connection, model, effective mode, sources and the
plugins with their MCP server names.

**Generate (UA4.5/UA4.6)** drafts a spec from a goal in a `taskDraft: true` session that writes nothing:
the draft authors in `dontAsk` mode with queue delivery, 180 s × 2 attempts, and nothing is saved until
the user saves (a save records no confirmed digest — Create & Run asks first). A draft attempting a write
that no rule pre-approves is denied, raises no permission request, and leaves the folder unchanged — on
all three runtimes.

The orchestrator's DELETE cascade is one predicate (`tasks/orchestrator-folder.ts`, UA3.8): only an
orchestrator (a `taskSlug` with no `taskNodeId`) takes its folder, only when no other live session carries
the slug; archiving keeps it. The delete dialog names the folder.

## Projects

Under OQ-1 option (a′): upstream's project ENTITY over OUR folder handle. A project lives in
`{workspaceRoot}/projects/<slug>/config.json`; its `folder` is a `ProjectFolder` written only from a
resolved handle (`ProjectHandleService.validateProjectDirectory` — the one raw-path ingress; a raw
`folder`/`workingDirectory` patch is refused with `project-folder-handle-required`) and carries a STABLE
`projectKey` (inode identity, `project-identity.ts`): a renamed folder keeps its key and trust, a REPLACED
folder is `project-folder-identity-changed`, and `setProjectId` never moves a session's folder (binding
adopts nothing; the session keeps its working directory). A foldered project has no project memory of its
own (reason (c): the folder's `.nessy-agent/MEMORY.md` does it better); a folderless one carries
`projects/<slug>/MEMORY.md` (UA5.12).

**The context layer (UA5.5)** is one host producer for all three runtimes, and it is a FILE: after every
config write the host renders `context.md` through the ported sanitiser
(`formatProjectContextForPrompt`, `prompts/project-context-prompt.ts`) and records the bytes' sha256 as a
`project-context` ledger entry. The capability resolver binds an instruction record only for bytes that
match the ledger digest; a tampered file (codex can write it; Pi and Claude are refused by the
`projects/*/context.md` guard pattern in `GUARDED_WORKSPACE_RECORD_PATTERNS`) is re-rendered from
`config.json`, logged `project-context-tampered`, never used as is. The record's `contentHash` makes a
post-bind swap fail as `capability-resource-stale`. Assets (UA5.6) are `projects/<slug>/assets/` with
symlink-aware exclusive writes; their manifest joins the layer at render time.

The unbind cascade (UA5.3): deleting a project unbinds its sessions
(`ISessionManager.unbindProjectFromSessions`), then its pages (`unbindProjectFromPages` — the cross-lane
pair with UA6.2), then removes the folder. Session grouping, filter and colours (UA5.9) are the session
list's, with our second muted line (`lastOutputSummary`), waiting label and Allow once / Deny kept — the
upstream hunks that would have removed them were split on purpose.

## Statuses

Statuses are ours since the fork (`packages/shared/src/statuses/`, `resources/docs/statuses.md`), not a
v0.13.4 port; the plan's rows changed two things. The board maps a status to a column (`statusToColumn`)
and a column drop may set one (the Appearance map, `resolveDropStatus`). And the agent's own closure is
bounded (UA1.2): `set_session_status` refuses a CLOSED status by category (not by id — a workspace's own
closed status is refused too) with the sentence in `set-session-status.ts` `closedStatusRefusal`; the
human owns closure, and the host, the UI and the Conductor set statuses through
`SessionManager.setSessionStatus` directly, never through the tool's rule.

## The script automation action

`runApprovedScript` (`shared/src/automations/script-executor.ts`, UA8.1) is the ONLY way a `script` action
runs: it reads the bytes once, hashes them, requires a MACed `script-approval` ledger entry bound to
`{ path, sha256, args, runtime }`, writes those exact bytes to a private 0700 copy and spawns the
interpreter on that — never a shell. The env is an allowlist (`buildScriptEnv`), never `process.env`. A
page's scheduled refresh (UA8.2) and a page action's script (UA9.2) go through the same entry with their
own approval kinds (`refresh-approval`, a `page-grant`); `automations:approveScript`,
`pages:approveRefresh` and `pages:runRefreshNow` are the renderer's doors. The managed local-automation
policy is asked at use time, every run. Stated residues: the digest pins the entry file only (an approved
script is one self-contained file), and network stays allowed.

## t-artifacts publishing

The one publish chain: `runArtifactPublish` (`server-core/src/sessions/artifact-publishing.ts`) — the
read-floor guard (`shared/src/artifacts/publish-guard.ts`, UA1.17: realpath inside the session roots, every
`SAFE_MODE_CONFIG.deniedPaths` pattern, `.env` files and the registry refused, one read into one buffer,
the secret scan), the normaliser, the host card, a re-read of the digest, ONE request through the fixed
origin client (`t-artifacts-client.ts`, UA1.16: `https://t-artifacts.t-tech.team`, a fresh dp token per
request, never cached, no env override), the registry row (`artifacts/registry.json`, itself on the denied
read path), and a host-written audit event. Every entry point meets the same chain: the agent's
`publish_artifact` (UA1.18, one card per call in every mode, unattended contexts refused without one), a
chat share (UA1.24/UA1.25: the snapshot builder masks secrets and relativises paths —
`sessions/share-snapshot.ts`), a preview's Publish button (UA1.23), and a Page's Share (UA6.7, through
`pages/page-publishing.ts` and the share bundle — see `docs/architecture/pages.md`).

## Host-record integrity, in one paragraph

Five things this feature set later trusts are written ONLY by the host and checked against the MACed
host-approvals ledger: a page grant, a script digest, a refresh approval, the human-confirmed task spec
digest, and a project-context digest. The agent-writable files they guard (`tasks/*/task.yaml`,
`pages/*/page.json`, `projects/*/config.json`, `projects/*/context.md`, `host-approvals.json`) are
write-refused by `GUARDED_WORKSPACE_RECORDS` / `GUARDED_WORKSPACE_RECORD_PATTERNS`
(`agent/core/pre-tool-use.ts`) on Pi and Claude, and projected into codex's own permission profile as exact
paths where codex accepts them — the pattern rows are a stated codex residue (codex refuses glob subpaths
with `read` access), and what the host trusts for them is the ledger digest, never the file.

## What was not ported

- Upstream's `workingDirectory` on a project — replaced by the handle-typed folder (reason (b), OQ-1 (a′)).
- Upstream's editor folder picker — ours is used (owner 2026-09-23, reason (c)).
- Keyboard drag on the board (OQ-14) — upstream has none; ours since UA12.21 is dnd-kit's own `KeyboardSensor` (Space picks up, Left/Right jump a column, Space/Enter/Tab drop, Escape cancels; the tile opens on Enter only, and not while it is being dragged; a board unmounted mid-drag cancels the drag), with localized announcements (`kanban/board-keyboard-drag.ts`).
- Upstream's messaging pills in the session list (`titleSuffix`) — messaging is removed in ours; the port
  carried the project name only.
- Upstream's `evt.finalText ?? getSessionFinalText(...)` fallback in TaskRunner — it returns the previous
  turn's answer when a turn produced none; ours is `evt.finalText ?? ''` (controller hand-back, UA4.1).
