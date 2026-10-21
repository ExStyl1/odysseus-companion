# R7: info pages, automations UI, overlays, event processor, i18n, bundled docs, main/preload, webui/viewer (v0.14.0 → v0.15.1)

Reader R7, 2026-10-14. Read-only. Ours = HEAD `f495cf311` (`feat/TCODE-000-1-41-0`). Upstream = `.references/craft-agents-oss` at tags v0.14.0, v0.14.1, v0.15.0, v0.15.1. Each tag is one squashed commit, so every reading below is a tag-to-tag `git diff`.

**Instruments:**
- `git diff --numstat` per release pair over the 80 assigned paths.
- `git diff v0.14.0 v0.15.1` over the 73 non-foreign-locale paths. This is a 4686-line dump, read in full: `scratchpad/r7/all.diff`.
- For the 20 diverged files: our file, brand-normalised the way `diverge.py` does it, diffed against upstream v0.14.1 (`scratchpad/r7/ours/*.diff`).
- en.json: a JSON key-set diff across v0.14.0, v0.14.1, v0.15.0 and v0.15.1 against our en and ru (`scratchpad/r7/i18n.json`).

## 1. Summary

- **Where the changes land.** v0.14.1 touches only the locales and the two `package.json` versions. v0.15.0 carries nearly everything: the "A new look" restyle plus five functional fixes. v0.15.1 touches `preload/bootstrap.ts` (single-flight OAuth), `browser-tools.md` and `sources.md`, the password-redaction `toolInput` on `tool_result`, `webui/web-api.ts` and 5 i18n keys.
- **The four defects B3/B4 found are confirmed at HEAD, with file:line:**
  - The Windows window is transparent over nothing on Win10 and Win11 before 22H2.
  - `theme.json` overrides are never applied.
  - The automation next-run time ignores the automation's timezone.
  - A failed `source_test` is invisible.
  - They become rows R7-01 to R7-04.
- **One new functional gap: R7-05.** Our automation timeline hides a webhook's error and response body. The host writes both (`webhook-utils.ts:41,54`). The renderer drops them in `useAutomations.ts:177-183` and in the `WebhookDetails` type. They were removed in `b0053399e`, a bulk commit whose subject does not mention them, so this is likely accidental (medium confidence). Upstream renders both (v0.13.4 and v0.15.1).
- **NavigationContext needs nothing.** Both of upstream's cold-load deep-link fixes already exist in ours, in a different shape (UA12.179): the switch is keyed by id (`NavigationContext.tsx:1157-1169`) and a stale route is guarded (`:1431`).
- **Info primitives.** 13 of the 16 `components/info/*` paths are identical to upstream (div 0) and are taken 1:1. Three are new: `Info_FullscreenButton`, `Info_StatePill` and `Info_TechnicalDetails`. Ours adds 9 Capability/Plugin/Sources components (1451 lines), which are not upstream. They need their own restyle row, because our Source, Skill and Plugin info pages render through `CapabilityDetailTemplate`, not `Info_Page`.
- **Cross-cutting trap (for R1).** v0.15.1 removes every `--*-rgb` CSS variable: 22 definitions at v0.14.0, 0 at v0.15.1, same instrument. Ours still has 22 definitions and 20 files that read `var(--*-rgb)`. Every file that is merged rather than taken 1:1 must drop them in the same wave, or its colours become silently invalid.
- **i18n.**
  - Upstream en gains 124 keys, removes 11 and changes 3.
  - **We need 110 new en keys and 120 new ru keys.** 8 are N/A (Slack/Microsoft titles; Claude-artifact publishing, DROP-b). 3 wait on UB6 (⏸). ru needs 10 extra plural forms.
  - The 9 removed keys we still carry must stay until the background-task chip row removes their callers.
- **Docs.**
  - `automations.md`: correct as-is for ours; take it now.
  - `labels.md`: rides UB4.11.
  - `sources.md`: adapt to our tool names; rides OQ-B4-2(c).
  - `browser-tools.md`: covered by B5-10.
  - `pages.md`: N/A (DROP-b).
- **Dormant webui/viewer.** They are still type-checked (`typecheck:chain`, P6.738). R7-01's new `getWindowVibrancy` therefore needs a webui stub. Everything else there is N/A.

## 2. Proposed rows

The ids are this report's; the controller assigns UB numbers. B3 and B4 each proposed UB4.11 and UB4.12 for different rows, so those numbers collide: renumber at merge. Functional rows go to their owning phase. Visual rows go to Phase 14.

Abbreviations:
- **R1-tokens:** R1's foundation row(s), covering `tokens.css`, `base.css`, `theme-roles.ts`, the `packages/ui` `./motion` and `./utils` exports, and `ThemeContext`.
- **R6-01 / R6-03:** Button + IconButton, and `Info_HeaderMenu`.
- **R5-01:** `SettingsPage.tsx` `DETAIL_COLUMN_CLASS`.

### Functional (owning earlier phases)

**R7-01 `[windows]` `[main]` `[renderer]` Opaque window on Windows 10 / Windows 11 before 22H2 (S; ≡ B3-17; Phase 4).**
- **Needs:** none. The renderer half is written so that R1's later 1:1 `ThemeContext` take keeps it: same attribute name `data-vibrancy`.
- **Upstream:**
  - v0.15.0 `apps/electron/src/main/window-manager.ts`: `WINDOWS_BACKGROUND_MATERIAL_MIN_BUILD = 22621`, Mica only, Acrylic dropped, `additionalArguments: --craft-window-vibrancy=<under-window|mica>`.
  - `preload/bootstrap.ts` `getWindowVibrancy()`, which reads the argument synchronously.
  - `ThemeContext.tsx:283-351` sets `data-vibrancy` only over a material; `index.css` keeps the canvas translucent only under `[data-vibrancy]`.
  - `channel-map-parity.test.ts` lists `getWindowVibrancy` as preload-only.
  - Mechanism, quoting the upstream comment: Electron ignores `backgroundMaterial` before 22H2 "but still makes the web contents transparent".
- **Ours, confirmed:**
  - `window-manager.ts:34-50` returns Mica at ≥22000 and Acrylic at ≥17763.
  - `index.css:331-337`: `html[data-theme-override]::before` paints 50% translucent always.
  - `ThemeContext.tsx:304-305` always sets `themeOverride`.
  - Upstream ships Windows; so do we (`build-win.ps1`).
- **Files:** `apps/electron/src/main/window-manager.ts` (3 hunks: the gate, the arg, the comment); `apps/electron/src/preload/bootstrap.ts` (the vibrancy hunk only); `apps/electron/src/shared/types.ts` (`getWindowVibrancy(): 'under-window' | 'mica' | null`); `renderer/context/ThemeContext.tsx` (`data-vibrancy`); `renderer/index.css` (translucent only under `[data-vibrancy]`); `transport/__tests__/channel-map-parity.test.ts`; `apps/webui/src/adapter/web-api.ts` (`getWindowVibrancy: () => null`, required by `typecheck:webui`).
- **Method:** re-apply hunks. Our window-manager diverges by 207 lines and our bootstrap by 313; upstream's hunks apply on their own.
- **Keep:** the argument is named `--nessy-window-vibrancy`; our window options (macOS vibrancy block, frame handling).
- **Tests:**
  - New `apps/electron/src/main/__tests__/window-material.test.ts`, with the gate extracted as a pure `windowsBackgroundMaterialForBuild(build)`. Positive: 22621 → `mica`. Boundary: 22000 and 19045 → `undefined` and no argument.
  - New `apps/electron/src/preload/window-vibrancy.test.ts`: `--nessy-window-vibrancy=mica` → `mica`; an unknown value or a missing argument → `null`.
  - The parity test stays green.
  - Live: a Windows 10 sitting case, plus a dark-theme screenshot on macOS showing the vibrancy unchanged.
- **Runtimes:** runtime-neutral (shell).
- **Done means:** on a build below 22621 no material is requested and the canvas is opaque. macOS and Win11 22H2+ are unchanged.

**R7-02 `[theme]` `[renderer]` `theme.json` colour overrides apply live (S; ≡ B3-21; Phase 4).**
- **Needs:** none. R1's later 1:1 `ThemeContext` take must keep this test green.
- **Upstream:** v0.15.0 `ThemeContext.tsx` loads `getAppTheme` and `onAppThemeChange` and resolves `resolveTheme(preset, overrides)`. v0.15.0 `App.tsx` drops its dead `appTheme` state (−`ThemeOverrides` import, −state, −effect, `useTheme()` with no argument).
- **Ours, confirmed:** `App.tsx:339` (state), `:414` (`useTheme({ appTheme })`), `:831` and `:836` (load and subscribe). Only `shikiTheme`/`isDark` are used. B3 found `ThemeContext.tsx:250` resolving the preset only, while `resources/docs/themes.md` promises live app-level overrides.
- **Files:** `renderer/App.tsx` (3 hunks); `renderer/context/ThemeContext.tsx`; `renderer/hooks/useTheme.ts`.
- **Method:** re-apply hunks. App.tsx diverges by 827 lines, so only the theme hunks are taken.
- **Keep:** the style id `nessy-theme-overrides` (`ThemeContext.tsx:351`); our theme set.
- **Tests:** new `apps/electron/src/renderer/context/__tests__/theme-overrides.test.tsx`. Positive: a stubbed `getAppTheme` returning `{ accent: '#ff0000' }` reaches the injected CSS, and an `onAppThemeChange` push updates it. Negative: `null` leaves the preset values unchanged.
- **Runtimes:** runtime-neutral.
- **Done means:** editing `theme.json` recolours the app live, as `themes.md` promises.

**R7-03 `[automations]` `[renderer]` Next run computed in the automation's timezone (XS; ≡ B4-04 / its UB4.13; Phase 4).**
- **Upstream:** v0.15.0:
  - `components/automations/utils.ts` `computeNextRuns(cron, count, timezone)` builds `new Cron(cron, { timezone })`.
  - `types.ts` `deriveAutomationSummary` passes `matcher.timezone`.
  - `AutomationInfoPage.tsx` formats dates with `timeZone: automation.timezone`.
  - `__tests__/types.test.ts` adds the "cron next-run timezone" cases.
- **Ours, confirmed, and worse than a plain offset:**
  - `utils.ts:124-126` runs `new Cron(cron)` in the local zone.
  - `types.ts:411` then FORMATS that run in `matcher.timezone` (`:414-421`), so a 9:30 Kiritimati job shows a different hour.
  - `AutomationInfoPage.tsx:59,151-152` passes no zone.
  - The scheduler uses the zone (`shared/automations/utils.ts:358`).
- **Files:** the three above, plus `components/automations/__tests__/types.test.ts`.
- **Method:** re-apply 4 hunks.
- **Keep:** UA8.3 script summaries.
- **Not taken:** `CronBuilder.tsx:181` still computes in the local zone. This is upstream parity: v0.15.1 `CronBuilder.tsx:171` does the same, and our only caller is `playground/registry/automations.tsx:102`.
- **Tests:** upstream's two cases, copied with a source header. Negative: no timezone → the system zone, as the scheduler.
- **Runtimes:** runtime-neutral.
- **Done means:** the list summary, the info page and the scheduler agree on the hour.

**R7-04 `[sources]` A failed `source_test` is visible (S; ≡ B3-20 / B4-05 / its UB3.9; Phase 3). Confirmation plus one amendment.**
- **Confirmed:**
  - `git grep connectionStatus\|connectionError -- apps/electron/src/renderer` → 0 files. Positive control: the writer is in `packages/session-tools-core/src/handlers/source-test.ts`.
  - `capabilitySummaryConnectionStatus` (`source-status-indicator.tsx:311`) reads `SafeCapabilitySummary`, which has no test verdict.
- **Amendment to UB3.9 (detail page):** our `SourceInfoPage` renders through `components/info/CapabilityDetailTemplate.tsx` (`:157-169`), not `Info_Page.Hero`. So the verdict shows as an `Info_Alert` with `sourceInfo.connectionErrorTitle` in the template, raw text in `Info_TechnicalDetails`, and a pill in the hero `meta` (`Info_StatePill`). Upstream does the same in v0.15.1 `pages/SourceInfoPage.tsx:412-424`.
  - UB3.9 may land first with a plain `Info_Alert`. R7-07 and R7-09 then restyle it.
  - Keys: `sourceInfo.connectionErrorTitle`, `sourceInfo.technicalDetails`, `sourcesList.statusConnected` (en+ru).
- **Tests:** add to `components/ui/__tests__/source-status-indicator.test.tsx` and `components/info/__tests__/CapabilityDetailTemplate.test.tsx`. Positive: a stored `error` renders `failed` plus the alert. Negative: `untested` stays grey and shows no alert.
- **Runtimes:** runtime-neutral.

**R7-05 `[automations]` `[renderer]` A webhook's error and response body show again in the automation timeline (XS; NEW; Phase 4).**
- **Premise (read):**
  - Ours `hooks/useAutomations.ts:177-183` copies method, url, statusCode, durationMs and attempts, but drops `error` and `responseBody`.
  - `components/automations/types.ts` `WebhookDetails` has neither field.
  - `AutomationEventTimeline.tsx` neither renders nor copies them.
  - The host writes both, capped (`shared/automations/webhook-utils.ts:41,54`, `constants.ts:34`).
  - The removal came in `b0053399e` "fix: align displayed app version source", a bulk commit with no stated reason.
- **Upstream:** v0.13.4 and v0.15.1 `useAutomations.ts:180-188`, `types.ts` `WebhookDetails {error?, responseBody?}`, and the timeline's error row plus response `<pre>` and copy text.
- **Files:** `hooks/useAutomations.ts` (2 fields); `components/automations/types.ts`; `AutomationEventTimeline.tsx` (lands with R7-10's 1:1 take, or by itself first).
- **i18n:** `automations.webhookError`, `automations.webhookResponse` in en and ru. Both are absent in ours, present upstream.
- **Keep:** our `compactTimeLabel`/`renderRelativeTime`.
- **Tests:** new `components/automations/__tests__/webhook-details.test.tsx` (renderToStaticMarkup). Positive: an entry with `error` and `responseBody` renders both and the copy text contains `--- Response Body ---`. Negative: an entry without them renders no empty rows.
- **Runtimes:** runtime-neutral.
- **Done means:** a failed webhook shows why on the timeline.

### Phase 14 (look 1:1, our specifics kept)

**R7-06 `[design]` `[ui]` `packages/ui` leaf primitives and overlays 1:1 (M).**
- **Needs:** R1-tokens. Specifically: `popover-styled`, `motion-popover`/`motion-pop-in`, `bg-scrim`, `bg-floating`, `shadow-elev-*`, `min-h-row-menu`; `motion/presets` `TWEEN`/`DURATION`/`EASE`; `--accent-raw` from `theme-roles.ts`. Ours has 0 files with `--accent-raw`.
- **Upstream:** v0.15.1 `packages/ui/src/components/ui/{StyledDropdown,SimpleDropdown,drawer,BrowserControls,BrowserShader,index}.tsx`, `overlay/{FullscreenOverlayBaseHeader,ZoomControls,OverlayErrorBanner,MultiDiffPreviewOverlay}.tsx` and `src/index.ts`, plus the ADDED `ui/AnimatedCollapsibleContent.tsx`. Mechanisms:
  - `DrawerOverlay` becomes `forwardRef`, for Radix Presence exit.
  - Bottom sheets are inset 8px with a safe-area bottom divided by `--webui-css-zoom`.
  - BrowserShader reads `--accent-raw` hex at 70%.
  - `--shadow-color: var(--destructive)`.
- **Method:** take 1:1 for the 10 div-0 files. Re-apply on `MultiDiffPreviewOverlay.tsx` (1 line, at `:451` in ours) and on `src/index.ts`.
- **Keep:**
  - Our `src/index.ts` exports: `CraftLogo`→our logo, `formatToolDisplay`, the transcript-verbosity set (P6.469), `lib/diff-comments` (P6.306), and the removal of `LoadingIndicator` from the barrel.
  - MultiDiff P6.306 line comments.
  - A subpath export `./ui/AnimatedCollapsibleContent` in `packages/ui/package.json`. Reason: the barrel trap, see R6's note. Consumers: R6-02's `collapsible.tsx`, R3's `CollapsibleSection`, R5's `SettingsRadioGroup`.
- **Tests:**
  - New `packages/ui/src/components/ui/__tests__/browser-shader-accent.test.ts`. Positive: `#336699` → `[36,71,107]`. Negative: an empty or non-hex `--accent-raw` → no colour and no throw.
  - New `packages/ui/src/components/ui/__tests__/animated-collapsible.test.tsx`: closed renders nothing, open renders children.
  - Guard `packages/ui/src/__tests__/no-rgb-vars.test.ts`: `git grep -e 'var(--[a-z-]*-rgb)' -- packages/ui/src` is 0, with a positive control on a planted string.
- **Playground (dark):** `browser-ui`, the dropdown/menu registry, the drawer (compact) and the multi-diff overlay. **CDP (dark):** the diff overlay with an error banner.
- **Runtimes:** neutral.
- **Done means:** the files equal v0.15.1 modulo brand and the kept hunks; `typecheck:ui` is green.

**R7-07 `[design]` `[info]` Info primitives 1:1 plus the three new ones (M).**
- **Needs:** R1-tokens; R6-01 (`IconButton`, for `Info_FullscreenButton`); R5-01 (`Info_Page` imports `DETAIL_COLUMN_CLASS` from `components/settings/SettingsPage`); R6-03 (`Info_HeaderMenu`, exported from `index.ts`).
- **Upstream:** v0.15.1 `components/info/{Info_Alert,Info_Badge,Info_DataTable,Info_GroupedList,Info_Page,Info_Section,Info_StatusBadge,Info_Table,index}.tsx`, plus ADDED `Info_FullscreenButton`, `Info_StatePill`, `Info_TechnicalDetails`. API changes:
  - `Info_Page.Hero` gains `meta` and `actions`; the header carries actions only; the edge mask and `CHAT_LAYOUT` are dropped.
  - `Info_Section` gains `count`.
  - `Info_Badge` gains `dot`, and **`muted` now means outlined/code-like while `default` is the neutral fill**.
  - `Info_DataTable` exports `INFO_TABLE_HEADER_CLASS` and `INFO_TABLE_SORTABLE_HEADER_CLASS`.
  - `Info_Table` label column 120→140 (110 in a compact panel).
- **Method:** take 1:1 (all div 0 except `Info_GroupedList` at 6 and `index.ts` at 54). Re-point our 10 `Info_Badge color="muted"` callers by meaning:
  - Neutral status → `default`: `AutomationInfoPage.tsx:207,215`, `PermissionsDataTable.tsx:150,189`, `LabelsDataTable.tsx:108`.
  - Code-like → keep `muted`: `AutoRulesDataTable.tsx:69,135`, `PermissionsDataTable.tsx:116`, `ToolsDataTable.tsx:53` (becomes `<code>` upstream), `CapabilityPermissionsSection.tsx:58`, `AppearanceSettingsPage.tsx:87`.
- **Keep:**
  - `Info_GroupedList` imports `Spinner` from the `@nessy-agent/ui/ui/LoadingIndicator` subpath (P6.844).
  - `index.ts` keeps its Capability*, Plugin* and SourcesManagement* exports.
- **i18n:** `sourceInfo.technicalDetails` (en+ru).
- **Tests:** new `components/info/__tests__/info-primitives.test.tsx`. Positive: `<Info_Badge dot color="success">` renders the dot span; `Info_Page.Hero` with `meta` and `actions` renders both. Negative: `Info_StatePill tone="off"` still renders its label text, so state never relies on colour alone.
- **Playground (dark):** the Info states (loading, error, empty, hero, alert ×4, badges). **CDP (dark):** AutomationInfoPage and a Source info page.
- **Runtimes:** neutral.
- **Done means:** 1:1 modulo the kept hunks; `capability-info-pages.test.tsx` is green.

**R7-08 `[design]` `[info]` Info data tables (S).**
- **Needs:** R7-07. The `AutoRulesDataTable` semantic arms need UB6.8 (⏸).
- **Upstream:** v0.15.1 `{LabelsDataTable,ToolsDataTable,PermissionsDataTable,AutoRulesDataTable}.tsx`:
  - `Info_FullscreenButton` replaces the inline button.
  - The header classes change.
  - ToolsDataTable moves the access column last, renders a mono `<code>` name and a 2-line description.
  - LabelsDataTable adds `aria-expanded`/`aria-label` on the expander.
  - AutoRules gains `ruleValueText`: no template is shown on a plain label (pairs with UB4.11 / B4-03).
- **Method:**
  - Labels and Tools: take 1:1 (div 0).
  - Permissions: re-apply the restyle on ours (div 123).
  - AutoRules: ours equals v0.13.4 (div_vs_134 0). With UB6.8 landed, take v0.15.1. Otherwise re-apply the restyle plus `ruleValueText` reduced to `label.valueType ? rule.valueTemplate : undefined`. `isSemanticAutoLabelRule` does not exist in ours: `git grep` gives 0 hits; positive control: `packages/shared/src/labels/index.ts` has 5 exports.
- **Keep:** PermissionsDataTable `unenforceable`, `UnenforceableStyle` and `AccessCell` (P3.351, P6.209).
- **i18n:** `table.semanticRule` only with UB6.8.
- **Tests:** extend the existing `components/info/__tests__/` with a new `data-tables.test.tsx`. Positive: a plain label's auto-rule row shows "—" for the template. Negative: a valued label shows its `valueTemplate`. An `unenforceable` row with `annotate` keeps its sentence.
- **Playground (dark):** label/permission/tool tables and fullscreen.
- **Runtimes:** neutral.

**R7-09 `[design]` `[info]` Our-only detail components adopt the anatomy (M).**
- **Needs:** R7-07, R6-03.
- **Upstream:** none (ours). The pattern to follow is v0.15.1 `AutomationInfoPage.tsx` and `pages/SourceInfoPage.tsx`: header actions in `Info_HeaderMenu`, the name in the hero, `Info_Page.Hero` `meta`/`actions`.
- **Files:** `components/info/{CapabilityDetailTemplate,CapabilityResources,CapabilityContentPanel,CapabilityMcpToolsSection,CapabilityPermissionModesSection,CapabilityPermissionsSection,PluginComponentsSection,SourcesManagementRow,SourcesManagementRowList}.tsx` (1451 lines; 36 legacy-class hits on `text-foreground/`, `muted-foreground`, `shadow-minimal`, `rounded-[`).
  - `CapabilityDetailTemplate.tsx:158-169`: header `title` → hero; the origin badge → `meta`; the separate actions `div` → `actions`.
- **Method:** restyle onto the R1 role tokens; behaviour untouched.
- **Keep:** every behaviour (MCP tools state, permission modes, resources, plugin components, source management enablement and scope).
- **Tests:** the existing `components/info/__tests__/{CapabilityDetailTemplate,CapabilityMcpToolsSection,CapabilityPermissionSections,PluginComponentsSection,SourcesManagementRow}.test.tsx` stay green. Add one positive (the hero renders `actions` inside the hero row) and one negative (no header title is duplicated).
- **Playground (dark):** `capability-detail`. **CDP (dark):** Source, Skill and Plugin info pages.
- **Runtimes:** neutral (capability data per runtime is data, not branches).

**R7-10 `[design]` `[automations]` Automation surfaces 1:1 (M).**
- **Needs:** R7-07, R6-01, R6-03, R7-03, R7-05.
- **Upstream:** v0.15.1 `components/automations/{AutomationCard,AutomationAvatar,ActionTypeIcon,AutomationActionPreview,AutomationActionRow,AutomationEventTimeline,AutomationInfoPage,CronBuilder}.tsx`:
  - Role tints. The old `warning` colour becomes info/amber.
  - Badges become `Info_Badge`; the Test button becomes `Button secondary sm`; the copy button becomes `IconButton` with `automations.copyPayload` (ours has the key).
  - CronBuilder uses `field-surface` and `aria-invalid`, and its presets get `aria-pressed`.
  - The info-page menu moves to `Info_HeaderMenu`; edit actions move into the hero.
- **Method:**
  - Card and Avatar: take 1:1 (div 0).
  - Every other file: re-apply the restyle on ours.
- **Keep:**
  - UA8.3 script action: `ActionTypeIcon` `script` → `SquareTerminal`, the preview's script arm, `ScriptActionDetails` with approve-by-digest, and the info page's `approveScript`.
  - `getManagedEditConfig` (managed edit, not a raw `automations.json` path).
  - `getPermissionDisplayName(mode, t)`.
  - CronBuilder i18n `labelKey`s (UA12.214).
  - Timeline `compactTimeLabel`/`renderRelativeTime`.
  - The "skipped" status (UB4.8).
  - Telegram-topic rows stay removed (messaging removed).
- **Tests:** existing `components/automations/__tests__/{script-action-row,relative-time-label,types}.test.ts*` stay green. New positive: a preset button renders `aria-pressed="true"` for the active cron. Negative: an invalid cron sets `aria-invalid` and shows the message.
- **Playground (dark):** `registry/automations.tsx` (card, timeline with webhook details, info page, CronBuilder valid and invalid). **CDP (dark):** the automation info page.
- **Runtimes:** neutral.

**R7-11 `[design]` `[renderer]` Small renderer pieces: hooks, `cn`, pre-paint script, tooltip delay, directory browser (S).**
- **Needs:** R1-tokens (`./utils`, `./motion`, `--dur-fast`); R3-01 (tooltip timing); R4 (its `ActiveOptionBadges` row drops `useDynamicStack`); R2 (`SessionList` consumes `useListReorderFlip`); R6-01 (`skeleton` consumes `useDelayedLoading`; Button `size="lg"`/`primary`/`ghost`).
- **Upstream:** v0.15.0:
  - `hooks/useContainerWidth.ts` measures first in a layout effect (no cold-load reflow).
  - `useResizeGradient.ts` reads the `--dur-fast` token.
  - ADDED `hooks/useDelayedLoading.ts` (200 ms delay, 400 ms minimum) and `hooks/useListReorderFlip.ts`.
  - DELETED `hooks/useDynamicStack.ts`.
  - `lib/utils.ts` becomes `export { cn } from '@craft-agent/ui/utils'`.
  - `index.html` gets the pre-paint dark-mode script.
  - `App.tsx` uses `<TooltipProvider>` without `delayDuration={0}`.
  - `components/ServerDirectoryBrowser.tsx` is restyled.
- **Method:**
  - `useContainerWidth`, `useResizeGradient`, `lib/utils` (all div 0): take 1:1.
  - Add the two hooks.
  - Delete `useDynamicStack.ts`. Its only caller is `components/app-shell/ActiveOptionBadges.tsx` (`git grep`; positive control: the hook file itself matches).
  - `index.html`: re-apply the script.
  - `App.tsx`: drop the `delayDuration={0}` at `:2164` in R3-01's commit. Without this, R3-01's 500/300 ms timing is overridden.
  - `ServerDirectoryBrowser`: re-apply the restyle.
- **Keep:**
  - Pre-paint key `nessy-theme` (`lib/local-storage.ts:6` `PREFIX = 'nessy-'`, `:33` `theme`).
  - Our CSP without `'unsafe-eval'` and our `<title>`.
  - `ServerDirectoryBrowser`: `validateProjectDirectory` → `IssuedProjectHandle`, `getServerHomeDir`, `projects.serverBrowserGo`.
  - `provider-icons.ts`: unchanged (the Cloudflare entry is DROP-a).
- **Tests:**
  - New `hooks/__tests__/useDelayedLoading.test.ts` with fake timers. Positive: a 300 ms load shows for at least 400 ms. Negative: a 150 ms load never shows.
  - New `hooks/__tests__/useListReorderFlip.test.ts`. Positive: a pure reorder is `enabled`. Negative: an added row disables it.
  - `index.html` pre-paint: a jsdom-free string test that the script reads `nessy-theme`.
- **Playground (dark):** primitives (skeleton). **CDP (dark):** a cold launch in dark mode shows no light flash. Screenshot the first frame after reload.
- **Runtimes:** neutral.

**R7-12 `[docs]` Bundled agent docs for v0.15.x (XS; rides the behaviour rows).**
- **Upstream:** v0.15.0 `resources/docs/{automations,labels,pages}.md`; v0.15.1 `{browser-tools,sources}.md`.
- **Method per page:**
  - **`automations.md`: take now.** The 2 hunks state that `LabelAdd`/`LabelRemove` match the label ENTRY (`id::value`). This is already our behaviour: `automation-system.ts:671-679` emits each entry string, and `automations/utils.ts:89-91` matches `data.label`. Our page still says "Label ID" (`automations.md:61-62,265`).
  - **`labels.md`:** hunks 1–6 land in UB4.11's (B4-03) commit. The semantic-rule `value` hunk waits for UB6.8. Our page has no semantic section: `grep -i semantic` → only `:166` "semantic colors".
  - **`sources.md`:** adapted paragraph, in the OQ-B4-2(c) prompt-tools row's commit. It names our resource tools (Claude/codex native; Pi `list_mcp_resources`/`read_mcp_resource`) and the new host `source_list_prompts`/`source_get_prompt`. It drops upstream's "`<sources>` notes once per session" sentence (B4-06 DROP-c).
  - **`browser-tools.md`:** COVERED-BY B5-10.
  - **`pages.md`:** N/A. Upstream's added sentence is Claude-artifact publishing (DROP-b), and our page is our own text (div 438).
- **Keep:** `$NESSY_LABEL`; our page wording.
- **Tests:** `scripts/docs-integrity.test.ts` stays green. Negative: `rg 'source_list_resources'` over `resources/docs` is 0, because that is upstream's name, not ours.
- **Runtimes:** the docs are read by all three runtimes.

**R7-13 `[webui]` `[viewer]` Dormant apps: only what the gates need (XS).**
- **Method:**
  - `apps/webui/src/adapter/web-api.ts`: add `getWindowVibrancy: () => null` in R7-01's commit. `typecheck:webui` is in `typecheck:chain` (P6.738).
  - `apps/viewer/src/App.tsx` (div 4) and `main.tsx` (div 0, `MotionPreferenceProvider`): take 1:1 after R1's `./motion` export lands. This is cheap and keeps the viewer on the tokens.
  - Everything else is N/A: `webui/App.tsx` `?ws=` deep link (needs a server half we do not run), `login.html` (−214), `vite.config.ts` `renderBuiltUrl`, the webui OAuth join in `web-api.ts` (UB3.10 covers electron only), `index.html`, and both `package.json` versions.
- **Tests:** `bun run typecheck:webui` and `typecheck:viewer` green.
- **Runtimes:** neutral.

**R7-14 `[i18n]` Extend the plan's section I with the v0.15.x key ledger (XS; governance).**
- Add the §6 owner table to the plan's "I. i18n by owning row". Each owning row commits its keys first (en+ru, `lint:i18n:parity`/`sorted` green).
- Delete the 9 upstream-removed keys only in the background-task chip row (UB9.8 + R2). Their live callers: `TaskActionMenu.tsx`, `task-output.ts` and their tests.
- `chat.newChatSubtitle` is rebranded ("Craft Agents" → Nessy).
- **Done means:** every needed key has exactly one owning row.

## 3. Functional changes hidden in these files

| Where (upstream) | Change | Ours | Owner |
| --- | --- | --- | --- |
| v0.15.0 `main/window-manager.ts`, `preload/bootstrap.ts` | Mica only at build ≥ 22621; material passed to the renderer | Bug present (`window-manager.ts:34-50`) | R7-01 |
| v0.15.0 `App.tsx` | `theme.json` overrides move into ThemeProvider | Bug present (`App.tsx:339,414,831,836`) | R7-02 |
| v0.15.0 `automations/utils.ts`, `types.ts`, `AutomationInfoPage.tsx` | Next run in the automation's zone | Bug present (`utils.ts:124-126`, `types.ts:411`) | R7-03 |
| v0.13.4+ `useAutomations.ts`, `AutomationEventTimeline.tsx` | Webhook error and response body shown | Dropped (`useAutomations.ts:177-183`) | R7-05 (new) |
| v0.15.0 `App.tsx`, `atoms/sessions.ts`, `event-processor/{processor,types}.ts` | `task_activity` updates a chip with no watchdog reset; `stopping` state | Absent (`ToolResultEvent`/`AgentEvent` lack it) | UB9.8 (B4-01) renderer half; chip row (R2) |
| v0.15.0 `hooks/useBackgroundTasks.ts` | `stopTask` with "Stopping…" plus a 15 s confirm; `dismissTask` | Ours differs: L9 routes plus failure-key map (`useBackgroundTasks.ts:36-91`); Stop is HAVE (B4-01) | Keep ours; adopt `stopping`/`dismiss` only in the chip row |
| v0.15.1 `event-processor/handlers/tool.ts`, `types.ts` + test | `tool_result.toolInput` replaces the start input (password redaction) | Absent (`types.ts` `ToolResultEvent` has no `toolInput`) | B5-07 |
| v0.15.1 `preload/bootstrap.ts`, `webui/web-api.ts` | One sign-in per source: join, restart, deadline | Absent (`bootstrap.ts:329` own runner) | UB3.10 (B4-10) |
| v0.15.0 `NavigationContext.tsx` | Cold-load `?route=` deep link not replaced | HAVE: UA12.179 (`:1157-1169`, `:1431`) | none |
| v0.15.0 `App.tsx` | Tooltip delay back to the provider default (500/300 ms) | `delayDuration={0}` at `App.tsx:2164` would override R3-01 | R7-11 with R3-01 |
| v0.15.0 `hooks/useContainerWidth.ts` | First width in a layout effect (no compact reflow) | div 0 | R7-11 |
| v0.15.0 `info/AutoRulesDataTable.tsx` | Plain label shows no template or value | Pre-fix | R7-08 / UB4.11 |
| v0.15.0 `packages/ui/.../BrowserShader.tsx` | Accent read from `--accent-raw` | `--accent-raw` defined nowhere in ours (0 files) | R7-06 needs R1 |
| v0.15.0 tokens (all files) | Every `--*-rgb` variable removed (22 → 0 defs, same `git grep`) | 22 defs; 20 files read them, only `playground/registry/runtime-switch.tsx` is ours-only | R1 (sweep the merged files in the same wave); R7-06 guard |
| v0.15.0 `docs/automations.md` | LabelAdd matches the entry `id::value` | Already the behaviour; doc stale | R7-12 |
| v0.15.0 `types.ts` summary | — (upstream also English) | `deriveAutomationSummary` "Next run:"/"Cron:" English in ru UI (`types.ts:422,425`) | Residue, upstream parity; not a row |

## 4. Our specifics to keep (in these files)

- **Script automations (UA8.3):** the `script` icon and preview, `ScriptActionDetails` with approve-by-digest, and the info page's `approveScript`.
- **Managed edit config** on the automation info page (`getManagedEditConfig`).
- **i18n:** CronBuilder `labelKey`s (UA12.214); the timeline's `compactTimeLabel`/`renderRelativeTime`; `getPermissionDisplayName(t)`.
- **Messaging stays removed:** the Telegram-topic rows and the supergroup fetch.
- **PermissionsDataTable** `unenforceable` / `UnenforceableStyle` / `AccessCell` (P3.351, P6.209).
- **The `info/` barrel's 9 our-only exports**; `Info_GroupedList`'s subpath `Spinner` (P6.844).
- **`packages/ui/src/index.ts` our exports** (verbosity P6.469, diff comments P6.306, logo, `formatToolDisplay`); MultiDiff line comments.
- **ServerDirectoryBrowser** project-handle validation and the server home dir.
- **NavigationContext** UA12.179 guards (do not take upstream's shape over them).
- **`useBackgroundTasks`** L9 stop routes and failure-key map.
- **`index.html`:** CSP without `'unsafe-eval'`, our title, pre-paint key `nessy-theme`. The window argument is named `--nessy-window-vibrancy`. Style id `nessy-theme-overrides`.
- **Drops stay dropped:** the Cloudflare provider icon (DROP-a), Claude-artifact keys and docs (DROP-b), Slack/Microsoft auth titles.

## 5. Per-path disposition (all 80 assigned paths)

"div" is our file against upstream v0.14.1, from divergence.json. "Δ" is upstream v0.14.0→v0.15.1 (+/−) with its release.

| # | Path | div | Δ (release) | Disposition | Row |
| --- | --- | --- | --- | --- | --- |
| 1 | `resources/docs/automations.md` | 197 | +3/−3 (0.15.0) | Re-apply 2 hunks now (describes current behaviour) | R7-12 |
| 2 | `resources/docs/browser-tools.md` | 6 | +7/−4 (0.15.1) | COVERED-BY B5-10 | — |
| 3 | `resources/docs/labels.md` | 53 | +7/−5 (0.15.0) | Re-apply with UB4.11; semantic hunk with UB6.8 | R7-12 |
| 4 | `resources/docs/pages.md` | 438 | +1/−1 (0.15.0) | N/A (DROP-b; our own page) | — |
| 5 | `resources/docs/sources.md` | 109 | +9 (0.15.1) | Adapt to our tool names; with OQ-B4-2(c) row | R7-12 |
| 6 | `src/main/window-manager.ts` | 207 | +15/−13 (0.15.0) | Re-apply 3 hunks | R7-01 |
| 7 | `src/preload/bootstrap.ts` | 313 | +8 (0.15.0), +49/−18 (0.15.1) | Vibrancy hunk → R7-01; OAuth runner → UB3.10 | R7-01, UB3.10 |
| 8 | `renderer/App.tsx` | 827 | +32/−18 (0.15.0) | Per-hunk: theme → R7-02; task_activity/stopping → UB9.8; Tooltip → R7-11 | R7-02, R7-11, UB9.8 |
| 9 | `renderer/atoms/label-value-edit.ts` | ADDED | +24 (0.15.0) | Add with R2's ChatHeaderLabels row (+R4 ChatInputZone) | R2 (B4-02) |
| 10 | `renderer/atoms/sessions.ts` | 380 | +4 (0.15.0) | Re-apply `activity`/`stopping` into our differing `BackgroundTask` | UB9.8 / chip row |
| 11 | `components/ServerDirectoryBrowser.tsx` | 84 | +20/−19 (0.15.0) | Re-apply restyle | R7-11 |
| 12 | `automations/ActionTypeIcon.tsx` | 6 | +1/−1 | Take + script arm | R7-10 |
| 13 | `automations/AutomationActionPreview.tsx` | 4 | +3/−3 | Take + script arm | R7-10 |
| 14 | `automations/AutomationActionRow.tsx` | 96 | +26/−26 | Re-apply restyle; keep ScriptActionDetails | R7-10 |
| 15 | `automations/AutomationAvatar.tsx` | 0 | +14/−12 | Take 1:1 | R7-10 |
| 16 | `automations/AutomationCard.tsx` | 0 | +15/−17 | Take 1:1 | R7-10 |
| 17 | `automations/AutomationEventTimeline.tsx` | 31 | +39/−40 | Take + our time label; restores webhook details | R7-10, R7-05 |
| 18 | `automations/AutomationInfoPage.tsx` | 58 | +34/−33 | Re-apply; timezone hunk | R7-10, R7-03 |
| 19 | `automations/CronBuilder.tsx` | 47 | +20/−27 | Re-apply restyle; keep i18n keys | R7-10 |
| 20 | `automations/__tests__/types.test.ts` | 44 | +24 | Add the 2 timezone cases | R7-03 |
| 21 | `automations/types.ts` | 111 | +1/−1 | Re-apply 1 hunk | R7-03 |
| 22 | `automations/utils.ts` | 84 | +5/−2 | Re-apply `computeNextRuns(tz)` | R7-03 |
| 23 | `info/AutoRulesDataTable.tsx` | 50 (=v0.13.4) | +25/−32 | Restyle + plain-label arm; semantic with UB6.8 | R7-08 |
| 24 | `info/Info_Alert.tsx` | 0 | +24/−12 | Take 1:1 | R7-07 |
| 25 | `info/Info_Badge.tsx` | 0 | +17/−48 | Take 1:1; re-point 10 `muted` callers | R7-07 |
| 26 | `info/Info_DataTable.tsx` | 0 | +11/−4 | Take 1:1 | R7-07 |
| 27 | `info/Info_FullscreenButton.tsx` | ADDED | +30 | Add (needs R6-01) | R7-07 |
| 28 | `info/Info_GroupedList.tsx` | 6 | +11/−11 | Take; keep subpath Spinner | R7-07 |
| 29 | `info/Info_Page.tsx` | 0 | +34/−31 | Take (needs R5-01) | R7-07 |
| 30 | `info/Info_Section.tsx` | 0 | +16/−8 | Take 1:1 | R7-07 |
| 31 | `info/Info_StatePill.tsx` | ADDED | +42 | Add | R7-07 |
| 32 | `info/Info_StatusBadge.tsx` | 0 | +3/−2 | Take 1:1 | R7-07 |
| 33 | `info/Info_Table.tsx` | 0 | +9/−12 | Take 1:1 | R7-07 |
| 34 | `info/Info_TechnicalDetails.tsx` | ADDED | +36 | Add | R7-07 |
| 35 | `info/LabelsDataTable.tsx` | 0 | +15/−23 | Take 1:1 | R7-08 |
| 36 | `info/PermissionsDataTable.tsx` | 123 | +15/−27 | Re-apply; keep unenforceable | R7-08 |
| 37 | `info/ToolsDataTable.tsx` | 0 | +21/−18 | Take 1:1 | R7-08 |
| 38 | `info/index.ts` | 54 | +9 | Re-apply 4 exports; keep ours | R7-07 |
| 39 | `contexts/NavigationContext.tsx` | 408 | +16/−6 | HAVE (UA12.179); keep ours | none |
| 40 | `event-processor/handlers/__tests__/tool-result-input.test.ts` | ADDED | +62 (0.15.1) | COVERED-BY B5-07 | — |
| 41 | `event-processor/handlers/tool.ts` | 23 | +2 (0.15.1) | COVERED-BY B5-07 | — |
| 42 | `event-processor/processor.ts` | 156 | +3/−2 | With UB9.8 (`task_activity` no-op) | UB9.8 |
| 43 | `event-processor/types.ts` | 283 | +16 (0.15.0), +2 (0.15.1) | `TaskActivityEvent` → UB9.8; `toolInput` → B5-07 | UB9.8, B5-07 |
| 44 | `hooks/useBackgroundTasks.ts` | 201 | +43/−22 | Keep ours; `stopping`/`dismiss` via chip row | UB9.8 / R2 |
| 45 | `hooks/useContainerWidth.ts` | 0 | +12/−3 | Take 1:1 | R7-11 |
| 46 | `hooks/useDelayedLoading.ts` | ADDED | +42 | Add | R7-11 |
| 47 | `hooks/useDynamicStack.ts` | DELETED | −185 | Delete after R4 drops the only caller | R7-11 |
| 48 | `hooks/useListReorderFlip.ts` | ADDED | +53 | Add (needs R1 motion; consumer R2) | R7-11 |
| 49 | `hooks/useResizeGradient.ts` | 0 | +2/−2 | Take 1:1 | R7-11 |
| 50 | `renderer/index.html` | 4 | +9 | Re-apply pre-paint (`nessy-theme`); keep CSP and title | R7-11 |
| 51 | `renderer/lib/provider-icons.ts` | 81 | +1 | N/A (Cloudflare, DROP-a) | — |
| 52 | `renderer/lib/utils.ts` | 0 | +2/−6 | Take after R1 `./utils` | R7-11 |
| 53 | `apps/viewer/package.json` | 4 | version | N/A (our versions) | — |
| 54 | `apps/viewer/src/App.tsx` | 4 | +4/−2 | Take (cheap) | R7-13 |
| 55 | `apps/viewer/src/main.tsx` | 0 | +4/−1 | Take after R1 `./motion` | R7-13 |
| 56 | `apps/webui/package.json` | 2 | version | N/A | — |
| 57 | `apps/webui/src/App.tsx` | 0 | +6/−2 | N/A (dormant; `?ws=` needs a server half) | — |
| 58 | `apps/webui/src/adapter/web-api.ts` | 129 | +1 (0.15.0), +44/−8 (0.15.1) | `getWindowVibrancy` stub only (typecheck); OAuth join N/A | R7-13 |
| 59 | `apps/webui/src/index.html` | 4 | +9 | N/A (dormant) | — |
| 60 | `apps/webui/src/login.html` | 4 | +15/−214 | N/A (dormant) | — |
| 61 | `apps/webui/vite.config.ts` | 2 | +22 | N/A (dormant) | — |
| 62 | `i18n/locales/de.json` | — | +127/−14 | N/A (en+ru only) | — |
| 63 | `i18n/locales/en.json` | 2608 | +127/−14 | Key ledger §6; keys land in their owning rows | R7-14 |
| 64 | `i18n/locales/es.json` | — | +127/−14 | N/A | — |
| 65 | `i18n/locales/hu.json` | — | +127/−14 | N/A | — |
| 66 | `i18n/locales/ja.json` | — | +127/−14 | N/A | — |
| 67 | `i18n/locales/pl.json` | — | +137/−14 | N/A | — |
| 68 | `i18n/locales/zh-Hans.json` | — | +127/−14 | N/A | — |
| 69 | `ui/overlay/FullscreenOverlayBaseHeader.tsx` | 0 | +5/−7 | Take 1:1 | R7-06 |
| 70 | `ui/overlay/MultiDiffPreviewOverlay.tsx` | 196 | +1/−1 | Re-apply 1 line; keep P6.306 | R7-06 |
| 71 | `ui/overlay/OverlayErrorBanner.tsx` | 0 | +2/−2 | Take 1:1 | R7-06 |
| 72 | `ui/overlay/ZoomControls.tsx` | 0 | +1/−3 | Take 1:1 | R7-06 |
| 73 | `ui/ui/AnimatedCollapsibleContent.tsx` | ADDED | +32 | Add + subpath export | R7-06 |
| 74 | `ui/ui/BrowserControls.tsx` | 0 | +4/−3 | Take 1:1 | R7-06 |
| 75 | `ui/ui/BrowserShader.tsx` | 0 | +6/−8 | Take (needs `--accent-raw`) | R7-06 |
| 76 | `ui/ui/SimpleDropdown.tsx` | 0 | +1/−3 | Take 1:1 | R7-06 |
| 77 | `ui/ui/StyledDropdown.tsx` | 0 | +18/−32 | Take 1:1 | R7-06 |
| 78 | `ui/ui/drawer.tsx` | 0 | +27/−23 | Take 1:1 | R7-06 |
| 79 | `ui/ui/index.ts` | 0 | +1 | Take 1:1 | R7-06 |
| 80 | `packages/ui/src/index.ts` | 28 | +9 | Re-apply (+motion R1, +RunCommand R3-02, +AnimatedCollapsible); keep ours | R7-06 |

## 6. i18n key delta (en.json, upstream v0.14.0 → v0.15.1)

**Upstream totals.** Upstream en grows from 1866 to 1979 keys: +124 added, −11 removed, 3 changed. Of the 124 added, 3 arrived in 0.14.1, 116 in 0.15.0 and 5 in 0.15.1.

**Against ours.**
- 6 of the 124 added keys are already in our en and ru (`chat.conversationCompacted`, `chat.noRenderableMessages(+Hint)`, two `onboarding.providerSelect.*`, `turnCard.preparingResponse`). **118 are missing.**
- The 3 changed keys (`settings.ai.decisions.feature{AdaptiveThinkingTooltip,LargeResultsDesc,LargeResultsTooltip}`) are absent in ours. They belong to UB6 (⏸), so there are 0 edits now.
- Of the 11 removed keys, 9 are still in ours with live callers (`chat.clickForTaskActions`, `chat.stopTask`, `chat.taskStatus{Done,Failed,Stopped}`, `chat.taskType{Agent,Shell,Workflow}`, `toast.failedToLoadTaskOutput`). They are deleted with the chip row.
- `chat.noOutputYet` and `chat.taskStatusOrphaned` are already absent.

**Needed keys by owning row (118):**

| Owner | Keys | Notes |
| --- | --- | --- |
| R3 (turnCard 14, datatable 3, preview 2, overlay 1, chat.warning, chat.runCommand* 2) | 23 | |
| R3-08 / new-chat states (`chat.newChat*` 2, `chat.suggestions.*` 12, `session.empty*` 4) | 18 | `chat.newChatSubtitle` rebrand |
| R3 AuthRequestCard (`chat.authCard.*`, incl. `restartSignIn` for UB3.10) | 13 | |
| Chip row (B4-01 / UB9.8 + R2): `chat.backgroundTask.*` | 22 | |
| R2 (`session.*` 7, `chat.moreLabels_*` 4, `chat.statusButton`, `sidebar.*` 2, `automations.selectAutomation`) | 15 | |
| R5-08 (`settings.appearance.motion*`) | 4 | |
| R5/R6-09 (`common.hide`, `common.show`) | 2 | |
| R4-04 (`chat.credentials.*`) | 3 | |
| UB4.14 / B4-20 (`toast.attachment*`) | 4 | |
| UB3.9 + R7-07 (`sourceInfo.connectionErrorTitle`, `sourceInfo.technicalDetails`, `sourcesList.statusConnected`) | 3 | |
| UB6 ⏸ (`settings.ai.decisions.usage*`) | 3 | conditional |
| N/A: `chat.authCard.title{Slack,Microsoft}` (removed surfaces) | 2 | |
| N/A: `pages.claudeArtifact.*` 4 + `toast.pageClaudeArtifact*` 2 (DROP-b) | 6 | |

**What we must add:**
- **en: 110 keys** (118 − 8 N/A), of which 3 are conditional on UB6.
- **ru: 120 keys.** That is the same 110, plus `_few`/`_many` for the 5 new plural bases that ship only `_one`/`_other` in en: `chat.backgroundTask.steps`, `turnCard.failedCount`, `stepCount`, `stepsCompletedCount`, `subagentContinued`. `chat.moreLabels` already ships all four forms in en.
- Our ru carries 88 `_few` keys against 54 in en, so this matches house convention.

**Outside this slice's delta:** `automations.webhookError` and `automations.webhookResponse` (R7-05) are older upstream keys that ours lacks. Overall, upstream v0.15.1 has 540 en keys absent from ours. Most are older and handled by the draft's section I or N/A (messaging, etc.). This report counts only the v0.14.0→v0.15.1 delta.

## 7. Coverage

- **All 80 assigned paths have a disposition (§5).**
- **What was read:**
  - All 73 non-foreign-locale diffs were read in full.
  - The 6 foreign locales: numstat only. They are N/A by owner decision (7).
  - en.json was read as a JSON key diff, not line by line.
  - Our side, for the 20 diverged files: brand-normalised hunks.
  - Spot reads at HEAD for every claim cited with a line number.
- **Rows taken from other readers, not re-derived:**
  - B3-17, B3-20 and B3-21 (Windows window, failed source test, `theme.json`).
  - B4-01, B4-02, B4-03, B4-04, B4-05, B4-06, B4-08, B4-10 and B4-20.
  - B5-06, B5-07 and B5-10.
  - R3-01, R3-02, R3-08 and R3-09.
  - R5-01, R5-08.
  - R6-01, R6-02 and R6-03.
- **Not done:**
  - No build, test or typecheck was run (read-only brief).
  - The Windows defect is confirmed from code, not on a Windows machine. The upstream mechanism comes from upstream's comment: medium-high confidence.
  - R7-05's "accidental" verdict rests on commit `b0053399e`'s subject and scope: medium confidence. An owner who removed it on purpose should say so, and the row then closes as a recorded divergence.
- **Positive controls used:**
  - `connectionStatus`: renderer 0 files, writer present.
  - `isSemanticAutoLabelRule`: 0 hits, against `labels/index.ts` exports.
  - `--accent-raw`: ours 0 files, upstream 3.
  - `--*-rgb` definitions: v0.14.0 22 vs v0.15.1 0.
  - `useDynamicStack` callers: the hook file itself matches.
  - CronBuilder callers: playground only.
