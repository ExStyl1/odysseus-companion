import type { NestorToolCall } from './event-adapter.ts';

// The vocabulary is the backend's, not ours: every name, key set and requiredness below is
// transcribed from `internal/usecase/vibe/agent/codeagent/tools.go` (@ df526b7), whose tool
// definitions are all `Strict: true`, so nothing else can ever arrive. The list is the UNION
// across agent modes — `write_to_file`/`replace_in_file` are ACT-only and `plan_mode_respond`
// is PLAN-only (`codeagent/agent.go:70-94`), and `activate_skill` rides the `a2a_skills_enabled`
// flag, ENABLE by default since 2026-07-29 (`internal/usecase/flag/default.go:82-85`).
export const NESTOR_BUILTIN_TOOL_NAMES = [
  'read_file',
  'list_files',
  'search_files',
  'write_to_file',
  'replace_in_file',
  'execute_command',
  'ask_followup_question',
  'plan_mode_respond',
  'activate_skill',
] as const;

export type NestorBuiltinToolName = typeof NESTOR_BUILTIN_TOOL_NAMES[number];
export type NestorSemanticId =
  | 'read' | 'ls' | 'grep' | 'write' | 'edit' | 'bash' | 'ask_user' | 'submit_plan' | 'skill' | 'mcp_dynamic';

const BUILTIN_SEMANTIC_IDS: Readonly<Record<NestorBuiltinToolName, NestorSemanticId>> = Object.freeze({
  read_file: 'read',
  list_files: 'ls',
  search_files: 'grep',
  write_to_file: 'write',
  replace_in_file: 'edit',
  execute_command: 'bash',
  ask_followup_question: 'ask_user',
  plan_mode_respond: 'submit_plan',
  activate_skill: 'skill',
});

/**
 * The one builtin answered from the session's own skill registry rather than a
 * local-tool port. Spelled once here because the executor's failure funnel has to
 * recognise it on the PRESENTED name — i.e. on a call whose normalization threw,
 * where there is no `semanticId` left to dispatch on.
 */
export const NESTOR_ACTIVATE_SKILL_TOOL_NAME: NestorBuiltinToolName = 'activate_skill';

export const NESTOR_TERMINAL_TOOL_NAMES = [
  'ask_followup_question',
  'plan_mode_respond',
] as const satisfies readonly NestorBuiltinToolName[];

export interface NormalizedNestorToolCall extends NestorToolCall {
  args: Record<string, unknown>;
  kind: 'builtin' | 'mcp' | 'unknown';
  semanticId?: NestorSemanticId;
  builtinName?: NestorBuiltinToolName;
  mcp?: {
    server: string;
    tool: string;
    proxyName: string;
    args: Record<string, unknown>;
  };
}

const BUILTINS = new Set<string>(NESTOR_BUILTIN_TOOL_NAMES);
const TERMINAL_TOOLS = new Set<string>(NESTOR_TERMINAL_TOOL_NAMES);
const MCP_TOOL_NAME_SEPARATOR = '|';
const MCP_USE_TOOL_NAME = 'use_mcp_tool';
const MCP_LEGACY_PREFIX = 'mcp__';
const MCP_LEGACY_SEPARATOR = '__';

/**
 * The ONE spelling of an advertised MCP tool name, written next to the parser that has to
 * read it back. The backend echoes `metadata.mcp[].name` to the model and returns it verbatim
 * on the call (`codeagent/agent.go:95-112`, `Name: tool.Name`, `Strict: true`), so advertise
 * and parse are a single decision — `server|tool`, the same form the reference connector uses
 * (`CONNECTOR/src/metadata/mcp/provider.ts:11-16`).
 *
 * `tool` is the server's RAW tool name, never the pool's minted `mcp__…` proxy name:
 * `McpClientPool.getProxyName(slug, originalName)` is the authority that maps the pair back
 * onto the executable proxy name (sanitization + collision suffixes), and it can only do that
 * lookup from the original name.
 */
export function buildAdvertisedMcpName(server: string, tool: string): string {
  return `${server}${MCP_TOOL_NAME_SEPARATOR}${tool}`;
}

export function parseRemoteToolCall(data: Record<string, unknown>): NestorToolCall | null {
  if (typeof data.id !== 'string' || typeof data.index !== 'number') return null;
  const fn = data.function;
  if (typeof fn !== 'object' || fn === null) return null;
  const name = (fn as Record<string, unknown>).name;
  const args = (fn as Record<string, unknown>).arguments;
  if (typeof name !== 'string') return null;
  if (typeof args !== 'string' && (typeof args !== 'object' || args === null)) return null;
  return {
    id: data.id,
    index: data.index,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  };
}

export function normalizeNestorToolCall(call: NestorToolCall): NormalizedNestorToolCall {
  const args = parseArgs(call.arguments);

  if (BUILTINS.has(call.name)) {
    const builtinName = call.name as NestorBuiltinToolName;
    return {
      ...call,
      kind: 'builtin',
      builtinName,
      semanticId: BUILTIN_SEMANTIC_IDS[builtinName],
      args: validateBuiltinArgs(builtinName, args),
    };
  }

  const mcp = normalizeMcp(call.name, args);
  if (mcp) {
    return {
      ...call,
      name: buildAdvertisedMcpName(mcp.server, mcp.tool),
      arguments: JSON.stringify(mcp.args),
      args: mcp.args,
      kind: 'mcp',
      semanticId: 'mcp_dynamic',
      mcp,
    };
  }

  return { ...call, args, kind: 'unknown' };
}

export function buildA2AToolResultData(input: {
  toolCallId: string;
  content?: string;
  error?: string;
}): { tool_call_id: string; content: string; error?: string } {
  return {
    tool_call_id: input.toolCallId,
    content: input.content ?? '',
    ...(input.error ? { error: input.error } : {}),
  };
}

export function isNestorTerminalTool(name: string): boolean {
  return TERMINAL_TOOLS.has(name);
}

/**
 * What a terminal tool call hands to the USER, and the raw arguments it carried.
 *
 * `ask_followup_question` renders as the question, a SINGLE newline, then the
 * choices numbered from 1 — the reference connector's exact spelling
 * (`CONNECTOR/src/tools/ask-followup-question/acp.ts:11-21`), which matters
 * because the backend's own tool description tells the model the user answers by
 * picking one of them (`tools.go:320`). `plan_mode_respond` renders as its
 * response verbatim (`tools.go:38-65` declares nothing else).
 *
 * Deliberately LENIENT where {@link normalizeNestorToolCall} is strict: this text
 * is the only thing standing between the user and a suspended turn, so an
 * unexpected extra key or a malformed `followup` entry must not swallow the
 * question. Nothing here is dispatched, so there is no closed key set to enforce.
 */
export function readNestorTerminalToolPrompt(call: NestorToolCall): {
  text: string;
  input: Record<string, unknown>;
} {
  const input = lenientArgs(call.arguments);
  if (call.name === 'ask_followup_question') {
    const question = typeof input.question === 'string' ? input.question : '';
    const choices = Array.isArray(input.followup)
      ? input.followup.filter((choice): choice is string => typeof choice === 'string' && choice.length > 0)
      : [];
    const numbered = choices.map((choice, index) => `${index + 1}. ${choice}`).join('\n');
    return { text: numbered ? `${question}\n${numbered}` : question, input };
  }
  if (call.name === 'plan_mode_respond') {
    return { text: typeof input.response === 'string' ? input.response : '', input };
  }
  return { text: '', input };
}

function lenientArgs(value: string): Record<string, unknown> {
  try {
    return recordValue(JSON.parse(value) as unknown) ?? {};
  } catch {
    return {};
  }
}

function normalizeMcp(name: string, args: Record<string, unknown>) {
  // First occurrence wins, so a `|` inside a raw tool name stays in the tool segment — the
  // same split the reference connector performs (`CONNECTOR/src/adapter/a2a/utils.ts:222-226`).
  if (name.includes(MCP_TOOL_NAME_SEPARATOR)) {
    const [server, ...rest] = name.split(MCP_TOOL_NAME_SEPARATOR);
    const tool = rest.join(MCP_TOOL_NAME_SEPARATOR);
    if (server && tool) {
      return { server, tool, proxyName: buildProxyName(server, tool), args };
    }
  }

  // Legacy inbound: this module advertised the pool's minted `mcp__<slug>__<tool>` proxy name
  // before the `server|tool` fix, and a remote context created then can still echo one back.
  // Split after the FIRST `__` past the prefix: a slug is minted from [A-Za-z0-9_-] and a raw
  // tool name may itself contain `__`, so the remainder belongs to the tool. Best-effort by
  // construction — the pair only has to be good enough for `getProxyName`, whose fallback
  // rebuilds exactly this name when the reverse lookup misses.
  if (name.startsWith(MCP_LEGACY_PREFIX)) {
    const rest = name.slice(MCP_LEGACY_PREFIX.length);
    const boundary = rest.indexOf(MCP_LEGACY_SEPARATOR);
    if (boundary > 0 && boundary + MCP_LEGACY_SEPARATOR.length < rest.length) {
      const server = rest.slice(0, boundary);
      const tool = rest.slice(boundary + MCP_LEGACY_SEPARATOR.length);
      return { server, tool, proxyName: name, args };
    }
  }

  if (name !== MCP_USE_TOOL_NAME) return null;
  strictKeys(args, ['serverName', 'server', 'toolName', 'tool', 'arguments']);
  const serverValue = args.serverName ?? args.server;
  const toolValue = args.toolName ?? args.tool;
  if (typeof serverValue !== 'string' || typeof toolValue !== 'string') return null;

  return {
    server: serverValue,
    tool: toolValue,
    proxyName: buildProxyName(serverValue, toolValue),
    args: parseNestedArgs(args.arguments),
  };
}

function buildProxyName(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/\//g, '__')}`;
}

function parseArgs(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    const record = recordValue(parsed);
    if (!record) throw new Error('arguments must be an object');
    return record;
  } catch {
    throw new Error('Malformed Nestor tool arguments');
  }
}

function parseNestedArgs(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value === 'string') return parseArgs(value);
  const record = recordValue(value);
  if (!record) throw new Error('MCP arguments must be an object');
  return record;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateBuiltinArgs(
  name: NestorBuiltinToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (name) {
    // tools.go:11-35 — required ["path"].
    case 'read_file':
      strictKeys(args, ['path']);
      return { path: stringValue(args.path, 'path') };
    // tools.go:98-124 — required ["path","recursive"], but every call is re-marshalled to two
    // STRING fields by fixListFilesArgs (tools.go:126-144, applied at agent.go:374), which emits
    // an empty path for the workspace root. Empty path is therefore valid input, not a bad arg.
    case 'list_files':
      strictKeys(args, ['path', 'recursive']);
      return {
        ...(args.path === undefined ? {} : { path: stringValue(args.path, 'path', true) }),
        ...(args.recursive === undefined ? {} : { recursive: booleanValue(args.recursive, 'recursive') }),
      };
    // tools.go:260-292 — required ["path","regex"], optional "file_pattern" glob.
    case 'search_files':
      strictKeys(args, ['path', 'regex', 'file_pattern']);
      return {
        path: stringValue(args.path, 'path', true),
        regex: stringValue(args.regex, 'regex'),
        ...(args.file_pattern === undefined ? {} : { file_pattern: stringValue(args.file_pattern, 'file_pattern') }),
      };
    // tools.go:68-96 — required ["path","content"]; an empty file is a legitimate write.
    case 'write_to_file':
      strictKeys(args, ['path', 'content']);
      return { path: stringValue(args.path, 'path'), content: stringValue(args.content, 'content', true) };
    // tools.go:190-257 — required ["path","diff"], where diff is one or more SEARCH/REPLACE
    // blocks in plain text. There is no old_string/new_string on this wire.
    case 'replace_in_file':
      strictKeys(args, ['path', 'diff']);
      return {
        path: stringValue(args.path, 'path'),
        diff: stringValue(args.diff, 'diff'),
      };
    // tools.go:148-187 — required ["command"]; the schema declares no other property.
    case 'execute_command':
      strictKeys(args, ['command']);
      return { command: stringValue(args.command, 'command') };
    // tools.go:295-341 — required ["question"], optional "followup" (items string, minItems 2,
    // maxItems 4 at :329-330). The bounds are not enforced here: a client-side length check can
    // only manufacture a failure the backend did not, and the question would be lost with it.
    case 'ask_followup_question':
      strictKeys(args, ['question', 'followup']);
      return {
        question: stringValue(args.question, 'question'),
        ...(args.followup === undefined ? {} : { followup: stringArrayValue(args.followup, 'followup') }),
      };
    // tools.go:38-65 — required ["response"].
    case 'plan_mode_respond':
      strictKeys(args, ['response']);
      return { response: stringValue(args.response, 'response') };
    // tools.go:344-371 — required ["skill_name"]; appended whenever a2a_skills_enabled is on.
    case 'activate_skill':
      strictKeys(args, ['skill_name']);
      return { skill_name: stringValue(args.skill_name, 'skill_name') };
  }
}

function strictKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(args).find(key => !allowed.includes(key));
  if (extra) throw new Error(`Unknown Nestor tool argument: ${extra}`);
}

function stringValue(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`Invalid Nestor tool argument: ${name}`);
  }
  return value;
}

function stringArrayValue(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Invalid Nestor tool argument: ${name}`);
  }
  return value as string[];
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid Nestor tool argument: ${name}`);
}
