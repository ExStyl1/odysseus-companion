/**
 * P6.384 — the two host-side skill gates, driven end to end.
 *
 * `disableSkillShellExecution` is the vendor's own settings key and
 * `disableSkills` is ours (the binary has no counterpart — both measurements are
 * in `config/skill-gates.ts`). Both are read in `BaseAgent`, which is the seam
 * all three runtimes share, so what is asserted here is one behaviour rather
 * than three.
 *
 * Every arm has its control, because a gate that cannot be seen to be OFF is
 * indistinguishable from a feature that never worked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { SKILL_SHELL_EXECUTION_DISABLED_PLACEHOLDER } from '../../config/skill-gates.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import { TestAgent, createMockBackendConfig, collectEvents } from './test-utils.ts';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const SKILL_BODY = 'summary: !`echo hello`\n';

let previousConfig: string | null = null;
let sandbox: string;

/** Write one top-level key into the stored config, preserving the rest. */
function setSetting(key: string, value: unknown): void {
  const base = previousConfig
    ? JSON.parse(previousConfig)
    : { storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null };
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...base, [key]: value }), 'utf-8');
}

function clearSettings(): void {
  if (previousConfig === null) rmSync(CONFIG_FILE, { force: true });
  else writeFileSync(CONFIG_FILE, previousConfig, 'utf-8');
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'nessy-skill-gates-'));
  mkdirSync(CONFIG_DIR, { recursive: true });
  previousConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
});

afterAll(() => {
  clearSettings();
  rmSync(sandbox, { recursive: true, force: true });
});

function runtimeWithPluginSkill(): CapabilityTurnRuntime {
  const skill = {
    key: 'skill://workspace/shelly',
    logicalName: 'shelly',
    description: 'runs a command before the model sees the body',
    selectedAsUnqualifiedAlias: true,
    // The renderer executes only for a skill carrying a verified plugin bundle,
    // so the fixture carries one — otherwise the control arm would pass for the
    // wrong reason (nothing executed because nothing was eligible).
    pluginRuntime: {
      rootPath: '/cache/shelly', dataPath: '/data/shelly', bundleHash: 'd'.repeat(64),
      profile: 'generic-plugin-env-v1',
    },
    resource: {
      source: 'workspace' as const,
      scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
      resourceId: 'shelly',
      absolutePath: '/private/shelly/SKILL.md',
      revision: 'r1',
      contentHash: '9'.repeat(64),
      // `collectPluginSkillRuntime` refuses a plugin skill whose resource does
      // not carry its instance id, so the fixture carries one — the shape a real
      // plugin skill has.
      pluginInstanceId: 'plugin://internal/shelly@1.0.0',
    },
  };
  return {
    provider: 'pi',
    view: {
      generation: 'test-generation',
      sources: [], skills: [skill], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      // Annotated because the literal is cast to `CapabilityTurnRuntime` as a
      // whole, which switches contextual typing off for its members.
      async resolvePath(resource: { absolutePath?: string }) {
        return resource.absolutePath ?? '/test/plugin-resource';
      },
      async readText() { return SKILL_BODY; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as unknown as CapabilityTurnRuntime;
}

/**
 * An agent with a recording executor. Every arm gets one, including the listing
 * arms: the fixture skill carries a placeholder, and the renderer refuses with
 * `runtime-skill-context-executor-unavailable` when a body needs an executor and
 * the session has none — an absence that would fail the listing tests for a
 * reason that has nothing to do with the gate under test.
 */
function agentWithExecutor(): { agent: TestAgent; executed: string[] } {
  const executed: string[] = [];
  const agent = new TestAgent(createMockBackendConfig({
    runtimeSkillContextExecutor: async (request: { command: string }) => {
      executed.push(request.command);
      return 'RAN-THE-COMMAND';
    },
  }));
  agent.setCapabilityTurnRuntime(runtimeWithPluginSkill());
  return { agent, executed };
}

async function invokeSkill() {
  const { agent, executed } = agentWithExecutor();
  await collectEvents(agent.chat('[skill:shelly] go'));
  return { executed, message: agent.chatCalls.at(-1)!.message, agent };
}

describe('P6.384 — disableSkillShellExecution', () => {
  it('replaces the command with a named placeholder and runs nothing', async () => {
    setSetting('disableSkillShellExecution', true);
    const { executed, message } = await invokeSkill();
    expect(executed).toEqual([]);
    expect(message).toContain(SKILL_SHELL_EXECUTION_DISABLED_PLACEHOLDER);
    // The author's shell instruction must not survive into the prompt either:
    // handing the model the command text is the outcome `skills.md` rules out.
    expect(message).not.toContain('!`echo hello`');
    clearSettings();
  });

  it('CONTROL: with the gate off the command still runs and its output lands', async () => {
    clearSettings();
    const { executed, message } = await invokeSkill();
    expect(executed).toEqual(['echo hello']);
    expect(message).toContain('RAN-THE-COMMAND');
    expect(message).not.toContain(SKILL_SHELL_EXECUTION_DISABLED_PLACEHOLDER);
  });
});

describe('P6.384 — disableSkills', () => {
  const listingOf = (agent: TestAgent): string | undefined =>
    (agent as unknown as { promptBuilder: { buildSkillListingPart(): string | undefined } })
      .promptBuilder.buildSkillListingPart();

  it('empties the model listing while the skill stays dispatchable by name', async () => {
    setSetting('disableSkills', true);
    const { agent } = agentWithExecutor();
    expect(listingOf(agent)).toBeUndefined();
    // The split this gate deliberately keeps: the listing is what the model
    // reads, and a user who names the skill still gets it.
    await collectEvents(agent.chat('[skill:shelly] go'));
    expect(agent.chatCalls.at(-1)!.message).toContain('<invoked-skill ');
    clearSettings();
  });

  it('CONTROL: with the gate off the skill is listed to the model', async () => {
    clearSettings();
    const { agent } = agentWithExecutor();
    const listing = listingOf(agent);
    expect(listing).toContain('<available_skills>');
    expect(listing).toContain('shelly');
  });
});
