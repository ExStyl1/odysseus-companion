/**
 * P6.339 — the operator's web-search domain allowlist.
 *
 * ## What was measured
 *
 * No runtime gives an operator this control today. Codex PUBLISHES the key and
 * we never write it (`WebSearchToolConfig.allowed_domains`, an array of strings,
 * in the vendored `codex-protocol/schema/config-schema.json` — generated from
 * the source the shipped binary is built from). Claude has `allowed_domains`
 * only as a MODEL-chosen tool INPUT in the vendored SDK's tool types, which is
 * the model narrowing its own search, not an operator constraining it. Pi's
 * `web_search` schema is `{query, count}` and its DDG provider filters nothing.
 *
 * So this is a step-2 row by the native-first rule: no runtime offers the
 * control host-side, and the host supplies it once for all three.
 *
 * ## The name is ours, and it is stated rather than borrowed
 *
 * `env-vars.md` documents no web-search allowlist variable, so there is no
 * spelling to be compatible with; inventing a `CLAUDE_CODE_` name would claim a
 * contract that does not exist. `NESSY_WEB_SEARCH_ALLOWED_DOMAINS` follows the
 * family `web-search-budget.ts` already established for this tool.
 *
 * ## The matching rule, and why it is suffix-wise
 *
 * An entry matches its own host and every subdomain of it: `example.com` allows
 * `example.com` and `docs.example.com`, and does NOT allow `notexample.com` —
 * the label boundary is checked, because a plain `endsWith` would let an
 * attacker register `evil-example.com` past an allowlist that reads correct.
 * That is the same shape codex's own key implies and the shape an operator
 * means; it is written here rather than assumed because the two differ by one
 * character of code.
 *
 * UNSET IS OFF. An empty list filters nothing, so an install that configured
 * nothing behaves exactly as it did before this row.
 */

/** The one name an operator sets. Comma- or whitespace-separated. */
export const WEB_SEARCH_ALLOWED_DOMAINS_ENV = 'NESSY_WEB_SEARCH_ALLOWED_DOMAINS'

/**
 * The configured hosts, lowercased and normalized, or an empty list.
 *
 * Entries are accepted in the spellings people actually write them in — with a
 * scheme, with a leading dot, with a trailing path — because refusing those
 * would be a setting that silently does nothing for a value that looks right.
 * An entry that normalizes to nothing is dropped.
 */
export function resolveWebSearchAllowedDomains(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const raw = env[WEB_SEARCH_ALLOWED_DOMAINS_ENV]
  if (raw === undefined || raw.trim().length === 0) return []
  const seen = new Set<string>()
  for (const entry of raw.split(/[,\s]+/)) {
    const host = normalizeAllowlistHost(entry)
    if (host) seen.add(host)
  }
  return [...seen]
}

/** `https://Docs.Example.com/x` -> `docs.example.com`; `.example.com` -> `example.com`. */
function normalizeAllowlistHost(entry: string): string | undefined {
  let value = entry.trim().toLowerCase()
  if (!value) return undefined
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.split('/')[0] ?? ''
  // A port is not part of the host an operator means to allow.
  value = value.split(':')[0] ?? ''
  value = value.replace(/^\.+/, '').replace(/\.+$/, '')
  return value.length > 0 ? value : undefined
}

/**
 * Is this result's URL inside the allowlist?
 *
 * An EMPTY allowlist allows everything — the feature is off, not deny-all. A
 * URL that cannot be parsed is REFUSED when an allowlist is in force: an
 * operator who named the hosts their people may read has not consented to "and
 * anything we could not classify".
 */
export function isWebSearchUrlAllowed(url: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return false
  }
  return allowed.some(domain => host === domain || host.endsWith(`.${domain}`))
}

/** The sentence a filtered-to-nothing search returns, naming the lever. */
export function webSearchAllowlistNotice(allowed: readonly string[]): string {
  return `Every result was outside the operator's web-search allowlist `
    + `(${WEB_SEARCH_ALLOWED_DOMAINS_ENV}=${allowed.join(', ')}). `
    + `Continue with what you already have, or ask the user to widen the allowlist.`
}

/**
 * F1.1041 — the allowlist on Claude Code's OWN `WebSearch`, through the tool's own input.
 *
 * Claude's search runs on Anthropic's backend (or the user's passthrough endpoint), so the host never
 * sees its results to filter them the way Pi's tool and the host search do. What the runtime does
 * hand us is the tool's own scoping input and a hook field that rewrites it:
 * `tools-reference.md#websearch-tool-behavior` — "Claude can scope results with `allowed_domains` to
 * include only certain hosts, or `blocked_domains` to exclude them. The two lists can't be combined in
 * a single call." — and `hooks.md#pretooluse-decision-control` — `updatedInput` "Modifies the tool's
 * input parameters before execution. Replaces the entire input object". So the claude PreToolUse gate
 * passes the call through here, and the answer is the WHOLE input it forwards.
 *
 * - UNSET IS OFF, as everywhere: an empty allowlist returns the input object itself, untouched.
 * - No `allowed_domains` from the model: the operator's list becomes it.
 * - The model's own `allowed_domains`: intersected, host by host, keeping the NARROWER of each
 *   overlapping pair (`docs.example.com` asked under an allowed `example.com` stays `docs.example.com`;
 *   `example.com` asked over an allowed `docs.example.com` becomes `docs.example.com`), so the model can
 *   narrow inside the operator's list and never widen it. Its entries are normalized like the
 *   operator's.
 * - `blocked_domains` is DROPPED: the page forbids combining the two lists, and the operator's list
 *   must be the one that holds. Residue, stated: a model's exclusion inside the allowlist is lost for
 *   that call; its results still come only from allowed hosts.
 * - An intersection that is empty is REFUSED with a reason naming the variable — there is no input
 *   that searches only the model's hosts and stays inside the operator's list, and an empty
 *   `allowed_domains` would read as no filter at all.
 *
 * The backend applies the list by its own host rules; this module does not re-filter what it returns.
 */
export function scopeClaudeWebSearchInput(
  input: Record<string, unknown>,
  allowed: readonly string[] = resolveWebSearchAllowedDomains(),
): { input: Record<string, unknown> } | { refusal: string } {
  if (allowed.length === 0) return { input }
  const asked = (Array.isArray(input.allowed_domains) ? input.allowed_domains : [])
    .flatMap(entry => (typeof entry === 'string' ? [normalizeAllowlistHost(entry)] : []))
    .filter((host): host is string => host !== undefined)
  const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)
  const domains = asked.length === 0
    ? [...allowed]
    : [...new Set(asked.flatMap(host => allowed.flatMap(domain =>
      under(host, domain) ? [host] : under(domain, host) ? [domain] : [])))]
  if (domains.length === 0) {
    return {
      refusal: `This search named only domains outside the operator's web-search allowlist `
        + `(${WEB_SEARCH_ALLOWED_DOMAINS_ENV}=${allowed.join(', ')}), so it was not run. `
        + `Search within those domains, continue with what you already have, or ask the user to widen the allowlist.`,
    }
  }
  const { blocked_domains: _blocked, allowed_domains: _asked, ...rest } = input
  return { input: { ...rest, allowed_domains: domains } }
}
