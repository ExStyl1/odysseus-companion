# R6 — Dialogs, menus, toasts, onboarding, API setup and renderer ui primitives (v0.14.0 → v0.15.1)

Reader: R6. Read-only analysis, 2026-10-14. Upstream `.references/craft-agents-oss`, tags v0.14.0 / v0.15.1. Ours at HEAD `f495cf311` (branch `feat/TCODE-000-1-41-0`).
Instruments: `git diff v0.14.0 v0.15.1 -- <72 paths>` (5156 lines, all read: `scratchpad/delta/r6/all.diff`);
upstream-v0.14.1-vs-ours unified diffs per diverged file (`scratchpad/delta/r6/ours/*.diff`, brand-normalised);
a dry-run of the upstream v0.14.0→v0.15.1 patch onto each of our files (`scratchpad/delta/r6/applytest.tsv`, macOS `patch --dry-run -F2`;
positive control: the same patch onto a 50-line garbage file fails 13/13 hunks, onto ours 9/13 for `slash-command-menu.tsx`).

## 1. Summary

- Upstream v0.15.0 ("A new look") rewrote every renderer primitive in this slice onto one token vocabulary: text roles (`text-label`, `text-label-sm`, `text-secondary`, `text-tertiary`, `text-caption`, `text-display`), fills (`bg-fill-hover/-pressed/-selected`, `bg-sunken`, `bg-raised`, `bg-floating`, `bg-paper`, `bg-navigator`, `*-tint`), control sizes (`h-control*`, `size-control*`, `min-h-row-menu`), materials (`popover-styled`, `field-surface`, `keycap`, `switch-track`, `shadow-elev-*`, `bg-scrim`) and motion classes (`motion-press`, `motion-dialog`, `motion-scrim`, `motion-popover`, `motion-context-menu`, `motion-palette`, `duration-micro/base/slow`). All of these come from R1's CSS/token files; nothing in this slice defines them.
- Button gets ONE primary treatment (solid accent), `secondary`/`ghost`/`danger`/`danger-solid`/`link`, new sizes (`sm|md|lg|xl|icon-sm|icon|icon-lg`), deprecated aliases (`default`/`outline`/`destructive`) and a new `IconButton` (required `aria-label`, optional tooltip + keycaps). Default variant flips from foreground-filled to accent.
- Dialogs/popovers/menus/command palette/toasts "float on their own material": radius-xl floating surface + elev-3, scrim overlay, enter/exit motion classes; Cancel = ghost, forward = primary (with a `↵` keycap when Enter submits), irreversible = danger-solid.
- Toasts (sonner) move from top-right/no icons to bottom-left inside the content card (top-center on compact), 3 visible, 5 s, status icons, width anchored to the first pane via a new `useToastAnchor` hook (caller in R2's `PanelStackContainer`).
- Onboarding becomes a paper card on the navigator canvas with a left-aligned serif display title (`font-serif text-display`); provider tiles get a hairline ring; monochrome provider marks are drawn in `currentColor` (`ProviderMark`).
- Rows (`entity-row`): mail-style full-bleed rows, hairline under each row, the "⋯" button becomes a named sibling that replaces the trailing meta on hover; `showSeparator` is deprecated (renders nothing); new `subtitleTrailing`, `moreButtonLabel`. Group headers become sticky.
- Composer caret menus (`/`, `@`, `#`) share a new `inline-menu-styles.ts` material.
- Functional changes hidden in the restyle: label chips edit only their own entry (`entryIndex`) and open controlled/by keyboard; the `#` label menu keeps valued labels listed and excludes applied plain labels by id; a failed `source_test` shows as failed in the list (`source-connection-status.ts`); workspace avatar initial reaches WCAG AA (`workspace-avatar-color.ts`); `RichTextInput.onTextPaste` (feeds "paste a console snippet → offer to run it"); Cloudflare AI Gateway API-key preset + Azure URL placeholder in `ApiKeyInput`; `statusDisplayLabel`, `PermissionModeIcon` exports; a11y names on header buttons and the API-key eye toggle.
- Not ours / N/A: the five messaging dialogs (we removed messaging), the Copilot half of `CredentialsStep`, `KeyboardShortcutsDialog` (retired on purpose by P2.441).

## 2. Proposed rows

Common to every row below:
- **Needs R1-tokens:** the R1 row(s) that land `packages/ui/src/styles/{tokens,base,index}.css`, `apps/electron/src/renderer/index.css` and the `packages/ui` `./motion` export (R1's slice). Without them every class named in §1 is a no-op. Our `packages/ui/package.json` today exports no `./motion` and no `./utils` (read 2026-10-14; upstream v0.15.1 exports both).
- **Barrel trap (KEEP on every file that gains a `@craft-agent/ui` import):** our `@nessy-agent/ui` barrel reaches the Vite-only `pdfjs-dist/build/pdf.worker.min.mjs?url`, which `bun test` cannot resolve. Evidence: `apps/electron/src/renderer/components/ui/source-status-indicator.tsx` header (P6.837), `ui/panel-header-button-style.ts:1-15`, `ui/slash-command-menu.tsx` import comment (P6.844), and `ui/__tests__/EditPopover-add-skill.test.tsx:8` which must `mock.module` the worker to load the barrel. So `button.tsx` imports `Tooltip*` from `@nessy-agent/ui/ui/tooltip`, `sonner.tsx` imports `Spinner` from `@nessy-agent/ui/ui/LoadingIndicator`, and `collapsible.tsx` re-exports `AnimatedCollapsibleContent` from a subpath R7 adds — never from the barrel (confidence high).
- **Runtimes:** renderer-only rows are runtime-neutral (no runtime reads these components); the per-runtime surfaces inside them (provider cards, slash-command exclusions, runtime switch dialog) keep their data-driven behaviour untouched.
- **Visual verification:** each visual row extends the named playground registry entries and is swept in DARK theme; R6-15 is the slice's CDP screenshot case (RS id allocated by the controller).

**R6-01 `[ui]` `[design]` Control primitives 1:1: Button + IconButton, Input, Textarea, Select, Switch, Tabs, Kbd, Avatar, HotkeyKeycaps, Skeleton (M).**
- **Needs:** R1-tokens.
- **Upstream:** v0.15.1 `apps/electron/src/renderer/components/ui/{button,input,textarea,select,switch,tabs,kbd,avatar}.tsx`; ADDED `ui/hotkey-keycaps.tsx`, `ui/skeleton.tsx` (needs R1's `.skeleton` CSS and R7's `useDelayedLoading`). Mechanism: class-vocabulary swap; `buttonVariants` new variants/sizes with deprecated aliases and `compoundVariants` for `link`; `IconButton`/`iconButtonVariants` exported.
- **Files (ours):** the same paths (all div 0 vs v0.14.1 except `select.tsx` div 6).
- **Method:** take v0.15.1 1:1; `select.tsx` re-apply our one hunk.
- **Keep:** `select.tsx:24` `type="button"` on `SelectTrigger` (measured: a typeless Radix trigger submitted the personal-key form); `button.tsx` Tooltip from the subpath (barrel trap).
- **Tests:** new `apps/electron/src/renderer/components/ui/__tests__/button-variants.test.tsx` (renderToStaticMarkup, as `source-status-indicator.test.tsx` does). Positive: bare `<Button>` renders `data-variant="primary"` and `bg-accent-solid`; `<IconButton aria-label="Copy" tooltip icon=…/>` inside a `TooltipProvider` renders the trigger with that name. Negative/boundary: `variant="outline"` renders the `secondary` class list (alias, so 85 deprecated-variant call sites in ours keep compiling: `git grep -o 'variant="(outline|destructive|default)"'` over `apps/electron/src/renderer` = 85, upstream = 26); `variant="link"` carries `h-auto px-0`. New `ui/__tests__/hotkey-keycaps.test.ts`: `⌘⇧[`→`['⌘','⇧','[']`, `Ctrl+N`→`['Ctrl','N']`; boundary `+`→`['+']`, `null` renders nothing. New `ui/__tests__/primitives-no-ui-barrel.test.ts`: `button.tsx`, `sonner.tsx`, `collapsible.tsx` contain no `from '@nessy-agent/ui'` (exact barrel); positive control on the same regex: `EditPopover.tsx:19` matches. Existing select-in-form behaviour: SelectTrigger renders `type="button"`.
- **Playground:** R1's `registry/primitives.tsx` (every button variant × size, IconButton, inputs, switch on/off/disabled, tabs, kbd, skeleton) in dark.
- **Runtimes:** runtime-neutral (renderer).
- **Done means:** the files equal v0.15.1 modulo brand, the Select hunk and the subpath import; the three test files pass with the expected file counts; `bun run typecheck` for `apps/electron` green (the alias variants keep every caller compiling).

**R6-02 `[ui]` `[design]` Floating material 1:1: Dialog, Popover, DropdownMenu, ContextMenu, StyledContextMenu, Command, Sonner, ScrollArea, Collapsible (M).**
- **Needs:** R6-01, R1-tokens (`motion-*`, `bg-scrim`, `bg-floating`, `shadow-elev-3`, `[data-sonner-toast]` CSS, `z-scrollbar`, `--border-strong/--border-control`), R7 (`AnimatedCollapsibleContent` in `packages/ui` with a subpath export), R2 (`AppShell.tsx:72-73` imports `AnimatedCollapsibleContent` and `springTransition as collapsibleSpring` from `@/components/ui/collapsible` — upstream removes `springTransition`; R2's AppShell row must drop that import in the same wave, or this row keeps a one-line `springTransition` re-export until it does; `PanelStackContainer` calls `useToastAnchor`).
- **Upstream:** v0.15.1 `ui/{dialog,popover,dropdown-menu,context-menu,styled-context-menu,command,sonner,scroll-area,collapsible}.tsx`. Mechanisms: `DialogOverlay` becomes `forwardRef` (Radix Presence exit animation); `CommandDialog` gains a required visually-hidden `title` and `openedWithKeyboard` (zero callers in ours: `git grep CommandDialog` outside `command.tsx` = 0); Sonner position/offset/width/icons/visibleToasts/duration and `useToastAnchor`; ScrollArea thumb colours + `z-scrollbar`.
- **Files (ours):** same paths (div 0 except `scroll-area.tsx` div 14).
- **Method:** take 1:1; `scroll-area.tsx` re-apply our `viewportClassName` hunk.
- **Keep:** `scroll-area.tsx:6-36` `viewportClassName` (the height cap belongs on the Viewport; documented in our docblock); dialog sr-only Close is already `t("common.close")` (`dialog.tsx:75`); subpath imports for `Spinner` and `AnimatedCollapsibleContent`.
- **Tests:** new `ui/__tests__/floating-material.test.tsx`. Positive: `DialogContent` renders `motion-dialog bg-floating shadow-elev-3` and a close button with the localised name in `ru`; `useToastAnchor(120, 400)` sets `--toast-anchor-left`/`--toast-anchor-width` and removes them on unmount. Negative/boundary: `useToastAnchor(null)` sets nothing; with `matchMedia('(max-width: 767px)')` stubbed true the Toaster renders `top-center`, false → `bottom-left`. Existing ScrollArea users keep `viewportClassName` (positive: class reaches the viewport; negative: a `max-h-*` on the Root does not).
- **Playground:** R1's `registry/toasts.tsx` (success/info/warning/error/loading, 4 stacked → 3 visible), a dialog entry, dropdown + context menu, command palette; dark.
- **Runtimes:** runtime-neutral.
- **Done means:** files equal v0.15.1 modulo the kept hunks; AppShell compiles (R2 coordination recorded); tests green.

**R6-03 `[ui]` `[design]` `[a11y]` Header and app-menu controls: HeaderIconButton, TopBarButton, HeaderMenu, Info_HeaderMenu, DesktopAppMenu, BatchAutomationMenu, MetadataBadge, MentionBadge (S).**
- **Needs:** R6-01, R1-tokens (`.header-icon-btn` compact sizing). Consumers of `Info_HeaderMenu` are R2 (`SkillInfoPage`, `SourceInfoPage`) and R7 (`AutomationInfoPage`, `info/index.ts`).
- **Upstream:** v0.15.1 `ui/{HeaderIconButton,TopBarButton,HeaderMenu,metadata-badge,mention-badge}.tsx`, `app-menu/DesktopAppMenu.tsx`, `automations/BatchAutomationMenu.tsx`; ADDED `info/Info_HeaderMenu.tsx`. Mechanism: tooltip doubles as `aria-label`; `HeaderMenu` trigger named `common.more`; opacity-faded text replaced by roles (AA).
- **Method:** HeaderIconButton/TopBarButton/MetadataBadge take 1:1 (div 0); DesktopAppMenu, BatchAutomationMenu, HeaderMenu, MentionBadge apply upstream hunks onto ours (patch applies cleanly, 0 failed).
- **Keep:** `DesktopAppMenu` `NessySymbol` + `menu.nessyMenu`; `HeaderMenu` `nessy://` deep link and `getDocUrl(helpFeature, i18n.resolvedLanguage)`; `BatchAutomationMenu` id-based `setAutomationEnabled`/`deleteAutomation` (ours); `MentionBadge` `SafeCapabilitySummary` types.
- **Tests:** new `ui/__tests__/header-buttons-a11y.test.tsx`. Positive: `HeaderIconButton tooltip="Share"` → `aria-label="Share"`; explicit `aria-label` wins over tooltip; `Info_HeaderMenu` trigger is named `common.more` (en "More") and a custom `label` overrides it. Negative: no tooltip and no `aria-label` → no `aria-label` attribute (nothing invented).
- **Runtimes:** runtime-neutral.

**R6-04 `[ui]` `[design]` List rows and empty states: EntityRow, EntityList, EntityListEmptyScreen, Empty, SourceAvatar (M).**
- **Needs:** R6-01, R6-02, R1-tokens (`--gutter`, `px-gutter`, `bg-paper`, `z-sticky`, `bg-fill-selected`, `--spring-snap*`). Consumers in R2 (`SessionItem` passes `subtitleTrailing`/`moreButtonLabel`; `entity-panel`) take their own upstream hunks.
- **Upstream:** v0.15.1 `ui/{entity-row,entity-list,entity-list-empty,empty,source-avatar}.tsx`. Mechanism: row anatomy (36/54 px, hairline from the text edge, selection = fill), named "⋯" sibling (`tabIndex=-1` on desktop, 36 px always-visible on compact), `showSeparator`/`separatorClassName` deprecated and inert, sticky group headers with `aria-expanded`, `GROUP_GAP`, brand tile ring on source avatars.
- **Method:** `empty.tsx` take 1:1; the other four merge: take v0.15.1 and re-apply ours (patch dry-run: entity-row 2/12 failed, entity-list 0/3, entity-list-empty 1/2, source-avatar 2/3).
- **Keep:** `entity-row.tsx:96-297` `disabled` prop (+ `aria-disabled`, no hover, `cursor-not-allowed opacity-60`, no click/mousedown) — the model catalog shows unavailable models; `entity-row.tsx:295` and `entity-list.tsx:119` `type="button"` (rows live inside the personal-key `<form>`); `entity-list.tsx` `viewportClassName` and the localised context menu (`entityList.expand/collapse/collapseAll/expandAll`; upstream v0.15.1 still ships English literals); `entity-list-empty.tsx:50` `type="button"` (upstream's new `<Button variant="secondary">` sets no type) and `getDocUrl(docKey, i18n.resolvedLanguage)`; `source-avatar.tsx` our `SafeCapabilitySummary` input and status pip — only `BRAND_TILE_CLASS` is added to the `EntityIcon` `className` (`source-avatar.tsx:84`). Our six `showSeparator` call sites (`SessionItem.tsx:184`, `ProjectsListPanel.tsx:133`, `AutomationsListPanel.tsx:113`, `SourcesManagementRow.tsx:184`, `SourcesManagementRowList.tsx:103`, `entity-panel.tsx:90`) keep compiling; `McpServersPanel.tsx:412-428` draws its own separator (ours) and is restyled in R6-11's sweep or by its owner.
- **Tests:** new `ui/__tests__/entity-row.test.tsx`. Positive: with `menuContent` the "⋯" button is a sibling of `.entity-row-btn` named by `moreButtonLabel` (default `common.more`); `titleTrailing` renders under `data-slot="entity-row-meta"`; a `disabled` row has `disabled` + `aria-disabled` and no `hover:bg-fill-hover`. Negative/boundary: `showSeparator` renders no separator element; the row button keeps `type="button"`. Extend an EntityList case: collapsible group header has `aria-expanded` and the ru context-menu labels.
- **Playground:** our `registry/entity-lists.tsx`, `session-list.tsx`, `sources-management.tsx`, `mcp-servers-panel.tsx`, `capability-detail.tsx` (model catalog with a disabled row) in dark.
- **Runtimes:** runtime-neutral.

**R6-05 `[composer]` `[design]` Composer caret menus look: inline-menu-styles, SlashCommandMenu, InlineMentionMenu, InlineSkillMention, RichTextInput (L).**
- **Needs:** R6-01, R6-02, R1-tokens (`popover-styled` = radius 12 + elev-2, `--selection`, `duration-slow`, `ease-standard`). R4 owns the consumers (`FreeFormInput` → `onTextPaste`; `ComposerModeChip`/`CompactPermissionModeSelector` → `PermissionModeIcon`, `bare`, `footer`).
- **Upstream:** ADDED v0.15.1 `ui/inline-menu-styles.ts`; v0.15.1 `ui/{slash-command-menu,mention-menu,skill-mention-menu,rich-text-input}.tsx`. Mechanisms: `INLINE_MENU_*` constants; slash menu exports `PermissionModeIcon`, gains `bare`, `showDescriptions`, `footer` props and a cmdk `label`; `RichTextInput.onTextPaste(text)` called for every plain-text paste before insertion/attachment; mention badge HTML on `bg-raised shadow-elev-0`; selection tint `var(--selection)`.
- **Files (ours):** same paths; div 670 / 701 / 33 / 126 (ours carries the Codex-desktop composer parity work); patch dry-run failed hunks 9/13, 5/8, 2/3, 2/11.
- **Method:** merge per hunk. Add `inline-menu-styles.ts` 1:1 and point our `MENU_CONTAINER/LIST/ITEM/ITEM_SELECTED/SECTION_HEADER` constants at it; map our extra row styles (`MENU_ICON_STYLE`, `MENU_TITLE_STYLE`, `MENU_DESCRIPTION_STYLE`, `MENU_ARGUMENT_HINT_STYLE`, `slash-command-menu.tsx:429-444`) to the role tokens (`text-secondary` icon, `text-tertiary` description/hint). Take `PermissionModeIcon` export, `bare` and `footer` (inert until R4 consumes them). `showDescriptions`/`MODE_DESCRIPTION_KEYS` are N/A: ours always shows the description (`CommandItemContent`, `slash-command-menu.tsx:637-690`) from `PERMISSION_MODE_FULL_DESCRIPTION_KEYS` over our mode set (no `guarded`; draft OQ-43.4 (a)). Take `onTextPaste` (prop only; the behaviour is R4/B-owned).
- **Decision taken (owner rule "the LOOK follows upstream, behaviour stays ours"):** the menus stop coupling their radius to `--composer-radius-eff` (`slash-command-menu.tsx:429`, `mention-menu.tsx:75`) and use `popover-styled`. Recorded in the row's commit; reversible.
- **Keep (behaviour):** portals (`createPortal`), the `max-h-[40dvh]` list cap, argument-hint slot, description truncation with `title` tooltip (R15), custom slash commands and per-runtime exclusions (`resolveExcludedCommandIds`), `buildPermissionModeCommands(displays)` with `descriptionResolved`, `@nessy-agent/ui/icons` subpath (P6.844), `SafeCapabilitySummary` + agent mentions, `isComposerSelectableSkillRow`/`skillMentionInvocationId`; RichTextInput IME (F1.431 `composerShowsPlaceholder`), line box (F1.460), style merge (F1.247), autocorrect off (F1.249).
- **Tests:** existing `ui/__tests__/slash-command-menu.test.tsx`, `mention-menu.test.ts`, `rich-text-input.test.ts`, `rich-text-input-render.test.tsx`, `rich-text-input-composition.test.tsx`, `slash-command-help-table.test.ts` stay green (file counts read). New cases in `rich-text-input.test.ts`: positive — a plain-text paste calls `onTextPaste` once with the text, also when it then becomes a long-text attachment; negative — an empty `text/plain` (image paste) does not call it. In `slash-command-menu.test.tsx`: positive — `InlineSlashCommand` container carries `popover-styled` and `origin-bottom-left`, `PermissionModeIcon` is exported; negative — a runtime-excluded command (e.g. `/approve` on a non-codex session, per `resolveExcludedCommandIds`) is still withdrawn after the merge.
- **Playground:** our `registry/slash-command.tsx`, `input.tsx` (mention menu, skill menu, mention badges selected/unselected) in dark.
- **Runtimes:** renderer; the slash menu's Pi/Claude/Codex exclusions are data and must be unchanged (negative test above).

**R6-06 `[labels]` `[design]` Label chips, label menus, status menu and EditButton (M).**
- **Needs:** R6-01, R6-02, R6-05 (`inline-menu-styles.ts`), R1 (`@nessy-agent/ui/motion` `TWEEN`), B4's labels rows ("plain labels never carry values"); R2 consumers (`ChatHeaderLabels`, `SessionBadges` pass `entryIndex`/`popoverSide`; `CompactSessionMenu`, `ChatHeaderStatusButton` use `statusDisplayLabel`).
- **Upstream:** v0.15.1 `ui/{entity-list-label-badge,label-menu,label-value-popover,session-status-menu,EditPopover}.tsx`. Mechanisms: chip edits/removal touch only `sessionLabels[entryIndex]`; controlled `open`/`onOpenChange`, `sessionId`, `popoverSide`; Enter/Space opens the chip editor; chip tint `color-mix(… 18%)` with role text; `#` menu builds items excluding only PLAIN labels already applied, by id (`extractLabelId`, `flattenLabels` — both exist in ours: `packages/shared/src/labels/values.ts:93`, `labels/tree.ts:35`); value popover header (LabelIcon + name) and `side` prop; `statusDisplayLabel(state, t)` exported; cmdk `label`; `EditButton` becomes a quiet text action; EditPopover backdrop `transition={TWEEN.base}`.
- **Method:** apply upstream hunks onto ours (dry-run: label-badge 0/3 failed, label-menu 2/9, label-value-popover 0/14, session-status-menu 2/6, EditPopover 2/4).
- **Not here:** the EditPopover labels-prompt sentence "Values … are stored only on labels with a valueType…" belongs with B4's labels-clean row (ours lacks the preceding semantic-rule sentence, which `UB6.8` adds; the retarget data maps `EditPopover.tsx` to `UB6.8`).
- **Keep:** `nessy:focus-input` event (`label-value-popover.tsx:94`); `labels.value.*` keys (`label-value-popover.tsx:223,277`; upstream still ships English placeholders); `sidebarMenu.states`/`sidebar.labels` section headers; `sessionMenu.noStatusFound` in the status menu's empty state (pinned by `components/__tests__/renderer-hardcoded-strings.test.ts:475`; upstream's `chat.noResults` is equivalent, so ours stays — simplest, no pin edit).
- **Tests:** extend `ui/__tests__/label-menu.test.ts`: positive — a session holding `priority::high` (valued label) still lists `priority`; negative — a session holding legacy `bug::bug` (plain label with a value) does not list `bug`. New `ui/__tests__/entity-list-label-badge.test.tsx`: positive — with `entryIndex=1` over `['customer::acme','customer::globex']` a value edit rewrites only index 1; negative — without `entryIndex` both entries change (upstream's documented fallback). `session-status-menu`: `statusDisplayLabel` translates `todo` in ru and returns a custom status's own label unchanged.
- **Playground:** our `registry/label-badges.tsx` (coloured/uncoloured, valued, duplicate ids), `edit-popover.tsx`, status menu; dark.
- **Runtimes:** runtime-neutral.

**R6-07 `[dialogs]` `[design]` Upstream dialogs and pickers: ResetConfirmationDialog, RenameDialog, CreateProjectDialog, ColorPicker, InlineColorPickerRow, CompactWorkingDirectorySelector (S).**
- **Needs:** R6-01, R6-02.
- **Upstream:** v0.15.1 same paths. Mechanism: Cancel ghost, forward primary with `<Kbd aria-hidden>↵</Kbd>` where Enter submits, Reset confirm `danger-solid`, info-tint warning box, field without wrapper padding; colour swatches `motion-press`; selector rows `px-2`.
- **Method:** rename-dialog take 1:1 (div 0); the rest apply hunks onto ours (only ResetConfirmationDialog's footer hunk fails — ours already dropped `className="gap-2 sm:gap-0"`).
- **Keep:** CreateProjectDialog provenance header (UA5.8); color-picker / inline-color-picker-row provenance headers (UA2.3) and `projectInfo.colorSelected/colorNone`; CompactWorkingDirectorySelector project handles (`IssuedProjectHandle`, `ui/CompactWorkingDirectorySelector.tsx:4,22`), no per-row "remove recent" button, required `workspaceId`.
- **Tests:** new `ui/__tests__/dialog-buttons.test.tsx`. Positive: RenameDialog Save is `data-variant="primary"` with an `aria-hidden` keycap and Cancel is `ghost`; ResetConfirmationDialog confirm is `danger-solid`. Negative: Save is `disabled` for a whitespace-only value; Reset confirm is `disabled` until the arithmetic answer is correct.
- **Playground:** `startup-dialogs.tsx`, `project-colors.tsx`; dark.
- **Runtimes:** runtime-neutral.

**R6-08 `[onboarding]` `[design]` Onboarding steps on the paper card (M).**
- **Needs:** R6-01, R1-tokens (`bg-navigator`, `bg-paper`, `font-serif`, `text-display`, `text-copy`, `rounded-xl`, `shadow-elev-1`).
- **Upstream:** v0.15.1 `onboarding/{primitives,GitBashWarning,ReauthScreen,CompletionStep,LocalModelStep,OnboardingWizard,APISetupStep,CredentialsStep,ProviderSelectStep}.tsx`. Mechanism: `StepFormLayout` wraps header/content/actions in one paper card (flattens below `sm`), serif left-aligned title, ContinueButton = primary lg, BackButton = ghost lg; tiles with hairline ring and accent selected ring; skip link accent-underlined; `type="button"` on tiles.
- **Method:** primitives and GitBashWarning take 1:1 (div 0); ReauthScreen, CompletionStep, LocalModelStep, OnboardingWizard, APISetupStep apply cleanly; CredentialsStep apply the ChatGPT hunk only (the Copilot hunk is N/A); ProviderSelectStep merge (3/4 hunks fail: ours is a different card set).
- **Keep:** our card set and flags (`ProviderSelectStep.tsx` `nessy`, `nessy_cloud`, `nessy_codex`, `nessy_claude`, `claude`, `chatgpt`, `chatgpt_codex`, `custom_runtime`, `local`; `isProviderCardOffered`, `ProviderSelectStep.tsx:171`; `DEFAULT_PROVIDER_FLAGS`); runtime marks as `currentColor` SVG components (`components/icons/runtime/*Icon.tsx:22 fill="currentColor"`) — this already gives upstream's `ProviderMark` dark-mode guarantee, so `ProviderMark.tsx` is not added; the one-line description `truncate` + `title` (`ProviderSelectStep.tsx:210`; take upstream's "show on mobile", keep truncate); `NessySymbol`; our extra steps (`byo-runtime`, `gateway-connect`) and `codex_chatgpt_oauth` in APISetupStep/CredentialsStep; `LocalModelStep` `t('common.connecting')` (UA12.206).
- **Tests:** new `onboarding/__tests__/onboarding-primitives.test.tsx`. Positive: `StepFormLayout` renders the card (`bg-paper shadow-elev-1`) with an `h1.font-serif.text-display`; `ContinueButton` is `data-variant="primary"`, `BackButton` `ghost`. Negative: the header is not centred (`centered={false}`: no `text-center`). Existing `provider-card-flags.test.ts`, `provider-card-runtime-names.test.ts` stay green (the card set is unchanged).
- **Playground:** our `registry/onboarding.tsx` (every step incl. ByoRuntime/GatewayConnect, reauth, git-bash) in dark, at 375 px and desktop.
- **Runtimes:** renderer; the provider cards cover Pi, Claude and Codex (data, unchanged).

**R6-09 `[connections]` `[design]` ApiKeyInput look, named eye toggle, Cloudflare/Azure rows per B2 (M).**
- **Needs:** R6-01, R6-02, R1-tokens; B2's disposition of `packages/shared/src/config/cloudflare-gateway.ts`; serialise with draft `UB7.7` (Moonshot labels, same file).
- **Upstream:** v0.15.1 `apisetup/ApiKeyInput.tsx`: `field-surface` fields, segmented controls (`bg-fill-hover p-0.5`, selected `bg-raised shadow-elev-1`), preset trigger pill, tier dropdown `popover-styled`, eye toggle `aria-label={t('common.hide'|'common.show')}`; `urlPlaceholder` on presets; `CLOUDFLARE_AI_GATEWAY_PROVIDER` preset (piOnly) with a submit-time URL check.
- **Method:** merge per hunk (div 373; 10/25 hunks fail).
- **i18n:** `common.hide`, `common.show` are absent from both our locales (checked 2026-10-14); keys commit first, en+ru.
- **Keep:** the Nessy Gateway preset (`ApiKeyInput.tsx:157`) and DA1.32's blank-key rule; DA1.53 `VISIBLE_ENDPOINT_PRESET_KEYS = {anthropic, openai, custom}` (`:222`) — so Azure's `urlPlaceholder` and a Cloudflare row are table data no user reaches; DA1.11 gateway-host hint; UA12.214 `t()` placeholders; masked edit flows.
- **Cloudflare/Azure hunks:** follow B2. Default: add the `urlPlaceholder` field (harmless) and the Cloudflare row + submit check only if B2 adopts `cloudflare-gateway.ts`; either way it stays hidden by DA1.53 (no new reachable third-party preset, network posture).
- **Tests:** existing `apisetup/__tests__/*` stay green. New case: positive — the eye toggle is named "Show" (ru "Показать" or the ru value the keys row writes) and flips to "Hide"; negative — it keeps `tabIndex=-1`, and the visible preset list is still exactly `anthropic, openai, custom` after the merge.
- **Playground:** our `registry/api-key-input.tsx` in dark.
- **Runtimes:** the form serves Pi/Claude BYO connections (data unchanged); runtime-neutral for the look.

**R6-10 `[dialogs]` `[design]` Our own dialogs onto the same material and button vocabulary (M).**
- **Needs:** R6-01, R6-02, R6-07 (the recipe).
- **Upstream:** none (ours-only files); the recipe is v0.15.1 `ResetConfirmationDialog.tsx`/`ui/rename-dialog.tsx`/`messaging/LarkConnectDialog.tsx` (segmented control) — read as reference only.
- **Native-first / build:** restyle only; no behaviour change.
- **Files:** `components/BypassPermissionsDialog.tsx` (87 lines), `app-shell/input/RuntimeSwitchDialog.tsx` (237), `app-shell/kanban/RunConfirmationDialog.tsx` (133), `workspace/ProjectTrustDialog.tsx` (158), `marketplace/MarketplaceAddDialog.tsx` (156), `marketplace/MarketplaceSkillPreviewModal.tsx` (120), `plugins/PluginConfigurationPrompt.tsx` (136), `plugins/PluginInstallChecklist.tsx` (283), the dialog parts of `artifacts/PublishedPagesSection.tsx` and `pages/PluginsPage.tsx` (list: `git grep -l "DialogContent|AlertDialogContent|DrawerContent"` minus upstream's file list, 2026-10-14). Any of these another reader owns is skipped here and named to them.
- **Method:** Cancel/Deny → `ghost`; forward → `primary`; irreversible (bypass permissions, trust a project) → `danger-solid`; text roles; drop `DialogFooter` gap overrides.
- **Keep:** RuntimeSwitchDialog's runtime costs and switch semantics (our three-runtime specific); bypass/trust wording.
- **Tests:** new `components/__tests__/ours-dialogs-vocabulary.test.ts`: positive control — the regex `variant="(outline|destructive|default)"` matches a planted line; the listed files contain none. Visual: `registry/startup-dialogs.tsx`, `runtime-switch.tsx`, `runtime-switch-costs.tsx`, `marketplace.tsx`, `plugin-configuration.tsx`, `plugin-install-checklist.tsx`, `published-pages.tsx` in dark.
- **Runtimes:** RuntimeSwitchDialog spans Pi/Claude/Codex (behaviour untouched); the rest runtime-neutral.

**R6-11 `[onboarding]` `[ui]` `[design]` Our own onboarding, API-setup and ui surfaces re-tokened (M).**
- **Needs:** R6-01, R6-02, R6-08, R6-09.
- **Files:** `onboarding/ByoRuntimeStep.tsx` (832), `onboarding/GatewayConnectStep.tsx` (165), `apisetup/ModelCatalogPicker.tsx` (280), `apisetup/GatewayAuthUrlHint.tsx` (56), `ui/system-card.tsx` (109), `ui/compact-chat-card.tsx` (116), `ui/panel-header-button-style.ts` (`PANEL_HEADER_BUTTON_CLASS` → the `HeaderIconButton` recipe, keeping it barrel-free), and `app-shell/McpServersPanel.tsx`'s own separator if no other reader owns it.
- **Method:** build (restyle) with the upstream recipes: `field-surface` inputs, APISetupStep segmented control, ProviderSelectStep tiles, `bg-sunken` info wells, tints for error/success.
- **Keep:** all behaviour (BYO runtime arms, gateway one-click, catalog probing, unavailable rows).
- **Tests:** existing `ui/__tests__/compact-chat-card.test.tsx`, `system-card-sticky-band.test.ts`, `apisetup/__tests__/*` stay green; new static check in `ours-dialogs-vocabulary.test.ts` extended to these files (no `bg-foreground-2`/`text-muted-foreground` left; positive control a planted line). Visual: `registry/onboarding.tsx` (BYO + gateway steps), `oauth.tsx`, `pending-auth-notice.tsx`, `info-notice.tsx` in dark.
- **Runtimes:** ByoRuntimeStep serves the codex-runtime / claude-runtime / Pi arms; behaviour unchanged.

**R6-12 `[sources]` A failed source test shows as failed in the list (S; ADAPT; coordinate with B3).**
- **Premise (MEASURED by reading, confidence medium-high):** `source_test` persists its own vocabulary into `config.connectionStatus` — `'error'`/`'connected'`/`'disconnected'`/`'unknown'` (`packages/session-tools-core/src/handlers/source-test.ts:74,131,134,139`; `source-test.test.ts:420` expects `'disconnected'` persisted). Our renderer never reads it: every surface renders `SafeCapabilitySummary`, and `capabilitySummaryConnectionStatus` (`ui/source-status-indicator.tsx:311`) returns `connected` for `state:'active'` + credential ready. `availabilityState` (`packages/shared/src/capabilities/views.ts:369-376`) does not consult `connectionStatus`, and `declaredConnectionStatus` (`agent/core/source-manager.ts:503`) drops undeclared values. So a source whose last test failed paints green — the defect upstream fixed, reached by a different path.
- **Upstream:** ADDED v0.15.1 `ui/source-connection-status.ts` (`normalizeStoredStatus`: `error`/`disconnected` → `failed`, unknown → `untested`) + `ui/__tests__/source-connection-status.test.ts`; `source-status-indicator.tsx` re-exports `deriveConnectionStatus`.
- **Why not take the files:** our `deriveConnectionStatus` was deleted on purpose (P6.768, recorded in `source-status-indicator.tsx` docblock ≈ lines 236-260): no renderer surface holds the config shape. Taking the file would revive a mapping nothing can call.
- **Native-first:** n/a — source health is a host concept on all three runtimes.
- **Build:** `normalizeStoredStatus` moves to `packages/shared` (source+licence header, Apache-2.0) and feeds a new optional `SafeCapabilitySummary.lastTestStatus` set in `views.ts`; `capabilitySummaryConnectionStatus` returns `failed` when credentials are ready and the last test failed; order stays `local_disabled` → `needs_auth` → `failed`. Wire/schema touch → risk trigger (shared wire).
- **Tests:** extend `ui/__tests__/source-status-indicator.test.tsx`: positive — `{state:'active', credentialState:'ready', lastTestStatus:'failed'}` → `failed`; negative — `lastTestStatus` absent or `'untested'` keeps today's verdict, and a stdio source with local MCP off is still `local_disabled`. New shared test for `normalizeStoredStatus` (upstream's cases copied+adapted).
- **Runtimes:** runtime-neutral (summary built host-side for every runtime's sources).
- **Overlap:** B3 triages "A failed source test shows in the list"; R2's `new-chat-suggestions.ts` imports `source-connection-status` upstream and must use our summary reader instead.

**R6-13 `[renderer]` Amend draft UB7.2 (workspace avatars) to v0.15.1 (XS amendment).**
- UB7.2 (H13) creates `ui/workspace-avatar.tsx` (absent in ours: `ls components/ui` has none; no `atoms/*avatar*`). Retarget its source to v0.15.1: `workspace-avatar.tsx` + ADDED `ui/workspace-avatar-color.ts` (lightest lightness ≤52 % at which the white initial reaches 4.5:1) + ADDED `ui/__tests__/workspace-avatar-color.test.ts` (copy+adapt, header). UB7.2's own tests stay; this adds upstream's AA positive (every hue ≥ 4.5:1) and its boundary (hue 30 at 52 % < 4.5).

**R6-14 `[rtk]` Amend draft UB7.4 (RtkUpdateDialog) to v0.15.1 styling (XS amendment).**
- UB7.4 creates `components/RtkUpdateDialog.tsx` from v0.14.0 under OQ-43.8 (b) (no installer command, no copy keys). Take v0.15.1's classes for what remains (`text-label`, `text-secondary`, `text-tertiary`; Later = ghost, Recheck = `primary`); the `<pre>` command and the Copy button stay out per (b).

**R6-15 `[cdp]` Slice live case: dialogs, toasts, menus, onboarding and API setup in DARK theme (S).**
- **Needs:** R6-01…R6-11.
- **Case:** `scripts/cdp/cases/rs-NNN.ts` (RS id from the controller), packaged build, `env -u` launcher, dark theme forced: screenshot (1) Rename dialog with keycap, (2) Reset confirmation, (3) a toast stack (desktop bottom-left inside the first pane; compact top-center at 375 px), (4) a dropdown and a context menu, (5) the `/` and `@` menus over the composer, (6) the provider-select step and the reauth screen, (7) ApiKeyInput with the eye toggle, (8) the sources list with one source whose test failed (R6-12). Detector: DOM reads of `data-variant`, `data-slot`, computed `border-radius`/`box-shadow` on `[data-slot=dialog-content]`, the toast's `left` offset relative to the content card; the failed source's pip reads `failed`.
- **Runtimes:** drive once on a Pi session; (5) also on Claude and Codex sessions to confirm per-runtime slash exclusions survive (e.g. `/approve` only on codex).

**Plan amendment (result, not a row):** draft `UB4.2` names `components/ui/dialog.tsx` sr-only "Close" as an English string. At HEAD it is already `t("common.close")` (`apps/electron/src/renderer/components/ui/dialog.tsx:75`; upstream v0.13.4 and v0.14.0 have the same line). UB4.2 shrinks to the `AutomationMenu.tsx` half.

## 3. Functional changes hidden in the redesign

| Upstream change | Paths (v0.15.1) | Our state + evidence | Disposition | Row |
| --- | --- | --- | --- | --- |
| Label chip edits/removes only its own entry (`entryIndex`), controlled open, Enter/Space opens editor, `popoverSide`, `sessionId` focus return | `ui/entity-list-label-badge.tsx` | div 0 vs v0.14.1; old code rewrites every entry with the same id | TAKE | R6-06 |
| `#` menu excludes only applied PLAIN labels, by id; valued labels stay listed | `ui/label-menu.tsx` | `createLabelMenuItems(labels, sessionLabels)` unfiltered; helpers exist (`labels/values.ts:93`, `labels/tree.ts:35`) | TAKE (depends on B4 semantics) | R6-06 |
| Label value popover names its label (header), `side` prop | `ui/label-value-popover.tsx` | absent | TAKE | R6-06 |
| `statusDisplayLabel` export; cmdk `label`; localised Clear/Archive | `ui/session-status-menu.tsx` | ours already localised (`sessionMenu.*`, `common.clear`) | TAKE export + label; KEEP our empty-state key | R6-06 |
| EditPopover label-rule prompt: values only on valued labels | `ui/EditPopover.tsx` | ours lacks the semantic-rule sentence it follows (UB6.8) | TAKE in B4's labels row | — (B4) |
| Failed `source_test` shows failed in list | `ui/source-connection-status.ts` + test, `ui/source-status-indicator.tsx` | summary ignores stored status (`views.ts:369-376`, `source-status-indicator.tsx:311`); `deriveConnectionStatus` deleted (P6.768) | ADAPT (build on summary); DROP the two files | R6-12 |
| Workspace avatar initial at WCAG AA | `ui/workspace-avatar-color.ts` + test, `ui/workspace-avatar.tsx` | no avatar component in ours; UB7.2 adds it | TAKE via UB7.2 retarget | R6-13 |
| `RichTextInput.onTextPaste` (feeds "paste a console snippet → offer to run") | `ui/rich-text-input.tsx` | absent | TAKE prop; feature is R4/B-owned | R6-05 |
| `PermissionModeIcon` export, `bare`/`footer` props | `ui/slash-command-menu.tsx` | not exported; no such props | TAKE (inert until R4) | R6-05 |
| Mode one-line descriptions (`showDescriptions`, `MODE_DESCRIPTION_KEYS` incl. `guarded`) | `ui/slash-command-menu.tsx` | ours always shows full descriptions from `PERMISSION_MODE_FULL_DESCRIPTION_KEYS`; no guarded mode | HAVE (equivalent) / N/A | R6-05 |
| Cloudflare AI Gateway preset + submit URL check; Azure URL placeholder | `apisetup/ApiKeyInput.tsx` | presets hidden except anthropic/openai/custom (`ApiKeyInput.tsx:222`, DA1.53) | ADAPT: follow B2; stays hidden | R6-09 |
| Eye toggle named (`common.hide/show`) | `apisetup/ApiKeyInput.tsx` | unnamed; keys absent en+ru | TAKE (+2 keys) | R6-09 |
| Header buttons named from tooltip; HeaderMenu trigger named | `ui/HeaderIconButton.tsx`, `ui/HeaderMenu.tsx` | unnamed | TAKE | R6-03 |
| "⋯" row button named, sibling (not nested), out of Tab order on desktop | `ui/entity-row.tsx` | nested, unnamed | TAKE | R6-04 |
| Collapsible group header `aria-expanded` | `ui/entity-list.tsx` | absent | TAKE | R6-04 |
| `CommandDialog` requires accessible `title`, instant open from keyboard | `ui/command.tsx` | zero callers in ours | TAKE | R6-02 |
| `DialogOverlay` forwardRef (exit animation runs) | `ui/dialog.tsx` | function component | TAKE | R6-02 |
| Toast placement/visible count/duration/icons + `useToastAnchor` | `ui/sonner.tsx` | top-right, no icons | TAKE (anchor caller R2) | R6-02 |
| `AnimatedCollapsibleContent` moves to `@craft-agent/ui` (fade + 4px drop, no height spring); `springTransition` export removed | `ui/collapsible.tsx` | `AppShell.tsx:72-73` imports `springTransition` | TAKE, coordinate R2/R7 | R6-02 |
| Colour-mix chip text roles, opacity → roles (AA) | `ui/metadata-badge.tsx`, `ui/mention-menu.tsx` type chip | opacity-faded | TAKE | R6-03, R6-05 |
| Messaging dialogs restyle (Lark/Telegram/WhatsApp/pairing) | `messaging/*.tsx` | `components/messaging` absent; `git grep -c -i "whatsapp\|telegram\|lark"` over `apps/electron/src` + locales = 0 (control: `ResetConfirmationDialog` = 3 files) | N/A (removed; OQ-43.10 (a)) | — |
| Copilot device-code block restyle | `onboarding/CredentialsStep.tsx` | Copilot removed (`git grep -ci copilot` onboarding+apisetup: one test file only) | N/A | R6-08 (rest of file) |
| KeyboardShortcutsDialog uses Kbd/KbdGroup | `KeyboardShortcutsDialog.tsx` | retired on purpose (P2.441), pinned absent by `pages/__tests__/shortcuts-surfaces.test.ts:23-56`; upstream's copy is dead too (only referenced by `apps/electron/eslint.config.mjs:168`) | N/A here; the Kbd look goes to our `pages/settings/ShortcutsPage.tsx:145` local `Kbd` (R5's slice) | — (R5) |
| RtkUpdateDialog restyle | `RtkUpdateDialog.tsx` | absent; UB7.4 creates it | TAKE in UB7.4 | R6-14 |
| ProviderMark (mono marks in currentColor) | `onboarding/ProviderMark.tsx` | our marks are `currentColor` SVG components (`icons/runtime/*Icon.tsx:22`) | HAVE (equivalent); file not added | R6-08 |
| Info_HeaderMenu (named "⋯" for detail pages) | `info/Info_HeaderMenu.tsx` | absent | TAKE (consumers R2/R7) | R6-03 |
| HotkeyKeycaps / Skeleton primitives | `ui/hotkey-keycaps.tsx`, `ui/skeleton.tsx` | absent | TAKE (consumers R2/R3/R5) | R6-01 |

## 4. Our specifics to keep (file → what to re-apply)

- `ui/select.tsx` → `type="button"` on SelectTrigger (line 24).
- `ui/button.tsx`, `ui/sonner.tsx`, `ui/collapsible.tsx` → subpath imports, never the `@nessy-agent/ui` barrel (P6.837/P6.844 trap).
- `ui/scroll-area.tsx` → `viewportClassName` prop and docblock.
- `ui/entity-row.tsx` → `disabled` (+ aria-disabled, no hover, no click), `type="button"` on the row button, UA5.9 comment on `suppressSelectionBar`.
- `ui/entity-list.tsx` → `viewportClassName`, `type="button"` on the group header, `entityList.*` i18n context menu.
- `ui/entity-list-empty.tsx` → `type="button"` on the Learn-more button, `getDocUrl(docKey, i18n.resolvedLanguage)`.
- `ui/source-avatar.tsx`, `ui/source-status-indicator.tsx` → whole SafeCapabilitySummary design (P6.681/P6.745/P6.768/P6.769), tooltip subpath, own TooltipProvider, pulse prop; only the brand tile ring is new.
- `ui/HeaderMenu.tsx` → `nessy://` URL, localised doc URL.
- `app-menu/DesktopAppMenu.tsx`, `onboarding/{CompletionStep,ReauthScreen,ProviderSelectStep}.tsx` → `NessySymbol`, `menu.nessyMenu`.
- `automations/BatchAutomationMenu.tsx` → id-based enable/delete.
- `ui/mention-badge.tsx`, `ui/mention-menu.tsx`, `ui/skill-mention-menu.tsx` → `SafeCapabilitySummary`, agent mentions, `isComposerSelectableSkillRow`, `skillMentionInvocationId`, portal, `max-h-[40dvh]`.
- `ui/slash-command-menu.tsx` → full command catalogue (advisor, approve, btw, recap, subtask, quota, …), custom commands + argument hints, `buildPermissionModeCommands`/`descriptionResolved`, per-runtime exclusions, description tooltip, `@nessy-agent/ui/icons` subpath, portal. Dropped: `--composer-radius-eff` radius coupling (look follows upstream).
- `ui/rich-text-input.tsx` → F1.431, F1.460, F1.247, F1.249 hunks.
- `ui/label-value-popover.tsx` → `nessy:focus-input`, `labels.value.*` keys.
- `ui/label-menu.tsx` → `sidebarMenu.states`, `sidebar.labels`.
- `ui/session-status-menu.tsx` → `sessionMenu.noStatusFound` (pinned).
- `ui/EditPopover.tsx` → everything ours (div 494: capability/managed-resource flows, `.nessy-agent/docs` paths); only EditButton and TWEEN hunks land here.
- `ui/CompactWorkingDirectorySelector.tsx` → project handles, no remove-recent, required `workspaceId`, `ServerDirectoryBrowser workspaceId`.
- `ui/color-picker.tsx`, `ui/inline-color-picker-row.tsx`, `projects/CreateProjectDialog.tsx` → provenance headers; `projectInfo.color*` i18n.
- `apisetup/ApiKeyInput.tsx` → Nessy Gateway preset, DA1.32, DA1.53 visible-key filter, DA1.11 hint, UA12.214, masked edit; UB7.7 Moonshot hunk serialised.
- `onboarding/OnboardingWizard.tsx` → `byo-runtime` and `gateway-connect` steps and their props.
- `onboarding/ProviderSelectStep.tsx` → nine cards behind `isProviderCardOffered`, runtime marks, `DEFAULT_PROVIDER_FLAGS`, truncate + title.
- `onboarding/APISetupStep.tsx`, `onboarding/CredentialsStep.tsx` → `codex_chatgpt_oauth`, no Copilot, `ApiKeyInitialValues`, legacy-edit description.
- `onboarding/LocalModelStep.tsx` → `t('common.connecting')`.
- i18n: only `common.hide`, `common.show` are new for this slice (en+ru, keys first); upstream's `mode.*Desc`, `labels.selectDate`, `chat.mentionFilesSkillsSources` are N/A (ours uses its own keys).

## 5. Per-path disposition

`div` = changed lines ours vs upstream v0.14.1 (brand-normalised); `fail` = upstream v0.14.0→v0.15.1 hunks that fail to apply on ours (dry-run). Paths relative to `apps/electron/src/renderer/components/`.

| Path | Ours | div | fail | Method | Row |
| --- | --- | --- | --- | --- | --- |
| KeyboardShortcutsDialog.tsx | absent (retired P2.441) | — | — | N/A; look → R5 ShortcutsPage | — |
| ResetConfirmationDialog.tsx | yes | 2 | 1/3 | apply hunks | R6-07 |
| RtkUpdateDialog.tsx | absent (UB7.4 creates) | — | — | fold into UB7.4 | R6-14 |
| apisetup/ApiKeyInput.tsx | yes | 373 | 10/25 | merge per hunk | R6-09 |
| app-menu/DesktopAppMenu.tsx | yes | 4 | 0/2 | apply hunks | R6-03 |
| automations/BatchAutomationMenu.tsx | yes | 11 | 0/1 | apply hunks | R6-03 |
| info/Info_HeaderMenu.tsx | absent | ADDED | — | add 1:1 | R6-03 |
| messaging/LarkConnectDialog.tsx | absent (removed) | — | — | N/A (OQ-43.10) | — |
| messaging/PairingCodeDialog.tsx | absent (removed) | — | — | N/A | — |
| messaging/TelegramConnectDialog.tsx | absent (removed) | — | — | N/A | — |
| messaging/TelegramSupergroupPairingDialog.tsx | absent (removed) | — | — | N/A | — |
| messaging/WhatsAppConnectDialog.tsx | absent (removed) | — | — | N/A | — |
| onboarding/APISetupStep.tsx | yes | 20 | 0/6 | apply hunks | R6-08 |
| onboarding/CompletionStep.tsx | yes | 4 | 0/1 | apply hunks | R6-08 |
| onboarding/CredentialsStep.tsx | yes | 117 | 1/2 | apply ChatGPT hunk; Copilot N/A | R6-08 |
| onboarding/GitBashWarning.tsx | yes | 0 | 0/5 | take 1:1 | R6-08 |
| onboarding/LocalModelStep.tsx | yes | 2 | 0/4 | apply hunks | R6-08 |
| onboarding/OnboardingWizard.tsx | yes | 79 | 0/1 | apply hunk | R6-08 |
| onboarding/ProviderMark.tsx | absent | ADDED | — | HAVE equivalent; not added | R6-08 |
| onboarding/ProviderSelectStep.tsx | yes | 149 | 3/4 | merge | R6-08 |
| onboarding/ReauthScreen.tsx | yes | 2 | 0/6 | apply hunks | R6-08 |
| onboarding/primitives.tsx | yes | 0 | 0/7 | take 1:1 | R6-08 |
| projects/CreateProjectDialog.tsx | yes | 5 | 0/2 | apply hunks | R6-07 |
| ui/CompactWorkingDirectorySelector.tsx | yes | 38 | 0/4 | apply hunks | R6-07 |
| ui/EditPopover.tsx | yes | 494 | 2/4 | apply EditButton + TWEEN; prompt sentence → B4 | R6-06 |
| ui/HeaderIconButton.tsx | yes | 0 | 0/3 | take 1:1 | R6-03 |
| ui/HeaderMenu.tsx | yes | 6 | 0/1 | apply hunk | R6-03 |
| ui/TopBarButton.tsx | yes | 0 | 0/2 | take 1:1 | R6-03 |
| ui/__tests__/source-connection-status.test.ts | absent | ADDED | — | DROP; cases adapted into R6-12 tests | R6-12 |
| ui/__tests__/workspace-avatar-color.test.ts | absent | ADDED | — | add (copy+adapt) | R6-13 |
| ui/avatar.tsx | yes | 0 | 0/3 | take 1:1 | R6-01 |
| ui/button.tsx | yes | 0 | 0/3 | take 1:1 + tooltip subpath | R6-01 |
| ui/collapsible.tsx | yes | 0 | 0/1 | take 1:1 + subpath; R2/R7 coordination | R6-02 |
| ui/color-picker.tsx | yes | 2 | 0/1 | apply hunk | R6-07 |
| ui/command.tsx | yes | 0 | 0/10 | take 1:1 | R6-02 |
| ui/context-menu.tsx | yes | 0 | 0/9 | take 1:1 | R6-02 |
| ui/dialog.tsx | yes | 0 | 0/6 | take 1:1 | R6-02 |
| ui/dropdown-menu.tsx | yes | 0 | 0/9 | take 1:1 | R6-02 |
| ui/empty.tsx | yes | 0 | 0/4 | take 1:1 | R6-04 |
| ui/entity-list-empty.tsx | yes | 7 | 1/2 | merge (keep type + lang) | R6-04 |
| ui/entity-list-label-badge.tsx | yes | 0 | 0/3 | take 1:1 | R6-06 |
| ui/entity-list.tsx | yes | 24 | 0/3 | apply hunks | R6-04 |
| ui/entity-row.tsx | yes | 32 | 2/12 | merge (keep disabled/type) | R6-04 |
| ui/hotkey-keycaps.tsx | absent | ADDED | — | add 1:1 | R6-01 |
| ui/inline-color-picker-row.tsx | yes | 7 | 0/2 | apply hunks | R6-07 |
| ui/inline-menu-styles.ts | absent | ADDED | — | add 1:1 | R6-05 |
| ui/input.tsx | yes | 0 | 0/2 | take 1:1 | R6-01 |
| ui/kbd.tsx | yes | 0 | 0/2 | take 1:1 | R6-01 |
| ui/label-menu.tsx | yes | 4 | 2/9 | merge (keep i18n) | R6-06 |
| ui/label-value-popover.tsx | yes | 4 | 0/14 | apply hunks | R6-06 |
| ui/mention-badge.tsx | yes | 10 | 0/2 | apply hunks | R6-03 |
| ui/mention-menu.tsx | yes | 701 | 5/8 | merge per hunk | R6-05 |
| ui/metadata-badge.tsx | yes | 0 | 0/2 | take 1:1 | R6-03 |
| ui/popover.tsx | yes | 0 | 0/1 | take 1:1 | R6-02 |
| ui/rename-dialog.tsx | yes | 0 | 0/2 | take 1:1 | R6-07 |
| ui/rich-text-input.tsx | yes | 126 | 2/11 | merge per hunk | R6-05 |
| ui/scroll-area.tsx | yes | 14 | 0/2 | apply hunks | R6-02 |
| ui/select.tsx | yes | 6 | 0/5 | apply hunks | R6-01 |
| ui/session-status-menu.tsx | yes | 6 | 2/6 | merge (keep empty key) | R6-06 |
| ui/skeleton.tsx | absent | ADDED | — | add 1:1 | R6-01 |
| ui/skill-mention-menu.tsx | yes | 33 | 2/3 | merge | R6-05 |
| ui/slash-command-menu.tsx | yes | 670 | 9/13 | merge per hunk | R6-05 |
| ui/sonner.tsx | yes | 0 | 0/1 | take 1:1 + Spinner subpath | R6-02 |
| ui/source-avatar.tsx | yes | 233 | 2/3 | merge (ring only) | R6-04 |
| ui/source-connection-status.ts | absent | ADDED | — | DROP file; ADAPT on summary | R6-12 |
| ui/source-status-indicator.tsx | yes | 277 | 1/1 | N/A for the hunk (re-export of a deleted fn); R6-12 edits this file | R6-12 |
| ui/styled-context-menu.tsx | yes | 0 | 0/5 | take 1:1 | R6-02 |
| ui/switch.tsx | yes | 0 | 0/2 | take 1:1 | R6-01 |
| ui/tabs.tsx | yes | 0 | 0/4 | take 1:1 | R6-01 |
| ui/textarea.tsx | yes | 0 | 0/1 | take 1:1 | R6-01 |
| ui/workspace-avatar-color.ts | absent | ADDED | — | add via UB7.2 | R6-13 |
| ui/workspace-avatar.tsx | absent (UB7.2 creates) | — | — | UB7.2 takes v0.15.1 | R6-13 |

## 6. Owner questions

None. Two choices were decided under the owner rules and are recorded in their rows: the composer caret menus drop their `--composer-radius-eff` radius coupling (R6-05; "the LOOK follows upstream"), and the status menu keeps our more specific, test-pinned empty-state string (R6-06; equivalent behaviour). The Cloudflare preset follows B2's decision and stays hidden under DA1.53 either way (R6-09).

## 7. Coverage

- Assigned: 72 paths (`R6-paths.txt`). Read: 72 (every hunk of the 5156-line v0.14.0..v0.15.1 diff; 32 of our diverged counterparts diffed against upstream v0.14.1; the patch dry-run over all 55 files we have). Skipped: 0.
- Overlaps relied on: R1 (tokens/CSS/motion export, playground registries), R2 (AppShell `springTransition`, `PanelStackContainer` toast anchor, `SessionItem`/`ChatHeaderLabels`/`SessionBadges`/`CompactSessionMenu`/`ChatHeaderStatusButton`/`SkillInfoPage`/`SourceInfoPage`/`DetailEmptyState`/`SidebarPane`/`new-chat-suggestions` consumers), R3 (`TranscriptStates` skeleton/serif), R4 (`FreeFormInput` `onTextPaste`, `ComposerModeChip`/`CompactPermissionModeSelector`), R5 (`ShortcutsPage` Kbd look, `AppearanceSettingsPage` avatar), R7 (`AnimatedCollapsibleContent`, `useDelayedLoading`, `AutomationInfoPage`, `info/index.ts`), B2 (`cloudflare-gateway.ts`), B3 (sources), B4 (labels semantics, EditPopover prompt sentence).
