/**
 * UB4.14 — the composer's attachment size guard (craft-agents-oss v0.15.1, "Clear message for
 * attachments that are too large"; Apache-2.0).
 *
 * Attachments must fit in one message to the connected server, or the send drops the connection
 * and every pending request fails with "Connection lost" (`packages/shared/src/protocol/message-limits.ts`).
 * The server advertises its limit in `handshake_ack.maxMessageBytes`; the composer reads it from the
 * transport connection state and refuses, with a toast naming the problem:
 * - a file that can never be sent, BEFORE it is read (reading and base64-encoding a huge file can
 *   freeze the window) — the file picker, a paste, a drop, a global paste and a long-text paste;
 * - a set of attachments that is too big together, at send time, keeping the draft.
 *
 * `v0.15.1:apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` keeps these few
 * lines inline (`maxMessageBytesRef`, `showAttachmentSizeProblem`, `refuseOversizedAttachment`, the
 * submit check). They live here, called from the same places, because `bun test` has no DOM and
 * importing the composer pulls a UI barrel bun cannot resolve (`staged-image-send-guard.test.ts`),
 * so the decision and the toast copy could otherwise be pinned only at source level. The wiring
 * itself is pinned at source level by `__tests__/attachment-size-guard.test.ts`.
 */

import {
  checkAttachmentSizes,
  DEFAULT_MAX_MESSAGE_BYTES,
  formatAttachmentBytes,
  type AttachmentSizeInput,
  type AttachmentSizeProblem,
} from '@nessy-agent/shared/protocol/message-limits'

/**
 * The limit the composer checks against: the one the connected server advertised
 * (`TransportConnectionState.maxMessageBytes`), or the smaller (Bun) one for a server that
 * advertises none (an older server) or before the first handshake.
 */
export function maxMessageBytesOf(advertised: number | undefined): number {
  return advertised ?? DEFAULT_MAX_MESSAGE_BYTES
}

/** What the size check needs from a browser `File` before it is read (upstream's inline shape). */
export function attachmentSizeInputOf(
  file: { name: string; size: number; type: string },
  overrideName?: string,
): AttachmentSizeInput {
  return {
    name: overrideName || file.name,
    size: file.size,
    type: file.type.startsWith('image/') ? 'image' : undefined,
  }
}

/** A file that can never be sent on its own (upstream `refuseOversizedAttachment`'s decision). */
export function oversizedAttachment(
  attachment: AttachmentSizeInput,
  maxMessageBytes: number,
): Extract<AttachmentSizeProblem, { kind: 'file' }> | null {
  const problem = checkAttachmentSizes([attachment], maxMessageBytes)
  return problem?.kind === 'file' ? problem : null
}

/** The toast for a size problem (upstream `showAttachmentSizeProblem`'s copy). */
export function attachmentSizeToast(
  problem: AttachmentSizeProblem,
  t: (key: string, options?: Record<string, string>) => string,
): { title: string; description: string } {
  const size = formatAttachmentBytes(problem.size)
  const limit = formatAttachmentBytes(problem.limit)
  return problem.kind === 'file'
    ? {
        title: t('toast.attachmentTooLarge', { name: problem.name }),
        description: t('toast.attachmentTooLargeDescription', { size, limit }),
      }
    : {
        title: t('toast.attachmentsTooLarge'),
        description: t('toast.attachmentsTooLargeDescription', { size, limit }),
      }
}
