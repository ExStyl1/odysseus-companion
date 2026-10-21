/**
 * P2.513 — the claude backend's stderr ring buffer, reachable from outside.
 *
 * The defect was NOT a missing buffer. `ClaudeAgent` has always kept the last
 * twenty chunks of the SDK child's stderr; what it lacked was the method
 * `SessionManager.getRecentAgentStderr` (RPC `session:getRecentStderr`) probes
 * for. That accessor is duck-typed and answers `''` when the probe misses, so
 * every claude session reported "no diagnostics" — indistinguishable, to a
 * caller, from "not wired", which is the state that makes a reader build a
 * SECOND buffer beside the one that already exists.
 *
 * So the subject here is the PROBE, not the method: the assertions replicate
 * `getRecentAgentStderr`'s own `typeof agent?.getRecentStderr !== 'function'`
 * shape verbatim, because a test that calls `agent.getRecentStderr()` directly
 * would have passed the day the accessor was added and still left the probe
 * missing it.
 *
 * `ClaudeAgent`'s constructor is SDK-free (a query is only created inside
 * `ensureLiveSession`), which is what lets this file build one without a
 * `mock.module` on the SDK specifier — the process-global hazard four other
 * files in this directory already carry.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';

const WORKSPACE_ID = 'ws-p2513-stderr';
const WORKSPACE_ROOT = '/tmp/nessy-p2513-stderr';

let sessionCounter = 0;

function agentConfig(): BackendConfig {
  sessionCounter += 1;
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'P2.513 stderr accessor',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-p2513-${sessionCounter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

/**
 * `SessionManager.getRecentAgentStderr`, transcribed. Kept as one function so
 * both the subject and the control go through the identical code path.
 */
function probeLikeSessionManager(agent: unknown): string {
  const maybe = agent as { getRecentStderr?: () => string } | undefined;
  if (typeof maybe?.getRecentStderr !== 'function') return '';
  try {
    return maybe.getRecentStderr();
  } catch {
    return '';
  }
}

/** Write into the private ring the `stderr` callback fills at the query site. */
function seedStderr(agent: ClaudeAgent, chunks: string[]): void {
  (agent as unknown as { lastStderrOutput: string[] }).lastStderrOutput = chunks;
}

describe('ClaudeAgent.getRecentStderr (P2.513)', () => {
  it('answers the duck-typed session probe with what the child said', () => {
    const agent = new ClaudeAgent(agentConfig());
    seedStderr(agent, ['first line', 'second line']);
    expect(probeLikeSessionManager(agent)).toBe('first line\nsecond line');
  });

  // The negative subject, and the reason the row calls the old state "worse than
  // absent": an empty buffer and a missing method are the same string. Only the
  // pair of cases distinguishes them, so both are asserted here rather than one.
  it('answers empty for a quiet child, exactly as it did when the method was absent', () => {
    const agent = new ClaudeAgent(agentConfig());
    seedStderr(agent, []);
    expect(probeLikeSessionManager(agent)).toBe('');
  });

  // The positive control for the probe itself: it must still MISS on a backend
  // that declares nothing, or the two assertions above would pass against any
  // object at all.
  it('the probe still misses a backend that declares no accessor', () => {
    expect(probeLikeSessionManager({ notAnAccessor: true })).toBe('');
    expect(probeLikeSessionManager(undefined)).toBe('');
  });

  // The join is not cosmetic: the buffer's other consumer, the
  // `process exited with code 1` diagnosis, reads `lastStderrOutput.join('\n')`.
  // Two renderings of the same chunks is the drift this pins shut.
  it('renders chunks the way the error path already renders them', () => {
    const agent = new ClaudeAgent(agentConfig());
    const chunks = ['a', 'b', 'c'];
    seedStderr(agent, chunks);
    expect(probeLikeSessionManager(agent)).toBe(chunks.join('\n'));
  });
});
