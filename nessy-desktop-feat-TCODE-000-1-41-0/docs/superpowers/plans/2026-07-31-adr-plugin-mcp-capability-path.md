# ADR: plugin MCP servers leave the Source projection — the capability-path decision

**Status:** proposed, awaiting owner signature (block at the end).
**Date:** 2026-07-31. **This is T7 of** `2026-07-31-plugin-install-usability.md`,
written to the owner's stated lean ("option C, because one model is simpler to
maintain") — as *how, and what it costs*, with a go/no-go recommendation.
Written against HEAD with V2-T1 landed (`bca6fa7c`) and the § 0b-3/§ 0b-4
owner decisions recorded (`c91ff493`: T9 fixes stdio now, T10 flips connection
timing to full Claude parity); T2–T6, T9 and T10 are assumed landed by the
time this ADR executes, and every interaction with them is called out.
Every code citation below was re-read on 2026-07-31; the quoted sentence, not
the line number, is the durable part of each citation.

## 1. The decision

Plugin-declared MCP servers stop materializing into Sources. A plugin's remote
and stdio servers live under the plugin itself, on the pinned capability
snapshot the plugin already runs on, exactly as Claude's contract states:
"Plugin MCP servers start automatically when the plugin is enabled"
(`plugins/manifest-reference.md#mcpservers (was line 188 of the retired plugins-reference page)`) and "Plugin servers can be configured
independently of user MCP servers" (`plugins/manifest-reference.md#mcpservers (was line 191 of the retired plugins-reference page)`). A server that
needs OAuth or a bearer token gets a **plugin-scoped GLOBAL credential slot
keyed `{pluginKey, serverName}`** in the encrypted store — one credential per
server, ever, in every workspace, matching the contract's model ("one
credential per server, centrally — no per-workspace duplication concept
anywhere in the contract", plan § 0a). The Source store returns to what it was
built for: user-created connections only. The entire projection layer — the
materializer, the per-workspace lifecycle, the adapter demotion branches, the
dedupe/replace/purge machinery — is deleted, not deprecated.

## 2. Credential migration

**What exists.** Connector credentials are rows in the machine-keyed encrypted
store `~/.nessy-agent/credentials.enc` (`backends/secure-storage.ts:4`:
"Stores credentials in an encrypted file at ~/.nessy-agent/credentials.enc").
Exactly **two key shapes** apply to connector sources —
`source_oauth::{workspaceId}::{sourceId}` and
`source_bearer::{workspaceId}::{sourceId}` (`credentials/types.ts:181-186`;
`SourceCredentialManager.getCredentialId` maps `mcp.authType === 'bearer'` to
`source_bearer`, everything else to `source_oauth`,
`sources/credential-manager.ts:325-350`). They are written by the source OAuth
completion path (`rpc/oauth.ts` → `SourceCredentialManager`), and read by the
capability resolver (credential state), the runtime pool, `isSourceUsable`,
and `TokenRefreshManager`. `purgeConnectorSourceCredentials` deletes both
slots plus the legacy per-source cache file
(`connector-source-materializer.ts:193-218`).

**T5 interaction — its outcome survives; its keys are re-migrated.** By
execution time, V2-T5 will have keyed connectorOrigin credentials globally and
collapsed the per-workspace rows to one per server (plan § 6: "key the
credential globally (`credential-manager.ts:346-350`), migrate existing
`source_oauth::{ws}::{slug}` rows once"). The option-C migration is then a
**pure key rename**: lift each of T5's one-per-server rows to
`plugin_mcp_oauth::{pluginKey}::{serverName}` /
`plugin_mcp_bearer::{pluginKey}::{serverName}`. What survives: T5's real
deliverable — the per-workspace collapse, including its winner-selection among
duplicate workspace rows — is **not** redone, and no user re-authenticates.
What is re-migrated: the key string, once. What is deleted afterwards: T5's
connectorOrigin special-case in `getCredentialId` and T5's own migration code.
C's migration is strictly simpler *because* T5 ran first: N rows renamed
(one per server) instead of N×W rows merged.

**Mechanics.** One-shot, on first launch of the C build, before the first
capability snapshot resolves: **copy, don't move** — write the plugin-keyed
row, leave the source-keyed row in place, record completion in a migration
marker. Reads go to the plugin slot behind the C flag (§ 8). The old rows are
purged one release later, when the flag is removed.

**Rollback.** Because migration copies, downgrading to a Source-model build
finds the old rows intact and works unchanged. The only decay: a token
*refreshed* under C updates only the plugin slot, so a later downgrade may hold
a stale (expired) source row → re-auth prompt, never token loss.

**Uninstalled plugins.** Today credentials die with the sources
(`onPluginUninstall` → `removeConnectorSources` →
`purgeConnectorSourceCredentials`, `storage-runtime.ts:370-377`). Under C,
uninstall purges the plugin slots through the existing `dataLifecycle`
(`storage-runtime.ts:386-388` already removes plugin data there). A migration
encountering rows whose `pluginKey` has no active install purges them under
the same rule the materializer documents: revoke the secret before freeing the
slot (`connector-source-materializer.ts:462-465`).

## 3. stdio connectors: the class is already dead by T9 — C only buries it

This question is **decided and implemented before C runs** (owner § 0b-3:
"мне кажется лучше сразу реализовать это"). V2-T9 fixes it at the adapter
level — a stdio entry never becomes a connector at all — so by execution time
stdio plugin servers already ride the capability pool's stdio branch
(`runtime-pool-servers.ts:274-366`: `resolvePluginStdioExecutable`,
absolute-command enforcement, bundle-hash verified `pluginRuntime`,
`inheritProcessEnv: false`), with install-time npx vendoring
(`bundleRoot/.nessy-runtime/npx`, `stdio-command.ts:137`,
`plugin-runtime-dependencies.ts`) continuing to apply. T9 is deliberately
adapter-only, so the materializer's now-unreachable guards stay on disk: the
stdio refusal — "never let connector stdio bypass the supervised plugin
transport as native MCP" (`connector-source-materializer.ts:57-60`) — and the
`connector-stdio-deferred` parking state
(`connector-source-materializer.ts:123`). What remains for C here is
**burial, not behavior**: the § 7 deletion removes those vestigial guards
with the rest of the file, and C5's gate confirms the class stayed dead
(no `connector-stdio-deferred` can be emitted from any path). The § 7
inventory already assumes T9's adapter routing is in place.

**Routing change per adapter under C** — with stdio gone via T9, only the
**remote** demotion branches remain, and each is a redirect of an existing
branch, not new parsing:

- `format-adapters/claude.ts:1044-1058` — T1's connector promotion reverses
  shape but keeps its substance: an http/sse entry declaring OAuth stays a
  `kind:'mcp'` capability carrying a new auth descriptor
  (`oauthResource`/`clientId`/`authType`) instead of becoming a
  `PluginConnectorDescriptor`. T1's detection logic (which entries get an
  OAuth slot; headers/env entries keep their reviewed binding) survives
  verbatim.
- `format-adapters/codex.ts:1005-1038` — the `oauth_resource` branch emits the
  same auth-carrying `kind:'mcp'` capability instead of a connector.
- `format-adapters.ts:1255-1273` — the legacy `httpUrl` demotion branch, same
  redirect.

## 4. dp-backed servers: nothing moves, because they never rode Sources

The nine dp-backed servers are already capability-path stdio servers; C
changes **nothing** for them, which is itself evidence for C — the capability
path already carries 9 of the measured 14 servers plus every Claude-adapter
stdio server. What stays, verbatim:

- the dp gating: `if (externalAuthProvider === 'dp') { … if (dpSessionState
  !== 'ready') continue; }` (`runtime-pool-servers.ts:326-329`) and the
  missing-binary hard stop "host-owned dp executable is missing."
  (`runtime-pool-servers.ts:543-544`);
- `preflightDpAuth` (`SessionManager.ts:8037`) and its held first send;
- the one-login-unblocks-N aggregation V2-T2 ships: the single
  `externalAuthRequirements` entry carrying every dp wire name
  (`runtime-pool-servers.ts:403-410`).

What changes: `externalAuthRequirements` stops being dp-only. The same
aggregation grows `oauth`/`bearer` entries for plugin servers whose plugin
slot is empty — giving T3's checklist and T4's notice one uniform "what needs
auth" feed instead of today's split (dp from the pool, connectors from source
credential state).

## 5. Connection timing: C inherits T10's already-flipped default

Timing is **decided** (owner § 0b-4, overruling the planner's keep-intent
recommendation: "я бы лучше по полному паритету так как поддерживать будет
проще") and **ships before C** as V2-T10: the default flips to Claude's
contract — "At session startup, Claude Code connects the servers for enabled
plugins automatically" (`mcp.md:315`) — at the `awaitConnect` seam
(`{ awaitConnect: false, … }`, `SessionManager.ts:15235` at research time;
locate by name), with the bank's connect-by-intent posture preserved as a
setting (suggested `sources.connectOnStartup`, default `true`) under a
managed-policy key so a strict deployment restores it fleet-wide with one
key. C therefore changes nothing about timing and argues nothing about it:
the capability path inherits the flipped default because plugin servers reach
the session through the same `setSourceServers` seam T10 gates — they merely
arrive from the pool instead of from materialized sources. The T10 policy
switch governs them identically on either side of the C flag, a startup
connection failure keeps surfacing through the T4 notice (Claude's
startup-notice model), and C5's gate includes the policy-off path staying
byte-identical so the intent gate remains live code, not dead code.

## 6. Sources UI impact

**Disappears:** every connector-origin source row, and with it the
per-workspace duplication (14 servers × W workspaces for
`nessy-default-extension`), the `credential-missing` parked rows
(`resolver.ts:1529`), the 🔌 placeholder-icon rows, and the connector branches
in `SourceMenu.tsx`, `SourcesListPanel.tsx`, `SourcesManagementRow.tsx`,
`capability-info-metadata.ts`. Sources lists user-created connections only.

**Appears:** ONE panel listing ALL MCP servers — plugin-owned and user-created
together, each row with its origin label, transport, auth state and a
**per-server enable toggle**. This is the planner amendment accepted at
signature: a plugin-only listing beside a user-only Sources pane would be the
two-surface split § 10's counter-case warns about; Claude's `/mcp` is a single
surface for "user-configured servers, plugin servers, claude.ai connectors,
and built-in servers", and ours mirrors it. The plugin detail page shows the
same rows filtered to that plugin — a view, not a second surface. Claude's model
is the cite: "`disabledMcpServers`: an opt-out list for user-configured
servers, plugin servers, claude.ai connectors, and built-in servers that
default to on. Claude Code doesn't connect to a server you list here."
(`mcp.md:201`). We do not need new policy plumbing for it: the
`CapabilityPolicyStore` already supports capabilityId-scoped records — "A
capabilityId-scoped record is a pure per-capability toggle"
(`policy-store.ts:306-310`) — so per-server disable is a per-capability toggle
on the server's mcp capability, workspace-scopable through the store's
existing layers. Only the listing UI is new.

**Carries over unchanged:** T3's post-install checklist (it consumes T2's
install-result summary; the producer changes, the RPC shape does not), T4's
session-start notice (it is state-based; its input becomes the generalized
`externalAuthRequirements` feed of § 4), the dp sign-in entry, and the
userConfig dialog (Claude's own prompt-at-enable contract,
`plugins/components.md#when-the-configuration-dialog-appears (was line 544 of the retired plugins-reference page)`). T4's non-interrupting sign-in maps directly onto
Claude's surfacing: "Claude Code also shows a startup notice when one or more
configured servers need authentication, so you don't have to open `/mcp` to
discover which servers need sign-in." (`mcp.md:575`).

## 7. What gets deleted, counted

Counted with `grep -ac "onnector"` (NUL-safe) against per-file `grep -c ""`
totals on 2026-07-31, HEAD `ea341d22` + T1. Whole-file deletions are exact;
partial-file numbers are the measured token-line count expanded to the
surrounding blocks read above.

| Site | LOC removed |
|---|---|
| `plugins/connector-source-materializer.ts` (whole file) | 521 |
| `plugins/__tests__/connector-source-materializer.test.ts` | 621 |
| `plugins/__tests__/connector-credentials-oauth.test.ts` | 213 |
| `plugins/__tests__/connector-corpus-qualification.test.ts` | 89 |
| `bootstrap/storage-runtime.ts` — `connectorOnInstallAuthRequests` (:213-232) + `reconcileWorkspaceConnectors` + `connectorLifecycle` (:298-390) | ~115 |
| `plugins/management-service-v2.ts` — `syncConnectorSourcesOnEnable/Disable` (:543-585), repair/uninstall hooks, `authRequests` plumbing (97 token lines) | ~120 |
| `capabilities/resolver.ts` — connectorOrigin/connectorRuntime branches (:1517-1560, :2176-2185) | ~75 |
| `rpc/oauth.ts` — connector rebind/invalidation branches (:286-325, :547) | ~45 |
| `protocol/capabilities.ts` + `capabilities/types.ts` + `views.ts` — `SafeSourceConnectorOrigin`, `SafeConnectorAuthRequest`, `connectorRuntime` plumbing | ~70 |
| `sources/types.ts` + `storage.ts` + `native-sources.ts` + `config/validators.ts` + `mcp/runtime-pool-servers.ts:135-138` | ~45 |
| adapter demotion branches rewritten in place (claude :1044-1058, codex :1005-1038, format-adapters :1255-1273) | net ~30 |
| renderer connector rows (4 files) | net ~30 |
| **Delete total** | **~1,975** |

Added: plugin credential type + key shape (~40), resolver credential binding
for plugin http servers (~60; the pool's `Authorization: Bearer` injection for
a bound credential **already exists**, `runtime-pool-servers.ts:389-394`),
generalized `externalAuthRequirements` (~60), the OAuth-core extraction and
plugin-server flow entry (§ 8 risk 1, ~200-300), one-shot migration (~100),
uninstall purge (~20), plugin-page server list UI (~150), tests (~350-450).
**Add total ≈ 1,000-1,150. Net ≈ −850 to −1,000 lines**, roughly two deleted
per one added — and the deleted half is the half with the staged-replace,
backup-rename, purge-rollback state machine
(`connector-source-materializer.ts:237-363`) that has to be re-verified on
every source-store change today.

## 8. Risks and the kill-switch

**Named risk trigger: auth boundary rework.** Per the repo policy and plan
§ 1.6, the expanded verification set runs once on the final diff.

1. **The OAuth machinery is LoadedSource-shaped end to end.** The PKCE flow,
   `completeOAuthFlow` (`rpc/oauth.ts:143`), `markSourceAuthenticated`,
   `TokenRefreshManager`, `getSourcesNeedingAuth`
   (`sources/credential-manager.ts:1126`) and the model-facing
   `source_oauth_trigger` ("Source must exist in the current workspace",
   `tool-defs.ts:543-553`, registered at `:971`) all take a source.
   Generalizing that core to "an OAuth-capable endpoint with a credential id"
   is the real project inside C; the deletion is the cheap part. If the
   extraction is skipped and the flow is forked instead, we end with two auth
   stacks — strictly worse than today.
2. **A second consecutive encrypted-store migration.** T5 migrates
   `credentials.enc` once; C migrates it again one release later. Two
   migration events on a machine-keyed store is two chances to lose a working
   token. Mitigation is the copy-don't-move design (§ 2) plus the invariants
   below.
3. **Token refresh continuity.** `TokenRefreshManager` discovers refreshables
   through sources. Miss the re-point and every plugin OAuth token silently
   expires in ~1h — a delayed, invisible credential loss. A refresh-path test
   on a plugin-slot credential is a C4 gate, not an afterthought.
4. **Persisted state references the old world.** Pinned capability snapshots
   embed `connectorRuntime` bindings (`views.ts:68-69`), and old sessions may
   name connector sources. Resolution of a stale binding must degrade to
   needs-auth/unavailable — never a thrown turn.

**Kill-switch and staging.** C ships behind a build-time/runtime flag
(`NESSY_FEATURE_PLUGIN_MCP_CAPABILITY_PATH` shape, default off in the landing
release): the migration is copy-only on first launch of the enabled build;
reads flip with the flag; flag off = the Source projection runs exactly as
before against the untouched old rows. The deletion wave (C5) lands only
after the flag has been default-on for one release. **A failed migration must
NOT:** delete or overwrite any `source_oauth::`/`source_bearer::` row, throw
on the startup path (brick), or report success partially — it leaves the old
rows authoritative, logs the failure, and retries next launch; the worst
user-visible outcome is a re-auth prompt, never a silently lost credential
and never an unbootable app.

## 9. Execution sketch (becomes the plan on signature)

Sized against V2: wave-1 tasks (T1/T2/T5/T6) are the unit. C3 is the center
of gravity and goes first — if it stalls, nothing else has landed and the
kill-switch is trivial.

| # | task | gate |
|---|---|---|
| C1 | Extract the source-independent OAuth core (PKCE/discovery/refresh over `{url, authType, oauthResource, clientId, credentialId}`); sources become its first caller, behavior byte-identical | existing source OAuth tests green unchanged; mutation: re-inline → extraction test red |
| C2 | Plugin credential slot: new credential types + key shapes, uninstall purge, `source_oauth_trigger` grows the plugin-server target (or a sibling tool) | key round-trip + purge tests; live OAuth probe against a temp-config plugin server |
| C3 | Adapters redirect (3 branches, § 3): auth-carrying `kind:'mcp'` capabilities; resolver binds plugin http credentials; pool surfaces `oauth`/`bearer` in `externalAuthRequirements` | the T1 fixture normalizes to an auth-carrying capability; pool test shows the needs-auth entry; dp aggregation unchanged (positive control) |
| C4 | Migration (copy-only) + flag + `TokenRefreshManager` re-point | fixture-store migration test incl. failure/rollback; refresh test on a plugin slot; downgrade test: old rows untouched |
| C5 | Delete the projection (§ 7 table) behind the flag flip; Sources returns user-created-only | install probe: zero sources created on a 14-server install; `nessy-default-extension` servers usable via capability path; `grep -a` absence checks on the deleted symbols (`connector-stdio-deferred` included — the T9-killed class stays dead); T10's policy-off probe rerun byte-identical |
| C6 | Plugin-page server list + per-server toggle (policy-store capabilityId records); T3/T4 re-point to the generalized feed | CDP row on a packaged build; toggle round-trip test |
| C7 | Close-out: version bump, release notes, docs-site, category strings, deviation-register regeneration | full regression per plan § 10 shape |

## 10. Recommendation

**Go — with C1 as the first landed commit and the flag as the exit.** The
capability path already carries the majority of real servers (all stdio, all
dp); the Source projection exists to give the remaining http/oauth servers an
auth surface, and it pays for that with ~2,000 lines of per-workspace
duplication, staged-replace/rollback machinery, a permanently-dead stdio
class, and a second enable surface duplicating per-capability toggles the
policy store already has. The honest counter-case: the projection bought
plugin MCP a single battle-tested OAuth stack for free, and C's cost is
concentrated in extracting that stack's core on the auth boundary, one
release after T5 already migrated the same store — if C1 proves harder than
sized, stop there, keep the flag off, and the Source model (post-V2, which is
already Claude-shaped in surfacing) remains a defensible end-state. The
simpler-to-maintain argument decides it: after C there is one server model,
one credential shape, one enable surface, and the contract page and the code
say the same thing.

Owner decision: **GO** — 2026-07-31. Recorded by the planner from the owner's
words: "нет спешки — можно сразу это делать чтоб дать наоборот качественное
решение." Scope note the words change: C does NOT wait for a later release —
it executes immediately after the V2 waves land, in the same release train,
and the close-out follows the whole set. Quality over shipping speed is the
owner's stated trade. The § 9 sketch becomes the execution plan; C1 remains
first and remains the kill-switch.
