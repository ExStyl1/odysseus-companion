# S13 — A `/subtask` fork must appear in the panel

Found by the CDP wave, 2026-07-30. Evidence is in
`docs/testing/cdp-live-checklist.md`'s findings log under **AGT-2**.

**The command works and the panel never sees it.** R29b built both halves and
they do not meet.

---

## 0. What was measured, not inferred

Driven live three times, including a deliberately slow fork polled every five
seconds while it ran:

- The string `fork` appears **nowhere** in the DOM, running or finished.
- No row appears below the composer; that region holds only the composer hints,
  the mode and the model.
- `getPiHarnessRuntime(...).snapshot.childState.children` is **`0`** at every
  poll of an active fork, queried with the correct workspace and session ids.

And the fork *does* run — AGT-1 passed in the same session: the fork answered a
codeword that exists only in the parent's conversation.

The panel is not missing. `useAgentPanel` reads `childState.children`;
`PiRuntimeControlCenter` renders it; `SessionManager` builds `childState` from
`piChildSessionServices.get(key)?.snapshot()`. What is missing is the fork's
**registration** into that map.

**The likely cause is a deliberate decision from R29b's own report**, and this is
why the fix needs care rather than a quick wire-up: `/subtask` does **not** route
through the `subagent` tool, because that tool refuses `agent: "fork"` when fork
mode is off while `sub-agents.md` says the command works "with or without the
variable set". So `startSubtaskFork` calls the spawner directly — and if child
registration lives on the tool path, the direct call bypasses it.

**This is the series' recurring defect inside the unit built to remove it:**
declared on one path, enforced on another.

---

## 1. Method rules

1. **Reproduce before fixing.** Drive it yourself; do not take § 0 on trust. If
   it does not reproduce, that is the finding and you should stop and say so.
2. **Fix the registration, not the symptom.** Making the panel read a second
   source would give us two child registries to keep in step — the shape that
   caused this. One registry, both paths.
3. **Declared ≠ enforced.** Prove the row appears on **Pi**, the shipped default,
   with fork mode **off** — which is the default and the state AGT-2 failed in.
4. **Two git commands** — pathspec on the `commit`. Note 11c in the tracker: that
   is not sufficient when two agents share a file, and `SessionManager.ts` is the
   file every unit touches.
5. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md` — accurate on the
   last three runs. Reproduce on a clean `git worktree`, never `git stash`.
6. **`rg` skips NUL-containing files silently; eight of ours have one** — tracker
   note 11a; use `grep -a`.

---

## 2. Task 1 — one child registry, both paths

**Commit:** `fix(agents): a /subtask fork registers as a child session`

Make the fork appear in `childState.children` for its whole life, and disappear
when it ends.

- Find the registration seam the `subagent` tool path uses and route
  `startSubtaskFork` through it. If that is genuinely impossible — say why in the
  commit — then extract the registration so both callers share it, rather than
  duplicating it.
- The row must carry enough to be **useful**, not merely present: it is a fork
  rather than a named subagent, and it is the thing R29b's panel offers open /
  follow-up / stop on. Check what `toAgentPanelRows` needs and supply it.
- **A finished fork must not leak a row forever.** R29b's panel has a dismiss
  action; make sure a completed fork reaches whatever state that acts on.

**Gate:** an integration test that starts a `/subtask` fork and asserts a child
row exists **while it runs** and is gone or marked finished after — with fork mode
**off**, the default. A unit test over `toAgentPanelRows` proves the mapper, not
the registration, and the registration is what is broken.

---

## 3. Task 2 — the prompt that had nowhere to go

**Commit:** `fix(agents): a fork's permission prompt reaches the panel`

R29a recorded that a fork's `permission_request` is emitted with the child's
**hidden** session id and nothing renders it; R29b's Task 2 was supposed to route
it to the panel. **An unregistered fork is also an unrendered prompt**, so verify
whether this is fixed by Task 1 or still broken on its own.

- If Task 1 fixes it, say so and prove it rather than adding code.
- If not, route it — and remember R29b's own correction: `:1044` gives a
  **background named subagent** the same "prompts surface in your main session",
  so the routing is unconditional for hidden children and a fork-only gate would
  be wrong.

**Gate:** a fork that requests a permission surfaces a prompt the user can answer,
**and answering it unblocks the fork.** Assert the unblocking. A prompt that
renders and does not unblock is the same hang with a friendlier face.

---

## 4. Task 3 — pin it so it cannot regress silently

**Commit:** `test(agents): the fork panel contract, end to end`

The reason this shipped broken is that both halves had tests and nothing tested
the seam between them. Add the test that would have caught it: from the command
to the panel's data, not from either end alone.

---

## 5. Gate

Focused suites for every changed file, plus the session, agent and renderer
aggregates; `bun run typecheck:all` **and `apps/cli` separately** (it is not in
that script — two units hit this); `bun run lint`; `git diff --check`.

**Session lifecycle and permission surfacing are both named risk triggers.** Run
the expanded set once on the final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

---

## 6. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- **A Nessy Desktop dev instance may be running on CDP port 9223.** Do not kill
  it and do not drive it; it is the planner's live test bed.
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 7. Report

Commit shas; **whether § 0 reproduced**; where the registration seam was and
whether both paths now share it; whether Task 2 was fixed by Task 1 or needed its
own change; **every correction to this plan**; and the gate evidence with fork
mode off.
