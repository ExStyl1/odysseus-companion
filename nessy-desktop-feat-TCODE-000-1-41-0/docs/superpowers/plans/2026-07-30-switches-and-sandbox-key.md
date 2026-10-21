# W3c, W3a, W3b, W3d, P2 — the documented switches, and the sandbox key we refuse

Five new rows from step 3. Four are documented switches with zero
implementation; one is a settings key our own validator rejects. Safe mode
leads because it is a posture, not a preference.

## 0. Method rules

1. `curl -s` the pages: `https://code.claude.com/docs/en/env-vars.md`,
   `.../settings.md`, `.../model-config.md`, `.../workflows.md`,
   `.../sandboxing.md`. Quote WHOLE lines.
2. **Declared ≠ enforced.** Reproduce each absence before building — and check
   BOTH spellings (`CLAUDE_CODE_*` and `NESSY_*`), because this repo aliases
   documented names and reporting an alias-covered switch as absent would be a
   false finding. The precedent to follow for a new pair is `isCronDisabled`
   (`NESSY_DISABLE_CRON` / `CLAUDE_CODE_DISABLE_CRON`, Nessy name wins when both
   are set, values `1/true/yes/on`).
3. **NUL bytes** — always `grep -a` for absence claims.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`. Check no other
   `bun test` is running before recording a new failure.
6. CDP may be on 9223 — do not kill or drive it; do not run
   `electron:build:servers`.

---

## 1. Task 1 — safe mode (W3c)

**Commit:** `feat(config): safe mode starts a session with no third-party code`

`env-vars.md:318` — read and quote it whole. `CLAUDE_CODE_SAFE_MODE=1` starts
with **no** CLAUDE.md, skills, plugins, hooks, MCP servers, commands, agents,
themes, keybindings, status line, LSP or auto-memory — **while still applying
managed policy**. Nessy has no such switch and no `--safe-mode` flag under
either spelling.

This is the posture an incident response needs: a session that loads none of the
code a compromised plugin, skill or MCP server could have supplied, while the
organization's policy still binds. Build it as one gate, not eleven:

- **One decision point at capability resolution.** Safe mode must not be a
  scatter of `if` checks across eleven loaders — a subsystem added later would
  silently escape it. Find the single place a capability runtime is composed and
  make safe mode return the empty runtime there, then verify each of the eleven
  named surfaces is actually empty by test.
- **Managed policy must still apply.** That is the half that makes it a security
  posture rather than a debug flag: prove by test that a managed deny still
  denies under safe mode. If any policy input travels through a loader safe mode
  disables, that is the interesting case — find it and say so.
- Support both the env var and a CLI flag on `apps/cli`, per the doc.
- **State it in the UI.** A session that silently loads nothing looks like a
  broken session; the mode must be visible in the app, not only in the env.
  i18n keys in every locale, parity + sorted green.

**Gate:** under safe mode, each of the eleven surfaces resolves empty (one
assertion per surface), a managed deny still denies, and the mode is visible;
without it, nothing changes. **Mutation:** let plugins through the gate → the
plugin-empty assertion goes red.

---

## 2. Task 2 — the subagent model override (W3a)

**Commit:** `feat(agents): a subagent model env override outranks both model inputs`

`model-config.md:611` and `workflows.md:357` — quote whole. The variable
**overrides both** the per-invocation `model` parameter and the subagent
definition's `model` frontmatter; `inherit` restores normal resolution.
`resolveAgentModelId` (`pi-agent-server/src/orchestrator/spawner.ts:215`)
implements only the two lower tiers.

- Add the env tier above both, with the documented `inherit` escape.
- An unresolvable model name must fail the way an unresolvable frontmatter model
  already fails — find that behaviour and match it rather than inventing a
  second one.

**Gate:** the env value beats a per-invocation model and a frontmatter model;
`inherit` restores the existing order; unset changes nothing. **Mutation:**
drop the env tier → the override test goes red.

---

## 3. Task 3 — the bundled-skills off switch (W3b)

**Commit:** `feat(config): disableBundledSkills removes bundled skills and workflows`

`settings.md:260` / `env-vars.md:225` — quote whole: bundled skills **and**
workflows are removed entirely. Today bundled skills are seeded unconditionally
(`apps/electron/src/main/index.ts:412`) and only `NESSY_DISABLE_WORKFLOWS`
exists.

- Implement the setting so it covers both halves the doc names, and compose it
  with the existing workflows switch rather than replacing it — say in the
  report which wins when they disagree and why.
- Seeding is the interesting part: a bundled skill already on disk from a
  previous run must also be inert, or the switch only works on a fresh profile.

**Gate:** with the setting on, bundled skills are absent from the resolved
runtime **and** from a profile that already had them seeded, and workflows are
off; with it off, both behave as today. **Mutation:** leave seeding unguarded →
the already-seeded test goes red.

---

## 4. Task 4 — the non-interactive background wait (W3d)

**Commit:** `feat(agents): the non-interactive run waits for background work`

`env-vars.md:307` — quote whole: the `-p` wait for background subagents and
workflows is capped at 600000 ms by `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`.
Nessy has **neither the cap nor the wait**: generation disposal aborts every
background task (`pi-agent-server/src/index.ts:1888` →
`BackgroundTaskRegistry.drain`).

- Implement the wait for the non-interactive path only, with the documented
  default ceiling, and leave interactive teardown exactly as it is — the
  abort-on-dispose behaviour is deliberate there.
- **A wait must be unable to hang**: on the ceiling, the run ends with a stated
  outcome naming what was still running, never silence. (S15 removed exactly
  this class of defect from the pre-plan compaction; do not reintroduce it.)

**Gate:** a non-interactive run with a background task in flight waits for it
and reports it; at the ceiling it ends with a readable message; an interactive
session still tears down immediately. **Mutation:** remove the ceiling → the
timeout test hangs or goes red (assert with a bounded timer, not by waiting).

---

## 5. Task 5 — `sandbox.filesystem.disabled` (P2)

**Commit:** `feat(sandbox): the filesystem layer can be turned off explicitly`

`sandboxing.md:201`, `:317`, settings table `:365` — quote whole: it "turns the
filesystem layer off entirely while keeping network isolation". Today there is
no key in `SANDBOX_SETTING_KEYS` (`config/sandbox-settings.ts:106-113`), so
`assertKnownKeys` **rejects a conforming settings file**.

- Add the key and honour it in profile composition.
- **The coupling is the load-bearing part**: `sandboxing.md:478` says the
  settings-file deny rules hold "unless you disable filesystem isolation, which
  turns these deny rules off". So B3's `selfConfigDenyWriteRoots`
  (`server-core/src/pi-harness/isolation/self-config-deny.ts`) must switch off
  with the layer — and that means a user who sets this key gives up the
  self-config protection. Make that consequence visible where the setting is
  read, and state in the report whether anything else rides those deny roots.
- Network isolation must remain — that is the whole point of the key. Prove the
  network dimension still applies with the filesystem layer off.

**Gate:** a settings file setting the key is accepted (not rejected by
`assertKnownKeys`); with it on, a filesystem write outside the workspace
succeeds while a network denial still holds; with it off, nothing changes.
**Mutation:** keep the deny roots applied when the layer is off → the
consequence test goes red.

---

## 6. Task 6 — category strings

**Commit:** `docs(audit): what the switch and sandbox-key work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters.

### 6a. What this plan leaves

Four strings, each measured against the code as committed. Two are halves of a
task that land inside a sibling executor's zone or in a subsystem Nessy does not
have: the sandbox key's profile composition, and the four safe-mode surfaces
with no third-party loader here. Two are surfaces the tasks deliberately scoped
out — the built-in-command hiding and the managed tier for the bundled-skills
switch, and the entry points other than the CLI run.

- documented, not implemented — sandboxing.md:478 turns the settings-file deny rules off with the filesystem layer. The key now parses, resolves and reports exactly what it surrenders, but resolveProcessIsolation still composes selfConfigDenyWriteRoots unconditionally, so the layer is described as off while every deny root still binds: `sandbox.filesystem.disabled`
- documented, not implemented — env-vars.md:318 names custom themes, custom keybindings, the status line and file-suggestion commands among the surfaces safe mode must not load. Nessy has no third-party loader for any of the four: they are not capability kinds, so the single gate suppresses nothing there and the doc line is only partly met: `--safe-mode`
- documented, not implemented — settings.md:260 keeps built-in commands typable while hiding them from the model when bundled skills are off. Nessy removes the bundled skills and the workflows and stops there: no command is hidden from the model, and the managed policy key list carries no row for the setting, so an organization cannot enforce it: `disableBundledSkills`
- documented, not implemented — env-vars.md:307 caps the wait that non-interactive mode takes after the final turn. The cap and the wait now exist for nessy-general-agent run, which sets the marker the agent subprocess reads, but no other entry point sets it, and the separate five-second grace period for plain background shells is absent: `-p`

## 7. Gate

Focused suites per changed file; the config, capabilities, pi-agent-server and
`apps/cli` aggregates once on the final diff; `bun run typecheck:all` **exit 0
with zero `error TS`, stated explicitly**; `bun run lint`; i18n parity + sorted;
`git diff --check`.

**Isolation and process lifecycle are named risk triggers** — run the expanded
set once on the final diff.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.

## 8. Constraints

- You own `packages/shared/src/config/**`, `packages/pi-agent-server/src/index.ts`
  and `orchestrator/**`, `apps/electron/src/main/index.ts`, `apps/cli/**`, and
  `packages/session-tools-core/src/runtime/**`.
- **THREE SIBLING EXECUTORS run concurrently.** One owns `pi-agent.ts`,
  `mode-manager.ts`, `pre-tool-use.ts`, `permission-dsl.ts`, `pi-harness/**`,
  `SessionManager.ts`, `runtime-agent-definition.ts`. One owns
  `shared/src/mcp/**`, `auth/oauth.ts`, `agent/backend/types.ts`,
  `plugins/format-adapters/claude.ts`, `network-address-guard.ts`. One owns
  `capabilities/**`, `base-agent.ts`, `pi-agent-server/src/context-categories.ts`
  and the context overlay. **Stay out of all three.** Safe mode will want to
  reach a capability loader — if the single gate lands inside `capabilities/**`,
  coordinate by reporting the residual rather than editing.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- Do not touch `docs/superpowers/specs/` or the CDP checklist, nor
  `~/.nessy-agent/skills/r17-*` or `~/.nessy-agent/mcp/elicit-server.mjs`.
  No version bumps or release notes. Never write `~/.nessy/dp_auth_creds.json`.
- **Never run the sandbox or a sweep against the user's real config dir** —
  temp dirs you created, always. Loopback probes only.
- Code, comments and commits in English.

## 9. Report

Commit shas; each absence reproduced under BOTH spellings; safe mode's single
gate and the per-surface proof, plus what happens to managed policy; which
switch wins when `disableBundledSkills` and the workflows switch disagree; the
already-seeded case; the background wait's stated timeout outcome; what else
rides the self-config deny roots; residuals word for word; corrections to this
plan; mutation probes with which side went red; the explicit typecheck
statement.
