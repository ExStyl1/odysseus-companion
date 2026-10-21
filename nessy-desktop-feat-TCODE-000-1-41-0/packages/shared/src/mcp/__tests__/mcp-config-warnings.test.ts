import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_RESERVED_MCP_SERVER_NAMES,
  parseMcpServersDocument,
  reservedMcpServerName,
  whitespaceBearingMcpFields,
} from '../project-config.ts';

/**
 * P6.350(b) — two of the four documented configuration warnings, from
 * `mcp.md#configuration-warnings`. The third (same name in more than one scope)
 * is NOT here: it already exists at HEAD as the resolver's
 * `capability.collision.mcp-scope-precedence`, which is where scopes meet.
 */
describe('.mcp.json configuration warnings — hidden whitespace', () => {
  const parse = (server: unknown, slug = 'docs') => {
    const warnings: string[] = [];
    const servers = parseMcpServersDocument({ mcpServers: { [slug]: server } }, message => warnings.push(message));
    return { config: servers[slug], warnings };
  };

  it('names every documented field and NEVER the value', () => {
    // `mcp.md#configuration-warnings`: "Claude Code checks `command`, `url`,
    // each `args` entry, and the values and key names under `env` and
    // `headers`", "naming the affected fields without echoing their values".
    const { warnings } = parse({
      type: 'stdio',
      command: ' /usr/bin/server',
      args: ['--clean', 'trailing \n'],
      env: { ' SPACED_KEY': 'fine', TOKEN: 'sk-secret-value\n' },
    });

    const whitespace = warnings.filter(message => message.includes('leading or trailing whitespace'));
    expect(whitespace).toHaveLength(1);
    expect(whitespace[0]).toContain('command');
    expect(whitespace[0]).toContain('args[1]');
    expect(whitespace[0]).toContain('env key " SPACED_KEY"');
    expect(whitespace[0]).toContain('env.TOKEN');
    // args[0] is clean and must not be named.
    expect(whitespace[0]).not.toContain('args[0]');
    // The whole point of "without echoing their values".
    expect(whitespace[0]).not.toContain('sk-secret-value');
    expect(whitespace[0]).not.toContain('/usr/bin/server');
  });

  it('does not trim — the server still loads with the value exactly as written', () => {
    // "Claude Code doesn't trim the whitespace and uses the values exactly as
    // written". Reporting and repairing are different acts.
    const { config, warnings } = parse({ type: 'http', url: 'https://mcp.example.test/mcp ' });
    expect(config).toMatchObject({ type: 'http', url: 'https://mcp.example.test/mcp ' });
    expect(warnings.some(message => message.includes('url'))).toBe(true);
  });

  it('covers header values and header key names', () => {
    const fields = whitespaceBearingMcpFields({
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { Authorization: 'Bearer abc\n', 'X-Trailing ': 'clean' },
    });
    expect(fields).toEqual(['headers.Authorization', 'headers key "X-Trailing "']);
  });

  it('says nothing about a clean entry, and nothing about a non-string field', () => {
    // The negative control. `args: [1]` and `env: { A: 2 }` are not strings and
    // are rejected elsewhere; the whitespace check must not invent a report for
    // them, or every shape error would acquire a second, wrong explanation.
    expect(whitespaceBearingMcpFields({
      type: 'stdio', command: '/usr/bin/server', args: ['--clean'], env: { A: 'b' },
    })).toEqual([]);
    expect(whitespaceBearingMcpFields({ type: 'stdio', command: '/x', args: [1], env: { A: 2 } })).toEqual([]);
    expect(whitespaceBearingMcpFields('not an object')).toEqual([]);
  });

  it('catches the invisible ones: a BOM and a non-breaking space', () => {
    // Why `trim()` and not a `\s` regex — `trim` removes the Unicode
    // whitespace set plus U+FEFF, which is the "hidden" half of the sentence.
    expect(whitespaceBearingMcpFields({ command: '﻿/usr/bin/server' })).toEqual(['command']);
    expect(whitespaceBearingMcpFields({ command: '/usr/bin/server ' })).toEqual(['command']);
  });
});

describe('.mcp.json configuration warnings — reserved server names', () => {
  const parse = (slug: string) => {
    const warnings: string[] = [];
    const servers = parseMcpServersDocument(
      { mcpServers: { [slug]: { type: 'http', url: 'https://mcp.example.test/mcp' } } },
      message => warnings.push(message),
    );
    return { config: servers[slug], warnings };
  };

  it('names each of the five documented reserved names', () => {
    expect([...CLAUDE_RESERVED_MCP_SERVER_NAMES]).toEqual([
      'workspace', 'claude-in-chrome', 'computer-use', 'Claude Preview', 'Claude Browser',
    ]);
    for (const name of CLAUDE_RESERVED_MCP_SERVER_NAMES) {
      expect(reservedMcpServerName(name)).toBe(name);
    }
  });

  it('warns and KEEPS LOADING — the divergence is made honest, not copied', () => {
    // We have no built-in by these names (ours are the `dp` family), so copying
    // claude's skip would refuse a good server to protect a built-in this fork
    // does not have. The warning says what a claude-runtime session will do.
    const { config, warnings } = parse('workspace');
    expect(config).toMatchObject({ type: 'http', url: 'https://mcp.example.test/mcp' });
    const reserved = warnings.filter(message => message.includes('reserved for a built-in server'));
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toContain('"workspace"');
    expect(reserved[0]).toContain('Claude Code session skips');
  });

  it('matches EXACTLY, case included — folding would be invention', () => {
    // The page gives mixed-case spellings side by side (`workspace` beside
    // `Claude Preview`) and says nothing about folding.
    expect(reservedMcpServerName('Workspace')).toBeUndefined();
    expect(reservedMcpServerName('claude preview')).toBeUndefined();
    expect(parse('my-workspace').warnings.filter(m => m.includes('reserved'))).toHaveLength(0);
  });
});
