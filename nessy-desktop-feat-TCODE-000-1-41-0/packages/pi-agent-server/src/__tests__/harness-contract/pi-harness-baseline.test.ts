import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  getToolDefsAsJsonSchema,
  getSessionToolDefs,
  getSessionToolNames,
  SESSION_TOOL_DEFS,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT,
} from '../../../../session-tools-core/src/tool-defs.ts';
import { handleBashOutput } from '../../../../session-tools-core/src/handlers/bash-output.ts';
import { handleScriptSandbox } from '../../../../session-tools-core/src/handlers/script-sandbox.ts';
import { handleSendAgentMessage } from '../../../../session-tools-core/src/handlers/send-agent-message.ts';
import { LEGACY_BROWSER_TOOL_ALIASES } from '../../../../shared/src/agent/browser-tool-names.ts';
import {
  getHarnessToolDescriptor,
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getPiStaticModelContractHash,
  getPiToolBinding,
} from '../../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
import {
  finalizePiExecutionManifest,
  type PiExecutionManifestSeedV2,
} from '../../../../shared/src/agent/pi-harness/harness-manifest.ts';
import { createToolExecutor } from '../../../../shared/src/agent/pi-harness/tool-executor.ts';
import { LocalToolRuntime } from '../../../../shared/src/agent/local-tools/runtime.ts';
import { PiEventAdapter } from '../../../../shared/src/agent/backend/pi/event-adapter.ts';
import { NessyMcpClient } from '../../../../shared/src/mcp/client.ts';
import { getSystemPrompt } from '../../../../shared/src/prompts/system.ts';
import {
  createFileCheckpoint,
  finalizeFileCheckpoint,
  listFileCheckpoints,
  revertFileCheckpoint,
} from '../../../../shared/src/sessions/file-checkpoints.ts';
import {
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_TO_CANONICAL,
} from '../../../../shared/src/agent/mode-types.ts';
import { LOCALE_REGISTRY } from '../../../../shared/src/i18n/registry.ts';
import {
  buildDeferredMcpToolSurface,
  DEFAULT_DEFERRED_MCP_TOOL_THRESHOLD,
  DEFERRED_MCP_TOOL_LOAD_NAME,
  DEFERRED_MCP_TOOL_SEARCH_NAME,
} from '../../deferred-mcp-tools.ts';
import { normalizePiSdkToolCallRecordsV1 } from '../../compat/pi-legacy-ingress.ts';
import {
  buildRuntimeBackedBuiltinToolDefinitions,
  buildRuntimeBackedToolExecutionPorts,
} from '../../local-tools/runtime-backed-tools.ts';
import { createAskUserTool } from '../../orchestrator/ask-user-tool.ts';
import { createGetSubagentResultTool, createSteerSubagentTool, createStopTaskTool, createSubagentTool } from '../../orchestrator/subagent-tool.ts';
import { createWorkflowTool } from '../../orchestrator/workflow-tool.ts';
import { createReviewTool } from '../../orchestrator/review-tool.ts';
import { compileWorkflowScript } from '../../orchestrator/sandbox.ts';
import {
  createBackgroundBashTool,
} from '../../tools/background-bash.ts';
import { createSearchTool } from '../../tools/search/create-search-tool.ts';
import { createWebFetchTool } from '../../tools/web-fetch.ts';
import { projectPiManifestTools } from '../../harness/tool-manifest.ts';
// P2.116 — the canonicalisation and the factory table are SHARED with the gate
// that blocks on these same pins (`bun run check:surface`, wired into this
// package's `typecheck`). A second copy here is how a guard and its gate end up
// disagreeing about what is green.
import {
  SOURCE_STATE_FACTORIES,
  canonicalJson,
  sourceStateFactoryBlock,
} from '../../harness/source-state-contract.ts';
import { MODULE_GRAPH_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets';

/**
 * This suite's red is its MODULE GRAPH, not any test in it, and the budget is
 * sized against that — never against zero, and never against a neighbour's
 * constant (copying a sibling's number is what manufactured a red in the two
 * suites `P6.630` registered).
 *
 * How it presents: `"executes golden event and prompt producers with ordered
 * source contracts"` times out at bun's 5 000 ms default under wave load while
 * the file passes ALONE — the starvation signature AGENTS' two-causes rule
 * separates. W8-g measured that one test alone at load 9.08: 1 pass /
 * 186 expect() calls, run total 542.83 s (2026-09-07).
 *
 * What W7-ae then measured, and it moves the budget off that one test: the
 * whole file, alone, is 23 pass / 0 fail in 75.66 s at load 11.99, 341.01 s at
 * load 13.82, and 1.32 s at load 13.23 — a 258x spread across three runs whose
 * LOADS differ by 15 %, so load does not explain it — while EVERY test body measures
 * in milliseconds (junit reporter, slowest three: 152 ms, 100 ms, and 65 ms for
 * the golden producer itself). So the seconds are the import graph blocking the
 * loop, bun's budget is a TIMER, and WHICH test is holding the window when it
 * fires is an accident. A per-test budget would leave the other 22 exposed to
 * the identical mechanism, so the budget is the file's.
 *
 * It also reproduces the register's own trap: the FILTERED run (542.83 s) is
 * slower than the whole file (75.66 s), so a per-test cost read off a filter is
 * the module graph, not the test.
 *
 * Registered in `docs/superpowers/specs/2026-07-29-known-failing-tests.md`,
 * module-graph family. `P6.638` replaces this per-file constant with ONE shared
 * budget across that family; until it lands, a per-file constant carrying its
 * own reading is the honest state.
 *
 * RELABELLED 2026-09-07 (`P6.677`): the family's class (c) STARVATION label rested
 * on "never failed alone, at any load", which cannot distinguish starvation from
 * an I/O-bound timer lottery. The zero-case control on this file (a `-t` name
 * nothing matches, so none of the 23 cases runs) measured **2.62 s at 65 % cpu**
 * (load 8.48) and then **26.49 s at 7.2 % cpu** on the repeat at load 8.24 — TEN
 * TIMES SLOWER at the LOWER load, with total CPU flat at ~1.9 s. Load does not
 * order these numbers; the page cache does. Budget unchanged.
 */
// P6.638 — the budget is the SHARED one now; the reasoning above is this
// file's own measurement and stays. The constant's docblock carries the
// sizing rule and the zero-case-control recipe for whoever sizes the next
// one, so a seventh suite does not rediscover them a seventh time.
setDefaultTimeout(MODULE_GRAPH_BUDGET_MS);

const fixturesDir = resolve(import.meta.dir, 'fixtures');
const repoRoot = resolve(import.meta.dir, '../../../../..');

function supervisedBackgroundTool(emitEvent: (event: any) => void = () => undefined, handle = 'process_0123456789abcdef0123456789abcdef') {
  return createBackgroundBashTool({
    emitEvent,
    // `environmentProfile`/`environmentDigest` are required on
    // `SupervisedProcessResult`; the sibling `tools/background-bash.test.ts`
    // carries the same two, and neither reaches an assertion here — the
    // `shell_backgrounded` event this tool emits is a fixed four-key literal.
    start: async () => ({ handle, output: '', nextCursor: 0, isRunning: true, exitCode: null, signal: null, isolationProfile: 'workspace:fixture', environmentProfile: 'restricted', environmentDigest: 'digest' }),
  });
}

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8')) as T;
}

function schemaContract(
  row: any,
  payload: unknown,
  evidenceKind: 'live-json-schema' | 'live-tool-parameters' | 'source-state-schema' | 'dynamic-wire-source',
  handlerSource: string,
  inputCodec: string,
  resultCodec: string,
): Record<string, string> {
  const digest = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  return {
    evidenceKind,
    schemaIdentity: `${evidenceKind}:sha256:${digest}`,
    modelSchemaVersion: `${evidenceKind}/sha256:${digest}`,
    bindingSchemaVersion: `exact-name:${row.currentName}/sha256:${digest}`,
    handlerSchemaVersion: `${handlerSource}#${row.handlerName}@e3357945a45ad6dd45019cc53944a9a071788503`,
    inputCodec,
    resultCodec,
  };
}

function sourceFactoryBlock(path: string, startMarker: string, endMarker?: string): string {
  const source = sourceAt(path);
  const start = source.indexOf(startMarker);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  expect(start, `${path}#${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `${path}#${endMarker ?? 'EOF'}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function liveToolSchemaContracts(tools: any): Record<string, Record<string, string>> {
  const contracts: Record<string, Record<string, string>> = {};
  // R20: `NESSY_ENABLE_TASKS` makes the task checklist and the legacy
  // TodoWrite/Task pair mutually exclusive on the Pi surface, so a single
  // enumeration can never see all 46 registry tools. The ledger pins every
  // tool's contract, so it enumerates BOTH switch states and unions them.
  //
  // P3.276 added a THIRD dimension for the same reason: `ReviewDiff` is
  // `visibility: 'not-pi'` (Pi's own `review` tool does strictly more) and is
  // additionally gated on `reviewDiffPort`, so it appears in NEITHER state of
  // the Pi enumeration. The union therefore also walks the default projection
  // with the port flag on — the ledger pins every tool's contract, and a tool no
  // enumeration here can see is a contract nobody pins.
  //
  // UB6.11 added a FOURTH: `decide` is port-gated like `ReviewDiff` on every
  // surface (`SessionToolFilterOptions.decidePort`), so the enumeration has to
  // ask for it or the ledger row reads as a removal. Same arm
  // `source-state-contract.ts` `liveJsonSchemaDigests` carries.
  const sessionDefinitions = new Map(['1', '0'].flatMap(value => {
    const previous = process.env.NESSY_ENABLE_TASKS;
    process.env.NESSY_ENABLE_TASKS = value;
    try {
      return ([
        { prefix: 'mcp__session__', includeDeveloperFeedback: true, projection: 'pi' as const },
        { prefix: 'mcp__session__', includeDeveloperFeedback: true, reviewDiffPort: true, hostWebSearch: true },
        { prefix: 'mcp__session__', includeDeveloperFeedback: true, decidePort: true },
      ]).flatMap(options => getToolDefsAsJsonSchema(options)
        .map(definition => [definition.name, definition] as const));
    } finally {
      if (previous === undefined) delete process.env.NESSY_ENABLE_TASKS;
      else process.env.NESSY_ENABLE_TASKS = previous;
    }
  }));
  for (const row of tools.sessionTools) {
    const definition = sessionDefinitions.get(row.currentName);
    expect(definition, row.currentName).toBeDefined();
    contracts[row.semanticId] = { ...schemaContract(
      row,
      definition!.inputSchema,
      'live-json-schema',
      'packages/session-tools-core/src/tool-defs.ts',
      'getToolDefsAsJsonSchema:zodToJsonSchema($refStrategy=none)',
      'ProxyExecutionResult->AgentToolResult',
    ), descriptionDigest: liveToolDescriptionDigest(definition!.description) };
  }

  const searchProvider = { name: 'fixture', search: async () => [] };
  const liveStaticDefinitions = [
    ...buildRuntimeBackedBuiltinToolDefinitions(repoRoot),
    createSearchTool(searchProvider, searchProvider),
    createWebFetchTool(() => null),
    supervisedBackgroundTool(),
    createAskUserTool({ askUser: async () => ({ type: 'option', optionIndex: 0, value: 'fixture' }) }),
  ];
  const liveStaticByName = new Map(liveStaticDefinitions.map(definition => [definition.name, definition]));
  const staticSources: Record<string, string> = {
    read: 'packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts',
    bash: 'packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts',
    edit: 'packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts',
    write: 'packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts',
    grep: 'packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts',
    find: 'packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts',
    ls: 'packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts',
    NotebookEdit: 'packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts',
    web_search: 'packages/pi-agent-server/src/tools/search/create-search-tool.ts',
    web_fetch: 'packages/pi-agent-server/src/tools/web-fetch.ts',
    bash_background: 'packages/pi-agent-server/src/tools/background-bash.ts',
    ask_user: 'packages/pi-agent-server/src/orchestrator/ask-user-tool.ts',
  };
  for (const row of tools.piStaticTools) {
    const definition = liveStaticByName.get(row.currentName);
    if (definition) {
      const handlerSource = staticSources[row.currentName];
      // Refuse by name rather than pinning `undefined` as a handler path: a
      // static row added without a source entry would otherwise reach the
      // fixture comparison as a contract whose provenance is missing.
      if (handlerSource === undefined) throw new Error(`no handler source pinned for static tool ${row.currentName}`);
      contracts[row.semanticId] = schemaContract(
        row,
        definition.parameters,
        'live-tool-parameters',
        handlerSource,
        'Pi ToolDefinition.parameters:canonical-json',
        'AgentToolResult',
      );
      continue;
    }

    const sourceState = SOURCE_STATE_FACTORIES[row.currentName];
    if (!sourceState) throw new Error(`Unsupported source-state tool: ${row.currentName}`);
    // The gate looks these pins up by `semanticId`; this row is where the two
    // spellings meet, so a table that names the wrong contract fails HERE
    // rather than making the gate check a pin that is not this one.
    expect(sourceState.semanticId, row.currentName).toBe(row.semanticId);
    const sourcePath = sourceState.path;
    const sourceContract = sourceStateFactoryBlock(repoRoot, sourceState);
    contracts[row.semanticId] = schemaContract(
      row,
      { sourcePath, factorySource: sourceContract },
      'source-state-schema',
      sourcePath,
      'source-state parameters declaration; live import excluded because spawner eager runtime graph retains handles',
      'AgentToolResult',
    );
  }

  const proxyTool = (name: string) => ({
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    async execute() { return { content: [{ type: 'text' as const, text: name }], details: {} }; },
  });
  const deferred = buildDeferredMcpToolSurface({
    enabled: true,
    proxyTools: Array.from({ length: DEFAULT_DEFERRED_MCP_TOOL_THRESHOLD + 1 }, (_, index) =>
      proxyTool(`mcp__fixture__tool_${index}`)) as any,
    loadedToolNames: new Set(),
  });
  const deferredByName = new Map(deferred.tools.map(definition => [definition.name, definition]));
  for (const row of tools.conditionalTools) {
    const definition = deferredByName.get(row.currentName);
    expect(definition, row.currentName).toBeDefined();
    contracts[row.semanticId] = schemaContract(
      row,
      definition!.parameters,
      'live-tool-parameters',
      'packages/pi-agent-server/src/deferred-mcp-tools.ts',
      'TypeBox ToolDefinition.parameters:canonical-json',
      'AgentToolResult',
    );
  }

  const dynamicRow = tools.dynamicMcp;
  contracts[dynamicRow.semanticId] = schemaContract(
    dynamicRow,
    {
      bindingPattern: dynamicRow.bindingPattern,
      poolProjection: sourceFactoryBlock(
        'packages/shared/src/mcp/mcp-pool.ts',
        '  getProxyToolDefs(slugs?: string[], leaserId?: string): ProxyToolDef[]',
        // P3 made the callTool signature multi-line (optional per-call context).
        '  async callTool(',
      ),
      piProjection: sourceFactoryBlock(
        'packages/pi-agent-server/src/index.ts',
        'function buildProxyTools(backgroundTasks?: BackgroundTaskRegistry)',
        'async function queryLlm',
      ),
    },
    'dynamic-wire-source',
    'packages/shared/src/mcp/mcp-pool.ts',
    'McpToolDefinition.inputSchema->ProxyToolDef.inputSchema->ToolDefinition.parameters',
    'MCP CallToolResult->McpToolResult->ProxyExecutionResult->AgentToolResult',
  );
  return contracts;
}

function livePinnedStaticDefinitions(cwd: string) {
  const provider = { name: 'fixture', search: async () => [] };
  const proxyTools = Array.from({ length: DEFAULT_DEFERRED_MCP_TOOL_THRESHOLD + 1 }, (_, index) => ({
    name: `mcp__fixture__tool_${index}`,
    label: 'fixture',
    description: 'fixture',
    parameters: { type: 'object' },
    async execute() { return { content: [], details: {} }; },
  }));
  const deferred = buildDeferredMcpToolSurface({
    enabled: true,
    proxyTools: proxyTools as any,
    loadedToolNames: new Set(),
  }).tools.filter(tool => tool.name === DEFERRED_MCP_TOOL_SEARCH_NAME || tool.name === DEFERRED_MCP_TOOL_LOAD_NAME);
  const childResult = { agent: 'worker', status: 'done' as const, text: '', tokensIn: 0, tokensOut: 0 };
  const childPort = {
    start: async () => ({ agentId: 'child', status: 'completed' as const, output: '' }),
    resume: async () => ({ agentId: 'child', status: 'completed' as const, output: '' }),
    steer: async () => {},
    getResult: async () => ({ agentId: 'child', status: 'completed' as const, output: '' }),
    stop: async () => {}, stopTask: async () => {}, sealOwnerTask: async () => {},
    searchOutput: async () => ({ agentId: 'child', cursor: 0, status: 'completed' as const, results: [] }),
    attach: async () => ({ agentId: 'child', cursor: 0, output: '', status: 'completed' as const }),
    monitor: async () => ({ agentId: 'child', status: 'completed' as const, output: '' }),
  };
  return [
    ...buildRuntimeBackedBuiltinToolDefinitions(cwd),
    createSearchTool(provider, provider),
    createWebFetchTool(() => null),
    supervisedBackgroundTool(),
    createSubagentTool({ getCwd: () => cwd, spawn: async () => childResult, childSessionPort: childPort }),
    createReviewTool({ getCwd: () => cwd, spawn: async () => ({ ...childResult, agent: 'reviewer' }), computeDiff: async () => '', childSessionPort: childPort }),
    createGetSubagentResultTool(childPort),
    createSteerSubagentTool(childPort),
    createStopTaskTool(childPort),
    createWorkflowTool({ getCwd: () => cwd, spawn: async () => childResult }),
    createAskUserTool({ askUser: async () => ({ type: 'option', optionIndex: 0, value: 'fixture' }) }),
    ...deferred,
  ];
}

function resolveEffectiveToolRow(tools: any, collection: string, row: any): any {
  const profile = tools.toolLedgerSchema.collectionProfiles[collection];
  const schemaContract = tools.schemaContracts?.[row.semanticId];
  expect(schemaContract, `${collection}.${row.semanticId}.schemaContract`).toBeDefined();
  return {
    ...profile,
    ...row,
    ...schemaContract,
    claudeCounterpartReason: row.claudeCounterpartReason ?? profile.claudeCounterpartReason,
  };
}

function testExecutionManifest() {
  const generation = 'fixture-generation';
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey: { workspaceId: 'fixture', sessionId: 'fixture' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
      const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName];
      return modelContractHash ? [{
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash,
      }] : [];
    }),
  };
  return finalizePiExecutionManifest(seed, []);
}

describe('Pi harness R0 baseline', () => {
  test('pins the current package baseline and the approved Artifactory target', () => {
    const tools = fixture<any>('tool-surface.json');
    const rootPackage = fixtureAt<any>('package.json');
    const serverPackage = fixtureAt<any>('packages/pi-agent-server/package.json');

    expect(tools.currentPiVersion).toBe('0.87.1');
    expect(tools.selectedArtifactoryPiVersion).toBe('0.87.1');
    expect(rootPackage.dependencies['@earendil-works/pi-ai']).toBe(tools.currentPiVersion);
    expect(rootPackage.dependencies['@earendil-works/pi-coding-agent']).toBe(tools.currentPiVersion);
    for (const name of [
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
    ]) {
      expect(serverPackage.dependencies[name]).toBe(tools.currentPiVersion);
    }
  });

  test('pins the H1A adapter, public prompt lifecycle, and readiness contract', () => {
    const runtime = fixture<any>('runtime-behavior.json');
    expect(runtime.h1aRuntimeCompatibility).toEqual({
      installedPiVersion: '0.87.1',
      adapterOwner: 'packages/pi-agent-server/src/compat/pi-runtime-adapter.ts',
      constructionPaths: ['main', 'ephemeral', 'orchestrator-child'],
      sessionStrategies: ['memory', 'continue', 'fork-with-anchor'],
      promptLifecycle: 'DefaultResourceLoader inline ExtensionFactory before_agent_start override; no private session prompt fields',
      settingsLifecycle: 'SettingsManager.inMemory({}, { projectTrusted: false }); native settings/package/extension discovery and persistence cannot feed construction',
      sessionShape: 'adapter validates every directly consumed AgentSession method and property before returning a handle',
      bedrockBundling: 'entrypoint statically registers bedrockProviderModule through setBedrockProviderModule before runtime construction',
      readinessFailure: 'startup_error, invalid session shape, initial auto-compaction failure, or pre-startup-settled child exit rejects shared readiness, pending RPCs, listeners and child state, then permits retry',
    });
    expect(runtime.jsonl.outbound).toContain('startup_error');

    const artifactoryAttribution = runtime.referenceSources
      .filter((source: { id: string }) => source.id.startsWith('artifactory-pi-'))
      .map((source: { attribution: string }) => source.attribution);
    expect(new Set(artifactoryAttribution)).toEqual(new Set([
      'UA12.211 installed exact 0.87.1 through the existing configured Artifactory with no registry override (2026-10-10); WJ-lift did the same for 0.85.1 on 2026-09-24, W19-z2 for 0.84.4 on 2026-09-13 and W11-pi for 0.84.3 on 2026-09-11.',
    ]));
  });

  test('pins the selected H1B runtime protocol and safe event disposition', () => {
    const runtime = fixture<any>('runtime-behavior.json');
    const protocol = runtime.h1bRuntimeProtocol;
    const core = sourceAt('node_modules/@earendil-works/pi-agent-core/dist/types.d.ts');
    const session = sourceAt('node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts');
    const eventTypes = (input: string) => [...input.matchAll(/type: "([a-z_]+)"/g)].map(match => match[1]!);
    const selectedEvents = [...new Set([
      ...eventTypes(core.slice(core.indexOf('export type AgentEvent ='), core.indexOf('//# sourceMappingURL'))),
      ...eventTypes(session.slice(session.indexOf('export type AgentSessionEvent ='), session.indexOf('export type AgentSessionEventListener'))),
    ])];

    expect([...protocol.selectedEvents].sort()).toEqual([...selectedEvents].sort());
    expect(protocol).toMatchObject({
      toolExecution: 'parallel, assigned and read back through PiRuntimeAdapter',
      agentDir: 'server-derived from sessionPath/.pi-agent',
      orchestratorFields: ['concurrency', 'depth', 'maxParallelTasks', 'maxAgents', 'tierModelMap', 'tokenBudget', 'contextSeed', 'sessionDepth', 'sessionIsFork', 'forkSubagent', 'availableModels'],
      orchestratorDisposition: 'host sends the finalized V2 manifest and all eleven normalized fields; manifestless standalone ingress is rejected',
      callLlmExecution: 'Pi SDK adapter to ToolExecutor to buildProxyTools dispatch; no speculative host dispatch or transient approval receipt',
      queueUpdate: 'status counts only; queued prompt contents never emitted',
      unknownEvent: 'safe Pi 0.87.1 type diagnostic plus active queue contract failure',
      maxAgentTurns: 'raw turn_start N+1 one-shot abort before adaptation; one public-chat budget across fallback; terminal raw events dropped',
    });

    const adapterSource = sourceAt('packages/pi-agent-server/src/compat/pi-runtime-adapter.ts');
    expectOrderedMarkers(adapterSource, [
      "result.session.agent.toolExecution = 'parallel'",
      "result.session.agent.toolExecution !== 'parallel'",
    ], 'parallel tool execution assignment and read-back');

    const eventAdapter = new PiEventAdapter();
    expect([...eventAdapter.adaptEvent({ type: 'queue_update', steering: ['secret'], followUp: [] } as any)])
      .toEqual([{ type: 'status', message: 'Pi queue updated: 1 steering, 0 follow-up' }]);
    expect([...eventAdapter.adaptEvent({ type: 'future_event', secret: 'hidden' } as any)])
      .toEqual([{ type: 'error', message: 'Unsupported Pi 0.87.1 event: future_event' }]);
    expect(eventAdapter.shouldCompleteQueue(false)).toBe(true);
  });

  test('pins all 56 session tools and their current execution-policy fields', () => {
    const tools = fixture<any>('tool-surface.json');
    const expectedSemanticIds = [
      'session.submit_plan', 'session.config_validate', 'session.skill_validate',
      'session.mermaid_validate', 'session.source_test', 'session.source_manage', 'session.source_oauth_trigger',
      'session.source_google_oauth_trigger', 'session.source_credential_prompt',
      'session.update_user_preferences', 'session.remember', 'session.todo_write', 'session.task',
      // R20 — the four documented task tools.
      'session.task_create', 'session.task_update', 'session.task_get', 'session.task_list',
      'session.goal_get', 'session.goal',
      // P6.148 — the host's own search, offered where the runtime's native one
      // cannot reach us: on a claude session whose `WebSearch` is withheld, and
      // on every codex session. `not-pi`, because Pi registers its own.
      'session.web_search',
      'session.transform_data', 'session.script_sandbox', 'session.render_template',
      // P2.1 — the advisor consult, `backend` for call_llm's reason: it runs on
      // the agent's own tool-less `queryLlm` route, which no registry handler
      // can reach.
      'session.send_developer_feedback', 'session.call_llm',
      // UB6.11 — the decide tool (v0.15.1): the decision layer's one session tool,
      // OFFERED only through `SessionToolFilterOptions.decidePort` (the stated
      // deviation, OQ-43.5 (a)), so it sits in the defs between `call_llm` and the
      // advisor consult and appears in the live catalog only under its flag.
      'session.decide', 'session.advisor_consult', 'session.spawn_session',
      'session.browser_tool',
      // P3.276 — the host-computed review diff, offered on claude and on a
      // bridged codex only once the host binds `ctx.reviewDiff`.
      'session.review_diff',
      'session.slash_command', 'session.bash_output', 'session.process_stop',
      'session.monitor',
      'session.enter_worktree', 'session.exit_worktree', 'session.worktree_batch',
      // P6.466 — `archive_session`, whose approval card is raised by the HOST
      // closure rather than by the permission gate: for a session MCP tool
      // neither `INTERACTION_ONLY_TOOLS` (zero `runPreToolUseChecks` call sites
      // in `codex-agent.ts`) nor `findNonNegotiableFloors` (subjects are `Bash`
      // and `Write` only) is on codex's answer path.
      'session.set_labels', 'session.set_status', 'session.archive', 'session.get_info', 'session.list',
      'session.list_mcp_resources', 'session.read_mcp_resource',
      // UB7.11 — the MCP prompt pair (v0.15.1): host session tools on ALL THREE
      // runtimes, offered unconditionally (the resource pair's pi-only reason —
      // a colliding native tool — does not exist for prompts).
      'session.source_list_prompts', 'session.source_get_prompt',
      // R17 — the read half of lazy skill supporting resources.
      'session.read_skill_resource',
      'automation.list', 'automation.validate', 'automation.create', 'automation.update',
      'session.send_agent_message',
      'plugin.plan_install', 'plugin.install', 'plugin.status', 'plugin.manage',
      // R27a — model-invocable delivery.
      'session.report_findings', 'session.push_notification', 'session.send_user_file',
      // R27b — session-scoped scheduling. P6.295 arm (2) added the fifth,
      // `cron_control`: pause / resume / run-now / mark-read in one tool.
      'session.cron_create', 'session.cron_list', 'session.cron_delete', 'session.cron_control',
      // R39 — the self-paced /loop wakeup.
      'session.schedule_wakeup',
      // UA1.18 — t-artifacts publishing; the publish card is the HOST closure's (archive_session's seam).
      'session.publish_artifact', 'session.list_artifacts',
      // UA3.5 — the board task tool; every restriction on the caller is the HOST closure's.
      'session.create_board_task',
      // UA6.3 — the six page tools; storage and delete_page's one-shot card are the HOST closure's.
      'session.list_pages', 'session.get_page', 'session.create_page', 'session.update_page', 'session.write_page_data', 'session.delete_page',
      // UB1.12 — the append-only project-memory note (v0.15.1); the dated heading and the one O_APPEND write are the
      // HOST closure's, and the tool-defs entry sits after delete_page (the same order this list pins).
      'session.project_memory_append',
    ];
    expect(tools.sessionTools.map((row: { semanticId: string }) => row.semanticId)).toEqual(expectedSemanticIds);
    expect(SESSION_TOOL_DEFS).toHaveLength(tools.sessionTools.length);

    const byName = new Map(SESSION_TOOL_DEFS.map((definition) => [definition.name, definition]));
    for (const row of tools.sessionTools) {
      const current = byName.get(row.handlerName);
      expect(current, row.handlerName).toBeDefined();
      expect(row.currentName).toBe(`mcp__session__${row.handlerName}`);
      expect(row.bindingName).toBe(row.currentName);
      expect(row.finalPiName).toBeString();
      expect(current?.executionMode).toBe(row.executionMode);
      expect(current?.safeMode).toBe(row.safeMode);
      expect(Boolean(current?.readOnly)).toBe(row.readOnly);
      expect(row.semanticId).toBeString();
      expect(row.claudeBehaviorCounterpart === null || typeof row.claudeBehaviorCounterpart === 'string').toBe(true);
      expect(row.permissionName).toBeString();
    }
  });

  test('resolves and validates every complete effective tool-ledger row', () => {
    const tools = fixture<any>('tool-surface.json');
    const schema = tools.toolLedgerSchema;
    expect(schema.schemaVersion).toBe('effective-tool-row@4');

    const collections: Array<[string, any[]]> = [
      ['sessionTools', tools.sessionTools],
      ['piStaticTools', tools.piStaticTools],
      ['conditionalTools', tools.conditionalTools],
      ['dynamicMcp', [tools.dynamicMcp]],
    ];
    for (const [collection, rows] of collections) {
      const inherited = schema.collectionProfiles[collection];
      expect(inherited, collection).toBeDefined();
      for (const row of rows) {
        const effective = resolveEffectiveToolRow(tools, collection, row);
        for (const field of schema.requiredEffectiveFields) {
          expect(Object.prototype.hasOwnProperty.call(effective, field), `${collection}.${row.semanticId}.${field}`).toBe(true);
          expect(effective[field], `${collection}.${row.semanticId}.${field}`).not.toBeUndefined();
          if (typeof effective[field] === 'string') {
            expect(effective[field].length, `${collection}.${row.semanticId}.${field}`).toBeGreaterThan(0);
          }
        }
        for (const field of schema.collectionRequiredFields[collection]) {
          expect(Object.prototype.hasOwnProperty.call(effective, field), `${collection}.${row.semanticId}.${field}`).toBe(true);
        }
        for (const field of [
          'promptCallSites', 'hookCallSites',
          'permissionCallSites', 'transcriptCallSites', 'a2aCallSites',
        ]) {
          expect(effective[field], `${collection}.${row.semanticId}.${field}`).toBeArray();
        }
        expect(effective.schemaIdentity).toMatch(
          /^(live-json-schema|live-tool-parameters|source-state-schema|dynamic-wire-source):sha256:[a-f0-9]{64}$/,
        );
        expect(effective.bindingSchemaVersion).toContain(`exact-name:${row.currentName}/sha256:`);
        expect(effective.handlerSchemaVersion).toContain(`#${row.handlerName}@`);
        expect(effective.availabilityCondition).toBeString();
        if (effective.claudeBehaviorCounterpart === null) {
          expect(effective.claudeCounterpartReason).toBeString();
          expect(effective.claudeCounterpartReason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  /**
   * P6.802 — WHERE THE PINS THESE TWO TESTS READ LIVE, and who moved them.
   *
   * `tool-surface.json` is JSON and carries no comment channel, so the
   * provenance of a re-pinned digest has to be written here. Five pins were
   * re-taken on 2026-09-08; each cause was identified before the pin was moved,
   * never after, and the four `schemaContracts` digests were recomputed
   * INDEPENDENTLY of the failing run — `sha256(canonicalJson(payload))` over the
   * same payload the helper below builds — and reproduced the live values
   * exactly:
   *
   * - `session.spawn_session` · `01383f5e1` (P6.334) added `propose` to
   *   `SpawnSessionSchema`.
   * - `session.spawn_session` · this commit (UA12.108) added `projectId` to
   *   `SpawnSessionSchema` — the Pi model surface caught up with the
   *   `SpawnSessionRequest` field UA5.4 had wired the host side of; re-pinned
   *   from `check:surface -- --live-json-schema`'s expected values, not from
   *   this test's failure.
 * - `session.project_memory_append` · this commit (UB1.12) added the tool (v0.15.1
 *   upstream parity): a NEW row, not a re-pin — the row and its four digests landed
 *   together, from `check:surface -- --live-json-schema`'s expected values; the
 *   `handlerSchemaVersion` commit suffix is carried, not derived (e3357945a, every
 *   row's shared value).
 * - `session.source_list_prompts` / `session.source_get_prompt` · this commit
 *   (UB7.11) added the pair (v0.15.1 upstream parity, OQ-B4-2 (c)): TWO NEW rows,
 *   not a re-pin — minted the same way as `project_memory_append`'s, from
 *   `getToolDefsAsJsonSchema`'s live schema + description over `canonicalJson`;
 *   the `handlerSchemaVersion` commit suffix is carried, not derived. `mcp.dynamic`
 *   moved in the same commit because its payload is the SOURCE TEXT of the pool's
 *   proxy-tool builders and the row's client-side prompt paging edited that file.
   * - `session.update_user_preferences` · `6c6a20e72` (P6.441) added the
   *   git-attribution preference keys.
   * - `web.fetch` · `7a459959b` put the extraction step behind an opt-in, which
   *   rewrote the `prompt` parameter's description.
   * - `mcp.dynamic` · `e85ff4b85` (P6.701) — this one is NOT a schema change:
   *   the payload is the SOURCE TEXT of `getProxyToolDefs` and `buildProxyTools`,
   *   so the idle-timeout read moved it. Attributed by walking that exact payload
   *   over the 40 commits touching either file; the digest changes at that commit
   *   and at no other.
   * - `agent.review`'s `modelContractHash` · `ace4a5821` (P6.308) changed the
   *   review tool, and `PI_STATIC_MODEL_CONTRACT_HASHES` — the live constant, not
   *   this fixture — was updated with it.
   *
   * `bun run check:surface` cannot see any of the five: it pins the
   * `source-state-schema` rows only, and reports 81/81 green while these are red.
   * That is not a hole in the gate — a `live-json-schema` pin has no source block
   * to hash — but it does mean this file is the only place that catches them.
   */
  test('pins deterministic production schema contracts for every effective tool', () => {
    const tools = fixture<any>('tool-surface.json');
    const semanticIds = [
      ...tools.sessionTools,
      ...tools.piStaticTools,
      ...tools.conditionalTools,
      tools.dynamicMcp,
    ].map((row: any) => row.semanticId);
    const liveContracts = liveToolSchemaContracts(tools);
    expect(Object.keys(tools.schemaContracts ?? {})).toEqual(semanticIds);
    expect(tools.schemaContracts).toEqual(liveContracts);
  });

  test('pins the complete projected model contract for every static child tool', () => {
    const fixtureTools = fixture<any>('tool-surface.json');
    const definitions = livePinnedStaticDefinitions(repoRoot);
    const byName = new Map(definitions.map(definition => [definition.name, definition]));
    const standalone = testExecutionManifest();
    const rows: any[] = [...fixtureTools.piStaticTools, ...fixtureTools.conditionalTools];
    for (const row of rows) {
      // `String(...)` on the label is load-bearing: `expect(any, any)` resolves
      // to bun's `(actual?: never, customFailMessage?: string): Matchers<undefined>`
      // overload, and every `.toBe(<string>)` then fails to compile. Measured —
      // `expect(any, string)` and `expect(string, any)` both resolve fine.
      expect(row.modelContractHash, String(row.bindingName)).toBe(getPiStaticModelContractHash(row.bindingName));
    }
    expect(() => projectPiManifestTools({
      manifest: standalone,
      definitions: standalone.tools.map(tool => byName.get(tool.binding.bindingName)!),
      expectedGeneration: standalone.snapshotGeneration,
      expectedManifestHash: standalone.manifestHash,
    })).not.toThrow();

    const provenance = { capabilityKey: 'fixture:mcp', generation: 'fixture-generation' };
    const conditionalTools = fixtureTools.conditionalTools.map((row: any) => {
      const binding = getPiToolBinding(row.finalPiName);
      return {
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash: getPiStaticModelContractHash(binding.bindingName),
      };
    });
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: provenance.generation,
      sessionKey: { workspaceId: 'fixture', sessionId: 'fixture' },
      provenance: [provenance],
      mcpSources: [{ wireName: 'fixture', ...provenance }],
      orchestrator: standalone.orchestrator,
      staticTools: [...standalone.tools, ...conditionalTools],
    };
    const dynamic = Array.from({ length: DEFAULT_DEFERRED_MCP_TOOL_THRESHOLD + 1 }, (_, index) => ({
      bindingName: `mcp__fixture__tool_${index}`,
      description: 'fixture',
      inputSchema: { type: 'object' },
      modelSchemaVersion: 1 as const,
      bindingSchemaVersion: 1 as const,
      provenance,
    }));
    const deferredManifest = finalizePiExecutionManifest(seed, dynamic, { deferredMcpEnabled: true });
    expect(() => projectPiManifestTools({
      manifest: deferredManifest,
      definitions,
      expectedGeneration: deferredManifest.snapshotGeneration,
      expectedManifestHash: deferredManifest.manifestHash,
    })).not.toThrow();
  });

  test('pins permission vocabulary, static tools, and deferred MCP spellings', () => {
    const tools = fixture<any>('tool-surface.json');
    const mcp = fixture<any>('mcp-capabilities.json');

    expect([...PERMISSION_MODE_ORDER]).toEqual(tools.permissionModes.internal);
    expect(PERMISSION_MODE_TO_CANONICAL).toEqual(tools.permissionModes.mapping);
    expect(tools.permissionModes.canonical).toEqual([
      'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
    ]);
    expect(tools.piStaticTools.map((row: { currentName: string }) => row.currentName)).toEqual([
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'NotebookEdit',
      'web_search', 'web_fetch', 'bash_background', 'subagent', 'review',
      'get_subagent_result', 'steer_subagent', 'stopTask',
      'workflow', 'ask_user',
    ]);
    expect(tools.piStaticTools.map((row: { semanticId: string }) => row.semanticId)).toEqual([
      'file.read', 'process.shell', 'file.edit', 'file.write', 'file.grep', 'file.find',
      'file.list', 'notebook.edit', 'web.search', 'web.fetch',
      'process.background_shell', 'agent.subagent', 'agent.review',
      'agent.get_subagent_result', 'agent.steer_subagent', 'agent.stop_task',
      'workflow.execute', 'user.ask',
    ]);
    expect(tools.piStaticTools.map((row: { handlerName: string }) => row.handlerName)).toEqual([
      'buildRuntimeBackedBuiltinToolDefinitions.read.execute',
      'buildRuntimeBackedBuiltinToolDefinitions.bash.execute',
      'buildRuntimeBackedBuiltinToolDefinitions.edit.execute',
      'buildRuntimeBackedBuiltinToolDefinitions.write.execute',
      'buildRuntimeBackedBuiltinToolDefinitions.grep.execute',
      'buildRuntimeBackedBuiltinToolDefinitions.find.execute',
      'buildRuntimeBackedBuiltinToolDefinitions.ls.execute',
      'createNotebookEditTool.execute', 'createSearchTool.execute',
      'createWebFetchTool.execute', 'createBackgroundBashTool.execute',
      'createSubagentTool.execute', 'createReviewTool.execute',
      'createGetSubagentResultTool.execute',
      'createSteerSubagentTool.execute', 'createStopTaskTool.execute',
      'createWorkflowTool.execute', 'createAskUserTool.execute',
    ]);
    expect(tools.conditionalTools.map((row: { currentName: string }) => row.currentName)).toEqual([
      DEFERRED_MCP_TOOL_SEARCH_NAME, DEFERRED_MCP_TOOL_LOAD_NAME,
    ]);
    for (const row of tools.piStaticTools) {
      if (row.claudeBehaviorCounterpart === null) {
        expect(row.claudeCounterpartReason).toBeString();
      } else {
        expect(row.claudeBehaviorCounterpart).toBeString();
      }
    }
    expect(mcp.deferredLoading.searchTool).toBe(DEFERRED_MCP_TOOL_SEARCH_NAME);
    expect(mcp.deferredLoading.loadTool).toBe(DEFERRED_MCP_TOOL_LOAD_NAME);
    expect(mcp.deferredLoading.threshold).toBe(DEFAULT_DEFERRED_MCP_TOOL_THRESHOLD);
    expect(tools.dynamicMcp.bindingPattern).toBe('mcp__<sanitized-server>__<exact-sanitized-tool>');
  });

  test('compares effective availability with current registries, filters, and live builders', async () => {
    const tools = fixture<any>('tool-surface.json');
    // The ledger rows the DEFAULT (claude-runtime) projection does not carry.
    //
    // T12: five entries LEFT this set. `Monitor` and the four scheduling tools
    // were listed here under R2/R27b/R39 because the Monitor gate and the cron
    // service were bound on the Pi path — and T1/T2 generalized both, T3
    // projected all five onto claude-runtime, and T5 bridged them to codex.
    // The set kept its pre-T3 shape and this test failed with a diff of exactly
    // those five names, which is how the drift was found.
    //
    // P2.2: two more LEFT it, by the same mechanism and for the same shape of
    // reason. `session.goal_get`/`session.goal` were Pi-only because
    // `ctx.goalPort` was bound on the Pi path; the host now binds it for every
    // runtime in `SCHEDULED_DELIVERY_RUNTIMES`, Claude resolves it from the
    // per-session callback registry and Codex over the host-callback bridge —
    // so the goal is one objective a session keeps across a runtime switch
    // rather than a Pi construct. `session.task*` stayed, and stays as this
    // set's positive control: the projection filter still withholds something.
    //
    // The list stays LITERAL because it is a PIN: an unintended projection
    // change has to fail here. What keeps it from rotting into a stale belief
    // again is the row below, which measures the same split off the live
    // registry, per runtime, and compares.
    //
    // D1.174 — AND THIS LITERAL IS WHERE "PI-ONLY" LIVES, which a row once got
    // wrong in two ways at once, so the correction is recorded beside the thing
    // it is about rather than only in a commit message.
    //
    // That row asked for the surface to be re-pinned because the fixture "still
    // lists WorktreeBatch as a pi-only session tool". Measured, both halves were
    // wrong. There is exactly ONE `tool-surface.json` in this repo and it is the
    // one this test reads, under this directory's own `fixtures/`; the path the
    // row named, directly inside the package, does not exist. And no row of that
    // fixture carries a visibility field at all — `session.worktree_batch`'s
    // carries semanticId, currentName, finalPiName, bindingName, handlerName,
    // executionMode, safeMode, readOnly, permissionName and
    // claudeBehaviorCounterpart, and nothing in the file says "pi-only". So the
    // instrument the row prescribed writes NOTHING for this class: the re-pin
    // command covers the source-text digests, the drift was here, and running it
    // would have produced an empty commit.
    //
    // The name is written out rather than quoted as a `path:line` citation on
    // purpose: a correction that spells the dead anchor re-creates the finding
    // it is repairing (AGENTS.md §Traps).
    const piOnlySessionTools = new Set([
      'session.task',
      // R20: the four task tools are Pi-only, like the legacy `session.task`
      // they replace there.
      'session.task_create', 'session.task_update', 'session.task_get', 'session.task_list',
      // R2 said the worktree tools depend on the Pi permission gate's approval
      // floor, "the one reason of that era that T1/T2 did NOT remove, because
      // no host-side equivalent of the approval floor exists" — and P6.508 had
      // the batch fan-out inherit it. P6.799 measured that reason and REPLACED
      // it; C3.329 then acted on the replacement and the set is TWO names.
      //
      // The floor is host-side already: `evaluateWorktreeApproval` lives in
      // `packages/shared/src/agent/core/pre-tool-use.ts` and `claude-agent.ts`
      // routes every tool call through `runPreToolUseChecks`. Only its INPUT is
      // Pi-only (`worktreeGateContext()`, shared on `base-agent.ts`, one call
      // site in `pi-agent.ts`), and without that input the floor fails CLOSED —
      // `EnterWorktree` measured `block`, so a lift could never have shipped an
      // unguarded move on claude. Two of the three were never judged by it at
      // all: `ENTER_WORKTREE_TOOLS` holds only the `EnterWorktree` spellings,
      // and `ExitWorktree`/`WorktreeBatch` both measured `allow`, beside `Read`
      // as the control.
      //
      // `EnterWorktree`/`ExitWorktree` stay pi-only on NATIVE-FIRST grounds:
      // claude ships its own (declared in the vendored `sdk-tools.d.ts`) with
      // the floor documented as the runtime's own in `worktrees.md`, so ours
      // would be a second mechanism beside a working one.
      //
      // C3.329 (`b6b8e1be1`) LIFTED `session.worktree_batch` off this set, and
      // this pin MOVES with the contract rather than being relaxed to make a red
      // go away. The native-first refusal above is what argues FOR the lift
      // here: claude ships no batch counterpart at all, and the one it did ship
      // this fork switched OFF by its own hand (C3.326 `8d1b5f0ad`,
      // `skillOverrides { batch: 'off' }`, because the vendor's `/batch` opens a
      // pull request per unit) — so there is no second mechanism to create. The
      // family dependency is not real either: a batch never asks the MODEL to
      // enter anything, `SessionManager.runWorktreeBatch` enters each unit's
      // worktree HOST-side, per unit, over `createSessionWorktreePort(child)`.
      // Codex has no worktree surface at all and no `runPreToolUseChecks`, and
      // `visibility` is binary (`'pi-only' | 'not-pi'`), so the lift reaches it
      // too; the codex half of the FLOOR needs the shape P6.466 built for
      // `archive_session` and is a row of its own. Full reasoning and the
      // measurements: the comment above `EnterWorktree` in `tool-defs.ts`.
      'session.enter_worktree', 'session.exit_worktree',
      // R5: the MCP resource tools are Pi-runtime session tools, gated on a
      // resource-advertising source; not projected onto a standalone backend.
      'session.list_mcp_resources', 'session.read_mcp_resource',
      // R27a: the notification port is bound on the Pi path only, so projecting
      // it elsewhere would advertise a tool that can only answer "unavailable".
      'session.push_notification',
    ]);
    // T12 — the pin above against the LIVE per-runtime projection.
    //
    // `Task` is the documented carve-out: `NESSY_ENABLE_TASKS` makes the legacy
    // checklist pair and the four task tools mutually exclusive on Pi, so under
    // the default (task tools on) `Task` is on NEITHER surface and therefore
    // cannot appear in a difference of the two. It stays in the ledger set
    // because it is still Pi-only in the `NESSY_ENABLE_TASKS=0` shape the rows
    // further down exercise.
    const piProjection = getSessionToolNames({ projection: 'pi' });
    const claudeProjection = getSessionToolNames();
    expect(
      tools.sessionTools
        .filter((row: any) => piOnlySessionTools.has(row.semanticId))
        .map((row: any) => row.handlerName as string)
        .filter((name: string) => name !== 'Task')
        .sort(),
    ).toEqual([...piProjection].filter(name => !claudeProjection.has(name)).sort());
    // The other direction, which a pi-only list cannot state: the claude surface
    // carries exactly one name Pi's does not, and it is the legacy checklist
    // half — not a tool that quietly stopped being projected onto Pi.
    expect([...claudeProjection].filter(name => !piProjection.has(name))).toEqual(['TodoWrite']);
    // P3.276 — a THIRD category the pi-only/common split cannot express.
    //
    // `ReviewDiff` is `visibility: 'not-pi'` (Pi's own `review` tool computes
    // the same diff AND spawns the reviewer, so offering both would put two
    // tools in front of one model for one job) and it is gated a second time on
    // `reviewDiffPort`, a PER-SESSION host binding that `@nessy-agent/shared`
    // makes.
    //
    // Re-pinned 2026-09-03 (W2-p) for `36839ff94`, which moved that second gate
    // OUT of `getSessionToolDefs` and into the two surfaces that compute what is
    // ADVERTISED: the safe-mode classifier reads the same function with no
    // per-session facts, so leaving the gate there made it guess "unavailable"
    // and refuse a read-only diff in Explore (now plan) on every runtime. The DEFINITION is
    // therefore in the default defs list — subtracting it below was the
    // pre-`36839ff94` shape, and it is what reddened this row. It stays
    // subtracted from the PI projection, where the reason is `not-pi` and has
    // nothing to do with the port. Both facts are driven in the rows below.
    const notPiSessionTools = new Set(['session.review_diff', 'session.web_search']);
    // P6.148 — each gated tool has its OWN lifting option, because the gates
    // name different per-session facts: a bound diff port, and a claude session
    // whose native `WebSearch` is withheld. One flag lifting both would be the
    // two-lists-must-agree shape this file exists to catch.
    const liftingOptionFor: Record<string, Record<string, boolean>> = {
      ReviewDiff: { reviewDiffPort: true },
      web_search: { hostWebSearch: true },
    };
    const commonSessionRows = tools.sessionTools.filter((row: any) =>
      !piOnlySessionTools.has(row.semanticId));
    expect(getSessionToolDefs().map(row => row.name)).toEqual(commonSessionRows.map((row: any) => row.handlerName));

    // Both arms of the port gate, so "absent" above is a measurement and not a
    // filter that stopped running.
    const gatedHandlerNames = tools.sessionTools
      .filter((row: any) => notPiSessionTools.has(row.semanticId))
      .map((row: any) => row.handlerName as string);
    expect(gatedHandlerNames).toEqual(['web_search', 'ReviewDiff']);
    for (const name of gatedHandlerNames) {
      const lift = liftingOptionFor[name]!;
      expect(lift, `${name} has no lifting option`).toBeDefined();
      // Read through the ADVERTISED surface, not through `getSessionToolDefs`.
      // The port gate moved out of that function on purpose: it also feeds the
      // read-only (plan) mode classification, which is told nothing about a
      // per-session host binding and was refusing this tool everywhere.
      expect(getSessionToolNames().has(name), `${name} offered with no port`).toBe(false);
      expect(getSessionToolNames(lift).has(name), name).toBe(true);
      // `not-pi`: the port flag must not put it on the Pi surface either.
      expect(getSessionToolNames({ projection: 'pi', ...lift }).has(name), name).toBe(false);
      // It stays in the DEFINITIONS, which is what keeps the safe-mode
      // classification and the registry dispatch able to see it.
      expect(getSessionToolDefs().some(row => row.name === name), name).toBe(true);
    }
    // R20: `NESSY_ENABLE_TASKS` makes the legacy checklist pair and the four
    // task tools mutually exclusive on Pi, so the ledger's 46 rows are never all
    // projected at once. Default = task tools; `0` = the legacy pair.
    const legacyChecklist = new Set(['TodoWrite', 'Task']);
    const taskTools = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);
    const ledgerNames = tools.sessionTools
      .filter((row: any) => !notPiSessionTools.has(row.semanticId))
      .map((row: any) => row.handlerName as string);
    expect(getSessionToolDefs({ projection: 'pi' }).map(row => row.name))
      .toEqual(ledgerNames.filter((name: string) => !legacyChecklist.has(name)));
    const previousSwitch = process.env.NESSY_ENABLE_TASKS;
    process.env.NESSY_ENABLE_TASKS = '0';
    try {
      expect(getSessionToolDefs({ projection: 'pi' }).map(row => row.name))
        .toEqual(ledgerNames.filter((name: string) => !taskTools.has(name)));
    } finally {
      if (previousSwitch === undefined) delete process.env.NESSY_ENABLE_TASKS;
      else process.env.NESSY_ENABLE_TASKS = previousSwitch;
    }
    expect(getSessionToolDefs({ includeDeveloperFeedback: false }).some(row => row.name === 'send_developer_feedback')).toBe(false);

    const external = getSessionToolDefs({ externalStandaloneOnly: true });
    // P6.802 — the third term is `c324a0b8e`'s (P6.303): `externalStandaloneOnly`
    // IS the codex handshake, and a tool codex brings natively is withheld there
    // rather than offered twice. `TodoWrite` is the only member today. It is
    // deliberately a SET rather than a `visibility` value — claude keeps
    // `TodoWrite`, having no native equivalent — so this re-derivation has to
    // read the set, exactly as the filter it checks does.
    const expectedExternal = SESSION_TOOL_DEFS.filter(row => row.visibility !== 'pi-only' &&
      row.executionMode === 'registry' && !SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(row.name)
      && !SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT.has(row.name));
    expect(external.map(row => row.name)).toEqual(expectedExternal.map(row => row.name));
    expect([...SESSION_TOOLS_REQUIRING_HOST_CALLBACK]).toEqual(tools.availabilityAudit.hostCallbackExcludedNames);
    expect([...LEGACY_BROWSER_TOOL_ALIASES]).toEqual(tools.legacyBrowserAliases.names);
    expect(tools.legacyBrowserAliases.scope).toContain('none are Pi exact-dispatch aliases');
    expect(getPiToolBinding('find').permissionName).toBe('Find');
    expect(getPiToolBinding('ls').permissionName).toBe('Ls');
    expect(getPiToolBinding('bash').permissionName).toBe('Bash');
    expect(getPiToolBinding('bash_background').permissionName).toBe('Bash');

    const liveRuntimeNames = buildRuntimeBackedBuiltinToolDefinitions(repoRoot).map(tool => tool.name);
    expect(liveRuntimeNames).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'NotebookEdit']);
    expect(tools.piStaticTools.slice(0, liveRuntimeNames.length).map((row: any) => row.currentName)).toEqual(liveRuntimeNames);
    const searchProvider = { name: 'fixture', search: async () => [] };
    const liveAdditionalNames = [
      createSearchTool(searchProvider, searchProvider),
      createWebFetchTool(() => null),
      supervisedBackgroundTool(),
      createAskUserTool({ askUser: async () => ({ type: 'option', optionIndex: 0, value: 'fixture' }) }),
    ].map(tool => tool.name);
    const subagentSource = sourceAt('packages/pi-agent-server/src/orchestrator/subagent-tool.ts');
    const workflowSource = sourceAt('packages/pi-agent-server/src/orchestrator/workflow-tool.ts');
    const reviewSource = sourceAt('packages/pi-agent-server/src/orchestrator/review-tool.ts');
    expectOrderedMarkers(subagentSource, [
      'export function createSubagentTool', "name: 'subagent'",
      'export function createStopTaskTool', "name: 'stopTask'",
    ], 'subagent tool definitions');
    expectOrderedMarkers(workflowSource, [
      'export function createWorkflowTool', "name: 'workflow'",
    ], 'workflow tool definition');
    expectOrderedMarkers(reviewSource, [
      'export function createReviewTool', "name: 'review'",
    ], 'review tool definition');
    liveAdditionalNames.splice(3, 0, 'subagent', 'review', 'get_subagent_result', 'steer_subagent', 'stopTask', 'workflow');
    expect(liveAdditionalNames).toEqual([
      'web_search', 'web_fetch', 'bash_background', 'subagent', 'review', 'get_subagent_result',
      'steer_subagent', 'stopTask', 'workflow', 'ask_user',
    ]);
    expect(tools.piStaticTools.slice(liveRuntimeNames.length).map((row: any) => row.currentName))
      .toEqual(liveAdditionalNames);

    const proxyTool = (name: string) => ({
      name,
      label: name,
      description: `fixture ${name}`,
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text' as const, text: name }], details: {} }; },
    });
    const candidates = Array.from({ length: DEFAULT_DEFERRED_MCP_TOOL_THRESHOLD + 1 }, (_, index) =>
      proxyTool(`mcp__fixture__tool_${index}`));
    const sessionTool = proxyTool('mcp__session__remember');
    const loaded = new Set<string>();
    const loads: string[][] = [];
    const first = buildDeferredMcpToolSurface({
      enabled: true,
      proxyTools: [sessionTool, ...candidates] as any,
      loadedToolNames: loaded,
      onLoadToolNames: names => loads.push(names),
    });
    expect(first.enabled).toBe(true);
    expect(first.hiddenToolNames).toHaveLength(candidates.length);
    expect(first.tools.map(tool => tool.name)).toEqual([
      'mcp__session__remember', DEFERRED_MCP_TOOL_SEARCH_NAME, DEFERRED_MCP_TOOL_LOAD_NAME,
    ]);
    const loadTool = first.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_LOAD_NAME)!;
    const firstCandidate = candidates[0]!;
    await loadTool.execute('load-1', { name: firstCandidate.name } as any, new AbortController().signal, undefined, {} as never);
    expect(loads).toEqual([[firstCandidate.name]]);
    expect(first.tools.some(tool => tool.name === firstCandidate.name)).toBe(false);
    const next = buildDeferredMcpToolSurface({
      enabled: true,
      proxyTools: [sessionTool, ...candidates] as any,
      loadedToolNames: loaded,
    });
    expect(next.tools.some(tool => tool.name === firstCandidate.name)).toBe(true);
    // The count check now applies only to a caller that passes its own threshold.
    expect(buildDeferredMcpToolSurface({
      enabled: true,
      threshold: DEFAULT_DEFERRED_MCP_TOOL_THRESHOLD,
      proxyTools: candidates.slice(0, DEFAULT_DEFERRED_MCP_TOOL_THRESHOLD) as any,
      loadedToolNames: new Set(),
    }).enabled).toBe(false);
    // Absent an explicit threshold the manifest's decision rules, at any count:
    // the uncached-source case enables deferral precisely because the count is low.
    expect(buildDeferredMcpToolSurface({
      enabled: true,
      proxyTools: candidates.slice(0, 1) as any,
      loadedToolNames: new Set(),
    }).enabled).toBe(true);
  });

  test('pins exact-dispatch ordering, alias collisions, and browser projection', () => {
    const tools = fixture<any>('tool-surface.json');
    expect(tools.dispatchContract.selectedSource).toEqual({
      commit: 'a23abe4a695df8b69b613f73e9fdda2a8af894d4',
      path: 'packages/agent/src/agent-loop.ts',
      blobSha: 'd93458d0784950798853cb1d182a46f0248f68c1',
      url: 'https://github.com/earendil-works/pi/blob/a23abe4a695df8b69b613f73e9fdda2a8af894d4/packages/agent/src/agent-loop.ts',
      executionDisposition: 'Selected 0.87.1 is installed through the configured Artifactory and guarded by the fail-closed PiRuntimeAdapter VERSION/shape contract. The cited agent-loop blob is deliberately left at the 0.80.3 revision the ordered steps below were read from: U2 (2026-08-20) re-verified the public API surface against the installed 0.84.0 dist, not this upstream file, so promoting the reference would claim a reading that was not performed.',
    });
    expect(tools.dispatchContract.orderedSteps).toEqual([
      'exact lookup: currentContext.tools?.find(t => t.name === toolCall.name)',
      "unknown name: return createErrorToolResult('Tool <name> not found') with isError=true immediately",
      'prepareArguments(toolCall, tool)',
      'validateToolArguments(tool, preparedArgs)',
      'Pi beforeToolCall hook',
      'blocked or aborted hook result returns an immediate error result',
      'matched tool.execute(toolCall.id, validatedArgs, signal, onUpdate)',
      'stream tool updates',
      'Pi afterToolCall hook and final result rewrite',
    ]);
    expect(tools.dispatchContract.unknownNameReachability).toEqual({
      beforeToolCall: false,
      matchedExecute: false,
      nessyWrappedExecute: false,
      result: 'immediate isError tool result',
    });
    expect(tools.dispatchContract.ordinaryToolCallHookLimitation)
      .toContain('cannot create or rename an unknown tool');
    expect(tools.dispatchContract.requiredAliasPlacement).toContain('persisted Pi SDK transcript ingress');
    // The wire-name unification REWORKED this block rather than respelling it.
    // It used to pair `currentName` (the host bindingName) with `finalPiName`
    // (the model-facing piName) and lean on those two diverging — which is
    // exactly the divergence the unification removed for session tools. What
    // the block was always really about is the OTHER axis: a name a transcript
    // on disk may carry that is no longer the name Pi dispatches on. So the
    // pair is now `persistedName` -> `normalizedName`, and it is asserted
    // against the live ingress function instead of against a frozen belief.
    expect(tools.dispatchContract.historicalNameMappings.map((row: { semanticId: string }) => row.semanticId))
      .toEqual([
        ...PI_TOOL_BINDINGS
          .filter(binding => binding.bindingName.startsWith('mcp__session__')
            && binding.descriptorId !== binding.handlerName)
          .map(binding => `session.${binding.descriptorId}`),
        'notebook.edit', 'agent.stop_task',
      ]);
    for (const collision of tools.dispatchContract.historicalNameMappings) {
      expect(collision.persistedName).not.toBe(collision.normalizedName);
      expect(collision.collisionRule).toContain('distinct under exact equality');
      const [normalized] = normalizePiSdkToolCallRecordsV1([
        { content: [{ type: 'toolCall', name: collision.persistedName }] },
      ]) as Array<{ content: Array<{ name: string }> }>;
      expect(normalized!.content[0]!.name, collision.persistedName).toBe(collision.normalizedName);
    }
    expect(tools.dispatchContract.sharedPolicyMappingsThatAreNotAliases).toEqual([
      {
        policyName: 'Bash',
        dispatchNames: ['bash', 'bash_background'],
        reason: 'shared policy/display classification only; the exact dispatch names and handlers remain distinct',
      },
    ]);

    const browser = tools.sessionTools.find((row: { semanticId: string }) => row.semanticId === 'session.browser_tool');
    expect(browser.projectionDisposition).toContain('only when getBrowserToolEnabled()');
    expect(browser.projectionDisposition).toContain('never a Pi subprocess builtin');
    // P2.1's fix wave gave the advisor the same host gate, so the ledger states
    // it the same way — a backend tool whose projection is conditional must say
    // WHICH condition, or the ledger reads as "always advertised".
    const advisor = tools.sessionTools.find((row: { semanticId: string }) => row.semanticId === 'session.advisor_consult');
    expect(advisor.projectionDisposition).toContain('only when getAdvisorEnabled()');
    expect(advisor.projectionDisposition).toContain('never a Pi subprocess builtin');
    const agentSource = readFileSync(resolve(repoRoot, 'packages/shared/src/agent/pi-agent.ts'), 'utf8');
    // The backend set IS the exact-dispatch ordering, and it now carries comment
    // lines between its entries (P2.1 wrote six above `advisor_consult`). Read
    // the entries instead of one contiguous literal: a comment must not be able
    // to break this pin — and must not be able to hide a reordering either.
    const backendSetStart = agentSource.indexOf('export const PI_BACKEND_SESSION_TOOL_NAMES');
    expect(backendSetStart).toBeGreaterThan(-1);
    const backendSetBlock = agentSource.slice(backendSetStart, agentSource.indexOf(']);', backendSetStart));
    expect([...backendSetBlock.matchAll(/^ *'([a-z_]+)',$/gm)].map(match => match[1]))
      .toEqual(['call_llm', 'advisor_consult', 'spawn_session', 'browser_tool']);
    expect(agentSource).toContain("sessionToolDefs = sessionToolDefs.filter(definition => definition.name !== 'mcp__session__browser_tool')");
    expect(agentSource).toContain("sessionToolDefs = sessionToolDefs.filter(definition => definition.name !== 'mcp__session__advisor_consult')");
  });

  test('pins all MCP rows against the actual current client surface and runtime JSONL scenarios', () => {
    const mcp = fixture<any>('mcp-capabilities.json');
    const runtime = fixture<any>('runtime-behavior.json');

    expect(mcp.sdkVersion).toBe('@modelcontextprotocol/sdk@1.29.0');
    expect(mcp.runtimeProtocolVersion).toBe('2025-11-25');
    expect(mcp.supportedProtocolVersions).toEqual([
      '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07',
    ]);
    expect(mcp.protocolRows.map((row: { method: string }) => row.method)).toEqual([
      'tools/list', 'tools/call', 'resources/list', 'resources/read',
      'resources/subscribe', 'prompts/list', 'prompts/get', 'elicitation/create',
      'sampling/createMessage', 'pagination', 'cancellation', 'reconnect-cache', 'auth-consent',
      'same-turn-reveal',
    ]);
    for (const row of mcp.protocolRows) {
      for (const field of mcp.requiredRowFields) {
        expect(Object.prototype.hasOwnProperty.call(row, field), `${row.method}.${field}`).toBe(true);
      }
      expect(row.protocolVersion).toBe(mcp.runtimeProtocolVersion);
      for (const field of [
        'method', 'capability', 'current', 'owner', 'timeoutCancel', 'trustBoundary',
        'pagination', 'reconnect', 'cache', 'auth', 'consent', 'sameTurnReveal', 'futurePhase',
      ]) expect(row[field], `${row.method}.${field}`).toBeString();
      expect(Object.keys(row.h10Disposition)).toEqual(['H10A', 'H10B']);
      expect(row.h10Disposition.H10A.length).toBeGreaterThan(0);
      expect(row.h10Disposition.H10B.length).toBeGreaterThan(0);
    }

    // Re-pinned 2026-09-03 (W2-p) for `6acef70b7`, which gave every runtime the
    // half of a server's introduction that is not a tool name: `getInstructions`
    // joined BOTH the optional `PoolClient` surface and `NessyMcpClient`'s
    // prototype. Only the prototype row went red — this list and the fixture it
    // is compared against are both static, so the pair agreed while both were
    // wrong. The source loop below is what makes this list a reading.
    expect(mcp.currentClientSurface.PoolClient).toEqual([
      'listTools', 'callTool', 'close', 'setUnexpectedCloseHandler',
      'setCapabilitiesChangedHandler', 'setChannelHandler', 'notifyRootsChanged', 'listResources',
      // UB7.10 — the templates listing sits between its siblings in the interface.
      'listResourceTemplates', 'listPrompts',
      'readResource', 'getPrompt', 'getServerCapabilities', 'getInstructions',
    ]);
    expect(Object.getOwnPropertyNames(NessyMcpClient.prototype).filter(name => name !== 'constructor')).toEqual(
      mcp.currentClientSurface.NessyMcpClientPublicPrototype,
    );
    expect(mcp.currentClientSurface.absentPiHostMethods).toEqual([
      'resources/subscribe', 'prompts/list', 'sampling',
    ]);
    const mcpClientSource = sourceAt('packages/shared/src/mcp/client.ts');
    const poolInterface = mcpClientSource.slice(
      mcpClientSource.indexOf('export interface PoolClient'),
      mcpClientSource.indexOf('export class NessyMcpClient'),
    );
    for (const method of [
      'listTools()', 'callTool(', 'close()', 'setUnexpectedCloseHandler?(',
      'setCapabilitiesChangedHandler?(', 'setChannelHandler?(', 'notifyRootsChanged?()',
      // UB7.10 — `listResources` grew the cursor parameter too (the pool's page
      // walker follows `nextCursor`), so the marker spells the open paren, not
      // the parameterless call; the templates listing sits beside it.
      'listResources?(',
      'listResourceTemplates?(',
      // UB7.11 — `listPrompts` grew the cursor parameter (the pool's page walker
      // follows `nextCursor`); the marker spells the signature, not the bare name.
      'listPrompts?(cursor?: string):',
      'readResource?(', 'getPrompt?(', 'getServerCapabilities?(', 'getInstructions?(',
    ]) {
      expect(poolInterface).toContain(method);
    }
    for (const absent of ['subscribeResource', 'createMessage']) {
      expect(poolInterface).not.toContain(absent);
    }
    expect(mcpClientSource).toContain('? { elicitation: { form: {}, url: {} } }');
    expect(mcpClientSource).toContain('options.elicitationHandler!(request as ElicitRequest, extra.signal, {');
    const listStart = mcpClientSource.indexOf('async listTools()'); // F1.643/F1.665: ONE tolerant list path
    const listBlock = mcpClientSource.slice(listStart, mcpClientSource.indexOf('getServerInfo()', listStart));
    expect(listBlock).toContain('return this.requestTools();'); expect(listBlock).toContain('listToolsTolerantly(this.client)');
    const tolerant = mcpClientSource.slice(mcpClientSource.indexOf('export async function listToolsTolerantly'), mcpClientSource.indexOf('export function skippedToolsSummary'));
    expect((tolerant.match(/client\.request\(\{ method: 'tools\/list' \}/g) ?? [])).toHaveLength(1);
    expect(tolerant).not.toContain('nextCursor');
    const callStart = mcpClientSource.indexOf('async callTool(');
    const callEnd = mcpClientSource.indexOf('async close()', callStart);
    const callBlock = mcpClientSource.slice(callStart, callEnd);
    expect((callBlock.match(/client\.callTool\(/g) ?? [])).toHaveLength(1);
    expect(callBlock).toContain('signal?: AbortSignal');
    // The abort signal still reaches the SDK request options. It is no longer the
    // ONLY option there: P5 added the idle window, which needs all three of
    // `timeout` + `resetTimeoutOnProgress` + a registered progress handler, or
    // the SDK never attaches a progressToken and the window degrades into a plain
    // deadline that kills healthy long calls.
    expect(callBlock).toMatch(/callTool\(\{ name, arguments: args \}, undefined, \{\s*\n\s*signal,/);
    expect(callBlock).toContain('timeout: idleTimeoutMs');
    expect(callBlock).toContain('resetTimeoutOnProgress: true');
    expect(callBlock).toContain('onprogress:');
    expect(mcp.protocolRows.find((row: any) => row.method === 'same-turn-reveal').h10Disposition.H10A)
      .toStartWith('mandatory:');

    expect(runtime.scenarios.map((row: { id: string }) => row.id)).toEqual([
      'capability-turn', 'orchestrator-init', 'prompt-override', 'normal-proxy-approval',
      'call-llm-speculative-prefetch', 'abort', 'resume-compact', 'checkpoints',
      'subagents', 'workflow', 'background-shell', 'live-cwd', 'mcp-elicitation',
      'session-tools', 'permission-modes',
    ]);
    expect(runtime.jsonl.inbound).toContain('init');
    expect(runtime.jsonl.inbound).toContain('register_tools');
    expect(runtime.jsonl.outbound).toContain('pre_tool_use_request');
    expect(runtime.jsonl.outbound).toContain('tool_execute_request');
    expect(runtime.unstableFieldsExcluded).toEqual([
      'credentials',
      'private Claude prompt text',
      'timestamps',
      'random request/session/tool identifiers',
      'temporary absolute paths',
      'live provider responses',
    ]);
  });

  test('pins classified sources, all six mode goldens, and every R0 coverage area', () => {
    const runtime = fixture<any>('runtime-behavior.json');
    expect(runtime.referenceSources.map((row: { id: string }) => row.id)).toEqual([
      'pi-selected-official-tag', 'pi-selected-published-revision',
      'artifactory-pi-agent-core', 'artifactory-pi-ai', 'artifactory-pi-coding-agent',
      'pi-public-comparison', 'nessy-pi-harness', 'nessy-session-tool-registry',
      'nessy-capability-storage', 'nessy-adjacent-backends',
      'claude-code-public-tag', 'claude-code-public-npm', 'claude-code-local',
      'claude-desktop-local', 'claude-desktop-native-code-bundle',
      'claude-desktop-vm-sdk-version', 'exact-dispatch-before-wrapper',
    ]);
    expect(new Set(runtime.referenceSources.map((row: { classification: string }) => row.classification)))
      .toEqual(new Set(['DOC', 'LOCAL', 'NESSY', 'INFERENCE']));
    // The seven Pi-runtime rows are re-taken by every Pi bump: 2026-08-20 for
    // 0.80.3 → 0.84.0 (U2), 2026-09-03 for 0.84.0 → 0.84.2 (S0-3), 2026-09-11 for
    // 0.84.2 → 0.84.3 (W11-pi), 2026-09-13 for 0.84.3 → 0.84.4 (W19-z2), 2026-09-24 for 0.84.4 → 0.85.1 (WJ-lift, F1.255), 2026-10-10 for 0.85.1 → 0.87.1 (UA12.211). Everything
    // else still carries its X0 date. The remaining reference rows describe
    // Claude/Codex artifacts the Pi bump did not touch, so re-dating them would
    // claim a re-reading that never happened — which is also why the Claude SDK
    // bump landing beside this one moved none of them.
    const piRetrievedSourceIds = [
      'pi-selected-official-tag',
      'pi-selected-published-revision',
      'artifactory-pi-agent-core',
      'artifactory-pi-ai',
      'artifactory-pi-coding-agent',
      'nessy-pi-harness',
      'exact-dispatch-before-wrapper',
    ];
    expect(runtime.referenceSources
      .filter((row: { retrievedOn: string }) => row.retrievedOn === '2026-10-10')
      .map((row: { id: string }) => row.id))
      .toEqual(piRetrievedSourceIds);
    const piRetrievedSourceIdSet = new Set(piRetrievedSourceIds);
    for (const source of runtime.referenceSources) {
      expect(['DOC', 'LOCAL', 'NESSY', 'INFERENCE']).toContain(source.classification);
      for (const field of ['url', 'revision', 'retrievedOn', 'license', 'runtime', 'attribution']) {
        expect(source[field], `${source.id}.${field}`).toBeString();
        expect(source[field].length, `${source.id}.${field}`).toBeGreaterThan(0);
      }
      // The Pi-retrieved group shares ONE date, re-taken whenever the Pi pin moves:
      // W11-pi lifted 0.84.2 → 0.84.3 on 2026-09-11, W19-z2 0.84.3 → 0.84.4 on 2026-09-13
      // (C3.380 lift 3), WJ-lift 0.84.4 → 0.85.1 on 2026-09-24 (F1.255) and UA12.211
      // 0.85.1 → 0.87.1 on 2026-10-10, each re-reading every Pi fact in that group —
      // via a registry packument's `gitHead`, one shared value per release:
      // `f07218c4…` at 0.87.1 (six members read), `d981de12…` at 0.85.1 (eight), `b79e4cc8…` at 0.84.4.
      // `nessy-pi-harness` moves with them because its `runtime` field carries
      // the installed Pi version; its `revision` still names the X0 phase base
      // and is deliberately unchanged — the date is when the PI facts were read.
      expect(source.retrievedOn).toBe(piRetrievedSourceIdSet.has(source.id) ? '2026-10-10' : '2026-07-14');
    }
    expect(runtime.referenceSources.find((row: { id: string }) => row.id === 'pi-selected-official-tag').revision)
      .toBe('v0.87.1/f07218c4d4bbc12bef056a7058c3dd49dfe41abe');
    expect(runtime.referenceSources.find((row: { id: string }) => row.id === 'exact-dispatch-before-wrapper').classification)
      .toBe('INFERENCE');
    expect(runtime.referenceSources.find((row: { id: string }) => row.id === 'claude-code-public-tag').revision)
      .toBe('v2.1.207/d4d8fbbb333c627d8fe2c1c583a5ccc26fdb1aed');
    const claudeNpm = runtime.referenceSources.find((row: { id: string }) => row.id === 'claude-code-public-npm');
    expect(claudeNpm.revision).toContain('gitHead not declared');
    expect(claudeNpm.license).toBe('SEE LICENSE IN README.md');
    expect(claudeNpm.runtime).toBe('Node >=22.0.0');
    expect(runtime.referenceSources.find((row: { id: string }) => row.id === 'claude-desktop-native-code-bundle').revision)
      .toBe('2.1.205 (Claude Code)');
    expect(runtime.referenceSources.find((row: { id: string }) => row.id === 'claude-desktop-vm-sdk-version').revision)
      .toBe('2.1.197');
    expect(runtime.claudeDesktopPublicArtifactDisposition).toContain('No independently published public Claude Desktop version artifact');

    expect(runtime.officialReferenceGroups.map((group: { id: string }) => group.id)).toEqual([
      'official-claude-docs', 'official-codex-docs',
    ]);
    for (const group of runtime.officialReferenceGroups) {
      expect(group.classification).toBe('DOC');
      expect(group.retrievedOn).toBe('2026-07-14');
      for (const field of ['revision', 'license', 'runtime', 'attribution']) {
        expect(group[field], `${group.id}.${field}`).toBeString();
      }
      expect(group.urls.length).toBeGreaterThan(0);
      for (const url of group.urls) expect(url, group.id).toMatch(/^https:\/\//);
    }
    expect(runtime.officialReferenceGroups[0].urls).toEqual([
      'https://code.claude.com/docs/en/agent-sdk/agent-loop',
      'https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts',
      'https://code.claude.com/docs/en/tools-reference',
      'https://code.claude.com/docs/en/permissions',
      'https://code.claude.com/docs/en/permission-modes',
      'https://code.claude.com/docs/en/sandboxing',
      'https://code.claude.com/docs/en/hooks',
      'https://code.claude.com/docs/en/mcp',
      'https://code.claude.com/docs/en/skills',
      'https://code.claude.com/docs/en/sub-agents',
      'https://code.claude.com/docs/en/agent-teams',
      'https://code.claude.com/docs/en/workflows',
      'https://code.claude.com/docs/en/memory',
      'https://code.claude.com/docs/en/context-window',
      'https://code.claude.com/docs/en/prompt-caching',
      'https://code.claude.com/docs/en/sessions',
      'https://code.claude.com/docs/en/agent-sdk/sessions',
      'https://code.claude.com/docs/en/checkpointing',
      'https://code.claude.com/docs/en/agent-view',
      'https://code.claude.com/docs/en/agent-sdk/todo-tracking',
      'https://code.claude.com/docs/en/monitoring-usage',
      'https://code.claude.com/docs/en/security',
    ]);
    expect(runtime.officialReferenceGroups[1].urls).toEqual([
      'https://learn.chatgpt.com/docs/app-server',
      'https://learn.chatgpt.com/docs/open-source',
      'https://learn.chatgpt.com/docs/agent-approvals-security',
      'https://learn.chatgpt.com/docs/agent-configuration/subagents',
      'https://learn.chatgpt.com/docs/config-file/config-basic',
    ]);

    expect(runtime.reuseIntake.map((row: { id: string }) => row.id)).toEqual([
      'pi-extension-api', 'pi-anthropic-provider-adapter', 'pi-native-skills',
      'pi-sandbox-example', 'pi-containerization-guide', 'masurii-pi-permission-system',
      'gotgenes-pi-permission-system', 'pi-subagent-example', 'mjakl-pi-subagent',
      'tintinweb-pi-subagents', 'nicobailon-pi-subagents', 'tintinweb-pi-tasks',
      'nicobailon-pi-mcp-adapter', 'samfoy-pi-lsp-extension', 'spences10-pi-lsp',
      'pi-extension-events', 'spences10-my-pi', 'spences10-pi-telemetry',
      'pi-git-checkpoint', 'arpagon-pi-rewind', 'gotgenes-pi-subagents-worktrees',
      'pi-background-process-readme', 'injaneity-pi-computer-use',
    ]);
    for (const row of runtime.reuseIntake) {
      for (const field of runtime.reuseIntakeRequiredFields) {
        expect(row[field], `${row.id}.${field}`).toBeString();
        expect(row[field].length, `${row.id}.${field}`).toBeGreaterThan(0);
      }
      expect(row.retrievedOn).toBe('2026-07-14');
      expect(row.url).toMatch(/^https:\/\//);
    }
    expect(runtime.thirdPartySourceCopiedInR0).toBe(false);

    expect(runtime.modeGoldenBehavior.map((row: { mode: string }) => row.mode)).toEqual(PERMISSION_MODE_ORDER);
    // Mode descriptions are single-sourced from the i18n `en` locale's
    // `mode.<canonical>FullDesc` keys (PERMISSION_MODE_CONFIG carries structure
    // only); the golden rows freeze the same English words as before.
    const enMessages = LOCALE_REGISTRY.en.messages as Record<string, string>;
    for (const row of runtime.modeGoldenBehavior) {
      const canonical = PERMISSION_MODE_TO_CANONICAL[row.mode as keyof typeof PERMISSION_MODE_TO_CANONICAL];
      expect(row.canonical).toBe(canonical);
      expect(row.evidence).toBe(`i18n:mode.${canonical}FullDesc`);
      expect(row.description).toBe(enMessages[`mode.${canonical}FullDesc`]);
    }
    expect(runtime.goldenCoverage.map((row: { area: string }) => row.area)).toEqual([
      'source-provenance', 'pi-version-exports', 'exact-dispatch-aliases',
      'tool-model-binding-handler-codecs', 'prompt-override',
      'hooks-permissions-transcript', 'call-llm-execution',
      'browser-source-automation-projection', 'permission-modes', 'mcp-protocol',
      'session-jsonl', 'resume-compaction', 'checkpoints-cwd',
      'foreground-background-process', 'subagents', 'workflow', 'capability-storage',
      'adjacent-backends', 'offline-isolation', 'p0-defect-register',
    ]);
    for (const row of runtime.goldenCoverage) expect(row.evidence).toBeString();
  });

  test('pins independently reproducible Claude, Codex, and Pi reference metadata', () => {
    const runtime = fixture<any>('runtime-behavior.json');
    const references = new Map<string, any>(
      runtime.referenceSources.map((row: { id: string }) => [row.id, row] as const),
    );

    expect(references.get('pi-selected-official-tag')?.revision)
      .toBe('v0.87.1/f07218c4d4bbc12bef056a7058c3dd49dfe41abe');
    expect(references.get('claude-code-public-tag')?.revision)
      .toBe('v2.1.207/d4d8fbbb333c627d8fe2c1c583a5ccc26fdb1aed');
    expect(references.get('claude-code-public-npm')).toMatchObject({
      revision: '2.1.207; shasum 9401101d42487b7e82d4632243c1a0485641c2fa; gitHead not declared',
      license: 'SEE LICENSE IN README.md',
      runtime: 'Node >=22.0.0',
    });
    expect(references.get('claude-code-local')?.revision).toBe('2.1.197');
    expect(references.get('claude-desktop-local')?.revision).toBe('1.20186.1');
    expect(references.get('claude-desktop-native-code-bundle')?.revision).toBe('2.1.205 (Claude Code)');
    expect(runtime.claudeDesktopPublicArtifactDisposition)
      .toContain('No independently published public Claude Desktop version artifact');

    for (const group of runtime.officialReferenceGroups) {
      expect(group.id).toBeString();
      expect(group.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(group.revision).toBeString();
      expect(group.license).toBeString();
      expect(group.runtime).toBeString();
      expect(group.attribution).toBeString();
      expect(group.urls.length, `${group.id}.urls`).toBeGreaterThan(0);
      for (const url of group.urls) expect(() => new URL(url), `${group.id}.${url}`).not.toThrow();
    }
  });

  test('executes golden event and prompt producers with ordered source contracts', async () => {
    const runtime = fixture<any>('runtime-behavior.json');
    expect(runtime.goldenBaselines.map((row: { id: string }) => row.id)).toEqual([
      'event-order', 'prompt-sections-and-tool-availability',
      'normal-permission-approval-order', 'six-permission-modes', 'abort',
      'resume-compact', 'checkpoints', 'subagents', 'workflow', 'foreground-process',
      'background-process', 'live-cwd', 'mcp-elicitation', 'bash-output',
      'spawn-session', 'send-agent-message', 'script-sandbox',
    ]);
    for (const row of runtime.goldenBaselines) {
      expect(row.execution, `${row.id}.execution`).toBeString();
      expect(typeof row.input, `${row.id}.input`).toBe('object');
      expect(typeof row.expected, `${row.id}.expected`).toBe('object');
      expect(row.sourceAnchors.length, `${row.id}.sourceAnchors`).toBeGreaterThan(0);
      for (const anchor of row.sourceAnchors) {
        const [path, symbol] = anchor.split('#');
        const source = sourceAt(path);
        expect(source.length, anchor).toBeGreaterThan(0);
        if (symbol) expect(source, anchor).toContain(symbol);
      }
    }

    const eventGolden = runtime.goldenBaselines.find((row: any) => row.id === 'event-order');
    const eventAdapter = new PiEventAdapter();
    eventAdapter.startTurn('golden-turn');
    const emitted = [
      ...eventAdapter.adaptEvent({ type: 'turn_start' } as any),
      ...eventAdapter.adaptEvent({ type: 'message_start' } as any),
      ...eventAdapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: eventGolden.input.delta },
      } as any),
      ...eventAdapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: eventGolden.input.final },
      } as any),
      ...eventAdapter.adaptEvent({ type: 'turn_end' } as any),
      ...eventAdapter.adaptEvent({ type: 'agent_end' } as any),
    ];
    expect(emitted.map(event => event.type)).toEqual(eventGolden.expected.emittedSequence);
    expect(emitted[0]).toMatchObject({ type: 'text_delta', text: 'Hello' });
    expect(emitted[1]).toMatchObject({ type: 'text_complete', text: 'Hello' });
    expect(emitted[2]).toMatchObject({ type: 'complete' });

    const promptGolden = runtime.goldenBaselines.find((row: any) => row.id === 'prompt-sections-and-tool-availability');
    const prompt = getSystemPrompt(
      '', undefined, undefined, undefined, undefined, 'Pi', false,
      undefined, undefined, undefined, undefined, true,
    );
    for (const section of promptGolden.expected.promptSections) expect(prompt).toContain(section);
    expect(promptGolden.expected.privatePromptText).toBe('excluded');
    const promptRuntimeTools = buildRuntimeBackedBuiltinToolDefinitions(repoRoot);
    expect(promptRuntimeTools.map(tool => tool.name)).toEqual(promptGolden.expected.runtimeTools);
    for (const tool of promptRuntimeTools) {
      expect(tool.promptSnippet, `${tool.name}.promptSnippet`).toBeString();
      expect(tool.parameters, `${tool.name}.parameters`).toBeDefined();
    }
    expect(getSessionToolDefs({ includeDeveloperFeedback: false }).some(row => row.name === 'send_developer_feedback'))
      .toBe(promptGolden.expected.feedbackAdvertised);
    const serverSource = sourceAt('packages/pi-agent-server/src/index.ts');
    const definitionStart = serverSource.indexOf('function buildSessionDefinition');
    const definitionEnd = serverSource.indexOf('\nasync function ensureSession', definitionStart);
    const definitionBlock = serverSource.slice(definitionStart, definitionEnd);
    expectOrderedMarkers(definitionBlock, [
      'const webTools', 'const builtinDefs', 'const proxyTools = buildProxyTools(backgroundTasks)',
      'const orchestratorTools', 'const wrappedAll = adaptTools',
      'customTools: wrappedAll', 'tools: wrappedAll.map(tool => tool.name)',
    ], 'prompt/tool assembly');
    const ensureStart = serverSource.indexOf('async function ensureSession');
    const ensureEnd = serverSource.indexOf('\nfunction handleSessionEvent', ensureStart);
    const ensureBlock = serverSource.slice(ensureStart, ensureEnd);
    // UPDATED 2026-08-21 (T7): the single `runtimeAdapter.createSession` call
    // became a `createWithStrategy` closure so a carry fork that throws can
    // retry once as a plain resume instead of taking the session down. The
    // marker follows the construction, not the spelling that preceded it.
    expectOrderedMarkers(ensureBlock, [
      'const config = initConfig', 'const cwd = resolvedCwd(config)',
      'const definition = buildSessionDefinition(',
      'const createWithStrategy = (chosen: PiRuntimeSessionStrategy) => runtimeAdapter.createSession',
    ], 'prompt/tool runtime construction');
    expect(promptGolden.expected.assemblySequence).toEqual([
      'webTools', 'builtinDefs', 'proxyTools', 'orchestratorTools',
      'adaptTools', 'customTools', 'tools',
    ]);
  });

  test('pins golden approval, modes, abort, resume, and compact ordering', () => {
    const runtime = fixture<any>('runtime-behavior.json');
    const normal = runtime.goldenBaselines.find((row: any) => row.id === 'normal-permission-approval-order');
    expect(normal.expected.sequence).toEqual([
      'canonical subject/check', 'PiPermissionService decision/receipt',
      'child strict parse/replay guard', 'ToolExecutor permissionBridge',
      'scheduler.run', 'X4A isolation/dispatch', 'buildProxyTools.execute',
      'pendingToolExecutions.set', 'tool_execute_request', 'handleToolExecuteResponse',
      'pending.resolve(msg.result)', 'bounded receipt/result',
    ]);
    const serverSource = sourceAt('packages/pi-agent-server/src/index.ts');
    const wrapperSource = sourceAt('packages/pi-agent-server/src/local-tools/tool-wrapper.ts');
    const executorSource = sourceAt('packages/shared/src/agent/pi-harness/tool-executor.ts');
    expect(serverSource).toContain('async permissionBridge(request, canonicalInput)');
    expect(serverSource).toContain('const rawReceipt = await requestPiPermissionReceipt(');
    expect(serverSource).toContain('const receipt = parseAndFreezePiPermissionReceipt(rawReceipt, {');
    expect(serverSource).toContain('consumedPermissionDecisionIds.add(receipt.decisionId)');
    const wrapperStart = wrapperSource.indexOf('const wrappedExecute');
    const wrapperEnd = wrapperSource.indexOf('return { ...tool', wrapperStart);
    const wrapperBlock = wrapperSource.slice(wrapperStart, wrapperEnd);
    expect(wrapperBlock).toContain('await deps.toolExecutor.execute({');
    expect(wrapperBlock).not.toContain('requestPiPermissionReceipt');
    expectOrderedMarkers(executorSource, [
      'canonicalInput = port.canonicalize(request.canonicalInput, request)',
      'permissionBridge(request, canonicalInput)',
      'canonicalInput = port.canonicalize(decision.canonicalInput ?? canonicalInput, request)',
      'await scheduler.run(descriptor',
    ], 'canonicalize, one permission decision, and scheduled dispatch');
    expect((executorSource.match(/permissionBridge\(request, canonicalInput\)/g) ?? [])).toHaveLength(1);
    const proxyStart = serverSource.indexOf('function buildProxyTools');
    const proxyEnd = serverSource.indexOf('\nfunction ', proxyStart + 1);
    const proxyBlock = serverSource.slice(proxyStart, proxyEnd > proxyStart ? proxyEnd : undefined);
    expectOrderedMarkers(proxyBlock, [
      'const resultPromise = new Promise<ProxyExecutionResult>',
      'const pending:',
      'if (signal)',
      "type: 'tool_execute_cancel'",
      "signal.addEventListener('abort', abort, { once: true })",
      'pendingToolExecutions.set(requestId, pending)',
      "type: 'tool_execute_request'",
      'proxyExecutionResultToAgentToolResult(await resultPromise)',
    ], 'approved proxy execution request');
    expect(proxyBlock).not.toContain('requestPiPermissionReceipt(');
    const responseStart = serverSource.indexOf('function handleToolExecuteResponse');
    const responseEnd = serverSource.indexOf('\nfunction ', responseStart + 1);
    const responseBlock = serverSource.slice(responseStart, responseEnd > responseStart ? responseEnd : undefined);
    expectOrderedMarkers(responseBlock, [
      "type: 'tool_execute_response'",
      'pendingToolExecutions.get(msg.requestId)',
      'pendingToolExecutions.delete(msg.requestId)',
      'pending.resolve(msg.result)',
    ], 'tool execution response resolution');
    const processStart = serverSource.indexOf('async function processMessage');
    const processEnd = serverSource.indexOf('\nasync function ', processStart + 1);
    const processBlock = serverSource.slice(processStart, processEnd > processStart ? processEnd : undefined);
    expectOrderedMarkers(processBlock, [
      "case 'tool_execute_response':",
      'handleToolExecuteResponse(msg)',
    ], 'tool execution response dispatch');

    const modeGolden = runtime.goldenBaselines.find((row: any) => row.id === 'six-permission-modes');
    expect([...PERMISSION_MODE_ORDER]).toEqual(modeGolden.input.modes);
    expect(PERMISSION_MODE_ORDER.map(mode => PERMISSION_MODE_TO_CANONICAL[mode]))
      .toEqual(modeGolden.expected.canonical);

    const abortGolden = runtime.goldenBaselines.find((row: any) => row.id === 'abort');
    const abortStart = serverSourceAt('async function handleAbort');
    const abortEnd = serverSourceAt('async function handleMiniCompletion');
    const abortBlock = sourceAt('packages/pi-agent-server/src/index.ts').slice(abortStart, abortEnd);
    expectOrderedMarkers(abortBlock, [
      'await piSession.abort()',
      "clearPendingPreToolUse('Aborted')",
      'for (const [, pending] of pendingAskUser)',
      'pendingAskUser.clear()',
    ], 'abort handler');
    const clearStart = serverSource.indexOf('function clearPendingPreToolUse');
    const clearEnd = serverSource.indexOf('\n}', clearStart) + 2;
    const clearBlock = serverSource.slice(clearStart, clearEnd);
    expectOrderedMarkers(clearBlock, [
      'for (const [, pending] of pendingPreToolUse)',
      'pendingPreToolUse.clear()',
    ], 'pending approval cleanup');
    expect(abortGolden.expected.handlerSequence).toEqual([
      'piSession.abort', 'block and clear pending approvals',
      'reject pending ask_user', 'clear pending ask_user',
    ]);
    const dispatchStart = serverSourceAt('async function processMessage');
    const dispatchBlock = sourceAt('packages/pi-agent-server/src/index.ts').slice(dispatchStart);
    expectOrderedMarkers(dispatchBlock, ["case 'abort':", 'await handleAbort()'], 'abort dispatch');

    const resumeGolden = runtime.goldenBaselines.find((row: any) => row.id === 'resume-compact');
    const ensureStart = serverSourceAt('async function ensureSession');
    const ensureEnd = serverSourceAt('function handleSessionEvent');
    const ensureBlock = sourceAt('packages/pi-agent-server/src/index.ts').slice(ensureStart, ensureEnd);
    // UPDATED 2026-08-21 (T7 of the cross-runtime-history-carry plan). A THIRD
    // arm now sits between the branch fork and the plain resume: a first
    // cross-runtime switch INTO Pi forks the host's synthesized carry file.
    // The markers pin the two properties that make that arm safe — it is
    // reached only when Pi has NO session of its own in this directory
    // (`!findMostRecentSessionFile(sessionDir)`, the anchor rule enforced
    // where it cannot be argued with), and the outcome is REPORTED to the host
    // rather than assumed, so a decline or a failed fork leaves the armed text
    // handoff to deliver instead.
    expectOrderedMarkers(ensureBlock, [
      'const config = initConfig', 'let agentDir',
      "let strategy: PiRuntimeSessionStrategy = { kind: 'memory' }",
      'let carriedHistory = false',
      'if (config.sessionPath)', 'mkdirSync(agentDir',
      "const sessionDir = join(config.sessionPath, '.pi-sessions')",
      'mkdirSync(sessionDir', 'if (config.branchFromSessionPath && !findMostRecentSessionFile(sessionDir))', // F1.1291: the branch forks once
      'findMostRecentSessionFile(parentPiSessionDir)', "kind: 'fork'",
      'anchorEntryId: config.branchFromSdkTurnId',
      'config.carryHistorySessionFile && !findMostRecentSessionFile(sessionDir)',
      'parentSessionFile: config.carryHistorySessionFile',
      'carriedHistory = true',
      "kind: 'continue'",
      'const createWithStrategy = (chosen: PiRuntimeSessionStrategy) => runtimeAdapter.createSession',
      'runtimeHandle = await createWithStrategy(strategy)',
      'carriedHistory = false',
      "runtimeHandle = await createWithStrategy({ kind: 'continue', sessionDir: strategy.sessionDir })",
      'carriedHistory ? { carriedHistory: true } : {}',
    ], 'resume/branch/carry state transitions');
    expect(resumeGolden.expected.resumeSequence).toEqual([
      'create isolated agentDir', 'create .pi-sessions directory',
      'branch via forkFrom, carry via forkFrom, or resume via continueRecent',
      'install sessionManager through PiRuntimeAdapter',
      'report whether the carry file was forked',
    ]);
    const compactStart = serverSourceAt('async function handleCompact');
    const compactEnd = serverSourceAt('async function handleSetAutoCompaction');
    const compactBlock = sourceAt('packages/pi-agent-server/src/index.ts').slice(compactStart, compactEnd);
    expectOrderedMarkers(compactBlock, [
      'const session = await ensureSession()', 'const handle = runtimeHandle',
      'if (!handle || handle.session !== session)',
      // Re-pinned 2026-10-16 (UB12.5) for `d2d43e37d` (UB2.3), which capped the
      // wait under the host's RPC deadline: the marker keeps the cap's argument,
      // and F1.352's epoch check follows it, so a Stop taken during the wait
      // never starts the compaction.
      'await waitForCompaction(session, { timeoutMs: MANUAL_COMPACT_WAIT_MS',
      "if (epoch !== compactionEpoch) throw new Error('Compaction cancelled')",
      // Re-pinned 2026-09-03 (W2-p) for `413354e4b`, which wrapped the argument
      // in `withProjectCompactSteering` and so split this call across lines.
      // Two markers rather than a truncated one: the first keeps the ordering
      // claim, the second keeps what the old single marker actually asserted —
      // that the caller's own `customInstructions` still reach the call.
      'const result = await handle.compact(',
      'withProjectCompactSteering(msg.customInstructions',
      'lastCompaction = {',
      'const contextUsage = buildContextUsageSnapshot', "type: 'compact_result'",
      "event: { type: 'context_usage_update'",
    ], 'compact state transitions');
    expect(compactBlock).not.toContain('await session.compact(');
    expect(resumeGolden.expected.compactSequence).toEqual([
      'ensureSession', 'validate active runtime handle', 'waitForCompaction',
      'runtimeHandle.compact', 'capture lastCompaction',
      'build context usage', 'compact_result', 'context_usage_update',
    ]);
  });

  test('executes golden checkpoints and pins subagent normalization branches', async () => {
    const runtime = fixture<any>('runtime-behavior.json');
    const checkpointGolden = runtime.goldenBaselines.find((row: any) => row.id === 'checkpoints');
    expect(checkpointGolden.expected.operations).toEqual([
      'createFileCheckpoint', 'listFileCheckpoints', 'revertFileCheckpoint',
    ]);
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'nessy-r0-checkpoint-'));
    try {
      const sessionPath = join(checkpointRoot, 'session');
      const target = join(checkpointRoot, checkpointGolden.input.path);
      mkdirSync(sessionPath, { recursive: true });
      writeFileSync(target, checkpointGolden.input.before);
      const created = await createFileCheckpoint({
        adapter: 'file',
        sessionPath, toolName: 'write', toolCallId: 'golden-write', input: { path: target },
      });
      writeFileSync(target, checkpointGolden.input.after);
      await finalizeFileCheckpoint({ sessionPath, checkpointId: created[0]!.id, succeeded: true });
      const listed = await listFileCheckpoints(sessionPath);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: created[0]!.id, adapter: 'file', conflict: false });
      const reverted = await revertFileCheckpoint({ sessionPath, checkpointId: created[0]?.id });
      expect(reverted).toMatchObject({ success: true, restored: true, filePath: target });
      expect(readFileSync(target, 'utf8')).toBe(checkpointGolden.expected.restored);
    } finally {
      rmSync(checkpointRoot, { recursive: true, force: true });
    }

    const subagentGolden = runtime.goldenBaselines.find((row: any) => row.id === 'subagents');
    const subagentSource = sourceAt('packages/pi-agent-server/src/orchestrator/subagent-tool.ts');
    const normalizeSource = subagentSource.slice(
      subagentSource.indexOf('export function normalizeSubagentRequest'),
      subagentSource.indexOf('export function applyPreviousSubstitution'),
    );
    expectOrderedMarkers(normalizeSource, [
      "const hasSingle = typeof params.agent === 'string' || typeof params.task === 'string'",
      'const hasParallel = params.tasks !== undefined',
      'const hasChain = params.chain !== undefined',
      'const hasResume = params.resume !== undefined',
      "return { mode: 'resume', tasks: [], resumeAgentId: params.resume.trim(), resumeInput: params.input }",
      "return { mode: 'single', tasks: [asTask(params, 'single task')] }",
      "return { mode: 'parallel', tasks: params.tasks.map",
      "return { mode: 'chain', tasks: params.chain.map",
    ], 'subagent normalization branches');
    // Chain substitution defangs child A's text before it becomes part of child
    // B's task prompt — the sink is higher-authority than a parent-facing return.
    expect(subagentSource).toContain("return task.replaceAll('{previous}', scanSubagentOutput(previous))");
    expect(subagentGolden.expected.modes).toEqual(['single', 'parallel', 'chain', 'resume']);
    expect(subagentGolden.expected.substitution).toBe('use result');
  });

  test('executes the golden workflow sandbox and pins tool state transitions without touching repo state', async () => {
    const runtime = fixture<any>('runtime-behavior.json');
    const workflowGolden = runtime.goldenBaselines.find((row: any) => row.id === 'workflow');
    const repoOrchestratorPath = join(repoRoot, '.orchestrator');
    const repoOrchestratorBefore = snapshotTree(repoOrchestratorPath);
    const logs: string[] = [];
    const phases: string[] = [];
    const returnValue = await compileWorkflowScript(workflowGolden.input.script)({
      agent: async () => undefined,
      workflow: async () => undefined,
      parallel: async thunks => Promise.all(thunks.map(thunk => thunk())),
      pipeline: async items => items,
      phase: title => { phases.push(title); return title; },
      log: message => { logs.push(message); return message; },
      args: workflowGolden.input.args,
      budget: { spent: () => 0, remaining: () => undefined },
    });
    expect(returnValue).toBe(workflowGolden.expected.returnValue);
    expect(logs).toEqual(workflowGolden.expected.logs);
    expect(phases).toEqual(['first']);
    expect(snapshotTree(repoOrchestratorPath)).toBe(repoOrchestratorBefore);
    const workflowSource = sourceAt('packages/pi-agent-server/src/orchestrator/workflow-tool.ts');
    const workflowExecute = workflowSource.slice(workflowSource.indexOf('async execute(toolCallId'));
    // R4 Task 3 split compile from invocation so a syntax-invalid script
    // returns a structured `{error}` result instead of throwing after the
    // launch was accepted. The ordered sequence is unchanged; the compile step
    // is now two markers instead of one.
    expectOrderedMarkers(workflowExecute, [
      'const input = normalizeInput(params)', 'const journal = new WorkflowJournal',
      'const makeApi', 'compiledScript = compileWorkflowScript(script)',
      'await compiledScript(makeApi(input.args',
      'const result = toResultPayload',
    ], 'workflow state transitions');
    expect(workflowGolden.expected.sourceSequence).toEqual([
      'normalize input', 'create journal', 'make API', 'compile script', 'build result',
    ]);
    expect(workflowSource).toContain('new WorkflowJournal(options.getSessionPath?.(), runId, input.resumeRunId)');
    expect(workflowGolden.expected.status).toBe('done');
  });

  test('executes golden foreground and background process contracts', async () => {
    const runtime = fixture<any>('runtime-behavior.json');
    const foregroundGolden = runtime.goldenBaselines.find((row: any) => row.id === 'foreground-process');
    const executionManifest = testExecutionManifest();
    const sessionKey = executionManifest.sessionKey;
    const manifestIdentity = {
      generation: executionManifest.snapshotGeneration,
      manifestHash: executionManifest.manifestHash,
      responseEpoch: 1,
    };
    const foregroundCalls: any[] = [];
    let foregroundIsolationProfile: string | undefined;
    const authorizedRuntime = new LocalToolRuntime({
      filesystemScope: {
        session: { workspaceId: 'workspace-test', sessionId: 'session-test' },
        primaryRoot: repoRoot,
        cwd: repoRoot,
        additionalRoots: [],
        managedExclusions: [],
        generation: 'g-test',
      },
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
      guardLargeResults: false,
      runCommand: async (command, cwd, options) => {
        foregroundCalls.push({
          command,
          cwd,
          timeout: options?.timeout,
          signal: options?.signal,
          semanticId: options?.semanticId,
          isolationProfile: options?.isolationProfile,
        });
        return {
          stdout: 'fixture',
          stderr: '',
          exitCode: 0,
          isolationProfile: options?.isolationProfile,
        };
      },
    });
    const toolExecutor = createToolExecutor({
      runtime: authorizedRuntime,
      ports: buildRuntimeBackedToolExecutionPorts(repoRoot),
      authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
      permissionBridge: async (_request, canonicalInput) => ({
        allowed: true,
        decisionId: 'fixture-approved',
        canonicalInput,
      }),
      onReceipt: receipt => {
        foregroundIsolationProfile = receipt.isolationProfile;
      },
    });
    const foregroundTool = buildRuntimeBackedBuiltinToolDefinitions(repoRoot, {
      toolExecutor,
      sessionKey,
      manifestIdentity,
    }).find(tool => tool.name === foregroundGolden.input.tool)!;
    const foregroundSignal = new AbortController().signal;
    const foregroundResult = await foregroundTool.execute(
      // The model-facing bash timeout is MILLISECONDS (R10 pass-12 fix); the
      // golden expects the value to pass through to runCommand unchanged.
      'foreground-call', { command: foregroundGolden.input.command, timeout: 2000 }, foregroundSignal, undefined, {} as never,
    );
    expect(foregroundCalls).toEqual([{
      command: foregroundGolden.expected.runCommand.command,
      cwd: repoRoot,
      timeout: foregroundGolden.expected.runCommand.timeout,
      signal: foregroundSignal,
      semanticId: foregroundGolden.expected.runCommand.semanticId,
      isolationProfile: foregroundGolden.expected.runCommand.isolationProfile,
    }]);
    expect(foregroundIsolationProfile).toBe(foregroundGolden.expected.runCommand.isolationProfile);
    expect(foregroundResult.content[0]).toEqual({ type: 'text', text: foregroundGolden.expected.text });

    const backgroundGolden = runtime.goldenBaselines.find((row: any) => row.id === 'background-process');
    expect(backgroundGolden.expected.sequence).toEqual([
      'host supervisor start', 'emit shell_backgrounded', 'return opaque process handle', 'host cursor logs', 'host owns exit state',
    ]);
    const backgroundEvents: any[] = [];
      const backgroundTool = supervisedBackgroundTool(event => backgroundEvents.push(event), backgroundGolden.expected.shellId);
      const backgroundResult = await backgroundTool.execute(
        'background-call', { command: backgroundGolden.input.command }, new AbortController().signal, undefined, {} as never,
      );
      expect(backgroundResult.details).toMatchObject({
        shellId: backgroundGolden.expected.shellId, command: backgroundGolden.input.command,
      });
      expect(backgroundEvents).toEqual([{
        type: 'shell_backgrounded', toolUseId: 'background-call',
        shellId: backgroundGolden.expected.shellId, command: backgroundGolden.input.command,
      }]);
      expect(backgroundResult.details?.isolationProfile).toBe('workspace:fixture');
  });

  test('pins golden live-cwd and MCP elicitation ordering', () => {
    const runtime = fixture<any>('runtime-behavior.json');
    const cwdGolden = runtime.goldenBaselines.find((row: any) => row.id === 'live-cwd');
    const piAgentSource = sourceAt('packages/shared/src/agent/pi-agent.ts');
    const spawnStart = piAgentSource.indexOf('private async spawnSubprocess');
    const spawnEnd = piAgentSource.indexOf('\n  private ', spawnStart + 1);
    const spawnBlock = piAgentSource.slice(spawnStart, spawnEnd > spawnStart ? spawnEnd : undefined);
    expectOrderedMarkers(spawnBlock, [
      'const cwd = this.resolvedCwd()', 'const child = this.spawnProcess', 'cwd,',
      'const workingDirectory = this.config.session?.workingDirectory || cwd',
      'this.send(buildPiInitMessage({', 'cwd,', 'workingDirectory,',
    ], 'live cwd subprocess/init propagation');
    expect(cwdGolden.expected.spawnSequence).toEqual([
      'resolvedCwd', 'spawn cwd', 'derive workingDirectory',
      'send init cwd', 'send init workingDirectory',
    ]);

    const elicitationGolden = runtime.goldenBaselines.find((row: any) => row.id === 'mcp-elicitation');
    const mcpSource = sourceAt('packages/shared/src/mcp/client.ts');
    const constructorStart = mcpSource.indexOf('constructor(config: McpClientConfig');
    const constructorEnd = mcpSource.indexOf('\n  async connect()', constructorStart);
    const constructorBlock = mcpSource.slice(constructorStart, constructorEnd);
    expectOrderedMarkers(constructorBlock, [
      // The capabilities argument is an ACCUMULATED object now, not an
      // either/or ternary — R57 added `roots` beside elicitation, and a naive
      // key append to the ternary would have dropped elicitation in one branch.
      'this.client = new Client', 'capabilities: {', '...(options?.elicitationHandler',
      '? { elicitation: { form: {}, url: {} } }', '...(options?.rootsProvider ? { roots: { listChanged: true } } : {})',
      'if (options?.elicitationHandler)',
      'setRequestHandler(ElicitRequestSchema', 'extra.signal',
    ], 'MCP elicitation constructor');
    expect(elicitationGolden.expected.constructorSequence).toEqual([
      'Client capabilities', 'conditional elicitation advertisement',
      'set ElicitRequestSchema handler', 'forward extra.signal',
    ]);
    expect(elicitationGolden.expected.advertised).toEqual({ elicitation: { form: {}, url: {} } });
  });

  test('executes golden BashOutput, spawn_session, send_agent_message, and script_sandbox contracts', async () => {
    const runtime = fixture<any>('runtime-behavior.json');
    const bashOutputGolden = runtime.goldenBaselines.find((row: any) => row.id === 'bash-output');
    const bashResult = await handleBashOutput({
      readBackgroundShellOutput: async (shellId: string, offset?: number) => {
        expect(shellId).toBe('shell-fixture');
        expect(offset).toBe(3);
        return { shellId, output: 'chunk', nextOffset: 9, isRunning: true };
      },
    } as any, bashOutputGolden.input);
    expect(bashResult.isError).toBe(false);
    expect(bashResult.content[0]).toEqual({ type: 'text', text: bashOutputGolden.expected.text });

    const spawnGolden = runtime.goldenBaselines.find((row: any) => row.id === 'spawn-session');
    const spawnDefinition = SESSION_TOOL_DEFS.find(row => row.name === spawnGolden.expected.name);
    expect(spawnDefinition).toMatchObject({
      name: spawnGolden.expected.name,
      executionMode: spawnGolden.expected.executionMode,
      safeMode: spawnGolden.expected.safeMode,
    });
    expect(Object.prototype.hasOwnProperty.call(spawnDefinition, 'readOnly'))
      .toBe(spawnGolden.expected.readOnlyDeclared);
    expect(Boolean(spawnDefinition?.readOnly)).toBe(spawnGolden.expected.readOnlyEffective);
    const spawnSchema = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' })
      .find(row => row.name === `mcp__session__${spawnGolden.expected.name}`)?.inputSchema as any;
    expect(spawnSchema).toBeDefined();
    for (const field of Object.keys(spawnGolden.input)) {
      expect(spawnSchema.properties, `spawn_session.${field}`).toHaveProperty(field);
    }
    const spawnToolSource = sourceAt('packages/shared/src/agent/spawn-session-tool.ts');
    const spawnToolBlock = spawnToolSource.slice(spawnToolSource.indexOf('export function createSpawnSessionTool'));
    expectOrderedMarkers(spawnToolBlock, [
      'const spawnFn = options.getSpawnSessionFn()',
      'if (!spawnFn)',
      "return errorResponse('spawn_session is not available in this context.')",
      'const result = await spawnFn(args as Record<string, unknown>)',
      'JSON.stringify(result, null, 2)',
      'return errorResponse(`spawn_session failed: ${error.message}`)',
    ], 'spawn_session callback/result state transitions');
    expect(spawnGolden.expected.handlerSequence).toEqual([
      'resolve session-scoped callback', 'fail closed when unavailable',
      'invoke callback with validated args', 'serialize result', 'normalize Error failure',
    ]);

    const sendGolden = runtime.goldenBaselines.find((row: any) => row.id === 'send-agent-message');
    const sent: any[] = [];
    const sendResult = await handleSendAgentMessage({
      sessionId: sendGolden.input.from,
      getSessionInfo: () => ({ name: sendGolden.input.fromName }),
      // Resolves to the receiver's verdict, not `void`: a drop, hold or refusal
      // has to reach the sender (`cross-session-messaging.md` §Limitations).
      sendAgentMessage: async (...args: any[]) => { sent.push(args); return { status: 'delivered' as const }; },
    } as any, { sessionId: sendGolden.input.to, message: sendGolden.input.message });
    expect(sendResult.isError).toBe(false);
    // Two arguments, not three: the message is text only, so there is no
    // attachments slot left to pass (`cross-session-messaging.md` — "never
    // conversation history or files").
    expect(sent).toEqual([[sendGolden.input.to, sendGolden.expected.wrappedMessage]]);

    const sandboxGolden = runtime.goldenBaselines.find((row: any) => row.id === 'script-sandbox');
    const sandboxResult = await handleScriptSandbox({} as any, sandboxGolden.input);
    expect(sandboxResult.isError).toBe(true);
    expect(sandboxResult.content[0]).toEqual({ type: 'text', text: sandboxGolden.expected.error });
  });

  test('pins shipped materializer, lease, invalidation, catalog, trust, storage, quiescence, and delete shapes', () => {
    const runtime = fixture<any>('runtime-behavior.json');
    expect(runtime.storageContracts.map((row: { id: string }) => row.id)).toEqual([
      'materializer', 'lease', 'agent-runtime-view', 'invalidation', 'safe-catalog', 'project-trust',
      'session-storage', 'storage-runtime', 'quiescence', 'delete-hook',
    ]);
    for (const row of runtime.storageContracts) {
      expect(Object.keys(row.exportedShape).length, row.id).toBeGreaterThan(0);
      for (const shape of Object.values(row.exportedShape) as unknown[][]) {
        expect(shape, row.id).toBeArray();
        expect(shape.length, row.id).toBeGreaterThan(0);
      }
      expect(row.currentBehavior).toBeString();
      expect(row.evidence).toBeString();
    }

    const materializer = sourceAt('packages/shared/src/capabilities/materializer.ts');
    for (const marker of [
      "| 'revoked'", "| 'credential-not-ready'", "| 'stale'", "| 'missing'",
      // Comma, not `)`: this one throw carries `result.revision` as the
      // second argument, which is what lets a consumer tell "the pin this
      // snapshot captured is behind the store" from "the record is absent".
      // The marker asserted `')'` and went red the moment that argument was
      // added — the code was right and the pin had decayed.
      "CapabilityMaterializationError('credential-not-ready',", 'assertActive(): void',
      'verifyPlugin(pluginInstanceId: string)', 'resolvePath(resource:', 'readText(resource:',
      'resolveCredential(binding:', "CapabilityMaterializationError('revoked')",
      "CapabilityMaterializationError('missing')", "CapabilityMaterializationError('stale')",
    ]) expect(materializer).toContain(marker);
    const materializerFixture = runtime.storageContracts.find((row: any) => row.id === 'materializer').exportedShape;
    expect(interfaceFieldNames(materializer, 'CapabilitySnapshotMaterializer'))
      .toEqual(materializerFixture.CapabilitySnapshotMaterializer);
    expect(interfaceFieldNames(materializer, 'CapabilitySnapshotMaterializerOptions'))
      .toEqual(materializerFixture.CapabilitySnapshotMaterializerOptions);

    const invalidation = sourceAt('packages/shared/src/capabilities/invalidation.ts');
    const invalidationFixture = runtime.storageContracts.find((row: any) => row.id === 'invalidation').exportedShape;
    for (const name of ['NativeSourceInvalidation', 'PluginRuntimeInvalidation', 'CapabilityCatalogInvalidation']) {
      expect(interfaceFieldNames(invalidation, name), name).toEqual(invalidationFixture[name]);
    }
    for (const scope of invalidationFixture.scopes) expect(invalidation).toContain(`kind: '${scope}'`);
    for (const effect of invalidationFixture.effects) expect(invalidation).toContain(`'${effect}'`);

    const resolver = sourceAt('packages/shared/src/capabilities/resolver.ts');
    for (const marker of [
      'context: CapabilityContext', 'generation: string', 'leaseId: string',
      'entries: ResolvedCapabilityEntry[]', 'installedPlugins: ResolvedInstalledPlugin[]',
      'diagnostics: CapabilityDiagnostic[]', 'releaseSnapshot(leaseId: string)',
      'isLeaseActive(leaseId: string)', "'refresh-before-next-turn'",
      "'revoke-active-snapshot'", "case 'project-trust':", "case 'session':", "case 'plugin':",
    ]) expect(resolver).toContain(marker);

    const safeCatalog = sourceAt('packages/shared/src/protocol/capabilities.ts');
    const safeFixture = runtime.storageContracts.find((row: any) => row.id === 'safe-catalog').exportedShape;
    for (const name of [
      'SafeCapabilityScopeRef', 'SafeCapabilitySummary', 'SafePluginOriginIdentity',
      'SafeInstalledPluginSummary', 'SafeCapabilityDiagnostic', 'ComposerCatalogView',
      'UserCapabilityCatalog',
    ]) expect(interfaceFieldNames(safeCatalog, name), name).toEqual(safeFixture[name]);
    expect(interfaceNestedFieldNames(safeCatalog, 'SafeCapabilitySummary', 'mention'))
      .toEqual(safeFixture['SafeCapabilitySummary.mention']);
    expect(interfaceNestedFieldNames(safeCatalog, 'SafeInstalledPluginSummary', 'activation'))
      .toEqual(safeFixture['SafeInstalledPluginSummary.activation']);
    expect(interfaceNestedFieldNames(safeCatalog, 'SafeInstalledPluginSummary', 'actions'))
      .toEqual(safeFixture['SafeInstalledPluginSummary.actions']);

    const views = sourceAt('packages/shared/src/capabilities/views.ts');
    const runtimeViewFixture = runtime.storageContracts.find((row: any) => row.id === 'agent-runtime-view').exportedShape;
    for (const name of ['AgentRuntimeView', 'RuntimeSourceHandle', 'RuntimeSkillHandle']) {
      expect(interfaceFieldNames(views, name), name).toEqual(runtimeViewFixture[name]);
    }

    const snapshotFixture = runtime.storageContracts.find((row: any) => row.id === 'lease').exportedShape;
    expect(interfaceFieldNames(resolver, 'EffectiveCapabilitySnapshot')).toEqual(snapshotFixture.EffectiveCapabilitySnapshot);

    const projectTrust = sourceAt('packages/shared/src/capabilities/project-trust-store.ts');
    for (const marker of [
      'export interface ProjectTrustRecord', 'identityFingerprint: string',
      "persistence: 'stable' | 'process-only'", 'record.identityFingerprint === identity.identityFingerprint',
    ]) expect(projectTrust).toContain(marker);
    const trustFixture = runtime.storageContracts.find((row: any) => row.id === 'project-trust').exportedShape;
    expect(interfaceFieldNames(projectTrust, 'ProjectTrustRecord')).toEqual(trustFixture.ProjectTrustRecord);
    expect(interfaceFieldNames(projectTrust, 'ProjectTrustDecision')).toEqual(trustFixture.ProjectTrustDecision);

    const storageRuntime = sourceAt('packages/server-core/src/bootstrap/storage-runtime.ts');
    expect(storageRuntime).toContain('export interface StorageRuntime');
    expect(storageRuntime).toContain('const workspaceQuiescence = new WorkspaceQuiescenceCoordinator()');
    expect(storageRuntime).toContain('workspaceService = createWorkspaceService({');
    const workspaceCallStart = storageRuntime.indexOf('workspaceService = createWorkspaceService({');
    const workspaceCallEnd = storageRuntime.indexOf('\n  })', workspaceCallStart);
    expect(storageRuntime.slice(workspaceCallStart, workspaceCallEnd)).toContain('quiescence: workspaceQuiescence');

    const workspaceService = sourceAt('packages/shared/src/workspaces/service.ts');
    expect(workspaceService).toContain('export interface WorkspaceQuiescenceLease');
    expect(workspaceService).toContain('export interface WorkspaceQuiescence');
    expect(workspaceService).toContain("throw new Error('Workspace quiescence is required for deletion')");
    expect(workspaceService).toContain('await participant.stage(id, transactionId)');
    expect(workspaceService).toContain('await participant.commit(transactionId)');
    expect(workspaceService).toContain('await participant.rollback(transactionId)');
    expect(workspaceService).toContain('await lease.release()');
    expect(interfaceFieldNames(workspaceService, 'WorkspaceQuiescenceLease')).toEqual(['release']);
    expect(interfaceFieldNames(workspaceService, 'WorkspaceQuiescence')).toEqual(['acquire']);

    const workspaceTypes = sourceAt('packages/shared/src/workspaces/types.ts');
    expect(interfaceFieldNames(workspaceTypes, 'WorkspaceDeleteResult')).toEqual(['deleted', 'cleanupFailures']);
    expect(interfaceFieldNames(workspaceTypes, 'WorkspaceCleanupParticipant')).toEqual(['id', 'stage', 'commit', 'rollback']);
    const sessionTypes = sourceAt('packages/shared/src/sessions/types.ts');
    const sessionStore = sourceAt('packages/shared/src/sessions/store-v2.ts');
    expect(interfaceFieldNames(sessionTypes, 'SessionKey')).toEqual(['workspaceId', 'sessionId']);
    expect(interfaceFieldNames(sessionStore, 'SessionStore')).toEqual([
      'ensureWorkspaceDir', 'getSessionPath', 'getSessionFilePath', 'create', 'load', 'list', 'delete',
    ]);

    expect(runtime.acceptedStorageBaseline).toEqual({
      w12ImplementationFoundation: '47f28745',
      completedCloseout: '781144bf',
      realProfileSmoke: 'completed and accepted in storage closeout',
      finalCloseout: 'completed and accepted',
      genericProductionWorkspaceQuiescence: 'present; StorageRuntime owns the generic coordinator and SessionManager registers the Pi participant',
    });
  });

  test('records all 26 migrated P0 rows and closes the X3 call_llm defect register without active tracker coupling', () => {
    const defects = fixture<any>('p0-defects.json');
    const corpus = JSON.parse(readFileSync(resolve(
      repoRoot,
      'packages/pi-agent-server/src/__tests__/extension-first/fixtures/behavior-corpus.json',
    ), 'utf8')) as { cases: Array<Record<string, unknown>> };
    expect(defects.trackerSource).toBeUndefined();
    expect(defects.p0Rows.map((row: { id: string }) => row.id)).toEqual([
      'pi-version-compatibility', 'system-prompt', 'tool-registry', 'scheduling',
      'file-edits', 'foreground-shell', 'background-shell', 'tool-cancellation',
      'permission-policy', 'approval-count', 'headless-approval', 'auto-accept-edits',
      'shell-sandbox', 'arbitrary-code-tools', 'workflow-evaluator', 'hooks-semantics',
      'child-execution', 'extension-runtime', 'trust-injection', 'headless-sdk-parity',
      'desktop-runtime-supervision', 'desktop-permission-prompt', 'desktop-sandbox-status',
      'desktop-background-processes', 'desktop-subagent-cards',
      'desktop-crash-reload-recovery',
    ]);
    const corpusById = new Map(corpus.cases.map(row => [row.id, row]));
    for (const row of defects.p0Rows) {
      expect(row.priority).toBe('P0');
      expect(row.corpusCaseId).toBe(row.id);
      expect(row.historical.area).toBeString();
      expect(row.historical.owner).toBeString();
      expect(row.historical.phases).toBeArray();
      expect(row.historical.phases).not.toHaveLength(0);
      expect(row.historical.reason).toBeString();
      expect(row.historical.evidence).toBeString();
      expect(corpusById.get(row.corpusCaseId), row.id).toMatchObject({
        id: row.id,
        priority: 'P0',
        owner: expect.any(String),
        currentStatus: expect.stringMatching(/^(implemented|partial|missing|blocked|accepted-difference)$/),
        targetPhase: expect.stringMatching(/^X(?:0|[1-9]|10|11)(?:[AB])?(?:\/X(?:0|[1-9]|10|11)(?:[AB])?)*$/),
      });
    }

    expect(defects.knownDefects).toEqual([]);
    expect(corpusById.get('call-llm-speculative-prefetch')).toMatchObject({
      id: 'call-llm-speculative-prefetch',
      currentStatus: 'implemented',
      targetPhase: 'X3',
    });
  });

  test('proves normal call_llm wrapper execution while speculative host dispatch is absent', () => {
    const serverSource = readFileSync(resolve(repoRoot, 'packages/pi-agent-server/src/index.ts'), 'utf8');
    const agentSource = readFileSync(resolve(repoRoot, 'packages/shared/src/agent/pi-agent.ts'), 'utf8');
    const wrapperSource = readFileSync(resolve(repoRoot, 'packages/pi-agent-server/src/local-tools/tool-wrapper.ts'), 'utf8');
    const executorSource = readFileSync(resolve(repoRoot, 'packages/shared/src/agent/pi-harness/tool-executor.ts'), 'utf8');

    for (const removed of ['PREFETCHABLE_TOOLS', 'callLlmApprovalReceipts', 'prefetchCache', 'Speculative prefetch']) {
      expect(serverSource).not.toContain(removed);
    }
    expect(wrapperSource).toContain('await deps.toolExecutor.execute({');
    expectOrderedMarkers(executorSource, [
      'permissionBridge(request, canonicalInput)',
      'await scheduler.run(descriptor',
      'port.dispatch.execute(canonicalInput, context)',
    ], 'normal wrapper executor dispatch');
    const proxyStart = serverSource.indexOf('function buildProxyTools');
    const proxyEnd = serverSource.indexOf('\nfunction ', proxyStart + 1);
    const proxyBlock = serverSource.slice(proxyStart, proxyEnd);
    expectOrderedMarkers(proxyBlock, [
      'const pending:',
      'if (signal)',
      "type: 'tool_execute_cancel'",
      "signal.addEventListener('abort', abort, { once: true })",
      'pendingToolExecutions.set(requestId, pending)',
      "type: 'tool_execute_request'",
      'proxyExecutionResultToAgentToolResult(await resultPromise)',
    ], 'single proxy dispatch');
    expect(proxyBlock).not.toContain('requestPiPermissionReceipt');

    const childInitStart = serverSource.indexOf('interface InitMessage');
    const childInitEnd = serverSource.indexOf('interface RuntimeConfigUpdateMessage', childInitStart);
    const childInitBlock = serverSource.slice(childInitStart, childInitEnd);
    expect(childInitBlock).toContain('orchestrator?: {');
    expect(childInitBlock).not.toContain('agentDir?:');
    const spawnerStart = serverSource.indexOf('function configureSpawnerForGeneration');
    const definitionStart = serverSource.indexOf('function buildSessionDefinition', spawnerStart);
    const spawnerBlock = serverSource.slice(spawnerStart, definitionStart);
    const definitionEnd = serverSource.indexOf('\nasync function ensureSession', definitionStart);
    const definitionBlock = serverSource.slice(definitionStart, definitionEnd);
    expect(spawnerBlock).toContain("config: Extract<InboundMessage, { type: 'init' }>");
    expect(spawnerBlock).toContain('tierModelMap: config.orchestrator?.tierModelMap');
    expect(definitionBlock).toContain("config: Extract<InboundMessage, { type: 'init' }>");
    expect(definitionBlock).toContain('getMaxParallelTasks: () => generationConfig.orchestrator?.maxParallelTasks');
    // The manifest argument is load-bearing, not cosmetic: it is where the
    // spawner reads this session's own tool pool (a fork inherits it verbatim,
    // sub-agents.md:324) and its `sessionIsFork` flag (:1052).
    expect(definitionBlock.split('configureSpawnerForGeneration(config, manifest)').length - 1)
      .toBe(2);
    const initStart = agentSource.indexOf('export function buildPiInitMessage');
    const initEnd = agentSource.indexOf('\n}', initStart) + 2;
    const initBlock = agentSource.slice(initStart, initEnd);
    expect(initBlock).toContain("{ type: 'init', contextProfile }");
    expect(initBlock).not.toContain('agentDir');
    expect(initBlock).not.toContain('orchestrator:');
  });
});

function fixtureAt<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as T;
}

function sourceAt(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function serverSourceAt(marker: string): number {
  const index = sourceAt('packages/pi-agent-server/src/index.ts').indexOf(marker);
  expect(index, marker).toBeGreaterThanOrEqual(0);
  return index;
}

function interfaceFieldNames(source: string, name: string): string[] {
  const marker = `export interface ${name} {`;
  const start = source.indexOf(marker);
  expect(start, name).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = -1;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  expect(end, `${name}.end`).toBeGreaterThan(start);
  const body = source.slice(start + marker.length, end);
  return Array.from(body.matchAll(/^  ([A-Za-z][A-Za-z0-9_]*)\??(?:\s*:\s*|\()/gm), match => match[1]!);
}

function interfaceNestedFieldNames(source: string, interfaceName: string, property: string): string[] {
  const interfaceStart = source.indexOf(`export interface ${interfaceName} {`);
  expect(interfaceStart, interfaceName).toBeGreaterThanOrEqual(0);
  const propertyStart = source.indexOf(`  ${property}`, interfaceStart);
  expect(propertyStart, `${interfaceName}.${property}`).toBeGreaterThan(interfaceStart);
  const open = source.indexOf('{', propertyStart);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  expect(end, `${interfaceName}.${property}.end`).toBeGreaterThan(open);
  return Array.from(
    source.slice(open + 1, end).matchAll(/^    ([A-Za-z][A-Za-z0-9_]*)\??\s*:/gm),
    match => match[1]!,
  );
}

function expectOrderedMarkers(source: string, markers: string[], label: string): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    expect(next, `${label}: ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function snapshotTree(path: string): string {
  if (!existsSync(path)) return 'absent';
  const hash = createHash('sha256');
  const walk = (entryPath: string, relativePath: string) => {
    const stat = lstatSync(entryPath);
    hash.update(`${relativePath}\0${stat.mode}\0${stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'file'}\0`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(entryPath).sort()) walk(join(entryPath, name), join(relativePath, name));
    } else if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(entryPath));
    } else {
      hash.update(readFileSync(entryPath));
    }
  };
  walk(path, '.');
  return hash.digest('hex');
}

/**
 * F1.115 (origin `D1.430`'s residue) — the provenance of the 2026-09-20 re-pin,
 * written at the END of this file rather than beside the five entries in
 * `P6.802`'s docblock ~1 200 lines above, and the reason is mechanical: eight
 * line-tailed `docs/**` citations into this file sit below that docblock, and a
 * thirty-line insertion there moves every one of them. The house rule is that a
 * comment edit in a file the ledgers cite by line keeps its line count; this
 * block is appended below the highest cited line, so nothing moves.
 *
 * CAUSE FIRST, then the pin, which is that docblock's discipline:
 *
 * - `automation.create` and `automation.update` — a `.describe()` on
 *   `AutomationCreateSchema.permissionMode`
 *   (`session-tools-core/src/handlers/automation-management.ts`). `D1.430`
 *   shipped a server-side ceiling of `acceptEdits` for the two MODEL-facing
 *   automation tools while the input schema still offered `auto` and
 *   `bypassPermissions` as enum members, so a model reading the schema alone
 *   tried one and was refused once. The ceiling now rides the field the model
 *   reads. `automation.update` moves WITH it because `AutomationUpdateSchema`
 *   is `AutomationCreateSchema.partial()`, which carries the description
 *   through — the live check that those two are one declaration and not two
 *   copies, and the reason exactly two rows moved rather than one.
 *
 * - Recomputed INDEPENDENTLY of the failing run, as the older entries were: a
 *   throwaway script re-implemented `sha256` over a locale-sorted,
 *   undefined-stripped canonical JSON of each tool's live `inputSchema` — the
 *   rule each row's own `inputCodec` states — importing nothing from
 *   `source-state-contract.ts`, and carrying a control asserting the new
 *   sentence is inside the payload it hashed. Both reproduced the gate's
 *   `expected` exactly: `951f2e94…` for create, `c0c68269…` for update.
 *
 * All three digest-bearing fields of a row move TOGETHER (`schemaIdentity`,
 * `modelSchemaVersion`, `bindingSchemaVersion`): `findLiveJsonSchemaFindings`
 * compares each as a WHOLE string, and the tool's name is hashed into the digest
 * as well as spelled in the third field, so a half-moved row leaves a stale
 * prefix beside a right hash. `PI_STATIC_MODEL_CONTRACT_HASHES` is NOT touched —
 * these two are session tools and that table pins the pi static ones.
 */

/**
 * F1.114 (origin WI-bw) — the DESCRIPTION half of every `live-json-schema` pin,
 * derived here INDEPENDENTLY of `source-state-contract.ts`: the literal prefix is
 * spelled out rather than imported, so this oracle and the gate's
 * `--live-json-schema` mode are two derivations that must agree, not one
 * constant read twice. Placed at the END of the file for the same reason as the
 * F1.115 block above — the call site at the session-tool loop was edited one
 * line for one line, and nothing any `docs/**` citation points at moves.
 *
 * CAUSE: the three digests hash `inputSchema` only. On 2026-09-20 a
 * `.describe()` on one field moved two pins while rewriting both `automation_*`
 * tool descriptions moved nothing (23 pass / 0 fail) — the sentence a model reads
 * first was pinned by nothing. The rule is sha256 over the RAW description
 * string (an absent one hashes the empty string, so LOSING a description moves
 * the pin). All 61 values were written into the fixture by a throwaway script
 * that re-implemented that rule and imported nothing from the gate; the gate's
 * live mode then answered 61/61, and a planted one-digest mutant answered exit 1
 * naming `descriptionDigest` alone. The 20 Pi static and conditional rows carry
 * none because their `modelContractHash` already hashes the description, and the
 * one `dynamic-wire-source` row is a template with no text of its own.
 */
function liveToolDescriptionDigest(description: string | undefined): string {
  return `live-tool-description:sha256:${createHash('sha256').update(description ?? '').digest('hex')}`;
}

/**
 * F1.197 (origin WJ-l P-WJ-l-2) — the provenance of the 2026-09-23 re-pin of
 * the two DISCOVERY rows, written here for F1.115's reason (the fixture is JSON,
 * and eight `docs/**` citations sit below `P6.802`'s docblock).
 *
 * CAUSE: `mcp__tool_search` and `mcp__tool_load` described the catalogue as
 * "deferred MCP source tools" while it also carries the nine on-demand built-ins
 * and the deferred session tools, so a model looking for `review` had no reason
 * to search there (F1.147's live symptom). Their descriptions, the search tool's
 * `promptSnippet` and the three parameter descriptions were reworded; nothing
 * else about either tool changed.
 *
 * FOUR values move, and only these: each tool's `modelContractHash` (the
 * fixture's `conditionalTools` rows AND `PI_STATIC_MODEL_CONTRACT_HASHES` in
 * `shared/src/agent/pi-harness/harness-tool-descriptor.ts`, which must agree),
 * and each row's `live-tool-parameters` digest in all three of its spellings.
 * Recomputed INDEPENDENTLY of the failing run by a throwaway script that
 * re-implemented both rules — sha256 over the key-sorted, undefined-stripped
 * canonical JSON of `parameters`, and of the model-visible contract object
 * `{name, description, schema, promptSnippet, promptGuidelines, provenance}` —
 * importing nothing from `source-state-contract.ts` or `harness-manifest.ts`.
 * Its CONTROL patched the live definitions back to HEAD's strings and
 * reproduced HEAD's four pinned values exactly before the new ones were taken:
 * search `5cc4f298…`, load `84229a57…`, search parameters `41a3700a…`, load
 * parameters `2701e7b3…`.
 */

/**
 * F1.805 (release sitting SIT-p) — the provenance of the 2026-09-26 re-pin of
 * ONE value, written here for F1.115's reason.
 *
 * CAUSE: `plugin_plan_install`'s description said `repositoryUrl` names "a
 * repository to inspect for a supported plugin/skill format", but the plan step
 * parses the URL only and never contacts the repository, so a model read an
 * `installable` answer for a repository that does not exist as a verified one.
 * The parenthetical now says the repository is fetched and validated by
 * `plugin_install`; nothing else about the tool changed.
 *
 * ONE value moves: the `plugin.plan_install` row's `descriptionDigest` (its
 * `inputSchema` is unchanged, so its three `live-json-schema` spellings stay).
 * Recomputed INDEPENDENTLY by a throwaway script hashing the raw live
 * description with sha256 (F1.114's rule, importing nothing from the gate);
 * its CONTROL put HEAD's sentence back and reproduced HEAD's pin `083754d2…`
 * exactly before the new `cdf7f227…` was taken.
 */
