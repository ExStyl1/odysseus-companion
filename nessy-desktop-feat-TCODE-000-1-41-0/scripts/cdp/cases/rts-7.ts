/**
 * RTS-7 — an image the target runtime cannot take must be reported, not dropped in silence.
 *
 * C5/T12. `resolveComposerCapabilities` answers `attachments.images` per
 * connection, and on this profile the three gateway cards disagree — measured,
 * not assumed:
 *
 * | card | `attachments.images` |
 * | --- | --- |
 * | `codex-gateway` | **`yes`** |
 * | `pi-api-key` | `no` |
 * | `claude-gateway` | `no` |
 *
 * So the switch that matters is Codex → Claude: a conversation carrying an image
 * moves to a runtime that cannot carry it. `switchSessionRuntime` computes
 * `droppedAttachments` from the SAME `capabilities` value the composer is handed,
 * so the switch's summary and the composer's refusal are one answer rather than
 * two derivations — and `ChatPage.tsx` raises a toast naming the files.
 *
 * **Silence is the failure.** Not the dropping — a runtime that cannot take
 * images cannot take them, and that is honest. The failure is a user who
 * attached a screenshot, switched integration, and is never told the model can
 * no longer see it. Everything downstream then reads as the model being obtuse.
 *
 * ## Staging the image
 *
 * Attachments are stored at SEND time, not held as a draft: `App.tsx:1290` calls
 * `storeAttachment(sessionId, attachment)` for each one and then sends with the
 * returned refs. There is no UI path a CDP run can drive — "Attach Files" opens
 * a native dialog — so this case makes those same two calls in the same order.
 * It is the app's own path invoked directly rather than a test seam, and it is
 * named here because the harness's default is to drive the UI.
 *
 * The image is a real 1×1 PNG written by the case, so `isImageAttachment` sees a
 * genuine `type: 'image'` with a real mime type and size.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, isProcessing, transcript, waitFor } from '../lib/state.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { requireRuntimeTrio, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'

const ID = 'RTS-7'
const TITLE = 'Switching to a runtime that cannot take images says so instead of dropping them quietly'

/** A real 1×1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const IMAGE_NAME = 'rts7-screenshot.png'

interface ComposerCapabilities {
  attachments?: { images?: string }
}

async function composerCapabilities(session: CdpSession, sessionId: string): Promise<ComposerCapabilities | null> {
  return session.call<ComposerCapabilities | null>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
    return s ? (s.composerCapabilities ?? null) : null
  `)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const key = await freshSession(session, `${ID} image across a switch`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')

  // --- the source side must actually accept images ------------------------
  await switchRuntime(session, key.sessionId, trio.codex)
  run.require(
    'the session starts on the codex card',
    (await waitForConnection(session, key.sessionId, trio.codex)) === trio.codex,
    trio.codex,
  )
  await Bun.sleep(2_000)
  const sourceCaps = await composerCapabilities(session, key.sessionId)
  run.observe('codex attachments.images', sourceCaps?.attachments?.images)
  if (sourceCaps?.attachments?.images !== 'yes') {
    blocked(
      `the source card ${trio.codex} reports attachments.images=${sourceCaps?.attachments?.images} — `
      + 'this row needs a runtime that ACCEPTS images to move away from. Nothing here can stage one.',
    )
  }

  // --- send a message carrying the image ----------------------------------
  const before = (await transcript(session, key)).length
  const sent = await session.call<{ ok: boolean; error?: string; storedName?: string }>(`
    const attachment = {
      type: 'image',
      path: ${JSON.stringify(`/tmp/${IMAGE_NAME}`)},
      name: ${JSON.stringify(IMAGE_NAME)},
      mimeType: 'image/png',
      base64: ${JSON.stringify(PNG_BASE64)},
      size: ${Buffer.from(PNG_BASE64, 'base64').length},
    }
    try {
      const stored = await window.electronAPI.storeAttachment(${JSON.stringify(key.sessionId)}, attachment)
      await window.electronAPI.sendMessage(
        ${JSON.stringify(key.sessionId)},
        'Here is an image. Reply with exactly: IMAGE-SEEN',
        [attachment],
        stored ? [stored] : undefined,
      )
      return { ok: true, storedName: stored && (stored.name ?? stored.fileName) }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  `)
  run.observe('send with attachment', sent)
  run.require('the image was accepted by the source runtime', sent.ok, sent.error ?? '')

  // Wait for the turn to SETTLE, not merely to land a message. A switch
  // requested while `isProcessing` is still set is refused with SESSION_BUSY
  // (RTS-8's subject), and that refusal here would look like this row failing.
  await waitFor(
    async () => ({
      count: (await transcript(session, key)).length,
      processing: await isProcessing(session, key),
    }),
    value => value.count > before && !value.processing,
    { timeoutMs: 300_000, intervalMs: 2_000, label: 'the turn carrying the image to settle' },
  ).catch(() => undefined)

  // Read the attachment names from the DTO directly. `lib/state.ts`'s
  // `transcript()` projects a fixed field list and does NOT carry `attachments`,
  // so a `JSON.stringify(...).includes(name)` over its output is a read of the
  // HARNESS's projection, not of the session — it answers "false" about a
  // message that has the attachment.
  const attachmentNames = await session.call<string[]>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    return (s && s.messages ? s.messages : []).flatMap(m => (m.attachments ?? []).map(a => a.name))
  `)
  run.observe('attachment names on the transcript', attachmentNames)
  run.check(
    'the transcript carries the image attachment',
    attachmentNames.includes(IMAGE_NAME),
    attachmentNames.join(', ') || 'none',
  )

  // --- the switch to a runtime that cannot take it ------------------------
  const targetSlug = trio.claude
  const outcome = await switchRuntime(session, key.sessionId, targetSlug)
  run.observe('switch codex → claude', outcome)
  run.require('the switch was accepted', outcome.ok, outcome.error ?? '')
  run.require(
    'the session reports the claude card',
    (await waitForConnection(session, key.sessionId, targetSlug)) === targetSlug,
    targetSlug,
  )

  await Bun.sleep(2_000)
  const targetCaps = await composerCapabilities(session, key.sessionId)
  run.observe('claude attachments.images', targetCaps?.attachments?.images)
  run.require(
    'the target really cannot take images — otherwise there is nothing to report',
    targetCaps?.attachments?.images === 'no',
    String(targetCaps?.attachments?.images),
  )

  const dropped = outcome.result?.droppedAttachments ?? []
  run.observe('droppedAttachments reported by the switch', dropped)
  run.check(
    'the switch NAMES the image the new runtime cannot see — the user is told, not left to guess',
    dropped.includes(IMAGE_NAME),
    dropped.length === 0
      ? 'droppedAttachments is empty: the image is silently invisible to the new runtime'
      : dropped.join(', '),
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
