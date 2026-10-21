/**
 * UA1.19 — RPC handlers for the Published pages list (t-artifacts, OQ-18; plan row UA1.19, waves.md O23): the
 * signed-in dp identity's OWN artifacts (`GET /api/artifacts/mine` — the service is the source of truth for the list)
 * joined to THIS workspace's registry (`@nessy-agent/shared/artifacts/registry`: which session published which file,
 * and which deletions are still owed). Ours: upstream craft-agents v0.13.4 has no counterpart (its share service is
 * cut under reason (a), plan §0.1 item 6).
 *
 * Channels (all REMOTE_ELIGIBLE, as `tasks:*`: the registry lives under the workspace root, and the dp identity that
 * publishes is the one on the server that owns the workspace — the same server `publish_artifact` runs on):
 * - `artifacts:list` — `/mine` joined to the registry. A deletion still owed is retried at the next successful sign-in:
 *   on the dp session's needs-login → ready boundary for every workspace ({@link retryOwedDeletesOnSignIn}, over
 *   `SessionManager.subscribeDpSessionState` — the broker the system and chat dp cards publish to, the one the MCP pool
 *   registry already watches), and again here once the list call itself has succeeded (a second trigger, not the only
 *   one). On `needs-login` the list answers ONE status (the renderer shows one card, opens no browser and spawns no
 *   `dp auth login` — the client never does) plus the registry's pending deletions, so a deletion still owed stays visible.
 * - `artifacts:setRetention` — `PATCH retention_days`, 0 (unlimited) to the service's ceiling; the renderer asks for
 *   its own confirmation first. The model's 1..30 range (UA1.18) is the TOOL's limit, not this one: longer and
 *   unlimited retention are exactly what only the user may set (OQ-22 (b)).
 * - `artifacts:delete` — `DELETE`, after the renderer's confirmation ("Deleting closes the link for everyone…"). A
 *   delete that fails for a reason a later attempt can fix (`needs-login`, `network`, `dp-unavailable`, `server`) is
 *   KEPT as a pending deletion in the registry — never dropped silently — including for a page published outside
 *   this workspace, which gets a minimal registry entry for it (`keepArtifactPendingDelete`); `gone` (404/410) means
 *   the page is already unreachable and its entry leaves. A refusal no retry fixes (`forbidden`, `policy`, `invalid`)
 *   is answered as a failure and keeps nothing.
 *
 * - `artifacts:publishFile` (UA1.23) — the user's "Publish" on an inline html-preview / markdown-preview block:
 *   `{ sessionId, filePath }`, a PATH and never bytes, handed to `SessionManager.publishArtifactFromUser`, the SAME
 *   path as `publish_artifact` (UA1.17 guard → UA1.18 card → client → registry → audit row) with the block's session
 *   as the source. The card, the 7-day default and every refusal are UA1.18's; this handler adds none of its own.
 *
 * Every handler runs `assertCallerWorkspace` (UA1.9) first, refusing `artifacts-workspace-mismatch`. No handler is
 * gated (spec §6): the safety of this surface is the user's own click behind a confirmation, the fixed-origin client
 * (UA1.16: the managed network policy, no redirects, the dp token per request and never logged) and the registry's
 * read floor. Nothing here returns a token, a request header or a response body — the client's sentences only.
 */
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type {
  ArtifactActionResult,
  ArtifactDeleteResult,
  ArtifactPublishFileRequest,
  ArtifactPublishFileResult,
  ArtifactsListResult,
  PublishedArtifactDto,
} from '@nessy-agent/shared/protocol'
import {
  ArtifactClientError,
  isTArtifactsUrl,
  MAX_RETENTION_DAYS,
  type ArtifactClientErrorKind,
  type OwnedArtifact,
  type TArtifactsClient,
} from '@nessy-agent/shared/artifacts/t-artifacts-client'
import {
  artifactEntryKind,
  keepArtifactPendingDelete,
  readArtifactRegistry,
  recordArtifactUpdate,
  removeArtifactRegistryEntry,
  type ArtifactRegistryEntry,
} from '@nessy-agent/shared/artifacts/registry'
import { pushTyped, type RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceOrThrow } from '../utils'
import { assertCallerWorkspace } from './caller-workspace'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.artifacts.LIST,
  RPC_CHANNELS.artifacts.SET_RETENTION,
  RPC_CHANNELS.artifacts.DELETE,
  RPC_CHANNELS.artifacts.PUBLISH_FILE,
] as const

/** The refusal every handler raises for a caller bound to another workspace (UA1.9). */
const WORKSPACE_MISMATCH = 'artifacts-workspace-mismatch'

/** The failures a later attempt can fix: a DELETE that met one of these is kept as a pending deletion. */
const RETRYABLE_DELETE_KINDS: ReadonlySet<ArtifactClientErrorKind> = new Set(['needs-login', 'network', 'dp-unavailable', 'server'])

/**
 * How long one retry pass keeps STARTING owed deletions (each one is a dp token plus one request, up to 30 s apiece).
 * The rest wait for the next pass. DECIDED with `artifacts:list`'s 145 s budget (`RPC_REQUEST_TIMEOUT_BY_CHANNEL`):
 * list ≤ 60 s + this window + the last retry started inside it (token ≤ 30 s + request ≤ 30 s) + 5 s.
 */
export const PENDING_DELETE_RETRY_WINDOW_MS = 20_000

/** Test seams, as `registerTasksHandlers` has one: the census tests register with two arguments. */
export interface ArtifactsHandlerOptions {
  /** Default: `SessionManager.createArtifactsClient()` — the fixed-origin client with the host's managed network policy. */
  createClient?: () => TArtifactsClient
  now?: () => Date
}

/** The dp session state the host publishes (`SessionManager.subscribeDpSessionState`). */
export type ArtifactsDpSessionState = 'ready' | 'needs-login' | 'unavailable'

function errorKindOf(error: unknown): ArtifactClientErrorKind {
  return error instanceof ArtifactClientError ? error.kind : 'network'
}

function errorMessageOf(error: unknown): string {
  return error instanceof ArtifactClientError ? error.message : 'The artifact service could not be reached.'
}

/**
 * A registry entry the workspace itself published from a session (a pending-only entry has no session), or a page
 * the user published from the Pages view (UA6.7: kind `page`, no session, its path `pages/<slug>`).
 */
function sourceOf(entry: ArtifactRegistryEntry | undefined): PublishedArtifactDto['source'] {
  if (!entry || (entry.sourceSessionId === '' && artifactEntryKind(entry) !== 'page')) return undefined
  return { sessionId: entry.sourceSessionId, path: entry.sourcePath, kind: artifactEntryKind(entry) }
}

function pendingOf(entry: ArtifactRegistryEntry | undefined): PublishedArtifactDto['pendingDelete'] {
  if (!entry?.pendingDelete) return undefined
  return {
    requestedAt: entry.pendingDelete.requestedAt,
    ...(entry.pendingDelete.lastErrorKind !== undefined ? { lastErrorKind: entry.pendingDelete.lastErrorKind } : {}),
  }
}

function retentionOf(days: number): number | null {
  return Number.isSafeInteger(days) && days >= 0 ? days : null
}

/** One row: the service's record when it listed one, else the registry's (a pending deletion the list no longer shows). */
export function toPublishedArtifactDto(owned: OwnedArtifact | undefined, entry: ArtifactRegistryEntry | undefined): PublishedArtifactDto {
  const base = owned ?? entry!
  const source = sourceOf(entry)
  const pendingDelete = pendingOf(entry)
  return {
    id: base.id,
    url: base.url,
    title: owned?.title || entry?.title || '',
    ...(owned?.emoji ? { emoji: owned.emoji } : {}),
    expiresAt: base.expiresAt,
    retentionDays: retentionOf(base.retentionDays),
    ...(source ? { source } : {}),
    ...(pendingDelete ? { pendingDelete } : {}),
  }
}

function readRegistryOrEmpty(workspaceRoot: string): { entries: ArtifactRegistryEntry[]; unreadable: boolean } {
  try {
    return { entries: readArtifactRegistry(workspaceRoot), unreadable: false }
  } catch {
    return { entries: [], unreadable: true }
  }
}

/**
 * `artifacts:list`: `/mine` → retry the owed deletions (bounded by {@link PENDING_DELETE_RETRY_WINDOW_MS}) → join.
 * Never throws for a service failure: the status says what happened.
 */
export async function listPublishedArtifacts(
  workspaceRoot: string,
  client: TArtifactsClient,
  options: { now?: () => Date } = {},
): Promise<ArtifactsListResult> {
  const clock = options.now ?? (() => new Date())
  let owned: OwnedArtifact[]
  try {
    owned = await client.listOwnedArtifacts()
  } catch (error) {
    const kind = errorKindOf(error)
    const { entries } = readRegistryOrEmpty(workspaceRoot)
    return {
      status: kind === 'needs-login' ? 'needs-login' : 'unavailable',
      errorKind: kind,
      message: errorMessageOf(error),
      // A deletion still owed stays visible while the list cannot be read.
      artifacts: entries.filter(entry => entry.pendingDelete).map(entry => toPublishedArtifactDto(undefined, entry)),
    }
  }

  // The list call succeeded, so the token works: retry what is owed (oldest request first).
  const deleted = await retryOwedArtifactDeletes(workspaceRoot, client, { now: clock })
  const retriedDeletes = deleted.size

  const { entries, unreadable } = readRegistryOrEmpty(workspaceRoot)
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const rows: PublishedArtifactDto[] = []
  for (const item of owned) {
    if (deleted.has(item.id)) continue
    rows.push(toPublishedArtifactDto(item, byId.get(item.id)))
    byId.delete(item.id)
  }
  // Pending deletions the service no longer lists (expired, or listed under another identity) are still shown.
  for (const entry of byId.values()) {
    if (entry.pendingDelete) rows.push(toPublishedArtifactDto(undefined, entry))
  }
  return {
    status: 'ok',
    artifacts: rows,
    ...(retriedDeletes > 0 ? { retriedDeletes } : {}),
    ...(unreadable ? { message: 'This workspace\'s artifact registry could not be read; pages are listed without their source sessions.' } : {}),
  }
}

/**
 * Retry this workspace's owed deletions, oldest request first, STARTING them for {@link PENDING_DELETE_RETRY_WINDOW_MS}:
 * a success or `gone` (404/410) removes the entry; any other failure keeps it owed with the new error kind. Returns
 * the ids that left. Shared by the list and the sign-in boundary, so the two cannot drift.
 */
export async function retryOwedArtifactDeletes(
  workspaceRoot: string,
  client: TArtifactsClient,
  options: { now?: () => Date } = {},
): Promise<Set<string>> {
  const clock = options.now ?? (() => new Date())
  const deleted = new Set<string>()
  const started = clock().getTime()
  const owed = readRegistryOrEmpty(workspaceRoot).entries
    .filter(entry => entry.pendingDelete)
    .sort((a, b) => a.pendingDelete!.requestedAt.localeCompare(b.pendingDelete!.requestedAt))
  for (const entry of owed) {
    if (clock().getTime() - started > PENDING_DELETE_RETRY_WINDOW_MS) break
    try {
      await client.deleteArtifact({ id: entry.id })
      removeArtifactRegistryEntry(workspaceRoot, entry.id)
      deleted.add(entry.id)
    } catch (error) {
      const kind = errorKindOf(error)
      if (kind === 'gone') {
        removeArtifactRegistryEntry(workspaceRoot, entry.id)
        deleted.add(entry.id)
      } else {
        keepArtifactPendingDelete(workspaceRoot, entry, kind, clock())
      }
    }
  }
  return deleted
}

/**
 * The listener {@link registerArtifactsHandlers} subscribes to the host's dp session state: on the boundary into
 * `ready` (the first `ready` after any other state, the start included — the pool registry's rule), every workspace
 * whose registry owes a deletion gets one retry pass. A workspace that owes nothing creates no client and asks dp for
 * no token. Passes run one at a time; a failure is kept owed by {@link retryOwedArtifactDeletes} and never thrown into
 * the broker. Returns the pass's promise (the tests await it; the broker ignores it).
 */
export function retryOwedDeletesOnSignIn(
  workspaceRoots: () => string[],
  createClient: () => TArtifactsClient | undefined,
  options: { now?: () => Date } = {},
): (state: ArtifactsDpSessionState) => Promise<void> | undefined {
  let ready = false
  let queue: Promise<void> = Promise.resolve()
  return state => {
    const crossed = state === 'ready' && !ready
    ready = state === 'ready'
    if (!crossed) return undefined
    queue = queue.then(async () => {
      let roots: string[]
      try {
        roots = workspaceRoots()
      } catch {
        return
      }
      for (const root of roots) {
        try {
          if (!readArtifactRegistry(root).some(entry => entry.pendingDelete)) continue
          const client = createClient()
          if (!client) return
          await retryOwedArtifactDeletes(root, client, options)
        } catch {
          // An unreadable registry or a failed client: the deletion stays owed; the list shows it and retries it.
        }
      }
    })
    return queue
  }
}

/** `artifacts:setRetention`: one PATCH; the registry follows when the workspace holds the entry. */
export async function setPublishedArtifactRetention(
  workspaceRoot: string,
  client: TArtifactsClient,
  id: string,
  retentionDays: number,
): Promise<ArtifactActionResult> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > MAX_RETENTION_DAYS) {
    return { ok: false, errorKind: 'invalid', message: `The retention must be a whole number of days from 0 (unlimited) to ${MAX_RETENTION_DAYS}.` }
  }
  try {
    const record = await client.patchArtifact({ id }, { retentionDays })
    let entry: ArtifactRegistryEntry | undefined
    try {
      entry = readArtifactRegistry(workspaceRoot).some(existing => existing.id === record.id)
        ? recordArtifactUpdate(workspaceRoot, { record, retentionSent: true })
        : undefined
    } catch {
      entry = undefined
    }
    return { ok: true, artifact: toPublishedArtifactDto(record, entry) }
  } catch (error) {
    return { ok: false, errorKind: errorKindOf(error), message: errorMessageOf(error) }
  }
}

/** `artifacts:delete`: one DELETE; a retryable failure is kept as a pending deletion, never dropped. */
export async function deletePublishedArtifact(
  workspaceRoot: string,
  client: TArtifactsClient,
  target: { id: string; url: string; title?: string; expiresAt?: string | null; retentionDays?: number | null },
  options: { now?: () => Date } = {},
): Promise<ArtifactDeleteResult> {
  // The link is kept in the registry if the delete is owed, so it must be a link on the one origin.
  if (!isTArtifactsUrl(target.url)) {
    return { outcome: 'failed', errorKind: 'invalid', message: 'Only pages on the artifact service can be deleted here.' }
  }
  try {
    await client.deleteArtifact({ id: target.id })
  } catch (error) {
    const kind = errorKindOf(error)
    if (kind !== 'gone') {
      const message = errorMessageOf(error)
      if (!RETRYABLE_DELETE_KINDS.has(kind)) return { outcome: 'failed', errorKind: kind, message }
      try {
        keepArtifactPendingDelete(workspaceRoot, {
          id: target.id,
          url: target.url,
          title: target.title ?? '',
          expiresAt: target.expiresAt ?? null,
          retentionDays: target.retentionDays ?? Number.NaN,
        }, kind, (options.now ?? (() => new Date()))())
      } catch {
        // The registry could not record it: say so — this is the one case the deletion is NOT kept.
        return {
          outcome: 'failed',
          errorKind: kind,
          message: `${message} The deletion could not be kept for a retry, because this workspace's artifact registry could not be written.`,
        }
      }
      return { outcome: 'pending', errorKind: kind, message }
    }
  }
  try {
    removeArtifactRegistryEntry(workspaceRoot, target.id)
  } catch {
    // The page is gone either way; an unreadable registry keeps its old row, which the next list shows as gone.
  }
  return { outcome: 'deleted' }
}

export function registerArtifactsHandlers(server: RpcServer, deps: HandlerDeps, options: ArtifactsHandlerOptions = {}): void {
  const workspaceRootOf = (workspaceId: string): string =>
    getWorkspaceOrThrow(deps.workspaceService, workspaceId).workspaceRootPath
  const clientFor = (): TArtifactsClient => {
    const client = options.createClient?.() ?? deps.sessionManager.createArtifactsClient?.()
    if (!client) throw new Error('artifacts-unavailable')
    return client
  }

  // UA12.117 — the registry row `id` is a page the user published from the Pages view (`kind: 'page'`, UA6.7);
  // read BEFORE the action, because a delete removes the row. An unreadable registry is not a page row: the push
  // is a refresh for open views, never a gate on the action.
  const isPageRegistryRow = (workspaceRoot: string, id: string): boolean => {
    try {
      const entry = readArtifactRegistry(workspaceRoot).find(candidate => candidate.id === id)
      return entry !== undefined && artifactEntryKind(entry) === 'page'
    } catch {
      return false
    }
  }

  // UA12.117 — the same copy rpc/pages.ts's own mutations push: the workspace's pages with their registry joins
  // (`loadWorkspacePages` binds each page's `publication`), so an open Pages view re-reads its share badge.
  const broadcastPagesChanged = async (workspaceId: string, workspaceRoot: string): Promise<void> => {
    const { loadWorkspacePages } = await import('@nessy-agent/shared/pages')
    pushTyped(server, RPC_CHANNELS.pages.CHANGED, { to: 'workspace', workspaceId }, workspaceId, loadWorkspacePages(workspaceRoot))
  }
  // "Retried after the next successful sign-in" (the row and the UI copy): the dp sign-in boundary, for every workspace.
  deps.sessionManager.subscribeDpSessionState?.(retryOwedDeletesOnSignIn(
    () => deps.workspaceService?.listResolved().map(workspace => workspace.workspaceRootPath) ?? [],
    () => options.createClient?.() ?? deps.sessionManager.createArtifactsClient?.(),
    { now: options.now },
  ))

  server.handle(RPC_CHANNELS.artifacts.LIST, async (ctx, workspaceId: string): Promise<ArtifactsListResult> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    return listPublishedArtifacts(workspaceRootOf(workspaceId), clientFor(), { now: options.now })
  })

  server.handle(RPC_CHANNELS.artifacts.SET_RETENTION, async (ctx, workspaceId: string, id: string, retentionDays: number): Promise<ArtifactActionResult> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    const workspaceRoot = workspaceRootOf(workspaceId)
    const result = await setPublishedArtifactRetention(workspaceRoot, clientFor(), String(id), Number(retentionDays))
    // UA12.117 — an extend of a page row is a share state the open Pages view must see; a file row is not.
    if (result.ok && isPageRegistryRow(workspaceRoot, String(id))) await broadcastPagesChanged(workspaceId, workspaceRoot)
    return result
  })

  server.handle(RPC_CHANNELS.artifacts.DELETE, async (
    ctx,
    workspaceId: string,
    target: { id: string; url: string; title?: string; expiresAt?: string | null; retentionDays?: number | null },
  ): Promise<ArtifactDeleteResult> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    if (!target || typeof target.id !== 'string' || typeof target.url !== 'string') {
      return { outcome: 'failed', errorKind: 'invalid', message: 'The page to delete was not named.' }
    }
    const workspaceRoot = workspaceRootOf(workspaceId)
    // UA12.117 — read before the action: a successful delete REMOVES the row. `pending` pushes too — the
    // pending-deletion badge is a registry state an open Pages view must see.
    const wasPage = isPageRegistryRow(workspaceRoot, target.id)
    const result = await deletePublishedArtifact(workspaceRoot, clientFor(), target, { now: options.now })
    if (wasPage && (result.outcome === 'deleted' || result.outcome === 'pending')) {
      await broadcastPagesChanged(workspaceId, workspaceRoot)
    }
    return result
  })

  server.handle(RPC_CHANNELS.artifacts.PUBLISH_FILE, async (
    ctx,
    workspaceId: string,
    req: ArtifactPublishFileRequest,
  ): Promise<ArtifactPublishFileResult> => {
    assertCallerWorkspace(ctx, deps, workspaceId, WORKSPACE_MISMATCH)
    if (!req || typeof req.sessionId !== 'string' || typeof req.filePath !== 'string') {
      return { status: 'refused', note: 'The preview named no session or no file, so nothing was published.' }
    }
    const sessionManager = deps.sessionManager
    if (!sessionManager.publishArtifactFromUser) throw new Error('artifacts-unavailable')
    return await sessionManager.publishArtifactFromUser(req.sessionId, req.filePath, workspaceId)
  })
}
