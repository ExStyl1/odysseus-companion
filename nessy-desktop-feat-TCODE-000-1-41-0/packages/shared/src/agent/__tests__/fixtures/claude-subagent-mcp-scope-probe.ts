/**
 * P6.832 — is `AgentDefinition.mcpServers` ADDITIVE or RESTRICTIVE?
 *
 * ## The question, and why neither side's documentation answers it
 *
 * `claude-runtime-agents.ts` forwards an author's declared MCP servers to a
 * subagent as wire NAMES since P6.791. What that forwarding MEANS to the child
 * is undocumented on both sides:
 *
 * - `sdk.d.ts:59` types the field `mcpServers?: AgentMcpServerSpec[]` with **no
 *   doc comment at all**, unlike its neighbour `tools`, whose comment states the
 *   inheritance rule outright (*"If omitted, inherits all tools from parent"*).
 * - `sub-agents.md#scope-mcp-servers-to-a-subagent` frames the field additively —
 *   *"Use the `mcpServers` field to give a subagent access to MCP servers that
 *   aren't available in the main conversation"* — and its §Tools sentence says
 *   *"Subagents inherit the built-in tools and MCP tools available in the main
 *   conversation, narrowed by two filters"*, neither of which is this field. But
 *   nothing on the page says what happens to the OTHER session servers when the
 *   list is present, and "give access to servers that aren't available" is
 *   equally true of a field that replaces the pool.
 *
 * The difference is not cosmetic: under the restrictive reading, an author who
 * names one server to ADD it silently removes every other server the session
 * configured from that subagent's reach, and we would be forwarding a widening
 * as a narrowing.
 *
 * ## The rig
 *
 * One real turn on the vendored claude child (`pathToClaudeCodeExecutable` →
 * the vendored binary, provenance asserted from the child's own `user-agent`
 * against the vendored manifest, per AGENTS.md §Traps — a rig that resolves a
 * different SDK measures a runtime this repo does not ship).
 *
 * - The session configures **two** stdio MCP servers, `alpha` and `beta`, each
 *   exposing exactly one tool. They are the same self-terminating fixture shape
 *   `claude-managed-mcp-spawn-probe.ts` proved, extended to answer `tools/list`
 *   with a real tool so the names reach the wire.
 * - One subagent definition, `prober`, names **`alpha` only** — the string
 *   reference form, which the page calls *"a string referencing an MCP server
 *   already configured in your session"*.
 * - The upstream is a SCRIPTED Anthropic Messages stub, not a model. It records
 *   every request's `tools` array, answers the main turn with a `tool_use` for
 *   the child's own agent-spawning tool, and answers everything else with one
 *   word. **No credential is involved and no model is consulted**: what is
 *   measured is the child's own tool-pool ASSEMBLY for the subagent, which is
 *   exactly the thing in question.
 * - The observable is the `mcp__*` tool names in the request the SUBAGENT's turn
 *   sends. Additive ⇒ both servers' tools are there; restrictive ⇒ only
 *   `alpha`'s. The subagent's request is identified by {@link SUBAGENT_MARKER},
 *   a string that appears only in its system prompt.
 *
 * A NEGATIVE CONTROL runs the identical rig with the `mcpServers` field OMITTED:
 * without it, "the subagent sees both" would be indistinguishable from "the field
 * did nothing at all", and an absence finding needs a positive control on the
 * same rig (AGENTS.md).
 *
 * Every side effect is behind `import.meta.main` — a fixture whose module body
 * exits kills the runner at import time and reports exit 0 with ZERO tests
 * executed (AGENTS.md, measured 2026-09-01).
 *
 * ## THE RESULT: ADDITIVE. Measured 2026-09-08, all three arms
 *
 * Vendored 2.1.233 / agent-sdk 0.3.233, asserted from the child's own
 * `user-agent` (`claude-cli/2.1.233 (external, sdk-ts, agent-sdk/0.3.233)`) on
 * every arm; the agent-spawning tool the child published was `Agent`; every arm
 * ended `success`, and a subagent turn reached the upstream in all three.
 *
 * | arm | MAIN turn's MCP tools | SUBAGENT turn's MCP tools |
 * | --- | --- | --- |
 * | `declares-nothing` | alpha, beta | alpha, beta |
 * | `declares-alpha` | alpha, beta | alpha, beta |
 * | `declares-inline-gamma` | alpha, beta | alpha, beta, **gamma** |
 *
 * The field only ADDS. Declaring one of the session's two servers takes nothing
 * away — the subagent is offered exactly what the control arm offers it — and an
 * inline server the session does not have appears in the subagent's pool beside
 * both inherited ones while the main turn never sees it, which is
 * `sub-agents.md#scope-mcp-servers-to-a-subagent` verbatim: *"The subagent gets
 * the tools; the parent conversation doesn't."*
 *
 * The inline arm is load-bearing: `declares-alpha` and `declares-nothing` are
 * identical, so on their own they cannot separate *additive* from *the field was
 * never read*. Only an entry the session lacks can, and it did.
 *
 * Also observed, incidentally: the subagent's BUILT-IN pool is smaller than the
 * main turn's (no `Cron*`, `Task*`, `Workflow`, `ReportFindings`,
 * `ScheduleWakeup`) — `sub-agents.md#available-tools`'s two filters. The MCP half
 * of the pool is untouched by them.
 */
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  vendoredClaudeBinary,
  vendoredVersions,
} from '../../../config/__tests__/fixtures/claude-policy-helper-probe.ts';

export { vendoredClaudeBinary, vendoredVersions };

/** Never reaches a model; the stub answers every request itself. */
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** Appears ONLY in the subagent's system prompt, so its turn is identifiable. */
export const SUBAGENT_MARKER = 'P6832-SUBAGENT-PROMPT-MARKER';

/** The two servers the SESSION configures. The definition names only the first. */
export const SERVER_A = 'alphaprobe';
export const SERVER_B = 'betaprobe';
/** Configured ONLY inside the agent definition — never in the session. */
export const SERVER_C = 'gammaprobe';
const TOOL_A = 'alpha_ping';
const TOOL_B = 'beta_ping';
const TOOL_C = 'gamma_ping';

export type ScopeArm =
  /** The subject: the definition names `alphaprobe` and nothing else. */
  | 'declares-alpha'
  /** NEGATIVE CONTROL: the identical rig with no `mcpServers` field at all. */
  | 'declares-nothing'
  /**
   * THE SEPARATING ARM. `declares-alpha` and `declares-nothing` cannot tell
   * "additive" from "the field was ignored": a string reference names a server
   * the session already has, and a subagent inherits those anyway. An INLINE
   * server the session does NOT configure appears in the subagent's pool only if
   * the field was read at all — and the other two servers' presence beside it is
   * then additivity, measured rather than assumed.
   */
  | 'declares-inline-gamma';

export interface RecordedRequest {
  index: number;
  /** Is this the SUBAGENT's turn? True when the marker is in the body. */
  subagent: boolean;
  /** Every tool name the child offered on this request. */
  toolNames: string[];
  /** Just the MCP ones, which is the whole subject. */
  mcpToolNames: string[];
}

export interface ScopeOutcome {
  arm: ScopeArm;
  /** The agent-spawning tool the child actually published, by name. */
  agentToolName: string | null;
  /** Did a subagent turn ever reach the upstream? Nothing is concluded if not. */
  sawSubagentTurn: boolean;
  /** The MCP tools the MAIN turn was offered — the pool the subagent narrows. */
  mainMcpTools: string[];
  /** The MCP tools the SUBAGENT turn was offered — the answer. */
  subagentMcpTools: string[];
  requests: RecordedRequest[];
  ended: 'result' | 'throw';
  detail: string;
  /** The child's self-report, checked against the vendored manifest. */
  userAgent: string | null;
}

/**
 * A stdio MCP server that answers a handshake and publishes exactly one tool.
 *
 * Same shape as `claude-managed-mcp-spawn-probe.ts`'s fixture (which returns an
 * EMPTY tool list, since its observable is the spawn), with a real `tools/list`
 * entry: here the tool NAME is the observable and an empty list would measure
 * nothing.
 */
function writeMcpFixture(path: string, serverName: string, toolName: string): void {
  writeFileSync(path, [
    `#!${process.execPath}`,
    "let buffer = ''",
    "process.stdin.on('data', chunk => {",
    '  buffer += chunk',
    "  let index = buffer.indexOf('\\n')",
    '  while (index >= 0) {',
    '    const line = buffer.slice(0, index).trim()',
    '    buffer = buffer.slice(index + 1)',
    "    index = buffer.indexOf('\\n')",
    '    if (!line) continue',
    '    let message',
    '    try { message = JSON.parse(line) } catch { continue }',
    '    if (message.id === undefined) continue',
    "    const result = message.method === 'initialize'",
    `      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(serverName)}, version: '0.0.1' } }`,
    "      : message.method === 'tools/list'",
    `        ? { tools: [{ name: ${JSON.stringify(toolName)}, description: 'probe tool', inputSchema: { type: 'object', properties: {} } }] }`,
    '        : {}',
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')",
    '  }',
    '})',
    '// Self-terminate so a refused or timed-out connect cannot leak a process.',
    'setTimeout(() => process.exit(0), 60000)',
  ].join('\n'));
  chmodSync(path, 0o755);
}

interface ScriptedStub {
  port: number;
  requests: RecordedRequest[];
  agentToolName: string | null;
  userAgent: string | null;
  close: () => Promise<void>;
}

type WireTool = { name?: string; input_schema?: { properties?: Record<string, unknown> } };

/**
 * The Anthropic Messages endpoint, scripted rather than canned.
 *
 * It answers the FIRST non-subagent request with a `tool_use` for whichever
 * agent-spawning tool the child published (read from that request's own `tools`
 * array — the `Task`→`Agent` rename is a shipped bug in this tree's history, so
 * the name is discovered, never assumed), and everything else with one word.
 */
async function startScriptedStub(subagentType: string): Promise<ScriptedStub> {
  const state = {
    requests: [] as RecordedRequest[],
    agentToolName: null as string | null,
    userAgent: null as string | null,
    spawned: false,
  };
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method !== 'POST' || !path.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
      return;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: { model?: string; tools?: WireTool[] } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch { /* still a request */ }
    state.userAgent ??= String(req.headers['user-agent'] ?? '');

    const toolNames = (body.tools ?? []).map(tool => String(tool.name ?? '')).filter(Boolean);
    const subagent = raw.includes(SUBAGENT_MARKER);
    state.requests.push({
      index: state.requests.length + 1,
      subagent,
      toolNames,
      mcpToolNames: toolNames.filter(name => name.startsWith('mcp__')),
    });

    const agentTool = (body.tools ?? []).find(
      tool => tool.name === 'Agent' || tool.name === 'Task',
    );
    if (agentTool?.name) state.agentToolName ??= agentTool.name;

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const spawnNow = !subagent && !state.spawned && agentTool?.name !== undefined;
    frame('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${state.requests.length}`, type: 'message', role: 'assistant',
        model: body.model ?? MODEL, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    });
    if (spawnNow) {
      state.spawned = true;
      // Built from the tool's OWN schema: only the properties it declares are
      // sent, so a schema change cannot make this rig send a rejected shape.
      const properties = Object.keys(agentTool?.input_schema?.properties ?? {});
      const input: Record<string, unknown> = {};
      if (properties.includes('subagent_type')) input.subagent_type = subagentType;
      if (properties.includes('description')) input.description = 'probe the subagent tool pool';
      if (properties.includes('prompt')) input.prompt = 'Reply with the single word done.';
      frame('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_p6832', name: agentTool?.name, input: {} },
      });
      frame('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      });
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 },
      });
    } else {
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
      });
    }
    frame('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    get requests() { return state.requests; },
    get agentToolName() { return state.agentToolName; },
    get userAgent() { return state.userAgent; },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
  } as ScriptedStub;
}

export async function runScopeArm(arm: ScopeArm): Promise<ScopeOutcome> {
  const subagentType = 'prober';
  const stub = await startScriptedStub(subagentType);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'p6832-')));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'p6832-cwd-')));
  const configDir = mkdtempSync(join(tmpdir(), 'p6832-cfg-'));
  const commandA = join(root, 'alpha-mcp-server');
  const commandB = join(root, 'beta-mcp-server');
  const commandC = join(root, 'gamma-mcp-server');
  writeMcpFixture(commandA, SERVER_A, TOOL_A);
  writeMcpFixture(commandB, SERVER_B, TOOL_B);
  writeMcpFixture(commandC, SERVER_C, TOOL_C);

  const declared: Record<ScopeArm, { mcpServers?: unknown[] }> = {
    'declares-nothing': {},
    'declares-alpha': { mcpServers: [SERVER_A] },
    'declares-inline-gamma': {
      mcpServers: [{ [SERVER_C]: { type: 'stdio', command: commandC, args: [] } }],
    },
  };

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|API_)/i.test(key)),
  ) as Record<string, string>;

  let ended: ScopeOutcome['ended'] = 'result';
  let detail = '';
  const query = sdk.query({
    prompt: 'Use the prober subagent.',
    options: {
      cwd,
      model: MODEL,
      // Nothing from disk: the session's server pool must be exactly the two
      // programmatic entries, or the arm cannot say what narrowed it.
      settingSources: [],
      permissionMode: 'bypassPermissions',
      pathToClaudeCodeExecutable: vendoredClaudeBinary() ?? undefined,
      mcpServers: {
        [SERVER_A]: { type: 'stdio' as const, command: commandA, args: [] as string[] },
        [SERVER_B]: { type: 'stdio' as const, command: commandB, args: [] as string[] },
      },
      agents: {
        [subagentType]: {
          description: 'A probe subagent used by P6832.',
          prompt: `You are a probe. ${SUBAGENT_MARKER}. Reply with the single word done.`,
          // Foreground, so the subagent's turn is part of this query's own flow
          // rather than a background task this rig would have to wait out.
          background: false,
          ...declared[arm],
        },
      },
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'not-needed',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    } as never,
  });

  try {
    for await (const message of query) {
      const typed = message as { type: string; subtype?: string; result?: unknown; is_error?: boolean };
      if (typed.type === 'result') {
        detail = JSON.stringify({
          subtype: typed.subtype,
          is_error: typed.is_error,
          result: String(typed.result ?? '').slice(0, 300),
        });
        break;
      }
    }
  } catch (error) {
    ended = 'throw';
    detail = String(error).slice(0, 500);
  }

  const requests = [...stub.requests];
  const subagentTurn = requests.find(request => request.subagent);
  const mainTurn = requests.find(request => !request.subagent && request.mcpToolNames.length > 0);
  const outcome: ScopeOutcome = {
    arm,
    agentToolName: stub.agentToolName,
    sawSubagentTurn: subagentTurn !== undefined,
    mainMcpTools: mainTurn?.mcpToolNames ?? [],
    subagentMcpTools: subagentTurn?.mcpToolNames ?? [],
    requests,
    ended,
    detail,
    userAgent: stub.userAgent,
  };
  try {
    await (query as unknown as { interrupt?: () => Promise<void> }).interrupt?.();
  } catch { /* the verdict is already taken */ }
  await stub.close();
  if (!existsSync(commandA)) outcome.detail += ' | fixture vanished';
  return outcome;
}

if (import.meta.main) {
  const arm = (process.argv[2] ?? 'declares-alpha') as ScopeArm;
  console.log(JSON.stringify({ versions: vendoredVersions(), ...(await runScopeArm(arm)) }, null, 2));
  process.exit(0);
}
