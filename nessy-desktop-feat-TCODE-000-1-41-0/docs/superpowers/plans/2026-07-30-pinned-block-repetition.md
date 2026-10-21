# L3 — the pinned block is paid for on every turn

**Measured, not argued.** With a 3736-token session memory,
`conversation_messages` grew by **4331 tokens on every turn** (4325 → 8656 →
12987 → 17318) while the assistant produced ~40 tokens per turn. With no memory
the same sessions grew ~750/turn. The pinned capability block is re-composed
into **every user message** instead of being sent once.

`prompt-caching.md:28` puts CLAUDE.md, auto memory and unscoped rules in a
**project-context layer that changes only at session start, `/clear` or
`/compact`** — sent once, cached thereafter.

This is cost and latency on every long session with memory, on **both shipped
backends**. It is not a correctness bug: the content is right, it is sent again.

## 0. What you must read before touching anything

1. **`packages/shared/AGENTS.md`, the volatile/stable context split.** Pi folds
   only STABLE blocks into the system prefix because a per-minute re-stamp
   invalidates pi-ai's cached system prefix and every downstream history entry
   (issue #862). That split is load-bearing and was itself a bug fix. **Whatever
   you build must keep it true**, and the report must say how you proved it.
2. `buildPinnedCapabilityContext` / `composePinnedCapabilityContext`
   (`base-agent.ts:846`, `:871`) and its call site in `chat()` (`:2674`).
3. `curl -s https://code.claude.com/docs/en/prompt-caching.md` and
   `context-window.md`. Quote WHOLE lines.

**Two hazards live inside this builder and neither may be broken:**

- **Compaction re-injection.** After a compaction the pinned content has to be
  present again; a naive "send once per session" loses it exactly when the model
  needs it most. Establish what compaction does today before changing anything.
- **A permission-handoff side effect.** `buildVolatileContextParts` consumes a
  one-shot mode-change signal and `AGENTS.md` warns it must be called **exactly
  once per turn**. Find every consumer of that kind inside the pinned path
  before you move a call.

## 1. Method rules

1. **Measure, do not reason.** This is a cost defect; the only proof is
   tokens-per-turn before and after, on Pi, against the real gateway. **Use a
   positive control** — the refuted row that produced L3 was only trustworthy
   because an output-style change on the same rig moved the number. Say what
   your control was.
2. **Declared ≠ enforced.** Prove on Pi, the shipped default.
3. **NUL bytes** — always `grep -a`; never `head -N` a grep whose hit count you
   have not counted.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.**
6. CDP instances are live on **9223 and 9224** — do not kill or rebuild for
   either. `scripts/cdp/**` is read-and-run only.

## 2. Task 1 — the pinned block is sent once per generation, not per turn

**Commit:** `fix(agents): the pinned capability block is sent once, not re-sent every turn`

- Send it once and let the cache hold it, re-sending only when the generation
  moves or a compaction has dropped it. The generation already moves on an
  instruction, rule, skill or memory change — **verify that rather than assuming
  it**, because the whole value depends on it.
- **A user must never see stale pinned content.** Today a memory edit reaches
  the model on the next turn and that is BETTER than upstream (which waits for
  `/clear`, `/compact` or a restart) — measured with a codeword. **Do not
  regress it.** Whatever you build must keep the next-turn freshness and stop
  the repetition; if those two genuinely conflict, say so and choose freshness.
- Watch the interaction with history: a block sent once lives in the transcript
  at one position. Establish what a resume, a rewind and a compaction each do to
  it.

**Gate:** measured tokens-per-turn on Pi with a real memory, before and after —
the per-turn growth must fall to roughly the no-memory baseline; a memory edit
still reaches the model on the next turn, asserted on CONTENT with a codeword,
not on a token count; a compaction leaves the content present. **Mutation:**
re-send every turn → the token-growth assertion goes red.

## 3. Task 2 — category strings

**Commit:** `docs(audit): what the pinned-block work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters. At minimum: whatever you could not make cache-stable, and
the compaction behaviour you found.

### 3a. What this work leaves

Seven strings. Task 1 made the block cache-stable on Pi only; the first three
say why the other three backends were left alone, and the last three are what
the runs found beside the defect.

- shipped, backend-scoped — Pi confirms delivery at its prompt send and pays for the block once; Nestor Cloud is left re-sending it every turn because the conversation lives on the remote agent under a context id this process cannot inspect, and the store that would reveal a reset conversation is loaded inside chatImpl, after the block has already been composed: `NestorCloudContextStore`
- documented, not implemented — Codex is left re-sending because a permission-mode change tears its thread down and starts a new one with no history, and the teardown decision is taken after the turn was composed, so a once-sent block would be lost with no signal that it had been: `pendingModeRestart`
- documented, not implemented — Claude is left re-sending because its four fresh-session recovery sites null the sdk session id inline instead of going through the one seam that forgets a delivered block, so the latch would go stale against an empty transcript. Provider is off by default at build time: `onSdkSessionIdCleared`
- measured, not a defect — a resume pays for one extra copy. The latch is per agent object, so a new process re-sends the block into a conversation Pi restores from its own session file. Bounded to once per app start against 4331 tokens per turn, and it fails toward the model having the user instructions: `pinnedCapabilityContextSentGeneration`
- defect, not fixed here — an RPC-driven compaction never runs the post-compaction reset on Pi. The typed slash form and the model dispatch both resolve through a compact result message, not the raw event stream the reset hangs off, so path-scoped rules and seen sources survive a manual compact that summarised them away: `resetPrerequisiteState`
- defect, not fixed here — no production caller clears history on any backend, and the slash form is not a session command, so it reaches the model as prose inside a fully composed turn. Nothing truncates the remote context id, the Pi session file or the codex thread: `clearHistory`
- measured, not verifiable here — the after number could not be taken on the live rig. The instrumented app runs a built bundle and rebuilding it was out of scope, so the gate was met with the production estimator on the production composition path plus the counters the defect run already persisted: `refreshContextUsage`

## 4. Gate

Focused suites per changed file; the agent and capabilities aggregates once on
the final diff; `bun run typecheck:all` **exit 0 with zero `error TS`, stated
explicitly**, plus `apps/cli` separately; `bun run lint`; `git diff --check`.

**Context composition is where issue #862 came from** — treat it as a risk
trigger and run the expanded set once on the final diff.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.

## 5. Constraints

- The tree should be quiet. If a file is dirty with work that is not yours,
  **report it rather than committing it** — a pathspec commit takes the working
  tree, not your hunks.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- `docs/superpowers/specs/` and `docs/testing/cdp-live-checklist.md` are
  planner-owned. No version bumps. Never write `~/.nessy/dp_auth_creds.json`.
- The app on 9224 is signed into a **real corporate gateway** and every measured
  turn costs money: keep the runs short, and **never log a token, JWT or header
  value**. Do not paste session content into the report.
- Code, comments and commits in English.

## 6. Report

Commit shas; **tokens per turn before and after, with the method and the
positive control stated**; what moves the generation, verified not assumed;
whether next-turn freshness survived, proven on content; what a resume, a rewind
and a compaction each do to a once-sent block; how you proved the volatile/stable
split still holds; residuals word for word; corrections to this plan; the
mutation probe; the explicit typecheck statement including `apps/cli`.
