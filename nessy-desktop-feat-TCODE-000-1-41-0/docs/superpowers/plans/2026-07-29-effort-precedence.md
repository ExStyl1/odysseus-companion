# S10 — Effort precedence: an override, not a clamp

From the phase-4 sweep (`2026-07-29-phase4-findings.md`, `model-config.md`).

`model-config.md` defines skill and subagent frontmatter `effort` as an
**override** of the session level. Our Pi subagent path implements it as a
**downward-only clamp**: a subagent can never think harder than its parent, and
inherits `off` outright when the parent's level is unset.

**The skill half of that same sentence is implemented correctly.** So the two
halves of one documented rule disagree inside our own codebase, and one of them
is already the reference implementation to align the other to.

---

## 0. Method rules

1. **Fetch the page yourself**: `curl -s https://code.claude.com/docs/en/model-config.md`.
   Never a summarising fetch tool — it invented field names twice in this series
   and both shipped.
2. **The quotation is the identifier, not the line number.** Report where you
   found each. Cite-drift has been checked in this neighbourhood recently and was
   clean, but check again rather than trusting that.
3. **Read around each quotation.** Follow pointers to other pages: `sub-agents.md`
   makes subagent thinking inheritance a pointer *into* this page, and an
   executor last week found the shape a plan needed on a page the plan had not
   named.
4. **Declared ≠ enforced.** Prove each site on **Pi**, the shipped default.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. **That list has
   been short three times running**, so reproduce anything you call pre-existing
   on a clean `git worktree` at your base commit. Never `git stash`.
7. **`rg` silently skips files containing a NUL byte and eight of ours have
   one** — see the tracker's method note 11a. If an absence claim touches
   `sessions/mirror/*`, `handlers/rpc/capabilities.ts` or
   `agent/memory/rule-matching.ts`, use `grep -a` or `rg --text`.

---

## 1. The four sites

The sweep named these; **verify each before building**, and report any that does
not reproduce.

1. **Frontmatter `effort` is a clamp, not an override**, in the subagent spawner.
   Establish what the page actually requires — override in both directions, or
   override upward only from a stated floor — and implement that.
2. **Inheritance goes stale after `set_thinking_level`.** A session whose level
   changed mid-conversation spawns children carrying the old value.
3. **A plugin-hook agent defaults to `?? 'off'`**, so a hook-spawned agent thinks
   at nothing regardless of the session.
4. **No per-model supported-level clamp.** A level a model does not support has
   to resolve to something; today nothing narrows it.

**The reference implementation is the skill path** (`base-agent.ts:2281` per the
sweep — confirm the line). Align the subagent path to it rather than inventing a
second reading, and if the two genuinely need different rules, say why in the
commit.

---

## 2. Tasks

### Task 1 — override, and one resolver

**Commit:** `fix(agents): subagent effort overrides the session level instead of clamping it`

Make the frontmatter/`effort`-argument path an override, and put the whole
precedence in **one** resolver both paths call. Two implementations of one
documented sentence is how they drifted apart in the first place; leaving two
after this unit means the next change breaks them apart again.

Cover the unset-parent case explicitly: inheriting `off` when the parent simply
has no level set is not the same as the parent choosing `off`.

**Gate:** a table over (parent level × child request), including
parent-unset and child-higher-than-parent, asserting the resolved level. The
child-higher row is the one that is wrong today.

---

### Task 2 — inheritance that is not stale, and the two remaining sites

**Commit:** `fix(agents): effort inheritance follows a mid-session level change`

- Read the level at spawn time, not at whatever earlier moment it is captured
  now. Find where the staleness enters and say so.
- The plugin-hook agent's `?? 'off'` — decide what it should default to and why.
  An agent that silently thinks at nothing is a quality regression nobody can
  see.
- The per-model supported-level clamp. **This one narrows**, unlike the rest of
  the unit, so keep it separate in the code and in your head: an override that
  raises a level and a clamp that lowers it to what the model supports are
  different rules, and collapsing them is how "override" quietly became "clamp"
  the first time.

**Gate:** for staleness, change the level mid-session and assert the *next* spawn
carries the new one — a test that spawns once proves nothing. For the model
clamp, a model that does not support a level must resolve to a level it does.

---

### Task 3 — the rest of the page

**Commit:** `docs(agents): the model-config rows we do not implement`

Category strings for what you leave. The sweep counted 18 findings on this page
across implemented, divergent, absent and inert; verify rather than copy.

Note that `availableModels` enforcement from this same page was closed as S6 —
do not re-open it, but do check that nothing in this unit's resolvers bypasses
the allowlist S6 installed.

**Write the strings unwrapped and unbolded**, then confirm they appear:
`python3 scripts/regenerate-deviation-register.py | grep effort`. The generator
has already lost rows to soft-wrapping and to `**emphasis**`.

---

## 3. Gate

Focused suites for every changed file, plus the agent, spawner and session
aggregates; `bun run typecheck:all`; `bun run lint`; `git diff --check`.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe:** restore the clamp and the Task 1 child-higher row must go
red.

---

## 4. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so — three
  executors have now done that correctly rather than shipping a known bug.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 5. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; which of the four sites reproduced and which did not; the Task 1 table;
whether the skill and subagent paths now share one resolver and, if not, why;
the category strings with proof they appear in the register; and the mutation
probe.

---

## 6. The rest of `model-config.md` — what this unit leaves

Verified against the page fetched with `curl` on 2026-07-29 and against the tree
at `b9aef019`, not copied from the sweep. Each string is one physical line and
is wrapped in backticks, because the register's category pattern reads up to the
next backtick or pipe: an unwrapped bullet with no terminator greedily swallows
the bullet after it, and two rows become one.

`availableModels` and `enforceAvailableModels` are NOT re-opened here. They
closed as S6, and nothing in this unit's resolvers touches model selection —
`clampThinkingLevelToModel` reads a model id only to pick an effort level and
cannot change which model runs, while the spawner still resolves the child model
through `resolveAgentModelId`, whose `isModelInManagedAllowlist` filter is
unchanged.

### The effort axis

- `documented, not implemented — model-config.md:315 gives Enterprise admins a per-role maximum effort level per model, so a level above the cap is not offered and a higher one named at launch runs at the cap instead. Our managed Pi policy has no effort key: availableModels, defaultMode and the permission-mode locks, nothing bounding reasoning depth. It needs a managed key plus a second narrowing rule`
- `documented, not implemented — model-config.md:506 puts an environment variable above every other effort source, including the frontmatter override this unit just built, so the documented precedence has a top tier we lack. There is no CLAUDE_CODE_EFFORT_LEVEL analogue: the session level resolves caller, trusted project default, workspace default, global default, with no environment layer above any`
- `documented, not implemented — model-config.md:499 and :501 set the level through an interactive slider command and a launch flag. Nessy sets it through the desktop thinking selector and the session RPC only. There is no slash command and no CLI flag, and the headless client has no effort surface of any kind, so a scripted run cannot choose one`
- `documented, not implemented — model-config.md:503 and :508 make effortLevel a settings key whose managed-tier value is a starting default that re-asserts in new sessions. Our equivalent, defaultThinkingLevel, exists app-globally and for workspace and project defaults, but the managed tier has no entry: an administrator can set a default permission mode and cannot set a default reasoning depth`
- `documented, not implemented — model-config.md:454 makes the default effort per model, high everywhere except one model defaulting to xhigh, and :456 holds that default across sessions until the user chooses explicitly. Our default is one constant for every model, medium, with no hold. The hold needs a persisted explicit-choice flag our stored level cannot distinguish from an inherited one`
- `documented, not implemented — model-config.md:458 makes max session-only while the four lower levels persist across sessions. Every Nessy level persists identically, so a session raised to max leaves max as the default for the next one`
- `documented, not implemented — model-config.md:462 makes ultracode an effort-menu entry that sends xhigh AND orchestrates dynamic workflows, for the current session only. Nessy has the workflow half under the same name but as a per-prompt keyword gated to human-typed input, appending a directive to one turn and never touching the effort level. The effort behaviour and the session scope do not match`
- `documented, not implemented — model-config.md:493 recognises ultrathink anywhere in a prompt as a request for deeper reasoning on that turn, adding an in-context instruction while leaving the level sent to the API unchanged. Nessy recognises no such keyword, so the word reaches the model as ordinary prompt text, which is what the same paragraph says happens to think and think hard`

### The thinking axis, and why our `off` conflates two rules

- `documented, not implemented — sub-agents.md:316 says a subagent inherits the main conversation extended-thinking configuration, on stays on and off stays off, with no per-subagent thinking setting, while the effort frontmatter overrides the session level. Two axes in Claude, one enum here: off is a Nessy level below low, so a subagent declaring an effort raises itself out of a parent that turned thinking off`
- `documented, not implemented — model-config.md:527 stores a global thinking toggle, :528 turns thinking off regardless of effort through an environment variable, :518 reverts two named models to a fixed thinking budget, and :532 controls whether full reasoning summaries are available when expanded. None of the four has a Nessy equivalent. Our token-budget fallback derives from the level rather than being settable`

### The per-model support table

- `documented, not implemented — model-config.md:444 says models absent from its per-model table do not support effort at all. Our clamp encodes only families we positively know to be narrower, because Nessy runs unlisted models that demonstrably reason: Haiku on a fixed token budget, and every discovered gateway model. Read literally it would resolve all of those to off and disable reasoning across the Pi provider set`
- `documented, not implemented — model-config.md:668 lets a deployment declare a pinned model capabilities with a companion environment variable, naming effort, xhigh_effort and max_effort among its values. That is the data-driven source our clamp table would otherwise read, and what a Bedrock ARN or Foundry deployment name needs. Without it the clamp cannot narrow a provider-specific id at all`

### Model-selection rows outside the effort axis

- `documented, not implemented — model-config.md:690 maps individual Anthropic model ids to provider-specific strings, applying to picker selections and, since a named version, to ids passed through the model flag and the family environment variables. Nessy has a same-named concept for custom-endpoint capability overrides inside the Pi runtime, a different thing, and no id mapping layer at all`
- `documented, not implemented — model-config.md:344 makes one alias a mode-sensitive hybrid, using the larger model in plan mode and switching to the smaller one for execution. Nessy resolves a model once per session and has no mode-triggered switch; our tier map is per subagent rather than per permission mode`
- `documented, not implemented — model-config.md:361 configures an ordered chain of fallback models tried when the primary is overloaded or fails non-retryably, and :390 adds classifier-driven fallback re-running a flagged request on a named other model. Neither exists. A single fallbackModel string is parsed, defaulted and trimmed in the stored config and read by nothing`
