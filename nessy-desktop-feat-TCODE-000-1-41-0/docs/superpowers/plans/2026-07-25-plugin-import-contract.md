> **CLOSED — do not execute.** Landed as `e0a87519`, `fba90192`, `2210acb0`,
> `34743b82`, `d858b620`, `1c8f3ba9`, `3e2ceff8`, `1efc0fea`. Retained for the
> end-of-series review; every checkbox below is finished work. Evidence lives in
> `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` §0, row P3,
> and three follow-ups it surfaced are in that file's `Known follow-ups`.

# Plugin Import Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude plugin either works or says why — no component installs "successfully" and then does nothing, and an imported security hook's documented `deny` actually blocks the tool call.

**Architecture:** Two independent halves of the same contract. The format adapter learns the manifest field names and default files Claude actually documents, and records a deferral for every surface it still cannot run, so nothing is dropped in silence. The live hook-output parser learns Claude's nested `permissionDecision`, its three-way exit-code semantics and its two-mode matcher — without letting a hook `allow` reopen the centralized deny floor.

**Tech Stack:** TypeScript, Bun test runner. Packages: `@nessy-agent/shared` (`src/plugins`, `src/automations`).

Sources: `docs/superpowers/specs/2026-07-25-claude-adapter-doc-gaps.md`,
`docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` (shortlist items
1 and 2). Every claim below was re-verified against current code and against the
official docs on 2026-07-25.

## Before you start: re-verify

Done on 2026-07-25 by the planning session; all three anchors held, and the doc
re-fetch produced four corrections already applied below. Re-run only if HEAD has
moved past `41df2c98`.

- [x] `format-adapters/claude.ts:180` still passes `input.lsp`; `lspServers`
  appears nowhere in the file.
- [x] `automations/hook-command.ts:78-110` is still the only live hook-output
  parser. `plugins/hooks-runtime.ts` has exactly two importers
  (`hooks-automation.ts:28`, `format-adapters.ts:10`) and both are
  `import type { PluginHookEventName }` — its executor still has no production
  caller.
- [x] `pluginMatcherMatches:236`, `pluginHookMatcher:751`, `pluginHookAction:766`.
- [x] Re-fetched `plugins-reference.md` and `hooks.md`. Corrections folded in:
  1. `themes` and `monitors` are accepted at **both** the top level and under
     `experimental.*` — "the top level still works, `claude plugin validate` warns,
     and a future release will require `experimental.*`". Task 2's table now checks
     both.
  2. The exact-match matcher character class is `[a-zA-Z0-9_\-\s,\|]` — **any**
     whitespace, not just a literal space. Task 6's regex corrected.
  3. Exit 2 "blocks regardless of JSON content"; any other non-zero is a
     non-blocking error where the action proceeds and Claude never sees stderr.
     Task 5 now matches that exactly instead of parsing stdout on a failed exit.
  4. A malformed LSP entry is **skipped** while the plugin's other servers still
     start ("Claude Code skips a server whose configuration is invalid, for example
     one missing `command` or `extensionToLanguage`"). Our per-entry diagnostic
     already matches that shape — do not turn it into a plugin-level failure.

  Confirmed unchanged: `lspServers` (`string|array|object`, default `./.lsp.json`),
  per-server `extensionToLanguage`, "a single `SKILL.md` file at the plugin root",
  `defaultEnabled` (boolean, defaults to `true`, outranked by a user's
  `enabledPlugins` entry), `workflows` as a manifest field replacing the default
  `workflows/`, `outputStyles` replacing `output-styles/`, and the documented hook
  event list — 34 names against the 13 we map, so the audit's figure stands.

## Global Constraints

- **The deny floor is not negotiable.** Hooks run *after* the centralized
  permission gate deliberately, so a hook `allow` or `updatedInput` cannot reopen
  a denied path (`pi-agent.ts:2983-2989`, and `updatedInput` is mandatorily
  re-gated at `:3008-3033`). Nothing in Task 5 may change that ordering.
- **Deny wins.** Claude documents precedence as `deny` > `defer` > `ask` >
  `allow`: "If any hook returns `deny`, the operation is blocked regardless of
  other hooks." A nested `deny` must never be overwritten by a top-level
  `continue: true` or `decision: 'allow'`.
- Do **not** add `'defer'` to the live `PreToolUseDecision` vocabulary in this
  plan. `defer` is a turn-suspending mechanism the audit scoped to its own later
  plan; accepting the word without the mechanism would silently drop the decision.
- **Do not revive `hooks-runtime.ts`.** It contains a second, unreachable hook
  executor whose `PluginHookOutputDecision` vocabulary does not match the live
  `PreToolUseDecision`. Fixing the dead path and believing the bug closed is the
  specific trap here.
- Task 4 (exit codes) and Task 5 (matcher) are **behaviour-loosening or
  behaviour-changing for existing users**. Each must preserve today's semantics for
  native Nessy automations and apply Claude's semantics only to imported Claude
  hooks. Read each task's warning before editing.
- Never widen trust or activation. A newly-recognized component must arrive
  through the existing capability/deferral types, not a new bypass.
- One commit per task. No `Co-Authored-By` trailers.
- Typecheck: `bun run typecheck:shared`.

## File Structure

| File | Responsibility |
| --- | --- |
| Modify `packages/shared/src/plugins/format-adapters/claude.ts` | Manifest field names, default files, deferral coverage, `defaultEnabled`. |
| Modify `packages/shared/src/plugins/__tests__/format-adapters.test.ts` | Adapter contract per fixture. |
| Modify `packages/shared/src/plugins/__tests__/fixtures/` | New bundle fixtures for the shapes we currently drop. |
| Modify `packages/shared/src/automations/hook-command.ts` | Nested `permissionDecision`, exit-code semantics. |
| Modify `packages/shared/src/automations/utils.ts` | Two-mode matcher. |
| Modify `packages/shared/src/plugins/hooks-automation.ts` | Keep native automations on today's semantics while imported hooks get Claude's. |

---

### Task 1: Read the documented LSP manifest field and its default file

**Files:**
- Modify: `packages/shared/src/plugins/format-adapters/claude.ts:102-106`, `:180`, `:751-800`
- Test: `packages/shared/src/plugins/__tests__/format-adapters.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeClaudeLspServers(rootDirectory: string, input: unknown, diagnostics: PluginDiagnostic[]): Promise<PluginCapability[]>` — note it becomes **async** and gains a first parameter. Task 2 does not depend on it.

Three separate defects in one function. The adapter reads `input.lsp`; Claude's
documented field is `lspServers`. The documented plugin-root default `.lsp.json` is
never read, and `normalizeClaudeLspServers` returns `[]` immediately when the
manifest field is absent — so a bundle shaped exactly like the official
`typescript-lsp` plugin yields no capability, **no diagnostic and no deferral**.
And the descriptor demands a `languages` array, while Claude's field is
`extensionToLanguage`.

- [ ] **Step 1: Write the failing test**

Add to `format-adapters.test.ts`, using that file's existing Claude-bundle fixture
helper:

```ts
  it('imports an LSP server from the documented lspServers manifest field', async () => {
    const bundle = claudeBundle('lsp-manifest', {
      manifest: {
        name: 'lsp-manifest',
        lspServers: { go: { command: 'gopls', args: ['serve'], extensionToLanguage: { '.go': 'go' } } },
      },
    });
    const result = await normalizeClaudePluginBundle(bundle);
    const lsp = result.capabilities.filter(c => c.kind === 'lsp');
    expect(lsp).toHaveLength(1);
    expect(lsp[0]!.lsp.command).toBe('gopls');
  });

  it('imports an LSP server from the documented .lsp.json plugin-root default', async () => {
    // The official typescript-lsp / pyright-lsp shape: root file, nothing in the
    // manifest. The server map is at the TOP LEVEL of .lsp.json — unlike
    // .mcp.json, it has no wrapper key.
    const bundle = claudeBundle('lsp-file', {
      manifest: { name: 'lsp-file' },
      files: { '.lsp.json': JSON.stringify({ go: { command: 'gopls', extensionToLanguage: { '.go': 'go' } } }) },
    });
    const result = await normalizeClaudePluginBundle(bundle);
    expect(result.capabilities.filter(c => c.kind === 'lsp')).toHaveLength(1);
  });

  it('accepts extensionToLanguage as the language source', async () => {
    const bundle = claudeBundle('lsp-ext', {
      manifest: { name: 'lsp-ext', lspServers: { go: { command: 'gopls', extensionToLanguage: { '.go': 'go', '.mod': 'gomod' } } } },
    });
    const result = await normalizeClaudePluginBundle(bundle);
    const lsp = result.capabilities.filter(c => c.kind === 'lsp')[0]!;
    expect([...lsp.lsp.languages].sort()).toEqual(['go', 'gomod']);
  });

  it('keeps the legacy lsp field working so nothing regresses', async () => {
    const bundle = claudeBundle('lsp-legacy', {
      manifest: { name: 'lsp-legacy', lsp: [{ id: 'go', command: 'gopls', languages: ['go'] }] },
    });
    const result = await normalizeClaudePluginBundle(bundle);
    expect(result.capabilities.filter(c => c.kind === 'lsp')).toHaveLength(1);
  });
```

Read the file's existing Claude fixture helper first and use its real name and
option shape — the two existing Claude LSP tests show it. Do not invent a helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts`
Expected: the first three fail — the manifest field is not read, the root file is
not read, and `extensionToLanguage` is not accepted. The legacy test passes.

- [ ] **Step 3: Write minimal implementation**

Add the default-file constant beside the other five:

```ts
const CLAUDE_DEFAULT_LSP_FILE = '.lsp.json';
```

Change the call site at `claude.ts:180`, accepting the documented name and keeping
ours as an alias:

```ts
    ...await normalizeClaudeLspServers(rootDirectory, input.lspServers ?? input.lsp, diagnostics),
```

Make the function async, read the default file, and accept both language sources:

```ts
async function normalizeClaudeLspServers(
  rootDirectory: string,
  input: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<PluginCapability[]> {
  let source = input;
  if (source === undefined) {
    // Documented plugin-root default. Unlike `.mcp.json`, the server map is at
    // the TOP LEVEL of this file — there is no wrapper key.
    const lspPath = join(rootDirectory, CLAUDE_DEFAULT_LSP_FILE);
    if (!existsSync(lspPath)) return [];
    try {
      source = JSON.parse(await readFile(lspPath, 'utf-8'));
    } catch {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_json_unreadable',
        'Claude .lsp.json could not be parsed.',
        CLAUDE_DEFAULT_LSP_FILE,
      ));
      return [];
    }
  }
  // …existing entry-walking body, unchanged except for the language read below…
```

and inside the per-entry loop replace the `languages` read:

```ts
      // Claude's documented field is `extensionToLanguage`; `languages` is our
      // own earlier spelling and stays accepted.
      const extensionToLanguage = isRecord(entry.extensionToLanguage)
        ? [...new Set(Object.values(entry.extensionToLanguage).filter((value): value is string => typeof value === 'string' && value.length > 0))]
        : undefined;
      const languages = readRequiredUniqueStringArray(entry.languages)
        ?? (extensionToLanguage?.length ? extensionToLanguage : undefined);
      if (!languages) {
        diagnostics.push(incompleteClaudeCapability('lsp', `lspServers.${lspId}`, 'Claude LSP server requires extensionToLanguage or languages.'));
        return;
      }
```

Confirm `pluginDiagnostic`, `existsSync`, `readFile` and `join` are already
imported in this file; add only what is missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts`
Expected: 0 fail, including the legacy test.

- [ ] **Step 5: Prove no adapter regression**

Run: `bun test packages/shared/src/plugins`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/plugins
git commit -m "fix(plugins): read Claude's documented lspServers field and .lsp.json"
```

---

### Task 2: Record a deferral for every surface we cannot run

**Files:**
- Modify: `packages/shared/src/plugins/format-adapters/claude.ts` (`addClaudeRetainedSurfaceDeferrals`, `CLAUDE_CUSTOM_PATH_FIELDS`)
- Test: `packages/shared/src/plugins/__tests__/format-adapters.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

Deferral today is **manifest-field driven only**, so a bundle carrying
`workflows/`, `output-styles/`, `themes/`, `monitors/monitors.json`, `bin/` or a
root `settings.json` with no matching manifest field produces no capability **and
no deferred record**. That breaks the invariant `PluginCompatibilityReport`
documents — nothing is silently dropped. `workflows` is additionally absent from
both manifest-field tables, and the docs moved themes and monitors under
`experimental.*`, which the retained list never inspects.

- [ ] **Step 1: Write the failing test**

```ts
  it('defers every file-backed surface it cannot run, with no silent drop', async () => {
    const bundle = claudeBundle('peripherals', {
      manifest: { name: 'peripherals' },
      files: {
        'workflows/build.js': 'export const meta = {}',
        'output-styles/terse.md': '# terse',
        'themes/dark.json': '{"name":"dark"}',
        'monitors/monitors.json': '[{"name":"log","command":"tail -F x"}]',
        'bin/tool': '#!/bin/sh\n',
        'settings.json': '{"agent":"reviewer"}',
      },
    });

    const result = await normalizeClaudePluginBundle(bundle);
    const kinds = result.compatibility.deferred.map(d => d.externalKind).sort();

    expect(kinds).toEqual(['bin', 'monitors', 'output-styles', 'settings', 'themes', 'workflows']);
    // Nothing may be dropped without a record: every deferral carries a reason.
    for (const entry of result.compatibility.deferred) {
      expect(entry.reasonCode).toMatch(/^plugin\.deferred\./);
    }
  });

  it('inspects the documented experimental.* manifest fields', async () => {
    const bundle = claudeBundle('experimental', {
      manifest: { name: 'experimental', experimental: { themes: './t', monitors: './m' } },
    });
    const result = await normalizeClaudePluginBundle(bundle);
    const kinds = result.compatibility.deferred.map(d => d.externalKind);
    expect(kinds).toContain('themes');
    expect(kinds).toContain('monitors');
  });
```

Read `addClaudeRetainedSurfaceDeferrals` and the deferral record type first, and
use the **real** `externalKind` spellings and `reasonCode` values the function
already emits for its existing surfaces — the exact strings above are the intent,
not necessarily the current vocabulary. Match the existing vocabulary and adjust
the assertion, rather than renaming what already ships.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts`
Expected: FAIL — the deferred list is empty for the file-backed bundle, and the
`experimental.*` fields are not seen.

- [ ] **Step 3: Write minimal implementation**

Extend `addClaudeRetainedSurfaceDeferrals` so it is driven by **both** the manifest
field and the default directory/file on disk. Add a table beside the existing
manifest-field list:

```ts
/**
 * Surfaces Claude documents that this runtime cannot execute yet. Each is
 * deferred from EITHER its manifest field OR its documented default path, because
 * a field-only check let a bundle that simply used the default layout disappear
 * with no capability and no record — the one thing
 * `PluginCompatibilityReport.deferred` exists to prevent.
 */
const CLAUDE_RETAINED_DEFAULT_PATHS: ReadonlyArray<{
  externalKind: string;
  path: string;
  manifestField?: string;
  experimentalField?: string;
}> = [
  { externalKind: 'workflows', path: 'workflows', manifestField: 'workflows' },
  { externalKind: 'output-styles', path: 'output-styles', manifestField: 'outputStyles' },
  // `themes` and `monitors` are accepted at BOTH the top level and under
  // `experimental.*`: the docs say the top level still works and `plugin validate`
  // only warns, so a bundle using either spelling must be recorded.
  { externalKind: 'themes', path: 'themes', manifestField: 'themes', experimentalField: 'themes' },
  { externalKind: 'monitors', path: 'monitors/monitors.json', manifestField: 'monitors', experimentalField: 'monitors' },
  { externalKind: 'bin', path: 'bin' },
  { externalKind: 'settings', path: 'settings.json', manifestField: 'settings' },
];
```

and inside the function, for each row, emit one deferral when the manifest field is
present, when the experimental field is present
(`isRecord(input.experimental) && input.experimental[row.experimentalField] !== undefined`),
or when `existsSync(join(rootDirectory, row.path))`. Emit at most one record per
`externalKind`. Reuse the function's existing deferral constructor and its
`plugin.deferred.*` reason-code naming; do not invent a second record shape.

`addClaudeRetainedSurfaceDeferrals` currently takes `(input, deferred)`. It needs
the bundle root, so change the signature to
`(rootDirectory: string, input: Record<string, unknown>, deferred: …)` and update
the single call site at `claude.ts:166`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts`
Expected: 0 fail.

- [ ] **Step 5: Prove no adapter regression**

Run: `bun test packages/shared/src/plugins`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/plugins
git commit -m "fix(plugins): defer Claude surfaces found by their default path"
```

---

### Task 3: Accept the documented single-skill and inline-config layouts

**Files:**
- Modify: `packages/shared/src/plugins/format-adapters/claude.ts` (`normalizeClaudeSkills`, `isClaudeCustomPathOverride`, `defaultEnabled`)
- Test: `packages/shared/src/plugins/__tests__/format-adapters.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

Three documented shapes we reject: a plugin that ships exactly one skill may place
`SKILL.md` at the bundle root; `hooks` and `mcpServers` accept an **inline object**
form, which `isClaudeCustomPathOverride` rejects because it only accepts strings,
arrays and records-of-strings, so the config vanishes with no deferral; and
`defaultEnabled: false` is not honored, so a plugin whose author marked it opt-in
imports as enabled.

- [ ] **Step 1: Write the failing test**

```ts
  it('detects the documented single-skill root SKILL.md layout', async () => {
    const bundle = claudeBundle('one-skill', {
      manifest: { name: 'one-skill' },
      files: { 'SKILL.md': '---\nname: review\ndescription: Review code\n---\n\nReview it.' },
    });
    const result = await normalizeClaudePluginBundle(bundle);
    const skills = result.capabilities.filter(c => c.kind === 'skill');
    expect(skills).toHaveLength(1);
    // The invocation name comes from frontmatter `name`, not the directory.
    expect(skills[0]!.skill.slug).toBe('review');
  });

  it('records a deferral for an inline hooks or mcpServers object instead of dropping it', async () => {
    const bundle = claudeBundle('inline', {
      manifest: {
        name: 'inline',
        hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo hi' }] }] },
      },
    });
    const result = await normalizeClaudePluginBundle(bundle);
    const hookish = [
      ...result.capabilities.filter(c => c.kind === 'hook'),
      ...result.compatibility.deferred.filter(d => d.externalKind.includes('hook')),
    ];
    expect(hookish.length).toBeGreaterThan(0);
  });

  it('honors defaultEnabled: false so an opt-in plugin does not import enabled', async () => {
    const bundle = claudeBundle('opt-in', { manifest: { name: 'opt-in', defaultEnabled: false } });
    const result = await normalizeClaudePluginBundle(bundle);
    expect(result.manifest.defaultEnabled).toBe(false);
  });
```

The third assertion needs a field on the normalized manifest to carry the value.
Read `NessyPluginManifest` in `packages/shared/src/plugins/types.ts` first: if it
already has a `defaultEnabled`, assert against it; if not, add it as an optional
boolean and assert that. Do **not** wire activation policy in this task — carrying
the value truthfully is the deliverable, and consuming it is its own change with
its own review.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts`
Expected: all three fail.

- [ ] **Step 3: Write minimal implementation**

In `normalizeClaudeSkills`, before the `skills/<slug>/SKILL.md` walk, check for a
root `SKILL.md` and, when present, emit one skill whose slug comes from its
frontmatter `name` (falling back to the manifest name). Reuse the existing
frontmatter parser the directory walk already uses — do not add a second parser.

In `isClaudeCustomPathOverride`, keep returning `false` for an object whose values
are objects (it is **not** a path override), but ensure the caller records a
deferral for that case instead of returning silently. The clean split is: the
predicate answers "is this a path override", and the caller's `else` branch emits
`plugin.deferred.claude_inline_config` for a present-but-not-path value.

For `defaultEnabled`, read `input.defaultEnabled` where the other metadata is read
(`claude.ts:183-199`) and carry it onto the normalized manifest.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts`
Expected: 0 fail.

- [ ] **Step 5: Prove no plugin regression**

Run: `bun test packages/shared/src/plugins packages/shared/src/capabilities`
Expected: 0 fail.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck:shared`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/plugins
git commit -m "fix(plugins): accept Claude's single-skill and inline-config layouts"
```

---

### Task 4: Read the nested permissionDecision, deny-wins

**Files:**
- Modify: `packages/shared/src/automations/hook-command.ts:78-110`
- Test: `packages/shared/src/automations/__tests__/hook-command.test.ts` (locate the real path first — Task 6 of the research listed the existing hook tests)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

`parseHookCommandOutput` **does** destructure `hookSpecificOutput` at
`hook-command.ts:84-87`, but only for `additionalContext`, `updatedInput` and
`updatedToolOutput` — it never reads the permission decision. So a hook returning
Claude's documented
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
produces **no decision at all** and the tool call proceeds.

- [ ] **Step 1: Write the failing test**

```ts
  it('blocks on the documented nested permissionDecision deny', () => {
    const decision = parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Secrets file is off limits',
      },
    }));
    expect(decision?.decision).toBe('deny');
    expect(decision?.reason).toContain('off limits');
  });

  it('maps nested allow and ask', () => {
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    }))?.decision).toBe('allow');
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    }))?.decision).toBe('ask');
  });

  it('lets deny win over a top-level allow, in both orders', () => {
    // Claude: "If any hook returns deny, the operation is blocked regardless of
    // other hooks." A single hook emitting both must not resolve to allow.
    expect(parseHookCommandOutput(JSON.stringify({
      continue: true,
      decision: 'allow',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    }))?.decision).toBe('deny');
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      decision: 'allow',
    }))?.decision).toBe('deny');
  });

  it('ignores an unknown nested decision rather than inventing one', () => {
    // `defer` is documented but its mechanism is a separate plan; accepting the
    // word without the mechanism would silently drop the decision. With no other
    // field present the whole result is undefined.
    expect(parseHookCommandOutput(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' },
    }))?.decision).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test <the hook-command test path>`
Expected: FAIL — every nested case yields `undefined`.

- [ ] **Step 3: Write minimal implementation**

Rank the candidates instead of assigning in source order, so precedence cannot
depend on JSON key order:

```ts
    // Claude's documented precedence is deny > ask > allow: "If any hook returns
    // deny, the operation is blocked regardless of other hooks." Rank rather than
    // overwrite, so a nested deny cannot be undone by a top-level allow.
    const candidates: Array<PreToolUseDecision['decision']> = [];
    if (parsed.continue === false) candidates.push('block');
    else if (parsed.continue === true) candidates.push('allow');
    if (['allow', 'ask', 'block', 'deny'].includes(String(parsed.decision))) {
      candidates.push(parsed.decision as PreToolUseDecision['decision']);
    }
    // `permissionDecision` lives inside `hookSpecificOutput`, never at the top
    // level. `defer` is deliberately NOT accepted: its suspend mechanism does not
    // exist yet, and accepting the word would drop the decision silently.
    const nested = hookSpecificOutput?.permissionDecision;
    if (nested === 'deny' || nested === 'allow' || nested === 'ask') candidates.push(nested);

    const RANK: Record<string, number> = { deny: 3, block: 3, ask: 2, allow: 1 };
    const winner = candidates.sort((a, b) => (RANK[String(b)] ?? 0) - (RANK[String(a)] ?? 0))[0];
    if (winner) decision.decision = winner;
```

and read the nested reason when the top-level one is absent:

```ts
    if (typeof parsed.reason === 'string') {
      decision.reason = redactHookOutput(parsed.reason);
    } else if (typeof hookSpecificOutput?.permissionDecisionReason === 'string') {
      decision.reason = redactHookOutput(hookSpecificOutput.permissionDecisionReason as string);
    }
```

Keep the existing `redactHookOutput` on every path — hook output is untrusted and
secret redaction is an invariant this repo already holds.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test <the hook-command test path>`
Expected: 0 fail.

- [ ] **Step 5: Prove the hook and permission paths still pass**

Run: `bun test packages/shared/src/automations packages/shared/src/plugins packages/shared/src/agent`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/automations
git commit -m "fix(hooks): honour the documented nested permissionDecision"
```

---

### Task 5: Claude's exit-code semantics, without loosening native automations

**Files:**
- Modify: `packages/shared/src/automations/hook-command.ts:112-124`
- Modify: `packages/shared/src/plugins/hooks-automation.ts` (`pluginHookAction`)
- Test: the hook-command test path from Task 4

**Interfaces:**
- Consumes: `parseHookCommandOutput` from Task 4.
- Produces: nothing later tasks depend on.

> **This task LOOSENS behaviour. Read before editing.** Today *any* non-zero exit
> blocks a PreToolUse call. Claude documents three-way semantics: `0` = parse
> stdout, `2` = blocking error with **stderr** fed back to the model, other
> non-zero = **non-blocking** error. Adopting that verbatim would stop a hook that
> exits `1` from blocking — which is a real reduction in enforcement for any
> native Nessy automation that relies on today's behaviour. The mitigation is
> mandatory: keep `HookCommandAction.blockOnNonZero` as the switch, have
> `pluginHookAction` set it explicitly so **imported Claude hooks** get Claude's
> semantics while **native automations keep block-on-any-non-zero**.

- [ ] **Step 1: Write the failing test**

```ts
  it('blocks on exit 2 and reports stderr, per the documented contract', () => {
    const decision = getHookCommandPreToolDecision(
      { type: 'command', command: 'x', blockOnNonZero: false },
      { success: false, exitCode: 2, stdout: '', stderr: 'policy violation', output: '', error: '' } as never,
    );
    expect(decision?.decision).toBe('block');
    expect(decision?.reason).toContain('policy violation');
  });

  it('does NOT block on other non-zero exits when Claude semantics are selected', () => {
    const decision = getHookCommandPreToolDecision(
      { type: 'command', command: 'x', blockOnNonZero: false },
      { success: false, exitCode: 1, stdout: '', stderr: 'transient', output: '', error: '' } as never,
    );
    expect(decision).toBeUndefined();
  });

  it('keeps native automations blocking on any non-zero exit', () => {
    const decision = getHookCommandPreToolDecision(
      { type: 'command', command: 'x' },
      { success: false, exitCode: 1, stdout: '', stderr: '', output: 'boom', error: '' } as never,
    );
    expect(decision?.decision).toBe('block');
  });
```

Match the real `HookCommandAction` and `HookCommandActionResult` shapes rather than
the `as never` placeholders — read `packages/shared/src/automations/types.ts:149-150`
and the result type, and construct them properly.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test <the hook-command test path>`
Expected: the exit-1 non-blocking case fails (it blocks today), and the exit-2 case
reports `output` rather than `stderr`.

- [ ] **Step 3: Write minimal implementation**

```ts
export function getHookCommandPreToolDecision(
  action: HookCommandAction,
  result: HookCommandActionResult,
): PreToolUseDecision | undefined {
  if (!result.success) {
    // `blockOnNonZero !== false` is the native-automation contract: ANY non-zero
    // exit blocks. Imported Claude hooks opt into Claude's three-way semantics by
    // setting it to false, where only exit 2 blocks and stderr is what the model
    // is told — other non-zero codes are non-blocking diagnostics.
    if (action.blockOnNonZero !== false) {
      return {
        decision: 'block',
        reason: result.output || result.error || `Hook command exited with code ${result.exitCode ?? 'unknown'}.`,
      };
    }
    // Exit 2 "blocks regardless of JSON content", so stdout is deliberately not
    // parsed here.
    if (result.exitCode === 2) {
      return {
        decision: 'block',
        reason: result.stderr || result.output || result.error || 'Hook command reported a blocking error.',
      };
    }
    // Any other non-zero is a non-blocking error: the action proceeds and the
    // model is not told. stdout is not parsed — only exit 0 carries a decision.
    return undefined;
  }

  return parseHookCommandOutput(result.stdout ?? '');
}
```

Note the shape change: the current guard is the single condition
`if (!result.success && action.blockOnNonZero !== false)`, and the exit-2 branch
has to sit inside a widened `if (!result.success)` block.

Nothing in production sets `blockOnNonZero` today — `rg -n blockOnNonZero packages/`
finds only the type (`automations/types.ts:150`), the schema
(`automations/schemas.ts:73`) and this one check — so the `false` path is currently
unreachable and adopting Claude's semantics behind it changes no shipped behavior
until `pluginHookAction` opts in below.

Then in `pluginHookAction` (`hooks-automation.ts:766`, the `type: 'command'` return
at `:780-795`), set `blockOnNonZero: false` with a comment naming why. It is the
only constructor of command actions for imported hooks — re-confirm that with
`rg -n "type: 'command'" packages/shared/src/plugins` before editing, because a
second path would make the semantics inconsistent per hook. The trust hash reads
the hook's own fields, not the derived action, so this adds no hash churn.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test <the hook-command test path>`
Expected: 0 fail.

- [ ] **Step 5: Prove no automation regression**

Run: `bun test packages/shared/src/automations packages/shared/src/plugins`
Expected: 0 fail. If a pre-existing test asserts that an imported plugin hook
blocks on exit 1, that test encodes the old contract — update it and say so in the
commit body.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/automations packages/shared/src/plugins
git commit -m "fix(hooks): apply Claude exit-code semantics to imported hooks only"
```

---

### Task 6: Two-mode matcher, scoped so stored automations do not change meaning

**Files:**
- Modify: `packages/shared/src/automations/utils.ts:151-162` (`matchesBasePredicate`)
- Modify: `packages/shared/src/automations/types.ts` (`AutomationMatcher`)
- Modify: `packages/shared/src/plugins/hooks-automation.ts:751` (`pluginHookMatcher`)
- Test: `packages/shared/src/automations/__tests__/` (the suite covering `matcherMatches`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

> **This task changes matching for existing users. Read before editing.**
> `matchesBasePredicate` is the canonical predicate for **all** automations, not
> just plugin hooks — `matcherMatches` and `matcherMatchesSdk` both route through
> it. Today every matcher is an unanchored regex, which over-fires (`"Bash"` also
> matches `BashOutput`) and under-fires (Claude's `"Edit, Write"` exact list
> matches neither). A user's stored native automation may depend on today's
> substring behaviour. **Scope the new modes to imported plugin hooks** unless you
> can show no stored automation relies on substring matching.

- [ ] **Step 1: Write the failing test**

```ts
  const claude = (matcher: string) => ({ id: 'm', matcher, matchMode: 'claude' as const, event: 'PreToolUse', actions: [] });
  const native = (matcher: string) => ({ id: 'm', matcher, event: 'PreToolUse', actions: [] });

  it('treats a plain alternation list as exact names, per the documented contract', () => {
    // "A matcher containing only letters, digits, _, -, spaces, `,` and `|` is
    // compared as an exact string, with alternatives separated by | or ,"
    expect(matcherMatches(claude('Write|Edit'), 'PreToolUse', { toolName: 'Write' })).toBe(true);
    expect(matcherMatches(claude('Write, Edit'), 'PreToolUse', { toolName: 'Edit' })).toBe(true);
    expect(matcherMatches(claude('Bash'), 'PreToolUse', { toolName: 'BashOutput' })).toBe(false);
  });

  it('treats `*` and an empty matcher as match-all', () => {
    expect(matcherMatches(claude('*'), 'PreToolUse', { toolName: 'Anything' })).toBe(true);
    expect(matcherMatches(claude(''), 'PreToolUse', { toolName: 'Anything' })).toBe(true);
  });

  it('still evaluates a matcher with regex characters as an unanchored regex', () => {
    expect(matcherMatches(claude('mcp__.*__write'), 'PreToolUse', { toolName: 'mcp__memory__write' })).toBe(true);
  });

  it('leaves native automation matching unchanged', () => {
    // A stored native matcher keeps today's substring semantics.
    expect(matcherMatches(native('Bash'), 'PreToolUse', { toolName: 'BashOutput' })).toBe(true);
  });
```

Read `AutomationMatcher` and the existing suite's fixture builder before writing
these — use its real required fields and the real payload key `getMatchValue`
reads for `PreToolUse`, rather than the shorthand above.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/automations packages/shared/src/plugins`
Expected: the first two plugin cases fail; the native case passes.

- [ ] **Step 3: Write minimal implementation**

Scope the new semantics by **data on the matcher**, not by call path. Every plugin
hook already routes through the canonical pipeline
(`pluginMatcherMatches` → `matcherMatchesSdk` → `matcherMatchesWithContext` →
`matchesBasePredicate`), and bypassing that pipeline would skip the condition
gating its own comment warns against. So add an opt-in field instead.

In `automations/types.ts`, on `AutomationMatcher`:

```ts
  /**
   * `'claude'` selects Claude's documented two-mode matcher, and is set only by
   * `pluginHookMatcher` for imported plugin hooks. Absent means today's
   * unanchored-regex behaviour, which every stored native automation was written
   * against — flipping that default would silently re-scope saved automations.
   */
  matchMode?: 'claude';
```

In `utils.ts`, inside `matchesBasePredicate`, replace the single regex branch:

```ts
  if (!matcher.matcher) return true; // No matcher means match all
  if (matcher.matchMode === 'claude') return matchesClaudeMatcher(matcher.matcher, matchValue);
  try {
    return new RegExp(matcher.matcher).test(matchValue);
  } catch {
    return false; // Invalid regex — skip
  }
```

with the helper beside it:

```ts
/**
 * "A matcher containing only letters, digits, `_`, `-`, spaces, `,` and `|` is
 * compared as an exact string, with alternatives separated by `|` or `,`… A
 * matcher containing any other character is evaluated as an unanchored regular
 * expression… A matcher of `*`, an empty string, or omitting the matcher entirely
 * matches every occurrence of the event."
 */
function matchesClaudeMatcher(matcher: string, matchValue: string): boolean {
  if (matcher === '*') return true;
  // Documented class: letters, digits, `_`, `-`, whitespace, `,`, `|`.
  if (/^[A-Za-z0-9_\-\s,|]+$/.test(matcher)) {
    return matcher.split(/[|,]/).map(part => part.trim()).filter(Boolean).includes(matchValue);
  }
  try {
    return new RegExp(matcher).test(matchValue);
  } catch {
    return false;
  }
}
```

Then set `matchMode: 'claude'` on the matcher `pluginHookMatcher`
(`hooks-automation.ts:751`) returns.

Check the trust hash is unaffected: `pluginHookExecutableHash`
(`hooks-automation.ts:554`) hashes the hook's raw `matcher` string, not the derived
`AutomationMatcher`, so this adds no hash churn and re-prompts no user for trust.
Confirm that before committing — if it did change, every installed plugin hook
would ask for trust again.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/automations packages/shared/src/plugins`
Expected: 0 fail.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck:shared`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/automations packages/shared/src/plugins
git commit -m "fix(hooks): match imported hooks by Claude's two-mode matcher"
```

---

## Final Verification

- [ ] `bun test packages/shared/src/plugins packages/shared/src/automations packages/shared/src/agent packages/shared/src/capabilities packages/shared/src/mcp packages/server-core/src packages/pi-agent-server/src`
- [ ] `bun run typecheck:shared`; `cd packages/server-core && bun run typecheck`; `cd packages/pi-agent-server && bun run typecheck`; `bun run typecheck:electron`
- [ ] `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`; `git diff --check`
- [ ] `bun run electron:build`
- [ ] Review the diff specifically for: a hook `allow` reaching a denied path, a
  native automation whose matching or blocking changed, and any newly recognized
  component arriving without a capability or a deferral.

### Live verification

- [ ] Install an official LSP plugin from the `openai/plugins` or Claude registry
  (`typescript-lsp` shape: root `.lsp.json`, nothing in the manifest). Confirm the
  plugin detail shows an LSP component rather than nothing.
- [ ] Install a plugin carrying `monitors/` or `output-styles/`. Confirm the detail
  shows a disabled component with a path-free reason, not an empty section.
- [ ] Install a Claude plugin whose hook denies a write, attempt the write in chat,
  and confirm the call is blocked with the hook's reason surfaced.
- [ ] Clean up: uninstall the QA plugins, delete the QA sessions, stop the process,
  leave `git status` clean.

**Ran 2026-07-25** against `bun run electron:dev` with `NESSY_CDP_PORT=9223`,
`NESSY_BUN=$(which bun)` and an isolated `NESSY_CONFIG_DIR` (the real
`~/.nessy-agent` was left untouched — verified no `qa-*` trace and an unchanged
`installed.json`). Three QA Claude bundles were installed through a local
directory-of-plugins registry (`marketplace.addRegistry` → `marketplace.install`),
because a raw local path is deliberately not renderer-installable. Dark theme was
forced before the screenshot.

- LSP: `qa-lsp` (root `.lsp.json`, nothing in the manifest) installed
  `ok:true state:"supported"` with capability `lsp:lsp.typescript`,
  `languages: ["typescript","typescriptreact"]` derived from
  `extensionToLanguage`, and `trust.required: true` intact. The plugin detail
  shows `Apps: typescript` / `Capabilities: lsp` instead of nothing. **Pass.**
- Peripherals: `qa-peripherals` (`monitors/monitors.json` + `output-styles/`
  present ONLY as default paths) installed `state:"partial"` with
  `[{output-style, plugin.deferred.claude_output_style}, {monitor,
  plugin.deferred.claude_monitor}]`. **Adapter/report: pass.** **UI: fail** — the
  plugin detail renders no disabled component and says "No issues detected"; the
  renderer does not read `compatibility.deferred` at all. Out of this plan's file
  scope (no renderer files listed); it belongs with the known Sources-UI
  divergence.
- Hook deny: `qa-deny` (PreToolUse `Write|Edit` hook emitting ONLY
  `hookSpecificOutput.permissionDecision: "deny"` + reason, exit 0) blocked the
  write in a real gateway turn in `allow-all` mode — `tool_start Write` →
  `tool_result "QA hook: writing files is off limits in this QA plugin test."`,
  the target file was never created, and the model reported the block. **Pass.**
- Cleanup: all three plugins uninstalled `ok:true`, registry removed
  (`listRegistries` → 0), QA session deleted, app stopped (CDP down), QA config
  dir removed, `git status` clean.

## Deliberately out of scope

- `defer` as a decision — its suspend mechanism is a separate audit item.
- The unmapped hook events beyond the 13 we bind. The research found 13 of ~34
  mapped; expanding the map is a separate change with its own event-by-event
  reachability question.
- Consuming `defaultEnabled` in activation policy. Task 3 carries the value
  truthfully; acting on it changes install behaviour and deserves its own review.
- Deleting the dead `hooks-runtime.ts` executor. Tempting while nearby, but it is
  a separate cleanup and mixing it in would obscure this plan's diff.

## Tracker

| # | Task | Status | Gate | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Re-verify the three anchors above | **done** | all three confirmed; 4 doc corrections applied | anchors held at `41df2c98`; corrections listed in the re-verify section |
| 1 | `lspServers` + `.lsp.json` + `extensionToLanguage` | done `e0a87519` | 5 tests pass, legacy `lsp` still works | RED `69 pass / 4 fail` (manifest field, root file, `extensionToLanguage`, malformed-entry skip); GREEN `73 pass / 0 fail`; `packages/shared/src/plugins` `427 pass / 1 skip / 0 fail` |
| 2 | Deferral for every unrunnable surface | done `fba90192` | 3 tests pass, no silent drop | RED `74 pass / 2 fail` (deferred list empty for the file-backed bundle; `experimental.*` unseen); GREEN `430 pass / 1 skip / 0 fail` across `plugins`. Pre-existing test updated: `qualifies claude uvx and bundle-relative stdio MCP commands` asserted `supported` for a bundle shipping `bin/` — now `partial` + one `bin` deferral per format |
| 3 | Root `SKILL.md`, inline config, `defaultEnabled` | done `2210acb0` (+ `3e2ceff8`) | 5 tests pass; typecheck clean | RED `77 pass / 3 fail`; GREEN `plugins` + `capabilities` `577 pass / 1 skip / 0 fail`; `typecheck:shared` no output. Review follow-up `3e2ceff8`: an empty `hooks: {}` / `mcpServers: []` is a no-op, not a deferred surface |
| 4 | Nested `permissionDecision`, deny-wins | done `34743b82` | 7 tests pass incl. both orders | New suite `automations/hook-command.test.ts`; RED `2 pass / 5 fail` (every nested case `undefined`; top-level allow beat nested deny); GREEN `7 pass / 0 fail`; `automations` + `plugins` + `agent` `2106 pass / 4 skip / 0 fail` |
| 5 | Exit-code semantics, scoped | done `d858b620` | 5 tests pass; native still blocks on exit 1 and 2 | RED `9 pass / 2 fail` (exit 2 did not block; stdout was parsed on a failed exit); GREEN `11 pass / 0 fail`; `automations` + `plugins` `710 pass / 1 skip / 0 fail`. No pre-existing test encoded the old contract — both non-zero-exit tests build their action literally, without `blockOnNonZero`, so they keep native semantics |
| 6 | Two-mode matcher, scoped | done `1c8f3ba9` | 5 matcher tests + 1 live-path test pass; native matching unchanged | RED `52 pass / 3 fail` in `conditions.test.ts` (plugin cases only; the native case passed throughout); GREEN `automations` + `plugins` + `capabilities` `860 pass / 1 skip / 0 fail`. **Plan gap:** `plugins/hooks-automation.ts` has no production caller — the live builder is `capabilities/runtime-automations.ts`, so both opt-ins are set there too and pinned by a new live-path test. Trust hash byte-identical (`59ec382137e14ce0…` for a fixed hook record at `91af9d2e` and at HEAD) |
| — | Final Verification | done | full list above | `bun test <7 paths>` `3483 pass / 4 skip / 0 fail` (357 files); `typecheck:shared`, `server-core`, `pi-agent-server`, `typecheck:electron` all exit 0; `lint:i18n:parity` `OK (1 locales, 1963 keys)`; `lint:i18n:sorted` exit 0; `git diff --check` exit 0; `bun run electron:build` `✓ built in 23.02s` + resources copied. Diff review: no hook `allow` reaches a denied path (`applyPreToolUseHookDecision` returns a centralized `block` before reading the hook decision, and `allow` returns `checkResult` unchanged); no native automation changed (both opt-ins are per-record on imported hooks, and the automations zod schema strips `matchMode`, so user config cannot set it); every newly recognized surface arrives as a capability or a deferral |

Status values: `not started` / `in progress` / `blocked: <why>` / `done <commit>`.

**Stop conditions.** Halt and report:

- Task 5 or 6 requires changing behaviour for native automations to pass. That
  means the scoping failed; report rather than accepting the regression.
- Any test shows a hook `allow` permitting a path the centralized gate denied.
- The re-verify step finds a cited anchor gone. Correct this file first.
