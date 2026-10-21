import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TextContent as PiTextContent } from '@earendil-works/pi-ai';

import {
  findPiToolBinding,
  piToolPresentedNames,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
import type {
  ToolExecutor,
  ToolExecutionPort,
  ToolManifestIdentity,
} from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import type { ToolExecutionRequest } from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import { createToolInputValidator } from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import type { ToolExecutionProgress } from '../../../shared/src/agent/pi-harness/execution-receipt.ts';
import type { LocalToolExecutionResult } from '../../../shared/src/agent/local-tools/types.ts';
import type { SessionKey } from '../../../shared/src/sessions/types.ts';
import { guardLargeResult } from '../../../shared/src/utils/large-response.ts';
import { scanToolResultForSecrets } from '../../../shared/src/agent/tool-result-secret-scan.ts';
import { fileReadOutputTokenLimit } from '../../../shared/src/config/file-read-output-limit.ts';
import { allowNessyMetadataProperties, stripNessyMetadata } from '../nessy-metadata-schema.ts';
import { appendPreToolUseAdditionalContext } from '../pretool-context.ts';

export interface PiSdkToolAdapterDependencies {
  toolExecutor: ToolExecutor;
  sessionKey: SessionKey;
  manifestIdentity: ToolManifestIdentity;
  resolveSemanticId?: (presentedName: string) => string;
  progressBridge?: PiToolProgressBridge;
}

export interface PiToolProgressBridge {
  bind(executionId: string, onUpdate: ((result: AgentToolResult<any>) => void) | undefined): () => void;
  emit(executionId: string, value: ToolExecutionProgress): void;
}

export function createPiToolProgressBridge(): PiToolProgressBridge {
  const callbacks = new Map<string, (result: AgentToolResult<any>) => void>();
  return Object.freeze({
    bind(executionId: string, onUpdate: ((result: AgentToolResult<any>) => void) | undefined) {
      if (!onUpdate) return () => {};
      if (callbacks.has(executionId)) throw new Error(`Duplicate Pi progress binding: ${executionId}`);
      callbacks.set(executionId, onUpdate);
      return () => { callbacks.delete(executionId); };
    },
    emit(executionId: string, value: ToolExecutionProgress) {
      callbacks.get(executionId)?.({
        content: [{ type: 'text', text: value.text }],
        details: value.details,
      });
    },
  });
}

/**
 * The read tool's descriptor id (`PI_TOOL_BINDINGS`: `binding('read', 'read',
 * 'read', 'read', 'Read')`). Matched on `semanticId` rather than on the
 * presented name because the presented name has three spellings and the
 * descriptor id has one.
 */
const PI_READ_SEMANTIC_ID = 'read';

/**
 * `{ tokenLimit }` when the operator set the documented ceiling, `{}` when they
 * did not. An object rather than `number | undefined` so the call site can
 * SPREAD it: `resolveResultTokenLimit` guards on `!== undefined`, and relying
 * on that guard is how a ceiling of nothing turns into a ceiling of zero the
 * first time the guard is rewritten.
 */
function readTokenLimitOverride(debugLog: (message: string) => void): { tokenLimit?: number } {
  const tokenLimit = fileReadOutputTokenLimit(process.env, debugLog);
  return tokenLimit === undefined ? {} : { tokenLimit };
}

export function createPiToolResultTransformer(options: {
  getSessionPath: () => string | null;
  getModelContextWindow: () => number | undefined;
  getCurrentUserMessage: () => string;
  runMiniCompletion: (prompt: string) => Promise<string | null>;
  debugLog: (message: string) => void;
}): (
  request: ToolExecutionRequest,
  canonicalInput: Record<string, unknown>,
  result: LocalToolExecutionResult,
) => Promise<LocalToolExecutionResult> {
  return async (request, canonicalInput, result) => {
    // P6.574 — the secret scan runs FIRST and UNCONDITIONALLY, ahead of the
    // `sessionPath` guard below. The large-result guard needs a session
    // directory to spill into and is legitimately skipped without one; the
    // scan needs nothing, and a session with no path is exactly the case where
    // skipping it would be silent. The notice is COUNT-ONLY and is appended to
    // the content, so the model is told that something was removed rather than
    // handed a text that quietly lost bytes.
    //
    // P6.771 — and the ordering is load-bearing for a SECOND reason the P6.574
    // note did not state: `guardLargeResult` below does not merely shorten an
    // oversized result, it WRITES IT TO DISK under `long_responses/`. It is
    // handed `scrubbed.content`, so the artifact carries the marker. Swapping
    // these two lines would leave the event scrubbed and the FILE readable, and
    // no reader of the event could tell — the event says `[REDACTED:…]` either
    // way. Pinned on the artifact's own bytes in `tool-wrapper.test.ts`.
    // The other three `guardLargeResult` sites in this tree (`mcp/mcp-pool.ts`,
    // `agent/local-tools/runtime.ts`, `sources/api-tools.ts`) spill before any
    // scan and are NOT covered by this line; their scan happens downstream in an
    // event adapter, which reaches the event and never the file.
    const scanned = scanToolResultForSecrets(result.content);
    const scrubbed = scanned.notice
      ? { ...result, content: `${scanned.text}\n\n${scanned.notice}` }
      : result;
    const sessionPath = options.getSessionPath();
    if (!sessionPath) return scrubbed;
    const rawInput = record(request.canonicalInput);
    try {
      const guarded = await guardLargeResult(scrubbed.content, {
        sessionPath,
        toolName: findPiToolBinding(request.presentedName)?.permissionName ?? request.presentedName,
        input: canonicalInput,
        // UB12.39 — the model's `_intent` and the user's message travel as TWO
        // fields, as upstream v0.15.1's Pi wrapper keeps them (`intent` from
        // `_intent` or undefined, `userRequest: currentUserMessage`). Folding
        // the message into `intent` labelled it "The AI assistant's goal" in
        // the summariser prompt and made every Pi call read as one that stated
        // an intent; the summariser still falls back to the message, labelled
        // as the user's request, when no `_intent` was given.
        intent: typeof rawInput._intent === 'string' ? rawInput._intent : undefined,
        userRequest: options.getCurrentUserMessage(),
        summarize: options.runMiniCompletion,
        contextWindow: options.getModelContextWindow(),
        // P6.693 / P6.490 — the documented file-read ceiling, and THIS is its
        // only live seam on Pi. `LocalToolRuntime.guardResult` looks like the
        // place and is INERT here: the Pi runtime is constructed with
        // `guardLargeResults: false`, so a fix written there never runs. Read
        // only: `tokenLimitFor(contextWindow)` keeps governing Bash, MCP and
        // every other tool, because the page scopes the key to file reads.
        // Unset, `fileReadOutputTokenLimit()` answers `undefined` and this
        // spread contributes nothing — an unset environment is byte-identical
        // to the behaviour before this line. The key is spread rather than
        // assigned for exactly that reason.
        ...(request.semanticId === PI_READ_SEMANTIC_ID
          ? readTokenLimitOverride(options.debugLog)
          : {}),
      });
      return guarded ? {
        ...scrubbed,
        content: guarded,
        ...(scrubbed.isError ? { error: guarded } : {}),
      } : scrubbed;
    } catch (error) {
      options.debugLog(`Large response handling failed: ${error instanceof Error ? error.message : String(error)}`);
      // Still the SCRUBBED result: a failure in the size guard must not put the
      // credential back.
      return scrubbed;
    }
  };
}

export function createPiToolExecutionPorts(
  tools: readonly ToolDefinition<any, any>[],
  resolveSemanticId: (presentedName: string) => string = staticSemanticId,
): ToolExecutionPort[] {
  const groups = new Map<string, Map<string, ToolDefinition<any, any>>>();
  for (const tool of tools) {
    const semanticId = resolveSemanticId(tool.name);
    const group = groups.get(semanticId) ?? new Map<string, ToolDefinition<any, any>>();
    // Index under EVERY spelling that can arrive as presentedName, not just the
    // one this definition was registered under: ports are built from the raw
    // definitions (bindingName) while requests carry the projected, model-facing
    // piName. Keying on one axis alone made every diverging session tool throw
    // "Missing <semanticId> definition for <piName>" on its first live call.
    for (const presentedName of piToolPresentedNames(tool.name)) {
      if (group.has(presentedName)) throw new Error(`Duplicate Pi execution definition: ${presentedName}`);
      group.set(presentedName, tool);
    }
    groups.set(semanticId, group);
  }
  const validators = new Map(tools.map(tool => [
    tool.name,
    createToolInputValidator(tool.parameters as Record<string, unknown>, tool.name),
  ]));
  return [...groups].map(([semanticId, definitions]) => {
    const definitionFor = (presentedName: string): ToolDefinition<any, any> => {
      const value = definitions.get(presentedName);
      if (!value) throw new Error(`Missing ${semanticId} definition for ${presentedName}`);
      return value;
    };
    return {
      semanticId,
      canonicalize(input, request) {
        const tool = definitionFor(request.presentedName);
        const prepared = tool.prepareArguments ? tool.prepareArguments(input as never) : input;
        const canonical = stripNessyMetadata(record(prepared));
        return validators.get(tool.name)!(canonical);
      },
      dispatch: {
        kind: 'semantic' as const,
        async execute(input, context) {
          const tool = definitionFor(context.request.presentedName);
          const result = await tool.execute(
            context.request.executionId,
            input,
            context.signal,
            update => context.emitProgress(agentResultProgress(update)),
            undefined as never,
          );
          return agentResultToLocal(result);
        },
      },
    };
  });
}

export function createPiSdkToolAdapter(deps: PiSdkToolAdapterDependencies): {
  adaptTools: (tools: ToolDefinition<any, any>[]) => ToolDefinition<any, any>[];
  adaptTool: (tool: ToolDefinition<any, any>) => ToolDefinition<any, any>;
} {
  const adaptTool = (tool: ToolDefinition<any, any>): ToolDefinition<any, any> => {
    const binding = findPiToolBinding(tool.name);
    const semanticId = deps.resolveSemanticId?.(tool.name) ?? binding?.descriptorId;
    if (!semanticId) throw new Error(`Missing Pi semantic identity for ${tool.name}`);
    const parameters = allowNessyMetadataProperties(tool.parameters);

    /**
     * P3.370 · why a denied receipt still THROWS, and what adopting Pi's
     * `terminate` hint would cost.
     *
     * Pi ships a batch-aware early-termination hint and we use none of it. The
     * row that measured this asked for the small seam — "return an error result
     * with `terminate` instead of throwing" — and the measurement below is the
     * answer to it: that seam is reachable and it is NOT free. Written here
     * rather than left as an absence, because an unadopted native mechanism
     * with no visible reason is indistinguishable from an oversight, and the
     * next reader would pay for this measurement again.
     *
     * Measured at HEAD against `@earendil-works/pi-agent-core@0.84.2`, and every
     * bullet re-read unchanged at `@0.84.3` (W11-pi, 2026-09-11):
     *
     * - `terminate?: boolean` has THREE declaration sites in that package's
     *   `dist/types.d.ts` — `BeforeToolCallResult`, `AfterToolCallResult` and
     *   `AgentToolResult<T>` — plus the extension-facing `ToolCallEventResult`
     *   in `pi-coding-agent`. The third is reachable from an ordinary tool's
     *   RETURN VALUE, which is exactly where this function sits.
     * - The rule is UNANIMITY: `agent-loop.js`'s `shouldTerminateToolBatch` is
     *   `finalizedCalls.length > 0 && finalizedCalls.every(f => f.result.terminate === true)`.
     *   A batch with one allowed call does not stop, so the hint can never be a
     *   replacement for a guarantee — only a graceful companion to one.
     * - Both hook seams are ALREADY TAKEN. `AgentSession._installAgentToolHooks()`
     *   in `pi-coding-agent` assigns `agent.beforeToolCall` AND
     *   `agent.afterToolCall` unconditionally at session construction, wiring
     *   them to its extension runner. "Registering one" therefore means
     *   overwriting the vendored harness's own installation, not adding a hook
     *   beside it. (The register entry O27 said our permission and hook layers
     *   "block Pi tools through exactly this seam" — they do not; this tree has
     *   zero production registrations of either, and
     *   `fixtures/tool-surface.json` already records `beforeToolCall: false`.)
     * - **Returning instead of throwing loses the loop's error flag.**
     *   `executePreparedToolCall` answers `{ result, isError: false }` for a
     *   returned result and `{ result: createErrorToolResult(msg), isError: true }`
     *   for a thrown one, and that flag lands on the `toolResult` message
     *   `createToolResultMessage` builds — the one that enters session history
     *   and reaches the provider. So the cheap adoption tells the model a
     *   DENIED tool call succeeded, in exchange for a hint that only fires when
     *   every call in the batch was denied.
     *
     * It is restorable, and only through a second seam: the `tool_result`
     * extension event this package already handles in
     * `extensions/lifecycle-bridge.ts` can set `isError`, because
     * `ToolResultEventResult` declares it — and it cannot set `terminate`,
     * because that type does not.
     *
     * And there is a POSTURE question under the mechanics, which is why this is
     * a note and not a patch: nothing documents "a denied tool call ends the
     * turn". Claude's own PreToolUse deny does not. The one place this fork has
     * already decided a turn ends is `AbortReason.PermissionHookInterrupt`
     * (`pi-agent.ts`), the PermissionRequest band that sets `interrupt: true` —
     * and that is a HARD stop which cancels every pending permission and aborts
     * every pending execution, where Pi's hint stops cleanly after the batch
     * finalizes. Pairing them is the only shape that adds anything, and it
     * needs a `terminate` flag on the `pre_tool_use_response` wire so the
     * subprocess learns which denial was the interrupting one.
     *
     * The throw also carries a recorded contract: R4 Task 5, "Denial = the
     * workflow does not run, no agents spawn, no side effect", pinned by two
     * tests in this package that assert the rejection by name. Flipping it is a
     * deliberate act with those pins rewritten to the substance, not a quiet
     * refactor.
     */
    const wrappedExecute: ToolDefinition<any, any>['execute'] = async (
      executionId,
      params,
      signal,
      onUpdate,
    ) => {
      const input = record(params);
      const releaseProgress = deps.progressBridge?.bind(executionId, onUpdate) ?? (() => {});
      let receipt: Awaited<ReturnType<ToolExecutor['execute']>>;
      try {
        receipt = await deps.toolExecutor.execute({
          executionId,
          sessionKey: deps.sessionKey,
          manifestIdentity: deps.manifestIdentity,
          semanticId,
          canonicalInput: input,
          source: 'pi',
          presentedName: tool.name,
          abortSignal: signal ?? new AbortController().signal,
        });
      } finally {
        releaseProgress();
      }
      if (receipt.outcome !== 'success') {
        throw new Error(receipt.reason ?? receipt.result.error ?? receipt.result.content);
      }
      const result = appendPreToolUseAdditionalContext(
        localResultToAgent(receipt.result),
        receipt.additionalContext,
      );
      return result;
    };

    return { ...tool, parameters, execute: wrappedExecute };
  };

  return {
    adaptTools: tools => tools.map(adaptTool),
    adaptTool,
  };
}

function staticSemanticId(presentedName: string): string {
  const binding = findPiToolBinding(presentedName);
  if (!binding) throw new Error(`Missing Pi tool binding for ${presentedName}`);
  return binding.descriptorId;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool input must be an object');
  return { ...(value as Record<string, unknown>) };
}

function agentResultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((content): content is PiTextContent => content.type === 'text')
    .map(content => content.text)
    .join('');
}

function agentResultProgress(result: AgentToolResult<any>): ToolExecutionProgress {
  const details = result.details && typeof result.details === 'object'
    ? result.details as Record<string, unknown>
    : undefined;
  return {
    text: agentResultText(result),
    ...(details ? { details } : {}),
  };
}

function agentResultToLocal(result: AgentToolResult<any>): LocalToolExecutionResult {
  const details = result.details && typeof result.details === 'object'
    ? result.details as Record<string, unknown>
    : undefined;
  const content = agentResultText(result);
  const isError = details?.isError === true;
  return {
    content,
    isError,
    ...(isError ? { error: content } : {}),
    ...(details ? { structuredContent: details } : {}),
  };
}

/**
 * The receipt -> model direction, and the mirror of `agentResultToLocal` above.
 *
 * P6.568 — it used to copy `structuredContent` into `details` and drop
 * `result.isError` on the floor, so an errored result reached the model
 * UNMARKED. **Carry MCP's own flag; do not invent a second one.** `details` is
 * where this flag lives on the Pi side and nowhere else: `AgentToolResult` (in
 * `@earendil-works/pi-agent-core`) declares `content`, `details`, `usage`,
 * `addedToolNames` and `terminate` and has **no top-level `isError`** — a
 * literal carrying one would not typecheck — while `makeErrorResult` below,
 * `deferred-mcp-tools.ts` and `create-search-tool.ts` all spell it
 * `details: { isError: true }`, and `agentResultToLocal` reads it back from
 * exactly there. So `details.isError` IS the top level for this flag.
 *
 * WHY IT WAS INVISIBLE, and why the fix is still owed — measured at HEAD:
 * `createToolExecutor` ends with `finish(result.isError ? 'error' : 'success',
 * result, …)`, so today `outcome === 'success'` IMPLIES `result.isError ===
 * false` and the caller's `receipt.outcome !== 'success'` throw takes every
 * errored receipt one line earlier. The old behaviour was therefore correct
 * only by COUPLING to a derivation in another package. Either side moving —
 * an executor that reports a soft error as `success`, or a caller that stops
 * throwing — silently tells the model a failed tool call succeeded. This makes
 * the flag travel on its own.
 *
 * Only ADDITIVE: a `false` never erases an `isError` a tool already put in its
 * own `structuredContent`.
 */
function localResultToAgent(result: LocalToolExecutionResult): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: result.content }],
    details: result.isError
      ? { ...result.structuredContent, isError: true }
      : result.structuredContent,
  };
}

export function makeErrorResult(message: string): AgentToolResult<any> {
  return { content: [{ type: 'text', text: message }], details: { isError: true } };
}
