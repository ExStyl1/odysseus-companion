/**
 * P2.235 — the live manifest COMPOSITIONS, out of the test that owned them.
 *
 * `live-manifest-contract.test.ts` built the live subprocess tool set and the
 * four production manifest compositions inline, so anything else wanting the
 * same live surface had to rebuild it. `pi-harness-baseline.test.ts` does
 * exactly that: it imports the same factories and assembles its own copy, which
 * is two constructions of one thing and the drift that follows from it. This
 * module is the one construction; both files are meant to call it.
 *
 * WHY IT IS A MODULE AND NOT A WIDER TYPECHECK-TIME GATE, which is the shape
 * the row first proposed. The 72 live-derived pins in
 * `fixtures/tool-surface.json` can only be recomputed by importing the live Pi
 * tool graph, and that import was MEASURED at 336 145 ms
 * (`runtime-backed-tools.ts` 132 389 ms, `subagent-tool.ts` 105 473 ms, load
 * 17.5, 2026-09-03). `source-state-contract.ts`'s gate rides
 * `bun run typecheck` in this package — the affected-package check every lane
 * runs in its implementation loop — so widening it that way would put five and a
 * half minutes on every lane's inner loop. It is not widened; what CAN be
 * checked for all 78 without the graph (prefixes, cross-field agreement, handler
 * path and name) is, in `collectPinStructureFindings`.
 *
 * WHERE THE LIVE DIGEST HALF ALREADY RUNS, said plainly so this module is not
 * read as a gap: `pi-harness-baseline.test.ts` compares the WHOLE
 * `schemaContracts` object — all 78, whole strings — against contracts it
 * derives live, under root `bun test`, which is CI's `test` job. A second live
 * oracle over the same pins would be a duplicate oracle, not extra coverage.
 * What is missing is not a reader; it is that no lane runs root `bun test` in an
 * implementation loop, which is P2.255 and is a gate-shape question rather than
 * a coverage one.
 *
 * Nothing here is production code: it is the fixture side of two contract tests,
 * kept out of `__tests__` only so both packages' tests can import it by path.
 */
import type { EffectiveCapabilitySnapshot } from '../../../shared/src/capabilities/resolver.ts';
import type { AgentRuntimeView } from '../../../shared/src/capabilities/views.ts';
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  type PiDynamicToolDefinition,
  type PiExecutionManifestV2,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import { getToolDefsAsJsonSchema } from '../../../session-tools-core/src/tool-defs.ts';
import { buildRuntimeBackedBuiltinToolDefinitions } from '../local-tools/runtime-backed-tools.ts';
import { createAskUserTool } from '../orchestrator/ask-user-tool.ts';
import {
  createGetSubagentResultTool,
  createSteerSubagentTool,
  createStopTaskTool,
  createSubagentTool,
} from '../orchestrator/subagent-tool.ts';
import { createReviewTool } from '../orchestrator/review-tool.ts';
import { createWorkflowTool } from '../orchestrator/workflow-tool.ts';
import { createBackgroundBashTool } from '../tools/background-bash.ts';
import { createSearchTool } from '../tools/search/create-search-tool.ts';
import { createWebFetchTool } from '../tools/web-fetch.ts';
import { buildDeferredMcpToolSurface } from '../deferred-mcp-tools.ts';

export const LIVE_MANIFEST_VIEW: AgentRuntimeView = {
  generation: 'generation-live-manifest-contract',
  sources: [],
  skills: [],
  mcpServers: [],
  hooks: [],
  automations: [],
  agents: [],
  promptLayers: [],
  memory: [],
  permissionLayers: [],
  commands: [],
  promptCommands: [],
  apps: [],
};

export const LIVE_MANIFEST_SNAPSHOT = {
  context: {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    projectTrustState: 'none',
    projectTrustRevision: '',
  },
  generation: LIVE_MANIFEST_VIEW.generation,
  leaseId: 'lease-live-manifest-contract',
  entries: [],
  installedPlugins: [],
  diagnostics: [],
} as EffectiveCapabilitySnapshot;

export const LIVE_MANIFEST_SESSION_KEY = { workspaceId: 'workspace-1', sessionId: 'session-1' } as const;

/** The live subprocess static definitions, from the same factories buildSessionDefinition uses. */
export function liveStaticDefinitions(cwd: string, forkMode = false) {
  const provider = { name: 'fixture', search: async () => [] };
  const childResult = { agent: 'worker', status: 'done' as const, text: '', tokensIn: 0, tokensOut: 0 };
  const childPort = {
    start: async () => ({ agentId: 'child', status: 'completed' as const, output: '' }),
    resume: async () => ({ agentId: 'child', status: 'completed' as const, output: '' }),
    steer: async () => {},
    getResult: async () => ({ agentId: 'child', status: 'completed' as const, output: '' }),
    stop: async () => {},
    stopTask: async () => {},
    sealOwnerTask: async () => {},
    searchOutput: async () => [],
    attach: async () => ({ cursor: 0, output: '', status: 'completed' as const }),
    monitor: async () => ({ agentId: 'child', status: 'completed' as const, output: '' }),
  } as never;
  return [
    ...buildRuntimeBackedBuiltinToolDefinitions(cwd),
    createSearchTool(provider, provider),
    createWebFetchTool(() => null),
    createBackgroundBashTool({
      emitEvent: () => undefined,
      start: async () => ({
        handle: 'process_0123456789abcdef0123456789abcdef',
        output: '',
        nextCursor: 0,
        isRunning: true,
        exitCode: null,
        signal: null,
        isolationProfile: 'workspace:fixture',
        environmentProfile: 'restricted',
        environmentDigest: 'digest',
      }),
    }),
    createSubagentTool({ getCwd: () => cwd, spawn: async () => childResult, childSessionPort: childPort, isForkModeEnabled: () => forkMode }),
    createReviewTool({ getCwd: () => cwd, spawn: async () => ({ ...childResult, agent: 'reviewer' }), computeDiff: async () => '', childSessionPort: childPort } as never),
    createGetSubagentResultTool(childPort),
    createSteerSubagentTool(childPort),
    createStopTaskTool(childPort),
    createWorkflowTool({ getCwd: () => cwd, spawn: async () => childResult }),
    createAskUserTool({ askUser: async () => ({ type: 'option', optionIndex: 0, value: 'fixture' }) }),
  ];
}

/** The session tools exactly as the host registers them. */
export function liveSessionDynamicTools(generation: string): PiDynamicToolDefinition[] {
  return getToolDefsAsJsonSchema({
    prefix: 'mcp__session__',
    includeDeveloperFeedback: true,
    projection: 'pi',
  }).map(definition => ({
    bindingName: definition.name,
    description: definition.description ?? definition.name,
    inputSchema: definition.inputSchema as Record<string, unknown>,
    modelSchemaVersion: 1 as const,
    bindingSchemaVersion: 1 as const,
    provenance: { capabilityKey: 'runtime:pi-session', generation },
  }));
}

export interface LiveComposition {
  readonly label: string;
  readonly manifest: PiExecutionManifestV2;
  readonly definitions: ReturnType<typeof liveStaticDefinitions>;
}

/**
 * The four live compositions a pinned static hash must survive.
 *
 * Each one is a shape the app really builds, and the reason it is here rather
 * than inline in one test is that a composition the loop does not carry is a pin
 * compared against nothing — which is how `mcp__tool_search` and `mcp__tool_load`
 * went unchecked until the fourth was added.
 */
export function buildLiveCompositions(repoRoot: string): LiveComposition[] {
  const seed = createPiExecutionManifestSeed({
    snapshot: LIVE_MANIFEST_SNAPSHOT,
    view: LIVE_MANIFEST_VIEW,
    sessionKey: LIVE_MANIFEST_SESSION_KEY,
  });
  const forkSeed = createPiExecutionManifestSeed({
    snapshot: LIVE_MANIFEST_SNAPSHOT,
    view: LIVE_MANIFEST_VIEW,
    sessionKey: LIVE_MANIFEST_SESSION_KEY,
    orchestrator: { forkSubagent: true },
  });
  const sessionDynamicTools = liveSessionDynamicTools(seed.snapshotGeneration);

  // Deferral on: the only composition that carries the two discovery tools.
  const capabilityKey = 'native:workspace:mcp:deferred';
  const deferredSeed = {
    ...createPiExecutionManifestSeed({
      snapshot: LIVE_MANIFEST_SNAPSHOT,
      view: LIVE_MANIFEST_VIEW,
      sessionKey: LIVE_MANIFEST_SESSION_KEY,
    }),
    provenance: [
      { capabilityKey: 'runtime:pi-session', generation: seed.snapshotGeneration },
      { capabilityKey, generation: seed.snapshotGeneration },
    ],
    mcpSources: [{ wireName: 'deferred', capabilityKey, generation: seed.snapshotGeneration }],
  };
  const deferredManifest = finalizePiExecutionManifest(
    deferredSeed,
    [
      ...sessionDynamicTools,
      {
        bindingName: 'mcp__deferred__thing',
        description: 'A deferrable MCP tool.',
        inputSchema: { type: 'object', properties: {} },
        modelSchemaVersion: 1 as const,
        bindingSchemaVersion: 1 as const,
        provenance: { capabilityKey, generation: seed.snapshotGeneration },
      },
    ],
    { toolSearchMode: { kind: 'always' } },
  );
  const deferredDefinitions = [
    ...liveStaticDefinitions(repoRoot),
    ...buildDeferredMcpToolSurface({
      enabled: deferredManifest.deferredMcp.enabled,
      generation: deferredManifest.snapshotGeneration,
      candidatePiNames: deferredManifest.deferredMcp.candidatePiNames,
      proxyTools: [],
      loadedToolNames: new Set<string>(),
    }).tools,
  ];

  return [
    {
      label: 'live+session',
      manifest: finalizePiExecutionManifest(seed, sessionDynamicTools),
      definitions: liveStaticDefinitions(repoRoot),
    },
    {
      // NESSY_DISABLE_BACKGROUND_TASKS removes bash_background, which changes the
      // presentation-replacement set ('Bash' becomes unambiguous).
      label: 'off-switch+session',
      manifest: finalizePiExecutionManifest(seed, sessionDynamicTools, { disableBackgroundTasks: true }),
      definitions: liveStaticDefinitions(repoRoot),
    },
    {
      // Fork mode: same tools, a different `subagent` schema, a different pin.
      label: 'fork-mode+session',
      manifest: finalizePiExecutionManifest(forkSeed, sessionDynamicTools),
      definitions: liveStaticDefinitions(repoRoot, true),
    },
    { label: 'deferred-mcp+session', manifest: deferredManifest, definitions: deferredDefinitions },
  ];
}
