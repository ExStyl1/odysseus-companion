import { describe, expect, it } from 'bun:test';
import type { AgentAutomationSystem, SdkAutomationInput } from '../../automations/index.ts';
import { runClaudePreToolUseHookPipeline } from '../../agent/claude-agent.ts';
import {
  DEFAULT_MANAGED_PI_POLICY,
  registerManagedPiPolicyProvider,
  type ManagedPiPolicyV1,
} from '../../agent/pi-harness/managed-policy.ts';
import type { CapabilitySnapshotMaterializer } from '../materializer.ts';
import { buildPinnedAgentAutomationSystem, resolveVettedPluginHookLock } from '../runtime-automations.ts';
import type { AgentRuntimeView } from '../views.ts';

/**
 * P2.496, claude half — the user-tier `disableAllHooks` becomes READABLE.
 *
 * W2-g established the vendor's intent and pinned the user tier's real boundary:
 * `settings-reference.md#disableallhooks` exempts Agent SDK hooks by name, so
 * the host's own registrations in `claude-agent.ts` surviving the switch is
 * stated behaviour, not a leak. The owner's decision is that our own additions
 * should stand down anyway. W2-l then measured why they could not: the effective
 * value was a local of `buildPinnedAgentAutomationSystem`, the interface had no
 * reader, and the builder answers `undefined` when everything is empty — which
 * is ALSO what "no hooks configured" looks like. One optional reader closes it.
 *
 * These cases drive the builder, not a stub, because the two states this row is
 * about are produced by the builder and by nothing else.
 */

const HOOKS_OFF = JSON.stringify({ disableAllHooks: true });
const ONE_HOOK = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'decision', decision: 'ask', reason: 'review' }] }] },
});

function materializerFor(contentByPath: Record<string, string>): CapabilitySnapshotMaterializer {
  return {
    assertActive() {},
    async readText(resource: { absolutePath: string }) {
      return contentByPath[resource.absolutePath] ?? '{}';
    },
  } as unknown as CapabilitySnapshotMaterializer;
}

function viewWith(paths: string[]): AgentRuntimeView {
  return {
    generation: 'generation-1',
    sources: [], skills: [], mcpServers: [],
    hooks: paths.map((absolutePath, index) => {
      const resource = {
        source: 'workspace' as const,
        scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
        resourceId: `hook:workspace:${index}`,
        absolutePath,
        revision: '1',
        contentHash: String(index).repeat(64).slice(0, 64),
      };
      return { key: resource.resourceId, event: 'hooks.json', resource, executableHash: resource.contentHash };
    }),
    automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
  } as AgentRuntimeView;
}

async function build(contentByPath: Record<string, string>): Promise<AgentAutomationSystem | undefined> {
  return await buildPinnedAgentAutomationSystem(
    { view: viewWith(Object.keys(contentByPath)), materializer: materializerFor(contentByPath) },
    { workspaceRootPath: '/workspace' },
  );
}

describe('P2.496 — the user tier disableAllHooks is readable at the registration site', () => {
  it('answers a system carrying the flag where it used to answer undefined', async () => {
    // The row itself. A settings file that turns hooks off and configures none
    // leaves every tier empty, and the builder used to return `undefined` — the
    // same answer as an unconfigured workspace, which is why `claude-agent.ts`
    // could not tell the two apart and left its own registrations running.
    const system = await build({ '/ws/settings.json': HOOKS_OFF });
    expect(system).toBeDefined();
    expect(system!.userTierDisableAllHooks).toBe(true);
  });

  it('still answers undefined when nothing is configured at all', async () => {
    // The control, and the half that must not move: `undefined` keeps meaning
    // "no automations", by far the more common state. A change here would make
    // every consumer that reads it that way wrong.
    expect(await build({ '/ws/empty.json': '{}' })).toBeUndefined();
  });

  it('leaves the flag ABSENT, never false, when the switch is not engaged', async () => {
    // Absence is "unknown" by the interface's own contract, and a `false` would
    // assert the opposite. A host that cannot answer must not have its hooks
    // silenced by a default, so this distinction is load-bearing.
    const system = await build({ '/ws/hooks.json': ONE_HOOK });
    expect(system).toBeDefined();
    expect(system!.userTierDisableAllHooks).toBeUndefined();
  });

  it('carries the flag on a system whose managed-distributed hooks SURVIVED the switch', async () => {
    // The MIXED case, and the reason the flag reports the SETTING rather than
    // this object's contents. `settings-reference.md#disableallhooks` spares
    // "hooks from plugins force-enabled in managed `enabledPlugins`", so under
    // `allowManagedHooksOnly` with a force-enabled set the plugin tier keeps
    // running while every tier the user owns is emptied. The host must still be
    // able to stand its OWN additions down — the administrator's hooks are not
    // the user's, and the user's switch is still engaged.
    //
    // Fixture and policy shape taken from `managed-hook-lock-separation.test.ts`,
    // whose "allowManagedHooksOnly keeps force-enabled plugin hooks out of that
    // switch" case pins the same build at exactly one surviving hook. This
    // asserts that count HERE too, so the case cannot quietly decay into the
    // flag-only build and keep passing.
    const pluginInstanceId = `plugin://local/vetted@1.0.0#${'d'.repeat(64)}`;
    const nativeResource = {
      source: 'workspace' as const,
      scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
      resourceId: 'hook:workspace:mixed.json',
      absolutePath: '/workspace/mixed.json',
      revision: '1',
      contentHash: 'c'.repeat(64),
    };
    const view = {
      generation: 'generation-mixed',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [
        { key: nativeResource.resourceId, event: 'hooks.json', resource: nativeResource, executableHash: nativeResource.contentHash },
        {
          key: 'plugin-vetted-hook',
          event: 'PreToolUse',
          type: 'prompt' as const,
          prompt: 'plugin guidance',
          resource: { pluginInstanceId, relativePath: 'hooks/vetted.js', contentHash: 'd'.repeat(64) },
          executableHash: 'd'.repeat(64),
          pluginInstanceId,
        },
      ],
    } as unknown as AgentRuntimeView;
    const materializer = {
      assertActive() {},
      async verifyPlugin() {},
      async readText() { return HOOKS_OFF; },
    } as unknown as CapabilitySnapshotMaterializer;
    const composed: ManagedPiPolicyV1 = {
      ...DEFAULT_MANAGED_PI_POLICY,
      allowManagedHooksOnly: true,
      enabledPlugins: { 'bWFya2V0.dmV0dGVk': true },
    } as ManagedPiPolicyV1;

    registerManagedPiPolicyProvider(() => composed);
    try {
      const system = await buildPinnedAgentAutomationSystem(
        { view, materializer },
        {
          workspaceRootPath: '/workspace',
          managedHookLock: {
            enabled: true,
            pluginHooksVetted: resolveVettedPluginHookLock(composed, 'pi'),
          },
        },
      );
      expect(system).toBeDefined();
      // The positive control: something really did survive, so this is the
      // mixed arm and not the flag-only build wearing its clothes.
      const ran = await system!.executeAgentEvent(
        'PreToolUse',
        { hook_event_name: 'PreToolUse', tool_name: 'Bash' } as SdkAutomationInput,
      );
      expect(ran.matchedCount).toBe(1);
      expect(system!.userTierDisableAllHooks).toBe(true);
    } finally {
      registerManagedPiPolicyProvider(undefined);
    }
  });

  it('is INERT: the PreToolUse pipeline reads it exactly as it read undefined', async () => {
    // The safety property, driven through the real consumer rather than argued.
    // The flag-carrying system now reaches `runClaudePreToolUseHookPipeline`
    // where `undefined` used to, and the two must be indistinguishable there:
    // `disableAllHooks` governs hooks, a status line and a file-suggestion
    // command, never a permission decision, so a switch that changed this
    // pipeline's answer would be a permission widening.
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } as SdkAutomationInput;
    const revalidate = (value: Record<string, unknown>) => ({ ok: true, seen: value });

    const withNothing = await runClaudePreToolUseHookPipeline({ hookInput: input, revalidate });
    const disabled = await build({ '/ws/settings.json': HOOKS_OFF });
    const withDisabled = await runClaudePreToolUseHookPipeline({
      automationSystem: disabled!,
      hookInput: input,
      revalidate,
    });

    expect(withDisabled).toEqual(withNothing);
    expect(withDisabled.kind).toBe('validated');
    // Named individually as well as by equality: an equal pair of BLOCKED
    // results would satisfy the line above and be a catastrophe.
    expect(withDisabled).not.toHaveProperty('hookDecision');
    expect(withDisabled).not.toHaveProperty('hookReason');
  });

  it('offers no buildSdkHooks, so the registration site sees the same empty map', async () => {
    // `claude-agent.ts` reads `this.automationSystem?.buildSdkHooks?.() ?? {}`.
    // An empty map from a present method and an absent method are the same value
    // there; absence is chosen so there is one way to say it.
    const system = await build({ '/ws/settings.json': HOOKS_OFF });
    expect(system!.buildSdkHooks).toBeUndefined();
  });
});
