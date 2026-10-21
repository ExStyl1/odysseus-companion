/**
 * Test utilities for agent tests
 *
 * Provides mock factories and helpers for testing agent implementations.
 */

import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig, CapabilityTurnRuntime, ChatOptions } from '../backend/types.ts';
import { AbortReason } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import type { ResolvedWorkspace as Workspace } from '../../workspaces/types.ts';
import type { SessionConfig as Session } from '../../sessions/storage.ts';
import type { LoadedSource } from '../../sources/types.ts';
import type { AgentEvent as AutomationAgentEvent } from '../../automations/types.ts';
import { BaseAgent, type SkillForkOutcome, type SkillForkRequest } from '../base-agent.ts';

// ============================================================
// Mock Workspace Factory
// ============================================================

/**
 * Create a mock Workspace object for testing.
 */
export function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'test-workspace-id',
    workspaceRootPath: '/test/workspace',
    sessionRootPath: '/test/sessions/test-workspace-id',
    config: {
      id: 'test-workspace-id',
      name: 'Test Workspace',
      createdAt: 1,
      updatedAt: 1,
    },
    lastAccessedAt: 1,
    ...overrides,
  };
}

// ============================================================
// Mock Session Factory
// ============================================================

/**
 * Create a mock Session object for testing.
 */
export function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-id',
    name: 'Test Session',
    workspaceId: 'test-workspace-id',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    permissionMode: 'default',
    ...overrides,
  };
}

// ============================================================
// Mock Source Factory
// ============================================================

/**
 * Create a mock LoadedSource object for testing.
 */
export function createMockSource(overrides: Partial<LoadedSource['config']> = {}): LoadedSource {
  return {
    config: {
      id: 'test-source-id',
      name: 'Test Source',
      slug: 'test-source',
      enabled: true,
      provider: 'test',
      type: 'mcp',
      ...overrides,
    },
    guide: null,
    folderPath: '/test/source',
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-workspace-id',
  };
}

// ============================================================
// Mock BackendConfig Factory
// ============================================================

/**
 * Create a mock BackendConfig for testing.
 */
export function createMockBackendConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: createMockWorkspace(),
    session: createMockSession(),
    model: 'test-model',
    thinkingLevel: 'medium',
    isHeadless: true, // Headless mode to avoid config watcher
    ...overrides,
  };
}

/**
 * The minimum live-shaped capability turn.
 *
 * **`BaseAgent.chat()` REFUSES to run without one** —
 * `extractSkillInvocations` throws `capability-turn-runtime-required` — so any
 * test that drives the shared `chat()` template must install this first. That
 * is not optional plumbing and it is easy to miss: three tests in
 * `runtime-handoff-context.test.ts` shipped red for exactly this reason, and
 * this helper exists so the next one does not.
 *
 * Even with no layers at all the pinned block is
 * `<capability-generation>…</capability-generation>`, so a real send always
 * reaches `chatImpl` with something composed ahead of the user's text.
 */
export function createMockCapabilityTurnRuntime(
  overrides: { workspaceId?: string; sessionId?: string; provider?: string } = {},
): CapabilityTurnRuntime {
  const manifestSeed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-test-1',
    sessionKey: {
      workspaceId: overrides.workspaceId ?? 'test-workspace',
      sessionId: overrides.sessionId ?? 'test-session',
    },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  };
  return {
    provider: overrides.provider ?? 'pi',
    view: {
      generation: manifestSeed.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [],
      apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(resource: unknown) { return (resource as { absolutePath: string }).absolutePath; },
      async readText() { return ''; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
    piExecutionManifestSeed: manifestSeed,
  } as CapabilityTurnRuntime;
}

// ============================================================
// TestAgent - Concrete BaseAgent for Testing
// ============================================================

/**
 * Concrete implementation of BaseAgent for testing.
 * Provides minimal implementations of abstract methods.
 */
export class TestAgent extends BaseAgent {
  protected backendName = 'Test';
  // Track calls for verification
  public chatCalls: Array<{ message: string; attachments?: unknown[]; options?: ChatOptions }> = [];
  public abortCalls: Array<{ reason?: string }> = [];
  public forceAbortCalls: Array<{ reason: AbortReason }> = [];
  public respondToPermissionCalls: Array<{ requestId: string; allowed: boolean; alwaysAllow?: boolean }> = [];

  private _isProcessing: boolean = false;

  /**
   * When set, `chatImpl` yields exactly these events instead of the default
   * single `complete`. Lets a test drive the shared `chat()` template method
   * with a scripted backend stream.
   */
  public scriptedEvents: AgentEvent[] | null = null;

  /**
   * Whether `chatImpl` confirms that the composed message reached the model, the
   * way a real backend does at its send seam (`PiAgent`'s `send({type:'prompt'})`).
   *
   * Off by default so the default `TestAgent` models a backend that has NOT
   * opted in: the pinned capability block then rides every turn exactly as it
   * did before, which is what most tests here assume.
   */
  public confirmsPinnedCapabilityDelivery = false;

  constructor(config: BackendConfig) {
    super(config, 'test-model', 100_000);
  }

  getMcpPreToolUseContextForTest() {
    return this.getMcpPreToolUseContext();
  }

  runSessionStartAutomationForTest() {
    return this.emitAutomationEvent('SessionStart', { hook_event_name: 'SessionStart' });
  }

  runAutomationForTest(event: AutomationAgentEvent) {
    return this.emitAutomationEvent(event, { hook_event_name: event });
  }

  /** P6.300 — the same seam with a caller-supplied payload. */
  emitAutomationEventForTest(event: AutomationAgentEvent, input: Record<string, unknown>) {
    return this.emitAutomationEvent(event, input as never);
  }

  resolveActivePluginSkillRuntimeForProcessForTest(command: string, args: readonly string[] = []) {
    return this.resolveActivePluginSkillRuntimeForProcess(command, args);
  }

  getActiveSkillContinuationReferencesForTest() {
    return this.getActiveSkillContinuationReferences();
  }

  extractModelSkillInvocationsForTest(assistantText: string) {
    return this.extractModelSkillInvocations(assistantText);
  }

  extractSkillInvocationsForTest(message: string) {
    return this.extractSkillInvocations(message);
  }

  /** Every `context: fork` dispatch this agent was asked to start (skills.md:569). */
  public skillForkCalls: SkillForkRequest[] = [];

  /**
   * What {@link startSkillFork} answers with.
   *
   * `null` — the default — models a backend with NO child-session spawner, which
   * is what `BaseAgent` itself is. A test opts in to a working fork by setting
   * a responder, so nothing here can accidentally make the base class look like
   * it can spawn.
   */
  public skillForkResponder:
    | ((request: SkillForkRequest) => Promise<SkillForkOutcome | null> | SkillForkOutcome | null)
    | null = null;

  protected override async startSkillFork(request: SkillForkRequest): Promise<SkillForkOutcome | null> {
    this.skillForkCalls.push(request);
    return this.skillForkResponder ? await this.skillForkResponder(request) : null;
  }

  protected async *chatImpl(
    message: string,
    attachments?: unknown[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    this.chatCalls.push({ message, attachments, options });
    if (this.confirmsPinnedCapabilityDelivery) this.notePinnedCapabilityContextDelivered();
    this._isProcessing = true;
    try {
      if (this.scriptedEvents) {
        for (const event of this.scriptedEvents) yield event;
        return;
      }
      yield { type: 'complete' };
    } finally {
      this._isProcessing = false;
    }
  }

  async abort(reason?: string): Promise<void> {
    this.abortCalls.push({ reason });
    this._isProcessing = false;
  }

  forceAbort(reason: AbortReason = AbortReason.UserStop): void {
    this.forceAbortCalls.push({ reason });
    this._isProcessing = false;
  }

  isProcessing(): boolean {
    return this._isProcessing;
  }

  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void {
    this.respondToPermissionCalls.push({ requestId, allowed, alwaysAllow });
  }

  async runMiniCompletion(_prompt: string): Promise<string | null> {
    return 'Test Response';
  }

  /**
   * Every `queryLlm` request this agent was asked to run. The advisor rides
   * this route, so it is how a test sees what a consult SENT — the transcript
   * packaging, the system prompt and the resolved model.
   */
  public queryLlmCalls: Array<import('../llm-tool.ts').LLMQueryRequest> = [];

  /**
   * Scripted `queryLlm` outcome. An `Error` is THROWN (the transport failure
   * path); anything else is returned. `null` keeps the default reply.
   */
  public queryLlmOutcome: import('../llm-tool.ts').LLMQueryResult | Error | null = null;

  async queryLlm(request: import('../llm-tool.ts').LLMQueryRequest): Promise<import('../llm-tool.ts').LLMQueryResult> {
    this.queryLlmCalls.push(request);
    if (this.queryLlmOutcome instanceof Error) throw this.queryLlmOutcome;
    return this.queryLlmOutcome ?? { text: 'Test LLM Response' };
  }

  /** P2.1 — drive the `advisor_consult` tool path without a backend adapter. */
  executeAdvisorConsultForTest(args: Record<string, unknown>): Promise<string> {
    return this.executeAdvisorConsult(args);
  }

  /** P2.1 — drive the `/advisor` seam answer. */
  describeAdvisorForTest(action: 'status' | 'on' | 'off') {
    return this.describeAdvisor(action);
  }

  // Expose protected state for testing
  getConfigWatcherManager() { return this.configWatcherManager; }

  // Helper to reset tracking
  resetTracking(): void {
    this.chatCalls = [];
    this.abortCalls = [];
    this.forceAbortCalls = [];
    this.respondToPermissionCalls = [];
  }
}

// ============================================================
// Event Collector Utility
// ============================================================

/**
 * Collect all events from an AsyncGenerator.
 */
export async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

// ============================================================
// Callback Spy Utility
// ============================================================

/**
 * Create a callback spy that records all calls.
 */
export function createCallbackSpy<T extends (...args: unknown[]) => unknown>(): {
  spy: T;
  calls: Parameters<T>[];
} {
  const calls: Parameters<T>[] = [];
  const spy = ((...args: Parameters<T>) => {
    calls.push(args);
  }) as T;
  return { spy, calls };
}
