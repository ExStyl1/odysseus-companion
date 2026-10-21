/**
 * UA1.25 — session sharing on t-artifacts (OQ-22 (e)–(g), owner 2026-09-23), as plain functions over ports so the
 * ORDER is testable without a `SessionManager`. `SessionManager.shareToViewer` / `updateShare` / `revokeShare` keep
 * their names, events and the `sharedUrl` / `sharedId` fields and bind these ports.
 *
 * What changed against upstream craft-agents v0.13.4 (`SessionManager.ts` `shareToViewer`): upstream POSTs the raw
 * `StoredSession` JSON to `${VIEWER_URL}/s/api` — every field of the session file, raw tool results, stored attachment
 * paths and the working directory included. That POST is GONE (reason (b), security; and (a): the viewer is a Craft
 * service, `branding.ts` `VIEWER_URL` is removed). What is sent now is the UA1.24 snapshot
 * (`share-snapshot.ts` {@link buildShareSnapshot}: the transcript as it is, secrets masked, paths relativised),
 * normalised once by the publish path's own normaliser (`content_type: 'markdown'`, the v1 content policy included),
 * through the one fixed-origin client (UA1.16).
 *
 * ## Order (create; update is the same with `PUT` to the same id and the old expiry kept)
 *
 *   already shared? → a window that can show the card? → one card at a time → snapshot (refused over 16 MiB) →
 *   normalise → scan the bytes once more (a finding left after masking refuses) → THE CARD (the same host card as
 *   `publish_artifact`, UA1.18, plus the snapshot's counts in `chatShare`) → the client (one request carrying exactly
 *   the previewed bytes) → the registry (kind `chat`) → one audit row.
 *
 * The trigger is ONLY the user's Share action (`sessionCommand` `shareToViewer` / `updateShare`); no session tool and
 * no agent path reaches these functions. The card is raised in every permission mode — the person clicked Share, and
 * the card is what they consent to — and is refused, with zero requests, when no connected window of the workspace can
 * show it (`CLIENT_CONFIRM_DIALOG`: a phone or a headless client cannot answer it).
 *
 * ## Revoke (OQ-22 (g), O18)
 *
 * Stop sharing = one `DELETE`, no card (it sends nothing; it closes the link). It is `handlers/rpc/artifacts.ts`
 * {@link deletePublishedArtifact} — the Published pages list's own delete, reused, not forked: `gone` counts as
 * deleted, a failure a later attempt can fix (`needs-login`, `network`, `dp-unavailable`, `server`) is KEPT as a
 * pending deletion in the registry (retried by the list, UA1.19) and the session's fields are cleared, because the
 * link is no longer this chat's share — it is a deletion owed; any other failure keeps the share as it was. Deleting a
 * session no longer revokes on its own (O18): the renderer asks in the delete confirmation (UA1.26) and calls revoke
 * first. A share whose link is NOT on the t-artifacts origin (a session imported from upstream, shared through Craft's
 * viewer) is never contacted: update refuses with a sentence, revoke only clears the local fields.
 */
import type { ShareResult } from '@nessy-agent/shared/protocol'
import {
  ArtifactClientError,
  DEFAULT_RETENTION_DAYS,
  isTArtifactsUrl,
  type ArtifactRecord,
  type TArtifactsClient,
} from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { normalizeArtifact, type NormalizedArtifact } from '@nessy-agent/shared/artifacts/normalize'
import {
  PUBLISH_SCAN_SENTENCE,
  scanArtifactText,
  sha256Hex,
  type PublishGuardPass,
} from '@nessy-agent/shared/artifacts/publish-guard'
import {
  findArtifactRegistryEntry,
  recordArtifactPublish,
  recordArtifactUpdate,
  type ArtifactRegistryEntry,
} from '@nessy-agent/shared/artifacts/registry'
import {
  artifactOwnerLogin,
  buildArtifactPublishCard,
  type ArtifactAuditRecord,
  type ArtifactCardAnswer,
  type ArtifactPublishCard,
} from './artifact-publishing.ts'
import type { ShareSnapshotResult } from './share-snapshot.ts'
import { deletePublishedArtifact } from '../handlers/rpc/artifacts.ts'

/** The favicon of a shared chat (U+1F4AC SPEECH BALLOON): one emoji, as `normalize.ts` requires. */
export const CHAT_SHARE_EMOJI = '\u{1F4AC}'

/** The name the normaliser reads (only its `.md` extension and basename matter). */
const CHAT_SHARE_FILE_NAME = 'chat.md'

/** The session's current share, as its `sharedId` / `sharedUrl` fields hold it. */
export interface ChatShareLink {
  id: string
  url: string
}

export interface ChatSharePorts {
  workspaceRoot: string
  sessionId: string
  /** For the audit row: `pi`, `claude`, `codex`, … */
  runtime: string
  permissionMode: string
  /** The session's share now, or `undefined`. */
  shared: ChatShareLink | undefined
  /** A connected window of this workspace can show a confirmation card. */
  interactiveClientAttached(): boolean
  /** True while this session already waits on a publish or share card. */
  cardPending(): boolean
  /** The UA1.24 snapshot of the session as it is now. */
  buildSnapshot(): Promise<ShareSnapshotResult>
  /** Raise the host card and wait for its answer. */
  raiseCard(card: ArtifactPublishCard): Promise<ArtifactCardAnswer>
  createClient(): TArtifactsClient
  audit(record: ArtifactAuditRecord): void
  /**
   * UA12.52 — the registry just gained or changed the chat's row, so the host pushes `artifacts:changed` to the
   * workspace's windows and an OPEN Published pages section reloads without its Retry button. Optional: a caller
   * with no window push (a test) omits it.
   */
  notifyArtifactChanged?(): void
  /** The request is being sent (true) / has answered (false): the session's shimmer. */
  sending?(on: boolean): void
  now?(): Date
}

/**
 * What the caller applies: the answer for the renderer, and the session's new share — a link to store, `null` to clear
 * the fields, absent to leave them as they are.
 */
export interface ChatShareOutcome {
  result: ShareResult
  shared?: ChatShareLink | null
}

function fail(error: string, extra: Partial<ShareResult> = {}): ChatShareOutcome {
  return { result: { success: false, error, ...extra } }
}

const NOT_OUR_SERVICE = 'This chat was shared through a sharing service Nessy no longer uses, so that link cannot be '
  + 'updated. Stop sharing, then share the chat again.'

/** Share (`create`) or re-send to the same link (`update`). Never throws for a refusal: every outcome is a sentence. */
export async function runChatShare(ports: ChatSharePorts, action: 'create' | 'update'): Promise<ChatShareOutcome> {
  const now = () => ports.now?.() ?? new Date()

  // 1. The request itself.
  if (action === 'create' && ports.shared) {
    return fail('This chat is already shared. Update the share, or stop sharing first.')
  }
  if (action === 'update') {
    if (!ports.shared) return fail('Session not shared')
    if (!isTArtifactsUrl(ports.shared.url)) return fail(NOT_OUR_SERVICE)
  }
  let previous: ArtifactRegistryEntry | undefined
  if (action === 'update') {
    try {
      previous = findArtifactRegistryEntry(ports.workspaceRoot, ports.shared!.id)
    } catch {
      previous = undefined // read again (and refused, if still unreadable) when the update is recorded
    }
    if (previous?.pendingDelete) {
      return fail('This link is waiting to be deleted (see Published pages), so it cannot be updated. Share the chat again instead.')
    }
  }

  // 2. Nobody to answer the card → nothing happens.
  if (!ports.interactiveClientAttached()) {
    return fail('Sharing needs a confirmation in a Nessy window, and no window is open on this workspace; nothing was sent.')
  }
  if (ports.cardPending()) {
    return fail('A publish confirmation is already waiting in this session; answer it first. Nothing was sent.')
  }

  // 3. The bytes: snapshot → normalise → one more scan of exactly what would be sent.
  const snapshot = await ports.buildSnapshot()
  if (!snapshot.ok) return fail(snapshot.message)
  let normalized: NormalizedArtifact
  try {
    normalized = normalizeArtifact({ fileName: CHAT_SHARE_FILE_NAME, text: snapshot.markdown, emoji: CHAT_SHARE_EMOJI })
  } catch (error) {
    const sentence = error instanceof Error ? error.message : 'The chat could not be prepared.'
    return fail(`This chat cannot be shared: ${sentence} Nothing was sent.`)
  }
  const scan = scanArtifactText(normalized.content, { sensitiveKeys: false })
  if (scan.blocking) {
    // Belt and braces: the snapshot masks with the same composition, so a finding here is a masking defect. The
    // key-name rule (UA12.9) is publish-only (UA12.175): a chat's secrets are MASKED, never refused (OQ-22(e)).
    return fail(`This chat still contains a value matching the ${scan.blocking.rule} rule after masking, so nothing was sent.`)
  }
  const sha256 = sha256Hex(normalized.content)
  const pass: PublishGuardPass = {
    ok: true,
    realPath: CHAT_SHARE_FILE_NAME,
    contentType: 'markdown',
    buffer: Buffer.from(normalized.content, 'utf8'),
    text: normalized.content,
    sha256,
    byteLength: normalized.byteLength,
    counts: { emails: scan.emails, phones: scan.phones },
    scanSentence: PUBLISH_SCAN_SENTENCE,
  }
  const retentionSent = action === 'create' ? DEFAULT_RETENTION_DAYS : undefined
  const expiresAt = retentionSent !== undefined
    ? new Date(now().getTime() + retentionSent * 24 * 60 * 60 * 1000).toISOString()
    : (previous?.expiresAt ?? null)
  const ownerLogin = artifactOwnerLogin()
  const base = buildArtifactPublishCard({
    mode: action,
    sourcePath: CHAT_SHARE_FILE_NAME,
    guard: pass,
    normalized,
    expiresAt,
    ...(ownerLogin !== undefined ? { ownerLogin } : {}),
    ...(retentionSent !== undefined ? { retentionDays: retentionSent } : {}),
    ...(action === 'update' ? { url: ports.shared!.url } : {}),
    ...(previous ? { previous } : {}),
  })
  // The chat is named by its title (the snapshot's own, already cleaned) — there is no file.
  const card: ArtifactPublishCard = {
    ...base,
    sourcePath: base.title,
    // UA12.66 — an update whose registry row is gone (or unreadable) has a `null` expiry the card must not read as
    // "never": the service-side link keeps its original expiry, so the host marks it unknown instead.
    ...(action === 'update' && previous === undefined ? { expiresUnknown: true } : {}),
    chatShare: {
      maskedSecrets: snapshot.maskedSecrets.map(entry => ({ rule: entry.rule, count: entry.count })),
      maskedSecretTotal: snapshot.maskedSecretTotal,
      relativisedPaths: snapshot.relativisedPaths,
      truncatedPayloads: snapshot.truncatedPayloads,
    },
  }
  const audit = (record: Omit<ArtifactAuditRecord, 'action' | 'runtime' | 'permissionMode' | 'timestamp' | 'sourcePath'>) =>
    ports.audit({
      action,
      runtime: ports.runtime,
      permissionMode: ports.permissionMode,
      sourcePath: `chat "${card.title}"`,
      timestamp: now().toISOString(),
      sha256,
      byteLength: normalized.byteLength,
      emailCount: scan.emails,
      phoneCount: scan.phones,
      ...(retentionSent !== undefined ? { retentionDays: retentionSent } : {}),
      ...record,
    })

  // 4. The card.
  const answer = await ports.raiseCard(card)
  if (!answer.allowed) {
    audit({ decision: 'denied' })
    return fail(answer.refusal ?? 'Sharing was declined; nothing was sent.', { declined: true })
  }

  // 5. Send — exactly one request carrying the previewed bytes.
  let record: ArtifactRecord
  ports.sending?.(true)
  try {
    const client = ports.createClient()
    const request = {
      content: normalized.content,
      contentType: normalized.contentType,
      title: normalized.title,
      emoji: normalized.emoji,
      ...(retentionSent !== undefined ? { retentionDays: retentionSent } : {}),
    }
    record = action === 'update'
      ? await client.updateArtifact({ id: ports.shared!.id }, request)
      : await client.createArtifact(request)
  } catch (error) {
    const kind = error instanceof ArtifactClientError ? error.kind : 'network'
    audit({ decision: 'approved', failure: kind })
    const sentence = error instanceof ArtifactClientError ? error.message : 'The artifact service could not be reached.'
    return fail(`${sentence} Nothing was ${action === 'update' ? 'updated' : 'shared'}.`)
  } finally {
    ports.sending?.(false)
  }

  // P-UA-i-4 — the deployed service answers WITHOUT `expires_at` (measured live on RC4, S7-D 2026-10-10)
  // although the create sent `retention_days` and the card above showed the retention's date. An answer
  // without an expiry is carried as the EXPECTATION — the sent retention, else the registry's previous
  // expiry on an update — so the result and the registry row never read the link as never-expiring while
  // a retention governs it. (An update's registry row keeps its old expiry either way: `retentionSent:
  // false` below.) The service divergence is a release-notes KNOWN line, not fixable here.
  record = {
    ...record,
    expiresAt: record.expiresAt
      ?? (retentionSent !== undefined
        ? new Date(now().getTime() + retentionSent * 24 * 60 * 60 * 1000).toISOString()
        : (previous?.expiresAt ?? null)),
  }

  // 6. Registry (the chat's row, kind `chat`) and the audit row. A registry that cannot be written loses only this
  // workspace's map to the page — the link is live and is still the session's share.
  let registryNote: string | undefined
  try {
    if (action === 'update' && findArtifactRegistryEntry(ports.workspaceRoot, record.id)) {
      recordArtifactUpdate(ports.workspaceRoot, {
        record,
        retentionSent: false,
        contentDigest: sha256,
        sourcePath: card.title,
        byteLength: normalized.byteLength,
        lineCount: card.lineCount,
      })
    } else {
      recordArtifactPublish(ports.workspaceRoot, {
        record,
        sourceSessionId: ports.sessionId,
        sourcePath: card.title,
        contentDigest: sha256,
        kind: 'chat',
        byteLength: normalized.byteLength,
        lineCount: card.lineCount,
      })
    }
  } catch {
    registryNote = 'registry-write-failed'
  }
  // UA12.52 — the registry write landed, so the workspace's windows learn it and an OPEN Published pages section
  // reloads without its Retry button (a failed write keeps the note and pushes nothing).
  if (!registryNote) ports.notifyArtifactChanged?.()
  audit({ decision: 'approved', url: record.url, ...(registryNote ? { rule: registryNote } : {}) })
  return {
    result: { success: true, url: record.url, expiresAt: record.expiresAt },
    shared: { id: record.id, url: record.url },
  }
}

/** Stop sharing: one DELETE (no card — nothing is sent); see the header for the outcomes. */
export async function runChatShareRevoke(
  ports: Pick<ChatSharePorts, 'workspaceRoot' | 'shared' | 'createClient' | 'sending' | 'now'>,
): Promise<ChatShareOutcome> {
  const shared = ports.shared
  if (!shared) return fail('Session not shared')
  // A link on another service is never contacted: the local fields go, nothing is sent.
  if (!isTArtifactsUrl(shared.url)) return { result: { success: true }, shared: null }

  let entry: ArtifactRegistryEntry | undefined
  try {
    entry = findArtifactRegistryEntry(ports.workspaceRoot, shared.id)
  } catch {
    entry = undefined
  }
  ports.sending?.(true)
  try {
    const outcome = await deletePublishedArtifact(ports.workspaceRoot, ports.createClient(), {
      id: shared.id,
      url: shared.url,
      title: entry?.title ?? '',
      expiresAt: entry?.expiresAt ?? null,
      retentionDays: entry?.retentionDays ?? null,
    }, ports.now ? { now: () => ports.now!() } : {})
    if (outcome.outcome === 'deleted') return { result: { success: true }, shared: null }
    if (outcome.outcome === 'pending') {
      return {
        result: { success: true, deletionPending: true, ...(outcome.message ? { message: outcome.message } : {}) },
        shared: null,
      }
    }
    return fail(outcome.message ?? 'Failed to revoke share')
  } finally {
    ports.sending?.(false)
  }
}
