import type { LocalToolCall, LocalToolPermissionSubject } from '../../local-tools/index.ts';
import type { ToolExecutionPort, ToolExecutionRequest } from '../../pi-harness/tool-executor.ts';
import { parseSearchReplaceDiff } from './search-replace-diff.ts';
import {
  buildAdvertisedMcpName,
  normalizeNestorToolCall,
  type NestorSemanticId,
  type NormalizedNestorToolCall,
} from './tool-schema.ts';

export const NESTOR_SEMANTIC_IDS: readonly NestorSemanticId[] = Object.freeze([
  'read', 'ls', 'grep', 'write', 'edit', 'bash', 'ask_user', 'submit_plan', 'mcp_dynamic',
]);

export function createNestorToolExecutionPorts(options: {
  resolveCall(executionId: string): NormalizedNestorToolCall | undefined;
  resolveMcpProxy?(server: string, tool: string): string;
}): ToolExecutionPort[] {
  return NESTOR_SEMANTIC_IDS.map(semanticId => ({
    semanticId,
    canonicalize(input, request) {
      return reboundCall(options, request, input).args;
    },
    dispatch: {
      kind: 'local' as const,
      toLocalCall(input, request, signal) {
        const localCall = toLocalToolCall(reboundCall(options, request, input));
        if (!localCall) throw new Error(`Unsupported Nestor tool: ${request.presentedName}`);
        return { ...localCall, abortSignal: signal };
      },
    },
  }));
}

function reboundCall(
  options: Parameters<typeof createNestorToolExecutionPorts>[0],
  request: ToolExecutionRequest,
  input: unknown,
): NormalizedNestorToolCall {
  const original = options.resolveCall(request.executionId);
  if (!original || !original.semanticId) throw new Error(`Missing Nestor tool call: ${request.executionId}`);
  const rebound = normalizeNestorToolCall({
    id: original.id,
    index: original.index,
    // Re-spelled through the ONE builder `normalizeNestorToolCall` parses back, so
    // the separator cannot drift between the two halves of the same round-trip.
    name: original.kind === 'mcp' && original.mcp
      ? buildAdvertisedMcpName(original.mcp.server, original.mcp.tool)
      : original.name,
    arguments: JSON.stringify(input),
  });
  if (rebound.semanticId !== request.semanticId) throw new Error('Nestor semantic identity mismatch');
  if (rebound.mcp && options.resolveMcpProxy) {
    rebound.mcp.proxyName = options.resolveMcpProxy(rebound.mcp.server, rebound.mcp.tool);
  }
  return rebound;
}

export function toLocalToolCall(call: NormalizedNestorToolCall): LocalToolCall | null {
  if (call.kind === 'mcp' && call.mcp) {
    return baseLocalToolCall(call, {
      displayName: call.mcp.proxyName,
      operation: { kind: 'mcp', proxyName: call.mcp.proxyName, args: call.mcp.args },
      permission: { toolName: call.mcp.proxyName, input: call.mcp.args, type: 'mcp_mutation' },
    });
  }

  if (call.kind !== 'builtin' || !call.builtinName) {
    return null;
  }

  switch (call.builtinName) {
    case 'read_file':
      return baseLocalToolCall(call, {
        displayName: 'read_file',
        operation: { kind: 'read_file', path: call.args.path as string },
        permission: readPermission(readTargetPath(call.args.path)),
      });
    case 'list_files':
      return baseLocalToolCall(call, {
        displayName: 'list_files',
        operation: {
          kind: 'list_files',
          path: typeof call.args.path === 'string' ? call.args.path : undefined,
          recursive: call.args.recursive === true || call.args.recursive === 'true',
        },
        permission: readPermission(readTargetPath(call.args.path)),
      });
    // `regex` is Rust regex syntax and `file_pattern` a glob filter (tools.go:256-292), which is
    // the `grep` operation, not `search_files`: the latter passes `--fixed-strings` and has no
    // glob, so every real pattern the model writes would match nothing and the whole tree would
    // be searched for it.
    case 'search_files':
      return baseLocalToolCall(call, {
        displayName: 'search_files',
        operation: {
          kind: 'grep',
          pattern: call.args.regex as string,
          path: typeof call.args.path === 'string' ? call.args.path : undefined,
          glob: typeof call.args.file_pattern === 'string' ? call.args.file_pattern : undefined,
        },
        permission: readPermission(readTargetPath(call.args.path)),
      });
    case 'write_to_file':
      return baseLocalToolCall(call, {
        displayName: 'write_to_file',
        operation: {
          kind: 'write_file',
          path: call.args.path as string,
          content: call.args.content as string,
        },
        permission: {
          toolName: 'Write',
          input: { file_path: call.args.path, content: call.args.content },
          type: 'file_write',
        },
      });
    // The wire carries one plain-text `diff` of SEARCH/REPLACE blocks (tools.go:188-255), so the
    // multi-edit `edit_file` operation is the match — `replace_in_file`'s single oldString/newString
    // pair cannot express a two-block diff, and its arguments do not exist on this wire at all.
    // NAMED DEVIATION (owner call, review of T3-T6): the backend's rule 2 says "Each block
    // replaces only the first match occurrence"; our `edit_file` runtime instead REQUIRES the
    // SEARCH text to match exactly once and fails otherwise. The backend's rule 1 already orders
    // the model to "Include enough nearby context to make the match unique", so a multi-match
    // diff is a model error here — failing loudly through the backend's <tool_error> retry
    // channel beats silently editing the first of several sites. Pinned by the duplicate-match
    // test in tool-executor.test.ts.
    // A malformed diff throws `SearchReplaceDiffError`, whose message IS the retry guidance; the
    // executor's permission bridge turns that into the tool error the backend wraps in
    // `<tool_error>` for the model (mapping/tool_result.go:29-39).
    case 'replace_in_file':
      return baseLocalToolCall(call, {
        displayName: 'replace_in_file',
        operation: {
          kind: 'edit_file',
          path: call.args.path as string,
          edits: parseSearchReplaceDiff(call.args.diff as string),
        },
        permission: {
          toolName: 'Edit',
          input: {
            file_path: call.args.path,
            diff: call.args.diff,
          },
          type: 'file_write',
        },
      });
    case 'execute_command':
      return baseLocalToolCall(call, {
        displayName: 'execute_command',
        operation: {
          kind: 'bash',
          command: call.args.command as string,
        },
        permission: {
          toolName: 'Bash',
          input: { command: call.args.command },
          type: 'bash',
          command: String(call.args.command ?? ''),
        },
      });
    // The two terminal tools have NO local operation: they are answered by the
    // USER, and the turn suspends until the next prompt arrives to become their
    // `tool_result` (F5; `turn.ts`). The `return_text` mapping they used to carry
    // returned the model's own question as the answer (`local-tools/runtime.ts:94-95`),
    // so the user never saw the question and the model answered itself.
    case 'ask_followup_question':
    case 'plan_mode_respond':
      return null;
    // activate_skill resolves against the session skill registry rather than the filesystem
    // scope, so it has no local-tool operation either; `tool-executor.ts` answers it.
    case 'activate_skill':
      return null;
  }
}

/** The wire may carry an EMPTY path for the workspace root (`fixListFilesArgs` emits `path:""`);
 * `??` alone would let `''` through into path-scoped permission checks. */
function readTargetPath(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '.';
}

function readPermission(filePath: unknown): LocalToolPermissionSubject {
  return { toolName: 'Read', input: { file_path: filePath } };
}

function baseLocalToolCall(
  call: NormalizedNestorToolCall,
  values: Omit<LocalToolCall, 'id' | 'permissionRequestId'>,
): LocalToolCall {
  return {
    id: call.id,
    permissionRequestId: `nestor-cloud-${call.id}`,
    ...values,
  };
}
