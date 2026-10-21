/**
 * P6.84 — the telemetry opt-out zeros on Pi's vendored SDK and codex's shipped
 * binary, pinned so a bump that adds a sink fails loudly.
 *
 * ## What ledger C3 asks, and why the zeros are the answer
 *
 * C3 asks whether an operator's standard opt-out reaches the runtime. On Pi and
 * codex the honest answer is not *"yes, it is honoured"* — it is *"there is
 * nothing there to honour it, and the host covers the gap"*. Two artefact
 * absences carry that, and an absence is only worth as much as its controls, so
 * every one below has a POSITIVE CONTROL on the identical instrument and a
 * FABRICATED name at zero.
 *
 * ## Pi: no vendor telemetry exists for an opt-out name to fail to reach
 *
 * `DO_NOT_TRACK`, `DISABLE_TELEMETRY` and `OTEL_EXPORTER_OTLP_ENDPOINT` score
 * **0 files** over `node_modules/@earendil-works` (control `telemetry` → 82,
 * fabricated → 0), and `pi-telemetry/dist` is index + memory + noop plus a
 * `testing/` directory: a span vocabulary with an in-memory sink and a frozen
 * no-op, no exporter and no network call anywhere in it. The only live Pi signal
 * is OURS, and it is gated by the shared predicate at
 * `server-core/src/pi-harness/otlp-telemetry.ts:281`.
 *
 * ## codex: the runtime honours NEITHER standard name, and the host covers it
 *
 * `DO_NOT_TRACK` and `DISABLE_TELEMETRY` are both absent from the shipped
 * `codex-app-server`, against present controls `OTEL_EXPORTER_OTLP_ENDPOINT` and
 * `CODEX_HOME`. So the unprobed half measures as *a runtime that cannot*, and the
 * cover is `resolveCodexOtelExport`'s `if (telemetryOptedOut(env)) return {}`,
 * read per spawn — one predicate, three runtimes, so they cannot disagree about
 * what an operator's opt-out meant.
 *
 * ## The row's residual READ, and the one thing it got wrong
 *
 * The row expects the source read to show `exporter = none`. At
 * `rust-v0.150.1`, `codex-rs/core/src/config/otel.rs` gives **two of three**:
 *
 * ```rust
 * let exporter = config.exporter.unwrap_or(OtelExporterKind::None);          // :17
 * let trace_exporter = config.trace_exporter.unwrap_or(OtelExporterKind::None); // :20
 * let metrics_exporter = config.metrics_exporter.unwrap_or(OtelExporterKind::Statsig); // :21
 * ```
 *
 * The METRICS sink defaults to `Statsig`, and `codex-rs/otel/src/config.rs`
 * resolves that — **outside debug builds only**, i.e. in exactly the binary we
 * ship — to an `OtlpHttp` exporter pointed at
 * `https://ab.chatgpt.com/otlp/v1/metrics` with a `statsig-api-key` header baked
 * in as a constant. All three strings are in the shipped binary (nonsense control
 * absent), so this is not a theoretical branch.
 *
 * **It is nevertheless closed on our sessions, and NOT by the exporter key.**
 * `codex-rs/core/src/otel_init.rs:70-77` at the same tag:
 *
 * ```rust
 * let metrics_exporter = if config.analytics_enabled.unwrap_or(default_analytics_enabled) {
 *     to_otel_exporter(&config.otel.metrics_exporter)
 * } else { OtelExporter::None };
 * ```
 *
 * P2.450 writes `[analytics] enabled = false` into every session's `config.toml`,
 * so the `unwrap_or(Statsig)` above can never run — which is why that same lane
 * deliberately declined to write `metrics_exporter = "none"` beside it (a guard
 * that cannot fire is protection that is not there). That decision is pinned in
 * `codex-responses-adapter/src/__tests__/config-writer-otel.test.ts`; this file
 * pins the OTHER half — that the sink it defends against is real and present in
 * the artefact — so the two cannot drift apart.
 *
 * ## The instrument
 *
 * `find … -type f -exec grep -a -l -F … {} +`, not `grep -r`: measured warm on
 * this box at load ~10, the same absent needle over 10 319 files took 117 s under
 * `grep -a -q -r -F` and 2 s under the `find` form (~58x, reproduced on a second
 * needle). Presence over the binary is `grep -a -q`, never a count — a
 * `grep -a -c` over a binary counts LINES.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (relative: string): string =>
  fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url));

const PI_VENDOR_DIR = (() => {
  const entry = Bun.resolveSync('@earendil-works/pi-ai', import.meta.dir);
  return entry.slice(0, entry.lastIndexOf('/@earendil-works/')) + '/@earendil-works';
})();

const PI_TELEMETRY_DIST = (() => {
  const entry = Bun.resolveSync('@earendil-works/pi-telemetry', import.meta.dir);
  return entry.slice(0, entry.lastIndexOf('/'));
})();

const countFilesNaming = (dir: string, needle: string): number => {
  const found = Bun.spawnSync([
    'find', dir, '-type', 'f', '-exec', 'grep', '-a', '-l', '-F', '-e', needle, '{}', '+',
  ]);
  return new TextDecoder().decode(found.stdout).split('\n').filter(line => line.length > 0).length;
};

const inArtefact = (path: string, needle: string): boolean =>
  Bun.spawnSync(['grep', '-a', '-q', '-F', '-e', needle, path]).exitCode === 0;

const findStagedCodexAppServer = (): string | undefined => {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  const exe = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
  const candidate = repoFile(`apps/electron/resources/bin/codex/${process.platform}-${arch}/${exe}`);
  return existsSync(candidate) ? candidate : undefined;
};

describe('P6.84 · Pi — there is no vendor telemetry for an opt-out name to fail to reach', () => {
  // ~2-3 s per needle at load ~10 (measured); the budget is that floor with
  // headroom for a loaded wave, not bun's 5 s default.
  it('scores both standard opt-outs and the OTLP endpoint at zero, with both controls', () => {
    for (const name of ['DO_NOT_TRACK', 'DISABLE_TELEMETRY', 'OTEL_EXPORTER_OTLP_ENDPOINT']) {
      expect(countFilesNaming(PI_VENDOR_DIR, name), `${name} appears in Pi's vendored tree`).toBe(0);
    }
    // POSITIVE CONTROL: the instrument reads this tree at all.
    expect(countFilesNaming(PI_VENDOR_DIR, 'telemetry')).toBeGreaterThan(0);
    // ZERO CONTROL: without it, a `find` returning nothing would make the three
    // absences above pass for free.
    expect(countFilesNaming(PI_VENDOR_DIR, 'zzNotATelemetryNameP684')).toBe(0);
  }, 120_000);

  it('ships a span vocabulary with a no-op and an in-memory sink, and no exporter', () => {
    const modules = new Set(
      readdirSync(PI_TELEMETRY_DIST)
        .filter(entry => !entry.endsWith('.map') && !entry.endsWith('.d.ts'))
        .map(entry => entry.replace(/\.js$/, '')),
    );
    // The whole shipped surface. A bump that adds an exporter module lands here.
    expect([...modules].sort()).toEqual(['index', 'memory', 'noop', 'testing']);

    // And no module in it reaches the network. POSITIVE CONTROL on the same read:
    // the no-op sink it DOES ship is named in the barrel.
    const barrel = readFileSync(`${PI_TELEMETRY_DIST}/index.js`, 'utf8');
    expect(barrel).toContain('NOOP_TELEMETRY_CONTEXT');
    for (const module of ['index', 'memory', 'noop']) {
      const source = readFileSync(`${PI_TELEMETRY_DIST}/${module}.js`, 'utf8');
      for (const outbound of ['fetch(', 'node:http', 'node:https', 'XMLHttpRequest']) {
        expect(source, `${module}.js reaches the network via ${outbound}`).not.toContain(outbound);
      }
    }
  });

  it('the only live Pi signal is ours, and the standard opt-out is its first gate', () => {
    const exporter = readFileSync(
      repoFile('packages/server-core/src/pi-harness/otlp-telemetry.ts'),
      'utf8',
    );
    const optOut = exporter.indexOf('if (telemetryOptedOut(env)) return undefined');
    const optIn = exporter.indexOf('if (!telemetryOptedIn(env)) return undefined');
    expect(optOut).toBeGreaterThan(-1);
    // POSITIVE CONTROL, and the ordering claim: the opt-out is read BEFORE the
    // opt-in, so an operator who set both is opted OUT.
    expect(optIn).toBeGreaterThan(optOut);
  });
});

const stagedCodexBinary = findStagedCodexAppServer();

describe('P6.84 · codex — the runtime honours neither standard name', () => {
  /**
   * Skipped VISIBLY when no `codex-app-server` is staged for this platform: the
   * binaries are gitignored, so a clean checkout has none.
   */
  it.skipIf(stagedCodexBinary === undefined)(
    'carries neither opt-out name, against two controls it does carry',
    () => {
      const binary = stagedCodexBinary!;
      for (const absent of ['DO_NOT_TRACK', 'DISABLE_TELEMETRY']) {
        expect(inArtefact(binary, absent), `${absent} is present in ${binary}`).toBe(false);
      }
      // POSITIVE CONTROLS: codex knows the OTLP vocabulary and its own home — so
      // the two absences above are a refusal to speak the opt-out names, not a
      // probe that stopped reading.
      for (const present of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'CODEX_HOME']) {
        expect(inArtefact(binary, present), `${present} is missing from ${binary}`).toBe(true);
      }
      expect(inArtefact(binary, 'zzNotATelemetryNameP684')).toBe(false);
    },
    120_000,
  );

  /**
   * THE SINK `[analytics] enabled = false` DEFENDS AGAINST, pinned in the
   * artefact rather than in prose. `metrics_exporter` defaults to `Statsig`
   * (`core/src/config/otel.rs:21`), which resolves outside debug builds to an
   * OTLP/HTTP exporter at the endpoint below with a `statsig-api-key` header
   * (`otel/src/config.rs:9-31`). If a bump ever removed it, the guard in
   * `config-writer-otel.test.ts` would be defending nothing and this test says so.
   */
  it.skipIf(stagedCodexBinary === undefined)(
    'carries the built-in metrics sink our analytics switch turns off',
    () => {
      const binary = stagedCodexBinary!;
      expect(inArtefact(binary, 'https://ab.chatgpt.com/otlp/v1/metrics')).toBe(true);
      expect(inArtefact(binary, 'statsig-api-key')).toBe(true);
      // The three config keys the gate is written in terms of.
      for (const key of ['metrics_exporter', 'trace_exporter', 'analytics']) {
        expect(inArtefact(binary, key), `${key} is missing from ${binary}`).toBe(true);
      }
      expect(inArtefact(binary, 'zzNotAStatsigNameP684')).toBe(false);
    },
    120_000,
  );
});
