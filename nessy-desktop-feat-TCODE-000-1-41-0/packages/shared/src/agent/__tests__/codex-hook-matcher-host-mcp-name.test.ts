/**
 * F1.274 (origin WJ-z P-WJ-z-4) — does a host-side hook matcher written in the
 * host's MCP spelling, `mcp__<wire>__.*`, fire on a codex pool call?
 *
 * ## What was measured, and why the answer was no
 *
 * Codex's transcript row for a pool call is codex's raw `(server, tool)` pair,
 * `mcp__sources__<wire>__<tool>` (`backend/codex/event-adapter.ts`
 * `mcpRowToolName`, F1.217), and `noteCodexToolCallForHooks` minted
 * `PostToolUse` / `PostToolUseFailure` with THAT name as `tool_name`. Pi sends
 * the binding's `permissionName` (`pi-agent-server/src/index.ts`
 * `requestPostToolUseTransform`), which for a dynamic MCP binding is its
 * binding name `mcp__<wire>__<tool>` (`pi-harness/harness-manifest.ts`
 * `resolveDynamicTool`). The matcher reads `tool_name`
 * (`automations/utils.ts` `getMatchValueForSdkInput`) as an unanchored regex or,
 * in claude mode, as a literal list — and `mcp__<wire>__` is not a substring of
 * `mcp__sources__<wire>__…`. So one hook, written once, ran on Pi and never on
 * codex: the P3.335 contract ("the payload is Pi's, field for field") broken in
 * its one field a matcher reads.
 *
 * ## The fix, and what it deliberately leaves alone
 *
 * The same one-segment shift F1.272 gives the permission rules
 * (`capabilities/mcp-wire-name.ts` `hostMcpToolNameForCodexRow`), applied to
 * the hook payload's `tool_name` only — on the two post-tool events and on
 * `PermissionDenied`, the third tool-name event codex mints. The TRANSCRIPT row
 * keeps codex's raw pair (F1.217's decision stands), and a session tool's name,
 * `mcp__session__<tool>`, was already the same on every runtime.
 *
 * Every arm runs the REAL matcher through the real executor
 * (`plugins/hooks-automation.ts` `executePluginHookAutomations`, the one every
 * tier dispatches through), with a prompt hook whose runner records each call:
 * a recorded call IS the hook firing. The codex events come out of the real
 * `CodexEventAdapter` fed codex's `mcpToolCall` item.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { AutomationsConfig } from '../../automations/types.ts';
import { executePluginHookAutomations } from '../../plugins/hooks-automation.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';
import { CodexAgent } from '../codex-agent.ts';
import { PiAgent } from '../pi-agent.ts';

const WORKSPACE = '/tmp/wjhh-f1274-ws';

function config(provider: 'codex-runtime' | 'pi'): BackendConfig {
  return {
    provider,
    workspace: {
      id: `ws-f1274-${provider}`,
      name: 'F1.274 Workspace',
      rootPath: WORKSPACE,
      workspaceRootPath: WORKSPACE,
      sessionRootPath: `${WORKSPACE}/sessions`,
    } as never,
    session: {
      id: `session-f1274-${provider}`,
      workspaceRootPath: WORKSPACE,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    ...(provider === 'codex-runtime' ? { model: 'codex/test-model' } : {}),
    isHeadless: true,
  } as BackendConfig;
}

/** One hook per event, the matcher under test, in the mode the matcher is read in. */
function hooks(event: string, matcher: string, matchMode?: 'claude'): AutomationsConfig {
  return {
    automations: {
      [event]: [{
        id: 'f1274',
        matcher,
        ...(matchMode ? { matchMode } : {}),
        actions: [{ type: 'plugin-prompt', prompt: 'observe' }],
      }],
    },
  } as unknown as AutomationsConfig;
}

/** The real executor behind an agent's emission; each prompt-runner call is one hook run. */
function executorFor(automations: AutomationsConfig) {
  const fired: Array<{ event: string; toolName: unknown }> = [];
  const emit = async (event: string, input: Record<string, unknown>) => {
    const result = await executePluginHookAutomations(automations, event as never, input as never, {
      workspaceRootPath: WORKSPACE,
      promptRunner: async () => {
        fired.push({ event, toolName: input.tool_name });
        return { ok: true };
      },
    });
    return result;
  };
  return { fired, emit };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** A codex pool call, end to end through the real adapter, into the real hook seam. */
async function codexPoolCall(automations: AutomationsConfig, server: string, tool: string, isError = false) {
  const agent = new CodexAgent(config('codex-runtime'));
  const { fired, emit } = executorFor(automations);
  const internals = agent as unknown as {
    emitAutomationEvent: typeof emit;
    noteCodexToolCallForHooks: (event: AgentEvent) => void;
  };
  internals.emitAutomationEvent = emit;
  const adapter = new CodexEventAdapter();
  adapter.startTurn('turn-f1274');
  const item = {
    type: 'mcpToolCall', id: 'm-f1274', server, tool, arguments: { issue: 'NES-1' },
    appContext: null, pluginId: null,
  };
  const rows: AgentEvent[] = [
    ...adapter.adapt('item/started', { item: { ...item, status: 'inProgress', result: null, error: null } }),
    ...adapter.adapt('item/completed', {
      item: isError
        ? { ...item, status: 'failed', result: null, error: { message: 'boom' } }
        : { ...item, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }], structuredContent: null, _meta: null }, error: null },
    }),
  ];
  for (const row of rows) internals.noteCodexToolCallForHooks(row);
  await settle();
  agent.destroy();
  return { fired, rows };
}

/** The same call on Pi: the subprocess's post-tool request, named by the binding's permissionName. */
async function piPoolCall(automations: AutomationsConfig, bindingName: string) {
  const agent = new PiAgent(config('pi'));
  const { fired, emit } = executorFor(automations);
  (agent as unknown as Record<string, unknown>).send = () => {};
  (agent as unknown as Record<string, unknown>).emitAutomationEvent = emit;
  await (agent as unknown as { handlePostToolUseRequest: (req: unknown) => Promise<void> }).handlePostToolUseRequest({
    requestId: 'pi-post-f1274', toolName: bindingName, input: { issue: 'NES-1' }, toolResponse: 'ok', isError: false,
  });
  agent.destroy();
  return { fired };
}

describe('F1.274 · a host-spelled MCP hook matcher fires on a codex pool call as it does on Pi', () => {
  it('PostToolUse `mcp__linear__.*` (regex) fires on Pi and on codex, with the same tool_name', async () => {
    const pi = await piPoolCall(hooks('PostToolUse', 'mcp__linear__.*'), 'mcp__linear__create_issue');
    expect(pi.fired).toEqual([{ event: 'PostToolUse', toolName: 'mcp__linear__create_issue' }]);

    const codex = await codexPoolCall(hooks('PostToolUse', 'mcp__linear__.*'), 'sources', 'linear__create_issue');
    expect(codex.fired).toEqual([{ event: 'PostToolUse', toolName: 'mcp__linear__create_issue' }]);
  });

  it('a claude-mode literal matcher names the same call on both runtimes', async () => {
    const literal = hooks('PostToolUse', 'mcp__linear__create_issue', 'claude');
    expect((await piPoolCall(literal, 'mcp__linear__create_issue')).fired).toHaveLength(1);
    expect((await codexPoolCall(literal, 'sources', 'linear__create_issue')).fired).toHaveLength(1);
  });

  it('PostToolUseFailure carries the same name', async () => {
    const codex = await codexPoolCall(hooks('PostToolUseFailure', 'mcp__linear__.*'), 'sources', 'linear__create_issue', true);
    expect(codex.fired).toEqual([{ event: 'PostToolUseFailure', toolName: 'mcp__linear__create_issue' }]);
  });

  it('PermissionDenied names an MCP call in the host spelling too', async () => {
    const agent = new CodexAgent(config('codex-runtime'));
    const { fired, emit } = executorFor(hooks('PermissionDenied', 'mcp__linear__.*'));
    (agent as unknown as { emitAutomationEvent: typeof emit }).emitAutomationEvent = emit;
    (agent as unknown as { emitCodexPermissionDeniedHook: (n: string, i: Record<string, unknown>, r: string) => void })
      .emitCodexPermissionDeniedHook('mcp__sources__linear__create_issue', {}, 'Denied by the dontAsk permission mode.');
    await settle();
    agent.destroy();
    expect(fired).toEqual([{ event: 'PermissionDenied', toolName: 'mcp__linear__create_issue' }]);
  });
});

describe('F1.274 · what the shift must NOT change', () => {
  it('the TRANSCRIPT row keeps codex\'s raw pair (F1.217) — only the hook payload is shifted', async () => {
    const { rows } = await codexPoolCall(hooks('PostToolUse', 'mcp__linear__.*'), 'sources', 'linear__create_issue');
    expect(rows.map(row => (row as { toolName?: string }).toolName))
      .toEqual(['mcp__sources__linear__create_issue', 'mcp__sources__linear__create_issue']);
  });

  it('a session tool is named the same everywhere, and its matcher fires unchanged', async () => {
    const codex = await codexPoolCall(hooks('PostToolUse', 'mcp__session__.*'), 'session', 'automation_list');
    expect(codex.fired).toEqual([{ event: 'PostToolUse', toolName: 'mcp__session__automation_list' }]);
  });

  it('NEGATIVE CONTROL: a matcher for another server fires on neither runtime', async () => {
    const other = hooks('PostToolUse', 'mcp__github__.*');
    expect((await piPoolCall(other, 'mcp__linear__create_issue')).fired).toEqual([]);
    expect((await codexPoolCall(other, 'sources', 'linear__create_issue')).fired).toEqual([]);
  });

  it('BOUNDARY: a matcher spelled in codex\'s row form no longer fires — it names the bridge, not the source', async () => {
    const rowForm = hooks('PostToolUse', 'mcp__sources__linear__.*');
    expect((await codexPoolCall(rowForm, 'sources', 'linear__create_issue')).fired).toEqual([]);
    expect((await piPoolCall(rowForm, 'mcp__linear__create_issue')).fired).toEqual([]);
  });
});
