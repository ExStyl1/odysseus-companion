/**
 * The plugin-facing hook EVENT VOCABULARY — the whole of this module.
 *
 * It used to also carry V1's standalone hook runtime (`PluginHookRuntime`,
 * `runHooks`, `createHookRegistryFromProjection`, `parseHookOutput` and their
 * invocation/registry types), which read a `PluginProjectionPlan` and executed
 * command hooks itself. F4 deleted that: it had no production caller — the
 * running hook path is `capabilities/runtime-automations.ts` over
 * `PluginScopedAutomationSystem` — and a second executor reading a second
 * projection is exactly the shape that let F1's translation pass attach to a
 * road nobody drives. What remains is the vocabulary, which the format adapters
 * and the automation bridge both read.
 */

/**
 * This union carries the hook events hooks.md enumerates that we emit, plus our
 * own `McpServerStart` and `McpToolCall`. Two we do NOT emit — `TeammateIdle`
 * (needs agent teams) and `Setup` (needs a `--init-only` / `-p --init` /
 * `-p --maintenance` launch mode, which this fork has none of) — are
 * deliberately absent and import as recorded deferrals instead of silently
 * registering a hook that can never fire (see
 * `DEFERRED_EXTERNAL_HOOK_EVENT_REASONS` in `format-adapters.ts`).
 * `PreModelSwitch` / `PostModelSwitch` were a third and a fourth until P3.374
 * built their emitter in `SessionManager.updateSessionModel`; they are mapped
 * now. **The emitted count is deliberately not written here either** — the
 * sentence that carried it has been wrong three times.
 *
 * **The size of the page's roster is deliberately not written here.** This line
 * said 31 for a month after the page reached 33, and the guard that was supposed
 * to notice restated the same 31 (P3.349). The denominator is derived offline
 * from `scripts/claude-doc-anchors.tsv` and checked in `format-adapters.test.ts`;
 * the number lives in that measurement, not in this prose.
 *
 * `DirectoryAdded` landed upstream in 2.1.219 (changelog.md,
 * July 24 2026); `MessageDisplay` was the second half of the same row and
 * stopped being a deferral once the wire gained a display-only companion field
 * for assistant text (`SessionEvent.text_delta.displayDelta` /
 * `text_complete.displayText`) — the missing channel was the whole reason it
 * was deferred, not the event.
 *
 * `Setup` moved the other way, and for the opposite kind of reason: not a
 * missing channel but a firing rule we cannot satisfy. We were emitting it on
 * every Pi runtime start, which hooks.md#setup excludes in as many words, so it
 * was removed rather than left registrable-and-wrong.
 *
 * Claude's `Elicitation` maps onto our long-standing `McpElicitation` at the
 * adapter layer; the contract name is NOT renamed, because stored automations
 * reference it.
 */
export type PluginHookEventName =
  | 'InstructionsLoaded'
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'UserPromptExpansion'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'Notification'
  | 'MessageDisplay'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Stop'
  | 'StopFailure'
  | 'ConfigChange'
  | 'CwdChanged'
  | 'DirectoryAdded'
  | 'PreModelSwitch'
  | 'PostModelSwitch'
  | 'FileChanged'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'PreCompact'
  | 'PostCompact'
  | 'McpElicitation'
  | 'ElicitationResult'
  | 'McpServerStart'
  | 'McpToolCall'
  | 'SessionEnd';
