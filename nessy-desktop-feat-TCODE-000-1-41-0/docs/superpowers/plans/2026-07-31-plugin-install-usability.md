# Plugin install → usable: close the gap the owner hit with nessy-default-extension

**The complaint, verbatim in spirit:** "the user installs a plugin and should be
able to use it (passing whatever auth is genuinely required) — today they must
also hand-create a source per MCP, which makes plugins barely usable."

**Measured 2026-07-31** on a real install of `nessy-default-extension` 1.0.9
(14 MCP servers) through the product's own boundary
(`PluginsPage → useMarketplaceInstall → MarketplaceService.install →
PluginManagementServiceV2.installUnlocked`), plus comparative installs of a
Claude-format plugin (context7-style), a Codex-format plugin (codex-security)
and the third-party honey plugin. Adversarially verified: every code site read,
every doc line re-curled; the corrections were line-number drift only.

**Net result: 2 of 14 servers usable with zero user action.** The pure
Claude-format and Codex-format plugins were fully usable from one install call —
the defect is concentrated in remote/auth-bearing MCP.

## 0. The measured defect chain (each stop is a task below)

1. **Install is SILENT about what it leaves broken.** `installUnlocked` activates
   immediately ("Installation is the consent boundary",
   `management-service-v2.ts:199-203`), returns `ok:true` with empty diagnostics
   and **no authRequests** — because the install-result assembly
   (`connectorOnInstallAuthRequests`, `storage-runtime.ts:214-232`, filtered to
   `timing: 'ON_INSTALL'` at `:224`) reports only ON_INSTALL timing while both
   adapters hardcode `ON_FIRST_USE` (`format-adapters.ts:1269`,
   `codex.ts:1035`). The plugin looks cleanly installed; 12 of 14 servers are
   not usable.
2. **Per-server, per-WORKSPACE Source sprawl.** `syncConnectorSourcesOnEnable`
   (`management-service-v2.ts:547`) → `materializeConnectorSources`
   (`connector-source-materializer.ts:373`, dedupe key
   `${connector.id}#${server.serverName}` `:401`) creates one Source per HTTP
   server in EVERY workspace; 3 of 4 park immediately as disabled
   `credential-missing` (`resolver.ts:1529`).
3. **The only auth surface is a turn-terminating interrupt.** The model must
   call `source_oauth_trigger` (`tool-defs.ts:971`) → `beginAuthRequest` →
   `interruptForHandoff(AbortReason.AuthRequest)`; the user clicks through the
   card + browser OAuth and the session resumes — once **per server per
   workspace**, because credential ids key on `{workspaceId, sourceId}`
   (`credential-manager.ts:346-350`). Two nominally-existing alternatives are
   practically dead: the `action/oauth/<slug>` route has no production link
   producer, and the install/enable `authRequests → performOAuth` path never
   fires (see 1).
4. **dp-backed stdio servers (9 of 14) vanish silently.**
   `runtime-pool-servers.ts:326-329` drops them when dp is not ready (`:543-544`
   when the binary is absent — no downloader by frozen decision); the user's
   FIRST message send is then held by `preflightDpAuth` (`SessionManager.ts:8037`)
   raising the "Sign in to Developer Platform" card. One shared dp login
   unblocks all nine — and nothing says so before the first send.
5. **Claude-adapter remote MCP has NO auth path at all.** `claude.ts:1038` keeps
   `.mcp.json` entries as `kind:'mcp'` capabilities; a missing credential env
   silently omits the server (`runtime-pool-servers.ts:256`, debug-only). No
   card, no badge, no OAuth slot — hand-creating a Source is today the ONLY way
   to give such a server an OAuth flow. **This is the owner's literal
   complaint.**
6. **The userConfig dialog fires only on the separate ENABLE RPC**
   (`management-service-v2.ts:259`, `usePluginConfigurationPrompt.tsx:54`); the
   install-with-activation path never raises it, so config-needing servers sit
   at `user-config-missing` (`resolver.ts:1740-1742`) with no prompt.
7. Minor: stdio connectors permanently `connector-stdio-deferred`; zero-auth
   servers still wait for connect-intent (`awaitConnect:false`,
   `SessionManager.ts:15235` — the bank start policy); doubled install
   diagnostics (npx installer, Codex app warnings ×2).

## 0a. The contracts we are matching

**Claude:** "Plugin MCP servers start automatically when the plugin is enabled"
(`plugins/manifest-reference.md#mcpservers (was line 188 of the retired plugins-reference page)`); "At session startup, Claude Code connects the
servers for enabled plugins automatically" (`mcp.md`); auth is **visible, not
turn-breaking** — a startup notice when servers need authentication, sign-in via
`/mcp` or `claude mcp login <name>`; per-server disable in `/mcp`
(`disabledMcpServers`); "The userConfig field declares values that Claude Code
prompts the user for when the plugin is enabled" (`plugins/components.md#when-the-configuration-dialog-appears (was line 544 of the retired plugins-reference page)`);
**one credential per server, centrally — no per-workspace duplication concept
anywhere in the contract.**

**Codex:** hooks are the only trust-gated component; bundled MCP gets no trust
gate — consent is per-tool approval plus a marketplace policy knob: "Use
policy.authentication to decide whether auth happens on install or first use"
(`build/plugins.md:381-382`); per-server enable and tool approval via
`plugins.<plugin>.mcp_servers.<server>` in user config.

**What is NOT friction to remove:** the OAuth itself and the dp login itself —
upstream requires the equivalent. We remove only the multiplication, the
silence, and the turn-termination, which are ours.

## 0b. Owner decisions — BOTH ANSWERED 2026-07-31

1. **Per-workspace credential isolation for connector sources: not a required
   property.** Owner: "лучше делать навсегда, то есть глобально… нужно чтоб
   работало во всех воркспейсах" — with the clarification that dp was already
   system-wide; this decision covers the connector OAuth credentials that today
   key on `{workspaceId, sourceId}`. **T5 is a GO**: one OAuth per server,
   shared across workspaces, connectorOrigin sources only.
2. **Install-time OAuth chaining: Claude's model.** Owner: "давай как у
   Claude." The T3 checklist ships with **no per-connector OAuth buttons** —
   connector rows are informational and point at the T4 session-start notice,
   which is where sign-in happens on demand. The dp sign-in entry and the
   userConfig dialog stay actionable on the checklist: dp is our system login
   (not connector OAuth chaining), and userConfig is Claude's own
   prompt-at-enable contract.

3. **stdio connectors: fixed IN THIS PLAN, not deferred to the ADR.** Owner:
   "мне кажется лучше сразу реализовать это." Task 9, wave 1 — the class
   `connector-stdio-deferred` dies now; option C later inherits the behaviour
   rather than introducing it.
4. **Connection timing: FULL Claude parity.** Owner overruled the planner's
   keep-intent-based recommendation: "я бы лучше по полному паритету так как
   поддерживать будет проще… делать паритет когда есть расхождения будет со
   временем сложно." Default flips to Claude's contract — servers of enabled
   plugins connect at session start; the bank's connect-by-intent posture is
   PRESERVED as a setting with managed-policy control, so a strict deployment
   turns it back on with one key. Task 10, wave 2.

Every task is now unconditional. **Owner 2026-07-31: V2 executes BEFORE the
1.16.0 close-out — this is what users are waiting for.** File-zoning against
the concurrently-running mode-table executor: T1, T2, T5 and T6 are
server-side and start immediately; T3 and T4 (renderer + locales +
SessionManager) wait until that executor lands, because two executors in one
locale file cross commits.

## Tracker

Update the row IN THE SAME COMMIT that lands the task. Status: ⬜ open ·
🔄 in flight · ✅ done · ⏸ parked.

| # | task | status | commit | note |
|---|---|---|---|---|
| T1 | Claude-adapter remote MCP gets the auth path | ✅ | bca6fa7c | wave 1 — oauth-declaring http/sse `.mcp.json` entries promote to ON_FIRST_USE oauth connectors; zero-auth/header/env/ws/stdio entries unchanged (fixture corpus byte-stable) |
| T2 | Install result tells the whole truth | ✅ | 43e77995 | wave 1 — pending-auth report un-filtered (all timings) + RPC split keeps `authRequests`=ON_INSTALL-only per § 0b-2; configuration rides install-with-activation; agent tool result carries the same `authRequirements` + model-relayable `setup` (owner amendment a7ab726b) |
| T3 | Post-install checklist (renderer) | ✅ | c0674ed4 | wave 2 — `derivePluginSetupChecklist` + checklist dialog on both install paths; dp sign-in rides the system one-click flow + new value-only `dp-auth:probe` (broker publish → registry resync, no chat message); userConfig row opens the enable-time prompt; connector rows informational per § 0b-2; playground states added; also fixes the wave-1 `pluginDetail.configurationPromptRequired` interpolation mismatch (EN/ru `_one` now carry `{{count}}`) |
| T4 | Session-start auth notice, non-interrupting sign-in | ✅ | 852ba59c | wave 2 — `sources:pendingAuth` RPC (workspace-scope resolve + `materializeRuntimePoolServers`, NEVER a pool sync) feeds `PendingAuthNotice` above the main panel; rows: dp set (one-click system sign-in + probe), oauth sources (`performOAuth`, no `interruptForHandoff` anywhere), credential-parked servers (informational), failed connects (T10's broken-server surface); positive control: empty summary renders nothing; playground category 'Sources' added to the order list (it was silently dropped before) |
| T5 | One OAuth per server (global connector creds) | ✅ | 1f34905e | wave 1 — connectorOrigin creds key `{type}::@connector-global::{pluginKey}#{connectorId}#{serverName}`; plain-source keying byte-identical; one-shot startup migration (first-writer-wins) on the fixture-tested path; `markSourceAuthenticated` fans out to connector siblings. Note: a workspace-scope disable/uninstall purge now clears the SHARED slot (conservative, never grants) |
| T6 | Install hygiene | ✅ | 095e0c5f | wave 1 — `materializeStagedBundle` dedupes every returned diagnostic list (the ×2 came from `normalizeStagedInstall` appending AND returning its findings; the old don't-dedupe comment's premise was hollow — store-v2 persists `diagnostics: []`); `plugin.install.version_mismatch` info on listing-vs-bundle skew; `plugin.install.manifest_format_selected` info on dual-format bundles (manifest FILES, not loose adapter detection — Claude's manifestless discovery would flag everything) |
| T7 | Option-C ADR (spike, no code) | ✅ | a9fbcb10 | SIGNED GO 2026-07-31; execution plan: 2026-07-31-plugin-mcp-capability-path.md, runs after both V2 waves, before the close-out |
| T8 | Category strings | ✅ | (this commit) | last — eight strings (five wave-1 residuals per the tracker rows + three wave-2), all regex-verified against scripts/regenerate-deviation-register.py; the register itself is generated in specs/ (planner-owned) and needs a regeneration pass at close-out |
| T9 | stdio plugin servers ride the capability path | ✅ | b6f00cc6 | wave 1 — rerouted at the ONE funnel (`normalizeNessyPluginManifest`), which covers native manifests and the Codex declarative-`connectors` passthrough at once; both format adapters' own MCP readers never demoted stdio (codex `oauth_resource` demands http/sse, claude post-T1 promotes http/sse only). Claude stdio byte-identical; `resolveConnectorSourceRuntime`'s stdio branch stays for pre-T9 installed entries. Also carries the T5-missed `auth-shape-conformance` frozen-shape update (per-workspace → global credential id) |
| T10 | Connect at session start, intent-only behind a policy switch | ✅ | e2a90a48 | wave 2 — `createSession` warms the shared workspace pool through the registry's existing lazy-connect authority (session start is now a NEED); `sources.connectOnStartup` (user, default true) + managed `connectSourcesOnStartup` compose tighter-wins; policy off returns BEFORE the registry is touched (byte-identical gate + mutation probe both red/green); the send path's `awaitConnect:false` is deliberately unchanged in both states — flipping it would re-introduce the measured 33.7s latency scaling (correction to § 9b's seam reading, recorded in T8); ephemeral helper sessions never connect |

## 9a. Task 9 — stdio plugin servers ride the capability path (§ 0b-3)

**Commit:** `fix(plugins): stdio plugin servers ride the capability path`

The `connector-stdio-deferred` class (`connector-source-materializer.ts:123`)
is a parking lot with no exit: a stdio `.mcp.json`/manifest entry that reached
the connector path never starts. Claude-adapter stdio entries already ride the
pinned capability snapshot and WORK — the mechanism exists; this task routes
the remaining class onto it. **Prefer fixing at the adapter** (a stdio entry
never becomes a connector at all) over teaching the materializer to handle it —
locate the demotion by name in both adapters, not by line. Install-time npx
vendoring continues to apply to these servers.

**Gate:** a Codex-format plugin fixture with a zero-auth stdio server serves
tools after install in a temp config dir; the deferred diagnostic is gone from
the install result; Claude-adapter stdio behaviour byte-identical. **Mutation:**
restore the demotion → the fixture goes red.

## 9b. Task 10 — connect at session start; intent-only is a policy switch (§ 0b-4)

**Commit:** `feat(sources): plugin servers connect at session start, intent-only behind a policy switch`

Claude's contract, now ours by owner decision: "At session startup, Claude Code
connects the servers for enabled plugins automatically" (`mcp.md`). Flip the
default at the `awaitConnect` seam (`SessionManager.ts:15235` at research time —
locate by name): enabled plugin servers with ready credentials connect at
session start; a connection failure surfaces through the T4 notice (that is
Claude's startup-notice model, not a new surface). The former behaviour stays
reachable: one setting (suggested `sources.connectOnStartup`, default `true`)
with a managed-policy key so a strict deployment restores connect-by-intent
fleet-wide.

**Gate:** a fresh session with an installed zero-auth plugin lists AND connects
its server before any tool call; with the policy off, behaviour is
byte-identical to today (the intent path is a gate, not dead code); a broken
server surfaces in the notice at start. **Mutation:** flip the default with the
setting ignored → the policy-off test goes red.

## 1. Method rules

1. **Declared ≠ enforced.** Name the production consumer for every claim; rerun
   the live probe for every gate that cites one.
2. **NUL bytes** — always `grep -a`; never `head -N` an uncounted grep.
3. **Two git commands** — pathspec on the `commit`. One commit per task.
4. **Run every test from the repository ROOT.**
5. Installs during development go into TEMP config dirs (`NESSY_CONFIG_DIR`),
   never the user's real `~/.nessy-agent`. Never write
   `~/.nessy/dp_auth_creds.json`. Never log a token or paste OAuth URLs with
   credentials into a report.
6. **Auth boundary = named risk trigger**: expanded verification once on the
   final diff.

## 2. Task 1 — Claude-adapter remote MCP gets the auth path (the literal complaint)

**Commit:** `fix(plugins): a Claude plugin's remote MCP server gets an auth path`

Promote Claude-adapter remote (`httpUrl`/`http`/`sse`) `.mcp.json` servers to
connectors in `packages/shared/src/plugins/format-adapters/claude.ts`, mirroring
what `codex.ts:230` already does — so they gain the Source/OAuth path instead of
the silent `runtime-pool-servers.ts:256` drop. Stdio entries stay capabilities
(they need no OAuth slot).

**Gate:** a Claude plugin fixture with an http+oauth `.mcp.json` entry
normalizes to a connector; a context7-style zero-auth plugin still installs and
serves tools unchanged. **Mutation:** restore the `kind:'mcp'` passthrough for
http entries → the fixture test goes red.

## 3. Task 2 — the install result tells the whole truth

**Commit:** `fix(plugins): the install result reports every auth and config requirement`

Extend the install/enable result assembly (`storage-runtime.ts:214-232`,
`management-service-v2.ts:203/259`, `rpc/marketplace.ts`, `rpc/plugins.ts`) to
report ALL auth requirements — ON_FIRST_USE included, dp (with the
one-login-unblocks-N count), userConfig/env needs — and to carry the
configuration payload on the install path so the userConfig dialog fires on
install-with-activation, not only on the separate enable RPC.

**The AGENT-DRIVEN install path gets the same truth (owner 2026-07-31).**
`plugin_plan_install` → `plugin_install` (`plugin-management-tools.ts`) calls
the SAME `pluginManagement.install` boundary, but its `successResponse` carries
only `{ok, pluginKey, compatibility, diagnosticCodes}` — the model reports
"installed" and the user hits the same dead servers, with no checklist (T3 is
an RPC-result surface the tool path never raises). Put the same
authRequirements summary into the tool result, phrased for a model to relay:
what is ready, what one dp sign-in unblocks, which servers will ask to connect
at first use, which need userConfig. The T4 session-start notice remains the
state-based backstop for BOTH paths.

**Gate:** the install probe rerun on `nessy-default-extension` returns a result
naming every non-ready server with its reason and the dp aggregation; the
userConfig dialog fires on install. **Mutation:** re-filter to ON_INSTALL → the
probe assertion goes red.

## 4. Task 3 — the post-install checklist (renderer)

**Commit:** `feat(plugins): install ends in a setup checklist, not silence`

A skippable post-install surface consuming Task 2's result: "Installed. 2 of 14
servers ready. To finish: Sign in to Developer Platform (9 servers) · 3 sources
will ask to connect when first used". Per § 0b-2 (decided): dp sign-in and the
userConfig dialog are actionable; **connector rows are informational** — they
name the server and point at the session-start notice, no OAuth buttons, which
is Claude's no-chaining-at-install contract. Nothing blocks; skipping leaves
everything reachable later. i18n keys in every locale (aggregated-count forms
included), playground states added.

**Gate:** installing `nessy-default-extension` in a temp config dir shows the
checklist with true counts; completing dp sign-in flips nine servers to
available **without sending a chat message**. **Mutation:** suppress the
checklist → its test goes red.

## 5. Task 4 — pending auth is visible at session start, and sign-in does not kill a turn

**Commit:** `feat(sources): pending auth surfaces at session start and signs in without interrupting`

Claude's surfacing model, ours to build: a session-start / Sources-panel notice
listing every server needing auth — including the silently-dropped dp set and
`credential-missing` capability servers — each with one-click sign-in that runs
`performOAuth`/dp login **without** `interruptForHandoff`. The mid-turn
interrupt remains only as the mid-task fallback. Reuse
`getSourcesNeedingAuth` + the `externalAuthRequirements` already computed by
`materializeRuntimePoolServers`.

**Gate:** fresh config dir + installed plugin → opening a session shows the
notice before any send, and completing sign-in from it never aborts a turn;
positive control: with dp ready and all sources authed, no notice. **Mutation:**
drop the notice → its test goes red.

## 6. Task 5 — one OAuth per server, ever (GO per § 0b-1)

**Commit:** `fix(sources): a connector credential is shared across workspaces`

For sources carrying `connectorOrigin` only: key the credential globally
(`credential-manager.ts:346-350`), migrate existing
`source_oauth::{ws}::{slug}` rows once, fan out `markSourceAuthenticated` to
sibling sources. Ordinary user-created sources keep per-workspace keying.

**Gate:** OAuth completed in workspace A makes `isSourceUsable` true for the
sibling source in workspace B with no second flow; the migration test passes on
a fixture credential store; a plain source's keying is byte-identical.
**Mutation:** restore workspace keying for connectorOrigin → the cross-workspace
test goes red.

## 7. Task 6 — install hygiene

**Commit:** `fix(plugins): install diagnostics are deduplicated and honest about versions`

Dedupe the doubled diagnostics (npx installer-unavailable ×2, Codex app
warnings ×2); info diagnostic on marketplace-version vs registry-version
mismatch; on dual-format repos, note which manifest was chosen
(`repository-install.ts` candidate order).

**Gate:** probe reruns show each diagnostic exactly once; the honey install logs
the claude-vs-codex manifest choice. **Mutation:** restore one duplicate → its
test goes red.

## 8. Task 7 — the option-C spike (ADR, no code)

Option C — remove the plugin-MCP→Source translation entirely and run plugin
servers on the pinned capability snapshot with a plugin-scoped global credential
slot — **is Claude's exact contract and the right end-state**, but it is an
auth-boundary rework with an encrypted-credential migration. After T1–T6 land,
write the ADR: credential migration, stdio-connector and dp semantics on the
capability path, Sources-UI impact, and whether the remaining Source-projection
complexity still pays for itself. The owner accepts or rejects it in writing.

## 9. Task 8 — category strings

**Commit:** `docs(audit): what the plugin-install work leaves open`

Unwrapped, unbolded, backtick-terminated, under 400 characters. At minimum: the
§ 0b decisions as taken, the stdio-connector class, the Codex `.app.json`
surfacing question, and the bank connect-intent policy vs Claude's
connect-at-startup.

## Category strings — what the plugin-install work leaves open (T8)

Eight recorded decisions, harvested by the deviation register. The first five
are wave 1's residuals as its tracker rows recorded them; the last three are
wave 2's.

**Global connector credentials share one purge (§ 0b-1, T5).** Category:
`documented, not implemented — Claude keeps one credential per server centrally with no per-workspace scoping anywhere in the contract; our connector credentials are global per owner decision 0b-1, but a workspace-scoped disable or uninstall purge still clears the SHARED slot, so one workspace's cleanup signs every workspace out of that server — conservative, never grants, accepted until the option-C credential rework`

**No install-time OAuth chaining for first-use connectors (§ 0b-2, T2/T3).**
Category:
`documented, not implemented — Codex's policy.authentication lets a catalog demand install-time auth for any connector; our wire authRequests stays ON_INSTALL-only by owner decision 0b-2 (Claude's no-chaining model), so an ON_FIRST_USE connector never gets install-time OAuth even when a marketplace policy asks for it — sign-in moves to the session-start notice`

**The stdio-connector class survives in old stores (§ 0b-3, T9).** Category:
`documented, not implemented — the stdio-connector demotion died at the manifest funnel per owner decision 0b-3, yet resolveConnectorSourceRuntime keeps its stdio branch for entries installed before T9; pre-T9 installs stay on the parked path until reinstall or the option-C migration, so the dead class outlives its producer in old stores`

**Codex app-only connectors have no surface beyond the requirement row.**
Category:
`documented, not implemented — Codex app-only connectors (.app.json bindings with no materializable MCP server) surface only as the unsupported-app auth requirement row; no card, page or notice names them beyond that, and whether they deserve a first-class surface is deferred to the option-C plan`

**The T1 promotion covers oauth-declaring http/sse only.** Category:
`documented, not implemented — Claude connects every .mcp.json server kind, while the T1 promotion gives the Source/OAuth path only to oauth-declaring http and sse entries; ws entries and header- or env-authenticated remotes keep capability semantics with no OAuth slot — the measured pre-T1 behaviour — until option C unifies the path`

**dp sign-in is one system login, not per-server (T3/T4).** Category:
`documented, not implemented — Claude signs into a pending MCP server per server via /mcp or claude mcp login; our dp-backed servers share ONE system login (ensureGatewayAuth plus a value-only broker probe), so the checklist and the notice offer a single dp sign-in that unblocks all nine servers at once — deliberate: dp is a system credential, not a connector OAuth`

**The awaitConnect seam was not the flip point (T10, correction to § 9b).**
Category:
`documented, not implemented — the plan's 9b read the awaitConnect seam as the flip point, but awaitConnect true at send would re-introduce the measured 33.7s turn-latency scaling and let one hanging server block the turn; connect-at-session-start is instead a policy-gated warm of the shared workspace pool at createSession, and the send path keeps awaitConnect false in BOTH policy states`

**Session-start connect is workspace-scope and skips ephemeral sessions
(T10).** Category:
`documented, not implemented — Claude connects the servers of enabled plugins at session startup regardless of session shape; our session-start connect is workspace-scope only and skips ephemeral helper sessions, so trusted-project-scoped MCP still connects at first send rather than at create — a deliberate containment of the T10 blast radius`

## 10. Gate

Focused suites per changed file; the plugins, sources, sessions and renderer
aggregates once on the final diff; `bun run typecheck:all` exit 0 stated
explicitly + `apps/cli` separately; `bun run lint`; i18n parity + sorted;
`git diff --check`. **Auth boundary is the named risk trigger** — expanded set
once on the final diff. Live probes rerun in temp config dirs; the checklist
CDP row recorded on a packaged build at close-out.

## 11. Constraints

- One commit per task, subjects exactly as given. No `Co-Authored-By`. No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash. Mutation probes
  restored by re-edit or `.orig`, never git.
- `docs/superpowers/specs/` and `docs/testing/cdp-live-checklist.md` are
  planner-owned. No version bumps — the 1.16.0 close-out owns versioning; this
  plan targets the release after it.
- Temp config dirs for every install; the user's real config and
  `~/.nessy/dp_auth_creds.json` are untouchable. Code/comments/commits English.

## 12. Report

Commit shas; the install probe before/after with real counts; the two § 0b
decisions as recorded; what the checklist and the notice actually render;
whether the Claude-adapter promotion changed any existing plugin's behaviour;
residuals word for word; corrections to this plan; mutation probes with sides;
the explicit typecheck statement including `apps/cli`.
