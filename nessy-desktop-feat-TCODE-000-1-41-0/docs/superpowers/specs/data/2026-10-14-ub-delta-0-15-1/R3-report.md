# R3 — Transcript and markdown rendering: upstream v0.14.0 → v0.15.1 (input for the 1.43.0 plan)

Reader: R3 (slice "transcript"). Read-only analysis at our HEAD `f495cf311` (branch `feat/TCODE-000-1-41-0`) against `.references/craft-agents-oss` tags v0.14.0, v0.14.1, v0.15.0, v0.15.1. Upstream read by tag only. Scratch copies of every upstream version and of our brand-normalised files are in `scratchpad/r3/` (`up140/`, `up151/`, `ours/`, `up.diff`, `ours-turncard.diff`, `ours-auth.diff`, `ours-msgbubble.tsx`).

**Release placement (measured, `git diff --numstat` per tag pair over all 51 paths):** v0.14.0→v0.14.1 touches none of them; v0.14.1→v0.15.0 touches all 51; v0.15.0→v0.15.1 touches only `AuthRequestCard.tsx` (+31/−9) and `chat/turn/tool-display.ts` (+5). So the slice is the 0.15.0 "A new look" transcript plus two 0.15.1 follow-ups.

---

## 1. Summary

- **TurnCard was taken apart.** v0.15.1 `TurnCard.tsx` is 1888 lines (v0.14.0: 3287). Its row components moved to a new `packages/ui/src/components/chat/turn/` folder (13 files): `WorkLog` (the collapsed "N steps · preview" row with a "N failed" chip and a hover-revealed ⋯ menu), `ActivityRow` (icon · verb · object · right-aligned +/− stats and ✓/✗), `ActivityGroupRow` (subagent group), `TodoList`, `ThinkingRow`, `ResponseFooter` (Copy / Markdown / Fullscreen / Branch as 24px icon buttons), `TurnIconButton`, `ActivityIcons`, `turn-classes` (all class strings), `use-row-reveal` (CSS `@starting-style` insert animation), `tool-display` and `work-log-summary` (pure helpers). Tree connector lines and the 540px answer cap are gone.
- **The answer is plain copy.** It is no longer a card. Plans keep a raised card with a header. One tree serves both streaming and completed states, and new blocks fade in once.
- **Sunken wells.** Code, diff and JSON blocks and every rich preview (datatable, spreadsheet, image, PDF, HTML, markdown doc, mermaid) sit in one well: a new `PreviewBlockChrome.tsx` with a 32px header of icon · title · actions. The diff well gains a path and +/− header, classic +/− indicators and a reserved height.
- **Inline errors.** `SystemMessage` and the new electron `chat-display/ErrorMessage.tsx` draw a tinted marker with a role icon. Error actions are Buttons, the first one primary.
- **New electron files.** Three new files under `chat-display/` (`MessageBubble`, `ErrorMessage`, `TranscriptStates`) are extracted from upstream's `ChatDisplay.tsx`.
- **Functional changes hidden in the redesign:**
  - Shell and console code blocks get a **Run in background** button (`RunCommandContext`, `shell-command.ts`, `run-command-message.ts`).
  - **Subagent steps are grouped**: rows of a subagent launched in an earlier turn form a `continued` group, and nested subagent rows stay inside their outer group (`turn-utils.ts`).
  - The turn's error count moved out of the preview text into the failed chip.
  - Loading states reserve height.
  - Tooltip timing is now 500ms first, then a 300ms skip window.
  - Datatable booleans and "No rows" are translated.
  - In 0.15.1, the auth card can **restart** a lost browser sign-in.
- **Our divergence is concentrated in four files:** `TurnCard.tsx` (457 changed lines), `AuthRequestCard.tsx` (521), `turn-utils.ts` (161), and the inline `MessageBubble`/`ErrorMessage` inside our `ChatDisplay.tsx`. Of the 28 paths that exist on both sides, 20 are identical to upstream after brand normalisation and take 1:1.

## 2. Proposed rows

Dependency order. Every visual row lists its own i18n keys (keys commit first, reader second; en + ru only), and its live arm sits in the sitting case R3-13. Cross-reader dependencies (`R1`, `R2`, `R4`, `R6`, `R7`, `B4`) refer to the sibling readers' rows; the controller maps them to UB ids.

**R3-01 `[ui]` `[design]` Transcript primitives: turn classes, icon button, row reveal, thinking row, activity icons, tooltip (S).**
- **Needs:** R1's token and utility rows (they are not in our tree: `rg -n "sunken|fill-hover|elev-2" packages/ui/src/styles apps/electron/src/renderer/index.css` returns nothing, while v0.15.1 `packages/ui/src/styles/tokens.css:344-453` defines `--color-sunken`, `--color-fill-hover`, `--text-label-sm`, `--text-mono-ui`, `--shadow-elev-2`). Also R1's `packages/ui/src/motion/presets.ts` (`SPRING`, `TWEEN`; `packages/ui/src/motion` does not exist in ours), the `in-data-compact` custom variant and the `motion-press` / `motion-tooltip` / `state-overlay` utilities.
- **Upstream:** v0.15.1 `packages/ui/src/components/chat/turn/{turn-classes.ts,TurnIconButton.tsx,use-row-reveal.ts,ThinkingRow.tsx,ActivityIcons.tsx}` (ADDED). v0.15.1 `packages/ui/src/components/tooltip.tsx`: 500ms delay, 300ms `skipDelayDuration`, `sideOffset` 6, floating material.
- **Files:** the five new `turn/*` files and `packages/ui/src/components/tooltip.tsx`.
- **Method:** take 1:1 (ADDED, plus `tooltip.tsx` at div 0). `SIZE_CONFIG` moves to `turn/turn-classes.ts`, and `TurnCard.tsx` re-exports it with `ActivityStatusIcon`, as upstream does, so `InlineExecution.tsx:12` and our cards keep importing from `./TurnCard`.
- **Keep:** nothing to re-apply. `ActivityIcons` keys on canonical tool names, which all three runtimes emit:
  - Pi maps to `binding.permissionName` (`packages/shared/src/agent/backend/pi/event-adapter.ts:1393`).
  - Codex emits `Bash` / `Edit` / `WebSearch` (`backend/codex/event-adapter.ts:1744,1750,1773`).
  - Codex collab rows (`spawn_agent` …, `event-adapter.ts:352-358`) fall to Wrench, but they render through our `renderActivity` cards, never this icon.
- **Tests:** new `packages/ui/src/components/chat/turn/__tests__/turn-primitives.test.tsx` (`renderToStaticMarkup`, the same instrument as `markdown/__tests__/markdown-link-routing.test.ts`):
  - Positive: `ResultGlyph status="error"` renders the destructive circle-x; `TurnIconButton` carries its `aria-label` and `data-slot="icon-button"`.
  - Negative: `ToolIcon` for `spawn_agent` falls to the Wrench glyph, and `mcp__sources__wire__tool` (codex bridge shape) to Plug.
  - Tooltip: a props assertion that the `TooltipProvider` defaults are 500/300 and that an explicit `delayDuration` overrides them.
- **Runtimes:** runtime-neutral (presentational).
- **Done means:** the files exist byte-equal to v0.15.1 except for a `v0.15.1:<path>` header line; the package typechecks.

**R3-02 `[ui]` `[design]` Code, diff and JSON wells, markdown typography, Run-in-background button (UI half) (M).**
- **Needs:** R3-01. R7's `packages/ui/src/components/ui/AnimatedCollapsibleContent.tsx`, for `CollapsibleSection`. R7's `packages/ui/src/index.ts` row, to export `RunCommandProvider`, `useRunCommand`, `shellCommandFromBlock` and `consoleSnippetCommand` as v0.15.1 `packages/ui/src/index.ts:92-96` does.
- **Upstream:** v0.15.1 `packages/ui/src/components/markdown/`:
  - `CodeBlock.tsx`: sunken well; Run button only under a provider and only in `mode==='full'`; long lines scroll.
  - `RunCommandContext.tsx` and `shell-command.ts` (ADDED), with `__tests__/shell-command.test.ts`.
  - `MarkdownDiffBlock.tsx`: diff theme variables, `diffIndicators:'classic'`, path and stats header, reserved height. Plus `diff-summary.ts` (ADDED) and `__tests__/diff-summary.test.ts`.
  - `MarkdownJsonBlock.tsx`.
  - `Markdown.tsx`: link underline, `text-copy-lg` headings, `border-strong` blockquotes.
  - `CollapsibleSection.tsx`: shared `AnimatedCollapsibleContent`, `SPRING.snap`.
  - `index.ts` (+2 exports).
- **Files:** the above, ours at the same paths.
- **Method:** take 1:1. All of ours are div 0, and the brand only touches the shiki theme names (`registerNessyShikiThemes`, `nessy-dark`/`nessy-light`, which normalise to the upstream spelling).
- **Keep:** the brand names in `MarkdownDiffBlock` (theme registration).
- **i18n:** `chat.runCommandInBackground`, `chat.runCommandStarted` (missing in our en and ru, measured by a key lookup over both locale JSONs; `chat.processing.thinking` is the positive control and is present in both).
- **Tests:**
  - Copy upstream `shell-command.test.ts` and `diff-summary.test.ts` (each holds positive and negative cases: a console transcript keeps only `$` lines with continuations; plain text and `It costs\n$ 5` are never a command; a bare hunk-less body still counts).
  - New `markdown/__tests__/code-block-run.test.tsx`. Positive: a `bash` block inside `RunCommandProvider value={fn}` renders the Run button, and the click calls `fn` with the de-prompted command. Negative: a `ts` block, a provider value of `null` (the streaming answer) and `mode="terminal"` render no Run button.
  - Playground: R1's `registry/markdown.tsx` "Code blocks with Run" entry, swept in dark theme.
- **Runtimes:** the UI half is neutral. The message it sends is R3-09's.
- **Done means:** both copied tests and the new one pass alone with their FILE COUNT; a `bash` fence in a completed answer shows Run next to Copy.

**R3-03 `[ui]` `[design]` Rich preview blocks on one well: `PreviewBlockChrome` (L).**
- **Needs:** R3-01. R7's `StyledDropdown.tsx` row (`PreviewItemNavigator` uses `StyledDropdownMenuContent`/`Item`).
- **Upstream:** v0.15.1 `packages/ui/src/components/markdown/`:
  - `PreviewBlockChrome.tsx` (ADDED: frame, header, action, loading, error, fade, item navigator).
  - `MarkdownDatatableBlock.tsx`: chips; `awaitingFile` shows the loading well instead of a one-frame JSON fallback; translated yes/no/no-rows.
  - `MarkdownSpreadsheetBlock.tsx`: same `awaitingFile`.
  - `TableExportDropdown.tsx`: ghost button with `aria-label`.
  - `MarkdownImageBlock.tsx` and `ImageCardStack.tsx`: `SPRING.gesture`/`SPRING.base`; cards rise from 96% scale, 8px below.
  - `MarkdownMermaidBlock.tsx`: header with title and fullscreen.
  - `MarkdownPdfBlock.tsx`.
  - `MarkdownDocBlock.tsx`: paper body; Minimize icon when expanded; 400px reserved while loading.
  - `MarkdownHtmlBlock.tsx`: `bg-paper` iframe instead of `bg-white`; bottom fade removed; 400px reserved.
- **Files:** the ten paths above.
- **Method:**
  - Take 1:1 for Datatable, Spreadsheet, TableExport, Image, ImageCardStack, Pdf and PreviewBlockChrome (div 0 or ADDED).
  - Mermaid: take, then re-apply one hunk (div 2).
  - Doc and Html: take, then re-apply our Publish action (div 25 each).
- **Keep:**
  - **UA1.23 Publish** in `MarkdownDocBlock.tsx` and `MarkdownHtmlBlock.tsx`: `previewPublishTarget(activeItem, onPublishFile)` and the `Upload` button with `data-preview-publish`. It becomes a `<PreviewBlockAction aria-label={t('preview.publish')} title={t('preview.publishTitle')} icon={<Upload/>} data-preview-publish …>` placed before the fullscreen action. Ours today: `MarkdownDocBlock.tsx` `onPublishFile` hunk at upstream-v0.14.0 L133→ours L136-156; same shape in `MarkdownHtmlBlock.tsx`.
  - **Mermaid aria key:** ours spells `t('overlay.openMermaidFullscreen')` (`MarkdownMermaidBlock.tsx:232`); upstream spells `t('preview.openMermaidFullscreen')`. Take upstream's key, add it to en and ru, and retire `overlay.openMermaidFullscreen` (`en.json:1567`, sole reader `MarkdownMermaidBlock.tsx:232` by `git grep`).
- **i18n:** `datatable.yes`, `datatable.no`, `datatable.noRows`, `overlay.itemNumber`, `preview.imagePreview`, `preview.openMermaidFullscreen` (all missing in ours).
- **Tests:**
  - Extend `markdown/__tests__/preview-publish-target.test.ts`, or add `preview-block-publish.test.tsx`. Positive: a Doc block whose active item names a file, with `onPublishFile` wired, renders `[data-preview-publish]`. Negative: no `onPublishFile` gives no button.
  - New `preview-block-chrome.test.tsx`. Positive: the navigator disables "previous" at index 0. Negative: a single item renders no navigator.
  - Playground: R1's markdown registry entries (datatable, spreadsheet, image stack, PDF, HTML, doc, mermaid) in dark theme, plus the doc and html "publish" state.
- **Runtimes:** runtime-neutral.
- **Done means:** every preview block renders inside `PreviewBlockFrame`; the Publish button survives on doc and html; i18n parity and sorted checks are green.

**R3-04 `[ui]` `[claude]` Subagent steps grouped under their subagent (S; functional, 0.15.0 bug fix).**
- **Needs:** none.
- **Upstream:** v0.15.1 `packages/ui/src/components/chat/turn-utils.ts`. `groupActivitiesByParent` now:
  - groups by the topmost subagent ancestor;
  - keeps a nested subagent's rows inside the outer group, with depth relative to the group;
  - collects rows of a subagent launched in an earlier turn into one `continued: true` group with a stand-in `Agent` parent (status derived from its rows), where they used to interleave as orphans;
  - adds `ActivityGroup.continued`.

  Test: v0.15.1 `__tests__/turn-utils-grouping.test.ts`, two cases rewritten.
- **Files:** `packages/ui/src/components/chat/turn-utils.ts` (only the `ActivityGroup` and `groupActivitiesByParent` hunks); `__tests__/turn-utils-grouping.test.ts` (div 0, take 1:1).
- **Method:** re-apply our hunks. Our `turn-utils.ts` (div 161) is identical to v0.14.0 inside `groupActivitiesByParent`; the divergence is elsewhere, so the upstream hunk applies cleanly.
- **Keep (do not touch):**
  - `orchestrationProgress` on activities.
  - `extractChecklistFromActivities` (R20).
  - P4.4 `thinking` type, never promoted to a response.
  - R32 `displayContent` / `displayText`.
  - P2.37 `terminal_reason:` verdict flushes complete, not interrupted.
  - F1.931 compaction divider pushed as a system turn.
  - P6.561 `parentToolUseId` messages are never the turn response.
  - F1.477 status rows with `infoLevel==='success'` are completed.
  - The English-export docblocks (P2.504).
  - **No `messages.filter(m => !m.hidden)`.** Upstream has had it since v0.11.0 (`v0.14.0:packages/core/src/types/message.ts:297` `hidden?: boolean`); ours has neither the filter nor the field (`git grep -n "\bhidden\b" -- packages/core/src/types/` finds only `session.ts:59`, the session-list flag). This is by decision: F1.351 (comment in our `ChatDisplay.tsx` `MessageBubble`, decided 2026-09-23) renders host task notifications as a labelled system line, "not hidden".
- **Tests:** take upstream's two rewritten cases. Positive: own/sub/own/sub gives `[own1, continued group(sub1, sub2) at depth 0, own2]`; nested descendants are kept with relative depth. Add one negative: a row whose `parentId` points at an existing non-Task tool stays top-level (no group).
- **Runtimes:** Claude only, stated residue.
  - Only the Claude adapter emits `parentToolUseId` (`git grep -c parentToolUseId`: `backend/claude/event-adapter.ts` 8 hits, `claude-agent.ts` 2; `pi/event-adapter.ts` and `pi-agent.ts` 0; codex backend 0 hits for `parentId`).
  - Pi subagents (`subagent`) and codex collab render through our `SubagentCard` (`ChatDisplay.tsx:1654-1666`, P3.24), so for them the grouping has nothing to group.
- **Done means:** the grouping test passes with FILE COUNT 1; `hasTaskSubagents` in R3-06 also switches on `a.parentId`.

**R3-05 `[ui]` `[design]` The quiet work log: rows, groups, todo list, header (L).**
- **Needs:** R3-01, R3-04.
- **Upstream:** v0.15.1 `packages/ui/src/components/chat/turn/{WorkLog.tsx,ActivityRow.tsx,ActivityGroupRow.tsx,TodoList.tsx,tool-display.ts,work-log-summary.ts}` (ADDED). v0.15.1 `tool-display.ts` also adds five names (`project_memory_append`, `source_list_resources`, `source_read_resource`, `source_list_prompts`, `source_get_prompt`).
- **Files:** the six new `turn/*` files; our `packages/ui/src/components/chat/{tool-display.ts,turn-preview.ts,intermediate-row.ts,tool-elapsed.ts,run-summary.ts,PublishedArtifactChip.tsx}` (unchanged or lightly touched); `packages/shared/src/utils/toolNames.ts` `SESSION_TOOL_DISPLAY_NAMES` (only if the tools land).
- **Method:** merge. Upstream's file layout and markup are taken; our decisions are re-plugged:
  - **`turn/tool-display.ts`:** take `stripMarkdown`, `computeEditWriteDiffStats`, `formatToolInput`, `stripSessionFolderPath` and `getActivityFileName`. `formatToolDisplay` and `getToolDisplayName` re-export OUR implementations: `chat/tool-display.ts` (F1.477) uses `parseMcpToolName` (`chat/mcp-tool-name.ts`), which splits on `__` and shifts past codex's `mcp__sources__<wire>__<tool>` bridge (F1.217). `turn-preview.ts` `getToolDisplayName` reads the shared `SESSION_TOOL_DISPLAY_NAMES` (F1.434/F1.435). Upstream's `/^mcp__[^_]+__/` regex is exactly the bug `mcp-tool-name.ts`'s header records.
  - **Five new display names:** add them to `SESSION_TOOL_DISPLAY_NAMES` only together with the B-reader rows that land those tools. Today they are absent (`sed -n 195,240p packages/shared/src/utils/toolNames.ts | grep project_memory\|source_list…` → none; `'TodoWrite'` present, 2 hits).
  - **`turn/work-log-summary.ts`:** keep the upstream signature (`{ text?: string }`, `countFailedActivities`) with our text. The completed branch returns `summarizeTurnRun(activities)` (run-summary) instead of `{}`; the running branch uses our `getToolDisplayName`; the `errorCount` suffix is DROPPED, because it moved to the failed chip. Import names from `turn-preview` and never from `turn/tool-display`: upstream's version reaches `../../code-viewer` and `@pierre/diffs`, and our convention is that a decision lives in a module bun can load (header of `chat/turn-preview.ts`, P2.493). `turn-preview.ts` `getPreviewText` becomes the delegate or is retired with its tests retargeted.
  - **`turn/ActivityRow.tsx`:**
    - The intermediate branch also takes `type==='thinking'`, through `describeIntermediateRow` (P4.4): a spinner while streaming; commentary gets upstream's `MessageSquareText`; reasoning keeps `Brain` and is de-emphasised (`italic`, tertiary); text is `displayContent ?? content` (R32).
    - The backgrounded/elapsed text comes from `describeToolElapsed(activity, toolElapsedLabels())` (P4.9: running-heartbeat elapsed, i18n `turnCard.elapsed` / `backgroundTaskId` / `backgroundShellId`) instead of upstream's English literal `Task ID: … elapsed`.
    - `<PublishedArtifactChip activity>` (UA1.19) sits before the result glyph.
    - The thinking fallback name uses `i18n.t('turnCard.processing')`.
  - **`turn/WorkLog.tsx` and `ActivityGroupRow.tsx`:** thread an optional `renderActivity?: (p: ActivityRenderProps) => ReactNode` (ours, `TurnCard.tsx:339`) through `WorkLogRows` and `GroupChildren`. A non-null result replaces `<ActivityRow>` inside the same reveal wrapper. Our `ChatDisplay` routes `SubagentCard` (Pi `subagent` and codex collab, P3.24), `WorkflowPanel`, `TodoListCard` (P2.503) and `AdvisorConsultationCard` (P4.5) through it (`ChatDisplay.tsx:1654-1697`).
  - **`TodoList`:** take it (ours has the same `TodoStatus` with `'interrupted'`, `TurnCard.tsx:218`).
- **Keep:** as listed above, plus `ActivityRenderProps` exported from `TurnCard.tsx`.
- **i18n:** `turnCard.stepCount`, `turnCard.stepsCompletedCount`, `turnCard.failedCount`, `turnCard.subagent`, `turnCard.subagentContinued`, `turnCard.tokenCount`, `turnCard.todoList` (plural forms `_one`/`_other` in en; ru `_one`/`_few`/`_many`/`_other`).
- **Tests:**
  - Retarget source-reading tests that today read `TurnCard.tsx` (`git grep -ln "TurnCard.tsx"` over test files lists `turn-card-i18n-literals.test.ts`, `turn-preview-label.test.ts`, `intermediate-row.test.ts`, `run-summary.test.ts`, `transcript-verbosity.test.ts`, `turn-preview.test.ts` and `apps/electron/.../activity-overlay-title.test.ts`):
    - `turn-card-i18n-literals.test.ts` reads `turn/ActivityRow.tsx`; its positive control `function ActivityRow(` moves with it, and it must still refuse upstream's `Task ID:` literal.
    - `turn-preview-label.test.ts` reads `turn/WorkLog.tsx`: `truncate` stays on the summary span, and no `whitespace-normal`/`line-clamp`.
  - New `turn/__tests__/work-log-summary.test.ts`. Positive: a completed turn of three reads and one edit yields the `summarizeTurnRun` label with no error suffix, and `countFailedActivities` counts 2. Negative: an explicit intent wins over everything; an empty running turn yields `turnCard.starting`.
  - New `turn/__tests__/activity-row.test.tsx` (if the module graph loads under bun; otherwise value tests on `describeIntermediateRow` and `describeToolElapsed`, which exist). Positive: a `thinking` row paints its content and a `codex mcp__sources__w__t` row reads the source name. Negative: a `renderActivity` that returns `null` falls back to the ordinary row and never deletes it (the P3.24 failure mode).
  - Playground: R1's `registry/turn-card.tsx` plus our `turn-card-modes.tsx` (collapsed, expanded, failed chip, continued subagent group, thinking row, published-artifact chip), dark theme.
- **Runtimes:** Pi, Claude and Codex all render through this row. Codex rows keep their bridge-shaped names (parse rule above); Claude groups subagents (R3-04); Pi and codex subagents use our cards.
- **Done means:** every named test passes alone with its FILE COUNT; no English literal from upstream's `ActivityRow` ships.

**R3-06 `[ui]` `[design]` TurnCard shell, plain answer, plan card, response footer, small chat pieces (L).**
- **Needs:** R3-02, R3-05. Serialise with UB6.11, which adds the `decide` overlay to `TurnCard.tsx` (draft plan line 539).
- **Upstream:** v0.15.1:
  - `packages/ui/src/components/chat/TurnCard.tsx`:
    - `ResponseCard` with `ANSWER_PROSE`; `ANSWER_BLOCK_IN` while streaming; one tree for streaming and completed.
    - `RunCommandProvider value={isStreaming ? null : runCommand}`.
    - Plan = raised card plus header `turnCard.plan`.
    - `MAX_HEIGHT` 540 cap removed; `hideFirstMermaidExpand={false}`; footer via `ResponseFooter`.
    - `TurnCard` = `WorkLog` + `ThinkingRow` + answer, 10px apart; `hasTaskSubagents` also on `a.parentId`.
    - Annotation chip `--shadow-color: var(--info)`.
  - `turn/ResponseFooter.tsx` (ADDED).
  - `TurnCardActionsMenu.tsx`: a `TurnIconButton` trigger with `aria-expanded`/`aria-haspopup`.
  - `AcceptPlanDropdown.tsx` and `CompactAcceptPlanDrawer.tsx`: solid accent primary.
  - `InlineExecution.tsx`: token colours, `state-overlay`.
- **Files:** those six paths; our `apps/electron/src/renderer/playground/registry/turn-card-modes.tsx`.
- **Method:**
  - `TurnCard.tsx`: per-hunk merge (div 457 against an upstream change of 1791 lines).
  - `ResponseFooter`, `TurnCardActionsMenu`, `AcceptPlanDropdown`, `CompactAcceptPlanDrawer`: take 1:1 (div 0 or ADDED).
  - `InlineExecution`: take, then re-apply our helper split (div 42).
- **Keep (TurnCard.tsx, re-applied by name):**
  - `OrchestrationProgress` import and `ActivityItem.orchestrationProgress`.
  - `ActivityItem.displayContent` and `ResponseContent.displayText` (R32). The answer paints `response.displayText ?? response.text`, while `onPopOut` keeps `response.text`.
  - `ActivityRenderProps` and the `renderActivity` prop, passed into `WorkLog`.
  - **P6.469 `transcriptVerbosity`:**
    - `resolveTranscriptVerbosity(...).expandByDefault` forces the work log open.
    - `sortedActivities = verbosity.activities`.
    - `hasActivities` counts the UNFILTERED non-plan list.
    - The memo comparator line `prev.transcriptVerbosity !== next.transcriptVerbosity`.
    - `turn-card-modes.tsx` playground.
  - The P4.4 arm in "interrupted with no meaningful work" (`intermediate` or `thinking`).
  - Thinking label: take upstream's `t('chat.processing.thinking')` (present in our en and ru). `turnCard.thinkingIndicator` (`en.json:3427`) is retired if `git grep` then finds no reader.
  - Inline-code annotation: ours writes `style.outline` (since the pivot baseline `845cf0a41`); upstream writes `boxShadow` plus `removeProperty('box-shadow')`. Take upstream; confidence on why ours differs is LOW. Verify with the playground annotation states.
  - `InlineExecution.tsx`: `InlineActivityItem` and `mapToolEventToActivity` stay in `inline-execution-helpers.ts`, re-exported (our hunk, div 42).
- **i18n:** `turnCard.plan`, `turnCard.moreActions`, `turnCard.viewAsMarkdown` (missing). `chat.branchOptions`, `chat.branch`, `chat.branchFromThisMessage`, `chat.branchFromThisMessageDescription`, `common.copy`, `common.copied` and `common.viewFullscreen` already exist (not reported missing by the scan).
- **Tests:**
  - `accept-plan-chevron-group.test.ts` (existing, reads both plan files: `group/accept` and `group-data-[state=open]/accept:rotate-180` must survive; upstream keeps both).
  - `transcript-verbosity.test.ts` and `turn-lifecycle.test.ts`, `turn-phase.test.ts` (existing): positive, Verbose opens the log; negative, Summary keeps the step count.
  - New `turn/__tests__/response-footer.test.tsx`. Positive: Copy, Markdown, Fullscreen and Branch render as named buttons. Negative: without `onPopOut`/`onBranch` those buttons are absent, and `variant="plan"` is always visible (no `HOVER_REVEAL`).
  - Playground: answer, plan with Accept, streaming answer, compact plan drawer, annotations, in dark theme.
- **Runtimes:** runtime-neutral (the shell); it carries per-runtime rows via R3-05.
- **Done means:**
  - `TurnCard.tsx` matches the v0.15.1 shape plus our named hunks only.
  - `@nessy-agent/ui` still exports `SIZE_CONFIG`, `ActivityStatusIcon` and `formatToolDisplay`.
  - The UB6.11 `decide` arm in `formatToolInput` is already present (upstream keeps it, so take it now).

**R3-07 `[ui]` `[design]` User bubble, system marker, session viewer (S).**
- **Needs:** R3-01.
- **Upstream:** v0.15.1:
  - `packages/ui/src/components/chat/UserMessageBubble.tsx`: radius 16, 15/24 copy, max width 82% (90% compact), raised badges, `BUBBLE_MARKDOWN`.
  - `SystemMessage.tsx`: tinted inline marker with a role icon.
  - `SessionViewer.tsx`: logo `size-8 text-accent/40`.
- **Files:** those three.
- **Method:**
  - `SystemMessage`: take 1:1 (div 0).
  - `UserMessageBubble`: take, then re-apply hunks (div 18).
  - `SessionViewer`: take, then re-apply hunks (div 17).
- **Keep:**
  - `UserMessageBubble`: `SessionAttachmentDto` instead of `StoredAttachment`; the `onAttachmentOpen(handleId)` prop; `att.previewUrl` instead of `data:` base64; `key={att.handleId || i}` (our hunks at upstream-v0.14.0 L13/L311/L416-L446).
  - `SessionViewer`: our exported `NessyLogo` (normalised `CraftLogo`) mark path, with upstream's new classes.
- **Tests:**
  - New `chat/__tests__/user-message-bubble.test.tsx` (`renderToStaticMarkup`). Positive: an image attachment with `previewUrl` renders `<img src=previewUrl>`. Negative: no `previewUrl` renders the icon placeholder and never a `data:image/png;base64,` src.
  - `SystemMessage`: positive, `type="error"` uses `bg-destructive-tint` plus the circle-alert icon; negative, `type="system"` uses no left rule.
  - Playground: R1's chat registry bubbles in dark theme.
- **Runtimes:** runtime-neutral.

**R3-08 `[renderer]` `[design]` Transcript messages extracted: MessageBubble, ErrorMessage, TranscriptStates (L).**
- **Needs:** R3-07. R6's `apps/electron/src/renderer/components/ui/{button.tsx,skeleton.tsx,collapsible.tsx}` rows (`IconButton`, `Button variant="primary" size="md"`, `Skeleton`). R7's `hooks/useDelayedLoading.ts`. R1's `@nessy-agent/ui/motion` subpath export (`packages/ui/package.json`).
- **Pairs with R2's `ChatDisplay.tsx` row:** that row deletes our inline `ErrorMessage` (ours `ChatDisplay.tsx:3545`), `MessageBubble` (`:3650`), `MemoizedMessageBubble` (`:3885`) and the inline load/empty states (`:2385-2467`), and imports these files. Both land in one commit, or this row lands first and is unused until R2's.
- **Upstream:** v0.15.1 `apps/electron/src/renderer/components/app-shell/chat-display/`:
  - `MessageBubble.tsx`: assistant as plain copy; status line; `INFO_LEVELS`; compaction divider with `bg-separator`; warning marker.
  - `ErrorMessage.tsx`: destructive inset-ring marker; actions as Buttons, the first one primary; `stripRepeatedTitle` (R2 owns `strip-repeated-title.ts`).
  - `TranscriptStates.tsx`: `TranscriptSkeleton`, `TranscriptLoadError`, `NoRenderableMessages`, `CompactEmptyState`, `NewChatEmptyState` (serif display heading), `EarlierMessagesHint`.

  All three are ADDED.
- **Files:** the three new files.
- **Method:** add, then merge in our specifics, which today live inline in our `ChatDisplay.tsx`. The diff of our `:3545-3900` against upstream v0.14.0 `ChatDisplay.tsx:2153-2390` is in `scratchpad/r3/ours-msgbubble.tsx`.
- **Keep (all in our `ChatDisplay.tsx`):**
  - **ErrorMessage:**
    - D1.194 / D1.272 credential sign-in: `resolveCredentialSignIn(message.errorCode, connectionSlug)` from `sessionMetaMapAtom`; a `data-testid="credential-sign-in"` button first, as the primary; `isReplacedByCredentialSignIn` drops the backend's `settings` action; `connectionSlug` is passed to `handleErrorMessageAction`.
    - `t('chat.errorRaw')`, never upstream's literal `Raw: {`, which `renderer-hardcoded-strings.test.ts:312` forbids.
  - **MessageBubble:**
    - F1.351 `taskNotification`: the `TaskNotificationLine`, before the user branch.
    - `MemoryContextMenu`: save-to-memory, and rewind with `rewindAnchorId(message)` (C3.384), around both the user and assistant branches.
    - `workspaceId` plus `onAttachmentOpen`, which goes to `window.electronAPI.openSessionAttachment`.
    - The **runtime-switch marker**: `parseRuntimeSwitchMarker`, `runtimeSwitchNoticeKey(switchMarker.carry)`, an `ArrowLeftRight` rule with R1 "what crossed". It is redrawn in the new divider style like `compaction_complete`.
    - P2.37 **terminal-reason** notice: `parseTerminalReasonMarker`, `terminalReasonNoticeKey`; an unknown reason renders nothing.
    - P6.712 / P6.731 `infoNoticeLayout` (pre-wrap and conditional select, `ChatDisplay.info-notice.ts`).
    - Warning heading: ours `chat.warningBubble.heading` (C3.331), upstream `chat.warning`. Take upstream's key and retire ours once no reader remains.
    - Memo comparator includes `onSaveToMemory` and `onRewindMessage`.
  - **TranscriptStates:**
    - D1.382 `emptyStateLabel` replaces both compact empty-state lines.
    - Retry label: ours `chat.retrying` (`ChatDisplay.tsx:2423`), upstream `common.retrying`. Take upstream's and retire ours.
- **i18n:** `chat.warning`, `common.retrying`, `chat.newChatTitle`, `chat.newChatSubtitle` (missing). The suggestion chips under `NewChatEmptyState` belong to R2/B3 (`new-chat-suggestions.ts`).
- **Tests:**
  - Retarget source-reading tests that read `ChatDisplay.tsx` for these branches: `task-notification-line.test.tsx:60,70`; `rewind-menu.test.tsx`; `ChatDisplay.info-notice.test.ts`; `renderer-hardcoded-strings.test.ts:273,312`, which must now list `chat-display/ErrorMessage.tsx` and `TranscriptStates.tsx` with `chat.errorRaw`, `chat.noRenderableMessages` and `chat.noRenderableMessagesHint`.
  - Existing value tests stay: `lib/__tests__/credential-sign-in.test.ts`, `input/__tests__/runtime-switch-copy.test.ts`, `error-message-actions.test.ts`.
  - New `chat-display/__tests__/message-bubble.test.tsx`. Positive: an `info` message `runtime_switched:pi:claude…` renders the switch rule with its i18n sentence, and an `auth` error code renders `[data-testid=credential-sign-in]` first. Negative: an unknown `terminal_reason:` renders nothing, and a `taskNotification` user entry never renders the user bubble.
  - Playground: the chat registry error, warning, info, compaction and runtime-switch states plus the transcript skeleton, in dark theme.
- **Runtimes:**
  - The runtime-switch marker spans all three.
  - Credential sign-in is per connection (gateway `claude-gateway` / BYO).
  - The rest is runtime-neutral.
- **Done means:** our `ChatDisplay.tsx` holds no message-rendering function; every kept specific is reachable from `chat-display/*`; i18n is green.

**R3-09 `[renderer]` Run-in-background message (XS; 0.15.0 "Run shell snippets in the background", agent-message half).**
- **Needs:** none. Its readers are R2's `ChatDisplay` `RunCommandProvider value={session ? handleRunCommand : null}` (v0.15.1 `ChatDisplay.tsx:884,1365`) and the composer reader's `FreeFormInput` paste offer (v0.15.1 `FreeFormInput.tsx:1172` `consoleSnippetCommand`).
- **Upstream:** v0.15.1 `apps/electron/src/renderer/lib/run-command-message.ts` and `lib/__tests__/run-command-message.test.ts` (ADDED).
- **Files:** those two.
- **Method:** take 1:1.
- **Native-first:** the button sends an ordinary user message that ASKS the agent to start the command as a background task, so the session's permission mode, cards and chips apply unchanged. No new authority, no host execution path.
  - **Claude:** native `Bash` `run_in_background`.
  - **Pi:** our bash tool takes `run_in_background` (`packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts:130,422,434`).
  - **Codex:** its model has no `Bash` tool and no such parameter. Codex has native background terminals (`codex-agent.ts:2369-2401`, `thread/backgroundTerminals/*`), but whether the model, given this wording, starts one or blocks is a HYPOTHESIS. The live arm in R3-13 measures it on the binary. If it blocks, a follow-up row adds a codex wording variant named after what codex's own tool accepts (read-don't-invent).
- **Tests:** copy the upstream test. Positive: a bash fence plus the background instruction. Boundary: a command holding ```` ``` ```` gets a four-backtick fence.
- **Runtimes:** Pi and Claude native; Codex is a stated residue until measured.

**R3-10 `[renderer]` `[design]` Auth request card on the decision-card material (L).**
- **Needs:** R4's `apps/electron/src/renderer/components/app-shell/input/structured/DecisionCard.tsx` row (`DecisionCard`, `DecisionHeader`, `DecisionBody`, `DecisionActions`, `DECISION_ACTION`, …). R6's `button.tsx`.
- **Pairs with B4:** B4 also lists this path, for 0.15.1 "One sign-in for parallel sessions", whose host half adds `restart` to `performOAuth` and makes sessions join a sign-in already in progress.
- **Upstream:**
  - v0.15.0 `apps/electron/src/renderer/components/chat/AuthRequestCard.tsx`: `AuthOutcome` tones; every title and status translated (`chat.authCard.*`); field chrome; a provider name on the sign-in button.
  - v0.15.1 adds `startOAuth(restart)` with `oauthAttemptRef` (only the latest attempt ends the spinner) and a "Restart sign-in" action while the browser sign-in runs.
- **Files:** `AuthRequestCard.tsx`.
- **Method:** per-hunk merge. Our 1096 lines diverge by 521; upstream changed 485.
- **Keep (ours, `ours-auth.diff`):**
  - The whole **dp (Developer Platform / Nestor) login card**: `AuthRequestType` includes `'dp'` (`packages/core/src/types/message.ts:34-38`); `DpSessionStatus`, `resolveDpAuthUi`, `routeDpAuthStatus`, `runDpAuthAttempt`, `dpAuthStatusForResult`, the `auth-url:` status into `GatewayAuthUrlHint`. Its title becomes an i18n key (`chat.authCard.titleDp`, new; today the literal `'Developer Platform'`).
  - Plugin-server OAuth: `buildOAuthCardRequest`, `pluginServerAuthKind`, `message.authPluginServer`.
  - OAuth cancel (`window.electronAPI.cancelOAuth`), `resolveOAuthUi`, `shouldAbortOAuthOperation`, and the transient codes `cancel-failed` / `settlement-failed`. Their English messages `OAUTH_CANCEL_FAILURE_MESSAGE` / `OAUTH_SETTLEMENT_FAILURE_MESSAGE` should become keys; the AGENTS.md i18n rule says keys in all locales.
  - **No Slack or Microsoft arms:** our `AuthRequestType` has no `oauth-slack`/`oauth-microsoft`, so upstream's `titleSlack` / `titleMicrosoft` keys and switch arms are NOT ported (removed surface, owner specific 6).
  - **Restart sign-in:** take it only if B4's host row lands `restart` (and joining). Otherwise it is out of scope and recorded.
- **i18n:** `chat.authCard.{authenticating,cancelled,completeInBrowser,connected,encryptedAtRest,failed,restartSignIn,signInWith,signedInAs,titleCredential,titleGoogle,titleOAuth,workspace}`, `chat.credentials.{showValue,hideValue}`, plus ours `chat.authCard.titleDp` (all missing).
- **Tests:**
  - Existing `AuthRequestCard.dp-auth.test.tsx` and `AuthRequestCard.oauth.test.tsx` stay green: positive, the dp card reaches `connected` on `ready`; negative, a cancelled dp error code is `cancelled`, not `failed`.
  - New arm: a completed OAuth card renders the `AuthOutcome` success tone with `signedInAs`; an unknown type never renders a Slack or Microsoft title.
  - Playground: auth card pending, credential form, dp waiting-browser with URL hint, connected, failed, in dark theme.
- **Runtimes:** runtime-neutral host UI. The dp card is the Nessy gateway specific.

**R3-11 `[renderer]` `Info_Markdown` on the info card language (XS).**
- **Needs:** R7's `apps/electron/src/renderer/components/info/Info_FullscreenButton.tsx` row and R1's `px-card-pad` spacing token. This row may equally be folded into R7's `info/*` row.
- **Upstream:** v0.15.1 `apps/electron/src/renderer/components/info/Info_Markdown.tsx`.
- **Files:** `Info_Markdown.tsx`.
- **Method:** take, then re-apply one hunk (div 25).
- **Keep:** P6.850, the leaf import `@nessy-agent/ui/overlay/DocumentFormattedMarkdownOverlay` (not the barrel), with its measurement comment.
- **Tests:** positive, `fullscreen` renders `Info_FullscreenButton`; negative, without `fullscreen` there is no button.

**R3-12 `[renderer]` `[design]` Our own transcript cards on the new language (M; no upstream counterpart).**
- **Needs:** R3-05 and R3-08.
- **Upstream:** none. These files are ours (each absent at v0.15.1, by `git cat-file -e v0.15.1:<path>`).
- **Files:**
  - `apps/electron/src/renderer/components/app-shell/{SubagentCard.tsx,WorkflowPanel.tsx,TodoListCard.tsx,AdvisorConsultationCard.tsx,task-notification-line.tsx,deferred-spawn-chip.tsx}`.
  - `packages/ui/src/components/chat/PublishedArtifactChip.tsx`.
  - The runtime-switch divider markup lives in R3-08.
- **Method:** restyle onto `turn-classes` (`WORK_LOG_ROW`, `ROW_ICON_SLOT`, `CHIP_NEUTRAL` / `CHIP_DESTRUCTIVE`), `TurnIconButton` and `PreviewBlockFrame` where a card is a well. Behaviour is unchanged.
- **Keep:** every routing decision in `activity-card-routing.ts` (P3.24) and `isTodoCardActivity` / `isAdvisorCardActivity`, untouched.
- **Tests:** existing `activity-slot-cards.test.tsx`, `codex-collab-tool-routing.test.ts`, `task-notification-line.test.tsx`, `published-artifact.test.ts` stay green (positive). Negative: a card that cannot render still yields the ordinary row (`activity-slot-cards`). Playground: subagent (pi and codex), workflow, todo card, advisor card, in dark theme.
- **Runtimes:** Pi `subagent`, Codex collab, Claude todo/advisor: all three.

**R3-13 `[cdp]` `[pi]` `[claude]` `[codex]` Transcript look, live sitting case (M).**
- **Needs:** R3-02 through R3-12. RS id allocated by the controller.
- **Files:** `scripts/cdp/cases/rs-NNN.ts` (`meta.row` = the UB id of this row) and the checklist row.
- **Arms:** packaged build, `env -u` launcher, DARK theme, `bypassPermissions`, one session per runtime (Pi gateway card, `claude-gateway`, a codex card); read back the BOUND connection as RS-121 does. Each arm prompts a turn that reads two files, edits one, runs one failing command and answers with a `bash` fence and a diff fence. Screenshots:
  1. collapsed work log with "N failed" chip;
  2. expanded rows (codex `mcp__sources__…` row name correct; Claude `Agent` group; Pi `subagent` card);
  3. sunken code well with Run;
  4. diff well header;
  5. error marker;
  6. after clicking Run, a background task chip appears. On codex, record whether it blocked: the R3-09 measurement.
- **Done means:** a PASS per runtime recorded in `docs/testing/cdp-live-checklist.md`, the codex Run reading written down, and the screenshots under `docs/testing/cdp-runs/`.

## 3. Functional changes hidden in the redesign

| # | Upstream change | Paths (v0.15.x) | Our state + evidence | Disposition | Row |
| --- | --- | --- | --- | --- | --- |
| 1 | "Run in background" on shell and console code blocks; never while streaming; `$` prompts stripped; plain text never a command | `markdown/{CodeBlock.tsx,RunCommandContext.tsx,shell-command.ts}`, `TurnCard.tsx` (`RunCommandProvider value={isStreaming?null:runCommand}`), `lib/run-command-message.ts` | Absent: no `RunCommandContext.tsx` or `shell-command.ts` in our `markdown/` listing | TAKE (UI). ADAPT: codex wording is a measured residue | R3-02, R3-06, R3-09 (wiring: R2; paste: composer reader) |
| 2 | Subagent rows from an earlier turn grouped as `continued`; nested subagent rows kept inside the outer group | `chat/turn-utils.ts`, `turn/ActivityGroupRow.tsx` | Ours equals v0.14.0 in `groupActivitiesByParent` (div 161 is all elsewhere) | TAKE (Claude-only reach, measured) | R3-04, R3-05 |
| 3 | Turn error count leaves the preview text and becomes a "N failed" chip; completed summary reads "N steps completed" | `turn/work-log-summary.ts`, `turn/WorkLog.tsx` | Ours: `turn-preview.ts` `getPreviewText` appends `turnCard.errorCount` and uses `summarizeTurnRun` (`turn-preview.ts:153`) | ADAPT: take the chip; keep our run-summary text in place of "N steps completed" | R3-05 |
| 4 | Answer no longer capped at 540px; fullscreen moved into the footer; first mermaid keeps its expand (`hideFirstMermaidExpand={false}`) | `TurnCard.tsx` (`MAX_HEIGHT` removed) | Ours keeps the cap (v0.14.0 shape) | TAKE | R3-06 |
| 5 | One render tree for streaming and completed answers; blocks fade in once (`@starting-style`); rows animate only when inserted after mount | `TurnCard.tsx`, `turn/turn-classes.ts`, `turn/use-row-reveal.ts` | Ours: framer per-row stagger, separate streaming view | TAKE | R3-01, R3-06 |
| 6 | Tree connector lines removed; inset hairline; icon · verb · object · right-aligned stats and ✓/✗; file name inline | `turn/ActivityRow.tsx` | Ours: `TreeViewConnector` (v0.14.0 shape) | TAKE | R3-05 |
| 7 | Diff well: path and +/− header, classic indicators, height reserved before async paint | `MarkdownDiffBlock.tsx`, `diff-summary.ts` | Ours = v0.14.0 (div 0) | TAKE | R3-02 |
| 8 | Datatable/spreadsheet: loading well instead of a one-frame JSON fallback; translated yes/no/no-rows | `MarkdownDatatableBlock.tsx`, `MarkdownSpreadsheetBlock.tsx` | Ours = v0.14.0; literal "No rows" | TAKE | R3-03 |
| 9 | Doc/HTML/PDF/image blocks reserve height while loading; HTML iframe on `bg-paper` (was white); HTML bottom fade removed | `MarkdownDocBlock.tsx`, `MarkdownHtmlBlock.tsx`, `MarkdownPdfBlock.tsx`, `MarkdownImageBlock.tsx` | Ours = v0.14.0 plus Publish | TAKE, re-apply Publish | R3-03 |
| 10 | Multi-item navigator moves into the block header (`PreviewItemNavigator`) | `PreviewBlockChrome.tsx` | Ours uses `overlay/ItemNavigator` | TAKE | R3-03 |
| 11 | Tooltip timing 500ms, then 300ms skip window; floating material | `tooltip.tsx` | Ours: 300ms, no skip (div 0) | TAKE (app-wide) | R3-01 |
| 12 | Auth card restart for a lost browser sign-in; only the latest attempt ends the spinner | `AuthRequestCard.tsx` (v0.15.1) | Absent; ours has cancel plus transient codes instead | ADAPT, paired with B4's host `restart` / joining | R3-10 |
| 13 | Auth card titles and statuses translated | `AuthRequestCard.tsx` | Ours: English literals (`getAuthTypeLabel`, `AuthRequestCard.tsx:585-596`) | TAKE, minus Slack/Microsoft, plus dp | R3-10 |
| 14 | Error marker: actions as Buttons (first primary), repeated title stripped, details on a sunken well | `chat-display/ErrorMessage.tsx` | Ours inline in `ChatDisplay.tsx:3545` with credential sign-in | ADAPT (keep credential sign-in and `chat.errorRaw`) | R3-08 |
| 15 | Assistant message is plain copy (no card); status and info rows match the live line | `chat-display/MessageBubble.tsx` | Ours: card (`ChatDisplay.tsx` assistant branch) | TAKE, keep the memory menu | R3-08 |
| 16 | New-chat empty state with serif display heading; transcript skeleton after 200ms | `chat-display/TranscriptStates.tsx` | Ours: spinner (`ChatDisplay.tsx:2385-2396`) | TAKE (suggestions: R2/B3) | R3-08 |
| 17 | Commentary row icon becomes `MessageSquareText` (the dashed circle read as a "Todo" glyph) | `turn/ActivityRow.tsx` | Ours: `MessageCircleDashed` plus `Brain` for reasoning (P4.4) | ADAPT: take it for commentary, keep `Brain` for reasoning | R3-05 |
| 18 | ⋯ menu trigger is a real button with `aria-expanded`/`haspopup` | `TurnCardActionsMenu.tsx` | Ours: `div role=button` (div 0) | TAKE | R3-06 |
| 19 | Display names for `project_memory_append`, `source_list_resources`, `source_read_resource`, `source_list_prompts`, `source_get_prompt` (0.15.1) | `turn/tool-display.ts` | Absent from `SESSION_TOOL_DISPLAY_NAMES` (control: `TodoWrite` present) | ADAPT: into the shared table, only with the B-rows that land the tools | R3-05 (gated on B rows) |
| 20 | Visible-message filter `m.hidden` | `turn-utils.ts` (since v0.11.0) | Absent by decision (F1.351, "not hidden") | KEEP absence (N/A) | R3-04 (Keep) |
| 21 | Markdown links underlined (accent/40 decoration); headings 16/24 | `Markdown.tsx` | Ours = v0.14.0 | TAKE | R3-02 |
| 22 | `formatToolInput` `mcp__session__decide` → '' | `turn/tool-display.ts` | Ours removed that arm (no decide tool yet) | TAKE now (harmless; UB6.11 needs it) | R3-05 |

## 4. Our specifics to keep (file → what to re-apply)

- **`packages/ui/src/components/chat/TurnCard.tsx`**
  - `OrchestrationProgress` and `ActivityItem.orchestrationProgress`.
  - `displayContent` / `displayText` (R32).
  - `ActivityRenderProps` and `renderActivity`.
  - `transcriptVerbosity` (P6.469): forced expand, filtered list, unfiltered count, memo line.
  - P4.4 `thinking` in the interrupted check.
  - Imports from our pure modules (`tool-display`, `intermediate-row`, `tool-elapsed`, `run-summary`, `turn-preview`, `transcript-verbosity`, `PublishedArtifactChip`).
- **`turn/ActivityRow.tsx`** (new)
  - `describeIntermediateRow` (thinking rows, Brain, de-emphasis, `displayContent`).
  - `describeToolElapsed` (P4.9) with i18n labels; never the `Task ID:` literal.
  - `PublishedArtifactChip` (UA1.19).
  - `i18n.t('turnCard.processing')` fallback.
- **`turn/tool-display.ts`** (new): `formatToolDisplay` and `getToolDisplayName` from our `chat/tool-display.ts` and `turn-preview.ts` (`parseMcpToolName`, codex `sources` bridge, F1.217; `SESSION_TOOL_DISPLAY_NAMES`, F1.434/435).
- **`turn/work-log-summary.ts`** (new): our `summarizeTurnRun` completed label; imports only bun-loadable modules (P2.493 convention).
- **`turn/WorkLog.tsx`, `turn/ActivityGroupRow.tsx`** (new): the `renderActivity` passthrough (P3.24 `SubagentCard` for Pi `subagent` and codex collab, `WorkflowPanel`, `TodoListCard` P2.503, `AdvisorConsultationCard` P4.5).
- **`turn-utils.ts`**: R20 checklist, P4.4, R32, P2.37, F1.931, P6.561, F1.477 status success, P2.504 English export docblocks, no `hidden` filter (F1.351).
- **`InlineExecution.tsx`**: the helper split into `inline-execution-helpers.ts` with re-exports.
- **`UserMessageBubble.tsx`**: `SessionAttachmentDto`, `previewUrl`, `handleId`, `onAttachmentOpen`.
- **`SessionViewer.tsx`**: the Nessy logo mark (exported).
- **`MarkdownDocBlock.tsx`, `MarkdownHtmlBlock.tsx`**: UA1.23 Publish action (`previewPublishTarget`, `onPublishFile`, `data-preview-publish`).
- **`MarkdownMermaidBlock.tsx`**: i18n'd aria-label (move to upstream's `preview.openMermaidFullscreen` key).
- **`MarkdownDiffBlock.tsx`**: Nessy shiki theme names.
- **`chat-display/ErrorMessage.tsx`** (new, from our `ChatDisplay.tsx`): D1.194/D1.272 credential sign-in, `connectionSlug` in actions, `chat.errorRaw`.
- **`chat-display/MessageBubble.tsx`** (new): F1.351 task-notification line, `MemoryContextMenu` (save to memory, rewind C3.384), `onAttachmentOpen`/`workspaceId`, runtime-switch marker, P2.37 terminal reason, P6.712/P6.731 info layout, memo comparator props.
- **`chat-display/TranscriptStates.tsx`** (new): D1.382 `emptyStateLabel`.
- **`AuthRequestCard.tsx`**: the dp login card (state machine, auth-url hint), plugin-server OAuth, OAuth cancel with transient codes, no Slack or Microsoft, a `titleDp` key.
- **`Info_Markdown.tsx`**: the P6.850 leaf import.
- **Our transcript cards** (R3-12): restyle only; routing untouched.

## 5. Per-path disposition (every assigned path)

`div` = `div_vs_141` from `divergence.json`. It equals `div_vs_134` for all 51 paths and was re-measured by brand-normalised `diff` against v0.14.0, which gives identical numbers. Upstream v0.14.0 = v0.14.1 for every path.

| Path | Ours | Div | Method | Row |
| --- | --- | --- | --- | --- |
| apps/electron/src/renderer/components/app-shell/chat-display/ErrorMessage.tsx | — (inline in our `ChatDisplay.tsx:3545`) | ADDED | add, merge our inline specifics | R3-08 |
| apps/electron/src/renderer/components/app-shell/chat-display/MessageBubble.tsx | — (inline `ChatDisplay.tsx:3650,3885`) | ADDED | add, merge our inline specifics | R3-08 |
| apps/electron/src/renderer/components/app-shell/chat-display/TranscriptStates.tsx | — (inline `ChatDisplay.tsx:2385-2467`) | ADDED | add, merge | R3-08 |
| apps/electron/src/renderer/components/chat/AuthRequestCard.tsx | same path (1096 lines) | 521 | per-hunk merge | R3-10 (with B4) |
| apps/electron/src/renderer/components/info/Info_Markdown.tsx | same path | 25 | take, re-apply leaf import | R3-11 (or R7) |
| apps/electron/src/renderer/lib/__tests__/run-command-message.test.ts | — | ADDED | take 1:1 | R3-09 |
| apps/electron/src/renderer/lib/run-command-message.ts | — | ADDED | take 1:1 | R3-09 |
| packages/ui/src/components/chat/AcceptPlanDropdown.tsx | same | 0 | take 1:1 | R3-06 |
| packages/ui/src/components/chat/CompactAcceptPlanDrawer.tsx | same | 0 | take 1:1 | R3-06 |
| packages/ui/src/components/chat/InlineExecution.tsx | same | 42 | take, re-apply helper split | R3-06 |
| packages/ui/src/components/chat/SessionViewer.tsx | same | 17 | take, re-apply logo | R3-07 |
| packages/ui/src/components/chat/SystemMessage.tsx | same | 0 | take 1:1 | R3-07 |
| packages/ui/src/components/chat/TurnCard.tsx | same (3222 lines) | 457 | per-hunk merge | R3-06 |
| packages/ui/src/components/chat/TurnCardActionsMenu.tsx | same | 0 | take 1:1 | R3-06 |
| packages/ui/src/components/chat/UserMessageBubble.tsx | same | 18 | take, re-apply attachment DTO hunks | R3-07 |
| packages/ui/src/components/chat/__tests__/turn-utils-grouping.test.ts | same | 0 | take 1:1, plus one negative case | R3-04 |
| packages/ui/src/components/chat/turn-utils.ts | same | 161 | re-apply the upstream grouping hunk onto ours | R3-04 |
| packages/ui/src/components/chat/turn/ActivityGroupRow.tsx | — | ADDED | add, plus `renderActivity` passthrough | R3-05 |
| packages/ui/src/components/chat/turn/ActivityIcons.tsx | — | ADDED | take 1:1 | R3-01 |
| packages/ui/src/components/chat/turn/ActivityRow.tsx | — (`ActivityRow` inside our `TurnCard.tsx`) | ADDED | add, merge our row decisions | R3-05 |
| packages/ui/src/components/chat/turn/ResponseFooter.tsx | — | ADDED | take 1:1 | R3-06 |
| packages/ui/src/components/chat/turn/ThinkingRow.tsx | — | ADDED | take 1:1 | R3-01 |
| packages/ui/src/components/chat/turn/TodoList.tsx | — | ADDED | take 1:1 | R3-05 |
| packages/ui/src/components/chat/turn/TurnIconButton.tsx | — | ADDED | take 1:1 | R3-01 |
| packages/ui/src/components/chat/turn/WorkLog.tsx | — | ADDED | add, plus `renderActivity` passthrough | R3-05 |
| packages/ui/src/components/chat/turn/tool-display.ts | — (ours: `chat/tool-display.ts`, `turn-preview.ts`) | ADDED (+5 lines in 0.15.1) | add, delegate names to ours | R3-05 |
| packages/ui/src/components/chat/turn/turn-classes.ts | — | ADDED | take 1:1 | R3-01 |
| packages/ui/src/components/chat/turn/use-row-reveal.ts | — | ADDED | take 1:1 | R3-01 |
| packages/ui/src/components/chat/turn/work-log-summary.ts | — (ours: `turn-preview.ts`, `run-summary.ts`) | ADDED | add, ADAPT text to run-summary | R3-05 |
| packages/ui/src/components/markdown/CodeBlock.tsx | same | 0 | take 1:1 | R3-02 |
| packages/ui/src/components/markdown/CollapsibleSection.tsx | same | 0 | take 1:1 | R3-02 |
| packages/ui/src/components/markdown/ImageCardStack.tsx | same | 0 | take 1:1 | R3-03 |
| packages/ui/src/components/markdown/Markdown.tsx | same | 0 | take 1:1 | R3-02 |
| packages/ui/src/components/markdown/MarkdownDatatableBlock.tsx | same | 0 | take 1:1 | R3-03 |
| packages/ui/src/components/markdown/MarkdownDiffBlock.tsx | same | 0 | take 1:1 (brand) | R3-02 |
| packages/ui/src/components/markdown/MarkdownDocBlock.tsx | same | 25 | take, re-apply Publish | R3-03 |
| packages/ui/src/components/markdown/MarkdownHtmlBlock.tsx | same | 25 | take, re-apply Publish | R3-03 |
| packages/ui/src/components/markdown/MarkdownImageBlock.tsx | same | 0 | take 1:1 | R3-03 |
| packages/ui/src/components/markdown/MarkdownJsonBlock.tsx | same | 0 | take 1:1 | R3-02 |
| packages/ui/src/components/markdown/MarkdownMermaidBlock.tsx | same | 2 | take (upstream key) | R3-03 |
| packages/ui/src/components/markdown/MarkdownPdfBlock.tsx | same | 0 | take 1:1 | R3-03 |
| packages/ui/src/components/markdown/MarkdownSpreadsheetBlock.tsx | same | 0 | take 1:1 | R3-03 |
| packages/ui/src/components/markdown/PreviewBlockChrome.tsx | — | ADDED | take 1:1 | R3-03 |
| packages/ui/src/components/markdown/RunCommandContext.tsx | — | ADDED | take 1:1 | R3-02 |
| packages/ui/src/components/markdown/TableExportDropdown.tsx | same | 0 | take 1:1 | R3-03 |
| packages/ui/src/components/markdown/__tests__/diff-summary.test.ts | — | ADDED | take 1:1 | R3-02 |
| packages/ui/src/components/markdown/__tests__/shell-command.test.ts | — | ADDED | take 1:1 | R3-02 |
| packages/ui/src/components/markdown/diff-summary.ts | — | ADDED | take 1:1 | R3-02 |
| packages/ui/src/components/markdown/index.ts | same | 0 | take 1:1 | R3-02 |
| packages/ui/src/components/markdown/shell-command.ts | — | ADDED | take 1:1 | R3-02 |
| packages/ui/src/components/tooltip.tsx | same | 0 | take 1:1 | R3-01 |

Overlaps relied on (owned by other readers):
- **R1:** `packages/ui/src/styles/*` tokens and utilities, `packages/ui/src/motion/*`, `packages/ui/package.json` (`./motion` export), playground `registry/{turn-card,markdown,chat}.tsx`.
- **R2:** `ChatDisplay.tsx`, `chat-display/{ProcessingIndicator,ScrollOnMount,TurnFrame,NewChatSuggestions,new-chat-suggestions,strip-repeated-title}`.
- **R4:** `input/structured/DecisionCard.tsx`.
- **R6:** electron `ui/{button,skeleton,collapsible}.tsx`.
- **R7:** `packages/ui/src/components/ui/{AnimatedCollapsibleContent,StyledDropdown,index}.tsx`, `packages/ui/src/index.ts`, `info/Info_FullscreenButton.tsx`, `hooks/useDelayedLoading.ts`.
- **B4:** `AuthRequestCard` behaviour, background-task chips and output views.
- **Composer reader:** `FreeFormInput` paste offer.
- **Draft plan:** UB6.11 (decide overlay in `TurnCard.tsx`; serialise with R3-06).

## 6. Owner questions

None needed. Decisions taken under the owner rules (1:1 with our specifics; read-don't-invent; simplest), stated so they can be overruled:
- Keep our run-summary label as the completed work-log preview (ours genuinely differs and is richer); take upstream's failed chip and drop our text error suffix.
- Adopt upstream's i18n key names where ours differ only in name, and retire ours once no reader remains:
  - `chat.warning` for ours `chat.warningBubble.heading`;
  - `common.retrying` for `chat.retrying`;
  - `preview.openMermaidFullscreen` for `overlay.openMermaidFullscreen`;
  - `chat.processing.thinking` for `turnCard.thinkingIndicator`.
- Run-in-background ships upstream's message text on all three runtimes. Codex behaviour is measured in R3-13 before any codex-specific wording is written.
- Auth-card "Restart sign-in" ships only together with B4's host `restart` / joining row.

## 7. Coverage

Assigned 51, read 51, skipped 0. Every path was read through `git diff v0.14.0 v0.15.1 -- <path>`, and per tag pair for release placement. The v0.15.1 full text was read for all 16 ADDED files and for `TurnCard.tsx`. For the markdown preview blocks (Datatable, Spreadsheet, Image, Pdf, Json, Mermaid, ImageCardStack), the non-className lines were read in full, and the className-only hunks were skimmed by pattern.
