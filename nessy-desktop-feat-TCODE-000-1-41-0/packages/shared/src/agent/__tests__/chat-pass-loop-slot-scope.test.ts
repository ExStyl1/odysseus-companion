/**
 * L1 — HOW MANY BACKEND TURNS ONE USER TURN IS.
 *
 * `SessionManager.sendMessage` iterates `agent.chat()` exactly once per user
 * message (SessionManager.ts:17857 is the ONLY `agent.chat(` iteration site in
 * the server). But `BaseAgent.chat` re-enters `chatImpl` in a
 * `for (let pass = 0; ; pass += 1)` loop (base-agent.ts:3778) for model-side
 * skill invocation, and deliberately HOLDS BACK the non-terminal `complete`
 * (`:3789`) so the caller's loop — which stops at the first one — does not end
 * the turn early.
 *
 * Under L2 each `chatImpl` entry sends its own message into the live query and
 * therefore earns its own SDK `result`. So "one open slot per agent, settled by
 * the first terminal event" cannot be `chat()`-scoped: passes 2..N would run
 * with the caller already settled. These tests pin the multiplicity and the
 * partition, which is the contract L2 owes the renderer either way:
 *
 *   N `chatImpl` entries, N backend completions — ONE `complete` out of `chat()`.
 *
 * L2 may change WHERE the slot lives. It may not change this partition.
 */
import { describe, expect, it } from 'bun:test';
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef } from '../../capabilities/resolver.ts';
import type { AgentEvent } from '@nessy-agent/core/types';
import { TestAgent, collectEvents, createMockBackendConfig, createMockSession } from './test-utils.ts';

const PROJECT = '/fixture/pass-loop';

function runtimeWithSkill(): CapabilityTurnRuntime {
  const resource: NativeResourceRef = {
    source: 'project',
    scope: { kind: 'project', workspaceId: 'ws' },
    resourceId: 'skill:py',
    absolutePath: `${PROJECT}/.agents/skills/py/SKILL.md`,
    revision: '1',
    contentHash: 'c'.repeat(64),
  };
  return {
    provider: 'pi',
    view: {
      generation: 'generation-pass-loop',
      sources: [],
      skills: [{
        key: 'skill:project:py',
        logicalName: 'py',
        description: 'Python helper',
        selectedAsUnqualifiedAlias: true,
        resource,
      }],
      mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [],
      commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return resource.absolutePath; },
      async readText() { return 'PY_SKILL_BODY'; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as CapabilityTurnRuntime;
}

function makeAgent(): TestAgent {
  const agent = new TestAgent(createMockBackendConfig({
    session: createMockSession({ workingDirectory: PROJECT }),
  }));
  agent.setCapabilityTurnRuntime(runtimeWithSkill());
  return agent;
}

const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

describe('one user turn, N backend turns (L1 — the slot-scope question)', () => {
  it('a model-side [skill:…] re-enters chatImpl, so one chat() is TWO backend turns', async () => {
    const agent = makeAgent();
    // The backend "says" it wants the skill. The same script runs on every pass;
    // the once-per-session dedup inside extractModelSkillInvocations is what
    // stops the second pass from asking again, so the loop settles at two.
    agent.scriptedEvents = [
      { type: 'text_complete', text: 'Let me use [skill:py] for this.' },
      { type: 'complete', usage },
    ] as AgentEvent[];

    const events = await collectEvents(agent.chat('do the thing'));

    // TWO backend entries for ONE user message. Under L2 that is two `result`
    // messages arriving on the one live query.
    expect(agent.chatCalls).toHaveLength(2);
    // The re-entry carries the materialized skill body — proof it is the
    // continuation and not a retry of the same message.
    expect(agent.chatCalls[0]!.message).not.toContain('PY_SKILL_BODY');
    expect(agent.chatCalls[1]!.message).toContain('PY_SKILL_BODY');

    // And ONE `complete` reaches the caller: pass 1's was held back.
    // `SessionManager`'s loop returns on the first `complete`, so a second one
    // here would truncate the turn at the pass boundary.
    expect(events.filter(event => event.type === 'complete')).toHaveLength(1);
    expect(events[events.length - 1]!.type).toBe('complete');

    // AFTER L2: whatever owns the per-turn slot must still yield exactly one
    // `complete` per `chat()` while consuming N backend terminal events. A
    // `chat()`-scoped slot settled by the FIRST terminal event would settle
    // here at pass 1 and leave pass 2's events with nowhere to go.
  });

  it('positive control on the same rig: no invocation, one pass, one complete', async () => {
    // Without this, "two passes" above proves only that the harness counts.
    const agent = makeAgent();
    agent.scriptedEvents = [
      { type: 'text_complete', text: 'No skill needed.' },
      { type: 'complete', usage },
    ] as AgentEvent[];

    const events = await collectEvents(agent.chat('do the thing'));

    expect(agent.chatCalls).toHaveLength(1);
    expect(events.filter(event => event.type === 'complete')).toHaveLength(1);
  });

  it('a terminal-reasoned complete is NOT held back and never continues the turn', async () => {
    // The guard that makes the pass loop safe: a `complete` carrying a
    // `terminalReason` means the backend ended the turn for a reason of its own
    // (a cap, an abort), and re-entering would resume an aborted turn.
    // L2's settlement rule inherits this distinction.
    const agent = makeAgent();
    agent.scriptedEvents = [
      { type: 'text_complete', text: 'Let me use [skill:py] for this.' },
      { type: 'complete', usage, terminalReason: 'provider_error' },
    ] as AgentEvent[];

    const events = await collectEvents(agent.chat('do the thing'));

    expect(agent.chatCalls).toHaveLength(1);
    const completes = events.filter(event => event.type === 'complete');
    expect(completes).toHaveLength(1);
    expect((completes[0] as { terminalReason?: string }).terminalReason).toBe('provider_error');
  });
});
