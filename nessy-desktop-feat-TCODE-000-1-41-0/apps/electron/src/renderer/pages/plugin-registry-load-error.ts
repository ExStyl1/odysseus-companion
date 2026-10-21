/**
 * Which sentence a refused or failed marketplace gets (P2.429, P6.41's
 * legibility residue).
 *
 * ## The defect this closes
 *
 * Every per-registry failure reaches the renderer the same way — a
 * `SafeMarketplaceRegistryLoadError` carrying path-free diagnostic CODES — and
 * `PluginsPage` mapped none of them, rendering one generic
 * `plugins.registryLoadError` note for all of them. So a marketplace REFUSED
 * for impersonating an Anthropic-published source (`reserved_name`, the gate
 * P6.41 built) was told to the user in the same words as a network fetch that
 * timed out, and the two have opposite remedies: one is a standing verdict
 * about the NAME that retrying can never clear, the other clears itself.
 *
 * `marketplace.registry.fetch_pending` made the same banner say something
 * simply untrue — a registry whose catalog fetch is still in flight is not a
 * registry that "could not be loaded", and the poll that will replace it is
 * already scheduled (`useMarketplaceItems.ts`'s
 * `marketplacePendingPollInterval`).
 *
 * ## Why a table and not a branch for the one code
 *
 * P6.41's own delivery path already needed a second outcome
 * (`refused-reserved-name` versus a generic `failed`) for exactly this reason.
 * A branch closes one code; the next refusal added to `registry-source.ts`
 * silently falls back to "could not be loaded" again. The table makes adding a
 * code a one-line edit and makes the fallback the explicit, named default
 * rather than the accidental one.
 *
 * Pure (no React, no IPC, no i18n instance — it returns the KEY), so it is
 * testable without mounting a page this tree has no DOM harness for.
 */

/** The generic note, kept as the honest answer for a code nobody has mapped yet. */
export const REGISTRY_LOAD_ERROR_FALLBACK_KEY = 'plugins.registryLoadError'

/**
 * Diagnostic code → message key, for the codes whose REMEDY diverges from the
 * generic one. A code absent from this table is not a bug: it falls back, and
 * the fallback still tells the truth.
 *
 * Codes read from their producers rather than invented:
 * `marketplace/registry-source.ts` emits `source_not_allowed`, `reserved_name`,
 * `fetch_timeout` and `fetch_failed`, and its `pendingLoadError` emits
 * `fetch_pending`. `source_blocked` is the one exception and it is stated as
 * such on its row below: the sentence is here, the producer is not yet.
 */
export const REGISTRY_LOAD_ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  // A standing verdict about the NAME. Retrying never clears it; renaming or
  // removing the marketplace does.
  'marketplace.registry.reserved_name': 'plugins.registryLoadErrorReservedName',
  // A managed-policy refusal. The user usually cannot fix it themselves.
  'marketplace.registry.source_not_allowed': 'plugins.registryLoadErrorSourceNotAllowed',
  // P2.482 — the OTHER managed-policy refusal, and it gets its own sentence
  // because the two have OPPOSITE administrator remedies: this one clears when
  // the entry is removed from `blockedMarketplaces`, the one above when the
  // source is added to `allowedPluginMarketplaces`. They share a code today, so
  // a blocked marketplace tells the user to ask for the wrong key. The blocking
  // ENTRY is deliberately not in the sentence — `toLoadError` is path-free by
  // construction, so an administrator's pattern stays on the operator's log
  // line, where the person who can change it reads it.
  //
  // NOTHING EMITS THIS CODE YET, and that is stated rather than left to be
  // discovered. `registry-source.ts` was held by another lane when this landed,
  // so the producer half is dispatched: `resolveRegistryEntry`'s `blockedBy`
  // branch returns `source_blocked` instead of `source_not_allowed`, and the
  // same code joins the `refused` set in `fetchRegistryEntry`'s warning — a code
  // added in the first place and not the second silently rejoins the "catalog
  // fetch failed" wording, which is the verb P2.467 already had to fix once.
  // Until then this row is inert and the blocklist refusal keeps the allowlist's
  // sentence; the machine check in `__tests__/plugin-registry-load-error.test.ts`
  // is satisfied either way (it requires every EMITTED code to be mapped, not
  // every mapped code to be emitted), so nothing here was weakened to land it.
  'marketplace.registry.source_blocked': 'plugins.registryLoadErrorSourceBlocked',
  // Transient. Retrying is exactly the right thing to do.
  'marketplace.registry.fetch_timeout': 'plugins.registryLoadErrorFetchTimeout',
  'marketplace.registry.fetch_failed': 'plugins.registryLoadErrorFetchFailed',
  // Not a failure at all — the fetch is still in flight and a poll is already
  // scheduled. Nothing for the user to do.
  'marketplace.registry.fetch_pending': 'plugins.registryLoadErrorFetchPending',
  // P6.621 — also not a failure: the marketplace renamed ITSELF between two
  // refreshes and its catalog is unchanged. It rides this channel because the
  // page already renders the channel as the section's note, which is the same
  // move `fetch_pending` made; the sentence says the catalog is unchanged so the
  // note is not read as a fetch that broke.
  'marketplace.registry.renamed': 'plugins.registryLoadErrorRenamed',
  // P6.479 — the managed tier's `headersHelper` ran and failed, so the catalog
  // fetch was never made. Its own sentence because the remedy is neither
  // "retry" nor "rename": the command lives in managed settings and only an
  // administrator can fix it. The command TEXT is deliberately absent from the
  // sentence, as it is from every diagnostic on this path.
  'marketplace.registry.headers_helper_failed': 'plugins.registryLoadErrorHeadersHelperFailed',
}

/**
 * The message key for one registry's load error.
 *
 * First MAPPED code wins, in the order the server listed them, and the rule is
 * deliberately that simple: today every refusal is reported alone (each
 * `resolveRegistryEntry` refusal returns a single-code `loadError`, and
 * `pendingLoadError` is synthesized on its own), so no precedence between two
 * mapped codes can arise. A multi-code error today is a set of catalog PARSE
 * errors, none of which is mapped — which is precisely the fallback's case.
 * If a future producer can emit two mapped codes at once, that is the moment to
 * give this a precedence order, not before.
 */
export function registryLoadErrorMessageKey(diagnosticCodes: readonly string[]): string {
  for (const code of diagnosticCodes) {
    const key = REGISTRY_LOAD_ERROR_MESSAGE_KEYS[code]
    if (key) return key
  }
  return REGISTRY_LOAD_ERROR_FALLBACK_KEY
}

/**
 * F1.226 — the codes that ride this channel and are NOT a failure: a fetch
 * still in flight (a poll is already scheduled) and a marketplace that renamed
 * itself with its catalogue unchanged. Their own section notes say exactly that.
 */
const NOT_A_LOAD_FAILURE_CODES: ReadonlySet<string> = new Set([
  'marketplace.registry.fetch_pending',
  'marketplace.registry.renamed',
])

/**
 * F1.226 — the registries the page-level "Some marketplaces could not be
 * loaded." banner (`MarketplaceBrowsePage`'s `loadErrorNote`) stands for: every
 * load error that is a FAILURE (a code outside {@link NOT_A_LOAD_FAILURE_CODES},
 * or no code at all), on a marketplace OTHER than the selected one — the
 * selected registry's own section already names its reason, in the specific
 * words {@link registryLoadErrorMessageKey} picks. Returned as ids, in the
 * server's order, so a caller can count them or name them.
 */
export function registryLoadFailuresElsewhere(
  errors: ReadonlyArray<{ marketplaceId: string; diagnosticCodes: readonly string[] }>,
  selectedMarketplaceId: string,
): string[] {
  return errors
    .filter(error => error.marketplaceId !== selectedMarketplaceId)
    .filter(error => error.diagnosticCodes.length === 0
      || error.diagnosticCodes.some(code => !NOT_A_LOAD_FAILURE_CODES.has(code)))
    .map(error => error.marketplaceId)
}
