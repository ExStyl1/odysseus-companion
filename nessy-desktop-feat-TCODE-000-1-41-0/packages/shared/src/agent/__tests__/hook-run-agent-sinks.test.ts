/**
 * P6.643, the last two lines — the runtime-native hook-run sinks.
 *
 * W9-l2 built the store (`HookRunStore`), the `/hooks` listing that reads it,
 * the host feed in `BaseAgent.emitAutomationEvent`, and BOTH adapter sides: the
 * claude adapter calls `callbacks.onHookRun`, the codex adapter calls its
 * settable `onHookRun`. Neither was ever set, so both were declared extension
 * points with no caller — and the host feed can only record FAILURES
 * (`hookErrors` is all `AgentEventExecutionResult` publishes per hook), which
 * made a successful hook run illegible on every runtime.
 *
 * The subject is therefore the WIRING and not the store: a test that called
 * `agent.recordHookRun(...)` directly would have passed on the day the store
 * shipped and still left both sinks inert. Each case drives the sink the
 * adapter itself drives and reads the agent's own store back.
 *
 * Both constructors are SDK-free at `isHeadless: true` (a claude query is only
 * created inside `ensureLiveSession`; codex's config watcher is skipped), which
 * is what lets this file build one of each without a `mock.module` on either
 * runtime's specifier.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import type { HookRunObservation } from '../hook-run-report.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';

const WORKSPACE_ROOT = '/tmp/nessy-p6643-hook-sinks';

let sessionCounter = 0;

function agentConfig(provider: 'anthropic' | 'codex-runtime'): BackendConfig {
  sessionCounter += 1;
  return {
    provider: provider === 'anthropic' ? 'anthropic' : 'codex-runtime',
    providerType: provider,
    model: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.1-codex',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-p6643-hook-sinks',
      name: 'P6.643 hook sinks',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-p6643-${sessionCounter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

function observation(runtime: HookRunObservation['runtime']): HookRunObservation {
  return {
    runtime,
    event: 'PreToolUse',
    name: 'guard/no-secrets',
    // A SUCCESS on purpose: this is the outcome the host feed structurally
    // cannot record, so it is the one that proves the native sink is the reason
    // the run is legible at all.
    outcome: 'success',
    exitCode: 0,
  };
}

/** The store, read the way `/hooks` reads it. */
function storedRuns(agent: unknown): Array<{ label: string; count: number }> {
  const groups = (agent as { hookRuns: { groups(): Array<{ label: string; runs: unknown[] }> } })
    .hookRuns.groups();
  return groups.map(group => ({ label: group.label, count: group.runs.length }));
}

describe('P6.643 · the runtime-native hook-run sinks are wired', () => {
  it('claude — the adapter callback the agent passes reaches the session store', () => {
    const agent = new ClaudeAgent(agentConfig('anthropic'));
    expect(storedRuns(agent)).toEqual([]);

    const sink = (agent as unknown as { eventAdapter: { callbacks: { onHookRun?: (o: HookRunObservation) => void } } })
      .eventAdapter.callbacks.onHookRun;
    // The wiring IS the assertion: without it this is `undefined` and the
    // adapter's own `callbacks.onHookRun?.(observation)` is a no-op.
    expect(typeof sink).toBe('function');
    sink!(observation('claude'));

    expect(storedRuns(agent)).toEqual([{ label: 'guard/no-secrets', count: 1 }]);
  });

  it('codex — the settable adapter field the constructor assigns reaches the same store', () => {
    const agent = new CodexAgent(agentConfig('codex-runtime'));
    expect(storedRuns(agent)).toEqual([]);

    const sink = (agent as unknown as { eventAdapter: { onHookRun?: (o: HookRunObservation) => void } })
      .eventAdapter.onHookRun;
    expect(typeof sink).toBe('function');
    sink!(observation('codex'));

    expect(storedRuns(agent)).toEqual([{ label: 'guard/no-secrets', count: 1 }]);
  });

  it('each session keeps its OWN runs — the store is per agent, not per process', () => {
    const first = new ClaudeAgent(agentConfig('anthropic'));
    const second = new ClaudeAgent(agentConfig('anthropic'));

    const sink = (first as unknown as { eventAdapter: { callbacks: { onHookRun?: (o: HookRunObservation) => void } } })
      .eventAdapter.callbacks.onHookRun;
    sink!(observation('claude'));

    expect(storedRuns(first)).toEqual([{ label: 'guard/no-secrets', count: 1 }]);
    expect(storedRuns(second)).toEqual([]);
  });
});
