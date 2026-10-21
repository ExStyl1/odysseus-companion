import { describe, expect, test } from 'bun:test';

import {
  isOrchestrationProgress,
  isOrchestrationResultPayload,
  type OrchestrationProgress,
  type OrchestrationResultPayload,
} from '../src/orchestration.ts';

describe('orchestration wire guards', () => {
  test('accept valid progress payloads', () => {
    const payload: OrchestrationProgress = {
      kind: 'subagent',
      runId: 'run-1',
      agents: [{
        id: 'agent-1',
        label: 'Scout',
        agentType: 'scout',
        phase: 'read',
        status: 'running',
        tokensIn: 10,
        tokensOut: 2,
        toolCalls: 3,
        costUsd: 0.01,
        startedAt: '2026-07-06T00:00:00.000Z',
        lastActivity: 'reading files',
      }],
    };

    expect(isOrchestrationProgress(payload)).toBe(true);
    expect(isOrchestrationProgress({
      ...payload,
      agents: payload.agents.map(({ startedAt: _startedAt, ...agent }) => agent),
    })).toBe(true);
  });

  test('accept declared workflow phases on progress payloads', () => {
    expect(isOrchestrationProgress({
      kind: 'workflow',
      runId: 'run-1',
      agents: [],
      phases: [
        { title: 'Discover', detail: 'Read the repo' },
        { title: 'Review' },
      ],
    })).toBe(true);
  });

  test('reject malformed progress payloads', () => {
    expect(isOrchestrationProgress({
      kind: 'subagent',
      runId: 'run-1',
      agents: [{ id: 'agent-1', label: 'Scout', agentType: 'scout', status: 'running', tokensIn: '10', tokensOut: 2 }],
    })).toBe(false);

    expect(isOrchestrationProgress({
      kind: 'subagent',
      runId: 'run-1',
      agents: [{ id: 'agent-1', label: 'Scout', agentType: 'scout', status: 'running', tokensIn: 10, tokensOut: 2, startedAt: 123 }],
    })).toBe(false);

    expect(isOrchestrationProgress({
      kind: 'subagent',
      runId: 'run-1',
      agents: [{ id: 'agent-1', label: 'Scout', agentType: 'scout', status: 'running', tokensIn: 10, tokensOut: 2, toolCalls: '2' }],
    })).toBe(false);

    expect(isOrchestrationProgress({
      kind: 'workflow',
      runId: 'run-1',
      agents: [],
      phases: [{ title: 42 }],
    })).toBe(false);
  });

  test('accept valid result payloads', () => {
    const payload: OrchestrationResultPayload = {
      kind: 'workflow',
      runId: 'run-2',
      status: 'done',
      results: [{
        id: 'agent-1',
        label: 'Worker',
        agentType: 'worker',
        status: 'done',
        text: '{"ok":true}',
        tokensIn: 12,
        tokensOut: 4,
      }],
      failures: [{
        helper: 'parallel',
        index: 1,
        phase: 'scan',
        error: 'child failed',
      }],
    };

    expect(isOrchestrationResultPayload(payload)).toBe(true);
  });

  test('reject invalid result statuses', () => {
    expect(isOrchestrationResultPayload({
      kind: 'workflow',
      runId: 'run-2',
      status: 'running',
      results: [],
    })).toBe(false);
  });
});
