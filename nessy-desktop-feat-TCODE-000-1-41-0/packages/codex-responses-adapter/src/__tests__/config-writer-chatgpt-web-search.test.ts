/**
 * F1.570 (origin WJ-bf P-WJbf-5, 2026-09-24; DECIDED by the controller,
 * native-first) — the ChatGPT (Codex) card follows codex's OWN web-search
 * default, and the Nessy Gateway card keeps `web_search = "disabled"`.
 *
 * The line's reason was gateway-specific — *"Hosted web_search executes on
 * OpenAI's backend — unreachable through the Nestor adapter"* — and the ChatGPT
 * card (`declaredModelProvider: 'openai'`, F1.202) sends its turns to exactly
 * that backend. So on that card no key is written and codex resolves its own
 * default: `resolve_web_search_mode(&cfg, &features).unwrap_or(WebSearchMode::Cached)`
 * (`codex-rs/core/src/config/mod.rs`, `rust-v0.156.1`, the tag
 * `codex-protocol/manifest.json` pins; `#[default] Cached` on the enum in
 * `protocol/src/config_types.rs`).
 *
 * Turning codex's search ON has two consequences this file pins with it:
 *
 *  - **One search tool in front of the model, not two.** The host's own
 *    `web_search` session tool is advertised on every codex session because
 *    codex's was off (`isOfferedByHostPorts`, session-tools-core). On this card
 *    codex's is on, so the writer withholds the host's through codex's own
 *    per-server lever, `disabled_tools` on `[mcp_servers.session]` (F1.378's
 *    lever; `codex-mcp/src/tools.rs` `ToolFilter::allows` compares the raw
 *    name) — the P6.148 rule that a native search is kept and the host's is
 *    withheld, as on a claude passthrough session.
 *  - **The operator's allowlist follows the search.** P6.339 recorded that the
 *    emit belonged "to whichever row enables the mode": `[tools.web_search]
 *    allowed_domains`, which codex turns into the hosted tool's
 *    `filters.allowed_domains` (`core/src/tools/hosted_spec.rs`
 *    `create_web_search_tool`, `protocol/src/config_types.rs`
 *    `From<WebSearchToolConfig> for WebSearchConfig`). Written only where the
 *    search is on — an allowlist on a tool that is off reads as protection
 *    nobody has.
 *
 * WHAT EACH ARM KILLS: a card that keeps the disabled line; a gateway or
 * Bedrock card that loses it; a card where the host search is still offered
 * beside codex's; a user's own deny rule that the withheld search overwrites;
 * an allowlist written on a card whose search is off, or not written on the
 * card; a schema rename that would silently drop the allowlist. The live arm
 * reads the shipped binary's own `config/read`, so "codex parses this file"
 * is a reading, not an assumption.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexConfigToml,
  CODEX_HOST_WEB_SEARCH_TOOL,
  validateConfigAgainstSchema,
  type CodexConfigOptions,
} from '../config-writer.ts';
import { AppServer } from './app-server-rig.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const SCHEMA = join(REPO_ROOT, 'packages', 'codex-protocol', 'schema', 'config-schema.json');
const TOOL_DEFS = join(REPO_ROOT, 'packages', 'session-tools-core', 'src', 'tool-defs.ts');
const CODEX_AGENT = join(REPO_ROOT, 'packages', 'shared', 'src', 'agent', 'codex-agent.ts');

const SESSION_MCP = { command: '/usr/bin/true', args: ['/tmp/f1570-session-server.js', '--session-id', 's'] };
const GATEWAY: CodexConfigOptions = {
  codexHome: '/tmp/f1570-home',
  model: 'tgpt/deepseek-v4-flash-0731',
  adapterPort: 4321,
  sessionMcp: SESSION_MCP,
};
const CHATGPT: CodexConfigOptions = {
  codexHome: '/tmp/f1570-home',
  model: 'gpt-6-astra',
  declaredModelProvider: 'openai',
  sessionMcp: SESSION_MCP,
};
const BEDROCK: CodexConfigOptions = { ...CHATGPT, declaredModelProvider: 'amazon-bedrock' };
const ALLOWLIST = ['example.com', 'docs.example.org'] as const;

interface Parsed {
  model_provider?: string;
  web_search?: unknown;
  tools?: { web_search?: { allowed_domains?: string[] } };
  mcp_servers?: Record<string, { disabled_tools?: string[]; tools?: Record<string, unknown> }>;
}
const parse = (toml: string): Parsed => Bun.TOML.parse(toml) as Parsed;

describe('F1.570 · web search on the ChatGPT (Codex) card follows codex\'s own default', () => {
  test('the card writes no web_search key, so codex resolves its own default', () => {
    const toml = buildCodexConfigToml(CHATGPT);
    const parsed = parse(toml);
    expect(parsed.model_provider).toBe('openai');
    expect('web_search' in parsed).toBe(false);
    expect(toml).not.toContain('web_search = "disabled"');
  });

  test('CONTROL: the gateway card and the Bedrock card keep web_search = "disabled"', () => {
    for (const opts of [GATEWAY, BEDROCK]) {
      const parsed = parse(buildCodexConfigToml(opts));
      expect(parsed.web_search).toBe('disabled');
      expect(parsed.tools).toBeUndefined();
      expect(parsed.mcp_servers?.session?.disabled_tools).toBeUndefined();
    }
  });

  test('the host web_search is withheld on the card, so ONE search tool faces the model', () => {
    const parsed = parse(buildCodexConfigToml(CHATGPT));
    expect(parsed.mcp_servers?.session?.disabled_tools).toEqual([CODEX_HOST_WEB_SEARCH_TOOL]);
    // The withheld name IS the host tool's registered name — a rename in
    // session-tools-core would otherwise withhold nothing, silently.
    expect(CODEX_HOST_WEB_SEARCH_TOOL).toBe('web_search');
    expect(readFileSync(TOOL_DEFS, 'utf8')).toContain(`{ name: '${CODEX_HOST_WEB_SEARCH_TOOL}', description: TOOL_DESCRIPTIONS.web_search`);
  });

  test('a user\'s own deny and ask rules merge with the withheld search; a deny still wins', () => {
    const parsed = parse(buildCodexConfigToml({
      ...CHATGPT,
      mcpToolLevers: { session: { disabledTools: ['automation_update'], promptTools: ['web_search', 'config_validate'] } },
    }));
    expect(parsed.mcp_servers?.session?.disabled_tools).toEqual(['automation_update', 'web_search']);
    expect(parsed.mcp_servers?.session?.tools).toEqual({ config_validate: { approval_mode: 'prompt' } });
  });

  test('the operator allowlist lands in [tools.web_search] on the card only', () => {
    const card = parse(buildCodexConfigToml({ ...CHATGPT, webSearchAllowedDomains: ALLOWLIST }));
    expect(card.tools?.web_search?.allowed_domains).toEqual([...ALLOWLIST]);
    expect(card.model_provider).toBe('openai'); // the table swallowed no bare key
    for (const opts of [GATEWAY, BEDROCK]) {
      const toml = buildCodexConfigToml({ ...opts, webSearchAllowedDomains: ALLOWLIST });
      expect(parse(toml).tools).toBeUndefined();
      expect(toml).not.toContain('example.com');
    }
  });

  test('an empty or unusable allowlist writes no [tools] table', () => {
    expect(parse(buildCodexConfigToml({ ...CHATGPT, webSearchAllowedDomains: [] })).tools).toBeUndefined();
    expect(parse(buildCodexConfigToml({ ...CHATGPT, webSearchAllowedDomains: [' ', 'a\u0007b'] })).tools).toBeUndefined();
  });

  test('CONTROL: the gateway card\'s config is unchanged by the new option', () => {
    expect(buildCodexConfigToml({ ...GATEWAY, webSearchAllowedDomains: ALLOWLIST })).toBe(buildCodexConfigToml(GATEWAY));
  });

  test('the codex host hands the writer the allowlist Pi and the host search read', () => {
    // Source text, because the one caller builds its whole runtime around this
    // call; the resolver is the same function the other two searches use.
    const agent = readFileSync(CODEX_AGENT, 'utf8');
    expect(agent).toContain('webSearchAllowedDomains: resolveWebSearchAllowedDomains()');
    expect(agent).toContain("import { resolveWebSearchAllowedDomains } from '../config/web-search-allowlist.ts';");
  });
});

describe('F1.1061 · a user\'s whole-tool WebSearch deny is written as codex\'s own switch', () => {
  // What `projectCodexMcpPermissionRules` hands the writer for `deny: ['WebSearch']`
  // (pinned in shared's codex-mcp-rule-projection.test.ts): the app's search
  // withheld AND the flag for codex's own.
  const DENIED = { session: { disabledTools: [CODEX_HOST_WEB_SEARCH_TOOL], promptTools: [], webSearchDenied: true } };

  test('the card writes web_search = "disabled", keeps the app\'s search withheld, and writes no allowlist', () => {
    const parsed = parse(buildCodexConfigToml({ ...CHATGPT, mcpToolLevers: DENIED, webSearchAllowedDomains: ALLOWLIST }));
    expect(parsed.model_provider).toBe('openai');
    expect(parsed.web_search).toBe('disabled');
    expect(parsed.mcp_servers?.session?.disabled_tools).toEqual([CODEX_HOST_WEB_SEARCH_TOOL]);
    expect(parsed.tools).toBeUndefined();
  });

  test('CONTROL: a deny of the app\'s tool alone leaves codex\'s own search on its default, allowlist written', () => {
    const parsed = parse(buildCodexConfigToml({
      ...CHATGPT,
      mcpToolLevers: { session: { disabledTools: [CODEX_HOST_WEB_SEARCH_TOOL], promptTools: [] } },
      webSearchAllowedDomains: ALLOWLIST,
    }));
    expect('web_search' in parsed).toBe(false);
    expect(parsed.tools?.web_search?.allowed_domains).toEqual([...ALLOWLIST]);
  });

  test('CONTROL: the gateway card already writes "disabled" and the flag changes nothing else there', () => {
    const { webSearchDenied: _flag, ...plain } = DENIED.session;
    expect(buildCodexConfigToml({ ...GATEWAY, mcpToolLevers: DENIED }))
      .toBe(buildCodexConfigToml({ ...GATEWAY, mcpToolLevers: { session: plain } }));
  });

  test('the card with the deny passes the pinned schema', () => {
    expect(() => validateConfigAgainstSchema({ ...CHATGPT, mcpToolLevers: DENIED, webSearchAllowedDomains: ALLOWLIST }, SCHEMA)).not.toThrow();
  });
});

describe('F1.570 · the schema guard', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'nessy-f1570-schema-'));
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  test('the card with an allowlist and a deny passes the pinned schema', () => {
    expect(() => validateConfigAgainstSchema({ ...CHATGPT, webSearchAllowedDomains: ALLOWLIST }, SCHEMA)).not.toThrow();
  });

  test('a schema that lost WebSearchToolConfig.allowed_domains is refused, loudly, on the card only', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
      definitions: { WebSearchToolConfig: { properties: Record<string, unknown> } };
    };
    delete schema.definitions.WebSearchToolConfig.properties.allowed_domains;
    const renamed = join(ROOT, 'renamed-schema.json');
    writeFileSync(renamed, JSON.stringify(schema));
    expect(() => validateConfigAgainstSchema({ ...CHATGPT, webSearchAllowedDomains: ALLOWLIST }, renamed))
      .toThrow(/allowed_domains/);
    // CONTROL: the gateway card never writes the table, so the same schema passes it.
    expect(() => validateConfigAgainstSchema({ ...GATEWAY, webSearchAllowedDomains: ALLOWLIST }, renamed)).not.toThrow();
  });
});

const BIN = join(
  REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN);
/** A ~185 MB binary booted twice; generous because lanes share this machine. */
const BUDGET_MS = 240_000;

/** A refusing proxy, so nothing a boot attempts can leave the machine. */
async function refusingProxy(): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => { res.writeHead(502); res.end('refused'); });
  server.on('connect', (_req, socket) => { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.destroy(); });
  server.on('clientError', (_err, socket) => { socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('proxy got no port');
  return { port: address.port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe.if(HAVE_BIN)('F1.570 · the shipped codex-app-server reads the card\'s config', () => {
  const ROOT = HAVE_BIN ? mkdtempSync(join(tmpdir(), 'nessy-f1570-live-')) : '';
  afterAll(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

  async function readConfig(name: string, opts: CodexConfigOptions): Promise<{ config: Record<string, unknown>; warnings: unknown[] }> {
    const home = join(ROOT, name);
    const ws = join(ROOT, `${name}-ws`);
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({ ...opts, codexHome: home }));
    const proxy = await refusingProxy();
    const url = `http://127.0.0.1:${proxy.port}`;
    const child = spawn(BIN, [], {
      cwd: ws,
      env: {
        ...process.env,
        CODEX_HOME: home,
        HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, http_proxy: url, https_proxy: url, all_proxy: url,
        NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const server = new AppServer(child);
    try {
      await server.request('initialize', {
        clientInfo: { name: 'nessy-f1570', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      server.notify('initialized');
      const answer = await server.request('config/read', { includeLayers: false, cwd: ws }) as { config: Record<string, unknown> };
      return {
        config: answer.config,
        warnings: server.notifications.filter(n => n.method === 'configWarning').map(n => n.params),
      };
    } finally {
      server.kill();
      await proxy.close();
    }
  }

  test('the card reads no web_search mode, the allowlist and the session deny; the gateway card reads "disabled"', async () => {
    const card = await readConfig('card', { ...CHATGPT, webSearchAllowedDomains: ALLOWLIST });
    expect(card.config.model_provider).toBe('openai');
    expect(card.config.web_search ?? null).toBeNull();
    expect((card.config.tools as { web_search?: { allowed_domains?: unknown } } | null)?.web_search?.allowed_domains)
      .toEqual([...ALLOWLIST]);
    expect((card.config.mcp_servers as Record<string, { disabled_tools?: unknown }>).session?.disabled_tools)
      .toEqual([CODEX_HOST_WEB_SEARCH_TOOL]);
    expect(card.warnings).toEqual([]);
    // CONTROL on the same instrument: the gateway card's own file reads "disabled".
    const gateway = await readConfig('gateway', { ...GATEWAY, adapterPort: 1 });
    expect(gateway.config.model_provider).toBe('nessy_gateway');
    expect(gateway.config.web_search).toBe('disabled');
  }, BUDGET_MS);
});
