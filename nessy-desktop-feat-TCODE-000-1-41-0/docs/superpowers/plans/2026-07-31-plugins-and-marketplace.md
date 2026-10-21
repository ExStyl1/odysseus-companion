# Plugins and the marketplace: install it, then be able to use it

One plan for everything plugin-shaped — our internal Skills Market, Claude
plugins, Codex plugins, and the path between "installed" and "the model can
call it". It replaces scattered tracking: five earlier plugin plans covered
*format and components*, none covered *lifecycle behaviour under failure*, and
that is where every defect the owner hit actually lives.

## Where this came from

Two independent multi-agent audits on 2026-07-31, both against live systems:

- **Lifecycle audit** — Claude's documented plugin lifecycle vs our code. 13
  gaps, 4 blockers, every one carrying a quoted doc sentence.
- **Marketplace audit** — six contract surfaces (Skills Market v1, Skills Market
  v2 Registry, our install pipeline, the Claude adapter, the Codex adapter, and
  install→usable per capability kind). 48 findings, each challenged by a skeptic
  told to refute it; 45 survived.

Findings are marked **CONFIRMED** (challenged and survived), **UNCHALLENGED**
(no skeptic reached it — weaker evidence, treat as probably-needs-rechecking),
or were dropped when refuted. Two blockers about the 106 command-less catalog
rows were **refuted** and are recorded in §Not doing so nobody re-files them.

## Tracker

Status: ⬜ open · 🔄 in progress · ✅ done · ⏸ parked on an owner decision ·
❌ withdrawn (the row was wrong — the reason is kept, not the task)

**Goal**: ① working internal marketplace · ② Claude/Codex plugins install ·
③ correct operation · ④ what the Claude docs say we lack.

One table, ordered by how soon a user stops being blocked. `dep` = must land
after. Rows sharing a **file** must not run concurrently — see §Parallelism.

| # | task | goal | status | commit | dep | note |
|---|---|---|---|---|---|---|
| A0 | A derived source has a label instead of a raw i18n key | ① | ✅ | `832f4acc` `4b157ea4` | | label landed `832f4acc`; the load-bearing assertion lands here. `plugins-source-confidence-labels.test.ts` drives the exported `installSourceLabel`/`unsupportedInstallReason` against the real `LOCALE_REGISTRY`, exhaustive over the SAFE union by `Record<…, true>` (the plan named the domain union — the renderer only ever sees the safe one; both are now pinned mutually assignable).
| B1 | The pending-auth notice refetches when capabilities change | ③ | ✅ | `a93ec18b` + `4c45ed33` | | subscription landed `a93ec18b`; the load-bearing assertion lands here. The old block only drove the exported helper, so it could not see the wiring. `PendingAuthNotice.test.tsx` now MOUNTS the component through a hook-dispatcher seam (React 18.3.1 `ReactCurrentDispatcher` — the repo ships no DOM and no `renderHook`, and `renderToStaticMarkup` never runs effects) and emits a real `capabilities.onChanged`. Three arms: a same-workspace event refetches **and the Connect affordance appears with no session switch**; another workspace does neither; unmount unsubscribes. **Mutation — the reviewer's own, not a helper swap:** delete `useEffect(() => subscribePendingAuthRefresh(…))` at `PendingAuthNotice.tsx:197-200` → mount arm RED at `fetchCount` **1 vs 2**, unmount arm RED at `unsubscribeCount` **0 vs 1** (**6 pass / 2 fail**); restored byte-identical (sha `b66b4e6a…`, `git status` clean) → **8 pass / 0 fail**. Under that same mutation the 5 pre-existing helper tests stay GREEN — that blindness is exactly what this row closes. **Positive control** for the other-workspace absence arm: the same stub and same `emit` path do refetch for the mounted id. `tsc --noEmit` (apps/electron) exit 0. Live gate still owed (packaged build on CDP 9224) |
| W1 | The sign-in notice is a card INSIDE the chat, not a strip above the app | ③ | ✅ | `0659446b` | B1, B2 | **Owner, with a screenshot: "да я включил, но вижу это сверху а не в самом чате в виде карточки".** **Premise reproduced on HEAD:** `MainContentPanel.tsx:255` rendered `PendingAuthNoticeForView` inside `wrapWithStoplight`, BEFORE `{content}` — a full-bleed strip above EVERY view, stacked with `SafeModeBanner` and `GatewayAuthBanner`. Third rejection of the same shape (Sources → MCPs `574e627e`, the duplicate plugin-page Connect `2eaa3cdc`). **Landed:** the shell mount and its import are DELETED; the only mount is `ChatDisplay.tsx:2310`, inside `<div className={cn(CHAT_LAYOUT.maxWidth, "mx-auto w-full px-3")}>` — the wrapper the earlier fix already gave `TaskChecklistPanel` and `AgentPanel`, so the width is followed, not invented, and equals the scrolling message column's `CHAT_LAYOUT.maxWidth`. The card body is `TaskChecklistPanel:54`/`AgentPanel:183`'s `rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs`, replacing the strip's `shrink-0 border-b border-foreground/10 bg-background`. **PLACEMENT ARGUED, not chosen on taste:** the session's only two system-ish cards both sit outside the ScrollArea between the message list and the composer, so the notice joins them rather than entering the message flow — the message list has never carried a non-message item, and a card pinned at its top scrolls away with the first turn, taking the only sign-in affordance we ship with it. It goes FIRST in that stack so the Connect button does not shift under the cursor when a checklist or agent row appears mid-turn. **The MCP exclusion is now unnecessary BY CONSTRUCTION:** `isMcpServersNavigation` and `PendingAuthNoticeForView` are deleted with the `NavigationState` import they needed, and a recursive scan of every renderer `.ts(x)` finds `<PendingAuthNotice` in exactly one file, `ChatDisplay.tsx`; **positive control on the same sweep**, `PendingAuthNoticeView` is still found at its live consumer `playground/registry/pending-auth-notice.tsx:74`. Nothing is lost elsewhere: `GatewayAuthBanner` still carries dp/login-required at shell level, and `PluginServerConnectButton` carries per-server sign-in on the MCP rows and the plugin page. **Production call site of the moved mount** (`grep -ran '<PendingAuthNotice'`): **1**, `ChatDisplay.tsx:2310`. **Gate** `PendingAuthNotice.test.tsx` **12 pass / 0 fail** (51 expects), placement asserted structurally because `ChatDisplay` cannot be mounted in this runner — **measured**: importing `@/config/layout` alone fails with `SyntaxError: Missing 'default' export in module .../pdfjs-dist/build/pdf.worker.min.mjs?url`, so source-reading is the repo's established fallback and every arm carries its own positive control. **Mutation 1 — return the mount to the shell wrapper** (import + JSX back in `wrapWithStoplight`, block removed from `ChatDisplay`): **9 pass / 3 fail** — chat-placement, shell-strip and only-mount arms all RED. **Mutation 2 — delete `useEffect(() => subscribePendingAuthRefresh(…))` at `PendingAuthNotice.tsx:215-218`:** **10 pass / 2 fail** — refetch arm RED at `fetchCount` **1 vs 2**, unmount arm RED at `unsubscribeCount` **0 vs 1**, i.e. B1's assertion still bites after the move. All three files restored byte-identical after each mutation (sha256 `cf0f1609…` notice, `23d38c4c…` shell, `1aa8d318…` chat) → **12 pass / 0 fail**. Dismissible, non-interrupting and session-start behaviour are untouched — the component itself is unchanged apart from its chrome. **LIVE, on the running dev app (CDP 9224, read-only):** the workspace summary really has a pending server — `getWorkspacePendingAuth` returns `sources:[{sourceSlug:'figma',reason:'needs-auth',canSignIn:true}]` — and the modules Vite is serving now carry the move: `MainContentPanel.tsx` **0** occurrences of `PendingAuthNotice`, `ChatDisplay.tsx` **3** plus the `mx-auto w-full px-3` wrapper (positive control that these are real modules and not the SPA fallback: 76 KB / 460 KB transformed, and the notice module itself shows 32). Adjacent suites green, run together: ChatDisplay follow-ups + branching + usage-overlay, McpServersPanel, TaskChecklistPanel, AgentPanel — **61 pass / 0 fail**. `bun run typecheck:electron` rc 0; eslint on the four files 0 errors (5 pre-existing `exhaustive-deps` warnings in `ChatDisplay`); `git diff --check` clean. **OWED:** the pixel check with a chat actually open — the app was parked on Sources → MCPs and this zone may not drive input, so the rendered card's measured width and position on a packaged build is the planner's; and the playground entry `pending-auth-notice` (out of zone) still frames the View as a standalone strip, so the new card chrome is unswept there. |
| W2 | One Sources card everywhere, and Enable/Disable as one action wherever the option exists | ③ | ✅ | `e3f2b163` | A7, W1 | **Owner, driving the app, three reports.** (1) «встроенные мсп не отображаются если выбрать пункт где все sources» — **already closed by `b57e5db3`, not re-fixed here.** The built-in set is projected into the catalog as ordinary `kind:'mcp'` records, so it reaches the aggregate list through `isSafeSourceRow` with no second addend; what was missing was the ASSERTION, and the owner was reading an app whose main bundle predates that commit. `source-navigation-counts.test.ts` now pins the built-ins IN the aggregate rows and pins `rows.length === counts.total` — the counter deliberately stays an independent sum, because a count re-derived from the list it labels can never disagree with it. (2) «карточки … к единому виду … оставим просто самую важную информацию»: every Sources/Skills row is now icon + name + ONE category badge (`SourceCardBadges`), and the description tail, the second “Plugin” badge and the `PluginOriginBadge` acquisition pill are GONE from both `SourcesListPanel` branches and from `SkillsListPanel`. Colours are per-category in hue AND fill; `skill` moved off the neutral `foreground/10` it shared with the old plugin badge, following the raw-palette precedent the sky plugin badge set (2026-07-19). (3) «включение … одной кнопкой … а так же в подробностях элемента»: a built-in dp MCP row now carries Enable/Disable in the row menu, and `SourceInfoPage` grows the SAME action through the SAME `SourceEnablementMenuItems` component. **The two write paths are NOT unified** (owner decision): `lib/source-enablement.ts` is a discriminated union, so a `builtin` value structurally cannot reach the plugin mutation and a `plugin` value cannot reach `setBuiltinDpMcpServerEnabled`. Rows with no such option (native `.mcp.json`, api, local, and a plugin row with no `connectorOrigin`) return `undefined` and grow no dead item. **Deviation, deliberate:** the brief said “exactly one action”; a plugin row with a project context still offers one per SCOPE (workspace + active project), because the 2026-07-19 owner decision offers both and they are different states — each is still a single action labelled from its own state. **Testability is why the decisions are pure functions:** `SourceMenu`/`SourceDetailActions` import `menu-context`/`styled-dropdown`, and the bun runner cannot load that `@nessy-agent/ui` barrel — re-measured here (`source-avatar`, `skill-avatar`, `PluginOriginBadge` LOAD; `entity-list-badge`, `menu-context` FAIL on `pdfjs-dist/…/pdf.worker.min.mjs?url`), which is also why `SourceCardBadges` carries local badge markup rather than importing `EntityListBadge`. **Gate:** `source-card` + `source-enablement` + `source-navigation-counts` **31 pass / 0 fail**; `packages/shared/src/i18n` **35 pass / 0 fail** (new `sources-card-keys.test.ts` drives every `sourcesList.*`/`sourcesManagement.*` literal in the renderer through real i18next in every locale — the hole both lint gates are blind to). Renderer suite **994 pass / 6 fail / 1 error**; the SAME 6 + 1 reproduce on a clean worktree at HEAD `4494934b` (**968 pass / 6 fail / 1 error**) — pre-existing cross-file `mock.module` leakage in the info/pages files, all of which pass in isolation. **Mutations:** (a) filter `origin !== 'builtin'` out of `buildRuntimeResourceRows` → **5 pass / 3 fail**, count-equals-length RED; (b) drop the `origin === 'plugin'` guard so a native row gets an action → **8 pass / 1 fail**, dead-item arm RED; (c) route the built-in's `run()` through `onTogglePlugin` → **8 pass / 1 fail**, settings-key arm RED; (d) put the description tail back in the card → **2 pass / 12 fail**. All files restored by `cp` from backup and re-verified. **Playground swept:** `entity-list-sources` (All Sources / MCP Only / With Selection), `entity-list-skills`, `entity-list-mixed` (grouped + flat) and `entity-list-interactive` all render the new card, and they import the PRODUCTION `SOURCE_CATEGORY_BADGE` colours so the palette cannot drift; the `entity-row` primitive entry and the `Management` variant (`SourcesManagementRow`) are deliberately unchanged. `bun run typecheck:all` rc 0, **each package also run individually** (core, shared, server-core, server, session-tools-core, ui, pi-agent-server, electron) plus `apps/cli` separately — all rc 0; `lint` 0 errors; `lint:i18n:parity` + `:sorted` green. **NOT unified, and it is a real gap:** `McpServersPanel` rows (the MCPs filter) keep origin/transport/auth badges and their inline switch, and `SourcesManagementRow` (the Plugins subsection) keeps its description and origin pill. Both are control surfaces whose extra badges are load-bearing (the auth badge is what the Connect button answers), so unifying them is an owner call, not an executor's. **OWED:** no live check — nothing was listening on CDP 9224 by the time this ran. |
| C1 | `hooks`/`mcpServers` load from a declared path or inline | ② | ✅ | `7359a814` | | default file / declared path / inline all yield one capability set; mutation drops the inline arm to `[]` |
| D1 | The official Codex catalog browses with names | ② | ✅ | `f87591fd` | | measured on the real clone: 0 → 180 of 180 with description/version/displayName |
| B2 | Every surface that says "Sign in required" can sign you in | ③ | ✅ | `7910008b` | B3 | Both surfaces now render one shared `PluginServerConnectButton` making the exact `performOAuth` call `PendingAuthNotice.tsx:196-202` makes; `bearer`/`environment`/`dp`, ready and user rows render nothing. **Correction — `SafeCapabilitySummary` does NOT gain the auth kind.** Its producer `toSafeSummary` (`views.ts:321`) is outside zone V2, so the field would have landed with no writer — the dead-half shape wave 1 was demoted for — and it is not needed: the kind ALREADY crosses the wire per plugin on `SafeInstalledPluginSummary.authRequirements` (`views.ts:388`, from `derivePluginMcpAuthRequirements`), which `PluginInfoPage` was already rendering as static text. New `pluginServerAuthKind()` in `protocol/capabilities.ts` joins it per server on the capability `logicalName` — the manifest `mcp.serverName`, NOT the row label, since a manifest may override `displayName` (the oauth fixture deliberately does, and a label join would refuse it). **Premise reproduced:** `grep -acn performOAuth` = **0** in both files and auth-kind discrimination in the panel = **0**; **positive control on the same sweep**, `PendingAuthNotice.tsx` = **3**. **Four mutations, each red from 15 pass / 0 fail across both suites:** drop the auth-kind guard → **11/4** (the bearer AND environment arms red on BOTH surfaces); compute the control and never render it → **12/3**; `onClick` a no-op → **14/1**, the wiring arm the markup arms cannot see; revert the plugin page section to informational → **14/1**. All three files restored byte-identical (sha256 match) → **15/0**. `typecheck:shared` rc 0, `typecheck:electron` rc 0, eslint rc 0. **OWED:** no new i18n keys — labels reuse `pendingAuth.connect/connecting/error`, so an expired slot reads "Connect", not "Reconnect" (both locale files are another zone's); the playground `mcp-servers-panel` entry carries no not-ready-oauth knob (out of zone); the LIVE sign-in on a packaged build is the planner's |
| B3 | The model-facing plugin sign-in tool is wired | ③ | ✅ | `f2ef9041` | | **Pi arm landed and gated end-to-end** through `routeToolCall` → registry handler → the context `pi-agent.ts` builds; both mutations (producer call, context getter) turn all three cases red with the exact pre-fix refusal. **Corrections: ONE factory, not two** — `createClaudeContext` serves Claude AND Pi; and the **Codex arm is deliberately absent** (measured 37 → 18 tools under `--external-standalone-only`, `source_oauth_trigger` dropped, control `config_validate` kept). **OWED:** `ClaudeAgent` never publishes the authority — one line at `claude-agent.ts:853`, out of zone **VERIFIED live in production**: `pi-agent.ts:1046` populates `resolvePluginMcpServerFn`, `claude-context.ts:285` reads it through the registry. Codex arm deliberately absent — `--external-standalone-only` drops the tool before any handler. |
| A4 | A marketplace refresh stops blinding the catalog while it runs | ① | ✅ | `a8bc46cb` | | measured 34.97 s window; the cure is the cause |
| A5 | A failed fetch is not cached as if it were a catalog | ①④ | ✅ | `4f6fa69e` | A4 | the non-healing half; upstream fixed this in v2.1.214 |
| A6 | An upgrade reports what actually happened | ① | ✅ | `7e2dfa4b` `0268e8f5` | A5 | resolver half `7e2dfa4b`. **The false success toast is now closed**: `applyRegistryUpgrade` (exported from `PluginsPage.tsx`) reads `upgraded` — `false` ends in the action-error banner + an error toast and **no catalog refetch**, so a throwing clone can no longer render as "Marketplace upgraded" over the pre-upgrade list. Two mutations, both red: drop the `upgraded` guard → the `upgraded:false` case goes red; revert the handler to `await mutateAsync(...)` + `toast.success(...)` → the wiring assertion goes red (the helper alone does not prove the button). The listing-miss error also stops advising "refresh the marketplace and try again" (A4 made that remedy the cause) and names the `<marketplaceId>:<name>` id shape; mutation reverts → red. **STILL OWED, out of zone W1:** `reason`/`diagnosticCodes` cannot cross the RPC because `SafeMarketplaceUpgradeRegistryResult` (`packages/shared/src/protocol/capabilities.ts:617`) carries only `{marketplaceId, upgraded}`, and the distinct *pending vs failed* wording needs new keys in both locale files. Until then the renderer can say "it did not happen", not "why" **VERIFIED end to end**: `registry-source.ts:807` → RPC → `PluginsPage.tsx:605` `applyRegistryUpgrade` with `toastError`/`setActionError` and no refetch on failure. |
| E1 | One failing server stops taking the others down | ③④ | ✅ | `9891167f` | | per-server try/catch in `materializeSnapshotMcpServers`; `revoked` stays batch-fatal. `setSourceServers` NOT crossed — see the note below the row |
| B4 | A server pending OAuth is visible mid-turn | ③ | ✅ | `f14f89c5` | B3 | Landed as a NON-INTERRUPTING `<system-reminder>` on the VOLATILE context tail, so signing in mid-session does not re-stamp Pi's cached prefix (#862). `setSourceServers` joins `externalAuthRequirements` to the pinned view (`collectPendingPluginServerAuth`) so each pending server keeps its own `pluginKey`/`serverName` — the requirement aggregates them per PROVIDER, which would have mis-named a second unauthorized plugin. `dp` is dropped from the join on purpose: that one still pauses, in `SessionManager.preflightDpAuth`, untouched here. Gate drives the REAL `materializeRuntimePoolServers` over a materializer that THROWS `credential-not-ready` like production; 6 pass. **Mutations:** delete the producer call → 3 fail (the reminder vanishes); make it interrupting (`onAuthRequest` + `interruptForHandoff`) → 1 fail, exactly the non-pause assertion, with the handoff callback armed BEFORE the seam. Positive control for the absence: the same agent raises a real handoff via `handleSessionMcpToolCompletion`. Server names are defanged (`neutralizeHarnessMarkers`) so a plugin cannot close the host block |
| B5 | A skill does not instruct the model to call tools that are not there | ③ | ✅ | `18e0c739` | B4 | Premise RE-MEASURED independently on the owner's real `installed.json`: 12 skill capabilities, **8** naming a Figma MCP tool, **5** distinct (`use_figma`, `get_design_context`, `create_new_file`, `generate_diagram`, `get_motion_context`) — the skeptic's re-count, not the first audit's four. Landed as ` [server 'figma' needs sign-in]` in `<available_skills>`, matched on the DECLARING plugin instance so name similarity cannot mark a stranger's skill. Gate asserts marked/unmarked in the SAME listing (two plugin skills marked, another plugin's and a native one untouched, `needs sign-in` count == 2); 9 pass with B4. **Mutations:** drop the annotation → 2 fail; drop the plugin-instance filter so every skill is marked → 1 fail, the untouched-neighbour case. The suffix rides the STABLE part on purpose — it changes only when the credential slot does, and the capability generation turns over then anyway |
| B6 | An `ON_INSTALL` connector is not silently downgraded | ③ | ✅ | `8d91084c` `8d3a3d56` | | **CLOSED by the planner, both halves in one commit `8d3a3d56` — the two zones were each too narrow, and the fix needed exactly three files no zone owned together.** The timing is read back off the twin connector `twinLessConnectors` drops (`auth-requirements.ts`), which is the only descriptor a catalog policy writes it onto; the checklist's two `timing !== 'ON_INSTALL'` filters are gone (`PluginInstallChecklist.tsx`), because the `consumeConnectorAuthRequests` chain they assumed has never run — `authRequests` is assigned nowhere service-side, re-confirmed with `grep -an` (control: `authRequirements` at `management-service-v2.ts:1159`). Landing the derivation alone was the measured regression both zones correctly refused: `derivePluginSetupChecklist` returns `null` at `ON_INSTALL`, i.e. no dialog at all. Third half, found while landing: `summarizePluginInstallSetup`'s ON_INSTALL note claimed the servers "ask the user to connect now (install-time sign-in)" and reaches the MODEL through `plugin-management-tools.ts:199` — with the timing corrected it would have asserted an authorisation that never happened, so it now names the three surfaces that really offer it. Mutation-verified both ways: re-hardcoding the timing fails 1 of 4 in `auth-requirements.test.ts`; restoring either filter fails 1 of 6 in `plugin-install-checklist.test.tsx`. 18 pass across the four affected files; `typecheck:shared` + `typecheck:electron` clean. `authRequests`' deletion is deliberately NOT part of this — it is dead-field cleanup across 5 out-of-scope declarations, not user-visible. History from the two blocked zones follows. **Zone Y1, base `3dc99a46` — the honest minimum LANDED, the timing chain stays BLOCKED, and W6's blocked judgement is CONFIRMED by re-measurement, not by reading its report.** Premise re-reproduced against the owner's real record: figma carries `origin.provenance.connectorAuthTiming = ON_INSTALL` and `manifest.connectors[0].auth.timing = ON_INSTALL`, yet `derivePluginMcpAuthRequirements(entry.manifest)` returns exactly `[{kind:'oauth', timing:'ON_FIRST_USE', connectorIds:['mcp.connector_68df…figma'], serverNames:['figma']}]`. **Precise loss point (new, and it is in Y1's own file):** `management-service-v2.ts:applyCatalogAuthentication` writes the catalog policy onto `connectors[].auth.timing` only — the `kind:'mcp'` capability twin it also rewrites has no timing field to carry it — so `twinLessConnectors` drops the one descriptor holding the value and the capability branch then hardcodes the bucket. The comment at `auth-requirements.ts:109-113` is **accurate but incomplete**, not false as earlier read: `ON_FIRST_USE` really is "the value both adapters always declared" (`claude.ts:1116`, `codex.ts:1049` both hardcode it); figma's `ON_INSTALL` arrives from the CATALOG policy path (`external-catalog-adapters.ts:301`, `entry.policy.authentication`), which that comment does not mention — which is exactly why the row reads as closed to a passing reader. **Re-measured regression, against the real renderer function, not by reasoning:** `derivePluginSetupChecklist({ok:true, authRequirements:[{kind:'oauth',serverNames:['figma'],timing:'ON_INSTALL'}]})` → `null` (no dialog at all); the same input at `ON_FIRST_USE` → `{connectors:[{serverName:'figma'}],serversNeedingSetup:1}`. The plan's fix landed alone therefore replaces a row carrying a false hint with **no row at all** — strictly worse — so it is NOT landed. **LANDED instead:** `pluginChecklist.connectorHint` en `"Sign-in happens in chat — the session notice offers it when a chat starts."` / ru `"Вход выполняется в чате — уведомление предложит подключение при старте сессии."` The false first clause is gone; the second survives because it is true — pending-auth feed 2b (`server-core/src/sessions/pending-auth-summary.ts:83-100`) emits an `oauth` plugin server with `canSignIn: true`, the row `PendingAuthNotice.tsx:130` puts a sign-in button on. With the timing chain unrepaired this is now the *correct* end state, not a placeholder: `connectorRow` + this hint describe what actually happens to figma. Production call site of the changed string: `PluginInstallChecklist.tsx:227`, one site (`grep -an`). **`authRequests` fold-in — DELETE, and neither half is landable from Y1.** Populating is impossible at the seam the plan names: `summarizeInstalled(entry)` has no `workspaceId`, which `PluginConnectorAuthRequest` requires, and C3 deleted the Source whose `sourceSlug` the renderer's `consumeConnectorAuthRequests` would hand to `performOAuth`. Deleting is typecheck-breaking from inside Y1 — the read sites (`server-core/handlers/rpc/marketplace.ts:270`, `rpc/plugins.ts:84`, `:100`) and the Safe declarations (`protocol/capabilities.ts:439`, `:607`) are all out of zone. Absence re-confirmed with `grep -an` repo-wide: no assignment to `authRequests` anywhere; positive control on the same command, `authRequirements` is assigned at `management-service-v2.ts:1159`/`:1173`. **STILL OWED, all out of zone Y1:** the `ON_INSTALL` exclusion and its stale comment in `PluginInstallChecklist.tsx:63-65/84/94`; the wire target for an ON_INSTALL request (`pluginServer` vs `sourceSlug` — planner's call); and the timing read in `derivePluginMcpAuthRequirements`, which must land in the SAME commit wave as the renderer half or not at all. Plus a live packaged-build check. Historical note from zone W6 follows. **BLOCKED from zone W6 — no code landed, and the plan's fix must not land as written.** Premise reproduced on the owner's record: the timing is in the MANIFEST too (`connectors[0].auth.timing = ON_INSTALL`), not only in provenance — the twin gate drops the connector that carries it and the capability branch hardcodes the bucket, so `derivePluginMcpAuthRequirements` returns `ON_FIRST_USE`. **The fix landed alone is a MEASURED regression:** `derivePluginSetupChecklist` with `timing:'ON_INSTALL'` returns `null` — no checklist dialog at all, where today the row at least names `figma`. Its exclusion comment ("the OAuth chain has already run") is false: `PluginManagementResult.authRequests` is assigned NOWHERE service-side (control: `authRequirements:` is assigned at `management-service-v2.ts:1159` + 2 agent-tool sites), so `pendingAuth`/`authRequests` never cross the wire and no install-time OAuth has ever run. Populating it as suggested is also unsafe — its contract is `{workspaceId, sourceSlug}` and C3 deleted the Source for capability-path connectors, so it would aim `consumeConnectorAuthRequests` at a slug that does not exist; the repair is a `pluginServer` target (wire shape — planner's call) or deletion (3 read sites, all out of zone). And `auth-requirements.ts:109-113` already records the drop as owner decision § 0b-2 / C3, deviation-register line 481. **OWED, every user-visible half out of zone W6:** `pluginChecklist.connectorHint` (locales = Z1's exclusive files) — only its first clause "No sign-in is needed now" is false; the second is TRUE (pending-auth feed 2b names an oauth plugin server with `canSignIn`), so the honest rewrite keeps it — plus `PluginInstallChecklist.tsx` and the RPC/wire halves |
| E4 | The remaining unguarded `resolveCredential` sites re-resolve | ③ | ✅ | `474d18ad` + `3c25ec92` | E3 ✅ | **five** sites, not four — `:387` is one too. The error names the store's current revision, which is what makes one re-resolve possible; expiry reaches it through the same revision change. All five now carry an arm: the two lazy pool getters (`:180` credential, `:187` token) are driven through a REAL pooled tool call over the SDK's own transport a turn later — nothing is rebuilt, so the closure under test is the one the pool holds — and `materializePluginMcpCredentialEnvironment` (`:580`) through a spawned plugin's subprocess env. Premise reproduced before fixing: HEAD's suite is 53 pass with all three of those guards removed; **positive control** — removing the already-covered `:387` guard reddens that same suite (52 pass/1 fail), so the suite can see a removed guard and simply was not looking at these three. Per-site mutation, one site at a time: `:180`→bearer arm red, `:187`→OAuth arm red, `:580`→both plugin-env arms red, 59 pass/0 fail restored each time. The floor is not widened — a lease that dies after the turn still fails a pooled call with `capability-snapshot-revoked`, and a record expired AT the new revision still withholds the plugin |
| C2 | A plugin agent keeps its `description` | ② | ✅ | `6928ac91` | | one line; mutation returns `undefined`. `description` is the ONE agent frontmatter field the runtime does not re-read from the file — the other ten arrive as `agent.X ?? frontmatter.X` |
| C3 | A marketplace `renames` map is honoured | ② | ✅ | `ad1025b4` `e10a7256` | | **CLOSED — the map does not cross the wire at all; the ROW carries the ids it used to have.** Shape chosen: `formerIds: string[]` on `MarketplaceCatalogItem` (`marketplace/types.ts`) and `SafeMarketplaceCatalogItem` (`protocol/capabilities.ts`), derived server-side by inverting the parser's resolved `renames` at `registry-catalog-items.ts:registryCatalogItems` — `{qodo-skills: 'qodo'}` becomes `id 'reg:qodo'` carrying `formerIds ['reg:qodo-skills']`. **Why this over the whole-map field the previous zones were sized for:** the map is per-registry and the list result is not, so a map on `MarketplaceListResult` would have had to re-carry its own registry key and make the renderer re-apply the registry anchor and the null-is-a-removal rule by hand; on the row both rulings become structural. A `null` rename has NO surviving row to attach to, so it cannot join anything — **measured, not argued**: mutation M2b deletes the `null` guard AND actively attaches removed names, and the suite stays 12/0 green, because `formerIds.get(name)` finds no row. The teeth for that ruling are therefore in the renderer, where the join decision lives (M6 below). **Correction to the seven-hop map both zones recorded: only FIVE hops need code.** `MarketplaceListResult` (`types.ts:230`), `MarketplaceRegistryListResult` (`service.ts:51`) and `SafeMarketplaceListResult` (`capabilities.ts:521`) all hold `MarketplaceCatalogItem[]`/`SafeMarketplaceCatalogItem[]` and pass items by reference (`service.ts:mergeRegistryItems`/`filterRegistryItems` spread, never reshape), so a field on the ITEM crosses them with zero edits — that is what made the work fit. The hop the map really would have died at is `registry-source.ts`, and it needed no field either: `PersistedCatalogEntry.items` JSON-round-trips the row. What it DID need is `CATALOG_CACHE_SCHEMA_VERSION` **1 → 2** — a `v1` file is served on a signature match without a fetch, and the signature only moves on an upgrade, so an already-cached registry would have served rename-blind rows forever and the join would never have fired in production while every test passed. **Five production files:** `registry-catalog-items.ts` (derivation), `registry-source.ts` (cache invalidation), `marketplace/types.ts`, `protocol/capabilities.ts`, `rpc/marketplace.ts:toSafeMarketplaceCatalogItem` (allowlist projection), `useMarketplaceItems.ts:matchesInstalledItem` — which now tests `[item.id, ...formerIds]` against the SAME three equalities it already used, adding no join semantics and no name fallback. **Mutations, one at a time, restored byte-identical (sha256 `e9fd3ccf…` / `c46dc02a…` / `42970636…` / `e44633d8…`):** M1 re-discard the map → **8 pass / 4 fail** (was 12/0); M2 drop the still-listed-former-name guard → **11/1**; M2b drop the `null` guard → **12/0, green by construction**; M3 revert the cache schema to `1` → **42/2** (was 44/0); M4 drop the Safe projection → **17/1** (was 18/0); M5 join ignores `formerIds` → **13/1** (was 14/0); M6 re-add the REFUSED `installed.name === item.name` fallback → **13/1**. **Gates:** `registry-catalog-items` 12/0, `registry-source` 44/0, rpc `marketplace` 18/0, hook `useMarketplaceItems` 14/0; `bun test packages/shared/src/marketplace packages/shared/src/protocol` **195/0**, `apps/electron/src/renderer/hooks` **109/0**; `bun run typecheck:all` rc 0; eslint clean; `git diff --check` clean. `packages/server-core/src/handlers/rpc` shows 161/2 — the documented order-dependent `mock.module` leak from `sessions.search-content.test.ts` (known-failing register § *Order-dependent mock leak*), reproduced with the marketplace file passing 18/18 alone. History from the two blocked zones follows. resolved against the real 1.59 MB catalog; the joiner rewrite in `useMarketplaceItems.ts` is OWED (renderer, other zone). **Wave 3 / zone X2: BLOCKED, no code landed — the fix cannot be made in a zone that owns only `service.ts`, `registry-catalog-items.ts` and `useMarketplaceItems.ts`.** Premise re-reproduced end to end on the LIVE catalog (`anthropics/claude-plugins-community`, 1585046 bytes, 2307 plugins, fetched anonymously 2026-07-31): its `renames` is exactly the four the row names, `parseExternalPluginCatalog('claude', …)` resolves all four, and `registryCatalogItems` returns `Object.keys() = diagnostics,items` — `'renames' in result` is **false**, discarded at `registry-catalog-items.ts:75`. Measured on the same run: the current row's id is `community:qodo` while a record installed under the former name carries `community:qodo-skills`, which is what `matchesInstalledItem` cannot join. **The map has to cross seven hops and five of them are other zones' files:** producer `registry-source.ts:692` (the ONLY production caller of `registryCatalogItems`, and it must carry the map through its cached catalog entry and out of `listItems()`); `MarketplaceListResult` `marketplace/types.ts:230`; `toSafeMarketplaceListResult` `server-core/src/handlers/rpc/marketplace.ts:507`; `SafeMarketplaceListResult` `protocol/capabilities.ts:521` (and/or `SafeMarketplaceCatalogItem` `:467`, which today carries no alias/former-name field at all). Only `MarketplaceRegistryListResult` (`service.ts:51`) and the join itself (`useMarketplaceItems.ts`) are in zone. **No half was landed on purpose:** stamping the map on `registryCatalogItems`' result alone is precisely the dead half this wave exists to stop — nothing would read it. **Nothing already on the wire can substitute:** the renamed row's `name`, `id`, `pluginId` and `pluginKey` all carry the CURRENT name, so the renderer has no signal to join a stored former name without the map **Wave 4 / zone Y2: BLOCKED again, no code landed — and this zone is NARROWER than X2's, not wider.** Y2 owns `external-catalog-adapters.ts`, `registry-catalog-items.ts`, `useMarketplaceItems.ts` and `PluginsPage.tsx`; it owns neither `registry-source.ts` (X2 did not either) nor `service.ts` (X2 did), so of the seven hops the map must cross, **six** are now another zone's file. **Premise re-reproduced independently on `3dc99a46`** with a local probe over the parser's own API (no network, four renames incl. a `null`): `parseExternalPluginCatalog('claude', …)` returns `keys = proposals,diagnostics,renames` with `{qodo-skills→qodo, auth0-sdks→auth0, gone-plugin→null}` resolved, while `registryCatalogItems(…)` returns `Object.keys() = items,diagnostics` and `'renames' in result` is **false** — discarded at `registry-catalog-items.ts:75`, exactly as three reviewers recorded. **The half that IS in zone was deliberately not landed:** stamping the resolved map on `registryCatalogItems`' result gives it no reader, which is the dead-half this wave exists to refuse. **And nothing already on the wire can carry it instead** — read field by field this pass: `MarketplaceCatalogItem` (`marketplace/types.ts:340-387`) and `SafeMarketplaceCatalogItem` (`protocol/capabilities.ts:467-491`) have no alias / former-name / passthrough field between them, and the row's `raw` is deliberately emptied for registry rows and never projected to the renderer. A renderer-only bridge was checked and refused too: `matchesInstalledItem` could fall back to `installed.name === item.name`, but the installed record carries the name captured AT INSTALL time and a name join would also fire across unrelated plugins. **The unblocking edit is one field on `MarketplaceListResult` + one on the safe result (or an alias field on the safe ROW, which the join would prefer), plus the two producers; give it to a zone that owns `registry-source.ts` + `marketplace/types.ts` + `rpc/marketplace.ts` + `protocol/capabilities.ts` together with `useMarketplaceItems.ts` — split any further and it blocks again.** |
| C5 | LSP servers keep `env`/`workspaceFolder`; the rest is a diagnostic, not a deferred row | ② | ✅ | `3f044263` `414fd331` | | **Path (a) plus the channel rule it forced.** The carry is complete: the resolver binding carries both fields, `toAgentRuntime().lspServers` hands them to `SessionManager`, and `resolvePluginLspLaunch` turns them into the spawn's `env`/`workingDirectory` — placeholders expanded against the plugin runtime env, the host's own runtime binding layered ABOVE the declaration (stdio-MCP's order), an out-of-root folder falling back instead of becoming a supervised cwd; `substituteLsp` now covers both, so `${user_config.KEY}` works there. `workspaceRoot` is deliberately untouched — it is `resolvePiLspDocumentUri`'s containment boundary. **Premise re-measured and both halves corrected.** (1) The cost is not an install prompt: `requiresConfirmation` comes from `repair`/`update` only (`management-service-v2.ts:196` returns without it), so a `deferred` row means an UPDATE that purges policy and switches the plugin off. (2) The catalogue counts: 0 of 2307 community entries declare `lspServers`; 12 of 276 official ones do; **0** declare `env` or `workspaceFolder`; exactly **2** (`jdtls-lsp`, `kotlin-lsp`) declare a field from the unread list, both `startupTimeout` — so the deferred row's whole measurable effect was to switch those two off over a knob. It is now a warning diagnostic on D3's channel (`diagnosticCodes`, every install); the deferred row for a SKIPPED server stays and is the positive control. **Gates:** `claude-lsp-fields.test.ts` 5 pass (install AND update driven through `PluginManagementServiceV2`), `plugin-user-config-substitution.test.ts` 12 pass, `SessionManager.process-supervisor.test.ts` 36 pass. **Mutations, one at a time, each restored byte-identical by sha:** restore the deferred push → 2 fail; drop the resolver carry → 1 fail; drop `substituteLsp`'s two fields → 1 fail; revert the spawn to `env: {...pluginEnvironment, ...executable.environment}` + `managed.workingDirectory` → the WIRING test fails while the helper test stays green, which is the split it exists for. **Correction:** `capabilities/projection.ts` does not exist and `plugins/projection.ts`'s `lspServers` has zero production readers, so nothing was added there — see §C5. **OWED, out of zone:** `startupTimeout` (`types.ts`+`schema.ts`) — `LspService` already has the knob, its default is 12 s, and both plugins that declare it ask for 120 s, so they abort at `initialize` today |
| D3 | Dropped Codex manifest fields leave a diagnostic | ② | ✅ | `08d6c60a` `52e5a700` | | measured: 180/180 real bundles drop a listing block; 29 of them said `supported`. **The "dead channel" reading is half wrong, measured through `PluginManagementServiceV2`:** the warning is pushed into the array the adapter RETURNS, so it reaches `PluginManagementInstallResult.diagnostics` → `rpc/marketplace.ts:275` `diagnosticCodes` on EVERY install, with `state` still `supported`. It is `adapter.warnings` AND the live wire. **OWED (renderer, out of zone):** a reader on the SUCCESS path — `PluginsPage` reads `diagnosticCodes` only in the blocked branch, while the success branch already hands the whole result to `installChecklist.offer`. Mutation = route it only to `adapter.warnings` (what the demotion assumed shipped) → red |
| D4 | `.agent-plugin/plugin.json` is recognised | ② | ✅ | `6d21bfe0` | | landed in Z-W7. **Premise corrected — it was not "unrecognised", it was MIS-adopted.** Measured before the fix: a `.agent-plugin` bundle that also has `skills/` is claimed by the Claude adapter's manifestless discovery, so the manifest is never read and the plugin installs as id/name = the temp DIRECTORY name at version `0.0.0`; the same bundle without `skills/` is refused `unsupported_format`. After: `codex-plugin-json`, id `honey`, version `1.0.0`. Gate is the end-to-end install through `PluginManagementServiceV2`, plus a precedence arm (both manifests → `.codex-plugin` still wins). **OWED, root half only:** the sentence also permits the manifest "at the root **or in its single top-level directory**" — the bundle root is chosen before any adapter runs, so that half is the staging layer's, not detection's. Also OWED: `registry-catalog-fetcher.ts:144` `PLUGIN_MANIFEST_DESCRIPTORS` (Z4's file) still scans only `.codex-plugin`/`.claude-plugin` |
| D2 | We stop executing hooks upstream parses and skips | ② | ✅ | `0c303c83` | | hooks.md: prompt and agent handlers are "parsed but skipped"; this also corrects R16 §4.4 |
| D5 | Documented command-hook fields have a reader | ② | ✅ | `c5f4d13a` | | `commandWindows` applied on win32; `additionalContextLimit`/`async` parsed and reported |
| D6 | Codex `SessionEnd` gets its own 3 s ceiling | ② | ✅ | `e16957bb` | | landed in Z-W7. Premise reproduced on the LIVE runtime path before the fix (`{codex-end:1500, claude-end:1500}` from the timeout the injected command runner actually receives), 3000/1500 after. The discriminator is the normalized `PluginRuntimeCompatibilityProfile`, never adapterId/origin — same rule `pluginRuntimeEnvForProfile` states; the projection path has no profile on its hook record, so it is looked up per instance off `plan.activeCapabilities[].entry.manifest`. Gated on BOTH callers through their real builders (`buildPinnedAgentAutomationSystem`, `buildTrustedPluginHookAutomations`), never on the helper. **Decide: the second half of the same sentence also landed** — "`SessionEnd` uses `1` second by DEFAULT", so a Codex SessionEnd hook declaring nothing now gets 1000 ms where it got Claude's 1500; one line to revert if the planner wants ceiling-only |
| E2 | A pooled `api` source does not capture a dead lease | ③ | ⬜ | | | **mechanism confirmed and STRONGER than stated; consequence NOT reachable.** `runSync` releases the lease at `workspace-mcp-pool-registry.ts:328` and syncs at `:345`, so the browse pool's `api` closures are born dead — not merely outliving a turn. But an `api` closure only runs from a tool handler, and all nine `.callTool(` sites take a SESSION leaser; the browse leaser has 6 uses, none a tool call. The session path re-materializes on every send. Fix also needs a `CapabilityResolver` the pool materializer never receives — it is the CALLERS' file |
| E6 | Provenance records the resolved version, not the advertised one | ① | ✅ | `6cc23ccc` | | resolved version + the verified sha512 (never the sha1 `dist.shasum`, which A9 now refuses) are stamped on the record. Gate is the PRODUCTION repair path: install at advertised `1.0.9`, let the registry publish a NEWER stamp of the same base, repair — and it re-downloads the original tarball. The installed↔catalog join needed widening in the same commit or a stamped install reads as not-installed in browse |
| A3 | A GitLab archive comes from the documented API route | ① | ✅ | `58884870` | | premise re-probed anonymously 2026-07-31: web route → **302 `text/html`** → `/users/sign_in`; **positive control, same host, same minute**: API route → **404 `application/json`**, i.e. it fails TYPED. API route + `&path=` now; `downloadArtifact` refuses an HTML body before `writeFile`. The old fixture pinned the WEB URLs and asserted only the auth header — it could not fail the way production did |
| F1 | Browse can filter 6084 skills | ① | ✅ | `8319630c` `7205576e` | | client half landed `8319630c`. **Premise re-reproduced on HEAD** (wave 1b, zone W1): `getMarketplaceSkillFacets` has ZERO production callers — `grep -a` finds only `client.ts:124` and its own test; **positive control on the same sweep**, `listMarketplaceSkills` is called from `service.ts:100`. `PluginsPage.tsx:163-169` still builds `queryContext` from `kind`/`query`/`sort`/`workspaceId`/`sessionId` only. **The `tenants`/`professions` pipe DOWN already exists end to end** (`useMarketplaceItems.ts:88-89` → safe request → RPC → `service.ts:302-303` → `buildListUrl`); what is missing is the vocabulary coming UP and a control to bind it to. **Not reachable from zone W1** — needs, minimum: a `SKILL_FACETS` entry in `protocol/channels.ts`; a safe facets result + guard in `protocol/capabilities.ts`, which must ALSO gain `tags` (`isSafeMarketplaceListRequest`'s `hasOnlyKeys` allowlist has no `tags`, so a tag selection is refused at the boundary today); a facets method on `MarketplaceService` (the handler's `Pick<>` has none) plus `tags` forwarding at `service.ts:302`; the preload bridge; `apps/electron/src/shared/types.ts`; `useMarketplaceItems.ts` (another zone's file per C3/F2); and both locale files for the control's labels **Still 🔄 on measurement**: `grep -a` for facets across the renderer returns ZERO hits — the corrected parameters reach no UI, so the fix is unobservable. **Wave 4 / zone Y2: a filter now reaches the UI and the corrected parameter is observable — but its vocabulary is NOT the facets endpoint's, and that deviation is measured, not assumed.** `/v1/skills/facets` is still unreachable from any file this zone owns (no channel in `protocol/channels.ts`, no safe result/guard in `protocol/capabilities.ts`, no method on `MarketplaceService`, no handler in `rpc/marketplace.ts`, no preload bridge, nothing in `apps/electron/src/shared/types.ts` — `grep -an "acets"` across all six returns **0**; **positive control on the same sweep**, `marketplace/client.ts:124` and `marketplace/types.ts:66` do carry it). So the control is populated from the tenants the LOADED ROWS carry (`SafeMarketplaceCatalogItem.tenant`, already on the wire), which makes the named hazard structurally unreachable instead of merely unlikely: every option provably has ≥1 row. **The hazard, reproduced live 2026-08-01 (anonymous, one rig, one minute):** `/v1/skills` `x-total-count` = **6084**, `?tenant=escape-tools` = **139** (exactly the facet's own count), `?tenant=ads` = **23**, `?tenant=not-a-real-tenant` = **0** — an out-of-vocabulary value empties the list rather than failing. **The cost of the row-derived vocabulary, measured on the same run and pinned in the fixture:** page one carries **52 of the 457** tenants, covering **1316 of 6084** skills; the union grows with every page fetched. Landed in zone: `useMarketplaceItems.ts` gains `catalogTenants`/`mergeTenantVocabulary`/`browseTenantFilter`/`useTenantVocabulary` + `marketplaceListRequest` (the request builder no caller can bypass), `loadedTenants` on the hook result read off the UNCOLLAPSED rows (the F2 collapse keys on name+description and would drop a bucket's second tenant); `PluginsPage.tsx` gains the `TenantMenu` in `headerActions`, the `tenants` spread on the query context, the render-cap reset, and `browseEmptyMessageKey` so a filtered-to-empty list reads "No marketplace items found" instead of the pre-search prompt. The union only GROWS within one browsed set on purpose — recomputing it from the filtered rows collapses it to the single selected value and strands the user inside their own filter. No new i18n keys: `plugins.filterTenant` and `common.clear` already exist in both locales with zero consumers. **Production call sites** (`grep -ran`): `marketplaceListRequest` `useMarketplaceItems.ts:89`, `catalogTenants` `:102`, `useTenantVocabulary` `PluginsPage.tsx:190`, `browseTenantFilter` `PluginsPage.tsx:1012`, `browseEmptyMessageKey` `PluginsPage.tsx:1052`. **Gate** `plugins-tenant-filter.test.ts` **10 pass / 0 fail**. **Five mutations, one at a time, each red on the arm it owns:** drop the `tenants` spread from the query context → **9/1**; drop the `browseTenantFilter` guard at the selection site → **9/1**; recompute the vocabulary from the current rows instead of the union → **9/1** (the strand-the-user arm); render a hardcoded option list → **9/1**; revert `emptyMessage` to the query-only decision → **9/1**, while the `browseEmptyMessageKey` arms stay green, which is the helper↔wiring split both exist for. Restored byte-identical each time (sha256 `ec98917b…` / `99f59ba1…`). `typecheck:electron` rc 0, eslint clean, `git diff --check` clean; hook suites 9 + 6 and `plugins-registry-upgrade` 4 still green. **OWED:** the FULL vocabulary (457 tenants, 1354 tags, 10 professions) and the `tags` parameter — `isSafeMarketplaceListRequest`'s allowlist has no `tags` — need the six out-of-zone files above; and the browse design's playground entry has no tenant-filter knob (`playground` is out of zone), so the control is unswept. Base for this evidence: `3dc99a46`. **VERIFIED LIVE 2026-08-01**: `useTenantVocabulary` reaches production at `PluginsPage.tsx:190`, and `marketplace-tenant-filter` rendered in the running app. The earlier zero-hit grep was measured before the wiring landed. |
| F2 | The browse list stops showing 1926 duplicate rows | ① | ✅ | `475c937d` `92420a17` `4c3a04f1` | | **Landed, but NOT by the route this row directed — the directed route was measured and refused.** Premise re-reproduced: `grep -ran listSkillsRegistryCatalog` = `client.ts:150` + `client.test.ts:171,196`, zero production callers; **positive control on the same sweep**, `listMarketplaceSkills` is called at `service.ts:100`. Plan counts reproduce live 2026-07-31: `/v2/registry/catalog` = **3914 groups over 5341 entries = 1427 duplicates**; `/v1/skills` = **6084 rows** (all 61 pages). **Why browse is not routed through the grouped catalog — five measurements, all on the live market:** (1) the registry is a SMALLER population — 920 v1 skillIds are in no group, **537 distinct names have no v2 entry at all, 142 of them with a live source**, so the directed route DROPS them from browse; (2) the installed join breaks for the **654** multi-variant groups whenever the user installed a non-default variant, because the row id becomes `defaultVariantId`; (3) a v2 entry carries no `artifactDelivery`, so every skill row's `sourceConfidence` falls from `primary` and its `detailUrl` (the SKILL.md link) is lost — `delivery` is only `{installable, installCommand}` on all 5341 entries; (4) paging is cursor-only (no offset), and `createService()` builds a NEW `MarketplaceService` per RPC call (`rpc/marketplace.ts:94`), so page→cursor needs process-level state; (5) the lossless alternative — keep the v1 rows and collapse them by group — needs the WHOLE catalog: **40 cursor pages, 8.2 s measured**, which cannot ride a browse fetch. **Shipped instead, in `useMarketplaceItems.ts`:** the browse list collapses rows that are indistinguishable on screen — same `marketplaceId`+`listKind`+`name`+`version`+non-empty `description`. **Measured on the live 6084: 6084 → 4711, 1373 rows removed in 654 buckets**, and joined against the market's OWN clustering it disagrees on **9 buckets (19 rows)**, where name and description are byte-identical anyway. A row with no description never collapses (280 live rows; name alone disagrees on 271 buckets). `tenant`/`repo` are deliberately out of the key because the registry's own clusters span tenants (one `acceptance-criteria` cluster covers `system-analysis`, `coin`, `sme-ios`); keying on tenant collapses 383 instead of 1373. The installed inventory joins the UNCOLLAPSED catalog and an installed duplicate takes over its bucket in place, so collapsing can never hide the copy the user has. **Production call sites** (`grep -ran`): `marketplaceBrowseRows` `useMarketplaceItems.ts:100`, `collapseDuplicateCatalogRows` `useMarketplaceItems.ts:170`, hook consumed at `PluginsPage.tsx:171`. **Gate** `marketplace-duplicate-rows.test.ts` 6 pass / 0 fail (+ the 9 pre-existing hook tests green). **Three mutations, one at a time, each restored byte-identical (sha256 `b0bdcd70…`):** drop the collapse from `marketplaceBrowseRows` → **5/1**, the browse arm reporting the pre-fix `['listing-first','listing-second']`; make the hook return `items: catalogItems` → **5/1**, the wiring arm (the behavioural arms cannot see this one, which is why both exist); drop the installed-in-place rule → **4/2**. `typecheck:electron` rc 0, `bun run lint` 0 errors. **OWED / planner's decision:** `listSkillsRegistryCatalog` STILL has no production caller. It is now a choice with a number on it — delete it, or spend the 8.2 s full-catalog walk (cached process-wide) to collapse by the registry's clusters instead of by appearance, which would recover the 19 disagreeing rows and cost the first browse 8 s **One of its two shas is dead**: `listSkillsRegistryCatalog` (`475c937d`) still has ZERO production callers; the live half is `92420a17` via `useMarketplaceItems.ts:100/:170`. Open UX seam: `PluginsPage.tsx:717` shows `marketplace.total` (6084) while the list renders `visible` (4711). **Wave 4 / zone Y2 — that seam is CLOSED.** The header number is now derived from the section's OWN `cards` array inside `browseCatalogSection` (exported from `PluginsPage.tsx`), so the count and the rows cannot disagree again by construction — the old shape passed the count in beside the cards, which is exactly how a 6084 came to sit over 4711 collapsed rows capped to `PAGE_RENDER_STEP`. The catalog total is not dropped, it is LABELLED: the section note carries `plugins.showingCount` ("Showing {{visible}} of {{total}}" / "Показано {{visible}} из {{total}}") whenever more rows matched than are on screen, so the row's "show both with a label" option lands too. **No new i18n keys** — that key already existed in both locales with zero consumers (`grep -ran` across the renderer = 0 before this commit). Only the built-in section is routed through it; the registry section's `note` is its load-error line and is left alone. **Gate** `plugins-browse-count.test.ts` **6 pass / 0 fail**. **Three mutations, one at a time:** revert the branch to `...(debouncedQuery ? { count: marketplace.total } : {})` → **4/2**, both wiring arms (the helper arms stay green — that is the split they exist for); make the helper count `input.total` instead of its cards → **3/3**; drop the labelled note → **4/2**. Restored byte-identical (sha256 `0c32efab…`). `typecheck:electron` rc 0, eslint clean, `git diff --check` clean; the F1, duplicate-rows and registry-upgrade suites stay 10 / 6 / 4 green. **OWED:** the note is a new element the browse playground entry does not carry a knob for (`playground` is out of zone), and the live look of "Showing N of M" under the section header is unswept. |
| F3 | We record which snapshot we installed | ① | ✅ | `a9dcb236` `c59aacec` | | wired: `fetchMarketSkillFilesArtifact` stamps snapshotId/artifactId/contentDigest/sourceCommit/lifecycle onto the origin, and a market that cannot name a release installs anyway with `plugin.install.skill_snapshot_unrecorded`. **Gate runs through `PluginManagementServiceV2`** — `installFromSource` has **zero** production callers (control: the only `stageInstall`/`normalizeStagedInstall` callers ARE the management service), so a record assertion driven from it proves nothing |
| F4 | A skill installs in one archive request, not N+1 | ① | ✅ | `2e3e5016` `a44ff778` | | wired: `fetchMarketSkillFilesArtifact` now takes `/v1/skills/{id}/archive.zip` in ONE request whenever the release names an archive, with the digest checked against the SEPARATELY fetched release (`artifact.archive.digest`), so the bytes are pinned to the artifact the market named rather than merely un-corrupted in transit. **Production call sites for `downloadMarketplaceSkillArchive`: 1** (`install-service.ts:1134`, was 0 — definition + its own client test only), reached from the Install button via `MarketplaceServiceV2.install` → `PluginManagementServiceV2.install` → `stageInstall`. **W8's blocker is resolved IN ZONE rather than by splitting `mcpb-archive.ts`, and the split would have been the wrong shape:** MCPB's root-`manifest.json` precondition is exactly what refuses a skill archive, and its executable-entry rule is defined against an MCPB manifest's declared binary server, which a skill has none of — so an exported `extractZipArchive` would have carried a policy this caller must not take. The new `extractSkillArchiveZip` writes no new path-safety logic: containment is this file's OWN `isUnsafeArchivePath` + `assertPathInside` (the two the per-file path already calls on every entry) and the caps are the same `MAX_SKILL_SNAPSHOT_*` trio, so the two market transports cannot drift apart. The per-file listing stays as the fallback for a market that names no archive; a fetched archive that fails digest or extraction is a REFUSAL (`plugin.install.skill_archive_fetch_failed`), never a quiet downgrade back to N+1. Re-probed anonymously 2026-07-31 on `skl_v1_225cfdef…`: release `artifact.archive.digest`, the `archive.zip` ETag and sha256 of the 84899-byte body are the same hex, and that tree is 6 files — 7 requests become 1. **Gate** `bun test packages/shared/src/plugins/__tests__/install-service.test.ts` → **47 pass / 0 fail**, with a positive control in the same test that the SAME stub still produces the 1+N shape when the release names no archive. **Mutations:** revert the switch → **45 pass / 2 fail**; drop `expectedDigest` → **46 / 1**; drop the executable bit → **46 / 1**. **Measured caveat, so nobody over-reads the traversal case:** under `decodeStrings: true` yauzl's own `validateFileName` refuses `..`, backslash and absolute names before an entry is emitted, so no test can single out our two containment calls — they are the seatbelt for that option changing, and the traversal case pins only that such an archive installs NOTHING and does not reopen the per-file path |
| F5 | Installs are reported to the marketplace | ① | ✅ | `18e0335b` `ddbb1eca` | | issued once per staged market-skill install from `fetchMarketSkillFilesArtifact` — **not** from `installFromSource`, which has zero production callers. Token source = the read-only cached gateway JWT, injectable. **The bearer is scoped to the verified Skills Market API base**: `filesUrl` is a catalog field, so an unscoped bearer would be credential exfiltration by catalog entry; another host gets no report at all. **OWED (planner):** live confirmation that the marketplace ACCEPTS this JWT — the only proof is a POST that counts a real install on the owner's account |
| A7 | A built-in dp-backed MCP set, switchable per server | ①③ | ✅ | `8b17a79c` `4d019cf4` `74df120a` `36374915` `e0a917dd` `3f87cfa4` `0fc79b84` `2eaa3cdc` + this commit | | **Wave 6 — the built-in is a real CAPABILITY (option A), so the row, the detail page, the tools panel and the metadata table all work with NO new screen.** Owner decision 2026-08-01: "нам нужно общее поведение для всего, единственное отличие это то что они встроены" — common behaviour for everything, built-in being the only difference. **READ side is now common, WRITE side is UNCHANGED**: `builtinDpMcpCapabilityRecords` (`storage-runtime.ts`) projects all 28 definitions into `nativeInventory.records` as `kind:'mcp'`, `scope:{kind:'builtin'}`, key `builtin:mcp:<name>`, `sourceEnabled` read from the SAME `builtinDpMcpServers.enabled` preference the pools fold with — enablement still persists only through `setBuiltinDpMcpServerEnabled`, never `set-capability-enabled`. **Hazard 2 (double materialization) was real and is closed in `resolver.ts`:** a builtin-scope mcp record's binding now withholds `resource`/`sourceName`, so `materializeSnapshotMcpServers` cannot produce an entry under the built-in's wire name — if it did, `mergeBuiltinDpMcpServers` would treat the name as configured and stand the real built-in down, i.e. "enabled in the list, never starts". `wireName` is kept, and that is what makes `SessionManager.resolveMcpBindingFromContext` find the built-in's live tools for the detail page. **Hazard 1 (toggle loses its route) closed in `capability-catalog.ts`:** the catalog row derives `builtinDpName` from `logicalName`, and the RPC copy is no longer dropped by the name dedupe — it is JOINED onto the catalog row, contributing the live switch state and the dp-availability sentence. That join is also the answer to **hazard 3 (no invalidation)**: `builtinDpMcp:setEnabled` still publishes no capability change (`handlers/rpc/settings.ts:513`, OUT OF ZONE, reported not crossed), so a catalog-only `enabled` would leave the switch stuck until restart. A merely-off built-in no longer copies `source-disabled` into `unavailableReason`, which would have painted the "needs dp" warning badge on every off server. **Hazard 4 (managed policy) — DECIDED, not accidental: built-ins are NOT filtered by `isManagedMcpServerAllowed`.** Two measured reasons: the fold that actually starts them applies no managed policy, so filtering the mirror would hide a row while its server still starts; and `domain/capabilities/context.ts` never sets `provider`, so that filter is inert for every catalog/detail read anyway — it would change neither what runs nor what is shown. `mcpServerIdentity` carries the logical `dp ai mcp <sub>` argv so the FOLD has a real identity to match on when subjecting the set to `managed-mcp` is done there (OWED, out of zone). Pinned by a new arm in `storage-runtime-policy.test.ts`. **Gates:** `builtin-dp-mcp-capability-projection.test.ts` **6 pass / 0 fail** (catalog fields incl. `origin:'builtin'`/`mcpTransport:'stdio'`, preference-driven state with a positive control, runtime view in/out, **an enabled built-in still reaching `materializeRuntimePoolServers`' `mergedMcpServers` as `dp ai mcp jira`** with a materializer whose `readText` THROWS, and the FILE contract `{"enabled":{"dpJira":true}}` asserted on `config.json` in a child process with its own `NESSY_CONFIG_DIR`); `builtin-mcp-binding.test.ts` **2 pass / 0 fail** (the binding asymmetry with a discovered-record positive control); `McpServersPanel.test.tsx` **27 pass / 0 fail** (5 new arms: the join, the catalog-half-alone switch, the configured-name collision, no false "needs dp" badge with a positive control, and row NAVIGATION `onOpenServer('builtin:mcp:dpJira')` beside the unchanged plugin toggle). Blast radius: `server-core/bootstrap` **71/0**, `shared/src/{capabilities,mcp}` **549/0**, `renderer/lib` **154/0**, `server-core/handlers` + `shared/config` **802 pass / 2 fail** — both the register's line-119 `isUsableGitBashPath`/`resizeImageForAPI` module-load errors. `typecheck` for server-core and apps/electron clean; `lint` 0 errors and none in the changed files; `lint:i18n:parity` 2118 keys and `lint:i18n:sorted` clean (no new keys). **Mutation A (the row's) — route a built-in toggle through the plugin capability mutation:** **24 pass / 3 fail**, the new navigation+write arm red plus the two pre-existing "switch only on plugin rows" arms. The FILE assertion cannot go red from a renderer mutation — it is driven by `setBuiltinDpMcpServerEnabled` directly — so the routing half is what this probe pins, and it is reported as such rather than claimed. **Mutation B — drop the `builtinDpName` derivation on the catalog row:** **180 pass / 1 fail**, only the catalog-half-alone arm; with both halves present the RPC overlay masks it, which is exactly why that arm exists. **Mutation C (mine, for hazard 2) — restore `resource`/`sourceName` on the built-in binding:** **5 pass / 3 fail**, the binding arm, the runtime-view arm and the POOL arm all red. All three files restored byte-identical (`resolver.ts` `cbb481ad…`, `capability-catalog.ts` `41019e26…`, `McpServersPanel.tsx` `41e1e9a2…`). **PRODUCTION CALL SITES:** `builtinDpMcpCapabilityRecords` 1 (`storage-runtime.ts`'s `nativeInventory`), and the projection reaches the user through `toUserCatalog` → `buildMcpServerRows` → `McpServersPanel` and through `buildDetail`. **CONSEQUENCE TO KNOW:** the 28 built-ins now also appear in the unfiltered "All sources" list (`isSafeSourceRow` admits `kind:'mcp'`); the nav counters are unaffected because the MCP figure already went through `buildMcpServerRows`. **NOT reproducible live:** `electron:dev` runs the main process from built bundles, so the projection is absent from the running app until a rebuild. **BRANCH-LEVEL FINDING, not mine and not registered:** `bun run typecheck:shared` is RED on HEAD (`9d52ec7b`) with 3 errors in `i18n/__tests__/mcp-servers-panel-keys.test.ts` (`Bun.Glob.scanSync().flatMap`, implicit any, `i18n.t(unknown)`); the suite itself passes 4/0. **Prior wave note follows.** **Wave 5 — the switch is REACHABLE, which is the half the row was missing.** Measured on `36374915` before this wave: `grep -arn "builtinDpMcpServers\|BuiltinDpMcp\|builtin-dp" apps/electron/src --include=*.tsx --include=*.ts \| grep -v __tests__` → **0 hits**, and the same sweep over `packages/server-core/src/handlers` → **0 hits**. No renderer, no RPC; `config.json` had to be hand-edited. **What landed:** `config/builtin-dp-mcp-preferences.ts` (`3f87cfa4`) — `setBuiltinDpMcpServerEnabled` writes ONE server through `loadStoredConfig` → `saveConfig`, never a direct file write, and `readBuiltinDpMcpSettingsView` assembles the payload a card renders; channels `builtinDpMcp:list` / `builtinDpMcp:setEnabled` + their handlers (`0fc79b84`), **REMOTE_ELIGIBLE** for the `GET_MCP_CHANNEL_PUSH` reason and NOT the retention one — the preference is read only by the two pools, which run on whichever server owns the workspace, and `dp` has to be on THAT machine; and the `BuiltinDpMcpServers` card in App settings (this commit). **The write refuses a wire name no definition claims while the read still IGNORES one — deliberately opposite**, so a map written by a newer release survives a downgrade and cannot conjure a server. **Gates:** RPC surface **9 pass / 0 fail**, card **5 pass / 0 fail**, i18n key resolution **5 pass / 0 fail**; blast radius `packages/shared/src/{config,mcp,protocol,i18n}` **970 pass / 0 fail**, `server-core/handlers/rpc` + `electron/src/{transport,shared}` + renderer settings **235 pass / 2 fail**, both failures the register's line-119 `isUsableGitBashPath`/`resizeImageForAPI` module-load errors. `typecheck:shared`, `server-core` and `apps/electron` all clean; `lint:i18n:parity` 2121 keys, `lint:i18n:sorted` clean. **Mutation A (the row's) — drop the write path** (`saveConfig` never called): **6 pass / 3 fail**, the persist arm and both stored-map arms red. **Mutation B — write the WHOLE set on every toggle** (freezing today's defaults into every user's config): the SAME **6 pass / 3 fail**, because the persist arm asserts the stored map by exact equality; B is therefore not an independent probe, and the forward-compat half is pinned by the exact-equality assertion rather than by its own mutation. Both restored byte-identical (`builtin-dp-mcp-preferences.ts` `ba0ada9b…`). **CORRECTION, and the branch was red for it:** `config/__tests__/builtin-dp-mcp-settings.test.ts` still asserted the six default-ON servers `74df120a` wrote out by hand; `36374915` flipped every definition to `false` and never came back — **4 pass / 3 fail on HEAD**, not in the known-failing register, fixed in `e0a917dd` by deriving the expectations from `BUILTIN_DP_MCP_SERVERS`. Two of its arms lost real coverage to that flip and now say so in place: with no default-ON server left, neither "an explicit `false` overrides a default `true`" nor "fell back to defaults" as distinct from "turned everything off" is observable through `materializeBuiltinDpMcpServers`. **DEVIATION:** the setter does NOT sit beside `getBuiltinDpMcpServerPreferences` in `config/storage.ts`, where every neighbouring setting keeps its get/set pair — the zone forbade editing that file. Moving it there is a safe follow-up and would close the getter/setter split this repo's own trap list warns about. **Prior wave note follows.** **Wave 4 — the per-server preference is PERSISTED; the row stays 🔄 because nothing threads it into a pool.** New user layer `builtinDpMcpServers.enabled` in `config.json` (`config/builtin-dp-mcp-settings.ts`, plus the key in the strict `StoredConfigTopLevelSchema` — a top-level key missing there takes `loadStoredConfig()` down, which is how the `workflow` key once bricked startup), read by `getBuiltinDpMcpServerPreferences()` (`config/storage.ts`) into `MaterializeBuiltinDpMcpOptions.enabled`. **Forward-compatible in both directions, deliberately: the layer validates no server NAME** — an unknown name is inert (a map written by a newer release must not fail the load), and a server ABSENT from the map takes its own `defaultEnabled` (a built-in added later must reach its measured default for users whose stored map predates it; "absent = off" would hide every future built-in, invisibly, because a map that was complete when written still looks complete). Only literal JSON booleans are honoured, so `"false"` lands on the definition default rather than on string truthiness. `materializeBuiltinDpMcpServers` deliberately does NOT read config itself — a settings read hidden in a default would make every caller's behaviour depend on the host's config file, which is wave 3's own trap. **Gate 7 pass / 0 fail** (`config/__tests__/builtin-dp-mcp-settings.test.ts`); the load-bearing arm writes a real `config.json` into a temp `NESSY_CONFIG_DIR` and runs `loadStoredConfig` → `getBuiltinDpMcpServerPreferences` → `materializeBuiltinDpMcpServers` in a child process with `resolveDpPath` INJECTED — **no arm needs `dp` installed, none executes it, none reads the developer's real config**. **Mutation A (the row's) — ignore the stored map** (`getBuiltinDpMcpServerPreferences` returns `{}`): **6 pass / 1 fail**, the disable arm red, `dpSage` back in the set. **Mutation B — "absent means off"** (`isBuiltinDpMcpServerEnabled` → `override ?? false`): **4 pass / 3 fail**, all three disk arms red — that is the forward-compat half, which mutation A alone does not pin. Both restored byte-identical (`storage.ts` `8e223e66…`, `builtin-dp-servers.ts` `eb973fc9…`). Neighbours re-run green: `mcp/__tests__/builtin-dp-servers.test.ts` 9/0, `validators-stored-config` 17/0, `user-settings-strict-report` 5/0, `source-startup-settings` 2/0; `typecheck:shared` clean. **PRODUCTION CALL SITES FOR THE NEW SYMBOLS: ZERO, and the row is half-done because of it** — `grep -ran` finds `getBuiltinDpMcpServerPreferences` only in its own definition, its doc and its test, and `MaterializePoolServersOptions.builtinDpMcpServers` is still passed by NO production caller, so the set stays inert in the product. **OWED, other zones, one line each:** `builtinDpMcpServers: { enabled: getBuiltinDpMcpServerPreferences() }` at `agent/base-agent.ts:1723` and `server-core/src/mcp/workspace-mcp-pool-registry.ts:497`, plus a Settings UI writer — nothing writes the key today, so a user must hand-edit `config.json`. **OWNER CALL, deliberately not taken here: whether the default flips back to ON now that a stop switch exists.** The switch answers the "no way to turn them off" half of `7e99c772`; it does NOT answer the 13 exact-map assertions across 4 files that default-ON broke on a machine with `dp` while CI went green. Base for every count above: `3dc99a46`. \| **Wave 3 — the wiring landed, and it carries a debt: THREE out-of-zone test expectations are OWED and the branch is red on a machine that HAS `dp` until they land** (each is one line — add `builtinDpMcpServers: false` to that call's options): `plugins/__tests__/mcpb.test.ts:181`, `plugins/__tests__/unified-adapter-conformance.test.ts:397`, `server-core/src/bootstrap/__tests__/capability-path-install-probe.test.ts:171`. All three assert an exact `mergedMcpServers` map, so all three were ALREADY host-dependent in the other direction and would have flipped the day a runner got `dp`. **Wiring:** the fold is `runtime-pool-servers.ts:136` (`foldBuiltinDpMcpServers`), inside `materializeRuntimePoolServers` — the file's own header: "There is NO second materialization path" — so **both** production call sites carry the set with no further code: `agent/base-agent.ts:1723` (session pool) and `server-core/src/mcp/workspace-mcp-pool-registry.ts:497` (browse pool). Production call sites for the new symbols: `materializeBuiltinDpMcpServers` 1, `mergeBuiltinDpMcpServers` 1, both at `runtime-pool-servers.ts` — **was 0 before this commit, which is why the row was 🔄.** Default is ON (`builtinDpMcpServers?: false \ **Demoted: default flipped to OPT-IN (`7e99c772`).** Default-ON broke 13 exact-map assertions across 4 files on any machine with `dp`, while CI (no `dp`) stayed green on the same commit. And nothing reads a user preference into the per-server switch, so ON meant 6 stdio subprocesses per pool per workspace with no way to stop them. Wiring preferences is the remaining half. \| MaterializeBuiltinDpMcpOptions`); per-user persistence of the `enabled` record is OWED and is not in this zone. **Collision rule, decided deliberately:** the configured map is the LEFT argument, so a built-in yields TWICE over — to a taken wire name, and (new here) to a taken `dp ai mcp <sub>` under any other name, which is the installed-`nessy-default-extension` case; without the second rule a user with the extension gets two subprocesses and two names for one tool set. Matched on the argv TAIL, never `command === 'dp'`, because a plugin-declared dp server arrives with its command rewritten to the supervised host executable. **Gate 64 pass / 0 fail** (`mcp/__tests__/runtime-pool-servers.test.ts`, five new arms driven through `materializeRuntimePoolServers`, never through the merge helper); whole `packages/shared/src/mcp` directory **279 pass / 0 fail**; `typecheck:shared` clean; no dp executed, no network. **Mutation A — drop the fold call:** gate **59 pass / 5 fail** while `builtin-dp-servers.test.ts` stays **9 pass / 0 fail** — the exact split that hid wave 2's hole, now visible from the gate side. **Mutation B — swap arguments 2 and 3 of the merge (the precedence half):** gate **62 pass / 2 fail**, both precedence arms red, helper suite again **9 pass / 0 fail**. Restored byte-identical (sha `ae5c53a7…`). Prior wave-2 note follows. **owner-directed.** Module landed (`mcp/builtin-dp-servers.ts`); **the wiring is OWED and no user behaviour has changed yet.** **Registration point established before editing, and the file NAMED "built-in sources" is the wrong one:** `sources/builtin-sources.ts::getBuiltinSources` reaches only `loadAllSources`, whose production callers are tool-DISPLAY metadata (`SessionManager.ts:17779`, `:17930`) and `plugins/mcp-credentials.ts:126` — registering there is the F1–F5 dead-half trap. MCP servers reach the model through exactly ONE path: `materializeRuntimePoolServers` (`mcp/runtime-pool-servers.ts`, its own header: "There is NO second materialization path") fed from the capability view; **positive control on the same sweep** — `SourceServerBuilder.buildAll` has one production caller, `runtime-pool-servers.ts:182`, and `runtime-pool-servers.ts` imports nothing from `sources/storage.ts` but `parseGuideMarkdown`. That file is Z7's, so the one-line fold is owed, not crossed. **Set built from OUTPUT, not prose:** `dp ai mcp --help` on Spirit CLI **13.32.4** lists **31** subcommands, not the 20 the brief recorded — so `t-tracker`→`tracker` and `dpMail`→`mail` DO exist, correcting the brief; `whiteboard`/`meetings` still do not and are excluded with their reason rather than guessed at a `dp ai mcp remote --url` we cannot read; `context7` is excluded as an npx server. 12 servers, wire names taken from the four live `nessy-default-extension` catalogue rows; default-ON = the six all four rows declare (measured rule, not taste). **Gate 8 pass / 0 fail**, no dp executed and no network. **Mutation (the plan's):** drop the per-server `continue` → **6 pass / 2 fail**, the disabled-server arm red. **Second mutation:** fall through to a bare `dp` instead of the unavailable branch → **7 pass / 1 fail**, the dp-absent arm red. Restored byte-identical (sha `6fac47c7…`). Collision decision lives in the module: `mergeBuiltinDpMcpServers` YIELDS to a user's own `dpGitlab`/`dpJira`/`dpMR` with a diagnostic, never `mergePinnedMcpServers`' throw — an unasked-for set must not brick a workspace to announce itself |
| E5a | Reload keeps the live connections of unchanged servers | ④ | ✅ | `a8b4eaec` `f6f77ee3` | E1 | **owner-directed. Browse-reload half landed; the send path is another zone's.** **Premise reproduced, and it is HALF true — the churn is the API half only.** Measured against the REAL `McpClientPool`: MCP servers are content-keyed (`mcpConnectionKey` = sha256 over the config), so an unchanged one already keeps its client — a resync with an equivalent set reconnects **0 of 2**. An API source reaches the pool as a live in-process `McpServer` and `apiConnectionKey` keys on the INSTANCE through a WeakMap, so a resync with three equivalent api sources reconnected **3 of 3** (connect counts 1→2 on every slug); **positive control on the same probe** — handing the pool the SAME three instances reconnects **0 of 3**, so the pool's diff was already right and the identity was what churned. **Answer to "reuse `apiConnectionKey` or need a content key": reuse it.** A content key inside the pool is not expressible — an in-process server has no serializable config, its identity IS the object — and keeping the live client necessarily means keeping that object anyway. The content key belongs where the content is, so `WorkspaceMcpPoolRegistry.retainUnchangedBrowseApiServers` digests the loaded source record (config/guide/folderPath/workspace ids) **plus the value-only credential binding** `{id, expectedRevision}` (never the secret) and hands the pool back the instance it is already holding when the digest matches. **Browse only, deliberately:** a session leaser's api instance carries closures over that turn's materializer, so retaining one across turns would pin an expired lease (E2's mechanism) — those keep being minted fresh. **Gate** `workspace-mcp-pool-browse-reload.test.ts` drives the REAL registry over the REAL pool (a subclass that only records `connectInProcess`/`sync` and delegates — no diff rule reproduced), a REAL materializer and REAL api sources on disk, and asserts **client identity**, not counts: after a no-change reload the pool is handed the same instance objects (`instanceAt(1,x) === instanceAt(0,x)`) and connect counts stay 1; after one source's config moves, only that one reconnects and the neighbour's instance is still the first sync's. 2 pass / 0 fail, 17 assertions. **Three mutations, one at a time, each restored byte-identical (sha256 `fd2e42b6…`):** sync the raw materialized map (today's behaviour) → **0 pass / 2 fail**, both arms; retain unconditionally, ignoring the digest → **0 pass / 2 fail** with a CHANGED source no longer reconnecting; drop the credential binding from the digest → **1 pass / 1 fail**, exactly the rotation arm while the config arm stays green, which is the split that arm exists for. Regression: registry suite 28 pass, descriptor-store 2 pass, `tsc --noEmit` (server-core) exit 0. **OWED, out of zone X4:** the SEND path still mints a fresh instance per api source per turn — `base-agent.ts:1761` and `SessionManager.ts:8235` call `pool.sync` with a freshly materialized map, and the safe fix there is E2's rebinding, not instance retention. E5b not attempted (separate row) **Wave 4 / zone Y4 — the SEND half now lands, and the “OWED, out of zone X4” clause above is CLOSED.** Base: `3dc99a46`. **Premise reproduced at the production seam before fixing** (mutation A below IS that reproduction, since it restores the pre-fix line): two sends with an unchanged api source reconnected **2 of 2**, and a credentialed one **1 of 1**. **Correction to X4's hand-off — the safe fix here is NOT E2's rebinding ‘instead of’ instance retention; it is instance retention WITH a rebinding, and either alone is wrong.** Retention alone regresses: the in-process api server’s only closures are its credential providers, and they captured the BUILDING turn’s materializer, so a retained instance would resolve against a released lease and every api tool call on the next turn would fail `capability-snapshot-revoked` (E2’s mechanism, reached this time because the session leaser IS the one that makes tool calls). Rebinding alone does not stop the churn. So `RuntimeApiServerRetention` (`mcp/runtime-pool-servers.ts:168`) owns BOTH: the per-slug digest, and the materializer the providers resolve through — which is re-pointed at the live turn on every materialization, i.e. exactly where an UNRETAINED instance’s provider already was. Nothing widens a lease: a retained instance whose CURRENT turn is released still fails `revoked`. **The pool’s keying is untouched**, as wave 3 directed — `apiConnectionKey` still keys on the instance, and the digest (loaded source record + the value-only credential binding `{id, expectedRevision}`, never the secret) lives where the content is. It is a THIRD store, not the browse one: browse retains per workspace pool entry, this one per session agent, because the retained instance belongs to that agent’s leaser — cleared in `BaseAgent.destroy`. **Production call sites** (`grep -ran`, no `head`): `RuntimeApiServerRetention` constructed at `base-agent.ts:325`, supplied at `base-agent.ts:1738`, consumed at `runtime-pool-servers.ts:376`; `retainUnchanged` `:416`; `bindMaterializer` `:377`; `currentMaterializer` `:379`. Zero test-only symbols. **Gate** `mcp/__tests__/runtime-pool-servers-api-retention.test.ts` — REAL `BaseAgent.setSourceServers`, REAL `materializeRuntimePoolServers`, REAL `SourceServerBuilder`, REAL `CapabilitySnapshotMaterializer` over its own releasable lease, REAL `McpClientPool` (a subclass that only RECORDS `connectInProcess`/`sync` and delegates). Asserts CONNECT COUNTS and INSTANCE IDENTITY, never list length. **3 pass / 0 fail, 23 assertions.** Host-independent: temp dirs, in-process transports, stubbed `fetch`, no dp, no network. **Three mutations, one at a time, each restored byte-identical (sha256 `df0622e8…`):** (A) rebuild unconditionally — the plan’s mutation — → **0 pass / 3 fail**, every arm reporting the pre-fix 2-of-2 reconnect; (B) drop the rebinding and capture `runtime.materializer` directly → **2 pass / 1 fail**, ONLY the credential arm, with both identity arms still green — the split that arm exists for, and the reason a pure identity gate is not enough; (C) drop the credential binding from the digest → **2 pass / 1 fail**, ONLY the rotation arm while the config arm stays green. **Positive control inside arm 3:** after asserting the retained instance answers a real pooled `callTool` with turn 2’s bearer, the CURRENT turn’s lease is released and the SAME instance then fails `capability-snapshot-revoked` — so the pass is a live pass, not a rig that cannot see a dead lease. Regression, each run alone under the wave lock: `runtime-pool-servers.test.ts` 64 pass / 0 fail, `plugin-server-auth-visibility.test.ts` 9 pass / 0 fail, `base-agent.test.ts` 99 pass / 0 fail; `bun run typecheck:shared` exit 0; eslint on the three files, 0 problems. **OWED, out of zone:** `SessionManager.preflightDpAuth` (`SessionManager.ts:8235`) still syncs a FRESH api map under the same session leaser before `setSourceServers` runs, so a turn that carries a ready dp server still churns its api sources once — measured as no worse than before (2 connects per such turn, same as today), but it is the last send-path site and it needs the registry lease to carry the agent’s store. E5b untouched (separate row, needs a desktop design). |
| E5b | An explicit, refusable apply step | ④ | ⬜ | | E5a | needs a desktop design — Claude's is a CLI verb |
| C4 | A refused host is refused at browse, not after install | ② | ✅ | `4bbe028d` | | **owner-directed**, step 1 of 3 toward Claude. Landed in `source-resolver.ts` only — the allowlist is NOT widened (that is C4b/C4c). Every classification branch now funnels through one `resolveClassifiedSource`, which refuses a git-repository-shaped source on an unsupported host as `plugin.source.unsupported_repository_host` (error) naming the host AND the supported set. **Premise reproduced on HEAD before the fix, and it had two different shapes:** the catalogue shape (`{"source":"url","url":"https://bitbucket.org/…​.git"}`) parsed to a clean `kind:'repository'` with **zero diagnostics** and was refused only at staging by `plugin.install.repository_url_unsupported`, a sentence about which URLs the repository route accepts that never names the offending host; the **ad-hoc "install by URL" shape** (the same string typed by a user) classified as `kind:'url'` → `archive-url` and spent a **real HTTP request** — measured `requested: ["https://bitbucket.org/team/plugin.git"]`, failing `plugin.install.artifact_download_failed`. Deliberately narrow: an UNPARSEABLE repository URL is never refused (`git@github.com:o/r.git`, and the `git-subdir` `owner/repo` shorthand behind 190 of the 2307 community entries), and a plain `url` is only judged when its path ends `.git`, so archive/manifest URLs on any host stay a supported route. **Gate** drives the REAL catalogue parser (`parseExternalPluginCatalog('claude', …)`) and the REAL `PluginInstallService` with a counting `fetchImpl`: bitbucket refused with the host named and `requested === []` on both shapes; **positive control on the same counter**, the github entry does reach it (`requested.length > 0`, all `github.com`) so the empty arrays are refusals, not a broken seam; github/gitlab/`git-subdir` unaffected. **Mutation** — force `resolveClassifiedSource`'s refusal to `undefined` (restore the late refusal) → **7 pass / 2 fail**, the bitbucket arm reporting the exact pre-fix `plugin.install.repository_url_unsupported`; restored byte-identical (sha256 `39df85b2…`) → **9 pass / 0 fail**. **Folded in, same file:** `parseHostedRepositoryUrl` honoured only `marker === 'tree'` but did not REFUSE another marker, so a `/-/blob/<ref>/<path>` file URL silently resolved to the whole repository at its default branch with ref and path both dropped (measured on HEAD, and the identical defect was on the GitHub `/blob/` branch — both fixed; `install-source.ts:parseGitLabRepositorySource` already had the correct handling, and the file-shaped route lives at `install-service.ts:isGitLabBlobUrl`). Its own mutation → that arm red (**8 pass / 1 fail**). The orphaned `isGitLabBlobUrl` copy in `source-resolver.ts` is DELETED — **positive control for the absence**, `grep -an` shows the identically-named `install-service.ts:2609` copy is live at `:604`, which is AGENTS.md's "identically-named symbol in a sibling subsystem" trap, so the subsystem is named. Regression sweep, all green and each run alone: registry-catalog-fetcher 24, install-service 45, install-source 12, normalizers 21, registry-source 39, public-api 2, management-service-v2 47, store 10, external-catalog-adapters 23, registry-catalog-items 6, repository-install 10, marketplace service-v2 11, proposal-registry 8. `bun run typecheck:shared` exit 0 |
| C4b | The archive route generalises to GitLab-compatible hosts | ② | ⬜ | | C4, A3 | step 2 — covers self-hosted without a git dependency |
| C4c | A `git clone` fallback for the rest | ② | ⬜ | | C4b | step 3 — only if a real host needs it |
| C6 | `bin/` executables reach the Bash PATH | ② | ✅ | `6d910885` `c7e1e1d8` | | **Wave 4 / zone Y3 — THE PATH HALF IS BUILT, on both shipping backends, and it is gated by a real bare-command resolution rather than by a string.** `plugins-reference.md` § File locations, `bin/`: "Executables added to the Bash tool PATH. Files here are invokable as bare commands in any Bash tool call while the plugin is enabled." **Premise reproduced at base `3dc99a46`**, `grep -a` over the HEAD blobs: `appendPluginBinPath\|PLUGIN_BIN\|binBundleRoots` = **0** in `claude-agent.ts`, **0** in `pi-agent.ts`, `bin` = **0** in `data-paths.ts`; **positive control on the same sweep**, HEAD *does* compose a PATH — `claude-agent.ts:714` `PATH: ${shimDirectory}${delimiter}${process.env.PATH}` — so the sweep can see a PATH composition and there simply was none for `bin/`. **X5's stated seam was confirmed wrong and not used:** `pluginRuntimeEnv*` is per-BUNDLE and a PATH is ONE value shared by every enabled bundle, so two bundles each returning a `PATH` key would collide (and would throw `plugin-skill-runtime-environment-ambiguous:PATH` at `resolveSelectedPluginSkillRuntimePolicy`'s own `mergeEnvironment`). Composed at the two child-environment merge sites instead: `claude-agent.ts:689/736` (the SDK subprocess env the Bash tool inherits) and `pi-agent.ts:5187` (`handleProcessStartRequest`, for EVERY supervised child start — "any Bash tool call" is the documented scope, not just a plugin-owned command). **APPENDED, never prepended**, so a plugin shipping a file called `git`/`node`/`sh` can never shadow the system binary; the node shim stays first. **The grant is deliberate and is stated as such:** an enabled plugin can make one of its own files resolvable as a bare command in every Bash call of the session — Claude accepts that trade and we are matching it. **Enablement, not selection, is the key:** the roots come from the turn's runnable capability view (`skills`/`mcpServers`/`hooks`/`commands`/`promptCommands`/`outputStyles`/`lspServers` — the seven `AgentRuntimeView` arrays that carry `pluginRuntime`), and `toAgentRuntime` admits an entry only when `isRunnable` holds, so a switched-off plugin contributes no root. A bundle with no `bin/` on disk contributes no PATH entry. **Production call sites** (`grep -ran`): `appendPluginBinPath` **3** (`claude-agent.ts:691`, `:736`, `pi-agent.ts:5187`), `enabledPluginBundleRoots` **2** (`claude-agent.ts:689`, `pi-agent.ts:5189`); `pluginBinDirectories`/`PLUGIN_BIN_DIR_NAME` are module-private, reached only through `appendPluginBinPath` — deliberately NOT exported so no half sits there with no reader. **Gate** `agent/__tests__/plugin-bin-path.test.ts` **6 pass / 0 fail**: the host PATH is INJECTED (`process.env.PATH` replaced by one temp dir, restored in `finally`) so no arm's verdict can depend on this machine, and the load-bearing arms EXECUTE a bare name (`execFileSync('alpha-tool', {env:{PATH}})` → `alpha`) rather than asserting a string. Arms: enabled resolves · same-named system binary still wins (`probe` → `system`, both directories hold one) · disabled resolves nothing, with a **positive control** on the same rig that `probe` still runs on the injected PATH so the ENOENT is the absent `bin/` and not a broken fixture · shim-first/bundles-last, deduped across two surfaces naming one root and a second bundle joined · Pi child start carries `{PATH}` alone for an ordinary Bash call and `{plugin env + PATH}` for a plugin-owned one. **Mutation A — drop the PATH entry at BOTH wiring sites (this is exactly HEAD's behaviour):** **1 pass / 5 fail**, and the ONE arm that stays green is the disabled arm, which is the correct split. **Mutation B — prepend instead of append (the shadowing half):** **1 pass / 5 fail**, the shadow arm reporting `probe` → `plugin`. **Mutation C — restore the blanket `{externalKind:'bin', defaultPath:'bin'}` row** (re-run on THIS base, not X5's): `claude-bin-surface.test.ts` **0 pass / 4 fail**, including the no-longer-partial arm. All four files restored byte-identical by sha256 after every mutation (`claude-agent.ts` `a7575ff8…`, `pi-agent.ts` `48d02ebd…`, `data-paths.ts` `e2ecbfd8…`, adapter `git diff` empty). Regression, each alone: `data-paths` 12, `claude-bin-surface` 4, `claude-agent-plugin-runtime` 3, `pi-agent-bash-output` 3, all 0 fail; `bun run typecheck:all` rc 0; `bun run lint` 0 errors. **OWED, and the first one is a CONSEQUENCE of this commit, not a leftover:** (1) `addClaudeBinSurfaceDeferral`'s `plugin.deferred.claude_bin` row and its `plugin.format.claude_bin_path_unsupported` warning now say the opposite of the truth — an unreferenced `bin/` file DOES resolve as a bare command on Claude and Pi, and the deferral still makes the report `partial`, which `management-service-v2.ts:553` answers by purging every durable activation grant. The fix is to stop deferring when the bundle contributes any `pluginRuntime`-carrying capability, and it **cannot land in zone Y3**: it flips `format-adapters.test.ts:2837`'s `expect(kinds).toEqual(['bin','settings','theme'])` to `['settings','theme']` for the `claude-default-path-peripherals` bundle (its `output-style` capability qualifies), and that file is not this zone's. One assertion, one comment. (2) The **Codex backend composes no such PATH** — `codex-agent.ts:359-401` has the identical `resolveSelectedPluginSkillRuntimePolicy` and was not crossed; `NESSY_FEATURE_CODEX_RUNTIME` is off by default, so nothing ships broken, but the two backends now disagree. (3) A bundle whose ONLY surface is `bin/` contributes no capability-view entry and therefore no PATH entry; nothing invokes such a bundle today, but the documented rule is unconditional on enablement. (4) LIVE acceptance (G1) — `openai/plugins` → `superhuman/bin/cli.js` installed on a packaged build and invoked bare from a Bash call — is the planner's. **Prior wave-3 record follows.** **discovery half landed; THE PATH HALF IS NOT BUILT and is not reachable from zone X5.** Premise reproduced on HEAD with the real adapter (`superhuman`-shaped bundle: `bin/cli.js` + a skill): `deferred:[{bin,plugin.deferred.claude_bin}]`, **`diagnostics: []`** — and on a SUCCESSFUL install neither surfaces, because `PluginsPage.tsx` stores `deferred`/`diagnosticCodes` only when blocked-or-confirm and renders them only through `blockedInstallMessage`; `usePluginInstallChecklist.tsx` reads neither (`grep -an` — same OWED as D3). **The blanket `{externalKind:'bin', defaultPath:'bin'}` row was wrong in a way that cost users, not just silent:** it fired on directory EXISTENCE, so a bundle whose `bin/` holds the MCP server it already executes (`"command":"./bin/local-mcp"` → `${NESSY_PLUGIN_ROOT}/bin/local-mcp`) reported `partial` — and `management-service-v2.ts:553` answers `partial` on repair/update by `policyStore.purgePlugin` of every durable activation grant, `requiresConfirmation:true`, and `rpc/plugins.ts:141`'s `remove` runtime effect. The repo's own conformance fixture is that bundle. Now: `addClaudeBinSurfaceDeferral` runs AFTER the capabilities (whether a `bin/` entry is unrunnable depends on them), defers only files no mcp/hook/lsp/command-monitor command executes by path, and NAMES them in a `warning` (`plugin.format.claude_bin_path_unsupported`) so a skill shelling out to its own tool gets an explanation instead of `command not found`. **Gate** `claude-bin-surface.test.ts` 4 pass / 0 fail: named-warning · covered-file-not-deferred (`state:'supported'`, with the imported `${NESSY_PLUGIN_ROOT}/bin/local-mcp` as the positive control) · both name boundaries · empty `bin/`. **Five mutations, each red on the arm it owns:** drop the coverage filter → 2/2 (+ the conformance test); drop the warning → 2/2; drop the nothing-unrunnable guard → 2/2; drop the trailing `(?![\w.-])` (so `bin/local-mcp` reads as covered by `bin/local-mcp2`) → 3/1; drop the leading `(?:^\|[^\w.-])` (so `scripts/mybin/tool` covers `bin/tool`) → 3/1. Restored byte-identical (sha256 `a04ab36e…`); format-adapters 144 pass, unified-adapter-conformance 14, management-service-v2 47, `typecheck:shared` exit 0. **OWED, and the plan's stated seam is WRONG:** the PATH cannot be composed in `data-paths.ts`. The Bash tool's env for the Claude backend is assembled in `claude-agent.ts:673-717` (`resolveSelectedPluginSkillRuntimePolicy` → `getDefaultOptions({...pluginRuntime.environment})`), which is where `PATH: ${shimDirectory}${delimiter}${process.env.PATH}` is already built; a `PATH` key returned by `pluginRuntimeEnvForProfile` would hit that function's own `mergeEnvironment` conflict check and throw `plugin-skill-runtime-environment-ambiguous:PATH`, and two enabled plugins would throw against each other. PATH must be composed ONCE at the merge site, per backend — `claude-agent.ts`, `codex-agent.ts:381-401`, and the Pi path — none of them zone X5. Also owed: the end-to-end consequence gate through `PluginManagementServiceV2.repair` (`management-service-v2.test.ts`, another zone) and a renderer that shows a successful install's warnings. **test case found**: `openai/plugins` → `superhuman/bin/cli.js` |
| A8 | A disagreeing `repository.url` warns, never refuses | ① | ✅ | `2eaf5e86` | | **RE-SHAPED — the original would have refused 68 of 88.** Landed as `plugin.install.derived_repository_mismatch`, severity `warning`, scoped to derived coordinates so the 12 published rows are untouched. Table-driven over empty / absent / agreeing (`git+…​.git`) / disagreeing / published-command; **every arm installs**. Mutation = restore the hard gate → the empty arm (the 68) goes red. **Premise re-probe blocked:** artifactory answers 404 anonymously — control on the same rig and minute, skills-market 200 and gitlab API a typed 404, so egress is not the reason; the counts are wave 1's recorded measurement |
| A9 | Integrity is verified from the published digest | ① | ✅ | `43e9a40a` | | unknown algorithm now refuses instead of passing; `dist.shasum` read as a transport check only |
| G1 | Eight plugins install and work, driven as a user | ①②③ | ✅ | | wave 1 | **live acceptance — PASSED, on the owner's real rig, every action a real click.** **Enable-and-USE half, the one link nothing had ever tested:** `dpFs` switched on in the panel → `config.json` gains `builtinDpMcpServers.enabled.dpFs = true` → `[McpClientPool] Connected source dpFs: 14 tools` (14 is exactly what `dp ai mcp fs` advertises, confirmed by handshaking the subprocess directly) → **offered to the model**: `Registered 65 proxy tools`, splitting 51 `mcp__session__` + 14 `mcp__dpFs__` → **called**: `tool_start: mcp__dpFs__list_directory`, `toolStatus=completed`, and the 2767-byte result spot-checked BYTE-EXACT against the filesystem, so it is the server's output and not the model narrating. **Negative control with its own positive control:** switched off, the same session-creation step logs no `dpFs` anywhere, while the neighbouring plugin-auth diagnostics are unchanged — materialization ran and simply produced no dpFs; `dpFs` appears zero times in the log before the flip. Off-switch round-trips to the found state. **No app restart was needed** — `base-agent.ts:1744` re-reads the preference per materialization, and that comment holds live. **Uninstall proved too:** all five test installs removed through the same UI, leaving only the owner's pre-existing `figma`. **Residue, deliberately not hand-repaired:** the `enabled` map now carries an explicit `"dpFs": false` key that was absent before (effective state identical to the default; only the UI writes that file), and two probe sessions remain rather than delete anything. **Install half: DONE, every action a real click.** Five source shapes, one from each registry, each verified against `~/.nessy-agent/plugins/installed.json` rather than against the screen: `agent-sdk-dev` 1.0.0 (claude-code, 13 rows — the `owner/repo` shorthand registry that could not even *load* before `9791e1f7`), `42crunch-api-security-testing` 1.15.0 (claude-plugins-official, 276), `0x-ai` 1.0.0 (claude-plugins-community, 2307), `linear` 0.0.3 (openai/plugins — a Codex bundle, 15 s), and a `t-skills` skill from the internal Skills Market (3 s). `agent-sdk-dev`'s detail page went from "This plugin ships no components" to a real inventory (command `new-sdk-app`, two agents), so the install populated, it did not merely record. **MCP panel checked in the same pass:** 30 rows / 30 switches, **zero duplicate names** (H2 holds live), each row name + `MCP` badge + description, `Connect` on the two plugin servers — the single shape the owner asked for. **Two live findings that were measurement artefacts, not defects, and cost real turns:** on a window that is not being DRAWN `innerText` degrades to `""` while `textContent` is correct — two probes reported "no such element" for elements that were there; and a click on a browse card's Install button reaches the CARD, navigating to the detail page instead of installing, so the reliable path is card → detail → Install. **Still open:** the enable-and-USE half — an enabled built-in dp server's tool actually reaching the model in a turn. The switch's persistence is already proven (`config.json` carries `builtinDpMcpServers.enabled` with real per-server entries); what is unproven is the last link. |
| E0 | An un-authorized plugin slot stops bricking every send | ③ | ✅ | `1a125e90` | | the release blocker; cause was NOT the one first stated |
| E3 | A not-ready credential is its own error code | ③④ | ✅ | `c0c5e0de` | | `credential-not-ready` split from `revoked` |
| A2 | An npm version resolves through a ladder | ① | ✅ | `1582c9a9` | | **12 → 116 of 118 installable, measured live** |
| A1 | ~~A derived coordinate stops pinning a version~~ | ① | ❌ | | | withdrawn — with A2's ladder the pin resolves and is the only base signal |
| H1 | A 401 or 403 marks a server as needing sign-in | ②③ | ✅ | `parity(mcp-auth-failure)` | | **owner-directed; closed 2026-08-08.** The defect was exactly as filed — `sourceNeedsAuthentication` tested only `!isAuthenticated`, so a revoked token left the slot FULL and the server read as broken. The pool now keeps its own auth verdict (`authFailedConnections`, separate from `failedConnections` so connection health and user-facing auth state stay distinct), marked at reconcile connect, on-demand connect, EVERY tool-call 401/403 — not just `headersHelper`-backed ones — and both reconnect-failure branches; surfaced through `authNeededSlugs()` into the pending-auth summary as `credential-expired`. **A hole the brief's own verified facts missed, found by the executor:** `NessyMcpClient.connect` re-wrapped a failing `tools/list` health check in a plain `new Error(...)`, so a server that accepted `initialize` and then 401'd on the health check arrived with NO status at all — unclassifiable, i.e. "broken". Fixed by preserving `{ cause }` and walking the cause chain. **The mirror-image defect is pinned, not assumed:** a 500, a 404, a transport error and an app-level tool error must NOT become a sign-in prompt. Orchestrator's control widened the classifier to accept any status and failed exactly the three tests named for that distinction. **Recovery proven on three independent paths** — re-auth mints a new connection identity, a successful connect clears it, a successful tool call clears it. `authType: 'none'` + 401 deliberately stays a BROKEN server: there is no credential slot to write, so a Connect button could not help. `mcp.md:803`'s helper retry-once is byte-identical (its pre-`authNeededSlugs` assertions passed on pre-change code). No new i18n — the existing `pendingAuth.sourceCredentialExpired` says precisely what a 401 means. **Recorded scope boundary:** a PLUGIN-owned server whose filled token is revoked gets an informational row without a one-click Connect, because `externalAuthRequirements` only names plugin servers with an EMPTY slot, so a wire name cannot be mapped back to `{pluginKey, serverName}`. Connector-origin Sources are fully handled. |
| H2 | A user server and a built-in of the same name are ONE row | ①③ | ✅ | `3bdb4a2b` | | **Closed, and the surviving half is narrower than the row said.** The planner re-measured before fixing and the row's premise was already half-wrong: `buildMcpServerRows` (`capability-catalog.ts`) DID drop a colliding built-in, and its doc comment said "wire name" — but the code keyed on `row.name`, which is `displayName ?? logicalName`. So the two-row case needed the user to have RENAMED their own server; identical names were already one row. Since the built-in set ships in this release, that is a defect the feature introduces, not one it inherits, so it ships fixed: the drop now reads `logicalName` off the capabilities plus the component name off plugin MCP components, and the display-name map keeps only its other job — joining the two halves of the same built-in. **Deliberately NOT covered:** the runtime also stands a built-in down when another server already serves the same `dp ai mcp <sub>` under a different wire name (`mergeBuiltinDpMcpServers`' second rule, tested at `builtin-dp-servers.test.ts:258`). The renderer cannot evaluate it — `SafeCapabilitySummary` carries `logicalName` but no command or args — so it needs a new wire field. Consequence if hit: a switch that flips, persists and starts nothing, silently. Mutation-verified: removing the wire-name drop fails 1 of 15; the other two arms survive because the older display-name path still catches those shapes. Original finding: **found by an executor, measured**: `dpJira` in a user `.mcp.json` yields two rows where the runtime starts one |
| H3 | A plugin that relies on DEFAULT component directories still says what it ships | ①③ | ⬜ | | H2 | **Owner decision 2026-08-01: deferred past the 1.17.0 release, deliberately, and the reason is a quota not a difficulty.** What shipped: a listing that declares components shows them, and the detail page probes the plugin's own manifest at its pinned sha for BOTH formats. What that cannot reach: **an absent manifest field is not an absent component** — `plugins-reference.md` § Plugin manifest schema, "The manifest is optional. If omitted, Claude Code auto-discovers components in default locations", and `plugins/build/plugins.md` § Path rules says the same for Codex hooks. Measured on 59 official Claude manifests fetched at their pinned shas: **25 declare a component field, 34 declare none** and rely on the default directories — `figma`, the plugin the owner reported this on, is in the second group, so its page honestly says the listing does not say. Closing it needs a directory listing (`api.github.com/…/git/trees/<sha>`), which is a NEW host on a 60-request/hour unauthenticated quota. Recommended shape when it lands: detail page only, cached per plugin+sha, and a rate-limited response degrades to the same honest copy rather than to a false emptiness. |

**6 open · 5 half-done · 34 done · 1 withdrawn** across 46 rows. No rows are parked — every owner decision was answered.
owner decision was answered.

**🔄 means the fix landed and its gate did not.** Wave 1's reviewer found that
seven rows carried a ✅ over a half-run gate; they are demoted here rather than
absorbed. Two patterns caused all seven: a client-side half landed with no
production caller (F1–F5, C3), and a gate whose named check is blind to the
regression it exists to catch (A0, B1). Wave 1b closes both.

---

## Decisions that are the owner's, not an executor's

**These are parked (⏸) until answered. Do not let an executor pick.**

### D1 — do we introduce an apply boundary? (blocks E5)

Claude separates mutation from materialization with an explicit, refusable,
user-initiated step:

> In that case `/reload-plugins` shows a warning and does not apply the reload;
> pass `--force` to apply anyway.

and reload is a **diff over a live set**:

> When you reload, Claude Code keeps the live connections of plugin servers
> whose configuration is unchanged […]. Before v2.1.210, Claude Code
> disconnected plugin-provided MCP servers that the new SDK server list didn't
> name.

We have no such boundary: install/uninstall bumps the capability generation
immediately, and there is no state in which a session keeps working on the
previous generation.

**What is NOT blocked on this decision:** E1–E4. Our MCP connections are already
long-lived (`McpClientPool` is torn down only in
`WorkspaceMcpPoolRegistry.dispose` — "browse keep-alive"). Per-server isolation,
preserve-on-failure and retry-once all fit inside the current per-turn lease
without changing it. Every measured failure closes without D1.

**Recommendation: defer.** Taking it adds a user step that does not exist today,
on a surface (a desktop app) where Claude publishes no contract — their model is
a CLI plus a `/plugin` panel. Revisit once Waves A–E are green and we can see
what is left.

### D2 — is the git host allowlist a supply-chain boundary? (blocks C4)

Claude's `url` source is typed "Git URL source" with no host constraint, and the
docs name Bitbucket and AWS CodeCommit explicitly. We accept only `github.com`
and `*gitlab*`; anything else parses cleanly and then fails at staging with a
message blaming the URL rather than our allowlist.

Either (a) extend to a generic archive route plus a `git clone --depth 1`
fallback, or (b) keep the allowlist and move the refusal **forward** so a
catalog entry is refused at browse with an honest reason.

*The skeptic corrected the original finding here: the claim that this is "the
shape an internal T-Bank marketplace would take" is false — our internal
marketplace is on `gitlab.tcsbank.ru`, which is allowed. So this is about
third-party Claude marketplaces, not about us. That lowers its priority but
does not answer it.*

**Recommendation: (b).** Cheaper, honest, and reversible. Only take (a) if we
want to consume Bitbucket-hosted Claude marketplaces, which nothing today asks
for.

### D3 — do we put a plugin's `bin/` on PATH? (blocks C6)

Documented upstream: executables in `bin/` are "invokable as bare commands in
any Bash tool call while the plugin is enabled". We defer them. Putting a
bundle's directory on the Bash PATH is a real privilege surface.

**Recommendation: do not implement; upgrade the silent deferral to an
install-time warning.** A plugin whose skill calls its own tool then fails with
an explanation instead of `command not found`. *Note the skeptic's correction:
the claim that today's deferral is "visible in the install summary" is FALSE —
`plugins.compatDeferredEntry` has exactly one consumer, reached only from the
two blocked-install paths. So the warning is the load-bearing part.*

### D4 — do we keep deriving npm coordinates from a naming convention?

A2/A1 rest on `deriveNessyExtensionCoordinates`, which reproduces all 12
published install commands. It works. But it couples the desktop client to the
marketplace's **private publishing convention**: if that convention changes, we
resolve to a stale or foreign package rather than failing.

Two mitigations, both cheap: require the resolved package's
`versions[*].repository.url` to match the entry's `path` before accepting, and
file an upstream ask on `nessy-marketplace-api` to publish `install` for all 118
rows (12 of 118 do today — the other 106 have `npmPublishError`, which the API
knows and does not expose).

**Recommendation: do both.** The upstream ask is the real fix; the confirmation
step is the seatbelt until it lands.

### D5 — `verifyIntegrity` fails open on unrecognized algorithms

`sha1-`/`md5-`/malformed returns undefined, which the caller reads as
"verified"; `dist.shasum` is never read and `artifact.integrity` is never
populated on a first install. Today the check is the registry's
self-attestation and detects transport corruption only. Not a Claude contract —
ours to decide — but **the risk scales with A1/A2**, which make ~106 more rows
installable.

---

## Wave A — the internal marketplace can actually install

### A0 — a derived source has a label instead of a raw i18n key

**A regression introduced by `8bbb1f73`, and the cheapest user-visible fix in
the whole plan.** `plugins.sourceConfidence.coordinates-derived` exists in
**neither** locale. Verified: `grep -a` over both files returns nothing;
**positive control on the same sweep**, `command-derived` is present at
`en.json:1170` and `ru.json:1186`. It is rendered unguarded at
`PluginsPage.tsx:1562` and `:1567`:

```ts
t(`plugins.sourceConfidence.${item.install.sourceConfidence}`)
```

So **88–106 of the 118 extension rows now display the literal string
`plugins.sourceConfidence.coordinates-derived`** where the source label belongs.

The label must be honest about derivation — it is the only signal in the browse
list that the coordinate was derived rather than published. The install-time
info diagnostic already exists (`marketplace.install.derived_source`,
`install-source.ts:42-49`); do not re-add it.

**Files: the two locale files only.**

**Gate:** `bun run lint:i18n:parity && bun run lint:i18n:sorted`, plus a renderer
assertion that the key does not resolve to itself. **Mutation:** delete the
`ru.json` line only → parity fails; delete both → the assertion fails.

### A1 — withdrawn ❌

**This row said to drop the `version` spread at `normalizers.ts:399-403`. That
would now be a regression, and the reason is worth keeping.**

The row was written against a base where `selectNpmVersion` did an exact-key
lookup, so a pinned `1.0.9` failed for every CI-stamped package. `1582c9a9`
changed the premise: with the ladder in place the pin **resolves**, and it is
the only base-version signal we have. Dropping it falls through to
`dist-tags.latest`, which is not guaranteed to be the same base release — that
trades a resolvable pin for a silent cross-version install.

**Do not delete the spread.** Measured on HEAD: 20 of 20 sampled derived rows
resolve; the confidence histogram is `{command-derived: 12, coordinates-derived:
88}` over the 100-row page (the server caps `pageSize` at 100).

### A2 — an npm version resolves through a ladder ✅ `1582c9a9`

`selectNpmVersionName` (`install-service.ts:1186-1243`) is a three-rule ladder:
exact → `widened-within-base` → refuse, with the matched rule recorded.

The prefix test is against the **request itself** (`${requestedVersion}-`)
rather than "any prerelease sharing the base", and that is load-bearing in both
directions: it admits a stamp on a *prerelease* base (`1.0.3-beta.0-source.…` —
three live catalog rows publish only that way) while still refusing
`1.0.3-beta.1` for a requested `1.0.3-beta.0`, which is a different build rather
than a stamp of this one. Base equality is checked as a belt on top of the
prefix.

Rule 3 (`dist-tags.latest`) is deliberately unreachable for a pinned request and
left explicit rather than deleted — the comment in the source says why.

**Measured over all 118 live rows, the two commits together: 12 installable
before → 56 after the derivation alone → 116 after both.** The two that remain
were never published to Artifactory at all. This is the number that answers
"does the internal marketplace work".

The provenance seam this row surfaced is carried by **E6**.

### A3 — a GitLab archive comes from the documented API route

`repositoryArchiveUrl` (`install-service.ts:1222`) builds the Rails **web** UI
route `${repositoryUrl}/-/archive/<ref>/<repo>-<ref>.tar.gz`. Probed anonymously
today against `gitlab.tcsbank.ru`: **302, `content-type: text/html`** — a
redirect to sign-in, which the tar extractor then fails on opaquely.

Rewrite for `spec.host === 'gitlab'` to
`https://<host>/api/v4/projects/<encodeURIComponent(projectPath)>/repository/archive.tar.gz?sha=<ref>`,
plus `&path=<subdirectory>` when known — mirroring what `gitLabApiRawUrl`
already does for files. With `path=`, the extract-then-copy branch becomes a
strip-prefix on a subdirectory-sized archive instead of a whole-repo download.
Add an `isHtmlResponse` guard to `downloadArtifact` that returns a typed
diagnostic instead of letting a sign-in page reach the extractor.

*This path is not on the marketplace's critical route today (all 118 rows
normalize to npm), but it backs bring-your-own registries —
`registry-catalog-fetcher.ts:180-184` reuses `stageInstall`.*

**Gate:** the existing repository-install test gains a negative arm — the web
`/-/archive/` route returns 302/HTML and the install fails with a typed
diagnostic naming HTML, not an opaque tar error — and the positive arm pins the
API route with `path=`. **Mutation:** revert to the web route → the negative arm
goes red. *The current fixture asserts only that the auth header was attached,
never that GitLab accepts the route; it cannot fail the way production does.*

### A4 — a marketplace refresh stops blinding the catalog while it runs

`upgrade()` (`registry-source.ts:723-729`) persists a new `lastUpgradedAt`
**before** awaiting `refreshCache`. `lastUpgradedAt` is folded into
`registrySignature` (`:855`), and `findCatalogItem` (`:425-436`) requires an
exact signature match and deliberately never fetches. From the instant Upgrade
is clicked until the clone lands, every lookup returns undefined.

**Measured on the owner's rig: a 34.97 s window** (`lastUpgradedAt`
12:37:45.327Z, refreshed catalog `updatedAt` 12:38:20.296Z) with the failing
calls at 12:38:05 and 12:38:07 inside it. This is why "refresh the marketplace
and try again" did not help: for the duration of its own clone, **upgrade is the
cause**. Claude's contract is the opposite:

> To refresh a marketplace without losing installed plugins, use
> `claude plugin marketplace update` instead.

Stamp `lastUpgradedAt` only after a successful fetch, or key the cache by
fetched content and swap atomically. **Do not** fix this by loosening
`findCatalogItem` to ignore the signature or fall back to a stale disk entry —
the signature is what stops an install resolving against a catalog the registry
has moved past.

**Do not** route `upgrade()` through the 2-slot `withFetchSlot` semaphore "for
consistency": it can deadlock behind a queued browse fetch for the same
registry. Note `withTimeout` does not cancel the clone — there is no abort
signal in the staging layer — so a timed-out upgrade leaks a running clone.

**Gate:** call `upgrade()` without awaiting and assert `findCatalogItem` stays
defined for the whole clone, and `listItems` never reports zero rows. The
existing scratchpad probes (`d2-probe.test.ts`, `d2-probe2.test.ts`) already
drive the real `PluginRegistrySource`. **Mutation:** restore the early stamp →
red.

### A5 — a failed fetch is not cached as if it were a catalog

Upstream records our exact bug as one they already fixed:

> If a refresh request fails, Claude Code keeps the server's previously
> discovered tools, prompts, and resources until a later refresh succeeds.
> Before v2.1.214, a transient error during the refresh replaced the server's
> tools, prompts, and resources with an empty list.

**We wrote that sentence down on 2026-07-26** in
`docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md:334`, with the
note "a naive refresh implementation reproduces a bug Claude has already fixed"
— and filed it against R5, the **MCP tool** refresh row. We applied it there and
shipped the identical bug in the **marketplace registry** refresh. Same
contract, sibling subsystem. That is the shape this whole plan exists to catch.

`fetchRegistryEntry` (`:642`) never rejects: a timeout or failed clone returns
`{signature: NEW, items: []}`. `commitEntry` (`:480`) caches it with
`persistable:false`; the on-disk catalog still carries the OLD signature;
`loadDiskEntry` (`:531`) demands an exact match; `lastUpgradedAt` only moves
forward. The good 180-row file becomes permanently unreadable and is never
deleted. `listItems` (`:379`) refetches only on a signature mismatch, so a
cached **failure** is indistinguishable from a cached success and no further
fetch is issued for the process lifetime.

Make a failure a distinct cache state from an empty success: keep serving the
previous entry, record the load error separately, allow a bounded retry.
**Explicitly do NOT delete the orphaned disk file on a signature mismatch** — it
is the only surviving copy of the catalog after a failed upgrade, and deleting
it turns a recoverable state into an unrecoverable one.

Serving a stale catalog after a failure is a deliberate trade: an entry deleted
upstream would still install. Bound it — retry plus visible staleness — rather
than making stale-forever the default.

**Gate:** with a warm 180-row catalog, force one clone failure, then assert
`findCatalogItem` still resolves, `listItems` still returns 180 rows with a
load-error note, and a subsequent `listItems` issues a fresh attempt. Simulate a
process restart and confirm recovery. **Mutation:** restore failure-caching →
red.

### A6 — an upgrade reports what actually happened

`upgrade()` returns `{upgraded:true}` even when the clone threw. The RPC drops
`RegistryUpgradeResult.reason`, so `not-found` and `not-git` both cross as a
bare false. The renderer toasts success without reading `upgraded` at all.

Propagate the reason; report failure honestly; stop advising "refresh the
marketplace and try again" in an error whose named remedy is currently also its
cause. Split `fetch_pending` from `fetch_failed`/`fetch_timeout`.

Separately: catalog ids are `<registryId>:<pluginName>` and that shape is
invisible at every surface a human or script reads. Surface the real listing id
in the error. **The failing `listingId` from the owner's D2 reproduction is
still unrecovered** — capture it on CDP rather than guessing; the blind window
and a wrong bare-name id both produce the message verbatim and cannot be told
apart from the artifacts on disk.

**Gate:** `upgrade()` returns `upgraded:false` with a reason on a throwing
clone; the reason survives the RPC; the renderer shows distinct pending vs
failed states. **Mutation:** drop the reason → red.

---

## Wave B — installed becomes usable

This wave is the owner's original complaint: *"я поставил фигму но не понятно
как авторизоваться"*. Every row below is a step between Install and the model
being able to call the tool.

### B1 — the pending-auth notice refetches when capabilities change

**Blocker, and it survives the F1 fix.** F1 restored the summary's *server-side*
correctness; this is the renderer never asking again.

`PendingAuthNotice.tsx:151-163` — `refresh` is a `useCallback` with deps
`[workspaceId]`; `:165-170` — `useEffect(..., [refresh, activeSessionId])`.
Mounted at `MainContentPanel.tsx:253` with `workspaceId` + `activeSessionId`,
neither of which changes on install. The app's only capability-change
subscriber, `AppShell.tsx:1417-1429`, calls
`refreshCapabilityDependentsOnChange` with exactly three targets — the
pending-auth summary is not one of them.

So: the user installs Figma, and the Connect button that would authorize it does
not appear until they switch sessions or restart. Nothing tells them that.

Subscribe to `window.electronAPI.capabilities.onChanged` and call `refresh()` —
the same one-liner `ProjectHooksPanel.tsx:185` already uses — or add the summary
to `refreshCapabilityDependentsOnChange`'s target set so one subscription serves
both.

**Gate:** LIVE on CDP 9224 — install a plugin with an OAuth server in an open
session and the Connect affordance appears without switching sessions or
restarting. **Mutation:** drop the subscription → the live check fails and the
unit asserting a refetch-on-change goes red.

### B2 — every surface that says "Sign in required" can sign you in

`McpServersPanel.tsx:58-60` emits the badge "Sign in required"; the row's only
interactive elements are detail-open and the enable `Switch`. No OAuth action
anywhere in the file. `PluginInfoPage.tsx:258-269` renders "OAuth" plus the
server name as static `<p>` text.

A user who looks in the obvious places — the MCP list, the plugin's own page —
finds a badge naming the problem and nothing that solves it. The one surface
that *can* act is transient and appears only at session start.

Add Connect/Reconnect when `row.originKind === 'plugin' && row.credentialState
!== 'ready'` and the capability declares `authType: 'oauth'`, calling
`performOAuth({workspaceId, sourceSlug: serverName, pluginServer: {pluginKey,
serverName}})` — the exact call `PendingAuthNotice.tsx:196-202` already makes.
`SafeCapabilitySummary` needs to carry the auth kind alongside `credentialState`
so the panel can tell oauth (actionable) from bearer/environment (configure on
the plugin page).

**Gate:** LIVE — sign in to Figma from the MCP panel, no session restart.
**Mutation:** remove the auth-kind field → the panel cannot distinguish and the
unit goes red.

### B3 — the model-facing plugin sign-in tool is wired

`resolvePluginMcpServer` is declared optional (`context.ts:491`) and consumed at
`source-oauth.ts:51-55`, which returns a flat refusal when absent. Exhaustive
`grep -ran` returns exactly three production lines: the declaration and those
two uses. **Nothing populates it.** So the model is told the trigger exists and,
if it calls it, is refused.

Populate from the session's `capabilityTurnRuntime.view.mcpServers` (each entry
already carries `endpointAuth: {authType, pluginKey, serverName}` —
`resolver.ts:1039-1053`). The RPC behind it (`oauth.ts:318-390`
`startPluginServerFlow`) is complete and policy-checked.

**Corrected — there is ONE arm to build, not two.** `createClaudeContext`
(`claude-context.ts`) is the factory for BOTH the Claude SDK adapter
(`session-scoped-tools.ts:229`) and Pi (`pi-agent.ts:5292`), so a single seam
there covers both backends. The absence claim carries a positive control: the
same `grep -ran` finds the sibling optional field `pluginManagement` assigned at
`session-self-management-bindings.ts:131`, so the zero-assignment result for
`resolvePluginMcpServer` was a real absence and not a grep artifact.

**The Codex arm is deliberately absent and must not be built.**
`source_oauth_trigger` is in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`
(`tool-defs.ts:1102`); the only production spawner of session-mcp-server is
`CodexAgent.buildSessionMcpSpec`, which passes `--external-standalone-only`
unconditionally (`codex-agent.ts:158`); under that flag `getSessionToolDefs`
drops every host-callback tool (`tool-defs.ts:1241-1245`) and
`session-mcp-server/src/index.ts:452` refuses the name before any handler runs.
**Measured on HEAD, same run:** 37 tools without the flag, **18** with it,
`source_oauth_trigger` absent from the 18 — positive control on the same list,
`config_validate` present. Populating `createCodexContext` would be dead code,
and the subprocess cannot reach the host capability view in any case.

**Shape as built:** one optional callback on the session-scoped callback
registry (`resolvePluginMcpServerFn`), one NON-memoized lazy getter in
`createClaudeContext` that re-reads the registry on every access (the context is
built once per session and cached, so a memoized answer would outlive the turn
it came from), and one producer per backend reading
`capabilityTurnRuntime.view.mcpServers[].endpointAuth` — carried only by a
non-stdio plugin server with a declared `authType` (`resolver.ts`), and only for
runnable capabilities (`views.ts:isRunnable`), so presence there IS the "is it
enabled" test the contract asks for.

**Gate:** `__tests__/plugin-mcp-auth-trigger.test.ts` drives
`PiAgent.routeToolCall('mcp__session__source_oauth_trigger', …)` — the real Pi
tool router, the canonical registry handler and the context `pi-agent.ts` itself
builds, with no injected seam: an enabled `oauth` plugin server opens the flow
and raises the auth request, an absent one answers "not found or not enabled",
and a `bearer` one answers "not configured for OAuth authentication".
**Mutation:** deleting the producer call from `PiAgent.setCapabilityTurnRuntime`
and, separately, deleting the getter from `createClaudeContext` each turn all
three cases red with the exact pre-fix refusal, "Plugin MCP server
authentication is not available in this session runtime."

**OWED, out of zone:** `ClaudeAgent` never publishes the authority. The one line
belongs at `claude-agent.ts:853`, or better once for both backends beside
`BaseAgent.publishSkillResourceAuthority` — until then the tool is wired on Pi
only, which is the default runtime (`NESSY_FEATURE_PROVIDER_CLAUDE` is off).

### B4 — a server pending OAuth is visible mid-turn

`base-agent.ts:1723-1731` calls `materializeRuntimePoolServers` and consumes
`.sources`, `.mcpServers`, `.apiServers`, `.mergedMcpServers` — the returned
`externalAuthRequirements` is never read. **Positive control on the same value:**
`SessionManager.ts:8225-8227` reads the identical array for dp requirements and,
when one is not ready, pauses the turn and raises an auth-request card.

*The skeptic narrowed this: the user does get a session-start signal via
`PendingAuthNotice`. Restate the consequence as mid-turn only — neither the
model nor the turn carries any signal that a declared server exists but is
unauthorized.*

Emit a one-line system reminder naming the server and pointing at
`source_oauth_trigger` (once B3 lands), and/or a non-interrupting notice row.
**Non-interrupting** — a dp requirement is a hard dependency, an unauthorized
plugin server is not.

**Gate:** a turn with a `needs-login` oauth requirement carries the reminder and
does **not** pause. **Mutation:** make it interrupting → the non-pause assertion
goes red.

### B5 — a skill does not instruct the model to call tools that are not there

Measured through the production resolver against the owner's real install:
`view.skills` = 12, all enabled, reaching the system prompt with zero further
steps; `view.mcpServers` = 1 but `mergedMcpServers` = `[]` after materialization.
**Eight of the twelve** skill descriptions name a Figma MCP tool by name, across
five distinct tools (the first audit said four; the skeptic re-counted and it is
an undercount, not an overcount).

So the model is primed to call Figma tools, loads a skill telling it to, and
finds no such tool. The user sees "the plugin is broken", not "the plugin needs
a sign-in". **This ordering inversion is what makes the missing sign-in
affordance expensive rather than merely annoying.**

Annotate that plugin's skills in the `<available_skills>` listing
(`prompt-builder.ts:302`) with a short suffix — e.g. `[server 'figma' needs
sign-in]` — derived from the same `externalAuthRequirements` B4 stops
discarding.

**Gate:** with an unauthorized plugin server, that plugin's skills carry the
suffix and others do not. **Mutation:** drop the annotation → red.

### B6 — an `ON_INSTALL` connector is not silently downgraded

`auth-requirements.ts:114-121` unconditionally writes capability-path servers
into the `ON_FIRST_USE` bucket. The owner's real install record disagrees:
`installed.json`'s figma entry carries `connectorAuthTiming: "ON_INSTALL"` and
`catalogAuthenticationPolicy: "ON_INSTALL"`.

Consequence: `authRequests`/`onInstall` is empty, so
`PluginInstallChecklist.tsx:214-229` renders the connector row as
**informational** with the hint *"No sign-in is needed now — the session notice
offers it when a chat starts"*. **That sentence is currently false, and it is the
sentence that sent the owner away.**

Read the persisted `origin.provenance.connectorAuthTiming` in
`derivePluginMcpAuthRequirements` and honour ON_INSTALL. Related and worth
folding in: `PluginManagementResult.authRequests` is declared, read in three
places, and **assigned nowhere** — either populate it in `summarizeInstalled`
from the live credential-slot state (it already computes `authRequirements` two
lines up) or delete it and let `authRequirements` be the single source.

**Until the ON_INSTALL chain is repaired, the honest minimum is to change the
hint string** — do that first even if the rest of the row slips.

**Gate:** an ON_INSTALL connector renders an actionable checklist row, not an
informational one. **Mutation:** restore the unconditional bucket → red.

---

## Wave C — Claude plugins

### C1 — `hooks`/`mcpServers` load from a declared path or inline

**Blocker.** The manifest reference's own complete-schema example contains
`"hooks": "./config/hooks.json"` and `"mcpServers": "./mcp-config.json"`, and the
component sections say **"Location: `.mcp.json` in plugin root, or inline in
plugin.json"** and **"`hooks/hooks.json` in plugin root, or inline in
plugin.json"**. We load **only** the two default files: a custom path or an
inline object yields zero capabilities.

So a user installs `testdino` or `tres-finance-plugin` from Anthropic's
community marketplace and gets a plugin with **no MCP server at all** — the
tools it exists to provide never appear.

*Skeptic's sharpening: the install does not report plain success —
`compatibility.state` comes back `partial`, which drives `needsConfirmEnable`.
But the user still gets no explanation, because `plugins.compatDeferredEntry`
has exactly one consumer, reached only from the two blocked-install paths.*

Give `normalizeClaudeMcpServers` and `normalizeClaudeHooks` the same
`ClaudeComponentPathResolution` argument every other component reader already
takes. Inline → parse directly; declared paths → read those files; merge with
the default file.

**This is the recurring failure mode AGENTS.md names** — renames and new
component types. Diff the component table in `plugins-reference.md` against the
adapter's discovery constants field by field while you are in there.

**Gate:** a fixture plugin declaring `"mcpServers": "./mcp-config.json"` and an
inline `hooks` object yields both capabilities; the default-file plugin still
works. **Mutation:** revert either reader → its arm goes red.

### C2 — a plugin agent keeps its `description`

Docs: plugin agents support `description` among their frontmatter, and Claude
uses it to decide when to invoke the agent. We drop it, so the model sees
`Imported <name> agent.` and has no basis to auto-dispatch by task fit — plugin
agents are effectively manual-invocation-only. **The same agent file imported
through the Codex adapter works**, which is the tell.

One line in `claude.ts:923-932`, mirroring `codex.ts:1610`:
`...(frontmatter.description ? { description: frontmatter.description } : {}),`
on the pushed capability object.

**Gate:** an imported Claude agent's description reaches the model listing.
**Mutation:** drop the line → red.

### C3 — a marketplace `renames` map is honoured

> `renames` | object | Map from a former plugin `name` to its current name, or
> to `null` if the plugin was removed. Lets existing users migrate
> automatically when you rename or remove an entry in `plugins`.

Never read. **Four plugins in Anthropic's own community marketplace already have
a renamed identity.** A user who installed one under the old name has an
installed record that no longer joins any catalog row, and the new name shows in
browse as a separate, not-installed plugin. The join is `matchesInstalledItem`
(`useMarketplaceItems.ts:180-187`).

Add `renames?: Record<string, string | null>` to `ExternalPluginCatalogDto`,
resolve in `parseExternalPluginCatalog` (`external-catalog-adapters.ts:251`):
follow chains to a terminal name or `null`, refuse cycles, expose the resolved
map so the installed-plugin joiner can rewrite a stored id once. Treat `null` as
removed-upstream, not as a rename.

**Gate:** an installed plugin whose catalog entry was renamed still joins, and a
`null` entry reports removed-upstream. **Mutation:** drop the resolution → red.

### C5 — LSP servers keep `env` and `workspaceFolder`

Docs name ten optional LSP fields, and the substitution table lists `command`,
`args`, `env`, `workspaceFolder` as placeholder targets. We keep almost none.

*Skeptic: understated, not overstated — the drop is **fully silent**.
`compatibility.state` came back `supported`, `deferred = []`, `diagnostics =
[]`. So unlike hooks/mcp there is not even a machine-readable record.*

Extend `PluginLspDescriptor` with `env` and `workspaceFolder`, read them through
`rewriteClaudeTokensInRecord`/`rewriteClaudeTokens` like every other executable
field, and thread `env` into the `LspService` spawn. **Record the remaining
seven tuning fields as a `deferred` row — that half is load-bearing**, since
today they vanish without trace.

**Gate:** an LSP plugin declaring `env` and `workspaceFolder` starts with them;
the seven others appear as deferred. **Mutation:** drop the deferred row → red.

**Wave 2 completed the carry and moved the record off `deferred`. Two premise
corrections came out of it, both measured:**

- There is no `capabilities/projection.ts`. The projection on this path is
  `plugins/projection.ts`, and its `lspServers` has **zero production readers** —
  the live path is capability → resolver binding → `views.ts` → `SessionManager`.
  (Positive control on the same sweep: `views.ts`'s `lspServers` is read at
  `SessionManager.ts:11586`/`:11604`.) Nothing was added to the projection record.
- `requiresConfirmation` comes from `repair`/`update` only. `install` never
  returns it — `management-service-v2.ts:196` returns without it, and the comment
  above it says so: "the supported subset activates in the requested scope
  without a second confirmation step". So a `deferred` row's cost is not an
  install prompt; it is an **update** that calls `policyStore.purgePlugin` and
  switches the plugin off until the user confirms it again.

### The C5/D3 channel rule — where a parsed-but-ignored field is recorded

Settled here so no later row re-litigates it. Three channels exist and they are
not interchangeable:

| channel | who reads it | what it costs |
|---|---|---|
| `compatibility.adapter.warnings` | **nobody** (`claude.ts:2490`) | — |
| install-result `diagnostics` | `rpc/marketplace.ts:275` → `diagnosticCodes` on **every** install, `state` untouched | nothing |
| `compatibility.deferred` | `toSafeDeferredCapabilities` → the plugin detail view's badge; **and** `state: 'partial'` → `requiresConfirmation` + `purgePlugin` on update | the plugin is switched off and must be re-confirmed |

**The rule: a FIELD we parse and ignore is a warning diagnostic. A COMPONENT the
user does not get is a `deferred` row.** D3 already lands on the diagnostic side
for Codex's dropped listing fields; C5's tuning knobs are the same shape and now
match it. A whole LSP server skipped for an invalid `workspaceFolder` stays a
`deferred` row, because that is a component.

The counts that decided it, measured 2026-07-31 against the two published
Claude catalogues: **0 of 2307** community entries declare `lspServers` at all;
**12 of 276** official entries do; **0** of those 12 declare `env` or
`workspaceFolder`; and exactly **2** (`jdtls-lsp`, `kotlin-lsp`) declare one
field from the unread list — `startupTimeout`, nothing else. So the deferred
row's entire measurable effect was to switch those two plugins off on their own
update, over a knob that costs them no capability.

**Owed, and out of zone V1:** `startupTimeout` is the one unread field with a
reader already waiting — `LspService`'s `startupTimeoutMs`, whose default is
12 s. Both plugins that declare it ask for **120 s**, so today they abort at
`initialize` with `lsp-initialize-timeout` and only `sessionLog.warn` says so.
Carrying it needs `plugins/types.ts` and `plugins/schema.ts`.

### C-minor — metadata fields, re-weighted

`category`, `tags`, `keywords`, `license`, `repository`, `relevance` are
dropped. **The skeptic re-derived the real numbers across all 2307 community
entries: `category` appears on 151, `tags` on exactly 1, and `license`,
`repository`, `keywords`, `relevance` on ZERO.** So "the detail view cannot show
a licence or link to the repository" has no instance in the largest real Claude
catalog. Carry `category` (it enables a browse facet worth having); leave the
rest until something real needs them. **Not a tracker row** — folded into C5's
commit if convenient, otherwise dropped.

---

## Wave D — Codex plugins

### D1 — the official Codex catalog browses with names

**Blocker.** Ground truth from the owner's cache: 180 items, **`with
description: 0`, `with version: 0`, `with nonempty capabilities: 0`**, every
icon a generic grey plugin glyph.

`openai/plugins` ships its catalog at `.agents/plugins/marketplace.json`, whose
key union across 180 entries is exactly `['category','name','policy','source']`
— no description, no version.
`registry-catalog-fetcher.ts:201-211` returns the moment `readCatalogManifest`
succeeds, so `scanPluginDirectories` never runs and the per-plugin manifests it
just staged are never read.

The user cannot tell 180 plugins apart before installing — choosing means
installing to find out. **This is the primary discovery surface for the only
large Codex plugin registry that exists.**

Continue to the directory scan after a root manifest succeeds and merge the
per-plugin manifests over the root entries.

**Gate:** the openai/plugins catalog browses with descriptions and versions on
a substantial majority of its 180 rows; count before and after. **Mutation:**
restore the early return → red.

### D2 — we stop executing hooks upstream parses and skips

We execute Codex prompt and agent hooks that upstream parses and **skips**. We
are more permissive than the platform we are importing from, which is the wrong
direction for third-party code.

### D3 — dropped manifest fields leave a diagnostic

Every publisher and listing field a real Codex manifest carries is dropped and
the bundle still reports **"supported"**. Same shape as C5: the fix is the
diagnostic, not necessarily the field.

### D4 — `.agent-plugin/plugin.json` is recognised

One of the three manifest locations Codex accepts, not recognised at all.

### D5/D6 — documented fields and budgets

`additionalContextLimit`, `commandWindows`, `async` have no reader and no
diagnostic. Codex `SessionEnd` hooks are clamped to Claude's 1.5 s instead of
Codex's 3 s ceiling.

*One Codex finding was refuted and is recorded in §Not doing.*

**Gate (D2–D6, one commit each):** a fixture exercising each field/location
behaves per the quoted spec sentence. **Mutation:** revert the reader → red.

---

## Wave E — degradation semantics

The through-line, in Claude's words: **the unit of degradation is a tool, never
the turn.** Stated three ways across the docs. E1–E4 adopt that inside our
existing lease model — no architecture change, as established in §Decisions D1.

### E0 — an un-authorized plugin slot stops bricking every send ✅ `1a125e90`

The release blocker, and **the plan that produced it attributed the wrong
cause.** `assertActive` never fired. `materializer.resolveCredential` reported
"this credential is not ready" by throwing the **same** `capability-snapshot-revoked`
code. C3 deliberately keeps an `authType` plugin MCP server *enabled* while its
slot is empty so the pending-auth surface can name it — so Figma's unauthorized
OAuth server threw at `runtime-pool-servers.ts:380` on **every** materialization,
making the `endpointAuthPending` branch three lines below it unreachable. Not a
race, which is exactly why it never healed.

**The decisive artifact:** `capability-path-install-probe.test.ts`'s
`fakeMaterializer` modelled `resolveCredential` as a quiet `{ready:false}` while
production **throws**. That is why CI was green through a shipped release
blocker. All 20 hand-built materializer fixtures have since been classified and
made faithful — 9 further hits are the host seam, where `{ready:false}` genuinely
*is* the contract. Flipped together across 17 files and 8641 tests: **exactly 0
additional reds**, every one inert.

**"It clears only on an app restart" is WITHDRAWN.** It was never measured, and
the mechanism contradicts it — an absent credential row survives a restart. The
stronger control, on one *unrestarted* process: 15:38 Figma uninstalled → send
answered; 15:46 Figma reinstalled → the failure returned. **The plugin is the
variable, not process lifetime.** Do not design against the restart claim.

### E1 — one failing server stops taking the others down

Materialization is all-or-nothing: one unresolvable credential aborts the whole
batch, so unrelated, unchanged servers die with it. Wrap per server; a server
that cannot materialize is reported unavailable and the rest proceed.

**One caller is deliberately NOT degraded, and E1 must not "fix" it without
saying so.** `BaseAgent.setSourceServers` calls `materializeRuntimePoolServers`
directly on the send path and was left hard on purpose: degrading there runs the
turn with **zero MCP servers**, which is a silent capability loss — strictly
worse than a visible failure. It is recorded as a category string. If E1's
per-server isolation makes a soft outcome safe there, that is an argument to be
made explicitly in the commit, not a side effect.

**Gate:** a batch with one unresolvable and three healthy servers yields three
live servers and one reported unavailable; the `setSourceServers` behaviour is
either unchanged or its change is argued. **Mutation:** restore the single try →
red.

### E2 — a pooled `api` source does not capture a dead lease

`resolver.ts:1435`:

```ts
function isLeaseActive(leaseId: string): boolean {
  const record = leases.get(leaseId);
  return !!record && !record.revoked;
}
```

A **deleted** lease — the normal end of a turn, `releaseSnapshot` does
`leases.delete` — is indistinguishable from a **revoked** one, a security event.
`materializeSnapshotSources` hands the source builder closures capturing the
turn's materializer (`runtime-pool-servers.ts:183` and `:190`); those closures
survive into the app-lifetime `McpClientPool`, and invoked after the turn they
hit a deleted lease and read it as revoked. Nothing re-enters the resolver.

**Scope, established by the E0 executor and narrower than first stated: this
reaches `type: 'api'` sources ONLY.** MCP sources receive a materialized value,
not a closure. Note also that this is *not* the mechanism behind what the owner
measured — E0 settled that — so treat it as an independent latent defect with no
known live reproduction, and find one before building the fix around a guess.

Bind the pooled config's credential provider to the **current resolver** rather
than a captured expired lease. **Do NOT keep the turn's lease alive to serve the
pool** — that is the one careless fix here that genuinely widens a lease's
lifetime.

**Gate:** on a packaged build, complete a turn that populates the pool with a
credentialed native source, let the turn end, force a pooled tool call from a
later turn, and confirm no `capability-snapshot-revoked`. **A positive control is
required** — make the same call with a deliberately revoked lease and confirm it
DOES fail. **Mutation:** revert the binding → the first arm goes red while the
control stays red.

### E3 — a not-ready credential is its own error code ✅ `c0c5e0de`

`credential-not-ready` is split from `revoked`; `assertActive` is untouched on
both sides and a non-endpoint credential still fails hard. **Verify when picking
up E4 that all three triggers are covered** — `!ready`, revision mismatch, and
**expiry** (`materializer.ts:191`, `result.credential?.expiresAt <= Date.now()`).
Expiry is the one most easily missed and is more common than rotation: a token
that simply lapses between snapshot resolution and materialization takes the
whole workspace down the same way.

**Still open here:** Claude's retry, which E4 now carries.

> When a request to an OAuth server you already signed in to returns `401
> Unauthorized`, Claude Code refreshes the stored token, reconnects, and retries
> the request once. It flags the server in `/mcp` only if that retry also fails.

**Gate:** each of the three triggers yields `credential-not-ready`, not
`revoked`; a dead lease still yields `revoked`; the re-resolve fires once.
**Mutation:** collapse the codes → red.

### E4 — the remaining unguarded sites

Four raw `resolveCredential` calls remain: `runtime-pool-servers.ts:162`, `:176`,
`:183`, and `:508` (`materializePluginMcpCredentialEnvironment`, MCPB
`credentialEnvironment`).

*Consequence checked separately and it is narrower than F1's: a merely missing
credential is parked upstream by the resolver (`resolver.ts:1546-1550`,
`:1731-1737`), so those capabilities never reach materialization. The live
triggers are rotation and expiry.*

**Do not widen the soft path** — `assertActive` is a correctness floor. E3's code
split is what makes this fixable: once the codes differ, these sites can
re-resolve on `credential-not-ready` and still fail hard on `revoked`.

**Gate:** a rotated and an expired credential each re-resolve once at each of
the four sites; a revoked lease still fails hard. **Mutation:** revert → red.

### E6 — provenance records the resolved version, not the advertised one

Handed back by the E0/A2 executor as out of its scope. `marketplaceProvenance` →
`reconstructInstallSource` keeps the **advertised** version, so Repair re-widens
through the A2 ladder rather than reproducing the exact artifact that was
installed. After A2 this no longer *fails* — it just is not byte-reproducible.

Compounding it: **no integrity digest is persisted from the resolved dist**, so
the install was never byte-pinned in the first place. Fixing provenance without
also persisting the digest gives reproducibility in name only. See §Decisions D5
— `verifyIntegrity` currently fails open on unrecognized algorithms and never
reads `dist.shasum`.

**Gate:** an installed record carries the resolved version string and the
resolved dist digest; Repair reproduces that exact artifact rather than
re-resolving. **Mutation:** restore the advertised version → the repair test
resolves a different string and goes red.

---

## Wave F — the API surface we never connected

We consume three endpoints (`/v1/meta`, `/v1/skills`, `/v1/plugins`) of a
**54-path** OpenAPI 3.0 spec (`https://skills-market.t-tech.team/api/docs/openapi.json`,
title `nessy-marketplace-api` v1.0). Catalog size: **6084 skills, 118
extensions**.

- **F1 — filters.** `/v1/skills/facets` is never called, so 457 tenants / 1354
  tags / 10 professions of filter vocabulary are unavailable against 6084
  skills. Also: `/v1/skills` filter parameters are currently sent under
  **bracketed names the server ignores**, and `phase` is not a parameter at all.
- **F2 — duplicates.** Browse shows **1926 duplicate skill rows** that
  `/v2/registry/catalog` already groups into variant clusters for us.
- **F3 — staleness.** We never record which immutable snapshot we installed, so
  a market skill can never be told it is stale.
- **F4 — N+1.** We fetch a skill file-by-file when
  `/v1/skills/{id}/archive.zip` serves the whole tree anonymously in one
  digest-verified request, and both extractors already exist.
- **F5 — telemetry.** `POST /v2/registry/entries/{kind}/{id}/installations`
  exists and nothing in the repo calls it: every desktop install is invisible to
  the marketplace's own counters.

Also unconsumed, not yet tracker rows: **Skill Packs** (16 curated bundles with
resolved artifact ids, plus an `/install-sources` sub-resource that is literally
our problem statement), and `/v1/catalog` (the only endpoint exposing
`npmPackage`, on 14 of 118 rows).

**Gate (per row):** the endpoint is called and its result reaches a user-visible
surface; F2 asserts the deduplicated row count. **Mutation:** per row, revert →
red.

---

## Not doing, and why — so nobody re-files these

- **Install the 106 command-less extensions via the v2 Registry.** v2 is
  **skills-only by server-side kind validation**. Live probe:
  `?kind=nessy-extension` → HTTP 400 `INVALID_REGISTRY_KIND`; same for
  `extension`, `plugin`, `mcp-server`, `nessy-plugin`. Only `agent-skill` and
  `skill` return 200 (aliases, both `total: 5341`). The OpenAPI copy pins it:
  `/v2/registry/catalog`'s `kind` parameter is `"enum": ["agent-skill"]`.
  **Positive control, same rig, same minute:** `/v1/plugins?pageSize=100`
  returns 118 rows of `"kind": "nessy-extension"`. Closed question — the ask
  belongs upstream (§Decisions D4).
- **"The normalizer refuses 106 rows before any network call."** Refuted:
  measured on HEAD after `8bbb1f73`, the real normalizer against the live
  listing returns **installable 118, refused 0**. What legitimately survives is
  dead code only: `normalizeDetailManifestSource` (`normalizers.ts:264-278`)
  reads `detail.manifestUrl` from a nested object the API never returns —
  `manifestUrl`/`manifestPath`/`manifest` are top-level. Unreachable, no user
  consequence.
- **"The derivation rule is refuted by the catalogue."** Refuted: the finding
  tested two rules the implementation does not use. HEAD's
  `deriveNessyExtensionCoordinates` (`normalizers.ts:349-387`) is a single
  deterministic hybrid — gitlab group plus the `/-/tree/<ref>/` subdirectory
  tail, or group plus the listing's own `name` at a repo root — and every one of
  the counterexamples resolves cleanly under it. The **design** risk survives
  and is §Decisions D4.
- **"The inline `manifest` removes the need to fetch anything."** It does not.
  `manifest` is a capability **summary** — arrays of names with no commands,
  args, env, transports or file paths. `"commands": ["commands"]` in one entry
  is a *directory name*, not a command list. An install built from it would
  declare MCP servers by name with nothing behind them. Use it for the browse
  card and pre-install preview only. **Carried verbatim as a guardrail: this is
  the most likely thing a future pass mistakes for an installable artifact.**
- **"figma's trusted PostToolUse hook cannot resolve its own command"** — refuted
  by the skeptic.
- **Fetching the vendor docs at `ai-office.pages.devplatform.tcsbank.ru`.**
  Behind a devplatform login redirect; not anonymously fetchable. Every claim in
  this plan about the marketplace comes from the OpenAPI document plus a live
  probe, never from prose we could not read. If someone gains access, re-check
  §Decisions D4 first.

---

## Method rules

1. **Reproduce before fixing.** Every row above has a live reproduction or a
   measured count. Do not start from the prose.
2. **NUL bytes** — several source files carry one and plain `grep`/`rg` skips
   such a file **silently**. Use `grep -a` for every absence claim, and never
   pipe a grep through `head` before you know the hit count.
3. **UNCHALLENGED ≠ CONFIRMED.** Rows sourced from an unchallenged finding are
   marked in the tracker notes. Re-verify the evidence before building on it.
4. **Two git commands** — pathspec on the `commit`, not only on `git add`. One
   commit per row, tracker row updated in the same commit.
5. **Zone by FILE, not by subsystem.** `git commit <pathspec>` takes the file's
   working-tree state, so two agents editing one file WILL cross. See the
   parallelism table below.
6. Run every test from the repository **ROOT** — a package-directory run
   destroys the real `~/.nessy-agent/config.json`. Check `ps aux | grep "bun
   test"` first; two concurrent runs manufacture failures.
7. **Live evidence comes from a packaged build.** `electron:dev` runs the host
   and the Pi subprocess from built bundles, and preloads the interceptor from
   source when `!isPackaged` — a fix can be on disk and absent from the running
   app.
8. **An absence needs a positive control.** Say what yours was.
9. The app on CDP **9224 is the owner's live rig** — drive it, do not kill or
   rebuild it. Probes that install go to TEMP config dirs, never the owner's.
10. Never write `~/.nessy/dp_auth_creds.json`; never log a token, JWT, cookie or
    header value.
11. **Audit test fixtures for the same infidelity that hid these bugs.** Both
    `fakeMaterializer` helpers modelled `resolveCredential` as a quiet
    `{ready:false}` while production **throws** — which is why CI stayed green
    through a shipped defect. Check every hand-built
    `CapabilitySnapshotMaterializer`, and the repository-install fixture that
    asserts a header instead of a route.

## G1 — live acceptance, and the sources it runs against

**The plan is not done without this row.** Every C and D gate is a fixture. A
fixture proves the manifest parses; it does not prove a user can install a
plugin and use it. That gap is what produced every defect in this plan.

**Test sources, all verified anonymously reachable on 2026-07-31:**

| source | catalog | entries | why this one |
|---|---|---|---|
| `anthropics/claude-plugins-official` | `.claude-plugin/marketplace.json`, 161 KB | **276** | the official one; entry keys include `lspServers`, `skills`, `strict`, `version` |
| `anthropics/claude-plugins-community` | same path, 1.59 MB | **2307** | third-party, screened, pinned to commit SHAs; entry keys include `mcpServers` |
| `anthropics/claude-code` | same path, 5.5 KB | **13** | Anthropic's own demo plugins — the smallest honest smoke set |
| `openai/plugins` | `.agents/plugins/marketplace.json`, 49 KB | **180** | the Codex catalog; already added on the owner's rig |
| Skills Market | `/v1/plugins` | **118** | ours |

Note what the two Anthropic catalogs carry that our adapter must not drop:
`lspServers` at entry level in the official one (the field a shipped bug already
read as `input.lsp`), and `mcpServers` at entry level in the community one.

**The four source shapes the community catalog actually uses**, counted across
all 2307 entries — this is the install matrix G1 must cover, and it is not what
a reading of the docs alone would predict:

| shape | count | example |
|---|---|---|
| `url` + `sha` | **1898** | `{"source":"url","url":"https://github.com/JuliusBrussee/caveman.git","sha":"0d95a81d…"}` |
| `git-subdir` | **405** | `{"source":"git-subdir","url":"42Crunch-AI/claude-plugins","path":"plugins/api-security-testing","ref":"v1.0.1","sha":"30287f5e…"}` |
| bare relative string | **4** | `"./testdino"` — resolved inside the marketplace repo itself |
| npm | — | ours; Skills Market only |

Two things to note before designing against this. **`git-subdir`'s `url` is an
`owner/repo` shorthand, not a URL** — 190 entries have no parseable host for
exactly this reason. And **2300 of 2303 are pinned to a commit SHA**, so
SHA-pinned fetch is the dominant path, not an edge case.

**The host allowlist is NOT a blocker here, and C4's priority drops
accordingly:** every one of the 2113 resolvable hosts is `github.com`. C4/C4b/C4c
stay in the plan as honesty and reach, not as something the Claude catalogs need.

**`renames` is a top-level marketplace key and it is populated** — exactly four
entries, which settles C3's premise with the real file: `qodo-skills → qodo`,
`wordpress-com → build-with-wordpress`, `auth0-sdks → auth0`,
`twilio → twilio-developer-kit`.

**Named test cases already identified:**

- **`caveman`** — `url` + `sha` shape,
  `https://github.com/JuliusBrussee/caveman.git`. **Owner-requested**, and it is
  the single most representative test in the whole matrix: 82% of the community
  catalog is this shape. Also install it **by URL directly**, not only through
  the catalog, to cover the custom/ad-hoc source path.
- **`42crunch-api-security-testing`** — the `git-subdir` shape with a `ref` and a
  `sha`, the second-largest bucket at 405 entries.

- **`superhuman`** in `openai/plugins` — the **only** one of 180 shipping a
  `bin/` directory (`plugins/superhuman/bin/cli.js`). This is C6's test case;
  before finding it, C6 was a feature with no known consumer.
- **`testdino`** and **`tres-finance-plugin`** in the community catalog — both
  declare `mcpServers` inline, both install with **zero** MCP servers today.
  C1's test cases. Note they are also two of the four **bare relative string**
  sources (`"./testdino"`), so one install exercises both C1 and the string
  shape.
- **`nessy-dev-agent`** in Skills Market — 3 MCP servers
  (`dpGitlab`, `dpCodeSearch`, `filesystem`) and a `NESSY.md` context file, so
  it exercises install → capability → use on our own catalog.

**Gate:** eight plugins, at least two from each of three sources, installed by
**real clicks through the UI** on a packaged build, recording per plugin:
installed y/n · checklist rendered y/n · capabilities present y/n · sign-in
reachable y/n · the model can call one of its tools y/n. **A row that installs
but cannot be used counts as a failure.** **Mutation:** none — this is
acceptance, not a unit.

**Sequencing:** run G1 **after** wave 1. Run before, and it measures what we
already know is broken.

## Dispatch — how this runs autonomously

**Zoned by FILE, not by subsystem.** `git commit <pathspec>` takes the file's
working-tree state, so two agents editing one file WILL cross and each lands
under the other's subject. Partial staging is interactive and therefore
unavailable. Every zone below is one agent owning its files end to end; rows
inside a zone are **sequential**, zones run **concurrently**.

Each agent: reproduce → fix → gate → mutation probe → commit (one per row,
tracker updated in the same commit) → report. An agent that finishes its zone
stops; it does not pick up another zone.

### Wave 1 — eleven zones, no cross-dependencies

| zone | rows | files owned |
|---|---|---|
| Z1 | A0 | `i18n/locales/en.json`, `ru.json` — **only** |
| Z2 | B1 | `PendingAuthNotice.tsx` — **only** (do not touch `AppShell.tsx`) |
| Z3 | C1 → C2 → C5 | `format-adapters/claude.ts` |
| Z4 | D1 → C3 | `registry-catalog-fetcher.ts`, `external-catalog-adapters.ts` |
| Z5 | D2 → D3 → D4 → D5 → D6 | `format-adapters/codex.ts` |
| Z6 | A4 → A5 → A6 | `marketplace/registry-source.ts` |
| Z7 | E1 → E4 → E2 | `mcp/runtime-pool-servers.ts`, `capabilities/materializer.ts` |
| Z8 | B3 | `session-tools-core/context.ts`, `claude-context.ts`, `session-mcp-server/index.ts` |
| Z9 | B6 | `plugins/auth-requirements.ts`, `management-service-v2.ts` |
| Z10 | A3 → E6 | `plugins/install-service.ts`, `plugins/source-resolver.ts` |
| Z11 | F1 → F2 → F3 → F4 → F5 | `marketplace/client.ts`, `normalizers.ts`, `types.ts` |

**Z4 and Z3 both touch adapter code but different files** — C3 is the catalog
parser, C1/C2/C5 are the Claude adapter. Keep them apart as listed; if either
agent finds it must edit the other's file, it stops and reports rather than
crossing.

### Wave 2 — after Z8 (B3) lands

| zone | rows | files owned |
|---|---|---|
| Z12 | B2 | `McpServersPanel.tsx`, `PluginInfoPage.tsx`, + the `SafeCapabilitySummary` auth-kind field |
| Z13 | B4 → B5 | `agent/base-agent.ts`, `SessionManager.ts`, `agent/core/prompt-builder.ts` |

B2, B4 and B5 all consume what B3 wires. Starting them early means guessing at
its shape.

### Review

Every zone reports to the planner, who verifies before the row is marked ✅.
**A correction to this plan is worth more than compliance with it** — three rows
of the first draft were already wrong (A1 withdrawn, E2 rescoped, the
restart-only claim withdrawn), each caught by an executor or a skeptic rather
than by the planner. An agent that cannot reproduce a row's premise must say so
and stop, not build the fix anyway.

**Live evidence comes from a packaged build.** `electron:dev` runs the host and
the Pi subprocess from built bundles and preloads the interceptor from source
when `!isPackaged`, so a main-process fix can be on disk and absent from the
running app. Rows B1, B2, B4 and E1 need `bun run electron:build:main` plus a
relaunch before their live gate means anything. **The owner's rig on CDP 9224 is
not an agent's to restart** — request it through the planner.

## Parallelism

Waves A, C, D and F touch disjoint files and can run concurrently. Within them:

- **A1 + A2 are the same file region** (`normalizers.ts` /
  `install-service.ts` version handling) — **sequence them**, A1 first.
- **A4 + A5 + A6 all touch `registry-source.ts`** — **one executor, sequential**.
- **B1 + B2 both touch renderer panels** but different files; B3 and B4 are
  server-side. B5 depends on B4's data. **B6 is independent.**
- **E2 + E4 both touch `runtime-pool-servers.ts`** — one executor. **E3 must land
  before E4** (E4's fix depends on the code split).
- **E1 and E3 both touch the materialize path** — sequence E1 → E3.

## Blocking order

Nothing in B, C, D or F blocks anything in A. Within the user's goals:

- **Goal 1 (working internal marketplace)** = A1 → A2, then A4/A5/A6.
- **Goal 2 (Claude/Codex plugins)** = C1 and D1 are the two blockers; the rest
  is quality.
- **Goal 3 (correct operation)** = Wave B plus E1–E4.
- **Goal 4 (what the docs say we lack)** = Wave E, plus C1/C3/C5 and the
  refusals recorded in §Not doing.

## Report

Per row: sha; the reproduction before and after; the mutation with both sides;
the positive control for any absence claim. For the waves as a whole: which
UNCHALLENGED rows you re-verified and what changed; corrections to this plan —
**expected, and more valuable than compliance**; `bun run typecheck:all` plus
`apps/cli` separately (the former does not cover it) stated explicitly with exit
codes.

## Constraints

No push, MR, tags, `reset`, `rebase`, `--amend`, `checkout --`, or `stash`.
Probes restored by re-edit or `.orig`. No `Co-Authored-By` trailers. No version
bumps until close-out. `docs/superpowers/specs/` and
`docs/testing/cdp-live-checklist.md` are planner-owned. `.references/` must not
be modified. Do not rewrite registry or Bun config to bypass supply-chain
quarantine. English in code, comments and commits.

## Close-out

When every non-parked row is ✅: bump the version in **both** root
`package.json` and `apps/electron/package.json` in lockstep, add a **new**
`apps/electron/resources/release-notes/<version>.md` (never edit an existing
one — the changelog is append-only per-version history), update the affected
`docs-site/` pages, and regenerate both derived specs:

```
python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md
python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md
```

**Do not delete this plan.** It is where these decisions' reasons live.

## The parity row this plan creates

The audits exist because plugin **lifecycle** was never a parity dimension. Five
earlier plans covered format and components; the parity report marks
`plugins-reference.md`, `mcp.md`, `plugin-marketplaces.md` and
`discover-plugins.md` "all built", and none of the 13 doc gaps was visible from
inside that framing.

Add a standing parity row — *plugin and capability lifecycle under failure* —
whose check is not "is the contract implemented somewhere" but **"is it applied
on every surface that refreshes, materializes or invalidates"**. A5 is the proof
that this row is needed: we read the v2.1.214 contract on 2026-07-26, wrote it
down, applied it to MCP tool refresh, and shipped the identical bug in
marketplace registry refresh five days later.

---

## A8 re-shaped — a hard confirmation gate was the wrong seatbelt

The row asked for a refusal when a derived coordinate's package does not
correspond to the entry's `path`. **Measured across the live catalog, that gate
is unsatisfiable**, and the executor stopped rather than build it.

Of the 88 derived rows (no `install.command`), `repository.url` is **populated on
18** — 12 agree with the entry path, **6 disagree** — **empty (`{"type":"","url":""}`)
on 68**, and the package 404s on 2. Control on the same sweep: of the 12
published-command rows, `repository.url` is populated on exactly 1.

So a hard gate refuses 68 of 88 rows and undoes most of A2's measured 12 → 116.

**Worse, the 6 disagreements are verifiably the CORRECT packages.**
`@ai-office/nessy-extension-nfs-support-nessy-extensions-nessy-default-extension`
advertises `1.0.3-beta.0` and publishes exactly
`1.0.3-beta.0-source.20260627123722.90adde5e1b5a` with a matching description;
`@ai-office/nessy-extension-sotqa-packages-ai-skills` advertises `0.0.6` and
publishes `0.0.6-source.20260729124639.fed4817ff908`. Their `repository` field is
inherited from the template repo the extension was **copied out of** — it records
authorship, not identity. Requiring a match refuses real, correct rows.

**The seatbelt A8 wanted largely already exists.** A2's ladder ties the derived
package to the listing's own advertised version base (`widened-within-base`), and
the advertised version IS published on essentially every row — unlike
`repository.url`.

**So A8 becomes a warning, never a refusal:** emit a diagnostic when
`repository.url` is populated AND disagrees, naming both. Say nothing when it is
empty, which is the common case. The upstream ask (§Decisions D4 — have
`nessy-marketplace-api` publish `install` for all 118 rows) is unaffected and
remains the real fix.

**Gate:** a populated-and-disagreeing row warns and still installs; an empty
`repository.url` is silent; the 12 published rows are untouched.
**Mutation:** turn the warning into a refusal → the 68-row fixture goes red.

---

## H1 — a 401 or 403 marks a server as needing sign-in

**Owner decision 2026-08-01: match Claude.** Quoted from `mcp.md`:

> Claude Code marks a remote server as needing authentication when the server
> responds with `401 Unauthorized` or `403 Forbidden`. For a server you haven't
> signed in to, either status code flags it in `/mcp` so you can complete the
> OAuth flow.

And on a refresh that the provider rejects:

> As of v2.1.195, when a token refresh fails because the server rejects the
> stored refresh token, Claude Code immediately shows a notice pointing at
> `/mcp`. The connected server's menu there offers Re-authenticate, so you can
> sign in again before the next tool call fails.

**Why this is a real gap and not a nicety.** Our only "needs sign-in" signal is
an EMPTY credential slot (`pending-auth-summary.ts` feeds 1 and 2b). A server
whose slot is filled but whose token the provider has revoked or expired
server-side is invisible to every surface we ship: the row shows connected, the
session-start card says nothing, and the failure appears as a tool call that
does not work. The user has no way to reach a re-authentication.

**Already built, and this row depends on it:** E3 split `credential-not-ready`
from `revoked`, and Claude's retry contract — refresh, reconnect, retry once,
flag only if the retry also fails — is the shape E4 gave the four remaining
`resolveCredential` sites. So the mechanism exists; the missing piece is the
HTTP-status trigger that feeds it.

**Scope:** a `401`/`403` from a plugin-owned MCP server flags that server as
needing sign-in through the same path an empty slot uses, so all three surfaces
(the row, the detail page, the chat card) offer Connect without a new mechanism.
**Do not** flag on any other status — the docs are explicit that 4xx and
authentication errors are not retried, but only these two mean "sign in".

**Gate:** a server returning 401 is flagged and offers Connect on all three
surfaces; the same server returning 500 is not flagged; a flagged server whose
sign-in completes clears. **Mutation:** drop the status check → the 401 arm goes
red while the empty-slot arm stays green, proving the new trigger and not the
old one is what fires.

---

## H2 — a user server and a built-in of the same name render twice

**Introduced by `b57e5db3`** (built-ins became ordinary capabilities) and found by
the executor that landed the card work, not by a gate.

**Measured:** a user-defined `.mcp.json` server named `dpJira` produces **two**
rows — `dpJira/user` and `dpJira/builtin` — where the runtime starts exactly one.
The runtime is right: `mergeBuiltinDpMcpServers` treats a configured wire name as
taken and stands the built-in down. It is the projection that double-counts.

**Why the existing gate does not catch it.** There IS a "counted ONCE" arm, and
it passes — because its fixture supplies only the RPC half of the pair, never the
catalog half. That is the fixture-fidelity shape this repo has now been bitten by
three times: a hand-built double that cannot express the state the bug lives in.

**Consequence:** the row count disagrees with what runs, one of the two rows'
switches writes a preference that the fold then ignores, and the Sources total
(which H-era work just taught to equal the row count) inherits the error.

**Scope:** the projection must stand the built-in down on the same rule the fold
already uses — a configured wire name, or a configured `dp ai mcp` subcommand,
wins. Do not solve it by de-duplicating in the renderer: the two sources of truth
would still disagree, and only one of them starts processes.

**Gate:** with a user `.mcp.json` server named `dpJira`, exactly one row appears,
it is the user's, and the built-in's switch is absent rather than inert; the
Sources count matches. Extend the existing "counted ONCE" fixture to carry BOTH
halves — that fixture's blindness is half this row. **Mutation:** drop the
stand-down → two rows again, and the count assertion goes red with it.
