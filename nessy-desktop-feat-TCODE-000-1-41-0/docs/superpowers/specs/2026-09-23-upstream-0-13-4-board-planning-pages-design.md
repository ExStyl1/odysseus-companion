# Design spec: upstream 0.13.4 adoption — task board, durable tasks and planning, projects, pages

**Plan:** `docs/superpowers/plans/2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md` (it carries the PORT MANIFEST and the FEATURE INVENTORY).
**Status:** final design, 2026-09-23. It started from the native-first draft, took parts of the incremental and host-uniform drafts, and was corrected by six critic reviews: native-host parity, upstream fidelity, grounding, security, port-maximality and plan format. §20 lists every contradiction and how it was resolved.
- Later the same day, two owner directives (§1 rows 5 and 6) revised it. Nothing is gated, so every ported feature ships available and the switch design this spec used to carry is withdrawn (§6). Page publishing is DEFERRED to the owner's internal artifact resource rather than dropped, and Craft's share service stays dropped (§3).
- Three critic reviews of that revision (residue, safety, format) then corrected it once more. Their accepted findings are folded in. The one design change this spec declines is recorded in §20.

**Readings:**
- **Upstream:** `.references/craft-agents-oss` at `v0.13.4` (`b2d6c8aa`). The fork seed is `v0.10.5`.
- **Ours:** the working tree of `feat/TCODE-000-1-41-0`, at HEAD `fbc835776` when this was synthesised. Live 1.41.0 lanes were committing while it was written. Earlier passes read `76f1cc426`, `f11d43e60` and `14e893083`, all ancestors of that HEAD, and the last correction pass read `5fa36c983`.
- **Line numbers** of our code are readings with a date. Rows cite symbols and re-take the line at dispatch.
- **Claude documentation pages** are named in words. Anything not measured is marked **UNVERIFIED** and has an owning row.

## 0. Summary

We port upstream's Kanban board, durable Tasks, planning, Projects and Pages. Planning covers Generate mode, the Conductor DAG runner, acceptance grading with a repair loop, and the v0.13.4 plan dispatcher. The port is **as complete as our architecture allows**. Renderer and backend files are copied file for file, rebranded, and adapted in four classes:

1. **Host seam.** The host holds every durable object and makes every decision. Pi, Claude and Codex execute sessions and reach new host tools through three existing channels: the Pi harness descriptor, the Claude callback registry, and the Codex host-callback bridge.
2. **Folder boundary.** Upstream's entity shapes are kept, but every folder goes through our `ProjectHandleService` (handle, inode `projectKey`, trust). No raw path reaches `createSession` from any source.
3. **Safety posture.** Protections include:
   - Conductor children get a lifetime ceiling at the orchestrator's live mode;
   - agents cannot close cards;
   - the page frame carries its own strict CSP;
   - grants and approvals live in a MACed host ledger;
   - script environments are allowlisted;
   - an approved script runs the exact bytes whose digest was approved (§15);
   - project context reaches a prompt only from a digest-verified render (§12);
   - `delete_page` always shows a card;
   - Craft's public share service is cut, and page publishing waits for the owner's internal artifact resource (§3).
4. **Conventions.** en and ru i18n, the playground sweep, ledger rows, CDP sitting cases, tracker rules.

**No feature gating (owner, 2026-09-23).** The owner's words: «нет, закрывать ничего не нужно, делаем сразу как доступные фичи». Nothing is gated. Every ported feature ships AVAILABLE by default: the board, tasks, planning, projects, Pages (core, UI, thumbnails), the automation script action, scheduled page refresh, and page actions with grants. There is no switch, flag, environment toggle or managed switch key. Each surface's own controls carry its safety, and the existing managed policies keep applying (§6).

**Release shape.** A phase ships only when it is user-complete and its live cases pass.
- **Valid cuts:** the end of Phase 1, and the end of board Phases 2, 4 and 5. Phase 3 alone is not a cut, because it creates specs that nothing can run until Phase 4. On the pages lane, each merged unit is a cut: Phases 6+7, then 8, then 9.
- **Pages lane.** It lands on its own branch and merges into the release branch in whole units. A unit not complete by the 1.42.0 cut is not merged and moves to 1.43.0, rather than shipping hidden.
- **Board lane.** Once the controller names the board-lane cut boundary, later board phases also wait for 1.43.0 (§21 OQ-5).

**Upstream code in scope:**

| Area | Lines |
| --- | --- |
| kanban directory | 4,709 |
| `shared/tasks` | 1,351 |
| `server-core/tasks` | 1,900 |
| `shared/pages` | 4,876 |
| `server-core/pages` | 857 |
| renderer pages | 2,287 |
| `shared/projects` | 730 |

Integration hunks come on top. About 1,500 upstream lines are not ported now, nearly all of them sharing:
- **Dropped:** the Craft service client (`publisher.ts` lines 1–435), and its `feature-flags.ts` and `credentials/types.ts` hunks.
- **DEFERRED to the owner's internal artifact resource (§3):** about 1,040 lines — the share bundle, its test and `SharePageDialog.tsx`.

## 1. Owner decisions (2026-09-23)

| # | Intent | Reading |
| --- | --- | --- |
| 1 | Adopt the upstream Kanban board. This reverses 2026-07-19 "do not adopt kanban/tasks", which was recorded only in auto-memory. Planning must be covered. | §2 maps every planning element to a row. |
| 2 | Fit OUR runtimes, integrations and host object. | §4 layer table; §5 architecture; reach matrix. |
| 3 | Pages behind a flag, OFF by default. Public sharing is cut. | **The flag half is reversed** later the same day (row 5), and **the sharing half is narrowed** (row 6): Craft's share service stays dropped under reason (a), and the publishing feature is DEFERRED (§3). §13–§16. |
| 4 | Undecided: Projects, the script action, the release. | §21, with recommended defaults. Row 5 decides the script action (OQ-4). |
| Addendum | PORT by default. Copy the frontend. Drop only for (a) a Craft external service, (b) a security posture with no safe adaptation, or (c) an existing Nessy feature that does it better, citing the file. Port Pages as fully as possible. The plan must carry a manifest and an exhaustive inventory. | §3 is the complete drop and deferral list. The manifest and inventory are in the plan. |
| 5 (reversal, later 2026-09-23) | «нет, закрывать ничего не нужно, делаем сразу как доступные фичи» — "no, nothing needs to be gated; we ship them straight away as available features". | Reverses row 3's flag and the whole switch design: no switches of any kind, and every ported feature is available by default, Pages included (§6). OQ-3 and OQ-4 are DECIDED; the release shape follows from it (OQ-5). |
| 6 (later 2026-09-23) | «для артефактов я попозже дам наш внутренний скил/ресурс и подключим» — "for artifacts I will provide our internal skill/resource later, and we will connect it". | Page publishing is DEFERRED, not dropped. The share UI, bundle, channels, keys and tool fields wait for that resource (§3; plan UA6.7 ⏸; OQ-18, which has no default). Craft's share service, its Worker and every Craft URL stay dropped under (a), and a guard forbids them (plan UA6.6). |
| 7 (later 2026-09-23) | «можем ли мы сделать в хост объекте для всех рантаймов возможность создания артефакта через любой рантайм используя https://t-artifacts.t-tech.team/»; «по артефактам да, использовать то что выше дал»; «нужно понять как сам craft agents их делает, то есть что является тригером и взять как есть условно, но использовать именно наш механизм»; chat sharing «пока только как ресерч». | Row 6 resolves to t-artifacts: one host publisher for Pi, Claude and Codex, craft's trigger behaviour kept (§24). OQ-18 and OQ-22 decided. |

## 2. What upstream calls "planning", and how this plan covers it

Upstream "planning" is four things. None of them is scheduled: a task runs when a user clicks.

| Upstream element | What it is at `v0.13.4` | Ours today | Disposition | Rows |
| --- | --- | --- | --- | --- |
| **Generate mode** | `tasks:generate` creates a `taskDraft` orchestrator session. That session authors `task.yaml` from a goal using `generator-prompt.ts`. `extractYaml` pulls the YAML out, it is validated, and it is pushed back through `tasks:generated`. Each attempt has a 180 s timeout, with 2 attempts (one repair turn). Nothing is saved until the user saves; saving adopts the draft. | none | **Port.** Adapted: the draft authors in `dontAsk` (the only mode that never raises a card on any runtime); it is not `hidden`; messages are queued, never steered; the client timeout is attempts × timeout + 20 s. | UA4.5, UA4.6 |
| **The DAG format** | `schema`, `refs`, `validate` (caps 64/24/24/50), `storage`, `slug`. | none | **Port** with `js-yaml`. Beta kinds and flags are accepted with a warning. | UA3.2 |
| **Conductor** (`TaskRunner`) | Each node runs as a child session: `depends_on`, `${nodes.x.output}`, params, inputs, skills preamble, sources, `max_parallel`, retry, token budget, run-log, spec snapshot, rehydrate. | none (the Pi `Workflow` runs inside one Pi session only) | **Port.** Adapted through `SessionConductorHost`: completion is turn-scoped, children take the orchestrator's handle and mode ceiling, hostability is preflighted, and resume uses the run snapshot. | UA4.1–UA4.3 |
| **Acceptance grading and repair** | A verify message goes to the orchestrator. The last `VERDICT:` line wins, and its `nodes=` part is split on an em-dash or colon. Up to 2 re-asks when the verdict does not parse. The repair frontier is the named nodes plus their dependents. `max_iterations` defaults to 3, capped at 10. | none (`/goal` grades one session only) | **Port verbatim.** Only a completion whose turn started after the verify message counts as the verdict. | UA4.1, UA4.7 |
| Pause / resume / stop | The channels exist upstream; nothing in the UI calls them. | none | **Port and add the UI.** | UA4.3, UA4.4 |
| Tile Play, "Create & Run", Results tab | UI | none | **Port.** Add a run confirmation, enforced by the host, for specs no human saved. | UA4.4 |
| Agent `create_task` | Creates a task; never runs it. | none | **Port** as `create_board_task`, on three runtimes. | UA3.5 |
| **Plan mode** | Plan approval, plus the v0.13.4 `pending-plan-dispatch.ts` single-dispatch claim. | Plan mode is ours. Our claim returns `Promise<void>` and cannot refuse. | **Port** the dispatcher, the storage claim, and the tests. | UA4.9 |
| **Planner playground** | `registry/planner.tsx` prototype, never wired to the product. | Ours, identical except for 4 rebrand lines. `planner.css` inlines the shadow because `--shadow-dragging` has 0 hits in our tree. | Port the `index.css` token. `planner.css` then copies verbatim. | UA2.3 |

**Coverage.** Every upstream planning behaviour is ported. We add a run UI, honest restart state, three-runtime reach, and a run confirmation. Nothing is dropped.

**Control-flow node kinds.** Upstream has no text for them (`tasks-architecture.md` is not in its repo), so executing them would be invention. They parse and warn, as recorded in OQ-2.

## 3. Port rules, the complete drop list, and what is deferred

**Default disposition: copy-verbatim.** "copy+adapt" means only these changes:
- rebrand: `Craft`→`Nessy`, `@craft-agent`→`@nessy-agent`, `CRAFT_`→`NESSY_`, `craft-pages/v1`→`nessy-pages/v1`, `craft-*` localStorage keys→`nessy-*`;
- en and ru i18n;
- our tokens and components;
- the host seam, capability projection and cards;
- folder-handle ingress.

Anything else is a rewrite and carries its reason. A **staged copy** is still copy+adapt. Its header records each upstream range withheld until its owning row lands (`withheld: v0.13.4 L<a>–L<b> → UA<x>`), and that row removes the line.

**Licence and docs.**
- Upstream is Apache-2.0; LICENSE and NOTICE are kept.
- Copied files record `v0.13.4:<path>` in their header. Adapted prompt text records its source and licence.
- Shipped product docs are rewritten in our words (docs/README rule).

| Dropped | Reason |
| --- | --- |
| `pages/publisher.ts` lines 1–435 (publish, unpublish, password): the client of Craft's Cloudflare pages-share Worker. Its default base is `DEFAULT_PAGES_SHARE_API_BASE_URL = 'https://thecraftagents.com/p/api'`, overridable by `CRAFT_PAGES_SHARE_API_URL`. Its local-delete half (lines 436–471, `deletePageWithUnpublish`) is **ported** as `deletePageLocal`. | (a) Anonymous POST to thecraftagents.com, and the owner's cut of Craft's service. Precedent: `branding.ts` `VIEWER_URL = ''` and `SessionManager` `requireViewerUrl`. |
| `isPagesSharingEnabled` / `CRAFT_FEATURE_PAGES_SHARING` (the whole `feature-flags.ts` hunk since the seed), and the `page_publish_token` credential type (the Worker-minted capability that authorises update and unpublish) | (a) Both exist only for Craft's service. Nothing in this port is gated (§6). If the owner's resource needs a credential, UA6.7 defines its own. |
| thecraftagents.com docs URL in the system prompt; the `sources.md` hunk, which points the Google OAuth redirect at `thecraftagents.com/auth/callback` | (a). Copying it would send users' OAuth codes to Craft. |
| Upstream's separate per-workspace `McpClientPool` for page actions | (b) It bypasses our MCP authority and leasing. Rewritten onto `WorkspaceMcpPoolRegistry.lease`. |
| The `CRAFT_*` prefix pass-through over `process.env` (`v0.13.4:packages/shared/src/automations/utils.ts` lines 355–358) | (b) After rebrand it would hand `NESSY_DP_AUTH_TOKEN`, `NESSY_CLI_DP_AUTH_TOKEN`, `NESSY_SERVER_TOKEN` and `NESSY_WH_*` secrets to every script. The allowlist half is kept. |
| Grants and approvals trusted from `page.json` | (b) An agent can write the file. Moved to the MACed host ledger (§16). |
| Project `MEMORY.md` for projects **with a folder** | (c) `<folder>/.nessy-agent/MEMORY.md` is already that folder's memory on all three runtimes (`capabilities/native-sources.ts`). Folderless projects: UA5.12. |
| TaskEditor `ANTHROPIC_MODELS` fallback | (c) Our model list is the connection catalogue (`AppShellContext.llmConnections`); gateway models resolve by alias. |
| `archive-guards.ts` **scoping arm** | (c) `SessionManager.archiveSessionForAgent` scopes to the workspace and shows a card in every mode. The **mid-turn refusal arm is ported** (UA3.8): ours has no `isProcessing` check. |
| `server-core/src/sources/build-servers.ts` | (c) Rewritten onto our `getSourceServerBuilder`. |
| `PageSourceAuthBanner` inline single-value credential dialog | (c) The renderer has no credential-save channel: `saveSourceCredentials` is absent from `channels.ts` and `shared/types.ts`, and `git log -S` shows `b0053399e` as its last touch. Credentials are entered through the Sources flow. The OAuth path and the "fix with agent" hand-off are ported. |

**Deferred, not dropped: awaiting the owner's internal artifact skill/resource** (owner 2026-09-23, §1 row 6; plan UA6.7 ⏸; OQ-18). These pieces are the page publishing FEATURE, as distinct from Craft's service. Once the owner supplies the resource, they are designed and ported against it, re-derived rather than copied blind:

| Deferred | What it is upstream |
| --- | --- |
| `SharePageDialog.tsx` (464 lines) | the share dialog: publish, password, unpublish |
| `share-bundle.ts` (311) + test (266) | builds the bundle a publication uploads |
| The five share channels `pages:getShareCapabilities`, `pages:getShareDataScan`, `pages:publish`, `pages:setPublicationPassword` and `pages:unpublish`, with their `rpc/pages.ts` handlers | the RPC surface |
| Publication types in `core/src/types/page.ts`; `PageToolSummary.shared`, `shareUrl` and `wasPublished` in `session-tools-core/src/context.ts`; the "share state" wording in the `list_pages` description | the tool and DTO surface |
| 31 `pages.*` share keys (30 `pages.share*`/`shared` + `pages.deleteSharedNote`) and 7 share toasts | the copy |

**Until the resource arrives:**
- Craft publication fields in `page.json` are stripped on read, as its `grants` are.
- No tool summary carries share state.
- A guard forbids Craft's hosts and share-service knobs, never sharing as such (plan UA6.6).

**Everything else is ported**, in a later phase, and ships available (§6).
- `ActiveTasksBar.tsx` (52-line upstream diff) and the chip-state files are MEASURED in UA4.11 before any drop.
- `useBackgroundTasks.ts` has no upstream diff since the seed, so it is not an adoption item.

## 4. Layer ownership (native-first) and reach

| Capability | What each runtime has | Layer | Verdict |
| --- | --- | --- | --- |
| Board cards and columns | **Claude:** only the claude.ai `Projects` tool (a cloud surface). **Codex:** `Project` notifications, with 0 of 102 client requests about projects. **Pi:** none. | host facts + renderer | UNIFORM |
| "Needs input" on a card | Host `awaitingApprovalCount` on the Session DTO | host | UNIFORM |
| Durable task, runs, outputs | none | host, `{workspaceRoot}/tasks/` | UNIFORM |
| DAG execution | **Claude:** `Workflow` resumes only in the same session. **Codex:** `spawn_agent` is scoped to one turn. **Pi:** `Workflow` only. None is cross-session, durable and host-observable. | host Conductor; native engines run INSIDE a node | UNIFORM (nestor-cloud refused) |
| Grading and repair | Upstream is already host-side (message + parse) | port | UNIFORM |
| Generate | orchestrator session + final text | host | UNIFORM |
| Plan approval inside a node | Pi and Claude show a card; codex has none (existing `planApproval` row) | existing | HONEST |
| Pages | **Claude:** `Artifact` publishes to claude.ai, a publish path outside the product (UA1.5). **Codex, Pi:** none. | host tools | UNIFORM |
| Scheduled refresh | Host automations `SchedulerTick`. Claude scheduled tasks and routines are cloud or desktop surfaces (pages not read, UNVERIFIED). | host | UNIFORM |
| Project entity | Codex: no client API. Claude: the cwd. Pi: none. | host entity over our handle | UNIFORM |
| Project context | Pinned capability block, delivered by `BaseAgent.chat` message parts on all three | host, file-backed prompt layer | UNIFORM (measured UA5.5) |

**Reach matrix (target state):**

| Surface | Pi | Claude | Codex | Verdict |
| --- | --- | --- | --- | --- |
| `set_session_status` / `set_session_labels` | yes | yes | yes after UA1.3 | UNIFORM |
| `create_board_task`, six page tools | registry | callback registry | bridge `/task/create`, `/page/*` | UNIFORM: offered wherever the runtime hosts session tools (codex when the host-callback bridge is present, as for every bridged tool) |
| `delete_page` confirmation | card | card | card; unattended → deny | UNIFORM |
| Conductor node, Generate draft | host session | host session | host session | UNIFORM |
| Background work outliving a node's turn | Pi Workflow, goal, cron | Claude L2 agents, cron, Monitor | collab agents, cron | HONEST (UA4.8) |

## 5. Architecture

```
renderer (board, TaskEditor, Projects, PagesHome/PageView)
   │ RPC: tasks:* projects:* pages:*      push: session_metadata_changed, tasks:generated, pages:changed
   ▼
HOST (server-core)
 SessionManager: +projectId parentSessionId kanbanColumn taskSlug taskRunId taskNodeId taskNodeCount taskDraft
   onSessionComplete (idle arm only, turn-scoped final text, error flag)
 TasksStore {ws}/tasks/<slug>/ ── TaskRunner ── SessionConductorHost ── createSession(projectHandleId) + sendMessage(queue, onAck)
 ProjectsStore {ws}/projects/<slug>/ ── ProjectHandleService (the only raw-path ingress, plus trust) ── context.md writer (digest in the ledger)
 PagesStore {ws}/pages/<slug>/ · tool callbacks · watcher
 host-approvals ledger (MACed) — grants · script digests · refresh approvals · confirmed spec digests · project-context digests
 AutomationSystem + runApprovedScript (the only script entry; runs the verified bytes) · PageActionBroker → WorkspaceMcpPoolRegistry.lease / getSourceServerBuilder
      │ Pi: harness descriptor   │ Claude: callback registry   │ Codex: HOST_CALLBACK_BRIDGE_ROUTES + session-mcp-server
Electron main: will-frame-navigate guard · PageThumbnailer (sandbox, CSP, network-cancel partition, window-open and navigation denied)
```

**How a new registry tool reaches each runtime.** The pattern below is traced on `set_session_status`. Do not copy `archive_session`: it has no descriptor entry.

- **Pi descriptor.** `external(...)` plus `sessionBinding(...)` in `packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts`. Pin it in `packages/pi-agent-server/src/__tests__/harness-contract/fixtures/tool-surface.json`.
- **In-process.** A closure in `session-scoped-tool-callback-registry.ts` and a lazy getter in `session-self-management-bindings.ts`.
- **Codex.**
  - Membership in both `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` and `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`.
  - A route in `HOST_CALLBACK_BRIDGE_ROUTES` (`packages/session-tools-core/src/host-callback-bridge.ts`).
  - A client in `packages/session-mcp-server/src/host-callback-bridge-client.ts`.
  - A handler in `packages/shared/src/agent/backend/codex/session-callback-bridge.ts`.
- **Pins that move in the same commit:**
  - `scheduling-projection.test.ts`, `external-standalone.test.ts`, both `runtime-capability-drift.test.ts`, `runtime-switch-costs-surface-counts.test.ts`, `apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts`;
  - `packages/pi-agent-server/src/harness/source-state-contract.ts` (`liveJsonSchemaDigests`), `live-manifest-compositions.ts` (`liveSessionDynamicTools`);
  - the comment above the `claude-agent.ts` `availableToolNames` call, whose measured name counts move. The call itself needs no option. `getSessionToolNames()` is the Claude projection of the registry, so it already includes the new tools, and a restricted Claude subagent can be granted them.

**No offer gate (§6).** The new tools carry no `SessionToolFilterOptions` field and no spawn flag. They are offered by the rule every existing session tool follows:
- **Pi and Claude:** whenever the session tool registry is offered (the harness descriptor; `session-scoped-tools.ts`).
- **Codex:** membership in both host-callback sets, so the external-standalone arm of `getSessionToolDefs` offers them exactly when the spawn has the host-callback bridge.
- **Every callback** checks what it always checks — workspace, folder handle, mode, card — and no feature flag.

**The Conductor host adapter (`SessionConductorHost`).**
- **Why it must not block.** Our `sendMessage` resolves when the turn is over, and **so does upstream's** (`v0.13.4:…/SessionManager.ts`, line 6223, `for await` over the chat iterator). `TaskRunner` fire-and-forgets dispatch (`v0.13.4:…/TaskRunner.ts` line 325, `void this.dispatch(node)`), so `max_parallel` is never serialised.
- **Every send uses queue mode.** The adapter passes `{ midStreamOverride: 'queue' }` (`protocol/dto.ts`, P6.480) on every Conductor and Generate send, so no runtime steers a Conductor message into a live turn.
- **Settling a send.** The adapter races `onAck` against the send settling, over the three arms `runWorktreeBatch` names (C3.328):

  | How the send settles | Meaning | Adapter action |
  | --- | --- | --- |
  | ack | dispatched | wait for `onSessionComplete` |
  | resolved with no ack (a slash-command arm) | not delivered | synthetic `error` completion: "prompt not delivered" |
  | rejected before the ack | dispatch failure | `TaskRunner`'s catch calls `failNode` once |
  | rejected after the ack | turn failure | ignored; the turn's outcome arrives through `onSessionComplete`, so it is reported exactly once |
- **`getSessionWorkingDirectory` is replaced by `getSessionProjectHandleId`.** `dispatch()` passes `projectHandleId` and never `workingDirectory`. Our `CreateSessionOptions.workingDirectory` is `'user_default' | 'none'`, so the upstream hunk would not even typecheck.

## 6. No feature gating (owner 2026-09-23)

**The decision.** Later on 2026-09-23 the owner reversed the flag half of decision 3, and with it the switch design this section used to specify: «нет, закрывать ничего не нужно, делаем сразу как доступные фичи» — "no, nothing needs to be gated; we ship them straight away as available features". Every ported feature ships AVAILABLE by default:
- the board, tasks and projects;
- planning: Generate, the Conductor, grading and repair, and the plan dispatcher;
- Pages: core, UI and thumbnails;
- the automation script action and scheduled page refresh;
- page actions with grants.

**What is therefore not built.**
- no stored switch key, no `NESSY_SWITCH_*` environment variables, no managed-policy switch key;
- no `switches:*` RPC or push, and no Settings toggles;
- no `feature-disabled:<name>` refusal, no off notice, no hidden entry;
- no switch-aware tool offer: no `SessionToolFilterOptions` field and no codex spawn flag for the new tools (§5);
- no default flip at close-out, and no switch precondition in a live case.

**How tools and prompt sections are offered.** By the rule every existing session tool follows (§5): on Pi and Claude with the session tool registry, and on codex whenever the spawn has the host-callback bridge. A prompt section is delivered on a slot exactly when its tools are offered there.

**Where each former switch's protection comes from.** The switches only controlled availability. They sat on top of these controls and added none of their own. Each surface keeps the controls this design already gave it:

| Former switch | Surfaces | Controls that carry the safety |
| --- | --- | --- |
| `board` | board, tasks, planning, projects | the closure guard (§8). No task runs on its own: a user starts every run, and a spec no human saved or confirmed needs the run confirmation, which the host enforces against the digest in the MACed ledger (§10, §16). Conductor children run under the orchestrator's lifetime ceiling (§11). Folders enter only through handles, trust and a persisted stable `projectKey` (§10, §12). Project context reaches a prompt only from a digest-verified render (§12). `assertCallerWorkspace` guards every handler. `create_board_task` carries its restrictions (§10). |
| `pages` | Pages core, UI, thumbnails | the frame CSP, `sandbox`, the `event.source` and origin checks, the `will-frame-navigate` guard and the `open-url` confirmation (§14). The `delete_page` card in every mode (§13). The hardened thumbnailer, which also denies window-open and navigation (§14). Guard patterns on `page.json` (§16). No Craft share service (§3). A measured frame leak holds the unit out of the release (plan UA7.6). |
| `pageRefresh` | scheduled refresh | the host writes the script from content. The refresh is inert until a human approves its digest in `PageView`. `runApprovedScript` is the only entry and runs the verified bytes. The env allowlist. Audit (§15). |
| `pageActions` | page source actions | grants come only from the MACed ledger, never `page.json`. The `scriptSha256` re-hash. User activation plus frame focus for mutations and for grant requests, with one grant dialog at a time. Source policy with managed deny. Our MCP lease. Audit. The 30-day TTL (§15, §16). |
| `automationScripts` | the script action | digest approval in the UI; an unapproved or changed run is refused and recorded. `runApprovedScript` runs the verified bytes. The env allowlist. Audit (§15). |

**Existing product policies keep applying; none is added.**
- **`isLocalAutomationManagedDisabled()`** (the codex-tier `in_app_local_automation` requirement) refuses the script action and scheduled refresh by name, with `describeManagedLocalAutomationRefusal()`. It does so through the three arms it already has:
  - the `enableScheduler` construction gate;
  - the `subscribeManagedLocalAutomationChange` → `enforceManagedLocalAutomationPolicy` enforcement;
  - a use-time check, in the D1.409 shape of `runMissedRunSweep`, which UA8.1 and UA8.2 apply at script and refresh dispatch.

  The construction gate alone cannot stop a system built before the codex tier is written.
- **The managed hook policy (`isManagedAllHooksDisabled`)** keeps governing the per-session runtime-hook projection (`capabilities/runtime-automations.ts`), which ORs it with `isLocalAutomationManagedDisabled()`. The host `AutomationSystem` in `SessionManager` does not read it, and nothing under `packages/shared/src/automations/` does. So a script action on a trigger the host system handles is gated only by `isLocalAutomationManagedDisabled()`. This is stated rather than assumed. For each trigger kind, UA8.1 pins which path runs the action and what `disableAllHooks` alone does to it.
- **The managed permission policy** normalises every Conductor child's mode (`normalizeSessionPermissionMode`), and managed deny beats any page-action grant (`source-policy.ts`).

**Residue, stated.**
- **No new administrator key.** An administrator has no new key that turns off a ported feature; the levers are the existing managed policies above (§17 S21). A new key would be a new operator contract, which is the reason `config/managed-local-automation.ts` gives for not adding a host tier. That is the owner's call.
- **The inherited local-automation residue.** The script action and scheduled refresh inherit it unchanged. In a process where no codex runtime ever starts, the codex tier is never read and the scheduler runs. This is recorded in the docblock beside `managedLocalAutomationUnsubscribe` in `SessionManager.ts`.

**Release consequence.** With nothing hidden, an incomplete phase must not reach a release. A phase ships only when it is user-complete and its live cases pass.
- The valid cuts are the end of Phase 1, the end of board Phases 2, 4 and 5, and each merged pages unit.
- The pages lane merges from its own branch in whole units. A unit not complete by the 1.42.0 cut moves to 1.43.0.
- So do board phases after the boundary the controller names (OQ-5; plan Sequencing and UA11.1).

## 7. Session model

- **New persisted fields** in `SESSION_PERSISTENT_FIELDS`, under upstream names: `projectId`, `parentSessionId`, `kanbanColumn`, `taskSlug`, `taskRunId`, `taskNodeId`, `taskNodeCount`, `taskDraft`.
  - `taskDraft` is sent as `false`, never `undefined`.
  - `parentSessionId` also names a different field on `PermissionRequest` (visible-ancestor routing, decoded by iOS). On `Session` it means the Conductor orchestrator. These are distinct objects; the docblock states it, and §22 lists it as a name collision.
- **Create path.** `SessionManager.createSession` persists through `this.sessionStore.create(...)`, which is `packages/shared/src/sessions/store-v2.ts`.
  - Its own `CreateSessionOptions` gains each field, and `create` copies each field by name. `sessions/storage.ts` `createSession` is not on this path.
  - DTO `CreateSessionOptions` gains `projectId`, `parentSessionId`, `taskSlug`, `taskRunId`, `taskNodeId`, `taskDraft` and `applyTaskLabel`.
- **Setters.** `setKanbanColumn`, `setTaskNodeCount` and `setSessionProjectId` copy the `setSessionStatus` path: `writeSessionMetadata` → `updateSessionMetadata`, then `sendEvent`, then `notifySessionPartitionFileChange`.
  - `updateSessionMetadata`'s closed `Pick` union and its `in` lines (`packages/shared/src/sessions/storage.ts`) gain `kanbanColumn`, `taskNodeCount`, `taskDraft`, `taskSlug` and `projectId`, as upstream's did.
- **Event.** `session_metadata_changed { sessionId, changes }`.
  - It joins `App.tsx` `handoffEventTypes`, or idle-session changes skip the atom path.
  - iOS decodes unknown events to `.unknown`, and `Session` uses synthesized `Decodable`, so no iOS change is needed; the row records the reading.

## 8. Statuses and closure

- The status model is unchanged. Defaults are `backlog`, `todo`, `needs-review`, `done` and `cancelled`; **there is no `in-progress` status**.
- **Closure guard (OQ-6).** Agent `set_session_status` refuses `category: 'closed'`. `ResolvedStatusResult` gains `category`.
  - Closing remains possible for the host, the UI, the Conductor, and the mini-agent auto-`done`.
- **The Conductor's close is a stated exception, kept from upstream.**
  - Upstream `TaskRunner.finish('completed')` (`v0.13.4:…/TaskRunner.ts`, `finish`) sets the orchestrator's column to `done` and its status to `done`. A node child's status is set to `done` when it finishes with text.
  - A run completes when every node has finished and, where the spec sets acceptance, the verifier's last `VERDICT:` line is PASS. So an agent's verdict can close the card of a run that a human started and, where needed, confirmed (§10).
  - Node children are Conductor-internal and never tiles (§9).
  - Setting `needs-review` on completion instead would be a product posture and is the owner's call (OQ-6). The default keeps upstream (§20).
- **The rule's text lives in the tool DESCRIPTION,** because that is the one text all three runtimes see: codex never calls `getSystemPrompt`.
  - The schema example `"in_progress"` (`tool-defs.ts` `SetSessionStatusSchema`) resolves to "Unknown status" today, and is replaced with real ids.
  - The self-closing workflow steps in `system.ts` (Session Self-Management) are rewritten to end at `needs-review`.
- **Tests** are scoped to those two strings only. `in_progress` is legitimate in the TodoWrite and TaskCreate schemas.

## 9. Board

A port of `v0.13.4:…/app-shell/kanban/*`. Behaviour is kept verbatim:
- **Cards:** top-level sessions, excluding archived, hidden, draft and child sessions.
- **Columns:** `kanbanColumn ?? statusToColumn(status)`. Built-in columns are `todo`, `in-progress` and `done`; `in-progress` is a column id only.
- **Drop status** per column. Newest-first bucketing.
- **Per-project editing** (UA5.10), only when exactly one project is selected: add, rename, recolour, drop status and remove. There is no reorder, and the last column cannot be removed.
- **Drag and drop:** `@dnd-kit/core` with `SmartPointerSensor`. This is already a dependency of ours.
- **Tile:** badge and status menu, pulse, subtasks, Play, and `NewTaskComposer`.
  - Upstream renders the edit (Pencil), add-subtask (Plus) and Play controls only when their callbacks are set.
  - The board phase leaves those callbacks, and the New Task → editor entry, unset until their targets land (plan UA2.4 → UA3.6, UA4.4). A board shipped alone has no control that leads nowhere.
- **Settings → Appearance:** column colours, pulse, status on move. These are per-viewer localStorage, as upstream; no stored-config key.

Adaptations:
- a `board` route and `SessionsNavigationState.viewMode`;
- a needs-input badge when `awaitingApprovalCount > 0` (the subject pair only names the request);
- a runtime chip from `llmConnection` → `providerType`;
- `ModelChip` falls back to the connection's provider icon for gateway ids;
- the project filter gets a "No project" bucket;
- the pulse keys on `isProcessing`;
- the drag overlay needs upstream's `index.css` `--shadow-dragging` hunk;
- **no keyboard drag.** Upstream has none, and Space/Enter collide with the tile's open action (OQ-14). The status menu is the keyboard path.

## 10. Tasks

- **What a task is.** `{workspaceRoot}/tasks/<slug>/task.yaml` plus one orchestrator session with a matching `taskSlug`. The workspace root is `CONFIG_DIR/workspaces/<id>`, which is disjoint from the Pi task-list root `CONFIG_DIR/tasks` (`retention-sweep.ts`).
- **Library** (port):
  - `js-yaml` replaces `yaml`; it is already a root dependency.
  - Modes go through `parsePermissionMode`.
  - Non-`session` kinds, `runner: 'orchestrate'` and `summarize: true` produce **warnings**, for beta compatibility.
  - Model checks use `getModelById` plus the gateway aliases.
  - Hostability is checked by the host at `tasks:validate`, because `shared` cannot import `server-core` (§11).
- **Slugs.**
  - Upstream `slugify` is ASCII-only, so every Cyrillic title becomes `untitled-task` (`v0.13.4:…/kanban/task-spec-form.ts` line 188).
  - Ours falls back to `task-<6 hex>` for non-Latin titles.
  - Create mode refuses a `spec.id` that already has a `task.yaml` or a live `taskSlug` session, with `task-slug-taken:<slug>`. The editor derives a fresh slug with `uniqueTaskSlug` against `tasks:list`.
- **Binding** (attach, adopt, fresh) is ported, with these locks:
  - A different `llmConnection` on a session that already has messages is refused with `task-attach-connection-locked`. Upstream writes the field directly, which would be a silent runtime switch.
  - The folder changes only through `projects:setSessionProject`.
  - Attach and adopt never RAISE a session's mode: the spec mode is clamped to the session's current mode.
  - Fresh create takes the orchestrator's mode from the editor request (a human choice) or, for agent creation, the invoking session's mode.
- **Folder ingress.** `spec.cwd`, the editor folder, `TaskGenerateRequest.cwd` and the agent tool's `workingDirectory` all resolve through `ProjectHandleService.validateProjectDirectory` plus trust. The renderer sends only a `projectHandleId`.
- **RPC.**
  - The module is new: `rpc/tasks.ts`. It handles `tasks:validate`, `create`, `generate`, `run`, `pause`, `resume`, `stop`, `get`, `list`, `getResults` and `delete`, plus the push `tasks:generated`. Each handler calls the lifted `assertCallerWorkspace`.
  - `tasks:getOutput`, which reads background-agent output, stays in `rpc/sessions.ts`, and a `channels.ts` docblock separates the two families.
- **`create_board_task`** (upstream name `create_task`, OQ-8):
  - It creates only; the task lands in `todo`. `safeMode: 'block'`. It reaches three runtimes.
  - It uses `uniqueTaskSlug`. Unknown sources and skills are returned as warnings, and the spec has a single `main` node.
  - The description contrasts it with "your in-session checklist or plan tool", naming no tool.
  - Restrictions on the invoking agent:
    - the folder must be the invoking session's own (`project-handle-required`);
    - `projectId` must be the invoking session's project, or a project whose folder `projectKey` equals the caller's;
    - `sources` must be a subset of the caller's enabled sources;
    - `llmConnection` must be the caller's, or unset;
    - no permission mode.
- **Run confirmation.** A run needs a confirmation whenever the `task.yaml` digest is **not the last digest a human saved or confirmed**, as recorded in the host ledger (§16). The confirmation lists each node's runtime/connection, sources and effective mode, and the node count. It covers agent-created specs, Generate drafts and on-disk edits alike. The HOST enforces it, not the renderer:
  - A `tasks:create` from the editor records the spec digest in the ledger. A save that adopts a Generate draft records nothing, because an agent wrote its nodes. `create_board_task` never records one.
  - `tasks:get` returns `needsRunConfirmation`.
  - `tasks:run` refuses with `run-confirmation-required` unless the current digest is the ledger's last confirmed one, or the request's `confirmedDigest` equals it. In that second case the host records the digest.
- **Lifecycle.**
  - Deleting an orchestrator deletes `tasks/<slug>/` **only if no other non-archived session carries that slug**, and the dialog names the folder.
  - Archiving keeps the folder (OQ-13).
  - An agent cannot archive a session mid-turn; the upstream processing arm is ported.

## 11. Planning

**Completion seam — an upstream port, not new code.**
- **Code ported:**
  - `SessionCompletionEvent`, `onSessionComplete`, `emitSessionComplete` and `getSessionFinalText` (`v0.13.4:…/SessionManager.ts`, lines 1095–1106, 5144–5151, 6602–6625 and 6785–6795);
  - the interface declaration and the `sessions/index.ts` export.
- **Where it emits.** **Only** in `onProcessingStopped`'s final idle `else` arm, beside `fireSessionIdleNotices(managed,'idle')`.
  - It never emits on the `queuePaused` arm. A paused non-empty queue means the user is intervening, so it is not completion.
  - It never emits on the `pendingTaskNotifications` arm, which starts a turn.
- **Hang fix.** The done-arm `clearVisualsForSession` await is wrapped in try/catch. This is upstream's own hang fix; ours is still unguarded.
- **Final text** is `getLastFinalAssistantMessageId`, **only when** `didReceiveNewFinalMessage` against `turnStartFinalMessageId`. Otherwise it is undefined, so thinking rows (`isIntermediate`) and a previous turn's text never pass as output.
- **Error reporting.** The event carries `terminalIsError` and `terminalReason`. A `complete` with `terminalIsError` fails the node. `piChildTranscriptOutcome` is untouched.

**Conductor.** Port `TaskRunner.ts` (926 lines) and its 31 cases. Adaptations:
1. **Children.**
   - They are visible, with `parentSessionId`, the item label, the orchestrator's `projectHandleId` and the orchestrator's `projectId` (never `spec.project`, never `spec.cwd` at dispatch).
   - They are created with `SessionManager.createSession` directly. The child-session port would pin the parent's connection.
   - Each node's runtime comes from its `llmConnection`.
2. **Posture (OQ-7).** A child's mode is `normalizeSessionPermissionMode(child, clampPermissionModeToParent(requested, normalizeSessionPermissionMode(orch, orch.permissionMode)))`.
   - `clampChildPermissionModeToParent` treats Conductor `parentSessionId` as a ceiling key beside `piParentSessionKey`. The ceiling therefore holds for the node's lifetime: lowering the orchestrator lowers the nodes.
   - `AUTONOMOUS_DEFAULT_MODE = 'allow-all'` is removed.
   - A node blocked on a card shows needs-input.
3. **Hostability.**
   - The node predicate IS `SCHEDULED_DELIVERY_RUNTIMES` (pi, anthropic, codex-runtime; the same exclusion of nestor-cloud).
   - `tasks:validate` and `tasks:run` call `canHostSession` for every distinct node connection before the FIRST dispatch. A refusal names the node, the connection and the reason.
   - An unresolvable connection refuses; it never silently falls back.
4. **Settlement gate.** A node counts as done at the idle door only when all of these hold:
   - `computeSessionSettlementV1` reports settled;
   - the session has no active goal;
   - no monitor, cron or `task_backgrounded` record is live.

   Otherwise completion is deferred to the next idle door. A turn that starts in a node already marked done is logged as `node-woke-after-done` and shown on its tile. UA4.8 measures which producers the settlement does not count; that gap is an HONEST residue.
5. **Verdict listener.** It accepts only a completion whose turn began after the verify message was recorded.
6. **Status and interrupt.**
   - The running *status* is written only if the workspace defines `in-progress`; the column always moves.
   - An interrupted child **pauses** the run, and Resume re-dispatches it. This is upstream's stated intent; upstream's code fails the run.
   - On completion the orchestrator is closed as upstream closes it (§8).
7. **Resume.** `rehydrate` loads `readRunSpecSnapshot` and the params recorded in `run-started`; `params` is added to that entry. Upstream reloads the live `task.yaml` with default params.
   - `tasks:getResults` reports a non-terminal log with no live runner as **interrupted (app restarted)** and offers Resume. Nothing is written at startup.
   - At every run and resume, `spec.cwd` is re-validated through the handle service.
8. **Runtime-switch safety.**
   - Nodes cannot switch runtime while running (`SESSION_BUSY`), or to a remote connection.
   - An orchestrator switched between rounds keeps verifying on its new runtime.
   - A repair re-dispatch uses the spec's connection.
10. **Plugins (owner 2026-09-24).** A node is an ordinary session: its plugins, their MCP servers, skills, agents and hooks come from the host capability snapshot exactly as in any session of the orchestrator's project on that runtime. Enablement is the workspace's plus the orchestrator's project's; the orchestrator's session-scoped plugins do not pass to nodes; the spec and `create_board_task` cannot enable a plugin; the run confirmation lists each node's active plugins beside its sources. Whether node `sources` also narrows plugin MCP servers is measured at dispatch (expected: no) and stated in the editor either way (plan UA4.1).
9. **Codex `tokenUsage`.** Codex's adapter reads `usage?.total ?? usage?.last`, and it is UNVERIFIED that this is cumulative per session. UA4.1 adds a per-runtime `tokenUsage` fixture for `token_budget`.

**Verdict and repair.** Ported verbatim (§2). UA4.7 pins the parsing against one final-text fixture per runtime.

**Generate.**
- The draft is `taskDraft: true` (upstream), **not `hidden`**. A hidden session's card has no window (`permissionSurfaceRouting`), and adopting a hidden draft would hide the task for good.
- It authors in `dontAsk`, index 0 of `PERMISSION_MODE_ORDER`, where on codex "what no rule pre-approves is denied rather than shown". On Pi and Claude, `dontAsk` still lets rule-pre-approved tools run. So UA4.5 asserts on all three runtimes that a write no rule pre-approves is denied without a card and leaves the folder unchanged. On adoption the draft takes the editor's mode.
- Generate sends use queue mode.
- The client fallback is `MAX_GENERATE_ATTEMPTS × GENERATE_TIMEOUT_MS + 20 s` = 380 s, from one shared constant. Upstream uses 200 s against a 360 s worst case.

**Plan mode.**
- Port `pending-plan-dispatch.ts` and its test. Also port the storage claim: `markPendingPlanExecutionDispatched` returns `Promise<boolean>` and refuses when `awaitingCompaction` or `executionDispatched` is set.
- Also port:
  - the `SessionManager` refusal when the session is missing or processing;
  - the `sessionCommand` `Promise<boolean>` overload;
  - the `pending-plan-execution.test.ts` hunk and the two claim cases of `midstream-queue.test.ts`.
- The in-memory flag is set **synchronously before** persistence is awaited. Ephemeral sessions return `false`.

## 12. Projects (recommended (a′), OQ-1)

- **Entity (port).** `ProjectConfig` with id `proj_<8hex>`, `slug`, `name`, `description`, `details`, `color`, `colorTheme`, `kanbanColumns`, and timestamps. It is stored in `{workspaceRoot}/projects/<slug>/config.json` plus `assets/`.
- **Folder (adapt).**
  - `workingDirectory` becomes `folder?: { workingDirectory; projectKey? }`, the `WorkspaceDefaultProject` shape. It is written only from a resolved handle.
  - Its rule is kept verbatim: a STABLE `projectKey` is persisted, and a process-only key never is ("Stable identities only. Process-only keys must not be persisted.").
  - The DTO exposes `{ handleId, displayPath, trusted }`.
  - `kanbanColumns` is validated with zod on the server.
- **Binding.**
  - `createSession({ projectId })` takes the explicit project, else the parent's.
  - The host re-validates the folder and compares the persisted `projectKey`: `project-folder-identity-changed` on a mismatch. Trust is applied through the `defaults.defaultProject` path.
  - `config.json` is agent-writable, so a `folder.workingDirectory` rewritten on disk to another folder is caught by that comparison, not only by trust.
  - An explicit missing project throws; an inherited missing one is dropped. Children keep `projectId`.
  - `spawn_session` gains upstream's `projectId`, plus the `base-agent.ts` pass-through. It is allowed only for a folderless project or one whose `projectKey` equals the caller's.
- **Rebind.** `setSessionProjectId` never moves the folder. The folder moves only through `projects:setSessionProject`, which refuses while processing.
- **Context.**
  - Upstream's `formatProjectContextForPrompt` and `prompt-sanitize.ts` (59 lines, copied verbatim) produce the body. They defang closing tags and strip control characters.
  - On every entity write, the host writes a mirror to `{workspaceRoot}/projects/<slug>/context.md` and records its sha256 in the host ledger (§16).
  - `capabilities/resolver.ts` emits one `{ kind: 'instruction' }` binding for the session's project, **only when the file's bytes match the recorded digest**. On a mismatch it re-renders from `config.json` through `formatProjectContextForPrompt`, never from the file's raw bytes, and logs `project-context-tampered`.
  - `views.ts` `toAgentRuntime` surfaces the binding in `promptLayers`. The layer is therefore file-backed, so `InstructionsLoaded` reports a real path, and it reaches all three runtimes through the pinned block in `BaseAgent.chat`. An agent that writes `context.md` directly, which codex can, never gets unsanitised bytes into a prompt.
  - Whether an edit reaches the next turn or only a new session is measured (UA5.5). If context is pinned per session, port upstream's drift notice ("System prompt context changed since this session started…").
- **Assets** are ported behind a measurement of agent read reach (UA5.6).
- **Memory.** Foldered projects: dropped under (c). Folderless projects: UA5.12 measures, then either ports upstream's project `MEMORY.md` into the context layer or records a KNOWN residue.
- **RPC.**
  - Upstream keys merge into our `projects` block, and every handler calls `assertCallerWorkspace`.
  - Channel strings are disjoint from ours. Ours: `PICK_LOCAL_DIRECTORY`, `VALIDATE_DIRECTORY`, `LIST_RECENT`, `ISSUE_RECENT_HANDLE`, `SET_TRUST`, `SET_SESSION_PROJECT`, `SET_WORKSPACE_DEFAULT`. Upstream: `GET`, `GET_ONE`, `CREATE`, `UPDATE`, `DELETE`, `LIST_ASSETS`, `UPLOAD_ASSET`, `DELETE_ASSET`, `CHANGED`. Verified 2026-09-23.
- **Delete.** It unbinds sessions, then pages, then removes the entity directory. The user's folder is never touched. Who wires the pages half depends on which lane lands first:
  - UA5.3 wires it if the Pages 6+7 unit is already on the release branch.
  - UA6.2 wires it if Phase 5 is already on the pages branch.
  - If neither row found the other half, UA11.1's cross-lane audit catches the gap, and it becomes a row before the cut.
- **Naming.** "Project" means the entity. Existing strings that mean a folder are reworded to "folder" in en and ru.

## 13. Pages core

- **Storage (port).** `{workspaceRoot}/pages/<slug>/` holds:
  - `page.json`, written last;
  - `index.html`;
  - `thumbnail.jpg`;
  - `data/store.sqlite` (`bun:sqlite`, private);
  - `data/snapshot.json`.
- **Kinds:** `static`, `interactive`, `live`. Store caps: 1000 keys, 100 series, 1000 points per series. Writes happen in a one-shot Bun process via `resolveScriptRuntime`.
- **Exports.** Export `resolveScriptRuntime`, `isPathWithinDirectory`, `isPathWithinDirectoryForCreation` and the three runtime types from the `@nessy-agent/session-tools-core` root. Upstream `script-executor.ts` imports them from there, and ours exports none. `data-store.ts` is a Bun-only subpath. Our `resolve-script-runtime.ts` is KEPT: `isPackagedEnvValue` already accepts `'true'`.
- **Delete.** `deletePageLocal` (ported from `deletePageWithUnpublish`) is the single implementation behind `pages:delete` and `delete_page`.
- **Tools.**
  - `list_pages` and `get_page` are `safeMode:'allow'`. `create_page`, `update_page`, `write_page_data` and `delete_page` are `'block'`.
  - **`delete_page` raises a one-shot, non-rememberable host card in every mode**, bypass included. With no attended UI, it resolves as deny and the tool returns the reason.
  - Tool summaries carry no share fields until publishing lands (§3, UA6.7).
  - Upstream's `refresh` parameter on `create_page` and `update_page` takes a workspace-relative script path, which reason (b) drops. It is withheld until the content-based schema lands (UA6.3 → UA8.2). Until then a `refresh` in `page.json` schedules nothing.
- **Guide and prompt.**
  - `apps/electron/resources/docs/pages.md` is rewritten, with `DOC_REFS.pages`. It covers refresh and actions only once those units land.
  - The prompt section is delivered on all three slots only when the tools are offered.
  - `codexDeveloperInstructions` gains a `sections` argument at its three call sites.
- **Watcher.** A `pages/` branch that fires only on `page.json` and slug-directory add/remove.

## 14. Pages UI and frame isolation

**Finding.**
- A `srcdoc` document inherits the embedder's CSP.
- Ours (`apps/electron/src/renderer/index.html`) allows `connect-src 'self' https: wss:` plus `http`/`ws`/`wss` on `localhost:*` and `127.0.0.1:*`, and `img-src … https: file:`.
- So page script could exfiltrate by `fetch`, `WebSocket` or `<img>`.
- It could also reach host loopback services: the codex-responses adapter binds 127.0.0.1 and attaches the Nestor JWT upstream. Whether a page could drive it is UNVERIFIED.
- A `file:` image would work as an existence oracle.

**The fix, piece by piece:**
- **Builder.** `apps/electron/src/shared/page-frame-csp.ts` `buildPageSrcdoc(content, kind)` emits `<!doctype html>`, then the CSP `<meta>`, then the page bytes. The doctype comes first so the page is not in quirks mode; UA7.6's sitting case reads `compatMode`.
  - The policy is `default-src 'none'; script-src 'unsafe-inline'` (`'none'` for `static`), then `style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'`. It contains no localhost token.
  - Lease bytes stay equal to the page, so the digest is unchanged. An agent `<meta>` can only add restrictions.
  - A guard test fails if either render site sets `srcdoc` without the builder.
- **Frame.** `sandbox=""` for `static`, `allow-scripts allow-forms` otherwise, and never `allow-same-origin`.
- **Messages** are accepted only if `event.source === iframeRef.current?.contentWindow` **and** `event.origin === 'null'`, then parsed strictly.
- **Navigation.** A main-process `will-frame-navigate` guard denies subframe navigation. Today only `will-navigate` is guarded.
- **`open-url`** is http(s) only. It needs user activation **and** `document.activeElement === iframeRef.current`, plus a host confirmation that shows the full URL (OQ-12).
- **WebRTC.** The first script removes the constructors, as defence in depth. DNS-prefetch and preconnect leak behaviour are UNVERIFIED on Electron 39. UA7.6's sitting case measures both, and **any leak holds the 6+7 unit out of the release until its fix lands and the case re-passes**.
- **Thumbnailer:**
  - an offscreen window: `sandbox: true`, `contextIsolation`, no preload;
  - `setWindowOpenHandler(() => ({ action: 'deny' }))`, plus `will-navigate` and `will-frame-navigate` denied on the thumbnail window. Upstream has neither handler;
  - upstream's capture timeout is kept; on timeout the window is destroyed;
  - an in-memory partition that cancels everything except `data:`, `blob:` and `about:`;
  - the host document's CSP allows only its own script, by `sha256` hash;
  - the snapshot is serialised with every `<` replaced by its JSON unicode escape, so neither `</script>` nor `<!--` survives into the host document;
  - the srcdoc comes from the builder.
- **UI (port).** `PagesHome`, `PageView`, `PageTile`, `DeletePageDialog`, `page-visuals`, a sidebar entry, and a playground (ours). `PagesHome`, `PageView` and `PageFrame` are staged copies whose withheld ranges land with their owners:
  - the project filter and move-to-project go to whichever of UA5.9 and UA7.3 lands second;
  - refresh status and approval go to UA8.3;
  - grants, the action handler and source auth go to UA9.3;
  - the share entry goes to UA6.7.

## 15. Script action, scheduled refresh, page actions

**Script action (OQ-4, decided: a general automation action, available, digest-approved).** Port `ScriptAction`, `script-executor.ts` and `script-handler.ts`:
- argv spawn;
- symlink-aware containment;
- default timeout 60 s, clamped 1 s–15 min;
- SIGTERM, then SIGKILL after 5 s;
- output capped;
- a per-matcher lock.

Our adaptations:
1. **One entry point, and the verified bytes are the bytes that run.**
   - `runApprovedScript` is the ONLY exported entry. `ScriptHandler`, the `rpc/automations.ts` Test handler and `script-executor-bridge.ts` all call it, and a guard test finds no other importer of the raw executor.
   - It reads the script bytes once, verifies their sha256 against the ledger, and writes those exact bytes to a private temporary file in a 0700 directory. It spawns the interpreter on that copy, with upstream's working directory. A swap of the original between the check and the spawn therefore cannot run.
   - Stated residue: the digest pins the entry file only. An approved script is a single self-contained file: one that imports sibling files cannot resolve them from the private copy, and the guide says so.
2. **Environment by allowlist.** Upstream's `SCRIPT_ENV_PLATFORM_ESSENTIALS` (no PATH), plus the named keys the upstream builder writes explicitly, rebranded (`NESSY_SESSION_ID`, `NESSY_WORKSPACE_ID`, `NESSY_WORKSPACE_PATH`, `NESSY_PAGE_SLUG`/`_DIR`/`_DATA_DIR`, and so on). There is **no prefix loop** over `process.env`.
3. **Approval.**
   - An approval is bound to `{ path, sha256(bytes), args, runtime }` in the host ledger and given in the UI: the automation row (`automations:approveScript`) or `PageView` (`pages:approveRefresh`).
   - These channels are ours. Upstream has no approval or run-now channel (verified against upstream `channels.ts`).
   - An unapproved or changed-digest run is refused, and the reason is recorded in history. An unattended trigger cannot show a card.
4. **Audit.** An injected `audit(event, payload)` port, which `SessionManager` wires to `PrivilegedExecutionBroker.auditEvent` (`logs/privileged-actions.jsonl`). `shared` cannot import `server-core`.
5. **Managed gate (an existing policy, §6).** `isLocalAutomationManagedDisabled()` is checked at dispatch; `describeManagedLocalAutomationRefusal()` supplies the text. §6 states what `disableAllHooks` does and does not reach.
6. **Network.** Allowed (upstream parity; the sandbox is off by standing decision). This residue is stated in the guide.

A user-authored `type:'script'` is valid in any automation. Approval (3) is what stands between authoring it and running it.

**Scheduled refresh.**
- Port `pages/refresh.ts`: synthetic `page:<slug>` `SchedulerTick` matchers.
- The agent-facing `PageRefreshSpecInputSchema` is REWRITTEN. The agent supplies script **content**, and the host writes `pages/<slug>/refresh.<ext>` and stores that path. Reason (b): no agent-authored path into scheduled execution.
- A refresh stays inert until a human approves its digest in `PageView`. `pages:runRefreshNow` runs an approved refresh through `runApprovedScript`.
- The existing managed-local-automation policy applies through all three of its arms (§6), with a use-time check at refresh dispatch.

**Page actions.** Port `action-bridge.ts`: leases with a nonce, a replay cache, rate limits, 30-day grants (OQ-11). Our adaptations:
- **Grants.** Kept in the host ledger and **never read from `page.json`**, whose `grants` field is stripped on read. They are read from the ledger on every invocation, so a revoked grant is refused at the next call.
- **Script grants** carry `scriptSha256`, `args` and `runtime`. The bridge runs through `runApprovedScript` and refuses a changed script with `grant-script-changed`.
- **Mutating invocations** need user activation plus frame focus.
- **Grant requests.** Upstream's `grant-request` carries a page-supplied `description` and action, and needs no activation.
  - Ours need user activation plus frame focus.
  - One dialog is shown at a time per page, and further requests are rate-limited.
  - The dialog shows the host-validated descriptor (source; tool, or method and path; script path and `scriptSha256`) as the authority. It labels the page's `description` as page-supplied.
- **Policy.** `source-policy.ts` is extracted from our pre-tool-use with no behaviour change; managed deny beats any grant.
- **MCP** goes through `WorkspaceMcpPoolRegistry.lease({ workspaceId }, { leaserId: 'page:<slug>' })`, honouring the isolation lever. The shared posture is the default (`per-leaser` was measured broken, DA3.8).
- **API** goes through `getSourceServerBuilder` and `executeApiRequest`.
- **Audit** goes to `logs/page-actions.jsonl`, redacted, and rotated as `privileged-actions.jsonl` is.
- **`PageSourceAuthBanner`.** OAuth goes to our Sources reconnect; the agent hand-off is kept; there is no credential input.
- **Grant dialog** is styled as our cards (OQ-10).
- **Staging, not gating.** A surface whose owner has not landed does not exist yet; nothing hides it behind a flag. The staged ranges are:
  - the bridge's grant and action message kinds, rejected as unknown kinds until UA9.3 (plan UA7.2);
  - the page tools' `refresh` parameter (plan UA6.3);
  - the `PageView` and `PageFrame` ranges (§14).

## 16. Host-record integrity (new)

**The problem.** The design depends on agents not forging files in workspace storage:
- the sandbox is off by default;
- the codex path runs no `runPreToolUseChecks`;
- `GUARDED_WORKSPACE_RECORDS` (`agent/core/pre-tool-use.ts`) is an exact-path Map with only three entries.

**The fixes:**
1. **One host ledger,** `{workspaceRoot}/host-approvals.json`. It holds page grants, script-digest approvals, refresh approvals, "last human-confirmed" `task.yaml` digests, and project-context digests (§12).
   - Every entry carries `mac = HMAC-SHA256(key, canonical(entry))`. The key is per install, held in our credential store as a new credential type.
   - The broker, the scheduler, the Conductor, the run confirmation and the context resolver accept only entries whose MAC verifies.
2. **Guard patterns.** `GUARDED_WORKSPACE_RECORDS` gains pattern entries, each with its guidance message (D1.438 shape), for:
   - `tasks/*/task.yaml`;
   - `pages/*/page.json`;
   - `projects/*/config.json`;
   - `projects/*/context.md`;
   - `host-approvals.json`.
3. **Measurement (UA1.10).** On Pi, Claude and Codex in a default install, UA1.10 measures:
   - agent write reach to those five;
   - agent read reach to `credentials.enc`, through the Read tool and through the shell, in each mode below `bypassPermissions`.

   The negative control is `automations.json`, which must be refused.

**Residue.**
- **Who can recover the key.** Any process that can read `credentials.enc` can recover it. The file is encrypted with a key derived from a machine id (`secure-storage.ts`, `pbkdf2Sync` over `stableMachineId`). Reads of `credentials.enc` are withheld from agents only at the tool layer: codex `deniedReadPaths`, and Pi's and Claude's denied paths.
- **What the ledger protects against.** An agent that can write files but cannot run unapproved shell: Write/Edit-only modes and bridged writes.
- **What it does not protect against.** An agent that already runs shell unprompted. Such an agent can schedule code by other means anyway.
- **If a mode below bypass can read and decrypt the key** (UA1.10), the finding is a row that blocks the Phase 8 and Phase 9 unit merges until it lands (plan UA11.1).

## 17. Security posture

| # | Threat | Upstream | Ours | Proof |
| --- | --- | --- | --- | --- |
| S1 | Page exfiltration via the inherited CSP (https, wss, loopback, file) | vulnerable | injected doctype-first CSP | `page-frame-csp.test.ts`, UA7.6 |
| S2 | Frame self-navigation | unguarded | `will-frame-navigate` | guard test, UA7.6 |
| S3 | WebRTC, DNS prefetch | n/a | constructor removal; measure; a leak holds the unit | UA7.6 |
| S4 | Thumbnail host network access, script injection, window-open or navigation | no CSP; no window-open or navigation handler | CSP hash, escaping, partition, window-open and navigation denied, timeout | UA7.4 |
| S5 | `open-url` exfiltration | opens directly | activation + focus + confirmation | PageFrame test, UA7.6 |
| S6 | Conductor children escalate | `allow-all` | lifetime ceiling + managed normalisation | UA4.2, UA4.12 |
| S7 | Raw paths | yes | handle + trust + persisted stable `projectKey` | UA3.4, UA4.1, UA5.4 |
| S8 | RPC trusts `workspaceId` | yes | `assertCallerWorkspace` | per-namespace negatives |
| S9 | Unattended code | yes | ledger approval, one entry point, audit, managed gate | UA8.1, UA8.5 |
| S10 | A second permission system | separate pool | our lease, policy, credentials, audit | UA9.2 |
| S11 | Irreversible `delete_page` | prompt rule | card in every mode; unattended deny | UA6.2 |
| S12 | Claude cloud publish | n/a | measure, then disallow | UA1.5 |
| S13 | Agent closes cards | refused | refused; the Conductor's close of a completed run is the stated exception (§8) | UA1.2, UA1.12 |
| S14 | Codex `explore` and bridged mutators | n/a | measure, then rule | UA1.8 |
| S15 | `bun:sqlite` in Node bundles | subpath | subpath + guard | UA6.1 |
| S16 | Secret env to scripts | `CRAFT_*` prefix | allowlist | UA8.1, UA8.5 |
| S17 | Forged grants or approvals | trusted from `page.json` | MACed ledger + guards; key-recovery residue stated (§16) | UA1.10, UA9.2 |
| S18 | Script swapped after grant or approval, or between check and spawn | page digest only | `scriptSha256` re-hash; the verified bytes run from a private copy | UA8.1, UA9.2 |
| S19 | Agent task escalates via project, sources or connection | open | restrictions + host-enforced run confirmation | UA3.5, UA3.9, UA4.4 |
| S20 | Cross-frame bridge spoof | `source` check | `source` + origin | UA7.3 |
| S21 | An administrator cannot turn off a ported feature | n/a | no new managed key (owner 2026-09-23); the existing managed policies govern what they already govern | stated residue (§6) |
| S22 | Craft OAuth redirect in docs | present | dropped | UA6.6 |
| S23 | Page bytes sent to Craft's share service | anonymous POST to thecraftagents.com | the service client dropped; a guard forbids Craft hosts and share-service knobs; publishing waits for the owner's resource | UA6.6, UA6.7 |
| S24 | Forged project context reaches every session's prompt | n/a (rendered from config) | digest-verified render; re-render through the sanitiser on mismatch; guard patterns | UA1.10, UA5.5 |
| S25 | Grant dialogs spammed or worded by the page | no activation, no bound | activation + focus, one at a time, rate limit, host descriptor as authority | UA9.3 |

## 18. i18n, playground, docs, ledger

- **i18n: counts.** Upstream en.json has 314 keys new since the seed. Families:

  | Family | Keys |
  | --- | --- |
  | `kanban.*` | 27 |
  | `settings.appearance.kanban*` | 9 |
  | `tasks.*` | 74 |
  | `projectInfo.*` | 34 |
  | `projectsList.*` | 13 |
  | other project keys | 13 |
  | `pages.*` | 82: 25 core, 17 grants, 9 auth, 31 share (DEFERRED) |
  | `toast.page*` | 17: 6 core, 4 grant/source, 7 share (DEFERRED) |
- **i18n: other keys.** Also `sidebar.pages`, `sidebar.allPages`, `chat.workInFolder`, `status.change`, and `common.*` keys absent from ours. Ours has 0 keys under `kanban.`, `tasks.`, `pages.`, `projectInfo.` and `projectsList.`.
- **i18n: landing rule.** **Each row that introduces a reader lands exactly the keys that reader uses, in en and ru, as its first commit, and the reader as its second.** Locale-only rows do not exist, because `lint:i18n:reachable` fails on a key with no reader. Upstream's `scripts/check-i18n-coverage.ts` is ported as a forward gate: every literal `t()` key must resolve.
- **Playground.**
  - Copied: `kanban.tsx` + mock data (category `Kanban`), `task-editor.tsx`, and `project-colors.tsx` (upstream category `Session List`, kept).
  - New: Pages (category `Pages`).
  - Each new category gets a registry test asserting its `categoryOrder` line. Dark sweep.
- **Docs.**
  - `board.md` and `pages.md` (rewritten); `statuses.md` and `automations.md` updated. `pages.md` gains refresh and source actions only with their units.
  - docs-site en and ru. Every feature is described as available, with no "experimental" or "switch" wording, and Pages as not yet publishable.
  - architecture records `task-board-and-planning.md` and `pages.md`.
- **Ledger.** `docs/superpowers/specs/2026-08-28-capability-ledger.md` gets rows per surface, and only for surfaces that ship. Absences are declared counts; controls are prose with dates.

## 19. Upstream defects not copied

1. `in-progress` status writes.
2. Self-closing prompt text that contradicts the refusal.
3. `allow-all` children.
4. RPC with no caller check.
5. Thumbnail host with no CSP and a `</script>`-only escape.
6. Silent `summarize` and kinds.
7. Interrupted child fails the run.
8. Controls with no UI; no restart state.
9. Task folders never deleted.
10. Pulse keyed to a column id.
11. Resume from the live `task.yaml` and default params.
12. Generate client timeout shorter than the server worst case.
13. ASCII-only slugs overwriting tasks in create mode.
14. Attach/adopt writing connection, mode and cwd directly.
15. Script env prefix pass-through.
16. Grants trusted from `page.json`.
17. Script grants not pinned to script bytes.
18. User activation not tied to the frame.
19. Automation Test running scripts outside the handler.
20. A thumbnail window with no window-open or navigation handler.
21. Grant requests with no activation and no bound, showing page-written text as the request.
22. Scripts spawned from their path after the check, leaving a swap window.

## 20. Contradictions and how they were resolved

| Topic | Resolution | Why |
| --- | --- | --- |
| Row family | `UA` | covers all five features; measured free |
| Manifest location | plan | addendum |
| `sendMessage` "serialisation trap" | refuted; the adapter returns on `onAck`, so failure is reported once | upstream awaits too, and dispatch is fire-and-forget |
| Completion source | `getLastFinalAssistantMessageId`, turn-scoped; idle arm only | `piChildTranscriptOutcome` reads intermediate rows |
| Node done | settlement gate + `node-woke-after-done` | the host starts unattended turns after idle |
| Feature gating | none: no switch, env toggle, managed key, RPC or refusal; every ported feature available | owner 2026-09-23, reversing decision 3; each surface's own controls carry its safety (§6) |
| Release shape | a phase ships only when user-complete; the pages lane merges from its own branch in whole units; board phases after the named boundary wait | nothing is hidden, so an incomplete phase must not reach a release |
| Sharing | Craft's service dropped (a) and guarded; the publishing feature DEFERRED to the owner's internal resource (UA6.7) | owner 2026-09-23 (§1 row 6): the feature is wanted, Craft's service is not |
| Project context | file-backed `context.md` from the sanitising formatter, used only on a digest match | a prompt layer must be a resource; injection defence; an agent can write the file |
| Orchestrator close on a completed run | **kept from upstream and stated (§8)**; `needs-review` instead is the owner's call (OQ-6). A safety critic asked for the change; this spec declines it. | the closure guard is on the agent's own tool, and upstream already separates the Conductor's close from it. The run is human-started, and a spec no human saved needs the host-enforced confirmation. Changing it is a product posture. |
| Script bytes | verified bytes run from a private copy; single-file residue stated | a re-hash alone leaves a swap window on unattended runs |
| Staged copies | withheld ranges recorded in headers and removed by their owning rows | a board or pages cut must not show an entry that leads nowhere |
| Pages-lane sha pins | pinned only after the unit's merge | a sha never merged would fail `lint:plan-shas` on CI |
| `planner.css` | port the `index.css` token, then copy `planner.css` verbatim | `KanbanBoard.tsx` needs `.shadow-dragging` |
| Generate draft | `taskDraft` only, `dontAsk`, queued | hidden cards hang; codex refuses silently in `dontAsk` |
| Node predicate | `SCHEDULED_DELIVERY_RUNTIMES` + `canHostSession` | no duplicate record; catches build and credential gaps |
| i18n rows | keys ride their reader row | `lint:i18n:reachable` |
| CDP cases | RS sitting cases; ids allocated by the controller on the release branch | the harness checks `meta.row` only for `rs-*.ts`; two branches cannot see each other's ids |
| `spawn_session` `projectId` | ported with the folder rule | (c) did not cover folderless projects |
| `archive-guards` | scoping dropped (c), processing arm ported | ours lacks the mid-turn check |
| `WorkingDirectorySelector` | not ported (c); ours reused | owner 2026-09-23: «используем наш с мелкими правками». Our `CompactWorkingDirectorySelector` already returns an `IssuedProjectHandle`; the TaskEditor renders it, and the main composer is untouched |
| `resolve-script-runtime.ts` | KEEP | ours already accepts `'true'` |
| Keyboard drag | residue | Space/Enter collision |
| Run history retention | kept with the task; deleted by the cascade | an age would be an invented product posture |

## 21. Owner decisions and open questions (defaults taken unless the owner says otherwise; owner rule 2026-09-05)

| # | Question | Recommended default, or the decision |
| --- | --- | --- |
| **OQ-1** ⏸ | Projects: (a) verbatim, (a′) entity + our handle + `projectId`, (b) folder-keyed columns, (c) workspace board + path filter | (a′) |
| OQ-2 | How much planning executes | upstream v1 parity: `session` kind executes, other kinds warn, runs are user-started, agents only create |
| OQ-3 ✅ | Switch mechanism and defaults | **DECIDED 2026-09-23: no switches.** Owner: «нет, закрывать ничего не нужно, делаем сразу как доступные фичи». Every ported feature ships available (§6). |
| OQ-4 ✅ | Script action | **DECIDED 2026-09-23:** a general automation action, available, run only after its digest is approved in the ledger; scheduled refresh available, inert until its digest is approved in `PageView` |
| OQ-5 | Release | 1.42.0 on `feat/TCODE-000-1-42-0` after the 1.41.0 close-out. A phase ships only when user-complete with its live cases passing. **Valid cuts:** the end of Phase 1 and of board Phases 2, 4 and 5. Phase 3 alone is not user-complete. **Board lane:** the controller names the board cut before dispatching the next board phase, and later board phases move to 1.43.0. **Pages lane:** on `feat/TCODE-000-1-42-0-pages`, merged in whole units (Phases 6+7, then 8, then 9). A unit not merged by the cut moves to 1.43.0 instead of shipping hidden. |
| OQ-6 | Human owns closure | adopt. The Conductor's close of a completed, human-started run is kept from upstream (§8); `needs-review` on completion instead is the owner's call. |
| OQ-7 | Child mode | lifetime ceiling at the orchestrator |
| OQ-8 | Agent tool name | `create_board_task` |
| OQ-9 | Project memory | foldered: drop (c); folderless: UA5.12 |
| OQ-10 | Grant UX | renderer dialog + broker audit; requests bound to activation (§15) |
| OQ-11 | Grant TTL | 30 days, stated |
| OQ-12 | `open-url` | confirm with the full URL |
| OQ-13 | Orchestrator delete | delete the folder if no other session shares the slug |
| OQ-14 | Keyboard drag | residue |
| OQ-15 | Claude cloud tools | disallow those measured present |
| OQ-16 | Attach with a different connection | refuse (`task-attach-connection-locked`) rather than route through a runtime switch |
| OQ-17 | Run confirmation | whenever the spec digest is not the last one a human saved or confirmed; enforced by the host |
| **OQ-18** ✅ | Pages publishing target | **DECIDED 2026-09-23:** t-artifacts (`https://t-artifacts.t-tech.team`) through the host publisher (plan UA1.16–UA1.18, UA6.7); the `artifact-publish` skill is not shipped (§24). |
| OQ-19 | Sidebar placement of "Projects" and "Pages" | after Sources (ours already holds Plugins, Hooks and Skills there) and before Automations, Projects first, Pages second — upstream's relative position; our Plugins/Hooks/Skills entries, the top-level Plugins entry, "New Chat in Worktree" and the Automations "Add" type picker are kept (plan UA5.8, UA7.3) |
| OQ-20 ✅ | Three small upstream carries found 2026-09-23 outside this plan's feature set | **DECIDED 2026-09-23 by the owner, all three YES → plan UA1.13 (Up-arrow, with the double-Esc condition), UA1.14 (local-to-local Send to Workspace), UA1.15 (chip as an Appearance preference, default off).** The recommendations as asked: (1) Up-arrow in an empty composer during a turn stops it and restores the last prompt (v0.11.2) — recommended YES, only while processing and only when no double-Esc draft is waiting (P2.447); it touches the composer, so it is the owner's call. (2) "Send to Workspace" between two LOCAL workspaces (v0.11.2, `transfer-targets.ts`) — recommended YES, size S if our server already imports locally, else M (UNVERIFIED). (3) The "background session finished" chip in the composer (v0.11.0) — optional; upstream ships it as an Appearance preference defaulting to off (a user preference, not a feature gate). |
| OQ-21 ✅ | The default "Project" label (string value) next to the Projects entity | **DECIDED 2026-09-23 by the owner: keep it as upstream** («давай как у апстрима, так будет проще если что перетаскивать фичи когда они будут добавляться»). `getDefaultLabelConfig` is not changed; plan UA5.2 pins it with a test. |
| **OQ-22** ✅ | Artifacts and chat-sharing posture | Owner 2026-09-23 (asked with options): **(a)** a host card on EVERY create AND EVERY update, in every reachable mode, bypass included; **(b)** retention default 7 days (the service's), model range 1..30, unlimited only from the UI; **publishing only when the user asked in the conversation** (the agent may offer a page in one line, never publishes unasked); **Publish on inline previews: YES** (plan UA1.23). Defaults taken and stated (owner rule 2026-09-05): **(c)** unattended runs (automations, schedules, goal continuations, background subagents, Workflow children, `dontAsk`) are refused; **(d)** a user-installed artifact-publish skill or a direct Bash call is redirected to `publish_artifact` on Pi/Claude by a pre-tool-use rule, and codex is a stated residue; **(e)** chat sharing is PLANNED (owner 2026-09-23, asked with options): t-artifacts; the transcript as it is — messages, tool calls with input and displayed result, thinking collapsed — with paths made relative and secrets masked; only the user's Share action triggers it (plan UA1.24–UA1.27); **(f)** token custody: v1 sends the opaque platform dp token to t-artifacts (stated on the docs page as a product posture) and asks dp for a delegated token (`aud` = `SPIRIT_SYSTEM`, `act.sub`); **(g)** deleting a session does not delete its artifacts — it asks. |

## 22. Review focus

1. **Frame CSP:** first bytes, doctype-first, at both render sites, no localhost. Plus the `event.source` check, activation with focus, and a thumbnail window that denies window-open and navigation.
2. **No raw path** reaches `createSession`.
3. **No `allow-all`.** The lifetime ceiling applies to Conductor children.
4. **Completion:** emitted only in the idle arm and turn-scoped; the settlement gate; queue mode on every Conductor send.
5. **Codex reach** is six artefacts plus the Pi descriptor and the three surface pins. An advertised tool with no route is the P3.13 shape.
6. **The ledger is the only grant and approval authority,** including confirmed spec digests and project-context digests. The script env is an allowlist. `runApprovedScript` is the only entry and runs the verified bytes.
7. **Every new setter** writes through `updateSessionMetadata` and the partition notify. Every create field goes through `store-v2`.
8. **Name collisions:**
   - `setSessionProject` vs `setSessionProjectId`;
   - `parentSessionId` on `PermissionRequest` vs on `Session`;
   - `tasks:*` (durable) vs `tasks:getOutput`;
   - two `tasks/` roots.
9. **Nothing is gated.**
   - There is no switch key, env toggle, `feature-disabled` refusal, hidden entry or offer flag. Each surface's protection is the control §6 names.
   - A pages unit reaches the release branch whole or not at all.
   - `isManagedAllHooksDisabled` covers runtime hooks, not the host `AutomationSystem`.
10. **i18n:** a key lands with its reader. Playground `categoryOrder`.
11. **Codex fan-out:** UA4.12's sitting case counts file descriptors under four codex nodes (the Electron floor is 256).
12. **js-yaml round-trip;** `bun:sqlite` never reaches Electron main.
13. **The Craft share-service guard** forbids Craft hosts and share-service knobs, never sharing as such. Publishing lands later, against the owner's resource (UA6.7).
14. **Staged copies:** no visible entry leads to a withheld range. This covers tile controls, TaskEditor tabs, `PagesHome`, `PageView` and `PageFrame`, and the page tools' `refresh`.

## 23. Verified and UNVERIFIED

**Verified 2026-09-23:**
- **Upstream:**
  - `void this.dispatch(node)` and awaited sends;
  - `CRAFT_` prefix pass-through; `SCRIPT_ENV_PLATFORM_ESSENTIALS` excludes PATH; script timeout clamp 1 s–900 s with SIGKILL grace 5 s;
  - grants read from `page.json`; ASCII `slugify` and the `untitled-task` fallback;
  - the Generate draft is `taskDraft` only;
  - the `sources.md` hunk points at `thecraftagents.com`;
  - `prompt-sanitize.ts` is 59 lines; `check-i18n-coverage.ts` is 175 lines;
  - `archive-guards` has a processing arm;
  - `project-colors.tsx` uses category `Session List`;
  - the `feature-flags.ts` hunk since the seed is only `isPagesSharingEnabled` (the sharing flag);
  - the five share channels are `pages:getShareCapabilities`, `pages:getShareDataScan`, `pages:publish`, `pages:setPublicationPassword` and `pages:unpublish`. There is no refresh-approval or run-now channel;
  - `publisher.ts` is the client of Craft's Cloudflare pages-share Worker: its default base is `https://thecraftagents.com/p/api`, overridable by `CRAFT_PAGES_SHARE_API_URL`, and `page_publish_token` is the Worker-minted admin capability;
  - `TaskRunner.finish('completed')` sets the orchestrator's column and status to `done`, and a finished node's status to `done`;
  - `TaskTile` renders Pencil, add-subtask and Play only when their callbacks are set;
  - `TaskEditor` imports `useProjects` and calls `generateTask`, `runTask` and `getTaskResults`;
  - `PagesHome` imports `projectsAtom` and `ProjectMultiSelectFilter`; `PageView` imports `useProjects`, `PageGrantsDialog` and `SharePageDialog`; `PageFrame` reads `page.config.grants` and handles `action` and `grant-request`;
  - `create_page`/`update_page` carry `refresh: PageRefreshSpecInputSchema` with a workspace-relative script path;
  - `grant-request` carries a page-supplied `description` and needs no activation;
  - `page-thumbnailer.ts` has no `setWindowOpenHandler` or navigation handler, and does have a capture timeout;
  - kanban appearance and project colour treatment are localStorage (`atomWithStorage`, `KEYS.projectColorTreatment`).
- **Ours:**
  - `index.css` has 0 `shadow-dragging` hits;
  - the renderer CSP includes loopback;
  - `PERMISSION_MODE_ORDER[0]` is `dontAsk`;
  - `SCHEDULED_DELIVERY_RUNTIMES`, `canHostSession`, `store-v2` `CreateSessionOptions`, `computeSessionSettlementV1`, `turnStartFinalMessageId`, `turnTerminalIsError` and `midStreamOverride` exist;
  - `onProcessingStopped` has three arms with an unguarded teardown;
  - `assertCallerWorkspace` is private to `projects.ts`;
  - `codexDeveloperInstructions(outputStylePrompt?)`;
  - `GUARDED_WORKSPACE_RECORDS` is an exact-path Map of 3 entries;
  - the managed local-automation policy has three arms (the `enableScheduler` construction gate, the `subscribeManagedLocalAutomationChange` enforcement, the `runMissedRunSweep` use-time check) and a named residue in the docblock beside `managedLocalAutomationUnsubscribe`;
  - `isManagedAllHooksDisabled` is read by `capabilities/runtime-automations.ts` (ORed with `isLocalAutomationManagedDisabled`), `bootstrap/storage-runtime.ts` and the `SessionManager` Claude worktree port. It is read by nothing under `packages/shared/src/automations/`;
  - `WorkspaceDefaultProject` persists a stable `projectKey` ("Stable identities only. Process-only keys must not be persisted.");
  - `credentials.enc` is encrypted with a key derived by `pbkdf2Sync` from a machine-derived id;
  - the harness checks `meta.row` only for `rs-*.ts`;
  - `rs-108.ts` already exists;
  - `useBackgroundTasks.ts` has no upstream diff;
  - `NESSY_DP_AUTH_TOKEN` and `NESSY_SERVER_TOKEN` exist;
  - `git grep -a` finds none of `thecraftagents`, `CRAFT_PAGES_SHARE_API_URL`, `CRAFT_FEATURE_PAGES_SHARING` or their `NESSY_` rebrands under `packages` or `apps`. This is an absence reading; its in-scope positive control is the planted file in UA6.6's test.

**UNVERIFIED** (owning row in brackets):
- the Claude cloud-tool roster (UA1.5);
- codex refusal of bridged mutators in `explore` (UA1.8);
- agent write reach; credential-store read reach; and whether a mode below bypass can read and decrypt the key (UA1.10);
- whether upstream rebind moves the cwd (UA5.4);
- `promptLayers` reach and edit timing (UA5.5);
- asset read reach (UA5.6);
- restart treatment of children (UA4.3);
- producers not counted by the settlement (UA4.8);
- codex `tokenUsage` cumulativity (UA4.1);
- WebRTC, DNS prefetch and `compatMode` on Electron 39 (UA7.6);
- whether the loopback adapter authenticates inbound requests (UA7.6);
- which automation path runs a script action for each trigger kind, and what `disableAllHooks` alone does to it (UA8.1);
- the Claude pages on artifacts, dynamic workflows, scheduled tasks and routines, which have not been read;
- equivalence of upstream `proxyToolName` with `buildPoolProxyBaseName`/`sanitizeMcpToolNameSegment` (UA9.2).

## 24. Artifacts and page publishing through t-artifacts; chat sharing (research)

**Service facts (read 2026-09-23 from `gitlab.tcsbank.ru/loyalty-personalization/t-artifacts` at `14e402e`, `release-1.0.13`, and the live service; the landing page is partly stale).** Creating needs `Authorization: Bearer <dp token>`; no edit token is issued any more — the owner is the caller's dp identity, which authorizes `PUT`, `PATCH` and `DELETE /api/artifacts/{id}`; `GET /api/artifacts/mine` lists one's own artifacts. Retention defaults to 7 days (0 = unlimited, max 36500); an update does not extend it; an expired artifact is 404 for good. One page up to 16 MiB; the service wraps the content itself and writes title and emoji RAW (the host escapes them). Anyone on the company network with the link can read the page without login, and the source is downloadable by id without auth. The CSP is permissive (scripts, CDNs). The service is young (about 49 users, 497 artifacts) and changed its auth model twice in three weeks (delegated JWTs since `022fead`, 2026-09-23), so the client is thin and pinned to `openapi.yaml@14e402e`.

**How craft triggers artifact-like output (copied as behaviour).** The agent authors Pages and inline previews on its own when a result is worth keeping or seeing; **publishing is always the user's action** (craft's prompt: "Publishing/sharing is the user's action"; its guide: "You don't publish pages yourself"). Claude's native `Artifact` and the t-artifacts skill are proactive; we do not copy that, because t-artifacts pages are readable by the whole company network.

**Our mechanism (native-first step 2: one host tool for three runtimes).** Claude's `Artifact` publishes to claude.ai and stays disallowed (F1.253 / UA1.5) with an alias to our tool (UA1.20); Pi's `session-share` has verdict NEVER; codex has none. The `artifact-publish` skill is NOT shipped: publishing through Bash differs per runtime and mode, needs npx and Artifactory at every publish, and spawns an interactive `dp auth login` and a browser. Instead: `publish_artifact` / `list_artifacts` (UA1.18) over a host client (UA1.16) and guard (UA1.17), with the host card on every create and update (OQ-22 (a)), a Published pages list (UA1.19), Publish on Pages (UA6.7) and on inline previews (UA1.23), all through ONE host path. The card shows who can read it, the expiry, size and sha256, a preview of exactly the bytes sent, the script count and external hosts, and the scan sentence; there is no "always allow". Token custody is a stated posture (OQ-22 (f)); the card is a consent control for the sanctioned path, not an egress control (UA1.21).

**Chat sharing — PLANNED since 2026-09-23 (owner, asked with options; plan UA1.24–UA1.27).** Owner: «нужно отправлять как есть по возможности, то есть не только текст сообщений но и тулы и прочее, но без путей и секретов»; target t-artifacts; thinking included as in the chat; paths made relative (outside the roots: `…/<basename>`); secrets masked, not refused. The research verdict that led there: Technically feasible: a user-initiated Markdown snapshot published to t-artifacts through the same client and guard (size S–M on top of UA1.16/UA1.17). Precondition before any work: the dormant `shareToViewer`/`updateShare` stop serialising the raw `StoredSession`; the payload is built only from the Markdown export with a field allowlist (no `rawToolResult`, `toolResult`, `toolInput`, thinking, `workingDirectory`, `storedPath`), text messages only by default, paths stripped, exact-bytes preview. The dp agent-related tools (`agent`, `ai`, `mcp-hub`, `code-interpreter`, `nezabudka`, `s3aas`, `cdn`, `mail`, `time`) offer no login-gated sharing; the only ACL-capable alternative is Confluence via `dp wixie`. The session menu's Share item refused while sharing had no target (intended at the time, owner 2026-09-23); UA1.26 makes it work. Owner answers: link-sharing on t-artifacts is accepted for chats; tool I/O and thinking ARE included (minus paths and secrets); no Confluence path; the 1.42.0 plan. For the t-artifacts team: whether S3 or backups keep old bytes after PUT/DELETE; login-gated or per-person sharing plans; a takedown procedure; delegated JWTs for a desktop app and the production `SPIRIT_SYSTEM`; quotas; the licence of the `skilldata` texts; an istio body cap.
