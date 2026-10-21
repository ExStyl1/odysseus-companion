# Prompt caching and pinning, plus the egress disclosure

Two items the owner unparked on 2026-07-30, for a release to users and testers
on **Pi and remote Nestor**.

**Task 1 is the one that matters.** Memory and the output style are re-read
every turn, so a `remember` call or a memory edit **zeroes cache reads for the
rest of the session** — and that lands on cost and latency for every user, on
every long session, on the two backends the release is for. The other three
parked rows are not on the user's path; this one is on everyone's.

**Task 2 is the cheap half of R19**, taken alone. R19 itself stays parked — the
owner's decision to leave egress open stands. What does not stand is a settings
page saying `networked: available` when "available" means unrestricted egress.

## 0. Method rules

1. `curl -s https://code.claude.com/docs/en/prompt-caching.md` and
   `context-window.md`, `sandboxing.md` for Task 2. Quote WHOLE lines.
2. **Measure, do not reason.** This task is about cache hits; a claim about
   caching that is not a measured before/after number is not a finding. Say how
   you measured.
3. **NUL bytes** — always `grep -a`; never `head -N` a grep whose hit count you
   have not counted.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`.
6. A CDP dev instance is live on **9224** and the user owns one on **9223** —
   do not kill or rebuild for either.

---

## 1. Task 1 — memory and the output style are read once and pinned

**Commit:** `fix(agents): memory and the output style are pinned, not re-read every turn`

**What exists already, so you build on it rather than beside it:**
`extendedPromptCache` (`config/storage.ts:123`) is a manual boolean that
upgrades the interceptor's `cache_control` TTL from 5m to 1h.
`buildPinnedCapabilityContext` (`base-agent.ts:846`) already composes a pinned
block once per capability generation. `packages/shared/AGENTS.md` documents the
volatile/stable split and **why Pi differs from Claude**: Pi folds only stable
blocks into the system prefix, because a per-minute re-stamp invalidates
pi-ai's cached system prefix and every downstream history entry. Read that
section before touching anything — the split is load-bearing and was a bug fix.

- **Establish the baseline first, by measurement.** Drive a session with several
  turns and record cache reads per turn; then do the same with a `remember`
  call in the middle. The claim to prove or disprove is that the second run's
  cache reads drop to zero and stay there. **If it does not reproduce, that is
  the finding — stop and say so.** This row was written from reading, not from
  a measurement.
- Pin memory and the output style to the capability generation rather than the
  turn, so a re-read happens when the content changes and not otherwise. The
  generation already moves when an instruction, rule or skill changes — check
  whether a memory edit moves it, and if not, that is the actual defect.
- **A pin must not serve stale content.** The failure mode of caching is a user
  editing a memory file and the agent continuing on the old text with no way to
  tell. Whatever invalidates the pin must be provable, and the report must say
  what a user does when they want a re-read now.
- **TTL selection:** the doc auto-selects by auth type; ours is one manual
  boolean. Decide whether to auto-select and say why — a wrong TTL costs money
  on one side and cache misses on the other, so state the trade rather than
  picking silently.
- **This is Pi and Nestor first.** Prove the improvement on the shipped default;
  the Claude backend is flag-off and its numbers do not decide this.

**Gate:** measured cache reads per turn, before and after, on Pi — with and
without a mid-session `remember`; a memory edit still reaches the model on the
next turn (assert the CONTENT, not the cache metric); the volatile/stable split
documented in `AGENTS.md` still holds. **Mutation:** unpin the memory block →
the cache-read assertion goes red.

---

## 2. Task 2 — the settings page says what `networked` means

**Commit:** `feat(settings): the isolation section states what open egress means`

R19 stays parked; this is only the disclosure half. Today
`PermissionsSettingsPage` shows `networked: available`, and "available" does not
tell an administrator that a sandboxed command can reach any host. The warning
that does exist goes to the session log only — a channel no one reads before an
incident.

- State it where the posture is shown, in the words an administrator needs:
  what `networked` grants, and that `deniedDomains`/`allowedDomains` entries are
  **not enforced** today (the resolver already names each unenforceable entry —
  reuse it rather than writing a second truth).
- Keep it factual, not alarming. This is a recorded owner decision, not a
  defect; the page should read as "here is your posture", not as a warning about
  a bug.
- i18n: keys in every locale, parity + sorted green. The playground is a design
  surface — add the states.
- **Do not change any enforcement.** If you find yourself editing a profile,
  stop: that is R19 and it is parked.

**Gate:** the isolation section states the egress posture and names any
unenforceable domain entry; no profile, rule or enforcement path changes.
**Mutation:** remove the disclosure → its test goes red.

---

## 3. Task 3 — category strings

**Commit:** `docs(audit): what the caching and disclosure work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters. At minimum the TTL decision.

### 3a. What this work leaves

Six strings. The first three are measurements: Task 1 shipped no code because
its premise did not survive contact with a running app, and what the runs found
instead is recorded here rather than discarded. The last three are what Task 2
scoped out, including the TTL decision.

- measured, not a defect — the claim that a remember call zeroes cache reads for the rest of the session does not reproduce. Memory rides the pinned block on the user-message tail, so an edit appends rather than re-stamping the prefix. Two live five-turn Pi runs on the Nessy Gateway held 32768 to 38272 cache reads per turn with and without a mid-session edit: `remember`
- documented, not implemented — prompt-caching.md:28 keeps CLAUDE.md, auto memory and unscoped rules in a project-context layer that changes only at session start, compact or clear. Ours is composed onto every user message instead, so a 3736-token memory added 4331 tokens to each turn's conversation layer where an empty one added 750: `buildPinnedCapabilityContext`
- measured, not a defect — prompt-caching.md:162 does not apply an output-style change until restart, so its cache never moves. Ours applies it on the next turn and pays once: a mid-session switch dropped cache reads from 36416 to 16384 and recovered to 37568 the turn after. Applying what the user asked for is the better trade: `outputStyleId`
- documented, not implemented — prompt-caching.md:198 auto-selects the cache TTL by auth type; ours stays one manual boolean. It only rewrites cache_control, which only the Anthropic adapter emits, and the shipped Pi and Nestor path is an OpenAI-like relay with automatic prefix caching and no cache writes, so auto-selection would bill and change nothing: `extendedPromptCache`
- documented, not implemented — sandboxing.md:321 puts the per-domain boundary behind a proxy. R19 stays parked by owner decision, so deniedDomains and allowedDomains bind nothing for a sandboxed command; the settings page now names each such entry instead of the session log alone: `sandbox.network.deniedDomains`
- documented, not implemented — the egress posture rides the startup isolation probe, which is the only caller holding resolved sandbox settings. A standalone server answering the capability RPC on demand reports no posture, and the isolation section then states availability with nothing about egress: `IsolationNetworkPostureV1`

## 4. Gate

Focused suites per changed file; the agent, config and renderer aggregates once
on the final diff; `bun run typecheck:all` **exit 0 with zero `error TS`,
stated explicitly**, plus `apps/cli`'s own typecheck (`typecheck:all` does not
cover it); `bun run lint`; i18n parity + sorted; `git diff --check`.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`,
including the `sessions.search-content.test.ts` mock leak that fails two
innocent files when it joins a run.

## 5. Constraints

- Another executor may still be finishing `pi-harness/isolation.ts`, the fork
  panel and the permission card. If a file is dirty with work that is not
  yours, **report it rather than committing it** — a pathspec commit takes the
  working tree, not your hunks, and two commits crossed that way earlier today.
- `scripts/cdp/**` is read-and-run only. `docs/superpowers/specs/` and
  `docs/testing/cdp-live-checklist.md` are planner-owned.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- No version bumps or release notes. Never write `~/.nessy/dp_auth_creds.json`.
- The app on 9224 is signed into a real corporate gateway: **never log a token,
  JWT or header value**, and never paste session content into the report.
- Code, comments and commits in English.

## 6. Report

Commit shas; **the measured cache reads per turn, before and after, with the
method stated**; whether the zeroing reproduced at all; what moves the pin and
how a user forces a re-read; the TTL decision and its trade; what the settings
page now says; residuals word for word; corrections to this plan; mutation
probes with which side went red; the explicit typecheck statement including
`apps/cli`.
