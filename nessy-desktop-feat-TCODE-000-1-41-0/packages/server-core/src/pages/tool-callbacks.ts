/**
 * Pages Tool Callbacks
 *
 * Backend implementation of the agent-facing pages tools (list_pages,
 * get_page, create_page, update_page, write_page_data, delete_page).
 * SessionManager builds one instance per session, bound to the invoking
 * session's workspace (`SessionManager.pagesToolCallbacksForAgent`).
 *
 * Storage flows are the SAME primitives the pages RPC handlers use
 * (@nessy-agent/shared/pages) — including deletePageLocal, shared verbatim
 * with the pages:delete RPC so the two delete paths cannot drift.
 * Every mutation calls deps.onPagesMutated so the host can poke the config
 * watcher and broadcast `pages:changed`, exactly like the RPC handlers do.
 *
 * UA6.2 — copied from craft-agents-oss `v0.13.4:packages/server-core/src/pages/tool-callbacks.ts` (Apache-2.0),
 * adapted:
 * - NESSY: `delete_page` asks the HOST first ({@link PagesToolCallbacksDeps.confirmDelete}, required): a one-shot,
 *   non-rememberable card in every mode, `bypassPermissions` included, and a refusal with no card when nobody can
 *   answer one (spec §13, §17 S11; upstream deletes on the tool call). A refusal throws its sentence, so the
 *   verbatim `handleDeletePage` (UA6.3) answers "Failed to delete page: <sentence>" and nothing is removed.
 * - The tool-facing types (`PagesToolCallbacks` …) live in `@nessy-agent/session-tools-core`'s `context.ts` and are
 *   imported from there as upstream does (UA6.3 moved them; re-exported below for this module's readers).
 * - UA9.3: v0.13.4 L109–L119 + L129 (`grants`) read the host-approvals ledger (`listPageGrants`, UA9.2), never page.json
 *   (reason (b)); `stale` is upstream's `!isPageGrantUsable` against the digest of the page's bytes on disk (the digest
 *   the broker checks). A host with no ledger key lists none (the closed failure).
 * - UA6.7: v0.13.4 L70 + L130 (`shared`, `shareUrl`) read `LoadedPage.publication` (the artifact registry's `'page'`
 *   row, never page.json): shared = a live row (not pending deletion; an expired row is no publication), as the Pages view.
 * - UA8.2: v0.13.4 L68, L174, L197 (`refresh` on the summary, on create and on update) land REWRITTEN: the tool's
 *   `refresh` carries script CONTENT, and `setPageRefresh` (`@nessy-agent/shared/pages`) writes `pages/{slug}/refresh.ts`
 *   and page.json; the input is validated BEFORE any write (`parsePageRefreshInput`), so an invalid refresh fails the
 *   whole create or update as upstream's validate-on-write does. The upstream script-path spec is dropped under reason (b).
 * - UA7.4: `onContentChanged` (v0.13.4 L39–L44, L177, L207) lets the host enqueue a poster capture.
 */

import { existsSync, statSync } from 'node:fs'
import { getHostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import type { LoadedPage, PageDataSnapshot, PageKind, PageUnpublishBeforeDelete, UpdatePagePatch } from '@nessy-agent/shared/pages'
import { UNATTENDED_WHY, type ArtifactUnattendedReason } from '../sessions/artifact-publishing.ts'
import type {
  CreatePageToolInput,
  PageDataToolPatch,
  PagesToolCallbacks,
  PageToolDataSummary,
  PageToolDetails,
  PageToolSummary,
  UpdatePageToolPatch,
} from '@nessy-agent/session-tools-core'

export type {
  CreatePageToolInput,
  DeletePageToolResult,
  PageDataToolPatch,
  PageDataWriteSummary,
  PagesToolCallbacks,
  PageToolDataSummary,
  PageToolDetails,
  PageToolSummary,
  UpdatePageToolPatch,
} from '@nessy-agent/session-tools-core'

// ============================================================
// The delete confirmation (NESSY)
// ============================================================

/** The host's answer for one `delete_page` call. */
export type PageDeleteConfirmation = { allowed: true } | { allowed: false; refusal: string }

/** The page a `delete_page` card names. */
export interface PageDeleteSubject {
  slug: string
  name: string
}

/**
 * How long a `delete_page` card waits before it resolves to a DENY. 110 s, DECIDED (transparent, simple) for the
 * reason `PUBLISH_ARTIFACT_CARD_TIMEOUT_MS` gives (`sessions/artifact-publishing.ts`): inside the 120 s ceilings of
 * the codex bridge client and the Pi descriptor, so the host decides and the model is told "declined" rather than
 * meeting a transport timeout — and a page is never deleted after the model was told the call failed.
 */
export const DELETE_PAGE_CARD_TIMEOUT_MS = 110_000

/** The sentence the model reads when nobody can answer a `delete_page` card (UA1.18's unattended predicate; UA12.61 — the clause is `sessions/artifact-publishing.ts`'s one `UNATTENDED_WHY`, never a second copy). */
export function pageDeleteUnattendedRefusal(reason: ArtifactUnattendedReason, page: PageDeleteSubject): string {
  return `delete_page needs the user to approve a confirmation card, and ${UNATTENDED_WHY[reason]}, so the page `
    + `"${page.name}" (${page.slug}) was not deleted. Tell the user which page to delete; they can delete it from an `
    + 'open session.'
}

// ============================================================
// Callbacks
// ============================================================

export interface PagesToolCallbacksDeps {
  workspaceId: string
  workspaceRootPath: string
  log?: (message: string) => void
  /**
   * Called after every successful mutation (create/update/write/delete) with
   * the page slug. The host notifies the config watcher and broadcasts
   * `pages:changed` here.
   */
  onPagesMutated?: (pageSlug: string) => void | Promise<void>
  /**
   * Called specifically when a page's HTML content changed (create-with-content
   * or update-with-content) so the host can enqueue a thumbnail (re)capture.
   * Not fired for data-only writes (those don't change the content digest).
   */
  onContentChanged?: (pageSlug: string) => void
  /**
   * NESSY — the host's decision for ONE `delete_page` call, asked after the page is found and before anything is
   * removed. Required: there is no delete without a decision.
   */
  confirmDelete: (page: PageDeleteSubject) => Promise<PageDeleteConfirmation>
  /**
   * UA6.7 — the unpublish step `deletePageLocal` runs before a PUBLISHED page's folder goes (one DELETE through the
   * artifact registry; `pages/page-publishing.ts` `unpublishBeforeDelete`). Without it, deleting a published page
   * reports `publicCopyMayRemain: true` — never a copy claimed offline that nobody took down.
   */
  unpublishPage?: PageUnpublishBeforeDelete
}

const PAGE_KINDS: readonly string[] = ['static', 'interactive', 'live']

function assertKind(kind: string | undefined): PageKind | undefined {
  if (kind === undefined) return undefined
  if (!PAGE_KINDS.includes(kind)) {
    throw new Error(`Invalid page kind "${kind}" — expected static | interactive | live`)
  }
  return kind as PageKind
}

function toSummary(page: LoadedPage): PageToolSummary {
  const config = page.config
  return {
    slug: config.slug,
    name: config.name,
    description: config.description,
    kind: config.kind,
    projectId: config.projectId,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    hasContent: existsSync(page.contentPath),
    ...(config.refresh ? { refresh: config.refresh } : {}), // UA8.2 — v0.13.4 L68
    lastRefresh: config.lastRefresh,
    shared: livePublicationUrl(page) !== undefined, // UA6.7 — v0.13.4 L70
    folderPath: page.folderPath,
  }
}

/**
 * UA6.7 — the page's public link while its publication is LIVE: the registry row exists, is not expired (the loaders
 * drop an expired row) and no unpublish is pending — the same rule the Pages view's Published badge reads.
 */
function livePublicationUrl(page: LoadedPage): string | undefined {
  return page.publication && !page.publication.pendingDelete ? page.publication.url : undefined
}

function toDataSummary(page: LoadedPage, snapshot: PageDataSnapshot | null): PageToolDataSummary | null {
  if (!snapshot) return null
  return {
    generatedAt: snapshot.generatedAt,
    kvKeys: Object.keys(snapshot.kv),
    series: Object.entries(snapshot.series).map(([name, points]) => ({
      name,
      points: points.length,
      // Snapshot series are ascending by t — the last point is the newest.
      latest: points.length > 0 ? points[points.length - 1] : undefined,
    })),
    snapshotPath: page.snapshotPath,
  }
}

function toDetails(
  page: LoadedPage,
  options: { includeContent: boolean },
  helpers: {
    readSnapshot: () => PageDataSnapshot | null
    loadContent: () => string | null
    /** UA9.3 — the page's grants as the agent sees them (from the ledger). */
    grants: PageToolDetails['grants']
  },
): PageToolDetails {
  const config = page.config
  const summary = toSummary(page)

  let contentLength: number | undefined
  if (summary.hasContent) {
    try {
      contentLength = statSync(page.contentPath).size
    } catch {
      contentLength = undefined
    }
  }

  return {
    ...summary,
    id: config.id,
    contentDigest: config.contentDigest,
    contentLength,
    contentPath: page.contentPath,
    data: toDataSummary(page, helpers.readSnapshot()),
    grants: helpers.grants,
    ...(livePublicationUrl(page) !== undefined ? { shareUrl: livePublicationUrl(page) } : {}), // UA6.7 — v0.13.4 L130
    ...(options.includeContent ? { content: helpers.loadContent() ?? undefined } : {}),
  }
}

export function buildPagesToolCallbacks(deps: PagesToolCallbacksDeps): PagesToolCallbacks {
  const { workspaceId, workspaceRootPath } = deps

  async function loadDetails(slug: string, includeContent = false): Promise<PageToolDetails | null> {
    const { loadPage, loadPageById, readPageDataSnapshot, loadPageContent } = await import('@nessy-agent/shared/pages')
    const page = loadPage(workspaceRootPath, slug) ?? loadPageById(workspaceRootPath, slug)
    if (!page) return null
    return toDetails(page, { includeContent }, {
      readSnapshot: () => readPageDataSnapshot(workspaceRootPath, page.config.slug),
      loadContent: () => loadPageContent(workspaceRootPath, page.config.slug),
      grants: await pageToolGrants(workspaceRootPath, page.config.slug),
    })
  }

  async function mutated(pageSlug: string): Promise<void> {
    try {
      await deps.onPagesMutated?.(pageSlug)
    } catch (error) {
      deps.log?.(`pages tool: post-mutation notify failed for ${pageSlug}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    async listPages(): Promise<PageToolSummary[]> {
      const { loadWorkspacePages } = await import('@nessy-agent/shared/pages')
      return loadWorkspacePages(workspaceRootPath).map(toSummary)
    },

    async getPage(slug: string, options?: { includeContent?: boolean }): Promise<PageToolDetails | null> {
      return loadDetails(slug, options?.includeContent === true)
    },

    async createPage(input: CreatePageToolInput): Promise<PageToolDetails> {
      const { createPage, parsePageRefreshInput, setPageRefresh } = await import('@nessy-agent/shared/pages')
      if (input.refresh !== undefined) parsePageRefreshInput(input.refresh) // UA8.2 — refuse before the page exists
      let config = createPage(workspaceRootPath, {
        name: input.name.trim(),
        description: input.description,
        kind: assertKind(input.kind),
        projectId: input.projectId,
        content: input.content,
      })
      if (input.refresh !== undefined) config = setPageRefresh(workspaceRootPath, config.slug, input.refresh)
      await mutated(config.slug)
      if (input.content !== undefined) deps.onContentChanged?.(config.slug)
      deps.log?.(`pages tool: created page ${config.slug} in workspace ${workspaceId}`)
      const details = await loadDetails(config.slug)
      if (!details) throw new Error(`Created page ${config.slug} but failed to reload it`)
      return details
    },

    async updatePage(slug: string, patch: UpdatePageToolPatch): Promise<PageToolDetails> {
      const { updatePage, savePageContent, loadPage, parsePageRefreshInput, setPageRefresh } = await import('@nessy-agent/shared/pages')
      const existing = loadPage(workspaceRootPath, slug)
      if (!existing) throw new Error(`Page not found: ${slug}`)
      // UA8.2 — validate a new refresh before anything is written (null removes it).
      if (patch.refresh !== undefined && patch.refresh !== null) parsePageRefreshInput(patch.refresh)

      // Config patch: only include provided keys. Explicit null passes
      // through — "null clears" is normalized once, inside shared updatePage,
      // so this path and the pages:update RPC cannot drift.
      const configPatch: UpdatePagePatch = {}
      if (patch.name !== undefined) configPatch.name = patch.name.trim()
      if (patch.kind !== undefined) configPatch.kind = assertKind(patch.kind)
      if (patch.description !== undefined) configPatch.description = patch.description
      if (patch.projectId !== undefined) configPatch.projectId = patch.projectId

      if (Object.keys(configPatch).length > 0) {
        updatePage(workspaceRootPath, existing.config.slug, configPatch)
      }
      if (patch.refresh !== undefined) setPageRefresh(workspaceRootPath, existing.config.slug, patch.refresh)
      if (patch.content !== undefined) {
        savePageContent(workspaceRootPath, existing.config.slug, patch.content)
      }

      await mutated(existing.config.slug)
      if (patch.content !== undefined) deps.onContentChanged?.(existing.config.slug)
      const details = await loadDetails(existing.config.slug)
      if (!details) throw new Error(`Updated page ${slug} but failed to reload it`)
      return details
    },

    async writePageData(slug: string, patch: PageDataToolPatch) {
      const { writePageData } = await import('@nessy-agent/shared/pages')
      const { result } = await writePageData(workspaceRootPath, slug, patch)
      await mutated(slug)
      return {
        slug: result.pageSlug,
        kvCount: result.kvCount,
        seriesCount: result.seriesCount,
        generatedAt: result.generatedAt,
        snapshotPath: result.snapshotPath,
        durationMs: result.durationMs,
      }
    },

    async deletePage(slug: string) {
      const { deletePageLocal, loadPage } = await import('@nessy-agent/shared/pages')
      const existing = loadPage(workspaceRootPath, slug)
      if (!existing) throw new Error(`Page not found: ${slug}`)
      // NESSY: the host decides before anything is removed (see the module header).
      const decision = await deps.confirmDelete({ slug: existing.config.slug, name: existing.config.name })
      if (!decision.allowed) throw new Error(decision.refusal)
      const outcome = await deletePageLocal(workspaceRootPath, workspaceId, existing.config.slug, {
        log: deps.log,
        ...(deps.unpublishPage ? { unpublish: deps.unpublishPage } : {}), // UA6.7 — after the card, before the folder
      })
      await mutated(existing.config.slug)
      deps.log?.(`pages tool: deleted page ${existing.config.slug}`)
      return { deleted: true as const, publicCopyMayRemain: outcome.publicCopyMayRemain }
    },
  }
}

/**
 * UA9.3 — a page's grants for `get_page` (v0.13.4 L109–L119): read from the host-approvals ledger, `stale` when the
 * grant is bound to other content than the page's bytes now, or expired. No key (a headless host) → none listed.
 */
async function pageToolGrants(workspaceRootPath: string, pageSlug: string): Promise<PageToolDetails['grants']> {
  const { listPageGrants, isPageGrantUsable, loadPageContent, computePageContentDigest } = await import('@nessy-agent/shared/pages')
  let key: Buffer
  try {
    key = await getHostApprovalsKeyProvider().getKey()
  } catch {
    return []
  }
  const content = loadPageContent(workspaceRootPath, pageSlug)
  const digest = content === null ? undefined : computePageContentDigest(content)
  const now = Date.now()
  return listPageGrants(workspaceRootPath, key, pageSlug).map((grant) => ({
    id: grant.id,
    kind: grant.action.kind,
    ...(grant.action.kind === 'script'
      ? { script: grant.action.script }
      : { sourceSlug: grant.action.sourceSlug }),
    description: grant.description,
    expiresAt: grant.expiresAt,
    stale: !isPageGrantUsable(grant, digest, now),
  }))
}
