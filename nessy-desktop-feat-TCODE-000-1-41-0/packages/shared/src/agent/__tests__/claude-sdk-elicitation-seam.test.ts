/**
 * P3.269 (5) — the host elicitation bridge vs `Options.onElicitation`.
 *
 * ## The duplication is REFUTED, measured
 *
 * The coverage analysis filed `ElicitationAskUserBridge` plus the two host hook
 * events as a duplicate of `Options.onElicitation` and the SDK's
 * `Elicitation`/`ElicitationResult` hooks. They do not overlap: **every entry of
 * `Options.mcpServers` on the claude path is produced by `createSdkMcpServer`**
 * — the `session` tool server plus one in-process proxy per source, each of
 * which routes its calls through the host's own `McpClientPool`. The CLI never
 * holds an MCP connection to a server we configure, so `onElicitation` cannot
 * fire for one. The host bridge is the ONLY reachable implementation, which is
 * §1.2's "the host is correctly the seam", not a duplication.
 *
 * ## Which is exactly why the callback is now wired
 *
 * `strictMcpConfig` is not set, so the CLI still runs its own MCP config
 * discovery beside the servers we hand it, and the SDK's documented default for
 * a real server's elicitation is *"elicitation requests that aren't handled by
 * hooks will be declined automatically"*. An automatic decline with no user, no
 * transcript line and no log is a silent divergence. Routing the callback into
 * `handleMcpElicitation` — the same entry point the pool uses — makes the two
 * paths incapable of answering differently, and costs nothing while unreachable.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { toClaudeElicitRequest } from '../claude-agent.ts';

const CLAUDE_AGENT = new URL('../claude-agent.ts', import.meta.url);

/**
 * Read the built params as a loose record.
 *
 * `ElicitRequest['params']` is a discriminated union whose two arms carry
 * different keys, so a direct `.url` or `.requestedSchema` does not typecheck on
 * the union — and asserting shape is exactly what these tests do.
 */
function params(request: ReturnType<typeof toClaudeElicitRequest>): Record<string, unknown> {
  return request.params as unknown as Record<string, unknown>;
}

describe('P3.269 — the SDK elicitation request becomes the MCP one the host handles', () => {
  it('carries a form elicitation through unchanged', () => {
    // `ElicitRequest['params']` is a DISCRIMINATED UNION (form carries
    // `requestedSchema`, url carries `url`), so every read below narrows through
    // `params()` rather than reaching into the union — the same reason
    // `toClaudeElicitRequest` casts once at its return.
    const schema = { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] };
    const built = params(toClaudeElicitRequest({
      serverName: 'linear',
      message: 'Paste your token',
      mode: 'form',
      requestedSchema: schema,
    }));
    expect(built.message).toBe('Paste your token');
    expect(built.mode).toBe('form');
    expect(built.requestedSchema).toEqual(schema);
  });

  it('carries a URL elicitation, schema and all', () => {
    // `requestedSchema` is form-only on the SDK side, and the MCP request type
    // requires it — so a URL elicitation gets the empty object the host's own
    // URL route ignores, rather than an `undefined` that would fail validation
    // before the user ever sees the sign-in prompt.
    const built = params(toClaudeElicitRequest({
      serverName: 'github',
      message: 'Sign in to continue',
      mode: 'url',
      url: 'https://example.invalid/auth',
      elicitationId: 'e-1',
    }));
    expect(built.mode).toBe('url');
    expect(built.url).toBe('https://example.invalid/auth');
    expect(built.elicitationId).toBe('e-1');
    expect(built.requestedSchema).toEqual({ type: 'object', properties: {} });
  });

  it('BOUNDARY — absent optionals stay absent rather than becoming undefined keys', () => {
    const built = params(toClaudeElicitRequest({ serverName: 's', message: 'm' }));
    expect('mode' in built).toBe(false);
    expect('url' in built).toBe(false);
    expect('elicitationId' in built).toBe(false);
  });

  it('is wired to the ONE host handler the MCP pool also uses', () => {
    const source = readFileSync(CLAUDE_AGENT, 'utf8');
    expect(source).toContain('onElicitation: async (request, callbackOptions) => {');
    expect(source).toContain('this.handleMcpElicitation(');
    // The server name must reach the handler as its context, or a prompt cannot
    // say which server is asking.
    expect(source).toContain('{ server: request.serverName }');
    // A failure returns a settled `null` (the SDK's "host declines to answer"),
    // never a hang — an MCP server blocked forever is worse than a decline.
    expect(source).toContain('return null;');
  });

  it('THE REFUTATION — every MCP server this path configures is in-process', () => {
    const source = readFileSync(CLAUDE_AGENT, 'utf8');
    // Both halves of `fullMcpServers`, and the type that makes the claim
    // structural rather than textual: `createSourceProxyServers` is declared to
    // return `Record<string, ReturnType<typeof createSdkMcpServer>>`, so a
    // stdio/http entry could not be added without changing that signature.
    expect(source).toContain('const fullMcpServers: Options[\'mcpServers\'] = {');
    expect(source).toContain('session: getSessionScopedTools(');
    expect(source).toContain('...sourceProxies,');
    expect(source).toContain('): Record<string, ReturnType<typeof createSdkMcpServer>> {');
    // POSITIVE CONTROL for the absence claim: the file talks about MCP servers
    // constantly, so a zero here is about the transport kinds specifically.
    expect(source).toContain('mcpServers');
    for (const transport of ["type: 'stdio'", "type: 'http'", "type: 'sse'"]) {
      expect(source.includes(transport)).toBe(false);
    }
  });

  it('and the SDK default the wiring exists to replace, quoted', () => {
    const typings = readFileSync(
      require.resolve('@anthropic-ai/claude-agent-sdk').replace(/sdk\.mjs$/, 'sdk.d.ts'),
      'utf8',
    );
    expect(typings).toContain('be declined automatically');
    expect(typings).toContain('onElicitation?: OnElicitation;');
  });
});
