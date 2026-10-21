/**
 * P3.70 — the switch re-picks the session's UTILITY model, and nothing said so.
 *
 * Only the MAIN model was ever reported at switch time: `switchSessionRuntime`
 * returns `previousModel`/`model` and the renderer turns a difference into
 * `chat.runtimeSwitch.modelReset`. The utility model — titles, summaries, mini
 * completions, and the SDK's built-in tools through
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL` — is a per-CONNECTION field, so a switch
 * silently re-resolves it: a user who chose a cheap side model does not keep it.
 *
 * The report is computed with the HOST's own expression, `getMiniModel(conn) ??
 * conn.defaultModel`, which is what `createAgentForSession` hands the backend as
 * `config.miniModel` — so this suite drives the real `getMiniModel` rather than
 * a stand-in, and a change to that resolution shows up here.
 */

import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { LlmConnection } from '@nessy-agent/shared/config'
import { createTestSessionManager } from './test-session-manager.ts'

const source = readFileSync(
  fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
  'utf-8',
)

const connection = (over: Partial<LlmConnection>): LlmConnection => ({
  slug: 'conn',
  name: 'Conn',
  providerType: 'openai_compat',
  authType: 'api_key',
  ...over,
} as LlmConnection)

function fixture() {
  const emitted: Array<{ event: Record<string, unknown>; workspaceId: string }> = []
  const manager = createTestSessionManager() as any
  manager.sendEvent = mock((event: Record<string, unknown>, workspaceId: string) => {
    emitted.push({ event, workspaceId })
  })
  const managed: any = {
    id: 'session-utility',
    workspace: { id: 'workspace-utility', name: 'Utility', rootPath: '/tmp/utility' },
  }
  return { manager, managed, emitted }
}

describe('P3.70 · the side model a switch re-picks', () => {
  it('names both ends when the switch changes it', () => {
    const { manager, managed, emitted } = fixture()
    manager.reportUtilityModelChange(
      managed,
      connection({ slug: 'from', models: ['big-1', 'cheap-1'], defaultModel: 'big-1' }),
      connection({ slug: 'to', models: ['other-1', 'other-cheap-1'], defaultModel: 'other-1' }),
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.workspaceId).toBe('workspace-utility')
    expect(emitted[0]!.event).toMatchObject({ type: 'info', level: 'warning', sessionId: 'session-utility' })
    const message = emitted[0]!.event.message as string
    // Both ends, because "your side model changed" without the two names is not
    // actionable — the same rule `chat.runtimeSwitch.modelReset` follows.
    expect(message).toContain('cheap-1')
    expect(message).toContain('other-cheap-1')
    // P2.196: an uninitialised i18next answers `undefined`, not the key.
    expect(message).not.toBe('chat.runtimeSwitch.utilityModelChanged')
  })

  it('is silent when the two integrations resolve to the same side model', () => {
    const { manager, managed, emitted } = fixture()
    const models = ['big-1', 'cheap-1']
    manager.reportUtilityModelChange(
      managed,
      connection({ slug: 'from', models, defaultModel: 'big-1' }),
      connection({ slug: 'to', models, defaultModel: 'big-1' }),
    )
    // The common case: all three gateway cards share one catalogue, so most
    // switches keep the side model and must say nothing at all.
    expect(emitted).toHaveLength(0)
  })

  it('honours an explicit `miniModel` slot on either side', () => {
    const { manager, managed, emitted } = fixture()
    manager.reportUtilityModelChange(
      managed,
      connection({ slug: 'from', models: ['big-1', 'cheap-1'], miniModel: 'big-1' }),
      connection({ slug: 'to', models: ['big-1', 'cheap-1'] }),
    )
    // The user PICKED `big-1` as the side model on the source; the target has no
    // slot, so the heuristic takes the last entry. That is precisely the loss
    // this row is about, and it is only visible because the report reads the
    // explicit slot rather than the heuristic alone.
    expect(emitted).toHaveLength(1)
    const message = emitted[0]!.event.message as string
    expect(message).toContain('big-1')
    expect(message).toContain('cheap-1')
  })

  it('falls back to the connection default, exactly as the host does', () => {
    const { manager, managed, emitted } = fixture()
    // No `models` at all → `getMiniModel` answers `undefined` and every host
    // call site reads `?? connection.defaultModel`.
    manager.reportUtilityModelChange(
      managed,
      connection({ slug: 'from', defaultModel: 'sole-1' }),
      connection({ slug: 'to', defaultModel: 'sole-2' }),
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.event.message as string).toContain('sole-2')
  })

  it('says nothing when either side cannot be resolved', () => {
    for (const [from, to] of [
      [undefined, connection({ models: ['a', 'b'] })],
      [connection({ models: ['a', 'b'] }), connection({})],
    ] as Array<[LlmConnection | undefined, LlmConnection]>) {
      const { manager, managed, emitted } = fixture()
      manager.reportUtilityModelChange(managed, from, to)
      // A report that names `undefined` on one end is worse than no report:
      // it reads as "your side model was removed".
      expect(emitted).toHaveLength(0)
    }
  })
})

describe('P3.70 · where the report is taken from', () => {
  /**
   * The source connection must be read BEFORE the switch rewrites
   * `managed.llmConnection`; after it, both sides are the target and the report
   * is silent for ever. Asserted by ORDER against the source, the instrument
   * `permission-policy-notice.test.ts` established, because
   * `switchSessionRuntime` is a 400-line method behind a mutation boundary.
   */
  it('captures the source connection before the switch rewrites it', () => {
    const method = source.slice(source.indexOf('  async switchSessionRuntime('))
    expect(method.length).toBeGreaterThan(0)
    const capture = method.indexOf('const sourceConnection =')
    const report = method.indexOf('this.reportUtilityModelChange(')
    // The CALL, not the first mention: three comments in this method name the
    // same function, and anchoring on prose would make the ordering claim move
    // whenever one of them is reworded.
    const teardown = method.indexOf('this.clearRuntimeScopedSessionState(managed, fromProvider)')
    expect(capture).toBeGreaterThan(-1)
    expect(report).toBeGreaterThan(-1)
    expect(teardown).toBeGreaterThan(-1)
    expect(capture).toBeLessThan(teardown)
    expect(report).toBeGreaterThan(teardown)

    /**
     * …and captures the SESSION's connection, not the target's.
     *
     * Added after a mutation SURVIVED (M10): rewriting the capture to
     * `getLlmConnection(connectionSlug)` left every assertion above green,
     * because the ordering claim only proves WHERE the read happens and the
     * behaviour tests call the reporter directly with both ends supplied. The
     * mutant makes both sides the target, so the comparison can never differ
     * and the notice silently never fires — the original defect restored, with
     * a passing suite over it.
     */
    const captureLine = method.slice(capture, method.indexOf('\n', capture))
    expect(captureLine).toContain('managed.llmConnection')
    expect(captureLine).not.toContain('connectionSlug')
  })

  it('reads the host resolution, not a second copy of it', () => {
    const method = source.slice(
      source.indexOf('  private reportUtilityModelChange('),
      source.indexOf('  private reportUtilityModelChange(') + 2500,
    )
    expect(method).toContain('reportUtilityModelChange')
    // `getMiniModel(conn) ?? conn.defaultModel` is the expression every host
    // call site uses; a second spelling here is how the report comes to name a
    // model the runtime never receives.
    expect(method).toContain('getMiniModel(')
    expect(method).toContain('defaultModel')
  })
})
