/**
 * P3.279 — Pi receives an MCP server's `instructions`.
 *
 * `mcp.md#scale-with-mcp-tool-search`, verbatim: *"Only tool names and server
 * instructions load at session start, so adding more MCP servers has minimal
 * impact on your context window."* P3.228 delivered the second half on
 * `claude-agent.ts` (per source, into the SDK's `instructions` option) and on
 * `McpPoolServer` (flattened into one `instructions` slot) — and that pool
 * server is codex-only, so Pi's path delivered instructions from no server,
 * ever. Not stale; absent.
 *
 * These tests drive `PiAgent.chatImpl` on the production path — the same rig
 * `pi-hook-context-fence.test.ts` uses — and read the `systemPrompt` string that
 * actually reaches the subprocess. Reading the composed prompt and not the
 * helper's return value is the point: a block composed and then dropped before
 * the `send` would pass a unit test of the composer and change nothing the model
 * sees, which is the exact shape of the defect this row records.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../backend/types.ts';
import { MCP_TEXT_MAX_CHARS, MCP_TEXT_TRUNCATION_MARKER } from '../../mcp/third-party-text.ts';
import { PiAgent } from '../pi-agent.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-mcp-instructions-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** What each call to the pool was asked, so leaser scoping is observable. */
interface PoolProbe {
  asked: Array<{ slug: string; leaserId: string | undefined }>;
  leaserSlugCalls: string[];
  connectedSlugCalls: number;
}

function stubPool(
  instructions: Record<string, string | undefined>,
  probe: PoolProbe,
  options?: { leased?: readonly string[] },
) {
  return {
    getInstructions(slug: string, leaserId?: string): string | undefined {
      probe.asked.push({ slug, leaserId });
      return instructions[slug];
    },
    slugsForLeaser(leaserId: string): Set<string> {
      probe.leaserSlugCalls.push(leaserId);
      return new Set(options?.leased ?? Object.keys(instructions));
    },
    getConnectedSlugs(): string[] {
      probe.connectedSlugCalls += 1;
      return Object.keys(instructions);
    },
    // The rest of the surface construction and `chatImpl` brush against on this
    // rig. `BaseAgent`'s constructor registers an elicitation handler on the
    // pool, so these two are load-bearing for the agent to exist at all.
    setElicitationHandler: () => {},
    registerElicitationHandler: () => () => {},
    getProxyToolDefs: () => [],
    alwaysLoadProxyToolNames: () => [],
    hasResourceCapability: () => false,
    isProxyTool: () => false,
  };
}

function config(pool: unknown, mcpLeaserId?: string): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-mcp-instructions',
      name: 'Test Workspace',
      rootPath: tempDir,
      workspaceRootPath: tempDir,
      sessionRootPath: join(tempDir, 'sessions'),
    },
    session: {
      id: 'session-mcp-instructions',
      workspaceRootPath: tempDir,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: tempDir,
    },
    model: 'pi/test-model',
    isHeadless: true,
    ...(pool === undefined ? {} : { mcpPool: pool }),
    ...(mcpLeaserId === undefined ? {} : { mcpLeaserId }),
  } as unknown as BackendConfig;
}

/** Drive one turn and return the two strings the subprocess is sent. */
async function turn(pool: unknown, mcpLeaserId?: string): Promise<{ systemPrompt: string; message: string }> {
  const agent = new PiAgent(config(pool, mcpLeaserId));
  const prompts: Array<Record<string, unknown>> = [];
  const internals = agent as unknown as Record<string, any>;
  internals.ensureSubprocess = async () => undefined;
  internals.syncExecutionManifestForCurrentTurn = async () => ({
    snapshotGeneration: 'generation-1',
    manifestHash: 'manifest-1',
    tools: [],
    deferredMcp: { candidatePiNames: [] },
  });
  internals.send = (message: Record<string, unknown>) => {
    if (message.type !== 'prompt') return;
    prompts.push(message);
    (internals.eventQueue as { complete: () => void }).complete();
  };
  for await (const _ of internals.chatImpl('ship the thing')) { /* drain */ }
  agent.destroy();
  return {
    systemPrompt: String(prompts[0]?.systemPrompt ?? ''),
    message: String(prompts[0]?.message ?? ''),
  };
}

function probe(): PoolProbe {
  return { asked: [], leaserSlugCalls: [], connectedSlugCalls: 0 };
}

describe('P3.279 — a connected MCP server\'s instructions reach Pi\'s model', () => {
  it('delivers every connected source, labelled by slug, in the system prompt', async () => {
    const p = probe();
    const { systemPrompt, message } = await turn(stubPool({
      linear: 'Always search before creating an issue.',
      notion: 'This workspace is read-only.',
    }, p));

    // MUTATION KILLED: never calling the composer. Before this row the string
    // below appeared nowhere on Pi's path, for any server.
    expect(systemPrompt).toContain('<mcp_server_instructions>');
    expect(systemPrompt).toContain('</mcp_server_instructions>');

    // The `## <slug>` heading is `McpPoolServer.aggregateSourceInstructions`'s
    // spelling, kept identical so a server's instructions do not change shape
    // across a Pi↔codex switch.
    expect(systemPrompt).toContain('## linear\n\nAlways search before creating an issue.');
    expect(systemPrompt).toContain('## notion\n\nThis workspace is read-only.');

    // Provenance is stated: Pi has no MCP protocol frame to carry it.
    expect(systemPrompt).toContain('is the `instructions` an MCP server returned');

    // BAND: the system prefix, not the user tail — instructions load "at session
    // start", and a per-turn re-stamp of the volatile tail is not that.
    expect(message).not.toContain('<mcp_server_instructions>');
    expect(message).toContain('ship the thing');
  });

  it('CONTROL: a pool whose sources said nothing emits no element at all', async () => {
    // MUTATION KILLED: emitting the element unconditionally. An empty block is a
    // claim that a server described itself, and it would ride the cached prefix
    // of every session with an MCP source connected.
    const p = probe();
    const { systemPrompt } = await turn(stubPool({ linear: undefined, notion: undefined }, p));
    expect(systemPrompt).not.toContain('<mcp_server_instructions>');
    // The negative is a real read, not an empty loop: both sources were asked.
    expect(p.asked.map(entry => entry.slug)).toEqual(['linear', 'notion']);
  });

  it('CONTROL: a session with no pool at all composes the same prompt as before', async () => {
    const { systemPrompt } = await turn(undefined);
    expect(systemPrompt).not.toContain('<mcp_server_instructions>');
    // Positive control on the same rig: the prompt itself was really composed.
    expect(systemPrompt).toContain('<working_directory>');
  });

  it('asks the LEASED slugs under a shared pool, and the pool-wide set without a leaser', async () => {
    // A shared workspace pool scopes what this session may see; asking the
    // pool-wide set there would describe a server this session cannot call.
    const leased = probe();
    await turn(stubPool(
      { linear: 'Leased.', foreign: 'Another session\'s source.' },
      leased,
      { leased: ['linear'] },
    ), 'leaser-A');
    expect(leased.leaserSlugCalls).toContain('leaser-A');
    expect(leased.connectedSlugCalls).toBe(0);
    expect(leased.asked).toEqual([{ slug: 'linear', leaserId: 'leaser-A' }]);

    const shared = probe();
    await turn(stubPool({ linear: 'Private pool.' }, shared));
    expect(shared.connectedSlugCalls).toBeGreaterThan(0);
    expect(shared.asked).toEqual([{ slug: 'linear', leaserId: undefined }]);
  });

  /**
   * `mcp.md#for-mcp-server-authors`: *"Claude Code truncates tool descriptions
   * and server instructions at 2KB each."* Pi is the runtime built to that page,
   * and this is the surface where the bytes land in the system prefix as free
   * text — unbounded, one server's `initialize` result would size Pi's cached
   * prefix.
   *
   * P3.292 moved the cap into `mcp/third-party-text.ts` and changed its spelling
   * to the one measured in the vendored binary: 2048 CODE UNITS rather than
   * UTF-8 bytes, and the vendor's own `… [truncated]` rather than a
   * self-explaining marker. Both changes exist so the same server's prose is the
   * same bytes on claude, Pi and codex; the assertions below are written against
   * the shared constants for that reason.
   */
  it('caps one server\'s instructions and marks the cut the way the binary does', async () => {
    const p = probe();
    const huge = `HEAD_MARK ${'a'.repeat(4000)} TAIL_MARK`;
    const { systemPrompt } = await turn(stubPool({ linear: huge }, p));

    expect(systemPrompt).toContain('HEAD_MARK');
    // MUTATION KILLED: delivering the body uncapped.
    expect(systemPrompt).not.toContain('TAIL_MARK');
    expect(systemPrompt).toContain(MCP_TEXT_TRUNCATION_MARKER);

    const block = systemPrompt.slice(
      systemPrompt.indexOf('## linear\n\n') + '## linear\n\n'.length,
      systemPrompt.indexOf('\n</mcp_server_instructions>'),
    );
    expect(block.length).toBe(MCP_TEXT_MAX_CHARS + MCP_TEXT_TRUNCATION_MARKER.length);
  });

  it('BOUNDARY: a non-ASCII body inside the cap is delivered whole, marker-free', async () => {
    // The regression this pins: the cap used to count UTF-8 BYTES, so a Cyrillic
    // body of 1500 characters (3000 bytes) was CUT here while claude delivered
    // it whole. Under the binary's spelling it is 1500 code units and survives.
    const p = probe();
    const body = `${'д'.repeat(1500)}END_MARK`;
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(2048);
    expect(body.length).toBeLessThanOrEqual(MCP_TEXT_MAX_CHARS);
    const { systemPrompt } = await turn(stubPool({ linear: body }, p));
    expect(systemPrompt).toContain(body);
    expect(systemPrompt).not.toContain(MCP_TEXT_TRUNCATION_MARKER);
  });
});

/**
 * P3.292 — the OTHER half of the same page sentence, which no runtime in this
 * tree implemented: an MCP server also authors every tool `description`, and on
 * Pi those descriptors go into the turn's execution manifest.
 */
describe('P3.292 — an MCP tool description is capped, and only an MCP one', () => {
  it('caps a source tool\'s description and leaves a host tool\'s alone', () => {
    // Read at `buildCurrentProxyToolDefinitions`, which is the ONE producer of
    // this list (`buildExecutionManifestForCurrentTurn` is its only caller), so
    // a cap applied here is a cap on what the manifest ships.
    const p = probe();
    const pool = {
      ...stubPool({}, p),
      getConnectedSlugs: () => [],
      getProxyToolDefs: () => [
        {
          name: 'mcp__linear__createIssue',
          description: `HEAD_MARK${'y'.repeat(4000)}TAIL_MARK`,
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'mcp__linear__search',
          description: 'Search issues.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };

    const agent = new PiAgent(config(pool));
    const tools = (agent as unknown as {
      buildCurrentProxyToolDefinitions(): Array<{ name: string; description: string }>;
    }).buildCurrentProxyToolDefinitions();
    agent.destroy();
    const byName = new Map(tools.map(tool => [String(tool.name), String(tool.description ?? '')]));

    const capped = byName.get('mcp__linear__createIssue') ?? '';
    expect(capped).toContain('HEAD_MARK');
    // MUTATION KILLED: passing the pool's descriptors through unmapped.
    expect(capped).not.toContain('TAIL_MARK');
    expect(capped.endsWith(MCP_TEXT_TRUNCATION_MARKER)).toBe(true);
    // CONTROL: a short MCP description on the same list is untouched.
    expect(byName.get('mcp__linear__search')).toBe('Search issues.');

    // CONTROL on the same manifest: a HOST tool's description is not MCP-authored
    // prose and must not be cut by a rule about what a server author writes.
    // MUTATION KILLED: capping the whole `tools` array.
    const hostTool = tools.find(tool => String(tool.name).startsWith('mcp__session__'));
    expect(hostTool).toBeDefined();
    expect(String(hostTool?.description ?? '')).not.toContain(MCP_TEXT_TRUNCATION_MARKER);
  });
});
