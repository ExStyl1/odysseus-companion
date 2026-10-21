import { describe, expect, it } from 'bun:test';

import { PromptBuilder } from '../../shared/src/agent/core/prompt-builder.ts';
import { materializePiContextResources } from '../../shared/src/agent/pi-harness/context-resource.ts';
import { estimateTokens } from '../../shared/src/utils/large-response.ts';
import { buildContextUsageSnapshot } from './context-usage.ts';
import { buildPiRuntimeAgentDefinitions } from './orchestrator/runtime-agent-definitions.ts';

const AGENTS_MD_CONTENT = '# Project guide\n\nAlways run bun test from the repo root.\n';
const MEMORY_MD_CONTENT = '# Memory Index\n\n- prefer the Pi path for new vendors\n';

async function composeSessionParts() {
  // The system prompt exactly as production sends it: base prompt plus the
  // PromptBuilder's stable parts (including the model-facing skill listing),
  // joined the way chatImpl composes `fullSystemPrompt`.
  const promptBuilder = new PromptBuilder({
    workspace: {
      id: 'ws-context',
      name: 'Context Workspace',
      rootPath: '/tmp/nessy-context-usage-test',
      workspaceRootPath: '/tmp/nessy-context-usage-test',
      sessionRootPath: '/tmp/nessy-context-usage-test-sessions',
    } as never,
  });
  promptBuilder.setCapabilityRuntimeActive(true);
  promptBuilder.setRuntimeSkills([
    {
      key: 'ws:review',
      logicalName: 'review',
      description: 'Review a diff for correctness.',
      selectedAsUnqualifiedAlias: true,
      resource: { kind: 'native', path: '/tmp/skills/review/SKILL.md', contentHash: 'c'.repeat(64) } as never,
    },
  ]);
  const systemPrompt = ['You are the Nessy assistant.', ...promptBuilder.buildStableContextParts()].join('\n\n');

  // Subagent definitions through the production builder.
  const agentDefinitions = buildPiRuntimeAgentDefinitions([{
    schemaVersion: 2 as const,
    key: 'plugin://honey#agent.hive-scout@workspace',
    name: 'hive-scout',
    description: 'Honey scout',
    selectedAsUnqualifiedAlias: true,
    systemPrompt: 'Inspect concisely.',
    sha256: 'a'.repeat(64),
    provenance: 'plugin://honey#agent.hive-scout@workspace@generation-1',
    capabilityGeneration: 'generation-1',
    definitionDigest: 'b'.repeat(64),
  }], ['read', 'grep'], undefined, { sessionDepth: 0, maxDepth: 3 });

  // Instruction/memory layers through the production materializer.
  const contents = new Map<string, string>([
    ['AGENTS.md', AGENTS_MD_CONTENT],
    ['MEMORY.md', MEMORY_MD_CONTENT],
  ]);
  const contextResources = await materializePiContextResources({
    view: {
      generation: 'generation-1',
      promptLayers: [{ key: 'project:AGENTS.md', resource: { kind: 'native', path: 'AGENTS.md', contentHash: 'd'.repeat(64) } }],
      memory: [{ key: 'auto-memory:MEMORY.md', resource: { kind: 'native', path: 'MEMORY.md', contentHash: 'e'.repeat(64) } }],
    } as never,
    materializer: {
      async readText(resource: { path: string }) {
        return contents.get(resource.path) ?? '';
      },
    } as never,
    mcpResources: [],
  });

  // The three kinds the production surface actually advertises: a builtin, an
  // internal session tool in MCP spelling (`mcp__session__*` — the shape ALL
  // ~50 of Nessy's own tools take, per session-tool-defs.ts), and a genuine
  // MCP-server tool. The old fixture had no `mcp__session__*` entry, which is
  // exactly why 4/4 green proved nothing about the split.
  const toolDefinitions = [
    {
      name: 'read',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
    },
    {
      name: 'mcp__session__SubmitPlan',
      description: 'Submit a plan for user approval.',
      parameters: { type: 'object', properties: { plan: { type: 'string' } } },
    },
    {
      name: 'mcp__gitlab__repos',
      description: 'List GitLab repositories.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ];

  const messages = [
    { role: 'user', content: 'Audit the release readiness of this repo.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Starting the audit now.' }] },
  ];

  return { systemPrompt, agentDefinitions, contextResources, toolDefinitions, messages };
}

function sessionStub(totalTokens: number) {
  return {
    getContextUsage: () => ({ tokens: totalTokens, contextWindow: 200_000 }),
    model: { id: 'test-model', contextWindow: 200_000 },
  } as never;
}

describe('buildContextUsageSnapshot category breakdown', () => {
  it('measures the seven documented categories from the production-composed parts', async () => {
    const parts = await composeSessionParts();
    const snapshot = buildContextUsageSnapshot(sessionStub(50_000), undefined, parts);

    expect(snapshot.inputTokens).toBe(50_000);
    const categories = snapshot.categories ?? [];
    // debug-your-config.md: "broken down by category: system prompt, system
    // tools, MCP tools, custom subagents with the source each loaded from,
    // memory files, skills, and conversation messages." Seven, exactly.
    expect(categories.map(category => category.id)).toEqual([
      'system_prompt',
      'system_tools',
      'mcp_tools',
      'custom_subagents',
      'memory_files',
      'skills',
      'conversation_messages',
    ]);
    for (const category of categories) {
      // `custom_subagents` is the exception, and it is the point of C4: agent
      // definitions cost nothing on the Pi wire, so the row reports 0. Measured
      // (C1): seven agents seeded with unique markers in description and body,
      // 0 of 7 of each anywhere in the request. A row that reported a positive
      // number here was telling the user where their window went and naming a
      // place it does not go.
      if (category.id === 'custom_subagents') {
        expect(category.tokens, category.id).toBe(0);
        continue;
      }
      expect(category.tokens, category.id).toBeGreaterThan(0);
    }

    // MEASURED === SENT: the breakdown measures the exact production strings,
    // never a re-composed copy. The skill listing is the tagged block inside
    // the sent system prompt; the system prompt row is the remainder.
    const skillsBlock = /<available_skills>[\s\S]*?<\/available_skills>/.exec(parts.systemPrompt)?.[0];
    expect(skillsBlock).toBeTruthy();
    const skills = categories.find(category => category.id === 'skills')!;
    expect(skills.tokens).toBe(estimateTokens(skillsBlock!));
    const systemPromptRow = categories.find(category => category.id === 'system_prompt')!;
    expect(systemPromptRow.tokens).toBe(estimateTokens(parts.systemPrompt.replace(skillsBlock!, '')));

    // The identity the overlay reports: categories + unattributed == total.
    const sum = categories.reduce((total, category) => total + category.tokens, 0);
    expect(sum + (snapshot.unattributedTokens ?? 0)).toBe(snapshot.inputTokens!);
  });

  it('files internal session tools under system tools, never under MCP tools', async () => {
    // context-window.md's "MCP tools" row is the MCP SERVERS' tool listing
    // ("MCP tool names listed so Claude knows what is available", deferred via
    // tool search). Nessy's internal session tools are advertised in MCP
    // spelling (`mcp__session__*`) for the Pi SDK's benefit, but no user MCP
    // server supplies them — they are system tools. With the bare-prefix split
    // this session measured ~12K tokens of "MCP tools" with zero servers
    // connected.
    const parts = await composeSessionParts();
    const snapshot = buildContextUsageSnapshot(sessionStub(50_000), undefined, parts);
    const toolText = (tool: { name: string; description?: string; parameters?: unknown }) =>
      [tool.name, tool.description ?? '', JSON.stringify(tool.parameters)].filter(Boolean).join('\n');
    const [builtin, sessionTool, mcpServerTool] = parts.toolDefinitions;
    expect(sessionTool!.name.startsWith('mcp__session__')).toBe(true);

    const systemTools = snapshot.categories?.find(category => category.id === 'system_tools');
    const mcpTools = snapshot.categories?.find(category => category.id === 'mcp_tools');
    // Token-exact, so each of the three kinds is pinned to one column: the
    // builtin and the session tool are the system row, the server tool alone
    // is the MCP row.
    expect(systemTools?.tokens).toBe(
      estimateTokens(toolText(builtin!)) + estimateTokens(toolText(sessionTool!)),
    );
    expect(mcpTools?.tokens).toBe(estimateTokens(toolText(mcpServerTool!)));
  });

  it('names each subagent row with the source it loaded from', async () => {
    const parts = await composeSessionParts();
    const snapshot = buildContextUsageSnapshot(sessionStub(50_000), undefined, parts);

    const subagents = snapshot.categories?.find(category => category.id === 'custom_subagents');
    expect(subagents?.items).toEqual([
      {
        name: 'hive-scout',
        tokens: expect.any(Number),
        source: 'plugin://honey#agent.hive-scout@workspace@generation-1',
      },
    ]);
  });

  it('lists the instruction and memory files the session actually loaded, with per-file estimates', async () => {
    const parts = await composeSessionParts();
    const snapshot = buildContextUsageSnapshot(sessionStub(50_000), undefined, parts);

    expect(snapshot.loadedFiles).toEqual([
      // R55 composes every memory layer's delivered body through
      // `composeMemoryLayerBodies`, which trims — so the shipped body is the
      // trimmed one and that is what `/context` must report. Counting the raw
      // file here made this expectation disagree with the block the model sees.
      // R77 routed INSTRUCTION layers through the same composer (an instruction
      // file's `@path` import can name a sibling only that pass can see), so the
      // same trim now applies to them: `AGENTS.md`'s trailing newline is one
      // token this readout used to count and the model never received.
      { name: 'project:AGENTS.md', kind: 'instruction', tokens: estimateTokens(AGENTS_MD_CONTENT.trim()) },
      { name: 'auto-memory:MEMORY.md', kind: 'memory', tokens: estimateTokens(MEMORY_MD_CONTENT.trim()) },
    ]);
    const memoryFiles = snapshot.categories?.find(category => category.id === 'memory_files');
    expect(memoryFiles?.tokens).toBe(
      estimateTokens(AGENTS_MD_CONTENT.trim()) + estimateTokens(MEMORY_MD_CONTENT.trim()),
    );
  });

  it('renders a totals-only snapshot when no category inputs are provided (legacy shape)', () => {
    const snapshot = buildContextUsageSnapshot(sessionStub(50_000));
    expect(snapshot.categories).toBeUndefined();
    expect(snapshot.loadedFiles).toBeUndefined();
    expect(snapshot.unattributedTokens).toBeUndefined();
    expect(snapshot.inputTokens).toBe(50_000);
  });
});
