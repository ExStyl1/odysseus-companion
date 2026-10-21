/**
 * R30a Task 4 — the `paths` frontmatter field.
 *
 * `code.claude.com/docs/en/skills.md:267`: "Glob patterns that limit when this
 * skill is activated. Accepts a comma-separated string or a YAML list. When set,
 * Claude loads the skill automatically only when working with files matching the
 * patterns. Uses the same format as path-specific rules."
 *
 * Two things that sentence decides, and that this file pins:
 *
 * 1. It limits AUTOMATIC activation. The user's own invocation is never gated —
 *    getting that backwards would hide a skill from its own `/name`.
 * 2. "the same format as path-specific rules" is an instruction to reuse R28's
 *    matcher on R28's seam, not to write a second glob engine.
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { afterAll, describe, expect, it } from 'bun:test';
import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef } from '../../capabilities/resolver.ts';
import { TestAgent, collectEvents, createMockBackendConfig, createMockSession } from './test-utils.ts';

const PROJECT = '/fixture/project';

/** Stands in for Pi and Claude — the backends that run the gate. */
class PathSkillAgent extends TestAgent {
  protected override get deliversPathScopedActivations(): boolean { return true; }
  gateContext() { return this.getPathScopedRulePreToolUseContext(); }
}

/** Stands in for Codex and the Nestor cloud agent, which do not run the gate. */
class NoTriggerAgent extends TestAgent {
  gateContext() { return this.getPathScopedRulePreToolUseContext(); }
}

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => true,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

const sessionKeys: Array<{ workspaceId: string; sessionId: string }> = [];
afterAll(() => { for (const key of sessionKeys) cleanupModeState(key); });

function runtimeWithPathSkill(paths: string[] | undefined): CapabilityTurnRuntime {
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
      generation: 'generation-paths-skill',
      sources: [],
      skills: [{
        key: 'skill:project:py',
        logicalName: 'py',
        description: 'Python helper',
        selectedAsUnqualifiedAlias: true,
        resource,
        ...(paths ? { paths } : {}),
      }],
      mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [],
      commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return resource.absolutePath; },
      async readText() { return 'Python guidance.'; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as CapabilityTurnRuntime;
}

/** One real gate call, so activation runs through production's own seam. */
function readFile(agent: PathSkillAgent, filePath: string): void {
  const sessionKey = { workspaceId: 'ws-paths', sessionId: `paths-${sessionKeys.length}` };
  sessionKeys.push(sessionKey);
  cleanupModeState(sessionKey);
  initializeModeState(sessionKey, 'bypassPermissions');
  const ctx: PreToolUseInput = {
    toolName: 'Read',
    input: { file_path: filePath },
    sessionId: sessionKey.sessionId,
    sessionKey,
    permissionMode: 'bypassPermissions',
    workspaceRootPath: PROJECT,
    workspaceId: 'ws-paths',
    workingDirectory: PROJECT,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
    ...agent.gateContext(),
  };
  runPreToolUseChecks(ctx);
}

async function agentWith(paths: string[] | undefined): Promise<PathSkillAgent> {
  const agent = new PathSkillAgent(createMockBackendConfig({
    session: createMockSession({ workingDirectory: PROJECT }),
  }));
  agent.setCapabilityTurnRuntime(runtimeWithPathSkill(paths));
  // The gate context is served from the pinned-context cache, which is composed
  // on the first turn — so run one, exactly as R28's trigger test does.
  await collectEvents(agent.chat('go'));
  return agent;
}

describe('paths-gated skills', () => {
  it('refuses MODEL invocation until a matching file is read', async () => {
    const agent = await agentWith(['**/*.py']);

    const before = await agent.extractModelSkillInvocationsForTest('Let me use [skill:py] here.');
    expect(before.refused).toEqual(['py']);
    expect(before.invocations).toHaveLength(0);

    // A TypeScript file does not bring it into scope.
    readFile(agent, `${PROJECT}/src/app.ts`);
    expect((await agent.extractModelSkillInvocationsForTest('[skill:py]')).refused).toEqual(['py']);

    // A matching file does — through the same matcher R28 uses.
    readFile(agent, `${PROJECT}/src/app.py`);
    const after = await agent.extractModelSkillInvocationsForTest('Use [skill:py] now.');
    expect(after.refused).toEqual([]);
    expect(after.invocations.map(invocation => invocation.name)).toEqual(['py']);
  });

  it('never gates the USER invoking the skill by name', async () => {
    const agent = await agentWith(['**/*.py']);

    // No file has been read at all: the model cannot reach it, the user can.
    expect((await agent.extractModelSkillInvocationsForTest('[skill:py]')).refused).toEqual(['py']);
    const user = await agent.extractSkillInvocationsForTest('[skill:py] please');
    expect(user.missingSkills).toEqual([]);
    expect(user.invocations.map(invocation => invocation.name)).toEqual(['py']);
  });

  it('leaves a skill without paths always eligible', async () => {
    const agent = await agentWith(undefined);
    const result = await agent.extractModelSkillInvocationsForTest('[skill:py]');
    expect(result.refused).toEqual([]);
    expect(result.invocations).toHaveLength(1);
  });

  it('stays inert on a backend that never delivers activations', async () => {
    // Codex and the Nestor cloud agent do not run `runPreToolUseChecks`, so
    // nothing there could ever answer "yes". Refusing forever would not be the
    // documented gate, it would be a dead skill.
    const agent = new NoTriggerAgent(createMockBackendConfig({
      session: createMockSession({ workingDirectory: PROJECT }),
    }));
    agent.setCapabilityTurnRuntime(runtimeWithPathSkill(['**/*.py']));
    await collectEvents(agent.chat('go'));

    const result = await agent.extractModelSkillInvocationsForTest('[skill:py]');
    expect(result.refused).toEqual([]);
    expect(result.invocations).toHaveLength(1);
  });
});
