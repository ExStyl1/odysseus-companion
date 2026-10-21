import { describe, it, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { printToken, login } from '../dp-api.ts';
import { createDpSessionBroker } from '../session-broker.ts';
import { relatchHomeDirForTests } from '../../../config/home-latch.ts';
import { DpAuthError, DpAuthServiceError } from '../errors.ts';
import { createFakeDp } from './fake-dp.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe('printToken', () => {
  it('returns the token when dp is logged in', async () => {
    const fake = createFakeDp({ loggedIn: true, token: 'tok-abc' });
    expect(await printToken(fake.binary)).toBe('tok-abc');
  });

  it('returns undefined when dp reports needs-login', async () => {
    const fake = createFakeDp({ loggedIn: false });
    expect(await printToken(fake.binary)).toBeUndefined();
  });

  it('returns the token even when dp writes a warning to stderr', async () => {
    const fake = createFakeDp({
      loggedIn: true,
      token: 'dp-access-token-value',
      printTokenStderrWarning: 'warning: a new Spirit CLI version is available',
    });
    expect(await printToken(fake.binary)).toBe('dp-access-token-value');
  });

  it('passes DP_NO_WARNINGS=true to the child (a banner would otherwise break the single-line parse)', async () => {
    const fake = createFakeDp({
      loggedIn: true,
      token: 'dp-access-token-value',
      printTokenBannerUnlessNoWarnings: true,
    });
    expect(await printToken(fake.binary)).toBe('dp-access-token-value');
  });

  it(
    'times out a hung print-token, and the budget is the thing under test rather than the clock',
    async () => {
      // C3.391 · the budget is INJECTED. This case used to wait out the real
      // constant and assert `< 6s`, which pinned the value 5_000 in a sentence
      // the constant could move away from — and did. What has to stay true is
      // that a budget which expires maps to Timeout; the VALUE of the shipped
      // budget is proven by the slow-but-successful arm below, which is the
      // only one that can tell 5 s from 30 s.
      const fake = createFakeDp({ loggedIn: true, hangPrintToken: true });
      const start = Date.now();
      let error: unknown;
      try {
        await printToken(fake.binary, { timeoutMs: 300 });
      } catch (e) {
        error = e;
      }
      const elapsed = Date.now() - start;
      expect(error).toBeInstanceOf(DpAuthServiceError);
      expect((error as DpAuthServiceError).code).toBe(DpAuthError.Timeout);
      expect(elapsed).toBeLessThan(5_000);
    },
    10_000,
  );

  it(
    'a SLOW but successful print-token is a token, not a Timeout (the C3.391 budget)',
    async () => {
      // The discriminating arm, and the whole of C3.391's "done means": six
      // seconds is ABOVE the 5 s budget this shipped with and below the 30 s it
      // is sized to now, so this case fails on the old constant and passes on
      // the new one. dp's own startup hook is what spends that time on a machine
      // whose corporate host is unreachable (nessy-cli's AIDT-7828; the readings
      // are quoted at `PRINT_TOKEN_TIMEOUT_MS`), and the user who pays for it is
      // signed in with a perfectly good session.
      const fake = createFakeDp({
        loggedIn: true,
        token: 'dp-token-after-a-slow-hook',
        printTokenDelaySeconds: 6,
      });
      const start = Date.now();
      expect(await printToken(fake.binary)).toBe('dp-token-after-a-slow-hook');
      expect(Date.now() - start).toBeGreaterThan(5_000);
    },
    60_000,
  );

  /**
   * F1.360 — dp 13.60.0 carries TWO needs-login sentences (both measured in the
   * binary with `grep -aoF`, 2026-09-23), and only the first was recognised: the
   * second was reported as `ExecFailed` ("Developer Platform command failed")
   * where the user needed "sign in". Which sentence dp prints WHEN is not yet
   * measured (F1.364 item 1), so both must read as needs-login.
   */
  it.each([
    ['dp 13.50.0 sentence', 'no access token found, you need to authorize user or service account first'],
    ['dp 13.60.0 second sentence', 'access token not found. you should relogin'],
    ['the second sentence behind a cobra "Error:" prefix', 'Error: access token not found. you should relogin'],
  ])('reads %s on a non-zero exit as needs-login (F1.360)', async (_label, message) => {
    const fake = createFakeDp({ loggedIn: false, needsLoginStderr: `${message}\n` });
    expect(await printToken(fake.binary)).toBeUndefined();
    expect(fake.countCalls('auth print-token')).toBe(1);
  });

  it('the broker reports the second sentence as needs-login, not error:ExecFailed (F1.360)', async () => {
    const fake = createFakeDp({
      loggedIn: false,
      needsLoginStderr: 'access token not found. you should relogin\n',
    });
    const broker = createDpSessionBroker({ resolveBinary: () => fake.binary });
    try {
      const state = await broker.probe();
      expect(state.state).toBe('needs-login');
    } finally {
      broker.dispose();
    }
  });

  it('an UNRELATED stderr line on a non-zero exit stays ExecFailed, never a login (F1.360 control)', async () => {
    const fake = createFakeDp({
      loggedIn: false,
      needsLoginStderr: 'error: failed to load plugin registry: permission denied\n',
    });
    let error: unknown;
    try {
      await printToken(fake.binary);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DpAuthServiceError);
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExecFailed);
  });

  it('maps caller abort to Cancelled', async () => {
    const fake = createFakeDp({ loggedIn: true, hangPrintToken: true });
    const controller = new AbortController();
    const p = printToken(fake.binary, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    let error: unknown;
    try {
      await p;
    } catch (e) {
      error = e;
    }
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.Cancelled);
  });
});

describe('login', () => {
  it('resolves and leaves dp logged in on success', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'tok-xyz' });
    await login(fake.binary);
    // print-token now succeeds because the login run created the marker.
    expect(await printToken(fake.binary)).toBe('tok-xyz');
    expect(fake.countCalls('auth login')).toBe(1);
  });

  it('cancels via signal, killing the dp child (SIGTERM)', async () => {
    const fake = createFakeDp({ hangLogin: true });
    const controller = new AbortController();
    const p = login(fake.binary, { signal: controller.signal });
    // Abort only once the child has actually started (its trap is installed);
    // a fixed timer can fire before a cold exec runs on slower filesystems.
    await waitFor(() => fake.countCalls('auth login') >= 1);
    controller.abort();
    let error: unknown;
    try {
      await p;
    } catch (e) {
      error = e;
    }
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.Cancelled);
    // The child's SIGTERM trap flushes its marker asynchronously, after Node's
    // abort rejects the promise — poll briefly for it.
    expect(await waitFor(() => fake.gotSigterm())).toBe(true);
  });

  it('maps a non-zero exit to LoginFailed', async () => {
    // /usr/bin/false exits 1 with no abort → LoginFailed.
    let error: unknown;
    try {
      await login('/usr/bin/false');
    } catch (e) {
      error = e;
    }
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.LoginFailed);
  });
});

/**
 * F1.362 — the interactive Sign-in uses dp's own `dp auth ensure` (reuse or
 * refresh, else ONE browser login shared across processes) when the installed
 * dp has it, and `dp auth login` otherwise. Support is detected by probing
 * `dp auth ensure --help` and reading ensure's own NAME line, never by version.
 */
describe('F1.362 · login() prefers dp auth ensure when dp has it', () => {
  it('(+) a dp with ensure: ensure runs, login does not, and the session is ready', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'tok-ensure', hasEnsure: true });
    await login(fake.binary);
    expect(fake.countCalls('auth ensure')).toBe(1);
    expect(fake.countCalls('auth login')).toBe(0);
    expect(await printToken(fake.binary)).toBe('tok-ensure');
  });

  it('(−) a dp without ensure: login runs, ensure never runs past its --help probe', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'tok-login' });
    await login(fake.binary);
    expect(fake.countCalls('auth login')).toBe(1);
    expect(fake.countCalls('auth ensure')).toBe(0);
    expect(await printToken(fake.binary)).toBe('tok-login');
  });

  it('BOUNDARY — a --help that answers exit 0 with the PARENT\'s help is not support', async () => {
    const fake = createFakeDp({ loggedIn: false, ensureHelpLikeParent: true });
    await login(fake.binary);
    expect(fake.countCalls('auth login')).toBe(1);
    expect(fake.countCalls('auth ensure')).toBe(0);
  });

  it('ensure keeps login\'s contract: the URL relay, a cancel kills the child, a non-zero exit is LoginFailed', async () => {
    const relayed: string[] = [];
    const relay = createFakeDp({ hasEnsure: true, loginBrowserUrl: 'https://sso.example.invalid/authorize?x=1' });
    await login(relay.binary, { onAuthUrl: (url) => relayed.push(url), forwardBrowser: '' });
    expect(relayed).toEqual(['https://sso.example.invalid/authorize?x=1']);

    const hang = createFakeDp({ hasEnsure: true, hangLogin: true });
    const controller = new AbortController();
    const pending = login(hang.binary, { signal: controller.signal });
    await waitFor(() => hang.countCalls('auth ensure') >= 1);
    controller.abort();
    const cancelled = await pending.then(() => undefined, (e: unknown) => e);
    expect((cancelled as DpAuthServiceError).code).toBe(DpAuthError.Cancelled);
    expect(await waitFor(() => hang.gotSigterm())).toBe(true);

    const failing = createFakeDp({ hasEnsure: true, failLogin: true });
    const failed = await login(failing.binary).then(() => undefined, (e: unknown) => e);
    expect((failed as DpAuthServiceError).code).toBe(DpAuthError.LoginFailed);
    expect(failing.countCalls('auth login')).toBe(0);
  });

  it('BOUNDARY — a non-interactive caller runs neither ensure (it opens a browser) nor login', async () => {
    const fake = createFakeDp({ loggedIn: false, hasEnsure: true });
    const broker = createDpSessionBroker({ resolveBinary: () => fake.binary });
    try {
      const refused = await broker.ensure({ ownerId: 'headless', interactive: false }).then(() => undefined, (e: unknown) => e);
      expect((refused as DpAuthServiceError).code).toBe(DpAuthError.InteractiveLoginUnavailable);
      expect(fake.calls().filter((call) => call.startsWith('auth ensure') || call === 'auth login')).toEqual([]);
    } finally {
      broker.dispose();
    }
  });
});

/**
 * DA1.6, the first of the row's two named live defects: both execs used to pass
 * `{ ...process.env, DP_NO_WARNINGS: 'true' }` and nothing else, so the process
 * that MINTS the token followed a confirmed managed `HOME` live while
 * `getCredsPath()` stayed latched — minting against the new home's dp state and
 * storing at the old home's path.
 *
 * Every arm reads the env the CHILD actually received (`fake.childEnv()`), not
 * the object this module built: AGENTS.md records a managed-env spread that was
 * correct in the parent and empty in the subprocess, and only a real grandchild
 * separated the two.
 */
describe('every dp exec carries the latched HOME and the workdir of its record (DA1.6)', () => {
  afterEach(() => relatchHomeDirForTests());

  it('print-token runs under the LATCHED home, not a live one', async () => {
    const latched = mkdtempSync(join(tmpdir(), 'dp-latched-home-'));
    relatchHomeDirForTests(latched);
    const fake = createFakeDp({ loggedIn: true, token: 'tok-home' });

    expect(await printToken(fake.binary)).toBe('tok-home');
    expect(fake.childEnv()).toHaveLength(1);
    expect(fake.childEnv()[0]).toContain(`HOME=${latched}|`);
  });

  it('print-token carries DP_WORKDIR only when the record has one', async () => {
    const withRoot = createFakeDp({ loggedIn: true, token: 'tok-a' });
    await printToken(withRoot.binary, { workdir: '/tmp/dp-state-a' });
    expect(withRoot.childEnv()[0]).toContain('|DP_WORKDIR=/tmp/dp-state-a|');

    // The dominant case (Target scheme clause 3): no workdir, so the key is
    // OMITTED and dp uses its own `~/.dp`. The negative arm of the same rule.
    const shared = createFakeDp({ loggedIn: true, token: 'tok-b' });
    await printToken(shared.binary);
    expect(shared.childEnv()[0]).toContain('|DP_WORKDIR=|');
  });

  it('login runs under the latched home and its workdir too', async () => {
    const latched = mkdtempSync(join(tmpdir(), 'dp-latched-home-'));
    relatchHomeDirForTests(latched);
    const fake = createFakeDp();

    await login(fake.binary, { workdir: '/tmp/dp-state-login' });
    expect(fake.childEnv()[0]).toBe(
      `HOME=${latched}|DP_WORKDIR=/tmp/dp-state-login|DP_NO_WARNINGS=true`,
    );
  });

  it('login is NOT handed DP_AI_MCP_SKIP_LOGIN — the one command that must open a browser', async () => {
    const fake = createFakeDp();
    await login(fake.binary);
    // `dpRuntimeEnvironment` (the dp MCP CHILD's env) carries that switch; this
    // module builds its own env for exactly this reason, and the fixture records
    // the three keys the exec env is allowed to set.
    expect(fake.childEnv()[0]).not.toContain('DP_AI_MCP_SKIP_LOGIN');
  });
});

/**
 * F1.2 — dp never PRINTS its authorization URL (RQ-dp-device, 13.50.0 source);
 * its opener prepends `BROWSER` to its candidate list and passes the URL as the
 * first argument. `login` points `BROWSER` at a temporary helper that records
 * the URL and FORWARDS it, so the tab still opens and the app can show the link
 * when the tab cannot be seen. Every arm forwards to a RECORDER script, never to
 * a real browser, and every URL is built from random bytes.
 */
function createBrowserRecorder(): { path: string; urls(): string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'dp-browser-recorder-'));
  const path = join(dir, 'browser');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${dir}/urls.log'\n`);
  chmodSync(path, 0o755);
  return {
    path,
    urls: () => {
      const log = join(dir, 'urls.log');
      return existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter((l) => l.length > 0) : [];
    },
  };
}

function fakeAuthUrl(): { url: string; state: string } {
  const state = randomBytes(12).toString('hex');
  return {
    url: `https://as.example.invalid/oauth2/auth?client_id=dp-cli&state=${state}&code_challenge=${randomBytes(16).toString('hex')}`,
    state,
  };
}

describe('login captures the authorization URL through BROWSER (F1.2)', () => {
  const savedBrowser = process.env.BROWSER;
  afterEach(() => {
    if (savedBrowser === undefined) delete process.env.BROWSER;
    else process.env.BROWSER = savedBrowser;
  });

  it('(+) hands the URL to onAuthUrl ONCE and forwards it to the browser ONCE', async () => {
    const { url } = fakeAuthUrl();
    const fake = createFakeDp({ loginBrowserUrl: url });
    const recorder = createBrowserRecorder();
    const seen: string[] = [];

    await login(fake.binary, { onAuthUrl: (u) => seen.push(u), forwardBrowser: recorder.path });

    expect(seen).toEqual([url]);
    expect(await waitFor(() => recorder.urls().length >= 1)).toBe(true);
    expect(recorder.urls()).toEqual([url]);
    // The child ran OUR helper, not the recorder directly.
    expect(fake.browserPaths()).toHaveLength(1);
    expect(fake.browserPaths()[0]).not.toBe(recorder.path);
  });

  it('(boundary) a user-set BROWSER is the FORWARD target, not overwritten', async () => {
    const { url } = fakeAuthUrl();
    const fake = createFakeDp({ loginBrowserUrl: url });
    const userBrowser = createBrowserRecorder();
    process.env.BROWSER = userBrowser.path;
    const seen: string[] = [];

    await login(fake.binary, { onAuthUrl: (u) => seen.push(u) });

    expect(seen).toEqual([url]);
    expect(await waitFor(() => userBrowser.urls().length >= 1)).toBe(true);
    expect(userBrowser.urls()).toEqual([url]);
    expect(fake.browserPaths()[0]).not.toBe(userBrowser.path);
  });

  it('(-) a dp that never invokes BROWSER yields no URL, and the Timeout path is unchanged', async () => {
    const fake = createFakeDp({ hangLogin: true });
    const recorder = createBrowserRecorder();
    const seen: string[] = [];
    let error: unknown;
    try {
      await login(fake.binary, { timeoutMs: 300, onAuthUrl: (u) => seen.push(u), forwardBrowser: recorder.path });
    } catch (e) {
      error = e;
    }
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.Timeout);
    expect(seen).toEqual([]);
    expect(recorder.urls()).toEqual([]);
  });

  it('records the URL at 0600 in a private directory that is gone once login returns', async () => {
    const { url } = fakeAuthUrl();
    const fake = createFakeDp({ loginBrowserUrl: url });
    const recorder = createBrowserRecorder();
    let modeAtCapture: number | undefined;

    await login(fake.binary, {
      forwardBrowser: recorder.path,
      onAuthUrl: () => {
        const helperDir = dirname(fake.browserPaths()[0]!);
        modeAtCapture = statSync(join(helperDir, 'url')).mode & 0o777;
      },
    });

    expect(modeAtCapture).toBe(0o600);
    expect(existsSync(dirname(fake.browserPaths()[0]!))).toBe(false);
  });

  it('a URL that is not http(s) is forwarded but never relayed to the app', async () => {
    const fake = createFakeDp({ loginBrowserUrl: 'file:///etc/hosts' });
    const recorder = createBrowserRecorder();
    const seen: string[] = [];

    await login(fake.binary, { onAuthUrl: (u) => seen.push(u), forwardBrowser: recorder.path });

    expect(seen).toEqual([]);
    expect(await waitFor(() => recorder.urls().length >= 1)).toBe(true);
  });

  it('without an onAuthUrl listener BROWSER is left exactly as the user set it (no helper)', async () => {
    const { url } = fakeAuthUrl();
    const fake = createFakeDp({ loginBrowserUrl: url });
    const userBrowser = createBrowserRecorder();
    process.env.BROWSER = userBrowser.path;

    await login(fake.binary);

    expect(fake.browserPaths()).toEqual([userBrowser.path]);
  });

  it(
    'the debug log names the capture and its origin, never the query string (a CHILD, the only instrument that reads the sink)',
    async () => {
      const { url, state } = fakeAuthUrl();
      const fake = createFakeDp({ loginBrowserUrl: url });
      const recorder = createBrowserRecorder();
      const script = join(mkdtempSync(join(tmpdir(), 'dp-login-log-')), 'child.ts');
      const dpApi = resolve(import.meta.dir, '../dp-api.ts');
      writeFileSync(
        script,
        `import { login } from ${JSON.stringify(dpApi)};\n` +
          `await login(process.env.FAKE_DP!, { onAuthUrl: () => {}, forwardBrowser: process.env.RECORDER! });\n` +
          `console.error('CHILD-DONE');\n`,
      );
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, NESSY_DEBUG: '1', FAKE_DP: fake.binary, RECORDER: recorder.path },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.stdout.on('data', (d) => { stdout += String(d); });
      const code = await new Promise<number | null>((done) => child.on('close', done));

      expect({ code, done: stderr.includes('CHILD-DONE') }).toEqual({ code: 0, done: true });
      // Positive control: the sink is being read, and the capture line is in it.
      expect(stderr).toContain('authorization URL captured');
      expect(stderr).toContain('https://as.example.invalid');
      // The query string — and the random state inside it — appear nowhere.
      expect(`${stderr}${stdout}`).not.toContain(state);
      expect(`${stderr}${stdout}`).not.toContain('client_id=');
    },
    30_000,
  );
});
