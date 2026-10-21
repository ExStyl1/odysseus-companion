import { resolveScopedPath, type SessionFilesystemScope } from '../../session-filesystem-scope.ts';
import { createHash } from 'node:crypto';

import type { AgentEvent } from '@nessy-agent/core/types';
import type { PreToolUseDecision } from '../../../automations/types.ts';
import { resolveHookToolOutputRewrite } from '../../../automations/hook-decision-contract.ts';
import type { McpClientPool } from '../../../mcp/mcp-pool.ts';
import type { SessionKey } from '../../../sessions/types.ts';
import {
  LocalToolPermissionGate,
  LocalToolRuntime,
  type DeniedResultPathFilter,
  type LocalToolCall,
  type LocalToolExecutionResult,
} from '../../local-tools/index.ts';
import { createToolExecutor, type ToolExecutionPort } from '../../pi-harness/tool-executor.ts';
import type { PermissionResponseOptions } from '../types.ts';
import type { ToolPermissionResult } from '../../core/types.ts';
import type { NestorToolCall } from './event-adapter.ts';
import { createNestorToolExecutionPorts, toLocalToolCall } from './local-tool-adapter.ts';
import {
  NESTOR_SKILL_FAILURE_PREFIX,
  formatNestorSkillContent,
  formatNestorSkillFailure,
  type NestorSkillActivation,
} from './skills.ts';
import {
  NESTOR_ACTIVATE_SKILL_TOOL_NAME,
  normalizeNestorToolCall,
  type NormalizedNestorToolCall,
} from './tool-schema.ts';
import type { NestorToolExecutionResult } from './turn.ts';
import { fenceHookBand } from '../../../automations/hook-context-fence.ts';
import { createFileCheckpoint, finalizeFileCheckpoint } from '../../../sessions/file-checkpoints.ts';

const ADAPTER_VERSION = 1;
const ADAPTER_PROVENANCE = 'nessy:nestor-a2a-tool-adapter';
const ADAPTER_GENERATION = `nestor-a2a-v${ADAPTER_VERSION}`;
// The LOCAL-TOOL mappings this adapter installs, which is what the manifest hash
// identifies. `skill` is deliberately absent: `activate_skill` resolves against
// the session's own skill registry and never reaches a local-tool port
// (`toLocalToolCall` returns null for it), so adding it here would change the
// identity of every dispatch without changing any dispatch.
const ADAPTER_HASH = createHash('sha256').update(JSON.stringify({
  version: ADAPTER_VERSION,
  mappings: ['read', 'ls', 'grep', 'write', 'edit', 'bash', 'ask_user', 'submit_plan', 'mcp_dynamic'],
})).digest('hex');
const MAX_ADAPTER_ERROR = 512;

/** The subset of an execution receipt this class reads back. */
type NestorExecutionOutcome = Pick<
  Awaited<ReturnType<ReturnType<typeof createToolExecutor>['execute']>>,
  'decisionId' | 'outcome' | 'reason' | 'result'
>;

export interface NestorPermissionManagerLike {
  evaluateToolCall(toolName: string, input: Record<string, unknown>): ToolPermissionResult;
}

export interface NestorToolTelemetry {
  semanticId: string;
  presentedName: string;
  source: 'nestor-a2a';
  dialect: 'a2a';
  adapterVersion: 1;
  provenance: string;
  decisionId: string;
  outcome: string;
}

export interface NestorPreToolUseInput {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface NestorPostToolUseInput extends NestorPreToolUseInput {
  toolResponse: string;
  isError: boolean;
}

export interface NestorCloudToolExecutorOptions {
  /** Captured session filesystem authority shared with local tools. */
  filesystemScope: SessionFilesystemScope;
  sessionKey: SessionKey;
  abortSignal: AbortSignal;
  permissionManager: NestorPermissionManagerLike;
  mcpPool?: Pick<McpClientPool, 'callTool' | 'isProxyTool'> & {
    getProxyName?: (sourceSlug: string, originalName: string, leaserId?: string) => string;
  };
  /** Leaser identity for a SHARED workspace pool (per-session view scoping). */
  mcpLeaserId?: string;
  onPermissionRequest?: (request: {
    requestId: string;
    toolName: string;
    command?: string;
    description: string;
    type?: 'bash' | 'file_write' | 'mcp_mutation' | 'ask_user';
  }) => void;
  onTelemetry?: (event: NestorToolTelemetry) => void;
  /**
   * Load an advertised skill's instruction body (F4). Absent means this session
   * has no skill registry wired, which is answered exactly like a lookup
   * failure — a backend that advertises `activate_skill` unconditionally
   * (`codeagent/agent.go:80-82`) must always get a well-formed answer.
   *
   * Rejecting is the documented way to say "no such skill"; the rejection
   * message is what the model reads.
   */
  resolveSkill?: (skillName: string) => Promise<NestorSkillActivation>;
  onPreToolUse?: (input: NestorPreToolUseInput) => Promise<PreToolUseDecision | undefined>;
  onPostToolUse?: (input: NestorPostToolUseInput) => Promise<PreToolUseDecision | undefined>;
  runCommand?: (
    command: string,
    cwd: string,
    options?: { timeout?: number; signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  sessionPath?: string;
  summarizeLargeResult?: (prompt: string) => Promise<string | null>;
  contextWindow?: number;
  /**
   * P3.323 — the RESULTS half of the `deniedPaths` floor, for THIS backend.
   *
   * `LocalToolRuntime` calls this at all five result seams (`search_files`,
   * `grep`, `find`, `ls`, `list_files`), and this executor is the SECOND
   * production site that constructs one. Pi's got the option in P3.272 and this
   * one did not, so a `grep` rooted one directory above a denied file passed the
   * REQUEST gate with a perfectly legal `path` argument and returned the denied
   * file's lines — P3.105's asymmetry, on a live backend, three rows after it
   * was closed everywhere else.
   *
   * Absent, the search and discovery tools behave exactly as before and withhold
   * nothing: the honest status quo, not a silent partial filter.
   */
  filterDeniedResultPaths?: DeniedResultPathFilter;
}

export class NestorCloudToolExecutor {
  private readonly runtime: LocalToolRuntime;
  private readonly permissionGate: LocalToolPermissionGate;
  private readonly calls = new Map<string, NormalizedNestorToolCall>();
  private readonly ports: ReadonlyMap<string, ToolExecutionPort>;
  private readonly executor: ReturnType<typeof createToolExecutor>;
  private readonly sessionKey: SessionKey;
  private readonly pendingHookPermissions = new Map<string, (allowed: boolean) => void>();
  private responseEpoch = 1;
  private disposed = false;

  constructor(private readonly options: NestorCloudToolExecutorOptions) {
    this.sessionKey = options.sessionKey;
    this.runtime = new LocalToolRuntime({
      filesystemScope: options.filesystemScope,
      permissionManager: options.permissionManager,
      mcpPool: options.mcpPool,
      ...(options.mcpLeaserId ? { mcpLeaserId: options.mcpLeaserId } : {}),
      onPermissionRequest: options.onPermissionRequest,
      runCommand: options.runCommand,
      sessionPath: options.sessionPath,
      summarizeLargeResult: options.summarizeLargeResult,
      contextWindow: options.contextWindow,
      // P3.323 — spread-conditional, so an executor built without the filter
      // spawns byte-identically to before and `LocalToolRuntime`'s own
      // "absent means withhold nothing" branch is what runs.
      ...(options.filterDeniedResultPaths
        ? { filterDeniedResultPaths: options.filterDeniedResultPaths }
        : {}),
    });
    this.permissionGate = new LocalToolPermissionGate(options);
    const executionPorts = createNestorToolExecutionPorts({
      resolveCall: executionId => this.calls.get(executionId),
      resolveMcpProxy: (server, tool) => options.mcpPool?.getProxyName?.(server, tool, options.mcpLeaserId)
        ?? `mcp__${server}__${tool.replace(/\//g, '__')}`,
    });
    this.ports = new Map(executionPorts.map(port => [port.semanticId, port]));
    const pendingCheckpoints = new Map<string, string>();
    const manifestIdentity = {
      generation: ADAPTER_GENERATION,
      manifestHash: ADAPTER_HASH,
      responseEpoch: this.responseEpoch,
    };
    this.executor = createToolExecutor({
      runtime: this.runtime,
      ports: executionPorts,
      authority: {
        sessionKey: this.sessionKey,
        manifestIdentity,
        getCurrentResponseEpoch: () => this.responseEpoch,
      },
      permissionBridge: async (request, input) => {
        const port = this.ports.get(request.semanticId);
        if (!port || port.dispatch.kind !== 'local') throw new Error('Missing Nestor execution port');
        const localCall = port.dispatch.toLocalCall(input, request, request.abortSignal);
        const decision = await this.permissionGate.check(localCall);
        return {
          allowed: decision.allowed,
          decisionId: `nestor-a2a:${request.executionId}`,
          canonicalInput: input,
          reason: decision.reason,
        };
      },
      beforeDispatch: async (request, descriptor, input) => {
        if (!options.sessionPath || !descriptor.checkpointAdapter) return;
        const localCall = this.ports.get(request.semanticId)?.dispatch;
        if (!localCall || localCall.kind !== 'local') throw new Error('Missing Nestor execution port');
        const call = localCall.toLocalCall(input, request, request.abortSignal);
        const operation = call.operation;
        if (operation.kind !== 'write_file' && operation.kind !== 'replace_in_file' && operation.kind !== 'edit_file') {
          throw new Error(`File checkpoint adapter cannot handle ${operation.kind}`);
        }
        const path = resolveScopedPath(operation.path, options.filesystemScope, { access: 'write' });
        const [checkpoint] = await createFileCheckpoint({
          sessionPath: options.sessionPath,
          adapter: descriptor.checkpointAdapter,
          toolName: call.permission.toolName,
          toolCallId: request.executionId,
          input: { ...call.permission.input, file_path: path },
        });
        if (checkpoint) pendingCheckpoints.set(request.executionId, checkpoint.id);
        return checkpoint ? { checkpointId: checkpoint.id } : undefined;
      },
      afterDispatch: async (request, _descriptor, _input, outcome) => {
        const checkpointId = pendingCheckpoints.get(request.executionId);
        if (!checkpointId || !options.sessionPath) return;
        pendingCheckpoints.delete(request.executionId);
        await finalizeFileCheckpoint({
          sessionPath: options.sessionPath,
          checkpointId,
          succeeded: Boolean(outcome.result && !outcome.result.isError),
        });
        return { checkpointId };
      },
    });
    options.abortSignal.addEventListener('abort', this.dispose, { once: true });
  }

  async execute(call: NestorToolCall): Promise<NestorToolExecutionResult> {
    if (this.disposed) return this.failure(call, undefined, 'Nestor tool execution is cancelled');
    let normalized: NormalizedNestorToolCall;
    try {
      normalized = normalizeNestorToolCall(call);
    } catch (error) {
      return this.failure(call, undefined, invalidArgumentsMessage(error));
    }
    if (!normalized.semanticId) return this.failure(call, normalized, `Unsupported Nestor tool: ${call.name}`);

    let preToolDecision: PreToolUseDecision | undefined;
    try {
      preToolDecision = await this.options.onPreToolUse?.({
        toolUseId: call.id,
        toolName: normalized.name,
        toolInput: structuredClone(normalized.args),
      });
    } catch (error) {
      return this.failure(call, normalized, `Nestor PreToolUse hook failed: ${errorMessage(error)}`);
    }
    if (preToolDecision?.decision === 'block' || preToolDecision?.decision === 'deny') {
      return this.failure(call, normalized, preToolDecision.reason ?? 'Blocked by PreToolUse hook');
    }
    if (preToolDecision?.updatedInput) {
      try {
        const updated = normalizeNestorToolCall({
          ...call,
          name: normalized.name,
          arguments: JSON.stringify(preToolDecision.updatedInput),
        });
        if (updated.semanticId !== normalized.semanticId) throw new Error('Nestor semantic identity mismatch');
        normalized = updated;
      } catch (error) {
        return this.failure(call, normalized, invalidArgumentsMessage(error));
      }
    }
    const semanticId = normalized.semanticId;
    if (!semanticId) return this.failure(call, normalized, `Unsupported Nestor tool: ${call.name}`);
    if (preToolDecision?.decision === 'ask' && !await this.requestHookPermission(normalized, preToolDecision.reason)) {
      return this.failure(call, normalized, preToolDecision.reason ?? 'Permission denied by PreToolUse hook');
    }

    this.calls.set(call.id, normalized);
    const requestId = `nestor-cloud-${call.id}`;
    const signal = this.options.abortSignal;
    const cancelApproval = () => this.permissionGate.respondToPermission(requestId, false);
    signal.addEventListener('abort', cancelApproval, { once: true });
    try {
      // `activate_skill` is answered from the session's skill registry, so it
      // short-circuits the local-tool pipeline entirely: it has no filesystem
      // target, no permission subject and no execution port (the reference
      // connector's ActivateSkillTool sets `permissionRequired = false`). The
      // hook rails above and the result rails below still apply to it.
      const receipt: NestorExecutionOutcome = semanticId === 'skill'
        ? await this.activateSkill(normalized)
        : await this.executor.execute({
          executionId: call.id,
          sessionKey: this.sessionKey,
          manifestIdentity: {
            generation: ADAPTER_GENERATION,
            manifestHash: ADAPTER_HASH,
            responseEpoch: this.responseEpoch,
          },
          semanticId,
          canonicalInput: normalized.args,
          source: 'nestor-a2a',
          presentedName: call.name,
          abortSignal: signal,
        });
      try {
        this.options.onTelemetry?.(Object.freeze({
          semanticId,
          presentedName: boundedAdapterString(call.name),
          source: 'nestor-a2a',
          dialect: 'a2a',
          adapterVersion: ADAPTER_VERSION,
          provenance: ADAPTER_PROVENANCE,
          decisionId: boundedAdapterString(receipt.decisionId),
          outcome: receipt.outcome,
        }));
      } catch {
        // Telemetry is observational and cannot change the public A2A result.
      }
      let content = receipt.result.content;
      let error = receipt.outcome === 'success'
        ? undefined
        : receipt.reason ?? receipt.result.error ?? receipt.result.content;
      let structuredContent = receipt.result.structuredContent;
      let postToolDecision: PreToolUseDecision | undefined;
      try {
        postToolDecision = await this.options.onPostToolUse?.({
          toolUseId: call.id,
          toolName: normalized.name,
          toolInput: structuredClone(normalized.args),
          toolResponse: error ?? content,
          isError: error !== undefined,
        });
      } catch {
        // PostToolUse is observational and cannot change tool success/failure.
      }
      if (postToolDecision?.updatedToolOutput !== undefined) {
        // P3.162 · this forwarded the hook's replacement RAW, and this is the
        // one runtime where nothing downstream re-checks it. The Claude path
        // can forward raw because the SDK applies the rule itself
        // (hooks.md#posttooluse-decision-control: "For built-in tools, a value
        // that doesn't match the tool's output schema is ignored and the
        // original output is used. MCP tool output is passed through without
        // schema validation."); the Nestor wire has no such consumer — the
        // replacement goes straight onto `content`/`error` and into the
        // `tool_result` event. So mirror the SDK's rule rather than invent one:
        // `resolveHookToolOutputRewrite` IS that rule, already calibrated to
        // these same built-ins ("their results travel the Pi wire as text"),
        // and unlike the SDK path the original here really is a string, so it
        // applies without the `.trim()` crash that refuted P3.148.
        //
        // The MCP escape hatch keys on the pool's minted proxy name, not the
        // `server|tool` name the backend advertises — `normalized.name` is
        // rewritten to the advertised spelling by `normalizeNestorToolCall`,
        // which never starts with `mcp__`, so passing it would put every
        // external MCP result through the built-in JSON-kind check.
        const rewrite = resolveHookToolOutputRewrite({
          toolName: normalized.mcp?.proxyName ?? normalized.name,
          originalOutput: error ?? content,
          updatedToolOutput: postToolDecision.updatedToolOutput,
        });
        // A skill-registry failure's prefix is the backend's ONLY signal that
        // the activation failed (skills.go:59-61); a hook rewrite that drops it
        // would mark the skill activated forever. Keep the original in that one
        // case — additionalContext still appends below, prefix stays at byte 0.
        const skillFailurePrefixLost = 'output' in rewrite
          && error === undefined
          && content.startsWith(NESTOR_SKILL_FAILURE_PREFIX)
          && !rewrite.output.startsWith(NESTOR_SKILL_FAILURE_PREFIX);
        if ('output' in rewrite && !skillFailurePrefixLost) {
          if (error === undefined) content = rewrite.output;
          else error = rewrite.output;
          // The drop is COUPLED to the rewrite, not collateral to it, and that
          // is why it moved inside the guard. `structuredContent` is the
          // machine-readable twin of the text on the same `tool_result` event
          // and it is persisted with the transcript; hooks.md#decision-control
          // names redaction as this field's purpose ("For redaction or
          // transformation use cases, intercept at […] `PostToolUse` for
          // inbound tool results"), so leaving the original structure beside a
          // redacted string would keep the secret one field over. What was
          // wrong before is that it dropped for a replacement the documented
          // rule says to IGNORE — losing the structured half while the model
          // still saw the original text.
          structuredContent = undefined;
        }
      }
      const hookContext = [preToolDecision?.additionalContext, postToolDecision?.additionalContext]
        .filter((value): value is string => Boolean(value?.trim()));
      if (hookContext.length > 0) {
        if (error === undefined) content = appendHookContext(content, hookContext);
        else error = appendHookContext(error, hookContext);
      }
      return this.result(
        call,
        content,
        error !== undefined,
        structuredContent,
        error,
      );
    } finally {
      signal.removeEventListener('abort', cancelApproval);
      this.calls.delete(call.id);
    }
  }

  respondToPermission(
    requestId: string,
    allowed: boolean,
    _alwaysAllow?: boolean,
    _options?: PermissionResponseOptions,
  ): void {
    const hookPermission = this.pendingHookPermissions.get(requestId);
    if (hookPermission) {
      this.pendingHookPermissions.delete(requestId);
      hookPermission(allowed);
      return;
    }
    this.permissionGate.respondToPermission(requestId, allowed);
  }

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.responseEpoch += 1;
    for (const executionId of this.calls.keys()) {
      this.permissionGate.respondToPermission(`nestor-cloud-${executionId}`, false);
    }
    for (const resolve of this.pendingHookPermissions.values()) resolve(false);
    this.pendingHookPermissions.clear();
    this.options.abortSignal.removeEventListener('abort', this.dispose);
  };

  /**
   * Answer `activate_skill` from the session skill registry.
   *
   * BOTH branches report `outcome: 'success'`, and the failure branch puts its
   * text in `content` with `error` left unset. That is the contract, not a
   * swallowed error: the reference connector returns `approved: true` for a
   * registry miss too, and the backend only recognises a failed activation by
   * the literal prefix on the tool result TEXT
   * (`codeagent/skills.go:59-61`). Routing it through `error` would have the
   * backend wrap it in `<tool_error>`, the prefix check would miss, and the
   * skill would be marked activated for the rest of the conversation — so the
   * model could never load it again.
   */
  private async activateSkill(call: NormalizedNestorToolCall): Promise<NestorExecutionOutcome> {
    const decisionId = `nestor-a2a:${call.id}`;
    const skillName = typeof call.args.skill_name === 'string' ? call.args.skill_name : '';
    let content: string;
    try {
      if (!this.options.resolveSkill) throw new Error('skills are not available in this session');
      const activation = await this.options.resolveSkill(skillName);
      content = formatNestorSkillContent({ ...activation, name: skillName });
    } catch (error) {
      content = formatNestorSkillFailure(errorMessage(error));
    }
    return { decisionId, outcome: 'success', result: { content, isError: false } };
  }

  private async requestHookPermission(call: NormalizedNestorToolCall, reason?: string): Promise<boolean> {
    if (this.options.abortSignal.aborted || !this.options.onPermissionRequest) return false;
    // Mapping can now REJECT a call whose arguments are well-typed but unusable — a malformed
    // `replace_in_file` diff. On the normal path that throw is the permission bridge's, and its
    // message reaches the model as the tool error. Here it would escape `execute()` and reject
    // the whole turn, so an unmappable call is treated as the un-approvable call it already was.
    let localCall: LocalToolCall | null = null;
    try {
      localCall = toLocalToolCall(call);
    } catch {
      localCall = null;
    }
    // A skill activation legitimately has NO local-tool mapping (it is answered
    // from the session registry), so the null above is not "unmappable" for it —
    // treating it as such turned a hook's `ask` into a silent deny. It asks with
    // no command and no permission `type`, both of which are optional on the
    // request.
    if (!localCall && call.semanticId !== 'skill') return false;
    const requestId = `nestor-cloud-hook-${call.id}`;
    const allowed = new Promise<boolean>((resolve) => {
      this.pendingHookPermissions.set(requestId, resolve);
    });
    this.options.onPermissionRequest({
      requestId,
      toolName: call.name,
      ...(localCall?.permission.command !== undefined ? { command: localCall.permission.command } : {}),
      description: reason ?? `PreToolUse hook requires approval for ${call.name}`,
      ...(localCall?.permission.type !== undefined ? { type: localCall.permission.type } : {}),
    });
    return allowed;
  }

  /**
   * The ONE failure funnel every early return in {@link execute} goes through.
   *
   * For `activate_skill` the answer is NOT an A2A error. The backend rewrites a
   * result carrying `error` into `<tool_error>…` (`mapping/tool_result.go:11-17`),
   * `isSkillRegistryErrorResponse` then fails to see the literal prefix
   * (`codeagent/skills.go:59-61`), and `skills.go:37-38` counts the skill as
   * ACTIVATED for the rest of the conversation — every later activation of the
   * same name is answered "Skill content is already loaded" and the model never
   * receives the instructions. So a skill failure ALWAYS rides `content` with the
   * prefix and `error` unset, whether it was raised inside
   * {@link activateSkill} or by the disposed guard, argument normalization, or a
   * PreToolUse hook that blocked, threw, or denied its own `ask`.
   *
   * `normalized` is absent exactly when normalization itself failed, which is why
   * the presented name is the second half of the test.
   */
  private failure(
    call: NestorToolCall,
    normalized: NormalizedNestorToolCall | undefined,
    message: string,
  ): NestorToolExecutionResult {
    const bounded = boundedAdapterString(message);
    return normalized?.semanticId === 'skill' || call.name === NESTOR_ACTIVATE_SKILL_TOOL_NAME
      ? this.result(call, formatNestorSkillFailure(bounded), false)
      : this.result(call, bounded, true);
  }

  private result(
    call: Pick<NestorToolCall, 'id' | 'name'>,
    content: string,
    isError: boolean,
    structuredContent?: LocalToolExecutionResult['structuredContent'],
    error?: string,
  ): NestorToolExecutionResult {
    const resultContent = error ?? content;
    const event: AgentEvent = {
      type: 'tool_result',
      toolUseId: call.id,
      toolName: call.name,
      result: resultContent,
      isError,
      ...(structuredContent ? { structuredContent } : {}),
    };
    return {
      content: isError ? '' : content,
      error: isError ? resultContent : undefined,
      events: [event],
    };
  }
}

function invalidArgumentsMessage(error: unknown): string {
  return `Invalid Nestor tool arguments: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The tool-result twin of `nestor-cloud-agent.ts`'s `<hook_context>` block, and
 * it takes the identical mitigation (P2.31).
 *
 * `contexts` is the `additionalContext` a PreToolUse and a PostToolUse hook
 * printed on STDOUT — a shell script's bytes, frequently a command's output the
 * script merely relayed. Composed raw it could write `</tool_hook_context>` and
 * continue in the host's voice inside a tool result the remote agent reads.
 * `untrusted-text.ts:wrapUntrusted` fences it and runs it through
 * `neutralizeHarnessMarkers`; the fence is self-protecting because `untrusted`
 * is one of that defanger's three names.
 *
 * The outer element, the two-newline separator, the trim/drop-empty filter and
 * the pre-then-post order are unchanged — `content` still begins with whatever
 * it began with, which is what keeps `NESTOR_SKILL_FAILURE_PREFIX` at byte 0.
 *
 * P2.236 · composed by the shared `fenceHookBand` now, which adds
 * `UNTRUSTED_HOOK_NOTICE` above the fence. The three parts this comment already
 * described are byte-identical; what was missing was any statement of what a
 * hook's bytes may DO, which is the half that gives containment its value.
 *
 * `fenceHookBand` returns `undefined` for a blank body. The caller only reaches
 * this function with at least one non-blank context, so the fallback is the
 * belt: it returns `output` untouched rather than emitting an empty element.
 */
function appendHookContext(output: string, contexts: readonly string[]): string {
  const band = fenceHookBand({
    element: 'tool_hook_context',
    source: 'tool_hook_context',
    body: contexts.map(value => value.trim()).filter(Boolean).join('\n\n'),
  });
  if (!band) return output;
  return `${output}${output ? '\n\n' : ''}${band}`;
}

function boundedAdapterString(value: string): string {
  return value.slice(0, MAX_ADAPTER_ERROR);
}
