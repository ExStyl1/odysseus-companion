# R4 — Composer slice (upstream v0.14.0 → v0.15.1)

Analyst: R4, 2026-10-14. Read-only. Upstream read by tag from `.references/craft-agents-oss`; ours at HEAD of `feat/TCODE-000-1-41-0` (f495cf311).

Prefixes: `U:` = `apps/electron/src/renderer/components/app-shell/input/` upstream, `O:` = the same directory in our repo.

## 1. Summary

- **What changed upstream.** v0.14.1 changed nothing in this slice. Nearly all of it is v0.15.0, "A new look": the composer becomes "one raised card with quiet toolbar chips". v0.15.1 adds one functional change: an attachment-size pre-check inside `FreeFormInput`.
- **FreeFormInput was split up.** Its inline JSX moved into 7 new components: `SendButton`, `ComposerModeChip`, `ComposerModelMenu`, `ComposerSourcesChip`, `ContextUsageChip`, `FollowUpChips`, `ComposerHintLine`. Two style modules came with them: `composer-styles.ts` (role-token class strings) and `action-hotkey.ts` (keycaps from the action registry). The file shrank from 2468 to 1938 lines.
- **New toolbar layout.** Left: attach · sources · folder. Right: mode · model, then the context chip and Send. The permission-mode chip moved from the badge row into the toolbar on desktop. The badge row shows the mode only while a decision prompt replaces the toolbar.
- **Shortcut hints.** A new line under the card fades in on focus and shows the send, new-line and ⇧Tab keys.
- **Decision cards.** Permission, credential and admin prompts now share one anatomy, `structured/DecisionCard.tsx`: an icon tile, a sunken mono preview well, primary/secondary/ghost actions and a quiet foot. The composer card draws an info ring, or a destructive ring when a permission request carries decision-model risks (`structured/decision-tone.ts`).
- **Functional changes inside the redesign:**
  - a pasted console snippet offers "Run in background" (`PastedCommandChip` in `ChatInputZone`);
  - attachment size limits are checked before reading or sending;
  - keyboard tips leave the compact placeholder rotation;
  - re-adding an applied valued label no longer appends a bare duplicate;
  - label and status chips leave the badge row for the chat header;
  - reduced motion skips the height animation;
  - background-task props are renamed (stop, dismiss, open output);
  - the kanban "+ New Task" button moves to the column header.
- **Our composer diverged on purpose.** The Codex-desktop composer parity work of 2026-07-04/05 (plan archived at `git show 2374bbb53^:docs/current-plans/codex-composer/README.md`) gave us a glass squircle surface, a grid footer, a 4-state submit, a queue, a context donut, an effort pill, a cwd + branch footer under the card, and capability-driven slots.
- **Disposition.** Take the LOOK 1:1 and keep the BEHAVIOUR. The toolbar order, materials, decision-card anatomy and hint line come from upstream. Every behaviour listed in §4 is re-applied on top.

## 2. Proposed rows

Shared preconditions for every row:
- **R1** has landed the token/material/motion layer (`packages/ui/src/styles/tokens.css`, `index.css`, `packages/ui/src/motion/*`). Without it, utility classes such as `h-control`, `bg-raised`, `shadow-elev-*`, `text-label*`, `bg-fill-hover`, `bg-info-tint`, `motion-press`, `state-overlay`, `min-h-row-touch`, `field-surface`, the `--info-border`/`--destructive-border` variables and `TWEEN`/`DURATION`/`EASE` do not exist in ours.
  - Positive control: `rg -c 'h-control|bg-raised|shadow-elev|text-label|bg-fill-hover|text-tertiary'` over `apps/electron/src/renderer/index.css` and `packages/ui/src/styles/index.css` returned nothing at HEAD.
  - The same classes are present in `v0.15.1:apps/electron/src/renderer/index.css`, e.g. `.input-toolbar-btn` at its line 559.
- **R6** has landed `components/ui/button.tsx` (`IconButton`, `variant="primary"`, `size="lg"`), `kbd.tsx`, `popover.tsx`, `slash-command-menu.tsx` (`PermissionModeIcon`, re-keyed to OUR six modes), `rich-text-input.tsx` (`onTextPaste`) and `CompactWorkingDirectorySelector.tsx`.

Every visual row is checked in DARK theme first, in the playground entries named in the row and in a CDP screenshot. The case id is taken from `docs/testing/cdp-live-checklist.md` at row time. The new composer visual case is born in R4-14 and the earlier rows add arms to it.

---

**R4-01 `[design]` `[composer]` Composer materials and decision-card primitives (S).**
- **Needs:** R1 (tokens, motion), R6 (`kbd.tsx`, `button.tsx`). Must land BEFORE:
  - R2's `ActiveOptionBadges.tsx` row (upstream imports `ComposerModeChip`, which needs these styles);
  - the `components/chat/AuthRequestCard.tsx` row (R3/B4). At `v0.15.1:apps/electron/src/renderer/components/chat/AuthRequestCard.tsx:21` it imports from `input/structured/DecisionCard`.
- **Upstream:**
  - `v0.15.0:` `U:composer-styles.ts` (ADDED): `COMPOSER_CHIP`, `COMPOSER_META_CHIP`, `MODE_CHIP_TONE`, `MODE_ICON_TONE`, `knownMode`.
  - `U:action-hotkey.ts` (ADDED): `actionHotkeyKeys`, `composerSendKeys`.
  - `U:structured/DecisionCard.tsx` (ADDED): `DecisionCard/Body/Header/Details/Preview/Actions/Foot/Spacer`, `decisionRingClass`, `DECISION_ACTION`.
  - `U:structured/decision-tone.ts` (ADDED): `getDecisionTone`, `knownPermissionRisks`.
- **Files (ours):** new `O:composer-styles.ts`, `O:action-hotkey.ts`, `O:structured/DecisionCard.tsx`, `O:structured/decision-tone.ts`.
- **Method:**
  - `action-hotkey.ts` and `DecisionCard.tsx`: take 1:1. Brand imports only. `actions['chat.cyclePermissionMode']` exists at `apps/electron/src/renderer/actions/definitions.ts:214`.
  - `composer-styles.ts`: take, then re-key `MODE_CHIP_TONE`, `MODE_ICON_TONE` and `knownMode` to OUR `PermissionMode` (`'dontAsk'|'plan'|'default'|'acceptEdits'|'auto'|'bypassPermissions'`, `packages/shared/src/agent/mode-types.ts:38`).
  - The tone of each mode keeps today's mapping (`O:CompactPermissionModeSelector.tsx:24-49`: dontAsk neutral, plan accent, default info, acceptEdits success, auto info, bypassPermissions accent), expressed in upstream's role classes. The fallback for an unknown mode becomes `'default'`, not `'ask'`.
  - `decision-tone.ts`: take. Its risk arm needs `PermissionRisk` and `PermissionRequest.risks`, which ours lacks. `rg 'risks|PermissionRisk'` finds nothing in `packages/core/src/types/message.ts`; positive control: the same probe hits `canRemember`/`noAlwaysAllow` in `O:structured/PermissionRequest.tsx:498`. Those come from draft UB6.10, which is ⏸ on OQ-43.2.
    - Default: if UB6.10's type hunk has landed, take the file verbatim.
    - Otherwise ship `getDecisionTone` with the risk arm absent (always `'info'`), and UB6.10 re-adds it in the same commit as its badges.
    - Our extra structured types (`ask_user`, `workflow_launch`, the `outside_root`/outside-read/artifact/reopen/worktree permission variants) resolve to `'info'`.
- **Keep:** our six modes and their current tone semantics; nothing here reads `providerType` (decision 3a).
- **Tests:** new `O:__tests__/composer-styles.test.ts` and `O:structured/__tests__/decision-tone.test.ts`.
  - Positive: every member of `PERMISSION_MODE_ORDER` has a `MODE_CHIP_TONE` and a `MODE_ICON_TONE` entry, and `composerSendKeys('cmd-enter').send` is `[mod, ↵]`.
  - Negative / boundary: `knownMode('guarded' as never)` → `'default'`; a permission state with no risks → `'info'`.
- **Runtimes:** neutral.
- **Done means:** the four files exist with Apache-2.0 source headers; tsc is clean; R2 and AuthRequestCard can import them.

**R4-02 `[design]` `[composer]` Leaf files taken 1:1 (S).**
- **Needs:** R4-01, R1, R6 (`kbd.tsx`).
- **Upstream (`v0.15.0`):**
  - `U:FreeFormInputContextBadge.tsx`: `COMPOSER_CHIP`, ellipsis instead of `FadingText`, `aria-expanded`, `data-badge-label`.
  - `U:ToolbarStatusSlot.tsx`: opaque `bg-raised` + info/accent tint overlays, `TWEEN`.
  - `U:InputErrorBoundary.tsx`: decision-style fallback card.
  - `U:ImageSupportWarningBanner.tsx`: `bg-info-tint` banner.
- **Files:** `O:FreeFormInputContextBadge.tsx` (div 0), `O:ToolbarStatusSlot.tsx` (div 0), `O:InputErrorBoundary.tsx` (div 13), `O:ImageSupportWarningBanner.tsx` (div 58).
- **Method:**
  - The two div-0 files: take 1:1.
  - `InputErrorBoundary`: take v0.15.1 and re-apply our no-Sentry hunk. Ours logs with `console.error` and has no `@sentry/electron` import; upstream base line 2 imports Sentry.
  - `ImageSupportWarningBanner`: take v0.15.1 classes and re-apply:
    - the optional `onEnable` (the action renders only when it is passed);
    - the `refusalSentence` line, P6.584 (`chat.imageWarning.endpointSaid`), restyled `text-tertiary italic`;
    - the docblocks.
- **Keep:** the P6.584 refusal sentence; optional enable (`resolveStagedImagePolicy`); no Sentry.
- **Tests:**
  - `learn-image-refusal-wiring.test.ts` (existing) stays green. Positive: a banner with a `refusalSentence` renders it.
  - New arm in `staged-image-send-guard.test.ts` or a new `image-support-banner.test.tsx`. Negative: a banner without `onEnable` renders no action button.
  - Playground: `image-support` entries and `input-container` with `isProcessing` (escape overlay), dark.
- **Runtimes:** neutral. The banner is shown on any runtime that declares no images.
- **Done means:** the diff against v0.15.1 is limited to the listed hunks.

**R4-03 `[design]` `[kanban]` NewTaskComposer opened from the column header (XS).**
- **Needs:** R2's `kanban/KanbanColumn.tsx` row, landing in the SAME commit. Upstream moved the "+" into the column header and the composer now takes `open/onOpenChange`. Ours calls `<NewTaskComposer onCreate={onCreateTask} />` (`apps/electron/src/renderer/components/app-shell/kanban/KanbanColumn.tsx:132`).
- **Upstream:** `v0.15.0:apps/electron/src/renderer/components/app-shell/kanban/NewTaskComposer.tsx`: dashed button removed, `field-surface` textarea.
- **Files:** `kanban/NewTaskComposer.tsx` (div 2: only our copy header).
- **Method:** take 1:1. The header comment is updated to "copied from v0.15.1 … by R4-03".
- **Keep:** the provenance header.
- **Tests:** existing kanban tests under `kanban/__tests__/`.
  - Positive: with `open` the textarea is focused and Enter creates a tile.
  - Negative: with `open=false` nothing renders, so no stray dashed button.
  - Playground `kanban` entry, dark.
- **Runtimes:** neutral.
- **Done means:** a task can be created from the header "+" and the old button is gone.

**R4-04 `[design]` Credential and admin cards on the decision anatomy (M).**
- **Needs:** R4-01.
- **Upstream:** `v0.15.0:U:structured/CredentialRequest.tsx` and `U:structured/AdminApprovalRequest.tsx`: DecisionCard/Header/Details/Preview/Actions/Foot; Save primary, Cancel ghost (no icons); "encrypted at rest" foot with `ShieldCheck`; reveal buttons get `aria-label`.
- **Files:** `O:structured/CredentialRequest.tsx` (div 16), `O:structured/AdminApprovalRequest.tsx` (div 86).
- **Method:**
  - `CredentialRequest`: take v0.15.1 and re-apply OUR i18n. Keep our keys: `auth.authenticationRequired`, `auth.enterField`, `common.save`, `common.cancel`, `auth.credentialsEncryptedAtRest`. Upstream still hard-codes Save, Cancel and the foot in English. New aria keys: `chat.credentials.hideValue` and `chat.credentials.showValue` (en + ru).
  - `AdminApprovalRequest`: merge. Take the anatomy and re-apply:
    - `adminApprovalCardData` (F1.885);
    - `canRemember` (no switch without a lifetime or with `noAlwaysAllow`, F1.869/F1.885);
    - `ruleSentence`;
    - the `Trans`-based i18n (F1.554).
- **Keep:** F1.554, F1.869, F1.885, all i18n.
- **Tests:** `structured/__tests__/AdminApprovalRequest.test.tsx` (existing).
  - Positive: a card with `rememberForMinutes` shows the switch inside `DecisionActions`.
  - Negative: a `noAlwaysAllow` card shows no switch.
  - New `CredentialRequest.test.tsx`. Positive: Save is `type="submit"`, Cancel is `type="button"` (the upstream 0.15.0 cancel-must-not-submit invariant; ours already holds it at `O:structured/CredentialRequest.tsx:295`). Negative: Escape calls `onResponse({cancelled:true})` with no value.
  - Playground `input-container` inputMode `admin_approval` / `admin_approval_ask_rule`, dark.
- **Runtimes:** neutral. Admin cards come from Claude and Pi.
- **Done means:** both cards render as decision cards and every F-row behaviour is pinned.

**R4-05 `[design]` `[permissions]` PermissionRequest on the decision anatomy (L).**
- **Needs:** R4-01. Pairs with draft UB1.2 (`canRemember`, Always Allow hidden without a key) and UB6.10 (risk chips). Whichever lands later re-applies its hunk inside `DecisionDetails`/`DecisionActions`.
- **Upstream:** `v0.15.0:U:structured/PermissionRequest.tsx`:
  - Hand / TriangleAlert tile;
  - `toolName` in mono;
  - risk chips as `bg-destructive-tint` pills;
  - command in `DecisionPreview`;
  - Allow primary · Always Allow secondary · `DecisionSpacer` · Deny ghost;
  - the Always-Allow tip moves to `DecisionFoot`.
- **Files:** `O:structured/PermissionRequest.tsx` (897 lines, div 842).
- **Method:** per-hunk merge, LOOK only. Every variant keeps its behaviour and maps onto the anatomy:
  - outside-root header and answers;
  - outside-read three-answer row (P6.202);
  - artifact publish (`ArtifactPublishDetails`);
  - reopen compact / don't-ask (P6.500/P6.950);
  - worktree cleanup;
  - "Yes, and switch to auto mode" (P6.208, `shouldOfferAutoModeSwitch`);
  - subagent label row (`agentLabel`);
  - impact block (moves INSIDE `DecisionDetails` above the preview; its "outranks the description" placement is kept);
  - session-only Always Allow labels;
  - the permission comment / answer note (`answerNoteOffered`).
- Button mapping:
  - the affirmative answer → primary;
  - the durable "allow" answers → secondary;
  - refusals → ghost after `DecisionSpacer`;
  - the dashed-destructive styles disappear (upstream dropped them).
- **Keep:** all of the above; the exported pure helpers (`shouldOfferAutoModeSwitch`, `permissionRememberScope`, `alwaysAllowIsSessionOnly`, `alwaysAllowKeepsSessionKeyOnly`, `answerNoteOffered`, `permissionAnswerResponse`) stay untouched.
- **Tests:** `structured/__tests__/PermissionRequest.test.tsx` (existing; it asserts behaviour, not classes, so it should stay green).
  - Positive: an outside-read card still renders three answers inside `DecisionActions` and the auto-switch button is present when offered.
  - Negative: a worktree-cleanup card renders no Always Allow.
  - Playground `input-container` inputMode `permission` / `permission_impact` plus `permission-input-toggle`, dark.
  - CDP: a Bash prompt on each runtime, card screenshot.
- **Runtimes:** pi/claude/codex. Each runtime's own card variants are kept.
- **Done means:** every existing permission test is green and the card is visually upstream's.

**R4-06 `[design]` Our-only structured cards adopt the anatomy (M).**
- **Needs:** R4-01.
- **Upstream:** no counterpart. Consistency with `DecisionCard` is the rule ("look follows upstream").
- **Files:** `O:structured/AskUserRequest.tsx` (526), `O:structured/WorkflowLaunchRequest.tsx` (84), `O:structured/ArtifactPublishDetails.tsx` (138, re-hosted in `DecisionDetails`).
- **Method:** restyle only. DecisionHeader / Body / Actions; the primary answer primary, the others secondary/ghost.
- **Keep:** the AskUserQuestion multi-question/option behaviour, workflow-launch semantics and artifact publish details.
- **Tests:** existing `WorkflowLaunchRequest.test.tsx`, `ArtifactPublishDetails.test.tsx`, `chat-share-card.test.tsx` stay green.
  - Positive: an ask-user card with 2 questions still submits both answers.
  - Negative: a workflow launch with no steps still renders Cancel.
  - Playground inputMode `workflow_launch`, dark.
- **Runtimes:** claude (AskUserQuestion), pi/claude (workflows).
- **Done means:** no structured card in `O:structured/` keeps the old `bg-info/5 border-info/30` material (`rg 'bg-info/5' O:structured` → 0, with a planted control).

**R4-07 `[design]` InputContainer: one raised card, decision ring, `peer/composer` (S).**
- **Needs:** R4-01, R1.
- **Upstream:** `v0.15.0:U:InputContainer.tsx`:
  - `rounded-xl bg-raised`;
  - `shadow-elev-1`, or `shadow-elev-0` when the panel is unfocused;
  - `focus-within:ring-1 ring-focus/55`;
  - `decisionRingClass(getDecisionTone(...))` for structured modes;
  - `peer/composer` wrapper;
  - `DURATION.base` / `EASE.standard`;
  - `prefersReducedMotion()` → duration 0.
- **Files:** `O:InputContainer.tsx` (div 91).
- **Method:** merge. Replace our `composer-surface … bg-background/95 backdrop-blur-lg` (`O:InputContainer.tsx:278-280`) with upstream's card. Re-apply:
  - `workflow_launch: 200` fallback (`:34`);
  - our `structured-height` clamp (we never took `composer-height`/`useInputAvailableHeight`; that stays draft UB5.4's measurement);
  - P6.208 mode forwarding (`:244-255`);
  - the "leaving structured layer gets no exit animation" rule (`:294-319`);
  - the UA1.15 docblock (`:327`).
- **Keep:** the four items above.
- **Tests:** `structured-height.test.ts` (existing) green.
  - New arm in a source-level `input-container-look.test.ts`. Positive: structured mode with a permission state carries the info ring class. Negative: freeform carries the focus ring and no decision ring.
  - Playground `input-container` (freeform and permission), plus `container-transitions` with reduced motion emulated, dark.
- **Runtimes:** neutral.
- **Done means:** `rg 'composer-surface' apps/electron/src/renderer/components` → 0. R1 can then drop `.composer-surface` from `index.css:1517-1528`; R1 must not drop it before this row lands.

**R4-08 `[design]` `[composer]` Send, context and follow-up chips (M).**
- **Needs:** R4-01, R6 (`button.tsx` `primary`/`icon`).
- **Upstream:**
  - `v0.15.0:U:SendButton.tsx` (ADDED): a round 28px accent primary that morphs to Stop, `send-btn` hook, press .94.
  - `U:ContextUsageChip.tsx` (ADDED): an info-tint ring + percent chip, compact-on-click.
  - `U:FollowUpChips.tsx` (ADDED): follow-up chips with TWEEN fade and a ≤ 4px rise, `keycap` index.
- **Files:** new `O:SendButton.tsx`, `O:ContextUsageChip.tsx`, `O:FollowUpChips.tsx`; `O:composer-parts.tsx` (`ContextUsageDonut` / `ContextUsageUnknownDonut` fold into the chip's ring; `ComposerFooterLabel` / `ComposerFooterDivider` retire with the grid footer in R4-11).
- **Method:**
  - `FollowUpChips`: take 1:1. Ours is still the inline v0.14.0 block (`O:FreeFormInput.tsx` follow-up section), so it is equivalent behaviour.
  - `SendButton`: ADAPT. Take the material and the `data-state` morph, and extend the props with our `SubmitMode` (`send|queue|steer|stop|loading`, `O:submit-control.ts`), `inert`, the loading spinner and our tooltip. The tooltip covers: blocked reason; queue/steer keys; Esc Esc; the mid-stream override line P6.946/F1.331.
  - `ContextUsageChip`: ADAPT. Take the chip and ring material. Drive it from OUR `resolveContextMeterState` (`O:context-meter-state.ts`), not upstream's `context-display.ts` (ours has no `context-display.ts`).
    - Keep our visibility: always shown when `composerCapabilities.contextMeter`. The donut has been a quiet, neutral, always-visible meter since the codex parity wave (Task 1.7).
    - Upstream shows the chip only at warning. On ours the WARNING state takes upstream's info-tint chip 1:1; the quiet state is the ring alone, `text-tertiary`.
    - Keep the unknown-window twin (`ContextMeterUnknownWindow`), the combined threshold label and the fallback-window note.
- **Keep:** the 4-state submit (codex wave 2.7), F1.331, P6.946, the context meter semantics (owner 2026-08-08).
- **Tests:**
  - `submit-control.test.ts` (existing) green.
  - New `send-button.test.tsx`. Positive: `mode='steer'` renders a submit button labelled with the steer label. Negative: `mode='stop'` with `inert` renders a `type="button"` that does not call `onStop`.
  - `context-meter-state.test.ts` (existing; lines 10, 221 and 356 import `composer-parts` donuts, so repoint them to the chip). Positive: warning → a button that compacts. Negative: unknown window → the broken ring, never `percent={0}`.
  - Playground `input-container` with isProcessing, plus the queue knobs, dark.
- **Runtimes:** neutral. The meter shows per `contextMeter` capability (codex/claude/pi as resolved).
- **Done means:** Stop is accent, not grey; the queue/steer tooltips are unchanged.

**R4-09 `[design]` `[permissions]` Mode chip in the toolbar (M).**
- **Needs:** R4-01, R6 (`slash-command-menu.tsx` `PermissionModeIcon` keyed to our modes, `popover.tsx`, `kbd.tsx`).
- **Upstream:**
  - `v0.15.0:U:ComposerModeChip.tsx` (ADDED): a tinted 28px pill; `Popover` + `SlashCommandMenu bare showDescriptions showFilter` with a footer showing the cycle hotkey keycaps; icon-only under 32rem.
  - `U:CompactPermissionModeSelector.tsx`: the `MODE_CHIP_TONE` pill and `min-h-row-touch` drawer rows; icon-only under 24rem.
- **Files:** new `O:ComposerModeChip.tsx`; `O:CompactPermissionModeSelector.tsx` (div 156); the desktop mode dropdown leaves `O:FreeFormInput.tsx:2611-2700`.
- **Method:**
  - `ComposerModeChip`: ADAPT. Take the trigger, the popover material and the hotkey footer. The menu CONTENT stays ours: `permissionModeMenuDisplays` from `@/lib/composer-permission-modes`, with:
    - descriptions at the measured 440px width (R15);
    - digit shortcuts (`selectPermissionModeByDigit`, `O:FreeFormInput.tsx:2642`);
    - `PermissionModeItemTitle` / `PermissionModeItemTrailing` decorations (F1.1052);
    - the single runtime note (`permissionModeRuntimeNote`, `:1121`);
    - `locked` from capabilities.
  - It is rendered through `SlashCommandMenu bare` only if R6's port carries descriptions, decorations and a footer. Otherwise it keeps `StyledDropdownMenuContent` with upstream menu tokens.
  - `CompactPermissionModeSelector`: take the v0.15.1 trigger and row classes, and re-apply our row parts (`PermissionModeBadge`, decorations, runtime note, locked).
  - Drop upstream's `useAvailablePermissionModes` (Guarded / decision layer); our list comes from capabilities.
- **Keep:** the six Claude-native modes, the workspace cycle (`applyWorkspaceCycleToComposerModes`), digit shortcuts, runtime note, locked mode.
- **Tests:**
  - `apps/electron/src/renderer/lib/__tests__/composer-permission-modes.test.ts` (existing) green.
  - New `composer-mode-chip.test.tsx`. Positive: the chip renders `data-mode` and the tone class for `acceptEdits`. Negative: `locked` disables the trigger and the menu does not open.
  - Playground `parity-permission-mode-selector` (`playground/registry/parity-ui.tsx:863`), dark; compact at 375px.
- **Runtimes:** pi/claude/codex (codex's runtime note is shown once).
- **Done means:** the desktop mode control sits in the right toolbar group with upstream's look; ⇧Tab cycling is unchanged.

**R4-10 `[design]` `[runtimes]` Model menu: our DesktopModelPickerMenu becomes ComposerModelMenu (L).**
- **Needs:** R4-01. Overlaps B2 (runtimes/models): our runtime-switch rows are B2-neutral, but any v0.15.x model-catalogue change lands through B2's rows.
- **Upstream:**
  - `v0.15.0:U:ComposerModelMenu.tsx` (ADDED): trigger + content extracted from FreeFormInput; `COMPOSER_CHIP` trigger; `MENU_GROUP_LABEL` / `ITEM_NAME` / `ITEM_DESCRIPTION` row classes; `bg-fill-selected`.
  - `U:CompactModelSelector.tsx`: `COMPOSER_CHIP` trigger, a `Cpu` glyph replacing the name under 26rem, `SHEET_ROW` / `SHEET_SECTION` rows, `size-9` vision toggle.
- **Files:**
  - `O:DesktopModelPickerMenu.tsx` (421 lines, D1.214) → renamed `O:ComposerModelMenu.tsx` (upstream's name). It now also owns the trigger, which moves out of `O:FreeFormInput.tsx:2908-2952`.
  - `O:CompactModelSelector.tsx` (div 337).
  - `O:ModelListDisclosures.tsx` and `O:ConnectionRow.tsx` restyled.
- **Method:** merge. Take upstream's trigger, row and menu classes. Re-apply:
  - `ConnectionRow` (runtime switch with preview / confirm, `RuntimeSwitchDialog`);
  - `ModelListDisclosures` (RS-44/DA2.23);
  - the translated-wire and catalogue-unlisted marks (DA2.25);
  - capability-driven reasoning levels (`composerCapabilities.reasoning.levels`, not global `THINKING_LEVELS`);
  - the effort pill on the trigger (codex wave 3.2, F1.1266; `O:FreeFormInput.tsx:2930-2934`), restyled as a quiet inner pill;
  - ultracode in compact (QK5);
  - `onPreviewConnectionChange`;
  - `switchable` from capabilities.
  - Keep D1.214's docblock reason; the harness now covers the trigger too.
- **Keep:** the three-runtime switching, gateway model aliases (displayed through `stripPiPrefixForDisplay` / catalogue), vision toggles, `connectionUnavailable`.
- **Tests:**
  - `model-list-disclosures.test.tsx`, `model-picker-helpers.test.ts`, `picker-mode.test.ts`, `runtime-switch-copy.test.ts`, `ultracode-toggle.test.ts` (existing) green; repoint any `DesktopModelPickerMenu` import.
  - Positive: on an empty session with 2 connections the menu renders a `ConnectionRow` per runtime and the effort pill shows `t(getThinkingLevelNameKey('high'))`.
  - Negative: with `reasoning.levels=[]` no effort pill and no thinking sub-menu render.
  - Playground `runtime-switch`, `runtime-switch-costs`, plus the compact model-picker entries, dark.
  - CDP: the model menu opened on a claude-gateway, a codex and a pi session.
- **Runtimes:** pi/claude/codex.
- **Done means:** `rg 'DesktopModelPickerMenu' apps` → 0 (the rename is complete); the picker shows the same rows as before in upstream's look.

**R4-11 `[design]` `[composer]` Sources chip, folder selector and branch chip in the toolbar (M).**
- **Needs:** R4-01, R4-02, R6 (`CompactWorkingDirectorySelector.tsx`, `popover.tsx`, `source-avatar.tsx`).
- **Upstream:**
  - `v0.15.0:U:ComposerSourcesChip.tsx` (ADDED): `SourceStack` on `rounded-xs bg-raised shadow-elev-0` tiles; compact = drawer, desktop = popover.
  - `U:WorkingDirectorySelector.tsx`: menu material `min-h-row-menu`, `bg-fill-selected`, `text-tertiary`, remove-recent `aria-label`.
- **Files:** new `O:ComposerSourcesChip.tsx`; new `O:WorkingDirectorySelector.tsx`; `O:FreeFormInput.tsx` (`WorkingDirectoryBadge`, `:3063-3275`); `O:BranchSwitcher.tsx`; `O:ChatInputZone.tsx:257-271` (the external footer row).
- **Method:**
  - **Sources:** ADAPT. Take the chip and the stack. Source identity becomes ONE function, `source.mention?.id ?? source.logicalName`, for both compact and desktop. Ours uses `SafeCapabilitySummary` (`O:FreeFormInput.tsx:229`), not `LoadedSource.config.slug`.
    - Latent inconsistency fixed: the compact chip counts by `s.logicalName` (`O:FreeFormInput.tsx:2534`, `:2566`) while the desktop chip (`:2728`, `:2760`) and `CompactSourceSelector.tsx:85` key on `mention?.id ?? logicalName`.
    - Harmless today, because a source's `mention.id` is its `logicalName` (`packages/shared/src/capabilities/views.ts:485`). Confidence high.
    - Labels: `mention?.label ?? logicalName`. The stale-slug guard "never '0 sources'" is kept.
  - **Folder:** extract our `WorkingDirectoryBadge` popover body into `O:WorkingDirectorySelector.tsx` with upstream's `renderTrigger` shape and v0.15.0 menu classes. The change callback stays typed `IssuedProjectHandle` (owner 2026-09-23; `kanban/TaskEditor.tsx:14-17` keeps our `CompactWorkingDirectorySelector`). Re-apply:
    - D1.251 (session storage directory in the tooltip);
    - `ServerDirectoryBrowser`;
    - UA12.206 (`chat.workInFolder`).
    - Upstream's remove-recent X: ours has no remove-recent at all (`use-working-directory-state.ts` exposes none; `rg 'handleRemoveRecent'` → 0, positive control `handleSelectRecent` hits). That is a pre-delta divergence, so it stays N/A here and is not added.
  - **Placement:** the folder chip moves INTO the toolbar's left group as upstream (attach · sources · folder), leaving our Codex external footer under the card. `BranchSwitcher` (capability `externalFooter.gitBranch`) follows the folder chip in the same group as a `COMPOSER_CHIP`, icon-only below 32rem via `data-badge-label`.
- **Keep:** project handles, D1.251, the branch switcher behaviour (codex wave 4.2), capability gating.
- **Tests:**
  - `use-working-directory-state.test.ts`, `BranchSwitcher.test.tsx` (existing) green.
  - New `composer-sources-chip.test.tsx`. Positive: two selected sources render "A, B" on desktop and the count on compact. Negative: a stale slug that matches no source renders the empty affordance, not "0 sources".
  - Playground `input-container` with showSources / sourceCount and the cwd scenarios, dark; 375px compact.
- **Runtimes:** neutral. The branch chip is capability-gated.
- **Done means:**
  - no composer control lives below the card except the deep-link notice and the hint line;
  - `rg 'optimisticSourceSlugs.includes\(s\.logicalName\)'` → 0.

**R4-12 `[design]` `[composer]` FreeFormInput assembly (L).**
- **Needs:** R4-02, R4-08, R4-09, R4-10, R4-11; R6 (`rich-text-input.tsx` copy type).
- **Upstream:** `v0.15.0:U:FreeFormInput.tsx`:
  - its own `@container/panel` root;
  - card material `rounded-xl bg-raised shadow-elev-2` (unwrapped);
  - drop target `ring-2 ring-inset ring-focus bg-accent-tint`;
  - RichTextInput `px-3.5 pt-3.5 pb-3.5 text-copy`, compact `text-copy-lg min-h-[80px]`, `--lh-copy`;
  - toolbar `flex … px-2 pb-1.5`: left group clamped `min-w-[clamp(0px,calc(100%-11rem),6rem)]`; right group `-m-1 … overflow-hidden p-1` (mode · model); then context and Send outside the squeeze;
  - `IconButton` attach;
  - collapsed-compact spacer restyled;
  - compact-mode default placeholders without keyboard tips.
- **Files:** `O:FreeFormInput.tsx` (3275 lines, div 2211).
- **Method:** per-hunk merge on the JSX return (`:2219-3043`) and the placeholder block (`:407-417`).
  - Replace:
    - `composer-surface` / backdrop blur (`:2226-2227`);
    - the Codex grid footer (`:2465`) with upstream's two-group flex row;
    - the "Drop to attach" label overlay (`:2236-2240`) with upstream's inset ring + tint. `chat.dropToAttach` is then unused; the key is removed in en+ru in the same commit.
  - Mount R4-08..R4-11's components in upstream's order. Compact moves mode · model to the RIGHT (today they lead the left group, `:2481-2516`).
  - Placeholder: take upstream's DEFAULTS half (compact drops `shiftTab`, `newLine`, `sidebar`, `focusMode` by KEY, locale-safe). Do NOT take upstream's re-wired `placeholderOptions` English-needle filter for caller lists. That is the same dead / locale-inert filter F1.93/D1.400 deleted, and upstream v0.15.0 wires it back. Our rule stands: a compact embedding names its own placeholder.
  - Everything non-visual stays.
- **Keep:** see §4 (the full behaviour list).
- **Tests:**
  - `compact-placeholder.test.ts` (existing, source-level) is updated. The declaration probe on `placeholderOptions` stays as long as no filter is taken.
    - Positive (new arm): with `compactMode` the default list contains no `chatInput.placeholder.shiftTab`.
    - Negative (kept): the source contains no `includes('shift + tab')`.
  - All existing `O:__tests__/*` green, notably `slash-command-actions`, `double-escape`, `submit-control`, `staged-image-send-guard`, `ultracode-toggle`, `learn-image-refusal-wiring` (source-level probes; re-anchor any symbol they read).
  - Playground: the full `input-container` matrix (freeform, compact, isProcessing, attachments, follow-ups, queue, cwd), `side-question`, `slash-command`, dark.
  - CDP: the composer at 1400px and at 700px (compact), on pi, claude-gateway and codex, dark.
- **Runtimes:** pi/claude/codex.
- **Done means:**
  - `rg 'composer-footer|ComposerFooterLabel|ContextUsageDonut' apps/electron/src/renderer/components` → 0. R1 may then drop `.composer-footer*` from `index.css:1530-1534`.
  - The toolbar order matches upstream.
  - Every §4 behaviour still has its test green.

**R4-13 `[design]` `[composer]` ChatInputZone and the hint line (M).**
- **Needs:** R4-07, R4-09, R4-12; R2 (`ActiveOptionBadges.tsx`: `showPermissionMode`, labels and status leave the badge row; chat-header label chips); R7 (`atoms/label-value-edit.ts`); B4/R2 (background-task chip props).
- **Upstream:**
  - `v0.15.0:U:ComposerHintLine.tsx` (ADDED): shortcut hints under the card, desktop only, reserved height, fades in on `peer-focus-within/composer`, keys from the Send-message-key setting.
  - `U:ChatInputZone.tsx`:
    - padding `px-gutter` / `@xs/panel:px-6 pb-3.5`;
    - `ActiveOptionBadges showPermissionMode={!!inputProps.structuredInput}`;
    - `showPermissionModeChip` passed to the composer;
    - `handleLabelAdd` compares `extractLabelId` and opens a valued label's editor through `pendingLabelValueEditAtom`;
    - background-task props `onStopTask`, `onDismissTask`, `onOpenTaskOutput` replace `onKillTask` / `onInsertMessage`.
- **Files:** `O:ChatInputZone.tsx` (div 242), new `O:ComposerHintLine.tsx`.
- **Method:** merge.
  - Take: the hint line (`window.electronAPI.getSendMessageKey` exists, `apps/electron/src/shared/types.ts:1086`); the badge-row mode rule (ours passes `showPermissionMode={compactMode}`, `O:ChatInputZone.tsx:188`); the padding tokens (via our `CHAT_LAYOUT.controlGutter*` if R2 keeps them).
  - Take the `extractLabelId` duplicate check (a defect inherited from v0.14.0: `O:ChatInputZone.tsx:130` `current.includes(labelId)` appends a bare `labelId` beside an existing `labelId::value`; `extractLabelId` exists at `packages/shared/src/labels/values.ts:93`).
  - Take the `pendingLabelValueEditAtom` hand-off once R7 and R2 have landed (otherwise keep `autoOpenLabelId`).
  - Re-apply:
    - `ComposerCapabilitiesProvider` (decision 3a);
    - the queue (`QueuedMessageList` above the card, `queueGet` / `queue_changed`, D1.383 stub guard, F1.481);
    - `neverPersist` (P6.502);
    - `onShowTerminalOverlay` (L9), unless B4's row replaces it with `onOpenTaskOutput`;
    - the deep-link external-prompt notice (deep-links contract, below the card ABOVE the hint line).
  - The cwd / branch footer row leaves (R4-11).
- **Keep:** the items listed under Re-apply.
- **Tests:**
  - New `composer-hint-line.test.tsx`. Positive: `sendMessageKey='cmd-enter'` renders ⌘↵ for send. Negative: `empty` renders no hints but keeps the height (`h-6`).
  - New arm in a `chat-input-zone-labels.test.ts`. Positive: adding `priority` when `priority::3` is applied leaves the list unchanged. Negative: adding an unapplied plain label appends it once.
  - `queue-paused-banner.test.tsx`, `queue-reorder-strip.test.ts` (existing) green.
  - Playground `input-container` showOptionBadges + showTasks; `active-option-badges`, dark.
- **Runtimes:** neutral.
- **Done means:** desktop shows the hint line on focus; the mode chip appears above the card only during prompts; no duplicate label entries.

**R4-14 `[feature]` `[composer]` Attachment size pre-check, paste-a-console-snippet offer, visual sitting (M).**
- **Needs:**
  - R4-12, R4-13;
  - B2's `packages/shared/src/protocol/message-limits.ts` row (`checkAttachmentSizes`, `DEFAULT_MAX_MESSAGE_BYTES`, `formatAttachmentBytes`) and the transport's `maxMessageBytes` (B4: server/client);
  - R6 `rich-text-input.tsx` `onTextPaste`;
  - R3 `packages/ui/src/components/markdown/shell-command.ts` (`consoleSnippetCommand`) and `apps/electron/src/renderer/lib/run-command-message.ts`;
  - R2 `ChatDisplay.tsx` `handleRunCommand`.
- **Upstream:**
  - `v0.15.1:U:FreeFormInput.tsx` (+50): `refuseOversizedAttachment` before reading (file picker, paste-files event, long-text paste) and the submit refusal with toasts `toast.attachment(s)TooLarge*`.
  - `v0.15.0:U:ChatInputZone.tsx` `PastedCommandChip`: "Run in background" + dismiss. It is cleared when the pasted text leaves the draft; running clears a draft equal to the snippet.
- **Files:** `O:FreeFormInput.tsx`, `O:ChatInputZone.tsx`.
- **Method:** take both hunks. Ours has neither:
  - `rg 'checkAttachmentSizes|maxMessageBytes|consoleSnippetCommand|onConsoleSnippetPaste|onTextPaste|attachmentTooLarge'` over `apps packages` → 0;
  - positive control: `onLongTextPaste` hits `components/ui/rich-text-input.tsx:59`.
- The offer is gated on `onRunCommand` being passed. Native-first default:
  - the caller passes it only where the session's runtime can start a background shell natively (Claude's Bash `run_in_background`);
  - add a `ComposerCapabilities` flag (e.g. `backgroundShell`) in `packages/shared/src/protocol/dto.ts:87` rather than a `providerType` check;
  - which runtimes set it is R3's / B4's decision with run-command-message. Ours already has a separate host `!cmd` runner (`O:FreeFormInput.tsx:1753-1758`), which stays unchanged.
- **Keep:** the `!` shell mode; the staged-image send guard; the queue send path.
- **i18n (en+ru, keys commit first):**
  - `toast.attachmentTooLarge`, `toast.attachmentTooLargeDescription`, `toast.attachmentsTooLarge`, `toast.attachmentsTooLargeDescription`;
  - `chat.runCommandInBackground` (and `chat.runCommandStarted` if R3 renders it);
  - `chat.stopResponse` (R4-08), `chat.credentials.hideValue`, `chat.credentials.showValue` (R4-04) — if not already committed by their rows.
- **Tests:**
  - New `attachment-size-guard.test.ts`. Positive: a file over the limit is refused before `readFileAsAttachment` and toasts its name. Negative: a file exactly at the limit is accepted.
  - New `pasted-command-chip.test.tsx`. Positive: pasting `$ bun test` shows the chip and Run calls `onRunCommand('bun test')`. Negative: without `onRunCommand` there is no chip, and deleting the pasted text clears it.
  - CDP composer visual case (new checklist row, DARK): freeform focus (hint line), a permission prompt (ring), an oversized-attachment toast and the snippet chip. Drive it once per runtime (pi, claude-gateway, codex); the chip arm only where the capability is set.
- **Runtimes:**
  - size check: neutral (all three);
  - snippet offer: claude for sure; codex and pi per the capability, a stated residue where unset.
- **Done means:** oversized attachments no longer surface as "Connection lost"; the chip appears only where the agent can honour it.

## 3. Functional changes hidden in the redesign

| Upstream change | Paths | Our state + evidence | Disposition | Row |
|---|---|---|---|---|
| Attachment size checked before read/send, with named toasts (v0.15.1) | `U:FreeFormInput.tsx` | absent: `rg checkAttachmentSizes\|maxMessageBytes` → 0 (control: `onLongTextPaste` hits) | TAKE (needs B2 message-limits) | R4-14 |
| Pasted console snippet offers "Run in background" | `U:ChatInputZone.tsx` `PastedCommandChip`, `U:FreeFormInput.tsx` `handleTextPaste` | absent (same probe); ours has a host `!cmd` foreground runner (`O:FreeFormInput.tsx:1753`) | ADAPT: capability-gated per runtime | R4-14 |
| Compact placeholder drops keyboard tips (release note "phones no longer rotate keyboard-shortcut tips") | `U:FreeFormInput.tsx` defaults + `placeholderOptions` | defaults always include them (`O:FreeFormInput.tsx:407-415`); the filter was deleted on purpose (F1.93/D1.400, `__tests__/compact-placeholder.test.ts`) | ADAPT: take the key-based defaults half; DROP the English-needle filter (locale-inert, as measured in F1.93) | R4-12 |
| Re-adding an applied valued label appended a bare duplicate | `U:ChatInputZone.tsx` `handleLabelAdd` | defect present: `O:ChatInputZone.tsx:130` `current.includes(labelId)` | TAKE | R4-13 |
| Valued label opens its value editor in the chat header (`pendingLabelValueEditAtom`); label/status chips leave the badge row | `U:ChatInputZone.tsx` | ours: `autoOpenLabelId` + chips in `ActiveOptionBadges` (`O:ChatInputZone.tsx:186-209`) | TAKE after R2 (chat header) + R7 (atom) | R4-13 |
| Permission-mode chip moves into the toolbar; badge row shows it only during decision prompts | `U:ChatInputZone.tsx`, `U:FreeFormInput.tsx`, `U:ComposerModeChip.tsx` | ours: desktop already in the toolbar (codex wave 2.8) but on the LEFT; badge row shows it in compact (`O:ChatInputZone.tsx:188`) | TAKE placement and rule; keep our modes/menu | R4-09, R4-13 |
| Shortcut hint line under the card | `U:ComposerHintLine.tsx` | absent | TAKE (desktop) | R4-13 |
| Decision prompts draw an info/destructive ring on the composer card | `U:InputContainer.tsx`, `U:structured/decision-tone.ts` | no ring; no `risks` on our requests (`rg PermissionRisk` in `packages/core/src/types/message.ts` → 0) | TAKE ring; danger arm waits on UB6.10 | R4-01, R4-07 |
| Reduced motion: composer height change lands at once | `U:InputContainer.tsx` | always animates | TAKE | R4-07 |
| Stop is solid accent (morphs from Send), not grey | `U:SendButton.tsx` | `bg-foreground` round button, 4-state (`O:FreeFormInput.tsx:2979-3000`) | ADAPT (keep 4 states) | R4-08 |
| Context chip appears only at high usage | `U:ContextUsageChip.tsx` | ours always shows a quiet donut; unknown-window twin; threshold label | HAVE (keep ours); take the chip material for the warning state | R4-08 |
| Background-task chip props: stop / dismiss / open output | `U:ChatInputZone.tsx` | `onKillTask`, `onShowTerminalOverlay` (L9) | ADAPT with B4/R2's background-task row | R4-13 |
| Reveal buttons and context badges get `aria-label` / `aria-expanded` | `U:structured/CredentialRequest.tsx`, `U:FreeFormInputContextBadge.tsx` | absent | TAKE (+ en/ru keys) | R4-02, R4-04 |
| "Cancelling a credential prompt no longer submits the typed credential" | fix is in `components/chat/AuthRequestCard.tsx` (R3/B4), not in this slice | our `CredentialRequest` Cancel is already `type="button"` (`O:structured/CredentialRequest.tsx:295`) | HAVE here; AuthRequestCard is R3/B4's | R4-04 (pin) |
| Kanban "+ New Task" moves to the column header | `kanban/NewTaskComposer.tsx` | dashed button inside the column (`kanban/KanbanColumn.tsx:132`) | TAKE with R2's KanbanColumn | R4-03 |
| Narrow compact model chip shows a `Cpu` glyph, not a 1-letter ellipsis | `U:CompactModelSelector.tsx` | truncated name | TAKE | R4-10 |
| Admin card Cancel loses the destructive dashed style; Always Allow tip moves to a foot | `U:structured/*` | old styles | TAKE (look) | R4-04, R4-05 |
| WorkingDirectorySelector remove-recent gets `aria-label` | `U:WorkingDirectorySelector.tsx` | ours has no remove-recent (pre-delta divergence; handles, not paths) | N/A | R4-11 |
| Drop target: inset focus ring + accent tint, no label | `U:FreeFormInput.tsx` | "Drop to attach" pill overlay (codex wave 1.8, `O:FreeFormInput.tsx:2236`) | TAKE (look 1:1); remove the `chat.dropToAttach` key | R4-12 |

## 4. Our specifics to keep (file → what to re-apply)

**Composer behaviour list, and whether upstream v0.15.1 now has an equivalent:**

| Our behaviour | Where | Upstream v0.15.1 equivalent? | Verdict |
|---|---|---|---|
| Model/connection picker with runtime switching (preview, confirm dialog, costs), translated-wire and catalogue marks, disclosures | `DesktopModelPickerMenu.tsx`, `ConnectionRow.tsx`, `RuntimeSwitchDialog.tsx`, `ModelListDisclosures.tsx`, `CompactModelSelector.tsx` | partial: `ComposerModelMenu` has a provider → connection → model switcher on EMPTY sessions only, no runtime switch | KEEP ours in upstream's file and look (R4-10) |
| Reasoning levels per runtime (`composerCapabilities.reasoning.levels`) and an effort pill on the trigger | `FreeFormInput.tsx:2930`, codex wave 3.1/3.2 | no: global `THINKING_LEVELS`, no pill | KEEP |
| Ultracode toggle (QK5) | `CompactModelSelector.tsx:80`, `FreeFormInput.tsx:434` | no | KEEP |
| Six Claude-native permission modes, workspace cycle, digit shortcuts, runtime note, locked | `composer-permission-modes.ts`, `FreeFormInput.tsx:2611-2700`, `CompactPermissionModeSelector.tsx` | no: 4 modes incl. Guarded (decision layer) | KEEP, upstream chip look (R4-09) |
| 4-state submit (Send/Queue/Steer/Stop + loading), blocked-reason tooltip, mid-stream override hotkey | `submit-control.ts`, `FreeFormInput.tsx:2979+` | no: Send/Stop only | KEEP (R4-08) |
| Message queue UI (steer / edit / delete / reorder / resume, paused) | `QueuedMessageList.tsx`, `ChatInputZone.tsx:85-174` | no queue UI (its mid-turn queue is decision-layer, B1) | KEEP; restyle with the `FollowUpChips` / `COMPOSER_META_CHIP` material (R4-13) |
| Context meter (always visible, threshold, unknown window, fallback-window note) | `context-meter-state.ts`, `ContextMeterUnknownWindow.tsx`, `composer-parts.tsx` | warning-only chip | KEEP behaviour (R4-08) |
| Working directory as an issued project HANDLE, D1.251 storage dir, server directory browser | `FreeFormInput.tsx:3063+`, `use-working-directory-state.ts` | path-based `WorkingDirectorySelector` | KEEP behaviour, upstream file shape and look (R4-11) |
| Git branch switcher chip (capability-gated) | `BranchSwitcher.tsx`, `ChatInputZone.tsx:267` | no (branch shown only in the tooltip) | KEEP, moved into the toolbar (R4-11) |
| `/btw` side-question overlay | `FreeFormInput.tsx:2307`, `SideQuestionOverlay` | no | KEEP |
| Slash actions, custom slash commands, rewind, out-of-band commands, `/compact` wait, plan approval dispatch | `slash-command-actions.ts`, `custom-slash-command-submission.ts`, `compaction-wait.ts`, `pending-plan-dispatch.ts` | upstream has slash + plan dispatch; ours is a superset | KEEP |
| Double-escape, input history recall, ArrowUp stop guard | `double-escape.ts`, `input-event-guards.ts` | no | KEEP |
| `!cmd` host shell mode | `FreeFormInput.tsx:1753` | no (its paste offer is agent-run) | KEEP, independent of R4-14 |
| Staged-image policy per runtime + learned refusal | `attachment-capability.ts`, `useLearnImageRefusal.ts`, `ImageSupportWarningBanner.tsx` | banner only | KEEP |
| @file mentions via codex fuzzy search | `FreeFormInput.tsx:1428-1430` (a grandfathered `providerType` check) | no | KEEP (not touched here) |
| Pasted-text chip restore | `AttachmentPreview` (R2) | no | KEEP (R2) |
| Auto-capitalise first character | `FreeFormInput.tsx:2089` | no | KEEP |
| Deep-link external-prompt notice under the card | `ChatInputZone.tsx:244-256` | no | KEEP (above the hint line) |
| Capability-driven slots, no `providerType` in JSX (decision 3a) | `composer-capabilities-context.tsx` | n/a | KEEP; every new chip reads capabilities |

**File-by-file re-apply list:**
- `composer-styles.ts`: mode tone maps keyed to our six modes; fallback `'default'`.
- `InputContainer.tsx`:
  - `workflow_launch` fallback;
  - `structured-height` clamp;
  - P6.208 mode props;
  - no exit animation for a leaving structured layer;
  - UA1.15 note.
- `ChatInputZone.tsx`:
  - `ComposerCapabilitiesProvider`;
  - queue hydrate / subscribe / handlers;
  - `neverPersist`;
  - `workspaceId`;
  - L9 terminal overlay (until B4);
  - deep-link notice;
  - F1.481 `queueHoldsUnsteerableRow`.
- `FreeFormInput.tsx`: everything in the table above, plus F1.1266 (level name, not id) and F1.331/P6.946 tooltip lines.
- `CompactModelSelector.tsx` / `ComposerModelMenu.tsx`:
  - `ConnectionRow`;
  - `ModelListDisclosures`;
  - ultracode;
  - `onPreviewConnectionChange`;
  - `switchable`;
  - capability levels;
  - D1.214 harness.
- `CompactPermissionModeSelector.tsx`: `PermissionModeBadge`, decorations, runtime note, locked.
- `ImageSupportWarningBanner.tsx`: optional `onEnable`; `refusalSentence` (P6.584).
- `InputErrorBoundary.tsx`: no Sentry.
- `structured/CredentialRequest.tsx`: our i18n keys (`auth.*`, `common.*`).
- `structured/AdminApprovalRequest.tsx`: F1.554 `Trans`, F1.869/F1.885 remember rules, `ruleSentence`, `adminApprovalCardData`.
- `structured/PermissionRequest.tsx`:
  - outside-root;
  - outside-read 3 answers (P6.202);
  - artifact publish;
  - reopen-compact (P6.500/P6.950);
  - worktree cleanup;
  - auto-mode switch (P6.208);
  - subagent label;
  - impact block;
  - session-only Always Allow;
  - answer note;
  - all exported helpers.
- `WorkingDirectorySelector.tsx` (new, ours): handle-typed change, D1.251, `ServerDirectoryBrowser`, UA12.206 key.
- `kanban/NewTaskComposer.tsx`: provenance header only.

**Dropped from ours (Codex look superseded by the owner's 1:1 design rule):**
- the glass squircle `composer-surface` + backdrop blur (codex wave 1.2);
- the grid footer `composer-footer` (wave 1.4);
- the cwd external footer row (wave 1.9);
- the drop overlay pill (wave 1.8);
- `ComposerFooterLabel` / `ComposerFooterDivider`.

The "Codex" theme preset (wave 4.4) is R1's call.

## 5. Per-path disposition

| Path (under `apps/electron/src/renderer/components/app-shell/`) | Ours | div vs 0.14.1 | Upstream Δ 0.14.1→0.15.1 | Method | Row |
|---|---|---|---|---|---|
| `input/ChatInputZone.tsx` | same path | 242 | 134 | merge | R4-13, R4-14 |
| `input/CompactModelSelector.tsx` | same path | 337 | 113 | merge (look on our content) | R4-10 |
| `input/CompactPermissionModeSelector.tsx` | same path | 156 | 86 | merge | R4-09 |
| `input/ComposerHintLine.tsx` | — | — | ADDED | add (deps: `kbd`, `action-hotkey`, `getSendMessageKey`) | R4-13 |
| `input/ComposerModeChip.tsx` | — | — | ADDED | add, adapted to our modes and menu | R4-09 |
| `input/ComposerModelMenu.tsx` | `input/DesktopModelPickerMenu.tsx` (renamed) | n/a (ours extracted separately, D1.214) | ADDED | merge into the renamed file | R4-10 |
| `input/ComposerSourcesChip.tsx` | — (inline in `FreeFormInput`) | — | ADDED | add, adapted to `SafeCapabilitySummary` | R4-11 |
| `input/ContextUsageChip.tsx` | — (inline donut + `composer-parts`) | — | ADDED | add, adapted to `context-meter-state` | R4-08 |
| `input/FollowUpChips.tsx` | — (inline) | — | ADDED | add 1:1 | R4-08 |
| `input/FreeFormInput.tsx` | same path | 2211 | 1010 | per-hunk merge | R4-12, R4-14 |
| `input/FreeFormInputContextBadge.tsx` | same path | 0 | 46 | take 1:1 | R4-02 |
| `input/ImageSupportWarningBanner.tsx` | same path | 58 | 6 | take + re-apply hunks | R4-02 |
| `input/InputContainer.tsx` | same path | 91 | 41 | merge | R4-07 |
| `input/InputErrorBoundary.tsx` | same path | 13 | 16 | take + re-apply no-Sentry | R4-02 |
| `input/SendButton.tsx` | — (inline) | — | ADDED | add, adapted to 4-state | R4-08 |
| `input/ToolbarStatusSlot.tsx` | same path | 0 | 52 | take 1:1 | R4-02 |
| `input/WorkingDirectorySelector.tsx` | — (`WorkingDirectoryBadge` inside `FreeFormInput.tsx:3063`) | n/a (never split out) | 37 | add (extract ours into upstream's shape, handle-typed) | R4-11 |
| `input/action-hotkey.ts` | — | — | ADDED | add 1:1 | R4-01 |
| `input/composer-styles.ts` | — | — | ADDED | add, mode maps re-keyed | R4-01 |
| `input/structured/AdminApprovalRequest.tsx` | same path | 86 | 70 | merge | R4-04 |
| `input/structured/CredentialRequest.tsx` | same path | 16 | 114 | take + re-apply i18n | R4-04 |
| `input/structured/DecisionCard.tsx` | — | — | ADDED | add 1:1 | R4-01 |
| `input/structured/PermissionRequest.tsx` | same path | 842 | 112 | per-hunk merge | R4-05 |
| `input/structured/decision-tone.ts` | — | — | ADDED | add (risk arm gated on UB6.10) | R4-01 |
| `kanban/NewTaskComposer.tsx` | same path | 2 | 46 | take 1:1 (paired with R2 KanbanColumn) | R4-03 |

The ours-only files restyled by R4-06/R4-08/R4-10/R4-11/R4-13 are not in the assigned list: `AskUserRequest`, `WorkflowLaunchRequest`, `ArtifactPublishDetails`, `QueuedMessageList`, `BranchSwitcher`, `ConnectionRow`, `ModelListDisclosures`, `ContextMeterUnknownWindow`, `composer-parts`.

## 6. Owner questions

None needed. Every choice follows from the owner decisions of 2026-10-14 (look 1:1, behaviour ours). The defaults taken are listed so a reviewer can overturn them:
- the folder and branch chips move into the toolbar, and the Codex external footer goes;
- the context meter stays always visible, with upstream's chip used for the warning state;
- the drop overlay label goes;
- the mode-tone mapping keeps today's per-mode colours;
- the risk ring waits on UB6.10;
- the snippet offer is capability-gated per runtime (its message is R3's).

## 7. Coverage

- Assigned: 25. Read: 25. For every path I read the v0.14.0→v0.15.1 diff. I read the full v0.15.1 file for the 11 ADDED or large files: `composer-styles`, `action-hotkey`, `SendButton`, `ComposerHintLine`, `ContextUsageChip`, `decision-tone`, `ComposerModeChip`, `ComposerSourcesChip`, `FollowUpChips`, `DecisionCard`, `ComposerModelMenu`. For `CredentialRequest` I read v0.15.1 lines 40–120, and for `WorkingDirectorySelector` its head. For `FreeFormInput` I read both the 0.15.0→0.15.1 diff and the full 0.14.0→0.15.1 diff. Skipped: 0.
- Overlaps relied on:
  - R1: tokens, motion, `index.css` hooks, playground registry;
  - R2: `ActiveOptionBadges`, `ChatHeader`, `ChatDisplay` `handleRunCommand`, `KanbanColumn`, `AttachmentPreview`, `BackgroundFinishedChip`;
  - R3: `shell-command.ts`, `run-command-message.ts`, `AuthRequestCard`;
  - R6: `button`, `kbd`, `popover`, `slash-command-menu`, `rich-text-input`, `CompactWorkingDirectorySelector`, `source-avatar`;
  - R7: `label-value-edit` atom;
  - B2: `message-limits`;
  - B4: background-task props, transport `maxMessageBytes`;
  - draft UB1.2 / UB6.10: `canRemember` / `risks`;
  - draft UB5.4: composer viewport stays a measurement; `composer-height` is not in this delta.
