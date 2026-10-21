/**
 * P3.374 — `PreModelSwitch` / `PostModelSwitch` fire on the one seam that
 * switches a session's model, and a `PreModelSwitch` block really cancels.
 *
 * ## Why this matters more than a missing hook usually does
 *
 * Both events were DEFERRED under `plugin.deferred.event_model_switch_no_emitter`
 * with an honest reason: `updateSessionModel` is a real seam and nothing emitted
 * on it. hooks.md#premodelswitch makes the event fail CLOSED — "A PreModelSwitch
 * hook that doesn't respond before its timeout blocks the switch" — so an author
 * who registered one and saw it accepted had a guard that let through exactly
 * what it was written to block.
 *
 * ## What the assertions are keyed on
 *
 * The BLOCK is asserted on the effects, not on the return value: a cancelled
 * switch must leave `managed.model` and the agent's own model untouched, because
 * a hook that "blocks" while the write has already happened blocks nothing. The
 * ORDER is asserted too — Pre before the write, Post after it — since the page
 * separates them by exactly that.
 *
 * The dispatcher is `managed.agentAutomationSystem`, which is the HOST's and is
 * the same object for Pi, claude-runtime and codex; there is no per-runtime
 * branch in the emitter, so one fixture proves all three.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PiAgent } from '@nessy-agent/shared/agent/pi-agent'
import type { BackendConfig } from '@nessy-agent/shared/agent/backend/types'
import { getAgentEventContractV1 } from '@nessy-agent/shared/automations/types'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

interface Recorded {
  event: string
  input: Record<string, unknown>
  modelAtCall: string | undefined
}

function rig(decision?: Record<string, unknown>) {
  const manager = createTestSessionManager()
  const workspace = {
    id: 'workspace-ms', name: 'Workspace MS', rootPath: '/tmp/nessy-model-switch',
    workspaceRootPath: '/tmp/nessy-model-switch', sessionRootPath: '/tmp/nessy-model-switch-sessions',
    config: { id: 'workspace-ms', name: 'Workspace MS', createdAt: 1, updatedAt: 1 },
    lastAccessedAt: 1,
  }
  const agent = new PiAgent({
    provider: 'pi', workspace,
    session: { id: 'ms-session', workspaceId: workspace.id, workspaceRootPath: workspace.rootPath, createdAt: 1, lastUsedAt: 1 },
    model: 'old-model', isHeadless: true,
  } as BackendConfig)
  const recorded: Recorded[] = []
  const system = {
    async executeAgentEvent(event: string, input: Record<string, unknown>) {
      // The model AT THE MOMENT OF THE CALL is what separates "before the
      // write" from "after" — reading it afterwards would prove nothing.
      recorded.push({ event, input, modelAtCall: managed.model })
      if (event === 'PreModelSwitch' && decision) return { matchedCount: 1, decision }
      return { matchedCount: 1 }
    },
  }
  const managed: any = {
    id: 'ms-session', workspace, permissionMode: 'default', thinkingLevel: 'off', model: 'old-model',
    llmConnection: 'pi', agent, messages: [], messagesLoaded: true, backgroundShellCommands: new Map(),
    agentAutomationSystem: system,
  }
  ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }), managed)
  ;(manager as any).writeSessionMetadata = async () => {}
  ;(manager as any).persistSession = () => {}
  // P6.377 — the warm-cache warning rides `sendEvent`, so it is RECORDED here
  // rather than swallowed; a rig that discarded it could not see that half.
  const events: { type: string; message?: string; level?: string }[] = []
  ;(manager as any).sendEvent = (event: { type: string; message?: string; level?: string }) => { events.push(event) }
  // MEASURED, not assumed, and it found a real defect rather than a fixture
  // quirk: `managed.agentAutomationSystem` is a PER-CAPABILITY-TURN object,
  // cleared when the lease is released, and a model switch happens between
  // turns. The first emitter read the field directly, so it fired Pre only
  // because this fixture had planted a system by hand and fired Post never. The
  // production fix routes both through `withPinnedConfigChange`; this builder is
  // what that mechanism calls, and it returns one recorder so every instance
  // answers to one array.
  // A STABLE instance, deliberately: the field is cleared between capability
  // turns, so returning `managed.agentAutomationSystem` here would hand back
  // `undefined` on the second lease and the fixture would report a missing
  // emitter that is present.
  ;(manager as any).buildAgentAutomationSystem = async () => system
  return { manager, workspace, managed, agent, recorded, events }
}

describe('P3.374 · the model-switch hook pair', () => {
  test('fires Pre before the write and Post after it, with the documented identity fields', async () => {
    const { manager, workspace, managed, agent, recorded } = rig()
    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')

    const switches = recorded.filter(r => r.event.endsWith('ModelSwitch'))
    expect(switches.map(r => r.event)).toEqual(['PreModelSwitch', 'PostModelSwitch'])
    // Ordering, keyed on the write itself rather than on call order alone.
    expect(switches[0]!.modelAtCall).toBe('old-model')
    expect(switches[1]!.modelAtCall).toBe('new-model')

    for (const entry of switches) {
      expect(entry.input.hook_event_name).toBe(entry.event)
      expect(entry.input.from_model).toBe('old-model')
      expect(entry.input.to_model).toBe('new-model')
      expect(entry.input.requested_model).toBe('new-model')
      // The page's vocabulary; this seam is a client asking the host to set a
      // model, which is what `sdk` names.
      expect(entry.input.source).toBe('sdk')
      // P6.377 CORRECTED THIS PIN. Three of the five need vendor pricing this
      // host does not have and stay absent rather than zeroed — a `0` would be
      // a false cost report to a hook written to display one. The other two are
      // recoverable, and are absent HERE only because this fixture's session has
      // reported no usage yet; the warm-cache test below is the positive arm.
      for (const field of ['cache_ttl', 'estimated_cache_write_usd', 'pricing']) {
        expect(entry.input[field], field).toBeUndefined()
      }
      for (const field of ['context_tokens', 'prompt_cache_warm']) {
        expect(entry.input[field], field).toBeUndefined()
      }
    }
    agent.destroy()
    await manager.cleanup()
  })

  test('a PreModelSwitch block cancels the switch, leaving model and agent untouched', async () => {
    const { manager, workspace, managed, agent, recorded } = rig({ decision: 'block', reason: 'not on this project' })
    const before = agent.getModel()
    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')

    // The effects, not the return value: a hook that "blocks" after the write
    // has happened blocks nothing.
    expect(managed.model).toBe('old-model')
    expect(agent.getModel()).toBe(before)
    // And nothing downstream ran — no Post, and no ConfigChange for a commit
    // that never happened.
    expect(recorded.map(r => r.event)).toEqual(['PreModelSwitch'])
    agent.destroy()
    await manager.cleanup()
  })

  test('an allow decision is not a block — the negative control for the case above', async () => {
    // Without this, a `blocked` predicate that returned true for every decision
    // would satisfy the block test and never be caught.
    const { manager, workspace, managed, agent, recorded } = rig({ decision: 'allow' })
    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')
    expect(managed.model).toBe('new-model')
    expect(recorded.map(r => r.event)).toContain('PostModelSwitch')
    agent.destroy()
    await manager.cleanup()
  })

  /**
   * P6.377 — the two cost fields the host CAN answer, and the one warning.
   *
   * `hooks.md#premodelswitch` lists five cost fields; the emitter omitted all
   * five because "a `0` would be a false cost report". That is right for the
   * three that need vendor pricing and wrong for these two, which
   * `managed.tokenUsage` already held — and omitting a field it can fill leaves
   * a `PreModelSwitch` gate unable to say anything about the switch it gates.
   */
  test('a warm session reports context_tokens and prompt_cache_warm, and is warned exactly once', async () => {
    const { manager, workspace, managed, agent, recorded, events } = rig()
    managed.tokenUsage = {
      inputTokens: 40_000, outputTokens: 1_000, totalTokens: 41_000, contextTokens: 40_000,
      costUsd: 0, cacheReadTokens: 30_000, cacheCreationTokens: 0, cacheObservedAt: Date.now(),
    }
    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')

    const pre = recorded.find(entry => entry.event === 'PreModelSwitch')!
    expect(pre.input.context_tokens).toBe(40_000)
    expect(pre.input.prompt_cache_warm).toBe(true)
    // The two that need vendor rates stay ABSENT, not zeroed.
    for (const field of ['estimated_cache_write_usd', 'pricing']) {
      expect(pre.input[field], field).toBeUndefined()
    }
    // And `cache_ttl` is absent HERE for a different reason than those two: this
    // session carries no resolved lifetime, which the page's vocabulary spells
    // as "the runtime's own default". See the C4.22 pair below.
    expect(pre.input.cache_ttl).toBeUndefined()
    const warnings = events.filter(event => event.level === 'warning')
    expect(warnings).toHaveLength(1)
    // Both halves in the one line: the cache is discarded, and this host cannot
    // price the re-send — which is what the three absent fields mean.
    expect(warnings[0]!.message).toContain('30000')

    // A second switch is a user who has already been told.
    await manager.updateSessionModel(managed.id, workspace.id, 'third-model')
    expect(events.filter(event => event.level === 'warning')).toHaveLength(1)
    agent.destroy()
    await manager.cleanup()
  })

  /**
   * The boundary. Without the TTL, a session idle overnight would report a warm
   * cache it certainly no longer has, and would warn about discarding it.
   */
  test('a reading older than the assumed TTL is cold, and warns nobody', async () => {
    const { manager, workspace, managed, agent, recorded, events } = rig()
    managed.tokenUsage = {
      inputTokens: 40_000, outputTokens: 1_000, totalTokens: 41_000, contextTokens: 40_000,
      costUsd: 0, cacheReadTokens: 30_000, cacheCreationTokens: 0,
      cacheObservedAt: Date.now() - 60 * 60_000,
    }
    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')
    const pre = recorded.find(entry => entry.event === 'PreModelSwitch')!
    // `false`, not absent: a reading exists and it says cold. Absent means "no
    // reading", which a hook must be able to tell apart from "cold".
    expect(pre.input.prompt_cache_warm).toBe(false)
    expect(pre.input.context_tokens).toBe(40_000)
    expect(events.filter(event => event.level === 'warning')).toEqual([])
    agent.destroy()
    await manager.cleanup()
  })

  /**
   * C4.22 — `cache_ttl`, the third fillable cost field, and the staleness window
   * it also fixes.
   *
   * `hooks.md#premodelswitch`: "Prompt cache lifetime Claude Code requests for
   * this session: `"5m"` or `"1h"`". That is a question about the request this
   * host makes, not about anyone's rates, and the host resolves it itself
   * (`resolvePromptCacheTtl`) and stamps it on `tokenUsage.cache.ttl`.
   */
  test('reports the resolved cache_ttl, and measures warmth against it rather than five minutes', async () => {
    const { manager, workspace, managed, agent, recorded } = rig()
    managed.tokenUsage = {
      inputTokens: 40_000, outputTokens: 1_000, totalTokens: 41_000, contextTokens: 40_000,
      costUsd: 0, cacheReadTokens: 30_000, cacheCreationTokens: 0,
      // Half an hour old: COLD under the five-minute constant this replaced, and
      // warm under the hour the operator actually asked for. That is the whole
      // behaviour change, and it is why the two arms of this pair use the same
      // observation time.
      cacheObservedAt: Date.now() - 30 * 60_000,
      cache: { warmth: 'warm', hitRate: 0.75, cacheReadTokens: 30_000, cacheCreationTokens: 0, ttl: '1h' },
    }
    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')
    const pre = recorded.find(entry => entry.event === 'PreModelSwitch')!
    expect(pre.input.cache_ttl).toBe('1h')
    expect(pre.input.prompt_cache_warm).toBe(true)
    // Still no money: `cache_ttl` is a lifetime, and the two that need vendor
    // rates did not become answerable by its arrival.
    expect(pre.input.estimated_cache_write_usd).toBeUndefined()
    expect(pre.input.pricing).toBeUndefined()
    agent.destroy()
    await manager.cleanup()
  })

  /** The negative arm of the pair above: the same reading under a `5m` lifetime. */
  test('a 5m lifetime keeps the short window, so the same reading is cold', async () => {
    const { manager, workspace, managed, agent, recorded } = rig()
    managed.tokenUsage = {
      inputTokens: 40_000, outputTokens: 1_000, totalTokens: 41_000, contextTokens: 40_000,
      costUsd: 0, cacheReadTokens: 30_000, cacheCreationTokens: 0,
      cacheObservedAt: Date.now() - 30 * 60_000,
      cache: { warmth: 'warm', hitRate: 0.75, cacheReadTokens: 30_000, cacheCreationTokens: 0, ttl: '5m' },
    }
    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')
    const pre = recorded.find(entry => entry.event === 'PreModelSwitch')!
    expect(pre.input.cache_ttl).toBe('5m')
    // `false`, not absent — a reading exists and it says cold.
    expect(pre.input.prompt_cache_warm).toBe(false)
    agent.destroy()
    await manager.cleanup()
  })

  /** "a mid-session model OR EFFORT change" — the second seam, same warning. */
  test('an effort change warns too, and re-picking the level in force does not', async () => {
    const { manager, workspace, managed, agent, events } = rig()
    managed.tokenUsage = {
      inputTokens: 10, outputTokens: 1, totalTokens: 11, contextTokens: 10,
      costUsd: 0, cacheReadTokens: 5, cacheCreationTokens: 0, cacheObservedAt: Date.now(),
    }
    await manager.setSessionThinkingLevel(managed.id, 'off', workspace.id)
    expect(events.filter(event => event.level === 'warning')).toEqual([])
    await manager.setSessionThinkingLevel(managed.id, 'high', workspace.id)
    expect(events.filter(event => event.level === 'warning')).toHaveLength(1)
    agent.destroy()
    await manager.cleanup()
  })

  /**
   * C3.208 — the declaration and the emitter, compared, which nothing did.
   *
   * `AGENT_EVENT_CONTRACTS_V1`'s `redactedPayload` is what an author is shown a
   * model-switch hook carries. It listed the four identity fields for two days
   * while `modelSwitchCostFields` spread three more into BOTH payloads, and the
   * residue survived because the two halves live in different packages and no
   * test read them together — AGENTS.md §Traps' "an assertion about another
   * module's behaviour has no guard" in its cheapest form.
   *
   * The fixture is the maximal payload deliberately: a warm session with a
   * resolved lifetime is the only shape that produces every fillable field at
   * once, so a field added to the emitter and not to the contract reddens here.
   * `hook_event_name` is the envelope `runModelSwitchHook` stamps, not a payload
   * field, and is excluded by name rather than by a filter that would also hide
   * a real omission.
   */
  test('every field the emitter can produce is declared in the contract, and the two it cannot are not', async () => {
    const { manager, workspace, managed, agent, recorded } = rig()
    managed.tokenUsage = {
      inputTokens: 40_000, outputTokens: 1_000, totalTokens: 41_000, contextTokens: 40_000,
      costUsd: 0, cacheReadTokens: 30_000, cacheCreationTokens: 0,
      cacheObservedAt: Date.now(),
      cache: { warmth: 'warm', hitRate: 0.75, cacheReadTokens: 30_000, cacheCreationTokens: 0, ttl: '1h' },
    }
    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')

    for (const event of ['PreModelSwitch', 'PostModelSwitch'] as const) {
      const entry = recorded.find(recordedEntry => recordedEntry.event === event)!
      const declared = getAgentEventContractV1(event, 1).redactedPayload as readonly string[]
      const emitted = Object.keys(entry.input).filter(key => key !== 'hook_event_name')
      // Positive control on the fixture itself: if the warm session stopped
      // producing the cost fields, the subset check below would pass vacuously.
      expect(emitted, event).toContain('cache_ttl')
      expect(emitted, event).toContain('prompt_cache_warm')
      expect(emitted, event).toContain('context_tokens')
      for (const key of emitted) expect(declared, `${event}.${key}`).toContain(key)
      // The two that need vendor rates are neither emitted nor promised.
      for (const key of ['estimated_cache_write_usd', 'pricing']) {
        expect(declared, `${event}.${key}`).not.toContain(key)
      }
    }
    agent.destroy()
    await manager.cleanup()
  })

  test('a hook that throws fails OPEN, because a crashed plugin has decided nothing', async () => {
    const { manager, workspace, managed, agent } = rig()
    ;(manager as any).buildAgentAutomationSystem = async () => ({
      async executeAgentEvent() { throw new Error('plugin exploded') },
    })
    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')
    expect(managed.model).toBe('new-model')
    agent.destroy()
    await manager.cleanup()
  })
})

/**
 * D1.217 — the model switch this HOST makes on its own, announced.
 *
 * ## What the owner asked for, and what the page had already answered
 *
 * The row proposed "a `source` discriminator plus a host-side mint" at the
 * fallback sites. Both halves were already settled by `hooks.md`, and reading it
 * changed the build rather than confirming it:
 *
 * - the discriminator EXISTS and is spelled by the vendor —
 *   `#postmodelswitch-input` gives this event `auto` (a change Claude Code made
 *   on its own) and `resume` on top of `PreModelSwitch`'s `command | picker |
 *   sdk`. An invented `'runtime'` would have been a fourth spelling.
 * - the SITES are refuted: *"Claude Code doesn't run PostModelSwitch hooks when
 *   a model from a fallback model chain serves a turn, because that
 *   substitution lasts one turn and leaves the session's model unchanged."*
 *   `resolveFallbackModelChain` on pi and codex, and claude's
 *   `model_refusal_fallback`, are all exactly that.
 * - and `PreModelSwitch` must NOT fire: *"Claude Code doesn't run PreModelSwitch
 *   hooks for switches it makes on its own … Those changes reach PostModelSwitch
 *   only."*
 *
 * The site that DOES qualify is the runtime switch, where this host writes
 * `managed.model` outside `updateSessionModel`.
 *
 * ## Why the arms drive the flush rather than the whole switch
 *
 * The announcement is DEFERRED by construction — the switch path disposes the
 * agent and asserts it is gone — so the mechanism under test is the flush, and
 * these drive the REAL method with a REAL recorder rather than a stub of it. The
 * wiring into agent construction is pinned by a source arm, the instrument this
 * file's neighbours already use on that same method.
 */
describe('D1.217 · a host-made model switch reaches PostModelSwitch, and only it', () => {
  function flushRig(pending?: Record<string, unknown>) {
    const manager = createTestSessionManager()
    const seen: Recorded[] = []
    const system = {
      async executeAgentEvent(event: string, input: Record<string, unknown>) {
        seen.push({ event, input, modelAtCall: undefined })
        return { matchedCount: 1 }
      },
    }
    const managed: any = {
      id: 'ms-auto', workspace: { id: 'workspace-ms', rootPath: '/tmp/nessy-model-switch' },
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, contextTokens: 51_000, costUsd: 0 },
      ...(pending ? { pendingModelSwitchHook: pending } : {}),
    }
    return { manager, managed, system, seen }
  }

  test('emits PostModelSwitch with the vendor\'s own `auto` source and a null requested_model', async () => {
    const { manager, managed, system, seen } = flushRig({
      from_model: 'old-model', to_model: 'new-model', source: 'auto',
    })

    await (manager as any).flushPendingModelSwitchHook(managed, system)

    expect(seen.map(entry => entry.event)).toEqual(['PostModelSwitch'])
    expect(seen[0]!.input).toMatchObject({
      hook_event_name: 'PostModelSwitch',
      from_model: 'old-model',
      to_model: 'new-model',
      requested_model: null,
      source: 'auto',
    })
    // The same cost producer the user-initiated switch uses, so a hook cannot
    // tell the two occurrences apart by which fields arrived.
    expect(seen[0]!.input.context_tokens).toBe(51_000)
    // hooks.md#premodelswitch: a switch Claude Code makes on its own reaches
    // PostModelSwitch ONLY. This is the assertion that keeps it there.
    expect(seen.some(entry => entry.event === 'PreModelSwitch')).toBe(false)
    await manager.cleanup()
  })

  test('CONTROL — it fires ONCE, and a session with nothing pending announces nothing', async () => {
    const { manager, managed, system, seen } = flushRig({
      from_model: 'old-model', to_model: 'new-model', source: 'auto',
    })

    await (manager as any).flushPendingModelSwitchHook(managed, system)
    // Consumed before dispatch: every later agent construction in the session
    // would otherwise re-announce a switch that happened once.
    await (manager as any).flushPendingModelSwitchHook(managed, system)
    expect(seen).toHaveLength(1)

    const quiet = flushRig()
    await (quiet.manager as any).flushPendingModelSwitchHook(quiet.managed, quiet.system)
    expect(quiet.seen).toEqual([])
    await quiet.manager.cleanup()
    await manager.cleanup()
  })

  test('BOUNDARY — no automation system KEEPS the record instead of dropping it', async () => {
    const { manager, managed, system, seen } = flushRig({
      from_model: 'old-model', to_model: 'new-model', source: 'auto',
    })

    await (manager as any).flushPendingModelSwitchHook(managed, undefined)
    // Dropping it here would make the event depend on whether a capability view
    // happened to build — "a hook that silently does not exist".
    expect(managed.pendingModelSwitchHook).toBeDefined()

    await (manager as any).flushPendingModelSwitchHook(managed, system)
    expect(seen).toHaveLength(1)
    await manager.cleanup()
  })

  test('the flush is WIRED into agent construction, before the agent is handed the system', async () => {
    // A source pin, and this file's neighbours use the same instrument on this
    // same method for the same reason: the behaviour is three layers inside a
    // capability lease, and the ORDER is the load-bearing part — after the
    // system exists, before `setAutomationSystem`, so it rides the lease that is
    // already held rather than asking for a second one.
    const source = readFileSync(
      new URL('./SessionManager.ts', import.meta.url),
      'utf8',
    )
    const build = source.indexOf('const agentAutomationSystem = await this.buildAgentAutomationSystem')
    const flush = source.indexOf('await this.flushPendingModelSwitchHook(managed, agentAutomationSystem)')
    const hand = source.indexOf('managed.agent?.setAutomationSystem(agentAutomationSystem)')
    expect(build).toBeGreaterThan(-1)
    expect(flush).toBeGreaterThan(build)
    expect(hand).toBeGreaterThan(flush)
    // NEGATIVE CONTROL: the flush must not also sit inside `runModelSwitchHook`,
    // whose `withPinnedConfigChange` would ask for a second capability lease.
    expect(source.indexOf('withPinnedConfigChange')).toBeGreaterThan(-1)
    expect(
      source.slice(flush, flush + 400).includes('withPinnedConfigChange'),
    ).toBe(false)
  })
})
