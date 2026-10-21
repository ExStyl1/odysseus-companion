/**
 * P3.243 — two managed controls, collapsed into one key.
 *
 * `settings-reference.md#strictpluginonlycustomization-hooks` and
 * `#what-runs-under-allowmanagedhooksonly` engage the same
 * `managedHookLock.enabled` in `SessionManager.buildAgentAutomationSystem`
 * (its OR is deliberate — both block user, project and local `settings.json`
 * hooks). They differ on exactly one tier, and the pages say so in terms:
 *
 *  - strict-plugin-only "stops running hooks from user, project, and local
 *    `settings.json`, and keeps running plugin hooks and hooks in managed
 *    settings" — ALL plugin hooks, vetted by nobody;
 *  - `allowManagedHooksOnly` keeps only "hooks from plugins your managed
 *    settings force-enable through `enabledPlugins`" and blocks "hooks from
 *    other plugins".
 *
 * On the parent commit the builder had one answer for both, so one key did two
 * things it should not: with `enabledPlugins` present it marked every installed
 * plugin's hooks managed-DISTRIBUTED — immune to the user's own
 * `disableAllHooks`, which `settings-reference.md#disableallhooks` spares for
 * "managed hooks, Agent SDK hooks, and hooks from plugins force-enabled in
 * managed `enabledPlugins`" and nothing else — and with `enabledPlugins` absent
 * it dropped the plugin tier the key exists to keep.
 *
 * Driven through the real builder rather than asserted on the predicates,
 * because the defect is in which hooks END UP in the system.
 */
import { describe, expect, it } from 'bun:test';
import type { SdkAutomationInput } from '../../automations/index.ts';
import {
  DEFAULT_MANAGED_PI_POLICY,
  registerManagedPiPolicyProvider,
  type ManagedPiPolicyV1,
} from '../../agent/pi-harness/managed-policy.ts';
import type { CapabilitySnapshotMaterializer } from '../materializer.ts';
import { buildPinnedAgentAutomationSystem, resolveVettedPluginHookLock } from '../runtime-automations.ts';
import type { AgentRuntimeView } from '../views.ts';

const PLAIN_HOOK_FILE = JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: 'Bash',
      actions: [{ type: 'decision', decision: 'block', reason: 'user hook' }],
    }],
  },
});

/** The user's own switch. `#disableallhooks`: "In any other settings file". */
const DISABLING_HOOK_FILE = JSON.stringify({ disableAllHooks: true, hooks: {} });

const NATIVE_ID = 'hook:workspace:p3243.json';

const nativeResource = {
  source: 'workspace' as const,
  scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
  resourceId: NATIVE_ID,
  absolutePath: '/workspace/p3243.json',
  revision: '1',
  contentHash: 'c'.repeat(64),
};

const pluginInstanceId = `plugin://local/unvetted@1.0.0#${'d'.repeat(64)}`;
const pluginHook = {
  key: 'plugin-unvetted-hook',
  event: 'PreToolUse',
  type: 'prompt' as const,
  prompt: 'plugin guidance',
  resource: { pluginInstanceId, relativePath: 'hooks/unvetted.js', contentHash: 'd'.repeat(64) },
  executableHash: 'd'.repeat(64),
  pluginInstanceId,
};

function mixedView(): AgentRuntimeView {
  return {
    generation: 'generation-p3243',
    sources: [], skills: [], mcpServers: [], automations: [], agents: [],
    promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    hooks: [
      { key: NATIVE_ID, event: 'hooks.json', resource: nativeResource, executableHash: nativeResource.contentHash },
      pluginHook,
    ],
  } as unknown as AgentRuntimeView;
}

const materializerWith = (nativeContent: string) => ({
  assertActive() {},
  async verifyPlugin() {},
  async readText() { return nativeContent; },
} as unknown as CapabilitySnapshotMaterializer);

const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash' } as SdkAutomationInput;

/**
 * Build the system exactly as `SessionManager.buildAgentAutomationSystem` does:
 * the lock's `enabled` is the OR of the two keys, and `pluginHooksVetted` comes
 * from `resolveVettedPluginHookLock` on the same policy. Nothing here is allowed
 * to compute the answer a different way — that divergence IS the row.
 */
async function build(
  policy: Partial<ManagedPiPolicyV1>,
  nativeContent: string = PLAIN_HOOK_FILE,
) {
  const composed: ManagedPiPolicyV1 = { ...DEFAULT_MANAGED_PI_POLICY, ...policy };
  registerManagedPiPolicyProvider(() => composed);
  try {
    return await buildPinnedAgentAutomationSystem(
      { view: mixedView(), materializer: materializerWith(nativeContent) },
      {
        workspaceRootPath: '/workspace',
        managedHookLock: {
          enabled: composed.allowManagedHooksOnly === true
            || composed.strictPluginOnlyCustomization?.includes('hooks') === true,
          pluginHooksVetted: resolveVettedPluginHookLock(composed, 'pi'),
        },
      },
    );
  } finally {
    registerManagedPiPolicyProvider(undefined);
  }
}

/** How many hooks matched, or 0 when the builder produced no system at all. */
async function matched(system: Awaited<ReturnType<typeof build>>): Promise<number> {
  if (!system) return 0;
  const result = await system.executeAgentEvent('PreToolUse', input);
  return result.matchedCount;
}

const FORCE_ENABLED = { 'bWFya2V0.dmV0dGVk': true } as const;

describe('P3.243 · the two managed hook locks are two controls', () => {
  it('THE POSITIVE CONTROL: with neither key set, both tiers run', async () => {
    // Without this every assertion below is satisfied by a builder that returns
    // nothing, which is the shape a fail-closed mistake takes.
    expect(await matched(await build({}))).toBe(2);
  });

  it('strictPluginOnlyCustomization:["hooks"] keeps the plugin tier with no force-enable at all', async () => {
    // `#strictpluginonlycustomization-hooks`: "keeps running plugin hooks and
    // hooks in managed settings". MUTATION KILLED: dropping the
    // `strictPluginOnlyHooksLock` arm of `keepPluginHooks` — the administrator
    // who locks hooks to plugin sources then gets zero plugin hooks.
    expect(await matched(await build({ strictPluginOnlyCustomization: ['hooks'] }))).toBe(1);
  });

  it("strictPluginOnlyCustomization:['hooks'] still blocks the user/project settings tier", async () => {
    // The half both keys share. The native hook above is the workspace tier and
    // must not survive; only the plugin hook is left, which is the `1` above.
    // Asserted on WHICH one survived, not just how many: the workspace hook is a
    // `block` decision and the plugin hook is a prompt, so the shape of the
    // result names the tier that ran.
    const system = await build({ strictPluginOnlyCustomization: ['hooks'] });
    const result = await system!.executeAgentEvent('PreToolUse', input);
    expect(result.matchedCount).toBe(1);
    expect(result.decision).toEqual({ additionalContext: 'plugin guidance' });
  });

  it("a user's own disableAllHooks REACHES plugin hooks kept by strictPluginOnlyCustomization", async () => {
    // THE ROW. `#disableallhooks` spares "hooks from plugins force-enabled in
    // managed `enabledPlugins`" — and nothing narrowed these to that set, so
    // they are not spared. On the parent commit the presence of ANY
    // `enabledPlugins: true` entry made this answer 1.
    expect(await matched(await build(
      { strictPluginOnlyCustomization: ['hooks'], enabledPlugins: FORCE_ENABLED },
      DISABLING_HOOK_FILE,
    ))).toBe(0);
  });

  it('allowManagedHooksOnly keeps force-enabled plugin hooks out of that switch', async () => {
    // The carve-out P6.5 restored, unchanged: under the OTHER key the surviving
    // plugin hooks really are the administrator's, so the user's switch stops at
    // them. MUTATION KILLED: making `pluginHooksAreManagedDistributed` require
    // something the `allowManagedHooksOnly` path cannot satisfy.
    expect(await matched(await build(
      { allowManagedHooksOnly: true, enabledPlugins: FORCE_ENABLED },
      DISABLING_HOOK_FILE,
    ))).toBe(1);
  });

  it('allowManagedHooksOnly with no force-enabled set still drops the plugin tier', async () => {
    // `#what-runs-under-allowmanagedhooksonly` blocks "hooks from other
    // plugins". MUTATION KILLED: letting the strict-plugin-only arm apply when
    // `allowManagedHooksOnly` is also set, which would widen the stricter key.
    expect(await matched(await build({ allowManagedHooksOnly: true }))).toBe(0);
  });

  it('both keys together follow the stricter one', async () => {
    expect(await matched(await build({
      allowManagedHooksOnly: true,
      strictPluginOnlyCustomization: ['hooks'],
    }))).toBe(0);
  });
});

describe('P3.243 · resolveVettedPluginHookLock answers for allowManagedHooksOnly only', () => {
  const policy = (over: Partial<ManagedPiPolicyV1>): ManagedPiPolicyV1 =>
    ({ ...DEFAULT_MANAGED_PI_POLICY, ...over });

  it('is true only when the lock that narrows is the one engaged', () => {
    expect(resolveVettedPluginHookLock(
      policy({ allowManagedHooksOnly: true, enabledPlugins: FORCE_ENABLED }), 'pi',
    )).toBe(true);
    // The narrowing filter in `storage-runtime.ts` is gated on
    // `isManagedHooksOnly` alone, so under strict-plugin-only it did not run and
    // nothing here may claim it did.
    expect(resolveVettedPluginHookLock(
      policy({ strictPluginOnlyCustomization: ['hooks'], enabledPlugins: FORCE_ENABLED }), 'pi',
    )).toBe(false);
  });

  it('stays fail-closed for a provider-neutral browse resolve', () => {
    expect(resolveVettedPluginHookLock(
      policy({ allowManagedHooksOnly: true, enabledPlugins: FORCE_ENABLED }), undefined,
    )).toBe(false);
  });
});
