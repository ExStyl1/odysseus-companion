/**
 * P3.229 — a PLUGIN stdio MCP server must be judged on the argv it is SPAWNED
 * under, not only on the one its manifest declares.
 *
 * The sibling row P3.217 closed this for the built-in dp set. A plugin was the
 * looser path one level over: `resolvePluginStdioExecutable`
 * (`mcp/runtime-pool-servers.ts`) replaces the declared command at
 * materialization time — a bundle-relative path becomes an absolute one inside
 * the installed bundle, a bare `dp` becomes the host-owned absolute dp — and
 * the only managed-MCP gate a plugin server passed
 * (`server-core/bootstrap/storage-runtime.ts:pluginMcpServerIdentity`) sits
 * upstream of that rewrite and reads the DECLARED shape alone. An
 * administrator's deny written from what the process actually runs matched
 * nothing.
 *
 * `managed-mcp.md#how-a-server-is-evaluated` is pre-load and unconditional:
 * "Before loading a server ... A server that matches any denylist entry, by
 * URL, command, or name, is blocked. Nothing overrides a denylist match."
 *
 * WHICH rewrites join the identity is the decision this row carries, and the
 * arms below pin both poles of it. `bundle` and `dp` join: each resolves to a
 * binary somebody other than the app provisioned, at a path that outlives an
 * app update, and each is what `ps`/`which dp` prints. The managed-runtime
 * rewrites (`node`, `uvx`, `python`) and the package-runner rewrites
 * (`npx`, `bunx`) do NOT — see `resolvePluginStdioExecutable` for the reasons,
 * and the two DECISION arms at the bottom for the measurement.
 *
 * Every absence assertion carries a positive control on the same rig: "no
 * marker" is otherwise indistinguishable from a rig that materialized nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseManagedPiPolicyV1,
  registerManagedPiPolicyProvider,
} from '../../agent/pi-harness/managed-policy.ts';
import { spawn } from 'node:child_process';
import { McpClientPool } from '../mcp-pool.ts';
import type { ProcessSupervisorPort } from '../../agent/pi-harness/process-supervisor-port.ts';
import { materializeRuntimePoolServers } from '../runtime-pool-servers.ts';
import { computeNormalizedBundleHash } from '../../plugins/bundle-hash.ts';
import type { CapabilityTurnRuntime } from '../../agent/backend/types.ts';

let root: string;
let bundleRoot: string;
let bundleExecutable: string;
let dpPath: string;
let markerPath: string;
let pool: McpClientPool | undefined;
let previousTimeout: string | undefined;
let children: ReturnType<typeof spawn>[] = [];

/**
 * A fixture "server" that records that it RAN, and with what argv.
 *
 * It writes into `NESSY_PLUGIN_DATA` rather than a path of its own, for two
 * reasons that are both properties of the production spawn path: that name is
 * in the child environment on EVERY branch (`pluginRuntimeEnvForProfile` mints
 * it), while a host-runtime binding's own `environment` reaches only the
 * branches that go through `resolvedHostExecutable`; and `client.ts` passes
 * `runtime.dataPath` as an `additionalWritableRoots` entry, so a marker written
 * there is inside the authority the real server is given.
 */
function writeMarkerScript(path: string): void {
  writeFileSync(path, [
    `#!${process.execPath}`,
    "const fs = require('node:fs')",
    "const nodePath = require('node:path')",
    "fs.writeFileSync(nodePath.join(process.env.NESSY_PLUGIN_DATA, 'SPAWNED.json'), JSON.stringify({",
    '  argv: process.argv.slice(1),',
    '}))',
    '// Stay alive long enough to look like a server, then self-terminate so a',
    '// timed-out connect cannot leak a process into the suite.',
    'setTimeout(() => process.exit(0), 8000)',
  ].join('\n'));
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'p3229-plugin-mcp-'));
  bundleRoot = join(root, 'plugins', 'acme');
  mkdirSync(join(bundleRoot, 'bin'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  bundleExecutable = join(bundleRoot, 'bin', 'local-mcp');
  dpPath = join(root, 'bin', 'dp');
  markerPath = join(root, 'data', 'SPAWNED.json');
  writeMarkerScript(bundleExecutable);
  writeMarkerScript(dpPath);
  children = [];
  // The fixtures speak no MCP, so the connect pays its deadline once per run.
  previousTimeout = process.env.NESSY_MCP_TIMEOUT;
  process.env.NESSY_MCP_TIMEOUT = '1200';
});

afterEach(async () => {
  await pool?.disconnectAll();
  pool = undefined;
  for (const child of children) child.kill('SIGKILL');
  children = [];
  registerManagedPiPolicyProvider(undefined);
  if (previousTimeout === undefined) delete process.env.NESSY_MCP_TIMEOUT;
  else process.env.NESSY_MCP_TIMEOUT = previousTimeout;
  if (root) rmSync(root, { recursive: true, force: true });
});

function denyCommand(serverCommand: readonly string[]) {
  registerManagedPiPolicyProvider(() => parseManagedPiPolicyV1({
    schemaVersion: 1,
    disabledPermissionModes: [],
    deniedMcpServers: [{ serverCommand: [...serverCommand] }],
  }));
}

interface PluginServerFixture {
  command: string;
  args?: string[];
}

/** The same fold the session agent and the browse pool both drive. */
async function fold(server: PluginServerFixture) {
  // The REAL hash of the bundle as it stands: `client.ts`'s `beforeStart`
  // recomputes it and refuses to spawn on a mismatch, so a placeholder here
  // would make every spawn assertion in this suite vacuously "did not run".
  const bundleHash = await computeNormalizedBundleHash(bundleRoot);
  const runtime = {
    view: {
      sources: [],
      mcpServers: [{
        key: 'acme#mcp',
        wireName: 'acme',
        logicalName: 'acme-server',
        definition: { type: 'stdio', command: server.command, ...(server.args ? { args: server.args } : {}) },
        pluginRuntime: {
          rootPath: bundleRoot,
          dataPath: join(root, 'data'),
          bundleHash,
          profile: 'claude-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://acme',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    },
    materializer: {
      assertActive: () => {},
      readText: async () => { throw new Error('a plugin server must not be read from disk here'); },
      resolvePath: async () => join(root, 'abs'),
      resolveCredential: () => { throw new Error('no credential in this suite'); },
      verifyPlugin: async () => {},
    },
  } as unknown as CapabilityTurnRuntime;
  return materializeRuntimePoolServers(runtime, {
    workspaceRootPath: root,
    workspaceId: 'ws_a',
    builtinDpMcpServers: false,
    // `ready`, so the dp-auth withholding branch is never what decides an arm.
    dpSessionState: 'ready',
    pluginNodeRuntime: {
      command: process.execPath,
      environment: { NESSY_SPAWN_MARKER: markerPath },
      executables: {
        dp: {
          command: dpPath,
          externalAuthProvider: 'dp',
          environment: { NESSY_SPAWN_MARKER: markerPath },
        },
      },
    },
  });
}

/**
 * The host authority a plugin MCP server needs to run at all — `client.ts`
 * refuses one outright without it (`plugin-mcp-process-supervisor-required`),
 * which is why this suite supplies a real spawner rather than a recorder. It
 * runs `beforeStart` first, so the production bundle-hash verification still
 * gates every start, and then actually executes the argv the fold produced.
 * The marker is therefore host-side execution driven from the fold, through
 * `pool.sync` → `reconcileUnion` → `connectOnce`, with nothing about the
 * decision stubbed.
 */
function spawningSupervisor(): ProcessSupervisorPort {
  return {
    async start(request) {
      await request.beforeStart?.();
      const child = spawn(request.command, request.args ?? [], {
        cwd: request.cwd,
        env: request.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      child.stdout?.on('data', (chunk: Buffer) => request.onStdout?.(chunk));
      child.on('close', (code, signal) => request.onClose?.(code, signal));
      return {
        handle: `handle-${children.length}`,
        output: '',
        nextCursor: 0,
        isRunning: true,
        exitCode: null,
        signal: null,
        isolationProfile: 'plugin-mcp:test',
        environmentProfile: 'explicit',
        environmentDigest: 'b'.repeat(64),
      };
    },
    async write() {},
    async read() { throw new Error('unused'); },
    async stop() {},
    async drainSession() { return []; },
  };
}

/** `pool.sync` → `reconcileUnion` → `connectOnce`, the only door to a spawn. */
async function spawnThrough(servers: Record<string, unknown>): Promise<void> {
  pool = new McpClientPool({
    workspaceRootPath: root,
    connectTimeoutMs: 1200,
    pluginProcessAuthority: {
      processSupervisor: spawningSupervisor(),
      sessionKey: { workspaceId: 'ws_a', sessionId: 'p3229' },
    },
  });
  await pool.sync(servers as Parameters<McpClientPool['sync']>[0]);
  const deadline = Date.now() + 3_000;
  while (!existsSync(markerPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const BUNDLE = { command: '${NESSY_PLUGIN_ROOT}/bin/local-mcp', args: ['--stdio'] };
const DP = { command: 'dp', args: ['ai', 'mcp', 'gitlab'] };

describe('P3.229 — a managed-denied plugin stdio MCP server', () => {
  it('POSITIVE CONTROL: with no managed policy the bundle server materializes and IS spawned', async () => {
    const materialized = await fold(BUNDLE);
    expect(materialized.mergedMcpServers.acme).toMatchObject({
      type: 'stdio',
      command: realpathSync(bundleExecutable),
      args: ['--stdio'],
    });
    await spawnThrough(materialized.mergedMcpServers);
    expect(existsSync(markerPath)).toBe(true);
  }, 40_000);

  it('a deny written with the RESOLVED bundle path withholds it and stops the spawn', async () => {
    // What `ps` prints. The declared spelling carries `${NESSY_PLUGIN_ROOT}`,
    // which the matcher expands from the PROCESS environment
    // (`managed-mcp.md#how-policy-entries-expand`) and where that name never
    // appears — it is a per-plugin value `pluginRuntimeEnvForProfile` mints at
    // materialization. So the page's own "an entry written as
    // `["${HOME}/bin/server"]` matches a server config that uses either the
    // same reference or the expanded path" could not reach this server from
    // either side until the resolved path joined its identity.
    denyCommand([realpathSync(bundleExecutable), '--stdio']);
    const materialized = await fold(BUNDLE);
    expect(materialized.mergedMcpServers.acme).toBeUndefined();
    await spawnThrough(materialized.mergedMcpServers);
    expect(existsSync(markerPath)).toBe(false);
  }, 40_000);

  it('a deny written with the RESOLVED dp path withholds it, and claims no dp auth', async () => {
    denyCommand([dpPath, 'ai', 'mcp', 'gitlab']);
    const materialized = await fold(DP);
    expect(materialized.mergedMcpServers.acme).toBeUndefined();
    // A withheld server must not go on demanding the sign-in it will never use.
    expect(materialized.externalAuthRequirements).toEqual([]);
  });

  it('NEGATIVE CONTROL: a resolved-path deny aimed elsewhere leaves it running', async () => {
    // Four ways to be a near miss, none of which may bite: a sibling file in
    // the same bundle, the same file with the argument dropped, the same file
    // with one added, and a basename match under a different root. If any
    // blocked, the identity would have widened into a prefix or basename match
    // rather than gaining one exact spelling.
    for (const serverCommand of [
      [join(bundleRoot, 'bin', 'other-mcp'), '--stdio'],
      [realpathSync(bundleExecutable)],
      [realpathSync(bundleExecutable), '--stdio', '--extra'],
      ['/some/other/prefix/bin/local-mcp', '--stdio'],
    ]) {
      denyCommand(serverCommand);
      expect(`${serverCommand.join(' ')}: ${(await fold(BUNDLE)).mergedMcpServers.acme !== undefined}`)
        .toBe(`${serverCommand.join(' ')}: true`);
    }
  });

  it('the DECLARED spelling still bites', async () => {
    // The identity gained a spelling; it did not trade one away.
    denyCommand(['${NESSY_PLUGIN_ROOT}/bin/local-mcp', '--stdio']);
    expect((await fold(BUNDLE)).mergedMcpServers.acme).toBeUndefined();
    denyCommand(['dp', 'ai', 'mcp', 'gitlab']);
    expect((await fold(DP)).mergedMcpServers.acme).toBeUndefined();
  });

  it('a REGISTERED but empty managed policy changes nothing', async () => {
    // The commonest production state by far. An unset allowlist must not read
    // as "deny all"; if it ever did, this gate would switch every plugin MCP
    // server off fleet-wide, which is worse than the hole it closes.
    registerManagedPiPolicyProvider(() => parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
    }));
    expect((await fold(BUNDLE)).mergedMcpServers.acme).toBeDefined();
  });

  it('DECISION: the managed-runtime rewrite does NOT join the identity', async () => {
    // `node` resolves to the app's OWN bundled runtime — the same binary for
    // every plugin on the machine, at a path that moves with the next app
    // update. A `serverCommand` rule written against it would stop matching on
    // upgrade, which is a control that silently stops controlling. The stable
    // handle is the declared spelling, and the arm below proves it still works.
    const node = { command: 'node', args: ['${NESSY_PLUGIN_ROOT}/server.js'] };
    writeMarkerScript(join(bundleRoot, 'server.js'));
    denyCommand([process.execPath, join(bundleRoot, 'server.js')]);
    expect((await fold(node)).mergedMcpServers.acme).toBeDefined();

    // Positive control on the same rig: the declared spelling DOES withhold it,
    // so the arm above reads the identity rather than a policy that never
    // parsed.
    denyCommand(['node', '${NESSY_PLUGIN_ROOT}/server.js']);
    expect((await fold(node)).mergedMcpServers.acme).toBeUndefined();
  });

  it('DECISION: the package-runner rewrite does NOT join the identity', async () => {
    // `npx -y pkg` is not re-SPELLED, it is re-WRITTEN: the package spec — the
    // one token `managed-mcp.md`'s own example configuration denies on — is
    // replaced by a resolved path into the bundle. Admitting that argv as
    // "another spelling of the same command" would widen
    // `#how-a-server-is-evaluated`'s "Commands match exactly", not honour it.
    const packageRoot = join(bundleRoot, 'node_modules', 'acme-mcp');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(bundleRoot, 'bun.lock'), '');
    writeFileSync(join(bundleRoot, 'package.json'), JSON.stringify({ dependencies: { 'acme-mcp': '1.0.0' } }));
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'acme-mcp', version: '1.0.0', bin: 'cli.js' }));
    writeMarkerScript(join(packageRoot, 'cli.js'));
    const npx = { command: 'npx', args: ['-y', 'acme-mcp'] };

    const open = await fold(npx);
    const materializedArgv = [
      open.mergedMcpServers.acme && (open.mergedMcpServers.acme as { command: string }).command,
      ...((open.mergedMcpServers.acme as { args?: string[] } | undefined)?.args ?? []),
    ] as string[];
    expect(materializedArgv[0]).toBeTruthy();

    denyCommand(materializedArgv);
    expect((await fold(npx)).mergedMcpServers.acme).toBeDefined();

    // Positive control on the same rig: the declared spelling, which names the
    // package, DOES withhold it.
    denyCommand(['npx', '-y', 'acme-mcp']);
    expect((await fold(npx)).mergedMcpServers.acme).toBeUndefined();
  });
});
