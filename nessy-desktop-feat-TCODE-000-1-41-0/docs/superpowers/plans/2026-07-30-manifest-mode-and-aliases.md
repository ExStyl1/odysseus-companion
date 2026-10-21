# R1, R21, R27 — the manifest, the plan-mode route, the alias table

Three of the last five reopened rows. Shared shape: **a decision is made
correctly and then not carried to the surface that had to hear it.**

## 0. Method rules

1. `curl -s` the pages — `permissions.md`, `permission-modes.md`,
   `auto-mode-config.md`, `hooks.md` (SubagentStop section). Quote whole lines;
   read the WHOLE line.
2. **Declared ≠ enforced.** Reproduce each defect before fixing. Prove on Pi.
3. **NUL bytes** — always `grep -a` for absence claims.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`.
6. CDP may be on 9223 — do not kill or drive it; do not run
   `electron:build:servers`.

## 1. Task 1 — a denied tool leaves the manifest (R1)

**Commit:** `fix(permissions): a bare-name deny removes the tool from the manifest`

`permissions.md:82` and `:142`: a deny rule naming a tool without a specifier
removes it from what the model is offered. Ours denies at the gate
(fail-closed, so nothing unsafe runs) but **leaves the schema in the model's
context**, so the model keeps attempting a tool it can never use — burning a
turn and context on every attempt. The forms that must remove: `deny Bash(*)`,
`deny mcp__*`, `deny mcp__server__*`, `deny mcp__server__tool`.

- The removal happens where the manifest is composed, not at the gate. Read how
  deferred-tool filtering already drops tools there (S14 built that seam) and
  reuse it — do not add a second filter.
- **A composition-dependent manifest is a hazard**: `PI_STATIC_MODEL_CONTRACT_HASHES`
  pins tool shapes, and S14 established that changing which tools are *present*
  is safe while changing any tool's *shape* is not. State explicitly in the
  report that no pin changed, and run the harness-contract pin suites.
- Second half of the row, separately verified by the challenger: **the `/path`
  settings-source anchor is parsed and then dropped by every permission-rule
  consumer** — one of the four anchors the row claims. Either enforce it or
  record it as a category string with the reason; do not leave it parsed-and-ignored.

**Gate:** with `deny Bash(*)` the advertised manifest has no Bash tool and the
gate still denies (both, not either); a specifier'd deny like `deny Bash(git *)`
leaves the tool present. **Mutation:** drop the manifest filter → the
absent-from-manifest test goes red.

## 2. Task 2 — plan mode routes to the classifier (R21)

**Commit:** `feat(permissions): plan mode routes shell commands to the classifier`

The whole line below is the anchor; the number is a convenience and is the
2026-08-23 fetch's `permission-modes.md:240` (this row's original `:156` is a
VS Code UI-label table row there). Whole line: "When auto mode is available and the
`useAutoModeDuringPlan` setting is on, which it is by default, the classifier
reviews shell commands during planning instead of prompting you. Approved
commands run, and rejected ones are blocked. Otherwise, commands outside the
built-in read-only set prompt for approval."

Ours does neither: `mode-manager.ts:2138-2170` blocks a non-read-only Bash
command **outright** in plan mode (`allowsPlanAndDataWrites = mode === 'safe'`),
and `useAutoModeDuringPlan` has zero occurrences under any name. The deviation
is recorded only in a plan file, not in the row.

- Build the setting and the route: in plan mode, a command outside the
  read-only set goes to the classifier when auto mode is available and the
  setting is on; otherwise it **prompts** rather than being blocked outright —
  the doc's "Otherwise" branch is also missing today.
- **The guardian consult was just narrowed** (`pi-agent.ts`, `8c2990ad`): a
  non-negotiable prompt never reaches the judge. Your plan-mode route must
  respect that — a floor in plan mode still reaches the human.
- Default the setting on, as documented, and make it settable the same way the
  neighbouring permission settings are.
- The `auto-mode` CLI subcommands (`auto-mode-config.md:246-266`) are a
  separate surface — record a category string, do not build them here.

**Gate:** in plan mode with the setting on, a non-read-only command is
classified (approved runs, rejected blocks); with it off, it prompts; a
read-only command is unaffected; a non-negotiable floor still prompts.
**Mutation:** force the setting off in the route → the classified test goes red.

## 3. Task 3 — the alias table and the SubagentStop payload (R27)

**Commit:** `fix(agents): cron tools alias and SubagentStop carries its documented fields`

Two defects, both created by R27's own later halves:

1. `CronCreate`/`CronList`/`CronDelete` have **no `PI_RUNTIME_AGENT_TOOL_ALIASES`
   entry**, so an imported Claude agent naming one in `tools` is rejected
   WHOLE — exactly the failure mode the comment at
   `runtime-agent-definition.ts:60-63` exists to prevent. R27b shipped three
   model-facing tools with Claude's spellings *after* R27a added the aliases and
   did not apply its own lesson. **Sweep for any other tool added since that
   lacks an alias** — the recurring shape is what matters, not these three.
2. `SubagentStop` carries 2 of its 5 documented fields. `hooks.md` (the
   SubagentStop section, quote it whole): the event receives `stop_hook_active`,
   `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`.
   `SessionManager.executePiChildTerminalAutomation` (~`:5371`) supplies
   `agent_id`, `agent_type`, `background_tasks`, `session_crons`.
   **`stop_hook_active` is computable two lines away** — the SubagentStop streak
   is recorded at `:5391` via `recordHookBlockFeedback`, and the same counter
   already feeds `Stop`. `agent_transcript_path` exists repo-wide only inside a
   `debug()` string on the off-by-default Claude backend.
   `last_assistant_message` is not produced for SubagentStop at all.

- Supply all five. If one genuinely cannot be produced on Pi, say which and
  why, and record a category string — but `stop_hook_active` has no such excuse.

**Gate:** an imported Claude agent declaring `tools: ['Read', 'CronList']`
loads; a SubagentStop hook receives all five fields with `stop_hook_active`
true after a blocked stop. **Mutation:** remove the alias entry → the agent-load
test goes red.

## 4. Task 4 — category strings

**Commit:** `docs(audit): what the manifest, mode and alias fixes leave open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 chars.

### 4a. What this plan leaves

Four strings, each measured against the code as committed. Two are decisions
these tasks made and had to record rather than build: the settings-source anchor,
which needs a directory no permission-rule layer carries, and the imported-agent
names with no Pi counterpart, which still cost the whole agent. Two are surfaces
the tasks deliberately scoped out — the classifier's CLI subcommands, and a
control for the setting Task 2 introduced.

- documented, not implemented — permissions.md:281 anchors a single-leading-slash path rule at the directory of the settings source that defines it, and :288 maps five scopes onto five directories. Nessy drops such a rule from every permission-rule layer, because the layer input carries no settings-source directory and compiling one without a root fails the whole layer closed: `/path`
- documented, not implemented — auto-mode-config.md:246 gives the classifier three CLI subcommands: defaults prints the built-in rule lists as JSON, config prints the effective merged config, and reset removes the autoMode section from user settings. Nessy resolves those sets into the judge prompt and has no surface that prints or resets them: `auto-mode`
- documented, not implemented — tools-reference.md names tools Nessy has no counterpart for, and an imported Claude agent listing one in tools is rejected whole rather than losing that one tool, because the resolver throws on a name with no alias entry. The documented names that do have a Pi counterpart now resolve; Skill, EnterPlanMode, TaskOutput and the rest still throw: `tools`
- documented, not implemented — permission-modes.md:240 makes useAutoModeDuringPlan a user setting that is on by default. Nessy reads it from the stored config and honours it in the plan-mode route, and it has a getter and setter beside the guardian settings, but no settings control and no RPC channel, so turning it off means editing config.json by hand: `useAutoModeDuringPlan`

## 5. Gate

Focused suites per changed file; permissions + pi-harness + server-core
aggregates once on the final diff (permission decisions are a named risk
trigger); harness-contract pin suites for Task 1; `bun run typecheck:all`
**exit 0 with zero `error TS`, stated explicitly**; `bun run lint`; i18n
parity + sorted if strings are added; `git diff --check`.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
Check no other `bun test` is running before recording a new failure.

## 6. Constraints

- You own `packages/shared/src/agent/pi-agent.ts`, `mode-manager.ts`,
  `agent/core/pre-tool-use.ts`, `permission-dsl.ts`, `pi-harness/**`,
  `packages/server-core/src/sessions/SessionManager.ts`,
  `runtime-agent-definition.ts`, and their tests.
  **A sibling executor owns `base-agent.ts`, `capabilities/**`,
  `runtime-skill-content.ts` and `apps/electron/src/renderer/**`** — stay out;
  if a fix needs one, land the rest and report the residual word for word.
- One commit per task, subjects exactly as given. No `Co-Authored-By`. No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or `.orig`, never git.
- No `docs/superpowers/specs/` or checklist edits. No version bumps or release
  notes. Never write `~/.nessy/dp_auth_creds.json`. Loopback fixtures only.
- Code, comments and commits in English.

## 7. Report

Commit shas; each defect reproduced; the no-pin-changed statement; the `/path`
anchor decision; which SubagentStop fields are produced and any that cannot be,
with the reason; the alias sweep result; residuals word for word; corrections to
this plan; mutation probes with sides; the explicit typecheck statement.
