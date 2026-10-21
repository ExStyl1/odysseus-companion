import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SdkAutomationInput } from '../../automations/index.ts';
import {
  DEFAULT_MANAGED_PI_POLICY,
  registerManagedPiPolicyProvider,
  type ManagedPiPolicyV1,
} from '../../agent/pi-harness/managed-policy.ts';
import {
  commandHookPreauthorizedTier,
  type CommandHookRunner,
  type CommandHookSource,
} from '../../plugins/hooks-automation.ts';
import type { CapabilitySnapshotMaterializer } from '../materializer.ts';
import { createCapabilityResolver } from '../resolver.ts';
import { buildPinnedAgentAutomationSystem, resolveVettedPluginHookLock } from '../runtime-automations.ts';
import { recordCodexLocalAutomationRequirement } from '../../config/managed-local-automation.ts';
import { CapabilityTrustStore } from '../trust-store.ts';
import type { NativeCapabilitySourceRecord } from '../types.ts';
import { toAgentRuntime, type AgentRuntimeView } from '../views.ts';

describe('pinned capability automations', () => {
  it('applies the documented decision precedence whether or not a policy is requested (P3.193)', async () => {
    const materializer = {
      assertActive() {},
      async readText() {
        return JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: 'Bash',
              actions: [
                { type: 'decision', decision: 'ask', reason: 'review' },
                { type: 'decision', decision: 'allow' },
              ],
            }],
          },
        });
      },
    } as unknown as CapabilitySnapshotMaterializer;
    const resource = {
      source: 'workspace' as const,
      scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
      resourceId: 'hook:workspace:strict.json',
      absolutePath: '/strict/hooks.json',
      revision: '1',
      contentHash: 'a'.repeat(64),
    };
    const view = {
      generation: 'generation-1',
      sources: [], skills: [], mcpServers: [],
      hooks: [{ key: resource.resourceId, event: 'hooks.json', resource, executableHash: resource.contentHash }],
      automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    } as AgentRuntimeView;
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash' } as SdkAutomationInput;

    // The hooks.json above is `ask` then `allow`. This builder is what
    // `SessionManager` calls, and it asked for `'strict'` only on the Pi arm —
    // so this default path IS what a `claude-runtime` / `codex` session got, and
    // it used to answer `allow`: an earlier hook's permission prompt erased by a
    // later hook's auto-approve. hooks.md#pretooluse-decision-control:
    // "precedence is `deny` > `defer` > `ask` > `allow`."
    const byDefault = await buildPinnedAgentAutomationSystem({ view, materializer }, { workspaceRootPath: '/workspace' });
    expect(await byDefault!.executeAgentEvent('PreToolUse', input)).toMatchObject({
      decision: { decision: 'ask', reason: 'review' },
    });
    // The second rig this test used to build — the same construction plus
    // `decisionMergePolicy: 'strict'` — is GONE with the field (P3.256). With
    // nothing left to differ, it compared an object to a copy of itself: a dead
    // control, which reads as a passing assertion and can never fail. The
    // documented ordering above is now asserted once, on the only path there is.
  });

  it('materializes agent hooks once and fails closed after snapshot revoke', async () => {
    let active = true;
    let reads = 0;
    const materializer = {
      assertActive() {
        if (!active) throw new Error('revoked');
      },
      async readText() {
        reads += 1;
        return JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: 'Bash',
              actions: [{ type: 'decision', decision: 'block', reason: 'pinned hook' }],
            }],
          },
        });
      },
    } as unknown as CapabilitySnapshotMaterializer;
    const resource = {
      source: 'workspace' as const,
      scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
      resourceId: 'hook:workspace:hooks.json',
      absolutePath: '/disposable/hooks.json',
      revision: '1',
      contentHash: 'a'.repeat(64),
    };
    const view: AgentRuntimeView = {
      generation: 'generation-1',
      sources: [], skills: [], mcpServers: [],
      hooks: [{ key: 'hook:workspace:hooks.json', event: 'hooks.json', resource, executableHash: resource.contentHash }],
      automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    };

    const system = await buildPinnedAgentAutomationSystem(
      { view, materializer },
      { workspaceRootPath: '/disposable/workspace' },
    );
    expect(reads).toBe(1);
    const result = await system!.executeAgentEvent('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    } as SdkAutomationInput);
    expect(result).toMatchObject({ matchedCount: 1, decision: { decision: 'block', reason: 'pinned hook' } });

    active = false;
    expect(system!.executeAgentEvent('PreToolUse', {} as SdkAutomationInput)).rejects.toThrow('revoked');
  });

  it('runs a project native hook only under its exact current definition-hash grant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-hook-runtime-'));
    try {
      const projectKey = `p_${'a'.repeat(32)}`;
      const scope = { kind: 'project' as const, workspaceId: 'ws-1', projectKey };
      const hook: NativeCapabilitySourceRecord = {
        key: `hook::project::ws-1::${projectKey}::.nessy-agent/hooks.json`,
        kind: 'hook',
        scope,
        logicalName: '.nessy-agent/hooks.json',
        sourcePath: join(dir, 'project', '.nessy-agent', 'hooks.json'),
        revision: 'r1',
        contentHash: 'a'.repeat(64),
        mutable: true,
      };
      const trustStore = new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') });
      const resolver = createCapabilityResolver({
        inputs: () => ({
          nativeInventory: { records: [hook], blockedLayers: [] },
          installedPlugins: [],
          activePluginInstances: {},
          pluginCandidates: [],
          resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
          resolveTrust: key => trustStore.resolve(key),
        }),
      });
      let reads = 0;
      const materializer = {
        assertActive() {},
        async readText() {
          reads += 1;
          return JSON.stringify({
            hooks: {
              PreToolUse: [{
                matcher: 'Bash',
                actions: [{ type: 'decision', decision: 'block', reason: 'trusted project hook' }],
              }],
            },
          });
        },
      } as unknown as CapabilitySnapshotMaterializer;
      const context = {
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        projectKey,
        projectTrustState: 'trusted' as const,
        projectTrustRevision: 'trust-r1',
      };

      const untrusted = await resolver.resolve(context);
      expect(untrusted.entries[0]?.summary).toMatchObject({ enabled: false, trustState: 'review-required' });
      expect(await buildPinnedAgentAutomationSystem(
        { view: toAgentRuntime(untrusted), materializer },
        { workspaceRootPath: join(dir, 'workspace') },
      )).toBeUndefined();
      resolver.releaseSnapshot(untrusted.leaseId);
      expect(reads).toBe(0);

      trustStore.grant({ capabilityId: hook.key, executableHash: hook.contentHash, scope });
      const trusted = await resolver.resolve(context);
      const system = await buildPinnedAgentAutomationSystem(
        { view: toAgentRuntime(trusted), materializer },
        { workspaceRootPath: join(dir, 'workspace') },
      );
      expect(await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {},
      } as SdkAutomationInput)).toMatchObject({
        matchedCount: 1,
        decision: { decision: 'block', reason: 'trusted project hook' },
      });
      resolver.releaseSnapshot(trusted.leaseId);
      expect(reads).toBe(1);

      hook.contentHash = 'b'.repeat(64);
      hook.revision = 'r2';
      const changed = await resolver.resolve(context);
      expect(changed.entries[0]?.summary).toMatchObject({ enabled: false, trustState: 'review-required' });
      expect(await buildPinnedAgentAutomationSystem(
        { view: toAgentRuntime(changed), materializer },
        { workspaceRootPath: join(dir, 'workspace') },
      )).toBeUndefined();
      resolver.releaseSnapshot(changed.leaseId);
      expect(reads).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries a PermissionRequest band decision through the LIVE runtime path', async () => {
    // CDP pass 3 (2026-07-27): the band consumed
    // `hookSpecificOutput.decision.behavior` but the automation layer below it
    // dropped every non-PreToolUse decision, so a hook `allow` still raised the
    // prompt. Pass 2's lesson — assert the live `buildPinnedAgentAutomationSystem`
    // path, not only `executePluginHookAutomations` in isolation.
    const dir = mkdtempSync(join(tmpdir(), 'band-hook-runtime-'));
    try {
      const pluginInstanceId = `plugin://local/band@1.0.0#${'a'.repeat(64)}`;
      const materializer = {
        assertActive() {},
        async verifyPlugin() {},
      } as unknown as CapabilitySnapshotMaterializer;
      const view: AgentRuntimeView = {
        generation: 'generation-band-hook',
        sources: [], skills: [], mcpServers: [], automations: [], agents: [],
        promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
        hooks: [{
          key: 'plugin-band-hook',
          event: 'PermissionRequest',
          type: 'command',
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }))')}`,
          resource: { pluginInstanceId, relativePath: 'hooks/band.js', contentHash: 'a'.repeat(64) },
          executableHash: 'b'.repeat(64),
          pluginInstanceId,
        }],
      };

      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer },
        { workspaceRootPath: dir, allowDirectCommandRunner: true },
      );
      expect(await system!.executeAgentEvent('PermissionRequest', {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      } as SdkAutomationInput)).toMatchObject({
        matchedCount: 1,
        decision: { decision: 'allow' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('re-verifies an immutable plugin immediately before a hook process starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-hook-runtime-'));
    const marker = join(dir, 'hook-ran');
    let verifications = 0;
    let stale = false;
    const pluginInstanceId = `plugin://local/hooks@1.0.0#${'a'.repeat(64)}`;
    const materializer = {
      assertActive() {},
      async verifyPlugin(instanceId: string) {
        expect(instanceId).toBe(pluginInstanceId);
        verifications += 1;
        if (stale) throw new Error('capability-snapshot-stale');
      },
    } as unknown as CapabilitySnapshotMaterializer;
    const view: AgentRuntimeView = {
      generation: 'generation-plugin-hook',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [{
        key: 'plugin-hook',
        event: 'PreToolUse',
        type: 'command',
        matcher: 'Bash',
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}`,
        resource: { pluginInstanceId, relativePath: 'hooks/pre-tool.js', contentHash: 'a'.repeat(64) },
        executableHash: 'b'.repeat(64),
        pluginInstanceId,
        pluginRuntime: {
          rootPath: dir,
          dataPath: join(dir, 'data'),
          profile: 'generic-plugin-env-v1' as const,
        },
      }],
    };

    try {
      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer },
        { workspaceRootPath: dir },
      );
      expect(verifications).toBe(1);
      stale = true;
      await expect(system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {},
      } as SdkAutomationInput)).rejects.toThrow('capability-snapshot-stale');
      expect(verifications).toBe(2);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes plugin, project, and native workspace command hooks through the injected supervised runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervised-hook-runtime-'));
    const marker = join(dir, 'native-hook-ran');
    try {
      const pluginInstanceId = `plugin://local/hooks@1.0.0#${'a'.repeat(64)}`;
      const projectResource = {
        source: 'project' as const,
        scope: { kind: 'project' as const, workspaceId: 'ws-1', projectKey: `p_${'a'.repeat(32)}` },
        resourceId: 'hook:project:hooks.json',
        absolutePath: join(dir, 'project', '.nessy-agent', 'hooks.json'),
        revision: 'r1',
        contentHash: 'a'.repeat(64),
      };
      const workspaceResource = {
        source: 'workspace' as const,
        scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
        resourceId: 'hook:workspace:hooks.json',
        absolutePath: join(dir, 'workspace', '.nessy-agent', 'hooks.json'),
        revision: 'r1',
        contentHash: 'b'.repeat(64),
      };
      const materializer = {
        assertActive() {},
        async verifyPlugin() {},
        async readText(resource: { resourceId: string }) {
          if (resource.resourceId === projectResource.resourceId) {
            return JSON.stringify({
              hooks: { PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: 'project-hook-cmd' }] }] },
            });
          }
          return JSON.stringify({
            hooks: {
              PreToolUse: [{
                matcher: 'Bash',
                actions: [{ type: 'command', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}` }],
              }],
            },
          });
        },
      } as unknown as CapabilitySnapshotMaterializer;
      const view: AgentRuntimeView = {
        generation: 'generation-supervised-hook',
        sources: [], skills: [], mcpServers: [], automations: [], agents: [],
        promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
        hooks: [
          { key: 'workspace-hook', event: 'hooks.json', resource: workspaceResource, executableHash: workspaceResource.contentHash },
          { key: 'project-hook', event: 'hooks.json', resource: projectResource, executableHash: projectResource.contentHash },
          {
            key: 'plugin-hook',
            event: 'PreToolUse',
            type: 'command',
            matcher: 'Bash',
            command: 'plugin-hook-cmd',
            resource: { pluginInstanceId, relativePath: 'hooks/pre-tool.js', contentHash: 'a'.repeat(64) },
            executableHash: 'c'.repeat(64),
            pluginInstanceId,
            pluginRuntime: { rootPath: dir, dataPath: join(dir, 'data'), profile: 'generic-plugin-env-v1' as const },
          },
        ],
      };

      const supervisedCommands: Array<{ command: string; pluginDataPath?: string }> = [];
      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer },
        {
          workspaceRootPath: dir,
          pluginCommandHookRunner: async (action, options) => {
            supervisedCommands.push({
              command: action.command,
              ...(options.pluginDataPath ? { pluginDataPath: options.pluginDataPath } : {}),
            });
            return { type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 0 };
          },
        },
      );
      await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {},
      } as SdkAutomationInput);

      // Every effectful command hook executes through the injected supervised runner.
      expect(supervisedCommands.sort((a, b) => a.command.localeCompare(b.command))).toEqual([
        { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}` },
        { command: 'plugin-hook-cmd', pluginDataPath: join(dir, 'data') },
        { command: 'project-hook-cmd' },
      ]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the imported two-mode matcher and exit-code semantics to plugin hooks only, on the live runtime path', async () => {
    // `buildPinnedAgentAutomationSystem` is the path a real session uses, and it
    // builds plugin matchers/actions itself. Both opt-ins must be live here.
    // (It used to be worth saying "rather than through
    // `buildTrustedPluginHookAutomations`"; F4 deleted that second builder.)
    const dir = mkdtempSync(join(tmpdir(), 'plugin-matchmode-runtime-'));
    const pluginInstanceId = `plugin://internal/toolkit@1.0.0#${'a'.repeat(64)}`;
    const nativeResource = {
      source: 'workspace' as const,
      scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
      resourceId: 'hook:workspace:native.json',
      absolutePath: join(dir, 'hooks.json'),
      revision: '1',
      contentHash: 'b'.repeat(64),
    };
    const materializer = {
      assertActive() {},
      async verifyPlugin() {},
      async readText() {
        return JSON.stringify({
          hooks: { PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: 'native-cmd' }] }] },
        });
      },
    } as unknown as CapabilitySnapshotMaterializer;
    const view: AgentRuntimeView = {
      generation: 'generation-plugin-matchmode',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [
        { key: 'native-hook', event: 'hooks.json', resource: nativeResource, executableHash: nativeResource.contentHash },
        {
          key: 'plugin-hook',
          event: 'PreToolUse',
          type: 'command' as const,
          matcher: 'Bash',
          command: 'plugin-cmd',
          // hooks.md's 0/2/other contract is a CLAUDE format identity, stamped
          // by the Claude adapter. Without it an imported hook keeps the native
          // any-non-zero contract — see the Codex-format hook below.
          exitCodeContract: 'claude-three-way' as const,
          resource: { pluginInstanceId, relativePath: 'hooks/pre-tool.js', contentHash: 'a'.repeat(64) },
          executableHash: 'c'.repeat(64),
          pluginInstanceId,
          pluginRuntime: { rootPath: dir, dataPath: join(dir, 'data'), profile: 'generic-plugin-env-v1' as const },
        },
        {
          key: 'codex-hook',
          event: 'PreToolUse',
          type: 'command' as const,
          matcher: 'Bash',
          command: 'codex-cmd',
          resource: { pluginInstanceId, relativePath: 'hooks/codex.js', contentHash: 'b'.repeat(64) },
          executableHash: 'd'.repeat(64),
          pluginInstanceId,
          pluginRuntime: { rootPath: dir, dataPath: join(dir, 'data'), profile: 'generic-plugin-env-v1' as const },
        },
      ],
    };

    try {
      const ran: string[] = [];
      const exits = new Map<string, number>();
      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer },
        {
          workspaceRootPath: dir,
          pluginCommandHookRunner: async action => {
            ran.push(action.command);
            const exitCode = exits.get(action.command) ?? 0;
            return {
              type: 'command', command: action.command, success: exitCode === 0,
              exitCode, signal: null, durationMs: 0,
              ...(exitCode === 0 ? {} : { stderr: `exit ${exitCode}`, output: `exit ${exitCode}` }),
            };
          },
        },
      );

      // `Bash` is an exact name for the imported hook, so BashOutput must not
      // fire it. The stored native automation keeps substring matching.
      await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'BashOutput', tool_input: {},
      } as SdkAutomationInput);
      expect(ran).toEqual(['native-cmd']);

      // Exit 1 from a CLAUDE-format hook is a non-blocking diagnostic — but it
      // is reported, not swallowed (hooks.md § Exit code output). Exit 2 blocks
      // with stderr. The native hook still blocks on any non-zero exit.
      ran.length = 0;
      exits.set('plugin-cmd', 1);
      const nonBlocking = await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {},
      } as SdkAutomationInput);
      expect(ran).toContain('plugin-cmd');
      expect(nonBlocking.decision).toBeUndefined();
      expect(nonBlocking.hookErrors?.map(notice => notice.summary)).toEqual(['exit 1']);

      exits.set('plugin-cmd', 2);
      const blocking = await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {},
      } as SdkAutomationInput);
      expect(blocking.decision).toMatchObject({ decision: 'block' });

      // A hook with no format identity (Codex, native `nessy-plugin.json`) is
      // NOT on Claude's three-way contract: exit 1 blocks the way its author
      // intended. This is the half that regressed when every imported hook was
      // opted in unconditionally.
      exits.delete('plugin-cmd');
      exits.set('codex-cmd', 1);
      const codexBlocking = await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {},
      } as SdkAutomationInput);
      expect(codexBlocking.decision).toMatchObject({ decision: 'block' });

      exits.delete('codex-cmd');
      exits.set('native-cmd', 1);
      const nativeBlocking = await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {},
      } as SdkAutomationInput);
      expect(nativeBlocking.decision).toMatchObject({ decision: 'block' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gates an if-filtered plugin hook per invocation on the live runtime path', async () => {
    // CDP pass 2 (2026-07-26) caught this live: `ifRule` reached
    // RuntimeHookRegistration but this path never read it, so both if-filtered
    // hooks fired on every tool call. The projection-path tests stayed green
    // while live was broken — pin the behaviour on THIS path.
    const dir = mkdtempSync(join(tmpdir(), 'if-filter-runtime-'));
    const pluginInstanceId = `plugin://internal/if-filter@1.0.0#${'a'.repeat(64)}`;
    const hook = (key: string, ifRule: string, command: string) => ({
      key,
      event: 'PreToolUse',
      type: 'command' as const,
      matcher: 'Bash',
      ifRule,
      command,
      resource: { pluginInstanceId, relativePath: `hooks/${command}.js`, contentHash: 'a'.repeat(64) },
      executableHash: 'b'.repeat(64),
      pluginInstanceId,
      pluginRuntime: { rootPath: dir, dataPath: join(dir, 'data'), profile: 'generic-plugin-env-v1' as const },
    });
    const view: AgentRuntimeView = {
      generation: 'generation-if-filter',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [
        hook('ls-hook', 'Bash(ls *)', 'ls-cmd'),
        hook('git-hook', 'Bash(git status)', 'git-cmd'),
      ],
    };

    try {
      const ran: string[] = [];
      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer: { assertActive() {}, async verifyPlugin() {} } as unknown as CapabilitySnapshotMaterializer },
        {
          workspaceRootPath: dir,
          pluginCommandHookRunner: async action => {
            ran.push(action.command);
            return { type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 0 };
          },
        },
      );

      // `git status` must fire only the git hook, `ls -la` only the ls hook.
      await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' },
      } as SdkAutomationInput);
      expect(ran).toEqual(['git-cmd']);

      ran.length = 0;
      await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' },
      } as SdkAutomationInput);
      expect(ran).toEqual(['ls-cmd']);

      // Any-subcommand: a compound command fires every hook whose rule matches
      // one of its subcommands (hooks.md: subcommands are checked).
      ran.length = 0;
      await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status && ls -la' },
      } as SdkAutomationInput);
      expect(ran.sort()).toEqual(['git-cmd', 'ls-cmd']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails open on an unparseable if filter on the live runtime path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'if-unparseable-runtime-'));
    const pluginInstanceId = `plugin://internal/if-filter@1.0.0#${'a'.repeat(64)}`;
    const view: AgentRuntimeView = {
      generation: 'generation-if-unparseable',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [{
        key: 'unparseable-hook',
        event: 'PreToolUse',
        type: 'command' as const,
        matcher: 'Bash',
        ifRule: 'not a rule ((((',
        command: 'unparseable-cmd',
        resource: { pluginInstanceId, relativePath: 'hooks/u.js', contentHash: 'a'.repeat(64) },
        executableHash: 'b'.repeat(64),
        pluginInstanceId,
        pluginRuntime: { rootPath: dir, dataPath: join(dir, 'data'), profile: 'generic-plugin-env-v1' as const },
      }],
    };

    try {
      const ran: string[] = [];
      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer: { assertActive() {}, async verifyPlugin() {} } as unknown as CapabilitySnapshotMaterializer },
        {
          workspaceRootPath: dir,
          pluginCommandHookRunner: async action => {
            ran.push(action.command);
            return { type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 0 };
          },
        },
      );
      await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'anything at all' },
      } as SdkAutomationInput);
      // hooks.md: the filter "fails open, running your hook regardless of
      // pattern, when the Bash command can't be parsed" — same for the rule.
      expect(ran).toEqual(['unparseable-cmd']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops an if-filtered hook on a non-tool event on the live runtime path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'if-non-tool-runtime-'));
    const pluginInstanceId = `plugin://internal/if-filter@1.0.0#${'a'.repeat(64)}`;
    const view: AgentRuntimeView = {
      generation: 'generation-if-non-tool',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [{
        key: 'session-start-if-hook',
        event: 'SessionStart',
        type: 'command' as const,
        ifRule: 'Bash(ls *)',
        command: 'session-cmd',
        resource: { pluginInstanceId, relativePath: 'hooks/s.js', contentHash: 'a'.repeat(64) },
        executableHash: 'b'.repeat(64),
        pluginInstanceId,
        pluginRuntime: { rootPath: dir, dataPath: join(dir, 'data'), profile: 'generic-plugin-env-v1' as const },
      }],
    };

    try {
      const ran: string[] = [];
      // hooks.md: on non-tool events "a hook with `if` set never runs" — the
      // registration must not produce an action at all, so the only hook in the
      // view yields no automation system.
      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer: { assertActive() {}, async verifyPlugin() {} } as unknown as CapabilitySnapshotMaterializer },
        {
          workspaceRootPath: dir,
          pluginCommandHookRunner: async action => {
            ran.push(action.command);
            return { type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 0 };
          },
        },
      );
      expect(system).toBeUndefined();
      expect(ran).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('consumes Claude-style Honey command output for session, subagent, and post-tool hooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'honey-hook-runtime-'));
    const pluginInstanceId = `plugin://greenpt/honey@1.1.0#${'a'.repeat(64)}`;
    const hook = (event: 'SessionStart' | 'SubagentStart' | 'PostToolUse', command: string, matcher?: string) => ({
      key: `honey-${event}`,
      event,
      type: 'command' as const,
      ...(matcher ? { matcher } : {}),
      command,
      resource: { pluginInstanceId, relativePath: `hooks/${command}.js`, contentHash: 'a'.repeat(64) },
      executableHash: 'b'.repeat(64),
      pluginInstanceId,
      pluginRuntime: { rootPath: dir, dataPath: join(dir, 'data'), profile: 'codex-plugin-env-v1' as const },
    });
    const view: AgentRuntimeView = {
      generation: 'generation-honey-hook',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [
        hook('SessionStart', 'session'),
        hook('SubagentStart', 'subagent'),
        hook('PostToolUse', 'post-tool', 'Bash'),
      ],
    };
    const seenInputs: SdkAutomationInput[] = [];
    // Verbatim shapes of the installed plugin's hooks (greenpt/honey 1.0.0
    // `hooks/honey-session.js`, `hooks/logcompress-hook.js`): a bare
    // `hookSpecificOutput`, no `continue` field. An earlier fixture added
    // `continue: false` here, which is a documented HARD STOP
    // ("takes precedence over any event-specific decision field") and never
    // something Honey emits — R9's per-event contract would honour it, so the
    // fixture is corrected to the real output and the precedence is pinned
    // separately below.
    const outputs: Record<string, string> = {
      session: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'session context' } }),
      subagent: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'worker context' } }),
      'post-tool': JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'compressed output' } }),
    };

    try {
      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer: { assertActive() {}, async verifyPlugin() {} } as unknown as CapabilitySnapshotMaterializer },
        {
          workspaceRootPath: dir,
          pluginCommandHookRunner: async (action, options) => {
            seenInputs.push(options.input);
            // Honey's real hook exits silently unless the Claude-compatible
            // tool name is exactly "Bash". Pi emits the canonical "bash".
            const stdout = action.command === 'post-tool' && options.input.tool_name !== 'Bash'
              ? ''
              : outputs[action.command];
            return {
              type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 0,
              stdout,
            };
          },
        },
      );

      expect((await system!.executeAgentEvent('SessionStart', { hook_event_name: 'SessionStart' })).decision)
        .toEqual({ additionalContext: 'session context' });
      expect(await system!.executeAgentEvent('SubagentStart', {
        hook_event_name: 'SubagentStart', agent_type: 'worker',
      })).toMatchObject({ decision: { additionalContext: 'worker context' } });
      expect((await system!.executeAgentEvent('PostToolUse', {
        hook_event_name: 'PostToolUse', tool_name: 'bash', tool_response: 'long output',
      })).decision).toEqual({ updatedToolOutput: 'compressed output' });
      expect(seenInputs).toContainEqual({
        hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'long output',
      });
      expect(seenInputs).toContainEqual({ hook_event_name: 'SubagentStart', agent_type: 'worker' });

      const sdkHooks = system!.buildSdkHooks!();
      const sdkResult = await sdkHooks.PostToolUse![0]!.hooks[0]!({
        hook_event_name: 'PostToolUse', tool_name: 'bash', tool_response: 'long output',
      }, 'tool-1', {});
      expect(sdkResult).toMatchObject({
        continue: true,
        hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'compressed output' },
      });

      // Precedence pin: `continue: false` from the same hook is a stop, and it
      // wins over the event-specific `updatedToolOutput` it ships with.
      outputs['post-tool'] = JSON.stringify({
        continue: false,
        hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'compressed output' },
      });
      expect((await system!.executeAgentEvent('PostToolUse', {
        hook_event_name: 'PostToolUse', tool_name: 'bash', tool_response: 'long output',
      })).decision).toMatchObject({ decision: 'block' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * `plugins/manifest-reference.md#environment-variables` — "All values are exported to hook processes as
   * `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables, where `<KEY>` is the
   * option key uppercased."
   *
   * Declared is not enforced, so this asserts a REAL subprocess on the live
   * `buildPinnedAgentAutomationSystem` path — the one a Pi turn takes — reading
   * the variables out of its own environment and writing them back.
   */
  it('exports CLAUDE_PLUGIN_OPTION_<KEY> into a real plugin hook process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-option-env-'));
    const marker = join(dir, 'options.json');
    try {
      const pluginInstanceId = `plugin://local/options@1.0.0#${'a'.repeat(64)}`;
      const materializer = {
        assertActive() {},
        async verifyPlugin() {},
      } as unknown as CapabilitySnapshotMaterializer;
      const script = 'require("node:fs").writeFileSync('
        + `${JSON.stringify(marker)}, JSON.stringify({`
        + ' endpoint: process.env.CLAUDE_PLUGIN_OPTION_API_ENDPOINT,'
        + ' token: process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN,'
        + ' extras: process.env.CLAUDE_PLUGIN_OPTION_EXTRA_PATHS,'
        + ' root: process.env.NESSY_PLUGIN_ROOT }))';
      const view: AgentRuntimeView = {
        generation: 'generation-option-env',
        sources: [], skills: [], mcpServers: [], automations: [], agents: [],
        promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
        hooks: [{
          key: 'plugin-option-hook',
          event: 'PreToolUse',
          type: 'command',
          matcher: 'Bash',
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          resource: { pluginInstanceId, relativePath: 'hooks/pre-tool.js', contentHash: 'a'.repeat(64) },
          executableHash: 'b'.repeat(64),
          pluginInstanceId,
          pluginRuntime: {
            rootPath: dir,
            dataPath: join(dir, 'data'),
            profile: 'claude-plugin-env-v1' as const,
          },
          optionEnvironment: {
            CLAUDE_PLUGIN_OPTION_API_ENDPOINT: 'https://internal.example/api',
            CLAUDE_PLUGIN_OPTION_API_TOKEN: 'SENSITIVE_OPTION_CANARY',
            CLAUDE_PLUGIN_OPTION_EXTRA_PATHS: '["a","b"]',
          },
        }],
      };

      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer },
        { workspaceRootPath: dir, allowDirectCommandRunner: true },
      );
      const result = await system!.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      } as SdkAutomationInput);

      expect(result).toMatchObject({ matchedCount: 1 });
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
        endpoint: 'https://internal.example/api',
        // `:583` names this variable as the alternative for the shell-form case,
        // which only works if a sensitive value is exported too.
        token: 'SENSITIVE_OPTION_CANARY',
        // A `multiple` option is one JSON string; a hook parses it back.
        extras: '["a","b"]',
        // The plugin path aliases are untouched by the option export.
        root: dir,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
  it('runs a Codex plugin SessionEnd hook on the Codex budget, not Claude\'s', async () => {
    // Codex `hooks.md` § Notes, `timeout`: "`SessionEnd` uses `1` second by
    // default and supports up to `3` seconds." Claude `hooks.md`: "`SessionEnd`
    // hooks share a 1.5-second budget" and "Timeouts set on plugin-provided
    // hooks don't raise the budget." We applied Claude's number to both, so an
    // imported Codex cleanup hook that asked for 3 s was killed at 1.5 s. The
    // budget the injected runner receives IS the one the hook process gets.
    const dir = mkdtempSync(join(tmpdir(), 'codex-session-end-budget-'));
    const seen: Record<string, number | undefined> = {};
    const hook = (key: string, profile: 'codex-plugin-env-v1' | 'claude-plugin-env-v1', timeoutMs?: number) => {
      const pluginInstanceId = `plugin://local/${key}@1.0.0#${'a'.repeat(64)}`;
      return {
        key,
        event: 'SessionEnd',
        type: 'command' as const,
        command: key,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        resource: { pluginInstanceId, relativePath: `hooks/${key}.js`, contentHash: 'a'.repeat(64) },
        executableHash: 'b'.repeat(64),
        pluginInstanceId,
        pluginRuntime: { rootPath: dir, dataPath: join(dir, 'data'), profile },
      };
    };
    const view: AgentRuntimeView = {
      generation: 'generation-codex-session-end',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [
        hook('codex-declared', 'codex-plugin-env-v1', 3_000),
        hook('codex-over', 'codex-plugin-env-v1', 300_000),
        hook('codex-default', 'codex-plugin-env-v1'),
        hook('claude-declared', 'claude-plugin-env-v1', 3_000),
      ],
    };

    try {
      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer: { assertActive() {}, async verifyPlugin() {} } as unknown as CapabilitySnapshotMaterializer },
        {
          workspaceRootPath: dir,
          pluginCommandHookRunner: async (action) => {
            seen[action.command] = action.timeoutMs;
            return {
              type: 'command', command: action.command, success: true,
              exitCode: 0, signal: null, durationMs: 0, stdout: '',
            };
          },
        },
      );
      await system!.executeAgentEvent('SessionEnd', { hook_event_name: 'SessionEnd' });

      expect(seen['codex-declared']).toBe(3_000);
      expect(seen['codex-over']).toBe(3_000);
      expect(seen['codex-default']).toBe(1_000);
      // Claude's budget must not move.
      expect(seen['claude-declared']).toBe(1_500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `settings-reference.md#allowmanagedhooksonly` — Scope `Managed`, and
 * "`true`: only managed hooks run, plus Agent SDK hooks and hooks from plugins
 * your managed settings force-enable."
 * `settings-reference.md#what-runs-under-allowmanagedhooksonly` —
 * "**Everything else is blocked**: user, project, and local hooks, hooks from
 * other plugins, and hooks declared in agent frontmatter."
 */
describe('allowManagedHooksOnly', () => {
  const HOOK_FILE = JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        actions: [{ type: 'decision', decision: 'block', reason: 'user hook' }],
      }],
    },
  });

  function nativeView(scopeKind: 'workspace' | 'project' | 'global'): AgentRuntimeView {
    const resource = {
      source: 'workspace' as const,
      scope: { kind: scopeKind, workspaceId: 'ws-1' },
      resourceId: `hook:${scopeKind}:hooks.json`,
      absolutePath: `/${scopeKind}/hooks.json`,
      revision: '1',
      contentHash: 'a'.repeat(64),
    };
    return {
      generation: 'generation-1',
      sources: [], skills: [], mcpServers: [],
      hooks: [{ key: resource.resourceId, event: 'hooks.json', resource, executableHash: resource.contentHash }],
      automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    } as unknown as AgentRuntimeView;
  }

  const materializer = {
    assertActive() {},
    async readText() { return HOOK_FILE; },
  } as unknown as CapabilitySnapshotMaterializer;

  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash' } as SdkAutomationInput;

  it('without the lock, a user hook still fires', async () => {
    const system = await buildPinnedAgentAutomationSystem(
      { view: nativeView('workspace'), materializer },
      { workspaceRootPath: '/workspace' },
    );
    expect(await system!.executeAgentEvent('PreToolUse', input))
      .toMatchObject({ decision: { decision: 'block' } });
  });

  it('with the lock, user and project hook tiers are dropped whole', async () => {
    for (const scope of ['workspace', 'project', 'global'] as const) {
      const system = await buildPinnedAgentAutomationSystem(
        { view: nativeView(scope), materializer },
        {
          workspaceRootPath: '/workspace',
          managedHookLock: { enabled: true, pluginHooksVetted: false },
        },
      );
      // No tier survives, so there is no automation system at all — the lock
      // drops the buckets before anything can be merged.
      expect(system).toBeUndefined();
    }
  });

  it('a vetted plugin allowlist does not resurrect the user tier', async () => {
    // `:607` — "User hooks, project hooks, and all other plugin hooks are
    // blocked." The plugin carve-out is about PLUGIN hooks only.
    const system = await buildPinnedAgentAutomationSystem(
      { view: nativeView('workspace'), materializer },
      {
        workspaceRootPath: '/workspace',
        managedHookLock: { enabled: true, pluginHooksVetted: true },
      },
    );
    expect(system).toBeUndefined();
  });
})

/**
 * P6.5 — the caller's half of the vetted-plugin carve-out.
 *
 * `settings-reference.md#what-runs-under-allowmanagedhooksonly`:
 * "**Force-enabled plugin hooks run**: hooks from plugins your managed settings
 * force-enable through `enabledPlugins`". The lock's `pluginHooksVetted` flag
 * decides whether that carve-out applies, and the defect was in what the caller
 * accepted as PROOF that the upstream per-plugin filter had run: a
 * `provider === 'pi'` check that P2.314 had already made false.
 */
describe('resolveVettedPluginHookLock', () => {
  const FORCE_ENABLED: ManagedPiPolicyV1 = Object.freeze({
    ...DEFAULT_MANAGED_PI_POLICY,
    // P3.243 — the carve-out belongs to `allowManagedHooksOnly` and to nothing
    // else, so the fixture carries the key. Without it this policy engages the
    // OTHER lock only (`strictPluginOnlyCustomization: ['hooks']`), whose
    // per-plugin narrowing never runs, and the predicate must answer `false`
    // there — see the `keeps the carve-out to its own lock` case below.
    allowManagedHooksOnly: true,
    // Keyed the way THIS FORK stores it: `pluginKeyFor()`'s base64url pair,
    // which is also what `resolveManagedPluginActivation` is asked about
    // upstream. Since P3.244 the documented `plugin-name@marketplace-name`
    // spelling parses too and NORMALIZES to exactly this string, so the two are
    // the same key rather than two vocabularies — the stored spelling is used
    // here because that is what the reading side sees.
    enabledPlugins: Object.freeze({ 'YWNtZQ.c2VjdXJpdHktZ3VhcmQ': true }),
  });

  it('holds the carve-out open on a claude-runtime turn, not only on Pi', () => {
    // The regression this row names: before P6.5 this answered `false`, so an
    // administrator's vetted hooks were blocked on the runtime the carve-out was
    // written for — the same policy, two different hook sets across a switch.
    expect(resolveVettedPluginHookLock(FORCE_ENABLED, 'anthropic')).toBe(true);
    expect(resolveVettedPluginHookLock(FORCE_ENABLED, 'codex-runtime')).toBe(true);
    expect(resolveVettedPluginHookLock(FORCE_ENABLED, 'pi')).toBe(true);
  });

  it('fails closed when the turn carried no provider', () => {
    // A provider-neutral browse resolve never ran `storage-runtime.ts`'s
    // `pluginCandidates` filter, so nothing narrowed the plugin tier and the
    // lock must not trust it. This is the conjunct that has to survive: it is
    // the whole reason the flag is not just `areVettedPluginHooksAllowed`.
    expect(resolveVettedPluginHookLock(FORCE_ENABLED, undefined)).toBe(false);
  });

  it('stays closed with no force-enabled set, on every provider', () => {
    for (const provider of ['pi', 'anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      expect(resolveVettedPluginHookLock({ ...DEFAULT_MANAGED_PI_POLICY, allowManagedHooksOnly: true }, provider))
        .toBe(false);
    }
  });

  it('keeps the carve-out to its own lock (P3.243)', () => {
    // `storage-runtime.ts`'s per-plugin narrowing is gated on
    // `isManagedHooksOnly` alone, so under the strict-plugin-only spelling of
    // the lock it does not run and this proof must not claim it did.
    const strictOnly: ManagedPiPolicyV1 = {
      ...DEFAULT_MANAGED_PI_POLICY,
      strictPluginOnlyCustomization: ['hooks'],
      enabledPlugins: FORCE_ENABLED.enabledPlugins!,
    };
    expect(resolveVettedPluginHookLock(strictOnly, 'pi')).toBe(false);
  });
});

/**
 * `hooks.md:612` — "To temporarily disable all hooks without removing them, set
 * `"disableAllHooks": true` in your settings file." `:614` — "Only
 * `disableAllHooks` set at the managed settings level can disable managed
 * hooks."
 */
describe('disableAllHooks', () => {
  const DISABLED_HOOK_FILE = JSON.stringify({
    disableAllHooks: true,
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        actions: [{ type: 'decision', decision: 'block', reason: 'user hook' }],
      }],
    },
  });

  const nativeResource = {
    source: 'workspace' as const,
    scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
    resourceId: 'hook:workspace:hooks.json',
    absolutePath: '/workspace/hooks.json',
    revision: '1',
    contentHash: 'a'.repeat(64),
  };
  const pluginInstanceId = `plugin://local/vetted@1.0.0#${'a'.repeat(64)}`;
  const pluginHookRegistration = {
    key: 'plugin-vetted-hook',
    event: 'PreToolUse',
    type: 'prompt' as const,
    prompt: 'managed-distributed guidance',
    resource: { pluginInstanceId, relativePath: 'hooks/vetted.js', contentHash: 'b'.repeat(64) },
    executableHash: 'b'.repeat(64),
    pluginInstanceId,
  };

  function mixedView(): AgentRuntimeView {
    return {
      generation: 'generation-disable',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [
        { key: nativeResource.resourceId, event: 'hooks.json', resource: nativeResource, executableHash: nativeResource.contentHash },
        pluginHookRegistration,
      ],
    } as unknown as AgentRuntimeView;
  }

  const materializer = {
    assertActive() {},
    async verifyPlugin() {},
    async readText() { return DISABLED_HOOK_FILE; },
  } as unknown as CapabilitySnapshotMaterializer;

  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash' } as SdkAutomationInput;

  it('the user-level flag silences user and user-installed plugin hooks', async () => {
    // No managed lock: the plugin tier is user-installed, so the settings-file
    // switch reaches all of it and nothing is left to RUN.
    //
    // P2.496 moved what "nothing left" is ANSWERED with, and the pin moves with
    // the meaning rather than being deleted. This used to be `undefined`, which
    // is also how the builder says "no hooks were configured" — so the
    // registration site could not tell a user who turned hooks off from a
    // workspace that never had any, and the switch reached nothing the host
    // registers itself. The answer now carries that one bit and is inert in
    // every other direction, which is what the three assertions below say.
    const system = await buildPinnedAgentAutomationSystem(
      { view: mixedView(), materializer },
      { workspaceRootPath: '/workspace' },
    );
    expect(system).toBeDefined();
    expect(system!.userTierDisableAllHooks).toBe(true);
    // The part this test was written for is unchanged: nothing runs.
    expect((await system!.executeAgentEvent('PreToolUse', input)).matchedCount).toBe(0);
  });

  it('the user-level flag does not silence managed-distributed plugin hooks', async () => {
    // Lock engaged and vetted: the surviving plugin hooks are the managed
    // force-enabled set, which only the MANAGED level of the key may disable.
    const system = await buildPinnedAgentAutomationSystem(
      { view: mixedView(), materializer },
      {
        workspaceRootPath: '/workspace',
        managedHookLock: { enabled: true, pluginHooksVetted: true },
      },
    );
    expect(await system!.executeAgentEvent('PreToolUse', input)).toMatchObject({
      matchedCount: 1,
      decision: { additionalContext: 'managed-distributed guidance' },
    });
  });

  it('the managed-level flag silences everything, managed hooks included', async () => {
    const system = await buildPinnedAgentAutomationSystem(
      { view: mixedView(), materializer },
      {
        workspaceRootPath: '/workspace',
        managedDisableAllHooks: true,
        managedHookLock: { enabled: true, pluginHooksVetted: true },
      },
    );
    expect(system).toBeUndefined();
  });

  it('omission changes nothing: the same view without the flag still builds', async () => {
    const enabledMaterializer = {
      assertActive() {},
      async verifyPlugin() {},
      async readText() {
        return JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: 'Bash',
              actions: [{ type: 'decision', decision: 'block', reason: 'user hook' }],
            }],
          },
        });
      },
    } as unknown as CapabilitySnapshotMaterializer;
    const system = await buildPinnedAgentAutomationSystem(
      { view: mixedView(), materializer: enabledMaterializer },
      { workspaceRootPath: '/workspace' },
    );
    expect(await system!.executeAgentEvent('PreToolUse', input)).toMatchObject({
      matchedCount: 2,
      decision: { decision: 'block' },
    });
  });
})

/**
 * P2.206 — the managed hook kill switch, wired to the policy instead of to an
 * option nobody passed.
 *
 * Measured on the parent commit: `buildPinnedAgentAutomationSystem` has exactly
 * one production caller (`SessionManager.buildAgentAutomationSystem`), that
 * caller passes `managedHookLock` and never `managedDisableAllHooks`, and the
 * only setter of the option repo-wide was the test three blocks up. So an
 * administrator who set `disableAllHooks` in a managed policy silenced nothing
 * on any provider — the key's only other reader is `storage-runtime.ts`'s
 * plugin-candidate filter, behind `isPiCapabilityTurn` and scoped to plugin hook
 * candidates.
 *
 * The neighbour, checked the same way because "a dead switch beside live ones is
 * how this one survived": `allowPluginHooks` (`areManagedPluginHooksAllowed`)
 * had the same single Pi-gated reader, so the plugin-hook kill switch admitted
 * every plugin hook on claude, codex and nestor-cloud.
 */
describe('P2.206 · the managed policy floor reaches the hook builder', () => {
  const ENABLED_HOOK_FILE = JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        actions: [{ type: 'decision', decision: 'block', reason: 'user hook' }],
      }],
    },
  });

  const nativeResource = {
    source: 'workspace' as const,
    scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
    resourceId: 'hook:workspace:p2206.json',
    absolutePath: '/workspace/p2206.json',
    revision: '1',
    contentHash: 'c'.repeat(64),
  };
  const pluginInstanceId = `plugin://local/floor@1.0.0#${'d'.repeat(64)}`;
  const pluginHook = {
    key: 'plugin-floor-hook',
    event: 'PreToolUse',
    type: 'prompt' as const,
    prompt: 'plugin guidance',
    resource: { pluginInstanceId, relativePath: 'hooks/floor.js', contentHash: 'd'.repeat(64) },
    executableHash: 'd'.repeat(64),
    pluginInstanceId,
  };

  function mixedView(): AgentRuntimeView {
    return {
      generation: 'generation-p2206',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [
        { key: nativeResource.resourceId, event: 'hooks.json', resource: nativeResource, executableHash: nativeResource.contentHash },
        pluginHook,
      ],
    } as unknown as AgentRuntimeView;
  }

  const materializer = {
    assertActive() {},
    async verifyPlugin() {},
    async readText() { return ENABLED_HOOK_FILE; },
  } as unknown as CapabilitySnapshotMaterializer;

  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash' } as SdkAutomationInput;

  const withFloor = async (
    policy: Partial<ManagedPiPolicyV1> | undefined,
    options: Parameters<typeof buildPinnedAgentAutomationSystem>[1] = { workspaceRootPath: '/workspace' },
  ) => {
    registerManagedPiPolicyProvider(policy === undefined
      ? undefined
      : () => ({ ...DEFAULT_MANAGED_PI_POLICY, ...policy }));
    try {
      return await buildPinnedAgentAutomationSystem({ view: mixedView(), materializer }, options);
    } finally {
      // Process-scoped registration: leaving it set would silence every later
      // test in this process, which is the loudest possible way to notice — but
      // it would also make THIS test pass for the wrong reason next run.
      registerManagedPiPolicyProvider(undefined);
    }
  };

  it('THE POSITIVE CONTROL: with no managed policy at all, both tiers still build', async () => {
    // Without this the two assertions below are satisfied by a builder that
    // returns `undefined` for everything, which is exactly the shape a
    // fail-closed mistake takes.
    const system = await withFloor(undefined);
    expect(await system!.executeAgentEvent('PreToolUse', input)).toMatchObject({
      matchedCount: 2,
      decision: { decision: 'block' },
    });
  });

  it('a managed disableAllHooks silences every tier with no option passed', async () => {
    // MUTATION KILLED: reverting the read to `options.managedDisableAllHooks ===
    // true` alone — the dead-switch state, in which this returns a working hook
    // system while the administrator believes hooks are off.
    expect(await withFloor({ disableAllHooks: true })).toBeUndefined();
  });

  it('a caller cannot turn the kill switch back off', async () => {
    // MUTATION KILLED: `options.managedDisableAllHooks ?? floor` instead of the
    // OR. A kill switch a caller may override is not a kill switch, and the host
    // has no authority over the managed tier.
    expect(await withFloor(
      { disableAllHooks: true },
      { workspaceRootPath: '/workspace', managedDisableAllHooks: false },
    )).toBeUndefined();
  });

  it('the option still tightens on its own, with no managed policy', async () => {
    // MUTATION KILLED: dropping the option in favour of the floor only, which
    // would break the caller override and the three tests above this block.
    expect(await withFloor(
      undefined,
      { workspaceRootPath: '/workspace', managedDisableAllHooks: true },
    )).toBeUndefined();
  });

  it('allowPluginHooks:false drops the plugin tier and leaves the native tier alone', async () => {
    // MUTATION KILLED (first): not reading `areManagedPluginHooksAllowed` here
    // at all — `matchedCount` would stay 2, i.e. the plugin hook still runs
    // under a policy that forbids plugin hooks.
    // MUTATION KILLED (second): treating it as a whole-system kill and returning
    // `undefined` — it is a plugin-only posture, and the user's own hook is not
    // the administrator's business.
    const system = await withFloor({ allowPluginHooks: false });
    expect(await system!.executeAgentEvent('PreToolUse', input)).toMatchObject({
      matchedCount: 1,
      decision: { decision: 'block' },
    });
  });

  it('allowPluginHooks:true is not a kill switch in the other direction', async () => {
    // MUTATION KILLED: `policy.allowPluginHooks === true` instead of
    // `!== false`. Absent must mean allowed — the control above proves absent,
    // this proves an explicit true.
    const system = await withFloor({ allowPluginHooks: true });
    expect(await system!.executeAgentEvent('PreToolUse', input)).toMatchObject({ matchedCount: 2 });
  });

  /**
   * D1.205 — codex's `[features] in_app_local_automation = false` reaches the
   * SAME kill switch, which is the path the row found missing.
   *
   * The premise correction that shaped it: the hook half already had
   * `ManagedPiPolicyV1.disableAllHooks` and codex's key reached it from
   * nowhere, so what was owed is a PATH, not a second switch. The scheduler
   * half — the other half of `packages/shared/src/automations/` — is gated at
   * the `AutomationSystem` construction in `SessionManager`.
   *
   * The tier is process-scoped by design (a codex `configRequirements` read
   * lands once per process), so both cases restore it in a `finally`: leaving
   * it set would silence every later test in this process.
   */
  const withCodexLocalAutomation = async (disabled: boolean | undefined) => {
    recordCodexLocalAutomationRequirement(disabled);
    try {
      return await withFloor(undefined);
    } finally {
      recordCodexLocalAutomationRequirement(undefined);
    }
  };

  it('a codex in_app_local_automation requirement silences every hook tier (D1.205)', async () => {
    expect(await withCodexLocalAutomation(true)).toBeUndefined();
  });

  it('and only a REQUIREMENT does — the control (D1.205)', async () => {
    // Without this the case above is satisfied by a builder that returns
    // `undefined` for everything, which is the shape a fail-closed mistake
    // takes. `false` and `undefined` are both "automations work", and they are
    // NOT the same fact: `undefined` means no codex runtime has answered.
    for (const tier of [false, undefined] as const) {
      const system = await withCodexLocalAutomation(tier);
      expect(await system!.executeAgentEvent('PreToolUse', input)).toMatchObject({ matchedCount: 2 });
    }
  });
})

/**
 * P6.294 — there is no one place that lists the hooks this session will run.
 *
 * The row was born from a measurement, and the measurement is what shapes these
 * cases: the catalog knows REGISTRATIONS, `AutomationsListPanel` renders user
 * AUTOMATIONS, and `ProjectHooksPanel` filters to
 * `origin === 'native' && scope.kind === 'project'` — so a user hook, a managed
 * hook and a plugin hook were each invisible on some surface. What is asserted
 * here is the projection of the MERGED system: the tiers that actually survived
 * every lock, each row naming its event, matcher, handler type and a source
 * path a user view may carry.
 *
 * The controller's shape (1) — project the RELATIVE path and the handler TYPE,
 * never the command string — is the Safe-projection rule, and the last case is
 * what holds it: an absolute path and a command string are BOTH in the fixture,
 * and neither may appear anywhere in the output.
 */
describe('describeHookBindings (P6.294)', () => {
  const HOOKS_JSON = JSON.stringify({
    hooks: {
      PreToolUse: [{
        name: 'guard-bash',
        matcher: 'Bash',
        if: 'Bash(rm *)',
        actions: [{ type: 'command', command: '/opt/secret-scripts/block-rm.sh' }],
      }],
    },
  });

  const materializer = {
    assertActive() {},
    async readText() { return HOOKS_JSON; },
    async verifyPlugin() {},
  } as unknown as CapabilitySnapshotMaterializer;

  const nativeHook = (kind: 'project' | 'global' | 'builtin', absolutePath: string) => {
    const resource = {
      source: kind === 'project' ? ('project' as const) : ('managed-global' as const),
      scope: kind === 'project'
        ? { kind: 'project' as const, workspaceId: 'ws-1', projectPath: '/workspace' }
        : { kind } as never,
      resourceId: `hook:${kind}:hooks.json`,
      absolutePath,
      revision: '1',
      contentHash: 'a'.repeat(64),
    };
    return { key: resource.resourceId, event: 'hooks.json', resource, executableHash: resource.contentHash };
  };

  const pluginHook = {
    key: 'toolkit/audit',
    event: 'PreToolUse',
    type: 'command' as const,
    matcher: 'Write|Edit',
    command: 'node audit.js',
    pluginInstanceId: 'plugin-1' as never,
    resource: { pluginInstanceId: 'plugin-1' as never, relativePath: 'hooks/audit.js', contentHash: 'b'.repeat(64) },
    executableHash: 'b'.repeat(64),
  };

  const viewWith = (hooks: unknown[]): AgentRuntimeView => ({
    generation: 'generation-1',
    sources: [], skills: [], mcpServers: [],
    hooks: hooks as never,
    automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
  } as AgentRuntimeView);

  it('lists a hooks.json matcher and a plugin hook, each naming its own source', async () => {
    // done_means, both halves in one listing: the native tier and the plugin
    // tier, with provenance. Before this they could only be counted, never
    // named — `mergeAutomationsConfigs` drops which file a matcher came from.
    const system = await buildPinnedAgentAutomationSystem(
      { view: viewWith([nativeHook('project', '/workspace/.nessy-agent/hooks.json'), pluginHook]), materializer },
      { workspaceRootPath: '/workspace' },
    );
    const bindings = system!.describeHookBindings!();

    expect(bindings).toContainEqual({
      event: 'PreToolUse',
      tier: 'project',
      handlerType: 'command',
      name: 'guard-bash',
      matcher: 'Bash',
      ifRule: 'Bash(rm *)',
      source: '.nessy-agent/hooks.json',
      enabled: true,
    });
    expect(bindings).toContainEqual({
      event: 'PreToolUse',
      tier: 'plugin',
      handlerType: 'command',
      name: 'toolkit/audit',
      matcher: 'Write|Edit',
      source: 'hooks/audit.js',
      enabled: true,
    });
  });

  it('UA12.33 — a script action on an agent event is projected inert, its command sibling is not', async () => {
    // The row's control: the view of a PreToolUse script matcher says inert.
    // A `script` action is mapped to the `command` shape but never runs on an
    // agent event — the host ScriptHandler takes App events only and the
    // runtime hook dispatch runs no script either (validation only warns,
    // `automations/validation.ts`) — so one row per action must separate the
    // two, or the listing promises a hook this session will never run.
    const scriptMaterializer = {
      assertActive() {},
      async readText() {
        return JSON.stringify({
          hooks: {
            PreToolUse: [{
              name: 'guard-and-log',
              matcher: 'Bash',
              actions: [
                { type: 'command', command: '/opt/secret-scripts/block-rm.sh' },
                { type: 'script', script: 'scripts/guard.ts' },
              ],
            }],
          },
        });
      },
      async verifyPlugin() {},
    } as unknown as CapabilitySnapshotMaterializer;
    const system = await buildPinnedAgentAutomationSystem(
      { view: viewWith([nativeHook('project', '/workspace/.nessy-agent/hooks.json')]), materializer: scriptMaterializer },
      { workspaceRootPath: '/workspace' },
    );
    const bindings = system!.describeHookBindings!();
    // One row per action (P6.294), and the two kinds read differently.
    expect(bindings).toHaveLength(2);
    // The command action runs; its row carries no inert marker.
    expect(bindings).toContainEqual({
      event: 'PreToolUse',
      tier: 'project',
      handlerType: 'command',
      name: 'guard-and-log',
      matcher: 'Bash',
      source: '.nessy-agent/hooks.json',
      enabled: true,
    });
    // The script action never runs here: same command shape, marked inert.
    expect(bindings).toContainEqual({
      event: 'PreToolUse',
      tier: 'project',
      handlerType: 'command',
      inert: true,
      name: 'guard-and-log',
      matcher: 'Bash',
      source: '.nessy-agent/hooks.json',
      enabled: true,
    });
  });

  it('reports the administrator tier as managed and a global file by name alone', async () => {
    // Two answers in one case, and they are the two the pair-of-panels defect
    // hid. `builtin` is this fork's spelling for the ADMINISTRATOR scope
    // (P6.239), so it must not read as "user". And a user-global hooks file
    // sits OUTSIDE the workspace: relativizing it would emit a `../../..` chain
    // spelling out where the workspace sits under the home directory, so the
    // file name alone is carried.
    const managed = await buildPinnedAgentAutomationSystem(
      { view: viewWith([nativeHook('builtin', '/Library/Application Support/nessy/hooks.json')]), materializer },
      { workspaceRootPath: '/workspace' },
    );
    expect(managed!.describeHookBindings!()).toContainEqual(expect.objectContaining({
      tier: 'managed', source: 'hooks.json',
    }));

    const user = await buildPinnedAgentAutomationSystem(
      { view: viewWith([nativeHook('global', '/Users/someone/.nessy-agent/hooks.json')]), materializer },
      { workspaceRootPath: '/workspace' },
    );
    const userBindings = user!.describeHookBindings!();
    expect(userBindings).toContainEqual(expect.objectContaining({ tier: 'user', source: 'hooks.json' }));
    expect(JSON.stringify(userBindings)).not.toContain('someone');
  });

  it('never carries the command string or an absolute path', async () => {
    // The negative half, and the reason the projection returns `handlerType`
    // rather than the action: an action object carries `command`, `http.url`
    // and `prompt`, so handing one out would defeat the rule at the one place
    // it is built. `absolutePath` is marked server-only on `NativeResourceRef`
    // for the same reason.
    const system = await buildPinnedAgentAutomationSystem(
      { view: viewWith([nativeHook('project', '/workspace/.nessy-agent/hooks.json'), pluginHook]), materializer },
      { workspaceRootPath: '/workspace' },
    );
    const serialized = JSON.stringify(system!.describeHookBindings!());
    expect(serialized).not.toContain('/opt/secret-scripts/block-rm.sh');
    expect(serialized).not.toContain('node audit.js');
    expect(serialized).not.toContain('/workspace/.nessy-agent');
    // The positive control on the same rig: the fixture really does declare
    // both, so the three absences above are readings and not an empty list.
    expect(HOOKS_JSON).toContain('/opt/secret-scripts/block-rm.sh');
    expect(serialized).toContain('"handlerType":"command"');
  });

  it('asks the component layer LIVE, because that tier is not a build-time snapshot', async () => {
    // R87's tier — a skill's or a subagent's frontmatter hooks — appears and
    // disappears with the active components inside one turn, which is why the
    // layer is a function and not a value. A listing that had snapshotted it at
    // build time would show a guardrail the session no longer has, so this is
    // the one tier read at listing time. `onceMatchersFor` is read too: an
    // unconsumed `once` hook is a hook this session will still run.
    let live = false;
    const layer = {
      matchersFor: (event: string) => (live && event === 'PreToolUse'
        ? { automations: { PreToolUse: [{ name: 'skill-guard', matcher: 'Bash', actions: [{ type: 'decision', decision: 'ask' }] }] } }
        : undefined),
      onceMatchersFor: () => undefined,
      consumeOnce: () => {},
      hasMatchers: () => live,
    };
    const system = await buildPinnedAgentAutomationSystem(
      { view: viewWith([nativeHook('project', '/workspace/.nessy-agent/hooks.json')]), materializer },
      { workspaceRootPath: '/workspace', componentHookLayer: () => layer as never },
    );

    // Before the component is active the listing carries the native tier alone.
    expect(system!.describeHookBindings!().some(binding => binding.tier === 'component')).toBe(false);
    live = true;
    expect(system!.describeHookBindings!()).toContainEqual({
      event: 'PreToolUse',
      tier: 'component',
      handlerType: 'decision',
      name: 'skill-guard',
      matcher: 'Bash',
      enabled: true,
    });
  });

  it('drops the tiers the user switch silenced, and reports nothing when no hook survives', async () => {
    // The view lists what will RUN. `disableAllHooks` in a user/project settings
    // document silences the native, project and component tiers, so the listing
    // must lose them too — a view that still showed them would be the same
    // silent divergence this row closes, with the sign flipped.
    const disablingMaterializer = {
      assertActive() {},
      async readText() { return JSON.stringify({ disableAllHooks: true, hooks: JSON.parse(HOOKS_JSON).hooks }); },
      async verifyPlugin() {},
    } as unknown as CapabilitySnapshotMaterializer;
    const system = await buildPinnedAgentAutomationSystem(
      { view: viewWith([nativeHook('project', '/workspace/.nessy-agent/hooks.json')]), materializer: disablingMaterializer },
      { workspaceRootPath: '/workspace' },
    );
    // Nothing survives, so the builder answers with the inert user-disabled
    // system; it enumerates no tiers, which is the honest reading.
    expect(system!.describeHookBindings?.() ?? []).toEqual([]);
    expect(system!.userTierDisableAllHooks).toBe(true);
  });
});

/**
 * D1.429 — a WORKSPACE-scope command hook is not the operator's own settings,
 * because the MODEL can write that file.
 *
 * D1.343 pre-authorised the `user` tier on the page's own words: `hooks.md`
 * scopes its review burden to the author — *"Review and test all hook commands
 * before adding them to your configuration"* — and that argument holds only
 * while the configuration really is the operator's. `<workspaceRoot>` is the
 * app's own directory (`getWorkspaceRootPath` = `<configDir>/workspaces/<id>`),
 * and `automations.json` inside it is what the model-invocable
 * `automation_create` session tool writes. So the workspace tier is JOINTLY
 * writable, and a tier a model can append to cannot carry a review the operator
 * performed.
 *
 * The builder is what decides this: `buildPinnedAgentAutomationSystem` files
 * every non-`project` scope into one bucket, and that bucket is dispatched as
 * `hookSource: 'user'`. These cases drive the builder, not the constant.
 */
describe('D1.429 — the workspace tier declares itself and keeps its card', () => {
  /**
   * Keyed on the resource, so the two tiers carry DIFFERENT command strings.
   * They must: `mergeAutomationsConfigs` folds byte-identical matchers, so a
   * single fixture command would make a two-record control indistinguishable
   * from a one-record one — which is exactly how it read before the fix, with
   * one `'user'` standing for both files.
   */
  const automationsMaterializer = {
    assertActive() {},
    async readText(resource: { absolutePath?: string }) {
      const command = resource.absolutePath?.endsWith('automations.json')
        ? '/tmp/d1429-workspace-hook.sh'
        : '/tmp/d1429-operator-hook.sh';
      return JSON.stringify({
        version: 2,
        automations: {
          PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command }] }],
        },
      });
    },
    async verifyPlugin() {},
  } as unknown as CapabilitySnapshotMaterializer;

  /** The record `native-sources.ts` files for `<workspaceRoot>/automations.json`. */
  const workspaceAutomations = () => {
    const resource = {
      source: 'workspace' as const,
      scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
      resourceId: 'automation:workspace:automations.json',
      absolutePath: '/workspace/automations.json',
      revision: '1',
      contentHash: 'c'.repeat(64),
    };
    return { key: resource.resourceId, event: 'automations.json', resource, executableHash: resource.contentHash };
  };

  /** The operator's OWN file, the control D1.343 must keep. */
  const globalHooks = () => {
    const resource = {
      source: 'managed-global' as const,
      scope: { kind: 'global' as const } as never,
      resourceId: 'hook:global:hooks.json',
      absolutePath: '/Users/someone/.nessy-agent/hooks.json',
      revision: '1',
      contentHash: 'd'.repeat(64),
    };
    return { key: resource.resourceId, event: 'hooks.json', resource, executableHash: resource.contentHash };
  };

  const viewWithRecords = (records: unknown[]): AgentRuntimeView => ({
    generation: 'generation-1',
    sources: [], skills: [], mcpServers: [],
    hooks: [], automations: records as never,
    agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
  } as AgentRuntimeView);

  /**
   * Records the attribution and never spawns — the seam under test ends at the
   * runner's arguments, which is exactly what `SessionManager` reads before it
   * decides whether to raise the card.
   */
  const recordingRunner = () => {
    const seen: Array<{ command: string; source: CommandHookSource | undefined }> = [];
    const runner: CommandHookRunner = async (action, runnerOptions) => {
      seen.push({ command: action.command, source: runnerOptions.hookSource });
      return { type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 0 };
    };
    return { runner, seen };
  };

  const preToolUse = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } } as SdkAutomationInput;

  it('a workspace automations.json command hook is attributed `workspace`, and that tier is NOT pre-authorised', async () => {
    const { runner, seen } = recordingRunner();
    const system = await buildPinnedAgentAutomationSystem(
      { view: viewWithRecords([workspaceAutomations()]), materializer: automationsMaterializer },
      { workspaceRootPath: '/workspace', pluginCommandHookRunner: runner },
    );

    const result = await system!.executeAgentEvent('PreToolUse', preToolUse);

    // It still RUNS — the fix is the tier, not a silent removal of workspace
    // hooks. A dropped bucket would pass the attribution assertion below by
    // never dispatching at all, so the match count is asserted first.
    expect(result.matchedCount).toBe(1);
    expect(seen).toEqual([{ command: '/tmp/d1429-workspace-hook.sh', source: 'workspace' }]);
    // The verdict the host reads. `false` is the ordinary state for a
    // workspace-only session (no bound project to trust), and `true` is here so
    // that a trusted project cannot smuggle the workspace tier through either.
    expect(commandHookPreauthorizedTier(seen[0]?.source, false)).toBeUndefined();
    expect(commandHookPreauthorizedTier(seen[0]?.source, true)).toBeUndefined();
  });

  it('the SDK route declares the same tier, so the hook cannot run unasked on claude and ask on Pi', async () => {
    const { runner, seen } = recordingRunner();
    const system = await buildPinnedAgentAutomationSystem(
      { view: viewWithRecords([workspaceAutomations()]), materializer: automationsMaterializer },
      { workspaceRootPath: '/workspace', pluginCommandHookRunner: runner },
    );

    for (const matcher of system!.buildSdkHooks!().PreToolUse ?? []) {
      for (const callback of matcher.hooks) {
        await callback(preToolUse, 'tool-use-d1429', { signal: new AbortController().signal });
      }
    }

    expect(seen).toEqual([{ command: '/tmp/d1429-workspace-hook.sh', source: 'workspace' }]);
  });

  it('CONTROL — the operator\'s own global hooks.json still runs unasked, and the two tiers stay separate in one session', async () => {
    const { runner, seen } = recordingRunner();
    const system = await buildPinnedAgentAutomationSystem(
      { view: viewWithRecords([globalHooks(), workspaceAutomations()]), materializer: automationsMaterializer },
      { workspaceRootPath: '/workspace', pluginCommandHookRunner: runner },
    );

    await system!.executeAgentEvent('PreToolUse', preToolUse);

    // Both ran, and they are TWO answers rather than one merged bucket. Keyed
    // by COMMAND because the dispatch order is `executeAgentEventInner`'s
    // business and this case is about the mapping.
    expect(Object.fromEntries(seen.map(entry => [entry.command, entry.source]))).toEqual({
      '/tmp/d1429-operator-hook.sh': 'user',
      '/tmp/d1429-workspace-hook.sh': 'workspace',
    });
    // D1.343 intact: the operator's own file keeps its pre-authorisation.
    expect(commandHookPreauthorizedTier('user', false)).toBe('user');
  });
});
