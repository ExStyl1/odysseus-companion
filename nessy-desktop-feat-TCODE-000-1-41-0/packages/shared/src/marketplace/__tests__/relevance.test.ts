/**
 * `plugin-relevance.md` § Field reference and `plugins/org.md#recommend-plugins`, both
 * fetched 2026-08-07.
 *
 * The `cwd` row: "Glob patterns matched against the session's working directory.
 * Matched as an absolute path and, when inside a git repository, as a path
 * relative to the repository root. Forward-slash normalized and
 * case-insensitive. Every pattern matches the directory itself and everything
 * under it, so `infra`, `infra/`, and `infra/**` behave identically. ... Maximum
 * 10 patterns of 256 characters each."
 */
import { describe, expect, it } from 'bun:test';
import {
  MANIFEST_CONTENT_MAX,
  matchCwdSignal,
  matchManifestDepsSignal,
  matchRelevanceSignal,
  parseMarketplaceRelevance,
  UNMATCHABLE_RELEVANCE_SIGNALS,
} from '../relevance.ts';

describe('parseMarketplaceRelevance', () => {
  it('parses the documented block and keeps the topic', () => {
    expect(parseMarketplaceRelevance({ topic: 'Terraform', signals: { cwd: ['infra'] } }))
      .toEqual({ topic: 'Terraform', signals: { cwd: ['infra'] } });
  });

  it('ignores unknown sub-keys rather than rejecting the block', () => {
    // The Note: "Claude Code ignores unknown fields under `relevance` and
    // `relevance.signals` at load time, so older clients continue to load your
    // marketplace." A newer upstream marketplace must keep parsing here.
    expect(parseMarketplaceRelevance({
      topic: 'Stripe',
      unknownTopLevel: 1,
      signals: { cli: ['stripe'], hosts: ['api.stripe.com'], somethingNew: true },
    })).toEqual({ topic: 'Stripe', signals: {} });
  });

  it('drops a block that is not an object or declares no signals at all', () => {
    // "At least one signal is required for the plugin to be suggestible."
    expect(parseMarketplaceRelevance('yes')).toBeUndefined();
    expect(parseMarketplaceRelevance({ topic: 'Terraform' })).toBeUndefined();
    expect(parseMarketplaceRelevance({ signals: {} })).toBeUndefined();
    expect(parseMarketplaceRelevance(undefined)).toBeUndefined();
  });

  it('enforces the documented caps', () => {
    const parsed = parseMarketplaceRelevance({
      topic: 'x'.repeat(65),
      signals: { cwd: [...Array.from({ length: 12 }, (_value, index) => `dir${index}`), 'y'.repeat(257)] },
    });
    expect(parsed?.topic).toBeUndefined();
    expect(parsed?.signals.cwd).toHaveLength(10);
  });
});

describe('matchCwdSignal', () => {
  const relevance = (cwd: string[]) => parseMarketplaceRelevance({ signals: { cwd } });

  it('matches the repository-relative path, the directory itself, and everything under it', () => {
    const context = { workingDirectory: '/Users/me/proj/infra/modules', repositoryRoot: '/Users/me/proj' };
    // All three spellings behave identically, and each matches a descendant.
    for (const pattern of ['infra', 'infra/', 'infra/**']) {
      expect(matchCwdSignal(relevance([pattern]), context)).toBe('cwd');
    }
    // The directory itself, not only its descendants.
    expect(matchCwdSignal(relevance(['infra/modules']), context)).toBe('cwd');
  });

  it('matches the absolute path, case-insensitively and separator-normalized', () => {
    expect(matchCwdSignal(relevance(['/users/me/proj/**']), { workingDirectory: '/Users/Me/Proj/infra' }))
      .toBe('cwd');
    expect(matchCwdSignal(relevance(['C:/Work/**']), { workingDirectory: 'C:\\Work\\infra' }))
      .toBe('cwd');
  });

  it('does NOT match a sibling directory, a prefix collision, or a missing cwd', () => {
    const context = { workingDirectory: '/Users/me/proj/infrastructure', repositoryRoot: '/Users/me/proj' };
    // `infra` must not swallow `infrastructure`: the rule is "the directory
    // itself and everything under it", which is a path-segment relationship.
    expect(matchCwdSignal(relevance(['infra']), context)).toBeUndefined();
    expect(matchCwdSignal(relevance(['docs']), context)).toBeUndefined();
    expect(matchCwdSignal(relevance(['infra']), {})).toBeUndefined();
    expect(matchCwdSignal(undefined, context)).toBeUndefined();
  });

  it('never matches on a signal this fork does not decide', () => {
    // A block whose only signal is `cli` parses fine and is simply unmatchable
    // here — it is not silently promoted into a cwd match.
    const cliOnly = parseMarketplaceRelevance({ signals: { cli: ['terraform'] } });
    expect(matchCwdSignal(cliOnly, { workingDirectory: '/Users/me/proj' })).toBeUndefined();
  });
});

/**
 * `plugin-relevance.md` § `relevance.signals`, the `manifestDeps` row, fetched
 * 2026-09-06 — "Each entry is `{ "file": "...", "pattern": "..." }`, where `file`
 * is a regular expression matched against the manifest file's path ... and
 * `pattern` is a regular expression matched against that file's contents. ...
 * Manifest files larger than 512 KB are skipped. Both values are JavaScript
 * `RegExp` source strings of at most 256 characters. `file` matches
 * case-insensitively. `pattern` is case-sensitive. Maximum 10 entries."
 */
describe('manifestDeps', () => {
  // The page's own example entry, in its JSON-escaped spelling.
  const stripeEntry = { file: '[/\\\\]package\\.json$', pattern: '"stripe"\\s*:' };
  const stripe = parseMarketplaceRelevance({ topic: 'Stripe', signals: { manifestDeps: [stripeEntry] } });
  const manifest = (content: string) => [{ path: '/Users/me/proj/package.json', content }];

  it('parses the documented entry and enforces the entry and source caps', () => {
    expect(stripe?.signals.manifestDeps).toEqual([stripeEntry]);
    const capped = parseMarketplaceRelevance({
      signals: {
        manifestDeps: [
          ...Array.from({ length: 12 }, () => ({ file: 'a$', pattern: 'b' })),
          { file: 'c'.repeat(257), pattern: 'b' },
          { file: 'a$', pattern: 42 },
          'not an object',
        ],
      },
    });
    expect(capped?.signals.manifestDeps).toHaveLength(10);
  });

  it('matches a dependency declared in the project manifest', () => {
    expect(matchManifestDepsSignal(stripe, { manifests: manifest('{"dependencies":{"stripe":"^1"}}') }))
      .toBe('manifestDeps');
    // `file` is case-insensitive and NOT separator-normalized: a Windows path
    // matches the same entry through its `[/\\]` alternation.
    expect(matchManifestDepsSignal(stripe, {
      manifests: [{ path: 'C:\\Work\\Proj\\PACKAGE.JSON', content: '{"stripe": "^1"}' }],
    })).toBe('manifestDeps');
  });

  it('does NOT match a miss, an unsupplied manifest, an over-cap file, or a bad regular expression', () => {
    // The file matches, the contents do not.
    expect(matchManifestDepsSignal(stripe, { manifests: manifest('{"dependencies":{"axios":"^1"}}') }))
      .toBeUndefined();
    // The contents match, the path does not.
    expect(matchManifestDepsSignal(stripe, {
      manifests: [{ path: '/Users/me/proj/README.md', content: '"stripe":' }],
    })).toBeUndefined();
    // No manifests collected at all — the ordinary case for a project with none.
    expect(matchManifestDepsSignal(stripe, {})).toBeUndefined();
    // "Manifest files larger than 512 KB are skipped."
    expect(matchManifestDepsSignal(stripe, {
      manifests: manifest(`${' '.repeat(MANIFEST_CONTENT_MAX)}"stripe":`),
    })).toBeUndefined();
    // A marketplace's uncompilable source is skipped, never thrown.
    const broken = parseMarketplaceRelevance({ signals: { manifestDeps: [{ file: '([', pattern: 'x' }] } });
    expect(matchManifestDepsSignal(broken, { manifests: manifest('x') })).toBeUndefined();
    // `pattern` is case-sensitive, unlike `file`.
    expect(matchManifestDepsSignal(stripe, { manifests: manifest('{"STRIPE": "^1"}') })).toBeUndefined();
  });

  it('names the three signals it declines to decide, and prefers cwd when both match', () => {
    expect(UNMATCHABLE_RELEVANCE_SIGNALS).toEqual(['cli', 'hosts', 'filesRead']);
    const both = parseMarketplaceRelevance({
      signals: { cwd: ['/users/me/proj'], manifestDeps: [stripeEntry] },
    });
    // "This is the only signal that can match at session start" — cwd answers first.
    expect(matchRelevanceSignal(both, {
      workingDirectory: '/Users/me/proj',
      manifests: manifest('"stripe":'),
    })).toBe('cwd');
    expect(matchRelevanceSignal(both, { manifests: manifest('"stripe":') })).toBe('manifestDeps');
    expect(matchRelevanceSignal(both, {})).toBeUndefined();
  });
});
