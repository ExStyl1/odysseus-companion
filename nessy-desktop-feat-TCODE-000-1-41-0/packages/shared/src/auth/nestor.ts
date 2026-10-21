import {
  NESTOR_MODEL_SNAPSHOT_META,
  NESTOR_MODEL_SNAPSHOT_WINDOWS,
} from './nestor-model-snapshot.ts';

export const NESTOR_CLI_BASE_PREFIX = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/';
export const NESTOR_GATEWAY_HOST = new URL(NESTOR_CLI_BASE_PREFIX).hostname;

export { NESTOR_MODEL_SNAPSHOT_META, NESTOR_MODEL_SNAPSHOT_WINDOWS };

export function isNestorCliBaseUrl(baseUrl?: string | null): boolean {
  return !!baseUrl?.trim().startsWith(NESTOR_CLI_BASE_PREFIX);
}

/**
 * The openai-like chat base — the connection `baseUrl` the one-click gateway
 * cards write, and the root of every chat request the runtimes send.
 *
 * DERIVED here from {@link NESTOR_CLI_BASE_PREFIX} rather than imported, and
 * that is a packaging constraint rather than a preference:
 * `unified-network-interceptor.ts` is staged into the Pi subprocess as a SOURCE
 * CLOSURE of relative imports under `packages/shared/src`
 * (`scripts/build/interceptor-pairing.ts` symbol `interceptorClosure` refuses a
 * specifier resolving outside it), and this module is a member of that closure.
 * A bare `@nessy-agent/codex-responses-adapter` import here would resolve in the
 * repo and be missing from the staged tree.
 *
 * So there are two derivations of one URL, and they are pinned EQUAL by a test
 * rather than trusted: `agent/backend/internal/drivers/upstream-target.ts`
 * symbol `NESSY_GATEWAY_CHAT_BASE_URL` derives the same string from the
 * adapter's `NESTOR_CHAT_URL`, and
 * `__tests__/nestor.test.ts` asserts the two agree (`:201`). A
 * third hand-written copy is what DA1.11 is about; this one at least cannot
 * drift silently.
 */
export const NESTOR_GATEWAY_CHAT_BASE_URL = `${NESTOR_CLI_BASE_PREFIX}openai-like/v1`;

/** The catalogue endpoint (`fetchNestorModels`), the second of the two named endpoints. */
export const NESTOR_GATEWAY_MODELS_URL = `${NESTOR_CLI_BASE_PREFIX}models`;

/**
 * DA1.10 — may the corporate dp JWT be attached to THIS URL?
 *
 * ## Why this is narrower than {@link isNestorCliBaseUrl}, and why that one stays
 *
 * The CLI prefix accepts EVERY path under `…/api/v1/cli/`. As a credential
 * boundary that is too wide in one specific, reachable way: a BYO `pi_compat`
 * connection pointed at any other path under the prefix was handed the dp JWT as
 * its api key, and had its own Bearer rewritten to `Nestor-Token` on the way
 * out. The named set is TWO URLs — the chat base (and everything under it, which
 * is where `/chat/completions` and the SDK's own `/models` live) and the
 * catalogue URL — so that is what the credential decisions test.
 *
 * **The prefix predicate is NOT deprecated by this, and a mechanical sweep of
 * its call sites would reverse written decisions and open a leak.** Every count
 * below is a READING WITH A DATE, not a standing fact — this census has already
 * gone stale twice inside one wave, which is why the list is per-site and the
 * number is dated rather than quoted forward. Instrument both times: `git grep
 * -an` over `packages apps` for `isNestorCliBaseUrl` AND for a direct
 * `startsWith(NESTOR_CLI_BASE_PREFIX)`, with the definition, imports, comments
 * and tests excluded by hand.
 *
 * - **2026-09-13:** twelve executable sites, of which only the two CREDENTIAL
 *   ones (inside `unified-network-interceptor.ts` symbol
 *   `rewriteNestorAuthHeaders`) move onto this predicate.
 * - **2026-09-17:** **nine**, and the three that left are accounted for
 *   individually: the two credential sites under DA1.10, and
 *   `agent/backend/composer-capabilities.ts` symbol `offersNestorQuota`, which
 *   DA1.44 moved onto THIS predicate and the wave-A2 review then moved again
 *   onto the whole-URL rule (see the asymmetry note below). That file now has
 *   zero executable prefix reads.
 *
 * Per surviving site, why each keeps it:
 *
 * - `unified-network-interceptor.ts` symbol `rewriteCredentialHeader` uses the
 *   prefix to EXCLUDE — "Never on the verified gateway prefix", because that
 *   path has its own scheme. Narrowing it would START rewriting Bearer to
 *   `x-api-key` on gateway-host paths it currently leaves alone. It moves the
 *   OPPOSITE way, so it stays wide.
 * - `unified-network-interceptor.ts` symbol `isProviderApiUrl` uses the prefix
 *   to WIDEN the boundary operator headers may ride on. Narrowing SHRINKS a
 *   documented allowance nobody asked to shrink.
 * - FOUR sites in `telemetry/gateway-headers.ts` (`gatewayCorrelationHeaders`,
 *   `gatewayRequestHeaders`, `operatorHeadersRideOnUpstream`,
 *   `gatewayHeaderDecisionLine`) are the operator-header and correlation
 *   channel, whose own docblock declares the prefix scope deliberate: "only a
 *   BYO endpoint that happens to sit under the verified prefix rides too, which
 *   is the same test the header stamp makes, so the two can never disagree." A
 *   correlation id is not a credential; narrowing them would reverse that
 *   decision without naming it, and would make the stamp and the predicate
 *   disagree.
 * - `agent/pi-agent.ts` symbol `describeQuota` decides whether `/quota` is
 *   answered at all. The quota URL is built from the connection ORIGIN, sits
 *   outside the CLI prefix and carries its own token, so this is a FEATURE gate
 *   and not a credential gate; narrowing it would silently stop answering
 *   `/quota` for endpoints that answer it today.
 *
 *   **THE ONE ASYMMETRY IN THIS FILE'S SCOPE, and it is deliberate — meet it on
 *   purpose rather than re-discover it.** The Pi `/quota` MENU and the Pi
 *   `/quota` ANSWER no longer read the same predicate. The menu
 *   (`agent/backend/composer-capabilities.ts` symbol `offersNestorQuota`) is the
 *   whole-URL rule `backend/internal/drivers/upstream-target.ts` symbol
 *   `isNessyGatewayBaseUrl` as of the wave-A2 review; the answer above is still
 *   the CLI prefix, by the decision in this very bullet. So a connection under
 *   the prefix but off the chat base is NOT offered the row and WOULD be
 *   answered if the command were reached another way. That direction is the safe
 *   one — the menu offers strictly less than the answer serves, never more — and
 *   it is the reverse of the ADVERTISED shape `offersNestorQuota`'s own menu
 *   table exists to prevent. It does falsify that table's sentence *"Each row
 *   reads the SAME predicate the seam reads"* for this one row, so the sentence
 *   is qualified there too. Closing it means taking DA1.10's written decision
 *   back, which is a product posture and not a sweep.
 * - `apps/electron/src/renderer/lib/provider-icons.ts` is an icon, and since
 *   2026-09-17 it is the ONLY remaining member of what used to be a two-file
 *   "capability tier and an icon" bullet. It attaches nothing.
 * - `server-core/model-fetchers/nestor.ts` symbol `isNestorConnection` selects
 *   the FETCHER for a connection and reads its own local copy of the prefix; it
 *   is `packages/server-core` and outside this module's reach.
 *
 * ## The parse, not a substring test
 *
 * `new URL` is what makes `…/openai-like/v1/../../personal/x` resolve before it
 * is compared, and what lowercases the host — the rule
 * `upstream-target.ts` states for its own host read ("PARSED - never a substring
 * test"). Query and fragment are dropped: they do not name an endpoint. A
 * trailing slash is normalised so `…/v1` and `…/v1/` compare equal, the same
 * normalisation `normalizeUpstreamBaseUrl` applies.
 *
 * A URL that does not parse is NOT the gateway — fail closed, which is also what
 * keeps the interceptor's identity return for a malformed input.
 */
export function isNestorGatewayCredentialUrl(url?: string | null): boolean {
  const trimmed = url?.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const normalized = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  return normalized === NESTOR_GATEWAY_MODELS_URL
    || normalized === NESTOR_GATEWAY_CHAT_BASE_URL
    || normalized.startsWith(`${NESTOR_GATEWAY_CHAT_BASE_URL}/`);
}

/**
 * The floor below which a reported context window is a placeholder, not a window.
 *
 * **Measured, twice, in two independent catalogues — and every count below is
 * DATED, because a bare count reads as a standing fact about a catalogue that
 * moves weekly.** llm-proxy's `GET /models` reports `context_length: 1` for
 * **63 of its 387 rows as measured 2026-08-28** — including real chat models —
 * and it means "nobody filled this in", not "one token". This line said *68 of
 * 383* until 2026-08-28: that was a 2026-08-14 reading carried forward undated,
 * and it had already drifted by the time it shipped, which is the third stale
 * hand-count this repo has placed beside a correct artefact. Two further rows sit
 * under 1024 at the same reading, so ~17% of the catalogue would poison a naive
 * consumer. The Pi SDK's own vendored model registry carries the same
 * placeholder: **207 entries at `contextWindow: 1` and one at `0`, as recorded
 * 2026-08-28** — that half is not re-measured here, since the SDK is not
 * installed in this tree. Consuming either literally would cap a session at a
 * window the model does not have, silently, on exactly the models nobody curated.
 *
 * The floor is deliberately three orders of magnitude above the two observed
 * placeholders (`0` and `1`) and below any deployed chat model's window, because
 * the two failure directions are not symmetric and neither is free:
 * accepting a placeholder breaks the session outright, while rejecting a
 * genuinely tiny window degrades to the fallback table and, failing that, to the
 * loud "no context window" warning. The second is recoverable and audible; the
 * first is neither.
 *
 * **This is the ONLY floor, and it guards BOTH catalogue paths (P3.91).** The BYO
 * fetcher (`server-core/model-fetchers/openai-compat.ts`) used to keep a private
 * `MIN_CREDIBLE_CONTEXT_WINDOW = 4096` for the same sentinel, with neither site
 * citing the other, so a genuine 2048-token window survived the gateway path and
 * was discarded on the BYO one. Both now call
 * {@link sanitizeReportedContextWindow}. If this number ever moves, it moves for
 * both — and `scripts/refresh-nestor-model-windows.ts` parses it out of this
 * file's source rather than restating it, so the snapshot cannot ship a value the
 * runtime then rejects.
 */
export const MIN_PLAUSIBLE_CONTEXT_WINDOW = 1024;

/**
 * A reported context window, or `undefined` when the value is a placeholder.
 *
 * Shared by every reader of a *reported* window — the model fetcher's live
 * `/cli/models` parse and the snapshot refresh script — so the sentinel is
 * rejected once rather than in each consumer that remembered to.
 */
export function sanitizeReportedContextWindow(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored >= MIN_PLAUSIBLE_CONTEXT_WINDOW ? floored : undefined;
}

/**
 * The hand-typed window this fallback started life as — kept as the ceiling half
 * of the merge, NOT as an authority, and re-labelled by P3.88 because the label
 * it carried was the trap.
 *
 * **This said `Hand-confirmed gateway max_model_len … verified against the model
 * server` and that description is refuted.** Measured 2026-08-28 against both
 * back ends: `262144` is what **llm-proxy** publishes as `context_length`, and
 * it is exactly 256 x 1024 — the model's ARCHITECTURAL window. The **gateway**'s
 * own `GET /api/v1/cli/models` publishes `context_window_size: 262000` for the
 * same two ids, which is its SERVING limit. They measure different quantities,
 * the difference is uniform across the entire two-model shipped pool rather than
 * a one-model quirk, and **the one that will reject a request is the smaller
 * one**.
 *
 * So the number below is not a second opinion about the gateway; it is a
 * different system's answer, and it survives here only as the upper bound
 * {@link mergeSmallerWindow} takes the minimum against. Deleting it changes
 * nothing today (the merge already resolves to 262000) and deleting the
 * REASONING would change plenty: a reader who meets `262144` in llm-proxy's
 * catalogue and "corrects" the snapshot upward walks straight back into the
 * silent no-compaction bug this whole tier exists to prevent. That is the
 * failure P3.88 exists to make un-repeatable, which is why the sentence is here
 * rather than in a plan row.
 *
 * `NESSY_GATEWAY_CONTEXT_WINDOW` in the electron `nessy-gateway` preset no
 * longer restates it — it derives from the merged table (`gatewaySeedWindow`),
 * so the two cannot drift the way they did before P3.91.
 */
const NESTOR_CURATED_MODEL_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  'tgpt/qwen35-397b-a17b-fp8': 262_144,
  'tgpt/qwen36-35b-a3b-fp8': 262_144,
});

/**
 * Ids the gateway once served and no longer lists, with the last window IT
 * reported for them — kept as DATED HISTORY, not as a catalogue.
 *
 * **Measured 2026-09-11 (P6.1080).** `GET /api/v1/cli/models` returns two rows:
 * `tgpt/qwen36-35b-a3b-fp8` (alias `fast`, 262000) and
 * `tgpt/deepseek-v4-flash-0731` (alias `coder`, 524000). A request naming
 * `tgpt/qwen35-397b-a17b-fp8` — the id this repo called the default coder model
 * for a year — is answered `404 … больше не поддерживается`. The snapshot
 * refresh therefore dropped that id, correctly: it harvests what the gateway
 * serves.
 *
 * Dropping it from the MERGE as well would be wrong, and the direction is the
 * silent one. The window table is tier two, consulted exactly when the live
 * fetch could NOT answer — an offline start, a 5xx, a stored catalogue entry
 * that lost its window. That is also precisely the state in which a connection
 * still carries the retired id as its `defaultModel`, because
 * `ModelRefreshService._doRefresh` only rewrites a stale default on a
 * SUCCESSFUL fetch. So the one session that still runs this model is the one
 * that cannot look its window up, and deleting the row here would hand
 * `claude-agent.ts` `undefined`, leave `CLAUDE_CODE_AUTO_COMPACT_WINDOW` unset,
 * and reproduce the never-compacts bug this whole tier exists to prevent — on
 * the users worst placed to notice.
 *
 * The value is the gateway's own last SERVING limit (262000), not the
 * architectural 262144 in {@link NESTOR_CURATED_MODEL_WINDOWS}: with the
 * snapshot half gone the merge would otherwise resolve this id UPWARD by 144
 * tokens, which is the over-stating direction {@link mergeSmallerWindow} exists
 * to refuse. Nothing is invented here — 262000 is the number the 2026-08-28
 * harvest recorded, re-stated in the table that keeps it.
 *
 * A row leaves this table only when no stored connection can still carry the
 * id, which is not a thing this process can know; it is cheap to keep and
 * expensive to drop.
 */
const NESTOR_RETIRED_MODEL_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  /** Retired by the gateway on or before 2026-09-11; last reported 2026-08-28. */
  'tgpt/qwen35-397b-a17b-fp8': 262_000,
});

/**
 * Merge two window tables, keeping the SMALLER value wherever they disagree.
 *
 * Staleness in a context window is silent and asymmetric: an over-stated window
 * reproduces the very bug this fallback exists to prevent (the session runs past
 * the real limit before anything compacts), while an under-stated one merely
 * compacts early. So a disagreement between a hand-confirmed number and a
 * harvested one is resolved downward rather than by deciding which source is
 * more authoritative — that decision is exactly the one nobody can make
 * correctly from inside the process.
 */
function mergeSmallerWindow(
  ...tables: ReadonlyArray<Readonly<Record<string, number>>>
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const table of tables) {
    for (const [id, window] of Object.entries(table)) {
      const existing = merged[id];
      merged[id] = existing === undefined ? window : Math.min(existing, window);
    }
  }
  return merged;
}

/**
 * Gateway model id → context window, for the models the live API could not
 * answer for.
 *
 * **This is tier two of three, and the order matters.** The live
 * `/cli/models` response is tier one: measured 2026-08-28, it reports
 * `context_window_size` on every row, so `fetchNestorModels` stamps a real
 * window onto the catalogue and this table is never consulted for those ids.
 * Tier three is the loud "no context window" warning for a model in neither.
 *
 * It lives HERE, in the dependency-free Nestor module, rather than beside its
 * first reader, because it has three of them in three packages and they must
 * not drift: `server-core/model-fetchers/nestor.ts` stamps it onto the fetched
 * catalogue, `shared/agent/claude-agent.ts` falls back to it when the stored
 * catalogue entry carries no window (without it the Claude SDK subprocess gets
 * no `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and never compacts at all), and the
 * electron `nessy-gateway` preset seeds it into a freshly created connection.
 * A table that lived in only one of those was a fallback the other two could
 * not consult — which is exactly how a gateway model reached a session with no
 * window and no compaction.
 *
 * The value is the smaller of the hand-confirmed `max_model_len` and the
 * harvested snapshot; see {@link mergeSmallerWindow} for why disagreement is
 * resolved downward, and {@link NESTOR_MODEL_SNAPSHOT_META} for when the
 * snapshot half was harvested. {@link NESTOR_RETIRED_MODEL_WINDOWS} joins the
 * merge for ids the gateway has since stopped listing — dated history, so a
 * connection still carrying a retired default keeps a window to compact
 * against.
 */
export const NESTOR_GATEWAY_MODEL_WINDOWS: Readonly<Record<string, number>> = Object.freeze(
  mergeSmallerWindow(
    NESTOR_CURATED_MODEL_WINDOWS,
    NESTOR_RETIRED_MODEL_WINDOWS,
    NESTOR_MODEL_SNAPSHOT_WINDOWS,
  ),
);

/** The gateway-confirmed window for a model id, or `undefined` for any other id. */
export function nestorGatewayModelWindow(modelId?: string): number | undefined {
  return modelId ? NESTOR_GATEWAY_MODEL_WINDOWS[modelId] : undefined;
}
