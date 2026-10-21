/**
 * P6.309 (2) — the eight declared subagent fields codex cannot express were
 * dropped in silence.
 *
 * `CodexAgentRoleDescriptor` never carries them, so the config writer cannot
 * report what it never receives — the same boundary P3.301 found for
 * `isolation`, and the reason this report lives on the agent.
 *
 * WHAT EACH TEST KILLS:
 *  - "names every declared field" dies if the walk is dropped or a field is
 *    quietly removed from it: the loss goes back to being invisible.
 *  - "stays silent when nothing declares one" dies if the report becomes
 *    unconditional, which is how a notice on an eight-deep queue crowds out the
 *    facts that are not always true.
 *  - "is ONE operator notice for many definitions" dies if the aggregation is
 *    lost — P3.337's measured reason, one notice per agent would exhaust the
 *    queue on a workspace with a normal agent set.
 *  - "keeps the isolation family separate" dies if the two reports are merged:
 *    isolation is about WHERE the child runs and has its own row and wording.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

interface Event { type: string; message?: string; level?: string }

function definition(key: string, extra: Record<string, unknown>): any {
  return {
    schemaVersion: 2,
    key,
    name: key,
    description: `${key} agent`,
    selectedAsUnqualifiedAlias: true,
    systemPrompt: 'You help.',
    provenance: 'project',
    capabilityGeneration: 'gen-1',
    definitionDigest: 'digest-1',
    ...extra,
  };
}

function harness(definitions: any[]) {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-unexpressible',
      name: 'Codex Unexpressible Workspace',
      rootPath: '/tmp/ws-codex-unexpressible',
      workspaceRootPath: '/tmp/ws-codex-unexpressible',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-unexpressible',
    } as any,
    session: {
      id: 'session-codex-unexpressible',
      workspaceRootPath: '/tmp/ws-codex-unexpressible',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    piRuntimeAgentDefinitions: definitions,
  } as BackendConfig;
  const agent = new CodexAgent(config);
  const events: Event[] = [];
  const debug: string[] = [];
  const internals = agent as unknown as {
    turnSink: { push: (e: Event) => void } | null;
    debug: (message: string) => void;
    reportUnexpressibleCodexAgentFields: () => void;
    reportDroppedCodexAgentIsolation: () => void;
  };
  internals.turnSink = { push: (e: Event) => events.push(e) };
  internals.debug = (message: string) => { debug.push(message); };
  return {
    events,
    debug,
    report: () => internals.reportUnexpressibleCodexAgentFields(),
    reportIsolation: () => internals.reportDroppedCodexAgentIsolation(),
  };
}

describe('P6.309 (2) · the fields codex cannot express name themselves', () => {
  it('names every declared field, per definition and in the notice', () => {
    const h = harness([definition('reviewer', {
      maxTurns: 12,
      memory: 'agent',
      background: true,
      color: 'blue',
      tier: 'big',
      skillKeys: ['plugin:doc'],
      mcpServerKeys: ['linear'],
      initialPrompt: 'Start here.',
    })]);
    h.report();
    expect(h.debug).toHaveLength(1);
    for (const fragment of ['maxTurns=12', 'memory=agent', 'background=true', 'color=blue',
      'tier=big', 'skills=1', 'mcpServers=1', 'initialPrompt']) {
      expect(h.debug[0]).toContain(fragment);
    }
    const notice = h.events.find(e => (e.message ?? '').startsWith('codex-agent-roles-unexpressible'));
    expect(notice).toBeDefined();
    expect(notice!.level).toBe('warning');
    expect(notice!.message).toContain('reviewer');
  });

  it('stays silent when a definition declares none of them', () => {
    const h = harness([definition('plain', { model: 'inherit' })]);
    h.report();
    expect(h.debug).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('is ONE operator notice however many definitions are affected', () => {
    const h = harness([
      definition('a', { maxTurns: 3 }),
      definition('b', { memory: 'agent' }),
      definition('c', { background: false }),
    ]);
    h.report();
    expect(h.debug).toHaveLength(3);
    expect(h.events.filter(e => (e.message ?? '').startsWith('codex-agent-roles-unexpressible')))
      .toHaveLength(1);
  });

  it('keeps the isolation family on its own notice', () => {
    const h = harness([definition('worktree-agent', { isolation: 'worktree', maxTurns: 4 })]);
    h.report();
    h.reportIsolation();
    const kinds = h.events
      .map(e => (e.message ?? '').split(':')[0] ?? '')
      .filter(prefix => prefix.startsWith('codex-agent-roles'));
    expect(new Set(kinds).size).toBe(2);
  });
});
