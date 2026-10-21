/**
 * F1.80 (origin D1.386) — `/hooks` read through the object production actually
 * hands the agent.
 *
 * ## The measured defect
 *
 * On the packaged 1.40.0 (`RS-97`, SIT-6b) `/hooks` answered *"This session does
 * not publish a hook listing, so nothing can be shown here."* and *"No hook has
 * run in this session yet."* on BOTH runtimes, while the same run's log said
 * `User SDK hooks loaded:` all 32 events and eight `<Event>.hit` files proved
 * eight of them had fired.
 *
 * ## Where the two halves were lost, read before building
 *
 * The reader is `BaseAgent`'s `/hooks` arm:
 * `formatHookBindingsReport(this.automationSystem?.describeHookBindings?.())`
 * plus the run store `hookRuns`. `this.automationSystem` is never the builder's
 * `PluginScopedAutomationSystem` in production — every setter hands the agent
 * `SessionManager.buildAgentAutomationSystem`'s result, which is
 * `trackAgentAutomationSystem`'s WRAPPER, and that wrapper forwarded
 * `executeAgentEvent`, `hasAgentEventMatchers` and `buildSdkHooks` and nothing
 * else. So the listing read an optional method the wrapper did not have and
 * reported "no listing" for a session with 32 hooks.
 *
 * Every earlier test of the listing and of the run store used the UNWRAPPED
 * system (`runtime-automations.test.ts`'s P6.294 block,
 * `host-hook-runs-production-executor.test.ts`'s end-to-end case), and every
 * behavioural test of the production builder REPLACES the wrapper with an
 * identity (`manager.trackAgentAutomationSystem = (_m, system) => system`). A
 * planted collaborator production does not have at this moment — AGENTS.md's
 * C3.371 trap. This file never replaces the wrapper.
 *
 * The run half: the D1.354 producer landed after the measured artefact
 * (`935c4edfe` is not an ancestor of `61cfc4659`), so an event the AGENT emits
 * now reaches the store through the wrapper. An event the HOST emits —
 * `MessageDisplay` (`runMessageDisplayBatch`), `SubagentStart`,
 * `UserPromptExpansion`, the model-switch pair — calls the wrapper's
 * `executeAgentEvent` directly and never passes the agent's reader, so those
 * runs were never recorded anywhere. `MessageDisplay` fired seven times on claude
 * and four on Pi across the measured run's two turns.
 *
 * ## The one stand-in, and why it is not the trap
 *
 * `pluginCommandHookRunner` is replaced by a non-spawning runner. Production HAS
 * a runner at this moment (the ProcessSupervisor `workspace` spawn), so this
 * replaces an implementation, not an absence — the seam
 * `host-hook-runs-production-executor.test.ts` uses for the same reason. The
 * wrapper, the builder, the agent and its reader are all the real ones.
 *
 * The expected sentences are spelled literally: `slash-commands/hooks-command.ts`
 * is not in `@nessy-agent/shared`'s export map.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAgent } from '@nessy-agent/shared/agent/pi-agent'
import type { BackendConfig } from '@nessy-agent/shared/agent/backend/types'
import { buildPinnedAgentAutomationSystem } from '@nessy-agent/shared/capabilities/runtime-automations'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createTestSessionManager } from './test-session-manager.ts'

const UNSUPPORTED = 'This session does not publish a hook listing, so nothing can be shown here.'
const NONE = 'No hooks will run in this session.'
const NO_RUNS = 'No hook has run in this session yet.'

/** Three command hooks on three events, the shape `hooks.json` is written in. */
const HOOKS_JSON = JSON.stringify({
  hooks: {
    PreToolUse: [{ name: 'guard-bash', matcher: 'Bash', actions: [{ type: 'command', command: 'guard.sh' }] }],
    Stop: [{ name: 'audit-stop', actions: [{ type: 'command', command: 'audit.sh' }] }],
    MessageDisplay: [{ name: 'echo-display', actions: [{ type: 'command', command: 'display.sh' }] }],
  },
})

let counter = 0

function rig(options: { provider?: string; hooks?: boolean; document?: string } = {}) {
  counter += 1
  const provider = options.provider ?? 'pi'
  const root = mkdtempSync(join(tmpdir(), 'nessy-f180-'))
  const workspaceId = `ws-f180-${counter}`
  const sessionId = `session-f180-${counter}`
  const workspace = {
    id: workspaceId,
    name: 'F1.80',
    rootPath: root,
    workspaceRootPath: root,
    sessionRootPath: join(root, 'sessions'),
    config: { id: workspaceId, name: 'F1.80', createdAt: 1, updatedAt: 1 },
    lastAccessedAt: 1,
  }
  const agent = new PiAgent({
    provider: 'pi',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace,
    session: {
      id: sessionId, workspaceId, workspaceRootPath: root, workingDirectory: root,
      createdAt: 1, lastUsedAt: 1, permissionMode: 'default',
    },
    model: 'test-model',
    thinkingLevel: 'medium',
  } as unknown as BackendConfig)
  // A session command is answered in `BaseAgent.chat` before any backend runs;
  // a regression that routes `/hooks` into the model fails loudly here.
  ;(agent as unknown as { chatImpl: (message: string) => never }).chatImpl =
    (message: string) => { throw new Error(`chatImpl must not run: ${message}`) }

  // One native hooks document in the USER scope, as `~/.nessy-agent/hooks.json`
  // arrives in a capability view.
  const resource = {
    source: 'managed-global',
    scope: { kind: 'global' },
    resourceId: 'hook:global:hooks.json',
    absolutePath: join(root, 'config', 'hooks.json'),
    revision: '1',
    contentHash: 'a'.repeat(64),
  }
  const hooks = options.hooks === false
    ? []
    : [{ key: resource.resourceId, event: 'hooks.json', resource, executableHash: resource.contentHash }]
  const generation = `generation-f180-${counter}`
  const runtime = {
    provider,
    view: {
      generation,
      sources: [], skills: [], mcpServers: [], hooks, automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [],
      apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(ref: unknown) { return (ref as { absolutePath: string }).absolutePath },
      async readText() { return options.document ?? HOOKS_JSON },
      resolveCredential() { throw new Error('no credential in this rig') },
    },
    piExecutionManifestSeed: {
      surfaceVersion: 2,
      snapshotGeneration: generation,
      sessionKey: { workspaceId, sessionId },
      provenance: [],
      mcpSources: [],
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
      staticTools: [],
    },
  }
  agent.setCapabilityTurnRuntime(runtime as never)

  const manager = createTestSessionManager() as any
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  manager.sendEvent = () => {}
  const commands: string[] = []
  manager.pluginCommandHookRunner = () => async (action: { command: string }) => {
    commands.push(action.command)
    return { type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 1, stdout: 'ok\n' }
  }
  const managed: any = {
    id: sessionId,
    workspace: { id: workspaceId, rootPath: root },
    workingDirectory: root,
    permissionMode: 'default',
    agentLifecycleEnding: false,
    agent,
  }
  return { agent, manager, managed, runtime, root, commands }
}

/** What production does in `getOrCreateAgentUnchecked`, and nothing else. */
async function wireAsProduction(r: ReturnType<typeof rig>, provider = 'pi') {
  const system = await r.manager.buildAgentAutomationSystem(r.managed, r.runtime, provider)
  r.managed.agentAutomationSystem = system
  r.agent.setAutomationSystem(system)
  return system
}

async function answer(agent: PiAgent, command = '/hooks'): Promise<string> {
  const infos: string[] = []
  for await (const event of agent.chat(command)) {
    if (event.type === 'info') infos.push(event.message)
  }
  expect(infos.length).toBeGreaterThan(0)
  return infos.join('\n')
}

describe('F1.80 · the listing, read through the wrapper production hands the agent', () => {
  for (const provider of ['pi', 'anthropic', 'codex-runtime']) {
    test(`three loaded hooks are listed on a ${provider} session, not denied`, async () => {
      const r = rig({ provider })
      const system = await wireAsProduction(r, provider)
      expect(system, `no automation system was built for ${provider}`).toBeDefined()
      const text = await answer(r.agent)
      expect(text).not.toContain(UNSUPPORTED)
      expect(text).toContain('Hooks that will run in this session (3 hooks, 3 events):')
      expect(text).toContain('guard-bash')
      expect(text).toContain('audit-stop')
      expect(text).toContain('echo-display')
    })
  }

  test('CONTROL: the inner builder\'s system, unwrapped, lists the same three', async () => {
    // Proves the rig can see a listing at all, on the same view and the same
    // agent — so a denial above is the wrapper's, not the fixture's.
    const r = rig()
    const inner = await buildPinnedAgentAutomationSystem(r.runtime as never, { workspaceRootPath: r.root })
    r.agent.setAutomationSystem(inner)
    const text = await answer(r.agent)
    expect(text).toContain('Hooks that will run in this session (3 hooks, 3 events):')
  })

  test('a session with no hook configured says none will run, not that it cannot say', async () => {
    // BOUNDARY. The production builder still answers with a system here (the
    // live component layer is always supplied), so this is the listing's
    // EMPTY state read through the wrapper — the one a user with no hooks meets.
    const r = rig({ hooks: false })
    await wireAsProduction(r)
    const text = await answer(r.agent)
    expect(text).toContain(NONE)
    expect(text).not.toContain(UNSUPPORTED)
  })

  test('no system at all — the managed kill switch — reads as none, and a system without the method still says it cannot list', async () => {
    // `buildPinnedAgentAutomationSystem` returns `undefined` when a managed
    // `disableAllHooks` is engaged: nothing will run, and the listing says so.
    const r = rig()
    r.agent.setAutomationSystem(undefined)
    expect(await answer(r.agent)).toContain(NONE)
    // The distinction the unsupported sentence exists for survives: an
    // implementation that cannot enumerate still says it cannot.
    r.agent.setAutomationSystem({ executeAgentEvent: async () => ({ matchedCount: 0 }) })
    expect(await answer(r.agent)).toContain(UNSUPPORTED)
  })

  test('F1.222 · a user who turned ALL hooks off reads that none will run, not that the session cannot say', async () => {
    // The user tier's `disableAllHooks` makes the builder answer with its inert
    // system (`createUserDisabledAutomationSystem`), which had no listing — so
    // `/hooks` said "does not publish", the sentence for a runtime that cannot
    // answer, to a user whose own switch is the answer. Read through the wrapper.
    const r = rig({ document: JSON.stringify({ disableAllHooks: true, hooks: JSON.parse(HOOKS_JSON).hooks }) })
    // The rig's control: the builder itself answers with the user-disabled system.
    const inner = await buildPinnedAgentAutomationSystem(r.runtime as never, { workspaceRootPath: r.root })
    expect(inner?.userTierDisableAllHooks, 'the builder did not answer with the user-disabled system').toBe(true)
    await wireAsProduction(r)
    const text = await answer(r.agent)
    expect(text).toContain(NONE)
    expect(text).not.toContain(UNSUPPORTED)
  })
})

describe('F1.80 · the run history, through the same wrapper', () => {
  test('a hook the AGENT emits is recorded exactly once', async () => {
    // The route Pi's `Stop` takes. Recorded at HEAD by D1.354 — the arm is the
    // guard that a second recorder on the wrapper does not count it twice.
    const r = rig()
    await wireAsProduction(r)
    await (r.agent as unknown as {
      emitAutomationEvent(event: string, input: Record<string, unknown>): Promise<unknown>
    }).emitAutomationEvent('Stop', { hook_event_name: 'Stop' })
    expect(r.commands).toEqual(['audit.sh'])
    const text = await answer(r.agent)
    expect(text).not.toContain(NO_RUNS)
    expect(text).toContain('audit-stop (Stop) - 1 run\n')
  })

  test('a hook the HOST emits (MessageDisplay) is recorded', async () => {
    // The real host-side dispatch, `runMessageDisplayBatch`, which calls the
    // wrapper's `executeAgentEvent` directly and never passes the agent.
    const r = rig()
    await wireAsProduction(r)
    const cursor = { messageId: 'message-f180', index: 0, fires: true, wholeLines: false, displayed: '', overridden: false }
    await r.manager.runMessageDisplayBatch(r.managed, cursor, 'hello', true, 'turn-f180')
    expect(r.commands).toEqual(['display.sh'])
    const text = await answer(r.agent)
    expect(text).not.toContain(NO_RUNS)
    expect(text).toContain('echo-display (MessageDisplay) - 1 run\n')
  })

  test('an event with no hook on it records nothing', async () => {
    // NEGATIVE: the recorder reports runs, never dispatches.
    const r = rig()
    await wireAsProduction(r)
    await r.managed.agentAutomationSystem.executeAgentEvent('SessionEnd', { hook_event_name: 'SessionEnd', reason: 'other' })
    expect(r.commands).toEqual([])
    expect(await answer(r.agent)).toContain(NO_RUNS)
  })
})

/**
 * F1.223 (P-WJu-3) — the runs claude executes through `buildSdkHooks()` callbacks.
 *
 * On claude every hook event but `PreToolUse` (and the host-emitted session and
 * model-switch pairs) runs inside the SDK child, which calls back into the
 * callbacks the automation system built. Those callbacks run the SAME executor
 * and then return `automationResultToSdkHookResult(...)` — the SDK's shape, with
 * no `hookRuns` — so `/hooks` never listed a `UserPromptSubmit`, `PostToolUse`,
 * `PostToolBatch`, `Stop` or `InstructionsLoaded` run on claude, while the claude
 * binary's own `hook_response` covers only ITS hooks, not callbacks
 * (`claude-agent.ts`'s `includeHookEvents` note). Driven here exactly as the SDK
 * child drives it: the wrapper's `buildSdkHooks()` map, a callback invoked with
 * the child's input.
 */
describe('F1.223 · a hook claude runs through an SDK callback reaches the run history', () => {
  async function callBack(system: any, event: string, input: Record<string, unknown>) {
    const results: unknown[] = []
    for (const matcher of system.buildSdkHooks()[event] ?? []) {
      for (const callback of matcher.hooks) results.push(await callback(input, 'tool-use-f1223', {}))
    }
    return results
  }

  test('a Stop hook the SDK child calls back is recorded once, and the SDK still gets its own answer', async () => {
    const r = rig({ provider: 'anthropic' })
    const system = await wireAsProduction(r, 'anthropic')
    const results = await callBack(system, 'Stop', { hook_event_name: 'Stop', session_id: 's' })
    expect(r.commands).toEqual(['audit.sh'])
    expect(results).toHaveLength(1)
    const text = await answer(r.agent)
    expect(text).not.toContain(NO_RUNS)
    expect(text).toContain('audit-stop (Stop) - 1 run\n')
  })

  test('CONTROL: building the map runs nothing and records nothing', async () => {
    const r = rig({ provider: 'anthropic' })
    const system = await wireAsProduction(r, 'anthropic')
    expect(Object.keys(system.buildSdkHooks())).toContain('Stop')
    expect(r.commands).toEqual([])
    expect(await answer(r.agent)).toContain(NO_RUNS)
  })
})

/**
 * F1.279 (origin WJ-aa P-WJaa-2) — F1.223's COMPONENT-layer route.
 *
 * F1.223 threaded the recorder to every tier `buildSdkHooks` builds, the
 * component layer included (`PluginScopedAutomationSystem.buildComponentSdkHooks`:
 * skill and subagent frontmatter hooks, resolved live from the agent's active
 * invocations through `SessionManager.liveComponentHookLayer`). Only the CONFIG
 * route was driven. Here a skill carrying a frontmatter `Stop` hook is ACTIVE on
 * the agent, the user tier carries no hook at all (`hooks: false`), and the SDK
 * child's `Stop` callback is invoked through the wrapper's map — so the one run
 * can only be the skill's, arriving by the component route. The config route's
 * own arm is F1.223's above, the CONTROL this row names.
 */
describe('F1.279 · a skill frontmatter hook claude runs through an SDK callback reaches the run history', () => {
  const SKILL_STOP = { automations: { Stop: [{ name: 'skill-stop', actions: [{ type: 'command', command: 'skill-stop.sh' }] }] } }

  /** One active skill invocation carrying `SKILL_STOP`, the shape the agent keeps. */
  function activateSkill(agent: PiAgent): void {
    ;(agent as unknown as { activeSkillInvocations: Map<string, unknown> }).activeSkillInvocations =
      new Map([['skill:f1279', { key: 'skill:f1279', componentHooks: { always: SKILL_STOP } }]])
  }

  async function callBack(system: any, event: string, input: Record<string, unknown>) {
    const results: unknown[] = []
    for (const matcher of system.buildSdkHooks()[event] ?? []) {
      for (const callback of matcher.hooks) results.push(await callback(input, 'tool-use-f1279', {}))
    }
    return results
  }

  test('an active skill\'s Stop hook the SDK child calls back is recorded exactly once', async () => {
    const r = rig({ provider: 'anthropic', hooks: false })
    activateSkill(r.agent)
    const system = await wireAsProduction(r, 'anthropic')
    // Not vacuous: with no config hook, the map's Stop entry is the skill's.
    expect(Object.keys(system.buildSdkHooks())).toEqual(['Stop'])
    const results = await callBack(system, 'Stop', { hook_event_name: 'Stop', session_id: 's' })
    expect(r.commands).toEqual(['skill-stop.sh'])
    expect(results).toHaveLength(1)
    const text = await answer(r.agent)
    expect(text).not.toContain(NO_RUNS)
    expect(text).toContain('skill-stop (Stop) - 1 run\n')
  })

  test('CONTROL: the same callback through the UNWRAPPED builder\'s map runs the hook and records nothing', async () => {
    // The builder's system, handed the same live layer and runner but no
    // recorder — so the run above is the wrapper's hand-off, not a second route.
    const r = rig({ provider: 'anthropic', hooks: false })
    activateSkill(r.agent)
    const inner = await buildPinnedAgentAutomationSystem(r.runtime as never, {
      workspaceRootPath: r.root,
      componentHookLayer: () => r.agent.getComponentHookLayer(),
      pluginCommandHookRunner: r.manager.pluginCommandHookRunner(),
    })
    r.agent.setAutomationSystem(inner)
    await callBack(inner, 'Stop', { hook_event_name: 'Stop', session_id: 's' })
    expect(r.commands).toEqual(['skill-stop.sh'])
    expect(await answer(r.agent)).toContain(NO_RUNS)
  })

  test('BOUNDARY: with no skill active, the map carries no Stop entry and nothing runs', async () => {
    const r = rig({ provider: 'anthropic', hooks: false })
    const system = await wireAsProduction(r, 'anthropic')
    expect(system.buildSdkHooks().Stop).toBeUndefined()
    expect(r.commands).toEqual([])
    expect(await answer(r.agent)).toContain(NO_RUNS)
  })
})
