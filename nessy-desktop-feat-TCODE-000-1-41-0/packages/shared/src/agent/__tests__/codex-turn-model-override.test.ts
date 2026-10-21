/**
 * P6.365 — a mid-session model change forked the codex thread, when `turn/start`
 * declares five overrides we never sent.
 *
 * ## The premise that was wrong
 *
 * `codexThreadConfigSignature`'s own docblock asserted that "codex fixes a
 * thread's model at `thread/start` and `turn/start` carries no model". Measured
 * at HEAD against the pinned schema, that is false and had been since the tag
 * the bundled binary is built from:
 * `packages/codex-protocol/schema/v2/TurnStartParams.json` declares
 * `model: {"description": "Override the model for this turn and subsequent
 * turns.", "type": ["string","null"]}`, with `effort`, `summary`, `serviceTier`
 * and `personality` carrying the same sentence.
 *
 * The cost was invisible because the fork preserves history: what a mid-session
 * model switch actually spent was a round trip, the re-fork budget, a new thread
 * id, and — on a thread with no rollout record yet — a fallback `thread/start`
 * that begins an EMPTY thread.
 *
 * ## What this case pins
 *
 * The wire. A turn carries the session's model on `turn/start`, and a model
 * change produces no `thread/fork` at all.
 */
import { describe, expect, it } from 'bun:test';
import { CodexAgent } from '../codex-agent.ts';
import type { AgentEvent } from '../../automations/types.ts';

function createConfig(): any {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-turn-model',
      name: 'Codex Turn Model Workspace',
      rootPath: '/tmp/ws-codex-turn-model',
      workspaceRootPath: '/tmp/ws-codex-turn-model',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-turn-model',
    } as any,
    session: {
      id: 'session-codex-turn-model',
      workspaceRootPath: '/tmp/ws-codex-turn-model',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/first-model',
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
  (agent as any).debug = () => {};
  return requests;
}

async function drain(agent: CodexAgent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of (agent as any).chatImpl(prompt)) events.push(event as AgentEvent);
  return events;
}

const starts = (requests: Array<{ method: string; params: any }>) =>
  requests.filter(entry => entry.method === 'turn/start').map(entry => entry.params);

describe('P6.365 · a codex turn carries the session model on turn/start', () => {
  it('sends the model on every turn, and the NEW model after a mid-session change', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent);
      await drain(agent, 'first');
      expect(starts(requests).map(p => p.model)).toEqual(['codex/first-model']);

      // Everything from here on is what the MODEL CHANGE cost. The mark matters:
      // this rig stubs `ensureRuntime`, so `runtimeConfigSignature` is unset and
      // the first turn applies the config layer once — a real session sets it in
      // `createRuntime`. Measuring from the mark asks the row's question ("what
      // does a model change produce?") instead of the rig's.
      const mark = requests.length;
      agent.setModel('codex/second-model');
      await drain(agent, 'second');
      const afterChange = requests.slice(mark);

      // ONE turn/start per turn, the second carrying the new model…
      expect(starts(requests).map(p => p.model))
        .toEqual(['codex/first-model', 'codex/second-model']);
      expect(afterChange.filter(r => r.method === 'turn/start')).toHaveLength(1);
      // …and NO fork, which is the whole of the row. `thread/start` is absent
      // too: the model change never reached the config-drift walk, so it cannot
      // fall through to the empty-thread fallback either.
      expect(afterChange.filter(r => r.method === 'thread/fork')).toHaveLength(0);
      expect(afterChange.filter(r => r.method === 'thread/start')).toHaveLength(0);
    } finally { agent.destroy(); }
  });

  it('carries the effort override too, mapped through the config writer’s own table', async () => {
    // `model_reasoning_effort` lives in `config.toml`, which the app-server reads
    // only at START — so before this field an `/effort` change reached codex on
    // the next RUNTIME BUILD, not on the next turn. The mapping is imported from
    // the writer rather than restated: `off` is Nessy's own level and codex's
    // `none` is the variant it maps to.
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent);
      agent.setThinkingLevel('high');
      await drain(agent, 'first');
      expect(starts(requests).map(p => p.effort)).toEqual(['high']);

      agent.setThinkingLevel('off');
      await drain(agent, 'second');
      expect(starts(requests).map(p => p.effort)).toEqual(['high', 'none']);
      // …and still no fork: effort was never config drift either.
      // C3.426 · this line read `toHaveLength(1) // the initial layer only`,
      // under a comment saying "still no fork: effort was never config drift
      // either". HALF of that is still true and the half that moved is a
      // different mechanism, so the guard moves with it rather than being
      // relaxed to a count that would pass on anything.
      //
      // C4.11 (`8260c9c4f`, QG4 answer B) exports the documented
      // `$CLAUDE_EFFORT`/`$NESSY_EFFORT` pair to codex's SHELL children through
      // codex's own `[shell_environment_policy].set` — and that map IS hashed by
      // `codexThreadConfigSignature`. Its commit message prices the consequence
      // rather than hiding it: "a level change BETWEEN TURNS costs one extra
      // `thread/fork`", bounded at one, only on a turn whose level differs, zero
      // for a model with no effort control. C4.11 turned over two other stale
      // assertions in its own commit and missed this one.
      //
      // So the effort still rides `turn/start` — the two `p.effort` assertions
      // above are what the row P6.365 is about and they are untouched — and the
      // second fork is the ENVIRONMENT changing, not the override. Asserted by
      // the two configs rather than by their number, because a count cannot tell
      // the documented cost from a regression that re-forked for some other
      // reason.
      const forkConfigs = requests
        .filter(r => r.method === 'thread/fork')
        .map(r => (r.params.config as { shell_environment_policy?: { set?: Record<string, string> } }))
      expect(forkConfigs).toHaveLength(2)
      expect(forkConfigs[0]?.shell_environment_policy?.set)
        .toEqual({ CLAUDE_EFFORT: 'high', NESSY_EFFORT: 'high' })
      // `off` withholds BOTH names — the same rule the hook input and the Pi
      // child follow — so the whole policy block is gone, which is the only
      // difference between the two layers.
      expect(forkConfigs[1]?.shell_environment_policy).toBeUndefined()
    } finally { agent.destroy(); }
  });

  it('keeps the field on an UNCHANGED session, so it cannot go stale', async () => {
    // Sent unconditionally rather than only after a change: the field is the
    // thread's model as this session understands it, and a conditional send is
    // a second piece of state to keep in step with the first.
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent);
      await drain(agent, 'one');
      await drain(agent, 'two');
      expect(starts(requests).map(p => p.model))
        .toEqual(['codex/first-model', 'codex/first-model']);
    } finally { agent.destroy(); }
  });
});
