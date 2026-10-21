/**
 * P6.156's Pi arm — the bundled agents' tier drop is announced on Pi too, once
 * per session, through the same builder claude's arm uses.
 *
 * The builder itself (text, both locales, one-line-not-four) is covered by
 * `agents/builtin-tier-notice.test.ts`. What is measured HERE is the mount: the
 * channel, the latch, and that a fully resolved tier map says nothing.
 */
import { describe, expect, it } from 'bun:test';

import { PiAgent } from '../pi-agent.ts';

function agentWithSink(): { agent: any; lines: string[] } {
  const lines: string[] = [];
  const agent = new PiAgent({
    provider: 'pi',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws', name: 'ws', rootPath: '/tmp/ws', workspaceRootPath: '/tmp/ws', sessionRootPath: '/tmp/sessions/ws',
    },
    session: { id: 'tier-notice', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1 },
    mcpPool: {
      setElicitationHandler() {},
      getProxyToolDefs: () => [],
      alwaysLoadProxyToolNames: () => new Set<string>(),
      hasResourceCapability: () => true,
      slugsForLeaser: () => new Set<string>(),
    },
  } as any);
  agent.onDebug = (message: string) => lines.push(message);
  return { agent, lines };
}

describe('Pi builtin-agent tier notice (P6.156 Pi arm)', () => {
  it('names the inert tiers on the Pi debug channel', () => {
    const { agent, lines } = agentWithSink();
    try {
      agent.noteBuiltinAgentTiersOnce({ small: 'gateway/fast' });
      const notice = lines.filter(line => line.includes('worker') || line.includes('planner'));
      expect(notice).toHaveLength(1);
      // `small` resolved, so `scout` drops out and the bigger tiers stay named.
      expect(notice[0]).toContain('medium');
      expect(notice[0]).toContain('big');
    } finally {
      agent.destroy();
    }
  });

  it('is latched once a session, not once a turn', () => {
    const { agent, lines } = agentWithSink();
    try {
      agent.noteBuiltinAgentTiersOnce(undefined);
      agent.noteBuiltinAgentTiersOnce(undefined);
      agent.noteBuiltinAgentTiersOnce(undefined);
      expect(lines.filter(line => line.includes('worker'))).toHaveLength(1);
    } finally {
      agent.destroy();
    }
  });

  it('CONTROL — a fully resolved tier map says nothing at all', () => {
    const { agent, lines } = agentWithSink();
    try {
      agent.noteBuiltinAgentTiersOnce({ small: 'a', medium: 'b', big: 'c' });
      expect(lines.filter(line => line.includes('worker'))).toEqual([]);
    } finally {
      agent.destroy();
    }
  });

  it('CONTROL — a null map (the manifest\'s own empty form) is the same as absent', () => {
    const { agent, lines } = agentWithSink();
    try {
      agent.noteBuiltinAgentTiersOnce(null);
      expect(lines.filter(line => line.includes('worker'))).toHaveLength(1);
    } finally {
      agent.destroy();
    }
  });
});
