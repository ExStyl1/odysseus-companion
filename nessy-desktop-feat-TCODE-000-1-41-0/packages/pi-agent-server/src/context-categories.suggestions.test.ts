/**
 * S2 — `/context` carries optimization suggestions.
 *
 * `context-window.md:1616` whole: "The visualization uses representative
 * numbers. To see your actual context usage at any point, run `/context` for a
 * live breakdown by category with optimization suggestions, including which
 * CLAUDE.md and auto memory files loaded. Run `/memory` to open and edit those
 * files."
 *
 * We shipped the breakdown, the loaded-file list and the over-limit warnings and
 * had no suggestion producer anywhere. These are its rules, each pinned to the
 * row it names — the suggestion's `tokens` is READ FROM the finished category
 * array, so it can never disagree with the row above it in the overlay.
 *
 * The MCP rule runs after the R11 split (internal session tools are system
 * tools, not MCP tools), which is what keeps it from advising a user with zero
 * MCP servers to remove one.
 */

import { describe, expect, it } from 'bun:test';

import { estimateTokens } from '../../shared/src/utils/large-response.ts';
import {
  buildContextCategoryBreakdown,
  buildContextCategorySuggestions,
  type ContextCategoryInputs,
  type ContextCategoryToolDefinition,
} from './context-categories.ts';
import type { ContextUsageCategory } from '../../shared/src/protocol/dto.ts';
import { buildContextUsageSnapshot } from './context-usage.ts';

/** A tool definition big enough to be worth advising about, at `index`. */
function mcpServerTool(index: number): ContextCategoryToolDefinition {
  return {
    name: `mcp__gitlab__operation_${index}`,
    description: `Operation ${index} against the GitLab API. `.repeat(20),
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search expression. '.repeat(10) } },
    },
  };
}

const SMALL_INPUTS: ContextCategoryInputs = {
  systemPrompt: 'You are the Nessy assistant.',
  toolDefinitions: [
    { name: 'read', description: 'Read a file from disk.' },
    { name: 'mcp__session__SubmitPlan', description: 'Submit a plan for user approval.' },
    { name: 'mcp__gitlab__repos', description: 'List GitLab repositories.' },
  ],
  contextResources: [
    { id: 'cap-1', kind: 'prompt', content: '# Project guide\n', provenance: 'project:AGENTS.md@gen-1' },
  ],
  messages: [{ role: 'user', content: 'hello' }],
};

function category(id: ContextUsageCategory['id'], tokens: number): ContextUsageCategory {
  return { id, tokens };
}

describe('optimization suggestions', () => {
  it('advises deferring MCP tools when the MCP surface dominates the configuration', () => {
    const toolDefinitions = Array.from({ length: 40 }, (_, index) => mcpServerTool(index));
    const breakdown = buildContextCategoryBreakdown({ ...SMALL_INPUTS, toolDefinitions });

    const mcpRow = breakdown.categories.find(row => row.id === 'mcp_tools')!;
    expect(breakdown.suggestions).toEqual([
      { id: 'defer_mcp_tools', category: 'mcp_tools', tokens: mcpRow.tokens, count: 40 },
    ]);
    // The number in the suggestion IS the number in the row it names.
    expect(breakdown.suggestions[0]!.tokens).toBe(mcpRow.tokens);
  });

  it('yields nothing for a small composition', () => {
    expect(buildContextCategoryBreakdown(SMALL_INPUTS).suggestions).toEqual([]);
  });

  it('leaves the category rows and the loaded-file list byte-identical', () => {
    const toolDefinitions = Array.from({ length: 40 }, (_, index) => mcpServerTool(index));
    const withSuggestions = buildContextCategoryBreakdown({ ...SMALL_INPUTS, toolDefinitions });

    // Recomputed from the same inputs the rows were built from: measuring for
    // advice must never change what was measured for display.
    expect(withSuggestions.categories.find(row => row.id === 'mcp_tools')!.tokens).toBe(
      toolDefinitions.reduce(
        (total, tool) => total + estimateTokens([tool.name, tool.description ?? '', JSON.stringify(tool.parameters)].join('\n')),
        0,
      ),
    );
    expect(withSuggestions.loadedFiles).toEqual([
      { name: 'project:AGENTS.md', kind: 'memory', tokens: estimateTokens('# Project guide\n') },
    ]);
  });

  it('advises on memory files and on the skill listing, each naming its own row', () => {
    const bulk = 'Repository conventions worth remembering. '.repeat(400);
    const skills = `<available_skills>\n${Array.from(
      { length: 60 },
      (_, index) => `- [skill:helper-${index}] — ${'Does a thing for the repository. '.repeat(12)}`,
    ).join('\n')}\n</available_skills>`;
    const breakdown = buildContextCategoryBreakdown({
      systemPrompt: `You are the Nessy assistant.\n${skills}`,
      contextResources: [
        { id: 'cap-1', kind: 'prompt', content: bulk, provenance: 'project:AGENTS.md@gen-1' },
        { id: 'cap-2', kind: 'context', content: bulk, provenance: 'auto-memory:MEMORY.md@gen-1' },
      ],
    });

    const rows = new Map(breakdown.categories.map(row => [row.id, row.tokens]));
    expect(breakdown.suggestions).toEqual([
      { id: 'trim_memory_files', category: 'memory_files', tokens: rows.get('memory_files')!, count: 2 },
      { id: 'gate_skill_listing', category: 'skills', tokens: rows.get('skills')!, count: 60 },
    ]);
  });

  it('never advises about a category with nothing behind it', () => {
    // A large `mcp_tools` figure with zero MCP-server tools cannot happen after
    // the R11 split; the guard is here so it can never come back.
    expect(buildContextCategorySuggestions(
      [category('mcp_tools', 50_000), category('conversation_messages', 500_000)],
      { mcpToolCount: 0, loadedFileCount: 0, skillCount: 0 },
    )).toEqual([]);
  });

  it('does not let a long conversation silence a configuration suggestion', () => {
    // The share denominator excludes `conversation_messages` on purpose: the
    // configuration is what the user can change, and it is worth trimming most
    // in exactly the sessions where the history is largest.
    const categories = [category('mcp_tools', 30_000), category('conversation_messages', 900_000)];
    expect(buildContextCategorySuggestions(categories, {
      mcpToolCount: 40, loadedFileCount: 0, skillCount: 0,
    })).toEqual([{ id: 'defer_mcp_tools', category: 'mcp_tools', tokens: 30_000, count: 40 }]);
  });

  it('reaches the wire snapshot, and stays absent when there is nothing to say', () => {
    const session = {
      getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000 }),
      model: { id: 'test-model', contextWindow: 200_000 },
    } as never;
    const toolDefinitions = Array.from({ length: 40 }, (_, index) => mcpServerTool(index));

    expect(buildContextUsageSnapshot(session, undefined, { ...SMALL_INPUTS, toolDefinitions })
      .suggestions?.map(suggestion => suggestion.id)).toEqual(['defer_mcp_tools']);
    expect(buildContextUsageSnapshot(session, undefined, SMALL_INPUTS).suggestions).toBeUndefined();
    expect(buildContextUsageSnapshot(session).suggestions).toBeUndefined();
  });
});
