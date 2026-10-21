/**
 * F1.941 (owner decision 2026-09-26, option (c)) — the Pi Guardian judge runs
 * only the administrator's hooks.
 *
 * ## The door
 *
 * F1.876/F1.889 took the parent's skills and MCP servers out of the judge; its
 * HOOKS were still built like any session's (`buildAgentAutomationSystem`), so a
 * preauthorized user or project hook ran inside every judge lookup and a
 * non-preauthorized native `PreToolUse` hook blocked the judge's read at once.
 *
 * ## The fix
 *
 * `buildAgentAutomationSystem` engages the existing managed-only lock for a
 * judge — and for any session beneath one — through the identity
 * `insideHostConsult` already asks (F1.920): `managedHookLock: { enabled: true,
 * pluginHooksVetted }` — since F1.1039 the same `resolveVettedPluginHookLock`
 * answer every session reads, so a plugin force-enabled under a managed
 * `allowManagedHooksOnly` keeps its hooks here too — the same bucket filter
 * `settings-reference.md#what-runs-under-allowmanagedhooksonly` describes and
 * `buildPinnedAgentAutomationSystem` already implements ("Everything else is
 * blocked: user, project, and local hooks, hooks from other plugins, and hooks
 * declared in agent frontmatter"). No tier logic is new.
 *
 * Residue, pinned below rather than implied: under a managed
 * `strictPluginOnlyCustomization: ['hooks']` policy the builder keeps the whole
 * plugin tier (`#strictpluginonlycustomization-hooks`: "keeps running plugin
 * hooks and hooks in managed settings"), in the judge exactly as in any other
 * session — the administrator named plugins as the hook surface.
 *
 * ## The rig
 *
 * The REAL builder on a real `SessionManager`, over a view with one user-tier
 * `hooks.json` and one plugin hook, both matching `PreToolUse`; the instrument
 * is the built system's own `matchedCount`. Modelled on
 * `agent-hook-runner-every-runtime.test.ts` (the builder) and
 * `capabilities/__tests__/managed-hook-lock-separation.test.ts` (the view).
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import {
  DEFAULT_MANAGED_PI_POLICY,
  registerManagedPiPolicyProvider,
  type ManagedPiPolicyV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { GUARDIAN_POLICY_PROMPT } from '@nessy-agent/shared/prompts/guardian'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager module graph dominates this file's wall time; the bodies are milliseconds.
setDefaultTimeout(120_000)

afterEach(() => registerManagedPiPolicyProvider(undefined))

const USER_HOOK_FILE = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'decision', decision: 'block', reason: 'user hook' }] }],
  },
})

const NATIVE_ID = 'hook:global:f1941.json'
const nativeResource = {
  source: 'global', scope: { kind: 'global' }, resourceId: NATIVE_ID,
  absolutePath: '/home/user/.nessy-agent/hooks.json', revision: '1', contentHash: 'c'.repeat(64),
}
const pluginInstanceId = `plugin://local/f1941@1.0.0#${'d'.repeat(64)}`

function runtime() {
  return {
    provider: 'pi',
    view: {
      generation: 'generation-f1941',
      sources: [], skills: [], mcpServers: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      hooks: [
        { key: NATIVE_ID, event: 'hooks.json', resource: nativeResource, executableHash: nativeResource.contentHash },
        {
          key: 'plugin-f1941-hook', event: 'PreToolUse', type: 'prompt', prompt: 'plugin guidance',
          resource: { pluginInstanceId, relativePath: 'hooks/f1941.js', contentHash: 'd'.repeat(64) },
          executableHash: 'd'.repeat(64), pluginInstanceId,
        },
      ],
    },
    materializer: { assertActive() {}, async verifyPlugin() {}, async readText() { return USER_HOOK_FILE } },
  }
}

const judgeRestrictions = { prompt: `${GUARDIAN_POLICY_PROMPT}\n\nJudge this.`, model: 'gateway-fast', tools: ['read', 'grep', 'find', 'ls'], worktreePolicy: 'shared', thinkingLevel: 'off', permissionMode: 'plan', skillKeys: [], mcpServerKeys: [] }
const subagentRestrictions = { prompt: 'You are scout, a read-only explorer.', model: 'gateway-fast', tools: ['read', 'grep', 'find', 'ls'], worktreePolicy: 'shared', thinkingLevel: 'off' }

function session(id: string, extra: Record<string, unknown>) {
  return { id, workspace: { id: 'workspace-f1941', rootPath: process.cwd() }, model: 'gateway-fast', messages: [], messagesLoaded: true, backgroundShellCommands: new Map(), ...extra }
}

/** How many hooks match a `PreToolUse` on the session's built system; 0 when nothing was built at all. */
async function matchedFor(managed: any, policy: Partial<ManagedPiPolicyV1> = {}, register: Array<any> = []) {
  const manager = createTestSessionManager() as any
  const composed: ManagedPiPolicyV1 = { ...DEFAULT_MANAGED_PI_POLICY, ...policy }
  manager.managedPiPolicyCurrent = composed
  registerManagedPiPolicyProvider(() => composed)
  // The collaborators this builder and the plugin prompt runner need and this row does not test (P6.590's rig).
  manager.trackAgentAutomationSystem = (_managed: unknown, system: unknown) => system
  manager.sendEvent = () => {}
  manager.appendPiExecutionReceipt = (_managed: unknown, receipt: unknown) => receipt
  manager.piGoalReceiptReference = () => undefined
  manager.isPluginHookEffectAllowed = async () => true
  for (const other of [managed, ...register]) {
    manager.sessions.set(encodeSessionKey({ workspaceId: 'workspace-f1941', sessionId: other.id }), other)
  }
  try {
    const system = await manager.buildAgentAutomationSystem(managed, runtime(), 'pi')
    if (!system) return 0
    return (await system.executeAgentEvent('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })).matchedCount as number
  } finally {
    // The doubles are not real sessions: drop them before cleanup drains what it holds.
    manager.sessions.clear()
    await manager.cleanup()
  }
}

const parentKey = { workspaceId: 'workspace-f1941', sessionId: 'parent' }

describe('F1.941 — the Guardian judge keeps only the administrator\'s hooks', () => {
  it('CONTROL: an ordinary subagent child keeps the user tier and the plugin tier', async () => {
    const child = session('scout-child', { piChildRestrictions: subagentRestrictions, piParentSessionKey: parentKey })
    expect(await matchedFor(child, {}, [session('parent', {})])).toBe(2)
  })

  it('the judge child runs neither the user hook nor the plugin hook', async () => {
    const judge = session('judge-child', { piChildRestrictions: judgeRestrictions, piParentSessionKey: parentKey })
    expect(await matchedFor(judge, {}, [session('parent', {})])).toBe(0)
  })

  it('a session BENEATH a judge (an agent hook it started) is locked the same way', async () => {
    const judge = session('judge-child', { piChildRestrictions: judgeRestrictions, piParentSessionKey: parentKey })
    const beneath = session('beneath-judge', {
      piChildRestrictions: subagentRestrictions,
      piParentSessionKey: { workspaceId: 'workspace-f1941', sessionId: 'judge-child' },
    })
    expect(await matchedFor(beneath, {}, [judge, session('parent', {})])).toBe(0)
  })

  // F1.1039 (controller decision 2026-09-28, DECISIONS-2 Q3) — under a managed
  // `allowManagedHooksOnly` with a force-enabled plugin, the page keeps "hooks from
  // plugins force-enabled in managed `enabledPlugins`": an administrator's forced
  // plugin hook IS an administrator's hook, so the judge keeps it as every session
  // does (the upstream candidate filter narrows the view to that set; this rig's
  // view is already that one plugin). The user tier stays dropped.
  const forcedPluginPolicy: Partial<ManagedPiPolicyV1> = { allowManagedHooksOnly: true, enabledPlugins: { 'f1941@local': true } }

  it('F1.1039: under allowManagedHooksOnly with a force-enabled plugin the judge keeps that plugin hook, and still not the user hook', async () => {
    const judge = session('judge-child', { piChildRestrictions: judgeRestrictions, piParentSessionKey: parentKey })
    expect(await matchedFor(judge, forcedPluginPolicy, [session('parent', {})])).toBe(1)
  })

  it('F1.1039 CONTROL: an ordinary subagent under the same policy keeps the same set — the judge is no longer narrower than the administrator', async () => {
    const child = session('scout-child', { piChildRestrictions: subagentRestrictions, piParentSessionKey: parentKey })
    expect(await matchedFor(child, forcedPluginPolicy, [session('parent', {})])).toBe(1)
  })

  it('F1.1039 BOUNDARY: allowManagedHooksOnly with NO force-enabled plugin keeps no plugin hook in the judge', async () => {
    const judge = session('judge-child', { piChildRestrictions: judgeRestrictions, piParentSessionKey: parentKey })
    expect(await matchedFor(judge, { allowManagedHooksOnly: true }, [session('parent', {})])).toBe(0)
  })

  it('RESIDUE: a managed strictPluginOnlyCustomization:["hooks"] keeps the plugin tier in the judge, as in every session', async () => {
    const judge = session('judge-child', { piChildRestrictions: judgeRestrictions, piParentSessionKey: parentKey })
    expect(await matchedFor(judge, { strictPluginOnlyCustomization: ['hooks'] }, [session('parent', {})])).toBe(1)
  })
})
