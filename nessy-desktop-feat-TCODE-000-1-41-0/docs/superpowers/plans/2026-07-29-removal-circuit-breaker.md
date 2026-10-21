# S4 — The removal circuit breaker

Not a parity row. A safety floor the documentation states three times and we do
not have at all, found by the phase-4 sweep of pages this audit had never read.

**On HEAD, in `allow-all`, `rm -rf ~` runs with no prompt.**

---

## 0. Method rules

1. **Fetch the pages yourself** with `curl -s`. Never a summarising fetch tool —
   it has invented field names twice in this series and both shipped.
2. **The quotation is the identifier, not the line number.** Locate each quoted
   sentence by its text; report the line you found it at.
3. **Read around the quotation.** A sentence between two quoted ones can reverse
   their meaning.
4. **Declared ≠ enforced.** Name the consumer and prove it runs, on the **Pi**
   backend, which is our shipped default.
5. **Two git commands** — pathspec on the `commit`, not only on `git add`.

---

## 1. The contract

`permissions.md`, the `bypassPermissions` row of the permission-mode table:

> Skips permission prompts, except those forced by explicit `ask` rules,
> connector tools your organization set to `ask`, and MCP tools marked
> `requiresUserInteraction`. Root and home directory removals such as `rm -rf /`
> also still prompt as a circuit breaker

`permissions.md`, the callout below that table:

> Removals targeting the filesystem root or home directory, such as `rm -rf /`
> and `rm -rf ~`, also prompt as a circuit breaker against model error,
> including when the command contains command substitution with `$(...)` or
> backticks, or process substitution with `<(...)`. Before v2.1.208, only the
> plain form, such as `rm -rf ~` typed as its own command, prompted; commands
> that reached the removal through a substitution didn't.

`permission-modes.md` § *Skip all checks with bypassPermissions mode*:

> Removals targeting the filesystem root or home directory, such as `rm -rf /`
> and `rm -rf ~`, still prompt as a circuit breaker against model error. The
> circuit breaker also fires when the command contains command substitution with
> `$(...)` or backticks, or process substitution with `<(...)`, whether the
> removal sits inside the substitution, as in `echo "$(rm -rf ~)"`, or elsewhere
> in the same command.

And the same page, on plan mode under bypass:

> Explicit ask rules and the removal circuit breaker above still prompt.

Three statements, two pages, one rule. Note the last one especially: the breaker
outranks plan mode's own suspension of blocks.

---

## 2. Our state, measured

`allow-all` is our `bypassPermissions` analogue. Searched the whole permission
path — `pre-tool-use.ts`, `mode-manager.ts`, `permission-dsl.ts` — for any
root-or-home removal guard: **there is none.** `rg` for
`rootRemoval|homeRemoval|dangerousRemoval|destructiveRemoval|removalCircuit`
across `packages/` and `apps/` returns nothing.

The `rm -rf /` strings that do exist in `mode-manager.ts` are all **comments**,
illustrating why command substitution is dangerous — the file reasons about the
mechanism and never implements the floor.

**The machinery you need already exists.** `runPreToolUseChecks` has prompts that
deliberately survive `allow-all`, carrying `nonNegotiable` and **no**
`rememberForMinutes`/`commandHash` because the documented floor offers no
"don't ask again": `worktreeApproval` and the interaction-required prompt. Read
those two and follow their shape. The comment above them explains the reasoning
you must preserve.

---

## 3. Tasks

### Task 1 — detect the targets

**Commit:** `feat(permissions): detect removals targeting root or the home directory`

A pure, tested predicate over a Bash command string. No I/O, no permission
decisions — those are Task 2.

Decisions to make and record, each with its reasoning:

- **What counts as "targeting".** The docs' examples are `rm -rf /` and
  `rm -rf ~`. A removal of `~/projects/scratch` targets a subdirectory, not the
  home directory, and must **not** fire — a breaker that cries wolf on ordinary
  cleanup will be routed around and then it protects nothing. Enumerate the
  forms you accept: `/`, `~`, `$HOME`, `${HOME}`, the resolved absolute home
  path, and their trailing-slash variants. Decide explicitly about `/*` and
  `~/*` and say why.
- **Which commands are removals.** `rm` is the documented example. Consider `rmdir`,
  `find … -delete`, `shred`, and `mv <target> /dev/null`. You may scope to `rm`
  and `rmdir` — but if you do, say so as a category string rather than leaving
  the boundary implicit.
- **Reuse the wrapper stripping that already exists.** `claude-bash-rule.ts`'s
  `stripSubcommand` sees through `sudo`, `doas`, `env` (including
  `-S`/`--split-string`) and exec wrappers for deny-shaped matching — added in
  `4af8bd1e` for exactly this class of evasion. `sudo rm -rf ~` must fire. Do
  **not** write a second stripper.
- **The substitution clause is deliberately broad.** The docs fire the breaker
  when the command *contains* `$(...)`, backticks or `<(...)` **and** a
  qualifying removal appears **anywhere in the same command** — the example
  `echo "$(rm -rf ~)"` has the removal inside, but the sentence explicitly says
  "or elsewhere in the same command". Implement the documented breadth, and note
  that `splitCompoundCommand`/`substitutionSpans` in `claude-bash-rule.ts`
  already walk these spans.

**Gate:** a table-driven test with both poles. Positive: the two documented
forms, the wrapper-prefixed forms, the substitution forms, `$HOME` spellings.
Negative — and these matter more, because a false positive is how the feature
gets disabled: `rm -rf ~/projects/scratch`, `rm -rf ./build`, `rm file.txt`,
`echo "rm -rf ~"` (a quoted string, no removal), and a path merely *containing*
the home path as a prefix of a longer directory name.

---

### Task 2 — make it prompt, in every mode

**Commit:** `feat(permissions): the removal circuit breaker outranks every mode`

Wire the predicate into `runPreToolUseChecks` so a qualifying removal prompts —
**in `allow-all`, in plan mode, and against an `allow` rule alike.**

- Follow the `worktreeApproval` shape: emitted before every mode branch, carrying
  `nonNegotiable`, and carrying **neither** `rememberForMinutes` nor
  `commandHash`. Those two fields are the "don't ask again" mechanism and this
  floor has none — a remembered bypass of a circuit breaker is not a circuit
  breaker.
- The description the user reads must name **what** will be removed and **why
  they are being asked despite the mode**. A prompt that looks like every other
  prompt gets the same reflexive approval.
- `permission-modes.md` says the breaker still prompts under plan mode's
  bypass — check what our plan mode does and make it consistent.
- **Check every backend.** `runPreToolUseChecks` is called from `pi-agent.ts`;
  R30a found a per-read rule wired into Pi only, so the same field was inert
  under Claude. Establish which backends reach this chokepoint and report it. Pi
  is the one that must work.

**Gate:** drive `runPreToolUseChecks` directly with `permissionMode: 'allow-all'`
and each positive case, asserting a prompt is returned. Then the mutation probe:
remove the wiring and confirm the test fails. **A test that only exercises `ask`
mode proves nothing** — the entire point is the modes that skip prompts.

---

### Task 3 — the rows this does not cover

**Commit:** `docs(permissions): the bypass-mode floor items we do not implement`

`permissions.md`'s bypass row lists four things that still prompt. This plan
implements one. Give each of the others a category string —
`documented, implemented` · `documented, impossible on Pi — <equivalent>` ·
`documented, not implemented — <reason>`:

- explicit `ask` rules,
- connector tools an organization set to `ask`,
- MCP tools marked `requiresUserInteraction`,
- the removal breaker (this plan).

Some are likely already implemented — the interaction-required prompt looks like
the third. Verify rather than assume, and add the strings to the plan file so
they reach the deviation register.

#### Result — the four bypass-row floors, measured on HEAD

Each string below was verified by reading the path that enforces it, not by
matching a field name. All four survive `allow-all`, our `bypassPermissions`.

1. **Explicit `ask` rules — `documented, implemented`.**
   `mode-manager.ts:2090-2116` evaluates `config.toolRules` BEFORE the
   `allow-all` early return at `2122`, so an `ask` rule returns
   `requiresPermission` even in that mode; `pre-tool-use.ts` turns it into a
   prompt carrying `nonNegotiable: 'askRule'`, ahead of every mode branch. The
   readable permission DSL's own `ask` action is the second spelling and is
   enforced at `pi-agent.ts:3964` (`decision.outcome === 'allow'` → `ask`), with
   `promptIsNonNegotiable`'s `dslEvaluation` argument keeping a hook `allow`
   off it. In `dontAsk` both spellings deny instead, marked `askRuleDenied`.

2. **Connector tools an organization set to `ask` —
   `documented, impossible on Pi — an admin `ask` rule over the MCP tool name`.**
   claude.ai connectors have no Nessy equivalent: the GitHub subscription
   surface is gone and there is no org connector registry to carry a per-tool
   `ask` flag. The equivalent an admin actually has is
   `claudeRules.ask` in `/etc/nessy/managed-policy.json`
   (`ManagedClaudeRulesV1`, `pi-harness/managed-policy.ts:264-269`), whose rule
   strings may name `mcp__server__tool` and which lands on exactly the same
   non-negotiable `askRule`/DSL-ask path as item 1. Nothing is missing at the
   enforcement layer; the concept the row names is what does not exist.

3. **MCP tools marked `requiresUserInteraction` — `documented, implemented`.**
   `mcp-pool.ts:223` reads the server's `_meta["anthropic/requiresUserInteraction"]`,
   `base-agent.ts:619` projects the proxy names, and BOTH backends spread that
   context into their check args (`pi-agent.ts`, `claude-agent.ts`
   `getMcpPreToolUseContext()`), so the gate's step-1 flag is fed on Pi rather
   than merely declared. It prompts in every mode, is never remember-able, and
   denies in `dontAsk`.

4. **Root and home removals — `documented, implemented` (this plan).**
   `pi-harness/removal-circuit-breaker.ts` + the floor in `pre-tool-use.ts`.
   The one floor `allow-all` does not skip, with no don't-ask-again and no
   would-prompt marker in `dontAsk`.

Scope note for item 4, recorded as its own category string:
**`find … -delete`, `shred`, and `mv <target> /dev/null` — `documented, not
implemented — outside the docs' removal examples, and `find ~ -name '*.pyc'
-delete` is ordinary cleanup that a breaker keyed on `find` would fire on every
time.`** `rm` and `rmdir` are the whole fire set. A PowerShell `Remove-Item`
reaching the same Bash tool on Windows is likewise not covered.

---

## 4. Gate

- The new focused suites, plus `packages/shared/src/agent/core` and the
  permission/mode aggregates.
- `bun run typecheck:all`, `bun run lint`, `git diff --check`.

This touches **permission decisions**, a named risk trigger in `AGENTS.md`, so
run the expanded permission set once on the final diff.

**Run every test from the repository ROOT.** A run from inside a package
directory bypasses the config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

One failure is known pre-existing and must be reproduced on a clean worktree at
your base commit before you call it that:
`Pi harness R0 baseline > executes golden foreground and background process contracts`.

---

## 5. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- **Never run a destructive command while testing this.** Drive the predicate and
  the checker with strings. Nothing in this plan requires executing `rm`.
- Code, comments and commits in English.

## 6. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; the positive/negative table from Task 1; which backends reach the
chokepoint; the Task 3 category strings; and the mutation-probe result.
