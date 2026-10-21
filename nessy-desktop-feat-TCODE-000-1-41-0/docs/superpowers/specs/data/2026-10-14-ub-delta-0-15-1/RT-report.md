# RT — re-targeting the 41 draft rows from upstream v0.14.0 to v0.15.1

Read-only, 2026-10-14. Draft: `work/wi16/plan-1.43.0/plan-upstream-adoption-0-14-0.md` (line refs below are into it). Upstream: `.references/craft-agents-oss`, read only by tag. Ours: HEAD `f495cf311`.

## Method and instruments

- **Per-tag placement:** I ran `git diff --numstat` for v0.14.0→v0.14.1, v0.14.1→v0.15.0 and v0.15.0→v0.15.1 over the 87 unique paths in `retarget-rows.json`. The output is in `scratchpad/rt/numstat.txt`.
- **Large shared files, read in full:**
  - `SessionManager.ts`: the whole v0.14.0..v0.15.1 diff, 990 lines (`scratchpad/rt/sm.diff`).
  - `claude-agent.ts`: 319 lines (`ca.diff`).
  - `pi-agent.ts`, `backend/types.ts`, `base-agent.ts`, `pre-tool-use.ts`, `llm-connections.ts`, `event-adapter.ts`, `task-notification.ts`, `message.ts`, `dto.ts`, `TaskRunner.ts`, every session-tools-core file on the map, `validators.ts`, the labels files, `automations.md`, `labels.md`, `sources.md`, and `system.ts`.
  - `pi-agent-server/src/index.ts`: read with comment lines filtered out.
  - `browser-pane-manager.ts` (`bpm.diff`): grepped for its teardown and popup hunks, plus the test's case names.
- **How to read a verdict.** The map is file-level, so it is coarse. 22 rows list a file that changed only for some *other* feature. "(a) unchanged" means:
  - the row's own symbol or hunk has no hunk in the v0.14.0..v0.15.1 diff;
  - the hunk in the shared file is owned by the named row or report.
- **Positive control for "no diff" claims.**
  - `git diff --stat v0.14.0 v0.15.1` over 33 row-adjacent paths printed only the four `decisions/{records,usage}` files and `pick-mini-model.ts`. The other paths were `permission-remember.ts`, `mini-model-query.ts`, `verdict-decision.ts`, `smart-titles.ts`, `turn-outcome.ts`, `mid-turn-messages.ts`, `suggestions.ts`, `automation-condition.ts`, `permission-risks.ts`, `decide.ts`, `mode-manager.ts`, `rtk-detector.ts`, `rtk-rewrite.ts`, `oauth.ts`, `permission-manager.ts`, `prompt-handler.ts`, `pending-steers.ts`, `rpc/llm-connections.ts`, `compaction-wait.ts` and `tool-matching.ts`.
  - `git cat-file -t v0.15.1:<path>` returned `blob` for each of those 20 paths, so an empty diff means "unchanged", not "missing".
- **Id collision in the B reports (the plan writer must renumber).** The B reports assign the same ids to different new rows:

  | Id | Assigned by |
  |---|---|
  | UB3.9 | B1 (source-call `_intent`) and B4 (failed `source_test` visible) |
  | UB4.11 | B1 (sidebar titles), B3, and B4 (canonical labels) |
  | UB4.12–UB4.14 | B3 and B4 |
  | UB7.10–UB7.12 | B3 and B4 |
  | UB2.8 | B2 (Pi/codex Stop ends only the reply) and B4 (TaskRunner v0.15.1 arms) |

  Below I write "B4's UB4.11" and so on.

## Row verdicts

Verdict key: (a) unchanged · (b) amend · (c) split · (d) obsolete.

| row | verdict | what changes (precise) | new row if split | covered by B/R report? |
|---|---|---|---|---|
| UB8.1 | (b) | The lift it names, 0.3.274 → 0.3.280, is done: tracker L1089 records UA12.211. The new target is the v0.15.1 pin `@anthropic-ai/claude-agent-sdk` 0.3.296 (root, `packages/core`, `packages/shared` `package.json`; `bun.lock` moves all 8 platform binaries 0.3.280 → 0.3.296). Artifactory 14-day rule unchanged. Carry: (1) the detached-WebFetch/WebSearch guard (`event-adapter.ts` `isDetachedToolCallResult`/`DETACHED_TOOL_CALL_RESULT`, its `claude-event-adapter.test.ts` case, the matcher-less PostToolUse comment); (2) explicit `permissionMode` on side children (≥0.3.286); (3) F1.1217's list. Done-means: both self-reports print the 0.3.296 pair. | — | Yes: B2-04, S-03, B2-08. Nothing added. |
| UB8.2 | (b) | The lift it names, 0.85.1 → 0.87.1, is done (L1090, UA12.211). The new target is Pi `@earendil-works/*` 1.1.0 (root, `shared`, `pi-agent-server`, `server-core` `package.json`).<br>**Missed by B2:** the v0.15.1 `bun.lock` adds `pi-codemode@1.1.0`, `pi-mcp@1.1.0` and `quickjs-wasi@3.6.2`. It bumps `pi-telemetry`, `pi-tui` and `chord` to 1.1.0. Under `pi-ai` it moves `@anthropic-ai/sdk` 0.124.0 → 0.129.0 and `openai` 6.40.0 → **7.19.0 (a major)**. Every one of these must clear the mirror and quarantine.<br>Also rewrite UB2.6's Done-means: "green on Pi 0.85.1" at L344 becomes "green on 0.87.1 (HEAD), the guard for 1.1.0". | — | Mostly: B2-01/03/04 (a–f), B2-06, B2-10 (rename). The lockfile set is new here. |
| UB4.8 | (b) | The guard itself is unchanged: `sm.diff` has no `automationLoopGuard`/`MAX_AUTOMATION_CHAIN_DEPTH` hunk. Amend:<br>(i) Port the timeline `skipped` status at v0.15.1 styling (`statusConfig.skipped = {CircleSlash, 'text-tertiary'}`). Ours has no skipped status: `ExecutionStatus = 'success' \| 'error' \| 'blocked'` at `apps/electron/src/renderer/components/automations/types.ts:254` (control: `AutomationEventTimeline.tsx:22,24` hold the success/blocked rows). The rest of the v0.15.0 timeline restyle (`IconButton` copy, tokens, `blocked` → `text-info`) goes with the redesign row that owns `components/automations/*`; whichever lands second re-applies.<br>(ii) Copy only the loop-guard describe of `automation-loop-and-retry.test.ts`. The new cases in its `source-activation auto-retry` describe belong elsewhere: v0.14.1 auth-retry/hidden-nudge → UB6.14 (B1-08); v0.15.1 caller-chosen thinking → B4's UB2.9 or dropped adaptive thinking.<br>(iii) The `automations.md` LabelAdd/LabelRemove match value is now the entry (`id::value`), and `$CRAFT_LABEL` follows. Both belong to B4's UB4.11; UB4.8's bullet must not restate the old "Label ID". UB4.11 lands before UB4.8's live case.<br>(iv) The renderer `automations/types.ts` v0.15 hunk is the timezone fix (B4's UB4.13). Same file: serialise. | — | (iii) is in B4-03; (i), (ii) and (iv) are new. |
| UB6.9 | (a) | `automation-condition.ts` has no diff. The `automations.md` semantic-condition text is unchanged; only the LabelAdd rows moved (B4's UB4.11). Its skipped entry renders through UB4.8's `skipped` row, so it inherits UB4.8 (i). | — | — |
| UB6.8 | (b) | B1-11 covers the v0.15.0 `semantic-labels.ts` (`LabelEntrySet`, `foldsValueCase`). B4-03 covers `evaluator`/`canonical` and the regex half (B4's UB4.11). **Missed** (all v0.15.0):<br>(a) `SessionManager.applySemanticAutoLabels`: the dispatch snapshot is `new LabelEntrySet(labelsAtDispatch, foldsValueCase(labelTree))`, and it calls `applyAutoLabelMatches(…, labelTree)` (`sm.diff` hunk `@@ -1338`).<br>(b) `validateSemanticAutoLabelRule(rule, { valueType })` warns "value is ignored" on a plain label. It is wired in `config/validators.ts` `validateLabelsContent`, the only `validators.ts` hunk for this row; the theme-colour warnings in the same file belong to the redesign.<br>(c) `AutoRulesDataTable.tsx`: `ruleValueText` shows a value/template only for valued labels, plus the restyle (`Info_Badge color="default"`, `INFO_TABLE_*_CLASS`). Port the table at v0.15.1.<br>(d) `labels.md`: semantic `value` "Omitted, or on a plain label → the plain label id".<br>(e) The `EditPopover.tsx` labels `EDIT_CONFIGS` sentence on valueTemplate/value covers both regex and semantic rules: give it to B4's UB4.11. Its `TWEEN`/`EditButton` hunks go to the redesign.<br>**Needs:** B4's UB4.11. **Test (add):** a semantic rule with `value` on a plain label validates with the warning and applies the bare id. | — | Partly (B1-11, B4-03); (a)–(e) are new. |
| UB3.1 | (b) | Port v0.15.1 `api-auth.ts` plus test: header name/value validation, no CRLF, and a single custom header name is sent under that name. **Added:** the v0.15.1 `credential-manager.ts` hunk is the refresh single-flight key (B4-12 → B4's UB1.13, CRITICAL), not this row's. UB3.1 takes its `credential-manager.ts` hunk onto a file where UB1.13 has landed (same file). The v0.15.1 `sources.md` +9 is MCP resources/prompts (B4-06 HAVE / B4-08 DROP-c); UB3.1's paragraph is unchanged. | — | Yes: B4-21. |
| UB3.3 | (a) | `oauth.ts` and `generic-oauth.ts` have no diff. In `rpc/oauth.ts` and `oauth-flow-store.ts` the v0.15.1 change is the single-flight sign-in (B4-10 → B4's UB3.10); the `resource` lines only move (`resource: flow.resource` / `prepared.resource` re-indented). Port from v0.14.0 text; UB3.10 then rebases (B4: UB3.10 Needs UB3.3). | — | Yes (B4-10 sequencing). |
| UB4.6 | (a) | No teardown hunk. The `instances.delete`/`cdp.detach` path is untouched; the BPM's v0.15.1 hunks are B5-01…08. The popup-close arm only gains `popupOpenedOriginByWebContentsId.delete` (B5-08). B5 sequences every BPM row after UB4.6. | — | Yes: B5 (L19 of B5). |
| UB9.2 | (a) | The creation side is unchanged: the `task_started`/`task_updated` arms, `wasLaunchedByMainAgent`, `task_completed.launchedHere/toolUseId`, and the `task-notification.ts` `toolUseId`. Co-edits in its files belong to other rows: `task_progress` → `task_activity` (`event-adapter.ts`, `classifyClaudeTaskProgress`, `message.ts`, `dto.ts`, `App.tsx`) is B4's UB9.8; the detached-call guard is UB8.1; `stopBackgroundTask`/`getBackgroundTaskOutput` replacing `killShell`/`getTaskOutput` is B4-01; the `context.ts`/`tool-defs.ts` v0.15.1 hunks are project memory and MCP resources, not background tasks. | — | Yes: B4-01, B3-29. |
| UB7.4 | (b) | Logic unchanged: no diff in `rtk-detector`/`rtk-rewrite`; `rtkContext` is untouched in `claude-agent`/`pi-agent`; the `validators.ts` hunks are labels and theme. Cosmetic: `RtkUpdateDialog.tsx` at v0.15.1 classes (R6-14). `AiSettingsPage` reads `settings.rtkEnabled`/`rtkStatus` from the batched settings load, and the gain bar becomes `scaleX` (R5-09a). The `<RtkUpdatePrompt>` mount is unchanged (v0.14.0 `AppShell.tsx:3966-3967` → v0.15.1 `:2914-2915`) but lands in the redesigned AppShell. `SettingsToggle` per R5-01. | — | Yes: R6-14, R5-01/09a. |
| UB1.2 | (a) | `permission-remember.ts` has no diff. `canRemember` keeps its meaning (v0.15.1 `PermissionRequest.tsx:49`). The markup moves into `DecisionCard`; the Always-Allow tip becomes `DecisionFoot`. Re-apply per R4-01 ("whichever lands later"). The `message.ts` v0.15 hunk is `task_activity` (UB9.8). | — | Yes: R4-01. |
| UB6.10 | (b) | Danger tone, and unknown risks dropped (`Object.hasOwn(riskLabels, risk)`, v0.15.1 `PermissionRequest.tsx:48`): B1-10. Card anatomy and the `decision-tone` risk arm: R4-01/R4-07. **Added:** the chip markup is v0.15.1 (`rounded-full bg-destructive-tint text-label-sm`, `mt-2`). The `core/types/index.ts` v0.15 hunk is `PageClaudeArtifactInfo` (pages), so UB6.10's `PermissionRisk` export hunk is unchanged. | — | Yes: B1-10, R4. |
| UB6.6 | (b) | Rebase onto the v0.15.1 completion function (B4-15). **Added:**<br>(a) v0.15.1 removes `getSessionFinalText` from `ConductorSessionHost` and from server-core entirely (`git grep` at v0.15.1: 0 hits). `finalText` is now turn-only (`turnFinalMessageId`). The 14 verdict cases rebase onto a host without that fallback. Their test names are unchanged; only the lenient empty-text case is removed (B4-19).<br>(b) The TaskEditor verdict block is restyled at v0.15.1; the `tasks.verdictInferred` line becomes `text-label-sm text-tertiary` (v0.15.1 `TaskEditor.tsx:1297-1299`). Port at v0.15.1. The 620 s client-timeout hunk belongs to B4's UB2.9.<br>(c) Unchanged: `verdict-decision.ts`, `task-verdict.ts`, `task-repairs.ts`, `TaskVerdictDto`, and the `storage.ts` verdict `via`/`confidence`. The `storage.ts` v0.15.1 hunks are `node-waiting`/`nodeOutputPath` (B4's UB2.8/UB1.14). | — | Partly (B4-15); (a) and (b) are new. |
| UB6.5 | (b) | Port the card at v0.15.1, with the v0.14.1 usage note, the `SettingsToggle.note`, and 1:1 `SettingsToggle` (which supersedes the tooltip-prop hunk). Under the owner's OQ-43.2 answer, upstream's install hint and docs link ship. | — | Yes: B1-05, R5-01, R5-10. |
| UB3.7 | (a) | Upstream is unchanged: the deepseek lines are identical, and `models.ts` mapped `deepseek-v4-flash → deepseek-flash` already at v0.14.0 (`git diff v0.14.0 v0.15.1 -- models.ts \| grep -ci deepseek` = 0, control: v0.14.0 has 2 hits). The `mock-utils.ts` v0.15 hunks are background-task/sessionCommand/onLabelsChanged mocks.<br>**HEAD premise is half stale (not an upstream change):**<br>- Ours already has `PI_MINI_PREFERRED_DEFAULTS.deepseek = ['deepseek-flash']` (`llm-connections.ts:1852`, renamed by UA12.211's Pi 0.87.1 lift; the comment there confirms the shipped catalog). The retirement is therefore verified, so drop the "confirm on DeepSeek's site / not retired" branch.<br>- Remaining work: `:1781` still lists `deepseek-v4-flash`, and our `DEPRECATED_MODEL_REPLACEMENTS` (`models.ts:54`) has no deepseek entry. Add upstream v0.15.1 `models.ts:94-95`, including `deepseek-v4-flash-vision-exp`. | — | — |
| UB6.3 | (b) | Three changes: `decisions:getUsage` (read, REMOTE_ELIGIBLE); the v0.14.1 cold-start deadline in `decision-point.ts` with the new `decision-point.test.ts`; and the invariant that no decision point runs on activation/auth retries or hidden messages. Its channel files' other v0.15 hunks (background tasks, `oauth:status`, pages artifact, vibrancy) belong to other rows. | — | Yes: B1-05, B1-07, B1-08, B1 S11. |
| UB2.3 | (a) | No hunk in `isCompactionInFlight`, `waitForCompaction`/`compaction-wait.ts`, or the SessionManager queue arm. `backend/types.ts` adds `stopTurn?`/`stopBackgroundTask?` (B2-12/B4-01); `base-agent.ts` adds `getSourceFeatures` (B4-06); the `pi-agent.ts` hunks are large-result/intent (B1-01/02). | — | — |
| UB4.9 | (a) | `mini-model-query.ts` has no diff. The `queryLlm` hunks are only `resolveCraftAgentDir` (B2-07, ours HAVE). The v0.15.0 `pick-mini-model.ts` walks the mini table first; ours already does (B2-05 HAVE). | — | — |
| UB6.16 | (b) | Port the v0.14.1/v0.15.1 relevance filter, not v0.14.0's gate. `setLargeResultSummaryGate` and `large-result-summary-gate.test.ts` were deleted at v0.14.1. Size M. | — | Yes: B1-01, S2–S4. |
| UB5.6 | (b) | Also record the share of summarized results that carry an `_intent`, per runtime (the filter runs only with an intent). | — | Yes: B1-01. |
| UB3.4 | (a) | The only `connection-setup-logic.ts` hunk is a Cloudflare display name (B2-11/R5-11). `TestLlmConnectionParams` is unchanged in `dto.ts`. | — | — |
| UB1.3 | (a) | No upstream counterpart. The `pi-agent.ts` and SessionManager hunks are unrelated. | — | — |
| UB2.4 | (a) | The `source_activated` retry body has no hunk. v0.15.1 sets `turnFromUser` only on non-retry sends (part of B4's UB2.8 `fromUser`), and the retry keeps the hint and level (B1-08 → UB6.14).<br>**Residue:** suppose B4's UB2.9 adopts upstream's per-turn `SendMessageOptions.thinkingLevel` (v0.15.1 `dto.ts`) rather than a session-level one. Then this row's retry must keep it, per upstream's test "keeps it for its retries". | — | — |
| UB6.7 | (b) | Rebase per B4-15. **Added:** at v0.15.1 `finishNodeAfterOutcomeCheck` receives `st.replies.join('\n\n')` (every turn of the attempt). It runs only after the `waitingForUser`/`backgroundWorkRunning` arms, so a stopped node never reaches the classifier until the user's turn. Add that as UB6.7's negative case. | — | Partly (B4-15). |
| UB6.12 | (a) | No `smart-titles.ts` diff and no title hunk in `sm.diff`. | — | — |
| UB6.13 | (a) | No hunk in `steerQueuedIfDecided`, `canSteerNow`, `mid-turn-messages.ts` or `pending-steers.ts`. | — | — |
| UB6.14 | (b) | An auth retry keeps the request's hint and trace, asks nothing, and writes its follow-up once (`turnSuggestionHint`, v0.14.1). | — | Yes: B1-08. |
| UB6.15 | (a) | No `turn-outcome.ts` diff. v0.15.1 reports a user-stopped turn as `interrupted` (`stopEpoch`); B4-15 says ours already does (F1.1239), and the outcome runs only on `complete`. | — | — |
| UB9.5 | (a) | The `emitSessionComplete` snapshot iteration is unchanged. The event gains `backgroundWorkRunning`/`fromUser` (B4's UB2.8); the pin is unaffected. | — | — |
| UB6.11 | (a) | No diff in `decide.ts`, `DecideSchema` or the decide bindings. Co-edits in the same files (`context.ts`, `tool-defs.ts`, `handlers/index.ts`, `index.ts`, registry, bindings) come from two sources:<br>- v0.15.1 `project_memory_append` (B4-09 → B4's UB1.12), **a second new session tool**, so Global Constraint L65 is false.<br>- four `source_*` MCP resource/prompt tools (B4-06 HAVE / B4-08 DROP-c, not ported).<br>`TurnCard.tsx` v0.15.0 redesign: serialise with R3-06; R3 takes the `formatToolInput` decide arm now. | — | Yes: R3, B4-09. |
| UB9.3 | (a) | `isToolHeartbeat`/`tool-matching.ts` have no diff. The test file's +20 lines are the S-03 detached case (UB8.1). | — | — |
| UB2.2 | (b) | B2-12 says Claude HAVE and sends leftovers to point (3), but rewrites nothing. **Upstream:** add v0.15.1 `claude-agent.ts`:<br>- `stopTurn()`: marks the turn aborted, ends the channel, calls `pendingSteers.pause()`, clears `toolHandoff`, then a cooperative `interrupt()`;<br>- the `stoppedTurn` consumer filter: leftovers up to the stopped turn's `result` are dropped, but background notifications among them still go through `routeBackgroundMessage`;<br>- `STOPPED_TURN_RESULT_WAIT_MS` 10 s hard-stop; teardown nulls `currentQuery`;<br>- the four `stopTurn` cases of `claude-keepalive-stop.test.ts`.<br>**Premise (3) adds:** after OUR Stop (`interruptLiveTurn`, query kept; B2-12), do the stopped turn's trailing messages before its `result` reach the next turn's slot? **Keep:** our `INTERRUPT_DEADLINE_MS` 5 s against upstream's 10 s, stated rather than changed. **Test (negative, add):** a stopped turn's leftover text never reaches turn N+1, and a `task_notification` among the leftovers reaches the background sink. | — | Partly (B2-12). |
| UB7.5 | (a) | The live thinking-apply path is untouched. The v0.15.0 Haiku 5.5 hunk in `resolveClaudeThinkingOptions` and its `claude-thinking-config.test.ts` case are B2-02's new row: same function and test file, so serialise. | — | — |
| UB2.1 | (b) | `HANDOFF_*`/`beginToolHandoff` are unchanged. v0.15.1 `stopTurn` clears the handoff timer. **Test (negative, add):** a Stop during the 3 s handoff wait cancels the wait, so no interrupt fires after the Stop. Read our Stop path first; close as HAVE if it already clears the timer. | — | — |
| UB1.5 | (a) | No diff in the domain arm, `permission-manager.ts` or `getNetworkCommandHosts`. `pre-tool-use.ts` co-edits: `keepSourceToolIntent` (B1's UB3.9) and `checkBashPrerequisites` (B4's UB7.11). Serialise. | — | — |
| UB7.6 | (a) | `mode-manager.ts` has no diff. | — | — |
| UB1.6 | (a) | The source-activation re-run in `pi-agent.ts` is untouched. Its v0.14.1 hunks are B1-01/02. | — | — |
| UB3.6 | (b) | v0.15.0 extracts the closure into an exported `preferredModelRank(id, preferred)`:<br>- −1 for deprecated or unmatched ids; Bedrock profiles are reverse-mapped;<br>- `getDefaultModelsForConnection` maps −1 to `preferred.length`;<br>- `findSmallModel` reuses it.<br>Port that, not v0.14.0's inline `preferredRank`. Ours: the `findPreferredIndex` closure at `llm-connections.ts:1897-1934`. **Tests (add):** direct unit cases for bare, `pi/`-prefixed and snapshot ids and a Bedrock profile; a deprecated id gives −1. **Order:** before B2-05's new mini-pick row, which consumes it. | — | No (new). |
| UB6.1 | (b) | Add `coldStart` to records (B1-07). **Added:** v0.14.1 `records.ts` exports `previousDecisionsLogPath`, which UB6.4's `readDecisionToggleUsage` consumes. Land it in UB6.1(b) so UB6.4 does not edit `records.ts`. The `validators.ts` v0.15 hunks are labels (UB6.8) and theme (redesign); the `decisionLayer` schema is unchanged. | — | Partly (B1-07). |
| UB6.4 | (b) | Add `readDecisionToggleUsage` over the current and rotated logs, and `DECISION_RECORD_TAGS` limited to the adopted toggles. Add the "cold failed" column and per-action follow-ups. | — | Yes: B1-05, S1. |
| UB4.1 | (a) | The date line is identical (v0.15.1 `system.ts:259`). The v0.15.1 `system.ts` hunks are project-memory guidance (B4-09 → UB1.12) and MCP resources (B4-06). Our `system.ts:299` still carries "Ignore any other date information", so the premise holds. | — | — |

**Split:** no row needs a new split here. Every v0.15 hunk that rides on these rows' files but is not their feature already has a new row in a B report: B4's UB9.8, UB2.8, UB2.9, UB3.10, UB4.11, UB4.13, UB1.12–UB1.14, UB7.11; B1's UB3.9; B2's UB2.8 plus the B2-02 and B2-05 rows.

**Obsolete sub-parts (no whole row is obsolete):**
- UB6.16: v0.14.0's summary gate.
- UB8.1 and UB8.2: the from-versions.
- UB6.6: any reliance on `getSessionFinalText`, removed at v0.15.1.

## Draft statements that assume a v0.13.4 checkout or a v0.14.0 target

| Line(s) | Statement | Rewrite to |
|---|---|---|
| L1, L1108 | Title "Upstream Adoption 0.14.0"; UB11.8 "against craft-agents v0.14.0 … newer tags listed for the next plan" | Through v0.15.1 (owner 2026-10-14). No deferral of newer tags. |
| L8 | "`show v0.14.0:<path>` … The checkout stays at `v0.13.4`" | The checkout is at v0.15.1. Read by tag: `v0.15.1:` (or the tag a hunk landed in). |
| L10 | Goal "between v0.13.4 and v0.14.0" | v0.13.4..v0.15.1 (+ the H-list). |
| L25 | Spec `spec-upstream-adoption-0-14-0.md` | Rename with the plan. |
| L29–30, L149, L882 | "311 v0.13.4..v0.14.0 paths", `d14-map.json`/`d14-map.py` as the coverage artefact | Add a v0.14.0..v0.15.1 map that asserts exact coverage of its `--name-only` list (input: `divergence.json` / `all-paths.txt`); UB1.1 moves it with the others. |
| L60 | "exactly two rows add a StoredConfig key" | Still true for the B and R reports (`grep -ci StoredConfig *-report.md` = 0 in each; control: `decisionLayer` 1 hit in B1). Re-check once the design rows (R1/R2) are in. |
| L65 | "the one new tool is `decide` (UB6.11)" | Plus `project_memory_append` (B4's UB1.12 under OQ-B4-1 (a)). Both rows run the full Session-tools set: serialise. |
| L73 | Copied files record `v0.14.0:<path>` | `v0.15.1:<path>` (or the actual tag). |
| L148 | S1: "v0.14.0 added … 13 feature toggles" | Still 13 at v0.15.1 (B1 frame 2); add v0.14.1 usage and cold start. |
| L167 | "v0.14.0's TaskRunner equals v0.13.4 … nothing is lost before UB6.6" | False at v0.15.1: `TaskRunner.ts` +87/−31 and its test +170 in v0.15.1 (B4-15/16/17/19). |
| L170, L428, L1052 | "Its one v0.14.0 `EditPopover.tsx` hunk …" | v0.15.0 adds two more (the valueType sentence, `TWEEN`/`EditButton`). UB4.7's "13 hard-coded `~/.craft-agent/`" still holds at v0.15.1 (measured: 13 at v0.14.0 and at v0.15.1). |
| L309, L1032 | UB2.2 "four … hunks of the `v0.13.4..v0.14.0` diff" | Plus v0.15.1 `stopTurn`/`stoppedTurn` (table above). |
| L323, L706 | `canSteerNow` / `isCompactionInFlight` cited at v0.14.0 / v0.13.6 | Unchanged at v0.15.1; cite v0.15.1. |
| L344, L411 | "green on Pi 0.85.1" (UB2.6); UB4.4 instrument "on Pi 0.85.1" | HEAD is 0.87.1 (UA12.211); the target is 1.1.0. |
| L461 | UB5.1 "SDK 0.3.274 records the system prompt" | HEAD 0.3.280, target 0.3.296. |
| L613, L615, L1089–1090 | UB8.1 "0.3.274 → 0.3.280", UB8.2 "0.85.1 → 0.87.1" | Done in 1.42.0; the remaining targets are 0.3.296 / 1.1.0. |
| L623, L625, L1092–1093 | UB9.2/UB9.3 "v0.14.0's" creation side / `isToolHeartbeat` | Content unchanged at v0.15.1; cite v0.15.1. |
| L663 | UB11.8 step (3) "every path of `diff --name-only v0.13.4 v0.14.0`" | v0.13.4..v0.15.1, via both maps. |
| L670–671 | Manifest tag legend `.5/.6/.14`; numstat v0.13.4..v0.14.0 | Add `.14.1/.15/.15.1`. |
| L805, L880 | Upstream release notes 0.13.5/0.13.6/0.14.0 D(a) | Add 0.14.1/0.15.0/0.15.1. |
| L985 | Pointers back "`v0.14.0:` unless noted" | `v0.15.1:`. |
| L112 vs rows | OQ-43.2 is answered "identical to craft", yet UB6.3's title ("local-only provider changes") and UB6.5 ("no install hint, no external docs link") still assume recommendation (a). | Already owed per README L136 and R5-10. Listed because both rows are in this set. |

## Coverage

- **41/41 rows read** in the draft and decided against the v0.14.0..v0.15.1 diff of their mapped paths.
  - (a) unchanged: 22. UB6.9, UB3.3, UB4.6, UB9.2, UB1.2, UB3.7, UB2.3, UB4.9, UB3.4, UB1.3, UB2.4, UB6.12, UB6.13, UB6.15, UB9.5, UB6.11, UB9.3, UB7.5, UB1.5, UB7.6, UB1.6, UB4.1.
  - (b) amend: 19. UB8.1, UB8.2, UB4.8, UB6.8, UB3.1, UB7.4, UB6.10, UB6.6, UB6.5, UB6.3, UB6.16, UB5.6, UB6.7, UB6.14, UB2.2, UB2.1, UB3.6, UB6.1, UB6.4.
  - (c) split: 0 new. (d) obsolete: 0 whole rows.
- **Already decided by B/R reports and only cited:**
  - Fully covered: UB8.1, UB6.5, UB6.16, UB5.6, UB6.3, UB6.4, UB6.14, UB3.1, UB6.10, UB7.4, UB4.6, UB3.3, UB9.2, UB1.2, UB6.11.
  - Partly covered, with additions here: UB8.2, UB4.8, UB6.8, UB6.6, UB6.7, UB2.2, UB6.1.
  - New here: UB3.6, UB2.1, and the HEAD-premise note on UB3.7.
- **All 87 mapped paths placed per tag** (`numstat.txt`).
- **Not read line by line:**
  - the `AppShell.tsx`/`TurnCard.tsx`/`AiSettingsPage.tsx` redesign bodies (grepped only for row symbols: rtk, decide, canRemember/risks; owned by B3/R3/R5);
  - `bun.lock` beyond package keys;
  - `browser-pane-manager.ts`, read only through its teardown and popup hunks and its test case names (B5 owns it).
- No test, build or live run (read-only brief).
