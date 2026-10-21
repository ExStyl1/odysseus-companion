/**
 * C3.346 — where the model picker's list came from, and when it was last read.
 *
 * ## The finding this answers
 *
 * R1 (PR-R1-4, rig day 2026-09-12) measured the picker's model records against
 * the packaged 1.37.0 build: they carry **no provenance field at all**, and the
 * string `From gateway` scored 0 occurrences across all 318 renderer chunks and
 * 0 in `main.cjs`, against four positive controls on the same rig scoring 3–20.
 * So a user looking at the gateway's catalogue cannot tell it from a list
 * someone typed into the connection form, or from the one built into the app.
 *
 * ## Derived, never stored
 *
 * Nothing new crosses the wire and nothing new is persisted. The picker already
 * holds the whole connection, and the two facts the row asks for are already in
 * it: `baseUrl` + `providerType` decide whether this is the corporate gateway
 * (through `isNessyGatewayConnection`, IMPORTED rather than re-derived — its own
 * docblock records what a second copy of "which URL is the gateway" has cost
 * this repo), and `modelsSyncedAt` is the moment the host last merged the
 * endpoint's own metadata in.
 *
 * ## The half this deliberately did NOT claim, and how it was closed (DA2.12)
 *
 * **A gateway list carried no timestamp, and `modelsSyncedAt` must not be
 * borrowed for one.** That field is the BYO metadata-sync ENROLMENT marker, not
 * a refresh clock: `isModelSyncEnrolled`
 * (`packages/server-core/src/model-fetchers/index.ts`) returns `false` for any
 * connection without it and its docblock excludes the gateway cards by name —
 * *"no stamp is ever written for them … the gateway has its own fetcher with its
 * own cadence, and an enrollment that reached it would have this path and that
 * one both writing the same list."* Stamping it where the gateway catalogue is
 * replaced would therefore give one model list two writers, which is the exact
 * hazard that module declines. So C3.346 reported `syncedAt` when it existed and
 * let the sentence omit the time when it did not — a wrong time is worse than no
 * time on a surface whose whole purpose is telling the user where the list came
 * from — and recorded that closing the half needed a persisted field of its own,
 * never a cast.
 *
 * **DA2.12 closed it that way, and this paragraph is history rather than a live
 * limitation.** The refresh service writes `catalogueRefreshedAt` — a field of
 * its own, epoch milliseconds, in the same call that replaces `models` — and the
 * gateway arm below reads it. The endpoint arm still reads `modelsSyncedAt`, so
 * each path answers from the marker that owns it and neither borrows the other's.
 * If you are about to cite the paragraph above for "the gateway has no clock",
 * cite it with this date beside it: it stopped being true on 2026-09-17.
 */

/** Which source the picker's current model list came from. */
export type ModelListProvenance =
  /** The corporate Nessy Gateway catalogue, fetched by the host's own fetcher. */
  | { readonly kind: 'gateway'; readonly syncedAt?: number }
  /** A connection whose list is the user's own endpoint's, or their own typing. */
  | { readonly kind: 'endpoint'; readonly host: string; readonly syncedAt?: number }
  /** No connection resolved: the picker is showing the list built into the app. */
  | { readonly kind: 'builtIn' }

/** The shape this reads — a structural subset of `LlmConnection`, so a test needs no fixture. */
export interface ModelListConnectionFacts {
  readonly providerType?: string
  readonly baseUrl?: string
  readonly modelsSyncedAt?: number | null
  /**
   * DA2.12 — the moment the host last REPLACED this connection's list from a
   * live fetch, written by the refresh service in the same call that replaces
   * `models`. A NEW field and deliberately not `modelsSyncedAt`; the section
   * above says why borrowing that one would give one model list two writers.
   *
   * Optional on purpose, and that is what makes this readable BEFORE the field
   * exists: this interface is a structural subset declared here, so it compiles
   * whether or not the connection record carries one, and a connection without
   * it takes the same branch as today — the gateway arm omits the time, which
   * is the behaviour this module has always had.
   */
  readonly catalogueRefreshedAt?: number | null
  /**
   * F1.572 — the two facts that name a subscription card's endpoint for the
   * tool-egress line (`model-target-disclosure.ts`); this module reads neither.
   */
  readonly codexModelProvider?: string
  readonly piAuthProvider?: string
}

/**
 * The host of `baseUrl`, or the trimmed URL when it does not parse.
 *
 * The HOST and not the whole URL: the line sits under a list in a drawer, and a
 * gateway-length URL would wrap over three rows. A URL that does not parse is
 * shown as the user typed it rather than dropped — an endpoint they can no
 * longer recognise is worse than a long one.
 */
function endpointLabel(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  try {
    return new URL(trimmed).host || trimmed
  } catch {
    return trimmed
  }
}

/**
 * Classify the list the picker is showing.
 *
 * `isGateway` is injected rather than imported so this module stays free of the
 * renderer's component tree: the caller passes
 * `isNessyGatewayConnection` (`components/apisetup/nessy-gateway.ts`), which is
 * the one predicate in the renderer that answers this question, and a test can
 * drive both answers without restating a URL literal that would then be a second
 * copy of the boundary.
 */
export function modelListProvenance(
  connection: ModelListConnectionFacts | undefined,
  isGateway: (connection: { providerType?: string; baseUrl?: string }) => boolean,
): ModelListProvenance {
  if (!connection) return { kind: 'builtIn' }
  // A number, never `null`: the BYO form clears the enrolment by writing `null`,
  // and `null` means "not enrolled", not "synced at the epoch".
  const syncedAt = typeof connection.modelsSyncedAt === 'number' ? connection.modelsSyncedAt : undefined
  if (isGateway(connection)) {
    // DA2.12 — the gateway arm reads its OWN clock, never the BYO one. The same
    // `typeof` guard as above and for the same reason: the field is written as
    // `null` where it does not apply, and read as a number `null` is the epoch,
    // so the picker would say the catalogue was last read in 1970.
    //
    // The ENDPOINT arm below is deliberately unchanged. Both arms now answer the
    // same question — "when was this list last read" — from the marker that owns
    // it on that path, with no cast and no borrowed field. Giving the endpoint
    // arm a second source would make one sentence mean two things, and its own
    // marker already answers for every connection that has one.
    const refreshedAt = typeof connection.catalogueRefreshedAt === 'number'
      ? connection.catalogueRefreshedAt
      : undefined
    return refreshedAt === undefined ? { kind: 'gateway' } : { kind: 'gateway', syncedAt: refreshedAt }
  }
  const baseUrl = connection.baseUrl?.trim()
  // No `baseUrl` at all is a first-party connection (an Anthropic API key, a Pi
  // provider): the list is the one the app ships for that provider, which is
  // what `builtIn` says. Falling through to `endpoint` with an empty host would
  // print a sentence naming nothing.
  if (!baseUrl) return { kind: 'builtIn' }
  const host = endpointLabel(baseUrl)
  return syncedAt === undefined ? { kind: 'endpoint', host } : { kind: 'endpoint', host, syncedAt }
}
