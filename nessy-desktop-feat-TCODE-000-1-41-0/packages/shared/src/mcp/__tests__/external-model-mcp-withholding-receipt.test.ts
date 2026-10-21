/**
 * F1.143 (origin SIT-10, P-SIT10-6) - the withholding RECEIPT has to reach a
 * channel the packaged build carries, or D1.425 has no live instrument.
 *
 * ## What SIT-10 measured, and why the absence proved nothing about the policy
 *
 * `external_model_mcp.withheld:<class>: <names>` went to the pool's `debug`
 * option. On the session path that option is `message => this.debug(message)`
 * (`BaseAgent.setSourceServers`), `BaseAgent.debug` forwards to
 * `config.onDebug`, and `SessionManager` binds that to `sessionLog` - which is
 * `platform.logger` scoped, and `apps/electron/src/main/logger.ts` sets both of
 * its transports to `false` outside debug mode. A packaged build is always
 * outside debug mode. So a full `NESSY_DEBUG=1` run of dmg #4 carried the run's
 * own `[PERF]` lines and ZERO pool lines, and D1.425 was recorded NOT DRIVABLE.
 *
 * ## The instrument
 *
 * A CHILD, and its own stdout marker as the positive control. Stubbing
 * `process.stderr.write` in-process does not intercept this sink under bun
 * 1.3.14, and the question the row asks is exactly *which file descriptor an
 * operator has to be capturing* - which only a real child can answer. The child
 * drives the REAL `materializeRuntimePoolServers` with a `debug` that does
 * NOTHING, which is the packaged shape: if the receipt still reaches stderr, it
 * no longer depends on the channel that was dropping it.
 *
 * The verdict is the real `classifyModelTarget`'s and the host is a NON-gateway
 * one, as the row requires (`modelTargetForModel` returns a `nessy-gateway`
 * verdict unchanged, so a gateway arm could never withhold). No third-party key
 * and no network: nothing here connects anything.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { classifyModelTarget } from '../../agent/backend/internal/drivers/upstream-target.ts';
import { recordExternalModelMcpWithholding } from '../../agent/backend/internal/drivers/external-model-mcp-whitelist.ts';

const EXTERNAL = classifyModelTarget({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', providerType: 'pi_compat' });

describe('recordExternalModelMcpWithholding - the receipt itself', () => {
  it('is byte-identical to the line the pool used to write, and still reaches `debug`', () => {
    const seen: string[] = [];
    const receipt = recordExternalModelMcpWithholding(EXTERNAL, ['dpFs', 'dpOther'], message => seen.push(message));

    // The exact bytes, because a test that rebuilds the string cannot catch the
    // day the format moves. `unclassified` here would be a different class - the
    // real classifier said `external-vendor` for `api.openai.com`.
    expect(receipt).toBe('external_model_mcp.withheld:external-vendor: dpFs, dpOther');
    // The dev/headless channel is UNCHANGED: this adds a sink, it does not move one.
    expect(seen).toEqual([receipt]);
  });

  it('names `unknown` rather than throwing when there is no verdict', () => {
    const seen: string[] = [];
    expect(recordExternalModelMcpWithholding(undefined, ['dpFs'], m => seen.push(m)))
      .toBe('external_model_mcp.withheld:unknown: dpFs');
    expect(seen.length).toBe(1);
  });
});

describe('F1.143 - the receipt on the file descriptor a packaged build keeps', () => {
  const POOL = join(import.meta.dir, '..', 'runtime-pool-servers.ts');
  const CLASSIFIER = join(import.meta.dir, '..', '..', 'agent', 'backend', 'internal', 'drivers', 'upstream-target.ts');

  /**
   * The child drives the REAL materialization with `debug: () => {}` - the
   * packaged shape, where the pool's own channel reaches nobody.
   */
  function childSource(): string {
    return [
      `const pool = await import(${JSON.stringify(POOL)})`,
      `const cls = await import(${JSON.stringify(CLASSIFIER)})`,
      `const mcpServers = [`,
      `  { key: "k1", wireName: "dpJira", definition: { type: "http", url: "https://mcp.test/jira" } },`,
      `  { key: "k2", wireName: "dpFs", definition: { type: "http", url: "https://mcp.test/fs" } },`,
      `]`,
      `const runtime = {`,
      `  view: { generation: "g", sources: [], skills: [], mcpServers, hooks: [], automations: [], agents: [],`,
      `    promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [] },`,
      `  materializer: { assertActive(){}, async verifyPlugin(){}, async resolvePath(){ return "/abs/path" },`,
      `    async readText(){ return "{}" }, resolveCredential(){ throw new Error("credential-not-ready") } },`,
      `}`,
      `const modelTarget = cls.classifyModelTarget({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o", providerType: "pi_compat" })`,
      `const out = await pool.materializeRuntimePoolServers(runtime, {`,
      `  workspaceRootPath: "/ws", workspaceId: "ws-1", builtinDpMcpServers: false, modelTarget,`,
      `  debug: () => {},`,
      `})`,
      `console.log("RECEIPT-STDOUT-CONTROL " + Object.keys(out.mergedMcpServers).sort().join(","))`,
    ].join('\n');
  }

  /**
   * `delete` then assign, never `{ ...process.env, NAME: undefined }` - AGENTS.md
   * records that a spread can leave a name set that the object literal meant to
   * clear, which would keep the switch ON in the negative arm.
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

  it('reaches the child\'s STDERR under NESSY_DEBUG=1 although the pool `debug` swallows it', async () => {
    const { stdout, stderr } = await runChild(true);

    // The positive control FIRST, and it carries the policy outcome too: the
    // withholding really ran in this child, so an absent receipt would be an
    // absent RECEIPT rather than an absent decision.
    expect(stdout).toContain('RECEIPT-STDOUT-CONTROL dpJira');
    expect(stdout).not.toContain('dpFs');

    expect(stderr).toContain('external_model_mcp.withheld:external-vendor: dpFs');
    expect(stderr).toContain('[model-target]');
  }, 180_000);

  it('NEGATIVE CONTROL: with the switch off nothing is written, and the instrument still reads the child', async () => {
    const { stdout, stderr } = await runChild(false);
    expect(stdout).toContain('RECEIPT-STDOUT-CONTROL dpJira');
    expect(stderr).not.toContain('external_model_mcp.withheld');
  }, 180_000);
});
