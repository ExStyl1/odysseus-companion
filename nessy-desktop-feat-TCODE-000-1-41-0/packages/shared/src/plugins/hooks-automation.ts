import type {
  AgentAutomationSystem,
  AgentEvent,
  AgentEventExecutionResult,
  AutomationAction,
  AutomationMatcher,
  AutomationsConfig,
  ComponentHookLayer,
  HookBindingTier,
  HookBindingView,
  HookCommandAction,
  HookHandlerType, HookCommandActionResult,
  HookErrorNotice,
  HookOnFailure,
  HookUniversalOutput,
  PluginAgentHookAction,
  PluginHttpHookAction,
  PluginMcpToolHookAction,
  PluginPromptHookAction,
  PreToolUseDecision,
  PreToolUseDecisionAction,
  PreToolUseDecisionValue,
  SdkAutomationCallbackResult, SdkHooksBuildOptions,
  SdkAutomationCallbackMatcher,
  SdkAutomationInput, WebhookAction,
} from '../automations/types.ts';
import { AGENT_EVENTS, hookTypeSupportedForEvent } from '../automations/types.ts';
import { PERMISSION_MODE_AGENT_LABELS } from '../agent/mode-types.ts';
import { resolve } from 'node:path';
import { evaluateClaudeHookIfFilter, type ClaudeHookIfResult } from '../agent/pi-harness/claude-permission-rules.ts';
import {
  automationHookName,
  buildHookErrorNotice,
  claudeHookEventName,
  commandHookDedupKey,
  dedupeHookEntries,
  getHookCommandPreToolDecision,
  hookCommandBudgetMs, hookCommandStdoutContext,
  hookStdoutJsonFailure,
  hookStdoutParseFailure,
  mergeHookUniversalOutputs,
  parseHookCommandOutput,
  parseHookOutputForEvent,
  readClaudeContractExitAsDocumented,
  redactHookOutput,
  runHookCommand,
  type ImportedHookDialect,
} from '../automations/hook-command.ts';
import { applySessionStartTitleSourceGate, hookBlockEndsTurn, hookEventCanDecide, hookEventStdoutCanDecide, isBlockingHookDecision, mergePreToolUseDecisionObjects, projectHookDecisionForEvent, promptHookBlockEndsTurn } from '../automations/hook-decision-contract.ts';
import { parseCommandHookWorktreePath } from '../automations/hook-worktree-path.ts';
import { capHookRegistryText } from '../automations/hook-task-registry.ts';
import { buildAgentEventWebhookEnv, expandEnvVarsOnce, matcherMatchesSdk } from '../automations/utils.ts';
import type { HookRunObservation } from '../agent/hook-run-report.ts';
import type { PluginRuntimeCompatibilityProfile } from './types.ts';

/**
 * C4.12 (G17-claude) — a host's consumer for the SESSION band of a hook
 * decision: `sessionTitle`, `reloadSkills`, `initialUserMessage`, `watchPaths`.
 *
 * The decision handed over is the one `executePluginHookAutomations` returns,
 * already projected to the event's documented surface and already past
 * `hooks.md`'s SessionStart `source` gate — i.e. exactly what
 * `BaseAgent.applyHookSessionDirectives` documents as its precondition. Awaited,
 * because `reloadSkills` must land before the turn's capability manifest is
 * built.
 */
export type HookSessionDirectiveSink = (decision: PreToolUseDecision) => void | Promise<void>;

/** An automation system that can hand its session band to a host (C4.12). */
export interface SessionDirectiveSinkHost {
  setSessionDirectiveSink(sink: HookSessionDirectiveSink | undefined): void;
}

/**
 * C4.12 — detected rather than declared on `AgentAutomationSystem`.
 *
 * The registration is optional by construction: the inert system a user who
 * turned all hooks off still gets (see `InertAgentAutomationSystem`) has no
 * hooks to deliver a band from, and a host that never registers keeps the
 * previous behaviour byte for byte. A guard says that in a way a reader can
 * check, where an optional interface method would only say it in a type.
 */
export function supportsSessionDirectiveSink(system: unknown): system is SessionDirectiveSinkHost {
  return typeof (system as SessionDirectiveSinkHost | undefined)?.setSessionDirectiveSink === 'function';
}

/**
 * D1.343 — WHICH configuration declared the command hook now being run.
 *
 * The host's execution authority needs it because `hooks.md#workspace-trust`
 * makes the answer the gate: *"Claude Code checks workspace trust before it runs
 * any hook from a settings file"*, and the security disclaimer scopes its review
 * burden to the author's own tier — *"Review and test all hook commands before
 * adding them to your configuration"*. A settings-file hook and a hook a third
 * party shipped inside a plugin bundle are two different questions, and only the
 * dispatcher below knows which it is holding: by the time the tiers are merged
 * configs, provenance is gone (the same reason `HookBindingView.tier` is captured
 * where the resource ref still exists).
 *
 * Read as a RECORD, never inferred from the command text. ABSENT means
 * unattributed, and every consumer must treat that as the third-party answer —
 * a new dispatch site that forgets to declare its tier must not silently widen
 * what runs unasked.
 */
export type CommandHookSource = 'user' | 'workspace' | 'project' | 'plugin' | 'component';

/**
 * D1.343 — whether a command hook from this source may run WITHOUT a permission
 * card, and which tier to say so in when it does.
 *
 * ## The documented mechanism, which this fork was not following
 *
 * `hooks.md`'s opening sentence: *"Hooks are user-defined shell commands, HTTP
 * endpoints, MCP tool calls, LLM prompts, or subagents that execute
 * automatically at specific points in Claude Code's lifecycle."* The one gate
 * the page puts in front of that is workspace trust —
 * `hooks.md#workspace-trust`, verbatim: *"Claude Code checks workspace trust
 * before it runs any hook from a settings file"*, and for an interactive session
 * it *"holds back hooks from every settings file, including your own
 * `~/.claude/settings.json`, until you accept the workspace trust dialog"*. Past
 * that check the hook simply runs; there is no per-hook prompt in the contract.
 *
 * This fork put EVERY command hook through the host permission gate, so a hook
 * the operator wrote in their own settings raised a Bash card and, until D1.333,
 * waited for a click that a headless or unattended profile could never produce.
 * The security disclaimer places the review where the page expects it — *"Review
 * and test all hook commands before adding them to your configuration"* — which
 * is the author's tier, ahead of the run, not a card at run time.
 *
 * ## Two answers, and why they are not one
 *
 * `user` needs no trust decision: those settings are the operator's own and a
 * workspace-only session has no repository folder to trust in the first place
 * (`projectTrustState` is `'none'` for every session with no bound project, so
 * requiring trust here would keep the card for the common case on a rule the
 * page does not state). `project` is a settings file the REPOSITORY owns, which
 * is exactly what the page's trust check is about, so it is admitted only once
 * that folder is trusted; `'none'` and `'blocked'` keep the card.
 *
 * ## Where this fork stays STRICTER than the page, stated rather than implied
 *
 * `workspace`, `plugin`, `component` and an ABSENT source keep the card — a
 * `[product]` posture (D1.343, then D1.429). A plugin's hook command is third
 * party code the operator never wrote and the page's review advice is scoped to
 * *your* configuration; a component hook rides a skill or agent file as often a
 * plugin's as the user's own; and `workspace` is the APP's own directory, where
 * the model-invocable `automation_create` writes — a tier a model can append to
 * cannot carry a review the operator performed. Absent is fail-closed.
 */
export function commandHookPreauthorizedTier(
  source: CommandHookSource | undefined,
  projectTrusted: boolean,
): 'user' | 'project' | undefined {
  if (source === 'user') return 'user';
  if (source === 'workspace') return undefined;
  if (source === 'project' && projectTrusted) return 'project';
  return undefined;
}

/**
 * Spawns one command-hook action and returns its result — the same contract as
 * `runHookCommand` (env-building/output-parsing stay in `executePluginHookAutomations`
 * and `getHookCommandPreToolDecision`; ONLY the execution authority is swappable).
 * Hosts inject this runner to route effectful command hooks through their normal
 * permission, receipt, and process-isolation paths.
 */
export type CommandHookRunner = (
  action: HookCommandAction,
  options: {
    event: AgentEvent;
    input: SdkAutomationInput;
    cwd: string;
    signal?: AbortSignal;
    /** Present only for a verified plugin hook. */
    pluginDataPath?: string;
    /** D1.343 — the declaring tier. See {@link CommandHookSource}. */
    hookSource?: CommandHookSource;
  },
) => Promise<HookCommandActionResult>;

/**
 * Spawns one agent-hook's declared sub-agent (B1): a seam onto the existing child-session service
 * (mirrors `CommandHookRunner` onto the ProcessSupervisor) — never a new spawn authority, inert with
 * no runner, and observational only: the result is never a blocking decision.
 */
export interface PluginAgentHookRequest {
  agentName: string;
  event: AgentEvent;
  signal?: AbortSignal;
  /** F1.209 — the action's resolved hooks.md `timeout` in ms; absent = the runner's own budget. */
  timeoutMs?: number;
}

export type PluginAgentHookRunner = (request: PluginAgentHookRequest) => Promise<void>;

/**
 * Judges one prompt-hook's body with a fast model (R22, hooks.md): the model answers `{ok, reason}`;
 * `ok:false` becomes a blocking decision on the bound event. Injected authority — with no runner the
 * prompt hook stays the B1 observational `additionalContext` injection. `undefined` (error, timeout,
 * unparseable verdict) is fail-open: a broken judge must not block every call.
 */
export interface PluginPromptHookRequest {
  prompt: string;
  model?: string;
  event: AgentEvent;
  input: unknown;
  signal?: AbortSignal;
}

export type PluginPromptHookRunner = (request: PluginPromptHookRequest) => Promise<{ ok: boolean; reason?: string } | undefined>;

/** hooks.md: prompt hooks default to a 30s timeout; our 60s ceiling stays. */
const PROMPT_HOOK_DEFAULT_TIMEOUT_MS = 30_000;
const PROMPT_HOOK_MAX_TIMEOUT_MS = 60_000;

function clampPromptHookTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return PROMPT_HOOK_DEFAULT_TIMEOUT_MS;
  return Math.min(timeoutMs, PROMPT_HOOK_MAX_TIMEOUT_MS);
}

/**
 * What an http or mcp_tool runner answers with (D6/D8).
 *
 * Both hook types answer in one shape and are merged through one path, and
 * a JSON object answer is read exactly like a command hook's exit-0 stdout.
 * A NON-JSON answer is where they part (UB12.51): mcp_tool text is stdout,
 * an http body is not.
 *
 * hooks.md § HTTP response handling, re-read 2026-10-16 (curl):
 *   "* **2xx with an empty body**: success, equivalent to exit code 0 with no output
 *    * **2xx with a JSON object body**: parsed using the same [JSON output](#json-output) schema as command hooks. A body that fails schema validation is a non-blocking error
 *    * **2xx with any other body, such as plain text**: non-blocking error, handled the same as a non-2xx status. Claude Code doesn't add the text to Claude's context
 *    * **Non-2xx status**: non-blocking error, execution continues
 *    * **Connection failure**: non-blocking error, execution continues
 *    * **Timeout**: the hook is canceled, as described under [Timeouts](#timeouts)"
 * Until UB12.51 this block quoted an older wording of the same section, under
 * which a plain-text 2xx body was a success whose text was added as context.
 *
 * hooks.md § MCP tool hook fields, "How the tool's result is read": "Claude
 * Code reads the tool's text content the same way it reads command-hook
 * stdout, following the parsing rule under exit code 0. If the tool returns
 * `isError: true`, the hook produces a non-blocking error and execution
 * continues."
 *
 * `code` is a short host-authored reason code and NEVER the response body, URL,
 * query or headers: a policy webhook's answer is organizational data and may
 * carry credentials, so nothing but the code leaves the runner. A host that
 * returns nothing keeps the previous observational behaviour.
 */
export interface PluginHookRunnerVerdict {
  /**
   * The hook's answer. A JSON object is read exactly like a command hook's
   * exit-0 stdout; any other non-empty http body is a non-blocking error (UB12.51).
   */
  body?: string;
  /** A non-blocking error: non-2xx, transport failure, timeout, or `isError`. */
  failed?: boolean;
  /** Short, non-sensitive reason code for the documented error notice. */
  code?: string;
  /**
   * UB12.50 — the HOST refused to start the hook, so nothing was sent. It is
   * the receipt's own `code`, and {@link applyHookRunnerVerdict} reads it as a
   * non-blocking error that is reported, never as a decision.
   */
  refused?: PluginHookRunnerRefusal;
}

/**
 * UB12.50 — why a host runner refused to START a hook. Each value is the
 * `code` of the `denied`/`not-started` receipt the runner writes beside it.
 *
 * Before this, the runner wrote the receipt and returned nothing, and nothing
 * reads as "the hook answered nothing", so the hook never fired and no notice
 * said so. hooks.md#exit-code-output, verbatim: "Non-blocking error: your hook
 * exits with any other code, or fails in some other way, such as not starting
 * or printing invalid JSON. The action goes ahead, and on events such as
 * `PreToolUse` you see a `<hook name> hook error` notice in the transcript."
 */
export type PluginHookRunnerRefusal =
  | 'plugin-trust-unavailable'
  | 'http-hook-url-not-allowed'
  | 'permission-denied';

/**
 * Invokes one mcp_tool-hook's declared tool through the EXISTING MCP pool (B2); `proxyName` is the
 * fully-qualified `mcp__<server>__<tool>` name — the runner never resolves a short alias.
 */
export interface PluginMcpToolHookRequest {
  proxyName: string;
  args: Record<string, unknown>;
  event: AgentEvent;
  signal?: AbortSignal;
  /** F1.209 — the action's resolved hooks.md `timeout` in ms; absent = the runner's own budget. */
  timeoutMs?: number;
}

export type PluginMcpToolHookRunner = (
  request: PluginMcpToolHookRequest,
) => Promise<PluginHookRunnerVerdict | void>;

/**
 * Fires one http-hook's declared request through the EXISTING webhook executor (B2). Presence of this
 * runner IS the explicit network permission grant — when absent the request never fires (denial has
 * no side effect). The runner owns the bounded timeout (`timeoutMs` below) + response-size cap.
 */
export interface PluginHttpHookRequest {
  http: PluginHttpHookAction['http'];
  event: AgentEvent;
  signal?: AbortSignal;
  /** F1.209 — the action's resolved hooks.md `timeout` in ms; absent = the runner's own budget. */
  timeoutMs?: number;
}

export type PluginHttpHookRunner = (
  request: PluginHttpHookRequest,
) => Promise<PluginHookRunnerVerdict | void>;

/**
 * hooks.md § Common fields, `statusMessage`: "Custom spinner message displayed while the hook runs."
 * The host owns the spinner, so it injects this; called with the label when a matched hook declares
 * one, and with `undefined` when the event's hooks are done.
 */
export type PluginHookStatusReporter = (message: string | undefined) => void;

/**
 * C3.301 — one note from a background (`async`) command hook that has already
 * finished, on its way OUT OF BAND to the session.
 *
 * Every other authority this module takes is request/response inside the event
 * being handled; this one is the opposite direction, which is exactly why the
 * `async` branch could not deliver anything before it existed. The host owns
 * where it lands, because the two documented destinations are the host's own
 * idle/busy discipline and nothing in this package can see a session.
 *
 * `hooks.md#how-async-hooks-execute`, verbatim: *"After the background process
 * exits, Claude Code delivers the `additionalContext` and `systemMessage` fields
 * from the hook's JSON response to Claude on the next conversation turn. Unlike
 * a synchronous hook's `systemMessage`, neither field is shown to you."*
 * `hooks.md#limitations`: *"Hook output is delivered on the next conversation
 * turn. If the session is idle, the response waits until the next user
 * interaction. Exception: an `asyncRewake` hook that exits with code 2 wakes
 * Claude immediately even when the session is idle."*
 */
export interface PluginAsyncHookNote {
  /**
   * `'rewake'` — an `asyncRewake` hook that exited 2. The page's exception: it
   * wakes an idle session immediately.
   *
   * `'delivery'` — any background hook's `additionalContext`/`systemMessage`.
   * The page's rule: the next conversation turn, and an idle session waits for
   * the next user interaction rather than being woken.
   */
  readonly kind: 'rewake' | 'delivery';
  /** The matcher's name, for the log and for the note's own framing. */
  readonly hookName: string;
  /** The event whose dispatch started the background run. */
  readonly event: AgentEvent;
  /** The text to deliver. Never empty — an empty note is dropped at the source. */
  readonly text: string;
}

/**
 * The host's out-of-band sink for {@link PluginAsyncHookNote}. Absent = the
 * background run's output is discarded, which is what happened on every
 * runtime until C3.301.
 */
export type PluginAsyncHookNoteEmitter = (note: PluginAsyncHookNote) => void;

const EXTERNAL_HOOK_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: 'Bash',
};

function usesExternalHookToolNames(
  action: AutomationAction,
  pluginRuntime: boolean | undefined,
): action is HookCommandAction {
  return pluginRuntime === true
    && action.type === 'command'
    && action.env?.CLAUDE_PLUGIN_ROOT !== undefined;
}

// Hook prompt context is observational, but still crosses the agent boundary.
// Keep a malformed plugin declaration from consuming an unbounded turn budget.
const MAX_PLUGIN_HOOK_CONTEXT_CHARS = 16 * 1024
const MAX_PLUGIN_HOOK_HTTP_URL_CHARS = 8 * 1024
const MAX_PLUGIN_HOOK_HTTP_QUERY_FIELDS = 64
const MAX_PLUGIN_HOOK_HTTP_HEADER_FIELDS = 64
const MAX_PLUGIN_HOOK_HTTP_HEADER_VALUE_CHARS = 16 * 1024
const MAX_PLUGIN_HOOK_HTTP_BODY_DEPTH = 8
const MAX_PLUGIN_HOOK_HTTP_BODY_NODES = 256
const MAX_PLUGIN_HOOK_HTTP_BODY_FIELDS = 64
const MAX_PLUGIN_HOOK_HTTP_BODY_STRING_CHARS = 16 * 1024
const MAX_PLUGIN_HOOK_HTTP_FIELD_NAME_CHARS = 256
const SENSITIVE_PLUGIN_HOOK_CREDENTIAL_KEY = /(?:^|[-_])(?:authorization|proxy[-_]?authorization|cookie|token|secret|password|credential|api[-_]?key|auth(?:entication|orization)?|bearer|basic)(?:$|[-_])/i
const EXPLICIT_PLUGIN_HOOK_CREDENTIAL_ASSIGNMENT = /(?:^|[?&;,\s{])["']?([A-Za-z][A-Za-z0-9_-]{0,127})["']?\s*[:=]\s*["']?\S+/gi
const EXPLICIT_PLUGIN_HOOK_CREDENTIAL_BODY_MARKER = /\b(?:bearer|basic)\s+\S+/i

function isSafePluginHookHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSensitivePluginHookCredentialKey(value: string): boolean {
  if (value.length > MAX_PLUGIN_HOOK_HTTP_FIELD_NAME_CHARS) return true;
  const normalized = value.trim().replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  return SENSITIVE_PLUGIN_HOOK_CREDENTIAL_KEY.test(normalized);
}

function hasExplicitPluginHookCredentialString(value: string): boolean {
  if (EXPLICIT_PLUGIN_HOOK_CREDENTIAL_BODY_MARKER.test(value)) return true;
  for (const match of value.matchAll(EXPLICIT_PLUGIN_HOOK_CREDENTIAL_ASSIGNMENT)) {
    const key = match[1];
    if (key && isSensitivePluginHookCredentialKey(key)) return true;
  }
  return false;
}

function hasSensitivePluginHookUrlCredentials(value: string): boolean {
  if (value.length > MAX_PLUGIN_HOOK_HTTP_URL_CHARS) return true;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    let fields = 0;
    for (const [key, entry] of url.searchParams) {
      if (++fields > MAX_PLUGIN_HOOK_HTTP_QUERY_FIELDS
        || isSensitivePluginHookCredentialKey(key)
        || hasExplicitPluginHookCredentialString(entry)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function hasSensitivePluginHookBodyCredentials(
  value: unknown,
  depth = 0,
  state = { nodes: MAX_PLUGIN_HOOK_HTTP_BODY_NODES, seen: new WeakSet<object>() },
): boolean {
  if (typeof value === 'string') {
    return value.length > MAX_PLUGIN_HOOK_HTTP_BODY_STRING_CHARS
      || hasExplicitPluginHookCredentialString(value);
  }
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return false;
  if (typeof value !== 'object' || depth >= MAX_PLUGIN_HOOK_HTTP_BODY_DEPTH || state.nodes-- <= 0) return true;
  if (state.seen.has(value)) return true;
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_PLUGIN_HOOK_HTTP_BODY_FIELDS) return true;
    return value.some(entry => hasSensitivePluginHookBodyCredentials(entry, depth + 1, state));
  }
  if (!isPlainRecord(value)) return true;
  let fields = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (++fields > MAX_PLUGIN_HOOK_HTTP_BODY_FIELDS) return true;
    const entry = value[key];
    if (isSensitivePluginHookCredentialKey(key)
      || hasSensitivePluginHookBodyCredentials(entry, depth + 1, state)) return true;
  }
  return false;
}

/** Bounded fail-closed credential guard shared by hook dispatch and host execution. */
export function isCredentialBearingPluginHttpDescriptor(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isPlainRecord(value)) return true;
  const descriptor = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(descriptor, 'auth')) return true;
  if (typeof descriptor.url !== 'string' || hasSensitivePluginHookUrlCredentials(descriptor.url)) return true;
  if (Object.prototype.hasOwnProperty.call(descriptor, 'headers')) {
    const headers = descriptor.headers;
    if (headers !== undefined) {
      if (!headers || typeof headers !== 'object' || Array.isArray(headers) || !isPlainRecord(headers)) return true;
      let headerCount = 0;
      for (const name in headers) {
        if (!Object.prototype.hasOwnProperty.call(headers, name)) continue;
        const entry = (headers as Record<string, unknown>)[name];
        if (++headerCount > MAX_PLUGIN_HOOK_HTTP_HEADER_FIELDS
          || isSensitivePluginHookCredentialKey(name)
          || typeof entry !== 'string'
          || entry.length > MAX_PLUGIN_HOOK_HTTP_HEADER_VALUE_CHARS
          || hasExplicitPluginHookCredentialString(entry)) return true;
      }
    }
  }
  return Object.prototype.hasOwnProperty.call(descriptor, 'body')
    && hasSensitivePluginHookBodyCredentials(descriptor.body);
}

function isQualifiedPluginMcpProxyName(value: string): boolean {
  return /^mcp__[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/.test(value)
}

function externalHookInput(
  action: AutomationAction,
  input: SdkAutomationInput,
  pluginRuntime: boolean | undefined,
): SdkAutomationInput {
  if (!usesExternalHookToolNames(action, pluginRuntime) || !input.tool_name) return input;
  const toolName = EXTERNAL_HOOK_TOOL_NAMES[input.tool_name];
  return toolName && toolName !== input.tool_name ? { ...input, tool_name: toolName } : input;
}

/**
 * UB12.99 — the input a command hook held to Claude's contract reads: Claude's
 * spelling of the event in `hook_event_name` (`Elicitation` where this fork
 * fired `McpElicitation`, {@link claudeHookEventName}). Every other hook reads
 * the input unchanged.
 *
 * hooks.md#elicitation-input (curl'd 2026-10-17) shows the Elicitation input
 * with `"hook_event_name": "Elicitation"`, and § Common input fields defines
 * the field as "Name of the event that fired". `BaseAgent.elicitationHookBase`
 * stamps our internal name, the one native automations are stored under, so a
 * Claude plugin's hook that branched on `Elicitation` never matched.
 *
 * The test is the marker the executor already reads Claude's contract from,
 * `blockOnNonZero === false` (a Claude plugin's command hook, a hooks file
 * handler in Claude's settings shape, or a native handler that spells it). It
 * is the same set whose output is checked against Claude's schema
 * ({@link claudeContractOutputFailure}), so the name such a hook reads is the
 * name its `hookSpecificOutput.hookEventName` must carry. A native `actions`
 * hook and a codex or `nessy-plugin.json` command hook keep the stored name.
 *
 * Applied to the runner's input only, never to matching: the elicitation
 * matcher reads `mcp_server_name`, not the event name.
 */
function claudeContractHookInput(
  action: HookCommandAction,
  event: AgentEvent,
  input: SdkAutomationInput,
): SdkAutomationInput {
  if (action.blockOnNonZero !== false) return input;
  const spelled = claudeHookEventName(input.hook_event_name || event);
  return spelled === input.hook_event_name ? input : { ...input, hook_event_name: spelled };
}

function pluginMatcherMatches(
  matcher: AutomationMatcher,
  event: AgentEvent,
  input: SdkAutomationInput,
  pluginRuntime: boolean | undefined,
): boolean {
  if (matcherMatchesSdk(matcher, event, input)) return true;
  return matcher.actions.some(action => {
    const compatibleInput = externalHookInput(action, input, pluginRuntime);
    return compatibleInput !== input && matcherMatchesSdk(matcher, event, compatibleInput);
  });
}

/**
 * There used to be a `MATCHER_INERT_AGENT_EVENTS` map here, and a
 * `plugin.hooks.matcher_never_matches` warning reading from it, for documented
 * matcher-bearing events whose matcher vocabulary had no counterpart in what
 * Nessy emits. R73 emptied it, in two different ways, and it is gone rather
 * than left as a zero-entry lookup:
 *
 * - `ConfigChange` and `UserPromptExpansion` left because their PRODUCERS
 *   landed — the settings-file watcher carries the documented `source`, the
 *   command-expansion site carries `command_name`.
 * - `Setup` left because the EVENT did (f001). Its gap was a firing rule, not a
 *   payload gap, so there was no producer to add: hooks.md#setup fires it only
 *   under `--init-only` / `-p --init` / `-p --maintenance`. A hook on it is now
 *   refused upstream — `mapExternalHookEventName` routes it to a deferral — so
 *   nothing reaches this loop to warn about.
 *
 * If a documented matcher ever outruns our payload again, the warning belongs
 * back here; the reason it is not here now is that every remaining
 * matcher-bearing event has a real match value.
 */

/** Events the hook `if` filter evaluates on (hooks.md § if; PermissionDenied "supports the if filter"). */
export const TOOL_HOOK_EVENTS: ReadonlySet<AgentEvent> = new Set<AgentEvent>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])

/*
 * There is no `decisionMergePolicy` here, and the history is worth keeping
 * because the shape recurs (P3.193/P3.194, then P3.256).
 *
 * It WAS a two-member switch over two different orderings, defaulting to
 * `'legacy'`: a `deny` stayed sticky and everything else was
 * last-writer-wins, so a later `allow` erased an earlier `defer` OR `ask`.
 * Only `'strict'` implemented the documented precedence, and only Pi asked for
 * it (`SessionManager`'s `provider === 'pi'` arm), so the page's rule held on
 * one runtime of three. `hooks.md#pretooluse-decision-control` states the
 * ordering unconditionally — "When multiple PreToolUse hooks return different
 * decisions, precedence is `deny` > `defer` > `ask` > `allow`" — so there was
 * never anything for a policy to select.
 *
 * P3.193/P3.194 deleted `'legacy'`, which left a one-member type and a field
 * that selected nothing. P3.256 deletes the field and the type: an option that
 * cannot change an outcome is a knob a reader must still reason about, and the
 * compiler CANNOT catch a partial removal here — TypeScript does not
 * excess-property-check a value arriving through a conditional spread, which is
 * exactly how `SessionManager` passed it. That is why the field, its two option
 * surfaces, its caller and the test pinning the caller had to move together
 * rather than one at a time.
 */

/**
 * P6.294 — one matcher, projected into the rows a read-only hook view shows.
 *
 * ONE row per ACTION, not per matcher: `hooks.md#hook-handler-fields` lets a
 * matched group hold several handlers, and they can be of different types — a
 * view that collapsed them would tell the user "one hook" where two processes
 * run. The event, matcher and `if` filter are repeated on each row because they
 * are what the author wrote to scope ALL of them.
 *
 * What is withheld is the whole point of the shape, and it is stated once on
 * {@link HookBindingView}: no command, no argv, no absolute path. That rule is
 * why this returns `handlerType` and not the action itself — an action object
 * carries `command`, `http.url` and `prompt`, and handing it out would defeat
 * the projection at the one place it is built.
 */
export function hookBindingsForMatcher(
  event: AgentEvent,
  matcher: AutomationMatcher,
  tier: HookBindingTier,
  source?: string,
): HookBindingView[] {
  return matcher.actions.map(action => ({
    event,
    tier,
    handlerType: hookBindingHandlerType(action), ...(isInertHookBinding(action, event) ? { inert: true } : {}),
    ...(matcher.name ? { name: matcher.name } : {}),
    ...(matcher.matcher ? { matcher: matcher.matcher } : {}),
    ...(matcher.ifRule ? { ifRule: matcher.ifRule } : {}),
    ...(source ? { source } : {}),
    enabled: matcher.enabled !== false,
  }));
}

/**
 * The action's kind in the vocabulary `HookHandlerType` already publishes.
 *
 * The two native automation kinds have no hook spelling of their own: a
 * `webhook` action is our `http` handler under its stored name, and runs as one
 * on an agent event (F1.786). A native `prompt` action only borrows the word: it
 * starts a background session (its llmConnection, model, the matcher's labels)
 * and is NOT a `plugin-prompt` judge; nothing runs it on an AGENT event, so
 * that row is marked inert by {@link isInertHookBinding} (UB12.49). Where it was
 * authored is provenance, which {@link HookBindingView.tier} already says.
 */
function hookBindingHandlerType(action: AutomationAction): HookHandlerType | 'decision' {
  switch (action.type) {
    case 'command': case 'script': return 'command'; // UA8.1 spawn; UA12.33: a script on an agent event never runs — its row shows inert (isInertHookBinding)
    case 'plugin-prompt': case 'prompt': return 'prompt'; // UB12.49: a native `prompt` on an agent event never runs — its row shows inert (isInertHookBinding)
    case 'plugin-agent': return 'agent';
    case 'plugin-mcp-tool': return 'mcp';
    case 'plugin-http': case 'webhook': return 'http';
    case 'decision': return 'decision';
  }
}

export interface PluginScopedAutomationSystemOptions {
  nativeSystem?: AgentAutomationSystem;
  userGlobalHookConfig?: AutomationsConfig;
  workspaceHookConfig?: AutomationsConfig;
  pluginHookConfig: AutomationsConfig;
  projectHookConfig?: AutomationsConfig;
  /**
   * P6.294 — the enumerable tiers' bindings, already projected by the builder
   * that had the resource refs in hand.
   *
   * They are supplied rather than derived here because provenance is LOST by
   * the time the tiers are merged configs: `mergeAutomationsConfigs` keeps the
   * matchers and drops which file each came from. The component tier is the
   * exception and is NOT in this array — it is resolved fresh per dispatch, so
   * {@link PluginScopedAutomationSystem.describeHookBindings} asks the live
   * layer instead of trusting a snapshot taken at build time.
   */
  hookBindings?: readonly HookBindingView[];
  workspaceRootPath: string;
  workingDir?: string;
  assertActive?: () => void;
  /** Re-verify immutable plugin bytes immediately before a plugin callback/process. */
  verifyPluginIntegrity?: () => Promise<void>;
  /**
   * When present, every command-hook config spawns through the existing
   * ProcessSupervisor `workspace` isolation path.
   */
  pluginCommandRunner?: CommandHookRunner;
  /** Explicit legacy opt-in for non-Pi hosts that accept direct command-hook spawn. */
  allowDirectCommandRunner?: boolean;
  /** Judges prompt hooks with a fast model (R22); absent = observational. */
  pluginPromptRunner?: PluginPromptHookRunner;
  /**
   * Spawns plugin/project agent-hook sub-agents through the child-session
   * service. Applies to `pluginHookConfig`/`projectHookConfig` only — native
   * user/workspace hooks never route agent hooks. Absent = agent hooks inert.
   */
  pluginAgentRunner?: PluginAgentHookRunner;
  /** Invokes plugin/project mcp_tool hooks through the MCP pool (B2). */
  pluginMcpToolRunner?: PluginMcpToolHookRunner;
  /** Fires plugin/project http hooks under the network permission grant (B2). */
  pluginHttpRunner?: PluginHttpHookRunner;
  /**
   * Host-owned spinner channel for a hook's `statusMessage` (hooks.md § Common
   * fields). Absent = the label is carried and never displayed.
   */
  hookStatusReporter?: PluginHookStatusReporter;
  /**
   * C3.301 — the out-of-band sink for a background hook's output. Absent = the
   * `async` branch discards the run, which is the state this row closed.
   */
  asyncHookNoteEmitter?: PluginAsyncHookNoteEmitter;
  /**
   * R87 — the host's component-scoped (skill frontmatter) hook layer, resolved
   * FRESH on each dispatch. A function rather than a value because the layer's
   * matchers appear and disappear with the active components within a single
   * turn; capturing it once would defeat the whole point (the 429 plan's T2
   * correction). Absent = no component hooks.
   *
   * P6.59 corrected this comment's second half. It used to read "Absent = the
   * anthropic/SDK path, which dispatches through `buildSdkHooks`, not this
   * chain" — i.e. absence WAS the anthropic contract. Both halves were wrong:
   * the host withheld the layer from anthropic on the premise that the SDK owned
   * those hooks, and `buildSdkHooks` did not consult the layer at all, so on
   * that backend a skill's frontmatter hooks reached neither route. The layer is
   * now supplied on every provider and both routes read it
   * ({@link PluginScopedAutomationSystem.buildComponentSdkHooks}).
   */
  componentHookLayer?: () => ComponentHookLayer | undefined;
  /**
   * P2.496 — the user tier's `disableAllHooks`, carried so the host can read it.
   *
   * Set on a system that still EXISTS after the switch engaged, which is the
   * mixed case and not a contradiction: the user/project switch stops at the
   * managed boundary, so plugin hooks force-enabled in managed `enabledPlugins`
   * keep running while every tier the user owns is empty. The flag describes
   * the user's setting, not this object's contents.
   *
   * Absent means the switch was not engaged. Never set it to `false` to say
   * "unknown" — the interface reads absence as unknown and a `false` would
   * assert the opposite.
   */
  userTierDisableAllHooks?: boolean;
}

export class PluginScopedAutomationSystem implements AgentAutomationSystem {
  private readonly nativeSystem: AgentAutomationSystem | undefined;
  private readonly userGlobalHookConfig: AutomationsConfig | undefined;
  private readonly workspaceHookConfig: AutomationsConfig | undefined;
  private readonly pluginHookConfig: AutomationsConfig;
  private readonly projectHookConfig: AutomationsConfig | undefined;
  private readonly workspaceRootPath: string;
  private readonly workingDir: string | undefined;
  private readonly assertActive: () => void;
  private readonly verifyPluginIntegrity: () => Promise<void>;
  private readonly pluginCommandRunner: CommandHookRunner | undefined;
  private readonly allowDirectCommandRunner: boolean;
  private readonly pluginPromptRunner: PluginPromptHookRunner | undefined;
  private readonly pluginAgentRunner: PluginAgentHookRunner | undefined;
  private readonly pluginMcpToolRunner: PluginMcpToolHookRunner | undefined;
  private readonly pluginHttpRunner: PluginHttpHookRunner | undefined;
  private readonly hookStatusReporter: PluginHookStatusReporter | undefined;
  private readonly asyncHookNoteEmitter: PluginAsyncHookNoteEmitter | undefined;
  private readonly componentHookLayer: (() => ComponentHookLayer | undefined) | undefined;
  private readonly hookBindings: readonly HookBindingView[];
  /** P2.496 — see the option's comment; `undefined` is "not engaged". */
  readonly userTierDisableAllHooks: boolean | undefined;

  constructor(options: PluginScopedAutomationSystemOptions) {
    this.nativeSystem = options.nativeSystem;
    this.userTierDisableAllHooks = options.userTierDisableAllHooks;
    this.userGlobalHookConfig = options.userGlobalHookConfig;
    this.workspaceHookConfig = options.workspaceHookConfig;
    this.pluginHookConfig = options.pluginHookConfig;
    this.projectHookConfig = options.projectHookConfig;
    this.workspaceRootPath = options.workspaceRootPath;
    this.workingDir = options.workingDir;
    this.assertActive = options.assertActive ?? (() => {});
    this.verifyPluginIntegrity = options.verifyPluginIntegrity ?? (async () => {});
    this.pluginCommandRunner = options.pluginCommandRunner;
    this.allowDirectCommandRunner = options.allowDirectCommandRunner ?? false;
    this.pluginPromptRunner = options.pluginPromptRunner;
    this.pluginAgentRunner = options.pluginAgentRunner;
    this.pluginMcpToolRunner = options.pluginMcpToolRunner;
    this.pluginHttpRunner = options.pluginHttpRunner;
    this.hookStatusReporter = options.hookStatusReporter;
    this.asyncHookNoteEmitter = options.asyncHookNoteEmitter;
    this.componentHookLayer = options.componentHookLayer;
    this.hookBindings = options.hookBindings ?? [];
  }

  /**
   * P6.294 — every hook this session will actually run, in one place.
   *
   * ## Why this is a method on the SYSTEM and not a read of the catalog
   *
   * The catalog knows REGISTRATIONS; this knows what survived. Between the two
   * sit the managed kill switch, `allowManagedHooksOnly`, the strict-plugin-only
   * lock, the user/project `disableAllHooks`, the plugin-integrity verification
   * and the per-event acceptance in `pluginHookConfig` — a registration can be
   * present in the catalog and run nothing. A view built from the catalog would
   * therefore be a list of hooks the user does NOT have, which is worse than no
   * list: it is the same silent divergence this row exists to close, with the
   * sign flipped.
   *
   * ## The two halves, and why they are gathered differently
   *
   * The four config tiers are a SNAPSHOT — they were fixed when the system was
   * built, and their provenance was captured then, because
   * `mergeAutomationsConfigs` drops it. The component tier (R87: a skill's or a
   * subagent's frontmatter hooks) is NOT a snapshot: it appears and disappears
   * with the active components inside a single turn, which is why the layer is a
   * function. So it is asked LIVE, here, per event — `matchersFor` and
   * `onceMatchersFor` both, since a `once` hook that has not been consumed is a
   * hook this session will still run.
   *
   * `matchersFor` is called without a dispatch input, which is what makes this a
   * "could run" listing rather than a "would run for this call" one — the same
   * distinction {@link ComponentHookLayer.hasMatchers} is documented for.
   */
  describeHookBindings(): readonly HookBindingView[] {
    const componentLayer = this.componentHookLayer?.();
    if (!componentLayer) return this.hookBindings;
    const componentBindings: HookBindingView[] = [];
    const seen = new Set<string>();
    for (const event of AGENT_EVENTS) {
      for (const config of [componentLayer.matchersFor(event), componentLayer.onceMatchersFor(event)]) {
        for (const matcher of config?.automations[event] ?? []) {
          // A `once` hook that is still unconsumed is also returned by
          // `matchersFor` on some layers, so the two lists can overlap; the key
          // is the identity a reader would use to tell two rows apart.
          const key = `${event}\u0000${matcher.id ?? matcher.name ?? ''}\u0000${matcher.matcher ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          componentBindings.push(...hookBindingsForMatcher(event, matcher, 'component'));
        }
      }
    }
    return [...this.hookBindings, ...componentBindings];
  }

  /** Injected plugin/project hook runner seams (command/agent/mcp/http). */
  private pluginRunnerOptions(): {
    runner?: CommandHookRunner;
    promptRunner?: PluginPromptHookRunner;
    agentRunner?: PluginAgentHookRunner;
    mcpToolRunner?: PluginMcpToolHookRunner;
    httpRunner?: PluginHttpHookRunner;
    allowDirectCommandRunner?: boolean;
    statusReporter?: PluginHookStatusReporter;
    asyncNoteEmitter?: PluginAsyncHookNoteEmitter;
  } {
    return {
      ...(this.hookStatusReporter ? { statusReporter: this.hookStatusReporter } : {}),
      ...(this.asyncHookNoteEmitter ? { asyncNoteEmitter: this.asyncHookNoteEmitter } : {}),
      ...(this.pluginCommandRunner ? { runner: this.pluginCommandRunner } : {}),
      ...(this.pluginPromptRunner ? { promptRunner: this.pluginPromptRunner } : {}),
      ...(this.pluginAgentRunner ? { agentRunner: this.pluginAgentRunner } : {}),
      ...(this.pluginMcpToolRunner ? { mcpToolRunner: this.pluginMcpToolRunner } : {}),
      ...(this.pluginHttpRunner ? { httpRunner: this.pluginHttpRunner } : {}),
      ...(this.allowDirectCommandRunner ? { allowDirectCommandRunner: true } : {}),
    };
  }

  /**
   * C4.12 — the host's consumer of a hook decision's SESSION band, when one is
   * registered.
   *
   * The SDK-hook path is the only dispatch route for `SessionStart` on the
   * claude backend, and `automationResultToSdkHookResult` deliberately drops
   * `sessionTitle`, `reloadSkills`, `initialUserMessage` and `watchPaths` on the
   * way out (R64: the SDK would apply them to ITS session — renaming a record
   * the sidebar never reads, re-scanning its own skill directories). The fields
   * are the HOST's to act on, and on three backends the host reads them off
   * `AgentEventExecutionResult` after `emitAutomationEvent`. Claude never calls
   * that, so the band arrived and was dropped.
   *
   * This is the seam that hands it over, on the same object those three
   * backends read, before the SDK translation discards it. Registered by the
   * backend rather than by construction because it closes over the AGENT, which
   * does not exist when the automation system is built; unregistered leaves the
   * old behaviour byte for byte.
   *
   * NO gate is re-derived here, deliberately. `executePluginHookAutomations`
   * already applies `hooks.md`'s SessionStart `source` gate to the decision it
   * returns — "before any consumer — or any merge with another scope's result —
   * can read the field" — which is exactly the guarantee `applyHookSessionDirectives`
   * says it depends on. A second application at this seam would be two answers
   * to one question, which is the shape this file warns about in three other
   * places.
   */
  private hookSessionDirectiveSink?: HookSessionDirectiveSink;

  /** See {@link hookSessionDirectiveSink}. Pass `undefined` to unregister. */
  setSessionDirectiveSink(sink: HookSessionDirectiveSink | undefined): void {
    this.hookSessionDirectiveSink = sink;
  }

  /**
   * Read LIVE at dispatch, never captured: `buildSdkHooks()` runs when a query's
   * options are assembled and the sink is registered by the backend around the
   * same moment, so a captured value could be the one from before registration.
   */
  private deliverHookSessionDirectives(decision: PreToolUseDecision | undefined): void | Promise<void> {
    if (!decision) return;
    return this.hookSessionDirectiveSink?.(decision);
  }

  buildSdkHooks(options?: SdkHooksBuildOptions): Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> {
    const sessionDirectiveSink: HookSessionDirectiveSink = decision => this.deliverHookSessionDirectives(decision);
    const merged = mergeSdkHooks(
      this.nativeSystem?.buildSdkHooks?.(options) ?? {},
      // D1.343 — the SDK route declares the same tiers as `executeAgentEventInner`
      // above, because it reaches the SAME injected command runner. A tier
      // declared on one route and not on the other would mean a hook running
      // unasked on Pi and asking on claude, which is the silent-divergence class.
      this.userGlobalHookConfig ? buildSdkHooksForConfig(this.userGlobalHookConfig, {
        workspaceRootPath: this.workspaceRootPath,
        ...(this.workingDir ? { workingDir: this.workingDir } : {}),
        ...this.pluginRunnerOptions(),
        hookSource: 'user',
        sessionDirectiveSink, hookRunSink: options?.onHookRun,
      }) : {},
      this.workspaceHookConfig ? buildSdkHooksForConfig(this.workspaceHookConfig, {
        workspaceRootPath: this.workspaceRootPath,
        ...(this.workingDir ? { workingDir: this.workingDir } : {}),
        ...this.pluginRunnerOptions(),
        // D1.429 — its OWN tier. This field had no production setter and was
        // attributed `user` so the two could not answer differently "if one
        // ever appears"; `buildPinnedAgentAutomationSystem` now sets it, and
        // `<workspaceRoot>/automations.json` is a file the model can write
        // through `automation_create`, so the answer is `workspace`.
        hookSource: 'workspace',
        sessionDirectiveSink, hookRunSink: options?.onHookRun,
      }) : {},
      this.projectHookConfig ? buildSdkHooksForConfig(this.projectHookConfig, {
        workspaceRootPath: this.workspaceRootPath,
        ...(this.workingDir ? { workingDir: this.workingDir } : {}),
        ...this.pluginRunnerOptions(),
        hookSource: 'project',
        sessionDirectiveSink, hookRunSink: options?.onHookRun,
      }) : {},
      buildSdkHooksForConfig(this.pluginHookConfig, {
        workspaceRootPath: this.workspaceRootPath,
        ...(this.workingDir ? { workingDir: this.workingDir } : {}),
        ...this.pluginRunnerOptions(),
        pluginRuntime: true,
        hookSource: 'plugin',
        sessionDirectiveSink, hookRunSink: options?.onHookRun,
      }),
      this.buildComponentSdkHooks(options?.onHookRun),
    );
    for (const matchers of Object.values(merged)) {
      for (const matcher of matchers ?? []) {
        matcher.hooks = matcher.hooks.map(callback => async (...args) => {
          this.assertActive();
          await this.verifyPluginIntegrity();
          this.assertActive();
          const result = await callback(...args);
          this.assertActive();
          return result;
        });
      }
    }
    return merged;
  }

  /**
   * P6.59 — the component layer on the SDK path.
   *
   * `buildSdkHooks` is the ONLY dispatch route for every event but `PreToolUse`
   * on the anthropic backend (`mergeClaudeSdkHooks` drops the trusted
   * `PreToolUse` bucket so that event runs through
   * `runClaudePreToolUseHookPipeline` → `executeAgentEvent` instead). Until this
   * method the route consulted the four CONFIG tiers and never the component
   * layer, so a skill's own frontmatter hooks were unreachable on that backend
   * even once the layer was wired — the second half of the defect the row names.
   *
   * The layer has no config to translate, so the shape is inverted from
   * `buildSdkHooksForConfig`: one matcher per event with NO `matcher` pattern
   * (the layer's own configs carry theirs, and `executePluginHookAutomations`
   * applies them), and the callback re-resolves the layer at DISPATCH, so the
   * `once` tier, its consumption, and a skill that became active or finished
   * since the build all behave exactly as they do on the direct chain — one
   * executor, as `hooks.md` § *Hooks in skills and agents* requires ("the same
   * configuration format as settings-based hooks").
   *
   * What IS a snapshot is the EVENT KEY SET, because SDK hooks are registered
   * per event before the query starts. On the anthropic backend that snapshot is
   * exact rather than best-effort: a model-invoked skill ends the pass
   * (`BaseAgent.buildModelSkillContinuation`) and the next pass builds fresh
   * options, so a skill is registered for every pass in which it is active.
   *
   * No `timeout`: the config path derives one from a command action's
   * `timeoutMs`, and the layer's actions are not known until dispatch. The SDK
   * default applies, and each action's own timeout is still honoured by the
   * command runner.
   */
  private buildComponentSdkHooks(onHookRun?: SdkHooksBuildOptions['onHookRun']): Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> {
    const layer = this.componentHookLayer?.();
    if (!layer) return {};
    const sdkHooks: Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> = {};
    for (const event of AGENT_EVENTS) {
      if (!layer.hasMatchers(event)) continue;
      sdkHooks[event] = [{
        hooks: [async (input, toolUseId, callbackOptions) => {
          const enrichedInput: SdkAutomationInput = {
            ...input,
            hook_event_name: input.hook_event_name ?? event,
            ...(input.tool_use_id ? {} : { tool_use_id: toolUseId }),
          };
          const result = await this.executeComponentHookLayer(event, enrichedInput, {
            workspaceRootPath: this.workspaceRootPath,
            ...(this.workingDir ? { workingDir: this.workingDir } : {}),
            ...(callbackOptions.signal ? { signal: callbackOptions.signal } : {}),
          });
          // C4.12 / F1.223 — a fifth tier on the same route: the same band, the same runs.
          await this.deliverHookSessionDirectives(result.decision);
          onHookRun?.(result);
          return automationResultToSdkHookResult(event, result);
        }],
      }];
    }
    return sdkHooks;
  }

  /**
   * R32. Exactly the configs `executeAgentEventInner` below consults, in the
   * same order — a "yes" here must mean "something would actually run", not
   * "something is declared somewhere". D1.429 added `workspaceHookConfig`: it
   * used to feed `buildSdkHooks` alone, and its matchers now reach the direct
   * path as their own tier rather than folded into the user tier's bucket.
   */
  hasAgentEventMatchers(event: AgentEvent): boolean {
    if (this.nativeSystem?.hasAgentEventMatchers?.(event)) return true;
    for (const config of [this.userGlobalHookConfig, this.workspaceHookConfig, this.projectHookConfig, this.pluginHookConfig]) {
      if ((config?.automations[event]?.length ?? 0) > 0) return true;
    }
    // R87 — the component layer is dynamic, so it is asked live rather than read
    // off a captured config, the same as `executeAgentEventInner` below.
    if (this.componentHookLayer?.()?.hasMatchers(event)) return true;
    return false;
  }

  async executeAgentEvent(event: AgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<AgentEventExecutionResult> {
    try {
      return await this.executeAgentEventInner(event, input, signal);
    } finally {
      // The spinner label a hook set is transient by contract — "displayed
      // while the hook runs" — so the end of the event clears it whether the
      // hooks succeeded, blocked, or threw.
      this.hookStatusReporter?.(undefined);
    }
  }

  private async executeAgentEventInner(event: AgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<AgentEventExecutionResult> {
    this.assertActive();
    const nativeResult = await this.nativeSystem?.executeAgentEvent(event, input, signal);
    const options = {
      workspaceRootPath: this.workspaceRootPath,
      ...(this.workingDir ? { workingDir: this.workingDir } : {}),
      ...(signal ? { signal } : {}),
    };
    // D1.343 — each tier declares itself to the injected runner; `hookSource` is
    // what carries that past the merge. D1.429 added `workspace`, dispatched
    // here for the first time: it used to arrive folded into
    // `userGlobalHookConfig` and so ran with the OPERATOR's pre-authorisation,
    // on the very file `automation_create` writes.
    const userGlobalResult = this.userGlobalHookConfig
      ? await executePluginHookAutomations(this.userGlobalHookConfig, event, input, { ...options, ...this.pluginRunnerOptions(), hookSource: 'user' })
      : { matchedCount: 0 };
    const workspaceResult = this.workspaceHookConfig
      ? await executePluginHookAutomations(this.workspaceHookConfig, event, input, { ...options, ...this.pluginRunnerOptions(), hookSource: 'workspace' })
      : { matchedCount: 0 };
    const projectResult = this.projectHookConfig
      ? await executePluginHookAutomations(this.projectHookConfig, event, input, { ...options, ...this.pluginRunnerOptions(), hookSource: 'project' })
      : { matchedCount: 0 };
    await this.verifyPluginIntegrity();
    this.assertActive();
    const pluginResult = await executePluginHookAutomations(this.pluginHookConfig, event, input, {
      ...options,
      ...this.pluginRunnerOptions(),
      pluginRuntime: true,
      hookSource: 'plugin',
    });
    // R87 — component-scoped (skill frontmatter) hooks are folded LAST, the
    // narrowest scope. Position is deliberate: `mergePreToolUseDecisionObjects`
    // is last-writer-wins for advisory fields, so a hook the author scoped to
    // exactly one active skill gets the final say on `additionalContext` /
    // `updatedInput`, while a `deny`/`block` from any broader tier still
    // outranks a narrower `allow` regardless of order (block outranks). The
    // layer is read live here, not captured, so a skill invoked mid-turn is
    // seen and one that finished is gone. The `once` tier is dispatched
    // separately so its consumption is tied to whether IT matched, never to a
    // sibling always-on hook matching the same event.
    const componentResult = await this.executeComponentHookLayer(event, input, options);
    // D1.429 — the SAME left fold the four nested calls performed, with the new
    // tier in it, written as the list it is so the ORDER is readable: the
    // native system first, then the operator's own settings, then `workspace`,
    // then the repository's, then plugins, then components — broadest scope to
    // narrowest. The order is load-bearing, because
    // `mergePreToolUseDecisionObjects` is last-writer-wins for advisory fields
    // (a `deny`/`block` from any broader tier still outranks a narrower
    // `allow`), so it is stated here rather than traced through five brackets.
    const result = [userGlobalResult, workspaceResult, projectResult, pluginResult, componentResult]
      .reduce((merged, next) => mergeExecutionResults(merged, next), nativeResult ?? { matchedCount: 0 });
    this.assertActive();
    return result;
  }

  /**
   * Dispatch the active components' frontmatter hooks for one event (R87).
   * `hooks.md` § Hooks in skills and agents: component hooks "use the same
   * configuration format as settings-based hooks", so each tier runs through
   * the SAME `executePluginHookAutomations` and command runner as every other
   * tier — no second executor.
   */
  private async executeComponentHookLayer(
    event: AgentEvent,
    input: SdkAutomationInput,
    options: { workspaceRootPath: string; workingDir?: string; signal?: AbortSignal },
  ): Promise<AgentEventExecutionResult> {
    const layer = this.componentHookLayer?.();
    if (!layer) return { matchedCount: 0 };
    const runnerOptions = {
      ...options,
      ...this.pluginRunnerOptions(),
      // D1.343 — its own tier, not `user`. A component hook rides a SKILL or an
      // AGENT file, and those are as often a plugin's as the user's own; the
      // layer is resolved fresh per dispatch and carries no resource scope, so
      // this is the honest answer rather than the convenient one.
      hookSource: 'component' as const,
    };
    let result: AgentEventExecutionResult = { matchedCount: 0 };
    // R87b — the dispatch input is handed to the layer so a subagent-scoped
    // entry can answer for THIS event's `agent_id` and not for a sibling's.
    const always = layer.matchersFor(event, input);
    if (always) {
      result = mergeExecutionResults(result, await executePluginHookAutomations(always, event, input, runnerOptions));
    }
    const once = layer.onceMatchersFor(event, input);
    if (once) {
      const onceResult = await executePluginHookAutomations(once, event, input, runnerOptions);
      result = mergeExecutionResults(result, onceResult);
      // `hooks.md` §Common fields, `once`, VERBATIM: "If `true`, Claude Code
      // removes the hook after its first successful run. A run that fails,
      // blocks with exit code 2, or times out leaves the hook in place, so it
      // runs again on the next matching event."
      //
      // Two conditions, and only the first was here. MATCHING is not RUNNING:
      // a hook that matched and then exited non-zero, exited 2 or timed out was
      // deleted anyway — a LOOSENING divergence, in the direction that silently
      // disarms the hook the user wrote to guard something. `hookRunFailed` is
      // the second condition, and it is deliberately not "the result carries a
      // block": a hook that printed `decision: block` on a successful exit did
      // its job, and the page's non-consuming set is about the RUN.
      if (onceResult.matchedCount > 0 && !onceResult.hookRunFailed) layer.consumeOnce(event);
    }
    return result;
  }
}

/**
 * D6 — which platform's documented hook budgets a plugin's hooks are read
 * under. The selector is the normalized runtime-compatibility profile and
 * nothing else, for the same reason `pluginRuntimeEnvForProfile` uses it: two
 * manifests that differ only in adapter or origin but declare the same profile
 * are runtime-identical, so adapterId/format must never decide this.
 *
 * Anything that is not the Codex profile reads as `claude`, the stricter of the
 * two budgets — an unprofiled or generic plugin cannot buy itself a longer
 * SessionEnd window by declaring nothing.
 */
export function importedHookDialectForProfile(
  profile: PluginRuntimeCompatibilityProfile | undefined,
): ImportedHookDialect {
  return profile === 'codex-plugin-env-v1' ? 'codex' : 'claude';
}

/**
 * C3.301 — turn one finished background run into the notes the page promises,
 * and hand them to the host's out-of-band sink.
 *
 * ## The two sinks, and why the `kind` is decided HERE
 *
 * `hooks.md#limitations`, verbatim: *"Hook output is delivered on the next
 * conversation turn. If the session is idle, the response waits until the next
 * user interaction. Exception: an `asyncRewake` hook that exits with code 2
 * wakes Claude immediately even when the session is idle."* So the rule is one
 * sentence and the exception is one sentence, and the only input that separates
 * them is the action's `asyncRewake` plus the exit code — both of which exist
 * only here. The host receives `kind` and applies its own idle/busy discipline;
 * it has no business re-deriving a page rule from an exit code.
 *
 * ## Why the REWAKE note is not also a delivery
 *
 * The rewake sentence names its own payload — *"The hook's stderr, or stdout if
 * stderr is empty, is shown to Claude as a system reminder"* — which is the raw
 * output of a FAILING run, not a JSON field. A hook that exits 2 has, by the
 * three-way contract, not produced a parseable success response, so emitting
 * both would deliver the same bytes twice under two framings.
 *
 * ## Parsing
 *
 * The SAME parsers the synchronous branch uses, which is what
 * `hooks.md#how-async-hooks-execute` asks for — *"Claude Code validates that
 * JSON response against the same output schema as synchronous hooks, and drops
 * any field whose value has the wrong type"*. `parseHookCommandOutput` already
 * applies the redaction and the field limit; the rewake text is raw stderr, so
 * it is redacted here and capped through {@link capHookRegistryText}, the same
 * cap every other host-side hook text uses.
 *
 * NOT parsed for a decision, deliberately: `hooks.md` says a background hook's
 * output *"is not parsed for a decision"*, and the event it belongs to has long
 * since been answered. Only `additionalContext` and `systemMessage` travel.
 */
function emitAsyncHookNotes(
  emit: PluginAsyncHookNoteEmitter | undefined,
  action: HookCommandAction,
  hookName: string,
  event: AgentEvent,
  result: HookCommandActionResult,
): void {
  if (!emit) return;
  const push = (kind: PluginAsyncHookNote['kind'], text: string | undefined): void => {
    const trimmed = text?.trim();
    if (!trimmed) return;
    emit({ kind, hookName, event, text: trimmed });
  };
  // The exception first, because it is exclusive: exit 2 on an `asyncRewake`
  // hook is the wake, and its payload is the run's own output.
  if (action.asyncRewake === true && result.exitCode === 2) {
    const raw = (result.stderr?.trim() ? result.stderr : result.stdout) ?? '';
    push('rewake', capHookRegistryText(redactHookOutput(raw)));
    return;
  }
  const stdout = result.stdout ?? '';
  // UB12.101 — a Claude-contract hook's context comes from the fired event's
  // own `hookSpecificOutput` only, as on the synchronous branch; the CLI's
  // async reader strips a top-level `additionalContext` the same way.
  push('delivery', parseHookCommandOutput(stdout, { event, claudeContract: action.blockOnNonZero === false })?.additionalContext);
  push('delivery', parseHookOutputForEvent(stdout, event).universal?.systemMessage);
}

export async function executePluginHookAutomations(
  config: AutomationsConfig,
  event: AgentEvent,
  input: SdkAutomationInput,
  options: {
    workspaceRootPath: string;
    workingDir?: string;
    signal?: AbortSignal;
    /** Host-injected execution authority. Without one, commands fail closed. */
    runner?: CommandHookRunner;
    /**
     * Judges prompt hooks with a fast model (R22). When absent, prompt hooks
     * keep the observational additionalContext behaviour — the no-new-ambient-
     * authority rule.
     */
    promptRunner?: PluginPromptHookRunner;
    /**
     * Spawns agent-hook sub-agents through the child-session/subagent service.
     * When absent, agent hooks match but are inert (no spawn, no decision).
     */
    agentRunner?: PluginAgentHookRunner;
    /**
     * Invokes mcp_tool-hook tools through the existing MCP pool. When absent,
     * mcp hooks match but are inert (no invocation).
     */
    mcpToolRunner?: PluginMcpToolHookRunner;
    /**
     * Fires http-hook requests through the existing webhook executor. Presence
     * IS the network permission grant; when absent the request never fires.
     */
    httpRunner?: PluginHttpHookRunner;
    /** Host-owned provenance bit: only the normalized plugin config sets it. */
    pluginRuntime?: boolean;
    /**
     * D1.343 — the declaring tier, handed to the injected runner unchanged.
     *
     * Separate from {@link pluginRuntime}, which selects the external hook
     * DIALECT (tool-name compatibility, `NESSY_PLUGIN_DATA`) and answers only
     * "plugin or not". The host's permission question has four answers, and the
     * project tier — a settings file the repository owns — is the one the two
     * would have conflated.
     */
    hookSource?: CommandHookSource;
    /** Explicit non-Pi legacy opt-in; absence makes command actions inert/blocking. */
    allowDirectCommandRunner?: boolean;
    /**
     * hooks.md § Common fields, `statusMessage`: "Custom spinner message
     * displayed while the hook runs." Called with the label before the matched
     * hooks run and with `undefined` when they finish; without a reporter the
     * label is carried and never shown, which is what it did before.
     */
    statusReporter?: PluginHookStatusReporter;
    /**
     * C3.301 — the out-of-band sink a finished background hook's output reaches.
     * Absent = the `async` branch below discards the run, which is what it did
     * on every runtime until this row.
     */
    asyncNoteEmitter?: PluginAsyncHookNoteEmitter;
  },
): Promise<AgentEventExecutionResult> {
  const matchers = config.automations[event];
  if (!matchers?.length) return { matchedCount: 0 };

  let matchedCount = 0;
  let decision: PreToolUseDecision | undefined;
  let universal: HookUniversalOutput | undefined;
  const hookErrors: HookErrorNotice[] = [];
  // P6.292 — did any hook fail to RUN? Counted separately from `hookErrors`
  // because a failure the event turned into a block deliberately produces no
  // notice, and `once` consumption must still see it.
  let hookRunFailed = false;
  // D1.354 — every hook this dispatch RAN, successes included; plus F1.232/F1.270's not-ran rows (F1.449).
  //
  // P6.828 built this list, and built it on `AutomationSystem.executeAgentEvent`,
  // which D1.351 then measured as having no production caller at all. So the
  // host arm of the run history had exactly one producer and that producer never
  // ran: `base-agent.ts`'s `emitAutomationEvent` read `result.hookRuns` and saw
  // `undefined` on every session, on all three runtimes, and fell back to the
  // notice list — which is silent on success by construction. THIS executor is
  // the whole production agent-event path (`PluginScopedAutomationSystem` calls
  // it once per tier), so the observation is built here, at the run site, from
  // the result object each runner hands back.
  //
  // F1.9 (D1.365) closed the residue D1.354 stated here. The reader PREFERS this
  // list, so a non-command failure that was only a `hookErrors` notice vanished
  // from `HookRunStore` on any event that also ran a command hook. Now a prompt
  // (with a judge), agent, mcp_tool or http run is observed where its result is
  // in hand, and every notice raised BEFORE the consume phase (a hook with no
  // runner, a refused http request, an unparseable `if`) joins the list through
  // `withObservedPreRunNotices`; F1.232 observes the command loop's one notice.
  const hookRuns: HookRunObservation[] = [];
  // The matcher NAME travels with the action: it is the `<hook name>` half of
  // the documented `<hook name> hook error` notice and is otherwise lost when
  // the actions are flattened out of their matchers.
  const commandActions: Array<{ action: HookCommandAction; hookName: string; ifFailedOpen?: boolean }> = [];
  // P6.12 — prompt and agent actions carry their matcher name for the same
  // reason the two below already do: an absent runner is reported through the
  // `<hook name> hook error` notice, and the name is otherwise lost when the
  // actions are flattened out of their matchers.
  const promptActions: Array<{ action: PluginPromptHookAction; hookName: string }> = [];
  const agentActions: Array<{ action: PluginAgentHookAction; hookName: string }> = [];
  // The two DECIDING non-command types carry their matcher name for the same
  // reason command hooks do: it is the `<hook name>` half of the documented
  // `<hook name> hook error` notice their non-blocking failures produce.
  const mcpToolActions: Array<{ action: PluginMcpToolHookAction; hookName: string; ifFailedOpen?: boolean }> = [];
  const httpActions: Array<{ action: PluginHttpHookAction; hookName: string; ifFailedOpen?: boolean }> = [];

  for (const matcher of matchers) {
    if (!pluginMatcherMatches(matcher, event, input, options.pluginRuntime)) continue;
    // P2.277 — the `if` filter's fail-open is DELIBERATE (hooks.md § Hook
    // handler fields: "Because the `if` filter is best-effort, use the
    // permission system rather than a hook to enforce a hard allow or deny"),
    // so a rule that will not compile must keep running its hook. What was not
    // deliberate is the SILENCE: `evaluateClaudeHookIfFilter` has computed
    // `unparseableRule` since `147dbfa2` and every caller read `.run` and threw
    // the flag away, so a hook whose condition never compiled ran on every tool
    // call with no trace anywhere. The direction is unchanged; the diagnostic
    // is restored (the registration-time `if_unparseable_fail_open` report that
    // used to carry it retired with the V1 bridge in F4).
    let ifRuleUnparseable = false;
    if (matcher.ifRule) {
      const ifFilter = hookIfFilterRuns(matcher, event, input, options);
      if (!ifFilter.run) continue;
      ifRuleUnparseable = ifFilter.unparseableRule;
    }
    matchedCount++;
    const hookName = automationHookName(matcher, { event, ...(input.tool_name ? { toolName: input.tool_name } : {}) }); // F1.875
    if (ifRuleUnparseable) reportUnparseableIfRule(hookErrors, matcher, hookName, event);
    for (const action of matcher.actions) {
      // hooks.md § Prompt-based hooks: the per-event support matrix, enforced
      // at dispatch as well as at registration so a config that reached this
      // point without the registration gate (stored, runtime-projected, or
      // pre-gate) is inert rather than executed on an unsupported event.
      if (action.type === 'command') commandActions.push({ action, hookName, ifFailedOpen: ifRuleUnparseable });
      else if (action.type === 'plugin-prompt' && hookTypeSupportedForEvent(event, 'prompt')) promptActions.push({ action, hookName });
      else if (action.type === 'plugin-agent' && hookTypeSupportedForEvent(event, 'agent')) agentActions.push({ action, hookName });
      else if (action.type === 'plugin-mcp-tool' && hookTypeSupportedForEvent(event, 'mcp')) mcpToolActions.push({ action, hookName, ifFailedOpen: ifRuleUnparseable });
      else if ((action.type === 'plugin-http' || action.type === 'webhook') && hookTypeSupportedForEvent(event, 'http')) httpActions.push({ action: action.type === 'webhook' ? webhookAsHttpHookAction(action) : action, hookName, ifFailedOpen: ifRuleUnparseable }); // F1.786: a native webhook IS an http hook, see webhookAsHttpHookAction
      else if (action.type === 'decision') {
        // R9: which decision fields survive is the EVENT's documented contract,
        // not a hardcoded PreToolUse test. `projectHookDecisionForEvent` drops
        // anything outside the event's pattern, so an event can neither gain a
        // decision the docs withhold nor lose one they grant.
        const projected = projectHookDecisionForEvent(event, toPreToolUseDecision(action));
        if (projected) {
          decision = mergePreToolUseDecisions(decision, { type: 'decision', ...dropFailedOpenWidening(projected, ifRuleUnparseable) });
        }
      }
    }
  }

  // hooks.md: the spinner label belongs to a hook that is ABOUT to run, so it
  // is reported after matching (a hook filtered out by its matcher or its `if`
  // must not relabel the spinner) and before the first runner is entered. With
  // several matched hooks the first declared label wins; concatenating labels
  // from unrelated plugins would be noise, the same rule `mergeHookUniversalOutputs`
  // applies to `systemMessage`. The clear is the caller's — see
  // `executeAgentEvent`, which owns the end of the event.
  const statusMessage = [
    ...commandActions.map(entry => entry.action.statusMessage),
    ...promptActions.map(entry => entry.action.statusMessage),
    ...agentActions.map(entry => entry.action.statusMessage),
    ...mcpToolActions.map(entry => entry.action.statusMessage),
    ...httpActions.map(entry => entry.action.statusMessage),
  ].find(label => !!label?.trim());
  if (statusMessage) options.statusReporter?.(statusMessage);

  // hooks.md: "All matching hooks run in parallel, and identical handlers are
  // deduplicated automatically. Command hooks are deduplicated by command
  // string and `args`, and HTTP hooks are deduplicated by URL." Dedup runs per
  // event dispatch, BEFORE execution, on the documented keys for command/http;
  // prompt/agent/mcp handlers have no documented key, so "identical" is their
  // own identity fields. First registration wins, keeping every
  // ordering-sensitive merge unchanged.
  const uniquePromptActions = dedupeHookEntries(promptActions, entry => JSON.stringify([entry.action.prompt, entry.action.model ?? null]));
  const uniqueAgentActions = dedupeHookEntries(agentActions, entry => entry.action.agentName);
  const uniqueMcpToolActions = dedupeHookEntries(mcpToolActions, entry => JSON.stringify([entry.action.mcpTool, entry.action.mcpArgs ?? null]));
  const uniqueHttpActions = dedupeHookEntries(httpActions, entry => entry.action.http.url);
  const uniqueCommandActions = dedupeHookEntries(commandActions, entry => commandHookDedupKey(entry.action));

  // The parallel half of the sentence: every runner STARTS before any result is
  // consumed, and the results are then reduced in registration order, so the
  // decision merge stays byte-identical to the sequential code this replaces
  // (block stickiness, last-reason-wins, additionalContext concatenation order).
  // Rejections are captured per run and rethrown at the consume site in the
  // same order the sequential `await`s would have surfaced them.
  const captureRun = <T,>(promise: Promise<T>): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }> =>
    promise.then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));

  // Prompt hooks. With an injected decision runner (R22, hooks.md) the body is
  // judged by a fast model and `ok:false` merges as a blocking decision. On
  // PermissionRequest the documented behaviour is "their output is discarded",
  // so the runner is never consulted there. Without a runner — exactly the B1
  // observational one-shot additionalContext injection, nothing widens.
  // `runBoundedPromptHook` never rejects, so no capture is needed here.
  const promptRuns: Array<{ action: PluginPromptHookAction; hookName: string; verdict?: Promise<{ ok: boolean; reason?: string } | undefined> }> = [];
  for (const { action, hookName } of uniquePromptActions) {
    if (!action.prompt.trim() || action.prompt.length > MAX_PLUGIN_HOOK_CONTEXT_CHARS) continue;
    if (options.promptRunner && event !== 'PermissionRequest') {
      if (options.signal?.aborted) continue;
      promptRuns.push({ action, hookName, verdict: runBoundedPromptHook(options.promptRunner, action, event, input, options.signal) });
      continue;
    }
    // P6.12 — on `PermissionRequest` the fallback IS the documented behaviour
    // ("their output is discarded"), so it is not a degradation and is not
    // reported. Anywhere else, a missing judge silently turns a hook that can
    // BLOCK into one that can only add context.
    if (event !== 'PermissionRequest') {
      reportHookRunnerUnavailable(hookErrors, action, hookName, event, 'prompt');
    }
    promptRuns.push({ action, hookName });
  }

  // B1 agent hooks: spawn the declared sub-agent through the injected runner —
  // observational, its result is never a decision. D6/D8: mcp_tool hooks invoke
  // the declared tool through the injected pool runner and http hooks fire ONLY
  // when the network runner is present (the explicit permission grant — denial
  // has no side effect); both now ANSWER, and their answer is merged through
  // the command runner's decision path in the consume phase below.
  //
  // UB12.67 — an http hook that never STARTED (a guard refused it, or no runner
  // is injected) is a "can't start" failure for `onFailure: "block"`; its block
  // is merged in the consume phase, where the started ones' are.
  const httpNotStarted: Array<{ hookName: string; cause: string }> = [];
  const noteHttpNotStarted = (entry: { action: PluginHttpHookAction; hookName: string }, cause: string): void => {
    if (onFailureBlocks(entry.action, event, options.signal)) httpNotStarted.push({ hookName: entry.hookName, cause });
  };
  const agentRuns = options.agentRunner
    ? uniqueAgentActions
        .filter(entry => !options.signal?.aborted && entry.action.agentName.trim())
        .map(entry => ({ hookName: entry.hookName, run: captureRun(options.agentRunner!({
          agentName: entry.action.agentName,
          event,
          ...(options.signal ? { signal: options.signal } : {}), ...pluginHookRunnerTimeout(entry.action),
        })) }))
    : reportMissingRunner(hookErrors, uniqueAgentActions, event, 'agent');
  const mcpToolRuns = options.mcpToolRunner
    ? uniqueMcpToolActions
        .filter(entry => !options.signal?.aborted && isQualifiedPluginMcpProxyName(entry.action.mcpTool))
        .map(entry => ({
          kind: 'mcp_tool' as const,
          action: entry.action,
          hookName: entry.hookName,
          ifFailedOpen: entry.ifFailedOpen,
          onFailureBlock: false, // UB12.67 — hooks.md gives `onFailure` to command and http hooks only
          run: captureRun(options.mcpToolRunner!({
            proxyName: entry.action.mcpTool,
            args: entry.action.mcpArgs ?? {},
            event,
            ...(options.signal ? { signal: options.signal } : {}), ...pluginHookRunnerTimeout(entry.action),
          })),
        }))
    : reportMissingRunner(hookErrors, uniqueMcpToolActions, event, 'mcp');
  const httpRuns = options.httpRunner
    ? uniqueHttpActions.map(entry => ({ ...entry, http: httpHookRequestDescriptor(entry.action, event, input) })) // UB12.52: expanded BEFORE the guards
        // P3.231 · ONE PREDICATE PAST WHAT P6.12 MADE LEGIBLE. That row gave the
        // ABSENT-RUNNER case a voice; a hook refused by one of the two guards
        // below was still dropped by a silent `.filter`, so an operator whose
        // `type: "http"` hook carried an `Authorization` header, an `auth` key,
        // credentials in the query string, or an `ftp:`/`file:` URL saw exactly
        // what an operator with no hook at all sees. Same channel as P6.12
        // (`hookErrors` → transcript warning + debug detail), same per-action
        // dedupe, because a `PreToolUse` hook fires on every tool call and one
        // bubble per call is noise rather than a diagnostic.
        //
        // The abort check keeps its silence deliberately: a cancelled turn is
        // not a refused hook, and it has its own surface.
        .filter(entry => {
          if (options.signal?.aborted) return false;
          if (!isSafePluginHookHttpUrl(entry.http.url)) {
            reportRefusedHttpHook(hookErrors, entry.action, entry.hookName, event, 'unsafe-url');
            noteHttpNotStarted(entry, REFUSED_HTTP_HOOK_NOTICES['unsafe-url'].summary);
            return false;
          }
          if (isCredentialBearingPluginHttpDescriptor(entry.http)) {
            reportRefusedHttpHook(hookErrors, entry.action, entry.hookName, event, 'credential-bearing');
            noteHttpNotStarted(entry, REFUSED_HTTP_HOOK_NOTICES['credential-bearing'].summary);
            return false;
          }
          return true;
        })
        .map(entry => ({
          kind: 'http' as const,
          action: entry.action,
          hookName: entry.hookName,
          ifFailedOpen: entry.ifFailedOpen,
          onFailureBlock: onFailureBlocks(entry.action, event, options.signal),
          run: captureRun(options.httpRunner!({
            http: entry.http,
            event,
            ...(options.signal ? { signal: options.signal } : {}), ...pluginHookRunnerTimeout(entry.action),
          })),
        }))
    : (uniqueHttpActions.forEach(entry => noteHttpNotStarted(entry, MISSING_HOOK_RUNNER_NOTICES.http.summary)),
      reportMissingRunner(hookErrors, uniqueHttpActions, event, 'http'));

  const runner = options.runner ?? (options.allowDirectCommandRunner ? runHookCommand : undefined);
  const runCommand = (action: HookCommandAction) => runner!(action, {
    event,
    input: claudeContractHookInput(action, event, externalHookInput(action, input, options.pluginRuntime)),
    cwd: options.workingDir ?? options.workspaceRootPath,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.pluginRuntime && action.env?.NESSY_PLUGIN_DATA
      ? { pluginDataPath: action.env.NESSY_PLUGIN_DATA }
      : {}),
    // D1.343 — passed through rather than derived from `pluginDataPath`: that
    // field is present only when a plugin hook also carries
    // `NESSY_PLUGIN_DATA`, so a plugin hook without one would read as the
    // user's own. An absent source stays absent and the host fails closed.
    ...(options.hookSource ? { hookSource: options.hookSource } : {}),
  });
  const commandRuns: Array<{
    action: HookCommandAction;
    hookName: string;
    ifFailedOpen?: boolean;
    result?: Promise<{ status: 'fulfilled'; value: HookCommandActionResult } | { status: 'rejected'; reason: unknown }>;
  }> = [];
  for (const { action, hookName, ifFailedOpen } of uniqueCommandActions) {
    if (!runner) {
      // Fail-closed handling stays in the merge phase below.
      commandRuns.push({ action, hookName, ifFailedOpen });
      continue;
    }
    if (action.async) {
      // hooks.md: async command hooks run in the background without blocking and
      // their output is not parsed for a DECISION. On blocking events the hook
      // still runs but can never block — the documented effect of not waiting.
      //
      // C3.301 — "not parsed for a decision" is not "discarded". This branch was
      // `void runCommand(action).catch(() => {})`, which threw away the run AND
      // its failure, so two documented deliveries never happened:
      //
      //  - `hooks.md#how-async-hooks-execute`: *"After the background process
      //    exits, Claude Code delivers the `additionalContext` and
      //    `systemMessage` fields from the hook's JSON response to Claude on the
      //    next conversation turn. Unlike a synchronous hook's `systemMessage`,
      //    neither field is shown to you."*
      //  - `hooks.md#command-hook-fields`, `asyncRewake`: *"If `true`, runs in
      //    the background and wakes Claude on exit code 2. The hook's stderr, or
      //    stdout if stderr is empty, is shown to Claude as a system reminder so
      //    it can react to a long-running background failure"*.
      //
      // The two are ONE seam and two sinks, and which sink is the whole meaning
      // of `asyncRewake` — `hooks.md#limitations`: *"Hook output is delivered on
      // the next conversation turn. If the session is idle, the response waits
      // until the next user interaction. Exception: an `asyncRewake` hook that
      // exits with code 2 wakes Claude immediately even when the session is
      // idle."* So the note carries its `kind` and the HOST decides where it
      // lands; this module has no session to reach.
      //
      // Still fire-and-forget, and still swallowing: an emitter is optional and
      // a background failure is non-blocking by contract, so nothing here may
      // throw into the event that started it.
      const asyncAction = action;
      const asyncHookName = hookName;
      void runCommand(asyncAction)
        .then(result => { emitAsyncHookNotes(options.asyncNoteEmitter, asyncAction, asyncHookName, event, result); })
        .catch(() => { /* background failure is non-blocking by contract */ });
      continue;
    }
    commandRuns.push({ action, hookName, ifFailedOpen, result: captureRun(runCommand(action)) });
  }

  const preRunNoticeCount = hookErrors.length; // ---- consume phase: registration order, prompt → agent/mcp/http → command.
  for (const { action, hookName, verdict: verdictPromise } of promptRuns) {
    if (verdictPromise) {
      const verdict = await observedPromptVerdict(hookRuns, hookName, event, verdictPromise);
      if (verdict && verdict.ok === false) {
        // R9: a prompt hook's block travels through the SAME decision-contract
        // gate as a command hook's parsed output. On an event whose documented
        // surface carries no decision (`projectHookDecisionForEvent` drops it),
        // the verdict is inert — the prompt branch used to bypass this and mint
        // blocks on no-decision events. One gate, all branches.
        const projected = projectHookDecisionForEvent(event, {
          decision: 'block',
          reason: verdict.reason ?? 'Prompt hook blocked this event.',
        });
        if (projected) {
          decision = mergePreToolUseDecisions(decision, { type: 'decision', ...projected });
          // hooks.md: `continueOnBlock` is "implemented as `continue: true` on the
          // resulting `decision: 'block'`" — the block still happens, it just does
          // not end the turn. R22 stored the field; this is where it takes effect.
          // The three always-terminal events end the turn regardless, which
          // `hookBlockEndsTurn` (not this flag) decides at the emission site.
          if (action.continueOnBlock === true) {
            universal = mergeHookUniversalOutputs(universal, { continue: true });
          } else if (promptHookBlockEndsTurn(event, false) && !hookBlockEndsTurn(event)) {
            // P3.195 — THE OTHER HALF, and the only place it can be written.
            //
            // `hooks.md#response-schema` gives a prompt hook's block a DIFFERENT
            // default from a command hook's on two events: "`PreToolUse`: the
            // tool call is denied; by default the turn ends …", "`PostToolUse`:
            // by default the turn ends …". A command hook's deny on those same
            // two continues (the equivalence quoted on `hookBlockEndsTurn`), so
            // the terminality is a property of the HOOK KIND — and the kind is
            // known here and nowhere downstream, since the translator sees one
            // merged decision with no author on it.
            //
            // Written as the universal `continue: false` rather than a private
            // flag because the page already makes that field authoritative:
            // "Takes precedence over any event-specific decision fields". The
            // `stopReason` is its documented companion — "Message shown to the
            // user when `continue` is `false`" — which is exactly the page's
            // "the reason appears in the chat as a warning line".
            //
            // Guarded on `!hookBlockEndsTurn(event)` so the three always-terminal
            // events keep travelling through their own rule and this branch never
            // becomes a second author of the same answer.
            universal = mergeHookUniversalOutputs(universal, {
              continue: false,
              ...(projected.reason ? { stopReason: projected.reason } : {}),
            });
          }
        }
      }
      continue;
    }
    const observational = projectHookDecisionForEvent(event, { additionalContext: action.prompt });
    if (observational) {
      decision = mergePreToolUseDecisions(
        decision,
        { type: 'decision', ...observational },
      );
    }
  }

  // The runs all started above; their rejections surface here in registration
  // order, exactly where the sequential `await`s used to throw. Agent hooks stay
  // observational; the two that answer are folded in by `applyHookRunnerVerdict`
  // — mcp_tool before http, the order they were registered in.
  for (const { hookName, run } of agentRuns) {
    const outcome = await run;
    hookRuns.push(settledAgentHookRun(outcome, hookName, event));
  }
  for (const { cause } of httpNotStarted) {
    const blocked = onFailureBlockDecision(event, 'http hook', false, cause); // UB12.67
    if (blocked) decision = mergePreToolUseDecisions(decision, blocked);
  }
  for (const { kind, action, hookName, ifFailedOpen, onFailureBlock, run } of [...mcpToolRuns, ...httpRuns]) {
    const outcome = await run;
    if (outcome.status === 'rejected') throw outcome.reason;
    const merged = applyHookRunnerVerdict({
      kind,
      action,
      hookName,
      event,
      verdict: outcome.value,
      decision,
      universal,
      hookErrors,
      ifFailedOpen,
      onFailureBlock,
    });
    ({ decision, universal } = merged);
    hookRuns.push(hookRunnerVerdictRun(kind, hookName, event, outcome.value, action));
  }

  for (const { action, hookName, ifFailedOpen, result: resultPromise } of commandRuns) {
    if (!resultPromise) {
      // Fail-closed is a policy choice, not a decision-surface question: a SYNC
      // PreToolUse hook may be the deny gate, so a missing authority must block;
      // an `async` one never could (hooks.md), so it is a notice (F1.451). On every
      // other event a hook that cannot run leaves the normal path in charge (the
      // prompt still shows, the turn still ends) — so no block is synthesised.
      hookRunFailed = true;
      if (event === 'PreToolUse' && action.async !== true) {
        decision = mergePreToolUseDecisions(decision, {
          type: 'decision', decision: 'block', reason: 'command-hook-execution-authority-unavailable',
        });
        // F1.270 — the block is ALSO observed as its run row, so `/hooks` shows the hook that blocked the tool.
        hookRuns.push(authorityUnavailableBlockRun(hookName, event));
      } else {
        // Same silence the exit-code rows are about: on a non-blocking event a
        // hook that could not run at all left no trace anywhere. It is reported
        // as the documented error notice AND observed as its run row (F1.232);
        // a sync PreToolUse hook above reports itself through its block and row.
        pushObservedAuthorityNotice(hookErrors, hookRuns, {
          hookName,
          event,
          exitCode: null,
          summary: 'command-hook-execution-authority-unavailable',
        });
        // UB12.67 — a hook that cannot start is a failure `onFailure: "block"` turns into exit 2's effect.
        const blocked = onFailureBlocks(action, event, options.signal)
          ? onFailureBlockDecision(event, commandOnFailureLabel(action), false, 'command-hook-execution-authority-unavailable')
          : undefined;
        if (blocked) decision = mergePreToolUseDecisions(decision, blocked);
      }
      continue;
    }
    const settled = await resultPromise;
    if (settled.status === 'rejected') throw settled.reason;
    // UB12.93 — a Claude-contract run that exited other than 0 or 2 after printing JSON is read as exit 0
    // ("the fields alone decide", hooks.md#exit-code-output) unless `onFailure: "block"` makes it a failure.
    const result = readClaudeContractExitAsDocumented(action, settled.value, event, onFailureBlocks(action, event, options.signal));
    // UB12.70 — a Claude-contract exit 0 whose JSON cannot be parsed or fails
    // the output schema is the documented non-blocking error; UB12.100 — any
    // other command hook's exit 0 that cannot be parsed is the same error.
    const outputFailure = claudeContractOutputFailure(action, event, result) ?? nativeContractOutputParseFailure(action, event, result);
    // A non-zero exit (2 included) and a timeout both land here as
    // `success: false`, which is exactly the page's non-consuming set.
    if (!result.success) hookRunFailed = true;
    // D1.354 — recorded HERE, once per run, before any of the reductions below
    // can turn a failure into a block: the observation is what HAPPENED, and a
    // hook whose non-zero exit this event converts into a block still ran and
    // still exited non-zero. Reading it off the notice instead would lose
    // exactly those runs, because `buildHookErrorNotice` returns nothing for a
    // blocked one — and it would lose every clean run, which is the half the
    // notice list can never carry.
    hookRuns.push({
      runtime: 'host',
      event,
      name: hookName,
      outcome: result.timedOut ? 'timeout' : result.success && !outputFailure ? 'success' : 'error',
      // `exitCode` is `number | null` here and `number | undefined` on the
      // observation: a run killed by a signal has no code, and `null` would
      // render as one.
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...hostCommandRunStderr(result, event, outputFailure), // F1.558 — the hook's own stderr, plus a line when its terminalSequence was ignored; UB12.70 — and its output failure
      // Only when both streams are empty does the runner's single reduced
      // string mean anything — the same precedence `reportHookRun` applies.
      ...(!result.stdout && !result.stderr && result.output ? { output: result.output } : {}),
    });
    if (outputFailure) {
      // UB12.70 — "the run is a non-blocking error": its notice carries the
      // parse or validation message, and NOTHING from that output applies — no
      // decision, no universal field, and no stdout context ("Claude Code
      // doesn't add stdout it failed to parse"). `onFailure: "block"` counts it
      // ("Invalid output"), as UB12.67 already did for unparseable JSON.
      hookErrors.push({ hookName, event, ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}), summary: outputFailure });
      const blocked = onFailureBlocks(action, event, options.signal)
        ? onFailureBlockDecision(event, commandOnFailureLabel(action), false, outputFailure)
        : undefined;
      if (blocked) decision = mergePreToolUseDecisions(decision, blocked);
      continue;
    }
    // The universal fields (`continue`/`stopReason`/`suppressOutput`/
    // `systemMessage`/`terminalSequence`) are event-independent and come from the
    // one parser; the per-event contract table decides which event-specific
    // fields survive alongside them. Before R9 this branch forced every
    // non-PreToolUse event observational, which is how the PermissionRequest
    // band shipped inert (CDP pass 3).
    universal = mergeHookUniversalOutputs(universal, parseHookOutputForEvent(result.stdout ?? '', event).universal);
    // Exit-code semantics (any non-zero blocks, or Claude's three-way 0/2/other)
    // stay with the exit-status reader, which sees fields the stdout parse cannot.
    const rawParsedOutput = hookEventCanDecide(event)
      // C3.350 — see `hookTimeoutBlockReason`: a stalled hook produced no words
      // of its own, so the block reason has to name it.
      ? getHookCommandPreToolDecision(action, result, { hookName, event })
      // UB12.101 — the same reading `getHookCommandPreToolDecision` passes, so
      // a Claude-contract hook on a context-only event applies only its fired
      // branch's fields (never a top-level `additionalContext`).
      : parseHookCommandOutput(result.stdout ?? '', { event, claudeContract: action.blockOnNonZero === false });
    // R20: an exit-code-only event decides via its EXIT CODE, never via a
    // `decision` field on stdout. On a successful exit its stdout carries no
    // decision surface, so anything the hook printed there is dropped and only
    // its context survives. `continue: false` is handled by the universal path.
    const parsedOutput = result.success && !hookEventStdoutCanDecide(event)
      ? (rawParsedOutput ? { ...rawParsedOutput, decision: undefined, reason: undefined } : rawParsedOutput)
      : rawParsedOutput;
    // WorktreeCreate, command form: the path is the LAST non-empty stdout line,
    // ANSI-stripped — not JSON, so the JSON parse above never sees it. The `http`
    // form (`hookSpecificOutput.worktreePath`) comes through the parser instead.
    if (event === 'WorktreeCreate' && result.success && !parsedOutput?.worktreePath) {
      const candidate = parseCommandHookWorktreePath(result.stdout ?? '');
      if (candidate) {
        decision = mergePreToolUseDecisions(
          decision,
          { type: 'decision', worktreePath: candidate },
        );
      }
    }
    const commandDecision = projectHookDecisionForEvent(event, parsedOutput);
    const commandBlocked = commandDecision?.decision === 'block' || commandDecision?.decision === 'deny';
    // A failure the event turned into a block reports itself through that block
    // (exit 2 feeds stderr to the model). Every other failure is the documented
    // non-blocking error, which must still reach the user instead of vanishing.
    const notice = buildHookErrorNotice({
      event,
      hookName,
      result,
      blocked: commandBlocked,
    });
    if (notice) hookErrors.push(notice);
    if (commandDecision) {
      decision = mergePreToolUseDecisions(
        decision,
        { type: 'decision', ...dropFailedOpenWidening(commandDecision, ifFailedOpen) },
      );
    }
    // UB12.67 — `onFailure: "block"`: a failed run that did not already block
    // does what exit 2 does on this event. Its notice above stays as it was.
    if (!commandBlocked && onFailureBlocks(action, event, options.signal) && commandRunFailedForOnFailure(result)) {
      const cause = buildHookErrorNotice({ event, hookName, result, blocked: false })?.summary
        ?? 'the hook printed JSON that cannot be parsed';
      const blocked = onFailureBlockDecision(event, commandOnFailureLabel(action), result.timedOut === true, cause);
      if (blocked) decision = mergePreToolUseDecisions(decision, blocked);
    }
    // hooks.md § Exit code 0: `UserPromptSubmit`, `UserPromptExpansion`,
    // `SessionStart` and `PostModelSwitch` (UB12.69) are the four events where
    // exit-0 stdout is context rather than a debug line. An imported plugin hook
    // gets the same channel as a native automation — it is a property of the
    // EVENT, not of who declared the hook.
    const stdoutContext = hookCommandStdoutContext(event, result);
    if (stdoutContext) {
      decision = mergePreToolUseDecisions(
        decision,
        { type: 'decision', additionalContext: stdoutContext },
      );
    }
    // `continue: false` outranks whatever the event-specific surface said, and
    // reaches events that have no `decision` field at all.
    if (universal?.continue === false) {
      decision = mergePreToolUseDecisions(decision, { type: 'decision', decision: 'block' });
    }
  }

  // hooks.md:1060's source gate, applied where the INPUT is still in hand and
  // before any consumer — or any merge with another scope's result — can read
  // the field.
  const gatedDecision = applySessionStartTitleSourceGate(event, input.source, decision);

  return {
    matchedCount,
    ...(gatedDecision ? { decision: gatedDecision } : {}),
    ...(universal ? { universal } : {}),
    ...(hookErrors.length > 0 ? { hookErrors } : {}),
    // Every runner failure also produces a notice, so the notice list is the
    // second half of the answer; the flag alone would miss an http or mcp_tool
    // hook that failed without ever reaching the command loop.
    ...(hookRunFailed || hookErrors.length > 0 ? { hookRunFailed: true } : {}),
    // D1.354 — absent, rather than empty, when this dispatch has no row at all: no
    // hook ran, no pre-run notice, no not-ran row (F1.232's notice, F1.270's block;
    // F1.449). "This result reports no runs" and "nothing ran" are different facts,
    // and the reader in `base-agent.ts` branches on exactly that difference.
    ...withObservedPreRunNotices(hookErrors.slice(0, preRunNoticeCount), hookRuns),
  };
}

/**
 * A body that ATTEMPTED the documented JSON verdict and cannot be read.
 *
 * hooks.md § JSON output: "Your hook's stdout must contain only the JSON
 * object", and § MCP tool hook fields draws the same line — "if it parses as
 * valid JSON output it is processed as a decision, otherwise it is shown as
 * plain text". A body that never opens an object is therefore prose — the
 * documented context channel for an mcp_tool hook, and for an http hook the
 * non-blocking error {@link isPlainTextHookVerdictBody} names (UB12.51); either
 * way not THIS failure. A body that opens one and does not close or parse is a
 * verdict we cannot read, which is a different thing from silence.
 */
function isUnreadableHookVerdictBody(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return false;
  if (!trimmed.endsWith('}')) return true;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return !parsed || typeof parsed !== 'object' || Array.isArray(parsed);
  } catch {
    return true;
  }
}

/**
 * UB12.51 — a non-empty body that never opens a JSON object: prose, a JSON
 * array, a quoted string, a bare number. hooks.md § Exit code 0 sorts exactly
 * these as plain text ("Output that doesn't start with `{` … plain text. A JSON
 * array and a quoted JSON string are plain text by this rule"), and
 * {@link isUnreadableHookVerdictBody} owns every body that does open one, so
 * the two never claim the same body and an empty body is neither.
 *
 * An mcp_tool hook's plain text is command stdout and may become context. An
 * http hook's is not: hooks.md § HTTP response handling, "2xx with any other
 * body, such as plain text: non-blocking error, handled the same as a non-2xx
 * status. Claude Code doesn't add the text to Claude's context".
 */
function isPlainTextHookVerdictBody(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.length > 0 && !trimmed.startsWith('{');
}

/**
 * Merge one http or mcp_tool runner's verdict (D6/D8).
 *
 * THE decision path for both is the command runner's: the body is read as
 * command-hook exit-0 stdout by `parseHookOutputForEvent`, so the universal
 * fields, the per-event decision surface and `continue: false` behave
 * identically for all three hook types — there is no second merge to drift.
 * For an mcp_tool hook, `hookCommandStdoutContext` supplies the "plain text is
 * added as context" half through the same four-event gate a command hook's
 * stdout goes through (hooks.md § Exit code 0 names `UserPromptSubmit`,
 * `UserPromptExpansion`, `SessionStart` and `PostModelSwitch` as the events
 * where Claude Code "adds plain-text stdout as context"; UB12.69 added the
 * fourth).
 *
 * An http hook's plain-text body ({@link isPlainTextHookVerdictBody}) is NOT
 * stdout (UB12.51): hooks.md § HTTP response handling makes "2xx with any other
 * body, such as plain text" a "non-blocking error, handled the same as a
 * non-2xx status. Claude Code doesn't add the text to Claude's context". So it
 * raises the SAME `http-hook-error` notice a non-2xx raises, on every event,
 * and adds nothing — before UB12.51 a notification endpoint that answered
 * `ok` on `UserPromptSubmit` put `ok` in front of the model. A native `webhook`
 * action is the one exception to the notice (UB12.68,
 * {@link isNativeWebhookHttpHookAction}): its plain-text 2xx is a delivered
 * notification, a clean run that still adds nothing. Since UB12.105 the same
 * holds for every 2xx body of its that is not valid hook output — an object
 * that fails the schema and one that opens `{` and cannot be read — so only a
 * VALID object is read from a native webhook.
 *
 * Failures are the documented non-blocking error and produce the notice, never
 * a block: "Non-2xx status: non-blocking error, execution continues", and the
 * same for a not-connected server or `isError: true`.
 *
 * A REFUSED verdict (UB12.50) is the same non-blocking error for a hook the
 * host would not start, reported once per action and reason
 * ({@link reportRunnerRefusedHook}) rather than once per dispatch.
 *
 * An UNREADABLE verdict is the one place this is stricter than the page. On an
 * event whose stdout can decide, a body that tried to answer and could not be
 * parsed fails CLOSED: the alternative is to treat a broken policy answer as
 * consent, which is the failure mode this whole row exists to remove. On every
 * other event there is no decision to make, so it is inert and reported. A
 * native `webhook` action is outside this (UB12.105): it is a notification, not
 * a policy endpoint, and closing every tool call because one answered NDJSON
 * would turn a delivery into an outage. A policy endpoint is a `type: "http"`
 * hook, which keeps the fail-closed read.
 *
 * Nothing here reads or logs the body, URL, query or headers — the parser
 * redacts every string field it keeps (`hookOutputField`), and the notice
 * carries a host-authored code.
 */
function applyHookRunnerVerdict(args: {
  kind: 'http' | 'mcp_tool';
  /** The declared action, the key a refusal notice is deduplicated on (UB12.50). */
  action: object;
  hookName: string;
  event: AgentEvent;
  verdict: PluginHookRunnerVerdict | void;
  decision: PreToolUseDecision | undefined;
  universal: HookUniversalOutput | undefined;
  hookErrors: HookErrorNotice[];
  /** P6.570 — this handler's matcher had an `if` rule that would not compile ({@link dropFailedOpenWidening}). */
  ifFailedOpen?: boolean;
  /** UB12.67 — the hook declared `onFailure: "block"` and the event honours it ({@link onFailureBlocks}). */
  onFailureBlock?: boolean;
}): { decision: PreToolUseDecision | undefined; universal: HookUniversalOutput | undefined } {
  const { event, kind, hookName } = args;
  let decision = args.decision;
  let universal = args.universal;
  const verdict = args.verdict ?? undefined;
  // UB12.67 — every failure arm below ends here: the notice it raised stays,
  // and with `onFailure: "block"` the failure also does what exit 2 does.
  const failed = (cause: string, timedOut = false): { decision: PreToolUseDecision | undefined; universal: HookUniversalOutput | undefined } => {
    const blocked = args.onFailureBlock ? onFailureBlockDecision(event, `${kind} hook`, timedOut, cause) : undefined;
    return { decision: blocked ? mergePreToolUseDecisions(decision, blocked) : decision, universal };
  };
  // A host that answers nothing keeps the pre-D6/D8 observational behaviour.
  if (!verdict) return { decision, universal };
  if (verdict.refused) {
    reportRunnerRefusedHook(args.hookErrors, args.action, hookName, event, kind, verdict.refused);
    return failed(runnerRefusalNotice(kind, verdict.refused).summary);
  }
  if (verdict.failed) {
    const code = verdict.code ?? `${kind}-hook-error`;
    args.hookErrors.push({
      hookName,
      event,
      exitCode: null,
      summary: code,
    });
    return failed(code, code === `${kind}-hook-timeout`);
  }
  const body = verdict.body ?? '';
  // UB12.68 + UB12.105 — a native `webhook` action's 2xx is a delivered
  // notification: a body that is not valid hook output (plain text, an object
  // that fails the schema, one that cannot be read) is a clean run with
  // nothing from it applied. Only valid hook output is read from it below.
  const delivered = isNativeWebhookHttpHookAction(args.action);
  if (isUnreadableHookVerdictBody(body)) {
    if (delivered) return { decision, universal };
    args.hookErrors.push({
      hookName,
      event,
      exitCode: null,
      summary: `${kind}-hook-response-unreadable`,
    });
    if (hookEventStdoutCanDecide(event)) {
      decision = mergePreToolUseDecisions(decision, {
        type: 'decision',
        decision: 'block',
        reason: `A ${kind} hook answered with an unreadable decision.`,
      });
      return { decision, universal }; // already fails closed here, `onFailure` or not
    }
    return failed(`${kind}-hook-response-unreadable`);
  }
  if (kind === 'http' && isPlainTextHookVerdictBody(body)) {
    // UB12.68 — a native `webhook` action's plain-text 2xx (Slack's `ok`) is a
    // delivered notification: a clean run, still with nothing read from it.
    if (delivered) return { decision, universal };
    // UB12.51 — "handled the same as a non-2xx status": the runner's own
    // non-2xx code, and no decision, context or universal field is read.
    args.hookErrors.push({ hookName, event, exitCode: null, summary: 'http-hook-error' });
    return failed('http-hook-error');
  }
  // UB12.70 — a READABLE object that fails the output schema: "A body that
  // fails schema validation is a non-blocking error" (http), and an mcp_tool
  // hook's text is read "the same way it reads command-hook stdout". The notice
  // carries the validation message and nothing from the body applies. Unlike
  // the unreadable arm above it does NOT fail closed on its own: the page calls
  // it non-blocking, and `onFailure: "block"` is the documented way to close it.
  const schemaFailure = hookStdoutJsonFailure(body, event); // UB12.101 — with the event-name rule
  if (schemaFailure) {
    if (delivered) return { decision, universal }; // UB12.105
    args.hookErrors.push({ hookName, event, exitCode: null, summary: schemaFailure });
    return failed(schemaFailure);
  }
  // UB12.98 — a body is read under Claude's output contract, the same contract
  // the schema check above holds it to, so PreToolUse's deprecated top-level
  // `approve` is an `allow` here (`hooks.md#pretooluse-decision-control`).
  const parsed = parseHookOutputForEvent(body, event, { claudeContract: true });
  universal = mergeHookUniversalOutputs(universal, parsed.universal);
  const projected = projectHookDecisionForEvent(event, parsed.payload);
  if (projected) {
    decision = mergePreToolUseDecisions(decision, { type: 'decision', ...dropFailedOpenWidening(projected, args.ifFailedOpen) });
  }
  const stdoutContext = hookCommandStdoutContext(event, { success: true, stdout: body });
  if (stdoutContext) {
    decision = mergePreToolUseDecisions(
      decision,
      { type: 'decision', additionalContext: stdoutContext },
    );
  }
  // Universal `continue: false` outranks the event's own surface and reaches
  // events that have no `decision` field at all — the same belt the command
  // branch applies after its own merge.
  if (universal?.continue === false) {
    decision = mergePreToolUseDecisions(decision, { type: 'decision', decision: 'block' });
  }
  return { decision, universal };
}

/**
 * UB12.67 — `onFailure: "block"` on a `command` or `http` hook.
 *
 * `hooks.md#block-the-action-when-a-hook-fails` (curl'd 2026-10-16), verbatim:
 * *"On most events, when a hook fails or times out, Claude Code still carries
 * out the action, so a policy hook with a wrong path or a crashing script lets
 * everything through. To block the action instead, set `"onFailure": "block"`
 * on a `command` or `http` hook. The default value is `"continue"`."* And:
 * *"With `"block"` set, a failure does what exit code 2 does on that event,
 * except on `PermissionRequest`, where it denies the request."*
 *
 * Until this row the field was read nowhere, so a policy hook that declared it
 * failed OPEN on this host executor — Pi's and codex's hook engine, and every
 * plugin or hooks-file hook on claude (the SDK route funnels here too). Claude
 * settings-file hooks run inside the SDK engine and get the field natively
 * from claude 2.1.295; the bundle was at 2.1.280 when this landed.
 *
 * What counts as a failure is the page's list, and each arm names where it is
 * read: "Can't start" (no execution authority, a host refusal, a guard's
 * refusal, no http runner), "Exit code other than 0 or 2" (even with JSON that
 * allows — an exit-1 run is never parsed here), "HTTP error", "Timeout", and
 * "Invalid output" ({@link isUnreadableHookVerdictBody}: JSON that cannot be
 * parsed; for http also a 2xx body that is not empty and not a JSON object).
 * Exit 2 is NOT one: it is already the blocking error. A run of a stopped turn
 * is not one either — the abort signal decides, as it does for every refusal
 * notice in this file. "Fails schema validation" was this row's stated residue;
 * UB12.70 closed it for a Claude-contract command hook's exit 0
 * ({@link claudeContractOutputFailure}) and for every http and mcp_tool body
 * ({@link applyHookRunnerVerdict}). A native command hook is still read for
 * the fields it knows, under its own documented contract; its JSON that cannot
 * be parsed is "Invalid output" since UB12.100
 * ({@link nativeContractOutputParseFailure}).
 *
 * The effect is exit 2's, through the event's own projection
 * ({@link projectHookDecisionForEvent}): a `PreToolUse` tool call is blocked,
 * a `UserPromptSubmit` prompt is blocked, a `PermissionRequest` is denied, and
 * on an event exit 2 cannot block (`PostToolUse` feeds the reason to the model;
 * a context-only event shows the notice only) the projection keeps what exit 2
 * would. The failure's own notice is raised exactly as without the field, and
 * the block's reason is the page's message: `[<hook>]: failed; blocking because
 * onFailure is "block"` (or `timed out`), then the failure's first line.
 */
const ON_FAILURE_INERT_EVENTS: ReadonlySet<string> = new Set([
  // "The field has no effect on these hooks: `Stop`, `SubagentStop`,
  // `TaskCompleted`, and `TeammateIdle` hooks: exit code 2 on these events
  // sends Claude back to keep working, and Claude can't repair a hook that
  // won't run". `TeammateIdle` is not emitted here; it is listed as the page lists it.
  'Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle',
]);

/**
 * Whether a failure of this hook blocks: it declared `"block"`, it is not a
 * background hook ("Background command hooks: command hooks that set `async`
 * or `asyncRewake`" — `asyncRewake` implies `async` on every import path), the
 * event honours the field, and the turn was not stopped.
 */
function onFailureBlocks(
  action: { onFailure?: HookOnFailure; async?: boolean },
  event: AgentEvent,
  signal: AbortSignal | undefined,
): boolean {
  return action.onFailure === 'block' && action.async !== true && !ON_FAILURE_INERT_EVENTS.has(event) && signal?.aborted !== true;
}

/** The page's failure list for a command run that RAN (or was refused by its runner). */
function commandRunFailedForOnFailure(result: HookCommandActionResult): boolean {
  if (!result.success) return result.timedOut === true || result.exitCode !== 2;
  return isUnreadableHookVerdictBody(result.stdout ?? '');
}

/**
 * UB12.70 — the non-blocking error a command hook's exit-0 stdout raises under
 * CLAUDE'S output contract ({@link hookStdoutJsonFailure}: JSON that cannot be
 * parsed, or an object that fails the bundle's output schema), as its notice's
 * message; `undefined` when the stdout is valid JSON output, plain text, or not
 * read under that contract.
 *
 * - **Exit 0 only.** Exit 2 blocks with stderr as the reason whatever the JSON
 *   says (hooks.md § Exit code 2: "JSON that fails schema validation: the hook
 *   still blocks"). An exit 1 that printed JSON arrives here AS exit 0 (UB12.93,
 *   `readClaudeContractExitAsDocumented`), so the same check covers it.
 * - **The Claude contract only** — `blockOnNonZero === false`, the marker
 *   `pluginHookAction` (exitCodeContract `claude-three-way`) and
 *   `adaptClaudeHookGroups` (a hooks file's Claude-shape handler) set for the
 *   format a hook was AUTHORED in, the same marker UB12.93 keys on. A native
 *   `actions` hook and a codex or `nessy-plugin.json` command hook keep this
 *   fork's own documented reading (docs-site automations overview: a top-level
 *   `decision` of `allow`, `ask`, `block` or `deny`, a top-level
 *   `updatedInput`), which the bundle's schema refuses, so validating them
 *   would turn working hooks into errors (they get the parse half alone,
 *   {@link nativeContractOutputParseFailure}, UB12.100). A native handler that
 *   spells `blockOnNonZero: false` itself opts into the Claude contract with it.
 * - **Not `WorktreeCreate`**: its command stdout is the worktree path, never
 *   JSON ("A `WorktreeCreate` command hook can't return JSON").
 * - **The fired event** (UB12.101): a `hookSpecificOutput` naming another
 *   event's branch fails, as the CLI's "Hook returned incorrect event name".
 */
function claudeContractOutputFailure(
  action: HookCommandAction,
  event: AgentEvent,
  result: HookCommandActionResult,
): string | undefined {
  if (!result.success || action.blockOnNonZero !== false || event === 'WorktreeCreate') return undefined;
  return hookStdoutJsonFailure(result.stdout ?? '', event);
}

/**
 * UB12.100 — the PARSE half of {@link claudeContractOutputFailure} for every
 * command hook that is NOT read under Claude's output contract (a native
 * `actions` hook, a codex or `nessy-plugin.json` command hook): exit-0 stdout
 * that opens `{` and is not a JSON object ({@link hookStdoutParseFailure}).
 *
 * Only the parse half. The schema half stays Claude's alone, because the native
 * contract documents fields that schema refuses (a top-level `allow`, `ask`,
 * `block` or `deny`, a top-level `updatedInput`; docs-site automations
 * overview). The parse half is about the bytes: a hook that opened its
 * decision object and never finished it has printed neither a decision nor
 * prose. Before this row such a run was a clean success with no notice, and on
 * `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` and
 * `PostModelSwitch` its broken JSON reached the model as context, where
 * `hooks.md#exit-code-0` says "Claude Code doesn't add stdout it failed to
 * parse". The caller's failure branch now does for it what UB12.70 does for a
 * Claude-contract run: the notice carries the message, the run row is an
 * error, nothing from the output applies, and `onFailure: "block"` blocks.
 *
 * Same exclusions as the Claude arm: a failed run (its exit code speaks) and
 * `WorktreeCreate` (its stdout is the worktree path).
 */
function nativeContractOutputParseFailure(
  action: HookCommandAction,
  event: AgentEvent,
  result: HookCommandActionResult,
): string | undefined {
  if (!result.success || action.blockOnNonZero === false || event === 'WorktreeCreate') return undefined;
  return hookStdoutParseFailure(result.stdout ?? '');
}

/** The longest stretch of a command line the block reason quotes, in characters. */
const ON_FAILURE_COMMAND_QUOTE_LIMIT = 120;

/** The page's `[node …/check-command.js]` subject: the command and its args, redacted, on one capped line. */
function commandOnFailureLabel(action: HookCommandAction): string {
  const oneLine = redactHookOutput([action.command, ...(action.args ?? [])].join(' ')).replace(/\s+/g, ' ').trim();
  return oneLine.length > ON_FAILURE_COMMAND_QUOTE_LIMIT ? `${oneLine.slice(0, ON_FAILURE_COMMAND_QUOTE_LIMIT)}…` : oneLine;
}

/**
 * Exit 2's effect on `event`, as a decision action, or `undefined` where the
 * event's surface carries no decision (the failure's notice is then all that
 * shows, which is what exit 2 does there too).
 */
function onFailureBlockDecision(
  event: AgentEvent,
  subject: string,
  timedOut: boolean,
  cause: string | undefined,
): PreToolUseDecisionAction | undefined {
  const headline = `[${subject}]: ${timedOut ? 'timed out' : 'failed'}; blocking because onFailure is "block"`;
  const projected = projectHookDecisionForEvent(event, {
    decision: event === 'PermissionRequest' ? 'deny' : 'block',
    reason: cause?.trim() ? `${headline}\n${cause.trim()}` : headline,
  });
  return projected?.decision ? { type: 'decision', ...projected } : undefined;
}

/**
 * Awaits the prompt-decision runner bounded by the hook's clamped timeout.
 * Timeout, rejection and a missing verdict all resolve `undefined` — the
 * documented fail-open posture for a judge that cannot answer.
 */
async function runBoundedPromptHook(
  promptRunner: PluginPromptHookRunner,
  action: PluginPromptHookAction,
  event: AgentEvent,
  input: SdkAutomationInput,
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; reason?: string } | undefined> {
  const timeoutMs = clampPromptHookTimeoutMs(action.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promptRunner({
        prompt: action.prompt,
        ...(action.model ? { model: action.model } : {}),
        event,
        input,
        ...(signal ? { signal } : {}),
      }),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Evaluates one matcher's `if` filter against the current call. Fail-open on
 * evaluation trouble per hooks.md; on non-tool events the hook never runs
 * (also enforced at registration — this is the execution-side belt).
 */
function hookIfFilterRuns(
  matcher: Pick<AutomationMatcher, 'ifRule' | 'ifSourceRoot'>,
  event: AgentEvent,
  input: SdkAutomationInput,
  options: { workspaceRootPath: string; workingDir?: string },
): ClaudeHookIfResult {
  if (!TOOL_HOOK_EVENTS.has(event)) return { run: false, unparseableRule: false };
  const toolName = input.tool_name ? EXTERNAL_HOOK_TOOL_NAMES[input.tool_name] ?? input.tool_name : undefined;
  return evaluateClaudeHookIfFilter(matcher.ifRule!, {
    ...(toolName === undefined ? {} : { toolName }),
    ...(input.tool_input === undefined ? {} : { toolInput: input.tool_input }),
    cwd: options.workingDir ?? options.workspaceRootPath,
    // The half that was declared and never supplied: without it every
    // source-anchored `if` compiled to `invalid-policy` and failed open.
    ...(matcher.ifSourceRoot === undefined ? {} : { sourceRoot: matcher.ifSourceRoot }),
  });
}

/**
 * P6.570 — **a hook whose `if` filter FAILED OPEN may not widen the session.**
 *
 * The fail-open itself is the page's own rule and is not touched here.
 * `hooks.md#bash-if-matching`: *"When Claude Code can't determine which commands
 * the Bash input runs, it runs your hook regardless of the pattern. Because the
 * `if` filter is best-effort, use the permission system rather than a hook to
 * enforce a hard allow or deny."* So a hook whose rule will not compile keeps
 * running — `hookIfFilterRuns` returns `run: true` with `unparseableRule: true`,
 * and {@link reportUnparseableIfRule} says so once.
 *
 * That default is safe for every output a hook has EXCEPT one. Running a hook
 * more often than its author scoped it makes a `block`/`deny` stricter, an
 * `additionalContext` noisier, a `updatedInput` more often rewritten — all
 * inside what the author already asked for. `updatedPermissions` is the
 * exception and the only one: `hooks.md#permissionrequest` makes it **allow-only
 * and session-widening** — the hook is asking the host to hand the session a
 * permission it did not have. Applying it on a call the author scoped away is
 * the fail-open turning into a LOOSENING, and the same sentence that licenses
 * the fail-open forbids that reading: an `if` filter is explicitly not the place
 * to *"enforce a hard allow"*, so a filter that could not be evaluated cannot be
 * the authority for granting one.
 *
 * Note the asymmetry with the OTHER `if` outcome: a filter that evaluates and
 * does NOT match drops the hook entirely (the `continue` above), so nothing of
 * it — widening included — is applied. This function is only about the third
 * state, where the rule never compiled.
 *
 * Deliberately silent per widened call: the authoring fault already has exactly
 * one notice per matcher ({@link REPORTED_UNPARSEABLE_IF_RULES}), whose detail
 * names this consequence, and a `PreToolUse`-shaped hook fires on every call.
 */
function dropFailedOpenWidening<T extends PreToolUseDecision>(projected: T, ifFailedOpen: boolean | undefined): T {
  if (!ifFailedOpen || projected.updatedPermissions === undefined) return projected;
  const { updatedPermissions: _dropped, ...rest } = projected;
  return rest as T;
}

/**
 * Matchers whose unparseable `if` rule has already been reported.
 *
 * The diagnostic is an AUTHORING fact — this one rule, in this one matcher,
 * will never compile — so it is worth exactly one notice, not one per tool
 * call. A fail-open filter fires on every call across the five tool events, and
 * an un-deduplicated notice would put a warning bubble in the transcript beside
 * each of them; the operator learns nothing after the first and stops reading
 * the channel. Keyed on the matcher OBJECT, which the component-hook layers
 * hand back unchanged on every dispatch, so the key is per load rather than per
 * process: a reload, a second session, or a second workspace each get their own
 * notice, and nothing is retained after the config is dropped. If some future
 * path rebuilds matchers per dispatch this degrades to the un-deduplicated
 * behaviour — noisier, never silent.
 */
const REPORTED_UNPARSEABLE_IF_RULES = new WeakSet<object>();

/**
 * P6.12 — the four non-command handler kinds run through INJECTED runners, and
 * until this existed an absent runner was SILENTLY ZERO RUNS.
 *
 * Measured at the injection site (`SessionManager.buildAgentAutomationSystem`):
 * the agent/mcp_tool/http/prompt runners are inside a `provider === 'pi'`
 * ternary, so on claude-runtime, codex and nestor-cloud a `hooks.json`
 * declaring `"type": "http"` matched, dispatched, and did nothing at all. That
 * is the fork's largest defect class — a control that silently stops
 * controlling — and it is a SWITCH difference: the same plugin behaves
 * differently after a runtime change with nothing said.
 *
 * The remedy is deliberately the SMALLEST honest one and invents no channel:
 * it reuses `hookErrors`, the notice `command-hook-execution-authority-unavailable`
 * already rides two branches below for exactly this condition on the fifth
 * kind. `SessionManager.reportHookErrors` puts `summary` in the transcript as a
 * warning and `detail` in the debug log; on claude-runtime the same notice
 * reaches the user through `sdkUniversalHookOutput`'s `systemMessage`. So the
 * residual difference is now REPORTED rather than silent, which is the least
 * this can be — wiring the runners for every runtime is a separate, larger
 * decision (they carry Pi-named execution receipts and, for agent hooks, the
 * child-session service) and is NOT taken here.
 *
 * Deduplicated per ACTION object, exactly like {@link reportUnparseableIfRule}
 * dedupes per matcher: a `PreToolUse` hook fires on every tool call, and one
 * transcript warning per call would be noise rather than a diagnostic. The
 * config objects are rebuilt per automation-system build, so a user who fixes
 * the session sees the notice again on the next build.
 */
const REPORTED_MISSING_HOOK_RUNNERS = new WeakSet<object>();

/**
 * Why an http hook the runner WOULD have run was refused before it was sent.
 *
 * Two guards, and they are deliberately different in kind, so the notices say
 * different things rather than sharing one vague sentence:
 *  - `unsafe-url` is a SCHEME question — {@link isSafePluginHookHttpUrl} admits
 *    only `http:` and `https:`, so a `file:`, `ftp:` or unparseable URL never
 *    leaves the process.
 *  - `credential-bearing` is {@link isCredentialBearingPluginHttpDescriptor},
 *    which is FAIL-CLOSED and bounded: it refuses on an `auth` key, credentials
 *    in the userinfo or query string, a sensitive header NAME, a bearer/basic
 *    marker anywhere in a header value or body, and on any descriptor too large,
 *    too deep or too odd to inspect. So the detail says "or could not be
 *    inspected" rather than asserting a credential was definitely present —
 *    telling an operator their hook carries a secret when it carries a cyclic
 *    body would send them looking for the wrong thing.
 *
 * Neither is loosened by this row. What changes is that the refusal is legible.
 */
const REPORTED_REFUSED_HTTP_HOOKS = new WeakSet<object>();

type RefusedHttpHookReason = 'unsafe-url' | 'credential-bearing';

const REFUSED_HTTP_HOOK_NOTICES: Record<RefusedHttpHookReason, { summary: string; detail: string }> = {
  'unsafe-url': {
    summary: 'http hook did not run: its URL is not an http(s) URL',
    detail: 'A `type: "http"` hook matched, but its `url` is not a parseable `http:` or `https:` URL, so the request'
      + ' was never sent. Fix the `url` in the hook declaration; no other scheme is dispatched.',
  },
  'credential-bearing': {
    summary: 'http hook did not run: its request carries credentials, or could not be inspected',
    detail: 'A `type: "http"` hook matched, but its request descriptor was refused by the credential guard, so the'
      + ' request was never sent. That guard is fail-closed: it refuses an `auth` key, credentials in the URL'
      + ' userinfo or query string, a credential-shaped header name or value, a bearer/basic marker in the body —'
      + ' and also any descriptor too large, too deep, or too unusual to inspect within its bounds. Send secrets'
      + ' from the receiving service instead of from the hook declaration.',
  },
};

function reportRefusedHttpHook(
  hookErrors: HookErrorNotice[],
  action: object,
  hookName: string,
  event: AgentEvent,
  reason: RefusedHttpHookReason,
): void {
  if (REPORTED_REFUSED_HTTP_HOOKS.has(action)) return;
  REPORTED_REFUSED_HTTP_HOOKS.add(action);
  const notice = REFUSED_HTTP_HOOK_NOTICES[reason];
  hookErrors.push({ hookName, event, exitCode: null, summary: notice.summary, detail: notice.detail });
}

/**
 * UB12.50 — the notice for a hook the HOST runner refused to start
 * ({@link PluginHookRunnerRefusal}). The guards above refuse a hook before it
 * reaches the runner; these three refuse it inside the runner, where the trust,
 * the managed allowlist and the session's permission rules are read. Each one
 * used to leave only its receipt.
 *
 * Deduplicated per action AND reason, like the guards above: a `PreToolUse`
 * hook fires on every tool call. Keyed on the reason too, because unlike a
 * malformed URL these can change while the session runs (a mode switch, a
 * trust grant), and a hook refused for a new reason should say so. The receipt
 * and the run row (`hookRunnerVerdictRun`) are still written on every dispatch.
 */
const REPORTED_RUNNER_REFUSALS = new WeakMap<object, Set<PluginHookRunnerRefusal>>();

function runnerRefusalNotice(
  kind: 'http' | 'mcp_tool',
  reason: PluginHookRunnerRefusal,
): { summary: string; detail: string } {
  const never = kind === 'http' ? 'the request was never sent' : 'the declared tool was never invoked';
  const matched = `A \`type: "${kind}"\` hook matched, but`;
  switch (reason) {
    case 'plugin-trust-unavailable':
      return {
        summary: `${kind} hook did not run: this project is not trusted`,
        detail: `${matched} no hook in this session comes from a plugin and the project is not trusted,`
          + ` so ${never}. The host starts such a hook only in a trusted project.`,
      };
    case 'http-hook-url-not-allowed':
      return {
        summary: `${kind} hook did not run: its URL is not on the managed allowlist`,
        detail: `${matched} managed policy defines \`allowedHttpHookUrls\` and the hook's URL matches none of its`
          + ` patterns, so ${never}. Point the hook at an allowed URL, or ask the administrator to allow this one.`,
      };
    case 'permission-denied':
      return {
        summary: `${kind} hook did not run: the session's permission mode and rules do not allow it`,
        detail: `${matched} the session's permission mode and rules did not allow its effect without asking, and a`
          + ` hook cannot ask, so ${never}.`,
      };
  }
}

function reportRunnerRefusedHook(
  hookErrors: HookErrorNotice[],
  action: object,
  hookName: string,
  event: AgentEvent,
  kind: 'http' | 'mcp_tool',
  reason: PluginHookRunnerRefusal,
): void {
  const reported = REPORTED_RUNNER_REFUSALS.get(action) ?? new Set<PluginHookRunnerRefusal>();
  if (reported.has(reason)) return;
  reported.add(reason);
  REPORTED_RUNNER_REFUSALS.set(action, reported);
  const notice = runnerRefusalNotice(kind, reason);
  hookErrors.push({ hookName, event, exitCode: null, summary: notice.summary, detail: notice.detail });
}

type MissingHookRunnerKind = 'agent' | 'mcp' | 'http' | 'prompt';

const MISSING_HOOK_RUNNER_NOTICES: Readonly<Record<MissingHookRunnerKind, { summary: string; detail: string }>> = {
  agent: {
    summary: 'agent hook did not run: this runtime has no agent-hook execution authority',
    detail: 'A `type: "agent"` hook matched, but no agent-hook runner is injected for this runtime, so the sub-agent was never spawned.'
      + ' Agent hooks currently run on Pi-backed sessions only.',
  },
  mcp: {
    summary: 'mcp_tool hook did not run: this runtime has no mcp_tool-hook execution authority',
    detail: 'A `type: "mcp_tool"` hook matched, but no mcp_tool-hook runner is injected for this runtime, so the declared tool was never invoked.'
      + ' mcp_tool hooks currently run on Pi-backed sessions only.',
  },
  http: {
    summary: 'http hook did not run: this runtime has no http-hook execution authority',
    detail: 'A `type: "http"` hook matched, but no http-hook runner is injected for this runtime, so the request was never sent.'
      + ' http hooks currently run on Pi-backed sessions only.',
  },
  prompt: {
    summary: 'prompt hook ran without a decision runner: its body was injected as context and it cannot block here',
    detail: 'A `type: "prompt"` hook matched, but no prompt-judging runner is injected for this runtime, so the documented'
      + ' block verdict is unavailable and the body degrades to a one-shot `additionalContext` injection.'
      + ' Prompt-hook verdicts currently run on Pi-backed sessions only.',
  },
};

function reportHookRunnerUnavailable(
  hookErrors: HookErrorNotice[],
  action: object,
  hookName: string,
  event: AgentEvent,
  kind: MissingHookRunnerKind,
): void {
  if (REPORTED_MISSING_HOOK_RUNNERS.has(action)) return;
  REPORTED_MISSING_HOOK_RUNNERS.add(action);
  const notice = MISSING_HOOK_RUNNER_NOTICES[kind];
  hookErrors.push({ hookName, event, exitCode: null, summary: notice.summary, detail: notice.detail });
}

/**
 * The absent-runner arm of the three deciding/observational kinds: report every
 * matched action once, then hand back the empty run list the caller expects.
 * `never[]` so it is assignable to whichever run-tuple array the branch types.
 */
function reportMissingRunner(
  hookErrors: HookErrorNotice[],
  entries: readonly { action: object; hookName: string }[],
  event: AgentEvent,
  kind: MissingHookRunnerKind,
): never[] {
  for (const { action, hookName } of entries) {
    reportHookRunnerUnavailable(hookErrors, action, hookName, event, kind);
  }
  return [];
}

/**
 * Records the fail-open of an `if` rule that would not compile.
 *
 * The hook has already been allowed to run by the time this is called, and that
 * is the documented posture (hooks.md § Hook handler fields). The notice exists
 * so "the hook ran because its condition matched" is distinguishable from "the
 * hook ran because its condition is broken" — the distinction
 * `ClaudeHookIfResult.unparseableRule` was introduced to carry and that no
 * caller has ever read.
 *
 * It rides the same `hookErrors` channel as
 * `command-hook-execution-authority-unavailable`, for the same reason: a
 * configuration fault that leaves no trace on any other surface. The consumer
 * (`SessionManager.reportHookErrors`) puts `summary` in the transcript as a
 * warning and `detail` in the debug log.
 */
function reportUnparseableIfRule(
  hookErrors: HookErrorNotice[],
  matcher: AutomationMatcher,
  hookName: string,
  event: AgentEvent,
): void {
  if (REPORTED_UNPARSEABLE_IF_RULES.has(matcher)) return;
  REPORTED_UNPARSEABLE_IF_RULES.add(matcher);
  const rule = matcher.ifRule ?? '';
  hookErrors.push({
    hookName,
    event,
    summary: `if condition ${JSON.stringify(rule)} could not be parsed; the filter failed open and this hook now runs on every tool call`,
    detail: `if condition ${JSON.stringify(rule)} could not be parsed as a permission rule.`
      + ' The filter fails open by design, so this hook runs on every tool call of the five tool events until the rule is corrected.'
      + ' Its `updatedPermissions` are the one exception and are dropped while the rule will not compile: that output widens the'
      + ' session, and a filter that could not be evaluated must not be the authority for granting a permission.'
      + ' The `if` filter is best-effort: use the permission system rather than a hook to enforce a hard allow or deny.',
  });
}

/**
 * C3.270 + C3.275 — the ONE event this registrar wires and the claude child
 * never calls, recorded here because nothing else in the tree could say it.
 *
 * The loop below registers a callback matcher for every event a user's
 * automations config names, so `Notification` has been wired on claude for as
 * long as the translator has existed. MEASURED 2026-09-12 against the vendored
 * binary (self-reporting `2.1.247`), three arms — a plain turn, a `Write`
 * approval held two seconds at `canUseTool`, and a settled turn on a still-open
 * streaming session — and on all three NOTHING arrived, on any of the three
 * channels a `Notification` could use: this matcher, a `Notification` hook
 * declared in the child's own settings tier, and the `system`/`notification`
 * message. Both positive controls fired on the same runs (a settings-tier
 * `SessionStart` hook, and a `PreToolUse` callback through THIS channel), so it
 * is an absence rather than a rig.
 * `packages/shared/src/agent/__tests__/claude-notification-e2e.test.ts` holds
 * the arms, the controls and the mechanism the binary suggests.
 *
 * NOTHING IS BUILT FOR IT, deliberately. A host-side producer would mint
 * `Notification` events on claude that describe OUR permission card rather than
 * the runtime's own notification, so a matcher written against the documented
 * `notification_type` vocabulary would fire for a different occurrence than it
 * does on Pi — a silent divergence dressed as parity. The runtime's own SDK
 * surface already gives the same fact its own channel, and this fork already
 * consumes it: `SDKNotificationMessage` becomes an `info` event in
 * `agent/backend/claude/event-adapter.ts`.
 */
/**
 * F1.171 — the SDK's own per-matcher hook budget, and the UNIT this fork had
 * wrong.
 *
 * `HookCallbackMatcher.timeout` is declared in `sdk.d.ts` as *"Timeout in
 * seconds for all hooks in this matcher"*, and the shipped binary honours it at
 * the callback dispatch by MULTIPLYING: `hn.timeout ? hn.timeout*1000 : _`,
 * where `_` defaults to `var Li=600000` (one occurrence; both SDK self-reports
 * said `2.1.251` when this was measured). This function used to pass
 * `action.timeoutMs` straight into that field — a MILLISECOND number into a
 * seconds field — so a hook declaring the stored default of 30 000 ms asked the
 * runtime for 30 000 SECONDS, and one declaring this fork's own cap
 * ({@link MAX_HOOK_TIMEOUT_MS}, 600 000 ms) asked for nearly seven days. A
 * thousandfold widening in the one place a backstop is supposed to be a
 * backstop: it never fired, which is why nothing ever surfaced it.
 *
 * ## What is sent now, and why it is a CEILING rather than the hook's budget
 *
 * The naive repair — divide by 1000 — would be a REGRESSION, because the number
 * the author declares is not what the callback takes. One dispatch of this
 * callback can run the host's approval wait (bounded by the hook's own budget,
 * D1.333) and THEN the command itself (bounded by the same budget), in series,
 * for every command action in the matcher. So the honest outer bound is twice
 * each action's resolved budget, summed — `hookCommandBudgetMs` resolves the
 * defaults, so a matcher mixing a declared action with an undeclared one is
 * counted at what it can really cost rather than at what it happens to spell.
 *
 * It is then FLOORED at the runtime's own default — the LONGEST of its per-event
 * defaults; F1.188 measured `UserPromptSubmit`'s at 30 000 ms, the rest at
 * 600 000 — so this value can never cut
 * a callback shorter than sending nothing would have: the change is strictly a
 * tightening of an infinite bound, never a new kill. That floor also keeps the
 * SDK's backstop behind ours rather than beside it — the binary's own timeout
 * message blames the transport (F1.76 measured what that costs a reader), so the
 * host's bounded waits must always be the first thing to fire.
 */
const SDK_DEFAULT_HOOK_CALLBACK_BUDGET_MS = 600_000;

/**
 * F1.188 — the budget the HOST's agent, mcp-tool and http hook runners apply to
 * one action: `SessionManager.ts`'s `PLUGIN_HOOK_EFFECT_TIMEOUT_MS`, which this
 * package cannot import. Mirrored rather than moved so the host file is not
 * touched for a number; `sdk-hook-matcher-timeout.test.ts` pins the two equal.
 */
export const HOST_PLUGIN_HOOK_EFFECT_BUDGET_MS = 30_000;

/**
 * F1.188 (origin WJ-h P-WJ-h-3) — what ONE action can hold the callback for,
 * for every kind a matcher carries, not for commands alone.
 *
 * A command is twice its resolved budget (the approval wait, then the run).
 * A prompt judge is its own `timeoutMs` as {@link clampPromptHookTimeoutMs}
 * bounds it — never above that clamp's 60 000 ms, whatever the action spells.
 * An agent, mcp-tool or http action counts at its resolved `timeoutMs` (F1.209), else at the host
 * runner's own {@link HOST_PLUGIN_HOOK_EFFECT_BUDGET_MS}. A
 * `decision` action is synchronous work and holds nothing. The actions of one
 * matcher start in parallel, so the sum over-counts, and that is the safe
 * direction for a backstop that must never fire before the host's own bounds.
 */
function hookActionHostBudgetMs(action: AutomationMatcher['actions'][number]): number {
  switch (action.type) {
    case 'command': return hookCommandBudgetMs(action) * 2;
    case 'plugin-prompt': return clampPromptHookTimeoutMs(action.timeoutMs);
    case 'plugin-agent':
    case 'plugin-mcp-tool':
    case 'plugin-http': return action.timeoutMs ?? HOST_PLUGIN_HOOK_EFFECT_BUDGET_MS;
    // F1.786 (UB12.28) — dispatched as an http hook with no `timeoutMs` of its own ({@link webhookAsHttpHookAction}).
    case 'webhook': return HOST_PLUGIN_HOOK_EFFECT_BUDGET_MS;
    default: return 0;
  }
}

function sdkMatcherTimeoutSeconds(actions: AutomationMatcher['actions']): number {
  const hostCeilingMs = actions.reduce((total, action) => total + hookActionHostBudgetMs(action), 0);
  return Math.ceil(Math.max(SDK_DEFAULT_HOOK_CALLBACK_BUDGET_MS, hostCeilingMs) / 1000);
}

function buildSdkHooksForConfig(
  config: AutomationsConfig,
  options: {
    workspaceRootPath: string;
    workingDir?: string;
    runner?: CommandHookRunner;
    agentRunner?: PluginAgentHookRunner;
    mcpToolRunner?: PluginMcpToolHookRunner;
    httpRunner?: PluginHttpHookRunner;
    pluginRuntime?: boolean;
    /** D1.343 — the declaring tier, forwarded to the injected command runner. */
    hookSource?: CommandHookSource;
    /** C4.12 — see {@link PluginScopedAutomationSystem.setSessionDirectiveSink}. */
    sessionDirectiveSink?: HookSessionDirectiveSink;
    /** F1.223 — see {@link SdkHooksBuildOptions.onHookRun}. */
    hookRunSink?: SdkHooksBuildOptions['onHookRun'];
  },
): Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> {
  const sdkHooks: Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> = {};
  for (const [event, matchers] of Object.entries(config.automations) as [AgentEvent, AutomationMatcher[]][]) {
    if (!matchers?.length) continue;
    sdkHooks[event] = matchers.map(matcher => ({
      ...(matcher.matcher ? { matcher: matcher.matcher } : {}),
      // F1.171 — SECONDS, and a ceiling over what the host itself can take.
      // F1.188 — sent on EVERY matcher. F1.171 kept a gate (only when a command
      // declared a budget) on the reading that the runtime's default is
      // 600 000 ms everywhere; it is not. The vendored 2.1.251 passes
      // `timeoutMs:I_e` with `I_e=30000` from both `UserPromptSubmit` executors,
      // and on that event a callback timeout BLOCKS the prompt — so a prompt
      // judge, an agent, an mcp-tool or an http hook (each bounded by the host
      // at 30–60 s) was cut at 30 s and turned a fail-open hook into a refused
      // prompt, on claude alone. The value is floored at 600 000 ms, which is
      // byte-for-byte the runtime's default on every other event, so this
      // changes nothing anywhere but where the default was the shorter one.
      timeout: sdkMatcherTimeoutSeconds(matcher.actions),
      hooks: [async (input, toolUseId, callbackOptions) => {
        const enrichedInput: SdkAutomationInput = {
          ...input,
          hook_event_name: input.hook_event_name ?? event,
          ...(input.tool_use_id ? {} : { tool_use_id: toolUseId }),
        };
        const result = await executePluginHookAutomations({ automations: { [event]: [matcher] } }, event, enrichedInput, {
          ...options,
          ...(callbackOptions.signal ? { signal: callbackOptions.signal } : {}),
        });
        // C4.12 — hand the session band to the host BEFORE the SDK translation
        // drops it (R64, below). Awaited: `reloadSkills` has to land before the
        // turn's capability manifest is built, which is what hooks.md's "available
        // in the same session, starting with the first prompt" requires.
        if (result.decision) await options.sessionDirectiveSink?.(result.decision);
        // F1.223 — the runs, handed to the host before the SDK translation drops them.
        options.hookRunSink?.(result);
        return automationResultToSdkHookResult(event, result);
      }],
    }));
  }
  return sdkHooks;
}

function mergeSdkHooks(
  ...sources: Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>>[]
): Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> {
  const merged: Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> = {};
  for (const source of sources) {
    for (const [event, matchers] of Object.entries(source) as [AgentEvent, SdkAutomationCallbackMatcher[]][]) {
      if (!matchers?.length) continue;
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged;
}

/**
 * Events whose SDK `hookSpecificOutput` accepts `additionalContext` (P3.163).
 *
 * MEMBERSHIP comes from the vendored bundle, which is the denominator here:
 * `@anthropic-ai/claude-agent-sdk/sdk.d.ts` declares `additionalContext?: string`
 * on twelve `…HookSpecificOutput` types, and eleven of those event names are
 * also `AgentEvent`s in this fork. (`Setup` is the twelfth and is not an event
 * we emit — see `UNEMITTED_HOOK_EVENT_REASONS`; `Elicitation` carries no
 * `additionalContext` at all, so this fork's `McpElicitation` spelling never
 * has to be translated.) hooks.md#add-context-for-claude documents the same set
 * from the other side, naming where each event's reminder lands: "SessionStart
 * and SubagentStart: at the start of the conversation, before the first
 * prompt"; "PreToolUse, PostToolUse, PostToolUseFailure, and PostToolBatch:
 * next to the tool result"; "Stop and SubagentStop: at the end of the turn."
 *
 * Before this list the translator named three events inline, so a hook author's
 * `additionalContext` was discarded on the other eight — the two the row calls
 * out (`PostToolUse`, `PostToolUseFailure`) included. Every member's decision
 * surface already carries the field, which the contract test pins, so this list
 * can only widen to events BOTH sides document.
 */
const SDK_ADDITIONAL_CONTEXT_EVENTS: readonly AgentEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SubagentStart',
  'Stop',
  'SubagentStop',
  'Notification',
];

/**
 * The universal half of a hook's output, in SDK spelling (P3.163).
 *
 * hooks.md#json-output: the five universal fields are accepted by "Every
 * event", and `SyncHookJSONOutput` declares all five. Only `continue` was ever
 * read here — `stopReason`, `suppressOutput`, `systemMessage` and
 * `terminalSequence` were parsed by `parseUniversalHookOutput`, merged across
 * hooks by `mergeHookUniversalOutputs`, and then dropped at the wire.
 *
 * `hookErrors` rides `systemMessage` because that is the field the page gives
 * for a warning shown to the user, and because the host-path reporter
 * (`SessionManager.reportHookErrors`) is not reachable from here: hooks built
 * by `buildSdkHooks` return their result to the SDK, never to
 * `executeAgentEvent`. Without this a crashed hook on claude-runtime left no
 * trace on any surface — the exact failure `HookErrorNotice` was introduced to
 * end. The summary half is used, matching the documented notice ("followed by
 * the first line of stderr"); the full `detail` has no SDK-side channel.
 */
function sdkUniversalHookOutput(result: AgentEventExecutionResult): SdkAutomationCallbackResult {
  const universal = result.universal;
  const messages = [
    ...(universal?.systemMessage ? [universal.systemMessage] : []),
    ...(result.hookErrors ?? []).map(notice => `${notice.hookName} hook error: ${notice.summary}`),
  ];
  return {
    ...(universal?.stopReason !== undefined ? { stopReason: universal.stopReason } : {}),
    ...(universal?.suppressOutput !== undefined ? { suppressOutput: universal.suppressOutput } : {}),
    ...(universal?.terminalSequence !== undefined ? { terminalSequence: universal.terminalSequence } : {}),
    ...(messages.length > 0 ? { systemMessage: messages.join('\n') } : {}),
  };
}

/**
 * This fork's PreToolUse decision in the SDK's `HookPermissionDecision` spelling
 * (P3.176) — or `undefined` where the honest translation is to say nothing.
 *
 * hooks.md#pretooluse-decision-control, quoted whole because line numbers decay:
 * "Unlike other hooks that use a top-level `decision` field, PreToolUse returns
 * its decision inside a `hookSpecificOutput` object. This gives it richer
 * control: four outcomes (allow, deny, ask, or defer) plus the ability to modify
 * tool input before execution." The field table:
 *
 *   `"allow"` skips the permission prompt … `"deny"` prevents the tool call.
 *   `"ask"` prompts the user to confirm. `"defer"` exits gracefully so the tool
 *   can be resumed later. [Deny and ask rules] are still evaluated regardless of
 *   what the hook returns
 *
 * Three of the four are translated here, and the fourth is WITHHELD ON PURPOSE:
 *
 * - `block`/`deny` → `"deny"`. Same outcome as before; what changes is the
 *   field. The note under the same section convicts the old shape: "PreToolUse
 *   previously used top-level `decision` and `reason` fields, but these are
 *   deprecated for this event. Use `hookSpecificOutput.permissionDecision` and
 *   `hookSpecificOutput.permissionDecisionReason` instead."
 * - `ask` → `"ask"`, which was DISCARDED. Strictly restrictive: it can only add
 *   a prompt, never remove one, and the page says so even in auto mode — "A
 *   hook's `"ask"` also forces a permission prompt in [auto mode]: the
 *   classifier can still deny the tool call, but it can't approve the call
 *   silently." It is also what the direct path already honours
 *   (`runClaudePreToolUseHookPipeline` reads `ask` into `hookDecision`), so this
 *   makes the two paths agree rather than granting anything new.
 * - `defer` → `"defer"`. P3.176 gave it the representation it had never had at
 *   any layer (P3.124's finding, P3.93's measurement), and until P2.525 it left
 *   here as `"ask"` — matching the live gate, which degraded it one rank because
 *   the host could not RECEIVE a deferral. This translator has no live reader
 *   (the merge above drops this event's non-internal matchers), which is exactly
 *   why it has to keep agreeing with the live path: two answers to one question,
 *   one of them reachable, is how a wiring change turns a dead branch into a
 *   stranded turn.
 *
 *   P2.525 closed the receive side — the event adapter reads both endings, the
 *   resume port is ungated, `tool_deferred` has transcript copy — and the live
 *   gate now emits the runtime's own value. So the degrade is gone from BOTH
 *   sides in one commit, which is the constraint the row carries. The DECISION
 *   is mirrored and nothing else: `claude-hook-defer.test.ts` pins the live half
 *   and the companion fields the page drops stay dropped on this side too.
 * - `allow` → `undefined`, NOT `"allow"`. This is the owner's call, not the
 *   lane's, and P3.93 is why: measured live on five arms, a PreToolUse `allow`
 *   silences the SDK's auto-mode classifier COMPLETELY — zero classifier
 *   requests, zero `canUseTool`, and `curl … | sh` executed with no review. Our
 *   own gate already sends `allow` for calls it approves (`buildClaudePreToolUseContinue`),
 *   which is where that measurement came from; letting a PLUGIN-authored hook do
 *   the same is a permission-surface widening, and per the documented precedence
 *   (`deny` > `defer` > `ask` > `allow`) an allow is the one value that can only
 *   ever loosen. Returning `undefined` keeps today's behaviour exactly: the
 *   payload carries no `permissionDecision` at all, which is P3.93's arm A4 —
 *   the one shape that lets the classifier run.
 *
 * The strict floor is unaffected either way: our gate owns the only SDK
 * PreToolUse callback (`mergeClaudeSdkHooks` drops every other source's
 * PreToolUse matchers), `permissions.deny` outranks a hook, and the page's own
 * "Deny and ask rules are still evaluated regardless of what the hook returns"
 * says the same from the vendor's side.
 */
function sdkPreToolUsePermissionDecision(
  decision: PreToolUseDecisionValue | undefined,
): 'deny' | 'ask' | 'defer' | undefined {
  if (decision === 'block' || decision === 'deny') return 'deny';
  if (decision === 'ask') return 'ask';
  // P2.525 — `defer` leaves as `defer`. It used to leave as `ask` because the
  // LIVE gate degraded it that way and this translator had to answer the same
  // question the same way; the live gate now emits the runtime's own value, so
  // holding the degrade here would re-create the two-answers-to-one-question
  // state P2.525 exists to prevent, on the arm that is dead today and would be
  // the first to bite if anything ever wired it.
  if (decision === 'defer') return 'defer';
  return undefined;
}

function automationResultToSdkHookResult(event: AgentEvent, result: AgentEventExecutionResult): SdkAutomationCallbackResult {
  const decision = result.decision;
  const universal = sdkUniversalHookOutput(result);
  // hooks.md#json-output, `continue`: "If `false`, Claude stops processing
  // entirely after the hook runs. Takes precedence over any event-specific
  // decision fields." A hook that asked to stop therefore outranks whatever the
  // event's block would have done on its own.
  const stopRequested = result.universal?.continue === false;
  const blocks = isBlockingHookDecision(decision);
  // P3.163 · an unconditional `continue: false` on every block ended the turn on
  // EVERY event, against hooks.md's per-event matrix; `hookBlockEndsTurn` is that
  // matrix (a `PostToolUse` block "adds the `reason` next to the tool result").
  // P3.195 · a `PreToolUse` deny continues (that docblock has the sentence), and
  // a prompt hook's terminal default arrives as the universal `continue: false`.
  // F1.864 · on the two PROMPT events the documented block ends the turn by
  // itself — hooks.md#userpromptsubmit-decision-control: `"block"` "prevents the
  // prompt from being processed", `reason` is "Shown to the user" — so no
  // `continue: false` joins it: the 2.1.267 executor yields `preventContinuation`
  // before `blockingError`, the prompt consumer returns on the first, and the
  // reason read "Operation stopped by hook". The hook's OWN `continue: false`
  // still wins (`stopRequested`); `PostToolBatch`'s loop reads both, unchanged.
  const sdkBlockEndsPrompt = event === 'UserPromptSubmit' || event === 'UserPromptExpansion';
  const stopViaContinue = stopRequested || (blocks && hookBlockEndsTurn(event) && !sdkBlockEndsPrompt);
  const base: SdkAutomationCallbackResult = { continue: !stopViaContinue, ...universal };
  // P3.176 · PreToolUse leaves through its OWN vocabulary and never through the
  // top-level pair the page deprecates for it. Everything the event can express
  // — the block that used to ride `decision: 'block'`, the `ask` that was
  // discarded, the `defer` that had no representation anywhere, and the rewrite
  // fields — is assembled once here, so no branch can return before a later one
  // gets to contribute (the exact shape that lost `additionalContext` alongside
  // a PostToolUse rewrite until P3.163).
  //
  // P3.195 · that disagreement is now RESOLVED rather than recorded. This
  // paragraph used to end "hooks.md's prompt/agent-hook list … implies a command
  // hook's plain deny does not end the turn, while `hookBlockEndsTurn` (P3.163's
  // matrix) ends it. That disagreement is recorded rather than resolved here."
  // It is settled in the page's favour on `hookBlockEndsTurn`, so the deny now
  // travels through its documented field AND leaves the turn running — which is
  // what made P3.176's move more than cosmetic.
  if (event === 'PreToolUse') {
    const permissionDecision = sdkPreToolUsePermissionDecision(decision?.decision);
    // "For `"defer"`, ignored" — the field table says it three times, of
    // `permissionDecisionReason`, of `updatedInput`, and of `additionalContext`
    // ("Ignored when `permissionDecision` is `"defer"`"). P2.525 changed which
    // VALUE leaves here and not this: a `defer` still carries its decision and
    // nothing else, because resurrecting the three fields on the way out would
    // let a defer rewrite the very input it was trying to hold — the sharp half
    // of the same defect P3.262 fixed on the live path.
    if (decision?.decision === 'defer') {
      return { ...base, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' as const } };
    }
    const preToolUseOutput = {
      ...(permissionDecision ? { permissionDecision } : {}),
      // Only a named decision carries a reason: on a deny it is "shown to
      // Claude", on an ask "shown to the user but not Claude", and with no
      // decision there is nothing for it to explain.
      ...(permissionDecision && decision?.reason ? { permissionDecisionReason: decision.reason } : {}),
      ...(decision?.updatedInput ? { updatedInput: decision.updatedInput } : {}),
      ...(decision?.additionalContext ? { additionalContext: decision.additionalContext } : {}),
    };
    return Object.keys(preToolUseOutput).length > 0
      ? { ...base, hookSpecificOutput: { hookEventName: 'PreToolUse', ...preToolUseOutput } }
      : base;
  }
  if (blocks) {
    return {
      ...base,
      decision: 'block',
      ...(decision?.reason ? { reason: decision.reason } : {}),
    };
  }
  if (!decision) return base;
  // P3.148 asked why this forwards `updatedToolOutput` raw while Pi routes the
  // same field through `resolveHookToolOutputRewrite`, and the premise — "one
  // path trusts what the other sanitises" — is REFUTED. Measured, three ways:
  //
  // 1. The guard does not sanitise. It type-checks `string`, passes `mcp__*`
  //    and any non-JSON original through UNCONDITIONALLY, and otherwise only
  //    requires the replacement to be JSON of the same top-level kind. No
  //    redaction, no escaping, no content inspection — a hook can still replace
  //    a result with arbitrary prose whenever the kinds agree. It is a
  //    shape-conformance gate, nothing more.
  // 2. The consumer here already applies that rule. `buildSdkHooks()` is the
  //    Claude Agent SDK path and only that path (`base-agent.ts`: "Non-Claude
  //    backends call this directly. ClaudeAgent uses SDK's buildSdkHooks()
  //    instead"), and hooks.md#posttooluse-decision-control states it as the
  //    SDK's own behaviour: "For built-in tools, a value that doesn't match the
  //    tool's output schema is ignored and the original output is used. MCP
  //    tool output is passed through without schema validation." Pi has no such
  //    enforcement, which is the whole reason the guard exists there.
  // 3. Wiring it here would CRASH, not harden. The guard's `originalOutput` is
  //    a string it calls `.trim()` on, and it is calibrated to Pi's built-ins
  //    ("their results travel the Pi wire as text"). On this path the original
  //    is `input.tool_response` straight off the SDK, and
  //    hooks.md#posttooluse-input shows it as an OBJECT —
  //    `"tool_response": { "filePath": "…", "success": true }`, "The exact
  //    schema for both depends on the tool" — with built-ins that "return
  //    structured objects rather than plain strings". Different shape model,
  //    and a `.trim()` on an object is a TypeError inside the hook callback.
  //
  // The raw forward is therefore correct HERE. The path that does match Pi's
  // situation — our own text wire, no downstream enforcement — is
  // `agent/backend/nestor-cloud/tool-executor.ts`, which forwards raw and also
  // drops `structuredContent`; that is its own row (P3.162), not this one.
  //
  // R64 · the `SessionStart` quartet and `UserPromptSubmit`'s `sessionTitle`
  // are deliberately NOT forwarded below. `SdkAutomationCallbackResult` is the
  // shape handed to the Claude Agent SDK's own hook callbacks, and the SDK
  // would apply them to ITS session — renaming a record the sidebar never reads
  // and re-scanning the SDK's own skill directories rather than Nessy's. The
  // fork's consumers are the host's (`renameSession`, the skills-cache
  // invalidation), and they take the fields off `AgentEventExecutionResult`.
  // `additionalContext` is the opposite case: its consumer IS the SDK's own
  // context window, so it belongs on this wire for every event both sides
  // document — B1 prompt hooks bind to the context-injection events, and
  // P3.163 extends that from three events to the documented eleven.
  const hookSpecificOutput = {
    ...(event === 'PostToolUse' && decision.updatedToolOutput !== undefined
      ? { updatedToolOutput: decision.updatedToolOutput }
      : {}),
    // P7.14 · the auto-mode classifier's note, `PostToolUse` only (the failure
    // twin's vendored type declares no such field), and FRAMED rather than
    // relayed verbatim.
    //
    // The framing is the whole decision, and it exists because this fork
    // collapses a distinction the page makes. `hooks.md#annotate-a-result-for-the-auto-mode-classifier` weighs the same note two ways: a note from
    // *"hooks from settings files, plugins, skills, and agent frontmatter"* is
    // *"unverified, application-provided context"* that *"never establishes
    // user intent"*, while one returned by an *"In-process Agent SDK callback"*
    // *"may weigh a user statement relayed in the note as user intent"* and
    // *"can satisfy a consent requirement the classifier would accept from a
    // message you send"*. On this fork EVERY configured hook — plugin,
    // settings file, workspace automation — reaches the runtime through our
    // in-process callback, so relaying its text unchanged would PROMOTE a
    // third-party plugin's sentence to the host's own weight, silently. That is
    // an unauditable influence on a permission outcome, which is worse than an
    // absent one.
    //
    // Nothing on `AgentEventExecutionResult` carries provenance to gate on, and
    // adding it is a larger change than the honest one: the host says whose
    // sentence this is, in its own voice, so the note keeps its documented
    // primary use (*"a fact about its origin"*, the page's own example being
    // *"This query ran against the staging database, not production."*) and can
    // never read as the user speaking. The host's OWN hook results are built as
    // literals in `claude-agent.ts` and do not pass through this translator, so
    // there is no case here where the frame would be wrong.
    ...(event === 'PostToolUse' && decision.classifierContext !== undefined
      ? { classifierContext: `A hook configured in this workspace reports: ${decision.classifierContext}` }
      : {}),
    ...(decision.additionalContext && SDK_ADDITIONAL_CONTEXT_EVENTS.includes(event)
      ? { additionalContext: decision.additionalContext }
      : {}),
  };
  if (Object.keys(hookSpecificOutput).length > 0) {
    return { ...base, hookSpecificOutput: { hookEventName: event, ...hookSpecificOutput } };
  }
  return base;
}

function mergeExecutionResults(
  nativeResult: AgentEventExecutionResult | undefined,
  pluginResult: AgentEventExecutionResult,
): AgentEventExecutionResult {
  if (!nativeResult) return pluginResult;
  const matchedCount = nativeResult.matchedCount + pluginResult.matchedCount;
  const decision = mergePreToolUseDecisionObjects(nativeResult.decision, pluginResult.decision);
  const universal = mergeHookUniversalOutputs(nativeResult.universal, pluginResult.universal);
  // Every failing hook gets its own notice — unlike the decision surface, these
  // do not merge into one winner.
  const hookErrors = [...(nativeResult.hookErrors ?? []), ...(pluginResult.hookErrors ?? [])];
  const hookRunFailed = nativeResult.hookRunFailed === true || pluginResult.hookRunFailed === true;
  // D1.354 — the tiers CONCATENATE, exactly as the notice list does: every tier
  // that ran a hook ran a different hook, so there is no winner to pick. This
  // merge dropped the field entirely until D1.354, which is the second half of
  // why the host arm was dead — `PluginScopedAutomationSystem.executeAgentEvent`
  // folds four tiers through here, so a producer alone would still have
  // published nothing.
  const hookRuns = [...(nativeResult.hookRuns ?? []), ...(pluginResult.hookRuns ?? [])];
  return {
    matchedCount,
    ...(decision ? { decision } : {}),
    ...(universal ? { universal } : {}),
    ...(hookErrors.length > 0 ? { hookErrors } : {}),
    ...(hookRunFailed ? { hookRunFailed: true } : {}),
    ...(hookRuns.length > 0 ? { hookRuns } : {}),
  };
}

function toPreToolUseDecision(action: PreToolUseDecisionAction): PreToolUseDecision {
  const { type: _type, ...decision } = action;
  return decision;
}

/**
 * The ONE merge of a hook's decision action into the running decision, and the
 * one the hooks a session runs go through: every call in
 * `executePluginHookAutomations` above. Exported for the suites that pin it
 * (`automations/hook-command.test.ts`, `automations/hook-decision-contract.test.ts`).
 *
 * F1.230 (WJ-r P-WJ-r-2) — until 2026-09-23 a byte-identical copy was EXPORTED
 * from `automations/automation-system.ts`, and both suites imported that one.
 * Its only production caller was the agent-event dispatch F1.10 (D1.366) took
 * out of that class, so the tests pinned a copy nothing ran while this one, the
 * copy production reads, was private. One copy now, and it is this one.
 *
 * P3.194 — the copy that left was once a second decision merge, ~30 lines of
 * near-copy of the one in `hook-decision-contract.ts`, and it was wrong in four
 * ways the canonical merge already handled: it took `next.reason` even when an
 * outranking `current` won the decision (19 of the 49 ordered decision pairs),
 * and `{...current, ...next}` left explicit `undefined` keys behind while
 * keeping a deny-only `interrupt` on an `allow`, an allow-only
 * `updatedPermissions` under a deny, and an accept-only `elicitationContent`
 * under a `decline`. So this is a two-line adapter from the action shape, and
 * the ordering lives in exactly one place: `mergePreToolUseDecisionObjects`.
 */
export function mergePreToolUseDecisions(
  current: PreToolUseDecision | undefined,
  nextAction: PreToolUseDecisionAction,
): PreToolUseDecision {
  return mergePreToolUseDecisionObjects(current, toPreToolUseDecision(nextAction)) ?? {};
}

/**
 * F1.9 (D1.365) — a prompt hook's run, observed where its verdict is in hand.
 *
 * `runBoundedPromptHook` resolves `undefined` for a judge that timed out,
 * rejected or answered nothing, and that is the documented fail-open: the event
 * goes through. It is still a run that did not do its job, so it is recorded as
 * an `error` — the transcript stays as silent about it as it always was, and
 * `/hooks` is where the failure becomes visible. A verdict of either kind (`ok`,
 * or a block) is a run that worked.
 *
 * Returns the verdict unchanged, so the call site stays one line.
 */
async function observedPromptVerdict(
  hookRuns: HookRunObservation[],
  hookName: string,
  event: AgentEvent,
  verdictPromise: Promise<{ ok: boolean; reason?: string } | undefined>,
): Promise<{ ok: boolean; reason?: string } | undefined> {
  const verdict = await verdictPromise;
  hookRuns.push({
    runtime: 'host',
    event,
    name: hookName,
    outcome: verdict ? 'success' : 'error',
    ...(verdict ? {} : { stderr: 'prompt-hook-no-verdict: the judge timed out, failed or answered nothing, so the hook failed open' }),
  });
  return verdict;
}

/**
 * F1.9 — an agent hook's run. Observational by contract (its result is never a
 * decision), so a fulfilled run is a success; a rejection is rethrown HERE, in
 * registration order, exactly where the loop this replaced threw it.
 */
function settledAgentHookRun(
  outcome: { status: 'fulfilled'; value: void } | { status: 'rejected'; reason: unknown },
  hookName: string,
  event: AgentEvent,
): HookRunObservation {
  if (outcome.status === 'rejected') throw outcome.reason;
  return { runtime: 'host', event, name: hookName, outcome: 'success' };
}

/**
 * F1.9 — an mcp_tool or http hook's run, read off the SAME verdict
 * {@link applyHookRunnerVerdict} folds, in its three arms: a runner failure and
 * an unreadable answer are errors carrying the host-authored code their notice
 * carries (never the body — nothing here reads or logs it); an answer, or no
 * answer at all, is a run that worked. A refusal (UB12.50) is an error on EVERY
 * dispatch, carrying its notice's detail as the guards' pre-run rows do
 * ({@link noticeAsObservedRun}), though the notice itself is reported once.
 * An http hook's plain-text body (UB12.51) is an error with the non-2xx code
 * its notice carries, so `/hooks` and the transcript agree, and so is a body
 * that fails the output schema (UB12.70), with its validation message. A
 * native `webhook` action's 2xx is a success whatever its body (UB12.68 for
 * plain text, UB12.105 for a schema-failing or unreadable object), the same
 * clean run {@link applyHookRunnerVerdict} makes of it.
 */
function hookRunnerVerdictRun(
  kind: 'http' | 'mcp_tool',
  hookName: string,
  event: AgentEvent,
  verdict: PluginHookRunnerVerdict | void,
  action: object,
): HookRunObservation {
  const failure = !verdict
    ? undefined
    : verdict.refused
      ? runnerRefusalNotice(kind, verdict.refused).detail
      : verdict.failed
        ? verdict.code ?? `${kind}-hook-error`
        : isNativeWebhookHttpHookAction(action)
          ? undefined // UB12.68 + UB12.105 — a native webhook's 2xx is a delivery
          : isUnreadableHookVerdictBody(verdict.body ?? '')
            ? `${kind}-hook-response-unreadable`
            : kind === 'http' && isPlainTextHookVerdictBody(verdict.body ?? '')
              ? 'http-hook-error'
              : hookStdoutJsonFailure(verdict.body ?? '', event); // UB12.70 — the schema failure its notice carries (UB12.101: with the event-name rule)
  return {
    runtime: 'host',
    event,
    name: hookName,
    outcome: failure ? 'error' : 'success',
    ...(failure ? { stderr: failure } : {}),
  };
}

/**
 * F1.9 — the notices raised BEFORE the consume phase, as the run rows the
 * reader's fallback would have made of them, ahead of what actually ran.
 *
 * `BaseAgent.recordAutomationHookRuns` reads the result's `hookRuns` when it is
 * present and the notice list only when it is not — deliberately, because a
 * failing COMMAND run is in both. So a notice no run stands for was lost from
 * `HookRunStore` the moment anything else on the event was observed. The
 * notices raised before the consume phase are exactly those: a hook with no
 * runner (agent, mcp_tool, http — or a prompt with no judge, which degrades to
 * context and cannot block), an http request the guards refused, and an `if`
 * rule that would not compile. Each becomes one row here, in the fallback's own
 * shape (runtime `host`, outcome `error`, the notice's detail as stderr), so the
 * store reads the same whether or not something else ran. POSITION is the key,
 * so the notice needs none: every notice the consume phase pushes belongs to a
 * run already observed (a runner failure, an unreadable answer, a command
 * hook's error) — with the one exception below — so none is counted twice.
 *
 * The one exception F1.9 stated here is closed by F1.232: a COMMAND hook with
 * no execution authority off `PreToolUse`, whose notice the command loop pushes
 * AFTER the position this keys on. {@link pushObservedAuthorityNotice} observes
 * it where it is pushed, through the same {@link noticeAsObservedRun} mapping.
 * The user also still sees it in the transcript.
 *
 * Absent, rather than empty, when there is nothing to report — see the field.
 */
function withObservedPreRunNotices(
  preRunNotices: readonly HookErrorNotice[],
  runs: readonly HookRunObservation[],
): { hookRuns?: HookRunObservation[] } {
  const observed: HookRunObservation[] = [
    ...preRunNotices.map(noticeAsObservedRun),
    ...runs,
  ];
  return observed.length > 0 ? { hookRuns: observed } : {};
}

/**
 * A notice as the run row `BaseAgent.recordAutomationHookRuns`'s fallback makes
 * of it — runtime `host`, outcome `error`, the notice's own exit code and detail
 * — so a row is the same row whether the executor observed it or the reader fell
 * back to the notice list. The two sites that observe a notice share it.
 *
 * F1.450 — the detail is `detail ?? summary`, the notice type's own contract
 * ("omitted when equal to `summary`") and the debug-log reader's reading
 * (`SessionManager.reportHookErrors`). Reading `detail` alone left a notice that
 * carries only a summary — F1.232's no-authority code — as a bare `error` in
 * `/hooks`, where its PreToolUse twin (F1.270) names the code. The reader's
 * fallback reads it the same way, so the "same row either way" above still holds.
 */
function noticeAsObservedRun(notice: HookErrorNotice): HookRunObservation {
  return {
    runtime: 'host',
    event: notice.event,
    ...(notice.hookName ? { name: notice.hookName } : {}),
    outcome: 'error',
    ...(typeof notice.exitCode === 'number' ? { exitCode: notice.exitCode } : {}),
    ...((notice.detail ?? notice.summary) ? { stderr: notice.detail ?? notice.summary } : {}),
  };
}

/**
 * F1.232 (WJ-r P-WJ-r-4, decided 2026-09-23: observe it) — a COMMAND hook that
 * could not run because no execution authority was injected, off `PreToolUse`.
 *
 * The notice is pushed exactly as before, so the transcript says what it said.
 * It is ALSO observed as its run row, here, because the reader prefers
 * `hookRuns` and reads the notice list only when the result carries none: on an
 * event where anything else was observed — a hook that ran, or merely another
 * hook's pre-run notice (F1.9) — this notice was the one `/hooks` never showed,
 * and `/hooks` is the user's one view of a hook that did not run.
 *
 * Nothing is counted twice: the reader reads the notice list ONLY when
 * `hookRuns` is absent, and a dispatch that reaches this push now always returns
 * `hookRuns`. A SYNC hook on `PreToolUse` raises no notice (its missing authority
 * is a fail-closed block carrying the code as its reason), so it never comes here —
 * it is observed by {@link authorityUnavailableBlockRun} instead (F1.270). An
 * `async` one on `PreToolUse` DOES come here since F1.451: it could never block by
 * running, so its absence is reported the way it is on every other event. Like
 * that row, it has no production caller at HEAD (F1.448 — see its docblock).
 */
function pushObservedAuthorityNotice(
  hookErrors: HookErrorNotice[],
  hookRuns: HookRunObservation[],
  notice: HookErrorNotice,
): void {
  hookErrors.push(notice);
  hookRuns.push(noticeAsObservedRun(notice));
}

/**
 * F1.209 — the budget a plugin agent / mcp_tool / http action hands its runner:
 * the action's RESOLVED hooks.md `timeout` (`pluginHookAction` in
 * `capabilities/runtime-automations.ts`), or nothing, so a hand-built action
 * with no budget leaves the host runner on its own.
 */
function pluginHookRunnerTimeout(action: { timeoutMs?: number }): { timeoutMs?: number } {
  return typeof action.timeoutMs === 'number' && Number.isFinite(action.timeoutMs) && action.timeoutMs > 0
    ? { timeoutMs: action.timeoutMs }
    : {};
}

/**
 * F1.270 (WJ-bb P-WJ-bb-2, DECIDED by the controller 2026-09-23: record the
 * block as a run row with its reason) — a SYNC command hook with no execution
 * authority ON `PreToolUse` (an `async` one is a notice since F1.451).
 *
 * There the missing authority fails CLOSED: the tool call is blocked with the
 * code as the block's reason, and no notice is raised (the block reports
 * itself to the model). That left the user nothing in `/hooks` — the one view
 * of a hook that did not run — for a hook that had just stopped a tool. The
 * block is unchanged; it is now also a run row, outcome `error` (the hook did
 * not run), carrying the code and what it did as its detail, in the shape
 * {@link noticeAsObservedRun} gives the notice off `PreToolUse` (whose row, since
 * F1.450, carries the same code as its detail).
 *
 * F1.448 — REACHABLE ONLY WITHOUT A RUNNER, which no production system is: every
 * one is built by `buildPinnedAgentAutomationSystem`, whose one caller
 * (`SessionManager.buildAgentAutomationSystem`) passes `pluginCommandHookRunner`
 * unconditionally. So this row and {@link pushObservedAuthorityNotice}'s are the
 * fail-closed guard for a future construction site or a test, not a state a user
 * reaches at HEAD; `host-hook-runs-non-command.test.ts` pins that premise.
 */
function authorityUnavailableBlockRun(hookName: string, event: AgentEvent): HookRunObservation {
  return {
    runtime: 'host',
    event,
    name: hookName,
    outcome: 'error',
    stderr: 'command-hook-execution-authority-unavailable: this hook could not run here, so the tool call was blocked (PreToolUse fails closed)',
  };
}

/**
 * F1.558 — the line a run row carries when its hook returned a `terminalSequence`.
 *
 * DECIDED (controller, TRANSPARENT and SIMPLE, 2026-09-24): the field stays
 * ignored and the run history says so. Measured null on every runtime before the
 * decision: the host accepts and allowlists it (`automations/hook-command.ts`
 * symbol `allowlistedTerminalSequence`) and, on claude, forwards it to the SDK
 * ({@link sdkUniversalHookOutput}), yet NO surface shows it — C3.89 on claude and
 * codex (packaged 1.36.0, a `systemMessage` control rendered beside it) and
 * SIT-5f on Pi (packaged 1.40.0). `hooks.md` limits the field to interactive
 * sessions, and the desktop app has no terminal to write an escape sequence to.
 *
 * The other option the row offered — map the allowlisted OSC 9/99/777 to a
 * desktop notification, OSC 0/1/2 to the window title and BEL to an attention
 * cue — is a product surface of its own and was not chosen; this line is what a
 * user who wrote such a hook needs in order not to be misled.
 *
 * Where the line goes, and why there: the run's own row in the run history
 * (`/hooks`), riding `stderr` like every other host-authored run line in this
 * file (`prompt-hook-no-verdict`, the http/mcp_tool codes, the missing-authority
 * code) and carrying its own code prefix, so it is never mistaken for the hook's
 * output. A clean run stays silent in the transcript, by `reportHookRun`'s rule.
 * ONE line per run that returned an ACCEPTED sequence; a sequence the allowlist
 * rejects is dropped whole by the page's own rule, as before, and gets no line.
 * The field itself still travels unchanged.
 */
export const TERMINAL_SEQUENCE_IGNORED_NOTE = 'terminal-sequence-ignored: the desktop app has no terminal, so the terminalSequence this hook returned was not written anywhere';

/**
 * F1.558 — the `stderr` of a command hook's run row: the hook's own stream,
 * byte for byte, then {@link TERMINAL_SEQUENCE_IGNORED_NOTE} on a line of its own
 * when the run returned an accepted `terminalSequence`. Absent when both are.
 */
function hostCommandRunStderr(result: HookCommandActionResult, event: AgentEvent, outputFailure?: string): { stderr?: string } {
  const ignored = parseHookOutputForEvent(result.stdout ?? '', event).universal.terminalSequence !== undefined;
  // UB12.70 — a run whose output failed the schema applied nothing, so its
  // sequence was not "returned and ignored"; its row carries the failure
  // instead, the line its transcript notice carries.
  const note = outputFailure ?? (ignored ? TERMINAL_SEQUENCE_IGNORED_NOTE : undefined);
  const own = result.stderr ?? '';
  if (!note) return own ? { stderr: own } : {};
  return { stderr: own ? `${own}${own.endsWith('\n') ? '' : '\n'}${note}` : note };
}

/**
 * F1.758, F1.771 — the permission mode a COMMAND HOOK's host gate is judged in.
 *
 * Plan mode is a restriction on the MODEL's own tool calls, not on the
 * operator's hooks. `permission-modes.md`'s plan-mode description is about what
 * *Claude* does while planning ("Claude reads files, runs shell commands to
 * explore, and writes a plan"), and `hooks.md` opens with hooks that "execute
 * automatically at specific points in Claude Code's lifecycle" — there is no
 * sentence on either page that suspends a hook while a session plans.
 *
 * This fork's host runner (`SessionManager.pluginCommandHookRunner`) judged the
 * hook's command line in the session's own mode, and in plan mode every command
 * outside the read-only allowlist — `true` and `printf` included, measured — is
 * refused outright. A refusal is a deny, which D1.343's "the operator declared
 * it" upgrade never touches (it lifts only an `ask`), so the run failed; a
 * native automation's failed run is a block, and a block on `UserPromptSubmit`
 * ends the turn. So ANY user `UserPromptSubmit` command hook dropped every
 * plan-mode prompt ("Operation stopped by hook", SIT-g), and a
 * `PreToolUse` one blocked every tool call.
 *
 * F1.771 measured the same refusal, and the same two consequences, in
 * `explore` and `dontAsk`: both fall through to the same read-only allowlist,
 * so a user's sessionTitle hook, a plain `true` and a genuinely blocking hook
 * were all refused ("… is not in the read-only allowlist"), every prompt
 * dropped and every tool call was denied (`SessionManager.hook-plan-mode.test.ts`,
 * 10 of 20 red before this change).
 *
 * The decision, TRANSPARENT and SIMPLE, per mode:
 *
 * - `plan` → judged as `default` (Manual); the retired `explore` arrives as
 *   `plan`. It restricts what the model's own tools may change while it plans;
 *   it is not a statement about the operator's hooks. That is exactly the answer
 *   `acceptEdits` and `default` already gave — the sitting's working control.
 * - `dontAsk` → judged as `default` TOO, and the `ask` that leaves is turned
 *   into a refusal by {@link commandHookUnpromptedDecision}. The page's own
 *   words make that the whole mode — `permission-modes.md#allow-only-pre-approved-tools-with-dontask-mode`:
 *   "Claude Code auto-denies every tool call that would otherwise prompt you.
 *   Claude still runs actions that need no approval in Manual mode". So an
 *   operator-declared hook's `ask` still runs unasked with its disclosure
 *   (D1.343 — no card, nothing to wait for), while a plugin's, a component's,
 *   the workspace tier's or an unattributed hook, which would get a card in
 *   Manual mode, is refused with a sentence naming the mode, never a card.
 * - `default`, `acceptEdits`, `auto`, `bypassPermissions` → judged in their own
 *   mode, unchanged; each already answers a hook with a run, an allow or a card.
 *
 * Everything that is not the mode still applies in every row: the floors
 * (denied paths, the read fence, the self-kill guard), deny rules and the
 * readable permission policy are evaluated before any mode branch in
 * `shouldAllowToolInMode`, so a deny is still a deny; a third party's hook
 * still gets a card, bounded by the hook's own budget (D1.333), wherever the
 * mode may prompt. `default` and not the mode plan mode will return to,
 * because that could be `bypassPermissions`, which would run a plugin's hook
 * with no card at all. One consequence stated rather than implied: an `ask`
 * RULE matching a user's own hook in `dontAsk` used to refuse it (the mode
 * turns an ask rule into a deny for the model's calls), and now lets it run —
 * the same D1.343 answer `default` gives that rule.
 */
export function commandHookGateMode<M extends string>(mode: M): M | 'default' {
  return mode === 'plan' || mode === 'dontAsk' ? 'default' : mode; // F1.1050: explore retired (read as plan)
}

/**
 * F1.771 — `dontAsk`'s other half: the host gate's answer for a command hook
 * in a session that must never show a card.
 *
 * {@link commandHookGateMode} judges a `dontAsk` session's hook as `default`,
 * so the gate can answer `ask`. D1.343 turns that `ask` into a run for an
 * operator-declared hook BEFORE this is consulted; whatever `ask` is left
 * would raise a card, which `dontAsk` promises never to do, so it becomes a
 * refusal whose reason says why the hook did not run. Every other mode, and
 * every `allow` and `deny`, passes through untouched.
 *
 * A refused hook then behaves as any refused hook does: a plugin hook reports a
 * non-blocking hook error; a native one blocks only on PreToolUse and the two
 * worktree events and is a notice on every other one (F1.1065, the page's
 * non-blocking bucket; `refusedHookIsNonBlocking` in `automations/hook-command.ts`).
 */
export function commandHookUnpromptedDecision<D extends { outcome: 'allow' | 'ask' | 'deny'; reason?: string }>(
  sessionMode: string,
  decision: D,
): D | { outcome: 'deny'; reason: string } {
  if (sessionMode !== 'dontAsk' || decision.outcome !== 'ask') return decision;
  return {
    outcome: 'deny',
    reason: `Command hook not run: it needs approval (${decision.reason ?? 'no reason given'}), `
      + `and ${PERMISSION_MODE_AGENT_LABELS.dontAsk} mode never prompts.`,
  };
}

/**
 * UA12.33 — whether a binding row must be shown INERT: an action that can never
 * run on the event the view names it under.
 *
 * The first case is a `script` action on an agent event. It rides the `command`
 * shape in {@link hookBindingHandlerType} (a spawned process is what the
 * vocabulary publishes), but no runner ever starts it: the host ScriptHandler
 * takes App events only (`automations/handlers/script-handler.ts`), and the
 * runtime hook dispatch — this module's own `executePluginHookAutomations` —
 * runs no `script` action either. Validation only warns the author
 * (`automations/validation.ts`), so the pairing loads and the view would show a
 * live-looking command hook that never fires.
 *
 * Kept a predicate rather than folded into the mapper so the renderer and the
 * projection agree on one definition, and appended BELOW this file's highest
 * doc-cited line (1773) per the hot-file rule — the row itself is set inside
 * `hookBindingsForMatcher` by a one-for-one line change.
 *
 * F1.786 (UB12.28) adds the second case. A `webhook` action on an agent event
 * now RUNS, as the `http` hook the view already calls it
 * ({@link webhookAsHttpHookAction}), so it is inert only where hooks.md's
 * per-event matrix withholds `http` — `SessionStart` today
 * ({@link hookTypeSupportedForEvent}); the dispatch loop skips it there by the
 * same predicate, so the view and the run cannot disagree.
 *
 * UB12.49 adds the third case: a native `prompt` action on an agent event. The
 * App-event PromptHandler returns early on every non-App event
 * (`automations/handlers/prompt-handler.ts`, upstream v0.15.1's too), and the
 * dispatch loop of {@link executePluginHookAutomations} takes `plugin-prompt`
 * only, so the action matched and did nothing, silently. It is marked inert
 * and warned at validation (`automations/validation.ts`) — UA12.33's shape —
 * rather than run: a native prompt STARTS A SESSION (connection, model,
 * labels), which is the PromptHandler's App-event authority, not a hook's
 * answer. Running it per tool call would be a second session-creation path;
 * upstream v0.15.1 does not run it either (`executeAgentEvent` only counts).
 */
export function isInertHookBinding(action: AutomationAction, event: AgentEvent): boolean {
  if (!AGENT_EVENTS.includes(event)) return false;
  return action.type === 'script' || action.type === 'prompt'
    || (action.type === 'webhook' && !hookTypeSupportedForEvent(event, 'http'));
}

/**
 * F1.786 (UB12.28) — a native `webhook` action bound to an AGENT event,
 * dispatched as the `http` hook {@link hookBindingHandlerType} has always
 * advertised it as.
 *
 * Measured live on packaged RC4 `b72bb163d` (lane L5F3, 2026-10-10/11): a
 * user-tier `PreToolUse` matcher with `[command, webhook]` ran the command and
 * delivered 0 bodies to a loopback sink that the automations "Run test" path
 * reached, with no notice anywhere. The dispatch loop of
 * {@link executePluginHookAutomations} had no `webhook` branch, so the action
 * matched and vanished — on the host tiers and on the claude SDK route alike,
 * since `buildSdkHooksForConfig` funnels into the same executor. The App-event
 * `WebhookHandler` returns early on every non-App event (upstream v0.15.1's
 * does too), so nothing else ran it.
 *
 * The fix is QUESTIONS.md TL5F3-1's default (a): no second executor. The
 * action joins the `plugin-http` entries, so it gets the same URL dedupe, the
 * same two refusal guards with their `hookErrors` notices
 * ({@link isSafePluginHookHttpUrl}, {@link isCredentialBearingPluginHttpDescriptor}),
 * the same "no runner, reported" arm, and the same injected
 * {@link PluginHttpHookRunner}, whose presence is the network grant and whose
 * host side owns trust, the managed URL allowlist, the permission check and
 * the receipt. What that makes true, stated rather than implied:
 *  - The response is the hook's ANSWER under the http-hook contract
 *    ({@link applyHookRunnerVerdict}): an empty 2xx body is a clean run, a JSON
 *    object can decide, and a failure is a non-blocking notice. A 2xx
 *    plain-text answer such as a notification endpoint's `ok` never reaches
 *    the model's context (UB12.51) and, unlike a plugin http hook's, raises no
 *    notice (UB12.68, {@link isNativeWebhookHttpHookAction}); nor does an
 *    object that fails the schema or cannot be read, which also never fails
 *    closed (UB12.105). On App events the same action stays fire-and-forget.
 *  - `auth` is copied onto the descriptor ONLY so the fail-closed credential
 *    guard sees it: a webhook carrying `auth` is refused and reported, never
 *    sent without the credentials its author configured.
 *  - `bodyFormat` is carried on the descriptor for the runner's executor call
 *    (the http shape does not type it; a `form` body must not turn into JSON);
 *    `captureResponse` is not, because the response is the answer either way.
 *  - The descriptor kept here holds the templates as written; each dispatch
 *    expands them from the hook input before the guards read the request
 *    ({@link httpHookRequestDescriptor}, UB12.52). Until UB12.52 nothing
 *    expanded them, so a URL that is wholly a template was refused by the
 *    safe-url guard and one that still parsed went out with the literal text.
 *
 * Memoised per stored action object because the refusal and missing-runner
 * notices are deduplicated per ACTION object: a fresh adapter per dispatch
 * would report again on every tool call.
 */
const WEBHOOK_HTTP_HOOK_ACTIONS = new WeakMap<WebhookAction, PluginHttpHookAction>();
/**
 * UB12.68 — the adapted actions themselves, so the verdict reader can tell a
 * native `webhook` action from a plugin's `type: "http"` hook after the two
 * have joined one list ({@link isNativeWebhookHttpHookAction}).
 */
const NATIVE_WEBHOOK_HTTP_HOOK_ACTIONS = new WeakSet<object>();

function webhookAsHttpHookAction(action: WebhookAction): PluginHttpHookAction {
  const cached = WEBHOOK_HTTP_HOOK_ACTIONS.get(action);
  if (cached) return cached;
  const http = {
    url: action.url,
    ...(action.method ? { method: action.method } : {}),
    ...(action.headers ? { headers: action.headers } : {}),
    ...(action.body !== undefined ? { body: action.body } : {}),
    ...(action.bodyFormat ? { bodyFormat: action.bodyFormat } : {}),
    ...(action.auth ? { auth: action.auth } : {}),
  };
  const adapted: PluginHttpHookAction = { type: 'plugin-http', http };
  WEBHOOK_HTTP_HOOK_ACTIONS.set(action, adapted);
  NATIVE_WEBHOOK_HTTP_HOOK_ACTIONS.add(adapted);
  return adapted;
}

/**
 * UB12.68 — whether this http action is a native `webhook` action, whose 2xx
 * answer that is not a JSON object ({@link isPlainTextHookVerdictBody}) is a
 * clean run instead of hooks.md's non-blocking error; since UB12.105 also one
 * that opens `{` and is not valid hook output.
 *
 * Why the two kinds part here. hooks.md § HTTP response handling is the
 * contract of a Claude `type: "http"` hook, an endpoint written to answer the
 * hook protocol, and a plugin http hook keeps it: "2xx with any other body,
 * such as plain text: non-blocking error, handled the same as a non-2xx
 * status". A native `webhook` action is our automations' notification action
 * (docs-site automations overview: "POST to my Slack incoming-webhook URL"),
 * and its own contract is upstream's: v0.15.1's `executeWebhookRequest`
 * (`automations/webhook-utils.ts`, ours unchanged there) sets
 * `success = response.status >= 200 && response.status < 300` and reads the
 * body only to drain it or, with `captureResponse`, to store it in history.
 * Slack incoming webhooks answer `ok`. Under the http contract every
 * successful delivery on `PostToolUse` raised one `http-hook-error` warning per
 * tool call, for a request that worked.
 *
 * What still holds for a native webhook: the plain text never reaches the
 * model's context (UB12.51), and a VALID hook-output object is still read as
 * the hook's answer (UB12.28), so it can deny, stop or add context. A non-2xx,
 * a timeout and a refusal are still the notice.
 *
 * The question's other options were not taken. Keeping the notice is noise for
 * a delivery that worked. Reporting it once per action is still a warning that
 * says something failed. A separate code only renames that warning.
 *
 * UB12.105 — the same reading for a body that opens `{` and is not valid hook
 * output: an object that fails the output schema (UB12.70, e.g. a service's
 * own `{"continue":"yes"}`) and one that cannot be read (NDJSON, a truncated
 * object). Before it, the first raised one notice per dispatch and the second
 * failed CLOSED on `PreToolUse`, so a notification endpoint blocked every tool
 * call. Both are now the clean run upstream's `executeWebhookRequest` counts
 * every 2xx as, with nothing from the body applied. The safety trade is
 * stated: a native webhook pointed at a policy service that answers garbage no
 * longer blocks. A native webhook has no `onFailure` to ask for that, and a
 * plugin or hooks-file `type: "http"` hook, the documented policy shape, keeps
 * hooks.md § HTTP response handling and the fail-closed unreadable read.
 */
function isNativeWebhookHttpHookAction(action: object): boolean {
  return NATIVE_WEBHOOK_HTTP_HOOK_ACTIONS.has(action);
}

/**
 * UB12.52 — the request an http action sends: a plugin's `type: "http"` hook
 * as declared, a native `webhook` action with its templates expanded.
 *
 * The App-event `WebhookHandler` expands a webhook's url, headers and body
 * from `buildWebhookEnv` variables (`automations/utils.ts`: `NESSY_*` from the event,
 * `NESSY_WH_*` secrets from the shell). Until this row the agent-event route
 * sent the same action's templates as written, so a URL that is one template
 * was refused as a non-http URL and a body read `$NESSY_PROMPT` literally,
 * while docs-site's automations overview shows exactly that action on
 * `UserPromptSubmit`. Now the env is {@link buildAgentEventWebhookEnv}, from
 * the hook input, and the expansion runs before the safe-url and credential
 * guards, so both read the request that would be sent: a secret that expands
 * into a query `token=` or URL credentials is refused and reported, as a
 * literal one is.
 *
 * What is expanded and how, each choice stated:
 *  - `url`, every header value, and the body: a string body as one string,
 *    an object or array body leaf by leaf (string values only; keys and
 *    non-string values as written), so an inserted prompt or tool input that
 *    carries quotes or newlines cannot break the JSON or add fields. The
 *    App-event executor expands the body's JSON text instead (upstream
 *    v0.15.1's `executeWebhookRequest`), unchanged there.
 *  - One pass ({@link expandEnvVarsOnce}): text a variable inserts is never
 *    expanded again, so a tool input's `$HOME` stays literal and event text
 *    cannot name a secret into the request.
 *  - `auth` is not expanded: the credential guard refuses any webhook that
 *    carries it (UB12.28).
 *  - An unknown name expands to the empty string, as on App events.
 *
 * Residues, stated rather than hidden:
 *  - The host runner still applies hooks.md's header rule to every http
 *    action ("References to unlisted variables are replaced with empty
 *    strings", hooks.md#http-hook-fields), and a native webhook lists no
 *    `allowedEnvVars`, so a `$NAME` that an expanded value carries into a
 *    header is blanked there.
 *  - The credential guard reads event text too: a payload template whose
 *    expansion looks like a credential (`password=…`, `Bearer …`) or one
 *    string over 16 KiB (a large `$NESSY_EVENT_DATA`) refuses that dispatch,
 *    reported once per action.
 *  - Plugin and hooks-file `type: "http"` hooks keep hooks.md's contract
 *    (header interpolation through `allowedEnvVars` at the host runner, url
 *    and body as declared); only the native action is expanded here.
 */
function httpHookRequestDescriptor(
  action: PluginHttpHookAction,
  event: AgentEvent,
  input: SdkAutomationInput,
): PluginHttpHookAction['http'] {
  if (!isNativeWebhookHttpHookAction(action)) return action.http;
  const env = buildAgentEventWebhookEnv(event, input);
  const expand = (value: string): string => expandEnvVarsOnce(value, env);
  const { url, headers, body } = action.http;
  return {
    ...action.http,
    url: expand(url),
    ...(headers ? { headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, typeof value === 'string' ? expand(value) : value])) } : {}),
    ...(body !== undefined ? { body: expandWebhookBodyStrings(body, expand) } : {}),
  };
}

/** UB12.52 — a webhook body with every string leaf expanded; structure, keys and other values kept. */
function expandWebhookBodyStrings(value: unknown, expand: (value: string) => string): unknown {
  if (typeof value === 'string') return expand(value);
  if (Array.isArray(value)) return value.map(entry => expandWebhookBodyStrings(entry, expand));
  if (value && typeof value === 'object' && isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandWebhookBodyStrings(entry, expand)]));
  }
  return value;
}
