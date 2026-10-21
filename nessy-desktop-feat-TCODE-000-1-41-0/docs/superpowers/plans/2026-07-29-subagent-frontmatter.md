# R30c — the subagent frontmatter remainder

**Status:** ready for execution
**Parity row:** R30 (Ord 9), third and last slice. R30a closed; R30b is `/doctor`.
**Branch:** `fix/renderer`
**Base:** current HEAD

## Contract source

`curl -sL https://code.claude.com/docs/en/sub-agents.md` — 1246 lines at the time
of writing. **Fetch it yourself.** Line numbers in this plan are a convenience
and they rot: the R27c executor found every cite in that plan uniformly 7 lines
low because `hooks.md` had grown between the two fetches, with every quotation
still verbatim correct. **The quoted sentence is the identifier; re-derive the
line and report what you find.**

The frontmatter table is the "Configuration reference" section, around `:277`.
Quoted, per field this slice adds:

- **`skills`** — "Skills to preload into the subagent's context at startup. **The
  full skill content is injected, not only the description.** Subagents can still
  invoke unlisted project, user, and plugin skills through the Skill tool."
  `tools` adds: "To preload Skills into context, use the `skills` field rather
  than listing `Skill` here."
- **`mcpServers`** — "Each entry is either a server name referencing an
  already-configured server (e.g., `"slack"`) or an inline definition with the
  server name as key and a full MCP server config as value."
- **`hooks`** — "Lifecycle hooks scoped to this subagent."
- **`memory`** — "Persistent memory scope: `user`, `project`, or `local`. Enables
  cross-session learning."
- **`background`** — "Set to `true` to always run this subagent as a background
  task, even when Claude needs its result right away. When unset, Claude chooses,
  and as of v2.1.198 it runs subagents in the background by default."
- **`isolation`** — "Set to `worktree` to run the subagent in a temporary git
  worktree, giving it an isolated copy of the repository **branched by default
  from your default branch rather than the parent session's `HEAD`**. The
  worktree is automatically cleaned up if the subagent makes no changes."
- **`color`** — one of `red`, `blue`, `green`, `yellow`, `purple`, `orange`,
  `pink`, `cyan`.
- **`initialPrompt`** — "Auto-submitted as the first user turn **when this agent
  runs as the main session agent** (via `--agent` or the `agent` setting).
  Commands and skills are processed. Prepended to any user-provided prompt."

**Three fields say "Ignored for plugin subagents": `permissionMode`,
`mcpServers`, `hooks`.** That is a scoping rule with a security character — a
plugin must not hand its own subagent a broader permission mode, its own MCP
servers, or its own lifecycle hooks. Implement the exclusion explicitly and pin
it; do not let it fall out of some other check by accident.

## Verified state on HEAD

`AgentDefinition` (`packages/shared/src/agents/definitions.ts:23`) carries
`name`, `aliases`, `description`, `systemPrompt`, `toolset`, `tools`, `tier`,
`model`, `disallowedTools`, `maxTurns`, `permissionMode`, `effort`, plus internal
identity fields. **Missing: `skills`, `mcpServers`, `hooks`, `memory`,
`background`, `isolation`, `color`, `initialPrompt`.**

`ARRAY_FRONTMATTER_KEYS` at `:136` is `{tools, disallowedTools}` — any new array
field needs adding there or it arrives as a string.

## Scope, and what is deliberately not in it

Take the fields in this order, and **stop and report rather than expanding** if
one turns out to need a subsystem we do not have:

1. `color`, `memory`, `background`, `effort`-adjacent plumbing — parse, validate,
   carry. Cheap, and they establish the pattern.
2. `skills` — preloading full skill content into a child's context. R17's
   materialiser already produces exactly that content; this is a wiring job, not
   a new mechanism.
3. `isolation: worktree` — we ship `EnterWorktree`/`ExitWorktree` and R2 recorded
   a `bgIsolation` default, so check what exists before building. The documented
   detail most likely to be got wrong is the **base branch**: branched from the
   repository's default branch, *not* the parent session's `HEAD`.
4. `mcpServers` and `hooks` — both carry the plugin-exclusion rule. If either
   needs a per-subagent server pool or hook scope we do not have, say so, cost
   it, and record the category rather than half-building it.
5. `initialPrompt` — only meaningful when an agent runs as the **main session
   agent**. If we have no such surface, that is a `documented, not implemented`
   with a named reason, not something to invent.

## The deviation rule applies

Read it at the top of
`docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md`. Claude's docs
are the contract. The 2026-07-29 audit found **zero** of 159 recorded deviations
qualified for the impossibility exception and every one of the 24 challenged
fell, so "we can't" will be tested: produce a measurement or an SDK-type
citation, take the nearest existing equivalent rather than inventing a shape, and
record every outcome with one of the rule's three category strings verbatim.

## Tests that must exist

- Each new field round-trips from frontmatter through to the materialised
  definition, including the string-vs-native shape frontmatter delivers.
- A plugin subagent declaring `permissionMode`, `mcpServers` or `hooks` has all
  three **ignored** — one fixture, three assertions.
- `skills` injects full content, not the description — assert on a string only
  the body contains.
- An invalid `color`, an invalid `memory` scope and an invalid `isolation` value
  are each rejected with a message naming the field, not silently dropped.
- `background: true` forces background even where the caller wants the result
  inline.

## Gate

Affected packages during the loop: `agents`, `capabilities`, `pi-agent-server`'s
orchestrator, plus `typecheck:all`, `lint`, `git diff --check`. **`permissionMode`
and `hooks` touch permission decisions — a listed immediate risk trigger** — so
run the permission/mode and subagent suites once on the final diff. Agent
definition fixtures will move; update the pin, never loosen the assertion.

Tests from the REPO ROOT. A suite run from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

## Execution constraints

One commit per field or tight group; no `Co-Authored-By`; no push, MR or tag;
never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`;
leave `~/.nessy-agent/skills/r17-*` and `~/.nessy-agent/mcp/elicit-server.mjs`
alone. You may edit this plan file.

Other agents are working in managed-policy/config-storage and in
`scripts/build-server.ts` and the server package. Stay out of those. If
`typecheck:all` fails on files you did not touch, run it in a detached
`git worktree` at your own HEAD and say so.

Report any propagation of these gaps on other paths — do not fix it.

## Outcome (executed 2026-07-29)

Page re-fetched: still 1246 lines, every quotation verbatim. The section is
`#### Supported frontmatter fields` at `:271`, not "Configuration reference";
`:277` is the first table row, so the LINE cite was right and the SECTION NAME
was transcribed wrong. The page did not move.

| Field | Category | Commit |
| --- | --- | --- |
| `color` | `documented, implemented` | `b31d6421` |
| `memory` | `documented, not implemented — scope parsed, validated and carried; the per-agent memory DIRECTORY (`agent-memory/<name>/`, MEMORY.md injection, auto Read/Write/Edit) is a subsystem we do not have` | `b31d6421` |
| `background` | `documented, implemented` | `b31d6421` |
| `skills` | `documented, implemented` | `66a90b60` |
| `isolation` | `documented, implemented` | `0703ae07` |
| `mcpServers` | `documented, implemented` for the name-reference form; the inline-definition form is `documented, not implemented — the frontmatter parser is typed `Record<string, string>` and explicitly refuses nested structure` | `70f9dc94` |
| plugin exclusion (`permissionMode`, `mcpServers`, `hooks`) | `documented, implemented` | `70f9dc94` |
| `hooks` | `documented, not implemented — no per-subagent hook scope, and the value is a nested event map the flat frontmatter parser cannot represent` | — |
| `initialPrompt` | `documented, not implemented — no main-session-agent surface (`--agent` flag or `agent` setting) exists to run an agent definition as the main session` | — |

None of the three unimplemented items claims impossibility: each is a cost
against a mechanism we own, not a Pi SDK or host-runtime limit.
