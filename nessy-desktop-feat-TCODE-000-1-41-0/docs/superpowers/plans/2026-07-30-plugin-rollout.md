# D13, D14, D15 — a mandated plugin that actually works on a workstation

Three rows, one story: **an organization mandates an internal plugin and it
does not work.** The marketplace cannot be delivered, so the plugin never
resolves; if it did, its token placeholder would reach the server as literal
text; and the user is never asked for the token in the first place.

D14 and D15 are two halves of one feature — **shipping either alone leaves it
broken**: a substituted token nobody was asked for is as useless as a token
collected and never substituted. Build them together.

## 0. Method rules

1. `curl -s` the pages — `plugins-reference.md`, `plugins.md`,
   `discover-plugins.md`, `settings.md`, `server-managed-settings.md`. Quote
   WHOLE lines.
2. **Declared ≠ enforced, and enforced ≠ reachable.** Name the production
   consumer. Prove on **Pi**, the shipped default.
3. **NUL bytes** — always `grep -a`; never `head -N` a grep whose hit count you
   have not counted.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`.
6. CDP instances are live on **9223 and 9224** — do not kill, drive or rebuild
   for either. Do not run `electron:build:servers` or `electron:dev`.

---

## 1. Task 1 — managed policy can deliver the catalogue (D13)

**Commit:** `feat(policy): managed policy delivers a plugin marketplace`

Managed policy can force-enable a plugin key and restrict sources but **cannot
supply the internal marketplace**, so every workstation must add it by hand
before a mandated plugin resolves — and **a force-enable of an uninstalled
plugin is a silent no-op the admin never sees.**

- Deliver the marketplace through the managed policy schema, composed with the
  source restrictions that already exist. Read how a marketplace is added today
  and reuse that path rather than building a second one.
- **The silent no-op is the honesty half and is worth as much as the delivery
  half.** A force-enable naming a plugin that is not installed must be visible
  — in `doctor` at minimum, since that is where this repo puts fleet-diagnosis
  answers. An admin who cannot see that their mandate did nothing is the same
  defect class as a policy key with no reader.
- **A delivered marketplace is a code-distribution channel.** Whatever
  containment an interactively-added marketplace has — trust, source
  validation, the install gates — a delivered one gets the same or more, never
  less. Say in the report which gates apply and how you verified.
- **Never install or execute a plugin fetched from the network in a test.**
  Local fixtures only.

**Gate:** a managed policy naming a marketplace makes a mandated plugin
resolvable without a manual step; a force-enable of an uninstalled plugin
produces a visible finding; a delivered marketplace passes the same gates an
added one does. **Mutation:** drop the delivery → the resolve test goes red.

---

## 2. Task 2 — `${user_config.*}` is substituted everywhere it is documented (D14)

**Commit:** `fix(plugins): a plugin's user config reaches its MCP, LSP and skill surfaces`

Only hook processes read configured values, so a plugin whose MCP/LSP config or
skill body carries `${user_config.TOKEN}` ships the **literal placeholder** to
the server and fails to authenticate at the first tool call. That is exactly how
an internal plugin talks to an internal service.

- Read the page for every documented substitution site and cover them. Quote the
  line that lists them.
- **A configured secret must not become loggable.** The value substitutes into
  a server config and a skill body; make sure it does not then appear in a
  transcript, a diagnostic, a receipt or a log line. There is existing redaction
  machinery — find it and say whether it covers these sites.
- **`${user_config.*}` inside a `headersHelper` command is documented as
  REFUSED** (`errors.md`) and that refusal already exists for monitors — check
  whether it applies here and keep it.
- An unset key must not substitute to empty and silently authenticate as
  nobody. Decide: refuse the capability with a stated reason, or leave the
  placeholder. Say which and why.

**Gate:** a plugin declaring `${user_config.TOKEN}` in an MCP config, an LSP
config and a skill body gets the configured value in all three; an unset key
behaves as stated; the value appears in no log, transcript or diagnostic.
**Mutation:** stop substituting at one site → that site's test goes red.

---

## 3. Task 3 — the user is asked before they are broken (D15)

**Commit:** `feat(plugins): a plugin that needs configuration asks for it at enable`

`PluginInfoPage` collects values and masks secrets but **labels every field
with the raw key**, never renders the imported title/description, and **nothing
prompts at enable**. A user turns on a plugin that needs a token, is told
nothing, and hits an auth failure at first use with no hint where to fix it.

- Render the imported `title` and `description` the adapter already carries —
  B1b landed them and nothing shows them.
- Prompt at enable when a required key is unset. The prompt must be
  answerable-or-dismissable without leaving the plugin half-enabled in a state
  nobody can explain.
- **A secret field must stay masked and must not be recoverable from the DOM,
  the playground state or a diagnostic.**
- The playground is a design surface in this repo: add the states (required key
  unset, optional key unset, secret field, imported description present and
  absent).
- i18n: keys in every locale, parity + sorted green.

**Gate:** enabling a plugin with a required unset key prompts, naming the field
by its imported title; the value round-trips to Task 2's substitution; a secret
stays masked; a plugin needing nothing enables silently as before.
**Mutation:** drop the enable-time prompt → its test goes red.

---

## 4. Task 4 — category strings

**Commit:** `docs(audit): what the plugin rollout work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters.

### 4a. What this plan leaves

Six strings, each measured against the code as committed. Three are divergences
this work chose on purpose and states here rather than in a comment nobody
greps; two are documented behaviour a task did not reach; one is a bound the
existing result-redaction set imposes on a value D14 newly puts in reach of it.

- deliberate divergence, stated — a delivered marketplace registers on the first marketplace read rather than at bootstrap, so a process that never browses, lists or resolves a catalog item never writes the row. Every path that could observe one ensures it first, and there is no second registration path to drift: `ensureDeliveredMarketplaces`
- deliberate divergence, stated — an entry whose declared source is a host pattern or an inline settings catalogue is dropped with a recorded reason. A pattern recognizes sources but names none, and the inline catalogue format has no reader here, so registering either would produce a marketplace whose catalogue can never load: `deliveredMarketplaceSource`
- documented, not implemented — delivery registers the marketplace and never installs the plugin, so a mandated plugin still needs one install per workstation. The page puts installation behind explicit consent; what changed is that doctor now names an unfulfilled mandate instead of the no-op being silent: `resolveMandatedPluginFindings`
- ours, bounded — a sensitive value substituted into an MCP command, argument, working directory or URL sits outside the pool's result-redaction set, which is built from the final headers and env values only. The value is still substituted and the author is warned by key and by field: `plugin.user_config.unredacted_sink`
- documented, not implemented — a multiple-valued string option cannot be filled in from the configuration form at all: the input yields one scalar and the store requires an array, so the save is refused as invalid. Only a single-valued option is settable through the UI: `multiple`
- deliberate divergence, stated — a global-scope enable raises no prompt, because there is no workspace to read a stored value against and the credential identity is workspace-scoped. Workspace and project enables prompt, and the plugin's own page stays the answer for the global case: `enableTimeConfiguration`

## 5. Gate

Focused suites per changed file; the plugins, capabilities, config and renderer
aggregates once on the final diff; `bun run typecheck:all` **exit 0 with zero
`error TS`, stated explicitly**; `bun run lint`; i18n parity + sorted;
`git diff --check`.

**Managed policy and credential handling are named risk triggers** — run the
expanded set once on the final diff.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
One row is NOT on that list and belongs to your area: `Pi harness R0 baseline >
pins all MCP rows against the actual current client surface` — `117746a5` added
six `NessyMcpClient` methods without updating the fixture. **Fix that pin**; it
has been failing all day with no owner.

## 6. Constraints

- You own `packages/shared/src/plugins/**`, `packages/shared/src/capabilities/**`,
  `packages/shared/src/marketplace/**`, the renderer's plugin pages and their
  playground entries, and `packages/pi-agent-server/src/__tests__/harness-contract/**`
  for the pin above.
- **A sibling executor owns `managed-policy.ts`, `permissions-config.ts`,
  `permission-dsl.ts`, `server-core/src/bootstrap/**` and `SessionManager.ts`
  — and D13 will want the managed schema.** Coordinate by reporting the exact
  edit as a residual rather than editing, unless the file is clean and you can
  commit within minutes. Another sibling owns `session-tools-core/src/runtime/**`
  and `pi-harness/isolation*`; a third owns `scripts/cdp/**`. Stay out.
- **A pathspec commit takes the WORKING TREE, not your hunks.** Two executors
  crossed on one file earlier today and each landed under the other's subject.
  Commit promptly; if a file is dirty with work that is not yours, report it
  rather than committing it.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- Do not touch `docs/superpowers/specs/` or the CDP checklist. No version bumps.
  Never write `~/.nessy/dp_auth_creds.json`.
- **Never install or execute a plugin fetched from the network**; never point a
  probe at a real external host or a real marketplace; **never print a
  configured secret value**, even a fixture one.
- Code, comments and commits in English.

## 7. Report

Commit shas; each defect reproduced; which gates a delivered marketplace passes
and how you verified; every substitution site covered and whether redaction
reaches them; the unset-key decision; the enable-prompt flow; whether you fixed
the MCP client pin; residuals word for word; corrections to this plan; mutation
probes with which side went red; the explicit typecheck statement.
