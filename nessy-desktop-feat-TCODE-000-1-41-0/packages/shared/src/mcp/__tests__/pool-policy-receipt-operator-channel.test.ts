/**
 * F1.178 (origin WJ-i, P-WJ-i-2) — the pool's POLICY receipts on a channel a
 * packaged build carries.
 *
 * ## The chain, and where each arm stands in it
 *
 * The pool writes its receipts to the `debug` option it is handed. On the
 * session path that is `message => this.debug(message)`
 * (`BaseAgent.setSourceServers`) → `BaseAgent.debug` → `config.onDebug` →
 * `SessionManager`'s `sessionLog`, which is `platform.logger` scoped — and
 * `apps/electron/src/main/logger.ts` sets both electron-log transports to
 * `level = false` outside debug mode, which a packaged build always is. SIT-10
 * measured the consequence directly: a full `NESSY_DEBUG=1` run of dmg #4
 * carried the run's own `[PERF]` lines and ZERO pool lines.
 *
 * F1.143 moved ONE receipt off that chain. These are its siblings, and the row
 * names two of them; a third (`plugin_mcp.managed_policy_denied`) is the same
 * administrator decision on a plugin server and is swept with them — see
 * `recordPoolPolicyReceipt`'s docblock for the per-receipt reasoning, including
 * the two that deliberately stay dev-only.
 *
 * - the CHILD arms drive the real `materializeRuntimePoolServers` with
 *   `debug: () => {}` — the packaged shape, where the pool's own channel reaches
 *   nobody — and read the child's own stderr. Stubbing `process.stderr.write`
 *   in-process does not intercept this sink under bun 1.3.14 (AGENTS.md, WI-v),
 *   and the question the row asks is exactly *which file descriptor an operator
 *   has to be capturing*.
 * - the SOURCE-TEXT arms close the chain at the three call sites, and are the
 *   honest instrument for `plugin_mcp.managed_policy_denied`: reaching it live
 *   needs a real plugin bundle with a computed hash, which
 *   `managed-denied-plugin-mcp-spawn.test.ts` already builds and pins. That
 *   suite owns the behaviour; this file owns the channel.
 * - the IN-PROCESS arm is the row's own control: the existing `debug` channel is
 *   UNCHANGED, so nothing moved — a sink was added.
 *
 * Every stdout marker carries the policy OUTCOME, so an absent receipt is an
 * absent RECEIPT rather than a materialization that never made the decision.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { materializeRuntimePoolServers } from '../runtime-pool-servers.ts';
import type { CapabilityTurnRuntime } from '../../agent/backend/types.ts';
import { bracedRegion } from '../../testing/source-regions.ts';

const POOL_SOURCE = join(import.meta.dir, '..', 'runtime-pool-servers.ts');
const MANAGED_POLICY = join(import.meta.dir, '..', '..', 'agent', 'pi-harness', 'managed-policy.ts');

/** The empty capability view every arm folds a built-in into. */
function emptyRuntime(): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'g',
      sources: [],
      skills: [],
      mcpServers: [],
      hooks: [],
      automations: [],
      agents: [],
      promptLayers: [],
      memory: [],
      permissionLayers: [],
      commands: [],
      promptCommands: [],
      apps: [],
      lspServers: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/abs/path'; },
      async readText() { return '{}'; },
      resolveCredential() { throw new Error('credential-not-ready'); },
    },
  } as unknown as CapabilityTurnRuntime;
}

describe('F1.178 · the pool policy receipts reach the operator channel', () => {
  /**
   * TWO materializations in ONE child, so one module-graph load covers two
   * receipts: the needs-login withholding, then the managed-policy denial.
   */
  function childSource(): string {
    return [
      `const pool = await import(${JSON.stringify(POOL_SOURCE)})`,
      `const mp = await import(${JSON.stringify(MANAGED_POLICY)})`,
      `const runtime = () => ({`,
      `  view: { generation: "g", sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],`,
      `    promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [] },`,
      `  materializer: { assertActive(){}, async verifyPlugin(){}, async resolvePath(){ return "/abs/path" },`,
      `    async readText(){ return "{}" }, resolveCredential(){ throw new Error("credential-not-ready") } },`,
      `})`,
      `const builtin = { resolveDpPath: () => "/usr/local/bin/dp", enabled: { dpGitlab: true }, runtimeEnv: {} }`,
      // 1. dp reports needs-login: the built-in is withheld from the map.
      `const a = await pool.materializeRuntimePoolServers(runtime(), {`,
      `  workspaceRootPath: "/ws", workspaceId: "ws-1", builtinDpMcpServers: builtin,`,
      `  dpSessionState: "needs-login", debug: () => {},`,
      `})`,
      `console.log("RECEIPT-STDOUT-CONTROL needs-login withheld=" + (a.mergedMcpServers["dpGitlab"] === undefined))`,
      // 2. dp is ready, and an ADMINISTRATOR's managed policy denies the same
      //    built-in by both dimensions the policy can name.
      `mp.registerManagedPiPolicyProvider(() => mp.parseManagedPiPolicyV1({`,
      `  schemaVersion: 1, disabledPermissionModes: [],`,
      `  deniedMcpServers: [{ serverName: "dpGitlab" }, { serverCommand: ["dp", "ai", "mcp", "gitlab"] }],`,
      `}))`,
      `const b = await pool.materializeRuntimePoolServers(runtime(), {`,
      `  workspaceRootPath: "/ws", workspaceId: "ws-1", builtinDpMcpServers: builtin,`,
      `  dpSessionState: "ready", debug: () => {},`,
      `})`,
      `mp.registerManagedPiPolicyProvider(undefined)`,
      `console.log("RECEIPT-STDOUT-CONTROL denied withheld=" + (b.mergedMcpServers["dpGitlab"] === undefined))`,
    ].join('\n');
  }

  /**
   * `delete` then assign, never a spread with `undefined` — AGENTS.md records
   * that an object literal cannot clear a name Bun pre-created a slot for, which
   * would leave the switch ON in the negative arm.
   */
  async function runChild(debugOn: boolean) {
    const env = { ...process.env };
    delete env.NESSY_DEBUG;
    if (debugOn) env.NESSY_DEBUG = '1';
    const child = Bun.spawn(['bun', '-e', childSource()], { env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return { stdout, stderr };
  }

  it('both withholding receipts reach the child\'s STDERR although the pool `debug` swallows them', async () => {
    const { stdout, stderr } = await runChild(true);

    // The positive controls FIRST, and they carry the decisions: both
    // materializations really withheld the server, so an absent receipt below is
    // an absent RECEIPT and not an absent decision.
    expect(stdout).toContain('RECEIPT-STDOUT-CONTROL needs-login withheld=true');
    expect(stdout).toContain('RECEIPT-STDOUT-CONTROL denied withheld=true');

    expect(stderr).toContain('runtime-external-auth-required:dp-builtin:1');
    expect(stderr).toContain('builtin_dp_mcp.managed_policy_denied: dpGitlab');
    // The scope an operator greps for, beside `[model-target]` and `[dp-auth]`.
    expect(stderr).toContain('[mcp-pool]');
  }, 300_000);

  it('NEGATIVE CONTROL: with the switch off nothing is written, and the instrument still reads the child', async () => {
    const { stdout, stderr } = await runChild(false);

    expect(stdout).toContain('RECEIPT-STDOUT-CONTROL needs-login withheld=true');
    expect(stderr).not.toContain('runtime-external-auth-required:dp-builtin:');
    expect(stderr).not.toContain('builtin_dp_mcp.managed_policy_denied');
  }, 300_000);

  it('the dev/headless `debug` channel is UNCHANGED — a sink was added, not moved', async () => {
    // The row's own stated control. In-process, because this half has nothing to
    // do with a file descriptor: it is about the option the caller passes.
    const seen: string[] = [];
    const out = await materializeRuntimePoolServers(emptyRuntime(), {
      workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
      builtinDpMcpServers: { resolveDpPath: () => '/usr/local/bin/dp', enabled: { dpGitlab: true }, runtimeEnv: {} },
      dpSessionState: 'needs-login',
      debug: message => seen.push(message),
    });

    expect(out.mergedMcpServers['dpGitlab']).toBeUndefined();
    expect(seen).toContain('runtime-external-auth-required:dp-builtin:1');
  });
});

describe('F1.178 · which receipts were swept, said in code', () => {
  it('all three withholding receipts go through the one seam', async () => {
    const src = await Bun.file(POOL_SOURCE).text();

    for (const needle of [
      'recordPoolPolicyReceipt(debug, `runtime-external-auth-required:dp-builtin:',
      'recordPoolPolicyReceipt(debug, `builtin_dp_mcp.managed_policy_denied:',
      'recordPoolPolicyReceipt(debug, `plugin_mcp.managed_policy_denied:',
    ]) {
      expect(src).toContain(needle);
    }
    // The seam really writes both channels — a site could route through a
    // function that had quietly stopped doing so. Bounded at the function's
    // OWN closing brace: this slice ran to the end of the file until F1.593
    // (`2e5d1c518`) appended `foldManagedOrgMcpServers` below it, and the size
    // bound then measured that code instead of the seam. The control names that
    // declaration, which sits BELOW the anchor, so a runaway scan fails here.
    const seam = bracedRegion(src, src.indexOf('function recordPoolPolicyReceipt('));
    expect(seam).not.toContain('export function foldManagedOrgMcpServers(');
    expect(seam.length).toBeLessThan(300);
    expect(seam).toContain('debug(message);');
    expect(seam).toContain('poolOperatorLog.warn(message);');
  });

  it('the two REQUIREMENT receipts deliberately stay on `debug` alone', async () => {
    // Not an oversight and not a gap: both fire on every materialization while a
    // provider is unauthenticated, and the requirement they record has a surface
    // of its own — it is returned as `externalAuthRequirements` and becomes the
    // sign-in card. On the operator channel they would stand in front of the
    // lines that have no other surface. The reasoning is in
    // `recordPoolPolicyReceipt`'s docblock; this arm is what makes a future
    // change to it deliberate rather than accidental.
    const src = await Bun.file(POOL_SOURCE).text();

    expect(src).toContain('debug(`runtime-external-auth-required:dp:${dpSessionState}`);');
    expect(src).toContain('debug(`runtime-external-auth-required:${provider}:needs-login`);');
    expect(src).toContain('TWO receipts in this module are deliberately NOT routed');
  });
});
