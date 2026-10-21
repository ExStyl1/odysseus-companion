/**
 * Task 4.3 gate: CodexRuntimeManager teardown.
 *
 * kill() sends SIGTERM then escalates to SIGKILL after the grace window when the
 * child ignores SIGTERM, and resolves once the child exits. A child that exits
 * on SIGTERM resolves quickly without escalation.
 *
 * (No live codex binary needed — we drive the manager with a stub executable.)
 * Ownership note: the responses-adapter + managed CODEX_HOME are owned/cleaned
 * by CodexAgent (which created them), not the manager — the plan text put that
 * in the manager, but the creator owns the resource. The agent-level teardown +
 * the Phase-3/4 e2e `pgrep` check cover no-orphan.
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_KILL_TIMEOUT_PREFIX, CodexRuntimeManager } from '../runtime-manager.ts';

// Spawn the current interpreter with a script arg (shebang-launched children do
// not retain a SIGTERM handler under bun-spawn; interpreter+arg does).
function writeScript(body: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-stub-'));
  const path = join(dir, 'stub.mjs');
  writeFileSync(path, body);
  return { dir, path };
}

describe('CodexRuntimeManager.kill', () => {
  test('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    // A handler that no-ops SIGTERM — only uncatchable SIGKILL stops it.
    const { dir, path } = writeScript(
      "process.on('SIGTERM', () => {});\nprocess.stdout.write('READY\\n');\nsetInterval(() => {}, 1000);\n",
    );
    const mgr = new CodexRuntimeManager();
    const child = mgr.spawn({ binaryPath: process.execPath, args: [path], cwd: dir, codexHome: dir });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        reject(new Error(`Stub exited before READY (code=${code}, signal=${signal})`));
      };
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (!output.includes('READY\n')) return;
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        resolve();
      };
      child.once('exit', onExit);
      child.stdout.on('data', onData);
    });

    const start = Date.now();
    await mgr.kill(300); // SIGTERM ignored → SIGKILL after 300ms
    const elapsed = Date.now() - start;

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
    rmSync(dir, { recursive: true, force: true });
  });

  test('resolves quickly when the child exits on SIGTERM (no escalation)', async () => {
    const { dir, path } = writeScript('setInterval(() => {}, 1000);\n'); // no handler → dies on SIGTERM
    const mgr = new CodexRuntimeManager();
    const child = mgr.spawn({ binaryPath: process.execPath, args: [path], cwd: dir, codexHome: dir });
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    await mgr.kill(3000);
    const elapsed = Date.now() - start;

    expect(child.signalCode).toBe('SIGTERM');
    expect(elapsed).toBeLessThan(2000); // resolved well before the 3s grace window
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * P3.376 — the third outcome, which had no bound at all until 2026-09-04.
   *
   * SIGKILL is best-effort: a child in uninterruptible sleep, or one this
   * process cannot signal, never fires `exit`, and `kill()` awaited that event
   * forever while `cleanupRuntimeResources` awaited `kill()` with no deadline of
   * its own. The user's runtime switch simply never completed, and nothing was
   * printed — strictly worse than a refusal, which is at least legible.
   *
   * An unkillable child cannot be manufactured portably, so the SIGNALS are
   * neutered instead: `child.kill` is stubbed to a no-op after spawn, which is
   * the same observable state (both signals sent, no `exit` event) and needs no
   * privileged process. The real child is reaped afterwards so the suite leaves
   * nothing behind.
   */
  test('rejects with a named reason instead of hanging when the child never exits', async () => {
    const { dir, path } = writeScript(
      "process.on('SIGTERM', () => {});\nprocess.stdout.write('READY\\n');\nsetInterval(() => {}, 1000);\n",
    );
    const mgr = new CodexRuntimeManager();
    const child = mgr.spawn({ binaryPath: process.execPath, args: [path], cwd: dir, codexHome: dir });
    await new Promise((r) => setTimeout(r, 100));
    const realKill = child.kill.bind(child);
    // Neither signal lands: the same state as a child that cannot be killed.
    (child as unknown as { kill: () => boolean }).kill = () => true;

    const start = Date.now();
    let message = '';
    try {
      await mgr.kill(200);
      throw new Error('kill() resolved — the bound is gone and a hang is back');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const elapsed = Date.now() - start;

    expect(message).toContain(CODEX_KILL_TIMEOUT_PREFIX);
    // The reason must name what happened, not just that something did.
    expect(message).toContain('did not exit within');
    expect(message).toContain('the child is abandoned');
    // Bounded: grace + the hard deadline, with slack for a loaded box. The
    // lower bound is the control — an implementation that rejected immediately
    // would satisfy the assertions above and would have thrown away the grace.
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(8000);

    realKill('SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  test('kill() is a no-op when nothing was spawned', async () => {
    const mgr = new CodexRuntimeManager();
    await mgr.kill(100); // must not throw
    expect(mgr.process).toBeNull();
  });
});

/**
 * P2.213. Every URL we configure codex with is loopback (the responses adapter
 * and `McpPoolServer`), so an inherited corporate `HTTPS_PROXY` must not eat
 * them — measured: without the exemption the turn dies with `stream
 * disconnected before completion … http://127.0.0.1:<port>/v1/responses`.
 *
 * The proxy arrives through `opts.env` rather than a mutated `process.env`:
 * the spawn merges both into ONE object before the exemption runs, so this is
 * the same code path, and module-scope env mutation is the documented way to
 * manufacture failures in a concurrent `bun test` run.
 */
async function childEnv(
  opts: { env?: Record<string, string>; caCertificatePath?: string },
): Promise<Record<string, string>> {
  const { dir, path } = writeScript(
    'process.stdout.write(JSON.stringify(process.env));\n',
  );
  const mgr = new CodexRuntimeManager();
  const child = mgr.spawn({
    binaryPath: process.execPath,
    args: [path],
    cwd: dir,
    codexHome: dir,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.caCertificatePath === undefined ? {} : { caCertificatePath: opts.caCertificatePath }),
  });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await mgr.kill(100);
  rmSync(dir, { recursive: true, force: true });
  return JSON.parse(out) as Record<string, string>;
}

/**
 * The developer running this suite may well BE behind a corporate proxy, and
 * an ambient `HTTPS_PROXY` would silently decide two of these three cases. So
 * every arm starts from an explicit zero: an empty string reads as "no proxy"
 * to the exemption, and overrides whatever the shell exported.
 */
const NEUTRAL_PROXY_ENV: Record<string, string> = {
  HTTP_PROXY: '', http_proxy: '',
  HTTPS_PROXY: '', https_proxy: '',
  ALL_PROXY: '', all_proxy: '',
  NO_PROXY: '', no_proxy: '',
};

/**
 * P6.255 (children arm) — Node 24 stopped honouring the proxy env in
 * `fetch`/undici unless `NODE_USE_ENV_PROXY` is set, and the name scored 0 files
 * across `packages` + `apps`. The flag is not for `codex-app-server`, which is
 * Rust; it is for the NODE children codex spawns from this env — the bundled
 * `[mcp_servers.session]` launcher, and any stdio MCP server that is a Node
 * program.
 *
 * MEASURED on the shipped binary (2026-09-07): `NODE_USE_ENV_PROXY` occurs 2
 * times inside codex's OWN network-proxy env lists (controls on the same scan:
 * `HTTPS_PROXY` 23, `CODEX_HOME` 36) — so codex uses the mechanism for its own
 * proxy and does nothing for the host operator's.
 *
 * These arms read the env of a REAL spawned child, so a value that never left
 * the parent cannot pass.
 */
describe('CodexRuntimeManager NODE_USE_ENV_PROXY (P6.255)', () => {
  test('sets it when a proxy is configured', async () => {
    const env = await childEnv({
      env: { ...NEUTRAL_PROXY_ENV, HTTPS_PROXY: 'http://proxy.corp:3128' },
    });
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    // The precondition that makes it safe: the loopback exemption already ran,
    // so a Node child honouring the proxy still reaches the in-process adapter
    // directly. Asserted here rather than assumed from call order.
    expect((env.NO_PROXY ?? '').split(',')).toContain('127.0.0.1');
  });

  test.each(['http_proxy', 'HTTP_PROXY', 'ALL_PROXY', 'all_proxy', 'https_proxy'])(
    'the %s spelling arms it too',
    async (name) => {
      const env = await childEnv({ env: { ...NEUTRAL_PROXY_ENV, [name]: 'http://proxy.corp:3128' } });
      expect(env.NODE_USE_ENV_PROXY).toBe('1');
    },
  );

  test('leaves a machine with NO proxy byte-identical — the POSITIVE CONTROL', async () => {
    // Without this, "it is set when a proxy exists" is equally satisfied by
    // setting it unconditionally, which is a change nobody asked for.
    const env = await childEnv({ env: { ...NEUTRAL_PROXY_ENV } });
    expect(env.NODE_USE_ENV_PROXY ?? '').toBe('');
  });

  test('a whitespace-only proxy value is not a proxy', async () => {
    const env = await childEnv({ env: { ...NEUTRAL_PROXY_ENV, HTTPS_PROXY: '   ' } });
    expect(env.NODE_USE_ENV_PROXY ?? '').toBe('');
  });

  test('never overwrites an explicit operator value, including the OFF one', async () => {
    for (const value of ['0', '1', 'anything']) {
      const env = await childEnv({
        env: { ...NEUTRAL_PROXY_ENV, HTTPS_PROXY: 'http://proxy.corp:3128', NODE_USE_ENV_PROXY: value },
      });
      expect(env.NODE_USE_ENV_PROXY).toBe(value);
    }
  });
});

describe('CodexRuntimeManager loopback proxy exemption', () => {
  test('adds both NO_PROXY spellings when a proxy is configured', async () => {
    const env = await childEnv({
      env: { ...NEUTRAL_PROXY_ENV, HTTPS_PROXY: 'http://proxy.corp:3128' },
    });
    for (const spelling of ['NO_PROXY', 'no_proxy'] as const) {
      const entries = (env[spelling] ?? '').split(',');
      expect(entries).toContain('localhost');
      expect(entries).toContain('127.0.0.1');
      expect(entries).toContain('::1');
      // Both IPv6 spellings. `::1` is the one THIS binary honours
      // (hyper-util 0.1.20); `[::1]` is for the Bun/Node children the sandboxed
      // model launches with this env inherited. P2.471.
      expect(entries).toContain('[::1]');
    }
    expect(env.NO_PROXY).toBe(env.no_proxy as string);
  });

  test('extends an existing NO_PROXY instead of replacing it, without duplicates', async () => {
    const env = await childEnv({
      env: {
        ...NEUTRAL_PROXY_ENV,
        HTTP_PROXY: 'http://proxy.corp:3128',
        // Whitespace spelling + a loopback host the user already listed: the
        // first must parse, the second must not appear twice.
        NO_PROXY: '.corp.example 127.0.0.1',
      },
    });
    const entries = (env.NO_PROXY ?? '').split(',');
    expect(entries).toContain('.corp.example');
    expect(entries.filter((e) => e === '127.0.0.1')).toHaveLength(1);
    expect(entries).toContain('localhost');
  });

  test('leaves NO_PROXY untouched when no proxy is configured', async () => {
    // The negative half: a session with no proxy must keep the env it had, so
    // the exemption cannot be blamed for an unrelated change in behaviour.
    const env = await childEnv({
      env: { ...NEUTRAL_PROXY_ENV, NO_PROXY: '.corp.example' },
    });
    expect(env.NO_PROXY).toBe('.corp.example');
    expect(env.no_proxy ?? '').toBe(''); // not back-filled from NO_PROXY
  });
});

/**
 * The machine running this suite may itself sit behind corporate TLS
 * interception and export `SSL_CERT_FILE`, which would decide three of these
 * four arms silently. So every arm starts from an explicit zero — and the zero
 * is an EMPTY STRING on purpose: that is exactly how the binary reads "unset"
 * (`.filter(|value| !value.is_empty())` in `custom_ca.rs`), so the neutral
 * baseline exercises the real semantics instead of routing around them.
 */
const NEUTRAL_CA_ENV: Record<string, string> = {
  CODEX_CA_CERTIFICATE: '',
  SSL_CERT_FILE: '',
};

describe('CodexRuntimeManager custom CA certificate', () => {
  test('hands the app CA to the child as CODEX_CA_CERTIFICATE', async () => {
    // The whole row: the binary's trust store reads this name and ignores
    // `NODE_EXTRA_CA_CERTS`, so the bundle every other runtime verifies against
    // has to arrive re-badged or codex trusts the OS store alone.
    const env = await childEnv({
      env: { ...NEUTRAL_CA_ENV },
      caCertificatePath: '/opt/nessy/tinkoff-bundle.crt',
    });
    expect(env.CODEX_CA_CERTIFICATE).toBe('/opt/nessy/tinkoff-bundle.crt');
    // Never the Node spelling: it is inert for this binary, and writing it
    // would make the child look configured while nothing changed.
    expect(env.NODE_EXTRA_CA_CERTS ?? '').not.toBe('/opt/nessy/tinkoff-bundle.crt');
  });

  test('never displaces an operator SSL_CERT_FILE', async () => {
    // Codex loads exactly ONE bundle, and `CODEX_CA_CERTIFICATE` outranks
    // `SSL_CERT_FILE`, so writing ours here would REPLACE the operator's trust
    // rather than add to it — a working CA control deleted by a "fix".
    const env = await childEnv({
      env: { ...NEUTRAL_CA_ENV, SSL_CERT_FILE: '/etc/ssl/operator-bundle.pem' },
      caCertificatePath: '/opt/nessy/tinkoff-bundle.crt',
    });
    expect(env.CODEX_CA_CERTIFICATE ?? '').toBe('');
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/operator-bundle.pem');
  });

  test('never displaces an operator CODEX_CA_CERTIFICATE', async () => {
    const env = await childEnv({
      env: { ...NEUTRAL_CA_ENV, CODEX_CA_CERTIFICATE: '/etc/ssl/operator-codex.pem' },
      caCertificatePath: '/opt/nessy/tinkoff-bundle.crt',
    });
    expect(env.CODEX_CA_CERTIFICATE).toBe('/etc/ssl/operator-codex.pem');
  });

  test('leaves the child trust store untouched when the app has no CA', async () => {
    // The negative half, and it is asserted on IDENTITY rather than on
    // emptiness: `?? ''` would have read a DELETED key as a preserved one, and
    // a blind `env[VAR] = path` deletes it on the `undefined` arm (node drops
    // undefined values from a child env).
    for (const caCertificatePath of [undefined, '']) {
      const arm = caCertificatePath === undefined ? {} : { caCertificatePath };
      const neutral = await childEnv({ env: { ...NEUTRAL_CA_ENV }, ...arm });
      expect(neutral.CODEX_CA_CERTIFICATE).toBe('');

      // …and a session where the app has no CA of its own must still be a
      // session where the operator's does the job it did before.
      const operator = await childEnv({
        env: { ...NEUTRAL_CA_ENV, SSL_CERT_FILE: '/etc/ssl/operator-bundle.pem' },
        ...arm,
      });
      expect(operator.SSL_CERT_FILE).toBe('/etc/ssl/operator-bundle.pem');
      expect(operator.CODEX_CA_CERTIFICATE).toBe('');
    }
  });
});

/**
 * P2.381 — the remote-control transport is EXPLICITLY disabled (owner ruling
 * 2026-09-01), and the assertion is on what the SUBPROCESS received.
 *
 * `childEnv` spawns a real grandchild and reads its own `process.env`, which is
 * the only instrument that can see this: a name Bun pre-creates a slot for is
 * readable by property in the parent and invisible to the `{...process.env}`
 * spread the child env is built from, so an object-literal assertion can pass
 * while the child gets nothing (AGENTS.md, measured 2026-09-01).
 *
 * The value is asserted as the exact string `1` because that is the whole of
 * codex's own predicate at the tag we ship (`rust-v0.148.0`,
 * `remote_control/mod.rs`): `var_os(...).is_some_and(|value| value == "1")`.
 * Anything else — `true`, `yes`, `""` — reads as NOT disabled, which is the
 * quiet failure this row exists to end.
 */
describe('CodexRuntimeManager remote-control posture', () => {
  test('the child is spawned with the disable marker set to exactly "1"', async () => {
    const env = await childEnv({ env: {} });
    expect(env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED).toBe('1');
  });

  test('an ambient value cannot re-open the transport', async () => {
    // The administrator-visible posture is "off on every runtime", so a shell
    // that exports `…_DISABLED=0` (or anything else) must not decide it. This
    // is the mutant that proves the assignment is unconditional rather than a
    // default-if-absent.
    for (const ambient of ['0', 'false', '', 'true']) {
      const env = await childEnv({
        env: { CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: ambient },
      });
      expect(env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED).toBe('1');
    }
  });

  test('the operator diagnostic names the SAME variable and value the spawner sets', () => {
    // The `doctor` listing spells the name and value a second time, because
    // `apps/cli` does not depend on this package and a workspace dependency to
    // print one sentence would rewrite the lockfile. A second spelling drifts
    // silently, so it is pinned here rather than left to review: this is the
    // whole reason the posture is checkable by an operator at all.
    const doctor = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', 'apps', 'cli', 'src', 'doctor.ts'),
      'utf-8',
    );
    expect(doctor).toContain("env: 'CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED'");
    expect(doctor).toContain("value: '1'");
    // Positive control for the instrument: the file really was read, and a
    // string that is NOT in it is reported absent.
    expect(doctor).toContain('Codex remote control:');
    expect(doctor).not.toContain('CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_ENABLED');
  });
});
