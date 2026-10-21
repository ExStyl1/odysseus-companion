import { beforeAll, describe, expect, it } from 'bun:test'
import type { AgentProvider } from '@nessy-agent/shared/agent/backend'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// Imported lazily for the same reason every other suite in this directory does
// it: `SessionManager.ts` pulls in `config/paths.ts`, whose CONFIG_DIR freezes
// at first import.
let withoutLoopSkill: typeof import('../SessionManager.ts')['withoutLoopSkillWhereCronToolsAreAbsent']
let cronToolsAbsent: typeof import('../SessionManager.ts')['cronToolsAbsentFor']
let bridgeKnownAbsent: typeof import('../SessionManager.ts')['schedulingBridgeKnownAbsent']
let LOOP_SLUG: string

// The explicit budget is not decoration: this hook imports `SessionManager.ts`
// — 1.3 MB and a wide module graph — and bun's default 5 s hook timeout is
// exceeded whenever the machine is busy, which collapses the WHOLE file into a
// single "(unnamed) … a beforeEach/afterEach hook timed out". Measured
// 2026-08-27 on this branch: the file at HEAD, unmodified, failed that way at
// 5 s / 15 s / 22 s / 37 s under load and passed in 1.0 s when idle, so the
// signature reads exactly like a real failure and is not one.
beforeAll(async () => {
  const mod = await import('../SessionManager.ts')
  withoutLoopSkill = mod.withoutLoopSkillWhereCronToolsAreAbsent
  cronToolsAbsent = mod.cronToolsAbsentFor
  bridgeKnownAbsent = mod.schedulingBridgeKnownAbsent
  LOOP_SLUG = mod.LOOP_SKILL_SLUG
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const SKILLS = [
  { logicalName: 'loop' },
  { logicalName: 'brainstorming' },
]

/**
 * T17 Step 5. `NESSY_DISABLE_CRON` was the only way the bundled `loop` skill
 * could leave, and it is not the only way its tools do. The skill is withheld
 * wherever its scheduler is absent, and the rows below are that condition.
 *
 * **The paragraph that used to stand here contradicted every assertion under
 * it** (P2.211). It said "all four cron tools are `visibility: 'pi-only'` … and
 * a non-Pi projection drops them", while the positive control below asserts the
 * skill is KEPT on `anthropic` and `codex-runtime` — the two runtimes that
 * claim was about. The assertions were right and the prose was dead: T1
 * generalized `SessionCronService` off the Pi path, T3 projected the four cron
 * tools onto Claude and T5 carried them to Codex over the host-callback bridge,
 * so `SESSION_TOOL_DEFS` marks none of them `pi-only` any more.
 *
 * What the condition IS, today: `cronToolsAbsentFor` is the env flag OR a
 * runtime outside `SCHEDULED_DELIVERY_RUNTIMES` — the three coding runtimes
 * that own a session scheduler. The surviving negative arm is therefore
 * `nestor-cloud-agent`, which runs no host-side tool loop for a fire to wake.
 *
 * A test comment must not restate a `visibility` value: it is computable from
 * `SESSION_TOOL_DEFS`, and the copy here had no way to learn the original moved.
 */
describe('withoutLoopSkillWhereCronToolsAreAbsent', () => {
  it('drops the loop skill on a runtime with no scheduler', () => {
    expect(withoutLoopSkill(SKILLS, 'nestor-cloud-agent' as AgentProvider).map(s => s.logicalName))
      .toEqual(['brainstorming'])
  })

  // The positive control. Without it the row above passes on a filter that
  // drops `loop` everywhere, which is the failure mode this shape invites.
  it('keeps it on every scheduled-delivery runtime', () => {
    for (const provider of ['pi', 'anthropic', 'codex-runtime'] as AgentProvider[]) {
      expect(withoutLoopSkill(SKILLS, provider).map(s => s.logicalName)).toEqual(['loop', 'brainstorming'])
    }
  })

  // A provider-blind read (no session yet) must not remove a skill on the
  // strength of a runtime nobody has picked. The env flag remains the only
  // thing that may.
  it('keeps it when the runtime is not yet known', () => {
    expect(withoutLoopSkill(SKILLS, undefined).map(s => s.logicalName)).toEqual(['loop', 'brainstorming'])
  })

  it('leaves a skill list without the loop skill untouched', () => {
    const others = [{ logicalName: 'brainstorming' }, { logicalName: 'debugging' }]
    expect(withoutLoopSkill(others, 'nestor-cloud-agent' as AgentProvider)).toEqual(others)
  })
})

/**
 * T20. The condition above was applied to the slash-command list and to the
 * model-facing runtime view — and NOT to the composer catalog, which is the
 * list the palette actually renders. Measured live as RTS-11 on packaged
 * 1.26.1: `/loop` was offered identically on Pi, Claude and Codex, so a user on
 * Claude could pick a command whose four scheduling tools do not exist there.
 * Nothing errors; the model answers as though it had scheduled something.
 *
 * The catalog is a MIXED capability list, which is why its call site needs the
 * bare condition and a kind guard rather than the skill-list helper.
 */
describe('cronToolsAbsentFor — the condition the composer catalog needs', () => {
  it('is true on a runtime that owns no scheduler', () => {
    expect(cronToolsAbsent('nestor-cloud-agent' as AgentProvider)).toBe(true)
  })

  it('is false on every scheduled-delivery runtime, and when the runtime is not yet known', () => {
    for (const provider of ['pi', 'anthropic', 'codex-runtime'] as AgentProvider[]) {
      expect(cronToolsAbsent(provider)).toBe(false)
    }
    expect(cronToolsAbsent(undefined)).toBe(false)
  })

  // The kind guard the catalog call site adds, asserted as the shape it
  // protects: a SOURCE named `loop` is not the bundled skill and must survive.
  // The skill-list helper cannot make this distinction because its lists hold
  // only skills.
  it('a non-skill capability named loop is not what the guard removes', () => {
    const items = [
      { kind: 'skill', logicalName: LOOP_SLUG },
      { kind: 'source', logicalName: LOOP_SLUG },
      { kind: 'skill', logicalName: 'brainstorming' },
    ]
    const kept = items.filter(item => !(item.kind === 'skill' && item.logicalName === LOOP_SLUG))
    expect(kept).toEqual([
      { kind: 'source', logicalName: LOOP_SLUG },
      { kind: 'skill', logicalName: 'brainstorming' },
    ])
  })
})

/**
 * P2.280. The condition above was a pure function of the runtime NAME, and on
 * codex the name is not the whole story: `codex-runtime` earns its place in
 * `SCHEDULED_DELIVERY_RUNTIMES` only when its T5 host-callback bridge started,
 * and `CodexAgent.startCallbackBridge` fails NON-FATALLY BY DESIGN ("scheduling
 * tools stay unavailable this session"). Measured on HEAD: an unbridged codex
 * surface is 18 tools with none of `CRON_TOOL_NAMES`; a bridged one is 26 with
 * all four. So a session whose bridge failed was offered `/loop` for its whole
 * life with nothing behind it.
 *
 * The rows below pin the predicate half. What they deliberately do NOT claim is
 * that the gate closes the first turn: measured, it cannot. `managed.agent` is
 * assigned inside `getOrCreateAgentUnchecked`, which `withCapabilityRuntime`
 * reaches only AFTER `createCapabilityTurn` has already frozen the view, and the
 * bridge is started later still inside the chat generator's `ensureRuntime()`.
 * Turn one of a bridge-less session therefore reads `not-started` and keeps the
 * skill — which is why `'not-started'` has its own row here, as a boundary and
 * not as an oversight.
 */
describe('P2.280 · schedulingBridgeKnownAbsent — only a KNOWN failure withholds', () => {
  it('is true only for the unavailable state', () => {
    expect(bridgeKnownAbsent({ getSchedulingBridgeState: () => 'unavailable' })).toBe(true)
  })

  // The boundary that matters most: `not-started` is the state of every codex
  // session before its first turn. Reading it as absent would withhold `/loop`
  // from every codex session, which is the mirror of the bug being fixed.
  it('is false for not-started and for active', () => {
    expect(bridgeKnownAbsent({ getSchedulingBridgeState: () => 'not-started' })).toBe(false)
    expect(bridgeKnownAbsent({ getSchedulingBridgeState: () => 'active' })).toBe(false)
  })

  // Every non-codex backend, plus the cold session that has no agent at all.
  // Absence of the accessor is absence of EVIDENCE, never evidence of absence.
  it('is false for a backend that keeps no bridge, and for no agent at all', () => {
    expect(bridgeKnownAbsent(undefined)).toBe(false)
    expect(bridgeKnownAbsent(null)).toBe(false)
    expect(bridgeKnownAbsent({})).toBe(false)
    expect(bridgeKnownAbsent({ getSchedulingBridgeState: 'not a function' })).toBe(false)
  })

  it('is false when the accessor throws — a probe must never fail a turn', () => {
    expect(bridgeKnownAbsent({
      getSchedulingBridgeState: () => { throw new Error('agent disposed') },
    })).toBe(false)
  })
})

describe('P2.280 · a bridge-less codex session stops being offered /loop', () => {
  it('cronToolsAbsentFor is true on codex-runtime once the bridge is known absent', () => {
    expect(cronToolsAbsent('codex-runtime' as AgentProvider, true)).toBe(true)
  })

  // The positive control. Without it, the row above passes on a predicate that
  // returns true for codex unconditionally — which would be the old bug with a
  // new spelling.
  it('and stays false while the bridge is up or not yet attempted', () => {
    expect(cronToolsAbsent('codex-runtime' as AgentProvider, false)).toBe(false)
    expect(cronToolsAbsent('codex-runtime' as AgentProvider)).toBe(false)
  })

  it('the skill filter drops loop on a bridge-less codex session', () => {
    expect(withoutLoopSkill(SKILLS, 'codex-runtime' as AgentProvider, true).map(s => s.logicalName))
      .toEqual(['brainstorming'])
  })

  it('and keeps it while the bridge is up or not yet attempted', () => {
    expect(withoutLoopSkill(SKILLS, 'codex-runtime' as AgentProvider, false).map(s => s.logicalName))
      .toEqual(['loop', 'brainstorming'])
  })

  /**
   * MEASURED, and it corrected this row's first draft. That draft asserted the
   * opposite — that a `true` paired with a non-codex provider must NOT strip the
   * skill — and the predicate failed it, correctly.
   *
   * The bridge condition is AUTHORITATIVE rather than provider-scoped, and it
   * has to be. Making it `provider === 'codex-runtime' && bridgeAbsent` would
   * plant a SECOND copy of "which runtime owns a host-callback bridge" in a file
   * that cannot see `CodexAgent` — the two-lists-must-agree drift this suite's
   * own history is a record of. The narrowing is done where the fact lives
   * instead: `schedulingBridgeKnownAbsent` answers `false` for anything that
   * does not publish the accessor, and only `CodexAgent` does, so Pi and Claude
   * cannot reach this branch. The rows above pin that half.
   */
  it('a known-absent bridge withholds whatever the provider says', () => {
    expect(withoutLoopSkill(SKILLS, undefined, true).map(s => s.logicalName))
      .toEqual(['brainstorming'])
  })
})

/**
 * The WIRING, pinned as source text.
 *
 * A predicate nobody calls is the failure this plan has been burned by twice, and
 * neither call site can be driven from a unit test: `createCapabilityTurn` needs a
 * live `SessionManager` with a resolved capability lease, and `skillSlashCommands`
 * needs a pinned snapshot. `codex-callback-bridge-host.test.ts` reads
 * `codex-agent.ts` as source text for exactly this reason. Two directions are
 * asserted — that both sites pass the condition, and that the accessor's NAME
 * matches the one `CodexAgent` publishes — because a duck-typed probe that
 * silently misses is indistinguishable from a bridge that is up.
 */
describe('P2.280 · the condition reaches both skill surfaces', () => {
  it('both call sites pass the bridge condition, not just the provider', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
      'utf-8',
    )
    const calls = source.split('withoutLoopSkillWhereCronToolsAreAbsent(').slice(1)
    // The declaration is excluded for free: it spells the generic
    // (`…AreAbsent<T extends …>(`), so the split lands only on invocations.
    expect(calls.length).toBe(2)
    for (const call of calls) {
      // A bounded window, not a scan to the closing paren: both argument lists
      // are three short lines, and an unbounded slice makes a FAILURE here dump
      // half the file instead of the call that lost its argument.
      expect(call.slice(0, 200)).toContain('schedulingBridgeKnownAbsent(')
    }
  })

  it('the probed method name is the one CodexAgent publishes', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const agentSource = readFileSync(
      fileURLToPath(new URL('../../../../shared/src/agent/codex-agent.ts', import.meta.url)),
      'utf-8',
    )
    expect(agentSource).toContain('getSchedulingBridgeState(): CodexSchedulingBridgeState {')
    const managerSource = readFileSync(
      fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
      'utf-8',
    )
    expect(managerSource).toContain("probe.getSchedulingBridgeState() === 'unavailable'")
  })
})
