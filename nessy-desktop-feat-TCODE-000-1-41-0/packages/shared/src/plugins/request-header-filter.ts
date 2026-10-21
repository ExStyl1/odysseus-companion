/**
 * The header-name filter every marketplace-declared credential passes through,
 * in one place because it is declared in two.
 *
 * `plugins/host-marketplace.md#when-claude-code-skips-a-headershelper-command-or-drops-its-output`
 * — "**Entry sets a routing or identity header**: Claude Code drops
 * request-routing and client-identity names such as `Host`, `Cookie`, and
 * `X-Forwarded-*` from an entry's `headers` and command output, and keeps
 * authentication names such as `Authorization`."
 *
 * `settings-reference.md#extraknownmarketplaces` applies the same filter to the
 * OTHER place a credential can be declared, and makes it depend on the file:
 * "Claude Code applies the same filter to a catalog entry and to an entry in an
 * `--add-dir` directory's settings, and no filter to an entry in your user
 * settings, a `--settings` file, or managed settings."
 *
 * We filter on both paths regardless of file, and that is deliberately STRICTER
 * than the page for a managed settings file. The reason is that the exemption
 * buys an administrator nothing here — `Host`, `Cookie` and `X-Forwarded-*` are
 * not credentials for any registry we can reach — while the filter is what keeps
 * one code path between a catalog (untrusted, fetched over the network) and a
 * settings file. The difference is REPORTED rather than silent: every drop
 * carries a diagnostic naming the header.
 *
 * "such as" is not an enumeration and there is still no bundle array to derive
 * the complete set from — and THAT is the half that survives every lift, while
 * the parenthetical around it has now been wrong twice in the same direction.
 * It first read "2.1.223 has neither the archive source nor either `headers`
 * field"; S0-3 lifted the bundle to 2.1.233 and half of that went false (the
 * `archive` source, `url` + `sha256`, arrived with it). It then read that the
 * ENTRY arm carries no `headers` field, and at the bundle we ship today that is
 * false too — measured 2026-09-17 against the vendored `sdk.d.ts`, whose two
 * self-reports agree at `claudeCodeVersion` 2.1.251 and a binary answering
 * `2.1.251 (Claude Code)`: a marketplace entry declares `headers` ("HTTP headers
 * sent when downloading this entry's `archive` source") AND a `headersHelper`
 * command form beside it, ten `headersHelper` declarations across the
 * marketplace shapes, and `archiveAuth` now occurs zero times.
 *
 * **None of that gives this filter an array to read, which is the only thing it
 * was ever waiting for.** The shipped shape is `Record<string, string>` — an
 * open map with no enumeration of what the CLI itself drops — so a lift can keep
 * adding header FIELDS without ever publishing a dropped-name list. Read the
 * bundle before quoting a version here; do not re-derive the list from one.
 * See `archive-headers.ts` for the measurement and for why the host keeps the
 * fetch. The list is therefore the three
 * names the page gives plus the exact spellings of the same two mechanisms —
 * RFC 7239 `Forwarded` for routing, `Cookie2`/`X-Real-IP` for identity — and
 * nothing invented beyond that class. A name outside it is KEPT, which is the
 * direction that cannot silently break an authenticated install.
 *
 * No imports on purpose: this is read by the managed-policy parser, which runs
 * before a config dir is settled and must not pull in the plugin schema.
 */

const DROPPED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'cookie',
  'cookie2',
  'forwarded',
  'x-real-ip',
]);

const DROPPED_HEADER_PREFIXES: readonly string[] = ['x-forwarded-'];

export function isDroppedRequestHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return DROPPED_HEADER_NAMES.has(lower)
    || DROPPED_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix));
}

export interface FilteredRequestHeaders {
  /** The headers that survive. Omitted rather than empty when nothing does. */
  headers?: Record<string, string>;
  /** Names dropped by the routing/identity filter, in declaration order. */
  dropped: string[];
  /** Names whose value was not a string, or whose name was blank. */
  malformed: string[];
}

/**
 * Filter one declared `headers` object. `undefined` for `value` means the field
 * was absent; a non-object value yields no headers and is reported by the caller,
 * which is the layer that knows what to call the thing that declared it.
 *
 * NEVER returns or logs a header VALUE anywhere but in `headers` itself: the
 * whole point of the field is that it carries a credential.
 */
export function filterDeclaredRequestHeaders(value: unknown): FilteredRequestHeaders | undefined {
  if (value === undefined || value === null) return { dropped: [], malformed: [] };
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  const dropped: string[] = [];
  const malformed: string[] = [];
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    const trimmedName = name.trim();
    if (!trimmedName || typeof headerValue !== 'string') {
      malformed.push(name);
      continue;
    }
    if (isDroppedRequestHeaderName(trimmedName)) {
      dropped.push(trimmedName);
      continue;
    }
    headers[trimmedName] = headerValue;
  }
  return {
    ...(Object.keys(headers).length ? { headers } : {}),
    dropped,
    malformed,
  };
}
