/**
 * F1.778 (origin: release sitting SIT-l E16, packaged `5896a66d2`) — F1.227's
 * floor fired on codex but its sentence never reached the card.
 *
 * The drop, read from source: `handleServerRequest` appended the floor's
 * sentence to the request's `reason`, and the ordinary permission card
 * (`PermissionRequest.tsx`) renders `toolName`, `description`, `impact` and
 * `command` — `reason` is rendered only by the admin-approval card. F1.227's
 * arms asserted `reason`, so they were green over a card that showed codex's
 * generic `Allow the session MCP server to run tool "automation_update"?` and
 * nothing else. Pi and claude put every floor sentence in `description`
 * (`core/pre-tool-use.ts`, each `nonNegotiable` prompt), so that is the field
 * pinned here: the EMITTED request, the seam the renderer reads.
 *
 * The request is SIT-l E16's, in the shape codex-rs builds at `rust-v0.154.0`
 * (`core/src/mcp_tool_call.rs`): form mode, `_meta.codex_approval_kind =
 * "mcp_tool_call"`, `_meta.tool_params` = the call's arguments.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import {
  describeUnattendedAutomationEdit,
  findNonNegotiableFloors,
  firstNonNegotiableFloor,
  unattendedAutomationEdit,
} from '../core/pre-tool-use.ts';

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'wjcritgg-f1778-'));
writeFileSync(join(WORKSPACE_ROOT, 'automations.json'), JSON.stringify({
  version: 2,
  automations: {
    SchedulerTick: [
      { id: 'sitl-nightly', name: 'SIT-l nightly sweep', cron: '0 3 * * *', permissionMode: 'bypassPermissions', enabled: false, actions: [{ type: 'prompt', prompt: 'sweep' }] },
      { id: 'sitl-live', name: 'SIT-l live sweep', cron: '0 4 * * *', permissionMode: 'bypassPermissions', enabled: true, actions: [{ type: 'prompt', prompt: 'sweep' }] },
    ],
  },
}));

afterAll(() => {
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

const CODEX_MESSAGE = 'Allow the session MCP server to run tool "automation_update"?';
const HOME_RM = ['rm', '-rf', '~'].join(' ');

function attendedAgent() {
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1778',
      name: 'F1.778 Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as any,
    session: {
      id: 'session-f1778',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  } satisfies BackendConfig);
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = () => {};
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode('default');
  return { agent, surfaced };
}

/** codex's own approval request for one `automation_update` call. */
function automationUpdate(agent: CodexAgent, toolParams: Record<string, unknown>) {
  return (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    serverName: 'session',
    mode: 'form',
    message: CODEX_MESSAGE,
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: 'session',
      tool_description: 'Update an existing workspace automation by automationId.',
      tool_params: toolParams,
    },
    requestedSchema: { type: 'object', properties: {} },
  }) as Promise<Record<string, unknown>>;
}

describe('F1.778 · a codex floor card carries the floor sentence where the card renders it', () => {
  it('SIT-l E16: re-enabling a disabled bypass automation — description LEADS with the gate\'s own sentence', async () => {
    const toolParams = { automationId: 'sitl-nightly', patch: { enabled: true } };
    // The sentence Pi's and claude's card carry for the identical call: same
    // rule, same describer, so the three runtimes read one string.
    const edit = unattendedAutomationEdit('mcp__session__automation_update', toolParams, WORKSPACE_ROOT);
    expect(edit).toBeDefined();
    const gateSentence = describeUnattendedAutomationEdit(edit!);
    expect(gateSentence).toContain('runs unattended in bypassPermissions mode');

    const { agent, surfaced } = attendedAgent();
    const pending = automationUpdate(agent, toolParams);
    expect(surfaced).toHaveLength(1);
    const card = surfaced[0]!;
    expect(card.description.startsWith(gateSentence)).toBe(true);
    // Nothing codex said is hidden: its own question follows the floor's.
    expect(card.description).toContain(CODEX_MESSAGE);
    expect(card.noAlwaysAllow).toBe(true);
    agent.respondToPermission(card.requestId, false);
    expect((await pending).action).toBe('decline');
  });

  it('CONTROL: a no-op re-enable (already enabled) keeps codex\'s own text and its Always Allow', async () => {
    const toolParams = { automationId: 'sitl-live', patch: { enabled: true } };
    expect(unattendedAutomationEdit('mcp__session__automation_update', toolParams, WORKSPACE_ROOT)).toBeUndefined();
    const { agent, surfaced } = attendedAgent();
    const pending = automationUpdate(agent, toolParams);
    expect(surfaced).toHaveLength(1);
    const card = surfaced[0]!;
    expect(card.description).toBe(CODEX_MESSAGE);
    expect(card.noAlwaysAllow).toBe(false);
    agent.respondToPermission(card.requestId, false);
    expect((await pending).action).toBe('decline');
  });

  it('CONTROL: a non-floor edit of the same bypass automation (a rename) keeps codex\'s own text', async () => {
    const { agent, surfaced } = attendedAgent();
    const pending = automationUpdate(agent, { automationId: 'sitl-nightly', patch: { name: 'Renamed' } });
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.description).toBe(CODEX_MESSAGE);
    agent.respondToPermission(surfaced[0]!.requestId, false);
    expect((await pending).action).toBe('decline');
  });

  it('the same seam carries P2.140\'s removal floor: a codex `rm -rf ~` card leads with the floor sentence', async () => {
    const floor = firstNonNegotiableFloor(findNonNegotiableFloors('Bash', { command: HOME_RM }, 'default', {
      workspaceRootPath: WORKSPACE_ROOT,
      activeSourceSlugs: [],
      projectTrusted: false,
    }));
    expect(floor?.outcome).toBe('prompt');
    const { agent, surfaced } = attendedAgent();
    const pending = (agent as any).handleServerRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: HOME_RM, cwd: WORKSPACE_ROOT,
    }) as Promise<Record<string, unknown>>;
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.description.startsWith(floor!.description)).toBe(true);
    expect(surfaced[0]!.description).toContain(`Run: ${HOME_RM}`);
    agent.respondToPermission(surfaced[0]!.requestId, false);
    expect((await pending).decision).toBe('decline');
  });

  // F1.799 — F1.778 kept the floor's sentence appended to `reason` too, so the request carried it
  // twice. `reason` is read by the admin-approval card alone, and nothing else renders it, so it now
  // keeps codex's own cause (`MCP server: …`, codex's `reason`) and the sentence is said once.
  it('F1.799: a floor card\'s `reason` is exactly the one the same frame gets with no floor', async () => {
    const floored = attendedAgent();
    const pendingFloor = automationUpdate(floored.agent, { automationId: 'sitl-nightly', patch: { enabled: true } });
    const plain = attendedAgent();
    const pendingPlain = automationUpdate(plain.agent, { automationId: 'sitl-live', patch: { enabled: true } });
    const floorCard = floored.surfaced[0]!;
    const plainCard = plain.surfaced[0]!;
    // The floor fired on one and not the other, or this arm compares nothing.
    expect(floorCard.noAlwaysAllow).toBe(true);
    expect(plainCard.noAlwaysAllow).toBe(false);
    expect(plainCard.reason).toBe('MCP server: session');
    expect(floorCard.reason).toBe(plainCard.reason);
    floored.agent.respondToPermission(floorCard.requestId, false);
    plain.agent.respondToPermission(plainCard.requestId, false);
    expect((await pendingFloor).action).toBe('decline');
    expect((await pendingPlain).action).toBe('decline');
  });

  it('F1.799: the `rm -rf ~` floor card keeps codex\'s own `reason` as sent, the floor sentence only in `description`', async () => {
    const floor = firstNonNegotiableFloor(findNonNegotiableFloors('Bash', { command: HOME_RM }, 'default', {
      workspaceRootPath: WORKSPACE_ROOT,
      activeSourceSlugs: [],
      projectTrusted: false,
    }));
    const { agent, surfaced } = attendedAgent();
    const pending = (agent as any).handleServerRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: HOME_RM, cwd: WORKSPACE_ROOT,
      reason: 'clear the scratch folder',
    }) as Promise<Record<string, unknown>>;
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.description.startsWith(floor!.description)).toBe(true);
    expect(surfaced[0]!.reason).toBe('clear the scratch folder');
    agent.respondToPermission(surfaced[0]!.requestId, false);
    expect((await pending).decision).toBe('decline');
  });

  it('PREMISE: the ordinary permission card renders `description` — the field this suite pins', () => {
    const card = readFileSync(join(
      import.meta.dir, '../../../../../apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx',
    ), 'utf-8');
    expect(card).toContain('{request.description}');
  });
});
