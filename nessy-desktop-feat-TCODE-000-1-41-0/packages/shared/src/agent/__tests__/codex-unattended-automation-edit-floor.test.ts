/**
 * F1.227 (origin WJ-l P-WJ-l-4) — F1.113 + F1.228's card on codex, over the
 * REAL approval path: `CodexAgent.handleServerRequest` answering the
 * `mcpServer/elicitation/request` codex sends for an MCP tool call.
 *
 * The request is built in the shape codex-rs builds it at `rust-v0.154.0`
 * (`core/src/mcp_tool_call.rs`, `build_mcp_tool_approval_elicitation_request` +
 * `build_mcp_tool_approval_elicitation_meta`; key names from
 * `protocol/src/mcp_approval_meta.rs`): form mode, an empty requested schema,
 * `_meta.codex_approval_kind = "mcp_tool_call"`, `_meta.persist` offering the
 * session remember, and `_meta.tool_params` carrying the call's ARGUMENTS. The
 * message is `build_mcp_tool_approval_fallback_message`'s template.
 *
 * Before the row the bridge surfaced this as an ordinary MCP card — "Allow the
 * session MCP server to run tool …" with nothing naming the automation's mode —
 * and an unattended turn with the operator's `allow` escape hatch accepted it.
 * Both arms below were red on that.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';
import type { PermissionMode } from '../mode-types.ts';

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'wjl-f1227-'));
writeFileSync(join(WORKSPACE_ROOT, 'automations.json'), JSON.stringify({
  version: 2,
  automations: {
    SchedulerTick: [
      { id: 'dormant-bypass', name: 'Weekly purge', cron: '0 5 * * 0', permissionMode: 'bypassPermissions', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
      { id: 'tidy', name: 'Tidy', cron: '0 4 * * *', permissionMode: 'acceptEdits', actions: [{ type: 'prompt', prompt: 'old' }] },
    ],
  },
}));

afterAll(() => {
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1227',
      name: 'F1.227 Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as any,
    session: {
      id: 'session-f1227',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** codex's own approval request for one `automation_update` call. */
function approvalFor(toolParams: Record<string, unknown>) {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    serverName: 'session',
    mode: 'form',
    message: 'Allow the session MCP server to run tool "automation_update"?',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: 'session',
      tool_description: 'Update an existing workspace automation by automationId.',
      tool_params: toolParams,
    },
    requestedSchema: { type: 'object', properties: {} },
  };
}

function agentIn(mode: PermissionMode, attended: boolean) {
  const agent = new CodexAgent(createConfig());
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = () => {};
  if (attended) agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode(mode);
  return { agent, surfaced };
}

function ask(agent: CodexAgent, toolParams: Record<string, unknown>) {
  return (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, approvalFor(toolParams)) as
    Promise<Record<string, unknown>> | Record<string, unknown>;
}

const REENABLE = { automationId: 'dormant-bypass', patch: { enabled: true } };

describe('F1.227 · codex: changing what or when a bypass automation runs reaches a person, named', () => {
  it('attended: the card names the automation and its mode, and a remembered answer is refused', async () => {
    const { agent, surfaced } = agentIn('default', true);
    const pending = ask(agent, REENABLE);
    expect(surfaced).toHaveLength(1);
    const card = surfaced[0]!;
    expect(card.description).toContain('"Weekly purge" (dormant-bypass) runs (enabled)');
    expect(card.description).toContain('bypassPermissions');
    expect(card.noAlwaysAllow).toBe(true);
    // The person says yes, and asks to remember: the yes stands, the remember
    // does not — and our accept never carries `_meta.persist`, which is the only
    // thing that would make codex answer the next call itself.
    agent.respondToPermission(card.requestId, true, true);
    const answer = await pending;
    expect(answer.action).toBe('accept');
    expect(answer._meta).toBeUndefined();
  });

  it('unattended: refused even with the operator escape hatch open', async () => {
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    const { agent } = agentIn('default', false);
    expect((await ask(agent, REENABLE)).action).toBe('decline');
    // CONTROL on the same hatch: an edit that is not the floor is accepted, so
    // the refusal above is the floor's doing and not the rig's.
    expect((await ask(agent, { automationId: 'tidy', patch: { enabled: true } })).action).toBe('accept');
  });

  it('bypassPermissions skips it, as the claude/Pi gate does', async () => {
    const { agent, surfaced } = agentIn('bypassPermissions', true);
    expect((await ask(agent, REENABLE)).action).toBe('accept');
    expect(surfaced).toHaveLength(0);
  });

  it('CONTROL: renaming it, or editing an automation at the ceiling, keeps the ordinary card', async () => {
    for (const toolParams of [
      { automationId: 'dormant-bypass', patch: { name: 'Renamed' } },
      { automationId: 'tidy', patch: { enabled: true } },
    ]) {
      const { agent, surfaced } = agentIn('default', true);
      const pending = ask(agent, toolParams);
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]!.description).not.toContain('runs unattended in');
      agent.respondToPermission(surfaced[0]!.requestId, false);
      expect((await pending).action).toBe('decline');
    }
  });
});
