/**
 * P6.393 — the reattached-skill budget cut a body and said nothing.
 *
 * `selectReattachedSkills` slices an over-long skill body to the per-skill
 * budget (5000 tokens, `pi-harness/skill-reattach-budget.ts`) and hands back
 * something shaped exactly like a whole body. After a compaction the cut copy
 * is what gets reinjected, so the model went on following instructions it had
 * only part of and the user had nothing to read about it — which presents as
 * "the skill stopped working properly", the least diagnosable shape there is.
 *
 * Both arms are here because the notice is only worth having if silence still
 * means silence: a skill UNDER the budget must produce no line at all.
 *
 * Host-side and therefore one test, not three: the reattachment and the notice
 * both live in `BaseAgent`, which every runtime's agent extends, and the
 * reinjection path (`extractSkillInvocations`) is not gated on the provider.
 */

import { describe, expect, it } from 'bun:test';
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import { TestAgent, createMockBackendConfig, collectEvents } from './test-utils.ts';

/** The per-skill ceiling is 5000 tokens and `estimateTokens` is chars / 4. */
const PER_SKILL_CHARS = 5000 * 4;

function runtimeWithSkill(name: string, body: string): CapabilityTurnRuntime {
  const skill = {
    key: `skill://workspace/${name}`,
    logicalName: name,
    description: `${name} skill`,
    selectedAsUnqualifiedAlias: true,
    resource: {
      source: 'workspace' as const,
      scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
      resourceId: name,
      absolutePath: `/private/${name}/SKILL.md`,
      revision: 'r1',
      contentHash: '7'.repeat(64),
    },
  };
  return {
    view: {
      generation: 'test-generation',
      sources: [],
      skills: [skill],
      mcpServers: [],
      hooks: [],
      automations: [],
      agents: [],
      promptLayers: [],
      memory: [],
      permissionLayers: [],
      commands: [],
      promptCommands: [],
      apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(resource) {
        return 'absolutePath' in resource ? resource.absolutePath : '/test/plugin-resource';
      },
      async readText() { return body; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as CapabilityTurnRuntime;
}

/** Invoke the skill, then compact, then send the turn that reinjects it. */
async function reinjectAfterCompaction(name: string, body: string) {
  const agent = new TestAgent(createMockBackendConfig());
  agent.setCapabilityTurnRuntime(runtimeWithSkill(name, body));
  await collectEvents(agent.chat(`[skill:${name}] select`));
  agent.resetPrerequisiteState();
  return { agent, events: await collectEvents(agent.chat('continue after compact')) };
}

const noticesOf = (events: readonly { type: string; message?: string }[]): string[] =>
  events.filter(event => event.type === 'info').map(event => event.message ?? '');

describe('P6.393 — a reattached skill body that was cut says so', () => {
  it('names the skill, once, on the turn the cut copy is sent', async () => {
    const { agent, events } = await reinjectAfterCompaction('oversized', 'A'.repeat(PER_SKILL_CHARS * 3));
    // The cut really happened: the reinjected body is the budget, not the body.
    expect(agent.chatCalls.at(-1)!.message).toContain('<invoked-skill ');
    const notices = noticesOf(events).filter(message => message.includes('oversized'));
    expect(notices).toHaveLength(1);
    // The user's two facts: WHICH skill, and that what the model has is short.
    expect(notices[0]).toContain('shortened copy');
  });

  it('says nothing when the body fits — the control that keeps silence meaningful', async () => {
    const { agent, events } = await reinjectAfterCompaction('modest', 'B'.repeat(PER_SKILL_CHARS - 400));
    expect(agent.chatCalls.at(-1)!.message).toContain('<invoked-skill ');
    expect(noticesOf(events).filter(message => message.includes('modest'))).toEqual([]);
  });
});
