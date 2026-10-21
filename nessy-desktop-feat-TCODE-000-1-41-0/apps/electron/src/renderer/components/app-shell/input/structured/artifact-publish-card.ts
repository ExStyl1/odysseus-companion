/**
 * UA1.18 — the presentation DECISIONS of the `publish_artifact` card, as values (the `turn-preview.ts` convention:
 * a decision does not live in a component a test can only read as source).
 *
 * The card shows what is about to leave the machine BEFORE the person answers: the access line, the owner and the
 * absolute expiry; the file, its size and a sha256 prefix; a preview of the normalised bytes (HTML in a frame with
 * scripts disabled, Markdown rendered) plus the first 40 source lines; the script count and every external host;
 * the scan sentence; and, for an update, the size/line change against what the registry recorded for the last
 * publish of that link.
 */
import type { PermissionRequest } from '../../../../../shared/types'

export type ArtifactPublishCardData = NonNullable<PermissionRequest['artifactPublish']>

/**
 * The HTML preview's document: a CSP that allows NOTHING to load or run (no scripts, no network — an `<img>` to an
 * external host would otherwise be a request made by merely looking at the card), placed FIRST so it precedes any
 * markup in the page, then the normalised content. The frame itself also carries `sandbox=""` (no scripts, opaque
 * origin, no forms, no navigation of the top window); the CSP is the second, independent half.
 */
export const ARTIFACT_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

export function artifactPreviewSrcDoc(content: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PREVIEW_CSP}"><meta charset="utf-8">${content}`
}

/** The first 12 hex characters of the digest — enough to compare by eye with the audit row. */
export function artifactShaPrefix(sha256: string): string {
  return sha256.slice(0, 12)
}

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta)
}

/** An update's change against the last publish, or `null` when the card is a create. */
export type ArtifactUpdateDiff =
  | { kind: 'unchanged' }
  | { kind: 'sized'; byteDelta: string; lineDelta: string }
  | { kind: 'unknown-size' }

export function artifactUpdateDiff(card: Pick<ArtifactPublishCardData, 'mode' | 'previous' | 'sha256' | 'byteLength' | 'lineCount'>): ArtifactUpdateDiff | null {
  if (card.mode !== 'update' || !card.previous) return null
  if (card.previous.sha256 === card.sha256) return { kind: 'unchanged' }
  if (card.previous.byteLength === undefined || card.previous.lineCount === undefined) return { kind: 'unknown-size' }
  return {
    kind: 'sized',
    byteDelta: signed(card.byteLength - card.previous.byteLength),
    lineDelta: signed(card.lineCount - card.previous.lineCount),
  }
}

/** The absolute expiry date as the person's locale writes it, or `null` for "never". */
export function artifactExpiryLabel(expiresAt: string | null, locale?: string): string | null {
  if (expiresAt === null) return null
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return expiresAt
  return date.toLocaleString(locale, { dateStyle: 'long', timeStyle: 'short' })
}

/**
 * UA1.26 — a CHAT share's card (the session's Share action, `card.chatShare` set by UA1.25): what the snapshot did to
 * the transcript before these bytes were built — the masked secrets by rule, the paths rewritten, the tool outputs
 * cut. `null` for a file's card, which shows its file line instead.
 */
export interface ChatShareSummary {
  maskedTotal: number
  /** `jwt ×2, bearer ×1` — rule names and counts, never a value. */
  maskedRules: string
  relativisedPaths: number
  truncatedPayloads: number
}

export function chatShareSummary(card: Pick<ArtifactPublishCardData, 'chatShare'>): ChatShareSummary | null {
  const share = card.chatShare
  if (!share) return null
  return {
    maskedTotal: share.maskedSecretTotal,
    maskedRules: share.maskedSecrets.map(entry => `${entry.rule} ×${entry.count}`).join(', '),
    relativisedPaths: share.relativisedPaths,
    truncatedPayloads: share.truncatedPayloads,
  }
}
