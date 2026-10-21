# Session Runtime Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user change a live session's LLM connection — including one whose runtime differs (`pi` ↔ `anthropic` ↔ `codex-runtime`) — with the runtime's own conversation state handled honestly: preserved where the anchor survives, handed over as bounded context where it cannot.

**Architecture:** The session's runtime is derived from one field, `SessionConfig.llmConnection`, through `resolveBackendContext` → `AgentProvider` → `DRIVER_REGISTRY`. Two deliberate blocks stop it changing mid-session: `connectionLocked = true` at first agent creation (`SessionManager.ts:12878`) and a hard `throw` in `setSessionConnection` when the session has messages (`SessionManager.ts:14671`). This plan replaces both with one explicit `switchSessionRuntime` operation that reuses machinery already in the codebase: the restart-required drift path (`tryRefreshAgentRuntime` → `disposeManagedAgentRuntime` → recreate), the per-turn context-injection seam in `BaseAgent.chat` (`base-agent.ts:3707`), and Codex's own `thread/fork` boundary. The one genuinely new persisted concept is a provider-scoped runtime anchor replacing the single, namespace-ambiguous `sdkSessionId`.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run typecheck:all`), React 19 + Tailwind renderer, Electron main/renderer split, i18next.

## Global Constraints

- Use Bun for all JS/TS work. Never `npm`/`yarn`/`pnpm`.
- Branch name must follow `<type>/TCODE-000`; use the literal `TCODE-000` fallback when no tracker task exists.
- One commit per task, using the commit message given in that task's final step.
- Never add `Co-Authored-By` trailers.
- Update this plan's `## HANDOFF (2026-08-15) — the "runtime" session ended after T3

The session that ran waves 1-2 is gone (socket closed, unreachable). State
at handoff, verified by the orchestrator on a QUIESCENT tree (only three
foreign files modified, none of this plan's):

- ✅ T1 `26bc740ee`, T2 `9b6b26604` + fix in `bd8fcd44a`, T3 `bd8fcd44a`,
  T16 `6b73b8b11`; plan/tracker commits `d5f90d5d4`, `81c4cf347`,
  `4bb19527b`.
- ⬜ Remaining 13, in the Order that session established:
  **T4 ‖ T5 → T7 ‖ T14 → T8 → T9 → T10 → T12 → T13 → T17 → T11 → T15 → T6.**
- Executors are now SUBAGENTS dispatched by the orchestrator, one per wave,
  tasks sequential inside a wave (this is how plans 1-2 finished after
  their own session died). The no-concurrent-`git commit` rule that session
  introduced still holds — it exists because concurrent invocations race
  `.git/index.lock`, which disjoint file sets do NOT protect against.

CARRY THESE FORWARD — they are protocol, not preference:
1. **Per-task re-verification (owner's standing rule).** Before STARTING
   each task, re-verify THAT task's anchors and claims against the tree as
   it is THEN, correct the task text in the same commit, and rule-8 stop if
   a correction changes the task's APPROACH rather than its coordinates.
   It has now caught, in three tasks: a helper comparing a RAW value to a
   DERIVED one that would have made the feature INERT on the primary card
   while green on every test written for it; a test and a signature from
   two steps that did not typecheck together; an instruction to edit a
   doc-comment that does not exist; and a defect in T2 found by T3 one wave
   later.
2. **The tracker note contract.** Every row carries the number MEASURED
   (not the adjective), the artifact it was read from, the CONTROL that
   ruled the alternative out, and for live proof the case name + commit.
   A row that states a verdict without evidence gets sent back.
3. **Anchors: match on the identifier, correct the number.** ~48 line
   numbers had already drifted `master → HEAD` before this plan started,
   and this plan's own tasks move each other's (SessionManager.ts is in 10
   of 17). Claims about BEHAVIOUR survive edits; COORDINATES do not.
4. **Line-number tables measured during a running wave are stale on
   arrival** — measure them only on a quiescent tree.

## Tracker` table **in the same commit that lands the task**.
- Do not create merge requests or tags during autonomous execution.
- i18n: every new key goes into **all** locale files; `bun run lint:i18n:parity` and `bun run lint:i18n:sorted` must stay green.
- Follow the repo's Implementation-First Verification Budget: during the implementation loop run only focused tests for changed behavior plus affected-package typechecks. Full repository regression runs at the T6 close-out boundary only.
- `rm -rf release` before any repository-wide `bun test` (a packaged build leaves renderer copies under `release/**/Resources/app/src/` that the root test run collects).
- `nestor-cloud-agent` is **out of scope** as a switch target and a switch source. It is filtered out of the target list; a session already on it keeps today's behavior.

---

## Background: what is true on `master` today

Verified 2026-08-14 by reading the code. Every claim here has a file:line, and each is what the tasks below are built on.

**Runtime binding.** `LlmProviderType` (six values, `llm-connections.ts:63`) collapses onto four `AgentProvider` values via `providerTypeToAgentProvider`: `pi`/`pi_compat` → `pi`, `anthropic`/`claude-runtime` → `anthropic`, `codex-runtime` → `codex-runtime`, `nestor-cloud-agent` → itself. `DRIVER_REGISTRY` (`factory.ts:74`) maps those to backends.

**Model catalog is per-connection.** `LlmConnection.models` (`llm-connections.ts:164`), refreshed by `MODEL_FETCHERS` (`model-fetchers/registry.ts:63`). The picker reads `effectiveConnectionDetails.models` (`CompactModelSelector.tsx:119`). Switching integration therefore changes the offered model list for free — that half already works.

**Effective model resolution** is `resolveModelForProvider` (`factory.ts:721`): session model → workspace default → `connection.defaultModel`, with a cross-provider guard and a catalog guard. **The catalog guard is scoped `provider === 'pi'`** (`factory.ts:759`), so a stale model id survives a switch onto an `anthropic` or `codex-runtime` connection.

**Drift refresh already exists.** `tryRefreshAgentRuntime` (`SessionManager.ts:10645`) is called from `getOrCreateAgentUnchecked` (`:12831`) and `refreshConnectionRuntime` (`:12567`). `buildRestartRequiredSignature` (`runtime-config.ts:50`) already includes `provider`, `providerType`, `slug`, `authType`, `piAuthProvider`; `buildBackendRuntimeSignature` (`:71`) additionally includes `resolvedModel`.

**Only PiAgent implements `updateRuntimeConfig`** (`pi-agent.ts:7604`; the interface member is optional at `backend/types.ts:1134`). For Claude and Codex any runtime drift — including a model change — therefore falls through to `disposeManagedAgentRuntime(..., strict = true)` and a full backend recreate.

**Anchor re-verification, 2026-08-15 (after two plan close-outs).** Every claim in this section still holds; **every line number moved.** `updateRuntimeConfig` is still implemented only by `PiAgent` — but at `pi-agent.ts:7604`, not `:7491`, and it now holds for a stronger reason: lane F added TWO spawn-time env vars to the Claude runtime (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, both inside `startLocalAdapterRuntime`), so Claude carries *more* configuration that only a respawn can change, not less. Codex's `CODEX_HOME` is still `mkdtempSync` (`:292`) removed at `:1066`, and `rg -ac sdkSessionId codex-agent.ts` is still **0**. Pi still resumes by directory (`pi-agent-server/src/index.ts:2198`). Claude still resumes by id (`claude-agent.ts:1894`). This is exactly the shape Step 0's anchor rule predicts: **match on the identifier, correct the number.**

**Runtime-side history anchors:**

| Runtime | Anchor | Storage | Survives dispose? |
| --- | --- | --- | --- |
| Pi | `sdkSessionId` → `piSessionId` (`pi-agent.ts:1041`, re-verified) | `.pi-sessions` sidecar under the session dir | yes |
| Claude | `sdkSessionId` → SDK `resume` (`claude-agent.ts:1894`) | `<workspaceRoot>/claude-config/projects/<encoded-sdkCwd>` | yes |
| Codex | `threadId` from `thread/start` (`codex-agent.ts:345`, re-verified) | `CODEX_HOME` = `mkdtempSync(tmpdir(), 'nessy-codex-home-')` (`:292`), deleted in `teardownRuntime` (`:1066`) | **no** |

Consequences: (a) `sdkSessionId` is one field holding two different namespaces, so a cross-runtime switch that does not clear it hands Claude a Pi id; (b) a model change on a live Codex session today dispose-recreates the agent and starts a **fresh empty thread** while the UI transcript still shows everything — a silent `/clear`.

**Context handoff seam.** `BaseAgent.chat` composes `messageParts = [capabilityContext, branchSeedContext, transferredSessionContext, continuationRestore, pinnedSkills, forkedSkills, cleanMessage]` (`base-agent.ts:3707`). `buildBranchSeedContext` (`:2606`) emits the last 24 messages at ≤1200 chars each, once, gated on `branchContextStrategy === 'seeded-fresh-session' && !branchSeedApplied`. This works on **all three** backends already.

**Precedent for the product decision.** Claude Code's `/model` picker "asks for confirmation when the conversation has prior output, since the next response re-reads the full history without cached context" (`code.claude.com/docs/en/model-config`, § Setting your model). Codex `/model` switches model and reasoning effort mid-session preserving context, and resets reasoning effort to the new model's default rather than carrying the prior level over. Both precedents are adopted below: confirmation is scoped to transitions that actually cost something, and effort is renormalized rather than carried.

---

## Audit corrections — 2026-08-14

A 50-agent adversarial audit read every surface this plan touches and re-verified each claim against HEAD. It found **five blockers, three of them in this plan rather than in the product**. Everything below is folded into the tasks; this section exists so a reviewer can see what changed and why without diffing.

### Blockers this plan introduced

**A1 — writing `managed.permissionMode` directly is a privilege split.** Task 3 assigned the field. It is the only such write in the codebase not paired with `setPermissionMode(...)` on the mode manager, and **enforcement does not read the field**: `PermissionManager.getPermissionMode()` delegates to the module singleton (`packages/shared/src/agent/core/permission-manager.ts:209-210`) and Claude's PreToolUse gate reads it with the comment "single source of truth" (`packages/shared/src/agent/claude-agent.ts:1474-1475`). A newly constructed agent never reads `config.session.permissionMode`. So a Codex→Pi switch off `bypassPermissions` would clamp the record and the UI to `default` while the agent kept running unrestricted. `SessionManager.ts:19288-19296` already calls exactly this state "drift" and logs it. **Fix: route through `setSessionPermissionMode` (`:19255`), the documented "Door 2/2" for every mid-session mode change.**

**A2 — the `'default'` fallback is an escalation and re-implements an existing authority.** `normalizeManagedPermissionMode` (`packages/shared/src/agent/mode-types.ts:158-176`) uses a graded chain and lands `dontAsk` on the `'plan'` floor "rather than to a mode that could prompt". This plan mapped `plan` and `explore` — both no-write — onto write-capable `default`. Dormant today (every non-nestor provider declares all modes) and live the moment anyone narrows the list. **Fix: `renormalizeForRuntime` returns `normalizeManagedPermissionMode(mode, disabled)`; the permission half of the bespoke helper is deleted.**

**A3 — wrong teardown primitive, and the boundary is checked but never held.** The repo's primitive for a destructive session mutation is `strictDrainSessionForMutation` (`SessionManager.ts:10319`), used by rewind, project mutation, delete, trust revoke, root revoke, auth retry and cleanup. It routes to `strictDrainPiSession` when the OUTGOING provider is Pi (`:10324-10327`) — which is what drains worktree leases, child sessions and `piChildRuns` and asserts `pi-session-worktree-residual`/`pi-session-child-residual`; it `forceAbort`s a live agent, kills background shells and FAILS if one survives, and it **holds `acquireSessionMutationBoundary` for the whole operation** (`:10329`). This plan read `projectMutationSessions` without acquiring it — check-without-hold, and `disposeManagedAgentRuntime` is async. **Fix: acquire the boundary; replace the dispose with `strictDrainSessionForMutation`.**

**A4 — app quit races the switch.** `cleanup()` (`SessionManager.ts:21334`) acquires the mutation boundary for every session and lets the throw escape (`:21347`). With A3 fixed, a quit during a switch makes `acquireSessionMutationBoundary` throw `session-project-mutation-busy` and `cleanup()` rejects at the first session — skipping SessionEnd hooks, Pi drains, config watchers, MCP pools, cron/LSP teardown, and everything after `cleanup()` in the Electron quit handler including the **server lock-file release**. `setProjectTrust` (`:16072`) has the same shape. **Fix: an in-flight-switch set the quit path awaits.**

**A5 — the anchor map would adopt a poisoned Codex value and then lie.** `BaseAgent.getSessionId()` returns the **Nessy** session id (`base-agent.ts:590`), `CodexAgent` does not override it, and `SessionManager.ts:17119-17123` writes it into `sdkSessionId` unconditionally after the first Codex turn. Task 2 would migrate that into `anchors['codex-runtime']`, and Task 3 would then report `contextCarried: 'runtime-anchor'` on a Codex→Codex change while `CodexAgent` starts a brand-new thread in a fresh `mkdtempSync` CODEX_HOME. Total amnesia with a UI string affirming the opposite. **Fix: `codex-runtime` is NOT an anchored provider; guard `:17119`; Codex same-runtime is a handoff case.**

### The fact that changes the design

**Pi does not resume by `sdkSessionId` — it resumes by DIRECTORY.** `piSessionId` is never forwarded to the subprocess; the init passes `sessionPath` and the subprocess does `join(config.sessionPath, '.pi-sessions')` → `strategy = { kind: 'continue', sessionDir }` → `continueRecent(cwd, sessionDir)` (`packages/pi-agent-server/src/index.ts:2171`, `:2191`; `compat/pi-runtime-adapter.ts:336`). On the Pi path `sdkSessionId` only picks `'resume'` vs `'startup'` for the SessionStart hook.

Consequence: **Pi → Claude → Pi silently rejoins the pre-switch Pi thread and omits every Claude turn**, while the UI shows all of them. That is worse than a blank slate — it looks like a correct resume and cannot be repaired afterwards, because the Claude turns live only in Nessy's JSONL, never in the Pi sidecar. The return trip must therefore force a FRESH Pi session directory and let the handoff be the sole history.

### Blockers that already exist on `master`

Not created by this feature, but reachable through it and therefore in scope:

- **A persisted Pi goal keeps auto-dispatching turns on the new runtime.** `schedulePiGoalContinuation` (`SessionManager.ts:3848`) re-arms after every completed turn with no provider gate, the `GoalService` survives dispose (deleted only at rewind/delete/shutdown), and for a non-Pi provider `getPiHarnessRuntimeSnapshot` returns a settlement that is unconditionally `settled: true` — so the loop fires `sendMessage("Continue active goal …")`. Bounded by `DEFAULT_PI_GOAL_BUDGETS` (32 turns / 250k tokens / $20 / 2h) and the accounting does accrue on the new runtime. Neither model nor user can cancel: `Goal`/`GoalGet` are `pi-only`, every control throws `pi-runtime-provider-required`, and there is no RPC or UI.
- **Session crons / `/loop` keep waking the session.** `SessionCronService`'s `setInterval` is never stopped by dispose; delivery is not provider-gated. The cron FILE also leaks permanently if the session is switched off Pi, restarted, then deleted.
- **`ws` monitors are never stopped.** `SessionMonitorService.stopAll` has no production caller anywhere.
- **The context meter freezes on the old runtime's numbers, permanently, Pi→non-Pi.** `applyContextUsageSnapshot` early-returns on `undefined`, Claude and Codex never emit one, dispose clears neither `contextUsage` nor `tokenUsage`, and the renderer prefers the stale snapshot. Codex's fresh counts land in `tokenUsage` and stay invisible behind it for the life of the session. Self-heals in the other direction only.
- **A staged image is silently dropped on the claude-runtime wire.** `attachments.images` has zero non-test consumers; both filter sites are gated on `isCompatProvider`, which is `pi_compat` only. The adapter's `flattenContent` keeps only parts with a string `text`.

### Refuted — do not spend effort here

- **The transcript cannot break.** There is no provider-keyed branch anywhere in the render path; `Edit` shapes and MCP wire names already parse in both forms. Every risk on that surface is state-lifecycle, not rendering.
- **Tool rows do not spin forever.** `onProcessingStopped` emits `complete` unconditionally. What survives is the same reload cosmetic every Stop produces today.
- **Pi children do not inject completion notices into the new runtime** — three independent gates. They are orphaned silently instead, which is the real (lower-ranked) problem.
- **`capabilities_changed` is not missing.** The two blocks this plan removes ARE the two emitters. The real hazard is the opposite: a racing second emit carrying the pre-switch payload.
- **LSP, plugin peripherals, MCP pools/leases, channel subscriptions and tool callbacks are torn down correctly** by `disposeManagedAgentRuntime`.
- **Cost accounting already handles the mixed case** (`CostReporting` has a `'partial'` member; `modelUsage` is keyed by model). **`sdkCwd` does not drift.** **Archive is inert.**


---

## Execution protocol — verify each task against what the previous ones actually left

**Owner's standing rule, 2026-08-15, verbatim:** «пусть он проверяет сам перед каждым началом задачи из плана, то есть сделал одну - следующую перед тем как брать нужно проверить на актуальность и подкорретировать и так до конца плана, общая цель не меняется».

Before **starting** each task — not once up front — re-verify that task's anchors and claims against the tree as it is at that moment, correct the task text where it drifted, then implement. Task by task, to the end. **The plan's overall goal does not change; the task bodies may.**

Two things follow, and the second is the one people get wrong:

1. **The check is scoped to the task being taken** — its cited `file:line`, its claims about current behaviour, its zone. It is not a re-audit of the plan. Scoped, it costs minutes; unscoped, nobody will do it by task six.
2. **The drift is mostly self-inflicted, and it is guaranteed.** `SessionManager.ts` appears in ten of seventeen tasks. By the time T8 lands, the line numbers T9 cites were written against a tree that no longer exists. This rule is not insurance against an unlikely event — it is the routine handling of something that will happen every single time.

A seventeen-task plan starts decaying the moment task 1 lands. Line numbers drift, symbols get renamed during review, and a task's own close-out note records decisions the later tasks were written before. So the plan is **not** verified once up front and then trusted; every task opens with a pre-flight against the tree as it actually is.

**This is Step 0 of every task and it is not optional.** It runs before a single line of code is written, and it may end in a plan edit instead of an implementation.

### The five pre-flight checks

1. **Anchors.** For every `file:line` the task cites, open it and confirm the quoted symbol is there. A doc or code line number decays; the quoted identifier does not — so match on the identifier and correct the number. If a symbol moved to another file, that is a finding, not a typo.

   **A behaviour claim survives an edit; a coordinate does not.** This is why the rule says *verify and correct*, not *re-cite*. "config.toml is read when the app-server starts and nothing here respawns it" and "`applyContextUsageSnapshot` also writes `tokenUsage.contextWindow`" stay true when the lines around them move; `:12889` does not. When a task's claim and its number disagree, the claim is the thing to test and the number is the thing to fix — never the reverse.

   **A wrong PATH is worse than a wrong line.** A check that cannot find the file may conclude the *claim* is stale when only the path was, and a task then gets rewritten around a defect that never went away. Always cite the full path from the repo root; never a shorthand that looks like one.

   **Never accept an anchor table measured while anything was in flight.** Measured 2026-08-15: a table produced during wave 1 was off by exactly +2 on every `SessionManager.ts` and `codex-agent.ts` anchor, because two units were editing those files as it was written. That kind of stale is worse than absent — it reads as verified. Anchor tables are measured on a quiescent tree, and the note says which tree.
2. **Contracts.** Every name in this task's `Consumes` block must exist with the declared signature. Run `bun run typecheck:all` before writing anything: a red typecheck at Step 0 means an earlier task shipped a different shape than it promised.
3. **Promises kept.** Read the tracker rows of every completed task and the commits they name (`git show --stat <sha>`). Compare against those tasks' `Produces` blocks. A task that landed with a deviation recorded in its note may have invalidated this task's assumptions.
4. **Green base.** Re-run the previous task's tests. They must still pass on the current tree. If a rename broke them, this is where it surfaces — not three tasks later.
5. **Scope still real.** Re-read this task's opening paragraph and ask whether the defect it describes still exists. Some of these tasks fix things another task may have already had to touch. A task whose reason has evaporated is closed as `⏸ superseded` with the reason, not implemented for completeness.

### What to do when a check fails

**Correct the task text, then implement — and record the correction in the SAME commit as the task**, the way a tracker row flips (owner's rule, and AGENTS.md's tracker rule already works this way). Never code around a stale plan silently: that is how the plan and the tree stop describing the same system, and every later task inherits the confusion.

*The one exception is mechanical, not a loophole.* Inside a parallel wave no agent may touch the plan file at all (Parallelisation §6 — it is a shared file for every pair and cannot be zoned). There, the agent returns its corrected task text alongside its tracker row and the orchestrator writes both in the wave-boundary commit. Thirteen of seventeen tasks run alone, so for most of this plan the agent writes it itself.

**Coordinates versus approach — the line that decides whether you may proceed.** A correction that moves a number, renames a symbol or re-points a file is a *coordinate* change: fix it and carry on. A correction that invalidates *why* the task is written the way it is — the defect no longer reproduces, the seam moved to another layer, another task already solved it — is an *approach* change. **Stop there and ask before implementing.** T7 is the worked example already in this plan: three of its tests go green the moment T3 lands, and the honest response was to rewrite its test list at Step 0, not to implement a task whose reason had partly evaporated.

Record every correction in the table below. One row per divergence, with the task that found it. This table is the honest record of how the plan changed under execution, and a reviewer reads it before the diff.

### Corrections log

One row per divergence. `Kind` separates the two things a pre-flight can find about the PLAN, because they have different rules: a **correction** is the plan describing something wrongly, an **addition** is the plan not describing it at all. A third kind — a real defect in the code that is out of scope for the task that found it — does not belong here; it goes on the Deferred fix-list below.

| Kind | Found by | What the plan said | What the tree actually had | Resolution |
| --- | --- | --- | --- | --- |
| correction | T4 Step 0 | T4's opening: the handoff is **three parts** (state snapshot + tail + mini-model summary), producing `RuntimeHandoffPayload`, `splitHandoffTranscript`, `HANDOFF_TAIL_*` and a `runtime-handoff.ts` module | **No step implements any of it.** Steps 1–9 implement a tail-only builder in `base-agent.ts`. Four other places in the plan agree with the steps: the global File Structure (no `runtime-handoff.ts`), the Deviations log (summary "deliberately NOT built up front"), T4's tracker row, Step 9's commit subject | Tail + marker shipped. Part C not built (a recorded owner decision forbids it). Part A not built and recorded in the task body as a bounded follow-up, with the reason — it was never stepped, and it needs a persisted payload, an async `listFileCheckpoints` load and a render that the task does not specify |
| addition | T4 Step 0 | `SESSION_PERSISTENT_FIELDS` + the `SessionConfig` field is all persistence needs | `headerToMetadata` (`store-v2.ts:187`) is a hand-copied projection and `loadSessionsFromDisk` builds every restored session from it. A field not in it — and `transferredSessionSummary` is the precedent — must be copied in the two message-hydration paths instead | Copies added at `SessionManager.ts:8538` and `:9586`. Without them a quit between the switch and the next turn drops the handoff and then **persists the loss** |
| addition | T4 Step 0 | `hasHistory` reads `managed.messages` directly | `managed.messages` is lazy-loaded; a session not opened in this process reads `[]` while its JSONL holds the conversation. The arming, the notice and `contextCarried` would all be wrong on exactly those sessions — and green in every test, because the harness builds `messagesLoaded: true` sessions | `await this.ensureMessagesLoaded(managed)` before the classification, with a test that stubs the loader and goes red when the await is removed |
| correction | T4 Step 0 | Step 6: `role: 'system'`, `id: \`runtime-switch-${Date.now()}\``, and `sendEvent({ …, message })` | `MessageRole` has no `'system'` (Wave-0 decision D1 already said so); the file's precedent for an appended row is `generateMessageId()` + `this.monotonic()`; and in `SessionManager.ts` `Message` aliases **`PersistedMessage`** (`:219`) so the event needs `toSessionMessage(message)` or `tsc` fails on `attachments` | All three corrected in the snippet and the code |
| correction | T4 Step 0 | Step 6: `this.clearRuntimeScopedSessionState(managed)` | T3 landed it with a second parameter, `fromProvider` — the snippet predates its own dependency | Corrected |
| correction | T4 Step 0 | Step 3: add the export "immediately after `buildBranchSeedContext` (ends `:2627`)" | `buildBranchSeedContext` is a `protected` method ending `:2629`; a class body cannot hold a module-level export | Placed immediately before `export abstract class BaseAgent`, with a docstring pointing back |
| correction | T4 Step 0 | Step 7: `await createSwitchHarness({ provider: 'pi' })` | The harness is synchronous and its option is `from` (default `'pi-source'`); `provider` is inert | Corrected. Separately, T4 turns **two of T3's own tests red** — both changes are correct, so Step 7 repairs them |
| correction | T5 Step 0 | Step 9: pass `canSwitchConnection` into `derivePickerMode`, and wrap the dialog around the cross-connection model handlers (`handlePickSwitcherModel`, `FreeFormInput.tsx:2637`) | Both belong to the SUPERSEDED single-tree design. The owner's "two controls, not one tree" decision (Deviations log, 2026-08-14) deletes the `switcher` UI entirely, so there are no cross-connection model handlers to wrap and `switchable` never reaches `derivePickerMode` — it reaches `ConnectionRow`, which owns the confirmation | Step 9 rewritten to what the two-control shape actually needs. `derivePickerMode` keeps two fields and decides only the model list |
| correction | T5 Step 0 | Step 2: "Expected: FAIL — `PickerModeInput` still requires `isEmptySession` and `connectionCount`" | `bun test` does not typecheck. Measured: the rewritten fixture passes **5/0 against the OLD implementation**, because the omitted fields read `undefined` and the `switcher` branch is unreachable. The red is `tsc`'s TS2322 | Step 2 re-pointed at `bun run typecheck`, with the measured error text. A verify-it-fails step whose command cannot see the failure reports green and reads as proof |
| correction | T5 Step 0 | Step 8: add a nested `"runtimeSwitch": { … }` object under `chat` | The locale files are **flat dot-notation**. A nested object fails `lint:i18n:sorted` and is unreachable from `t('chat.runtimeSwitch.confirm')` | Nine flat keys in `en.json` + `ru.json`. `crossRuntimeCapabilities` deliberately NOT added — it interpolates T17's `capabilityDelta`, which does not exist |
| correction | T5 Step 0 | Files: create `RuntimeSwitchDialog.tsx` and `runtime-switch-copy.ts`; modify `apps/electron/src/renderer/locales/*.json`, `dto.ts:566` | `ConnectionRow.tsx` is missing from the block while Step 3's own doc-comment references it and the plan's File Structure lists it; the locales directory does not exist (the File Structure already says so); `SessionCommand` is at `:570` | Files block rewritten, plus four files the task never named: `ChatDisplay.tsx` (D1 gives T5 the marker's copy), `composer-capabilities-context.tsx` (a REQUIRED capability field must appear in the renderer default), `playground/registry/runtime-switch.tsx` (the `modelPickerSlot` seam is deleted here), and two test fixtures that build a whole `ComposerCapabilities` |
| correction | T10 Step 0 | Step 3: declare the two fields, add them to `SESSION_PERSISTENT_FIELDS`, stamp at every `managed.messages.push` | The declarations shipped in T16 (`message.ts:271/283/285/401/403`). `SESSION_PERSISTENT_FIELDS` is the session HEADER's projection — messages never pass through it; they ride `messageToStored`/`storedToPersistedMessage`, which both spread. And **the completed assistant message does not use `push`**: it goes through `insertCompletedAssistantMessage` so it can land above anything queued mid-turn | Only the stamp was built, through one helper for the 20 push sites plus a direct stamp at the assistant insert. Following the instruction literally would have left the most important row type unstamped, and every test written from the same mental model would have passed |
| correction | T10 Step 0 | Step 5's three consumers | The rewind region is about FILE checkpoints, which are session-scoped and learn nothing from message provenance. Branch ALREADY refuses on a provider mismatch (`:9995`), and a branch-POINT refusal is a new user-visible refusal. The transcript notice gets `from`/`to` directly from `switchSessionRuntime`, which is strictly more accurate than deriving them from adjacent rows | None built: one out of scope, one an owner decision, one superseded — each recorded in the task body. `RuntimeSwitchResult.from`/`to` (declared by T16, never filled) are filled instead |
| correction | T10 Step 0 | T9's tracker row records `typecheck:all` exit 0 | **It was not 0.** The command was `bun run typecheck:all 2>&1 \| tail -4; echo "EXIT=$?"` — `$?` is `tail`'s status, so the pipeline reported green over two real errors: `ISessionManager` had neither `sessionsUsingConnection` nor `listAutomationsUsingConnection` (TS2551/TS2339), which shipped in `62939879a` | Both added to `packages/server-core/src/handlers/session-manager-interface.ts` in T10's commit. **Never pipe a gate into `tail` and read `$?`** — redirect to a file and read the command's own status. This is the same class as the plan's own "a verify-it-fails step whose command cannot see the failure reports green" |
| correction | T9 Step 0 | `llm-connections.ts:532-553` is the DELETE handler; `listAutomationsUsingConnection(workspaceId, slug)`; Step 3's `throw new CodedError(...)` dropped into the handler | That region is now `SET_DEFAULT` — DELETE is at `:565`. And DELETE is `(_ctx, slug)`: no workspace, while connections are global config, so a per-workspace automation check would let a delete through that breaks another workspace. The handler also wraps its body in a `try/catch` returning `{ success:false, error }`, which would have swallowed the code before it reached the wire | Found by identifier; the reader takes `(slug)` and scans every loaded workspace; `if (error instanceof CodedError) throw error` added at the top of that catch, with a test asserting `error.code` rather than only the message |
| addition | T9 Step 0 | Files: the handler + the orphan clear + one test | The refusal is invisible: `AiSettingsPage.handleDeleteConnection` only `console.error`s, so a correctly-refused delete is a button that does nothing. And `createPromptHistoryEntry` lives in `packages/shared/src/automations/webhook-utils.ts`, with **three** prompt-history write sites, not one | Toast + two flat i18n keys in `en.json`/`ru.json` (the same code-branch shape `ChatPage` already uses); all three history writes carry `connectionFallback` |
| correction | T9 Step 0 | Step 3: announce the orphan clear with the Task 4 transcript notice | `appendRuntimeSwitchNotice` needs the runtime the session LEFT, and at the orphan clear that connection's record is already deleted — it is unknowable. The clear also runs in `loadSessionsFromDisk` at startup, where messages are lazy and no renderer is subscribed | **Not implemented, recorded.** With the DELETE refusal in place the orphan is unreachable through the product's own door; what remains is hand-edited config or an older build. Approximating the notice would have written a row stating a runtime we cannot know |
| addition | T8 Step 0 | Files: `SessionManager.ts` + `runtime-switch-session.test.ts` | `SessionManager.execution-observability.test.ts:80` builds its cleanup fixture as a bare `Object.create(SessionManager.prototype)` and hand-lists **every map `cleanup()` reads**. A new one that is not added there makes that test throw on `undefined`, which is how it surfaced: green in the task's own suite, red in the package | `manager.runtimeSwitchesInFlight = new Map()` added to the fixture. It is the only such fixture that reaches `cleanup()` — the other nine `Object.create` sites do not |
| correction | T8 Step 0 | Anchors `cleanup :21334`, `setProjectTrust :16072`, and the await site `:21347` | `:21767`, `:16418`, and the await goes at `:21770` | Corrected. Also: the plan's test omits an `await` between starting the switch and calling `cleanup()`, and without it the switch has not yet taken the boundary — **the test passes with and without the fix.** A `setProjectTrust` row has the same trap in a second form: it needs `managed.workingDirectory`, or it throws `session-project-unavailable` long before the boundary loop |
| correction | T14 Step 0 | `RPCClient.switchRuntime(sessionId:workspaceId:connectionSlug:model:)`, in both the `Produces` block and Step 3 | The wire command T5 shipped is `{ type, connectionSlug }` and nothing else (`dto.ts:614`, `rpc/sessions.ts:766`) — the owner's "two controls, not one tree" decision means no gesture picks an integration and a model together | `model:` and `workspaceId:` dropped. Settled at the wave-3 boundary before implementation |
| correction | T14 Step 0 | Files: `.../NessyAgentKit/RPC/RPCClient+SessionControl.swift`; gate `xcodebuild test -scheme NessyAgentKit -destination 'platform=iOS Simulator,name=iPhone 16'` | The directory is `Client/`, not `RPC/`. And `Package.swift` declares `.macOS(.v15)` precisely so `swift test` runs the Kit suite with no simulator — its own comment says so | Path corrected; gate is `swift test` for the Kit and `xcodebuild -scheme NessyMobile` for the app. The plan's `iPhone 16` destination is also not installed on this machine (`iPhone 17` is) |
| addition | T14 Step 0 | The picker learns its integration from `connection_changed` | A client that only listens has no value until something changes, so the integration row would open **blank on every session**. `Session` in the Kit had no `llmConnection` and `getSessionState` decoded only `messages` + `isProcessing` | Two optional fields added to `SessionMessagesEnvelope` (`llmConnection`, `composerCapabilities`) — both already ride the Session DTO that `sessions:getMessages` returns, so no new round trip. `ChatViewModel` and `RPCClient+Sessions.swift` were both missing from the Files block |
| correction | T7 Step 0 | Step 4: gate `deliverMonitorEvent` on `provider === 'pi'` | That method is the SHARED sink for five producers and three of them run on every runtime — MCP channel pushes (the pool is leased for "all backends", `:13151`), R10 detached MCP results, R86 background-task completions. The gate would have silently dropped channel pushes on Claude and Codex | Gate moved to the two Pi-owned producers (`SessionMonitorService`'s deliver callback, the cron's deliver closure) via one `deliverPiMonitorEvent` helper. A test asserting the SINK still delivers on a non-Pi provider is kept as the anti-over-gate control |
| correction | T7 Step 0 | Step 1's three tests, and "give `stopAll` its first caller" | All three measure T3, not T7: `clearRuntimeScopedSessionState` clears `goalState` (`:14958`), `stop()`s and deletes the cron service (`:14969`) and calls `sessionMonitors.stopAll` (`:14976`) — so `stopAll` already has its production caller and `session-monitor-service.ts` needs no edit. Their harness options were inert too (`provider`/`withCron`/`withWsMonitor` are not `HarnessOptions` keys) | Test list rewritten to the two gates the task actually adds, each with a negative subject, plus the sink control. The originals are struck in the task body rather than deleted. This is the outcome the Execution protocol names for T7 by name |
| correction | T7 Step 0 | Anchors `:3848` goal, `:3106` monitor delivery, `:13050` cron creation, `:16445` cron clear, `resolveManagedProvider :6602` | `:3880`, `:3138`, `:3213`, no separate clear site (it is T3's `:14969`), `:6634` | Corrected. `schedulePiGoalContinuation` also has **eight** call sites, not the six a `head`-truncated grep shows — `:19226` and `:20554` sort last and are the two that are NOT provider-gated, i.e. the whole reason the task survives |
| correction | T12 Step 0 | `Produces`: `filterAttachmentsForModelInput(…): { attachments; dropped: string[] }` — "the `dropped` half is new" | It is not new. The function already returns `omittedImages: FileAttachment[]` (`runtime-config.ts:16`) and `SessionManager.ts:17572` already maps it to names for an existing info event. What was missing is that **nothing but `pi_compat` ever reached the branch** | Signature and return shape unchanged; only the gate moved to the capability. A new `dropped: string[]` would have been a second name for a field that has three call sites and three tests |
| correction | T12 Step 0 | Step 4: widen `showVisionWarning` to the capability | That one flag ALSO renders `ImageSupportWarningBanner`'s "Enable image support" action, which writes `supportsImages: true` onto the connection's model entry. On `claude-runtime` that override changes nothing — `to-chat.ts:67` `flattenContent` keeps only parts with a string `text` — so the widened flag would have offered a button that clears the warning, re-enables the send and drops the image anyway | Split into `blocked` / `offerModelOverride` (`attachment-capability.ts`). Same class as T7's shared-sink gate: the condition was right, the surface it fed was two surfaces |
| correction | T12 Step 0 | Anchors `FreeFormInput.tsx:1868` `submitDisabled`, `SessionManager.ts:17069` info event, test file `__tests__/attachment-capability.test.ts` | `:1851` (`:1866` is the reason line, `:1868` the empty-input reason), `:17571-17579`, and the function's tests already live in `runtime-config.test.ts:140`. `runtime-config.ts:121` was exact | Corrected. Also found: `submitDisabled` never carried the vision condition, so `chat.submit.blocked.imagesUnsupported` was **unreachable copy** — Step 4 is what wires it, and `chat.imageWarning.title` ("Images will be stripped before sending") became false with it |
| correction | T12 Step 0 | Step 5: "Task 5's dialog lists them" | `RuntimeSwitchDialog` is a PRE-switch confirmation reached from `ConnectionRow.pick`, computed in the renderer from the two connection records; it never sees `RuntimeSwitchResult`, which arrives after. The plan's own Deviations log had already recorded this (2026-08-15, D4) and named `ChatPage.tsx` as T12/T13's cost | Post-switch summary built in `ChatPage.handleConnectionChange`, the callback that already toasts this operation's failures. T13/T17 extend the same surface |
| addition | T12 Step 0 | The capability gate is described as a `pi_compat` → `claude-runtime` widening | It also admits `nestor-cloud-agent`, which declares `images: 'no'`. Out of the plan's switch scope, but in scope for attachments — and the statement is true there: `nestor-cloud-agent.ts:62` takes `_attachments` and ignores them, so the omission was real and silent | Left in. The composer now refuses the send and the session raises the existing notice, on a provider where the images were being discarded without a word |
| correction | T13 Step 0 | Step 3's whole snippet: `managed.worktreeLeaseState.path`, `piWorktreeLeaseServices.get(…)` as the thing with `exit`, `port.exit({reason})` returning `{ok, reason}` | Three separate shape errors. `worktreeLeaseState` is `{schemaVersion, revision, leases[]}` — a LIST. `piWorktreeLeaseServices` holds `WorktreeLeaseService`, which has **no `exit`**; the port with `exit()` is `SessionWorktreePort` (`createSessionWorktreePort`), built on demand and stored nowhere, so it is never missing and "no port" is not a reachable `WORKTREE_EXIT_UNAVAILABLE`. `exit()` takes no argument and resolves `{path, previousWorkingDirectory} \| null` | Rewritten against the real port. `WORKTREE_EXIT_UNAVAILABLE` now fires on the case that IS reachable: the cwd is inside a lease but is not the lease root (a `/cd` into a subdirectory), which is exactly when `exit()` resolves `null` |
| correction | T13 Step 0 | Step 1's second test: "refuses when the worktree has uncommitted work" — implying a new dirtiness check | **The refusal already exists.** `worktree-lease-service.ts:releaseUnlocked` inspects (`git status --porcelain`) and throws `WorktreeLeaseError('worktree-dirty', […])`, which the drain wraps as `pi-session-drain-failed:runtime switch (…)`. The behaviour was right and the ERROR was unusable | `WORKTREE_DIRTY` implemented as a re-code of the existing refusal (`findWorktreeDirtyResidual` walks `cause` + `AggregateError` for the structured residual `code`, never message text). A second `git status` would have been a duplicate of a rule that already runs |
| correction | T13 Step 0 | Step 4: "Task 5's dialog lists them by agent name" | Same pre-switch/post-switch problem T12 recorded — the dialog cannot see `RuntimeSwitchResult` | Added to the post-switch summary T12 built in `ChatPage.handleConnectionChange`, with the two new refusal codes. `PiChildSessionRecordV1.agent` is the agent NAME (`agentId` is the instance id), so "by agent name" resolves to `agent` |
| addition | T13 Step 0 | Files: `SessionManager.ts` + the one test file | The two coded refusals are invisible without a renderer branch: `handleConnectionChange` mapped every non-`SESSION_BUSY` error to the generic `chat.runtimeSwitch.failed`, so a dirty worktree would have read as "could not switch integration" | Two flat i18n keys per locale plus the `stoppedChildren` plural set (ru needs `_few`/`_many`), in the same code-branch shape T5 shipped |
| correction | T17 Step 0 | Step 1/Step 3: `view.components.filter(c => c.kind === 'monitor' && c.enabled)`, and `off.view.components.find(…)?.unavailableReason` | `AgentRuntimeView` has **no `components`** — it carries typed lists (`monitors`, `lspServers`, `hooks`, …) — and **no `unavailableReason`**: that field lives on `ResolvedCapabilityEntry.summary`, i.e. the CATALOGUE, which is a different view built by `toUserCatalog`. Nor is there an `enabled` flag to filter on: `toAgentRuntime` already drops everything `isRunnable` refuses, `unsupported-runtime` included | Delta reads the typed lists (`monitorId`, `lspId`, `hook.type`); the `unavailableReason` assertions moved to `resolver.test.ts`, beside the agent gate's own rows, where that field exists |
| correction | T17 Step 0 | The opening: "three of its five hook kinds fire and do nothing", listing `agent`/`mcp_tool`/`http` | **Four.** `SessionManager.ts:12827` supplies `pluginCommandHookRunner` unconditionally and the other four — `prompt`, `agent`, `mcp_tool`, `http` — only under `provider === 'pi'`; `hooks-automation.ts:786-831` skips an action whose runner is absent. `prompt` was missed | Delta reports four kinds. The count in the task body is corrected rather than the code narrowed to match a wrong number |
| correction | T17 Step 0 | Step 4: widen the gate "reading the same shared constant the session path reads — that is what `runtime-agent-support.ts` exists for" | The constant that module exports is `AGENT_DEFINITION_RUNTIMES` = `{pi, anthropic, codex-runtime}`. Reusing it for peripherals would have declared LSP and monitors **supported on Claude and Codex** — the exact lie the task exists to remove, inverted | New `PLUGIN_PERIPHERAL_RUNTIMES` = `{pi}` + `runtimeRunsPluginPeripherals` in the same module, and the three session-path wirings (`:13153`, `:13164`, `:14854`) now read it too. The module's stated purpose is a single set with two readers; a second set is what that purpose calls for here, not a second condition |
| correction | T17 Step 0 | `Produces`: `CapabilityDelta` includes `unavailableSources: string[]`, filled by `(managed.enabledSourceSlugs ?? []).filter(slug => isDpAuthenticatedSource(slug, managed))` | `isDpAuthenticatedSource` does not exist, and the input is a category error: a dp-authenticated capability is a plugin-bundled MCP **server** whose resolved executable reports `externalAuthProvider === 'dp'` (`runtime-pool-servers.ts:641`), not a user source with a slug. The only honest reader is `materializeRuntime`'s `externalAuthRequirements` — async, and needs the MCP pool lease | **Not built**, field dropped from the type rather than declared and left empty (T10's lesson). The underlying defect — `preflightDpAuth` hard-returning `'unavailable'` off Pi — is already Deferred fix-list row 5 |
| addition | T17 Step 0 | Step 5: "Thread the turn provider through. Both call sites already have the provider in scope" | True, with a nuance worth writing down: the view site has `provider` as a local, but `skillSlashCommands(snapshot, reservedNames)` does not — it reads `snapshot.context.provider`, the field the resolver pinned that snapshot to, so no signature moves | Used `snapshot.context.provider`. Also: an UNDEFINED provider must KEEP the skill, or a workspace-scoped read would remove it on the strength of a runtime nobody has chosen |
| addition | T5 Step 0 | — | `ComposerCapabilities.connection` is a REQUIRED field, so every literal that builds the interface must supply it: `DEFAULT_COMPOSER_CAPABILITIES` (defaults to `switchable: false` — a composer with no capabilities yet must not offer a switch it cannot know is legal) and the `composer-permission-modes` test fixture | Both updated; `typecheck:all` is the gate that finds them |
| correction | T11 Step 0 | Files/`Modify`: `SessionManager.ts:8459` for `applyContextUsageSnapshot` | The method is at `:8583`. The BEHAVIOUR claim the anchor carries — "it also writes `tokenUsage.contextWindow`, so clearing only `managed.contextUsage` leaves the old runtime's window dividing the new runtime's tokens" — is exactly right, and is what the task's control now measures | Number corrected. The identifier held, the coordinate did not — the shape this plan's anchor rule predicts |
| correction | T11 Step 0 | Step 1's three snippets: `await createSwitchHarness({ provider: 'pi' })`, `runOneTurn(manager, managed, {inputTokens})`, `windowOf(slug)`, `capabilitiesFor(managed)`, `thresholdKindOf(slug)`, and a `'llm-proxy'` target | None of the five helpers exists, `createSwitchHarness` is synchronous and takes `{ from }`, and `'llm-proxy'` is not a fixture slug. The production seams that do exist: `processEvent(managed, { type: 'usage_update', usage })` — the chat loop's own entry point, used the same way by `context-usage-turn-persistence.test.ts` — and `setEventSink` + `sendCapabilitiesChanged` for the capability | Rewritten against the real seams. The three PROPERTIES are unchanged, so this is coordinates, not approach |
| correction | T11 Step 0 | Step 1's third row assumes a same-runtime connection change re-reads the window at the switch | `clearRuntimeScopedSessionState` is called only on the `connection-cross-runtime` branch (`SessionManager.ts:15107`), so the source's window survives the switch itself and is replaced by the target's first turn. The assertion the row wanted (the window is the target's after a turn) does hold | Both halves asserted — the transient AND the heal — so a later change to the transient is visible as a change. **Not fixed**: bounded by the next turn, identical to the existing model-change path, and clearing it is a new user-visible behaviour this plan's escalation rule sends to the owner |
| correction | T11 Step 0 | `clearRuntimeScopedSessionState`'s own comment cites `applyContextUsageSnapshot (:8480)` | It is `:8583` — the comment's coordinate drifted with the method | **Left as-is on purpose.** T11's success condition is green with no production change; a stale comment coordinate does not justify a diff against a verification. Recorded here for the next editor of that block |

### Deferred fix-list

Between "the plan described this wrongly" and "this needs its own task" sits the most common thing an executor actually finds: a small, real, out-of-scope defect noticed while reading code for something else. A stale comment, a wrong error string, a guard on the wrong side of a condition. Folding it into the current task quietly widens that task's diff and its review; carrying it in someone's head loses it.

It goes on this list instead.

**What may go on the list.** Anything with a `file:line` and a one-line statement of what is wrong. Nothing else. "This area feels fragile" is not an item — an item a later reader cannot act on without re-deriving it is worse than no item, because it looks like coverage.

**What may NOT go on the list.** Anything that blocks the task in hand. If the current task cannot land correctly without it, it is not deferred — it is fixed now, inside that task, and named in the task's tracker note. The list is for work that is genuinely separable, not for work that is inconvenient.

**When it is swept.** Two named gates, never "eventually":

1. **Before Task 15.** A live run against real credentials is expensive and its evidence is only as good as the build under it. Anything on the list that could make a live case report the wrong thing is resolved first. This is the gate that matters.
2. **At Task 6 close-out.** Everything remaining gets a disposition.

**Every item ends with one of four dispositions**, recorded in its row — never left blank:

- **fixed** — with the commit.
- **promoted** — became task T16/T17/…, with the number.
- **decision** — intended behaviour after all; the reason is written down, because in this repo a plan is where a decision's reason lives.
- **dropped** — no longer reproduces, with what changed.

| # | Found by | File:line | What is wrong | Disposition |
| --- | --- | --- | --- | --- |
| 1 | capability audit | `codex-agent.ts:515-558` | No `appendPluginBinPath`; a plugin's bundled `bin/` is not on PATH, so a skill invoking its own executable fails with "command not found" on Codex | |
| 2 | capability audit | `SessionManager.ts:1010`, `:19725`, `pre-tool-use.ts:858` | The literal `session` is hard-coded; Codex mounted the bundled server as `nessy_session`, so its rows lost labels, icons and two interceptions. **Re-check at the sweep against the ROLLOUT shape, not the wire:** 1.26.1 unified the model-facing wire name, but Codex still *stores* the call split as `{"name":"config_validate","namespace":"mcp__session"}`, and the emitted config.toml carries `[mcp_servers.session]`. Read `scripts/cdp/cases/session-tool-wire-parity.ts` (`85d7f9326`) first — it is the cheapest evidence and it nearly mis-measured this itself | |
| 3 | capability audit | `permission-dsl.ts:737-741` | The mcp matcher splits on `__` with no bridge shift, so `deny: mcp__prod-db__*` does not match Codex's `mcp__sources__prod-db__query` | |
| 4 | capability audit | `capabilities/mcp-wire-name.ts` | `session` / `nessy_session` / `sources` / `workspace` are not reserved; a source named `session` overwrites Nessy's own tools on Claude. Same sweep note as row 2 — check the rollout's stored pair, not only the wire | |
| 5 | capability audit | `SessionManager.ts:8975` | `preflightDpAuth` hard-returns `'unavailable'` off Pi, so a dp-authenticated source stays checked while its tools silently vanish | |

### When a task must be ADDED mid-execution

A pre-flight will sometimes find not a wrong line number but missing work — a prerequisite nobody saw, or a defect uncovered by the previous task's diff. That is expected on a plan this size and the protocol handles it explicitly rather than leaving it to judgement.

**First decide whether it is a task at all.** Fold it into the current task when the work is required for that task's own deliverable and stays inside its blast radius — then say so in the task's tracker note. Give it its own task when a reviewer could meaningfully accept one and reject the other, or when it needs its own test cycle. That is the same right-sizing rule the plan was written under; discovering work mid-flight does not change it.

**Numbers are permanent.** A new task takes the next free number — T16, T17 — no matter where it runs in the order. **Never renumber and never reuse a number**: the `Consumes` blocks reference tasks by number (`(Task 3)`), the tracker notes reference them, and the Corrections log references them. Renumbering silently invalidates every one of those pointers, and nothing would fail loudly.

**Order is data, not numbering.** The execution order is the Order row below the tracker, and it is the only authority on what runs when. A task added late can and often will run early.

**A new task carries the same shape as every other one**, with two extra lines in its opening paragraph: which task's Step 0 found it, and what it unblocks. Without those a later reader cannot tell a discovered prerequisite from scope creep.

**Who authorises it.** A prerequisite discovered in the code — something that must be true for a planned task to land — is added by the executor and recorded. Anything that widens the product surface (a new control, a new setting, a new user-visible behaviour) stops and asks the owner, even when it looks small. The line is: does a user see something they did not before?

**Removing a task.** Never delete one. A task whose reason evaporated is marked `⏸ superseded` with the reason and the task that made it unnecessary. In this repo a plan is where a decision's reason lives, and a deleted task deletes the record that the decision was ever made.

**After any addition or removal, three things must agree** — and the next task's Step 0 checks that they still do:

1. The task sections in the body.
2. The tracker rows.
3. The Order row.

### Order

Authoritative execution order. Update this row whenever a task is added, moved or superseded.

`T1 ‖ T2 ‖ T16 → T3 → T4 ‖ T5 → T7 ‖ T14 → T8 → T9 → T10 → T12 → T13 → T17 → T11 → T15 → T18 → T19 → T6`

Tasks joined by `‖` share a wave and may run concurrently; `→` is a hard boundary. The waves, the file collisions that produce them and the rules for concurrent agents are in the section below.

---

## Parallelisation

*Written 2026-08-14 against `717a4e039`. Every file claim below was checked on that tree with `grep -a`/`rg -a`, not taken from the task blocks — several task blocks under-declare their files, and that is the whole risk this section manages.*

### 1. The verdict

**Almost none of it parallelises: sixteen tasks (fifteen planned plus one addition, T16) run in twelve waves, with exactly three genuine pairs — T1 ‖ T2 ‖ T16, T4 ‖ T5, T7 ‖ T14 — and everything after wave 4 is a strict serial chain.**

### 2. The bottleneck

AGENTS.md: *"`git commit <pathspec>` takes the file's WORKING-TREE state, not your hunks… Zone parallel work **by file**, not by subsystem."* Two tasks may share a wave only when their **file sets are disjoint**. Logical independence buys nothing.

| File | Tasks that touch it | Effect |
| --- | --- | --- |
| `packages/server-core/src/sessions/SessionManager.ts` (21 466 lines) | **10** — T2 T3 T4 T7 T8 T9 T10 T11 T12 T13 | This file *is* the schedule. It forces waves 5–10 to be one task each. |
| `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts` | 6 — T3 (creates) T4 T7 T8 T11 T13 | Costs nothing extra: all six already collide on `SessionManager.ts`. |
| `packages/shared/src/protocol/dto.ts` | 4 — T4 (see below) T5 T10 T11 | Resolved by T16; see §7. |
| `packages/shared/src/protocol/types.ts` | 3 — T3 T9 T13, **declared by none of them** | `ErrorCode` (`:100`) and `KNOWN_ERROR_CODES` (`:102`) are a closed union + mirror set; T3 throws `SESSION_BUSY`/`CONNECTION_NOT_SWITCHABLE`, T9 `CONNECTION_IN_USE`, T13 `WORKTREE_DIRTY`/`WORKTREE_EXIT_UNAVAILABLE`, and `CodedError`'s constructor (`:137`) is typed `ErrorCode`. None of the five exists today. Resolved by T16. |
| `packages/core/src/types/message.ts` | 3 — T10 T11 (+T4 if it uses a new role) | T10 widens `Message`/`StoredMessage`, T11 needs `ContextUsageSnapshot.source` (`:640`, closed) to admit `'derived'`. Neither Files block names the overlap. Resolved by T16. |
| `packages/shared/src/i18n/locales/{en,ru}.json` | 3 — T5 T12 T13 | **The plan's File Structure row (`apps/electron/src/renderer/locales/*.json`) points at a directory that does not exist.** Correct path is `packages/shared/src/i18n/locales/`. All three already collide elsewhere. |
| `apps/electron/.../app-shell/input/FreeFormInput.tsx` | 3 — T5 T12 T13 (+ an uncommitted working-tree edit, see Wave 0) | |
| `packages/shared/src/sessions/types.ts` | 3 — T2 T4 T10 | |
| `apps/electron/src/shared/types.ts:408` | 3 — T5 T12 T13, **declared by none of them** | `sessionCommand`'s return type is a hand-written closed union that does not contain `RuntimeSwitchResult`, so T5's handler cannot read the result T12 and T13 both add fields to. It is *not* covered by the `export * from '@nessy-agent/shared/protocol'` on line 4. Resolved by T16. |

### 3. The waves

Gates below are the **wave-boundary** gates, run by the orchestrator with every agent idle. Per-task gates stay as written in each task, minus the repo-wide commands (see §5).

| Wave | Tasks | Why disjoint | Wave gate |
| --- | --- | --- | --- |
| **0** | orchestrator only | — | tree clean; four decisions recorded (below) |
| **1** | **T1 ‖ T2 ‖ T16** | T1 = `codex-agent.ts` + `__tests__/codex-model-switch.test.ts`. T2 = `sessions/runtime-anchors.*`, `shared/sessions/{types,index}.ts`, `SessionManager.ts`, `__tests__/runtime-anchor-scope.test.ts`. T16 = `protocol/{dto,types}.ts`, `protocol/runtime-switch.ts` (new), `core/types/message.ts`, `apps/electron/src/shared/types.ts`, `renderer/event-processor/{types.ts,processor.ts,handlers/session.ts}`. No file appears twice. None consumes another. | `bun run typecheck:all`, `bun run lint`, path-scoped suites of all three |
| **2** | **T3** | Consumes T2's `readRuntimeAnchor`/`writeRuntimeAnchor` *and* shares `SessionManager.ts` with it. Nothing can join: every remaining task either consumes T3 or touches `SessionManager.ts`, and T14 consumes T5. Widest diff in the plan (538 lines of spec). | `typecheck:all`, `bun test packages/server-core/src/sessions` |
| **3** | **T4 ‖ T5** | Both consume T3 only. Disjoint **because T16 landed** `message_added`, the error codes, `RuntimeSwitchKind`/`RuntimeSwitchResult` and the `sessionCommand` return widening — without T16 they collide head-on in `dto.ts` and `apps/electron/src/renderer`. T4 = `shared/agent/runtime-handoff.ts` + test, `base-agent.ts`, `agent/backend/types.ts`, `shared/sessions/types.ts`, `SessionManager.ts`, `runtime-switch-session.test.ts`. T5 = `dto.ts`, `agent/backend/composer-capabilities.ts`, `handlers/rpc/sessions.ts`, `handlers/session-manager-interface.ts`, `renderer/.../input/*`, `ChatPage.tsx`, both locale files. | `typecheck:all`, `lint:i18n:parity`, `lint:i18n:sorted`, both task suites |
| **4** | **T7 ‖ T14** | The one free pair in the original plan. T14 is Swift under `apps/ios/` only, built with `xcodebuild`; it shares no TypeScript file, no locale file, no `SessionManager.ts`, and does not run `bun test` at all. T14 may float to any wave ≥ 4. | `typecheck:all`; `xcodebuild test` for T14 |
| **5** | **T8** | `SessionManager.ts` | `bun test packages/server-core/src/sessions` |
| **6** | **T9** | `SessionManager.ts` | same |
| **7** | **T10** | `SessionManager.ts` | same + `bun test packages/shared/src/sessions` |
| **8** | **T11** | `SessionManager.ts` | same |
| **9** | **T12** | `SessionManager.ts` chain + `FreeFormInput.tsx` + locales | same + renderer input suite + i18n lints |
| **10** | **T13** | `SessionManager.ts` chain + `RuntimeSwitchDialog.tsx` + locales | same |
| **11** | **T15** | **Exclusive machine.** `rm -rf release`, packaged dmg, eight live CDP cases on real credentials. No other agent may run a root-level `bun test` (the `release/**/Resources/app/src/` collection trap) and no source edit may be in flight. | the eight live rows, recorded verbatim |
| **12** | **T6** | **Exclusive machine.** Full regression **compared against `master`, not against this branch's base**, version bump, release notes, docs-site + `ru/` twins, regenerated parity report and deviation register. Shares `docs/testing/cdp-live-checklist.md` with T15. | the full command list in T6 Step 1 |

#### Wave 0 — must complete before any agent is dispatched

**Tree hygiene.** `git status` on `717a4e039` is dirty with another plan's close-out already in flight: `package.json` and `apps/electron/package.json` are bumped to `1.26.0`, `apps/electron/resources/release-notes/1.26.0.md` is untracked, `docs-site/content/{,ru/}reference/config/custom-endpoint.md` are modified, and `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` (+24/−3), `apps/electron/src/renderer/playground/registry/index.ts` (+2) and the untracked `playground/registry/runtime-switch.tsx` are the `modelPickerSlot` design seam T5 deletes. Commit or stash all of it. **T6 must not bump onto an uncommitted bump.**

**Four decisions.** Each changes a file set, so none can be settled by an agent inside a wave without crossing another:

- **D1 — the switch notice's role.** T4 Step 6 writes `role: 'system'`. `MessageRole` (`packages/core/src/types/message.ts:10-19`) is `user|assistant|tool|error|status|info|warning|plan|auth-request` — there is no `'system'`. **Decision: `role: 'info'`, content `runtime_switched:<from>:<to>` as a machine-readable marker.** T4 therefore does not touch `core/types/message.ts`, and rendering the marker into human copy is T5's, which already owns the renderer and both locale files.
- **D2 — the transcript event.** `rg -a --hidden "message_added"` returns **one hit in the entire repo: plan line 1602.** `sendEvent` (`SessionManager.ts:20442`) is typed `SessionEvent`, a closed union at `dto.ts:361-465`. **Decision: T16 adds the union member and the renderer case.** Note for the reviewer: the renderer's exhaustive check is over its *own* mirror union (`event-processor/types.ts:227`) and `App.tsx:973` double-casts (`event as unknown as AgentEvent`), so a `dto.ts`-only addition would compile green and the notice would silently land in `processor.ts`'s `default:` arm forever. T16 carries a renderer test for exactly that.
- **D3 — where `RuntimeSwitchKind` lives.** T3 declares it in `packages/server-core/src/sessions/runtime-switch.ts` (plan `:920`); T5's renderer imports it from `@nessy-agent/shared/protocol` (plan `:1878`). The renderer cannot import server-core. **Decision: `RuntimeSwitchKind`, `RuntimeSwitchResult` and `classifyRuntimeSwitch` live in `packages/shared/src/protocol/runtime-switch.ts`** — T16 lands the two types, T3 lands the classifier there and keeps the renormalizers in server-core.
- **D4 — the dialog is pre-flight *and* post-flight.** T5 Step 9 fires the dialog **before** the command. T12 Step 5 and T13 Step 4 both put fields on `RuntimeSwitchResult` — a value that only exists **after** the switch — and say "Task 5's dialog lists them". **Decision: T5 builds both surfaces in wave 3** (a pre-flight confirmation and a post-switch summary fed by the widened `sessionCommand` return). Otherwise T12 and T13 acquire `RuntimeSwitchDialog.tsx`, `ChatPage.tsx`, `apps/electron/src/shared/types.ts` and both locale files in waves 9–10, which is a much larger diff than either task advertises.

Two further Wave-0 notes, recorded so an executor does not rediscover them mid-wave:

- Plan line 1913 tells T5 to use `@/components/ui/alert-dialog`. **That component does not exist** — `components/ui/` has `dialog.tsx`, `drawer.tsx`, `context-menu.tsx`; the only `alert-dialog` string in the whole renderer is a CSS token in `index.css`. T5 builds on `dialog.tsx`.
- T13 Step 3 calls `port.exit({ reason })`. `WorktreeLeaseService` (`packages/server-core/src/pi-harness/worktree-lease-service.ts:80`) exposes `list / touch / sweepOrphans / acquire / recover / release` — **there is no `exit`, and no `SessionWorktreePort` in `SessionManager.ts`.** T13's Step 0 rewrites Step 3 against `release(worktreeLeaseId)` plus an explicit cwd restore, and records it in the Corrections log.

### 4. What stays serial, and the file that pins it

| Task | Pinned by |
| --- | --- |
| T1 | nothing — free in wave 1 (`codex-agent.ts` is touched by no other task; `base-agent.ts` is T4's, and T1 does **not** need it: `packages/shared/src/agent/backend/types.ts:1134` declares `updateRuntimeConfig` optional on the interface and `pi-agent.ts:7510` is the precedent with no `override`) |
| T2 | `SessionManager.ts` — pins everything after it |
| T16 | nothing — free in wave 1 |
| T3 | `SessionManager.ts` (T2) **+** consumes `readRuntimeAnchor`/`writeRuntimeAnchor` |
| T4 | `SessionManager.ts` (T3) + consumes `RuntimeSwitchResult.contextCarried` |
| T5 | consumes `switchSessionRuntime` (T3); pinned against T12/T13 by `FreeFormInput.tsx` and the locale files |
| T7 | `SessionManager.ts` (`:3848`, `:3106`, `:13050`, `:16445`) |
| T8 | `SessionManager.ts` (`cleanup` `:21334`, `setProjectTrust` `:16072`) |
| T9 | `SessionManager.ts:8379-8386` + consumes `appendRuntimeSwitchNotice` (T4) |
| T10 | `SessionManager.ts` (message write sites) + `shared/sessions/types.ts` |
| T11 | `SessionManager.ts:8459` + `core/types/message.ts` (T10) + consumes T3's cleared `contextUsage` |
| T12 | `SessionManager.ts` + `FreeFormInput.tsx` (T5) + locales |
| T13 | `SessionManager.ts` + `RuntimeSwitchDialog.tsx` (T5) + locales |
| T14 | consumes T5's `switchRuntime` command — **free from wave 4 onward**, pinned by nothing else |
| T15 | exclusive machine: `rm -rf release`, packaged build, real credentials |
| T6 | consumes T15's green verdict; exclusive machine; shares `cdp-live-checklist.md` with T15 |

**T14 carries a contract mismatch that must be settled in wave 3, not discovered in wave 4.** T14's Produces declares `RPCClient.switchRuntime(sessionId:workspaceId:connectionSlug:model:)`, but T5's command is `{ type: 'switchRuntime'; connectionSlug: string }` and T3 hard-assigns `managed.model = target.defaultModel`. Desktop recovers the user's tapped model with a *second* call (`onModelChange` → `setSessionModel`); T14 Step 4 explicitly forbids that second call. As written, the same gesture lands on the tapped model on desktop and the connection's default on iOS. Either T5 widens the command to carry an optional `model` and T3 honours it, or T14 is rewritten — decide at wave 3's boundary.

**Settled at wave 3's boundary, 2026-08-15 (T5): the command stays `{ type: 'switchRuntime'; connectionSlug: string }`, and T14 is the side that changes.** The mismatch was a consequence of the single-tree picker, and that tree is gone. There is no longer a gesture that picks an integration and a model together: the model list shows only the ACTIVE integration's models, so changing integration is one gesture that carries no model, and choosing a model inside the new integration is a separate one. Desktop therefore makes no "second call to recover the tapped model" — there is no tapped model to recover — and T14's prohibition is satisfied by copying the two-gesture flow rather than by widening the command. Widening it would re-create exactly the conflation the owner's "two controls, not one tree" decision removed. **T14's Step 4 and its `RPCClient` signature must be rewritten at ITS Step 0**; drop the `model:` parameter.

**T7 is rescoped at Step 0, not superseded.** Its three declared "Expected: FAIL" tests are already green once T3 lands: `clearRuntimeScopedSessionState` sets `managed.goalState = undefined`, calls `piCronServices.get(key)?.stop()`, and calls `sessionMonitors.stopAll(...)`. Also `SessionCronService` has **no `isRunning()`** (`start/stop/list/create/…` only), and the Files line "give `stopAll` its first caller" is stale — T3 gives it that caller. What survives is real and belongs to T7: the provider gates at `schedulePiGoalContinuation` (`:3848`) and `deliverMonitorEvent` (`:3106`), and the cron creation/clear gates (`:13050`, `:16445`), which stop a `/loop` created *after* the session has left Pi. **T7 rewrites its own test list at Step 0 and records it in the Corrections log.** One of the three, the monitor assertion, would flake as written regardless: T3's `stopAll` is fire-and-forget (`void`), so `monitors.list(...)` is racing `retire()`.

### 5. Test-run rule for concurrent agents — instructions

1. **During a wave, never run a repo-wide command.** No bare `bun test`, no `bun run typecheck:all`, no `bun run lint`, no `validate:ci`. All of them read the entire working tree, including the other agent's half-finished edits, and a red gate caused by your wave-mate is indistinguishable from your own bug. Concrete: `packages/shared/src/sessions/storage.ts:56` re-exports `SessionConfig`, `agent/backend/types.ts:31` imports it, and `codex-agent.ts:65` imports `sessions/storage.ts` — so in wave 1, T1's typecheck compiles T2's in-flight `sessions/types.ts`.
2. **Run only path-scoped suites during a wave**: `bun test <explicit paths>`. Repo-wide typecheck/lint/i18n are wave-boundary gates, run by the orchestrator with every agent idle.
3. **`rm -rf release` before any root-level `bun test`.** A packaged build leaves the renderer sources at `release/**/Resources/app/src/` and the root run collects them: measured 12 928 tests / 14 phantom failures with it present, 11 464 / 4 without.
4. **Two agents in one wave must not both run a `packages/server-core/src/sessions` suite.** This schedule never asks them to — verify it still holds before adding a task to a wave. (For the record: `bunfig.toml`'s preload `packages/shared/tests/setup/isolate-shared-config-dir.ts:37-39` gives each test **process** its own `mkdtemp` `NESSY_CONFIG_DIR`, and the three module-scope mutators in `sessions/` — `queue-ops.test.ts:7`, `worktree-floor-approval.test.ts:44`, `permission-remember.test.ts:44` — all assign `mkdtemp` paths too. The classic hazard is in-process load order, not cross-process. **Keep the rule anyway**: it costs nothing here and the next suite added may not use `mkdtemp`.)
5. **Fixed `/tmp` roots are the real cross-process hazard, and one is in wave 1.** `packages/shared/src/agent/__tests__/codex-agent-lifecycle-hooks.test.ts:13-22` uses `/tmp/ws-root`, `/tmp/nessy-general-agent-test-sessions/ws-test`, `/tmp/project-root`. Nothing in T2's or T16's run list writes there, so wave 1 is safe — but before pairing any two tasks in future, grep both run lists for fixed `/tmp` paths.
6. **A failed focused check blocks the commit.** Do not defer it to the wave gate.
7. **Units inside a wave perform NO git writes at all** — no `add`, no `commit`, no `stash`. They edit, they run their path-scoped tests, and they return their file list; the orchestrator commits each task separately once the wave is idle.

   *This closes a gap in the analysis above.* §2 proves the file sets are disjoint, which makes `git commit <pathspec>` safe against **crossed content** — but disjointness says nothing about three concurrent `git commit` invocations racing `.git/index.lock`. That is a different failure with the same blast radius, and no amount of file zoning prevents it. Serialising the commits after the wave removes it for free and costs nothing, because the expensive part — reading, editing, testing — is what ran in parallel. Approved as a standing deviation 2026-08-15.

### 6. Tracker rule — instructions

**Parallel agents must not touch `docs/superpowers/plans/2026-08-14-session-runtime-switching.md`.** Every one of the sixteen tasks would otherwise stage it to write a Tracker row, a Corrections-log row or a Deferred-fix row, which makes it a shared file for *every* pair and is not zonable.

1. Delete `docs/superpowers/plans/2026-08-14-session-runtime-switching.md` from the `git add` line of every task before dispatch. It appears in all sixteen.
2. Each agent returns, as **text in its final message**, three blocks: its Tracker row (status glyph, commit sha, note), its Corrections-log rows, its Deferred-fix-list rows.
3. The **orchestrator** writes those rows into the plan and commits the plan file itself at the wave boundary, with no agent running. It also commits each unit's own files, one commit per task, in task order — see §5 rule 7 for why the units do not do this themselves. That commit also re-checks that the task sections, the tracker rows and the **Order** row still name the same set of tasks.
4. **No directory pathspecs in any `git add`.** A directory pathspec sweeps whatever a wave-mate has uncommitted underneath it. The tasks that currently use one, all of which must be rewritten to an explicit file list: T5 (`packages/server-core/src/handlers`, `apps/electron/src/renderer`), T7, T8, T9, T13 (`packages/server-core/src/sessions`), T10 (`packages/shared/src/sessions packages/server-core/src/sessions`), T11 (`packages/shared/src/agent packages/server-core/src/sessions`), T12 (`.../input`, `__tests__`), T14 (`apps/ios`), T15 (`scripts/cdp/cases`), T6 (`docs-site docs/superpowers`).
5. **T15's pathspec also *misses* a required file.** `scripts/cdp/run.ts:20` holds a hand-maintained closed `CASES` array; the eight `rts-*` cases must be registered there, and `scripts/cdp/cases` does not cover it. Note that `run.ts` already ships `'RUN-MARKS'` and `'PLATE-GUTTER'` while `scripts/cdp/cases/run-marks.ts` is untracked — another plan's in-flight state.
6. **T6's `git add` must name files, never `docs-site` or `docs/superpowers`** — the tree already carries a second session's `docs-site` edits.

### 7. Splits and additions

**Worth it — T16, "the shared wire surface" (an ADDITION, not a split).** Under the plan's own addition protocol it takes the next free number, keeps it forever, and runs in wave 1. It lands, in one commit and with no other consumer:

- `packages/shared/src/protocol/dto.ts` — `SessionEvent | { type: 'message_added'; sessionId: string; message: Message }`.
- `packages/shared/src/protocol/types.ts` — `SESSION_BUSY`, `CONNECTION_NOT_SWITCHABLE`, `CONNECTION_IN_USE`, `WORKTREE_EXIT_UNAVAILABLE`, `WORKTREE_DIRTY` in **both** `ErrorCode` (`:100`) and `KNOWN_ERROR_CODES` (`:102`).
- `packages/shared/src/protocol/runtime-switch.ts` (new) — `RuntimeSwitchKind`, `RuntimeSwitchResult` (per D3).
- `packages/core/src/types/message.ts` — `Message.runtime?` / `Message.llmConnection?` on `Message` and `StoredMessage`; `'derived'` on `ContextUsageSnapshot.source`.
- `apps/electron/src/shared/types.ts:408` — `sessionCommand`'s return union gains `RuntimeSwitchResult`.
- `renderer/event-processor/{types.ts, processor.ts, handlers/session.ts}` + one test — the `message_added` case that appends `event.message` to `session.messages`.

**Cost:** one extra commit whose declarations have no consumers yet. Every addition is a new union member or an optional field, so `typecheck:all` stays green and nothing behaves differently except the renderer handler, which is tested. **Benefit:** it is required work regardless (T4 cannot compile without the event, T3/T9/T13 cannot throw their errors, T5 cannot import `RuntimeSwitchKind`, T12/T13 cannot read their own results), and it is the **only** thing that keeps T4 ‖ T5 legal — without it the schedule is thirteen waves, not twelve.

**Worth it — merge T8 into T3. Saves one wave (12 → 11).** T8 is two files and roughly twenty lines: a `runtimeSwitchesInFlight: Map<string, Promise<unknown>>`, an await in `cleanup()` (`:21334`) and a guard in `setProjectTrust` (`:16023`). No public API (`session-manager-interface.ts` is untouched), no DTO, no locale key. It is a wave of its own purely because of `SessionManager.ts`, and no reviewer would accept T3 and reject T8. Stronger reason to merge: T3 passes `boundaryHeld = true` into `strictDrainSessionForMutation` without ever calling `acquireSessionMutationBoundary`, so `releaseBoundary` is `undefined` (`:10328`, `:10355`) and `projectMutationSessions` stays empty for the whole switch — T8's map exists only to compensate. The correct fix is a boundary acquisition inside T3, not a second tracking mechanism a wave later.

**Owner's call — merge T10 into T11. Would save a second wave (11 → 10).** They share `core/types/message.ts`, `dto.ts` and `SessionManager.ts` — three of T10's five files. But they are genuinely separable to a reviewer (per-message provenance vs. context-meter derivation), and merged they produce one diff spanning core types, shared config, both agent backends and `SessionManager.ts`. Propose it; do not do it unilaterally, and if you do, record it under the addition protocol.

**Not worth it — splitting `SessionManager.ts`.** 21 466 lines, ten tasks, 37 references in this plan. Splitting it is a larger and riskier change than the feature.

**Not worth it — a wider type-only micro-task than T16.** Pulling `dto.ts`/`types.ts`/`message.ts` out of T9, T10, T11 and T13 as well changes the wave count by **zero**: all four still collide on `SessionManager.ts`. T16 is scoped to exactly the additions that unblock a pair or that no task declares an owner for.

### 8. Honest speedup

Sixteen tasks in twelve waves — four waves saved, three of them from the three pairs and one from T16 riding free in wave 1. Measured against the plan as written (fifteen serial tasks), the saving is **three waves**. By plan-section length that looks like ~25 %; **by wall clock it is 15–20 %**, because the two longest-running items are T15 (packaged dmg plus eight live CDP cases on real credentials) and T6 (full regression against `master`) — both strictly serial, both needing an exclusive machine, and both among the shortest sections in this document. The one wave that is free without qualification, T7 ‖ T14, is free only because T14 is a different language against a different build system.

If schedule matters more than review granularity, the highest-leverage move is not more parallelism. It is merging T8 into T3 — and, if the owner agrees, T10 into T11 — so the `SessionManager.ts` chain is six links instead of eight.

### The tracker note contract — what a row must carry

**Owner's addition, 2026-08-15, verbatim:** «как он сделает план — ты проверь его выполнение и если будут баги — нужно будет отправить ему что б исправил».

The close-out is not the end. An independent pass then checks what actually landed — tracker claims read against the code they cite, gates re-run where cheap, live evidence spot-checked — and anything it finds comes back here to fix. That pass is the last thing standing between a defect and the owner's time, so every row is written to be *checkable by someone who does not trust it*.

**A note carries evidence, not a verdict.** A row that says "works", "done", "fixed" is unverifiable and will be sent back on that alone. AGENTS.md already demands this — "run the gate command that proves it and record real output" — and this makes the shape explicit:

- **The number measured**, not the adjective. `contextWindow 262144 → 128000` beats "the window updates".
- **The file it was read from.** Which artifact produced the number: the session's `.pi-sessions/*.jsonl`, the live `CODEX_HOME/config.toml`, the test's own output.
- **The control that ruled the alternative out.** The half most rows skip. A gate that fires is not proof the gate works — proof is that it fired *and* stayed quiet on the negative case. Without a control, a test that disables everything passes exactly like a test that gates correctly.
- **For anything proven live: the case name and the commit.** So the pass can re-read the same source instead of re-running the rig — the rig is where the cost and the doubt both live.

**Three control shapes, so a control costs one run rather than a second test.** Pick whichever fits; do not invent a fourth when one of these applies:

- **Disabled-source revert.** Turn the new code off — comment the emission, force the predicate false — show the test goes red, restore. One run, and it proves the test is actually coupled to the change. Lane F used exactly this and it caught a test that passed with the fix disabled.
- **Negative subject.** Assert the same code path does **not** fire where it must not. This is the only shape that catches "disabled everything" and "matched everything" in a single row. T17's unsupported-runtime test is built this way on purpose.
- **Positive control for an absence.** Never record "X does not happen" without something on the same rig making X happen. Every absence claim in this repo that lacked one turned out to be wrong; the Codex split-namespace false absence is only the most recent.

**Where a control is genuinely impossible, the row says so and says why.** An honest "no control available, because …" is verifiable. A silent omission reads as a control that passed, which is worse than no claim at all.

**The recorded output must come from the FINAL state of the code.** A unit that measures, keeps editing, then reports the earlier number files a false row while being entirely truthful — this is the commonest way an honest agent produces a wrong tracker. Re-run after the last edit, and record *that* output.

**A comparison between a RAW value and a DERIVED one — measured 2026-08-15, T1, caught at Step 0.** The plan's own `codexUpdateIsModelOnly` compared `update.runtime?.baseUrl` — the connection's raw url, which `runAgentRuntimeRefresh` actually sends — against a *derived* pinned value, because `buildCodexRuntimeUpstream` maps the gateway url to `{kind:'nestor'}` whose baseUrl is `undefined`, while the gateway card does seed a baseUrl. As written the helper would have declined **every** gateway update: the feature inert on the primary card, and **green on every test written for it**, because those tests were written from the same wrong mental model as the code.

A test suite structurally cannot catch this. What caught it was reading the value the caller actually sends instead of trusting the plan's description of it. **Whenever two sides of a comparison come from different layers, Step 0 reads both — the sent value at the call site and the stored value at the field — and never infers one from the other's name.**

**Three shapes this repo has actually punished, and every row is written against them:**

1. **A claim proven on a stale bundle.** `electron:dev` runs the host and the Pi subprocess from BUILT bundles: a main-process change can be on disk and absent from the running app. Live evidence comes from a packaged build or it is not live evidence.
2. **A green suite that never asserted the thing.** Name the assertion, not the suite. "12 tests pass" says nothing about whether any of them touched the behaviour.
3. **A detector reporting a false absence.** The worked example is in this plan already: a byte scan of the Codex rollout for `mcp__session__config_validate` finds nothing, because the rollout stores the pair split. A false absence is believed far more readily than a false presence.

### Refusal conditions

Stop and ask the owner rather than improvising when:

- A `Consumes` symbol no longer exists **and** no obvious replacement is named in a tracker note.
- Two completed tasks recorded contradictory decisions in their notes.
- The pre-flight would require editing a file another session is concurrently changing (check `git status` first — this branch has had a second session in the tree).
- A refusal condition inside the task itself fires during implementation (a drain that will not settle, a worktree that will not release).


---

## Cross-plan dependencies — `2026-08-14-runtime-icons-plates-model-sync.md`

**Status re-verified 2026-08-15 against HEAD.** The neighbouring plan has **closed**: lanes A, B, C, D, E, F, G and Z are all `✅`, released as 1.26.0 (`443b53b1d`), with a second plan closing on top at 1.26.1 (`85d7f9326`). Every collision this section originally recorded is resolved. The paragraphs below are kept because they name what changed under this plan — an executor reading a task written on 2026-08-14 needs to know which of its assumptions expired.

### Resolved — the plan file was destroyed and is restored

`4f059c5c8` truncated that plan to 0 bytes (a Python `open(p,'w')` that truncates before it reads). Restored in `7d091f52d` from `b2414a7f6`; HEAD carries 2413 lines, verified. A docs-integrity test now turns a truncated plan or checklist into a red test instead of a silent 0-byte file (`95c17372c`) — so this specific accident cannot recur unnoticed.

### Resolved — lane F closed, and it makes T11 obsolete rather than merely blocked

Lane F is `✅` **F1–F9**, live-proven on all three runtimes, and it went further than either plan expected. Beyond the four tasks this section originally listed: **F6 refuted its own plan's candidate cause by measurement** (claude occupancy reads zero for a different reason than assumed), **F7** made codex auto-compaction fire at a limit we write, **F8** put one shared `resolveContextTokens` behind the overlay row, and **F9** fixed claude auto-compaction outright — the SDK's gate required a window source of `auto` and a gateway model id never matched it.

~~**T11 is `⏸` and the recommendation is to CUT it, not merge it.**~~ **Superseded 2026-08-15 by the owner, who declined the cut** («резать не нужно, скорее проверить как он дойдет, так как там будет переключение рантайма») and re-scoped T11 from implement to verify. The recommendation was right about the implementation — its clearing half is in T3 and its deriving half is F1–F9 — and wrong about the conclusion: lane F's three arms each ran inside ONE runtime standing still, so nothing had yet measured the state across the move. T11 closed `✅` green with no production change, and the two disabled-source controls in its row are what make that green mean something.

### Resolved — D6 closed, T15 unblocked

D6 is `✅`, all its cases closed, and the hand-maintained `CASES` array in `scripts/cdp/run.ts` is free. T15's Step 0 gate on that row now passes; keep the gate — it costs nothing and documents why the ordering exists.

### Resolved, and it grew — E5 closed, and lane G rebuilt the form on top of it

E5 is `✅`: the merged personal-key form is the only entrance and the `api_key` card is gone. **Lane G then rebuilt that form's presentation** — llm-proxy-first, chips, availability probing, a hidden endpoint field (`G1`–`G3`, all `✅`). This plan's T5 predates **both**. **T5 is a rewrite against the current form, not a merge**, and its Step 0 must read `ByoRuntimeStep` and lane G's decision set before touching the picker.

### Resolved — the tree is clean, and this plan's own WIP is committed

The 1.26.0 close-out is committed. This plan's uncommitted design seam — `modelPickerSlot` in `FreeFormInput.tsx` plus `playground/registry/{index.ts,runtime-switch.tsx}` — was parked and is now on the branch as **`63dbaaacf`** (`wip(runtime-switch): restore the parked session-runtime-switching work`, +1413/−3, `typecheck:electron` green). **T5's Step 0 must reconcile against that commit**: the `modelPickerSlot` prop it plans to add already exists there, and the playground draft it is built from is already versioned. Resume, do not redo.

### What has already landed that this plan should USE, not re-derive

Verify each at the Step 0 of the task that touches it:

- **A2/A3 — runtime-aware provider icons.** `getProviderIcon` already returns the runtime marks and differentiates `claude-runtime`/`codex-runtime`.
- **C1/C2 — the `openai-compat` model fetcher and `modelsSyncedAt`.** Where a BYO catalog with hundreds of rows comes from; T5's collapse-past-ten-models branch exists because of it.
- **E1 — `miniModel`.** T4's summary path runs a mini model; use this preference rather than inventing a selection.
- **F1–F9 — the context-window layer.** T17's capability delta and T3's `contextUsage` clear must be re-read against `thresholdKind` and `resolveContextTokens`, which did not exist when they were written.
- **1.26.1 — session-tool wire names are now byte-identical across Pi/Claude/Codex.** This weakens, and may remove, the Deferred fix-list's rows 2 and 4. Re-check them at their sweep gate rather than assuming they still reproduce.
- **D7 — stale agent definitions could kill a session.** Landed in `SessionManager.ts`; every task in that chain re-resolves its anchors at Step 0 anyway.

### The standing rule, now one-sided

Both plans are no longer live: theirs is closed. What remains is that **this plan's Background section cites roughly twenty `file:line` anchors written against a tree that has since taken two full plan close-outs.** Step 0's anchor check is not a formality on this plan — it is the main event of the first few tasks.


---

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `packages/shared/src/sessions/runtime-anchors.ts` | Pure helpers over the provider-scoped anchor map: read, rebind, migrate a legacy `sdkSessionId`. No I/O. |
| `packages/shared/src/sessions/runtime-anchors.test.ts` | Unit tests for the above. |
| `packages/server-core/src/sessions/runtime-switch.ts` | Pure classification of a switch: `classifyRuntimeSwitch(from, to)` → `'model' | 'connection-same-runtime' | 'connection-cross-runtime'`, plus the renormalization helpers (permission mode, thinking level) that take capabilities and return clamped values. No `SessionManager` dependency. |
| `packages/server-core/src/sessions/runtime-switch.test.ts` | Unit tests for classification and renormalization. |
| `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts` | `SessionManager`-level tests for `switchSessionRuntime`. |
| `packages/shared/src/agent/__tests__/codex-model-switch.test.ts` | Codex in-place model switch coverage. |
| `apps/electron/src/renderer/components/app-shell/input/RuntimeSwitchDialog.tsx` | The three-tier confirmation dialog. |
| `apps/electron/src/renderer/components/app-shell/input/ConnectionRow.tsx` | The integration control: current integration with its runtime mark, opening the integration list. Rendered above the model list, never interleaved with it. |
| `apps/electron/src/renderer/components/app-shell/input/__tests__/runtime-switch-copy.test.ts` | Pure test over the dialog's tier→copy mapping. |

**Modified:**

| Path | Change |
| --- | --- |
| `packages/shared/src/agent/codex-agent.ts` | Fold the model into the thread-config signature; add `updateRuntimeConfig`. |
| `packages/shared/src/sessions/types.ts:42` | Add `sdkSessionAnchors` to `SESSION_PERSISTENT_FIELDS`; declare the field on the session types. |
| `packages/shared/src/agent/backend/factory.ts:759` | Un-scope the catalog guard from `provider === 'pi'`. |
| `packages/server-core/src/sessions/SessionManager.ts` | `switchSessionRuntime`; anchor rebinding in `getOrCreateAgentUnchecked` and `onSdkSessionIdUpdate`; `setSessionConnection` delegation; `updateSessionModel` lock note; Pi stickiness gate. |
| `packages/shared/src/protocol/dto.ts` | `SessionCommand` gains `switchRuntime`; `ComposerCapabilities` gains `connection: { switchable: boolean; activeRuntime: AgentProvider }`. |
| `packages/server-core/src/handlers/rpc/sessions.ts:762` | Route the new command. |
| `packages/server-core/src/handlers/session-manager-interface.ts:156` | Declare `switchSessionRuntime`. |
| `apps/electron/src/renderer/components/app-shell/input/picker-mode.ts` | Delete the `switcher` mode and the `isEmptySession` input. The hierarchical connection→model tree is what conflated the two gestures; the integration row replaces it. |
| `apps/electron/src/renderer/components/app-shell/input/CompactModelSelector.tsx` | Render `ConnectionRow` above the model list; delete the `switcher` branch. |
| `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` | Same for the desktop dropdown. |
| `apps/electron/src/renderer/pages/ChatPage.tsx:308` | `handleConnectionChange` surfaces failures as a toast instead of `console.error`. |
| `packages/shared/src/i18n/locales/*.json` | New keys. **Not** `apps/electron/src/renderer/locales/` — that directory does not exist. |

---

### Task 1: Codex applies a model change in place

Codex is the only runtime where changing the model today silently destroys the conversation. It is also the only one whose own protocol names the fix: `thread/fork` "preserves history while loading a fresh, complete config layer" (`codex-agent.ts:575`). This task is independent of every other task and ships value on its own.

**Obligation added 2026-08-15 by the independent re-verification pass — T1 creates this, so T1 owns it.** Lane F made the codex driver derive `contextWindow` from the connection's model catalogue at construction and write it into `config.toml` (`packages/shared/src/agent/backend/internal/drivers/codex.ts`, the `contextWindow` block — verified first-hand; note the pass cited a `backend/drivers/` path that does not exist). `codex-agent.ts`'s own comment states the consequence: *"config.toml is read when app-server STARTS, and nothing here respawns"*. A `thread/fork` carries the new model but **not a new config layer**, so after this task's in-place model switch the window in `config.toml` is the OLD model's until the next runtime start.

Before T1, nobody could change the model mid-session on Codex, so the staleness was unreachable. **This task makes it reachable in production, and therefore must resolve it**: either fold the target model's `contextWindow` into the fork's config layer, or record it as an explicit deviation with the reason. Silently shipping a stale window is not an option — it is the exact class lane F spent nine tasks removing.

**Files:**
- Modify: `packages/shared/src/agent/codex-agent.ts` (`:349-357`, `:568-587`)
- Test: `packages/shared/src/agent/__tests__/codex-model-switch.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `CodexAgent.updateRuntimeConfig(update: BackendRuntimeUpdate): Promise<boolean>` — returns `true` when the update was a model-only change it applied, `false` otherwise (SessionManager then recreates the backend). Task 3 relies on this contract to keep a same-connection model change off the dispose path.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first read the neighbouring plan's tracker (`docs/superpowers/plans/2026-08-14-runtime-icons-plates-model-sync.md`) and **refuse while its D6 row is `🔄`** — that lane owns the same machine, the same real profile and the same `scripts/cdp/run.ts` `CASES` array. Then sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/agent/__tests__/codex-model-switch.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { codexThreadConfigSignature, codexUpdateIsModelOnly } from '../codex-agent.ts'

const CONFIG = { sandbox_mode: 'workspace-write' } as const

describe('codexThreadConfigSignature', () => {
  it('drifts when only the model changes', () => {
    const a = codexThreadConfigSignature('gpt-5.3-codex', CONFIG)
    const b = codexThreadConfigSignature('gpt-5.3-codex-mini', CONFIG)
    expect(a).not.toBe(b)
  })

  it('is stable for the same model and config', () => {
    expect(codexThreadConfigSignature('gpt-5.3-codex', CONFIG))
      .toBe(codexThreadConfigSignature('gpt-5.3-codex', CONFIG))
  })
})

describe('codexUpdateIsModelOnly', () => {
  const current = { providerType: 'codex-runtime' as const, authType: 'bearer_token' as const, baseUrl: undefined }

  it('accepts a bare model change', () => {
    expect(codexUpdateIsModelOnly({ model: 'gpt-5.3-codex-mini' }, current)).toBe(true)
  })

  it('accepts a model change alongside an unchanged runtime block', () => {
    expect(codexUpdateIsModelOnly(
      { model: 'gpt-5.3-codex-mini', providerType: 'codex-runtime', authType: 'bearer_token', runtime: {} },
      current,
    )).toBe(true)
  })

  it('declines an endpoint change — a fresh adapter and CODEX_HOME are required', () => {
    expect(codexUpdateIsModelOnly(
      { model: 'gpt-5.3-codex', runtime: { baseUrl: 'https://example.invalid/v1' } },
      current,
    )).toBe(false)
  })

  it('declines a providerType change', () => {
    expect(codexUpdateIsModelOnly({ model: 'gpt-5.3-codex', providerType: 'pi' }, current)).toBe(false)
  })

  it('declines an authType change', () => {
    expect(codexUpdateIsModelOnly({ model: 'gpt-5.3-codex', authType: 'api_key' }, current)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/shared/src/agent/__tests__/codex-model-switch.test.ts
```

Expected: FAIL — `codexThreadConfigSignature` and `codexUpdateIsModelOnly` are not exported from `codex-agent.ts`.

- [ ] **Step 3: Add the two pure helpers**

At the bottom of `packages/shared/src/agent/codex-agent.ts`, beside the existing `isForeignThreadNotification` helper:

```ts
/**
 * The identity of a codex thread's configuration layer.
 *
 * The MODEL belongs in here, not only the sandbox/approval config: codex fixes
 * a thread's model at `thread/start` and `turn/start` carries no model, so a
 * signature that omitted it left `setModel` inert on a live thread — the
 * session kept answering on the old model until something else forced a
 * restart, and the restart dropped the thread's history.
 *
 * ONE builder, called from both the `thread/start` and the `thread/fork` side,
 * because two hand-written copies of "what makes a thread stale" is exactly the
 * drift that produced the bug.
 */
export function codexThreadConfigSignature(model: string, config: unknown): string {
  return JSON.stringify({ model, config });
}

/** The runtime fields a live codex agent is pinned to and cannot re-point. */
export interface CodexPinnedRuntime {
  providerType: LlmProviderType | undefined;
  authType: LlmAuthType | undefined;
  baseUrl: string | undefined;
}

/**
 * May this runtime update be applied to a LIVE codex agent?
 *
 * Only a model change may. The adapter, its upstream credential and the managed
 * `CODEX_HOME` are all established once in `createRuntime` from `this.config`,
 * which never mutates — so an endpoint, provider or auth change cannot be
 * re-pointed in place and must fall through to a backend recreate.
 *
 * An update whose runtime block merely REPEATS the pinned values is still
 * model-only: `SessionManager` sends the whole connection shape on every
 * refresh, so requiring an absent block would decline every real update.
 */
export function codexUpdateIsModelOnly(
  update: Pick<BackendRuntimeUpdate, 'providerType' | 'authType' | 'runtime'>,
  pinned: CodexPinnedRuntime,
): boolean {
  if (update.providerType !== undefined && update.providerType !== pinned.providerType) return false;
  if (update.authType !== undefined && update.authType !== pinned.authType) return false;
  const nextBaseUrl = update.runtime?.baseUrl;
  if (nextBaseUrl !== undefined && nextBaseUrl !== pinned.baseUrl) return false;
  return true;
}
```

Add to the type imports at the top of the file (the block that already imports `FileAttachment`, `ChatOptions`, …):

```ts
import type { BackendRuntimeUpdate, LlmAuthType, LlmProviderType } from './backend/types.ts';
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/shared/src/agent/__tests__/codex-model-switch.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Use the signature builder at both sites**

In `createRuntime`, replace the assignment at `codex-agent.ts:356-360`:

```ts
      this.runtimeConfigSignature = JSON.stringify(buildCodexRuntimeConfigOverride({
        mode: this.getPermissionMode(),
        sandboxGloballyEnabled: this.sandboxGloballyEnabled(),
        deniedReadPaths: [join(CONFIG_DIR, 'credentials.enc')],
      }));
```

with:

```ts
      this.runtimeConfigSignature = codexThreadConfigSignature(this._model, buildCodexRuntimeConfigOverride({
        mode: this.getPermissionMode(),
        sandboxGloballyEnabled: this.sandboxGloballyEnabled(),
        deniedReadPaths: [join(CONFIG_DIR, 'credentials.enc')],
      }));
```

In `applySelectedPluginSkillRuntimePolicy`, replace `codex-agent.ts:574`:

```ts
    const signature = JSON.stringify(config);
```

with:

```ts
    const signature = codexThreadConfigSignature(this._model, config);
```

and update that method's doc-comment opening line to name both triggers:

```ts
  /**
   * Re-fork the thread when its configuration layer has drifted — either the
   * plugin/sandbox config or the SELECTED MODEL. Both are fixed at
   * `thread/start`, and `turn/start` carries neither.
   */
```

- [ ] **Step 6: Add `updateRuntimeConfig` to `CodexAgent`**

Insert immediately after the class's `isProcessing()` method (`codex-agent.ts:787`):

```ts
  /**
   * In-place runtime refresh (`AgentBackend.updateRuntimeConfig`).
   *
   * Returning `false` is not a failure — it is this backend telling
   * `SessionManager.runAgentRuntimeRefresh` to dispose and recreate. Only a
   * model change is applied here; the new model reaches codex on the next turn
   * through `applySelectedPluginSkillRuntimePolicy`'s fork, which is codex's
   * own supported boundary for a fresh config layer WITH the thread's history
   * intact. Before this existed, every model change on a live codex session
   * took the recreate path and silently started an empty thread.
   */
  // NOT `override`: `updateRuntimeConfig` is an OPTIONAL member of the
  // `AgentBackend` interface (`backend/types.ts:1134`) and `BaseAgent` does not
  // declare it, so `override` is TS4113 and `typecheck:all` fails. The
  // precedent is `pi-agent.ts:7510`, which declares it with no modifier.
  async updateRuntimeConfig(update: BackendRuntimeUpdate): Promise<boolean> {
    const upstream = getBackendRuntime(this.config).upstream;
    const pinned: CodexPinnedRuntime = {
      providerType: this.config.providerType,
      authType: this.config.authType,
      baseUrl: upstream?.kind === 'openai-compatible' ? upstream.baseUrl : undefined,
    };
    if (!codexUpdateIsModelOnly(update, pinned)) return false;
    this.setModel(update.model);
    return true;
  }
```

- [ ] **Step 7: Typecheck the affected packages**

```bash
bun run typecheck:all
```

Expected: exit 0.

- [ ] **Step 8: Run the codex agent suite**

```bash
bun test packages/shared/src/agent/__tests__/codex-agent-lifecycle-hooks.test.ts packages/shared/src/agent/__tests__/codex-sandbox-globally-enabled.test.ts packages/shared/src/agent/__tests__/codex-model-switch.test.ts
```

Expected: PASS. The sandbox test asserts config-override content and must be unaffected by the signature wrapper; if it asserts the raw signature string, update that assertion to wrap through `codexThreadConfigSignature` rather than loosening it.

- [ ] **Step 9: Update the tracker row for T1, then commit**

```bash
git add packages/shared/src/agent/codex-agent.ts packages/shared/src/agent/__tests__/codex-model-switch.test.ts docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "fix(codex): apply a model change by re-forking the thread instead of recreating the agent"
```

---

### Task 2: Provider-scoped runtime anchors

`sdkSessionId` holds a Pi session id for a Pi session and a Claude SDK session id for a Claude session. One slot, two namespaces. Today `connectionLocked` makes the collision unreachable; Task 3 removes that, so the anchor must become provider-keyed first. Keying it as a map (rather than merely clearing on switch) also means switching back restores the previous runtime's history for free.

**Files:**
- Create: `packages/shared/src/sessions/runtime-anchors.ts`, `packages/shared/src/sessions/runtime-anchors.test.ts`
- Modify: `packages/shared/src/sessions/types.ts:42` and the three interfaces carrying `sdkSessionId` (`:334`, `:428`, `:486`)
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (`:1441` field, `:13205` session config, `:13232` `onSdkSessionIdUpdate`, `:13248` `onSdkSessionIdCleared`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type RuntimeAnchorMap = Partial<Record<AgentProvider, string>>`
  - `readRuntimeAnchor(anchors: RuntimeAnchorMap | undefined, provider: AgentProvider): string | undefined`
  - `writeRuntimeAnchor(anchors: RuntimeAnchorMap | undefined, provider: AgentProvider, anchor: string | undefined): RuntimeAnchorMap`
  - `migrateLegacyAnchor(anchors: RuntimeAnchorMap | undefined, legacy: string | undefined, provider: AgentProvider): RuntimeAnchorMap`

  Task 3 calls `readRuntimeAnchor` when building the backend's `session.sdkSessionId` and `writeRuntimeAnchor` when a runtime reports its id.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/sessions/runtime-anchors.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { migrateLegacyAnchor, readRuntimeAnchor, writeRuntimeAnchor } from './runtime-anchors.ts'

describe('runtime anchors', () => {
  it('reads nothing from an empty map', () => {
    expect(readRuntimeAnchor(undefined, 'pi')).toBeUndefined()
  })

  it('keeps one anchor per provider', () => {
    let anchors = writeRuntimeAnchor(undefined, 'pi', 'pi-123')
    anchors = writeRuntimeAnchor(anchors, 'anthropic', 'claude-abc')
    expect(readRuntimeAnchor(anchors, 'pi')).toBe('pi-123')
    expect(readRuntimeAnchor(anchors, 'anthropic')).toBe('claude-abc')
  })

  it('clears one provider without disturbing the others', () => {
    const anchors = writeRuntimeAnchor(writeRuntimeAnchor(undefined, 'pi', 'pi-123'), 'anthropic', 'claude-abc')
    const cleared = writeRuntimeAnchor(anchors, 'anthropic', undefined)
    expect(readRuntimeAnchor(cleared, 'anthropic')).toBeUndefined()
    expect(readRuntimeAnchor(cleared, 'pi')).toBe('pi-123')
  })

  it('adopts a legacy sdkSessionId for the session\'s current provider', () => {
    expect(readRuntimeAnchor(migrateLegacyAnchor(undefined, 'pi-legacy', 'pi'), 'pi')).toBe('pi-legacy')
  })

  it('never lets a legacy id overwrite an anchor already recorded for that provider', () => {
    const anchors = writeRuntimeAnchor(undefined, 'pi', 'pi-current')
    expect(readRuntimeAnchor(migrateLegacyAnchor(anchors, 'pi-legacy', 'pi'), 'pi')).toBe('pi-current')
  })

  it('never records an anchor for the remote provider', () => {
    expect(writeRuntimeAnchor(undefined, 'nestor-cloud-agent', 'x')).toEqual({})
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/shared/src/sessions/runtime-anchors.test.ts
```

Expected: FAIL — module `./runtime-anchors.ts` not found.

- [ ] **Step 3: Implement the helpers**

Create `packages/shared/src/sessions/runtime-anchors.ts`:

```ts
import type { AgentProvider } from '../agent/backend/types.ts';

/**
 * A session's runtime-side conversation anchors, one per backend.
 *
 * This replaces the single `sdkSessionId`, which held a PI session id for a Pi
 * session and a CLAUDE SDK session id for a Claude session — one slot, two
 * namespaces. That was safe only while a session's provider could not change;
 * once it can, handing Claude a Pi id resumes nothing and reads to the user as
 * "resume is broken".
 *
 * Keyed by provider rather than merely cleared on switch, so returning to a
 * runtime returns to its conversation. `nestor-cloud-agent` is never recorded:
 * it keeps no local anchor and is out of scope for switching.
 */
export type RuntimeAnchorMap = Partial<Record<AgentProvider, string>>;

/**
 * `codex-runtime` is deliberately ABSENT.
 *
 * Codex keeps no durable conversation store: its thread lives in a
 * `mkdtempSync` CODEX_HOME that `teardownRuntime` deletes, and its `threadId`
 * is never persisted. Worse, `BaseAgent.getSessionId()` returns the NESSY
 * session id and `CodexAgent` does not override it, so
 * `SessionManager.ts:17119` writes that id into `sdkSessionId` after the first
 * Codex turn. Anchoring Codex would migrate that garbage into the map and make
 * a Codex→Codex change report "history preserved" while the runtime starts
 * empty — a lie with a UI string behind it.
 */
const ANCHORED_PROVIDERS: readonly AgentProvider[] = ['pi', 'anthropic'];

function isAnchored(provider: AgentProvider): boolean {
  return ANCHORED_PROVIDERS.includes(provider);
}

export function readRuntimeAnchor(
  anchors: RuntimeAnchorMap | undefined,
  provider: AgentProvider,
): string | undefined {
  if (!anchors || !isAnchored(provider)) return undefined;
  return anchors[provider];
}

export function writeRuntimeAnchor(
  anchors: RuntimeAnchorMap | undefined,
  provider: AgentProvider,
  anchor: string | undefined,
): RuntimeAnchorMap {
  const next: RuntimeAnchorMap = { ...(anchors ?? {}) };
  if (!isAnchored(provider)) return next;
  if (anchor) next[provider] = anchor;
  else delete next[provider];
  return next;
}

/**
 * One-way adoption of a pre-map `sdkSessionId`.
 *
 * A session written before this field existed carries its anchor in the legacy
 * slot and nothing else, so the only provider it can belong to is the one the
 * session was running. Never overwrites an anchor already recorded — on a
 * session that has both, the map is the newer truth.
 */
export function migrateLegacyAnchor(
  anchors: RuntimeAnchorMap | undefined,
  legacy: string | undefined,
  provider: AgentProvider,
): RuntimeAnchorMap {
  const next: RuntimeAnchorMap = { ...(anchors ?? {}) };
  if (!legacy || !isAnchored(provider) || next[provider]) return next;
  next[provider] = legacy;
  return next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/shared/src/sessions/runtime-anchors.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Persist the field**

In `packages/shared/src/sessions/types.ts`, change line 32 from:

```ts
  'id', 'workspaceId', 'sdkSessionId', 'sdkCwd',
```

to:

```ts
  'id', 'workspaceId', 'sdkSessionId', 'sdkSessionAnchors', 'sdkCwd',
```

Then, beside each of the three `sdkSessionId?: string;` declarations (`:334`, `:428`, `:486`), add:

```ts
  /**
   * Per-runtime conversation anchors. `sdkSessionId` is kept as the legacy
   * slot for sessions written before this field existed and for the ONE
   * runtime a given session is currently on; readers must go through
   * `readRuntimeAnchor`/`migrateLegacyAnchor` rather than either field.
   */
  sdkSessionAnchors?: RuntimeAnchorMap;
```

and add the import at the top of `types.ts`:

```ts
import type { RuntimeAnchorMap } from './runtime-anchors.ts';
```

- [ ] **Step 6: Route the SessionManager through the map**

In `packages/server-core/src/sessions/SessionManager.ts`, add the field to `ManagedSession` beside `sdkSessionId` (`:1441`):

```ts
  sdkSessionAnchors?: RuntimeAnchorMap
```

Import at the top of the file:

```ts
import { migrateLegacyAnchor, readRuntimeAnchor, writeRuntimeAnchor, type RuntimeAnchorMap } from '@nessy-agent/shared/sessions'
```

(export the three functions and the type from `packages/shared/src/sessions/index.ts` alongside the existing session exports.)

In `getOrCreateAgentUnchecked`, replace the `sessionConfig` line at `:13205`:

```ts
        sdkSessionId: managed.sdkSessionId,
```

with:

```ts
        // Provider-scoped: a Pi id must never be handed to Claude. The legacy
        // slot is adopted for THIS provider on first read so a session written
        // before the map existed still resumes.
        sdkSessionId: readRuntimeAnchor(
          managed.sdkSessionAnchors = migrateLegacyAnchor(managed.sdkSessionAnchors, managed.sdkSessionId, provider),
          provider,
        ),
```

Replace the body of `onSdkSessionIdUpdate` (`:13232`) so it writes both slots:

```ts
      const onSdkSessionIdUpdate = (sdkSessionId: string) => {
        managed.sdkSessionId = sdkSessionId
        managed.sdkSessionAnchors = writeRuntimeAnchor(managed.sdkSessionAnchors, provider, sdkSessionId)
```

(leave the rest of that function — the branch-fork retirement, the log lines, `persistSession`, `flush` — unchanged).

Replace the body of `onSdkSessionIdCleared` (`:13248`):

```ts
      const onSdkSessionIdCleared = () => {
        managed.sdkSessionId = undefined
        managed.sdkSessionAnchors = writeRuntimeAnchor(managed.sdkSessionAnchors, provider, undefined)
```

and the same two lines inside `onBranchForkInvalidated` (`:13255`).

- [ ] **Step 7: Write the SessionManager-level regression test**

Create `packages/server-core/src/sessions/__tests__/runtime-anchor-scope.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { migrateLegacyAnchor, readRuntimeAnchor, writeRuntimeAnchor } from '@nessy-agent/shared/sessions'

describe('a session that has run on two runtimes', () => {
  it('never hands one runtime the other\'s anchor', () => {
    // Session started on Pi, before the map existed.
    let anchors = migrateLegacyAnchor(undefined, 'pi-session-1', 'pi')
    expect(readRuntimeAnchor(anchors, 'pi')).toBe('pi-session-1')
    // The user switches to Claude; Claude has not reported an id yet.
    expect(readRuntimeAnchor(anchors, 'anthropic')).toBeUndefined()
    // Claude reports its own.
    anchors = writeRuntimeAnchor(anchors, 'anthropic', 'claude-session-1')
    expect(readRuntimeAnchor(anchors, 'anthropic')).toBe('claude-session-1')
    // Switching back reaches the Pi conversation, not Claude's.
    expect(readRuntimeAnchor(anchors, 'pi')).toBe('pi-session-1')
  })

  it('does not let the legacy slot re-poison a provider after a switch', () => {
    // Legacy slot still holds the Pi id (the session config keeps writing it),
    // but the map already records Claude for `anthropic`.
    const anchors = writeRuntimeAnchor(migrateLegacyAnchor(undefined, 'pi-session-1', 'pi'), 'anthropic', 'claude-session-1')
    expect(readRuntimeAnchor(migrateLegacyAnchor(anchors, 'pi-session-1', 'anthropic'), 'anthropic'))
      .toBe('claude-session-1')
  })
})
```

- [ ] **Step 8: Run the tests**

```bash
bun test packages/shared/src/sessions/runtime-anchors.test.ts packages/server-core/src/sessions/__tests__/runtime-anchor-scope.test.ts
bun run typecheck:all
```

Expected: both suites PASS, typecheck exit 0.

- [ ] **Step 9: Update the tracker row for T2, then commit**

```bash
git add packages/shared/src/sessions/runtime-anchors.ts packages/shared/src/sessions/runtime-anchors.test.ts packages/shared/src/sessions/types.ts packages/shared/src/sessions/index.ts packages/server-core/src/sessions/SessionManager.ts packages/server-core/src/sessions/__tests__/runtime-anchor-scope.test.ts docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "feat(sessions): scope the runtime conversation anchor to its provider"
```

---

### Task 3: The switch operation

**Files:**
- Create: `packages/server-core/src/sessions/runtime-switch.ts`, `packages/server-core/src/sessions/runtime-switch.test.ts`, `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts`
- Modify: `packages/shared/src/agent/backend/factory.ts:759`
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (`:14664` `setSessionConnection`, `:6603`/`:10670`/`:12843` Pi stickiness)

**Interfaces:**
- Consumes: `readRuntimeAnchor` / `writeRuntimeAnchor` (Task 2).
- Produces:
  - `type RuntimeSwitchKind = 'model' | 'connection-same-runtime' | 'connection-cross-runtime'`
  - `classifyRuntimeSwitch(from: { slug?: string; provider: AgentProvider }, to: { slug: string; provider: AgentProvider }): RuntimeSwitchKind`
  - `renormalizeForRuntime(input: { permissionMode?: PermissionMode; thinkingLevel?: ThinkingLevel; capabilities: ComposerCapabilities; disabledPermissionModes: readonly PermissionMode[] }): { permissionMode?: PermissionMode; thinkingLevel?: ThinkingLevel }`
  - `SessionManager.switchSessionRuntime(sessionId: string, connectionSlug: string, workspaceId?: string): Promise<RuntimeSwitchResult>` where `RuntimeSwitchResult = { kind: RuntimeSwitchKind; contextCarried: 'runtime-anchor' | 'handoff' | 'none'; model: string }`

  Task 4 sets the handoff on the `'connection-cross-runtime'` branch; Task 5 renders `RuntimeSwitchResult`.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing classification test**

Create `packages/server-core/src/sessions/runtime-switch.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { classifyRuntimeSwitch, renormalizeForRuntime } from './runtime-switch.ts'

describe('classifyRuntimeSwitch', () => {
  it('is a model change when the slug is unchanged', () => {
    expect(classifyRuntimeSwitch({ slug: 'a', provider: 'pi' }, { slug: 'a', provider: 'pi' })).toBe('model')
  })

  it('is same-runtime when two connections share a provider', () => {
    // Claude Pro/Max (anthropic) → Claude Code via Nessy Gateway (claude-runtime):
    // two providerTypes, ONE AgentProvider, one durable transcript location.
    expect(classifyRuntimeSwitch({ slug: 'claude-max', provider: 'anthropic' }, { slug: 'claude-gateway', provider: 'anthropic' }))
      .toBe('connection-same-runtime')
  })

  it('is cross-runtime when the provider differs', () => {
    expect(classifyRuntimeSwitch({ slug: 'nessy-gateway', provider: 'pi' }, { slug: 'codex-gateway', provider: 'codex-runtime' }))
      .toBe('connection-cross-runtime')
  })

  it('treats a session with no connection as cross-runtime onto a different provider', () => {
    expect(classifyRuntimeSwitch({ provider: 'pi' }, { slug: 'claude-gateway', provider: 'anthropic' }))
      .toBe('connection-cross-runtime')
  })
})

describe('renormalizeForRuntime', () => {
  const codexCaps = {
    reasoning: { levels: ['off', 'low', 'medium', 'high'] },
    permissions: { modes: ['default', 'plan', 'acceptEdits', 'bypassPermissions'] },
  } as never

  it('clamps a thinking level the target runtime does not offer', () => {
    expect(renormalizeForRuntime({
      thinkingLevel: 'max', capabilities: codexCaps, disabledPermissionModes: [],
    }).thinkingLevel).toBe('high')
  })

  it('leaves an offered level alone', () => {
    expect(renormalizeForRuntime({
      thinkingLevel: 'low', capabilities: codexCaps, disabledPermissionModes: [],
    }).thinkingLevel).toBe('low')
  })

  it('clamps a permission mode the target host disables', () => {
    expect(renormalizeForRuntime({
      permissionMode: 'bypassPermissions', capabilities: codexCaps, disabledPermissionModes: ['bypassPermissions'],
    }).permissionMode).toBe('default')
  })

  it('leaves an undefined mode undefined rather than inventing one', () => {
    expect(renormalizeForRuntime({ capabilities: codexCaps, disabledPermissionModes: [] }).permissionMode)
      .toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test packages/server-core/src/sessions/runtime-switch.test.ts
```

Expected: FAIL — module `./runtime-switch.ts` not found.

- [ ] **Step 3: Implement the pure module**

Create `packages/server-core/src/sessions/runtime-switch.ts`:

```ts
import type { AgentProvider } from '@nessy-agent/shared/agent/backend'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels'

/**
 * How much a connection change costs the session.
 *
 * The three tiers are not cosmetic — they decide whether the runtime's own
 * conversation survives:
 *
 * - `model`: same connection, different model. The runtime keeps its thread.
 * - `connection-same-runtime`: different connection, same `AgentProvider`. The
 *   backend is recreated (credentials/endpoint changed) but the runtime anchor
 *   is still valid, because both Pi's `.pi-sessions` sidecar and Claude's SDK
 *   transcript are keyed by session/workspace, never by connection.
 * - `connection-cross-runtime`: different `AgentProvider`. The target runtime
 *   has no anchor for this session; context can only be handed over as text.
 */
export type RuntimeSwitchKind = 'model' | 'connection-same-runtime' | 'connection-cross-runtime'

export function classifyRuntimeSwitch(
  from: { slug?: string; provider: AgentProvider },
  to: { slug: string; provider: AgentProvider },
): RuntimeSwitchKind {
  if (from.slug === to.slug) return 'model'
  return from.provider === to.provider ? 'connection-same-runtime' : 'connection-cross-runtime'
}

/**
 * Clamp session settings the TARGET runtime cannot honour.
 *
 * Codex's own `/model` resets reasoning effort to the new model's default
 * rather than carrying the prior level over; we do the narrower, less
 * surprising thing and clamp to the highest level the target still offers.
 * A setting silently retained but unreachable is how a user comes to believe
 * they are in a mode they are not in.
 */
export function renormalizeForRuntime(input: {
  permissionMode?: PermissionMode
  thinkingLevel?: ThinkingLevel
  capabilities: ComposerCapabilities
  disabledPermissionModes: readonly PermissionMode[]
}): { permissionMode?: PermissionMode; thinkingLevel?: ThinkingLevel } {
  const levels = input.capabilities.reasoning.levels
  const thinkingLevel = input.thinkingLevel === undefined || levels.includes(input.thinkingLevel)
    ? input.thinkingLevel
    : (levels[levels.length - 1] ?? 'off')

  const permissionMode = input.permissionMode === undefined
    ? undefined
    : (input.disabledPermissionModes.includes(input.permissionMode)
        || !input.capabilities.permissions.modes.includes(input.permissionMode)
        ? 'default'
        : input.permissionMode)

  return { ...(permissionMode !== undefined ? { permissionMode } : {}), ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) }
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
bun test packages/server-core/src/sessions/runtime-switch.test.ts
```

Expected: PASS, 8 tests.

**Two obligations added 2026-08-15 by the re-verification pass, neither declared when this task was written:**

1. **`applyContextUsageSnapshot` also writes `tokenUsage.contextWindow`.** Clearing `managed.contextUsage` alone therefore leaves **Pi's window** sitting in `tokenUsage.contextWindow`, and lane F's fallback will divide the new runtime's tokens by it until the target reports its first usage update. Clear both, or state why not.
2. **Un-scoping the catalog guard is no longer nearly-inert.** When this task was written, `claude-runtime` / `codex-runtime` / BYO connections usually carried an empty `models` list. They now carry **synced catalogues**, so a `connectionDefault` that is not in the list falls through to `connectionModelIds[0]` — an arbitrary first row out of a 388-entry llm-proxy catalogue. Before touching `resolveModelForProvider`, read AGENTS.md's standing warning about `isManagedModelAllowed`: the edit now sits between an `isManagedModelSelectable` clamp above it and a `claude-runtime` early return below it, neither of which existed in this plan's mental model.

- [ ] **Step 5: Un-scope the model catalog guard**

In `packages/shared/src/agent/backend/factory.ts`, replace line 759:

```ts
  if (provider === 'pi' && connection?.models?.length) {
```

with:

```ts
  // Applies to EVERY provider, not just Pi. A gateway model id such as
  // `tgpt/qwen35-397b-a17b-fp8` is absent from MODEL_REGISTRY, so the
  // cross-provider guard above cannot see it — under the old pi-only scope a
  // stale id survived a switch onto an `anthropic` or `codex-runtime`
  // connection and was sent to a provider that has never heard of it.
  if (connection?.models?.length) {
```

- [ ] **Step 6: Add a regression test for the guard**

Append to `packages/shared/src/agent/__tests__/` a new file `model-catalog-guard.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { resolveModelForProvider } from '../backend/factory.ts'
import type { LlmConnection } from '../../config/llm-connections.ts'

function connection(overrides: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'target', name: 'Target', providerType: 'codex-runtime', authType: 'bearer_token',
    createdAt: 0, ...overrides,
  } as LlmConnection
}

describe('resolveModelForProvider catalog guard', () => {
  it('drops a model absent from a codex connection catalog', () => {
    const conn = connection({ models: ['gpt-5.3-codex'], defaultModel: 'gpt-5.3-codex' })
    expect(resolveModelForProvider('codex-runtime', 'tgpt/qwen35-397b-a17b-fp8', conn)).toBe('gpt-5.3-codex')
  })

  it('keeps a model the catalog does list', () => {
    const conn = connection({ models: ['gpt-5.3-codex', 'gpt-5.3-codex-mini'], defaultModel: 'gpt-5.3-codex' })
    expect(resolveModelForProvider('codex-runtime', 'gpt-5.3-codex-mini', conn)).toBe('gpt-5.3-codex-mini')
  })

  it('leaves a connection without a catalog untouched', () => {
    const conn = connection({ defaultModel: 'gpt-5.3-codex' })
    expect(resolveModelForProvider('codex-runtime', 'some-byo-model', conn)).toBe('some-byo-model')
  })
})
```

- [ ] **Step 7: Implement `switchSessionRuntime`**

In `packages/server-core/src/sessions/SessionManager.ts`, replace the whole body of `setSessionConnection` (`:14664`) with a delegation, and add the new method immediately after it:

```ts
  /**
   * Legacy entry point. Kept because the `setConnection` session command and
   * the empty-session picker both call it; it now simply delegates, so there is
   * ONE implementation of "this session changes connection".
   */
  async setSessionConnection(sessionId: string, connectionSlug: string, workspaceId?: string): Promise<void> {
    await this.switchSessionRuntime(sessionId, connectionSlug, workspaceId)
  }

  /**
   * Move a live session onto a different LLM connection, including one whose
   * runtime differs.
   *
   * Refuses only two things, and says which: a session mid-turn (the backend
   * cannot be replaced under a running stream) and a connection that does not
   * resolve. Everything else is handled rather than blocked — the previous
   * `throw` for "session has already started" is what this method replaces.
   */
  async switchSessionRuntime(
    sessionId: string,
    connectionSlug: string,
    workspaceId?: string,
  ): Promise<RuntimeSwitchResult> {
    const managed = this.getManaged(sessionId, workspaceId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)

    const { getLlmConnection } = await import('@nessy-agent/shared/config/storage')
    const target = getLlmConnection(connectionSlug)
    if (!target) throw new CodedError('CONNECTION_NOT_FOUND', `LLM connection "${connectionSlug}" not found`)
    if (target.providerType === 'nestor-cloud-agent') {
      throw new CodedError('CONNECTION_NOT_SWITCHABLE', 'Remote connections cannot be switched into an existing session')
    }
    if (managed.agent?.isProcessing()) {
      throw new CodedError('SESSION_BUSY', 'Cannot switch connection while the session is running a turn')
    }
    if (this.projectMutationSessions.has(this.managedKey(managed))) {
      throw new CodedError('SESSION_BUSY', 'Cannot switch connection while the working directory is changing')
    }

    const fromProvider = this.resolveManagedProvider(managed)
    const toProvider = providerTypeToAgentProvider(target.providerType)
    const kind = classifyRuntimeSwitch(
      { ...(managed.llmConnection ? { slug: managed.llmConnection } : {}), provider: fromProvider },
      { slug: connectionSlug, provider: toProvider },
    )

    // Tear the old runtime down BEFORE any state is rewritten, through the
    // repo's own primitive for a destructive session mutation. NOT
    // `disposeManagedAgentRuntime`: this one routes to `strictDrainPiSession`
    // when the OUTGOING provider is Pi (`:10324`), which is what releases
    // worktree leases and child sessions and asserts
    // `pi-session-worktree-residual` / `pi-session-child-residual`; it
    // `forceAbort`s a live agent, kills background shells and FAILS if one
    // survives; and it holds the mutation boundary for the whole operation
    // instead of merely reading it.
    await this.strictDrainSessionForMutation(managed, `runtime switch (${kind})`, true)

    // `activeProvider` is the Pi stickiness latch. An explicit switch is exactly
    // the case it must NOT win: it exists to stop a workspace-default change
    // from moving a live Pi session, not to stop the user.
    managed.activeProvider = undefined
    managed.llmConnection = connectionSlug
    managed.connectionLocked = true
    managed.backendRuntimeSignature = undefined
    managed.backendRestartSignature = undefined

    // A model id from the previous integration is meaningless here; start from
    // the target's own default and let `resolveModelForProvider` settle it.
    managed.model = target.defaultModel

    const capabilities = resolveComposerCapabilities({
      provider: toProvider,
      connection: target,
      ...(managed.model ? { model: managed.model } : {}),
    })
    const renormalized = renormalizeForRuntime({
      ...(managed.thinkingLevel ? { thinkingLevel: managed.thinkingLevel } : {}),
      capabilities,
    })
    managed.thinkingLevel = renormalized.thinkingLevel

    // The permission mode goes through the ONE door, never by assignment.
    // `managed.permissionMode` is a record, not the authority: enforcement
    // reads the mode-manager singleton (`permission-manager.ts:209-210`,
    // `claude-agent.ts:1474` "single source of truth"). Assigning the field
    // alone downgrades the UI and the record while the new agent keeps running
    // under the old mode — the exact state `SessionManager.ts:19288` calls
    // drift. `normalizeManagedPermissionMode` is the repo's graded chain
    // (`mode-types.ts:158-176`), which lands a no-write mode on the `plan`
    // floor rather than on write-capable `default`.
    if (managed.permissionMode) {
      const nextMode = normalizeManagedPermissionMode(
        managed.permissionMode,
        toProvider === 'pi' ? this.managedPiPolicy.disabledPermissionModes : [],
      )
      if (nextMode !== managed.permissionMode) {
        await this.setSessionPermissionMode(sessionId, nextMode, managed.workspace.id)
      }
    }

    let contextCarried: RuntimeSwitchResult['contextCarried'] = 'none'
    if (kind === 'connection-cross-runtime') {
      this.clearRuntimeScopedSessionState(managed)
      contextCarried = 'handoff'   // Task 4 arms the handoff itself.
    } else if (readRuntimeAnchor(managed.sdkSessionAnchors, toProvider)) {
      contextCarried = 'runtime-anchor'
    }

    this.persistSession(managed)
    await this.flushSession(managed.id, managed.workspace.id)

    this.sendEvent({
      type: 'connection_changed',
      sessionId,
      connectionSlug,
      supportsBranching: resolveSupportsBranching(managed),
    }, managed.workspace.id)
    this.sendCapabilitiesChanged(managed)
    this.sendEvent({ type: 'session_model_changed', sessionId, model: managed.model ?? null }, managed.workspace.id)

    sessionLog.info(`Session ${sessionId} switched to "${connectionSlug}" (${kind}, context=${contextCarried})`)
    return { kind, contextCarried, model: managed.model ?? '' }
  }

  /**
   * Drop the state that belongs to the runtime we are leaving.
   *
   * Everything here is state a DIFFERENT backend cannot interpret: Pi's
   * continuation envelope and goal, a deferred tool call whose tool no longer
   * exists, child bookkeeping whose processes the dispose above has already
   * drained, and pending interactions whose ids the new runtime never issued.
   * Nessy's own transcript (`managed.messages`) and the message queue are
   * deliberately NOT touched — they are provider-agnostic and are the whole
   * reason a switch is survivable.
   */
  private clearRuntimeScopedSessionState(managed: ManagedSession): void {
    managed.piContinuationEnvelope = undefined
    managed.goalState = undefined
    managed.deferredToolCall = undefined
    managed.childSessionState = undefined
    managed.planModeState = undefined
    managed.pendingAskUser = undefined
    managed.piBackgroundTaskKinds = undefined
    // `piGoalServices` is a SessionManager field, never a ManagedSession one —
    // the earlier draft had an optional-chained call on `managed` that could
    // not compile and silently did nothing next to the real line.
    this.piGoalServices.delete(this.managedKey(managed))
    // The Pi services that keep RUNNING after a dispose. The cron one owns a
    // live `setInterval` and delivery is not provider-gated, so without this a
    // `/loop` keeps waking the session on Claude or Codex.
    this.piCronServices.get(this.managedKey(managed))?.stop()
    this.piCronServices.delete(this.managedKey(managed))
    for (const map of [
      this.piAskUserServices, this.piPlanModeServices, this.piTaskServices,
      this.piChildSessionServices, this.piWorktreeLeaseServices, this.piMailboxServices,
    ]) map.delete(this.managedKey(managed))
    void this.sessionMonitors.stopAll({ workspaceId: managed.workspace.id, sessionId: managed.id })
    // The context meter's only writer early-returns on `undefined`, and neither
    // Claude nor Codex ever emits a snapshot — so a Pi reading left here
    // shadows every later number for the life of the session.
    managed.contextUsage = undefined
    if (managed.tokenUsage) managed.tokenUsage.contextUsage = undefined
    // Streaming residue, the same block `rewindToMessage:15307-15320` clears.
    const deltaKey = this.managedKey(managed)
    const timer = this.deltaFlushTimers.get(deltaKey)
    if (timer) { clearTimeout(timer); this.deltaFlushTimers.delete(deltaKey) }
    this.pendingDeltas.delete(deltaKey)
    this.deltaFlushChain?.delete(deltaKey)
    managed.streamingText = ''
    managed.messageDisplayCursor = undefined
    managed.backgroundShellCommands.clear()
    // A cross-runtime switch is a session END for the outgoing runtime: without
    // this the incoming one inherits `sessionStartEmitted` and never runs its
    // own SessionStart hooks.
    managed.agentLifecycleState = undefined
    this.clearPendingPermissionRequestsForSession(managed.id, managed.workspace.id)
    // The ONE piece of capability state that outlives a dispose and is read
    // afterwards. An MCP "always allow" is stored in `adminRememberApprovals`
    // keyed by a sha256 of the TOOL NAME with lifetime `'session'` (=Infinity),
    // and `:6997` auto-approves on a hash hit with no card shown. The map is
    // cleared only at session delete (`:16465`) and manager cleanup (`:21443`).
    // Left alone, a user who allowed `mcp__github__create_issue` on Pi is not
    // re-asked after moving the session to Claude — while every harmless thing
    // they accumulated in the agent (bash whitelists, allowed domains, hook
    // session rules) IS wiped and re-asks. Exactly backwards.
    this.clearAdminRememberApprovalsForSession({ workspaceId: managed.workspace.id, sessionId: managed.id })
  }
```

Add near the other exported types in the same file:

```ts
export interface RuntimeSwitchResult {
  kind: RuntimeSwitchKind
  contextCarried: 'runtime-anchor' | 'handoff' | 'none'
  model: string
}
```

and the imports:

```ts
import { classifyRuntimeSwitch, renormalizeForRuntime, type RuntimeSwitchKind } from './runtime-switch.ts'
import { providerTypeToAgentProvider, resolveComposerCapabilities } from '@nessy-agent/shared/agent/backend'
```

- [ ] **Step 8: Let an explicit switch beat Pi stickiness**

The latch is read at three sites. Clearing `managed.activeProvider` in Step 7 already neutralises `:6603` and `:12843`. The third, in `tryRefreshAgentRuntime` (`:10668-10675`), must additionally not fire on a session that now HAS an explicit connection. Replace that guard:

```ts
      if (
        managed.activeProvider === 'pi'
        && !managed.llmConnection
        && backendContext.provider !== 'pi'
      ) {
```

with the same condition plus an explicit comment (no behavioural change — the `!managed.llmConnection` clause already excludes an explicitly-switched session, and this step is recording that it is load-bearing):

```ts
      // `!managed.llmConnection` is what keeps this guard off an EXPLICIT
      // switch: it fires only for a session running on the workspace default,
      // which is the case it was written for (the default moved under a live
      // Pi session). A session with its own slug has chosen its provider.
      if (
        managed.activeProvider === 'pi'
        && !managed.llmConnection
        && backendContext.provider !== 'pi'
      ) {
```

- [ ] **Step 9: Write the SessionManager-level tests**

Create `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts`, modelled on `refresh-connection-runtime.test.ts` (same `createTestSessionManager` harness and agent-stub shape):

```ts
import { describe, expect, it } from 'bun:test'
import { classifyRuntimeSwitch } from '../runtime-switch.ts'

describe('switchSessionRuntime refusals', () => {
  it('refuses while a turn is running', async () => {
    const { manager, managed } = await createSwitchHarness({ isProcessing: true })
    await expect(manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id))
      .rejects.toThrow(/running a turn/)
  })

  it('refuses an unknown connection', async () => {
    const { manager, managed } = await createSwitchHarness({})
    await expect(manager.switchSessionRuntime(managed.id, 'does-not-exist', managed.workspace.id))
      .rejects.toThrow(/not found/)
  })
})

describe('switchSessionRuntime effects', () => {
  it('same-runtime switch keeps the runtime anchor and reports it', async () => {
    const { manager, managed } = await createSwitchHarness({ provider: 'anthropic', anchor: 'claude-1' })
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-same-runtime')
    expect(result.contextCarried).toBe('runtime-anchor')
  })

  it('cross-runtime switch reports a handoff and clears Pi-scoped state', async () => {
    const { manager, managed } = await createSwitchHarness({ provider: 'pi', anchor: 'pi-1' })
    managed.piContinuationEnvelope = { schemaVersion: 1 } as never
    const result = await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(result.kind).toBe('connection-cross-runtime')
    expect(result.contextCarried).toBe('handoff')
    expect(managed.piContinuationEnvelope).toBeUndefined()
  })

  it('cross-runtime switch resets the model to the target default', async () => {
    const { manager, managed } = await createSwitchHarness({ provider: 'pi', model: 'tgpt/qwen35-397b-a17b-fp8' })
    const result = await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(result.model).not.toBe('tgpt/qwen35-397b-a17b-fp8')
  })

  it('clamps a thinking level the target runtime does not offer', async () => {
    const { manager, managed } = await createSwitchHarness({ provider: 'pi', thinkingLevel: 'max' })
    await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    expect(managed.thinkingLevel).toBe('high')
  })

  it('keeps the transcript and the queued messages', async () => {
    const { manager, managed } = await createSwitchHarness({ provider: 'pi' })
    managed.messages = [{ id: 'm1', role: 'user', content: 'hello' } as never]
    managed.messageQueue = [{ message: 'queued' }]
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    expect(managed.messages).toHaveLength(1)
    expect(managed.messageQueue).toHaveLength(1)
  })
})
```

Write `createSwitchHarness` in the same file, following `refresh-connection-runtime.test.ts:26-80` — a `createTestSessionManager`, a `createManagedSession` from a metadata literal, an agent stub whose `isProcessing()` returns the flag, and two connections written into a temp `NESSY_CONFIG_DIR` config (`claude-gateway` with `providerType: 'claude-runtime'`, `codex-gateway` with `providerType: 'codex-runtime'`, both with a `models` array and a `defaultModel`).

- [ ] **Step 10: Run the tests**

```bash
bun test packages/server-core/src/sessions/runtime-switch.test.ts packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts packages/shared/src/agent/__tests__/model-catalog-guard.test.ts
bun run typecheck:all
```

Expected: all PASS, typecheck exit 0. Nothing else may be running `bun test` concurrently — several session suites mutate `process.env.NESSY_CONFIG_DIR` at module scope.

- [ ] **Step 11: Update the tracker row for T3, then commit**

```bash
git add packages/server-core/src/sessions/runtime-switch.ts packages/server-core/src/sessions/runtime-switch.test.ts packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts packages/server-core/src/sessions/SessionManager.ts packages/shared/src/agent/backend/factory.ts packages/shared/src/agent/__tests__/model-catalog-guard.test.ts docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "feat(sessions): switch a live session onto a different connection and runtime"
```

---

### Task 4: Context handoff across runtimes

A cross-runtime switch leaves the target with no anchor. The seam that hands it context already exists and already runs on all three backends — this task arms it, gives it three complementary parts, and makes the discontinuity visible in the transcript instead of invisible.

**⚠ Corrected at Step 0, 2026-08-15 — this task contradicted itself about its own scope.** The paragraph and table below described a THREE-part handoff (state snapshot + verbatim tail + mini-model summary) and the `Interfaces` block promised a `RuntimeHandoffPayload` to carry it. **Not one of Steps 1–9 implements any of that**, and four other places in this plan describe the tail-only design the steps do implement: the global File Structure (which has no `runtime-handoff.ts`), the Deviations log (*"The handoff carries the transcript, not an LLM summary… `transferredSessionSummary` remains available and is the escalation… deliberately NOT built up front"*), this task's tracker row (*"reuses the existing per-turn context seam; adds the transcript marker"*) and Step 9's own commit subject. Nothing in the plan consumes `RuntimeHandoffPayload` — T5's dialog copy reads none of these symbols, as the block itself says.

**Resolution: parts B (verbatim tail) and the transcript marker ship; parts A and C do not.** Part C is forbidden by a recorded owner decision, and re-adding it needs that decision reversed, not an executor's judgement. Part A (a `listFileCheckpoints` + `taskState` state snapshot) is not forbidden by anything — it is simply un-stepped work that would have required designing the persisted payload, the async load and the render, none of which the task specifies. It is left unbuilt and recorded here so the reason survives; it is a bounded follow-up if live testing (T15) shows the tail alone is insufficient. The table below is kept verbatim as the record of what was considered.

~~The handoff is three parts, composed once, identical for all three runtimes.~~ A bare transcript tail was the first design and it is wrong for the case that matters: half an hour of dense work is 60–100 messages, of which a 24-message tail covers the last ten minutes — the task statement, the constraints found along the way and the agreements all fall off the front, which is exactly what the new runtime needs most.

| Part | Source | Cost | When | Shipped? |
| --- | --- | --- | --- | --- |
| **A. State snapshot** | `listFileCheckpoints(sessionPath)` (imported at `SessionManager.ts:183`, and it is `async`) plus `taskState` / `planModeState` — note `clearRuntimeScopedSessionState` wipes `planModeState`, so a builder would have to run before it | free — no model call, no `git` subprocess | always | **no** — un-stepped; follow-up |
| **B. Verbatim tail** | last 24 messages of `managed.messages`, ≤1200 chars each | free | always | **yes** |
| **C. Summary of the earlier part** | existing `generateConversationSummary` + a temporary agent, the same machinery remote-session transfer uses (`SessionManager.ts:21226`) | one mini-model call, bounded by a timeout | only when the transcript is longer than the tail | **no** — contradicts the Deviations log |

Part A is the one a coding agent benefits from most and the one nobody would think to write: the work product of the previous runtime lives on disk, not in its memory, so "which files were created and which were modified in this session" answers *what happened here* more precisely than any prose. It is also the only part that is exact.

Part C never blocks the switch. It runs before the old backend is disposed (its connection is warm and known-good), under a hard timeout, and a failure degrades to A+B with the degradation recorded — a summary that silently did not happen is how a user comes to believe context was carried when it was not.

**Files** (corrected at Step 0 to what the steps actually touch):
- Create: `packages/shared/src/agent/__tests__/runtime-handoff-context.test.ts` — the builder's unit test. ~~`packages/shared/src/agent/runtime-handoff.ts`~~ is not created: Step 1 imports the builder from `base-agent.ts` and the plan's own File Structure never listed a `runtime-handoff.ts`.
- Modify: `packages/shared/src/agent/base-agent.ts` (`:2606` `buildBranchSeedContext`, ends `:2629` — but a class body cannot hold a module-level export, so the builder goes immediately BEFORE the class at `:317`; `:3674`/`:3707` — compose it into the turn, both anchors held)
- Modify: `packages/shared/src/agent/backend/types.ts` (`:568` area — the config seam; anchor held)
- Modify: `packages/shared/src/sessions/types.ts` — `SESSION_PERSISTENT_FIELDS` + the two `SessionConfig` fields
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (`:13328` `getBranchSeedMessages` sibling, **not `:13286`**; config pass at `:13639`, **not `:13567`**; `ManagedSession` fields beside `transferredSessionSummaryApplied` at `:1674`, **not `:1648`**; `switchSessionRuntime` cross-runtime branch; the transcript notice; **and the two hydration copies below**)
- Test: `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts` (extend — **and repair two of T3's own tests**, see Step 7)

**Two additions required for the task to work at all, neither in the plan.** Both are the shape Step 0 exists to catch: the code passes every test the plan wrote while being inert in production.

1. **`SESSION_PERSISTENT_FIELDS` is not sufficient to make a field survive a restart.** `headerToMetadata` (`packages/shared/src/sessions/store-v2.ts:187`) hand-copies the listing projection and `loadSessionsFromDisk` (`SessionManager.ts:8383`) builds every restored session from it. `runtimeHandoffFrom` follows the `transferredSessionSummary` precedent instead — a *deferred-load* field, copied in the two message-hydration paths (`loadMessagesFromDisk` `:9586`, `hydrateMessagesForColdPersist` `:8538`). Without the copies a quit between the switch and the next turn drops the handoff **and then persists the loss**, exactly the failure `store-v2.ts:199` warns about. (This is T2's defect one layer over.)
2. **`managed.messages` is LAZY.** A session the user has not opened in this process reads `[]` while its JSONL holds the whole conversation, so `hasHistory` — which decides the arming, the notice and `contextCarried` — must run after `await this.ensureMessagesLoaded(managed)`. Every test in the harness constructs `messagesLoaded: true` sessions, so without this the feature is inert on cold sessions and green everywhere.

**Interfaces** (corrected to what shipped):
- Consumes: `RuntimeSwitchResult.contextCarried === 'handoff'` (Task 3). ~~`listFileCheckpoints`~~ — part A is not built.
- Produces:
  - `buildRuntimeHandoffContext(from: string, messages?: Array<{ type: 'user' | 'assistant'; content: string }>): string | null` — exported from `packages/shared/src/agent/base-agent.ts`
  - `BackendConfig.getRuntimeHandoffMessages?: () => { from: string; messages: RecoveryMessage[] } | null`
  - `BackendConfig.markRuntimeHandoffApplied?: () => void`
  - `ManagedSession.runtimeHandoffFrom?: AgentProvider` and `ManagedSession.runtimeHandoffApplied?: boolean`, both persisted
  - `SessionManager.appendRuntimeSwitchNotice` (private) — consumed by T9
  - ~~`RuntimeHandoffState`, `RuntimeHandoffPayload`, `HANDOFF_TAIL_MESSAGES`, `HANDOFF_TAIL_CHARS`, `splitHandoffTranscript`~~ — parts A and C only; not built.

  Task 5's dialog copy describes this behavior; it reads none of these symbols. **T5 does read the marker**: rendering `runtime_switched:<from>:<to>` into human copy is T5's (Wave-0 decision D1).

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/agent/__tests__/runtime-handoff-context.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { buildRuntimeHandoffContext } from '../base-agent.ts'

const MESSAGES = [
  { type: 'user' as const, content: 'add a retry to the fetch helper' },
  { type: 'assistant' as const, content: 'Done — three retries with backoff in fetchWithRetry.' },
]

describe('buildRuntimeHandoffContext', () => {
  it('returns null with no messages', () => {
    expect(buildRuntimeHandoffContext('pi', [])).toBeNull()
    expect(buildRuntimeHandoffContext('pi', undefined)).toBeNull()
  })

  it('names the runtime it came from', () => {
    const text = buildRuntimeHandoffContext('pi', MESSAGES)!
    expect(text).toContain('<runtime_handoff_context>')
    expect(text).toContain('different runtime')
  })

  it('carries the transcript, not a summary of it', () => {
    const text = buildRuntimeHandoffContext('pi', MESSAGES)!
    expect(text).toContain('add a retry to the fetch helper')
    expect(text).toContain('fetchWithRetry')
  })

  it('bounds a long history the same way the branch seed does', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ type: 'user' as const, content: `msg-${i}` }))
    const text = buildRuntimeHandoffContext('pi', many)!
    expect(text).not.toContain('msg-0')
    expect(text).toContain('msg-39')
  })

  it('truncates an oversized single message', () => {
    const text = buildRuntimeHandoffContext('pi', [{ type: 'user', content: 'x'.repeat(5000) }])!
    expect(text).toContain('...[truncated]')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test packages/shared/src/agent/__tests__/runtime-handoff-context.test.ts
```

Expected: FAIL — `buildRuntimeHandoffContext` is not exported.

- [ ] **Step 3: Implement the builder**

In `packages/shared/src/agent/base-agent.ts`, add a module-level export. **Corrected at Step 0:** `buildBranchSeedContext` is a `protected` METHOD (ends `:2629`, not `:2627`) and a class body cannot hold a module-level function, so it goes immediately before `export abstract class BaseAgent` (`:333` before the edit) — the nearest legal spot, with a docstring pointing back at the branch-seed builder.

```ts
/**
 * One-shot context for a session that has just moved to a DIFFERENT runtime.
 *
 * Deliberately not the branch-seed element: a branch tells the model "ignore
 * anything after this cutoff", which is false here and reads as an instruction
 * to forget the very history we are handing over. Same bounds as the branch
 * seed (24 messages, 1200 chars) because they are the bounds that were sized
 * against a first-turn prompt, and this is the same position in the prompt.
 *
 * This is the ONLY thing that crosses: Pi, Claude and codex all resume by their
 * own session id and none accepts an injected history, so a text handoff is the
 * ceiling, not a shortcut.
 */
export function buildRuntimeHandoffContext(
  from: string,
  messages?: Array<{ type: 'user' | 'assistant'; content: string }>,
): string | null {
  if (!messages || messages.length === 0) return null;
  const formatted = messages.slice(-24)
    .map(m => {
      const role = m.type === 'user' ? 'User' : 'Assistant';
      const content = m.content.length > 1200 ? `${m.content.slice(0, 1200)}...[truncated]` : m.content;
      return `[${role}]: ${content}`;
    })
    .join('\n\n');

  return `<runtime_handoff_context>
This conversation was running on a different runtime (${from}) and has just been moved here.
The transcript below is what happened before the move. Treat it as this conversation's history and continue it.
Tool results and file state described below were produced by the previous runtime; re-check anything you depend on rather than assuming it is still true.

${formatted}
</runtime_handoff_context>`;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
bun test packages/shared/src/agent/__tests__/runtime-handoff-context.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Wire the seam into the turn**

In `packages/shared/src/agent/backend/types.ts`, beside `getBranchSeedMessages` (`:568`):

```ts
  /** Transcript to hand a runtime that has just taken over this session (one-shot). */
  getRuntimeHandoffMessages?: () => { from: string; messages: RecoveryMessage[] } | null;
  markRuntimeHandoffApplied?: () => void;
```

In `packages/shared/src/agent/base-agent.ts`, inside `chatImpl`'s context assembly, immediately after the `branchSeedContext` block (`:3674-3677`):

```ts
      const handoff = this.config.getRuntimeHandoffMessages?.();
      const runtimeHandoffContext = handoff
        ? buildRuntimeHandoffContext(handoff.from, handoff.messages)
        : null;
      if (runtimeHandoffContext) {
        this.config.markRuntimeHandoffApplied?.();
      }
```

and add it to `messageParts` (`:3707`) directly after `branchSeedContext`:

```ts
      const messageParts = [capabilityContext, branchSeedContext, runtimeHandoffContext, transferredSessionContext, continuationRestore, pinnedSkills, forkedSkills, cleanMessage].filter(Boolean);
```

- [ ] **Step 6: Arm it from the SessionManager**

Add two fields to `ManagedSession` beside `transferredSessionSummaryApplied` (`:1674`; `branchSeedApplied` is at `:1670`, not `:1648`) — and the same two to `SessionConfig` in `packages/shared/src/sessions/types.ts`, or `pickSessionFields` cannot see them:

```ts
  /** Provider this session was moved OFF, until the new runtime has been given its context. */
  runtimeHandoffFrom?: AgentProvider
  runtimeHandoffApplied?: boolean
```

Add both to `SESSION_PERSISTENT_FIELDS` in `packages/shared/src/sessions/types.ts` (the "Remote transfer handoff" group is the right neighbourhood):

```ts
  'runtimeHandoffFrom', 'runtimeHandoffApplied',
```

**And copy them in the two hydration paths** (addition 1 above) — the array alone writes them to disk and never reads them back:

```ts
// SessionManager.ts, `hydrateMessagesForColdPersist` (:8538), beside the transfer summary
if (managed.runtimeHandoffFrom === undefined) managed.runtimeHandoffFrom = stored.runtimeHandoffFrom
if (managed.runtimeHandoffApplied === undefined) managed.runtimeHandoffApplied = stored.runtimeHandoffApplied

// SessionManager.ts, `loadMessagesFromDisk` (:9586), same neighbourhood
managed.runtimeHandoffFrom = storedSession.runtimeHandoffFrom
managed.runtimeHandoffApplied = storedSession.runtimeHandoffApplied
```

In `getOrCreateAgentUnchecked`, beside `getBranchSeedMessages` (`:13328`, not `:13286`), add:

```ts
      const getRuntimeHandoffMessages = () => {
        if (!managed.runtimeHandoffFrom || managed.runtimeHandoffApplied) return null
        const messages = managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)
          .map(m => ({ type: m.role as 'user' | 'assistant', content: m.content }))
        if (messages.length === 0) return null
        return { from: managed.runtimeHandoffFrom, messages }
      }

      const markRuntimeHandoffApplied = () => {
        if (managed.runtimeHandoffApplied || !managed.runtimeHandoffFrom) return
        managed.runtimeHandoffApplied = true
        managed.runtimeHandoffFrom = undefined
        this.persistSession(managed)
        sessionLog.info(`Runtime handoff context applied for ${managed.id}`)
      }
```

and pass both in the backend config beside `markBranchSeedApplied` (`:13639`, not `:13567`):

```ts
        getRuntimeHandoffMessages,
        markRuntimeHandoffApplied,
```

In `switchSessionRuntime`, first load the transcript — `managed.messages` is lazy, and it is the input to every decision below (addition 2 above). Immediately before `const fromProvider = …`:

```ts
    await this.ensureMessagesLoaded(managed)
```

Then replace the cross-runtime branch from Task 3 — note T3 landed `clearRuntimeScopedSessionState(managed, fromProvider)` with a SECOND argument, which this snippet predates:

```ts
    if (kind === 'connection-cross-runtime') {
      this.clearRuntimeScopedSessionState(managed, fromProvider)
      contextCarried = 'handoff'   // Task 4 arms the handoff itself.
    } else if (...
```

with:

```ts
    if (kind === 'connection-cross-runtime') {
      this.clearRuntimeScopedSessionState(managed, fromProvider)
      const hasHistory = managed.messages.some(m => (m.role === 'user' || m.role === 'assistant') && !m.isIntermediate)
      managed.runtimeHandoffFrom = hasHistory ? fromProvider : undefined
      managed.runtimeHandoffApplied = false
      contextCarried = hasHistory ? 'handoff' : 'none'
      // Gated on the same predicate (Step 0 decision): with nothing above it, a
      // "the runtime changed" row is the FIRST thing in the transcript and
      // explains a discontinuity that never happened. Choosing an integration
      // on a fresh session is the common gesture, not a mid-conversation move.
      if (hasHistory) this.appendRuntimeSwitchNotice(managed, fromProvider, toProvider)
    } else if (...
```

Add the transcript notice below `clearRuntimeScopedSessionState`:

```ts
  /**
   * A visible marker in the transcript at the point the runtime changed.
   *
   * Without it a mixed transcript — tool calls under one runtime's wire names
   * followed by another's — looks like a rendering bug, and a user who scrolls
   * up has nothing telling them why the assistant "forgot" the tool output
   * above the line.
   */
  private appendRuntimeSwitchNotice(managed: ManagedSession, from: AgentProvider, to: AgentProvider): void {
    const message: Message = {
      id: generateMessageId(),
      role: 'info',
      content: `runtime_switched:${from}:${to}`,
      timestamp: this.monotonic(),
    }
    managed.messages.push(message)
    this.sendEvent(
      { type: 'message_added', sessionId: managed.id, message: toSessionMessage(message) },
      managed.workspace.id,
    )
  }
```

**Three corrections in that ten-line block, all found at Step 0:**

- `role: 'system'` → **`role: 'info'`**. `MessageRole` has no `'system'` member; this is Wave-0 decision D1, which this snippet predates.
- `id`/`timestamp` follow the file's own precedent for an appended row (`:4224`): `generateMessageId()` (already imported, `:212`) and `this.monotonic()`. A `Date.now()` id is neither unique nor the id shape the rest of the transcript branches from.
- In `SessionManager.ts`, `Message` is an alias for **`PersistedMessage`** (`:219`) and the wire type is `RendererMessage` (`:218`). The event carries the wire shape, so the row goes through `toSessionMessage` (`:2169`) like every other event that ships a message — without it `tsc` fails on `attachments`.

- [ ] **Step 7: Add the SessionManager-level handoff test — and repair the two T3 tests this task turns red**

**Corrected at Step 0:** `createSwitchHarness` is SYNCHRONOUS and its option is `from` (defaulting to `'pi-source'`), not `provider` — `await createSwitchHarness({ provider: 'pi' })` as written compiles to a session on the default connection anyway, so the option was inert rather than wrong. `managed` is a `Record<string, unknown>`, so a read of `managed.messages` needs a cast.

**Two of T3's own tests fail the moment this task lands, and both changes are correct**, so they are repaired here rather than worked around:

- *"cross-runtime switch reports a handoff and clears Pi-scoped state"* asserted `contextCarried === 'handoff'` on a session with **no messages**. Under T4 an empty session reports `'none'` — that is this task's second test. The fixture gains a message.
- *"keeps the transcript and the queued messages"* asserted `toHaveLength(1)`; the notice makes it 2. Rewritten to assert the original row is still there **and** untouched, which is what the test was actually guarding.

Append to `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts`:

```ts
describe('cross-runtime handoff', () => {
  it("arms the handoff with the session's own transcript", async () => { … })
  // Negative subject: neither the arming NOR the notice may fire with nothing
  // to hand over — one test measuring both.
  it('does not arm a handoff, or write a notice, for a session with no transcript', async () => { … })
  // Negative subject for the RUNTIME half: same-runtime change, with a
  // transcript, arms nothing.
  it('does not arm a handoff for a same-runtime connection change', async () => { … })
  // Positive control for the lazy-transcript fix: `messagesLoaded: false`, a
  // stubbed loader that supplies the row, and the switch must still report a
  // handoff. Remove the `ensureMessagesLoaded` await and ONLY this goes red.
  it('loads a cold transcript before deciding whether a handoff is owed', async () => { … })
  it('writes a switch notice into the transcript', async () => { … })   // also asserts role === 'info'
  // The seam's body, reproduced against the same managed session: armed → the
  // transcript minus `isIntermediate` rows; applied → null.
  it('hands the transcript over exactly once', async () => { … })
})
```

- [ ] **Step 8: Run the tests**

```bash
bun test packages/shared/src/agent/__tests__/runtime-handoff-context.test.ts packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts
bun run typecheck:all
```

Expected: all PASS, typecheck exit 0.

- [ ] **Step 9: Update the tracker row for T4, then commit**

```bash
git add packages/shared/src/agent/base-agent.ts packages/shared/src/agent/backend/types.ts packages/shared/src/agent/__tests__/runtime-handoff-context.test.ts packages/shared/src/sessions/types.ts packages/server-core/src/sessions/SessionManager.ts packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "feat(sessions): hand the session transcript to a runtime taking over mid-conversation"
```

---

### Task 5: Protocol and the picker

**Files** (corrected at Step 0):
- Modify: `packages/shared/src/protocol/dto.ts` (`ComposerCapabilities` at `:77`, its `permissions` line at `:92`; `SessionCommand` at `:570`, **not `:566`**)
- Modify: `packages/shared/src/agent/backend/composer-capabilities.ts` (`resolveComposerCapabilities` `:147`; `thresholdKind` lives inside `resolveContextUsageCapability` and was NOT touched)
- Modify: `packages/server-core/src/handlers/rpc/sessions.ts:762`, `packages/server-core/src/handlers/session-manager-interface.ts:156` — both anchors HELD
- Modify: `apps/electron/src/renderer/components/app-shell/input/picker-mode.ts`
- Create: `.../input/RuntimeSwitchDialog.tsx`, `.../input/runtime-switch-copy.ts`, **and `.../input/ConnectionRow.tsx`** — the Files block omitted it while Step 3's own doc-comment references it, and the plan's global File Structure lists it
- Modify: `CompactModelSelector.tsx`, `FreeFormInput.tsx`, `ChatPage.tsx`, **`ChatDisplay.tsx`** (D1: rendering the `runtime_switched:` marker into human copy is T5's), **`composer-capabilities-context.tsx`** (the renderer's `DEFAULT_COMPOSER_CAPABILITIES` must supply every REQUIRED capability field), **`playground/registry/runtime-switch.tsx`** (the `modelPickerSlot` seam and its entry are deleted here)
- Modify: `packages/shared/src/i18n/locales/{en,ru}.json`. **Not** `apps/electron/src/renderer/locales/*.json` — that directory does not exist, as the plan's own File Structure already says.
- Test: `.../input/__tests__/picker-mode.test.ts` (rewritten), `.../input/__tests__/runtime-switch-copy.test.ts` (new), `packages/shared/src/agent/backend/__tests__/composer-capabilities.test.ts` (extend), `apps/electron/src/renderer/lib/__tests__/composer-permission-modes.test.ts` (its fixture builds a whole `ComposerCapabilities`)

**Interfaces:**
- Consumes: `RuntimeSwitchResult` and `switchSessionRuntime` (Task 3); `RuntimeSwitchKind` (Task 16).
- Produces:
  - `runtimeSwitchCopyKey(kind: RuntimeSwitchKind, hasHistory: boolean): { titleKey; bodyKey; confirmKey } | null` — `null` means no dialog
  - `classifyConnectionSwitch(from, to): RuntimeSwitchKind` — the renderer's copy of the server's classifier, so the tier is known BEFORE the switch runs
  - `runtimeForProviderType`, `runtimeLabel`, `RUNTIME_SWITCH_MARKER`, `parseRuntimeSwitchMarker`
  - `ComposerCapabilities.connection: { switchable: boolean; activeRuntime: ModelProvider }` — `ModelProvider`, not `AgentProvider`: they are the same type (`backend/types.ts:105` is an alias) and `ModelProvider` is what `dto.ts` and T16's `runtime-switch.ts` already reach for.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Rewrite the picker-mode test around two controls**

The picker has, since #727, decided between four mutually exclusive layouts, one of which (`switcher`) is a hierarchical connection → model tree. That tree is what makes one tap change both the integration and the model, and it is the reason a "did you mean to change runtime?" question had to be inferred from where the tap landed. Two separate controls remove the inference: the model list only ever lists the ACTIVE integration's models, and the integration is its own row above it.

Replace the whole of `apps/electron/src/renderer/components/app-shell/input/__tests__/picker-mode.test.ts` with:

```ts
import { describe, expect, it } from 'bun:test'
import { derivePickerMode } from '../picker-mode'

describe('derivePickerMode', () => {
  it('puts an unavailable connection first', () => {
    expect(derivePickerMode({ connectionUnavailable: true, connectionDefaultModel: 'm' })).toBe('unavailable')
  })

  it('renders a single-model connection as a label, not a list', () => {
    expect(derivePickerMode({ connectionUnavailable: false, connectionDefaultModel: 'qwen' })).toBe('locked-single')
  })

  it('renders the active connection\'s models otherwise', () => {
    expect(derivePickerMode({ connectionUnavailable: false, connectionDefaultModel: null })).toBe('flat')
  })

  it('no longer depends on how many connections exist — the integration row owns that', () => {
    // Regression guard for #727: a user whose only connection was a
    // single-model pi_compat used to be unreachable by the switcher because
    // the two branches competed for precedence. With the integration row
    // always present, there is nothing to compete with.
    expect(derivePickerMode({ connectionUnavailable: false, connectionDefaultModel: 'qwen' })).toBe('locked-single')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

**Corrected at Step 0 — the red is a TYPE error, not a test failure.** `bun test` does not typecheck, and the rewritten fixture omits `isEmptySession`/`connectionCount`, which read as `undefined` and make the `switcher` branch unreachable at runtime. Measured: `bun test …/picker-mode.test.ts` → **5 pass / 0 fail** against the OLD implementation. The red that matters is:

```bash
cd apps/electron && bun run typecheck
```

Measured: `picker-mode.test.ts(18,3): error TS2322: Type '{ … isEmptySession?: boolean | undefined; connectionCount?: number | undefined; }' is not assignable to type 'PickerModeInput'.`

A "run it to verify it fails" step whose command cannot observe the failure is worse than no step: it reports green and reads as proof.

- [ ] **Step 3: Collapse the picker mode to three layouts**

Rewrite `picker-mode.ts` so it decides only how the MODEL list renders. The integration is no longer one of its outcomes:

```ts
/**
 * Pure render-mode decision for the chat-input MODEL list.
 *
 * The integration is deliberately NOT one of these outcomes any more. It used
 * to be — mode `switcher` rendered a provider → connection → model tree, and a
 * tap on a model inside another connection changed the integration and the
 * model at once. That single gesture is what forced the runtime question to be
 * inferred from where the tap landed. The integration now has its own row
 * ({@link ConnectionRow}) above this list, so the two gestures cannot be
 * confused and the confirmation attaches to exactly one control.
 *
 * Precedence (highest first):
 *   1. unavailable   — the active connection is gone / errored
 *   2. locked-single — the active connection offers one model; render it as a label
 *   3. flat          — the active connection's models
 */
export type PickerMode = 'unavailable' | 'locked-single' | 'flat'

export interface PickerModeInput {
  connectionUnavailable: boolean
  /** Non-null when the active connection is `pi_compat` with ≤1 model. */
  connectionDefaultModel: string | null
}

export function derivePickerMode(input: PickerModeInput): PickerMode {
  if (input.connectionUnavailable) return 'unavailable'
  if (input.connectionDefaultModel != null) return 'locked-single'
  return 'flat'
}
```

**Superseded reference — the old body, for the reviewer diffing this task.** It replaced the `isEmptySession` field and the branch:

```ts
  /** True when the session has no messages yet. */
  isEmptySession: boolean
```

```ts
  if (input.isEmptySession && input.connectionCount > 1) return 'switcher'
```

with:

```ts
  /**
   * True when this session may still change connection. Previously this was
   * `isEmptySession`, because a connection locked at the first message; a
   * session can now switch at any idle moment, so the flag is the SERVER's
   * answer (`ComposerCapabilities.connection.switchable`) rather than a
   * transcript-length guess the renderer makes for itself.
   */
  canSwitchConnection: boolean
```

```ts
  if (input.canSwitchConnection && input.connectionCount > 1) return 'switcher'
```

Update the precedence doc-comment's item 2 accordingly.

- [ ] **Step 4: Run it to verify it passes**

```bash
bun test apps/electron/src/renderer/components/app-shell/input/__tests__/picker-mode.test.ts
```

Expected: PASS.

- [ ] **Step 5: Extend the protocol**

In `packages/shared/src/protocol/dto.ts`, add to `ComposerCapabilities` (after `permissions`, `:90`):

```ts
  connection: { switchable: boolean; activeRuntime: AgentProvider }
```

and to the `SessionCommand` union (`:566`):

```ts
  | { type: 'switchRuntime'; connectionSlug: string }
```

In `composer-capabilities.ts`, add to the returned object in `resolveComposerCapabilities`:

```ts
    // A remote connection is not switchable in either direction, and a session
    // with no configured connections has nothing to switch to.
    connection: {
      switchable: input.provider !== 'nestor-cloud-agent',
      activeRuntime: input.provider,
    },
```

In `packages/server-core/src/handlers/session-manager-interface.ts`, beside `setSessionConnection` (`:156`):

```ts
  switchSessionRuntime(sessionId: string, connectionSlug: string, workspaceId?: string): Promise<RuntimeSwitchResult>
```

In `packages/server-core/src/handlers/rpc/sessions.ts`, after the `setConnection` case (`:764`):

```ts
      case 'switchRuntime':
        log.info(`IPC: switchRuntime received for session ${sessionId}, connection: ${command.connectionSlug}`)
        return sessionManager.switchSessionRuntime(sessionId, command.connectionSlug, workspaceId)
```

- [ ] **Step 6: Write the dialog-copy test**

Create `apps/electron/src/renderer/components/app-shell/input/__tests__/runtime-switch-copy.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { runtimeSwitchCopyKey } from '../runtime-switch-copy'

describe('runtimeSwitchCopyKey', () => {
  it('asks nothing for a model change', () => {
    expect(runtimeSwitchCopyKey('model', true)).toBeNull()
  })

  it('asks nothing on an empty session, whatever the tier', () => {
    expect(runtimeSwitchCopyKey('connection-cross-runtime', false)).toBeNull()
  })

  it('warns about the restart for a same-runtime switch', () => {
    expect(runtimeSwitchCopyKey('connection-same-runtime', true)?.bodyKey)
      .toBe('chat.runtimeSwitch.sameRuntimeBody')
  })

  it('warns about lost runtime memory for a cross-runtime switch', () => {
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true)?.bodyKey)
      .toBe('chat.runtimeSwitch.crossRuntimeBody')
  })
})
```

- [ ] **Step 7: Implement the copy map and the dialog**

Create `apps/electron/src/renderer/components/app-shell/input/runtime-switch-copy.ts`:

```ts
import type { RuntimeSwitchKind } from '@nessy-agent/shared/protocol'

export interface RuntimeSwitchCopy {
  titleKey: string
  bodyKey: string
  confirmKey: string
}

/**
 * Which switches are worth interrupting the user for.
 *
 * Claude Code's picker "asks for confirmation when the conversation has prior
 * output, since the next response re-reads the full history without cached
 * context" — the confirmation is scoped to the transition that actually costs
 * something, not attached to every model pick. Same rule here, one tier
 * sharper because our cross-runtime tier loses more than a cache.
 */
export function runtimeSwitchCopyKey(kind: RuntimeSwitchKind, hasHistory: boolean): RuntimeSwitchCopy | null {
  if (!hasHistory) return null
  if (kind === 'model') return null
  if (kind === 'connection-same-runtime') {
    return {
      titleKey: 'chat.runtimeSwitch.sameRuntimeTitle',
      bodyKey: 'chat.runtimeSwitch.sameRuntimeBody',
      confirmKey: 'chat.runtimeSwitch.confirm',
    }
  }
  return {
    titleKey: 'chat.runtimeSwitch.crossRuntimeTitle',
    bodyKey: 'chat.runtimeSwitch.crossRuntimeBody',
    confirmKey: 'chat.runtimeSwitch.confirm',
  }
}
```

The dialog's cross-runtime body will render the **capability delta** from `RuntimeSwitchResult.capabilityDelta` (Task 17) beneath the fixed consequences, omitting any line whose count is zero. This is the plan's own Open question 2 answered: yes, enumerate what stops — the delta is computable from the outgoing runtime's view and nothing else in the product surfaces it. **T5 ships the fixed consequences only**; the delta arrives with the field that carries it, in T17.

Create `RuntimeSwitchDialog.tsx` on `@/components/ui/dialog` — `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter` plus `Button` and `useRegisterModal`, the shape `ResetConfirmationDialog.tsx` uses. **There is no `alert-dialog` component in this repo**; `components/ui/` has `dialog.tsx`, `drawer.tsx` and `context-menu.tsx`, and the only `alert-dialog` string in the renderer is a CSS token, rendering `t(copy.titleKey)`, `t(copy.bodyKey, { from, to })`, a cancel button on `common.cancel` and a confirm button on `t(copy.confirmKey)`.

- [ ] **Step 8: Add the i18n keys to every locale**

**Corrected at Step 0 — the locale files are FLAT dot-notation, not nested.** A nested `"runtimeSwitch": { … }` object under `chat` would fail `lint:i18n:sorted` and be unreachable from `t('chat.runtimeSwitch.confirm')`. Nine flat keys go into `en.json` and `ru.json`, in alphabetical position:

`chat.runtimeSwitch.busy`, `.confirm`, `.crossRuntimeBody`, `.crossRuntimeTitle`, `.failed`, **`.integration`** (the section label on the new row), **`.notice`** (the transcript marker's human copy — D1 gives T5 the rendering), `.sameRuntimeBody`, `.sameRuntimeTitle`.

**`crossRuntimeCapabilities` is NOT added.** It interpolates `{{monitors}}/{{lsp}}/{{hooks}}/{{sources}}` from `RuntimeSwitchResult.capabilityDelta`, which is **Task 17's** field and does not exist. A key with no call site is a translated string nobody can reach and a false signal that the feature is present; T17 adds it with the code that fills it.

The two body strings interpolate `{{fromRuntime}}`/`{{toRuntime}}` as well as `{{from}}`/`{{to}}`: the dialog names the RUNTIMES ("Pi", "Claude", "Codex") in the sentence and the CONNECTIONS in the header row above it, because two connections with the same name pattern can sit on different runtimes and the sentence is the half that explains the cost.

- [ ] **Step 9: Route the pickers through the dialog**

In `ChatPage.tsx`, replace `handleConnectionChange` (`:308`):

```ts
  const handleConnectionChange = React.useCallback(async (connectionSlug: string) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'switchRuntime', connectionSlug })
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      toast.warning(t(code === 'SESSION_BUSY' ? 'chat.runtimeSwitch.busy' : 'chat.runtimeSwitch.failed'))
    }
  }, [sessionId, t])
```

**Corrected at Step 0.** This step describes the SUPERSEDED single-tree design — `canSwitchConnection` into `derivePickerMode`, and a dialog wrapped around the cross-connection model handlers. The owner's "two controls, not one tree" decision (Deviations log, 2026-08-14) retires both: `switchable` never reaches `derivePickerMode` (which now decides only how the model list renders), and there are no cross-connection model handlers left to wrap, because the model list only ever carries the ACTIVE integration's models.

What actually lands in the two pickers:

- `derivePickerMode` is called with two fields, and `handlePickSwitcherModel` / the hierarchical `onSelect` branch are **deleted** along with the whole `switcher` UI (96 lines in `CompactModelSelector.tsx`, 110 in `FreeFormInput.tsx`).
- `<ConnectionRow>` is rendered above the model list in both, reading `switchable` from `useComposerCapabilities()` and `hasHistory` from `!isEmptySession`. It owns the confirmation: it computes the tier with `classifyConnectionSwitch`, asks `runtimeSwitchCopyKey`, and either calls `onSwitch` straight away or opens `RuntimeSwitchDialog` and calls it on confirm.
- `busy` is threaded from the composer's existing `isProcessing`, so the row can say WHY it will not move rather than looking broken. `CompactModelSelector` gains an `isProcessing` prop for it.
- The flat list's "using {connection}" header line is removed: the integration row says the same thing one row up, and now also names the runtime.
- `modelPickerSlot` (`FreeFormInput.tsx`) and the `runtime-switch-in-real-composer` playground entry are deleted, as that prop's own docstring instructs.

- [ ] **Step 10: Run the renderer tests and the i18n gates**

```bash
bun test apps/electron/src/renderer/components/app-shell/input/__tests__/
bun run lint:i18n:parity
bun run lint:i18n:sorted
bun run typecheck:all
```

Expected: all PASS / exit 0.

- [ ] **Step 11: Update the tracker row for T5, then commit**

**No directory pathspecs** (Parallelisation §6 rule 4): `packages/server-core/src/handlers` and `apps/electron/src/renderer` would each sweep another session's uncommitted files. Name every file.

```bash
git add packages/shared/src/protocol/dto.ts \
  packages/shared/src/agent/backend/composer-capabilities.ts \
  packages/shared/src/agent/backend/__tests__/composer-capabilities.test.ts \
  packages/shared/src/i18n/locales/en.json packages/shared/src/i18n/locales/ru.json \
  packages/server-core/src/handlers/rpc/sessions.ts \
  packages/server-core/src/handlers/session-manager-interface.ts \
  apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx \
  apps/electron/src/renderer/components/app-shell/input/{ConnectionRow,RuntimeSwitchDialog}.tsx \
  apps/electron/src/renderer/components/app-shell/input/{runtime-switch-copy,picker-mode}.ts \
  apps/electron/src/renderer/components/app-shell/input/composer-capabilities-context.tsx \
  apps/electron/src/renderer/components/app-shell/input/{CompactModelSelector,FreeFormInput}.tsx \
  apps/electron/src/renderer/components/app-shell/input/__tests__/{picker-mode,runtime-switch-copy}.test.ts \
  apps/electron/src/renderer/lib/__tests__/composer-permission-modes.test.ts \
  apps/electron/src/renderer/pages/ChatPage.tsx \
  apps/electron/src/renderer/playground/registry/runtime-switch.tsx \
  docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "feat(chat): offer a mid-session integration switch with a tiered confirmation"
```

---

### Task 16: The shared wire surface

**Found by** the parallelisation analysis, before any task ran. **It unblocks** T3, T4, T5, T9, T10, T11, T12 and T13 — every one of them declares a type, an event or an error code that does not exist today, and none of them declares the file that must hold it. Landing them in one commit with no other consumer is also the only thing that makes T4 ‖ T5 legal; without it those two collide head-on in `dto.ts` and the renderer, and the schedule is thirteen waves instead of twelve.

Everything here is a new union member or an optional field, so `typecheck:all` stays green and nothing behaves differently — except the renderer event case, which is tested.

**Files:**
- Modify: `packages/shared/src/protocol/dto.ts` (the `SessionEvent` union, `:361-465`)
- Modify: `packages/shared/src/protocol/types.ts` (`ErrorCode` `:100`, `KNOWN_ERROR_CODES` `:102`)
- Create: `packages/shared/src/protocol/runtime-switch.ts`
- Modify: `packages/core/src/types/message.ts` — **the two `Message` fields only.** Do not touch `ContextUsageSnapshot.source` (`:625`): that is lane F's risk trigger and F4 replaces the discriminant.
- Modify: `apps/electron/src/shared/types.ts:408` (`sessionCommand`'s return union)
- Modify: `apps/electron/src/renderer/event-processor/types.ts`, `processor.ts`, `handlers/session.ts`
- Test: `apps/electron/src/renderer/event-processor/__tests__/message-added.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SessionEvent | { type: 'message_added'; sessionId: string; message: Message }`; the error codes `SESSION_BUSY`, `CONNECTION_NOT_SWITCHABLE`, `CONNECTION_IN_USE`, `WORKTREE_EXIT_UNAVAILABLE`, `WORKTREE_DIRTY`; `RuntimeSwitchKind` and `RuntimeSwitchResult` in `packages/shared/src/protocol/runtime-switch.ts`; `Message.runtime?: AgentProvider` and `Message.llmConnection?: string` on `Message` and `StoredMessage`; `RuntimeSwitchResult` in `sessionCommand`'s return union.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks.

- [ ] **Step 1: Write the failing renderer test**

The one behaviour in this task. `dto.ts` alone would compile green and the notice would land in the reducer's `default:` arm forever, because the renderer checks exhaustiveness against its OWN mirror union (`event-processor/types.ts:227`) and `App.tsx:973` double-casts (`event as unknown as AgentEvent`).

Create `apps/electron/src/renderer/event-processor/__tests__/message-added.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { processEvent } from '../processor'

describe('message_added', () => {
  it('appends the message to the session transcript', () => {
    const session = { id: 's1', messages: [{ id: 'm1', role: 'user', content: 'hi' }] } as never
    const next = processEvent(session, {
      type: 'message_added',
      sessionId: 's1',
      message: { id: 'm2', role: 'info', content: 'runtime_switched:pi:anthropic', timestamp: 1 },
    } as never)
    expect(next.session.messages).toHaveLength(2)
    expect(next.session.messages.at(-1)?.content).toBe('runtime_switched:pi:anthropic')
  })

  it('ignores an event for a different session', () => {
    const session = { id: 's1', messages: [] } as never
    const next = processEvent(session, {
      type: 'message_added', sessionId: 's2',
      message: { id: 'm2', role: 'info', content: 'x', timestamp: 1 },
    } as never)
    expect(next.session.messages).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test apps/electron/src/renderer/event-processor/__tests__/message-added.test.ts
```

Expected: FAIL — `message_added` is not a member of the event union and falls to the reducer's default arm.

- [ ] **Step 3: Add the wire declarations**

In `packages/shared/src/protocol/dto.ts`, add to the `SessionEvent` union:

```ts
  | { type: 'message_added'; sessionId: string; message: Message }
```

In `packages/shared/src/protocol/types.ts`, add all five codes to **both** the `ErrorCode` union and the `KNOWN_ERROR_CODES` Set — the Set is a hand-maintained mirror and a code missing from it is accepted by the compiler and rejected at runtime:

```ts
  | 'SESSION_BUSY'
  | 'CONNECTION_NOT_SWITCHABLE'
  | 'CONNECTION_IN_USE'
  | 'WORKTREE_EXIT_UNAVAILABLE'
  | 'WORKTREE_DIRTY'
```

Create `packages/shared/src/protocol/runtime-switch.ts`:

```ts
import type { AgentProvider } from '../agent/backend/types.ts'

/**
 * How much a connection change costs the session. Declared in `shared/protocol`
 * and not in `server-core` because the RENDERER needs it for the confirmation
 * copy, and the renderer cannot import server-core. The classifier that
 * produces it lives in server-core; only the vocabulary is shared.
 */
export type RuntimeSwitchKind = 'model' | 'connection-same-runtime' | 'connection-cross-runtime'

export interface RuntimeSwitchResult {
  kind: RuntimeSwitchKind
  contextCarried: 'runtime-anchor' | 'handoff' | 'none'
  model: string
  /** Filled by Task 12. Attachments the target runtime cannot accept. */
  droppedAttachments?: string[]
  /** Filled by Task 13. Background children stopped to make the switch safe. */
  stoppedChildren?: string[]
  /** Provider the session left, when it changed. */
  from?: AgentProvider
  to?: AgentProvider
}
```

In `packages/core/src/types/message.ts`, add `runtime?: AgentProvider` and `llmConnection?: string` to both `Message` and `StoredMessage`. **Nothing else in that file** — `ContextUsageSnapshot.source` (`:625`) belongs to the neighbouring plan's lane F.

In `apps/electron/src/shared/types.ts:408`, add `RuntimeSwitchResult` to `sessionCommand`'s return union — it is a hand-written closed union and is **not** covered by the `export *` on line 4.

- [ ] **Step 4: Add the renderer case**

Mirror the union member in `event-processor/types.ts`, then handle it in `handlers/session.ts` — append `event.message` to `session.messages` when `event.sessionId` matches — and route it from `processor.ts` so it never reaches the default arm.

- [ ] **Step 5: Run the test and the affected suites**

```bash
bun test apps/electron/src/renderer/event-processor/__tests__/
bun run typecheck:all
```

Expected: PASS, exit 0. Nothing else changes behaviour — every other addition is a declaration with no consumer yet.

- [ ] **Step 6: Return the tracker row to the orchestrator, then commit**

Do **not** add the plan file (see the tracker rule in Parallelisation §6). Return the row as text; the orchestrator writes it at the wave boundary.

```bash
git add packages/shared/src/protocol/dto.ts packages/shared/src/protocol/types.ts packages/shared/src/protocol/runtime-switch.ts packages/core/src/types/message.ts apps/electron/src/shared/types.ts apps/electron/src/renderer/event-processor/types.ts apps/electron/src/renderer/event-processor/processor.ts apps/electron/src/renderer/event-processor/handlers/session.ts apps/electron/src/renderer/event-processor/__tests__/message-added.test.ts
git commit -m "feat(protocol): the shared wire surface runtime switching needs"
```


---

### Task 7: Stop the Pi loops that outlive their runtime

Three Pi-owned schedulers keep firing after the session has moved. All three predate this feature and all three are reachable through it, so they land here rather than in a follow-up.

**Rescoped at Step 0, 2026-08-15 — two of the three were already closed by T3.** `clearRuntimeScopedSessionState` (`SessionManager.ts:14969`) clears `goalState`, deletes the goal service, `stop()`s **and** deletes the cron service, and calls `sessionMonitors.stopAll` — so the cron timer and the ws monitors do not survive a switch, and `stopAll` already has the production caller this task was written to give it. This is the outcome the Execution protocol predicted for exactly this task ("three of its tests go green the moment T3 lands"), and the response it prescribes is to rewrite the test list rather than implement a task whose reason has partly evaporated.

What is left is the two provider GATES, and the first one is the reason the task is not superseded outright: the goal continuation's choke point is reachable **without a switch at all**.

**Files:**
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (`:3880` `schedulePiGoalContinuation`, `:3213` `getOrCreatePiCronService`'s deliver closure, `:4143` the `SessionMonitorService` deliver callback; new `deliverPiMonitorEvent` beside `deliverMonitorEvent` `:3138`)
- ~~Modify: `packages/server-core/src/sessions/session-monitor-service.ts:163`~~ — `stopAll` got its first caller in T3 (`SessionManager.ts:14976`); the file is untouched here.
- Test: `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveManagedProvider` (existing, `SessionManager.ts:6634`), `MonitorDelivery` (existing, `session-monitor-service.ts:39`).
- Produces: `deliverPiMonitorEvent(delivery: MonitorDelivery): void` — a private gate in front of the shared sink, for the two Pi-owned producers only.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing tests**

**Rewritten at Step 0.** The three tests below were the original list; all three measure T3's `clearRuntimeScopedSessionState`, not this task, and all three pass on the tree as it stands. They are struck rather than deleted so a reviewer can see what moved and why. Their harness options were also inert (`provider` is not a `HarnessOptions` key — the field is `from`; there is no `withCron` or `withWsMonitor`), which is a second reason none of them could have been run as written.

- ~~`does not re-arm the goal continuation on a non-Pi provider` (asserting `managed.goalState === undefined` after a switch)~~ — T3 clears it at `:14958`.
- ~~`stops the session cron timer on a switch`~~ — T3 calls `piCronServices.get(key)?.stop()` at `:14969`, and `getOrCreatePiCronService` is only ever called for `provider === 'pi'` (`:13100`), so nothing recreates it.
- ~~`stops ws monitors on a switch`~~ — T3 calls `sessionMonitors.stopAll(...)` at `:14976`.

The five that replace them measure the two gates this task adds, each with its negative subject, plus the anti-over-gate control:

```ts
describe('Pi schedulers do not outlive their runtime', () => {
  // The live hole T3 does NOT close: `onProcessingStopped` (`:19226`) re-arms
  // after every completed turn with no provider gate, and `goalState` is in
  // `SESSION_PERSISTENT_FIELDS`.
  it('does not re-arm the goal continuation on a non-Pi provider', () => {
    const { manager, managed } = createSwitchHarness({ from: 'claude-gateway' })
    managed.goalState = activeGoalState() as never
    scheduleGoal(manager, managed)
    expect(managed.piGoalContinuationRunning).toBeUndefined()
    expect(goalServices(manager).has(`${managed.workspace.id}:${managed.id}`)).toBe(false)
  })

  it('still re-arms the goal continuation on Pi', () => { /* same call, `from: 'pi-source'` → true/true */ })

  it('drops a Pi monitor/cron delivery once the session has left Pi', () => { /* deliverPiMonitorEvent, `from: 'codex-gateway'` */ })
  it('still delivers a Pi monitor/cron event while the session is on Pi', () => { /* … `from: 'pi-source'` */ })

  // Anti-over-gate control — see Step 4.
  it('leaves the shared monitor sink open on a non-Pi provider', async () => {
    const { manager, managed } = createSwitchHarness({ from: 'codex-gateway' })
    await deliverMonitorEvent(manager, delivery(managed))
    expect(managed.pendingTaskNotifications).toEqual(['watch fired'])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts
```

Expected: FAIL on the two gated rows — the goal arms on Claude, the monitor delivery is queued on Codex. The three ungated rows (both negative subjects and the sink control) pass before and after, which is what makes them controls rather than assertions.

- [ ] **Step 3: Gate the goal continuation on the provider**

At `SessionManager.ts:3880`, open `schedulePiGoalContinuation` with the gate (the comment in the code also records WHY it sits at the choke point rather than at the call sites):

```ts
    if (this.resolveManagedProvider(managed) !== 'pi') return
```

Six of the eight call sites are already pi-gated — `controlPiAgentView` and the goal-control method both throw `pi-runtime-provider-required` first, and `emitPiHarnessInvalidation` returns. **Two are not**, and both fire on ordinary traffic: `onProcessingStopped` (`:19226`) re-arms after every completed turn, and the background-task completion handler (`:20554`) re-arms whenever a child settles. Since `goalState` is in `SESSION_PERSISTENT_FIELDS` (`packages/shared/src/sessions/types.ts:50`) and a connection's own `providerType` can be edited — which respawns the backend through `tryRefreshAgentRuntime` and clears neither the state nor the service — this hole is reachable **without any switch at all**. That is why the task survives T3.

- [ ] **Step 4: Gate the Pi-owned monitor producers — NOT the shared sink**

**Corrected at Step 0. The instruction as written was a regression.** `deliverMonitorEvent` (`:3138`, not `:3106`) is the shared sink for five producers, and three of them are live on every runtime: MCP channel pushes (`ensureSessionChannelSubscription` `:2792`, whose pool is leased for **all** backends — `:13151`, "all backends use it"), R10 detached MCP results, and R86 background-task completions. A `provider !== 'pi'` gate there would silently drop a channel push on Claude and Codex.

The gate goes on the two producers that do belong to Pi — the ws monitor service (`:4143`) and the session cron (`:3213`'s deliver closure) — through one shared helper, because the monitor callback has only a `SessionKey` and not a `ManagedSession`:

```ts
  private deliverPiMonitorEvent(delivery: MonitorDelivery): void {
    const managed = this.getManaged(delivery.sessionKey.sessionId, delivery.sessionKey.workspaceId)
    if (!managed || this.resolveManagedProvider(managed) !== 'pi') return
    void this.deliverMonitorEvent(delivery)
  }
```

T3 already stops both producers at the switch; this covers the in-flight event, because `stopAll` is fire-and-forget at `:14976` and the cron's timer callback can already be on the stack. `mcp-channel-gate.test.ts` is the suite that would catch the over-gated version.

- [ ] **Step 5: Run the tests**

```bash
bun test packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts
```

Expected: PASS.

- [ ] **Step 6: Update the tracker, then commit**

```bash
git add packages/server-core/src/sessions docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "fix(sessions): stop Pi goal, cron and monitor loops when the session leaves Pi"
```

---

### Task 8: A switch in flight must not break app quit

**Files:**
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (`switchSessionRuntime` `:14825`, `cleanup` `:21767`, `setProjectTrust` `:16418`)
- Test: `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts`
- Test: `packages/server-core/src/sessions/SessionManager.execution-observability.test.ts` — **not in the original block, and required.** Its cleanup fixture is a bare `Object.create(SessionManager.prototype)` that hand-lists every map `cleanup()` reads; a new one that is not added there makes that test throw on `undefined`.

**Interfaces:**
- Consumes: `switchSessionRuntime` (Task 3).
- Produces: `SessionManager.runtimeSwitchesInFlight: Map<string, Promise<void>>` and `awaitRuntimeSwitchesInFlight()` — awaited by `cleanup()` and `setProjectTrust` before they take the mutation boundary.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing test**

```ts
it('lets cleanup finish while a switch is in flight', async () => {
  const { manager, managed, releaseDrain } = createSwitchHarness({ holdDrain: true })
  const switching = manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
  await settle()                       // the switch now owns the boundary
  const cleaning = manager.cleanup()
  releaseDrain()
  await expect(cleaning).resolves.toBeUndefined()
  await switching.catch(() => undefined)
})
```

**Corrected at Step 0.** The harness is synchronous and takes `from`, not `provider` (the same correction T4 recorded); `holdDrain` is new here and is implemented by blocking the agent stub's `drainAutomationEvents` — the first `await` the switch reaches while holding the boundary (`drainAgentAutomationEvents` `:6568`, reached through `strictDrainSessionForMutation` → `disposeManagedAgentRuntime`). The `await settle()` is load-bearing: without it `cleanup()` runs before the switch has taken the boundary and the test passes with or without the fix.

Three more rows land with it, because a promise the quit path waits on is only safe if it is scoped and always settles: a **negative subject** (`cleanup()` with nothing in flight must not depend on the new await), a **leak check** (a switch that throws must leave the map empty, or every later quit hangs forever), and the **same-shaped second caller** — `setProjectTrust`'s revoke, which takes the boundary for every session in the workspace in one uncaught loop. That last one needs `managed.workingDirectory` set or it short-circuits on `session-project-unavailable` and never reaches the boundary — measured: without it the row passed against the un-fixed code.

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts -t 'cleanup finish'
```

Expected: FAIL with `session-project-mutation-busy`.

- [ ] **Step 3: Register the in-flight switch and await it on the quit path**

In `switchSessionRuntime`, register a deferred under `this.managedKey(managed)` immediately AFTER the boundary is acquired — a switch that never got the boundary is not something shutdown should wait on — and settle it in the same `finally` that releases, boundary first so a waiter resuming on the promise finds it free. In `cleanup()` (`:21770`) and `setProjectTrust` (`:16465`), await every in-flight switch before acquiring:

```ts
  private async awaitRuntimeSwitchesInFlight(): Promise<void> {
    if (this.runtimeSwitchesInFlight.size === 0) return
    await Promise.allSettled([...this.runtimeSwitchesInFlight.values()])
  }
```

A deferred rather than the operation's own promise, because that would mean splitting T3's method in two; `allSettled` rather than `all`, because a switch that failed has still finished and its error belongs to the caller that started it.

- [ ] **Step 4: Run the test**

```bash
bun test packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts -t 'cleanup finish'
```

Expected: PASS.

- [ ] **Step 5: Update the tracker, then commit**

```bash
git add packages/server-core/src/sessions docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "fix(sessions): a runtime switch in flight no longer aborts shutdown"
```

---

### Task 9: Deleting a connection must not silently move a live session

**Files:**
- Modify: `packages/server-core/src/handlers/rpc/llm-connections.ts` — the DELETE handler is at `:565`; the region the plan cited is now `SET_DEFAULT`. Found by identifier.
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (the two new readers; `executePromptAutomation` `:21179`; the automation history writes at `:21305`, `:21315` and `:7862`)
- Modify: `packages/shared/src/automations/webhook-utils.ts` — `createPromptHistoryEntry` is here, not in `SessionManager`
- Modify: `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx` + `packages/shared/src/i18n/locales/{en,ru}.json` — **not in the original block, and the task is inert without them.** That page's delete handler only `console.error`s, so a refusal nobody translates is a Delete button that silently does nothing.
- ~~Modify: the orphan clear (`SessionManager.ts:8458`)~~ — see the note below; not implemented.
- Test: `packages/server-core/src/handlers/rpc/__tests__/connection-delete-live-session.test.ts` — moved from `sessions/__tests__/`: the subject is the DELETE handler, and that directory's harness (a fake `RpcServer` collecting `server.handle` registrations) is what the test needs.

**Interfaces:**
- Consumes: `CodedError` + the `CONNECTION_IN_USE` code (Task 16 — already on `protocol/types.ts:117`).
- Produces: `SessionManager.sessionsUsingConnection(slug: string): SessionKey[]`, `listAutomationsUsingConnection(slug): string[]`, `connectionFallback` on the automation history entry.

**Corrected at Step 0 — `listAutomationsUsingConnection` takes no `workspaceId`.** `llmConnections.DELETE` is `(_ctx, slug: string)`: it has no workspace, connections are GLOBAL config, and a per-workspace check would let a delete through that breaks a different workspace's nightly task. It scans every loaded `automationSystems` entry instead.

**Corrected at Step 0 — the refusal is a THROWN `CodedError`, and the handler's existing `catch` had to learn to re-throw it.** That handler's contract is `{ success: boolean; error?: string }` and it wraps its whole body in a `try/catch` that flattens anything thrown into `error`. Left alone, the code would never reach the wire and the renderer could only print an English server string. The precedent for throwing instead is `settings.ts:202`'s `MODEL_RESTRICTED_BY_POLICY`, whose comment says exactly why: "the message reaches a renderer toast, and a policy's contents are the administrator's to disclose".

**Not implemented, and this is the one part of Step 3 that cannot be built as written: the transcript notice at the orphan clear.** `appendRuntimeSwitchNotice(managed, from, to)` needs the runtime the session LEFT, and at the orphan clear that connection's record is already deleted — the outgoing providerType is unknowable, so the notice could not say the true thing. The clear also runs inside `loadSessionsFromDisk` at startup, where `managed.messages` is lazy (loading every orphaned session's transcript to write one row is a startup cost for a migration path) and no renderer is subscribed yet, so an emitted `connection_changed` would reach nobody. With the DELETE refusal in place the orphan is no longer reachable through the product's own door at all — only through hand-edited config or a connection deleted by an older build. Recorded rather than approximated.

**Automations are the second door onto the same defect.** They never run inside a session — `executePromptAutomation` (`SessionManager.ts:20695`) calls `createSession` for every run — so a runtime switch cannot touch them. But the connection they name is resolved at run time, and `:20715-20718` logs a warning and **falls through to the default** when it no longer resolves. A nightly automation configured for Codex keeps firing on Pi after someone deletes that connection, with nothing said anywhere: not in the automation's history, not in the UI.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses to delete a connection a live session is bound to', async () => {
  const { manager, managed, deleteConnection } = await createDeleteHarness({ slug: 'codex-gateway' })
  managed.llmConnection = 'codex-gateway'
  await expect(deleteConnection('codex-gateway')).rejects.toThrow(/in use/)
})

it('refuses to delete a connection an automation is configured for', async () => {
  const { deleteConnection, addAutomation } = await createDeleteHarness({ slug: 'codex-gateway' })
  addAutomation({ name: 'nightly', action: { type: 'prompt', prompt: 'go', llmConnection: 'codex-gateway' } })
  await expect(deleteConnection('codex-gateway')).rejects.toThrow(/automation/)
})

it('records the fallback in automation history instead of only logging it', async () => {
  const { runAutomation, history } = await createAutomationHarness({ llmConnection: 'gone' })
  await runAutomation()
  expect(history.at(-1)?.connectionFallback).toEqual({ requested: 'gone', used: expect.any(String) })
})

// NOT IMPLEMENTED — see the note above the steps. The outgoing runtime is
// unknowable once the connection record is deleted, so the notice cannot say
// the true thing, and the clear runs at startup with lazy messages and no
// subscriber.
```

**Rewritten at Step 0.** The three implemented rows keep their subjects and lose their invented harnesses (`createDeleteHarness`/`addAutomation`/`createAutomationHarness` do not exist; the handler-test pattern in `handlers/rpc/__tests__/` does). Four more land with them, because a refusal is only as good as its scope: the **code** must reach the wire (`error.code === 'CONNECTION_IN_USE'`, not just a message — the handler's own `catch` would otherwise flatten it), a connection nothing uses must still delete, an unknown slug must still answer through the result shape, and the two readers get direct rows — `sessionsUsingConnection` against three sessions on two slugs, and `listAutomationsUsingConnection` across TWO workspaces with a webhook action carrying an `llmConnection` key it must not match.

- [ ] **Step 2: Run to verify they fail**

```bash
bun test packages/server-core/src/sessions/__tests__/connection-delete-live-session.test.ts
```

Expected: FAIL — DELETE succeeds silently; the orphan clear only logs.

- [ ] **Step 3: Refuse the delete, and announce the orphan clear**

In the DELETE handler, before removing the record:

```ts
    const bound = deps.sessionManager.sessionsUsingConnection(slug)
    const automations = deps.sessionManager.listAutomationsUsingConnection(workspaceId, slug)
    if (bound.length > 0 || automations.length > 0) {
      throw new CodedError(
        'CONNECTION_IN_USE',
        `${bound.length} session(s) and ${automations.length} automation(s) still use this connection`,
      )
    }
```

Both readers are new `SessionManager` methods beside `refreshConnectionRuntime`. Then, in `AiSettingsPage.handleDeleteConnection`, branch on the wire `code` and toast — the same shape `ChatPage` uses for `MODEL_RESTRICTED_BY_POLICY` and for T5's two switch refusals. Two flat keys in `en.json` and `ru.json`.

~~At `SessionManager.ts:8380`, after clearing the orphan, emit `connection_changed` + `capabilities_changed` and append the Task 4 transcript notice~~ — not implemented; the reason is above the steps.

In `executePromptAutomation` (`:21179`), replace the bare warning with a recorded fact: it returns the fallback it took, and the automation-history entry gains `connectionFallback?: { requested: string; used: string }` so the Automations UI can show that a run did not go where it was configured to go. A log line is not a user-visible fact. **Three** history writes carry it, not one — the awaited path's (`:7862`) and both of the fire-and-forget path's (`:21305` ok, `:21315` failed).

- [ ] **Step 4: Run the tests**

```bash
bun test packages/server-core/src/sessions/__tests__/connection-delete-live-session.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update the tracker, then commit**

```bash
git add packages/server-core/src/handlers/rpc/llm-connections.ts packages/server-core/src/sessions docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "fix(connections): deleting a connection can no longer move a live session in silence"
```

---

### Task 10: Per-message runtime provenance

The audit's one additive recommendation, and the cheapest thing that turns three silent-wrong behaviours into explicit ones: neither `Message` nor `StoredMessage` records which runtime produced it, so rewind, branch and the transcript boundary all fall back to the session's single CURRENT connection — wrong for every pre-switch row.

**Files:**
- ~~Modify: `packages/core/src/types/message.ts`~~ — **already done.** T16 (`6b73b8b11`) shipped `MessageRuntimeProvider` (`:271`), `Message.runtime`/`.llmConnection` (`:283`, `:285`) and `StoredMessage.runtime`/`.llmConnection` (`:401`, `:403`). What was missing is that **nothing filled them.**
- ~~Modify: `packages/shared/src/sessions/types.ts` (persist it)~~ — **not needed, and would have been wrong.** `SESSION_PERSISTENT_FIELDS` is the session HEADER's projection; messages never pass through it. They persist through `messageToStored` (`core/types/message-mapper.ts:23`), which spreads, and restore through `storedToPersistedMessage` (`:45`), which spreads too — so a field on the message rides both directions for free.
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (the two new helpers; 20 `managed.messages.push` sites; the completed-assistant insert; the `RuntimeSwitchResult` return)
- Modify: `packages/server-core/src/handlers/session-manager-interface.ts` — carries T9's two new readers; see the Corrections log.
- Test: `packages/server-core/src/sessions/__tests__/message-provenance.test.ts` (moved from `packages/shared/` — the stamp is a `SessionManager` method) and `runtime-switch-session.test.ts` (the end-to-end half)

**Interfaces:**
- Consumes: `resolveManagedProvider` (existing, `:6634`), `MessageRuntimeProvider` (Task 16).
- Produces: `stampMessageProvenance` + `appendManagedMessage` (private), and `RuntimeSwitchResult.from`/`to` finally filled.

**The trap in Step 3's wording, and it is the whole task.** "Stamp them at every `managed.messages.push`" reaches twenty sites and misses the twenty-first — the **completed assistant message**, which does not use `push` at all. It goes through `insertCompletedAssistantMessage(managed.messages, …)` (`transcript-order.ts:51`), because a finished answer must land above anything the user queued mid-turn. Following the instruction literally leaves the single most important row type unstamped, and every test written from that same mental model passes.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing test**

```ts
it('stamps the producing runtime on every assistant message', () => {
  const stored = readSessionJsonl(file)
  expect(stored.messages.filter(m => m.role === 'assistant').every(m => !!m.runtime)).toBe(true)
})

it('keeps the pre-switch runtime on pre-switch rows', () => {
  const stored = readSessionJsonl(file)
  expect(stored.messages[0]?.runtime).toBe('pi')
  expect(stored.messages.at(-1)?.runtime).toBe('anthropic')
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/shared/src/sessions/__tests__/message-provenance.test.ts
```

Expected: FAIL — `runtime` is not a field.

- [ ] **Step 3: Add the field and stamp it**

~~Declare `runtime?: AgentProvider` and `llmConnection?: string` on both interfaces~~ (T16 did, as `MessageRuntimeProvider`), ~~add both to `SESSION_PERSISTENT_FIELDS`~~ (wrong projection — see the Files block), and stamp them from `this.resolveManagedProvider(managed)` / `managed.llmConnection` **at write time**, through one `stampMessageProvenance` helper reached by `appendManagedMessage` (the 20 push sites) **and applied directly at the completed-assistant insert**.

Write time, not persist time: stamping in `messageToStored` would give every pre-switch row the post-switch runtime, which is the exact lie the field exists to stop.

While here, fill `RuntimeSwitchResult.from`/`to`. T16 declared both and `switchSessionRuntime` never set either, so a caller read `undefined` on every switch — the same declared-never-filled shape this task is fixing one layer down, and the two values are already in scope at the return.

- [ ] **Step 4: Run the test**

```bash
bun test packages/shared/src/sessions/__tests__/message-provenance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Use it in the three places that need it** — **NOT DONE, and each has its own reason. Checked at Step 0 against the tree.**

- **Rewind** (`rewindToMessage`, now `:15691`): the cited region is about FILE checkpoints — `listFileCheckpoints`, `revertStoredFileCheckpoint`, `restoredCheckpoints`, `skippedLinks`. Checkpoints are session-scoped, not runtime-scoped, so message provenance does not tell that report anything it does not already know. **Out of scope** for this task; if the uncounted-remainder report is wanted it is its own task.
- **Branch**: the premise no longer holds as stated. `createSession`'s branch validation (`:9995`) ALREADY refuses on `providerMismatch || providerTypeMismatch || piAuthProviderMismatch`, comparing the source session's resolved backend against the target's. What it does not compare is the branch POINT's runtime against the session's current one — and a branch reseeds from the retained transcript (`branchContextStrategy: 'seeded-fresh-session'`) either way, so "silently wrong" overstates it. Adding a refusal on top of an existing refusal chain is a **new user-visible behaviour**, which this plan's own escalation rule sends to the owner. **Owner decision.**
- **The transcript notice**: **superseded.** `switchSessionRuntime` knows `fromProvider` and `toProvider` exactly and hands them to `appendRuntimeSwitchNotice` directly (T4). Deriving them from adjacent rows would be strictly less accurate. What was missing is one layer up — `RuntimeSwitchResult.from`/`to` — and Step 3 now fills it.

The record is the deliverable; the three readers are what it makes possible. Shipping the stamp without them is the additive half the audit actually recommended, and it is what a later task or the owner needs in order to build any of the three.

- [ ] **Step 6: Update the tracker, then commit**

```bash
git add packages/core/src/types/message.ts packages/shared/src/sessions packages/server-core/src/sessions docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "feat(sessions): record which runtime produced each message"
```


---

### Task 11: Does the context state survive a switch?

**Owner decision, 2026-08-15, verbatim:** «резать не нужно, скорее проверить как он дойдет, так как там будет переключение рантайма».

So this task is **not cut and not implemented as originally written.** It was drafted as "make the meter derive a number for runtimes that do not report one" — and lane F has since done that properly, F1–F9, live-proven on all three runtimes, with measurements this plan never had (F6 refuted its own candidate cause; F9 found the Claude gate required a window source of `auto` that a gateway model id never matched).

What lane F **structurally could not cover** is the switch itself. Its three arms each ran inside one runtime, standing still. This task is the case that only exists once the switch machinery does: **the field that decides the window — the connection, its model list, each model's `contextWindow` and `wire` — is exactly what changes under a live session.** So T11 becomes a verification task, and it sequences late, after the switch exists.

**If the landed behaviour turns out to be correct across a switch, this task closes green with the evidence recorded and no production change.** That is a success, not a wasted task.

**OUTCOME, 2026-08-15: GREEN, no production change.** The five verification rows pass against the tree as it is, and `git diff` on every production file is empty. `applyContextUsageSnapshot` (`packages/server-core/src/sessions/SessionManager.ts:8583` — the task's `:8459` had drifted) writes the snapshot in three places, and T3's `clearRuntimeScopedSessionState` (`:15349-15353`) clears all three; the two controls below prove the assertions have teeth rather than passing vacuously.

**Files:**
- Test: `packages/server-core/src/sessions/__tests__/context-usage-after-switch.test.ts` — created; the only file this task adds.
- Modify (only if the verification fails): whatever lane F owns — `packages/shared/src/config/context-window-resolver.ts`, `packages/shared/src/agent/{claude,codex}-agent.ts`, `SessionManager.ts:8583` (was `:8459`). **Any change here is a change to another plan's landed work: record it in the Corrections log and say so in the tracker note.** Not reached: nothing failed.

**Interfaces:**
- Consumes: `switchSessionRuntime` (Task 3), lane F's `thresholdKind` and `resolveContextTokens`. All three resolve.
- Produces: no code symbols. Produces evidence: the five recorded outcomes below.

- [x] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks.

**Additionally, and this is the substance of this task's Step 0:** read lane F's rows F1–F9 in `docs/superpowers/plans/2026-08-14-runtime-icons-plates-model-sync.md` and the code they name — `thresholdKind` on the composer capability (F4), `resolveContextTokens` in `ChatDisplay` (F8), `buildClaudeMaxContextTokensEnv` / the auto-compact window env (F2/F9), the codex `model_auto_compact_token_limit` gate (F7). **This task cannot be written against the plan text above**, which predates all nine.

**What Step 0 found (2026-08-15).** All five checks pass: the 14 completed tracker rows name commits whose subjects match, `git status --porcelain` shows only the three foreign files of another session, `bun run typecheck:all` exits **0** (real exit code, no pipe), the task sections / tracker rows / Order row name the same 17 tasks, and every `Consumes` symbol resolves. Four coordinate corrections, no approach change — logged in the Corrections table and applied above and below:

1. `applyContextUsageSnapshot` is `SessionManager.ts:8583`, not `:8459`.
2. `clearRuntimeScopedSessionState`'s own comment still cites that method as `(:8480)`. **Left as-is deliberately** — this task's success condition is no production change, and a stale comment coordinate is not worth a diff against a green verification. Noted here so the next editor of that block fixes it.
3. Step 1's snippets name a harness API that does not exist (`createSwitchHarness({provider})` is `{from}` and synchronous; there is no `runOneTurn`, `windowOf`, `capabilitiesFor` or `thresholdKindOf`; `'llm-proxy'` is not a fixture slug). The real seams are `processEvent(managed, {type:'usage_update', usage})` — the production entry point the chat loop feeds, as `context-usage-turn-persistence.test.ts` uses it — and `setEventSink` + `sendCapabilitiesChanged` for the capability. The three PROPERTIES asserted are unchanged, so this is coordinates.
4. Step 1's third row assumed the same-runtime case re-reads the window at the switch. It does not: `clearRuntimeScopedSessionState` runs only for `connection-cross-runtime` (`:15107`). The assertion it wanted (the window is the target's after a turn) holds; the transient before that turn is recorded rather than fixed — see Step 3.

- [x] **Step 1: Write the verification tests** (five, not three — the extra two are the control and the occupancy half)

Each asserts a property lane F established, across a switch rather than within one runtime.

```ts
describe('context state across a runtime switch', () => {
  it('reports the TARGET runtime window, not the source one', async () => {
    const { manager, managed } = await createSwitchHarness({ provider: 'pi' })
    await runOneTurn(manager, managed, { inputTokens: 150_000 })
    const before = managed.contextUsage?.contextWindow
    await manager.switchSessionRuntime(managed.id, 'codex-gateway', managed.workspace.id)
    await runOneTurn(manager, managed, { inputTokens: 12_000 })
    expect(managed.contextUsage?.contextWindow).not.toBe(before)
    expect(managed.contextUsage?.contextWindow).toBe(windowOf('codex-gateway'))
    expect(managed.contextUsage?.inputTokens).toBe(12_000)
  })

  it('carries no threshold from the runtime it left', async () => {
    const { manager, managed, capabilitiesFor } = await createSwitchHarness({ provider: 'pi' })
    await runOneTurn(manager, managed, { inputTokens: 150_000 })
    await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
    const caps = await capabilitiesFor(managed)
    expect(caps.contextUsage.thresholdKind).not.toBe('legacy')
    expect(caps.contextUsage.thresholdKind).toBe(thresholdKindOf('claude-gateway'))
  })

  it('re-reads the window when the same runtime changes its model catalogue', async () => {
    // The case lane F could not reach: the connection is what decides the
    // window, and the switch is the only thing that changes it mid-session.
    const { manager, managed } = await createSwitchHarness({ provider: 'pi' })
    await runOneTurn(manager, managed, { inputTokens: 10_000 })
    await manager.switchSessionRuntime(managed.id, 'llm-proxy', managed.workspace.id)
    await runOneTurn(manager, managed, { inputTokens: 10_000 })
    expect(managed.contextUsage?.contextWindow).toBe(windowOf('llm-proxy'))
  })
})
```

**The block above is kept as the record of what was planned; the shipped file is `context-usage-after-switch.test.ts` and its five rows are:**

| row | what it proves |
| --- | --- |
| divides by the TARGET runtime window | Pi at 150 000/240 000 → switch to codex → all three snapshot writes are gone → codex's first turn installs **272 000** and 12 000. |
| leaves the window unknown when the target reports none | **The control.** F3(b)'s "no window, no invented limit": a first turn with no `contextWindow` must leave the meter unknown. With `tokenUsage.contextWindow = undefined` commented out of the clear, this row reads `240 000` — the source's window dividing the target's tokens. |
| carries no threshold from the runtime it left | Four arms on one seam: pi `real` → claude-runtime `formula-claude` (and explicitly `not 'legacy'`), pi → codex `none`, codex → pi back to `real`. Three different values, so no arm can pass on a constant. |
| re-reads the window when the same runtime changes connection | The same-runtime transient, stated so a later change to it is visible as a change; the target's first turn then installs 128 000. |
| keeps the occupancy counters across the switch | The numerator is deliberately NOT cleared where the divisor is — the same two fields are the session's cumulative accounting — and the target's first turn overwrites it. |

- [x] **Step 2: Run them**

```bash
bun test packages/server-core/src/sessions/__tests__/context-usage-after-switch.test.ts
```

**GREEN: 5 pass / 0 fail / 26 expect() calls, exit 0.** Lane F's work survives the switch. Step 3 is therefore not reachable, and no production file is touched by this task.

- [x] **Step 3 (conditional): Fix what the verification found** — **NOT REACHED.** Step 2 was green.

Only reachable if Step 2 was red. Fix it **inside lane F's own abstractions** — `thresholdKind`, `resolveContextTokens`, the env builders — never by adding a parallel derivation beside them. Record it in the Corrections log as a change to another plan's landed work, and name the F row it touches.

**One thing measured and deliberately NOT fixed**, because it is a behaviour change rather than a defect the verification found: on a `connection-same-runtime` switch (Pi → a narrower Pi connection) the source's window survives the switch itself, because `clearRuntimeScopedSessionState` is called only on the cross-runtime branch (`:15107`). It is bounded by the next turn — Pi re-reports its window every turn and is the only runtime that sends a snapshot at all — and the identical transient already exists on the plain model-change path, which is not a runtime switch. Clearing it would be a new user-visible behaviour on a path this plan's escalation rule sends to the owner. Recorded in the fourth test row so a later change to it is a visible change.

- [x] **Step 4: Add the live case to T15** — `RTS-12`, added to T15's case table.

One row: fill a Pi session to roughly half its window, switch to Codex, and read the meter. The number and the threshold must both belong to Codex. **Read the session's own runtime log for the reading, not a typed field** — `ContextUsageSnapshot.lastCompaction` is declared and never filled on the Pi path and has previously reported "never happened" through twenty-seven real compactions.

- [x] **Step 5: Return the tracker row to the orchestrator, then commit**

```bash
git add packages/server-core/src/sessions/__tests__/context-usage-after-switch.test.ts \
  docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "test(context): the context state is correct after a runtime switch"
```

The plan file joins the `git add` because the tracker row flips in the same commit (Global Constraints), and because Step 0's corrections land with the task. Explicit paths only — three files in this tree belong to another session.


---

### Task 12: Attachments the target runtime cannot take

`ComposerCapabilities.attachments.{files,images,folders}` has zero non-test consumers, and both filter sites are gated on `isCompatProvider` — `pi_compat` and nothing else. On claude-runtime a staged image reaches the adapter and `flattenContent` drops every part without a string `text`.

Re-verified at Step 0 on `2f1baecf2`: the defect still reproduces. `to-chat.ts:67` keeps only content parts carrying a string `text`, and `modelSupportsImages` already answers "no" for an undeclared `claude-runtime` model — so the capability was right and nothing read it.

**Files:**
- Modify: `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` (`:1858` warning, `:1851` `submitDisabled`, `:1972` banner)
- Modify: `apps/electron/src/renderer/components/app-shell/input/ImageSupportWarningBanner.tsx` (`onEnable` becomes optional)
- Create: `apps/electron/src/renderer/components/app-shell/input/attachment-capability.ts` (`resolveStagedImagePolicy`)
- Modify: `apps/electron/src/renderer/pages/ChatPage.tsx` (`handleConnectionChange` — the post-switch summary)
- Modify: `apps/electron/src/renderer/playground/registry/image-support.tsx` (the no-override-on-offer state)
- Modify: `packages/server-core/src/sessions/runtime-config.ts:121` (`filterAttachmentsForModelInput`)
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (`switchSessionRuntime` fills `droppedAttachments`; the existing info event at `:17571`)
- Modify: `packages/shared/src/protocol/runtime-switch.ts` (`droppedAttachments`' doc-comment, now that it is filled)
- Modify: `packages/shared/src/i18n/locales/{en,ru}.json`
- Test: `packages/server-core/src/sessions/runtime-config.test.ts:140` (the function's existing describe block), `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts`, `apps/electron/src/renderer/components/app-shell/input/__tests__/attachment-capability.test.ts`

**Interfaces:**
- Consumes: `resolveComposerCapabilities` (existing), `RuntimeSwitchResult` (Task 3).
- Produces: `resolveStagedImagePolicy({hasStagedImages, images, providerType}): { blocked, offerModelOverride }`, and `RuntimeSwitchResult.droppedAttachments: string[]` filled. `filterAttachmentsForModelInput` keeps its signature and its `omittedImages` half — what changes is which connections reach the branch.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing test**

In `runtime-config.test.ts`'s existing `filterAttachmentsForModelInput` block (the plan's separate `__tests__/attachment-capability.test.ts` would split one function's tests across two files, and the three negative controls already live here):

```ts
it('strips and reports an image on a runtime that cannot take one', () => {
  const result = filterAttachmentsForModelInput(
    [imageAttachment, textAttachment],
    claudeGateway,
    'tgpt/qwen35-397b-a17b-fp8',
  )
  expect(result.omittedImages.map(a => a.name)).toEqual(['image.png'])
  expect(result.attachments?.map(a => a.name)).toEqual(['note.txt'])
})
```

Plus the two negative subjects, which are the whole control: the same `claude-runtime` connection with `supportsImages: true` on the model keeps its image, and a direct `anthropic` connection keeps its image — `claude-runtime` collapses onto the `anthropic` AgentProvider, so a filter keyed off the provider alone would strip images on api.anthropic.com too.

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/server-core/src/sessions/runtime-config.test.ts
```

Expected: FAIL — the function returns untouched for any non-`pi_compat` connection.

- [ ] **Step 3: Replace the `isCompatProvider` gate with the capability**

In `runtime-config.ts:121`, drop the `isCompatProvider` early-return and decide from `resolveComposerCapabilities({provider, connection, model}).attachments.images`. The provider is DERIVED from the connection via `providerTypeToAgentProvider` — the same call `resolveBackendContext` makes, so the value is identical to the caller's and the signature does not move. The existing info event at `SessionManager.ts:17571` already maps `omittedImages` to names, so it now fires on every runtime rather than only `pi_compat`.

- [ ] **Step 4: Make the composer read the capability**

`showVisionWarning` becomes `hasStagedImages && composerCapabilities.attachments.images === 'no'`, and that condition joins `submitDisabled` with the existing `chat.submit.blocked.imagesUnsupported` reason.

Split in two, because the same flag also renders the banner's "Enable image support" action (`resolveStagedImagePolicy`): that action writes `supportsImages: true` onto the connection's model entry, which decides anything only where the connection catalog is the authority. On `claude-runtime` the adapter drops image parts whatever the catalog says, so widening the flag alone would have offered a button that clears the warning, re-enables the send and changes nothing that reaches the model. `blocked` drives the warning and the refusal on every runtime; `offerModelOverride` keeps the remedy on `pi_compat`.

Note that `submitDisabled` did **not** carry this condition before — `chat.submit.blocked.imagesUnsupported` was written for a refusal that was never wired, so this step is what makes that string reachable. `chat.imageWarning.title` ("Images will be stripped before sending") had to change with it: the send is refused now, not stripped.

- [ ] **Step 5: The switch enumerates what the target cannot take**

`switchSessionRuntime` returns `droppedAttachments: string[]` — the deduplicated names of images already in the transcript that the target declares it cannot read, read off the same `capabilities` value the switch hands the composer.

**Not Task 5's dialog.** That dialog runs BEFORE the switch and is computed entirely in the renderer from the two connection records (`ConnectionRow.pick` → `RuntimeSwitchDialog`); it never sees `RuntimeSwitchResult`. The plan's own Deviations log recorded this on 2026-08-15 — "T5 ships the pre-flight confirmation only… T12/T13 will still have to touch `ChatPage.tsx`". So the post-switch summary is built where the result actually arrives: `ChatPage.handleConnectionChange`, which already toasts this operation's failures. T13 and T17 extend the same surface.

- [ ] **Step 6: Run the tests**

```bash
bun test packages/server-core/src/sessions/runtime-config.test.ts packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts apps/electron/src/renderer/components/app-shell/input/__tests__/
bun run lint:i18n:parity && bun run lint:i18n:sorted
bun run typecheck:all
```

Expected: PASS, exit 0.

- [ ] **Step 7: Update the tracker, then commit**

```bash
git add packages/server-core/src/sessions/runtime-config.ts packages/server-core/src/sessions/runtime-config.test.ts packages/server-core/src/sessions/SessionManager.ts packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts packages/shared/src/protocol/runtime-switch.ts packages/shared/src/i18n/locales apps/electron/src/renderer/components/app-shell/input apps/electron/src/renderer/pages/ChatPage.tsx apps/electron/src/renderer/playground/registry/image-support.tsx docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "fix(attachments): honour the runtime's attachment capability instead of a pi_compat-only gate"
```

---

### Task 13: Leave the worktree, and land the children, before the runtime changes

Two Pi-only escapes become traps once the runtime can move: `ExitWorktree` (`session-tools-core/src/tool-defs.ts:1094`) and every child control are `pi-only`, so after a switch neither the model nor the user can reach them.

`strictDrainSessionForMutation` (adopted in Task 3) already drains children and asserts `pi-session-worktree-residual`, so the unhandled case is narrow and specific: the session's **cwd is inside a live lease**. Draining releases the lease; the cwd stays pointed at a directory that is about to be reaped.

Re-verified at Step 0 on `960485189`. Both halves of the claim hold, and one of them is already half-solved: `strictDrainPiSessionOwned` releases every lease at `:10548` and `releaseUnlocked` **already refuses a dirty worktree** (`WorktreeLeaseError('worktree-dirty')`) — but that arrives at the user as `pi-session-drain-failed:runtime switch (…)`, which says nothing about uncommitted work. So `WORKTREE_DIRTY` is a re-code of an existing refusal, not a new check.

**Files:**
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (`switchSessionRuntime` `:15040`; new `exitWorktreeBeforeRuntimeSwitch` next to `createSessionWorktreePort` `:11483`; module-level `findWorktreeDirtyResidual`)
- Modify: `apps/electron/src/renderer/pages/ChatPage.tsx` (the two new refusal codes, and `stoppedChildren` on the post-switch summary T12 built)
- Modify: `packages/shared/src/i18n/locales/{en,ru}.json`
- Test: `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts`

**Interfaces:**
- Consumes: `switchSessionRuntime` (Task 3), `strictDrainSessionForMutation` (existing), `SessionWorktreePort` (existing), `WorktreeLeaseError` (existing).
- Produces: the coded errors `WORKTREE_EXIT_UNAVAILABLE` and `WORKTREE_DIRTY` (both already in the wire `ErrorCode` union, T16), and `RuntimeSwitchResult.stoppedChildren: string[]`.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing tests**

Six rows in `runtime-switch-session.test.ts`, three of them negative subjects. The harness needs no `createWorktreeHarness`: installing a stub `WorktreeLeaseService` in `piWorktreeLeaseServices` is what stops `createPiWorktreeLeaseService` from building a real one (it returns any existing entry first), and `mutateWorkingDirectory` is replaced with a recorder so the cwd move is observable without a real git tree.

```ts
it('returns the session to the launch directory before the runtime changes', async () => {
  // …lease at LEASE_PATH, cwd = LEASE_PATH, sdkCwd = workspaceRoot
  let cwdAtDrain: unknown
  manager.strictDrainSessionForMutation = async m => { cwdAtDrain = m.workingDirectory }
  await manager.switchSessionRuntime(managed.id, 'claude-gateway', managed.workspace.id)
  expect(cwdAtDrain).toBe(workspaceRoot)          // the ORDER, seen from inside the drain
  expect(managed.workingDirectory).toBe(workspaceRoot)
})
```

The order is the assertion that matters: the drain releases the lease and `git worktree remove`s the directory, so an exit that ran afterwards would move the session into a path that no longer exists. Negative subjects: a session **not** inside a lease records **no** cwd move at all; an unrelated drain failure keeps its own error rather than being re-coded `WORKTREE_DIRTY`; and a switch with no running children leaves `stoppedChildren` absent.

- [ ] **Step 2: Run to verify they fail**

```bash
bun test packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts
```

Expected: FAIL — the cwd stays inside the worktree.

- [ ] **Step 3: Exit the worktree first, or refuse**

In `switchSessionRuntime`, before the drain, through `exitWorktreeBeforeRuntimeSwitch`. The plan's original snippet cannot compile against this tree and each divergence is a real one:

- `managed.worktreeLeaseState` is `{ schemaVersion, revision, leases[] }` — a LIST, with no `.path`.
- `piWorktreeLeaseServices` holds `WorktreeLeaseService`, which has **no `exit`**. The thing with `exit()` is `SessionWorktreePort`, built on demand by `createSessionWorktreePort` and stored nowhere; it is therefore always available, so "no port" is not a reachable `WORKTREE_EXIT_UNAVAILABLE`.
- `port.exit()` takes no argument and resolves `{path, previousWorkingDirectory} | null` — never `{ok, reason}` — and it does not look at dirtiness.

What it does instead: find the lease containing the cwd (`isPathWithin`, so a `/cd` into a subdirectory is seen), call `port.exit()`, and refuse `WORKTREE_EXIT_UNAVAILABLE` when it resolves `null` — which is exactly the subdirectory case, since the port matches the lease root exactly. Going through the port rather than writing `workingDirectory` is deliberate: the port routes the move through `mutateWorkingDirectory({intent:'keep', preserveSdkCwd:true})`, which revokes outside-root receipts, invalidates the capability snapshot and persists.

`WORKTREE_DIRTY` is a **re-code, not a new check**: `releaseUnlocked` already throws `WorktreeLeaseError('worktree-dirty', […])` during the drain. `findWorktreeDirtyResidual` walks the `cause` chain and any `AggregateError` for a residual whose structured `code` is `worktree-dirty` — matched on the code, never on message text — and everything else rethrows unchanged.

- [ ] **Step 4: Say what happened to background children**

`RuntimeSwitchResult` gains `stoppedChildren: string[]` — the `agent` names of children whose status was `starting`/`running`, read from the same source the rest of the file reads children from (`:3348`, `:3605`, `:6384`, `:7264`) and read **before** the drain, because after it the same expression is empty. Surfaced on the post-switch summary in `ChatPage.handleConnectionChange` (see T12 Step 5 for why not the dialog), together with the two new refusal codes.

- [ ] **Step 5: Run the tests**

```bash
bun test packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts
bun run lint:i18n:parity && bun run lint:i18n:sorted
bun run typecheck:all
```

Expected: PASS, exit 0.

- [ ] **Step 6: Update the tracker, then commit**

```bash
git add packages/server-core/src/sessions apps/electron/src/renderer/pages/ChatPage.tsx packages/shared/src/i18n/locales docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "fix(sessions): leave the worktree and land background children before the runtime changes"
```

---

### Task 14: The mobile client

`apps/ios/NessyMobile/NessyMobile/Chat/ModelPickerView.swift:29-33` renders a `Section` per connection and sends only `sessions:setModel(sessionId, workspaceId, model, connection)`; there is no `setConnection` and no `switchRuntime` in `RPCClient+SessionControl.swift`. `SessionEvent.swift:7-25` decodes `session_model_changed` but has no case for `connection_changed` or `capabilities_changed` — both fall to `.unknown`. Without this task, Task 3's model-catalog guard makes every cross-connection pick on mobile a silent no-op.

**Files:**
- Modify: `apps/ios/NessyAgentKit/Sources/NessyAgentKit/Client/RPCClient+SessionControl.swift` (the directory is `Client/`, not `RPC/`)
- Modify: `apps/ios/NessyAgentKit/Sources/NessyAgentKit/Client/RPCClient+Sessions.swift` — **not in the original block.** `getSessionState` is where the picker's opening value has to come from; see Step 4.
- Modify: `apps/ios/NessyAgentKit/Sources/NessyAgentKit/Models/SessionEvent.swift`
- Create: `apps/ios/NessyAgentKit/Sources/NessyAgentKit/Models/ComposerCapabilities.swift`, `.../Models/RuntimeSwitch.swift`
- Modify: `apps/ios/NessyMobile/NessyMobile/Chat/ModelPickerView.swift`, `.../Chat/ChatViewModel.swift` (the view model owns every RPC the view calls; it was not in the block)
- Test: `apps/ios/NessyAgentKit/Tests/NessyAgentKitTests/SessionEventDecodingTests.swift`, `.../RuntimeSwitchTests.swift`

**Interfaces:**
- Consumes: the `switchRuntime` session command (Task 5) and the `connection_changed` / `capabilities_changed` events (existing wire).
- Produces: `SessionEvent.connectionChanged` / `.capabilitiesChanged` cases, and `RPCClient.switchRuntime(sessionId:connectionSlug:)`.

**Corrected at Step 0 — the command takes no `model`.** The wire shape T5 shipped is `{ type: 'switchRuntime'; connectionSlug: string }` (`packages/shared/src/protocol/dto.ts:614`), and the handler passes exactly that (`rpc/sessions.ts:766`). The owner's "two controls, not one tree" decision is why: no gesture picks an integration and a model together, so the server resolves the target's model itself and the desktop makes no second call. A `model:` parameter here would have been a mobile-only wire shape the server does not read.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Write the failing test**

```swift
func testDecodesConnectionChanged() throws {
  let json = #"{"type":"connection_changed","sessionId":"s1","connectionSlug":"claude-gateway","supportsBranching":true}"#
  let event = try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
  guard case .connectionChanged(let payload) = event else { return XCTFail("fell through to .unknown") }
  XCTAssertEqual(payload.connectionSlug, "claude-gateway")
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/ios/NessyAgentKit && swift test
```

Expected: FAIL — the event decodes to `.unknown("connection_changed")`.

**Corrected at Step 0: the gate is `swift test`, not `xcodebuild -scheme NessyAgentKit`.** `Package.swift` declares `.macOS(.v15)` with the comment "enables `swift test` on macOS CI/dev machines without booting a simulator", so the Kit's suite runs in under a second with no simulator. The app target is a separate Xcode project and needs `xcodebuild -scheme NessyMobile` — both are run below.

- [ ] **Step 3: Add the two event cases and the command**

Add `connectionChanged` and `capabilitiesChanged` cases to `SessionEvent`, and `switchRuntime(sessionId:connectionSlug:)` to `RPCClient+SessionControl.swift`, mirroring the desktop `sessionCommand` shape.

`capabilities_changed` carries the whole `ComposerCapabilities`; only its `connection: { switchable, activeRuntime }` half is modelled (`dto.ts:106`), with every field optional, which is the same forward-compat rule `SessionEvent` already applies to unknown `type`s. The `RuntimeSwitchResult` the command returns is discarded, for the reason T5 recorded on the desktop: the post-switch summary waits for the fields it would show, and what the session carried over is already stated by the transcript notice.

- [ ] **Step 4: Restructure the mobile picker to two controls**

`ModelPickerView` renders an integration row (current integration, runtime mark, chevron) above a model list scoped to the ACTIVE integration — the same two-control grammar as the desktop draft. A cross-integration pick routes through a confirmation alert and `switchRuntime`, never `setModel`.

**Addition found at Step 0 — the picker had no way to know its own integration.** `ChatViewModel` tracked `currentModel` and nothing else; `Session` in the Kit has no `llmConnection`, and `getSessionState` decoded only `messages` + `isProcessing`. Listening for `connection_changed` alone is not enough: a client that only listens has no value at all until something changes, so the integration row would open blank on every session. The seed rides the Session DTO that `sessions:getMessages` already returns — `pickSessionFields` includes `llmConnection` and `managedToSession` attaches `composerCapabilities` — so `SessionMessagesEnvelope` gains two optional fields and `getSessionState` returns them. No new round trip and no new channel.

The tier logic is ported to the Kit (`RuntimeSwitch.swift`) rather than written in the view, mirroring `runtime-switch-copy.ts`: `AgentRuntime(providerType:)` restates `providerTypeToAgentProvider`, `classify` restates `classifyConnectionSwitch`, and `confirmation` restates `runtimeSwitchCopyKey`'s tiering. That is what makes any of this testable — SwiftUI views are not unit-tested in this repo.

- [ ] **Step 5: Run the tests and the app**

```bash
cd apps/ios/NessyAgentKit && swift test
cd apps/ios/NessyMobile && xcodebuild -scheme NessyMobile -destination 'platform=iOS Simulator,name=iPhone 17' test
```

Expected: PASS. Launching the app against a live server is **T15's** job, not this task's — it needs a running desktop server and a real JWT, and this plan's live evidence is collected in one pass there.

- [ ] **Step 6: Update the tracker, then commit**

```bash
git add apps/ios docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "feat(mobile): switch a session's integration and runtime from iOS"
```


---

### Task 17: The capability layer across a switch

**Found by** the capability-layer audit (2026-08-14, 21 agents), which asked the question this plan never did: plugins, MCP, skills, sources — do they switch too? **It unblocks** nothing; it closes a silence.

The answer that made this task necessary: **nothing switches — the whole layer is destroyed and re-resolved from scratch**, and the *inventory* comes back byte-identical because the resolver reads `context.provider` in only three places (`resolver.ts:1802`, `:1972`, `:2932`). What does not come back is the *execution*: roughly thirty capabilities in `getOrCreateAgentUnchecked` are wired `provider === 'pi' ? … : undefined`. A plugin's card stays enabled and its skills keep working while its background monitor is dead, its LSP is gone and ~~three~~ **four** of its five hook kinds fire and do nothing. **Nothing in the product says so.** This task makes the catalogue able to say it and the switch able to enumerate it.

Measured at Step 0 on `e2034d6ea`: `buildPinnedAgentAutomationSystem` supplies `pluginCommandHookRunner` unconditionally and the other **four** runners — `prompt`, `agent`, `mcp_tool`, `http` — only under `provider === 'pi'` (`SessionManager.ts:12827`); `hooks-automation.ts:786-831` simply skips an action whose runner is absent. The task's "three" omitted `prompt`.

**Files:**
- Modify: `packages/server-core/src/sessions/SessionManager.ts` — new `describeCapabilityDelta`; the `loop`-skill filter at `:437`; the three peripheral wirings now read the shared predicate (`:13153`, `:13164`, `:14854`)
- Modify: `packages/shared/src/agent/runtime-agent-support.ts` — `PLUGIN_PERIPHERAL_RUNTIMES` + `runtimeRunsPluginPeripherals`
- Modify: `packages/shared/src/capabilities/resolver.ts:1972` — widen the `unsupported-runtime` gate past `kind === 'agent'`
- Modify: `packages/shared/src/protocol/runtime-switch.ts` — `CapabilityDelta`, `RuntimeSwitchResult.capabilityDelta`
- Modify: `apps/electron/src/renderer/pages/ChatPage.tsx`, `packages/shared/src/i18n/locales/{en,ru}.json`
- Test: `packages/shared/src/capabilities/__tests__/resolver.test.ts` (the catalogue half, beside the agent gate's own rows), `packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts` (the delta), `packages/server-core/src/sessions/__tests__/loop-skill-runtime.test.ts`

**Interfaces:**
- Consumes: `switchSessionRuntime` (Task 3), `resolveManagedProvider` (existing), `runtimeDispatchesAgentDefinitions`'s module (existing).
- Produces: `SessionManager.describeCapabilityDelta(managed, from: AgentProvider, to: AgentProvider): CapabilityDelta | undefined` where `CapabilityDelta = { stoppedMonitors: string[]; lostLsp: string[]; inertHookKinds: string[] }`, and `RuntimeSwitchResult.capabilityDelta?: CapabilityDelta`. **`unavailableSources` is not built** — see the Corrections log.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks.

- [ ] **Step 1: Write the failing tests**

Three files, because the two halves live in different packages and the third is a pure filter. **The plan's own snippet is against a shape that does not exist** — `AgentRuntimeView` has no `components` array (it has typed `monitors`/`lspServers`/`hooks` lists) and no `unavailableReason` (that lives on `ResolvedCapabilityEntry.summary`, i.e. the CATALOGUE). So the catalogue half is tested at the resolver, beside the agent gate's own rows, and the delta half at the switch:

```ts
// resolver.test.ts — the catalogue half, and its positive control
it('refuses both peripherals on a runtime that starts neither', …)  // anthropic + codex-runtime
it('keeps both active on Pi, which really runs them', …)            // the control
it('leaves the provider-neutral catalog untouched', …)              // no session ⇒ no verdict
it('does not gate a plugin hook, whose command form runs everywhere', …)

// runtime-switch-session.test.ts — the delta
it('names the peripherals and the hook kinds the target will not run', …)
it('says nothing when the target runs the peripherals', …)          // pi ← claude, the plan's own control
it('reads the outgoing runtime\'s view, before the drain disposes it', …)
```

The last one is the placement proof: its drain stub clears `capabilityRuntime`, exactly as the real drain does, so the row fails if the delta is computed after the drain.

- [ ] **Step 2: Run to verify they fail**

```bash
bun test packages/shared/src/capabilities/__tests__/resolver.test.ts -t T17
bun test packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts -t "stops executing"
```

Expected: FAIL — `describeCapabilityDelta` does not exist; `unavailableReason` is only ever `'unsupported-runtime'` for `kind === 'agent'`; `loop` is listed on every runtime.

- [ ] **Step 3: Compute the delta from the OUTGOING runtime's view**

`SessionManager.describeCapabilityDelta`, called from `switchSessionRuntime` **before** the drain — after the drain the outgoing runtime's view is gone, and after the switch the resolver re-runs on the new provider and honestly returns nothing.

Two corrections to the plan's snippet beyond the view shape:

- It returns `CapabilityDelta | undefined` rather than an empty object. An empty delta and an absent one mean the same thing to every reader, and `undefined` keeps `RuntimeSwitchResult` free of a field that says "nothing happened".
- `unavailableSources` is **not built**, and the reason is a category error in the snippet rather than a missing helper: `isDpAuthenticatedSource(slug, managed)` does not exist, and `managed.enabledSourceSlugs` is the wrong input — a dp-authenticated capability is a plugin-bundled MCP **server** (`runtime-pool-servers.ts:641`, an stdio server whose resolved executable reports `externalAuthProvider === 'dp'`), not a user source with a slug. The only honest reader is `materializeRuntime`'s `externalAuthRequirements`, which is async and needs the MCP pool lease. Re-deriving the rule from the command name would be the second copy of a rule this plan keeps refusing. The underlying defect is already tracked as Deferred fix-list row 5.

- [ ] **Step 4: Let the catalogue say "not here"**

In `resolver.ts`, the `unsupported-runtime` reason is currently reachable only for `kind === 'agent'`. Widen it to `lsp` and `monitor` through a NEW shared predicate in `runtime-agent-support.ts` — `runtimeRunsPluginPeripherals`, the set `{pi}` — and make the three session-path wirings read the same predicate instead of restating `provider === 'pi'` (`:13153`, `:13164`, `:14854`). That two-reader shape is the module's whole purpose; the plan said to reuse `runtimeDispatchesAgentDefinitions` itself, which is wrong: its set includes `anthropic` and `codex-runtime`, neither of which runs a peripheral.

Do **not** widen it to `hook`: command hooks run everywhere and only four action kinds are inert, so a whole-row gate would lie in the other direction. There is a test for that.

- [ ] **Step 5: Drop `loop` where its tools do not exist**

`withoutLoopSkillWhenCronDisabled` (`SessionManager.ts:437`) filtered on `isCronDisabled()` alone, while the four cron tools are `visibility: 'pi-only'` (`tool-defs.ts:1161-1169`) and dropped for any non-Pi projection (`:1319`). Renamed `withoutLoopSkillWhereCronToolsAreAbsent` and given the provider. Both call sites have one: the view site directly, and `skillSlashCommands` off `snapshot.context.provider` — the field the resolver already pinned the snapshot to, so no signature moves. An UNDEFINED provider keeps the skill, for the same reason the peripheral predicate answers `true` there.

- [ ] **Step 6: Run the tests**

```bash
bun test packages/shared/src/capabilities/__tests__/
bun test packages/server-core/src/sessions/__tests__/
bun run lint:i18n:parity && bun run lint:i18n:sorted
bun run typecheck:all
```

Expected: PASS, exit 0.

- [ ] **Step 7: Return the tracker row to the orchestrator, then commit**

```bash
git add packages/server-core/src/sessions packages/shared/src/capabilities/resolver.ts packages/shared/src/capabilities/__tests__/resolver.test.ts packages/shared/src/agent/runtime-agent-support.ts packages/shared/src/protocol/runtime-switch.ts packages/shared/src/i18n/locales apps/electron/src/renderer/pages/ChatPage.tsx docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "feat(capabilities): name what stops executing when a session changes runtime"
```


---

### Task 15: Live verification on the owner's real profile

Everything above is proven by unit tests against stubs. This task is the only one that proves the feature on the machine it ships to: the owner's own config directory, their own Nessy Gateway JWT, and their own workspace with real projects. It runs LAST, on a **packaged build** — `electron:dev` runs the host and the Pi subprocess from built bundles, so a main-process change can be on disk and absent from the running app, and `resolveInterceptorBundlePath` starts the Pi subprocess unpatched with no error when the bundle is missing.

**Preconditions (owner-owned, cannot be automated):**
- A signed-in `~/.nessy/dp_auth_creds.json` with a non-expired JWT.
- At least four connections configured: Nessy Gateway (Pi), Claude Code (Nessy Gateway), Codex (Nessy Gateway), and one BYO/`pi_compat` endpoint.
- A workspace with at least one real project that has a git repo and uncommitted-safe scratch space.

**Files:**
- Modify: `docs/testing/cdp-live-checklist.md`
- Create: `scripts/cdp/cases/rts-1.ts` … `rts-8.ts`

**Interfaces:**
- Consumes: every task above — this is the first and only place the whole feature runs as one system, on real credentials.
- Produces: no code symbols. Produces evidence: eight rows in `docs/testing/cdp-live-checklist.md` with real recorded output, and a red/green verdict that gates the release.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Build the packaged app**

```bash
rm -rf release
CSC_IDENTITY_AUTO_DISCOVERY=false bash apps/electron/scripts/build-dmg.sh arm64
```

Expected: a `.dmg` under `release/`. Force dark theme before any screenshot.

- [ ] **Step 2: Write the eight live cases**

| id | case | The failure it catches |
| --- | --- | --- |
| `RTS-1` | Codex session, three turns, change the model, send again. | The reply must reference the earlier turns. Before T1 the thread restarted blank. |
| `RTS-2` | Pi (Nessy Gateway) with real file edits → switch to Claude Code (Nessy Gateway) → ask "what have we changed so far". | The answer must name the files. Proves the T4 handoff (state snapshot + tail) actually arrived. |
| `RTS-3` | Same session → switch back to Pi → ask the same question. | Must NOT silently resume the pre-switch Pi thread and omit the Claude span. Proves the forced-fresh Pi session dir. |
| `RTS-4` | Claude Pro/Max → Claude Code (Nessy Gateway), on a session with prior tool use. | Same runtime: history must resume through the SDK anchor. **Highest-risk row** — a transcript recorded against api.anthropic.com may contain blocks the gateway adapter cannot translate. |
| `RTS-5` | Set `bypassPermissions` under Codex, switch to Pi, then ask the agent to run a shell command. | It MUST prompt. Catches blocker A1 — the one check that proves enforcement followed the record. |
| `RTS-6` | Start a `/loop` under Pi, switch to Claude, wait past two intervals. | No turn may fire. Catches C2. |
| `RTS-7` | Stage a screenshot, switch to Claude Code (Nessy Gateway), send. | Either the image is delivered or the composer refuses and says why. Silence is the failure. Catches C5/T12. |
| `RTS-9` | With a plugin that ships a `when: 'always'` monitor: note its PID in `ps` on Pi, switch to Claude, confirm it is gone, switch back to Pi, confirm a **new** PID appears. | The positive control matters more than the absence — without the return leg the case passes on a build that simply never starts monitors. |
| `RTS-10` | Grant an MCP "always allow" on Pi, switch to Claude, call the same tool. | A card must appear. Without the T3 clear it runs silently on a runtime the user never authorised. |
| `RTS-11` | `/loop 5m …` in the picker after a pi → claude switch. | The skill must be absent. Today it is listed while its four cron tools are pi-only, so the model narrates a schedule it never created. |
| `RTS-8` | Switch mid-turn; then switch while the app is quitting (⌘Q during the confirm). | The first must refuse with the busy copy; the second must let the app exit and release the server lock file. Catches A3/A4. |
| `RTS-12` | Fill a Pi (Nessy Gateway) session to roughly half its window, switch to Codex (Nessy Gateway), send one turn, read the meter. | The number AND the threshold must both belong to Codex: the occupancy must be the codex turn's, the divisor codex's window, and the composer must show NO threshold warning (codex's `thresholdKind` is `none`). Added by T11, whose unit evidence is host-side only. **Read the reading from the session's own runtime log, never from `ContextUsageSnapshot.lastCompaction`** — that field is declared and never filled on the Pi path and has reported "never happened" through twenty-seven real compactions. |

- [ ] **Step 3: Run each case on the packaged build**

```bash
node scripts/cdp/run.mjs --case rts-1 --case rts-2 --case rts-3 --case rts-4 --case rts-5 --case rts-6 --case rts-7 --case rts-8
```

Record real output per row.

**One detector shape has already nearly produced a wrong answer in this repo, and it is in scope here.** A byte scan of the Codex rollout for a joined tool name such as `mcp__session__config_validate` finds **nothing** — not because the call did not happen, but because the rollout stores the pair split: `{"name":"config_validate","namespace":"mcp__session"}`. `scripts/cdp/cases/session-tool-wire-parity.ts` (`85d7f9326`) is the worked example. Any case here that greps a rollout must match the stored shape, or it will report a false absence and be believed.

A case whose detector cannot distinguish "feature worked" from "feature never ran" is not evidence — for `RTS-3` and `RTS-6` read the session's own `.pi-sessions/*.jsonl`, not a typed field, because `ContextUsageSnapshot.lastCompaction` is declared and never filled and has previously reported "never happened" through twenty-seven real events.

- [ ] **Step 4: Record the results in the checklist and the tracker**

Append the eight rows to `docs/testing/cdp-live-checklist.md` with their real outcomes. A red row blocks the release.

- [ ] **Step 5: Commit**

```bash
git add docs/testing/cdp-live-checklist.md scripts/cdp/cases docs/superpowers/plans/2026-08-14-session-runtime-switching.md
git commit -m "test(live): runtime switching verified on a packaged build against the real gateway"
```


---

### Task 6: Close-out

**Files:**
- Modify: `package.json`, `apps/electron/package.json`
- Create: `apps/electron/resources/release-notes/<version>.md`
- Modify: `docs-site/` pages covering connections and conversations, `docs/testing/cdp-live-checklist.md`
- Modify: this plan's Tracker and the deviation log

**Interfaces:**
- Consumes: the green verdict from Task 15. A red row there blocks this task entirely.
- Produces: no code symbols. Produces the release: a bumped version in both `package.json` files, a new per-version release-notes file, updated `docs-site/` pages (including their `ru/` twins), and the regenerated parity report and deviation register.

- [ ] **Step 0: Pre-flight (see Execution protocol)**

Run the five checks against the current tree, then record any divergence in the Corrections log before continuing:

```bash
git log --oneline -12
git status --porcelain
bun run typecheck:all
```

Expected: the tracker's completed rows match the commits listed; typecheck exits 0; every `Consumes` symbol above resolves. A failure here is a plan correction, not an implementation problem.

If this task is **Task 15**, first sweep the Deferred fix-list: nothing on it may still be able to make a live case report the wrong thing. A live run on a build with a known lie in it produces evidence nobody can trust.

Then confirm the plan still describes itself: the task sections, the tracker rows and the **Order** row must name the same set of tasks. If an earlier Step 0 added or superseded one and left the three out of step, fix that before anything else — an Order row that disagrees with the tracker is how a task gets skipped without anyone noticing.

- [ ] **Step 1: Run the full regression**

```bash
rm -rf release
bun run typecheck:all
bun run lint
bun run test:shared:all
bun test
bun run lint:i18n:parity
bun run lint:i18n:sorted
bun run validate:ci
```

Expected: all green apart from rows already recorded in `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. **Compare against `master`, not against this branch's base** — a per-base check cannot see an accumulation.

- [ ] **Step 2: Bump the version in lockstep**

Patch-bump `version` in both `package.json` and `apps/electron/package.json` from the current value.

- [ ] **Step 3: Write the release notes**

Create `apps/electron/resources/release-notes/<version>.md` in the house style (`# Nessy Desktop <version>`, a date line, `## NEW` / `## IMPROVED` / `## FIXED`). Never edit an existing per-version file.

```markdown
# Nessy Desktop <version>

<date>

## NEW

- Switch a conversation's integration at any time, including one that runs on a different runtime. When the runtime changes, the conversation so far is passed to the new one as text and the change is marked in the transcript.

## FIXED

- Changing the model on a Codex conversation kept the conversation. Previously the runtime was restarted and its history silently dropped.
- A model belonging to a previous integration is no longer sent to a new one.
```

- [ ] **Step 4: Update the docs-site**

Update the connections and conversations pages under `docs-site/content/` **and their `ru/` twins** to describe the switch, the three tiers, and that a cross-runtime switch passes the conversation as text.

- [ ] **Step 5: Add the live-test rows**

In `docs/testing/cdp-live-checklist.md`, correct the stale line numbers in `PRV-N9` and add:

| id | case |
| --- | --- |
| `PRV-N22` | Codex conversation, three turns, change the model, send again — the reply must reference the earlier turns. Before T1 it started blank. |
| `PRV-N23` | Pi (Nessy Gateway) conversation with real work done, switch to Claude Code (Nessy Gateway), send again — the reply must reference the earlier work, the transcript must carry the switch marker, and the reasoning level must have been clamped. |
| `PRV-N24` | Switch Pi → Claude → Pi and confirm the returned-to runtime resumes its OWN conversation rather than starting fresh (the anchor map's payoff). |
| `PRV-N25` | Claude Pro/Max → Claude Code (Nessy Gateway) on a conversation with prior tool use: same runtime, so history must resume through the SDK anchor. **This is the highest-risk row** — a transcript recorded against api.anthropic.com may contain blocks the gateway adapter cannot translate. |
| `PRV-N26` | Attempt a switch mid-turn: the picker must refuse with the busy copy, and the running turn must complete unaffected. |

- [ ] **Step 6: Regenerate the derived registers**

```bash
python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md
python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md
```

- [ ] **Step 7: Commit**

```bash
git add package.json apps/electron/package.json apps/electron/resources/release-notes docs-site docs/testing/cdp-live-checklist.md docs/superpowers
git commit -m "chore(release): session runtime switching close-out"
```

---

## Tracker

| Task | Status | Commit | Note |
| --- | --- | --- | --- |
| T1 Codex in-place model switch (`thread/fork`) | ✅ | `26bc740ee` | Defect reproduced on HEAD before the fix: `SessionManager.ts:10746` gates on `managed.agent?.updateRuntimeConfig`, CodexAgent had none, so `refreshed` stayed false and `:10780` disposed — every codex model change started an empty thread. **Two blocking defects in the plan's OWN proposed code, both found at Step 0 and fixed inside the task.** (A) `codexUpdateIsModelOnly` compared `update.runtime?.baseUrl` (the connection's RAW url, sent by `runAgentRuntimeRefresh` `:10752`) against a DERIVED pinned value — `buildCodexRuntimeUpstream` maps the gateway url to `{kind:'nestor'}`, whose baseUrl is `undefined`, while `codexGatewayConnectionDefaults()` does seed a baseUrl. As written the helper would have declined every gateway update, i.e. the feature would have been inert on the primary card. (B) Step 1's test and Step 3's signature did not typecheck together (`Pick<…,'providerType'\|'authType'\|'runtime'>` excludes `model`). Control: the two named codex suites were re-run green, and `codex-agent-lifecycle-hooks` asserts a `thread/fork` COUNT of 2 which the signature change could have moved — it did not, because that test stubs `ensureRuntime` so `_model` is constant across all three drains. Evidence: `bun test` over `codex-model-switch` + `codex-agent-lifecycle-hooks` + `codex-sandbox-globally-enabled` → **14 pass / 0 fail / 31 expect() calls**, and `packages/shared` `tsc --noEmit` exit 0. Anchors: 6 of 14 held; the rest moved (`writeCodexConfig` :349→:313, `applySelectedPluginSkillRuntimePolicy` :568→:598, signature sites :356→:391 and :574→:609, `isProcessing` :787→:850) and the plan contradicted itself on the PiAgent precedent (:7510 in Step 6 vs :7604 in Step 0 — :7604 is right). One plan instruction was unfollowable as written: Step 5 says to edit that method's doc-comment; the method had none, so the block was added. |
| T2 Provider-scoped runtime anchors | ✅ | `9b6b26604` + fix in `bd8fcd44a` | Evidence: `bun test runtime-anchors.test.ts + runtime-anchor-scope.test.ts` → **10 pass / 0 fail / 18 expect() calls**; `typecheck:all` exit 0 at the wave boundary. Control: TDD red was demonstrated by moving the source aside and re-running (module-not-found), then restoring — the tests are coupled to the implementation, not passing incidentally. **`store-v2.ts` was NOT in the Files block and is required**: `headerToMetadata` (:187) hand-copies header fields one by one, and `loadSessionsFromDisk` (:8385) builds every restored session from that projection — without the copy the anchor map is written to disk and never read back, which typechecks and passes every test while silently forgetting every anchor on restart. Two Files-block corrections: `SESSION_PERSISTENT_FIELDS` is at `:32`, not `:42` (Step 5 already said 32 — the block contradicted its own steps); and the "three interfaces carrying `sdkSessionId`" are two interfaces and one NESTED `branchFrom.sdkSessionId` (`:428`), which correctly received no anchor map. Every `SessionManager.ts` coordinate moved by exactly +11 (`:1441`→`:1452`, `:13205`→`:13216`, `:13232`→`:13243`). `codex-runtime` stayed out of `ANCHORED_PROVIDERS` as the plan requires. Anchors: 12 of 22 held. |
| T3 `switchSessionRuntime` | ✅ | `bd8fcd44a` | Defect reproduced on HEAD `d5f90d5d4` before the fix: `setSessionConnection` threw "Cannot change connection after session has started" at `:14727-14730`. Evidence, all from the FINAL tree: `bun test runtime-switch.test.ts + __tests__/runtime-switch-session.test.ts + model-catalog-guard.test.ts` → **36 pass / 0 fail / 61 expect() calls**, re-run and confirmed independently by the orchestrator; `typecheck:all` exit 0; `bun test packages/server-core/src/sessions` → 706 pass / 0 fail across 100 files; `bun test packages/shared/src/agent/backend + __tests__` → 2022 pass / 3 skip / 0 fail. **NEW BLOCKING DEFECT found and fixed inside the task — it was in T2, already committed.** `getOrCreateAgent` runs `migrateLegacyAnchor(anchors, managed.sdkSessionId, provider)` for the INCOMING provider, which adopts the legacy value whenever that provider has no anchor yet — i.e. on every first switch. A Pi→Claude switch would have put the Pi session id into `anchors.anthropic` and handed it to the Claude SDK as a resume target: exactly the lie A5 forbids, arriving through a different door. Fixed by folding the legacy value into the OUTGOING provider's own key before clearing the slot. **The plan's own A3 code reproduced the defect A3 names:** `strictDrainSessionForMutation(managed, reason, boundaryHeld = false)` acquires only when `boundaryHeld` is false, and Step 7 passed `true` while never acquiring — check-without-hold. Implemented the way `rewindToMessage` (`:15298`) and `setSessionProject` (`:15870`) do it: acquire, drain with `true`, release in `finally`. **A2's test expectation was wrong about its own authority:** `normalizeManagedPermissionMode` does not produce `'default'` — `bypassPermissions` lands on `'acceptEdits'` and `explore` on `'plan'`. Expectations rewritten to the authority's real output, with `.not.toBe('default')` kept as the regression assertion. **A1 correction:** `setSessionPermissionMode` is SYNCHRONOUS (`: void`) at `:19327`; the plan's `await` was wrong. **Obligation 1 met in full:** `applyContextUsageSnapshot` writes THREE places (`managed.contextUsage`, `tokenUsage.contextUsage`, `tokenUsage.contextWindow` at `:8493-8495`) — all three cleared. **Obligation 2 narrowed, and this is the one judgement call:** only the managed-id half of the catalog guard is un-scoped; the `connectionDefault → connectionModelIds[0]` substitution stays pi-only, because on a ~388-row synced catalogue it would silently replace the user's declared default with an arbitrary first row. Checked against inert-worklist §3.2 — the rejected fix there was at the PERSISTENCE boundary; `resolveModelForProvider` writes nothing, so this is not that. Controls: negative subject on the catalog scope ("does NOT substitute an out-of-catalog default for a non-Pi connection" paired with "still substitutes for a Pi connection" — together they measure the scope, not a dead branch); positive control for an absence (all three model ids assert `getModelProvider` returns `undefined`, so the guard assertions cannot pass because the cross-provider guard cleared them first); boundary released even when the switch throws. **Control NOT possible, stated:** the A2 capability clamp cannot be driven end-to-end because every provider currently declares all seven permission modes — exactly the audit's "dormant today". The A1 end-to-end test drives the only live narrowing path, `managedPiPolicy.disabledPermissionModes`, on a codex→pi switch; the capability half is unit-covered instead. Two plan instructions were unimplementable as written: `CONNECTION_NOT_FOUND` is not an `ErrorCode` member (kept the plain `Error`, which the plan's own test expects), and Step 9's fixture writing a temp `NESSY_CONFIG_DIR` at module scope is inert because `CONFIG_DIR` freezes at first import — measured 17/18 failures before switching the fixture to `saveConfig` into the frozen dir. Step 9's harness path was also wrong: `refresh-connection-runtime.test.ts` is not under `__tests__/`. |
| T4 Cross-runtime context handoff | ✅ | `afbc94a13` | Evidence, all from the FINAL tree: `bun test runtime-handoff-context.test.ts + __tests__/runtime-switch-session.test.ts` → **30 pass / 0 fail / 69 expect() calls**; `bun test packages/shared/src/agent/__tests__/` → 1787 pass / 2 skip / 0 fail across 160 files; `bun test packages/shared/src/sessions/` → 173 pass / 0 fail; `typecheck:all` exit 0; `git diff --check` clean. TDD red measured first: `SyntaxError: Export named 'buildRuntimeHandoffContext' not found`. **Controls.** (1) *Disabled-source revert* — removing `await this.ensureMessagesLoaded(managed)` from `switchSessionRuntime` turns exactly ONE test red ("loads a cold transcript…", 23 pass / 1 fail), restored and re-run to 24/0: the test is coupled to that line and to nothing else. (2) *Negative subjects, three of them* — no arming and **no notice** on an empty transcript; no arming on a same-runtime change that does have a transcript; the seam returns `null` once applied. Together they measure the gate rather than a dead branch. (3) *The two T3 tests that went red are themselves a control* — the notice and the `hasHistory` gate are observable from outside this task's own tests. **Control NOT possible, stated:** nothing exercises `chatImpl`'s `messageParts` composition — the identical adjacent seam (`branchSeedContext`) has no composition test either and building a `BaseAgent` harness is out of proportion here; the builder, the arming and the disarming are unit-covered and the wiring is typecheck-covered. **Two additions required for the feature to work in production, neither in the plan, both of the "green tests, inert product" class:** the persisted fields needed hand-copies in `loadMessagesFromDisk` (`:9586`) and `hydrateMessagesForColdPersist` (`:8538`) — `headerToMetadata` does not project them, so a quit between the switch and the next turn dropped the handoff and then persisted the loss; and `hasHistory` had to run after `ensureMessagesLoaded`, because `managed.messages` is lazy. **Scope corrected at Step 0:** the task contradicted itself — a three-part payload in its prose against a tail-only design in all nine of its steps, the global File Structure, the Deviations log, this row and its own commit subject. Tail + marker shipped; part C is forbidden by a recorded owner decision; part A (state snapshot) is unbuilt, un-stepped, and recorded in the task body as a bounded follow-up. **Decision inside the task:** the notice is gated on `hasHistory` too — on an empty session it would be the transcript's first row, explaining a discontinuity that never happened. Anchors: 4 of 11 held (`base-agent.ts:2606/:3674/:3707`, `backend/types.ts:568`); `SessionManager.ts` moved +42/+41/+22 and two snippets predated their own dependencies (D1's `role: 'info'`, T3's second parameter). |
| T5 Protocol + picker + dialog | ✅ | `bfb271aec` | Evidence, all from the FINAL tree: `bun test .../input/__tests__/` → **118 pass / 0 fail / 230 expect() calls**; `bun test packages/shared/src/agent/backend/__tests__/composer-capabilities.test.ts` → 16 pass / 0 fail; `bun test apps/electron/src/renderer` → 1325 pass / 0 fail across 148 files; `bun test` over the three task suites together → 158 pass / 0 fail / 327 expect() calls; `typecheck:all` exit 0; `lint:i18n:parity` → "i18n parity OK (1 locales, 2266 keys each)"; `lint:i18n:sorted` exit 0; `apps/electron` lint → 0 errors (119 pre-existing warnings); `git diff --check` clean. **Controls.** (1) *Disabled-source revert on the ROUTING* — deleting the `case 'switchRuntime'` from `rpc/sessions.ts` turns `packages/server-core` red at `sessions.ts(804,15): TS2322: Type '{ type: "switchRuntime"; connectionSlug: string; }' is not assignable to type 'never'`, restored to exit 0. The router's `const _exhaustive: never = command` is what couples the gate to the case, so "typecheck green" is real evidence here rather than a formality. (2) *Negative subject on the capability* — `nestor-cloud-agent` asserts `switchable: false` against three local runtimes asserting `true`; together they measure the predicate, not a constant. (3) *Negative subject on the copy map* — the two tiers must carry different titles AND bodies, which catches a map collapsed onto one string; plus "asks nothing" on both the model tier and the no-history case. (4) *Negative subject on the transcript marker* — `parseRuntimeSwitchMarker` must return `null` for an ordinary `info` row, for the marker word mid-sentence, and for a truncated marker; without it a loose matcher would replace unrelated rows with a switch divider. (5) *Type-level red measured before the change*: `picker-mode.test.ts(18,3): TS2322` — and recorded, because `bun test` reported **5 pass / 0 fail against the OLD implementation**, so the plan's own "run it to verify it fails" step could not see it. **Control NOT possible, stated:** nothing renders `ConnectionRow`/`RuntimeSwitchDialog` in a test — this repo has one component test in the whole input directory (`BranchSwitcher.test.tsx`) and standing up a Radix dropdown + ModalContext harness is out of proportion to the budget; the logic those two components branch on (`classifyConnectionSwitch`, `runtimeSwitchCopyKey`, `derivePickerMode`, `parseRuntimeSwitchMarker`) is pure and unit-covered instead, which is why it was extracted. **Scope, and what was deliberately NOT built:** (a) the playground draft's extra tiers — the >10-models collapse, the 388-model search screen and the reasoning drill-down row — are design exploration beyond the recorded owner decision ("the picker gets a dedicated integration row above the model list, and the hierarchical `switcher` mode is deleted"), and rebuilding the reasoning control is not in any step; (b) **D4's post-switch summary surface is not built** — the fields it exists to show (`droppedAttachments` T12, `stoppedChildren` T13, `capabilityDelta` T17) do not exist, the only post-switch fact T5 can honestly state today is already the transcript notice, and a dialog rendering three empty lists is the speculative work the verification budget forbids. The cost is that T12/T13 will still touch `ChatPage.tsx`; D4's file-ownership goal is met for `RuntimeSwitchDialog.tsx` and both locale files, not for `ChatPage.tsx`. **Deleted:** the `switcher` picker mode and both its UIs (96 lines in `CompactModelSelector.tsx`, 110 in `FreeFormInput.tsx`), `handlePickSwitcherModel`, the flat list's duplicate "using {connection}" header, `FreeFormInput`'s `modelPickerSlot` design seam and the `runtime-switch-in-real-composer` playground entry it existed for — all as that prop's own docstring instructed. Anchors: 3 of 5 held (`rpc/sessions.ts:762`, `session-manager-interface.ts:156`, `ChatPage.tsx:308`); `SessionCommand` moved `:566`→`:570` and `ComposerCapabilities.permissions` `:90`→`:92`. |
| T16 Shared wire surface (events, error codes, types) | ✅ | `6b73b8b11` | Evidence: `bun test apps/electron/src/renderer/event-processor/__tests__/` → **2 pass / 0 fail / 3 expect() calls**, red before the implementation (the appended message was missing, asserted at the test's line 25); `typecheck:all` exit 0. Control: the second test is the negative subject — an event for a DIFFERENT session must not append — so the row cannot pass on a handler that appends unconditionally. **Two files required beyond the Files block, both barrels that are explicit export lists rather than globs**: `packages/shared/src/protocol/index.ts` (without `export * from './runtime-switch'` the new types are unreachable to consumers) and `packages/core/src/types/index.ts`. Three coordinate corrections: the `SessionEvent` union is `:374-479` not `:361-465`; `ErrorCode` is `:75-100`; and the do-not-touch pointer is `ContextUsageSnapshot.source` at **`:647`**, while `:625` is `contextWindowSource?` — a different field, so the plan pointed at the wrong one. Lane F's `thresholdKind` was left untouched as instructed. Anchors: 15 of 19 held. |
| T7 Stop Pi goal / cron / monitor loops | ✅ | `4c799ba41` | **Rescoped at Step 0: two of the three loops were already closed by T3**, which is the outcome the Execution protocol names for this task by name. `clearRuntimeScopedSessionState` clears `goalState` (`:14958`), `stop()`s + deletes the cron service (`:14969`) and calls `sessionMonitors.stopAll` (`:14976`) — so `stopAll` already had the production caller this task was written to give it, and `session-monitor-service.ts` was not touched. Struck the three original tests in the task body rather than deleting them. **What survived, and why:** the goal continuation is reachable with no switch at all — of its **eight** call sites (a `head`-truncated grep shows six; `:19226` and `:20554` sort last), `onProcessingStopped` re-arms after every completed turn and the background-task handler after every settled child, neither provider-gated, while `goalState` is in `SESSION_PERSISTENT_FIELDS` (`shared/sessions/types.ts:50`) and editing a connection's own `providerType` respawns the backend via `tryRefreshAgentRuntime` without clearing it. **Step 4 as written was a regression, corrected:** `deliverMonitorEvent` is the SHARED sink and three of its five producers run on every runtime (MCP channel pushes — the pool is leased for "all backends", `:13151` — R10 detached MCP results, R86 task completions), so the gate went on the two Pi-owned producers via a new `deliverPiMonitorEvent` instead. Evidence, from the FINAL tree: `bun test runtime-switch-session.test.ts` → **29 pass / 0 fail / 64 expect() calls** (24 → 29, five new); the ten suites that name `schedulePiGoalContinuation`/`goalState`/`deliverMonitorEvent` plus `session-cron-service` and `goal-service` → **160 pass / 0 fail across 10 files**; `session-monitor-service.test.ts` → 17 pass / 0 fail; `typecheck:all` exit 0; `git diff --check` clean. **Controls.** (1) *Disabled-source revert, run twice, one line at a time* — removing the goal gate turns exactly ONE row red (`does not re-arm the goal continuation on a non-Pi provider`, 28 pass / 1 fail); restored; removing the `!== 'pi'` half of `deliverPiMonitorEvent` turns exactly ONE different row red (`drops a Pi monitor/cron delivery once the session has left Pi`, 28 pass / 1 fail); restored to 29/0. Each gate is coupled to its own row and to nothing else. (2) *Negative subjects, two* — the identical call on `pi-source` must still arm the goal and still deliver the monitor event; without them a blanket `return` would score the same. (3) *Anti-over-gate control* — `deliverMonitorEvent` itself must STILL queue on a `codex-gateway` session; this is the row that fails if the gate is ever moved back onto the sink, and `mcp-channel-gate.test.ts` (green) is the independent second reader of the same boundary. **Not fixed, noticed:** `void this.sessionMonitors.stopAll(...)` at `:14976` is fire-and-forget inside a synchronous `clearRuntimeScopedSessionState`, so the stop is not ordered against the switch; the new producer gate makes a late delivery harmless but the un-awaited stop itself is untouched. |
| T8 In-flight switch vs app quit | ✅ | `50754157b` | Defect reproduced on the tree before the fix, twice: with `awaitRuntimeSwitchesInFlight` commented out, `cleanup()` rejects with `session-project-mutation-busy` from `acquireSessionMutationBoundary` (`:21782`, inside a `try` with a `finally` and no `catch`), and `setProjectTrust`'s revoke does the same at `:16469`. Evidence, all from the FINAL tree: `bun test .../__tests__/runtime-switch-session.test.ts` → **33 pass / 0 fail / 74 expect() calls** (29 → 33); `bun test packages/server-core/src/sessions` → **721 pass / 0 fail across 100 files**; `typecheck:all` exit 0; `git diff --check` clean. **Controls.** (1) *Disabled-source revert* — commenting BOTH `await this.awaitRuntimeSwitchesInFlight()` calls turns exactly two rows red (`lets cleanup finish while a switch is in flight`, `lets a project-trust revoke finish while a switch is in flight`; 31 pass / 2 fail), restored to 33/0. Run again after the last edit, because the revoke row's `state` had to change (`'blocked'` is not a `ProjectTrustSelection`; the members are `'trusted' \| 'untrusted'` — `tsc` caught it, `bun test` did not). (2) *Negative subject* — `cleanup()` with an empty map must resolve without depending on the new await, so the row above cannot be passing on a `cleanup()` that always waits. (3) *Leak check as a second negative* — a switch that throws (`no-such-connection`) must leave both the map and the boundary empty; a registration left behind would hang every later quit, and nothing else in the suite would notice. **Two traps measured, both of the "green test, no coverage" class.** The plan's own test starts the switch and calls `cleanup()` with no `await` between them — the switch has not taken the boundary yet, so **it passes with and without the fix**; an `await settle()` is what makes it a test. And `setProjectTrust({ session, state })` short-circuits on `session-project-unavailable` before the boundary loop unless `managed.workingDirectory` is set — measured: the first version of that row passed against the un-fixed code. **One file beyond the Files block, found by the package run:** `SessionManager.execution-observability.test.ts:80` builds its cleanup fixture as a bare `Object.create(SessionManager.prototype)` listing every map `cleanup()` reads, so the new one had to be added there — green in the task's own suite, red in the package. It is the only one of the ten `Object.create(SessionManager.prototype)` fixtures that reaches `cleanup()`. **Residual, not fixed:** the wait happens before the boundary loop, so a switch STARTED after that await and before the loop would still throw. Closing it needs a "quitting" latch that makes `switchSessionRuntime` refuse, which is a new refusal on a user-visible surface and therefore an owner decision, not an executor one. |
| T9 Connection delete must not move a live session | ✅ | `62939879a` (+ `aa81028ec` for the typecheck fix) | Evidence, all from the FINAL tree: `bun test .../__tests__/connection-delete-live-session.test.ts` → **9 pass / 0 fail / 11 expect() calls** (new file); `bun test packages/server-core/src/handlers/rpc/__tests__/` → **199 pass / 0 fail across 19 files**; `bun test packages/shared/src/automations` → **464 pass / 0 fail across 23 files**; `bun test packages/server-core/src/sessions` → **721 pass / 0 fail across 100 files**; ~~`typecheck:all` exit 0~~ — **that claim was false and is corrected in T10's commit**: the gate was piped into `tail` and `$?` read `tail`'s status, masking `ISessionManager` missing both new readers (TS2551/TS2339). Fixed in `session-manager-interface.ts`; `typecheck:all` is exit 0 on the tree T10 left, read from the command's own status. `lint:i18n:parity` → "i18n parity OK (1 locales, **2268** keys each)" (2266 → 2268); `lint:i18n:sorted` exit 0; `apps/electron` lint → 0 errors (119 pre-existing warnings, the same count T5 recorded); `git diff --check` clean. **Controls, three disabled-source reverts, one line each.** (1) Forcing the refusal predicate false turns exactly the three refusal rows red (6 pass / 3 fail), restored. (2) Removing ONLY `if (error instanceof CodedError) throw error` from the handler's pre-existing catch turns the SAME three red — which is the finding, not a duplicate: the throw and the re-throw are both load-bearing, and without the second one the code never reaches the wire and the renderer can only print an English server string. (3) Removing `connectionFallback` from `createPromptHistoryEntry` turns exactly one row red (8 pass / 1 fail), restored to 9/0. **Negative subjects.** A connection nothing uses must still delete (asserted on the CONFIG, because the credential manager this handler also calls is unavailable in-process and reports through the same result object — so asserting `success: true` would have measured the credential manager); an unknown slug must still answer `{ success: false, error: 'Connection not found' }` rather than a code; a run that went where it was configured must carry NO `connectionFallback` key; and `listAutomationsUsingConnection` is measured against a **webhook** action carrying an `llmConnection` key, which a matcher without the `type === 'prompt'` guard would wrongly count. **The cross-workspace row is the correction, not a flourish:** `llmConnections.DELETE` is `(_ctx, slug)` with no workspace while connections are global config, so the reader scans every loaded `automationSystems` entry and the test proves it by putting the second automation in a second workspace. **Two files beyond the block, and the task is inert without them:** `AiSettingsPage.handleDeleteConnection` only `console.error`s, so a correctly-refused delete was a button that did nothing — it now branches on the wire code and toasts, with two flat keys in both locales. **One step NOT implemented, with the measurement:** the orphan clear's transcript notice. `appendRuntimeSwitchNotice` needs the runtime the session LEFT, and at that point the connection record is already deleted, so the row could not state a true runtime; the clear also runs inside `loadSessionsFromDisk` at startup where `managed.messages` is lazy and no renderer is subscribed. With the DELETE refusal in place that path is no longer reachable through the product's own door. |
| T11 Does the context state survive a switch? | ✅ | (this commit) | **GREEN WITH NO PRODUCTION CHANGE — the outcome the task names as a success.** Lane F's window/threshold/occupancy properties all survive a switch; `git diff` on `SessionManager.ts` and on every other production file is EMPTY, and the commit adds exactly one file. Evidence, all from the FINAL tree: `bun test .../__tests__/context-usage-after-switch.test.ts` → **5 pass / 0 fail / 26 expect() calls**, real exit 0; together with `runtime-switch-session.test.ts` → **54 pass / 0 fail / 124 expect() calls**; `bun test packages/server-core/src/sessions` → **754 pass / 0 fail across 103 files** (run because the new file `saveConfig`s into the FROZEN test CONFIG_DIR, so its neighbours are the concrete risk); `bun run typecheck:all` → exit **0**, read with `echo $?` directly after the command and NOT after a pipe (T9's row is why); `git diff --check` exit 0. **Controls — four, three of them disabled-source reverts of production lines, all restored, and `git diff packages/server-core/src/sessions/SessionManager.ts` verified empty afterwards.** (1) Comment out `managed.tokenUsage.contextWindow = undefined` in `clearRuntimeScopedSessionState` (`:15352`) → **3 pass / 2 fail**, exactly the two window rows, `Received: 240000` at test lines 230 and 261 — Pi's window dividing codex's tokens, which is the defect this task was pointed at. (2) Comment out the two snapshot clears instead → **4 pass / 1 fail**. So all three of `applyContextUsageSnapshot`'s writes are load-bearing and each is separately asserted. (3) The threshold row is its own control: four arms on one seam producing three distinct values — pi `real` → claude-runtime `formula-claude` → pi→codex `none` → codex→pi `real` — so no arm can pass on a constant. (4) Positive control that the new file is really in the typecheck chain (the `pi-agent-server` trap): appending `const __t11_probe: number = "not a number"` made server-core `tsc --noEmit` exit **2** with `context-usage-after-switch.test.ts(358,7): error TS2322`; probe removed, tsc exit 0. `packages/server-core/tsconfig.json` includes `src/**/*` with no test exclusion. **Measured and deliberately NOT fixed, both recorded in the Corrections log:** (a) a `connection-same-runtime` switch keeps the source's window until the target's first turn, because `clearRuntimeScopedSessionState` runs only on the cross-runtime branch (`:15107`) — bounded by the next turn, identical to the existing model-change path, and clearing it is a new user-visible behaviour the escalation rule sends to the owner; (b) that method's own comment still cites `applyContextUsageSnapshot` as `(:8480)` when it is `:8583`. **The occupancy half is asymmetric on purpose and is now asserted:** the divisor is cleared, the numerator is not, because `tokenUsage.inputTokens`/`contextTokens` are also the session's cumulative accounting — the first turn on the target overwrites them. Live proof is `RTS-12`, added to T15's table (host-side unit evidence cannot show the meter). Was: **Owner decision 2026-08-15: not cut.** Re-scoped from implement to verify — lane F (F1–F9, ✅) did the fix; the switch is the case it structurally could not cover. Green-with-no-change is a valid outcome. Sequenced late, after the switch machinery exists. Was: **blocked by lane F** of `2026-08-14-runtime-icons-plates-model-sync.md`, which does the same work with better measurements (F1–F4). The clearing half is already in T3; the residual assertion moved to T15. Owner decides whether to cut it outright. |
| T12 Attachment capability honoured per runtime | ✅ | `a81339289` | Defect reproduced on `2f1baecf2` before the fix: `runtime-config.test.ts`'s new claude-gateway case measured `omittedImages` **`[]` against an expected `['image.png']`** — `runtime-config.ts:121` returned untouched for every non-`pi_compat` connection, and `to-chat.ts:67` `flattenContent` then dropped the image part without a word. Evidence, all from the FINAL tree: `bun test runtime-config.test.ts + __tests__/runtime-switch-session.test.ts + .../input/__tests__/` → **173 pass / 0 fail / 337 expect() calls across 16 files**; `bun run lint:i18n:parity` exit 0, `bun run lint:i18n:sorted` exit 0; `bun run typecheck:all` **exit 0 read from the command itself, not through a pipe** (`REAL_EXIT=0`). **Controls, three shapes.** (1) Disabled-source revert: replacing `capabilities.attachments.images === 'no'` with `false` in `switchSessionRuntime` turns **exactly one** test red — "names the transcript images a text-only target will never receive" — and no other; restored and re-measured. (2) Negative subject ×3: the same `claude-runtime` connection with `supportsImages: true` on the model KEEPS its image, a direct `anthropic` connection keeps its image (`claude-runtime` collapses onto the `anthropic` AgentProvider, so a provider-keyed filter would have stripped api.anthropic.com too), and a cross-runtime switch to `codex-gateway` from the same transcript reports **no** `droppedAttachments`. (3) Fail-open control: `resolveStagedImagePolicy` blocks on `'no'` alone, so `DEFAULT_COMPOSER_CAPABILITIES`' `'per-model'` — a composer that has not heard from the server yet — does not refuse. **Four corrections at Step 0**, all in the Corrections log; the one that mattered is Step 4: `showVisionWarning` also renders the banner's "Enable image support" action, and widening that single flag would have offered, on `claude-runtime`, a button that clears the warning, re-enables the send and drops the image regardless — the same shared-surface shape T7 caught on `deliverMonitorEvent`. Noticed, not fixed: `submitDisabled` never carried the vision condition, so `chat.submit.blocked.imagesUnsupported` was unreachable copy until this task. |
| T13 Worktree exit + child landing before the switch | ✅ | `33b6b0caf` | **Step 0 found half the task already built and the other half's snippet uncompilable.** The dirty refusal exists (`worktree-lease-service.ts:releaseUnlocked` throws `WorktreeLeaseError('worktree-dirty')` during the drain's `:10548` release loop) — it just arrived as `pi-session-drain-failed:runtime switch (connection-cross-runtime)`, so `WORKTREE_DIRTY` is a re-code, not a second `git status`. The plan's `port.exit({reason})` does not exist in any shape: three separate errors, in the Corrections log. Evidence, all from the FINAL tree: `bun test __tests__/runtime-switch-session.test.ts` → **45 pass / 0 fail / 93 expect() calls**, and `bun test packages/server-core/src/sessions/__tests__/` → **367 pass / 0 fail / 1242 expect() calls across 57 files**; `lint:i18n:parity` exit 0 (2273 keys), `lint:i18n:sorted` exit 0; `bun run typecheck:all` **exit 0 read from the command itself** (`REAL_EXIT=0`). **Controls, four disabled-source reverts, each turning exactly the named rows red and no others.** (1) Comment out `exitWorktreeBeforeRuntimeSwitch(managed)` → 2 fail: "returns the session to the launch directory" and "refuses when the cwd is inside a worktree the port cannot leave". (2) Force `findWorktreeDirtyResidual` to `undefined` → 1 fail: the re-code row. (3) Drop `stoppedChildren` from the returned object → 1 fail: "names the background children the switch stopped". (4) **Move the children read from before the drain to after it → the same row fails**, which is what proves the placement rather than the field: the test's drain stub clears `childSessionState` exactly as the real drain does. **Negative subjects ×3:** a session not inside a lease records **zero** cwd moves (an unconditional exit would pass row 1); an unrelated drain failure (`pi-session-shell-owner-residual` inside an `AggregateError`) comes out with **no** `code` and its own message; a switch with no running children leaves `stoppedChildren` **absent**, and a `completed` child is excluded while `running`/`starting` are not. Ordering is asserted from INSIDE the drain (`cwdAtDrain`), not after it — after the drain both orders look identical. Recorded consequence: the exit runs before the drain, so a switch refused by `WORKTREE_DIRTY` leaves the session already moved back to its launch directory. That is the plan's own "exit first, or refuse" order, and the alternative needs a dirtiness probe `WorktreeLeaseService` does not expose. |
| T14 Mobile (iOS) client | ✅ | `1266d81a3` | Evidence, all from the FINAL tree: `swift test` in `apps/ios/NessyAgentKit` → **96 pass / 1 skip / 0 fail** (88 before, 8 new); `xcodebuild -scheme NessyMobile -destination 'platform=iOS Simulator,name=iPhone 17' test` → **49 pass / 0 fail, TEST SUCCEEDED**; a `generic/platform=iOS Simulator` build of the app → BUILD SUCCEEDED, measured **before** any edit as the green base and again after; `git diff --check` clean. **Controls.** (1) *Disabled-source revert, twice, one line each* — renaming the two `case "connection_changed"` / `"capabilities_changed"` arms turns exactly those two rows red (96 run, 2 fail, both reporting `fell through to unknown(...)`), restored; forcing `RuntimeSwitch.classify` to return `.connectionCrossRuntime` turns exactly one row red (`testClassifiesTheThreeTiers`, "connectionCrossRuntime is not equal to connectionSameRuntime"), restored to 96/0. (2) *Negative subject on the decoder* — `session_model_changed` must still reach its own case, which catches a new arm added above the wrong neighbour; the two new rows alone would not. (3) *Negative subject on the target filter* — `nestor-cloud-agent` asserts `isSwitchTarget == false` against three runtimes asserting `true`. (4) *Negative subject on the copy* — the two tiers must carry DIFFERENT bodies, and `.model` plus `hasHistory: false` must ask nothing; a copy map collapsed onto one string passes every `XCTAssertNotNil` without them. (5) *Boundary row* — `classify(from: (slug: nil, …))` must not read as `.model`, which would skip the confirmation on the first pick after a cold open. **Control NOT possible, stated:** nothing renders `ModelPickerView` — this repo has no SwiftUI view tests at all — so the tiering, the runtime mapping and the target filter were extracted into `NessyAgentKit` where they are pure and unit-covered, and the view is covered only by the compiler. **Command shape settled before implementation:** `switchRuntime` takes `{ connectionSlug }` only; the plan's `model:`/`workspaceId:` parameters belonged to the superseded single-tree design and the server would not have read them (`dto.ts:614`). **Addition the plan did not have, and the picker is inert without it:** the integration row had no opening value — `Session` in the Kit carries no `llmConnection` and `getSessionState` decoded only `messages` + `isProcessing`, so listening for `connection_changed` alone would open a blank row on every session; both fields ride the Session DTO `sessions:getMessages` already returns, so the fix is two optional fields on `SessionMessagesEnvelope` and no new round trip. **Not done here, by design:** launching against a live server is T15's pass (needs a running desktop server and a real JWT); `apps/ios/PROTOCOL-CONFORMANCE.md` is a dated 2026-08-09 measurement snapshot and was left alone — no channel was added, `sessions:command` already carries the switch. |
| T10 Per-message runtime provenance | ✅ | `aa81028ec` | **Step 0 found the task half-built and its remaining half mis-aimed.** T16 already shipped every declaration (`message.ts:271/283/285/401/403`) — what was missing is that **nothing filled them**, so every reader fell back to the session's current connection. `SESSION_PERSISTENT_FIELDS` was the wrong projection to add them to (it is the session HEADER's; messages ride the two spreading mappers instead, so persistence needed no change — proven by a round-trip row rather than assumed). **The one that would have shipped a hole:** Step 3 says stamp "at every `managed.messages.push`", and the **completed assistant message does not use `push`** — it goes through `insertCompletedAssistantMessage` so a finished answer lands above anything queued mid-turn. Twenty sites reached, the twenty-first missed, and every test written from the same mental model green. Evidence, all from the FINAL tree: `bun test .../__tests__/message-provenance.test.ts` → **5 pass / 0 fail / 9 expect() calls** (new file); `bun test .../__tests__/runtime-switch-session.test.ts` → **35 pass / 0 fail / 77 expect() calls** (33 → 35); `bun test packages/server-core/src/sessions` → **728 pass / 0 fail across 101 files**; `bun test packages/server-core/src` → **1613 pass / 0 fail across 201 files**; `typecheck:all` exit 0, read from the command's own status; `git diff --check` clean. **Controls.** (1) *Disabled-source revert, twice* — emptying `stampMessageProvenance`'s two lines turns exactly five rows red across both files (35 pass / 5 fail), including the end-to-end notice row, restored; removing `from`/`to` from the `RuntimeSwitchResult` return turns exactly one different row red (39 pass / 1 fail), restored to 40/0. (2) *Negative subject* — a session with no `llmConnection` must record the runtime and **not** invent a slug, so "absent" stays distinguishable, which the field's own doc-comment requires. (3) *Positive control for an absence* — a legacy row built without the stamp must carry nothing through BOTH mappers; without it, a mapper that defaulted `runtime` would pass every other row. (4) *End-to-end boundary row* — the switch notice must be stamped `runtime: 'pi'` on a pi→anthropic switch, because it is appended before `llmConnection` is rewritten; that is what puts the marker between the two runtimes rather than inside the new one, and it is observable from outside this task's own unit tests. **Step 5 not built, each with its reason** (in the task body): the rewind bullet points at FILE checkpoints, which are session-scoped and learn nothing from provenance; the branch bullet's premise is weaker than stated (`createSession` already refuses on provider mismatch at `:9995`, and a branch-POINT refusal is a new user-visible refusal → owner); the transcript-notice bullet is superseded, since `switchSessionRuntime` knows both providers exactly. `RuntimeSwitchResult.from`/`to` — declared by T16, never filled — are filled instead. **Defect in an already-landed row, found and fixed here:** see the Corrections log — T9's `typecheck:all` was reported green by a `tail`-piped exit code over two real errors. |
| T17 Capability layer across a switch | ✅ | `0fca85638` | Defect reproduced on `e2034d6ea` before the fix, at the resolver: with the new gate compiled out (`if (false && …)`), a plugin LSP row and a plugin monitor row both resolve `unavailableReason: undefined` on `anthropic` and on `codex-runtime` while `getOrCreateAgentUnchecked` starts neither process — the row that fails is "refuses both peripherals on a runtime that starts neither". Evidence, all from the FINAL tree: `bun test packages/shared/src/capabilities/__tests__/` → **412 pass / 0 fail / 1259 expect() calls across 22 files**; `bun test packages/server-core/src/sessions/__tests__/` → **375 pass / 0 fail / 1253 expect() calls across 58 files**; `bun test packages/shared/src/plugins/__tests__/` → 707 pass / 1 skip / 0 fail; `bun test packages/server-core/src/handlers/rpc/__tests__/` → 199 pass / 0 fail; `lint:i18n:parity` exit 0 (2277 keys), `lint:i18n:sorted` exit 0; `bun run typecheck:all` **exit 0 read from the command itself** (`REAL_EXIT=0`). **Controls, four disabled-source reverts.** (1) `if (false && …)` on the resolver gate → 1 fail, the refusal row only. (2) Delete `if (runtimeRunsPluginPeripherals(to)) return undefined` → 1 fail, and it is the **pi ← claude** row, i.e. the delta stops being a delta and becomes "the whole view, always". (3) `if (true) return undefined` at the head of `describeCapabilityDelta` → 2 fail, both positive rows. (4) Restore the loop filter's old body (`isCronDisabled()` alone) → 1 fail, "drops the loop skill on a runtime whose projection has no cron tools". **Negative subjects ×4:** both peripherals stay `active` on Pi and on a provider-blind (`undefined`) read; a plugin **hook** row is NOT gated, because command hooks run everywhere; `loop` survives on Pi and when the runtime is unknown. **Four Step-0 corrections, all in the Corrections log**, two of which would have shipped wrong behaviour: `AgentRuntimeView` has no `components`/`unavailableReason` (the snippet was written against the catalogue's shape and the runtime view's name), and Step 4's instruction to reuse `runtimeDispatchesAgentDefinitions` would have declared LSP and monitors **supported on Claude and Codex** — the task's own lie, inverted. Measured, not assumed: the inert hook kinds are **four** (`prompt` was missing from the task's three) — `SessionManager.ts:12827` withholds four runners off Pi and `hooks-automation.ts:786-831` skips an action whose runner is absent. `unavailableSources` deliberately not built (category error in the snippet; the real defect is Deferred fix-list row 5). Noticed, not fixed: the three session-path peripheral wirings now read the shared predicate, so the catalogue and the session path can no longer drift — but the other ~27 `provider === 'pi' ?` wirings in `getOrCreateAgentUnchecked` still have no catalogue row to be honest in. |
| T15 Live verification on the owner's real profile | ✅ | `b92c4f2b8` | **The task said "run eight cases"; what it actually was is "author twelve drivers, register each in the closed `CASES` array, then run them on a packaged build" — none existed.** Recording the size error rather than absorbing it: a size error that gets silently absorbed teaches nothing. **7 PASS / 2 FAIL-with-finding / 3 BLOCKED.** PASS: RTS-1 (7/7), RTS-2 (11/11), RTS-3 (12/12 after T18), RTS-5 (6/6), RTS-6 (3/3), RTS-7 (6/6), RTS-12 (8/8). FAIL: RTS-8 (4/5 → **T19**), RTS-11 (1/4). BLOCKED with preconditions named: RTS-4, RTS-9, RTS-10. Full evidence, per-case numbers and the rig facts are in `docs/testing/cdp-live-checklist.md`. **Step 0 corrections, five:** (1) Step 3's command does not exist — the runner is `bun run scripts/cdp/run.ts RTS-1 …`, positional and uppercase, not `node scripts/cdp/run.mjs --case rts-1`; copy-pasting it fails before a case runs. (2) Step 5's `git add scripts/cdp/cases` is a directory pathspec, forbidden by this plan's own rule 4, and misses `run.ts`. (3) Step 1 expects a `.dmg`; the dmg step fails on `${env.NESSY_DESKTOP_UPDATE_URL}` and the `.app` is the artifact — same failure and conclusion as the 2026-08-11 sitting. (4) The RTS table holds twelve rows while the Files block and Step 3 name eight, and `RTS-8` sits out of sequence after `RTS-11`, so anyone deriving the list positionally gets the wrong eight. (5) RTS-5's premise is wrong: Pi **does** support `bypassPermissions`, and `renormalizeForRuntime` only rewrites what the target disallows, so "it MUST prompt" would have filed a defect against correct behaviour. **A packaged build cannot use the operator's real profile on this machine** (the rig fact "the whole `/usr/sbin` recipe is INERT on a packaged build", archived in `docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md`) — the wave runs against its own `NESSY_CONFIG_DIR` seeded with the owner's own three gateway cards, which need no credential store and are exactly the three runtimes this plan switches between. **Two detector faults caught before they were believed:** `memoryLeaks` defaulting its `configDir` to `~/.nessy-agent` (a scan of three absent files returns `[]`, which reads as "did not leak"), fixed structurally by `requireSessionDir`; and RTS-5's `echo` probe, refuted by a control — a fresh Pi session in `explore` ran the same command unasked, so the detector could not distinguish the two worlds it compared. Was: eight cases. |
| T18 The handoff must not repeat what the resumed thread already holds | ✅ | `228f91fac` | Found by T15's RTS-3, authorized mid-execution. Two beliefs written into `SessionManager.ts`, both reasonable alone, meeting on the return leg: the outgoing anchor is kept "so coming back still reaches that conversation" (`:15308`), while the cross-runtime branch arms the text handoff on the premise that "the target runtime has no anchor of its own" (`:15109`). Measured on packaged 1.26.1, reproduced on two independent sessions: Pi appended to the SAME `.pi-sessions` sidecar (count 1 → 1) and both pre-switch replies came back inside `<runtime_handoff_context>`. Context cost, not data loss — and it lands in the window lane F spent nine tasks accounting for. **Two wrong attempts, both caught live, neither catchable by the unit rows:** skipping the handoff outright loses the span the other runtime produced (RTS-3's own green half); then keying the trim on provenance alone put the boundary at the END of the transcript, because the user message being sent is appended before `chat()` composes the parts and is stamped with the provider about to answer it — the handoff vanished and a returning Pi session answered "there is no mention of a secret fruit in our conversation" about a fact planted two turns earlier. The boundary is the last **assistant** row with that provenance. Evidence: server-core `tsc --noEmit` exit 0; switch suite **51 pass / 0 fail** with two new rows; **disabled-source control** — reverting the branch turns exactly the `anchor-and-handoff` row red (50/1), restored to 51/0; live re-measure RTS-3 **12/12**. `contextCarried` gains `anchor-and-handoff`; no i18n or copy work, because nothing renders that field. **Test-surface finding: the unit rows passed against both broken versions** — they assert the classification, and the trim lives in a closure inside `getOrCreateAgent`. The live case is the only thing that covered it. |
| T20 The slash list must follow the session's runtime | ✅ | `3a1b46f1b` | Found by T15's RTS-11. **The first diagnosis was wrong and the wrong one was tidier:** the row was written up as "the palette has no runtime filter", on `slash.commandIds: "all"`. That describes the NATIVE command set, which is the same everywhere by design; the skill half has had a filter since T17 (`withoutLoopSkillWhereCronToolsAreAbsent`), applied to the slash-command list and the model-facing view. The real defect was one layer out — the server withheld the skill correctly and the RENDERER never asked again: `refreshCustomSlashCommands` re-ran on workspace, session and working-directory changes and not on a connection change, so the pre-switch list stayed on screen. Fixed by adding the session's connection to that effect's dependencies. Evidence: `apps/electron` `tsc --noEmit` exit 0; `loop-skill-runtime.test.ts` **7 pass / 0 fail** (4 → 7, adding `cronToolsAbsentFor` and the kind-guard row); live re-measure RTS-11 **7/7** on a rebuilt packaged app — offered on Pi, withdrawn on Claude and Codex, where it was offered on all three before. **Lesson recorded in the checklist:** a capability that looks unfiltered is not evidence that filtering is absent, and from outside a stale client is indistinguishable from a wrong server. Also retired the `slash.commandIds !== 'all'` assertion, which stayed RED after the real fix because it asserted an implementation shape rather than what the user sees. `RTS-4` removed in the same commit — owner decision: there will be no Claude Pro/Max subscription, so a permanently BLOCKED row reads as work owed. |
| T19 A refusal must reach the renderer with its code | ➡️ MOVED | — | **Moved to `2026-08-15-base-context-diet.md` as lane N (owner decision 2026-08-15).** Not dropped and not silently deferred — the diagnosis below stands and travels with it. Reason for the move: the defect is NOT runtime-switching-specific. **The mechanism named in this row when it was moved was wrong, and the wrong name points at the wrong seam.** This channel is not `ipcMain.handle` → `ipcRenderer.invoke`: `sessionCommand` goes over the WebSocket RPC client (`WsRpcClient`), and that half is CORRECT — `server.ts:688` maps a `CodedError` through `isErrorCode`, and `client.ts:594-598` re-attaches `err.code` on the preload side. The loss is one hop later, at `contextBridge.exposeInMainWorld` (`preload/bootstrap.ts:492`), which rebuilds a rejected promise's Error in the renderer world from `message` alone — `stack` is REGENERATED (`stackLines: 1`, zero frames) and every own property is dropped. It is still cross-cutting, and still not switching-specific: every coded error on every channel loses its code the same way. Runtime switching merely exposed it, being the first surface whose three refusals each needed a distinct message. Fixing it inside this plan would have hidden a cross-cutting transport defect inside a feature plan. Original diagnosis, measured live at the renderer boundary through `window.electronAPI.sessionCommand`: `{ ownKeys: [], name: "Error", message: "Cannot switch connection while the session is running a turn" }` — no `code`, so `ChatPage.tsx:355`'s branch on `SESSION_BUSY` / `WORKTREE_DIRTY` / `WORKTREE_EXIT_UNAVAILABLE` is unreachable and every refusal shows the generic toast. `WORKTREE_DIRTY` is the costly one: it is the only thing that tells a user their uncommitted work is why the switch failed. Survived to a live run because host-side tests call `switchSessionRuntime` directly, where the CodedError is intact. |
| T6 Close-out (version, notes, docs-site, live rows) | ✅ | `65437d6a9` | **1.26.1 → 1.27.0**, both `package.json` files in lockstep; new `apps/electron/resources/release-notes/1.27.0.md` (append-only, existing files untouched); `docs-site/content/core-concepts/conversations.md` gains a *Changing the Integration* section and its `ru/` twin the same, and the storage table's "locked once the first message is sent" is corrected — that line described the behaviour this plan removed. Parity report regenerated (`python3 scripts/build-parity-report.py`); deviation register regenerated and byte-identical, so no drift. **Full regression on the final tree: `bun test` → 13 646 pass / 0 fail across 1163 files, real exit 0**, with `release/` deleted first (the packaged renderer copies otherwise add ~180 phantom files). `bun run typecheck:all` exit 0, `lint:i18n:parity` exit 0, `lint:i18n:sorted` exit 0. **The comparison against `master` is satisfied trivially and deliberately stated that way: the branch is at ZERO failures**, so it cannot be carrying an accumulation `master` does not have — the failure mode that rule exists for. **The regression earned its keep.** It found a real i18n defect in T5's strings that every focused check had passed over: `chat.runtimeSwitch.stoppedChildren_one` omitted `{{count}}` in English, and because the parity test compares a locale's extra plural forms (`_few`/`_many`) against EN's `_one`, the Russian plurals failed. **48 of the 49 other extra-plural key pairs in the file carry `{{count}}` in the English singular** — T5's string was the outlier, so the fix is to the string and not to the test. Both singulars now carry both variables. Also measured: `nestor-reasoning-proxy-real-server.test.ts:223`, the assertion failure reported red in CI, **passes here** — it is environment-dependent, not a branch regression. |

## Deviations / decisions log

- 2026-08-14 — **`nestor-cloud-agent` is out of scope in both directions** (user, chat): the switch target list filters it, and a session already on it keeps today's behavior. It is a remote agent with no local query substrate and its own mode options; folding it in would make every tier's copy conditional.
- 2026-08-14 — **Anchors are a provider-keyed map, not a single cleared field.** A single field plus a "whose is it" discriminator is ~10 lines cheaper and loses the ability to return to a runtime and find its conversation. The map is the same cost and gives `PRV-N24`.
- 2026-08-14 — **Two controls, not one tree** (owner, chat): the picker gets a dedicated integration row above the model list, and the hierarchical `switcher` mode is deleted. This supersedes the earlier `canSwitchConnection` widening. The model list only ever shows the ACTIVE integration's models, so a model tap can never move a session; the confirmation attaches to the integration row alone and therefore fires once per real decision instead of once per tap near one. It also retires `derivePickerMode`'s four-way precedence — the #727 trap (a single-model `pi_compat` connection making the switcher unreachable) stops existing rather than being worked around. Cost: reaching a model of another integration is two taps instead of one on a fresh session.
- 2026-08-14 — **Confirmation is tiered, not universal**, following Claude Code's rule that the picker "asks for confirmation when the conversation has prior output" rather than on every pick. A model change inside one integration stays silent.
- 2026-08-15 — **The switch notice is gated on the transcript, not on the tier alone** (T4). A cross-runtime change on a session with no messages arms no handoff, reports `contextCarried: 'none'` and writes no notice: with nothing above it the marker would be the transcript's first row, explaining a discontinuity that never happened. Choosing an integration on a fresh session is the common gesture, not a mid-conversation move.
- 2026-08-15 — **T5 ships the pre-flight confirmation only; D4's post-switch summary waits for the fields it would show** (T12 `droppedAttachments`, T13 `stoppedChildren`, T17 `capabilityDelta`). The one post-switch fact available today is already in the transcript notice. Cost, recorded because D4's purpose was file ownership: T12/T13 will still have to touch `ChatPage.tsx`.
- 2026-08-15 — **The playground draft's extra tiers are not built** (T5). `playground/registry/runtime-switch.tsx` remains the accepted visual spec for the integration row, the confirmation and the notice, and those three shipped. Its >10-models collapse, its 388-model search screen and its reasoning drill-down row go beyond the recorded owner decision (integration row + delete the tree) and beyond any step; the reasoning control in the composer is untouched.
- 2026-08-14 — **The handoff carries the transcript, not an LLM summary.** `buildBranchSeedContext`'s bounds (24 messages × 1200 chars) are higher fidelity than a summary and cost no model call. `transferredSessionSummary` remains available and is the escalation if the bounded transcript proves insufficient in live testing — deliberately NOT built up front.
- 2026-08-14 — **`connectionLocked` is kept and still set.** It continues to stop `updateSessionModel` from changing the connection as a side effect; only the explicit `switchSessionRuntime` operation moves a session. Removing the flag would reopen the silent cross-connection model send.
- Category: `product-feature (session runtime switching)` — not a Claude-parity deviation; no parity-report row.

## Open questions for the owner

1. **Should a cross-runtime switch offer "start clean" as an alternative to the handoff?** The dialog currently always hands over. A second button ("switch without carrying the conversation") is cheap and is sometimes what the user wants.
2. **Background work started under Pi** — worktree leases, background children, session crons — is stopped by the dispose. Should the dialog enumerate what will be stopped, or is the generic sentence enough?
3. **`PRV-N25` risk.** If a Claude transcript recorded against api.anthropic.com does not resume cleanly through the gateway adapter, the fallback is to treat `anthropic` ↔ `claude-runtime` as cross-runtime (handoff instead of anchor reuse). That is a one-line change in `classifyRuntimeSwitch` — but it should be a measured decision, not a precaution.
