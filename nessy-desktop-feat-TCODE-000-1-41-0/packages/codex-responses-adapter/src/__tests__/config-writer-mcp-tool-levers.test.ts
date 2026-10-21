/**
 * F1.378 — the writer half: a user's exact-name `mcp__` deny/ask rules reach
 * codex's own per-server levers, `disabled_tools` and
 * `tools.<name>.approval_mode = "prompt"`, on `[mcp_servers.session]` and
 * `[mcp_servers.sources]`.
 *
 * Which rule lands on which entry under which raw name is
 * `projectCodexMcpPermissionRules` (`shared/src/agent/codex-permission-rule-support.ts`,
 * its own suite); this file pins only what the writer emits for what it is
 * handed, and that handing it nothing writes HEAD's config byte for byte. The
 * binary's own reading of the two levers is the live suite
 * `shared/src/mcp/__tests__/codex-mcp-tool-levers-live.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { buildCodexConfigToml, type CodexConfigOptions } from '../config-writer.ts';

const BASE: CodexConfigOptions = {
  codexHome: '/tmp/f1378-home',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 4321,
  mode: 'default',
  sandboxGloballyEnabled: false,
  sessionMcp: { command: '/usr/bin/node', args: ['/tmp/session-server.js', '--session-id', 's'] },
  poolMcpUrl: 'http://127.0.0.1:5555/mcp',
};

type McpTables = Record<string, { disabled_tools?: string[]; tools?: Record<string, { approval_mode?: string }> }>;

function mcpServers(toml: string): McpTables {
  return (Bun.TOML.parse(toml) as { mcp_servers?: McpTables }).mcp_servers ?? {};
}

describe('F1.378 · the MCP rule levers in [mcp_servers.*]', () => {
  it('a deny lands in disabled_tools and an ask in tools.<name>.approval_mode = "prompt", per entry', () => {
    const toml = buildCodexConfigToml({
      ...BASE,
      mcpToolLevers: {
        session: { disabledTools: ['automation_update'], promptTools: ['config_validate'] },
        sources: { disabledTools: ['plugin_cdp-echo-probe_echo__whoami'], promptTools: ['linear__get_issue'] },
      },
    });
    const servers = mcpServers(toml);
    expect(servers.session?.disabled_tools).toEqual(['automation_update']);
    expect(servers.session?.tools).toEqual({ config_validate: { approval_mode: 'prompt' } });
    expect(servers.sources?.disabled_tools).toEqual(['plugin_cdp-echo-probe_echo__whoami']);
    expect(servers.sources?.tools).toEqual({ linear__get_issue: { approval_mode: 'prompt' } });
    // The entries keep what they always carried — the levers are added, nothing moves.
    expect((Bun.TOML.parse(toml) as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers.sources!.url)
      .toBe('http://127.0.0.1:5555/mcp');
  });

  it('a deny wins over an ask on the same tool, and duplicates collapse', () => {
    const servers = mcpServers(buildCodexConfigToml({
      ...BASE,
      mcpToolLevers: { sources: { disabledTools: ['a__x', 'a__x'], promptTools: ['a__x', 'a__y', 'a__y'] } },
    }));
    expect(servers.sources?.disabled_tools).toEqual(['a__x']);
    expect(servers.sources?.tools).toEqual({ a__y: { approval_mode: 'prompt' } });
  });

  it('CONTROL: no levers, empty levers and absent entries all write HEAD\'s config byte for byte', () => {
    const head = buildCodexConfigToml(BASE);
    expect(buildCodexConfigToml({ ...BASE, mcpToolLevers: {} })).toBe(head);
    expect(buildCodexConfigToml({
      ...BASE,
      mcpToolLevers: { session: { disabledTools: [], promptTools: [] }, sources: {} },
    })).toBe(head);
    expect(head).not.toContain('disabled_tools');
    expect(head).not.toContain('approval_mode');
  });

  it('CONTROL: a lever for an entry the session does not write is written nowhere', () => {
    const { poolMcpUrl: _drop, ...noPool } = BASE;
    const toml = buildCodexConfigToml({ ...noPool, mcpToolLevers: { sources: { disabledTools: ['a__x'] } } });
    expect(mcpServers(toml).sources).toBeUndefined();
    expect(toml).not.toContain('a__x');
  });
});
