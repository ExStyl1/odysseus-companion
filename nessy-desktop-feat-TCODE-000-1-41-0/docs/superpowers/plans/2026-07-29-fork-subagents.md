# R29a — Conversation forks: the engine

Parity row **R29** in `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md`.
This plan is the **engine** half: a `fork` subagent type that inherits the parent
conversation, with the tool-pool, depth, model and background rules the docs
attach to it. The user-facing surface (`/subtask`, the observe-and-steer panel)
is **R29b** and is out of scope here.

---

## 0. Method rules that apply to this plan

These are not boilerplate. Each was written after a specific failure in this
series and each has cost us a landed defect.

1. **Re-fetch the page yourself.** Every quotation below came from
   `curl -s https://code.claude.com/docs/en/sub-agents.md`. Fetch it again before
   you start. Do **not** use a summarising fetch tool — twice in this series a
   summariser invented field names that then shipped.
2. **The quotation is the identifier, not the line number.** The page grows
   between fetches, and it has grown *non-uniformly* before (some cites moved up,
   some down). Locate each quoted sentence by its text, then **report the line
   number you actually found it at** in your close-out. If a quotation is no
   longer in the page, stop and say so — do not substitute a nearby sentence.
3. **Read around the quotation.** My quotations are what I judged load-bearing;
   they are not the whole contract. Read the enclosing section. If a sentence
   between my quotations changes what they mean, that sentence wins and you
   report the correction. (This exact failure produced a wrong composition
   premise in R25c: I quoted two sentences and missed the paragraph between them
   that said the opposite.)
4. **Two git commands, not one.** Put the pathspec on the **commit**, not only on
   `git add`. Another agent is working in this repo concurrently; a bare
   `git commit -a` or a pathspec-less commit will absorb their in-flight files.
5. **Declared ≠ enforced.** The recurring defect of this whole series, roughly
   twenty instances now, is a field parsed on one path and read on none, or read
   on one backend and not the other. For every field you add, name the consumer
   and prove it runs. A test that constructs the object and asserts the field is
   present proves nothing.

---

## 1. What a fork is, in the docs' own words

> A fork is a subagent that inherits the entire conversation so far instead of
> starting fresh. This drops the input isolation that subagents otherwise
> provide: a fork sees the same system prompt, tools, model, and message history
> as the main session, so you can hand it a side task without re-explaining the
> situation. The fork's own tool calls still stay out of your conversation and
> only its final result comes back, so your main context window stays clean.

(`sub-agents.md`, § *Fork the current conversation*, found at `:1004` on
2026-07-29.)

The comparison table in § *How forks differ from named subagents* (`:1038`–`:1044`
on 2026-07-29) is the field-by-field contract:

| | Fork | Named subagent |
| :-- | :-- | :-- |
| Context | Full conversation history | Fresh context with the prompt you pass |
| System prompt and tools | Same as main session | From the subagent's definition file, filtered for background runs |
| Model | Same as main session | From the subagent's `model` field |
| Permissions | Prompts surface in your terminal | Prompts surface in your main session when running in the background |
| Prompt cache | Shared with main session | Separate cache |

And the rules scattered through the rest of the page:

> [Forks](#fork-the-current-conversation) skip both filters and receive the main
> conversation's exact tool pool.

(§ *Available tools*, `:324`.)

> `Agent`, when the subagent is at the [depth limit](#let-subagents-spawn-their-own-subagents);
> in a [fork](#fork-the-current-conversation) the tool stays listed but returns
> an error instead of spawning

(§ *Available tools*, `:326`.)

> At the depth limit, Claude Code withholds the `Agent` tool from every subagent
> except a [fork](#fork-the-current-conversation), so a subagent at the limit
> does its delegated work itself and returns one summary. A fork at the limit
> keeps `Agent` in its inherited tool list, but the tool returns an error instead
> of spawning.

(§ *Let subagents spawn their own subagents*, `:862`.)

> The exception is a [fork](#fork-the-current-conversation), which inherits the
> parent conversation instead of starting fresh.

(§ *What loads at startup*, `:916`.)

> **Output style**: a subagent runs its own system prompt, so your
> [output style](/docs/en/output-styles) doesn't shape its responses, except in a
> [fork](#fork-the-current-conversation).

(§ *What loads at startup*, `:933`.)

> Claude can spawn a fork by requesting the `fork` subagent type explicitly. When
> Claude doesn't request a type, it still gets the
> [general-purpose](#built-in-subagents) subagent, and named subagents such as
> Explore still spawn as before.

(§ *Fork the current conversation*, `:1010`.)

> Every subagent runs in the [background](#run-subagents-in-foreground-or-background),
> whether it is a fork or a named subagent. Set
> `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` to `1` to keep subagents synchronous.

(§ *Fork the current conversation*, `:1011`.)

> When [`CLAUDE_CODE_FORK_SUBAGENT`](#fork-the-current-conversation) is set to
> `1`, every subagent runs in the background and the frontmatter `background`
> field has no effect, because fork mode removes the `run_in_background`
> parameter from the `Agent` tool. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` takes
> precedence over fork mode and keeps subagents in the foreground.

(§ *Run subagents in foreground or background*, `:783`.)

> To control fork mode regardless of the staged rollout, set
> [`CLAUDE_CODE_FORK_SUBAGENT`](/docs/en/env-vars) to `1` to enable it explicitly
> or to `0` to disable it. The variable is honored in interactive mode and via
> the SDK or `claude -p`.

(§ *Fork the current conversation*, `:1006`.)

> Setting `CLAUDE_CODE_FORK_SUBAGENT=1` enables fork mode in interactive
> sessions, [non-interactive mode](/docs/en/headless), and the Agent SDK; setting
> it to `0` disables fork mode everywhere, including any server-side rollout. A
> fork can't spawn further forks.

(§ *Limitations*, `:1052`.)

> When Claude spawns a fork through the Agent tool, it can pass
> `isolation: "worktree"` so the fork's file edits are written to a separate git
> worktree instead of your checkout.

(§ *How forks differ from named subagents*, `:1048`.)

> Because a fork's system prompt and tool definitions are identical to the
> parent, its first request reuses the parent's
> [prompt cache](/docs/en/prompt-caching#subagents-and-the-cache). This makes
> forking cheaper than spawning a fresh subagent for tasks that need the same
> context.

(§ *How forks differ from named subagents*, `:1046`.)

> Every subagent Claude spawns with the Agent tool counts toward the limit:
> nested subagents, [forks](#fork-the-current-conversation), and background
> subagents […]

(§ *Session subagent limit* neighbourhood, `:895`.)

**Explicitly out of scope, and why.** `:997`–`:999` describe `/subtask`, `/fork`
and the command-rename history; `:1019`–`:1032` describe the panel and its key
bindings. Those are R29b. `:1001` marks Claude-spawned forks experimental — that
is a rollout note about their product, not a contract we implement.

---

## 2. What we already have, and where the seam is

You are **not** building session forking. It exists. Confirm each of these
yourself before you write code; they were read on 2026-07-29 and the repo is
moving under a concurrent agent.

- **Pi SDK session fork.** `packages/shared/src/agent/pi-agent.ts` (~`:1434`)
  passes `branchFromSdkSessionId`, `branchFromSessionPath` and
  `branchFromSdkTurnId` into the subprocess init. The comment there explains the
  path derivation: the parent session directory is resolved transiently from the
  composite `branchFrom.parent` SessionKey and is never persisted to JSONL.
- **The host side of branching.** `SessionManager.createSession` accepts
  `branchFromSessionId` + `branchFromMessageId` (validation begins ~`:8150`) and
  folds them into the persisted `branchFrom` shape (~`:7007`).
- **A degradation path.** `SessionManager` ~`:1536` sets
  `branchContextStrategy` depending on whether `branchFromSdkSessionId` is
  present, and `packages/shared/src/agent/errors.ts:248` says *"Retrying will
  start a fresh fork from a summary of the parent conversation."* **This is the
  sharpest risk in the plan — see Task 4.**
- **The child-spawn seam.** `SessionManager.startPiChildRuntime` (~`:9473`)
  creates the child with `this.createSession(parent.workspace.id, {…})` at
  ~`:9502`. Today it passes `name`, `permissionMode`, `thinkingLevel`, `model`,
  `llmConnection`, `enabledSourceSlugs`, `hidden`, `projectHandleId`. **A fork is
  this call plus the branch options.**
- **The subagent tool.** `packages/pi-agent-server/src/orchestrator/subagent-tool.ts`.
  `normalizeSubagentRequest` (~`:101`) takes `{agent, task}` in single mode; the
  `agent` string is resolved against `BUILTIN_AGENT_DEFINITIONS`
  (`packages/shared/src/agents/definitions.ts:136`) plus runtime definitions.
  Background defaults are decided at ~`:362`–`:366` with an explicit call-site
  `background` argument winning.
- **The child contract.** `packages/shared/src/agent/pi-harness/child-session-port.ts`
  — `PiChildRestrictionsV1` carries `prompt`, `model`, `tools`, `thinkingLevel`,
  `worktreePolicy`, `maxTurns`, `permissionMode`, `skillKeys`, `mcpServerKeys`.
  `PiChildBudgetsV1` carries `depth`, `maxDepth`, `ancestry`.
- **Permission clamping.** `startPiChildRuntime` ~`:9490`–`:9498` clamps the
  child's mode to be no broader than the parent's. **This must keep applying to
  forks** — see Task 1's security note.

---

## 3. Tasks

Each task is one commit. Subjects are given verbatim; use them exactly.

### Task 1 — the `fork` agent type

**Commit:** `feat(agents): a fork subagent type that inherits the conversation`

Add `fork` as a spawnable agent type reachable through the existing subagent
tool's `agent` field, per `:1010`'s "requesting the `fork` subagent type
explicitly".

Decisions this task must make and record:

- **Where the type lives.** `BUILTIN_AGENT_DEFINITIONS` is a list of
  `AgentDefinition`s with `systemPrompt`, `toolset` and `tier`. A fork has **no**
  system prompt of its own and **no** toolset of its own — both come from the
  parent (`:1004`, and the table's "Same as main session" rows). Adding it as a
  fifth ordinary definition with placeholder values would be the wrong shape and
  would immediately violate `:1004` when something read `systemPrompt`. Decide
  whether `fork` is a definition with a marker field, or a reserved name handled
  before definition resolution. Whichever you pick, **the invariant is that no
  code path can read a fork's `systemPrompt`, `tools` or `model` from a
  definition** — assert that, don't assume it.
- **Reserved-name collision.** A workspace or plugin agent file named `fork`
  must not be able to shadow or impersonate the built-in. Check how
  `resolveAgentDefinition` currently orders built-ins against user definitions and
  make the outcome explicit and tested. Note that R30c closed a
  privilege-escalation hole in exactly this neighbourhood (a plugin's own agent
  file supplying `permissionMode: bypassPermissions`), so treat any
  plugin-supplied path here as hostile input.
- **Permission clamping still applies.** A fork inherits the parent's mode, which
  is what the clamp already produces when `restrictions.permissionMode` is
  absent. Do **not** special-case forks out of `clampPermissionModeToParent`. A
  fork inheriting the parent's mode is the contract; a fork *widening* it is not,
  and the clamp is the only thing standing between those two.

**Gate:** a test that spawns `agent: 'fork'` and asserts the child was created
with the parent's model and the parent's mode, and a test that a user-defined
agent named `fork` cannot change either.

---

### Task 2 — inheritance: wire the fork to the session branch

**Commit:** `feat(agents): forks inherit the parent conversation through a session branch`

In `startPiChildRuntime`, when the record is a fork, pass the branch options to
`createSession` so the child inherits the parent's message history — `:1004`'s
"inherits the entire conversation so far".

- **The anchor is the parent's latest persisted message** at spawn time. "So far"
  is the whole conversation, so the anchor is the end of it, not a user-chosen
  point.
- **The parent is mid-turn when it spawns.** This is the load-bearing mechanical
  risk. The parent's Pi session sidecar may not have flushed the current turn
  when the fork's preflight goes looking for it. **Prove what actually happens
  before you design around it**: spawn a fork mid-turn, and report whether the
  child's inherited history includes the parent's most recent messages, is short
  by a turn, or fails preflight entirely. Design the fix to whatever you
  measure — do not assume a flush is needed, and do not assume one is not.
- **`hidden: true` stays.** A fork's transcript must not appear as an ordinary
  session in the sidebar; `:1004` says only the final result comes back.
- **Model and system prompt come from the parent, not a definition.** The
  existing call passes `record.restrictions.model`; for a fork that value must be
  the parent's model. Same for the composed child prompt — `piChildRestrictions.prompt`
  is what the backend receives as `childSystemPrompt`, and for a fork it must be
  the parent's system prompt, not an agent prompt.

**Gate:** a test that reads the child session's inherited message list and
asserts it contains a message the parent sent, and one asserting a *named*
subagent's child does **not**.

---

### Task 3 — the tool pool, the depth rule, and no nested forks

**Commit:** `feat(agents): forks take the parent tool pool and cannot nest`

Three rules from three different sections, all about the same object.

- **`:324` — forks skip both filters and receive the main conversation's exact
  tool pool.** Find our equivalents of the two filters (the always-removed list,
  and the narrower background built-in set). If we have only one, or neither, say
  so with a category string rather than inventing a filter to then exempt forks
  from. What must be true at the end is that a fork's tool list equals the
  parent's, whatever machinery produces the parent's.
- **`:326` and `:862` — at the depth limit the `Agent` tool stays listed in a
  fork but returns an error instead of spawning.** Note this is *not* the same as
  withholding it, which is what non-fork subagents get. The tool must be present
  in the fork's advertised tools and must fail at call time with a real error.
  Our depth data is `PiChildBudgetsV1.depth`/`maxDepth`; `DEFAULT_MAX_DEPTH` in
  `spawner.ts` is `1`.
- **`:1052` — a fork can't spawn further forks.** This is unconditional, not
  depth-dependent. A fork at depth 0 of a `maxDepth: 3` tree still cannot fork.
  Decide the failure shape (an error from the tool, matching `:326`'s posture)
  and make it a distinct, readable message — "a fork cannot spawn another fork"
  is diagnosable; a generic depth error is not.

**Gate:** three tests, one per rule. The nested-fork test must run with headroom
in the depth budget, or it proves the depth rule instead of the fork rule.

---

### Task 4 — the degradation path must not be silent

**Commit:** `feat(agents): a fork that cannot inherit fails instead of degrading`

`errors.ts:248` and `branchContextStrategy` mean a branch whose SDK fork fails
falls back to **a summary of the parent conversation**. For a user branching a
session in the UI that is a reasonable degradation. For a fork subagent it
silently converts the thing `:1004` defines — full history, shared system prompt,
shared cache — into an ordinary subagent with a summary, while still calling
itself a fork.

That is the series' recurring defect wearing a new coat: the caller is told it
got a fork and it did not.

Required behaviour: when a fork subagent cannot inherit the parent conversation,
it **fails with a stated reason** rather than silently running as a summarised
child. If you conclude that failing is worse than degrading loudly, you may
degrade — but only if the fork's result carries the fact that it degraded, in
text the model spawning it will read, and the reason. Silence is the one option
not available.

Note the precedent: `SendUserFile` was reporting a delivery that never happened,
and the fix had to change **both** the result text and the tool description,
because the model reads the description before deciding to call. Check whether
the same two-sided fix applies here.

**Gate:** force the inherit path to fail and assert the caller can tell. A test
that only checks the happy path does not close this task.

---

### Task 5 — fork mode, the env gate, and background interaction

**Commit:** `feat(agents): the fork-mode gate and its background interaction`

`:1006` and `:1052` define an env-var gate with three states — `1` enables, `0`
disables everywhere including any server-side rollout, unset means the default.
Our convention is `NESSY_*` (the repo has ~40 such variables); `CLAUDE_CODE_FORK_SUBAGENT`
becomes `NESSY_FORK_SUBAGENT`. Use the repo's existing env-flag parser rather than
a new one — `AGENTS.md` documents the accepted values (`1/true/yes/on`,
`0/false/no/off`, anything else falls back to the default) and there is already a
helper implementing it. Find it; do not write a second.

Decide and record **what unset means for us.** Claude's default is a staged
server-side rollout, which we have no equivalent of. Pick a default, justify it
in one sentence, and make the two explicit states behave exactly as documented.

Then `:783` and `:1011`, which are one interacting pair:

- fork mode on ⇒ every subagent runs in the background, fork or named;
- fork mode on ⇒ the frontmatter `background` field has no effect, *because* the
  `run_in_background` parameter is removed from the tool — note the causal
  "because": the field stops mattering as a **consequence** of the parameter
  disappearing, so implement the parameter removal and let the field's
  irrelevance follow. Implementing them as two independent rules is how they
  drift apart later;
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` takes precedence over fork mode and
  keeps subagents in the foreground. Find our equivalent (the repo has
  `NESSY_AUTO_BACKGROUND_TASKS`, which is **not** the same variable — check
  before you assume either way) and make the precedence explicit.

Our subagent tool takes `background` as a call-site argument rather than
`run_in_background` (`subagent-tool.ts` ~`:328`, ~`:362`–`:366`). The parameter
name differs; the rule does not. Remove **our** parameter in fork mode.

**Gate:** a differential test. Enumerate the configurations — fork mode
{unset, on, off} × background {unset, true, false} × disable-background
{unset, on} — and report exactly which cells move and in which direction. A table
of results is the deliverable; "it works" is not.

---

### Task 6 — the remaining table rows, each answered

**Commit:** `docs(agents): the fork contract rows we do not implement, with reasons`

Every row of the `:1038` table and every fork sentence in the page must end with
one of the three category strings:

- `documented, implemented`
- `documented, impossible on Pi — <the nearest Pi-ecosystem equivalent we shipped>`
- `documented, not implemented — <reason and rough cost>`

The rows I expect to be interesting, though you should trust your reading over
my expectation:

- **Prompt cache shared with main session** (`:1046`). Whether a Pi session fork
  shares the parent's cache is a question about the Pi SDK and the gateway, not
  about our code. **Measure it** if you can — the honest answer is a measurement,
  and "identical prefix therefore shared cache" is an inference, not a result.
  If you cannot measure it, say that, and say what you would need.
- **Permissions: "prompts surface in your terminal"** (`:1044`). Our surface is
  a desktop app, not a terminal, and background subagents already surface prompts
  in the main session. State where a fork's prompts surface for us and whether
  that matches the row's intent.
- **`isolation: "worktree"` on a fork** (`:1048`). R30c shipped `isolation` for
  named subagents and found that `worktreePolicy` came solely from
  `toolset === 'full'`. A fork has no toolset. Check that a fork requesting
  worktree isolation is not rejected by the policy-mismatch throw R30c
  documented.
- **Forks count toward the session subagent limit** (`:895`). Verify against
  whatever limit we actually enforce.
- **Output style reaches a fork** (`:933`). We may not have an output-style
  concept at all; if so that is `inapplicable`, and say why in one line.

Do **not** half-build anything here. A costed, named gap is a better outcome than
a field that exists and does nothing — that is the shape of defect this entire
audit exists to remove.

---

## 4. Gate

Per the repo's implementation-first verification budget, run what proves the
changed contracts and name the risk each command covers:

- The focused suites for every file you touched.
- `bun run typecheck:all`.
- `bun run lint`.
- `git diff --check`.
- The affected-package aggregates for `packages/pi-agent-server`,
  `packages/server-core/src/sessions`, and `packages/shared/src/agents`.

This plan touches **session creation and permission-mode clamping**, both named
risk triggers in `AGENTS.md`. Run the expanded permission/session set **once, on
the final diff**, not after each task.

**Run every test from the repository root.** A run from inside a package
directory bypasses the config-dir isolation preload and destroys the real
`~/.nessy-agent/config.json`.

Record real output. A pre-existing failure must be reproduced on a clean
worktree at your base commit before you may call it pre-existing.

---

## 5. Constraints

- One commit per task, with the subject given verbatim above.
- **No `Co-Authored-By` trailers.**
- No push, no MR, no tags. No `git reset`, `git rebase`, or `git commit --amend`.
- **Pathspec on the commit itself**, not only on `git add`. A concurrent agent is
  working in this repo.
- Never `git checkout --` or `git stash` a file you are editing.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  — planner-owned.
- Do not touch `~/.nessy-agent/skills/r17-*` or `~/.nessy-agent/mcp/elicit-server.mjs`
  — CDP fixtures.
- No version bumps, no release notes.
- Never write to `~/.nessy/dp_auth_creds.json`.
- Never log a delivered payload, token, private key, passphrase, or credentialed
  proxy URL.
- Code, comments and commits in English.

## 6. Report

Return: the commit shas with subjects; the line number you found each quotation
at; every correction you made to this plan (they are the most valuable part of
your report — five of the last six executors found at least one real error in my
briefs, and the ones that found none were the ones I had to reopen); the Task 5
differential table; the Task 6 category strings; the mid-turn spawn measurement
from Task 2; and anything you found that is out of scope but wrong.
