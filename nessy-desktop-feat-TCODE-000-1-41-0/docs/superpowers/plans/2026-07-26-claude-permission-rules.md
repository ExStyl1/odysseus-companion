> **CLOSED 2026-07-26.** Executed and verified; evidence recorded in the parity audit §0 (R1).
> Kept until the end-of-series sweep. Do not execute again.

# Claude Permission Rule Strings (R1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile Claude's documented permission-rule strings (`Bash(git *)`, `Read(~/x)`, `Edit(//secrets/**)`, `mcp__srv__tool`, `WebFetch(domain:…)`, `Agent(Name)`, `Tool(param:value)`) into our permission DSL, with the gitignore path semantics the DSL cannot currently express, and wire the two real consumers: the imported-hook `if` filter and a managed-policy `claudeRules` list.

**Architecture:** A new pure module `claude-permission-rules.ts` parses one rule string into either a `PermissionDslRuleV1`-shaped rule or a structured warning (inert form). Path rules need semantics our DSL's `path` matcher (absolute-root containment, `permission-dsl.ts:373-374`) cannot express, so the DSL gains one additive matcher kind `pathGlob` (gitignore syntax, rule-type-dependent depth). Consumers compile strings at load time and evaluate through the existing `evaluatePermissionDslV1` path — no second evaluation engine.

**Tech Stack:** TypeScript, Bun test. No new dependencies — the glob subset needed (segment `*`, cross-segment `**`, `?`, character classes are NOT in the docs) is small enough to hand-roll and fuzz with tables.

**Contract source:** `code.claude.com/docs/en/permissions.md` (re-fetched 2026-07-26). The distilled contract is `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R1 — READ IT FIRST; it is longer than this plan and every sentence is implementable contract.

## Global Constraints

- Scope: Pi runtime + app. PowerShell rule matching is **deliberately deferred to B3** (win32 batch) — our Windows Bash tool runs Git Bash, and the PowerShell AST matcher has no consumer today. Record the deferral in the close-out report.
- Out of scope, recorded here so nobody "helpfully" adds them: project-settings rule ingestion and its trust dialog (we do not read `.claude/settings.json` permissions — that surface belongs to R25/enterprise), rule persistence via "don't ask again" (our whitelist owns that), `defaultMode`/admin-lock keys (R25), sandbox-boundary merge of `Edit(...)` rules (R15's floor work).
- One commit per task; no Co-Authored-By; no MR/tags; never reset/rebase/amend; do not touch `docs/superpowers/specs/`; pathspec-limited commits only.
- Implementation-First Verification Budget applies.
- The managed-policy loader must stay fail-closed: an unparseable `claudeRules` entry ABORTS startup (matching every other managed key), while the hook `if` consumer stays fail-open per its own documented contract. Same parser, opposite failure postures, each documented at its call site.

---

### Task 0: Pre-phase — fold in R22 close-out follow-ups

- [x] **Step 1:** Read the R22 executor's report (audit §0 entry "R22" once the planning session records it; if absent, read `docs/superpowers/plans/2026-07-26-hook-type-contract.md` close-out notes). Expected handoff: R22 Task 4 left `ifRule` imported+stored with a `plugin.hooks.if_deferred` info diagnostic and fail-open behaviour. This plan's Task 5 replaces that diagnostic with real evaluation — confirm the field name landed as `ifRule` and note any drift. If R22 named other follow-ups touching permission files, land them first as their own commits.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Confirm anchors:
  - `packages/shared/src/agent/pi-harness/permission-dsl.ts:21-36` `PermissionDslMatcherV1` (7 kinds), `:53-60` `CompiledMatcher`, `:100-103` `PATH_PARAMETERS`/`SAFE_PARAMETERS`, `:201-230` `parsePermissionDslV1` (strict, `exact(['version','rules'])`, ≤128 rules), the path containment test at `:373-374`, `ACTION_WEIGHT` deny>ask>allow at `:104`.
  - `packages/shared/src/agent/pi-harness/managed-policy.ts:10-71` `ManagedPiPolicyV1` (R21 ended at `autoMode`; R22 adds `allowedHttpHookUrls`/`httpHookAllowedEnvVars`). *(Re-verified 2026-07-26: interface now ends at :71 — doc comments grew; keys and semantics exactly as stated. `POLICY_KEYS` strict list at :120-135, `exact()` at :149-152.)*
  - `packages/server-core/src/pi-harness/managed-policy-loader.ts` — fail-closed loader.
  - The R22-landed `ifRule` on `PluginHookDescriptor` (`packages/shared/src/plugins/types.ts`) and its `plugin.hooks.if_deferred` diagnostic site in the hooks→automations projection.
  - `packages/shared/src/agent/permissions-config.ts` — how `CompiledPermissionDslV1` reaches the gate (5 callers per CodeGraph).
- [x] **Step 2:** Correct this plan in place if anything moved; say what changed.

**Task 1 re-verification notes (2026-07-26, executor).** All code anchors verified on HEAD (only the `ManagedPiPolicyV1` line range moved, fixed above). Re-fetching `permissions.md` and `hooks.md` (per AGENTS.md: Claude docs are a contract source) surfaced six contract corrections, applied to the tasks below:

1. **Word boundary includes end-of-string** (permissions.md § Bash): "requiring the prefix to be followed by a space **or end-of-string**. For example, `Bash(ls *)` matches `ls -la` but not `lsof`." So `Bash(git *)` DOES match bare `git`. The prefix table row `['git *', 'git', 'allow', 'no-match']` was wrong and is corrected to `'match'`.
2. **Exec wrappers are unapprovable by *prefix* rules only** (permissions.md § Wrappers): "Exec wrappers such as `watch`, `setsid`, `ionice`, and `flock` always prompt and can't be auto-approved by a prefix rule like `Bash(watch *)`... To approve a specific invocation, write an exact-match rule for the full command string." The allow-side `'no-match'` therefore applies only when the pattern contains a glob; a glob-free exact pattern matches the full command string literally.
3. **Allow rules cross known-safe env assignments** (permissions.md § Wrappers): "Claude Code also strips a leading assignment of certain known-safe environment variables, so `Bash(npm test *)` matches `NODE_ENV=test npm test`. An allow rule won't match past an assignment of any other variable." Task 2 gains the known-safe set (documented member: `NODE_ENV`; kept small and conservative).
4. **All Claude Bash rules compile to the `pattern` form** (Task 4 dispatch change). The `{ kind: 'bash', executable, args }` route for glob-free prefixes cannot cross env assignments on deny (`FOO=bar git push` would escape `deny Bash(git push)`), cannot strip wrappers, and tokenizes `FOO=bar` as the executable. Glob-free patterns go through `matchClaudeBashRule` as exact matches after the same stripping.
5. **The hook `if` filter is NOT allow-shaped for Bash** (hooks.md § if): each subcommand is checked and ANY match runs the hook (`npm test && git push` runs a `Bash(git *)` hook); leading assignments are stripped unconditionally; commands inside `$()` and backticks are checked; "patterns that specify more than the command name run the hook anyway on `$()`, backticks, or `$VAR`"; unparseable ⇒ run. And "On other events, a hook with `if` set never runs" — non-tool events are fail-closed for the whole hook. Task 5 evaluates `Bash(...)` if-rules through a dedicated if-mode matcher in `claude-bash-rule.ts`; non-Bash rules keep the one-rule-DSL allow-shaped path (hooks.md confirms allow depth for file tools: single-segment `Edit(src/**)` matches only `<cwd>/src`).
6. **Deny/ask depth float is narrower than a blanket `anyDepth`** (permissions.md § Read and Edit): "A relative pattern with a single directory segment, such as `src/**`, matches at different depths depending on the rule type... Every other pattern shape matches at the same depth in every rule type: `Edit(/src/**)` and `Edit(src/components/**)` match only at their anchored location." And "Bare filenames follow gitignore semantics and match at any depth" (every rule type). Task 3's DSL wiring bakes `anyDepth = action≠allow && anchor=relative && (single-segment directory pattern || slash-free pattern)`; literal bare filenames (no `/`, no wildcard) float in every rule type inside the helper. The pure-helper test table is unchanged and stays satisfied.

Also confirmed: WebFetch leading `*.` = any-depth subdomain excluding the bare domain (exactly our existing `matchesHost`); bare `*` matches everything; any other `*` position never crosses a dot — only the last two need adding. Tool-name glob deny/ask rules match the full tool name; the `EndConversation` exception covers glob rules too.

### Task 2: The Bash rule matcher — pure module, table-tested

**Files:**
- Create: `packages/shared/src/agent/pi-harness/claude-bash-rule.ts`
- Test: `packages/shared/src/agent/pi-harness/claude-bash-rule.test.ts`

**Interfaces:**
- Produces: `matchClaudeBashRule(pattern: string, command: string, opts: { ruleAction }): 'match' | 'no-match' | 'unparseable'`, `matchClaudeBashIfRule(pattern: string, command: string): 'match' | 'no-match' | 'unparseable'` (hook-`if` mode), and `splitCompoundCommand(command: string): string[] | null` (null = unparseable). All pure, no I/O.

Contract (permissions.md, distilled in the R1 verification entry; corrected per Task 1 notes):
- Prefix rules: `Bash(git *)` — glob may sit at any position; `:*` at pattern END is identical to trailing ` *` (elsewhere the colon is literal); a trailing space-`*` enforces a word boundary: the prefix must be followed by a space OR end-of-string (`Bash(ls *)` does NOT match `lsof` but DOES match bare `ls`; `Bash(ls*)` matches both).
- Compound commands split on `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines; EVERY subcommand must independently match for an allow to apply (deny/ask match if ANY subcommand matches).
- Wrapper stripping before matching: `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, and flagless `xargs` — but NOT `command -v` and NOT `nocorrect`. Exec wrappers `watch`, `setsid`, `ionice`, `flock`, and `find` with `-exec`/`-delete` can never be approved by a PREFIX (glob-containing) allow rule (return `'no-match'`); a glob-free exact-match allow rule matches the full command string and is unaffected.
- Leading env assignments (`FOO=bar cmd`): known-safe assignments (documented member: `NODE_ENV`) are stripped for every rule type; an allow rule refuses to cross any OTHER var (no match); a deny/ask rule crosses any (match still applies). Expose this as an option: `matchClaudeBashRule(pattern, command, { ruleAction: 'allow' | 'deny' | 'ask' })`.
- Hook-`if` mode (hooks.md, consumed by Task 5): `matchClaudeBashIfRule(pattern, command)` — ANY subcommand matching runs the hook; leading assignments stripped unconditionally; commands inside `$()`/backticks are checked as subcommands; a pattern specifying more than the command name returns `'match'` whenever the command contains `$(`, a backtick, or `$VAR`; unparseable ⇒ `'unparseable'` (caller fails open).
- Unparseable (unbalanced quotes, >10 000 chars): `'unparseable'`.

- [x] **Step 1: Write the failing table tests** — one `test.each`-style table per behaviour group. Minimum rows (copy these exactly; each is a documented example or its stated boundary):

```ts
const prefixCases: Array<[pattern: string, command: string, action: 'allow'|'deny'|'ask', want: string]> = [
  ['git *',        'git status',            'allow', 'match'],
  ['git *',        'git',                   'allow', 'match'],      // word boundary = space OR end-of-string (permissions.md)
  ['ls *',         'lsof',                  'allow', 'no-match'],   // space = word boundary
  ['ls*',          'lsof',                  'allow', 'match'],
  ['git commit:*', 'git commit -m x',       'allow', 'match'],      // :* == trailing ' *'
  ['npm run *',    'npm run build && rm -rf /', 'allow', 'no-match'], // every subcommand must match
  ['npm run *',    'npm run build && rm -rf /', 'deny',  'match'],    // any subcommand matches
  ['git *',        'timeout 5 git status',  'allow', 'match'],      // wrapper stripped
  ['git *',        'watch git status',      'allow', 'no-match'],   // exec wrapper never approvable by a prefix rule
  ['watch git status', 'watch git status',  'allow', 'match'],      // ...but an exact-match rule approves it
  ['git *',        'command -v git',        'allow', 'no-match'],   // command -v NOT stripped
  ['git *',        'FOO=bar git status',    'deny',  'match'],      // deny crosses any assignment
  ['git *',        'FOO=bar git status',    'allow', 'no-match'],   // allow refuses unknown var
  ['npm test *',   'NODE_ENV=test npm test','allow', 'match'],      // known-safe assignment stripped
  ['git *',        'git "status',           'allow', 'unparseable'],
];
```

- [x] **Step 2:** Run: `bun test packages/shared/src/agent/pi-harness/claude-bash-rule.test.ts` — FAIL (module absent).
- [x] **Step 3:** Implement. Structure: tokenize respecting single/double quotes and `$()`/backtick spans (an unclosed span ⇒ `'unparseable'`); `splitCompoundCommand` on the six operators + newlines at top nesting level; per subcommand: strip leading `VAR=value` tokens (record whether any were stripped), strip wrapper prefixes iteratively (`timeout` also consumes its duration argument; `stdbuf`/`nice` consume their `-` flags), detect exec wrappers and `find … -exec/-delete` ⇒ allow-side `'no-match'`; then glob-match pattern against the reconstructed subcommand string with `*` as the only metacharacter, honouring the space-word-boundary rule (a `*` preceded by a space requires the match boundary to fall at a token edge).
- [x] **Step 4:** Run — PASS. Add ≥6 adversarial rows of your own (nested `$(…)` with an operator inside, `|&`, a 10 001-char command ⇒ `'unparseable'`, `xargs -I{} rm {}` NOT stripped because flagged, `noglob git status`, CRLF newline split) — they must pass without code changes or you fix the code, not the table.
- [x] **Step 5:** Commit: `feat(permissions): Claude Bash rule matcher with documented compound/wrapper semantics`

### Task 3: The `pathGlob` matcher kind — gitignore semantics in the DSL

**Files:**
- Modify: `packages/shared/src/agent/pi-harness/permission-dsl.ts` (matcher union, compile, evaluate)
- Create: `packages/shared/src/agent/pi-harness/gitignore-glob.ts`
- Test: `packages/shared/src/agent/pi-harness/gitignore-glob.test.ts` + extend `permission-dsl` tests

**Interfaces:**
- Produces: `matchGitignoreGlob(pattern: string, relPath: string, opts: { anyDepth: boolean }): boolean` — pure. `anyDepth: true` is the deny/ask depth rule (pattern floats to any directory level); `false` anchors to the root (allow rule).
- Produces: matcher kind `{ kind: 'pathGlob', pattern: string, anchor: 'absolute' | 'home' | 'source' | 'relative', parameter?: PathParameter }` in `PermissionDslMatcherV1` + `CompiledMatcher`, evaluated against the same `PATH_PARAMETERS` extraction the `path` kind uses, after canonicalization but WITHOUT symlink resolution of the pattern side.

Contract: allow `Edit(src/**)` matches only `<cwd>/src/**`; deny/ask `Read(secrets/**)` matches a `secrets` directory at ANY depth; bare filename ≡ `**/name`; `//abs`, `~/home`, `/source-relative`, `rel` anchors; symlink asymmetry (allow: path AND resolved target must match; deny: EITHER matches — the evaluation site already receives the canonicalized value; thread the pre-canonicalization raw value through `PermissionDslRequestV1` as `rawInputPath?: string` so both can be tested).

- [x] **Step 1:** Failing table tests for `matchGitignoreGlob`:

```ts
const cases = [
  ['src/**',      'src/a.ts',            { anyDepth: false }, true],
  ['src/**',      'lib/src/a.ts',        { anyDepth: false }, false],
  ['secrets/**',  'a/b/secrets/key.pem', { anyDepth: true  }, true],
  ['.env',        'deep/nested/.env',    { anyDepth: true  }, true],   // bare filename ≡ **/.env
  ['.env',        '.env',                { anyDepth: false }, true],
  ['*.ts',        'a.ts',                { anyDepth: false }, true],
  ['*.ts',        'src/a.ts',            { anyDepth: false }, false],  // * is single-segment
  ['src/*/gen',   'src/x/gen',           { anyDepth: false }, true],
  ['src/*/gen',   'src/x/y/gen',         { anyDepth: false }, false],
];
```

- [x] **Step 2:** Run — FAIL. Implement segment-wise: split pattern and path on `/`; `**` spans ≥0 segments; `*`/`?` within a segment; `anyDepth` prefixes an implicit `**/`; a pattern with no `/` (bare filename) is `**/<name>`; trailing `/**` also matches the named directory itself.
- [x] **Step 3:** Run — PASS. Wire the DSL: add the kind to `PermissionDslMatcherV1` (`:21-36`), `compileMatcher`, and the evaluation switch, resolving the anchor to a base (absolute → none; home → `homedir()`; source → the rule's declared source root, threaded at compile time via a new optional `sourceRoot` on the layer input; relative → request `cwd`) and computing `relative(base, value)` before the glob test. Rule action decides `anyDepth`, refined per Task 1 note 6: `anyDepth = action ≠ allow && anchor = relative && (single-segment directory pattern || slash-free pattern)` — anchored patterns and multi-segment relative patterns match at the same depth in every rule type (permissions.md); literal bare filenames (no `/`, no wildcard) float in every rule type inside the helper. Pass the action into compile so the flag is baked, not re-decided per request. Extend `parsePermissionDslV1`'s matcher validation to accept the new kind (additive; `exact()` on its fields: `kind`, `pattern`, `anchor`, `parameter?`).
- [x] **Step 4:** DSL-level tests: an allow `pathGlob src/**` admits `<cwd>/src/a.ts` and refuses `<cwd>/lib/src/a.ts`; a deny `pathGlob secrets/**` matches `<cwd>/x/secrets/k` — through `evaluatePermissionDslV1`, not the helper. Plus: unknown fields on the new kind throw (loader stays strict).
- [x] **Step 5:** `bun test packages/shared/src/agent/pi-harness/` + `bun run typecheck:shared`. Commit: `feat(permissions): pathGlob matcher kind with gitignore depth semantics`

### Task 4: The rule-string parser

**Files:**
- Create: `packages/shared/src/agent/pi-harness/claude-permission-rules.ts`
- Test: `packages/shared/src/agent/pi-harness/claude-permission-rules.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ParsedClaudeRule {
  rule?: Omit<PermissionDslRuleV1, 'id'>;      // undefined when inert
  warning?: { code: string; message: string }; // inert forms, skipped globs, unknown tools
}
export function parseClaudeRuleString(
  raw: string,
  action: 'allow' | 'ask' | 'deny',
  opts?: { knownToolNames?: readonly string[] },
): ParsedClaudeRule
```

Dispatch table (each row = one branch + ≥2 tests, positive and boundary):

| Rule form | Produces | Notes |
| --- | --- | --- |
| `Bash(prefix)` | `{ kind: 'bash', pattern }` for EVERY prefix (glob-free included — see Task 1 note 4: the `executable/args` form cannot cross env assignments on deny or strip wrappers) — add `pattern?: string` to the `bash` matcher; delegates to `matchClaudeBashRule` with the rule action baked at compile | `Bash(command:…)` param form is IGNORED with warning `claude_rule.param_ignored` (docs: bypassable via compound) |
| `Read(p)` / `Edit(p)` | `{ kind: 'pathGlob', pattern, anchor }` with `parameter` unset (all path params) | `Edit` also produces the rule for Write/NotebookEdit semantics — our gate keys off path params, which already covers them; a `Read` deny must also match Edit targets: emit TWO rules for `Read` deny (read + write params) — implement by leaving `parameter` unset, which `PATH_PARAMETERS` already achieves, and pin with a test |
| `Write(p)` / `NotebookEdit(p)` / `Glob(p)` | inert + warning `claude_rule.unmatched_form` quoting the docs' startup-warning wording | accepted, never matched |
| `WebFetch(domain:d)` | `{ kind: 'host', host }` | case-insensitive, trailing dot stripped at parse; `example.*` between-dots wildcard kept as-is for the host matcher — verify the existing `host` matcher's wildcard semantics and extend ONLY if it cannot express "wildcard never crosses a dot" |
| `mcp__server` / `mcp__server__tool` | `{ kind: 'mcp', server, tool? }` | allow-side glob rules: server segment must be glob-free and the prefix literal, else warning `claude_rule.unanchored_allow_glob` + inert; deny/ask side accepts globs |
| `Agent(Name)` | `{ kind: 'agent', agent }` | |
| `ToolName` (bare) | `{ kind: 'tool', semanticId }` | bare-name deny removes the tool; `EndConversation` exception: a deny/ask on it is inert + warning while other tools remain — the CONSUMER enforces "while any other tool remains"; the parser just tags it |
| `Tool(param:value)` | `{ kind: 'parameter', name, equals }` — deny/ask only; on allow: warning + inert | one param per rule; `*` in value → `oneOf` is wrong, use a new `matches?: string` glob field on the parameter matcher; ignored params (`command`, `file_path`, `path`, `notebook_path`, `url`) → warning `claude_rule.param_ignored` |
| Unknown tool name in deny/ask (no `_`/`*` in name) | rule + warning `claude_rule.unknown_tool` | matches docs' startup warning |

- [x] **Step 1:** Write the failing tests — the table above, two per row minimum, plus: `Cd(pattern)` parses to `pathGlob` with `anchor` semantics but whole-path matching is R15/cd-surface territory — parse it, mark the rule with a warning `claude_rule.cd_not_enforced` and produce nothing (we have no `/cd` surface; document).
- [x] **Step 2:** Run — FAIL. Implement the dispatcher: `^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$` after trimming; specifier routing per the table; whitespace around `:` in param rules ignored.
- [x] **Step 3:** Run — PASS. `bun run typecheck:shared`.
- [x] **Step 4:** Commit: `feat(permissions): parse Claude permission-rule strings into the DSL`

### Task 5: Consumer 1 — the hook `if` filter evaluates for real

**Files:**
- Modify: the R22 `if_deferred` site (hooks→automations projection; locate by `plugin.hooks.if_deferred`)
- Test: extend the suite R22 added for it

**Semantics (hooks.md; corrected per Task 1 note 5):** tool events only — "On other events, a hook with `if` set never runs" (fail-closed for the whole hook on non-tool events); exactly one rule; **fail-open on evaluation trouble** — an unparseable rule or unparseable Bash command runs the hook. Evaluate as: parse `ifRule` with `parseClaudeRuleString(raw, 'allow')` (allow shape gives the documented anchored file-tool depth); inert/warning-only result ⇒ run the hook (fail-open); a parsed `Bash(...)` rule ⇒ `matchClaudeBashIfRule` (any-subcommand + `$()`/backtick contents + more-than-command-name fail-open — NOT allow-shaped); any other parsed rule ⇒ compile into a one-rule DSL and call `evaluatePermissionDslV1` (`'unsafe-shell'` diagnostic ⇒ run).

- [x] **Step 1:** Failing tests: `if: "Bash(git *)"` hook fires on `git status`, not on `npm test`; fires on `npm test && git push` (any-subcommand, hooks.md table); `if: "Bash(git *)"` on an unparseable command fires (fail-open); a hook with `if` on a non-tool event never runs (hooks.md; pin here); garbage `if: "???"` fires with the fail-open diagnostic.
- [x] **Step 2:** Implement, replacing the `if_deferred` diagnostic path. Keep an info diagnostic only for the garbage case (`plugin.hooks.if_unparseable_fail_open`).
- [x] **Step 3:** Focused suite + `bun run typecheck:shared`. Commit: `feat(hooks): evaluate the imported-hook if filter through the rule parser`

### Task 6: Consumer 2 — managed policy accepts `claudeRules`

**Files:**
- Modify: `packages/shared/src/agent/pi-harness/managed-policy.ts` (+`claudeRules?: { allow?: string[]; ask?: string[]; deny?: string[] }`)
- Modify: `packages/server-core/src/pi-harness/managed-policy-loader.ts`
- Test: `managed-policy.test.ts` + loader test

**Semantics:** compiled at load into DSL rules appended to `permissionDsl` (same evaluation, same receipts). FAIL-CLOSED: any entry that parses to a warning-only (inert) result or throws ⇒ the loader aborts startup exactly like every other malformed key — an admin's rule that silently does nothing is worse than a crash. Rule ids generated as `claude-<action>-<index>`; count against the existing 128-rule cap.

- [x] **Step 1:** Failing tests: a policy with `claudeRules.deny: ["Read(//etc/secrets/**)"]` compiles and a matching request evaluates `deny`; `claudeRules.allow: ["Write(x)"]` (inert form) ABORTS load; unknown keys inside `claudeRules` abort (`exact()`); combined DSL + claudeRules stays ≤128 or aborts.
- [x] **Step 2:** Implement; keep `exact()` at both levels. Commit: `feat(policy): managed claudeRules compiled through the Claude rule parser`

### Task 7: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, server-core suite, `bun run lint`.
- [x] **Step 2:** Mutation probes: (a) invert the word-boundary rule in the Bash matcher (`ls *` matching `lsof`) — the prefix table must fail; (b) make `anyDepth` always true — the allow-depth DSL test must fail; (c) make the loader tolerate an inert claudeRule — the abort test must fail. Restore all.
- [x] **Step 3:** Report: shas, gate numbers, deviations, follow-ups (expected: PowerShell→B3, Cd surface→R15 note, EndConversation consumer-side enforcement→R15/gate note, project-settings trust dialog→R25).

---

## Close-out evidence (2026-07-26, executor)

**Commits (one per task):** Task 0+1 `ed613e2b` (plan re-verify + doc-contract corrections); Task 2 `78d52c33`; Task 3 `631608c9`; Task 4 `a973cea7`; Task 5 `147dbfa2`; Task 6 `fe1c4e49`.

**Gates:** `typecheck:all` exit 0 (all 8 packages). `test:shared:all` 48 pass / 0 fail. Repo-wide `bun test` **7983 pass / 18 skip / 0 fail** across 741 files (213s) — includes the full shared and server-core suites. `bun run lint` exit 0 (4 pre-existing warnings in `apps/electron`, none in touched files). `git diff --check` clean. Note: `packages/shared`-cwd `bun test` shows 2 failures in `src/config/__tests__/paths-default-root.test.ts` — pre-existing cwd-dependence (the test spawns a subprocess importing a repo-root-relative path); passes from the repo root; unrelated to this plan.

**Mutation probes (all three killed, all restored, tree verified clean against HEAD):**
- (a) word-boundary inversion (`' *'` compiled without the boundary) → `ls * vs lsof as allow -> no-match` FAILED (44 pass / 1 fail).
- (b) `anyDepth` forced always-true → `pathGlob: allow anchors to cwd…` DSL test FAILED (9 pass / 1 fail).
- (c) loader tolerates an inert claudeRule (throw → skip) → BOTH abort tests FAILED (`managed Pi policy — claudeRules FAIL-CLOSED` and the server-core loader test; 30 pass / 2 fail).

**Deviations from the plan as written (all recorded in the Task 1 notes, applied before implementation):** the six doc-contract corrections (word boundary end-of-string; exec wrappers prefix-only; known-safe env vars; all-Bash-rules-via-pattern; if-filter any-subcommand semantics + non-tool-event fail-closed; depth float narrowed to single-segment/slash-free relative patterns). Two additional implementation choices beyond the documented text, both fail-safe and documented at the code site: (1) an allow rule containing a glob never matches a subcommand carrying command substitution (`$()`/backticks outside single quotes) — a prefix rule must not auto-approve embedded execution; (2) an unparseable Bash command under a `bashPattern` DSL rule keeps the DSL's existing unsafe-shell deny posture (Claude prompts instead; ours is the stricter direction). The `rawInputPath` request field is threaded and tested at the DSL level; the five gate call sites do not pass it yet (they pass canonicalized input, which degenerates to the pair-equal case) — wiring it is R15 floor-work territory.

**Follow-ups for the planner:**
- **PowerShell → B3**: `PowerShell(...)` specifier rules parse to the inert `claude_rule.powershell_deferred` warning (managed loader aborts on them, fail-closed); bare `PowerShell` tool-name rules enforce today. The AST matcher + alias canonicalization is B3 (win32 batch).
- **Cd surface → R15**: `Cd(pattern)` parses inert with `claude_rule.cd_not_enforced` — whole-path matching and the allowlist-mode switch need a `/cd` surface first.
- **EndConversation consumer-side enforcement → R15/gate**: the parser tags bare-name/glob deny/ask on `EndConversation` (`claude_rule.end_conversation_guarded`); "can't remove it while any other tool remains / ask never prompts for it" must be enforced where the manifest/gate knows the remaining tool set.
- **Project-settings rule ingestion + trust dialog → R25**: still out of scope, unchanged.
- **rawInputPath wiring → R15**: pass the pre-canonicalization path from the five `evaluatePermissionDslV1` call sites so the symlink-pair asymmetry bites on the real gate path.
