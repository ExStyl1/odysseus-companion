# R29b — The fork surface

Parity row **R29**, second and final slice. R29a built the engine; nothing lets a
user reach it, and three later units routed fork-shaped findings here.

---

## 0. Method rules

1. **Fetch the pages yourself**: `curl -s https://code.claude.com/docs/en/sub-agents.md`,
   and `output-styles.md` for Task 4. Never a summarising fetch tool — it
   invented field names twice in this series and both shipped.
2. **The quotation is the identifier, not the line number.** Report where you
   found each. **Read the whole line before concluding a sentence is gone** — the
   last executor reported a sentence removed when it was the second half of the
   line it quoted as replacing it, and I overturned that on a re-fetch.
3. **Read around each quotation.**
4. **Declared ≠ enforced.** Prove each on **Pi**, the shipped default.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. It has been short
   three times and wrong once in the other direction, so reproduce anything you
   call pre-existing — and if a failure reproduces in a worktree but passes in
   the repository, say so rather than filing it.
7. **`rg` silently skips files containing a NUL byte; eight of ours have one** —
   tracker method note 11a. Use `grep -a` for absence claims over
   `sessions/mirror/*`, `handlers/rpc/capabilities.ts`,
   `agent/memory/rule-matching.ts`.

---

## 1. What exists and what does not

R29a shipped: the `fork` agent type, inheritance through a session branch (the
fork takes the parent's session file untrimmed, because anchoring at the last
message would cut at a dangling tool call), the parent tool pool, the depth and
no-nested-fork rules, a fail-loud degradation path, and the `NESSY_FORK_SUBAGENT`
gate with its background interaction. Its close-out is in the tracker's R29 row.

Missing, and the reason this slice exists:

- **No user-facing way to start a fork.** `sub-agents.md` documents `/subtask`.
- **No panel.** The page documents a row per running fork below the prompt, with
  keys to open a transcript, send follow-ups, dismiss or stop.
- **`:1043` — a fork's permission prompts have nowhere to surface.** R29a found
  the `permission_request` is emitted with the child's *hidden* session id and
  nothing renders it. Recorded then as `not implemented, no surface`; the surface
  is this slice.

Routed here by later units, each already verified by whoever found it:

- **S7 (rewind):** a Pi child — fork included — is its own session with its own
  `sessionPath`, so a parent's rewind never reaches it. Correct for a named
  subagent, **wrong for a fork**, which by contract shares the parent's
  conversation.
- **S10 / the phase-4 sweep (output styles):** a fork inherits the output style,
  which is right, but **so does every named subagent**, which the docs say should
  not. One gated read.
- **R29a `:1041`:** `getSystemPrompt` forwards `sessionId` to
  `loadMemoryPromptBlock`, so a parent with per-session memory has a prefix the
  fork lacks — a divergence from "same system prompt" that must be fixed before
  any prompt-cache-sharing claim is meaningful.
- **R29a `:1048`:** `isolation: "worktree"` has no call-site parameter. R29a
  confirmed the R30c policy-mismatch throw is *not* in the way; only the request
  path is missing, costed at about half a day.

---

## 2. Tasks

### Task 1 — a user can start a fork

**Commit:** `feat(agents): a slash command that forks the conversation`

Implement the documented command. Establish its **name** from the page rather
than from this plan — the page records a rename, and `whats-new/2026-w29.md`
describes `/fork` and `/subtask` diverging into two different things. Getting
which-is-which wrong would ship the opposite feature.

Whatever we call it, the behaviour to match is the in-session forked subagent:
it inherits the conversation, runs alongside, and returns its result into the
main conversation.

**Gate:** drive the command through the real session path and assert a fork
child was created — not a named subagent, not a new top-level session.

---

### Task 2 — watch it, steer it, stop it

**Commit:** `feat(agents): running forks are visible and steerable`

The panel. The child port already has `attach`, `steer`, `searchOutput`,
`monitor` and `stop`, so this is largely a surface over machinery R29a and
earlier units built — check before you build.

- A row per running fork, plus the main session.
- Open a fork's transcript and send it follow-up messages.
- Dismiss a finished fork; stop a running one.
- **Route `:1043`'s permission prompts here.** A fork that blocks on a permission
  nothing renders is a hang with no explanation, and that is the single most
  user-visible consequence of shipping R29a without this slice.

The docs give terminal key bindings. We are a desktop app; map the *capabilities*
rather than the keystrokes, and say what you mapped them to.

**Gate:** a fork that requests a permission surfaces a prompt the user can answer,
and answering it unblocks the fork. Assert the unblocking, not just the render.

---

### Task 3 — the three routed defects

**Commit:** `fix(agents): a fork shares the parent's rewind, memory and style scope`

- **Rewind reaches a fork.** A fork shares the parent's conversation, so a rewind
  of the parent must reach the fork's file changes. Decide carefully what happens
  to a *running* fork when its parent rewinds — stopping it is defensible,
  silently leaving its edits is not.
- **Output style stops reaching named subagents.** One gated read; the gate is
  "is this a fork".
- **Per-session memory reaches the fork.** So that "same system prompt" is true
  rather than nearly true.

Each of these was found by a different unit and each is small. They are one
commit because they are one property: **a fork is inside the parent's scope, a
named subagent is outside it.** If any one of them turns out not to reproduce,
say so and drop it rather than inventing work.

**Gate:** one test per defect, each asserting the fork and the named subagent
land on *opposite* sides. A test that only checks the fork proves half the rule.

---

### Task 4 — `isolation: "worktree"`, and the rows that stay open

**Commit:** `feat(agents): a fork can request worktree isolation`

Add the call-site parameter R29a costed. If it turns out larger than half a day,
stop and record it instead — an honest costed gap beats a half-wired one.

Then category strings for what R29 leaves, including `:1046`'s prompt-cache
sharing, which R29a recorded as `not implemented, unmeasured` because our
gateway's cache accounting was unknown. **Say whether that is now measurable**;
if it is, measure it, and if it is not, say what would make it so.

**Write the strings unwrapped, unbolded, and backtick-terminated**, then confirm:
`python3 scripts/regenerate-deviation-register.py | grep -i fork`. The generator
has lost rows to soft-wrapping, to `**emphasis**`, and to an unterminated bullet
swallowing the next one.

---

## 3. Gate

Focused suites for every changed file, plus the agent, session and renderer
aggregates; `bun run typecheck:all`; `bun run lint`; `bun run lint:i18n:parity`
and `:sorted` if you add strings; `git diff --check`.

This touches **session lifecycle and permission surfacing** — both named risk
triggers. Run the expanded set once on the final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe** for Task 3: revert the fork gate and the opposite-sides tests
must go red on both sides.

---

## 4. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- i18n keys in **all** locale files.
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 5. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; the command name you established and from what; what you mapped the
panel key bindings to; which of the three routed defects reproduced; the
prompt-cache measurability answer; the category strings with proof they appear in
the register; and the mutation probe.

---

## 6. What R29 leaves, after R29b

Verified against `sub-agents.md` and `output-styles.md` fetched with `curl` on
2026-07-29 and against the tree at `29a70d6b`, not copied from R29a's close-out.
Each string is one physical line and is wrapped in backticks, because the
register's category pattern reads up to the next backtick or pipe: an unwrapped
bullet with no terminator swallows the bullet after it and two rows become one.

R29a's own rows are not restated here. The four that this slice CLOSED are, for
the record: `:1043` permission surfacing (Task 2), `:933`'s exclusion half and
`:1041`'s session-memory divergence (Task 3), and `:1048`'s missing call-site
parameter (Task 4). The three R29a recorded and this slice does not reopen —
`:324`'s background tool filter, `:326`'s withholding for non-forks, and
`:324`'s one-entry always-removed list — are unchanged and already in the
register under `plans/2026-07-29-fork-subagents.md`.

### The prompt cache

- `documented, not implemented — sub-agents.md:1046 says a fork's first request reuses the parent's prompt cache. Now MEASURABLE where R29a could not measure it: pi-ai's openai-completions adapter maps prompt_tokens_details.cached_tokens (or prompt_cache_hit_tokens) to cacheRead, and our Pi event adapter surfaces it as cacheReadTokens. The number exists end to end; two things still block a result, and neither is code we own`
- `documented, not implemented — the first blocker is credentials: the number needs one live turn per arm, forking and spawning a named subagent from the same parent and comparing each first request's cacheRead. The offline harness stubs the provider. The second is the gateway, which must populate cached_tokens on an OpenAI-compatible response; if it reports nothing the arms must run against an Anthropic-shaped connection`
- `documented, not implemented — one precondition R29a named is now satisfied rather than outstanding: the session-memory divergence that broke prefix identity for any parent with session memory is fixed, so a cache-sharing measurement would at last be measuring the thing the row describes. Cost is a live-credential probe of about half a day, most of it establishing whether the gateway reports cache tokens at all`

### The command that is not ours

- `documented, not implemented — sub-agents.md:997 and :895 make /fork a DIFFERENT feature since v2.1.212: it copies the whole session into a new background session with its own budget, while /subtask is the in-session fork this slice shipped. We have no background-session surface for a conversation to be copied into. Branching a session exists in the UI, but it produces an ordinary visible session, not a detached run`
- `documented, inapplicable — sub-agents.md:997 adds that when agent view is turned off, /subtask is not available and /fork starts the forked subagent instead. That is a fallback for a toggle we have no counterpart to; there is no agent-view setting here, so /subtask is unconditional and the substitution has nothing to trigger it`

### The panel's remaining rows

- `documented, not implemented — sub-agents.md:1019 says the fork's result arrives as a message in your main conversation. A model-spawned fork's result does return through its tool call, but a /subtask fork has no owning tool call, and the session event union has no append-an-assistant-message event; user_message is the only one. Its output is readable in the panel instead. One event type plus a renderer handler, about a day`
- `documented, not implemented — sub-agents.md:1032 says that with an agent's transcript open, typing /model or /fast shows a notice that it changes the main conversation rather than the viewed agent. The panel's follow-up field sends a steer and parses no slash commands at all, so there is nowhere to put the notice and no silent misapplication to warn about. It becomes real only if that field grows command handling`
- `documented, not implemented — sub-agents.md:1032 also routes skills typed into an open transcript to that agent while built-in commands stay in the main conversation. Our follow-up field is a plain steer message: a skill reference reaches the child as text, and the child invokes skills through its own inherited tools. Splitting the two needs the composer's skill resolution behind the panel input, half a day`

### Where a fork's prompts surface

- `documented, impossible on Pi — sub-agents.md:1044 says a fork's permission prompts surface in your terminal. There is no terminal here. The nearest equivalent shipped is this slice's routing: the prompt is filed under the visible ancestor conversation and rendered there with the asking agent named, which is what :770 and the named-subagent half of :1044 ask for, and answering it unblocks the child`
