/**
 * P6.791 — P6.342 (b): a capability KEY becomes an MCP WIRE NAME, and the
 * subagent's declared servers are finally forwarded.
 *
 * Verified at HEAD before this was written: `buildClaudeRuntimeAgentOptions`
 * took `definitions`, `mini`, `modelPolicy`, `skills`, `onNotice` and
 * `availableToolNames` — and no capability view at all. Our descriptors carry
 * resolved capability KEYS and `sdk.d.ts:120`'s `AgentMcpServerSpec` wants a
 * NAME, so the whole declaration could only be dropped (announced since
 * P6.342 (S)).
 *
 * The contract, read rather than inferred —
 * `sub-agents.md#scope-mcp-servers-to-a-subagent` (anchor verified on the
 * rendered page: `curl` of `code.claude.com/docs/en/sub-agents` publishes
 * `id="scope-mcp-servers-to-a-subagent"`): *"Each entry in the list is either an
 * inline server definition or a string referencing an MCP server already
 * configured in your session"*, and *"String references share the parent
 * session's connection."* The same section's trust rules list *"A name that
 * references a server you already configured"* among the two kinds loaded
 * without a folder-trust check — which is why the reference half needs no gate
 * and the INLINE half (P6.792) does.
 *
 * WHAT EACH TEST KILLS:
 *  - "forwards the resolved wire names" dies if the map is threaded but unread —
 *    the inert-field state this wave keeps finding.
 *  - "announces only what it could not name" dies if the notice goes back to
 *    firing on every declared key, or stops naming the ones it dropped.
 *  - "never sends a key it could not resolve" dies if an unresolved key is
 *    smuggled through as a name, which is the failure the original drop existed
 *    to prevent.
 *  - "is threaded from the claude turn" dies if the call site drops the
 *    argument: two pure functions cannot observe a caller that omits one.
 */
import { describe, expect, it } from 'bun:test';
import { buildClaudeRuntimeAgentOptions, buildClaudeRuntimeAgents } from '../claude-runtime-agents.ts';
import { mcpWireNamesByCapabilityKey } from '../../capabilities/views.ts';
import type { AgentRuntimeView } from '../../capabilities/views.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from '../pi-harness/runtime-agent-definition.ts';

function descriptor(
  overrides: Partial<PiRuntimeAgentDefinitionDescriptor> & { key: string; name: string },
): PiRuntimeAgentDefinitionDescriptor {
  return {
    schemaVersion: 2,
    description: 'reviews code',
    selectedAsUnqualifiedAlias: true,
    systemPrompt: 'You are a reviewer.',
    sha256: 'deadbeef',
    provenance: `${overrides.key}@gen-1`,
    capabilityGeneration: 'gen-1',
    definitionDigest: 'digest-1',
    ...overrides,
  } as PiRuntimeAgentDefinitionDescriptor;
}

function build(
  descriptors: PiRuntimeAgentDefinitionDescriptor[],
  wireNames?: ReadonlyMap<string, string>,
) {
  const notices: Array<{ agentKey: string; message: string }> = [];
  const agents = buildClaudeRuntimeAgents(
    descriptors,
    undefined,
    undefined,
    notice => notices.push({ agentKey: notice.agentKey, message: notice.message }),
    undefined,
    wireNames,
  );
  return { agents, notices };
}

describe('P6.791 · capability keys resolve to MCP wire names', () => {
  it('forwards the resolved wire names as the documented reference form', () => {
    const { agents, notices } = build(
      [descriptor({
        key: 'agent.linear', name: 'linear-triager',
        mcpServerKeys: ['cap.linear', 'cap.github'],
      })],
      new Map([['cap.linear', 'linear'], ['cap.github', 'plugin__forge__github']]),
    );
    const agent = agents['linear-triager'] as { mcpServers?: string[] };
    expect(agent.mcpServers).toEqual(['linear', 'plugin__forge__github']);
    // Nothing was dropped, so nothing is announced: the notice exists to report
    // a loss, and after this row a resolvable declaration is not one.
    expect(notices.filter(n => n.message.includes('MCP server'))).toHaveLength(0);
  });

  it('announces only what it could not name, and names it', () => {
    const { agents, notices } = build(
      [descriptor({
        key: 'agent.mixed', name: 'mixed',
        mcpServerKeys: ['cap.linear', 'cap.gone'],
      })],
      new Map([['cap.linear', 'linear']]),
    );
    expect((agents['mixed'] as { mcpServers?: string[] }).mcpServers).toEqual(['linear']);
    const mcpNotices = notices.filter(n => n.message.includes('MCP server'));
    expect(mcpNotices).toHaveLength(1);
    // ONE, not two: the count is of the unresolved remainder.
    expect(mcpNotices[0]!.message).toContain('1 MCP server ');
    expect(mcpNotices[0]!.message).toContain('cap.gone');
    // ...and it does not blame the one that worked.
    expect(mcpNotices[0]!.message).not.toContain('cap.linear');
  });

  it('never sends a key it could not resolve, with or without a map', () => {
    // The negative arm, and the failure the original drop existed to prevent:
    // a capability key is not a server name, and sending one would hand the
    // child whatever server answered to it.
    const declared = [descriptor({
      key: 'agent.k', name: 'k', mcpServerKeys: ['cap.linear'],
    })];
    const withEmptyMap = build(declared, new Map());
    expect('mcpServers' in (withEmptyMap.agents['k'] as Record<string, unknown>)).toBe(false);
    expect(withEmptyMap.notices.filter(n => n.message.includes('MCP server'))).toHaveLength(1);

    // No map at all — a turn with no pinned capability view — is byte-identical
    // to the pre-P6.791 behaviour.
    const withNoMap = build(declared);
    expect('mcpServers' in (withNoMap.agents['k'] as Record<string, unknown>)).toBe(false);
    expect(withNoMap.notices.filter(n => n.message.includes('MCP server'))).toHaveLength(1);

    // A duplicate wire name is sent once: the SDK's field is an array in shape
    // and a set in meaning.
    const deduped = build(
      [descriptor({ key: 'agent.d', name: 'd', mcpServerKeys: ['cap.a', 'cap.b'] })],
      new Map([['cap.a', 'linear'], ['cap.b', 'linear']]),
    );
    expect((deduped.agents['d'] as { mcpServers?: string[] }).mcpServers).toEqual(['linear']);
  });

  it('builds the map from BOTH producers, and from neither when there are none', () => {
    // A map built from `mcpServers` alone silently loses every MCP-transport
    // Source, and vice versa — the two arms are separate producers in the view.
    const view = {
      generation: 'gen-1',
      sources: [
        { key: 'cap.src.slack', logicalName: 'slack', resource: {}, mcpWireName: 'slack' },
        // A non-MCP source contributes nothing: no `mcpWireName`, no entry.
        { key: 'cap.src.api', logicalName: 'weather', resource: {} },
      ],
      skills: [],
      mcpServers: [
        { key: 'cap.mcp.linear', wireName: 'linear', logicalName: 'linear' },
        // A collision rewrote the wire name; the WIRE name is what the session
        // registered its tools under, so it is the one that travels.
        { key: 'cap.mcp.github', wireName: 'plugin__forge__github', logicalName: 'github' },
      ],
      hooks: [], automations: [], agents: [], promptLayers: [], memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [],
    } as unknown as AgentRuntimeView;

    const map = mcpWireNamesByCapabilityKey(view);
    expect(map.get('cap.mcp.linear')).toBe('linear');
    expect(map.get('cap.mcp.github')).toBe('plugin__forge__github');
    expect(map.get('cap.src.slack')).toBe('slack');
    expect(map.get('cap.src.api')).toBeUndefined();
    expect(map.size).toBe(3);

    // The empty view is the honest empty map, not a throw: a turn can have a
    // pinned view and no MCP capability at all.
    const empty = mcpWireNamesByCapabilityKey({ generation: 'g' } as unknown as AgentRuntimeView);
    expect(empty.size).toBe(0);
  });

  it('is threaded from the claude turn, and the options wrapper passes it on', async () => {
    // The wrapper half, asserted through the seam a turn actually calls.
    const options = buildClaudeRuntimeAgentOptions({
      definitions: [descriptor({
        key: 'agent.linear', name: 'linear-triager', mcpServerKeys: ['cap.linear'],
      })],
      mini: false,
      mcpWireNamesByKey: new Map([['cap.linear', 'linear']]),
    });
    const agent = options.agents?.['linear-triager'] as { mcpServers?: string[] } | undefined;
    expect(agent?.mcpServers).toEqual(['linear']);

    // The call-site half. A builder cannot observe a caller that omits an
    // optional argument, and the whole of P6.342 (b) was a missing input.
    const source = await Bun.file(new URL('../claude-agent.ts', import.meta.url).pathname).text();
    expect(source).toContain('mcpWireNamesByKey: mcpWireNamesByCapabilityKey(capabilityRuntime.view)');
    expect(source).toContain("import { mcpWireNamesByCapabilityKey } from '../capabilities/views.ts'");
  });
});

/**
 * C3.324 — the inline half is still NOT forwarded, and that is now a pin rather
 * than a comment.
 *
 * The row asked which of the two folder-trust enforcers is the seam once the
 * vendored child passed v2.1.238 and gained one of its own. The answer, argued
 * on `inlineServersTrusted` in `pi-harness/runtime-agent-definition.ts`, is that
 * the HOST gate is the seam and the child's cannot be pinned to it, because the
 * two judge DISJOINT inputs: this builder sends the resolved NAME-REFERENCE
 * form, which `sub-agents.md`'s trust section exempts outright, so nothing our
 * gate admits ever reaches the child's.
 *
 * The disjointness is the load-bearing part, so it is what these two cases kill.
 * Forwarding the inline form would hand the child a server to START on a folder
 * only the HOST decided about — measured as a real widening by the probe
 * `__tests__/fixtures/claude-subagent-mcp-scope-probe.ts`, whose inline arm gave
 * the subagent a server the main turn never had. Both cases give the descriptor
 * a map that has ALREADY passed the host's gate (`mcpServerInlineTrusted: true`),
 * which is the only state from which a future lane would be tempted to forward
 * it.
 */
describe('C3.324 · a trusted inline map still never reaches the SDK', () => {
  const INLINE = { gamma: { command: 'gamma-server', args: ['--stdio'] } };

  it('forwards the reference half and nothing of the inline half', () => {
    const { agents } = build(
      [descriptor({
        key: 'agent.linear',
        name: 'linear-triager',
        mcpServerKeys: ['cap.linear'],
        mcpServerInline: INLINE,
        mcpServerInlineTrusted: true,
      })],
      new Map([['cap.linear', 'linear']]),
    );
    const agent = agents['linear-triager'] as { mcpServers?: unknown[] };
    expect(agent.mcpServers).toEqual(['linear']);
    // `AgentMcpServerSpec` is `string | Record<string, …>`, so the inline form
    // would arrive as an OBJECT in this same array. Assert the ELEMENT TYPE and
    // not just the value: a future forwarding would append rather than replace.
    expect(agent.mcpServers!.every(entry => typeof entry === 'string')).toBe(true);
    // And no second field smuggles it in beside `mcpServers`.
    expect(Object.keys(agents['linear-triager']!).filter(key => key.toLowerCase().includes('inline')))
      .toEqual([]);
  });

  it('emits no server list at all for an inline-only agent — the boundary', () => {
    // The arm that separates "we forward references and drop inline" from "we
    // happened to have a reference to forward". A trusted inline map with no
    // reference beside it must produce no `mcpServers` key whatsoever.
    const { agents } = build([descriptor({
      key: 'agent.inline',
      name: 'inline-only',
      mcpServerInline: INLINE,
      mcpServerInlineTrusted: true,
    })]);
    expect('mcpServers' in (agents['inline-only'] as Record<string, unknown>)).toBe(false);
  });
});
