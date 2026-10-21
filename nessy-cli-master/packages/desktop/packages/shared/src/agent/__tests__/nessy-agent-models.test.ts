/* eslint-disable import/no-internal-modules */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelDefinition } from '../../config/models.ts';
import type { BackendConfig } from '../backend/types.ts';
import {
  NessyAgent,
  extractNessyParentToolUseId,
  formatNessyAcpErrorMessage,
  resolveNessyParentToolUseId,
} from '../nessy-agent.ts';

type NessyModelInternals = {
  recordSessionModels: (result: Record<string, unknown>) => void;
  applySessionSettings: (sessionId: string) => Promise<void>;
  callAcp: <T>(
    method: string,
    execute: (connection: {
      unstable_setSessionModel: (params: {
        sessionId: string;
        modelId: string;
      }) => Promise<T>;
      setSessionConfigOption: (params: {
        sessionId: string;
        configId: string;
        value: string;
      }) => Promise<T>;
      setSessionMode: (params: {
        sessionId: string;
        modeId: string;
      }) => Promise<T>;
    }) => Promise<T>,
  ) => Promise<T>;
  captureUsage: (update: Record<string, unknown>) => void;
  eventQueue: {
    drain: () => AsyncGenerator<unknown>;
  };
  extractUsage: (update: Record<string, unknown>) => {
    inputTokens: number;
    contextTokens: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  } | null;
  extractLatestTokenUsage: (updates: Array<Record<string, unknown>>) =>
    | {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        contextTokens: number;
        costUsd: number;
      }
    | undefined;
};

type NessyAuthRetryInternals = {
  connection: {
    signal: { aborted: boolean };
  };
  acpLease: {
    isActive: () => boolean;
    authenticate: (methodId: string) => Promise<void>;
    release: () => void;
  };
  callAcp: <T>(
    method: string,
    execute: (connection: unknown) => Promise<T>,
    timeoutMs?: number,
  ) => Promise<T>;
};

type PermissionOptionLike = {
  optionId?: string;
  kind?: string;
  name?: string;
};

type PermissionResponseLike = {
  outcome: { outcome: string; optionId?: string };
  answers?: Record<string, string>;
};

type PermissionResponseInternals = {
  createPermissionResponse: (
    options: PermissionOptionLike[],
    allowed: boolean,
    alwaysAllow: boolean,
    answers?: Record<string, string>,
  ) => PermissionResponseLike;
};

type PermissionRequestInternals = {
  handlePermissionRequest: (
    params: Record<string, unknown>,
  ) => Promise<{ outcome: { outcome: string; optionId?: string } }>;
};

type CapturedPermissionRequest = Parameters<
  NonNullable<NessyAgent['onPermissionRequest']>
>[0];

function createAgent(
  cwd: string,
  onAvailableModelsUpdate: BackendConfig['onAvailableModelsUpdate'],
): NessyAgent {
  return new NessyAgent({
    provider: 'nessy',
    workspace: {
      id: 'workspace-nessy',
      name: 'Nessy Workspace',
      slug: 'nessy-workspace',
      rootPath: cwd,
      createdAt: Date.now(),
    },
    session: {
      id: 'session-nessy',
      name: 'Nessy Session',
      workspaceRootPath: cwd,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: 'ask',
    },
    isHeadless: true,
    onAvailableModelsUpdate,
  } as BackendConfig);
}

async function readNextQueuedEvent(agent: NessyAgent): Promise<unknown> {
  const queue = (agent as unknown as NessyModelInternals).eventQueue;
  const iterator = queue.drain();
  const next = await iterator.next();
  await iterator.return?.(undefined);
  return next.value;
}

function createPermissionResponse(
  options: PermissionOptionLike[],
  allowed: boolean,
  alwaysAllow: boolean,
  answers?: Record<string, string>,
): PermissionResponseLike {
  const agent = Object.create(
    NessyAgent.prototype,
  ) as PermissionResponseInternals;
  return agent.createPermissionResponse(options, allowed, alwaysAllow, answers);
}

describe('NessyAgent ACP error formatting', () => {
  it('includes ACP internal error details in user-visible messages', () => {
    const error = Object.assign(new Error('Internal error'), {
      data: { details: '401 Unauthorized' },
    });

    expect(formatNessyAcpErrorMessage(error)).toBe(
      'Internal error: 401 Unauthorized',
    );
  });

  it('uses nested provider messages from ACP internal error data', () => {
    const error = Object.assign(new Error('Internal error'), {
      data: {
        error: {
          message: 'Model access denied',
          code: 'PermissionDenied',
        },
      },
    });

    expect(formatNessyAcpErrorMessage(error)).toBe(
      'Internal error: Model access denied',
    );
  });

  it('authenticates with DP Auth and retries a rejected session request', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-agent-auth-'));
    const agent = createAgent(cwd, () => undefined);
    const internals = agent as unknown as NessyAuthRetryInternals;
    const authenticatedMethods: string[] = [];
    let attempts = 0;

    internals.connection = { signal: { aborted: false } };
    internals.acpLease = {
      isActive: () => true,
      authenticate: async (methodId) => {
        authenticatedMethods.push(methodId);
      },
      release: () => undefined,
    };

    const result = await internals.callAcp(
      'session/new',
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('Authentication required'), {
            data: {
              authMethods: [
                { id: 'openai', name: 'OpenAI' },
                { id: 'dp-auth', name: 'DP Authentication' },
              ],
            },
          });
        }
        return { sessionId: 'authenticated-session' };
      },
      0,
    );

    expect(authenticatedMethods).toEqual(['dp-auth']);
    expect(attempts).toBe(2);
    expect(result).toEqual({ sessionId: 'authenticated-session' });
    agent.destroy();
  });
});

// [nessy-fork] desktop-plan-permission-flow
describe('NessyAgent permission responses', () => {
  // [nessy-fork] desktop-permission-request-ui
  it('forwards ACP file contents for permission diff review', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-agent-permission-'));
    const agent = createAgent(cwd, () => undefined);
    let captured: CapturedPermissionRequest | undefined;
    agent.onPermissionRequest = (request) => {
      captured = request;
    };

    const responsePromise = (
      agent as unknown as PermissionRequestInternals
    ).handlePermissionRequest({
      toolCall: {
        kind: 'edit',
        title: 'Edit example.ts',
        content: [
          {
            type: 'diff',
            path: '/workspace/example.ts',
            oldText: 'const answer = 41;\n',
            newText: 'const answer = 42;\n',
          },
        ],
        rawInput: {},
      },
      options: [
        {
          optionId: 'proceed_once',
          name: 'Allow',
          kind: 'allow_once',
        },
      ],
    });

    expect(captured).toMatchObject({
      type: 'file_write',
      filePath: '/workspace/example.ts',
      oldText: 'const answer = 41;\n',
      newText: 'const answer = 42;\n',
    });

    agent.respondToPermission(captured?.requestId ?? '', true, false);
    await expect(responsePromise).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'proceed_once',
      },
    });
  });

  it('shows exit plan mode as a regular switch-mode permission', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-agent-permission-'));
    const agent = createAgent(cwd, () => undefined);
    let captured: CapturedPermissionRequest | undefined;
    agent.onPermissionRequest = (request) => {
      captured = request;
    };

    const responsePromise = (
      agent as unknown as PermissionRequestInternals
    ).handlePermissionRequest({
      toolCall: {
        kind: 'switch_mode',
        title: 'Plan:',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: '1. Inspect the CLI flags.\n2. Align Desktop params.',
            },
          },
        ],
        rawInput: {},
      },
      options: [
        {
          optionId: 'restore_previous',
          name: 'Yes, restore previous mode (auto)',
          kind: 'allow_once',
        },
      ],
    });

    expect(captured?.type).toBe('mcp_mutation');
    expect(captured?.toolName).toBe('ExitPlanMode');
    expect(captured?.description).toBe(
      'Plan:\n1. Inspect the CLI flags.\n2. Align Desktop params.',
    );
    expect(captured?.impact).toBe(
      '1. Inspect the CLI flags.\n2. Align Desktop params.',
    );

    agent.respondToPermission(captured?.requestId ?? '', true, false);

    await expect(responsePromise).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'restore_previous',
      },
    });
  });

  it('restores the previous mode for plan approvals when offered by CLI', () => {
    const response = createPermissionResponse(
      [
        {
          optionId: 'restore_previous',
          name: 'Yes, restore previous mode (auto)',
          kind: 'allow_once',
        },
        {
          optionId: 'proceed_always',
          name: 'Yes, and auto-accept edits',
          kind: 'allow_always',
        },
        {
          optionId: 'proceed_once',
          name: 'Yes, and manually approve edits',
          kind: 'allow_once',
        },
        {
          optionId: 'cancel',
          name: 'No, keep planning (esc)',
          kind: 'reject_once',
        },
      ],
      true,
      false,
    );

    expect(response.outcome).toEqual({
      outcome: 'selected',
      optionId: 'restore_previous',
    });
  });

  it('submits ask_user_question answers with a CLI outcome option', () => {
    const response = createPermissionResponse(
      [
        {
          optionId: 'q0_opt0',
          name: 'Use TypeScript',
          kind: 'allow_once',
        },
        {
          optionId: 'proceed_once',
          name: "I'll specify my own answer",
          kind: 'allow_once',
        },
        {
          optionId: 'cancel',
          name: 'Cancel',
          kind: 'reject_once',
        },
      ],
      true,
      false,
      { '0': 'Use TypeScript' },
    );

    expect(response).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'proceed_once',
      },
      answers: { '0': 'Use TypeScript' },
    });
  });

  it('does not invent an option id when CLI sends no allow option', () => {
    const response = createPermissionResponse(
      [{ optionId: 'cancel', name: 'Reject', kind: 'reject_once' }],
      true,
      false,
    );

    expect(response.outcome).toEqual({ outcome: 'cancelled' });
  });
});

describe('NessyAgent model metadata', () => {
  it('extracts subagent parent metadata from Nessy ACP updates', () => {
    expect(
      extractNessyParentToolUseId({
        _meta: {
          parentToolCallId: 'agent-parent-1',
          subagentType: 'general-purpose',
        },
      }),
    ).toBe('agent-parent-1');
  });

  it('falls back to the only active parent tool without self-referencing', () => {
    expect(
      resolveNessyParentToolUseId({
        update: {},
        toolUseId: 'read-child-1',
        activeParentToolUseIds: new Set(['agent-parent-1']),
      }),
    ).toBe('agent-parent-1');

    expect(
      resolveNessyParentToolUseId({
        update: {},
        toolUseId: 'agent-parent-1',
        activeParentToolUseIds: new Set(['agent-parent-1']),
      }),
    ).toBeUndefined();
  });

  it('uses ACP-reported context and thinking metadata without a hardcoded context fallback', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-cwd-'));
    let capturedModels: ModelDefinition[] = [];
    let capturedCurrent: string | undefined;
    const agent = createAgent(cwd, (models, currentModelId) => {
      capturedModels = models;
      capturedCurrent = currentModelId;
    });

    (agent as unknown as NessyModelInternals).recordSessionModels({
      models: {
        currentModelId: 'qwen3-coder-flash',
        availableModels: [
          {
            modelId: 'qwen3-coder-flash',
            name: 'GLM 5.1',
            _meta: {
              contextLimit: 128_000,
              enable_thinking: false,
            },
          },
          {
            modelId: 'qwen3-coder-plus',
            name: 'qwen3 Coder Plus',
          },
        ],
      },
    });

    expect(agent.getModel()).toBe('qwen3-coder-flash');
    expect(capturedCurrent).toBe('qwen3-coder-flash');
    expect(capturedModels[0]).toMatchObject({
      id: 'qwen3-coder-flash',
      contextWindow: 128_000,
      supportsThinking: false,
    });
    expect(capturedModels[1]?.id).toBe('qwen3-coder-plus');
    expect(capturedModels[1]).not.toHaveProperty('contextWindow');
  });

  it('uses ACP total tokens for context usage without double-counting cached tokens', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-cwd-'));
    const agent = createAgent(cwd, () => {});

    const usage = (agent as unknown as NessyModelInternals).extractUsage({
      _meta: {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cachedReadTokens: 20,
        },
      },
    });

    expect(usage).toEqual({
      inputTokens: 100,
      contextTokens: 150,
      outputTokens: 50,
      cacheReadTokens: 20,
    });
  });

  it('applies configured session models through ACP session/set_model', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-cwd-'));
    const agent = createAgent(cwd, () => {});
    const internals = agent as unknown as NessyModelInternals;
    const methods: string[] = [];
    const setModelParams: Array<{ sessionId: string; modelId: string }> = [];

    internals.recordSessionModels({
      models: {
        currentModelId: 'qwen3-coder-flash',
        availableModels: [
          {
            modelId: 'qwen3-coder-flash',
            name: 'qwen3 Coder Flash',
          },
          {
            modelId: 'qwen3-coder-plus',
            name: 'qwen3 Coder Plus',
          },
        ],
      },
    });
    agent.setModel('qwen3-coder-plus');

    internals.callAcp = async (method, execute) => {
      methods.push(method);
      return execute({
        unstable_setSessionModel: async (params) => {
          setModelParams.push(params);
          return undefined as Awaited<ReturnType<typeof execute>>;
        },
        setSessionConfigOption: async () =>
          undefined as Awaited<ReturnType<typeof execute>>,
        setSessionMode: async () =>
          undefined as Awaited<ReturnType<typeof execute>>,
      });
    };

    await internals.applySessionSettings('nessy-session-1');

    expect(methods).toContain('session/set_model');
    expect(methods).not.toContain('session/set_config_option');
    expect(setModelParams).toContainEqual({
      sessionId: 'nessy-session-1',
      modelId: 'qwen3-coder-plus',
    });
  });

  it('falls back to ACP input tokens for context usage when total tokens are unavailable', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-cwd-'));
    const agent = createAgent(cwd, () => {});

    const usage = (agent as unknown as NessyModelInternals).extractUsage({
      _meta: {
        usage: {
          promptTokenCount: 100,
          cachedContentTokenCount: 20,
        },
      },
    });

    expect(usage).toEqual({
      inputTokens: 100,
      contextTokens: 100,
      outputTokens: undefined,
      cacheReadTokens: 20,
    });
  });

  it('ignores empty ACP usage instead of resetting context usage to zero', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-cwd-'));
    const agent = createAgent(cwd, () => {});

    const usage = (agent as unknown as NessyModelInternals).extractUsage({
      _meta: {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      },
    });

    expect(usage).toBeNull();
  });

  it('extracts latest replay usage for loaded Nessy native history', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-cwd-'));
    const agent = createAgent(cwd, () => {});

    const tokenUsage = (
      agent as unknown as NessyModelInternals
    ).extractLatestTokenUsage([
      {
        sessionUpdate: 'agent_message_chunk',
        _meta: {
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
        },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        _meta: {
          usageMetadata: {
            promptTokenCount: 200,
            candidatesTokenCount: 40,
            totalTokenCount: 240,
          },
        },
      },
    ]);

    expect(tokenUsage).toEqual({
      inputTokens: 240,
      outputTokens: 40,
      totalTokens: 240,
      contextTokens: 240,
      costUsd: 0,
    });
  });

  it('emits context ring usage with the same total-token semantics as /context', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-cwd-'));
    const agent = createAgent(cwd, () => {});
    const internals = agent as unknown as NessyModelInternals;

    internals.captureUsage({
      _meta: {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cachedReadTokens: 20,
        },
      },
    });

    await expect(readNextQueuedEvent(agent)).resolves.toEqual({
      type: 'usage_update',
      usage: {
        inputTokens: 150,
      },
    });
  });
});
