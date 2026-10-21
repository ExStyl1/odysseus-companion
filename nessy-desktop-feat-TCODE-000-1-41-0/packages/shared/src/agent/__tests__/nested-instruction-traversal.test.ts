/**
 * S1 — a subdirectory instruction file loads when a file under it is read.
 *
 * `memory.md:157` whole: "Claude also discovers `CLAUDE.md` and
 * `CLAUDE.local.md` files in subdirectories under your current working
 * directory. Instead of loading them at launch, they are included when Claude
 * reads files in those subdirectories." `:447`: nested files "are not
 * re-injected automatically; they reload the next time Claude reads a file in
 * that subdirectory."
 *
 * Everything here runs through `runPreToolUseChecks` — the production gate with
 * real tool inputs — and takes delivery through
 * `consumePendingPathScopedRuleContext`, the SINGLE lazy channel R28 built and
 * the one Pi already folds into the PreToolUse `additionalContext`. A second
 * delivery mechanism would be the defect this file exists to prevent.
 *
 * `nested_traversal` was in the `load_reason` union with zero producers
 * (hooks.md#instructionsloaded); the event assertions below are that producer.
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import { MAX_NESTED_INSTRUCTION_FILES } from '../../capabilities/native-sources.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef } from '../../capabilities/resolver.ts';
import type { AgentAutomationSystem, SdkAutomationInput } from '../../automations/types.ts';
import { TestAgent, createMockBackendConfig, createMockSession, createMockWorkspace } from './test-utils.ts';

/** Stands in for Pi and Claude — the backends that run the gate. */
class NestedAgent extends TestAgent {
  protected override get deliversPathScopedActivations(): boolean { return true; }
  buildPinned() { return this.buildPinnedCapabilityContext(); }
  gateContext() { return this.getPathScopedRulePreToolUseContext(); }
  pendingContext() { return this.consumePendingPathScopedRuleContext(); }
}

const roots: string[] = [];
const sessionKeys: Array<{ workspaceId: string; sessionId: string }> = [];
let sessionCounter = 0;

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const key of sessionKeys) cleanupModeState(key);
});

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => true,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

function resource(absolutePath: string): NativeResourceRef {
  return {
    source: 'project',
    scope: { kind: 'project', workspaceId: 'ws' },
    resourceId: absolutePath,
    absolutePath,
    revision: '1',
    contentHash: 'f'.repeat(64),
  };
}

/** A trusted generation whose ONLY eager instruction file is the cwd's own. */
function runtime(project: string, generation = 'generation-nested-1'): CapabilityTurnRuntime {
  const rootInstruction = join(project, 'AGENTS.md');
  return {
    provider: 'pi',
    projectTrustState: 'trusted',
    view: {
      generation,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [{ key: 'instruction::project::AGENTS.md', resource: resource(rootInstruction), order: 3 }],
      memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(res: unknown) { return (res as NativeResourceRef).absolutePath; },
      async readText() { return 'root contract'; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as unknown as CapabilityTurnRuntime;
}

interface Harness {
  agent: NestedAgent;
  events: SdkAutomationInput[];
  project: string;
  trigger: string;
}

/** A monorepo whose `packages/foo` carries its own contract. */
async function harness(): Promise<Harness> {
  const project = tmp('nested-agent-');
  writeFileSync(join(project, 'AGENTS.md'), 'root contract');
  mkdirSync(join(project, 'packages', 'foo', 'src'), { recursive: true });
  writeFileSync(join(project, 'packages', 'foo', 'AGENTS.md'), 'foo package contract');
  writeFileSync(join(project, 'packages', 'foo', 'src', 'x.ts'), 'export const x = 1;');

  const events: SdkAutomationInput[] = [];
  const agent = new NestedAgent(createMockBackendConfig({
    workspace: createMockWorkspace(),
    session: createMockSession({ workingDirectory: project }),
  }));
  const automationSystem: AgentAutomationSystem = {
    async executeAgentEvent(event, input) {
      if (event === 'InstructionsLoaded') events.push(input);
      return { matchedCount: 0 };
    },
  };
  agent.setAutomationSystem(automationSystem);
  agent.setCapabilityTurnRuntime(runtime(project));
  await agent.buildPinned();
  await settle();
  events.length = 0;
  return { agent, events, project, trigger: join(project, 'packages', 'foo', 'src', 'x.ts') };
}

/** Let the fire-and-forget observational emits settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** One real gate call on `filePath`, with whatever the agent's gate context is. */
function readFile(agent: NestedAgent, project: string, filePath: string): void {
  const sessionKey = { workspaceId: 'ws-nested', sessionId: `nested-session-${sessionCounter++}` };
  sessionKeys.push(sessionKey);
  cleanupModeState(sessionKey);
  initializeModeState(sessionKey, 'bypassPermissions');
  const ctx: PreToolUseInput = {
    toolName: 'Read',
    input: { file_path: filePath },
    sessionId: sessionKey.sessionId,
    sessionKey,
    permissionMode: 'bypassPermissions',
    workspaceRootPath: project,
    workspaceId: 'ws-nested',
    workingDirectory: project,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
    ...agent.gateContext(),
  };
  runPreToolUseChecks(ctx);
}

describe('a nested instruction file loads on the read that reaches it', () => {
  it('delivers the package contract and reports nested_traversal', async () => {
    const { agent, events, project, trigger } = await harness();

    readFile(agent, project, trigger);
    await settle();

    const delivered = agent.pendingContext();
    expect(delivered).toContain('foo package contract');
    expect(delivered).toContain('<instructions file="AGENTS.md" dir="packages/foo">');

    // `5dcc08249` (P6.300) gave EVERY hook event the session's own transcript
    // path, which `hooks.md`'s common-input table lists beside `session_id`. It
    // is read out first and asserted on its own rather than folded into the
    // equality below, because its value is the isolated config dir this run was
    // given — and because an object asserted with a matcher and then read again
    // is the `toMatchObject` mutation trap.
    expect(events).toHaveLength(1);
    const { transcript_path: transcriptPath, ...event } = events[0]!;
    expect(transcriptPath)
      .toContain(join('sessions', 'test-workspace-id', 'test-session-id', 'session.jsonl'));
    expect([event]).toEqual([{
      hook_event_name: 'InstructionsLoaded',
      file_path: join(project, 'packages', 'foo', 'AGENTS.md'),
      memory_type: 'Project',
      load_reason: 'nested_traversal',
      trigger_file_path: trigger,
    }]);
    // "present only for `path_glob_match` loads" — a traversal load carries none.
    expect(events[0]!.globs).toBeUndefined();

    agent.destroy();
  });

  it('does not re-activate on a second read of the same subtree', async () => {
    const { agent, events, project, trigger } = await harness();

    readFile(agent, project, trigger);
    await settle();
    expect(agent.pendingContext()).toContain('foo package contract');
    events.length = 0;

    readFile(agent, project, join(project, 'packages', 'foo', 'src', 'other.ts'));
    await settle();
    expect(agent.pendingContext()).toBeUndefined();
    expect(events).toEqual([]);

    agent.destroy();
  });

  it('reloads after a compaction, on the next read in that subdirectory', async () => {
    const { agent, events, project, trigger } = await harness();

    readFile(agent, project, trigger);
    await settle();
    agent.pendingContext();

    // memory.md:447 — nested files "are not re-injected automatically; they
    // reload the next time Claude reads a file in that subdirectory."
    agent.resetPrerequisiteState();
    await settle();
    expect(events.some(event => event.load_reason === 'compact'
      && event.file_path === join(project, 'packages', 'foo', 'AGENTS.md'))).toBe(false);
    events.length = 0;

    readFile(agent, project, trigger);
    await settle();
    expect(agent.pendingContext()).toContain('foo package contract');
    expect(events.map(event => event.load_reason)).toEqual(['nested_traversal']);

    agent.destroy();
  });

  it('leaves the cwd\'s own file to the eager pinned block', async () => {
    const { agent, events, project } = await harness();

    readFile(agent, project, join(project, 'top-level.ts'));
    await settle();

    expect(agent.pendingContext()).toBeUndefined();
    expect(events).toEqual([]);

    agent.destroy();
  });

  it('stops at the accumulation cap', async () => {
    const { agent, project } = await harness();

    let dir = project;
    for (let level = 0; level < MAX_NESTED_INSTRUCTION_FILES + 3; level += 1) {
      dir = join(dir, `deep${level}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'CLAUDE.md'), `deep layer ${level}`);
    }
    readFile(agent, project, join(dir, 'x.ts'));
    await settle();

    const delivered = agent.pendingContext() ?? '';
    const blocks = delivered.match(/<instructions /g) ?? [];
    expect(blocks).toHaveLength(MAX_NESTED_INSTRUCTION_FILES);
    // A further read in an untouched subtree adds nothing once the cap is spent.
    readFile(agent, project, join(project, 'packages', 'foo', 'src', 'x.ts'));
    await settle();
    expect(agent.pendingContext()).toBeUndefined();

    agent.destroy();
  });

  it('contributes nothing when the project is not trusted', async () => {
    const { agent, events, project, trigger } = await harness();
    agent.setCapabilityTurnRuntime({
      ...runtime(project),
      projectTrustState: 'none',
    } as CapabilityTurnRuntime);
    await agent.buildPinned();
    await settle();
    events.length = 0;

    readFile(agent, project, trigger);
    await settle();

    expect(agent.pendingContext()).toBeUndefined();
    expect(events).toEqual([]);

    agent.destroy();
  });
});
