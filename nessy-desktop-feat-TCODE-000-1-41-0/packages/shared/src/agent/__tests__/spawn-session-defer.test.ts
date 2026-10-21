/**
 * P6.334 — the DEFERRED form of `spawn_session`.
 *
 * The row's `done_means` has three clauses and only the FIRST is decided here:
 * *"the agent proposes work, NOTHING runs until the user clicks"*. The click is
 * `deferred-spawn-chip.tsx`'s and the isolation is the route's
 * (`worktree: true`, granted only for a trusted in-app navigation), both landed
 * by the renderer lane. What this pins is the declaration: the flag reaches the
 * host, and it reaches it in the ONE shape that cannot be misread.
 *
 * The direction of the default is the property worth a test of its own. A
 * missing, malformed or string-typed `defer` must resolve to "start it", not to
 * "propose it": a spawn the user did not want is visible in the session list and
 * can be archived, while a proposal that silently never ran is invisible — the
 * model believes it delegated the work and nobody ever sees a chip.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { SpawnSessionRequest, SpawnSessionResult } from '../base-agent.ts';
import { SpawnSessionSchema, TOOL_DESCRIPTIONS } from '../../../../session-tools-core/src/tool-defs.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

class SpawnTestAgent extends TestAgent {
  public invokeSpawn(input: Record<string, unknown>) {
    return this.preExecuteSpawnSession(input);
  }
}

function setup(status: SpawnSessionResult['status'] = 'started') {
  const agent = new SpawnTestAgent(createMockBackendConfig());
  const captured: SpawnSessionRequest[] = [];
  agent.onSpawnSession = async (request) => {
    captured.push(request);
    return { sessionId: 'spawned-id', name: 'spawned', status };
  };
  return { agent, captured };
}

describe('the declaration', () => {
  it('accepts defer as a boolean and nothing else', () => {
    expect(SpawnSessionSchema.safeParse({ prompt: 'hi', defer: true }).success).toBe(true);
    expect(SpawnSessionSchema.safeParse({ prompt: 'hi', defer: false }).success).toBe(true);
    expect(SpawnSessionSchema.safeParse({ prompt: 'hi' }).success).toBe(true);
    // A string `'true'` is refused at the schema rather than coerced, so the
    // only way to reach the host with a deferral is to mean it.
    expect(SpawnSessionSchema.safeParse({ prompt: 'hi', defer: 'true' }).success).toBe(false);
  });

  it('the description tells the model what defer does NOT do', () => {
    const description = TOOL_DESCRIPTIONS.spawn_session;
    expect(description).toContain('defer: true');
    expect(description).toContain('Nothing runs');
    // The isolation promise is part of the offer the model is making, so it has
    // to be in the text the model reads before making it.
    expect(description).toContain('its own git worktree');
    // And the reply is not a result: a model told "started" would wait.
    expect(description).toContain('not that anything ran');
  });
});

describe('the flag reaching the host', () => {
  let agent: SpawnTestAgent;
  let captured: SpawnSessionRequest[];

  beforeEach(() => {
    ({ agent, captured } = setup());
  });

  it('forwards defer: true', async () => {
    await agent.invokeSpawn({ prompt: 'clean up the dead config option', defer: true });
    expect(captured[0]?.defer).toBe(true);
  });

  it('an omitted defer starts the session — the safe direction', async () => {
    await agent.invokeSpawn({ prompt: 'hi' });
    expect(captured[0]?.defer).toBe(false);
  });

  it('a truthy NON-boolean does not defer', async () => {
    // The boundary this exists for: a loosely-typed client sending `'false'`
    // would defer under a truthiness read, and a proposal nobody sees is the
    // failure mode with no trace.
    for (const value of ['true', 'false', 1, {}, []]) {
      const { agent: a, captured: c } = setup();
      await a.invokeSpawn({ prompt: 'hi', defer: value });
      expect(c[0]?.defer, `defer: ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('defer does not disturb the other overrides', async () => {
    await agent.invokeSpawn({
      prompt: 'hi', defer: true, name: 'Cleanup', labels: ['chore'], permissionMode: 'plan',
    });
    expect(captured[0]).toMatchObject({
      prompt: 'hi', defer: true, name: 'Cleanup', labels: ['chore'], permissionMode: 'plan',
    });
  });

  it('help mode still answers without reaching the host at all', async () => {
    // Positive control for every "reached the host" assertion above: the same
    // entry point can return without calling `onSpawnSession`, so a captured
    // request is evidence and not an artefact of the harness.
    await agent.invokeSpawn({ help: true });
    expect(captured).toHaveLength(0);
  });
});

describe('the outcome the caller reads', () => {
  it("'proposed' is a status the type admits, distinct from 'started'", async () => {
    const { agent } = setup('proposed');
    const result = await agent.invokeSpawn({ prompt: 'hi', defer: true }) as SpawnSessionResult;
    expect(result.status).toBe('proposed');
    expect(result.status).not.toBe('started');
  });
});
