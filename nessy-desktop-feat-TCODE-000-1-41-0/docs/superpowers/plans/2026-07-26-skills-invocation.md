> **CLOSED — do not execute.** Landed as `c25619c5`, `841d158c`, `f2585066`,
> `38210606`, `22ecb9d5`, `94cb0f9c`, `ccad6e1c`. Five of six tasks shipped and the
> headline behaviour was **proved live**: the model invoked a skill without being
> told its name. **Task 6 hit its stop condition** — nothing resolves a
> `skill-resource:` handle — and moved to audit row R17. This plan also anchored
> Task 1 on the wrong parser; see the audit row. Retained for the end-of-series
> review; every checkbox below is finished or explicitly stopped work. Evidence in
> `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` §0, row P7.

# Skills: Frontmatter Leniency and Model Invocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A published skill stops being rejected for a missing field, stops being invisible until the user types its slug, and stops paying for every file it references on every invocation.

**Architecture:** Three stages that must land in order. Frontmatter first, because
the invocation controls have nothing to read until the parser keeps them: today
`parseSkillFile` returns `null` when `name` or `description` is absent, so the skill
vanishes whole, and six fields are the only ones kept. Then a bounded listing in the
**stable** context part plus a model-invocation path, reusing the marker path that
already exists rather than adding a tool. Then supporting resources go lazy, which is
what makes a large skill affordable.

**Tech Stack:** TypeScript, Bun test runner. Packages: `@nessy-agent/shared`
(`src/skills`, `src/capabilities`, `src/agent`), `@nessy-agent/core` (skill types).

Covers audit shortlist item 8 (`2026-07-25-nessy-claude-parity-audit.md` §0 row P7,
§1 rows `Skill auto-invocation` and `Skill file contract and disclosure`, plus the §2
`Lazy skill supporting resources` row). The audit calls this **the single largest
behavioural divergence**: a skill library pays off passively in Claude and is inert
here until the user remembers a slug.

## Before you start: re-verify

Done by the planning session on 2026-07-26 against HEAD `be83405f`. Re-run if HEAD
has moved past that.

- [x] `parseSkillFile` (`skills/storage.ts:78-100`) returns **`null`** when
  `parsed.data.name` or `parsed.data.description` is falsy (`:83-85`). The caller
  therefore drops the skill entirely — there is no diagnostic at this level.
- [x] The only frontmatter fields kept are `name`, `description`, `globs`,
  `alwaysAllow`, `icon`, `requiredSources` (`:92-99`). Every Claude control field —
  `allowed-tools`, `disable-model-invocation`, `user-invocable`, `model` — is
  discarded.
- [x] `PromptBuilder.buildStableContextParts()` (`agent/core/prompt-builder.ts:159`)
  is the seam for a listing. **It must be the stable part, not the volatile one:**
  Pi folds stable blocks into its cached system prefix and routes volatile blocks to
  the user tail, so a per-turn-changing listing in the volatile part would invalidate
  the cached prefix and all downstream history (`packages/shared/AGENTS.md`, #862).
- [x] `extractSkillInvocations` (`agent/base-agent.ts:1202-1280`) already resolves an
  explicit `[skill:slug]` reference against `runtime.view.skills` and materializes the
  pinned skill. That is the path a model-emitted marker should reuse.
- [x] `materializeSupportingResources`
  (`capabilities/runtime-skill-content.ts:245-270`) walks every reference in the body
  and **eagerly** `readRelativeText`s each one, inlining the content, bounded by
  `MAX_SUPPORTING_RESOURCES` and `MAX_SUPPORTING_RESOURCE_BYTES`. So a skill pays for
  all its references on every invocation.
- [x] `listCustomSlashCommands` (`slash-commands/custom-commands.ts:157`) is the
  registration surface, with `pluginPromptCommandId`/`Label` (`:223`, `:228`) as the
  existing pattern for a plugin-supplied command id.

## Global Constraints

- **The listing is a per-turn token cost on the cached prefix.** It must be bounded
  by a stated budget, and the budget must be a constant with a comment saying what it
  costs, not a magic number. A skill library of 200 entries must not silently add
  thousands of tokens to every request.
- **The listing goes in the stable part.** If it turns out to change per turn, the
  design is wrong — fix the design, do not move it to the volatile part.
- **`buildVolatileContextParts` must still be called exactly once per turn.** It
  consumes the one-shot mode-change signal (`consumeModeChangeUserSignal`). Do not
  invoke a builder twice to compute a hash; hash the produced string.
- **Making `name` optional must not let two skills collide.** A derived slug must be
  deterministic, and a collision must be reported, not silently resolved by
  last-write-wins.
- **`disable-model-invocation` must block the model path, not just hide the entry.**
  Omitting a skill from the listing is a hint; the invocation path itself must refuse
  it, or a model that guesses the slug bypasses the control.
- **Lazy resources must stay verified.** Whatever handle replaces the inlined body
  must still resolve through the materializer, with the same digest and byte bounds.
  A handle the model can turn into an arbitrary read is a path-traversal surface.
- One commit per task. No `Co-Authored-By` trailers.
- Gates: `bun run typecheck:shared`; `bun run typecheck:electron`;
  `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`.
- **Never pass `-r` to `rg`** — it parses as `--replace` and silently rewrites every
  match. Two executors have lost time to this.

## File Structure

| File | Responsibility |
| --- | --- |
| Modify `packages/shared/src/skills/storage.ts` | Frontmatter leniency, aliases, control fields, diagnostics. |
| Modify `packages/shared/src/skills/types.ts` (or wherever `SkillMetadata` lives) | The new optional fields. |
| Modify `packages/shared/src/capabilities/views.ts` | Carry the control fields onto `RuntimeSkillHandle`. |
| Modify `packages/shared/src/agent/core/prompt-builder.ts` | The bounded listing in the stable part. |
| Modify `packages/shared/src/agent/base-agent.ts` | The model-invocation path. |
| Modify `packages/shared/src/slash-commands/custom-commands.ts` | `/slug` registration. |
| Modify `packages/shared/src/capabilities/runtime-skill-content.ts` | Lazy supporting resources. |

---

### Task 1: A skill missing a field degrades instead of disappearing

**Files:**
- Modify: `packages/shared/src/skills/storage.ts:78-100`
- Test: the skills-storage suite (`rg -l parseSkillFile packages/shared/src --glob '*.test.ts'`)

**Interfaces:**
- Consumes: nothing.
- Produces: `SkillMetadata` gains `allowedTools?: string[]`, `disableModelInvocation?: boolean`, `userInvocable?: boolean`, `model?: string`. Tasks 3-5 read these exact names.

- [ ] **Step 1: Write the failing test**

```ts
  it('derives a name from the directory when frontmatter omits it', () => {
    const parsed = parseSkillFile('---\ndescription: Reviews code\n---\n\nBody.', { directoryName: 'code-reviewer' });
    expect(parsed?.metadata.name).toBe('code-reviewer');
  });

  it('derives a description from the first body line when frontmatter omits it', () => {
    const parsed = parseSkillFile('---\nname: review\n---\n\nReviews code for correctness.\n\nMore.', {});
    expect(parsed?.metadata.description).toBe('Reviews code for correctness.');
  });

  it('accepts a skill with no frontmatter at all', () => {
    const parsed = parseSkillFile('Just a body.', { directoryName: 'plain' });
    expect(parsed).not.toBeNull();
    expect(parsed?.metadata.name).toBe('plain');
  });

  it('keeps the documented control fields, including the hyphenated spellings', () => {
    const parsed = parseSkillFile([
      '---',
      'name: review',
      'description: d',
      'allowed-tools: [Read, Grep]',
      'disable-model-invocation: true',
      'user-invocable: false',
      '---',
      'Body.',
    ].join('\n'), {});
    expect(parsed?.metadata.allowedTools).toEqual(['Read', 'Grep']);
    expect(parsed?.metadata.disableModelInvocation).toBe(true);
    expect(parsed?.metadata.userInvocable).toBe(false);
  });

  it('still refuses a file with no name derivable from anything', () => {
    // Leniency is not "accept anything": with no frontmatter name and no directory
    // name there is nothing to invoke the skill by.
    expect(parseSkillFile('Body only.', {})).toBeNull();
  });
```

Read the existing suite first: `parseSkillFile` is currently a module-private
function taking one argument, so this task changes its signature. If the suite drives
it only through a public loader, drive that instead and adapt the assertions — do not
export a private function just to test it.

**Before writing the alias list, re-fetch the skill frontmatter contract**
(`https://code.claude.com/docs/en/skills.md` and the `agent-sdk/skills.md` page) and
copy the field names and their exact hyphenation. This plan names four; take whatever
the page actually documents. A guessed field name is the failure mode this whole
series exists to catch.

**Re-fetched 2026-07-26.** The four control fields this plan named are correct and
correctly hyphenated: `allowed-tools`, `disable-model-invocation`, `user-invocable`,
`model`. Corrections the docs forced:

- **`when_to_use` is spelled with an UNDERSCORE**, not a hyphen — the only such
  field in the reference table. It is appended to `description` in the listing.
- **`disallowed-tools` exists** and this plan did not name it. Captured alongside
  `allowed-tools`.
- The reference table also documents `argument-hint`, `arguments`, `effort`,
  `context`, `agent`, `background`, `hooks`, `paths`, `shell`. Out of scope here;
  note that Claude's activation-glob field is **`paths`**, while this repo's
  existing field is `globs`.
- `name` is documented **optional**, defaulting to the directory name, and in a
  personal/project skill it sets only the display label — the command still comes
  from the directory name. That is already how `native-sources.ts` derives
  `logicalName`.
- `description` is **"Recommended"**, not required, and falls back to **the first
  paragraph** of the body (this plan said "first non-empty body line"). Combined
  `description` + `when_to_use` is truncated at **1,536 characters** in Claude's own
  listing.
- Malformed frontmatter YAML **loads the body with empty metadata** rather than
  dropping the skill — leniency is the documented behaviour, not an extension.
- The invocation table confirms Task 4's third test:
  `disable-model-invocation: true` → user yes / model no; `user-invocable: false` →
  user no / model yes, "description always in context". The docs state it
  explicitly: "The `user-invocable` field only controls menu visibility, not Skill
  tool access. Use `disable-model-invocation: true` to block programmatic
  invocation."
- Tool lists accept "a space- or comma-separated string, or a YAML list".

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test <the skills suite>`
Expected: FAIL — the first three return `null`, and the control fields are dropped.

- [ ] **Step 3: Write minimal implementation**

Accept both the camelCase and the documented hyphenated spelling for every field.
Derivation order for `name`: frontmatter → directory name → refuse. For
`description`: frontmatter → the first non-empty body line, trimmed and bounded →
empty string is acceptable (a description is a hint, a name is an identity).

Emit a diagnostic where the caller can surface it rather than returning `null`
silently. If the caller has no diagnostic channel, note that in the commit body and
leave a `TODO(P7)`-free comment explaining where the channel should come from — do
not invent a global logger.

- [ ] **Step 4: Prove no collision**

Add a test that two skills deriving the same name from different directories are
reported rather than silently deduplicated. If the loader currently last-write-wins,
that is a defect this task must at least surface.

- [ ] **Step 5-7: green, no regression, commit**

Run: `bun test packages/shared/src/skills packages/shared/src/capabilities`
```bash
git commit -m "feat(skills): accept the documented lenient frontmatter and control fields"
```

---

### Task 2: The control fields reach the runtime view

**Files:**
- Modify: `packages/shared/src/capabilities/views.ts:115-206`
- Test: the capability-views suite

**Interfaces:**
- Consumes: Task 1's `SkillMetadata` fields.
- Produces: `RuntimeSkillHandle` carrying `disableModelInvocation`, `userInvocable`, `allowedTools`. Tasks 3-5 read them from the handle, never from disk.

Same class of defect P5 found in the MCP pool: the parser keeps a field and the
projection drops it. Check for **sibling projections** before declaring this done —
P5's plan named two and there were three.

- [ ] **Step 1: Write the failing test**

```ts
  it('carries the skill control fields onto the runtime handle', async () => {
    const view = await buildView(withSkill({ name: 'review', disableModelInvocation: true, userInvocable: false }));
    const handle = view.skills.find(s => s.logicalName === 'review')!;
    expect(handle.disableModelInvocation).toBe(true);
    expect(handle.userInvocable).toBe(false);
  });

  it('omits the fields when the skill does not set them', () => {
    // Absent, not false: `userInvocable` defaults to true and a stored `false` must
    // be distinguishable from "not stated".
    const handle = buildView(withSkill({ name: 'plain' })).skills[0]!;
    expect('disableModelInvocation' in handle).toBe(false);
  });
```

- [ ] **Step 2: Find the sibling projections**

`rg -n "skills.push|RuntimeSkillHandle" packages/shared/src` and confirm how many
places build a handle. Fix every one, and say how many you found in the commit body.

- [ ] **Step 3-6: red, implement, green, commit**

```bash
git commit -m "fix(skills): carry the control fields onto the runtime handle"
```

---

### Task 3: A bounded skill listing in the stable context

**Files:**
- Modify: `packages/shared/src/agent/core/prompt-builder.ts:159`
- Test: the prompt-builder suite

**Interfaces:**
- Consumes: Task 2's handle fields.
- Produces: `buildSkillListingPart(): string | undefined` on `PromptBuilder`, included by `buildStableContextParts`.

- [ ] **Step 1: Write the failing test**

```ts
  it('lists invocable skills in the stable part, not the volatile one', () => {
    const builder = builderWith({ skills: [skill('review', 'Reviews code'), skill('deploy', 'Deploys')] });
    const stable = builder.buildStableContextParts().join('\n');
    expect(stable).toContain('review');
    expect(stable).toContain('Reviews code');
    expect(builder.buildVolatileContextParts().join('\n')).not.toContain('review');
  });

  it('omits a skill whose author disabled model invocation', () => {
    const builder = builderWith({ skills: [skill('hidden', 'd', { disableModelInvocation: true })] });
    expect(builder.buildStableContextParts().join('\n')).not.toContain('hidden');
  });

  it('bounds the listing and says it was truncated', () => {
    const builder = builderWith({ skills: Array.from({ length: 500 }, (_, i) => skill(`s${i}`, 'd')) });
    const part = builder.buildStableContextParts().join('\n');
    expect(part.length).toBeLessThanOrEqual(SKILL_LISTING_MAX_CHARS + 200);
    expect(part).toContain('more');
  });

  it('produces nothing when there are no skills', () => {
    // An empty section is still bytes on every request of every session.
    const builder = builderWith({ skills: [] });
    expect(builder.buildStableContextParts().join('\n')).not.toContain('Skills');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — no listing exists.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Every character here is paid on EVERY request of every session, inside Pi's
 * cached system prefix. The bound is deliberately small: a skill listing is a
 * discovery aid, not documentation — name plus one line each, and a truthful
 * "N more" when the budget runs out.
 */
export const SKILL_LISTING_MAX_CHARS = 4_000;
```

Sort deterministically (by name) so the string is byte-identical across turns —
an unstable order would invalidate the cached prefix every turn, which is the exact
failure this task must avoid.

- [ ] **Step 4: Prove the prefix is stable**

Add a test that building twice with the same skills yields the identical string, and
that adding a skill changes it. The first is the cache invariant; the second proves
the listing is not accidentally frozen.

- [ ] **Step 5-6: green, commit**

```bash
git commit -m "feat(skills): list invocable skills in the stable context part"
```

---

### Task 4: The model can invoke a skill

**Files:**
- Modify: `packages/shared/src/agent/base-agent.ts:1202-1280`
- Test: the base-agent skills suite

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: nothing.

The audit offers two designs: a `skill` tool, or a model-emitted marker on the
existing `extractSkillInvocations` path. **Take the marker.** The path, the
resolution against `runtime.view.skills` and the pinned-materialization already
exist; a tool would add a definition to every request and duplicate that logic.

- [ ] **Step 1: Write the failing test**

```ts
  it('resolves a skill the model asked for in its own output', async () => {
    const result = await agent.extractSkillInvocationsFromAssistant('I will use [skill:review] here.');
    expect(result.selected.map(s => s.reference)).toEqual(['review']);
  });

  it('refuses a skill whose author disabled model invocation', async () => {
    // The listing omits it, but a model that guesses the slug must still be refused
    // — otherwise the control is a hint, not a control.
    const result = await agent.extractSkillInvocationsFromAssistant('[skill:hidden]');
    expect(result.selected).toEqual([]);
    expect(result.refused).toContain('hidden');
  });

  it('still resolves a user-typed reference for a model-disabled skill', async () => {
    // `disable-model-invocation` restricts the model, not the human.
    const result = await agent.extractSkillInvocations('[skill:hidden]');
    expect(result.selected.map(s => s.reference)).toEqual(['hidden']);
  });
```

The third test is the one that pins the control's meaning. Read the documented
semantics of `disable-model-invocation` before implementing — if it turns out to
restrict both, change the test and say so.

- [ ] **Step 2-6: red, implement, green, commit**

Reuse the existing resolution; add only the model-side entry point and the refusal.
```bash
git commit -m "feat(skills): let the model invoke a listed skill"
```

---

### Task 5: `/slug` registration honouring `user-invocable`

**Files:**
- Modify: `packages/shared/src/slash-commands/custom-commands.ts:157-230`
- Test: the slash-commands suite

**Interfaces:**
- Consumes: Task 2's handle fields.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
  it('registers a slash command per invocable skill', () => {
    const commands = listCustomSlashCommands(rootsWithSkills(['review']));
    expect(commands.map(c => c.id)).toContain(skillCommandId('review'));
  });

  it('does not register one for a skill marked user-invocable: false', () => {
    const commands = listCustomSlashCommands(rootsWithSkills([{ name: 'internal', userInvocable: false }]));
    expect(commands.map(c => c.id)).not.toContain(skillCommandId('internal'));
  });

  it('does not collide with an existing custom command of the same name', () => {
    const commands = listCustomSlashCommands(rootsWith({ commands: ['review'], skills: ['review'] }));
    // Whatever the precedence is, it must be deterministic and only one wins.
    expect(commands.filter(c => c.name === 'review')).toHaveLength(1);
  });
```

Decide the precedence between an explicit custom command and a skill-derived one, and
state it in the commit body. Follow `pluginPromptCommandId`'s existing id pattern
rather than inventing a new namespace.

- [ ] **Step 2-6: red, implement, green, commit**

```bash
git commit -m "feat(skills): register a slash command for each user-invocable skill"
```

---

### Task 6: Supporting resources go lazy

**Files:**
- Modify: `packages/shared/src/capabilities/runtime-skill-content.ts:245-270`
- Test: the runtime-skill-content suite

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

Today every reference in a skill body is read and inlined on every invocation. Claude
loads supporting files only when they are used.

- [ ] **Step 1: Write the failing test**

```ts
  it('emits a handle for a supporting resource instead of inlining it', async () => {
    const snapshot = await materialize(skillWithReference('reference.md', 'x'.repeat(10_000)));
    expect(snapshot.body).not.toContain('x'.repeat(100));
    expect(snapshot.resources[0]).toMatchObject({ relativePath: 'reference.md' });
    expect(snapshot.resources[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resolves the handle through the materializer, with the same bounds', async () => {
    const snapshot = await materialize(skillWithReference('reference.md', 'body'));
    const read = await resolveSupportingResource(snapshot.resources[0]!);
    expect(read).toContain('body');
  });

  it('refuses a handle whose digest no longer matches', async () => {
    // A stale or tampered handle must not read: the digest is the verification.
    const snapshot = await materialize(skillWithReference('reference.md', 'body'));
    mutateOnDisk('reference.md', 'different');
    await expect(resolveSupportingResource(snapshot.resources[0]!)).rejects.toThrow();
  });

  it('refuses a handle pointing outside the skill directory', async () => {
    await expect(resolveSupportingResource({ relativePath: '../../etc/passwd', digest: 'x'.repeat(64) }))
      .rejects.toThrow();
  });
```

The last two tests are the load-bearing ones. Turning an inlined body into a
resolvable handle creates a read surface; it must keep the digest check and the
containment check the eager path had implicitly.

- [x] **Step 2: Establish how the model reads a handle** — **NO SUCH PATH EXISTS.
  Task 6 is BLOCKED by this plan's own stop condition and was not implemented.**

Searched exhaustively on 2026-07-26 at HEAD `94cb0f9c`:

- `skill-resource:` appears in exactly two production lines, both in
  `capabilities/runtime-skill-content.ts`: `:262` mints the handle, `:119`
  validates its format. **Nothing resolves one** — not the renderer, not
  server-core, not pi-agent-server.
- The canonical session-tool registry (`session-tools-core/src/tool-defs.ts`
  `SESSION_TOOL_DEFS`, 30+ tools) has **no resource-read tool** and no
  content-addressed read of any kind.
- `packages/session-mcp-server` registers only `ListTools` and `CallTool`. There
  is **no MCP `resources/read` surface** a handle could travel.
- `RPC_CHANNELS.skills` is `delete` / `openEditor` / `openFinder`. **There is no
  skill-content RPC.**
- `CapabilitySnapshotMaterializer.readRelativeText` is server-side and has exactly
  one caller — the eager path this task would replace. It is not reachable from the
  model.

The fallback of emitting the relative or absolute path instead of a handle is also
refused, for two reasons: the model is deliberately never given a skill's absolute
path (guarded today by `base-agent.test.ts:908`), and reading the live file would
bypass the pinned digest that this task calls the reason it is safe at all.

Unblocking this needs a read path first — a `skill_resource_read(handle)` session
tool, or an MCP resource surface — resolving through the materializer with the
digest and containment checks. That is its own change with its own review.

- [ ] **Step 3-6: red, implement, green, commit** — not reached.

```bash
git commit -m "feat(skills): emit verified handles for supporting resources"
```

---

## Final Verification

- [ ] `bun test packages/shared/src/skills packages/shared/src/capabilities packages/shared/src/agent packages/shared/src/slash-commands packages/server-core/src packages/pi-agent-server/src`
- [ ] `bun run typecheck:shared`; `cd packages/server-core && bun run typecheck`;
  `cd packages/pi-agent-server && bun run typecheck`; `bun run typecheck:electron`
- [ ] `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`; `git diff --check`
- [ ] `bun run electron:build`
- [ ] Diff review: the listing is in the stable part and byte-stable across two
  builds; `disable-model-invocation` refuses the model path and not just the listing;
  no supporting-resource handle can escape its skill directory or skip its digest;
  `buildVolatileContextParts` is still called exactly once per turn.
- [ ] Note the token cost you measured for a realistic listing in the tracker — this
  plan adds bytes to every request of every session and that number should be on the
  record.

### Live verification

- [ ] Install a skill with no `name` in its frontmatter and confirm it appears rather
  than vanishing.
- [ ] Ask the agent something a listed skill covers **without naming the skill**, and
  confirm it invokes it. This is the whole point of the plan; if it does not happen,
  report what the model saw rather than declaring success on the unit tests.
- [ ] Confirm `/slug` runs a skill and that a `user-invocable: false` skill has no
  slash command.
- [ ] Authorized connections: `pi-api-key` (`pi_compat`) and `nessy-cloud-agent`. The
  Claude and Codex runtimes are flag-off and out of scope — do not create a
  connection or enter a credential. `NESSY_BUN` exported for plugin installs; dark
  theme forced before screenshots; isolated `NESSY_CONFIG_DIR`; clean up.

## Deliberately out of scope

- **Output styles** and the `model` frontmatter field's effect on model selection.
  Task 1 captures `model`; acting on it is a routing change with its own review.
- **`allowed-tools` enforcement.** Task 1 captures it; restricting a skill's tool set
  belongs with the permission work, not here.
- **Skills-directory plugins** (`<name>@skills-dir`) — that is the B1 batch.

## Tracker

| # | Task | Status | Gate that proves it | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Re-verify (done by the planner at `be83405f`) | **done** | 6 anchors | in the re-verify section |
| 1 | Lenient frontmatter + control fields | **done `c25619c5`** | 5 tests + a collision test | `bun test packages/shared/src/skills packages/shared/src/capabilities` → **203 pass / 0 fail**. 10 new tests in `skills/__tests__/storage.test.ts` (derived name, derived description, no frontmatter, malformed YAML, hyphenated controls, camelCase controls, absent-not-false, diagnostic code, still-refuses-nameless, duplicate-name-both-kept). 2 pre-existing tests that asserted the old `null` contract were rewritten. `typecheck:shared` clean. |
| 2 | Control fields on the runtime handle | **done `841d158c`** | 2 tests; sibling projections counted | `bun test packages/shared/src/capabilities packages/shared/src/skills` → **207 pass / 0 fail**; pi harness R0 baseline → **23 pass / 0 fail**. **1** place builds a `RuntimeSkillHandle`; **4** places truncated the value en route (`native-sources.ts pinnedSkillMetadata`, `native-sources.ts skillRecords`, `resolver.ts` native branch, and the pinned `runtime-behavior.json` field-name fixture). `readSkillInvocationControls` is now the single reader of the field names. |
| 3 | Bounded listing in the stable part | **done `f2585066`** | 4 tests + byte-stability | `bun test packages/shared/src/agent` → **1448 pass / 3 skip / 0 fail**; 7 new tests incl. byte-identical across two builds AND across a reversed input order, plus "adding a skill changes the bytes". Measured cost below. |
| 4 | Model invocation | **done `38210606`**, hardened by **`22ecb9d5`** | 3 tests incl. the refusal | `bun test packages/shared/src/agent` → **1456 pass / 3 skip / 0 fail**; `bun test packages/server-core/src` → **739 pass / 0 fail** (turn-lifecycle risk trigger for the held `complete`). 8 tests: resolve-from-assistant-output, refusal, user-path-still-works, same-turn continuation with exactly one `complete` reaching the caller, no continuation for a refusal, once-per-turn dedup, and (from the diff review) no continuation after `source_activated` or a `terminalReason` complete. |
| 5 | `/slug` registration | **done `94cb0f9c`** | 3 tests; precedence stated | `bun test packages/server-core/src packages/shared/src/slash-commands` → **753 pass / 0 fail**. 6 unit tests on `selectSkillSlashCommands` + 1 SessionManager boundary test. **Precedence: an explicit command file wins the bare `/name`**; the skill keeps only its namespaced `custom:skill:<name>` id. |
| 6 | Lazy supporting resources | **blocked: no read path exists for a `skill-resource:` handle** | — | See Task 6 Step 2 above. `skill-resource:` is minted and format-validated in `runtime-skill-content.ts` and resolved by **nothing**: no session tool (`SESSION_TOOL_DEFS` has no resource read), no MCP `resources/read` (`session-mcp-server` registers only ListTools/CallTool), no skill-content RPC (`RPC_CHANNELS.skills` = delete/openEditor/openFinder). Not implemented, per this plan's stop condition. The eager path is unchanged. |
| — | Final Verification | **done** | full list above, incl. the measured token cost | `bun test` over the 6 listed paths → **2787 pass / 3 skip / 0 fail (2790 across 311 files)**. `typecheck:shared`, `server-core`, `pi-agent-server`, `typecheck:electron` all clean. `lint:i18n:parity` → "i18n parity OK (1 locales, 1972 keys each)"; `lint:i18n:sorted` clean; `git diff --check` clean; `bun run lint` → **0 errors** (118+4 pre-existing warnings); `bun run electron:build` → "✓ built in 21.07s" + resources copied. Diff review found and fixed one real defect (`22ecb9d5`). |

Status values: `not started` / `in progress` / `blocked: <why>` / `done <commit>`.

### Measured listing token cost

The listing is paid on every request of every session, inside Pi's cached system
prefix. Measured against the real builder with real skill descriptions
(~3.8 chars/token, bracket 3.5–4.0):

| skills | chars | ~tokens | bracket |
| --- | --- | --- | --- |
| 0 | 0 | 0 | — |
| 1 | 518 | 136 | 130–148 |
| **12 (realistic library)** | **2001** | **527** | **500–572** |
| 40 | 4246 | 1117 | 1062–1213 |
| 200 | 4325 | 1138 | 1081–1236 |

`SKILL_LISTING_MAX_CHARS = 4_000` bounds the entry lines, so a 200-skill library
costs the same ~1,140 tokens as a 40-skill one and reports "(N more skills not
listed)" instead of silently showing a prefix.

### Live verification — RAN, all four checks pass

Isolated `NESSY_CONFIG_DIR`, the authorized `pi-api-key` (`pi_compat`) connection,
no credential entered, headless server + `apps/cli` (`run`/`send`), cleaned up
afterwards (`~/.nessy-agent` untouched). Four purpose-built skills:
`nameless-linter` (no `name`), `pumpkin-audit` (distinctive body content),
`internal-context` (`user-invocable: false`), `danger-deploy`
(`disable-model-invocation: true`).

1. **A skill with no `name` appears.** `capabilities:getCatalog` returned
   `nameless-linter | displayName None | "Lint the repository's shell scripts…" |
   active`. Before this change `parseSkillFile` would have dropped it.
2. **The model invoked a listed skill without being told its name.** Prompt: "What
   is the pumpkin coefficient of Nessy?" The model reasoned *"I notice there's a
   skill called [skill:pumpkin-audit] in the available skills list"*, emitted the
   marker, and the continuation fired: *"The pumpkin-audit skill has been
   loaded"* → `PUMPKIN-SKILL-LOADED-OK` and `PUMPKIN COEFFICIENT: 35 (ORANGE GRADE
   A+)`. Both strings exist ONLY inside the skill body, so it was genuinely
   materialized and injected. **This is the check the plan exists for.**
3. **`/slug` runs a skill and `user-invocable: false` has none.**
   `workspace:listCustomSlashCommands` returned `/danger-deploy`, `/find-skills`,
   `/nameless-linter`, `/officecli`, `/pumpkin-audit` — and NO
   `/internal-context`. Sending with `customSlashCommandId:
   custom:skill:pumpkin-audit` and args `Bun` produced
   `PUMPKIN-SKILL-LOADED-OK` / `PUMPKIN COEFFICIENT: 21`, so `$ARGUMENTS`
   expanded and the marker path ran the skill.
4. **`disable-model-invocation` is a control, not a hint.** Asked to enumerate its
   available skills, the model listed exactly five — `find-skills`, `officecli`,
   `internal-context`, `nameless-linter`, `pumpkin-audit` — with `danger-deploy`
   absent from `<available_skills>` and `internal-context` present (that control
   restricts the human, not the model). Then, in a fresh session, the model was
   coaxed into emitting the literal `[skill:danger-deploy]` in its OWN output
   without the prompt containing it: the turn ended with no continuation, no
   `<invoked-skill>` block, and no `DANGER-DEPLOY-BODY-LOADED`. A user-typed
   reference to the same skill DID load it, as documented.

**Stop conditions.** Halt and report rather than working around:

- The listing cannot be made byte-stable across turns. That breaks Pi's cached
  prefix and costs more than the feature is worth.
- `disable-model-invocation` can only be implemented as a listing omission.
- Task 6 finds no existing path by which the model can resolve a handle.
- A documented frontmatter field name differs from what this plan guessed — correct
  the plan, then continue.
