/**
 * The two codex `PermissionDenied` arms that still named an MCP call in codex's
 * own words, so a hook matcher written in the host's vocabulary missed them.
 *
 * - F1.382 (origin the WJ-hh verifier on F1.274) — codex's AUTO-REVIEW denial
 *   named the call by the action's bare `toolName` (`linear__create_issue`), so
 *   `mcp__linear__.*` and claude's literal `mcp__linear__create_issue` never
 *   fired, while Pi's guardian denial sends `mcp__linear__create_issue`.
 *
 * The rig is the WJ-hh verify probe's (`work/wj-hh-verify/f1274/f1274-probe.test.ts`,
 * P1 / P1-control), made permanent: the REAL `CodexAgent` caller of the emitter,
 * and the REAL matcher (`executePluginHookAutomations`) behind a counting prompt
 * runner — so "fired" is the product's own verdict, not a string comparison.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AutomationsConfig } from '../../automations/types.ts';
import { executePluginHookAutomations } from '../../plugins/hooks-automation.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';

const WS = '/tmp/wjrrb-permission-denied-mcp-name-ws';

function config(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: { id: 'ws-pdmn', name: 'pdmn', rootPath: WS, workspaceRootPath: WS, sessionRootPath: `${WS}/s` } as never,
    session: { id: 's-pdmn', workspaceRootPath: WS, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/wjrrb-proj' } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

function hooks(matcher: string, matchMode?: 'claude'): AutomationsConfig {
  return {
    automations: {
      PermissionDenied: [{ id: 'observer', matcher, ...(matchMode ? { matchMode } : {}), actions: [{ type: 'plugin-prompt', prompt: 'observe' }] }],
    },
  } as unknown as AutomationsConfig;
}

type Seen = { toolName: unknown; toolInput: unknown };

function rig(automations: AutomationsConfig, mode: string) {
  const agent = new CodexAgent(config());
  const emitted: Seen[] = [];
  const fired: Seen[] = [];
  const internals = agent as unknown as Record<string, unknown>;
  internals.emitAutomationEvent = async (event: string, input: Record<string, unknown>) => {
    if (event !== 'PermissionDenied') return undefined;
    emitted.push({ toolName: input.tool_name, toolInput: input.tool_input });
    return executePluginHookAutomations(automations, event as never, input as never, {
      workspaceRootPath: WS,
      promptRunner: async () => { fired.push({ toolName: input.tool_name, toolInput: input.tool_input }); return { ok: true }; },
    });
  };
  (agent as unknown as { onDebug: unknown }).onDebug = () => {};
  (agent as unknown as { onPermissionRequest: unknown }).onPermissionRequest = () => {};
  agent.setPermissionMode(mode as never);
  agent.getPermissionManager().setCapabilityPermissionLayers([], 'gen-pdmn', true);
  return { agent, emitted, fired, internals };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
beforeEach(() => { delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]; });
afterEach(() => { delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]; });

/** codex's auto-review verdict notification, denying `action`. */
async function reviewDenies(r: ReturnType<typeof rig>, action: Record<string, unknown>): Promise<void> {
  r.internals.activeThreadId = 'thread-1';
  (r.internals.handleNotification as (method: string, params: unknown) => void).call(r.agent, 'item/autoApprovalReview/completed', {
    threadId: 'thread-1', review: { status: 'denied' }, action,
  });
  await settle();
  r.agent.destroy();
}

const POOL_ACTION = { type: 'mcpToolCall', server: 'sources', toolName: 'linear__create_issue', connectorId: null, connectorName: null, toolTitle: null };

describe('F1.382 · codex\'s auto-review denial names an MCP call the way Pi\'s guardian denial does', () => {
  it('a pool call is mcp__<wire>__<tool>, and a host-vocabulary matcher fires', async () => {
    const r = rig(hooks('mcp__linear__.*'), 'default');
    await reviewDenies(r, POOL_ACTION);
    expect(r.emitted.map(e => e.toolName)).toEqual(['mcp__linear__create_issue']);
    expect(r.fired.map(e => e.toolName)).toEqual(['mcp__linear__create_issue']);
  });

  it('claude\'s literal in Pi\'s spelling fires too', async () => {
    const r = rig(hooks('mcp__linear__create_issue', 'claude'), 'default');
    await reviewDenies(r, POOL_ACTION);
    expect(r.fired).toHaveLength(1);
  });

  it('a session-server call is mcp__session__<tool>', async () => {
    const r = rig(hooks('mcp__session__.*'), 'default');
    await reviewDenies(r, { type: 'mcpToolCall', server: 'session', toolName: 'automation_list' });
    expect(r.emitted.map(e => e.toolName)).toEqual(['mcp__session__automation_list']);
    expect(r.fired).toHaveLength(1);
  });

  it('BOUNDARY: codex\'s bare row name no longer matches — the vocabulary moved, not widened', async () => {
    const r = rig(hooks('linear__create_issue', 'claude'), 'default');
    await reviewDenies(r, POOL_ACTION);
    expect(r.emitted).toHaveLength(1);
    expect(r.fired).toEqual([]);
  });

  it('CONTROL: a command verdict still names `shell`, and a call with no server keeps its bare name', async () => {
    const shell = rig(hooks('.*'), 'default');
    await reviewDenies(shell, { type: 'command', command: 'rm -rf build', cwd: '/tmp/wjrrb-proj' });
    expect(shell.emitted.map(e => e.toolName)).toEqual(['shell']);

    const serverless = rig(hooks('.*'), 'default');
    await reviewDenies(serverless, { type: 'mcpToolCall', toolName: 'create_issue' });
    expect(serverless.emitted.map(e => e.toolName)).toEqual(['create_issue']);
  });
});

/**
 * - F1.371 (origin WJ-hh P-WJ-hh-5) — codex's DONTASK denial of an MCP tool call
 *   differed from Pi's payload in two fields: `tool_input` was the raw
 *   elicitation FRAME (the branch passed `params`), not the call's arguments;
 *   and `tool_name` was the card's display title whenever the tool declares a
 *   `tool_title` (`mapElicitationApprovalToRequest`'s `toolTitle ??`), so a
 *   matcher missed. Both now come from `codexMcpToolCallRuleRequests`' request —
 *   the same subject the rule consult judged a moment earlier. The WJ-hh probe's
 *   P3 was the residue arm (`tool_title` set → the title was emitted).
 */
function mcpFrame(server: string, tool: string, toolParams: Record<string, unknown>, extraMeta: Record<string, unknown> = {}) {
  return {
    threadId: 't', turnId: 'u', serverName: server, mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: toolParams, tool_params_display: [], ...extraMeta },
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    requestedSchema: { type: 'object', properties: {} },
  };
}

async function dontAskDenies(r: ReturnType<typeof rig>, params: unknown): Promise<unknown> {
  const answer = await (r.internals.handleServerRequest as (method: string, params: unknown) => unknown)
    .call(r.agent, 'mcpServer/elicitation/request', params);
  await settle();
  r.agent.destroy();
  return answer;
}

describe('F1.371 · codex\'s dontAsk denial of an MCP call carries Pi\'s name and the call\'s own arguments', () => {
  it('a tool that declares a tool_title is still named mcp__<wire>__<tool>, and the matcher fires', async () => {
    const r = rig(hooks('mcp__linear__.*'), 'dontAsk');
    await dontAskDenies(r, mcpFrame('sources', 'linear__create_issue', { title: 'Broken build' }, { tool_title: 'Create issue' }));
    expect(r.emitted).toEqual([{ toolName: 'mcp__linear__create_issue', toolInput: { title: 'Broken build' } }]);
    expect(r.fired).toHaveLength(1);
  });

  it('tool_input is the call\'s arguments (`_meta.tool_params`), never the elicitation frame', async () => {
    const r = rig(hooks('.*'), 'dontAsk');
    await dontAskDenies(r, mcpFrame('sources', 'linear__create_issue', { title: 'Broken build', team: 'core' }));
    expect(r.emitted).toEqual([{ toolName: 'mcp__linear__create_issue', toolInput: { title: 'Broken build', team: 'core' } }]);
  });

  it('a session tool is mcp__session__<tool> with its own arguments', async () => {
    const r = rig(hooks('mcp__session__automation_update'), 'dontAsk');
    await dontAskDenies(r, mcpFrame('session', 'automation_update', { automationId: 'tidy' }, { tool_title: 'Update automation' }));
    expect(r.emitted).toEqual([{ toolName: 'mcp__session__automation_update', toolInput: { automationId: 'tidy' } }]);
    expect(r.fired).toHaveLength(1);
  });

  it('CONTROL: a command approval keeps the card\'s `shell` and the frame it was asked with', async () => {
    const cmd = rig(hooks('.*'), 'dontAsk');
    await (cmd.internals.handleServerRequest as (method: string, params: unknown) => unknown)
      .call(cmd.agent, 'item/commandExecution/requestApproval', { command: 'echo hi', cwd: '/tmp/wjrrb-proj' });
    await settle();
    cmd.agent.destroy();
    expect(cmd.emitted).toEqual([{ toolName: 'shell', toolInput: { command: 'echo hi', cwd: '/tmp/wjrrb-proj' } }]);
  });
});

/**
 * - F1.384 (origin the WJ-hh verifier on F1.274) — codex's AUTO-REVIEW denial of
 *   an MCP call sent the review's `action` as `tool_input`
 *   (`GuardianApprovalReviewAction`'s `mcpToolCall` arm: server, toolName,
 *   connector and title — no arguments), where Pi's guardian denial sends the
 *   call's own arguments. The call's arguments DO reach this host first: codex
 *   emits the MCP item's `item/started` (with `arguments`) before it asks for
 *   approval (`core/src/mcp_tool_call.rs` at `rust-v0.156.1`:
 *   `notify_mcp_tool_call_started` precedes `maybe_request_mcp_tool_approval`),
 *   and the review names that item (`targetItemId`, the call id). The dontAsk
 *   half of the row closed with F1.371 (the arm above).
 */
async function reviewDeniesStartedCall(
  r: ReturnType<typeof rig>,
  item: Record<string, unknown> | null,
  action: Record<string, unknown>,
  targetItemId: string | null,
): Promise<void> {
  r.internals.activeThreadId = 'thread-1';
  const notify = r.internals.handleNotification as (method: string, params: unknown) => void;
  if (item) notify.call(r.agent, 'item/started', { threadId: 'thread-1', turnId: 'turn-1', item });
  notify.call(r.agent, 'item/autoApprovalReview/completed', {
    threadId: 'thread-1', turnId: 'turn-1', targetItemId, review: { status: 'denied' }, action,
  });
  await settle();
  r.agent.destroy();
}

const STARTED_POOL_CALL = {
  type: 'mcpToolCall', id: 'call-nes-1', server: 'sources', tool: 'linear__create_issue',
  status: 'inProgress', arguments: { issue: 'NES-1', team: 'core' },
};

describe('F1.384 · codex\'s auto-review denial of an MCP call carries the call\'s own arguments, as Pi\'s guardian denial does', () => {
  it('tool_input is the arguments of the item the review targets, so a hook reading tool_input.issue sees NES-1', async () => {
    const r = rig(hooks('mcp__linear__.*'), 'default');
    await reviewDeniesStartedCall(r, STARTED_POOL_CALL, POOL_ACTION, 'call-nes-1');
    expect(r.emitted).toEqual([{ toolName: 'mcp__linear__create_issue', toolInput: { issue: 'NES-1', team: 'core' } }]);
    expect((r.fired[0]?.toolInput as { issue?: unknown } | undefined)?.issue).toBe('NES-1');
  });

  it('CONTROL: a review whose target was never started (or names none) keeps the action — nothing is invented', async () => {
    for (const target of ['call-unknown', null]) {
      const r = rig(hooks('.*'), 'default');
      await reviewDeniesStartedCall(r, STARTED_POOL_CALL, POOL_ACTION, target);
      expect(r.emitted).toEqual([{ toolName: 'mcp__linear__create_issue', toolInput: POOL_ACTION }]);
    }
  });

  it('CONTROL: a command verdict keeps its action as tool_input, even when its target item was started', async () => {
    const r = rig(hooks('.*'), 'default');
    const command = { type: 'command', source: 'shell', command: 'rm -rf build', cwd: '/tmp/wjrrb-proj' };
    await reviewDeniesStartedCall(r, { type: 'commandExecution', id: 'cmd-1', command: 'rm -rf build', cwd: '/tmp/wjrrb-proj', status: 'inProgress' }, command, 'cmd-1');
    expect(r.emitted).toEqual([{ toolName: 'shell', toolInput: command }]);
  });
});
