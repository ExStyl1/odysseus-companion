/**
 * Page Types (shared layer)
 *
 * The domain/protocol types live in @nessy-agent/core (renderer-safe); this
 * module re-exports them and adds the storage-layer shapes that carry
 * absolute paths or creation inputs.
 *
 * File structure: see the docblock in @nessy-agent/core types/page.ts.
 *
 * UA6.1 — copied from craft-agents-oss `v0.13.4:packages/shared/src/pages/types.ts` (Apache-2.0). The two
 * re-exports core no longer carries are gone (`PageActionGrant` — reason (b), grants live in the host ledger;
 * `PageShareInfo` — reason (a), see the core module's header), and `isPageGrantUsable` takes the two
 * fields it reads structurally instead of `Pick<PageActionGrant, …>`. UA6.7 (ours): `PagePublication` is
 * re-exported and {@link LoadedPage} carries `publication`, joined from the workspace's artifact registry by the
 * loaders (`storage.ts` `loadPage` / `loadWorkspacePages`) — never from page.json.
 */

import type { PageConfig, PageKind, PagePublication, PageRefreshSpec } from '@nessy-agent/core';

// Re-export the core page types so consumers can import everything from
// '@nessy-agent/shared/pages' (mirrors how sources/projects expose types).
export type {
  PageKind,
  PageScriptRuntime,
  PageRefreshSpec,
  PageRefreshStatus,
  PageSeriesPoint,
  PageDataSnapshot,
  PageActionHttpMethod,
  PageActionDescriptor,
  PageRenderLease,
  PageActionInvocation,
  PageActionRequest,
  PageActionResult,
  PageThumbnailInfo,
  PageConfig,
  PagePublication,
} from '@nessy-agent/core';

/**
 * Whether a grant is currently usable: bound to the given content digest and
 * not expired. The single definition of "usable"/"stale" — the render frame,
 * the publish ack requirement, and the get_page stale flag must all agree.
 * Pure and browser-safe (this module is imported by the renderer).
 */
export function isPageGrantUsable(
  grant: { contentDigest: string; expiresAt: number },
  contentDigest: string | undefined,
  now: number,
): boolean {
  return contentDigest !== undefined && grant.contentDigest === contentDigest && grant.expiresAt > now;
}

/**
 * Whether a request path contains a directory-traversal segment. Page API
 * invocations are matched against an anchored grant pattern and then handed to
 * fetch, which normalizes `..` — so a grant for `/repos/.*` could otherwise be
 * abused to reach `/repos/../../admin`. Reject such paths before the match so
 * match and execution can never disagree. Decodes one percent-layer first so
 * encoded forms (`%2e%2e`, `..%2f`) are caught too; a malformed encoding is
 * treated as unsafe. Pure and browser-safe — the server-side PageActionBroker
 * (authoritative) and the renderer page-bridge (defense-in-depth) both call it.
 */
export function hasPathTraversal(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true; // malformed percent-encoding — treat as unsafe
  }
  return decoded.split(/[/\\]/).includes('..');
}

/**
 * Page creation input (without auto-generated fields)
 */
export interface CreatePageInput {
  name: string;
  description?: string;
  /** Runtime capability class (default: 'interactive') */
  kind?: PageKind;
  /** Stable Project ID to bind this page to */
  projectId?: string;
  /** Initial index.html content (sets contentDigest when provided) */
  content?: string;
  refresh?: PageRefreshSpec;
}

/**
 * Fully loaded page (config + folder paths)
 */
export interface LoadedPage {
  config: PageConfig;
  /** Absolute path to the page folder */
  folderPath: string;
  /** Absolute path to index.html (may not exist yet) */
  contentPath: string;
  /** Absolute path to the data/ folder */
  dataPath: string;
  /** Absolute path to data/snapshot.json (may not exist yet) */
  snapshotPath: string;
  /** Absolute path to workspace folder */
  workspaceRootPath: string;
  /** Workspace this page belongs to (derived from basename of workspaceRootPath) */
  workspaceId: string;
  /** UA6.7 — the page's copy on t-artifacts, from the workspace's artifact registry; absent = private. */
  publication?: PagePublication;
}

// ============================================================
// UA6.7 — publishing a page on t-artifacts (wire shapes; ours)
// ============================================================

/** The host card a page publish is reviewed with — the SAME payload `publish_artifact`'s card carries (UA1.18). */
export type PageShareCard = NonNullable<import('@nessy-agent/core').PermissionRequest['artifactPublish']>;

/** What the person chose in the Share dialog. */
export interface PagePublishOptions {
  /** Inline the page's current data snapshot (default off). */
  includeData: boolean;
  /** The person confirmed the published copy is view-only (required while the page has usable source grants). */
  viewOnlyAcknowledged?: boolean;
}

/**
 * `pages:getShareDataScan` — upstream's data scan (what `includeData` would publish and which key names look like
 * secrets), plus OUR review: the host card for exactly the bytes a publish with these options would send, or the
 * sentence why nothing can be sent. `code` is the bundle's `PageShareErrorCode` when it refused.
 */
export interface PageShareReview {
  snapshotBytes: number | null;
  secretCandidates: string[];
  review:
    | { ok: true; mode: 'create' | 'update'; card: PageShareCard }
    | { ok: false; message: string; code?: string };
}

/** `pages:publish` — the outcome of one publish: `published`/`updated` carry the link. */
export interface PagePublishResult {
  status: 'published' | 'updated' | 'denied' | 'refused' | 'failed';
  note: string;
  url?: string;
  expiresAt?: string | null;
  code?: string;
}

/** `pages:unpublish` — one DELETE; a failure a retry can fix is kept as a pending deletion (UA1.19). */
export interface PageUnpublishResult {
  outcome: 'deleted' | 'pending' | 'failed' | 'not-published';
  message?: string;
  errorKind?: string;
}
