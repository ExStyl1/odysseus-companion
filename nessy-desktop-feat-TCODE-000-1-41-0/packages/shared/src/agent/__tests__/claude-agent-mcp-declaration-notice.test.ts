/**
 * P6.342 (S) — a subagent's declared MCP servers are dropped on the claude
 * runtime, and until this notice nothing said so.
 *
 * The drop stood at the time this file was written: our descriptor holds
 * resolved capability KEYS, while `AgentMcpServerSpec` is `string |
 * Record<string, McpServerConfigForProcessTransport>` — a configured server's
 * NAME or a whole process-transport config. Mapping a key onto a name would hand
 * the child whatever server answered to it.
 *
 * **P6.791 supplied the missing translation, and every case below still holds
 * because none of them threads one.** `buildClaudeRuntimeAgents` now takes an
 * optional capability KEY → WIRE NAME map; without it — a turn with no pinned
 * capability view — the behaviour is byte-identical to what this file pins, and
 * with it a resolvable key is forwarded as the documented reference form while
 * an unresolvable one is still dropped and still announced BY NAME. The
 * resolved side is pinned in `claude-subagent-mcp-wire-names.test.ts`.
 *
 * What was never a decision is the SILENCE: `componentHooks` is dropped here and
 * announced, `mcpServerKeys` is dropped here and was not — while Pi forwards the
 * same reference, so one definition gets its declared servers there and the
 * session's own here.
 *
 * WHAT EACH TEST KILLS:
 *  - "announces the dropped declaration" dies if the notice is removed — the step.
 *  - "still registers the agent" dies if someone answers the drop by withholding
 *    the agent: Pi runs it, and refusing it here is a NEW claude-only
 *    degradation, the overshoot R10's review had to unwind.
 *  - "says nothing for an agent that declares none" dies if the notice becomes
 *    unconditional.
 *  - "does not smuggle the keys through as SDK mcpServers" dies if a change ever
 *    sends a capability KEY where a server NAME belongs — the failure the drop
 *    existed to prevent, and the one P6.791 must not reintroduce: with no map,
 *    or with a map that cannot resolve the key, nothing is sent at all.
 */
import { describe, expect, it } from 'bun:test';
import { buildClaudeRuntimeAgents } from '../claude-runtime-agents.ts';
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

function build(descriptors: PiRuntimeAgentDefinitionDescriptor[]) {
  const notices: Array<{ agentKey: string; message: string }> = [];
  const agents = buildClaudeRuntimeAgents(
    descriptors,
    undefined,
    undefined,
    notice => notices.push({ agentKey: notice.agentKey, message: notice.message }),
  );
  return { agents, notices };
}

describe('P6.342 (S) · a dropped MCP declaration announces itself on claude', () => {
  it('announces the dropped declaration, naming the agent and the count', () => {
    const { notices } = build([
      descriptor({ key: 'agent.linear', name: 'linear-triager', mcpServerKeys: ['linear', 'github'] }),
    ]);
    const mcpNotices = notices.filter(n => n.message.includes('MCP server'));
    expect(mcpNotices).toHaveLength(1);
    expect(mcpNotices[0]!.agentKey).toBe('agent.linear');
    expect(mcpNotices[0]!.message).toContain('linear-triager');
    expect(mcpNotices[0]!.message).toContain('2 MCP servers');
  });

  it('still registers the agent — the drop is not a refusal', () => {
    const { agents } = build([
      descriptor({ key: 'agent.linear', name: 'linear-triager', mcpServerKeys: ['linear'] }),
    ]);
    expect(Object.keys(agents)).toContain('linear-triager');
  });

  it('says nothing for an agent that declares none', () => {
    const { notices } = build([descriptor({ key: 'agent.plain', name: 'plain' })]);
    expect(notices.filter(n => n.message.includes('MCP server'))).toHaveLength(0);
  });

  it('does not smuggle the capability keys through as SDK mcpServers', () => {
    const { agents } = build([
      descriptor({ key: 'agent.linear', name: 'linear-triager', mcpServerKeys: ['linear'] }),
    ]);
    expect('mcpServers' in (agents['linear-triager'] as Record<string, unknown>)).toBe(false);
  });
});
