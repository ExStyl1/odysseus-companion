/**
 * Read ONE plugin's own manifest at its PINNED ref, on demand (D3).
 *
 * The browse list must stay cheap: `anthropics/claude-plugins-official` points
 * at 276 different repositories and the community catalogue at 2 307, so a
 * per-row fetch would put a network round trip behind every row. A DETAIL page
 * is one plugin, and its address is exact — the catalogue entry already
 * resolved to a `repository` source carrying the entry's `sha`
 * (`external-catalog-adapters.ts` `claudeRepositorySource`: "Claude gives an
 * exact SHA precedence over a branch/tag ref"), and the manifest sits at a
 * fixed path inside it:
 *
 * `plugins-reference.md` § File locations reference — Manifest,
 * `.claude-plugin/plugin.json`. (https://code.claude.com/docs/en/plugins-reference.md)
 * `plugins/build/plugins.md` § Plugin structure — "Every plugin has a manifest
 * at `.codex-plugin/plugin.json`."
 * (https://developers.openai.com/plugins/build/plugins.md)
 *
 * So this is a single GET of a single JSON file, never a clone, never a
 * directory listing, and never speculative — the caller fires it when a detail
 * page opens and for nothing else.
 *
 * WHAT IT CANNOT TELL YOU. A manifest that declares no component field is the
 * NORM, not an empty plugin: `plugins-reference.md` § Plugin manifest schema —
 * "The manifest is optional. If omitted, Claude Code auto-discovers components
 * in default locations". Measured 2026-08-01 over 59 official Claude plugin
 * manifests fetched at their pinned shas: 25 declare at least one component
 * field, 34 declare none and rely on the default directories. A `null` result
 * and an empty result therefore mean the same thing to the caller — "the
 * listing does not say" — and neither may ever render as "ships nothing".
 *
 * SAFETY. Only a `github.com` repository source with a ref is addressable; the
 * URL is built here, the response host is re-checked after redirects, the body
 * is capped, and the request is abortable. Anything else returns `undefined`,
 * which is the honest answer, not a failure.
 */
import {
  declaredPluginComponentKinds,
  type PluginDeclaredComponentKind,
} from './declared-components.ts';
import type { PluginInstallSource } from './types.ts';

/** Host that serves a repository blob by path at a pinned ref. */
const RAW_GITHUB_HOST = 'raw.githubusercontent.com';

/**
 * Manifest sub-paths probed, in order. Claude first: a Codex registry's rows
 * are enriched from the staged scan at list time, so a probe that reaches here
 * is overwhelmingly a Claude row pointing at its own repository.
 */
const MANIFEST_SUBPATHS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'] as const;

/** A manifest that needs more than this is not a manifest. */
const MAX_MANIFEST_BYTES = 256 * 1024;

const DEFAULT_TIMEOUT_MS = 8_000;

export interface ProbePluginManifestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Caller-owned cancellation (detail page closed / navigated away). */
  signal?: AbortSignal;
}

/**
 * The component kinds the plugin's own manifest declares, or `undefined` when
 * no manifest is addressable or readable. An empty array means "a manifest was
 * read and it declares nothing", which is NOT "the plugin has nothing".
 */
export async function probePluginManifestComponentKinds(
  source: PluginInstallSource | undefined,
  options: ProbePluginManifestOptions = {},
): Promise<PluginDeclaredComponentKind[] | undefined> {
  const urls = pluginManifestUrls(source);
  if (!urls.length) return undefined;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return undefined;

  for (const url of urls) {
    const manifest = await readManifest(url, fetchImpl, options);
    if (manifest) return declaredPluginComponentKinds(manifest);
    if (options.signal?.aborted) return undefined;
  }
  return undefined;
}

/**
 * The manifest URLs for a source, at ITS ref. A source without a ref yields
 * nothing rather than defaulting to a branch: a moving ref would show a
 * composition that is not the one the pinned install would produce.
 */
export function pluginManifestUrls(source: PluginInstallSource | undefined): string[] {
  if (!source || source.kind !== 'repository') return [];
  const ref = source.ref?.trim();
  if (!ref || /[\s/]/.test(ref)) return [];
  const repo = githubRepoPath(source.repositoryUrl);
  if (!repo) return [];
  const subdirectory = normalizeSubdirectory(source.subdirectory);
  const base = `https://${RAW_GITHUB_HOST}/${repo}/${encodeURIComponent(ref)}${subdirectory}`;
  return MANIFEST_SUBPATHS.map(subpath => `${base}/${subpath}`);
}

/** `<owner>/<repo>` for a github.com HTTPS URL, or `undefined` for anything else. */
function githubRepoPath(repositoryUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return undefined;
  const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (segments.length !== 2) return undefined;
  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, '');
  if (!owner || !repo || !isSafeSegment(owner) || !isSafeSegment(repo)) return undefined;
  return `${owner}/${repo}`;
}

/** A contained `/a/b` suffix, or `''`. Refuses traversal outright. */
function normalizeSubdirectory(subdirectory: string | undefined): string {
  const segments = (subdirectory ?? '')
    .split(/[\\/]+/)
    .map(segment => segment.trim())
    .filter(segment => segment && segment !== '.');
  if (!segments.length) return '';
  if (segments.some(segment => segment === '..' || !isSafeSegment(segment))) return '';
  return `/${segments.map(segment => encodeURIComponent(segment)).join('/')}`;
}

function isSafeSegment(segment: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..';
}

async function readManifest(
  url: string,
  fetchImpl: typeof fetch,
  options: ProbePluginManifestOptions,
): Promise<Record<string, unknown> | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return undefined;
    // A redirect must not have walked us off the blob host.
    if (response.url && !isRawGithubUrl(response.url)) return undefined;
    const declaredLength = Number(response.headers?.get?.('content-length') ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) return undefined;
    const body = await response.text();
    if (body.length > MAX_MANIFEST_BYTES) return undefined;
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    // Offline, blocked, aborted, 404, malformed JSON — all one answer: unknown.
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

function isRawGithubUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === RAW_GITHUB_HOST;
  } catch {
    return false;
  }
}
