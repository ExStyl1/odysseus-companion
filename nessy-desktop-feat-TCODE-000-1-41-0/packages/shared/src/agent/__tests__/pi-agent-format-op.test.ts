import { describe, expect, it } from 'bun:test';
import { PiAgent, type FormatRunner } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import {
  getPiToolBindingByBindingName,
  getHarnessToolDescriptor,
} from '../pi-harness/harness-tool-descriptor.ts';

/**
 * CI1 — `format` op wiring on the PiAgent.
 *
 * These prove the agent-boundary contract for the formatter dispatch registry:
 * - the `format` proxy tool projects ONLY when the server injected a runner
 *   (trusted project + feature enabled); it is absent otherwise — the trust gate;
 * - routing a `format` call invokes the injected runner with the target path and
 *   returns its bounded result (positive path);
 * - with no runner the op reports "unavailable" and never spawns (negative path);
 * - a runner throw is surfaced as an isError result, never crashes the turn.
 *
 * The runner itself (host-tool detect-and-run, never-install, workspace-profile
 * spawn, boundedness) is proven by `formatter-registry.test.ts`.
 */

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'pi/test-model',
    isHeadless: true,
  };
}

function toolNames(agent: PiAgent): string[] {
  return (agent as any).buildCurrentProxyToolDefinitions().map((d: { name: string }) => d.name);
}

const abort = new AbortController().signal;

describe('PiAgent CI1 format op', () => {
  it('does NOT project the format tool without an injected runner (trust gate)', () => {
    const agent = new PiAgent(createConfig());
    expect(toolNames(agent)).not.toContain('format');
    agent.destroy();
  });

  it('projects the format tool once a runner is injected', () => {
    const agent = new PiAgent(createConfig());
    agent.formatRunner = async () => 'ok';
    expect(toolNames(agent)).toContain('format');
    agent.destroy();
  });

  it('has a static H2 binding so manifest build never treats format as an MCP wireName', () => {
    // Regression: without a PI_TOOL_BINDINGS entry, buildExecutionManifest*
    // classifies `format` as a dynamic MCP tool and parsePiDynamicMcpBindingName
    // throws "Unknown H2 Pi tool binding or invalid MCP wireName: format" at
    // session start in any trusted project (live 1.11.0/1.12.0 defect).
    const binding = getPiToolBindingByBindingName('format');
    expect(binding?.descriptorId).toBe('format');
    expect(binding?.piName).toBe('format');
    expect(() => getHarnessToolDescriptor('format')).not.toThrow();
  });

  it('routes a format call to the runner and returns its bounded result', async () => {
    const agent = new PiAgent(createConfig());
    const calls: string[] = [];
    const runner: FormatRunner = async (event) => {
      calls.push(event.path);
      return '[biome] formatted src/a.ts.';
    };
    agent.formatRunner = runner;

    const result = await (agent as any).routeToolCall('format', { path: 'src/a.ts' }, abort);
    expect(calls).toEqual(['src/a.ts']);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('formatted');
    agent.destroy();
  });

  it('reports unavailable and never spawns when no runner is injected', async () => {
    const agent = new PiAgent(createConfig());
    const result = await (agent as any).routeToolCall('format', { path: 'src/a.ts' }, abort);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('unavailable');
    agent.destroy();
  });

  it('rejects a format call with no path', async () => {
    const agent = new PiAgent(createConfig());
    let invoked = false;
    agent.formatRunner = async () => { invoked = true; return 'x'; };
    const result = await (agent as any).routeToolCall('format', {}, abort);
    expect(result.isError).toBe(true);
    expect(invoked).toBe(false);
    agent.destroy();
  });

  it('surfaces a runner throw as an isError result (never crashes the turn)', async () => {
    const agent = new PiAgent(createConfig());
    agent.formatRunner = async () => { throw new Error('boom'); };
    const result = await (agent as any).routeToolCall('format', { path: 'src/a.ts' }, abort);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('boom');
    agent.destroy();
  });
});
