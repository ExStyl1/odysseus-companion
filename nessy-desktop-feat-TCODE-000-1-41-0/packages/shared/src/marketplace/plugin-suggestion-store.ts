/**
 * The durable half of the plugin-suggestion decision (P6.424).
 *
 * `selectPluginSuggestion` takes `sessionOrdinal` and `shown` and deliberately
 * decides nothing about where they live — "both already have owners; a second
 * copy of either is a second thing to keep in step". This is that owner, and it
 * exists because the two documented limits are BETWEEN sessions and cannot hold
 * in memory:
 *
 *   "A given plugin's suggestion appears at most once every three sessions."
 *   "The session-start notification additionally stops appearing after the
 *   suggestion has been shown twice."
 *   — `plugin-relevance.md` § What the user sees
 *
 * A process-local counter would restart at zero on every app launch, so a user
 * who quits and reopens would meet the same suggestion again, forever. That is
 * the exact nag the two limits exist to prevent, so the record is a file.
 *
 * Deliberately tiny and deliberately tolerant. Every operation degrades to "no
 * record" rather than throwing: this file backs a SUGGESTION, and a suggestion
 * that can fail a session start is worse than one that is occasionally repeated.
 */

import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../plugins/marketplace-registry-store.ts';
import type { PluginSuggestionShownRecord } from './plugin-suggestion.ts';

/** What the file holds. Both fields are what `selectPluginSuggestion` reads. */
export interface PluginSuggestionStateV1 {
  /**
   * A monotonically increasing count of sessions started on this machine. The
   * page's limit is "once every three sessions", which needs an ordinal, not a
   * clock — a machine that is idle for a week must not thereby earn a re-show.
   */
  readonly sessionOrdinal: number;
  /** Per-plugin shown records, keyed by `<pluginName>@<marketplaceName>`. */
  readonly shown: Readonly<Record<string, PluginSuggestionShownRecord>>;
}

const EMPTY: PluginSuggestionStateV1 = Object.freeze({ sessionOrdinal: 0, shown: Object.freeze({}) });

/**
 * Read the record, or the empty one.
 *
 * A missing file is the first run. A corrupt file is treated identically and NOT
 * repaired: rewriting it here would mean a read path that writes, and the only
 * thing lost is how often a plugin has been suggested.
 */
export async function readPluginSuggestionState(filePath: string): Promise<PluginSuggestionStateV1> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as Partial<PluginSuggestionStateV1>;
    const ordinal = typeof parsed.sessionOrdinal === 'number' && Number.isFinite(parsed.sessionOrdinal)
      ? Math.max(0, Math.floor(parsed.sessionOrdinal))
      : 0;
    const shown: Record<string, PluginSuggestionShownRecord> = {};
    for (const [key, value] of Object.entries(parsed.shown ?? {})) {
      // A hand-edited or truncated entry is dropped rather than trusted: a
      // negative `lastShownSession` would make the cooldown unreachable.
      if (!value || typeof value !== 'object') continue;
      const record = value as Partial<PluginSuggestionShownRecord>;
      if (typeof record.shownCount !== 'number' || typeof record.lastShownSession !== 'number') continue;
      if (!Number.isFinite(record.shownCount) || !Number.isFinite(record.lastShownSession)) continue;
      shown[key] = {
        shownCount: Math.max(0, Math.floor(record.shownCount)),
        lastShownSession: Math.max(0, Math.floor(record.lastShownSession)),
      };
    }
    return { sessionOrdinal: ordinal, shown };
  } catch {
    return EMPTY;
  }
}

/**
 * Claim the next session ordinal and return the state a session decides against.
 *
 * The increment happens ONCE per session, at the moment a session first asks
 * whether it has a suggestion to make — not per turn, which would make "once
 * every three sessions" mean "every third message".
 */
export async function claimPluginSuggestionSession(
  filePath: string,
): Promise<PluginSuggestionStateV1> {
  const state = await readPluginSuggestionState(filePath);
  const next: PluginSuggestionStateV1 = { sessionOrdinal: state.sessionOrdinal + 1, shown: state.shown };
  await persist(filePath, next);
  return next;
}

/**
 * Record that one plugin's suggestion was shown in the session with this
 * ordinal. Both documented limits read exactly these two numbers.
 */
export async function recordPluginSuggestionShown(
  filePath: string,
  reference: string,
  sessionOrdinal: number,
): Promise<void> {
  const state = await readPluginSuggestionState(filePath);
  const previous = state.shown[reference];
  await persist(filePath, {
    // Never lower the ordinal: a concurrent claim may already have raised it,
    // and losing it would hand every plugin a free re-show.
    sessionOrdinal: Math.max(state.sessionOrdinal, sessionOrdinal),
    shown: {
      ...state.shown,
      [reference]: {
        shownCount: (previous?.shownCount ?? 0) + 1,
        lastShownSession: sessionOrdinal,
      },
    },
  });
}

/** Writes never throw at the caller, for the reason the header gives. */
async function persist(filePath: string, state: PluginSuggestionStateV1): Promise<void> {
  try {
    await writeJsonAtomic(filePath, state);
  } catch {
    // A read-only config directory loses the record, not the session.
  }
}
