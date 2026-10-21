/**
 * `model-config.md:364` — "Chains are capped at three models after duplicate
 * removal, and extra entries are ignored"; `:366` the flag "accepts a
 * comma-separated list"; `:373` the setting is an array; `:381` "The
 * `--fallback-model` flag takes precedence over the `fallbackModel` setting."
 */
import { describe, expect, it } from 'bun:test';

import {
  FALLBACK_MODEL_ENV_VAR,
  normalizeFallbackModelChain,
  resolveFallbackModelChain,
} from '../fallback-model-chain.ts';

describe('normalizeFallbackModelChain', () => {
  it.each([
    // The legacy scalar. `""` is on disk in every install that predates the
    // widening, and a single id stays a one-entry chain.
    ['', []],
    ['pi/one', ['pi/one']],
    ['  pi/one  ', ['pi/one']],
    // `:366`'s comma-separated flag value.
    ['pi/one,pi/two', ['pi/one', 'pi/two']],
    ['pi/one, pi/two ,, pi/three', ['pi/one', 'pi/two', 'pi/three']],
    // `:373`'s array form.
    [['pi/one', 'pi/two'], ['pi/one', 'pi/two']],
    [['pi/one', '', '  '], ['pi/one']],
    // Duplicate removal happens BEFORE the cap: the fourth distinct entry is
    // the one dropped, not the third.
    [['pi/one', 'pi/one', 'pi/two', 'pi/three', 'pi/four'], ['pi/one', 'pi/two', 'pi/three']],
    [['pi/one', 'pi/two', 'pi/three', 'pi/four'], ['pi/one', 'pi/two', 'pi/three']],
    ['pi/one,pi/one,pi/two,pi/three,pi/four', ['pi/one', 'pi/two', 'pi/three']],
    // Garbage of every shape disables fallback rather than throwing — this read
    // path runs on a user-editable file on every Pi turn.
    [undefined, []],
    [null, []],
    [42, []],
    [{ pi: 'one' }, []],
    [[1, 'pi/one', null], ['pi/one']],
  ] as const)('%p => %p', (raw, expected) => {
    expect(normalizeFallbackModelChain(raw)).toEqual([...expected]);
  });
});

describe('resolveFallbackModelChain', () => {
  it('lets the flag beat the setting, and falls back to the setting otherwise', () => {
    expect(resolveFallbackModelChain(['pi/set'], { [FALLBACK_MODEL_ENV_VAR]: 'pi/flag-a,pi/flag-b' }))
      .toEqual(['pi/flag-a', 'pi/flag-b']);
    expect(resolveFallbackModelChain(['pi/set'], {})).toEqual(['pi/set']);
  });

  it('does not let an empty flag value disable a configured chain', () => {
    // The negative case: `--fallback-model ""` is not a chain of zero entries,
    // it is an absent flag. Reading it as a chain would silently turn fallback
    // off for a user who configured one.
    expect(resolveFallbackModelChain(['pi/set'], { [FALLBACK_MODEL_ENV_VAR]: '  ,  ' }))
      .toEqual(['pi/set']);
  });
});
