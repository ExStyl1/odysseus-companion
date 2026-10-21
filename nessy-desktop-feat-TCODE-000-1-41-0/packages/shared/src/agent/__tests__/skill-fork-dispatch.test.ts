/**
 * R69b — `context: fork` dispatch, from the invoking turn's side.
 *
 * The contract, quoted (`skills.md:569`): "Add `context: fork` to your
 * frontmatter when you want a skill to run in isolation. The skill content
 * becomes the prompt that drives the subagent. It won't have access to your
 * conversation history."
 *
 * Two of those clauses are properties nothing else can check from here, so they
 * are what this file is built around: the skill content must NOT enter the
 * invoking conversation, and the ONLY thing that crosses to the child is that
 * content. Everything the parent knows and the child must not — the earlier
 * turns of the conversation — is proved absent against a planted canary, with
 * the parent's own turn as the positive control.
 *
 * `background` (`:269`, ":571") is the other half: `false` waits and returns the
 * result into this turn; `true` — the DEFAULT — returns immediately, and the
 * result reaches the conversation later (proved at its own seam in
 * `skill-fork.test.ts`; the transcript half is `fork-transcript-entry.ts`).
 */
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { describe, it, expect, beforeEach } from 'bun:test';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { RuntimeSkillHandle } from '../../capabilities/views.ts';
import {
  TestAgent,
  createMockBackendConfig,
  collectEvents,
} from './test-utils.ts';

const SKILL_BODY = 'Research the parser change and report the three riskiest call sites.';
/** Something ONLY the parent conversation can know. */
const CANARY = 'PARENT-ONLY-CANARY-7f3a91';

function skillHandle(name: string): RuntimeSkillHandle {
  return {
    key: `skill://workspace/${name}`,
    logicalName: name,
    description: '',
    selectedAsUnqualifiedAlias: true,
    resource: {
      source: 'workspace' as const,
      scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
      resourceId: name,
      absolutePath: `/skills/${name}/SKILL.md`,
      revision: 'r1',
      contentHash: 'a'.repeat(64),
    },
  };
}

function runtime(
  skills: RuntimeSkillHandle[],
  bodies: Record<string, string>,
  agents: CapabilityTurnRuntime['view']['agents'] = [],
): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'test-generation',
      sources: [], skills, mcpServers: [], hooks: [], automations: [], agents,
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(resource) {
        return 'absolutePath' in resource ? resource.absolutePath : '/test/plugin-resource';
      },
      async readText(resource) {
        const path = 'absolutePath' in resource ? resource.absolutePath : '';
        const body = bodies[path];
        if (body === undefined) throw new Error(`no fixture for ${path}`);
        return body;
      },
      async resolveSkillDirectory() { return '/skills'; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  };
}

const forkedSkillFile = (frontmatter: string) => `---\n${frontmatter}\n---\n${SKILL_BODY}`;

describe('context: fork dispatch', () => {
  let agent: TestAgent;

  beforeEach(() => {
    agent = new TestAgent(createMockBackendConfig());
  });

  it('drives a separate child with the skill body and keeps that body out of the conversation', async () => {
    agent.setCapabilityTurnRuntime(runtime(
      [skillHandle('research')],
      { '/skills/research/SKILL.md': forkedSkillFile('context: fork\nagent: reviewer') },
    ));
    agent.skillForkResponder = () => ({ background: true, agentId: 'child-1', taskId: 'task-skill-1' });

    await collectEvents(agent.chat('[skill:research] go'));

    // One dispatch, carrying exactly the skill content and nothing else —
    // `:569`, "The skill content becomes the prompt that drives the subagent."
    expect(agent.skillForkCalls).toHaveLength(1);
    expect(agent.skillForkCalls[0]).toMatchObject({
      name: 'research',
      agent: 'reviewer',
      // The skill's own arguments ride the body exactly as they do inline; the
      // CONTENT is the prompt either way.
      prompt: `${SKILL_BODY}\n\nARGUMENTS: go`,
      background: true,
    });

    const message = agent.chatCalls[0]!.message;
    // The body ran in the CHILD, so it must not also be pinned into this turn.
    expect(message).not.toContain(SKILL_BODY);
    expect(message).not.toContain('<invoked-skill ');
    expect(message).toContain('<forked-skill name="research" agent="reviewer" status="running"');
    expect(message).toContain('task_id="task-skill-1"');
  });

  it('never hands the child anything the parent conversation knows', async () => {
    // The negative control. A first turn plants a fact that exists only in this
    // conversation; the second turn forks. `:569` — the fork "won't have access
    // to your conversation history" — so the canary must be unreachable from
    // everything the child is given, which is the dispatch request in full.
    agent.setCapabilityTurnRuntime(runtime(
      [skillHandle('research')],
      { '/skills/research/SKILL.md': forkedSkillFile('context: fork') },
    ));
    agent.skillForkResponder = () => ({ background: true, agentId: 'child-1' });

    await collectEvents(agent.chat(`Remember this: ${CANARY}`));
    // No argument text, so the prompt is the body and nothing else — which is
    // what makes the VERBATIM assertion below possible.
    await collectEvents(agent.chat('[skill:research]'));

    // POSITIVE CONTROL: the same rig does carry the canary — into the parent's
    // own turn, which is the only place it belongs. Without this line an
    // absence below would prove nothing.
    expect(agent.chatCalls[0]!.message).toContain(CANARY);

    const request = agent.skillForkCalls[0]!;
    expect(JSON.stringify(request)).not.toContain(CANARY);
    // Stronger than "the canary is absent": the prompt is the skill body
    // VERBATIM, so there is no room in it for any conversation content at all.
    expect(request.prompt).toBe(SKILL_BODY);
  });

  it('waits for background: false and returns the child result into the invoking turn', async () => {
    agent.setCapabilityTurnRuntime(runtime(
      [skillHandle('research')],
      { '/skills/research/SKILL.md': forkedSkillFile('context: fork\nbackground: false') },
    ));
    let settled = false;
    agent.skillForkResponder = async request => {
      expect(request.background).toBe(false);
      // `:571` — "wait for the result in the turn that invoked the skill". The
      // turn must not reach the model before this resolves.
      await new Promise(resolve => setTimeout(resolve, 5));
      settled = true;
      return { background: false, status: 'done', result: 'Three risky call sites: a, b, c.' };
    };

    await collectEvents(agent.chat('[skill:research] go'));

    expect(settled).toBe(true);
    const message = agent.chatCalls[0]!.message;
    expect(message).toContain('status="completed"');
    expect(message).toContain('Three risky call sites: a, b, c.');
    // Still the child's job, not this turn's: the instructions stay out.
    expect(message).not.toContain(SKILL_BODY);
  });

  it('returns immediately for the default background mode and says the result comes later', async () => {
    agent.setCapabilityTurnRuntime(runtime(
      [skillHandle('research')],
      { '/skills/research/SKILL.md': forkedSkillFile('context: fork') },
    ));
    let childFinished = false;
    agent.skillForkResponder = () => {
      // A real background fork settles long after admission; the turn must not
      // be waiting on it.
      void new Promise(resolve => setTimeout(resolve, 50)).then(() => { childFinished = true; });
      return { background: true, agentId: 'child-1', taskId: 'task-skill-1' };
    };

    await collectEvents(agent.chat('[skill:research] go'));

    expect(childFinished).toBe(false);
    expect(agent.skillForkCalls[0]!.background).toBe(true);
    expect(agent.chatCalls[0]!.message)
      .toContain('Its result will be delivered here as a completion notification when it finishes');
  });

  it('reports a backend that cannot fork instead of running the skill inline', async () => {
    // The default `TestAgent` answers `null`, which is `BaseAgent`'s own answer.
    // Running the body inline would hand it the whole conversation — the one
    // thing `:569` forbids — so the honest report is the only safe degrade.
    agent.setCapabilityTurnRuntime(runtime(
      [skillHandle('research')],
      { '/skills/research/SKILL.md': forkedSkillFile('context: fork') },
    ));

    await collectEvents(agent.chat('[skill:research] go'));

    const message = agent.chatCalls[0]!.message;
    expect(message).toContain('status="unavailable"');
    expect(message).toContain('Its instructions were deliberately NOT loaded into this conversation.');
    expect(message).not.toContain(SKILL_BODY);
  });

  it('keeps a forked skill out of the pinned set, so it never reinjects on a later turn', async () => {
    agent.setCapabilityTurnRuntime(runtime(
      [skillHandle('research')],
      { '/skills/research/SKILL.md': forkedSkillFile('context: fork') },
    ));
    agent.skillForkResponder = () => ({ background: true, agentId: 'child-1' });

    await collectEvents(agent.chat('[skill:research] go'));

    // `activeSkillInvocations` is what a later turn reinjects and what the
    // persisted continuation envelope carries. A forked skill in there would put
    // its body into the conversation one turn late — the exact failure this
    // split exists to prevent.
    expect(agent.getActiveSkillContinuationReferencesForTest()).toEqual([]);
  });

  it('leaves a skill WITHOUT context: fork completely unchanged, ceiling included', async () => {
    const inline = runtime(
      [skillHandle('review')],
      { '/skills/review/SKILL.md': '---\nagent: reviewer\n---\nReview only the requested diff.' },
      [],
    );
    agent.setCapabilityTurnRuntime(inline);

    // `agent:` on a NON-forked skill is still the invoking turn's subagent
    // ceiling, and an unavailable one still fails the turn. This is the
    // regression that would fire if the fork target had reused the field.
    await expect(collectEvents(agent.chat('[skill:review] go')))
      .rejects.toThrow('Invoked skill agent unavailable: reviewer');
    expect(agent.skillForkCalls).toEqual([]);

    // With the agent available the skill runs inline exactly as before.
    const withAgent = new TestAgent(createMockBackendConfig());
    withAgent.setCapabilityTurnRuntime(runtime(
      [skillHandle('review')],
      { '/skills/review/SKILL.md': '---\nagent: reviewer\n---\nReview only the requested diff.' },
      [{ key: 'reviewer', name: 'reviewer', description: '', selectedAsUnqualifiedAlias: true } as never],
    ));
    await collectEvents(withAgent.chat('[skill:review] go'));
    expect(withAgent.skillForkCalls).toEqual([]);
    expect(withAgent.chatCalls[0]!.message).toContain('<invoked-skill ');
    expect(withAgent.chatCalls[0]!.message).toContain('Review only the requested diff.');
  });

  it('does not narrow the invoking turn with a FORKED skill\'s agent target', async () => {
    // The mirror of the case above: the same `agent: reviewer`, the same empty
    // agent view, and no failure — because under `context: fork` the field names
    // the child, not a ceiling on this turn.
    agent.setCapabilityTurnRuntime(runtime(
      [skillHandle('research')],
      { '/skills/research/SKILL.md': forkedSkillFile('context: fork\nagent: reviewer') },
    ));
    agent.skillForkResponder = () => ({ background: true, agentId: 'child-1' });

    await collectEvents(agent.chat('[skill:research] go'));
    expect(agent.skillForkCalls[0]!.agent).toBe('reviewer');
  });

  it('forks a MODEL-invoked skill too, on the continuation route', async () => {
    // R69's lesson: a property that holds on the user route and not on the model
    // route is a property that does not hold. The model emits `[skill:…]`, the
    // continuation is built, and the body must go to the child there as well.
    agent.setCapabilityTurnRuntime(runtime(
      [skillHandle('research')],
      { '/skills/research/SKILL.md': forkedSkillFile('context: fork') },
    ));
    agent.skillForkResponder = () => {
      // The scripted text repeats every pass; stop it after the first so this
      // measures ONE model invocation rather than the pass cap.
      agent.scriptedEvents = [{ type: 'complete' }];
      return { background: true, agentId: 'child-1', taskId: 'task-skill-9' };
    };
    agent.scriptedEvents = [
      { type: 'text_complete', text: 'I will use [skill:research] for this.' },
      { type: 'complete' },
    ];

    await collectEvents(agent.chat('look into the parser'));

    expect(agent.skillForkCalls).toHaveLength(1);
    // The model's own trailing words become the skill's arguments, as they do
    // on the inline route; the CONTENT is still what drives the child.
    expect(agent.skillForkCalls[0]!.prompt).toStartWith(SKILL_BODY);
    // The continuation pass carries the fork receipt, never the instructions.
    const continuation = agent.chatCalls[1]!.message;
    expect(continuation).toContain('<forked-skill name="research" status="running"');
    expect(continuation).not.toContain(SKILL_BODY);
    expect(continuation).toContain('its instructions are not shown here');
  });
});
