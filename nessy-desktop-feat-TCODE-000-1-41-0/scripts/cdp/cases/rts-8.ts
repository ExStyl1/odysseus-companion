/**
 * RTS-8 — a switch cannot land while a turn is in flight.
 *
 * Blocker A3. `switchSessionRuntime` tears the old runtime down through
 * `strictDrainSessionForMutation`, which force-aborts a live agent and kills
 * background shells. Doing that under a streaming turn is how a session ends up
 * with half an answer, a dead agent and no error — so the operation refuses
 * first, with `SESSION_BUSY`, before it touches anything.
 *
 * Two flags are checked there, not one: `managed.agent?.isProcessing?.()` and
 * `managed.isProcessing`. `sendMessage` sets the latter BEFORE the agent exists,
 * so the agent flag alone leaves a window in which a send is already committed
 * and the switch would still be allowed through. This case aims at exactly that
 * window: it submits a turn and asks for the switch immediately, without waiting
 * for the agent to come up.
 *
 * ## Why the refusal is asserted by CODE, not by copy
 *
 * The user-visible string is i18n'd and will be reworded. `SESSION_BUSY` is the
 * `CodedError` the operation throws and the picker keys off, so that is what is
 * asserted; the copy is observed for the record but never checked.
 *
 * ## The positive control
 *
 * A refusal case must show that the same call SUCCEEDS when the precondition is
 * absent — otherwise it passes on a build where switching is broken outright.
 * So the case switches the same session again once the turn has settled, and
 * requires that one to be accepted.
 *
 * ## The quit half of the plan's row is NOT here
 *
 * The plan pairs this with "switch while the app is quitting (⌘Q during the
 * confirm); the app must exit and release the server lock file". That half
 * terminates the app under test, so it cannot share a process with the rest of
 * the wave — every later case would attach to nothing. It is run last, on its
 * own, and recorded as its own row. Saying so here rather than quietly dropping
 * it: a row that covers half of what its title claims is worse than two rows.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, isProcessing, transcript, waitFor } from '../lib/state.ts'
import { clearComposer, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { requireRuntimeTrio, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'

const ID = 'RTS-8'
const TITLE = 'A switch requested while a turn is in flight is refused, and accepted once it settles'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const key = await freshSession(session, `${ID} switch mid-turn`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  await switchRuntime(session, key.sessionId, trio.pi)
  run.require(
    'the session starts on Pi',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )

  // A prompt long enough to still be running when the switch is asked for, and
  // cheap enough not to cost a minute: the model has to produce tokens, not
  // think hard.
  const before = (await transcript(session, key)).length
  await clearComposer(session)
  await typeIntoComposer(session, 'Count slowly from 1 to 40, one number per line, with no other words.')
  await submitComposer(session)

  // Do NOT wait for the agent — the window this case aims at is the one where
  // `managed.isProcessing` is already set and `managed.agent` is not yet there.
  const busy = await switchRuntime(session, key.sessionId, trio.claude)
  run.observe('switch requested mid-turn', busy)
  run.check('the mid-turn switch was refused', !busy.ok, busy.ok ? 'it was ACCEPTED' : String(busy.error))

  // The shape the RENDERER sees, read the way the renderer reads it.
  //
  // `ChatPage.tsx:355` picks the toast by `error.code`: `SESSION_BUSY` →
  // "a turn is running", `WORKTREE_DIRTY` → "commit or stash first",
  // `WORKTREE_EXIT_UNAVAILABLE` → "move out of the worktree", anything else →
  // the generic "switch failed". So `code` is not a detail — it is which of
  // four messages the user is given, and the only actionable ones are the
  // three specific ones.
  // Read every channel the code could arrive on, because three have now been
  // measured shut and the next attempt should not have to re-derive that:
  //
  // | channel | survives the contextBridge? |
  // | --- | --- |
  // | own property `code` | **no** — `getOwnPropertyNames` → `["stack","message"]` |
  // | `name` | **no** — `CodedError` sets `CodedError`, the renderer reads `Error` |
  // | `stack` | **no** — REGENERATED, not copied: the renderer receives the single line `Error: <message>` with no frames |
  // | `message` | yes — and it is translated and user-visible, which is why it is not a channel |
  //
  // A stack-marker fix was written against the third row and was inert for
  // exactly that reason; the measurement above is what retired it.
  const shape = await session.call<{
    ownKeys: string[]; directCode?: unknown; stackLines?: number; name?: string; message?: string
  }>(`
    try {
      await window.electronAPI.sessionCommand(
        ${JSON.stringify(key.sessionId)},
        { type: 'switchRuntime', connectionSlug: ${JSON.stringify(trio.claude)} },
      )
      return { ownKeys: ['__no_throw__'] }
    } catch (e) {
      const stack = e && typeof e.stack === 'string' ? e.stack : ''
      return {
        ownKeys: Object.getOwnPropertyNames(e ?? {}),
        directCode: e && e.code,
        // Frames, not content: a regenerated stack is a single line, so this
        // is the cheapest proof of which of the two the renderer received.
        stackLines: stack.split('\\n').length,
        name: e && e.name,
        message: e && e.message,
      }
    }
  `)
  run.observe('error shape at the renderer boundary', shape)
  run.check(
    'the renderer can name the refusal — otherwise every refusal is the generic toast',
    shape.directCode === 'SESSION_BUSY',
    shape.directCode === 'SESSION_BUSY'
      ? 'SESSION_BUSY'
      : `no code reached the renderer (ownKeys=${JSON.stringify(shape.ownKeys)}, stackLines=${shape.stackLines}); `
        + 'ChatPage falls through to chat.runtimeSwitch.failed, so the busy, worktree-dirty and worktree-exit '
        + 'messages are unreachable — and worktree-dirty is the only one naming uncommitted work as the cause',
  )
  run.check(
    'the session stayed on the runtime it was already on',
    (await waitForConnection(session, key.sessionId, trio.pi, 5_000)) === trio.pi,
    trio.pi,
  )

  // --- the positive control ------------------------------------------------
  await waitFor(
    async () => ({ processing: await isProcessing(session, key), count: (await transcript(session, key)).length }),
    value => !value.processing && value.count > before,
    { timeoutMs: 300_000, intervalMs: 2_000, label: 'the turn to settle' },
  )
  run.observe('turn settled', true)

  const settled = await switchRuntime(session, key.sessionId, trio.claude)
  run.observe('switch after the turn settled', settled)
  run.require(
    'the SAME switch is accepted once the turn is over — the refusal was about the turn, not about switching',
    settled.ok,
    settled.error ?? '',
  )
  run.check(
    'and the session really moved',
    (await waitForConnection(session, key.sessionId, trio.claude)) === trio.claude,
    trio.claude,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
