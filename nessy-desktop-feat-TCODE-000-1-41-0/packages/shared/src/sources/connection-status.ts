/**
 * UB14.48 — the stored connection verdict of a Source, in the app's vocabulary, for the capability catalog.
 *
 * Source: craft-agents-oss `v0.15.1:apps/electron/src/renderer/components/ui/source-connection-status.ts`
 * (Apache-2.0; LICENSE and NOTICE kept): `KNOWN_STATUSES` and `normalizeStoredStatus` are taken with their
 * behaviour unchanged (first shipped in v0.15.0, "A failed source test shows in the list"). Moved from the
 * renderer into `packages/shared` because no renderer surface here holds a source CONFIG: the Sources list,
 * the management rows and the detail page all render `SafeCapabilitySummary` (P6.745), so the HOST reads the
 * stored verdict while it builds the native inventory (`capabilities/native-sources.ts`) and the renderer
 * receives it as `SafeCapabilitySummary.lastTestStatus`. Upstream's `deriveConnectionStatus` is NOT taken:
 * ours was deleted on purpose (P6.768) and `capabilitySummaryConnectionStatus`
 * (`apps/electron/src/renderer/components/ui/source-status-indicator.tsx`) is its replacement over the safe row.
 *
 * `sanitizeStoredConnectionError` is ours (UB14.48). Upstream renders `config.connectionError` raw; the
 * capability summary is path-, URL- and secret-free by construction (`toSafeSummary`), so the stored text is
 * reduced before it joins it — see the function.
 */

import type { SourceConnectionStatus } from './types.ts';
import { scanToolResultForSecrets } from '../agent/tool-result-secret-scan.ts';

const KNOWN_STATUSES: ReadonlySet<string> = new Set<SourceConnectionStatus>([
  'connected', 'needs_auth', 'failed', 'untested', 'local_disabled',
]);

/**
 * `source_test` (session-tools-core) persists its own vocabulary — 'connected' | 'disconnected' |
 * 'error' | 'unknown' — into the same `connectionStatus` field. Without mapping, a source whose
 * test failed looked healthy in the sources list (no status entry for 'error') while its detail
 * page showed it broken. Map those values onto the app's states so every surface agrees.
 *
 * Readers: the capability summary (`capabilities/native-sources.ts`, UB14.48) and the model's
 * per-turn `<source_issue>` block (`agent/core/source-manager.ts` `storedConnectionStatus`, UB12.56).
 */
export function normalizeStoredStatus(stored: string): SourceConnectionStatus {
  if (KNOWN_STATUSES.has(stored)) return stored as SourceConnectionStatus;
  if (stored === 'error' || stored === 'disconnected') return 'failed';
  return 'untested';
}

/** Longest stored error text the summary carries; the rest is cut with an ellipsis. */
export const STORED_CONNECTION_ERROR_MAX = 1000;

/** C0 controls except tab, newline and carriage return (the text renders in a `<pre>`). */
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** A URL with an explicit scheme, up to the first whitespace, quote or angle bracket. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/** Sentence punctuation a URL match swallows at its end, given back after the rewrite. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * An absolute POSIX path under one of the filesystem roots a local error message names (a spawned
 * command, a config file, a home directory). Narrow on purpose: an HTTP route such as `/api/v1/tools`
 * in an error text is kept as the server wrote it.
 */
const ABSOLUTE_POSIX_PATH =
  /(?<![\w.~:/\\-])\/(?:Users|home|root|private|var|tmp|opt|usr|etc|Volumes|mnt|srv|Applications|Library|System|nix|snap|run)\/(?:[^\s/"'`<>|]+\/)*([^\s/"'`<>|]+)/g;

/** An absolute Windows drive path. */
const ABSOLUTE_WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s\\"'`<>|]+\\)*([^\s\\"'`<>|]+)/g;

function reduceUrl(match: string): string {
  const trailing = URL_TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
  const body = trailing ? match.slice(0, -trailing.length) : match;
  try {
    const url = new URL(body);
    if (url.protocol === 'file:') {
      const base = url.pathname.split('/').filter(Boolean).pop();
      return `file://…${base ? `/${base}` : ''}${trailing}`;
    }
    // Scheme and host only (`host` already drops `user:pass@`). A path can carry a secret
    // (a webhook or a per-user MCP endpoint), and the query is a credential channel.
    const elided = (url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '';
    return `${url.protocol}//${url.host}${elided ? '/…' : ''}${trailing}`;
  } catch {
    return `[url]${trailing}`;
  }
}

/**
 * The stored `connectionError` of a Source, made fit for `SafeCapabilitySummary.connectionError`.
 *
 * Its writers are `source_test`'s save (the probe's own message, credential values already masked
 * there), `markSourceNeedsReauth` (an OAuth token endpoint's body) and the token-refresh manager —
 * free text a server can shape. The summary crosses to every client (the renderer, the WebUI, the iOS
 * app) and its contract is no path, no secret, no server URL (`toSafeSummary`; `mcpServerIdentity` is
 * withheld for the same reason), so, in order:
 *
 * 1. a non-string or blank value is absent; C0 control characters (tab and line breaks kept) are dropped;
 * 2. every `scheme://…` URL is reduced to its scheme and host — the path, query (F1.311: a credential
 *    channel), fragment and userinfo are elided as `/…`; a `file://` URL keeps its last segment only;
 * 3. an absolute filesystem path under a known root (`/Users/…`, `/home/…`, `/opt/…`, `C:\…`) keeps its
 *    last segment only (`…/npx`);
 * 4. the tool-result secret table (`scanToolResultForSecrets`: provider key prefixes, JWTs, `Bearer …`)
 *    replaces every match with its rule's marker;
 * 5. the result is capped at {@link STORED_CONNECTION_ERROR_MAX} characters.
 *
 * Stated residue: a secret with no published prefix, written outside a URL, passes step 4 as text, and a
 * relative path or one under an unlisted root passes step 3.
 */
export function sanitizeStoredConnectionError(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.replace(CONTROL_CHARACTERS, '').trim();
  if (text === '') return undefined;
  text = text.replace(URL_PATTERN, reduceUrl);
  text = text.replace(ABSOLUTE_POSIX_PATH, (_match, base: string) => `…/${base}`);
  text = text.replace(ABSOLUTE_WINDOWS_PATH, (_match, base: string) => `…\\${base}`);
  text = scanToolResultForSecrets(text).text;
  return text.length <= STORED_CONNECTION_ERROR_MAX
    ? text
    : `${text.slice(0, STORED_CONNECTION_ERROR_MAX - 1)}…`;
}
