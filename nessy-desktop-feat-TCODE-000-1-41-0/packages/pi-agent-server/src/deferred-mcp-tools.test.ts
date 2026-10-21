import { describe, expect, it } from 'bun:test';
import {
  DEFERRED_MCP_TOOL_LOAD_NAME,
  DEFERRED_MCP_TOOL_SEARCH_NAME,
  buildDeferredMcpToolSurface,
} from './deferred-mcp-tools.ts';

const proxyTool = (name: string, description = name) => ({
  name,
  label: name,
  description,
  parameters: { type: 'object', properties: {} },
  async execute() {
    return { content: [{ type: 'text' as const, text: name }], details: {} };
  },
});

describe('deferred MCP surface enablement', () => {
  it('builds the discovery tools whenever the manifest enabled deferral, even below the count threshold', () => {
    // The uncached-source case: the manifest turned deferral on precisely BECAUSE
    // the server has no descriptors, so the candidate count here is low. Omitting
    // the discovery tools makes the subprocess disagree with the manifest, and
    // tool-manifest.ts then throws
    // "Pi execution manifest definition mismatch for mcp__tool_load: missing binding".
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      proxyTools: [proxyTool('mcp__xcodebuildmcp__build')] as never,
      loadedToolNames: new Set(),
    });

    expect(surface.enabled).toBe(true);
    expect(surface.tools.map(tool => tool.name)).toContain(DEFERRED_MCP_TOOL_LOAD_NAME);
    expect(surface.tools.map(tool => tool.name)).toContain(DEFERRED_MCP_TOOL_SEARCH_NAME);
    expect(surface.hiddenToolNames).toContain('mcp__xcodebuildmcp__build');
  });

  it('stays off when the manifest did not enable deferral', () => {
    const surface = buildDeferredMcpToolSurface({
      enabled: false,
      proxyTools: [proxyTool('mcp__xcodebuildmcp__build')] as never,
      loadedToolNames: new Set(),
    });
    expect(surface.enabled).toBe(false);
    expect(surface.tools.map(tool => tool.name)).toEqual(['mcp__xcodebuildmcp__build']);
  });

  it('keeps a manifest-pinned tool registered and out of the hidden set', () => {
    // P2's contract: the MANIFEST decides. `candidatePiNames` is the manifest's
    // own list of deferrable tools, so a candidate the manifest omitted is pinned
    // — the surface reads that decision instead of re-deriving `alwaysLoad`.
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      candidatePiNames: ['mcp__a__deferrable'],
      proxyTools: [proxyTool('mcp__a__pinned'), proxyTool('mcp__a__deferrable')] as never,
      loadedToolNames: new Set(),
    });

    expect(surface.enabled).toBe(true);
    expect(surface.tools.map(tool => tool.name)).toContain('mcp__a__pinned');
    expect(surface.hiddenToolNames).toEqual(['mcp__a__deferrable']);
    // The discovery tools are still built — pinning one tool does not switch
    // deferral off for the rest.
    expect(surface.tools.map(tool => tool.name)).toContain(DEFERRED_MCP_TOOL_SEARCH_NAME);
  });

  it('defers every candidate when the manifest supplies no candidate list', () => {
    // Absent `candidatePiNames`, nothing is pinned. This is the pre-existing
    // behavior every other caller relies on.
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      proxyTools: [proxyTool('mcp__a__one'), proxyTool('mcp__a__two')] as never,
      loadedToolNames: new Set(),
    });
    expect(surface.hiddenToolNames.sort()).toEqual(['mcp__a__one', 'mcp__a__two']);
  });

  it('still honors an explicit threshold when a caller passes one', () => {
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      threshold: 5,
      proxyTools: [proxyTool('mcp__a__one')] as never,
      loadedToolNames: new Set(),
    });
    expect(surface.enabled).toBe(false);
  });
});

describe('reaching a deferred tool', () => {
  /**
   * S14's reachability requirement: a tool that disappears from context must
   * still be callable. The whole documented route, driven end to end —
   * `mcp__tool_search` finds the hidden tool by description, `mcp__tool_load`
   * activates it, and the next surface registers the REAL definition.
   */
  it('search finds a hidden tool, load activates it, and the next surface registers it', async () => {
    const loadedToolNames = new Set<string>();
    const activationLeases = new Map();
    const hidden = proxyTool('mcp__github__create_issue', 'Open a new issue on a repository.');
    const registered: string[] = [];
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      generation: 'generation-1',
      candidatePiNames: [hidden.name],
      proxyTools: [hidden] as never,
      loadedToolNames,
      activationLeases,
      onLoadToolNames: names => registered.push(...names),
    });

    // Hidden means hidden: the definition is not in the model's surface.
    expect(surface.tools.map(tool => tool.name)).not.toContain(hidden.name);
    expect(surface.hiddenToolNames).toEqual([hidden.name]);

    // Found by a word from the DESCRIPTION, not just by exact name — the search
    // is the only way the model can learn the name exists.
    const found = await surface.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_SEARCH_NAME)!
      .execute('search-1', { query: 'issue' }, new AbortController().signal, undefined, {} as never);
    const foundText = found.content.map(part => ('text' in part ? part.text : '')).join('');
    expect(foundText).toContain(hidden.name);
    expect(foundText).toContain('available');

    const loaded = await surface.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_LOAD_NAME)!
      .execute('load-1', { name: hidden.name }, new AbortController().signal, undefined, {} as never);
    expect(loaded.details).not.toMatchObject({ isError: true });
    // The subprocess registration callback fired with this exact name, which is
    // what `createDeferredMcpRegistrationController` turns into a live binding.
    expect(registered).toEqual([hidden.name]);

    // And the tool is now part of the surface, with its own definition rather
    // than a placeholder — reached, not merely announced.
    const next = buildDeferredMcpToolSurface({
      enabled: true,
      generation: 'generation-1',
      candidatePiNames: [hidden.name],
      proxyTools: [hidden] as never,
      loadedToolNames,
      activationLeases,
    });
    expect(next.tools.map(tool => tool.name)).toContain(hidden.name);
    expect(next.hiddenToolNames).toEqual([]);
    expect(next.tools.find(tool => tool.name === hidden.name)?.description)
      .toBe('Open a new issue on a repository.');
  });

  /**
   * The route has to be discoverable from inside the surface, because a deferred
   * tool that is not in `tools` is not reachable by calling its name: Pi's own
   * loop answers `Tool <name> not found` from
   * `pi-agent-core/dist/agent-loop.js:360-365`, and it returns there BEFORE
   * `beforeToolCall`, so no host-side hook can improve that message. Until a
   * name listing lands (see the register), these two strings are the only thing
   * standing between the model and a dead end.
   */
  it('names the load tool in the search tool\'s own guidance', () => {
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      candidatePiNames: ['mcp__a__deferrable'],
      proxyTools: [proxyTool('mcp__a__deferrable')] as never,
      loadedToolNames: new Set(),
    });
    const search = surface.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_SEARCH_NAME)!;
    expect(search.promptSnippet).toContain(DEFERRED_MCP_TOOL_LOAD_NAME);
    expect(search.promptSnippet).toContain(DEFERRED_MCP_TOOL_SEARCH_NAME);
  });
});

describe('deferred MCP refresh', () => {
  it('revokes a removed deferred candidate before the next tool surface can load it', async () => {
    const loadedToolNames = new Set<string>();
    const activationLeases = new Map();
    const removed = proxyTool('mcp__github__delete_issue');
    const retained = proxyTool('mcp__github__list_issues');
    const initial = buildDeferredMcpToolSurface({
      enabled: true,
      threshold: 0,
      generation: 'generation-1',
      proxyTools: [removed, retained] as never,
      loadedToolNames,
      activationLeases,
    });
    await initial.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_LOAD_NAME)!
      .execute('load-1', { name: removed.name }, new AbortController().signal, undefined, {} as never);
    expect(loadedToolNames.has(removed.name)).toBe(true);

    const next = buildDeferredMcpToolSurface({
      enabled: true,
      threshold: 0,
      generation: 'generation-1',
      proxyTools: [retained] as never,
      loadedToolNames,
      activationLeases,
    });
    expect(loadedToolNames.has(removed.name)).toBe(false);
    expect(next.tools.map(tool => tool.name)).not.toContain(removed.name);

    const result = await next.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_LOAD_NAME)!
      .execute('load-2', { name: removed.name }, new AbortController().signal, undefined, {} as never);
    expect(result).toMatchObject({ details: { isError: true } });
  });

  /**
   * F1.803 — a catalogue GENERATION move alone no longer revokes a loaded tool
   * (before, a source added or a settings edit revoked every loaded tool, MCP
   * included — F1.738). The lease is carried when the entry it names has the
   * SAME digest in the new catalogue, and still revoked when the tool itself
   * changed, so the model loads it again and reads the new contract.
   */
  it('carries a lease across a generation move on an unchanged digest, and revokes it when the tool changed', async () => {
    const loadedToolNames = new Set<string>();
    const activationLeases = new Map();
    const same = proxyTool('mcp__github__list_issues', 'List the issues of a repository.');
    const changed = proxyTool('mcp__github__create_issue', 'Open a new issue on a repository.');
    const candidatePiNames = [same.name, changed.name];
    const first = buildDeferredMcpToolSurface({
      enabled: true,
      generation: 'generation-1',
      candidatePiNames,
      proxyTools: [same, changed] as never,
      loadedToolNames,
      activationLeases,
    });
    await first.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_LOAD_NAME)!
      .execute('load-1', { names: candidatePiNames }, new AbortController().signal, undefined, {} as never);
    expect([...loadedToolNames].sort()).toEqual([...candidatePiNames].sort());

    const next = buildDeferredMcpToolSurface({
      enabled: true,
      generation: 'generation-2',
      candidatePiNames,
      proxyTools: [same, proxyTool(changed.name, 'Open a new issue, now with labels.')] as never,
      loadedToolNames,
      activationLeases,
    });
    expect(loadedToolNames.has(same.name)).toBe(true);
    expect(activationLeases.get(same.name)?.capabilityGeneration).toBe('generation-2');
    expect(next.tools.map(tool => tool.name)).toContain(same.name);
    // BOUNDARY — the tool whose contract changed is revoked and hidden again.
    expect(loadedToolNames.has(changed.name)).toBe(false);
    expect(activationLeases.has(changed.name)).toBe(false);
    expect(next.hiddenToolNames).toContain(changed.name);
  });
});

describe('C7 deferrable built-ins on the shared surface', () => {
  // A definition is named by its bindingName; the manifest's candidates, the
  // capability catalogue and every name the model can type are piNames. They
  // agree for every MCP proxy tool, which is why nothing had to say so before
  // C7 put built-ins on this path — and why a mismatch here is silent.
  const PI_NAME_BY_DEFINITION = new Map([
    ['NotebookEdit', 'notebook_edit'],
    ['stopTask', 'stop_task'],
    ['web_search', 'web_search'],
    ['workflow', 'workflow'],
  ]);
  const semanticIdForDefinition = (name: string) => PI_NAME_BY_DEFINITION.get(name) ?? name;
  /**
   * Built-ins bring their catalogue entry from the CALLER, not from
   * `catalogInput` — which derives an `mcp:` source by splitting the name on
   * `__` and would describe a built-in as a server tool. In production these
   * come from `manifest.tools` filtered to `piBuiltin`, keyed by piName.
   *
   * Supplying them is not test scaffolding: a candidate with no catalogue entry
   * is dropped from `loadedToolNames` by the lease revalidation, so it would be
   * hidden AND unloadable. That failure is what this fixture proves cannot
   * happen on the production path, where every one of the eight qualifies.
   */
  const builtinCatalogEntries = [...PI_NAME_BY_DEFINITION.values()].map(semanticId => ({
    semanticId,
    displayName: semanticId,
    modelName: semanticId,
    kind: 'builtin' as const,
    description: `The ${semanticId} tool.`,
    inputSummary: 'No arguments.',
    effect: 'read' as const,
    risk: 'low' as const,
    source: `pi:${semanticId}`,
  }));

  it('defers a built-in whose piName differs from its definition name', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Matching `candidatePiNames` against a
    // definition's own name defers `web_search` and `workflow` and misses
    // `NotebookEdit` and `stopTask` — seven of nine, no error, every other test
    // green. The two included below are exactly the two that diverge, so a
    // revert to same-space matching turns this red rather than shrinking a count
    // nobody reads.
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      proxyTools: [...PI_NAME_BY_DEFINITION.keys()].map(name => proxyTool(name)) as never,
      candidatePiNames: [...PI_NAME_BY_DEFINITION.values()],
      semanticIdForDefinition,
      loadedToolNames: new Set(),
    });

    expect(surface.enabled).toBe(true);
    // Hidden names are DEFINITION names, because that is what the caller
    // subtracts from its own arrays and what the registration controller keys.
    expect(surface.hiddenToolNames.sort()).toEqual(['NotebookEdit', 'stopTask', 'web_search', 'workflow']);
    // None of the four is left advertised upfront.
    for (const name of PI_NAME_BY_DEFINITION.keys()) {
      expect(surface.tools.map(tool => tool.name)).not.toContain(name);
    }
    expect(surface.tools.map(tool => tool.name)).toContain(DEFERRED_MCP_TOOL_SEARCH_NAME);
  });

  it('reads a loaded built-in back through its piName, not its definition name', () => {
    // `loadedToolNames` is filled from catalogue leases, so it holds piNames.
    // Checking it with a definition name would leave a tool the model just
    // loaded still hidden — loadable, and never arriving.
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      proxyTools: [...PI_NAME_BY_DEFINITION.keys()].map(name => proxyTool(name)) as never,
      candidatePiNames: [...PI_NAME_BY_DEFINITION.values()],
      semanticIdForDefinition,
      catalogEntries: builtinCatalogEntries,
      loadedToolNames: new Set(['notebook_edit']),
    });

    expect(surface.tools.map(tool => tool.name)).toContain('NotebookEdit');
    expect(surface.hiddenToolNames).not.toContain('NotebookEdit');
    // The negative control: its unloaded neighbour is still hidden, so this
    // cannot pass by nothing being deferred at all.
    expect(surface.hiddenToolNames).toContain('stopTask');
  });

  it('leaves a built-in the manifest did not list alone', () => {
    // The manifest is the narrowing authority. A core tool absent from
    // `candidatePiNames` — `bash` here — stays registered even though it rides
    // the same array.
    const surface = buildDeferredMcpToolSurface({
      enabled: true,
      proxyTools: [proxyTool('bash'), proxyTool('web_search')] as never,
      candidatePiNames: ['web_search'],
      semanticIdForDefinition,
      loadedToolNames: new Set(),
    });

    expect(surface.tools.map(tool => tool.name)).toContain('bash');
    expect(surface.hiddenToolNames).toEqual(['web_search']);
  });
});
