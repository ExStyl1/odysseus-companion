import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCredsPath, readNestorJwt } from '../nestor-auth.ts';

const dir = mkdtempSync(join(tmpdir(), 'nestor-auth-'));
const write = (name: string, body: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};

describe('readNestorJwt', () => {
  test('returns a three-segment jwt verbatim', () => {
    const path = write('ok.json', { jwt: 'aGVhZA.cGF5bG9hZA.c2ln' });
    expect(readNestorJwt(path)).toBe('aGVhZA.cGF5bG9hZA.c2ln');
  });

  test('returns null for a non-JWT jwt value', () => {
    const path = write('garbage.json', { jwt: 'sk-not-a-jwt-token' });
    expect(readNestorJwt(path)).toBeNull();
  });

  test('returns null for a missing file', () => {
    expect(readNestorJwt(join(dir, 'absent.json'))).toBeNull();
  });
});

/**
 * DA1.5's FOURTH resolver arm — handed over by WA-a, whose own diff landed the
 * rule in `defaultCredsPath` above (the store's three siblings are pinned by
 * `packages/shared/src/agent/__tests__/credential-floor-parity.test.ts`; this
 * package cannot be reached from there, so the arm lives here).
 *
 * The rule is TOTAL on purpose — absolute or the default, never a tilde and
 * never a cwd resolution — so the four copies of it this tree is forced to keep
 * cannot drift apart. `NESSY_HOME` names the `.nessy` DIRECTORY itself, not a
 * home that contains one, exactly as `auth/dp/creds-store.ts` symbol
 * `getNessyDir` reads it.
 *
 * `delete` before every assignment and on the restore path, per AGENTS.md:
 * assigning to `process.env.X` under Bun can leave the name readable by
 * property and invisible to a spread, and every subprocess env in this tree is
 * built by spreading `process.env`.
 */
describe('defaultCredsPath honours NESSY_HOME (DA1.5, WA-a hand-off)', () => {
  const restore = process.env.NESSY_HOME;
  const setHome = (value?: string): void => {
    delete process.env.NESSY_HOME;
    if (value !== undefined) process.env.NESSY_HOME = value;
  };

  test('an ABSOLUTE value relocates the creds file into that directory', () => {
    const relocated = mkdtempSync(join(tmpdir(), 'nessy-home-'));
    try {
      setHome(relocated);
      expect(defaultCredsPath()).toBe(join(relocated, 'dp_auth_creds.json'));
      // And the reader really follows it, rather than the resolver merely
      // returning a string nothing uses.
      mkdirSync(relocated, { recursive: true });
      writeFileSync(join(relocated, 'dp_auth_creds.json'), JSON.stringify({
        jwt: 'aGVhZA.cGF5bG9hZA.c2ln',
        expiresAt: Date.now() + 60_000,
      }));
      expect(readNestorJwt()).toBe('aGVhZA.cGF5bG9hZA.c2ln');
    } finally {
      setHome(restore);
    }
  });

  test('a RELATIVE or tilde value falls back to the default and is never expanded', () => {
    try {
      const fallback = (): string => {
        const path = defaultCredsPath();
        return path;
      };
      setHome(undefined);
      const plain = fallback();
      // DA1.24 — the IN-CASE positive control, without which this test passes
      // against a resolver that ignores NESSY_HOME altogether: every assertion
      // below is "the answer did NOT move", and an answer that can never move
      // satisfies all of them. The absolute arm lives in its own `test()`, and
      // bun does not guarantee it runs first, so the control belongs here too.
      const accepted = mkdtempSync(join(tmpdir(), 'nessy-home-control-'));
      setHome(accepted);
      expect(fallback()).toBe(join(accepted, 'dp_auth_creds.json'));
      expect(fallback()).not.toBe(plain);
      // A BARE tilde is the spelling a user is most likely to type by hand and
      // the one the loop was missing; the rest are DA1.5's own rejected forms.
      for (const rejected of ['relative/dir', '~/somewhere', '~', './x', '  ']) {
        setHome(rejected);
        expect(fallback(), rejected).toBe(plain);
      }
    } finally {
      setHome(restore);
    }
  });
});
