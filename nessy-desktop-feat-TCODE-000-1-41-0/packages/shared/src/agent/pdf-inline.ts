/**
 * UB2.11 (B2 S-04, a silent v0.15.1 change) — which attached PDFs go to Claude
 * inline (a base64 `document` block).
 *
 * Ported from craft-agents-oss v0.15.1 `packages/shared/src/agent/pdf-inline.ts`
 * (Apache-2.0). The Messages API rejects requests over 32 MB, and an inline
 * document stays in the conversation, so every later turn re-sends it. Bigger
 * PDFs are sent by path only (the stored-file line the agent always gets) and
 * read with the Read tool, page range by page range; Pi sessions already send
 * every PDF that way.
 *
 * NESSY (the row's gateway specific): on a TRANSLATED route (any card whose wire
 * is not native `anthropic-messages` — the `claude-gateway` loopback adapter
 * translates a `document` block into the text `[document…]`, so the bytes
 * travel AND are dropped) NOTHING goes inline, whatever its size.
 */

/** Raw size up to which a PDF is attached inline */
export const MAX_INLINE_PDF_BYTES = 10 * 1024 * 1024

/** Raw size of an attachment: its declared size, else derived from its base64 */
function rawBytes(attachment: { size?: number; base64?: string }): number {
  if (typeof attachment.size === 'number' && attachment.size > 0) return attachment.size
  return attachment.base64 ? Math.floor((attachment.base64.length * 3) / 4) : 0
}

export function shouldInlinePdf(attachment: { size?: number; base64?: string }): boolean {
  return !!attachment.base64 && rawBytes(attachment) <= MAX_INLINE_PDF_BYTES
}

/**
 * NESSY — the caller's gate: `shouldInlinePdf` AND a native Anthropic wire. A translated route
 * (the `claude-gateway` loopback adapter, wire not `anthropic-messages`) turns a `document`
 * block into `[document…]` text — the bytes travel and the content never arrives — so every
 * PDF there goes by the stored path.
 */
export function shouldInlinePdfForRoute(
  attachment: { size?: number; base64?: string },
  route: { nativeAnthropicMessages: boolean },
): boolean {
  return route.nativeAnthropicMessages && shouldInlinePdf(attachment)
}

/** Tells the agent how to read a PDF that was not attached inline */
export function largePdfNote(attachment: { name: string; size?: number; base64?: string }): string {
  const mb = (rawBytes(attachment) / 1_000_000).toFixed(1)
  return `[${attachment.name} is too large to attach inline (${mb} MB). Read it from the stored path above with the Read tool, using the pages parameter for page ranges.]`
}
