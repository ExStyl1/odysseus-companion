/**
 * UA6.7 — the page bundle for t-artifacts (`share-bundle.ts`, adapted from craft-agents-oss v0.13.4, Apache-2.0):
 * the field allowlist, the script-grant refusal, the view-only acknowledgment, the snapshot parse check, the single
 * 16 MiB cap, the inlined snapshot and the read-only `nessy-pages/v1` shim — the shim itself driven with a stub
 * window, so "reads answer from the snapshot; writes and actions answer view-only" is a behaviour, not a grep.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ARTIFACT_CONTENT_BYTES } from '../artifacts/t-artifacts-client.ts';
import { createPage, ensurePageDataDir, getPageSnapshotPath, loadPageConfig } from './storage.ts';
import {
  buildPageShareBundle,
  buildPublishedPageDocument,
  pageShareErrorCode,
  PAGE_SHARE_MAX_DOCUMENT_BYTES,
  PAGE_SHARE_SNAPSHOT_ELEMENT_ID,
  PAGE_SHARE_VIEW_ONLY_ERROR,
  scanPageShareData,
  type PageShareGrantView,
} from './share-bundle.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ua67-bundle-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const HTML = '<!doctype html><html><head><title>KPIs</title><style>b{}</style></head><body><b id="v"></b><script>render()</script></body></html>';
const SNAPSHOT = { version: 1, generatedAt: 1, kv: { revenue: 42, note: '</script><script>alert(1)</script>' }, series: {} };

function page(kind: 'static' | 'interactive' | 'live' = 'live', content = HTML): string {
  const created = createPage(root, { name: 'KPIs', description: 'Quarterly', kind, content, projectId: 'proj-1' });
  return created.slug;
}

function writeSnapshot(slug: string, text: string): void {
  ensurePageDataDir(root, slug);
  writeFileSync(getPageSnapshotPath(root, slug), text);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return pageShareErrorCode(error);
  }
  return null;
}

const NO_GRANTS: PageShareGrantView[] = [];

describe('the bundle (positive)', () => {
  it('ships the allowlisted facts only, the HTML byte for byte, and the snapshot inlined before the page\'s own scripts', () => {
    const slug = page();
    writeSnapshot(slug, JSON.stringify(SNAPSHOT));
    const bundle = buildPageShareBundle(root, slug, { includeData: true, grants: NO_GRANTS });
    expect(Object.keys(bundle.manifest).sort()).toEqual(['contentDigest', 'description', 'includesData', 'kind', 'slug', 'title']);
    expect(bundle.manifest.includesData).toBe(true);
    expect(bundle.content).toBe(HTML);
    expect(bundle.document).toContain(`id="${PAGE_SHARE_SNAPSHOT_ELEMENT_ID}"`);
    // The inlined data and the shim come right after <head>, ahead of the page's own <style> and <script>.
    const head = bundle.document.indexOf('<head>') + '<head>'.length;
    expect(bundle.document.indexOf(PAGE_SHARE_SNAPSHOT_ELEMENT_ID)).toBeGreaterThan(head);
    expect(bundle.document.indexOf(PAGE_SHARE_SNAPSHOT_ELEMENT_ID)).toBeLessThan(bundle.document.indexOf('<style>'));
    expect(bundle.document.indexOf('nessy-pages/v1')).toBeLessThan(bundle.document.indexOf('render()'));
    expect(bundle.totalBytes).toBe(Buffer.byteLength(bundle.document, 'utf8'));
    // Nothing local-only leaks: the project id is not in the document or the manifest.
    expect(bundle.document).not.toContain('proj-1');
  });

  it('a value carrying </script> cannot close the inlined element', () => {
    const slug = page();
    writeSnapshot(slug, JSON.stringify(SNAPSHOT));
    const { document } = buildPageShareBundle(root, slug, { includeData: true, grants: NO_GRANTS });
    expect(document.match(/<\/script>/g)?.length).toBe(3); // the data element, the shim, the page's own script
    expect(document).toContain('\\u003c/script>\\u003cscript>alert(1)');
  });

  it('without includeData no snapshot is inlined, and a static page ships unchanged (it runs no script)', () => {
    const slug = page();
    writeSnapshot(slug, JSON.stringify(SNAPSHOT));
    const plain = buildPageShareBundle(root, slug, { includeData: false, grants: NO_GRANTS });
    expect(plain.document).not.toContain(`id="${PAGE_SHARE_SNAPSHOT_ELEMENT_ID}"`);
    expect(plain.document).toContain('nessy-pages/v1');
    expect(plain.manifest.includesData).toBe(false);

    const staticSlug = createPage(root, { name: 'Static', kind: 'static', content: '<p>hi</p>' }).slug;
    writeSnapshot(staticSlug, JSON.stringify(SNAPSHOT));
    const fixed = buildPageShareBundle(root, staticSlug, { includeData: true, grants: NO_GRANTS });
    expect(fixed.document).toBe('<p>hi</p>');
    expect(fixed.manifest.includesData).toBe(false);
  });

  it('a fragment gets the shim in front; a body-only document before <body>', () => {
    expect(buildPublishedPageDocument({ content: '<div>x</div>', page: { slug: 's', kind: 'live' } }).startsWith('<script>')).toBe(true);
    const bodyOnly = buildPublishedPageDocument({ content: '<body><p>x</p></body>', page: { slug: 's', kind: 'live' } });
    expect(bodyOnly.indexOf('nessy-pages/v1')).toBeLessThan(bodyOnly.indexOf('<body>'));
  });

  it('the one cap is the service\'s 16 MiB file limit', () => {
    expect(PAGE_SHARE_MAX_DOCUMENT_BYTES).toBe(MAX_ARTIFACT_CONTENT_BYTES);
  });
});

describe('refusals (negative)', () => {
  it('a page with a script grant is refused — even a stale one — and an unreadable ledger refuses too', () => {
    const slug = page();
    const script: PageShareGrantView = { action: { kind: 'script' }, contentDigest: 'stale', expiresAt: 0 };
    expect(codeOf(() => buildPageShareBundle(root, slug, { includeData: false, grants: [script] }))).toBe('PAGE_SHARE_SCRIPT_GRANT');
    expect(codeOf(() => buildPageShareBundle(root, slug, { includeData: false, grants: [script], viewOnlyAcknowledged: true }))).toBe('PAGE_SHARE_SCRIPT_GRANT');
    expect(codeOf(() => buildPageShareBundle(root, slug, { includeData: false, grants: null }))).toBe('PAGE_SHARE_GRANTS_UNREADABLE');
  });

  it('usable source grants need the view-only acknowledgment; stale ones do not', () => {
    const slug = page();
    const digest = loadPageConfig(root, slug)!.contentDigest!;
    const usable: PageShareGrantView = { action: { kind: 'api' }, contentDigest: digest, expiresAt: Date.now() + 60_000 };
    const stale: PageShareGrantView = { action: { kind: 'mcp' }, contentDigest: 'other', expiresAt: Date.now() + 60_000 };
    expect(codeOf(() => buildPageShareBundle(root, slug, { includeData: false, grants: [usable] }))).toBe('PAGE_SHARE_ACTIONS_ACK_REQUIRED');
    expect(codeOf(() => buildPageShareBundle(root, slug, { includeData: false, grants: [usable], viewOnlyAcknowledged: true }))).toBeNull();
    expect(codeOf(() => buildPageShareBundle(root, slug, { includeData: false, grants: [stale] }))).toBeNull();
  });

  it('a damaged snapshot, a missing page, a page with no content and an oversized document are refused', () => {
    const slug = page();
    writeSnapshot(slug, '{not json');
    expect(codeOf(() => buildPageShareBundle(root, slug, { includeData: true, grants: NO_GRANTS }))).toBe('PAGE_SHARE_SNAPSHOT_INVALID');
    expect(codeOf(() => buildPageShareBundle(root, 'missing', { includeData: false, grants: NO_GRANTS }))).toBe('PAGE_NOT_FOUND');
    const empty = createPage(root, { name: 'Empty', kind: 'live' }).slug;
    expect(codeOf(() => buildPageShareBundle(root, empty, { includeData: false, grants: NO_GRANTS }))).toBe('PAGE_NO_CONTENT');
    const big = page('live', `<p>${'x'.repeat(PAGE_SHARE_MAX_DOCUMENT_BYTES)}</p>`);
    expect(codeOf(() => buildPageShareBundle(root, big, { includeData: false, grants: NO_GRANTS }))).toBe('PAGE_SHARE_TOO_LARGE');
  });

  it('the data scan reports secret-looking key names by name only', () => {
    const slug = page();
    writeSnapshot(slug, JSON.stringify({ kv: { apiToken: 'x', count: 1 }, series: { password: [] } }));
    const scan = scanPageShareData(root, slug);
    expect(scan.secretCandidates.sort()).toEqual(['kv.apiToken', 'series.password']);
    expect(scan.snapshotBytes).toBeGreaterThan(0);
  });
});

/** Run the shim with a stub window; returns what it posted and a way to deliver messages. */
function runShim(document: string, snapshotText?: string) {
  const shim = /<script>\n([\s\S]*?)\n<\/script>/.exec(document)![1]!;
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const posted: Array<Record<string, unknown>> = [];
  const opened: string[] = [];
  const win: Record<string, unknown> = {
    parent: { postMessage: () => { throw new Error('the real parent must not be used') } },
    addEventListener: (type: string, fn: (event: unknown) => void) => { (listeners[type] ??= []).push(fn) },
    postMessage: (message: Record<string, unknown>) => { posted.push(message) },
    open: (url: string) => { opened.push(url) },
  };
  const doc = {
    readyState: 'complete',
    getElementById: (id: string) => (id === PAGE_SHARE_SNAPSHOT_ELEMENT_ID && snapshotText !== undefined ? { textContent: snapshotText } : null),
  };
  new Function('window', 'document', shim)(win, doc);
  const deliver = (data: unknown, source: unknown = win) => {
    for (const fn of listeners.message ?? []) fn({ data, source });
  };
  return { win, posted, opened, deliver };
}

describe('the read-only bridge shim', () => {
  it('answers init from the inlined snapshot on load and on ready, with no grants', () => {
    const slug = page();
    writeSnapshot(slug, JSON.stringify(SNAPSHOT));
    const { document } = buildPageShareBundle(root, slug, { includeData: true, grants: NO_GRANTS });
    const inlined = new RegExp(`id="${PAGE_SHARE_SNAPSHOT_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(document)![1]!;
    const { win, posted, deliver } = runShim(document, inlined);
    expect(win.parent).toBe(win);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ protocol: 'nessy-pages/v1', type: 'init' });
    const payload = posted[0]!.payload as { snapshot: unknown; grants: unknown[]; page: unknown };
    expect(payload.snapshot).toEqual(SNAPSHOT);
    expect(payload.grants).toEqual([]);
    expect(payload.page).toEqual({ slug, kind: 'live' });
    deliver({ protocol: 'nessy-pages/v1', type: 'ready' });
    expect(posted).toHaveLength(2);
    expect(posted[1]!.type).toBe('init');
  });

  it('every action answers view-only and a grant request gets no grants; foreign messages are ignored', () => {
    const { document } = buildPageShareBundle(root, page(), { includeData: false, grants: NO_GRANTS });
    const { posted, opened, deliver } = runShim(document);
    posted.length = 0;
    deliver({ protocol: 'nessy-pages/v1', type: 'action', requestId: 'r1', nonce: 'view-only', grantId: 'g', invocation: { kind: 'api' } });
    expect(posted).toEqual([{ protocol: 'nessy-pages/v1', type: 'action-result', payload: { result: { requestId: 'r1', ok: false, error: PAGE_SHARE_VIEW_ONLY_ERROR, durationMs: 0 } } }]);
    deliver({ protocol: 'nessy-pages/v1', type: 'grant-request', nonce: 'n', requests: [] });
    expect(posted[1]).toEqual({ protocol: 'nessy-pages/v1', type: 'grants', payload: { grants: [] } });
    // Another window's message, another protocol, and a non-http link do nothing.
    deliver({ protocol: 'nessy-pages/v1', type: 'ready' }, { other: true });
    deliver({ protocol: 'craft-pages/v1', type: 'ready' });
    deliver({ protocol: 'nessy-pages/v1', type: 'open-url', nonce: 'n', url: 'javascript:alert(1)' });
    expect(posted).toHaveLength(2);
    expect(opened).toEqual([]);
    deliver({ protocol: 'nessy-pages/v1', type: 'open-url', nonce: 'n', url: 'https://example.com/x' });
    expect(opened).toEqual(['https://example.com/x']);
  });
});
