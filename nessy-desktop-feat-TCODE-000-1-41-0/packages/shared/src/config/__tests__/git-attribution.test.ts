/**
 * P6.441 — the git-attribution precedence rule, driven directly.
 *
 * `resolveGitAttribution` is the one place the page's rule lives, and the rule
 * is not derivable from any single key:
 * `settings-reference.md#attribution`, verbatim — *"Once you set `commit` or
 * `pr`, Claude Code ignores the deprecated `includeCoAuthoredBy` setting and
 * uses its default text for whichever of the two you left unset."*
 *
 * Driven with an EXPLICIT `prefs` object rather than through the stored file,
 * so no verdict here depends on the developer's own `preferences.json` — and
 * with no `mock.module`, so this suite cannot amputate the preferences module
 * for a later file in the same process (AGENTS.md §Traps).
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_COMMIT_ATTRIBUTION,
  DEFAULT_PR_ATTRIBUTION,
  resolveGitAttribution,
  type UserPreferences,
} from '../preferences.ts';

const resolve = (prefs: UserPreferences, includeCoAuthoredBy?: boolean) =>
  resolveGitAttribution({ prefs, ...(includeCoAuthoredBy === undefined ? {} : { includeCoAuthoredBy }) });

describe('P6.441 — resolveGitAttribution', () => {
  test('POSITIVE: attribution OUTRANKS the deprecated key, and fills its own default for the half left unset', () => {
    // The page's rule in one assertion. `includeCoAuthoredBy: false` would
    // silence both texts on its own; setting `commit` makes it inert, and `pr`
    // — left unset — takes this fork's default rather than staying hidden.
    const resolved = resolve({
      includeCoAuthoredBy: false,
      attribution: { commit: 'Generated with AI\n\nCo-Authored-By: AI <ai@example.com>' },
    });
    expect(resolved.commitTrailer).toBe('Generated with AI\n\nCo-Authored-By: AI <ai@example.com>');
    expect(resolved.prText).toBe(DEFAULT_PR_ATTRIBUTION);
    // The two keys that are independent of the precedence rule keep their
    // documented defaults, so this case is not silently answering for them.
    expect(resolved.sessionUrl).toBe(true);
    expect(resolved.gitInstructions).toBe(true);
    expect(resolved.prUrlTemplate).toBeUndefined();
  });

  test('NEGATIVE: an EMPTY STRING hides, and is not the same value as unset', () => {
    // `settings-reference.md#attribution-commit`: "Set it to an empty string to
    // hide commit attribution." A truthiness test on these fields would discard
    // the one value an operator uses to turn a part off — which is why the
    // preference is an optional string rather than a defaulted one.
    const hidden = resolve({ attribution: { commit: '', pr: '' } });
    expect(hidden.commitTrailer).toBeUndefined();
    expect(hidden.prText).toBeUndefined();

    // UNSET is the other value, on the same rig: with the deprecated key on,
    // both take this fork's defaults.
    const unset = resolve({ includeCoAuthoredBy: true });
    expect(unset.commitTrailer).toBe(DEFAULT_COMMIT_ATTRIBUTION);
    expect(unset.prText).toBe(DEFAULT_PR_ATTRIBUTION);
  });

  test('the deprecated key still decides when the newer keys say nothing, in both directions', () => {
    // #576's fallback, and the explicit answer a caller can pin. Neither
    // direction may be lost: a pinned `false` must not be re-enabled by an
    // unset preference, and a pinned `true` must not be silenced by one.
    expect(resolve({}).commitTrailer).toBeUndefined();
    expect(resolve({ includeCoAuthoredBy: true }).commitTrailer).toBe(DEFAULT_COMMIT_ATTRIBUTION);
    expect(resolve({}, true).commitTrailer).toBe(DEFAULT_COMMIT_ATTRIBUTION);
    expect(resolve({ includeCoAuthoredBy: true }, false).commitTrailer).toBeUndefined();
    // …and the caller's answer is IGNORED once attribution decides, which is
    // the half a post-hoc override could not express.
    expect(resolve({ attribution: { commit: 'X' } }, false).commitTrailer).toBe('X');
  });

  test('the three non-text keys carry their documented defaults and their off values', () => {
    expect(resolve({}).sessionUrl).toBe(true);
    expect(resolve({ attribution: { sessionUrl: false } }).sessionUrl).toBe(false);
    expect(resolve({}).gitInstructions).toBe(true);
    expect(resolve({ includeGitInstructions: false }).gitInstructions).toBe(false);
    expect(resolve({ prUrlTemplate: '  ' }).prUrlTemplate).toBeUndefined();
    expect(resolve({ prUrlTemplate: 'https://r.example/{owner}/{repo}/pull/{number}' }).prUrlTemplate)
      .toBe('https://r.example/{owner}/{repo}/pull/{number}');
  });
});
