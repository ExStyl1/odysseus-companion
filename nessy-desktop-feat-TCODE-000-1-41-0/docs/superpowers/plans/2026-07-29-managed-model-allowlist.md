# S6 — Make the managed model allowlist enforce something

From the phase-4 sweep (`2026-07-29-phase4-findings.md`, `model-config.md`).

**An administrator who deploys a managed model allowlist today gets a policy that
loads without error, emits no drop diagnostic, and enforces nothing.** That is
worse than an unimplemented setting, because they have positive evidence the
restriction took.

---

## 0. Method rules

1. **Fetch the pages yourself** with `curl -s`
   (`https://code.claude.com/docs/en/settings.md`,
   `https://code.claude.com/docs/en/model-config.md`). Never a summarising fetch
   tool — it invented field names twice in this series and both shipped.
2. **The quotation is the identifier, not the line number.** Report the line you
   found each quoted sentence at.
3. **Read around each quotation.**
4. **Declared ≠ enforced.** This unit exists because two resolvers have zero
   production callers. Do not add a third.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. That list has been
   short twice running, so still reproduce anything you call pre-existing on a
   clean `git worktree` at your base commit. Never `git stash`.

---

## 1. State

`availableModels` and `enforceAvailableModels` are parsed, validated,
fail-closed-on-invalid and unit-tested in
`packages/shared/src/agent/pi-harness/managed-policy.ts`. Their resolvers —
`isManagedModelAllowed` and `resolveManagedDefaultModel` — have **zero
production callers**; only the policy's own test file invokes them.

**A previous unit already costed this and named the hazard**, in
`2026-07-29-deviation-unit-4.md` item 5. Read it before you design anything. Its
conclusion, which this plan adopts:

> The catalog choke point is `getLlmConnections()`'s `connection.models`, which
> every selector and every server-side helper (`getMiniModel`,
> `getSummarizationModel`, `resolveGatewayFastModelId`) reads; filtering there
> would round-trip through `updateLlmConnection` — which rebuilds connections
> from a hardcoded allowlist — and **permanently destroy a user's model list**.

So: **filter at the read boundary that feeds the UI and the session model
authority, never at the persistence boundary.** A managed policy must not be able
to delete a user's stored configuration; when the policy is withdrawn, the user's
models must come back.

---

## 2. The contract

Quote by text, report the lines:

- `settings.md`'s `availableModels` row — what the allowlist governs.
- `settings.md`'s `enforceAvailableModels` — that it extends the allowlist to the
  **Default** model. (`whats-new/2026-w24.md` records it as new: "makes the
  `availableModels` allowlist also constrain the Default model".)
- `settings.md`'s invalid-value semantics for these keys — the pair the parser
  already implements; confirm the enforcement side agrees with the parse side.
- The tiers `settings.md` names alongside the allowlist — subagent, skill and
  any advisor/mini tier. A restriction the composer honours and a subagent
  ignores is not a restriction.

---

## 3. Tasks

### Task 1 — filter at the read boundary

**Commit:** `feat(managed): the model allowlist narrows what a session can select`

Apply `isManagedModelAllowed` where the catalog is **read**, not where it is
stored. Requirements:

- **Nothing may write a narrowed list back.** Prove it: apply a policy, restart,
  withdraw the policy, and assert the user's original model list is intact. This
  is the single most important test in the unit — the named hazard is permanent
  data loss.
- Cover the **session model authority**, not just the picker. A model the user
  cannot select but the session can still resolve to is the declared-versus-
  enforced split again.
- An **empty** `availableModels` and an **absent** one are different. Follow
  whatever the parse side already decided and say what that is.
- Decide, and state, what happens when the session's **current** model is no
  longer allowed — a policy can arrive mid-session through the delivery path
  R25b built. Silently switching models mid-conversation and refusing to run are
  both defensible; silently continuing on the forbidden model is not.

**Gate:** a differential table — enumerate the model-resolution entry points you
found, and report which ones moved and which did not. "It works" is not the
deliverable.

---

### Task 2 — `enforceAvailableModels` and the other tiers

**Commit:** `feat(managed): the allowlist reaches the default model and the delegated tiers`

- `enforceAvailableModels: true` extends the allowlist to the Default model.
- The subagent, skill and mini/advisor tiers named in `settings.md`. Our
  equivalents include `tierModelMap` on the orchestrator config, `getMiniModel`
  and `getSummarizationModel`. **Report which of these an admin can currently use
  to reach a forbidden model**, then close them or record each as a category
  string with its reason.
- `resolveManagedDefaultModel` is the other zero-caller resolver; this is where
  it acquires one, or where you say why it should be deleted instead. **A
  resolver with no caller is the defect this audit is named after — do not leave
  a second one behind.**

**Gate:** one case per tier, each proving a forbidden model is refused there.

---

### Task 3 — say so when it bites

**Commit:** `feat(managed): tell the user when the model allowlist refuses`

A refusal the user cannot explain becomes a support ticket that reads "the app
broke". Whatever surface refuses — picker, session start, subagent spawn — must
say the model is restricted by managed policy, without leaking the policy's
contents beyond the model id in question.

`nessy-general-agent doctor` (R30b) should show the active allowlist as part of
the managed-source report. Reuse its existing rendering rather than adding a
second one.

Add i18n keys to **all** locale files and keep `lint:i18n:parity` and
`lint:i18n:sorted` green.

---

## 4. Gate

Focused suites for every changed file; the managed-policy, config and session
aggregates; `bun run typecheck:all`; `bun run lint`; `bun run lint:i18n:parity`;
`bun run lint:i18n:sorted`; `git diff --check`.

Named risk trigger in `AGENTS.md`: this is managed policy plus session
authority. Run the expanded set once on the final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe:** with the filter removed, the forbidden-model tests must go
red — including the delegated tiers, not only the picker.

---

## 5. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- Another agent may be working in `packages/shared/src/sessions/file-checkpoints.ts`
  — stay out of it.
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Never log a policy payload, token or credential.
- Code, comments and commits in English.

## 6. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; the Task 1 differential table; the tiers you found and what each does
now; proof that withdrawing the policy restores the user's model list; the
category strings; and the mutation probe.
