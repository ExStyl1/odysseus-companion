/**
 * Pages - Public API
 *
 * Workspace-scoped mini dashboards: storage/CRUD, refresh-hook matchers, and
 * the mediated source-action bridge.
 *
 * NOT exported here: ./data-store.ts (bun:sqlite) — Bun-only by design, import
 * it via the '@nessy-agent/shared/pages/data-store' subpath from Bun scripts.
 * Guarded by `pages-index-no-bun-sqlite` (data-store.test.ts).
 *
 * UA6.1 — copied from craft-agents-oss `v0.13.4:packages/shared/src/pages/index.ts` (Apache-2.0), staged:
 * - dropped: v0.13.4 L21 (`PageActionGrant`), L68–L71 (`addPageGrant`, `revokePageGrant`, `AddPageGrantInput`),
 *   L83 (`DEFAULT_PAGE_GRANT_TTL_MS`) and L93 (`PageActionGrantSchema`) — reason (b), grants live in the host
 *   ledger (UA9.2).
 * - dropped: v0.13.4 L153–L164 (`PagePublisher` and the rest of `publisher.ts`) — reason (a), the Craft
 *   share-service client; its local-delete half is `deletePageLocal`, exported from storage below.
 * - dropped: v0.13.4 L26, L72–L73, L94 (`PageShareInfo`, `setPageShareState`, `PageShareInfoSchema`) — reason (a), the
 *   Craft publication pointer in page.json. UA6.7 exports OUR publication type (`PagePublication`, from the artifact
 *   registry) and `pagePublicationFromRegistry` instead.
 * - UA6.7: v0.13.4 L136–L152 (`share-bundle.ts`) below, adapted to t-artifacts (one self-contained document).
 * - UA8.2: v0.13.4 L103–L109 (`refresh.ts`, the synthetic refresh matchers) below, plus the host-written script and
 *   its ledger approval (`setPageRefresh`, `approvePageRefresh`, `readPageRefreshApproval`).
 * - UA9.2: v0.13.4 L127–L134 (`action-bridge.ts`) below, plus the ledger grant helpers that replace the dropped L68–L71.
 */

// Types (core page types re-exported plus storage-layer shapes)
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
  CreatePageInput,
  LoadedPage,
  PagePublication,
} from './types.ts';
export { isPageGrantUsable } from './types.ts';

// Storage
export {
  // Path utilities
  getWorkspacePagesPath,
  getPagePath,
  getPageConfigPath,
  getPageContentPath,
  getPageDataPath,
  getPageSnapshotPath,
  getPageStorePath,
  getPageThumbnailPath,
  ensurePagesDir,
  ensurePageDataDir,
  // Config operations
  loadPageConfig,
  savePageConfig,
  loadPage,
  loadPageById,
  loadWorkspacePages,
  pageExists,
  // Create/update/delete
  generatePageSlug,
  createPage,
  updatePage,
  type UpdatePagePatch,
  deletePage,
  unbindProjectFromPages,
  deletePageLocal,
  type DeletePageOutcome,
  type PageUnpublishBeforeDelete,
  pagePublicationFromRegistry,
  stripUnownedPageFields,
  // Content
  computePageContentDigest,
  loadPageContent,
  savePageContent,
  // Data
  readPageDataSnapshot,
  recordPageRefresh,
  // Thumbnail (cached poster)
  recordPageThumbnail,
  isThumbnailFresh,
  // Constants
  PAGE_CONFIG_FILENAME,
  PAGE_CONTENT_FILENAME,
  PAGE_SNAPSHOT_FILENAME,
  PAGE_STORE_FILENAME,
  PAGE_THUMBNAIL_FILENAME,
} from './storage.ts';

// Validation
export {
  validatePageConfig,
  PageConfigSchema,
  PageKindSchema,
  PageRefreshSpecSchema,
  PageActionDescriptorSchema,
  PageThumbnailInfoSchema,
  PAGE_SLUG_REGEX,
  PAGE_REFRESH_MIN_INTERVAL_MS,
  isValidPageSlug,
  assertValidPageSlug,
  InvalidPageSlugError,
} from './validation.ts';

// Refresh hook (synthetic cron matchers; UA8.2 — host-written script, inert until its digest is approved)
export {
  buildPageRefreshMatchers,
  loadPageRefreshMatchers,
  pageRefreshMatcherId,
  isPageRefreshMatcherId,
  PAGE_REFRESH_MATCHER_PREFIX,
  PAGE_REFRESH_SCRIPT_FILENAME,
  REFRESH_APPROVAL_KIND,
  PageRefreshInputSchema,
  pageRefreshScriptPath,
  pageRefreshApprovalSubject,
  parsePageRefreshInput,
  setPageRefresh,
  pageRefreshAction,
  readPageRefreshApproval,
  approvePageRefresh,
  type PageRefreshInput,
  type PageRefreshApproval,
  type PageRefreshApprovalState,
} from './refresh.ts';

// Data writes (Node-safe: the SQLite work happens in a spawned Bun one-shot)
export {
  applyPageDataPatch,
  writePageData,
  validatePageDataPatch,
  buildPageDataWriterScript,
  PAGE_DATA_PATCH_MAX_BYTES,
  type PageDataPatch,
  type PageDataWriteResult,
} from './data-write.ts';
export {
  DEFAULT_SNAPSHOT_MAX_POINTS_PER_SERIES,
  PAGE_DATA_MAX_KV_KEYS,
  PAGE_DATA_MAX_SERIES,
} from './data-store-constants.ts';

// Mediated source-action bridge (UA9.2; grants live in the host-approvals ledger, kind `page-grant`)
export {
  PageActionBroker,
  type PageActionBrokerOptions,
  type PageActionExecutors,
  type PageActionValidationErrorCode,
  type CreateLeaseInput,
  type PageActionGrant,
  type PageGrantInput,
  type PageGateRefusalReport,
  DEFAULT_PAGE_LEASE_TTL_MS,
  DEFAULT_PAGE_ACTION_TIMEOUT_MS,
  DEFAULT_PAGE_GRANT_TTL_MS,
  PAGE_GRANT_KIND,
  PAGE_GRANT_SCRIPT_CHANGED,
  pageGrantSubject,
  pageGrantRecord,
  readPageGrant,
  listPageGrants,
  issuePageGrant,
  revokePageGrant,
} from './action-bridge.ts';

// Publishing (UA6.7 — the bundle for t-artifacts; the host's publish path is server-core `pages/page-publishing.ts`)
export {
  buildPageShareBundle,
  buildPublishedPageDocument,
  getShareSnapshotSizeBytes,
  scanSnapshotForSecretCandidates,
  scanPageShareData,
  pageShareErrorCode,
  PageShareError,
  PAGE_SHARE_MAX_DOCUMENT_BYTES,
  PAGE_SHARE_SNAPSHOT_ELEMENT_ID,
  PAGE_SHARE_VIEW_ONLY_ERROR,
  type PageShareErrorCode,
  type PagePublicManifest,
  type PageShareBundle,
  type PageShareGrantView,
  type BuildPageShareBundleOptions,
  type PageShareDataScan,
} from './share-bundle.ts';
