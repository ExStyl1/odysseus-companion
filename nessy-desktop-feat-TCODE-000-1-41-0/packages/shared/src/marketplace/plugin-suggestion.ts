/**
 * The one host-side decision behind all three plugin-suggestion surfaces.
 *
 * Contract: `plugin-relevance.md` § How it works and § What the user sees,
 * fetched 2026-09-06. The page puts a matched suggestion in three places:
 *
 *   "**Spinner tip**: a "Working with *topic*? Install the *plugin* plugin"
 *   message with the `/plugin install` command appears below the spinner while
 *   Claude is responding."
 *   "**Session-start suggestion**: if the `cwd` signal matches the working
 *   directory, a one-line `plugin suggestion: <name>@<marketplace> · /plugin`
 *   notification appears before the first turn."
 *   "**`/plugin` Discover tab**: the plugin is pinned to the top of the Discover
 *   list with an annotation such as "suggested for this directory"".
 *
 * WHY THIS IS ONE MODULE (P6.424). The Discover pin exists already and the other
 * two do not, which is how the three would drift. Relevance is host-side — the
 * vendor's spinner-tips system lives in a closed binary and has no analogue on
 * any of the three runtimes — so the host is the seam, and the seam is only
 * honest if it is ONE decision that every surface renders. This module makes the
 * decision; it renders nothing and localises nothing, so the surfaces stay free
 * to phrase it in the user's own language.
 *
 * NOT DECIDED HERE, deliberately: which plugins are candidates (the caller
 * applies the `pluginSuggestionMarketplaces` allowlist, exactly as the Discover
 * pin already does), and where the shown-record is persisted. Both already have
 * owners; a second copy of either is a second thing to keep in step.
 */

import {
  matchRelevanceSignal,
  type PluginMarketplaceRelevanceV1,
  type PluginRelevanceSignalKind,
  type RelevanceMatchContext,
} from './relevance.ts';

/** "A given plugin's suggestion appears at most once every three sessions". */
const SUGGESTION_SESSION_COOLDOWN = 3;
/**
 * "The session-start notification additionally stops appearing after the
 * suggestion has been shown twice."
 */
const SESSION_START_MAX_SHOWS = 2;

/** One allowlisted, matchable row, as the caller already has it. */
export interface PluginSuggestionCandidate {
  readonly pluginName: string;
  readonly marketplaceName: string;
  readonly relevance?: PluginMarketplaceRelevanceV1;
  /** "neither repeats once the plugin is installed". */
  readonly installed?: boolean;
}

/** What the caller persists per plugin so the documented limits can hold. */
export interface PluginSuggestionShownRecord {
  /** Times shown across the spinner tip and the session-start notice combined. */
  readonly shownCount: number;
  /** The session counter's value the last time this plugin was suggested. */
  readonly lastShownSession: number;
}

export interface PluginSuggestionContext extends RelevanceMatchContext {
  /**
   * A monotonically increasing count of sessions started on this machine. The
   * page's limit is "once every three sessions", which needs an ordinal and not
   * a clock; the caller owns it.
   */
  readonly sessionOrdinal: number;
  /** Per-plugin shown records, keyed by `<pluginName>@<marketplaceName>`. */
  readonly shown?: Readonly<Record<string, PluginSuggestionShownRecord>>;
  /**
   * `spinnerTipsEnabled` / `spinnerTipsOverride`, already resolved across the
   * settings files by the caller. "Claude Code disables both when
   * `spinnerTipsEnabled` resolves to `false`". Undefined means unset, which the
   * page treats as enabled. The Discover pin does NOT consult this — "The
   * Discover-tab pin is independent of tip settings."
   */
  readonly spinnerTipsEnabled?: boolean;
}

export interface PluginSuggestion {
  readonly pluginName: string;
  readonly marketplaceName: string;
  /** `<name>@<marketplace>`, the id both surfaces print. */
  readonly reference: string;
  /** The `/plugin install` line the spinner tip carries. */
  readonly installCommand: string;
  /** The phrase that fills "Working with *topic*?"; never used by the notice. */
  readonly topic: string;
  /** Which signal matched, so a surface can name it. */
  readonly signal: PluginRelevanceSignalKind;
  /** Below-the-spinner tip while the agent is responding. */
  readonly spinnerTip: boolean;
  /** One-line notice before the first turn. */
  readonly sessionStart: boolean;
}

/** `<pluginName>@<marketplaceName>` — the key of a shown record. */
export function pluginSuggestionKey(candidate: PluginSuggestionCandidate): string {
  return `${candidate.pluginName}@${candidate.marketplaceName}`;
}

/**
 * The first candidate this session may suggest, or undefined.
 *
 * Candidate order is the caller's — the Discover list's own order — so the tip
 * and the pin agree on which plugin they are talking about.
 */
export function selectPluginSuggestion(
  candidates: readonly PluginSuggestionCandidate[],
  context: PluginSuggestionContext,
): PluginSuggestion | undefined {
  // "Claude Code disables both when `spinnerTipsEnabled` resolves to `false`" —
  // both surfaces this function decides are part of the spinner-tips system.
  if (context.spinnerTipsEnabled === false) return undefined;

  for (const candidate of candidates) {
    if (candidate.installed) continue;
    const signal = matchRelevanceSignal(candidate.relevance, context);
    if (!signal) continue;

    const record = context.shown?.[pluginSuggestionKey(candidate)];
    if (record && context.sessionOrdinal - record.lastShownSession < SUGGESTION_SESSION_COOLDOWN) {
      continue;
    }
    const reference = pluginSuggestionKey(candidate);
    return Object.freeze({
      pluginName: candidate.pluginName,
      marketplaceName: candidate.marketplaceName,
      reference,
      installCommand: `/plugin install ${reference}`,
      topic: candidate.relevance?.topic ?? defaultTopic(candidate.pluginName),
      signal,
      spinnerTip: true,
      // "if the `cwd` signal matches the working directory" — the notice fires
      // before the first turn, which is the only moment `cwd` can be the answer.
      sessionStart: signal === 'cwd' && (record?.shownCount ?? 0) < SESSION_START_MAX_SHOWS,
    });
  }
  return undefined;
}

/**
 * "Defaults to the plugin name with each hyphen segment capitalized."
 * `terraform-helpers` becomes `Terraform Helpers`.
 */
function defaultTopic(pluginName: string): string {
  return pluginName
    .split('-')
    .filter(segment => segment.length > 0)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}
