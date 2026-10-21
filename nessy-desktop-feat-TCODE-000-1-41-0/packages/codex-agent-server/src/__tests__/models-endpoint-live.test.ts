/**
 * O20 — the shipped binary does NOT ask the loopback adapter for a model
 * catalog, and this is the tripwire that says so out loud.
 *
 * ## Why an assertion and not a comment
 *
 * The out-of-scope register records the opposite: *"codex asks the loopback
 * adapter for a model catalog on every session and gets a 404."* Driven, it
 * does not — `OpenAiModelsManager::should_refresh_models`
 * (`models-manager/src/manager.rs`, `rust-v0.150.1`) is
 * `uses_codex_backend() || has_command_auth()`, and the provider block
 * `writeCodexConfig` emits satisfies neither: it carries `env_key`, and
 * `ModelProviderInfo::has_command_auth` is `self.auth.is_some()`.
 *
 * That makes the absence a property of ONE LINE of the config writer, which
 * belongs to a different file and a different lane. If `env_key` is ever
 * replaced by a `[model_providers.<key>.auth]` table — the two cannot coexist,
 * the binary refuses the whole config with *"provider auth cannot be combined
 * with env_key"* — then codex starts fetching, and a response it accepts must
 * carry the agent's own system prompt (see `MODELS_NOT_SERVED` in
 * `codex-responses-adapter/src/server.ts`). This test turns that from a silent
 * behaviour change into a red test with the reasoning attached.
 *
 * ## The rig, and its control
 *
 * A recorder HTTP server stands in for the adapter on the port `config.toml`
 * points at: it logs every request line and answers 404 to `/models`, which is
 * byte-identical in STATUS to what the real route does (the body is pinned
 * separately, in `codex-responses-adapter/src/__tests__/models-endpoint.test.ts`
 * — that file can see the body and cannot see the binary; this one is the
 * reverse).
 *
 * The POSITIVE CONTROL runs FIRST and on the same binary in the same process:
 * the same home with `env_key` dropped and the `auth` table appended. It must
 * see the request. Its own latency then sets the clean arm's window — the same
 * discipline `config-warning-live.test.ts` uses, and for the same reason: a
 * constant tuned on a fast machine manufactures an absence on a slow one. If the
 * control ever stops firing, the clean arm refuses to run.
 *
 * Measured 2026-09-03 on darwin-arm64: the control saw 2–5
 * `GET /v1/models?client_version=0.148.0` per session; the clean arm saw zero
 * across four separate boots, three of which answered that endpoint 200 with a
 * catalog the binary would have accepted.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeCodexConfig,
  CODEX_API_KEY_ENV,
  CODEX_PROVIDER_KEY,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import { AppServerClient } from '../app-server-client.ts';
import { CodexRuntimeManager } from '../runtime-manager.ts';
import { hostCodexPlatformDir } from '../manifest-verifier.ts';

/** Four levels up from `src/__tests__` is the repo root. */
const PLATFORM_DIR = hostCodexPlatformDir();
const BUNDLED_CODEX = join(
  import.meta.dir, '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'bin', 'codex', PLATFORM_DIR,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Recorder {
  port: number;
  lines: string[];
  close: () => Promise<void>;
}

/** Stands in for the adapter: records request lines, 404s everything. */
function startRecorder(): Promise<Recorder> {
  const lines: string[] = [];
  const server: Server = createServer((req, res) => {
    lines.push(`${req.method} ${req.url ?? ''}`);
    req.resume();
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'recorder', type: 'invalid_request_error' } }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        lines,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

interface BootResult {
  /** Every `GET …/models` seen, with ms from spawn. */
  modelsRequests: Array<{ ms: number; line: string }>;
}

/**
 * Boot the real binary against `home`, drive the calls a session makes before
 * its first turn, then listen for `windowMs` more.
 *
 * No turn is sent: a turn needs an upstream, and the fetch under test happens
 * at catalog-resolution time, which `model/list` and `thread/start` both reach.
 */
async function boot(home: string, recorder: Recorder, windowMs: number): Promise<BootResult> {
  const workspace = scratchDir('o20-ws-');
  const manager = new CodexRuntimeManager();
  const child = manager.spawn({
    binaryPath: BUNDLED_CODEX,
    cwd: workspace,
    codexHome: home,
    env: { [CODEX_API_KEY_ENV]: 'loopback' },
    platformDir: PLATFORM_DIR,
  });
  // AFTER `spawn`, which runs the pre-spawn SHA gate over ~180 MB; timing from
  // before it folds our own cost into the latency the clean arm scales its
  // window from.
  const spawnedAt = Date.now();
  const seen = () => recorder.lines
    .filter((line) => line.startsWith('GET ') && line.includes('/models'))
    .map((line) => ({ ms: Date.now() - spawnedAt, line }));
  const client = new AppServerClient(child, { onDiagnostic: () => {}, onNotification: () => {} });
  try {
    await client.request(
      'initialize',
      {
        clientInfo: { name: 'nessy-o20-gate', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      { timeoutMs: 60_000 },
    );
    client.notify('initialized');
    for (const includeHidden of [false, true]) {
      await client.request('model/list', { includeHidden }, { timeoutMs: 30_000 });
    }
    await client.request('thread/start', { cwd: workspace, model: MODEL }, { timeoutMs: 30_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, windowMs));
  } finally {
    client.close();
    await manager.kill();
  }
  return { modelsRequests: seen() };
}

/** The home the product builds. */
function buildHome(recorder: Recorder): string {
  const home = scratchDir('o20-home-');
  writeCodexConfig({ codexHome: home, model: MODEL, adapterPort: recorder.port });
  return home;
}

/**
 * The same home with the ONE line that decides it swapped: `env_key` out, a
 * command-token `auth` table in. Deliberately not a variant `writeCodexConfig`
 * can emit — this is a control for the INSTRUMENT, not a shape we ship.
 */
function openTheGate(home: string): void {
  const configPath = join(home, 'config.toml');
  const text = readFileSync(configPath, 'utf8').replace(/^env_key = .*$\n/m, '');
  writeFileSync(
    configPath,
    `${text}\n[model_providers.${CODEX_PROVIDER_KEY}.auth]\ncommand = "/bin/echo"\nargs = ["loopback-token"]\n`,
    'utf8',
  );
}

/** Set by the positive control; the clean arm refuses to run without it. */
let controlLatencyMs: number | null = null;

describe.skipIf(!existsSync(BUNDLED_CODEX))(
  'GET {base_url}/models, against the shipped codex-app-server',
  () => {
    /**
     * POSITIVE CONTROL, first on purpose. It validates the INSTRUMENT — that
     * this recorder is on the port codex was pointed at and that a catalog
     * fetch is visible to it at all.
     *
     * KILLS: a rig watching the wrong port, a config whose `base_url` moved,
     * and any future codex bump that stops fetching even with command auth.
     */
    test('POSITIVE CONTROL: with command auth instead of env_key, the binary DOES fetch the catalog', async () => {
      const recorder = await startRecorder();
      try {
        const home = buildHome(recorder);
        openTheGate(home);

        const result = await boot(home, recorder, 3_000);

        expect(result.modelsRequests.length).toBeGreaterThanOrEqual(1);
        expect(result.modelsRequests[0]!.line).toContain('client_version=');
        controlLatencyMs = result.modelsRequests[0]!.ms;
      } finally {
        await recorder.close();
      }
    }, 180_000);

    /**
     * THE ROW'S ASSERTION. The home we actually build must produce NO catalog
     * fetch at all.
     *
     * KILLS: a config-writer change that swaps `env_key` for a command-token
     * `auth` table. That change would silently start feeding codex a catalog
     * response, and the only response it accepts is one carrying an agent
     * system prompt we would have to author — which replaces codex's own.
     */
    test('the home writeCodexConfig builds produces NO catalog fetch', async () => {
      expect(controlLatencyMs).not.toBeNull();
      // 3x the delay THIS rig showed, floored at 3 s, so the window grows with a
      // slow machine instead of manufacturing an absence on it.
      //
      // Not 25x, which is the multiplier `config-warning-live.test.ts` uses:
      // there the measured quantity is a small delta after boot, here it is
      // dominated BY the boot (7.975 s measured, load 16.6), so 25x would put a
      // 3-minute sleep inside a 4-minute budget and time the suite out rather
      // than strengthen it. The clean arm has also already passed the control's
      // own trigger point — same spawn, same `initialize`, same two
      // `model/list`s, same `thread/start` — before this window even opens, so
      // the total observation exceeds the control's by more than the multiplier
      // alone suggests.
      const window = Math.max(3_000, controlLatencyMs! * 3);
      // The number that bounds this arm belongs in its own output.
      console.log(`[O20] control latency ${controlLatencyMs} ms -> clean window ${window} ms`);
      const recorder = await startRecorder();
      try {
        const home = buildHome(recorder);

        const result = await boot(home, recorder, window);

        expect(result.modelsRequests).toEqual([]);

        // LIVENESS CONTROL for THIS recorder instance, after the count is taken.
        // An absence over a log nobody proved was recording is not an absence;
        // a dead listener and a silent binary look identical from here.
        const selfCheck = await fetch(`http://127.0.0.1:${recorder.port}/v1/models?self-check=1`);
        expect(selfCheck.status).toBe(404);
        expect(recorder.lines.filter((line) => line.includes('/models'))).toHaveLength(1);
      } finally {
        await recorder.close();
      }
    }, 240_000);
  },
);
