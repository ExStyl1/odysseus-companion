/**
 * Shared Utilities for Automations System
 *
 * Common helper functions used by both the legacy functional API (index.ts)
 * and the new Event Bus handlers (command-handler.ts, prompt-handler.ts).
 */

import type { BaseEventPayload } from './event-bus.ts';
import type { AutomationEvent, AutomationMatcher, PromptReferences, AgentEvent, SdkAutomationInput } from './types.ts';
import { matchesCron } from './cron-matcher.ts';
import { sanitizeForShell } from './security.ts';
import { evaluateConditions } from './conditions.ts';

// ============================================================================
// String Utilities
// ============================================================================

/**
 * Convert camelCase to SNAKE_CASE.
 *
 * @example
 * toSnakeCase('newStatus') // 'new_status'
 * toSnakeCase('toolName')  // 'tool_name'
 */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Expand environment variables in a string.
 * Supports both $VAR and ${VAR} syntax.
 *
 * @example
 * expandEnvVars('Hello $NAME', { NAME: 'World' }) // 'Hello World'
 * expandEnvVars('${GREETING} World', { GREETING: 'Hi' }) // 'Hi World'
 */
export function expandEnvVars(str: string, env: Record<string, string>): string {
  return str
    // Replace ${VAR} syntax
    .replace(/\$\{([^}]+)\}/g, (_, varName) => env[varName] ?? '')
    // Replace $VAR syntax (word boundary)
    .replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, varName) => env[varName] ?? '');
}

// ============================================================================
// Prompt Utilities
// ============================================================================

/**
 * Parse @mentions from a prompt (sources and skills both use @name syntax).
 *
 * Syntax:
 * - @name - references a source or skill (e.g., @linear, @github, @commit, @review-pr)
 *
 * References are case-insensitive and support hyphens (e.g., @my-source, @my-skill).
 * The caller should resolve which mentions are sources vs skills based on available configurations.
 */
export function parsePromptReferences(prompt: string): PromptReferences {
  const mentions: string[] = [];

  // Match @name (word characters and hyphens)
  // Avoid matching email addresses by requiring whitespace or start of string before @
  const matches = prompt.matchAll(/(?:^|[\s(])@([a-zA-Z][a-zA-Z0-9-]*)/g);
  for (const match of matches) {
    const captured = match[1];
    if (captured) {
      const mention = captured.toLowerCase();
      if (!mentions.includes(mention)) {
        mentions.push(mention);
      }
    }
  }

  return { mentions };
}

// ============================================================================
// Event Matching Utilities
// ============================================================================

/**
 * Get the match value for regex matching based on event type.
 * Uses the most complete version with data.data?.tool_name fallback for tool events.
 *
 * Accepts both plain data objects (legacy API) and BaseEventPayload (handler API).
 */
export function getMatchValue(event: AutomationEvent, data: Record<string, unknown>): string {
  switch (event) {
    case 'LabelAdd':
    case 'LabelRemove':
      return String(data.label ?? '');
    case 'LabelConfigChange':
      return ''; // Always matches
    case 'PermissionModeChange':
      return String(data.newMode ?? '');
    case 'FlagChange':
      return String(data.isFlagged ?? false);
    case 'SessionStatusChange':
      return String(data.newStatus ?? data.newState ?? '');
    case 'PreToolUse':
    case 'PostToolUse':
      return String(data.toolName ?? (data.data as Record<string, unknown>)?.tool_name ?? '');
    case 'SchedulerTick':
      // SchedulerTick uses cron matching, not regex
      return '';
    default:
      return JSON.stringify(data);
  }
}

/**
 * Nessy's own `ErrorCode` taxonomy projected onto `StopFailure`'s documented
 * matcher vocabulary (hooks.md#stopfailure: "The `error` field identifies the
 * error type and is used for matcher filtering", values `rate_limit`,
 * `overloaded`, `authentication_failed`, `oauth_org_not_allowed`,
 * `billing_error`, `invalid_request`, `model_not_found`, `server_error`,
 * `max_output_tokens`, `unknown`).
 *
 * Only unambiguous counterparts are mapped. A code with no documented
 * counterpart passes through unchanged rather than collapsing to `unknown`, so
 * a Nessy-specific matcher (`mcp_unreachable`, `proxy_error`, …) stays
 * reachable while an imported Claude hook's documented matcher works. Two
 * documented values — `oauth_org_not_allowed` and `max_output_tokens` — have no
 * Nessy producer and are therefore never emitted.
 */
const STOP_FAILURE_DOCUMENTED_ERROR: Readonly<Record<string, string>> = Object.freeze({
  rate_limited: 'rate_limit',
  provider_error: 'overloaded',
  service_unavailable: 'overloaded',
  invalid_api_key: 'authentication_failed',
  invalid_credentials: 'authentication_failed',
  expired_oauth_token: 'authentication_failed',
  token_expired: 'authentication_failed',
  billing_error: 'billing_error',
  invalid_request: 'invalid_request',
  image_too_large: 'invalid_request',
  data_policy_error: 'invalid_request',
  model_no_tool_support: 'invalid_request',
  invalid_model: 'model_not_found',
  service_error: 'server_error',
  unknown_error: 'unknown',
});

/**
 * The closed set hooks.md:2418 binds `StopFailure.error` to: "Error type:
 * `rate_limit`, `overloaded`, `authentication_failed`,
 * `oauth_org_not_allowed`, `billing_error`, `invalid_request`,
 * `model_not_found`, `server_error`, `max_output_tokens`, or `unknown`".
 */
const STOP_FAILURE_DOCUMENTED_ERRORS: ReadonlySet<string> = new Set([
  'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed',
  'billing_error', 'invalid_request', 'model_not_found', 'server_error',
  'max_output_tokens', 'unknown',
]);

/**
 * Project a Nessy `ErrorCode` onto the documented `StopFailure.error`
 * vocabulary, for the PAYLOAD.
 *
 * DIFFERENT FALLBACK FROM THE MATCHER, deliberately. `getMatchValueForSdkInput`
 * lets an unmapped Nessy code pass through unchanged so a Nessy-specific
 * matcher (`mcp_unreachable`, `proxy_error`, …) stays reachable. The payload
 * cannot do that: `:2418` gives `error` a closed ten-value vocabulary and
 * `unknown` is the documented catch-all, so a hook that switches on `.error`
 * would otherwise meet a word its case list cannot contain. The raw Nessy code
 * is still emitted beside it on `error_code`, and the matcher reads
 * `error_code` FIRST — so carrying both leaves every existing matcher
 * byte-identical while the payload conforms.
 */
export function toDocumentedStopFailureError(code: string): string {
  const mapped = STOP_FAILURE_DOCUMENTED_ERROR[code];
  if (mapped) return mapped;
  return STOP_FAILURE_DOCUMENTED_ERRORS.has(code) ? code : 'unknown';
}

/**
 * hooks.md#filechanged: the matcher "filters which hook groups run using the
 * standard matcher rules against the changed file's **basename**" — not the
 * path. Split on both separators rather than `node:path` so the shared matcher
 * stays runtime-agnostic and a Windows path matches the same way.
 */
function changedFileBasename(input: SdkAutomationInput): string {
  const filePath = input.file_path ?? input.path;
  if (!filePath) return '';
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/**
 * The one name every spelling of a Claude model reduces to — the dateless
 * `claude-<family>-<version>` (`claude-opus-5`, `claude-opus-4-6`) or the older
 * `claude-<version>-<family>` (`claude-3-5-sonnet`). Anything else is not a
 * canonical Claude name and is refused.
 */
const CANONICAL_CLAUDE_MODEL_NAME = /^claude-(?:[a-z]+(?:-\d+){1,2}|\d+(?:-\d+)?-[a-z]+)$/;

/**
 * UB12.102 — the value a `PreModelSwitch` / `PostModelSwitch` matcher is compared
 * with, derived from the payload's `to_model`.
 *
 * hooks.md § Matcher patterns (curl'd 2026-10-17): "For `PreModelSwitch` and
 * `PostModelSwitch`, Claude Code evaluates the matcher against the canonical
 * name it derives from `to_model`". hooks.md#premodelswitch says what that name
 * is: "Claude Code compares the matcher against the canonical name of the model
 * the session is switching to, ignoring any `[1m]` suffix. An alias such as
 * `opus`, a dated model ID, and a provider-specific ID such as an Amazon Bedrock
 * model ID all match the one canonical name they resolve to, so `claude-opus-5`
 * covers every spelling of Opus 5." #postmodelswitch: "The matcher follows the
 * same rules as PreModelSwitch".
 *
 * The page names the spellings, not an algorithm (the binary is closed), so this
 * reduces the ones a Nessy session can hold, by syntax rather than by a table, so
 * a model released after this line still reduces: a `[1m]` (any bracketed)
 * selector; a provider or runtime prefix (`anthropic/`, `pi/`, a gateway's
 * `tgpt/`); a Bedrock id (`us.anthropic.claude-opus-4-6-v1:0`, its ARN form);
 * a Vertex `@<date>`; a dated snapshot (`-20250929`) or `-latest`; and a dotted
 * version (`claude-opus-4.6`, OpenRouter's spelling).
 *
 * `undefined` means "no canonical name", and that is a documented state with its
 * own rule, not a miss: hooks.md#premodelswitch, "When Claude Code can't
 * determine a canonical name for the target, for example a custom model ID that
 * only your LLM gateway knows, it runs every PreModelSwitch hook regardless of
 * matcher." `matchesBasePredicate` applies it. Nessy states three cases where it
 * applies more often than in Claude Code, because they are ordinary here: a
 * non-Claude model (a Nessy Gateway alias's id, a Codex or Pi provider model); an
 * ALIAS such as `opus`, which only the Claude runtime can resolve and which
 * `updateSessionModel` passes through unresolved; and a cleared session model,
 * which leaves `to_model` absent.
 */
export function modelSwitchCanonicalName(toModel: string | undefined): string | undefined {
  if (typeof toModel !== 'string') return undefined;
  const spelled = toModel.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  // `claude-` at the start or after a prefix separator — never inside another
  // word, so `my-claude-proxy` is not read as a Claude model.
  const found = /(?:^|[./:])(claude-[a-z0-9]+(?:[-.][a-z0-9]+)*)/.exec(spelled)?.[1];
  if (!found) return undefined;
  const name = found
    .replace(/(\d)\.(?=\d)/g, '$1-')
    .replace(/-v\d+$/, '')
    .replace(/-(?:\d{8}|latest)$/, '');
  return CANONICAL_CLAUDE_MODEL_NAME.test(name) ? name : undefined;
}

/**
 * Get the match value for SDK agent events.
 * Mirrors the Claude SDK's `fieldToMatch` per event — each event type matches
 * against a specific field from the input.
 */
export function getMatchValueForSdkInput(event: AgentEvent, input: SdkAutomationInput): string {
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
    // hooks.md § Matcher patterns lists `PermissionDenied` in the same row as
    // the four tool events — "tool name" — and hooks.md#permissiondenied
    // repeats it: "Matches on tool name, same values as PreToolUse." Both
    // emitters already carry `tool_name` (pi-agent's auto-mode denial and the
    // permission-service denial), so this arm was the only thing keeping a
    // fully-wired `retry` hook unreachable.
    case 'PermissionDenied':
      return input.tool_name ?? '';
    // hooks.md:2692 / :2762 — "The matcher field matches against the MCP server
    // name". Before R24 both fell through to `''`, so a server-name matcher
    // never matched and only a catch-all hook ever ran. The documented field is
    // `mcp_server_name`; `mcp_server` is the fallback for the lifecycle-bridge
    // emissions, which match on the same server name under the older spelling.
    case 'McpElicitation':
    case 'ElicitationResult':
      return input.mcp_server_name ?? input.mcp_server ?? '';
    // hooks.md#notification — "Matches on notification type", carried on the
    // input as `notification_type`. This read `input.message` before U-B, the
    // free-text notification body: a documented `permission_prompt` matcher
    // never fired, and a native regex matcher substring-hit whichever unrelated
    // notification happened to contain the pattern.
    case 'Notification':
      return input.notification_type ?? '';
    case 'SessionStart':
      return input.source ?? '';
    // hooks.md#instructionsloaded: "The matcher runs against `load_reason`. For
    // example, use `"matcher": "session_start"` to fire only for files loaded at
    // session start, or `"matcher": "path_glob_match|nested_traversal"` to fire
    // only for lazy loads."
    case 'InstructionsLoaded':
      return input.load_reason ?? '';
    case 'SubagentStart':
    case 'SubagentStop':
      return input.agent_type ?? '';
    // hooks.md#precompact: "The matcher value indicates whether compaction was
    // triggered manually or automatically" (`manual` | `auto`);
    // hooks.md#postcompact: "The same matcher values apply as for `PreCompact`".
    case 'PreCompact':
    case 'PostCompact':
      return input.trigger ?? '';
    // hooks.md#sessionend: "Supports matchers to filter by exit reason. The
    // `reason` field in the hook input indicates why the session ended."
    case 'SessionEnd':
      return input.reason ?? '';
    // hooks.md#stopfailure: "The `error` field identifies the error type and is
    // used for matcher filtering." Nessy carries its own error type on
    // `error_code`; the documented spelling wins where one exists.
    case 'StopFailure': {
      const code = input.error_code ?? input.error ?? '';
      return STOP_FAILURE_DOCUMENTED_ERROR[code] ?? code;
    }
    // hooks.md#filechanged — the changed file's basename.
    case 'FileChanged':
      return changedFileBasename(input);
    // hooks.md#directoryadded — "The matcher filters on how the directory was
    // added": `slash_command` ("You add a directory with `/add-dir`") or
    // `register_repo_root` ("An SDK client adds a directory with the
    // `register_repo_root` control request"), carried on the input as `source`.
    // Nessy has no `/add-dir` command, so only `register_repo_root` is ever
    // produced today — a `slash_command` matcher correctly never fires rather
    // than matching the wrong add.
    case 'DirectoryAdded':
      return input.source ?? '';
    // R73 · hooks.md#configchange — "The matcher filters on the configuration
    // source", and the input carries it as `source`: "The `source` field
    // indicates which configuration type changed, and `file_path` provides the
    // path to the specific file that was modified."
    //
    // This arm landed WITH the settings-file producer (`ConfigWatcher`'s
    // `onSettingsSourceChange` → `SessionManager`), never before it — a matcher
    // reading a field nothing sets is the same dead filter it replaced. Nessy's
    // own runtime session-config occurrences (`model`, `authType`,
    // `thinkingLevel`, …) deliberately carry NO `source`, so they still reach
    // catch-all matchers only and never a documented one: they are a Nessy
    // extra, and labelling them with one of the five documented values would
    // fire the wrong hook.
    case 'ConfigChange':
      return input.source ?? '';
    // R73 · hooks.md#userpromptexpansion — "Matches on `command_name`. Leave the
    // matcher empty to fire on every prompt-type command." Landed WITH the
    // expansion-site producer (`SessionManager.emitUserPromptExpansion`, called
    // from the SEND_MESSAGE handler); before it there was no command name in the
    // payload to read.
    case 'UserPromptExpansion':
      return input.command_name ?? '';
    // UB12.102 — the canonical name derived from `to_model` (see the helper).
    // Before this arm both events fell to `''` below, so every matcher-bearing
    // model-switch hook was compared with nothing and never ran: a documented
    // `PreModelSwitch` veto failed open. `''` is still returned when there is no
    // canonical name, and for these two events it means "run every hook", which
    // `matchesBasePredicate` reads.
    case 'PreModelSwitch':
    case 'PostModelSwitch':
      return modelSwitchCanonicalName(input.to_model) ?? '';
    default:
      // Every documented matcher-bearing event Nessy emits now has an arm
      // above (the model-switch pair was the last to get one, UB12.102: this
      // comment said "every" while both fell through). Three events used to
      // fall through here instead:
      //
      // - `ConfigChange` and `UserPromptExpansion` left when their PRODUCERS
      //   landed (R73): ConfigChange now carries the documented settings
      //   `source`, and UserPromptExpansion fires at the command-expansion site
      //   carrying `command_name`.
      // - `Setup` left by being REMOVED (R73 · f001). Its gap was a firing rule,
      //   not a payload gap: hooks.md#setup fires it only under `--init-only` /
      //   `-p --init` / `-p --maintenance`, launch modes Nessy has none of, and
      //   we were firing it once per Pi runtime start — the case the page
      //   excludes. There was no `trigger` value to read because there was no
      //   correct occurrence to read it from, so the event left the inventory
      //   rather than keeping a matcher arm over a producer that should not
      //   exist. See `UNEMITTED_HOOK_EVENT_REASONS` in `types.ts`.
      //
      // The remaining events here are the documented matcher-less ones, handled
      // by MATCHERLESS_AGENT_EVENTS below rather than by a match value.
      return '';
  }
}

/**
 * Events whose `matcher` field is documented as silently ignored: hooks.md
 * § Matcher patterns — "`UserPromptSubmit`, `PostToolBatch`, `Stop`,
 * `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`,
 * `WorktreeRemove`, `MessageDisplay`, and `CwdChanged` don't support matchers
 * and always fire on every occurrence. If you add a `matcher` field to these
 * events, it is silently ignored."
 *
 * This is the full documented list intersected with Nessy's event inventory:
 * `TeammateIdle` is the only member with no Nessy event to name. Previously only
 * the two task events were listed — the other six compared a matcher against
 * `''`, so a matcher-bearing hook on `Stop` or `CwdChanged` never fired where the
 * documentation says it always does. `SubagentStop` is NOT here: it is documented
 * as matching on agent type.
 *
 * Note `enabled: false` is checked before this set in `matchesBasePredicate`:
 * it is the matcher FIELD that is ignored, not a disabled automation.
 */
const MATCHERLESS_AGENT_EVENTS: ReadonlySet<AutomationEvent> = new Set<AutomationEvent>([
  'UserPromptSubmit',
  'PostToolBatch',
  'Stop',
  // R32. A matcher on this event is not a filter and not a defect to report:
  // hooks.md:270 — "If you add a `matcher` field to these events, it is silently
  // ignored."
  'MessageDisplay',
  'TaskCreated',
  'TaskCompleted',
  'WorktreeCreate',
  'WorktreeRemove',
  'CwdChanged',
]);

/**
 * UB12.102 — the two events whose matcher is compared with a canonical model
 * name, and which run every hook when the target has none
 * (`modelSwitchCanonicalName`).
 */
const MODEL_SWITCH_AGENT_EVENTS: ReadonlySet<AutomationEvent> = new Set<AutomationEvent>([
  'PreModelSwitch',
  'PostModelSwitch',
]);

export interface MatcherContext {
  /** Precomputed value used for regex matching */
  matchValue: string;
  /** Payload used for condition evaluation */
  payload: Record<string, unknown>;
  /** Fallback timezone source for time conditions */
  matcherTimezone?: string;
}

/**
 * Base matcher predicate (enabled flag + regex/cron). Intentionally internal.
 *
 * Do not call directly from feature code. Use matcherMatchesWithContext()/adapters
 * so condition gating is never bypassed.
 */
function matchesBasePredicate(matcher: AutomationMatcher, event: AutomationEvent, matchValue: string): boolean {
  if (matcher.enabled === false) return false;
  if (event === 'SchedulerTick') {
    return !!matcher.cron && matchesCron(matcher.cron, matcher.timezone);
  }
  // These events "don't support matchers and always fire on every occurrence"
  // (hooks.md § Matcher patterns). They also have no match value, so without
  // this the matcher would be tested against '' and the hook would never run.
  if (MATCHERLESS_AGENT_EVENTS.has(event)) return true;
  // UB12.102 — hooks.md#premodelswitch: "When Claude Code can't determine a
  // canonical name for the target … it runs every PreModelSwitch hook regardless
  // of matcher", and PostModelSwitch's matcher "follows the same rules". The
  // match value is `''` exactly then: `modelSwitchCanonicalName` never returns
  // an empty name. `enabled: false` above and `conditions` after this still gate.
  if (MODEL_SWITCH_AGENT_EVENTS.has(event) && matchValue === '') return true;
  if (!matcher.matcher) return true; // No matcher means match all
  if (matcher.matchMode === 'claude') return matchesClaudeMatcher(matcher.matcher, matchValue);
  try {
    return new RegExp(matcher.matcher).test(matchValue);
  } catch {
    return false; // Invalid regex — skip
  }
}

/**
 * The imported-plugin matcher, per its documented contract: "A matcher
 * containing only letters, digits, `_`, `-`, spaces, `,` and `|` is compared as
 * an exact string, with alternatives separated by `|` or `,`… A matcher
 * containing any other character is evaluated as an unanchored regular
 * expression… A matcher of `*`, an empty string, or omitting the matcher
 * entirely matches every occurrence of the event."
 *
 * Only matchers carrying `matchMode: 'claude'` reach this. Native automations
 * keep the unanchored-regex behaviour they were written against.
 */
/**
 * Whether a `matchMode: 'claude'` matcher takes the documented LITERAL path
 * rather than the regex one — `hooks.md#matcher-patterns`: *"Exact string, or
 * list of exact strings separated by `|` or `,` with optional surrounding
 * whitespace"*, plus `*`, which the same section gives the meaning "matches
 * every occurrence of the event".
 *
 * Exported because {@link matchesClaudeMatcher} is not the only reader: C3.90
 * measured that `runMatcherSemanticValidations` was compiling EVERY matcher as a
 * regex, so an imported hook spelling the documented `*` was rejected with
 * "nothing to repeat" and took its whole hooks document down with it. A second
 * hand-written copy of this class in the validator is the drift that produced
 * that defect in the first place, so the two read one predicate.
 */
export function isClaudeLiteralMatcher(matcher: string): boolean {
  return matcher === '*' || /^[A-Za-z0-9_\-\s,|]+$/.test(matcher);
}

function matchesClaudeMatcher(matcher: string, matchValue: string): boolean {
  if (matcher === '*') return true;
  // Documented class: letters, digits, `_`, `-`, whitespace, `,`, `|`.
  if (isClaudeLiteralMatcher(matcher)) {
    return matcher.split(/[|,]/).map(part => part.trim()).filter(Boolean).includes(matchValue);
  }
  try {
    return new RegExp(matcher).test(matchValue);
  } catch {
    return false; // Invalid regex — skip
  }
}

/**
 * Canonical matcher evaluation pipeline used by all automation entry points.
 */
export function matcherMatchesWithContext(
  matcher: AutomationMatcher,
  event: AutomationEvent,
  context: MatcherContext,
): boolean {
  if (!matchesBasePredicate(matcher, event, context.matchValue)) return false;

  if (matcher.conditions?.length) {
    return evaluateConditions(matcher.conditions, {
      payload: context.payload,
      matcherTimezone: context.matcherTimezone ?? matcher.timezone,
    });
  }

  return true;
}

/**
 * App-event adapter for canonical matcher evaluation.
 */
export function matcherMatches(matcher: AutomationMatcher, event: AutomationEvent, data: Record<string, unknown>): boolean {
  return matcherMatchesWithContext(matcher, event, {
    matchValue: getMatchValue(event, data),
    payload: data,
    matcherTimezone: matcher.timezone,
  });
}

/**
 * SDK agent-event adapter for canonical matcher evaluation.
 */
export function matcherMatchesSdk(matcher: AutomationMatcher, event: AgentEvent, input: SdkAutomationInput): boolean {
  const matchValue = getMatchValueForSdkInput(event, input);
  const context = (value: string): MatcherContext => ({
    matchValue: value,
    payload: input as unknown as Record<string, unknown>,
    matcherTimezone: matcher.timezone,
  });
  if (matcherMatchesWithContext(matcher, event, context(matchValue))) return true;
  // F1.1131 — the same session tool under the other runtime's name (see the helper).
  const alias = matchValue === input.tool_name ? sessionToolHookAlias(matchValue) : undefined;
  return alias !== undefined && matcherMatchesWithContext(matcher, event, context(alias));
}

// ============================================================================
// Environment Variable Utilities
// ============================================================================

/**
 * Get process.env as a clean Record<string, string> with undefined values filtered out.
 * Avoids the unsafe `process.env as Record<string, string>` cast that turns undefined
 * values into the string "undefined".
 */
export function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
  );
}

/** Keys skipped when iterating payload fields for env vars */
const PAYLOAD_SKIP_KEYS = new Set(['sessionId', 'sessionName', 'workspaceId', 'timestamp']);

/**
 * Build the base NESSY_* environment variables shared by both prompt and webhook actions.
 * Contains event info, session metadata, scheduler time, and payload fields (unsanitized).
 */
function buildBaseEventEnv(event: AutomationEvent, payload: BaseEventPayload): Record<string, string> {
  const env: Record<string, string> = {
    NESSY_EVENT: event,
    NESSY_EVENT_DATA: JSON.stringify(payload),
  };

  if (payload.sessionId) env.NESSY_SESSION_ID = payload.sessionId;
  if (payload.sessionName) env.NESSY_SESSION_NAME = payload.sessionName;
  if (payload.workspaceId) env.NESSY_WORKSPACE_ID = payload.workspaceId;

  // Session metadata as JSON
  const sessionMetadata: Record<string, string> = {};
  if (payload.sessionId) sessionMetadata.id = payload.sessionId;
  if (payload.sessionName) sessionMetadata.name = payload.sessionName;
  if (Object.keys(sessionMetadata).length > 0) {
    env.NESSY_SESSION_METADATA = JSON.stringify(sessionMetadata);
  }

  // Local time for scheduler events
  if (event === 'SchedulerTick') {
    const now = new Date();
    env.NESSY_LOCAL_TIME = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    env.NESSY_LOCAL_DATE = now.toISOString().split('T')[0]!;
  }

  // Payload fields as NESSY_ vars (raw — callers apply sanitization if needed)
  for (const [key, value] of Object.entries(payload)) {
    if (PAYLOAD_SKIP_KEYS.has(key)) continue;
    const envKey = `NESSY_${toSnakeCase(key).toUpperCase()}`;
    env[envKey] = typeof value === 'string' ? value : String(value);
  }

  return env;
}

/**
 * Build environment variables from an event payload for prompt/command actions.
 * Includes full process.env and sanitizes user-controlled values for shell safety.
 */
export function buildEnvFromPayload(event: AutomationEvent, payload: BaseEventPayload): Record<string, string> {
  const base = buildBaseEventEnv(event, payload);
  const env: Record<string, string> = { ...cleanEnv(), ...base };

  // Sanitize session name for shell context
  if (payload.sessionName) env.NESSY_SESSION_NAME = sanitizeForShell(payload.sessionName);

  // Sanitize payload field values for shell context
  for (const [key, value] of Object.entries(payload)) {
    if (PAYLOAD_SKIP_KEYS.has(key)) continue;
    const envKey = `NESSY_${toSnakeCase(key).toUpperCase()}`;
    env[envKey] = typeof value === 'string' ? sanitizeForShell(value) : String(value);
  }

  return env;
}

/**
 * Build environment variables for webhook actions.
 *
 * Unlike buildEnvFromPayload (used by prompt actions), this:
 * - Does NOT spread process.env (no secret leakage)
 * - Does NOT apply shell sanitization (irrelevant for HTTP context)
 * - Only injects NESSY_WH_* user-defined vars from process.env (webhook secrets)
 * - Includes NESSY_* system vars derived from the event payload
 *
 * Users set webhook secrets in their shell profile:
 *   export NESSY_WH_SLACK_URL="https://hooks.slack.com/services/T.../B.../xxx"
 *   export NESSY_WH_DISCORD_TOKEN="abc123"
 *
 * Then reference them in automations.json:
 *   "url": "${NESSY_WH_SLACK_URL}"
 *   "headers": { "Authorization": "Bearer ${NESSY_WH_DISCORD_TOKEN}" }
 */
export function buildWebhookEnv(event: AutomationEvent, payload: BaseEventPayload): Record<string, string> {
  const env = buildBaseEventEnv(event, payload);
  applyWebhookSecrets(env);
  return env;
}

/**
 * User-defined webhook secrets: only `NESSY_WH_*` from process.env. Written
 * LAST by both webhook env builders, so no name derived from the event can
 * shadow a secret.
 */
function applyWebhookSecrets(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NESSY_WH_') && value !== undefined) {
      env[key] = value;
    }
  }
}

/**
 * UB12.52 — the expansion env of a native `webhook` action bound to an AGENT
 * event, the counterpart of {@link buildWebhookEnv} for App events.
 *
 * Since UB12.28 such an action runs as an http hook through the hook executor
 * (`plugins/hooks-automation.ts`), which expands its url, header values and
 * body from this env before the safe-url and credential guards read them.
 * Before UB12.52 nothing was expanded there: a template went out as written,
 * so the docs-site's own `UserPromptSubmit` example (`"url":
 * "${NESSY_WH_SLACK_URL}"`, body `$NESSY_PROMPT`) was refused as a non-http
 * URL on every prompt.
 *
 * The same contract as App events, from the hook input instead of the App
 * payload:
 *  - `NESSY_EVENT` and `NESSY_EVENT_DATA` (the whole hook input as JSON);
 *  - every top-level input field as `NESSY_<FIELD>` (the input's names are
 *    already snake_case: `tool_name` → `NESSY_TOOL_NAME`), a string as is and
 *    anything else as JSON, so the names a command hook reads
 *    (`buildHookCommandEnv` in `hook-command.ts`) are all here; `effort` is
 *    its `level`, as the command env spells `NESSY_EFFORT`;
 *  - `NESSY_WH_*` from process.env, and nothing else from it.
 * Values are RAW, never shell-escaped: an http request reaches no shell, as
 * {@link buildWebhookEnv} says. A field never replaces `NESSY_EVENT` or
 * `NESSY_EVENT_DATA` (FileChanged's input carries its own `event`).
 *
 * The input carries no session name or workspace id, so `NESSY_SESSION_NAME`,
 * `NESSY_SESSION_METADATA` and `NESSY_WORKSPACE_ID` stay unset here, as they
 * are in a command hook's env.
 */
export function buildAgentEventWebhookEnv(event: AgentEvent, input: SdkAutomationInput): Record<string, string> {
  const env: Record<string, string> = {
    NESSY_EVENT: event,
    NESSY_EVENT_DATA: JSON.stringify(input),
  };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const envKey = `NESSY_${toSnakeCase(key).toUpperCase()}`;
    if (envKey === 'NESSY_EVENT' || envKey === 'NESSY_EVENT_DATA') continue;
    env[envKey] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  if (input.effort?.level) env.NESSY_EFFORT = input.effort.level;
  applyWebhookSecrets(env);
  return env;
}

/**
 * UB12.52 — {@link expandEnvVars}'s `${VAR}` and `$VAR` grammar in ONE pass,
 * so a value it inserts is never read again.
 *
 * `expandEnvVars` runs two passes, so text that the `${VAR}` pass inserts is
 * rescanned by the `$VAR` pass. On an agent event the inserted text is the
 * prompt or the tool input, which the user or the model wrote: a Bash command
 * `echo $HOME` inserted through `${NESSY_TOOL_INPUT}` would lose `$HOME`, and
 * a prompt that spells `$NESSY_WH_SLACK_URL` would pull the secret into the
 * request. Here both stay literal. `expandEnvVars` is unchanged for its
 * App-event, prompt and command callers (upstream v0.15.1's function).
 */
export function expandEnvVarsOnce(str: string, env: Record<string, string>): string {
  return str.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/gi, (_, braced: string | undefined, plain: string | undefined) => env[braced ?? plain ?? ''] ?? '');
}

// ============================================================================
// Script action env (UA8.1) — an ALLOWLIST, never a prefix pass-through
// ============================================================================

/**
 * Env vars that are not `NESSY_*` but that script runtimes cannot function without. Paths and OS plumbing only —
 * never credentials. Upstream's list, verbatim (craft-agents-oss v0.13.4:packages/shared/src/automations/utils.ts,
 * Apache-2.0):
 * - HOME/USERPROFILE: bun/uv cache + python interpreter installs
 * - SYSTEMROOT/WINDIR/SYSTEMDRIVE/COMSPEC/PATHEXT/TEMP/TMP: Windows can't spawn or do DNS/socket work without these
 */
export const SCRIPT_ENV_PLATFORM_ESSENTIALS: readonly string[] = process.platform === 'win32'
  ? ['USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']
  : ['HOME'];

export interface ScriptEnvOptions {
  /** Workspace root, exposed as NESSY_WORKSPACE_PATH */
  workspaceRootPath: string;
  /** Page slug when the script refreshes a page (adds the NESSY_PAGE_* vars) */
  page?: string;
}

/**
 * UA8.1 — the script action's environment, built from NAMED keys only (spec §15 item 2, threat S16):
 * - the platform essentials above, copied from `process.env` when set;
 * - the event context `buildBaseEventEnv` derives from the event and its payload (`NESSY_EVENT`,
 *   `NESSY_EVENT_DATA`, `NESSY_SESSION_ID`, `NESSY_WORKSPACE_ID`, …) — values from the event, never from
 *   `process.env`; no shell sanitisation, since they are env payloads a shell never interprets;
 * - `NESSY_WORKSPACE_PATH` and, for a page, `NESSY_PAGE_SLUG` / `NESSY_PAGE_DIR` / `NESSY_PAGE_DATA_DIR`, applied
 *   last so an event payload can never clobber them (upstream ordering).
 *
 * DROPPED from upstream under reason (b): the loop that copied every `CRAFT_*` variable of `process.env`. After
 * the rebrand it would hand `NESSY_DP_AUTH_TOKEN`, `NESSY_CLI_DP_AUTH_TOKEN`, `NESSY_SERVER_TOKEN` and the
 * `NESSY_WH_*` webhook secrets to every script. Residue, stated: a script that needs a secret reads it itself.
 * Absent too, as upstream: PATH (runtimes are spawned by absolute path) and every other variable of the host.
 */
function applyPlatformEssentials(env: Record<string, string>): void {
  for (const key of SCRIPT_ENV_PLATFORM_ESSENTIALS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
}

function applyWorkspaceAndPageEnv(env: Record<string, string>, options: ScriptEnvOptions): void {
  env.NESSY_WORKSPACE_PATH = options.workspaceRootPath;
  if (options.page) {
    const pageDir = join(options.workspaceRootPath, 'pages', options.page);
    env.NESSY_PAGE_SLUG = options.page;
    env.NESSY_PAGE_DIR = pageDir;
    env.NESSY_PAGE_DATA_DIR = join(pageDir, 'data');
  }
}

/**
 * Event-independent script env: the allowlist without any automation event context, for a script run outside the
 * automations pipeline (a page action a user triggers by hand) — there is no event, so a synthetic NESSY_EVENT
 * would be a lie (upstream's reason).
 */
export function buildBaseScriptEnv(options: ScriptEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  applyPlatformEssentials(env);
  applyWorkspaceAndPageEnv(env, options);
  return env;
}

/** The script env for an automation event (see {@link applyPlatformEssentials} for the whole contract). */
export function buildScriptEnv(
  event: AutomationEvent,
  payload: BaseEventPayload,
  options: ScriptEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  applyPlatformEssentials(env);
  Object.assign(env, buildBaseEventEnv(event, payload));
  applyWorkspaceAndPageEnv(env, options);
  return env;
}

import { join } from 'node:path';

/**
 * F1.1131 (origin DN-161, 2026-09-26) — the other runtime's name for a session
 * tool, or `undefined`.
 *
 * The hook payload carries the runtime's own spelling: Claude and codex are
 * handed a session tool as `mcp__session__<name>`, Pi's PreToolUse payload
 * carries the binding's bare `permissionName`. So a matcher written for one
 * runtime missed the same tool on the other. The tool events match under both
 * names, as F1.478 reads a permission rule under both (`session-tool-rule-alias.ts`).
 *
 * Only for a session tool every runtime is handed (no `visibility`): a `pi-only`
 * tool is one Claude never receives from us (it runs its own built-in of that
 * name), and for a `not-pi` one the bare name on Pi is Pi's own built-in
 * (`web_search`). Never a widening beyond the tool the hook already names.
 */
function sessionToolHookAlias(toolName: string): string | undefined {
  sharedSessionToolNames ??= new Set(SESSION_TOOL_DEFS.filter(def => def.visibility === undefined).map(def => def.name));
  const bare = toolName.startsWith(SESSION_TOOL_PREFIX) ? toolName.slice(SESSION_TOOL_PREFIX.length) : undefined;
  if (bare !== undefined) return sharedSessionToolNames.has(bare) ? bare : undefined;
  return sharedSessionToolNames.has(toolName) ? `${SESSION_TOOL_PREFIX}${toolName}` : undefined;
}

const SESSION_TOOL_PREFIX = 'mcp__session__';
let sharedSessionToolNames: ReadonlySet<string> | undefined;
import { SESSION_TOOL_DEFS } from '@nessy-agent/session-tools-core'; // F1.1131 — appended, hoisted
