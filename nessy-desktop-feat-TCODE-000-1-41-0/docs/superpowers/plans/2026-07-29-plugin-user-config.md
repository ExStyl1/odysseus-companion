# B1b — `userConfig`: parse it, store it safely, export it

The next B1 slice, chosen by the measured order in
`docs/superpowers/specs/2026-07-29-b1-audit.md`. Read that file's `userConfig`
section before starting — it costs the whole surface at 4–6 slices and names the
cheapest honest first one, which is this plan.

Today `userConfig` appears **exactly once** in the Claude adapter: as a row in
the deferral table. No option is parsed, nothing reaches the IR, no value is ever
collected, stored, substituted or exported.

---

## 0. Scope

**In:** parse the option schema into the IR; store values with the documented
sensitive/non-sensitive split; export them to hook processes as
`CLAUDE_PLUGIN_OPTION_<KEY>`; and reject `${user_config.*}` where the contract
says it must be rejected.

**Out, deliberately, and each gets a category string:** the substitution engine
for MCP/LSP configs and skill/agent content; per-channel `userConfig`; the
`--config key=value` install flag; the prompt-at-enable UI beyond what is needed
to collect a value at all.

The env export is the contract's **own recommended alternative** for the
shell-form case, which is why it is in the cheap slice: it makes `userConfig`
usable without any substitution engine.

---

## 1. Method rules

1. **Fetch the page yourself**: `curl -s https://code.claude.com/docs/en/plugins-reference.md`.
   Never a summarising fetch tool — it invented field names twice in this series
   and both shipped.
2. **The quotation is the identifier, not the line number.** Report where you
   found each; read the whole line.
3. **Read around each quotation.**
4. **Declared ≠ enforced.** Prove the export reaches a real hook process on
   **Pi**.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`; short three times,
   wrong once the other way.
7. **`rg` skips NUL-containing files silently; eight of ours have one** — tracker
   note 11a.

---

## 2. The contract, and the trap in it

The audit already extracted these; **verify each against your own fetch**.

The option schema has `type` (`string`, `number`, `boolean`, `directory`,
`file`), `sensitive`, `multiple`, and `min`/`max`. Sensitive values go to the OS
keychain; non-sensitive ones under `pluginConfigs` in **user** settings. Values
are exported to hook processes as `CLAUDE_PLUGIN_OPTION_<KEY>`, uppercased.

**The trap, and it is the reason this plan exists at all:**

> Entries in a project's `.claude/settings.json` or `.claude/settings.local.json`
> are ignored. Both files live in the workspace, so a cloned repository could
> supply values there, and those values would flow into plugin hook commands, MCP
> server configs, LSP commands, and monitor commands.

We are safe from that today **only because we read no plugin config from any
settings source at all.** And this repo already has a project-scoped overlay
pattern — `resolveRuntimeHookSources({ projectRoot, projectTrusted })` reads
workspace-resident config — which is the natural, and **wrong**, way to implement
this here.

So the settings-source restriction is not a nicety to add later. **It is part of
the first slice or the first slice ships the vulnerability.**

---

## 3. Tasks

### Task 1 — parse the option schema

**Commit:** `feat(plugins): a Claude plugin's userConfig options reach the IR`

A live parallel implementation already exists for the MCPB format
(`format-adapters/mcpb.ts` → `mcpb-configuration.ts` → `storage-runtime.ts`), and
no Claude-format plugin can reach it. **Widen that rather than building a
second.** The audit found the existing `PluginUserConfigurationDescriptor` lacks
`title`, `description`, `multiple`, `min`/`max` and the `directory`/`file` types,
and that `mcpb.ts` currently **rejects** `multiple` outright.

Reuse the containment validation B1a landed (`b81bbe45`) for `directory` and
`file` values — a plugin-declared path is untrusted input.

**Gate:** every documented `type`, plus `multiple`, `min`/`max` and `sensitive`,
parsed from a fixture bundle into the IR. Negative: an unknown `type` is refused
with a diagnostic, not silently dropped.

---

### Task 2 — store values where the contract says

**Commit:** `feat(plugins): userConfig values are stored by sensitivity, from trusted sources only`

- `sensitive: true` → the credential manager. (MCPB today puts *every* value
  there, which is stricter than documented but not the documented split — decide
  and say which you shipped.)
- Non-sensitive → a `pluginConfigs`-equivalent in **user** settings.
- **Project and local settings must be ignored, by construction.** Not "not read
  yet" — a named, tested refusal, so the next person to add a settings source
  does not accidentally admit them.

**Gate:** the security test is the point of this task. A value planted in a
project-scoped settings file must **not** be visible to a plugin. Write it as an
attack, not as a unit test of a helper.

---

### Task 3 — export to hooks, and refuse the shell forms

**Commit:** `feat(plugins): hook processes receive CLAUDE_PLUGIN_OPTION_<KEY>`

- Export every value into hook process environments with the documented name
  shape.
- **Reject `${user_config.*}` in the fields the contract says reject it** —
  shell-form hook commands and monitor commands — with the documented error
  rather than a substitution. Since the substitution engine is out of scope, this
  rejection is a *static parse check* and can land now; the audit is explicit
  that if `userConfig` ever gains substitution without this check already in
  place, a configured value silently reaches a shell.
- Sensitive values in the environment of a process is a real exposure. Say what
  you decided about exporting them and why.

**Gate:** a real hook subprocess reads the variable. Negative: a shell-form
command containing `${user_config.KEY}` is refused with the documented error.

---

### Task 4 — what this slice leaves

**Commit:** `docs(plugins): the userConfig surfaces this slice does not build`

Category strings for everything in § 0's "out" list, each with the cost the
audit measured, so the next slice can be planned from them rather than
re-derived.

**Unwrapped, unbolded, backtick-terminated**, then confirm:
`python3 scripts/regenerate-deviation-register.py | grep -i user_config`.

---

## 4. Gate

Focused suites for every changed file, plus `packages/shared/src/plugins`;
`bun run typecheck:all`; `bun run lint`; i18n parity/sorted if you add strings;
`git diff --check`.

**Credential handling is a named risk trigger.** Run the expanded plugin and
credential set once on the final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Never log a configured value**, sensitive or not — a non-sensitive option can
still carry a hostname or a path a user would not want in a log.

**Mutation probe:** admit project-scoped settings and the Task 2 attack test must
go red.

---

## 5. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **Two other agents are working concurrently**: one in
  `packages/shared/src/prompts/`, one in the sandbox/isolation code. Stay out of
  both. Your work is in `packages/shared/src/plugins/` and the credential store.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 5a. What this slice leaves

Every surface § 0 named as out, plus three the execution turned up, as category
strings in the register's grammar. Each carries the cost the B1 audit measured,
so the next slice is planned from these rather than re-derived.

- documented, not implemented — substitution of a configured user_config value into MCP and LSP server configs and into skill and agent content, which plugins/manifest-reference.md#environment-variables (was line 577 of the retired plugins-reference page) declares; the option schema, the sensitivity-split storage and the hook environment export all landed here, so the engine is the one remaining half, measured by the B1 audit at one slice: `${user_config.KEY}`
- documented, not implemented — the per-channel user_config a channels entry may declare, which plugins/manifest-reference.md#channels (was line 630 of the retired plugins-reference page) says uses the same schema as the top-level field; channels are still a wholly deferred surface here, so the option schema has nothing to hang off and the work belongs inside the channels slice: `channels[].userConfig`
- documented, not implemented — the install flag that sets one user_config option non-interactively, plugins/cli-reference.md#plugin-install (was line 943 of the retired plugins-reference page); there is no plugin install CLI surface in Nessy for the flag to ride, so it needs that surface before it needs anything else from this slice, measured at one slice: `--config key=value`
- documented, not implemented — the enable-time prompt dialog for user_config, which plugins/components.md#when-the-configuration-dialog-appears (was line 544 of the retired plugins-reference page) makes the whole point of the field; values are collected only through the existing configure API, and no renderer surface renders an option title, its description, a masked sensitive input or a directory picker, measured at one slice: `userConfig`
- documented, not implemented — the refusal of a user_config reference in an MCP headersHelper command, plugins/manifest-reference.md#environment-variables (was line 585 of the retired plugins-reference page) with the wording at errors.md:1384; headersHelper appears nowhere in this repository, so the field the guard protects is never parsed and the check has no place to run until MCP dynamic headers exist: `headersHelper`
- documented, not implemented — the refusal of a user_config reference in a monitor command, plugins/manifest-reference.md#environment-variables (was line 584 of the retired plugins-reference page) with the wording at errors.md:1378; monitor configs are recorded as a deferred surface and never parsed, so this check must ship inside the monitors slice the B1 audit sized as a subsystem: `experimental.monitors`
- documented, not implemented — the documented sensitive and non-sensitive storage split for MCPB user_config values; the MCPB adapter still routes every value to the credential manager, which is stricter than plugins/manifest-reference.md#where-values-are-stored (was line 589 of the retired plugins-reference page) rather than conformant, and loosening it would move already-stored secrets into a plaintext file: `user_config`
- documented, not implemented — MCPB user_config options that declare multiple, still refused outright by the MCPB adapter; Claude's multiple is an array of strings for one option and MCPB's is a repeatable argument inside an mcp_config, so widening the shared descriptor does not settle the MCPB semantics: `multiple`
- documented, not implemented — the required-ness of the title and description on a user_config option, plugins/manifest-reference.md#user-configuration (was line 569 of the retired plugins-reference page) and :570; an option that omits them is imported with a warning rather than refused, because refusing would cost the user a working option in order to enforce a caption: `title`

## 6. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; whether you widened the MCPB path or built beside it and why; the
sensitive/non-sensitive decision; what you decided about sensitive values in
process environments; the category strings with proof they appear in the
register; and the mutation probe.
