# R16 — The Codex adapter, against whatever specification actually exists

Parity row **R16**. **Research first, build second, and the research may well
conclude that there is nothing to build against.**

Why this row is in scope even though the Codex *agent* is behind an off-by-default
flag: `format-adapters/codex.ts` has **zero** occurrences of
`isCodexRuntimeEnabled`, and is reached from `format-adapters.ts` on the ordinary
plugin-import path. A Codex-format plugin is normalised into our IR and served to
**Pi** whether or not the Codex runtime flag is on. Installing Codex plugins is
live functionality; the Codex agent is what is flagged off.

---

## 0. Method rules

1. **Fetch sources yourself** with `curl -s`. Never a summarising fetch tool —
   it invented field names twice in this series and both inventions shipped.
   That failure is the whole reason this row exists in this shape.
2. **The quotation is the identifier, not the line number.** Read the whole line.
3. **Declared ≠ enforced.** Prove any claimed reader runs on **Pi**.
4. **Two git commands** — pathspec on the `commit`.
5. **`rg` skips NUL-containing files silently; eight of ours have one** — tracker
   note 11a. Use `grep -a` for absence claims.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`; it has been short
   three times and wrong once the other way.

---

## 1. Task 1 — find out whether a contract exists

**Commit:** `docs(plugins): what specification the Codex plugin format actually has`

Search, and **record what you find and what you do not**:

- the OpenAI documentation site, for anything describing the plugin format;
- the `openai/plugins` repository — its own docs, any JSON Schema, its README,
  its release notes, its tests;
- any shipped schema file in a published package;
- real manifests in the wild, which are evidence of practice even without a spec.

**The honest outcome may be "there is no published specification."** If so, say
that plainly and stop looking — this row was written expecting that answer to be
possible, and a fabricated contract is worse than a documented absence. Our
adapter's own history says why: it was derived empirically, and nowhere in the
repository does it say so, which means the next person to change it will not know
there is nothing underneath.

Write the finding into `docs/superpowers/specs/` — **no, do not**: that tree is
planner-owned. Write it into this plan file's § 4 and into a comment at the head
of `format-adapters/codex.ts`, which is where someone editing the adapter will
actually look.

---

## 2. Task 2 — whichever of these the answer selects

### If a real contract was found

**Commit:** `feat(plugins): the Codex adapter follows its published contract`

Plan it field by field the way the Claude adapter was planned against
`plugins-reference.md`: every documented field, its shape, and either a live
reader or a category string. Report a table of field → our handling → verdict.

### If no contract was found

**Commit:** `test(plugins): a conformance suite over real Codex manifests`

Build the honest alternative:

- a conformance suite over **real** manifests you collected in Task 1, asserting
  what our adapter does with each — so a future change that breaks a real plugin
  fails a test rather than a user;
- a written statement, at the head of `codex.ts`, that the adapter is
  **empirical**: derived from observed manifests, not from a published contract,
  with the date and what was searched. This is the deliverable that stops the
  next person assuming a spec exists.
- a category string recording the absence.

Do **not** invent fields, and do not port Claude's field names across on the
assumption the formats are similar. Two units in this series already found that
Codex spells things differently (`tool_timeout_sec` for what Claude calls
`timeout`), and one found the Codex adapter carrying an agent-hook defect
identical to Claude's that was deliberately **not** fixed by copying Claude's
solution, precisely because the format is empirical.

---

## 3. Task 3 — the divergences already on file

**Commit:** `docs(plugins): the Codex-format divergences we carry deliberately`

Three are already recorded elsewhere in this series and belong in one place:

- Codex's `tool_timeout_sec` versus Claude's `timeout` (fixed, `codex.ts`);
- the Codex adapter's agent-hook defect, identical to the one S8 fixed on the
  Claude side and **deliberately left**, because guessing at an empirical format
  is how the invented-field bug started;
- Codex's `declaresDefaultPath` replace-versus-extend decision, which B1a found
  was **already working** for Codex manifests while the Claude adapter had none —
  a case where Codex was ahead.

Category strings, unwrapped, unbolded, backtick-terminated. Confirm with
`python3 scripts/regenerate-deviation-register.py | grep -i codex`.

---

## 4. Findings (Task 1, 2026-07-29)

**There is a published specification.** The premise this plan was written to
allow for — "the Codex plugin format has no public contract, our adapter is
empirical" — is **false as of 2026-07-29**, and the repository's own statement of
it (`AGENTS.md`: "the help article is not publicly fetchable, so
`github.com/openai/plugins` and real manifests are the practical contract there —
which is why the Codex adapter is derived empirically") is the reason nobody had
looked. That sentence is half-true in a way that misleads: the *help-centre*
article is bot-blocked, but the format is documented in full on the OpenAI
developer docs site, and every page has a machine-readable Markdown twin.

### What was searched, and what each source yielded

Every fetch below was `curl -s`. No summarising tool was used.

| Source | Result |
| :-- | :-- |
| `https://help.openai.com/en/articles/20001256-plugins-in-codex/` | **HTTP 403** — bot-blocked. This is the URL `AGENTS.md` and `fixtures/format-adapters/SOURCE.md` cite, and the only one anybody had tried. |
| `https://developers.openai.com/llms.txt` | **HTTP 200**, 106 KB. Full index; documents that "Markdown versions of documentation pages are available by appending `.md` to the page URL". 33 plugin pages listed. |
| `https://developers.openai.com/plugins/build/plugins.md` | **HTTP 200**, 23 KB. *Package your plugin* — **the manifest specification**: `.codex-plugin/plugin.json`, complete example manifest, § *Manifest fields*, § *Path rules*, § *Bundled MCP servers and lifecycle hooks*, and the whole marketplace format. |
| `https://learn.chatgpt.com/docs/hooks.md` | **HTTP 200**, 39 KB. **The hook specification**: § *Plugin-bundled hooks* gives the `hooks` manifest field's four accepted shapes, the default file, and replace-not-extend precedence; § *Config shape* gives handler fields; twelve `### <Event>` sections give the event schema. |
| `https://developers.openai.com/plugins/deploy/submission-errors.md` | **HTTP 200**, 68 KB. **A field-by-field validation contract** — ~150 named errors with per-field type, requiredness, length and format rules for the manifest, `interface`, `.app.json`, skills and `agents/openai.yaml`, plus a *Package warnings* table naming what the loader **ignores**. |
| `https://developers.openai.com/codex/plugins.md` | HTTP 200, 10 KB. End-user page (install/uninstall/permissions). No format content. Mirrored at `learn.chatgpt.com/docs/plugins.md`. |
| `https://developers.openai.com/codex/build-plugins.md` | HTTP 200, 4.5 KB. Introductory; points at the builder docs. Mirrored at `learn.chatgpt.com/docs/build-plugins.md` — the URL `SOURCE.md` cites, which **is** fetchable and always was. |
| `github.com/openai/plugins` (`api.github.com` tree, then the `main` tarball) | 8 022 entries. **180 real published manifests** at `plugins/*/.codex-plugin/plugin.json`, 154 `.app.json`, 8 `.mcp.json`, 2 root `hooks.json`. Read as data; nothing installed or executed. |
| `openai/plugins` → `.agents/skills/plugin-creator/references/plugin-json-spec.md` | **A second, independent field guide** — the reference the official `@plugin-creator` skill itself reads. Per-field types for the manifest, `interface` and the marketplace entry. |
| `openai/plugins` → `.agents/skills/plugin-creator/scripts/create_basic_plugin.py` | The official scaffolder. Authoritative for which fields a generated manifest carries. |
| `openai/plugins` → `plugins/plugin-eval` (v0.1.2, `src/evaluators/plugin.js`) | **The only executable contract artefact that exists** — OpenAI's own published plugin-quality evaluator, which reads `.codex-plugin/plugin.json` and fails a plugin for a non-kebab-case `name`, a `name` that disagrees with its directory, any of ten missing `interface` fields, or a `skills`/`hooks`/`mcpServers`/`apps`/`interface.composerIcon`/`interface.logo` value that is not a `./`-prefixed in-root path. Closest thing to a schema; it is code, not a schema. |

**Negatives — searched, nothing there.** Recording these so the next person does
not repeat the search:

- **No JSON Schema for the plugin manifest exists anywhere.** Not on the docs
  site, not in `openai/plugins` (`grep -rl '"$schema"' --include=plugin.json`
  matches nothing), not in a published npm package. The 40-odd `*.schema.json`
  files in that repo all belong to individual plugins' own payloads
  (`codex-security/schemas/findings.schema.json`, the `nvidia` skill reports) —
  none describes `plugin.json`. Our adapter accepts a `$schema` key; nothing
  upstream emits one. The nearest substitute is `plugin-eval`'s hand-written
  JavaScript checks, which are a linter rather than a grammar and are themselves
  incomplete — its path check rejects any non-string `hooks`, so it would fail
  the array and inline-object forms `hooks.md` explicitly permits.
- **`openai/plugins` has no README section, no docs directory, no release notes
  and no tests describing the format.** The repo is a plugin catalogue; the only
  format material in it is the `plugin-creator` skill above.
- **No manifest in the wild uses `hooks`.** All 180 declare only
  `name`/`version`/`description`/`author`/`keywords`/`interface` plus
  `repository`(179), `license`(179), `homepage`(177), `apps`(154), `skills`(72),
  `mcpServers`(8). Zero use `hooks`, `lsp`, `commands`, `settings`, `assets`,
  `install`, `connectors`, `id`, `pluginId`, `capabilities` or `$schema`.
- **No hook in the wild is anything but `type: "command"`.** The two real
  `hooks.json` files (`figma`, `replayio`) use `command` only, and `hooks.md`
  documents no other handler type. See § 4.3.
- **Codex CLI is not open source**, so there is no source-level contract to read
  the way there is for the Claude adapter; the docs plus the catalogue are it.

### 4.1 What the specification says, and where

The three load-bearing pages, quoted rather than paraphrased:

- `plugins/build/plugins.md` § *Plugin structure*: "Every plugin has a manifest
  at `.codex-plugin/plugin.json`." — "Only `plugin.json` belongs in
  `.codex-plugin/`. Keep `skills/`, `hooks/`, `assets/`, `.mcp.json`, and
  `.app.json` at the plugin root."
- `plugins/build/plugins.md` § *Bundled MCP servers and lifecycle hooks*:
  "`mcpServers` can point to an `.mcp.json` file that contains either a direct
  server map or a wrapped `mcp_servers` object."
- `learn.chatgpt.com/docs/hooks.md` § *Plugin-bundled hooks*: "By default, Codex
  looks for `hooks/hooks.json` inside the plugin root. A plugin manifest can
  override that default with a `hooks` entry in `.codex-plugin/plugin.json`. The
  manifest entry can be a `./`-prefixed path, an array of `./`-prefixed paths, an
  inline hooks object, or an array of inline hooks objects." — and "If a manifest
  defines `hooks`, Codex uses those manifest entries instead of the default
  `hooks/hooks.json`."

### 4.2 Where the specification contradicts itself

Two OpenAI sources disagree, and the disagreement decides real behaviour, so it
is recorded rather than resolved by preference:

- **Defaults: replace or extend?** `hooks.md` says a manifest `hooks` entry is
  used "instead of the default". `plugin-json-spec.md:94` says "`skills`,
  `hooks`, and `mcpServers` are supplemented on top of default component
  discovery; they do not replace defaults". We follow `hooks.md` for `hooks` (it
  is the specific page, and narrowing is the safe direction) and
  `plugin-json-spec.md` for `skills`/`mcpServers` (which is also what B1a
  already implemented).
- **Undeclared root files.** `submission-errors.md` § *Package warnings*:
  "`undeclared_mcp_manifest_ignored` — A root `.mcp.json` is imported only when
  the plugin-manifest `mcpServers` field is set to `./.mcp.json`", and the same
  for `.app.json`. `plugin-json-spec.md:94` says the opposite for `mcpServers`.
  See the divergence recorded in § 8.

### 4.3 The `hooks.json`-at-plugin-root problem, which the docs do not admit

`hooks.md` says the plugin default is `hooks/hooks.json`. **No plugin in
`openai/plugins` has that file.** The only two real plugin hook files —
`plugins/figma/hooks.json` and `plugins/replayio/hooks.json` — sit at the plugin
*root*, and neither manifest declares a `hooks` entry, so under the documented
rule neither would ever load. `plugin-json-spec.md:18` samples
`"hooks": "./hooks.json"`, i.e. the root file, which suggests the root form is
real and simply undocumented (or that both plugins' hooks are dead). Our adapter
defaulted to the root file only, which is why it loads those two plugins' hooks
and misses the documented one. It now checks both — see § 8.

### 4.4 Codex has no agent, prompt, http or mcp_tool hooks

`hooks.md` documents exactly one handler type. Every example in that page —
seven JSON blocks and five TOML blocks — is `type = "command"`, and the field
list in § *Config shape* describes `command`, `commandWindows`, `timeout`,
`statusMessage` and `additionalContextLimit`, all command-hook fields. There is
no `prompt`, `agent`, `http` or `mcp_tool` handler in the Codex contract, and no
real manifest declares one.

**This settles the open question this plan's § 3 inherited.** The
`hook-context-injection` plan left the Codex agent-hook defect unfixed and said
it "needs a real Codex manifest to settle the field name before either half can
be fixed". The answer is that there is no field name to settle: Codex agent hooks
do not exist. `codex.ts`'s `prompt`/`agent`/`http`/`mcp` branches are Nessy
extensions over the Codex format, not a reading of it, so the branch that demands
`agent`/`agentName`/`name` cannot be diverging from Codex — it can only diverge
from *us*. Copying Claude's `prompt` fallback across would have been inventing a
Codex field, exactly as feared. **Correct resolution: leave the branches, label
them as extensions.** Recorded in § 8.

### 4.5 What the empirical derivation got right

Worth stating, because it is the reason so little needed changing. Every field
the adapter reads from a real `.mcp.json` — `type`, `url`, `command`, `args`,
`env`, `cwd`, `env_vars`, `tool_timeout_sec`, `oauth_resource`,
`bearer_token_env_var` — appears in the eight real files and is handled
correctly, `tool_timeout_sec` included. All twelve documented hook events are in
`CODEX_HOOK_EVENT_MAP`. Every documented top-level manifest field is in
`CODEX_KNOWN_FIELDS`, so a spec-conformant manifest raises no unknown-field
warning. Running the adapter over the real `figma`, `codex-security` and
`replayio` bundles produces the expected skills, MCP servers, apps, connectors
and hooks with no unexpected diagnostic. The gaps found are all in shapes that no
published plugin happens to use — which is precisely what deriving a format from
a corpus cannot catch, and the argument for reading the contract.

---

## 5. Gate

Focused suites for `packages/shared/src/plugins`; `bun run typecheck:all`;
`bun run lint`; `git diff --check`.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Never install or execute a plugin you found in the wild.** Read its manifest as
data. A real manifest collected for a conformance fixture is text, not something
to run.

---

## 6. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **Another agent may be working in the sandbox/isolation code and
  `packages/server-core/src/sessions/`.** Stay out. Your work is
  `packages/shared/src/plugins/format-adapters/`.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 7. Report

What you searched and what each source yielded — including the negatives, which
are the point; which branch of Task 2 the answer selected and why; the field
table or the conformance inventory; **every correction to this plan**; the
category strings with proof they appear in the register.

---

## 8. The Codex-format divergences we carry deliberately (Task 3)

Everything below is measured against the contract found in § 4, not against the
Claude adapter. Where a row is closed it says so and carries no category string;
a category string means the gap is open.

### 8.1 The three this plan inherited

**`tool_timeout_sec`, not `timeout` — closed, and now confirmed against the
spec.** Codex spells the MCP tool timeout `tool_timeout_sec` where Claude spells
it `timeout`. `codex.ts` reads `tool_timeout_sec`, validates it as an integer in
1..86 400 and stores `toolTimeoutMs`. The real
`plugins/codex-security/.mcp.json` in `openai/plugins` declares
`"tool_timeout_sec": 900`, and running the adapter over that bundle yields
`toolTimeoutMs: 900000`. Not a deviation.

**The agent-hook defect — closed, because its premise was refuted.** The
`hook-context-injection` plan left `codex.ts`'s agent-hook branch demanding
`agent`/`agentName`/`name` while the Claude side was fixed to accept `prompt`,
and justified it: Codex's format "is derived empirically … so there is no page
saying its agent hooks carry `prompt`", and it "needs a real Codex manifest to
settle the field name before either half can be fixed". Both halves of that are
now answered, and the answer is that **the question does not apply**: `hooks.md`
documents exactly one handler type, `command`, across all twelve of its examples,
and none of the 180 published manifests declares any hook at all — the only two
real hook files use `command` only. Codex has no agent hooks, no prompt hooks, no
http hooks and no `mcp_tool` hooks. `codex.ts`'s branches for those are Nessy
extensions layered over the Codex format, so they cannot diverge from Codex, and
copying Claude's `prompt` fallback across would have invented a Codex field —
precisely the failure that plan was avoiding. **Action for the planner:** the
`documented, not implemented` row in
`docs/superpowers/plans/2026-07-29-hook-context-injection.md` is now settled and
should be closed; this executor did not edit another unit's plan to do it.

**`declaresDefaultPath` replace-versus-extend — closed, and refined.** B1a found
Codex already extended defaults where the Claude adapter had no default handling
at all, and it was right for the fields it checked: `plugin-json-spec.md:94` says
"`skills`, `hooks`, and `mcpServers` are supplemented on top of default component
discovery; they do not replace defaults". But `hooks.md` § *Plugin-bundled hooks*
says the opposite for hooks specifically — "If a manifest defines `hooks`, Codex
uses those manifest entries instead of the default `hooks/hooks.json`" — so hooks
now replace and `skills`/`mcpServers`/`apps` still extend. Two OpenAI sources
genuinely contradict each other here; we follow the specific page and the
narrower behaviour, and an empty declaration still defines nothing.

### 8.2 Open divergences from the published contract

**A root `.mcp.json` or `.app.json` is imported ALONGSIDE a manifest that
declares some other path or an inline object.** Resolved at P3.372, against the
SOURCE rather than by preference between two contradicting pages — the standoff
that left this open (`submission-errors.md`'s `undeclared_mcp_manifest_ignored`
vs `plugin-json-spec.md:94`) expired when AGENTS.md settled that for codex the
source outranks the page. Read at `github.com/openai/codex`, `rust-v0.148.0`,
`codex-rs/core-plugins/src/loader.rs`: `plugin_mcp_config_paths` returns
`vec![path]` for a declared `PluginManifestMcpServers::Path` and otherwise falls
through to `default_mcp_config_paths`, which takes the root `.mcp.json` if it is
a file; the `::Object` arm of `load_plugin_mcp_servers_from_manifest_with_format`
reads the inline map and never reaches the default at all;
`plugin_app_config_paths` has the same shape over `manifest_paths.apps`.

Two findings, pointing opposite ways:

1. **An UNDECLARED root file IS loaded by the CLI.** So
   `undeclared_mcp_manifest_ignored` does not describe the loader — on this
   evidence it is a publishing-side warning, which is the null the row allowed
   for. We keep importing it, and it is no longer a divergence. The reading is
   recorded in `codexUndeclaredRootImport`'s docblock in
   `format-adapters/codex.ts`, and the branch — which every codex fixture had
   missed, all of them writing the DECLARED case — is now covered by
   `plugins/__tests__/codex-undeclared-root.test.ts`.
2. **A DECLARED entry REPLACES the default rather than extending it**, so
   `plugin-json-spec.md:94` is wrong for this field too, and our importing the
   root file beside a declaration is a real widening over an executable
   declaration. It is KEPT, because narrowing it would drop servers from bundles
   installed here today with nothing said — the same defect from the other side —
   and it is now disclosed by a named warning,
   `plugin.format.codex_undeclared_root_import`, which reaches the install
   summary through `compatibility.adapter.warnings`. Category:
   `documented, not implemented — codex loads a root .mcp.json or .app.json only when the manifest declares no entry of its own; we import it alongside a declaration of another path or an inline object, so a server dead on codex is live here. Kept deliberately — narrowing would silently disable servers in bundles installed today — and disclosed by plugin.format.codex_undeclared_root_import`

**`.agent-plugin/plugin.json` is not a recognised manifest location — CLOSED,
and this entry outlived its own fix by carrying a deviation record into the
generated register for as long.** When written, the third of the three locations
`submission-errors.md`'s `plugin_manifest_missing` names — the archive "must
contain `.codex-plugin/plugin.json`, `.agent-plugin/plugin.json`, or
`.claude-plugin/plugin.json`" — had no reader, and the entry deferred the fix
because detection lives outside this row's file scope. It has since landed:
`AGENT_MANIFEST_RELATIVE_PATH` in `format-adapters.ts` sits in
`CODEX_ADAPTER_MANIFEST_CANDIDATES` (as the fallback, never an override), in
`BUNDLE_MANIFEST_CANDIDATES` as the `agent` label, and in
`marketplace/repository-install.ts`'s manifest list. Driven at P3.372 on a bundle
whose ONLY manifest is `.agent-plugin/plugin.json`, rather than re-read:
`detectPluginFormat` → `{detected: true, adapterId: 'codex-plugin-json'}` and
`normalizePluginBundle` → `ok: true`. The category string is removed with the
claim, so `scripts/regenerate-deviation-register.py` stops harvesting a
divergence that no longer exists.

**The `interface` block is read for four fields out of sixteen.** We take
`displayName`, `shortDescription`, `developerName` and `websiteURL`.
`submission-errors.md` § *Listing and interface errors* additionally specifies
`longDescription`, `category` (from a closed list of thirteen), `capabilities`,
`defaultPrompt` (string or list, at most three), `brandColor`, `brandColorDark`,
`composerIcon`, `logo`, `privacyPolicyURL`, `termsOfServiceURL` and `supportURL`;
`logoDark` appears in 42 real manifests without being documented. All 180 real
manifests carry `longDescription`, `category`, `capabilities` and `defaultPrompt`.
These are presentation and legal-link metadata with no consumer in our IR today.
Category:
`documented, not implemented — twelve specified interface fields including category, capabilities, defaultPrompt, the brand colours, the icon and logo paths and the three legal-link URLs are dropped at normalization, so every published Codex plugin loses the listing metadata it ships`

**Four documented publisher/discovery fields are not read.** § *Manifest fields*:
"`author`, `homepage`, `repository`, `license`, and `keywords` provide publisher
and discovery metadata." We read `homepage` and `author.name`; `repository`,
`license`, `keywords` and `author.email`/`author.url` have no reader. All four
are validated by `submission-errors.md` (`plugin_author_url_not_https`,
`plugin_author_email_too_long` and so on) and all 180 real manifests carry
`keywords`, 179 carry `repository` and `license`. Same class as the `interface`
row above — catalogue metadata with no consumer in our IR — but listed separately
so the field table has no silent holes. Category:
`documented, not implemented — the repository, license and keywords fields and the author email and url subfields are dropped at normalization, so a Codex plugin importing here loses its licence and its discovery tags`

**Two documented command-hook fields are not read.** `hooks.md` § *Config shape*
specifies `additionalContextLimit` — how much additional context a command hook
may return before Codex spills it to disk and sends a preview — and
`commandWindows` (TOML `command_windows`), a Windows-only command override.
Neither has a reader, so a Codex hook that relies on either behaves differently
here. Category:
`documented, not implemented — a Codex command hook carrying additionalContextLimit gets the host default instead of its declared budget, and one carrying commandWindows runs its POSIX command on Windows`

**`agents/openai.yaml` is ignored.** `submission-errors.md` § *Skill agent
metadata errors* specifies a per-skill interface at
`skills/<skill>/agents/openai.yaml` in snake_case — `display_name`,
`short_description`, `icon_small`, `icon_large`, `default_prompt` — with fourteen
named validation errors, and states that "Skill interface settings must use the
`interface` mapping in `agents/openai.yaml`; `metadata` in `SKILL.md` doesn't
configure the interface". Fourteen real plugins ship one. We read neither the
per-skill file nor the plugin-root one, so a Codex skill's display name and icon
fall back to its slug. Category:
`documented, not implemented — the snake_case skill interface file that Codex validates with fourteen named errors has no reader, so a bundled Codex skill shows its slug rather than the display name and icon it ships`

### 8.3 Extensions we keep, which are not deviations

Recorded so a later reader does not mistake them for gaps and "fix" them towards
the spec.

- **The root `hooks.json` default.** Undocumented as a *plugin* default —
  `hooks.md` names `hooks/hooks.json` for plugins and reserves bare `hooks.json`
  for config layers — but it is the only form that exists in practice, in both
  real hook files in `openai/plugins` and in `plugin-creator`'s own sample. We
  now read the documented default *and* keep this one.
- **`prompt`, `agent`, `http` and `mcp_tool` hook types**; **the root
  `commands/` and `agents/` directory scans**; **the `lsp` field**; **the
  `nessyExtensions`, `settings`, `assets`, `install`, `connectors`, `id` and
  `pluginId` manifest fields**. None appears in the Codex contract and none is
  used by any published manifest. `commands/` and `agents/` do exist in six and
  fourteen real bundles respectively, so the scans are grounded in practice even
  though no page describes them — but note that twelve of those fourteen
  `agents/` directories contain only `openai.yaml`, which is interface metadata
  and not an agent at all.
