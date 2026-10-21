/**
 * DA1.59 — the app's own `networkProxy` SETTING binds the `dp` exec; DA1.66 —
 * and so does its extra-CA selection, on the same spread and by the same owner
 * decision (one mechanism for every child). The CA arms are at the bottom, with
 * their own docblock: they follow the OPPOSITE rule from the proxy arms, since
 * the CA is emitted whether or not a proxy is enabled.
 *
 * The 1.39.0 release sitting measured the defect end to end (RS-43 B1/B2): with
 * the proxy in the app's SETTING the re-mint reached `as.tbank.ru` outside the
 * operator's proxy, which logged that host zero times; with the same proxy in
 * the app's ENVIRONMENT the child was refused three times in 121 ms. So `dp`
 * honours the proxy names and only the setting was not reaching it.
 *
 * EVERY ARM HERE DRIVES THE REAL RESOLVER — there is no `mock.module` in this
 * file. `dpExecEnv` calls `getProxyEnvVars()`, which calls the real
 * `loadStoredConfig()`, so the settings arms write a real `config.json` into
 * this process's isolated `CONFIG_DIR` (the repo-root preload's per-run temp
 * directory) and restore its bytes afterwards. AGENTS.md §Traps, measured
 * 2026-09-17 on a sibling row: a lever whose only test stubs the path the lever
 * changes measures the lever's KEY and never its POSTURE.
 *
 * WHAT THIS IMPORT COSTS THE TEN dp SUITES — DA1.67, measured 2026-09-17 with
 * the instruments AGENTS.md names, because the first reading of it was taken
 * with none of them and its attribution was wrong.
 *
 * `internal.ts` importing `config/proxy-env.ts` pulls `config/storage.ts`,
 * whose own imports are `credentials/index.ts`, `sessions/index.ts` and
 * `docs/index.ts`. Three readings, all at load 7–10 on this rig:
 *
 *  - **The zero-case control** (`bun test <the 11 dp files> -t '<matches
 *    nothing>'`), which prices the graph with no test body running at all:
 *    **118.55 s**, 0 tests executed.
 *  - **`--reporter=junit` on the same 11 files**: total **313.74 s**, of which
 *    the test bodies account for **135.14 s** — so **~179 s is outside every
 *    body**, which is the graph and the file-level hooks.
 *  - **Paired, alternating single-module imports** (`/usr/bin/time -p bun -e
 *    "await import('./<m>')"`, two rounds): round 1 `creds-store.ts` 10.30 s,
 *    `internal.ts` 74.58 s, `proxy-env.ts` 40.52 s, `storage.ts` 58.23 s,
 *    `index.ts` 86.50 s; round 2, same order, **0.29 / 0.33 / 0.28 s** for the
 *    last three. cpu is 0.04–0.65 s user against 10–86 s real, i.e. ~1 %.
 *
 * SO THE COST IS THE PAGE CACHE, NOT THE MODULE. Cold, the config graph adds
 * tens of seconds; warm, it adds nothing measurable. The same conclusion from
 * the other side: `e2e.test.ts` run ALONE three times, same bytes, same hour,
 * **49.93 s / 46.63 s / 1.26 s**, 6 pass each. A whole-batch run at the cold
 * end therefore loses the 5 000 ms per-test lottery in bulk — 17 fail / 9
 * errors on one run, 2 fail / 1 error on the next, identical bytes.
 *
 * WHY NO FIX LANDS HERE. The row proposed a leaf module for the settings read.
 * `getNetworkProxySettings` is three lines over `loadStoredConfig`, so a leaf
 * copy would be a second spelling of that function's refusal semantics (the
 * storage-layout version check and `refuseStorageLayout`) — the duplication
 * DA1.59 explicitly refused. The change that would actually work is splitting
 * `config/storage.ts` so `loadStoredConfig` stops dragging credentials,
 * sessions and docs, which is size M in the most load-bearing config module in
 * the repo and belongs to no lane's zone this wave. Recorded rather than
 * half-done: the measurement above is the expensive part and should not be
 * re-derived.
 *
 * THE AMBIENT NAMES ARE DELETED BEFORE THEY ARE ASSIGNED, on the restore path
 * too. `HTTP_PROXY`/`HTTPS_PROXY` and their lowercase twins are names Bun
 * pre-creates a slot for: a plain assignment into an unset one lands in that
 * slot and is INVISIBLE to `Object.keys` and to `{ ...process.env }`, which is
 * exactly the spread `dpExecEnv` builds from. Without the delete, the ambient
 * arms below would be testing nothing.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../../../config/paths.ts';
import { dpExecEnv } from '../internal.ts';

const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** Every proxy-shaped name an arm must control, ambient or projected. */
const CONTROLLED_NAMES = [
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy',
  'NODE_USE_ENV_PROXY',
] as const;

/**
 * The extra-CA name, kept OUT of `CONTROLLED_NAMES` on purpose: that list is
 * asserted undefined by the proxy negative arm, and the CA follows the opposite
 * rule (emitted regardless of proxy enablement), so folding it in would make
 * that arm assert the very thing DA1.66 decided against.
 */
const CA_ENV_NAME = 'NODE_EXTRA_CA_CERTS';

const savedEnv = new Map<string, string | undefined>();
let savedConfig: string | undefined | null = null;

/** Delete before assign, always — see the file docblock. */
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  delete process.env[name];
  if (value !== undefined) process.env[name] = value;
}

function clearAmbientProxyNames(): void {
  for (const name of CONTROLLED_NAMES) setEnv(name, undefined);
}

/**
 * Write the stored settings the real `getNetworkProxySettings()` will read.
 * The four envelope fields are what `loadStoredConfig` refuses the file
 * without; `networkProxy` is the block under test.
 */
function storeNetworkProxy(networkProxy: Record<string, unknown> | undefined): void {
  if (savedConfig === null) {
    savedConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf-8') : undefined;
  }
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      ...(networkProxy ? { networkProxy } : {}),
    }, null, 2),
    'utf-8',
  );
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    delete process.env[name];
    if (value !== undefined) process.env[name] = value;
  }
  savedEnv.clear();
  if (savedConfig !== null) {
    if (savedConfig === undefined) rmSync(CONFIG_PATH, { force: true });
    else writeFileSync(CONFIG_PATH, savedConfig, 'utf-8');
    savedConfig = null;
  }
});

describe('dpExecEnv carries the app\'s own networkProxy setting (DA1.59)', () => {
  it('projects the stored proxy into the child when the environment is clean', () => {
    clearAmbientProxyNames();
    storeNetworkProxy({
      enabled: true,
      httpProxy: 'http://proxy.corp.invalid:3128',
      httpsProxy: 'http://proxy.corp.invalid:3128',
    });

    const env = dpExecEnv();

    // Both documented spellings, because the readers disagree on precedence.
    expect(env.HTTP_PROXY).toBe('http://proxy.corp.invalid:3128');
    expect(env.http_proxy).toBe('http://proxy.corp.invalid:3128');
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp.invalid:3128');
    expect(env.https_proxy).toBe('http://proxy.corp.invalid:3128');
    // The loopback exemption ran, and it ran BEFORE the Node flag.
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    // The builder's own keys are untouched by the projection.
    expect(env.DP_NO_WARNINGS).toBe('true');
    expect(typeof env.HOME).toBe('string');
  });

  it('adds nothing when neither the setting nor the environment names a proxy', () => {
    clearAmbientProxyNames();
    storeNetworkProxy(undefined);

    const env = dpExecEnv('/tmp/dp-workdir-fixture');

    for (const name of CONTROLLED_NAMES) expect(env[name]).toBeUndefined();
    // The negative arm is only evidence if the builder still built something.
    expect(env.DP_NO_WARNINGS).toBe('true');
    expect(env.DP_WORKDIR).toBe('/tmp/dp-workdir-fixture');
  });

  it('lets the SETTING outrank an ambient proxy, so the spread is not the delivery path', () => {
    clearAmbientProxyNames();
    // Assigned through the delete-first helper, so this value really is in the
    // `{ ...process.env }` spread — the arm has to be able to lose.
    setEnv('HTTPS_PROXY', 'http://ambient.invalid:8888');
    setEnv('https_proxy', 'http://ambient.invalid:8888');
    expect({ ...process.env }.HTTPS_PROXY).toBe('http://ambient.invalid:8888');

    expect(dpExecEnv().HTTPS_PROXY).toBe('http://ambient.invalid:8888');

    storeNetworkProxy({ enabled: true, httpsProxy: 'http://settings.invalid:3128' });

    const env = dpExecEnv();
    expect(env.HTTPS_PROXY).toBe('http://settings.invalid:3128');
    expect(env.https_proxy).toBe('http://settings.invalid:3128');
  });

  /**
   * DA1.66 — the CA half of the same owner decision, and it is a DIFFERENT rule
   * from the proxy's: `buildNetworkEnvVars` emits `NODE_EXTRA_CA_CERTS`
   * regardless of proxy enablement, so these two arms are the ones that fail if
   * anyone ever gates the whole projection on `settings.enabled`.
   *
   * `NODE_EXTRA_CA_CERTS` is NOT one of the names Bun pre-creates a slot for —
   * measured 2026-09-17 on bun 1.3.14, where the slot list is `TZ`,
   * `NODE_TLS_REJECT_UNAUTHORIZED`, `BUN_CONFIG_VERBOSE_FETCH` and the three
   * proxy pairs — so a plain assignment would have been visible in the spread.
   * It still goes through the delete-first helper, because the whole file's
   * restore path does and a second rule here would be one to get wrong later.
   *
   * No arm asserts the BUNDLED tier: `resolveBundledCaPath` reads the app-owned
   * assets root, which is deliberately unregistered outside a packaged build
   * (that is the `network-config.md:114` threat control), so tier 3 is
   * unreachable from a test process by design and pretending otherwise would
   * pin a path this process cannot have.
   */
  it('carries the app\'s extra CA even with the proxy switched off (DA1.66)', () => {
    clearAmbientProxyNames();
    setEnv(CA_ENV_NAME, undefined);
    storeNetworkProxy({ enabled: false, tlsCaPath: '/etc/nessy-fixture/corp-root.pem' });

    const env = dpExecEnv();

    expect(env[CA_ENV_NAME]).toBe('/etc/nessy-fixture/corp-root.pem');
    // The point of the arm: the CA rode a projection that added no proxy name.
    for (const name of CONTROLLED_NAMES) expect(env[name]).toBeUndefined();
  });

  it('lets the stored tlsCaPath outrank an operator\'s ambient CA (DA1.66)', () => {
    clearAmbientProxyNames();
    setEnv(CA_ENV_NAME, '/etc/nessy-fixture/operator-root.pem');
    // The ambient value really is in the spread `dpExecEnv` builds from, so the
    // setting arm below has to be able to lose.
    expect({ ...process.env }[CA_ENV_NAME]).toBe('/etc/nessy-fixture/operator-root.pem');
    storeNetworkProxy(undefined);
    expect(dpExecEnv()[CA_ENV_NAME]).toBe('/etc/nessy-fixture/operator-root.pem');

    storeNetworkProxy({ enabled: false, tlsCaPath: '/etc/nessy-fixture/user-root.pem' });

    // Tier 2 (custom) over tier 3's operator fallthrough — the ladder in
    // `config/tls-ca-path.ts`, verified at this child rather than assumed.
    expect(dpExecEnv()[CA_ENV_NAME]).toBe('/etc/nessy-fixture/user-root.pem');
  });

  it('refuses a stored SOCKS proxy rather than pointing the child at one', () => {
    clearAmbientProxyNames();
    storeNetworkProxy({ enabled: true, httpsProxy: 'socks5://proxy.corp.invalid:1080' });

    const env = dpExecEnv();

    // `findRefusedProxyUrl` is the same guard the main process applies to
    // itself; a hand-edited config must not route dp somewhere the app refused.
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
  });
});
