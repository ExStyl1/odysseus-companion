/**
 * P2.368 — the built-in dp MCP set must obey the managed denylist.
 *
 * The sibling row P2.351 closed the browse-resolve bypass for DISCOVERED and
 * PLUGIN servers. The built-in dp set escaped it by a different door: its
 * records are appended to the capability list AFTER the managed filter, and the
 * fold that actually starts them (`foldBuiltinDpMcpServers`) read the stored
 * preference and applied no policy at all — so a denied built-in ran on EVERY
 * path, session turns included, not merely at session start.
 *
 * `managed-mcp.md#how-a-server-is-evaluated` governs both, and is pre-load and
 * unconditional: "Before loading a server … A server that matches any denylist
 * entry, by URL, command, or name, is blocked. Nothing overrides a denylist
 * match."
 *
 * End-to-end and real, to the standard the sibling set: the REAL
 * `materializeRuntimePoolServers` fold feeds a REAL `McpClientPool.sync`, whose
 * `reconcileUnion` → `connectOnce` spawns a stdio server. `dp` is a fixture
 * executable that writes its own argv and environment to a marker file — a
 * marker file is host-side execution, and the `DP_*` state-root variables in it
 * are what let a real `dp` answer with the user's own corporate session.
 *
 * Every absence assertion carries a positive control on the same rig: "no
 * marker" is otherwise indistinguishable from a rig that materialized nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseManagedPiPolicyV1,
  registerManagedPiPolicyProvider,
} from '../../agent/pi-harness/managed-policy.ts';
import { McpClientPool } from '../mcp-pool.ts';
import { materializeRuntimePoolServers } from '../runtime-pool-servers.ts';

let root: string;
let dpPath: string;
let markerPath: string;
let pool: McpClientPool | undefined;
let previousTimeout: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'p2368-builtin-dp-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  dpPath = join(root, 'bin', 'dp');
  markerPath = join(root, 'SPAWNED.json');
  // A stand-in for the corporate `dp`: it records that it RAN, with what argv
  // and with which dp state-root variables — the ones that make a real `dp ai
  // mcp <sub>` answer as the signed-in user.
  writeFileSync(dpPath, [
    `#!${process.execPath}`,
    "const fs = require('node:fs')",
    'fs.writeFileSync(process.env.NESSY_SPAWN_MARKER, JSON.stringify({',
    '  argv: process.argv.slice(1),',
    '  pid: process.pid,',
    '  dpStateRoot: process.env.DP_WORKDIR ?? null,',
    '}))',
    '// Stay alive long enough to look like a server, then self-terminate so a',
    '// timed-out connect cannot leak a process into the suite.',
    'setTimeout(() => process.exit(0), 8000)',
  ].join('\n'));
  chmodSync(dpPath, 0o755);
  // The fixture speaks no MCP, so the connect pays its deadline once per run.
  previousTimeout = process.env.NESSY_MCP_TIMEOUT;
  process.env.NESSY_MCP_TIMEOUT = '1200';
});

afterEach(async () => {
  await pool?.disconnectAll();
  pool = undefined;
  registerManagedPiPolicyProvider(undefined);
  if (previousTimeout === undefined) delete process.env.NESSY_MCP_TIMEOUT;
  else process.env.NESSY_MCP_TIMEOUT = previousTimeout;
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * The identity dimensions `managed-mcp.md:150` says are enforceable, both aimed
 * at the same built-in: its wire name AND the LOGICAL `dp ai mcp <sub>` argv
 * that `builtinDpMcpCapabilityRecords` already pins as its
 * `mcpServerIdentity`. Denying by both is what makes the arm below a statement
 * about the server rather than about one spelling of it.
 */
function denyGitlab() {
  return parseManagedPiPolicyV1({
    schemaVersion: 1,
    disabledPermissionModes: [],
    deniedMcpServers: [
      { serverName: 'dpGitlab' },
      { serverCommand: ['dp', 'ai', 'mcp', 'gitlab'] },
    ],
  });
}

/** The same fold the session agent and the browse pool both drive. */
async function fold() {
  return materializeRuntimePoolServers(
    {
      view: { sources: [], mcpServers: [] },
      materializer: {
        assertActive: () => {},
        readText: async () => { throw new Error('a built-in must not be read from disk'); },
        resolvePath: async () => join(root, 'abs'),
        resolveCredential: () => { throw new Error('no credential in this suite'); },
        verifyPlugin: async () => {},
      },
    } as unknown as Parameters<typeof materializeRuntimePoolServers>[0],
    {
      workspaceRootPath: root,
      workspaceId: 'ws_a',
      // `ready`, so the dp-auth withholding branch is not what decides this.
      dpSessionState: 'ready',
      builtinDpMcpServers: {
        enabled: { dpGitlab: true },
        // Injected: this suite never looks for the real dp and never runs it.
        resolveDpPath: () => dpPath,
        runtimeEnv: { NESSY_SPAWN_MARKER: markerPath, DP_WORKDIR: join(root, 'dp-state') },
      },
    },
  );
}

/** `pool.sync` → `reconcileUnion` → `connectOnce`, the only door to a spawn. */
async function spawnThrough(servers: Record<string, unknown>): Promise<void> {
  pool = new McpClientPool({ workspaceRootPath: root, connectTimeoutMs: 1200 });
  await pool.sync(servers as Parameters<McpClientPool['sync']>[0]);
  const deadline = Date.now() + 3_000;
  while (!existsSync(markerPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('P2.368 — a managed-denied built-in dp MCP server', () => {
  it('POSITIVE CONTROL: with no managed policy the built-in folds in and IS spawned', async () => {
    const materialized = await fold();
    expect(materialized.mergedMcpServers.dpGitlab).toEqual({
      type: 'stdio',
      command: dpPath,
      args: ['ai', 'mcp', 'gitlab'],
      env: { NESSY_SPAWN_MARKER: markerPath, DP_WORKDIR: join(root, 'dp-state') },
    });
    await spawnThrough(materialized.mergedMcpServers);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { argv: string[]; dpStateRoot: string };
    expect(marker.argv.slice(1)).toEqual(['ai', 'mcp', 'gitlab']);
    // The credential half: the process runs against dp's own state root, which
    // is where the user's corporate session lives.
    expect(marker.dpStateRoot).toBe(join(root, 'dp-state'));
  }, 40_000);

  it('is withheld from the pool when the managed policy denies it', async () => {
    registerManagedPiPolicyProvider(() => denyGitlab());
    const materialized = await fold();
    expect(materialized.mergedMcpServers.dpGitlab).toBeUndefined();
    // Nothing else took its place, and the dp auth requirement does not claim a
    // server the policy already removed.
    expect(Object.keys(materialized.mergedMcpServers)).toEqual([]);
    expect(materialized.externalAuthRequirements).toEqual([]);
  });

  it('does not RUN when the managed policy denies it', async () => {
    registerManagedPiPolicyProvider(() => denyGitlab());
    const materialized = await fold();
    await spawnThrough(materialized.mergedMcpServers);
    expect(existsSync(markerPath)).toBe(false);
  }, 40_000);

  it('a REGISTERED but empty managed policy changes nothing', async () => {
    // The commonest production state by far — every non-managed install boots
    // with the provider registered and `DEFAULT_MANAGED_PI_POLICY` behind it.
    // An unset allowlist must not be read as "deny all"; if it ever were, this
    // gate would silently switch the whole built-in set off fleet-wide, which is
    // a worse outcome than the hole it closes.
    registerManagedPiPolicyProvider(() => parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
    }));
    expect((await fold()).mergedMcpServers.dpGitlab).toBeDefined();
  });

  it('P3.217 — a deny written with the RESOLVED dp path withholds it and stops the spawn', async () => {
    // The residue this suite's own fix declared. The fold materializes
    // `command: <resolved dp>`, so the argv that RUNS is not the logical `dp ai
    // mcp gitlab` the catalog row shows. An administrator reading `which dp`
    // writes the resolved one — and until the identity carried both spellings
    // that rule matched nothing, read correct in the UI, and let the server run.
    registerManagedPiPolicyProvider(() => parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      deniedMcpServers: [{ serverCommand: [dpPath, 'ai', 'mcp', 'gitlab'] }],
    }));
    const materialized = await fold();
    expect(materialized.mergedMcpServers.dpGitlab).toBeUndefined();
    await spawnThrough(materialized.mergedMcpServers);
    expect(existsSync(markerPath)).toBe(false);
  }, 40_000);

  it('P3.217 NEGATIVE CONTROL: a resolved-path deny aimed elsewhere leaves it running', async () => {
    // Two ways to be a near miss, both of which must NOT bite: the same dp at a
    // different subcommand, and the same subcommand under a different dp. If
    // either blocked, the identity would have widened into a basename or a
    // suffix match rather than gaining one exact spelling.
    for (const serverCommand of [
      [dpPath, 'ai', 'mcp', 'jira'],
      ['/some/other/prefix/dp', 'ai', 'mcp', 'gitlab'],
    ]) {
      registerManagedPiPolicyProvider(() => parseManagedPiPolicyV1({
        schemaVersion: 1,
        disabledPermissionModes: [],
        deniedMcpServers: [{ serverCommand }],
      }));
      expect(`${serverCommand.join(' ')}: ${(await fold()).mergedMcpServers.dpGitlab !== undefined}`)
        .toBe(`${serverCommand.join(' ')}: true`);
    }
  });

  it('a denial aimed at a SIBLING leaves this one running', async () => {
    // The narrowing control: the gate reads the identity of each server rather
    // than standing the whole set down whenever any denylist exists.
    registerManagedPiPolicyProvider(() => parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      deniedMcpServers: [{ serverName: 'dpJira' }],
    }));
    const materialized = await fold();
    expect(materialized.mergedMcpServers.dpGitlab).toBeDefined();
  });

  it('an ALLOWLIST that does not name it withholds it too', async () => {
    // `managed-mcp.md`'s type-dependent allowlist: a stdio server has to match a
    // `serverCommand` or `serverName` entry to be admitted. A built-in is not
    // exempt from the grant half either.
    registerManagedPiPolicyProvider(() => parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      allowedMcpServers: [{ serverName: 'somethingElse' }],
    }));
    expect((await fold()).mergedMcpServers.dpGitlab).toBeUndefined();

    // Positive control on the same rig: an allowlist that DOES name it admits
    // it, so the arm above is reading the list rather than refusing everything.
    registerManagedPiPolicyProvider(() => parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      allowedMcpServers: [{ serverName: 'dpGitlab' }],
    }));
    expect((await fold()).mergedMcpServers.dpGitlab).toBeDefined();
  });
});

/**
 * P6.72, codex arm — and the row's own premise is refuted, which is the finding.
 *
 * The row asked for *"P2.368's own suite re-parameterised for provider `codex`"*.
 * **There is nothing to parameterise.** `materializeRuntimePoolServers` takes
 * `(runtime, options)` and neither carries a provider; `applyManagedMcpPolicy`
 * reads `resolveManagedPiPolicyFloor()` and the server's own identity and
 * nothing else. So every arm above is ALREADY the codex arm, byte for byte —
 * writing a second copy of them under a `provider: 'codex'` that no function
 * accepts would have looked like coverage and measured nothing.
 *
 * What was genuinely unpinned is the OTHER half of "shared by construction":
 * that a codex session reaches this fold at all. It reaches it through
 * `BaseAgent.setSourceServers`, which `CodexAgent` does not override — an
 * identity check rather than a source grep, so it goes red the day codex grows
 * its own. `PiAgent` DOES override it (and calls `super`), which is the positive
 * control proving the check can see an override at all; without that arm, three
 * identical references would be indistinguishable from a rig comparing the wrong
 * thing.
 *
 * The SPAWN half needs no repetition here: the arms above drive the real
 * `McpClientPool.sync` → `reconcileUnion` → `connectOnce` and assert on a marker
 * file, and codex reaches operator MCP behind that same host pool (one
 * aggregated loopback endpoint, P2.517) rather than spawning servers of its own.
 * The claude child's own three MCP entry points are a different question with a
 * different answer, measured in
 * `config/__tests__/claude-managed-mcp-spawn.test.ts`.
 */
describe('P6.72 — the managed MCP gate is provider-blind, and codex reaches it unchanged', () => {
  it('CodexAgent inherits setSourceServers, and PiAgent overriding it is the control', async () => {
    const [{ BaseAgent }, { CodexAgent }, { PiAgent }] = await Promise.all([
      import('../../agent/base-agent.ts'),
      import('../../agent/codex-agent.ts'),
      import('../../agent/pi-agent.ts'),
    ]);
    const base = (BaseAgent as unknown as { prototype: Record<string, unknown> }).prototype.setSourceServers;
    const codex = (CodexAgent as unknown as { prototype: Record<string, unknown> }).prototype.setSourceServers;
    const pi = (PiAgent as unknown as { prototype: Record<string, unknown> }).prototype.setSourceServers;

    // The rig proves itself: the base method exists and is a function, so an
    // identity comparison below is comparing something real.
    expect(typeof base).toBe('function');
    // THE CLAIM: codex has no MCP admission of its own — it drives the same
    // materialization the gate lives inside.
    expect(codex).toBe(base);
    // POSITIVE CONTROL on the identical instrument: an override IS visible.
    expect(pi).not.toBe(base);
    expect(typeof pi).toBe('function');
  }, 60_000);

  it('the fold takes no provider, so there is no second behaviour to measure', async () => {
    const { materializeRuntimePoolServers } = await import('../runtime-pool-servers.ts');
    // Two parameters — `(runtime, options)`. A provider argument would have to
    // be a third, or a key on one of them; `MaterializePoolServersOptions`
    // declares none, which `tsc` enforces for every caller in the tree.
    expect(materializeRuntimePoolServers.length).toBe(2);
  }, 60_000);
});
