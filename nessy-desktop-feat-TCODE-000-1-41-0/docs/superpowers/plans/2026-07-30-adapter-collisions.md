# Adapters against real bundles — R16 hook-id collisions, R28 rule-body delivery

Two adapter defects: **the Codex adapter rejects a conforming plugin whole
when two hook sources share an event, and the Claude backend records a rule
activation whose body never arrives.**

## 0. Method rules

1. `curl -s https://learn.chatgpt.com/docs/hooks.md` and
   `https://code.claude.com/docs/en/memory.md` (rules sections; plus any page
   R28's plan cited); quote whole lines. For Codex, remember practice and spec
   disagree — the 180-manifest catalogue is evidence too.
2. **Declared ≠ enforced.** Reproduce each defect before fixing.
3. **NUL bytes**: `grep -a` for absence claims.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** Check no other `bun test` runs
   concurrently before recording a failure.
6. CDP on 9223 — do not kill or drive it.

## 1. Task 1 — Codex hook ids carry their source (R16)

**Commit:** `fix(plugins): codex hook ids cannot collide across sources`

The challenger's mechanism, confirmed by two independent challenge runs:
`normalizeCodexHooks` (`codex.ts:1169-1204`) recurses per array element and
threads the element index into `diagnosticPath` only — never into the id.
`defaultId` is `${eventName}-${index}-${hookIndex}` (`:1240`) /
`${eventName}-${index}` (`:1252`), restarting at 0 for every source. Two
sources declaring the same event emit the identical capability id →
`normalizeNessyPluginManifest` treats a duplicate id as `error`
(`schema.ts:431-439`) → `:452` returns `{ok:false}` → the WHOLE manifest is
discarded → `install-service.ts:256-267` aborts the install, skills and MCP
servers included. Three live triggers, all conforming: two `./`-prefixed hook
path files split by concern; an inline array with the same event twice; and
the adapter's own deliberate both-default-files read (`:1156-1159`).

- Reproduce all three triggers first (they are cheap fixtures).
- Fix at id synthesis: the default id must carry a source discriminator (the
  array element index / default-file slot that `diagnosticPath` already
  knows). An EXPLICIT id colliding is still a real authoring error — keep that
  an error; only the synthesized defaults must stop colliding.
- **Id stability matters**: a hook's id feeds the trust/executable-hash record
  and user-facing enable state. A plugin with ONE hook source must keep its
  pre-fix ids (no re-prompt for every installed plugin). State in the report
  what id shape single-source plugins get and prove it unchanged against an
  existing fixture.
- Sweep the catalogue-derived fixtures: do any real plugins hit the collision
  today?

**Gate:** all three trigger fixtures import with every hook present and
distinct ids; a single-source fixture's ids are byte-identical to pre-fix; an
explicit duplicate id still errors. **Mutation:** drop the discriminator → the
two-file fixture test goes red.

## 2. Task 2 — the activated rule's body arrives on Claude too (R28)

**Commit:** `fix(rules): a path-scoped rule's body reaches the Claude backend`

From the re-verification: on the Claude backend an activated path-scoped
rule's body is queued and dropped — the delivery hop exists only in
`pi-agent.ts`. The activation IS recorded once-per-generation and an
`InstructionsLoaded` event fires with `load_reason: 'path'` — so telemetry
says the rule loaded while the model never saw it. The exact queue/consumer
names are in the rules runtime (find them from `pi-agent.ts`'s hop; `grep -a`).

- Reproduce on the Claude backend path (unit-level is fine: drive the shared
  rules runtime with a claude-agent consumer stub and show the queue drains
  nowhere).
- Deliver through claude-agent.ts's existing per-turn context channel — the
  same seam its other context blocks use; do not invent a second delivery
  mechanism. Mind the backend split documented in `packages/shared/AGENTS.md`
  (Claude keeps blocks on the user-message tail).
- The once-per-generation recording and the event must now be TRUE on both
  backends — if the Claude flag build cannot be exercised, prove at the seam
  (the queue has a consumer on both paths) and say exactly what live proof is
  owed.

**Gate:** the queued body reaches the Claude consumer (seam test); Pi behavior
unchanged (its existing rule-delivery tests stay green). **Mutation:**
disconnect the Claude consumer → the seam test goes red.

## 3. Task 3 — category strings

**Commit:** `docs(audit): adapter surfaces left open`

Unwrapped, unbolded, backtick-terminated, no inline backticks, under 400 chars.

Recorded at execution (2026-07-30). Both fixes landed — all three Codex
collision triggers import whole with the first source's ids byte-identical to
pre-fix, and the Claude backend consumes the pending rule body on the same
additional-context seam Pi uses. What stays open:

The Claude flag build was not run:

`partial — the R28 delivery hop on the Claude backend is proven at the unit seam only: the queued body joins the PreToolUse additionalContext beside the steer message and the disconnect mutation goes red, but the Claude provider flag build was not exercised, so a live flagged session showing the rule body inside a Claude turn is still owed`

The denied-trigger drop window, shared with Pi:

`partial — on both backends the consumed rule body only rides an allowed, modified or approved call: a user denying the very prompt that activated the rule drops the body after InstructionsLoaded already fired, and the once-per-generation key stays burned until compaction; the Claude hop mirrors the shipped Pi shape deliberately instead of inventing a second channel`

The collisions that still reject a Codex manifest whole:

`kept as an error — a Codex hook author writing an explicit id equal to another source's synthesized default, or nesting arrays until two slot composites coincide, still rejects the whole manifest through the duplicate-id diagnostic; only synthesized defaults slot away from collisions, because rewriting an explicit id would detach the trust record it keys`

## 4. Gate

Focused suites per changed file; plugins/format-adapters aggregate + rules
runtime suites once on the final diff; `bun run typecheck:all`;
`bun run lint`; `git diff --check`. Known-failing list as before; clean
`git worktree` for reproduction.

## 5. Constraints

- You own `packages/shared/src/plugins/**` (format-adapters, schema,
  install-service tests), `packages/shared/src/agent/claude-agent.ts`, and the
  rules runtime files their fix needs. Two sibling executors run elsewhere:
  (pi-agent.ts / pre-tool-use.ts / SessionManager.ts / permission-service.ts)
  and (pi-agent-server/src) — STAY OUT. If the rules runtime hop forces a
  `pi-agent.ts` edit, report it as a residual instead.
- One commit per task, subjects exactly as given. No `Co-Authored-By`. No
  push/MR/tags/reset/rebase/--amend/`checkout --`/stash. Mutations restored by
  re-edit or `.orig`, never git.
- No `docs/superpowers/specs/` or checklist edits; no version bumps; never
  write `~/.nessy/dp_auth_creds.json`; never install or execute a plugin
  fetched from the network — fixtures only.
- Code, comments and commits in English.

## 6. Report

Commit shas; the three collision triggers reproduced; the id shape decision
and the single-source stability proof; the Claude delivery seam chosen and the
Pi-unchanged evidence; what live proof remains owed; corrections; mutation
probes with sides.
