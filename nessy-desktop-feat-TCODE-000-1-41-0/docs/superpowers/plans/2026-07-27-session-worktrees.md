> **CLOSED 2026-07-27.** Executed and verified; evidence in the parity audit §0 (R2).
> Kept until the end-of-series sweep. Do not execute again.

# Session Worktrees (R2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `EnterWorktree`/`ExitWorktree` as documented — the exact tool names, the approval boundary that permission rules deliberately cannot suppress, the four worktree settings keys including the `bgIsolation` write block those tools release, and working-directory bookkeeping that survives resume.

**Architecture:** `WorktreeLeaseService` already creates and removes worktrees (R3 confirmed its `WorktreeCreate`/`WorktreeRemove` events fire). This plan puts two model-facing tools in front of it and one write gate behind it. The order matters: `bgIsolation: 'worktree'` **blocks `Edit`/`Write` in the main checkout until `EnterWorktree` is called**, so the tool is the release valve on a block — build the block and the valve together or ship a lock with no key.

**Tech Stack:** TypeScript, Bun test.

**Contract source:** `code.claude.com/docs/en/tools-reference.md` (EnterWorktree/ExitWorktree), `worktrees.md`, `settings.md` § Worktree settings (raw lines 361-372 — the page is 270 KB and summarizers truncate that section; fetch the raw markdown), `desktop.md`. Distilled in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R2 — **READ IT FIRST**; the queue entry was understated on five counts.

## Global Constraints

- Scope: Pi runtime + app. One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits only; do not touch `docs/superpowers/specs/` (you may edit this plan file); Implementation-First Verification Budget.
- **Out of scope, deliberately:** the retention/GC sweep and orphaned-worktree cleanup are **R12**, the very next plan. Name the seam your code needs (a way to enumerate leases with their last-use time) and stop there.
- **The exact tool names are `EnterWorktree` and `ExitWorktree`** — `tools-reference.md` opens with "The tool names are the exact strings you use in permission rules, subagent tool lists, and hook matchers." `rg` finds zero occurrences today. This is the pre-committed `Task`→`Agent` failure class: an imported Claude agent declaring `tools: [EnterWorktree]` matches nothing. R20 establishes the alias pattern; use it (`packages/shared/src/utils/toolNames.ts` already carries `'Agent'`).
- **The approval boundary is a floor, not a rule.** A `path` outside `.claude/worktrees/` prompts before entering, and "an `EnterWorktree` permission rule or choosing 'don't ask again' doesn't suppress this prompt; only `bypassPermissions` mode skips it." This is a new permission class for us: a prompt rule evaluation cannot satisfy. R15's `promptIsNonNegotiable` is exactly the seam — add this to it rather than inventing a parallel check.
- The series' recurring defect, now four instances deep (P6 `path`/`file_path`; pass 2 `ifRule`; pass 3 the band; pass 5 Monitor dispatch): **two parallel paths, tests green on the one production does not use.** For every surface you add, assert through the production path. A new session tool is **five surfaces** (R3's finding): descriptor, binding, callback-injection seam, handler, and the pinned `tool-surface.json` fixture with its parity test.

---

### Task 0: Pre-phase — fix the live Monitor dispatch defect (CDP pass 5)

**Files:** `packages/pi-agent-server/src/local-tools/tool-wrapper.ts` (~`:85-110`), `packages/pi-agent-server/src/index.ts` (~`:1119-1129`), plus whichever registration site names the tool
- Test: a test that dispatches through the real port construction, not the handler

Every live `Monitor` call fails with `Missing monitor definition for mcp__session__monitor`. `createPiToolExecutionPorts` groups definitions by semanticId and then looks one up by `context.request.presentedName`; the group holds the entry under the **registered** name (`Monitor`) while the request presents the **proxy** name (`mcp__session__monitor`). Unit tests call the handler directly, so nothing caught it.

- [x] **Step 1:** Reproduce in a test first: build the ports the way `index.ts` does and dispatch a `mcp__session__monitor` request. It must throw today.
- [x] **Step 2:** Fix the lookup so a definition resolves under **either** spelling within its semantic group (the proxy name and the registered name both address the same definition), or fix the registration so the group is keyed consistently — whichever leaves ONE name-resolution rule rather than two. Do not special-case `monitor`: the same mismatch would hit any future session tool registered this way, so the fix belongs in the shared resolution.
- [x] **Step 3:** Add a guard test that every registered session tool resolves through the port construction under its presented name — a parity test, so the next tool cannot reintroduce this.
- [x] **Step 4:** Focused suites + `bun run typecheck:all` (pi-agent-server + session-tools). Commit: `fix(pi-agent-server): resolve session-tool definitions by presented name`
- [x] **Step 5:** Note in your report that CDP pass 6 owes the four cases pass 5 could not run: Bash-rule inheritance on `Monitor{command}`, the ws approval prompt with no always-allow, the address-guard refusal with no prompt, and an event on an idle session starting a turn.

### Task 1: Re-verify the plan against current code

**Done. What the re-verification changed (ten corrections):**

1. **The alias-map anchor in Global Constraints was wrong.** `packages/shared/src/utils/toolNames.ts` is a *display-name* map plus `PARENT_TASK_TOOLS`, which exists for SDK message→event conversion. The Claude-name alias map for **imported agent tool lists** is `PI_RUNTIME_AGENT_TOOL_ALIASES` (`packages/shared/src/agent/pi-harness/runtime-agent-definition.ts:19`), consumed by `resolveExplicitTools` (`packages/pi-agent-server/src/orchestrator/runtime-agent-definitions.ts:42`). And the failure is **worse than "matches nothing"**: an unrecognised name lands in `unresolved` and `resolveExplicitTools` **throws** `Unavailable runtime agent tool(s): EnterWorktree`, rejecting the whole imported agent — not just that one tool. R20 has NOT shipped, so there is no R20 pattern to reuse; the shape to copy is the existing `todowrite` entry.
2. **Permission rules need no alias.** A binding's `permissionName` is what rules match, and `sessionBinding(id, Handler)` sets `permissionName = handlerName`. So `EnterWorktree`/`ExitWorktree` rules match by construction — the `Monitor` precedent. Assert it, do not build for it.
3. **`.claude/worktrees/` has no literal counterpart here.** Our harness-owned worktree root is `<dirname(projectRoot)>/.nessy-worktrees/<project-slug>/<leaseId>`, built inside `SessionManager.createPiWorktreeLeaseService`. The approval floor is therefore expressed against **that** root. To keep it from drifting from the lease policy, the layout rule moves into one shared helper both use.
4. **A lease carries NO timestamp of any kind.** `PiWorktreeLeaseV1` (`packages/shared/src/sessions/types.ts:169`) is `{ schemaVersion, worktreeLeaseId, workspaceId, ownerAgentId, path, branch, baseSha, status }` — no `createdAt`, no `lastUsedAt`. **R12 needs one**, so this plan adds `lastUsedAt` (stamped on acquire and on every enter/exit) purely as the enumeration seam and builds no sweep.
5. **Leases today are subagent-only.** `acquirePiWorktreeLease` derives the id from `record.agentId`; nothing owns a session-level lease. `EnterWorktree` introduces one.
6. **R15's seam has a hole the floor must close.** `pi-agent.ts` demotes an `ask` to `allow` when a readable-DSL allow rule matches. Today that also suppresses `requiresUserInteraction` and `askRule` prompts — contrary to the docs quoted in that very code ("an allow rule does not skip it"). Gating that branch on `promptIsNonNegotiable(checkResult)` is what makes the worktree floor survive an allow rule, and it fixes the two existing classes in the same place rather than adding a parallel check.
7. **The cwd record already has the documented two-field shape.** `SessionConfig.workingDirectory` is the mutable record; `sdkCwd` is "set once at creation, never changes" — the launch directory. The missing-worktree fallback needs no new field.
8. **`CwdChanged` already exists** as an automation event (`plugins/hooks-automation.ts:308`, emitted by `pi-agent-server/src/extensions/lifecycle-bridge.ts:144`). Enter/exit reuse it; no new event.
9. **A session tool is five surfaces plus three registry lists**: `TOOL_DESCRIPTIONS`, `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, and the baseline test's `expectedSemanticIds` (38 → 40, with `schemaContracts` recomputed).
10. **Task 0 was a hard precondition.** A `sessionBinding` whose handlerName differs in case from its descriptorId never dispatched — and `EnterWorktree`/`ExitWorktree` are exactly that shape, so this plan would have shipped two tools that throw on first call.

- [x] **Step 1:** Confirm anchors:
  - `WorktreeLeaseService` — `packages/server-core/src/pi-harness/worktree-lease-service.ts`: `acquire`/`recover`/`release`/`list`; `WorktreeCreate` fires BEFORE `git.create` with its path return honoured, `WorktreeRemove` after removal. **No timestamp of any kind** — correction 4.
  - ~~`packages/shared/src/utils/toolNames.ts`~~ → wrong file, correction 1: `PI_RUNTIME_AGENT_TOOL_ALIASES`.
  - `packages/shared/src/agent/core/pre-tool-use.ts` — `promptIsNonNegotiable` at `:532`, `nonNegotiable` at `:517` (`requiresUserInteraction` | `askRule`); the pre-mode marker at `:805` and the pre-mode-branch prompt at `:992` are the template the floor copies. Correction 6 records the hole.
  - `packages/session-tools-core/src/tool-defs.ts` — `Monitor` at `:774`, `visibility: 'pi-only'` as a security constraint; plus `TOOL_DESCRIPTIONS` and `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`.
  - `packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts` — `external(...)` at `:154`, `sessionBinding('monitor', 'Monitor')` at `:250` with the `permissionName` rationale. Session tools need no `PI_STATIC_MODEL_CONTRACT_HASHES` entry (Pi builtins only).
  - The session working-directory record → correction 7: `SessionConfig.workingDirectory` (mutable) + `sdkCwd` (launch directory, never changes), `packages/shared/src/sessions/types.ts:273,281`.
  - Settings schema: where a `worktree` section would live beside P10's `sandbox`. → `AppConfig.sandbox` at `packages/shared/src/config/storage.ts:78`, parsed by `packages/shared/src/config/sandbox-settings.ts` (strict unknown-key refusal, layered floor/merge) and admitted to managed policy at `packages/shared/src/agent/pi-harness/managed-policy.ts:152`. `worktree` goes beside it as `packages/shared/src/config/worktree-settings.ts`, same strictness.
- [x] **Step 2:** Correct this plan in place; say what changed. → the ten corrections above.

### Task 2: The two tools, the alias, and the approval floor

**Files:** new handler(s) in `packages/session-tools-core/src/handlers/`, `tool-defs.ts`, `harness-tool-descriptor.ts`, `toolNames.ts`, `pre-tool-use.ts`
- Test: colocated handler tests + a gate test through the production permission path

Documented contract:
- `EnterWorktree` — `Permission required: Yes`. Two forms: create-new, and enter an existing `path`. A `path` **outside** `.claude/worktrees/` prompts; **new-worktree creation and paths under `.claude/worktrees/` do not**. The prompt is non-suppressible except in `bypassPermissions`.
- Scoped availability: "From within a worktree session, or from a subagent with a pinned working directory such as `isolation: worktree`, only the `path` form is available and the target must be under `.claude/worktrees/` of the session's repository."
- `ExitWorktree` — `Permission required: No`.
- Both names aliased so imported Claude agent tool-lists and permission rules match.

- [x] **Step 1:** Failing tests: entering a path under `.claude/worktrees/` does not prompt; entering a path outside it prompts; an `EnterWorktree` **allow rule does not suppress** that prompt; a session-remembered "don't ask again" does not suppress it; `bypassPermissions`/`allow-all` does skip it; from inside a worktree session the create form is refused and a path outside the repo's `.claude/worktrees/` is refused; `ExitWorktree` never prompts; an imported agent declaring `tools: ['EnterWorktree']` resolves to our tool.
- [x] **Step 2:** Run — FAIL. **Step 3:** Implement (all five surfaces; the floor via `promptIsNonNegotiable`). **Step 4:** Run — PASS + the existing pre-tool-use and tool-surface parity suites. Commit: `feat(session-tools): EnterWorktree and ExitWorktree with their approval floor`

### Task 3: The four worktree settings keys and the `bgIsolation` write block

**Files:** the settings schema (beside `sandbox`), the write gate in `pre-tool-use.ts`/`mode-manager.ts`, `WorktreeLeaseService` for `baseRef`/`symlinkDirectories`/`sparsePaths`
- Test: schema tests + a write-gate test through the production gate

- `worktree.baseRef` — the ref a new worktree branches from.
- `worktree.symlinkDirectories` — directories symlinked into a new worktree.
- `worktree.sparsePaths` — sparse-checkout paths.
- `worktree.bgIsolation` — `"worktree"` is the **default** and it "blocks `Edit`/`Write` in the main checkout until `EnterWorktree` is called". Implement the block, and make `EnterWorktree` release it for that session. **Choose the default deliberately and say why in the commit body:** matching Claude means a fresh session cannot write to the main checkout until it enters a worktree, which is a visible behaviour change for every existing user of this fork. Ship the key with our current behaviour as the default and the documented value available, unless you can show the migration is safe — a silent write block is the kind of change that reads as a bug.

- [x] **Step 1:** Failing tests: each key parses, unknown keys throw (strict, matching `sandbox`); with `bgIsolation: 'worktree'` an `Edit` in the main checkout is refused with a reason naming `EnterWorktree`, and after `EnterWorktree` the same edit succeeds; `baseRef`/`symlinkDirectories`/`sparsePaths` reach lease creation.
- [x] **Step 2:** Implement. **Step 3:** Suites + typecheck. Commit: `feat(config): worktree settings with the bgIsolation write block`

### Task 4: Working-directory bookkeeping across resume

**Files:** the session working-directory record, resume path
- Test: session-layer tests

Documented: entering records the session under its **new** working directory "the same way `/cd` does, so `/desktop` and `--resume` find it there"; exiting moves it back the same way; a worktree created by a `WorktreeCreate` hook **keeps its transcript at the launch directory**; a forked resume starts in the launch directory and leaves the original worktree untouched; **if the worktree directory no longer exists, the session resumes in the launch directory** (do not fail the resume).

- [x] **Step 1:** Failing tests: enter → the recorded cwd is the worktree; exit → back to the original; resume finds the session under the worktree cwd; resume with the worktree deleted lands in the launch directory without error; a fork leaves the original lease untouched.
- [x] **Step 2:** Implement. **Step 3:** Suites + typecheck. Commit: `feat(sessions): worktree-aware working directory across resume`

### Task 5: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, server-core + session-tools + pi-agent-server suites, `bun run lint`, `git diff --check`.
- [x] **Step 2:** Mutation probes: (a) let an `EnterWorktree` allow rule suppress the outside-path prompt → that test must fail; (b) drop the inside-`.claude/worktrees/` exemption so everything prompts → that test must fail; (c) make a missing worktree fail the resume → that test must fail; (d) revert the Task 0 name-resolution fix → the parity test must fail. Restore all four.
- [x] **Step 3:** Report: per-task shas, gate numbers, deviations, probe results, the `bgIsolation` default you chose and why, whether a lease carries a last-use timestamp (**R12 needs it**), and the CDP cases for pass 6 — pass 5's four owed Monitor cases plus: a real `EnterWorktree` outside `.claude/worktrees/` prompting even with an allow rule present, and an `Edit` refused in the main checkout under `bgIsolation: 'worktree'` if you shipped that default.

---

## Close-out record

**Commits** — `bc7415e1` (Task 0), `6e5c6136` (Task 1), `505e9861` (Task 2),
`c76af27c` (Task 3), `d2425848` (Task 4).

**Gates on the final diff** — `bun run typecheck:all` clean across all nine
packages; `bun test` 8236 pass / 18 skip / 0 fail across 756 files;
`bun run test:shared:all` 20 + 5 + 66 + 48 pass, 0 fail; `bun run lint`
0 errors (warnings only, none in changed files); `git diff --check` clean.
Isolated suites all green except `session-branch-rollback.isolated.ts`
(1 pass / 3 fail), which **fails identically on `fff1695a`**, the commit before
this plan started — pre-existing, `managed.agent?.setAutomationSystem is not a
function`, unrelated to worktrees.

**Mutation probes** — all four failed as required and were restored:
(a) dropping the `promptIsNonNegotiable` guard on the allow-rule demotion failed
the floor's pi-agent pin; (b) removing the inside-namespace exemption failed
"does not prompt for a path inside the repository worktree namespace";
(c) throwing on a missing worktree failed both resume tests; (d) reverting the
Task 0 spelling union failed three tests, including the whole-registry parity
test.

**Deviations, with reasons:**
1. **`bgIsolation` default is `"none"`, not the documented `"worktree"`.**
   Reasoning in the `c76af27c` commit body. The documented value is fully
   implemented and one setting away.
2. **The boundary is `<dirname(repo)>/.nessy-worktrees/<slug>/`, not
   `.claude/worktrees/`** — this fork has no such directory. Same boundary,
   different path, expressed once in `worktree-layout.ts`.
3. **Task 0 grew beyond `Monitor`.** The defect hit nine session bindings, and
   the fix collapsed the `presentedName` union rule — previously duplicated in
   `index.ts` and inline in `resolvePiAllowedBindingNames` — into one exported
   helper. `pi-runtime-protocol.test.ts`'s source pins were updated to follow it.
4. **The alias-map anchor named in Global Constraints was wrong**, and R20 has
   not shipped, so there was no R20 pattern to reuse. See Task 1 correction 1.
5. **R15's seam was widened, not just joined.** The allow-rule demotion fix
   changes behaviour for the two pre-existing `nonNegotiable` classes as well.
   That is a bug fix against the contract quoted in that code, and doing it at
   the one branch was the alternative to adding a parallel check.
6. **Worktree settings are not admitted to managed policy.** The plan asked for
   parse + strictness + reaching lease creation; the managed tier is not in
   scope and no test claims it.

**R12 input — a lease had NO timestamp of any kind.** `PiWorktreeLeaseV1` was
`{ schemaVersion, worktreeLeaseId, workspaceId, ownerAgentId, path, branch,
baseSha, status }`. This plan adds optional `lastUsedAt`, stamped on acquire and
on every enter/exit, plus `WorktreeLeaseService.touch()` and
`SessionWorktreePort.list()`. Absent means "unknown", never "epoch" — a sweep
must not treat a pre-existing lease as infinitely old.
