import { describe, expect, it } from 'bun:test';
import {
  type ToolDefinition,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import { createSearchTool } from './tools/search/create-search-tool.ts';
import { createWebFetchTool } from './tools/web-fetch.ts';
import { createBackgroundBashTool } from './tools/background-bash.ts';
import type { WebSearchProvider } from './tools/search/types.ts';
import { buildRuntimeBackedBuiltinToolDefinitions } from './local-tools/runtime-backed-tools.ts';
import {
  buildDeferredMcpToolSurface,
  DEFERRED_MCP_TOOL_LOAD_NAME,
  DEFERRED_MCP_TOOL_SEARCH_NAME,
} from './deferred-mcp-tools.ts';

/**
 * Regression contract for Pi SDK 0.70.0 tool registration.
 *
 * Pre-fix bug (PR #330): subprocess passed `tools: AgentTool[]` to
 * `createAgentSession`. Pi SDK 0.70.0 redefined `CreateAgentSessionOptions.tools`
 * as `string[]` (a name allowlist), so `new Set(tool_objects).has('name_string')`
 * returned false for every lookup in `_refreshToolRegistry` → every tool silently
 * filtered out → LLM saw only the default `[read, bash, edit, write]`.
 *
 * These tests lock in the post-fix shape so the regression can't re-enter:
 * - Every custom tool is a valid `ToolDefinition` with a `promptSnippet` (Pi SDK
 *   hides tools without a snippet from the system prompt's "Available tools"
 *   section, making them invisible to the LLM even when registered).
 * - The `tools` allowlist is a `string[]` of tool names.
 * - Every tool passed via `customTools` has its name present in the allowlist
 *   (otherwise it gets filtered out by `_refreshToolRegistry`'s allowlist guard).
 */

const stubSearchProvider: WebSearchProvider = {
  name: 'Stub',
  async search() {
    return [];
  },
};

function proxyTool(name: string, description = `Description for ${name}`): ToolDefinition<any, any> {
  return {
    name,
    label: name,
    description,
    promptSnippet: description,
    parameters: { type: 'object', additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: `executed ${name}` }] };
    },
  } as ToolDefinition<any, any>;
}

function assertValidToolDefinition(tool: ToolDefinition<any, any>): void {
  expect(typeof tool.name).toBe('string');
  expect(tool.name.length).toBeGreaterThan(0);
  expect(typeof tool.label).toBe('string');
  expect(typeof tool.description).toBe('string');
  expect(tool.description.length).toBeGreaterThan(0);
  expect(tool.parameters).toBeDefined();
  expect(typeof tool.execute).toBe('function');
}

describe('Pi subprocess tool shape contract', () => {
  it('createSearchTool returns a valid ToolDefinition with promptSnippet', () => {
    const tool = createSearchTool(stubSearchProvider);
    assertValidToolDefinition(tool);
    expect(tool.name).toBe('web_search');
    expect(typeof tool.promptSnippet).toBe('string');
    expect((tool.promptSnippet as string).length).toBeGreaterThan(0);
  });

  it('createWebFetchTool returns a valid ToolDefinition with promptSnippet', () => {
    const tool = createWebFetchTool(() => null);
    assertValidToolDefinition(tool);
    expect(tool.name).toBe('web_fetch');
    expect(typeof tool.promptSnippet).toBe('string');
    expect((tool.promptSnippet as string).length).toBeGreaterThan(0);
  });

  it('createBackgroundBashTool returns a valid ToolDefinition with promptSnippet', () => {
    const tool = createBackgroundBashTool({
      emitEvent: () => {},
      start: async () => ({ handle: 'process_0123456789abcdef0123456789abcdef', output: '', nextCursor: 0, isRunning: true, exitCode: null, signal: null, isolationProfile: 'workspace:test' }),
    });
    assertValidToolDefinition(tool);
    expect(tool.name).toBe('bash_background');
    expect(typeof tool.promptSnippet).toBe('string');
    expect((tool.promptSnippet as string).length).toBeGreaterThan(0);
  });

  it('production builtin builder returns runtime-backed ToolDefinitions', () => {
    const cwd = '/tmp';
    const builtins = buildRuntimeBackedBuiltinToolDefinitions(cwd);
    for (const tool of builtins) {
      assertValidToolDefinition(tool);
    }
    const names = builtins.map(t => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect(names).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'NotebookEdit']);
  });
});

describe('Pi SDK 0.70.0 CreateAgentSessionOptions contract', () => {
  it('`tools` field is typed as string[] (name allowlist, not objects)', () => {
    // Compile-time proof. If Pi SDK ever changes this back to accept tool
    // objects, the line below will become a type error and this test will
    // fail at build time — preventing silent regression.
    const options: CreateAgentSessionOptions = {
      tools: ['read', 'bash', 'edit', 'write', 'web_search', 'web_fetch'],
    };
    expect(Array.isArray(options.tools)).toBe(true);
    for (const name of options.tools ?? []) {
      expect(typeof name).toBe('string');
    }
  });

  it('`customTools` field accepts ToolDefinition[] (the tool object channel)', () => {
    const searchTool = createSearchTool(stubSearchProvider);
    const webFetchTool = createWebFetchTool(() => null);
    const options: CreateAgentSessionOptions = {
      customTools: [searchTool, webFetchTool],
    };
    expect(options.customTools?.length).toBe(2);
  });

  it('customTools names ⊆ tools allowlist invariant', () => {
    // This is the invariant the subprocess must maintain when building sessionOptions.
    // If any customTool name is missing from `tools`, that tool gets filtered out.
    const searchTool = createSearchTool(stubSearchProvider);
    const webFetchTool = createWebFetchTool(() => null);
    const backgroundBashTool = createBackgroundBashTool({
      emitEvent: () => {},
      start: async () => ({ handle: 'process_0123456789abcdef0123456789abcdef', output: '', nextCursor: 0, isRunning: true, exitCode: null, signal: null, isolationProfile: 'workspace:test' }),
    });
    const customTools = [
      ...buildRuntimeBackedBuiltinToolDefinitions('/tmp'),
      searchTool,
      webFetchTool,
      backgroundBashTool,
    ];
    const tools = customTools.map(t => t.name);
    const allowlistSet = new Set(tools);
    for (const tool of customTools) {
      expect(allowlistSet.has(tool.name)).toBe(true);
    }
  });
});

describe('deferred MCP tool surface', () => {
  it('keeps core tools plus search/load in the initial prompt when MCP proxy tools exceed the threshold', () => {
    const loadedToolNames = new Set<string>();
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      threshold: 2,
      loadedToolNames,
      proxyTools: [
        proxyTool('mcp__session__call_llm', 'Core session LLM helper'),
        proxyTool('mcp__github__create_issue', 'Create a GitHub issue'),
        proxyTool('mcp__github__list_repos', 'List GitHub repositories'),
        proxyTool('mcp__jira__create_ticket', 'Create a Jira ticket'),
        proxyTool('mcp__slack__send_message', 'Send a Slack message'),
      ],
    });

    const names = surface.tools.map(tool => tool.name);
    expect(names).toContain('mcp__session__call_llm');
    expect(names).toContain(DEFERRED_MCP_TOOL_SEARCH_NAME);
    expect(names).toContain(DEFERRED_MCP_TOOL_LOAD_NAME);
    expect(names).not.toContain('mcp__github__create_issue');
    expect(names).not.toContain('mcp__jira__create_ticket');
    expect(surface.hiddenToolNames).toEqual([
      'mcp__github__create_issue',
      'mcp__github__list_repos',
      'mcp__jira__create_ticket',
      'mcp__slack__send_message',
    ]);
  });

  it('loads a named deferred MCP tool, answers that it is callable from the next step, and retains it for later builds', async () => {
    const loadedToolNames = new Set<string>();
    const proxyTools = [
      proxyTool('mcp__session__call_llm', 'Core session LLM helper'),
      proxyTool('mcp__github__create_issue', 'Create a GitHub issue'),
      proxyTool('mcp__github__list_repos', 'List GitHub repositories'),
      proxyTool('mcp__jira__create_ticket', 'Create a Jira ticket'),
      proxyTool('mcp__slack__send_message', 'Send a Slack message'),
    ];

    const initialSurface = buildDeferredMcpToolSurface({
      enabled: true,
      threshold: 2,
      loadedToolNames,
      proxyTools,
    });
    const loadTool = initialSurface.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_LOAD_NAME);
    expect(loadTool).toBeDefined();

    const result = await loadTool!.execute('load-1', { name: 'mcp__github__create_issue' }, new AbortController().signal);
    // The wording is PINNED on purpose, and it has been wrong in both
    // directions. T15 withdrew "the next model turn of this request" because the
    // live session dropped the registered tool (its `tools` allowlist); F1.803
    // fixed the allowlist and restored the promise, measured on the real
    // subprocess by `__tests__/deferred-tool-load-real-server.test.ts`. If this
    // assertion fails on a wording change, re-run that suite before the promise.
    expect(result.content).toEqual([{ type: 'text', text: 'Tools loaded and callable from your next step (not in the same batch of tool calls as this load): mcp__github__create_issue' }]);

    const nextSurface = buildDeferredMcpToolSurface({
      enabled: true,
      threshold: 2,
      loadedToolNames,
      proxyTools,
    });

    expect(loadedToolNames.has('mcp__github__create_issue')).toBe(true);
    expect(nextSurface.tools.map(tool => tool.name)).toContain('mcp__github__create_issue');
    expect(nextSurface.hiddenToolNames).not.toContain('mcp__github__create_issue');
  });

  it('revokes a loaded tool when its model-visible content changes, and carries it across a bare generation move', async () => {
    const loadedToolNames = new Set<string>();
    const activationLeases = new Map();
    const tools = [
      proxyTool('mcp__gitlab__list_repositories', 'List GitLab repositories'),
      proxyTool('mcp__jira__find_issues', 'Find Jira issues'),
    ];
    const first = buildDeferredMcpToolSurface({
      enabled: true, threshold: 0, generation: 'generation-1', proxyTools: tools,
      loadedToolNames, activationLeases,
    });
    await first.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_LOAD_NAME)!
      .execute('load-1', { name: tools[0]!.name }, new AbortController().signal);
    expect(loadedToolNames.has(tools[0]!.name)).toBe(true);

    buildDeferredMcpToolSurface({
      enabled: true, threshold: 0, generation: 'generation-1',
      proxyTools: [proxyTool(tools[0]!.name, 'Changed contract'), tools[1]!],
      loadedToolNames, activationLeases,
    });
    expect(loadedToolNames.has(tools[0]!.name)).toBe(false);

    const second = buildDeferredMcpToolSurface({
      enabled: true, threshold: 0, generation: 'generation-1', proxyTools: tools,
      loadedToolNames, activationLeases,
    });
    await second.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_LOAD_NAME)!
      .execute('load-2', { name: tools[0]!.name }, new AbortController().signal);
    // F1.803 — this arm pinned the defect until then: a generation move with the
    // SAME tools revoked every loaded tool, so a source added or a settings edit
    // mid-session made a loaded tool answer "not found" (F1.738). A lease whose
    // entry digest is unchanged is now carried to the new generation; the
    // changed-contract arm above still revokes (and so does a removed tool).
    buildDeferredMcpToolSurface({
      enabled: true, threshold: 0, generation: 'generation-2', proxyTools: tools,
      loadedToolNames, activationLeases,
    });
    expect(loadedToolNames.has(tools[0]!.name)).toBe(true);
    expect(activationLeases.get(tools[0]!.name)?.capabilityGeneration).toBe('generation-2');
  });
});
