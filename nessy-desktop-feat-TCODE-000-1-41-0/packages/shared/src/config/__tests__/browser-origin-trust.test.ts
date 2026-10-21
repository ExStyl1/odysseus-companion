import { describe, expect, it } from 'bun:test';
import {
  applyBrowserTrustDecision,
  browserTrustOriginOf,
  listBrowserOriginTrust,
  noteBrowserOriginSeen,
  normalizeBrowserOriginTrust,
  resolveBrowserTrust,
  revokeBrowserOriginTrust,
  sessionGrantKey,
  type BrowserOriginTrustStateV1,
} from '../browser-origin-trust.ts';

/**
 * P6.536 — the per-origin browser trust store, owner decision D9 = option 2.
 *
 * Every assertion here is one clause of `done_means`. The one that matters most
 * is the DEFAULT: before this row both gates were an unconditional allow, so
 * `ask` for an unknown origin is the whole change and a regression to `allow`
 * would be silent everywhere else.
 */
const EMPTY: BrowserOriginTrustStateV1 = { version: 1, origins: {} };

describe('the trust key', () => {
  it('is per SUBDOMAIN, scheme and port included', () => {
    expect(browserTrustOriginOf('https://docs.example.com/a/b?c=d')).toBe('https://docs.example.com');
    expect(browserTrustOriginOf('https://example.com/')).toBe('https://example.com');
    // The point of per-subdomain: approving the docs site is not approving the
    // registrable domain.
    expect(browserTrustOriginOf('https://docs.example.com'))
      .not.toBe(browserTrustOriginOf('https://example.com'));
    expect(browserTrustOriginOf('http://localhost:5173/x')).toBe('http://localhost:5173');
    expect(browserTrustOriginOf('https://example.com:8443/')).toBe('https://example.com:8443');
  });

  it('never asks about the pane\'s own idle state, and never invents a key', () => {
    for (const url of ['about:blank', 'data:text/html,x', 'blob:https://a/b', 'devtools://x', '', 'not a url']) {
      expect(browserTrustOriginOf(url)).toBeUndefined();
    }
    // `file:` has no host but IS a page a debugger can attach to, so it gets one
    // key rather than being ungated.
    expect(browserTrustOriginOf('file:///Users/x/a.html')).toBe('file://');
  });
});

describe('what a gate does', () => {
  it('ASKS about an origin nobody has decided — the whole of the change', () => {
    expect(resolveBrowserTrust(EMPTY, undefined, 'https://a.example', 'navigation')).toBe('ask');
    expect(resolveBrowserTrust(EMPTY, undefined, 'https://a.example', 'cdp')).toBe('ask');
    expect(resolveBrowserTrust(undefined, undefined, 'https://a.example', 'cdp')).toBe('ask');
  });

  it('keeps the two gates separate — browsable is not debuggable', () => {
    const { state } = applyBrowserTrustDecision(EMPTY, 'https://a.example', 'navigation', 'always-allow');
    expect(resolveBrowserTrust(state, undefined, 'https://a.example', 'navigation')).toBe('allow');
    expect(resolveBrowserTrust(state, undefined, 'https://a.example', 'cdp')).toBe('ask');
  });

  it('allow-once grants this process and NOTHING on disk', () => {
    const applied = applyBrowserTrustDecision(EMPTY, 'https://a.example', 'cdp', 'allow-once');
    expect(applied.persisted).toBe(false);
    expect(applied.state).toEqual(EMPTY);
    expect(applied.sessionGrant).toBe(sessionGrantKey('https://a.example', 'cdp'));

    const grants = new Set([applied.sessionGrant!]);
    expect(resolveBrowserTrust(applied.state, grants, 'https://a.example', 'cdp')).toBe('allow');
    // The restart: same state, no grants. "Once" cannot decay into "always".
    expect(resolveBrowserTrust(applied.state, undefined, 'https://a.example', 'cdp')).toBe('ask');
  });

  it('a deny outranks a grant given earlier in the same run', () => {
    const grants = new Set([sessionGrantKey('https://a.example', 'navigation')]);
    const { state } = applyBrowserTrustDecision(EMPTY, 'https://a.example', 'navigation', 'deny');
    expect(resolveBrowserTrust(state, grants, 'https://a.example', 'navigation')).toBe('deny');
  });
});

describe('revoking, listing and reading back', () => {
  it('revoking returns an origin to ask, not to deny', () => {
    let state = applyBrowserTrustDecision(EMPTY, 'https://a.example', 'navigation', 'always-allow').state;
    state = applyBrowserTrustDecision(state, 'https://a.example', 'cdp', 'deny').state;
    const revoked = revokeBrowserOriginTrust(state, 'https://a.example');
    expect(resolveBrowserTrust(revoked, undefined, 'https://a.example', 'navigation')).toBe('ask');
    expect(resolveBrowserTrust(revoked, undefined, 'https://a.example', 'cdp')).toBe('ask');
    // Revoking an origin nobody decided is a no-op, not a new empty record.
    expect(revokeBrowserOriginTrust(revoked, 'https://never.example')).toEqual(revoked);
  });

  it('lists what was decided, most recent first', () => {
    let state = applyBrowserTrustDecision(EMPTY, 'https://old.example', 'navigation', 'always-allow', 100).state;
    state = applyBrowserTrustDecision(state, 'https://new.example', 'cdp', 'deny', 200).state;
    expect(listBrowserOriginTrust(state).map(e => e.origin))
      .toEqual(['https://new.example', 'https://old.example']);
  });

  it('does NOT turn into a browsing history: a visit to an undecided origin records nothing', () => {
    expect(noteBrowserOriginSeen(EMPTY, 'https://a.example').persisted).toBe(false);
    expect(noteBrowserOriginSeen(EMPTY, 'https://a.example').state).toEqual(EMPTY);

    const decided = applyBrowserTrustDecision(EMPTY, 'https://a.example', 'navigation', 'always-allow').state;
    const seen = noteBrowserOriginSeen(decided, 'https://a.example', 999);
    expect(seen.persisted).toBe(true);
    expect(seen.state.origins['https://a.example']?.lastSeenAt).toBe(999);
  });

  it('a corrupt or hand-edited file costs a prompt, never a silent grant', () => {
    expect(normalizeBrowserOriginTrust(null)).toEqual(EMPTY);
    expect(normalizeBrowserOriginTrust('nonsense')).toEqual(EMPTY);
    expect(normalizeBrowserOriginTrust([{ origin: 'x' }])).toEqual(EMPTY);
    const salvaged = normalizeBrowserOriginTrust({
      version: 1,
      origins: {
        'https://good.example': { navigation: 'always-allow', decidedAt: 5 },
        'https://bogus.example': { navigation: 'yes-please' },
        'https://empty.example': { decidedAt: 7 },
        'https://wrong.example': 42,
      },
    });
    expect(Object.keys(salvaged.origins)).toEqual(['https://good.example']);
    expect(resolveBrowserTrust(salvaged, undefined, 'https://bogus.example', 'navigation')).toBe('ask');
  });
});
