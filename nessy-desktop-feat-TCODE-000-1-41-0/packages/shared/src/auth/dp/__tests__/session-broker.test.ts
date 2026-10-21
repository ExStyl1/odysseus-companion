import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DpAuthError, DpAuthServiceError } from '../errors.ts';
import { getValidCreds, saveCreds } from '../creds-store.ts';
import {
  createDpSessionBroker,
  type DpSessionState,
  type DpSessionStatus,
} from '../session-broker.ts';
import { clearDemotedDpBinaries, resolveDpRuntime } from '../dp-binary.ts';
import { createFakeDp } from './fake-dp.ts';
import { makeTestJwt } from './test-jwt.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function brokerFor(binary: string) {
  return createDpSessionBroker({ resolveBinary: () => binary });
}

describe('DpSessionBroker', () => {
  it('probes a ready raw DP session without opening login', async () => {
    const fake = createFakeDp({ loggedIn: true });
    const broker = brokerFor(fake.binary);

    expect(await broker.probe()).toEqual({
      state: 'ready',
      version: '13.24.1',
      outdated: false,
    });
    expect(fake.countCalls('auth login')).toBe(0);
  });

  it(
    'runs the version probe and print-token CONCURRENTLY, so one window is not two hook waits',
    async () => {
      // C3.391 · both spawns pay dp's own startup hook and both budgets are now
      // sized against it, so the ordering decides whether a probe window costs
      // the LONGER of the two waits or their SUM. Two seconds each: sequential
      // is ~4 s, concurrent ~2 s. Without this the advisory version probe could
      // spend its whole budget before the token attempt even started.
      const fake = createFakeDp({
        loggedIn: true,
        versionDelaySeconds: 2,
        printTokenDelaySeconds: 2,
      });
      const broker = brokerFor(fake.binary);

      const start = Date.now();
      const state = await broker.probe();
      const elapsed = Date.now() - start;

      expect(state).toEqual({ state: 'ready', version: '13.24.1', outdated: false });
      // Both really ran — the concurrency must not have skipped one.
      expect(fake.countCalls('version')).toBe(1);
      expect(fake.countCalls('auth print-token')).toBe(1);
      // Above one delay (so the slow arm was really waited for) and well below
      // two (so they overlapped).
      expect(elapsed).toBeGreaterThan(1_800);
      expect(elapsed).toBeLessThan(3_500);
    },
    30_000,
  );

  it('reports needs-login without opening login', async () => {
    const fake = createFakeDp({ loggedIn: false });
    const broker = brokerFor(fake.binary);

    expect(await broker.probe()).toEqual({
      state: 'needs-login',
      version: '13.24.1',
      outdated: false,
    });
    expect(fake.countCalls('auth login')).toBe(0);
  });

  it('shares one login across concurrent ensure callers and re-probes', async () => {
    const fake = createFakeDp({ loggedIn: false });
    const broker = brokerFor(fake.binary);

    const [first, second] = await Promise.all([
      broker.ensure({ ownerId: 'first' }),
      broker.ensure({ ownerId: 'second' }),
    ]);

    expect(first).toEqual({ state: 'ready', version: '13.24.1', outdated: false });
    expect(second).toEqual(first);
    expect(fake.countCalls('auth login')).toBe(1);
    expect(fake.countCalls('auth print-token')).toBeGreaterThanOrEqual(2);
  });

  it('lets only the run owner cancel the login child', async () => {
    const fake = createFakeDp({ hangLogin: true });
    const broker = brokerFor(fake.binary);
    const owner = broker.ensure({ ownerId: 'owner' });
    const follower = broker.ensure({ ownerId: 'follower' });
    await waitFor(() => fake.countCalls('auth login') === 1);

    expect(broker.cancel('follower')).toBe(true);
    await expect(follower).rejects.toMatchObject({ code: DpAuthError.Cancelled });
    expect(fake.gotSigterm()).toBe(false);

    expect(broker.cancel('owner')).toBe(true);
    await expect(owner).rejects.toMatchObject({ code: DpAuthError.Cancelled });
    expect(await waitFor(() => fake.gotSigterm())).toBe(true);
  });

  it('honors already-aborted owner and follower signals', async () => {
    const ownerFake = createFakeDp({ hangVersion: true });
    const ownerBroker = brokerFor(ownerFake.binary);
    const ownerController = new AbortController();
    ownerController.abort();
    await expect(
      ownerBroker.ensure({ ownerId: 'aborted-owner', signal: ownerController.signal }),
    ).rejects.toMatchObject({ code: DpAuthError.Cancelled });

    const followerFake = createFakeDp({ hangLogin: true });
    const followerBroker = brokerFor(followerFake.binary);
    const owner = followerBroker.ensure({ ownerId: 'owner' });
    await waitFor(() => followerFake.countCalls('auth login') === 1);
    const followerController = new AbortController();
    followerController.abort();
    await expect(
      followerBroker.ensure({
        ownerId: 'aborted-follower',
        signal: followerController.signal,
      }),
    ).rejects.toMatchObject({ code: DpAuthError.Cancelled });
    expect(followerFake.gotSigterm()).toBe(false);
    followerBroker.cancel('owner');
    await expect(owner).rejects.toMatchObject({ code: DpAuthError.Cancelled });
  });

  it('owner cancellation kills an active version probe', async () => {
    const fake = createFakeDp({ hangVersion: true });
    const broker = brokerFor(fake.binary);
    const pending = broker.ensure({ ownerId: 'version-owner' });
    const outcome = pending.catch((error) => error);
    await waitFor(() => fake.countCalls('version') === 1);

    expect(broker.cancel('version-owner')).toBe(true);
    const killed = await waitFor(() => fake.gotSigterm(), 1_000);
    expect(await outcome).toMatchObject({ code: DpAuthError.Cancelled });
    expect(killed).toBe(true);
    // C3.391 · this was `toBe(0)`, and the zero was a statement about ORDERING:
    // the version probe was awaited FIRST, so a cancel during it meant
    // print-token never started. The two now run concurrently — that is the row
    // — so the honest assertion is that the second spawn DID happen and the
    // cancel still killed the hung one. Reverting to a sequence makes this 0
    // again, which is exactly what it should now fail on.
    expect(fake.countCalls('auth print-token')).toBe(1);
  }, 10_000);

  it('dispose kills an active version probe', async () => {
    const fake = createFakeDp({ hangVersion: true });
    const broker = brokerFor(fake.binary);
    const pending = broker.ensure({ ownerId: 'dispose-version-owner' });
    await waitFor(() => fake.countCalls('version') === 1);

    broker.dispose();

    await expect(pending).rejects.toMatchObject({ code: DpAuthError.Cancelled });
    expect(await waitFor(() => fake.gotSigterm(), 1_000)).toBe(true);
    // C3.391 · concurrent now, see the sibling case above.
    expect(fake.countCalls('auth print-token')).toBe(1);
  }, 10_000);

  it('maps missing and outdated DP to value-free stable states', async () => {
    const missing = createDpSessionBroker({
      resolveBinary: () => {
        throw new DpAuthServiceError(
          DpAuthError.DpNotFound,
          'secret stdout and stderr must not escape',
        );
      },
    });
    const outdated = createFakeDp({ loggedIn: true, version: '12.9.0' });

    const missingState = await missing.probe();
    expect(missingState).toEqual({ state: 'unavailable', code: DpAuthError.DpNotFound });
    expect(JSON.stringify(missingState)).not.toContain('stdout');
    expect(await brokerFor(outdated.binary).probe()).toEqual({
      state: 'ready',
      version: '12.9.0',
      outdated: true,
    });
  });

  it('does not retain or stringify a token when the callback fails', async () => {
    const token = 'raw-dp-token-must-stay-local';
    const fake = createFakeDp({ loggedIn: true, token });
    const broker = brokerFor(fake.binary);
    const failure = new Error('operation failed');

    await expect(
      broker.withAccessToken(async (received) => {
        expect(received).toBe(token);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(JSON.stringify(await broker.probe())).not.toContain(token);
  });

  it('publishes only value-free states and supports unsubscribe', async () => {
    const token = 'subscriber-must-never-see-this';
    const fake = createFakeDp({ loggedIn: false, token });
    const broker = brokerFor(fake.binary);
    const states: DpSessionState[] = [];
    const unsubscribe = broker.subscribe((state) => states.push(state));

    await broker.ensure({ ownerId: 'subscriber-test' });
    unsubscribe();
    await broker.probe();

    expect(states.map((state) => state.state)).toEqual(['needs-login', 'ready']);
    expect(JSON.stringify(states)).not.toContain(token);
  });

  it('isolates subscriber exceptions', async () => {
    const fake = createFakeDp({ loggedIn: true });
    const broker = brokerFor(fake.binary);
    const states: DpSessionState[] = [];
    broker.subscribe(() => {
      throw new Error('subscriber failed');
    });
    broker.subscribe((state) => states.push(state));

    const result = await broker.probe();

    expect(result.state).toBe('ready');
    expect(states).toEqual([result]);
  });

  it('does not treat valid Gateway credentials as a raw DP session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-broker-creds-'));
    const credsPath = join(root, '.nessy', 'dp_auth_creds.json');
    // DA1.50 · `getValidCreds` gates on `isUsableJwt`, so the fixture must decode.
    const gatewayJwt = makeTestJwt({ preferred_username: 'gateway-user', sub: 'gateway-id' });
    saveCreds({
      jwt: gatewayJwt,
      expiresAt: Date.now() + 60_000,
      username: 'gateway-user',
      userId: 'gateway-id',
    }, credsPath);
    expect(getValidCreds(credsPath)?.jwt).toBe(gatewayJwt);
    const fake = createFakeDp({ loggedIn: false });

    expect(await brokerFor(fake.binary).probe()).toMatchObject({ state: 'needs-login' });
    expect(fake.countCalls('auth login')).toBe(0);
  });

  it('rejects non-interactive ensure without opening a browser', async () => {
    const fake = createFakeDp({ loggedIn: false });
    const broker = brokerFor(fake.binary);

    await expect(
      broker.ensure({ ownerId: 'remote', interactive: false }),
    ).rejects.toMatchObject({ code: DpAuthError.InteractiveLoginUnavailable });
    expect(fake.countCalls('auth login')).toBe(0);
  });

  // DA3.17. dp opens a browser, prints neither the URL nor any failure, and
  // blocks in its loopback callback forever; on a machine where that browser
  // cannot be SEEN (SSH, a headless box, a locked console) the only thing the
  // user ever met was our own five-minute `Timeout` and the sentence "sign-in
  // timed out", which names neither the browser nor the port. The fake dp's
  // `hangLogin` is that machine, and `timeoutMs` is the seam that prices five
  // minutes in a quarter of a second.
  describe('DA3.17 · a login whose browser cannot be seen', () => {
    it('re-codes the login Timeout and says where the sign-in has to finish', async () => {
      const fake = createFakeDp({ loggedIn: false, hangLogin: true });
      const broker = brokerFor(fake.binary);
      const statuses: DpSessionStatus[] = [];

      const error = await broker
        .ensure({
          ownerId: 'invisible-browser',
          timeoutMs: 250,
          onStatus: (status) => statuses.push(status),
        })
        .catch((thrown: unknown) => thrown);

      // The dp child really ran — this is the timeout arm, not a refusal
      // upstream of the spawn.
      expect(fake.countCalls('auth login')).toBe(1);
      expect(statuses).toContain('waiting-browser');

      expect(error).toBeInstanceOf(DpAuthServiceError);
      const serviceError = error as DpAuthServiceError;
      expect(serviceError.code).toBe(DpAuthError.LoginBrowserTimeout);
      // The MESSAGE, not only the code: the port is the actionable half, and a
      // code assertion alone passes on a member that says nothing.
      expect(serviceError.message).toContain('localhost:25565');
      expect(serviceError.message).toContain('may not be visible on this machine');
      // The original survives, so a log line still says what dp answered.
      expect(serviceError.cause).toBeInstanceOf(DpAuthServiceError);
      expect((serviceError.cause as DpAuthServiceError).code).toBe(DpAuthError.Timeout);
      // And the card is driven off the STATUS as well as off the throw.
      expect(statuses).toContain(`error:${DpAuthError.LoginBrowserTimeout}`);
      expect(statuses).not.toContain(`error:${DpAuthError.Timeout}`);
    });

    it('leaves a cancel and a refused login alone — only the timeout is re-coded', async () => {
      // NEGATIVE ARM ONE: the same hanging dp, ended by the user instead of by
      // the clock. Without it the re-code could be "any login failure" and this
      // suite could not tell.
      const hanging = createFakeDp({ loggedIn: false, hangLogin: true });
      const cancelBroker = brokerFor(hanging.binary);
      const pending = cancelBroker.ensure({ ownerId: 'user-cancel' });
      const cancelled = pending.catch((thrown: unknown) => thrown);
      await waitFor(() => hanging.countCalls('auth login') === 1);
      expect(cancelBroker.cancel('user-cancel')).toBe(true);
      expect(await cancelled).toMatchObject({ code: DpAuthError.Cancelled });

      // NEGATIVE ARM TWO: dp ran and was refused — corp SSO said no, which is
      // not a browser nobody can see.
      const refusing = createFakeDp({ loggedIn: false, failLogin: true });
      await expect(
        brokerFor(refusing.binary).ensure({ ownerId: 'sso-refusal' }),
      ).rejects.toMatchObject({ code: DpAuthError.LoginFailed });
    });

    it('does not touch the non-interactive branch — no spawn, no re-code', async () => {
      // The `interactive === false` throw is UNCHANGED by DA3.17 and this pins
      // it against the very dp that produces the new code when a browser is
      // allowed: same fixture, same broker, no login and no `waiting-browser`.
      const fake = createFakeDp({ loggedIn: false, hangLogin: true });
      const broker = brokerFor(fake.binary);
      const statuses: DpSessionStatus[] = [];

      await expect(
        broker.ensure({
          ownerId: 'headless',
          interactive: false,
          timeoutMs: 250,
          onStatus: (status) => statuses.push(status),
        }),
      ).rejects.toMatchObject({ code: DpAuthError.InteractiveLoginUnavailable });

      expect(fake.countCalls('auth login')).toBe(0);
      expect(statuses).not.toContain('waiting-browser');
      expect(statuses).toContain(`error:${DpAuthError.InteractiveLoginUnavailable}`);
      expect(statuses).not.toContain(`error:${DpAuthError.LoginBrowserTimeout}`);
    });
  });

  it('dispose aborts active work, clears subscribers, and is idempotent', async () => {
    const fake = createFakeDp({ hangLogin: true });
    const broker = brokerFor(fake.binary);
    const states: DpSessionState[] = [];
    broker.subscribe((state) => states.push(state));
    const pending = broker.ensure({ ownerId: 'dispose-owner' });
    await waitFor(() => fake.countCalls('auth login') === 1);

    broker.dispose();
    broker.dispose();

    await expect(pending).rejects.toMatchObject({ code: DpAuthError.Cancelled });
    const countAfterDispose = states.length;
    await broker.probe();
    expect(states).toHaveLength(countAfterDispose);
  });

  describe('probe single-flight and ready-only TTL', () => {
    /** One `probe()` spawns two dp processes; count the second one. */
    const execs = (fake: ReturnType<typeof createFakeDp>) => fake.countCalls('auth print-token');

    it('collapses concurrent probes into one dp invocation', async () => {
      const fake = createFakeDp({ loggedIn: true });
      const broker = brokerFor(fake.binary);

      const [a, b, c] = await Promise.all([broker.probe(), broker.probe(), broker.probe()]);

      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(execs(fake)).toBe(1);
      expect(fake.countCalls('version')).toBe(1);
    });

    it('serves a ready result from cache within the TTL and re-probes after it', async () => {
      const fake = createFakeDp({ loggedIn: true });
      let clock = 1_000;
      const broker = createDpSessionBroker({
        resolveBinary: () => fake.binary,
        now: () => clock,
      });

      await broker.probe();
      await broker.probe();
      expect(execs(fake)).toBe(1);

      clock += 5_001;
      await broker.probe();
      expect(execs(fake)).toBe(2);
    });

    it('never caches a non-ready result', async () => {
      const fake = createFakeDp({ loggedIn: false });
      const broker = brokerFor(fake.binary);

      expect((await broker.probe()).state).toBe('needs-login');
      expect((await broker.probe()).state).toBe('needs-login');

      // needs-login is transient from the caller's point of view: the user may log
      // in between turns, and an exec failure must always be retried.
      expect(execs(fake)).toBe(2);
    });

    it('publishes on a cache hit so subscribers still observe the state', async () => {
      const fake = createFakeDp({ loggedIn: true });
      const broker = brokerFor(fake.binary);
      const seen: string[] = [];
      broker.subscribe((state) => seen.push(state.state));

      await broker.probe();
      await broker.probe();

      // Two observations, one exec. Suppressing the second would stop
      // `observeDpSessionState` from restoring DP servers to a leaser's set.
      expect(seen).toEqual(['ready', 'ready']);
      expect(execs(fake)).toBe(1);
    });

    it('drops the cached ready as soon as a token actually stops working', async () => {
      // The security boundary of the TTL: `withAccessToken` discovering the token
      // is gone must invalidate immediately, not let 'ready' ride out the window.
      const fake = createFakeDp({ loggedIn: true });
      let clock = 1_000;
      const broker = createDpSessionBroker({
        resolveBinary: () => fake.binary,
        now: () => clock,
      });

      expect((await broker.probe()).state).toBe('ready');
      rmSync(join(fake.dir, '.logged-in'));

      await expect(
        broker.withAccessToken(async () => 'never', { interactive: false }),
      ).rejects.toBeInstanceOf(DpAuthServiceError);

      // Same instant — the TTL has NOT elapsed — yet the state must be re-derived.
      expect((await broker.probe()).state).toBe('needs-login');
    });

    it('does not answer for a different dp binary than the one it verified', async () => {
      // A cached `ready` from one binary must not stand in for another — this is
      // also what keeps the process-wide `dpSessionBroker` singleton from leaking
      // one caller's verdict to another. The case where the path MOVES is the
      // easy half; the one below is the half a path-only key could not see.
      const ready = createFakeDp({ loggedIn: true });
      const loggedOut = createFakeDp({ loggedIn: false });
      let binary = ready.binary;
      let clock = 1_000;
      const broker = createDpSessionBroker({
        resolveBinary: () => binary,
        now: () => clock,
      });

      expect((await broker.probe()).state).toBe('ready');
      binary = loggedOut.binary;

      // Still inside the TTL, but a different binary.
      expect((await broker.probe()).state).toBe('needs-login');
      expect(loggedOut.countCalls('auth print-token')).toBe(1);
    });

    it('re-probes a dp that was replaced IN PLACE — DA1.6 item 6', async () => {
      // The dominant upgrade, and the one the path-only key missed: the corp
      // channel overwrites `/usr/local/bin/dp` rather than resolving elsewhere,
      // because that directory is root-owned and `rename()` needs directory
      // write. Same path, different bytes.
      const fake = createFakeDp({ loggedIn: true });
      const broker = createDpSessionBroker({
        resolveBinary: () => fake.binary,
        now: () => 1_000,
      });

      expect((await broker.probe()).state).toBe('ready');

      rmSync(join(fake.dir, '.logged-in'));
      appendFileSync(fake.binary, '\n# replaced in place\n');

      // Same instant, same path — the TTL has NOT elapsed.
      expect((await broker.probe()).state).toBe('needs-login');
      expect(fake.countCalls('auth print-token')).toBe(2);
    });

    it('a BYTE-IDENTICAL binary still answers from the cache (the control)', async () => {
      // Without this arm the one above would also pass against a cache that had
      // simply stopped working: here dp really did become logged out, the binary
      // did not change, and the cached verdict is expected to stand.
      const fake = createFakeDp({ loggedIn: true });
      const broker = createDpSessionBroker({
        resolveBinary: () => fake.binary,
        now: () => 1_000,
      });

      expect((await broker.probe()).state).toBe('ready');
      rmSync(join(fake.dir, '.logged-in'));

      expect((await broker.probe()).state).toBe('ready');
      expect(fake.countCalls('auth print-token')).toBe(1);
    });

    it('a changed STATE ROOT re-probes — a different dp session is a different verdict', async () => {
      const fake = createFakeDp({ loggedIn: true });
      let workdir: string | undefined;
      const broker = createDpSessionBroker({
        resolveRuntime: () => (workdir === undefined
          ? { dpPath: fake.binary, source: 'system' as const }
          : { dpPath: fake.binary, workdir, source: 'system' as const }),
        now: () => 1_000,
      });

      expect((await broker.probe()).state).toBe('ready');
      workdir = join(tmpdir(), 'dp-state-elsewhere');

      expect((await broker.probe()).state).toBe('ready');
      expect(fake.countCalls('auth print-token')).toBe(2);
    });
  });

  describe('the version floor steers the ladder (DA1.6 item 6)', () => {
    it('demotes a below-floor dp, and an in-place upgrade of the same path clears it', async () => {
      clearDemotedDpBinaries();
      // Two rung-2 candidates, in ladder order: PATH first, the fallback second.
      // Nothing else is runnable, so the ONLY thing that can move the answer
      // from one to the other is the demotion.
      const belowFloor = createFakeDp({ loggedIn: true, version: '12.0.0' });
      const fallback = createFakeDp({ loggedIn: true });
      const seams = {
        env: {},
        pathEnv: belowFloor.dir,
        fallbackPath: fallback.binary,
        configDir: mkdtempSync(join(tmpdir(), 'dp-config-')),
        nessyDir: mkdtempSync(join(tmpdir(), 'dp-nessy-')),
        homeDir: mkdtempSync(join(tmpdir(), 'dp-home-')),
        dirExists: () => true,
        isRunnable: (path: string) => path === belowFloor.binary || path === fallback.binary,
      };
      expect(resolveDpRuntime(seams).dpPath).toBe(belowFloor.binary);

      const outdatedProbe = await createDpSessionBroker({
        resolveBinary: () => belowFloor.binary,
      }).probe();
      expect(outdatedProbe.state === 'ready' && outdatedProbe.outdated).toBe(true);

      // Demoted: the ladder now descends past it to the next runnable rung.
      expect(resolveDpRuntime(seams).dpPath).toBe(fallback.binary);

      // Warn-only is preserved: with the fallback gone it is taken anyway.
      expect(
        resolveDpRuntime({ ...seams, isRunnable: (p: string) => p === belowFloor.binary }).dpPath,
      ).toBe(belowFloor.binary);

      // The corp channel upgrades the SAME path in place; the next probe of it
      // must undo its own demotion, with no test calling `undemoteDpBinary`.
      writeFileSync(join(belowFloor.dir, '.version'), '13.50.0');
      const upgraded = await createDpSessionBroker({
        resolveBinary: () => belowFloor.binary,
      }).probe();
      expect(upgraded.state === 'ready' && upgraded.outdated).toBe(false);
      expect(resolveDpRuntime(seams).dpPath).toBe(belowFloor.binary);
      clearDemotedDpBinaries();
    });
  });
});

/**
 * F1.2 — the URL dp's `login` hands its browser reaches the Sign-in UI as an
 * `auth-url:<url>` status, and a caller that JOINS the running login is handed
 * the same URL instead of starting a second login (two concurrent logins
 * collide on dp's loopback port anyway). `BROWSER` is pointed at a recorder for
 * every arm: the helper forwards there and never to a real browser.
 */
describe('F1.2 · the authorization URL reaches the Sign-in UI', () => {
  const savedBrowser = process.env.BROWSER;
  beforeEach(() => {
    const recorderDir = mkdtempSync(join(tmpdir(), 'broker-browser-recorder-'));
    const recorder = join(recorderDir, 'browser');
    writeFileSync(recorder, '#!/bin/sh\nexit 0\n');
    chmodSync(recorder, 0o755);
    process.env.BROWSER = recorder;
  });
  afterEach(() => {
    if (savedBrowser === undefined) delete process.env.BROWSER;
    else process.env.BROWSER = savedBrowser;
  });
  const authUrl = (): string =>
    `https://as.example.invalid/oauth2/auth?state=${randomBytes(12).toString('hex')}`;

  it('(+) the owner sees auth-url:<url> after waiting-browser and before ready', async () => {
    const url = authUrl();
    const fake = createFakeDp({ loggedIn: false, loginBrowserUrl: url });
    const broker = brokerFor(fake.binary);
    const statuses: DpSessionStatus[] = [];

    await broker.ensure({ ownerId: 'owner', onStatus: (status) => statuses.push(status) });

    expect(statuses.filter((s) => s.startsWith('auth-url:'))).toEqual([`auth-url:${url}`]);
    expect(statuses.indexOf(`auth-url:${url}`)).toBeGreaterThan(statuses.indexOf('waiting-browser'));
    expect(statuses.indexOf(`auth-url:${url}`)).toBeLessThan(statuses.indexOf('ready'));
  });

  it('(-) a dp that never invokes BROWSER emits no auth-url status', async () => {
    const fake = createFakeDp({ loggedIn: false });
    const broker = brokerFor(fake.binary);
    const statuses: DpSessionStatus[] = [];

    await broker.ensure({ ownerId: 'owner', onStatus: (status) => statuses.push(status) });

    expect(statuses).toContain('waiting-browser');
    expect(statuses.some((s) => s.startsWith('auth-url:'))).toBe(false);
  });

  it('(contention) an interactive caller joining the running login is handed ITS url', async () => {
    const url = authUrl();
    const fake = createFakeDp({ loggedIn: false, hangLogin: true, loginBrowserUrl: url });
    const broker = brokerFor(fake.binary);
    const ownerStatuses: DpSessionStatus[] = [];
    const owner = broker.ensure({ ownerId: 'owner', onStatus: (s) => ownerStatuses.push(s) }).catch((e: unknown) => e);
    expect(await waitFor(() => ownerStatuses.includes(`auth-url:${url}`), 5_000)).toBe(true);

    const joinerStatuses: DpSessionStatus[] = [];
    const joiner = broker.ensure({ ownerId: 'joiner', onStatus: (s) => joinerStatuses.push(s) }).catch((e: unknown) => e);

    expect(await waitFor(() => joinerStatuses.includes(`auth-url:${url}`))).toBe(true);
    expect(fake.countCalls('auth login')).toBe(1);
    expect(broker.cancel('owner')).toBe(true);
    expect(await owner).toMatchObject({ code: DpAuthError.Cancelled });
    expect(await joiner).toMatchObject({ code: DpAuthError.Cancelled });
  });

  it('(contention, non-interactive) is still refused — and handed the running URL, never a second login', async () => {
    const url = authUrl();
    const fake = createFakeDp({ loggedIn: false, hangLogin: true, loginBrowserUrl: url });
    const broker = brokerFor(fake.binary);
    const ownerStatuses: DpSessionStatus[] = [];
    const owner = broker.ensure({ ownerId: 'owner', onStatus: (s) => ownerStatuses.push(s) }).catch((e: unknown) => e);
    expect(await waitFor(() => ownerStatuses.includes(`auth-url:${url}`), 5_000)).toBe(true);

    const headlessStatuses: DpSessionStatus[] = [];
    await expect(
      broker.ensure({ ownerId: 'headless', interactive: false, onStatus: (s) => headlessStatuses.push(s) }),
    ).rejects.toMatchObject({ code: DpAuthError.InteractiveLoginUnavailable });
    expect(headlessStatuses).toEqual([`auth-url:${url}`]);
    expect(fake.countCalls('auth login')).toBe(1);

    expect(broker.cancel('owner')).toBe(true);
    expect(await owner).toMatchObject({ code: DpAuthError.Cancelled });
  });
});
