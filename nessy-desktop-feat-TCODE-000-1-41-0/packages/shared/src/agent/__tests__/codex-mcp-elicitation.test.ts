/**
 * The Codex runtime's MCP tool-call approval.
 *
 * Live evidence (dev build, 2026-08-11, `MCP-W2`): a Codex session calling
 * `mcp__sources__plugin_cdp-echo-probe_echo__whoami` failed with
 * `TOOL-FAILED: user rejected MCP tool call` while `awaitingApprovalCount`
 * stayed 0 — nothing was ever shown to a user. The app-server named the cause:
 *
 *   ERROR codex_app_server::bespoke_event_handling: failed to deserialize
 *   McpServerElicitationRequestResponse: missing field `action`
 *
 * `handleServerRequest` answers `{}` to every method `isApprovalMethod` does
 * not know, and `mcpServer/elicitation/request` — the method codex-app-server
 * uses to ask for an MCP tool-call approval — was not on that list. `{}` has no
 * `action`, so the frame fails to deserialize and codex reads it as a rejection.
 *
 * Contract, from the generated protocol in `packages/codex-protocol`:
 *   McpServerElicitationRequestResponse = { action, content?, _meta? }
 *   McpServerElicitationAction          = "accept" | "decline" | "cancel"
 * Only `action` is required (`schema/McpServerElicitationRequestResponse.json`).
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  isApprovalMethod,
  approvalKindForMethod,
  buildApprovalResponse,
  buildAbortResponse,
  buildElicitationContent,
  mapElicitationApprovalToRequest,
  mapPermissionsApprovalToRequest,
  describeRequestedPermissions,
  MCP_ELICITATION_METHOD,
  PERMISSIONS_METHOD,
} from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/**
 * The params codex-app-server sends for an MCP tool-call approval, reduced to
 * the fields this bridge reads. The `approval_mode` property and its `approve`
 * option are the app-server's own approval form (`core/src/mcp_tool_call.rs`,
 * `mcp_tool_call_approval`); `__codex_mcp_decline` is its decline sentinel.
 */
function toolCallApprovalParams() {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    serverName: 'sources',
    mode: 'openai/form',
    message: 'Approve app tool call?',
    _meta: {
      tool_title: 'whoami',
      connector: 'cdp-echo-probe',
      tool_params_display: '{"nonce":"3838e8c49e87"}',
    },
    requestedSchema: {
      type: 'object',
      properties: {
        approval_mode: {
          type: 'string',
          oneOf: [
            { const: 'approve', title: 'Allow' },
            { const: '__codex_mcp_decline', title: 'Deny' },
          ],
        },
      },
      required: ['approval_mode'],
    },
  };
}

/**
 * P6.1073 · several cases here drive `handleServerRequest` with no
 * `onPermissionRequest`, which is the whole definition of UNATTENDED on that
 * path, and since P6.531 the unattended answer is decided by the operator
 * escape hatch. An inherited value would silently move those verdicts under
 * their assertions, so the shipped default is restored before every case and
 * the one body that needs a yes opens the hatch for itself.
 *
 * `delete`, never an assignment of `undefined`: a name Bun pre-created a slot
 * for stays readable by property and invisible to every spread (AGENTS.md
 * §Traps).
 */
beforeEach(() => {
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});

describe('codex MCP elicitation is a bridged approval method', () => {
  it('recognizes mcpServer/elicitation/request as an approval with its own kind', () => {
    expect(MCP_ELICITATION_METHOD).toBe('mcpServer/elicitation/request');
    expect(isApprovalMethod(MCP_ELICITATION_METHOD)).toBe(true);
    expect(approvalKindForMethod(MCP_ELICITATION_METHOD)).toBe('elicitation');
    // The methods already bridged keep their kinds.
    expect(approvalKindForMethod('item/fileChange/requestApproval')).toBe('fileChange');
    expect(approvalKindForMethod('item/commandExecution/requestApproval')).toBe('command');
  });

  it('builds a well-formed response for both decisions, never a bare {}', () => {
    const params = toolCallApprovalParams();
    expect(buildApprovalResponse('elicitation', params, true)).toEqual({
      action: 'accept',
      content: { approval_mode: 'approve' },
    });
    expect(buildApprovalResponse('elicitation', params, false)).toEqual({
      action: 'decline',
      content: null,
    });
    // The command/file-change families are untouched.
    expect(buildApprovalResponse('command', {}, true, true)).toEqual({ decision: 'acceptForSession' });
    expect(buildApprovalResponse('fileChange', {}, false)).toEqual({ decision: 'decline' });
  });

  /**
   * `alwaysAllow` has no elicitation spelling. codex persists an MCP tool
   * approval off the chosen option's metadata, which we do not echo, so the
   * frame is a plain single accept and the next call asks again — never
   * `acceptForSession`, which is not a member of the action enum.
   */
  it('degrades alwaysAllow to a single accept rather than inventing an action', () => {
    const response = buildApprovalResponse('elicitation', toolCallApprovalParams(), true, true);
    expect(response).toEqual({ action: 'accept', content: { approval_mode: 'approve' } });
    expect(Object.keys(response)).not.toContain('_meta');
  });

  it('never answers with the decline sentinel, and reads multi-select options under items', () => {
    expect(buildElicitationContent({
      type: 'object',
      properties: { approval_mode: { oneOf: [{ const: '__codex_mcp_decline' }, { const: 'approve' }] } },
    })).toEqual({ approval_mode: 'approve' });
    expect(buildElicitationContent({
      type: 'object',
      properties: { scope: { enum: ['thisServer', 'allServers'] }, confirmed: { type: 'boolean' } },
    })).toEqual({ scope: 'thisServer', confirmed: true });
    // A `default` is an answer like any other, and is held to the same guard.
    expect(buildElicitationContent({ type: 'object', properties: { note: { default: 'ok' } } })).toEqual({ note: 'ok' });
    expect(buildElicitationContent({
      type: 'object',
      properties: { pick: { default: '__codex_mcp_decline', enum: ['__codex_mcp_decline', 'approve'] } },
    })).toEqual({ pick: 'approve' });
    // McpElicitationTitled/UntitledMultiSelectEnumSchema: options live under
    // `items`, and the answer is an array.
    expect(buildElicitationContent({
      type: 'object',
      properties: {
        titled: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] } },
        untitled: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, minItems: 2 },
        // An explicit `minItems: 0` asks for nothing, so nothing is selected.
        optional: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, minItems: 0 },
      },
    })).toEqual({ titled: ['a'], untitled: ['x', 'y'], optional: [] });
    // No schema at all — the caller decides what that means.
    expect(buildElicitationContent(undefined)).toBeNull();
  });

  /**
   * `elicitation.ts:63-71` refuses a partial accept for the same reason: an
   * accept missing a required field is an invalid response to the server, and
   * the values would be ones the user never gave.
   */
  it('declines a form whose required fields it cannot fill, even when allowed', () => {
    const unfillable = {
      threadId: 't', serverName: 'sources', mode: 'form', message: 'Your API key?',
      requestedSchema: {
        type: 'object',
        properties: { api_key: { type: 'string' }, note: { type: 'string' } },
        required: ['api_key'],
      },
    };
    expect(buildApprovalResponse('elicitation', unfillable, true)).toEqual({ action: 'decline', content: null });
    // A form-mode request with no schema at all cannot be answered either.
    expect(buildApprovalResponse('elicitation', { mode: 'form', serverName: 'sources' }, true))
      .toEqual({ action: 'decline', content: null });
    // The same schema without the required marker still accepts what it can fill.
    expect(buildApprovalResponse('elicitation', {
      ...unfillable,
      requestedSchema: { type: 'object', properties: { flag: { type: 'boolean' } } },
    }, true)).toEqual({ action: 'accept', content: { flag: true } });
  });

  /**
   * Unattended, url mode still declines: opening a browser is a side effect
   * nobody asked for when there is no user at the keyboard. The interactive
   * path goes through the card instead (see the url-mode describe below).
   */
  it('declines url mode when there is no user to show it to', () => {
    const urlParams = {
      threadId: 't', serverName: 'sources', mode: 'url',
      message: 'Sign in to continue', url: 'https://example.invalid/oauth', elicitationId: 'e1',
    };
    expect(buildApprovalResponse('elicitation', urlParams, true)).toEqual({ action: 'decline', content: null });
    expect(buildApprovalResponse('elicitation', urlParams, false)).toEqual({ action: 'decline', content: null });
  });

  it('answers an aborted elicitation with cancel, and an aborted exec with a decision', () => {
    expect(buildAbortResponse('elicitation', toolCallApprovalParams())).toEqual({ action: 'cancel', content: null });
    expect(buildAbortResponse('command', {})).toEqual({ decision: 'decline' });
  });

  it('names the tool, its arguments and the server on the permission card', () => {
    const request = mapElicitationApprovalToRequest('r1', toolCallApprovalParams());
    expect(request).toMatchObject({ requestId: 'r1', toolName: 'whoami', noAlwaysAllow: true });
    expect(request.description).toBe('Approve app tool call?');
    expect(request.reason).toContain('sources');
    // `tool_params_display` is what the tool was called WITH; a blank subject
    // is what the live run rendered.
    expect(request.command).toBe('{"nonce":"3838e8c49e87"}');

    // Every field a card can render stays a non-empty string on the barest
    // payload there is — nothing may render literally "undefined".
    for (const params of [{ serverName: 'sources' }, {}, null, 'nonsense']) {
      const bare = mapElicitationApprovalToRequest('r2', params);
      for (const value of [bare.toolName, bare.description, bare.command]) {
        expect(typeof value).toBe('string');
        expect(value).not.toContain('undefined');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
    expect(mapElicitationApprovalToRequest('r3', { serverName: 'sources' }).toolName).toBe('sources');
  });
});

describe('CodexAgent.handleServerRequest answers the elicitation', () => {
  it('answers in a well-formed frame when no permission callback is attached', async () => {
    // This case asserted an ACCEPT until P6.531 (`61d6c51ca`) flipped the
    // unattended fallback: until then codex approved with nobody present while
    // Pi (`pi-agent.ts`'s fail-closed fallback) and claude
    // (`CAN_USE_TOOL_NO_SURFACE_DENIAL`) both refused, so the ABSENCE OF A HUMAN
    // widened what could run on exactly one runtime and nothing said so. The
    // operator escape hatch (`unattendedApprovalFallback`) defaults to deny, and
    // the whole mode x attendance matrix is owned by
    // `codex-approval-attendance-matrix.test.ts` rather than re-proved here.
    //
    // What THIS case pins is unchanged and is the reason it exists: an
    // elicitation with nobody to ask is ANSWERED, in the frame the protocol
    // expects, rather than left hanging — the accept shape with its filled
    // `approval_mode` is proved on the attended path in the case immediately
    // below, and again by `hides Always Allow`.
    const agent = new CodexAgent(createConfig());
    const result = await (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, toolCallApprovalParams());
    expect(result).toEqual({ action: 'decline', content: null });
  });

  it('surfaces the permission card and maps allow to accept', async () => {
    const agent = new CodexAgent(createConfig());
    let surfaced: Parameters<PermissionCallback>[0] | null = null;
    agent.onPermissionRequest = (request) => { surfaced = request; };

    const pending = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, toolCallApprovalParams());
    expect(surfaced).not.toBeNull();
    expect(surfaced!.toolName).toBe('whoami');

    agent.respondToPermission(surfaced!.requestId, true);
    expect(await pending).toEqual({ action: 'accept', content: { approval_mode: 'approve' } });
  });

  it('maps a denial to a well-formed decline', async () => {
    const agent = new CodexAgent(createConfig());
    let surfaced: Parameters<PermissionCallback>[0] | null = null;
    agent.onPermissionRequest = (request) => { surfaced = request; };

    const pending = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, toolCallApprovalParams());
    agent.respondToPermission(surfaced!.requestId, false);
    expect(await pending).toEqual({ action: 'decline', content: null });
  });

  it('declines in a well-formed frame when the approval never reaches a user', async () => {
    const agent = new CodexAgent(createConfig());
    agent.onPermissionRequest = () => { throw new Error('permission surface unavailable'); };
    const result = await (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, toolCallApprovalParams());
    expect(result).toEqual({ action: 'decline', content: null });
    expect((agent as any).pendingApprovals.size).toBe(0);
  });

  it('cancels pending elicitations on abort, and still answers exec approvals with a decision', async () => {
    const agent = new CodexAgent(createConfig());
    const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
    agent.onPermissionRequest = (request) => { surfaced.push(request); };

    const elicitation = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, toolCallApprovalParams());
    const exec = (agent as any).handleServerRequest('item/commandExecution/requestApproval', { command: 'ls' });
    expect(surfaced).toHaveLength(2);

    (agent as any).denyPendingApprovals();
    // An abort is a dialog that went away, not a user who said no.
    expect(await elicitation).toEqual({ action: 'cancel', content: null });
    expect(await exec).toEqual({ decision: 'decline' });
  });

  it('hides Always Allow, which neither side can honour for an elicitation', async () => {
    const agent = new CodexAgent(createConfig());
    let surfaced: Parameters<PermissionCallback>[0] | null = null;
    agent.onPermissionRequest = (request) => { surfaced = request; };

    const pending = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, toolCallApprovalParams());
    expect(surfaced!.noAlwaysAllow).toBe(true);
    expect(surfaced!.command).toBe('{"nonce":"3838e8c49e87"}');

    // Even if the button were pressed, the frame stays a single accept.
    agent.respondToPermission(surfaced!.requestId, true, true);
    expect(await pending).toEqual({ action: 'accept', content: { approval_mode: 'approve' } });
  });

  /**
   * A degraded Allow looks exactly like the original defect from the outside —
   * a rejection nobody chose — so the branch that caused it has to be named.
   */
  it('names the branch in the log when an Allow degrades to a decline', async () => {
    // url mode is NOT here: it now has a card and an opener of its own, and
    // exercising it through the default opener would launch a real browser.
    const cases = [
      {
        reason: 'unfillable required [api_key]',
        params: {
          serverName: 'sources', mode: 'form', message: 'Your API key?',
          requestedSchema: { type: 'object', properties: { api_key: { type: 'string' } }, required: ['api_key'] },
        },
      },
      { reason: 'no form schema', params: { serverName: 'sources', mode: 'form', message: 'Hello?' } },
    ];

    for (const { reason, params } of cases) {
      const agent = new CodexAgent(createConfig());
      const debug: string[] = [];
      agent.onDebug = (message) => { debug.push(message); };
      let surfaced: Parameters<PermissionCallback>[0] | null = null;
      agent.onPermissionRequest = (request) => { surfaced = request; };

      const pending = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, params);
      agent.respondToPermission(surfaced!.requestId, true);

      expect(await pending).toEqual({ action: 'decline', content: null });
      expect(debug).toEqual([`codex elicitation allow degraded to decline: ${reason}`]);
    }
  });

  it('says nothing when the Allow is honoured, or when the user declined', async () => {
    const agent = new CodexAgent(createConfig());
    const debug: string[] = [];
    agent.onDebug = (message) => { debug.push(message); };
    let surfaced: Parameters<PermissionCallback>[0] | null = null;
    agent.onPermissionRequest = (request) => { surfaced = request; };

    const allowed = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, toolCallApprovalParams());
    agent.respondToPermission(surfaced!.requestId, true);
    expect(await allowed).toEqual({ action: 'accept', content: { approval_mode: 'approve' } });

    const denied = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, toolCallApprovalParams());
    agent.respondToPermission(surfaced!.requestId, false);
    expect(await denied).toEqual({ action: 'decline', content: null });

    expect(debug.filter(line => line.includes('degraded'))).toEqual([]);
  });

  it('still answers a genuinely unknown server method with the empty JSON-RPC result', async () => {
    const agent = new CodexAgent(createConfig());
    agent.onPermissionRequest = () => { throw new Error('must not be surfaced'); };
    // Not in `ServerRequest` at all — the generic empty result is all we can say.
    expect(await (agent as any).handleServerRequest('some/methodFromALaterProtocol', {})).toEqual({});
  });
});

/**
 * URL-mode elicitation — the client opens a browser URL for the user.
 *
 * ACCEPT SEMANTICS, from the bundled app-server: url mode is the only mode
 * whose params carry a required `elicitationId`, and the binary implements the
 * MCP notification `notifications/elicitation/complete` with
 * `ElicitationResponseNotificationParam` carrying exactly that one field. The
 * server therefore announces completion out-of-band, keyed by the id — so the
 * JSON-RPC response cannot be what reports it, and `accept` means "the client
 * accepted the request and opened the URL", not "the user finished the flow".
 *
 * This is a DELIBERATE divergence from the Pi flow's second dialog
 * (`handleUrlElicitation`, `mcp.md:1089` — "Complete the flow in the browser,
 * then confirm in the CLI"). Claude Code has no completion notification, so it
 * has to ask; codex has one, and holding the response open until a human
 * confirms would block a turn on an answer codex is not waiting for. The safety
 * half of Pi's flow is NOT diverged from: the same `safeHttpUrl` gate, and a
 * refusal that is never silent.
 */
function urlParams(url = 'https://example.invalid/oauth?state=abc') {
  return {
    threadId: 'thread-1', turnId: 'turn-1', serverName: 'sources', mode: 'url',
    message: 'Sign in to continue', url, elicitationId: 'elicit-1',
  };
}

describe('codex url elicitation opens for the user', () => {
  function agentWithOpener() {
    const agent = new CodexAgent(createConfig());
    const opened: string[] = [];
    const debug: string[] = [];
    agent.onDebug = (message) => { debug.push(message); };
    (agent as any).openExternalUrl = async (url: string) => { opened.push(url); };
    let surfaced: Parameters<PermissionCallback>[0] | null = null;
    agent.onPermissionRequest = (request) => { surfaced = request; };
    return { agent, opened, debug, card: () => surfaced };
  }

  it('shows the user where they are being sent, then opens it on allow', async () => {
    const { agent, opened, card } = agentWithOpener();
    const pending = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, urlParams());

    // The URL is the subject of the card: consent to a link nobody can read is
    // not consent.
    expect(card()!.command).toBe('https://example.invalid/oauth?state=abc');
    expect(card()!.description).toContain('Sign in to continue');
    expect(card()!.noAlwaysAllow).toBe(true);
    expect(opened).toEqual([]);

    agent.respondToPermission(card()!.requestId, true);
    expect(await pending).toEqual({ action: 'accept', content: null });
    expect(opened).toEqual(['https://example.invalid/oauth?state=abc']);
  });

  it('never opens, and never accepts, on a scheme the gate refuses', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'obsidian://open?x=1', 'not a url']) {
      const { agent, opened, debug, card } = agentWithOpener();
      const result = await (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, urlParams(url));
      expect(result).toEqual({ action: 'decline', content: null });
      expect(opened).toEqual([]);
      // Refused before anything is shown — and never silently.
      expect(card()).toBeNull();
      expect(debug).toEqual(['codex elicitation allow degraded to decline: url-mode refused: not an http(s) url']);
    }
  });

  it('declines when the browser could not be opened, never accepts anyway', async () => {
    const { agent, debug, card } = agentWithOpener();
    (agent as any).openExternalUrl = async () => { throw new Error('no browser'); };
    const pending = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, urlParams());
    agent.respondToPermission(card()!.requestId, true);
    expect(await pending).toEqual({ action: 'decline', content: null });
    expect(debug).toEqual(['codex elicitation allow degraded to decline: url-mode could not open the browser: no browser']);
  });

  it('does not open the browser when the user says no', async () => {
    const { agent, opened, card } = agentWithOpener();
    const pending = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, urlParams());
    agent.respondToPermission(card()!.requestId, false);
    expect(await pending).toEqual({ action: 'decline', content: null });
    expect(opened).toEqual([]);
  });

  it('does not launch a browser on an unattended session', async () => {
    // P6.1073 — THE HATCH IS OPENED HERE, because the sentence this case is
    // named for is "an APPROVAL must not mean an auto-launch" and since P6.531
    // an unattended turn no longer produces one: at the shipped default the
    // request is refused by the fallback ABOVE the url branch, so `opened` stays
    // empty for a reason that has nothing to do with the url guard. With the
    // hatch open the fallback says yes — the debug line is asserted so that is
    // not taken on trust — and `buildApprovalResponse` still declines a url-mode
    // elicitation nobody can be shown, opening nothing.
    const agent = new CodexAgent(createConfig());
    const opened: string[] = [];
    const debug: string[] = [];
    agent.onDebug = (message) => { debug.push(message); };
    (agent as any).openExternalUrl = async (url: string) => { opened.push(url); };
    // No permission callback: headless.
    const previous = process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
    delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    try {
      expect(await (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, urlParams()))
        .toEqual({ action: 'decline', content: null });
      expect(opened).toEqual([]);
      expect(debug.some(line => line.includes('auto-approved headless by the operator escape hatch'))).toBe(true);
    } finally {
      delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
      if (previous !== undefined) process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = previous;
    }
  });

  it('refuses the same unattended url elicitation at the shipped default, before the url branch', async () => {
    // P6.1073 / P6.531 · the shipped default, hatch shut — what a user actually
    // meets, and the arm that keeps the case above honest: the same call, the
    // same empty `opened`, a DIFFERENT reason. Without this pair the case above
    // would pass against a build whose url guard had been deleted.
    const agent = new CodexAgent(createConfig());
    const opened: string[] = [];
    const debug: string[] = [];
    agent.onDebug = (message) => { debug.push(message); };
    (agent as any).openExternalUrl = async (url: string) => { opened.push(url); };

    expect(await (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, urlParams()))
      .toEqual({ action: 'decline', content: null });
    expect(opened).toEqual([]);
    expect(debug.some(line => line.includes('refused headless: no rule and no floor covered'))).toBe(true);
  });

  it('cancels an in-flight url elicitation on abort without opening anything', async () => {
    const { agent, opened, card } = agentWithOpener();
    const pending = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, urlParams());
    expect(card()).not.toBeNull();
    (agent as any).denyPendingApprovals();
    expect(await pending).toEqual({ action: 'cancel', content: null });
    expect(opened).toEqual([]);
  });
});

/**
 * `item/permissions/requestApproval` — codex's own `request_permissions` tool
 * (`core/src/tools/handlers/request_permissions.rs`) asking to widen the turn's
 * sandbox. It has always been in `isApprovalMethod`, so it surfaced a card and
 * the user answered; the bridge then replied `{decision}`, which
 * `schema/PermissionsRequestApprovalResponse.json` does not define — its one
 * required field is `permissions`. codex discarded the human decision exactly
 * as it discarded the elicitation answer, and for the same reason:
 * `failed to deserialize PermissionsRequestApprovalResponse` sits beside the
 * elicitation error in `app-server/src/bespoke_event_handling.rs`.
 */
function permissionsParams(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: 1_770_000_000_000,
    cwd: '/tmp/project-root', environmentId: null,
    reason: 'needs the network to fetch the schema',
    permissions: {
      network: { enabled: true },
      fileSystem: { read: ['/tmp/project-root/src'], write: ['/tmp/project-root/out'] },
    },
    ...overrides,
  };
}

describe('codex permissions approval carries the granted profile', () => {
  it('is its own approval kind', () => {
    expect(PERMISSIONS_METHOD).toBe('item/permissions/requestApproval');
    expect(isApprovalMethod(PERMISSIONS_METHOD)).toBe(true);
    expect(approvalKindForMethod(PERMISSIONS_METHOD)).toBe('permissions');
  });

  /**
   * An Allow grants exactly what was asked, at the narrower of the two
   * documented scopes. The paths are echoed verbatim because the app-server
   * validates them and interrupts the turn on invalid ones — the only paths
   * safe to grant are the ones it just sent.
   */
  it('grants exactly what was requested, at scope turn, never widened', () => {
    const params = permissionsParams();
    expect(buildApprovalResponse('permissions', params, true)).toEqual({
      permissions: params.permissions,
      scope: 'turn',
    });
    // alwaysAllow must not promote the grant to session scope.
    expect(buildApprovalResponse('permissions', params, true, true)).toEqual({
      permissions: params.permissions,
      scope: 'turn',
    });
    // A half-empty request grants only the half that was asked for.
    expect(buildApprovalResponse('permissions', permissionsParams({
      permissions: { network: { enabled: true }, fileSystem: null },
    }), true)).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
  });

  /**
   * `GrantedPermissionProfile` has no required properties, so `{}` is a
   * well-formed profile that grants nothing — the only denial this response
   * shape can express, since it carries no decision field at all.
   */
  it('denies by granting nothing, and never grants on abort', () => {
    expect(buildApprovalResponse('permissions', permissionsParams(), false)).toEqual({
      permissions: {}, scope: 'turn',
    });
    expect(buildAbortResponse('permissions', permissionsParams())).toEqual({
      permissions: {}, scope: 'turn',
    });
  });

  it('names the ungrantable part of an Allow instead of dropping it silently', () => {
    const degraded: string[] = [];
    const response = buildApprovalResponse('permissions', permissionsParams({
      permissions: { network: { enabled: true }, futureCapability: { enabled: true } },
    }), true, false, reason => degraded.push(reason));
    expect(response).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(degraded).toEqual(['permissions allow degraded to a partial grant: ungrantable [futureCapability]']);

    const noProfile: string[] = [];
    expect(buildApprovalResponse('permissions', { cwd: '/tmp' }, true, false, r => noProfile.push(r)))
      .toEqual({ permissions: {}, scope: 'turn' });
    expect(noProfile).toEqual(['permissions allow degraded to an empty grant: request carried no profile']);
  });

  it('shows what is being approved, where the card used to say "shell"', () => {
    const request = mapPermissionsApprovalToRequest('r1', permissionsParams());
    expect(request).toMatchObject({ requestId: 'r1', toolName: 'request_permissions', noAlwaysAllow: true });
    expect(request.command).toBe('network access; read /tmp/project-root/src; write /tmp/project-root/out');
    expect(request.description).toContain('network access');
    expect(request.reason).toBe('needs the network to fetch the schema');

    expect(describeRequestedPermissions(permissionsParams({
      permissions: {
        fileSystem: {
          entries: [
            { access: 'write', path: { type: 'path', path: '/tmp/x' } },
            { access: 'read', path: { type: 'glob_pattern', pattern: '**/*.ts' } },
            { access: 'read', path: { type: 'special', value: { kind: 'tmpdir' } } },
          ],
        },
      },
    }))).toBe('write /tmp/x; read **/*.ts; read tmpdir');

    // Nothing renders blank or "undefined" on a bare payload.
    for (const params of [{}, null, { permissions: {} }]) {
      const bare = mapPermissionsApprovalToRequest('r2', params);
      for (const value of [bare.toolName, bare.description, bare.command]) {
        expect(typeof value).toBe('string');
        expect(value).not.toContain('undefined');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('round-trips a human decision through the seam', async () => {
    for (const [allowed, expected] of [
      [true, { permissions: permissionsParams().permissions, scope: 'turn' }],
      [false, { permissions: {}, scope: 'turn' }],
    ] as const) {
      const agent = new CodexAgent(createConfig());
      let surfaced: Parameters<PermissionCallback>[0] | null = null;
      agent.onPermissionRequest = (request) => { surfaced = request; };

      const pending = (agent as any).handleServerRequest(PERMISSIONS_METHOD, permissionsParams());
      expect(surfaced!.toolName).toBe('request_permissions');
      agent.respondToPermission(surfaced!.requestId, allowed);
      expect(await pending).toEqual(expected);
    }
  });
});

/**
 * PINNED INVENTORY — every server→client method the app-server can send, and
 * the frame we answer it with, checked against that method's `*Response.json`.
 *
 * Two of them are answered by a permission card (the legacy v1 approvals, whose
 * decision vocabulary is NOT the v2 one). Two are answered with the schema's
 * own refusal shape, because we do not implement the feature and a well-formed
 * "no" beats a fabricated answer. Two are deliberately left `{}` — their
 * responses have no refusal form at all, and the only alternative to failing is
 * forging a credential.
 */
describe('server methods we do not implement: answered, not garbled', () => {
  const answered: Array<{ method: string; requires: string[]; expected: Record<string, unknown>; degraded: string }> = [
    // P6.344 · `item/tool/requestUserInput` USED TO SIT HERE, and it does not
    // belong in a "we do not implement this" table any more:
    // `CodexAgent.handleCodexRequestUserInput` raises the same card Pi and
    // claude raise and answers by question id. Its round trip and its four
    // decline paths are pinned in
    // `__tests__/codex-request-user-input.test.ts`; the case below keeps the one
    // fact this suite still owns about it.
    {
      // A dynamic tool call, for tools a client registers. We register none, so
      // the honest answer is the schema's own failure shape.
      method: 'item/tool/call',
      requires: ['contentItems', 'success'],
      expected: {
        success: false,
        contentItems: [{ type: 'inputText', text: 'This client does not implement dynamic tool calls.' }],
      },
      degraded: 'item/tool/call refused: no dynamic tool is registered by this client',
    },
  ];

  for (const { method, requires, expected, degraded } of answered) {
    it(`${method} answers with its required ${requires.join(' + ')}`, async () => {
      const agent = new CodexAgent(createConfig());
      const debug: string[] = [];
      agent.onDebug = (message) => { debug.push(message); };
      agent.onPermissionRequest = () => { throw new Error('not an approval method — must not surface a card'); };

      expect(isApprovalMethod(method)).toBe(false);
      expect(await (agent as any).handleServerRequest(method, { toolName: 'x' })).toEqual(expected);
      for (const field of requires) expect(Object.keys(expected)).toContain(field);
      expect(debug).toEqual([`codex ${degraded}`]);
    });
  }

  /**
   * P6.344 — the one fact about `item/tool/requestUserInput` that still belongs
   * to THIS suite: it is not an approval method, so it must never take the
   * approval path, whatever answers it.
   */
  it('item/tool/requestUserInput is not an approval method, and never was', () => {
    expect(isApprovalMethod('item/tool/requestUserInput')).toBe(false);
  });

  /**
   * DELIBERATELY `{}` — a decision, not an oversight.
   *
   * Both responses consist entirely of required credential strings, and
   * neither schema has a refusal form. There is nothing honest to send: any
   * value we invent is a forged credential the app-server would then USE. A
   * response it cannot deserialize is a visible failure; a fabricated token is
   * a silent lie, and the failure it causes surfaces somewhere else entirely.
   */
  const keptEmpty: Array<{ method: string; requires: string[]; why: string }> = [
    {
      method: 'account/chatgptAuthTokens/refresh',
      requires: ['accessToken', 'chatgptAccountId'],
      why: 'would have to forge a ChatGPT access token; the gateway path never authenticates this way',
    },
    {
      method: 'attestation/generate',
      requires: ['token'],
      why: 'would have to forge an x-oai-attestation token; we also decline the capability at initialize',
    },
  ];

  for (const { method, requires, why } of keptEmpty) {
    it(`${method} stays {} on purpose — ${why}`, async () => {
      const agent = new CodexAgent(createConfig());
      agent.onPermissionRequest = () => { throw new Error('not an approval method — must not surface a card'); };
      expect(isApprovalMethod(method)).toBe(false);
      expect(await (agent as any).handleServerRequest(method, {})).toEqual({});
      // Named so the decision is visible rather than looking like the gap it used to be.
      expect(requires.length).toBeGreaterThan(0);
    });
  }
});

/**
 * The legacy v1 approvals. Their `ReviewDecision` enum is NOT the v2 one:
 * `approved` / `approved_for_session` / `{denied: {rejection}}` / `timed_out` /
 * `abort`, so answering them with the v2 `accept`/`decline` would be as
 * unparseable as `{}`. Whether the bundled app-server still emits them under
 * `experimentalApi` was not proved either way — they are declared in
 * `ServerRequest`, so they are answered correctly for the cost of a switch arm.
 *
 * `denied` became an OBJECT variant in `rust-v0.147.0` (it was a bare string
 * through `rust-v0.142.5`); the bare string no longer deserializes, so this
 * asserts the object shape.
 */
describe('legacy v1 approvals speak the v1 decision vocabulary', () => {
  it('maps allow / always / deny / abort onto ReviewDecision', () => {
    for (const kind of ['commandV1', 'fileChangeV1'] as const) {
      expect(buildApprovalResponse(kind, {}, true)).toEqual({ decision: 'approved' });
      expect(buildApprovalResponse(kind, {}, true, true)).toEqual({ decision: 'approved_for_session' });
      expect(buildApprovalResponse(kind, {}, false)).toEqual({
        decision: { denied: { rejection: 'The user declined this action.' } },
      });
      expect(buildAbortResponse(kind, {})).toEqual({ decision: 'abort' });
    }
    // The v2 twins keep their own vocabulary.
    expect(buildApprovalResponse('command', {}, true)).toEqual({ decision: 'accept' });
    expect(buildApprovalResponse('fileChange', {}, true, true)).toEqual({ decision: 'acceptForSession' });
  });

  /**
   * P6.1 — `rejection` is the only field in either protocol version where a
   * refusal can say why, and it used to be a fixed sentence attributing every
   * refusal to a person. A floor denial, a permission-rule denial and a
   * `dontAsk` denial were all reported as "The user declined this action."
   *
   * KILLS: dropping the parameter, or forwarding it on the wrong argument.
   */
  it('a v1 denial carries the reason that actually refused it', () => {
    for (const kind of ['commandV1', 'fileChangeV1'] as const) {
      expect(buildApprovalResponse(kind, {}, false, undefined, undefined, 'Denied by permission rule "session-2" (workspace).'))
        .toEqual({ decision: { denied: { rejection: 'Denied by permission rule "session-2" (workspace).' } } });
    }
  });

  /**
   * The default is still the sentence it describes — a person saying no — and a
   * blank reason must not replace a true sentence with nothing.
   *
   * KILLS: making the parameter required, or letting `''` through.
   */
  it('falls back to the human sentence when no reason is supplied', () => {
    expect(buildApprovalResponse('commandV1', {}, false))
      .toEqual({ decision: { denied: { rejection: 'The user declined this action.' } } });
    expect(buildApprovalResponse('commandV1', {}, false, undefined, undefined, '   '))
      .toEqual({ decision: { denied: { rejection: 'The user declined this action.' } } });
  });

  /**
   * THE MEASURED RESIDUE, pinned so it is not mistaken for an oversight. The v2
   * approval responses have NO field for a reason —
   * `CommandExecutionApprovalDecision::Decline` and its file-change twin are
   * bare enum members at `rust-v0.148.0`, and codex's own
   * `From<CoreReviewDecision>` drops the `rejection` when it converts. So a
   * refusal of ours on the v2 path reaches the model as one word, and no
   * host-side change can alter that.
   *
   * KILLS: inventing a `reason`/`rejection` key on the v2 response, which the
   * server would reject as an unknown field.
   */
  it('a v2 refusal has nowhere to carry a reason, and does not invent one', () => {
    expect(buildApprovalResponse('command', {}, false, undefined, undefined, 'Denied by permission rule "session-2".'))
      .toEqual({ decision: 'decline' });
    expect(buildApprovalResponse('fileChange', {}, false, undefined, undefined, 'Denied by a floor.'))
      .toEqual({ decision: 'decline' });
  });

  it('surfaces a card naming the command or the files', async () => {
    const agent = new CodexAgent(createConfig());
    const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
    agent.onPermissionRequest = (request) => { surfaced.push(request); };

    expect(approvalKindForMethod('execCommandApproval')).toBe('commandV1');
    expect(approvalKindForMethod('applyPatchApproval')).toBe('fileChangeV1');
    expect(isApprovalMethod('execCommandApproval')).toBe(true);
    expect(isApprovalMethod('applyPatchApproval')).toBe(true);

    const exec = (agent as any).handleServerRequest('execCommandApproval', {
      callId: 'c1', conversationId: 't1', cwd: '/tmp/p', command: ['rm', '-rf', 'build'], parsedCmd: [],
      reason: 'clean the tree',
    });
    const patch = (agent as any).handleServerRequest('applyPatchApproval', {
      callId: 'c2', conversationId: 't1', grantRoot: '/tmp/p', fileChanges: { '/tmp/p/a.ts': {} },
    });

    // `command` arrives as argv on v1, not as a string.
    expect(surfaced[0]!.command).toBe('rm -rf build');
    expect(surfaced[0]!.description).toContain('rm -rf build');
    expect(surfaced[0]!.reason).toBe('clean the tree');
    expect(surfaced[1]!.description).toContain('/tmp/p');

    agent.respondToPermission(surfaced[0]!.requestId, true);
    agent.respondToPermission(surfaced[1]!.requestId, false);
    expect(await exec).toEqual({ decision: 'approved' });
    expect(await patch).toEqual({
      decision: { denied: { rejection: 'The user declined this action.' } },
    });
  });
});
