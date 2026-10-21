> **CLOSED 2026-07-27.** Executed by a user-driven agent; verified independently; evidence in the parity audit §0 (R8).
> A review-found Critical (skill re-attach leaked supportingResources past the 5k/25k budget) was fixed in `6e17f55d` before close.
> Live auto-compaction trigger deferred to the end-of-series wave; the resource bug is integration-covered.
> Kept until the end-of-series sweep. Do not execute again.

# Compaction Parity (R8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring auto-compaction to parity: a better auto summary by routing our instruction layer into the auto path, the documented skill re-attach budget after the summary, the threshold knobs an admin sets, and the thrashing-guard termination reason.

**Architecture:** The manual `/compact` path already composes instructions (`composePiCompactionInstructions`, `pi-agent.ts:5144`) and both hook events already fire (`session_before_compact`→`PreCompact`, `session_compact`→`PostCompact`, `lifecycle-bridge.ts:129-137`). The gaps are: the **auto** path (SDK-driven inside the Pi subprocess) receives no custom instructions — `prompt-composer.ts:84` records "there is no seam to hand it this"; the **skill re-attach budget** (5,000 tokens/skill, 25,000 combined, newest-first) does not exist; the current P7 records retain skill bodies but no invocation chronology; the **threshold knobs** are unexposed even though the reported threshold already derives from `contextWindow - reserveTokens`; and the **thrashing guard** has no termination reason.

**Tech Stack:** TypeScript, Bun test.

**Contract source:** `code.claude.com/docs/en/context-window.md`, `how-claude-code-works.md`, `skills.md`/`slash-commands.md` (the 5k/25k numbers), `settings.md` (`autoCompactEnabled`), `troubleshooting.md` (thrashing). Distilled in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R8 — **READ IT FIRST**; the queue entry carried only half of it.

## Global Constraints

- Scope: Pi runtime + app. Claude/Codex runtimes are flag-off; do not touch them.
- One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits only; do not touch `docs/superpowers/specs/` (you may edit this plan file); Implementation-First Verification Budget.
- **Do NOT reintroduce the crash the audit records.** Calling `session.compact()` alongside the SDK's own auto path is what crashed. The auto path already emits `session_before_compact` and honours `{cancel:true}` / a full `{compaction:{summary,firstKeptEntryId,tokensBefore,details}}` replacement — work WITH that event, never a parallel `compact()` call.
- **Pi-SDK reachability is a real question, not an assumption.** Task 2 must first establish whether the auto path can accept custom instructions at all. If the Pi SDK genuinely exposes no seam (as `prompt-composer.ts:84` currently claims), record it as a Pi limitation the way R9 recorded the one-way lifecycle sink — build what is reachable, name what is not, and do not fake a seam.
- **A deliberate divergence to RECORD, not fix:** P7 put our skill listing in the STABLE prompt parts, so we re-inject it after compaction; Claude does not ("the skill listing is the one exception"). This is arguably ahead. Record it in the close-out; do not remove our listing.
- The series' recurring defect is now SEVEN instances (P6 path/file_path; ifRule; the band; Monitor dispatch; nine dead bindings; test-only zod schemas; ALWAYS_ALLOWED_TOOLS). For every behaviour, assert through the production path, not a stub above it. In particular: the auto path lives in the **Pi subprocess** (`packages/pi-agent-server/src/index.ts`), the manual path in the **host** (`pi-agent.ts`) — a test that exercises only the host path proves nothing about auto.

---

### Task 0: Pre-phase — fold in R5 close-out follow-ups

- [ ] **Step 1:** Read the R5 close-out (audit §0 entry "R5"). R5 was MCP resources/prompts and touched the pool, session tools, and `@`/slash surfaces — none of the compaction path. Confirm that and record "no R5 follow-ups touch compaction" in your Task 1 commit body. R5's one flagged item (the `@`-autocomplete renderer gap) is a UI pass, not this plan.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Confirmed at `142f96abf5507118061f83e3398248f6e2ddc788` on 2026-07-27. No listed anchors moved:
  - `packages/shared/src/agent/pi-agent.ts:5112` `requestCompact(customInstructions)`, `:5144` the `composePiCompactionInstructions(...)` call, `:4472-4473` the manual `/compact` extraction, `:1361-1364` auto-compaction enable, `:2316`/`:2419` `compaction_start`/`compaction_end`, `:4686` the `firstKeptEntryId` result parse.
  - `packages/shared/src/agent/pi-harness/prompt-composer.ts:88` `composePiCompactionInstructions`, and the `:84` comment claiming the auto path has no instruction seam — **this is the claim Task 2 tests.**
  - `packages/pi-agent-server/src/index.ts:2957` `handle.compact(msg.customInstructions)`, `:248` the `compact` message type, `:2997` `session.autoCompactionEnabled`, `:378` the compact result shape.
  - `packages/pi-agent-server/src/extensions/lifecycle-bridge.ts:129-137` — `session_before_compact`→`PreCompact` and `session_compact`→`PostCompact` already wired.
  - P7 invoked-skill state is `BaseAgent.activeSkillInvocations` (`packages/shared/src/agent/base-agent.ts:254`), a key-deduplicated `Map<string, SkillInvocationRecord>` whose records retain `body` (`packages/shared/src/capabilities/runtime-skill-content.ts:20-38`). Its bounded snapshots are carried in `ContinuationEnvelopeV1.invokedSkills` (`packages/shared/src/agent/base-agent.ts:1641-1647`, `packages/shared/src/agent/pi-harness/continuation-envelope.ts:18-22`) and restored into that map (`base-agent.ts:1658-1676`). It has no `invokedAt` or other ordering field.
  - `ContextUsageSnapshot` is `packages/core/src/types/message.ts:452-478`; its existing threshold surface is `autoCompactionEnabled`, `autoCompactionThreshold`, `remainingBeforeAutoCompact`, and `reserveTokens` (`:466-470`). The subprocess derives the threshold as `contextWindow - reserveTokens` (`packages/pi-agent-server/src/context-usage.ts:70-90`), while the host always enables auto-compaction at startup (`packages/shared/src/agent/pi-agent.ts:1361-1364`); no settings/env policy knobs exist yet.
- [x] **Step 2:** Corrected this plan in place: recorded the real P7 skill-state source and missing ordering, plus the existing threshold derivation and absent policy knobs. Commit body names these corrections and confirms no R5 follow-ups touch compaction.

### Task 2: Route the instruction layer into the auto-compaction summary

**Files:** `packages/pi-agent-server/src/index.ts` (the auto-compaction path), `packages/shared/src/agent/pi-harness/prompt-composer.ts` (the `:84` comment + any shared composer), possibly `pi-agent.ts` if the instructions are threaded from the host
- Test: a test that drives the **auto** path (not `requestCompact`)

The manual path passes `composePiCompactionInstructions(custom, references)`; the auto path passes nothing. Establish the seam:
- **First, investigate:** does the Pi SDK's auto-compaction accept a custom-instructions/summary-prompt input? Check the `session_before_compact` event payload and the `handle.compact`/auto-config surface. Write the finding into the plan file before implementing.
- **If reachable:** feed the same `composePiCompactionInstructions(undefined, getPiCompactionReferences())` into the auto path so an auto summary carries the instruction layer and reference re-injection, exactly as manual does. Update the `prompt-composer.ts:84` comment.
- **If not reachable:** record it as a Pi-SDK limitation (name the missing SDK surface), wire whatever IS reachable (e.g. if `session_before_compact` can supply a `{compaction:{...details}}` hint), and leave a follow-up. Do not call `session.compact()` to force it.

**Reachability finding (2026-07-27, installed Pi 0.80.3):** Pi's built-in auto summarizer is not instruction-injectable: `AgentSession._runAutoCompaction` hardcodes `customInstructions: undefined`, calls `compact(..., undefined, autoSignal, ...)`, and the auto-config surface only toggles `setAutoCompactionEnabled(boolean)`. The reachable surface is replacement, not injection: `session_before_compact` supplies `preparation`, `branchEntries`, `reason`, `willRetry`, and the auto controller's `AbortSignal`, and accepts a full `{ compaction }` result. The public `compact(...)` export plus the handler context's model/model-registry and the live session's stream/auth configuration are sufficient to own that one summarization request inside the SDK event and return the replacement without calling `session.compact()`. `pi-agent-core` 0.80.3 mirrors the `{ compaction }` result contract for its explicit `AgentHarness.compact()`, but exposes no automatic-compaction controller/configuration path; the production auto owner here is `pi-coding-agent` through `packages/pi-agent-server/src/index.ts`.

- [x] **Step 1: Write the failing test** — drive an auto-compaction on a stub/real Pi handle and assert the summarisation request carries the composed instructions (the reference-reinjection marker `composePiReferenceReinjection` produces is the observable). If the investigation shows the seam is absent, this task's deliverable becomes the recorded finding + a test pinning that the manual path still composes and the auto path does not regress — commit that instead, clearly labelled.
- [x] **Step 2:** Run — FAIL (or, in the not-reachable branch, establish the pin). **Step 3:** Implement the reachable wiring. **Step 4:** Run — PASS + existing compaction suites unchanged. `bun run typecheck:all`.
- [x] **Step 5:** Commit: `feat(pi): route the instruction layer into auto-compaction` (or `docs+test(pi): pin the auto-compaction instruction-seam limitation` in the not-reachable branch — say which in the body).

### Task 3: The skill re-attach budget

**Files:** the post-compaction re-injection path (where invoked skills are restored), a new pure `skill-reattach-budget.ts`
- Test: colocated, table-driven

Documented algorithm (implement exactly): after the summary, re-attach the **most recent invocation of each skill**, keeping the **first 5,000 tokens** of each, within a **25,000-token combined budget** filled **newest-first**, dropping older skills entirely (not truncating them) rather than throwing. Current P7 state is a key-deduplicated `activeSkillInvocations` map with `SkillInvocationRecord.body`, persisted as continuation-envelope snapshots; it has no `invokedAt`. First make the production state retain the needed recency order, then pass that real order to the selector — do not manufacture timestamps in a test-only adapter.

- Pure function: `selectReattachedSkills(invocations: {skillId; invokedAt; body}[], perSkillTokens=5000, totalTokens=25000): {skillId; body}[]` — newest-first, one entry per skill (its most recent invocation), each capped at 5,000 tokens keeping the START of the body, accumulating until the next whole skill would exceed 25,000, then stop. Use the project's existing token estimator; do not invent one.
- Wire it into the post-compaction re-injection so the survivors are the skills actually invoked, matching "only skills you actually invoked are preserved".

- [ ] **Step 1:** Failing tests: one skill under 5k survives whole; one over 5k keeps its first 5k (start-of-body, assert the tail is dropped); with skills summing past 25k the newest fill first and the oldest are dropped **entirely** (assert a dropped skill contributes zero, not a truncated fragment); the most recent invocation of a repeatedly-invoked skill is the one kept; an empty invocation list yields an empty result, no throw.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement the pure selector + the re-injection wiring. **Step 4:** Run — PASS. Commit: `feat(compaction): skill re-attach budget (5k/skill, 25k total, newest-first)`

### Task 4: The threshold knobs

**Files:** the settings schema (beside `sandbox`/`worktree`), the auto-compaction enable path (`pi-agent.ts:1361`, `pi-agent-server` toggle), env parsing, the managed-policy floor
- Test: schema + enable-path tests

Four documented knobs (map each to our layer; where one has no counterpart, say so):
- `autoCompactEnabled` — settings, default `true`. We already toggle auto-compaction; surface the setting that drives the toggle.
- `DISABLE_AUTO_COMPACT=1` — env, disables auto while leaving manual `/compact`.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — 1-100, **lowers only** (values above the default are ignored), applies to main conversations and subagents. Name our env `NESSY_AUTOCOMPACT_PCT_OVERRIDE` (follow the `NESSY_*` convention this fork uses) and record the Claude name it mirrors.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — capacity in tokens, **capped at the model's real window**. Mirror as `NESSY_AUTO_COMPACT_WINDOW`.
- Accepted env truthiness follows the repo convention (`1/true/yes/on`).

- [ ] **Step 1:** Failing tests: `autoCompactEnabled: false` disables the auto toggle while `/compact` still works; `DISABLE_AUTO_COMPACT=1` disables auto; the pct override lowers the threshold and a value above default is ignored; the window override is capped at the model window; unknown settings keys still throw (strict).
- [ ] **Step 2:** Implement (settings + env + the enable path; managed floor rides the existing `sandbox`-style parse). **Step 3:** Suites + typecheck. Commit: `feat(config): auto-compaction threshold and disable knobs`

### Task 5: The thrashing-guard termination reason + the divergence record

**Files:** the auto-compaction retry path, the termination-reason enum/reporting (the closed `Termination reporting` row's surface)
- Test: retry-path test

Documented: after a successful compaction, if a file or tool output immediately refills the window several times in a row, Claude Code **stops retrying** and reports it. Add the termination reason (reuse the existing terminal-reason wire the `Termination reporting` row shipped — do not invent a parallel one) and stop the retry loop at the documented bound.

- [ ] **Step 1:** Failing tests: N consecutive immediate refills after compaction stop the retry loop and surface the thrashing termination reason; a single refill that then settles does not trip it.
- [ ] **Step 2:** Implement. **Step 3:** Also add a test that records the deliberate divergence (our skill listing survives compaction because it is in the stable prompt parts) — a pin asserting the listing is present post-compaction, with a comment citing that Claude drops it and we are ahead. Commit: `feat(compaction): thrashing-guard termination reason`

### Task 6: Close-out

- [ ] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, the pi-agent-server and server-core suites, `bun run lint`, `git diff --check`.
- [ ] **Step 2:** Mutation probes: (a) drop the per-skill 5k cap → the over-5k test must fail; (b) fill oldest-first → the newest-first test must fail; (c) truncate instead of dropping a skill past the 25k budget → the drop-entirely test must fail; (d) let the thrashing loop retry unbounded → the guard test must fail. Restore all four.
- [ ] **Step 3:** Report: per-task shas, real gate numbers, deviations, probe results, **the Task 2 Pi-SDK reachability finding (reachable or not, and what seam)**, which knobs have no counterpart here, and the CDP cases for the planning session — expected: a real auto-compaction on a long session producing a summary that carries the instruction layer (if Task 2 was reachable), and invoked skills surviving compaction within the 25k budget while the listing also survives. Flag for R11: the 5k/25k selector is the accounting R11's `/context` compaction-survival table consumes — name the exported function.
