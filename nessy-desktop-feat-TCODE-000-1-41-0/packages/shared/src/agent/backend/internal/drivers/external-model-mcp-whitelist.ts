/**
 * DA2.2 half A - which MCP servers an EXTERNAL model target may still be handed.
 *
 * `classifyModelTarget` (beside this file) answers WHERE a session's tool
 * schemas are about to go. This module answers the question DA2.1 deliberately
 * left to an owner: what is WITHHELD when the answer is "outside the
 * perimeter". They are two questions and they are kept in two modules so the
 * disclosure keeps working if this policy is ever changed or withdrawn.
 *
 * ---------------------------------------------------------------------------
 * OWNER DECISION 2026-09-17 (plan row DA2.14): NAMESPACE-ONLY, no BYO exemption
 * ---------------------------------------------------------------------------
 *
 * DP-5 is amended by that decision. Its original sentence - "the whitelist
 * restricts ONLY the corporate proxy channel ... BYO endpoints and the future
 * subscription cards are NOT restricted" - is superseded: the withholding now
 * follows the model NAMESPACE for every connection kind, which is the axis
 * `classifyModelTarget` already decides on and the axis the reference reached
 * independently. A BYO endpoint at a vendor is restricted exactly as the
 * corporate proxy channel is.
 *
 * Why the exemption could not be kept, in one line, because it is the reading
 * that decided it rather than a preference: the two populations DP-5 names are
 * the SAME connections at HEAD - `byo-runtime.ts` symbol `DEFAULT_ENDPOINT_URL`
 * is the corporate proxy host behind a HIDDEN field, so every BYO card submits
 * that channel unless a foreign URL was already stored. The four readings are in
 * `upstream-target.ts`'s DA2.1 section; this module does not repeat them.
 *
 * ---------------------------------------------------------------------------
 * The reference (read 2026-09-14 and re-read 2026-09-17 at nessy-cli `9d94ec5d4`;
 * evidence, not authority)
 * ---------------------------------------------------------------------------
 *
 * `packages/core/src/config/config.ts` symbol `isMcpServerAllowedForModel`:
 * a server passes when `contentGeneratorConfig.internal === true` OR its name is
 * in `packages/core/src/core/openaiContentGenerator/constants.ts` symbol
 * `EXTERNAL_MODEL_MCP_WHITELIST`. Two properties of that rule are easy to read
 * backwards and are therefore written out here:
 *
 * 1. **It is an ALLOW list, not a deny list.** For a non-internal model the
 *    whitelisted names are the ONLY servers that survive - a user's own MCP
 *    server, a project one and a plugin one are all withheld, not just the
 *    corporate ones. That is the posture this host now has too.
 * 2. **It judges the NAME.** There is no identity, no argv and no transport in
 *    it. Ours keys on the WIRE name for the same reason: that is the only
 *    identity the pool's desired map has at the moment the filter runs.
 *
 * Consequence (2) carries, stated rather than discovered later: a user who
 * configures their OWN server under a whitelisted wire name keeps it on an
 * external model, because the built-in fold stands down on a taken name
 * (`mergeBuiltinDpMcpServers`) and the surviving server under that name is
 * theirs. The reference has the identical property. It is recorded, not fixed:
 * an identity check here would judge a server the pool has already merged, and
 * the honest place for one is the fold, which is a separate row if the owner
 * ever wants it.
 *
 * ---------------------------------------------------------------------------
 * The seed is SEVEN of the reference's eight, and the eighth is not an omission
 * ---------------------------------------------------------------------------
 *
 * The donor's set is `dpJira`, `dpGitlab`, `dpWiki`, `t-tracker`, `dpFinedog`,
 * `dpSage`, `dpAllure`, `context7`. Seven of those are entries of
 * `BUILTIN_DP_MCP_SERVERS`; `context7` is the fourth entry of
 * `BUILTIN_DP_MCP_EXCLUSIONS` - "an npx server, not a dp one ... it already
 * installs through the marketplace" - so seeding at eight would mint here a name
 * this repo deliberately does not ship, and the relation is pinned by this
 * module's test against those two constants rather than asserted in prose.
 *
 * A name is a name, though: if a user installs `context7` from the marketplace
 * under that wire name it is NOT on this list and is withheld from an external
 * model. That asymmetry with the donor is the cost of not shipping it, and it is
 * the owner's to revisit.
 *
 * ---------------------------------------------------------------------------
 * What this does NOT reach
 * ---------------------------------------------------------------------------
 *
 * `mcp__session__*` is not pool-served - it is the in-process session tool
 * surface - so no pool filter can withhold it. That residue belongs to
 * ODR-1/DA2.4 and is named in DA2.2's own row; nothing here should be read as
 * covering it.
 */

import { modelTargetOperatorLog, type ModelTargetVerdict } from './upstream-target.ts';

/**
 * Wire names an external model target may still be handed.
 *
 * Seeded from the reference (see the module note) minus `context7`. A
 * `ReadonlySet` rather than an array for the donor's reason: every use is a
 * membership test, and the type has no `add`.
 */
export const EXTERNAL_MODEL_MCP_WHITELIST: ReadonlySet<string> = new Set([
  'dpJira',
  'dpGitlab',
  'dpWiki',
  't-tracker',
  'dpFinedog',
  'dpSage',
  'dpAllure',
]);

/**
 * Does this target withhold anything at all?
 *
 * `restricted` is the classifier's own summary - true for `external-vendor` and
 * for `unclassified`, false for the gateway, loopback, a `tgpt/` namespace and a
 * connection with no endpoint. Reading the FLAG rather than the class keeps ONE
 * axis: a class added to that module lands on whichever side its author put it,
 * instead of silently falling through a list written here.
 *
 * **`unclassified` is INCLUDED, and that is a product posture rather than a
 * detail - it is the sub-decision DA2.14 did not spell, so here is the
 * measurement behind it.** The owner's sentence says "when `classifyModelTarget`
 * says external", and reading that as `class === 'external-vendor'` alone was
 * considered and refused, because `unclassified` is where an UNPREFIXED model id
 * lands - and an unprefixed id at a vendor host is the common case, not the odd
 * one: `https://api.openai.com/v1` serving `gpt-4o` classifies `unclassified`,
 * exactly as a direct `api.anthropic.com` connection serving
 * `claude-sonnet-4-5-…` does. A class-only rule would leave both of those
 * holding every MCP server, at the vendor, which is the leak the policy exists
 * to stop. It also matches the reference, whose `isInternalModel` is a PREFIX
 * test, so an unprefixed id is non-internal there too and is blocked.
 *
 * The cost, stated because someone will meet it: a self-hosted corporate
 * endpoint that is neither loopback nor the gateway and serves unprefixed ids is
 * withheld from as well, a false positive. It is VISIBLE (DA2.6's disclosure
 * fires on the same flag and has since it shipped) and it is fixable without
 * touching this module - add the host or the namespace to the classifier's
 * vocabulary, which is what that vocabulary is for.
 *
 * An ABSENT verdict withholds nothing. That is the backend-construction path
 * having classified nothing - a backend built outside
 * `createBackendFromResolvedContext`, which in this tree is tests and the
 * `codex-agent-server` eval runner - and it is deliberately fail-OPEN, because
 * the alternative (withhold on "I do not know") would empty the tool set of
 * every such construction with no user-visible reason.
 */
export function modelTargetWithholdsMcpServers(verdict: ModelTargetVerdict | undefined): boolean {
  return verdict?.restricted === true;
}

/**
 * The donor's `isMcpServerAllowedForModel`, with the verdict passed in rather
 * than read off a singleton.
 *
 * Pure and synchronous: it runs once per server per materialization, on the
 * turn path, so it may not read a file, a setting or the environment.
 */
export function isMcpServerAllowedForModelTarget(
  wireName: string,
  verdict: ModelTargetVerdict | undefined,
): boolean {
  if (!modelTargetWithholdsMcpServers(verdict)) return true;
  return EXTERNAL_MODEL_MCP_WHITELIST.has(wireName);
}

/**
 * Split a desired wire-name set into what this target keeps and what it loses.
 *
 * The withheld half is what the operator's `debug` line and the user-facing
 * "N servers withheld" disclosure both count, so both read ONE computation
 * instead of two that can disagree. Sorted, so a log line and a test are stable.
 */
export function partitionMcpServersForModelTarget(
  wireNames: Iterable<string>,
  verdict: ModelTargetVerdict | undefined,
): { allowed: string[]; withheld: string[] } {
  const allowed: string[] = [];
  const withheld: string[] = [];
  for (const wireName of wireNames) {
    if (isMcpServerAllowedForModelTarget(wireName, verdict)) allowed.push(wireName);
    else withheld.push(wireName);
  }
  return { allowed: allowed.sort(), withheld: withheld.sort() };
}

/**
 * F1.143 (origin SIT-10, P-SIT10-6) - the withholding RECEIPT, on a channel a
 * packaged build carries.
 *
 * ## The defect, measured on the artefact
 *
 * The line this function writes used to be a bare call to the pool's `debug`
 * option. On the session path that option is `message => this.debug(message)`
 * (`BaseAgent.setSourceServers`), `BaseAgent.debug` forwards to
 * `config.onDebug`, and `SessionManager` binds that to `sessionLog` - which is
 * `platform.logger` scoped, and `apps/electron/src/main/logger.ts` disables both
 * of its transports outside debug mode. So in the builds the receipt exists for
 * it was written nowhere. SIT-10 read a full `NESSY_DEBUG=1` run of dmg #4 and
 * found ZERO pool lines beside that run's own `[PERF]` lines, and recorded
 * D1.425 NOT DRIVABLE for exactly this reason: an egress control with no live
 * instrument cannot be audited on the artefact at all.
 *
 * ## The fix, and why it ADDS rather than MOVES
 *
 * The receipt now also goes to {@link modelTargetOperatorLog} - `createLogger`,
 * stderr under `NESSY_DEBUG=1`, the sink `main/logger.ts`'s own comment names as
 * the one that survives. The `debug` call stays: it is what `electron:dev`, the
 * headless host and this module's tests read, and removing it would trade one
 * silent audience for another. Two copies in a dev build is the named cost.
 *
 * It returns the receipt so a caller can assert on the exact bytes rather than
 * rebuild the string, which is how a test and a log line drift apart.
 */
export function recordExternalModelMcpWithholding(
  verdict: ModelTargetVerdict | undefined,
  withheld: readonly string[],
  debug: (message: string) => void,
): string {
  const receipt = `external_model_mcp.withheld:${verdict?.class ?? 'unknown'}: ${withheld.join(', ')}`;
  debug(receipt);
  modelTargetOperatorLog.warn(receipt);
  return receipt;
}
