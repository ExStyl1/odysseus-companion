import { afterEach, describe, expect, it } from 'bun:test';
import {
  SESSION_TOOL_REGISTRY,
  type SessionToolDef,
} from '@nessy-agent/session-tools-core';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

const TOOL_NAME = 'structured_content_test_tool';

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

function registerTool(result: {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}): void {
  const baseDef = SESSION_TOOL_REGISTRY.get('list_sessions')!;
  SESSION_TOOL_REGISTRY.set(TOOL_NAME, {
    ...baseDef,
    name: TOOL_NAME,
    description: 'Test structuredContent conversion',
    executionMode: 'registry',
    handler: async () => result,
  } as SessionToolDef);
}

afterEach(() => {
  SESSION_TOOL_REGISTRY.delete(TOOL_NAME);
});

describe('PiAgent session tool structuredContent conversion', () => {
  it('preserves structuredContent in the subprocess tool response', async () => {
    registerTool({
      content: [{ type: 'text', text: 'rows ready' }],
      structuredContent: {
        rows: [{ id: 1, label: 'alpha' }],
      },
      isError: false,
    });

    const agent = new PiAgent(createConfig());
    try {
      const result = await (agent as any).executeSessionTool(TOOL_NAME, {});

      expect(result).toEqual({
        content: 'rows ready',
        isError: false,
        structuredContent: {
          rows: [{ id: 1, label: 'alpha' }],
        },
      });
    } finally {
      agent.destroy();
    }
  });

  it('keeps text-only session tool responses unchanged', async () => {
    registerTool({
      content: [{ type: 'text', text: 'plain text' }],
      structuredContent: {},
      isError: false,
    });

    const agent = new PiAgent(createConfig());
    try {
      const result = await (agent as any).executeSessionTool(TOOL_NAME, {});

      expect(result).toEqual({
        content: 'plain text',
        isError: false,
      });
    } finally {
      agent.destroy();
    }
  });
});
