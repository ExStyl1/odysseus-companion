# R5, R17 — resource mentions the shipped backend cannot use, a skill variable that aborts the skill

The last two of the five reopened rows, both refuted `holds`. Shared shape:
**built, tested, and unreachable on Pi — or reachable and worse than the
documented failure.**

## 0. Method rules

1. `curl -s` — `mcp.md` (resources/mentions) and `skills.md`. Quote whole
   lines; `skills.md:309`'s subject is TWO variables in TWO sites, which is the
   whole of R17.
2. **Declared ≠ enforced, and enforced ≠ reachable on the shipped backend.**
   Reproduce both before fixing.
3. **NUL bytes** — always `grep -a` for absence claims.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.**
6. CDP may be on 9223 — do not kill or drive it; do not run
   `electron:build:servers`.

## 1. Task 1 — `${CLAUDE_PROJECT_DIR}` works, and never aborts a skill (R17)

**Commit:** `fix(skills): the project-dir variable is substituted in both documented sites`

`skills.md:307` documents the variable; `:309`: "Claude Code substitutes
`${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` in two places: the skill's
markdown content, and Bash rules in the `allowed-tools` frontmatter."

Verified first-hand: `SKILL_VARIABLE_SPELLINGS`
(`capabilities/runtime-skill-content.ts:126-129`) carries skillDirectory,
sessionId, effort — **no project dir**. And the failure is worse than the
document's own degrade path (`:323`: an unsupported variable "stays a literal …
so the command still prompts"): `assertStaticRestriction` (`:744-745`) expands
only the skill directory and then **throws** on any surviving `$VAR`, so a
documented-valid `allowed-tools: Bash(${CLAUDE_PROJECT_DIR}/.claude/hooks/helper.sh)`
**aborts the entire skill invocation**. A plugin skill's `${CLAUDE_PLUGIN_ROOT}`
in a restriction does the same, because the plugin-env pass runs on the body only.

- Add the project dir to the spellings table with both the Nessy and Claude
  names, matching the existing pairs.
- Thread the value in: `RuntimeSkillHostContext` (`:133`) carries sessionId and
  effort; add the project root and supply it from the producers. **The
  `SessionManager.ts` producer is LOCKED to a sibling** — if it needs an edit,
  land the rest and report the residual word for word; `base-agent.ts` is yours.
- The `${CLAUDE_PLUGIN_ROOT}` restriction case: make the plugin pass cover
  restrictions too, or — if that is genuinely wrong — make the throw a
  *documented degrade* instead. **Aborting the skill is the one outcome the
  document rules out**; whichever way you go, that must stop.
- Probe all four cases through the production entry point
  `materializeRuntimeSkillInvocation`: native body, native restriction, plugin
  body, plugin restriction.

**Gate:** the variable is substituted in both sites for native and plugin
skills; an unknown variable no longer aborts the invocation but degrades as the
page describes. **Mutation:** remove the project-dir spelling → the restriction
test goes red.

## 2. Task 2 — resource mentions reach the shipped backend (R5)

**Commit:** `fix(mcp): resource mentions resolve on the shipped backend`

The challenger refuted R5 on two hops, both verifiable:

1. **The consumer runs only on a non-Pi backend.** The only renderer caller of
   `fuzzyFileSearch` is `mention-menu.tsx:711`, guarded at `:674`/`:709` by
   `canUseCodexFuzzy`, whose sole producer is `FreeFormInput.tsx:1087` —
   `providerType === 'codex-runtime'`, itself behind an off-by-default build
   flag. On **Pi**, the shipped default, the RPC is never issued and the branch
   falls through to a filesystem-only search.
2. **A field dropped at one hop.** Even on `codex-runtime`, `:715` reads
   `response.files` only; `response.resources` is never touched — zero `resource`
   hits in `mention-menu.tsx` and `FreeFormInput.tsx`, and the only other
   consumer of the DTO field is a playground mock.

`mcp.md`'s resource-mention contract is therefore satisfied on no shipped path.

- Fix both hops: the mention path must resolve resources on Pi, and the
  response's `resources` must be read.
- **Do not simply delete the `canUseCodexFuzzy` gate** — find out what it
  protects (a backend that lacks the RPC would throw). The right shape is
  "resources resolve wherever the RPC exists", which may mean a capability
  check rather than a provider-type check.
- `SessionManager.ts` holds `fuzzyResourceMentionCandidates` and is **LOCKED to
  a sibling**. If the host hop needs an edit, land the renderer and shared
  halves and report the residual word for word.
- The playground is a design surface: if a mention row gains a resource variant,
  add the state there (per the repo's playground convention).

**Gate:** on Pi, typing `@` with an MCP server connected offers its resources
and selecting one attaches it before the turn is built; the filesystem path
still works; a backend without the RPC degrades without throwing.
**Mutation:** stop reading `response.resources` → the resource-offer test goes
red.

## 3. Task 3 — category strings

**Commit:** `docs(audit): what the mention and skill-variable fixes leave open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 chars.

### 3a. What this plan leaves

Five strings, each measured against the code as committed. The first two record
narrowings the R17 fix takes deliberately; the third and fourth are mention
surfaces the two tasks scoped out; the fifth records a producer left unfed
because its file was locked to a sibling for this run.

- documented, not implemented — plugins-reference.md scopes a plugin bundle's placeholders to skill and agent content, and skills.md:309 names only the skill and project directories for the allowed-tools site. A plugin skill naming its bundle root in a restriction degrades to a literal that matches nothing and prompts; the skill-directory variable is the documented grant: `CLAUDE_PLUGIN_ROOT`
- documented, not implemented — skills.md:267 says an unavailable model is not used and the session keeps its current one. A skill naming one still throws at grant application, so an unresolved variable in that field aborts the turn one hop later than it used to; only the two tool fields reach the documented literal degrade: `model`
- documented, not implemented — mcp.md:1150 calls resource paths fuzzy-searchable in the mention autocomplete. The mention trigger's character class stops at a colon, so typing a scheme closes the menu and a resource is reached by server, name or description rather than by typing its uri: `@server:protocol://resource/path`
- documented, not implemented — mcp.md:1116 offers resources from all connected MCP servers. The renderer caches one query's candidates and filters later keystrokes client-side exactly as it does for files, so deleting characters narrows against the cache instead of re-asking the host, and a server connecting mid-menu is not seen until the menu reopens: `resources/list`
- documented, not implemented — skills.md:307 defines the project root for every skill origin. The child-session skill producer in SessionManager passes no host context at all, so a preloaded subagent skill gets no project dir, no session id and no effort level; that file was locked to another agent this run and the base agent producer is the only one fed: `materializeRuntimeSkillInvocation`

## 4. Gate

Focused suites per changed file; capabilities/skills and renderer suites, plus
the shared aggregate, once on the final diff; `bun run typecheck:all` **exit 0
with zero `error TS`, stated explicitly**; `bun run lint`; i18n parity + sorted
if strings are added; `git diff --check`.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
Check no other `bun test` is running before recording a new failure.

## 5. Constraints

- You own `packages/shared/src/capabilities/**`,
  `packages/shared/src/agent/base-agent.ts`, `packages/shared/src/mcp/**` and
  `apps/electron/src/renderer/**`, plus their tests.
  **A sibling owns `pi-agent.ts`, `mode-manager.ts`, `pre-tool-use.ts`,
  `permission-dsl.ts`, `pi-harness/**`, `SessionManager.ts` and
  `runtime-agent-definition.ts`** — stay out; report residuals instead.
- One commit per task, subjects exactly as given. No `Co-Authored-By`. No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or `.orig`, never git.
- No `docs/superpowers/specs/` or checklist edits. No version bumps. Never
  write `~/.nessy/dp_auth_creds.json`, and never touch
  `~/.nessy-agent/skills/r17-*` or `~/.nessy-agent/mcp/elicit-server.mjs` —
  they are live CDP fixtures.
- Code, comments and commits in English.

## 6. Report

Commit shas; both defects reproduced (the four skill cases, the two mention
hops); what `canUseCodexFuzzy` protected and what replaced it; residuals word
for word; corrections to this plan; mutation probes with sides; the explicit
typecheck statement.
