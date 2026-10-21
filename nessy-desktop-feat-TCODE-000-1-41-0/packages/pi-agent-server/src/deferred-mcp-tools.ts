import { Type } from '@sinclair/typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  activateCapabilityCatalogEntries,
  createCapabilityCatalogV1,
  revalidateCapabilityActivationLeases,
  searchCapabilityCatalogV1,
  type CapabilityActivationLeaseV1,
  type CapabilityCatalogEntryInputV1,
  type CapabilityCatalogV1,
} from '../../shared/src/agent/pi-harness/capability-catalog.ts';

export const DEFERRED_MCP_TOOL_SEARCH_NAME = 'mcp__tool_search';
export const DEFERRED_MCP_TOOL_LOAD_NAME = 'mcp__tool_load';
/** Reference value for callers that own their own deferral decision — no longer the tool surface's implicit default. */
export const DEFAULT_DEFERRED_MCP_TOOL_THRESHOLD = 48;
export const MAX_DEFERRED_CAPABILITY_SEARCH_OUTPUT = 32 * 1024;

const searchSchema = Type.Object({
  query: Type.Optional(Type.String({ description: 'Case-insensitive text to match against deferred tool names and descriptions.' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum results to return.', minimum: 1, maximum: 50 })),
});

const loadSchema = Type.Object({
  name: Type.Optional(Type.String({ description: 'Exact deferred tool name to load.' })),
  names: Type.Optional(Type.Array(Type.String(), { description: 'Exact deferred tool names to load.' })),
});

export interface DeferredMcpToolSurfaceOptions {
  enabled: boolean;
  threshold?: number;
  generation?: string;
  proxyTools: ToolDefinition<any, any>[];
  /**
   * `manifest.deferredMcp.candidatePiNames` — the manifest's OWN list of
   * deferrable tools. An MCP proxy tool absent from it is pinned (`alwaysLoad`)
   * and stays registered. Reading the manifest's decision is deliberate: P2's
   * contract is that the manifest decides and this surface must not re-derive
   * enablement. Omit to defer every candidate, which is the prior behavior.
   */
  candidatePiNames?: readonly string[];
  /**
   * A definition's name → the semantic id the MODEL sees for it.
   *
   * Two name spaces meet in this function and they are equal for every MCP
   * proxy tool, which is why nothing needed to say so until C7 put built-ins on
   * this path. A tool DEFINITION is keyed by `bindingName`
   * (`projectPiManifestTools` looks up `definitions.get(tool.binding.bindingName)`),
   * while `candidatePiNames`, the capability catalogue and therefore every name
   * the model can type into `mcp__tool_load` are `piName`s. Two of the eight
   * deferrable built-ins spell those differently — `NotebookEdit`/`notebook_edit`
   * and `stopTask`/`stop_task` — so matching one space against the other defers
   * six of eight and misses two SILENTLY, with every existing test green
   * because every existing test exercises MCP tools, where the two agree.
   *
   * Defaults to identity, which is exactly today's behaviour for MCP.
   */
  semanticIdForDefinition?: (definitionName: string) => string;
  loadedToolNames: Set<string>;
  activationLeases?: Map<string, CapabilityActivationLeaseV1>;
  catalogEntries?: readonly CapabilityCatalogEntryInputV1[];
  kindForSemanticId?: (semanticId: string) => 'plugin' | 'mcp' | 'app';
  onLoadToolNames?: (names: string[]) => void;
  onLoadLeases?: (leases: readonly CapabilityActivationLeaseV1[]) => void;
}

export interface DeferredMcpToolSurface {
  enabled: boolean;
  tools: ToolDefinition<any, any>[];
  hiddenToolNames: string[];
}

export function isDeferredMcpCandidate(toolName: string): boolean {
  return toolName.startsWith('mcp__') && !toolName.startsWith('mcp__session__');
}

function textResult(text: string, isError = false): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text }],
    details: isError ? { isError: true } : {},
  };
}

function createDeferredMcpSearchTool(
  catalog: CapabilityCatalogV1,
  loadedToolNames: Set<string>,
  activatableNames: ReadonlySet<string>,
): ToolDefinition<typeof searchSchema, { isError?: boolean }> {
  return {
    name: DEFERRED_MCP_TOOL_SEARCH_NAME,
    label: 'MCP Tool Search',
    description: 'Search the deferred tools — MCP server tools, on-demand built-ins such as review or web_fetch, and session tools — by exact name or description before loading one.',
    promptSnippet: 'Use mcp__tool_search to discover deferred tools (MCP server tools, on-demand built-ins, session tools) by name or description, then load exact names with mcp__tool_load.',
    parameters: searchSchema,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ isError?: boolean }>> {
      const query = (params.query ?? '').trim();
      const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 20)));
      const matches = searchCapabilityCatalogV1(catalog, query, limit);

      if (matches.length === 0) {
        return textResult(`No deferred MCP tools matched "${params.query ?? ''}".`);
      }

      const lines: string[] = [];
      let outputBytes = 0;
      for (const entry of matches) {
        const status = loadedToolNames.has(entry.semanticId) || !activatableNames.has(entry.semanticId) ? 'loaded' : 'available';
        const line = `- ${entry.semanticId} [${entry.kind}, ${status}, effect=${entry.effect}, risk=${entry.risk}, digest=${entry.digest}]: ${entry.description} Inputs: ${entry.inputSummary} Source: ${entry.source}`;
        const bytes = Buffer.byteLength(line, 'utf8') + 1;
        if (outputBytes + bytes > MAX_DEFERRED_CAPABILITY_SEARCH_OUTPUT) break;
        lines.push(line);
        outputBytes += bytes;
      }
      return textResult(`Nessy capability catalog (${catalog.generation}):\n${lines.join('\n')}`);
    },
  };
}

function normalizeLoadNames(params: { name?: string; names?: string[] }): string[] {
  const names = [
    ...(typeof params.name === 'string' ? [params.name] : []),
    ...(Array.isArray(params.names) ? params.names : []),
  ]
    .map(name => name.trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}

function createDeferredMcpLoadTool(
  catalog: CapabilityCatalogV1,
  loadedToolNames: Set<string>,
  activationLeases: Map<string, CapabilityActivationLeaseV1>,
  activatableNames: ReadonlySet<string>,
  onLoadToolNames?: (names: string[]) => void,
  onLoadLeases?: (leases: readonly CapabilityActivationLeaseV1[]) => void,
): ToolDefinition<typeof loadSchema, { isError?: boolean }> {
  return {
    name: DEFERRED_MCP_TOOL_LOAD_NAME,
    label: 'MCP Tool Load',
    // F1.803 (2026-09-25) — T15 made these three strings promise only "the
    // user's next message", because the live session DROPPED a registered tool:
    // its `tools` allowlist named only the tools advertised at construction,
    // and Pi's `_refreshToolRegistry` filters every registered tool through it.
    // The allowlist now names the hidden candidates too (`allowlistNames` in
    // extensions/deferred-mcp-extension.ts), so `onLoadToolNames` activates the
    // tool at once and Pi 0.85.1 re-reads the active set before the NEXT MODEL
    // CALL (`_installAgentNextTurnRefresh`) — no loop state is lost. The one
    // true limit is a call in the SAME batch as the load: it was dispatched
    // before the load ran. Measured on the real subprocess by
    // `__tests__/deferred-tool-load-real-server.test.ts`.
    description: 'Select one or more deferred tools by exact name. A loaded tool is callable from your next step in this same request and stays selected afterwards.',
    promptSnippet: 'Use mcp__tool_load with exact tool names returned by mcp__tool_search. A loaded tool is callable from your next step in this same request (not inside the same batch of tool calls as the load) and stays selected afterwards: load it, then call it.',
    parameters: loadSchema,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ isError?: boolean }>> {
      const requestedNames = normalizeLoadNames(params);
      if (requestedNames.length === 0) {
        return textResult('No MCP tool names were provided to load.', true);
      }

      const available = new Set(catalog.entries.map(entry => entry.semanticId));
      const unknown = requestedNames.filter(name => !available.has(name));
      if (unknown.length) return textResult(`Unknown or unavailable capabilities: ${unknown.join(', ')}`, true);
      const alreadyActive = requestedNames.filter(name => catalog.entries.some(entry => entry.semanticId === name) && !activatableNames.has(name));
      const requestedActivations = requestedNames.filter(name => activatableNames.has(name));
      if (alreadyActive.length && requestedActivations.length === 0) {
        return textResult(`Capabilities already active: ${alreadyActive.join(', ')}`);
      }
      let leases: readonly CapabilityActivationLeaseV1[];
      try {
        leases = activateCapabilityCatalogEntries(catalog, requestedActivations);
      } catch {
        return textResult(`Unknown or unavailable capabilities: ${requestedActivations.join(', ')}`, true);
      }
      const loaded = leases.map(lease => lease.semanticId);
      for (const lease of leases) {
        activationLeases.set(lease.semanticId, lease);
        loadedToolNames.add(lease.semanticId);
      }

      if (loaded.length > 0) {
        onLoadToolNames?.(loaded);
        onLoadLeases?.(leases);
      }

      return textResult(`Tools loaded and callable from your next step (not in the same batch of tool calls as this load): ${loaded.join(', ')}`, loaded.length === 0);
    },
  };
}

function inputSummary(tool: ToolDefinition<any, any>): string {
  const schema = tool.parameters as unknown as { properties?: Record<string, { type?: string }>; required?: string[] };
  const required = new Set(schema?.required ?? []);
  const fields = Object.entries(schema?.properties ?? {}).slice(0, 24).map(([name, value]) => (
    `${name}${required.has(name) ? '' : '?'}: ${value?.type ?? 'value'}`
  ));
  return fields.length ? fields.join(', ') : 'No arguments.';
}

function catalogInput(
  tool: ToolDefinition<any, any>,
  kind: 'plugin' | 'mcp' | 'app' = 'mcp',
): CapabilityCatalogEntryInputV1 {
  // F1.295 — the gate's own verb table (`mcp-tool-name-verbs.ts`), not a second regex:
  const readOnly = mcpToolNameReadsAsReadOnly(tool.name);
  const wireName = tool.name.split('__')[1] ?? 'unknown';
  return {
    semanticId: tool.name,
    displayName: tool.label || tool.name,
    modelName: tool.name,
    kind,
    description: tool.description?.trim() || tool.name,
    inputSummary: inputSummary(tool),
    effect: readOnly ? 'external-read' : 'external-write',
    risk: readOnly ? 'low' : 'high',
    source: `mcp:${wireName}`,
  };
}

export function buildDeferredMcpToolSurface(options: DeferredMcpToolSurfaceOptions): DeferredMcpToolSurface {
  const manifestCandidates = options.candidatePiNames ? new Set(options.candidatePiNames) : undefined;
  const semanticIdFor = options.semanticIdForDefinition ?? ((name: string) => name);
  // C7 widened this from "MCP tools the manifest also lists" to "whatever the
  // manifest lists", because the deferrable built-ins are not `mcp__`-prefixed
  // and the local predicate would have rejected all nine. The manifest is the signed
  // authority and already decides ENABLEMENT here; letting it decide CANDIDACY
  // too is the same contract, not a new one. `isDeferredMcpCandidate` stays as
  // the fallback for a caller that supplies no list — and it is still the thing
  // keeping `mcp__session__*` out on that path, which is C5's parked question.
  const candidates = options.proxyTools.filter(tool => (
    manifestCandidates
      ? manifestCandidates.has(semanticIdFor(tool.name))
      : isDeferredMcpCandidate(tool.name)
  ));

  // `options.enabled` IS the manifest's decision (`manifest.deferredMcp.enabled`),
  // already resolved against the mode, the preference and — where that arm still
  // applies — `PI_DEFERRED_MCP_TOOL_THRESHOLD`. Re-deriving
  // it here made the two sides disagree: the uncached-source case turns deferral on
  // BECAUSE the candidate count is low, so a local `> 48` check dropped the
  // discovery tools the manifest still listed, and `validateDefinitions` threw
  // `definition mismatch for mcp__tool_load: missing binding`. A caller that owns
  // its own decision passes an explicit threshold; absent one, the manifest rules.
  const threshold = options.threshold === undefined
    ? undefined
    : Math.max(0, Math.floor(options.threshold));

  if (!options.enabled || (threshold !== undefined && candidates.length <= threshold)) {
    return {
      enabled: false,
      tools: options.proxyTools,
      hiddenToolNames: [],
    };
  }

  // Definition names for the hiding side, semantic ids for the catalogue side.
  // Identical sets for MCP; different for two built-ins — see `semanticIdForDefinition`.
  const candidateNames = new Set(candidates.map(tool => tool.name));
  const activatableIds = new Set(candidates.map(tool => semanticIdFor(tool.name)));
  const bySemanticId = new Map<string, CapabilityCatalogEntryInputV1>();
  for (const entry of options.catalogEntries ?? []) bySemanticId.set(entry.semanticId, entry);
  // Synthesize an entry only for genuine MCP tools. `catalogInput` derives a
  // wire name and an `mcp:` source by splitting on `__`, which is meaningless
  // for a built-in and would overwrite the accurate manifest-derived entry the
  // caller already seeded — the built-in's real description, effect and risk.
  for (const tool of candidates) {
    if (!isDeferredMcpCandidate(tool.name)) continue;
    bySemanticId.set(semanticIdFor(tool.name), catalogInput(tool, options.kindForSemanticId?.(tool.name)));
  }
  const catalog = createCapabilityCatalogV1(options.generation ?? 'legacy', [...bySemanticId.values()]);
  const activationLeases = options.activationLeases ?? new Map<string, CapabilityActivationLeaseV1>();
  for (const loadedName of options.loadedToolNames) {
    if (activationLeases.has(loadedName)) continue;
    try {
      const [lease] = activateCapabilityCatalogEntries(catalog, [loadedName]);
      if (lease) activationLeases.set(loadedName, lease);
    } catch {
      options.loadedToolNames.delete(loadedName);
    }
  }
  // F1.803 — a lease survives a catalogue GENERATION move when the entry it
  // names is still here with the SAME digest. The digest covers everything the
  // model was shown for the tool (name, description, inputs, effect, risk,
  // source), so an unchanged digest is the same tool, and re-issuing the lease
  // against the new generation changes nothing the model relies on. A changed
  // digest (the tool itself changed) is still revoked below, and the model must
  // load it again and read its new contract. Before this, ANY move — a source
  // added, a settings edit — revoked every loaded tool, MCP included (F1.738).
  for (const [semanticId, lease] of activationLeases) {
    if (lease.capabilityGeneration === catalog.generation) continue;
    const entry = catalog.entries.find(candidate => candidate.semanticId === semanticId);
    if (!entry || entry.digest !== lease.digest) continue;
    const [carried] = activateCapabilityCatalogEntries(catalog, [semanticId]);
    if (carried) activationLeases.set(semanticId, carried);
  }
  const validated = revalidateCapabilityActivationLeases(catalog, [...activationLeases.values()]);
  activationLeases.clear();
  options.loadedToolNames.clear();
  for (const lease of validated.active) {
    activationLeases.set(lease.semanticId, lease);
    options.loadedToolNames.add(lease.semanticId);
  }

  // Everything the manifest did not list as deferrable stays registered: the
  // non-MCP tools as before, plus any MCP tool the manifest pinned.
  const coreTools = options.proxyTools.filter(tool => !candidateNames.has(tool.name));
  const loadedTools = candidates.filter(tool => options.loadedToolNames.has(semanticIdFor(tool.name)));
  const hiddenToolNames = candidates
    .filter(tool => !options.loadedToolNames.has(semanticIdFor(tool.name)))
    .map(tool => tool.name);

  return {
    enabled: true,
    tools: [
      ...coreTools,
      ...loadedTools,
      createDeferredMcpSearchTool(catalog, options.loadedToolNames, activatableIds),
      createDeferredMcpLoadTool(catalog, options.loadedToolNames, activationLeases, activatableIds, options.onLoadToolNames, options.onLoadLeases),
    ],
    hiddenToolNames,
  };
}

// F1.295 — imported here, at the end, so every line the docs cite by number keeps its
// place. The module has no imports of its own: the Pi subprocess loads it without the
// gate's module graph.
import { mcpToolNameReadsAsReadOnly } from '../../shared/src/agent/mcp-tool-name-verbs.ts';
