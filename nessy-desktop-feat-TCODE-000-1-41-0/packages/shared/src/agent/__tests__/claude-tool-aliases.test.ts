/**
 * P6.220 — the built-in names we ban reach the host's gated twin when the model
 * utters one anyway.
 *
 * Before this row `Options.toolAliases` had zero callers in the tree, so a
 * `Monitor` call the child emitted (because a skill document named it) died as
 * an unknown tool rather than landing on `mcp__session__Monitor`, whose start
 * `SessionManager.authorizeMonitor` gates and whose run the host instruments.
 *
 * Four claims, each failing in a different direction:
 *  - the alias map is WIRED into the one options literal that builds the child;
 *  - it is withheld when the `session` server is not in the projection, so it
 *    never points at a tool the child cannot resolve;
 *  - every KEY is a name the runtime bans, so the alias can never resurrect a
 *    tool the ban exists to remove from context;
 *  - every VALUE names a session tool that really exists, which is the half a
 *    rename in `tool-defs.ts` would take away silently.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CLAUDE_SESSION_DISALLOWED_TOOLS,
  CLAUDE_TOOL_ALIASES,
  claudeToolAliasesFor,
} from '../claude-agent.ts';
import { handlePublishArtifact, PublishArtifactSchema, SESSION_TOOL_NAMES, type SessionToolContext } from '@nessy-agent/session-tools-core';

type McpSet = Parameters<typeof claudeToolAliasesFor>[0];

/** A projection carrying the session server, shaped only as far as the guard reads it. */
const WITH_SESSION = { session: {}, linear: {} } as unknown as McpSet;
/** The mini path's filtered projection, with `session` dropped. */
const WITHOUT_SESSION = { linear: {} } as unknown as McpSet;

describe('P6.220 claude tool aliases', () => {
  it('offers the aliases when the session server is projected', () => {
    expect(claudeToolAliasesFor(WITH_SESSION)).toEqual({
      Monitor: 'mcp__session__Monitor',
      ScheduleWakeup: 'mcp__session__ScheduleWakeup',
      // UA1.20 — the claude.ai publisher lands on our carded t-artifacts tool.
      Artifact: 'mcp__session__publish_artifact',
    });
  });

  it('withholds them entirely when the session server is not in the set', () => {
    expect(claudeToolAliasesFor(WITHOUT_SESSION)).toBeUndefined();
    expect(claudeToolAliasesFor(undefined)).toBeUndefined();
    expect(claudeToolAliasesFor({} as unknown as McpSet)).toBeUndefined();
  });

  it('aliases only names this runtime bans, onto session tools that exist', () => {
    // Same-name twins for P6.220's two; UA1.20's `Artifact` is the one whose twin is named differently.
    const TWIN: Record<string, string> = { Monitor: 'Monitor', ScheduleWakeup: 'ScheduleWakeup', Artifact: 'publish_artifact' };
    expect(Object.keys(CLAUDE_TOOL_ALIASES).sort()).toEqual(Object.keys(TWIN).sort());
    for (const [builtin, target] of Object.entries(CLAUDE_TOOL_ALIASES)) {
      expect(CLAUDE_SESSION_DISALLOWED_TOOLS).toContain(builtin);
      expect(target).toBe(`mcp__session__${TWIN[builtin]}`);
      expect(SESSION_TOOL_NAMES.has(TWIN[builtin]!)).toBe(true);
    }
  });

  it('is wired into the options literal, not merely exported', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf-8');
    expect(source).toContain('const toolAliases = claudeToolAliasesFor(mcpServers);');
    expect(source).toContain('...(toolAliases ? { toolAliases } : {}),');
  });

  it('keeps the ban — the SDK calls the alias complementary to disallowedTools', () => {
    // A future edit that "simplifies" by dropping the ban would put the ungated
    // native copies back on the model's surface, which is the defect the two
    // entries were added for.
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).toContain('Monitor');
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).toContain('ScheduleWakeup');
    // UA1.20 — "the ban and the alias ship together": the alias catches the utterance, F1.253's ban keeps the
    // claude.ai publisher off the surface.
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).toContain('Artifact');
  });
});

/**
 * UA1.20 (O12) — the native `ArtifactInput` read out of the INSTALLED SDK at run time (the bundle is the denominator
 * for membership, AGENTS.md), so a field or an action a future bundle adds fails HERE, by name, until someone decides
 * what `publish_artifact` does with it. Read on 2026-10-10 from claudeCodeVersion 2.1.280 (the 0.3.280 lift, UA12.211);
 * the cached tarballs differ: `note` dropped by 2.1.267, `list_types` added in 2.1.267, `icon` added in 2.1.274,
 * `file_paths` added in 2.1.280.
 */
describe('UA1.20 the native Artifact shape against the installed sdk-tools.d.ts', () => {
  function artifactInputBody(): string {
    const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const typings = readFileSync(`${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk-tools.d.ts`, 'utf8');
    const start = typings.indexOf('export interface ArtifactInput {');
    expect(start).toBeGreaterThan(-1);
    const rest = typings.slice(start);
    return rest.slice(0, rest.indexOf('\n}\n'));
  }
  const fields = (): string[] => [...artifactInputBody().matchAll(/^ {2}([a-z_]+)\??:/gm)].map(match => match[1]!);
  const actions = (): string[] => {
    const body = artifactInputBody();
    const union = body.slice(body.indexOf('  action?:'), body.indexOf(';', body.indexOf('  action?:')));
    return [...union.matchAll(/"([a-z_]+)"/g)].map(match => match[1]!);
  };

  /** The publish fields the schema carries (mapped), and the two dropped sets — the decision, written down. */
  const DROPPED_CLAUDE_AI_KNOBS = ['label', 'icon', 'force', 'capabilities', 'contract'];
  // `file_paths` (2.1.280, the 0.3.280 lift): upload_asset's "several local … files in
  // place of `file_path`" — publish's own docblock still says "Content always comes from
  // file_path", so the alias schema keeps the singular and the zod parse strips this.
  const DROPPED_OTHER_ACTION_FIELDS = ['limit', 'scope', 'prompt', 'out_dir', 'asset_id', 'after', 'file_paths'];

  it('reads a non-empty interface (positive control on the same instrument)', () => {
    expect(fields()).toContain('file_path');
    expect(fields()).toContain('favicon');
    expect(actions()).toContain('publish');
    expect(actions().length).toBeGreaterThan(1);
  });

  it('every ArtifactInput field is either in the publish_artifact schema or deliberately dropped', () => {
    const schemaKeys = Object.keys(PublishArtifactSchema.shape);
    const unclassified = fields().filter(field => !schemaKeys.includes(field)
      && !DROPPED_CLAUDE_AI_KNOBS.includes(field) && !DROPPED_OTHER_ACTION_FIELDS.includes(field));
    expect(unclassified).toEqual([]);
    // The dropped ones really are absent from the schema, so the zod parse strips them.
    for (const field of [...DROPPED_CLAUDE_AI_KNOBS, ...DROPPED_OTHER_ACTION_FIELDS]) expect(schemaKeys, field).not.toContain(field);
  });

  it('every native action but publish is refused with the list_artifacts pointer and never reaches the host', async () => {
    let calls = 0;
    const ctx = { publishArtifact: async () => { calls += 1; return { status: 'published', note: 'x' }; } } as unknown as SessionToolContext;
    const refused = actions().filter(action => action !== 'publish');
    expect(refused).toContain('delete_asset');
    for (const action of refused) {
      const result = await handlePublishArtifact(ctx, { action, file_path: 'a.html' });
      expect(result.isError, action).toBe(true);
      expect(result.content[0]?.type === 'text' ? result.content[0].text : '', action).toContain('list_artifacts');
    }
    expect(calls).toBe(0);
    // The control: the one action that IS performed reaches the host closure.
    await handlePublishArtifact(ctx, { action: 'publish', file_path: 'a.html' });
    expect(calls).toBe(1);
  });
});

describe('UA1.20 follow-up: an alias named unlike its target keeps the target\'s name-keyed UI', () => {
  // The alias changes only which tool runs; the transcript row keeps the name the model emitted (`tool-matching.ts`
  // takes `toolBlock.name`). So a renderer consumer keyed on the target's name must accept the alias KEY as well, or
  // the aliased call loses it — here the UA1.19 chip (`packages/ui/src/components/chat/published-artifact.ts`).
  it('every alias onto a publish tool is a name the artifact chip accepts', async () => {
    const { isPublishArtifactToolName } = await import('../../../../ui/src/components/chat/published-artifact.ts');
    const keys = Object.entries(CLAUDE_TOOL_ALIASES).filter(([, target]) => isPublishArtifactToolName(target)).map(([key]) => key);
    expect(keys).toEqual(['Artifact']); // positive control: the derivation finds the alias at all
    for (const key of keys) expect(isPublishArtifactToolName(key)).toBe(true);
    expect(isPublishArtifactToolName('Monitor')).toBe(false); // negative: a same-name twin is not swept in
  });
});

/**
 * UA12.58 [claude][measure] — the seam the `Artifact` alias rides, measured OFFLINE against the
 * INSTALLED SDK (the bundle is the denominator, as above; read 2026-10-04 on the 2.1.274
 * bundle): a recording fake transport drives the real `createSdkMcpServer` instance with
 * `publish_artifact`'s own shape — no model, no network, no CLI.
 *
 * The two halves this pins are the premises of the UA1.22 sitting arm (native `Artifact` with
 * extra fields → the publish card), whose model→dispatch half only that sitting can measure:
 *
 *  - the schema the CLI receives at `tools/list` carries `additionalProperties: false`, so a
 *    CLI that validates input against the advertised schema COULD refuse a native-shaped call
 *    before it reaches us. Binary probes on this bundle (grep -a, positive control
 *    `tools/call` = 36 occurrences) found no input-validation machinery on the MCP call path —
 *    the bundled MCP client's `callTool` forwards `params` unvalidated and its only schema
 *    validation runs on RESPONSES (structured content vs output schema) — but strings are
 *    presence evidence, not behaviour, so that half stays with the sitting;
 *  - GIVEN the call arrives, the SDK server's own zod parse STRIPS the dropped native fields
 *    (`label`, `force`, `capabilities`, `contract`, `icon`) before our handler runs — the
 *    "still no request and no DELETE" half of P-UA-w-3, measured rather than asserted.
 */
describe('UA12.58 the seam the Artifact alias rides, against the installed SDK', () => {
  /** A transport that records what the SDK answers; requests are injected through its onmessage. */
  function probeTransport() {
    const sent: Array<Record<string, unknown>> = [];
    const transport: Record<string, unknown> = {
      start: async () => {}, close: async () => {}, onmessage: null, onerror: null, onclose: null,
      send: async (msg: unknown) => { sent.push(msg as Record<string, unknown>); },
    };
    return { transport, sent };
  }
  async function answer(transport: Record<string, unknown>, request: Record<string, unknown>): Promise<void> {
    (transport.onmessage as (m: unknown) => void)(request);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  async function probeServer(handlerArgs: Array<Record<string, unknown>>) {
    const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
    const server = createSdkMcpServer({
      name: 'session',
      version: '1.0.0',
      tools: [tool('publish_artifact', 'probe', PublishArtifactSchema.shape as never, async (args: Record<string, unknown>) => {
        handlerArgs.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      }) as never],
    });
    const { transport, sent } = probeTransport();
    await (server as { instance: { connect: (t: unknown) => Promise<void> } }).instance.connect(transport);
    return { transport, sent };
  }

  it('advertises publish_artifact with additionalProperties:false (the premise the sitting arm tests against)', async () => {
    const handlerArgs: Array<Record<string, unknown>> = [];
    const { transport, sent } = await probeServer(handlerArgs);
    await answer(transport, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const list = sent.find(message => message.id === 1) as { result?: { tools?: Array<{ name: string; inputSchema: Record<string, unknown> }> } } | undefined;
    const schema = list?.result?.tools?.find(def => def.name === 'publish_artifact')?.inputSchema;
    expect(schema?.type).toBe('object'); // positive control: the tool came back at all
    expect(schema?.additionalProperties).toBe(false); // the row's premise, now pinned to the bundle
  });

  it('the SDK server strips the dropped native fields — no refusal at the seam', async () => {
    const handlerArgs: Array<Record<string, unknown>> = [];
    const { transport, sent } = await probeServer(handlerArgs);
    await answer(transport, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'publish_artifact', arguments: { action: 'publish', file_path: 'probe.html', label: 'x', force: true, capabilities: ['*'], contract: 'c', icon: 'i' } },
    });
    const call = sent.find(message => message.id === 2) as { result?: { isError?: boolean; content?: Array<{ type: string }> } } | undefined;
    expect(call?.result?.content?.[0]?.type).toBe('text'); // the call succeeded
    expect(call?.result?.isError).toBeUndefined();
    expect(handlerArgs).toEqual([{ action: 'publish', file_path: 'probe.html' }]); // stripped, not refused
  });
});
