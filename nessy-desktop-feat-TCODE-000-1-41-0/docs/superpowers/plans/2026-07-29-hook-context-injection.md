# S8 — The hook context-injection channel

From the phase-4 sweep (`2026-07-29-phase4-findings.md`, `hooks-guide.md`).

**Both of the guide's canonical context-injection recipes are dead on our shipped
Pi backend.** A user who follows Claude's own hook guide writes a hook, sees it
run, and gets nothing in the model's context.

The hook layer is otherwise unusually conformant — the sweep reproduced the whole
`if`-filter truth table, 5 of 5. This is a specific missing channel, not a broken
subsystem.

---

## 0. Method rules

1. **Fetch the pages yourself**: `curl -s https://code.claude.com/docs/en/hooks-guide.md`
   and `curl -s https://code.claude.com/docs/en/hooks.md`. Never a summarising
   fetch tool — it invented three hook payload field names in this series and
   they shipped. That failure is why rule 1 exists.
2. **The quotation is the identifier, not the line number.** Report where you
   found each. `hooks.md` has grown between fetches before, non-uniformly.
3. **Read around each quotation.** The sweep found that one of these rules exists
   **only** on the guide and nowhere in the reference — reading one page of the
   pair is how this gap survived four previous hook units.
4. **Declared ≠ enforced.** Prove the channel on **Pi**, the shipped default.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. That list was short
   twice running, so still reproduce anything you call pre-existing on a clean
   `git worktree` at your base commit. Never `git stash`.

---

## 1. The three findings

Confirm each yourself before building — the sweep's probes are a starting point,
not evidence you may inherit.

**(a) Raw stdout does not become context.** The guide says that for
`UserPromptSubmit`, `UserPromptExpansion` and `SessionStart` hooks, "anything you
write to stdout is added to Claude's context" on exit 0 — and its
`SessionStart`-after-compaction recipe depends on exactly that: "Any text your
command writes to stdout is added to Claude's context." We appear to read only
the structured `additionalContext`, so a hook that simply echoes text produces
nothing.

**(b) `SessionStart` never fires with `source: "compact"`.** The guide's
re-inject-after-compaction recipe matches on `compact`; the reference lists
`startup`, `resume`, `clear`, `compact` and `fork` as the possible sources. If we
never emit `compact`, the recipe cannot fire at all.

**(c) `type: "agent"` hooks are rejected at import.** The reference lists
`"type": "agent"` as a hook type — multi-turn verification with tool access,
marked experimental. We refuse it outright.

Note also, from the same sweep and running the *other* way: `additionalContext`
at the **top level** of a hook's JSON output is documented as ignored, and
`hook-command.ts` reads it via `?? parsed.additionalContext`. We are more
permissive than the contract. Decide whether to keep that — being more permissive
is a smaller problem than being less, but it is still a divergence, and it exists
only because the sentence appears on the companion page.

---

## 2. Tasks

### Task 1 — raw stdout becomes context

**Commit:** `feat(hooks): raw stdout from a context hook reaches the model`

Implement the exit-0 stdout channel for the events the docs name, and **only**
those events. Establish the exact event list from the pages rather than from this
plan.

- Decide what happens when stdout is **both** valid JSON and meant as text. The
  docs treat a JSON decision object and raw context text as different things;
  a hook that legitimately echoes a JSON snippet as context must not have it
  parsed as a decision. Say what rule you used.
- Respect whatever output cap the docs state (this series has previously found a
  10 000-character cap on hook output — check whether it applies here).
- **Where the text lands matters.** Context injected into the system prefix
  invalidates the Pi prompt cache for the whole session;
  `packages/shared/AGENTS.md` documents the volatile-versus-stable split and why
  Pi routes volatile blocks to the user tail. Follow that split; do not put
  per-turn hook output anywhere cacheable.

**Gate:** a hook that writes plain text on exit 0, driven through the real hook
runtime, with the text asserted in the composed turn. Then the negative: an event
NOT on the documented list must not inject.

---

### Task 2 — `SessionStart` fires after compaction

**Commit:** `feat(hooks): SessionStart fires with source "compact" after compaction`

Emit the event at the real compaction seam with the documented `source` value.

- We already have `PreCompact`/`PostCompact` concepts in the event table — find
  what we emit today and where, and say whether this is a new emission or a
  missing `source` on an existing one.
- Check the other documented sources while you are there (`startup`, `resume`,
  `clear`, `fork`) and report which we emit. A `source` field that only ever
  carries one value is the declared-versus-enforced split in miniature.

**Gate:** drive a real compaction and assert the hook fires with
`source: "compact"`. A test that calls the emitter directly proves the emitter,
not the wiring.

---

### Task 3 — `type: "agent"` hooks, or an honest refusal

**Commit:** `feat(hooks): accept the agent hook type, or refuse it with a reason`

Two acceptable outcomes, and you decide which on evidence:

- implement it, if the mechanism maps onto something we have (we do have
  subagents and a hook runtime); or
- keep refusing, but **as a recorded, explained deferral** rather than a parse
  error — the same shape our plugin adapter uses for surfaces we do not support,
  with a reason string a user can act on.

What is not acceptable is the current state: a documented, experimental-but-real
hook type that fails at import with no explanation of why.

Whichever you choose, give it a category string.

---

### Task 4 — the rest of the guide

**Commit:** `docs(hooks): the hooks-guide rows we do not implement`

Category string per requirement, including the top-level `additionalContext`
divergence from § 1. The sweep counted nine `implemented` and thirteen
`divergent`/`absent`/`inert` on this page — verify rather than copy, and add the
strings so they reach the deviation register.

---

## 3. Gate

Focused suites for every changed file; the hooks, automations and session
aggregates; `bun run typecheck:all`; `bun run lint`; `git diff --check`.

Hooks are a **decision-bearing** surface — a named risk trigger. Run the expanded
hook/permission set once on the final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe:** with the stdout channel removed, the Task 1 test must go red.

---

## 4. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **A second agent may be editing the LLM-connection and model-catalog code
  (`packages/shared/src/config/`, the managed policy, the model resolvers).**
  Stay out of those.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- Never execute a hook fixture that leaves the temp directory you created for it.
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 5. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; the exact event list for the stdout channel and where you derived it; the
`SessionStart` sources we emit today versus documented; the Task 3 decision and
its reasoning; the category strings; and the mutation probe.

---

## 6. Execution record — `hooks-guide.md` row by row

Both pages fetched with `curl` on 2026-07-29: `hooks-guide.md` at 1000 lines,
`hooks.md` at 3173. Line numbers below are from those fetches and are secondary
to the quotations.

### 6.1 The three findings, as reproduced

Each was reproduced before any code was written, and each needed a correction.

**(a) Raw stdout does not become context — CONFIRMED, and the event list is
three, not "the events the docs name" loosely.** `hooks.md:674`: "For most
events, stdout is written to the debug log but not shown in the transcript. The
exceptions are `UserPromptSubmit`, `UserPromptExpansion`, and `SessionStart`,
where stdout is added as context that Claude can see and act on."
`hooks-guide.md:562` names the same three. Both parsers required stdout to start
`{` and end `}`, so `echo 'text'` produced `undefined`.

**(b) `SessionStart` never fires with `source: "compact"` — CONFIRMED, and two
more sources were missing.** The only emitters were `pi-agent.ts` (`this
.piSessionId ? 'resume' : 'startup'`), `codex-agent.ts` and
`nestor-cloud-agent.ts` (same ternary). `clear` and `fork` were absent too; the
subprocess bridge hard-coded `'startup'` and the host discards its `SessionStart`
entirely.

**(c) `type: "agent"` hooks are rejected at import — CONFIRMED, but not for the
stated reason, and this is the plan's largest correction.** The type is
*accepted*; what is rejected is the documented *shape*. The Claude adapter
demanded `agent`/`agentName`/`name`, and `hooks.md:493-500` § *Prompt and agent
hook fields* gives agent hooks exactly two fields, `prompt` (required) and
`model`. `hooks.md:2966`: "Set `type` to `"agent"` and provide a `prompt`
string." There is no agent-name key anywhere in the format, so the reference's
own example hook was dropped with `Claude agent hook requires an agent name` — a
diagnostic naming a key its author could not supply. It also read `name`, which
is the hook's own id, so a self-naming agent hook was imported as a request to
spawn a subagent by that name.

**The guide-only rule.** `hooks-guide.md:598`: "Nest `additionalContext` inside
`hookSpecificOutput`; if you place it at the top level of the JSON, Claude Code
silently ignores it." That sentence appears on the guide and **nowhere** in
`hooks.md`, which is why four hook units missed it.

### 6.2 Category strings

Counted on the fetched `hooks-guide.md`: **14 rows `documented, implemented`**
(three of them closed by this unit) and **18 rows carrying a deviation string**;
§ 6.3 adds 7 more found off this page.
The sweep's 9/13 is low on both sides; the difference is rows where only *half*
the requirement is implemented — HTTP and `mcp_tool` hooks fire but their output
is discarded, and three matcher vocabularies are inert on events we do emit —
which the sweep counted once each and this record splits.

**Keep each category string on one line.** The register regenerates with a
single-line `rg`, so a marker wrapped across a line break never reaches it.

#### Closed by this unit

- `:286` / `:562` exit-0 stdout on `UserPromptSubmit`, `UserPromptExpansion` and
  `SessionStart` — **documented, implemented**.
- `:284` `SessionStart` with a `compact` matcher after every compaction —
  **documented, implemented**.
- `:643` the `clear` `SessionStart` source — implemented on `PiAgent
  .clearHistory()`, but that method has no caller outside tests anywhere in
  `packages/` or `apps/`, so no product action reaches it yet. Counted as
  implemented at the API level; the missing `/clear` surface is its own gap.

#### Already implemented, verified on this pass

`:90` the `Notification`/`permission_prompt` recipe; `:185` `PostToolUse` with an
`Edit|Write` matcher; `:217` `PreToolUse` exit 2 with stderr fed back; `:393` the
`PermissionRequest` auto-approve recipe including
`updatedPermissions`/`setMode`; `:493` the `deny > defer > ask > allow` merge and
"Text from `additionalContext` is kept from every hook"; `:568` exit-0 JSON for
structured control; `:793` prompt hooks; `:903` the per-type timeout defaults;
`:917` `PreToolUse` firing before any permission-mode check, `dontAsk` included;
`:955` `stop_hook_active` and the 8-block override — all **documented,
implemented**.

#### Open deviations

- `:447` "all matching hooks run in parallel" — **documented, not implemented** —
  both executors run matched command hooks sequentially with `await`. Sequential
  order is deterministic, which is what makes the merge reproducible; the
  documented consequence we lose is wall-clock, not semantics.
- `:447` "identical hook commands are automatically deduplicated" —
  **documented, not implemented** — no dedupe by command string or `args`, so a
  hook declared at two scopes runs twice.
- `:462` `MessageDisplay` — **documented, not implemented** — Nessy renders
  assistant text in the renderer, not through a per-line interception seam;
  imported hooks defer with `plugin.deferred.event_message_display_unsupported`.
- `:469` `TeammateIdle` — **documented, inapplicable** — an agent-teams event
  with no counterpart product surface; deferred with
  `plugin.deferred.event_teammate_idle_unsupported`.
- `:487` `type: "agent"` — **documented, not implemented** — the type exists to
  verify against "actual files or test output, not just evaluating the hook input
  data alone" (`hooks.md:2962`), and Nessy has no decision-bearing tool-using
  verifier to map that onto. Degrading it onto the single-turn prompt-hook judge
  would answer from exactly the input the page calls insufficient, and a wrong
  `ok: true` from a degraded verifier is worse than none. Now a recorded deferral
  (`plugin.deferred.claude_hook_type_agent_experimental`) instead of an import
  failure.
- `:598` top-level `additionalContext` is "silently ignore[d]" —
  **documented, not implemented** — `hook-command.ts` reads
  `hookSpecificOutput?.additionalContext ?? parsed.additionalContext`, so we are
  MORE permissive than the contract. Kept deliberately: tightening it would break
  hooks that work today, and the failure mode of the divergence is a hook whose
  context reaches the model on Nessy and silently would not on Claude Code —
  visible to its author the moment they test it there, unlike the reverse.
- `:485` `mcp_tool` hook output — **documented, not implemented** — the tool is
  invoked, but `PluginMcpToolHookRunner` returns `Promise<void>`, so
  `hooks.md:467` ("The tool's text content is treated like command-hook stdout")
  has no consumer. An `mcp_tool` hook is observational on every event.
- `:890` HTTP hook response body — **documented, not implemented** — the request
  fires with `allowedEnvVars` interpolation, but `PluginHttpHookRunner` also
  returns `Promise<void>`, so the documented 2xx text-as-context and
  2xx-JSON-as-decision handling (`hooks.md:747-749`) is absent.
- `:340` `CLAUDE_ENV_FILE` — **documented, not implemented** — no env-file
  preamble is sourced before Bash tool calls, so the direnv recipe's `SessionStart`
  and `CwdChanged` hooks run and their writes are never read.
- `:650` the `ConfigChange` matcher vocabulary (`user_settings`,
  `project_settings`, `local_settings`, `policy_settings`, `skills`) —
  **documented, not implemented** — Nessy's `ConfigChange` reports runtime
  session-config keys, so a documented matcher can never fire. Already recorded at
  registration via `MATCHER_INERT_AGENT_EVENTS`.
- `:644` the `Setup` matcher vocabulary (`init`, `maintenance`) —
  **documented, inapplicable** — those are `--init-only`/`--init`/`--maintenance`
  CLI launch modes Nessy has no equivalent of.
- `:656` the `UserPromptExpansion` matcher (`command_name`) —
  **documented, not implemented** — Nessy's `UserPromptExpansion` fires once per
  turn at agent start and carries no expanded command name.
- `:783` managed-policy hook location — **documented, not implemented** — the
  managed Pi policy governs whether plugin hooks may run, but declares no hooks of
  its own, so `settings.md`'s "managed hooks" names an empty set here.
- `:785` skill and agent frontmatter as a hook location —
  **documented, not implemented** — no frontmatter `hooks:` reader exists, which
  is also why `once` is registered and then ignored
  (`plugin.hooks.once_ignored`); the field is documented as honoured for
  skill-frontmatter hooks only.
- `:787` the `/hooks` menu, "all configured hooks grouped by event" —
  **documented, not implemented** — project-scope hooks appear in the Sources
  panel and native automations in the Automations list; there is no single browser
  across all locations.
- `:789` `disableAllHooks` — **documented, not implemented** — no such setting;
  the managed policy's hook lock is the nearest control and is admin-only.
- `:966` `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` — **implemented** by R84 (doc-sweep
  parity wave, 2026-08-07). `resolveStopHookBlockCap`
  (`packages/shared/src/config/stop-hook-block-cap.ts`) reads
  `NESSY_STOP_HOOK_BLOCK_CAP` with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` as a
  compatibility alias, the Nessy spelling winning when both are set; `0`
  disables the cap and any malformed value falls back to 8, so a typo cannot
  buy an uncapped hook loop. The former fixed `MAX_CONSECUTIVE_HOOK_BLOCKS`
  constant is deleted.
- `:968` § *JSON validation failed* — **documented, inapplicable** — the section
  describes a shell-profile problem in the user's `~/.zshrc`, not host behaviour;
  our shell-form spawn has the same exposure and the same fix.

### 6.3 Findings outside the plan's three

- **Hook stdin on the non-Pi path.** `hooks.md:325`: a command hook "receives the
  event's JSON input on stdin". The shipped Pi runner passes it
  (`stdinData: JSON.stringify(options.input)`), but the direct fallback
  `runHookCommand` spawns with `stdio: ['ignore', ...]`, so on Claude and Codex
  backends every documented `input=$(cat)` script reads empty.
  **documented, not implemented** — the direct runner predates the supervised one
  and was never given the stdin half.
- **`UserPromptSubmit`/`UserPromptExpansion` context is discarded on Pi.** Both
  are emitted from the subprocess `before_agent_start` seam, and
  `pi-agent.ts` forwards them with `void this.emitAutomationEvent(...)`. The
  emission is also structurally too late: the host has already sent the prompt.
  So on Pi the stdout channel and `hookSpecificOutput.additionalContext` are
  equally unreachable on those two events — the gap is the *emission site*, not
  the channel. **documented, not implemented** — moving the emission host-side
  (as `codex-agent.ts` and `nestor-cloud-agent.ts` already do) would also hand
  those events a blocking decision they do not have today, which is a
  decision-bearing change and its own unit.
- **The 10,000-character cap can never bind.** `hooks.md:765` caps hook output
  strings at 10,000 and says longer output "is saved to a file and replaced with a
  preview and file path, the same way large tool results are handled".
  `hook-command.ts` buffers a subprocess at `OUTPUT_LIMIT = 8_192`, so the
  10,000-char rule is unreachable in production and long output is silently
  truncated with no preview, no file and no notice.
  **documented, not implemented** — the two limits were added by different units
  and neither knew about the other.
- **The Codex adapter still carries the agent-hook defect Task 3 fixed.**
  `format-adapters/codex.ts` demands `agent`/`agentName`/`name` and errors with
  `Codex agent hook requires an agent name`, including the `name`-as-agent-name
  misread. Deliberately NOT changed here: Codex's plugin format is derived
  empirically (`AGENTS.md` — the help article is not publicly fetchable), so there
  is no page saying its agent hooks carry `prompt`, and guessing is how the
  invented-field bug started. `unified-adapter-conformance.test.ts` does not cover
  agent hooks, so the two adapters now disagree with nothing failing.
  **documented, not implemented** — needs a real Codex manifest to settle the
  field name before either half can be fixed.
- **A documented agent hook now makes its plugin `partial`.** `claude.ts` sets
  `state: deferred.length > 0 ? 'partial' : 'supported'`, and the renderer turns
  `partial` into `needsConfirmEnable`. A Claude plugin whose only non-conformance
  is an agent hook used to auto-activate and now asks for confirmation. Kept: a
  hook that will never run IS partial support, and the confirmation is where the
  reason string becomes visible.
- **The post-compaction hook await is unbounded and un-abortable.** The next turn
  awaits the emission with no signal and no deadline, and an imported
  `SessionStart` command hook may declare up to 600 s. This is the same shape as
  the once-per-session `SessionStart` await that has always been there, widened to
  a second site rather than newly introduced — bounding it means inventing a
  timeout policy the page does not state, so it is recorded instead.
  **documented, not implemented** — no documented cancellation semantics for a
  `SessionStart` hook to implement against.
- **`fork` as a `SessionStart` source.** Branch/fork sessions
  (`branchContextStrategy: 'sdk-fork'`) start a child agent that reports
  `startup`/`resume`. **documented, not implemented** — the child would need the
  fork fact threaded through its `BackendConfig`.
