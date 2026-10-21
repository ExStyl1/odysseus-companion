/**
 * P2.408 — the assertion the row exists to add: **a CODEX_HOME this repo builds
 * must produce NO `warning` from the shipped binary**, and if one ever appears
 * this repo must SAY SO instead of dropping it.
 *
 * ## Why an assertion and not just a code path
 *
 * The classifier unit tests pin the strings. They cannot answer the question
 * that matters, which has two halves and only a real boot settles either:
 *
 *  1. **Does the binary warn about the home we actually ship?** The whole point
 *     of P2.384's refusal was that flipping an under-development feature key
 *     would run incomplete behaviour; this arm is the same refusal checked from
 *     the OTHER side — not "we never write the key" (the config-writer tripwire
 *     covers that) but "codex never tells us we did".
 *  2. **Does the notice actually reach a human when it fires?** Before this row
 *     it did not, in any file.
 *
 * ## The rig
 *
 * Bundled `codex-app-server` for the host platform, spawned through the real
 * `CodexRuntimeManager` (SHA gate included) and driven with the real
 * `AppServerClient`, against homes built by the real `writeCodexConfig`.
 * Measured 2026-08-29 on **darwin-arm64** (Apple M1 Pro); darwin-x64 and win32
 * not executed here.
 *
 * ## The window, and the trap it is built around
 *
 * Same trap as `config-warning-live.test.ts` — a timeout tuned on a fast
 * platform manufactures an absence on a slow one — but the window is measured
 * from a DIFFERENT origin, and the difference is not cosmetic.
 *
 * That file times from spawn, because its warning is emitted during boot, so
 * every slow thing about the machine is inside the number it multiplies. Here
 * the frame is co-flushed with the `thread/start` RESPONSE, which `boot()`
 * already awaits — so all of the machine's slowness is absorbed by that await,
 * and the only thing left to bound is the gap between the response and the
 * frame. The control measures exactly that gap and the clean arm waits 25x it,
 * floored at 5 s.
 *
 * Timing from spawn here was measured to be actively wrong, not merely
 * imprecise: the control's spawn-relative latency moved between 764 ms (this
 * file alone) and 6126 ms (four suites in one process), which at 25x asked the
 * clean arm to wait 153 s — inside its own 180 s timeout by less than the spread
 * that produced it. The response-relative gap was 0 ms on every run.
 *
 * If the control ever stops firing, the control case fails and the clean case
 * refuses to run: an absence here is never reported without its control.
 *
 * ## What the control enables, and why it is discovered rather than hardcoded
 *
 * The warning fires only when a feature codex stages as `underDevelopment` is
 * live, so the control has to enable one. Which features hold that stage is a
 * property of the BINARY and moves with it, so the control asks the binary —
 * `experimentalFeature/list` — instead of hardcoding a name that a version bump
 * would silently turn into a stable feature, at which point the control would
 * stop firing and this file would quietly stop testing anything.
 *
 * The four keys P2.384 pinned unwritten are excluded from that pick BY NAME.
 * `request_permissions_tool` is itself `underDevelopment`, so without this guard
 * a future binary could hand the control exactly the key the plan forbids, and a
 * test would be the thing that wrote it.
 *
 * ## Timing, measured on this rig
 *
 * The frame arrives in the same flush as `thread/started`, immediately after
 * `thread/start` resolves — never at `initialize` — and once per thread. That is
 * why `boot()` below starts a thread at all, and it is the measurement that
 * forced `CodexAgent` to DEFER the notice instead of pushing it at a `turnSink`
 * that does not exist yet.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodexConfig, CODEX_API_KEY_ENV } from '@nessy-agent/codex-responses-adapter/config-writer';
import { AppServerClient } from '../app-server-client.ts';
import { CodexRuntimeManager } from '../runtime-manager.ts';
import { CODEX_WARNING_METHOD } from '../server-warning.ts';
import { hostCodexPlatformDir } from '../manifest-verifier.ts';

/** Four levels up from `src/__tests__` is the repo root. */
const PLATFORM_DIR = hostCodexPlatformDir();
const BUNDLED_CODEX = join(
  import.meta.dir, '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'bin', 'codex', PLATFORM_DIR,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/**
 * The four keys P2.384 pinned unwritten. The control picks a feature to enable;
 * it must never pick one of these, and `request_permissions_tool` is a real
 * `underDevelopment` feature on the pinned binary, so this is a live hazard
 * rather than a formality.
 */
const NEVER_ENABLE = new Set([
  'network_access',
  'network_proxy',
  'request_permissions_tool',
  'suppress_unstable_features_warning',
]);

/**
 * Preferred first because it is what P2.408 actually measured and because it is
 * metadata-only. Falls back to whatever the binary reports if it ever leaves the
 * under-development stage.
 */
const PREFERRED_CONTROL_FEATURE = 'executed_tool_call_metadata';

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build the home the product builds, minus the parts that need live ports. */
function buildHome(): string {
  const home = scratchDir('p2408-home-');
  writeCodexConfig({ codexHome: home, model: MODEL, adapterPort: 54321 });
  return home;
}

interface BootResult {
  /**
   * `warning` notifications, with ms from spawn (`ms`) and ms from the
   * `thread/start` RESPONSE (`sinceThreadStart`, negative if it somehow beat it).
   * The second is the one the clean arm's window is derived from; see the
   * file docblock for why the first is not.
   */
  warnings: Array<{ ms: number; sinceThreadStart: number; params: unknown }>;
  /** Only OUR classifier lines — `[app-server stderr]` chunks are excluded. */
  classified: string[];
  /** Answer to `experimentalFeature/list`, when the boot asked for it. */
  features: Array<{ name: string; stage: string }>;
}

/**
 * Boot the real binary on `home`, start a thread, then listen for `windowMs`.
 *
 * The thread is not optional: measured, this notification arrives with
 * `thread/started` and never before it, so a boot that only calls `initialize`
 * would report a false absence.
 */
async function boot(home: string, windowMs: number, opts: { listFeatures?: boolean } = {}): Promise<BootResult> {
  const workspace = scratchDir('p2408-ws-');
  const manager = new CodexRuntimeManager();
  const warnings: BootResult['warnings'] = [];
  const classified: string[] = [];
  let features: BootResult['features'] = [];
  const child = manager.spawn({
    binaryPath: BUNDLED_CODEX,
    cwd: workspace,
    codexHome: home,
    env: { [CODEX_API_KEY_ENV]: 'loopback' },
    platformDir: PLATFORM_DIR,
  });
  // AFTER `spawn`, deliberately — `spawn` runs the pre-spawn SHA gate over
  // ~180 MB, and folding that into the latency the clean arm multiplies by 25
  // measures our hashing rather than the binary's boot.
  const spawnedAt = Date.now();
  // Set the instant the `thread/start` continuation runs. Still NaN when the
  // frame lands means the frame was in the SAME FLUSH as the response — readline
  // dispatches both lines synchronously, ahead of the await's microtask — which
  // is the measured case, and its gap is 0 by construction rather than by
  // rounding.
  let threadStartedAt = Number.NaN;
  const client = new AppServerClient(child, {
    onDiagnostic: (message) => {
      if (message.startsWith('[codex warning]')) classified.push(message);
    },
    onNotification: (method, params) => {
      if (method !== CODEX_WARNING_METHOD) return;
      const now = Date.now();
      warnings.push({
        ms: now - spawnedAt,
        sinceThreadStart: Number.isNaN(threadStartedAt) ? 0 : now - threadStartedAt,
        params,
      });
    },
  });
  try {
    await client.request(
      'initialize',
      {
        clientInfo: { name: 'nessy-p2408-gate', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      { timeoutMs: 60_000 },
    );
    client.notify('initialized');
    if (opts.listFeatures) {
      const listed = await client.request('experimentalFeature/list', {}, { timeoutMs: 30_000 });
      features = ((listed as { data?: unknown } | null)?.data ?? []) as BootResult['features'];
    }
    await client.request('thread/start', { cwd: workspace }, { timeoutMs: 60_000 });
    threadStartedAt = Date.now();
    await new Promise<void>(resolve => setTimeout(resolve, windowMs));
  } finally {
    client.close();
    await manager.kill();
  }
  return { warnings, classified, features };
}

/** Set by the discovery arm; the control refuses to run without it. */
let controlFeature: string | null = null;
/**
 * Set by the positive control; the clean arm refuses to run without it. This is
 * the gap from the `thread/start` response, NOT from spawn — see the docblock.
 */
let controlGapMs: number | null = null;

describe.skipIf(!existsSync(BUNDLED_CODEX))(
  'the projected CODEX_HOME, against the shipped codex-app-server',
  () => {
    /**
     * DISCOVERY, and it runs first so the control cannot hardcode a stage.
     *
     * KILLS: a control whose feature silently graduated out of
     * `underDevelopment` on a binary bump — which would make the positive
     * control stop firing and take the clean arm's meaning with it.
     */
    test('the binary reports at least one under-development feature we may enable', async () => {
      const { features } = await boot(buildHome(), 0, { listFeatures: true });
      expect(features.length).toBeGreaterThan(0);
      // P6.455 — the property `codexUnstableFeatureNames` PARSES on, asserted
      // against the binary rather than described in a comment. THIS ARM DID ITS
      // JOB and the comment it replaces was refuted rather than re-dated: at
      // `rust-v0.150.1` the measurement was 114 names, 0 outside `[a-z0-9_]+`,
      // 0 with a dot, and the parser took the first `.` after the marker as the
      // sentence end on exactly that strength. At `rust-v0.154.0` (2026-09-13,
      // C3.380 lift 2) the binary answers 140 names and one of them,
      // `guardianv2.thread_context`, carries a dot — which truncated the name
      // mid-way and reported a feature called `guardianv2` that does not exist.
      // The parser now accepts dot-separated segments and ends the sentence on a
      // `.` followed by whitespace or the string end; this assertion is the
      // shape it rests on, so the day a name takes a `-`, a `:` or a space it
      // reddens HERE, in one line, before the parser can invent anything.
      for (const feature of features) {
        expect(feature.name).toMatch(/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/);
      }
      const candidates = features
        .filter(f => f.stage === 'underDevelopment' && !NEVER_ENABLE.has(f.name))
        .map(f => f.name);
      expect(candidates.length).toBeGreaterThan(0);
      controlFeature = candidates.includes(PREFERRED_CONTROL_FEATURE)
        ? PREFERRED_CONTROL_FEATURE
        : candidates[0]!;
      // The name that sets this pair's meaning belongs in its own output.
      console.log(`[P2.408] control feature: ${controlFeature} (${candidates.length} candidates)`);
      // The forbidden four must never be reachable by the pick, whatever the
      // binary reports.
      for (const forbidden of NEVER_ENABLE) expect(candidates).not.toContain(forbidden);
    }, 120_000);

    /**
     * POSITIVE CONTROL. It validates the INSTRUMENT — that this rig sees a plain
     * `warning` at all, and that the transport classifies it on the way past.
     *
     * KILLS: a rig that never receives notifications (wrong method name, no
     * thread started, a client closed too early), and any regression that stops
     * `describeCodexServerWarning` from recognising the real payload — including
     * the one that matters most, dropping the `warning` case from
     * `AppServerClient.handleLine`.
     */
    test('POSITIVE CONTROL: an under-development feature is announced, and we say what it costs', async () => {
      expect(controlFeature).not.toBeNull();
      const home = buildHome();
      const configPath = join(home, 'config.toml');
      const projected = readFileSync(configPath, 'utf8');
      // Append INTO the existing `[features]` table rather than opening a second
      // one, which TOML rejects outright.
      expect(projected).toContain('[features]');
      writeFileSync(
        configPath,
        projected.replace('[features]\n', `[features]\n${controlFeature} = true\n`),
        'utf8',
      );

      const result = await boot(home, 5_000);

      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
      controlGapMs = result.warnings[0]!.sinceThreadStart;
      console.log(`[P2.408] control: ${result.warnings[0]!.ms} ms from spawn, ${controlGapMs} ms from the thread/start response`);
      const params = result.warnings[0]!.params as { message?: string; threadId?: string };
      expect(String(params.message)).toContain('Under-development features enabled');
      expect(String(params.message)).toContain(controlFeature!);
      // The half a "just a build note" reading would miss.
      expect(result.classified.length).toBeGreaterThanOrEqual(1);
      expect(result.classified[0]).toContain('UNDER-DEVELOPMENT FEATURES ARE LIVE');
      expect(result.classified[0]).toContain(controlFeature!);
    }, 120_000);

    /**
     * THE ROW'S ASSERTION. The home we actually build, booted for a window this
     * rig's own control latency sets, must produce nothing on this channel.
     *
     * KILLS: any lane that turns on an under-development codex feature — through
     * `[features]`, a profile, or a future config surface — which is exactly the
     * silent behaviour change P2.384 refused and this row was split out to make
     * impossible to miss.
     */
    test('a clean projected home produces NO warning at all', async () => {
      expect(controlGapMs).not.toBeNull();
      // 25x the gap THIS rig showed AFTER its own `thread/start` resolved,
      // floored at 5 s. The machine's own slowness is already absorbed: this arm
      // awaits its `thread/start` before the window opens, exactly as the control
      // did, so what is left to bound is the emission delay and nothing else.
      const window = Math.max(5_000, controlGapMs! * 25);
      console.log(`[P2.408] control gap ${controlGapMs} ms -> clean window ${window} ms`);

      const result = await boot(buildHome(), window);

      expect(result.warnings.map(w => JSON.stringify(w.params))).toEqual([]);
      expect(result.classified).toEqual([]);
    }, 180_000);
  },
);
