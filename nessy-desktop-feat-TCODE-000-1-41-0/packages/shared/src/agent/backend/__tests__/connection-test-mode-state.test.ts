/**
 * F1.416 (origin WJ-ff verifier on F1.257, the connection-test key) — a connection
 * test's temporary ClaudeAgent must not leave its mode entry behind.
 *
 * `testBackendConnection` builds a real ClaudeAgent for a direct Anthropic
 * connection (the anthropic driver declines the test for anything but
 * `claude-runtime`, so the generic subprocess path runs) under the synthetic key
 * `{ workspaceId: '__test', sessionId: 'test-<now>' }`. Its constructor registers
 * that key in the mode singleton. Before F1.257 `destroy()` cleared it; since
 * F1.257 `destroy()` keeps the entry (it is the HOST's for a real session), and
 * nothing owns a synthetic key — so every Test button press left one entry
 * behind (WJ-ff's PROBE-CONN: +3 for three tests). The fix clears the key in the
 * test's own `finally`, beside `agent.destroy()`.
 *
 * The SDK is never reached: `runMiniCompletion` is replaced on the prototype for
 * this file (and put back after), and the agent really is constructed — the
 * CONTROL arm counts the synthetic session ids the stub saw.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ClaudeAgent } from '../../claude-agent.ts';
import { modeManager } from '../../mode-manager.ts';
import { initializeCredentialManagerV2 } from '../../../credentials/index.ts';
import { testBackendConnection } from '../factory.ts';

const TEST_WORKSPACE_PREFIX = '__test';

const proto = ClaudeAgent.prototype as unknown as {
  runMiniCompletion(this: { config: { session?: { id?: string } } }, prompt: string): Promise<string | null>;
};
const realRunMiniCompletion = proto.runMiniCompletion;
const seenSessionIds: string[] = [];

beforeAll(() => {
  try {
    initializeCredentialManagerV2({ storageLayoutVersion: 2, verificationId: 'f1416-connection-test-mode-state' });
  } catch { /* already initialised by another file in this process */ }
  proto.runMiniCompletion = async function (this: { config: { session?: { id?: string } } }) {
    seenSessionIds.push(this.config.session?.id ?? '');
    return 'ok';
  };
});

afterAll(() => {
  proto.runMiniCompletion = realRunMiniCompletion;
});

function connectionTestEntries(): number {
  const states = (modeManager as unknown as { states: Map<string, unknown> }).states;
  return [...states.keys()].filter(key => key.startsWith(TEST_WORKSPACE_PREFIX) && key.includes('test-')).length;
}

describe('F1.416 · a connection test leaves no mode entry under its synthetic key', () => {
  it('three direct-Anthropic tests: each runs a real ClaudeAgent, none leaves `__test`/`test-<now>` behind', async () => {
    const before = connectionTestEntries();
    for (let i = 0; i < 3; i++) {
      const result = await testBackendConnection({
        provider: 'anthropic',
        apiKey: 'sk-f1416-not-a-real-key',
        model: 'claude-sonnet-4-6',
        hostRuntime: { appRootPath: process.cwd(), isPackaged: false },
        connection: { providerType: 'anthropic' },
        timeoutMs: 10_000,
      });
      expect(result).toEqual({ success: true });
    }
    // CONTROL: the temporary agent really ran, three times, under the synthetic key.
    expect(seenSessionIds.filter(id => id.startsWith('test-'))).toHaveLength(3);
    expect(connectionTestEntries() - before).toBe(0);
  }, 60_000);
});
