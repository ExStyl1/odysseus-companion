/**
 * F1.197 (origin WJ-l P-WJ-l-2) — Pi's tool search tells the model what is
 * deferred, and its two discovery tools stop describing the catalogue as
 * MCP-only.
 *
 * `agent-sdk/tool-search.md#how-tool-search-works`, verbatim: "The agent
 * receives a summary of available tools and searches for relevant ones when the
 * task requires a capability not already loaded." Before this row Pi sent no
 * summary, and `mcp__tool_search` read "Search deferred MCP source tools…" while
 * its catalogue also carried the on-demand built-ins and the session tools —
 * F1.147's live symptom (a gateway `pi` session reported `review` unavailable).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildDeferredMcpToolSurface,
  DEFERRED_MCP_TOOL_LOAD_NAME,
  DEFERRED_MCP_TOOL_SEARCH_NAME,
} from './deferred-mcp-tools.ts';
import {
  dropDeferredToolSummaryNames,
  renderDeferredToolSummary,
  setDeferredToolSummaryNames,
  withDeferredToolSummary,
} from './deferred-tool-summary.ts';

const tool = (name: string) => ({
  name,
  label: name,
  description: `${name} description`,
  parameters: { type: 'object', properties: {} },
  async execute() { return { content: [], details: {} }; },
});

describe('F1.197 · the deferred set reaches the model as a summary', () => {
  it('hidden built-ins and session tools are named, by the name the catalogue loads them under', () => {
    // The shape `index.ts` builds: MCP proxies, a deferrable built-in and a
    // session tool on ONE surface, the manifest naming the candidates.
    const proxies = [tool('mcp__linear__search_issues'), tool('review'), tool('mcp__session__cron_create')];
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      candidatePiNames: proxies.map(p => p.name),
      proxyTools: proxies as any,
      loadedToolNames: new Set(),
    });
    // Positive control on the same instrument: deferral really is on and hides
    // exactly these three, so the summary below cannot be vacuously empty.
    expect([...surface.hiddenToolNames].sort()).toEqual(proxies.map(p => p.name).sort());

    setDeferredToolSummaryNames(surface.hiddenToolNames);
    const prompt = withDeferredToolSummary('HOST SYSTEM PROMPT');
    expect(prompt.startsWith('HOST SYSTEM PROMPT\n\n<deferred-tools>')).toBe(true);
    expect(prompt).toContain('mcp__linear__search_issues, mcp__session__cron_create, review');
    expect(prompt).toContain('mcp__tool_search');
    expect(prompt).toContain('a loaded tool is callable from your next step in this same request.');
    expect(prompt).not.toContain('NEXT message');
  });

  it('CONTROL — with nothing deferred the host prompt passes through byte-identical', () => {
    setDeferredToolSummaryNames([]);
    expect(withDeferredToolSummary('HOST SYSTEM PROMPT')).toBe('HOST SYSTEM PROMPT');
    expect(renderDeferredToolSummary([])).toBe('');
  });

  it('the subprocess records the hidden set where it builds the surface and appends it where it applies the prompt', () => {
    // Source text, deliberately: both sites live inside `index.ts`'s session
    // build and prompt handler, which only a real Pi server exercises, and the
    // property is exactly "these two calls are made with these arguments".
    const source = readFileSync(resolve(import.meta.dir, 'index.ts'), 'utf8');
    expect(source).toContain('setDeferredToolSummaryNames(proxyToolSurface.hiddenToolNames.map(semanticIdForDefinition));');
    expect(source).toContain('applySystemPromptOverride(runtimeHandle, withDeferredToolSummary(msg.systemPrompt));');
    // …and the context accounting counts what the model is actually shown.
    expect(source).toContain('systemPrompt: withDeferredToolSummary(activeSystemPrompt)');
  });
});

describe('F1.838 · a load takes the tool off the summary inside the same request', () => {
  it('the loaded names leave the list and the rest stay, in order', () => {
    setDeferredToolSummaryNames(['review', 'mcp__linear__search_issues', 'web_search']);
    expect(dropDeferredToolSummaryNames(['web_search'])).toBe(true);
    const prompt = withDeferredToolSummary('HOST');
    expect(prompt).toContain('\nmcp__linear__search_issues, review\n</deferred-tools>');
    expect(prompt).not.toContain('web_search');
  });

  it('CONTROL — a name the list does not carry changes nothing, and loading the last one removes the block', () => {
    setDeferredToolSummaryNames(['review']);
    const before = withDeferredToolSummary('HOST');
    // An already-active or pinned tool: the caller must not re-apply the prompt.
    expect(dropDeferredToolSummaryNames(['mcp__stub__echo'])).toBe(false);
    expect(withDeferredToolSummary('HOST')).toBe(before);
    expect(dropDeferredToolSummaryNames(['review'])).toBe(true);
    expect(withDeferredToolSummary('HOST')).toBe('HOST');
  });

  it('the load callback drops the names and re-applies the host prompt to the live session', () => {
    // Source text, for the reason given in the F1.197 arm above; the behaviour
    // itself is driven end to end in `__tests__/deferred-tool-load-real-server.test.ts`.
    const source = readFileSync(resolve(import.meta.dir, 'index.ts'), 'utf8');
    expect(source).toContain('if (dropDeferredToolSummaryNames(names) && generationPublished && runtimeHandle && activeSystemPrompt) applySystemPromptOverride(runtimeHandle, withDeferredToolSummary(activeSystemPrompt));');
  });
});

describe('F1.197 · the discovery tools describe the catalogue they search', () => {
  const surface = buildDeferredMcpToolSurface({
    enabled: true,
    proxyTools: Array.from({ length: 60 }, (_, index) => tool(`mcp__fixture__tool_${index}`)) as any,
    loadedToolNames: new Set(),
  });
  const byName = new Map(surface.tools.map(definition => [definition.name, definition]));

  it('neither discovery tool calls the catalogue MCP-only any more', () => {
    const search = byName.get(DEFERRED_MCP_TOOL_SEARCH_NAME);
    const load = byName.get(DEFERRED_MCP_TOOL_LOAD_NAME);
    expect(search?.description).toContain('on-demand built-ins');
    expect(search?.description).toContain('session tools');
    for (const text of [search?.description, search?.promptSnippet, load?.description]) {
      expect(text).not.toContain('MCP source tools');
    }
    // The promise F1.147's skill clause relies on — same request since F1.803.
    expect(load?.description).toContain('A loaded tool is callable from your next step in this same request');
  });
});
