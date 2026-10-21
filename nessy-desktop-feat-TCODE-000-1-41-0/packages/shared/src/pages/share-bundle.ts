/**
 * Page Share Bundle — UA6.7 (Pages publishing through t-artifacts).
 *
 * Copied from craft-agents-oss `v0.13.4:packages/shared/src/pages/share-bundle.ts` (Apache-2.0) and adapted to
 * the internal artifact service (OQ-18, resolved 2026-09-23: «по артефактам да, использовать то что выше дал»).
 * Kept from upstream: the bundle is built FIELD BY FIELD from an allowlist (never by spreading `PageConfig`, so
 * local-only state — refresh scripts, store.sqlite, project ids, lastRefresh errors — cannot leak into the public
 * copy by accident); a page with a SCRIPT grant is refused outright, even a stale one ("a host-exec capability must
 * never be associated with a public URL"); a page with usable source-action grants needs the explicit view-only
 * acknowledgment; the snapshot must parse; the snapshot's secret-looking KEY NAMES are reported for the dialog
 * (`scanSnapshotForSecretCandidates`, a warning, never a block); `index.html` itself ships byte-for-byte, NOT
 * sanitised.
 *
 * What differs (ours), each for its reason:
 * - **One self-contained file** (the service stores one page, no Worker shell exists to serve a manifest, HTML and
 *   snapshot side by side — reason (a)): the snapshot is inlined as a JSON `<script type="application/json">` and a
 *   small read-only shim answers the `nessy-pages/v1` bridge from it ({@link buildPublishedPageDocument}): `init`
 *   on load and on `ready`, `grants` always empty, every `action` answered "view-only", `open-url` an ordinary
 *   new-tab link. Writes and actions therefore never reach anything — upstream's public shell made the same promise.
 *   A `static` page gets neither (its frame runs no script in the app either).
 * - **Caps re-derived** against the single 16 MiB file the service accepts (`artifacts/t-artifacts-client.ts`
 *   `MAX_ARTIFACT_CONTENT_BYTES`): upstream's three caps (5 MiB HTML, 2 MiB snapshot, 10 MiB bundle) were the
 *   Worker's; ours is the one the service enforces, checked on the built document.
 * - **Grants come from the host-approvals ledger** (UA9.2, reason (b)), passed in by the host; a ledger that cannot be
 *   read refuses the publish (`PAGE_SHARE_GRANTS_UNREADABLE`) — the script-grant refusal must not pass by default.
 * - **The scan runs over BOTH the HTML and the snapshot**: the bundle keeps `content` and `snapshotJson` apart from
 *   the built `document`, so the host's guard (`server-core/src/pages/page-publishing.ts` `guardPageShareBundle`,
 *   plan UA6.7 "the UA1.17 guard runs over both") can scan each part and name it in a refusal.
 * - Dropped: upstream's `PAGE_SHARING_DISABLED`, `PAGE_SHARE_TOKEN_MISSING`, `PAGE_SHARE_VAULT_ERROR` and the
 *   `PagePublicManifest.version` wire field — the Craft service, its feature flag and its admin-token vault, reason
 *   (a) (nothing is gated, spec §6).
 */

import { existsSync, readFileSync } from 'fs';
import type { PageKind } from '@nessy-agent/core';
import { isPageGrantUsable } from './types.ts';
import { isSensitiveKeyName } from '../utils/redaction.ts';
import {
  computePageContentDigest,
  getPageSnapshotPath,
  loadPageConfig,
  loadPageContent,
} from './storage.ts';

/**
 * The one cap: the service's single-file limit (`artifacts/t-artifacts-client.ts` `MAX_ARTIFACT_CONTENT_BYTES`), on
 * the built document (bytes, UTF-8). Written as a number, not imported, so the pages barrel does not pull the dp
 * client's module graph; `share-bundle.test.ts` pins the two equal.
 */
export const PAGE_SHARE_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** The DOM id of the inlined snapshot element the shim reads. */
export const PAGE_SHARE_SNAPSHOT_ELEMENT_ID = 'nessy-page-snapshot';

/** The sentence a published copy answers to every `action` (and the error code prefix a page can test for). */
export const PAGE_SHARE_VIEW_ONLY_ERROR = 'view-only: this is a published copy of the page; actions only run in the Nessy app.';

export type PageShareErrorCode =
  | 'PAGE_NOT_FOUND'
  | 'PAGE_NO_CONTENT'
  | 'PAGE_SHARE_TOO_LARGE'
  | 'PAGE_SHARE_SNAPSHOT_INVALID'
  | 'PAGE_SHARE_ACTIONS_ACK_REQUIRED'
  | 'PAGE_SHARE_SCRIPT_GRANT'
  | 'PAGE_SHARE_GRANTS_UNREADABLE'
  | 'PAGE_SHARE_ALREADY_PUBLISHED'
  | 'PAGE_SHARE_NOT_PUBLISHED'
  | 'PAGE_SHARE_REMOTE_ERROR';

/** Typed error for the publish pipeline (the code survives transport as a message prefix, as upstream). */
export class PageShareError extends Error {
  constructor(
    public readonly code: PageShareErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PageShareError';
  }
}

/** The allowlisted page facts a publication carries (upstream's `PagePublicManifest`, minus its wire `version`). */
export interface PagePublicManifest {
  slug: string;
  title: string;
  description?: string;
  kind: PageKind;
  /** sha256 hex of the published index.html (the `PageConfig.contentDigest` family). */
  contentDigest: string;
  includesData: boolean;
}

/** The grant facts the bundle reads (the ledger's `PageActionGrant`, structurally). */
export interface PageShareGrantView {
  action: { kind: string };
  contentDigest: string;
  expiresAt: number;
}

export interface PageShareBundle {
  manifest: PagePublicManifest;
  /** The exact index.html string being published. */
  content: string;
  /** The serialised snapshot inlined in the document (present only when opted in, available and the page runs scripts). */
  snapshotJson?: string;
  /** sha256 hex of `content`. */
  contentDigest: string;
  /** THE bytes to publish: the page with the inlined snapshot and the read-only bridge. */
  document: string;
  /** UTF-8 size of `document`. */
  totalBytes: number;
}

export interface BuildPageShareBundleOptions {
  /** Inline the current data/snapshot.json (default: false). */
  includeData: boolean;
  /** Required when the page has usable source-action grants: the person confirmed the copy is view-only. */
  viewOnlyAcknowledged?: boolean;
  /** The page's grants from the host-approvals ledger; `null` = the ledger could not be read (refused). */
  grants: readonly PageShareGrantView[] | null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

/** Human-readable size for user-facing limit errors ("2.3 MB"), as upstream. */
function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** JSON for an inline `<script>`: `<` escaped, so no `</script>` or `<!--` can close or confuse the element. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * The read-only `nessy-pages/v1` shim (page side of the bridge, see `apps/electron/src/shared/page-bridge.ts`). It
 * runs first, so the page's own scripts find it: `window.parent` is replaced by the window itself ([Replaceable]),
 * so the page's `window.parent.postMessage(…)` reaches this listener whether or not the copy is framed.
 */
function bridgeShim(page: { slug: string; kind: PageKind }): string {
  return [
    '(function () {',
    '  "use strict";',
    '  var P = "nessy-pages/v1";',
    `  var page = ${inlineJson(page)};`,
    '  var snapshot = null;',
    `  try { var el = document.getElementById(${inlineJson(PAGE_SHARE_SNAPSHOT_ELEMENT_ID)}); if (el) snapshot = JSON.parse(el.textContent || "null"); } catch (e) { snapshot = null; }`,
    '  try { window.parent = window; } catch (e) { /* framed and not replaceable: messages to the frame are lost */ }',
    '  function post(type, payload) { window.postMessage({ protocol: P, type: type, payload: payload }, "*"); }',
    '  function init() { post("init", { page: page, nonce: "view-only", snapshot: snapshot, grants: [] }); }',
    '  window.addEventListener("message", function (event) {',
    '    var m = event.data;',
    '    if (event.source !== window || !m || typeof m !== "object" || m.protocol !== P) return;',
    '    if (m.type === "ready") init();',
    `    else if (m.type === "action") post("action-result", { result: { requestId: String(m.requestId || ""), ok: false, error: ${inlineJson(PAGE_SHARE_VIEW_ONLY_ERROR)}, durationMs: 0 } });`,
    '    else if (m.type === "grant-request") post("grants", { grants: [] });',
    '    else if (m.type === "open-url" && typeof m.url === "string" && /^https?:\\/\\//i.test(m.url)) window.open(m.url, "_blank", "noopener,noreferrer");',
    '  });',
    '  if (document.readyState === "complete") init(); else window.addEventListener("load", init);',
    '})();',
  ].join('\n');
}

const HEAD_OPEN = /<head\b[^>]*>/i;
const BODY_OPEN = /<body\b[^>]*>/i;

/**
 * The published document: the page's HTML with, at its very start (right after `<head …>`, else before `<body …>`,
 * else in front of the fragment), the inlined snapshot and the read-only shim. The normaliser (UA1.16) lifts head
 * scripts in document order, so the shim stays first on the service. A `static` page is returned unchanged.
 */
export function buildPublishedPageDocument(input: {
  content: string;
  page: { slug: string; kind: PageKind };
  snapshot?: unknown;
}): string {
  if (input.page.kind === 'static') return input.content;
  const parts: string[] = [];
  if (input.snapshot !== undefined) {
    parts.push(`<script type="application/json" id="${PAGE_SHARE_SNAPSHOT_ELEMENT_ID}">${inlineJson(input.snapshot)}</script>`);
  }
  parts.push(`<script>\n${bridgeShim(input.page)}\n</script>`);
  const snippet = parts.join('\n');
  const head = HEAD_OPEN.exec(input.content);
  if (head) {
    const at = head.index + head[0].length;
    return `${input.content.slice(0, at)}\n${snippet}${input.content.slice(at)}`;
  }
  const body = BODY_OPEN.exec(input.content);
  if (body) return `${input.content.slice(0, body.index)}${snippet}\n${input.content.slice(body.index)}`;
  return `${snippet}\n${input.content}`;
}

/**
 * Build the public bundle for a page, enforcing the exclusion and size invariants. Throws {@link PageShareError}
 * on any violation.
 */
export function buildPageShareBundle(
  workspaceRootPath: string,
  pageSlug: string,
  options: BuildPageShareBundleOptions,
): PageShareBundle {
  const config = loadPageConfig(workspaceRootPath, pageSlug);
  if (!config) {
    throw new PageShareError('PAGE_NOT_FOUND', `Page not found: ${pageSlug}`);
  }

  const content = loadPageContent(workspaceRootPath, pageSlug);
  if (content === null) {
    throw new PageShareError('PAGE_NO_CONTENT', `Page has no content to publish: ${pageSlug}`);
  }

  if (options.grants === null) {
    throw new PageShareError(
      'PAGE_SHARE_GRANTS_UNREADABLE',
      "This page's approvals could not be read, so it cannot be checked for a script approval and was not published.",
    );
  }

  // Host command execution must never reach a public URL — refuse outright,
  // ahead of the softer view-only acknowledgment path below.
  if (options.grants.some((grant) => grant.action.kind === 'script')) {
    throw new PageShareError(
      'PAGE_SHARE_SCRIPT_GRANT',
      'This page has permission to run a script on this computer, so it cannot be published — not even as a view-only copy.',
    );
  }

  // The ack explains a behavior difference: action buttons work locally but
  // not on the public copy. Stale/expired grants don't work locally either,
  // so only usable grants require it. (Script grants were refused above —
  // that check deliberately counts stale ones too.)
  const now = Date.now();
  const hasUsableGrants = options.grants.some((grant) => isPageGrantUsable(grant, config.contentDigest, now));
  if (hasUsableGrants && options.viewOnlyAcknowledged !== true) {
    throw new PageShareError(
      'PAGE_SHARE_ACTIONS_ACK_REQUIRED',
      'This page has approved actions. Publishing needs confirmation that the public copy is view-only.',
    );
  }

  let snapshotJson: string | undefined;
  let snapshot: unknown;
  if (options.includeData && config.kind !== 'static') {
    const snapshotPath = getPageSnapshotPath(workspaceRootPath, pageSlug);
    if (existsSync(snapshotPath)) {
      const raw = readFileSync(snapshotPath, 'utf-8');
      try {
        snapshot = JSON.parse(raw);
      } catch {
        throw new PageShareError(
          'PAGE_SHARE_SNAPSHOT_INVALID',
          "The page's data snapshot is damaged. Refresh the page's data, then publish again.",
        );
      }
      snapshotJson = raw;
    }
  }

  const contentDigest = computePageContentDigest(content);
  const manifest: PagePublicManifest = {
    slug: config.slug,
    title: config.name,
    ...(config.description ? { description: config.description } : {}),
    kind: config.kind,
    contentDigest,
    includesData: snapshotJson !== undefined,
  };

  const document = buildPublishedPageDocument({
    content,
    page: { slug: config.slug, kind: config.kind },
    ...(snapshotJson !== undefined ? { snapshot } : {}),
  });
  const totalBytes = byteLength(document);
  if (totalBytes > PAGE_SHARE_MAX_DOCUMENT_BYTES) {
    throw new PageShareError(
      'PAGE_SHARE_TOO_LARGE',
      snapshotJson !== undefined
        ? `The page and its data together are too large to publish (${formatMb(totalBytes)}, limit ${formatMb(PAGE_SHARE_MAX_DOCUMENT_BYTES)}). Publish it without the data, or make it smaller.`
        : `The page is too large to publish (${formatMb(totalBytes)}, limit ${formatMb(PAGE_SHARE_MAX_DOCUMENT_BYTES)}).`,
    );
  }

  return { manifest, content, ...(snapshotJson !== undefined ? { snapshotJson } : {}), contentDigest, document, totalBytes };
}

/** Estimate the publishable snapshot size for UI display (null = no snapshot on disk) */
export function getShareSnapshotSizeBytes(workspaceRootPath: string, pageSlug: string): number | null {
  const snapshotPath = getPageSnapshotPath(workspaceRootPath, pageSlug);
  if (!existsSync(snapshotPath)) return null;
  try {
    return byteLength(readFileSync(snapshotPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Cap on reported secret-candidate paths (the UI shows a few + a count) */
const MAX_SECRET_CANDIDATES = 20;
const SECRET_SCAN_MAX_DEPTH = 8;

/**
 * Best-effort scan of a snapshot for values that LOOK like secrets, by key
 * name only (same deliberately-broad heuristic as redaction.ts — one source
 * of truth, over-flagging is fine for a warning). Walks `kv` keys and nested
 * object keys plus series names. Returns unique dot-paths, capped. Never
 * throws — a malformed snapshot simply reports no candidates (the publish
 * path itself rejects malformed snapshots separately).
 */
export function scanSnapshotForSecretCandidates(snapshotJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];

  const found = new Set<string>();
  const seen = new WeakSet<object>();

  const visit = (node: unknown, path: string, depth: number): void => {
    if (found.size >= MAX_SECRET_CANDIDATES) return;
    if (!node || typeof node !== 'object' || depth >= SECRET_SCAN_MAX_DEPTH) return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      // Array items keep the parent path — indices are noise in a warning.
      for (const item of node) visit(item, path, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (isSensitiveKeyName(key)) {
        found.add(keyPath);
        if (found.size >= MAX_SECRET_CANDIDATES) return;
      }
      visit(value, keyPath, depth + 1);
    }
  };

  const root = parsed as { kv?: unknown; series?: unknown };
  if (root.kv && typeof root.kv === 'object') visit(root.kv, 'kv', 1);
  if (root.series && typeof root.series === 'object' && !Array.isArray(root.series)) {
    for (const name of Object.keys(root.series)) {
      if (found.size >= MAX_SECRET_CANDIDATES) break;
      if (isSensitiveKeyName(name)) found.add(`series.${name}`);
    }
  }
  return [...found];
}

export interface PageShareDataScan {
  /** Byte size of the snapshot that would publish, or null when none exists */
  snapshotBytes: number | null;
  /** Key paths in the snapshot that look credential-bearing (capped) */
  secretCandidates: string[];
}

/**
 * One-read convenience for the Share dialog: what would `includeData` publish,
 * and does any of it look like a secret?
 */
export function scanPageShareData(workspaceRootPath: string, pageSlug: string): PageShareDataScan {
  const snapshotPath = getPageSnapshotPath(workspaceRootPath, pageSlug);
  if (!existsSync(snapshotPath)) return { snapshotBytes: null, secretCandidates: [] };
  let raw: string;
  try {
    raw = readFileSync(snapshotPath, 'utf-8');
  } catch {
    return { snapshotBytes: null, secretCandidates: [] };
  }
  return { snapshotBytes: byteLength(raw), secretCandidates: scanSnapshotForSecretCandidates(raw) };
}

/** Extract a PageShareErrorCode from any thrown value (transport-safe) */
export function pageShareErrorCode(err: unknown): PageShareErrorCode | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const match = message.match(/^(PAGE_[A-Z_]+):/);
  return match ? (match[1] as PageShareErrorCode) : null;
}
