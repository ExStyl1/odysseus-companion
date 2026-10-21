/**
 * F1.157 — what a user WITHOUT `dp` gets from the built-in dp MCP set, driven
 * through the REAL resolution ladder rather than a stubbed `() => null`.
 *
 * SIT-11 (2026-09-20, packaged 1.40.0) measured the whole surface with `dp`
 * installed and signed in; the `available: false` branch was never driven. The
 * neighbouring arms (`settings-builtin-dp-mcp.test.ts`, `builtin-dp-servers.test.ts`)
 * inject `resolveDpPath: () => null`, which proves the view's builder and not
 * that the product's own ladder produces that `null` on a dp-less machine. These
 * arms hand the view the production `resolveDpBinary` with only its PATHS
 * redirected into a scratch directory, and read four things:
 *
 *  1. **The ladder over empty directories answers `DpNotFound`, and the view it
 *     feeds lists all the servers beside the named diagnostic.** The row asked
 *     for "a profile with the dp ladder pointed at an empty directory"; this is
 *     that, without a profile.
 *  2. **The switch does NOT refuse.** It writes and reads back with dp missing —
 *     "a preference is a preference" (`builtin-dp-mcp-preferences.ts`'s view
 *     docblock) — so the row's "the enable switch's refusal" is a premise the
 *     source refutes: there is no refusal to read, only a sentence.
 *  3. **`available: true` is a PRESENCE reading, not a working-dp reading.** An
 *     unauthenticated `dp` stub on PATH makes the set available and is never
 *     executed — the positive control proves the marker file the stub writes
 *     when run is an instrument that can see an execution.
 *  4. **Why no live profile can reach branch 1 on a machine that has
 *     `/usr/local/bin/dp`:** the fallback rung is unconditional. With `NESSY_DP`
 *     unset and PATH empty the ladder still answers it; only the test seam
 *     `fallbackPath` moves it, and no environment variable does. A live case
 *     that wants the dp-less branch therefore needs a machine without that file
 *     (`scripts/cdp/cases/rs-105.ts` says so instead of timing out).
 *
 * Nothing here reads `~/.nessy/dp_auth_creds.json`, runs `dp auth`, or touches
 * the developer's real config: the root `bunfig.toml` preload points
 * `NESSY_CONFIG_DIR` at a private temp directory, and every path the ladder is
 * given lives under this file's own `mkdtemp` root.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDpBinary, resolveDpRuntime, type ResolveDpRuntimeOptions } from '../../auth/dp/dp-binary.ts';
import { DpAuthError } from '../../auth/dp/errors.ts';
import { BUILTIN_DP_MCP_SERVERS } from '../../mcp/builtin-dp-servers.ts';
import { readBuiltinDpMcpSettingsView, setBuiltinDpMcpServerEnabled } from '../builtin-dp-mcp-preferences.ts';
import { CONFIG_DIR } from '../paths.ts';
import { loadStoredConfig, saveConfig } from '../storage.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'f1157-no-dp-'));
const EMPTY_BIN = join(ROOT, 'empty-bin');
const STUB_BIN = join(ROOT, 'stub-bin');
const RAN_MARKER = join(ROOT, 'stub-ran.txt');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
let seeded = false;

/** Every rung of the ladder pointed into this file's scratch root. */
function ladder(pathEnv: string): ResolveDpRuntimeOptions {
  return {
    env: {},
    pathEnv,
    fallbackPath: join(ROOT, 'no-such-fallback', 'dp'),
    configDir: join(ROOT, 'config'),
    nessyDir: join(ROOT, 'nessy-home'),
    homeDir: join(ROOT, 'home'),
    // The state root is a WRITE the ladder performs on one rung; nothing here
    // needs it on disk, so it is not created.
    ensureStateRoot: () => {},
  };
}

/** The production resolver, wrapped the way `defaultResolveDpPath` wraps it. */
function viaLadder(pathEnv: string): () => string | null {
  return () => {
    try {
      return resolveDpBinary(ladder(pathEnv));
    } catch {
      return null;
    }
  };
}

beforeAll(() => {
  mkdirSync(EMPTY_BIN, { recursive: true });
  mkdirSync(STUB_BIN, { recursive: true });
  // An UNAUTHENTICATED dp: it refuses whatever it is asked, and it leaves a mark
  // when it runs at all — which is the only thing arm 3 reads.
  writeFileSync(
    join(STUB_BIN, 'dp'),
    `#!/bin/sh\nprintf 'ran %s\\n' "$*" >> '${RAN_MARKER}'\necho 'dp: not authenticated, run dp auth login' >&2\nexit 1\n`,
    'utf8',
  );
  chmodSync(join(STUB_BIN, 'dp'), 0o755);
  if (!existsSync(CONFIG_FILE)) {
    saveConfig({ workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null });
    seeded = true;
  }
});

afterAll(() => {
  if (seeded) {
    rmSync(CONFIG_FILE, { force: true });
  } else {
    const config = loadStoredConfig();
    if (config) {
      delete config.builtinDpMcpServers;
      saveConfig(config);
    }
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe('F1.157 — a machine without dp, through the real ladder', () => {
  it('the ladder over empty directories answers DpNotFound, and the view keeps every row beside the named reason', () => {
    let code: unknown;
    try {
      resolveDpRuntime(ladder(EMPTY_BIN));
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe(DpAuthError.DpNotFound);

    const view = readBuiltinDpMcpSettingsView({ resolveDpPath: viaLadder(EMPTY_BIN) });
    expect(view.available).toBe(false);
    expect(view.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['builtin_dp_mcp.dp_not_found']);
    // The denominator is the shipped constant, never a number written here.
    expect(view.servers.map(server => server.name)).toEqual(BUILTIN_DP_MCP_SERVERS.map(definition => definition.name));
    // The sentence names where the ladder looked, so a user can act on it.
    expect(view.diagnostics[0]!.message).toContain('NESSY_DP');
    expect(view.diagnostics[0]!.message).toContain('/usr/local/bin/dp');
  });

  it('the switch does not refuse: with dp missing a toggle still writes and reads back', () => {
    const name = BUILTIN_DP_MCP_SERVERS[0]!.name;
    const before = readBuiltinDpMcpSettingsView({ resolveDpPath: viaLadder(EMPTY_BIN) });
    expect(before.servers.find(server => server.name === name)?.enabled).toBe(BUILTIN_DP_MCP_SERVERS[0]!.defaultEnabled);

    setBuiltinDpMcpServerEnabled(name, !BUILTIN_DP_MCP_SERVERS[0]!.defaultEnabled);
    const after = readBuiltinDpMcpSettingsView({ resolveDpPath: viaLadder(EMPTY_BIN) });
    expect(after.available).toBe(false);
    expect(after.servers.find(server => server.name === name)?.enabled).toBe(!BUILTIN_DP_MCP_SERVERS[0]!.defaultEnabled);
  });

  it('available:true is a presence reading — an unauthenticated dp stub on PATH makes the set available and is never run', () => {
    rmSync(RAN_MARKER, { force: true });
    expect(resolveDpRuntime(ladder(STUB_BIN)).dpPath).toBe(join(STUB_BIN, 'dp'));

    const view = readBuiltinDpMcpSettingsView({ resolveDpPath: viaLadder(STUB_BIN) });
    expect(view.available).toBe(true);
    expect(view.diagnostics).toEqual([]);
    expect(existsSync(RAN_MARKER)).toBe(false);

    // POSITIVE CONTROL on the same instrument: running the stub DOES leave the
    // mark, so the absence above is "never executed", not "the marker is blind".
    const run = spawnSync(join(STUB_BIN, 'dp'), ['ai', 'mcp', 'gitlab'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not authenticated');
    expect(existsSync(RAN_MARKER)).toBe(true);
  });

  it('no environment variable reaches the fallback rung: PATH empty and NESSY_DP unset still answer /usr/local/bin/dp', () => {
    // Host-independent: `isRunnable` says which paths "exist", so this reads the
    // ladder's ORDER, not this machine's disk.
    const options: ResolveDpRuntimeOptions = { ...ladder(EMPTY_BIN), isRunnable: path => path === '/usr/local/bin/dp' };
    delete options.fallbackPath;
    const resolved = resolveDpRuntime(options);
    expect(resolved.dpPath).toBe('/usr/local/bin/dp');
    expect(resolved.source).toBe('system');
    // And an EMPTY-string NESSY_DP is not a lever either: the rung skips a blank value.
    expect(resolveDpRuntime({ ...options, env: { NESSY_DP: '  ' } }).dpPath).toBe('/usr/local/bin/dp');
  });
});
