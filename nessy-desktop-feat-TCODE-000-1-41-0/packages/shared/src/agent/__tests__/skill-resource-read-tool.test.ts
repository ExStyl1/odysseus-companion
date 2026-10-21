/**
 * R17 Task 2 — the resolver for `skill-resource:` handles.
 *
 * P7 minted handles (`capabilities/runtime-skill-content.ts:288`) and validated
 * their format (`:128`) but nothing in the tree could turn one back into bytes
 * (`docs/superpowers/plans/2026-07-26-skills-invocation.md:485-513`). These
 * tests drive the PRODUCTION surface the model actually reaches — the canonical
 * session-tool registry entry, executed against a `SessionToolContext` wired the
 * way `session-scoped-tools.ts` / `pi-agent.ts` wire it — never the bare resolve
 * function. A resolver a unit calls directly while the emitted handle never
 * reaches the model is the defect this series keeps shipping.
 *
 * Contract source: `code.claude.com/docs/en/skills.md` "Add supporting files" —
 * reference material is loaded "only when needed", and a skill's own SKILL.md is
 * what tells Claude "what each file contains and when to load it".
 */
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  getSessionToolRegistry,
  getToolDefsAsJsonSchema,
} from '@nessy-agent/session-tools-core';
import type { SessionToolContext } from '@nessy-agent/session-tools-core';
import { createClaudeContext } from '../claude-context.ts';
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts';
import { unregisterSessionScopedToolCallbacks } from '../session-scoped-tool-callback-registry.ts';
import { createPiExecutionManifestSeed, finalizePiExecutionManifest, type PiDynamicToolDefinition } from '../pi-harness/harness-manifest.ts';
import { getSessionToolProxyDefs } from '../backend/pi/session-tool-defs.ts';
import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts';
import type { AgentRuntimeView } from '../../capabilities/views.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import { TestAgent, createMockBackendConfig, createMockSession, createMockWorkspace } from './test-utils.ts';

const TOOL_NAME = 'read_skill_resource';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function collectEvents(generator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function reviewSkill(workspaceId: string) {
  return {
    key: 'skill://workspace/review',
    logicalName: 'review',
    description: 'Review code',
    selectedAsUnqualifiedAlias: true,
    resource: {
      source: 'workspace' as const,
      scope: { kind: 'workspace' as const, workspaceId },
      resourceId: 'review',
      absolutePath: '/secret/skills/review/SKILL.md',
      revision: 'r1',
      contentHash: 'a'.repeat(64),
    },
  };
}

/** A capability turn runtime whose supporting file can be mutated on disk mid-test. */
function runtimeWithGuide(
  workspaceId: string,
  onDisk: { content: string },
): CapabilityTurnRuntime {
  const skill = reviewSkill(workspaceId);
  return {
    view: {
      generation: 'test-generation',
      sources: [], skills: [skill], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/secret/skills/review/SKILL.md'; },
      async readText() { return 'Read [the guide](references/guide.md) before reviewing.'; },
      async readRelativeText(_resource: unknown, relativePath: string) {
        if (relativePath !== 'references/guide.md') throw new Error('missing');
        return { content: onDisk.content, contentHash: sha256(onDisk.content) };
      },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as CapabilityTurnRuntime;
}

function toolContext(workspaceId: string, sessionId: string): SessionToolContext {
  const context = createClaudeContext({
    sessionId,
    workspacePath: '/test/workspace',
    workspaceId,
    sessionPath: `/test/sessions/${workspaceId}/${sessionId}`,
    onPlanSubmitted: () => {},
    onAuthRequest: () => {},
  });
  attachSessionSelfManagementBindings(context, { workspaceId, sessionId });
  return context;
}

async function callReadSkillResource(
  context: SessionToolContext,
  handle: string,
): Promise<{ isError: boolean; text: string }> {
  const definition = getSessionToolRegistry().get(TOOL_NAME);
  if (!definition?.handler) throw new Error(`${TOOL_NAME} is not in the canonical session tool registry`);
  const result = await definition.handler(context, { handle });
  return {
    isError: result.isError === true,
    text: result.content.map(part => ('text' in part ? part.text : '')).join('\n'),
  };
}

/** Invoke the skill through the real chat path and return the emitted handle. */
async function invokeReviewSkill(input: {
  workspaceId: string;
  sessionId: string;
  onDisk: { content: string };
}): Promise<{ agent: TestAgent; handle: string; message: string }> {
  const agent = new TestAgent(createMockBackendConfig({
    workspace: createMockWorkspace({ id: input.workspaceId }),
    session: createMockSession({ id: input.sessionId, workspaceId: input.workspaceId }),
  }));
  agent.setCapabilityTurnRuntime(runtimeWithGuide(input.workspaceId, input.onDisk));
  await collectEvents(agent.chat('[skill:review] inspect this'));
  const message = agent.chatCalls[0]!.message;
  const handle = message.match(/skill-resource:[a-f0-9]{64}/)?.[0];
  if (!handle) throw new Error(`no skill-resource handle in the emitted turn: ${message.slice(0, 400)}`);
  return { agent, handle, message };
}

const sessionsToClean: { workspaceId: string; sessionId: string }[] = [];
function session(workspaceId: string, sessionId: string) {
  sessionsToClean.push({ workspaceId, sessionId });
  return { workspaceId, sessionId };
}

afterEach(() => {
  while (sessionsToClean.length > 0) unregisterSessionScopedToolCallbacks(sessionsToClean.pop()!);
});

describe('read_skill_resource', () => {
  it('resolves a handle to the exact pinned bytes through the session tool surface', async () => {
    const key = session('workspace-resolve', 'session-resolve');
    const onDisk = { content: 'PINNED GUIDE BODY' };
    const { handle } = await invokeReviewSkill({ ...key, onDisk });

    const result = await callReadSkillResource(toolContext(key.workspaceId, key.sessionId), handle);

    expect(result.isError).toBe(false);
    expect(result.text).toContain('PINNED GUIDE BODY');
    expect(result.text).toContain('references/guide.md');
    // The read path never hands the model the skill's absolute location.
    expect(result.text).not.toContain('/secret/skills');
  });

  it('refuses an unknown handle with a named error', async () => {
    const key = session('workspace-unknown', 'session-unknown');
    await invokeReviewSkill({ ...key, onDisk: { content: 'PINNED GUIDE BODY' } });

    const result = await callReadSkillResource(
      toolContext(key.workspaceId, key.sessionId),
      `skill-resource:${'b'.repeat(64)}`,
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain('skill-resource-unknown-handle');
  });

  it('reports on-disk drift instead of serving the new bytes', async () => {
    const key = session('workspace-drift', 'session-drift');
    const onDisk = { content: 'PINNED GUIDE BODY' };
    const { handle } = await invokeReviewSkill({ ...key, onDisk });

    // The supporting file changes after the invocation pinned it.
    onDisk.content = 'REWRITTEN GUIDE BODY';
    const result = await callReadSkillResource(toolContext(key.workspaceId, key.sessionId), handle);

    expect(result.isError).toBe(true);
    expect(result.text).toContain('skill-resource-changed');
    // The digest is the authority: neither the new bytes nor the stale ones leak.
    expect(result.text).not.toContain('REWRITTEN GUIDE BODY');
    expect(result.text).not.toContain('PINNED GUIDE BODY');
  });

  it('does not resolve a handle minted by another session', async () => {
    const owner = session('workspace-owner', 'session-owner');
    const other = session('workspace-owner', 'session-other');
    const { handle } = await invokeReviewSkill({ ...owner, onDisk: { content: 'OWNER GUIDE BODY' } });
    // A second live session that never invoked the skill.
    const bystander = new TestAgent(createMockBackendConfig({
      workspace: createMockWorkspace({ id: other.workspaceId }),
      session: createMockSession({ id: other.sessionId, workspaceId: other.workspaceId }),
    }));
    bystander.setCapabilityTurnRuntime(runtimeWithGuide(other.workspaceId, { content: 'OWNER GUIDE BODY' }));
    await collectEvents(bystander.chat('unrelated turn'));

    const result = await callReadSkillResource(toolContext(other.workspaceId, other.sessionId), handle);

    expect(result.isError).toBe(true);
    expect(result.text).toContain('skill-resource-unknown-handle');
    expect(result.text).not.toContain('OWNER GUIDE BODY');
  });

  it('sends the model a handle tag instead of the file body, and the handle resolves', async () => {
    const key = session('workspace-lazy', 'session-lazy');
    const { handle, message } = await invokeReviewSkill({ ...key, onDisk: { content: 'GUIDE BODY TEXT' } });

    // The turn the model receives advertises the file; it does not contain it.
    expect(message).toContain('<skill-resource ');
    expect(message).toContain('path="references/guide.md"');
    expect(message).not.toContain('GUIDE BODY TEXT');
    expect(message).not.toContain('</skill-resource>');

    const result = await callReadSkillResource(toolContext(key.workspaceId, key.sessionId), handle);

    expect(result.isError).toBe(false);
    expect(result.text).toContain('GUIDE BODY TEXT');
  });

  it('keeps resources off the re-attached turn after compaction and still resolves the handle', async () => {
    const key = session('workspace-compact', 'session-compact');
    const onDisk = { content: 'GUIDE BODY TEXT' };
    const { agent, handle } = await invokeReviewSkill({ ...key, onDisk });

    agent.resetPrerequisiteState();
    await collectEvents(agent.chat('continue after compact'));
    const reattached = agent.chatCalls.at(-1)!.message;

    // R8's re-attach budget still strips resources entirely.
    expect(reattached).toContain('<invoked-skill ');
    expect(reattached).not.toContain('<skill-resource ');
    expect(reattached).not.toContain('GUIDE BODY TEXT');
    expect(agent.getActiveSkillContinuationReferencesForTest()
      .every(reference => reference.snapshot.supportingResources.length === 0)).toBe(true);

    // The live session still holds the pinned bytes, so a later fetch works.
    const result = await callReadSkillResource(toolContext(key.workspaceId, key.sessionId), handle);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('GUIDE BODY TEXT');
  });

  it('is present in the projected Pi execution manifest, not just the descriptor list', () => {
    const bindingName = `mcp__session__${TOOL_NAME}`;
    // The exact list pi-agent.ts:1431 starts from.
    expect(getSessionToolProxyDefs().map(definition => definition.name)).toContain(bindingName);

    const view: AgentRuntimeView = {
      generation: 'generation-skill-resource-manifest',
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    };
    const snapshot = {
      context: { workspaceId: 'workspace-1', sessionId: 'session-1', projectTrustState: 'none', projectTrustRevision: '' },
      generation: view.generation,
      leaseId: 'lease-skill-resource-manifest',
      entries: [],
      installedPlugins: [],
      diagnostics: [],
    } as unknown as EffectiveCapabilitySnapshot;
    const seed = createPiExecutionManifestSeed({
      snapshot,
      view,
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    });
    const dynamicTools: PiDynamicToolDefinition[] = getToolDefsAsJsonSchema({
      prefix: 'mcp__session__',
      includeDeveloperFeedback: true,
      projection: 'pi',
    }).map(definition => ({
      bindingName: definition.name,
      description: definition.description ?? definition.name,
      inputSchema: definition.inputSchema as Record<string, unknown>,
      modelSchemaVersion: 1 as const,
      bindingSchemaVersion: 1 as const,
      provenance: { capabilityKey: 'runtime:pi-session', generation: seed.snapshotGeneration },
    }));
    const manifest = finalizePiExecutionManifest(seed, dynamicTools);

    expect(manifest.tools.map(tool => tool.binding.bindingName)).toContain(bindingName);
  });
});
