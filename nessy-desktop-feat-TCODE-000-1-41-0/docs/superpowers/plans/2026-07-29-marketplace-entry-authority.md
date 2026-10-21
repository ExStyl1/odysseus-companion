# S9 — The marketplace entry is a plugin definition, not just a source

From the phase-4 sweep (`2026-07-29-phase4-findings.md`, `plugin-marketplaces.md`).

The tracker has carried a row named **"Marketplace schema and lifecycle"** for
weeks, and `plugin-marketplaces.md` had **zero citations anywhere in
`docs/superpowers/`** until that sweep. This is the first unit to read it.

Two consequences, one functional and one security-shaped:

- **A `strict: false` entry installs a plugin with zero capabilities and zero
  diagnostics.** The doc says such an entry *is* the plugin definition; we drop
  every entry-level field before any consumer.
- **`metadata.pluginRoot` is unsupported, which is a silent directory
  substitution inside a marketplace repository.** With `pluginRoot: "./plugins"`
  and `source: "formatter"`, Claude installs `<root>/plugins/formatter` and we
  install `<root>/formatter`. Anyone who can land a top-level directory in that
  repo — a pull request to a public marketplace — shadows the intended plugin,
  and we emit no diagnostic.

---

## 0. Method rules

1. **Fetch the page yourself**: `curl -s https://code.claude.com/docs/en/plugin-marketplaces.md`.
   Never a summarising fetch tool — it invented field names twice in this series
   and both shipped.
2. **The quotation is the identifier, not the line number.** Report where you
   found each.
3. **Read around each quotation.** In this series a sentence between two quoted
   ones has reversed their meaning more than once, and an executor last week
   found that the shape my plan needed was on a *different page* than the one I
   named. If the marketplace page points at another, follow the pointer.
4. **Declared ≠ enforced.** Name the consumer and prove it runs.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. **That list has
   been short three times running**, so reproduce anything you call pre-existing
   on a clean `git worktree` at your base commit. Never `git stash`.

---

## 1. State

`packages/shared/src/marketplace/` — `normalizers.ts`,
`registry-catalog-items.ts`, `registry-catalog-fetcher.ts`,
`registry-source.ts`.

Established by the sweep and by the B1 audit; **verify each before building**:

- We implement the **source** half of the entry contract. `strict`, the six
  component fields (`skills`, `commands`, `agents`, `hooks`, `mcpServers`,
  `lspServers`), `version`, `description`, `metadata.pluginRoot` and `renames`
  are dropped before any consumer.
- `normalizers.ts` **does** read `skills`/`mcpServers`/`hooks` — but only to
  harvest display strings for a catalog card, never as paths. That is worse than
  not reading them: it looks like support.
- `rg '\bstrict\b' packages/shared/src/marketplace/` returns nothing.
- `RegistrySourceService.add` performs **no policy check** before staging, so on
  a managed fleet a user can add any marketplace source and we clone and browse
  it. `allowedPluginKeys` gates plugin **keys** at use time, not marketplace
  **sources** at add time.

**B1a landed a shared manifest-path resolver with containment validation
(`b81bbe45`).** Reuse it. The marketplace-root `skills` exception in
`plugins-reference.md` is defined *against* that resolver's behaviour, so the two
must agree; writing a second path resolver here is how they diverge.

---

## 2. Tasks

### Task 1 — carry the entry's own fields into the IR

**Commit:** `feat(marketplace): a catalog entry's component fields reach the plugin definition`

Parse the entry-level fields and thread them to where a plugin definition is
built. Include `version` and `description`, which today are dropped even though
they are pure metadata.

- Establish and state the **precedence** between an entry field and the same
  field in `plugin.json`. The docs settle it for `defaultEnabled` — the
  marketplace entry wins — so check whether that generalises or is specific.
- Reuse B1a's resolver and its containment check. **A marketplace entry is
  untrusted input in exactly the way a plugin manifest is**, and it arrives from
  a repository the user may not control.

**Gate:** a fixture entry declaring component paths must produce those
capabilities. The negative: an entry path escaping the bundle root is refused
with a diagnostic.

---

### Task 2 — `strict`, and the marketplace-root exception

**Commit:** `feat(marketplace): a strict entry is the whole plugin definition`

Implement `strict` with the meaning the page gives it, and the `skills`
exception it creates: for an entry whose `source` resolves to the marketplace
root, declaring specific subdirectories **replaces** the default `skills/` scan
rather than adding to it — the inverse of the ordinary rule B1a implemented.

Read both pages before deciding: the exception is stated in
`plugins-reference.md` § *Path behavior rules* and defined in
`plugin-marketplaces.md`.

**Gate:** the ordinary rule and the exception, side by side, each asserted
against the other's fixture so a future edit cannot silently collapse them into
one.

---

### Task 3 — `metadata.pluginRoot`

**Commit:** `fix(marketplace): resolve an entry against its declared plugin root`

The directory-substitution finding. With `pluginRoot` declared, a `source` must
resolve beneath it.

- **Containment applies to `pluginRoot` itself**, not only to what sits under it.
- When `pluginRoot` is absent, behaviour must not change.
- Decide what happens when `pluginRoot` names a directory that does not exist —
  refuse the entry, or install nothing and say so. Either is defensible; silently
  falling back to the repository root is not, because that is the current bug.

**Gate:** the finding's own case — `pluginRoot: "./plugins"` with a decoy
directory at the repository root and the real plugin beneath `plugins/` — must
install the one under `plugins/`. Assert **which** directory was installed, not
merely that an install happened.

---

### Task 4 — a marketplace-source policy, or a costed absence

**Commit:** `feat(marketplace): an administrator can restrict which sources may be added`

The page describes an administrator restriction on which marketplace sources
users may add, "before any network or filesystem operation", re-checked on
install, update and refresh. Find its exact name and shape on the page.

We have no analogue. `allowedPluginKeys` is not one: it gates keys at use time,
cannot express "only marketplaces on our internal GitLab host", and does not run
before the clone.

Two acceptable outcomes:

- implement it, keyed the way the page keys it (it describes host and path
  pattern forms), enforced in `RegistrySourceService.add` **before** any network
  or filesystem work, and re-checked wherever we refresh; or
- record it as `documented, not implemented — <reason and cost>` if it needs
  managed-tier machinery this unit should not grow.

For a bank fork the first is the valuable one, but a half-built check that runs
after the clone is worse than an honest absence — the clone is the part that
touches the network.

---

### Task 5 — the rest of the page

**Commit:** `docs(marketplace): the marketplace rows we do not implement`

Category strings for `renames`, sparse checkout, and whatever else you leave.
The sweep counted 21 findings on this page; verify rather than copy.

**Write the strings unwrapped and unbolded.** The register generator flattens
wrapped lines and strips emphasis now, but a string broken across a list-bullet
boundary can still be missed — check your rows appear by running
`python3 scripts/regenerate-deviation-register.py | grep marketplace` before you
call the task done.

---

## 3. Gate

Focused suites for every changed file, plus `packages/shared/src/marketplace` and
`packages/shared/src/plugins` — this touches the shared resolver B1a built, and a
regression there is invisible to a marketplace-only run.

`bun run typecheck:all`; `bun run lint`; `git diff --check`.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe:** with `pluginRoot` resolution removed, the Task 3 test must
install the decoy and go red.

---

## 4. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so — two executors
  have now done that correctly rather than shipping a known bug.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **Never clone or fetch a real remote marketplace in a test.** Build fixtures on
  local paths you created.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 5. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; the entry-versus-manifest precedence you established and where the page
settles it; which directory Task 3's fixture installed before and after; the
Task 4 decision; the category strings and proof they appear in the register; and
the mutation probe.

---

## 6. `plugin-marketplaces.md` rows we do not implement

Verified against the page as fetched 2026-07-29, not copied from the sweep. Each
row was checked in the tree before it was written down; sixteen survived, and the
absences the sweep counted separately that turned out to be the same mechanism
are folded together here rather than padded back out to a count.

- The renames map — `documented, not implemented — a top-level renames entry maps a plugin's former name to its current one, or to null when removed, so a user migrates instead of seeing plugin-not-found; Claude also rewrites the old key in enabledPlugins and pluginConfigs in every editable scope, following chains. Nessy keys a plugin by marketplace id plus plugin id with no rename channel, so a rename reads as a new plugin and the old as missing.`

- Cross-marketplace dependency allowlisting — `documented, not implemented — allowCrossMarketplaceDependenciesOn names the other marketplaces whose plugins this one may depend on, and a dependency from a marketplace not listed is blocked at install. Nessy has no cross-marketplace dependency resolution at all, so there is no install-time edge for the list to gate.`

- Reserved marketplace names — `documented, not implemented — sixteen names are reserved for official Anthropic use and are re-checked every time a marketplace loads, not only when it is added, so a third-party marketplace registered under one stops loading as an untrusted source. Nessy accepts any name. The reservation protects a namespace a T-Bank fork does not publish into, so the cost falls only on a user who adds an impersonating public marketplace.`

- Contextual install suggestions — `documented, not implemented — an entry can carry relevance signals that tell Claude when to suggest the plugin, taking effect only for marketplaces an administrator allowlists through pluginSuggestionMarketplaces in managed settings. Nessy has no contextual plugin-suggestion surface for the signals to feed, so the field is dropped at catalog parse rather than carried into a definition nothing reads.`

- The blocklist half of managed marketplace control — `documented, not implemented — blockedMarketplaces takes the same enforcement path as the allowlist and blocks named sources outright, and disableSideloadFlags rejects the CLI flags that sideload plugins, agents and MCP servers for one run. S9 implements the allowlist only. On a managed fleet the allowlist is the stronger control, since anything unlisted is already refused, so the blocklist adds reach not safety.`

- Marketplaces declared by settings rather than by the user — `documented, not implemented — extraKnownMarketplaces in project or managed settings registers a marketplace automatically, so team members are prompted to install it when they trust the project folder, and it is the documented partner of the allowlist. Nessy registers a marketplace only through an explicit add, so an administrator can restrict which sources are permitted but cannot pre-supply one.`

- Sparse checkout — `documented, not implemented — the add command takes a sparse option limiting the checkout to named directories through git sparse-checkout, and a git-subdir plugin source is documented to clone sparsely to minimise bandwidth for monorepos. Nessy records the requested paths on the registry row and clones in full, so a large monorepo marketplace costs its whole tree on every fetch. Correctness is unaffected; bandwidth is not.`

- Pre-populated plugin seed directories — `documented, not implemented — a seed directory pointed at by an environment variable lets a container image start with marketplaces and plugin caches already present and never clone at runtime, with seed entries outranking user configuration, remove and update refused against them, and paths probed at the mount rather than trusted from the seed. Nessy has no seed layer, so a container image re-clones on first use.`

- The marketplace git environment knobs — `documented, not implemented — three variables tune marketplace git behaviour: keeping the existing clone when a background pull fails instead of re-cloning, raising the 120-second git timeout, and cloning GitHub shorthand sources over HTTPS rather than SSH. Nessy has its own 45-second registry fetch timeout and no background pull at all, so two of the three describe a mechanism we do not run.`

- Commit-SHA version resolution — `documented, not implemented — a plugin version resolves from plugin.json, then the marketplace entry, then the git commit SHA of the plugin source, so a plugin that declares no version anywhere still gets a new version on every commit. S9 implements the first two. With neither declared the Claude adapter stamps 0.0.0, so an actively developed plugin with no version field never appears to change and the cached copy is kept.`

- Inline hooks and MCP configuration on an entry — `documented, not implemented — the page's own advanced entry example declares hooks and mcpServers as inline configuration objects rather than paths, and that is the shape a marketplace operator uses to add a hook to a plugin that ships none. Nessy records the inline object as a deferred compatibility entry and builds no capability from it, matching how the same inline form is already treated in a plugin manifest.`

- Entry components on a non-Claude bundle — `documented, not implemented — an entry defines components for whatever bundle its source contains, but only the Claude adapter reads one, because plugin-marketplaces.md is the contract that defines an entry. A bundle normalising as Codex, MCPB, native or legacy Nessy leaves its entry component fields unread; the install warns, naming the adapter that read the bundle, so they go unread but not unreported.`

- One marketplace per name — `documented, not implemented — each user may register only one marketplace per name, and adding a second with the same name replaces the first. Nessy dedupes on the raw source string instead, so two different sources whose catalogs declare the same marketplace name coexist and their plugins are told apart only by the registry id we mint per add.`

- Marketplace validation — `documented, not implemented — the validate command run against a marketplace directory checks the catalog for schema errors, duplicate plugin names and source path traversal, validates each local entry's own plugin.json, warns when an entry version disagrees with the manifest, and rejects a cyclic rename chain. Nessy validates a catalog only while fetching it, and offers no author-facing command.`

- Entry catalog metadata — `documented, not implemented — an entry may carry category, tags, keywords, license and repository. S9 carries the metadata the adapter can act on and leaves these five, because nothing in the Nessy plugin record or browse row reads them; carrying them would persist untrusted catalog text no consumer displays.`

- Organization-synced marketplaces — `documented, not implemented — distributing a marketplace through the Anthropic organization settings surface reads a private repository through the Claude GitHub App, forbids npm plugin sources, packages private plugin folders during distribution, and restricts which plugin sources may be private. That is an Anthropic-hosted product surface, and a T-Bank fork distributes through its own GitLab instead.`
