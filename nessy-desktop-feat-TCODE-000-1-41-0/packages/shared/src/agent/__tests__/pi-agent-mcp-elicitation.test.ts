import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { getHookCommandPreToolDecision } from '../../automations/hook-command.ts';
import { projectHookDecisionForEvent } from '../../automations/hook-decision-contract.ts';
import type { AgentEvent } from '../../automations/types.ts';

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

describe('PiAgent MCP elicitation bridge', () => {
  it('surfaces an MCP elicitation as ask_user and returns the answer to the server', async () => {
    const agent = new PiAgent(createConfig());
    let permission: Parameters<PermissionCallback>[0] | null = null;
    agent.onPermissionRequest = (request) => {
      permission = request;
    };

    const resultPromise = (agent as any).handleMcpElicitation({
      method: 'elicitation/create',
      params: {
        message: 'Allow this MCP action?',
        requestedSchema: {
          type: 'object',
          properties: {
            confirmed: {
              type: 'boolean',
              title: 'Confirmed',
            },
          },
          required: ['confirmed'],
        },
      },
    });

    // R24: the `McpElicitation` hook is consulted before anything is shown, so
    // the dialog is raised an async hop later than it used to be.
    for (let tick = 0; tick < 50 && !permission; tick++) await Promise.resolve();

    expect(permission).toMatchObject({
      toolName: 'ask_user',
      type: 'ask_user',
      askUser: {
        question: 'Allow this MCP action?',
        options: ['Yes', 'No'],
        allowFreeText: false,
      },
    });

    agent.respondToPermission(permission!.requestId, true, false, {
      askUserAnswer: { type: 'option', optionIndex: 0, value: 'Yes' },
    });

    const result = await resultPromise;
    expect(result).toEqual({
      action: 'accept',
      content: { confirmed: true },
    });

    agent.destroy();
  });

  /**
   * `declineVisibly` is the whole of the "tell the user why, then decline it,
   * never silently" rule, and it asks with a SINGLE `OK` — one option. Pi's
   * `ask_user` floor of 2 made that call throw, the throw degraded to a settled
   * refusal, and the one thing the user never saw was the refusal itself.
   *
   * Mutation probe: restore the `2` floor in `requestAskUserPermission` and
   * `permission` stays null here while the promise still settles — which is
   * exactly the shape of the defect.
   */
  it('shows an unsafe-URL refusal instead of declining it silently', async () => {
    const agent = new PiAgent(createConfig());
    let permission: Parameters<PermissionCallback>[0] | null = null;
    agent.onPermissionRequest = (request) => {
      permission = request;
    };

    const resultPromise = (agent as any).handleMcpElicitation({
      method: 'elicitation/create',
      params: {
        mode: 'url',
        message: 'Sign in to continue',
        elicitationId: 'elicit-unsafe',
        // Not http(s), so `safeHttpUrl` refuses it and the refusal must be shown.
        url: 'file:///etc/passwd',
      },
    });

    for (let tick = 0; tick < 50 && !permission; tick++) await Promise.resolve();

    expect(permission).toMatchObject({
      toolName: 'ask_user',
      type: 'ask_user',
      askUser: { options: ['OK'], allowFreeText: false },
    });
    expect(permission!.askUser?.question).toContain('Sign in to continue');
    expect(permission!.askUser?.question).toContain('http(s)');

    agent.respondToPermission(permission!.requestId, true, false, {
      askUserAnswer: { type: 'option', optionIndex: 0, value: 'OK' },
    });

    expect(await resultPromise).toEqual({ action: 'decline' });
    agent.destroy();
  });

  /**
   * The SAME refusal on the path the running app actually takes.
   *
   * `requestAskUserPermission` has two halves, and a `BackendConfig` without an
   * `askUserPort` exercises the one the product skips: live, `config.askUserPort`
   * is always set, the request leaves for the host's `AskUserService`, and the
   * floor that mattered was the host's — `ask-user-reducer.ts:16`, which threw
   * `invalid-options` BEFORE anything was published. Live case ELC-2 measured
   * exactly that: `pi-cards: []`, no `Permission request` line for the Pi
   * session, and `action=cancel` at the MCP server, while Claude and Codex both
   * showed the card. The port fake below carries that one line of the host's
   * rule, so the allowance has to reach it or nothing is surfaced.
   */
  it('carries the one-option allowance to the host port the live app uses', async () => {
    const config = createConfig();
    config.isHeadless = false;
    config.skipConfigWatcher = true;
    let settle: ((answer: any) => void) | undefined;
    const portRequests: Array<{ requestId: string; options: string[]; minOptions?: number }> = [];
    config.askUserPort = {
      request: input => {
        portRequests.push({
          requestId: input.requestId,
          options: input.askUser.options,
          minOptions: input.minOptions,
        });
        // ask-user-reducer.ts:16, the host's own floor.
        if (input.askUser.options.length < (input.minOptions ?? 2)) throw new Error('invalid-options');
        input.publish(input.requestId, input.askUser);
        return new Promise(resolve => { settle = resolve; });
      },
      answer: async input => { settle?.(input.answer); },
      cancel: async () => { settle?.(undefined); },
      reproject: () => {},
    };

    const agent = new PiAgent(config);
    let permission: Parameters<PermissionCallback>[0] | null = null;
    agent.onPermissionRequest = (request) => { permission = request; };

    const resultPromise = (agent as any).handleMcpElicitation({
      method: 'elicitation/create',
      params: {
        mode: 'url',
        message: 'Sign in to continue',
        elicitationId: 'elicit-host-port',
        url: 'file:///etc/passwd',
      },
    });

    for (let tick = 0; tick < 50 && !permission; tick++) await Promise.resolve();

    expect(portRequests).toEqual([
      { requestId: 'mcp-elicitation', options: ['OK'], minOptions: 1 },
    ]);
    expect(permission).toMatchObject({
      toolName: 'ask_user',
      type: 'ask_user',
      askUser: { options: ['OK'], allowFreeText: false },
    });

    agent.respondToPermission('mcp-elicitation', true, false, {
      askUserAnswer: { type: 'option', optionIndex: 0, value: 'OK' },
    });

    expect(await resultPromise).toEqual({ action: 'decline' });
    (agent as any).subprocess = null;
    agent.destroy();
  });

  // The tool a model calls sends NO allowance, so the host's own 2 still bounds
  // it — the elicitation exemption is not a channel-wide loosening.
  it('sends no option allowance for the ask_user tool itself', async () => {
    const config = createConfig();
    config.isHeadless = false;
    config.skipConfigWatcher = true;
    const portRequests: Array<{ requestId: string; minOptions?: number }> = [];
    config.askUserPort = {
      request: input => {
        portRequests.push({ requestId: input.requestId, minOptions: input.minOptions });
        if (input.askUser.options.length < (input.minOptions ?? 2)) throw new Error('invalid-options');
        input.publish(input.requestId, input.askUser);
        return new Promise(() => {});
      },
      answer: async () => {},
      cancel: async () => {},
      reproject: () => {},
    };
    const agent = new PiAgent(config);
    agent.onPermissionRequest = () => {};

    void (agent as any).requestAskUserPermission(
      { question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false },
      'tool-request-host',
    ).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(portRequests).toEqual([{ requestId: 'tool-request-host', minOptions: undefined }]);

    (agent as any).subprocess = null;
    agent.destroy();
  });

  // The floor moved for elicitation ONLY: the `ask_user` tool a model calls
  // keeps the 2-4 bound its own documentation gives it.
  it('keeps the ask_user tool itself at 2 to 4 options', async () => {
    const agent = new PiAgent(createConfig());
    agent.onPermissionRequest = () => {};

    await expect((agent as any).requestAskUserPermission(
      { question: 'Only one way out?', options: ['OK'], allowFreeText: false },
      'tool-request-1',
    )).rejects.toThrow('2 to 4 options');

    agent.destroy();
  });
});

/**
 * hooks.md §Elicitation / §ElicitationResult, "Exit code behavior": exit 2
 * "blocks the elicitation (action becomes decline)" / "blocks the response
 * (action becomes decline)". The exit code is read by
 * `getHookCommandPreToolDecision` and arrives at the agent as a block; this is
 * the step that turns that block into the documented action.
 */
describe('elicitation hook decision mapping', () => {
  const agent = new PiAgent(createConfig());
  const map = (result: unknown) => (agent as any).elicitationHookDecision(result);

  it.each(['McpElicitation', 'ElicitationResult'] as const)('maps an exit-2 %s hook to decline', (event) => {
    const decision = projectHookDecisionForEvent(
      event as AgentEvent,
      getHookCommandPreToolDecision(
        { type: 'command', command: 'check.sh', blockOnNonZero: false },
        { success: false, exitCode: 2, stderr: 'not allowed', output: '' } as never,
      ),
    );

    expect(decision?.decision).toBe('block');
    expect(map({ matchedCount: 1, decision })).toEqual({ action: 'decline' });
  });

  it('prefers an explicit action over any block value', () => {
    expect(map({
      matchedCount: 1,
      decision: { elicitationAction: 'accept', elicitationContent: { user: 'ada' } },
    })).toEqual({ action: 'accept', content: { user: 'ada' } });
  });

  it('is undefined when no hook matched, so the dialog runs', () => {
    expect(map(undefined)).toBeUndefined();
    expect(map({ matchedCount: 0 })).toBeUndefined();
    expect(map({ matchedCount: 1, decision: { additionalContext: 'fyi' } })).toBeUndefined();
  });
});

/**
 * `mcp.md:261` host half: the dialog lives here, the auto-background clock
 * lives in the subprocess, so the open/close edges have to cross the wire.
 */
describe('elicitation dialog state reaches the subprocess', () => {
  it('reports open before the prompt and closed after the answer', async () => {
    const agent = new PiAgent(createConfig());
    const sent: any[] = [];
    (agent as any).send = (cmd: any) => { sent.push(cmd); };
    const states = () => sent.filter(cmd => cmd.type === 'mcp_elicitation_state');

    let permission: Parameters<PermissionCallback>[0] | null = null;
    agent.onPermissionRequest = (request) => { permission = request; };

    const resultPromise = (agent as any).handleMcpElicitation({
      method: 'elicitation/create',
      params: {
        message: 'Allow?',
        requestedSchema: {
          type: 'object',
          properties: { confirmed: { type: 'boolean' } },
          required: ['confirmed'],
        },
      },
    });
    for (let tick = 0; tick < 50 && !permission; tick++) await Promise.resolve();

    // Open while the user is looking at it — this is what suppresses the detach.
    expect(states()).toEqual([
      { type: 'mcp_elicitation_state', dialogId: 'elicit-dialog-1', open: true },
    ]);

    agent.respondToPermission(permission!.requestId, true, false, {
      askUserAnswer: { type: 'option', optionIndex: 0, value: 'Yes' },
    });
    await resultPromise;

    expect(states()).toEqual([
      { type: 'mcp_elicitation_state', dialogId: 'elicit-dialog-1', open: true },
      { type: 'mcp_elicitation_state', dialogId: 'elicit-dialog-1', open: false },
    ]);

    agent.destroy();
  });
});

/**
 * The documented hook payloads, verbatim from `hooks.md:2696` and `:2766`:
 *
 *   Elicitation       — `mcp_server_name`, `message`, optional `mode`, `url`,
 *                       `elicitation_id`, `requested_schema`.
 *   ElicitationResult — `mcp_server_name`, `action`, optional `mode`,
 *                       `elicitation_id`, `content`.
 *
 * These assert the EXACT key set, not a subset, because the previous two
 * revisions both shipped invented names (`form_schema`/`form_state`, then
 * `schema`/`user_response`) that a `toMatchObject` would have let through.
 */
describe('elicitation hook payload field names', () => {
  const agent = new PiAgent(createConfig());
  const context = { server: 'my-mcp-server' };
  const formRequest = {
    method: 'elicitation/create',
    params: {
      message: 'Please provide your credentials',
      requestedSchema: { type: 'object', properties: { username: { type: 'string' } } },
    },
  } as any;

  it('builds the documented Elicitation input for form mode', () => {
    expect((agent as any).buildElicitationHookInput(formRequest, context)).toEqual({
      hook_event_name: 'McpElicitation',
      mcp_server_name: 'my-mcp-server',
      message: 'Please provide your credentials',
      mode: 'form',
      requested_schema: { type: 'object', properties: { username: { type: 'string' } } },
    });
  });

  it('builds the documented Elicitation input for url mode', () => {
    expect((agent as any).buildElicitationHookInput({
      method: 'elicitation/create',
      params: {
        mode: 'url',
        message: 'Please authenticate',
        elicitationId: 'elicit-123',
        url: 'https://auth.example.com/login',
      },
    } as any, context)).toEqual({
      hook_event_name: 'McpElicitation',
      mcp_server_name: 'my-mcp-server',
      message: 'Please authenticate',
      mode: 'url',
      url: 'https://auth.example.com/login',
      elicitation_id: 'elicit-123',
    });
  });

  it('builds the documented ElicitationResult input', () => {
    expect((agent as any).buildElicitationResultHookInput(formRequest, context, {
      action: 'accept',
      content: { username: 'alice' },
    })).toEqual({
      hook_event_name: 'ElicitationResult',
      mcp_server_name: 'my-mcp-server',
      action: 'accept',
      mode: 'form',
      content: { username: 'alice' },
    });
  });

  it.each([
    ['schema', 'requested_schema'],
    ['user_response', 'content'],
    ['form_schema', 'requested_schema'],
    ['form_state', undefined],
    ['mcp_server', 'mcp_server_name'],
    ['tool_name', undefined],
    ['tool_use_id', undefined],
    ['tool_input', undefined],
  ])('never emits the undocumented key %s', (wrong) => {
    const elicitation = (agent as any).buildElicitationHookInput(formRequest, context);
    const result = (agent as any).buildElicitationResultHookInput(formRequest, context, {
      action: 'accept', content: {},
    });
    expect(Object.keys(elicitation)).not.toContain(wrong);
    expect(Object.keys(result)).not.toContain(wrong);
  });

  // ElicitationResult's documented field list has no `message` and no schema.
  it('keeps message and requested_schema off ElicitationResult', () => {
    const keys = Object.keys((agent as any).buildElicitationResultHookInput(formRequest, context, {
      action: 'decline', content: {},
    }));
    expect(keys).not.toContain('message');
    expect(keys).not.toContain('requested_schema');
  });
});
