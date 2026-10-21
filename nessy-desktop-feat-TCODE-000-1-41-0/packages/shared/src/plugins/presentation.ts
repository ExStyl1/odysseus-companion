/**
 * Safe plugin presentation projector (A9).
 *
 * Derives the DISPLAY-ONLY `SafePluginPresentationOrigin` from a `PluginOrigin`
 * (+ its persisted adapter provenance). This is cosmetic metadata ONLY: no
 * path, URL, executable declaration or secret is ever read from or written
 * into it, and it must NEVER feed a resolver/trust/activation/credential
 * decision. Callers join the result by `pluginKey` into a user-facing
 * projection only (see `capabilities/views.ts` `toUserCatalog`); it is never
 * threaded through `toAgentRuntime`.
 */

import type { SafePluginPresentationOrigin } from '../protocol/capabilities.ts';
import type { PluginOrigin } from './types.ts';

const INTERNAL_MARKETPLACE_ID = 'skills-market';

/**
 * Adapter ids that persist onto `PluginOrigin.adapterId` at install/repair
 * time (see `acquisition.ts` `finalizeNormalizedInstall`). Format is
 * derived ONLY from this persisted provenance — never from a marketplace
 * label, extension/capability kind or display install command.
 */
function formatFromAdapterId(adapterId: string | undefined): SafePluginPresentationOrigin['format'] {
  if (adapterId === 'codex-plugin-json') return 'codex';
  if (adapterId === 'claude-plugin-json') return 'claude';
  if (adapterId === 'nessy-plugin-json' || adapterId === 'nessy-extension-json') return 'nessy';
  return 'unknown';
}

function acquisitionFromOrigin(origin: PluginOrigin): SafePluginPresentationOrigin['acquisition'] {
  switch (origin.source) {
    case 'marketplace':
      return origin.marketplaceId === INTERNAL_MARKETPLACE_ID ? 'nessy-marketplace' : 'external-marketplace';
    case 'repository':
      return 'repository';
    case 'local-path':
    // A skills-directory plugin is "discovered in place rather than copied into
    // the plugin cache" (`plugins-reference.md` § Skills-directory plugins) —
    // a local folder, so it presents as one. It gets no acquisition value of its
    // own: `SafePluginPresentationOrigin.acquisition` is a wire enum, and a new
    // member there is a protocol change for a distinction the user does not
    // need. Falling through to `'unknown'` instead would show a plugin that
    // plainly came from a local directory as having no known provenance.
    case 'skills-dir':
      return 'local';
    case 'url':
      return 'url';
    case 'agent-proposed':
      // The wrapped source (never the "agent-proposed" wrapper itself) is
      // what the plugin was actually acquired from; PluginOrigin already
      // flattens this at resolution time (see `source-resolver.ts`
      // `originForSource`'s `agent-proposed` case), so `origin.source` here
      // is already the underlying kind unless resolution left it unresolved.
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Project one installed plugin's `PluginOrigin` to its safe presentation.
 * Format comes only from the persisted adapter id; acquisition comes only
 * from the origin's source kind + marketplace identity.
 */
export function toSafePluginPresentationOrigin(origin: PluginOrigin): SafePluginPresentationOrigin {
  return {
    format: formatFromAdapterId(origin.adapterId),
    acquisition: acquisitionFromOrigin(origin),
  };
}

/**
 * Pre-inspection catalog-row presentation (A9): acquisition is known from the
 * listing's own marketplace identity, but the bundle has not been fetched or
 * adapter-detected yet, so format MUST stay `'unknown'` (generic package
 * icon) rather than being guessed from the listing's kind/label.
 */
export function toSafePluginPresentationForCatalogListing(
  acquisition: SafePluginPresentationOrigin['acquisition'],
): SafePluginPresentationOrigin {
  return { format: 'unknown', acquisition };
}
