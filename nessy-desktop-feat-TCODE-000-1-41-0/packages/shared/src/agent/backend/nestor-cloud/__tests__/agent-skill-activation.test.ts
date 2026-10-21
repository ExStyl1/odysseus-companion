import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityMaterializationError } from '../../../../capabilities/materializer.ts';
import type { CapabilityTurnRuntime } from '../../types.ts';
import { NestorCloudAgent } from '../../../nestor-cloud-agent.ts';
import { formatNestorSkillContent, type NestorSkillActivation } from '../skills.ts';
import { createMockBackendConfig, createMockWorkspace } from '../../../__tests__/test-utils.ts';

const CHECKLIST = 'Step one.\nStep two.\n';

// Single-quoted on purpose: the `${…}` are SKILL variables, not TS interpolation.
const SKILL_MARKDOWN = [
  '---',
  'name: honey',
  'description: Honey',
  'disallowed-tools: Bash, Write',
  '---',
  'Session ${CLAUDE_SESSION_ID} in ${NESSY_PROJECT_DIR}.',
  '',
  'Follow the [checklist](references/checklist.md) before shipping.',
  '',
].join('\n');

function capabilityRuntime(root: string): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'nestor-test-generation',
      sources: [],
      skills: [{
        key: 'skill:plugin:honey',
        logicalName: 'honey',
        description: 'Honey',
        selectedAsUnqualifiedAlias: true,
        resource: {
          pluginInstanceId: 'plugin://test/honey@1.0.0',
          relativePath: 'skills/honey/SKILL.md',
          contentHash: 'a'.repeat(64),
        },
      }],
      mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [],
      memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return join(root, 'skills/honey/SKILL.md'); },
      async readText() { return SKILL_MARKDOWN; },
      async readRelativeText(_resource: unknown, relativePath: string) {
        if (relativePath !== 'references/checklist.md') throw new Error(`unexpected resource: ${relativePath}`);
        return { content: CHECKLIST, contentHash: createHash('sha256').update(CHECKLIST).digest('hex') };
      },
      async resolveSkillDirectory() { return join(root, 'skills/honey'); },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as unknown as CapabilityTurnRuntime;
}

function activateRemoteSkill(agent: NestorCloudAgent, name: string): Promise<NestorSkillActivation> {
  return (agent as unknown as {
    activateRemoteSkill(skillName: string): Promise<NestorSkillActivation>;
  }).activateRemoteSkill(name);
}

describe('NestorCloudAgent.activateRemoteSkill', () => {
  it('sends the author\'s file paths and the expanded host variables, not opaque handles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nestor-cloud-skill-'));
    const agent = new NestorCloudAgent(createMockBackendConfig({
      provider: 'nestor-cloud-agent',
      workspace: createMockWorkspace({ workspaceRootPath: root, sessionRootPath: join(root, 'sessions') }),
      session: undefined,
    }));
    agent.setSessionId('session-abc');
    agent.setCapabilityTurnRuntime(capabilityRuntime(root));

    const activation = await activateRemoteSkill(agent, 'honey');
    const content = formatNestorSkillContent({ ...activation, name: 'honey' });

    // `materializeSupportingResources` rewrote `references/checklist.md` into a
    // `skill-resource:<hex>` handle (`runtime-skill-content.ts:1175`). That handle
    // resolves through OUR capability runtime; the remote model has `read_file`
    // and no way to ask for it, so the reference must go back to the path the
    // `Skill directory:` line makes readable.
    expect(activation.body).toContain('references/checklist.md');
    expect(activation.body).not.toContain('skill-resource:');
    expect(content).not.toContain('skill-resource:');

    // `expandRuntimeSkillBody` only expands the host variables the caller supplies
    // (`runtime-skill-content.ts:1059-1065`); with no host they stayed literal.
    expect(activation.body).toContain(`Session session-abc in ${root}.`);
    expect(activation.body).not.toContain('${CLAUDE_SESSION_ID}');

    // The author's `disallowed-tools` cannot be enforced on a model that runs
    // remotely, so it is STATED rather than dropped in silence.
    expect(content).toContain('Disallowed tools (author restriction, not enforced remotely): Bash, Write');
    expect(content).toContain(`Skill directory: ${join(root, 'skills/honey')}`);

    agent.destroy();
  });
});
