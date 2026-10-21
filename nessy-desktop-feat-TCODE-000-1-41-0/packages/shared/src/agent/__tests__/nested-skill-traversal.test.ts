/**
 * R79 — a package's own skills load on the read that reaches into the package.
 *
 * `skills.md:124` whole: "Skills also load from nested `.claude/skills/`
 * directories below your working directory. When Claude reads or edits a file in
 * a subdirectory, skills from that subdirectory's `.claude/skills/` become
 * available. This lets a monorepo package provide its own skills that apply when
 * working on that package, even if the session started at the repo root."
 * `:154`: they "load the first time Claude reads or edits a file inside that
 * subdirectory, and stay available for the rest of the session", and until then
 * "don't appear in autocomplete and can't be invoked by name".
 *
 * Everything here runs through `runPreToolUseChecks` — the production gate with
 * real tool inputs — on the SAME `**\/*` probe the nested-instruction channel
 * uses. The point of the first test is the seam that cannot be checked from
 * either side alone: the agent registers a root under a key it spells from its
 * own config, and `buildNativeCapabilityInventory` reads it under a key it spells
 * from the workspace policy context. If those two spellings ever drift, the
 * feature is silently inert.
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import {
  MAX_NESTED_SKILL_ROOTS,
  buildNativeCapabilityInventory,
  clearNestedSkillRoots,
} from '../../capabilities/native-sources.ts';
import { onNativeSourceInvalidation } from '../../capabilities/invalidation.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef } from '../../capabilities/resolver.ts';
import type { WorkspacePolicyContext } from '../../capabilities/types.ts';
import { TestAgent, createMockBackendConfig, createMockSession, createMockWorkspace } from './test-utils.ts';

const WORKSPACE_ID = 'test-workspace-id';
const PROJECT_KEY = 'pk-nested-skill';

/** Stands in for Pi and Claude — the backends that run the gate. */
class NestedSkillAgent extends TestAgent {
  protected override get deliversPathScopedActivations(): boolean { return true; }
  buildPinned() { return this.buildPinnedCapabilityContext(); }
  gateContext() { return this.getPathScopedRulePreToolUseContext(); }
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
  clearNestedSkillRoots();
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

function writeSkill(dir: string, slug: string, body: string): void {
  mkdirSync(join(dir, slug), { recursive: true });
  writeFileSync(join(dir, slug, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${body}\n---\n\n${body}\n`);
}

function resource(absolutePath: string): NativeResourceRef {
  return {
    source: 'project',
    scope: { kind: 'project', workspaceId: WORKSPACE_ID },
    resourceId: absolutePath,
    absolutePath,
    revision: '1',
    contentHash: 'f'.repeat(64),
  };
}

/** A trusted generation whose skill list is whatever the caller passes. */
function runtime(
  project: string,
  skills: CapabilityTurnRuntime['view']['skills'] = [],
  projectTrustState: CapabilityTurnRuntime['projectTrustState'] = 'trusted',
): CapabilityTurnRuntime {
  return {
    provider: 'pi',
    projectTrustState,
    view: {
      generation: 'generation-nested-skill-1',
      sources: [], skills, mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(res: unknown) { return (res as NativeResourceRef).absolutePath; },
      async readText() { return 'skill body'; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as unknown as CapabilityTurnRuntime;
}

/** A monorepo whose `apps/web` owns a `deploy` skill, plus a root `deploy`. */
function fixture(): { project: string; trigger: string } {
  const project = tmp('nested-skill-agent-');
  writeSkill(join(project, '.agents', 'skills'), 'deploy', 'root deploy');
  mkdirSync(join(project, 'apps', 'web', 'src'), { recursive: true });
  writeSkill(join(project, 'apps', 'web', '.agents', 'skills'), 'deploy', 'web deploy');
  writeFileSync(join(project, 'apps', 'web', 'src', 'x.ts'), 'export const x = 1;');
  return { project, trigger: join(project, 'apps', 'web', 'src', 'x.ts') };
}

async function harness(
  project: string,
  skills: CapabilityTurnRuntime['view']['skills'] = [],
  projectTrustState: CapabilityTurnRuntime['projectTrustState'] = 'trusted',
): Promise<NestedSkillAgent> {
  const agent = new NestedSkillAgent(createMockBackendConfig({
    workspace: createMockWorkspace(),
    session: createMockSession({ workingDirectory: project }),
    filesystemScope: {
      session: { workspaceId: WORKSPACE_ID, sessionId: 'test-session-id' },
      projectKey: PROJECT_KEY,
      primaryRoot: project,
      cwd: project,
      additionalRoots: [],
      managedExclusions: [],
      generation: 'fs-1',
    },
  }));
  agent.setCapabilityTurnRuntime(runtime(project, skills, projectTrustState));
  await agent.buildPinned();
  return agent;
}

/** One real gate call on `filePath`, with whatever the agent's gate context is. */
function readFile(agent: NestedSkillAgent, project: string, filePath: string): void {
  const sessionKey = { workspaceId: 'ws-nested-skill', sessionId: `nested-skill-${sessionCounter++}` };
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
    workspaceId: 'ws-nested-skill',
    workingDirectory: project,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
    ...agent.gateContext(),
  };
  runPreToolUseChecks(ctx);
}

/** The inventory the server would build for this session on its next turn. */
function nestedSkillsAfterActivation(project: string): Array<{ name: string; qualifier?: string }> {
  const context: WorkspacePolicyContext = {
    workspaceId: WORKSPACE_ID,
    workspaceRootPath: tmp('nested-skill-agent-ws-'),
    projectTrustState: 'trusted',
    projectTrustRevision: '1',
    projectRoot: project,
    workingDirectory: project,
    projectKey: PROJECT_KEY as WorkspacePolicyContext['projectKey'],
  };
  return buildNativeCapabilityInventory(context, {
    configDir: tmp('nested-skill-agent-cfg-'),
    homeAgentsSkillsDir: tmp('nested-skill-agent-home-'),
    instructionExcludes: [],
    // P2.455 — pinned OFF: the administrator tier's DEFAULT roots are absolute
    // machine-wide directories, so an unpinned rig reads the REAL ones on a
    // centrally managed host and a fixture everywhere else. `[]` means "no
    // administrator tier"; the standing guard is `admin-skills-dirs-pinned.test.ts`.
    adminSkillsDirs: [],
  }).records
    .filter(record => record.kind === 'skill')
    .map(record => ({
      name: record.logicalName,
      ...(record.skillDirectoryQualifier ? { qualifier: record.skillDirectoryQualifier } : {}),
    }));
}

describe('a nested skill becomes available on the read that reaches it', () => {
  it('registers the owning directory and the next inventory carries it', async () => {
    const { project, trigger } = fixture();
    const agent = await harness(project);

    // `:154` — "Until then, those skills don't appear in autocomplete and can't
    // be invoked by name."
    expect(nestedSkillsAfterActivation(project)).toEqual([{ name: 'deploy' }]);

    readFile(agent, project, trigger);

    expect(nestedSkillsAfterActivation(project)).toEqual([
      { name: 'deploy' },
      { name: 'deploy', qualifier: 'apps/web' },
    ]);

    agent.destroy();
  });

  it('asks the resolver to refresh exactly once per newly reached subtree', async () => {
    const { project, trigger } = fixture();
    writeSkill(join(project, 'apps', 'api', '.agents', 'skills'), 'seed', 'api seed');
    writeFileSync(join(project, 'apps', 'api', 'main.ts'), 'x');
    const agent = await harness(project);

    const events: string[] = [];
    const unsubscribe = onNativeSourceInvalidation(event => events.push(event.kind));

    readFile(agent, project, trigger);
    expect(events).toEqual(['skill']);
    // A second read in the SAME subtree changes nothing, so it must not make
    // every file read re-resolve the snapshot.
    readFile(agent, project, join(project, 'apps', 'web', 'src', 'other.ts'));
    expect(events).toEqual(['skill']);
    // A different package is a real change.
    readFile(agent, project, join(project, 'apps', 'api', 'main.ts'));
    expect(events).toEqual(['skill', 'skill']);

    unsubscribe();
    agent.destroy();
  });

  it('leaves the working directory\'s own skills to the eager pass', async () => {
    const { project } = fixture();
    const agent = await harness(project);
    writeFileSync(join(project, 'top.ts'), 'x');

    readFile(agent, project, join(project, 'top.ts'));

    expect(nestedSkillsAfterActivation(project)).toEqual([{ name: 'deploy' }]);
    agent.destroy();
  });

  it('contributes nothing when the project is not trusted', async () => {
    const { project, trigger } = fixture();
    const agent = await harness(project, [], 'none');

    readFile(agent, project, trigger);

    expect(nestedSkillsAfterActivation(project)).toEqual([{ name: 'deploy' }]);
    agent.destroy();
  });

  it('stops at the accumulation cap', async () => {
    const { project } = fixture();
    const agent = await harness(project);

    let dir = project;
    for (let level = 0; level < MAX_NESTED_SKILL_ROOTS + 3; level += 1) {
      dir = join(dir, `deep${level}`);
      writeSkill(join(dir, '.agents', 'skills'), `s${level}`, `deep ${level}`);
    }
    readFile(agent, project, join(dir, 'x.ts'));

    const qualified = nestedSkillsAfterActivation(project).filter(entry => entry.qualifier);
    expect(qualified).toHaveLength(MAX_NESTED_SKILL_ROOTS);
    // Once the budget is spent, a further read in an untouched subtree adds none.
    readFile(agent, project, join(project, 'apps', 'web', 'src', 'x.ts'));
    expect(nestedSkillsAfterActivation(project).filter(entry => entry.qualifier))
      .toHaveLength(MAX_NESTED_SKILL_ROOTS);

    agent.destroy();
  });
});

describe('the directory-qualified reference form', () => {
  const nestedHandle = (project: string) => ({
    key: 'skill::project::nested:apps/web::deploy',
    logicalName: 'deploy',
    description: 'web deploy',
    selectedAsUnqualifiedAlias: false,
    directoryQualifier: 'apps/web',
    resource: resource(join(project, 'apps', 'web', '.agents', 'skills', 'deploy', 'SKILL.md')),
  });
  const rootHandle = (project: string) => ({
    key: 'skill::project::d0::deploy',
    logicalName: 'deploy',
    description: 'root deploy',
    selectedAsUnqualifiedAlias: true,
    resource: resource(join(project, '.agents', 'skills', 'deploy', 'SKILL.md')),
  });

  it('resolves apps/web:deploy to the nested variant and /deploy to the root one', async () => {
    // `:132`, whole line: "Typing `/deploy` runs the project-root skill. Type the
    // qualified name `/apps/web:deploy` to run the nested variant explicitly."
    const { project } = fixture();
    const agent = await harness(project, [rootHandle(project), nestedHandle(project)]);

    const qualified = await agent.extractSkillInvocationsForTest('[skill:apps/web:deploy] go');
    expect(qualified.missingSkills).toEqual([]);
    expect([...qualified.invocations.values()].map(invocation => invocation.key))
      .toEqual(['skill::project::nested:apps/web::deploy']);

    const bare = await agent.extractSkillInvocationsForTest('[skill:deploy] go');
    expect(bare.missingSkills).toEqual([]);
    expect([...bare.invocations.values()].map(invocation => invocation.key))
      .toEqual(['skill::project::d0::deploy']);

    agent.destroy();
  });

  it('reports an unknown directory as missing rather than falling back to the root skill', async () => {
    const { project } = fixture();
    const agent = await harness(project, [rootHandle(project), nestedHandle(project)]);

    const result = await agent.extractSkillInvocationsForTest('[skill:apps/mobile:deploy] go');
    expect(result.missingSkills).toEqual(['apps/mobile:deploy']);
    expect(result.invocations).toHaveLength(0);

    agent.destroy();
  });
});
