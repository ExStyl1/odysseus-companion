# S15 — The session-command seam: `/subtask` and `/compact` both reach the model

**The sharpest thing the re-verification found, because one arm of it is a hang a
user hits by clicking a button.**

Two findings, one root cause. The CDP wave found `/subtask` never forks; the
re-verification then found `/compact` broken the same way, **two lines above it in
the same function**.

---

## 0. What was measured

**`/subtask`** — driven live over CDP on 2026-07-30, on freshly rebuilt bundles,
with the command **selected from the palette** so the app itself inserted
`/subtask ` into the composer. Result: the log shows
`[session] Message: /subtask …` then `Calling agent.chat()`, the string `child`
appears **zero** times, `childState.children` stays `0` across five polls, no
`Forked this conversation into …` message appears, and **the model answers the
task itself**. `parseSubtaskCommand` matches that exact string in isolation.

**`/compact`** — `pi-agent.ts:6195` matches `/^\/compact(?:\s+([\s\S]+))?$/i`
against the same prefixed `trimmedMessage`. `requestCompact` has two callers: the
model's path at `:5177`, which receives a **bare** command string, and `chatImpl`
at `:6198` — the user's, unreachable. Nothing intercepts it earlier: the renderer
only adds a display badge and `packages/server-core` contains no `'/compact'`
string at all.

**So all three user entry points reach the model as prose**: the palette, the
80%-context warning button, and the pre-plan-execution compaction — **and that
last one then waits on a `compaction complete` listener for an event that will
never fire.** A user who chooses "compact before executing the plan" hangs with no
error.

**And no test exercises the `chat()` → `chatImpl` command seam at all**, which is
why two shipped commands could both be dead without a suite noticing.

---

## 1. Method rules

1. **Reproduce both arms before fixing.** Do not take § 0 on trust — a red probe
   is a hypothesis, and I retracted a false CDP pass on this very feature
   yesterday. If either does not reproduce, that is the finding; stop and say so.
2. **Find where the prefix is lost, do not paper over it.** The fix is not "also
   check for the prefix somewhere else" — that would leave two parsers and the
   next command would break the same way. Establish what reaches `chatImpl` and
   why it is not what the branch expects.
3. **Fetch any doc page with `curl -s`.** Never a summarising fetch tool.
4. **Declared ≠ enforced.** Prove each command on **Pi**, the shipped default.
5. **`rg` skips NUL-containing files silently; eight of ours have one** — use
   `grep -a` for absence claims. Before claiming something is absent, say what it
   would be called and search the concept.
6. **Two git commands** — pathspec on the `commit`; note 11c on shared files.
7. **`electron:dev` runs BOTH the host and the Pi subprocess from built bundles.**
   A source-only change is invisible to a live run until
   `bun run electron:build:servers` and a relaunch. I lost a measurement to this
   yesterday.
8. **A CDP dev instance may be running on port 9223.** Do not kill or drive it —
   start your own on another port if you need one.

---

## 2. Task 1 — one seam, both commands

**Commit:** `fix(agents): a session command reaches the session, not the model`

Find the point where the user's `/subtask …` or `/compact …` stops being a
command, and fix it there.

- **There must be exactly one place** that decides "this message is a session
  command". Two commands already broke identically; a third will be added later.
- The comment beside the `/subtask` branch states the invariant to preserve:
  "the command is an instruction to the SESSION, not a prompt, so it must not
  reach the model." Make that true rather than aspirational.
- **The model's own path must keep working.** `requestCompact`'s other caller
  receives a *bare* command string from `dispatchSlashCommand`. Do not break it
  while fixing the prefixed form — and say in the report whether the two forms now
  share one normaliser.

**Gate:** drive each command through the **real** send path and assert the
session acted: `/compact` produces a compaction, `/subtask` produces a child in
`childState.children`. Asserting that the model did *not* answer is not enough on
its own — a command that silently does nothing also fails to make the model
answer.

---

## 3. Task 2 — the hang

**Commit:** `fix(chat): the pre-plan compaction cannot wait forever`

The pre-plan-execution compaction awaits a `compaction complete` event. Task 1
should make that event fire — **prove it does.** Then make the wait unable to hang
regardless: if the event does not arrive, the user must get a stated failure, not
silence.

**A listener with no timeout is the defect independent of its cause.** Task 1
removes today's cause; this removes the class.

**Gate:** the happy path completes, and with the event suppressed the wait ends
with something the user can read.

---

## 4. Task 3 — the test that would have caught it

**Commit:** `test(agents): the session-command seam, from send to session`

From the send path to the session action, for both commands, on Pi. Both halves
had unit tests and nothing tested between them — that is exactly the shape of
every defect this audit has been finding, and it is worth naming in the test's own
comment.

Include the **model-path** case so a future fix cannot repair the user form by
breaking the bare form.

---

## 5. Gate

Focused suites for every changed file, plus the agent and session aggregates;
`bun run typecheck:all` and `apps/cli` separately; `bun run lint`;
`git diff --check`.

**Session lifecycle is a named risk trigger.** Run the expanded set once on the
final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

Expected pre-existing failures:
`docs/superpowers/specs/2026-07-29-known-failing-tests.md` — accurate on the last
four runs. Reproduce on a clean `git worktree`, never `git stash`.

**Mutation probe:** revert the seam fix and both Task 1 assertions must go red.

---

## 6. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- **Another agent may be working in `packages/shared/src/plugins/` and
  `packages/shared/src/marketplace/`.** Stay out.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 7. Report

Commit shas; **whether both arms reproduced**; where the prefix was lost and
whether one place now decides; whether the model's bare-command path still works
and how you proved it; whether the pre-plan wait can still hang; **every
correction to this plan**; and the mutation probe.
