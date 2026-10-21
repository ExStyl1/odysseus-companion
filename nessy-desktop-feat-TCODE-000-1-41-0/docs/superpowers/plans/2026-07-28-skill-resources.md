# Lazy Skill Supporting Resources (R17) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop shipping every supporting file of an invoked skill into context. Emit each resource as a handle + digest + relative path, and build the resolver that turns a handle back into its pinned bytes on demand.

**Why the resolver comes first (P7 stopped exactly here):** `skill-resource:<hex64>` handles are minted (`packages/shared/src/capabilities/runtime-skill-content.ts:288`, sha256 over key + contentHash + relativePath + digest) and format-validated (`:128`, `/^skill-resource:[a-f0-9]{64}$/`) — and **nothing in the tree resolves one**. P7's Task 6 searched exhaustively and blocked (`docs/superpowers/plans/2026-07-26-skills-invocation.md:485-513`): no session tool, no MCP `resources/read`, no skills RPC. A lazy emit without a resolver would make the resources unreachable, not cheap.

**Architecture (verified 2026-07-28 at `3dd70d6e`, scout + doc fetch):**
- Eager today: `materializeSupportingResources` (`runtime-skill-content.ts:271`) reads every resource up front (`readRelativeText:284`), verifies its digest (`:286`) and stores the CONTENT in the snapshot (`:289`). The snapshot type `SkillSupportingResourceSnapshot` (`:17`) carries `handle`, `digest`, `content`.
- Emission: `formatRuntimeSkillInvocation` (`:394`) writes `<skill-resource handle="…" digest="…">content</skill-resource>` (`:396`) — the content inline, which is the cost R17 removes.
- The safety property to preserve: `validateSkillInvocationSnapshot` (`:135`) verifies `sha256(content) === digest`. Reading the live file instead would bypass exactly this, which is why the model is never handed a skill's absolute path.
- R8 interaction: `selectActiveSkillReattachments` (`packages/shared/src/agent/base-agent.ts:1879`) already forces `supportingResources: []` and `resourceLoaded: false` on re-attach — the lazy design must stay compatible with that, not fight it.
- Nearest seam for the resolver: the R5 resource tools (`packages/session-tools-core/src/handlers/mcp-resources.ts:15`, `list_mcp_resources` / `read_mcp_resource`) — MCP-only today. They are the precedent for a read-a-resource tool with a capability gate, a permission name and an `ALWAYS_ALLOWED_TOOLS` decision.

**Contract source (`code.claude.com/docs/en/skills.md`, fetched 2026-07-28):** "Skills can include multiple files in their directory. This keeps `SKILL.md` focused on the essentials while letting Claude access detailed reference material **only when needed**. Large reference docs, API specifications, or example collections **don't need to load into context every time the skill runs**." Reference them from `SKILL.md` "so Claude knows what each file contains and when to load it". Claude's own mechanism is a PATH plus the ordinary read tool, with `${CLAUDE_SKILL_DIR}` expanding to the skill directory "in the skill's markdown content, and Bash rules in the `allowed-tools` frontmatter", so a bundled script runs without a permission prompt.

## Global Constraints

- One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits; no edits to `docs/superpowers/specs/`, the audit, or the CDP checklist; you may edit this plan file. Implementation-First Verification Budget. Tests from the repo root.
- **The digest stays the authority.** A resolved resource is served from the pinned snapshot and re-verified against its digest before it reaches the model. If the on-disk file has changed since the invocation, the resolver reports that as a named error — it never silently serves newer bytes, and it never serves a live read in place of the pinned one.
- **The model never receives a skill's absolute path for READING.** Reading goes through the handle. (Executing a bundled script is a different question — see the variable decision below.)
- **The lazy emit keeps handle + digest + relative path** in the `<skill-resource>` tag so the model can decide what to fetch, exactly as the docs describe SKILL.md pointing at its files. Drop only the inline content.
- Back-compat: a skill with no supporting resources behaves byte-identically; an already-persisted `SkillInvocationRecord` with inline content must still render.
- Stay compatible with R8's re-attach budget: re-attach already strips resources; lazy emit must not reintroduce them, and a resource fetched after a compaction must go through the resolver again.
- **Decide and record: `${CLAUDE_SKILL_DIR}` / `${NESSY_SKILL_DIR}`.** We have `CLAUDE_PROJECT_DIR` (`packages/shared/src/plugins/data-paths.ts:121-131`) but NO skill-dir substitution anywhere, so the documented "run my bundled script without a prompt" pattern is impossible today. Recommended split: the resolver owns READING (digest-pinned, no path), and the variable owns EXECUTING a bundled script (a path is unavoidable there, and the `allowed-tools` Bash rule is what makes it safe). Implement the variable only if it lands cleanly inside this plan's scope; otherwise record it as a named follow-up with its exact seams rather than half-building it.

  **DECISION (2026-07-28), superseding an earlier "carry it as a follow-up"
  record: IMPLEMENTED HERE, as Task 3b, per owner directive — when parity and
  the documentation require a change to our behaviour, we change our behaviour
  rather than preserve the divergence.** The analysis that it does not land
  cleanly stands and is not withdrawn; the response is to change the two things
  it collides with, deliberately and narrowly, rather than to leave the
  documented contract unmatched.

  Verified in the fetched page: `skills.md:300` defines `${CLAUDE_SKILL_DIR}` as
  "the directory containing the skill's `SKILL.md` file. For plugin skills, this
  is the skill's subdirectory within the plugin, not the plugin root."; `:303`
  says substitution happens in "the skill's markdown content, and Bash rules in
  the `allowed-tools` frontmatter"; `:309`/`:315` show the pair
  (`allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)` plus the same
  string in the body) and state that the rule "matches the exact command the
  skill body tells Claude to run, so the script runs without prompting". Half of
  it would be worse than none — an expanded path with no matching rule always
  prompts — so both halves shipped together.

  **Carve-out 1 — the grant check.** `staticRestriction` and
  `assertStaticRestriction` still throw on every `${VAR}`/`$VAR` in
  `tools`/`model`/`agent`. Exactly ONE variable is expanded before the check
  instead of being refused: the skill directory, in both spellings. What reaches
  the grant check therefore still contains no variable at all, and the value
  substituted is host-derived (`materializer.resolveSkillDirectory`), never
  author- or model-supplied. `${HOST_SECRET}` in `allowed-tools` and
  `$ARGUMENTS` in `model` both still throw, pinned by a test.

  **Carve-out 2 — the model-facing path assertion.** `base-agent.test.ts`'s
  "never exposes its path" case is narrowed, not deleted. The property it now
  asserts is that a skill which does NOT ask for its directory never receives it
  and never sees its `SKILL.md` named; a paired new test asserts that a skill
  which DOES ask gets the directory in both documented places. The
  never-hand-out-a-path invariant is unchanged where it is load-bearing — the
  READ path — and is still asserted in `skill-resource-read-tool.test.ts`.

  **What shipped**, matching the seams recorded before the directive:
  - Value: `CapabilitySnapshotMaterializer.resolveSkillDirectory`, which is the
    SAME expression `readRelativeText` uses for its containment root (both now
    call one `containerDirectory` helper), so the variable and the resolver
    cannot disagree about where a skill lives. It stats behind `assertActive`,
    inside the lease, rather than in the caller. Plugin skills get their own
    subdirectory because `resolvePath` resolves the bundle-relative
    `skills/<name>/SKILL.md` — pinned by a test.
  - Resolved once in `materializeRuntimeSkillInvocation` and threaded into both
    substitution sites, rather than reaching for the materializer inside
    `expandRuntimeSkillBody`.
  - `NESSY_SKILL_DIR` is the emitted name and `CLAUDE_SKILL_DIR` its compat
    alias, the same split `claudeCompatPluginEnv` (`data-paths.ts:126-133`)
    makes for `NESSY_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`. Both spellings expand,
    in `${VAR}` and bare `$VAR` form.
  - When a materializer supplies no directory the variable stays LITERAL, the
    same way an unknown variable does — never expanded to something wrong.
- The recurring defect count is SEVENTEEN. The chain is mint → emit → tool surface → resolver → snapshot lookup → digest re-verify. Assert through production seams: a resolver a unit calls directly while the emitted handle never reaches the model, or a tool that is defined but absent from the projected manifest, is THE defect. Remember built artifacts (`bun run electron:build:servers`) and the live-composition pin guard if any model-facing schema text changes — that cost two live passes already.
- i18n for any renderer-visible strings.

---

### Task 0: Pre-phase — the R28 leftover

R28 deferred per-file `InstructionsLoaded` with its exact edits recorded in `docs/superpowers/plans/2026-07-28-rules-tier.md` (it needs `automations/types.ts`: `SdkAutomationInput` lacks `file_path`/`memory_type`/`load_reason`/`globs`/`trigger_file_path`/`parent_file_path`, and the frozen row pins `owner:'lifecycle-bridge'` + `terminalDelivery:'once-per-session'`; `lifecycle-bridge.test.ts` moves with it).

- [x] **Step 1:** Land it here, or record in this plan file why it is better carried again. If you land it: one emission per loaded instruction/rule file with its identity, the frozen row updated deliberately, and the once-per-session assertion replaced rather than deleted.

  **DECISION (2026-07-28, at `380fe98f`): carried again, to
  `docs/superpowers/plans/2026-07-26-instruction-memory-and-diagnostics.md`
  (27 open steps, and instruction/memory load diagnostics is exactly its
  subject). Not deferred for R28's original reason — that one has expired.**

  R28 blocked because `automations/types.ts` and `lifecycle-bridge.test.ts` were
  under review with the task-tools commits; R20 closed at `3dd70d6e`, so both
  files are editable now. The reason to carry it is new and is about R17:

  1. **It is a different subsystem with a different risk class.** The remaining
     work is a shared wire/schema change (`SdkAutomationInput` gains
     `file_path`/`memory_type`/`load_reason`/`globs`/`trigger_file_path`/
     `parent_file_path`), a frozen hook-contract row rewrite
     (`owner: 'lifecycle-bridge'` → `'base-agent pinned-capability composition'`,
     `terminalDelivery: 'once-per-session'` → `'once-per-occurrence'`), and a
     cross-package dispatcher move out of `pi-agent-server` into
     `packages/shared`. A hook-payload wire change is one of the Implementation-
     First Verification Budget's named immediate risk triggers, and so is R17's
     own new model-facing read surface. Landing both in one series means one
     review covering two independent risk triggers, which is how the
     declared-vs-enforced defects in this loop keep surviving review.
  2. **It has no seam in common with R17.** The R17 chain is
     mint → emit → tool surface → resolver → snapshot lookup → digest re-verify;
     it touches no automation, no hook dispatcher, and no instruction layer.
     Carrying it here buys no shared setup and no shared test fixture.
  3. **This plan gives it no commit subject.** R17's Global Constraints require
     one commit per task with the plan's exact subjects, and every R17 subject is
     `feat(skills): …`. A hook-contract change under a skills subject is a
     mislabelled commit in the release history.

  Nothing is lost by carrying: `2026-07-28-rules-tier.md:98-102` already records
  the exact edits, the exact seam (`composePinnedCapabilityContext`, which knows
  each file's identity), the two `load_reason` values (`'session_start'` and
  `'path_glob_match'` with `globs` + `trigger_file_path`), and the requirement
  that `lifecycle-bridge.ts:93`'s assertion be REPLACED with a per-file one
  rather than deleted. The rule-record identity fields it needs are worked out at
  `2026-07-28-rules-tier.md:56`.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Re-check every anchor on HEAD; correct drifts here; record in Task 2's commit body. Answer IN THIS FILE: (a) where the snapshot lives at resolve time (is it reachable from a session-tool handler, or only inside the agent?) — this decides whether the resolver is a session tool or an RPC; (b) whether `SkillInvocationRecord` persists resource CONTENT to disk today (that decides what a post-restart resolve can serve); (c) what `readRelativeText` guards against (traversal, symlinks) so the resolver inherits the same guarantees; (d) whether any consumer other than `formatRuntimeSkillInvocation` reads `supportingResources`.

  **Anchors re-checked on `380fe98f`. Three cosmetic drifts, no behavioural drift:**
  - `runtime-skill-content.ts:286` COMPUTES the digest (`const digest = sha256(content)`);
    the comparison against the on-disk hash is `:287`.
  - `selectActiveSkillReattachments` DECLARES at `base-agent.ts:1865`; `:1879` is
    the forced `supportingResources: Object.freeze([])` line inside it (the cited
    line is the right one for the stripping claim).
  - `data-paths.ts:121-131` — `claudeCompatPluginEnv` declares at `:126` and the
    `CLAUDE_PROJECT_DIR` entry is `:131`; `:121-125` is its doc comment.

  Confirmed exactly as written: `SkillSupportingResourceSnapshot:17`;
  handle format `/^skill-resource:[a-f0-9]{64}$/` at `:128`;
  `sha256(content) !== digest` at `:135` (inside `validateSkillInvocationSnapshot`,
  which declares at `:101`); `materializeSupportingResources:271`;
  `readRelativeText` call `:284`; mint `:288`; content stored in the snapshot
  `:289`; `formatRuntimeSkillInvocation:394` with the inline
  `<skill-resource …>content</skill-resource>` at `:396`;
  P7's stop record `2026-07-26-skills-invocation.md:485-513`;
  `mcp-resources.ts:15`. **Still true on HEAD: nothing in the tree resolves a
  `skill-resource:` handle.**

  **(a) Where the snapshot lives at resolve time — in the AGENT, and it is
  reachable from a session-tool handler through the established port seam. So:
  SESSION TOOL, not an RPC.** The pinned records live in
  `BaseAgent.activeSkillInvocations` (`base-agent.ts:266`), a private in-memory
  `Map<string, SkillInvocationRecord>` per agent instance. `SessionToolContext`
  has no agent reference, but it does not need one: the repo's standing seam for
  reaching agent/host state from a handler is the session-scoped callback
  registry — a lazy getter on the context
  (`session-self-management-bindings.ts:115` for `mcpResources`) reading a port
  out of `getSessionScopedToolCallbacks(key)`. Both backends already register
  agent-bound lambdas into that registry: `claude-agent.ts:853`
  (`registerSessionScopedToolCallbacks`) and `pi-agent.ts:5592`
  (`mergeSessionScopedToolCallbacks`). Binding `skillResourcesPort` there gives
  ONE resolver, owned by the agent that owns the snapshot, reachable from the
  handler on Claude and Pi alike. An RPC is the wrong shape regardless — the
  MODEL has to make this call, and the model cannot call an RPC channel.

  **(b) No. Resource CONTENT never reaches disk today.** The only persistence
  path for a `SkillInvocationRecord` is the Pi continuation envelope:
  `pi-agent.ts:2386` feeds `getActiveSkillContinuationReferences()`
  (`base-agent.ts:1857`) into `onPiContinuationBoundary`, which
  `SessionManager.ts:10470` stores as `managed.piContinuationEnvelope` and
  `persistSession`s. That producer routes through
  `selectActiveSkillReattachments()`, which forces `supportingResources: []`
  (`:1879`). So every persisted record carries zero resources. Consequences,
  both of which the design must respect: a post-restart resolve can serve
  NOTHING (correctly — the restored record also emits no `<skill-resource>`
  tags, so no live handle points at absent bytes), while an in-process
  compaction keeps working because `activeSkillInvocations` retains the full
  records and only the DERIVED reattachment copy is stripped.
  `validateSkillInvocationSnapshot` does still accept a record that carries
  inline content (`:131`, `:135`), which is the legacy shape Task 3 must keep
  rendering.

  **(c) `readRelativeText` (`materializer.ts:137-159`) guards six things**, and
  the resolver inherits all of them by re-reading through the same function
  rather than opening a path itself: (1) lease liveness — `assertActive()` on
  entry and again after I/O, so a revoked snapshot cannot be read from; (2)
  **containment** — the target is `resolveContainedPath(primaryRoot, relativePath)`
  against the skill's own directory, and `primaryRoot` itself comes from
  `resolvePath`, so an escaping relative path throws instead of reading; (3)
  **plugin-bundle integrity** — `verifyPlugin` re-hashes the bundle for a plugin
  resource, and a native resource re-runs `resolvePath`, whose mtime+content-hash
  check throws `capability-snapshot-stale` if the SKILL file moved under it;
  (4) file-ness — a missing target or a non-file throws
  `capability-snapshot-missing`; (5) text-ness — a fatal UTF-8 decode, so binary
  never enters the snapshot; (6) it returns `contentHash` over the raw bytes,
  which is the value the drift check compares against the pinned digest.
  Symlinks are NOT separately refused here — containment is enforced on the
  resolved path, which is the guarantee the eager path already relies on, and
  the resolver must not silently weaken or "improve" it.

  **(d) No. `formatRuntimeSkillInvocation` (`:395`) is the ONLY consumer that
  reads a resource's `content`.** Every other mention is structural:
  `frozenUnsignedRecord:81` deep-freezes them, `validateSkillInvocationSnapshot`
  `:122`/`:125`/`:138` bounds, rebuilds and de-duplicates them,
  `:155`+`:167`+`:354` derive `states.resourceLoaded` from
  `supportingResources.length > 0`, `:348` stores the materialized array, and
  `base-agent.ts:1879` writes the empty array on re-attach. Nothing in
  `server-core`, `pi-agent-server`, the renderer or any RPC DTO reads them —
  `SessionManager.ts:9560` formats subagent skill prompts through the same
  `formatRuntimeSkillInvocation`. **Consequence for Task 3:** changing the emit
  changes exactly one production reader, and the subagent prompt path at
  `SessionManager.ts:9560` gets the lazy shape for free — including the fact
  that a subagent's prompt will carry handles its own agent instance cannot
  resolve, which is recorded as a known limit rather than silently shipped.

### Task 2: The resolver

**Files:** a resolve function beside `runtime-skill-content.ts` + its exposure through the seam Task 1 chose (session tool preferred, mirroring `read_mcp_resource`)
- Test: through the production tool/RPC surface, not the bare function

- Input: a `skill-resource:` handle. Output: the pinned content, or a named error for: unknown handle, handle from a different session/generation, digest mismatch (on-disk drift), and a handle whose skill is no longer active.
- Permission/manifest: give it a permission name and decide its `ALWAYS_ALLOWED_TOOLS` membership the way R5 did for `read_mcp_resource` — record the decision. It must appear in the PROJECTED manifest, not just the descriptor list (R5's eighth-instance lesson).

- [x] **Step 1:** Failing tests: a valid handle resolves to the exact pinned bytes through the production surface; an unknown handle fails with its named error; a tampered on-disk file yields the digest-mismatch error rather than the new bytes; the tool is present in the projected manifest; a handle from another session does not resolve.
- [x] **Step 2:** Run — FAIL (0 pass / 5 fail, all `read_skill_resource is not in the canonical session tool registry`). **Step 3:** Implement. **Step 4:** PASS (5/5). Commit: `feat(skills): resolve skill-resource handles from the pinned snapshot` — `560bfa98`

  The tool is `read_skill_resource`; the port is `skillResourcesPort`, bound in
  `BaseAgent.publishSkillResourceAuthority` so ONE binding serves Claude and Pi.
  `ALWAYS_ALLOWED_TOOLS`: yes, same call R5 made for `read_mcp_resource`.
  Not `pi-only`, and not conditionally projected — reasons in the commit body
  and beside the registry entry.

  **The manifest test paid for itself on its first run:** the tool had a
  descriptor but no `PI_TOOL_BINDINGS` entry, so `finalizePiExecutionManifest`
  treated it as a dynamic MCP tool and threw
  `Pi execution manifest MCP wireName must resolve exactly once: session`.
  Declared-but-not-projected, caught before it shipped — instance eighteen
  avoided rather than added.

### Task 3: The lazy emit

**Files:** `formatRuntimeSkillInvocation` + `materializeSupportingResources`
- Test: emission shape + a real invocation through the agent

- Emit `<skill-resource handle="…" digest="…" path="…"/>` WITHOUT inline content; keep enough for the model to choose (the docs' "so Claude knows what each file contains and when to load it" — include the relative path, and the size if it is free).
- Materialization becomes lazy: verify the digest at invocation time (cheap, keeps the safety property) but do not carry the bytes into the emitted block.
- R8 compatibility asserted, not assumed.

- [x] **Step 1:** Failing tests: an invocation with two resources emits two handle tags and NO inline content; the emitted handles resolve through Task 2's surface; a skill with no resources is byte-identical to today; a persisted record with legacy inline content still renders; re-attach after compaction still carries no resources and a later resolve still works.
- [x] **Step 2:** Run — FAIL (4 fail; the byte-identical and post-compaction cases passed from the start, being the invariants that must NOT change). Implement — PASS (17/17). Commit: `feat(skills): emit supporting resources as handles instead of inline content` — `0a2ecd0e`

  Emitted shape: `<skill-resource handle="…" digest="…" path="…" bytes="…"/>`,
  self-closing. Size was free (`Buffer.byteLength` over the pinned content).
  Materialization stayed eager on purpose — the snapshot is what the resolver
  serves from and re-verifies against, so only the EMISSION is lazy.

  **One existing expectation was inverted rather than deleted.** The origins
  test asserted the formatted block CONTAINED the guide text and did NOT contain
  `references/guide.md`; both halves flip, because that is precisely what this
  task does. Its load-bearing half — no absolute path in model-facing text — is
  untouched and still asserted.

### Task 3b: The skill-directory variable (owner directive, 2026-07-28)

**Files:** `materializer.ts` (`resolveSkillDirectory`), `runtime-skill-content.ts`
(`expandSkillDirectory`, `expandRuntimeSkillBody`, `staticRestriction`,
`assertStaticRestriction`, `materializeRuntimeSkillInvocation`)
- Test: emission through the real invocation path, plus both carve-outs

- [x] **Step 1:** Failing tests: `${CLAUDE_SKILL_DIR}` and `${NESSY_SKILL_DIR}` expand in the body; a plugin skill resolves to its own subdirectory rather than the plugin root; an `allowed-tools` Bash rule expands to the same string the body names; any OTHER variable in a restriction still throws.
- [x] **Step 2:** Run — FAIL (3 fail; the "still refuses any other variable" case passed from the start, being the negative direction). **Step 3:** Implement. **Step 4:** PASS. Commit: `feat(skills): expand the skill-dir variable in bodies and allowed-tools`

### Task 4: Close-out

- [x] **Step 1:** Full gates, real output:
  - `bun run typecheck:all` — exit 0, clean across all 8 packages.
  - `bun run lint` — exit 0, 0 errors (118 + 4 pre-existing warnings, none in an
    R17 file).
  - `bun run test:shared:all` — 20/20, 5/5, 66/66, 48/48, 0 fail.
  - `bun test packages/shared/src/capabilities packages/shared/src/agent packages/session-tools-core`
    — **2073 pass, 3 skip, 0 fail**.
  - `bun test packages/session-tools-core` — 176/176.
  - `bun test packages/server-core` — 909/909.
  - `bun test packages/pi-agent-server` — 456 pass / 1 fail. The one failure is
    `executes golden foreground and background process contracts`
    (`isolationProfile: 'workspace'` vs `'networked'`), PRE-EXISTING and
    confirmed against a clean `5f3439fa` worktree with linked `node_modules`.
  - `bun test packages/shared` (whole package) — 5467 pass / 18 skip / **10
    fail**. All ten are pre-existing: the same worktree baseline fails 24 (its
    extra `PiAgent …` failures are worktree artifacts), and every one of my ten
    (`ensureStorageLayoutV2` ×7, `config path default-root classification` ×2,
    `managed paths with NESSY_CONFIG_DIR`) appears in that baseline list.
  - `git diff --check` — clean.
  - Model-facing schema text DID change (a new tool description), so
    `bun run electron:build:servers` ran; the live-composition pin guard
    (`live-manifest-contract.test.ts`) is **3/3** afterwards, and the staged
    `session-mcp-server` bundle contains the new tool.
  - Also flaky, not mine: `Pi runtime cwd transaction > keeps PREPARE private…`
    alternates pass/fail on an unchanged tree (observed both, back to back).

  **Three pins the gates forced, all deliberate updates rather than loosened
  assertions:** the 46→47 session-tool count and the new row in
  `fixtures/tool-surface.json`; that fixture's `hostCallbackExcludedNames` and
  `schemaContracts` (the live schema digest computed with the test's own
  `canonicalJson`, not invented); and `fixtures/runtime-behavior.json`'s
  `CapabilitySnapshotMaterializer` shape, which gained `resolveSkillDirectory`
  from Task 3b and was caught by the full `pi-agent-server` run.

- [x] **Step 2:** Mutation probes — all four confirmed, all four restored (each
  by copying the file aside first and copying it back, then re-running to green;
  `git diff --stat` empty after each):
  - **(a)** serve the live file instead of the pinned bytes (`content: live.content`,
    drift check removed) → `reports on-disk drift instead of serving the new bytes`
    **fails**; 6 pass / 1 fail.
  - **(b)** keep the inline content in the emit → **4 fail** / 17 pass:
    `emits every supporting resource as a handle tag and no inline content`,
    `still renders a persisted record whose resources carry legacy inline content`,
    `loads bundled references through opaque snapshot handles…`, and the agent-level
    `sends the model a handle tag instead of the file body`.
  - **(c)** drop the tool from the PROJECTION while keeping its descriptor
    (filter in `getToolDefsAsJsonSchema`, registry untouched) →
    `is present in the projected Pi execution manifest, not just the descriptor list`
    **fails alone**; 6 pass / 1 fail. (A blunter probe that also removed it from
    `getSessionToolDefs` failed all 7 — the surgical one is the real
    declared-vs-enforced split, so that is the recorded result.)
  - **(d)** search every live agent's snapshot instead of this session's →
    `does not resolve a handle minted by another session` **fails**; 6 pass / 1 fail.

- [x] **Step 3:** Reported to the caller. **Live/CDP cases for the planner** (none run here):
  1. Invoke a skill that bundles `references/guide.md`: the turn shows
     `<skill-resource … path="references/guide.md" bytes="…"/>` and NOT the file
     body, and the token cost of the turn drops by roughly the file's size.
  2. The model calls `read_skill_resource` with that handle and gets the file
     contents back, in the same turn it was minted (the unconditional projection
     is what makes this possible — verify it, since it is the decision most
     likely to be wrong).
  3. Edit the file on disk between invocation and fetch: the fetch reports
     `skill-resource-changed` and neither the old nor the new text appears.
  4. `/compact`, then fetch the same handle again: the re-attached block carries
     no `<skill-resource>` tags and the fetch still succeeds. After a full app
     restart the same handle reports `skill-resource-unknown-handle` — resources
     are not persisted, by design.
  5. A skill with `allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)`
     and the same string in its body runs the script WITHOUT a permission
     prompt; a plugin-bundled skill resolves to its own subdirectory, not the
     plugin root.
  6. Safe/plan mode: `read_skill_resource` is callable without a prompt, and a
     `deny read_skill_resource` rule blocks it.
