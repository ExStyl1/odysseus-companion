/**
 * P6.424 — the durable half of the suggestion limits.
 *
 * `plugin-relevance.md` § What the user sees: "A given plugin's suggestion
 * appears at most once every three sessions" and "stops appearing after the
 * suggestion has been shown twice". Both limits are BETWEEN sessions, so what is
 * pinned here is that they survive a process — a counter that restarts at zero
 * on every launch hands every plugin an unlimited supply of re-shows.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimPluginSuggestionSession,
  readPluginSuggestionState,
  recordPluginSuggestionShown,
} from '../plugin-suggestion-store.ts';

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'nessy-plugin-suggestion-')), 'plugin-suggestions.json');
}

describe('plugin suggestion store', () => {
  it('starts empty and claims one ordinal per session, durably', async () => {
    const path = statePath();
    expect(await readPluginSuggestionState(path)).toEqual({ sessionOrdinal: 0, shown: {} });
    expect((await claimPluginSuggestionSession(path)).sessionOrdinal).toBe(1);
    expect((await claimPluginSuggestionSession(path)).sessionOrdinal).toBe(2);
    // The read is what a fresh process would do: the count is on disk.
    expect((await readPluginSuggestionState(path)).sessionOrdinal).toBe(2);
  });

  it('records a show so both documented limits can be evaluated', async () => {
    const path = statePath();
    await claimPluginSuggestionSession(path);
    await recordPluginSuggestionShown(path, 'terraform-helpers@acme', 1);
    await recordPluginSuggestionShown(path, 'terraform-helpers@acme', 4);
    const state = await readPluginSuggestionState(path);
    expect(state.shown['terraform-helpers@acme']).toEqual({ shownCount: 2, lastShownSession: 4 });
    // The ordinal is never lowered by a record written from an older session.
    expect(state.sessionOrdinal).toBe(4);
  });

  /**
   * The boundary: a hand-edited or truncated file must not take a session start
   * down, and must not smuggle a value the limits cannot reason about. A
   * negative `lastShownSession` would put the cooldown permanently out of reach.
   */
  it('treats a corrupt file, a bad entry and a negative ordinal as no record', async () => {
    const path = statePath();
    writeFileSync(path, '{ this is not json');
    expect(await readPluginSuggestionState(path)).toEqual({ sessionOrdinal: 0, shown: {} });

    writeFileSync(path, JSON.stringify({
      sessionOrdinal: -7,
      shown: { good: { shownCount: 1, lastShownSession: -3 }, bad: { shownCount: 'x' }, worse: null },
    }));
    const state = await readPluginSuggestionState(path);
    expect(state.sessionOrdinal).toBe(0);
    expect(state.shown).toEqual({ good: { shownCount: 1, lastShownSession: 0 } });
  });
});
