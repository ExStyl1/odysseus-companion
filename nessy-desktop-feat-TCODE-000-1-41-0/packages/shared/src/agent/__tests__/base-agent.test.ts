/**
 * Tests for BaseAgent abstract class
 *
 * Uses TestAgent (concrete implementation) to verify BaseAgent functionality.
 * Tests model/thinking configuration, permission mode, source management,
 * and lifecycle management.
 */
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { describe, it, expect, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketplaceService } from '../../marketplace/service.ts';
import {
  createContinuationEnvelopeV1,
  revalidateContinuationEnvelopeV1,
} from '../pi-harness/continuation-envelope.ts';
import {
  computeSkillInvocationDigest,
  validateSkillInvocationSnapshot,
} from '../../capabilities/runtime-skill-content.ts';
import { estimateTokens } from '../../utils/large-response.ts';
import { loadProjectMcpServers } from '../../mcp/project-config.ts';
import type { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { AgentEvent, AgentTerminalReason } from '@nessy-agent/core/types';
// P2.227(d) — the join test below feeds the REAL claude emitter's crash
// `complete` to the REAL guard, so the two suites stop meeting by construction.
import { ClaudeEventAdapter } from '../backend/claude/event-adapter.ts';
import type { AgentAutomationSystem } from '../../automations/types.ts';
import {
  AbortReason,
  type CapabilityTurnRuntime,
  type SdkMcpServerConfig,
} from '../backend/types.ts';
import {
  TestAgent,
  createMockBackendConfig,
  createMockSession,
  createMockWorkspace,
  createMockSource,
  collectEvents,
} from './test-utils.ts';

describe('BaseAgent', () => {
  let agent: TestAgent;

  beforeEach(() => {
    agent = new TestAgent(createMockBackendConfig());
    agent.setCapabilityTurnRuntime(capabilityRuntime());
  });

  describe('Model Configuration', () => {
    it('should initialize with config model', () => {
      expect(agent.getModel()).toBe('test-model');
    });

    it('should allow setting model', () => {
      agent.setModel('new-model');
      expect(agent.getModel()).toBe('new-model');
    });
  });

  describe('Thinking Level Configuration', () => {
    it('should initialize with config thinking level', () => {
      expect(agent.getThinkingLevel()).toBe('medium');
    });

    it('should allow setting thinking level', () => {
      agent.setThinkingLevel('max');
      expect(agent.getThinkingLevel()).toBe('max');
    });

  });

  describe('Permission Mode', () => {
    it('should have a permission mode', () => {
      const mode = agent.getPermissionMode();
      expect(['plan', 'default', 'bypassPermissions']).toContain(mode);
    });

    it('should allow setting permission mode', () => {
      agent.setPermissionMode('plan');
      expect(agent.getPermissionMode()).toBe('plan');
    });

    it('should notify on permission mode change', () => {
      let notifiedMode = '';
      agent.onPermissionModeChange = (mode) => { notifiedMode = mode; };

      agent.setPermissionMode('bypassPermissions');
      expect(notifiedMode).toBe('bypassPermissions');
    });

    it('should cycle permission modes', () => {
      const initialMode = agent.getPermissionMode();
      const newMode = agent.cyclePermissionMode();
      expect(newMode).not.toBe(initialMode);
    });

    it('should report safe mode correctly', () => {
      agent.setPermissionMode('plan');
      expect(agent.isInSafeMode()).toBe(true);

      agent.setPermissionMode('default');
      expect(agent.isInSafeMode()).toBe(false);
    });
  });

  describe('Workspace & Session', () => {
    it('should return workspace from config', () => {
      const workspace = agent.getWorkspace();
      expect(workspace.id).toBe('test-workspace-id');
    });

    it('should allow setting workspace', () => {
      agent.setWorkspace({
        id: 'new-workspace',
        workspaceRootPath: '/new/path',
        sessionRootPath: '/new/sessions',
        config: { id: 'new-workspace', name: 'New Workspace', createdAt: 1, updatedAt: 1 },
        lastAccessedAt: 1,
      });
      expect(agent.getWorkspace().id).toBe('new-workspace');
    });

    it('should have session ID', () => {
      expect(agent.getSessionId()).toBeTruthy();
    });

    it('should allow setting session ID', () => {
      agent.setSessionId('new-session-id');
      expect(agent.getSessionId()).toBe('new-session-id');
    });
  });

  describe('Turn automation binding', () => {
    it('replaces and clears the automation system without retaining the prior snapshot', async () => {
      const calls: string[] = [];
      const system = (id: string): AgentAutomationSystem => ({
        async executeAgentEvent() {
          calls.push(id);
          return { matchedCount: 1, decision: { additionalContext: id } };
        },
      });

      agent.setAutomationSystem(system('snapshot-a'));
      expect((await agent.runSessionStartAutomationForTest())?.decision?.additionalContext).toBe('snapshot-a');

      agent.setAutomationSystem(system('snapshot-b'));
      expect((await agent.runSessionStartAutomationForTest())?.decision?.additionalContext).toBe('snapshot-b');

      agent.setAutomationSystem(undefined);
      expect(await agent.runSessionStartAutomationForTest()).toBeUndefined();
      expect(calls).toEqual(['snapshot-a', 'snapshot-b']);
    });

    it('drains fire-and-forget lifecycle hooks before turn authority is released', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let completed = false;
      agent.setAutomationSystem({
        async executeAgentEvent() {
          await gate;
          completed = true;
          return { matchedCount: 1 };
        },
      });

      void agent.runSessionStartAutomationForTest();
      let drained = false;
      const draining = agent.drainAutomationEvents().then(() => { drained = true; });
      await Bun.sleep(0);
      expect(drained).toBe(false);
      release();
      await draining;
      expect(completed).toBe(true);
      expect(drained).toBe(true);
    });

    it('serializes concurrent lifecycle events FIFO and continues after failure', async () => {
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      agent.setAutomationSystem({
        async executeAgentEvent(event) {
          order.push(`start:${event}`);
          if (event === 'SessionStart') await gate;
          if (event === 'Notification') throw new Error('hook failed');
          order.push(`end:${event}`);
          return { matchedCount: 1 };
        },
      });

      const first = agent.runAutomationForTest('SessionStart');
      const failed = agent.runAutomationForTest('Notification');
      const last = agent.runAutomationForTest('Stop');
      await Bun.sleep(0);
      expect(order).toEqual(['start:SessionStart']);

      release();
      await Promise.all([first, failed, last]);
      await agent.drainAutomationEvents();
      expect(order).toEqual([
        'start:SessionStart', 'end:SessionStart',
        'start:Notification',
        'start:Stop', 'end:Stop',
      ]);
    });
  });

  describe('Source Management', () => {
    it('should start with no active sources', () => {
      expect(agent.getActiveSourceSlugs()).toEqual([]);
    });

    it('projects standalone MCP identity into pre-tool checks', () => {
      const runtimeAgent = new TestAgent(createMockBackendConfig({
      }));
      runtimeAgent.setCapabilityTurnRuntime(capabilityRuntime({
        mcpServers: [{
          key: 'mcp:plugin:dpGitlab',
          wireName: 'dpGitlab',
          logicalName: 'dpGitlab',
          definition: { type: 'stdio', command: 'dp', args: ['ai', 'mcp', 'gitlab'] },
          pluginInstanceId: 'plugin://internal/default@1.0.9',
        }],
      }));

      expect(runtimeAgent.getMcpPreToolUseContextForTest()).toEqual({
        nonSourceMcpServerNames: ['dpGitlab'],
        interactionRequiredToolNames: [],
      });
    });

    it('falls back to an empty MCP inventory for partial capability runtimes', () => {
      const runtimeAgent = new TestAgent(createMockBackendConfig());
      for (const runtime of [{}, { view: {} }]) {
        runtimeAgent.setCapabilityTurnRuntime(runtime as CapabilityTurnRuntime);
        expect(runtimeAgent.getMcpPreToolUseContextForTest()).toEqual({
          nonSourceMcpServerNames: [],
          interactionRequiredToolNames: [],
        });
      }
    });

    it('projects the pool tools that declare requiresUserInteraction', () => {
      // The gate can only force a prompt for a flagged tool if this seam — the one
      // both backends spread into their check args — actually reports it.
      const runtimeAgent = new TestAgent(createMockBackendConfig({
        mcpPool: {
          interactionRequiredProxyToolNames: () => new Set(['mcp__srv__grant_access']),
          slugsForLeaser: () => new Set(['srv']),
        } as never,
      }));
      runtimeAgent.setCapabilityTurnRuntime(capabilityRuntime());

      expect(runtimeAgent.getMcpPreToolUseContextForTest().interactionRequiredToolNames)
        .toEqual(['mcp__srv__grant_access']);
    });

    it('should track source servers', async () => {
      await agent.setSourceServers(
        { 'source-1': { type: 'http', url: 'http://test' } },
        { 'source-2': {} },
        ['source-1', 'source-2']
      );

      expect(agent.getActiveSourceSlugs()).toContain('source-1');
      expect(agent.getActiveSourceSlugs()).toContain('source-2');
    });

    it('materializes a Source guide from its pinned runtime resource', async () => {
      const syncCalls: Array<Record<string, SdkMcpServerConfig>> = [];
      const runtimeAgent = new TestAgent(createMockBackendConfig({
        mcpPool: {
          async sync(mcpServers: Record<string, SdkMcpServerConfig>) {
            syncCalls.push(mcpServers);
          },
        } as unknown as McpClientPool,
      }));
      const configResource = {
        source: 'workspace' as const,
        scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
        resourceId: 'source:workspace:github',
        absolutePath: '/workspace/sources/github',
        revision: 'config-r1',
        contentHash: 'a'.repeat(64),
      };
      const guideResource = {
        ...configResource,
        resourceId: 'source:workspace:github:guide',
        absolutePath: '/workspace/sources/github/guide.md',
        revision: 'guide-r1',
        contentHash: 'b'.repeat(64),
      };
      const reads: string[] = [];
      const runtime = {
        view: {
          generation: 'generation-1',
          sources: [{
            key: 'source:workspace:github',
            logicalName: 'github',
            resource: configResource,
            guideResource,
            mcpWireName: 'github__qualified',
          }],
          skills: [],
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
          async resolvePath() { return configResource.absolutePath; },
          async readText(resource) {
            if (!('resourceId' in resource)) throw new Error('expected native resource');
            reads.push(resource.resourceId);
            return resource.resourceId === guideResource.resourceId
              ? '# GitHub\n\n## Scope\nIssues and pull requests.\n\n## Guidelines\nUse narrow queries.'
              : JSON.stringify({
                  id: 'github',
                  name: 'GitHub',
                  slug: 'github',
                  enabled: true,
                  provider: 'github',
                  type: 'mcp',
                  mcp: { url: 'https://example.invalid/mcp', authType: 'none' },
                });
          },
          resolveCredential() { return { ready: false, revision: 0 }; },
        },
      } satisfies CapabilityTurnRuntime;

      runtimeAgent.setCapabilityTurnRuntime(runtime);
      await runtimeAgent.setSourceServers({}, {}, []);

      expect(reads).toEqual([configResource.resourceId, guideResource.resourceId]);
      expect(runtimeAgent.getAllSources()[0]!.guide).toMatchObject({
        scope: 'Issues and pull requests.',
        raw: expect.stringContaining('Use narrow queries.'),
      });
      expect(syncCalls[0]?.github__qualified).toMatchObject({
        type: 'http',
        url: 'https://example.invalid/mcp',
      });
      expect(syncCalls[0]?.github).toBeUndefined();
    });

    it('threads config.mcpLeaserId into the pool sync options (shared pool), and omits it when unset', async () => {
      const optionCalls: Array<unknown> = [];
      const makePool = () => ({
        async sync(_mcp: Record<string, SdkMcpServerConfig>, _api: Record<string, unknown>, options?: unknown) {
          optionCalls.push(options);
          return [];
        },
      } as unknown as McpClientPool);

      // With a leaserId: sync receives { leaserId } so the session contributes
      // its desired set to the shared pool under its own leaser.
      const withLeaser = new TestAgent(createMockBackendConfig({
        mcpPool: makePool(),
        mcpLeaserId: 'session:abc',
      }));
      withLeaser.setCapabilityTurnRuntime(capabilityRuntime());
      await withLeaser.setSourceServers({}, {}, []);
      expect(optionCalls[0]).toEqual({ leaserId: 'session:abc' });

      // Without a leaserId (per-session private pool / embedded): no leaserId is
      // passed → the pool routes through its single implicit leaser (pre-sharing).
      optionCalls.length = 0;
      const noLeaser = new TestAgent(createMockBackendConfig({ mcpPool: makePool() }));
      noLeaser.setCapabilityTurnRuntime(capabilityRuntime());
      await noLeaser.setSourceServers({}, {}, []);
      expect(optionCalls[0]).toEqual({});
    });

    describe('dpSessionState threading', () => {
      const trackingPool = (synced: Array<Record<string, unknown>>) => ({
        async sync(mcpServers: Record<string, unknown>) { synced.push(mcpServers); return []; },
      } as unknown as McpClientPool);

      it('forwards dpSessionState so a ready DP server survives the materialization', async () => {
        const synced: Array<Record<string, unknown>> = [];
        const agent = makeAgentWithDpBoundServer(trackingPool(synced));

        await agent.setSourceServers({}, {}, [], { dpSessionState: 'ready' });

        // Without the option this call synced a DP-less set under the SAME leaser
        // id `preflightDpAuth` had just synced a DP-bearing set into, silently
        // evicting the servers the preflight authorized for the turn.
        expect(Object.keys(synced[0]!)).toContain('dp-bound');
      });

      it('still drops a DP server when the state is not ready', async () => {
        const synced: Array<Record<string, unknown>> = [];
        const agent = makeAgentWithDpBoundServer(trackingPool(synced));

        await agent.setSourceServers({}, {}, [], { dpSessionState: 'needs-login' });

        expect(Object.keys(synced[0]!)).not.toContain('dp-bound');
      });

      it('keeps the unavailable fallback when no dpSessionState is passed', async () => {
        const synced: Array<Record<string, unknown>> = [];
        const agent = makeAgentWithDpBoundServer(trackingPool(synced));

        // Proves the ready case above passes on the VALUE, not merely on an
        // options object being present, and that non-send callers are unchanged.
        await agent.setSourceServers({}, {}, [], { awaitConnect: false });

        expect(Object.keys(synced[0]!)).not.toContain('dp-bound');
      });
    });

    it('returns before the pool reconcile settles when awaitConnect is false, and still applies source state first', async () => {
      // The send path cannot wait on connect: ten servers measured 33.7s and one
      // hanging server never returned at all. `McpClientPool.sync` records the
      // leaser's desired set and hydrates cached descriptors BEFORE its first
      // await, so leaving the returned promise pending keeps health(),
      // dropLeaser() and the per-leaser union correct immediately.
      const order: string[] = [];
      let releaseSync: (() => void) | undefined;
      const mcpPool = {
        sync(mcpServers: Record<string, SdkMcpServerConfig>) {
          order.push(`sync:started:${Object.keys(mcpServers).join(',')}`);
          return new Promise<string[]>(resolve => {
            releaseSync = () => { order.push('sync:settled'); resolve([]); };
          });
        },
      } as unknown as McpClientPool;

      const deferredAgent = new TestAgent(createMockBackendConfig({ mcpPool }));
      deferredAgent.setCapabilityTurnRuntime(capabilityRuntime({
        sources: [{
          key: 'source:workspace:deferred-source',
          logicalName: 'deferred-source',
          resource: {
            source: 'workspace' as const,
            scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
            resourceId: 'source:workspace:deferred-source',
            absolutePath: '/workspace/sources/deferred-source',
            revision: 'deferred-r1',
            contentHash: 'f'.repeat(64),
          },
          mcpWireName: 'deferred-source',
        }],
      }, {
        async readText() {
          return JSON.stringify({
            id: 'deferred-source',
            name: 'Deferred Source',
            slug: 'deferred-source',
            enabled: true,
            provider: 'test',
            type: 'mcp',
            mcp: { url: 'http://deferred', authType: 'none' },
          });
        },
      }));

      await deferredAgent.setSourceServers({}, {}, ['deferred-source'], { awaitConnect: false });
      order.push('returned');

      // Ordering, not merely "it returned": the reconcile is provably still
      // pending when the caller regains control.
      expect(order).toEqual(['sync:started:deferred-source', 'returned']);
      // ...and the synchronous half — setAllSources + updateActiveState — ran
      // before returning, so the turn still sees its sources.
      expect(deferredAgent.getAllSources().map(source => source.config.slug)).toEqual(['deferred-source']);
      expect(deferredAgent.getActiveSourceSlugs()).toEqual(['deferred-source']);

      releaseSync!();
      await Bun.sleep(0);
      expect(order).toEqual(['sync:started:deferred-source', 'returned', 'sync:settled']);
    });

    it('still blocks on the reconcile when awaitConnect is not passed', async () => {
      const order: string[] = [];
      let releaseSync: (() => void) | undefined;
      const mcpPool = {
        sync() {
          order.push('sync:started');
          return new Promise<string[]>(resolve => {
            releaseSync = () => { order.push('sync:settled'); resolve([]); };
          });
        },
      } as unknown as McpClientPool;

      const awaitingAgent = new TestAgent(createMockBackendConfig({ mcpPool }));
      awaitingAgent.setCapabilityTurnRuntime(capabilityRuntime());

      const pending = awaitingAgent.setSourceServers({}, {}, [])
        .then(() => { order.push('returned'); });
      // A settle that merely lands a few microtasks late would look "awaited" to
      // a non-awaiting implementation, so give the default path a full timer
      // turn and assert it is STILL parked on the reconcile.
      await Bun.sleep(5);
      expect(order).toEqual(['sync:started']);

      releaseSync!();
      await pending;
      expect(order).toEqual(['sync:started', 'sync:settled', 'returned']);
    });

    it('handles a rejected background reconcile instead of leaking an unhandled rejection', async () => {
      const debugLog: string[] = [];
      const mcpPool = {
        sync: () => Promise.reject(new Error('reconcile-exploded')),
      } as unknown as McpClientPool;

      const backgroundAgent = new TestAgent(createMockBackendConfig({ mcpPool }));
      backgroundAgent.onDebug = message => debugLog.push(message);
      backgroundAgent.setCapabilityTurnRuntime(capabilityRuntime());

      // Resolves: a background connect failure must not fail the send path. The
      // failure is recorded on the pool and surfaced through health().
      await backgroundAgent.setSourceServers({}, {}, [], { awaitConnect: false });
      await Bun.sleep(0);

      expect(debugLog.filter(message => message.startsWith('Background MCP reconcile failed')))
        .toEqual(['Background MCP reconcile failed: reconcile-exploded']);
    });

    it('destroy() never tears down a LEASED shared pool, but still disconnects a private one', () => {
      // A leased shared pool is owned by the workspace registry: an agent
      // destroy (session dispose/delete/restart) must not disconnectAll it —
      // that would kill servers browse and OTHER sessions still lease. The
      // session's leaser is dropped by the lease release instead.
      let disconnects = 0;
      const makePool = () => ({
        async disconnectAll() { disconnects++; },
      } as unknown as McpClientPool);

      const leased = new TestAgent(createMockBackendConfig({
        mcpPool: makePool(),
        mcpLeaserId: 'session:abc',
      }));
      leased.destroy();
      expect(disconnects).toBe(0);

      // Private per-agent pool (no leaserId): destroy keeps today's teardown.
      const owned = new TestAgent(createMockBackendConfig({ mcpPool: makePool() }));
      owned.destroy();
      expect(disconnects).toBe(1);
    });

    it('merges project .mcp.json from the TRUSTED project workingDirectory (not managed storage)', async () => {
      // Managed workspace storage and the external project cwd are separate
      // locations. `.mcp.json` is repository-owned: it must come from the
      // project cwd, never from managed workspace storage.
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'managed-ws-'));
      const projectDir = mkdtempSync(join(tmpdir(), 'project-cwd-'));
      try {
        // A decoy .mcp.json in managed storage must be ignored entirely.
        writeFileSync(join(workspaceRoot, '.mcp.json'), JSON.stringify({
          mcpServers: { managed_decoy: { command: 'node', args: ['decoy.js'] } },
        }), 'utf-8');
        writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
          mcpServers: {
            project_search: {
              command: 'node',
              args: ['server.js'],
              env: { PROJECT_TOKEN: 'local' },
            },
          },
        }), 'utf-8');

        const syncCalls: Array<{ mcpServers: Record<string, SdkMcpServerConfig> }> = [];
        const mcpPool = {
          async sync(mcpServers: Record<string, SdkMcpServerConfig>) {
            syncCalls.push({ mcpServers });
            return [];
          },
        } as unknown as McpClientPool;

        const projectAgent = new TestAgent(createMockBackendConfig({
          workspace: createMockWorkspace({ workspaceRootPath: workspaceRoot }),
          session: createMockSession({ workingDirectory: projectDir }),
          mcpPool,
        }));
        const projectResource = {
          source: 'project' as const,
          scope: { kind: 'project' as const, workspaceId: 'test-workspace-id', projectKey: 'project:test' },
          resourceId: 'mcp:project:project_search',
          absolutePath: join(projectDir, '.mcp.json'),
          revision: 'project-r1',
          contentHash: 'c'.repeat(64),
        };
        projectAgent.setCapabilityTurnRuntime(capabilityRuntime({
          mcpServers: [{
            key: 'mcp:project:project_search',
            wireName: 'project_search',
            logicalName: 'project_search',
            resource: projectResource,
            sourceName: 'project_search',
            definition: { type: 'stdio', command: 'node' },
          }],
        }, {
          async readText(resource) {
            return 'resourceId' in resource && resource.resourceId === projectResource.resourceId
              ? JSON.stringify({ mcpServers: { project_search: { command: 'node', args: ['server.js'], env: { PROJECT_TOKEN: 'local' } } } })
              : '';
          },
        }));

        await projectAgent.setSourceServers(
          { 'registry-source': { type: 'http', url: 'http://registry.test/mcp' } },
          {},
          ['registry-source']
        );

        expect(projectAgent.getActiveSourceSlugs()).toContain('registry-source');
        // The managed-storage decoy is never loaded.
        expect(projectAgent.getActiveSourceSlugs()).not.toContain('managed_decoy');
        expect(syncCalls).toHaveLength(1);
        expect(syncCalls[0]?.mcpServers.project_search).toEqual({
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          // `whats-new/2026-w20.md:87` / `mcp.md:110`: stdio servers receive
          // the project directory IN THE SPAWN ENV, "matching hooks" — under
          // both spellings, with the entry's own env values still winning.
          env: {
            NESSY_PROJECT_DIR: projectDir,
            CLAUDE_PROJECT_DIR: projectDir,
            PROJECT_TOKEN: 'local',
          },
        });
        expect(syncCalls[0]?.mcpServers.managed_decoy).toBeUndefined();
        expect(syncCalls[0]?.mcpServers['registry-source']).toBeUndefined();
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it('does NOT load project .mcp.json when the project is untrusted', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'managed-ws-'));
      const projectDir = mkdtempSync(join(tmpdir(), 'project-cwd-'));
      try {
        writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
          mcpServers: { project_search: { command: 'node', args: ['server.js'] } },
        }), 'utf-8');

        const syncCalls: Array<{ mcpServers: Record<string, SdkMcpServerConfig> }> = [];
        const mcpPool = {
          async sync(mcpServers: Record<string, SdkMcpServerConfig>) {
            syncCalls.push({ mcpServers });
            return [];
          },
        } as unknown as McpClientPool;

        const projectAgent = new TestAgent(createMockBackendConfig({
          workspace: createMockWorkspace({ workspaceRootPath: workspaceRoot }),
          session: createMockSession({ workingDirectory: projectDir }),
          mcpPool,
        }));
        projectAgent.setCapabilityTurnRuntime(capabilityRuntime());

        await projectAgent.setSourceServers(
          { 'registry-source': { type: 'http', url: 'http://registry.test/mcp' } },
          {},
          ['registry-source']
        );

        expect(projectAgent.getActiveSourceSlugs()).not.toContain('project_search');
        expect(projectAgent.getActiveSourceSlugs()).toContain('registry-source');
        expect(syncCalls[0]?.mcpServers.project_search).toBeUndefined();
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it('should sync plugin MCP servers without treating them as native source slugs', async () => {
      const syncCalls: Array<{ mcpServers: Record<string, SdkMcpServerConfig> }> = [];
      const mcpPool = {
        async sync(mcpServers: Record<string, SdkMcpServerConfig>) {
          syncCalls.push({ mcpServers });
          return [];
        },
      } as unknown as McpClientPool;
      const pluginAgent = new TestAgent(createMockBackendConfig({
        mcpPool,
        pluginNodeRuntime: { command: process.execPath },
      }));
      const verifiedPlugins: string[] = [];
      pluginAgent.setCapabilityTurnRuntime(capabilityRuntime({
        mcpServers: [{
          key: 'mcp:plugin:linear',
          wireName: 'linear-qualified',
          logicalName: 'linear',
          definition: { type: 'stdio', command: 'node', args: ['mcp.js'] },
          pluginInstanceId: 'plugin://internal/toolkit@1.0.0',
          pluginRuntime: {
            rootPath: '/cache/linear', dataPath: '/data/linear', bundleHash: 'a'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
        }],
      }, {
        async verifyPlugin(pluginInstanceId) { verifiedPlugins.push(pluginInstanceId); },
      }));

      await pluginAgent.setSourceServers(
        { 'registry-source': { type: 'http', url: 'http://registry.test/mcp' } },
        {},
        ['registry-source']
      );

      expect(pluginAgent.getActiveSourceSlugs()).toEqual(['registry-source']);
      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0]?.mcpServers['linear-qualified']).toEqual({
        type: 'stdio',
        command: process.execPath,
        args: ['mcp.js'],
        cwd: '/cache/linear',
        env: {
          NESSY_PLUGIN_ROOT: '/cache/linear',
          PLUGIN_ROOT: '/cache/linear',
          NESSY_PLUGIN_DATA: '/data/linear',
          PLUGIN_DATA: '/data/linear',
        },
        inheritProcessEnv: false,
        pluginRuntime: {
          bundleRootPath: '/cache/linear',
          dataPath: '/data/linear',
          expectedBundleHash: 'a'.repeat(64),
        },
      });
      expect(syncCalls[0]?.mcpServers['registry-source']).toBeUndefined();
      expect(verifiedPlugins).toEqual(['plugin://internal/toolkit@1.0.0']);
    });

    it('selects plugin MCP stdio env by the normalized runtime compatibility profile only', async () => {
      const syncCalls: Array<{ mcpServers: Record<string, SdkMcpServerConfig> }> = [];
      const mcpPool = {
        async sync(mcpServers: Record<string, SdkMcpServerConfig>) {
          syncCalls.push({ mcpServers });
          return [];
        },
      } as unknown as McpClientPool;

      const genericAgent = new TestAgent(createMockBackendConfig({
        mcpPool,
        pluginNodeRuntime: { command: process.execPath },
      }));
      genericAgent.setCapabilityTurnRuntime(capabilityRuntime({
        mcpServers: [{
          key: 'mcp:plugin:generic',
          wireName: 'generic-qualified',
          logicalName: 'generic',
          definition: { type: 'stdio', command: 'node', args: ['mcp.js'] },
          pluginInstanceId: 'plugin://internal/generic@1.0.0',
          pluginRuntime: {
            rootPath: '/cache/generic', dataPath: '/data/generic', bundleHash: 'b'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
        }],
      }));
      await genericAgent.setSourceServers({}, {}, []);
      const genericConfig = syncCalls[0]?.mcpServers['generic-qualified'];
      expect(genericConfig?.type === 'stdio' ? genericConfig.env : undefined).toEqual({
        NESSY_PLUGIN_ROOT: '/cache/generic',
        PLUGIN_ROOT: '/cache/generic',
        NESSY_PLUGIN_DATA: '/data/generic',
        PLUGIN_DATA: '/data/generic',
      });

      const claudeAgent = new TestAgent(createMockBackendConfig({
        mcpPool,
        pluginNodeRuntime: { command: process.execPath },
      }));
      claudeAgent.setCapabilityTurnRuntime(capabilityRuntime({
        mcpServers: [{
          key: 'mcp:plugin:claude',
          wireName: 'claude-qualified',
          logicalName: 'claude',
          definition: { type: 'stdio', command: 'node', args: ['mcp.js'] },
          pluginInstanceId: 'plugin://internal/claude@1.0.0',
          pluginRuntime: {
            rootPath: '/cache/claude',
            dataPath: '/data/claude',
            bundleHash: 'c'.repeat(64),
            projectPath: '/workspace/project',
            profile: 'claude-plugin-env-v1',
          },
        }],
      }));
      await claudeAgent.setSourceServers({}, {}, []);
      const claudeConfig = syncCalls[1]?.mcpServers['claude-qualified'];
      expect(claudeConfig?.type === 'stdio' ? claudeConfig.env : undefined).toEqual({
        NESSY_PLUGIN_ROOT: '/cache/claude',
        PLUGIN_ROOT: '/cache/claude',
        NESSY_PLUGIN_DATA: '/data/claude',
        PLUGIN_DATA: '/data/claude',
        // `pluginRuntimeEnv` emits the Nessy spelling for every profile with a
        // validated project path — the name `claude.ts` rewrites
        // `${CLAUDE_PROJECT_DIR}` to, so the rewritten token resolves.
        NESSY_PROJECT_DIR: '/workspace/project',
        CLAUDE_PLUGIN_ROOT: '/cache/claude',
        CLAUDE_PLUGIN_DATA: '/data/claude',
        CLAUDE_CONFIG_DIR: '/data/claude',
        CLAUDE_PROJECT_DIR: '/workspace/project',
      });
    });

    it('should ignore malformed project .mcp.json files with a warning', () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'project-mcp-malformed-'));
      try {
        writeFileSync(join(workspaceRoot, '.mcp.json'), '{not json', 'utf-8');

        const warnings: string[] = [];
        expect(loadProjectMcpServers(workspaceRoot, message => warnings.push(message))).toEqual({});
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toContain('.mcp.json');
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('should check if source is active', async () => {
      const resource = {
        source: 'workspace' as const,
        scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
        resourceId: 'source:workspace:active-source',
        absolutePath: '/workspace/sources/active-source',
        revision: 'active-r1',
        contentHash: 'e'.repeat(64),
      };
      agent.setCapabilityTurnRuntime(capabilityRuntime({
        sources: [{
          key: 'source:workspace:active-source',
          logicalName: 'active-source',
          resource,
          mcpWireName: 'active-source',
        }],
      }, {
        async readText() {
          return JSON.stringify({
            id: 'active-source',
            name: 'Active Source',
            slug: 'active-source',
            enabled: true,
            provider: 'test',
            type: 'mcp',
            mcp: { url: 'http://test', authType: 'none' },
          });
        },
      }));
      await agent.setSourceServers(
        { 'active-source': { type: 'http', url: 'http://test' } },
        {},
        ['active-source']
      );

      expect(agent.isSourceServerActive('active-source')).toBe(true);
      expect(agent.isSourceServerActive('inactive-source')).toBe(false);
    });

    it('should track all sources', () => {
      const sources = [
        createMockSource({ slug: 'source-1' }),
        createMockSource({ slug: 'source-2' }),
      ];

      agent.setAllSources(sources);
      expect(agent.getAllSources()).toHaveLength(2);
    });

    it('should allow marking source as unseen', () => {
      // This should not throw
      agent.markSourceUnseen('some-source');
    });

    it('should track temporary clarifications', () => {
      agent.setTemporaryClarifications('Test clarification');
      // Clarifications are internal state - verify via PromptBuilder if needed
    });
  });

  describe('Manager Accessors', () => {
    it('should provide access to SourceManager', () => {
      const manager = agent.getSourceManager();
      expect(manager).toBeTruthy();
    });

    it('should provide access to PermissionManager', () => {
      const manager = agent.getPermissionManager();
      expect(manager).toBeTruthy();
    });

    it('should provide access to PromptBuilder', () => {
      const builder = agent.getPromptBuilder();
      expect(builder).toBeTruthy();
    });
  });

  describe('Lifecycle', () => {
    it('should track processing state', () => {
      expect(agent.isProcessing()).toBe(false);
    });

    it('should emit complete event from chat', async () => {
      const events = await collectEvents(agent.chat('test message'));
      expect(events.some(e => e.type === 'complete')).toBe(true);
    });

    it('should track chat calls', async () => {
      await collectEvents(agent.chat('test message'));
      expect(agent.chatCalls).toHaveLength(1);
      expect(agent.chatCalls[0]?.message).toContain('test message');
    });

    it('injects a selected materialized skill once, dedupes mentions, and does not volunteer its path', async () => {
      const skill = {
        key: 'skill://workspace/review', logicalName: 'review', description: 'Review code',
        selectedAsUnqualifiedAlias: true,
        resource: { source: 'workspace' as const, scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' }, resourceId: 'review', absolutePath: '/secret/SKILL.md', revision: 'r1', contentHash: 'a'.repeat(64) },
      };
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [skill] }, {
        async readText() { return '---\ntools: Read, Grep\nmodel: inherit\n---\nReview only the requested diff.'; },
        async resolveSkillDirectory() { return '/secret'; },
      }));

      await collectEvents(agent.chat('[skill:review] [skill:review] inspect this'));
      const message = agent.chatCalls[0]!.message;
      expect(message.match(/<invoked-skill /g)).toHaveLength(1);
      expect(message).toContain('Review only the requested diff.');
      // A skill that does not ask for its directory never receives it, and its
      // SKILL.md is never named. The narrower property replaces a blanket
      // "no absolute path anywhere": `skills.md:303` has the author opt IN to
      // the directory with `${CLAUDE_SKILL_DIR}` (see the next test), so the
      // invariant that actually matters is that we never volunteer the path —
      // and never hand one out when SERVING supporting-resource content, which
      // `skill-resource-read-tool.test.ts` asserts on the read path.
      expect(message).not.toContain('/secret/SKILL.md');
      expect(message).not.toContain('/secret');
    });

    it('expands the skill directory for a skill that asks for it, in the body and in allowed-tools', async () => {
      const skill = {
        key: 'skill://workspace/render', logicalName: 'render', description: 'Render a chart',
        selectedAsUnqualifiedAlias: true,
        resource: { source: 'workspace' as const, scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' }, resourceId: 'render', absolutePath: '/skills/render-chart/SKILL.md', revision: 'r1', contentHash: 'b'.repeat(64) },
      };
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [skill] }, {
        async readText() {
          return '---\nallowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)\n---\n'
            + 'Run `${CLAUDE_SKILL_DIR}/scripts/render.sh <csv-file>` to render the chart.';
        },
        async resolveSkillDirectory() { return '/skills/render-chart'; },
      }));

      const { invocations } = await agent.extractSkillInvocationsForTest('[skill:render] chart it');

      // The documented pair: the rule matches the exact command the body names.
      expect(invocations[0]!.body).toContain('/skills/render-chart/scripts/render.sh <csv-file>');
      expect(invocations[0]!.restrictions.tools).toEqual(['Bash(/skills/render-chart/scripts/render.sh *)']);
    });

    it('resolves exact colliding skill keys without weakening the short-alias winner', async () => {
      const project = {
        key: 'skill:project:honey', logicalName: 'honey', description: 'Project Honey',
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'project' as const,
          scope: { kind: 'project' as const, workspaceId: 'test-workspace-id', projectKey: 'project-1' },
          resourceId: 'project-honey',
          absolutePath: '/project/.agents/skills/honey/SKILL.md',
          revision: 'r1',
          contentHash: 'a'.repeat(64),
        },
      };
      const plugin = {
        key: 'plugin:greenpt/honey:skill.honey', logicalName: 'honey', description: 'Plugin Honey',
        selectedAsUnqualifiedAlias: false,
        resource: {
          pluginInstanceId: 'plugin://greenpt/honey@1.1.0',
          relativePath: 'skills/honey/SKILL.md',
          contentHash: 'b'.repeat(64),
        },
      };
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [project, plugin] }, {
        async readText(resource) {
          return 'pluginInstanceId' in resource ? 'PLUGIN_HONEY_BODY' : 'PROJECT_HONEY_BODY';
        },
      }));

      await collectEvents(agent.chat('[skill:honey] winner'));
      await collectEvents(agent.chat('[skill:plugin:greenpt/honey:skill.honey] loser'));
      await collectEvents(agent.chat('[skill:skill:project:honey] exact winner'));

      expect(agent.chatCalls[0]!.message).toContain('PROJECT_HONEY_BODY');
      expect(agent.chatCalls[0]!.message).not.toContain('PLUGIN_HONEY_BODY');
      expect(agent.chatCalls[1]!.message).toContain('PLUGIN_HONEY_BODY');
      expect(agent.chatCalls[1]!.message).not.toContain('PROJECT_HONEY_BODY');
      expect(agent.chatCalls[2]!.message).toContain('PROJECT_HONEY_BODY');
      expect(agent.chatCalls[2]!.message).not.toContain('PLUGIN_HONEY_BODY');
    });

    it('binds arguments to the exact mention when skill slugs collide', async () => {
      const aliasWinner = {
        key: 'skill:project:honey', logicalName: 'honey', description: 'Alias winner',
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'project' as const,
          scope: { kind: 'project' as const, workspaceId: 'test-workspace-id', projectKey: 'project-1' },
          resourceId: 'project-honey',
          absolutePath: '/project/.agents/skills/honey/SKILL.md',
          revision: 'r1',
          contentHash: 'a'.repeat(64),
        },
      };
      const qualified = {
        key: 'skill:portable:honey', logicalName: 'honey', description: 'Qualified collision',
        selectedAsUnqualifiedAlias: false,
        resource: {
          source: 'managed-global' as const,
          scope: { kind: 'global' as const },
          resourceId: 'portable-honey',
          absolutePath: '/managed/portable/honey/SKILL.md',
          revision: 'r1',
          contentHash: 'b'.repeat(64),
        },
      };
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [aliasWinner, qualified] }, {
        async readText(resource) {
          return 'resourceId' in resource && resource.resourceId === 'project-honey'
            ? 'PROJECT $ARGUMENTS'
            : 'PORTABLE $ARGUMENTS';
        },
      }));

      await collectEvents(agent.chat(
        '[skill:honey] FIRST [skill:honey] LATEST [skill:skill:portable:honey] QUALIFIED',
      ));

      const message = agent.chatCalls[0]!.message;
      expect(message).toContain('PROJECT LATEST');
      expect(message).not.toContain('PROJECT QUALIFIED');
      expect(message).toContain('PORTABLE QUALIFIED');
      expect(message).not.toContain('PORTABLE LATEST');
      expect(message.match(/<invoked-skill /g)).toHaveLength(2);
    });

    it('rehydrates a selected skill once after compaction and fails closed after generation change', async () => {
      const body = 'x'.repeat(32 * 1024);
      const skill = {
        key: 'skill://workspace/large', logicalName: 'large', description: 'Large skill',
        selectedAsUnqualifiedAlias: true,
        resource: { source: 'workspace' as const, scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' }, resourceId: 'large', absolutePath: '/private/large/SKILL.md', revision: 'r1', contentHash: 'b'.repeat(64) },
      };
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [skill] }, { async readText() { return body; } }));
      await collectEvents(agent.chat('[skill:large] start'));

      agent.resetPrerequisiteState();
      await collectEvents(agent.chat('continue after compact'));
      expect(agent.chatCalls[1]!.message).toContain(body.slice(0, 20_000));
      expect(agent.chatCalls[1]!.message).not.toContain(body);
      await collectEvents(agent.chat('continue again'));
      expect(agent.chatCalls[2]!.message).not.toContain('<invoked-skill ');

      agent.resetPrerequisiteState();
      agent.setCapabilityTurnRuntime(capabilityRuntime({ generation: 'next-generation', skills: [skill] }, { async readText() { return body; } }));
      await expect(collectEvents(agent.chat('continue stale'))).rejects.toThrow('Skill invocation stale: large');
    });

    it.each([
      ['ASCII', 0x41],
      ['CJK', 0x4e00],
      ['JSON-escaped control', 0x01],
    ])('persists all five maximum %s reattach-budget skills across a cold continuation restart', async (_, firstCodePoint) => {
      const bodies = Array.from({ length: 5 }, (_, index) => String.fromCharCode(firstCodePoint + index).repeat(20_000));
      const skills = bodies.map((_, index) => {
        const name = `maximum-${index + 1}`;
        return {
          key: `skill://workspace/${name}`, logicalName: name, description: `${name} skill`,
          selectedAsUnqualifiedAlias: true,
          resource: {
            source: 'workspace' as const,
            scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
            resourceId: name,
            absolutePath: `/private/${name}/SKILL.md`,
            revision: 'r1',
            contentHash: String(index + 1).repeat(64),
          },
        };
      });
      const runtime = capabilityRuntime({ skills }, {
        async readText(resource) {
          const index = skills.findIndex(skill => skill.resource.resourceId === ('resourceId' in resource ? resource.resourceId : ''));
          return bodies[index]!;
        },
      });
      const first = new TestAgent(createMockBackendConfig());
      first.setCapabilityTurnRuntime(runtime);
      for (const skill of skills) {
        await collectEvents(first.chat(`[skill:${skill.logicalName}] select`));
      }

      first.resetPrerequisiteState();
      await collectEvents(first.chat('continue after compact'));
      expect(first.chatCalls.at(-1)!.message.match(/<invoked-skill /g)).toHaveLength(5);

      const references = first.getActiveSkillContinuationReferencesForTest();
      expect(references.map(reference => reference.snapshot.body.length)).toEqual(Array(5).fill(20_000));
      const envelope = createContinuationEnvelopeV1({
        capabilityGeneration: runtime.view.generation,
        invokedSkills: references,
      });
      const revalidated = revalidateContinuationEnvelopeV1({
        envelope,
        capabilityGeneration: runtime.view.generation,
        availableToolDigests: new Map(),
        availableSkillDigests: new Map(skills.map(skill => [skill.key, skill.resource.contentHash])),
      });
      expect(revalidated.revoked).toEqual([]);

      const restored = new TestAgent(createMockBackendConfig({ getPiContinuationEnvelope: () => revalidated.envelope }));
      restored.setCapabilityTurnRuntime(runtime);
      await collectEvents(restored.chat('continue after cold restart'));
      const restoredMessage = restored.chatCalls[0]!.message;
      expect(restoredMessage.match(/<invoked-skill /g)).toHaveLength(5);
      for (const body of bodies) expect(restoredMessage).toContain(body);
    });

    it('reattaches only budgeted bodies when selected skills have supporting resources', async () => {
      const resources = Array.from({ length: 5 }, (_, index) => (
        `RESOURCE_${index + 1}_` + 'r'.repeat(32 * 1024 - `RESOURCE_${index + 1}_`.length)
      ));
      const bodyPrefixes = Array.from({ length: 5 }, (_, index) => (
        `BODY_${index + 1}_` + 'b'.repeat(19_880)
      ));
      const bodies = bodyPrefixes.map(body => (
        `${body}\nRead [the guide](references/guide.md)`
      ));
      const skills = bodies.map((_, index) => {
        const name = `resource-budget-${index + 1}`;
        return {
          key: `skill://workspace/${name}`, logicalName: name, description: `${name} skill`,
          selectedAsUnqualifiedAlias: true,
          resource: {
            source: 'workspace' as const,
            scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
            resourceId: name,
            absolutePath: `/private/${name}/SKILL.md`,
            revision: 'r1',
            contentHash: String(index + 1).repeat(64),
          },
        };
      });
      const runtime = capabilityRuntime({ skills }, {
        async readText(resource) {
          const index = skills.findIndex(skill => skill.resource.resourceId === ('resourceId' in resource ? resource.resourceId : ''));
          return bodies[index]!;
        },
        async readRelativeText(resource, relativePath) {
          expect(relativePath).toBe('references/guide.md');
          const index = skills.findIndex(skill => skill.resource.resourceId === ('resourceId' in resource ? resource.resourceId : ''));
          const content = resources[index]!;
          return { content, contentHash: createHash('sha256').update(content).digest('hex') };
        },
      });
      const first = new TestAgent(createMockBackendConfig());
      first.setCapabilityTurnRuntime(runtime);
      for (const skill of skills) {
        await collectEvents(first.chat(`[skill:${skill.logicalName}] select`));
      }

      first.resetPrerequisiteState();
      await collectEvents(first.chat('continue after compact'));
      const reinjectedMessage = first.chatCalls.at(-1)!.message;
      expect(reinjectedMessage.match(/<invoked-skill /g)).toHaveLength(5);

      const references = first.getActiveSkillContinuationReferencesForTest();
      expect(references).toHaveLength(5);
      expect(references.every(reference => reference.snapshot.supportingResources.length === 0)).toBe(true);
      expect(references.reduce((total, reference) => total + estimateTokens(reference.snapshot.body), 0)).toBeLessThanOrEqual(25_000);
      for (const bodyPrefix of bodyPrefixes) {
        const reference = references.find(candidate => candidate.snapshot.body.startsWith(bodyPrefix));
        expect(reference).toBeDefined();
        expect(reference!.snapshot.body).toContain(bodyPrefix);
      }
      for (const reference of references) {
        expect(reference.snapshot.body).toContain('skill-resource:');
        expect(reinjectedMessage).toContain(reference.snapshot.body);
      }
      for (const resource of resources) expect(reinjectedMessage).not.toContain(resource);
      expect(reinjectedMessage).not.toContain('<skill-resource ');
      const envelope = createContinuationEnvelopeV1({
        capabilityGeneration: runtime.view.generation,
        invokedSkills: references,
      });
      const revalidated = revalidateContinuationEnvelopeV1({
        envelope,
        capabilityGeneration: runtime.view.generation,
        availableToolDigests: new Map(),
        availableSkillDigests: new Map(skills.map(skill => [skill.key, skill.resource.contentHash])),
      });
      expect(revalidated.revoked).toEqual([]);

      const restored = new TestAgent(createMockBackendConfig({ getPiContinuationEnvelope: () => revalidated.envelope }));
      restored.setCapabilityTurnRuntime(runtime);
      await collectEvents(restored.chat('continue after cold restart'));
      const restoredMessage = restored.chatCalls[0]!.message;
      expect(restoredMessage.match(/<invoked-skill /g)).toHaveLength(5);
      for (const reference of references) expect(restoredMessage).toContain(reference.snapshot.body);
      for (const resource of resources) expect(restoredMessage).not.toContain(resource);
      expect(restoredMessage).not.toContain('<skill-resource ');
    });

    it('reattaches skills from separate turns after compaction in newest-first order', async () => {
      const skills = ['alpha', 'beta'].map((name, index) => ({
        key: `skill://workspace/${name}`, logicalName: name, description: `${name} skill`,
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
          resourceId: name,
          absolutePath: `/private/${name}/SKILL.md`,
          revision: 'r1',
          contentHash: String(index + 1).repeat(64),
        },
      }));
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills }, {
        async readText(resource) {
          return `BODY_${'resourceId' in resource ? resource.resourceId.toUpperCase() : 'UNKNOWN'}`;
        },
      }));

      await collectEvents(agent.chat('[skill:alpha] first turn'));
      await collectEvents(agent.chat('[skill:beta] second turn'));
      agent.resetPrerequisiteState();
      await collectEvents(agent.chat('continue after compact'));

      const message = agent.chatCalls[2]!.message;
      expect(message).toContain('BODY_ALPHA');
      expect(message).toContain('BODY_BETA');
      expect(message.indexOf('BODY_BETA')).toBeLessThan(message.indexOf('BODY_ALPHA'));
    });

    /**
     * `skills.md:262` — `effort` "Overrides the session effort level. Default:
     * inherits from session. Options: low, medium, high, xhigh, max; available
     * levels depend on the model."
     */
    describe('effort', () => {
      const effortSkill = (name: string) => ({
        key: `skill://workspace/${name}`, logicalName: name, description: `${name} skill`,
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
          resourceId: name,
          absolutePath: `/private/${name}/SKILL.md`,
          revision: 'r1',
          contentHash: 'a'.repeat(64),
        },
      });

      it('overrides the session level for the turn and restores it after', async () => {
        agent.setThinkingLevel('low');
        agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [effortSkill('deep')] }, {
          async readText() { return '---\neffort: xhigh\n---\nAt ${CLAUDE_EFFORT}.'; },
        }));

        await collectEvents(agent.chat('[skill:deep] go'));

        // The body sees the level it will actually run under, not the one it
        // just overrode (`:299` + `:262`).
        expect(agent.chatCalls[0]!.message).toContain('At xhigh.');
        // Not persisted: the session's own level is back once the turn ends.
        expect(agent.getThinkingLevel()).toBe('low');
      });

      it('degrades an unsupported level instead of failing the invocation', async () => {
        agent.setThinkingLevel('medium');
        agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [effortSkill('typo')] }, {
          async readText() { return '---\neffort: xhi\n---\nBody at ${CLAUDE_EFFORT}.'; },
        }));

        // No throw, no error event: the skill runs at the session's effort.
        await collectEvents(agent.chat('[skill:typo] go'));

        expect(agent.chatCalls[0]!.message).toContain('Body at medium.');
        expect(agent.getThinkingLevel()).toBe('medium');
      });
    });

    /**
     * `mcp.md` § Use MCP resources — "Resources are automatically fetched and
     * included as attachments when referenced", via
     * `@server:protocol://resource/path`.
     *
     * R5: the OFFER half was unreachable on Pi. The attach half runs off
     * `config.mcpPool`, which every backend has, so this pins that it stays
     * backend-independent and fails soft.
     */
    describe('MCP resource mentions', () => {
      const resourcePool = (read: (server: string, uri: string) => Promise<unknown>) => ({
        async sync() { return []; },
        readResource: read,
      } as unknown as McpClientPool);

      it('fetches and inlines a referenced resource before the turn is built', async () => {
        const reads: Array<{ server: string; uri: string }> = [];
        const resourceAgent = new TestAgent(createMockBackendConfig({
          mcpPool: resourcePool(async (server, uri) => {
            reads.push({ server, uri });
            return { contents: [{ uri, mimeType: 'text/plain', text: 'issue body' }] };
          }),
        }));
        resourceAgent.setCapabilityTurnRuntime(capabilityRuntime());

        await collectEvents(resourceAgent.chat('look at @github:issue://123 please'));

        expect(reads).toEqual([{ server: 'github', uri: 'issue://123' }]);
        const message = resourceAgent.chatCalls[0]!.message;
        expect(message).toContain('<mcp-resource server="github" uri="issue://123">\nissue body\n</mcp-resource>');
        expect(message).toContain('issue body');
      });

      it('leaves a note instead of failing the turn when the read fails', async () => {
        const failingAgent = new TestAgent(createMockBackendConfig({
          mcpPool: resourcePool(async () => { throw new Error('no such resource'); }),
        }));
        failingAgent.setCapabilityTurnRuntime(capabilityRuntime());

        await collectEvents(failingAgent.chat('read @docs:file://missing now'));

        expect(failingAgent.chatCalls[0]!.message)
          .toContain('<mcp-resource server="docs" uri="file://missing">(could not be read: no such resource)</mcp-resource>');
      });
    });

    /**
     * `skills.md:307` — `${CLAUDE_PROJECT_DIR}` is "The project root directory …
     * independent of where the skill is installed"; `:309` substitutes it in the
     * skill's markdown content AND in the `allowed-tools` Bash rules.
     */
    describe('project directory', () => {
      const projectSkill = () => ({
        key: 'skill://workspace/helper', logicalName: 'helper', description: 'helper skill',
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
          resourceId: 'helper',
          absolutePath: '/private/helper/SKILL.md',
          revision: 'r1',
          contentHash: 'a'.repeat(64),
        },
      });

      const skillMarkdown = '---\nallowed-tools: Bash(${CLAUDE_PROJECT_DIR}/.claude/hooks/helper.sh)\n---\n'
        + 'Run ${CLAUDE_PROJECT_DIR}/.claude/hooks/helper.sh.';

      it('supplies the session project root to both documented sites', async () => {
        const projectAgent = new TestAgent(createMockBackendConfig({
          session: createMockSession({ workingDirectory: '/repo/root' }),
        }));
        projectAgent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [projectSkill()] }, {
          async readText() { return skillMarkdown; },
        }));

        await collectEvents(projectAgent.chat('[skill:helper] go'));

        // The rule and the command the body names are the SAME string, which is
        // the only reason the documented pair runs without a prompt (`:321`).
        const message = projectAgent.chatCalls[0]!.message;
        expect(message).toContain('Run /repo/root/.claude/hooks/helper.sh.');
        expect(message).not.toContain('${CLAUDE_PROJECT_DIR}');
      });

      it('prefers the canonical project root over the session cwd', async () => {
        // "The same path hooks and MCP servers receive" (`:307`): the plugin
        // runtime binds `context.projectRoot ?? context.workingDirectory`, so a
        // session sitting in a subdirectory of its project still reports the
        // project root, not the cwd.
        const scopedAgent = new TestAgent(createMockBackendConfig({
          session: createMockSession({ workingDirectory: '/repo/root/packages/app' }),
          filesystemScope: {
            session: { workspaceId: 'test-workspace-id', sessionId: 'test-session-id' },
            projectKey: 'project-1',
            primaryRoot: '/repo/root',
            cwd: '/repo/root/packages/app',
            additionalRoots: [],
            managedExclusions: [],
            generation: 'scope-1',
          },
        }));
        scopedAgent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [projectSkill()] }, {
          async readText() { return skillMarkdown; },
        }));

        await collectEvents(scopedAgent.chat('[skill:helper] go'));

        expect(scopedAgent.chatCalls[0]!.message).toContain('Run /repo/root/.claude/hooks/helper.sh.');
      });
    });

    it('uses the last body when the same skill is mentioned repeatedly', async () => {
      const skill = {
        key: 'skill://workspace/review', logicalName: 'review', description: 'Review skill',
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
          resourceId: 'review',
          absolutePath: '/private/review/SKILL.md',
          revision: 'r1',
          contentHash: 'd'.repeat(64),
        },
      };
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [skill] }, {
        async readText() { return 'Use $ARGUMENTS'; },
      }));

      await collectEvents(agent.chat(
        '[skill:review] first [skill:review] last',
      ));

      const message = agent.chatCalls[0]!.message;
      expect(message).toContain('Use last');
      expect(message).not.toContain('Use first');
      expect(message.match(/<invoked-skill /g)).toHaveLength(1);
    });

    it('restores the exact argument-expanded skill snapshot after a cold restart', async () => {
      const skill = {
        key: 'skill://workspace/argumented', logicalName: 'argumented', description: 'Argumented skill',
        selectedAsUnqualifiedAlias: true,
        resource: { source: 'workspace' as const, scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' }, resourceId: 'argumented', absolutePath: '/private/argumented/SKILL.md', revision: 'r1', contentHash: 'e'.repeat(64) },
      };
      const runtime = capabilityRuntime({ skills: [skill] }, {
        async readText() { return '---\ntools: Read\n---\nUse $ARGUMENTS'; },
      });
      const first = new TestAgent(createMockBackendConfig());
      first.setCapabilityTurnRuntime(runtime);
      await collectEvents(first.chat('[skill:argumented] strict'));
      const [reference] = first.getActiveSkillContinuationReferencesForTest();
      const envelope = createContinuationEnvelopeV1({
        capabilityGeneration: runtime.view.generation,
        invokedSkills: [reference!],
      });

      const restored = new TestAgent(createMockBackendConfig({ getPiContinuationEnvelope: () => envelope }));
      restored.setCapabilityTurnRuntime(runtime);
      await collectEvents(restored.chat('continue'));
      const message = restored.chatCalls[0]!.message;
      expect(message).toContain('Use strict');
      expect(message).not.toContain('Use $ARGUMENTS');
      expect(message.match(/<invoked-skill /g)).toHaveLength(1);
      expect(envelope.invokedSkills[0]!.snapshot.restrictions.tools).toEqual(['Read']);
    });

    it('restores and migrates a legacy v1 skill snapshot without invokedAt', async () => {
      const skill = {
        key: 'skill://workspace/legacy', logicalName: 'legacy', description: 'Legacy skill',
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
          resourceId: 'legacy',
          absolutePath: '/private/legacy/SKILL.md',
          revision: 'r1',
          contentHash: 'e'.repeat(64),
        },
      };
      const runtime = capabilityRuntime({ skills: [skill] }, {
        async readText() { return 'Current body should not replace the snapshot'; },
      });
      const legacyUnsigned = {
        key: skill.key,
        name: skill.logicalName,
        sourceDigest: skill.resource.contentHash,
        generation: runtime.view.generation,
        body: 'Legacy persisted body',
        supportingResources: [],
        restrictions: {},
        states: { available: true as const, selected: true as const, resourceLoaded: false, grantApplied: true as const },
      };
      const legacyDigest = createHash('sha256')
        .update(JSON.stringify(legacyUnsigned))
        .digest('hex');
      const envelope = createContinuationEnvelopeV1({
        capabilityGeneration: runtime.view.generation,
        invokedSkills: [{
          id: skill.key,
          digest: skill.resource.contentHash,
          snapshot: { ...legacyUnsigned, invocationDigest: legacyDigest } as any,
        }],
      });
      expect(() => createContinuationEnvelopeV1({
        capabilityGeneration: runtime.view.generation,
        invokedSkills: [{
          id: skill.key,
          digest: skill.resource.contentHash,
          snapshot: { ...legacyUnsigned, body: 'Tampered body', invocationDigest: legacyDigest } as any,
        }],
      })).toThrow('Skill invocation digest mismatch');

      const migrated = envelope.invokedSkills[0]!.snapshot;
      expect(migrated.invokedAt).toBe(0);
      expect(migrated.invocationDigest).not.toBe(legacyDigest);
      expect(validateSkillInvocationSnapshot(migrated)).toEqual(migrated);

      const restored = new TestAgent(createMockBackendConfig({ getPiContinuationEnvelope: () => envelope }));
      restored.setCapabilityTurnRuntime(runtime);
      await collectEvents(restored.chat('continue'));
      expect(restored.chatCalls[0]!.message).toContain('Legacy persisted body');
    });

    it('renormalizes restored maximum chronology before a new invocation', async () => {
      const skills = ['restored', 'fresh'].map((name, index) => ({
        key: `skill://workspace/${name}`, logicalName: name, description: `${name} skill`,
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
          resourceId: name,
          absolutePath: `/private/${name}/SKILL.md`,
          revision: 'r1',
          contentHash: String(index + 7).repeat(64),
        },
      }));
      const runtime = capabilityRuntime({ skills }, {
        async readText() { return 'Use $ARGUMENTS'; },
      });
      const first = new TestAgent(createMockBackendConfig());
      first.setCapabilityTurnRuntime(runtime);
      await collectEvents(first.chat('[skill:restored] persisted'));
      const [reference] = first.getActiveSkillContinuationReferencesForTest();
      const { invocationDigest: _, ...unsigned } = reference!.snapshot;
      const maximumUnsigned = { ...unsigned, invokedAt: Number.MAX_SAFE_INTEGER };
      const maximumSnapshot = {
        ...maximumUnsigned,
        invocationDigest: computeSkillInvocationDigest(maximumUnsigned),
      };
      const envelope = createContinuationEnvelopeV1({
        capabilityGeneration: runtime.view.generation,
        invokedSkills: [{ ...reference!, snapshot: maximumSnapshot }],
      });

      const restored = new TestAgent(createMockBackendConfig({ getPiContinuationEnvelope: () => envelope }));
      restored.setCapabilityTurnRuntime(runtime);
      await collectEvents(restored.chat('continue'));
      await collectEvents(restored.chat('[skill:fresh] newest'));

      const references = restored.getActiveSkillContinuationReferencesForTest();
      expect(references.map(value => value.id)).toEqual([
        'skill://workspace/fresh',
        'skill://workspace/restored',
      ]);
      expect(references.map(value => value.snapshot.invokedAt)).toEqual([2, 1]);
      expect(references.every(value => Number.isSafeInteger(value.snapshot.invokedAt))).toBe(true);
      expect(() => createContinuationEnvelopeV1({
        capabilityGeneration: runtime.view.generation,
        invokedSkills: references,
      })).not.toThrow();
      expect(() => JSON.stringify(references)).not.toThrow();
    });

    it('persists deterministic invocation chronology for selected skills', async () => {
      const skills = ['review', 'test'].map((name, index) => ({
        key: `skill://workspace/${name}`, logicalName: name, description: `${name} skill`,
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
          resourceId: name,
          absolutePath: `/private/${name}/SKILL.md`,
          revision: 'r1',
          contentHash: String(index + 1).repeat(64),
        },
      }));
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills }, {
        async readText() { return 'Use $ARGUMENTS'; },
      }));

      await collectEvents(agent.chat('[skill:review] first [skill:test] second'));

      const references = agent.getActiveSkillContinuationReferencesForTest();
      expect(references.map(reference => reference.id)).toEqual([
        'skill://workspace/test',
        'skill://workspace/review',
      ]);
      expect(references.map(reference => reference.snapshot.invokedAt)).toEqual([2, 1]);
      expect(references[0]!.snapshot.body).toBe('Use second');
    });

    it('revalidates an invoked skill on the next ordinary turn without reapplying its hidden grant', async () => {
      const skill = {
        key: 'skill://workspace/pinned', logicalName: 'pinned', description: 'Pinned skill',
        selectedAsUnqualifiedAlias: true,
        resource: { source: 'workspace' as const, scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' }, resourceId: 'pinned', absolutePath: '/private/pinned/SKILL.md', revision: 'r1', contentHash: 'c'.repeat(64) },
      };
      agent.setCapabilityTurnRuntime(capabilityRuntime({
        skills: [skill],
        agents: [{ key: 'agent://reviewer', name: 'reviewer', selectedAsUnqualifiedAlias: true } as any],
      }, {
        async readText() { return '---\ntools: Read\nagent: reviewer\n---\nPinned body'; },
      }));
      await collectEvents(agent.chat('[skill:pinned] inspect'));
      await collectEvents(agent.chat('ordinary follow-up'));
      expect(agent.chatCalls[1]!.message).not.toContain('<invoked-skill ');

      agent.setCapabilityTurnRuntime(capabilityRuntime({ generation: 'changed', skills: [skill] }));
      await expect(collectEvents(agent.chat('next turn'))).rejects.toThrow('Skill invocation stale: pinned');
    });

    // ---- Model-side invocation (P7 Task 4) ---------------------------------
    // A listing that the model cannot act on is decoration. These pin the model
    // path AND the refusal that makes `disable-model-invocation` a control
    // rather than a hint.

    function invocableSkill(logicalName: string, over: Record<string, unknown> = {}) {
      return {
        key: `skill://workspace/${logicalName}`,
        logicalName,
        description: `${logicalName} skill`,
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'workspace' as const,
          scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
          resourceId: logicalName,
          absolutePath: `/private/${logicalName}/SKILL.md`,
          revision: 'r1',
          contentHash: 'd'.repeat(64),
        },
        ...over,
      };
    }

    it('resolves a skill the model asked for in its own output', async () => {
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [invocableSkill('review')] }, {
        async readText() { return 'REVIEW_SKILL_BODY'; },
      }));

      const result = await agent.extractModelSkillInvocationsForTest('I will use [skill:review] here.');

      expect(result.selected.map(entry => entry.reference)).toEqual(['review']);
      expect(result.refused).toEqual([]);
    });

    it('refuses a skill whose author disabled model invocation', async () => {
      // The listing omits it, but a model that guesses the slug must still be
      // refused — otherwise the control is a hint, not a control.
      agent.setCapabilityTurnRuntime(capabilityRuntime({
        skills: [invocableSkill('hidden', { disableModelInvocation: true })],
      }, { async readText() { return 'HIDDEN_SKILL_BODY'; } }));

      const result = await agent.extractModelSkillInvocationsForTest('[skill:hidden]');

      expect(result.selected).toEqual([]);
      expect(result.refused).toContain('hidden');
    });

    it('still resolves a user-typed reference for a model-disabled skill', async () => {
      // `disable-model-invocation` restricts the model, not the human — the
      // documented invocation table says the user can still invoke it.
      agent.setCapabilityTurnRuntime(capabilityRuntime({
        skills: [invocableSkill('hidden', { disableModelInvocation: true })],
      }, { async readText() { return 'HIDDEN_SKILL_BODY'; } }));

      await collectEvents(agent.chat('[skill:hidden] please'));

      expect(agent.chatCalls[0]!.message).toContain('HIDDEN_SKILL_BODY');
    });

    // ---- skillOverrides (R61 · skills.md:663) ------------------------------
    // The merged rule: MODEL origin refuses `user-invocable-only` AND `off`;
    // USER origin refuses `off` only. Either half alone leaves a hole, so the
    // matrix is table-driven rather than one case per sentence.

    it.each([
      ['on', false, false],
      ['name-only', false, false],
      ['user-invocable-only', true, false],
      ['off', true, true],
    ] as const)(
      'skillOverrides %p refuses the model=%p and the user=%p',
      async (overrideState, modelRefused, userRefused) => {
        const modelAgent = new TestAgent(createMockBackendConfig());
        modelAgent.setCapabilityTurnRuntime(capabilityRuntime({
          skills: [invocableSkill('guessable', { overrideState })],
        }, { async readText() { return 'GUESSABLE_SKILL_BODY'; } }));

        // The listing never showed it for the two hidden states — this is a
        // model that GUESSED the slug, which is the only reachable bypass.
        const model = await modelAgent.extractModelSkillInvocationsForTest('[skill:guessable]');
        expect(model.refusedByOverride).toEqual(modelRefused ? ['guessable'] : []);
        expect(model.selected.length).toBe(modelRefused ? 0 : 1);
        // Never confused with the FRONTMATTER refusal: the surfaced message has
        // to be able to name `skillOverrides`.
        expect(model.refused).toEqual([]);

        const userAgent = new TestAgent(createMockBackendConfig());
        userAgent.setCapabilityTurnRuntime(capabilityRuntime({
          skills: [invocableSkill('guessable', { overrideState })],
        }, { async readText() { return 'GUESSABLE_SKILL_BODY'; } }));
        const events = await collectEvents(userAgent.chat('[skill:guessable] please'));

        if (userRefused) {
          // `skills.md:676` — "Invoking a hidden skill by its full name still
          // returns the `skillOverrides` error instead of running it."
          const error = events.find(event => event.type === 'error') as { message: string } | undefined;
          expect(error?.message).toContain('skillOverrides');
          expect(error?.message).toContain('guessable');
          expect(userAgent.chatCalls.length).toBe(0);
        } else {
          expect(userAgent.chatCalls[0]!.message).toContain('GUESSABLE_SKILL_BODY');
        }
      },
    );

    it('reports an overridden skill as hidden, never as missing', async () => {
      // Two different errors, and the difference matters: the skill IS on disk.
      // Telling the user it does not exist sends them looking for a file that is
      // right where they left it.
      agent.setCapabilityTurnRuntime(capabilityRuntime({
        skills: [invocableSkill('deploy', { overrideState: 'off' })],
      }, { async readText() { return 'DEPLOY_BODY'; } }));

      const events = await collectEvents(agent.chat('[skill:deploy] ship it'));
      const error = events.find(event => event.type === 'error') as { message: string } | undefined;

      expect(error?.message).toContain('skillOverrides');
      expect(error?.message).not.toContain('not found');
    });

    it('refuses a PLUGIN-provided skill whose author disabled model invocation', async () => {
      // The end-to-end half of the plugin-adapter fix. The field travelling into
      // the capability proves nothing on its own — this proves it bites on a
      // plugin-provided handle, which is the content the control exists for, and
      // that the human can still invoke it.
      const pluginSkill = {
        key: 'plugin:deployer:skill.deploy',
        logicalName: 'deploy',
        description: 'Deploys to production',
        selectedAsUnqualifiedAlias: true,
        resource: {
          pluginInstanceId: 'plugin://local/deployer@1.0.0#bundle',
          relativePath: 'skills/deploy/SKILL.md',
          contentHash: 'd'.repeat(64),
        },
        pluginRuntime: {
          rootPath: '/managed/plugin-cache/deployer',
          dataPath: '/managed/plugin-data/deployer',
          profile: 'generic-plugin-env-v1' as const,
        },
        disableModelInvocation: true,
      };

      const modelAgent = new TestAgent(createMockBackendConfig());
      modelAgent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [pluginSkill] }, {
        async readText() { return 'PLUGIN_DEPLOY_BODY'; },
      }));
      const refusedByModel = await modelAgent.extractModelSkillInvocationsForTest('[skill:deploy]');

      expect(refusedByModel.selected).toEqual([]);
      expect(refusedByModel.refused).toContain('deploy');

      const userAgent = new TestAgent(createMockBackendConfig());
      userAgent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [pluginSkill] }, {
        async readText() { return 'PLUGIN_DEPLOY_BODY'; },
      }));
      await collectEvents(userAgent.chat('[skill:deploy] please'));

      expect(userAgent.chatCalls[0]!.message).toContain('PLUGIN_DEPLOY_BODY');
    });

    it('feeds the skill body back into the same turn when the model invokes it', async () => {
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [invocableSkill('review')] }, {
        async readText() { return 'REVIEW_SKILL_BODY'; },
      }));
      agent.scriptedEvents = [
        { type: 'text_complete', text: 'This needs a review. [skill:review]' },
        { type: 'complete' },
      ];

      const events = await collectEvents(agent.chat('look at my diff'));

      // Two backend passes: the model's own turn, then the continuation carrying
      // the skill instructions.
      expect(agent.chatCalls).toHaveLength(2);
      expect(agent.chatCalls[0]!.message).not.toContain('REVIEW_SKILL_BODY');
      expect(agent.chatCalls[1]!.message).toContain('REVIEW_SKILL_BODY');
      expect(agent.chatCalls[1]!.message).toContain('<invoked-skill ');
      // The caller's loop stops at the first `complete`, so the intermediate one
      // must not escape.
      expect(events.filter(event => event.type === 'complete')).toHaveLength(1);
    });

    it('does not continue the turn for a skill it refused', async () => {
      agent.setCapabilityTurnRuntime(capabilityRuntime({
        skills: [invocableSkill('hidden', { disableModelInvocation: true })],
      }, { async readText() { return 'HIDDEN_SKILL_BODY'; } }));
      agent.scriptedEvents = [
        { type: 'text_complete', text: 'Let me just run [skill:hidden].' },
        { type: 'complete' },
      ];

      await collectEvents(agent.chat('deploy it'));

      expect(agent.chatCalls).toHaveLength(1);
      expect(JSON.stringify(agent.chatCalls)).not.toContain('HIDDEN_SKILL_BODY');
    });

    it('does not continue a turn the backend ended without a clean complete', async () => {
      // Pi returns without a `complete` on its abort paths (source_activated,
      // plan submitted, auth request). Re-entering there would resume an aborted
      // turn.
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [invocableSkill('review')] }, {
        async readText() { return 'REVIEW_SKILL_BODY'; },
      }));
      agent.scriptedEvents = [
        { type: 'text_complete', text: 'I would use [skill:review] but I am being interrupted.' },
        { type: 'source_activated', sourceSlug: 'gmail', originalMessage: 'look at my diff' },
      ];

      await collectEvents(agent.chat('look at my diff'));

      expect(agent.chatCalls).toHaveLength(1);
    });

    it('does not continue a turn a cap already terminated', async () => {
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [invocableSkill('review')] }, {
        async readText() { return 'REVIEW_SKILL_BODY'; },
      }));
      agent.scriptedEvents = [
        { type: 'text_complete', text: 'Reaching for [skill:review].' },
        { type: 'complete', terminalReason: 'max_budget_usd' },
      ];

      await collectEvents(agent.chat('look at my diff'));

      expect(agent.chatCalls).toHaveLength(1);
    });

    it('invokes a model-requested skill at most once per turn', async () => {
      // The continuation re-states the marker inside the injected body, and the
      // model may repeat it. Without dedup that is an unbounded loop.
      agent.setCapabilityTurnRuntime(capabilityRuntime({ skills: [invocableSkill('review')] }, {
        async readText() { return 'REVIEW_SKILL_BODY'; },
      }));
      agent.scriptedEvents = [
        { type: 'text_complete', text: 'Using [skill:review] again and again.' },
        { type: 'complete' },
      ];

      await collectEvents(agent.chat('look at my diff'));

      expect(agent.chatCalls).toHaveLength(2);
      expect(agent.chatCalls[1]!.message.match(/<invoked-skill /g)).toHaveLength(1);
    });

    // P6.650 — RE-PINNED against `1931f6ab8` (P6.387), which is the commit that
    // changed the behaviour this case used to assert. Before it, an `@import`
    // line on a line of its own was dropped whether or not anything resolved
    // it, so "the pinned block contains no `@import`" was true. `1931f6ab8`
    // made an UNRESOLVED whole-line token keep its line on purpose — an
    // auto-memory topic file, a file the walk never registered and a file the
    // user disabled in Sources had all become silence, and `memory.md`'s
    // affordance ("Claude reads them on demand using its standard file tools")
    // needs the model to see the name. So the contract now has two arms and
    // this case pins both.
    it('splices a resolved memory import and leaves an unresolvable one visible, without raw permission documents', async () => {
      const resource = (resourceId: string) => ({
        source: 'workspace' as const,
        scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
        resourceId,
        absolutePath: `/pinned/${resourceId}.md`,
        revision: 'r1',
        contentHash: 'a'.repeat(64),
      });
      const memory = resource('memory-base');
      const imported = resource('memory-imported');
      const rule = resource('memory-rule');
      const unscopedRule = resource('memory-unscoped-rule');
      const permission = resource('permission-source');
      const contents: Record<string, string> = {
        [memory.resourceId]: '# Memory\n@import ./memory-imported.md\nbase memory',
        [imported.resourceId]: 'imported memory',
        [rule.resourceId]: '---\npaths: packages/app/**\n---\n@import ./rule-note.md\nmatched rule body',
        [unscopedRule.resourceId]: '@import ./rule-note.md\nunscoped rule body',
        [permission.resourceId]: JSON.stringify({ allowedWritePaths: ['PERMISSION_SENTINEL'] }),
      };
      agent.setCapabilityTurnRuntime({
        view: {
          generation: 'generation-memory',
          sources: [],
          skills: [],
          mcpServers: [],
          hooks: [],
          automations: [],
          agents: [],
          promptLayers: [],
          memory: [
            { key: 'memory:base', resource: memory, readOnly: false },
            { key: 'memory:imported', resource: imported, readOnly: false },
            { key: 'memory:rule', resource: rule, readOnly: false, format: 'rule' },
            { key: 'memory:unscoped-rule', resource: unscopedRule, readOnly: false, format: 'rule' },
          ],
          permissionLayers: [{
            key: 'permission:source',
            resource: permission,
            order: 2,
            sourceSlug: 'linear',
          }],
          commands: [],
          promptCommands: [],
          apps: [],
        },
        materializer: {
          assertActive() {},
          async verifyPlugin() {},
          async resolvePath() { return ''; },
          async readText(value) {
            return 'resourceId' in value ? contents[value.resourceId] ?? '' : '';
          },
          resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
        },
      } satisfies CapabilityTurnRuntime);

      await collectEvents(agent.chat('test message'));
      const message = agent.chatCalls[0]?.message ?? '';
      expect(message).toContain('base memory');
      // Arm 1 — RESOLVED: the token names a file that IS in the view, so its
      // body is spliced into the importer and the directive line goes. Once,
      // not twice: the child must not also ship as a standalone layer.
      expect(message).toContain('imported memory');
      expect(message).not.toContain('@import ./memory-imported.md');
      expect(message).not.toContain('<capability-layer key="memory:imported">');
      // Arm 2 — UNRESOLVED: nothing in the view sits at `./rule-note.md`, so
      // the line survives verbatim rather than being silently dropped
      // (`1931f6ab8`). This is the arm the old `not.toContain('@import')`
      // assertion contradicted.
      expect(message).toContain('@import ./rule-note.md');
      // R28: only an UNSCOPED rule belongs in the pinned block. A `paths:` rule
      // fires on a matching file read and must stay out of the compaction-
      // surviving layer.
      expect(message).toContain('unscoped rule body');
      expect(message).not.toContain('matched rule body');
      expect(message).not.toContain('paths: packages/app/**');
      expect(message).not.toContain('PERMISSION_SENTINEL');
      expect(agent.getPermissionManager().getCapabilityPermissionsContext()).toMatchObject({
        pinnedRevision: 'generation-memory',
      });
    });

    // ---- Pinned context composed once per generation (P8 Task 1) ----------
    // Instructions and memory ride the USER MESSAGE on the live path, uncapped,
    // and every layer body used to be re-read (readFileSync + statSync + sha256)
    // and recomposed on every turn. These pin the cost fix AND the fact that it
    // stays a cost fix: the model must still see the same text every turn.

    function pinnedLayerRuntime(
      options: {
        generation?: string;
        instructionBody?: string;
        memoryBody?: string;
        onReadText?: (logicalName: string) => void;
      } = {},
    ): CapabilityTurnRuntime {
      const resource = (resourceId: string, contentHash: string) => ({
        source: 'workspace' as const,
        scope: { kind: 'workspace' as const, workspaceId: 'test-workspace-id' },
        resourceId,
        absolutePath: `/pinned/${resourceId}`,
        revision: 'r1',
        contentHash,
      });
      const instruction = resource('AGENTS.md', 'a'.repeat(64));
      const memory = resource('MEMORY.md', 'b'.repeat(64));
      const bodies: Record<string, string> = {
        'AGENTS.md': options.instructionBody ?? 'instruction body fixture',
        'MEMORY.md': options.memoryBody ?? 'memory body fixture',
      };
      return capabilityRuntime({
        ...(options.generation ? { generation: options.generation } : {}),
        promptLayers: [{ key: 'instruction:AGENTS.md', resource: instruction, order: 3 }],
        memory: [{ key: 'memory:MEMORY.md', resource: memory, readOnly: false }],
      } as Partial<CapabilityTurnRuntime['view']>, {
        async readText(value) {
          const logicalName = 'resourceId' in value ? value.resourceId : '';
          options.onReadText?.(logicalName);
          return bodies[logicalName] ?? '';
        },
      });
    }

    it('reads each instruction layer once across turns of one generation', async () => {
      const reads: string[] = [];
      agent.setCapabilityTurnRuntime(pinnedLayerRuntime({ onReadText: key => reads.push(key) }));

      await collectEvents(agent.chat('one'));
      await collectEvents(agent.chat('two'));
      await collectEvents(agent.chat('three'));

      // One read per layer for the whole generation, not one per turn.
      expect(reads.filter(key => key === 'AGENTS.md')).toHaveLength(1);
      expect(reads.filter(key => key === 'MEMORY.md')).toHaveLength(1);
    });

    it('still sends the same text on every turn when the backend never confirms delivery', async () => {
      // The fail-open half of L3. A backend that does not call
      // `notePinnedCapabilityContextDelivered` at its send seam — and any turn
      // that dies between composition and the send — keeps re-sending the block,
      // because under-sending would silently drop the user's own instructions
      // for the rest of the generation. `TestAgent` confirms nothing by default.
      //
      // A backend that DOES confirm sends it once per generation instead; that
      // contract lives in `pinned-capability-delivery.test.ts`.
      agent.setCapabilityTurnRuntime(pinnedLayerRuntime());

      await collectEvents(agent.chat('same message'));
      await collectEvents(agent.chat('same message'));

      expect(agent.chatCalls[1]!.message).toContain('instruction body fixture');
      expect(agent.chatCalls[1]!.message).toContain('memory body fixture');
      expect(agent.chatCalls[1]!.message).toEqual(agent.chatCalls[0]!.message);
    });

    it('keeps re-publishing the permission layers on a cached turn', async () => {
      // The composed block is cached; the permission-manager handoff is a side
      // effect of the same builder and must NOT be skipped with it.
      agent.setCapabilityTurnRuntime(pinnedLayerRuntime({ generation: 'generation-pinned' }));
      await collectEvents(agent.chat('one'));
      agent.getPermissionManager().clearCapabilityPermissionLayers();

      await collectEvents(agent.chat('two'));

      expect(agent.getPermissionManager().getCapabilityPermissionsContext()).toMatchObject({
        pinnedRevision: 'generation-pinned',
      });
    });

    it('re-reads when the capability generation changes', async () => {
      const reads: string[] = [];
      agent.setCapabilityTurnRuntime(pinnedLayerRuntime({ onReadText: key => reads.push(key) }));
      await collectEvents(agent.chat('one'));

      agent.setCapabilityTurnRuntime(pinnedLayerRuntime({
        generation: 'gen-2',
        onReadText: key => reads.push(key),
      }));
      await collectEvents(agent.chat('two'));

      expect(reads.filter(key => key === 'AGENTS.md')).toHaveLength(2);
    });

    it('re-reads after a memory write', async () => {
      // A `remember` call rewrites MEMORY.md, which changes its `contentHash`;
      // `computeGeneration` hashes exactly that, so the host hands the next turn
      // a NEW generation. This must therefore fall out of the generation key
      // rather than need its own special case — if it does not, the key is wrong.
      const reads: string[] = [];
      agent.setCapabilityTurnRuntime(pinnedLayerRuntime({
        memoryBody: 'memory before the write',
        onReadText: key => reads.push(key),
      }));
      await collectEvents(agent.chat('one'));

      agent.setCapabilityTurnRuntime(pinnedLayerRuntime({
        generation: 'generation-after-remember',
        memoryBody: 'memory after the write',
        onReadText: key => reads.push(key),
      }));
      await collectEvents(agent.chat('two'));

      expect(reads.filter(key => key === 'MEMORY.md')).toHaveLength(2);
      expect(agent.chatCalls[1]!.message).toContain('memory after the write');
      expect(agent.chatCalls[1]!.message).not.toContain('memory before the write');
    });

    it('should resolve active plugin skill mentions into agent skill read directives', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'plugin-skill-agent-'));
      try {
        const skillDir = join(workspaceRoot, 'plugin-cache', 'market-review');
        mkdirSync(skillDir, { recursive: true });
        const skillPath = join(skillDir, 'SKILL.md');
        writeFileSync(skillPath, `---
name: Marketplace Review
description: Review marketplace installs
---
Use marketplace runtime context.
`, 'utf-8');

        const pluginAgent = new TestAgent(createMockBackendConfig({
          workspace: createMockWorkspace({ workspaceRootPath: workspaceRoot }),
          session: createMockSession({ workingDirectory: workspaceRoot }),
        }));
        pluginAgent.setCapabilityTurnRuntime(capabilityRuntime({
          skills: [{
            key: 'skill:plugin:market-review',
            logicalName: 'market-review',
            description: 'Review marketplace installs',
            selectedAsUnqualifiedAlias: true,
            resource: {
              pluginInstanceId: 'plugin://internal/skills@1.0.0',
              relativePath: 'skills/market-review/SKILL.md',
              contentHash: 'd'.repeat(64),
            },
          }],
        }, {
          async readText() {
            return `---\nname: Marketplace Review\ndescription: Review marketplace installs\n---\nUse marketplace runtime context.`;
          },
        }));

        await collectEvents(pluginAgent.chat('Use [skill:market-review] for this install.'));

        const message = pluginAgent.chatCalls[0]?.message ?? '';
        expect(message).toContain('<invoked-skill key="skill:plugin:market-review" name="market-review"');
        expect(message).toContain('Use marketplace runtime context.');
        expect(message).toContain('[Mentioned skill: market-review (slug: market-review)]');
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('expands the persisted Codex profile before injecting an invoked plugin skill', async () => {
      const pluginRoot = '/managed/plugin-cache/honey';
      const pluginAgent = new TestAgent(createMockBackendConfig());
      pluginAgent.setCapabilityTurnRuntime(capabilityRuntime({
        skills: [{
          key: 'plugin:honey:skill.honey',
          logicalName: 'honey',
          description: 'Honey',
          selectedAsUnqualifiedAlias: true,
          resource: {
            pluginInstanceId: 'plugin://local/honey@1.1.0#bundle',
            relativePath: 'skills/honey/SKILL.md',
            contentHash: 'd'.repeat(64),
          },
          pluginRuntime: {
            rootPath: pluginRoot,
            dataPath: '/managed/plugin-data/honey',
            profile: 'codex-plugin-env-v1',
          },
        }],
      }, {
        async readText() {
          return '`node "${CLAUDE_PLUGIN_ROOT}/hooks/honey-state.js" set full`';
        },
      }));

      await collectEvents(pluginAgent.chat('[skill:honey] set full'));

      const message = pluginAgent.chatCalls[0]?.message ?? '';
      expect(message).toContain(`node "${pluginRoot}/hooks/honey-state.js" set full`);
      expect(message).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    });

    it('binds a bundle-referencing process to exactly one selected plugin runtime for the active turn', async () => {
      const pluginAgent = new TestAgent(createMockBackendConfig());
      const skill = (slug: string, rootPath: string, dataPath: string) => ({
        key: `plugin:${slug}:skill.${slug}`,
        logicalName: slug,
        description: slug,
        selectedAsUnqualifiedAlias: true,
        resource: {
          pluginInstanceId: `plugin://local/${slug}@1.0.0#bundle`,
          relativePath: `skills/${slug}/SKILL.md`,
          contentHash: 'd'.repeat(64),
        },
        pluginRuntime: { rootPath, dataPath, profile: 'codex-plugin-env-v1' as const },
      });
      const honeyRoot = '/managed/plugin-cache/honey';
      const otherRoot = '/managed/plugin-cache/other';
      pluginAgent.setCapabilityTurnRuntime(capabilityRuntime({
        skills: [
          skill('honey', honeyRoot, '/managed/plugin-data/honey'),
          skill('other', otherRoot, '/managed/plugin-data/other'),
        ],
      }, { async readText() { return 'plugin instructions'; } }));

      const turn = pluginAgent.chat('[skill:honey] [skill:other] run');
      await turn.next();
      expect(pluginAgent.resolveActivePluginSkillRuntimeForProcessForTest(
        '/bin/sh',
        ['-lc', `node "${honeyRoot}/hooks/honey-state.js" set full`],
      )?.runtime.dataPath).toBe('/managed/plugin-data/honey');
      expect(pluginAgent.resolveActivePluginSkillRuntimeForProcessForTest('/bin/sh', ['-lc', 'pwd']))
        .toBeUndefined();
      expect(() => pluginAgent.resolveActivePluginSkillRuntimeForProcessForTest(
        '/bin/sh',
        ['-lc', `node "${honeyRoot}/hook.js" && node "${otherRoot}/hook.js"`],
      )).toThrow('plugin-skill-process-runtime-ambiguous');

      await turn.next();
      expect(pluginAgent.resolveActivePluginSkillRuntimeForProcessForTest(
        '/bin/sh',
        ['-lc', `node "${honeyRoot}/hooks/honey-state.js" set full`],
      )).toBeUndefined();
    });

    it('should track abort calls', async () => {
      await agent.abort('test reason');
      expect(agent.abortCalls).toHaveLength(1);
      expect(agent.abortCalls[0]?.reason).toBe('test reason');
    });

    it('should delegate handoff interrupts to forceAbort by default', () => {
      agent.interruptForHandoff(AbortReason.AuthRequest);
      expect(agent.forceAbortCalls).toHaveLength(1);
      expect(agent.forceAbortCalls[0]?.reason).toBe(AbortReason.AuthRequest);
    });

    it('should track respondToPermission calls', () => {
      agent.respondToPermission('req-1', true, false);
      expect(agent.respondToPermissionCalls).toHaveLength(1);
      expect(agent.respondToPermissionCalls[0]).toEqual({
        requestId: 'req-1',
        allowed: true,
        alwaysAllow: false,
      });
    });

    it('should cleanup on destroy', () => {
      // Should not throw
      agent.destroy();
    });

    it('should cleanup on dispose (alias)', () => {
      // Should not throw
      agent.dispose();
    });
  });

  describe('Callbacks', () => {
    it('should support debug callback', () => {
      let message = '';
      agent.onDebug = (msg) => { message = msg; };

      // Trigger a debug message by setting thinking level
      agent.setThinkingLevel('off');
      expect(message).toContain('Thinking level');
    });

    it('should support permission mode change callback', () => {
      let mode = '';
      agent.onPermissionModeChange = (m) => { mode = m; };

      agent.setPermissionMode('bypassPermissions');
      expect(mode).toBe('bypassPermissions');
    });
  });

  describe('Config Watcher', () => {
    it('should not start config watcher when skipConfigWatcher is true', () => {
      // Simulates the SessionManager scenario: isHeadless=false but server owns the watcher
      const managedAgent = new TestAgent(createMockBackendConfig({
        isHeadless: false,
        skipConfigWatcher: true,
      }));
      // configWatcherManager should remain null — the guard in startConfigWatcher() returns early
      expect(managedAgent.getConfigWatcherManager()).toBeNull();
      managedAgent.destroy();
    });

    it('should not start config watcher when isHeadless is true (existing behavior)', () => {
      // Simulates temp/headless agents — existing isHeadless guard still works
      const headlessAgent = new TestAgent(createMockBackendConfig({
        isHeadless: true,
      }));
      expect(headlessAgent.getConfigWatcherManager()).toBeNull();
      headlessAgent.destroy();
    });
  });

  describe('maxBudgetUsd ceiling', () => {
    // The check used to live only inside PiAgent's own chat loop, so a
    // Claude-backend session had no spend ceiling at all. It reads costUsd off a
    // complete/usage_update event, which is backend-agnostic, so it belongs on
    // the shared base.
    function agentWithBudget(maxBudgetUsd: number, scripted: AgentEvent[]): TestAgent {
      const budgeted = new TestAgent(createMockBackendConfig());
      budgeted.setCapabilityTurnRuntime(capabilityRuntime());
      budgeted.scriptedEvents = scripted;
      // Same config value Pi reads: loadConfigDefaults().workspaceDefaults.maxBudgetUsd.
      ;(budgeted as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => maxBudgetUsd;
      return budgeted;
    }

    /**
     * A turn from a backend that CAN price, at `costUsd`.
     *
     * P2.36 — `costReporting: 'reported'` is the whole difference between this
     * and {@link unpricedComplete}, and it is what the cap requires before it
     * counts anything. Both real emitters stamp it (`backend/claude` off the
     * SDK's cumulative total, `backend/pi` off pi-ai's table), so a fixture
     * without it describes an unpriced runtime rather than a cheap one.
     */
    function pricedComplete(costUsd: number): AgentEvent {
      return { type: 'complete', usage: { inputTokens: 1, outputTokens: 10, costUsd, costReporting: 'reported' } as never };
    }

    /** A turn from a backend that reported an accounting with no price in it. */
    function unpricedComplete(): AgentEvent {
      return { type: 'complete', usage: { inputTokens: 1, outputTokens: 10, costReporting: 'unsupported' } as never };
    }

    it('stops a non-Pi turn once the configured budget is exceeded', async () => {
      const budgeted = agentWithBudget(1.0, [
        { type: 'usage_update', usage: { costUsd: 0.7, costReporting: 'reported' } as never },
        { type: 'usage_update', usage: { costUsd: 0.5, costReporting: 'reported' } as never },
      ]);
      const events = await collectEvents(budgeted.chat('hi'));
      expect(events.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
      // A cap is a stop, not a failure: no error event, and the events already
      // produced this turn survive.
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(events.filter(event => event.type === 'usage_update')).toHaveLength(2);
      expect(budgeted.forceAbortCalls).toEqual([{ reason: AbortReason.MaxBudgetUsd }]);
      budgeted.destroy();
    });

    it('never fires when the provider reports no usable cost', async () => {
      // Subscription and gateway backends report no total_cost_usd. Nothing that
      // is not a finite positive number may read as spend: it must not read as 0
      // spend forever, and it must not read as a breach either.
      //
      // P2.36 split this into two questions that used to be one. What the cap
      // COUNTS is below; whether the session is TOLD is the sibling describe.
      // Each row is one shape `classifyEventCost` has to absorb — the two
      // `reported` rows are the ones `Number.isFinite` is still load-bearing
      // for, because a priced series may carry a junk increment on one event
      // without the meter itself being broken.
      const noCostShapes: Array<[string, unknown, unknown]> = [
        ['absent, no verdict', undefined, undefined],
        ['zero, no verdict', 0, undefined],
        ['non-numeric, no verdict', null, undefined],
        ['non-finite, no verdict', Number.POSITIVE_INFINITY, undefined],
        ['explicitly unsupported', undefined, 'unsupported'],
        ['zero under a working meter', 0, 'reported'],
        ['non-finite under a working meter', Number.POSITIVE_INFINITY, 'reported'],
      ];
      for (const [label, costUsd, costReporting] of noCostShapes) {
        const budgeted = agentWithBudget(1.0, [
          { type: 'complete', usage: { inputTokens: 1, outputTokens: 10, costUsd, costReporting } as never },
        ]);
        const events = await collectEvents(budgeted.chat('hi'));
        expect(events.at(-1), label).toMatchObject({ type: 'complete' });
        expect((events.at(-1) as { terminalReason?: string }).terminalReason, label).toBeUndefined();
        expect(budgeted.forceAbortCalls, label).toEqual([]);
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd, label).toBe(0);
        budgeted.destroy();
      }
    });

    it('stays off at the default of 0', async () => {
      // Priced on purpose: the ceiling of 0 must be what turns the cap off, not
      // an absent cost that would have turned it off anyway.
      const budgeted = agentWithBudget(0, [{ type: 'usage_update', usage: { costUsd: 999, costReporting: 'reported' } as never }]);
      const events = await collectEvents(budgeted.chat('hi'));
      expect((events.at(-1) as { terminalReason?: string }).terminalReason).toBeUndefined();
      expect(budgeted.forceAbortCalls).toEqual([]);
      budgeted.destroy();
    });

    it('names the budget on the backend complete rather than emitting a second one', async () => {
      // sendMessage's chat loop stops at the FIRST complete, so a reason appended
      // as an extra event after the backend's own complete would never be read.
      const budgeted = agentWithBudget(1.0, [pricedComplete(1.5)]);
      const events = await collectEvents(budgeted.chat('hi'));
      expect(events.filter(event => event.type === 'complete')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
      budgeted.destroy();
    });

    // ---------------------------------------------------------------------
    // P2.36 — AN UNENFORCEABLE CEILING SAYS SO INSTEAD OF PASSING SILENTLY.
    //
    // `exceedsMaxBudgetUsd` returning `false` used to mean two things at once:
    // "comfortably under the ceiling" and "there is no number to compare".
    // Codex reports no cost at all, pi-ai's price table yields nothing for every
    // Nessy Gateway model, and the claude adapter used to CLAIM `reported` over
    // a `total_cost_usd` that is 0 on every gateway result — so a configured cap
    // read as a satisfied budget check forever, and nothing said otherwise.
    //
    // Per the owner's budget ruling (2026-08-24) the fix is honesty, not a
    // manufactured number: no price table is invented anywhere in this change,
    // because a fabricated cost would make the cap fire on fiction.
    // ---------------------------------------------------------------------
    describe('an unenforceable ceiling is reported, not passed silently', () => {
      function noticesIn(events: AgentEvent[]): AgentEvent[] {
        return events.filter(event =>
          event.type === 'info' && /cannot be enforced/.test((event as { message: string }).message));
      }

      it('says the limit cannot be enforced when the turn reported no cost', async () => {
        const budgeted = agentWithBudget(5, [unpricedComplete()]);
        const events = await collectEvents(budgeted.chat('hi'));

        const notices = noticesIn(events);
        expect(notices).toHaveLength(1);
        // A warning, not an `info`: the user's spending limit is inert and that
        // is a fact about their safety net, not a status line.
        expect(notices[0]).toMatchObject({ type: 'info', level: 'warning' });
        // The configured ceiling is NAMED, so the message is about the limit the
        // user actually set rather than a generic capability disclaimer.
        expect((notices[0] as { message: string }).message).toContain('$5');
        // And it does NOT claim a spend: no number was established, so none is
        // shown. This is the line between "0 because free" and "0 because
        // unpriced" that the whole row exists to keep visible.
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(0);
        budgeted.destroy();
      });

      it('yields it BEFORE the complete, or nobody would ever read it', async () => {
        // `SessionManager.sendMessage`'s chat loop stops at the first `complete`.
        // A notice appended after it is emitted into a loop that has already
        // returned — the same trap the `terminalReason` spread exists for.
        const budgeted = agentWithBudget(5, [unpricedComplete()]);
        const events = await collectEvents(budgeted.chat('hi'));

        const noticeIndex = events.findIndex(event => event.type === 'info');
        const completeIndex = events.findIndex(event => event.type === 'complete');
        expect(noticeIndex).toBeGreaterThanOrEqual(0);
        expect(completeIndex).toBeGreaterThanOrEqual(0);
        expect(noticeIndex).toBeLessThan(completeIndex);
        budgeted.destroy();
      });

      it('says it once per session, not once per turn', async () => {
        // The fact is a property of the runtime this session talks to. Repeating
        // it every turn is noise the user learns to scroll past, which is how a
        // warning becomes invisible.
        const budgeted = agentWithBudget(5, [unpricedComplete()]);
        const first = await collectEvents(budgeted.chat('one'));
        budgeted.scriptedEvents = [unpricedComplete()];
        const second = await collectEvents(budgeted.chat('two'));

        expect(noticesIn(first)).toHaveLength(1);
        expect(noticesIn(second)).toHaveLength(0);
        budgeted.destroy();
      });

      it('CONTROL: a priced session is byte-identical — no notice, cap still fires', async () => {
        // The negative of this row is "the warning fires on sessions that ARE
        // capped", so the positive has to be pinned on the same rig. Two turns
        // of $3 against a $5 ceiling: silent under, capped over, never a notice.
        const budgeted = agentWithBudget(5, [pricedComplete(3)]);
        const under = await collectEvents(budgeted.chat('one'));
        budgeted.scriptedEvents = [pricedComplete(3)];
        const over = await collectEvents(budgeted.chat('two'));

        expect(noticesIn(under)).toHaveLength(0);
        expect(noticesIn(over)).toHaveLength(0);
        expect((under.at(-1) as { terminalReason?: string }).terminalReason).toBeUndefined();
        expect(over.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(6);
        budgeted.destroy();
      });

      it('CONTROL: a free turn under a working meter is not an unenforceable cap', async () => {
        // `costReporting: 'reported'` with a cost of 0 is the third state, and
        // it is the one that makes the distinction worth having: the meter
        // works, this turn was free, the ceiling is enforceable, say nothing.
        const budgeted = agentWithBudget(5, [pricedComplete(0)]);
        const events = await collectEvents(budgeted.chat('hi'));
        expect(noticesIn(events)).toHaveLength(0);
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(0);
        budgeted.destroy();
      });

      it('CONTROL: with no ceiling configured there is nothing to be unenforceable', async () => {
        const budgeted = agentWithBudget(0, [unpricedComplete()]);
        const events = await collectEvents(budgeted.chat('hi'));
        expect(noticesIn(events)).toHaveLength(0);
        budgeted.destroy();
      });

      it('CONTROL: a mid-turn usage_update without a cost is not the verdict', async () => {
        // Every `usage_update` the claude adapter emits carries tokens and a
        // context window and no money (`claude-agent.ts`'s P2.28 note). Keying
        // the notice off those would fire on the priced runtime, every turn, on
        // an event that never claimed to price anything. Only a turn's terminal
        // `complete` answers the question.
        const budgeted = agentWithBudget(5, [
          { type: 'usage_update', usage: { inputTokens: 20 } as never },
          pricedComplete(1),
        ]);
        const events = await collectEvents(budgeted.chat('hi'));
        expect(noticesIn(events)).toHaveLength(0);
        budgeted.destroy();
      });

      // -------------------------------------------------------------------
      // P2.128 — A RUNTIME THAT REPORTS NO COST AT ALL IS THE FOURTH CASE.
      //
      // `classifyEventCost` can only read what an event CARRIES, and
      // `backend/nestor-cloud` yields a bare `{ type: 'complete' }` — no usage
      // object at all. That is `absent`, the same verdict a `status` event
      // gets, so the notice never fired: a configured ceiling on a default-ON
      // card read as a satisfied budget check forever.
      //
      // It cannot be fixed by treating every usage-less complete as
      // unavailable — `claude-agent.ts` and `pi-agent.ts` each yield one on a
      // dozen error/abort/sub-flow paths and those runtimes CAN price. So the
      // runtime declares it, and the CONTROL below is the half that matters.
      // -------------------------------------------------------------------
      it('says so when the runtime reports no cost at all and the turn carried no usage', async () => {
        const budgeted = agentWithBudget(5, [{ type: 'complete' }]);
        ;(budgeted as unknown as { reportsCostUsd(): boolean }).reportsCostUsd = () => false;
        const events = await collectEvents(budgeted.chat('hi'));

        const notices = noticesIn(events);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ type: 'info', level: 'warning' });
        expect((notices[0] as { message: string }).message).toContain('$5');
        // The unmetered wording, not the per-turn one: "no cost for the turn"
        // would be a claim about one turn on a runtime where it is permanent.
        expect((notices[0] as { message: string }).message).toContain('does not report spending');
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(0);
        budgeted.destroy();
      });

      it('CONTROL: a bare complete on a runtime that CAN price says nothing', async () => {
        // The mutation this kills: making `classifyEventCost` answer
        // `unavailable` for every usage-less complete. Claude and Pi emit these
        // on error and abort paths, and the notice would latch a false claim —
        // "your limit cannot be enforced" — for the rest of the session on the
        // one runtime whose cap actually works.
        const budgeted = agentWithBudget(5, [{ type: 'complete' }]);
        const events = await collectEvents(budgeted.chat('hi'));
        expect(noticesIn(events)).toHaveLength(0);
        budgeted.destroy();
      });

      it('CONTROL: a priced turn on an unmetered runtime says nothing AND arms nothing', async () => {
        // `reportsCostUsd()` is about the runtime, not the turn, so a real
        // figure that arrived must not be described as a silence: priced $3
        // against a $5 ceiling emits NO notice. That half is unchanged and is
        // what this control was written for.
        //
        // The second half was reversed by `8bfb12497`, and deliberately. Before
        // it, a ceiling was armed on a runtime that can never price a turn and
        // stayed silent because no turn ever priced; the guard it added returns
        // BEFORE the counter on a runtime that declares it cannot price, so a
        // stray priced event cannot re-arm a cap the runtime cannot enforce.
        // `exceedsMaxBudgetUsd`'s own comment names the only thing that re-arms
        // it — deleting that runtime's `reportsCostUsd` override — and P2.258
        // declared the refusal. `sessionCostUsd` is that cap's counter and
        // nothing else reads it, so it stays at 0 with the cap disarmed.
        const budgeted = agentWithBudget(5, [pricedComplete(3)]);
        ;(budgeted as unknown as { reportsCostUsd(): boolean }).reportsCostUsd = () => false;
        const events = await collectEvents(budgeted.chat('hi'));
        expect(noticesIn(events)).toHaveLength(0);
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(0);
        // The successor asserted present, so this can never be met by deleting
        // the guard AND the expectation together: the SAME turn on a runtime
        // that does report cost counts the $3.
        const metered = agentWithBudget(5, [pricedComplete(3)]);
        await collectEvents(metered.chat('hi'));
        expect((metered as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(3);
        metered.destroy();
        budgeted.destroy();
      });

      it('still says it once per session on an unmetered runtime', async () => {
        const budgeted = agentWithBudget(5, [{ type: 'complete' }]);
        ;(budgeted as unknown as { reportsCostUsd(): boolean }).reportsCostUsd = () => false;
        const first = await collectEvents(budgeted.chat('one'));
        budgeted.scriptedEvents = [{ type: 'complete' }];
        const second = await collectEvents(budgeted.chat('two'));
        expect(noticesIn(first)).toHaveLength(1);
        expect(noticesIn(second)).toHaveLength(0);
        budgeted.destroy();
      });
    });

    // ---------------------------------------------------------------------
    // P2.129 — A CRASHED TURN DOES NOT GET TO ANSWER "CAN THIS RUNTIME PRICE?"
    //
    // Measured: the claude adapter reads its `costReporting` verdict off the
    // CUMULATIVE `total_cost_usd`, and the SDK's own type says a crash result may
    // carry a zeroed one (`sdk.d.ts`, `SDKResultError.total_cost_usd`:
    // *"Crash/startup-error results may carry zeroed values"*). So a PRICED
    // session whose FIRST turn ends `error_during_execution` reported
    // `unsupported`, the notice fired — and BOTH halves of it are permanent. The
    // latch is per-AGENT, cleared only by building a new instance; and
    // `SessionManager` persists the notice as a `level: 'warning'` transcript
    // row, which survives reload and is never retracted. A false "your limit
    // cannot be enforced" therefore outlives the crash that caused it.
    //
    // The fix DEFERS rather than answers. A failed turn is not evidence about
    // the meter, because no turn ran for it to price; the first turn that ends
    // normally establishes the verdict instead. The asymmetry is the whole
    // argument: a deferred notice is said one turn later, a false one forever.
    //
    // MEASURED RESIDUAL, OUTSIDE THIS ROW'S ZONE — the display half is NOT fixed
    // here. The crashed turn's `costReporting: 'unsupported'` still rides the
    // wire, and `SessionManager.ts`'s `mergeCostReporting` folds `unsupported`
    // followed by a later `reported` to `partial`, which then absorbs every turn
    // after it. So a crash-first priced session still renders its total as
    // incomplete forever. Only the emitter can fix both at once
    // (`backend/claude/event-adapter.ts`, `claudeCostReporting(msg.total_cost_usd)`).
    // ---------------------------------------------------------------------
    describe('a crashed turn defers the cost verdict instead of latching a false one', () => {
      function noticesIn(events: AgentEvent[]): AgentEvent[] {
        return events.filter(event =>
          event.type === 'info' && /cannot be enforced/.test((event as { message: string }).message));
      }

      /** Whether the once-per-session latch has been spent. */
      function latched(budgeted: TestAgent): boolean {
        return (budgeted as unknown as { budgetUnenforceableReported: boolean }).budgetUnenforceableReported;
      }

      /**
       * A turn that ENDED `reason`, carrying the zeroed accounting a crash
       * result produces — the exact shape `backend/claude/event-adapter.ts`
       * emits when `claudeCostReporting(0)` returns `unsupported`.
       *
       * `terminalIsError` mirrors the SDK's own `is_error`, which the adapter
       * spreads onto the complete; it is a SEPARATE axis from the reason,
       * because the `subtype: 'success'` + `is_error: true` shape carries a
       * failure with no error subtype of its own.
       */
      function endedComplete(
        reason: AgentTerminalReason | undefined,
        extra: { terminalIsError?: true } = {},
      ): AgentEvent {
        return {
          type: 'complete',
          usage: { inputTokens: 1, outputTokens: 0, costUsd: 0, costReporting: 'unsupported' },
          ...(reason ? { terminalReason: reason } : {}),
          ...extra,
        } as never;
      }

      /** The claude `error_during_execution` result, as the adapter emits it. */
      function crashComplete(): AgentEvent {
        return endedComplete('provider_error', { terminalIsError: true });
      }

      it('a crash-first PRICED session says nothing, then prices and caps normally', async () => {
        // THE ROW. Turn one crashes before anything was billed; turns two and
        // three are ordinary priced turns. Nothing may be said on the crash, the
        // real turn must establish the verdict, and the ceiling must still fire.
        const budgeted = agentWithBudget(5, [crashComplete()]);
        const crash = await collectEvents(budgeted.chat('one'));
        expect(noticesIn(crash)).toHaveLength(0);
        // The half that would have been PERSISTED: nothing latched, so there is
        // no stale warning for a reload to bring back.
        expect(latched(budgeted)).toBe(false);

        budgeted.scriptedEvents = [pricedComplete(3)];
        const real = await collectEvents(budgeted.chat('two'));
        expect(noticesIn(real)).toHaveLength(0);
        expect(latched(budgeted)).toBe(false);
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(3);

        budgeted.scriptedEvents = [pricedComplete(3)];
        const over = await collectEvents(budgeted.chat('three'));
        expect(noticesIn(over)).toHaveLength(0);
        expect(over.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
        budgeted.destroy();
      });

      it('DEFERRED, NOT SUPPRESSED: an unpriced runtime still says so on its next ordinary turn', async () => {
        // The positive control for the whole row. If the guard silenced the
        // notice rather than postponing it, a runtime that genuinely cannot
        // price would go quiet forever after one crash — the same class of
        // defect one sign flipped, and strictly harder to notice.
        const budgeted = agentWithBudget(5, [crashComplete()]);
        expect(noticesIn(await collectEvents(budgeted.chat('one')))).toHaveLength(0);

        budgeted.scriptedEvents = [unpricedComplete()];
        const second = await collectEvents(budgeted.chat('two'));
        expect(noticesIn(second)).toHaveLength(1);
        expect(latched(budgeted)).toBe(true);
        budgeted.destroy();
      });

      it('only a FAILED ending defers; an ending that FINISHED still answers', async () => {
        // NARROW ON PURPOSE, pinned per ending. `TERMINAL_REASON_VALUES` is the
        // vocabulary; the split is failure vs. finished, not error-ish vs. not.
        const defers: Array<[string, AgentEvent]> = [
          ['provider_error + is_error — the claude crash result', crashComplete()],
          ['provider_error alone', endedComplete('provider_error')],
          ['internal_error', endedComplete('internal_error')],
          ['timeout', endedComplete('timeout')],
          ['is_error with no reason at all', endedComplete(undefined, { terminalIsError: true })],
          // The SDK settles a user interrupt as `subtype: 'success'` +
          // `is_error: true` + an aborted terminal_reason, so this row overlaps
          // `user_stop` below and `terminalIsError` decides it. Deliberate: a
          // first-turn interrupt on a priced session has the SAME zeroed total a
          // crash does, so answering here would latch the same false warning.
          ['user_stop carrying is_error — an interrupted turn', endedComplete('user_stop', { terminalIsError: true })],
          ['tool_deferred_unavailable — is_error by contract', endedComplete('tool_deferred_unavailable', { terminalIsError: true })],
        ];
        const answers: Array<[string, AgentEvent]> = [
          ['no reason at all — an ordinary turn', endedComplete(undefined)],
          ['user_stop without is_error', endedComplete('user_stop')],
          ['provider_refusal — a refusal is a finished turn', endedComplete('provider_refusal')],
          ['max_agent_turns', endedComplete('max_agent_turns')],
          ['plan_submitted', endedComplete('plan_submitted')],
          ['tool_deferred', endedComplete('tool_deferred')],
        ];

        // P2.227(c) — EVERY ROW RUNS, EVERY RUN. These loops used to assert
        // inside themselves, so the first failing row aborted the test and the
        // twelve behind it were never exercised: under mutation only ONE of the
        // thirteen labelled endings was actually proven, while the block read
        // like 13 pins. Each row is measured into a table first and the tables
        // are compared once, so a mutant that breaks only the last row is caught
        // — and the label still names it, which was the block's real value.
        async function measure(rows: Array<[string, AgentEvent]>): Promise<Array<[string, number, boolean]>> {
          const seen: Array<[string, number, boolean]> = [];
          for (const [label, event] of rows) {
            const budgeted = agentWithBudget(5, [event]);
            const events = await collectEvents(budgeted.chat('hi'));
            seen.push([label, noticesIn(events).length, latched(budgeted)]);
            budgeted.destroy();
          }
          return seen;
        }

        expect(await measure(defers)).toEqual(defers.map(([label]) => [label, 0, false]));
        expect(await measure(answers)).toEqual(answers.map(([label]) => [label, 1, true]));
      });

      it('P2.227(d) THE JOIN: the fixtures above are the shape the REAL claude adapter emits', async () => {
        // The residue this closes: the adapter's suite proved a crash result
        // emits `costReporting: 'unsupported'` and `terminalIsError`, this suite
        // proved the guard defers on that shape, and NOTHING connected them —
        // the join was by construction, so a change to either side could have
        // left both suites green while the pair stopped meeting.
        //
        // Here the event is produced by the real emitter and fed to the real
        // guard. `error_during_execution` + `is_error` is the claude crash
        // result; `total_cost_usd: 0` is what the SDK documents it may carry.
        const adapter = new ClaudeEventAdapter({
          onDebug: () => {},
          onSessionId: () => {},
        } as never);
        adapter.startTurn();
        const emitted = await adapter.adapt({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: [],
          result: '',
          num_turns: 1,
          stop_reason: null,
          total_cost_usd: 0,
          modelUsage: {},
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          session_id: 'sess-join',
        } as never);
        const complete = emitted.find(event => event.type === 'complete') as AgentEvent | undefined;

        // The two axes the guard reads, off the emitter rather than off a literal.
        expect(complete).toMatchObject({ type: 'complete', terminalIsError: true });
        expect((complete as { usage?: { costReporting?: string } }).usage?.costReporting).toBe('unsupported');

        // And the guard defers on THAT event, not on a hand-written twin.
        const budgeted = agentWithBudget(5, [complete as AgentEvent]);
        expect(noticesIn(await collectEvents(budgeted.chat('hi')))).toHaveLength(0);
        expect(latched(budgeted)).toBe(false);
        budgeted.destroy();
      });

      it('CONTROL: only the NOTICE is skipped — a crashed turn that carried a price still counts', async () => {
        // The guard sits in `takeUnenforceableBudgetNotice` and nowhere else, so
        // enforcement is untouched. A crash that still reported $6 against a $5
        // ceiling must trip the cap exactly as it did before this row.
        const budgeted = agentWithBudget(5, [{
          type: 'complete',
          usage: { inputTokens: 1, outputTokens: 10, costUsd: 6, costReporting: 'reported' },
          terminalReason: 'provider_error',
          terminalIsError: true,
        } as never]);
        const events = await collectEvents(budgeted.chat('hi'));
        expect(noticesIn(events)).toHaveLength(0);
        expect(events.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(6);
        budgeted.destroy();
      });

      it('CONTROL: an UNMETERED runtime is a fact about the runtime, and a crash defers that too', async () => {
        // P2.128's arm reaches the same latch through `reportsCostUsd()`, so it
        // needs the same deferral: a crashed turn on a runtime that reports no
        // cost is still not the turn that gets to say so, and the next ordinary
        // turn still does.
        const budgeted = agentWithBudget(5, [{ type: 'complete', terminalReason: 'provider_error', terminalIsError: true } as never]);
        ;(budgeted as unknown as { reportsCostUsd(): boolean }).reportsCostUsd = () => false;
        expect(noticesIn(await collectEvents(budgeted.chat('one')))).toHaveLength(0);

        budgeted.scriptedEvents = [{ type: 'complete' }];
        expect(noticesIn(await collectEvents(budgeted.chat('two')))).toHaveLength(1);
        budgeted.destroy();
      });
    });

    // ---------------------------------------------------------------------
    // P2.43 — `/clear` MEANS ONE THING FOR THE SPEND CEILING, ON EVERY RUNTIME.
    //
    // The rule: `/clear` starts a fresh conversation, not a fresh wallet. The
    // argument for this direction rather than the other is on `sessionCostUsd`
    // itself; the short version is that a ceiling a single keystroke renews is
    // not a ceiling.
    //
    // Tested HERE because this is the `/clear` every backend takes: the arm lives
    // in `BaseAgent.chat` and `chatImpl` is never entered for it, so claude,
    // codex and nestor-cloud all pass through this exact path. Pi's two
    // boundaries have their own tests in `pi-agent-max-budget.test.ts`, and the
    // guard that no runtime can reintroduce a reset lives there too.
    // ---------------------------------------------------------------------
    describe('/clear leaves the spend ceiling exactly where it was', () => {
      it('keeps the accumulated spend across the shared /clear arm', async () => {
        const budgeted = agentWithBudget(5, [pricedComplete(3)]);
        await collectEvents(budgeted.chat('one'));
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(3);

        const cleared = await collectEvents(budgeted.chat('/clear'));
        // The real command, through the real seam: `chatImpl` is never entered.
        expect(cleared.some(event =>
          event.type === 'info' && /Context cleared/.test((event as { message: string }).message))).toBe(true);
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(3);
        budgeted.destroy();
      });

      it('and the ceiling still fires afterwards, against the pre-clear spend', async () => {
        // The letter of the rule is that the counter survives; the point of it is
        // that the CAP still consults it. $3 spent, cleared, $3 more against a $5
        // ceiling: a session that reset would sail straight past.
        const budgeted = agentWithBudget(5, [pricedComplete(3)]);
        await collectEvents(budgeted.chat('one'));
        await collectEvents(budgeted.chat('/clear'));

        budgeted.scriptedEvents = [pricedComplete(3)];
        const after = await collectEvents(budgeted.chat('two'));

        expect(after.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
        expect(budgeted.forceAbortCalls).toEqual([{ reason: AbortReason.MaxBudgetUsd }]);
        budgeted.destroy();
      });

      it('CONTROL: on a runtime with no cost the rule is a provable no-op', async () => {
        // Codex reports no cost at all and pi-ai prices no gateway model, so for
        // those sessions this is 0 before and 0 after. The rule must be
        // well-defined there rather than merely unexercised — and P2.36's notice
        // is what keeps that 0 from reading as "safely under budget".
        const budgeted = agentWithBudget(5, [unpricedComplete()]);
        await collectEvents(budgeted.chat('one'));
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(0);

        await collectEvents(budgeted.chat('/clear'));
        expect((budgeted as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(0);
        budgeted.destroy();
      });
    });

    // ---------------------------------------------------------------------
    // P2.44 — THE CEILING SURVIVES A NEW AGENT INSTANCE.
    //
    // `sessionCostUsd` is a field on an AGENT, and a session outlives its agent:
    // a runtime-config change disposes and recreates one, reopening builds one,
    // restarting the app builds one with no memory. Each started at $0, so a $5
    // ceiling was really $5 per instance. The fix reads the session's own
    // recorded spend once, through `config.getSessionSpendUsd` — the same
    // per-turn increments the counter adds, already surviving as a session-header
    // field, and already the figure the user is shown.
    // ---------------------------------------------------------------------
    describe('the ceiling survives a new agent instance', () => {
      /** An agent for a session that has already recorded `recorded` of spend. */
      function instanceForSession(
        maxBudgetUsd: number,
        getSessionSpendUsd: () => number | undefined,
        scripted: AgentEvent[],
      ): TestAgent {
        const agent = new TestAgent(createMockBackendConfig({ getSessionSpendUsd }));
        agent.setCapabilityTurnRuntime(capabilityRuntime());
        agent.scriptedEvents = scripted;
        ;(agent as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => maxBudgetUsd;
        return agent;
      }

      it('a replacement instance resumes the session spend instead of restarting it', async () => {
        // The first instance spends $3 of a $5 ceiling and is replaced — the
        // runtime-config change path (`managed.agent = await createAgent()`).
        // Before this row the replacement started at $0 and $3 more sailed
        // through; now 3 + 3 = 6 > 5 and the cap fires on the turn it should.
        const replacement = instanceForSession(5, () => 3, [pricedComplete(3)]);
        const events = await collectEvents(replacement.chat('after the switch'));

        expect(events.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
        expect((replacement as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(6);
        expect(replacement.forceAbortCalls).toEqual([{ reason: AbortReason.MaxBudgetUsd }]);
        replacement.destroy();
      });

      it('CONTROL: a genuinely fresh session still starts at 0', async () => {
        // The negative of the row is "every session inherits somebody's spend",
        // so the positive has to be pinned on the same rig. A new session has no
        // recorded total, and the same $3 turn against the same $5 ceiling must
        // pass — the row must not turn a fresh session into a pre-charged one.
        for (const [label, recorded] of [
          ['no record at all', undefined],
          ['a record of zero', 0],
        ] as Array<[string, number | undefined]>) {
          const fresh = instanceForSession(5, () => recorded, [pricedComplete(3)]);
          const events = await collectEvents(fresh.chat('hi'));
          expect((events.at(-1) as { terminalReason?: string }).terminalReason, label).toBeUndefined();
          expect((fresh as unknown as { sessionCostUsd: number }).sessionCostUsd, label).toBe(3);
          fresh.destroy();
        }
      });

      it('CONTROL: a junk recorded total is ignored rather than propagated', async () => {
        // The host reads a persisted field. A NaN or a negative must not become
        // the counter's baseline — a NaN baseline would make every later
        // comparison false, which is a cap that silently stops existing.
        for (const [label, recorded] of [
          ['NaN', Number.NaN],
          ['infinite', Number.POSITIVE_INFINITY],
          ['negative', -10],
        ] as Array<[string, number]>) {
          const agent = instanceForSession(5, () => recorded, [pricedComplete(3)]);
          await collectEvents(agent.chat('hi'));
          expect((agent as unknown as { sessionCostUsd: number }).sessionCostUsd, label).toBe(3);
          agent.destroy();
        }
      });

    it('COUNTED ONCE: the session total is a baseline taken once, not a value tracked', async () => {
        // THE trap this row could have shipped, and the first version of this
        // test could not see it. Mirroring the host total exactly after every
        // turn makes an assign-then-add indistinguishable from add-only: both
        // land on 7, so the test passed with the latch REMOVED. A detector that
        // cannot fail is not a detector.
        //
        // What makes it visible is the real asymmetry: `SessionManager`
        // accumulates `tokenUsage.costUsd` in `processEvent`, which runs after
        // the agent's own `+=` for the same event and does not include the turn
        // currently in flight. So the host total LAGS the agent's counter, and a
        // turn with two cost-bearing events is where that lag bites.
        //
        // Truth for an instance resuming at $3 and a turn of $2 + $2: 3 + 2 + 2
        // = 7. Re-hydrating per event assigns the lagging 3 back over the
        // counter between them, so the first $2 is DISCARDED and it lands on 5 —
        // the cap under-counting, i.e. failing open, which is the direction that
        // matters. (A host total that ran ahead instead would over-count by the
        // same mechanism.) Either way the counter stops being the sum of its own
        // increments, which is the invariant the latch protects.
        const hostTotal = 3;
        const agent = instanceForSession(100, () => hostTotal, [
          { type: 'usage_update', usage: { costUsd: 2, costReporting: 'reported' } as never },
          pricedComplete(2),
        ]);

        await collectEvents(agent.chat('one'));

        expect((agent as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(7);
        agent.destroy();
      });

      it('COUNTED ONCE, across turns too: a later turn does not re-take the baseline', async () => {
        // The across-turn half of the same invariant, on a rig where it is
        // decidable: the host total is captured once, at the start, and never
        // advanced — so a second hydration would assign 3 back over a counter
        // already at 5 and the second turn's $2 would land on 5 instead of 7.
        const agent = instanceForSession(100, () => 3, [pricedComplete(2)]);

        await collectEvents(agent.chat('one'));
        expect((agent as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(5);

        agent.scriptedEvents = [pricedComplete(2)];
        await collectEvents(agent.chat('two'));

        expect((agent as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(7);
        agent.destroy();
      });

      it('reads the total lazily, so a cap switched on mid-session sees the spend', async () => {
        // Hydration is inside the cap's own guard. A session that ran uncapped
        // and then had a ceiling configured must start from the money already
        // spent, not from zero — otherwise turning the cap ON grants a fresh
        // allowance, which is the walk-past in yet another shape.
        let cap = 0;
        const agent = instanceForSession(0, () => 4, [pricedComplete(1)]);
        ;(agent as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => cap;

        await collectEvents(agent.chat('uncapped'));
        expect((agent as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(0);

        cap = 5;
        agent.scriptedEvents = [pricedComplete(2)];
        const events = await collectEvents(agent.chat('now capped'));

        // 4 already spent + 2 this turn = 6 > 5.
        expect((agent as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(6);
        expect(events.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
        agent.destroy();
      });

      it('CONTROL: on a runtime with no cost at all the resume is a no-op', async () => {
        // Codex and every unpriced gateway model: the session total is 0 because
        // unpriced turns add `?? 0`, so there is nothing to resume and nothing is
        // invented. The cap remains unenforceable and P2.36's notice is what says
        // so — this row does not manufacture a number to enforce it with.
        const agent = instanceForSession(5, () => 0, [unpricedComplete()]);
        const events = await collectEvents(agent.chat('hi'));

        expect((agent as unknown as { sessionCostUsd: number }).sessionCostUsd).toBe(0);
        expect((events.at(-1) as { terminalReason?: string }).terminalReason).toBeUndefined();
        expect(events.some(event =>
          event.type === 'info' && /cannot be enforced/.test((event as { message: string }).message))).toBe(true);
        agent.destroy();
      });
    });
  });

  describe('Marketplace try-in-chat', () => {
    it('returns neutral non-autosend prompts for marketplace items', () => {
      const service = new MarketplaceService();
      const result = service.tryInChat({
        item: {
          id: 'linear-helper',
          kind: 'skill',
          listKind: 'skills',
          name: 'Linear Helper',
          icon: { kind: 'symbol', name: 'skill' },
          capabilities: ['skill'],
          install: { sourceConfidence: 'missing' },
          raw: {},
        },
        locale: 'en',
      });

      expect(result).toEqual({
        prompt: 'Tell me what you can do with Linear Helper and suggest the first useful task I can try.',
        autoSend: false,
        itemId: 'linear-helper',
        itemName: 'Linear Helper',
        kind: 'skill',
      });
    });
  });
});

/**
 * One trusted DP-bound plugin MCP server. `externalAuthProvider` is NOT a view
 * field — `runtime-pool-servers.ts:306` derives it from
 * `resolvePluginStdioExecutable`, which requires a plugin runtime with a bundle
 * hash, an absolute resolved command, AND the host marker
 * `pluginNodeRuntime.executables.dp.externalAuthProvider === 'dp'`. Shape copied
 * from the verified fixture in `mcp/__tests__/runtime-pool-servers.test.ts:703`.
 */
function makeAgentWithDpBoundServer(mcpPool: McpClientPool): TestAgent {
  const agent = new TestAgent(createMockBackendConfig({
    mcpPool,
    pluginNodeRuntime: {
      command: process.execPath,
      executables: {
        dp: {
          command: process.execPath,
          environment: { DP_AI_MCP_SKIP_LOGIN: 'true' },
          externalAuthProvider: 'dp',
        },
      },
    },
  }));
  agent.setCapabilityTurnRuntime(capabilityRuntime({
    mcpServers: [{
      key: 'plugin#dp-bound',
      wireName: 'dp-bound',
      definition: { type: 'stdio', command: 'dp', args: ['ai', 'mcp', 'dp-bound'] },
      pluginRuntime: {
        rootPath: '/cache/plugin',
        dataPath: '/data/plugin',
        bundleHash: '1'.repeat(64),
        profile: 'generic-plugin-env-v1',
      },
      pluginInstanceId: 'plugin://default',
    }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
  }));
  return agent;
}

function capabilityRuntime(
  view: Partial<CapabilityTurnRuntime['view']> = {},
  materializer: Partial<CapabilityTurnRuntime['materializer']> = {},
): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'test-generation',
      sources: [],
      skills: [],
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
      ...view,
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(resource) {
        return 'absolutePath' in resource ? resource.absolutePath : '/test/plugin-resource';
      },
      async readText() { return ''; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
      ...materializer,
    },
  };
}
