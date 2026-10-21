import { describe, expect, it } from 'bun:test';
import {
  NESTOR_BUILTIN_TOOL_NAMES,
  buildA2AToolResultData,
  isNestorTerminalTool,
  normalizeNestorToolCall,
  parseRemoteToolCall,
  type NestorBuiltinToolName,
  type NestorSemanticId,
} from '../tool-schema.ts';
import parity from './fixtures/provider-adapter-parity.json';

const BUILTIN_CASE_COUNT = 9;

function normalize(name: string, args: Record<string, unknown>) {
  return normalizeNestorToolCall({
    id: `call-${name}`,
    index: 0,
    name,
    arguments: JSON.stringify(args),
  });
}

describe('Nestor cloud tool schema', () => {
  it('maps every public builtin and both MCP spellings to canonical semantics', () => {
    const cases = parity.tools.slice(0, BUILTIN_CASE_COUNT) as Array<{
      name: NestorBuiltinToolName;
      semanticId: NestorSemanticId;
      args: Record<string, unknown>;
    }>;
    expect(cases.map(value => value.name)).toEqual([...NESTOR_BUILTIN_TOOL_NAMES]);
    for (const { name, args, semanticId } of cases) {
      const call = normalize(name, args);

      expect(call.kind).toBe('builtin');
      expect(call.builtinName).toBe(name);
      expect(call.semanticId).toBe(semanticId);
      expect(call.args).toEqual(args);
    }
  });

  it('parses the observed live remote tool-call shape with JSON-string arguments', () => {
    const parsed = parseRemoteToolCall({
      id: 'call-1',
      index: 0,
      function: {
        name: 'list_files',
        arguments: '{"path":"/workspace","recursive":"false"}',
      },
    });

    expect(parsed).toEqual({
      id: 'call-1',
      index: 0,
      name: 'list_files',
      arguments: '{"path":"/workspace","recursive":"false"}',
    });
    expect(normalizeNestorToolCall(parsed!)).toMatchObject({
      semanticId: 'ls',
      args: { path: '/workspace', recursive: false },
    });
  });

  // The backend re-marshals every list_files call to two STRING fields and emits an
  // empty path for the workspace root (codeagent/tools.go:126-144, applied at
  // codeagent/agent.go:374), so an empty path is a valid root listing, not a bad argument.
  it('accepts the backend re-marshalled list_files arguments including an empty root path', () => {
    expect(normalize('list_files', { path: '', recursive: 'true' }).args)
      .toEqual({ path: '', recursive: true });
  });

  it('accepts the backend search_files schema of path + regex + file_pattern', () => {
    expect(normalize('search_files', { path: 'src', regex: 'needle', file_pattern: '*.ts' }).args)
      .toEqual({ path: 'src', regex: 'needle', file_pattern: '*.ts' });
    expect(normalize('search_files', { path: 'src', regex: 'needle' }).args)
      .toEqual({ path: 'src', regex: 'needle' });
  });

  it('accepts the backend replace_in_file schema of path + diff', () => {
    const diff = '<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE';
    expect(normalize('replace_in_file', { path: 'a.ts', diff }).args).toEqual({ path: 'a.ts', diff });
  });

  it('accepts ask_followup_question answer choices', () => {
    expect(normalize('ask_followup_question', { question: 'which db?', followup: ['postgres', 'sqlite'] }).args)
      .toEqual({ question: 'which db?', followup: ['postgres', 'sqlite'] });
    expect(normalize('ask_followup_question', { question: 'which db?' }).args)
      .toEqual({ question: 'which db?' });
    // tools.go:329-330 documents minItems 2 / maxItems 4, but a client-side bound could only
    // manufacture a failure the backend did not: an out-of-range list is carried, not rejected.
    expect(normalize('ask_followup_question', { question: 'q', followup: ['only'] }).args)
      .toEqual({ question: 'q', followup: ['only'] });
  });

  it('accepts activate_skill as a non-terminal builtin with a skill semantic id', () => {
    const call = normalize('activate_skill', { skill_name: 'release-notes' });

    expect(call.kind).toBe('builtin');
    expect(call.builtinName).toBe('activate_skill');
    expect(call.semanticId).toBe('skill');
    expect(call.args).toEqual({ skill_name: 'release-notes' });
    expect(isNestorTerminalTool('activate_skill')).toBe(false);
  });

  it('always builds A2A tool result data with tool_call_id and string content', () => {
    expect(buildA2AToolResultData({ toolCallId: 'call-1' })).toEqual({
      tool_call_id: 'call-1',
      content: '',
    });
    expect(buildA2AToolResultData({ toolCallId: 'call-1', content: 'ok', error: 'boom' })).toEqual(parity.a2aResult);
  });

  it('normalizes MCP-style names', () => {
    const call = normalizeNestorToolCall({
      id: 'call-mcp',
      index: 1,
      name: 'jira|get_issue',
      arguments: '{"key":"ABC-1"}',
    });

    expect(call.kind).toBe('mcp');
    expect(call.mcp).toEqual({
      server: 'jira',
      tool: 'get_issue',
      proxyName: 'mcp__jira__get_issue',
      args: { key: 'ABC-1' },
    });
    expect(call.semanticId).toBe('mcp_dynamic');
  });

  // First-occurrence split, matching the reference connector's `splitMcpToolName`
  // (`CONNECTOR/src/adapter/a2a/utils.ts:222-226`, `indexOf`): a `|` inside the TOOL name
  // stays part of the tool, so the server segment is never guessed.
  it('splits an MCP name at the FIRST separator so a tool name may contain one', () => {
    const call = normalizeNestorToolCall({
      id: 'call-mcp',
      index: 1,
      name: 'jira|a|b',
      arguments: '{}',
    });

    expect(call.mcp?.server).toBe('jira');
    expect(call.mcp?.tool).toBe('a|b');
    expect(call.name).toBe('jira|a|b');
  });

  // Legacy inbound: a remote context minted before this build was advertised the pool's
  // `mcp__<slug>__<tool>` proxy name and can still echo it back. Accept it rather than
  // answering `Unsupported Nestor tool`.
  it('accepts a legacy mcp__server__tool name inbound', () => {
    const call = normalizeNestorToolCall({
      id: 'call-mcp',
      index: 1,
      name: 'mcp__jira__get_issue',
      arguments: '{"key":"ABC-1"}',
    });

    expect(call.kind).toBe('mcp');
    expect(call.name).toBe('jira|get_issue');
    expect(call.mcp).toEqual({
      server: 'jira',
      tool: 'get_issue',
      proxyName: 'mcp__jira__get_issue',
      args: { key: 'ABC-1' },
    });
    expect(call.semanticId).toBe('mcp_dynamic');
  });

  it('leaves a legacy name with an empty server or tool segment unsupported', () => {
    for (const name of ['mcp__', 'mcp__jira__', 'mcp____get_issue', 'mcp__jira']) {
      const call = normalizeNestorToolCall({ id: 'call-mcp', index: 1, name, arguments: '{}' });
      expect(call.kind).toBe('unknown');
      expect(call.semanticId).toBeUndefined();
    }
  });

  it('normalizes use_mcp_tool using connector-compatible server/tool fields', () => {
    const call = normalizeNestorToolCall({
      id: 'call-mcp',
      index: 1,
      name: 'use_mcp_tool',
      arguments: '{"serverName":"gitlab","toolName":"get_mr","arguments":{"id":42}}',
    });

    expect(call.kind).toBe('mcp');
    expect(call.name).toBe('gitlab|get_mr');
    expect(call.arguments).toBe('{"id":42}');
    expect(call.mcp?.proxyName).toBe('mcp__gitlab__get_mr');
    expect(call.semanticId).toBe('mcp_dynamic');
  });

  it('rejects malformed, missing, and extra arguments before permission', () => {
    const invalid = [
      { name: 'read_file', arguments: '{' },
      { name: 'read_file', arguments: '{}' },
      { name: 'read_file', arguments: '{"path":"a","extra":true}' },
      { name: 'list_files', arguments: '{"recursive":"yes"}' },
      { name: 'execute_command', arguments: '{"command":1}' },
      { name: 'search_files', arguments: '{"path":"src"}' },
      { name: 'replace_in_file', arguments: '{"path":"a.ts","diff":""}' },
      { name: 'activate_skill', arguments: '{}' },
      { name: 'activate_skill', arguments: '{"skill_name":"a","extra":1}' },
      { name: 'ask_followup_question', arguments: '{"question":"q","followup":"yes"}' },
      { name: 'ask_followup_question', arguments: '{"question":"q","followup":[1,2]}' },
    ];
    for (const [index, value] of invalid.entries()) {
      expect(() => normalizeNestorToolCall({ id: `bad-${index}`, index, ...value }), value.arguments).toThrow();
    }
  });

  // Negative controls: the shapes this adapter used to invent are no longer in the vocabulary,
  // so a regression back to them fails loudly instead of silently rejecting real backend calls.
  it.each([
    ['search_files', { path: 'src', pattern: 'needle' }, 'pattern'],
    ['replace_in_file', { path: 'a.ts', old_string: 'old', new_string: 'new' }, 'old_string'],
    ['execute_command', { command: 'pwd', cwd: '/tmp' }, 'cwd'],
  ] as const)('rejects the pre-contract %s shape', (name, args, unknownKey) => {
    expect(() => normalize(name, args)).toThrow(`Unknown Nestor tool argument: ${unknownKey}`);
  });

  it('allows an empty write_to_file content payload', () => {
    expect(normalize('write_to_file', { path: 'empty.txt', content: '' }).args.content).toBe('');
  });
});
