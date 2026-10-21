/**
 * The HTTP headers a marketplace ENTRY declares for its own archive download,
 * and the one filter every one of them passes through.
 *
 * `plugins/host-marketplace.md#authenticate-archive-downloads`, the **Archive authentication
 * fields:** table (fetched 2026-08-28,
 * `https://code.claude.com/docs/en/plugin-marketplaces.md`):
 *
 *   `headers` — "HTTP headers Claude Code sends when it downloads this entry's
 *   archive. Overrides the marketplace's headers of the same name. Requires
 *   Claude Code v2.1.238 or later."
 *
 * and `#authenticate-archive-downloads` names the failure this closes verbatim:
 *
 *   "Before v2.1.238, Claude Code downloaded an entry's archive without its
 *   `headers` or `headersHelper`, so an install that relied on them failed with
 *   `HTTP 401 while downloading plugin archive from`, followed by the URL, with
 *   the registry's status code in place of 401."
 *
 * **THE BUNDLE CAUGHT UP HALFWAY, AND THE HALF THAT MATTERS HERE DID NOT.**
 *
 * This paragraph used to read "the vendored bundle has none of this and cannot
 * be configured into having it", measured on 0.3.223 / Claude Code 2.1.223,
 * whose plugin-source union was `{ relative path, npm, url, github, git-subdir,
 * unsupported }` with no `archive` member at all. S0-3 lifted the bundle to
 * 0.3.233 / 2.1.233 (2026-09-03) and re-measured. What changed:
 *
 *  - `archive` IS a marketplace-entry source now, with `url` and `sha256`
 *    ("64-character hex SHA-256 digest"), and the binary downloads it itself:
 *    the union is `["npm","url","github","git-subdir","archive","command",
 *    "unsupported"]`, the dispatch is `case"archive": await …(e,o,t?.archiveAuth,
 *    …)`, and the diagnostic `HTTP ${o} while downloading plugin archive from`
 *    is present verbatim. `archiveAuth` scores 0 at 2.1.223 and 5 at 2.1.233.
 *  - `command` is a second NEW source, and `disableCommandPluginSources` — the
 *    managed control this file's last paragraph said we would need — went from
 *    0 occurrences to 14, inside the restrictive-only managed filter's own copy
 *    list (pinned in `claude-managed-settings.test.ts`).
 *
 * **That clause HAS now changed, and the file stays for the other reason
 * (P7.1/P7.16, re-measured 2026-09-11 at the vendored `0.3.247`).** This
 * paragraph read: *"the entry `archive` arm at 2.1.233 declares `url` and
 * `sha256` and NOTHING ELSE. No `headers`, no `headersHelper`. Entry-level
 * archive headers are a v2.1.238 field and we ship 2.1.233 — five patch versions
 * short"* — and that was the AGENTS.md union rule in its documented direction,
 * the page being the denominator for what we must ACCEPT while the bundle lagged.
 * The bundle has caught up: `sdk.d.ts` now declares `headers?: {[k:string]:
 * string}` and `headersHelper?: string` on the marketplace entry beside `url`
 * and `sha256` (`headersHelper` scores 10 in `sdk.d.ts`, 18 in `sdk.mjs` and 181
 * in the native binary, control `nessyNotARealSdkKey` → 0), with the vendor's own
 * gloss confirming the inheritance rule quoted further down.
 *
 * **The verdict does not move, because it never rested on the lag.** It rests on
 * the native-first step (2) below: the host already supplies this uniformly for
 * all three runtimes, and the SDK's archive installer is not reachable on this
 * fork's path at all. What the catch-up changes is the SHAPE of the residue —
 * an operator's entry-level `headers` is now a field the vendor would honour in
 * its own installer too, so the two implementations agree by construction rather
 * than by luck, and a plugin published for either is installable by both.
 *
 * And native-first (AGENTS.md) was re-asked in full, not assumed: step (1), does
 * the runtime have its own mechanism — yes, now. Step (2), can the host supply
 * it uniformly for all three — yes, and it already does. Routing the download
 * through the SDK would be a REGRESSION from (2) to a per-runtime (3): the SDK's
 * archive installer is reachable only through `Settings.extraKnownMarketplaces`
 * into the CLI's own plugin cache, `claude-agent.ts` passes `plugins: []` on
 * purpose, and Pi and codex would keep the host path regardless — so the host
 * would own the seam for two runtimes and the SDK for one, which is the switch
 * divergence native-first exists to prevent. The host fetch stays.
 *
 * The one duplication worth naming is not a duplication: the digest check the
 * SDK now advertises has been in the host path since `654aa4113` (2026-08-22),
 * six days BEFORE the credential work in this file — `resolveClaudeArchiveSource`
 * validates `sha256` as 64 hex, normalises it to `sha256-<lowercase>`, and
 * `acquisition.ts:fetchArchiveUrlArtifact` refuses the install on mismatch — and
 * the digest-as-version rule the SDK's new field describes is
 * `registry-catalog-items.ts:archiveDigestVersion`. There was nothing to retire.
 *
 * SCOPE, stated rather than implied, and NARROWED by P3.220 rather than closed.
 * This file is the ENTRY half. The marketplace `url` source's own `headers` are
 * now carried too, on the fetch `#authenticate-archive-downloads` names first —
 * "Before each fetch of the marketplace's `marketplace.json`" — through
 * `managed-marketplace-entries.ts` and `registry-catalog-fetcher.ts`, sharing
 * this file's name filter (`request-header-filter.ts`).
 *
 * The SECOND clause of the same sentence — "and before each archive download on
 * that origin" — was the other half, and P6.177 closed it: a marketplace's own
 * headers now reach an entry's archive download when that download is on the
 * marketplace URL's origin ("the same scheme, host, and port"), in
 * `marketplace/external-catalog-adapters.ts:applyEntryArchiveHeaders`, which is
 * the only place that knows an entry's RESOLVED archive URL. The precedence is
 * the page's — "Where both places set a header of the same name, Claude Code
 * sends the entry's value" — so this file's headers still win by name, and an
 * off-origin archive gets none and says so rather than 401ing.
 *
 * THE `headersHelper` COMMAND — the posture is now DECIDED, and this file keeps
 * the half that never runs one (P6.479, owner decision 2026-09-05 Q7, option C).
 *
 * The paragraph here used to say the command was unimplemented on "either
 * place" and that it was a host question. The question was put and answered:
 *
 *  - **A marketplace that MANAGED settings themselves declare** may mint its
 *    credential through a `headersHelper`. That is the operator's own tier —
 *    the command is written by the administrator who already controls the
 *    machine's settings file, and `plugin-marketplaces.md`
 *    #when-claude-code-skips-a-headershelper-command-or-drops-its-output makes
 *    it the one tier that survives every block: "Under either block, Claude
 *    Code still runs the command for a marketplace that managed settings
 *    themselves declare."
 *  - **Every other tier still refuses**, which is what this file implements. An
 *    entry's `headersHelper` in a published `marketplace.json` is
 *    CATALOG-declared: it is written by whoever publishes the catalog, not by
 *    the operator, and the page's own gate for it is a per-install acceptance
 *    dialog — "Claude Code shows you the command and the archive URL, and
 *    downloads the zip after you accept", repeated "each time they install or
 *    update that one plugin by itself". Option B (execute in both places) was
 *    DECLINED, so that dialog is not built and the entry tier does not execute,
 *    ever. Option A stays correct for every tier but the managed one.
 *
 * So {@link marketplaceEntryHeadersHelperDiagnostic} is not a placeholder
 * waiting for a feature; it is the permanent shape of the entry tier, and its
 * text now names the tier that IS the exception so a private-registry operator
 * reads where to put the command instead of concluding the app cannot do it.
 */
import { pluginDiagnostic } from './schema.ts';
import { filterDeclaredRequestHeaders } from './request-header-filter.ts';
import type { PluginDiagnostic } from './types.ts';

/**
 * The routing/identity name filter lives in `request-header-filter.ts`: the same
 * rule governs the marketplace `url` source's `headers`
 * (`settings-reference.md#extraknownmarketplaces`), and two copies of a
 * credential filter is one copy too many.
 */

export interface ParsedArchiveHeaders {
  headers?: Record<string, string>;
  diagnostics: PluginDiagnostic[];
}

/**
 * Parse and filter a marketplace entry's `headers` object.
 *
 * Every refusal is a WARNING, never an error: a malformed or filtered header
 * must not delete the entry from the catalog — the install simply proceeds
 * without that header and says which one it dropped, so a later 401 has a
 * written cause instead of being a mystery.
 */
export function parseMarketplaceEntryHeaders(
  value: unknown,
  context: { pluginName: string },
): ParsedArchiveHeaders {
  const diagnostics: PluginDiagnostic[] = [];
  if (value === undefined || value === null) return { diagnostics };
  if (typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'marketplace.catalog.entry_headers_invalid',
      `Catalog entry "${context.pluginName}" declares "headers" that is not an object; no headers are sent with its archive download.`,
      'headers',
      { pluginName: context.pluginName },
    ));
    return { diagnostics };
  }

  const filtered = filterDeclaredRequestHeaders(value)!;
  const { headers, dropped, malformed } = filtered;

  if (malformed.length) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'marketplace.catalog.entry_header_value_invalid',
      `Catalog entry "${context.pluginName}" declares headers whose values are not strings: ${malformed.join(', ')}.`,
      'headers',
      { pluginName: context.pluginName, headerNames: malformed },
    ));
  }
  if (dropped.length) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'marketplace.catalog.entry_header_dropped',
      `Catalog entry "${context.pluginName}" declares request-routing or client-identity headers, which are dropped: ${dropped.join(', ')}.`,
      'headers',
      { pluginName: context.pluginName, headerNames: dropped },
    ));
  }

  // NEVER log or echo a header VALUE — only its name. The whole point of the
  // field is that it carries a credential.
  return {
    ...(headers ? { headers } : {}),
    diagnostics,
  };
}

/**
 * The entry-tier `headersHelper` refusal. Named out loud at PARSE time rather
 * than at the 401, because the page's own account of the failure is that the
 * download simply goes out unauthenticated and the registry's status code is the
 * only evidence.
 *
 * P6.479 — the message now names the tier that IS executed. A refusal that only
 * says "this app does not run it" leaves a private-registry operator to conclude
 * the app cannot authenticate an archive download at all, when the answer is
 * that the command belongs one level up, in the marketplace their managed
 * settings declare. Stating the remedy is the difference between a refusal and
 * a dead end.
 *
 * The command TEXT is never echoed: it is written by whoever published the
 * catalog, and repeating it in a diagnostic is how a refusal becomes a delivery
 * mechanism for a string the user never chose to read.
 */
export function marketplaceEntryHeadersHelperDiagnostic(
  value: unknown,
  context: { pluginName: string },
): PluginDiagnostic | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return pluginDiagnostic(
    'warning',
    'marketplace.catalog.entry_headers_helper_unsupported',
    `Catalog entry "${context.pluginName}" declares a "headersHelper" command. `
    + 'This app never runs a command a published catalog declares, so the entry\'s archive download '
    + 'is sent with only the headers listed in "headers". '
    + 'A rotating credential belongs on the marketplace itself, in a marketplace your managed settings declare, '
    + 'where its "headersHelper" is run.',
    'headersHelper',
    { pluginName: context.pluginName },
  );
}
