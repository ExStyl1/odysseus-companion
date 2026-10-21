import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { joinHookRunStreams } from '../agent/hook-run-report.ts';
import { hookDecisionPattern, hookEventStdoutCanDecide, preToolUseDecisionRank, projectHookDecisionForEvent, type HookDecisionPattern } from './hook-decision-contract.ts';
import { HOOK_ENV_FILE_EVENTS } from './hook-env-file.ts';
import { sanitizeForShell } from './security.ts';
import { expandEnvVars } from './utils.ts';
import type {
  AgentEvent,
  HookCommandAction,
  HookCommandActionResult,
  HookErrorNotice,
  HookUniversalOutput,
  PreToolUseDecision,
  PreToolUseDecisionValue,
  SdkAutomationInput,
} from './types.ts';

/** Native stored automations were written against this; it is not hooks.md's. */
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * hooks.md's largest documented default (600 seconds for `command`, `http` and
 * `mcp_tool`) is the ceiling. It used to be 120s, which is nowhere in the page
 * and silently truncated every hook that asked for the documented budget —
 * on `PreToolUse` a truncated timeout is `success: false`, which is a block.
 */
export const MAX_HOOK_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = MAX_HOOK_TIMEOUT_MS;

/**
 * The budget ONE command hook runs under — the single reader of
 * {@link DEFAULT_TIMEOUT_MS}, so the host's two enforcement sites cannot hold
 * two different numbers.
 *
 * ## C4.47 — the DIVERGENCE this host keeps, stated where a reader meets it
 *
 * `hooks.md#run-hooks-in-the-background`, verbatim: *"Once an async hook is
 * running in the background, Claude Code doesn't enforce `timeout` on it. Claude
 * Code still enforces `timeout` on a hook you run with `asyncRewake`."* The
 * `#common-fields` `timeout` row says the same from the other side: *"Seconds
 * before canceling. Claude Code doesn't enforce it on a command hook you run
 * with `async: true`. Defaults: 600 for `command`, `http`, and `mcp_tool`; 30
 * for `prompt`; 60 for `agent`."*
 *
 * **This host DOES enforce it, deliberately** (owner decision 2026-09-13, option
 * A — a runaway async hook stays bounded). The reason is not a preference: the
 * packaged path does not run this function at all. `SessionManager` injects a
 * `pluginCommandHookRunner` that starts every hook through
 * `processSupervisorPort.start({ background: false, timeoutMs })`, and
 * `timeoutMs` is a REQUIRED `number` on `SupervisedProcessStartRequest` — the
 * supervisor has no unbounded foreground mode. Its only exempt mode is
 * `background: true`, which resolves without the result and would break C3.301's
 * delivery seam (that seam AWAITS the run to emit `additionalContext` /
 * `systemMessage` and the `asyncRewake` exit-2 wake). Matching the page is a
 * supervisor-contract change, not a `Math.min` edit.
 *
 * ## What DOES move, because the old number was indefensible in both directions
 *
 * The budget enforced on a plain `async` hook WAS
 * {@link DEFAULT_TIMEOUT_MS} — 30 s, which is `hooks.md`'s default for a
 * `prompt` hook and smaller than its 600 s default for a `command` hook, applied
 * to the one kind of hook the page promises not to time out at all. The page's
 * own async example is a background `run-tests.sh` in a `hooks.json`; here it was
 * SIGTERM'd at 30 seconds, and an async hook's result is never read back for a
 * notice on the settings tier, so the author saw a hook that simply did not
 * finish. That is this fork's largest defect class — a divergence
 * indistinguishable from a defect.
 *
 * So a plain `async` hook that declares nothing gets the page's own documented
 * `command` budget, {@link MAX_HOOK_TIMEOUT_MS}. Three boundaries, each chosen
 * rather than fallen into:
 *  - `asyncRewake` is NOT included. The page enforces `timeout` on it by name
 *    (*"Claude Code still enforces `timeout` on a hook you run with
 *    `asyncRewake`"*), so its default stays 30 s and this host agrees with the
 *    page there rather than diverging in the generous direction.
 *  - a DECLARED `timeoutMs` still wins, async or not. An author who wrote a
 *    budget asked for that budget; the widening is about the default, which is
 *    what the host chooses when nobody asked.
 *  - the document-tier ceiling is NOT touched. `HookCommandActionSchema` caps a
 *    declared value at 120 000 ms and `frontmatterHookToAction` clamps with the
 *    same figure, so a settings document or a skill's frontmatter still cannot
 *    ASK for more than 120 s. That cap bounds what an untrusted document may
 *    request; this default is what the host grants when it requests nothing, and
 *    widening the first is a product posture with a different blast radius. The
 *    consequence is real and is recorded rather than hidden: an async hook
 *    DECLARING `timeout: 600` is still bound at 120 s while one declaring
 *    nothing gets 600 s.
 */
export function hookCommandBudgetMs(action: HookCommandAction): number {
  if (action.timeoutMs !== undefined) return Math.min(action.timeoutMs, MAX_TIMEOUT_MS);
  // `asyncRewake` implies `async`, and the page enforces `timeout` on it by
  // name — so the order of these two tests is the contract, not a style.
  if (action.async === true && action.asyncRewake !== true) return MAX_HOOK_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}
const OUTPUT_LIMIT = 8_192;
/**
 * hooks.md: "every output string is capped at 10,000 characters". This is the
 * per-FIELD cap on parsed hook output and is applied exactly once, here in the
 * parser, so no call site has to remember it. It is independent of
 * `OUTPUT_LIMIT`, which caps how much stdout/stderr we buffer from a subprocess.
 */
const HOOK_OUTPUT_FIELD_LIMIT = 10_000;
const SAFE_INHERITED_ENV_KEYS = ['HOME', 'PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP'];

function toEnvString(value: unknown): string | undefined {
  if (value == null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function setSanitized(env: Record<string, string>, key: string, value: unknown): void {
  const text = toEnvString(value);
  if (text) env[key] = sanitizeForShell(text);
}

export function buildHookCommandEnv(
  event: AgentEvent,
  input: SdkAutomationInput,
  actionEnv: Record<string, string> = {},
  /**
   * The per-session hook env file (R85 · f141), minted by the execution
   * authority that knows the session key. Optional and event-gated below, so a
   * caller that has no session — or an event the page excludes — simply leaves
   * both spellings unset.
   */
  envFilePath?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    NESSY_EVENT: event,
    NESSY_EVENT_DATA: sanitizeForShell(JSON.stringify(input)),
  };

  for (const key of SAFE_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  setSanitized(env, 'NESSY_TOOL_NAME', input.tool_name);
  setSanitized(env, 'NESSY_TOOL_INPUT', input.tool_input);
  setSanitized(env, 'NESSY_TOOL_RESPONSE', input.tool_response);
  setSanitized(env, 'NESSY_ERROR', input.error);
  setSanitized(env, 'NESSY_PROMPT', input.prompt);
  setSanitized(env, 'NESSY_SOURCE', input.source);
  setSanitized(env, 'NESSY_MODEL', input.model);
  setSanitized(env, 'NESSY_AGENT_ID', input.agent_id);
  setSanitized(env, 'NESSY_AGENT_TYPE', input.agent_type);
  setSanitized(env, 'NESSY_TASK_ID', input.task_id);
  setSanitized(env, 'NESSY_TASK_SUBJECT', input.task_subject);
  setSanitized(env, 'NESSY_TASK_DESCRIPTION', input.task_description);
  setSanitized(env, 'NESSY_MESSAGE', input.message);
  setSanitized(env, 'NESSY_TITLE', input.title);
  // hooks.md `:707` — "The level is also available to hook commands and the
  // Bash tool as the `$CLAUDE_EFFORT` environment variable." `CLAUDE_EFFORT` is
  // the only spelling the page gives and is therefore mandatory; `NESSY_EFFORT`
  // rides along by the same both-spellings convention the skills path already
  // uses (`SKILL_VARIABLE_SPELLINGS`). `setSanitized` no-ops on `undefined`, so
  // an absent effort leaves BOTH keys unset rather than defaulting to a level.
  //
  // Placed before the `actionEnv` loop below so a hook's own `env` can still
  // override. NOT added to `EXEC_FORM_PATH_PLACEHOLDERS`: the page calls this an
  // environment variable, and exec-form `$`-forms are documented to pass
  // through verbatim, so expanding it there would diverge rather than converge.
  setSanitized(env, 'NESSY_EFFORT', input.effort?.level);
  setSanitized(env, 'CLAUDE_EFFORT', input.effort?.level);

  // hooks.md § SessionStart, "Persist environment variables": "SessionStart
  // hooks have access to the `CLAUDE_ENV_FILE` environment variable, which
  // provides a file path where you can persist environment variables for
  // subsequent Bash commands", scoped by ":1059" to SessionStart, Setup,
  // CwdChanged and FileChanged — "Other hook types don't have access to this
  // variable". `HOOK_ENV_FILE_EVENTS` is that closed set minus `Setup`, which
  // this fork does not emit at all, and the gate is re-applied HERE rather than
  // trusted from the caller so no second execution authority can widen it.
  //
  // NOT `setSanitized`: `sanitizeForShell` backslash-escapes `$`, quotes and
  // backslashes, which would corrupt a legitimate absolute path into one that
  // does not exist. This is an env VALUE handed to `spawn`, never a string
  // spliced into a shell line — the same reason `pluginRuntimeEnv` emits its
  // roots raw. Placed before the `actionEnv` loop so `expandEnvVars` can
  // reference it and after the inherited keys so nothing can shadow it.
  if (envFilePath && HOOK_ENV_FILE_EVENTS.has(event)) {
    env.NESSY_ENV_FILE = envFilePath;
    env.CLAUDE_ENV_FILE = envFilePath;
  }

  for (const [key, value] of Object.entries(actionEnv)) {
    env[key] = expandEnvVars(value, env);
  }

  return env;
}

/**
 * hooks.md § Common fields, `timeout`: "Seconds before canceling. Defaults: 600
 * for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`.
 * `UserPromptSubmit` lowers the `command`, `http`, and `mcp_tool` default to 30
 * … `SessionEnd` hooks share a 1.5-second budget".
 *
 * This resolves an IMPORTED hook's timeout only. Stored native automations keep
 * `DEFAULT_TIMEOUT_MS`, which is the value they were authored against — the
 * documented defaults describe hooks.md's hooks, not Nessy's own.
 */
const DOCUMENTED_HOOK_TIMEOUT_DEFAULT_MS = 600_000;
const DOCUMENTED_PROMPT_HOOK_TIMEOUT_MS = 30_000;
const DOCUMENTED_AGENT_HOOK_TIMEOUT_MS = 60_000;
const USER_PROMPT_SUBMIT_HOOK_TIMEOUT_MS = 30_000;
/**
 * R32 · the same sentence's other lowering: "`MessageDisplay` lowers it to 10"
 * (hooks.md:345). A DEFAULT and not a ceiling — ":1271 The default timeout for
 * this event is 10 seconds; if your hook needs more time, set the `timeout`
 * field in the hook entry." The emitter clamps its own wait separately, because
 * the same page makes the batch BLOCK on the hook.
 */
const MESSAGE_DISPLAY_HOOK_TIMEOUT_MS = 10_000;
/**
 * hooks.md § SessionEnd: the shared budget is 1.5 seconds, and "Timeouts set on
 * plugin-provided hooks don't raise the budget" — so for an imported hook this
 * is a ceiling, not just a default.
 */
const SESSION_END_HOOK_BUDGET_MS = 1_500;
/**
 * D6 — the two platforms disagree on exactly this number, and the disagreement
 * is documented on both sides. Codex `hooks.md` § Notes, under `timeout`:
 * "`SessionEnd` uses `1` second by default and supports up to `3` seconds."
 * Claude's 1.5 s budget above is therefore Claude's alone; applying it to an
 * imported Codex hook halves a cleanup budget its author was told they had.
 *
 * The default stays at 1 s for a Codex SessionEnd hook that declares nothing,
 * which is the other half of the same sentence.
 */
const CODEX_SESSION_END_HOOK_BUDGET_MS = 3_000;
const CODEX_SESSION_END_HOOK_DEFAULT_MS = 1_000;

/**
 * Which platform's documented budgets an imported hook is read under. Callers
 * derive it from the plugin's normalized runtime-compatibility profile — never
 * from adapterId, origin or manifest format (see `PluginRuntimeContext`), and
 * `claude` is the fallback because it is the stricter of the two.
 */
export type ImportedHookDialect = 'claude' | 'codex';

export function resolveImportedHookTimeoutMs(
  event: AgentEvent,
  type: 'command' | 'http' | 'mcp' | 'prompt' | 'agent',
  declaredMs: number | undefined,
  dialect: ImportedHookDialect = 'claude',
): number {
  if (event === 'SessionEnd' && dialect === 'codex') {
    const declared = declaredMs !== undefined && Number.isFinite(declaredMs) && declaredMs > 0
      ? declaredMs
      : CODEX_SESSION_END_HOOK_DEFAULT_MS;
    return Math.min(declared, CODEX_SESSION_END_HOOK_BUDGET_MS);
  }
  const documentedDefault = type === 'prompt'
    ? DOCUMENTED_PROMPT_HOOK_TIMEOUT_MS
    : type === 'agent'
      ? DOCUMENTED_AGENT_HOOK_TIMEOUT_MS
      : event === 'UserPromptSubmit' || event === 'PreModelSwitch' || event === 'PostModelSwitch'
        // hooks.md#common-fields, the `timeout` row: Claude Code "lowers the
        // `command`, `http`, and `mcp_tool` default to 30 on `UserPromptSubmit`,
        // `PreModelSwitch`, and `PostModelSwitch`, and to 10 on `MessageDisplay`".
        // One constant, three events — the value is the same 30 s and
        // re-declaring it per event is how two of them drift.
        ? USER_PROMPT_SUBMIT_HOOK_TIMEOUT_MS
        : event === 'MessageDisplay'
          ? MESSAGE_DISPLAY_HOOK_TIMEOUT_MS
          : DOCUMENTED_HOOK_TIMEOUT_DEFAULT_MS;
  const ceiling = event === 'SessionEnd' ? SESSION_END_HOOK_BUDGET_MS : MAX_HOOK_TIMEOUT_MS;
  const declared = declaredMs !== undefined && Number.isFinite(declaredMs) && declaredMs > 0
    ? declaredMs
    : documentedDefault;
  return Math.min(declared, ceiling);
}

/**
 * The path placeholders hooks.md substitutes in exec form, in every spelling
 * the adapters and the runtime env emit. Deliberately a closed list rather than
 * "any environment variable": exec form says "special characters such as
 * apostrophes, `$`, and backticks pass through verbatim because there is no
 * shell to interpret them", so a bare `$HOME` in an argument is data, not a
 * reference. Only the brace form of a documented placeholder is a placeholder.
 */
const EXEC_FORM_PATH_PLACEHOLDERS = [
  'NESSY_PLUGIN_ROOT',
  'NESSY_PLUGIN_DATA',
  'NESSY_PROJECT_DIR',
  'PLUGIN_ROOT',
  'PLUGIN_DATA',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PROJECT_DIR',
] as const;

const EXEC_FORM_PLACEHOLDER_PATTERN = new RegExp(`\\$\\{(${EXEC_FORM_PATH_PLACEHOLDERS.join('|')})\\}`, 'g');

function substituteExecFormPlaceholders(value: string, env: Record<string, string>): string {
  return value.replace(EXEC_FORM_PLACEHOLDER_PATTERN, (match, name: string) => env[name] ?? match);
}

/**
 * The exec-form invocation of a command hook, or `undefined` for shell form.
 *
 * hooks.md § Exec form and shell form: in exec form "path placeholders like
 * `${CLAUDE_PLUGIN_ROOT}` are substituted into `command` and into each `args`
 * element as plain strings". There is no shell to expand them, so the host does
 * it here, against the very environment the hook is spawned with — and only for
 * those placeholders, because everything else is documented to survive
 * verbatim. Shell form is untouched: its shell already expands them, and
 * expanding twice would re-interpret whatever the first pass produced.
 */
export function resolveExecFormHookInvocation(
  action: Pick<HookCommandAction, 'command' | 'args'>,
  env: Record<string, string>,
): { command: string; args: string[] } | undefined {
  if (!action.args) return undefined;
  return {
    command: substituteExecFormPlaceholders(action.command, env),
    args: action.args.map(value => substituteExecFormPlaceholders(value, env)),
  };
}

/** Redact, then apply the documented 10,000-character per-field cap. */
function hookOutputField(text: string): string {
  const redacted = redactHookOutput(text);
  return redacted.length > HOOK_OUTPUT_FIELD_LIMIT ? redacted.slice(0, HOOK_OUTPUT_FIELD_LIMIT) : redacted;
}

export function redactHookOutput(text: string): string {
  if (!text) return text;
  return text
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s"']+/gi, '$1$2[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|pk|api)_[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

function appendCapped(current: string, chunk: Buffer | string): { next: string; truncated: boolean } {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
  const remaining = OUTPUT_LIMIT - current.length;
  if (remaining <= 0) return { next: current, truncated: true };
  const nextChunk = text.slice(0, remaining);
  return { next: current + nextChunk, truncated: nextChunk.length < text.length };
}

/**
 * The JSON decision object a hook printed, or `undefined` when its stdout is
 * not the documented decision form.
 *
 * hooks.md § JSON output: "Your hook's stdout must contain only the JSON
 * object". hooks.md § UserPromptSubmit decision control draws the same line from
 * the other side — "any non-JSON text written to stdout is added as context" —
 * and § MCP tool hook fields states the rule outright: "if it parses as valid
 * JSON output it is processed as a decision, otherwise it is shown as plain
 * text".
 *
 * So ONE test answers both questions. The decision parsers and the stdout
 * context channel all read this, which is what stops them from disagreeing
 * about whether a given stdout was a decision or was prose.
 */
function parseHookStdoutObject(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * UB12.70 — one field of the hook JSON output schema: its JSON type, or the
 * closed list of strings it may hold.
 */
export type HookOutputFieldSpec =
  | 'boolean'
  | 'string'
  | 'object'
  | 'array'
  | 'string-array'
  | 'any'
  | 'permission-request-decision'
  | { readonly oneOf: readonly string[] };

/** UB12.70 — one `hookSpecificOutput` branch: its fields, and the ones it requires besides `hookEventName`. */
export interface HookSpecificOutputBranch {
  readonly fields: Readonly<Record<string, HookOutputFieldSpec>>;
  readonly required?: readonly string[];
}

/**
 * UB12.70 — the top-level fields of the hook JSON output, as the shipped
 * bundle types them (`SyncHookJSONOutput`, `@anthropic-ai/claude-agent-sdk`'s
 * `sdk.d.ts`, claudeCodeVersion 2.1.280). `hookSpecificOutput` is checked on
 * its own, against {@link HOOK_SPECIFIC_OUTPUT_BRANCHES}.
 *
 * Top-level `decision` is only `"approve"` or `"block"`: hooks.md § Decision
 * control, "The only value for `decision` is `"block"`", and the PreToolUse
 * note, "The deprecated values `"approve"` and `"block"` map to `"allow"` and
 * `"deny"` respectively". That mapping is applied where the output is READ, on
 * PreToolUse only (UB12.98, {@link parseHookCommandOutput}).
 */
export const HOOK_OUTPUT_TOP_LEVEL_FIELDS: Readonly<Record<string, HookOutputFieldSpec>> = {
  continue: 'boolean',
  suppressOutput: 'boolean',
  stopReason: 'string',
  decision: { oneOf: ['approve', 'block'] },
  reason: 'string',
  systemMessage: 'string',
  terminalSequence: 'string',
};

const ADDITIONAL_CONTEXT_ONLY: HookSpecificOutputBranch = { fields: { additionalContext: 'string' } };
const WATCH_PATHS_ONLY: HookSpecificOutputBranch = { fields: { watchPaths: 'string-array' } };
const ELICITATION_FIELDS: HookSpecificOutputBranch = {
  fields: { action: { oneOf: ['accept', 'decline', 'cancel'] }, content: 'object' },
};

/**
 * UB12.70 — the twenty-two `hookSpecificOutput` branches the bundle declares,
 * keyed by their `hookEventName`, which is CLAUDE'S event name (`Elicitation`,
 * where this codebase says `McpElicitation`). The branch is chosen by the name
 * the hook printed, not by the event that fired, which is how the bundle's union
 * is checked. UB12.101 adds the CLI's separate rule that the name must be the
 * event that fired ({@link hookJsonOutputSchemaError}), and reads only the
 * fired branch's own fields under Claude's contract
 * ({@link claudeContractHookSpecificOutput}).
 */
export const HOOK_SPECIFIC_OUTPUT_BRANCHES: Readonly<Record<string, HookSpecificOutputBranch>> = {
  PreToolUse: {
    fields: {
      permissionDecision: { oneOf: ['allow', 'deny', 'ask', 'defer'] },
      permissionDecisionReason: 'string',
      updatedInput: 'object',
      additionalContext: 'string',
    },
  },
  UserPromptSubmit: { fields: { additionalContext: 'string', sessionTitle: 'string', suppressOriginalPrompt: 'boolean' } },
  UserPromptExpansion: { fields: { additionalContext: 'string', suppressOriginalPrompt: 'boolean' } },
  SessionStart: {
    fields: {
      additionalContext: 'string',
      initialUserMessage: 'string',
      sessionTitle: 'string',
      watchPaths: 'string-array',
      reloadSkills: 'boolean',
    },
  },
  Setup: ADDITIONAL_CONTEXT_ONLY,
  PreModelSwitch: { fields: { permissionDecision: { oneOf: ['allow', 'deny', 'ask'] }, permissionDecisionReason: 'string' } },
  PostModelSwitch: ADDITIONAL_CONTEXT_ONLY,
  SubagentStart: ADDITIONAL_CONTEXT_ONLY,
  PostToolUse: {
    fields: { additionalContext: 'string', classifierContext: 'string', updatedToolOutput: 'any', updatedMCPToolOutput: 'any' },
  },
  PostToolUseFailure: ADDITIONAL_CONTEXT_ONLY,
  PostToolBatch: ADDITIONAL_CONTEXT_ONLY,
  Stop: ADDITIONAL_CONTEXT_ONLY,
  SubagentStop: ADDITIONAL_CONTEXT_ONLY,
  PermissionDenied: { fields: { retry: 'boolean' } },
  Notification: ADDITIONAL_CONTEXT_ONLY,
  PermissionRequest: { fields: { decision: 'permission-request-decision' }, required: ['decision'] },
  Elicitation: ELICITATION_FIELDS,
  ElicitationResult: ELICITATION_FIELDS,
  CwdChanged: WATCH_PATHS_ONLY,
  FileChanged: WATCH_PATHS_ONLY,
  WorktreeCreate: { fields: { worktreePath: 'string' }, required: ['worktreePath'] },
  MessageDisplay: { fields: { displayContent: 'string' } },
};

/**
 * UB12.99 — the events this fork names differently from Claude Code, keyed by
 * our name, with Claude's spelling as the value. `McpElicitation` is Claude's
 * `Elicitation`: the one non-identity entry of `CLAUDE_HOOK_EVENT_MAP`
 * (`plugins/format-adapters.ts`), which imports a Claude plugin's `Elicitation`
 * hook under our name. `hook-claude-event-spelling.test.ts` derives the same
 * pairs from that map and fails when one appears or goes.
 *
 * Two readers, both under Claude's contract:
 * - **Input.** A hook held to Claude's contract reads Claude's spelling as its
 *   `hook_event_name` (`claudeContractHookInput`, `plugins/hooks-automation.ts`).
 *   hooks.md#elicitation-input shows `"hook_event_name": "Elicitation"`, and
 *   § Common input fields defines `hook_event_name` as "Name of the event that
 *   fired" (curl'd 2026-10-17). Before this row the host wrote our
 *   `McpElicitation` there (`BaseAgent.elicitationHookBase`), so a Claude
 *   plugin hook that checks for `Elicitation` never matched.
 * - **Output.** The fired event's `hookSpecificOutput` branch is the bundle's,
 *   which is keyed by Claude's names ({@link claudeHookEventName}).
 *
 * A PRINTED `hookEventName` is no longer translated. UB12.70 accepted our
 * `McpElicitation` there as an alias, because the host wrote that name on the
 * hook's stdin and an echoing hook must not fail. Those hooks now read
 * `Elicitation`, so the alias is retired. The CLI's own schema has no
 * `McpElicitation` branch either.
 */
export const CLAUDE_HOOK_EVENT_SPELLINGS: Readonly<Record<string, string>> = { McpElicitation: 'Elicitation' };

/**
 * Claude Code's spelling of an event this fork fired: `Elicitation` for our
 * `McpElicitation` ({@link CLAUDE_HOOK_EVENT_SPELLINGS}). Every other name is
 * its own, and a name that is already Claude's comes back unchanged.
 */
export function claudeHookEventName(event: string): string {
  return Object.hasOwn(CLAUDE_HOOK_EVENT_SPELLINGS, event) ? CLAUDE_HOOK_EVENT_SPELLINGS[event]! : event;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** What is wrong with one field's value, in words; empty when the spec admits it. */
function hookOutputFieldProblem(path: string, spec: HookOutputFieldSpec, value: unknown): string[] {
  if (typeof spec === 'object') {
    return typeof value === 'string' && spec.oneOf.includes(value)
      ? []
      : [`${path} must be one of ${spec.oneOf.map(entry => `"${entry}"`).join(', ')}`];
  }
  switch (spec) {
    case 'any': return [];
    case 'boolean': return typeof value === 'boolean' ? [] : [`${path} must be true or false`];
    case 'string': return typeof value === 'string' ? [] : [`${path} must be a string`];
    case 'object': return isPlainJsonObject(value) ? [] : [`${path} must be an object`];
    case 'array': return Array.isArray(value) ? [] : [`${path} must be an array`];
    case 'string-array':
      return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? [] : [`${path} must be an array of strings`];
    case 'permission-request-decision': {
      // The bundle's two-armed union: `{behavior: "allow", updatedInput?,
      // updatedPermissions?}` or `{behavior: "deny", message?, interrupt?}`.
      // `updatedPermissions` is checked as an array; its entries' shape is the
      // permission-update schema, which this row does not restate.
      if (!isPlainJsonObject(value)) return [`${path} must be an object whose behavior is "allow" or "deny"`];
      if (value.behavior === 'allow') {
        return [
          ...('updatedInput' in value ? hookOutputFieldProblem(`${path}.updatedInput`, 'object', value.updatedInput) : []),
          ...('updatedPermissions' in value ? hookOutputFieldProblem(`${path}.updatedPermissions`, 'array', value.updatedPermissions) : []),
        ];
      }
      if (value.behavior === 'deny') {
        return [
          ...('message' in value ? hookOutputFieldProblem(`${path}.message`, 'string', value.message) : []),
          ...('interrupt' in value ? hookOutputFieldProblem(`${path}.interrupt`, 'boolean', value.interrupt) : []),
        ];
      }
      return [`${path}.behavior must be "allow" or "deny"`];
    }
  }
}

/**
 * UB12.70 — why a parsed hook JSON object fails the documented output schema,
 * or `undefined` when it passes.
 *
 * hooks.md § Exit code 0 (curl'd 2026-10-16), verbatim: "When Claude Code
 * tries to parse your stdout as JSON and can't, or the parsed object fails
 * schema validation, the run is a non-blocking error. The `<hook name> hook
 * error` notice carries the parse or validation message. On the events that
 * add plain-text stdout as context, Claude Code doesn't add stdout it failed to
 * parse." § HTTP response handling says it of an http body ("A body that fails
 * schema validation is a non-blocking error"), and § MCP tool hook fields reads
 * an mcp_tool hook's text "the same way it reads command-hook stdout".
 *
 * The page names the schema without spelling it out, so its MEMBERSHIP comes
 * from the vendored bundle (AGENTS.md: the docs are the contract for
 * behaviour, the bundle for membership): `SyncHookJSONOutput` and its
 * twenty-two `*HookSpecificOutput` branches in `sdk.d.ts`, read into
 * {@link HOOK_OUTPUT_TOP_LEVEL_FIELDS} and {@link HOOK_SPECIFIC_OUTPUT_BRANCHES}.
 * `hook-output-schema.test.ts` re-reads the d.ts and fails when a branch or a
 * field appears or goes. The native binary of the same version (2.1.280) was
 * read as the control on 2026-10-17 and checks the same fields with the same
 * types.
 *
 * What fails: a known field holding another JSON type (`null` included — an
 * optional field is absent or typed, never null), an enum field holding a
 * value outside its list, a `hookSpecificOutput` that is not an object, has no
 * `hookEventName`, or names no branch, and a branch's required field missing.
 * Our `McpElicitation` names no branch since UB12.99
 * ({@link CLAUDE_HOOK_EVENT_SPELLINGS}); its message names Claude's spelling.
 * An UNKNOWN key does not fail: the bundle's objects are not strict, and the
 * CLI only logs the keys it ignores ("Hook JSON output had unrecognized keys
 * (ignored)", 2.1.280 binary). It is not APPLIED either: under Claude's
 * contract the read takes only the schema's fields
 * ({@link parseHookCommandOutput}, UB12.101). Not applied here, stated: the
 * shape of `updatedPermissions` entries.
 *
 * UB12.101 — with `firedEvent`, a `hookSpecificOutput` that names a branch
 * other than the fired event's also fails. hooks.md § JSON output: it
 * "requires a `hookEventName` field set to the event name"; the 2.1.280 CLI
 * throws "Hook returned incorrect event name" when it differs, and its catch
 * makes the run a non-blocking error. The fired event is compared in Claude's
 * spelling ({@link claudeHookEventName}): our `McpElicitation` fires the
 * `Elicitation` branch. Without `firedEvent` the check is the event-agnostic
 * one UB12.70 landed.
 *
 * The message names paths and expected types and never a value the hook
 * printed, so the notice that carries it cannot carry a secret; the event it
 * names is the host's own.
 */
export function hookJsonOutputSchemaError(parsed: Record<string, unknown>, firedEvent?: string): string | undefined {
  const problems: string[] = [];
  for (const [field, spec] of Object.entries(HOOK_OUTPUT_TOP_LEVEL_FIELDS)) {
    if (field in parsed) problems.push(...hookOutputFieldProblem(field, spec, parsed[field]));
  }
  if ('hookSpecificOutput' in parsed) {
    const specific = parsed.hookSpecificOutput;
    if (!isPlainJsonObject(specific)) {
      problems.push('hookSpecificOutput must be an object');
    } else if (!('hookEventName' in specific)) {
      problems.push('hookSpecificOutput is missing its required field hookEventName');
    } else {
      const named = typeof specific.hookEventName === 'string' ? specific.hookEventName : undefined;
      const branch = named !== undefined && Object.hasOwn(HOOK_SPECIFIC_OUTPUT_BRANCHES, named)
        ? HOOK_SPECIFIC_OUTPUT_BRANCHES[named]
        : undefined;
      if (!branch) {
        // UB12.99 — our own spelling gets Claude's in its message: the hook
        // read that spelling on its stdin, so the fix is to echo it back.
        problems.push(named !== undefined && Object.hasOwn(CLAUDE_HOOK_EVENT_SPELLINGS, named)
          ? `hookSpecificOutput.hookEventName must be "${CLAUDE_HOOK_EVENT_SPELLINGS[named]}", Claude Code's name for this event`
          : 'hookSpecificOutput.hookEventName names no event that takes hookSpecificOutput');
      } else {
        const expected = firedEvent === undefined ? undefined : claudeHookEventName(firedEvent);
        if (expected !== undefined && expected !== named) {
          problems.push(`hookSpecificOutput.hookEventName must be "${expected}", the event that fired`);
        }
        for (const required of branch.required ?? []) {
          if (!(required in specific)) problems.push(`hookSpecificOutput.${required} is required for this event`);
        }
        for (const [field, spec] of Object.entries(branch.fields)) {
          if (field in specific) problems.push(...hookOutputFieldProblem(`hookSpecificOutput.${field}`, spec, specific[field]));
        }
      }
    }
  }
  if (problems.length === 0) return undefined;
  // The likeliest mistake gets its way out: this fork's native hooks DO take
  // these four at the top level (docs-site automations overview), Claude's do not.
  const misplaced = typeof parsed.decision === 'string' && ['allow', 'deny', 'ask', 'defer'].includes(parsed.decision)
    ? ' (a permission decision goes in hookSpecificOutput.permissionDecision on PreToolUse, or in hookSpecificOutput.decision.behavior on PermissionRequest)'
    : '';
  return `Hook output failed schema validation: ${problems.join('; ')}${misplaced}`;
}

/** UB12.70 — the parse half of the page's message, in our words. */
export const HOOK_OUTPUT_PARSE_FAILURE = 'Hook output opens a JSON object that cannot be parsed';

/**
 * UB12.70 — the documented non-blocking error a hook's JSON output raises, as
 * the transcript notice's message, or `undefined` when the output is valid JSON
 * output or plain text.
 *
 * Output that does not open `{` is plain text (hooks.md § Exit code 0). Output
 * that opens one and is not a JSON object is a parse failure — including a
 * stdout that never closes it, which the page reads as plain text: this is the
 * line `isUnreadableHookVerdictBody` (plugins/hooks-automation.ts) already
 * draws for `onFailure` and the http/mcp_tool verdicts, and a hook that died
 * half way through printing its decision has not written prose. The page's
 * multi-line rule (several lines that each parse are plain text unless one of
 * them sets an output field) is not applied either: such output is a parse
 * failure here, as it already was for those two readers.
 *
 * `firedEvent` (UB12.101) adds the event-name rule; every executor call site
 * passes it.
 */
export function hookStdoutJsonFailure(stdout: string, firedEvent?: string): string | undefined {
  if (!stdout.trim().startsWith('{')) return undefined;
  const parsed = parseHookStdoutObject(stdout);
  return parsed ? hookJsonOutputSchemaError(parsed, firedEvent) : HOOK_OUTPUT_PARSE_FAILURE;
}

/**
 * UB12.100 — the PARSE half of {@link hookStdoutJsonFailure} alone:
 * {@link HOOK_OUTPUT_PARSE_FAILURE} when the stdout opens `{` and is not a JSON
 * object (the same line, unclosed and multi-line output included), else
 * `undefined`. No schema is applied, so an object this fork's native vocabulary
 * writes (a top-level `allow`, an `updatedInput`) passes.
 *
 * This is what a hook that does NOT speak Claude's output contract gets (a
 * native `actions` hook, a codex or `nessy-plugin.json` command hook): the
 * page's parse rule is about the bytes, not the fields, and "On the events that
 * add plain-text stdout as context, Claude Code doesn't add stdout it failed to
 * parse" (`hooks.md#exit-code-0`, curl'd 2026-10-17). Codex's own engine
 * agrees for the context events: the staged `codex-app-server 0.162.0` carries
 * "hook returned invalid user prompt submit JSON output" and "hook returned
 * invalid session start JSON output".
 */
export function hookStdoutParseFailure(stdout: string): string | undefined {
  return stdout.trim().startsWith('{') && !parseHookStdoutObject(stdout) ? HOOK_OUTPUT_PARSE_FAILURE : undefined;
}

/**
 * The four events whose exit-0 stdout is CONTEXT rather than a debug line.
 *
 * hooks.md § Exit code 0 (curl'd 2026-10-17), verbatim: "For most events,
 * Claude Code writes stdout to the debug log and doesn't show it in the
 * transcript. The exceptions are `UserPromptSubmit`, `UserPromptExpansion`,
 * `SessionStart`, and `PostModelSwitch`, where Claude Code adds plain-text
 * stdout as context that Claude can see and act on." hooks-guide.md § Exit
 * codes names the first three, and its re-inject-after-compaction recipe
 * depends on nothing else: "Any text your command writes to stdout is added to
 * Claude's context."
 *
 * UB12.69 — `PostModelSwitch` joined the page's sentence after this list was
 * written with the older three. Its context is not delivered by the turn that
 * fired it, because no turn did: `hooks.md#postmodelswitch-decision-control`
 * says Claude Code "takes your hook's plain-text stdout on exit 0, or
 * `additionalContext` from JSON output, and delivers it to Claude with the next
 * request after the switch". The host fires the event on all three runtimes
 * (`SessionManager.updateSessionModel` and `flushPendingModelSwitchHook`),
 * keeps the result as the session's pending model-switch context, and the send
 * path adds it to the next prompt.
 *
 * The list is CLOSED. On every other event a hook that prints prose has printed
 * a diagnostic, and injecting it would put unreviewed text in front of the model
 * on events the docs never gave that power.
 */
const STDOUT_CONTEXT_EVENTS: readonly AgentEvent[] = ['UserPromptSubmit', 'UserPromptExpansion', 'SessionStart', 'PostModelSwitch'];

/** True when this event's exit-0 stdout is documented to reach the model. */
export function hookEventStdoutIsContext(event: AgentEvent): boolean {
  return STDOUT_CONTEXT_EVENTS.includes(event);
}

/**
 * The context one command hook's exit-0 stdout contributes, or `undefined`.
 *
 * Four gates, each a documented sentence:
 * - the event is one of the four above;
 * - the hook exited 0 — "JSON output is only processed on exit 0" and exit 2
 *   "ignores stdout", so neither channel reads a failed run;
 * - the stdout is NOT the JSON decision object. A hook that legitimately echoes
 *   a JSON snippet as context is the ambiguous case, and the docs resolve it in
 *   favour of the decision: stdout "must contain only the JSON object", so a
 *   bare object IS a decision. A JSON array, a bare scalar, or prose with an
 *   object after it does not open `{` and travels as text;
 * - the stdout is NOT a parse failure ({@link hookStdoutParseFailure}, UB12.100):
 *   "Claude Code doesn't add stdout it failed to parse" (`hooks.md#exit-code-0`).
 *   The executor raises that run's notice and never reaches this read; the gate
 *   keeps the function from answering otherwise for any hook, native included.
 *
 * hooks.md § JSON output caps "plain stdout" at 10,000 characters alongside
 * `additionalContext`, which `hookOutputField` applies.
 */
export function hookCommandStdoutContext(
  event: AgentEvent,
  result: Pick<HookCommandActionResult, 'success' | 'stdout'>,
): string | undefined {
  if (!hookEventStdoutIsContext(event) || !result.success) return undefined;
  const stdout = result.stdout ?? '';
  if (parseHookStdoutObject(stdout) || hookStdoutParseFailure(stdout)) return undefined;
  const text = hookOutputField(stdout).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * UB12.98 — what reading a hook's stdout needs besides the bytes: the event
 * that fired, and whether the hook was authored to CLAUDE'S output contract.
 * Both are optional so an event-agnostic read (a context or universal-field
 * probe) keeps its old answer.
 */
export interface HookOutputReading {
  readonly event?: AgentEvent | string;
  /**
   * The hook speaks Claude's output contract: a command hook whose action says
   * `blockOnNonZero: false` (the marker UB12.70 and UB12.93 key on), or any
   * http or mcp_tool body, which UB12.70 already validates against the bundle's
   * schema.
   */
  readonly claudeContract?: boolean;
}

/**
 * UB12.98 — does this read take PreToolUse's DEPRECATED top-level `decision`
 * spellings? `hooks.md#pretooluse-decision-control` (curl'd 2026-10-17),
 * verbatim: "PreToolUse previously used top-level `decision` and `reason`
 * fields, but these are deprecated for this event. … The deprecated values
 * `"approve"` and `"block"` map to `"allow"` and `"deny"` respectively."
 *
 * The bundle lets `approve` through on every event (`SyncHookJSONOutput`
 * `decision?: 'approve' | 'block'`), so this gate is what keeps the mapping
 * where the page puts it:
 * - **PreToolUse only.** No other event documents `approve`: `PreModelSwitch`
 *   and the elicitation pair name `decision: "block"` alone, and
 *   `PermissionRequest` decides through `decision.behavior`. Elsewhere it
 *   stays no decision, as before.
 * - **The Claude contract only.** A native `actions` hook and a codex or
 *   `nessy-plugin.json` command hook keep this fork's own top-level vocabulary
 *   (`allow`, `ask`, `block`, `deny`, `defer`; docs-site automations overview),
 *   which has never had an `approve`, so one is still read as nothing there.
 *
 * `"block"` needs no mapping: it is already a candidate on every read and ranks
 * WITH `deny` (`PRE_TOOL_USE_DECISION_PRECEDENCE`), and every PreToolUse
 * consumer treats the two alike (`isBlockingHookDecision`).
 */
function readsDeprecatedPreToolUseDecision(reading: HookOutputReading | undefined): boolean {
  return reading?.claudeContract === true && reading.event === 'PreToolUse';
}

/**
 * UB12.101 — the `hookSpecificOutput` a Claude-contract read may apply: the
 * branch the hook named, cut to that branch's own fields
 * ({@link HOOK_SPECIFIC_OUTPUT_BRANCHES}), or nothing when the object names no
 * branch or, with `event`, names a branch other than the fired event's.
 *
 * This is what the CLI does with the same bytes. The bundle's objects are not
 * strict, so its parse STRIPS a key outside the branch the printed
 * `hookEventName` selects and only logs it: "Hook JSON output had unrecognized
 * keys (ignored)" (2.1.280 binary). Its reader then switches on that name and
 * reads only that branch's fields, after throwing "Hook returned incorrect
 * event name" when the name is not the fired event. hooks.md § JSON output:
 * `hookSpecificOutput` "requires a `hookEventName` field set to the event
 * name". The executor raises that mismatch as the non-blocking error
 * ({@link hookStdoutJsonFailure} with the event) before reading; dropping the
 * object here keeps every other read path (async notes) from applying it.
 */
function claudeContractHookSpecificOutput(
  raw: unknown,
  event: string | undefined,
): Record<string, unknown> | undefined {
  if (!isPlainJsonObject(raw) || typeof raw.hookEventName !== 'string') return undefined;
  const named = raw.hookEventName;
  if (!Object.hasOwn(HOOK_SPECIFIC_OUTPUT_BRANCHES, named)) return undefined;
  if (event !== undefined && claudeHookEventName(event) !== named) return undefined;
  const own: Record<string, unknown> = { hookEventName: raw.hookEventName };
  for (const field of Object.keys(HOOK_SPECIFIC_OUTPUT_BRANCHES[named]!.fields)) {
    if (Object.hasOwn(raw, field)) own[field] = raw[field];
  }
  return own;
}

export function parseHookCommandOutput(stdout: string, reading?: HookOutputReading): PreToolUseDecision | undefined {
  const parsed = parseHookStdoutObject(stdout);
  if (!parsed) return undefined;

  try {
    // UB12.101 — Claude's contract reads the schema's fields only: the
    // top-level ones in HOOK_OUTPUT_TOP_LEVEL_FIELDS, with their schema
    // meaning, and the fired branch's own (`claudeContractHookSpecificOutput`).
    // The fork's own contract keeps its wider reading (docs-site automations
    // overview: a top-level `decision` of allow/ask/block/deny, a top-level
    // `updatedInput`), and `topLevelFallback` is where that reading lives.
    const claudeContract = reading?.claudeContract === true;
    const hookSpecificOutput = claudeContract
      ? claudeContractHookSpecificOutput(parsed.hookSpecificOutput, reading?.event)
      : isPlainJsonObject(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput : undefined;
    const topLevelFallback: Record<string, unknown> | undefined = claudeContract ? undefined : parsed;
    const decision: PreToolUseDecision = {};
    // Claude's documented precedence is deny > ask > allow: "If any hook returns
    // deny, the operation is blocked regardless of other hooks." Rank the
    // candidates rather than assigning in source order, so a nested deny cannot
    // be undone by a top-level `continue: true` or `decision: 'allow'` that
    // happens to be parsed later.
    const candidates: Array<PreToolUseDecisionValue> = [];
    if (parsed.continue === false) candidates.push('block');
    // UB12.101 — a fork-contract `continue: true` is an allow. Under Claude's
    // contract it is the field's default and decides nothing: hooks.md § JSON
    // output gives `continue` one effect, "If `false`, Claude stops processing
    // entirely", and the CLI reads it only when it is false.
    else if (parsed.continue === true && !claudeContract) candidates.push('allow');
    if (claudeContract) {
      // UB12.101 — the schema's own two values (`decision?: 'approve' |
      // 'block'`); the schema check refuses the rest before a read gets here.
      if (parsed.decision === 'block') candidates.push('block');
      else if (parsed.decision === 'approve' && readsDeprecatedPreToolUseDecision(reading)) {
        // UB12.98 — the deprecated PreToolUse `approve` is an `allow`, and it is
        // ranked here with the other candidates, so a nested `ask` or `deny`
        // beside it still wins.
        candidates.push('allow');
      }
    } else if (['allow', 'ask', 'block', 'deny', 'defer'].includes(String(parsed.decision))) {
      candidates.push(parsed.decision as PreToolUseDecisionValue);
    }
    // `permissionDecision` lives inside `hookSpecificOutput`, never at the top
    // level.
    const nested = hookSpecificOutput?.permissionDecision;
    if (nested === 'deny' || nested === 'allow' || nested === 'ask' || nested === 'defer') candidates.push(nested);
    // PermissionRequest output contract (hooks.md#permissionrequest):
    // `hookSpecificOutput.decision` = { behavior: 'allow' | 'deny',
    // updatedInput/updatedPermissions (allow only), message/interrupt (deny
    // only) }. The allow-only/deny-only pairing is enforced here — fields on
    // the wrong behavior are ignored.
    const bandDecision = hookSpecificOutput?.decision && typeof hookSpecificOutput.decision === 'object'
      && !Array.isArray(hookSpecificOutput.decision)
      ? hookSpecificOutput.decision as Record<string, unknown>
      : undefined;
    const bandBehavior = bandDecision?.behavior === 'allow' || bandDecision?.behavior === 'deny'
      ? bandDecision.behavior
      : undefined;
    if (bandBehavior) candidates.push(bandBehavior);
    if (bandBehavior === 'deny' && bandDecision?.interrupt === true) decision.interrupt = true;
    if (bandBehavior === 'allow' && Array.isArray(bandDecision?.updatedPermissions)) {
      decision.updatedPermissions = bandDecision.updatedPermissions as Array<Record<string, unknown>>;
    }
    // Documented precedence, from the one table that spells it
    // (`hook-decision-contract.ts`, `PRE_TOOL_USE_DECISION_PRECEDENCE`). This
    // file used to carry its own copy — the third of three (P3.194).
    const winner = candidates.sort(
      (a, b) => preToolUseDecisionRank(b) - preToolUseDecisionRank(a),
    )[0];
    if (winner) decision.decision = winner;

    if (typeof parsed.reason === 'string') {
      decision.reason = hookOutputField(parsed.reason);
    } else if (typeof hookSpecificOutput?.permissionDecisionReason === 'string') {
      decision.reason = hookOutputField(hookSpecificOutput.permissionDecisionReason);
    } else if (bandBehavior === 'deny' && typeof bandDecision?.message === 'string') {
      // PermissionRequest spells the deny reason `message` (deny-only).
      decision.reason = hookOutputField(bandDecision.message);
    }
    // UB12.101 — the three top-level spellings below are the fork contract's
    // (`topLevelFallback`). Claude's schema has none of them: its CLI strips a
    // top-level `additionalContext` with the hint "Did you mean
    // hookSpecificOutput.additionalContext (with a hookEventName)?".
    const additionalContext = hookSpecificOutput?.additionalContext ?? topLevelFallback?.additionalContext;
    if (typeof additionalContext === 'string') decision.additionalContext = hookOutputField(additionalContext);
    const updatedInput = hookSpecificOutput?.updatedInput
      ?? topLevelFallback?.updatedInput
      // PermissionRequest carries updatedInput inside `decision`, allow-only.
      ?? (bandBehavior === 'allow' ? bandDecision?.updatedInput : undefined);
    if (updatedInput && typeof updatedInput === 'object' && !Array.isArray(updatedInput)) {
      decision.updatedInput = updatedInput as Record<string, unknown>;
    }
    // PermissionDenied's whole documented output (hooks.md#permissiondenied).
    if (hookSpecificOutput?.retry === true) decision.retry = true;
    // `updatedMCPToolOutput` is marked DEPRECATED on agent-sdk/hooks.md and is
    // deliberately NOT implemented: `updatedToolOutput` already covers MCP tools,
    // and honouring both would give one hook two ways to rewrite the same result.
    // Named here so the refusal is a decision on record, not an oversight.
    // WorktreeCreate's http-hook spelling; the command-hook spelling is the last
    // stdout line and is read where the hook TYPE is known.
    if (typeof hookSpecificOutput?.worktreePath === 'string') {
      decision.worktreePath = hookOutputField(hookSpecificOutput.worktreePath);
    }
    const updatedToolOutput = hookSpecificOutput?.updatedToolOutput ?? topLevelFallback?.updatedToolOutput;
    if (typeof updatedToolOutput === 'string') decision.updatedToolOutput = hookOutputField(updatedToolOutput);
    // P7.14 · `classifierContext`, NESTED ONLY — the page shows it under
    // `hookSpecificOutput` and nowhere else
    // (`hooks.md#annotate-a-result-for-the-auto-mode-classifier`), unlike
    // `additionalContext` above, which it also shows at the top level. Read
    // event-agnostically like every other field here; the contract table is
    // what keeps it on `PostToolUse`.
    //
    // Capped by `hookOutputField` like its siblings and NOT re-capped to the
    // vendor's 2 000: *"Claude Code caps the notes for one tool call at 2,000
    // characters and truncates the rest. The cap is shared across every hook
    // that responds to that call"* — a budget shared across hooks can only be
    // spent by the runtime that sees all of them, and a second host-side
    // truncation beside the runtime's is the silent-divergence shape this fork
    // refuses elsewhere (see `buildClaudePreToolUseContinue` on `defer`).
    if (typeof hookSpecificOutput?.classifierContext === 'string') {
      decision.classifierContext = hookOutputField(hookSpecificOutput.classifierContext);
    }
    // `MessageDisplay`'s whole documented output (hooks.md:1311). Nested only —
    // the page shows it under `hookSpecificOutput` and nowhere else. Capped like
    // every other user-facing string; the contract table drops it on every other
    // event.
    if (typeof hookSpecificOutput?.displayContent === 'string') {
      decision.displayContent = hookOutputField(hookSpecificOutput.displayContent);
    }
    // `McpElicitation`/`ElicitationResult` (hooks.md §Elicitation, R24):
    // `hookSpecificOutput.{action, content}`. `content` is only meaningful on
    // an accept — a decline/cancel has no values to send — so it is dropped
    // otherwise rather than carried into a refusal. The contract table drops
    // both fields on every other event.
    // The `SessionStart` quartet (hooks.md:1059-1062) plus the `sessionTitle`
    // that `UserPromptSubmit` shares with it (:1266). NESTED ONLY: every
    // documented example puts all five under `hookSpecificOutput` (:1067-1071,
    // :1272-1278), unlike `additionalContext`/`updatedInput` which the page also
    // shows at the top level. Parsing is event-agnostic; the contract table is
    // what confines each field to the events that document it.
    if (typeof hookSpecificOutput?.sessionTitle === 'string') {
      decision.sessionTitle = hookOutputField(hookSpecificOutput.sessionTitle);
    }
    if (typeof hookSpecificOutput?.initialUserMessage === 'string') {
      decision.initialUserMessage = hookOutputField(hookSpecificOutput.initialUserMessage);
    }
    // Strict `true` only — a hook that prints the string "true" has not asked
    // for a re-scan, and a truthy coercion here would re-scan on `"false"`.
    if (hookSpecificOutput?.reloadSkills === true) decision.reloadSkills = true;
    // "Array of absolute paths": a relative entry is dropped rather than
    // resolved, because there is no documented base to resolve it against.
    if (Array.isArray(hookSpecificOutput?.watchPaths)) {
      const paths = hookSpecificOutput.watchPaths
        .filter((entry): entry is string => typeof entry === 'string' && isAbsolute(entry))
        .map(entry => hookOutputField(entry));
      if (paths.length > 0) decision.watchPaths = paths;
    }
    const action = hookSpecificOutput?.action;
    if (action === 'accept' || action === 'decline' || action === 'cancel') {
      decision.elicitationAction = action;
      const content = hookSpecificOutput?.content;
      if (action === 'accept' && content && typeof content === 'object' && !Array.isArray(content)) {
        decision.elicitationContent = content as Record<string, unknown>;
      }
    }
    return Object.keys(decision).length > 0 ? decision : undefined;
  } catch {
    return undefined;
  }
}

export interface ParsedHookOutput {
  universal: HookUniversalOutput;
  pattern: HookDecisionPattern;
  /** The event-specific surface, already projected onto its documented pattern. */
  payload: PreToolUseDecision;
}

/**
 * hooks.md: `terminalSequence` is restricted to OSC 0/1/2/9/99/777 and BEL.
 * "Everything else — CSI, OSC 8, OSC 52 clipboard, OSC 1337 — is rejected",
 * and rejection drops the whole field rather than sanitising it into a
 * different sequence.
 */
const ALLOWED_OSC_CODES = new Set(['0', '1', '2', '9', '99', '777']);
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function allowlistedTerminalSequence(value: string): string | undefined {
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === ESC) {
      // Only the OSC introducer is permitted; CSI/DCS/SOS/PM/APC are not.
      if (value[index + 1] !== ']') return undefined;
      const code = /^(\d{1,4})(?:[;]|$)/.exec(value.slice(index + 2))?.[1];
      if (!code || !ALLOWED_OSC_CODES.has(code)) return undefined;
      continue;
    }
    // Any other C0 control would move the cursor or clear the screen on its
    // own; BEL is the one documented bare notification.
    if (char < ' ' && char !== BEL && char !== '\n' && char !== '\t') return undefined;
  }
  return value;
}

function parseUniversalHookOutput(parsed: Record<string, unknown>): HookUniversalOutput {
  const universal: HookUniversalOutput = {};
  if (typeof parsed.continue === 'boolean') universal.continue = parsed.continue;
  if (typeof parsed.stopReason === 'string') universal.stopReason = hookOutputField(parsed.stopReason);
  if (typeof parsed.suppressOutput === 'boolean') universal.suppressOutput = parsed.suppressOutput;
  if (typeof parsed.systemMessage === 'string') universal.systemMessage = hookOutputField(parsed.systemMessage);
  if (typeof parsed.terminalSequence === 'string') {
    const allowed = allowlistedTerminalSequence(parsed.terminalSequence);
    if (allowed !== undefined) universal.terminalSequence = hookOutputField(allowed);
  }
  return universal;
}

/**
 * One parser, five shapes. Splits a hook's stdout into the universal fields
 * (every event) and the event-specific payload projected onto the pattern that
 * event actually speaks, so a call site can consume only what its event allows.
 *
 * `parseHookCommandOutput` remains the PreToolUse-shaped parse this wraps; the
 * projection is what makes the result per-event, not a second parser.
 */
export function parseHookOutputForEvent(
  stdout: string,
  event: AgentEvent,
  /** UB12.98 — whether the hook speaks Claude's output contract ({@link HookOutputReading}). */
  reading?: Pick<HookOutputReading, 'claudeContract'>,
): ParsedHookOutput {
  const pattern = hookDecisionPattern(event);
  const parsed = parseHookStdoutObject(stdout);
  if (!parsed) return { universal: {}, pattern, payload: {} };

  const universal = parseUniversalHookOutput(parsed);
  const parsedStdoutDecision = parseHookCommandOutput(stdout, { event, claudeContract: reading?.claudeContract });
  // An exit-code-only event has no documented `decision` FIELD: its two
  // mechanisms are exit 2 and `continue: false`. Its surface carries a block
  // value so an EXIT-CODE-derived block survives projection (R20), which must
  // not be read as inventing a stdout decision it never had.
  let payload: PreToolUseDecision = {};
  if (hookEventStdoutCanDecide(event)) {
    payload = projectHookDecisionForEvent(event, parsedStdoutDecision) ?? {};
  } else if (parsedStdoutDecision) {
    // R32 found the first event whose ENTIRE documented output is a NON-decision
    // field (`MessageDisplay`'s `displayContent`); the gate above — right about
    // decisions — dropped it, and it was carried back by naming the one field.
    // R64 found the second, third, fourth and fifth on `SessionStart`, so the
    // one-field escape hatch became a THIRD place the per-event surface had to
    // be mirrored, which is the drift both of these bugs are.
    //
    // Dropping the `decision` and projecting the rest is the general form: the
    // contract table stays the only gate, and R20's rule is unchanged because
    // it is about the `decision` field alone — an `exit-code-only` or
    // `path-return` event still cannot decide from stdout, and `reason` cannot
    // survive without the decision it explains (see `projectHookDecisionForEvent`).
    const { decision: _stdoutDecision, ...nonDecisionFields } = parsedStdoutDecision;
    payload = projectHookDecisionForEvent(event, nonDecisionFields) ?? {};
  }
  // `continue: false` is universal: it stops the agent on events that have no
  // `decision` field at all (the exit-code-only pattern) and outranks any
  // event-specific decision on the events that do. `stopReason` is deliberately
  // NOT copied into `reason` — it is the user-facing half.
  if (universal.continue === false) payload.decision = 'block';
  return { universal, pattern, payload };
}

/**
 * Merge the universal output of two hooks that ran for the same event. The
 * stopping/suppressing answer is sticky (any hook asking to stop stops, any hook
 * hiding its stdout hides it) and the first author of each user-facing string
 * keeps it — concatenating notifications from unrelated hooks would be noise.
 */
export function mergeHookUniversalOutputs(
  current: HookUniversalOutput | undefined,
  next: HookUniversalOutput | undefined,
): HookUniversalOutput | undefined {
  if (!current) return next && Object.keys(next).length > 0 ? next : undefined;
  if (!next) return Object.keys(current).length > 0 ? current : undefined;
  const merged: HookUniversalOutput = { ...current };
  if (next.continue === false || current.continue === false) merged.continue = false;
  else if (next.continue !== undefined && merged.continue === undefined) merged.continue = next.continue;
  if (next.suppressOutput === true || current.suppressOutput === true) merged.suppressOutput = true;
  else if (next.suppressOutput !== undefined && merged.suppressOutput === undefined) merged.suppressOutput = next.suppressOutput;
  if (merged.stopReason === undefined && next.stopReason !== undefined) merged.stopReason = next.stopReason;
  if (merged.systemMessage === undefined && next.systemMessage !== undefined) merged.systemMessage = next.systemMessage;
  if (merged.terminalSequence === undefined && next.terminalSequence !== undefined) merged.terminalSequence = next.terminalSequence;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The notice's `<hook name>`: a plugin hook's `<pluginId>/<hookId>`, a native automation's name, then its short id; F1.875 —
 * a nameless one (a hand-written `hooks.json` entry) the label claude 2.1.267 prints: the event, `<event>:<tool>` on a tool event.
 */
export function automationHookName(matcher: { name?: string; id?: string }, at?: { event?: string; toolName?: string }): string {
  const eventLabel = at?.event && at.toolName && /^(?:PreToolUse|PostToolUse|PostToolUseFailure)$/.test(at.event) ? `${at.event}:${at.toolName}` : at?.event;
  return matcher.name?.trim() || matcher.id?.trim() || eventLabel?.trim() || 'Automation';
}

/**
 * hooks.md: "Command hooks are deduplicated by command string and `args`" —
 * the DOCUMENTED key, exactly. `env` is deliberately outside it: the same
 * plugin hook installed under two marketplace ids differs only in its
 * provenance env and is one handler. `timeoutMs`/`async` differences on an
 * identical command resolve by registration order, the same first-wins rule
 * every other per-event merge in this file uses.
 */
export function commandHookDedupKey(action: Pick<HookCommandAction, 'command' | 'args'>): string {
  return JSON.stringify([action.command, action.args ?? null]);
}

/**
 * Keep the FIRST registration of each key (hooks.md: "identical handlers are
 * deduplicated automatically"), so every ordering-sensitive consumer — the
 * first-label spinner rule, additionalContext concatenation, decision reduce
 * order — sees the same sequence it would have without duplicates.
 */
export function dedupeHookEntries<T>(entries: readonly T[], keyOf: (entry: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const entry of entries) {
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

/** hooks.md: the transcript notice is the FIRST LINE of stderr, nothing more. */
function firstLine(value: string): string {
  const line = value.split(/\r?\n/).find(candidate => candidate.trim().length > 0);
  return (line ?? '').trim();
}

/**
 * The documented notice for a hook run that failed and did NOT block
 * (hooks.md § Exit code output). Returns `undefined` for a successful run, and
 * for a failure the caller already turned into a block — a blocking hook is
 * reported through its decision, not as an error notice.
 *
 * `stdout`/`stderr`/`output`/`error` are already redacted by the runner
 * (`runHookCommand` redacts both streams before it resolves, and the host
 * `pluginCommandHookRunner` calls `redactHookOutput` on its own refusals), so
 * this only picks the transcript line out of them.
 *
 * ## P6.449, the Pi arm — two things this could not say
 *
 * Pi has no hook channel of its own: THIS runner is Pi's hook mechanism (the
 * row's native clause, verbatim: *"pi is ours"*), so a Pi hook run becomes
 * legible here or nowhere. claude reads `SDKHookResponseMessage` and codex reads
 * `HookCompletedNotification`; both go through `reportHookRun`
 * (`agent/hook-run-report.ts`), and the SHARED half — which bytes a failure may
 * be described by — is {@link joinHookRunStreams}, reused here. The sentence is
 * NOT shared, on purpose: this path's wording is the page's own
 * (`hooks.md#other-exit-codes`: *"the transcript shows a `<hook name> hook
 * error` notice followed by the first line of stderr"*), which
 * `SessionManager.reportHookErrors` renders around `summary`.
 *
 * 1. **A TIMEOUT was shadowed by any byte on stderr.** The selection was
 *    `stderr || error || output`, and the runner puts its own sentence — `Hook
 *    command timed out after <n>ms.` — in `error`. A hook that printed one
 *    warning line and then hung reported that warning as the whole failure, and
 *    the fact that it was killed on the budget appeared on no surface. The
 *    timeout now LEADS, which also makes it the `summary` the transcript shows.
 * 2. **stdout was dropped whenever stderr had anything at all.** A hook that
 *    writes its diagnosis to stdout and a generic line to stderr showed only the
 *    generic line. `joinHookRunStreams` labels both — the same defect and the
 *    same fix as the claude arm's, which is why it is one function.
 */
export function buildHookErrorNotice(params: {
  event: string;
  hookName: string;
  result: HookCommandActionResult;
  blocked: boolean;
}): HookErrorNotice | undefined {
  const { event, hookName, result, blocked } = params;
  if (result.success || blocked) return undefined;
  // `error` stays the last resort it always was: the runner's own words for a
  // run that produced no streams at all — a shell that would not start, a host
  // refusal — reached only when both streams are empty.
  const lastResort = result.output ?? result.error;
  const streams = joinHookRunStreams({
    ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    ...(lastResort === undefined ? {} : { output: lastResort }),
  });
  const timeoutNote = result.timedOut
    ? (result.error?.trim() || 'Hook command timed out.')
    : '';
  const detail = (timeoutNote && !streams.includes(timeoutNote)
    ? [timeoutNote, streams].filter(text => text.length > 0).join('\n')
    : (streams || timeoutNote)
  ).trim();
  const summary = refusedHookSummary(result, firstLine(detail)) // F1.863 — a refused hook says it did not run, and which
    || `Hook command exited with code ${result.exitCode ?? 'unknown'}.`;
  return {
    hookName,
    event,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    summary,
    ...(detail && detail !== summary ? { detail } : {}),
  };
}

/**
 * C3.350 — the sentence a person meets when their OWN hook stalls and the stall
 * costs them their turn.
 *
 * C3.81 drove a packaged claude session carrying thirty-two command hooks and
 * met a block that named an event and a number and nothing else. On the host
 * path the equivalent reason was `result.error` alone — *"Hook command timed out
 * after 30000ms."* — which is one of the three facts a person needs and the
 * least useful one: it says a budget was exceeded without saying WHOSE budget or
 * what to do about it. On `UserPromptSubmit` that string IS the whole message
 * the person gets — `hooks.md#userpromptsubmit-decision-control`, the `reason`
 * row verbatim: *"Shown to the user when `decision` is `"block"`. Not added to
 * context"* — so there is no second surface on which to explain it.
 *
 * The POSTURE is unchanged and deliberately so: a native command hook whose run
 * fails blocks, and a stalled one has failed. The row asks for the sentence, not
 * for the trade — and the trade is the owner's, since failing OPEN on a timeout
 * would let through exactly the operations a policy hook was written to stop.
 *
 * Three things, which are the row's own three:
 * - **the hook** — its name from the matcher (`automationHookName`) and the
 *   event it was registered on, which together are how a person finds the entry
 *   in the document they wrote;
 * - **the budget** — the runner's own words, not a re-derived number: a
 *   host-injected command-hook runner enforces its own budget and states it, and
 *   recomputing one here would print a figure nothing measured;
 * - **the way out** — both of the documented ones.
 *   `hooks.md#userpromptsubmit`, verbatim: *"If your hook needs more time, set
 *   the `timeout` field in the hook entry."* And
 *   `hooks.md#run-hooks-in-the-background`, verbatim: *"Async hooks can't block
 *   or control Claude's behavior"* — which became reachable from a settings
 *   document and from skill frontmatter only with C3.334, one row earlier.
 */
export function hookTimeoutBlockReason(params: {
  action: HookCommandAction;
  result: HookCommandActionResult;
  hookName?: string;
  event?: string;
}): string {
  const { action, result, hookName, event } = params;
  const name = hookName?.trim();
  const subject = name && event && (name === event || name.startsWith(`${event}:`)) ? `A hook on ${name}` // F1.875: a label, no name
    : name ? (event ? `The "${name}" hook on ${event}` : `The "${name}" hook`)
    : (event ? `A hook on ${event}` : 'A hook');
  const budget = result.error?.trim()
    || `Hook command timed out after ${hookCommandBudgetMs(action)}ms.`;
  return `${subject} did not finish in time and was cancelled, so this operation was blocked instead of proceeding. ${budget} `
    + 'Give that hook more time with its `timeout` field, or run it with `async: true`, where a background hook cannot block. '
    // C4.47 — the sentence above was true about BLOCKING and misleading about the
    // kill: `async: true` stops a hook blocking, and this host still cancels it,
    // where `hooks.md#run-hooks-in-the-background` says the vendor does not
    // ("Claude Code doesn't enforce `timeout` on it"). Said here because this is
    // the one surface a person meets at the moment the budget matters — on
    // `UserPromptSubmit` this string IS the whole message they get. The number
    // is the one `hookCommandBudgetMs` actually grants, not a figure re-derived
    // for the sentence.
    + `A background hook is still cancelled here, at ${MAX_HOOK_TIMEOUT_MS}ms unless it declares its own \`timeout\`.`;
}

/**
 * UB12.93 — the events on which a non-zero exit decides by itself, so the JSON
 * of a Claude-contract run that exited 1 is NOT read there.
 *
 * `hooks.md#exit-code-output`, "Some events have their own rules" (curl'd
 * 2026-10-17), verbatim: "`WorktreeCreate`: any non-zero exit code makes
 * worktree creation fail, whatever your JSON says." — "`WorktreeRemove`: any
 * non-zero exit code makes worktree removal fail if the directory still exists
 * afterward." — "`Elicitation` and `ElicitationResult`: Claude Code applies
 * your `hookSpecificOutput` when your hook exits 0, and ignores it on any other
 * exit code." `Elicitation` is `McpElicitation` in this fork. `WorktreeCreate`
 * never gets the Claude contract (`adaptClaudeHookGroups` and `pluginHookAction`
 * exempt it); it is listed so a hand-spelled `blockOnNonZero: false` cannot
 * reopen it.
 */
const NON_ZERO_EXIT_DECIDES_EVENTS: ReadonlySet<string> = new Set([
  'WorktreeCreate', 'WorktreeRemove', 'McpElicitation', 'ElicitationResult',
]);

/**
 * UB12.93 — a Claude-contract command run that exited with a code other than 0
 * or 2 after printing JSON, read the way `hooks.md#exit-code-output` reads it:
 * as exit 0.
 *
 * The page's table, row "JSON object that passes schema validation" by column
 * "Any other exit code" (curl'd 2026-10-17), verbatim: "Success. Claude Code
 * ignores the exit code, and the fields alone decide. For hooks whose failure
 * blocks the action, the run counts as a failure instead". The paragraph above
 * the table: "when a `PreToolUse` hook exits 1 but prints JSON that passes
 * validation, that JSON can still decide what happens." Before this, such a run
 * was a non-blocking error whose stdout nobody parsed, so a policy hook that
 * exited 1 with `permissionDecision: "deny"` let the tool through.
 *
 * Returns the result with `success: true` (its `exitCode` kept, so the run row
 * still says what the process did) when every condition holds, else the result
 * unchanged:
 * - **the Claude contract**: `blockOnNonZero === false`, the marker
 *   `pluginHookAction` and `adaptClaudeHookGroups` set for the format a hook was
 *   authored in. A native hook keeps its own "any non-zero exit blocks";
 * - **the hook ran and exited 1, 3, …**: not a timeout ("discarding the hook's
 *   output"), not a refusal, not a signal, and not exit 2, whose block the
 *   fields "can't override";
 * - **its stdout opens a JSON object**. Whether that object parses and passes
 *   the schema is then decided exactly as on exit 0 (the executor's
 *   `claudeContractOutputFailure`), which is the table's second row: JSON that
 *   "can't be parsed or fails schema validation" is a "Non-blocking error. The
 *   notice carries the parse or validation message" under both columns. Plain
 *   text or nothing is the third row and stays the non-blocking error whose
 *   notice is stderr's first line;
 * - **the event lets the JSON decide** ({@link NON_ZERO_EXIT_DECIDES_EVENTS});
 * - **the hook's failure does not block** (`failureBlocks`): with `onFailure:
 *   "block"` on an event that honours it, the run "counts as a failure
 *   instead", so UB12.67's block stands and the JSON is not read. Only the
 *   caller knows the event's inertness and whether the turn was stopped, so it
 *   passes the answer in.
 *
 * Reading it as exit 0 is what makes every consumer agree at once: the decision
 * is parsed (`getHookCommandPreToolDecision`), no `<hook name> hook error`
 * notice is raised (`buildHookErrorNotice` returns nothing for a success), a
 * `once` hook is consumed ("removes the hook after its first successful run"),
 * and the observed run is a success.
 */
export function readClaudeContractExitAsDocumented(
  action: Pick<HookCommandAction, 'blockOnNonZero'>,
  result: HookCommandActionResult,
  event: string,
  failureBlocks: boolean,
): HookCommandActionResult {
  const exitCode = result.exitCode;
  const readsAsExitZero = action.blockOnNonZero === false
    && !failureBlocks
    && !result.success
    && result.timedOut !== true
    && result.refusedBeforeStart !== true
    && typeof exitCode === 'number' && exitCode !== 0 && exitCode !== 2
    && !NON_ZERO_EXIT_DECIDES_EVENTS.has(event)
    && (result.stdout ?? '').trim().startsWith('{');
  return readsAsExitZero ? { ...result, success: true } : result;
}

export function getHookCommandPreToolDecision(
  action: HookCommandAction,
  result: HookCommandActionResult,
  /**
   * C3.350 — who timed out, for the reason string. Optional so the dozens of
   * exit-code cases that do not need it keep their two-argument call; both
   * production call sites have both values in scope.
   */
  context?: { hookName?: string; event?: string },
): PreToolUseDecision | undefined {
  if (!result.success) {
    if (refusedHookIsNonBlocking(result, context?.event)) return undefined; // F1.863 — a notice, never a dropped prompt
    // `blockOnNonZero !== false` is the native-automation contract: ANY non-zero
    // exit blocks. Imported plugin hooks opt into Claude's three-way semantics by
    // setting it to false (see `pluginHookAction`), where only exit 2 blocks and
    // stderr is what the model is told — other non-zero codes are non-blocking
    // diagnostics.
    if (action.blockOnNonZero !== false) {
      return {
        decision: 'block',
        reason: hookOutputField(
          // C3.350 — a TIMEOUT gets the sentence above; every other failure
          // keeps the hook's own words, which are more specific than anything
          // this function could compose. A stalled hook produced no words at
          // all, which is exactly why it needed them supplied.
          result.timedOut
            ? hookTimeoutBlockReason({ action, result, ...context })
            : (result.output || result.error || `Hook command exited with code ${result.exitCode ?? 'unknown'}.`),
        ),
      };
    }
    // Exit 2 "blocks regardless of JSON content", so stdout is deliberately not
    // parsed here.
    if (result.exitCode === 2) {
      return {
        decision: 'block',
        reason: hookOutputField(result.stderr || result.output || result.error || 'Hook command reported a blocking error.'),
      };
    }
    // Any other non-zero is a non-blocking error: the action proceeds and the
    // model is not told. stdout is not parsed HERE: a run that printed JSON was
    // already read as exit 0 by {@link readClaudeContractExitAsDocumented}
    // (UB12.93, "the fields alone decide") before the executor called this, so
    // what reaches this line printed plain text or nothing, or its failure
    // blocks under `onFailure: "block"`.
    // The USER is told: the caller pairs this with `buildHookErrorNotice`, which
    // is what makes the documented `<hook name> hook error` notice appear
    // instead of the failure vanishing.
    return undefined;
  }

  // UB12.98 — the event and the contract decide whether PreToolUse's
  // deprecated `approve` is read ({@link HookOutputReading}).
  return parseHookCommandOutput(result.stdout ?? '', {
    event: context?.event,
    claudeContract: action.blockOnNonZero === false,
  });
}

/**
 * The exact bytes a command hook reads on stdin (D7).
 *
 * hooks.md § Hook input and output: "Command hooks receive JSON data via
 * stdin", and § Common input fields repeats it — "For command hooks, this JSON
 * arrives via stdin. For HTTP hooks, it arrives as the POST request body." One
 * UTF-8 JSON object, no trailing newline, so `input=$(cat)` in the documented
 * example yields exactly the object the page shows.
 *
 * `cwd` is a documented common field — "Current working directory when the hook
 * is invoked" — and is the one field the event input never carries for itself,
 * so it is filled here from the invocation rather than fabricated upstream.
 * Both execution authorities (this module's direct spawn and the host's
 * sandboxed runner) build the payload here, so the two cannot disagree about
 * what a hook reads.
 *
 * `hook_event_name` is the input's own. The executor has already put Claude's
 * spelling there for a hook held to Claude's contract (UB12.99,
 * `claudeContractHookInput` in `plugins/hooks-automation.ts`). Every other hook
 * keeps this fork's name, which `event` is the fallback for.
 *
 * NOT redacted, deliberately: the payload is the hook's whole purpose — the
 * documented `PreToolUse` example greps `.tool_input.command`, and a redacted
 * command is a policy hook that cannot judge. The same JSON already travels to
 * the same process in `NESSY_EVENT_DATA`, so stdin discloses nothing new, and
 * it is never logged. Redaction stays on the OUTPUT path (`redactHookOutput`),
 * which is what leaves the hook's trust boundary.
 */
export function hookCommandStdinPayload(
  event: AgentEvent,
  input: SdkAutomationInput,
  cwd?: string,
): string {
  return JSON.stringify({
    ...input,
    hook_event_name: input.hook_event_name || event,
    ...(input.cwd === undefined && cwd ? { cwd } : {}),
  });
}

/**
 * D1.333 — a hook approval that never arrives must end the WAIT, not the turn.
 *
 * ## The hang, and the ladder that names it
 *
 * RS-77's rig drove six `UserPromptSubmit` command hooks on one Pi gateway card,
 * a fresh session per rung, with the no-hook control FIRST and again LAST:
 *
 * | rung | command | turn |
 * | --- | --- | --- |
 * | A (control) | *(no hook)* | 12 040 ms, answered |
 * | B | `true` | 7 411 ms, answered |
 * | C | `echo <marker>` | 7 451 ms, answered |
 * | D | `cat > /dev/null` | 6 021 ms, answered |
 * | E | `cat` (stdin → stdout) | 11 087 ms, answered |
 * | **F** | **`cat >> <path>`** | **TIMEOUT — 60 s, then 121 s on a re-run; the file NEVER created** |
 * | D again, straight after F | `cat > /dev/null` | 6 021 ms, answered |
 *
 * **The cause is the host's own permission gate, and the ladder is exactly its
 * verdict table.** Measured at HEAD against the real `shouldPromptInAutoMode`
 * with a real `PermissionManager`:
 *
 * ```
 * AUTO  "true"                 -> ALLOW      "echo MARKER"          -> ALLOW
 * AUTO  "cat > /dev/null"      -> ALLOW      "cat"                  -> ALLOW
 * AUTO  "cat >> <outside ws>"  -> ASK        "cat >> <inside ws>"   -> ASK
 * ```
 *
 * Rung for rung. `SessionManager.pluginCommandHookRunner` turns that `ask` into
 * a `permission_request` card and then awaits the answer on a promise that
 * settles ONLY on a click or an abort — so with nobody answering, the turn waits
 * for ever. The file is never created because the spawn is BELOW that await: the
 * shell never ran, which is why `>>` — an operator that opens its target before
 * the command starts — left nothing on disk, and why both a config-dir path and
 * a `/private/tmp` path behaved the same (the gate asks about the REDIRECT, not
 * about the directory; an in-workspace path asks too).
 *
 * `runHookCommand` below is NOT the site: driven at HEAD over the same six
 * rungs in a temp dir it answered **9 / 9 / 17 / 10 / 12 / 13 ms**, all exit 0,
 * and the `cat >> <path>` rung CREATED its file. It has had a timeout since it
 * was written; the production authority is the injected runner, and that is the
 * one that had none.
 *
 * ## What this function is
 *
 * The bound, and nothing else. It is deliberately NOT a decision about whether a
 * hook command should need a card at all — that is a product posture (this fork
 * gates a command hook that `hooks.md` documents as simply running) and it is
 * reported rather than taken here. What a lane may fix is the SHAPE of the
 * failure: *"a hang with no diagnostic is the worst shape"*, and this turns it
 * into a bounded, named refusal the author can act on.
 *
 * The budget is the hook's OWN — {@link hookCommandBudgetMs}, `hooks.md`
 * § Common fields, `timeout`: *"Seconds before canceling"* — rather than a new
 * number nobody declared, so an author who needs longer at the card raises the
 * same field they already raise for a slow hook.
 *
 * `onExpiry` runs at most once and the loser is dropped: whichever of the two
 * settles first wins, and a click that arrives after the deadline finds its
 * resolver already removed, so it is a no-op rather than a second answer.
 */
export function raceHookApprovalDeadline<T>(
  wait: Promise<T>,
  budgetMs: number,
  onExpiry: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onExpiry());
    }, budgetMs);
    timer.unref?.();
    wait.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * D1.333 — the sentence a hook run gets when its approval never arrived.
 *
 * Transparent, in the owner's sense: it names what was waiting, what bounded the
 * wait, and the one field the author can raise. The command is included because
 * a hook author with several hooks cannot otherwise tell which one stalled — the
 * caller redacts it on the way out, the same as every other hook error string.
 */
export function hookApprovalTimeoutNotice(command: string, budgetMs: number): string {
  return `This command hook needed your approval and none arrived within ${budgetMs} ms, so it did not run: `
    + `${command}. Answer the permission card while the turn is waiting, or raise the hook's own `
    + '`timeout` — the approval wait is bounded by the same budget the hook declares for its run.';
}

export function runHookCommand(
  action: HookCommandAction,
  options: {
    event: AgentEvent;
    input: SdkAutomationInput;
    cwd: string;
    signal?: AbortSignal;
  },
): Promise<HookCommandActionResult> {
  const startedAt = Date.now();
  const timeoutMs = hookCommandBudgetMs(action);
  const env = buildHookCommandEnv(options.event, options.input, action.env);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const finish = (result: Omit<HookCommandActionResult, 'type' | 'command' | 'durationMs' | 'stdout' | 'stderr' | 'output' | 'truncated'>) => {
      if (settled) return;
      settled = true;
      const redactedStdout = redactHookOutput(stdout);
      const redactedStderr = redactHookOutput(stderr);
      const output = [redactedStdout, redactedStderr].filter(Boolean).join('\n');
      resolve({
        type: 'command',
        command: action.command,
        durationMs: Date.now() - startedAt,
        ...result,
        ...(redactedStdout ? { stdout: redactedStdout } : {}),
        ...(redactedStderr ? { stderr: redactedStderr } : {}),
        ...(output ? { output } : {}),
        ...(truncated ? { truncated } : {}),
      });
    };

    // hooks.md § Exec form and shell form. Exec form runs when `args` is
    // present: `command` is resolved as an executable and spawned directly with
    // `args` as the argument vector, "There is no shell, so each `args` element
    // is one argument exactly as written". Shell form is the `args`-absent case
    // and keeps `sh -c`. Presence selects the form, so `args: []` is still exec
    // form — that is the documented way to spawn a bare executable unquoted.
    //
    // hooks.md § Command hook fields, `shell`: shell form may pick `"bash"` or
    // `"powershell"`; the same row's closing sentence is "Ignored when `args`
    // is set", so exec form never consults it. Absent keeps the platform
    // default spawn. A declared shell that is not installed surfaces as a
    // stated execution error through the `error` handler below — never a
    // silent fallback to another shell.
    const execForm = resolveExecFormHookInvocation(action, env);
    const declaredShell = execForm ? undefined : action.shell;
    const effectiveCwd = action.cwd ?? options.cwd;
    const spawnOptions = {
      cwd: effectiveCwd,
      shell: false,
      env,
      // D7: stdin is a PIPE, not `ignore`. Every documented hook reads its
      // payload with `input=$(cat)`; against `ignore` that read returned empty
      // and the hook silently allowed whatever it was written to refuse.
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    };
    const child = execForm
      ? spawn(execForm.command, execForm.args, spawnOptions)
      : declaredShell === 'powershell'
        ? spawn(
            process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', action.command],
            spawnOptions,
          )
        : declaredShell === 'bash'
          ? spawn('bash', ['-c', action.command], spawnOptions)
          : spawn(action.command, { ...spawnOptions, shell: true });

    // A hook that never reads stdin must not deadlock the host. Node buffers
    // the write in userland — it never blocks this event loop even when the
    // payload exceeds the OS pipe buffer — so the only failure mode is the
    // child exiting first, which surfaces as EPIPE/ERR_STREAM_DESTROYED on the
    // stream. That is swallowed: an unhandled `error` on a child stdio stream
    // is an uncaught exception, and a hook that ignored its input still has a
    // valid exit code to report. `end()` is immediate so `cat` sees EOF.
    child.stdin?.on('error', () => { /* the child closed stdin; its exit still decides */ });
    try {
      child.stdin?.end(hookCommandStdinPayload(options.event, options.input, effectiveCwd));
    } catch {
      // Same case, synchronous spelling (already-destroyed stream).
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2_000).unref();
    }, timeoutMs);
    timeout.unref();

    const abort = () => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', chunk => {
      const next = appendCapped(stdout, chunk);
      stdout = next.next;
      truncated = truncated || next.truncated;
    });
    child.stderr?.on('data', chunk => {
      const next = appendCapped(stderr, chunk);
      stderr = next.next;
      truncated = truncated || next.truncated;
    });

    child.once('error', error => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      const message = error instanceof Error ? error.message : String(error);
      finish({
        success: false,
        exitCode: null,
        signal: null,
        // Name the shell the author asked for when it could not start, so a
        // missing `pwsh` on darwin/linux reads as exactly that.
        error: redactHookOutput(declaredShell
          ? `hook shell "${declaredShell}" failed to start: ${message}`
          : message),
      });
    });

    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      finish({
        success: exitCode === 0 && !timedOut,
        exitCode,
        signal,
        ...(timedOut ? { timedOut: true, error: `Hook command timed out after ${timeoutMs}ms.` } : {}),
      });
    });
  });
}

/**
 * F1.863, F1.874, F1.1037, F1.1065 — the events on which a command hook the HOST REFUSED
 * TO START is the documented non-blocking hook error, and never a block: since
 * F1.1065, EVERY event bar the three in {@link REFUSED_HOOK_FAIL_CLOSED_EVENTS}.
 *
 * F1.863 began with the two prompt events: a block on either "ends the turn" and erases
 * what the person typed (`ALWAYS_TERMINAL_BLOCK_EVENTS`, `hook-decision-contract.ts`).
 * A native automation's failed run is otherwise a block — the fail-closed
 * posture C3.350 keeps for a hook that RAN and failed, or stalled — and a
 * refusal by the host's own permission gate used to take that path too. So with
 * one structural deny rule and one `printf …; true` hook, every prompt was
 * dropped with the refusal as its only row (release sitting SIT-x, on Pi, the
 * row's runtime; the runner and this reader are shared, so claude and codex took
 * the same path).
 *
 * `hooks.md`'s events "execute automatically"; nothing on the page lets a hook
 * that never started stop a prompt, and a hook imported from a plugin (Claude's
 * three-way exit semantics, `blockOnNonZero: false`) already reached exactly
 * this answer here — a `<hook name> hook error` notice and the prompt answered
 * (SIT-x, crit-ee #3). This is the same answer for a native hook, and the same
 * one this host gives a hook whose execution authority is missing
 * (`executePluginHookAutomations`: "a hook that cannot run leaves the normal
 * path in charge").
 *
 * F1.874 — three more, measured on the same rig (`SessionManager.hook-refused-prompt.test.ts`).
 * `Stop` and `SubagentStop`: a block there stops nothing, it KEEPS THE AGENT
 * WORKING (hooks.md's exit-code-2 table: "Prevents Claude from stopping,
 * continues the conversation"). A refused hook answered that block with the
 * refusal as its reason, so claude's SDK continued the turn (to its 8-block
 * cap) and Pi and codex queued the refusal as the next turn's `<hook_feedback>`,
 * with no notice anywhere. A hook that never ran asked for no more work, and the
 * block was the fail-OPEN direction: more model actions, not fewer. `PreCompact`:
 * the block skipped every compaction, which is housekeeping, not an action a
 * guard stops. hooks.md#other-exit-codes, for all three: "A hook that can't
 * start lands in the same non-blocking bucket … For most hook events, the
 * action proceeds." (F1.1122 renamed the function from
 * refusedHookLeavesPromptInCharge, a name from the prompt-events-only days.)
 *
 * F1.1037 (controller decision 2026-09-28 under the owner-delegated rule,
 * DECISIONS-2 Q1) — the three guard events F1.874 left fail-closed follow the
 * same sentence: `PermissionRequest` (no deny: the permission's normal card
 * shows, so the PERSON decides), `ConfigChange` (the change applies) and
 * `PostToolBatch` (the loop goes on). A hook that never ran decided nothing, and
 * the page puts it in the non-blocking bucket; the notice names the hook and
 * the rule on every runtime.
 *
 * F1.1065 (controller decision 2026-09-28, same rule) — the rest of the events
 * that can decide follow the same sentence, which covers "most hook events":
 * `PostToolUse` and `PostToolUseFailure` (the refusal is no longer fed to the
 * model as the hook's stderr; the tool already ran), `TaskCreated` (the task
 * stays), `TaskCompleted` (it is marked done), `PreModelSwitch` (the switch
 * applies), `McpElicitation` and `ElicitationResult` (the request and the answer
 * go on as if no hook were set). The list is now written the other way round,
 * as the page writes it: the events that stay fail-closed, every other event
 * non-blocking — so an event added later lands in the page's default bucket.
 *
 * What is NOT changed, each deliberately:
 * - the refusal itself — the command still does not run, and a hook that runs
 *   the denied program is still refused;
 * - a hook that RAN: its exit code and its own `decision: block` decide as before;
 * - `PreToolUse`, where a guard that cannot run still blocks the call
 *   (fail-closed, our standing decision; Claude's own advice for a guard is
 *   `exit 2`) — a PreToolUse block withholds the tool call itself, with no card
 *   behind it to fall back on;
 * - `WorktreeCreate` and `WorktreeRemove`, the page's own stated exceptions (the
 *   Warning under Other exit codes: any non-zero exit aborts the creation, or
 *   fails the removal). `WorktreeRemove` carries no decision here (it is
 *   observational, `hook-decision-contract.ts`), so this reader never sees it
 *   today; it is listed so the page's rule holds if it ever gains one;
 * - a CANCELLED run (a stopped turn), which the runner does not mark.
 *
 * The consequence, stated rather than implied: a `UserPromptSubmit` hook written
 * as a guard, which the host's own policy refuses to run, no longer stops the
 * prompt, a `Stop` hook written to keep the agent going until a check passes no
 * longer does, and a `PermissionRequest`, `ConfigChange` or `PostToolBatch`
 * guard the host refuses no longer denies, keeps the old settings or stops the
 * loop, and a `PostToolUse`, `TaskCreated`, `TaskCompleted`, `PreModelSwitch` or
 * elicitation guard the host refuses no longer feeds the model, rolls back the
 * task, keeps it open, holds the switch or declines — the notice says it did
 * not run and why, on the transcript.
 */
const REFUSED_HOOK_FAIL_CLOSED_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse', // our standing decision: a guard that cannot run blocks the call
  'WorktreeCreate', 'WorktreeRemove', // hooks.md, Other exit codes: the page's own exceptions
]);

export function refusedHookIsNonBlocking(
  result: Pick<HookCommandActionResult, 'success' | 'refusedBeforeStart'>,
  event: string | undefined,
): boolean {
  return !result.success
    && result.refusedBeforeStart === true
    && event !== undefined
    && !REFUSED_HOOK_FAIL_CLOSED_EVENTS.has(event); // F1.1065 — every other event: hooks.md, Other exit codes, a hook that can't start is non-blocking
}

/** Longest stretch of a hook's command line a notice quotes, in characters. */
const REFUSED_HOOK_COMMAND_QUOTE_LIMIT = 120;

/**
 * F1.863 — the notice a refused hook leaves: that it DID NOT RUN, which hook (its
 * command, redacted, on one line and capped — the hook name alone is `Automation`
 * for a nameless `hooks.json` entry), and the refusal's own first line (which
 * names the rule). A refusal that already says it did not run — `dontAsk`'s
 * `Command hook not run: …`, D1.333's approval deadline — keeps its own words.
 */
function refusedHookSummary(result: HookCommandActionResult, summary: string): string {
  if (result.refusedBeforeStart !== true || !summary || /\bnot run\b/i.test(summary)) return summary;
  const oneLine = redactHookOutput(result.command).replace(/\s+/g, ' ').trim();
  const quoted = oneLine.length > REFUSED_HOOK_COMMAND_QUOTE_LIMIT
    ? `${oneLine.slice(0, REFUSED_HOOK_COMMAND_QUOTE_LIMIT)}…`
    : oneLine;
  return quoted.length > 0 ? `Command hook not run (\`${quoted}\`): ${summary}` : `Command hook not run: ${summary}`;
}
