# R2 — App shell and navigation: upstream v0.14.0 → v0.15.1 (input for the 1.43.0 plan, Phase 14)

Reader R2, read-only, 2026-10-14. Our tree: `feat/TCODE-000-1-41-0` at `f495cf311`, working tree untouched. Upstream: `.references/craft-agents-oss`, read by tag only.

Instruments (scratch: `scratchpad/r2/`, `scratchpad/r2o/`):
- every assigned path's `git diff v0.14.0 v0.15.1` (`*.updiff`);
- a logic-only diff that strips strings, comments and whitespace (B3's `b3_fdiff.py`, retargeted to v0.14.0→v0.15.1: `fdiff140.py`);
- our file vs v0.14.1 after brand normalisation (`r2_ours.sh` → `r2o/*.diff`);
- B3's 3-way merge simulation (`B3-merge.tsv`: conflict hunks / lines);
- an import-existence check over every ADDED file (`added-imports.txt`);
- an i18n lookup of every key the v0.15.1 files use against our `en.json`/`ru.json` (`r2_keys.py`), split by whether the key already existed upstream at v0.14.0.

**Release placement.** Measured with `git diff --numstat` per tag pair over all 94 paths:
- v0.14.0→v0.14.1 touches one path: `LeftSidebar.tsx`, the one-line truncate plus hover title for long names.
- v0.15.0→v0.15.1 touches one path: `TaskEditor.tsx`, the generate timeout constant.
- Everything else is the v0.15.0 "A new look".

---

## 1. Summary

- **The shell was taken apart, not restyled.**
  - `AppShell.tsx` loses its sidebar, filter menu and resize handles to `SidebarPane`, `SessionFilterMenu` (1112 new lines) and `ShellResizeHandle`.
  - The session header leaves `ChatPage.tsx` for five new `chat-header/*` files.
  - `ChatDisplay.tsx` sheds `ProcessingIndicator`, `ScrollOnMount` and `TurnFrame`.
  - `TaskActionMenu.tsx` is deleted in favour of `BackgroundTaskChip.tsx`.
- **The look:**
  - navigator canvas with ONE paper card joining list and first panel, with FLIP panel motion;
  - a pinned sidebar footer and a "Workspace" section header;
  - session rows on one grid: status glyph, then the title (bold when unread, accent dot), then a run-state line;
  - "+N" expands labels in place;
  - status, labels and actions move into the chat header, so the label row above the composer is gone;
  - board, pages and detail pages are restyled.
- **Functional changes hidden in it** (section 3, 43 items). The biggest:
  - background-task chips with a live card (Open, Copy, Stop, Dismiss);
  - new-chat suggestions;
  - Run-in-background wiring;
  - compact-board drag targeting (B3-22);
  - an automations empty-state bug that is **present in ours** (`MainContentPanel.tsx:467`);
  - the v0.14.1 sidebar truncate, **missing in ours** (`LeftSidebar.tsx:537`).
- **Divergence is concentrated in the shell hub files:**
  - `AppShell` 1266 of 4282 lines, `ChatDisplay` 2268, `ChatPage` 468 and `ActiveOptionBadges` 279 are ours.
  - So are our capability-catalog rewrites of `SourceInfoPage` / `SkillInfoPage` / `SourcesListPanel` / `SkillsListPanel` / `SessionFilesSection`.
  - Of the 94 paths, 24 are upstream-ADDED, 1 upstream-DELETED (`TaskActionMenu`), 1 absent in ours by design (`pages/ShortcutsPage.tsx`), and 18 are within 5 lines of v0.14.1 (taken 1:1).
- **20 proposed rows** (R2-01…R2-20, each ≤ L). They need the Phase 13 foundations first:
  - R1 tokens, motion, `CHAT_LAYOUT` and the playground;
  - the R6 primitives (`IconButton`, `HotkeyKeycaps`, `EntityRow` slots, label chips, `useToastAnchor`, `Info_HeaderMenu`);
  - the R7 hooks and atoms (`useDelayedLoading`, `useListReorderFlip`, `label-value-edit`, `useBackgroundTasks`, the `BackgroundTask` fields).
- **Every specific of ours is named per file in section 4.** Owner questions: none. The three defaults taken are stated in section 6.

## 2. Proposed rows

Rows are dependency-ordered. Cross-reader ids (`R1`, `R3`, `R4`, `R6`, `R7`, `B4`) are the sibling readers' rows; the controller maps them to UB ids.

Each row adds its own i18n keys in **en + ru**, keys first. Every visual row's playground states come from R1's registry row and are swept in DARK theme. The live arm of every row is R2-20.

Hot files (`AppShell.tsx`, `ChatDisplay.tsx`, `ChatPage.tsx`) are touched by sequential rows of ONE lane. Each such row re-anchors the ledger's line citations and runs `bun run lint:ledger-citations`. Measured: the five ledger-guard documents cite `AppShell.tsx` 5×, `ChatDisplay.tsx` 8×, `ChatPage.tsx` 3×, `SessionList.tsx` 3× and `MainContentPanel.tsx` 1× by line (`grep -o '<file>:[0-9]+'` over the documents `check-ledger-citations.ts:295,359-362` lists).

**R2-01 `[ui]` `[design]` Shell leaf files 1:1 (S).**
- **Needs:** R1 tokens and motion (`@nessy-agent/ui/motion` `SPRING.panel`, `h-row-sidebar`, `text-label*`, `duration-micro`, `bg-fill-hover`); R6-01 (`ui/hotkey-keycaps.tsx`, ADDED there, used by `DetailEmptyState`).
- **Upstream (v0.15.1):**
  - ADDED: `app-shell/fit-labels.ts` with `__tests__/fit-labels.test.ts`, `ShellResizeHandle.tsx`, `DetailEmptyState.tsx`, `chat-display/strip-repeated-title.ts` with its test (its reader is R3-08's `ErrorMessage`).
  - Near-clean files:
    - `panel-constants.ts` (`RADIUS_INNER` 10→12);
    - `SessionMenuParts.tsx`;
    - `SessionSearchHeader.tsx` (close button `type="button"` + `aria-label`);
    - `ProjectMultiSelectFilter.tsx`;
    - `SessionProjectColorWrapper.tsx` (B3-26: stripe under sticky headers);
    - `FabNewChat.tsx`;
    - `CompactPanelTransition.tsx` (`SPRING.panel`, `MotionConfig`);
    - `SessionStatusIcon.tsx` (24px hit area).
- **Method:** add or take 1:1, with the provenance header (`/* Copied from v0.15.1:<path> … Apache-2.0 */`) as on our UA-era copies.
- **Keep:**
  - `SessionStatusIcon.tsx`: our `<span role="button">`, a nested-button fix. Upstream still renders a `<button>` inside EntityRow's row `<button>`.
  - `CompactPanelTransition.tsx`: P6.473 `usePrefersReducedMotion` (our Motion setting above the OS query), unless R1's `MotionPreferenceProvider` carries the same setting, in which case take upstream's `MotionConfig`.
  - `FabNewChat.tsx`: our `shadow-strong` until R1's lint row admits upstream's shadow vocabulary (`nessy-styles/no-nonstandard-shadows` is `error`, `apps/electron/eslint.config.mjs:152`).
- **Tests:**
  - Copy `fit-labels.test.ts` and `strip-repeated-title.test.ts`. Each has positive cases (fits N chips; strips "Title: Title body") and boundary cases (zero width; a title that is not repeated is kept).
  - `SessionStatusIcon.test.tsx` stays green. Its negative: no `<button>` inside the row button.
  - Run as `bun test ./<path>` and read the FILE COUNT.
- **Runtimes:** neutral.
- **Done means:** the added files equal v0.15.1 apart from the rebrand and the header; both tests pass.

**R2-02 `[ui]` `[design]` `[motion]` Panel stack: navigator canvas, joined paper card, FLIP panel motion, toast anchor (M).**
- **Needs:**
  - R2-01;
  - R1 motion (`FlipOnChange`, `cancelFlip`, `cancelSlideOut`, `playSlideX`, `SPRING`);
  - R6-02 (`useToastAnchor` in `ui/sonner.tsx`, imported by `PanelStackContainer`).
- **Upstream:**
  - v0.15.1 `PanelStackContainer.tsx` (+189/−88):
    - the sidebar sits flush on the canvas;
    - the navigator and the first content panel share ONE paper card, and further panels get their own;
    - collapse and expand commit the layout once and FLIP the cards;
    - an `animateLayout` prop;
    - compact keeps the absolute slide stack.
  - `PanelSlot.tsx` (+62/−18): `PanelSlotElements`, the material layer, `PANEL_GAP`.
  - `context/AppShellContext.tsx` (+3): `panelId`.
- **Files:** the three above.
- **Method:**
  - `PanelStackContainer` (div 0): take 1:1.
  - `PanelSlot` (div 4, our two `t` dependency-array entries): take, then re-add the two entries.
  - `AppShellContext`: take only the `panelId` hunk.
- **Keep:** `AppShellContext` keeps our 102 lines:
  - A7 built-in dp MCP set;
  - F1.1050 / F1.1052 permission-mode ring;
  - F1.1191 workspace-settings reload;
  - P6.278, P6.480;
  - UA5.10;
  - external-prefill origin;
  - `capabilityContext`.
- **Tests:** new `app-shell/__tests__/panel-stack-materials.test.tsx` (`renderToStaticMarkup`):
  - Positive: with two content panels, the navigator and panel 1 render inside one card element and panel 2 in its own.
  - Boundary: `isCompact` renders the absolute stack with no joined card.
  - Playground: R1's panel-stack entries, in dark.
- **Runtimes:** neutral.
- **Done means:** the two files equal v0.15.1 modulo our 2 lines; in R2-20, a toast sits in the first pane's bottom-left corner.

**R2-03 `[ui]` `[design]` `[shell]` Sidebar pane, pinned footer, Workspace section, top bar; the AppShell sidebar hunks (M).**
- **Needs:**
  - R2-01, R2-02;
  - R6-01 (`HotkeyKeycaps`);
  - R6-02: upstream drops `springTransition`. This row deletes our dead import at `AppShell.tsx:69-74`; its last use is gone, since `grep -n "collapsibleSpring\|<Collapsible\|AnimatedCollapsibleContent" AppShell.tsx` shows only the import lines.
- **Upstream:**
  - ADDED `SidebarPane.tsx`: a New-session row with its shortcut on hover, the scrolling navigation, and a pinned footer.
  - `LeftSidebar.tsx` (+179/−195):
    - `SectionItem` headings;
    - the depth grid (8px row pad, 24px indent);
    - children fade in staggered (25ms × ≤6);
    - the v0.14.1 one-line title with `title=` on hover.
  - `TopBar.tsx`: 44px recessive chrome; named 28px icon buttons.
  - `AppShell.tsx`:
    - the sidebar block becomes `<SidebarPane links footerLinks …>`;
    - the links are split into `sidebarLinks` and `sidebarFooterLinks`;
    - `{ id: "section:workspace", type: "section" }` replaces `separator:chats-sources`;
    - storage fallbacks change to 232 / 304 (were 220 / 300);
    - `animateShellLayout`: pointer toggles animate, ⌘B and ⌘. are instant;
    - two `<ShellResizeHandle>`.
- **Files:** `AppShell.tsx`, `LeftSidebar.tsx`, `SidebarPane.tsx` (new), `TopBar.tsx`.
- **Method:**
  - `LeftSidebar` (div 10) and `TopBar` (div 25): take v0.15.1 and re-apply ours.
  - `AppShell`: per-hunk on OUR file. B3 simulated 6 conflict hunks / 1697 lines for the whole file; this row takes only the sidebar, width and animation hunks.
- **Keep:**
  - Our navigator set:
    - Plugins (`nav:sources:plugins`), Hooks (`nav:sources:hooks`) and Skills (`nav:sources:skills`) nested under Sources (`AppShell.tsx:2858-2880`), where upstream has a top-level `nav:skills`;
    - Projects → Pages → Automations (UA5.8 / UA7.3, OQ-19);
    - a footer of Settings, our top-level `nav:plugins` (`AppShell.tsx:2987`) and What's New.
  - Navigation counts:
    - the MCP count comes from `sourceNavigationCounts` with the built-in dp set (A7, `useBuiltinDpMcpServers`, `AppShell.tsx:875`);
    - the Plugins count comes from `capabilityCatalog.installedPlugins`.
  - UA2.2 `navigator-layout.ts` (`resolveNavigatorWidth`, `AppShell.tsx:3967`). The new defaults change only the `storage.get` fallbacks (`AppShell.tsx:595,599`).
  - `LeftSidebar`: i18n `sidebar.mainNavigation` / `sidebar.subNavigation`, and the `onAddProject` pass-through.
  - `TopBar`: the `WorkspaceInfo` type, localized `getDocUrl(…, i18n.resolvedLanguage)`, no messaging item, no `thecraftagents.com` docs URL.
- **i18n:** `sidebar.workspaceSection`.
  - Absent in our `en.json`. Positive control: `sidebar.subNavigation` is present.
- **Tests:**
  - New `app-shell/__tests__/sidebar-pane.test.tsx`:
    - Positive: footer links render after the scroller in a `shrink-0` block. A `section` item renders a heading that is not focusable and not in the `getItemProps` order.
    - Negative: a long link title renders inside `.truncate` with `title=` the full name. Ours renders a bare `{link.title}` at `LeftSidebar.tsx:537`, so this case fails on HEAD.
  - The source-reading guards over `AppShell.tsx` stay green; they pin our specifics:
    - `lib/__tests__/composer-permission-modes.test.ts`, `label-session-counts.test.ts`, `workspace-cyclable-modes.test.ts`;
    - `app-shell/__tests__/browser-refusal-toast.test.ts`, `stop-failure-is-surfaced.test.ts`;
    - `pages/settings/__tests__/workspace-settings-refresh.test.ts`, `pages/__tests__/plugin-update-affordance.test.tsx`;
    - `info/__tests__/local-mcp-disabled-surfaces.test.tsx`, `kanban/__tests__/project-columns.test.tsx`;
    - `scripts/cdp/rs-116-projects-score.test.ts`.
  - Then run `lint:ledger-citations`.
- **Runtimes:** neutral.
- **Done means:** at a 600px-tall window the footer stays visible; our entries are present; ⌘B toggles instantly and a click animates.

**R2-04 `[ui]` `[design]` `[filters]` `SessionFilterMenu` extracted from AppShell (M).**
- **Needs:** R2-03 (same file, after it); R6-03 (`HeaderIconButton`); R6-06 (label-menu look).
- **Upstream:**
  - ADDED `SessionFilterMenu.tsx`: the dropdown and `AltExcludeTooltip` / `FilterModeBadge` / `FilterMenuRow` / `FilterLabelItems`, moved out of AppShell and keyed by `activeWorkspaceId`.
  - `CompactSessionListFilter.tsx`: accent-tint active state.
- **Files:** new `SessionFilterMenu.tsx`; `AppShell.tsx` (our helpers at L201–L537 and the dropdown body move out); `CompactSessionListFilter.tsx`.
- **Method:** add upstream's file, then re-apply our filter hunks. They are small: our diff of that region vs v0.14.1 is `hasActiveLabelFilter`, i18n and `projectsAvailable`.
- **Keep:**
  - UA12.162: the tint and Clear key on LIVE label ids (`hasActiveLabelFilter`), not on `labelFilter.size`.
  - UA12.154 / UA12.163: dead-label prune and liveness.
  - UA5.9: the project include/exclude and `projectsAvailable`.
  - i18n: `common.clear`, `sidebar.statuses`, `sidebar.labels`.
  - Take upstream's `sidebar.noMatchingFilters`, and retire our `sidebar.filter.noStatusOrLabelMatches` only if `git grep` finds no other reader.
  - `CompactSessionListFilter`: ours (UA5.9 grouping, UA12.162 tint).
- **Tests:** new `app-shell/__tests__/session-filter-menu.test.tsx`:
  - Positive: a persisted filter holding only a deleted label renders the trigger untinted and with no Clear (UA12.162 carried).
  - Negative: a live label filter tints and shows Clear.
  - `inherited-filter-params.test.ts` stays green, and `label-session-counts.test.ts` is retargeted if it reads moved code.
- **Runtimes:** neutral.
- **Done means:** AppShell holds no filter-menu component, and filter behaviour is unchanged.

**R2-05 `[ui]` `[design]` `[sessions]` Session row anatomy and "+N" label expand (M).**
- **Needs:**
  - R2-01 (`fit-labels`);
  - R6-04 (`EntityRow` `titleTrailing` / `subtitle` / `subtitleTrailing` / `moreButtonLabel`);
  - R6-06 (label chip `entryIndex` / `popoverSide`);
  - B4-02 (`sessionLabelChips` in `@nessy-agent/shared/labels`).
- **Upstream:**
  - v0.15.1 `SessionItem.tsx` (+93/−66):
    - the leading glyph is the workflow status;
    - the title is 600 weight when unread, with an 8px accent dot and the age in accent;
    - the subtitle is the run state (needs you · working · failed · plan ready), else the labels, else the preview;
    - no separators;
    - `moreButtonLabel`.
  - `SessionBadges.tsx` (+143/−26): "+N" expands in place, ChevronUp shows fewer, `fitLabelCount`.
- **Files:** `SessionItem.tsx`, `SessionBadges.tsx`.
- **Method:**
  - `SessionBadges` (div 0): take 1:1.
  - `SessionItem` (div 182): MERGE. Upstream's anatomy, with upstream's `runState` computed from OUR predicates.
- **Keep:**
  - P6.757: the needs-you input is `sessionAwaitsApproval(item, local)`, which includes the server's `awaitingApprovalCount`.
  - P6.270 / P6.764: the attention label naming WHAT waits (`session.attention.waitingOn`, `…waitingOnQuestion`) becomes the run-state line's `title` and `aria-label`.
  - P6.504: the `lastOutputSummary` activity line (with `session.lastOutput.hint`) instead of the bare preview.
  - P6.589: `SessionRowPermissionAnswer` beside the chips.
  - UA5.9: project stripe and hover project name.
  - Upstream's `PLATFORM_LABEL` messaging hunk is not taken (messaging removed).
- **i18n:** `session.runState.needsYou`, `…working`, `…failed`, `…planReady`, `session.unreadIndicator`, `session.actionsFor`, `chat.moreLabels`, `session.showFewerLabels`. All are absent in ours.
- **Tests:** new `app-shell/__tests__/session-item-run-state.test.tsx`:
  - Positive: a meta with `awaitingApprovalCount: 1` and no local card renders the needs-you line naming the tool. A processing meta renders the working line.
  - Negative: an idle unread meta renders `font-semibold` and the dot, and NO run-state line.
  - SessionBadges: positive, "+2" expands to every chip; boundary, chips that fit render no "+N".
  - `SessionRowPermissionAnswer.test.tsx` and `SessionStatusIcon.test.tsx` stay green.
- **Runtimes:** neutral. Needs-you is fed for Pi, Claude and Codex by the same server count (P6.757).
- **Done means:** one meaning per slot, and our attention facts survive.

**R2-06 `[ui]` `[design]` `[sessions]` Session list motion, session menus, info popover (S).**
- **Needs:** R2-05; R7 (`hooks/useListReorderFlip.ts`, ADDED); R6-06 (`statusDisplayLabel`).
- **Upstream:**
  - `SessionList.tsx`: FLIP reorder through `useListReorderFlip` (`data-session-id`); Buttons.
  - `SessionMenu.tsx`: the label count shows only when >0.
  - `CompactSessionMenu.tsx`: `onShowInfo`, `initialView`, `onCloseAutoFocus`, an optional trigger, `statusDisplayLabel`.
  - `SessionInfoPopover.tsx`: controlled `open`, an optional trigger; the popover hugs its content up to 460px.
- **Method:** take the hunks.
- **Keep:**
  - `SessionList`: UA5.9, F1.353, UA12.121 (`knownProjects`).
  - `SessionMenu`: P6.703 per-chat memory scope and revert-checkpoint.
  - `CompactSessionMenu`: routing through `useSessionMenuActions`.
  - `SessionInfoPopover`: our `session: SessionKey` prop. Ours has no `sessionFolderPath` in the renderer (`git grep sessionFolderPath -- apps/electron/src/renderer` = 0 hits; positive control: `workingDirectory` has hits).
- **Tests:**
  - New `SessionInfoPopover` case. Positive: `open` with no trigger renders the content. Boundary: uncontrolled with a trigger toggles.
  - `project-grouping.test.ts` stays green.
- **Runtimes:** neutral.

**R2-07 `[ui]` `[design]` `[chat-header]` The chat header carries status, labels and actions (L).**
- **Needs:**
  - R2-05, R2-06;
  - R6-06 (`statusDisplayLabel`, label menus);
  - R7 (`atoms/label-value-edit.ts`);
  - R7's `AutomationInfoPage` row, which moves its `titleMenu` to `Info_HeaderMenu`. v0.15.1 `PanelHeader` has no `titleMenu`, and ours passes one at `AutomationInfoPage.tsx:82`;
  - B4-02.
- **Upstream:**
  - ADDED `chat-header/{ChatHeader,ChatHeaderLabels,ChatHeaderStatusButton,ChatShareMenu,label-strip-layout}.tsx` and `__tests__/label-strip-layout.test.ts`.
  - `PanelHeader.tsx`: `titleRow`; the title dropdown removed.
  - `ui/PanelHeaderCenterButton.tsx`: 28px ghost, 44px compact.
  - `ChatPage.tsx` (−444): rename, share, flag / archive / status callbacks and the menus move into `ChatHeader`, which reads them from `AppShellContext`. Every field it reads exists in ours.
- **Files:** the five new files; `PanelHeader.tsx`; `ui/PanelHeaderCenterButton.tsx`; `pages/ChatPage.tsx`.
- **Method:**
  - Add the five files and adapt them.
  - `PanelHeader` (div 0): take 1:1.
  - `PanelHeaderCenterButton`: upstream's doc and classes go into our `PANEL_HEADER_BUTTON_CLASS`.
  - `ChatPage`: per-hunk on OUR file (5 hunks / 543 lines simulated).
- **Keep:**
  - `ChatShareMenu`:
    - our share flow through our `useSessionMenuActions`: UA1.25 / UA1.26 internal t-artifacts with expiry toasts (`hooks/share-result-toast.ts`);
    - the `RENDERER_CONFIG.sharingEnabled` gate (`ChatPage.tsx:41`);
    - learn-more opens our URL (`ChatPage.tsx:774`), never upstream's `SHARING_DOCS_URL = https://thecraftagents.com/…` (D(a)).
  - `ChatHeader` actions:
    - P6.361 `WorkspaceActionsMenu` (`ChatPage.tsx:823`);
    - UA3.6 Edit task (upstream carries the same);
    - in compact, upstream's drawer "Session info" replaces our `compactInfoButton`;
    - `SessionInfoPopover session={{ sessionId, workspaceId }}`;
    - the `nessyagents://` scheme in open-in-new-window.
  - The folder meta comes from OUR `deriveSelectionFlags(workingDirectory, canReset)`. Upstream's second argument is `sessionFolderPath` (`input/use-working-directory-state.ts:211` vs v0.15.1 `:217`).
  - Everything else of ours in `ChatPage` stays:
    - the runtime switch: `previewRuntimeSwitch` (L312), `handleConnectionChange` (L342) and its toasts P3.266 / T3 / P6.113 / P3.350 / P6.14 / P3.340;
    - the project trust gate (D1.223 / D1.363, `<ProjectTrustDialog>` L1103);
    - the deep-link prefill disclosure;
    - UA1.23 `SessionPublishPlatform` (L1036);
    - the P6.424 spinner tip.
- **i18n:** `chat.statusButton`, `session.actionsFor`, `chat.moreLabels`.
- **Tests:**
  - Copy `label-strip-layout.test.ts`.
  - New `chat-header/__tests__/chat-header.test.tsx`:
    - Positive: with sharing on, the share menu's learn-more opens our URL and no rendered string contains `thecraftagents.com`; the `WorkspaceActionsMenu` slot renders.
    - Negative: compact renders no labels, meta or share, and ⋯ has `aria-haspopup="dialog"`.
    - `sameHeaderProps` returns true for a field-equal new meta object, so streamed deltas skip the header.
  - The `ChatPage` source-reading tests (2) are retargeted.
  - Then run `lint:ledger-citations`.
- **Runtimes:** neutral. The runtime-switch code it leaves in `ChatPage` is untouched, so the Pi / Claude / Codex switches keep their tests.
- **Done means:** the header shows status · title · folder · labels (+N) · info · share · ⋯; the label row above the composer is gone (R2-08).

**R2-08 `[ui]` `[design]` `[composer-row]` The rows above the composer: tasks row and mode chip; our session badges kept (M).**
- **Needs:**
  - R2-07: labels and status now live in the header;
  - R4-09 (`ComposerModeChip`);
  - R4-13: `ChatInputZone` passes `showPermissionMode` only while a decision prompt replaces the toolbar.
- **Upstream:** v0.15.1 `ActiveOptionBadges.tsx` (+41/−507, now 72 lines): the tasks row, then the mode chip.
- **Method:** take the v0.15.1 structure and re-add ours as one quiet chip row (B3 simulated 3 hunks / 698 lines).
- **Keep:**
  - P6.502 never-persist badge (`ActiveOptionBadges.tsx:257`);
  - P6.940 session-agent `@X` badge (L223);
  - P6.476 `SessionGoalBadge` (L194);
  - the D1.97 / D1.98 / D1.269 scheduled-work read (L207), handed to `ActiveTasksBar`.
- **Placement decided (section 6):** these stay in this row.
- **Dropped:**
  - our `LabelBadge` / `StateBadge` stack: the header owns them;
  - `FilesPopoverButton` (L401): it is the same `SessionInfoPopover` as the header's Info button;
  - `PermissionModeDropdown`: replaced by R4-09's chip. F1.1168's menu shape is R4-09's call.
- **Tests:**
  - `never-persist-badge-mount.test.tsx`, `session-agent-badge-mount.test.tsx` and `session-goal-mount.test.tsx` stay green. Positive: each badge renders alone.
  - New negative: with labels and a status set, the row renders no label or status badge.
- **Runtimes:** neutral. `sessionAgent` applies only where the server says it does (P6.940).

**R2-09 `[ui]` `[design]` `[tasks]` Background-task chips with a card: follow, open output, stop one task (L).**
- **Needs:**
  - R2-08;
  - B4-01 → UB9.8: a running Claude task's output behind OUR read, plus `task_activity`;
  - R7: `atoms/sessions.ts` `BackgroundTask` gains upstream's `activity`, `stopping`, `agentsCompleted`, `summary`, `workflowId` and `outputFile` beside ours `unlistedAt`, `listed`, `dismissedAt` and `endOutput` (ours lacks the upstream six: `atoms/sessions.ts:830-866`). R7 also changes `hooks/useBackgroundTasks.ts` from `killTask` to `stopTask` / `dismissTask`;
  - R4-01 (`input/composer-styles` `COMPOSER_META_CHIP`);
  - R1 motion.
- **Upstream:**
  - ADDED `BackgroundTaskChip.tsx`:
    - a chip with a spinner and shimmer, or a check / cross / stop mark;
    - a card with the live summary, steps, and an output tail polled every 2 s while open;
    - Open, Copy, Stop and Dismiss.
  - `ActiveTasksBar.tsx`: a motion row, one card open at a time.
  - `background-task-chip-state.ts`: `keepId` keeps an open card's chip past its linger.
  - DELETED `TaskActionMenu.tsx`.
- **Files:** new chip; `ActiveTasksBar.tsx`; `background-task-chip-state.ts`. Delete our `TaskActionMenu.tsx`. Its callers:
  - `ActiveTasksBar.tsx:46`;
  - the type import at `ActiveOptionBadges.tsx:9`;
  - `ChatDisplay`'s `TerminalOverlayData` (`task-output.ts` stays);
  - tests `TaskActionMenu.test.ts` and `background-tasks-mount.test.tsx`;
  - comments in `claude-agent.ts:8604` and `claude-stop-background-task.test.ts:477`, repointed.
- **Method:** add, then adapt the I/O to ours:
  - the card reads through `readBackgroundTaskOutput(sessionId, taskId, cursor)` (`apps/electron/src/shared/types.ts:497`), mapped to upstream's `BackgroundTaskOutput` (`text` | `agent`). Upstream's `getBackgroundTaskOutput(sessionId, id, type)` is not used;
  - Stop goes through our L9 routes (`stopAgentTask` L486, `killShell` L481), with our toast mapping (`useBackgroundTasks.ts:87-99`).
- **Keep:**
  - Our per-runtime truth moves from `TaskActionMenu` INTO the card:
    - `canViewTaskOutput` (`TaskActionMenu.tsx:48`): a Pi shell always; any row once it has ended with `endOutput`. Claude SDK tasks and codex terminals have no live read (UA12.205 / UA12.210) until UB9.8.
    - `canStopTask` (L57).
  - Scheduled-work static chips (D1.97 / D1.98, `ScheduledWorkBadge` at `ActiveTasksBar.tsx:70`), in the same row.
  - UA12.192 shell-liveness probe (L153).
  - UA12.186: dismissed rows hidden (L164).
  - UA12.18: one `BackgroundTask` definition.
- **Decided:** upstream's wrapping row replaces our horizontal scroll (`ActiveTasksBar.tsx:34,175`). Upstream places the tasks above the mode row "so a growing number of tasks wraps without moving it". Residue: many tasks take more lines.
- **i18n:** `chat.backgroundTask.*` (20 keys), `chat.taskOrphanedHint`, `chat.workflowAgentsDone`, `toast.taskOutputCopied`. All are absent in ours.
- **Tests:** retarget `background-tasks-mount.test.tsx` and `TaskActionMenu.test.ts` into `app-shell/__tests__/background-task-chip.test.tsx`:
  - Positive: a running Pi shell chip's card offers Open and Stop, and Open calls `readBackgroundTaskOutput`. An ended Claude agent with `endOutput` offers Open.
  - Negative: a running Claude agent (pre-UB9.8) and a codex terminal offer no Open, and a chip with `unlistedAt` offers no Stop.
  - Chip state: `advanceBackgroundTaskChips(prev, now, keepId)` keeps an expired terminal chip whose card is open, and prunes it once `keepId` is null.
- **Runtimes:**
  - Pi: live output and stop (supervisor store).
  - Claude: stop via `Query.stopTask`; live output after UB9.8.
  - Codex: stop via app-server terminate; no live read. That residue shows as a hidden Open.
- **Done means:** `TaskActionMenu.tsx` is gone, and the three-runtime matrix is pinned by tests.

**R2-10 `[renderer]` `[design]` ChatDisplay shell: extracted indicator and frames, run-command wiring, task-output overlay, delayed skeleton, instant session switch (L).**
- **Needs:**
  - R3-08: `MessageBubble` / `ErrorMessage` / `TranscriptStates`, in the same commit or before;
  - R3-09 (`lib/run-command-message.ts`);
  - R3-02 (`RunCommandProvider`);
  - R7 (`useDelayedLoading`);
  - R1 (`CHAT_LAYOUT` in `packages/ui/src/lib/layout.ts`; motion);
  - R2-09 (output data).
- **Upstream:**
  - ADDED `chat-display/{ProcessingIndicator,ScrollOnMount,TurnFrame}.tsx`.
  - `ChatDisplay.tsx` (+146/−588):
    - `RunCommandProvider value={session ? handleRunCommand : null}`;
    - `handleOpenTaskOutput` → `TaskOutputOverlayState`: the terminal overlay for text, the markdown overlay for an agent;
    - `useDelayedLoading` for the skeleton;
    - a session-keyed `contents` wrapper (no crossfade);
    - `TurnFrame`: the search ring 8px outside the turn;
    - `ChatInputZone` gets `onStopTask` / `onDismissTask` / `onOpenTaskOutput` / `onRunCommand`;
    - the `sessionStatuses`, `onSessionStatusChange` and `onInsertMessage` props are removed.
- **Method:** per-hunk merge on OUR file (3900 lines, 2268 diverged; 16 hunks / 1147 lines simulated). Apply upstream's structural hunks; never take the file.
- **Keep:**
  - In the extracted `ProcessingIndicator`: P6.274 `statusType` retry arm, P6.916 `retry` facts, P6.424 plugin spinner tip (`ChatDisplay.tsx:575-618`).
  - Our `TaskOutputOverlayState = TerminalOverlayData & {type:'task-output'}` (L200) is the text arm.
  - The rest of our ChatDisplay is untouched:
    - `MemoryContextMenu`, the rewind overlay, deferred spawns;
    - the `renderActivity` cards: SubagentCard P3.24, WorkflowPanel, TodoListCard P2.503, AdvisorConsultationCard P4.5;
    - verbosity, chat search.
- **Tests:**
  - Of the 32 test files that name `ChatDisplay`, retarget the source-reading ones R3-08 lists.
  - New `chat-display/__tests__/processing-indicator.test.tsx`:
    - Positive: `statusType="retrying"` with `retry` facts renders our retry line, and `suggestion` renders the tip under the spinner.
    - Negative: no status renders only the cycling `chat.processing.*` label.
  - Then run `lint:ledger-citations` (8 citations).
- **Runtimes:** neutral. Run sends a user message (R3-09) that each runtime's own gate decides.

**R2-11 `[feature]` `[renderer]` Suggestions in a new chat over our capability summaries (S–M; B3-13).**
- **Needs:** R2-10, which mounts it in R3-08's `NewChatEmptyState`; R6-12, the failed-test verdict on the summary.
- **Upstream:** ADDED `chat-display/{new-chat-suggestions.ts,NewChatSuggestions.tsx}` and `__tests__/new-chat-suggestions.test.ts`. ChatDisplay's `handleRunSuggestion` enables the source, then sends.
- **Method:** add, then adapt `pickNewChatSuggestions` to `SafeCapabilitySummary[]`. Ours has no `provider` and no `LoadedSource`; it has `logicalName`, `displayName`, `sourceType` and `mention` (`protocol/capabilities.ts:151-180`).
  - Kind map over the logical name: `jira` / `dp-jira` → issues; `gitlab` / `dp-gitlab` / `github` → code; `confluence` / `notion` → docs.
  - Suggestible means enabled and not failed (R6-12's field; until then, not disabled).
  - The mention is `[source:<mention.id>]`, which our parser accepts (`lib/__tests__/capability-catalog.test.ts:217`).
- **Keep / drop:**
  - Drop the `connectEmail` top-up: Microsoft OAuth is removed, and Google email setup is not a Nessy surface.
  - Keep `news` only where the session's runtime has web search.
  - Keep `files`.
- **i18n:** `chat.suggestions.label` and the kind keys. Ours has none: `chat.suggestions.email` is absent.
- **Tests:** an adapted copy of `new-chat-suggestions.test.ts`:
  - Positive: a dp Jira summary yields an `issues` chip first, and its message carries the `[source:…]` mention.
  - Negative: a disabled or failed summary yields no chip, and the top-up is `files`, never `connectEmail`.
- **Runtimes:** neutral (it sends a message).

**R2-12 `[ui]` `[design]` `[fix]` Main panel empty states (S).**
- **Needs:** R2-01 (`DetailEmptyState`); R6-01 (`HotkeyKeycaps`).
- **Upstream:** v0.15.1 `MainContentPanel.tsx` (+9/−17):
  - `DetailEmptyState` per navigator;
  - `SessionsEmptyState hasSessions`: a serif display heading plus the new-chat hotkey;
  - automations: "Select an automation" when the list is not empty.
- **Functional:** **bug present in ours.** `MainContentPanel.tsx:467` renders `automations.noAutomationsConfigured` with no `automations.length` branch, beside a populated list.
- **Keep:**
  - `SafeModeBanner`, `GatewayAuthBanner`;
  - `PluginsPage` / `PluginInfoPage`, `ProjectHooksPanel`;
  - capability ids and `RESOURCE_TYPE_KEYS` (F1.626);
  - the imports at the end of the file (line citations).
- **i18n:** `session.emptyTitle`, `session.emptyTitleFirst`, `session.emptyHint`, `session.emptyHintFirst`, `automations.selectAutomation`.
- **Tests:** new `app-shell/__tests__/detail-empty-state.test.tsx`:
  - Positive: `SessionsEmptyState hasSessions` renders `session.emptyTitle`.
  - Boundary: `hasSessions={false}` renders `…emptyTitleFirst`.
  - The automations choice is a pure helper `automationsEmptyMessageKey(count)`: 0 → `noAutomationsConfigured`, 2 → `selectAutomation`. The 2 case fails on HEAD's logic.
- **Runtimes:** neutral.

**R2-13 `[ui]` `[design]` List panels and the automations list (M).**
- **Needs:** R6-04 (`EntityRow` slots); R6-12 (verdict).
- **Upstream:**
  - `SourcesListPanel.tsx`: line 2 shows a non-connected state in its status colour, with the connection error as a tooltip; the type is title meta.
  - `SkillsListPanel.tsx`: "Project" as title meta; the description as subtitle.
  - `ui/entity-panel.tsx` (div 0): the `titleTrailing` / `subtitle` / `subtitleTrailing` passthrough.
  - `ProjectsListPanel.tsx`: 1 line.
  - `AutomationsListPanel.tsx`: one quiet subtitle "trigger · actions"; the last run as title meta; disabled rows dimmed by tertiary text (AA), not 50% opacity.
  - `AutomationTestPanel.tsx`: `Info_Alert` success / error.
- **Method:**
  - `entity-panel`, `ProjectsListPanel` and `AutomationTestPanel`: take.
  - `Sources` / `Skills` panels are capability-catalog rewrites (div 290 / 184): re-apply upstream's row anatomy on our rows.
  - `AutomationsListPanel`: take, and keep F1.795.
- **Keep:** P6.769 local-MCP pip; U4 plugins; the P2.439 reveal gate; `skillsList.projectBadge` keyed on our capability scope.
- **i18n:** `sourcesList.statusConnected` (new upstream), `sourcesList.statusAuthRequired` / `…Disabled` / `…Disconnected` / `…NotTested`, `skillsList.projectBadge`. All are absent in ours; `sourcesList.typeMcp` / `…typeApi` / `…typeLocal` are present.
- **Tests:**
  - Positive: a summary whose verdict is failed renders `sourcesList.statusDisconnected` in destructive text on line 2.
  - Negative: a connected source renders its description.
  - A disabled automation has a `text-tertiary` title and no `opacity-50` on the row.
- **Runtimes:** neutral.

**R2-14 `[ui]` `[design]` Detail pages (project, skill, source) and session files (M).**
- **Needs:** R6-03 (`Info_HeaderMenu`); R7 (`info/*`: `Info_StatePill`, `Info_TechnicalDetails`, `Info_Page.Header`); R6-12.
- **Upstream:**
  - `ProjectInfoPage.tsx`: hero avatar; `Button` / `IconButton`; a slug row.
  - `SkillInfoPage.tsx`: actions in `Info_HeaderMenu`; a slug row; permission glyphs.
  - `SourceInfoPage.tsx`: a hero state pill; the connection error as `Info_Alert` with `Info_TechnicalDetails`; the tools count; the tools-error well.
  - `right-sidebar/SessionFilesSection.tsx`: 2 class swaps.
- **Method:**
  - `Skill` / `Source` pages: KEEP ours. They are capability-detail rewrites on `CapabilityDetailTemplate` and `capabilities.getDetail`, at 98 / 154 lines vs upstream's 300+. Port the upstream look into our template: the header menu, a state pill from the summary verdict, the error banner.
  - `ProjectInfoPage` (div 175): take the hunks.
  - `SessionFilesSection`: our `SessionKey` rewrite (div 689); re-apply the 2 class swaps.
- **Keep:**
  - `ProjectInfoPage`: the NESSY folder handle and trust (UA5.3 / 5.5 / 5.6 / 5.12, UA12.113).
  - `SessionFilesSection`: `restoreSessionFileWatch`.
- **i18n:** `sourceInfo.connectionErrorTitle`, and `common.never` if used.
- **Tests:**
  - Positive: a capability detail with a failed verdict renders the `bad` state pill and the error banner.
  - Negative: a connected one renders the `ok` pill and no banner.
  - `local-mcp-disabled-surfaces.test.tsx` stays green.
- **Runtimes:** neutral.

**R2-15 `[ui]` `[design]` `[kanban]` Board and columns: stacked-drag targeting, drop bar, settle motion, header "+" (M).**
- **Needs:**
  - R1 motion (`playFlip`, `snapshotRects`, `springTiming`, `FLIP_ANIMATION_ID`, `prefersReducedMotion`);
  - R6-01 (`IconButton`);
  - **R4-03 in the SAME commit:** `NewTaskComposer` takes `open` / `onOpenChange`, and ours calls it at `KanbanColumn.tsx:132`.
- **Upstream:**
  - ADDED `kanban/board-collision.ts` with its test (B3-22).
  - `KanbanBoard.tsx` (+180/−19): the drop index at the recency slot; the settle FLIP and a tilted overlay; `homeStatusId`; `IconButton` add-column.
  - `KanbanColumn.tsx` (+205/−119): header "+"; `homeStatusId`; `dropIndicatorIndex`; neutral wells.
  - `BoardListToggle.tsx`: a segmented control with tooltips and `role="group"`.
- **Method:**
  - `KanbanBoard` (div 71) and `KanbanColumn` (div 70): take v0.15.1 and re-apply ours.
  - The collision file: add.
- **Keep:**
  - UA12.21 keyboard drag: `BoardKeyboardSensor`, `boardDropTarget`, the a11y announcements, `cancelBoardDrag`. It is compatible: dnd-kit's `pointerWithin` returns `[]` without pointer coordinates (`node_modules/@dnd-kit/core/dist/core.esm.js:479-480`), so keyboard drags fall to `closestCorners` (confidence high).
  - UA3.6 `onAddSubtask(…, connectionSlug)`.
  - UA5.10 add-column gate and column editor.
  - UA2.7 DOM hooks `data-kanban-column` / `data-kanban-task`.
- **Tests:**
  - Copy `board-collision.test.ts`. Positive: stacked rects pick the column under the pointer. Negative: side-by-side uses `closestCorners`.
  - Add a keyboard case to the UA12.21 suite: a stacked layout with no pointer coordinates still lands per `boardDropTarget`.
  - `board-dom-hooks.test.tsx` and `project-columns.test.tsx` stay green.
- **Runtimes:** neutral.

**R2-16 `[ui]` `[design]` `[kanban]` Task tiles, chips, editor and the board container (M).**
- **Needs:** R2-15; R7 (`AnimatedCollapsibleContent` from `@nessy-agent/ui`); R6-01.
- **Upstream:**
  - `TaskTile.tsx` (+109/−90):
    - a raised card;
    - a "Working" live line, gated by the existing live-pulse preference;
    - a meta row: status · model … messages · age;
    - no status chip when the status equals `columnStatusId`;
    - `dragOverlay`.
  - `StatusBadge.tsx`: a neutral chip with the icon in the status colour; the ping is dropped (the live line replaces it).
  - `SubtaskProgress.tsx`: run-state colours and a count.
  - `SubtaskRow.tsx`: one glyph shape per state.
  - `ModelChip.tsx`, `TaskChatPreview.tsx`, `node-state-pill.ts` with its test.
  - `TaskEditor.tsx` (+183/−174): `Button` / `Input` / `Textarea` / `IconButton`, a segmented group; v0.15.1 raises the client timeout 200→620 s.
  - `KanbanBoardContainer.tsx`: a 48px header, `KanbanProjectFilter`, a "New Task" button seeded with the project filter.
- **Method:**
  - `StatusBadge`, `SubtaskProgress` and `node-state-pill` (div ≤3): take 1:1.
  - The rest: take the hunks onto ours (`TaskEditor`: 10 hunks / 125 lines simulated).
- **Keep:**
  - `TaskTile`: UA2.5 connection icon, UA12.46 no-model rows, the P6.270 / P6.764 needs-input mark, UA12.21 `aria-describedby` / `dragging`.
  - `ModelChip`: UA2.5 `resolveModelChipIcon` / `ProviderIconMark`. Gateway aliases `coder` / `fast` take the connection's icon.
  - `SubtaskRow`: UA12.77, UA12.46, UA12.69.
  - `TaskChatPreview`: i18n and the optional model.
  - `TaskEditor`: the folder-handle picker and the UA4.x / UA5.4 / UA12.x rows. The generate timeout stays our shared `GENERATE_CLIENT_TIMEOUT_MS` (`@nessy-agent/shared/tasks/generate-limits`, `TaskEditor.tsx:86`, 380 s); its value is B4-14's.
  - `KanbanBoardContainer`: the UA rows (UA12.91 etc.).
- **Tests:**
  - Positive: a tile whose status equals its column's `homeStatusId` renders no status chip. A processing in-progress tile renders the Working line.
  - Negative: a tile with another status keeps its chip.
  - The existing gateway-alias `ModelChip` case stays green.
- **Runtimes:** neutral. The model chip covers gateway aliases for all three runtimes.

**R2-17 `[ui]` `[design]` `[pages]` Pages library, page view and page dialogs (M).**
- **Needs:** R6-01 / R6-02; R1 tokens.
- **Upstream:**
  - `PagesHome.tsx`: 48px header; a responsive grid.
  - `PageTile.tsx`: a raised 16:10 poster card with a hover lift.
  - `page-visuals.tsx`: role tones, a live dot.
  - `PageView.tsx`: header `IconButton`s and a paper body, plus the Claude-artifact publish.
  - `PageFrame.tsx`: `PAGE_CANVAS_CLASS`. It was already `bg-white` in ours, so this is a refactor.
  - `SharePageDialog.tsx`, `PageSourceAuthBanner.tsx`, `PageGrantsDialog.tsx`, `PageGrantRequestDialog.tsx`, `DeletePageDialog.tsx`: material and Button vocabulary.
- **Method:**
  - `PagesHome`, `page-visuals`, `DeletePageDialog` and `PageTile`: take.
  - The others: take the hunks onto ours.
  - **DROP-b** the Claude-artifact hunks of `PageView`: `publishPageAsClaudeArtifact`, `isClaudeAccountConnection`, `claude.svg`, `pages.claudeArtifact.*`, `toast.pageClaudeArtifact*`. This is the controller's decision, recorded as a visible divergence.
- **Keep:**
  - `SharePageDialog`: t-artifacts, with no password fields (our service has none, `SharePageDialog.tsx:7`); UA6.7.
  - `PageView`: UA9.3 grants, UA5.9 / UA7.4 / UA8.3.
  - `PageFrame`: the security posture (UA7.1 / UA9.3 / UA12.112).
  - `PageSourceAuthBanner`: ours (UA9.3).
- **Tests:**
  - Positive: the header renders a back `IconButton` whose `aria-label` is `pages.backToPages`.
  - Negative guard: `PageView.tsx` contains no `publishPageAsClaudeArtifact`.
  - Existing pages tests stay green.
- **Runtimes:** neutral.

**R2-18 `[ui]` `[design]` Workspace switchers and send-to-workspace (S).**
- **Needs:** UB7.2 (`ui/workspace-avatar.tsx`, amended by R6-13).
- **Upstream:**
  - ADDED `WorkspaceTargetList.tsx`: local / remote targets with remote health.
  - `SendToWorkspaceDialog.tsx` and `SendResourceToWorkspaceDialog.tsx` use it.
  - `WorkspaceSwitcher.tsx` and `CompactWorkspaceSwitcher.tsx`: classes only (0 logic lines).
- **Keep:**
  - F1.627 / UA1.14 transfer targets;
  - F1.577 / F1.606 per-type plural families;
  - the P6.501 delete sentences.
- **Tests:**
  - Positive: an unreachable remote renders `CloudOff`.
  - Boundary: an empty list renders the empty label.
  - `transfer-targets.test.ts` stays green.
- **Runtimes:** neutral.

**R2-19 `[ui]` `[design]` Composer-adjacent chips: attachments and background-finished (XS).**
- **Needs:** R4-07: `InputContainer` mounts `BackgroundFinishedChip` ABOVE the box.
- **Upstream:**
  - `AttachmentPreview.tsx`: a one-line `FileName` that keeps the extension; a remove `aria-label`; touch reveal.
  - `BackgroundFinishedChip.tsx`: `SPRING.snap`, above the input, never covering the draft.
- **Keep:**
  - F1.733 `type="button"`;
  - the pasted-text chip restore (R4);
  - UA1.15 `selectBackgroundFinishedEntry`.
- **Tests:**
  - Positive: `q3-planning-notes.md` keeps `.md` outside the truncating stem.
  - Boundary: a name without an extension, or with one longer than 8 characters, truncates whole.
- **Runtimes:** neutral.

**R2-20 `[cdp]` `[pi]` `[claude]` `[codex]` Shell slice live case, DARK theme (S).**
- **Needs:** R2-01…R2-19; a packaged build launched via the `env -u` launcher.
- **Case:** a new case id from `docs/testing/cdp-live-checklist.md`, one row in the case×runs table, with the narrative in `docs/testing/cdp-runs/`. Force dark first. Steps:
  - **Sidebar:**
    - the Workspace section;
    - the footer pinned at a 600px-tall window;
    - a long page title truncates, with a hover title;
    - ⌘B is instant, a click animates.
  - **Rows:**
    - a Pi session waiting on a card shows needs-you naming the tool;
    - a Claude session is working;
    - a failed codex turn shows failed;
    - "+N" expands.
  - **Header:** a status change, a label added, the share menu with our learn-more URL, compact ⋯ and the status drawer.
  - **Chips:**
    - Pi shell: Open shows output, Stop works;
    - Claude agent: Stop works;
    - codex terminal: no Open.
  - **Other surfaces:**
    - new-chat suggestions with dp sources;
    - a board drag in a narrow, stacked window;
    - Pages library and a page view;
    - a toast anchored in the first pane.
- **Done means:** dark screenshots for every step, and the runs-table row is filled.

## 3. Functional changes hidden in the redesign

| # | Change | Paths (v0.15.1) | Our state + evidence | Disposition | Row |
| --- | --- | --- | --- | --- | --- |
| 1 | Long sidebar names end in "…" and show the full name on hover (v0.14.1) | `LeftSidebar.tsx` | **Missing.** Ours renders a bare `{link.title}` (`LeftSidebar.tsx:537`) | TAKE | R2-03 |
| 2 | Settings / What's New pinned below the scroller at any window height | `SidebarPane.tsx` | Ours scrolls with the navigation (the footer items sit in the same `links` array, `AppShell.tsx:2977-3000`) | TAKE (our footer: Settings, Plugins, What's New) | R2-03 |
| 3 | "Workspace" section heading, not focusable | `LeftSidebar.tsx`, `AppShell.tsx` | Ours has a separator | TAKE | R2-03 |
| 4 | Keyboard ⌘B and ⌘. are instant; pointer toggles animate | `AppShell.tsx` (`animateShellLayout`), `PanelStackContainer.tsx` | Ours: one path (`AppShell.tsx:1176,1179`) | TAKE | R2-03 |
| 5 | Default sidebar and list widths 232 / 304 (were 220 / 300) | `AppShell.tsx` | Ours 220 / 300 (`AppShell.tsx:595,599`); persisted widths are unaffected | TAKE | R2-03 |
| 6 | Session row run-state line: needs you · working · failed · plan ready | `SessionItem.tsx` | Ours: icon strip plus attention label (P6.270), server count (P6.757) | MERGE: upstream anatomy, our predicates | R2-05 |
| 7 | Unread: title 600, accent dot, accent age | `SessionItem.tsx` | Ours: an unread glyph in the strip | TAKE | R2-05 |
| 8 | "+N" expands a row's labels in place; "show fewer" | `SessionBadges.tsx`, `fit-labels.ts` | Ours = v0.14.1 (div 0): no expand | TAKE | R2-05 |
| 9 | Labels move to line 2 (`subtitleTrailing`); hidden while the row needs attention | `SessionItem.tsx` | Ours: badges slot | TAKE | R2-05 |
| 10 | Session list reorder glides (FLIP) | `SessionList.tsx` | absent | TAKE | R2-06 |
| 11 | Label count in the session menu only when >0 | `SessionMenu.tsx` | Ours: always | TAKE | R2-06 |
| 12 | `SessionInfoPopover` controlled and hugs its content (≤460px) | `SessionInfoPopover.tsx` | Ours: fixed 460px | TAKE | R2-06 |
| 13 | `CompactSessionMenu` reopens on its initial view; Status pane straight from the status glyph | `CompactSessionMenu.tsx`, `ChatHeader.tsx` | absent | TAKE | R2-06 / R2-07 |
| 14 | Chat header: status button, click-to-rename title, folder meta, labels (+N), info, share, ⋯; compact drawer | `chat-header/*` | Ours: title dropdown and share in `ChatPage.tsx:733-930` | TAKE + keep ours | R2-07 |
| 15 | Header skips re-render on streamed deltas (`sameHeaderProps`) | `ChatHeader.tsx` | Ours: the header re-renders with `ChatPage` | TAKE | R2-07 |
| 16 | Label and status row removed from above the composer | `ActiveOptionBadges.tsx` | Ours: `LabelBadge` / `StateBadge` stack | TAKE (moved to the header) | R2-08 |
| 17 | Mode chip above the composer only while a decision prompt replaces the toolbar | `ActiveOptionBadges.tsx` + R4 | Ours: always in the badge row | TAKE with R4-09 / R4-13 | R2-08 |
| 18 | Task chip card: live activity, output tail, Open / Copy / Stop / Dismiss | `BackgroundTaskChip.tsx` | Ours: `TaskActionMenu` dropdown (Stop, View Output) | ADAPT; backend B4-01 | R2-09 |
| 19 | An open card keeps its chip past the linger | `background-task-chip-state.ts` (`keepId`) | absent | TAKE | R2-09 |
| 20 | The tasks row wraps above the mode row | `ActiveTasksBar.tsx` | Ours: horizontal scroll (`ActiveTasksBar.tsx:34,175`) | TAKE (stated in section 6) | R2-09 |
| 21 | Task output overlay from the chip (terminal for text, markdown for agent) | `ChatDisplay.tsx` | Ours: terminal overlay via `TaskActionMenu` (`ChatDisplay.tsx:200`) | ADAPT | R2-09 / R2-10 |
| 22 | Run-in-background provider wired; no runner while streaming | `ChatDisplay.tsx` | absent (B3-12) | TAKE (message is R3-09) | R2-10 |
| 23 | Transcript skeleton only after 200ms | `ChatDisplay.tsx` + `useDelayedLoading` | Ours: spinner at once | TAKE | R2-10 |
| 24 | Session switch swaps the transcript in one frame (no crossfade) | `ChatDisplay.tsx` | Ours: motion crossfade | TAKE | R2-10 |
| 25 | Search match ring 8px outside the turn | `TurnFrame.tsx` | Ours inline | TAKE | R2-10 |
| 26 | New-chat suggestions (3 chips; click enables the source and sends) | `chat-display/new-chat-suggestions.ts` | absent; non-compact empty chat renders nothing (B3-13) | ADAPT to `SafeCapabilitySummary` | R2-11 |
| 27 | Automations pane: "Select an automation" when the list is not empty | `MainContentPanel.tsx` | **Bug present:** "No automations configured" beside a populated list (`MainContentPanel.tsx:467`) | TAKE | R2-12 |
| 28 | Sessions pane: "pick one" vs "start your first" heading plus hotkey | `DetailEmptyState.tsx` | Ours: `session.noSessionSelected` only | TAKE | R2-12 |
| 29 | Sources list line 2 = non-connected state (error as tooltip) | `SourcesListPanel.tsx` | Ours: failed tests are invisible (B3-20 / R6-12) | ADAPT | R2-13 |
| 30 | Skills list "Project" meta | `SkillsListPanel.tsx` | absent | ADAPT (our scope) | R2-13 |
| 31 | Disabled automations dimmed by tertiary text (AA), not 50% opacity | `AutomationsListPanel.tsx` | Ours: `opacity-50` | TAKE | R2-13 |
| 32 | Source detail hero state pill and connection-error banner | `SourceInfoPage.tsx` | Ours: capability template, no pill | ADAPT | R2-14 |
| 33 | Compact (stacked) board drops on the column under the pointer | `kanban/board-collision.ts` | Ours: `closestCorners` only (`KanbanBoard.tsx:206`) | TAKE (B3-22) | R2-15 |
| 34 | Drop-indicator bar at the card's real (recency) slot | `KanbanBoard.tsx`, `KanbanColumn.tsx` | absent | TAKE | R2-15 |
| 35 | Column-header "+" opens the New Task composer | `KanbanColumn.tsx` + R4-03 | Ours: dashed button (`KanbanColumn.tsx:132`) | TAKE | R2-15 |
| 36 | A tile skips a status chip equal to its column | `TaskTile.tsx` (`columnStatusId`) | absent | TAKE | R2-16 |
| 37 | Live-pulse preference now drives a "Working" line instead of a ping | `TaskTile.tsx`, `StatusBadge.tsx` | Ours: ping on the badge (`StatusBadge.tsx:9,34`) | TAKE | R2-16 |
| 38 | Header "New Task" seeded with the project filter | `KanbanBoardContainer.tsx` | absent | TAKE | R2-16 |
| 39 | Task generate client timeout 200→620 s (v0.15.1) | `TaskEditor.tsx` | Ours: shared 380 s constant (`TaskEditor.tsx:86`) | COVERED-BY B4-14 | — |
| 40 | Publish a page as a Claude artifact | `PageView.tsx` | absent | DROP-b (controller) | R2-17 |
| 41 | Attachment names keep their extension on one line | `AttachmentPreview.tsx` | Ours: wraps | TAKE | R2-19 |
| 42 | Background-finished chip above the box (never covers the draft) | `BackgroundFinishedChip.tsx` + R4-07 | Ours: inside | TAKE | R2-19 |
| 43 | Toasts anchored to the first pane | `PanelStackContainer.tsx` + R6-02 | Ours: top-right | TAKE | R2-02 |

Refactors that are not behaviour changes, checked:
- `KanbanBoard` recency sort: ours already sorts newest-first (`KanbanBoard.tsx:135-137`).
- `PageFrame` white canvas: ours already uses `bg-white` (`PageFrame.tsx:465`).
- `ModelChip`: comment only.
- `WorkspaceSwitcher` / `CompactWorkspaceSwitcher`: 0 logic lines.

## 4. Our specifics to keep (file → what to re-apply)

- **`AppShell.tsx`.** These lines carry the in-file comments (row ids), and the source-reading tests named in R2-03 pin them.
  - Capability catalog: sources and skills come from the server's `SafeCapabilitySummary` / `UserCapabilityCatalog`, not `LoadedSource` / `LoadedSkill`.
    - A7: the nav count and the MCP list are read once.
    - R3-C: composer picker and @mention are folder / API sources only.
    - `capability-invalidation-refresh`.
  - Navigator:
    - U4 `PluginsManagementPanel`, C6 `ConnectedMcpServersPanel`;
    - `nav:sources:plugins` / `hooks` / `skills`, top-level `nav:plugins`;
    - the built-in dp MCP set `useBuiltinDpMcpServers`.
  - Plugins: the marketplace auto-update notice (`MARKETPLACE_AUTO_UPDATE_REASON_CODE`, "Plugins → Refresh runtime").
  - Permission modes: Shift+Tab cycling, the ONE handler.
    - D1.338, F1.1052;
    - D1.369 offers bypass;
    - F1.1191 workspace-settings reload;
    - `nextCyclePermissionMode`.
    - Upstream's guarded mode stays D(c).
  - Slash commands: custom (workspace / project scoped) and runtime-aware (RTS-11, P2.295; `nestor-cloud-agent` withholds cron tools).
  - Labels and filters:
    - F1.357 `countSessionsPerLabel`;
    - UA12.13 / 154 / 162 / 163 / 164 label liveness, plus the deleted-label empty view;
    - UA5.9 project filter, jump-to-project, inherit-sole-filter.
  - Navigator layout: UA2.2 `navigator-layout`; UA7.3 Pages; UA5.8 Projects; UA5.10.
  - Session creation:
    - P6.133 worktree session creation through `navigate` (host lease; Pi / Claude / Codex identical);
    - `describeSessionCreateFailure`.
  - P2.464 browser refusal toast (`browser-refusal-toast.ts`).
  - Removed surfaces stay removed: `MessagingDialogHost` (messaging D(b)); `RtkUpdatePrompt` belongs to UB7.4.
  - The file-end imports keep the docs' cited lines (≤2037). After the split, re-anchor with `lint:ledger-citations`.
- **`ChatPage.tsx`.**
  - Runtime and connection switch: preview (P3), the plan-history reason (P3.266), model-kept (T3), killed background commands (P6.113), hook events (P3.350 / P6.14 / P3.340), disposal failure.
  - Project trust gate (D1.223 / D1.363).
  - Link-prefill disclosure.
  - UA1.25 / UA1.26 t-artifacts share with expiry toasts and the `sharingEnabled` gate; our learn-more URL.
  - P6.361 `WorkspaceActionsMenu`; UA1.23 `SessionPublishPlatform`; UA3.6 Edit task; P6.424 spinner tip.
  - The `nessyagents://` scheme.
- **`ChatDisplay.tsx`.**
  - `ProcessingIndicator`: P6.274 / P6.916 / P6.424.
  - The rest stays in place: `MemoryContextMenu`, rewind, deferred spawns, `renderActivity` cards (P3.24 / P2.503 / P4.5), the task-output overlay data, and everything R3 lists for `MessageBubble` / `ErrorMessage`.
- **`ActiveOptionBadges.tsx`:** P6.502 never-persist, P6.940 session agent, P6.476 goal, the D1.97 / D1.98 / D1.269 scheduled-work read.
- **`ActiveTasksBar.tsx`:** scheduled-work chips, UA12.192 probe, UA12.186 dismissed filter, UA12.18 single type.
- **`TaskActionMenu.tsx` (deleted):** its `canViewTaskOutput` / `canStopTask` per-runtime gates (UA12.205 / UA12.210) and its `task-output.ts` read move into `BackgroundTaskChip`.
- **`background-task-chip-state.ts`:** `probeShellLiveness`, `confirmBackgroundTasksLive`, `backgroundTaskElapsedSeconds`.
- **`SessionItem.tsx`:** P6.757, P6.270, P6.764, P6.504, P6.589, UA5.9; no messaging pills.
- **`SessionList.tsx`:** UA5.9, F1.353, UA12.121. **`SessionMenu.tsx`:** P6.703, UA5.9. **`CompactSessionMenu.tsx`:** `useSessionMenuActions` routing. **`SessionInfoPopover.tsx`:** the `SessionKey` prop.
- **`SessionStatusIcon.tsx`:** the span button. **`CompactPanelTransition.tsx`:** P6.473 (unless R1 subsumes it). **`FabNewChat.tsx`:** the approved shadow class until R1's lint row lands. **`PanelSlot.tsx`:** the `t` dependency entries. **`PanelHeaderCenterButton.tsx`:** `PANEL_HEADER_BUTTON_CLASS`.
- **`LeftSidebar.tsx`:** i18n aria-labels, `onAddProject`. **`TopBar.tsx`:** `WorkspaceInfo`, localized `getDocUrl`, no messaging or Craft docs.
- **`MainContentPanel.tsx`:** `SafeModeBanner`, `GatewayAuthBanner` (the gateway / dp auth banner), Plugins pages, `ProjectHooksPanel`, capability ids, F1.626. **`AppShellContext.tsx`:** A7, F1.1050 / 1052 / 1191, P6.278, P6.480, UA5.10.
- **`SourcesListPanel.tsx` / `SkillsListPanel.tsx` / `SkillInfoPage.tsx` / `SourceInfoPage.tsx` / `SessionFilesSection.tsx`:** our capability and SessionKey rewrites (P6.769, U4, P2.439); only the look is re-applied.
- **`ProjectInfoPage.tsx` / `ProjectsListPanel.tsx`:** NESSY folder handle and trust, `LoadedProjectView` (UA5.3 / 5.5 / 5.6 / 5.8 / 5.12, UA12.113).
- **`Send*ToWorkspaceDialog.tsx`:** F1.627, UA1.14, F1.577, F1.606. **`WorkspaceSwitcher` ×2:** P6.501.
- **Kanban:**
  - UA12.21 keyboard drag (`KanbanBoard` / `KanbanColumn` / `TaskTile`);
  - UA3.6 `connectionSlug`; UA5.10 column editor; UA2.7 DOM hooks;
  - UA2.5 gateway model icon (`ModelChip`, `TaskTile`, `SubtaskRow`);
  - UA12.46 no-model; UA12.69; UA12.77;
  - P6.270 / P6.764 needs-input;
  - `TaskEditor`: folder handle, UA4.x, the shared generate constant;
  - `TaskChatPreview` i18n; `KanbanBoardContainer` UA rows.
- **Pages:** `SharePageDialog` (t-artifacts, no passwords, UA6.7), `PageSourceAuthBanner` (UA9.3), `PageFrame` (security posture), `PageView` (UA9.3 grants, UA5.9 / UA7.4 / UA8.3; no Claude artifact), provenance headers.
- **`AttachmentPreview.tsx`:** F1.733, the pasted-text chip. **`BackgroundFinishedChip.tsx`:** UA1.15.
- **Provenance headers** (`/* Copied from v0.13.4:… */`) on every UA-ported file are updated to `v0.15.1:` when that file is retaken.

## 5. Per-path disposition (all 94 assigned paths)

Columns:
- **ours:** `same` = same path in our tree; `—` = absent.
- **L:** our line count.
- **div:** our changed lines vs v0.14.1, brand-normalised.
- **up:** upstream changed lines v0.14.1→v0.15.1.
- **merge:** B3's simulated conflict hunks / conflicted lines.

Paths are relative to `apps/electron/src/renderer/{components/,}`.

| path | ours | L | div | up | merge | method | row |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `app-shell/ActiveOptionBadges.tsx` | same | 703 | 279 | 548 | 3/698 | merge: take v0.15.1 shape; re-add never-persist, session-agent, goal badges, scheduled-work; drop labels/status/FilesPopoverButton | R2-08 |
| `app-shell/ActiveTasksBar.tsx` | same | 237 | 208 | 107 | 5/247 | merge: take v0.15.1 chip row; re-apply scheduled-work badges, UA12.192 probe, UA12.186 dismissed filter | R2-09 |
| `app-shell/AppShell.tsx` | same | 4282 | 1266 | 1772 | 6/1697 | per-hunk merge on OUR file (keep list §4); upstream structure applied by hunk | R2-03, R2-04 |
| `app-shell/AttachmentPreview.tsx` | same | 154 | 45 | 68 | 7/37 | take v0.15.1 + re-apply F1.733 and pasted-text chip | R2-19 |
| `app-shell/BackgroundFinishedChip.tsx` | same | 155 | 22 | 36 | 2/15 | take v0.15.1 + re-apply UA1.15 selector | R2-19 |
| `app-shell/BackgroundTaskChip.tsx` | — | — | — | ADDED | — | add; adapt output read + stop gates to ours | R2-09 |
| `app-shell/ChatDisplay.tsx` | same | 3900 | 2268 | 734 | 16/1147 | per-hunk merge on OUR file (structural hunks only) | R2-10 (+R3-08) |
| `app-shell/CompactPanelTransition.tsx` | same | 77 | 8 | 15 | 3/11 | take v0.15.1; keep P6.473 setting unless R1 motion pref subsumes it | R2-01 |
| `app-shell/CompactSessionListFilter.tsx` | same | 512 | 26 | 61 | 2/11 | take class hunks; keep ours (UA5.9, UA12.154/162) | R2-04 |
| `app-shell/CompactSessionMenu.tsx` | same | 644 | 36 | 132 | 1/2 | take v0.15.1 + re-apply useSessionMenuActions routing | R2-06 |
| `app-shell/CompactWorkspaceSwitcher.tsx` | same | 293 | 105 | 42 | 2/12 | take class hunks (0 logic); keep P6.501 | R2-18 |
| `app-shell/DetailEmptyState.tsx` | — | — | — | ADDED | — | add 1:1 | R2-01 |
| `app-shell/FabNewChat.tsx` | same | 47 | 5 | 11 | 1/5 | take v0.15.1 (its shadow vocabulary replaces our shadow-strong once R1 lint lands) | R2-01 |
| `app-shell/LeftSidebar.tsx` | same | 597 | 10 | 374 | 4/112 | take v0.15.1 + re-apply i18n aria-labels, onAddProject pass-through | R2-03 |
| `app-shell/MainContentPanel.tsx` | same | 541 | 188 | 26 | 2/33 | take empty-state hunks; keep ours (banners, plugins, hooks, capability ids) | R2-12 |
| `app-shell/PanelHeader.tsx` | same | 286 | 0 | 155 | 0/0 | take 1:1 (div 0) | R2-07 |
| `app-shell/PanelSlot.tsx` | same | 152 | 4 | 80 | 0/0 | take 1:1 + our 2 dep-array lines | R2-02 |
| `app-shell/PanelStackContainer.tsx` | same | 274 | 0 | 277 | 0/0 | take 1:1 (div 0) | R2-02 |
| `app-shell/ProjectMultiSelectFilter.tsx` | same | 123 | 2 | 23 | 0/0 | take 1:1 + provenance header | R2-01 |
| `app-shell/ProjectsListPanel.tsx` | same | 174 | 13 | 2 | 0/0 | take 1-line hunk; keep ours (LoadedProjectView) | R2-13 |
| `app-shell/SendResourceToWorkspaceDialog.tsx` | same | 289 | 101 | 76 | 3/72 | take WorkspaceTargetList hunks; keep F1.577/F1.606 | R2-18 |
| `app-shell/SendToWorkspaceDialog.tsx` | same | 277 | 75 | 80 | 4/74 | take WorkspaceTargetList hunks; keep F1.627/UA1.14 | R2-18 |
| `app-shell/SessionBadges.tsx` | same | 42 | 0 | 169 | 0/0 | take 1:1 (div 0) | R2-05 |
| `app-shell/SessionFilterMenu.tsx` | — | — | — | ADDED | — | add; re-apply our filter hunks moved out of AppShell | R2-04 |
| `app-shell/SessionInfoPopover.tsx` | same | 161 | 18 | 68 | 2/13 | take v0.15.1 + keep our SessionKey `session` prop | R2-06 |
| `app-shell/SessionItem.tsx` | same | 329 | 182 | 159 | 5/240 | merge: upstream anatomy fed by our attention predicates | R2-05 |
| `app-shell/SessionList.tsx` | same | 808 | 119 | 40 | 0/0 | take FLIP/Button hunks; keep ours (UA5.9, F1.353, UA12.121) | R2-06 |
| `app-shell/SessionMenu.tsx` | same | 293 | 73 | 5 | 0/0 | take 3-line hunk; keep P6.703, UA5.9 | R2-06 |
| `app-shell/SessionMenuParts.tsx` | same | 197 | 0 | 2 | 0/0 | take 1:1 (div 0) | R2-01 |
| `app-shell/SessionProjectColorWrapper.tsx` | same | 46 | 2 | 24 | 0/0 | take 1:1 (B3-26) + header | R2-01 |
| `app-shell/SessionSearchHeader.tsx` | same | 107 | 0 | 22 | 0/0 | take 1:1 (div 0) | R2-01 |
| `app-shell/SessionStatusIcon.tsx` | same | 92 | 31 | 9 | 0/0 | take class hunk; keep our span role=button (nested-button fix) | R2-01 |
| `app-shell/ShellResizeHandle.tsx` | — | — | — | ADDED | — | add 1:1 | R2-01 |
| `app-shell/SidebarPane.tsx` | — | — | — | ADDED | — | add 1:1 | R2-03 |
| `app-shell/SkillsListPanel.tsx` | same | 127 | 184 | 17 | 1/141 | take Button/meta hunks onto our capability rows | R2-13 |
| `app-shell/SourcesListPanel.tsx` | same | 234 | 290 | 57 | 3/124 | take status-line hunks onto our capability rows | R2-13 |
| `app-shell/TaskActionMenu.tsx` | same | 314 | 295 | DELETED | — | DELETE ours after R2-09 moves its gates into the chip; retarget its tests | R2-09 |
| `app-shell/TopBar.tsx` | same | 293 | 25 | 40 | 1/5 | take v0.15.1 + re-apply WorkspaceInfo, localized getDocUrl, no messaging/Craft docs | R2-03 |
| `app-shell/WorkspaceSwitcher.tsx` | same | 324 | 120 | 16 | 1/10 | take class hunks (0 logic); keep P6.501 | R2-18 |
| `app-shell/WorkspaceTargetList.tsx` | — | — | — | ADDED | — | add (needs WorkspaceAvatar, UB7.2) | R2-18 |
| `app-shell/__tests__/fit-labels.test.ts` | — | — | — | ADDED | — | add 1:1 | R2-01 |
| `app-shell/background-task-chip-state.ts` | same | 155 | 114 | 7 | 3/33 | take keepId + stopping hunks; keep our probe/confirm helpers | R2-09 |
| `app-shell/chat-display/NewChatSuggestions.tsx` | — | — | — | ADDED | — | add 1:1 | R2-11 |
| `app-shell/chat-display/ProcessingIndicator.tsx` | — | — | — | ADDED | — | add, then merge our P6.274/P6.916/P6.424 props | R2-10 |
| `app-shell/chat-display/ScrollOnMount.tsx` | — | — | — | ADDED | — | add 1:1 (ours inline is the same) | R2-10 |
| `app-shell/chat-display/TurnFrame.tsx` | — | — | — | ADDED | — | add 1:1 | R2-10 |
| `app-shell/chat-display/__tests__/new-chat-suggestions.test.ts` | — | — | — | ADDED | — | add, adapted to SafeCapabilitySummary | R2-11 |
| `app-shell/chat-display/__tests__/strip-repeated-title.test.ts` | — | — | — | ADDED | — | add 1:1 | R2-01 |
| `app-shell/chat-display/new-chat-suggestions.ts` | — | — | — | ADDED | — | add, adapt (no provider/source-connection-status in ours) | R2-11 |
| `app-shell/chat-display/strip-repeated-title.ts` | — | — | — | ADDED | — | add 1:1 (reader: R3-08 ErrorMessage) | R2-01 |
| `app-shell/chat-header/ChatHeader.tsx` | — | — | — | ADDED | — | add + re-apply share gate, WorkspaceActionsMenu, SessionKey info, nessyagents:// | R2-07 |
| `app-shell/chat-header/ChatHeaderLabels.tsx` | — | — | — | ADDED | — | add 1:1 | R2-07 |
| `app-shell/chat-header/ChatHeaderStatusButton.tsx` | — | — | — | ADDED | — | add 1:1 | R2-07 |
| `app-shell/chat-header/ChatShareMenu.tsx` | — | — | — | ADDED | — | add; our learn-more URL, sharingEnabled gate, our toasts via useSessionMenuActions | R2-07 |
| `app-shell/chat-header/__tests__/label-strip-layout.test.ts` | — | — | — | ADDED | — | add 1:1 | R2-07 |
| `app-shell/chat-header/label-strip-layout.ts` | — | — | — | ADDED | — | add 1:1 | R2-07 |
| `app-shell/fit-labels.ts` | — | — | — | ADDED | — | add 1:1 | R2-01 |
| `app-shell/kanban/BoardListToggle.tsx` | same | 68 | 7 | 37 | 1/30 | take v0.15.1 (shadow class per R1 lint) | R2-15 |
| `app-shell/kanban/KanbanBoard.tsx` | same | 274 | 71 | 199 | 2/93 | take v0.15.1 + re-apply UA12.21 keyboard drag, connectionSlug, onAddColumn gate | R2-15 |
| `app-shell/kanban/KanbanBoardContainer.tsx` | same | 639 | 456 | 40 | 2/13 | take header hunks; keep ours (UA rows) | R2-16 |
| `app-shell/kanban/KanbanColumn.tsx` | same | 378 | 70 | 324 | 5/159 | take v0.15.1 + re-apply UA5.10 editor, UA2.7 DOM hooks, UA12.21 | R2-15 |
| `app-shell/kanban/ModelChip.tsx` | same | 74 | 53 | 9 | 1/6 | take comment/class hunks; keep UA2.5 resolveModelChipIcon | R2-16 |
| `app-shell/kanban/StatusBadge.tsx` | same | 50 | 2 | 36 | 0/0 | take 1:1 + header | R2-16 |
| `app-shell/kanban/SubtaskProgress.tsx` | same | 71 | 3 | 43 | 0/0 | take 1:1 + header | R2-16 |
| `app-shell/kanban/SubtaskRow.tsx` | same | 122 | 38 | 38 | 0/0 | take glyph hunks; keep UA12.77/UA12.46/UA12.69 | R2-16 |
| `app-shell/kanban/TaskChatPreview.tsx` | same | 125 | 23 | 36 | 3/22 | take class hunks; keep i18n + optional model | R2-16 |
| `app-shell/kanban/TaskEditor.tsx` | same | 1650 | 721 | 364 | 10/125 | take primitive hunks; keep ours (folder handle, UA4.x); timeout constant is B4-14 | R2-16 |
| `app-shell/kanban/TaskTile.tsx` | same | 641 | 158 | 199 | 9/109 | take v0.15.1 anatomy + re-apply UA2.5, UA12.46, P6.270/P6.764, UA12.21 | R2-16 |
| `app-shell/kanban/__tests__/board-collision.test.ts` | — | — | — | ADDED | — | add 1:1 | R2-15 |
| `app-shell/kanban/__tests__/node-state-pill.test.ts` | same | 54 | 2 | 13 | 0/0 | take 1:1 + header | R2-16 |
| `app-shell/kanban/board-collision.ts` | — | — | — | ADDED | — | add 1:1 (B3-22) | R2-15 |
| `app-shell/kanban/node-state-pill.ts` | same | 39 | 2 | 11 | 0/0 | take 1:1 + header | R2-16 |
| `app-shell/panel-constants.ts` | same | 38 | 0 | 4 | 0/0 | take 1:1 (div 0) | R2-01 |
| `automations/AutomationTestPanel.tsx` | same | 64 | 0 | 15 | 0/0 | take 1:1 (div 0) | R2-13 |
| `automations/AutomationsListPanel.tsx` | same | 365 | 27 | 52 | 1/36 | take v0.15.1 row anatomy; keep F1.795 | R2-13 |
| `pages/DeletePageDialog.tsx` | same | 49 | 3 | 7 | 0/0 | take 1:1 + header (UA6.7 note kept) | R2-17 |
| `pages/PageFrame.tsx` | same | 504 | 305 | 10 | 0/0 | take constant hunk; keep ours (UA7.1/UA9.3/UA12.112 posture) | R2-17 |
| `pages/PageGrantRequestDialog.tsx` | same | 119 | 113 | 24 | 1/32 | take class/Button hunks; keep UA9.3 | R2-17 |
| `pages/PageGrantsDialog.tsx` | same | 113 | 54 | 26 | 1/4 | take class hunks; keep ours | R2-17 |
| `pages/PageSourceAuthBanner.tsx` | same | 224 | 356 | 26 | 2/106 | take container/Button hunks; keep ours (UA9.3) | R2-17 |
| `pages/PageTile.tsx` | same | 188 | 25 | 118 | 2/24 | take v0.15.1 + re-apply UA5.9/UA6.7/UA7.4 | R2-17 |
| `pages/PageView.tsx` | same | 520 | 112 | 180 | 4/62 | take header/Button hunks; DROP-b Claude-artifact hunks; keep UA9.3 grants etc. | R2-17 |
| `pages/PagesHome.tsx` | same | 207 | 19 | 57 | 0/0 | take v0.15.1 + header | R2-17 |
| `pages/SharePageDialog.tsx` | same | 350 | 436 | 95 | 4/209 | take Input/Button hunks only; keep ours (t-artifacts, no passwords) | R2-17 |
| `pages/page-visuals.tsx` | same | 78 | 4 | 57 | 0/0 | take 1:1 + header | R2-17 |
| `right-sidebar/SessionFilesSection.tsx` | same | 248 | 689 | 4 | 1/20 | re-apply the 2 class swaps on OUR file (rewritten on SessionKey handles) | R2-14 |
| `ui/PanelHeaderCenterButton.tsx` | same | 40 | 11 | 16 | 1/10 | take doc + class into our PANEL_HEADER_BUTTON_CLASS | R2-07 |
| `ui/entity-panel.tsx` | same | 105 | 0 | 12 | 0/0 | take 1:1 (div 0) | R2-13 |
| `context/AppShellContext.tsx` | same | 343 | 102 | 3 | 0/0 | take panelId hunk; keep ours (A7, F1.1050/1052/1191, P6.278/480, UA5.10) | R2-02 |
| `pages/ChatPage.tsx` | same | 1124 | 468 | 556 | 5/543 | per-hunk merge on OUR file: header block → ChatHeader | R2-07 |
| `pages/ProjectInfoPage.tsx` | same | 540 | 175 | 108 | 4/46 | take hero/Button hunks; keep NESSY folder handle, UA5.x | R2-14 |
| `pages/ShortcutsPage.tsx` | — | — | — | 19 | — | N/A: ours has no such page (shortcuts live in pages/settings/ShortcutsPage.tsx, R5-03); upstream page is unrouted (navigation-registry Placeholder) | — |
| `pages/SkillInfoPage.tsx` | same | 98 | 336 | 71 | 2/176 | KEEP ours (capability-detail rewrite); re-apply header-menu + slug row via our template | R2-14 |
| `pages/SourceInfoPage.tsx` | same | 154 | 632 | 100 | 4/386 | KEEP ours (capability-detail rewrite); re-apply hero state pill + error banner | R2-14 |

Notes:
- The "up" column for `LeftSidebar` (374) is v0.14.1→v0.15.1. The v0.14.0→v0.14.1 truncate hunk (+2/−1) is not in that count; it is the R2-03 functional item.
- For `pages/ShortcutsPage.tsx` the evidence is: `v0.15.1:apps/electron/src/renderer/lib/navigation-registry.ts:167` routes `shortcuts` to `PlaceholderComponent`, and our `pages/` directory has no such file.

## 6. Owner questions

None needed. Three defaults were taken under the standing rule ("1:1 with our specifics"; owner 2026-10-08: simplest, runtime-native). They are stated so a reviewer can reverse them:

1. **Our session badges stay above the composer.** These are never-persist (P6.502), session agent `@X` (P6.940) and goal (P6.476).
   - They sit in the same chip row as the background tasks; they are not added to the chat header.
   - Reason: upstream's header has no slot for them. They are create-time facts the composer zone already shows.
   - Moving them would be an invention.
2. **The background-task row wraps** as upstream does, instead of our horizontal scroll.
   - Reason: upstream parity. Upstream states the wrap is deliberate.
   - Residue: many tasks take more lines.
3. **`ChatShareMenu` keeps our share semantics.** These are UA1.25 / UA1.26 internal t-artifacts with expiry, the `sharingEnabled` gate and our learn-more URL.
   - Upstream's `thecraftagents.com` docs link is D(a).
   - Publishing a page as a Claude artifact stays DROP-b (controller, 2026-10-14).

## 7. Coverage

- **94 / 94 assigned paths dispositioned** (section 5).
  - Every path's v0.14.0→v0.15.1 diff was saved.
  - A logic-only diff was read for every modified `.ts`/`.tsx`, in full for:
    - `AppShell`, `ChatDisplay`, `ChatPage`, `LeftSidebar`, `SessionItem`;
    - the kanban ×10, pages ×10, list panels, `MainContentPanel`, `TopBar`;
    - the small shell files.
  - Read in substance: the ADDED `SidebarPane`, `ChatHeader`, `ChatShareMenu` (head), `BackgroundTaskChip` (structure), `new-chat-suggestions.ts`, `TurnFrame`, `ScrollOnMount`, `DetailEmptyState`, `board-collision.ts`, and the v0.15.1 `ActiveOptionBadges`.
- **Our side:** brand-normalised diffs vs v0.14.1 for all 76 existing files. Comment and row-id extraction for the 30 most diverged; direct reads of `ChatPage.tsx:685-870`, `ActiveOptionBadges.tsx:186-260`, `ChatDisplay.tsx:575-618`, `MainContentPanel.tsx:425-470`, `AppShell.tsx:2855-3000`, `SkillInfoPage` / `SourceInfoPage` heads, and `TaskActionMenu` imports.
- **Dependencies:** every import of the 19 ADDED source files was checked for existence in ours. Missing:
  - `ui/hotkey-keycaps` → R6-01;
  - `@nessy-agent/ui/motion` → R1;
  - `input/composer-styles` → R4-01;
  - `ui/workspace-avatar` → UB7.2 / R6-13;
  - `ui/source-connection-status` → replaced by our summary verdict (R6-12);
  - `atoms/label-value-edit` → R7;
  - the intra-slice files.
  - Present: `useActionLabel` (`actions/index.ts:4`), `kanbanEditorTargetAtom`, `getSessionStatus`, every `AppShellContext` field `ChatHeader` reads except `panelId`. `deriveSelectionFlags` exists but with a different signature.
- **i18n:** 122 keys used by the v0.15.1 files are absent in our `en.json`. Positive control: `sourcesList.typeMcp` is found.
  - 50 are new in 0.15.x.
  - 72 already existed upstream at v0.14.0. Those belong to surfaces we replaced: our capability pages, t-artifacts sharing without passwords, the NESSY folder handle, messaging (removed) and the standalone ShortcutsPage.
  - Each row lists the keys it adopts.
- **Not done:** no runtime measurement (read-only brief).
  - The dnd-kit claim was read from the installed bundle (`core.esm.js:479-480`).
  - The three-runtime task-chip matrix is a code reading of `TaskActionMenu.tsx:48-60` and B4-01. R2-20 measures it.
