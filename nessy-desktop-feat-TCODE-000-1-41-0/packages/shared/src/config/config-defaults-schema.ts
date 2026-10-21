/**
 * TypeScript types for config-defaults.json
 *
 * Source of truth: apps/electron/resources/config-defaults.json
 * This file only defines types - the actual defaults come from the bundled JSON.
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { NotificationTiming } from './notification-timing.ts';

export interface ConfigDefaults {
  version: string;
  description: string;
  defaults: {
    /**
     * Legacy: superseded by `notificationTiming`. Kept so an unmigrated
     * `config.json` still resolves — see `notificationSettingsFromLegacyEnabled`.
     */
    notificationsEnabled: boolean;
    /**
     * `learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications` — turn-completion
     * alerts appear "never, only while ChatGPT is in the background, or always".
     */
    notificationTiming: NotificationTiming;
    /** The page's separate control for permission notifications. */
    notificationPermissionAlerts: boolean;
    /** The page's separate control for question notifications. */
    notificationQuestionAlerts: boolean;
    colorTheme: string;
    autoCapitalisation: boolean;
    sendMessageKey: 'enter' | 'cmd-enter';
    spellCheck: boolean;
    keepAwakeWhileRunning: boolean;
    richToolDescriptions: boolean;
    extendedPromptCache: boolean;
    browserToolEnabled: boolean;
    /**
     * Allow remote agents to call `browser_tool evaluate <expression>`.
     * When false, the local dispatcher rejects with `BROWSER_REMOTE_EVALUATE_BLOCKED`.
     */
    allowRemoteEvaluate: boolean;
    memoryEnabled: boolean;
    macosSeatbeltBashSandboxEnabled: boolean;
    /**
     * P6.202 · `settings-reference.md#permissions-blockreadsoutsideworkingdirectories`:
     * *"Stop Claude from reading paths outside the session's working directories
     * with the Read, Grep, Glob, and LSP tools, in every permission mode
     * including `bypassPermissions`."* Shipped OFF, matching the page's own
     * *"Default: unset, so reads outside the working directories follow your
     * permission mode and rules"*.
     */
    blockReadsOutsideWorkingDirectories: boolean;
    /**
     * Let a connected MCP server push text into a live turn through
     * `claude/channel`. Opt-in: false installs no channel dispatcher at all.
     */
    mcpChannelPushEnabled: boolean;
    /** Enable Pi automatic compaction. Manual /compact is independent. */
    autoCompactEnabled: boolean;
    /** Consult the guardian safety judge for borderline/high-risk actions. */
    guardianEnabled: boolean;
    /**
     * P3.2 — route escalated codex approvals through codex's NATIVE auto-review
     * guardian subagent (`approvals_reviewer = "auto_review"`). OPT-IN (default
     * false): only meaningful on the codex runtime, and only when the approval
     * policy is interactive. Mirrored in config-defaults.json +
     * FALLBACK_CONFIG_DEFAULTS + this type, per the three-site rule.
     */
    codexAutoReviewEnabled: boolean;
    /**
     * P3.2 — optional free-text instructions appended to codex's guardian prompt,
     * emitted as `[auto_review].policy`. Shipped EMPTY (no additions); a value
     * here only takes effect while `codexAutoReviewEnabled` is on.
     */
    codexAutoReviewPolicy: string;
    /**
     * C3.109 — whether codex may spawn its own agents (`[agents] enabled`).
     * Shipped TRUE, which is codex's own default, so the shipped value changes
     * nothing; only an explicit `false` is written into the config.toml.
     * Mirrored in config-defaults.json + FALLBACK_CONFIG_DEFAULTS + this type,
     * per the three-site rule.
     */
    codexSubagentsEnabled: boolean;
    /**
     * P2.1 — let the model consult the advisor at decision points. OPT-IN:
     * `advisor.md` turns the advisor on with `/advisor`/`advisorModel`, and an
     * always-on second model doubles the cost of a turn.
     */
    advisorEnabled: boolean;
    /**
     * The advising model. Shipped EMPTY, meaning "the session's own model" —
     * a named model here would outrank the session's for every install and
     * could never be escaped, since `syncConfigDefaults` rewrites the user copy
     * from the bundle on every launch (R52's recorded reason for shipping
     * `thinkingLevel` absent).
     */
    advisorModel: string;
    /**
     * P6.531 — what an UNATTENDED turn answers when no rule and no floor covers
     * the call. Shipped `deny` on all three runtimes, which is the whole point
     * of the row: codex used to approve there while Pi and claude refused.
     *
     * DECLARATIVE. `config/unattended-approval.ts` is a leaf module with no
     * imports and resolves the value from its own
     * `UNATTENDED_APPROVAL_FALLBACK_DEFAULT`; this entry exists so the file an
     * operator reads to learn the defaults names the floor too, and
     * `unattended-approval-defaults.test.ts` pins the two equal. It is not a
     * lever — `syncConfigDefaults` rewrites the user's copy from the bundle on
     * every launch; the levers are the `unattendedApprovalFallback` key in
     * `config.json` and `NESSY_UNATTENDED_APPROVAL_FALLBACK`.
     */
    unattendedApprovalFallback: 'deny' | 'allow';
    /** Days of session data to retain. Documented default 30, minimum 1. */
    retentionDays: number;
    /**
     * P6.502 — start every new session in never-persist mode: nothing is written
     * to disk, so resume, rewind and search are all absent inside it. Shipped
     * OFF; it is the zero `retentionDays` above cannot reach, since the minimum
     * retention is 1 and a window of 0 would only delete a file already written.
     */
    neverPersistSessions: boolean;
  };
  workspaceDefaults: {
    /**
     * OPTIONAL, and shipped ABSENT (R52). `model-config.md:453` gives every
     * effort-capable model its own default effort, and a value at this tier
     * outranks it forever — `syncConfigDefaults` rewrites the user copy from
     * the bundle on every launch, so a shipped value can never be escaped.
     * Absent leaves `getDefaultThinkingLevel()` on `DEFAULT_THINKING_LEVEL`,
     * which is what the previously shipped `"think"` already normalized to.
     */
    thinkingLevel?: ThinkingLevel;
    permissionMode: PermissionMode;
    cyclablePermissionModes: PermissionMode[];
    /** Per-turn Pi tool/pre-tool event cap. 0 disables the runaway guard. */
    maxAgentTurns: number;
    /**
     * P6.217 — the session-level BUILT-IN TOOL universe, the thing a user or an
     * operator could not restrict at all: `Options.allowedTools` had no producer
     * anywhere, and `Options.disallowedTools` was a host CONSTANT.
     *
     * Both OPTIONAL and shipped ABSENT, on `thinkingLevel`'s precedent and for
     * the same reason: `syncConfigDefaults` rewrites the user copy from the
     * bundle on every launch, so a shipped value could never be escaped. Absent
     * means "no session-level restriction", which is today's behaviour exactly.
     *
     * `sessionAllowedTools` is a WHITELIST (claude `Options.tools` — built-ins, F1.638 —
     * Pi's `piAllowedTools` universe) and `sessionDisallowedTools` a blacklist added
     * to the host constant. Codex is structurally denied — its
     * `enabled_tools`/`disabled_tools` cover MCP SERVERS only (A10) — and the
     * cost of that is P6.596's row, not a silent drop.
     */
    sessionAllowedTools?: string[];
    /** @see sessionAllowedTools */
    sessionDisallowedTools?: string[];
    /** Session-level Pi cost ceiling in USD. 0 disables the budget guard. */
    maxBudgetUsd: number;
    /**
     * P6.645 — the session-level TOKEN ceiling, the twin of `maxBudgetUsd`, and
     * the one every runtime can actually honour: native-first step 1 was
     * measured absent on all three (codex refused all three ceilings at
     * `rust-v0.148.0`, claude's `Options.taskBudget` has zero production
     * references, Pi's per-turn cap is USD-only), while all three already
     * REPORT token counts. 0 disables the guard, exactly as its USD twin does.
     * Read through `resolveMaxBudgetTokens()` (`config/max-budget-tokens.ts`),
     * never off this field, so "absent or non-positive means no cap" has one
     * answer.
     */
    maxBudgetTokens: number;
    /**
     * `model-config.md:364` — an ORDERED CHAIN of Pi model IDs, deduplicated,
     * capped at three, tried in order when the primary drains, and only for the
     * current turn. Accepted on read as an array, a comma-separated string or
     * the legacy single-id scalar (`""` is on disk in every install that
     * predates the widening); `loadConfigDefaults` narrows it to `string[]`,
     * where `[]` disables fallback.
     */
    fallbackModel: string | string[];
    /** When true, large MCP source tool sets are exposed through search/load tools. */
    deferredMcpToolLoading: boolean;
    localMcpServers: {
      enabled: boolean;
    };
  };
}
