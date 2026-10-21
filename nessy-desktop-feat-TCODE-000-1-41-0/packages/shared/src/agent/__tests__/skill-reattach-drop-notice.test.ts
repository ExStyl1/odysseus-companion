/**
 * P6.593 — a skill the reattachment budget dropped ENTIRELY said nothing.
 *
 * P6.393 closed the per-skill half: an over-long body is sliced to 5000 tokens
 * and the user is now told the model is working from a shortened copy. The
 * TOTAL is a different failure and needed a different sentence.
 * `selectReattachedSkills` (`pi-harness/skill-reattach-budget.ts`) sorts the
 * active invocations newest-first and `break`s the moment one would push the
 * running total past 25 000 tokens — so the oldest invoked skills are not
 * shortened, they are absent, and the length comparison P6.393 added cannot see
 * them because there is no reattached record left to compare against.
 *
 * The two arms that make the notice worth having: the drop is NAMED, and a
 * reinjection that fits stays silent.
 *
 * Host-side and therefore one test, not three — the reattachment and the notice
 * both live in `BaseAgent`, which every runtime's agent extends, and
 * `extractSkillInvocations` is not gated on the provider.
 */

import { describe, expect, it } from 'bun:test';
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import { TestAgent, createMockBackendConfig, collectEvents } from './test-utils.ts';

/**
 * The per-skill ceiling is 5000 tokens, the total 25 000, and `estimateTokens`
 * is `ceil(chars / 4)`. A body ABOVE the per-skill ceiling is sliced to exactly
 * `5000 * 4` chars, i.e. exactly 5000 tokens — which makes the arithmetic
 * independent of whatever wrapper materialization adds: five such skills fill
 * the total exactly, and a sixth is dropped.
 */
const OVER_PER_SKILL_CHARS = 5000 * 4 + 4000;
const FITS_EVERYWHERE_CHARS = 400;

function runtimeWithSkills(bodies: ReadonlyMap<string, string>): CapabilityTurnRuntime {
  const skills = [...bodies.keys()].map(name => ({
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
  }));
  return {
    view: {
      generation: 'test-generation',
      sources: [],
      skills,
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
      async readText(resource) {
        const resourceId = 'resourceId' in resource ? resource.resourceId : '';
        return bodies.get(String(resourceId)) ?? '';
      },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as CapabilityTurnRuntime;
}

/**
 * Invoke every skill, oldest first and one per turn (which is what gives them
 * distinct `invokedAt` values and therefore a defined drop order), then compact,
 * then send the turn that reinjects them.
 */
async function reinjectAfterCompaction(bodies: ReadonlyMap<string, string>) {
  const agent = new TestAgent(createMockBackendConfig());
  agent.setCapabilityTurnRuntime(runtimeWithSkills(bodies));
  for (const name of bodies.keys()) {
    await collectEvents(agent.chat(`[skill:${name}] select`));
  }
  agent.resetPrerequisiteState();
  return { agent, events: await collectEvents(agent.chat('continue after compact')) };
}

const noticesOf = (events: readonly { type: string; message?: string }[]): string[] =>
  events.filter(event => event.type === 'info').map(event => event.message ?? '');

describe('P6.593 — a reattached skill the total budget dropped says so', () => {
  it('names the dropped skill, once, and does not call it shortened', async () => {
    // Six skills, each over the per-skill ceiling: five sliced copies fill the
    // 25 000-token total exactly, so the OLDEST invocation is dropped outright.
    const bodies = new Map(
      ['oldest', 'two', 'three', 'four', 'five', 'newest']
        .map(name => [name, `${name} `.repeat(OVER_PER_SKILL_CHARS / 8)] as const),
    );
    const { agent, events } = await reinjectAfterCompaction(bodies);

    // The reinjection really happened — otherwise "nothing was said" would be
    // trivially true and this test would pass while measuring nothing.
    const reinjected = agent.chatCalls.at(-1)!.message;
    expect(reinjected).toContain('<invoked-skill ');
    // And the DROP really happened, read off the prompt the model is actually
    // sent rather than off the notice that claims it: the newest survives, the
    // oldest is not in the turn at all. Without this the notice could be
    // truthful about a set nobody computed from the real reattachment.
    expect(reinjected).toContain('newest');
    expect(reinjected).not.toContain('name="oldest"');

    const aboutOldest = noticesOf(events).filter(message => message.includes('oldest'));
    expect(aboutOldest).toHaveLength(1);
    // The user's two facts: WHICH skill, and that the model has none of it —
    // not the "shortened copy" its sibling notice reports.
    expect(aboutOldest[0]).toContain('no longer has those instructions at all');
    expect(aboutOldest[0]).not.toContain('shortened copy');

    // The five that survived were cut, not dropped: they are reported by the
    // P6.393 line and must NOT appear in the drop line.
    const droppedLine = aboutOldest[0]!;
    for (const survivor of ['two', 'three', 'four', 'five', 'newest']) {
      expect(droppedLine).not.toContain(survivor);
    }
  });

  it('says nothing when everything fits — the control that keeps silence meaningful', async () => {
    const bodies = new Map(
      ['alpha', 'beta'].map(name => [name, `${name} `.repeat(FITS_EVERYWHERE_CHARS)] as const),
    );
    const { agent, events } = await reinjectAfterCompaction(bodies);

    expect(agent.chatCalls.at(-1)!.message).toContain('<invoked-skill ');
    expect(noticesOf(events).filter(message => message.includes('reattachment budget'))).toEqual([]);
  });
});
