/**
 * A7 — the per-server enable/disable preference for the built-in dp MCP set.
 *
 * The load-bearing arm is the DISK one: a `config.json` written by hand, loaded
 * through the production loader in a child process with its own
 * `NESSY_CONFIG_DIR`, read by `getBuiltinDpMcpServerPreferences()` and driven
 * into `materializeBuiltinDpMcpServers`. Nothing shorter proves the thing that
 * actually breaks — a stored map that the strict top-level envelope rejects
 * takes `loadStoredConfig()` down and bricks startup (the `workflow` key did
 * exactly this), and a parser test alone cannot see that.
 *
 * Host-independence is the other rule these arms keep. `resolveDpPath` is
 * injected in every arm, so nothing here needs `dp` installed and nothing
 * executes it; the config dir is a fresh temp dir, so nothing here reads or
 * writes the developer's real `~/.nessy-agent/config.json`. An arm that
 * branched on either would be green on CI and wrong on a real machine.
 */

import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { parseBuiltinDpMcpSettingsV1 } from '../builtin-dp-mcp-settings.ts';
// The set itself, so the expectations below cannot drift out of date the way
// they did between `74df120a` and `36374915`: the six default-ON names were
// written out by hand here, the owner then flipped every definition to OFF, and
// three arms went red on a file nobody looked at again.
import { BUILTIN_DP_MCP_SERVERS } from '../../mcp/builtin-dp-servers.ts';

const DP = '/usr/local/bin/dp';

/**
 * The budget belongs to the FILE, not to a case. Every DISK arm spawns a bun
 * process that imports `storage.ts`'s whole module graph before a line of this
 * file's subject runs, and that cost is a PAGE-CACHE LOTTERY rather than work:
 * measured 2026-09-11 on the same child, `real 48.74` at load 8.26, `real 38.28`
 * at load 8.49, then **0.29 / 0.34 / 0.35** at load 7.62 once the graph was warm,
 * with CPU flat at ~0.5 s user + 0.2 s sys throughout — 1.7 % of the slow wall,
 * and a 140x spread straddling the 5 s default. Against that default all three
 * disk arms died at `expect(run.exitCode).toBe(0)` with `null` — the child killed
 * mid-import — which reads exactly like the bricked loader this file exists to
 * catch and is the opposite of it. Sized like the siblings paying the same cost
 * (`review-effort-memory.test.ts`, `workflow-settings.test.ts`); on the warm path
 * it costs nothing.
 */
setDefaultTimeout(300_000);

interface MaterializedFromDisk {
  available: boolean;
  servers: Record<string, { type: string; command: string; args: string[] }>;
  disabledServers: string[];
}

/**
 * Write `config.json` into a fresh config dir, then run the whole production
 * path — `loadStoredConfig` → `getBuiltinDpMcpServerPreferences` →
 * `materializeBuiltinDpMcpServers` — in a child process pointed at it.
 */
function materializeWithStoredConfig(config: Record<string, unknown>): MaterializedFromDisk {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-builtin-dp-pref-'));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
    activeWorkspaceId: 'ws-1',
    activeSessionId: null,
    ...config,
  }), 'utf-8');
  const storageModule = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;
  const builtinModule = pathToFileURL(
    join(import.meta.dir, '..', '..', 'mcp', 'builtin-dp-servers.ts'),
  ).href;
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    [
      `import * as S from '${storageModule}';`,
      `import * as M from '${builtinModule}';`,
      `S.loadStoredConfig();`,
      `const m = M.materializeBuiltinDpMcpServers({`,
      `  enabled: S.getBuiltinDpMcpServerPreferences(),`,
      `  resolveDpPath: () => ${JSON.stringify(DP)},`,
      `  runtimeEnv: {},`,
      `});`,
      `console.log(JSON.stringify({ available: m.available, servers: m.servers, disabledServers: m.disabledServers }));`,
    ].join('\n'),
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return JSON.parse(run.stdout.toString().trim()) as MaterializedFromDisk;
}

describe('the stored per-server map reaches the materialized set', () => {
  it('enables a default-off server, keeps an explicit off off, and ignores the rest', () => {
    const { available, servers, disabledServers } = materializeWithStoredConfig({
      builtinDpMcpServers: {
        enabled: {
          // Explicitly switched OFF. Since `36374915` every definition is
          // already off, so this arm can only prove that an explicit `false`
          // does not ACCIDENTALLY enable — the "overrides a default-on server"
          // direction is not observable through this path while the whole set
          // ships off, and no arm can restore it without a default-on server.
          dpSage: false,
          // A server that is OFF by default, switched ON. The only direction
          // the shipped defaults leave observable, and the load-bearing one.
          dpMail: true,
          // Forward compatibility: a name no definition claims. Ignored — it
          // must neither fail the load nor conjure a server, because a map
          // written by a newer release will carry exactly this.
          notAServerWeShip: true,
          // Not a JSON boolean, so not a preference: `dpWiki` falls back to its
          // own default (off) rather than to the truthiness of a string.
          dpWiki: 'false',
        },
      },
    });

    expect(available).toBe(true);
    // The disable arm: `dpSage` is gone, and it is REPORTED as switched off
    // rather than silently missing.
    expect(servers.dpSage).toBeUndefined();
    expect(disabledServers).toContain('dpSage');
    // The enable arm: `dpMail` is off by default and is here, with the right
    // `dp ai mcp <sub>` — the name and the subcommand differ, which is the pair
    // most likely to be "simplified" into a bug.
    expect(servers.dpMail).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'mail'] });
    expect(disabledServers).not.toContain('dpMail');
    // The unknown name reached nothing — not the server map, and not the
    // disabled list either, which would have leaked it into the settings UI.
    expect(servers.notAServerWeShip).toBeUndefined();
    expect(disabledServers).not.toContain('notAServerWeShip');
    // Absent from the map → each definition's own default, which is off.
    expect(servers.codeSearch).toBeUndefined();
    expect(disabledServers).toContain('codeSearch');
    // The non-boolean value fell back to the definition default (off) rather
    // than to the truthiness of the non-empty string `'false'`.
    expect(servers.dpWiki).toBeUndefined();
    expect(disabledServers).toContain('dpWiki');
    // The whole resulting set, so a preference that leaks into an unrelated
    // server is visible rather than absorbed by the per-key assertions above.
    expect(Object.keys(servers)).toEqual(['dpMail']);
    expect(disabledServers).toEqual(
      BUILTIN_DP_MCP_SERVERS.filter(d => d.name !== 'dpMail').map(d => d.name),
    );
  });

  it('leaves the measured defaults untouched when the key is absent', () => {
    // The "did this change today's behaviour" arm: a config.json that predates
    // the key must materialize exactly the shipped defaults. Owner decision
    // 2026-08-01 — "вшить весь базовый набор но по дефолту выключен" — makes
    // that the empty set, which is what keeps an upgrade from starting stdio
    // subprocesses nobody asked for.
    const { available, servers, disabledServers } = materializeWithStoredConfig({});
    expect(available).toBe(true);
    expect(Object.keys(servers)).toEqual([]);
    expect(disabledServers).toEqual(BUILTIN_DP_MCP_SERVERS.map(d => d.name));
  });

  it('falls back to the defaults when the stored block is malformed', () => {
    // A bad hand-edit must not wedge the load. `available: true` is the whole
    // claim: the loader accepted the file and the set resolved. It cannot also
    // distinguish "fell back to defaults" from "turned everything off" while
    // the defaults ARE off — see the note in the first arm.
    const { available, servers, disabledServers } = materializeWithStoredConfig({
      builtinDpMcpServers: { enabled: ['dpSage'] },
    });
    expect(available).toBe(true);
    expect(Object.keys(servers)).toEqual([]);
    expect(disabledServers).toEqual(BUILTIN_DP_MCP_SERVERS.map(d => d.name));
  });
});

describe('parseBuiltinDpMcpSettingsV1', () => {
  it('keeps literal booleans, including names it does not recognise', () => {
    expect(parseBuiltinDpMcpSettingsV1({
      enabled: { dpSage: false, dpMail: true, somethingLater: true },
    })).toEqual({ enabled: { dpSage: false, dpMail: true, somethingLater: true } });
  });

  it('drops every non-boolean value, so it lands on the definition default', () => {
    expect(parseBuiltinDpMcpSettingsV1({
      enabled: { a: 'true', b: 1, c: 0, d: null, e: {}, f: [], g: true },
    })).toEqual({ enabled: { g: true } });
  });

  it('reads a malformed or absent layer as no preference at all', () => {
    expect(parseBuiltinDpMcpSettingsV1(undefined)).toEqual({});
    expect(parseBuiltinDpMcpSettingsV1(null)).toEqual({});
    expect(parseBuiltinDpMcpSettingsV1([])).toEqual({});
    expect(parseBuiltinDpMcpSettingsV1('off')).toEqual({});
    expect(parseBuiltinDpMcpSettingsV1({})).toEqual({});
    expect(parseBuiltinDpMcpSettingsV1({ enabled: true })).toEqual({});
    expect(parseBuiltinDpMcpSettingsV1({ enabled: [] })).toEqual({});
  });

  it('does not let a stored `__proto__` entry reach the prototype', () => {
    const parsed = parseBuiltinDpMcpSettingsV1(JSON.parse('{"enabled":{"__proto__":true,"dpMail":true}}'));
    expect(parsed.enabled).toEqual({ dpMail: true });
    expect(({} as Record<string, unknown>).dpMail).toBeUndefined();
  });
});
