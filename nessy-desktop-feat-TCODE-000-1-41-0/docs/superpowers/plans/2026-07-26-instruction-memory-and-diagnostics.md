> **CLOSED — do not execute.** Landed as `46ccf138`, `b60581d5`, `0e0db90f`,
> `22e04372`, `2386046c`, `10a22a7d`. All four tasks shipped; **14 058 bytes of
> duplicate reads plus two SHA-256 saved per turn**, and the monorepo ancestor walk
> verified through the production path. Two executors died on API 529 mid-plan; a
> third finished it from a verified state brief. This plan had a **task-ordering
> defect** (Task 2 was told to reuse a constant Task 3 deletes) and two wrong file
> paths — see the audit row. Retained for the end-of-series review. Evidence in
> `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` §0, row P8.

# Instruction/Memory Cost and LSP Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-sending the full text of every instruction file and the whole memory block in every user message, start finding instruction files up the directory tree, and let LSP diagnostics reach the model through the post-edit channel that already exists.

**Architecture:** Two halves that share nothing but a plan. The context half stops
paying per turn for content that changes rarely, keyed to the capability generation
that already tracks exactly that. The diagnostics half connects a sink that already
exists to a delivery channel that already exists — deliberately **not** to the
`tool_result` seam, which is single-slot and occupied.

**Tech Stack:** TypeScript, Bun test runner. Packages: `@nessy-agent/shared`
(`src/agent`, `src/capabilities`, `src/prompts`), `@nessy-agent/server-core`
(`src/sessions`, `src/pi-harness`).

Covers audit shortlist items 9 and 10 (§0 row P8). **Both rows were re-framed** by the
re-verify research — read `§5c` of the audit before starting, and note the two
findings that would otherwise have produced a wrong plan.

## Before you start: re-verify

Done by the planning session on 2026-07-26; anchors read at HEAD `4abb5677`, full
findings in the audit's `§5c`. Re-run the two starred items if HEAD has moved a lot —
`PX` landed in `server-core/src/sessions/SessionManager.ts` after this research.

- [x] **Instructions and memory ride the user message, every turn, uncapped.**
  `BaseAgent.buildPinnedCapabilityContext()` (`agent/base-agent.ts:489`) is called
  unconditionally from `chat()` at `:1525` and prepended at `:1526`. It loops
  instruction layers (`:494-497`) and memory layers (`:498-508`), each body a fresh
  `readText` — `readFileSync` + `statSync` + sha256 verify per call, no content cache
  (`capabilities/materializer.ts:118-136`).
- [x] **The 10 KB cap does not apply there.** `MAX_CONTEXT_FILE_SIZE`
  (`prompts/system.ts:17`) is reachable only through `getProjectContextFilesPrompt`,
  which `agent/core/prompt-builder.ts:138` skips whenever the capability runtime is
  active — and it is active on every normal send. So this repo's own 14 047-byte
  `AGENTS.md` is re-sent in full every turn.
- [x] **A `remember` write already forces a new capability generation** by tripping the
  snapshot integrity check (`materializer.ts:132-134`). That is the invalidation signal
  this plan should key a cache to, rather than inventing one.
- [x] **No ancestor walk for instruction files.** `PROJECT_INSTRUCTION_FILES`
  (`capabilities/native-sources.ts:54`) is read at exactly two fixed directories,
  `context.workspaceRootPath` (`:692-695`) and `workingDirectory` (`:756-759`). The
  walk primitive exists and is already used **for skills**: `ancestorsUpTo`
  (`:609-621`, used at `:751-754`) with `context.projectRoot`
  (`capabilities/types.ts:153`).
- [x] **A dead trio.** `clearPinnedPreferences` (`prompt-builder.ts:273`) and
  `formatPreferences` (`:259`) have **zero** callers, so
  `PromptBuilder.pinnedPreferencesPrompt` (`:48`) is never written. The fields that are
  actually pinned are already cleared on clear (`claude-agent.ts:2688`,
  `pi-agent.ts:5443`).
- [x] **A dead descendant walk with a live invalidator.**
  `findAllProjectContextFiles` (`prompts/system.ts:228-284`) is a recursive walk
  **downward** with a 5-minute cache and zero production callers — but its invalidator
  is still called at `SessionManager.ts:11453`, invalidating a cache nothing reads.
- [x] **Post-edit diagnostics already ship, enabled by default.** `editFeedbackEnabled:
  true` (`SessionManager.ts:359`), injected at `:9525-9532`, runner
  `buildEditFeedbackRunner` (`:3951-3987`), agent side `pi-agent.ts:2326-2419`, scoped
  to `Edit`/`Write`/`NotebookEdit` (`:2380-2383`), delivered as the **next PreToolUse
  `additionalContext`** (`:2419-2421`), sourced from the project's own checks
  (`detectChecks`, `SessionManager.ts:3956`). **This is the channel to feed.**
- [x] **The LSP sink exists and is never passed.** Buffer at
  `server-core/src/pi-harness/lsp-service.ts:87` (bounds `:34`, `:40`, populated
  `:343-368`); `onDiagnostics` option at `:105-106`, invoked `:371`; neither
  production construction supplies it (`SessionManager.ts:8936-8954`, `:8967-8975`).
  `PiLspPort.onDiagnostics?` is declared (`pi-harness/lsp-port.ts:117-123`) but
  `createPiLspPort` returns only `health` + `request` (`SessionManager.ts:1813-1829`).
- [x] **The `tool_result` seam is single-slot and occupied** by the PostToolUse hook
  transform (`pi-agent-server/src/index.ts:1481`, `:2372`, `:1566-1587`;
  `extensions/lifecycle-bridge.ts:30-35`, `:111`). Do not put diagnostics there.
- [x] **LSP is Pi-only and the two constructions are mutually exclusive** — both sit
  inside `provider === 'pi'` (`SessionManager.ts:8899`) and the native fallback runs
  only when `services.size === 0` (`:8964`). A Claude-backend session has no
  `LspService` at all. Say so in scope; do not claim parity there.

## Global Constraints

- **A cache must not serve stale instructions.** Key it to the capability generation,
  which already changes when a layer's content changes (the integrity check above).
  Never key it to a timer or a turn counter, and never to `mtime` alone.
- **Do not move anything into the system prompt to "fix caching".** On the live path
  memory and instructions are *not* in the system prompt, so a system-prefix change
  would alter the dead legacy path and leave the real cost untouched. The saving here
  comes from not repeating the text, not from relocating it.
- **`buildVolatileContextParts` must still be called exactly once per turn** — it
  consumes the one-shot mode-change signal (`consumeModeChangeUserSignal`).
- **The ancestor walk must not escape the project root.** `ancestorsUpTo(from, root)`
  is bounded by design; reuse it rather than writing a loop, and never walk past
  `context.projectRoot` into a parent repository or the user's home.
- **Do not create a second post-edit injection.** If diagnostics and the existing
  linter feedback would both fire for one edit, they must arrive as one payload.
  Shipping two competing injections for the same tool call is worse than shipping
  neither.
- **Do not change today's duplicate-language behaviour.** `createPiLspPort` throws
  `lsp-language-ambiguous` when two servers claim a language
  (`SessionManager.ts:1822-1824`). Replacing that hard error with first-wins is a
  behaviour change with its own review — out of scope here.
- One commit per task. No `Co-Authored-By` trailers.
- Gates: `bun run typecheck:shared`; `cd packages/server-core && bun run typecheck`;
  `bun run typecheck:electron`.
- **Never pass `-r` to `rg`** — it parses as `--replace` and silently rewrites every
  match. Three agents have lost time to this.

## File Structure

| File | Responsibility |
| --- | --- |
| Modify `packages/shared/src/agent/base-agent.ts:489-527` | Cache the pinned capability context per generation. |
| Modify `packages/shared/src/capabilities/native-sources.ts:692-759` | Ancestor walk for instruction files. |
| Modify `packages/shared/src/agent/core/prompt-builder.ts` | Delete the dead trio. |
| Modify `packages/shared/src/prompts/system.ts:228-284` | Delete the dead descendant walk. |
| Modify `packages/server-core/src/sessions/SessionManager.ts` | Pass the LSP sink; route diagnostics into the edit-feedback payload. |
| Modify `packages/server-core/src/pi-harness/lsp-port.ts` | Implement the port method. |

---

### Task 1: Build the pinned context once per generation, not once per turn

**Files:**
- Modify: `packages/shared/src/agent/base-agent.ts:489-527`
- Test: `packages/shared/src/agent/__tests__/base-agent.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

```ts
  it('reads each instruction layer once across turns of one generation', async () => {
    const reads: string[] = [];
    const agent = fakeAgentWithLayers({ onReadText: key => reads.push(key) });
    await collect(agent.chat('one'));
    await collect(agent.chat('two'));
    await collect(agent.chat('three'));
    // One read per layer for the whole generation, not one per turn.
    expect(reads.filter(k => k === 'AGENTS.md')).toHaveLength(1);
  });

  it('still sends the same text on every turn', async () => {
    // The saving is in the READ, not in what the model sees: dropping the block
    // from later turns would change behaviour, not just cost.
    const agent = fakeAgentWithLayers({});
    const first = await collect(agent.chat('one'));
    const second = await collect(agent.chat('two'));
    expect(promptOf(second)).toContain(instructionBodyFixture);
    expect(promptOf(first)).toEqual(promptOf(second));
  });

  it('re-reads when the capability generation changes', async () => {
    const reads: string[] = [];
    const agent = fakeAgentWithLayers({ onReadText: key => reads.push(key) });
    await collect(agent.chat('one'));
    agent.setCapabilityTurnRuntime(runtimeWithGeneration('gen-2'));
    await collect(agent.chat('two'));
    expect(reads.filter(k => k === 'AGENTS.md')).toHaveLength(2);
  });

  it('re-reads after a memory write', async () => {
    // A `remember` call trips the snapshot integrity check, which forces a new
    // generation — so this must fall out of the generation key, not need its own
    // special case. If it does not, the key is wrong.
    const reads: string[] = [];
    const agent = fakeAgentWithLayers({ onReadText: key => reads.push(key) });
    await collect(agent.chat('one'));
    await agent.rememberSomething();
    await collect(agent.chat('two'));
    expect(reads.filter(k => k === 'MEMORY.md')).toHaveLength(2);
  });
```

The second test is the one that keeps this a cost fix rather than a behaviour change.
Read the real suite and use its harness names.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/agent/__tests__/base-agent.test.ts`
Expected: the first, third and fourth fail — every turn re-reads. The second passes
already and must keep passing.

- [ ] **Step 3: Write minimal implementation**

Memoise the composed block on the agent, keyed by the capability generation:

```ts
  /**
   * The composed instruction + memory block, cached per capability generation.
   *
   * Every layer body used to be re-read and re-sent on every turn: a fresh
   * `readFileSync` + `statSync` + sha256 per layer per turn, and the block is
   * uncapped on this path, so a 14 KB AGENTS.md was paid for in full every time.
   * The generation is the right key because a layer's content changing already
   * trips the snapshot integrity check and forces a new one — there is no second
   * invalidation signal to invent.
   */
  private pinnedCapabilityContextCache?: { generation: string; block: string };
```

Do **not** skip emitting the block on later turns. The model must see the same
context; only the disk read and the composition are saved.

- [ ] **Step 4: Measure and record**

Instrument or reason out the per-turn byte saving for this repo's own tree (root
`AGENTS.md` is 14 047 bytes) and put the number in the tracker. A cost fix with no
number recorded cannot be defended later.

- [ ] **Step 5-7: green, no regression, commit**

Run: `bun test packages/shared/src/agent packages/shared/src/capabilities`
```bash
git commit -m "perf(agent): compose the pinned capability context once per generation"
```

---

### Task 2: Find instruction files up the tree

**Files:**
- Modify: `packages/shared/src/capabilities/native-sources.ts:692-759`
- Test: the native-sources suite

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
  it('finds an instruction file in an ancestor directory up to the project root', async () => {
    // monorepo shape: root AGENTS.md, package cwd two levels down
    const tree = fixtureTree({ 'AGENTS.md': 'root rules', 'packages/web/src/.keep': '' });
    const layers = await instructionLayers({ projectRoot: tree.root, workingDirectory: `${tree.root}/packages/web/src` });
    expect(layers.map(l => l.key)).toContain('AGENTS.md');
  });

  it('prefers the nearest file and keeps both when both exist', async () => {
    const tree = fixtureTree({ 'AGENTS.md': 'root', 'packages/web/AGENTS.md': 'package' });
    const layers = await instructionLayers({ projectRoot: tree.root, workingDirectory: `${tree.root}/packages/web` });
    // Decide and pin the order: nearest-last means it wins when the model reads
    // top-to-bottom. State the choice in the commit body.
    expect(layers.map(l => l.body)).toEqual(['root', 'package']);
  });

  it('never walks above the project root', async () => {
    const tree = fixtureTree({ 'outside/AGENTS.md': 'must not load', 'repo/.keep': '' });
    const layers = await instructionLayers({ projectRoot: `${tree.root}/repo`, workingDirectory: `${tree.root}/repo` });
    expect(layers.map(l => l.body)).not.toContain('must not load');
  });
```

- [ ] **Step 2-3: red, then implement with `ancestorsUpTo`**

Reuse `ancestorsUpTo(from, root)` (`:609-621`) exactly as the skills branch does at
`:751-754`. Do not write a second walk, and do not reach for
`findAllProjectContextFiles` — Task 3 deletes it.

Keep the existing `workspaceRootPath` tier untouched; this adds the walk between it
and the working directory.

- [ ] **Step 4: Bound the result**

An ancestor walk can find one instruction file per level. Cap the number of layers and
say what the cap is — a deep tree with a file at every level must not silently
multiply the context.

**Correction, 2026-07-26 (planner error).** An earlier version of this step said to
reuse `MAX_CONTEXT_FILES` (`prompts/system.ts:23`). That is wrong: Task 3 **deletes**
that constant, because it belongs to the dead descendant walk and has no other user.
Define the ancestor walk's own bound next to the walk, with a comment saying what it
costs. If Task 3 has already landed when you reach this step, the constant is simply
gone — do not resurrect it.

- [ ] **Step 5-7: green, no regression, commit**

```bash
git commit -m "feat(capabilities): discover instruction files up to the project root"
```

---

### Task 3: Delete the dead code the audit pointed at

**Files:**
- Modify: `packages/shared/src/agent/core/prompt-builder.ts:48`, `:259-275`
- Modify: `packages/shared/src/prompts/system.ts:183-284`
- Modify: `packages/server-core/src/sessions/SessionManager.ts:11453`
- Test: whichever suites reference the removed symbols

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

The audit's own recommendation here was to *wire* `clearPinnedPreferences` into
`clearHistory`. The re-verify showed that would wire dead code: the trio has no
callers, and real pinning lives on the agents and is already cleared. So the honest
change is deletion.

- [ ] **Step 1: Prove they are unreferenced, then delete**

For each of `clearPinnedPreferences`, `formatPreferences`,
`PromptBuilder.pinnedPreferencesPrompt`, `findAllProjectContextFiles`,
`findProjectContextFile`: run a grep, paste the result in the commit body, then remove
it. If any turns out to have a caller, **stop and report** — the re-verify would be
wrong and the plan needs correcting rather than forcing.

- [ ] **Step 2: Remove the invalidator call**

`SessionManager.ts:11453` invalidates a cache nothing reads. Remove the call along with
the cache. If the invalidator is also used for something live, keep that use and say so.

- [ ] **Step 3-5: typecheck, full suite, commit**

Deleting exported symbols can break a re-export barrel; `bun run typecheck:all` is the
gate that proves otherwise.

```bash
git commit -m "refactor(prompts): delete the unreferenced preference and context-walk code"
```

---

### Task 4: LSP diagnostics reach the model through the existing channel

**Files:**
- Modify: `packages/server-core/src/sessions/SessionManager.ts:1813-1829`, `:8936-8975`, `:3951-3987`
- Modify: `packages/server-core/src/pi-harness/lsp-port.ts`
- Test: the lsp-service and edit-feedback suites

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
  it('passes an onDiagnostics sink into every LspService construction', () => {
    // Two constructions, mutually exclusive; both must be fed or the native
    // fallback session gets nothing.
    for (const construction of ['plugin', 'native'] as const) {
      expect(buildLspService(construction).options.onDiagnostics).toBeDefined();
    }
  });

  it('includes LSP diagnostics for the edited file in the post-edit payload', async () => {
    const payload = await runEditFeedbackFor('src/a.ts', {
      lspDiagnostics: [{ uri: 'file:///ws/src/a.ts', message: 'Type error', severity: 1 }],
      projectChecks: [],
    });
    expect(payload).toContain('Type error');
  });

  it('delivers ONE payload when both sources have something to say', async () => {
    // Two competing post-edit injections for one tool call is worse than one.
    const payloads = await capturePostEditInjections('src/a.ts', {
      lspDiagnostics: [{ uri: 'file:///ws/src/a.ts', message: 'Type error', severity: 1 }],
      projectChecks: ['eslint: unused var'],
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toContain('Type error');
    expect(payloads[0]).toContain('unused var');
  });

  it('says nothing when the edited file has no diagnostics', async () => {
    expect(await capturePostEditInjections('src/clean.ts', { lspDiagnostics: [], projectChecks: [] }))
      .toHaveLength(0);
  });
```

The third test is the load-bearing one and the reason this task exists at all rather
than a `tool_result` hook.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — no sink is passed and the payload has no LSP contribution.

- [ ] **Step 3: Write minimal implementation**

Implement `onDiagnostics` on the port (`createPiLspPort` currently returns only
`health` + `request`), pass the sink at both constructions, and have the
edit-feedback runner include the buffered diagnostics **for the touched URI only**.
Compose into the single existing payload — do not add a second injection point.

Respect the existing bounds: `MAX_DIAGNOSTIC_FILES` (`lsp-service.ts:34`) and
`MAX_DIAGNOSTICS_PER_FILE` (`:40`) already cap the buffer; do not read past them, and
bound what reaches the model separately if a file can legitimately have 1000
diagnostics.

- [ ] **Step 4: State the Pi-only scope**

Both constructions are inside `provider === 'pi'`. Say in the commit body that a
Claude-backend session gets no LSP diagnostics, and that this is scope rather than an
oversight.

- [ ] **Step 5-7: green, no regression, commit**

Run: `bun test packages/server-core/src packages/shared/src/agent`
```bash
git commit -m "feat(lsp): feed diagnostics into the existing post-edit channel"
```

---

## Final Verification

- [ ] `bun test packages/shared/src packages/server-core/src packages/pi-agent-server/src`
- [ ] `bun run typecheck:all`
- [ ] `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`; `git diff --check`
- [ ] `bun run electron:build`
- [ ] Diff review: the cached block is keyed to the generation and nothing else; the
  model still receives the same context every turn; the ancestor walk cannot escape
  the project root; exactly one post-edit injection exists per tool call; the
  `lsp-language-ambiguous` error is unchanged.
- [ ] Known-red before you start: `session-branch-rollback.isolated.ts` fails 3 tests
  and predates this work. Confirm it fails identically; do not chase it.

### Live verification

- [ ] In a monorepo-shaped tree, start a session in a subdirectory and confirm the root
  `AGENTS.md` is loaded. Today it is not.
- [ ] Send three turns and confirm from the logs that each instruction layer is read
  once, not three times — and that the third turn's prompt still contains the
  instruction text.
- [ ] Introduce a type error with an `Edit`, then confirm the model is told about it in
  its next turn and that it arrives as **one** payload alongside any linter output.
- [ ] Authorized connections: `pi-api-key` (`pi_compat`) and `nessy-cloud-agent`. The
  Claude and Codex runtimes are flag-off — do not create a connection or enter a
  credential. Isolated `NESSY_CONFIG_DIR`, dark theme before screenshots, clean up.

## Deliberately out of scope

- **First-registered-wins for duplicate file extensions.** `extensionToLanguage`'s keys
  are discarded at `format-adapters/claude.ts:865-867`, so there is no
  extension→server map to tie-break; building one is a prerequisite task, and the
  tie-break itself would replace today's hard `lsp-language-ambiguous` error. Two
  changes, both with their own review.
- **`restartOnCrash` / `maxRestarts`.** Absent repo-wide; LSP crash handling is
  terminal by design today (`lsp-service.ts:278`, `:382-387`). Restart policy is its
  own decision.
- **A per-server `diagnostics` flag.** Nothing parses one.
- **Pinning memory into the system prompt.** The re-verify showed memory is not in the
  system prompt on the live path, so this would only touch the dead legacy path.

## Tracker

| # | Task | Status | Gate that proves it | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Re-verify (planner, `4abb5677`; see audit §5c) | **done** | 10 anchors; 2 rows re-framed | audit §5c |
| 1 | Pinned context composed once per generation | **done `46ccf138`** | 4 tests; byte saving recorded | see §Task 1 evidence below |
| 2 | Ancestor walk for instruction files | **done `0e0db90f`** | 4 tests incl. the root escape and the cap | `bun test .../native-sources.test.ts` 24 pass / 0 fail; all 4 red first with zero project instruction records above the working directory |
| 3 | Delete the dead trio and dead walk | **done `b60581d5`** | greps pasted; `typecheck:all` clean | reference table in the commit body; `bun run typecheck:all` EXIT=0; `bun test packages/shared/src/prompts` 64 pass / 0 fail |
| 4 | Diagnostics into the post-edit channel | **done `22e04372`** | 8 tests, incl. exactly one payload | `bun test packages/server-core/src packages/shared/src/agent` 2212 pass / 3 skip / 0 fail; server-core `typecheck` EXIT=0 |
| — | Final Verification | **done** | full list above | see §Final Verification evidence below |
| — | Live verification | **partly done; rest `blocked`** | monorepo case ran on the production path; model-turn and LSP-payload checks blocked | see §Live verification below |

Status values: `not started` / `in progress` / `blocked: <why>` / `done <commit>`.

### Task 1 evidence — measured per-turn byte saving

Measured on this repository as a trusted project, through the real
`buildNativeCapabilityInventory`:

```
instruction  14047  AGENTS.md
instruction     11  CLAUDE.md
layers=2 file-bytes-read-per-turn=14058 composed-block-chars=14395
```

So **14 058 bytes** of duplicate file reads plus a SHA-256 per layer, and a
14 395-character recomposition, saved on every turn after the first of a
generation. The root `AGENTS.md` alone is 14 047 bytes and was re-read and
re-composed in full every turn. The block is still *emitted* every turn — the
model sees identical context; only the disk read and the composition are saved,
which is what keeps this a cost fix rather than a behaviour change.

### Final Verification evidence

```
bun test packages/shared/src packages/server-core/src packages/pi-agent-server/src
  5128 pass / 7 skip / 0 fail — 5135 tests across 496 files
bun run typecheck:all                     EXIT=0
bun run lint:i18n:parity                  i18n parity OK (1 locales, 1972 keys each)
bun run lint:i18n:sorted                  EXIT=0
git diff --check                          EXIT=0
bun run electron:build                    EXIT=0
```

Known-red, confirmed identical and untouched by this series (it lives in
`apps/electron`, which the series never modifies — note the plan's path was
wrong, it is `apps/electron/src/main/__tests__/session-branch-rollback.isolated.ts`):

```
bun test ./apps/electron/src/main/__tests__/session-branch-rollback.isolated.ts
  1 pass / 3 fail  (deletes newly created child session…, runs backend preflight…,
                    revalidates and inherits the parent project…)
```

Diff review of the assembled series (`46ccf138~1..HEAD`, code files only):

- The cached block is keyed to `runtime.view.generation` and nothing else; no
  timer, turn counter or `mtime` appears in `base-agent.ts`.
- The block is still emitted on every turn and
  `setCapabilityPermissionLayers` is still published on every turn, cache hit or
  miss.
- The ancestor walk stops at `context.projectRoot` via `ancestorsUpTo`, and every
  candidate still passes `insideRealRoot(projectRealRoot)` inside `fileRecord`,
  so a working directory outside the project root emits nothing.
- Exactly one post-edit injection: composition happens inside a single
  `formatDiagnostics` call and `pi-agent.ts` is untouched across the series, so
  no second injection point was added.
- `lsp-language-ambiguous` and `createPiLspPort` are untouched (`git diff` over
  the series matches neither).

### Live verification

**Ran — the monorepo case, through the production code path.** A real
monorepo-shaped tree (root `AGENTS.md`, session cwd at `packages/web`, its own
`AGENTS.md`, isolated `NESSY_CONFIG_DIR`) driven through the real
`buildNativeCapabilityInventory` (real disk reads + SHA-256) → real
`toAgentRuntime` → three composition turns across one generation and then a
generation change:

```
--- instruction records discovered (record order) ---
instruction project   <root>/AGENTS.md
instruction project   <root>/packages/web/AGENTS.md
--- promptLayers, in the order the model reads them ---
order=3 <root>/AGENTS.md
order=3 <root>/packages/web/AGENTS.md
--- three turns, one generation ---
readText calls total: 2
  reads of <root>/AGENTS.md: 1
  reads of <root>/packages/web/AGENTS.md: 1
turn 3 block still contains the ROOT instruction text: true
turn 3 block still contains the PACKAGE instruction text: true
all three turns identical: true
--- generation change ---
readText calls added by the new generation: 2
```

So the root contract two levels above the working directory is loaded (it was
not before), it is read once per generation rather than once per turn, the
nearest file lands last, and the third turn's block is byte-identical to the
first — the model still sees the same context. The probe was throwaway and is
not committed.

**blocked: no authorized credential-free path to a real Pi model turn.** The
three-turn log check and the post-edit payload check both need a live session.
The only authorized Pi-capable connection is the Nessy Gateway `pi_compat` card,
whose JWT is filled by `ensureNessyGatewayAuth()` behind an **Electron IPC
handler** (`apps/electron/src/main/handlers/nessy-auth.ts`) that the headless CLI
cannot reach; supplying the JWT any other way would mean handling a token in
plain text, which the executor may not do. `nessy-cloud-agent` is `authType:
'none'` but its `nestor-cloud-agent` backend is not a `BaseAgent` subclass, so it
exercises neither the pinned capability context nor the Pi-only edit-feedback
runner. A human with the app open can close both checks in one session.

**blocked, structurally: the LSP post-edit payload is not observable in a
shipped build today.** `resolvePiLspConfig` has **no producer in either host** —
neither `apps/electron/src/main/index.ts:677` nor `packages/server/src/index.ts:214`
supplies it — so the native-fallback `LspService` construction never runs in
production and is effectively an embedder/test seam. Only a plugin-supplied
`lspServers` entry starts a language server, and no LSP plugin is installed.
Both constructions are still fed, which is correct and is what the task pins,
but the shipped reach of LSP diagnostics is plugin-only until a host supplies
`resolvePiLspConfig` or an LSP plugin is installed. The project
linter/typechecker half of the same payload is unaffected and still ships
enabled-by-default.

### Findings the plan did not anticipate

1. **`resolvePiLspConfig` has no production producer** (above). This bounds what
   Task 4 can deliver today and belongs in the audit as its own row.
2. **The ancestor walk covers instruction files only; a monorepo root
   `MEMORY.md` is still missed.** Project memory is read at
   `join(workingDirectory, 'MEMORY.md')` and at `.nessy-agent/MEMORY.md`, both
   fixed directories — the probe's root `MEMORY.md` produced no memory record.
   Extending the walk to memory is a separate decision (memory is mutable and
   `remember` writes to one specific file, so "which one does a write target"
   has to be answered first).
3. **`memory-store.ts` ↔ `memory-cleanup.ts` is a real TDZ import cycle.**
   `memory-cleanup.ts:41` reads `AUTO_MEMORY_MARKER_REGEX_SOURCE` from
   `memory-store.ts:158` at module scope and throws
   `ReferenceError: Cannot access ... before initialization` whenever
   `memory-cleanup.ts` initializes first. The test runner's module ordering hides
   it; it surfaced immediately when the probe imported `native-sources.ts` as the
   graph root. Pre-existing and unrelated to this series.

Deviations from the plan as written, all recorded in the relevant commit bodies:

- **Task 3.** The three `prompts/__tests__/system.test.ts` cases that referenced
  the dead walk also covered `getProjectContextFilesPrompt`, which is live on the
  legacy route (`prompt-builder.ts:138`) and touches no deleted symbol. Only the
  dead-walk assertions and the invalidator calls were removed, not the whole
  tests. The `SessionManager.ts` invalidator call is at `:11457`, not `:11453`.
  The `prompt-builder.ts` dead trio was already gone before this series started.
- **Task 4.** `createPiLspPort`'s optional `onDiagnostics` subscription is
  deliberately still not implemented: nothing subscribes to it, its own doc
  comment sanctions a port without the member, and the mirror the runner reads is
  fed directly by the service sink. Implementing it would add an unconsumed
  fan-out one commit after deleting unreferenced code for the same reason. Also
  note the plan's file path `packages/server-core/src/pi-harness/lsp-port.ts`
  does not exist — the port type lives at
  `packages/shared/src/agent/pi-harness/lsp-port.ts`.
- **Task 4, found while wiring.** `buildEditFeedbackRunner` returned early on
  `checks.length === 0`, so a project with no linter/typechecker config would
  have discarded an LSP-only verdict. Detection now only decides whether to
  spawn.
- **`glob`** is now an unused dependency of `@nessy-agent/shared` (zero importers
  after Task 3). Left in place: dropping it moves the lockfile, which is its own
  risk trigger.
- **`packages/shared/AGENTS.md`** volatile-set line corrected per audit §5c.11,
  which ties that fix to P8 landing.

**Stop conditions.** Halt and report rather than working around:

- A cached block turns out to serve stale content in any test. Report rather than
  adding a second invalidation signal.
- Any symbol Task 3 would delete has a real caller.
- Diagnostics and linter feedback cannot be composed into one payload without
  restructuring the edit-feedback runner. That restructure is its own plan.
- The ancestor walk cannot be bounded without a new constant and a new policy.
