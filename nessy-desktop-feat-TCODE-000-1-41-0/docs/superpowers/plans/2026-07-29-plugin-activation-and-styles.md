# B1c — Managed plugin activation, and a plugin's output styles

Two B1 slices that were blocked and now are not. Read
`docs/superpowers/specs/2026-07-29-b1-audit.md`'s sections on **managed plugin
activation** and **`outputStyles`** before starting — both were measured, both
name their prerequisite, and both prerequisites landed today.

- Managed activation wanted `defaultEnabled` to survive install. It was parsed
  and then destroyed by re-normalization; `57a8af3b` fixed that.
- The plugin `output-styles/` scan wanted a shared manifest-path resolver
  (`b81bbe45`, B1a) and a real frontmatter reader (S11: `6a2ea544`). Both exist.

They are one plan because both are "a plugin surface finally reaching a runtime",
and because both touch the capability projection.

---

## 0. Method rules

1. **Fetch the pages yourself** with `curl -s`:
   `https://code.claude.com/docs/en/plugins-reference.md`,
   `.../settings.md`, `.../output-styles.md`. Never a summarising fetch tool —
   it invented field names twice in this series and both shipped.
2. **The quotation is the identifier, not the line number.** Read the **whole
   line** — twice this week a plan was wrong because its author stopped at the
   first sentence of a line that had two.
3. **Read around each quotation.**
4. **Declared ≠ enforced.** Name the consumer and prove it runs on **Pi**.
5. **Before claiming anything is absent, say what it would be called and search
   the concept** — the directory, the consumer, the i18n key, the RPC channel —
   **and grep the audit's own evidence column.** Four of my absence claims were
   wrong this week; the fourth was refuted by a line in the tracker I was
   planning from. See tracker method notes 11a/11b.
6. **Two git commands** — pathspec on the `commit`. Note 11c: that is *not*
   sufficient when two agents share a file, and `SessionManager.ts` is the file
   every unit eventually touches. If you must edit it, stage precisely.
7. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md` — accurate on the
   last two runs. Reproduce on a clean `git worktree`, never `git stash`.

---

## 1. Task 1 — a managed administrator can turn a plugin on

**Commit:** `feat(managed): a managed policy can activate a plugin fleet-wide`

Today the managed tier can **allow** and **deny** plugins
(`allowedPluginKeys`/`deniedPluginKeys`, read by `isManagedPluginAllowed`) but
cannot **enable** one. The activation tiers that exist — user, workspace, trusted
project — are the non-managed analogue; only the managed tier is missing.

- Establish the documented semantics from `settings.md`'s `enabledPlugins`,
  including what precedence a managed entry has and what `defaultEnabled` falls
  back to when no entry exists at any scope.
- **The `false` direction is not just "don't enable".** Check what the docs say
  about blocking installation and hiding a plugin from the marketplace, and
  report which of those you implemented.
- **This reopens a carve-out I closed today.** `93f886f1` shut
  `areVettedPluginHooksAllowed` to `false` because
  `settings.md`'s `allowManagedHooksOnly` exemption is for plugins
  **force-enabled** in managed settings, and we had no force-enable, so
  substituting `allowedPluginKeys` would have granted hook execution to every
  allowlisted plugin. **If this task ships a real force-enable set, that
  predicate should read it** — and then the carve-out has its documented subject
  for the first time. Do it, and say so.

**Gate:** a managed policy enables a plugin the user never enabled; the user
cannot disable it; and the reopened hook carve-out admits **only** the
force-enabled set — not the allowlist. Assert that last part explicitly, because
conflating the two lists is the exact defect `93f886f1` removed.

---

## 2. Task 2 — a plugin's output styles load

**Commit:** `feat(plugins): a plugin's output styles reach the picker`

The `outputStyles` manifest field and the default `output-styles/` directory.
Today the adapter tests both as **booleans** — field present, directory exists —
and emits a deferral; the value is never parsed into paths, no `.md` is read,
and there is no `output-style` capability kind.

- Reuse B1a's resolver. `outputStyles` is in the **REPLACES** set, so a declared
  path displaces the default directory — and B1a already distinguishes an
  authority declaration from a supplement, so do not re-derive that.
- Add the capability kind and carry it through projection, the safe-capability
  summary and the per-capability toggle. A style that installs but cannot be
  selected is the declared-but-inert shape.
- Reuse S11's frontmatter reader and its **bullet-level** coding/safety split. A
  plugin style must be able to drop the engineering guidance and must **never**
  be able to drop safety text — S11 found those are not separable by section, so
  do not try.
- **`force-for-plugin` is NOT in this task.** It lets a plugin override the
  user's own selection, which is the defect S11 just fixed arriving through
  another door. S11 recorded three preconditions for it; add a category string
  pointing at them.

**Gate:** a plugin-shipped style appears in the picker and applies when selected;
a declared path displaces the default directory; and a plugin style **cannot**
remove safety text. The last assertion is the one that matters most.

---

## 3. Task 3 — what these two slices leave

**Commit:** `docs(plugins): the activation and output-style surfaces still open`

Category strings, including per-registry `autoUpdate` (which the audit found
needs a plugin *update* mechanism that does not exist — `upgrade()` refreshes only
the catalog cache), and `force-for-plugin`.

**Unwrapped, unbolded, backtick-terminated, no inline backticks inside the
reason, under 400 characters** — the register's reason group stops at a backtick
or a pipe, and four separate ways of losing half a row have now been found. Then
confirm: `python3 scripts/regenerate-deviation-register.py | grep -iE "enabledPlugins|output.?style"`.

### 3a. What these two slices leave

Three surfaces, each measured against our code rather than assumed. Two name the
seam that holds them back rather than the field, because that is what the next
slice has to plan around.

A fourth was drafted and dropped: `output-styles.md:53`'s managed-policy style
directory is already recorded in S11's plan, and a second row for it would double
a register entry rather than add one. Searching the register before writing is
what caught it.

- documented, not implemented — the install-time half of settings.md:793, where a managed enabledPlugins entry blocks installation at all scopes and not merely hides an installed plugin. Task 1 shipped the hiding half: a blocked plugin activates nothing and reaches no listing that filters through isManagedPluginAllowed. The refusal belongs in the install service, held by another agent: `enabledPlugins`
- documented, not implemented — the per-marketplace autoUpdate boolean of settings.md:879, which refreshes a marketplace and updates its installed plugins in the background after startup. No such field is parsed anywhere, and the update it would drive does not exist: upgrade only re-fetches the catalog clone, and availableUpdateVersion has no producer, so canUpdate is always false: `autoUpdate`
- documented, not implemented — output-styles.md:94 force-for-plugin, which overrides the user's own selection. The adapter now reads it and records it as a deferred surface per bundle, so an author who asked for it is told; nothing applies it. The preconditions are S11's row on this same field in 2026-07-29-output-style-contract.md, whose first one — that plugin styles exist — Task 2 met: `force-for-plugin`

### 3b. Two rows in S11's plan that this slice made false

The register is regenerated from the plan and spec files, so a row left standing
keeps being reported. Both are in `2026-07-29-output-style-contract.md` and both
are false because of Task 2, which is why they are corrected there rather than
only mentioned here.

---

## 4. Gate

Focused suites for every changed file, plus `packages/shared/src/plugins`,
`packages/shared/src/prompts` and the capability aggregates;
`bun run typecheck:all`; `bun run lint`; i18n parity/sorted if you add strings;
`git diff --check`.

**Managed policy and system-prompt composition are both named risk triggers.**
Run the expanded set once on the final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe per task.** For Task 1, make the hook carve-out read the
allowlist again and the assertion above must go red.

---

## 5. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so — five executors
  have now done that correctly rather than shipping a known bug, and two of them
  caught their own security holes that way.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- **Another agent is working concurrently** on plugin authoring/status tooling
  (`plugin validate`, the CLI verbs, `management-service-v2`). Stay out of
  `management-service-v2.ts` and the CLI; your work is the adapter, the
  projection, the managed policy and `prompts/output-styles.ts`.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 6. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; whether the hook carve-out now has its documented subject and how you
proved it admits only the force-enabled set; which direction of the `false` case
you implemented; the category strings with proof they appear in the register; and
the mutation probes.
