/**
 * C3.16 (D1.35, born P6.227; ledger A71) — whether to pin
 * `[windows] sandbox_private_desktop` for codex the way the Pi harness does.
 *
 * ## The measurement the row ordered, and it did NOT need a Windows rig
 *
 * D1.35's own note says the read-back is owed "the day a Windows arm exists".
 * It is not: codex publishes its own effective configuration through
 * `config/read`, with an `origins` map naming the layer each key came from, and
 * that RPC answers on every platform. Driven below on the shipped
 * `darwin-arm64/codex-app-server` (`rust-v0.150.1`, `packages/codex-protocol/manifest.json`),
 * one boot per arm, no credential and no turn.
 *
 * | arm | `config.windows` | `origins["windows.sandbox_private_desktop"]` |
 * | --- | --- | --- |
 * | our shipped config, each of the SEVEN permission modes | `null` | absent |
 * | our shipped config, sandbox master switch OFF | `null` | absent |
 * | CONTROL: the same config plus `[windows] sandbox_private_desktop = false` | `{sandbox: null, sandbox_private_desktop: false}` | our `config.toml`, `type: "user"` |
 *
 * The control is what makes the seven nulls a reading: the binary ACCEPTS a
 * `[windows]` block on a non-Windows host, publishes the value back, and
 * attributes it to our layer — so the absence is ours, not the RPC's.
 *
 * ## The decision: the block is DELIBERATELY NOT WRITTEN
 *
 * Four readings, none of them invented:
 *
 *  1. **codex's own default is already the protective value.** The release
 *     `config-schema.json` says of `sandbox_private_desktop`: *"Defaults to
 *     `true`. Set to `false` to launch the final sandboxed child process on
 *     `Winsta0\\Default` instead of a private desktop."* That is the same value
 *     `packages/server-core/src/pi-harness/isolation/windows.ts` writes
 *     explicitly, so the two runtimes do not diverge in what the user GETS —
 *     only in pedigree, one by decision and one by inheritance.
 *  2. **Pinning cannot be the enforcement point anyway.** An administrator's
 *     requirement overwrites this key INSIDE codex — it is one of the seven
 *     fields `apply_to_config` writes straight over the loaded config, which is
 *     why `packages/shared/src/agent/codex-config-requirements.ts`
 *     (`CODEX_REQUIREMENT_ENFORCEMENT`) recorded `windowsSandboxPrivateDesktop`
 *     as `'codex'` until the field left the struct at `rust-v0.156.1`.
 *     Whatever this writer emitted would be replaced.
 *  3. **Every unnecessary key costs the whole file.** codex fails a config OPEN
 *     and WHOLE-FILE on one bad line, taking `[permissions]`, the execpolicy
 *     pointer and every deny floor with it — the posture
 *     `buildCodexHooksToml` and `buildCodexExecpolicyRules` already take.
 *  4. **Native-first, and the host is the seam for the DIFFERENCE.** The
 *     difference here is not behavioural, so the honest thing is to record it
 *     rather than to write a redundant key. What the seam owes is a tripwire,
 *     which is the first case below: if upstream ever stops defaulting this to
 *     `true`, the inheritance stops being safe and this file goes red on the
 *     lift rather than after a Windows incident.
 *
 * ## THE TRIPWIRE FIRED at `rust-v0.156.1` (F1.255, 2026-09-24) — and it fired SAFE
 *
 * The lift did not flip the default; it RETIRED the key. `WindowsToml` in the
 * release `config-schema.json` now declares `sandbox` alone, and the shipped
 * binary answers a written `[windows] sandbox_private_desktop = false` with a
 * `configWarning` naming the key as ignored and giving codex's own reason —
 * *"legacy Windows sandboxes always use a private desktop"* — from
 * `config/src/strict_config.rs` at the tag. So the protective value this file's
 * decision inherited is no longer a default a config could turn off: it is
 * unconditional, and there is no key left to write. The decision stands with a
 * stronger premise, and the two cases that read the key now read its absence:
 * the tripwire asserts the retirement (a key that RETURNS reddens it, and its
 * default must then be re-read), and the driven control asserts codex's own
 * refusal, with `[windows] sandbox` as the positive control that the block is
 * still parsed and still attributed to our layer.
 *
 * ## The residue, named
 *
 * `config/read` reports what the CONFIG LAYER says, not what the Windows
 * sandbox launcher does with an unset value; that last step is only observable
 * on Windows, and stays with the parked Windows rig (P3.7 / D1.96). What is
 * settled here is the config half, which is the half this writer owns.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml, type CodexPermissionMode } from '../config-writer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');
const BIN = join(
  REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN);
const BUDGET_MS = 180_000;

const ALL_MODES: CodexPermissionMode[] = [
  'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
];

const ROOT = HAVE_BIN ? mkdtempSync(join(tmpdir(), 'nessy-codex-windows-')) : '';
const WS = join(ROOT, 'ws');
afterAll(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

const BASE = {
  model: 'w16g-probe-model',
  adapterPort: 1,
  deniedReadPaths: ['/private/nessy/credentials.enc'],
} as const;

interface ConfigRead {
  config: Record<string, unknown>;
  origins: Record<string, unknown>;
}

/** The smallest app-server client that can ask one question. */
class Rig {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly warnings: unknown[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', line => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const id = msg.id;
      if (typeof id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (!p) return;
        if (msg.error !== undefined) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      if (typeof id === 'number' && typeof msg.method === 'string') {
        this.child.stdin.write(`${JSON.stringify({ id, result: { decision: 'denied' } })}\n`);
        return;
      }
      if (msg.method === 'configWarning') this.warnings.push(msg.params);
    });
    child.stderr.resume();
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timed out: ${method}`)); }, 60_000);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string): void { this.child.stdin.write(`${JSON.stringify({ method, params: {} })}\n`); }
  kill(): void { this.child.kill('SIGKILL'); }
}

/** Boot one `CODEX_HOME` this writer built and ask codex what it resolved. */
async function readBack(name: string, toml: string): Promise<{ read: ConfigRead; warnings: unknown[] }> {
  const home = join(ROOT, name);
  mkdirSync(home, { recursive: true });
  mkdirSync(WS, { recursive: true });
  writeFileSync(join(home, 'config.toml'), toml);
  const rig = new Rig(spawn(BIN, [], {
    cwd: WS,
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams);
  try {
    await rig.request('initialize', {
      clientInfo: { name: 'nessy-codex-windows', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rig.notify('initialized');
    await new Promise(resolve => setTimeout(resolve, 800));
    const read = await rig.request('config/read', { includeLayers: false, cwd: WS }) as ConfigRead;
    return { read, warnings: [...rig.warnings] };
  } finally {
    rig.kill();
  }
}

describe('C3.16 — the [windows] block is deliberately not written', () => {
  test('THE TRIPWIRE (fired safe at rust-v0.156.1): codex retired `sandbox_private_desktop`, so no config can turn the private desktop off', () => {
    // The decision rested on the default being the protective value. At
    // `rust-v0.156.1` codex removed the key outright (the private desktop is
    // unconditional for legacy Windows sandboxes), so the release schema no
    // longer declares it. A lift that RESTORES the key reddens here — and its
    // default must then be re-read before the inheritance is trusted again
    // (at `rust-v0.154.0` it read "Defaults to `true`").
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
      definitions: { WindowsToml: { properties: Record<string, unknown> } };
    };
    const properties = schema.definitions.WindowsToml.properties;
    expect(properties.sandbox_private_desktop).toBeUndefined();
    // Positive control on the same read, so a renamed/emptied definition cannot pass.
    expect(Object.keys(properties)).toEqual(['sandbox']);
  });

  test('this writer emits no [windows] block in any mode, in either switch position', () => {
    for (const mode of ALL_MODES) {
      for (const sandboxGloballyEnabled of [true, false]) {
        const toml = buildCodexConfigToml({ ...BASE, codexHome: '/tmp/x', mode, sandboxGloballyEnabled });
        expect(toml).not.toContain('[windows]');
        expect(toml).not.toContain('sandbox_private_desktop');
        // CONTROL: the emission that IS conditional on the same inputs still
        // fires, so "no [windows]" is not an empty config.
        expect(toml).toContain('[permissions.nessy_runtime]');
      }
    }
  });
});

describe('codex [windows] read-back — the detector is armed', () => {
  test('the bundled codex binary is present, or the skip is deliberate', () => {
    if (HAVE_BIN) {
      expect(HAVE_BIN).toBe(true);
      return;
    }
    console.warn(
      `[codex-windows] SKIPPED: no codex binary at ${BIN}. The read-back in this file's header was NOT`
      + ' re-driven in this run; it remains a dated reading.',
    );
    expect(HAVE_BIN).toBe(false);
  });
});

describe.if(HAVE_BIN)('codex [windows] read-back — driven on the shipped binary', () => {
  test('every permission mode resolves `windows: null`, attributed to no layer', async () => {
    for (const mode of ALL_MODES) {
      const { read, warnings } = await readBack(`mode-${mode}`, buildCodexConfigToml({
        ...BASE, codexHome: join(ROOT, `mode-${mode}`), mode, sandboxGloballyEnabled: true,
      }));
      expect(warnings).toEqual([]);
      // The key EXISTS in the published shape and carries nothing — codex does
      // not materialise a default `WindowsToml` for a config that omits it.
      expect(Object.keys(read.config)).toContain('windows');
      expect(read.config.windows).toBeNull();
      expect(read.origins['windows.sandbox_private_desktop']).toBeUndefined();
    }
  }, BUDGET_MS);

  test('CONTROL: a written `[windows] sandbox` is accepted and attributed to our layer', async () => {
    // Without this arm the seven nulls above would also be produced by an RPC
    // that simply never reports `windows`, and by a binary that discarded a
    // `[windows]` block on a non-Windows host. (Until `rust-v0.156.1` this arm
    // wrote `sandbox_private_desktop = false`; that key is retired — the next case.)
    const home = join(ROOT, 'written-sandbox');
    const toml = `${buildCodexConfigToml({
      ...BASE, codexHome: home, mode: 'default', sandboxGloballyEnabled: true,
    })}\n[windows]\nsandbox = "unelevated"\n`;
    const { read, warnings } = await readBack('written-sandbox', toml);

    expect(warnings).toEqual([]);
    expect(read.config.windows).toEqual({ sandbox: 'unelevated' });
    const origin = read.origins['windows.sandbox'] as { name?: { type?: string } } | undefined;
    expect(origin?.name?.type).toBe('user');
  }, BUDGET_MS);

  test('the retired key is REFUSED by name with codex\'s own reason, and the private desktop cannot be turned off', async () => {
    // F1.255 — the driven half of the tripwire above: codex does not merely
    // stop documenting the key, it ignores a written one and says why.
    const home = join(ROOT, 'written-false');
    const toml = `${buildCodexConfigToml({
      ...BASE, codexHome: home, mode: 'default', sandboxGloballyEnabled: true,
    })}\n[windows]\nsandbox_private_desktop = false\n`;
    const { read, warnings } = await readBack('written-false', toml);

    const summaries = warnings.map(warning => String((warning as { summary?: unknown }).summary ?? ''));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('`windows.sandbox_private_desktop` is ignored');
    expect(summaries[0]).toContain('legacy Windows sandboxes always use a private desktop');
    // The effective config carries no such field: the value never took effect.
    // (`origins` still lists the key — it maps the raw layer, not the parse.)
    expect(read.config.windows).toEqual({ sandbox: null });
  }, BUDGET_MS);
});
