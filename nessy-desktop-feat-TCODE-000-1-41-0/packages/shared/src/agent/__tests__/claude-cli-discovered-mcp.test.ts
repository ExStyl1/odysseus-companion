/**
 * P6.528 · the claude CLI runs its own MCP discovery beside the servers we hand
 * it, and now the session says which ones.
 *
 * Q-den 65 = option 2: leave `strictMcpConfig` unset and REPORT. The suite pins
 * the report and the choice, and the negative control is the ordinary session —
 * every server in the init message is one we supplied, and nothing is said.
 */
import { describe, expect, it } from 'bun:test';

import { claudeCliDiscoveredMcpNotice } from '../claude-agent.ts';

const configured = new Set(['session', 'linear']);

describe('P6.528 · CLI-discovered MCP servers are named', () => {
  it('positive — a server we did not configure is named, with its status verbatim', () => {
    const [line] = claudeCliDiscoveredMcpNotice(
      [
        { name: 'session', status: 'connected' },
        { name: 'linear', status: 'connected' },
        { name: 'from-dot-mcp-json', status: 'connected' },
      ],
      configured,
    );
    expect(line).toContain('from-dot-mcp-json (connected)');
    expect(line).toContain('1 MCP server');
    // Only the ones we did NOT supply are named: `linear` was ours.
    expect(line).not.toContain('linear');
  });

  it('negative — an ordinary session says nothing', () => {
    expect(claudeCliDiscoveredMcpNotice(
      [{ name: 'session', status: 'connected' }, { name: 'linear', status: 'failed' }],
      configured,
    )).toEqual([]);
  });

  it('a missing, malformed or empty list is not a report', () => {
    expect(claudeCliDiscoveredMcpNotice(undefined, configured)).toEqual([]);
    expect(claudeCliDiscoveredMcpNotice([], configured)).toEqual([]);
    expect(claudeCliDiscoveredMcpNotice([null, 7, { status: 'connected' }, { name: '' }], configured))
      .toEqual([]);
  });

  it('several are named together, and a nameless status is not invented', () => {
    const [line] = claudeCliDiscoveredMcpNotice(
      [{ name: 'a' }, { name: 'b', status: 'failed' }],
      configured,
    );
    expect(line).toContain('2 MCP servers');
    expect(line).toContain('a, b (failed)');
  });

  it('the knob is deliberately UNSET, and the architecture page now says so', async () => {
    // The decision itself, pinned in both places it is recorded. A later lane
    // that sets `strictMcpConfig: true` must move the doc row in the same step.
    const agent = await Bun.file(new URL('../claude-agent.ts', import.meta.url).pathname).text();
    // As an OPTION assignment — the identifier itself occurs in the prose that
    // records the decision, and a bare `toContain` would read that as the knob.
    expect(agent).not.toMatch(/^\s*strictMcpConfig:/m);

    const doc = await Bun.file(
      new URL('../../../../../docs/architecture/managed-mcp-access.md', import.meta.url).pathname,
    ).text();
    expect(doc).toContain('the channel exists and we leave it open');
    expect(doc).toContain('claudeCliDiscoveredMcpNotice');
  });
});
