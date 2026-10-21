/**
 * P6.577 — `plugins/loading.md#how-claude-code-computes-the-version`, one case per step.
 *
 * The page makes the version the update signal — "Claude Code uses the plugin's
 * version as the cache key that determines whether an update is available …
 * skips the update if it matches what's already installed" — so every case here
 * is written as a DETECTION claim: two revisions of the same plugin must not
 * resolve to the same string unless the page says they should.
 */
import { describe, expect, it } from 'bun:test';
import {
  isPlaceholderPluginVersion,
  resolvePluginVersionChain,
  shortenArchiveDigest,
  UNKNOWN_PLUGIN_VERSION,
} from '../plugin-version-chain.ts';
import { UNDECLARED_PLUGIN_VERSION } from '../types.ts';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = `${'b'.repeat(63)}c`;
const SHA_A = '9f2c1de4b7a30516c8d9e0f1a2b3c4d5e6f70819';

describe('resolvePluginVersionChain', () => {
  it('step 1 — `plugin.json`\'s own version outranks everything below it', () => {
    expect(resolvePluginVersionChain({
      manifestVersion: '2.1.0',
      entryVersion: '1.0.0',
      commitSha: SHA_A,
      archiveDigest: DIGEST_A,
    })).toBe('2.1.0');
  });

  it('step 2 — the marketplace entry\'s version, when the manifest declares none', () => {
    expect(resolvePluginVersionChain({
      entryVersion: '1.4.2',
      commitSha: SHA_A,
      archiveDigest: DIGEST_A,
    })).toBe('1.4.2');
  });

  it('step 3 — the git commit SHA, and a new commit is therefore a new version', () => {
    // "Users get updates whenever the source's resolved commit changes."
    const first = resolvePluginVersionChain({ commitSha: SHA_A });
    const second = resolvePluginVersionChain({ commitSha: `${'0'.repeat(39)}1` });
    expect(first).toBe(SHA_A);
    expect(second).not.toBe(first);
    // A REF NAME is not a SHA: the step must not accept one, or every branch
    // install would pin to the string "main" for ever.
    expect(resolvePluginVersionChain({ commitSha: 'main' })).toBe(UNKNOWN_PLUGIN_VERSION);
  });

  it('step 4 — the archive digest, shortened to the first 12 characters', () => {
    // "The SHA-256 digest, for `archive` sources … Claude Code shortens it to
    // the first 12 characters."
    expect(resolvePluginVersionChain({ archiveDigest: DIGEST_A })).toBe('a'.repeat(12));
    expect(resolvePluginVersionChain({ archiveDigest: `sha256-${DIGEST_A}` })).toBe('a'.repeat(12));
    // "Without one, users get updates whenever the hosted zip file's bytes
    // change" — two different zips must not collapse onto one version.
    expect(resolvePluginVersionChain({ archiveDigest: DIGEST_B }))
      .not.toBe(resolvePluginVersionChain({ archiveDigest: DIGEST_A }));
  });

  it('step 5 — `unknown` when no step answers', () => {
    expect(resolvePluginVersionChain({})).toBe(UNKNOWN_PLUGIN_VERSION);
    expect(resolvePluginVersionChain({ archiveDigest: 'not-a-digest' })).toBe(UNKNOWN_PLUGIN_VERSION);
  });

  it('treats BOTH placeholders as "not set", so a floor never wins a step', () => {
    // The adapter writes `0.0.0` when a bundle declares nothing; feeding that
    // back in as step 1 would freeze the chain at the very value this row
    // exists to replace.
    expect(resolvePluginVersionChain({
      manifestVersion: UNDECLARED_PLUGIN_VERSION,
      archiveDigest: DIGEST_A,
    })).toBe('a'.repeat(12));
    expect(resolvePluginVersionChain({
      entryVersion: UNKNOWN_PLUGIN_VERSION,
      commitSha: SHA_A,
    })).toBe(SHA_A);
  });

  it('the page\'s order holds even where the two middle steps could both answer', () => {
    expect(resolvePluginVersionChain({ commitSha: SHA_A, archiveDigest: DIGEST_A })).toBe(SHA_A);
  });
});

describe('shortenArchiveDigest', () => {
  it('accepts the two spellings a digest reaches us in, and refuses the rest', () => {
    expect(shortenArchiveDigest(DIGEST_A)).toBe('a'.repeat(12));
    expect(shortenArchiveDigest(`sha256-${DIGEST_A.toUpperCase()}`)).toBe('a'.repeat(12));
    expect(shortenArchiveDigest(`sha256:${DIGEST_A}`)).toBe('a'.repeat(12));
    expect(shortenArchiveDigest(undefined)).toBeUndefined();
    expect(shortenArchiveDigest('sha512-' + 'a'.repeat(64))).toBeUndefined();
    expect(shortenArchiveDigest('a'.repeat(63))).toBeUndefined();
    expect(shortenArchiveDigest('zzzz')).toBeUndefined();
  });
});

describe('isPlaceholderPluginVersion', () => {
  it('knows both placeholders and nothing else', () => {
    expect(isPlaceholderPluginVersion(UNDECLARED_PLUGIN_VERSION)).toBe(true);
    expect(isPlaceholderPluginVersion(UNKNOWN_PLUGIN_VERSION)).toBe(true);
    expect(isPlaceholderPluginVersion('0.0.1')).toBe(false);
    expect(isPlaceholderPluginVersion(undefined)).toBe(false);
  });
});
