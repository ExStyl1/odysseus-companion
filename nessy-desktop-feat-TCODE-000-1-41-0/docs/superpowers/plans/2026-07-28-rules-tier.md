# The Rules Instruction Tier (R28) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real rules tier: two scopes (user + project), recursive discovery, symlinks RESOLVED, unscoped rules loaded at launch with instruction-file priority, and `paths:` rules that actually fire — matched against the FILE BEING READ instead of the working directory.

**Three things are broken today, not merely missing** (scout-verified 2026-07-28 at `f8513d98`):
1. **Unscoped rules are dropped entirely.** `parseRuleFile` (`packages/shared/src/agent/memory/memory-store.ts:199`) returns `null` when line 1 isn't `---` (`:202-203`) or the closing `---` is missing (`:207`); `ruleMemoryRecords` drops anything the parser rejects. A rule file without frontmatter loads nothing.
2. **Every path-scoped rule silently never fires.** `getWorkingDirectoryMatchPath` (`memory-store.ts:276`) returns the WORKSPACE-ROOT-RELATIVE path of the WORKING DIRECTORY (`.` or `packages/api`), and its single caller `parseMatchingRuleFile` (`:288`) matches the rule's globs against that. A documented file glob like `src/api/**/*.ts` compiles to a pattern that can never match a directory path. Nothing in the tree triggers rules per file read.
3. **Discovery is one level deep and symlink-blind.** `ruleMemoryRecords` (`packages/shared/src/capabilities/native-sources.ts:592`) reads with `entry.isFile()`, which skips subdirectories AND symlinked entries — while the docs REQUIRE symlink support. This is the opposite posture from R4's deliberate symlink refusal; do not copy that pattern here.

**Architecture (verified 2026-07-28, scout):**
- Loader: `ruleMemoryRecords` (`native-sources.ts:592`) — reads `.agents/rules`, `.md` only, no recursion, requires `workingDirectory` (returns `[]` without it), emits through `memoryFileRecords(..., 'rule')`. **Task 1 must confirm whether `<projectRoot>/.nessy-agent/rules` is also read** — an older note says yes, the scout saw only `.agents/rules`.
- Parser: `parseRuleFile` / `parseMatchingRuleFile` (`memory-store.ts:199` / `:288`), match seam `getWorkingDirectoryMatchPath` (`:276`).
- File-read seam for a per-read trigger: `runPreToolUseChecks` + `FILE_PATH_TOOLS` (`packages/shared/src/agent/core/pre-tool-use.ts:102-132`) covers Read/Write/Edit/MultiEdit/Glob/Grep/NotebookEdit. **No per-read rule trigger exists today** — this plan adds one there.
- Compaction-surviving layer: `buildPinnedCapabilityContext` / `composePinnedCapabilityContext` (`packages/shared/src/agent/base-agent.ts:678` / `:702`) compose from `runtime.view.promptLayers` (instruction files) + `runtime.view.memory` (rules), cached per capability generation. Unscoped rules belong here.
- `InstructionsLoaded` fires **once per session** (`packages/pi-agent-server/src/extensions/lifecycle-bridge.ts:93`, payload `source: 'pinned-capability-view'`, Pi-only).
- **SPEC CORRECTION — `claudeMdExcludes` DOES NOT EXIST.** Doc-verification § R28 says to "reuse P8's `claudeMdExcludes` matcher"; the scout found no such symbol anywhere. It must be BUILT here (its documented example points at a rules directory: `"/home/user/monorepo/other-team/.claude/rules/**"`).
- Claude-SDK side (informational): `settingSources: ['user','project','local']` at `claude-agent.ts:301` — that is the SDK's own instruction loading, a different path from our rules tier.

**Contract source:** `code.claude.com/docs/en/memory.md` (the rules section) + doc-verification § R28 (line 528) — **READ BOTH FIRST**; the § R28 entry carries the exact quotes and the hardening budgets.

## Global Constraints

- One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits; no edits to `docs/superpowers/specs/`, the audit, or the CDP checklist; you may edit this plan file. Implementation-First Verification Budget. Tests from the repo root.
- **Two tiers, with priority.** A user-scope rules directory (our `CONFIG_DIR/rules`, the `~/.claude/rules/` equivalent) applies to every project; project rules load AFTER user rules and therefore win. Add `.claude/rules/` beside our own directories (we import Claude's config shapes) — do not replace ours.
- **Unscoped = launch-loaded at instruction priority.** A rule file with no `paths:` frontmatter (including no frontmatter at all) loads at launch with the same priority as the project instruction file, and lives in the pinned capability context so compaction re-injects it.
- **`paths:` rules trigger per FILE READ, not per working directory.** They fire when a tool reads a file matching the pattern, through the `runPreToolUseChecks` seam. Compaction behavior differs deliberately: unscoped rules are re-injected from disk; `paths:` rules are LOST until a matching file is read again — implement that, do not "fix" it.
- **Symlinks are REQUIRED here** (the inverse of R4): a symlinked rules directory and a symlinked rule file both resolve and load; circular symlinks are detected and handled gracefully (no crash, no infinite walk). Recursive discovery: `rules/frontend/react.md` is found automatically.
- **Brace-expansion hardening, exact budgets:** one shared budget of **1,000 expanded patterns and 4 MiB** per rule's `paths` list; over-budget patterns are used UNEXPANDED (their literal braces then match nothing); an unreadable `[` bracket expression matches nothing WITHOUT breaking the rule's other patterns.
- **Build the excludes matcher** (`claudeMdExcludes` equivalent): glob/absolute patterns that skip instruction and rule files under a path — the documented example excludes a whole package's `.claude/rules/**`.
- **Scope gating:** project rules are skipped when `project` is excluded from the setting sources; the `--add-dir` rule loading (`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` equivalent) applies to `--add-dir` directories ONLY, never to the `additionalDirectories` setting.
- **`InstructionsLoaded` becomes per-file**, replacing the once-per-session emission (keep the payload shape, add the file identity).
- **No managed/enterprise rules tier**; `strictPluginOnlyCustomization` has no `rules` surface — this stays project + user scope. Do not invent a managed layer.
- The recurring defect count is FIFTEEN. The chain is discovery → parse → match → pinned context → per-read trigger → emission. Assert through production seams: a matcher that a unit calls with a file path while production still passes the working directory is THE defect (that is literally today's bug). Live re-drive is the planner's pass.
- i18n for any renderer-visible strings.

---

### Task 0: Pre-phase

R20 leftovers: fold in anything the audit routed here after R20 closed; otherwise confirm no-op in one paragraph in this plan file.

- [x] **Step 1:** Confirm/record. **NO-OP.** R20's close-out (`0a77b5ea`) routed nothing to R28: its two fallout defects were both in the hook-decision surface (`hooks-automation.ts` stdout parsing, `hookEventStdoutCanDecide`), and its touched files (task tools, task store, task hooks, the Ctrl+T surface) do not intersect the rules chain. The parity audit's row 9 (`.claude/rules/` as an instruction tier) is still `not started` and is exactly what this plan closes; no other row was re-routed here.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Re-checked every anchor on HEAD (`0a77b5ea`). **Anchor drift (3, all cosmetic line offsets — no behavioural drift):** `parseMatchingRuleFile` declares at `memory-store.ts:283`, not `:288` (`:288` is its `getWorkingDirectoryMatchPath` call); `ruleMemoryRecords`'s `entry.isFile()` filter is `native-sources.ts:609` and the parser-rejection drop is `:613`; `runPreToolUseChecks` declares at `pre-tool-use.ts:861` while `FILE_PATH_TOOLS` is `:124-132` (the plan's `:102-132` covers the constant block only). Confirmed exactly as written: `parseRuleFile` `memory-store.ts:199` returning `null` at `:202-203` / `:207`; `getWorkingDirectoryMatchPath:276`; `ruleMemoryRecords` `native-sources.ts:592`; `buildPinnedCapabilityContext` `base-agent.ts:678` / `composePinnedCapabilityContext:702`; `InstructionsLoaded` once per session at `lifecycle-bridge.ts:93`; `settingSources: ['user','project','local']` at `claude-agent.ts:301`. **`claudeMdExcludes` confirmed absent** — zero occurrences outside `docs/superpowers/` prose, so the SPEC CORRECTION stands and the matcher is built here.

  **(a) Which rule directories `ruleMemoryRecords` reads today — BOTH, and a third.** Three call sites, not one: `<workspaceRoot>/.agents/rules` (workspace scope, `native-sources.ts:703`), `<workingDirectory>/.nessy-agent/rules` (project scope, `nessy` tier, `:768`) and `<projectContainmentRoot>/.agents/rules` (project scope, `portable` tier, `:816`). So the older note was right and the scout's `.agents/rules`-only reading was incomplete. There was **no user/global tier at all** — that is new in Task 2 (`CONFIG_DIR/rules`), as is `.claude/rules/` at the workspace and project tiers.

  **(b) What `runtime.view.memory` carries, and how a rule reaches the model.** `RuntimeMemoryHandle[]` — `{ key, resource, readOnly, format? }` (`capabilities/resolver.ts:717-726`), where `format: 'rule'` is projected from the record's `memoryFormat`. No content travels on the handle: `composePinnedCapabilityContext` materializes each one with `runtime.materializer.readText(layer.resource)` and injects the **verbatim body**, not a summary — for a rule, `parseRuleFile(content)?.body` (frontmatter stripped) with `@import` lines filtered out, wrapped as `<capability-layer key="…">`. Ordering is record push order (global → workspace → project); unlike `promptLayers`, `memory` is not re-sorted, so the user tier lands above the project tier for free.

  **(c) An existing per-read file-path resolution the trigger can reuse — YES.** `FILE_PATH_TOOLS` + `expandToolPaths` (`pre-tool-use.ts:124-195`) already normalize the per-call target from `file_path` (Read/Write/Edit/MultiEdit), `notebook_path` (NotebookEdit) and `path` (Glob/Grep), and `shouldAllowToolInMode` reads `input.file_path` for the deny floor (`:762`). The trigger reuses those same three keys inside `runPreToolUseChecks`, so it sees the post-expansion path the tool will actually open.

  **(d) A rule record's identity for the per-file `InstructionsLoaded` payload.** `NativeCapabilitySourceRecord.key` = `memory::<scopeKind>::<workspaceId|->::<projectKey|->::<discriminator>::<logicalName>` (`qualifiedKey`), which is what survives into `RuntimeMemoryHandle.key`; `logicalName` is now the rule's path **relative to its rules directory** (`frontend/react.md`), so nested and symlinked-in rules cannot collide; `sourcePath` is the absolute file path (server-only, never projected to a renderer DTO); `scope.kind` maps to the documented `memory_type` (`global` → `User`, `workspace`/`project` → `Project`). Together those give the hook `file_path` + `memory_type` + a stable per-file correlation key.

### Task 2: Discovery — recursion, symlinks, two tiers

**Files:** `native-sources.ts` (`ruleMemoryRecords`), a shared rule-discovery helper
- Test: temp trees with subdirectories, a symlinked directory, a symlinked file, and a symlink cycle

- Recursive `.md` discovery; symlinked dirs AND files resolved and loaded; circular symlinks detected without crash or infinite walk; user tier (`CONFIG_DIR/rules`) loaded before project tier so project wins; `.claude/rules/` read beside our existing directories.

- [x] **Step 1:** Failing tests: `rules/frontend/react.md` is discovered; a symlinked rules dir loads; a symlinked rule file loads; a cycle terminates with the reachable rules loaded; a same-named rule in both tiers resolves to the project one; `.claude/rules/` is read. → `packages/shared/src/capabilities/__tests__/rules-tier.test.ts`
- [x] **Step 2:** Run — FAIL (9/9). **Step 3:** Implement (`rule-discovery.ts` + `ruleMemoryRecords`). **Step 4:** PASS (9/9; capabilities suite 162/162). Commit: `feat(rules): recursive two-tier discovery with symlink resolution`

### Task 3: Unscoped rules load at instruction priority

**Files:** `memory-store.ts` (`parseRuleFile` returning a record instead of `null` when frontmatter is absent), the pinned capability context composition
- Test: through `composePinnedCapabilityContext` (the production seam), plus a compaction-shaped re-composition

- [x] **Step 1:** Failing tests (4/4 FAIL): a rule file with no frontmatter loads and its body reaches the composed context; a file with frontmatter but no `paths` also loads; both survive a compaction-shaped re-composition; a `paths:`-bearing rule does NOT load at launch. → `packages/shared/src/agent/__tests__/rules-unscoped-launch.test.ts`
- [x] **Step 2:** Implement — PASS (4/4; memory + capabilities suites 184/184). Commit: `feat(rules): load unscoped rules at launch with instruction priority`

### Task 4: `paths:` rules fire on the file being read

**Files:** the match seam (replace the working-directory compile), a per-read trigger at `runPreToolUseChecks`, brace-expansion hardening
- Test: through the production pre-tool-use pipeline with real tool inputs

- Patterns match the READ FILE's path; `src/api/**/*.ts` fires on reading `src/api/users.ts` and not otherwise; the working-directory compile is gone.
- Brace budgets exactly as in Global Constraints; a bad bracket expression degrades to matching nothing without killing sibling patterns.
- Compaction: `paths:` rules are lost until a matching file is read again (assert it).

- [x] **Step 1:** Failing tests (10/11 FAIL before the fix; the 11th was vacuously true because nothing ever fired): reading a matching file injects the rule; reading a non-matching file does not; a working-directory-shaped pattern no longer matches by accident; over-budget brace lists are used unexpanded (matching nothing); an unreadable `[` expression matches nothing while its siblings still work; after compaction a `paths:` rule is absent until a matching read. → `packages/shared/src/agent/__tests__/rules-path-scoped-trigger.test.ts`
- [x] **Step 2:** Implement — PASS (12/12; shared agent suite 1706 tests). Commit: `feat(rules): trigger path-scoped rules on the file being read`

  **Deviation (reported, not resolved here):** the final delivery hop lives in `packages/shared/src/agent/pi-agent.ts`, which this unit was told not to edit (another agent is reviewing the task-tools commits that touched it). Everything up to it is done and tested: the gate fires the trigger, `BaseAgent` owns the per-generation rule catalog, the once-until-compaction dedup and `consumePendingPathScopedRuleContext()`. Two lines remain — spread `...this.getPathScopedRulePreToolUseContext()` into `checkArgs` (`pi-agent.ts:3370`) and fold `this.consumePendingPathScopedRuleContext()` into `hookAdditionalContext` beside `editFeedbackContext` (`:3471`).

### Task 5: Excludes, scope gating, per-file emission

**Files:** the excludes matcher (new), setting-source gating, `--add-dir` gating, `lifecycle-bridge.ts` emission
- Test: production seams for each

- [x] **Step 1:** Failing tests (3/5 FAIL; the two that passed were negative-direction assertions): an excluded path's rules and instruction files are skipped (the documented `**/some-dir/.claude/rules/**` shape); project rules are skipped when `project` is excluded from setting sources; `--add-dir` directories contribute rules only under the opt-in env, and the `additionalDirectories` setting never does. → `packages/shared/src/capabilities/__tests__/rules-scope-gating.test.ts`
- [x] **Step 2:** Implement — PASS (5/5; capabilities + agent suites 1879 tests). Commit: `feat(rules): excludes matcher and scope gating`

  **BLOCKED, not done: the per-file `InstructionsLoaded` emission.** It cannot be built without editing two files this unit was told to leave alone while the task-tools commits are under review:
  - `packages/shared/src/automations/types.ts` — `SdkAutomationInput` carries none of the documented fields (`file_path`, `memory_type`, `load_reason`, `globs`, `trigger_file_path`, `parent_file_path`); only `path`/`source` exist, and squeezing the payload into those would misreport it. The frozen contract row also pins `owner: 'lifecycle-bridge'` + `terminalDelivery: 'once-per-session'`, both of which must change to `once-per-occurrence` for a per-file emission.
  - `packages/pi-agent-server/src/extensions/lifecycle-bridge.test.ts` — asserts the exact once-per-session payload at a fixed index, so replacing that emission fails a test in a file under review.

  Emitting from `composePinnedCapabilityContext` instead (the seam that DOES know each file's identity) would add a second dispatcher for one event, which the repo's frozen hook-authority rule forbids without the same `types.ts` change. The remaining work is therefore: add the six payload fields to `SdkAutomationInput`; change the `InstructionsLoaded` contract row to `owner: 'base-agent pinned-capability composition'` + `terminalDelivery: 'once-per-occurrence'`; emit one event per instruction/memory layer from `composePinnedCapabilityContext` (`load_reason: 'session_start'`, `memory_type` from `scope.kind`) and one per path-scoped activation (`load_reason: 'path_glob_match'` + `globs` + `trigger_file_path`); drop `lifecycle-bridge.ts:93` and its assertion.

### Task 6: Close-out

- [x] **Step 1:** Full gates, real output:
  - `bun run typecheck:all` — clean (all 8 packages, no output).
  - `bun run test:shared:all` — `llm-connections` 20/20, `models-pi` 5/5, `config` 66/66, `codex-adapter` **46 pass / 2 fail**. Both failures are the `conformance — live gateway` tests, which hit the real Nestor gateway behind `if (!live) return;` and print "live model returned text instead of a tool call (non-deterministic)". PRE-EXISTING and unrelated: R28 changes **0 files** under `packages/codex-responses-adapter`.
  - `bun test packages/pi-agent-server` — **456 pass / 1 fail**. The one failure is `Pi harness R0 baseline > executes golden foreground and background process contracts`, expecting `isolationProfile: 'workspace'` and receiving `'networked'`. PRE-EXISTING: `d214cb63 feat(bash): run shell commands with outbound network allowed` hardcodes `'networked'` at `local-tools/runtime.ts:256` and is an ANCESTOR of this plan's start point `0a77b5ea`; the baseline test file is byte-identical to its pre-R28 content.
  - `bun test packages/server-core` — 909/909, 0 fail.
  - `bun test packages/shared/src/capabilities packages/shared/src/agent` — 1876 pass, 3 skip, 0 fail (172 files).
  - `bun run lint` — exit 0, 0 errors; no warning is in an R28 file.
  - i18n parity/sorted — NOT RUN, correctly: no locale file is touched (no renderer-visible string was added).
  - `git diff --check 0a77b5ea..HEAD` — clean.
- [x] **Step 2:** Mutation probes, all four confirmed then restored (tree clean, suites re-run green afterwards):
  - **(a)** working-directory match restored at the trigger seam (`ruleTargetFilePaths` → `[ctx.workingDirectory]`) → `rules-path-scoped-trigger.test.ts` **2 pass / 10 fail**.
  - **(b)** unscoped rules dropped again (`parseRuleFile` returns `null` without frontmatter and when `patterns.length === 0`) → `rules-unscoped-launch.test.ts` **0 pass / 4 fail**.
  - **(c)** R4-style symlink refusal (`Dirent.isSymbolicLink()` skip + `Dirent.isDirectory()`) → `rules-tier.test.ts` **7 pass / 2 fail**, exactly the symlinked-directory and symlinked-file cases.
  - **(d)** budget ignored (`remaining = Number.MAX_SAFE_INTEGER`) → `rules-path-scoped-trigger.test.ts` **10 pass / 2 fail**, both brace-budget cases.
- [x] **Step 3:** Reported to the caller. **Live/CDP cases for the planner** (none run here — live re-drive is the planner's pass):
  1. Unscoped rule at `.claude/rules/style.md` (no frontmatter) visibly influences the FIRST turn, and still does after `/compact`.
  2. `.claude/rules/api.md` with `paths: ["src/**/*.ts"]` influences a turn ONLY after a matching file is read — not before — and is gone again after `/compact` until the next matching read. **Blocked on the `pi-agent.ts` wiring below.**
  3. A symlinked rules directory (`ln -s ~/shared-rules .claude/rules/shared`) and a symlinked rule file both load; a circular link does not hang startup.
  4. An excluded package's rules are ignored with `instructionExcludes: ["<project>/other-team/.claude/rules/**"]`.
  5. `rules/frontend/react.md` loads from the subdirectory; a user-tier `CONFIG_DIR/rules/style.md` is overridden by a project rule of the same name.

### Carried out of R28 (blocked by the do-not-touch list, both recorded above)

1. **`pi-agent.ts` delivery hop** (Task 4) — two lines, spelled out in Task 4's deviation note.
2. **Per-file `InstructionsLoaded`** (Task 5) — needs `automations/types.ts` + `lifecycle-bridge.test.ts`; the exact edits are spelled out in Task 5's block.
