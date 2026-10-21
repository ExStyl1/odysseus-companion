# Workflow Recipes and Governance (R4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one-shot `workflow` tool into the documented recipe system: filesystem-loaded saved workflows, invocable as `/<name>` and via `name`/`scriptPath` tool inputs, plus the governance dials and the per-run launch consent.

**Architecture:** The runtime exists — `createWorkflowTool` (`packages/pi-agent-server/src/orchestrator/workflow-tool.ts:286`) runs a `script` with `agent()`/`parallel()`/`pipeline()` and already resolves a saved-registry key through the `workflow(nameOrRef,args)` helper (paths/URLs/inline rejected). Missing: the **filesystem loader** that populates that registry from `.nessy-agent/workflows/`, the **invocation surfaces** (`/<name>`, `scriptPath`/`name` tool inputs), the **governance dials**, and the **launch consent**. Plugin `workflows/` is deferred at `claude.ts:973` — promote it.

**Tech Stack:** TypeScript, Bun test.

**Contract source:** `code.claude.com/docs/en/` — the workflow/orchestration pages, `slash-commands.md` (workflow-as-command), `plugins-reference.md` (`workflows/`), `settings.md` (governance keys). Distilled in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R4 — **READ IT FIRST**; it is five distinct sub-features.

## Global Constraints

- Scope: Pi runtime + app. Plugin *format* import stays in scope (promoting `workflows/`); the Claude/Codex runtimes do not.
- One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits only; do not touch `docs/superpowers/specs/` (you may edit this plan file); Implementation-First Verification Budget.
- **`export const meta` is parsed as a PURE LITERAL** — `name`, `description` required, optional `meta.phases`. No variables, calls, spreads, or interpolation. Reject a computed `meta` with a clear diagnostic; do not `eval` the script to read it.
- **Governance is ADVICE, not an enforced cap** (documented): `workflowSizeGuideline` is sent to the model as guidance, never a hard limit. `disableWorkflows` IS a hard off switch (setting + env + managed) that also removes bundled workflow commands and the keyword trigger. Keep the two straight — one advises, one forbids.
- **The launch consent is a real approval**, per-run, showing the planned phases, with a per-workflow-per-project "don't ask again". It is not the `ws`-style non-suppressible floor; it is a normal remember-able approval.
- The series' recurring defect is now SEVEN instances. The workflow tool runs in the **Pi subprocess** (`pi-agent-server`); the slash-command registry and consent live in the **host** (`server-core`/electron). Assert each surface through its production path — a saved workflow that loads but never registers as `/<name>` is exactly this defect.
- The symlink rule is **asymmetric and load-bearing**: the project location refuses if `.nessy-agent`, `.nessy-agent/workflows`, OR the target file is a symlink; the personal location refuses only if the target file itself is a symlink (so a dotfiles-managed `~/.nessy-agent` still works). Do not collapse the two into one rule.

---

### Task 0: Pre-phase — fold in R8 close-out follow-ups

- [x] **Step 1:** R8 landed through `39423d66` (`docs: close R8 with verified evidence and the review-found reattach fix`). Its close-out changed only the compaction plan/audit; it did not touch the workflow tool, slash-command registry, or workflow-governance settings. Recorded in the Task 1 commit body.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Re-verified at `39423d66`:
  - Pi subprocess: `packages/pi-agent-server/src/orchestrator/workflow-tool.ts:36-43` still requires `script` and accepts `args`, `phases`, `resumeRunId`, `tokenBudget`, and `maxAgents`; `scriptPath`/`name` are absent. `createWorkflowTool` is `:286`, `runScript` is `:556`, and `WorkflowToolDetails` is `:90-100`. A foreground result contains `progress`, nested `result.runId`, `journalPath`, `returnValue`, `logs`, and optional `error`; it has no `scriptPath` or `transcriptDir`.
  - `workflow(nameOrRef,args)` still resolves only `normalizeWorkflowRecipeKey` keys through `defaultWorkflowRecipeStore.get` (`packages/pi-agent-server/src/orchestrator/workflow-recipes.ts:9-25`); paths, URLs, and inline source are rejected.
  - `packages/shared/src/plugins/format-adapters/claude.ts:973` remains `{ externalKind: 'workflow', field: 'workflows', defaultPath: 'workflows' }` in the deferred-surface list.
  - Host slash seam: `SessionManager.pluginPromptCommandEntries` is `packages/server-core/src/sessions/SessionManager.ts:13618`; `listCustomSlashCommandSummaries` joins native/plugin/skill/MCP commands at `:13654-13680`; `resolveCustomSlashCommand` is `:13713`. Native discovery remains `packages/shared/src/slash-commands/custom-commands.ts:157` `listCustomSlashCommands`; saved/plugin workflows must join this existing production seam.
  - `.nessy-agent` discovery is `packages/shared/src/capabilities/native-sources.ts:746-775`; the portable instruction ancestor walk is `:779-807`. There is no project monitor loader to reuse, so Task 2 needs its own recursive workflow loader with the same containment/ancestor shape.
  - Settings live beside `sandbox`/`worktree`: user layers in `packages/shared/src/config/storage.ts:1029-1052`, strict parsers in `sandbox-settings.ts:210` and `worktree-settings.ts:122`, managed policy in `packages/shared/src/agent/pi-harness/managed-policy.ts:36-40`. Correction: `workflow-tool.ts` has **no** large-run warning or 25-agent threshold; it only has the `DEFAULT_MAX_AGENTS = 1000` hard backstop at `:27`.
- [x] **Step 2:** Corrected Task 0/Task 1 state and current anchors; removed the false assertion that a 25-agent large-run warning already exists.

### Task 2: The filesystem loader + asymmetric symlink refusal

**Files:** a new `workflow-loader.ts` (shared, pure where possible), wired into the registry the `workflow(nameOrRef,args)` helper reads
- Test: colocated, temp-tree

- Recursive discovery along the path from cwd to repo root: load from **every** `.nessy-agent/workflows/` on that path, plus `CONFIG_DIR/workflows/`; on a name collision run the one **closest to cwd**; **project-over-personal** overall.
- A save writes to the closest existing `.nessy-agent/workflows/` on the path, else the repo root.
- Parse `export const meta = {name, description, phases?}` as a pure literal (reject computed).
- **Asymmetric symlink refusal** (see Global Constraints) — two distinct rules, each tested.

- [x] **Step 1:** Failing tests over a temp tree: a workflow in `<repo>/.nessy-agent/workflows/` loads and is invocable by `meta.name`; a same-named one closer to cwd wins; a personal `CONFIG_DIR/workflows/` one loads and loses to a project one; a computed `meta` is rejected with a diagnostic; **project location** refuses when `.nessy-agent` is a symlink, when `.nessy-agent/workflows` is a symlink, and when the file is a symlink; **personal location** refuses only when the file is a symlink and accepts a symlinked `~/.nessy-agent`.
- [x] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS. Commit: `feat(workflows): filesystem loader with asymmetric symlink refusal`
  - Landed `33bda9d8`; review fix `11dc9c08` (`fix(workflows): isolate recipes across cwd rollback`).

### Task 3: Invocation surfaces

**Files:** `workflow-tool.ts` (`scriptPath`/`name` inputs + the richer result), the slash-command registry in `SessionManager`
- Test: tool-input tests + slash-registration tests through the production registry

- `workflow` tool gains `name` (resolves a saved or plugin workflow to a script) and `scriptPath` (path on disk; **takes precedence over `script` and `name`**). Every run persists its script under the session directory and returns `{scriptPath, transcriptDir, runId}`, plus an `error` field meaning the script failed its syntax check and never ran even though the launch was accepted.
- A saved workflow registers as an invocable `/<name>` command; a plugin workflow as `/<plugin>:<meta.name>` — join the existing `pluginPromptCommandEntries`/`resolveCustomSlashCommand` seam (R5's precedent), do not invent a second registry.

- [x] **Step 1:** Failing tests: `scriptPath` runs the on-disk script and wins over an inline `script`; `name` resolves a saved workflow; the result carries `scriptPath`/`transcriptDir`/`runId`; a syntax-invalid script returns `{error}` with the launch still accepted (not a throw); a saved workflow appears as `/<name>` through `listCustomSlashCommands`; a plugin workflow appears as `/<plugin>:<name>`; invoking `/<name>` runs it.
- [x] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS. Commit: `feat(workflows): scriptPath/name inputs and /name invocation`
  - Landed `f97f5e1f`; review fix `00c57493` (`fix(workflows): enforce runtime workflow contracts`).

### Task 4: Promote the plugin `workflows/` capability + the governance dials

**Files:** `format-adapters/claude.ts:973` (promote from deferred to imported), the settings schema, the managed-policy floor, `workflow-tool.ts` (the large-run warning), the prompt seam (the size guidance)
- Test: adapter test + settings tests + a guidance-surfaced test

**Anchor re-verification at `00c57493` (before implementing):**
- `packages/shared/src/plugins/format-adapters/claude.ts:973` is still exactly
  `{ externalKind: 'workflow', field: 'workflows', defaultPath: 'workflows' }` in
  `CLAUDE_RETAINED_SURFACE_FIELDS`. Unmoved. `packages/shared/src/plugins/__tests__/format-adapters.test.ts:2312-2328`
  pins `workflow` inside the deferred-kinds list, so promotion changes that test too.
- Settings layers: `packages/shared/src/config/storage.ts:84-87` (`sandbox` / `worktree`
  on `StoredConfig`) and `:1029-1052` (`getUserSandboxSettings` / `getUserWorktreeSettings`).
  Strict-parser precedent: `packages/shared/src/config/worktree-settings.ts` — `assertKnownKeys`
  throws on an unknown key, `enumValue` throws on a bad value, and `resolveWorktreeSettings`
  composes ordered layers with "tighter wins" for the restricting key. Unmoved.
- `packages/shared/src/agent/pi-harness/managed-policy.ts:36-40` still carries the
  `sandbox` floor; `MANAGED_POLICY_KEYS` is `:173` and the parse site `:388`. Unmoved.
- `packages/pi-agent-server/src/orchestrator/workflow-tool.ts`: `DEFAULT_MAX_AGENTS = 1000`
  moved `:27` → `:30` (Task 3 added the `parseWorkflowRecipe` import). Still the only
  agent-count backstop; still no large-run warning.
- **CORRECTION — the tool-description seam cannot carry the size guidance.** The
  `workflow` tool's model contract (description + schema + `promptSnippet` +
  `promptGuidelines`) is hash-pinned: `PI_STATIC_MODEL_CONTRACT_HASHES.workflow`
  (`packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts:49`) is compared in
  `projectPiManifestTools` via `hashProjectedPiToolDefinition`
  (`packages/pi-agent-server/src/harness/tool-manifest.ts:260-263`). A per-session
  guideline in the description would break that hash on every non-default value. The
  guidance therefore rides the PROMPT seam — `PromptBuilder.buildStableContextParts()`
  (`packages/shared/src/agent/core/prompt-builder.ts:199`) — which is also what
  `workflows.md` § Set a size guideline describes ("sends the guideline to Claude as
  advice, not a cap"). The tool keeps only the warning threshold.
- **CORRECTION — `disableWorkflows` must remove the tool at the HOST manifest, not in
  the Pi subprocess.** `validateDefinitions` (`tool-manifest.ts:163-179`) throws when a
  manifest tool has no definition, so dropping `createWorkflowTool` inside
  `pi-agent-server` alone would abort session build. The off switch belongs in
  `finalizePiExecutionManifest` (`harness-manifest.ts:365`), which already filters
  `seed.staticTools`.
- **Nessy has no bundled workflow commands and no keyword trigger today** (`rg` for
  `deep-research` / `ultracode` returns nothing outside docs). So "removes the bundled
  workflow commands" is implemented as: `disableWorkflows` removes EVERY workflow-derived
  slash command (saved + plugin) from the production registry, which is the same surface
  Claude's bundled commands occupy. The keyword trigger is introduced by this task.
- **Doc drift recorded, plan kept:** `workflows.md` now states the size-guideline default
  is `medium` as of v2.1.219 (earlier versions default to `unrestricted`). This plan and
  the spec both specify `unrestricted`, and `unrestricted` is what keeps the documented
  25-agent warning baseline ("The built-in default guideline leaves the threshold at 25").
  Implemented as `unrestricted`; the divergence is deliberate, not an oversight.

- Promote `workflows/` from a deferral to an imported capability kind (mirror how another plugin capability imports; a plugin workflow then loads and becomes `/<plugin>:<name>` from Task 3).
- `workflowSizeGuideline` — `unrestricted` (default), `small` (<5 agents), `medium` (<15), `large` (<50); sent to the model as **advice**, and it controls the new advisory large-run warning (baseline: >25 scheduled agents or >1.5M projected tokens; suppressed when max-effort mode is on). The current tool has no such warning.
- `disableWorkflows` — setting + env + managed; a hard off switch that **also removes bundled workflow commands and the keyword trigger**.
- A separate **keyword-trigger toggle**.

- [x] **Step 1:** Failing tests: a Claude bundle with `workflows/` imports the workflow as a capability (no longer deferred) and it registers as `/<plugin>:<name>`; `workflowSizeGuideline: 'medium'` is surfaced to the model as guidance and moves the warning threshold; `disableWorkflows: true` removes the `workflow` tool AND the bundled commands AND the keyword trigger; the keyword toggle independently disables only the trigger; unknown settings keys throw.
- [x] **Step 2:** Implement. **Step 3:** Suites + typecheck. Commit: `feat(workflows): import plugin workflows and add the governance dials`
  - Deviations, all recorded in the anchor block above: the guidance rides
    `PromptBuilder.buildStableContextParts()` (the tool contract is hash-pinned),
    the off switch acts in `finalizePiExecutionManifest` (the subprocess cannot
    drop a manifest tool), and `disableWorkflows` removes every workflow-derived
    slash command because Nessy has no bundled ones.
  - Three RED tests found in the blast radius were repaired in the same commit:
    the golden workflow marker list (Task 3 split compile from invocation), the
    `InboundMessage`/`OutboundMessage` frozen discriminants (Task 3 never added
    `workflow_execute`/`workflow_execute_result`, and the parser silently failed
    on multi-line union members), and an R5-era stale mock pool missing
    `hasResourceCapability`.

### Task 5: Launch consent

**Files:** the workflow launch path, the approval/permission surface, per-project remember storage
- Test: consent-path tests

- A per-run approval showing the **planned phases** (from `meta.phases`) before agents run.
- A per-workflow-per-project **"don't ask again"** that suppresses future prompts for that workflow in that project.
- Denial = the workflow does not run, no agents spawn, no side effect.

- [x] **Step 1:** Failing tests: a first run prompts with the phase list; denial runs nothing; "don't ask again" suppresses the next run of the same workflow in the same project; the same workflow in a **different** project still prompts; a different workflow in the same project still prompts.
- [x] **Step 2:** Implement. **Step 3:** Suites + typecheck. Commit: `feat(workflows): per-run launch consent with per-project remember`
  - Placement: the consent is a branch of the production `runPreToolUseChecks`
    gate, so it inherits the PermissionRequest band, the approval UI and the
    receipt. It is deliberately NOT marked `nonNegotiable` — that is what makes
    it remember-able rather than the `EnterWorktree` floor — and it is skipped
    in `allow-all` (our `bypassPermissions`).
  - The project key has ONE derivation (`workflowConsentProjectKey`) shared by
    the agent-side reader and the host-side writer, with a test that pins both
    call sites: two derivations would store an approval under one key and read
    it under another.
  - Not covered by an automated test, listed as a CDP case: clicking Always in
    the desktop approval card and observing the next launch start silently.

### Task 6: Close-out

- [x] **Step 1:** Full gates, all at `33bf2062`:
  - `bun run typecheck:all` — exit 0.
  - `bun run lint` — exit 0 (0 errors; 118 + 4 pre-existing warnings).
  - `bun run test:shared:all` — exit 0 (20 + 5 + 66 + 48 pass, 0 fail).
  - `bun run lint:i18n:parity` — OK, 1 locale, 1980 keys. `bun run lint:i18n:sorted` — exit 0.
  - `bun test` (repository) — 8422 pass / 18 skip / 0 fail, 775 files. Run twice
    clean; one intermediate run reported a single failure that did not reproduce
    and whose name never surfaced — recorded as a flake, not a result.
  - `.isolated.ts` sweep — all green except
    `apps/electron/src/main/__tests__/session-branch-rollback.isolated.ts` (3 fail),
    which fails identically at `00c57493` in a clean worktree: a stale mock agent
    missing `setAutomationSystem`/`drainAutomationEvents`, unrelated to R4.
  - pi-agent-server 422 pass / 0 fail; server-core sessions 126 pass / 0 fail;
    `git diff --check` clean.
- [x] **Step 2:** Mutation probes — all four killed a test, all four restored and re-verified green:
  - (a) computed `meta` accepted (`pureLiteral` resolves `Identifier`/`TemplateLiteral`)
    → `workflow-loader.test.ts` 11 pass / **2 fail** (the variable- and
    interpolation-metadata reject tests). Restored: 13 pass / 0 fail.
  - (b) symlink asymmetry collapsed (personal scope refuses a symlinked dir)
    → `workflow-loader.test.ts` 12 pass / **1 fail** (personal-accepts-a-symlinked-config-dir).
    Restored: 13 pass / 0 fail.
  - (c) `workflowSizeGuideline` turned into a hard cap on `agent()`
    → `workflow-tool.test.ts` 32 pass / **2 fail** (the advisory-warning test and
    the high-count backstop test). Restored: 34 pass / 0 fail.
  - (d) denied launch allowed to run (wrapper executes a non-success receipt for
    `workflow`, gate stops requiring consent) → `tool-wrapper.test.ts` **1 fail**
    and `pre-tool-use-checks.isolated.ts` 106 pass / **2 fail**. Restored:
    108 pass / 0 fail and 56 pass / 0 fail across the three workflow suites.
- [x] **Step 3:** Report: per-task shas, real gate numbers, deviations, probe results, and the CDP cases for the planning session — expected: a saved `.nessy-agent/workflows/<name>.js` invoked as `/<name>` runs; a plugin workflow appears as `/<plugin>:<name>`; `disableWorkflows` removes the tool and the commands live; a first launch shows the phase-list consent and "don't ask again" suppresses the next.
