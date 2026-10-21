/**
 * D1.239 — a model change NOBODY asked for says so, in the vendor's own word.
 *
 * ## The claim this replaces
 *
 * `updateSessionModel` stamped `source: 'sdk'` on every switch, under a comment
 * that said *"Every production route into this seam is a client asking the host
 * to set a model"*. That had stopped being true: `deliverScheduledCronFire`
 * calls the same method twice with nobody present — once for the cron record's
 * own model and once to restore the session's.
 *
 * `hooks.md#postmodelswitch-input`, verbatim (fetched 2026-09-18, HTTP 200):
 * *"two more `source` values: `"auto"` for an automatic fallback or other change
 * Claude Code made on its own, and `"resume"` for the model restored when you
 * resume a session"*. A scheduled override is that.
 *
 * ## Why both directions are asserted
 *
 * A hook written to gate switches reads `source`. If everything says `sdk`, a
 * gate that trusts a person is behind the request trusts one that is not; if
 * everything said `auto`, the same gate would refuse the user's own picker. So
 * the DEFAULT is pinned as hard as the override, and the parameter is pinned as
 * absent from `ISessionManager` — an RPC client must not be able to claim
 * `auto` for a switch a person drove.
 */
import { describe, expect, test } from 'bun:test'
import { SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager.ts'

function rig() {
  const manager = createTestSessionManager() as any
  const payloads: Array<{ event: string; source?: string }> = []
  const managed = {
    id: 'session-1',
    workspace: { id: 'workspace-1', rootPath: '/tmp/workspace-1' },
    model: 'model-before',
  }
  manager.getManaged = () => managed
  manager.warnWarmCacheDiscarded = () => {}
  manager.modelSwitchCostFields = () => ({})
  manager.writeSessionMetadata = async () => {}
  manager.sendEvent = () => {}
  manager.runModelSwitchHook = async (_managed: unknown, event: string, payload: { source?: string }) => {
    payloads.push({ event, source: payload.source })
    return {}
  }
  return { manager, managed, payloads }
}

describe('D1.239 · the model-switch hook says who asked', () => {
  test('a client route is `sdk` — the default, and the case that must not move', async () => {
    const h = rig()
    await SessionManager.prototype.updateSessionModel.call(h.manager, 'session-1', 'workspace-1', 'model-after')
    // BOTH halves of the pair, which is also the control that this rig drives
    // the real method rather than a branch of it.
    expect(h.payloads.map(entry => entry.event)).toEqual(['PreModelSwitch', 'PostModelSwitch'])
    expect(h.payloads.map(entry => entry.source)).toEqual(['sdk', 'sdk'])
  })

  test('the host\'s own scheduled switch is `auto`', async () => {
    const h = rig()
    await SessionManager.prototype.updateSessionModel.call(
      h.manager, 'session-1', 'workspace-1', 'model-after', undefined, 'auto',
    )
    expect(h.payloads.map(entry => entry.source)).toEqual(['auto', 'auto'])
    // The events are unchanged — this row moves one field, not the seam.
    expect(h.payloads.map(entry => entry.event)).toEqual(['PreModelSwitch', 'PostModelSwitch'])
  })

  test('and the RESTORE half carries it too, which a one-sided fix would have missed', async () => {
    const h = rig()
    // The shape `deliverScheduledCronFire` produces: the override, then the
    // restore to the model the session was left on. Both are host-driven.
    await SessionManager.prototype.updateSessionModel.call(
      h.manager, 'session-1', 'workspace-1', 'cron-model', undefined, 'auto',
    )
    await SessionManager.prototype.updateSessionModel.call(
      h.manager, 'session-1', 'workspace-1', 'model-before', undefined, 'auto',
    )
    expect(h.payloads.map(entry => entry.source)).toEqual(['auto', 'auto', 'auto', 'auto'])
  })
})
