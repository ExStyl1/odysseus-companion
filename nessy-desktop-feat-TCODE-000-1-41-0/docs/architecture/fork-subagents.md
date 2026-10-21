# Conversation forks (the `fork` subagent type)

A **fork** is a subagent that inherits the current conversation instead of
starting fresh. Claude Code's contract is `sub-agents.md`
§ *Fork the current conversation*; the line numbers below are where each
quotation was found on 2026-07-29.

Nessy's engine: `fork` is a reserved agent name
(`packages/shared/src/agents/definitions.ts`), the spawner composes its child
restrictions from the SESSION rather than from a definition
(`packages/pi-agent-server/src/orchestrator/spawner.ts`), and the host turns
those restrictions into an `sdk-fork` session branch of the parent
(`SessionManager.startPiChildRuntime`). The user-facing surface — `/subtask` and
the observe-and-steer panel — was added by R29b; see
`docs/superpowers/plans/2026-07-29-fork-surface.md` for what R29 still leaves.

Two later plans finished that surface and are part of its record:
`docs/superpowers/plans/2026-07-30-session-command-seam.md` (the `/subtask`
dispatch was dead in the `chat()` → `chatImpl` seam — the same seam that broke
manual `/compact`) and
`docs/superpowers/plans/2026-07-30-fork-panel-registration.md` (a `/subtask`
fork registering as a child session so the panel can show it).

**Live verification, by case.** `AGT-1`…`AGT-3` in `docs/testing/cdp-live-checklist.md` PASS on 2026-08-21 in the running app (the `/subtask` history split, the fork panel, a fork's permission prompt; `docs/testing/cdp-runs/2026-08-21-1.31.0-close-out.md`). AGT-4 and AGT-5 are BLOCKED on their fixtures, so output style, rewind, memory and effort reaching a fork are read from the code and its tests only.
All five were still ⬜ when this was written (2026-07-30), and AGT-1 was
once filed as PASS and had to be retracted (trap 1 of "What has burned us before" in the archive `docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md`).
Everything below is read from the code and its tests; those three cases are the
only part of it driven through the running app.

## Session web-search budget

`NESSY_MAX_WEB_SEARCHES_PER_SESSION` maps Claude's
`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` (accepted as a compat alias; the
Nessy name wins when both are set) and is read with the subagent-depth knob's
digits-only reader: a positive whole number in plain digits raises the
per-session `web_search` cap from its default of 200; anything else is ignored,
so the cap can be raised but not turned off (`env-vars.md:284`). See
`packages/shared/src/config/web-search-budget.ts`.

The count is tree-wide, the way `tools-reference.md:449` requires ("counted
across the main conversation and every subagent it spawns"): each Pi subprocess
keeps one module-scope counter, a spawned child is seeded with its parent's
count (`PiChildStartInput.webSearchesUsed` → `InitMessage.webSearchesUsed`),
and the child's consumption is credited back on its result
(`PiChildResult.webSearchesConsumed`). Over the cap, `web_search` returns a
non-error notice telling the model to continue with what it already gathered —
never an `isError` result that would invite a retry — and `/clear` resets the
count (`PiAgent.clearHistory` kills the subprocess and zeroes the host's
remembered total, so the next subprocess starts a fresh budget).

## Fork mode

`NESSY_FORK_SUBAGENT` maps Claude's `CLAUDE_CODE_FORK_SUBAGENT` and is read with
the repo's documented flag parser (`1/true/yes/on`, `0/false/no/off`, anything
else falls back to the default). See
`packages/shared/src/config/background-task-settings.ts`.

**Unset means ON since P6.506 (2026-09-07); it meant OFF before, and the reason
for OFF expired because the PAGE changed.** That reason read: *"Claude's unset
state is a staged server-side rollout of a capability its own docs mark
experimental; we have no rollout mechanism to mirror it."*
`sub-agents.md#turn-fork-mode-on-or-off` no longer describes a rollout — it
states two plain defaults for two plain shapes, verbatim (re-read 2026-09-07,
HTTP 200): *"Claude Code turns fork mode on by default in interactive sessions
and leaves it off by default in non-interactive mode with `-p` and in the Agent
SDK. The interactive default requires Claude Code v2.1.232 or later."* A Nessy Pi
session is the interactive shape and this fork has no `-p` one-shot Pi entry
point, so the interactive default is the one that applies. A future
non-interactive Pi entry point must pass the flag explicitly.

The second half of the old reason is still true and is now ACCEPTED rather than
avoided: every named subagent runs in the background, forks and non-forks alike,
because fork mode removes `run_in_background` from the `subagent` schema
(`:1011`, `:783`). That is the documented consequence of the documented default.
Both explicit states behave exactly as documented and are unchanged.

The residual difference between the runtimes is declared at the switch, as the
`forkSubagent` row in
`apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts`:
claude-runtime keeps the SDK's own documented OFF (nothing of ours reads this
function there), and codex has no subject at all — `thread/fork` forks a THREAD,
not a subagent inheriting the parent's context and prompt cache.

Fork mode is resolved HOST-side and carried in the execution manifest
(`PiOrchestratorConfig.forkSubagent`) rather than read from the subprocess
environment, because `:783` makes it change the `subagent` tool's parameter
schema and that schema is hashed into `modelContractHash`. Two pins therefore
exist — `subagent` and `subagent:fork-mode` — selected by
`piStaticModelContractPinKey`.

### The background interaction, measured

`fork mode {unset, on, off}` × `background {unset, true, false}` ×
`NESSY_DISABLE_BACKGROUND_TASKS {unset, on}`. Produced by
`packages/pi-agent-server/src/orchestrator/fork-mode.test.ts`.

| fork mode | `background` arg | disable-bg | `background` parameter | effective run | `agent:"fork"` |
| :-- | :-- | :-- | :-- | :-- | :-- |
| unset | unset | unset | present | background | rejected |
| unset | unset | on | present | foreground | rejected |
| unset | true | unset | present | background | rejected |
| unset | true | on | present | foreground | rejected |
| unset | false | unset | present | foreground | rejected |
| unset | false | on | present | foreground | rejected |
| on | unset | unset | removed | background | accepted |
| on | unset | on | removed | foreground | accepted |
| on | true | unset | removed | background | accepted |
| on | true | on | removed | foreground | accepted |
| on | false | unset | removed | background | accepted |
| on | false | on | removed | foreground | accepted |
| off | unset | unset | present | background | rejected |
| off | unset | on | present | foreground | rejected |
| off | true | unset | present | background | rejected |
| off | true | on | present | foreground | rejected |
| off | false | unset | present | foreground | rejected |
| off | false | on | present | foreground | rejected |

Three cells move, and only three:

1. **fork mode on removes the `background` parameter** (`:783`). Every other
   column is unaffected by the removal; the frontmatter `background` field
   losing its effect is a CONSEQUENCE of the parameter being gone, not a second
   rule, so it is not implemented separately.
2. **fork mode on forces every run to the background** (`:1011`), overriding an
   explicit `background: false`.
3. **`NESSY_DISABLE_BACKGROUND_TASKS` overrides both** (`:783`), returning every
   run to the foreground while leaving the parameter removed — the off switch's
   documented precedence is over scheduling, not over fork mode itself.

`unset` is byte-identical to `off` in every cell, which is what makes the chosen
default a single stated decision rather than a third behaviour.

### A user fork is also a background TASK

A detached child is not just a spawn. The host's delegating child-session port
refuses a background start that carries no `backgroundTaskId`
(`pi-background-child-task-id-required`), because a background child outlives the
turn that spawned it and needs a retained capability authority to keep running.
So a background fork owes the same three facts a background subagent owes:
`task_backgrounded` before it starts, a `BackgroundTaskRegistry` entry while it
runs, and `task_completed` when it ends — one seam, shared by both callers
(`packages/pi-agent-server/src/orchestrator/background-child-task.ts`).

`/subtask` deliberately does not route through the `subagent` tool (the tool
refuses `agent: "fork"` outside fork mode, while `:1013` starts a user fork with
or without the variable), and S13 found that it had inherited none of that
registration as a result: every `/subtask` fork was refused before a child
session existed, which is why no fork row ever reached the panel. Not being a
tool call was never meant to mean not being registered.

## Row-by-row status

Every row of the `:1038` table and every fork sentence in the page, each with one
of the three category strings.

### Implemented

| Contract | Where | Status |
| :-- | :-- | :-- |
| `:1004` a fork inherits the entire conversation so far | `startPiChildRuntime` → `createSession({branchFromSessionId, branchFromMessageId})` with `branchFullHistory` | `documented, implemented` |
| `:1040` Context — full conversation history | anchored at the parent's LATEST persisted message | `documented, implemented` |
| `:1042` Model — same as main session | `composeForkRestrictions` uses `cfg.modelId`, never `tierModelMap` or an agent `model` | `documented, implemented` |
| `:324` forks skip both filters and receive the main conversation's exact tool pool | `resolvePiSessionToolPool` | `documented, implemented` |
| `:326`/`:862` at the depth limit a fork keeps `Agent` listed and the tool errors | the fork's pool contains `subagent`; `spawnChildSession` returns the depth error at call time | `documented, implemented` |
| `:1052` a fork can't spawn further forks | `PiOrchestratorConfig.sessionIsFork` → `SpawnerRuntime.isForkSession`, checked before the depth budget | `documented, implemented` |
| `:1006`/`:1052` the env gate's three states | `forkSubagentModeEnabled` | `documented, implemented` |
| `:1010` Claude spawns a fork by requesting the `fork` type explicitly | reserved name; accepted only under fork mode | `documented, implemented` |
| `:1011`/`:783` background coupling and the off switch's precedence | table above | `documented, implemented` |
| `:895` forks count toward the session subagent limit | every fork goes through `ChildSessionService.start`, which counts `children.length` against `budgets.fanout` and never removes finished records | `documented, implemented` — the limit itself is `orchestrator.maxAgents` (default 1000), not Claude's 200 |
| `:916` a fork is the exception to fresh-context startup | the branch copies the parent transcript and forks the parent's Pi session file | `documented, implemented` |

### Divergences and gaps

**`:1041` System prompt and tools — same as main session.** CLOSED by R29b.
`documented, implemented.` The fork's child sends an EMPTY `childSystemPrompt`,
so its backend composes the same base session prompt the parent composes for
itself, with the same workspace, working directory, preset, output style and
project-trust inputs.

R29a recorded one input that differed — the session id session-scoped memory is
read under — and located it at `getSystemPrompt` → `loadMemoryPromptBlock`.
**That location was wrong**: the block is gated on `capabilityContextPinned`,
which is true on every normal Pi turn, so the path named there is dead in
production. On the live path session memory is a capability-inventory record
keyed by `CapabilityContext.sessionId`. Both are now fixed: a fork carries
`memorySessionId` (capability path) and `piParentSessionId` (legacy path), each
set only when `piChildRestrictions.fork === true`, so the fork reads the
PARENT's memory and a named subagent keeps its own.

**`:1046` Prompt cache — shared with main session.**
`documented, not implemented — still unmeasured, but now measurable.` This is a
question about the Pi SDK and the gateway, not about our code, and "identical
prefix therefore shared cache" is an inference rather than a result.

R29b established that the ACCOUNTING exists end to end, which R29a could not
confirm: `pi-ai`'s `openai-completions` adapter maps
`usage.prompt_tokens_details.cached_tokens` (falling back to
`prompt_cache_hit_tokens`) onto `cacheRead`, and our Pi event adapter already
surfaces that as `cacheReadTokens`. So the number is readable wherever the
provider reports one.

Two things still block a result, neither of them code we own. Reading it needs
one live turn per arm against the gateway — spawn a fork and a named subagent
from the same parent and compare each first request's `cacheRead` — and the
offline harness stubs the provider. And the gateway must populate
`cached_tokens` on an OpenAI-compatible response at all; if it reports nothing,
the arms have to run against an Anthropic-shaped connection instead.

One precondition R29a named is now satisfied rather than outstanding: the
session-memory divergence that broke prefix identity for any parent with session
memory is fixed, so a measurement would at last be measuring the thing the row
describes.

**`:1043` Permissions — prompts surface in your terminal.** CLOSED by R29b.
`documented, impossible on Pi — the visible ancestor conversation instead of a
terminal.` A fork's child is a `hidden: true` session and `SessionManager` still
emits `permission_request` with the CHILD's `sessionId` — that id is what
`respondToPermission` validates the answer against, so it is deliberately
unchanged. The request now also carries `parentSessionId`, walked to the nearest
VISIBLE ancestor, and an `agentLabel`; the renderer files the prompt under that
ancestor and names the asking agent on the card. Answering it resolves the
child's waiting resolver, so the fork unblocks.

The same routing covers named background subagents, which `:770` and the
named-subagent half of `:1044` put in the main session too.

**`:1048` a fork can be spawned with `isolation: "worktree"`.** CLOSED by R29b.
`documented, implemented.` R30c shipped `isolation` as an agent-DEFINITION
field, and a fork has no definition, so the call site is its only channel. The
`subagent` tool advertises `isolation` under FORK MODE ONLY — fork mode is the
only mode that accepts `agent: "fork"`, so the parameter is offered exactly
where it can be used, and only the `subagent:fork-mode` contract hash moved
rather than both variants. `spawnChildSession` refuses the argument for a named
agent by name rather than dropping it, and forwards it into
`composeForkRestrictions`, which is the only place a fork's `worktreePolicy` is
decided. R29a's reading of the R30c policy-mismatch throw holds and is now
covered by a test: it lives inside `if (pinnedDefinition)` and a fork never has
one, so a fork requesting an isolated worktree is admitted and gets a lease.

**`:933` Output style reaches a fork, and only a fork.** CLOSED by R29b.
`documented, implemented.` A fork gets the session's style because its prompt is
the session prompt; the global read that also gave it to every NAMED subagent is
now gated by `resolveChildOutputStyleId`, which suppresses the style for
`piChildKind === 'named'` and leaves the main session and forks untouched.
`output-styles.md:104` states the same rule from its own page.

**`:324` first filter — "removes a short list of tools from every subagent".**
`documented, partially implemented.` Our equivalent is
`SUBAGENT_UNAVAILABLE_TOOLS` in
`packages/pi-agent-server/src/orchestrator/runtime-agent-definitions.ts`, which
holds ONE entry (`ask_user`) against Claude's nine. We additionally subtract
`ORCHESTRATION_TOOLS` from a tool-less imported agent's inherited default, which
Claude has no counterpart for. A fork skips both, which is the row's requirement.

**`:324` second filter — background subagents get a narrower built-in set.**
`documented, not implemented — no such filter exists.` Our background children
receive the same tools as foreground ones. The `:770` phrase "except for
conversation forks" therefore has nothing to except a fork from. Implementing
the filter is a separate parity item and is a prerequisite before this row can be
called implemented for non-forks; a day, mostly in deciding which of our tool
names map onto Claude's twenty-name keep-list.

**`:326` first filter — `Agent` is withheld from a non-fork subagent at the depth
limit.** `documented, not implemented — for non-forks.` We never withhold
`subagent`; a named subagent that lists it keeps it and the call fails at the
depth check, which is the FORK behaviour applied to everyone. Built-in agent
definitions do not list `subagent`, so the practical exposure is limited to an
imported agent that names it explicitly. Half a day.

## The one thing that must not regress

A fork that cannot inherit **fails**; it never runs as a summarised or seeded
child. Three paths enforce it:

- `resolveForkBranchOptions` throws when the parent has no persisted message;
- `createSession` throws when the parent has no provider session to fork from,
  and `startPiChildRuntime` re-checks the created child's lineage before
  starting it;
- `createManagedSession` pins a restored fork child to `sdk-fork` instead of
  letting it fall back to `seeded-fresh-session`.

Every one of those reaches the spawning model as
`fork-not-started: … it was NOT started and no summarised or seeded substitute
was run in its place`, and the subagent tool's own description says the same
thing BEFORE the model decides to call — the two-sided shape the `SendUserFile`
delivery fix established. `errors.ts`'s "Retrying will start a fresh fork from a
summary of the parent conversation" describes the UI branch degradation, which is
Claude-backend only (`claude-agent.ts:recoverFromStaleBranchFork`) and is
deliberately not reachable from a fork subagent.
