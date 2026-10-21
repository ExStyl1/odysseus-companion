/**
 * Guardian judge core (plan: guardian-command-judge G2).
 *
 * The spawn-injected heart of the guardian judge, extracted to shared so ONE
 * implementation holds the read-only judge child, the strict verdict parse, the
 * bounded retry, the hard timeout, and the fail-closed contract.
 *
 * TWO LIVE CALLERS (F1.829, F1.1195), both in server-core's SessionManager:
 * `createGuardianJudgePort` (the Pi consult) spawns the read-only judge child over
 * the host-owned child-session authority (`PiChildSessionPort.start`) — no new
 * host↔subprocess RPC class, no server-core -> pi-agent-server package edge — and
 * `consultAgentMessageGuardian` (send_agent_message, EVERY runtime) spawns over the
 * sender's tool-less `queryLlm`, with no child session. A spawn-contract or
 * `sanitizeReason` change reaches both. pi-agent-server's `runGuardianJudge` delegates
 * here too but has NO production caller (`docs/superpowers/specs/2026-07-29-inert-worklist.md`).
 *
 * FAIL-CLOSED CONTRACT (unchanged from G1): ANY failure — timeout, spawn error,
 * aborted, malformed output, or an out-of-vocabulary verdict — resolves to
 * `verdict: 'unsure'`, NEVER `no_objection`. `unsure` routes the decision to a
 * human upstream.
 */

import { resolveAgentDefinition, type AgentDefinition } from '../../agents/index.ts';
import { resolveGatewayFastModelId, type LlmConnection } from '../../config/llm-connections.ts';
import {
  GUARDIAN_CATEGORIES,
  GUARDIAN_POLICY_PROMPT,
  GUARDIAN_VERDICT_SCHEMA,
  buildGuardianJudgeTask,
  type GuardianJudgeInput,
  type GuardianVerdictResult,
} from '../../prompts/guardian.ts';
import { neutralizeHarnessMarkers } from '../../prompts/untrusted-text.ts';

/** Default hard timeout for one judge evaluation, retries included: codex's own reviewer `REVIEW_TIMEOUT` (F1.857). */
export const GUARDIAN_DEFAULT_TIMEOUT_MS = 90_000;
// F1.857 — 90 s, the number codex gives its own reviewer (openai/codex
// `codex-rs/ext/guardian-reviewer/src/lib.rs`: `REVIEW_TIMEOUT … from_secs(90)`;
// `review.rs` arms ONE deadline from it over startup and every attempt, as this
// core's one timer spans both of its attempts). 60 s (F1.256, up from 15) ran out
// under load: SIT-y spent ~37 s starting the child at load 11–12 and 2 of 5 judges
// became cards; SIT-v measured 22.4 s and 53 s. A timeout is still `unsure`, never
// an allow. `SessionManager.createGuardianJudgePort` reads this constant for its
// child's `deadlineAt` (pinned in guardian-judge-turn-budget.test.ts), so the host
// never ends a judge before this timer does. Cost: a band action waits up to 90 s.

/** Judge attempts before failing closed (initial + one retry), like review-tool. */
const GUARDIAN_MAX_ATTEMPTS = 2;

/**
 * The ACTUAL protection is the read-only ALLOWLIST: the judge child is the
 * built-in `scout` def, whose `tools` are exactly the read-only scout set
 * (read/grep/find/ls) — it can never write, run shell, spawn, or reach the
 * network because those tools are simply not granted. This disallow list of
 * spawn/agent tools is belt-and-suspenders ONLY: it, plus the depth-1 budget,
 * closes the theoretical gap where a future scout allowlist gained a spawn
 * tool. It is not what keeps the judge read-only today.
 */
const GUARDIAN_DISALLOWED_TOOLS = ['subagent', 'workflow', 'task', 'agent'];

/**
 * Minimal spawn contract the core needs — a subset shared by the orchestrator
 * spawner and the host child-session adapter. Deliberately NOT imported from
 * pi-agent-server so shared stays leaf.
 */
export interface GuardianSpawnArgs {
  agentDef: AgentDefinition;
  task: string;
  cwd: string;
  model?: string;
  signal?: AbortSignal;
  depth?: number;
  background?: boolean;
  requestedAgentId?: string;
}

export interface GuardianSpawnResult {
  status: 'done' | 'error' | 'aborted';
  text: string;
  error?: string;
}

export type GuardianSpawn = (args: GuardianSpawnArgs) => Promise<GuardianSpawnResult>;

export interface RunGuardianJudgeCoreOptions {
  input: GuardianJudgeInput;
  cwd: string;
  spawn: GuardianSpawn;
  /** Judge model id. When omitted, defaults via {@link resolveGatewayFastModelId} if a connection is supplied. */
  modelId?: string;
  /** Optional gateway connection used to default the model to the `fast` alias. */
  connection?: Pick<LlmConnection, 'models'>;
  /** Hard timeout in ms (default {@link GUARDIAN_DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Depth of the CALLING session; the judge child is one deeper. */
  depth?: number;
  /** Caller abort signal; the judge aborts when it fires or on timeout. */
  signal?: AbortSignal;
  /**
   * @deprecated INERT, and deliberately so — see the closed-world resolution in
   * {@link runGuardianJudgeCore}. Consuming this is exactly what let a file in
   * the workspace replace the judge's own tool ceiling. The field is retained
   * only because the host port (`SessionManager.createGuardianJudgePort`) still
   * passes it; dropping it needs that call site, which is not this file's.
   */
  getWorkspaceRootPath?: () => string | undefined;
}

/** The outcome of a judge run. `verdict` is always populated; on failure it is `unsure`. */
export interface GuardianRunResult extends GuardianVerdictResult {
  /** Non-empty when the run failed closed to `unsure`. */
  failure?: 'timeout' | 'spawn-error' | 'aborted' | 'malformed';
}

/**
 * F1.817 — the judge's own turn budget, in model ROUND TRIPS. Since F1.83
 * (`04b18be95`) a Pi child's `maxTurns` binds its own agentic loop
 * (`agent-sdk/agent-loop.md#turns-and-messages`: "A turn is one round trip
 * inside the loop"), and this def used to inherit `scout`'s, which declares
 * none — so 1. One round trip cannot hold what `GUARDIAN_POLICY_PROMPT`
 * §"Investigation Guidelines" asks for ("use your read-only tools to gather
 * evidence before deciding"): the judge spent it on the lookup and was aborted
 * before its verdict (release sitting SIT-s: `terminal_reason:max_agent_turns`,
 * a card for every judged `auto` action). The prompt keeps its tools, so the
 * fix is room to finish, not a tool-less one-shot answer; codex's reviewer,
 * whose policy that prompt adapts, runs its tool continuations inside one
 * review bounded only by its deadline. The deadline still bounds this judge
 * (90 s, above). 8 is about how many round trips fit in 60 s at the one measured
 * gateway judge latency (7.4 s, SIT-i) — up to seven lookups, then the verdict;
 * F1.857's extra 30 s is room for a slow child start, not for more lookups — so
 * the cap binds only a judge whose round trips are fast, and it bounds the model
 * calls one consult can cost. A judge that reaches it still fails closed to `unsure`.
 */
export const GUARDIAN_JUDGE_MAX_TURNS = 8;

/**
 * Judge child def = the built-in read-only `scout` def with the guardian policy
 * as its system prompt and the spawn/agent tools disallowed. Reusing a built-in
 * read-only def keeps the child read-only without new spawn plumbing. Its turn
 * budget is the judge's own ({@link GUARDIAN_JUDGE_MAX_TURNS}), never `scout`'s.
 */
function guardianJudgeDef(base: AgentDefinition): AgentDefinition {
  const disallowed = new Set([...(base.disallowedTools ?? []), ...GUARDIAN_DISALLOWED_TOOLS]);
  return {
    ...base,
    tools: [...base.tools],
    disallowedTools: [...disallowed],
    systemPrompt: GUARDIAN_POLICY_PROMPT,
    maxTurns: GUARDIAN_JUDGE_MAX_TURNS,
  };
}

function unsure(failure: GuardianRunResult['failure'], reason: string): GuardianRunResult {
  // Some failure reasons embed child/adapter text (`result.error`, a thrown
  // message), so they go through the same boundary sanitizer as a parsed verdict.
  return { verdict: 'unsure', reason: sanitizeReason(reason), ...(failure ? { failure } : {}) };
}

/** Max chars of model-authored `reason` retained after sanitization. */
const GUARDIAN_REASON_MAX_LEN = 500;

/**
 * Sanitize the model-authored `reason` before it leaves the judge. `reason` is
 * free text the model wrote; it flows into deny diagnostics, audit receipts,
 * and UI. Left raw, an injected newline / ANSI escape / control char could
 * forge extra log lines or spoof terminal output downstream. Collapse all
 * control characters (including CR/LF, ESC, and other C0/C1) and any Unicode
 * line/paragraph separators to single spaces, squeeze runs of whitespace, trim,
 * and cap the length — so the value is always one bounded single line.
 */
function sanitizeReason(reason: string): string {
  // The reason reaches a MODEL too: a `deny` returns `outcome.diagnostic`
  // (category + reason) as the block reason the model reads. So harness-shaped
  // markers are defanged here as well, not just control characters.
  const singleLine = neutralizeHarnessMarkers(reason)
    // C0 controls (incl. CR/LF/TAB/ESC), DEL, C1 controls, and Unicode
    // line/paragraph separators — everything that could forge a new log line
    // or drive a terminal escape sequence.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return singleLine.length > GUARDIAN_REASON_MAX_LEN
    ? `${singleLine.slice(0, GUARDIAN_REASON_MAX_LEN)}…`
    : singleLine;
}

/**
 * Sanitize the model-authored `category`. It must be one of our known taxonomy
 * values to reach diagnostics; anything else (including injected text) is
 * dropped rather than echoed, so it can never carry log/UI-injection payloads.
 */
function sanitizeCategory(category: unknown): GuardianVerdictResult['category'] | undefined {
  return typeof category === 'string' && (GUARDIAN_CATEGORIES as string[]).includes(category)
    ? (category as GuardianVerdictResult['category'])
    : undefined;
}

/** Return a verdict with `reason`/`category` sanitized at the judge boundary. */
function sanitizeVerdict(parsed: GuardianVerdictResult): GuardianVerdictResult {
  const category = sanitizeCategory(parsed.category);
  return {
    verdict: parsed.verdict,
    reason: sanitizeReason(parsed.reason),
    ...(category ? { category } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Minimal structural validator for the verdict schema (mirrors the orchestrator's
 * `parseSchemaResult`): parse JSON, then check required keys and property types.
 * Enum membership is checked separately by the caller's vocabulary guard.
 */
function parseVerdictSchema(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isRecord(parsed)) return '$ must be an object';
  for (const key of GUARDIAN_VERDICT_SCHEMA.required) {
    if (!(key in parsed)) return `$.${key} is required`;
  }
  if (typeof parsed.verdict !== 'string') return '$.verdict must be a string';
  if (typeof parsed.reason !== 'string') return '$.reason must be a string';
  if ('category' in parsed && parsed.category !== undefined && typeof parsed.category !== 'string') {
    return '$.category must be a string';
  }
  return null;
}

/**
 * F1.256 — the text the verdict parse reads: the judge's output with ONE
 * Markdown code fence around the WHOLE of it removed (an optional language tag
 * such as `json`, and surrounding whitespace). Measured in the 1.41.0 release
 * sitting: the gateway judge answered `no_objection` inside a json-tagged
 * fence although `GUARDIAN_POLICY_PROMPT` says "no Markdown fences", the strict
 * parse called it malformed, and a bypass turn got a card. Deliberately narrow:
 * prose around the fence, a second fence, or a fence that never closes all
 * come back unchanged and stay malformed, because a lenient extractor would let
 * text the judge wrote AROUND its answer decide which object is the verdict.
 * The vocabulary guard and the sanitizer below run on the result as before.
 */
function stripVerdictFence(text: string): string {
  const fenced = /^\s*```[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```\s*$/.exec(text);
  if (!fenced || fenced[1] === undefined || fenced[1].includes('```')) return text;
  return fenced[1];
}

/**
 * Run one guardian judge evaluation with an injected spawn. Never throws —
 * every path returns a verdict, and every failure path returns `unsure`
 * (never `no_objection`).
 */
export async function runGuardianJudgeCore(options: RunGuardianJudgeCoreOptions): Promise<GuardianRunResult> {
  const { spawn } = options;
  const timeoutMs = options.timeoutMs ?? GUARDIAN_DEFAULT_TIMEOUT_MS;

  // Setup runs BEFORE the spawn loop and is part of the never-throws contract:
  // model resolution, `scout` def resolution, the def transform, and task
  // assembly can each throw (a bad connection, a workspace-root probe, a huge
  // input). Any throw here must fail closed to `unsure`, never propagate to the
  // host port (server-core calls this core directly, with no catch of its own).
  let modelId: string | undefined;
  let agentDef: AgentDefinition;
  let baseTask: string;
  try {
    modelId = options.modelId
      ?? (options.connection ? resolveGatewayFastModelId(options.connection) : undefined);
    // CLOSED WORLD. This is a permission boundary, not a preference.
    //
    // `resolveAgentDefinition` WITHOUT `runtimeDefinitions` takes the filesystem
    // branch of `loadAgentDefinitions`: global `CONFIG_DIR/agents/*.md`, plus
    // the workspace root's own `*.md` and `config.json#orchestratorAgents`. This
    // was the ONE live caller of that branch, and a definition named `scout`
    // found there REPLACED this judge's ceiling. Measured: a
    // `<workspaceRoot>/scout.md` declaring `tools: bash, write, edit, subagent`
    // and `maxTurns: 99` produced exactly that def for the judge child, with
    // nothing said anywhere. And `<workspaceRoot>` is the PRIMARY FILESYSTEM
    // ROOT of a no-project session (`buildSessionFilesystemScope`: `primaryRoot
    // = projectCanonicalPath ?? workspaceRootPath`), so the session under
    // judgment could author the ceiling of its own judge — measured too:
    // `resolveScopedPath('scout.md', scope, { access: 'write' })` is ALLOWED,
    // while the sibling workspace and the global agents dir are both refused.
    //
    // `[]` is the closed world every other spawn site already uses —
    // `subagent-tool.ts` passes the pinned snapshot, `review-tool.ts` passes
    // `[]` for its own reviewer judge — and it yields the BUILT-IN `scout`,
    // which is the def the disallow-list comment above has always claimed was
    // in use. It also keeps the two sides of the child-session admission check
    // in agreement: a pinned snapshot cannot claim the name either, because
    // `loadAgentDefinitions` stores a built-in collision under its QUALIFIED
    // key, so `scout` resolves to the built-in in the subprocess as well.
    const baseDef = resolveAgentDefinition('scout', { runtimeDefinitions: [] });
    agentDef = guardianJudgeDef(baseDef);
    baseTask = buildGuardianJudgeTask(options.input);
  } catch (error) {
    return unsure('spawn-error', `judge setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    let task = baseTask;
    for (let attempt = 1; attempt <= GUARDIAN_MAX_ATTEMPTS; attempt += 1) {
      let result: GuardianSpawnResult;
      try {
        result = await spawn({
          agentDef,
          task,
          cwd: options.cwd,
          ...(modelId ? { model: modelId } : {}),
          signal: controller.signal,
          depth: options.depth ?? 0,
          background: false,
          ...(attempt === 1 ? {} : { requestedAgentId: crypto.randomUUID() }),
        });
      } catch (error) {
        if (timedOut || controller.signal.aborted) {
          return timedOut
            ? unsure('timeout', `judge timed out after ${timeoutMs}ms`)
            : unsure('aborted', 'judge aborted before completing');
        }
        return unsure('spawn-error', `judge spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (result.status !== 'done') {
        if (timedOut) return unsure('timeout', `judge timed out after ${timeoutMs}ms`);
        if (result.status === 'aborted') return unsure('aborted', 'judge aborted before completing');
        return unsure('spawn-error', result.error || `judge ${result.status}`);
      }

      const verdictText = stripVerdictFence(result.text);
      const schemaError = parseVerdictSchema(verdictText);
      if (!schemaError) {
        const parsed = JSON.parse(verdictText) as GuardianVerdictResult;
        // The schema check does NOT verify enum membership, so an
        // out-of-vocabulary verdict (e.g. Codex's `allow`) would otherwise
        // pass. Fail closed on anything outside our vocabulary.
        if (parsed.verdict === 'no_objection' || parsed.verdict === 'deny' || parsed.verdict === 'unsure') {
          // Sanitize the model-authored reason/category at the boundary where
          // the verdict leaves the judge, so downstream diagnostics/audit/UI
          // can never receive an injected newline, ANSI escape, or bogus
          // category.
          return sanitizeVerdict(parsed);
        }
        if (attempt === GUARDIAN_MAX_ATTEMPTS) {
          return unsure('malformed', `judge returned an unknown verdict: ${String(parsed.verdict)}`);
        }
        task = `${baseTask}\n\nThe previous verdict "${String(parsed.verdict)}" is not allowed. Use exactly one of: no_objection, deny, unsure.`;
        continue;
      }
      if (attempt === GUARDIAN_MAX_ATTEMPTS) {
        return unsure('malformed', `judge output did not match the verdict schema: ${schemaError}`);
      }
      task = `${baseTask}\n\nThe previous result did not match the required schema: ${schemaError}. Return only the JSON verdict object.`;
    }
    return unsure('malformed', 'judge did not produce a verdict');
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);
  }
}
