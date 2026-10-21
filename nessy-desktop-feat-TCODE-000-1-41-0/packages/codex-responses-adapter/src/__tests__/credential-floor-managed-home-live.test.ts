/**
 * F1.192 — the SHIPPED `codex-app-server` expands a `~/` floor key with the
 * child's own `HOME`, so the host must hand it the latched home, absolute.
 *
 * Three arms over one fixture pair — a FAKE creds file under a "latched" home and
 * another under a "managed" home (never the real `~/.nessy/dp_auth_creds.json`):
 *
 * - **the defect's mechanism** — `HOME=<managed>` and the `~/`-anchored key the host
 *   emitted before F1.192: the latched file is READ and the managed one refused.
 *   This arm pins codex's behaviour, not ours; if it ever stops leaking, codex has
 *   started anchoring `~` elsewhere and `anchorCodexFloorOnCredentialHome` is worth
 *   re-reading, not deleting blindly.
 * - **the fix** — `HOME=<managed>` and the patterns through
 *   `anchorCodexFloorOnCredentialHome`: the latched file is refused.
 * - **the control** — `HOME=<latched>`: the helper hands back the same array, the
 *   `~/` key is emitted as before, and the latched file is refused.
 *
 * Every arm first asks the app-server whether it ACCEPTED `nessy_runtime`: a
 * rejected profile fails OPEN and would make the refusals below meaningless.
 * Fixtures live under `~/.cache` rather than `tmpdir()` for the reason
 * `sandbox-enforcement.test.ts` records. Skips visibly where the binary is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorCodexFloorOnCredentialHome, buildCodexConfigToml } from '../config-writer.ts';
import { AppServer } from './app-server-rig.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const BIN = join(
  REPO_ROOT,
  'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN) && process.platform !== 'win32';

const ROOT = join(homedir(), '.cache', 'nessy-codex-floor-managed-home');
const WS = join(ROOT, 'ws');
const LATCHED = join(ROOT, 'latched');
const MANAGED = join(ROOT, 'managed');
const CREDS = (home: string): string => join(home, '.nessy', 'dp_auth_creds.json');
const MARKER = 'NESSY-F1192-FAKE-TOKEN';
const FLOOR = ['~/.nessy/**'] as const;
const BUDGET_MS = 180_000;

interface Reading {
  readonly accepted: boolean | undefined;
  readonly toml: string;
  readonly latchedLeaked: boolean;
  readonly managedLeaked: boolean;
}

async function readUnder(name: string, patterns: readonly string[], childHome: string): Promise<Reading> {
  const codexHome = join(ROOT, 'homes', name);
  mkdirSync(codexHome, { recursive: true });
  const toml = buildCodexConfigToml({
    codexHome, model: 'm', adapterPort: 1, mode: 'default', sandboxGloballyEnabled: false,
    deniedReadPaths: [], deniedReadPatterns: patterns,
  });
  writeFileSync(join(codexHome, 'config.toml'), toml);
  const child = spawn(BIN, [], {
    cwd: WS,
    env: { ...process.env, HOME: childHome, CODEX_HOME: codexHome, COMPANY_LLM_API_KEY: 'loopback' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const server = new AppServer(child, { requestTimeoutMs: 120_000 });
  try {
    await server.request('initialize', {
      clientInfo: { name: 'nessy-f1192', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.notify('initialized');
    const listed = await server.request('permissionProfile/list', {}, 30_000) as {
      data?: { id?: string; allowed?: boolean }[];
    };
    const leaked = async (path: string): Promise<boolean> => {
      const r = await server.request('command/exec', { command: ['/bin/cat', path], cwd: WS, timeoutMs: 15_000 }, 60_000) as {
        stdout?: string;
      };
      return (r.stdout ?? '').includes(MARKER);
    };
    return {
      accepted: listed.data?.find(p => p.id === 'nessy_runtime')?.allowed,
      toml,
      latchedLeaked: await leaked(CREDS(LATCHED)),
      managedLeaked: await leaked(CREDS(MANAGED)),
    };
  } finally {
    server.kill();
  }
}

beforeAll(() => {
  if (!HAVE_BIN) return;
  rmSync(ROOT, { recursive: true, force: true });
  for (const dir of [WS, join(LATCHED, '.nessy'), join(MANAGED, '.nessy')]) mkdirSync(dir, { recursive: true });
  writeFileSync(CREDS(LATCHED), `${MARKER}-latched\n`);
  writeFileSync(CREDS(MANAGED), `${MARKER}-managed\n`);
  writeFileSync(join(WS, 'README.md'), 'workspace\n');
});

afterAll(() => {
  if (!HAVE_BIN) return;
  rmSync(ROOT, { recursive: true, force: true });
});

describe('F1.192 — the detector is armed', () => {
  test('the pinned codex binary is present, or the skip is said out loud', () => {
    if (!HAVE_BIN) console.warn(`[f1192-live] SKIPPED: no codex binary at ${BIN} (or win32).`);
    expect(typeof HAVE_BIN).toBe('boolean');
  });
});

describe.if(HAVE_BIN)('F1.192 — a managed HOME and the codex credential floor, against the shipped binary', () => {
  test('mechanism: a `~/` key is compiled against the CHILD HOME — the latched creds file is read', async () => {
    const r = await readUnder('tilde_managed', FLOOR, MANAGED);
    expect(r.accepted).toBe(true);
    expect(r.toml).toContain('"~/.nessy" = "deny"');
    expect(r.managedLeaked).toBe(false);
    expect(r.latchedLeaked).toBe(true);
  }, BUDGET_MS);

  test('fix: the patterns anchored on the latched home — the latched creds file is refused', async () => {
    const patterns = anchorCodexFloorOnCredentialHome(FLOOR, { credentialHome: LATCHED, childHome: MANAGED });
    const r = await readUnder('anchored_managed', patterns, MANAGED);
    expect(r.accepted).toBe(true);
    expect(r.toml).toContain(`"${LATCHED}/.nessy" = "deny"`);
    expect(r.latchedLeaked).toBe(false);
  }, BUDGET_MS);

  test('control: HOME unmoved — the same array, the `~/` key, and the latched file refused', async () => {
    const patterns = anchorCodexFloorOnCredentialHome(FLOOR, { credentialHome: LATCHED, childHome: LATCHED });
    expect(patterns).toBe(FLOOR);
    const r = await readUnder('tilde_latched', patterns, LATCHED);
    expect(r.accepted).toBe(true);
    expect(r.toml).toContain('"~/.nessy" = "deny"');
    expect(r.latchedLeaked).toBe(false);
    expect(r.managedLeaked).toBe(true);
  }, BUDGET_MS);
});
