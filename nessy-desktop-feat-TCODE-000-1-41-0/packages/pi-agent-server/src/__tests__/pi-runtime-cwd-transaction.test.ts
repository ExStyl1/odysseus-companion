import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PI_ORCHESTRATOR_CONFIG,
  finalizePiExecutionManifest,
  type PiDynamicToolDefinition,
  type PiExecutionManifestSeedV2,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
import { minimumReserveTokens } from '../auto-compaction-settings.ts';
import { isPiPreToolUseRequest, piPreToolUseResponse } from './support/pi-permission-receipt-fixture.ts';
import { REAL_SERVER_BOOT_WAIT_MS, realServerTestBudget } from './support/real-server-clock.ts';

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, '..', 'index.ts');
const repoRoot = join(here, '..', '..', '..', '..');
const adapterUrl = new URL('../compat/pi-runtime-adapter.ts', import.meta.url).href;
const wrapperUrl = new URL('../local-tools/tool-wrapper.ts', import.meta.url).href;
const searchProviderUrl = new URL('../tools/search/resolve-provider.ts', import.meta.url).href;

type JsonMessage = Record<string, unknown>;

function writeMessage(child: ChildProcessWithoutNullStreams, message: JsonMessage): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function readLog(path: string): JsonMessage[] {
  const source = readFileSync(path, 'utf8').trim();
  return source ? source.split('\n').map(line => JSON.parse(line) as JsonMessage) : [];
}

/**
 * The sessions the cwd TRANSACTION created, in order — identified by what they
 * are rather than by when they happened to be made.
 *
 * This test used to name every session by its creation ordinal, in about forty
 * places. That works only while nothing else creates a session, and something
 * else does: reaching a deferred tool loads it, loading sets `toolsChanged`,
 * and the prompt handler disposes and rebuilds the active session. Every
 * ordinal after that point shifts, and the failure surfaces as a 120-second
 * timeout on a wait whose subject never arrives — which reads like a lost
 * transaction and is not one. That misreading cost a withdrawn defect report.
 *
 * THE DISCRIMINATOR IS THE REGISTRY, and it is measured rather than assumed: a
 * transaction session is built on a registry created for it, while a rebuild
 * re-uses the registry of the session it replaces. In the passing control all
 * twelve sessions pair with their own `registry_create`; in a run carrying one
 * tool load, the rebuild re-uses registry 1. So "first session on a given
 * registry" selects exactly the transaction's own sessions and is blind to how
 * many times the tool list changed underneath them.
 */
function transactionSessions(log: JsonMessage[]): JsonMessage[] {
  const seenRegistries = new Set<unknown>();
  return log.filter(entry => {
    if (entry.type !== 'session_create') return false;
    if (seenRegistries.has(entry.registryId)) return false;
    seenRegistries.add(entry.registryId);
    return true;
  });
}

/** The id of the nth (1-based) transaction session, or undefined before it exists. */
function txnSessionId(log: JsonMessage[], nth: number): unknown {
  return transactionSessions(log)[nth - 1]?.sessionId;
}

describe('Pi runtime cwd transaction', () => {
  it('keeps PREPARE private, refreshes generation auth, and restores a failed COMMIT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-h1c-child-'));
    const sessionPath = join(root, 'session');
    const oldCwd = join(root, 'old-cwd');
    const nextCwd = join(root, 'next-cwd');
    const failedCwd = join(root, 'failed-cwd');
    const terminalBarrierCwd = join(root, 'terminal-barrier-cwd');
    const prepareFailureCwd = join(root, 'prepare-failure-cwd');
    const reinitRaceCwd = join(root, 'reinit-race-cwd');
    const markerPath = join(root, 'runtime.jsonl');
    const terminalControlReleasePath = join(root, 'terminal-control.release');
    const prepareFailureCreateReleasePath = join(root, 'prepare-failure-create.release');
    const prepareFailureControlReleasePath = join(root, 'prepare-failure-control.release');
    const reinitControlReleasePath = join(root, 'reinit-control.release');
    const terminalOwnerControlReleasePath = join(root, 'terminal-owner-control.release');
    const rollbackReinitControlReleasePath = join(root, 'rollback-reinit-control.release');
    const preloadPath = join(root, 'preload.ts');
    for (const [cwd, value] of [[oldCwd, 'untrusted-secret'], [nextCwd, 'current'], [failedCwd, 'candidate']] as const) {
      const workflowsDir = join(cwd, '.nessy-agent', 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(join(workflowsDir, 'rollback-isolation.js'), `
        export const meta = { name: 'rollback-isolation', description: 'CWD rollback isolation probe' };
        return ${JSON.stringify(value)};
      `);
    }
    const manifestGeneration = 'h1c-runtime-generation';
    const manifestCapabilityKey = 'mcp:external';
    const toolDefinitions = Array.from({ length: 49 }, (_, index) => ({
      name: `mcp__external__tool_${index}`,
      description: `Deferred tool ${index}`,
      inputSchema: { type: 'object', properties: {} },
    }));
    const manifestSeed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: manifestGeneration,
      sessionKey: { workspaceId: 'h1c-workspace', sessionId: 'h1c-runtime' },
      provenance: [{ capabilityKey: manifestCapabilityKey, generation: manifestGeneration }],
      mcpSources: [{ wireName: 'external', capabilityKey: manifestCapabilityKey, generation: manifestGeneration }],
      // Match the subprocess-normalized orchestrator: this init omits the field.
      orchestrator: { ...DEFAULT_PI_ORCHESTRATOR_CONFIG },
      staticTools: PI_TOOL_BINDINGS
        .filter(binding => PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName] !== undefined)
        .map(binding => ({
          descriptor: getHarnessToolDescriptor(binding.descriptorId),
          binding,
          source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
          modelContractHash: PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]!,
        })),
    };
    const executionManifest = finalizePiExecutionManifest(
      manifestSeed,
      toolDefinitions.map((definition): PiDynamicToolDefinition => ({
        bindingName: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        modelSchemaVersion: 1,
        bindingSchemaVersion: 1,
        provenance: { capabilityKey: manifestCapabilityKey, generation: manifestGeneration },
      })),
      { deferredMcpEnabled: true },
    );
    const wireToolDefinitions = executionManifest.tools
      .filter(tool => tool.source.kind === 'resolvedCapability')
      .map(tool => ({
        name: tool.binding.bindingName,
        description: tool.description!,
        inputSchema: tool.modelSchema!,
        promptSnippet: tool.promptSnippet,
        promptGuidelines: tool.promptGuidelines,
      }));
    writeFileSync(preloadPath, `
      import { mock } from 'bun:test';
      import { appendFileSync, existsSync } from 'node:fs';
      const markerPath = ${JSON.stringify(markerPath)};
      const terminalControlReleasePath = ${JSON.stringify(terminalControlReleasePath)};
      const prepareFailureCwd = ${JSON.stringify(prepareFailureCwd)};
      const nextCwd = ${JSON.stringify(nextCwd)};
      const failedCwd = ${JSON.stringify(failedCwd)};
      let candidateDelayFired = false;
      let renumberLoadFired = false;
      const prepareFailureCreateReleasePath = ${JSON.stringify(prepareFailureCreateReleasePath)};
      const prepareFailureControlReleasePath = ${JSON.stringify(prepareFailureControlReleasePath)};
      const reinitControlReleasePath = ${JSON.stringify(reinitControlReleasePath)};
      const terminalOwnerControlReleasePath = ${JSON.stringify(terminalOwnerControlReleasePath)};
      const rollbackReinitControlReleasePath = ${JSON.stringify(rollbackReinitControlReleasePath)};
      const record = (entry) => appendFileSync(markerPath, JSON.stringify(entry) + '\\n');
      const waitForRelease = async (path) => {
        const deadline = Date.now() + 15_000;
        while (!existsSync(path)) {
          if (Date.now() >= deadline) throw new Error('Timed out waiting for release: ' + path);
          await Bun.sleep(5);
        }
      };

      const actualAdapter = await import(${JSON.stringify(adapterUrl)});
      const actualWrapper = await import(${JSON.stringify(wrapperUrl)});
      mock.module(${JSON.stringify(wrapperUrl)}, () => ({
        ...actualWrapper,
        createPiSdkToolAdapter() {
          // adaptTool too: since F1.925 a tool loaded mid-request takes its execute from it.
          return { adaptTools: (tools) => tools, adaptTool: (tool) => tool };
        },
      }));
      mock.module(${JSON.stringify(searchProviderUrl)}, () => ({
        resolveSearchProvider(piAuth) {
          const key = piAuth?.credential?.key ?? piAuth?.credential?.access ?? null;
          record({ type: 'search_auth', key });
          return { name: 'h1c-search', search: async () => [] };
        },
      }));

      let registryCount = 0;
      let sessionCount = 0;
      const registries = new Map();
      // Pi 0.84 · the adapter's registry factory is async (ModelRuntime.create
      // is), the credential store replaced AuthStorage, and its only write path
      // is the async \`modify(provider, fn)\` rather than a sync \`set\`. The
      // recorded \`auth_set\` shape is unchanged so the assertions below still
      // read the same ledger.
      const createRegistry = async (existing) => {
        if (existing && registries.has(existing)) return registries.get(existing);
        const id = ++registryCount;
        const credentials = {
          __h1cId: id,
          async modify(provider, fn) {
            const credential = await fn(undefined);
            record({ type: 'auth_set', registryId: id, provider, key: credential?.key ?? credential?.access ?? null });
            return credential;
          },
        };
        const createModel = (modelId) => {
          const model = {
            id: modelId,
            name: modelId,
            provider: 'h1c-provider',
            api: 'h1c-api',
            contextWindow: 100_000,
          };
          if (id === 3) {
            Object.defineProperty(model, 'api', {
            get() { throw new Error('injected late commit publication failure'); },
            });
          }
          return model;
        };
        const initialModel = createModel('h1c-model');
        const modelRegistry = {
          find: (_provider, modelId) => createModel(modelId ?? 'h1c-model'),
          getAll: () => [initialModel],
          registerProvider() {},
        };
        const modelRuntime = { __h1cId: id };
        const registry = { credentials, modelRuntime, modelRegistry };
        registries.set(credentials, registry);
        record({ type: 'registry_create', registryId: id, reused: Boolean(existing) });
        return registry;
      };

      mock.module(${JSON.stringify(adapterUrl)}, () => ({
        ...actualAdapter,
        createPiRuntimeAdapter() {
          return {
            createRegistry,
            async createSession(options) {
              const id = ++sessionCount;
              // Per-session on purpose: a module-scope map would hand a later
              // probe a tool definition bound to a disposed session.
              const deferredRegistered = new Map<string, { execute: (...args: never[]) => unknown }>();
              await options.deferredMcpExtension?.({
                registerTool(tool) {
                  deferredRegistered.set(tool.name, tool);
                  record({ type: 'deferred_register', sessionId: id, name: tool.name });
                },
              });
              const registryId = options.registry.credentials.__h1cId;
              record({
                type: 'session_create',
                sessionId: id,
                registryId,
                cwd: options.cwd,
                strategy: options.strategy,
                model: options.sessionOptions.model?.id ?? null,
                thinkingLevel: options.sessionOptions.thinkingLevel ?? null,
              });
              // The PREPARE candidate, identified by what it IS rather than by
              // its ordinal. 'id === 2' held only while nothing else created a
              // session first, and an ordinal that silently encodes an unrelated
              // count is a tripwire for whoever changes session lifecycle next.
              if (!candidateDelayFired && options.cwd === nextCwd) {
                candidateDelayFired = true;
                record({ type: 'session_create_delayed', sessionId: id });
                await new Promise(resolve => setTimeout(resolve, 250));
              }
              if (options.cwd === prepareFailureCwd) {
                record({ type: 'prepare_failure_create_delayed', sessionId: id });
                await waitForRelease(prepareFailureCreateReleasePath);
                throw new Error('injected prepare construction failure');
              }
              let listener = null;
              const session = {
                sessionId: 'h1c-session-' + id,
                // C3.385 (56ab8aeb1) made handleSetThinkingLevel publish the
                // level Pi ACTUALLY HOLDS after its own clamp -- it reads
                // piSession.thinkingLevel -- where it used to republish the
                // level that was asked for. The real session exposes exactly
                // that, as a getter named thinkingLevel, in the Pi SDK's
                // dist/core/agent-session.d.ts at 0.84.4. This double carried
                // the value only on agent.state.thinkingLevel, so the host read
                // undefined, found no name to publish for it, and fell back to
                // the INIT config's level -- after which the PREPARE candidate
                // was created carrying off instead of the max set a moment
                // before, and this file failed 3 of 3 runs ALONE at the 1.38.0
                // close-out. Production was never affected: the double had gone
                // short of a seam the host had just started reading.
                //
                // NO BACKTICKS IN THIS COMMENT, and that is not style: every
                // line here is inside the preload TEMPLATE LITERAL that opens
                // near the top of this function, so a quoted identifier would
                // close the template and the child would be handed a broken
                // preload. Measured on the first draft of this very comment
                // (2026-09-13): 0 pass / 1 fail / 1 ERROR at 30 s, against
                // 1.9 s for the same case with the comment written in words.
                // Same trap as AGENTS.md's star-slash-in-a-docblock bullet, one
                // context over.
                get thinkingLevel() { return this.agent.state.thinkingLevel; },
                agent: {
                  state: {
                    model: options.sessionOptions.model,
                    thinkingLevel: options.sessionOptions.thinkingLevel,
                  },
                  toolExecution: 'parallel',
                },
                sessionManager: { getLeafId: () => null },
                settingsManager: {
                  applyOverrides(overrides) {
                    record({ type: 'apply_overrides', sessionId: id, overrides });
                  },
                },
                messages: [],
                isCompacting: false,
                autoCompactionEnabled: true,
                subscribe(next) {
                  listener = next;
                  record({ type: 'subscribe', sessionId: id });
                  return () => {
                    listener = null;
                    record({ type: 'unsubscribe', sessionId: id });
                  };
                },
                async prompt(message) {
                  record({
                    type: 'prompt_state',
                    sessionId: id,
                    model: this.agent.state.model?.id ?? null,
                    thinkingLevel: this.agent.state.thinkingLevel ?? null,
                  });
                  if (message === 'workflow rollback probe') {
                    let workflow = options.sessionOptions.customTools?.find(tool => tool.name === 'workflow');
                    if (!workflow) {
                      // Deferred: reach it the documented way — load, then take the
                      // definition the extension registered. Absence after that is
                      // still an error, not a skip.
                      const loader = options.sessionOptions.customTools?.find(tool => tool.name === 'mcp__tool_load');
                      if (loader) await loader.execute('workflow-deferred-load', { name: 'workflow' }, new AbortController().signal);
                      workflow = deferredRegistered.get('workflow');
                    }
                    if (!workflow) throw new Error('workflow tool missing from production session definition');
                    const result = await workflow.execute(
                      'workflow-rollback-probe',
                      { script: "return await workflow('rollback-isolation');" },
                      new AbortController().signal,
                    );
                    record({
                      type: 'workflow_recipe_result',
                      sessionId: id,
                      value: result.details?.returnValue ?? null,
                    });
                  }
                  if (message.startsWith('workflow trust probe')) {
                    let workflow = options.sessionOptions.customTools?.find(tool => tool.name === 'workflow');
                    if (!workflow) {
                      // Deferred: reach it the documented way — load, then take the
                      // definition the extension registered. Absence after that is
                      // still an error, not a skip.
                      const loader = options.sessionOptions.customTools?.find(tool => tool.name === 'mcp__tool_load');
                      if (loader) await loader.execute('workflow-deferred-load', { name: 'workflow' }, new AbortController().signal);
                      workflow = deferredRegistered.get('workflow');
                    }
                    if (!workflow) throw new Error('workflow tool missing from production session definition');
                    try {
                      const result = await workflow.execute(
                        'workflow-trust-probe',
                        { name: 'rollback-isolation' },
                        new AbortController().signal,
                      );
                      record({
                        type: 'workflow_trust_result',
                        probe: message,
                        sessionId: id,
                        value: result.details?.returnValue ?? null,
                        error: result.details?.error ?? null,
                      });
                    } catch (error) {
                      record({
                        type: 'workflow_trust_result',
                        probe: message,
                        sessionId: id,
                        value: null,
                        error: error instanceof Error ? error.message : String(error),
                      });
                    }
                  }
                  // Reachability is ASSERTED, not skipped. A bare truthiness guard
                  // here means that the day web_search stops being an upfront tool
                  // this probe stops RUNNING rather than failing — a false
                  // all-clear that takes its search_auth evidence with it and
                  // reports nothing. An absent subject is an error.
                  let search = options.sessionOptions.customTools?.find(tool => tool.name === 'web_search');
                  if (!search) {
                    const searchLoader = options.sessionOptions.customTools?.find(tool => tool.name === 'mcp__tool_load');
                    if (searchLoader) await searchLoader.execute('h1c-search-load', { name: 'web_search' }, new AbortController().signal);
                    search = deferredRegistered.get('web_search');
                  }
                  if (!search) throw new Error('web_search unreachable: absent from the surface and not loadable');
                  await search.execute('h1c-search', { query: 'auth probe' });
                  listener?.({ type: 'agent_end', messages: [] });
                },
                async compact() { return { summary: '', firstKeptEntryId: '', tokensBefore: 0 }; },
                abort() {},
                dispose() {},
                async setModel(model) {
                  if (model?.id === 'h1c-runtime-token-race') {
                    record({ type: 'control_delay', name: 'terminal-token-race' });
                    await waitForRelease(terminalControlReleasePath);
                  }
                  if (model?.id === 'h1c-runtime-prepare-failure-a') {
                    record({ type: 'control_delay', name: 'prepare-failure-a' });
                    await waitForRelease(prepareFailureControlReleasePath);
                  }
                  if (model?.id === 'h1c-runtime-reinit-race') {
                    record({ type: 'control_delay', name: 'reinit-race' });
                    await waitForRelease(reinitControlReleasePath);
                  }
                  if (model?.id === 'h1c-runtime-terminal-owner') {
                    record({ type: 'control_delay', name: 'terminal-owner' });
                    await waitForRelease(terminalOwnerControlReleasePath);
                  }
                  if (model?.id === 'h1c-runtime-rollback-reinit') {
                    record({ type: 'control_delay', name: 'rollback-reinit' });
                    await waitForRelease(rollbackReinitControlReleasePath);
                  }
                  this.agent.state.model = model;
                  record({ type: 'set_model', sessionId: id, model: model?.id ?? null });
                },
                setThinkingLevel(level) {
                  this.agent.state.thinkingLevel = level;
                  record({ type: 'set_thinking_level', sessionId: id, level });
                },
                async steer() {},
                setAutoCompactionEnabled(enabled) { this.autoCompactionEnabled = enabled; },
              };
              return {
                session,
                sessionFile: options.strategy.kind === 'reopen'
                  ? options.strategy.sessionFile
                  : '/tmp/h1c-active-session.jsonl',
                setSystemPrompt() {},
                compact: (...args) => session.compact(...args),
                dispose() {
                  // The failed-COMMIT candidate, identified by its directory
                  // rather than by its ordinal — this probe fires a deferred
                  // load DURING teardown, and which teardown that is has to
                  // survive any session the tool list adds ahead of it.
                  if (options.cwd === failedCwd) {
                    const loader = options.sessionOptions.customTools?.find(tool => tool.name === 'mcp__tool_load');
                    if (loader) {
                      void loader.execute('late-candidate-load', { names: ['mcp__external__tool_0'] });
                      record({ type: 'late_candidate_load', sessionId: id });
                    }
                  }
                  record({ type: 'dispose', sessionId: id });
                },
              };
            },
          };
        },
      }));
    `);

    const child = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    const messages: JsonMessage[] = [];
    const waiters: Array<{
      predicate: (message: JsonMessage) => boolean;
      resolve: (message: JsonMessage) => void;
    }> = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    lines.on('line', line => {
      let message: JsonMessage;
      try { message = JSON.parse(line) as JsonMessage; } catch { return; }
      messages.push(message);
      // Answer the permission bridge. Without it a deferred built-in's first
      // execution waits for a receipt nobody sends, and the run reads as "the
      // tool never ran" rather than "nobody answered".
      if (isPiPreToolUseRequest(message)) {
        writeMessage(child, piPreToolUseResponse({ manifest: executionManifest, request: message }));
      }
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });

    const waitFor = async (
      predicate: (message: JsonMessage) => boolean,
      label: string,
      timeoutMs = 120_000,
    ): Promise<JsonMessage> => {
      const existing = messages.find(predicate);
      if (existing) return existing;
      return new Promise<JsonMessage>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}\n${stderr}`)), timeoutMs);
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timeout);
            resolve(message);
          },
        });
      });
    };
    const waitForLog = async (
      predicate: (entry: JsonMessage) => boolean,
      label: string,
      timeoutMs = 120_000,
    ): Promise<JsonMessage> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const entry = readLog(markerPath).find(predicate);
        if (entry) return entry;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for log entry: ${label}\n${stderr}`);
    };
    /**
     * The server's own session serial advances once per created session, so an
     * exact value encodes a COUNT — the same fragility as the stub's ordinals,
     * one layer up. What these two sites mean is that a FRESH session became
     * ready, so that is what they assert: the shape, and that it is not the
     * serial that was ready before.
     */
    const readySerials: string[] = [];
    const expectFreshReadySession = (message: JsonMessage): void => {
      const serial = String(message.sessionId ?? '');
      expect(serial).toMatch(/^h1c-session-\d+$/);
      expect(readySerials).not.toContain(serial);
      readySerials.push(serial);
    };

    const transaction = async (
      id: string,
      phase: 'prepare' | 'commit' | 'rollback' | 'finalize',
      expectedGeneration: number,
      generation: number,
      cwd: string,
      timeoutMs = 120_000,
      projectTrusted = true,
    ): Promise<JsonMessage> => {
      writeMessage(child, {
        type: 'working_directory_transaction',
        id,
        phase,
        expectedGeneration,
        generation,
        cwd,
        projectTrusted,
      });
      return waitFor(
        message => message.type === 'working_directory_transaction_result'
          && message.id === id
          && message.phase === phase,
        `${id}:${phase}`,
        timeoutMs,
      );
    };

    try {
      writeMessage(child, {
        type: 'init',
        apiKey: '',
        model: 'h1c-model',
        cwd: oldCwd,
        workingDirectory: oldCwd,
        workspaceRootPath: root,
        projectTrusted: false,
        workspaceId: 'h1c-workspace',
        sessionId: 'h1c-runtime',
        sessionPath,
        plansFolderPath: join(sessionPath, 'plans'),
        thinkingLevel: 'off',
        deferredMcpToolLoading: true,
        executionManifest,
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'initial-token' } },
      });
      // F1.641: the child's first answer, so this wait covers its module-graph boot.
      await waitFor(message => message.type === 'ready', 'ready', REAL_SERVER_BOOT_WAIT_MS);
      writeMessage(child, {
        type: 'register_tools',
        id: 'initial-tools',
        tools: wireToolDefinitions,
        manifest: executionManifest,
        previous: {
          generation: executionManifest.snapshotGeneration,
          manifestHash: executionManifest.manifestHash,
        },
      });
      expect(await waitFor(
        message => message.type === 'register_tools_result' && message.id === 'initial-tools',
        'initial tools registration',
      )).toMatchObject({
        ok: true,
        generation: executionManifest.snapshotGeneration,
        manifestHash: executionManifest.manifestHash,
      });
      writeMessage(child, { type: 'ensure_session_ready', id: 'initial-session' });
      expectFreshReadySession(await waitFor(
        message => message.type === 'ensure_session_ready_result' && message.id === 'initial-session',
        'initial session',
      ));
      writeMessage(child, { type: 'prompt', id: 'initial-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(message => message.type === 'event' && (message.event as JsonMessage)?.type === 'agent_end', 'initial agent_end');
      writeMessage(child, { type: 'prompt', id: 'untrusted-workflow-probe', message: 'workflow trust probe initial', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      expect(await waitForLog(
        entry => entry.type === 'workflow_trust_result' && entry.probe === 'workflow trust probe initial',
        'untrusted workflow refusal',
      )).toMatchObject({
        // The claim is the REFUSAL: an untrusted cwd does not hand the session
        // its project recipes. No transaction has started and no candidate
        // exists yet, so the session ordinal asserted nothing about this and
        // only coupled the test to how many sessions happened to exist.
        value: null,
        error: expect.stringContaining('Unknown workflow recipe'),
      });

      const contextUpdatesBeforeModelChange = messages.filter(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'context_usage_update',
      ).length;
      writeMessage(child, { type: 'set_model', model: 'h1c-model-next' });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'context_usage_update'
          && messages.filter(candidate => candidate.type === 'event'
            && (candidate.event as JsonMessage)?.type === 'context_usage_update').length > contextUpdatesBeforeModelChange,
        'model change context update',
      );
      // The marker log is written by the subprocess on its own schedule, so the
      // event we waited for above is not proof the entry has landed. Wait for the
      // entry itself — and specifically for the COMPACTION-carrying one. The
      // startup sequence already logs an `apply_overrides` for session 1 (the
      // retry config), so a type+sessionId match is satisfied before the model
      // change writes anything: the wait was vacuous, and under full-suite CI
      // load the second entry landed after the assertion read the log — the
      // exact 13080-pass/1-fail shape master pipeline 121410987 recorded
      // (received array holds the retry entry, no compaction entry yet). The
      // assertion below is unchanged; only the wait now waits for its subject.
      // No session id: this waits for the model change to APPLY its compaction
      // override, and which session is active when it does is not the claim —
      // the sibling assertion below already said the number was incidental. It
      // is also not a transaction session after a rebuild, so resolving it
      // through `txnSessionId` would be wrong rather than merely redundant.
      await waitForLog(
        entry => entry.type === 'apply_overrides'
          && (entry as { overrides?: { compaction?: unknown } }).overrides?.compaction !== undefined,
        'model change apply_overrides marker',
      );
      expect(readLog(markerPath)).toContainEqual(expect.objectContaining({
        type: 'apply_overrides',
        // The session id is dropped rather than resolved: this asserts that the
        // model change applied its compaction override, and WHICH session was
        // active when it did is not the claim. The next line already said the
        // number was incidental — it just kept asserting it anyway.
        // The number below is incidental to what this case proves (the cwd transaction);
        // it is the resolver's one-turn floor, which this model's 100 000 window
        // is large enough to carry uncapped. Read from the resolver rather than
        // re-pinned, so a deliberate change to the floor does not read as a
        // transaction regression here.
        overrides: { compaction: { enabled: true, reserveTokens: minimumReserveTokens() } },
      }));
      writeMessage(child, { type: 'set_thinking_level', level: 'max' });

      const prepare = transaction('cwd-1', 'prepare', 0, 1, nextCwd);
      const candidateCreate = await waitForLog(
        entry => entry.type === 'session_create_delayed',
        'candidate create delay',
      );
      const candidateSessionId = candidateCreate.sessionId;
      writeMessage(child, { type: 'prompt', id: 'candidate-private-workflow-probe', message: 'workflow trust probe candidate-private', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      // The claim: a prompt during PREPARE is served by the ACTIVE session and
      // never by the private candidate. Asserting "not the candidate" against
      // the id captured above states that directly, and keeps stating it if the
      // number of sessions before this point ever changes.
      const candidatePrivate = await waitForLog(
        entry => entry.type === 'workflow_trust_result' && entry.probe === 'workflow trust probe candidate-private',
        'candidate workflow remains private',
      );
      expect(candidatePrivate).toMatchObject({
        value: null,
        error: expect.stringContaining('Unknown workflow recipe'),
      });
      expect(candidatePrivate.sessionId).not.toBe(candidateSessionId);
      writeMessage(child, {
        type: 'update_runtime_config',
        id: 'runtime-update-during-prepare',
        model: 'h1c-runtime-during-prepare',
      });
      writeMessage(child, { type: 'set_model', model: 'h1c-model-during-prepare' });
      writeMessage(child, { type: 'set_thinking_level', level: 'high' });
      writeMessage(child, {
        type: 'token_update',
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'prepared-token' } },
      });
      const duplicatePrepare = transaction('cwd-duplicate', 'prepare', 0, 1, nextCwd);
      expect(await duplicatePrepare).toMatchObject({
        success: false,
        errorMessage: 'A working-directory transaction is already active',
      });
      expect(await prepare).toMatchObject({ success: true });
      // "PREPARE is private" means the host is never told the CANDIDATE is the
      // session — not that no update is emitted at all. Counting conflated the
      // two: a tools-changed rebuild legitimately announces its new ACTIVE
      // session, and with deferral on, the model change above can cause one.
      // The claim, stated directly, is blind to how many rebuilds happened.
      expect(
        messages
          .filter(message => message.type === 'session_id_update')
          .map(message => message.sessionId),
      ).not.toContain('h1c-session-' + candidateSessionId);
      const preparedLog = readLog(markerPath);
      // Two TRANSACTION sessions exist at this point — the active one and the
      // candidate — and counting raw creates would also count any rebuild the
      // tool list triggered, which is not a transaction event.
      expect(transactionSessions(preparedLog)).toHaveLength(2);
      // `max` reaches the child as `max`, not as `xhigh`. The host used to
      // saturate the top level at `xhigh` on every model, and `559012df2`
      // removed that cap after measuring that Pi's own `ThinkingLevel` includes
      // `max` and that Pi narrows PER MODEL through `clampThinkingLevel` — so
      // the cap was a host ceiling pre-empting Pi's own table, and a user who
      // chose Max silently got XHigh. Re-measured on `pi-agent-core` 0.84.0,
      // 0.84.2 and 0.84.3 (W11-pi); see `backend/pi/constants.ts`. The claim
      // under test is unchanged: the candidate session is created carrying the
      // model and thinking level set before PREPARE.
      expect(preparedLog).toContainEqual(expect.objectContaining({
        type: 'session_create',
        sessionId: txnSessionId(preparedLog, 2),
        model: 'h1c-model-next',
        thinkingLevel: 'max',
      }));
      expect(preparedLog.filter(entry => entry.type === 'subscribe' && entry.sessionId === txnSessionId(readLog(markerPath), 2))).toHaveLength(0);
      expect(preparedLog.filter(entry => entry.type === 'auth_set'
        && entry.registryId === 2
        && entry.key === 'prepared-token')).toHaveLength(0);
      expect(await transaction('cwd-1', 'commit', 0, 1, nextCwd)).toMatchObject({ success: true });
      expect(await transaction('cwd-1', 'finalize', 0, 1, nextCwd)).toMatchObject({ success: true });
      writeMessage(child, { type: 'prompt', id: 'trusted-workflow-probe', message: 'workflow trust probe trusted', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      expect(await waitForLog(
        entry => entry.type === 'workflow_trust_result' && entry.probe === 'workflow trust probe trusted',
        'trusted workflow execution',
      )).toMatchObject({
        sessionId: txnSessionId(readLog(markerPath), 2),
        value: 'current',
        error: null,
      });
      await waitForLog(
        entry => entry.type === 'auth_set'
          && entry.registryId === 2
          && entry.key === 'prepared-token',
        'ordered prepared-token update',
      );
      expect(await waitFor(
        message => message.type === 'update_runtime_config_result'
          && message.id === 'runtime-update-during-prepare',
        'runtime update during prepare',
      )).toMatchObject({ success: true });
      await waitForLog(
        entry => entry.type === 'set_model'
          && entry.sessionId === txnSessionId(readLog(markerPath), 2)
          && entry.model === 'h1c-model-during-prepare',
        'model update during prepare',
      );
      await waitForLog(
        entry => entry.type === 'set_thinking_level'
          && entry.sessionId === txnSessionId(readLog(markerPath), 2)
          && entry.level === 'high',
        'thinking update during prepare',
      );
      writeMessage(child, { type: 'prompt', id: 'prepared-auth-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && readLog(markerPath).some(entry => entry.type === 'search_auth' && entry.key === 'prepared-token'),
        'prepared-token search',
      );
      expect(readLog(markerPath).filter(
        entry => entry.type === 'prompt_state' && entry.sessionId === txnSessionId(readLog(markerPath), 2),
      ).at(-1)).toMatchObject({
        model: 'h1c-model-during-prepare',
        thinkingLevel: 'high',
      });

      writeMessage(child, {
        type: 'token_update',
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'committed-token' } },
      });
      writeMessage(child, { type: 'prompt', id: 'committed-auth-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && readLog(markerPath).some(entry => entry.type === 'search_auth' && entry.key === 'committed-token'),
        'committed-token search',
      );
      writeMessage(child, {
        type: 'update_runtime_config',
        id: 'runtime-update-after-cwd',
        model: 'h1c-model-next',
      });
      expect(await waitFor(
        message => message.type === 'update_runtime_config_result'
          && message.id === 'runtime-update-after-cwd',
        'runtime config update after cwd finalize',
      )).toMatchObject({ success: true, updated: true });
      writeMessage(child, {
        type: 'token_update',
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'post-runtime-update-token' } },
      });
      const agentEndsBeforeRuntimeUpdatePrompt = messages.filter(
        message => message.type === 'event' && (message.event as JsonMessage)?.type === 'agent_end',
      ).length;
      writeMessage(child, { type: 'prompt', id: 'post-runtime-update-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && messages.filter(candidate => candidate.type === 'event'
            && (candidate.event as JsonMessage)?.type === 'agent_end').length > agentEndsBeforeRuntimeUpdatePrompt,
        'post-runtime-update agent_end',
      );
      await waitForLog(
        entry => entry.type === 'search_auth' && entry.key === 'post-runtime-update-token',
        'post-runtime-update token marker',
      );
      expect(readLog(markerPath)).toContainEqual(expect.objectContaining({
        type: 'search_auth',
        key: 'post-runtime-update-token',
      }));

      expect(await transaction('stale', 'prepare', 0, 1, failedCwd)).toMatchObject({
        success: false,
        errorMessage: 'Cwd prepare generation mismatch',
      });
      expect(await transaction('cwd-2', 'prepare', 1, 2, failedCwd, 120_000, false)).toMatchObject({ success: true });
      const failedCommit = await transaction('cwd-2', 'commit', 1, 2, failedCwd);
      expect(failedCommit).toMatchObject({ success: false });
      expect(String(failedCommit.errorMessage)).toContain('injected late commit publication failure');

      writeMessage(child, {
        type: 'token_update',
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'restored-token' } },
      });
      expect(await transaction('cwd-2', 'rollback', 1, 2, failedCwd)).toMatchObject({ success: true });
      const agentEndsBeforeWorkflowRollbackProbe = messages.filter(
        message => message.type === 'event' && (message.event as JsonMessage)?.type === 'agent_end',
      ).length;
      writeMessage(child, {
        type: 'prompt',
        id: 'workflow-rollback-probe',
        message: 'workflow rollback probe',
        systemPrompt: 'H1C',
        manifestGeneration,
        manifestHash: executionManifest.manifestHash,
      });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && messages.filter(candidate => candidate.type === 'event'
            && (candidate.event as JsonMessage)?.type === 'agent_end').length > agentEndsBeforeWorkflowRollbackProbe,
        'workflow rollback probe agent_end',
      );
      await waitForLog(
        entry => entry.type === 'workflow_recipe_result' && entry.sessionId === txnSessionId(readLog(markerPath), 2),
        'workflow rollback recipe marker',
      );
      expect(readLog(markerPath)).toContainEqual(expect.objectContaining({
        type: 'workflow_recipe_result',
        sessionId: txnSessionId(readLog(markerPath), 2),
        value: 'current',
      }));
      writeMessage(child, { type: 'prompt', id: 'restored-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && readLog(markerPath).some(entry => entry.type === 'search_auth' && entry.key === 'restored-token'),
        'restored-token search',
      );
      writeMessage(child, {
        type: 'token_update',
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'after-rollback-token' } },
      });
      writeMessage(child, { type: 'prompt', id: 'after-rollback-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && readLog(markerPath).some(entry => entry.type === 'search_auth' && entry.key === 'after-rollback-token'),
        'after-rollback-token search',
      );

      const postCommitRollbackCwd = join(root, 'post-commit-rollback-cwd');
      expect(await transaction('cwd-3', 'prepare', 1, 2, postCommitRollbackCwd)).toMatchObject({ success: true });
      expect(await transaction('cwd-3', 'commit', 1, 2, postCommitRollbackCwd)).toMatchObject({ success: true });
      writeMessage(child, {
        type: 'update_runtime_config',
        id: 'runtime-update-after-commit-before-rollback',
        model: 'h1c-runtime-after-commit',
      });
      writeMessage(child, { type: 'set_model', model: 'h1c-model-after-commit' });
      writeMessage(child, { type: 'set_thinking_level', level: 'low' });
      writeMessage(child, {
        type: 'token_update',
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'post-commit-rollback-token' } },
      });
      expect(await transaction('cwd-3', 'rollback', 1, 2, postCommitRollbackCwd)).toMatchObject({ success: true });
      expect(await waitFor(
        message => message.type === 'update_runtime_config_result'
          && message.id === 'runtime-update-after-commit-before-rollback',
        'runtime update after commit before rollback',
      )).toMatchObject({ success: true });
      await waitForLog(
        entry => entry.type === 'set_model'
          && entry.sessionId === txnSessionId(readLog(markerPath), 2)
          && entry.model === 'h1c-model-after-commit',
        'model update after rollback',
      );
      await waitForLog(
        entry => entry.type === 'set_thinking_level'
          && entry.sessionId === txnSessionId(readLog(markerPath), 2)
          && entry.level === 'low',
        'thinking update after rollback',
      );
      const agentEndsBeforePostCommitRollbackPrompt = messages.filter(
        message => message.type === 'event' && (message.event as JsonMessage)?.type === 'agent_end',
      ).length;
      writeMessage(child, { type: 'prompt', id: 'post-commit-rollback-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && messages.filter(candidate => candidate.type === 'event'
            && (candidate.event as JsonMessage)?.type === 'agent_end').length > agentEndsBeforePostCommitRollbackPrompt,
        'post-commit rollback prompt',
      );
      expect(readLog(markerPath).filter(
        entry => entry.type === 'prompt_state' && entry.sessionId === txnSessionId(readLog(markerPath), 2),
      ).at(-1)).toMatchObject({
        model: 'h1c-model-after-commit',
        thinkingLevel: 'low',
      });
      expect(readLog(markerPath)).toContainEqual(expect.objectContaining({
        type: 'search_auth',
        key: 'post-commit-rollback-token',
      }));

      expect(await transaction('cwd-4', 'prepare', 1, 2, terminalBarrierCwd, 15_000)).toMatchObject({ success: true });
      expect(await transaction('cwd-4', 'commit', 1, 2, terminalBarrierCwd, 15_000)).toMatchObject({ success: true });
      writeMessage(child, {
        type: 'update_runtime_config',
        id: 'runtime-update-token-race',
        model: 'h1c-runtime-token-race',
      });
      const finalizeWithTokenRace = transaction('cwd-4', 'finalize', 1, 2, terminalBarrierCwd, 15_000);
      await waitForLog(
        entry => entry.type === 'control_delay' && entry.name === 'terminal-token-race',
        'terminal token-race control delay',
        15_000,
      );
      writeMessage(child, {
        type: 'token_update',
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'ordered-token-t1' } },
      });
      writeFileSync(terminalControlReleasePath, 'release');
      expect(await finalizeWithTokenRace).toMatchObject({ success: true });
      expect(await waitFor(
        message => message.type === 'update_runtime_config_result'
          && message.id === 'runtime-update-token-race',
        'runtime update token race',
        15_000,
      )).toMatchObject({ success: true });
      const agentEndsBeforeTokenRacePrompt = messages.filter(
        message => message.type === 'event' && (message.event as JsonMessage)?.type === 'agent_end',
      ).length;
      writeMessage(child, { type: 'prompt', id: 'token-race-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && messages.filter(candidate => candidate.type === 'event'
            && (candidate.event as JsonMessage)?.type === 'agent_end').length > agentEndsBeforeTokenRacePrompt,
        'token-race prompt agent_end',
        15_000,
      );
      const tokenRaceAuth = readLog(markerPath).filter(entry => entry.type === 'search_auth').at(-1)?.key;

      const prepareFailure = transaction('cwd-5', 'prepare', 2, 3, prepareFailureCwd, 15_000);
      await waitForLog(
        entry => entry.type === 'prepare_failure_create_delayed',
        'prepare failure create delay',
        15_000,
      );
      writeMessage(child, {
        type: 'update_runtime_config',
        id: 'runtime-update-prepare-failure',
        model: 'h1c-runtime-prepare-failure-a',
      });
      // The control barrier is active while the prepare candidate is still
      // constructing (blocked on prepareFailureCreateReleasePath), so model A's
      // update_runtime_config above is deferred. Deferral is silent, so before
      // failing the prepare we round-trip an ungated get_context_usage probe:
      // stdin lines are dispatched in order and a deferred control pushes onto
      // the queue synchronously inside its dispatch, so once the probe's result
      // arrives, model A is guaranteed enqueued. Without this the createSession
      // release below could win the race, drain an EMPTY queue, clear the
      // barrier, and let model A (then model B) run un-deferred — the flake that
      // failed only under CI scheduling jitter (#T1 model-switch race).
      writeMessage(child, { type: 'get_context_usage', id: 'prepare-failure-enqueue-a' });
      await waitFor(
        message => message.type === 'context_usage_result'
          && message.id === 'prepare-failure-enqueue-a',
        'model A enqueued behind prepare barrier',
        15_000,
      );
      writeFileSync(prepareFailureCreateReleasePath, 'release');
      await waitForLog(
        entry => entry.type === 'control_delay' && entry.name === 'prepare-failure-a',
        'prepare failure control delay',
        15_000,
      );
      // Model A is now draining (its setModel is blocked on the control release),
      // so the barrier is still held. Enqueue model B and confirm it is deferred
      // the same way before sampling, so the "did B run early" check observes the
      // real ordering rather than a lost stdin race.
      writeMessage(child, { type: 'set_model', model: 'h1c-model-prepare-failure-b' });
      writeMessage(child, { type: 'get_context_usage', id: 'prepare-failure-enqueue-b' });
      await waitFor(
        message => message.type === 'context_usage_result'
          && message.id === 'prepare-failure-enqueue-b',
        'model B enqueued behind prepare barrier',
        15_000,
      );
      const beforeReleaseDeadline = Date.now() + 1_000;
      let modelBStartedBeforeRelease = false;
      while (Date.now() < beforeReleaseDeadline) {
        modelBStartedBeforeRelease = readLog(markerPath).some(
          entry => entry.type === 'set_model'
            && entry.sessionId === txnSessionId(readLog(markerPath), 5)
            && entry.model === 'h1c-model-prepare-failure-b',
        );
        if (modelBStartedBeforeRelease) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      writeFileSync(prepareFailureControlReleasePath, 'release');
      expect(await prepareFailure).toMatchObject({
        success: false,
        errorMessage: 'injected prepare construction failure',
      });
      expect(await waitFor(
        message => message.type === 'update_runtime_config_result'
          && message.id === 'runtime-update-prepare-failure',
        'runtime update after prepare failure',
        15_000,
      )).toMatchObject({ success: true });
      await waitForLog(
        entry => entry.type === 'set_model'
          && entry.sessionId === txnSessionId(readLog(markerPath), 5)
          && entry.model === 'h1c-model-prepare-failure-b',
        'post-prepare-failure model update',
        15_000,
      );
      const agentEndsBeforePrepareFailurePrompt = messages.filter(
        message => message.type === 'event' && (message.event as JsonMessage)?.type === 'agent_end',
      ).length;
      writeMessage(child, { type: 'prompt', id: 'prepare-failure-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && messages.filter(candidate => candidate.type === 'event'
            && (candidate.event as JsonMessage)?.type === 'agent_end').length > agentEndsBeforePrepareFailurePrompt,
        'prepare-failure prompt agent_end',
        15_000,
      );
      const prepareFailureModel = readLog(markerPath).filter(
        entry => entry.type === 'prompt_state' && entry.sessionId === txnSessionId(readLog(markerPath), 5),
      ).at(-1)?.model;

      expect({ tokenRaceAuth, modelBStartedBeforeRelease, prepareFailureModel }).toEqual({
        tokenRaceAuth: 'ordered-token-t1',
        modelBStartedBeforeRelease: false,
        prepareFailureModel: 'h1c-model-prepare-failure-b',
      });

      expect(await transaction('cwd-6', 'prepare', 2, 3, reinitRaceCwd, 15_000)).toMatchObject({ success: true });
      expect(await transaction('cwd-6', 'commit', 2, 3, reinitRaceCwd, 15_000)).toMatchObject({ success: true });
      writeMessage(child, {
        type: 'update_runtime_config',
        id: 'runtime-update-reinit-race',
        model: 'h1c-runtime-reinit-race',
      });
      const finalizeDuringReinit = transaction('cwd-6', 'finalize', 2, 3, reinitRaceCwd, 15_000);
      await waitForLog(
        entry => entry.type === 'control_delay' && entry.name === 'reinit-race',
        're-init race control delay',
        15_000,
      );
      const readyCountBeforeReinit = messages.filter(message => message.type === 'ready').length;
      writeMessage(child, {
        type: 'init',
        apiKey: '',
        model: 'h1c-reinit-model',
        cwd: oldCwd,
        workingDirectory: oldCwd,
        workspaceRootPath: root,
        workspaceId: 'h1c-workspace',
        sessionId: 'h1c-runtime',
        sessionPath,
        plansFolderPath: join(sessionPath, 'plans'),
        thinkingLevel: 'low',
        deferredMcpToolLoading: true,
        executionManifest,
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'h1c-reinit-token' } },
      });
      const readyBeforeReleaseDeadline = Date.now() + 1_000;
      let readyBeforeRelease = false;
      while (Date.now() < readyBeforeReleaseDeadline) {
        readyBeforeRelease = messages.filter(message => message.type === 'ready').length > readyCountBeforeReinit;
        if (readyBeforeRelease) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      writeFileSync(reinitControlReleasePath, 'release');
      await waitFor(
        message => message.type === 'ready'
          && messages.filter(candidate => candidate.type === 'ready').length > readyCountBeforeReinit,
        'ready after re-init control quiescence',
        15_000,
      );
      await finalizeDuringReinit;
      writeMessage(child, { type: 'ensure_session_ready', id: 'reinit-session' });
      const reinitSession = await waitFor(
        message => message.type === 'ensure_session_ready_result' && message.id === 'reinit-session',
        'reinitialized session',
        15_000,
      );
      const reinitSessionId = Number(String(reinitSession.sessionId).split('-').at(-1));
      const agentEndsBeforeReinitPrompt = messages.filter(
        message => message.type === 'event' && (message.event as JsonMessage)?.type === 'agent_end',
      ).length;
      writeMessage(child, { type: 'prompt', id: 'reinit-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && messages.filter(candidate => candidate.type === 'event'
            && (candidate.event as JsonMessage)?.type === 'agent_end').length > agentEndsBeforeReinitPrompt,
        'reinitialized prompt agent_end',
        15_000,
      );
      const reinitLog = readLog(markerPath);
      expect({
        readyBeforeRelease,
        createdModel: reinitLog.filter(
          entry => entry.type === 'session_create' && entry.sessionId === reinitSessionId,
        ).at(-1)?.model,
        promptModel: reinitLog.filter(
          entry => entry.type === 'prompt_state' && entry.sessionId === reinitSessionId,
        ).at(-1)?.model,
        auth: reinitLog.filter(entry => entry.type === 'search_auth').at(-1)?.key,
      }).toEqual({
        readyBeforeRelease: false,
        createdModel: 'h1c-reinit-model',
        promptModel: 'h1c-reinit-model',
        auth: 'h1c-reinit-token',
      });

      const terminalOwnerRaceCwd = join(root, 'terminal-owner-race-cwd');
      expect(await transaction('cwd-7', 'prepare', 0, 1, terminalOwnerRaceCwd, 15_000)).toMatchObject({ success: true });
      expect(await transaction('cwd-7', 'commit', 0, 1, terminalOwnerRaceCwd, 15_000)).toMatchObject({ success: true });
      writeMessage(child, {
        type: 'update_runtime_config',
        id: 'runtime-update-terminal-owner',
        model: 'h1c-runtime-terminal-owner',
      });
      const terminalOwnerFinalize = transaction('cwd-7', 'finalize', 0, 1, terminalOwnerRaceCwd, 15_000);
      await waitForLog(
        entry => entry.type === 'control_delay' && entry.name === 'terminal-owner',
        'terminal owner control delay',
        15_000,
      );
      const competingRollback = await transaction('cwd-7', 'rollback', 0, 1, terminalOwnerRaceCwd, 15_000);
      writeFileSync(terminalOwnerControlReleasePath, 'release');
      const terminalOwnerFinalizeResult = await terminalOwnerFinalize;
      await waitFor(
        message => message.type === 'update_runtime_config_result'
          && message.id === 'runtime-update-terminal-owner',
        'terminal owner runtime update',
        15_000,
      );
      const agentEndsBeforeTerminalOwnerPrompt = messages.filter(
        message => message.type === 'event' && (message.event as JsonMessage)?.type === 'agent_end',
      ).length;
      writeMessage(child, { type: 'prompt', id: 'terminal-owner-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && messages.filter(candidate => candidate.type === 'event'
            && (candidate.event as JsonMessage)?.type === 'agent_end').length > agentEndsBeforeTerminalOwnerPrompt,
        'terminal owner prompt agent_end',
        15_000,
      );
      const terminalOwnerLog = readLog(markerPath);
      const terminalOwnerPrompt = terminalOwnerLog.filter(entry => entry.type === 'prompt_state').at(-1);
      const terminalOwnerOutcome = {
        competingRollbackSuccess: competingRollback.success,
        finalizeSuccess: terminalOwnerFinalizeResult.success,
        promptSessionId: terminalOwnerPrompt?.sessionId,
        promptModel: terminalOwnerPrompt?.model,
        auth: terminalOwnerLog.filter(entry => entry.type === 'search_auth').at(-1)?.key,
        previousDisposed: terminalOwnerLog.some(entry => entry.type === 'dispose' && entry.sessionId === txnSessionId(terminalOwnerLog, 8)),
        candidateDisposed: terminalOwnerLog.some(entry => entry.type === 'dispose' && entry.sessionId === txnSessionId(terminalOwnerLog, 9)),
      };

      const readyCountBeforeTerminalReset = messages.filter(message => message.type === 'ready').length;
      writeMessage(child, {
        type: 'init',
        apiKey: '',
        model: 'h1c-terminal-reset-model',
        cwd: oldCwd,
        workingDirectory: oldCwd,
        workspaceRootPath: root,
        workspaceId: 'h1c-workspace',
        sessionId: 'h1c-runtime',
        sessionPath,
        plansFolderPath: join(sessionPath, 'plans'),
        thinkingLevel: 'low',
        deferredMcpToolLoading: true,
        executionManifest,
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'h1c-terminal-reset-token' } },
      });
      await waitFor(
        message => message.type === 'ready'
          && messages.filter(candidate => candidate.type === 'ready').length > readyCountBeforeTerminalReset,
        'ready after terminal owner reset',
        15_000,
      );
      writeMessage(child, { type: 'ensure_session_ready', id: 'terminal-reset-session' });
      expectFreshReadySession(await waitFor(
        message => message.type === 'ensure_session_ready_result' && message.id === 'terminal-reset-session',
        'terminal reset session',
        15_000,
      ));

      const rollbackReinitCwd = join(root, 'rollback-reinit-cwd');
      expect(await transaction('cwd-8', 'prepare', 0, 1, rollbackReinitCwd, 15_000)).toMatchObject({ success: true });
      expect(await transaction('cwd-8', 'commit', 0, 1, rollbackReinitCwd, 15_000)).toMatchObject({ success: true });
      writeMessage(child, {
        type: 'update_runtime_config',
        id: 'runtime-update-rollback-reinit',
        model: 'h1c-runtime-rollback-reinit',
      });
      const rollbackDuringReinit = transaction('cwd-8', 'rollback', 0, 1, rollbackReinitCwd, 15_000);
      await waitForLog(
        entry => entry.type === 'control_delay' && entry.name === 'rollback-reinit',
        'rollback re-init control delay',
        15_000,
      );
      const readyCountBeforeRollbackReinit = messages.filter(message => message.type === 'ready').length;
      writeMessage(child, {
        type: 'init',
        apiKey: '',
        model: 'h1c-rollback-reinit-model',
        cwd: oldCwd,
        workingDirectory: oldCwd,
        workspaceRootPath: root,
        workspaceId: 'h1c-workspace',
        sessionId: 'h1c-runtime',
        sessionPath,
        plansFolderPath: join(sessionPath, 'plans'),
        thinkingLevel: 'off',
        deferredMcpToolLoading: true,
        executionManifest,
        piAuth: { provider: 'h1c-provider', credential: { type: 'api_key', key: 'h1c-rollback-reinit-token' } },
      });
      const rollbackReadyBeforeReleaseDeadline = Date.now() + 1_000;
      let rollbackReadyBeforeRelease = false;
      while (Date.now() < rollbackReadyBeforeReleaseDeadline) {
        rollbackReadyBeforeRelease = messages.filter(message => message.type === 'ready').length > readyCountBeforeRollbackReinit;
        if (rollbackReadyBeforeRelease) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      writeFileSync(rollbackReinitControlReleasePath, 'release');
      const rollbackDuringReinitResult = await rollbackDuringReinit;
      await waitFor(
        message => message.type === 'ready'
          && messages.filter(candidate => candidate.type === 'ready').length > readyCountBeforeRollbackReinit,
        'ready after rollback re-init',
        15_000,
      );
      writeMessage(child, { type: 'ensure_session_ready', id: 'rollback-reinit-session' });
      expectFreshReadySession(await waitFor(
        message => message.type === 'ensure_session_ready_result' && message.id === 'rollback-reinit-session',
        'rollback re-init session',
        15_000,
      ));
      const agentEndsBeforeRollbackReinitPrompt = messages.filter(
        message => message.type === 'event' && (message.event as JsonMessage)?.type === 'agent_end',
      ).length;
      writeMessage(child, { type: 'prompt', id: 'rollback-reinit-prompt', message: 'probe', systemPrompt: 'H1C', manifestGeneration, manifestHash: executionManifest.manifestHash });
      await waitFor(
        message => message.type === 'event'
          && (message.event as JsonMessage)?.type === 'agent_end'
          && messages.filter(candidate => candidate.type === 'event'
            && (candidate.event as JsonMessage)?.type === 'agent_end').length > agentEndsBeforeRollbackReinitPrompt,
        'rollback re-init prompt agent_end',
        15_000,
      );
      const rollbackReinitLog = readLog(markerPath);
      expect({
        terminalOwnerOutcome,
        rollbackReadyBeforeRelease,
        rollbackSuccess: rollbackDuringReinitResult.success,
        previousDisposeCount: rollbackReinitLog.filter(
          entry => entry.type === 'dispose' && entry.sessionId === txnSessionId(readLog(markerPath), 10),
        ).length,
        candidateDisposeCount: rollbackReinitLog.filter(
          entry => entry.type === 'dispose' && entry.sessionId === txnSessionId(readLog(markerPath), 11),
        ).length,
        promptSessionId: rollbackReinitLog.filter(entry => entry.type === 'prompt_state').at(-1)?.sessionId,
        promptModel: rollbackReinitLog.filter(entry => entry.type === 'prompt_state').at(-1)?.model,
        auth: rollbackReinitLog.filter(entry => entry.type === 'search_auth').at(-1)?.key,
      }).toEqual({
        terminalOwnerOutcome: {
          competingRollbackSuccess: false,
          finalizeSuccess: true,
          promptSessionId: txnSessionId(rollbackReinitLog, 9),
          promptModel: 'h1c-runtime-terminal-owner',
          auth: 'h1c-reinit-token',
          previousDisposed: true,
          candidateDisposed: false,
        },
        rollbackReadyBeforeRelease: false,
        rollbackSuccess: false,
        previousDisposeCount: 1,
        candidateDisposeCount: 1,
        promptSessionId: txnSessionId(rollbackReinitLog, 12),
        promptModel: 'h1c-rollback-reinit-model',
        auth: 'h1c-rollback-reinit-token',
      });

      const log = readLog(markerPath);
      // The lifecycle claim, kept in full and no longer keyed to ordinals: these
      // twelve sessions, in this order, on these directories, with these
      // strategies. Only the identification changed — a rebuild is not a
      // transaction event and no longer shifts what this row names.
      expect(transactionSessions(log)).toEqual([
        expect.objectContaining({ cwd: oldCwd, strategy: expect.objectContaining({ kind: 'continue' }) }),
        expect.objectContaining({ cwd: nextCwd, strategy: expect.objectContaining({ kind: 'reopen', sessionFile: '/tmp/h1c-active-session.jsonl' }) }),
        expect.objectContaining({ cwd: failedCwd, strategy: expect.objectContaining({ kind: 'reopen', sessionFile: '/tmp/h1c-active-session.jsonl' }) }),
        expect.objectContaining({ cwd: postCommitRollbackCwd, strategy: expect.objectContaining({ kind: 'reopen', sessionFile: '/tmp/h1c-active-session.jsonl' }) }),
        expect.objectContaining({ cwd: terminalBarrierCwd, strategy: expect.objectContaining({ kind: 'reopen', sessionFile: '/tmp/h1c-active-session.jsonl' }) }),
        expect.objectContaining({ cwd: prepareFailureCwd, strategy: expect.objectContaining({ kind: 'reopen', sessionFile: '/tmp/h1c-active-session.jsonl' }) }),
        expect.objectContaining({ cwd: reinitRaceCwd, strategy: expect.objectContaining({ kind: 'reopen', sessionFile: '/tmp/h1c-active-session.jsonl' }) }),
        expect.objectContaining({ cwd: oldCwd, strategy: expect.objectContaining({ kind: 'continue' }) }),
        expect.objectContaining({ cwd: terminalOwnerRaceCwd, strategy: expect.objectContaining({ kind: 'reopen', sessionFile: '/tmp/h1c-active-session.jsonl' }) }),
        expect.objectContaining({ cwd: oldCwd, strategy: expect.objectContaining({ kind: 'continue' }) }),
        expect.objectContaining({ cwd: rollbackReinitCwd, strategy: expect.objectContaining({ kind: 'reopen', sessionFile: '/tmp/h1c-active-session.jsonl' }) }),
        expect.objectContaining({ cwd: oldCwd, strategy: expect.objectContaining({ kind: 'continue' }) }),
      ]);
      expect(log).toContainEqual(expect.objectContaining({ type: 'auth_set', registryId: 2, key: 'prepared-token' }));
      expect(log).toContainEqual(expect.objectContaining({ type: 'auth_set', registryId: 2, key: 'committed-token' }));
      expect(log).toContainEqual(expect.objectContaining({ type: 'auth_set', registryId: 2, key: 'restored-token' }));
      expect(log).toContainEqual(expect.objectContaining({ type: 'late_candidate_load', sessionId: txnSessionId(log, 3) }));
      expect(log).toContainEqual(expect.objectContaining({ type: 'dispose', sessionId: txnSessionId(log, 1) }));
      expect(log).toContainEqual(expect.objectContaining({ type: 'dispose', sessionId: txnSessionId(log, 3) }));
      const finalSessionTwoPrompt = log.filter(
        entry => entry.type === 'prompt_state' && entry.sessionId === txnSessionId(readLog(markerPath), 2),
      ).at(-1);
      expect(finalSessionTwoPrompt).toMatchObject({
        type: 'prompt_state',
        sessionId: txnSessionId(log, 2),
        model: 'h1c-model-after-commit',
        thinkingLevel: 'low',
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        writeMessage(child, { type: 'shutdown' });
        await Promise.race([
          new Promise<void>(resolve => child.once('exit', () => resolve())),
          new Promise<void>(resolve => setTimeout(resolve, 2_000)),
        ]);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      lines.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, realServerTestBudget(120_000)); // F1.641: the boot, then the old 180 s (120 s of answers + teardown)
});
