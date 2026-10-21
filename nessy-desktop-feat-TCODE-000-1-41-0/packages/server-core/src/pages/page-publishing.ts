/**
 * UA6.7 — publishing a Page on t-artifacts (OQ-18, resolved 2026-09-23: «по артефактам да, использовать то что выше
 * дал»), as plain functions over ports so the ORDER is testable without a `SessionManager` or an RPC server.
 *
 * There is ONE publish door (plan UA1.23 "one publishing path in the host for the tool, the Page button and the
 * preview button"): a page goes through `sessions/artifact-publishing.ts` {@link runArtifactPublish} — the request
 * checks, the normaliser (UA1.16), the host card payload (UA1.18), the re-check after the card, exactly one request
 * through the one fixed-origin client, the registry row and the audit row — with two ports of its own:
 *
 * - `readSource` — the page bundle (`@nessy-agent/shared/pages` `buildPageShareBundle`: the field allowlist, the
 *   script-grant refusal, the view-only acknowledgment, the snapshot parse check, the single 16 MiB cap; the snapshot
 *   inlined with the read-only `nessy-pages/v1` shim) and its guard ({@link guardPageShareBundle}: the UA1.17 scan
 *   over the page's HTML AND its snapshot). Read before the card and again after it, exactly as a file is.
 * - `raiseCard` — the card is the Share dialog's review. A person cannot be shown a host card in a session for a
 *   page (a page has no session), so the review is two calls: `pages:getShareDataScan` runs the chain with a card
 *   port that CAPTURES the card and declines ({@link reviewPagePublish} — nothing is sent, nothing is audited), the
 *   dialog renders it with the very component the session card uses (`ArtifactPublishDetails`), and `pages:publish`
 *   runs the chain again with a card port that allows only when the card's sha256 equals the one the person
 *   reviewed ({@link publishPage}). A page that changed in between is refused with a sentence and nothing is sent.
 *
 * Unattended: never — the trigger is a person's click in the Pages view (a page has no agent path to publishing;
 * `delete_page`'s unpublish below follows its own host card). Unpublish is one DELETE through the registry
 * (`handlers/rpc/artifacts.ts` {@link deletePublishedArtifact}, reused, not forked): a failure a retry can fix is
 * kept as a pending deletion and retried after the next sign-in (UA1.19), `gone` counts as deleted.
 *
 * The registry row (`artifacts/registry.json`, on the credential read floor) is where a page's publication lives —
 * never page.json, which an agent can write. Its kind is `'page'`, it has no source session (`list_artifacts` never
 * shows it to a model; `publish_artifact` refuses it as an update target), and its `page` facet carries the page id
 * the Pages loaders join on, the slug, `includesData` and the HTML digest at the publish.
 */
import { getHostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import { PUBLISH_SCAN_SENTENCE, scanArtifactText, sha256Hex, type PublishGuardResult } from '@nessy-agent/shared/artifacts/publish-guard'
import {
  findPageRegistryEntry,
  readArtifactRegistry,
  type ArtifactPageFacet,
  type ArtifactRegistryEntry,
} from '@nessy-agent/shared/artifacts/registry'
import type { TArtifactsClient } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import {
  buildPageShareBundle,
  getPageContentPath,
  listPageGrants,
  loadPageConfig,
  PageShareError,
  scanPageShareData,
  type PagePublication,
  type PageShareBundle,
  type PageShareGrantView,
} from '@nessy-agent/shared/pages'
import type {
  PagePublishOptions,
  PagePublishResult,
  PageShareCard,
  PageShareReview,
  PageUnpublishResult,
} from '@nessy-agent/shared/pages/types'
import {
  runArtifactPublish,
  type ArtifactAuditRecord,
  type ArtifactCardAnswer,
  type ArtifactPublishPorts,
} from '../sessions/artifact-publishing.ts'
import { deletePublishedArtifact } from '../handlers/rpc/artifacts.ts'

/** The registry's `sourcePath` of a page row (the audit row's and the card's spelling of the source). */
export function pagePublicationSourcePath(slug: string): string {
  return `pages/${slug}`
}

/** The ports the host binds (`handlers/rpc/pages.ts`). */
export interface PagePublishingDeps {
  workspaceRoot: string
  /** The one fixed-origin client with the host's managed network policy (`SessionManager.createArtifactsClient`). */
  createClient(): TArtifactsClient
  /** The page's grants from the host-approvals ledger; `null` when the ledger cannot be read. Default: {@link readPageGrantsForPublish}. */
  readGrants?(slug: string): Promise<readonly PageShareGrantView[] | null>
  /** One audit line per publish decision (no content, no token). */
  audit?(record: ArtifactAuditRecord): void
  now?(): Date
}

/** The ledger's grants of a page; no key (a headless host without one) or an unreadable ledger → `null` (refused). */
export async function readPageGrantsForPublish(workspaceRoot: string, slug: string): Promise<readonly PageShareGrantView[] | null> {
  try {
    const key = await getHostApprovalsKeyProvider().getKey()
    return listPageGrants(workspaceRoot, key, slug)
  } catch {
    return null
  }
}

function readRegistry(workspaceRoot: string): ArtifactRegistryEntry[] {
  try {
    return readArtifactRegistry(workspaceRoot)
  } catch {
    return []
  }
}

/** The page's LIVE registry row (a row owed a deletion, or past its expiry, is not a publication to update). */
function livePageEntry(workspaceRoot: string, pageId: string, now: Date): ArtifactRegistryEntry | undefined {
  const entry = findPageRegistryEntry(readRegistry(workspaceRoot), pageId, now)
  return entry && !entry.pendingDelete ? entry : undefined
}

/** The prose of a `PageShareError` (its code travels separately). */
function shareErrorSentence(error: PageShareError): string {
  return error.message.replace(/^PAGE_[A-Z_]+:\s*/, '')
}

/**
 * The UA1.17 guard over a page bundle (plan UA6.7 "the guard runs over both the HTML and the snapshot"): the same
 * scan as a file (`scanArtifactText`: the shared token table, `pan` and the key-name scan; e-mails and phone numbers counted, never
 * blocking), run on the HTML and on the snapshot SEPARATELY so a refusal names the part and its line, never the
 * value. A pass is the guard's own shape over the ONE buffer that is hashed, previewed and sent: the built document.
 * That buffer is scanned last as well (UA6.7 follow-up): the snapshot is inlined RE-SERIALISED from its parsed value,
 * so a token the raw file spells with JSON escapes (`\u0065yJ…`) reaches the copy in plain text. A finding only the
 * document shows REFUSES the publish — a refusal produces no card, so nothing is previewed (UA12.118) — and its
 * sentence names no line of that copy (the person never sees it; the result's `line` keeps it for the audit) and
 * sends the fix to the page's content or data, where the value actually lives; the copy itself is built, not edited.
 * The page's files are app-managed (`pages/<slug>/`), so the file
 * guard's path floor has nothing to judge here.
 */
export function guardPageShareBundle(bundle: PageShareBundle, contentPath: string): PublishGuardResult {
  const parts: Array<{ name: string; text: string; counted: boolean }> = [{ name: 'The page\'s HTML', text: bundle.content, counted: true }]
  if (bundle.snapshotJson !== undefined) parts.push({ name: 'The page\'s data snapshot', text: bundle.snapshotJson, counted: true })
  parts.push({ name: 'The copy built from this page (its content and data together)', text: bundle.document, counted: false })
  let emails = 0
  let phones = 0
  for (const part of parts) {
    const scan = scanArtifactText(part.text)
    if (scan.blocking) {
      const others = scan.blocking.total > 1 ? ` (${scan.blocking.total} findings in all)` : ''
      return {
        ok: false,
        kind: 'secret',
        // UA12.118 — the uncounted part IS the built copy: no line of it is named (the person never sees it), and its
        // finding is removed at the source (the page's content or data); the counted parts are the person's own edits.
        message: `${part.name}${part.counted ? ` line ${scan.blocking.line}` : ''} contains what looks like a `
          + `${scan.blocking.rule} value${others}, so nothing was published. `
          + (part.counted
            ? 'Remove it or replace it with a placeholder, then publish again.'
            : 'Remove the value from the page\'s content or its data, then publish again.'),
        rule: scan.blocking.rule,
        line: scan.blocking.line,
      }
    }
    if (!part.counted) continue
    emails += scan.emails
    phones += scan.phones
  }
  const buffer = Buffer.from(bundle.document, 'utf8')
  return {
    ok: true,
    realPath: contentPath,
    contentType: 'html',
    buffer,
    text: bundle.document,
    sha256: sha256Hex(buffer),
    byteLength: buffer.length,
    counts: { emails, phones },
    scanSentence: PUBLISH_SCAN_SENTENCE,
  }
}

/** Pages being published right now (`<root>\0<slug>`): a second click while one runs is refused, never stacked. */
const inFlight = new Set<string>()

interface ChainOutcome {
  verdict: Awaited<ReturnType<typeof runArtifactPublish>>
  card?: PageShareCard
  code?: string
  mode: 'create' | 'update'
}

/** One run of the publish chain for `slug`, with `answer` deciding the card. */
async function runPageChain(
  deps: PagePublishingDeps,
  slug: string,
  options: PagePublishOptions,
  answer: (card: PageShareCard) => ArtifactCardAnswer,
  audit: (record: ArtifactAuditRecord) => void,
): Promise<ChainOutcome> {
  const config = loadPageConfig(deps.workspaceRoot, slug)
  if (!config) {
    return { mode: 'create', code: 'PAGE_NOT_FOUND', verdict: { status: 'refused', note: `Page not found: ${slug}` } }
  }
  const grants = await (deps.readGrants ?? (s => readPageGrantsForPublish(deps.workspaceRoot, s)))(config.slug)
  const contentPath = getPageContentPath(deps.workspaceRoot, config.slug)
  const live = livePageEntry(deps.workspaceRoot, config.id, deps.now?.() ?? new Date())
  let lastBundle: PageShareBundle | undefined
  let code: string | undefined
  let card: PageShareCard | undefined

  const ports: ArtifactPublishPorts = {
    workspaceRoot: deps.workspaceRoot,
    sessionId: '',
    runtime: 'user (Pages)',
    permissionMode: 'n/a',
    sessionCwd: deps.workspaceRoot,
    addedRoots: [],
    unattendedReason: () => null,
    cardPending: () => false,
    raiseCard: async raised => {
      card = raised
      return answer(raised)
    },
    createClient: () => deps.createClient(),
    audit,
    ...(deps.now ? { now: deps.now } : {}),
    readSource: () => {
      try {
        lastBundle = buildPageShareBundle(deps.workspaceRoot, config.slug, {
          includeData: options.includeData === true,
          viewOnlyAcknowledged: options.viewOnlyAcknowledged === true,
          grants,
        })
      } catch (error) {
        if (!(error instanceof PageShareError)) throw error
        code = error.code
        // The guard's closest kind; the page's own code is the rule the audit row records.
        return {
          ok: false,
          kind: error.code === 'PAGE_SHARE_TOO_LARGE' ? 'too-large' : error.code === 'PAGE_NOT_FOUND' || error.code === 'PAGE_NO_CONTENT' ? 'not-found' : 'not-a-file',
          message: shareErrorSentence(error),
          rule: error.code,
        }
      }
      const guarded = guardPageShareBundle(lastBundle, contentPath)
      if (!guarded.ok) code = 'PAGE_SHARE_SECRET'
      return guarded
    },
    registrySource: {
      kind: 'page',
      sourceSessionId: '',
      sourcePath: pagePublicationSourcePath(config.slug),
      ...(live ? { updateTargetId: live.id } : {}),
      // Read at record time: the facet of the bundle that was actually sent.
      get page(): ArtifactPageFacet | undefined {
        return lastBundle
          ? { id: config.id, slug: config.slug, includesData: lastBundle.manifest.includesData, contentDigest: lastBundle.contentDigest }
          : undefined
      },
    },
  }
  const verdict = await runArtifactPublish(ports, {
    filePath: contentPath,
    title: config.name,
    ...(config.description ? { description: config.description } : {}),
    ...(live ? { url: live.url } : {}),
  })
  return { verdict, ...(card ? { card } : {}), ...(code ? { code } : {}), mode: live ? 'update' : 'create' }
}

const REVIEW_ONLY = 'review only'

/**
 * `pages:getShareDataScan` — the data scan (upstream's) and the review: the publish chain run with a card port that
 * captures the card and declines. No request is sent and no audit row is written (it is not a decision).
 */
export async function reviewPagePublish(
  deps: PagePublishingDeps,
  slug: string,
  options: PagePublishOptions,
): Promise<PageShareReview> {
  const scan = scanPageShareData(deps.workspaceRoot, slug)
  const outcome = await runPageChain(deps, slug, options, () => ({ allowed: false, refusal: REVIEW_ONLY }), () => {})
  if (outcome.card) {
    return { ...scan, review: { ok: true, mode: outcome.mode, card: outcome.card } }
  }
  return { ...scan, review: { ok: false, message: outcome.verdict.note, ...(outcome.code ? { code: outcome.code } : {}) } }
}

/**
 * `pages:publish` — the chain with the person's answer: the card is approved only when it is the card they reviewed
 * (`reviewedSha256`, the sha256 of the exact bytes). Exactly one POST (a create) or PUT (the page's own row).
 */
export async function publishPage(
  deps: PagePublishingDeps,
  slug: string,
  options: PagePublishOptions & { reviewedSha256: string },
): Promise<PagePublishResult> {
  const key = `${deps.workspaceRoot}\0${slug}`
  if (inFlight.has(key)) {
    return { status: 'refused', note: 'This page is already being published; wait for that to finish.' }
  }
  if (typeof options.reviewedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(options.reviewedSha256)) {
    return { status: 'refused', note: 'The page was not reviewed before publishing, so nothing was sent. Open Share and review it.' }
  }
  inFlight.add(key)
  try {
    const outcome = await runPageChain(
      deps,
      slug,
      options,
      card => card.sha256 === options.reviewedSha256
        ? { allowed: true }
        : { allowed: false, refusal: 'The page changed after you reviewed it, so nothing was sent. Review it again and publish.' },
      record => deps.audit?.(record),
    )
    const { status, note, url, expiresAt } = outcome.verdict
    return {
      status,
      note,
      ...(url !== undefined ? { url } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(outcome.code ? { code: outcome.code } : {}),
    }
  } finally {
    inFlight.delete(key)
  }
}

/**
 * `pages:unpublish` — one DELETE of the page's row (live, or one already owed a deletion: the retry). Nothing is sent
 * for a page with no row. Reuses the Published pages list's delete, so a retryable failure is kept as a pending
 * deletion and `gone` counts as deleted.
 */
export async function unpublishPage(
  deps: Pick<PagePublishingDeps, 'workspaceRoot' | 'createClient' | 'now'>,
  slug: string,
): Promise<PageUnpublishResult> {
  const config = loadPageConfig(deps.workspaceRoot, slug)
  const entry = config ? findPageRegistryEntry(readRegistry(deps.workspaceRoot), config.id) : undefined
  if (!entry) return { outcome: 'not-published' }
  const result = await deletePublishedArtifact(deps.workspaceRoot, deps.createClient(), {
    id: entry.id,
    url: entry.url,
    title: entry.title,
    expiresAt: entry.expiresAt,
    retentionDays: entry.retentionDays,
  }, deps.now ? { now: deps.now } : {})
  if (result.outcome === 'deleted') return { outcome: 'deleted' }
  return {
    outcome: result.outcome,
    ...(result.message ? { message: result.message } : {}),
    ...(result.errorKind ? { errorKind: result.errorKind } : {}),
  }
}

/**
 * The unpublish step `deletePageLocal` runs before a page's folder goes (`pages:delete` and `delete_page`): one
 * DELETE; anything but `deleted` reports that the public copy may remain (a pending deletion is still online until
 * its retry succeeds).
 */
export function unpublishBeforeDelete(
  deps: Pick<PagePublishingDeps, 'workspaceRoot' | 'createClient' | 'now'>,
): (page: { slug: string; publication: PagePublication }) => Promise<{ publicCopyMayRemain: boolean }> {
  return async page => {
    const result = await unpublishPage(deps, page.slug)
    return { publicCopyMayRemain: result.outcome !== 'deleted' && result.outcome !== 'not-published' }
  }
}
