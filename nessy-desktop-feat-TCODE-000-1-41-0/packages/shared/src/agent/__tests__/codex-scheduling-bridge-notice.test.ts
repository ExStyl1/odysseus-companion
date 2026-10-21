/**
 * P2.294 — turn 1 of a bridge-less codex session is lied to by its own skill
 * listing, and this is the sentence that tells it the truth.
 *
 * The listing is frozen in `SessionManager.createCapabilityTurn` BEFORE the
 * agent exists, so `schedulingBridgeKnownAbsent` has nobody to ask and `/loop`
 * is offered in a session whose cron tools are already gone. All three remedies
 * that would have removed the skill from that view are measured dead (W3-a,
 * W3-e, and the ordering refutation at the freeze site); what is left is to say
 * the true thing in the band the model reads. `CodexAgent.schedulingBridgeContextPart`
 * carries the whole design argument and the posture.
 *
 * Four propositions, each separable, and the second and third are what stop the
 * fix becoming a per-turn tax on every healthy session:
 *
 * 1. **`unavailable` puts the band on the turn**, above the user's own text.
 * 2. **`not-started` puts nothing there.** This is the state of every session
 *    that has not started a runtime, and a version that spoke here would warn
 *    every codex session about a bridge that is about to be fine.
 * 3. **`active` puts nothing there** — the overwhelming majority of sessions.
 * 4. **A session command carries no band**, for the same reason it carries no
 *    context parts: it must reach the backend as the bare command.
 *
 * The state is set directly rather than by driving a real listen: the ordering
 * this row turns on (`ensureRuntime` is awaited BEFORE the context parts are
 * built, so the state is exact by then) is a property of `chatImpl`, and the
 * stub transport below replaces `ensureRuntime` exactly as the sibling
 * context-parts suite does. `codex-scheduling-bridge-state.test.ts` is what
 * proves the state itself is reached, with a real bridge and both failure
 * shapes.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-bridge-notice';
const SESSION_ID = 'session-bridge-notice';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

/** The element the band opens with — the assertion target of every arm below. */
const BAND = '<scheduling_unavailable>';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Bridge Notice Workspace',
      rootPath: '/tmp/ws-bridge-notice-root',
      workspaceRootPath: '/tmp/ws-bridge-notice-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-bridge-notice',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-bridge-notice-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** Stand in for the app-server: record every request, settle each turn. */
function stubTransport(agent: CodexAgent): Array<{ method: string; params: any }> {
  const requests: Array<{ method: string; params: any }> = [];
  const client = {
    request(method: string, params: any) {
      requests.push({ method, params });
      if (method === 'turn/start') {
        queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
      }
      return Promise.resolve({ thread: { id: 'thread-1' } });
    },
    notify() {},
    close() {},
  };
  (agent as any).ensureRuntime = async () => {
    (agent as any).client = client;
    (agent as any).threadId = 'thread-1';
  };
  return requests;
}

async function drain(agent: CodexAgent, prompt: string): Promise<void> {
  for await (const _event of (agent as any).chatImpl(prompt)) { /* drain */ }
}

function turnText(requests: Array<{ method: string; params: any }>): string {
  const turn = requests.find(entry => entry.method === 'turn/start');
  return turn?.params.input[0].text as string;
}

/** One turn on an agent whose bridge is in `state`, and the text it sent. */
async function turnWithBridgeState(state: string, prompt = 'hello codex'): Promise<string> {
  cleanupModeState(SESSION_KEY);
  const agent = new CodexAgent(createConfig());
  const requests = stubTransport(agent);
  (agent as any).schedulingBridgeState = state;
  try {
    await drain(agent, prompt);
    return turnText(requests);
  } finally {
    agent.destroy();
  }
}

describe('P2.294 · a bridge-less codex turn says so in the model\'s own band', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('unavailable — the band rides the turn, ahead of the user text', async () => {
    const text = await turnWithBridgeState('unavailable');

    expect(text).toContain(BAND);
    expect(text).toContain('</scheduling_unavailable>');
    // The two facts the band exists to carry: the listing may be stale, and the
    // tool list is what to believe.
    expect(text).toContain('frozen before the bridge is attempted');
    expect(text).toContain('never report');
    // Claude's shape, which this file inherits: host parts first, user last.
    expect(text.indexOf(BAND)).toBeLessThan(text.indexOf('hello codex'));
    expect(text.endsWith('hello codex')).toBe(true);
  });

  it('not-started — nothing is said, because nothing is known to be wrong', async () => {
    // The default state of every fresh agent. Withholding on ignorance is the
    // mirror of the bug (`schedulingBridgeKnownAbsent`'s own argument), and
    // speaking on ignorance is the same error in the other direction.
    const text = await turnWithBridgeState('not-started');

    expect(text).not.toContain(BAND);
    expect(text).toContain('<session_state>');
    expect(text.endsWith('hello codex')).toBe(true);
  });

  it('active — the healthy majority pays nothing', async () => {
    const text = await turnWithBridgeState('active');

    expect(text).not.toContain(BAND);
    expect(text).toContain('<session_state>');
  });

  it('a session command still reaches the backend bare', async () => {
    // The band is composed on the SAME arm the context parts are, so a bridge
    // failure must not be the thing that finally puts a prefix in front of a
    // slash. `/subtask` is the kind that reaches `chatImpl` when driven
    // directly — see `codex-context-parts.test.ts` for why that is the only way
    // in today.
    const text = await turnWithBridgeState('unavailable', '/subtask investigate the flake');

    expect(text).toBe('/subtask investigate the flake');
  });
});
