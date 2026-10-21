import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCreds,
  getValidCreds,
  saveCreds,
  clearCreds,
  readCliOauthJwt,
  readDpIdentity,
  getNessyDir,
  getCredsPath,
  getOauthCredsPath,
  NESSY_HOME_ENV,
} from '../creds-store.ts';
import { isJwtShaped, isUsableJwt } from '../jwt.ts';
import { latchedHomeDir } from '../../../config/home-latch.ts';
import { makeTestJwt } from './test-jwt.ts';
import { RELOCATED_LIVE_ENV_NAMES } from '../../../../tests/setup/isolate-shared-config-dir.ts';

// Every call passes an explicit temp path — the real ~/.nessy/dp_auth_creds.json
// is NEVER touched (os.homedir() ignores $HOME on macOS, so an env override is
// not safe; explicit paths are).
let dir: string;
let credsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nessy-creds-'));
  credsPath = join(dir, 'dp_auth_creds.json');
});

function writeExisting(obj: unknown): void {
  writeFileSync(credsPath, JSON.stringify(obj, null, 2));
}

describe('loadCreds / getValidCreds', () => {
  it('returns null when the file is absent', () => {
    expect(loadCreds(credsPath)).toBeNull();
    expect(getValidCreds(credsPath)).toBeNull();
  });

  it('loads structurally valid creds', () => {
    const future = Date.now() + 1_000_000;
    // DA1.50 · a DECODABLE fixture, because `getValidCreds` now gates on
    // `isUsableJwt`. `loadCreds` is unchanged and still only wants the two
    // fields, which the arm below this one is what proves.
    const jwt = makeTestJwt({});
    writeExisting({ jwt, expiresAt: future, username: 'u', userId: 'i' });
    expect(loadCreds(credsPath)?.jwt).toBe(jwt);
    expect(getValidCreds(credsPath)?.jwt).toBe(jwt);
  });

  it('treats expired creds as loadable but not valid', () => {
    writeExisting({ jwt: 'j', expiresAt: Date.now() - 1000, username: 'u', userId: 'i' });
    expect(loadCreds(credsPath)?.jwt).toBe('j');
    expect(getValidCreds(credsPath)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    writeFileSync(credsPath, '{ not json');
    expect(loadCreds(credsPath)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    writeExisting({ username: 'u' });
    expect(loadCreds(credsPath)).toBeNull();
  });
});

describe('saveCreds', () => {
  const creds = () => ({
    jwt: 'new-jwt',
    expiresAt: Date.now() + 5000,
    username: 'me',
    userId: 'id-1',
  });

  it('creates the file at mode 0600', () => {
    saveCreds(creds(), credsPath);
    const mode = statSync(credsPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loadCreds(credsPath)?.jwt).toBe('new-jwt');
  });

  it('creates ~/.nessy 0700 when the dir is absent', () => {
    const nested = join(dir, '.nessy', 'dp_auth_creds.json');
    saveCreds(creds(), nested);
    const dirMode = statSync(join(dir, '.nessy')).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it('preserves cachedModels and unknown keys on rewrite', () => {
    writeExisting({
      jwt: 'old',
      expiresAt: 1,
      username: 'old',
      userId: 'old',
      cachedModels: [{ id: 'm1' }],
      customNessyCliKey: 'keep-me',
    });
    saveCreds(creds(), credsPath);
    const written = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(written.jwt).toBe('new-jwt');
    expect(written.cachedModels).toEqual([{ id: 'm1' }]);
    expect(written.customNessyCliKey).toBe('keep-me');
  });

  it('leaves no tmp litter behind', () => {
    saveCreds(creds(), credsPath);
    const entries = readdirSync(dir);
    expect(entries).toEqual(['dp_auth_creds.json']);
  });
});

describe('clearCreds', () => {
  it('removes the file', () => {
    saveCreds({ jwt: 'j', expiresAt: Date.now() + 5000, username: 'u', userId: 'i' }, credsPath);
    expect(existsSync(credsPath)).toBe(true);
    clearCreds(credsPath);
    expect(existsSync(credsPath)).toBe(false);
  });
});

describe('getValidCreds jwt shape', () => {
  test('non-JWT jwt with a future expiresAt reads as signed out', () => {
    const credsPath = join(dir, 'garbage-creds.json');
    writeFileSync(credsPath, JSON.stringify({
      jwt: 'sk-not-a-jwt-token',
      expiresAt: Date.now() + 86_400_000,
      username: 'u', userId: '1',
    }));
    expect(getValidCreds(credsPath)).toBeNull();
  });

  test('a DECODABLE jwt with a future expiresAt reads as valid', () => {
    const credsPath = join(dir, 'ok-creds.json');
    writeFileSync(credsPath, JSON.stringify({
      jwt: makeTestJwt({}),
      expiresAt: Date.now() + 86_400_000,
      username: 'u', userId: '1',
    }));
    expect(getValidCreds(credsPath)?.username).toBe('u');
  });

  test('DA1.50: the gate is `isUsableJwt`, so a three-segment value that cannot decode is refused', () => {
    // This arm is the FLIP of DA1.26's recorded residue, and it is written as
    // its own discriminating pair rather than as a changed assertion:
    // `aGVhZA.cGF5bG9hZA.c2ln` is `head`.`payload`.`sig` — three non-empty
    // segments, so the structural predicate accepts it, while the payload is
    // not JSON, so the usable predicate does not. Before DA1.50 this file
    // answered a non-null credential here; the value would have left the
    // machine as `Nestor-Token` and come back as a 401 nothing can fix.
    //
    // The fixture is written HERE and not inherited from the arm above: the
    // top-level `beforeEach` makes a fresh `mkdtempSync` directory before every
    // test, so `join(dir, …)` names an empty directory and `getValidCreds`
    // would answer `null` — which is what a MISSING FILE answers too, so the
    // arm would be passing its own vacuity off as the refusal it exists to
    // record. (That is not hypothetical: it landed red in `080b545cb` for
    // exactly this reason and was found by DA1.39's first run of the file.)
    const structuralPath = join(dir, 'structural-creds.json');
    writeFileSync(structuralPath, JSON.stringify({
      jwt: 'aGVhZA.cGF5bG9hZA.c2ln',
      expiresAt: Date.now() + 86_400_000,
      username: 'u', userId: '1',
    }));
    expect(isJwtShaped('aGVhZA.cGF5bG9hZA.c2ln')).toBe(true);
    expect(isUsableJwt('aGVhZA.cGF5bG9hZA.c2ln')).toBe(false);
    expect(getValidCreds(structuralPath)).toBeNull();

    // The positive twin, in the same arm and against the same directory, so
    // the refusal above cannot be read as the file having been unreadable.
    const usablePath = join(dir, 'usable-creds.json');
    writeFileSync(usablePath, JSON.stringify({
      jwt: makeTestJwt({}),
      expiresAt: Date.now() + 86_400_000,
      username: 'u', userId: '1',
    }));
    expect(getValidCreds(usablePath)).not.toBeNull();
  });

  test('DA1.50: expiry is still asked HERE, not folded into the predicate', () => {
    // A DECODABLE token that is out of date must read as re-mintable — null
    // from this function — while `isUsableJwt` still calls the value a JWT.
    // Folding expiry into the predicate would make the two indistinguishable,
    // which is what `isUsableJwt`'s own docblock declines to do.
    const jwt = makeTestJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const expiredPath = join(dir, 'expired-creds.json');
    writeFileSync(expiredPath, JSON.stringify({
      jwt,
      expiresAt: Date.now() - 60_000,
      username: 'u', userId: '1',
    }));
    expect(isUsableJwt(jwt)).toBe(true);
    expect(getValidCreds(expiredPath)).toBeNull();
  });
});

describe('the preload isolates the LIVE relocation names (DA1.39)', () => {
  // The title names no list and no count on purpose: a fifth name would make a
  // counted title wrong, and AGENTS.md §Traps records that a guard written as a
  // number WORD matches the number that replaces it.
  it('leaves every live relocation name unset for every suite under it', () => {
    // DA1.51 · asserted over the preload's OWN EXPORT, not over a hand-written
    // list. `getNessyDir()` reads NESSY_HOME LIVE, by design, so
    // `relatchHomeDirForTests` cannot isolate this file's creds paths on a
    // machine where that variable is exported: the suite would resolve the
    // developer's own `dp_auth_creds.json`. The preload deletes it, and this arm
    // is the only thing in the tree that can see the deletion go away — so a
    // FIFTH name is covered the moment it joins the list rather than the day
    // somebody remembers this file.
    for (const name of RELOCATED_LIVE_ENV_NAMES) {
      expect({ name, value: process.env[name] }).toEqual({ name, value: undefined });
    }
    // The BOUNDARY, and it is the whole reason the loop is safe: a loop over an
    // empty list passes trivially, so an emptied export would turn this arm into
    // a green no-op. Assert the list can still fail before believing that it
    // did not.
    expect(RELOCATED_LIVE_ENV_NAMES.length).toBeGreaterThan(0);
    for (const name of RELOCATED_LIVE_ENV_NAMES) expect(name.length).toBeGreaterThan(0);
    // Positive control on the same rig: the preload's OTHER seeding IS present,
    // so the undefineds above are the preload acting rather than a process that
    // never ran it.
    expect(process.env.NESSY_CONFIG_DIR).toBeTruthy();
  });

  it('so getNessyDir answers the LATCHED home, which is the only thing a suite can relatch', () => {
    // The negative arm of the same fact: with the variable deleted, the store
    // resolves through `latchedHomeDir()` — the one input a suite controls via
    // `relatchHomeDirForTests`. An exported NESSY_HOME would win over it
    // outright (`getNessyDir` returns the absolute value verbatim), which is
    // exactly the isolation hole DA1.39 closes.
    expect(getNessyDir()).toBe(join(latchedHomeDir(), '.nessy'));
  });
});

describe('readCliOauthJwt', () => {
  // Nestor-like: decodable claims with a non-empty preferred_username — a bare
  // 'a.b.c' would pass isJwtShaped but fail the decodable-claims check.
  const NESTOR_LIKE_JWT = makeTestJwt({ preferred_username: 'cli.user', sub: 'cli-id' });

  const writeOauth = (name: string, body: unknown): string => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };

  test('accepts an unexpired nestor-like access_token', () => {
    const p = writeOauth('ok.json', {
      access_token: NESTOR_LIKE_JWT,
      expiry_date: Date.now() + 86_400_000,
      token_type: 'Bearer',
    });
    expect(readCliOauthJwt(p)?.jwt).toBe(NESTOR_LIKE_JWT);
  });

  test('rejects a qwen token (resource_url present)', () => {
    const p = writeOauth('qwen.json', {
      access_token: NESTOR_LIKE_JWT,
      expiry_date: Date.now() + 86_400_000,
      resource_url: 'portal.qwen.ai',
    });
    expect(readCliOauthJwt(p)).toBeNull();
  });

  test('rejects expired / non-JWT / missing file', () => {
    expect(
      readCliOauthJwt(writeOauth('exp.json', { access_token: NESTOR_LIKE_JWT, expiry_date: Date.now() - 1 })),
    ).toBeNull();
    expect(
      readCliOauthJwt(writeOauth('junk.json', { access_token: 'ory-opaque-token', expiry_date: Date.now() + 86_400_000 })),
    ).toBeNull();
    expect(readCliOauthJwt(join(dir, 'absent.json'))).toBeNull();
  });

  test('rejects a decodable jwt with no preferred_username claim', () => {
    // Otherwise-valid (unexpired, JWT-shaped, no resource_url) but the claim
    // hard rule 4 requires — a non-empty preferred_username — is missing.
    const noUsernameJwt = makeTestJwt({ preferred_username: '', sub: 'no-name-id' });
    const p = writeOauth('no-username.json', {
      access_token: noUsernameJwt,
      expiry_date: Date.now() + 86_400_000,
    });
    expect(readCliOauthJwt(p)).toBeNull();
  });
});

describe('getNessyDir — NESSY_HOME (DA1.5)', () => {
  // Only the ENV VAR is moved, never `HOME`: every assertion below is a path
  // comparison, so no file outside a fresh temp dir is created, read or removed.
  let origNessyHome: string | undefined;

  beforeEach(() => {
    origNessyHome = process.env[NESSY_HOME_ENV];
    // delete-then-assign, never a bare assign (AGENTS.md § Traps: Bun leaves
    // some names readable by property and invisible to a spread).
    delete process.env[NESSY_HOME_ENV];
  });

  afterEach(() => {
    delete process.env[NESSY_HOME_ENV];
    if (origNessyHome !== undefined) process.env[NESSY_HOME_ENV] = origNessyHome;
  });

  it('unset: both credential paths keep the latched ~/.nessy default', () => {
    const base = join(latchedHomeDir(), '.nessy');
    expect(getNessyDir()).toBe(base);
    expect(getCredsPath()).toBe(join(base, 'dp_auth_creds.json'));
    expect(getOauthCredsPath()).toBe(join(base, 'oauth_creds.json'));
  });

  it('an absolute value moves BOTH paths — the nessy-cli seed included', () => {
    const relocated = mkdtempSync(join(tmpdir(), 'nessy-home-'));
    process.env[NESSY_HOME_ENV] = relocated;

    expect(getNessyDir()).toBe(relocated);
    expect(getCredsPath()).toBe(join(relocated, 'dp_auth_creds.json'));
    expect(getOauthCredsPath()).toBe(join(relocated, 'oauth_creds.json'));
  });

  it('a non-absolute value is IGNORED rather than resolved — tilde included', () => {
    // The stated divergence from nessy-cli's `Storage.getGlobalNessyDir`, which
    // expands `~` and resolves the rest against a cwd. Failing closed on the
    // default keeps the three deny anchors able to re-derive the same path.
    const base = join(latchedHomeDir(), '.nessy');
    for (const value of ['relative/nessy', '~/custom-nessy', '~', '   ']) {
      delete process.env[NESSY_HOME_ENV];
      process.env[NESSY_HOME_ENV] = value;
      expect(getNessyDir()).toBe(base);
    }
  });
});

describe('readDpIdentity — UA12.27, the display identity, never the token', () => {
  const future = Date.now() + 1_000_000;

  it('names the cached login and user id, and carries no token', () => {
    writeExisting({ jwt: makeTestJwt({}), expiresAt: future, username: 'ivanov.iv', userId: 'u-1' });
    const identity = readDpIdentity(credsPath);
    expect(identity).toEqual({ username: 'ivanov.iv', userId: 'u-1' });
    expect('jwt' in (identity ?? {})).toBe(false);
  });

  it('answers null for an absent file, an expired credential, a blank username and a malformed file', () => {
    expect(readDpIdentity(credsPath)).toBeNull();
    writeExisting({ jwt: 'j', expiresAt: Date.now() - 1000, username: 'u', userId: 'i' });
    expect(readDpIdentity(credsPath)).toBeNull();
    writeExisting({ jwt: makeTestJwt({}), expiresAt: future, username: '   ', userId: 'u-1' });
    expect(readDpIdentity(credsPath)).toBeNull();
    writeFileSync(credsPath, '{ not json');
    expect(readDpIdentity(credsPath)).toBeNull();
  });
});
