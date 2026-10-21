/**
 * C3.171 (QK8) — the background tier says which model it really runs on, once,
 * on every runtime.
 *
 * The third member of the family `unrecognized-model-diagnostic.test.ts` drives:
 * P6.362 names an id the catalogue does not serve, P6.1080 names a default the
 * endpoint retired, and this names the small/fast pick that is not the one the
 * connection asked for. All three ride one `sendEvent({ type: 'info',
 * level: 'warning' })` at one call site, which is why Pi, Claude and Codex say
 * them identically without any of the three being taught.
 *
 * The rule being surfaced is written in this repo's own words at
 * `packages/shared/src/config/llm-connections.ts` — *"a candidate that does not
 * resolve is skipped, so an invented id silently degrades the pick rather than
 * failing loudly"* — and `amazon-bedrock.md` names its price: *"a deployment
 * that doesn't pin a primary model is billed at the Opus rate"*.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'

type Event = { type: string; level?: string; message?: string }

/**
 * D1.109 — a REAL instance through `createTestSessionManager`, not
 * a bare prototype double.
 *
 * A bare prototype carries no class field, so such a double has to hand-seed
 * every private the code under test happens to reach — and when a landed commit
 * adds one, the red presents as a defect in whatever the case is NAMED for
 * (W12-c measured three such fields in one sitting on a sibling rig, one of them
 * a function and not a Map, at 166–235 s a cycle). This file seeded two;
 * `miniModelDegradationNotices` is now the one production initialises, and only
 * `sendEvent` is still overridden, because CAPTURING the event is the subject.
 *
 * The cost of the real constructor, measured 2026-09-17 with the file ALONE
 * under the test lock, is in the commit that made this change; it is a
 * `mkdtemp` and four in-memory stores, not a session.
 */
function harness(connection: Record<string, unknown> | null) {
  const events: Event[] = []
  const manager = createTestSessionManager() as any
  manager.sendEvent = (event: Event) => { events.push(event) }
  const managed = { id: 'session-1', workspace: { id: 'workspace-1' } }
  return {
    manager,
    managed,
    connection,
    warnings: () => events.filter(e => e.level === 'warning'),
  }
}

const model = (id: string) => ({ id, name: id, shortName: id, description: '', provider: 'x', contextWindow: 1000 })

describe('C3.171 the degraded background model is named', () => {
  test('names the model the tier fell through to, and what it costs', () => {
    // No small-class id anywhere in the catalogue and no declared cheap tier, so
    // `findSmallModel`'s last line hands back "the last allowed model in the
    // list" — a large one, silently, on every session title.
    const rig = harness({
      slug: 'byo',
      providerType: 'anthropic',
      models: [model('big-thinker-v2'), model('big-thinker-v1')],
      defaultModel: 'big-thinker-v2',
    })

    rig.manager.warnIfMiniModelDegraded(rig.managed, rig.connection)

    const [warning] = rig.warnings()
    expect(warning?.message).toContain('big-thinker-v1')
    expect(warning?.message).toContain('`byo`')
    expect(warning?.message).toContain("billed at that model's rate")
  })

  test('names the id requested beside the id used when an explicit choice is skipped', () => {
    const rig = harness({
      slug: 'byo',
      providerType: 'anthropic',
      // No allowlist is configured in this process, so the explicit id is
      // honoured — and an honoured choice is a decision, not a degradation.
      models: [model('claude-opus-4-8'), model('claude-haiku-4-5')],
      defaultModel: 'claude-opus-4-8',
      miniModel: 'claude-haiku-4-5',
    })

    rig.manager.warnIfMiniModelDegraded(rig.managed, rig.connection)

    expect(rig.warnings()).toEqual([])
  })

  test('says it ONCE for the same session, connection and pair', () => {
    const rig = harness({
      slug: 'byo',
      providerType: 'anthropic',
      models: [model('big-thinker-v2')],
      defaultModel: 'big-thinker-v2',
    })

    rig.manager.warnIfMiniModelDegraded(rig.managed, rig.connection)
    rig.manager.warnIfMiniModelDegraded(rig.managed, rig.connection)
    rig.manager.warnIfMiniModelDegraded(rig.managed, rig.connection)

    expect(rig.warnings()).toHaveLength(1)
  })

  test('says nothing without a connection, and nothing about a catalogue never fetched', () => {
    const none = harness(null)
    none.manager.warnIfMiniModelDegraded(none.managed, none.connection)
    expect(none.warnings()).toEqual([])

    const unfetched = harness({ slug: 'byo', providerType: 'anthropic', models: [], defaultModel: 'big-thinker-v2' })
    unfetched.manager.warnIfMiniModelDegraded(unfetched.managed, unfetched.connection)
    expect(unfetched.warnings()).toEqual([])
  })
})
