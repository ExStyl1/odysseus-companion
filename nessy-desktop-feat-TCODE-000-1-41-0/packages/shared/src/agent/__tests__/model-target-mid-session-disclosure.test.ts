/**
 * F1.111 (origin WI-bx, D1.425's stated residue) - the external-model
 * disclosure must be minted when a LIVE session's egress moves INTO a
 * restricted target, not only at backend construction.
 *
 * ## The defect
 *
 * `noteModelTargetToolEgress` runs once, in `createBackendFromResolvedContext`
 * (DA2.15). D1.425 then made the VERDICT mobile - `BaseAgent.setSourceServers`
 * re-derives it for the live model on every materialization - without making the
 * disclosure mobile with it. So a session that started on the gateway and
 * switched to an external vendor lost every non-whitelisted MCP server on the
 * next turn while the operator's audited sink recorded nothing at all. AGENTS.md
 * names that case: observability is part of "has a mechanism", and an
 * unauditable influence on permission outcomes is worse than an absent one.
 *
 * ## The instrument, and why two of them
 *
 * The in-process arms drive the REAL `BaseAgent.setSourceServers` with the REAL
 * `setModel` and capture the host port, which is what a host renders from. The
 * CHILD arm at the bottom answers a different question the first cannot - WHICH
 * FILE DESCRIPTOR an operator has to be capturing - because stubbing
 * `process.stderr.write` does not intercept this sink under bun 1.3.14, and
 * because a packaged Electron build drops the `platform.logger` chain the host
 * port is bound to (`apps/electron/src/main/logger.ts`). Its stdout marker is
 * the positive control on that instrument.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { McpClientPool } from '../../mcp/mcp-pool.ts';
import {
  _resetModelTargetNoticesForTesting,
  classifyModelTarget,
  NESSY_GATEWAY_CHAT_BASE_URL,
  noteModelTargetToolEgress,
  type ModelTargetVerdict,
} from '../backend/internal/drivers/upstream-target.ts';
import { CapabilityMaterializationError, type CapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts';
import type { CapabilityTurnRuntime, SdkMcpServerConfig } from '../backend/types.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

afterEach(() => { _resetModelTargetNoticesForTesting(); });

function runtimeWithTwoServers(): CapabilityTurnRuntime {
  const materializer: CapabilitySnapshotMaterializer = {
    assertActive: () => {},
    verifyPlugin: async () => {},
    resolvePath: async () => '/abs/path',
    readText: async () => '{}',
    resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready'); },
  };
  return {
    view: {
      generation: 'g',
      sources: [], skills: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [],
      apps: [], lspServers: [],
      mcpServers: [
        { key: 'k1', wireName: 'dpJira', definition: { type: 'http', url: 'https://mcp.test/jira' } },
        { key: 'k2', wireName: 'dpFs', definition: { type: 'http', url: 'https://mcp.test/fs' } },
      ],
    },
    materializer,
  } as unknown as CapabilityTurnRuntime;
}

class SilentPool extends McpClientPool {
  override async sync(
    _mcpServers: Parameters<McpClientPool['sync']>[0],
    _apiServers: Parameters<McpClientPool['sync']>[1] = {},
  ): Promise<string[]> { return []; }
}

const BYO = 'https://llm-proxy.corp.test/v1';
const INTERNAL_MODEL = 'tgpt/deepseek-v4-flash-0731';
const OTHER_INTERNAL_MODEL = 'tgpt/qwen36-35b-a3b-fp8';
const EXTERNAL_MODEL = 'gpt-4o';
const BYO_INTERNAL = classifyModelTarget({ baseUrl: BYO, model: INTERNAL_MODEL });
const BYO_EXTERNAL = classifyModelTarget({ baseUrl: BYO, model: EXTERNAL_MODEL });

/** One agent, one host sink, driven through the real session path. */
async function sessionWith(modelTarget: ModelTargetVerdict | undefined, model: string) {
  const lines: string[] = [];
  const agent = new TestAgent(createMockBackendConfig({
    mcpPool: new SilentPool({}),
    mcpLeaserId: `session-f1111-${lines.length}-${model}`,
    model,
    ...(modelTarget ? { modelTarget } : {}),
    onModelTargetDisclosure: (line: string) => lines.push(line),
  }));
  agent.setCapabilityTurnRuntime(runtimeWithTwoServers());
  return {
    lines,
    async switchTo(next: string) {
      agent.setModel(next);
      await agent.setSourceServers({}, {}, []);
    },
    async sync() { await agent.setSourceServers({}, {}, []); },
  };
}

describe('BaseAgent.setSourceServers - the mid-session disclosure (F1.111)', () => {
  it('mints exactly ONE notice when a live session moves into a restricted target', async () => {
    const session = await sessionWith(BYO_INTERNAL, INTERNAL_MODEL);
    await session.switchTo(EXTERNAL_MODEL);

    expect(session.lines.length).toBe(1);
    // The sentence is `modelTargetToolEgressNotice`'s, not a second copy: it
    // names the host and the reason the classifier gave, and no URL.
    expect(session.lines[0]).toContain('llm-proxy.corp.test');
    expect(session.lines[0]).toContain('MCP tool schema');
    expect(session.lines[0]).not.toContain(BYO);
  });

  it('CONTROL: a switch between two in-perimeter models emits NOTHING', async () => {
    const session = await sessionWith(BYO_INTERNAL, INTERNAL_MODEL);
    await session.switchTo(OTHER_INTERNAL_MODEL);
    expect(session.lines).toEqual([]);
  });

  it('CONTROL: moving BACK inside the perimeter emits nothing either', async () => {
    // Only the transition INTO a restricted target is a disclosure; coming back
    // withholds nothing and there is nothing to disclose.
    const session = await sessionWith(BYO_EXTERNAL, EXTERNAL_MODEL);
    await session.switchTo(INTERNAL_MODEL);
    expect(session.lines).toEqual([]);
  });

  it('CONTROL: a session CONSTRUCTED on an external model still gets exactly one notice, and not from here', async () => {
    // The factory speaks for it. This path must add nothing, or the user would
    // be told twice about a target that never moved.
    const factoryLines: string[] = [];
    noteModelTargetToolEgress({
      baseUrl: BYO, model: EXTERNAL_MODEL, providerType: 'pi_compat',
      emit: (line: string) => factoryLines.push(line),
    });
    expect(factoryLines.length).toBe(1);

    const session = await sessionWith(BYO_EXTERNAL, EXTERNAL_MODEL);
    await session.sync();
    await session.sync();
    expect(session.lines).toEqual([]);
  });

  it('CONTROL: a session with NO verdict discloses nothing, whatever it switches to', async () => {
    const session = await sessionWith(undefined, INTERNAL_MODEL);
    await session.switchTo(EXTERNAL_MODEL);
    expect(session.lines).toEqual([]);
  });

  it('CONTROL: a GATEWAY session discloses nothing, because the endpoint decided', async () => {
    const gateway = classifyModelTarget({ baseUrl: NESSY_GATEWAY_CHAT_BASE_URL, model: INTERNAL_MODEL });
    const session = await sessionWith(gateway, INTERNAL_MODEL);
    await session.switchTo(EXTERNAL_MODEL);
    expect(session.lines).toEqual([]);
  });

  it('CONTROL: the per-process dedupe still collapses two sessions onto one key', async () => {
    const first = await sessionWith(BYO_INTERNAL, INTERNAL_MODEL);
    await first.switchTo(EXTERNAL_MODEL);
    const second = await sessionWith(BYO_INTERNAL, INTERNAL_MODEL);
    await second.switchTo(EXTERNAL_MODEL);

    expect(first.lines.length).toBe(1);
    expect(second.lines).toEqual([]);
  });
});

describe('F1.111 - the notice reaches a file descriptor a packaged build keeps', () => {
  const MODULE = join(import.meta.dir, '..', 'backend', 'internal', 'drivers', 'upstream-target.ts');

  function childSource(): string {
    return [
      `const m = await import(${JSON.stringify(MODULE)})`,
      `const verdict = m.classifyModelTarget({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o", providerType: "pi_compat" })`,
      `m.noteModelTargetVerdictEgress({ verdict, model: "gpt-4o" })`,
      `console.log("DISCLOSURE-STDOUT-CONTROL")`,
    ].join('\n');
  }

  /**
   * `delete` then assign, never `{ ...process.env, NAME: undefined }`: AGENTS.md
   * records that Bun 1.3.14 leaves some names readable by property and invisible
   * to a spread, and an env built by spreading `undefined` over a set value is
   * the shape that quietly keeps the switch ON in the negative arm.
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

  it('writes the line to the child\'s STDERR under NESSY_DEBUG=1, with a stdout control', async () => {
    const { stdout, stderr } = await runChild(true);
    // The positive control FIRST: without it an absent line says nothing.
    expect(stdout).toContain('DISCLOSURE-STDOUT-CONTROL');
    expect(stderr).toContain('[model-target]');
    expect(stderr).toContain('api.openai.com');
    expect(stderr).toContain('external model vendor');
  }, 120_000);

  it('NEGATIVE CONTROL: with the switch off the same child writes no such line, and the instrument still reads it', async () => {
    const { stdout, stderr } = await runChild(false);
    expect(stdout).toContain('DISCLOSURE-STDOUT-CONTROL');
    expect(stderr).not.toContain('[model-target]');
  }, 120_000);
});
