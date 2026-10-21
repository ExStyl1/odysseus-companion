# B1e — The last two B1 subsystems: `dependencies` and monitors

The remainder of parity row **B1**, after B1a–B1d. Read
`docs/superpowers/specs/2026-07-29-b1-audit.md`'s sections on **`dependencies`**
and **`experimental.monitors`** first — both were measured, both carry security
notes, and the monitors one is the reason this plan puts them in that order.

Two tasks, sequential, because both touch `packages/shared/src/plugins/`.

---

## 0. Method rules

1. **Fetch the pages yourself** with `curl -s`:
   `https://code.claude.com/docs/en/plugins-reference.md`,
   `.../plugin-dependencies.md`, `.../plugin-marketplaces.md`. Never a
   summarising fetch tool — it invented field names twice in this series and both
   inventions shipped.
2. **The quotation is the identifier, not the line number.** Read the **whole
   line**: twice this week a plan was wrong because its author stopped at the
   first sentence of a line that had two, and once a whole security clause lived
   in the second sentence.
3. **Read around each quotation.**
4. **Declared ≠ enforced.** Name the consumer and prove it runs on **Pi**.
5. **Before claiming anything is absent**, say what it would be called and search
   the *concept* — the directory, the consumer, the i18n key, the RPC channel —
   **and grep the tracker's own evidence column.** Four of my absence claims were
   wrong this week; the worst was refuted by a line in the file I was planning
   from. Tracker method notes 11a/11b.
6. **Two git commands** — pathspec on the `commit`; note 11c: that does not
   protect a file another agent holds.
7. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md` — accurate on the
   last three runs. Reproduce on a clean `git worktree`, never `git stash`.
8. **`rg` skips NUL-containing files silently; eight of ours have one** — use
   `grep -a` for absence claims.
9. **A CDP dev instance may be running on port 9223.** Do not kill or drive it.

---

## 1. Task 1 — `experimental.monitors`, and its three guards

**Commit:** `feat(plugins): a plugin's monitors run, with the guards the docs require`

**This task goes first because it is the one that can hand an attacker a shell,
and I want its guards written while the reasoning is fresh rather than bolted on
after the dependency graph.**

The audit's finding: we detect the field's *presence* and emit a deferral. The
entries are never opened, never become a capability, and nothing starts. The
look-alike we do run — `RuntimeMonitorRegistration` — is a **different contract**
(`resource`/`cron`/`timezone`, no `command`), fed only by the native manifest
normalizer, armed per-turn, Pi-only.

**Three doc-mandated guards must ship in this same commit or not at all**, because
auto-start means an installed bundle executes an unsandboxed shell command at
session start with no per-invocation approval:

- **A project-scoped plugin must not load monitors.** Without this, a plugin
  checked into a repository executes shell on every collaborator's machine when
  they open it. `PluginScope` already exists.
- **`${user_config.*}` must be REJECTED, not substituted**, with the documented
  error. B1b already landed this rejection as a static parse check for hook
  commands — reuse it; the audit is explicit that monitor commands are the second
  site and were unreachable then because monitors were never parsed. **They are
  reachable now, which is why this is in this task.**
- **Mid-session disable must not stop a running monitor**, per the docs.

Also: monitors are `command`-form, so the `${CLAUDE_PLUGIN_ROOT}` rewrite and the
`PLUGIN_ROOT`/`PLUGIN_DATA` env already exist (`plugins/data-paths.ts`) — reuse,
do not re-derive. And `:334` says monitor processes get **no**
`CLAUDE_PLUGIN_OPTION_*`; B1b routed that map onto hook registrations only, so
verify nothing else can reach it.

**Gate:** a plugin monitor starts and its output surfaces; a **project-scoped**
plugin's monitor does **not** start; a monitor command containing
`${user_config.KEY}` is refused with the documented error. All three, and the
middle one is the one that matters.

---

## 2. Task 2 — `dependencies`

**Commit:** `feat(plugins): plugin dependencies resolve, install and guard removal`

Today the field's *contents* are dropped before the IR — names and ranges never
reach `NessyPluginManifest`. A bundle-only plugin (`name` + `dependencies`, which
the docs bless) installs as a plugin with zero capabilities that does nothing.

Establish from the page: semver range resolution against
`{plugin-name}--v{version}` git tags, range intersection across all installing
plugins, transitive enable writing an explicit `true`, refusal to disable a
plugin another enabled plugin needs, and prune of orphaned auto-installed
dependencies.

Two things the audit established that shape the work:

- **`defaultEnabled` precedence is already in place** (`57a8af3b`), and the docs
  make a dependency requirement write an explicit `true` that outranks it. So
  transitive enable has its foundation.
- **Tag enumeration does not exist** for any marketplace source. If that is a
  prerequisite you cannot meet in this slice, **resolve what you can and record
  the rest** rather than half-building version resolution — a range that silently
  resolves to "latest" is worse than one that refuses.

**The inverse exposure is the interesting one and belongs in the report:** a
bundle whose *safety* component lives in a dependency — a `PreToolUse` guard hook,
a permission-narrowing plugin — currently installs and activates with that
dependency absent, showing only a generic `partial` badge, where the contract
disables the dependent plugin until resolved. Say whether you implemented that
disabling.

**Gate:** a plugin declaring a dependency pulls it in; disabling a needed plugin
is refused with a message naming the dependent; prune removes an orphaned
auto-installed plugin and **not** a user-chosen one. That last distinction needs
the provenance bit — if you add it, say where it lives.

---

## 3. Task 3 — what B1 still leaves

**Commit:** `docs(plugins): what remains of B1 after the last two subsystems`

Category strings for whatever you deliberately left, plus a plain statement of
whether **B1 can now be closed** or what is still open.

Include `bin/`-on-PATH: the audit recommends **not implementing** it, because any
installed plugin dropping a file named `git`, `ssh` or `sudo` into `bin/` would
have it resolved by bare-name lookup for every subprocess the agent spawns, and
shadowing is the whole attack — the plugin never has to be invoked, only enabled.
Write that as the recommendation with its reasoning; the decision is the owner's.

**Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters** — five separate ways of losing half a register row have
been found, the last by measuring the parser's output. Confirm with
`python3 scripts/regenerate-deviation-register.py`.

---

## 4. Gate

Focused suites for every changed file, plus `packages/shared/src/plugins`,
`packages/shared/src/marketplace` and the capability aggregates;
`bun run typecheck:all` **and `apps/cli` separately** (it is not in that script);
`bun run lint`; i18n parity/sorted if you add strings; `git diff --check`.

**Credential handling, isolation and process lifecycle are all named risk
triggers here.** Run the expanded set once on the final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Never install a plugin fetched from the network, and never let a monitor
fixture run anything but `echo` into a temp directory you created.**

**Mutation probe per task.** For Task 1 specifically: remove the project-scope
guard and that gate case must go red.

---

## 5. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so — six executors
  have now done that correctly, and three caught their own security holes that way.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- **Another agent is working concurrently on tool search / deferred tool
  loading** — `pi-harness/harness-tool-descriptor.ts`, the manifest projection and
  the tool-surface fixtures. Stay out of those.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 6. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; the three monitor guards and how each is proved; whether tag enumeration
was reachable and what you did about version ranges; whether a dependent plugin is
now disabled when its dependency is absent; **whether B1 can be closed**; the
category strings with proof they appear in the register; and the mutation probes.

---

## 7. Executed — what B1 still leaves

Written by the B1e executor after `05d1bdc4` (monitors) and `6890db03`
(dependencies).

### Can B1 be closed?

**No — one row is still absent-but-declared, and it is not one of these two.**
Every other row of the nine is now either implemented with a live consumer or
recorded below with a reason. What is left open:

1. **`experimental.themes`** — declared-but-inert, unchanged by B1e. It is the
   last B1 surface with no runtime at all. A theme is presentation-only, so it
   carries none of the risk the other rows did, but the row cannot be called
   closed.
2. **`bin/` on PATH** — the audit's recommendation is **not to implement**, and
   the owner has not ruled. Until they do, the row is open by decision rather
   than by work.
3. **Auto-install of dependencies**, which is the one place where the *shape* of
   what the docs describe is genuinely unbuilt rather than deliberately narrowed.
   It has a hard prerequisite that does not exist anywhere in this repo (git tag
   enumeration on a marketplace source), so it is a subsystem of its own, not a
   B1 remainder.

So: B1 closes on (1) and a decision on (2); (3) should become its own row rather
than holding B1 open, because a plan that says "finish B1" would then be asked to
build a git-network capability.

### `bin/` on PATH — recommend not implementing

The audit's argument survives contact with B1e, and B1e adds a second data point
for it. Any installed plugin dropping a file named `git`, `npm`, `ssh`, `sudo`,
`curl`, `node` or `bun` into `bin/` would have it resolved by bare-name lookup for
**every** subprocess the agent spawns — not just the Bash tool, but hook commands,
LSP servers, stdio MCP servers, runtime skill contexts and, as of this slice,
plugin monitors. Shadowing is the whole attack: the plugin never has to be
invoked, only enabled, and the transcript attributes the resulting code execution
to whatever innocuous thing the user asked for.

The second data point: our trust record (`visibility-state.ts:77`-`:88`) is keyed
to one capabilityId plus one executableHash and cannot represent a directory whose
file set changes on plugin update. So even the fix's prerequisite is missing.

The cheap useful slice remains one string: tell the user the plugin ships
executables Nessy will not put on PATH, and that its own components can still call
them by absolute path. The detection and its deferral record are already live.

`documented, not implemented — plugin bin directories are detected and deferred and must stay that way, because putting one on PATH lets any enabled plugin shadow git, ssh, sudo, node or bun by bare name for every subprocess the agent spawns, not only the Bash tool, and the per-capability trust record cannot represent a directory whose file set changes on update`

### Dependencies — recorded rather than half-built

`documented, not implemented — dependency auto-install and semver range resolution both need plugin-name--vversion git tag enumeration on the marketplace repository, and no marketplace source in this repo enumerates tags at all; every source is a catalog-pinned ref, an npm package or a URL, so resolving a tilde range against whatever the catalog currently holds would make a constraint silently mean latest`

`documented, not implemented — range intersection across every installing plugin, and the range-conflict install failure it produces, exist to pick one version to FETCH; nothing is fetched here, so each dependent plugin's own range is checked independently at load and yields the same per-plugin verdict without the intersection`

`documented, not implemented — the cross-marketplace dependency refusal and its allowCrossMarketplaceDependenciesOn allowlist gate auto-install, so with nothing auto-installed there is no install to refuse; the target marketplace name is carried into the IR and already narrows which installed plugin can satisfy a dependency, so the check has its input the day auto-install lands`

`documented, not implemented — prune of orphaned auto-installed dependencies and the provenance bit it needs have no writer, because nothing is ever auto-installed; adding the bit now would ship a store field no code sets and a verb with nothing to remove, which is the declared-but-inert shape this audit is named after`

`documented, impossible on a multi-workspace scope model — the enable-time refusal when a dependency is set to false at a scope with higher precedence than the target cannot be evaluated here, because precedence is narrowest-wins and a global or workspace target names no single narrower scope to read; Claude has one active workspace and project and Nessy has many, so picking one would refuse an enable that is legal in every other`

`documented, not implemented — the organization-plugin-policy row of the enable-failure table is a managed-policy read, and the managed policy is assembled in the server-core resolution inputs rather than in the store-only management service where transitive enable runs, so that one condition is unenforced while the other three are`

### Monitors — recorded rather than half-built

`documented, not implemented — a monitor whose when field is on-skill-invoke followed by a skill name is imported, reported as deferred and never started, because no skill-dispatch seam exists to observe the trigger; starting it at session start instead would run a monitor its author explicitly asked to hold back until a skill ran`

### One of our own docs is now wrong in the other direction

`docs-site/content/plugins/overview.md:38` lists "scheduled monitors" as
normalising into governed capabilities for the Claude row. The audit recorded that
as false because no Claude monitor has a schedule. After B1e it is *half* true and
still misleading: Claude monitors are now governed capabilities, but they are
command monitors with no schedule at all, and the native cron form is the only
scheduled one. Left for the `docs/` audit the owner asked for after parity closes,
because a docs-site edit here would be the third owner of that sentence.
