import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const selectedPiEvents = [
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'session_info_changed',
  'thinking_level_changed',
  'auto_retry_start',
  'auto_retry_end',
  // Added by Pi 0.83/0.84. The subprocess forwards session events unfiltered
  // and the host adapter's `default` arm yields `{type:'error'}`, so each of
  // these needs a case in `backend/pi/event-adapter.ts` or the user gets an
  // error banner — `agent_settled` and `entry_appended` on every single turn.
  'agent_settled',
  'entry_appended',
  'bash_execution_update',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
].sort();

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function eventTypes(input: string): string[] {
  return [...input.matchAll(/type: "([a-z_]+)"/g)].map(match => match[1]!);
}

describe('Pi 0.84.3 runtime protocol', () => {
  it('pins the exact selected AgentSessionEvent surface', () => {
    const core = source('../../../../node_modules/@earendil-works/pi-agent-core/dist/types.d.ts');
    const session = source('../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts');
    const coreUnion = core.slice(core.indexOf('export type AgentEvent ='), core.indexOf('//# sourceMappingURL', core.indexOf('export type AgentEvent =')));
    const sessionUnion = session.slice(session.indexOf('export type AgentSessionEvent ='), session.indexOf('export type AgentSessionEventListener'));

    expect([...new Set([...eventTypes(coreUnion), ...eventTypes(sessionUnion)])].sort())
      .toEqual(selectedPiEvents);
  });

  it('removes speculative call_llm execution so the normal wrapper owns dispatch', () => {
    const server = source('../index.ts');
    const proxyStart = server.indexOf('function buildProxyTools()');
    const proxyEnd = server.indexOf('// LLM Query', proxyStart);
    const proxy = server.slice(proxyStart, proxyEnd);

    expect(server).not.toContain('PREFETCHABLE_TOOLS');
    expect(server).not.toContain('prefetchCache');
    expect(server).not.toContain('callLlmApprovalReceipts');
    expect(proxy).not.toContain('prefetch');
    expect(server).toContain('const toolExecutor = createExecutor');
    expect(server).toContain('createPiSdkToolAdapter({');
    expect(server).toContain('ports,');
    expect(server).toContain('createExecutor(cwd, executorPorts)');
    expect(server).toContain('configureSpawnerForGeneration(config, manifest);');
  });

  it('routes durable child orchestration over the host port without a child-side session constructor', () => {
    const server = source('../index.ts');
    const spawner = source('../orchestrator/spawner.ts');
    const tools = source('../orchestrator/subagent-tool.ts');
    expect(server).toContain("type: 'child_session_request'");
    expect(server).toContain("type: 'child_session_response'");
    expect(server).toContain('createGetSubagentResultTool(childSessionPort)');
    expect(server).toContain('createSteerSubagentTool(childSessionPort)');
    expect(spawner).toContain('startWithAbort(cfg.childSessionPort, {');
    expect(spawner).not.toContain('createPiRuntimeSession');
    expect(tools).toContain("name: 'get_subagent_result'");
    expect(tools).toContain("name: 'steer_subagent'");
  });

  it('binds register_tools and prompt atomically to one manifest identity', () => {
    const server = source('../index.ts');
    const inboundStart = server.indexOf('type InboundMessage =');
    const inboundEnd = server.indexOf('interface ProxyToolDef', inboundStart);
    const inbound = server.slice(inboundStart, inboundEnd);
    const registerStart = server.indexOf('function handleRegisterTools');
    const registerEnd = server.indexOf('\n}', registerStart) + 2;
    const register = server.slice(registerStart, registerEnd);
    const promptStart = server.indexOf('async function handlePrompt');
    const promptEnd = server.indexOf('\nasync function handleEnsureSessionReady', promptStart);
    const prompt = server.slice(promptStart, promptEnd);

    expect(inbound).toContain("type: 'register_tools'; id: string; tools: ProxyToolDef[]; manifest: PiExecutionManifestV2; previous: { generation: string; manifestHash: string }")
    expect(inbound).toContain("type: 'prompt'; id: string; message: string; systemPrompt: string; autoCompactionInstructions?: string; manifestGeneration: string; manifestHash: string")
    expect(register).toContain('preparePiManifestRegistration')
    expect(register).toContain('previous: msg.previous')
    expect(register).toContain('activeExecutionManifest = prepared.manifest')
    expect(register.indexOf('preparePiManifestRegistration')).toBeLessThan(register.indexOf('activeExecutionManifest = prepared.manifest'))
    expect(register).toContain("type: 'register_tools_result'")
    expect(prompt).toContain('assertPiExecutionManifestIdentity')
    expect(prompt.indexOf('assertPiExecutionManifestIdentity')).toBeLessThan(prompt.indexOf('session.prompt('))
  })

  it('publishes manifest definitions before startup controls can create a session', () => {
    const host = source('../../../shared/src/agent/pi-agent.ts');
    const start = host.indexOf('async spawnSubprocess(');
    const end = host.indexOf('private buildCurrentProxyToolDefinitions', start);
    const startup = host.slice(start, end);

    expect(host).toContain('autoCompactionInstructions: composePiCompactionInstructions(');
    expect(startup.indexOf('await this.publishExecutionManifest(execution, execution.manifest)')).toBeGreaterThanOrEqual(0);
    expect(startup.indexOf('await this.publishExecutionManifest(execution, execution.manifest)'))
      .toBeLessThan(startup.indexOf('this.requestSetAutoCompaction(autoCompaction, true)'));
  })

  it('commits host authority only after a current-owner registration acknowledgement', () => {
    const host = source('../../../shared/src/agent/pi-agent.ts');
    const start = host.indexOf('private async publishExecutionManifest');
    const end = host.indexOf('private async syncExecutionManifestForCurrentTurn', start);
    const publish = host.slice(start, end);

    expect(publish).toContain('const accepted = await registered')
    expect(publish.indexOf('const accepted = await registered'))
      .toBeLessThan(publish.indexOf('this.activeExecutionManifest = execution.manifest'))
    expect(publish).toContain('responseEpoch !== this.subprocessResponseEpoch')
    expect(publish).toContain('this.assertCurrentSubprocessAttempt(sourceAttempt)')
    expect(publish).toContain('materializer.assertActive()')
    expect(publish).toContain('this.capabilityTurnRuntime !== runtime')
    expect(publish).toContain('this.lastExecutionManifestIdentity = accepted')
  })

  it('keeps configured deferred MCP discovery in the manifest projection path', () => {
    const server = source('../index.ts');
    const start = server.indexOf('function buildSessionDefinition(');
    const end = server.indexOf('\nasync function ensureSession', start);
    const definition = server.slice(start, end);

    expect(definition).toContain('const proxyToolSurface = buildDeferredMcpToolSurface({');
    expect(definition).toContain('proxyTools,');
    expect(definition).toContain('loadedToolNames: deferredMcpLoadedToolNames');
    expect(definition).toContain('deferredMcpRegistration?.register(name)');
    expect(definition).toContain('createDeferredMcpRegistrationController({');
    expect(definition).toContain('const proxySemanticPorts = createPiToolExecutionPorts(proxyTools');
    expect(definition).not.toContain('await ensureSession()');
    expect(definition).toContain('definitions,');
    expect(definition).not.toContain('activeExecutionManifest\n    ? { enabled: false');
    expect(definition).not.toContain(': definitions;');
  })

  it('routes every child process request through the supervised host protocol', () => {
    const server = source('../index.ts');
    const background = source('../tools/background-bash.ts');
    const host = source('../../../shared/src/agent/pi-agent.ts');

    expect(server).toContain("type: 'process_start_request'")
    expect(server).toContain("type: 'process_cancel_request'")
    expect(server).toContain("type: 'tool_execute_cancel'")
    expect(host).toContain("case 'tool_execute_cancel':")
    expect(server).toContain('runCommand: async (command, commandCwd, options) =>')
    expect(server).toContain('const BACKGROUND_PROCESS_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000')
    expect(background).not.toContain("from 'node:child_process'")
    expect(background).not.toContain('backgroundBashProcesses')
    expect(background).not.toContain('backgroundBashOutputBuffers')
    expect(host).toContain('this.config.processSupervisorPort')
    expect(host).not.toContain("type: 'bash_output',")
  })

  it('validates and consumes each serialized permission receipt once', () => {
    const server = source('../index.ts');
    const host = source('../../../shared/src/agent/pi-agent.ts');
    const start = server.indexOf('async permissionBridge(request, canonicalInput)');
    const end = server.indexOf('async beforeDispatch', start);
    const bridge = server.slice(start, end);

    expect(bridge).toContain('const rawReceipt = await requestPiPermissionReceipt(')
    expect(bridge).toContain('parseAndFreezePiPermissionReceipt(rawReceipt, {')
    expect(bridge).toContain('consumedPermissionDecisionIds.has(receipt.decisionId)')
    expect(bridge).toContain('consumedPermissionDecisionIds.add(receipt.decisionId)')
    expect(bridge).toContain("allowed: receipt.outcome === 'allow'")
    expect(bridge).toContain("contextProfile: generationConfig.contextProfile ?? 'bare'")
    expect(server).toContain('contextProfile: msg.contextProfile ?? \'bare\'')
    expect(host).toContain("contextProfile: this.config.contextProfile ?? 'bare'")
    expect(server).toContain("if (!response.receipt) throw new Error(")
  })

  it('wraps the production Pi executor dispatch with descriptor-driven checkpoint finalization', () => {
    const server = source('../index.ts');
    const start = server.indexOf('const createExecutor = (');
    const end = server.indexOf('const executorPorts =', start);
    const executor = server.slice(start, end);

    expect(executor).toContain('async beforeDispatch(request, descriptor, canonicalInput)')
    expect(executor).toContain('if (!generationConfig.sessionPath || !descriptor.checkpointAdapter) return')
    expect(executor).toContain('checkpointIntents.set(request.executionId, {')
    expect(executor).toContain('createRuntime(runtimeCwd, async ({ call, canonicalPath })')
    expect(executor).toContain('adapter: descriptor.checkpointAdapter')
    expect(executor).toContain('authorizedTarget,')
    expect(executor).toContain("runtime.authorizePath(target, 'write')")
    expect(executor).toContain('pendingCheckpoints.set(executionId, {')
    expect(executor).toContain('async afterDispatch(request, _descriptor, _canonicalInput, outcome)')
    expect(executor).toContain('await finalizeFileCheckpoint({')
    expect(executor).toContain('succeeded: Boolean(outcome.result && !outcome.result.isError)')
  })

  it('projects only redacted execution receipt summaries to the host', () => {
    const server = source('../index.ts');
    const host = source('../../../shared/src/agent/pi-agent.ts');
    expect(server).toContain("interface OutboundExecutionReceipt { type: 'execution_receipt'; receipt: SafeExecutionReceiptInputV1 }")
    expect(server).toContain("onReceipt: receipt => send({ type: 'execution_receipt', receipt: summarizeExecutionReceipt(receipt) })")
    expect(host).toContain("case 'execution_receipt':")
    expect(host).toContain('parseSafeExecutionReceiptInput(msg.receipt)')
  })

  it('keeps cwd candidate lifecycle events closed until successful finalize', () => {
    const server = source('../index.ts');
    const bridge = source('../extensions/lifecycle-bridge.ts');

    expect(server).toContain('const candidateLifecycleGate = createPiLifecycleSinkGate(')
    expect(server).toContain('lifecycleEventSink: candidateLifecycleGate.emit')
    expect(server).toContain('transaction.candidate.lifecycleGate.open()')
    expect(bridge).toContain('if (open) await emit(event, input)')
  })

  it('resolves manifest tools for projected piNames and raw proxy bindingNames', () => {
    // The two NATIVE bindings diverge on purpose (piName `notebook_edit` vs
    // bindingName `NotebookEdit`; `stop_task` vs `stopTask` — Pi's own wire name
    // on one axis, the documented spelling on the other). Raw proxy definitions
    // keep the bindingName while projected definitions present the piName, so
    // every presentedName lookup must accept both or real sessions crash with
    // "Missing manifest tool"/"Non-advertised Pi tool spelling" on the first
    // prompt or proxy permission request.
    //
    // The example used to be a SESSION binding (`mcp__session__submit_plan` vs
    // `mcp__session__SubmitPlan`); the wire-name unification collapsed those two
    // axes onto the registry id, so session tools no longer exercise the union
    // and the rule now stands on the natives alone. It still has to hold: a
    // lookup keyed on one axis resolves `notebook_edit` and throws on
    // `NotebookEdit`, or the reverse.
    const server = source('../index.ts');
    const manifestModule = source('../harness/tool-manifest.ts');
    const unionStart = manifestModule.indexOf('function findPiManifestToolsByPresentedName');
    const union = manifestModule.slice(unionStart, manifestModule.indexOf('\n}', unionStart));

    // The union rule has exactly ONE home, in the harness module.
    expect(unionStart).toBeGreaterThan(-1)
    expect(union).toContain('value.binding.piName === presentedName')
    expect(union).toContain('value.binding.bindingName === presentedName')
    expect([...manifestModule.matchAll(/binding\.piName === presentedName/g)].length).toBe(1)
    // All presentedName resolution sites route through the union helper: the
    // executor semantic-id resolver, permission receipt parsing, the permission
    // bridge receipt binding, and the pre-tool-use receipt request.
    expect([...server.matchAll(/findManifestToolByPresentedName\(/g)].length).toBe(5)
    // ...and the local wrapper only delegates, so no single-axis lookup survives
    // in the runtime entrypoint.
    expect(server).toContain('return findPiManifestToolByPresentedName(manifest, presentedName);')
    expect(server).not.toContain('manifest.tools.find(value => value.binding.piName === ')

    // The same union, expressed over the static binding registry, is what the
    // execution ports index definitions by — the raw definitions they are built
    // from carry the bindingName while requests carry the piName.
    const wrapper = source('../local-tools/tool-wrapper.ts');
    expect(wrapper).toContain('for (const presentedName of piToolPresentedNames(tool.name))')

    const descriptors = source('../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts');
    expect(descriptors).toContain("sessionBinding('submit_plan', 'SubmitPlan')")
    expect(descriptors).toContain('export function piToolPresentedNames(')
  })
});
