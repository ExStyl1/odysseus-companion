/**
 * C3.253 — codex's plugin-startup egress, driven against the binary we SHIP.
 *
 * ## What this file exists to hold shut
 *
 * A codex boot used to reach the public internet before a single token was
 * generated. W15-e measured it on 2026-09-11 with `RUST_LOG=debug`: every boot
 * logged *"failed to warm featured plugin ids cache … remote featured plugin
 * request to `https://chatgpt.com/backend-api/plugins/featured?platform=codex`
 * failed with status 403"*, and the same boot materialised
 * `CODEX_HOME/.tmp/plugins-clone-<rand>/` with 25 plugin directories — tens of
 * megabytes, which is what made a session home 26–76 MB instead of 2.8 MB.
 *
 * The SOURCE at the pinned tag says where all of it comes from, and it is one
 * gate. `codex-rs/core-plugins/src/manager.rs` at `rust-v0.150.1`,
 * `maybe_start_plugin_startup_tasks_for_config`, opens with
 * `if config.plugins_enabled {` and everything the boot does over the network
 * lives inside that block:
 *
 *  - `maybe_start_curated_repo_sync_for_config` → `start_curated_repo_sync` →
 *    `sync_openai_plugins_repo`, whose constants (`startup_sync.rs`) are
 *    `GITHUB_API_BASE_URL = "https://api.github.com"`,
 *    `OPENAI_PLUGINS_GIT_URL = "https://github.com/openai/plugins.git"` and
 *    `CURATED_PLUGINS_BACKUP_ARCHIVE_API_URL =
 *    "https://chatgpt.com/backend-api/plugins/export/curated"`, cloning into
 *    `.tmp/plugins-clone-*` (`prepare_curated_repo_parent_and_temp_dir`);
 *  - `featured_plugin_ids_for_config` → `remote_legacy::fetch_remote_featured_plugin_ids`,
 *    which builds `{chatgpt_base_url}/plugins/featured`;
 *  - the remote catalogue / installed-bundle refreshes beside them.
 *
 * `config.plugins_enabled` is `self.features.enabled(Feature::Plugins)`
 * (`core/src/config/mod.rs`, `plugins_config_input`), i.e. the `[features]`
 * key `plugins` — `Stage::Stable`, `default_enabled: true`
 * (`codex-rs/features/src/lib.rs`). So the host writes `plugins = false`, and
 * this file is the proof that the key is (a) accepted by the shipped binary and
 * (b) load-bearing.
 *
 * ## The rig, and why it performs NO real egress
 *
 * Both arms run behind a loopback HTTP proxy sink that RECORDS the host each
 * request or `CONNECT` names and then refuses it, with loopback exempted
 * exactly as `applyLoopbackNoProxy` exempts it in the product. Nothing leaves
 * the machine in either arm — the control arm's whole point is that the
 * attempt is recorded rather than completed. No turn is started and no
 * credential is used: the adapter port in the config is never dialled.
 *
 * The control arm is the same config with the one `plugins = false` line
 * stripped, which is both "the config before this row" and "the config after an
 * upstream rename". Without it a green shipped arm would be indistinguishable
 * from a binary that no longer reaches out at all.
 *
 * Skips where the binary is absent — it is a build-time download and
 * gitignored, so CI's Linux container has none; the armed-check below makes
 * that skip deliberate rather than invisible, in the idiom
 * `config-writer-hooks-live.test.ts` and `sandbox-enforcement.test.ts`
 * established.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml } from '../config-writer.ts';
import { AppServer } from './app-server-rig.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const BIN = join(
  REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN);

/**
 * Per-test budget. Spawning a ~185 MB binary, waiting out `initialize` and then
 * giving the detached startup threads room to attempt their first request
 * dominates; the assertions are milliseconds. Generous because this branch runs
 * several lanes at once and timing is part of no claim here.
 */
const BUDGET_MS = 240_000;

/** How long a boot is left running after `initialized` for the sink to hear it. */
const SETTLE_MS = 20_000;

const ROOT = HAVE_BIN ? mkdtempSync(join(tmpdir(), 'nessy-codex-plugin-egress-')) : '';
const WS = join(ROOT, 'ws');

afterAll(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

/** A port that is never dialled: no turn is started in this file. */
const UNDIALLED_ADAPTER_PORT = 1;

/** The three non-loopback hosts codex's plugin startup reaches, per the source above. */
const PLUGIN_STARTUP_HOSTS = ['chatgpt.com', 'api.github.com', 'github.com'] as const;

interface ProxySink {
  readonly port: number;
  /** Every authority a request or CONNECT named, in arrival order. */
  readonly seen: string[];
  close(): Promise<void>;
}

/**
 * A refusing HTTP proxy that records what was asked for.
 *
 * `request` catches plain-HTTP proxying (absolute-form request line); `connect`
 * catches the HTTPS tunnel, which is what every URL above actually uses. Both
 * record and then fail the attempt, so the recording IS the measurement.
 */
async function startProxySink(): Promise<ProxySink> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    try {
      seen.push(new URL(req.url ?? '/', 'http://unknown.invalid').host);
    } catch { seen.push('unparsable'); }
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('nessy proxy sink: refused');
  });
  server.on('connect', (req, socket) => {
    seen.push((req.url ?? '').split(':')[0] ?? 'unparsable');
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
  });
  server.on('clientError', (_err, socket) => { socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('proxy sink got no port');
  return {
    port: address.port,
    seen,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

interface BootResult {
  /** Non-loopback authorities the sink heard during this boot. */
  readonly reached: string[];
  /** `.tmp` entries the boot created under CODEX_HOME (the clone lands here). */
  readonly tmpEntries: string[];
  readonly configWarnings: unknown[];
  readonly configText: string;
}

/** One boot of the shipped binary on a home this writer built, behind the sink. */
async function boot(name: string, opts: { stripPluginsKey?: boolean } = {}): Promise<BootResult> {
  const sink = await startProxySink();
  const home = join(ROOT, name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(WS, { recursive: true });
  let configText = buildCodexConfigToml({
    codexHome: home,
    model: 'tgpt/deepseek-v4-flash-0731',
    adapterPort: UNDIALLED_ADAPTER_PORT,
    mode: 'default',
    sandboxGloballyEnabled: false,
  });
  if (opts.stripPluginsKey) {
    const stripped = configText.replace(/^plugins = false\n/m, '');
    if (stripped === configText) throw new Error('control arm found no `plugins = false` line to strip');
    configText = stripped;
  }
  writeFileSync(join(home, 'config.toml'), configText);

  const proxy = `http://127.0.0.1:${sink.port}`;
  const loopback = 'localhost,127.0.0.1,::1';
  const child = spawn(BIN, [], {
    cwd: WS,
    env: {
      ...process.env,
      CODEX_HOME: home,
      // Every non-loopback attempt is funnelled at the sink and refused there,
      // so the control arm records the egress WITHOUT performing it.
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
      http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
      NO_PROXY: loopback, no_proxy: loopback,
      // `git` is spawned by the curated sync; never let it block on a prompt.
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const server = new AppServer(child);
  try {
    await server.request('initialize', {
      clientInfo: { name: 'nessy-codex-plugin-egress', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.notify('initialized');
    await new Promise(r => setTimeout(r, SETTLE_MS));
  } finally {
    server.kill();
    await sink.close();
  }
  const tmp = join(home, '.tmp');
  return {
    reached: sink.seen.filter(host => !['localhost', '127.0.0.1', '::1', ''].includes(host)),
    tmpEntries: existsSync(tmp) ? readdirSync(tmp) : [],
    configWarnings: server.notifications.filter(n => n.method === 'configWarning').map(n => n.params),
    configText,
  };
}

describe('codex plugin-startup egress — the detector is armed', () => {
  test('the bundled codex binary is present, or the skip is deliberate', () => {
    if (HAVE_BIN) {
      expect(HAVE_BIN).toBe(true);
      return;
    }
    console.warn(
      `[codex-plugin-egress] SKIPPED: no codex binary at ${BIN}. C3.253's claim that`
      + ' `[features] plugins = false` stops the featured-plugin fetch and the curated clone was NOT'
      + ' re-driven in this run; it remains a dated reading.',
    );
    expect(HAVE_BIN).toBe(false);
  });

  test('the writer emits the key at all', () => {
    const config = buildCodexConfigToml({
      codexHome: join(ROOT || tmpdir(), 'shape-only'),
      model: 'tgpt/deepseek-v4-flash-0731',
      adapterPort: UNDIALLED_ADAPTER_PORT,
    });
    expect(config).toContain('plugins = false');
    // Under `[features]`, not as a bare top-level key beside `[plugins]`
    // (which is codex's per-plugin entry table, a different thing entirely).
    const features = config.indexOf('[features]');
    expect(features).toBeGreaterThan(-1);
    expect(config.indexOf('plugins = false')).toBeGreaterThan(features);
  });
});

describe.if(HAVE_BIN)('codex plugin-startup egress — what the shipped binary does', () => {
  test('CONTROL: without the key, a boot reaches out before any turn', async () => {
    const result = await boot('control', { stripPluginsKey: true });
    // Printed, not only asserted: the exact set is upstream's and moves with a
    // codex lift, so the next reader wants the reading rather than the verdict.
    console.warn(
      `[codex-plugin-egress] CONTROL reached (refused at the sink): ${JSON.stringify(result.reached)};`
      + ` CODEX_HOME/.tmp: ${JSON.stringify(result.tmpEntries)}`,
    );
    // The detector can see egress at all — this is what makes the shipped arm
    // below mean "we stopped it" rather than "nothing happens here any more".
    const named = result.reached.filter(h => (PLUGIN_STARTUP_HOSTS as readonly string[]).includes(h));
    expect(named.length).toBeGreaterThan(0);
  }, BUDGET_MS);

  test('SHIPPED: `plugins = false` is accepted and no plugin-startup egress is attempted', async () => {
    const result = await boot('shipped');
    // (1) The key does not cost us the file. codex fails a config open and
    // WHOLE-FILE, so an unaccepted key would take `[permissions]`, the
    // execpolicy pointer and every deny floor with it.
    expect(result.configWarnings).toEqual([]);
    // (2) Nothing was asked of the proxy at all.
    expect(result.reached).toEqual([]);
    // (3) And the curated clone directory was never even prepared.
    expect(result.tmpEntries.filter(e => e.startsWith('plugins'))).toEqual([]);
  }, BUDGET_MS);
});
