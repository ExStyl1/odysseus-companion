# R5 — Settings slice, upstream v0.14.0 → v0.15.1 (input for plan 1.43.0)

Reader R5, 2026-10-14. Read-only. Upstream read by tag from `.references/craft-agents-oss` (`git diff v0.14.0 v0.15.1 -- <path>`, `git diff -w` for the re-indented pages, `git show v0.15.1:<path>` for the new and big files). Our side read at HEAD of `feat/TCODE-000-1-41-0` (f495cf311). Divergence numbers come from `divergence.json`.

## 1. Summary

- **No settings file changed in v0.15.1.** Two files changed in v0.14.1: `SettingsToggle` gained a `note` prop, and the AI page's decision card shows a "last 7 days" usage line under each Advanced toggle. Everything else is the v0.15.0 redesign.
- **New layout primitive.** `components/settings/SettingsPage.tsx` (new) exports `SettingsPage`, `SettingsPageTitle`, `SettingsPageState` and `DETAIL_COLUMN_CLASS`. Every page drops its own `PanelHeader title=` + `ScrollArea` + `max-w-3xl` wrapper. Instead it gets a header that carries only actions, plus a centred 680px column (16px sides in a compact panel). The column holds the page title, a one-line lede and the groups, spaced `space-y-6`. The lede reuses each page's navigator description key (`settings.<page>.description`), so it needs no new strings.
- **Primitives restyled on the new tokens.** Raised cards (`bg-raised shadow-elev-1`, full-width `bg-separator` hairlines, a new `SettingsCardDivider`). Group headings shrink to a quiet 12px secondary label. Rows are ≥56px with 14px sides, and their descriptions always wrap. Fields use the sunken `field-surface` with `aria-invalid`. The radio and segmented controls get an accent fill and a `--border-control` ring. The menu-select trigger becomes a pill chip. Expanding content uses `AnimatedCollapsibleContent` (a fade, no height animation).
- **Functional changes hidden in the pages:**
  - the AI page loads everything as one parallel snapshot behind a skeleton (new `ai-settings-loader.ts` + test), so sections no longer pop in above the controls;
  - workspace overrides sit in one card;
  - the credential banner becomes an info-tint card with a primary button;
  - a Cloudflare AI Gateway provider label is added;
  - Appearance gets a theme-tile grid (`ThemeGrid`, owned by R1) in place of the dropdown, a new **Motion** setting (system / reduced / full), and Font and Language move into "Interface";
  - App merges its three one-row groups into one headless card;
  - Shortcuts uses the shared `Kbd`/`KbdGroup` and denser 44px rows;
  - the Navigator rows take the EntityRow anatomy;
  - icon buttons get `aria-label`s, and the Server and Input pages get `common.browse`/`hide`/`show`.
- **Ours.** Ours is upstream ≤ v0.13.4 for most primitives (div 0), so the primitive swap is mechanical. The pages carry heavy Nessy specifics (the gateway, Codex and Claude runtime cards, guardian, advisor, codex auto-review, notification timing, retention, provenance, safe mode, judge rules, QR pairing, shortcut rebinding), so each page is a per-hunk merge.
- **Messaging stays removed.** `MessagingSettingsPage` is N/A. `SettingsEditRow` stays deleted (P6.1021; it has zero callers upstream too).

## 2. Proposed rows

Order is by dependency. Every row is renderer-only, so its Runtimes line is "runtime-neutral (renderer layout); connection cards per runtime are data, not branches" unless stated.

**Cross-reader dependencies:**
- **R1**: tokens, `index.css`, theme roles CSS, motion system, `ThemeGrid`, `ThemeContext`, playground.
- **R2**: `PanelHeader`.
- **R6**: `button.tsx` (`primary`/`secondary` variants, size `md`/`icon-sm`, `IconButton`), `skeleton.tsx` (ADDED upstream), `switch.tsx`, `kbd.tsx`, the onboarding wizard and `ApiKeyInput` (Cloudflare preset).
- **R7**: `AnimatedCollapsibleContent` export from `@nessy-agent/ui`, `Info_DataTable` header classes, `Info_Page` (which imports `DETAIL_COLUMN_CLASS` from this slice's `SettingsPage`), and the i18n locale files.
- **B1**: `getDecisionUsage` RPC and the `DecisionToggleUsage` type.
- **B2**: `cloudflare-gateway.ts`, `theme-roles.ts`.

The serialised file `AiSettingsPage.tsx` (plan 0.6) gains R5-09a/b, R5-10 and R5-11 beside UB6.5, UB7.4 and UB7.7. `WorkspaceSettingsPage.tsx` is touched by R5-05 only.

---

**R5-01 `[renderer]` `[design]` Settings primitives at v0.15.1 + the `SettingsPage` column (M).**
- **Needs:** R1 token row: `text-label`/`text-label-sm`/`text-title`/`text-caption`/`text-mono-ui`, `text-secondary`/`text-tertiary`, `bg-raised`, `shadow-elev-1`, `bg-separator`, `border-subtle`, `bg-fill-hover|pressed|selected`, `bg-accent-solid`, `bg-on-accent`, `bg-floating`, `--border-control`, `field-surface`, `h-control*`, `min-h-row-menu`, `motion-press`, `duration-micro`/`ease-out-subtle`, `--container-mobile` (for `@max-mobile/panel`), `in-data-compact`. **Positive control:** these tokens are absent in ours — `rg` over `apps/electron/src/renderer/index.css` for `text-label-sm|bg-raised|shadow-elev-1|bg-separator|text-tertiary|@max-mobile` → 0 hits, while `shadow-minimal` → hits at index.css:116,124. Also needs the R6 `button.tsx` row (`SearchableModelInput` uses `variant="secondary" size="icon-sm"`) and the R7 row exporting `AnimatedCollapsibleContent` from `@nessy-agent/ui` (ours has it only as a local function in `packages/ui/src/components/markdown/CollapsibleSection.tsx`). i18n keys `common.hide`, `common.show` (missing in our en and ru, present upstream) land first.
- **Upstream:** v0.15.1 `apps/electron/src/renderer/components/settings/{SettingsPage (ADDED), SettingsUIConstants, SettingsCard, SettingsSection, SettingsRow, SettingsToggle, SettingsSelect, SettingsMenuSelect, SettingsInput, SettingsTextarea, SettingsRadioGroup, SettingsSegmentedControl, SearchableModelInput, index}.ts(x)`. Mechanism:
  - `settingsUI` gains `row`, `rowBare`, `cardPadding`, `link` and `prose`;
  - every `inCard ? 'px-4 py-3.5' : 'py-3'` becomes `settingsUI.row|rowBare`;
  - `SettingsInput` and `SettingsSecretInput` share a `RevealButton` with `aria-label`;
  - `SettingsMenuSelect` adds `aria-label` and a chip trigger;
  - `SettingsSegmentedControl` becomes a well with a raised selected item and adds `aria-label`;
  - `SettingsRadioGroup` gets a `RadioIndicator`, and `AnimatedCollapsibleContent` replaces `motion.div`.
- **Files (ours):** the same 14 paths under `apps/electron/src/renderer/components/settings/`, with `SettingsPage.tsx` new.
- **Method:**
  - **TAKE 1:1** (div 0): `SettingsUIConstants`, `SettingsCard`, `SettingsSection`, `SettingsSelect`, `SettingsInput`, `SettingsRadioGroup`, `SettingsSegmentedControl`, `SettingsPage`.
  - **TAKE + re-apply hunks:**
    - `SettingsToggle` (div 32: ours lacks the v0.14.0 `tooltip`; taking v0.15.1 brings `tooltip` + `note` and supersedes UB6.5's "SettingsToggle.tsx tooltip prop" hunk);
    - `SettingsTextarea` (re-apply our `onBlur` prop, P6.225);
    - `SettingsMenuSelect` (keep `t('settings.noResultsFound')`);
    - `SearchableModelInput` (keep `@nessy-agent/ui` and `t('settings.noModelsFound')`; upstream still hard-codes the English strings);
    - `index.ts` (keep the `IsolationNetworkPosture` export; keep `SettingsRowLabel` NOT exported).
  - **MERGE:** `SettingsRow` (div 147, almost all of it docblocks). Take upstream's always-wrap description (`[overflow-wrap:anywhere]`, no `truncate`). D1.101/D1.213's truncating default is superseded by the owner's 2026-10-14 rule "settings 1:1". Keep `wrapDescription?` as an accepted, deprecated no-op so no page changes in this row. R5-05 and R5-09b drop its four call sites (`AiSettingsPage.tsx:426`, `WorkspaceSettingsPage.tsx:413,597,651`). Rewrite the docblock in a few lines naming the decision.
- **Keep:**
  - `IsolationNetworkPosture` stays ours. Its restyle is in R5-06.
  - `SettingsRowLabel` and `SettingsEditRow` stay deleted (P6.1021, D1.102). At v0.15.1 upstream has zero callers of either outside `components/settings/` (git grep → 0 files; positive control `SettingsToggle` → 6 files).
  - Our i18n strings stay.
- **Tests:**
  - `components/settings/__tests__/SettingsRow.test.tsx`, rewritten. Positive: a long path renders in full with `[overflow-wrap:anywhere]`. Negative/boundary: no description in any `components/settings/*.tsx` carries `truncate` (source census), and `wrapDescription` changes nothing in the markup.
  - New `components/settings/__tests__/SettingsPage.test.tsx` (`renderToStaticMarkup`). Positive: title `h2` + lede `p` + children inside `DETAIL_COLUMN_CLASS`. Negative: no `description` → no lede `p`; `SettingsPageState` renders no title.
  - New `SettingsToggle.test.tsx`. Positive: `note` renders a `tabular-nums` line. Negative: no `note` → no extra node; the tooltip button's click does not toggle the switch.
  - `IsolationNetworkPosture.test.tsx` re-run unchanged.
  - Playground: our 11 `playground/registry/settings-*.tsx` entries swept in DARK theme.
- **Runtimes:** runtime-neutral.
- **Done means:**
  - every primitive equals v0.15.1 modulo the listed hunks (a `diff` after the brand normalisation shows only those);
  - `@nessy-agent/ui` exports `AnimatedCollapsibleContent`;
  - the electron typecheck is green;
  - the playground sweep's dark screenshots are attached.

**R5-02 `[renderer]` `[design]` Settings navigator rows (XS).**
- **Needs:** R5-01; R1/R2 for the `entity-row-btn`, `pl-gutter`/`--gutter`, `bg-fill-selected`, `bg-separator` utilities (EntityRow anatomy).
- **Upstream:** v0.15.1 `pages/settings/SettingsNavigator.tsx`. It drops `Separator` and the absolutely-positioned icon. The row is now icon · title/subtitle with `data-slot="entity-row-title|subtitle"`, a hairline from the text edge drawn by `after:`, and a `⋯` button with `aria-label={t('common.more')}`, revealed on hover or focus-within.
- **Files:** `apps/electron/src/renderer/pages/settings/SettingsNavigator.tsx`.
- **Method:** TAKE 1:1 (div 2) and re-apply the URL scheme `nessy://settings/${item.id}?window=focused`.
- **Keep:** our scheme; our item list (`import` page present, `messaging` absent — `apps/electron/src/shared/settings-registry.ts`).
- **Tests:** new `pages/settings/__tests__/settings-navigator.test.tsx`.
  - Positive: the selected row renders `data-selected` and both entity slots.
  - Negative: the `⋯` trigger carries `aria-label` and `pointer-events-none` until hover or focus; the open-in-new-window URL starts with `nessy://`, never `craftagents://`.
- **Done means:** a dark playground or CDP screenshot of the navigator with one row selected.

**R5-03 `[renderer]` Small pages onto `SettingsPage`: Input, Labels, Preferences, Server, Import (S).**
- **Needs:** R5-01; R6 `button.tsx` (`IconButton`, `secondary`/`primary`, `md`); i18n `common.browse` (missing in ours) keys first.
- **Upstream:** v0.15.1 `InputSettingsPage.tsx`, `LabelsSettingsPage.tsx`, `PreferencesPage.tsx`, `ServerSettingsPage.tsx`. These are wrapper swaps to `SettingsPage` with `description={t("settings.<page>.description")}`, plus:
  - Labels: `settingsUI.prose`/`link`, a `Spinner` in place of `Loader2`, a new empty state;
  - Server: info-tint banners in place of the warning/amber ones, `IconButton` copy/show with `aria-label`/`aria-pressed`, `common.browse`, a footer with `ghost`/`primary` `md`.
- **Files:** those four, plus ours-only `ImportSettingsPage.tsx` (40 lines, the same wrapper swap) and `components/import/ClaudeImportPanel.tsx`. Its 38 legacy tokens, including 7 raw palette classes found by `git grep -P` for palette utilities, move to roles.
- **Method:**
  - Input: TAKE 1:1. Ours equals v0.14.0 after the brand normalisation (`diff` → identical).
  - Labels (div 44): take, then re-apply `getManagedEditConfig` + `labelsResource` and `getDocUrl('labels', i18n.resolvedLanguage)`.
  - Preferences (div 19): take, then re-apply `getManagedEditConfig('preferences-notes', …)`.
  - Server (div 29): take, then re-apply the F5 QR pairing `SettingsRow` (restyled: `rounded-sm`, `text-label-sm text-tertiary` hint) and `settings.server.notConfigured`. Our `settings.server.browse` → upstream `common.browse`; drop the orphan key only if `lint:i18n:reachable` says so.
  - Import: adopt `SettingsPage`.
- **Keep:** managed edit configs (no raw file paths); the QR pairing; the localized doc links; the `import` page.
- **Tests:**
  - Existing `safe-mode-entry-surface.test.ts` and `config-doctor-settings-surface.test.ts` re-run, because they read neighbouring page source.
  - New `pages/settings/__tests__/settings-page-shell.test.ts` (source census over `pages/settings/*.tsx` and `ImportSettingsPage.tsx`). Positive: each page renders through `SettingsPage`/`SettingsPageState`. Negative: none of them imports `PanelHeader` or `ScrollArea` directly. Each later page row extends its allowlist.
  - `claude-import-panel.test.tsx` re-run.
- **Done means:** dark screenshots of the five pages; zero raw palette classes in `ClaudeImportPanel.tsx`.

**R5-04 `[renderer]` App page merge (M).**
- **Needs:** R5-01, R5-07 (its three embedded sections), R6 `button.tsx`.
- **Upstream:**
  - v0.15.1 `AppSettingsPage.tsx`. Wrapper → `SettingsPage`.
  - The three ONE-row groups (desktop notifications, keep awake, built-in browser) merge into one headless card. Upstream's own comment: "three one-row cards under three headings only added boxes".
  - The proxy footer uses a `ghost` Reset and a `primary` Save at `md`.
  - The About row uses `tabular-nums` and `secondary`/`primary` buttons.
- **Files:** `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx` (ours 1075 lines, div 749).
- **Method:** MERGE per hunk. Layout decision (decided, not queued): upstream's merge rule does not hold here, because ours are not one-row groups.
  - Notifications has three rows plus the P6.467 `scopeNote` description (pinned by `notification-scope-note.test.ts`).
  - Tools has three rows (browser, download root, ask before download).
  - So Notifications, Tools, Workflows, Retention, Cross-session inbound, Network and About keep their headed sections on the new primitives. Power (one row) keeps its own section, because a single headless card at the top would read as unlabelled.
  - The divergence is recorded in the row's commit and a one-line code comment.
  - Inline legacy blocks (`px-4 py-3.5 text-sm text-muted-foreground space-y-1`: workflows notes, managed-updates note) become `settingsUI.cardPadding` + `settingsUI.prose`.
- **Keep:**
  - notification timing + permission/question alerts (O3);
  - workflow size guideline + managed note (P6.319);
  - retention;
  - cross-session inbound selector;
  - download root/ask;
  - bundled/custom CA;
  - managed updates (`isUpdatesManagedOff`, `updatesManagedSourceKey`);
  - the embedded Provenance / Config Doctor / Safe Mode sections.
- **Tests:**
  - `app-settings-managed-updates.test.ts`: its needle at lines 205–206 pins `className="px-4 py-3.5 text-sm text-muted-foreground space-y-1"`. Repoint it to the semantic needles (the `updatesManaged` line inside the block). Positive: the managed line renders under Check Now. Negative: no install row when managed-off.
  - `notification-scope-note.test.ts`, `cross-session-inbound-selector.test.ts` re-run.
  - Extend `settings-page-shell.test.ts`'s allowlist.
- **Done means:**
  - re-run `bun run lint:ledger-citations`. `scripts/ledger-citation-baseline.txt` carries `AppSettingsPage.tsx:355-365::NOTIFICATION_TIMINGS`, and capability-ledger rows B16, H43 and O3 cite `AppSettingsPage.tsx:<line>`. Convert every drifted citation to symbol form, naming the old anchor in words (AGENTS.md "A correction must not spell the dead anchor");
  - a dark screenshot.

**R5-05 `[renderer]` Workspace page (S).**
- **Needs:** R5-01, R6 `button.tsx` (`buttonVariants`), R7 `AnimatedCollapsibleContent`.
- **Upstream:** v0.15.1 `WorkspaceSettingsPage.tsx`.
  - Empty and loading states → `SettingsPageState`; `headerActions` is shared.
  - Raw `<button>`s → `Button secondary/ghost md`.
  - The icon-upload label gets a focus-visible outline and `buttonVariants`.
  - The mode-cycling error moves from `AnimatePresence` to `AnimatedCollapsibleContent` with `role="status"`.
- **Files:** `apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage.tsx` (691 lines, div 285).
- **Method:** MERGE per hunk. Drop the three `wrapDescription` props: R5-01 made the default wrap.
- **Keep:**
  - our six-mode default-mode selector (the v0.14.0 guarded half is D(c) in the draft manifest);
  - budget ceilings;
  - local MCP servers;
  - default project folder;
  - workspace-refresh behaviour.
- **Tests:**
  - `workspace-default-mode.test.ts`, `workspace-settings-refresh.test.ts`, `budget-ceilings-disclosure.test.ts`, `primary-folder-settings-surface.test.ts` re-run (source-text: re-anchor any needle the re-indent broke).
  - Positive: a mode-cycling error appears in a `role="status"` node.
  - Negative: no `AnimatePresence`/`motion.` import remains in the file.
- **Done means:** a dark screenshot.

**R5-06 `[renderer]` Permissions page + its Nessy sections (M).**
- **Needs:** R5-01, R7 (`Info_DataTable` restyle for the tables these sections embed).
- **Upstream:** v0.15.1 `PermissionsSettingsPage.tsx`. The wrapper → `SettingsPage`; `Spinner`; the About card on `settingsUI.prose`/`link`; the empty states.
- **Files:**
  - `PermissionsSettingsPage.tsx` (631 lines, div 414);
  - ours-only `AutoModeJudgeRulesSection.tsx`, `AutoModeDenialsSection.tsx`, `BrowserOriginTrustSection.tsx`, `components/settings/IsolationNetworkPosture.tsx` (legacy-token counts 12 / 18 / 13 / 10);
  - `permissions-cross-scope.ts` (no change expected).
- **Method:** MERGE the page per hunk. The four ours-only sections ADOPT: `SettingsSection` + `SettingsCard` + `settingsUI.row`/`cardPadding`/`prose`/`descriptionSmall`, `Button`/`IconButton`, and roles in place of `text-muted-foreground`/`text-xs`/`bg-muted`.
- **Keep:** primary folder; MCP channel push; process isolation + network posture; browser origin trust; auto-mode judge rules and denials; the cross-scope "already granted" annotation; blocked-tools annotation.
- **Tests:**
  - `permissions-cross-scope.test.ts`, `permissions-blocked-tools-annotation.test.ts`, `auto-mode-judge-rules-surface.test.ts`, `primary-folder-settings-surface.test.ts`, `IsolationNetworkPosture.test.tsx` re-run.
  - New census in `settings-page-shell.test.ts`. Positive: the four section files use `settingsUI`. Negative: none contains `text-muted-foreground` or `px-4 py-3.5`.
  - Playground `settings-isolation`, `settings-judge-rules`, `settings-judge-denials`, `settings-permissions-cross-scope`, `settings-blocked-tools` in dark.
- **Done means:** `lint:ledger-citations` green (ledger A43 cites `PermissionsSettingsPage.tsx:1-45`; I13 cites `:250`; the baseline cites `:317-325`); dark screenshots.

**R5-07 `[renderer]` App-page Nessy sections on the new primitives: Provenance, Config Doctor, Safe Mode (S).**
- **Needs:** R5-01.
- **Upstream:** none (ours-only). This is the "whole settings area looks 1:1" requirement.
- **Files:** `SettingsProvenanceSection.tsx` (361 lines, 41 legacy tokens), `SettingsConfigDoctorSection.tsx` (9), `SettingsSafeModeSection.tsx` (3).
- **Method:** ADOPT the primitives, as in R5-06. No behaviour change.
- **Keep:** all behaviour (provenance per key, doctor findings, safe-mode entry).
- **Tests:**
  - `config-doctor-settings-surface.test.ts`, `safe-mode-entry-surface.test.ts`, `connection-pane-surface.test.ts` re-run.
  - Census. Positive: the three files use `settingsUI`. Negative: zero `text-muted-foreground`.
  - Playground `settings-provenance`, `settings-config-doctor`, `settings-safe-mode` in dark.
- **Done means:** dark screenshots.

**R5-08 `[renderer]` `[design]` Appearance page: theme grid, Motion, Interface (M).**
- **Needs:**
  - R5-01;
  - R1's `ThemeGrid.tsx` (ADDED upstream) and its `ThemeContext` additions (`resolvedMode`, `motion`/`setMotion`, `appThemeOverrides`) + `packages/ui/src/motion` (`MotionPreference`);
  - B2 `theme-roles.ts` (`deriveThemeRoles`, which ThemeGrid uses);
  - R7 `Info_DataTable` (`INFO_TABLE_HEADER_CLASS`, `INFO_TABLE_SORTABLE_HEADER_CLASS`);
  - draft row UB7.2 (workspace-avatar colour override — the page's `ColorPicker` is that atom's setter);
  - OQ-R5.1;
  - i18n `settings.appearance.motion`, `motionDesc`, `motionReduced`, `motionFull` keys first (missing in ours).
- **Upstream:** v0.15.1 `AppearanceSettingsPage.tsx`.
  - The "Default Theme" card is split into a **Mode** section (segmented light/dark/system, with `aria-label`) and a **Color theme** section (`ThemeGrid` with live swatches in the resolved mode, dark-only caption, placeholder tiles while presets load, `lastPresetTileCount`).
  - **Font** (system/inter order), **Motion** (new) and **Language** move into the Interface card.
  - The tool-icon table headers use the Info table classes.
  - The workspace avatar trigger is restyled.
- **Files:** `apps/electron/src/renderer/pages/settings/AppearanceSettingsPage.tsx` (535 lines, div 163).
- **Method:** MERGE per hunk:
  - the placeholder count starts from OUR bundled preset count (6 files in `apps/electron/resources/themes/`: codex, github, haze, nord, one-dark-pro, vitesse), never upstream's 16 — derive it, do not hard-code it;
  - the Motion row replaces our "Reduced motion" toggle per OQ-R5.1 (default: take upstream's tri-state, and migrate our stored `prefersReducedMotion=true` to `'reduced'` in R1's store);
  - the avatar `ColorPicker` arrives with UB7.2. Until then, keep our `img` + placeholder.
- **Keep:**
  - managed edit config for tool icons (`getManagedEditConfig('edit-tool-icons', …)`);
  - `useKanbanColumnColors` / `withColumnDropStatus` (UA2.3);
  - project colour treatment (UA5.9; its file-end import that keeps doc line numbers);
  - background-finished chip (UA1.15);
  - rich tool descriptions;
  - our theme set (R1).
- **Tests:**
  - New `pages/settings/__tests__/appearance-theme-grid.test.tsx`. Positive: selecting a tile calls `setColorTheme` with the same id the dropdown used. Boundary: while presets load, `placeholderCount` equals our bundled count and nothing below shifts. Negative: a theme with `supportedModes:['dark']` shows the dark-only caption in light mode.
  - Motion arm. Positive: 'reduced' sets the reduced attribute. Negative: 'system' with the OS not asking leaves motion full.
  - Playground: theme grid in light and dark.
  - CDP: dark screenshot of Appearance.
- **Done means:** no `SettingsMenuSelect` remains for the app theme; the Motion row persists across restart.

**R5-09a `[renderer]` `[ai]` AI page: one-snapshot loader, skeleton, page shell (S).**
- **Needs:** R5-01, R6 `skeleton.tsx` (ADDED upstream; absent in ours — `ls components/ui` shows no skeleton, and v0.14.0 has none either).
- **Upstream:**
  - v0.15.0 `pages/settings/ai-settings-loader.ts` (ADDED): `loadAiSettings(api, refreshConnections)` is one `Promise.all`;
  - `__tests__/ai-settings-loader.test.ts` (ADDED, 3 cases);
  - `AiSettingsPage.tsx`: `settingsLoading` → three `Skeleton` blocks inside `SettingsPage`, a cancellable effect, `refreshLlmConnections` in the snapshot.
- **Files:**
  - `apps/electron/src/renderer/pages/settings/ai-settings-loader.ts` (new);
  - `pages/settings/__tests__/ai-settings-loader.test.ts` (new);
  - `AiSettingsPage.tsx` (load effect at :861–912 and the render shell at :1613–1620).
- **Method:** ADD, ADAPTED. Our `AiSettingsApi` pick is `getWorkspaces`, `getDefaultThinkingLevel`, `getOutputStyle` + `listOutputStyles(activeWorkspaceId)`, `getExtendedPromptCache`, `getRtkEnabled`, `getRtkStatus`, `getGuardianEnabled`, `getGuardianModel`, `getGuardianModelsByConnection`, `getAdvisorEnabled`, `getAdvisorModel`, `getCodexAutoReviewEnabled`, `getCodexAutoReviewPolicy`, `getCodexSubagentsEnabled` and `getCredentialHealth`.
  - **Not `getEnable1MContext`.** F1.1241 removed the Extended-context switch: `packages/server-core/src/sessions/SessionManager.ts:25891` and `packages/shared/src/agent/backend/types.ts:1100`; `git grep getEnable1MContext -- apps/electron/src` → 0 files, while the control `getExtendedPromptCache` hits at `shared/types.ts:1127`.
  - The page shell becomes `SettingsPage` with `description={t("settings.ai.description")}` (the key exists in en and ru).
  - Rename OUR route-props type `SettingsPageProps` (`pages/settings/settings-pages.ts:36`, imported at `AiSettingsPage.tsx:33`) to `SettingsRouteProps`. The barrel `@/components/settings` now exports a layout type with the same name, which would make the two collide.
- **Keep:** `connectionSlug` route (D1.254); every Nessy loader field above.
- **Tests:**
  - `ai-settings-loader.test.ts`, upstream's three cases rebased with source header `v0.15.1:…`:
    - positive: it waits for connections + health;
    - boundary: a slow workspace lookup does not serialise health;
    - negative: an RPC failure rejects and never invents healthy credentials.
    - Add a negative arm: the result carries no `enable1M`.
  - Source-text tests that pin `get*(` in `AiSettingsPage.tsx` read page + loader together: `advisor-settings-surface.test.ts:54-56`, `codex-subagents-settings-surface.test.ts:43-45`, `codex-auto-review-settings-surface.test.ts:59`.
  - `ai-settings-route-connection.test.ts:65` pins the signature string; update it for the rename.
- **Done means:**
  - the page reveals all sections at once (dark screenshot during the skeleton, and after);
  - the electron typecheck is green.

**R5-09b `[renderer]` `[ai]` `[design]` AI page body restyle (M).**
- **Needs:** R5-09a; R6 `button.tsx` (`IconButton`, variants); R7 `AnimatedCollapsibleContent`; R1 `bg-info-tint`/`--info-border`/`bg-navigator` tokens.
- **Upstream:** v0.15.0 hunks of `AiSettingsPage.tsx`:
  - `CredentialHealthBanner` → info tint, `primary md` button, wraps when narrow;
  - default-connection badge → `rounded-xs bg-fill-hover`, duplicate-account icon `text-info`;
  - the connection `⋯` → `IconButton aria-label={t('common.more')}`;
  - `WorkspaceOverrideCard` → one row inside ONE shared `SettingsCard` for all workspaces (`EXPANDER_ROW_CLASS`, `AnimatedCollapsibleContent`, `aria-expanded`, `pl-9` body);
  - "Add connection" → `Button secondary md`;
  - the RTK update/get/recheck buttons → `secondary md`;
  - the RTK meter → `scaleX` transform on `--border-control`, refresh → `IconButton`;
  - the overlay → `bg-navigator`, the close → `Button secondary icon` with `aria-label`.
- **Files:** `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx` (2037 lines, div vs v0.14.1 1304; 51 legacy tokens, 6 raw palette classes, 3 `AnimatePresence`).
- **Method:** MERGE per hunk. Drop `wrapDescription` at :426 (default now wraps). Restyle our own sections onto the same primitives: guardian, advisor, codex auto-review, codex subagents, output style, gateway reconnect, mid-stream hint.
- **Keep:**
  - Nessy gateway cards (`isNessyGatewayConnection`, `useNessyGatewayAuth`, `computeGatewayReconnectItem`, `gatewayReconnectFailureNotice`);
  - `runtimeConnectionLabel` (Claude Code / Codex, Nessy Gateway vs Custom Endpoint);
  - "Nessy Backend" labels;
  - `canEditLlmConnection`;
  - BYO runtime edit target;
  - managed-model refusal;
  - output style;
  - guardian per-integration models;
  - advisor;
  - codex auto-review + subagents;
  - the mid-stream behaviour submenu;
  - `describeConnectionInUseHolders`.
- **Tests:**
  - `ai-settings-reconnect.test.ts:246` pins an indentation-exact line (`'              <RefreshCcw className="h-3.5 w-3.5" />'`). Repoint it to a whitespace-insensitive needle. Positive: the reconnect item renders. Negative: a non-gateway connection shows no reconnect.
  - `managed-model-refusal.test.ts`, `connection-pane-surface.test.ts`, `codex-auto-review-floor-disclosure.test.ts` re-run.
  - Census. Positive: one `SettingsCard` wraps all workspace overrides. Negative: no `amber-`, `AnimatePresence` or `motion.div` remains in the file.
  - Playground `settings-codex-auto-review` in dark.
  - CDP: rs-40/rs-41 re-driven (rs-40's `connectionMenuTrigger` walks up from the row name to the first ancestor holding a trigger; the trigger becomes `IconButton` but stays a `button`).
- **Done means:**
  - `lint:ledger-citations` green. 42 `AiSettingsPage.tsx:<line>` citations exist across docs, two of them in the capability ledger (K31, M12). Convert drifted ones to symbol form, naming the dead anchor in words;
  - dark screenshots with one gateway card, one Codex card and one Claude-runtime card.

**R5-10 `[renderer]` `[decisions]` Amend UB6.5: port the decision card at v0.15.1, with the v0.14.1 usage line (S, amendment to UB6.5, not a parallel row).**
- **Needs:** R5-09b; UB6.1–UB6.4; B1's row for `getDecisionUsage` + `DecisionToggleUsage` (v0.14.1 RPC); R5-01 (`SettingsToggle.note`).
- **Upstream:**
  - v0.14.1 `AiSettingsPage.tsx` +19/−1: `DECISION_NO_CHANGE_MIN_CHECKS = 30`; usage loaded when Advanced opens; `decisionUsageNote()` → `SettingsToggle note`.
  - v0.15.0 restyle of the card: `SettingsCard divided={false}`; Advanced expander on `EXPANDER_ROW_CLASS`; `AnimatedCollapsibleContent`; the group titles lose uppercase; the local-server row and install hint, and the test row and privacy note, are each wrapped in ONE card child (no hairline); every `size="sm"` + inline class button becomes `secondary md`.
- **Files:** `AiSettingsPage.tsx`; i18n `settings.ai.decisions.usageChecks`, `usageChanged`, `usageNoChange` (en+ru, keys first).
- **Method:**
  - UB6.5 copies the card from v0.15.1, never from v0.14.0, so the card is ported once and not restyled a second time.
  - The owner's OQ-43.2/43.2b answer (2026-10-02, "identical to craft") means upstream's install hint and docs link ship as upstream has them; under that answer UB6.5's "no install hint, no external docs link" wording is stale.
- **Keep:** none beyond UB6.5's.
- **Tests:**
  - extend UB6.5's tests. Positive: with usage `{withOutcome: 30, changed: 0}` the note ends with "has not changed anything". Boundary: `withOutcome: 29` → no suffix. Negative: `withOutcome: 0` → the checks-only line.
  - Playground: the five UB6.5 card states plus "Advanced open with usage", in dark.
- **Done means:** UB6.5's Files list names v0.15.1 and the three usage keys.

**R5-11 `[connections]` Cloudflare AI Gateway provider label (XS, conditional).**
- **Needs:** the B2/R6 row that decides the Cloudflare preset (`packages/shared/src/config/cloudflare-gateway.ts`, `ApiKeyInput.tsx`). It is a new third-party egress preset, so it carries the same posture question as OQ-43.9 (Moonshot).
- **Upstream:** v0.15.0 `AiSettingsPage.tsx` `PI_AUTH_PROVIDER_LABELS['cloudflare-ai-gateway']`.
- **Files:** `AiSettingsPage.tsx` (`PI_AUTH_PROVIDER_LABELS`, :191–207).
- **Method:** add the label only if the preset ships, in the same commit as the preset. Otherwise close the row as "N/A (preset not adopted)".
- **Keep:** our map has no `moonshotai*` (UB7.7 adds those) and no `github-copilot` (Copilot removed; OQ-43.10 (a)).
- **Tests:** positive: a `cloudflare-ai-gateway` connection's row reads "Cloudflare AI Gateway". Negative: an unknown `piAuthProvider` falls back to the raw id, as today.

**R5-12 `[cdp]` Settings sweep live case (S).**
- **Needs:** R5-01 to R5-09b.
- **Case (RS id allocated at dispatch):** in the packaged build, dark theme, `bypassPermissions`:
  - open every settings page (11 navigator items);
  - screenshot each at the full panel width and at a compact panel width (≤ 448px container, where the settings-row stacking rule in `index.css` applies);
  - on AI, capture the skeleton frame then the revealed page and assert no section mounted above an already-visible control;
  - on Appearance, switch theme by tile and Motion to Reduced, then restart and read both back;
  - on Shortcuts, rebind one action and see the `KbdGroup` render.
- **Runtimes:** runtime-neutral (on AI, one gateway card for each of Pi, Claude and Codex present).
- **Done means:** the case PASSES and has its checklist row (`docs/testing/cdp-live-checklist.md`); a docs-site settings screenshot refresh is handed to UB11.

**Row not proposed separately:** ShortcutsPage. It is folded into R5-03 if the lane prefers; listed here so the method is explicit.
- **Upstream:** v0.15.1 `ShortcutsPage.tsx`: `SettingsPage` + `description`; the local `Kbd` → `@/components/ui/kbd` `Kbd`/`KbdGroup`; `SHORTCUT_ROW_CLASS = 'min-h-11 py-2'`.
- **Ours** (479 lines, div 363) adds rebinding (`useActionRegistry`, `hotkeyFromKeyboardEvent`, collision `role="status"` notice), search (`shortcuts-search.ts`) and the Linux/Windows key split.
- **Method:** MERGE. Delete our local `Kbd` (ShortcutsPage.tsx:145–151) in favour of the shared one (R6 restyles `kbd.tsx`; `KbdGroup` is already exported in ours, `kbd.tsx:28`). The rebind and unbind buttons move to `Button ghost`/`IconButton` with their existing `aria-label`s; the search `Input` sits first in the column.
- **Tests:** `shortcuts-search.test.ts` re-run. Positive: `KbdGroup` wraps the chips. Negative: no local `function Kbd` remains.

## 3. Functional changes hidden in the redesign

| Upstream change | Paths | Our state + evidence | Disposition | Row |
| --- | --- | --- | --- | --- |
| Page title + one-line lede inside a 680px column; the header carries actions only | `SettingsPage.tsx` (ADDED), every page | Every page renders `PanelHeader title=` + `ScrollArea` + `max-w-3xl` (e.g. `AiSettingsPage.tsx:1614-1617`); lede keys already exist (`settings.<page>.description` en+ru Y for all 11) | TAKE | R5-01, R5-03…R5-09a |
| Row descriptions always wrap (no `truncate`) | `SettingsRow.tsx` | Ours truncates by default with an opt-in `wrapDescription` (D1.101/D1.213; 4 call sites) | TAKE (owner 1:1), prop retired | R5-01, R5-05, R5-09b |
| `SettingsToggle.note` (usage line) | `SettingsToggle.tsx` (v0.14.1) | Absent; ours also lacks the v0.14.0 `tooltip` (div_vs_141 32) | TAKE | R5-01 |
| `aria-label` on menu-select, segmented control, search fields, reveal-password, icon buttons | `SettingsMenuSelect`, `SettingsSegmentedControl`, `SettingsInput`, `SearchableModelInput`, pages | Absent | TAKE | R5-01, pages |
| `aria-invalid` on invalid fields (destructive ring from the field primitive) | `SettingsInput`, `SettingsTextarea` | Ours draws `ring-1 ring-destructive` on a wrapper | TAKE | R5-01 |
| Expanding content fades in place (no height animation) | `SettingsRadioGroup`, AI/Workspace pages | Ours uses `motion/react` height springs (AI ×3, Workspace ×3) | TAKE (needs R7 export) | R5-01, R5-05, R5-09b |
| AI page loads as one parallel snapshot behind a skeleton; never inserts sections above controls | `ai-settings-loader.ts` (+test) ADDED, `AiSettingsPage.tsx` | Ours: sequential awaits (`AiSettingsPage.tsx:861-912`), 14 RPCs + output styles, banner pops in | ADAPT (our RPC set, no `enable1M`) | R5-09a |
| Extended 1M-context toggle in the loader | `ai-settings-loader.ts` | Removed in ours (F1.1241; `SessionManager.ts:25891`) | DROP (our specific) | R5-09a |
| Workspace overrides in ONE card | `AiSettingsPage.tsx` | A card per workspace (`AiSettingsPage.tsx:1680-1691`) | TAKE | R5-09b |
| Credential banner: info tint + primary Re-authenticate, wraps when narrow | `AiSettingsPage.tsx` | Amber palette (`:162-182`) | TAKE | R5-09b |
| Decision card: per-feature 7-day usage under Advanced, "30 checks changed nothing" | `AiSettingsPage.tsx` (v0.14.1) + B1 RPC | No decision card yet (UB6.5 draft, from v0.14.0) | TAKE via UB6.5 amendment | R5-10 |
| Decision card restyle (expander, one card child for row + hint, buttons) | `AiSettingsPage.tsx` (v0.15.0) | n/a until UB6.5 | TAKE (port at v0.15.1 directly) | R5-10 |
| Cloudflare AI Gateway provider label | `AiSettingsPage.tsx` | Absent (`PI_AUTH_PROVIDER_LABELS` :191-207) | ADAPT (conditional on the preset decision) | R5-11 |
| RTK savings meter as a transform (reduced-motion safe) | `AiSettingsPage.tsx` | Width transition | TAKE | R5-09b |
| Theme picker as tiles with live swatches in the active mode | `ThemeGrid.tsx` (R1), `AppearanceSettingsPage.tsx` | Dropdown | TAKE; placeholder count from OUR bundled set | R5-08 |
| Motion setting (system / reduced / full) | `AppearanceSettingsPage.tsx` + R1 motion | Ours: a "Reduced motion" boolean (P6.473, `lib/reduced-motion.ts`, OR-ed with the OS; `false` never forces animation) | ADAPT per OQ-R5.1 | R5-08 |
| Font and Language moved to Interface; mode order light/dark/system; font order system/inter | `AppearanceSettingsPage.tsx` | Old layout | TAKE | R5-08 |
| Workspace avatar colour picker in Workspace Themes | `AppearanceSettingsPage.tsx` (already at v0.14.0) | Absent; ours shows the img (`AppearanceSettingsPage.tsx:376-384`) | TAKE with UB7.2 | R5-08 (after UB7.2) |
| App page: three one-row groups merged into one headless card | `AppSettingsPage.tsx` | Our groups are multi-row (Notifications 3 + scope note, Tools 3) | ADAPT: headings kept, primitives taken; reason stated | R5-04 |
| Proxy footer `ghost` Reset / `primary` Save | `AppSettingsPage.tsx` | Old buttons | TAKE | R5-04 |
| Server: `common.browse`/`common.hide`/`common.show`; info banners; copy/show `IconButton`s with `aria-pressed` | `ServerSettingsPage.tsx` | Ours i18n'd with `settings.server.browse`; QR pairing (F5) | TAKE + keep QR | R5-03 |
| Shortcuts use shared `Kbd`/`KbdGroup`, 44px rows | `ShortcutsPage.tsx` | Local `Kbd`; ours has rebinding + search | MERGE | R5-03 (Shortcuts note) |
| Navigator rows: EntityRow anatomy, `⋯` hidden until hover/focus, `aria-label` | `SettingsNavigator.tsx` | Old anatomy | TAKE | R5-02 |
| Workspace page empty/loading states via `SettingsPageState`; mode-cycling error `role="status"` | `WorkspaceSettingsPage.tsx` | Own wrappers, `AnimatePresence` | TAKE | R5-05 |
| `SettingsEditRow` gets i18n'd Edit + `secondary md` | `SettingsEditRow.tsx` | File deleted (P6.1021); zero callers upstream (git grep → 0, control 6) | N/A | — |
| Messaging page restyle | `MessagingSettingsPage.tsx` | Page removed (`settings-pages.ts` has no `messaging`; upstream `settings-registry.ts:45` has it) | N/A (OQ-43.10 (a)) | — |

## 4. Our specifics to keep (file → what to re-apply)

- `components/settings/SettingsTextarea.tsx`: the `onBlur` prop (P6.225).
- `components/settings/SettingsMenuSelect.tsx`: `t('settings.noResultsFound')`.
- `components/settings/SearchableModelInput.tsx`: the `@nessy-agent/ui` import; `t('settings.noModelsFound')`.
- `components/settings/index.ts`: the `IsolationNetworkPosture` export; no `SettingsRowLabel` export (D1.102).
- `components/settings/SettingsRow.tsx`: `data-layout="settings-row"` / `settings-control` (index.css stacking hooks); a short docblock recording that D1.101 was superseded on 2026-10-14.
- `components/settings/IsolationNetworkPosture.tsx`: whole file (ours), restyled.
- `pages/settings/SettingsNavigator.tsx`: `nessy://settings/…` scheme.
- `pages/settings/settings-pages.ts`: `import` page; no `messaging`; route-props type (renamed `SettingsRouteProps`).
- `pages/settings/AiSettingsPage.tsx`:
  - gateway reconnect (`GatewayReconnectItemView`, `computeGatewayReconnectItem`, `useNessyGatewayAuth`, auth-URL toast);
  - `runtimeConnectionLabel` and the "Nessy Backend" labels;
  - `canEditLlmConnection`/`isNessyGatewayBaseUrl` edit lock;
  - `byoRuntimeInitialValues`/`resolveConnectionEditTarget`;
  - `describeManagedModelRefusal`;
  - output-style row;
  - guardian (per-integration models);
  - advisor;
  - codex auto-review + policy;
  - codex subagents;
  - mid-stream submenu + one-message hint;
  - `describeConnectionInUseHolders`;
  - `connectionSlug` route (D1.254);
  - `codexBedrockRegionMessage`;
  - no 1M toggle (F1.1241).
- `pages/settings/AppSettingsPage.tsx`:
  - notification timing + alerts + P6.467 scope note;
  - workflow size guideline (P6.319);
  - retention;
  - cross-session inbound;
  - download root/ask;
  - bundled/custom CA;
  - managed updates helpers;
  - embedded Provenance / Config Doctor / Safe Mode.
- `pages/settings/AppearanceSettingsPage.tsx`:
  - managed edit config for tool icons;
  - `useKanbanColumnColors`/`withColumnDropStatus` (UA2.3);
  - project colour treatment (UA5.9) incl. its file-end import;
  - background-finished chip (UA1.15);
  - rich tool descriptions;
  - the reduced-motion migration (OQ-R5.1);
  - our bundled theme count.
- `pages/settings/WorkspaceSettingsPage.tsx`: six-mode default selector; budget ceilings; local MCP servers; default project folder; refresh behaviour.
- `pages/settings/PermissionsSettingsPage.tsx`: primary folder; MCP channel push; isolation; browser origin trust; judge rules; denials; cross-scope annotation; blocked tools.
- `pages/settings/LabelsSettingsPage.tsx`, `PreferencesPage.tsx`: `getManagedEditConfig` resources; localized doc link.
- `pages/settings/ServerSettingsPage.tsx`: QR pairing (F5); `settings.server.notConfigured`.
- `pages/settings/ShortcutsPage.tsx`: rebind / unbind / collision notice, search, extra action label keys.
- Ours-only sections (`AutoModeDenialsSection`, `AutoModeJudgeRulesSection`, `BrowserOriginTrustSection`, `SettingsConfigDoctorSection`, `SettingsProvenanceSection`, `SettingsSafeModeSection`, `ImportSettingsPage`, `components/import/ClaudeImportPanel`): behaviour unchanged; adopt `SettingsPage` / `SettingsSection` / `SettingsCard` / `settingsUI.row|cardPadding|prose|link|descriptionSmall`, `Button` / `IconButton`, and roles in place of `text-muted-foreground` / `text-xs` / `bg-muted` / raw palette (R5-03, R5-06, R5-07).

## 5. Per-path disposition

| Path | Ours | div (vs v0.14.1) | Method | Row |
| --- | --- | --- | --- | --- |
| `components/settings/SearchableModelInput.tsx` | same path | 2 | take + re-apply (import scope, i18n) | R5-01 |
| `components/settings/SettingsCard.tsx` | same path | 0 | take 1:1 | R5-01 |
| `components/settings/SettingsEditRow.tsx` | — (deleted P6.1021) | n/a | N/A: keep deleted (0 callers upstream) | — |
| `components/settings/SettingsInput.tsx` | same path | 0 | take 1:1 | R5-01 |
| `components/settings/SettingsMenuSelect.tsx` | same path | 2 | take + re-apply i18n | R5-01 |
| `components/settings/SettingsPage.tsx` | — | ADDED | add | R5-01 |
| `components/settings/SettingsRadioGroup.tsx` | same path | 0 | take 1:1 | R5-01 |
| `components/settings/SettingsRow.tsx` | same path | 147 (docblocks + `wrapDescription`) | merge: upstream wrap, prop → deprecated no-op | R5-01 |
| `components/settings/SettingsSection.tsx` | same path | 0 | take 1:1 | R5-01 |
| `components/settings/SettingsSegmentedControl.tsx` | same path | 0 | take 1:1 | R5-01 |
| `components/settings/SettingsSelect.tsx` | same path | 0 | take 1:1 | R5-01 |
| `components/settings/SettingsTextarea.tsx` | same path | 10 | take + re-apply `onBlur` | R5-01 |
| `components/settings/SettingsToggle.tsx` | same path | 32 (lacks v0.14.0 tooltip) | take 1:1 (brings tooltip + note; supersedes UB6.5's hunk) | R5-01 |
| `components/settings/SettingsUIConstants.ts` | same path | 0 | take 1:1 | R5-01 |
| `components/settings/index.ts` | same path | 7 | take + keep `IsolationNetworkPosture`, drop `SettingsRowLabel` | R5-01 |
| `pages/settings/AiSettingsPage.tsx` | same path | 1304 | merge per hunk (shell+loader; body; decision card via UB6.5; Cloudflare label) | R5-09a, R5-09b, R5-10, R5-11 |
| `pages/settings/AppSettingsPage.tsx` | same path | 749 | merge per hunk; headed sections kept | R5-04 |
| `pages/settings/AppearanceSettingsPage.tsx` | same path | 163 | merge per hunk | R5-08 |
| `pages/settings/InputSettingsPage.tsx` | same path | 0 | take 1:1 | R5-03 |
| `pages/settings/LabelsSettingsPage.tsx` | same path | 44 | take + re-apply managed edit + doc-link locale | R5-03 |
| `pages/settings/MessagingSettingsPage.tsx` | — (removed) | n/a | N/A: stays removed (OQ-43.10 (a)) | — |
| `pages/settings/PermissionsSettingsPage.tsx` | same path | 414 | merge per hunk + adopt our sections | R5-06 |
| `pages/settings/PreferencesPage.tsx` | same path | 19 | take + re-apply managed edit | R5-03 |
| `pages/settings/ServerSettingsPage.tsx` | same path | 29 | take + re-apply QR pairing, i18n | R5-03 |
| `pages/settings/SettingsNavigator.tsx` | same path | 2 | take + `nessy://` | R5-02 |
| `pages/settings/ShortcutsPage.tsx` | same path | 363 | merge (keep rebind + search) | R5-03 (Shortcuts note) |
| `pages/settings/WorkspaceSettingsPage.tsx` | same path | 285 | merge per hunk | R5-05 |
| `pages/settings/__tests__/ai-settings-loader.test.ts` | — | ADDED | add, adapted (our RPC set, no `enable1M`) | R5-09a |
| `pages/settings/ai-settings-loader.ts` | — | ADDED | add, adapted | R5-09a |

**Ours-only files under these directories, no upstream counterpart:**
- `pages/settings/{AutoModeDenialsSection, AutoModeJudgeRulesSection, BrowserOriginTrustSection}.tsx` and `components/settings/IsolationNetworkPosture.tsx` → R5-06.
- `pages/settings/{SettingsConfigDoctorSection, SettingsProvenanceSection, SettingsSafeModeSection}.tsx` → R5-07.
- `pages/settings/ImportSettingsPage.tsx` and `components/import/ClaudeImportPanel.tsx` → R5-03.
- `pages/settings/{ai-settings-route-connection, managed-model-refusal, permissions-cross-scope, shortcuts-search}.ts` → no layout, untouched except the type rename in R5-09a.
- `components/artifacts/PublishedPagesSection.tsx` (also imports the settings primitives) inherits R5-01 automatically.

**Cross-slice notes:**
- R7's `Info_Page.tsx` imports `DETAIL_COLUMN_CLASS` from this slice's `SettingsPage`, so R7's row Needs R5-01.
- B1 owns `getDecisionUsage`.
- R1 owns `ThemeGrid.tsx`, `ThemeContext.tsx`, `useTheme.ts`, the motion module, `index.css` (the settings-row stacking rules sit at our `index.css:1353-1429`), and the upstream `no-raw-palette-colors` / `no-motion-antipatterns` ESLint rules. Upstream enables both as `warn` in `apps/electron/eslint.config.mjs` at v0.15.1. Once R1 lands them, R5-03…R5-09b should leave the settings directories warning-free (today: 6 raw palette classes in `AiSettingsPage.tsx`, 7 in `ClaudeImportPanel.tsx`, by `git grep -P`).

## 6. Owner questions

**OQ-R5.1 — Motion setting semantics.** Upstream v0.15.0 replaces any reduced-motion toggle with a tri-state Motion: System / Reduced / Full, where Full animates even when the OS asks to reduce. Ours is P6.473's boolean `prefersReducedMotion`. It follows the Claude Code settings page's wording ("`false`: the same as unset"), so it can only ADD reduction and never override the OS (`apps/electron/src/renderer/lib/reduced-motion.ts:1-30`).
- (a) Take upstream's tri-state 1:1; migrate stored `true` → `reduced`; the default stays `system`.
- (b) Take the segmented control but offer only System / Reduced (keeps the P6.473 semantics).
- (c) Keep our toggle.
- **Recommended (a):** the setting governs our app's UI motion, not Claude Code's CLI animations, so the owner's "settings 1:1" applies. "Full" is the user's own explicit choice, and the default still follows the OS. The R1 reader owns the motion store; this question decides the Appearance row only, and R1 should take the same answer.

## 7. Coverage

- **Assigned:** 29 paths (`R5-paths.txt`).
- **Read:** 29.
  - Every path's `git diff v0.14.0 v0.15.1`, plus the `-w` variant for the re-indented pages and the per-release numstat (v0.14.1 touched only `SettingsToggle` and `AiSettingsPage`; v0.15.1 touched none).
  - The full v0.15.1 text of `SettingsPage.tsx`, `ai-settings-loader.ts` and its test.
  - The v0.14.1→v0.15.0 hunks of `AiSettingsPage.tsx` in full.
  - Our counterparts were diffed against v0.14.0/v0.14.1 after the brand normalisation, or outlined (AI, App, Permissions, Workspace, Shortcuts).
- **Skipped:** 0.
