import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

describe('PiAgent SlashCommand session tool', () => {
  it('sends the resolved auto policy while manual compact remains available when auto is off', async () => {
    const agent = new PiAgent({
      ...createConfig(),
      autoCompaction: {
        enabled: false,
        thresholdPercent: 50,
        contextWindow: 100_000,
      },
    } as BackendConfig);
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).ensureSubprocess = async () => undefined;
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).requestCompact = async () => ({
      summary: 'manual still works',
      firstKeptEntryId: 'entry-1',
      tokensBefore: 12_345,
    });

    try {
      const toggle = (agent as any).requestSetAutoCompaction(
        (agent as any).config.autoCompaction,
      );
      await Promise.resolve();
      (agent as any).handleSetAutoCompactionResult({
        id: sent[0]?.id,
        success: true,
        enabled: false,
      });
      await expect(toggle).resolves.toBe(false);
      expect(sent[0]).toMatchObject({
        type: 'set_auto_compaction',
        enabled: false,
        thresholdPercent: 50,
        contextWindow: 100_000,
      });

      const manual = await (agent as any).executeSessionTool('SlashCommand', {
        command: 'compact',
      });
      expect(manual.isError).toBe(false);
      expect(manual.content).toContain('Compacted context');
    } finally {
      agent.destroy();
    }
  });

  it('runs an allowed compact slash command', async () => {
    const agent = new PiAgent(createConfig());
    const calls: Array<string | undefined> = [];
    (agent as any).requestCompact = async (customInstructions?: string) => {
      calls.push(customInstructions);
      return {
        summary: 'shorter',
        firstKeptEntryId: 'entry-1',
        tokensBefore: 12345,
      };
    };

    try {
      const result = await (agent as any).executeSessionTool('SlashCommand', {
        command: 'compact',
        arguments: 'preserve decisions',
      });

      expect(result.isError).toBe(false);
      expect(result.content).toContain('Compacted context');
      expect(calls).toEqual(['preserve decisions']);
    } finally {
      agent.destroy();
    }
  });

  it('includes estimated after-compact tokens when the subprocess reports them', async () => {
    const agent = new PiAgent(createConfig());
    (agent as any).requestCompact = async () => ({
      summary: 'shorter',
      firstKeptEntryId: 'entry-1',
      tokensBefore: 12345,
      estimatedTokensAfter: 2345,
    });

    try {
      const result = await (agent as any).executeSessionTool('SlashCommand', {
        command: 'compact',
      });

      expect(result.isError).toBe(false);
      expect(result.content).toContain('from ~12,345 to ~2,345 tokens');
    } finally {
      agent.destroy();
    }
  });

  it('resolves context usage requests from the subprocess response', async () => {
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).ensureSubprocess = async () => undefined;
    (agent as any).send = (cmd: Record<string, unknown>) => {
      sent.push(cmd);
    };

    try {
      const promise = agent.requestContextUsage();
      await Promise.resolve();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'get_context_usage' });

      ;(agent as any).handleContextUsageResult({
        id: sent[0]!.id,
        success: true,
        usage: {
          inputTokens: 100,
          contextWindow: 1000,
          contextWindowSource: 'runtime',
          source: 'sdk_usage',
        },
      });

      await expect(promise).resolves.toMatchObject({
        inputTokens: 100,
        contextWindow: 1000,
        source: 'sdk_usage',
      });
    } finally {
      agent.destroy();
    }
  });

  it('rejects failed context usage responses without affecting chat flow state', async () => {
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).ensureSubprocess = async () => undefined;
    (agent as any).send = (cmd: Record<string, unknown>) => {
      sent.push(cmd);
    };

    try {
      const promise = agent.requestContextUsage();
      await Promise.resolve();
      ;(agent as any).handleContextUsageResult({
        id: sent[0]!.id,
        success: false,
        errorMessage: 'not ready',
      });

      await expect(promise).rejects.toThrow('not ready');
      expect(agent.isProcessing()).toBe(false);
    } finally {
      agent.destroy();
    }
  });

  it('dispatches a structured workflow invocation without sending a model prompt', async () => {
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    const internals = agent as any;
    internals.ensureSubprocess = async () => undefined;
    internals.emitAutomationEvent = async () => undefined;
    internals.syncExecutionManifestForCurrentTurn = async () => ({
      snapshotGeneration: 'generation-1',
      manifestHash: 'manifest-1',
    });
    internals.send = (command: Record<string, unknown>) => {
      sent.push(command);
      if (command.type !== 'workflow_execute') return;
      queueMicrotask(() => internals.handleLine(JSON.stringify({
        type: 'workflow_execute_result',
        id: command.id,
        ok: true,
        content: 'workflow completed',
        details: { returnValue: 'done' },
      })));
    };

    try {
      const events: Array<Record<string, unknown>> = [];
      for await (const event of internals.chatImpl('/audit release readiness', undefined, {
        workflowInvocation: {
          name: 'audit',
          args: { input: 'release readiness' },
        },
      })) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'text_complete', text: 'workflow completed' },
        { type: 'complete' },
      ]);
      expect(sent).toEqual([{
        type: 'workflow_execute',
        id: expect.any(String),
        invocation: {
          name: 'audit',
          args: { input: 'release readiness' },
        },
        message: '/audit release readiness',
        manifestGeneration: 'generation-1',
        manifestHash: 'manifest-1',
      }]);
      expect(sent.some(command => command.type === 'prompt')).toBe(false);
    } finally {
      agent.destroy();
    }
  });

  it('rejects unknown slash commands', async () => {
    const agent = new PiAgent(createConfig());
    try {
      const result = await (agent as any).executeSessionTool('SlashCommand', {
        command: 'clear',
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown or blocked slash command');
    } finally {
      agent.destroy();
    }
  });
});
