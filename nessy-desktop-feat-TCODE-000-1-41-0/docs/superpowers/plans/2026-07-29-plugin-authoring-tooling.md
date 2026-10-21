# B1d — Plugin authoring and status tooling

A B1 slice. Read `docs/superpowers/specs/2026-07-29-b1-audit.md`'s
**authoring/status tooling** section first — it was measured, and its verdict
survived an adversarial refutation attempt.

What that audit established, and what you should confirm rather than inherit:

- **`validate` has no reachable form anywhere.** `PluginStore.validateInstalled`
  has zero callers — the textbook shape this whole audit is named after.
- **Status and scaffold already exist** with live readers: the
  `plugin_status`/`plugin_manage` session tools, the `plugins:manage` RPC with
  its inventory page, `/create-plugin` and the bundled `plugin-creator` skill.
  The refuter attacked all three on the axis this series keeps failing on —
  a reader that does not run on the shipped Pi default — and all three survived,
  one proven by execution.
- The token-cost columns belong to `plugin details`, **not** `plugin list`; the
  audit corrected the row on that.

So this slice is narrow: give `validate` a caller, and add the CLI verbs.

---

## 0. Method rules

1. **Fetch the page yourself**: `curl -s https://code.claude.com/docs/en/plugins-reference.md`.
   Never a summarising fetch tool. The CLI surface is documented there — find the
   verb table rather than trusting this plan's list.
2. **The quotation is the identifier, not the line number.** Read the whole line.
3. **Declared ≠ enforced**, and here it is literal: this task exists because a
   validator exists and nothing calls it. **Do not add a second one.**
4. **Before claiming something is absent, say what it would be called and search
   the concept**, not one guessed identifier — and grep the audit's evidence
   column. Four of my absence claims were wrong this week. Tracker notes 11a/11b.
5. **Two git commands** — pathspec on the `commit`; note 11c on shared files.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md` — accurate on the
   last two runs. Reproduce on a clean `git worktree`, never `git stash`.

---

## 1. Task 1 — `validate` gets a caller

**Commit:** `feat(plugins): validate a bundle without installing it`

A non-mutating entry point that stages and normalises a bundle and reports its
diagnostics **without** committing it to the store. The normaliser already
exists; what is missing is the door.

- Expose it where a plugin author can reach it. R30b's `nessy-general-agent
  doctor` established the CLI-subcommand precedent and its arg-parsing shape —
  follow it rather than inventing a second convention.
- `--strict` promotes warnings to failures if the docs say so; check.
- **Staging must not leave anything behind.** A validate that half-installs is
  worse than no validate. Prove the store is untouched afterwards.

**Gate:** a deliberately broken bundle reports its diagnostics and **is not
installed**; a good bundle validates clean and **is still not installed**. Assert
the store's state in both, not just the return value — that is the difference
between testing the validator and testing the door this task is adding.

---

## 2. Task 2 — the read-only CLI verbs

**Commit:** `feat(cli): plugin list and plugin details`

`list` and `details` over the existing status API, plus `--json`. Establish the
documented column sets from the page — and note the audit's correction that token
cost belongs to `details`.

- **Token cost is genuinely new work** (a `count_tokens` call against the active
  connection, a character fallback, a new field on the safe component summary).
  If it does not fit this slice, record it as a category string with its cost
  rather than half-wiring it.
- **`--prune`, transitive enable and dependent-blocking disable are NOT in this
  slice.** They need the `dependencies` graph and an auto-installed provenance
  bit, neither of which exists. The audit is explicit that they are a subsystem,
  not a slice.

**Gate:** both verbs run against a real installed plugin and their `--json` shape
is pinned. **Never install a plugin from the network in a test** — build a local
fixture bundle.

---

## 3. Task 3 — what this slice leaves

**Commit:** `docs(plugins): the authoring surfaces this slice does not build`

Category strings for `prune`/transitive-enable/dependent-blocking-disable (with
`dependencies` named as the prerequisite), the token-cost columns if you deferred
them, and `plugin init`/`--with` scaffolding — which the audit calls optional
given `/create-plugin` already works, so say whether you agree.

**Unwrapped, unbolded, backtick-terminated, no inline backticks inside the
reason, under 400 characters.** Four separate ways of losing half a register row
have been found; do not add a fifth. Confirm:
`python3 scripts/regenerate-deviation-register.py | grep -iE "plugin (list|details|validate)|prune"`.

---

## 4. Gate

Focused suites for every changed file, plus `packages/shared/src/plugins` and
`apps/cli`; `bun run typecheck:all`; `bun run lint`; i18n parity/sorted if you add
user-facing strings — note the CLI is English-only, which R30b established, so say
which applies; `git diff --check`.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe:** break the validator's diagnostic plumbing and the broken-bundle
case must go red.

---

## 5. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- **Another agent is working concurrently** on managed plugin activation and the
  plugin output-style scan — the format adapter, the capability projection, the
  managed policy and `prompts/output-styles.ts`. Stay out of those; your work is
  `management-service-v2.ts`, the store's validator and `apps/cli`.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- **Never install or execute a plugin fetched from the network.** Local fixtures
  only; read a manifest as data.
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 6. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; proof the store is untouched by a validate; whether token cost landed or
was costed; the category strings with proof they appear in the register; and the
mutation probe.

---

## 7. What this slice does not build

Written by the executor. Each row is a documented surface this slice deliberately
left, with the reason it was left rather than half-wired.

### The dependency subsystem

`prune`, transitive enable and dependent-blocking disable are one feature with
one missing prerequisite, so they are recorded as one row:

- `documented, not implemented — plugins/cli-reference.md#plugin-prune (was line 993 of the retired plugins-reference page) prune removes auto-installed dependencies no other plugin requires, :1018 enable resolves dependencies transitively, and :1037 disable fails when an enabled plugin depends on the target. All three need the dependencies manifest field, unparsed here, plus an auto-installed provenance bit to tell a pulled-in plugin from a chosen one`
- `documented, not implemented — plugins/cli-reference.md#plugin-tag (was line 1152 of the retired plugins-reference page) has plugin tag create a release git tag so a semver dependency constraint can resolve to it. Tagging is only useful once dependency resolution reads those tags, so it belongs inside the dependency subsystem rather than ahead of it as a standalone verb`

### Token cost

The always-on column landed as the documented fallback. Two halves did not:

- `documented, not implemented — plugins/cli-reference.md#plugin-details (was line 1148 of the retired plugins-reference page) computes the always-on total through the count_tokens API for the active model, and falls back to a character estimate only when that API is unreachable. This repository has no count_tokens caller anywhere and the CLI holds no model connection, so the fallback is the only path implemented and both output shapes label themselves an estimate`
- `documented, not implemented — plugins/cli-reference.md#plugin-details (was line 1120 of the retired plugins-reference page) prices each component when it fires and shows the figure per component. Computing it needs every skill, agent and command body read out of the installed bundle cache and counted, a second reader over bundle paths. The details verb reports on-invoke as null, named as not computed rather than shown as a zero`

### The verbs this slice did not add

- `documented, not implemented — plugins/cli-reference.md#plugin-list (was line 1089 of the retired plugins-reference page) lets plugin list include available plugins from marketplaces, requiring --json. That is a marketplace catalogue fetch rather than a registry read, so the verb would stop working offline and would pull in the registry source with its network and auth path. Every other column this listing prints comes from local state`
- `documented, not implemented — plugins/cli-reference.md#claude-plugin-commands (was lines 926-1074 of the retired plugins-reference page) give install, uninstall, enable, disable and update a CLI form with scope and config flags. Every one of those operations already exists here behind the plugins manage RPC and the plugin manage session tool, so the gap is the terminal entry point rather than the capability`
- `documented, not implemented — plugins/cli-reference.md#plugin-validate (was line 1192 of the retired plugins-reference page) names a slash form of validate alongside the terminal one, run inside a session against a directory path. The validator this slice added is host side and reachable from the CLI only; a session form needs a command or tool definition plus a decision about which paths a session may be pointed at`

### `plugin init` — the audit's judgement, and whether I agree

The audit calls scaffolding optional because `/create-plugin` and the bundled
`plugin-creator` skill already work. **I agree, and the reason is stronger than
"already covered".** `:874` scaffolds starter files a human then edits; the
existing command scaffolds them with a model that can fill them in from the
user's description in the same turn. A non-interactive `plugin init` would be the
weaker of the two surfaces, not a missing one. Recorded rather than built:

- `documented, not implemented — plugins/cli-reference.md#plugin-init (was line 874 of the retired plugins-reference page) scaffolds a plugin under the skills directory, with a --with list naming component folders to seed. The create-plugin command and the bundled plugin-creator skill already scaffold a bundle here, and they do it with a model that fills the starter files from the user's description, so a second non-interactive scaffolder would duplicate a working surface with a weaker one`

### Not a deviation, a documentation observation

`validate` is absent from the page's own CLI verb table (`:868`-`:1174`, ten
verbs). It is specified only in § *Unrecognized fields* (`:477`-`:491`),
§ *Experimental components* (`:540`) and the § *Common issues* row at `:1192`,
which is also the only place its argument appears. A reader who trusts the verb
table concludes the verb does not exist — which is what §0's "find the verb table
rather than trusting this plan's list" would have produced on its own. Both the
plan and the table had to be read against each other.
