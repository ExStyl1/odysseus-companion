/**
 * The automation-system WRAPPER production hands every agent — what it must
 * carry across, read over the real `SessionManager.buildAgentAutomationSystem`
 * and never over a replacement.
 *
 * ## Why this file never replaces the wrapper
 *
 * `trackAgentAutomationSystem` wraps the builder's system, and that wrapper is
 * what `managed.agentAutomationSystem` and every agent hold. F1.80 (D1.386) met
 * the first member it dropped — `describeHookBindings` — and the cause was a
 * test shape, not a code shape: every earlier test either drove the UNWRAPPED
 * system or replaced the wrapper with an identity
 * (`manager.trackAgentAutomationSystem = (_m, system) => system`), a planted
 * collaborator production does not have (AGENTS.md, the C3.371 trap). WJ-u's
 * throwaway probe over the real builder then found two more members the wrapper
 * dropped (P-WJu-1, P-WJu-2). Each arm below reads the object production reads.
 *
 * ## F1.222 (P-WJu-2) — the user's `disableAllHooks` never reached claude
 *
 * P2.496 is an owner decision: when the USER tier turns all hooks off, the
 * hooks `claude-agent.ts` registers into the SDK itself stand down too — a
 * narrowing the vendor does not require (`settings-reference.md#disableallhooks`
 * keeps "Agent SDK hooks" running) and the owner chose anyway, because a user
 * who turns hooks off reasonably believes hooks are off. The reader is
 * `AgentAutomationSystem.userTierDisableAllHooks`, the gate is
 * `claudeSubagentDebugHooksWithheld(this.automationSystem)`, and
 * `this.automationSystem` is the wrapper — which did not carry the flag. The
 * probe read `undefined` wrapped and `true` unwrapped, so the switch controlled
 * nothing in production. `undefined` is read as "unknown" (the field's own
 * contract), and "unknown" keeps the registrations.
 *
 * What stands down, stated at its honest size (W2-g's measurement, recorded in
 * `claude-agent.ts`): the host's `SubagentStart`/`SubagentStop` debug matchers.
 * `PreToolUse` and `PermissionDenied` never read the flag, by design — a
 * convenience switch must not become a permission widening.
 *
 * ## F1.221 (P-WJu-1) — claude's session-directive sink reached nobody
 *
 * C4.12 gave claude a consumer for a hook decision's SESSION band: where the
 * query options are assembled, `claude-agent.ts` registers
 * `decision => this.applyHookSessionDirectives(decision)` on its automation
 * system IF `supportsSessionDirectiveSink(this.automationSystem)` — a duck-typed
 * member the interface does not declare, so the wrapper never carried it and
 * the probe read `false` wrapped, `true` unwrapped. What that sink still serves
 * on claude, read rather than assumed: `SessionStart` is host-emitted on claude
 * since D1.155 (`mergeClaudeSdkHooks` keeps it out of the SDK map), so its band
 * already arrives through `emitAutomationEvent`; the sink is the only road for
 * a band field decided INSIDE an SDK callback, and the decision surface gives
 * one such field to one other event — `UserPromptSubmit`'s `sessionTitle`
 * (`hook-decision-contract.ts`). That is what now reaches the host.
 *
 * ## The guard — the next member cannot be dropped silently
 *
 * `WRAPPER_DISPOSITION` names every public member of the agent-facing surface:
 * the interface plus the production class, whose duck-typed sink the interface
 * does not declare. `satisfies Record<…>` is enforced by `typecheck:server-core`
 * (TS `keyof` leaves `private` members out), so a member added to either type
 * fails the build here until it is given a disposition; the runtime arm then
 * fails if the production system carries it and the wrapper does not. The
 * mutant arm proves the checker can fail, member by member.
 *
 * The one stand-in is the command runner (`pluginCommandHookRunner`), the seam
 * `hooks-command-host-wrapper.test.ts` uses for the same reason: production has
 * a runner at this moment, so it replaces an implementation, not an absence.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeSubagentDebugHooksWithheld, mergeClaudeSdkHooks } from '@nessy-agent/shared/agent/claude-agent'
import type { AgentAutomationSystem, PreToolUseDecision } from '@nessy-agent/shared/automations'
import {
  PluginScopedAutomationSystem,
  supportsSessionDirectiveSink,
} from '@nessy-agent/shared/plugins/hooks-automation'
import { buildPinnedAgentAutomationSystem } from '@nessy-agent/shared/capabilities/runtime-automations'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createTestSessionManager } from './test-session-manager.ts'

/** Two command hooks the way a user's `~/.nessy-agent/hooks.json` writes them. */
const HOOKS = {
  SessionStart: [{ name: 'title-start', actions: [{ type: 'command', command: 'start.sh' }] }],
  Stop: [{ name: 'audit-stop', actions: [{ type: 'command', command: 'audit.sh' }] }],
}

let counter = 0

function rig(document: Record<string, unknown>, stdoutByCommand: Record<string, string> = {}, provider = 'anthropic') {
  counter += 1
  const root = mkdtempSync(join(tmpdir(), 'nessy-wjaa-'))
  const resource = {
    source: 'managed-global',
    scope: { kind: 'global' },
    resourceId: 'hook:global:hooks.json',
    absolutePath: join(root, 'config', 'hooks.json'),
    revision: '1',
    contentHash: 'b'.repeat(64),
  }
  const runtime = {
    provider,
    view: {
      generation: `generation-wjaa-${counter}`,
      sources: [], skills: [], mcpServers: [],
      hooks: [{ key: resource.resourceId, event: 'hooks.json', resource, executableHash: resource.contentHash }],
      automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [],
      promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(ref: unknown) { return (ref as { absolutePath: string }).absolutePath },
      async readText() { return JSON.stringify(document) },
      resolveCredential() { throw new Error('no credential in this rig') },
    },
  }
  const manager = createTestSessionManager() as any
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  manager.sendEvent = () => {}
  const commands: string[] = []
  manager.pluginCommandHookRunner = () => async (action: { command: string }) => {
    commands.push(action.command)
    return {
      type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 1,
      stdout: stdoutByCommand[action.command] ?? '',
    }
  }
  const managed: any = {
    id: `session-wjaa-${counter}`,
    workspace: { id: `ws-wjaa-${counter}`, rootPath: root },
    workingDirectory: root,
    permissionMode: 'default',
    agentLifecycleEnding: false,
  }
  return { manager, managed, runtime, root, commands }
}

/** What production does in `getOrCreateAgentUnchecked`: the builder, then the wrapper, never replaced. */
async function wrappedSystem(r: ReturnType<typeof rig>, provider = 'anthropic') {
  return await r.manager.buildAgentAutomationSystem(r.managed, r.runtime, provider)
}

async function innerSystem(r: ReturnType<typeof rig>) {
  return await buildPinnedAgentAutomationSystem(r.runtime as never, { workspaceRootPath: r.root })
}

/**
 * The wrapper AND the exact system production wrapped. A spy that calls the
 * real `trackAgentAutomationSystem` and returns ITS result — never an identity.
 */
async function wrappedWithInner(r: ReturnType<typeof rig>) {
  const real = r.manager.trackAgentAutomationSystem.bind(r.manager)
  let inner: AgentAutomationSystem | undefined
  r.manager.trackAgentAutomationSystem = (managed: unknown, system: AgentAutomationSystem | undefined) => {
    inner = system
    return real(managed, system)
  }
  const wrapped = await r.manager.buildAgentAutomationSystem(r.managed, r.runtime, 'anthropic')
  return { wrapped, inner: inner! }
}

describe('F1.222 · the user tier\'s disableAllHooks reaches claude\'s own registrations through the wrapper', () => {
  test('hooks turned off: the wrapper carries the switch and claude stands its debug matchers down', async () => {
    const r = rig({ disableAllHooks: true, hooks: HOOKS })
    const wrapped = await wrappedSystem(r)
    expect(wrapped, 'the builder answers a user-disabled tier with an inert system, not undefined').toBeDefined()
    expect(wrapped.userTierDisableAllHooks).toBe(true)
    expect(claudeSubagentDebugHooksWithheld(wrapped)).toBe(true)
  })

  test('CONTROL (the rig can see the flag): the inner builder\'s system carries it unwrapped', async () => {
    const r = rig({ disableAllHooks: true, hooks: HOOKS })
    const inner = await innerSystem(r)
    expect(inner?.userTierDisableAllHooks).toBe(true)
    expect(claudeSubagentDebugHooksWithheld(inner)).toBe(true)
  })

  test('CONTROL: hooks on — the gate stays open and the SDK registrations are unchanged', async () => {
    const r = rig({ hooks: HOOKS })
    const wrapped = await wrappedSystem(r)
    const inner = await innerSystem(r)
    // Absent means "not engaged" (the builder's spread-conditional) and the
    // wrapper must not turn absence into an assertion either way.
    expect('userTierDisableAllHooks' in wrapped).toBe(false)
    expect(claudeSubagentDebugHooksWithheld(wrapped)).toBe(false)
    // The registrations claude hands the SDK are the wrapper's `buildSdkHooks`:
    // the same events, the same matcher counts, as the unwrapped system's.
    const shape = (hooks: Record<string, Array<{ hooks: unknown[] }> | undefined>) =>
      Object.fromEntries(Object.entries(hooks).map(([event, matchers]) => [event, (matchers ?? []).map(m => m.hooks.length)]))
    expect(shape(wrapped.buildSdkHooks())).toEqual(shape(inner!.buildSdkHooks!()))
    expect(Object.keys(wrapped.buildSdkHooks()).sort()).toEqual(['SessionStart', 'Stop'])
  })
})

describe('F1.221 · claude\'s session-directive sink reaches the inner system through the wrapper', () => {
  const PROMPT_TITLE = '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"auth-refactor"}}'
  const PROMPT_HOOKS = { UserPromptSubmit: [{ name: 'title-prompt', actions: [{ type: 'command', command: 'title.sh' }] }] }

  type SdkHooks = Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<unknown>> }> | undefined>

  /** What `claude-agent.ts` does where the query options are assembled: register, then hand the SDK the merged map. */
  function registerAsClaude(system: AgentAutomationSystem, sink: (decision: PreToolUseDecision) => void): SdkHooks {
    if (supportsSessionDirectiveSink(system)) system.setSessionDirectiveSink(sink)
    return mergeClaudeSdkHooks({}, system.buildSdkHooks?.() ?? {}) as unknown as SdkHooks
  }

  /** Every callback of one event, exactly as the SDK child calls them back. */
  async function dispatch(hooks: SdkHooks, event: string, input: Record<string, unknown>): Promise<unknown[]> {
    const results: unknown[] = []
    for (const matcher of hooks[event] ?? []) {
      for (const callback of matcher.hooks) results.push(await callback(input, undefined, {}))
    }
    return results
  }

  const PROMPT_INPUT = { hook_event_name: 'UserPromptSubmit', session_id: 'session-f1221', prompt: 'refactor the auth module' }

  test('a UserPromptSubmit hook\'s sessionTitle reaches the sink claude registers, and stays off the SDK wire', async () => {
    const r = rig({ hooks: PROMPT_HOOKS }, { 'title.sh': PROMPT_TITLE })
    const wrapped = await wrappedSystem(r)
    expect(supportsSessionDirectiveSink(wrapped)).toBe(true)
    const seen: PreToolUseDecision[] = []
    const sdkHooks = registerAsClaude(wrapped, decision => { seen.push(decision) })
    const results = await dispatch(sdkHooks, 'UserPromptSubmit', PROMPT_INPUT)
    expect(r.commands).toEqual(['title.sh'])
    expect(seen.map(decision => decision.sessionTitle)).toEqual(['auth-refactor'])
    // R64 is not undone: the SDK would rename ITS record, so the band stays off its wire.
    expect(JSON.stringify(results)).not.toContain('auth-refactor')
  })

  test('CONTROL: unregistering through the wrapper stops delivery — the inner system reads the sink live', async () => {
    const r = rig({ hooks: PROMPT_HOOKS }, { 'title.sh': PROMPT_TITLE })
    const wrapped = await wrappedSystem(r)
    const seen: PreToolUseDecision[] = []
    const sdkHooks = registerAsClaude(wrapped, decision => { seen.push(decision) })
    ;(wrapped as { setSessionDirectiveSink(sink: undefined): void }).setSessionDirectiveSink(undefined)
    await dispatch(sdkHooks, 'UserPromptSubmit', PROMPT_INPUT)
    expect(r.commands).toEqual(['title.sh'])
    expect(seen).toEqual([])
  })

  test('CONTROL: SessionStart is not on this road — claude keeps it out of the SDK map and emits it host-side (D1.155)', async () => {
    const r = rig({ hooks: HOOKS })
    const wrapped = await wrappedSystem(r)
    expect(Object.keys(wrapped.buildSdkHooks())).toContain('SessionStart')
    const sdkHooks = registerAsClaude(wrapped, () => {})
    expect(sdkHooks.SessionStart).toBeUndefined()
    expect(Object.keys(sdkHooks)).toEqual(['Stop'])
  })
})

/**
 * F1.278 — what the builder can return, read off the BUILDER's own declared
 * return type (`PinnedAgentAutomationSystem`, a closed list of classes) rather
 * than named here by hand. It used to be `keyof AgentAutomationSystem | keyof
 * PluginScopedAutomationSystem`, which a second production implementation's
 * duck-typed member would have walked past: the builder returns only through
 * its declared type, so a new implementation must join that list to compile,
 * and joining it puts its members into `AgentFacingMember` below.
 */
type BuiltAutomationSystem = NonNullable<Awaited<ReturnType<typeof buildPinnedAgentAutomationSystem>>>

/** `keyof (A | B)` is only the keys A and B SHARE; this is the keys of EACH. */
type KeysOfEach<T> = T extends unknown ? keyof T : never

type AgentFacingMember = keyof AgentAutomationSystem | KeysOfEach<BuiltAutomationSystem>

/**
 * Every PUBLIC member of the agent-facing surface and what the wrapper does
 * with it. `satisfies` makes the list exhaustive at typecheck time: add a
 * member to `AgentAutomationSystem`, or to any class the builder's return type
 * lists, and this literal stops compiling until the new member is placed.
 */
const WRAPPER_DISPOSITION = {
  serializesAgentEvents: 'wrapper-own',
  executeAgentEvent: 'wrapped',
  hasAgentEventMatchers: 'wrapped',
  buildSdkHooks: 'wrapped',
  describeHookBindings: 'forwarded',
  userTierDisableAllHooks: 'forwarded',
  setSessionDirectiveSink: 'forwarded',
} as const satisfies Record<AgentFacingMember, 'wrapper-own' | 'wrapped' | 'forwarded'>

/** The members `system` actually carries: a method, or a value that is not `undefined`. */
function carried(system: object): string[] {
  const bag = system as Record<string, unknown>
  return Object.keys(WRAPPER_DISPOSITION).filter(member => bag[member] !== undefined)
}

/** Every member the inner system carries that the wrapper does not carry the same way. */
function droppedMembers(inner: object, wrapper: object): string[] {
  const from = inner as Record<string, unknown>
  const to = wrapper as Record<string, unknown>
  return carried(inner).filter(member => (
    typeof from[member] === 'function' ? typeof to[member] !== 'function' : to[member] !== from[member]
  ))
}

describe('the guard · the wrapper carries every member the production system carries', () => {
  test('hooks on — the plugin-scoped system: nothing is dropped', async () => {
    const r = rig({ hooks: HOOKS })
    const { wrapped, inner } = await wrappedWithInner(r)
    expect(inner).toBeInstanceOf(PluginScopedAutomationSystem)
    // Not vacuous: the production class carries the members this file is about.
    expect(carried(inner)).toEqual(expect.arrayContaining([
      'executeAgentEvent', 'hasAgentEventMatchers', 'buildSdkHooks', 'describeHookBindings', 'setSessionDirectiveSink',
    ]))
    expect(droppedMembers(inner, wrapped)).toEqual([])
    expect(wrapped.serializesAgentEvents).toBe(true)
  })

  test('hooks turned off — the user-disabled system: nothing is dropped', async () => {
    const r = rig({ disableAllHooks: true, hooks: HOOKS })
    const { wrapped, inner } = await wrappedWithInner(r)
    expect(carried(inner)).toContain('userTierDisableAllHooks')
    expect(droppedMembers(inner, wrapped)).toEqual([])
  })

  test('CONTROL: a mutant wrapper that drops any one carried member is caught, and names it', async () => {
    for (const document of [{ hooks: HOOKS }, { disableAllHooks: true, hooks: HOOKS }]) {
      const { wrapped, inner } = await wrappedWithInner(rig(document))
      const members = carried(inner)
      expect(members.length).toBeGreaterThan(0)
      for (const member of members) {
        const mutant: Record<string, unknown> = { ...wrapped }
        delete mutant[member]
        expect(droppedMembers(inner, mutant)).toEqual([member])
      }
    }
  })
})
