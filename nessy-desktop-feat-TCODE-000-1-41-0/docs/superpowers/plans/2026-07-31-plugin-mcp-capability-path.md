# Option C executes: plugin MCP servers leave the Source projection

**Signed GO by the owner 2026-07-31** — see the ADR
(`2026-07-31-adr-plugin-mcp-capability-path.md`), which carries the decision,
the migration rules, the § 6 unified-panel amendment accepted at signature, the
counted delete/add estimate (net −850…−1000 LOC) and the § 9 sketch this plan
makes executable. **The ADR is the specification; this file is its execution
order, tracker and constraints.** Sequenced BEFORE the release close-out, by
owner decision: quality over shipping speed.

**Dispatch condition: after BOTH V2 waves land** (`2026-07-31-plugin-install-usability.md`
tracker all ✅ through T6/T9/T10). C builds on T5's global keying, T9's dead
stdio class and T10's flipped connect default — starting earlier re-does their
work in flight.

## Tracker

Update the row IN THE SAME COMMIT that lands the task. Status: ⬜ open ·
🔄 in flight · ✅ done · ⏸ parked.

| # | task | status | commit | note |
|---|---|---|---|---|
| C1 | Source-independent OAuth core extraction | ✅ | 9a52eb1c | `auth/endpoint-oauth.ts`: prepare/exchange/refresh/expiry over `{url, authType, oauthResource, clientId, oauth?}` (+ `OAuthEndpointBinding` carrying `credentialId`); `SourceCredentialManager` delegates its MCP prepare (incl. generic auto-discovery), mcp exchange, `refreshMcp` and both expiry checks. Byte-identical: the server-owned prepare path's existing omission of the `mcp.oauth` override block is CARRIED, not fixed (reported). Sources+auth suites 408 pass unchanged; mutation probe: re-inline of the exchange delegation sent both exchange routing tests red, restored green |
| C2 | Plugin credential slot + uninstall purge + trigger target | ✅ | 4416fc45 | `plugin_mcp_{oauth,bearer}::{pluginKey}::{serverName}` types + codec (`credentials/types.ts`) and the slot module `plugins/mcp-credentials.ts` (id/load-with-bearer-fallback/save/per-server delete/per-plugin purge); uninstall purge rides `PluginManagementServiceV2.uninstallUnlocked` next to the mcpb purge (store-enumerated, sibling plugins + source rows untouched — proven on a real install fixture); `source_oauth_trigger` grows `{pluginKey, serverName}` behind the new `resolvePluginMcpServer` ctx seam (host wires it in C3), google trigger keeps its strict schema; live probe: real discovery/DCR/exchange via the network seam minted a token into the plugin slot of a real temp-config `credentials.enc` (raw token absent from file bytes). Mutation probe: disabling the uninstall purge filter sent the uninstall test red, restored green |
| C3 | Adapters redirect; resolver binds plugin http creds; pool surfaces needs-auth | ✅ | 31c5101e | centre of gravity. DEVIATION-IN-MECHANISM (reported): the redirect lands at the ONE normalization funnel (`schema.ts rerouteConnectorServers`, T9's precedent) instead of rewriting the three adapter branches in place — the funnel covers the two routes the ADR's list misses (Codex declarative `connectors`, native-manifest connectors); detection logic in all three branches survives verbatim. App-referenced connectors survive as ROUTING METADATA with capability twins; `connectorsNeedingSourceProjection` (twin gate) keeps the Source projection serving ONLY pre-C3 persisted entries. Resolver: `endpointAuth` on RuntimeMcpServer + plugin-slot binding via existing credentialRef machinery + no-park exemption; pool: skip + generalized `externalAuthRequirements` (`oauth`/`bearer` entries with per-server `{pluginKey,serverName}` targets; registry's `[0]` dp indexing fixed). RPC: oauth START/COMPLETE/REVOKE accept `pluginServer` targets (endpoint pinned across the flow; completion writes the plugin slot). `applyCatalogAuthentication` stamps `authType` instead of synthesizing `catalog.*` connectors (per-server catalog TIMING granularity dropped — state-based pending replaces it). `derivePluginMcpAuthRequirements` reads twins (connectorIds now carry capability ids — RPC shape unchanged). Gates: T1 fixture → auth-carrying capability ✓; pool needs-login entry ✓; dp aggregation byte-identical control ✓; mutation probe (pool skip disabled → 2 tests red, restored). Test conversions recorded: 10 management tests re-pointed (pre-C3 persisted-entry harness via direct `store.install`; catalog tests to capability shape); T2 truth probe: install-time source authRequests row assertion replaced by requirement-set assertions (the row source is gone by design); one test deleted (`returns path-free ON_INSTALL auth refs…` — its subject, lifecycle authRequests through the install result, is dead for new installs and C5 deletes the plumbing) |
| C4 | Copy-only migration + flag + TokenRefreshManager re-point | ✅ | 7dbb5732 | failure leaves old rows authoritative. Flag `NESSY_FEATURE_PLUGIN_MCP_CAPABILITY_PATH` (default OFF): ON serves persisted pre-C3 connectors as capability-path candidates (`resolvePluginProjectionCandidates` synthesis, funnel-identical shape; manifests NEVER rewritten) and excludes connector-origin source records from the inventory; OFF = Source projection byte-identical. Migration `migrateConnectorCredentialsToPluginSlots` runs at startup after T5's collapse: copy-only + copy-if-absent (idempotent, NO marker), never throws, stale-pluginKey rows SKIPPED not purged (recorded deviation from ADR § 2's stale-purge sentence — the iron rule wins; purge belongs to the flag-removal release). REFRESH RE-POINT deviation-in-mechanism (reported): not TokenRefreshManager (whose source sweep is legacy-skipped under the capability runtime AND whose mid-lease write would trip revision pinning) — a process-wide `ensureFreshPluginMcpToken` (plugins/mcp-token-refresh.ts, C1 core, in-flight dedup + 5-min cooldown) called by the POOL at the point of consumption, so a refreshed token is used immediately and revision pinning can never serve it stale. Gates: fixture-store migration incl. failure/rollback + downgrade (source rows byte-identical) ✓; refresh test on a plugin slot ✓; pool read-through revision-proof test ✓; mutation probe (copy-if-absent disabled → 3 tests red, restored). Known C4 consequences recorded: flag-ON demands a NEW capability trust grant for projected legacy servers (re-review, not re-auth), and stale source-based pending-auth rows may linger in the T4 notice until C6 re-points it. Also carries the C3 test-ctx tsc fix (webContentsId) |
| C5 | Delete the projection behind the flag flip | ✅ | a43b9099 | flag default flips ON (post-deletion the flag is an emergency "do not serve legacy connectors" switch — it can no longer restore the deleted projection; recorded). DELETED: `connector-source-materializer.ts` (whole file; T5's `migrateConnectorSourceCredentialsToGlobal` moved to `mcp-credentials.ts` — the startup chain T5→C4 still runs), the connector lifecycle (`PluginConnectorLifecycle`, sync/reconcile/pendingAuthRequests, storage-runtime wiring), resolver/pool/views `connectorRuntime` plumbing (generation-hash material keeps `connectorRuntime: null` for shape stability), rpc/oauth connector branches (a connector-origin source START now throws `plugin-mcp-server-capability-path-required`), the project-scope connector refusal (project activation is now a normal target — nothing materializes), and the three § 7 test files + the superseded server-core `oauth.test.ts` (its plugin-flow replacement is `oauth-plugin-server.test.ts`). Connector-origin SOURCE records are excluded from the inventory UNCONDITIONALLY (on-disk dirs = rollback material; a spoofed Source.mcp can no longer reach the pool because the serving path itself is gone). Install probe (temp dirs, 14-server default-extension shape): sources created = 0; view.sources = 0; view.mcpServers = 14; materialized: 9 dp ready + 1 oauth needs-login entry naming all 5 plugin slots (9+5 = 14 served); `connector-stdio-deferred` unspellable in the whole output. `grep -a` absence: 12 deleted symbols at 0 hits repo-wide; residuals are the resolver's intentional null, prose, and the probe's own witness strings. T10 policy-off probe (`connect-on-startup.test.ts`) rerun byte-identical: file untouched, 3/3 green. Mutation probe: re-serving connector records sent the managed-policy test red, restored. DEFERRED to C6 (recorded § 7 correction): protocol `SafeConnectorAuthRequest`/renderer connector rows delete where their consumers re-point |
| C6 | ONE panel for all MCP servers + per-server toggle | ✅ | 959e833f | § 6 amendment: a view, not a second surface. `McpServersPanel` (+ app-shell-connected wrapper) lists plugin-owned AND user-created servers together — origin label (owning plugin name / User / Built-in), transport (new safe `mcpTransport` field threaded resolver→views→protocol; value only, never URL/command), auth state (slot ready/missing/expired), per-server enable Switch riding the EXISTING `set-capability-enabled` policy records. Mounted as the Sources→MCP subsection (replacing the type-filtered source list there); `PluginInfoPage` renders the SAME component filtered by pluginKey (mcp rows leave the generic components section — no intra-page duplication). T3/T4 re-point: `buildPendingAuthSummary` grows the GENERALIZED feed (oauth/bearer `externalAuthRequirements` entries → rows with `pluginServer` targets; bearer informational), `performOAuth`/oauth-orchestration/notice pass the plugin-server target end to end. i18n `mcpServers.*` in en+ru, parity+sorted green. Playground `mcp-servers-panel` entry (6 knobs, 5 variants incl. the plugin-detail view and empty). Gates: toggle round-trip THROUGH THE REAL LAYERS (install→setCapabilityEnabled(false)→resolve: component `enabled:false`+`capability-disabled`+server dropped from runtime→re-enable→served again) + panel/builder tests (both origins, toggle only on plugin rows, filter=same rows); mutation probe (builder drops plugin rows → 4 tests red, restored). Panel uses a LOCAL pill badge + empty state — the shared EntityListBadge pulls the `@nessy-agent/ui` barrel which bun test cannot load (pre-existing pdfjs-dist family, proven on a clean tree). User/built-in rows are display-state only in this pass (their enable path is the source/plugin machinery, not a policy record) — recorded residual. Remaining dead renderer connectorOrigin display branches (SourcesListPanel enablement path, SourcesManagementRow connector kind, capability-info-metadata rows) + inert `SafeConnectorAuthRequest` wire type deferred to close-out (their test family cannot run under bun test) — C7 category string. CDP row on a packaged build stays a close-out item per plan § 1.6 |
| C7 | Category strings; close-out folds into the release close-out | ✅ | (this commit) | 8 category strings in § C7 (regex-verified against `scripts/regenerate-deviation-register.py`: 8 harvested); register/parity regeneration, version bump, release notes, docs-site, packaged-build CDP row and the renderer residue fold into the planner-driven release close-out per the dispatch. Also carries three final-wave fixes (house precedent: T8): the C1 endpoint-core test now asserts through `isSourceUsable` (house lint rule `no-inline-source-auth-check` — the one lint ERROR on the final diff), and BOTH C5/C6 probe tests construct `new PluginStoreV2({rootDirectory})` directly — `createPluginStoreV2({rootDirectory} as never)` silently discarded the option (first param is the layout TOKEN) and both tests shared the preload-isolated GLOBAL plugins dir, which made the toggle round-trip flake in aggregates via a cross-file wire-name collision (`tracker-mcp-e66356e196`). Expanded final-diff wave: 2611 pass across the whole affected boundary with ONLY the dispatch-named pre-existing families failing (two orchestration rows + session-mirror flake); typecheck:all + apps/cli green; lint 0 errors; i18n parity+sorted green; `git diff --check` clean |

## Task order and commits

One commit per task, tracker row in the same commit. Subjects:

- C1: `refactor(sources): the OAuth core is source-independent`
- C2: `feat(plugins): a plugin server owns a global credential slot`
- C3: `feat(plugins): plugin MCP servers ride the capability path with auth`
- C4: `feat(plugins): connector credentials migrate copy-only behind the flag`
- C5: `feat(plugins): the Source projection is deleted — sources are user-created only`
- C6: `feat(ui): one panel lists every MCP server with per-server enable`
- C7: `docs(audit): what the capability-path migration leaves open`

Gates are the ADR § 9 table's, verbatim, plus per-task mutation probes in the
house style (state which side went red). The § 8 iron rules bind every task:
the migration never deletes or overwrites a `source_oauth::`/`source_bearer::`
row, never throws on the startup path, never reports partial success — old rows
stay authoritative on any failure, and the worst user-visible outcome is a
re-auth prompt.

## Method rules

1. **Declared ≠ enforced.** Every gate that cites a live behaviour reruns the
   install probe in a TEMP config dir (`NESSY_CONFIG_DIR`), never the user's
   real `~/.nessy-agent`. Never write `~/.nessy/dp_auth_creds.json`.
2. **NUL bytes** — `grep -a` always; never truncate an uncounted grep. The C5
   absence checks are exactly the claim class this rule exists for.
3. **Two git commands** — pathspec on the `commit`. Run every test from the
   repository ROOT. `ps aux | grep "bun test"` before every run.
4. **Auth boundary is the named risk trigger**: expanded verification once on
   the final diff — sessions, sources, plugins, renderer aggregates,
   typecheck:all + apps/cli separately, lint, i18n parity + sorted,
   `git diff --check`.
5. The encrypted credential store in ANY test or probe is a fixture you
   created. The user's real store is untouchable.
6. C6 is a design surface change: playground states for the unified panel, and
   the CDP row lands on a packaged build at close-out per the ADR gate.

## Constraints

- No push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash; probes restored
  by re-edit or `.orig`, never git. No `Co-Authored-By`. No version bumps —
  C7's close-out folds into the release close-out, which the planner drives.
- `docs/superpowers/specs/` and `docs/testing/cdp-live-checklist.md` are
  planner-owned. The ADR itself is decision-of-record: do not edit it; report
  corrections for the planner to append.
- The Electron dev app on CDP 9224 is the owner's live rig — never touch it;
  `electron:build:servers` on disk is fine.
- Code, comments and commits in English.

## C7 — what the capability-path migration leaves open

Residual deviations, one category string each (harvested by
`scripts/regenerate-deviation-register.py`; the register regeneration itself is
planner-owned and runs at the release close-out, per the dispatch):

- documented, not implemented — the server-owned OAuth prepare path still omits
  the `mcp.oauth` override block: `authServerMetadataUrl`/`scopes` reach the
  refresh and monolithic flows but not `prepareOAuth`; the C1 extraction
  carried the omission byte-identically (`credential-manager.ts` prepare
  branch) rather than silently changing prepared flows, so a source pinned to
  an internal metadata proxy still discovers via the public well-known chain at
  sign-in time.
- documented, not implemented — Claude's `disabledMcpServers` opt-out covers
  "user-configured servers, plugin servers, claude.ai connectors, and built-in
  servers" (`mcp.md:201`); the C6 panel's per-server toggle rides
  capabilityId-scoped policy records, which exist only for plugin
  capabilities, so user-created and built-in rows are display-state only until
  a per-native-capability policy record exists.
- documented, not implemented — ADR § 2 has the migration purge a global
  connector row whose pluginKey has no active install (revoke before freeing
  the slot); the C4 migration SKIPS such rows instead, because the execution
  plan's iron rule ("the migration never deletes or overwrites a
  `source_oauth::`/`source_bearer::` row") is absolute and the purge belongs
  to the later flag-removal release.
- documented, not implemented — the catalog-authenticated promotion
  (`applyCatalogAuthentication`) now stamps `authType: 'oauth'` on the
  capability instead of synthesizing a `catalog.*` connector, and the
  capability path has no per-server auth TIMING field: pending auth is
  state-based (empty slot ⇒ surfaced), so the catalog's
  ON_INSTALL/ON_FIRST_USE granularity is intentionally dropped there.
- documented, not implemented — the § 7 renderer residue (SourcesListPanel's
  connector-source enablement path, SourcesManagementRow's connector kind,
  capability-info-metadata's connector rows) and the inert
  `SafeConnectorAuthRequest` wire type survive C5/C6: their component-test
  family cannot run under `bun test` (pre-existing pdfjs-dist import failure,
  reproduced on a clean tree), so the deletion moved to the release close-out
  where the packaged-build CDP row can stand in as the gate.
- documented, inapplicable — ADR § 8's "flag off = the Source projection runs exactly as
  before" ended WITH C5 by design: the projection code is deleted, so
  `NESSY_FEATURE_PLUGIN_MCP_CAPABILITY_PATH=0` is now an emergency "do not
  serve legacy connector servers" switch; rollback protection lives in the
  data instead (copy-only migration; a build DOWNGRADE finds every old row
  byte-identical).
- documented, not implemented — a flag-ON legacy-connector projection derives
  a NEW capability trust hash (the deleted connector-source grant keyed
  `connector:<id>:<server>` with a different digest), so a migrated pre-C3
  server asks for one re-REVIEW; re-AUTH is never demanded — the ADR's "no
  user re-authenticates" holds through the copied slots.
- documented, not implemented — the C2 trigger tool's plugin-server branch has
  no silent-refresh fast path (the source branch refreshes before raising an
  auth card); the pool's read-through refresh keeps slots fresh at
  materialization, so the only cost is an occasional avoidable auth card from
  an explicit model-initiated trigger.

Open close-out items (planner-driven, per the dispatch): version bump +
release notes + docs-site, deviation-register/parity-report regeneration, the
packaged-build CDP row for the unified panel, and the renderer residue above.

## Report

Commit shas; the C1 extraction proven behaviour-identical (existing OAuth
suites green unchanged); the migration exercised through failure and rollback
on a fixture store; the C5 install probe numbers (sources created: must be 0;
servers usable via capability path with real counts); the unified panel
rendering both origins with the toggle round-trip; every ADR/plan correction —
including whether the ADR's § 9 intro sentence ("C3 … goes first") against its
own table order (C1 first) confused anything; residual category strings word
for word; the explicit typecheck statement including apps/cli.
