# Task Tracking Tools (R20) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The documented task list as the primary task surface — four tools (`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`) against their exact input AND output types, a file-backed store surviving resume and compaction, the two task hook events made decision-bearing, and the checklist rendered from tasks instead of the TodoWrite-only extraction.

**This is a build, not a rename.** Our `TaskSchema` (`packages/session-tools-core/src/tool-defs.ts:177`) is a `.strict()` discriminated union on `action` that takes a MODEL-supplied `id`, uses `title`, carries a `revision`, replaces `blockedBy` wholesale, and has no `description`/`activeForm`/`owner`/`metadata`/forward-`blocks`. The documented payloads therefore hard-FAIL against it rather than degrade — which is why key repair is load-bearing, not cosmetic.

**Architecture (verified 2026-07-28 at `de611523`, scout + doc fetch):**
- Tool surface today: `TaskSchema` (`tool-defs.ts:177`, four `.strict()` arms as above); `handleTask` (`packages/session-tools-core/src/handlers/task.ts:7`) does no validation — it forwards straight to `ctx.taskPort.execute(args)`; the port is `taskPort` (`packages/session-tools-core/src/context.ts:346`, `{ execute(args: Record<string, unknown>): Promise<unknown> }`, host-owned, Pi-only).
- Render today: `extractTodosFromActivities` (`packages/ui/src/components/chat/turn-utils.ts:298-326`) finds the LATEST `TodoWrite` activity and reads `input.todos`; `TodoListCard` (`apps/electron/src/renderer/components/app-shell/TodoListCard.tsx:65-69`) renders `activity.toolInput?.todos`. Both are TodoWrite-shaped.
- **The two hook events ALREADY EXIST but are the wrong kind**: `TaskCreated` and `TaskCompleted` are entries 10 and 11 of `AGENT_EVENT_CONTRACTS_V1` (`packages/shared/src/automations/types.ts:51-52`), `owner: 'task-service'`, **`observational`**. R20 makes them decision-bearing (R9's decision-kind precedent is the template).
- Key-repair precedent exists: `handleMonitor` maps `timeout_ms → timeoutMs` (`handlers/monitor.ts:53`), `handleBashOutput` maps `shell_id → shellId` (`handlers/bash-output.ts:14`). Same shape, same place.
- Retention: `RetentionPathClass` (`packages/shared/src/sessions/retention-sweep.ts:60`) sweeps `session` / `workspace-session-root` / `logs` / `feedback`, allowlisted via `NEVER_SWEPT_SESSION_ROOT_ENTRIES` + `STORAGE_ID_PATTERN` — a task store rides this, it does not invent a second sweep (R12 owns the key).
- Subagent subtraction: `SUBAGENT_UNAVAILABLE_TOOLS = Set(['ask_user'])` filtered at `runtime-agent-definitions.ts:85`.

**Contract source (fetched 2026-07-28, quote in commit bodies):**
- `agent-sdk/todo-tracking.md` — the migration table gives the exact inputs: `TaskCreate { subject, description, activeForm?, metadata? }`; `TaskUpdate { taskId, status?, subject?, description?, activeForm?, addBlocks?, addBlockedBy?, owner?, metadata? }`; status is `pending|in_progress|completed`, and **`status: "deleted"` deletes**. "The assigned task ID is not in the `TaskCreate` input. It comes back in the matching `tool_result` as `{ task: { id, subject } }`." The stream carries the RAW model shape: "Claude Code repairs some close-but-incorrect key names before execution, mapping `id` or `task_id` to `taskId` and `active_form` to `activeForm`, but that repair is not reflected in the stream." Task tools are the DEFAULT since v2.1.142; `CLAUDE_CODE_ENABLE_TASKS=0` keeps legacy `TodoWrite`.
- `hooks.md` — `TaskCreated`/`TaskCompleted` take **no matcher** and always fire; exit code 2 **rolls back the creation** / **prevents the completion**, with stderr fed back to the model; `{continue:false, stopReason}` stops the agent entirely. **`TaskCompleted` fires even when there is no tool call.**
- `agent-sdk/typescript.md:2110-2160`, `:2682-2740` — the four input AND output types (`TaskUpdate` returns `{ success, taskId, updatedFields, error?, statusChange? }`; `TaskGet` returns the full record with read-side `blocks`/`blockedBy` or `null` on miss; `TaskList` returns `{ tasks: [{ id, subject, status, owner?, blockedBy }] }`). Read these regions directly; the page is large and a summarizing fetch loses them.
- Distilled in doc-verification § R20 (line 621) — **READ IT FIRST**.

## Global Constraints

- One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits; no edits to `docs/superpowers/specs/`, the audit, or the CDP checklist; you may edit this plan file. Implementation-First Verification Budget. Tests from the repo root.
- **The harness assigns the ID.** A model-supplied `id` in `TaskCreate` is ignored, never trusted. The id comes back in the tool RESULT as `{ task: { id, subject } }`.
- **Dependencies are additive in BOTH directions**: `addBlocks` and `addBlockedBy` add edges; nothing replaces the set. The read side (`TaskGet`) exposes both `blocks` and `blockedBy`.
- **`deleted` is a status**, not a separate action.
- **Key repair, exactly two mappings** — `id`/`task_id` → `taskId`, `active_form` → `activeForm` — applied before execution, and NOT reflected in the streamed input (the stream keeps the raw model shape). Reuse the `handlers/monitor.ts:53` precedent's placement.
- **Store**: file-backed, one directory per task (our equivalent of `~/.claude/tasks/<id>/`), surviving resume AND compaction, with an env to share one list across sessions (`NESSY_TASK_LIST_ID`, our `CLAUDE_CODE_TASK_LIST_ID` equivalent). Retention rides R12's existing key/sweep — do not add a second sweeper.
- **The hook events become decision-bearing** (they exist as `observational` today): no matcher; exit 2 rolls back creation / blocks completion with stderr returned to the model; `{continue:false,stopReason}` stops the agent; `TaskCompleted` ALSO fires with no tool call when a turn ends holding in-progress tasks. Inputs: `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?`.
- **Render on the Ctrl+T surface, NOT `/tasks`** — `/tasks` is the background-task view (R3/R10 namespace). Replace the TodoWrite-only extraction; keep TodoWrite rendering working while the legacy path is enabled.
- **Legacy switch**: task tools are the default; `NESSY_ENABLE_TASKS=0` keeps the old `TodoWrite` path (mirrors the documented `CLAUDE_CODE_ENABLE_TASKS`). Old sessions whose transcripts contain TodoWrite activities must still render.
- **Out of scope, explicitly**: `TaskOutput`/`TaskStop`/`SDKTaskUpdatedMessage` (background-task namespace, R3/R10); self-claiming, file-lock claim races, auto-unblocking (documented only under agent teams, which ship experimental and off → R23).
- **The subagent-availability decision (make it, record it):** the docs keep task tools available to a subagent even when its `tools` list restricts everything else. Recommended answer: ADOPT it — the task list is a visible surface, not a side-effectful capability, and our clamp invariant is about permission MODES (`clampPermissionModeToParent`), which this does not touch. Add the four tools beside the existing subtraction seam (`runtime-agent-definitions.ts:85`) with ONE test pinning the intent, and write the rationale into this plan file. If you disagree after reading the code, record the counter-argument and the alternative you shipped.
- The recurring defect count is FIFTEEN. The chain is tool schema → repair → port → store → hook decision → renderer. Assert through production seams; a store the handler writes but `TaskList` reads from elsewhere is THE defect. Remember built artifacts: any model-facing schema change needs `bun run electron:build:servers` + the live-composition pin guard (R10's lesson, twice).
- i18n for renderer strings; new/changed card states into the playground registry.

---

### Task 0: Pre-phase

R18/R19 leftovers: R19 is PARKED by owner decision (egress opened in `d214cb63`); R18's open rows are gateway-blocked live cases. Neither routes work here. Confirm in one paragraph in this plan file.

- [x] **Step 1:** Confirm/record.

**Confirmed 2026-07-28 at `f8513d98`.** Neither leftover routes work into R20. R19 is parked by owner
decision — the egress-proxy work it depended on was superseded when the owner opened outbound network
for `Bash` in `d214cb63`, and the R19 plan file is retained un-executed by that same decision; nothing in
it touches the task list, the session-tool registry, or the hook contract table. R18's remaining open
rows are all *live* structured-output cases blocked on gateway availability (the Nestor gateway has no
Responses API and its tool-call shape is fragile), not code rows — they are reviewer-owned live evidence,
and R20 changes neither the structured-output retry knob nor the result/`terminal_reason` surface. The
one place the two touch R20 at all is the shared hook-decision machinery R9 built
(`packages/shared/src/automations/hook-decision-contract.ts`), which is already on HEAD and green; R20
extends its `exit-code-only` surface rather than re-opening anything R18/R19 left behind. No R18/R19 work
is a prerequisite for, or is invalidated by, Tasks 2-6.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Re-check every anchor on HEAD; correct drifts here; record in Task 2's commit body. Answer IN THIS FILE: (a) **where `taskPort` is implemented host-side** and what backs it today (in-memory? per-session? persisted?) — the scout found the interface, not the implementation; (b) whether tasks survive resume today; (c) what the `Ctrl+T` keybinding currently opens (the scout found the TodoWrite card, not the binding) and where a task checklist would mount; (d) whether `revision` (our optimistic-concurrency field) has a documented counterpart or must be dropped from the new surface.

**Anchor re-check at `f8513d98`.** Verified on HEAD:

| Anchor | Plan says | On HEAD | Verdict |
| --- | --- | --- | --- |
| `TaskSchema` | `tool-defs.ts:177` | `packages/session-tools-core/src/tool-defs.ts:177` | correct (the spec's `:174` is the stale one) |
| `handleTask` | `handlers/task.ts:7` | same | correct |
| `taskPort` iface | `context.ts:346` | same, plus a second declaration at `packages/shared/src/agent/backend/types.ts:317` | correct, incomplete |
| `extractTodosFromActivities` | `turn-utils.ts:298-326` | `:298-326` | correct |
| `TodoListCard` toolInput read | `TodoListCard.tsx:65-69` | `getTodoListItems` at `:64-69`; the component itself is at `:144` | correct anchor, mis-named symbol |
| `TaskCreated`/`TaskCompleted` contracts | `automations/types.ts:51-52`, `observational` | same, `owner: 'task-service'`, `kind: 'observational'` | correct |
| key-repair precedent | `handlers/monitor.ts:53`, `handlers/bash-output.ts:14` | `monitor.ts:52` (`resolveTimeoutMs(args.timeout_ms)`), `bash-output.ts:14` (`args.shell_id`) | correct within a line; see caveat below |
| `RetentionPathClass` | `retention-sweep.ts:60` | same, four classes as listed | correct |
| subagent subtraction | `runtime-agent-definitions.ts:85` | `packages/pi-agent-server/src/orchestrator/runtime-agent-definitions.ts`, set at `:50`, filtered at `:85` **and `:101`** | correct, incomplete — there are TWO filter sites |

**Four drifts the plan's Architecture section gets wrong, corrected here:**

1. **`taskPort` is not unimplemented.** It is wired at `packages/server-core/src/sessions/SessionManager.ts:10107-10123` to `TaskService` (`packages/server-core/src/pi-harness/task-service.ts`), built over the vendored reducer `packages/server-core/src/pi-harness/vendor/rpiv-interactions/task-reducer.ts`.
2. **The two hook events are not merely declared — they are already EMITTED.** `TaskService`'s third constructor argument is an `emit` callback, wired to `SessionManager.executePiTaskAutomationEvent` (`:4788-4806`), which already calls `executeAgentEvent(event, { hook_event_name, task_id })`. What is missing is not the emission, it is the **consumption**: the returned `AgentEventExecutionResult.decision` is discarded, and the emit happens *after* `this.state = candidate` has already been committed and persisted. R20 is a rollback/ordering change, not a new event.
3. **R9's contract table already classifies both events correctly.** `packages/shared/src/automations/hook-decision-contract.ts:73` has `EXIT_CODE_ONLY_EVENTS = ['TaskCreated', 'TaskCompleted']`. But `surfaceFor` gives the `exit-code-only` pattern `decisionValues: NO_VALUES`, so `hookEventCanDecide()` is `false`, so `automation-system.ts:666` takes the `parseHookCommandOutput` branch instead of `getHookCommandPreToolDecision` — which is the ONLY branch that reads the exit code. That single `NO_VALUES` is why exit 2 is silently dropped today. (`parseHookOutputForEvent:270` already honours `continue:false` for this pattern, so the JSON half is half-built already.)
4. **Retention does not need new wiring.** Task state lives inside the canonical session record, which the `session` path class already sweeps. See (b).

**(a) Where `taskPort` is implemented host-side, and what backs it.**
`SessionManager.ts:10107` builds it per session, Pi-only:
`taskPort: piTaskService ? { execute: args => piTaskService.execute(args as any) } : undefined` (`:10508` in the pre-edit numbering, `:10123` for the construction block). The implementation is `TaskService` (`packages/server-core/src/pi-harness/task-service.ts`), a 26-line class holding `private state: TaskState` — **in-memory, one instance per session key**, cached in `SessionManager.piTaskServices: Map<string, TaskService>` (`:2072`) and dropped on session deletion (`:13169`) and on shutdown (`:17341`). It is **also persisted**: the `persist` callback writes through `persistManagedInteractionState` into `managed.taskState` and calls `this.persistSession(managed, true)`. So: in-memory authoritative copy, write-through to the session record on every command.

**(b) Do tasks survive resume today? Yes.**
`taskState` is a `PiTaskStateV1` (`packages/shared/src/sessions/types.ts:79-84`) listed in `SESSION_PERSISTENT_FIELDS` (`:48`), so it is written to and read back from the canonical session record. On the next `getOrCreate`, the service is constructed with `managed.taskState` as its `initial` argument (`SessionManager.ts:10119`), rehydrating the list. This also answers retention: the store rides the session record, so R12's `session` path class already sweeps it — **no second sweeper is needed, and none should be added.** The gaps versus the documented contract are therefore NOT persistence-across-resume; they are (i) no per-task directory, (ii) no cross-session shared list, and (iii) nothing proving survival across *compaction* (compaction rewrites transcript history, not the session record's interaction fields, so this should already hold — Task 3 must pin it rather than assume it).

**(c) What `Ctrl+T` opens today: nothing. The binding does not exist.**
There is no `Ctrl+T`/`CommandOrControl+T` accelerator anywhere in `apps/electron` (the only `Cmd+T`-adjacent hit is a `Cmd+Tab` comment in `main/window-manager.ts:399`), and no `/tasks` slash command exists either — `slash-command-actions.ts` registers `/clear` and `/help`. The checklist today has no dedicated surface at all: it renders **inline in the chat transcript**, where `ChatDisplay.tsx:1300` returns `<TodoListCard activity={activity} />` for any activity passing `isTodoWriteActivity`, with `turn.todos` separately populated by `extractTodosFromActivities` (`turn-utils.ts:380`). The background-task view — the `/tasks` namespace we must NOT disturb — is `useBackgroundTasks` (`ChatDisplay.tsx:711`) rendered at `:2273`. **Consequence for Task 5: the Ctrl+T surface must be BUILT, not repointed.** A task checklist mounts as a session-scoped panel in `ChatDisplay` fed by a task-list selector, with the binding registered alongside the existing renderer shortcut actions (`shortcuts.action.*` in `packages/shared/src/i18n/locales/en.json:1518-1541`, surfaced by `pages/settings/ShortcutsPage.tsx`).

**(d) `revision` has NO documented counterpart. It must not appear on the new surface.**
`TaskUpdateInput` (typescript.md:2125-2135) has no optimistic-concurrency field, and `TaskUpdateOutput` (`:2697-2706`) returns `updatedFields: string[]` + `statusChange: {from,to}` instead — a post-hoc diff, not a pre-condition. The documented conflict story is "last write wins, and the result tells you what changed". `revision` therefore stays on the LEGACY `TaskSchema` untouched (behind `NESSY_ENABLE_TASKS=0`) and is **dropped from the four new tools**. The internal `PiTaskStateV1.revision` counter stays as-is — it is state-level, not exposed to the model, and the orchestration paths at `SessionManager.ts:9244-9268` depend on it.

**Subagent-availability decision: ADOPTED, as recommended.**
The four task tools are added to a new always-available set beside `SUBAGENT_UNAVAILABLE_TOOLS`, applied at both filter sites (`:85` explicit-list path and `:101` inherit path). Rationale, having read the code: our clamp invariant that matters is `clampPermissionModeToParent`, which bounds a subagent's permission MODE by index into `PERMISSION_MODE_ORDER` — it is untouched by tool membership, and none of the four tools can widen it. The tools are also not a capability escape: `TaskGet`/`TaskList` are pure reads of a list the parent session already owns, and `TaskCreate`/`TaskUpdate` write only into that same session-scoped store, reaching no filesystem, network, or credential seam. Every one is `safeMode: 'allow'`, matching Claude's "Permission required: No" (`tools-reference.md:51-56`). The concrete failure this avoids is a restricted subagent silently losing the ability to report progress into the shared checklist, which is a visibility regression, not a safety gain. Counter-argument considered and rejected: `resolveExplicitTools` is otherwise strictly subtractive, so an always-available set is a genuine new direction for that function — but it is scoped to four named, non-side-effectful tools, is pinned by a dedicated test, and the alternative (honouring the allowlist) would put us knowingly out of parity on a documented rule for no security benefit.

### Task 2: The four tools + key repair

**Files:** `tool-defs.ts` (four new tool schemas beside the legacy `TaskSchema`), `handlers/task.ts` (or four handlers), the repair helper
- Test: table-driven inputs incl. the documented raw model shapes

- Exact inputs/outputs per the contract source. Harness-assigned ids. Additive `addBlocks`/`addBlockedBy`. `deleted` as a status.
- Key repair before execution, not reflected in the streamed input (assert BOTH: the executed args are repaired AND the stream still carries the raw shape).
- The legacy `TaskSchema` path keeps working behind the env switch.

- [x] **Step 1:** Failing tests: each tool's documented input validates and its documented output shape comes back; a model-supplied `id` on create is IGNORED and the returned id is the harness's; `addBlocks`/`addBlockedBy` add rather than replace, in both directions; `status: 'deleted'` deletes; `id`/`task_id`/`active_form` are repaired; the streamed input keeps the raw keys; unknown keys behave per the documented tolerance.
- [x] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit: `feat(tasks): the four documented task tools with key repair`

### Task 3: The file-backed store

**Files:** a task store beside the session store, the `taskPort` implementation, retention wiring
- Test: through the production port + a real resume/compaction shape

- One directory per task; survives resume and compaction; `NESSY_TASK_LIST_ID` shares a list across sessions; retention rides R12's key.

- [x] **Step 1:** Failing tests: a task created in one session is present after a restart-shaped reload; compaction does not lose the list; two sessions sharing `NESSY_TASK_LIST_ID` see one list while unshared sessions do not; the retention sweep treats the store under the existing key (no second sweeper, nothing swept that R12 would not sweep).
- [x] **Step 2:** Implement. Commit: `feat(tasks): file-backed task store surviving resume and compaction`

### Task 4: Decision-bearing hook events

**Files:** `automations/types.ts` (the two entries flip from observational to decision), the hook decision plumbing (R9's contract), the create/complete call sites
- Test: through the production hook path (R9's seam), not a stub

- No matcher; exit 2 rolls back creation / blocks completion with stderr fed back; `{continue:false,stopReason}` stops the agent; `TaskCompleted` also fires with NO tool call when a turn ends holding in-progress tasks; documented input fields.

- [x] **Step 1:** Failing tests: exit 2 on `TaskCreated` → the task does NOT exist afterwards and the model sees stderr; exit 2 on `TaskCompleted` → status unchanged; `{continue:false}` stops the agent; a turn ending with an in-progress task fires `TaskCompleted` with no tool call; both events reject a matcher.
- [x] **Step 2:** Implement. Commit: `feat(tasks): decision-bearing TaskCreated and TaskCompleted hooks`

### Task 5: The checklist surface

**Files:** `turn-utils.ts` extraction, `TodoListCard` (or its successor), the Ctrl+T surface, locales, playground
- Test: renderer tests over task activities AND legacy TodoWrite activities

- Render from the task list (accumulate `TaskCreate` results + `TaskUpdate` inputs, or a `TaskList` snapshot), on the Ctrl+T surface; `/tasks` untouched.
- Legacy transcripts with TodoWrite activities still render.

- [x] **Step 1:** Failing tests: a transcript of task tool calls renders the checklist with statuses and the active form for in-progress items; a legacy TodoWrite transcript still renders; `/tasks` still shows background tasks only.
- [x] **Step 2:** Implement. Commit: `feat(tasks): render the task checklist on the Ctrl+T surface`

### Task 6: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, session-tools-core + pi-agent-server + server-core + ui/electron suites, `bun run lint`, i18n parity+sorted, `git diff --check`; schema changes → `bun run electron:build:servers` + the live-composition pin guard.
- [x] **Step 2:** Mutation probes: (a) trust a model-supplied `id` on create → the harness-id test must fail; (b) make `addBlockedBy` replace instead of add → the additive test must fail; (c) reflect the key repair in the streamed input → the raw-stream test must fail; (d) make `TaskCreated` observational again → the exit-2 rollback test must fail. Restore all four.
- [x] **Step 3:** Report: per-task shas, real gate numbers, the Task 1 answers, the subagent-availability decision with its rationale, deviations, probe results, and the live/CDP cases for the planner's pass 14 — expected: a live turn creating tasks renders the checklist on Ctrl+T with harness ids; a `TaskCreated` hook exiting 2 visibly rolls the task back; tasks survive an app restart; `/tasks` still shows background tasks.


---

## Execution record

**Commits** (branch `fix/renderer`, one per task, pathspec-limited):

| Task | Commit | Subject |
| --- | --- | --- |
| 0 + 1 + 2 | `0833c75a` | `feat(tasks): the four documented task tools with key repair` |
| 3 | `a756ab40` | `feat(tasks): file-backed task store surviving resume and compaction` |
| 4 | `db38f310` | `feat(tasks): decision-bearing TaskCreated and TaskCompleted hooks` |
| 5 | `9ee9914b` | `feat(tasks): render the task checklist on the Ctrl+T surface` |
| 6 | (this commit) | `chore(tasks): R20 close-out` |

Tasks 0 and 1 have no commit subject of their own in the plan, so their records
land with Task 2 as the plan instructs ("record in Task 2's commit body").

**Deviations, all deliberate and recorded at their site:**

1. **The checklist binding is `mod+shift+t`, not `mod+t`.** `mod+t` is already
   `app.newChatInPanel` and matches the OS "new tab" convention in a desktop
   shell; Claude's `Ctrl+T` is a terminal binding. R20 requires the checklist
   SURFACE, which is what shipped. Recorded in `actions/definitions.ts`.
2. **The `NESSY_ENABLE_TASKS` switch is scoped to the Pi projection.** The four
   tools are `pi-only`, so suppressing `TodoWrite` everywhere would leave the
   Claude and session-mcp-server backends with no checklist tool at all. The
   switch therefore swaps the two surfaces on Pi and leaves every other backend
   on `TodoWrite`.
3. **The matcherless rule covers only the two task events**, not the full
   documented list of ten (`hooks.md:262`). Extending it to `Stop`,
   `UserPromptSubmit` and the rest is a behaviour change for existing configs
   and belongs to whichever phase owns those events. Recorded in
   `automations/utils.ts`.
4. **`hookEventStdoutCanDecide` split out from `hookEventCanDecide`.** Giving
   the `exit-code-only` surface a block value (so an exit-2-derived decision
   survives projection) initially let a stdout `{"decision":"block"}` through on
   an exit-0 hook, which the docs do not permit. Two existing R9 tests caught it.
   Both parse sites now read one helper.
5. **Retention rides an added `tasks` config-root class** in the EXISTING
   `runRetentionSweep`, alongside `logs` and `feedback` — one sweep, one
   `cleanupPeriodDays` key, no second sweeper, and the `tasks` root itself is
   kept.

**Pre-existing failures, verified at `f8513d98` and untouched by R20:**

- `Pi harness R0 baseline > executes golden foreground and background process
  contracts` — `isolationProfile` `workspace` vs `networked`, from `d214cb63`.
  A background task was filed to resync that golden.
- `conformance — live gateway` (2 cases in `codex-responses-adapter`) — R18's
  gateway-blocked live rows.
- `ensureStorageLayoutV2` / `config path default-root` / `managed paths with
  NESSY_CONFIG_DIR` — 10 cases; `packages/shared/src/workspaces` +
  `packages/shared/src/config` report 381 pass / 10 fail both before and after.
- `bash tool-input timeout real server e2e` is flaky under full-suite parallel
  load only (a real-server e2e with a 3s wall-clock deadline); 3/3 in isolation.

**Mutation probes — all four confirmed the guard, all four restored:**

| Probe | Mutation | Test that failed |
| --- | --- | --- |
| (a) | Trust a model-supplied `id` on create | `a model-supplied id on create is IGNORED and the harness id is returned` |
| (b) | `addBlockedBy` replaces instead of adds | `a second addBlockedBy ADDS rather than replacing the set` |
| (c) | Repair mutates the caller's object | `the repair is NOT reflected in the streamed input` |
| (d) | `exit-code-only` back to `NO_VALUES` | `exit 2 produces a blocking decision carrying stderr` (both events) AND `the task does NOT exist afterwards and the model sees stderr` |

Probe (d) is the load-bearing one: it fails in BOTH the contract layer and the
end-to-end rollback, which is what proves the decision reaches the store rather
than stopping at the projection.
