/**
 * F1.218 (origin WJ-v P-WJ-v-4) — what `CodexAgent` answers, per permission
 * mode, to the MCP tool-call approval codex raises before a pool tool call.
 *
 * ## The request, read at the pinned tag and measured on the shipped binary
 *
 * `openai/codex@rust-v0.154.0` (`packages/codex-protocol/manifest.json`),
 * `core/src/mcp_tool_call.rs`: a regular MCP server's tool runs in
 * `AppToolApproval::Auto` unless its config says otherwise (we write no
 * `approval_mode` / `default_tools_approval_mode` for `[mcp_servers.sources]`),
 * and `requires_mcp_tool_approval` asks for EVERY tool whose annotations do not
 * carry `readOnlyHint: true`. The only auto-approve is
 * `mcp_permission_prompt_is_auto_approved` (`codex-mcp/src/mcp/mod.rs`), which
 * needs `approval_policy = never` AND a full-disk-write profile — and the host
 * writes `on-request` for every mode with the sandbox master switch off (the
 * product default). So the request is not a bypass leak on codex's side: it is
 * codex asking its client, and the CLIENT's answer is where the mode lives. It
 * arrives as `mcpServer/elicitation/request` because `ToolCallMcpElicitation`
 * is on; its accept is parsed by `parse_mcp_tool_approval_elicitation_response`
 * — an `accept` with no `persist` in its `_meta` and no answer in its content
 * resolves to `ReviewDecision::Approved`, a `decline` to "user rejected MCP tool
 * call".
 *
 * {@link MEASURED_FRAME} is copied from the shipped `codex-app-server` on
 * 2026-09-23 (a probe over the real pool server, the real config writer and the
 * real Responses adapter, the same rig as `mcp/__tests__/codex-model-tool-name-live.test.ts`):
 * identical in `bypassPermissions`, `default` and `dontAsk`; answering it with
 * the product's own accept frame completed the call and reached the fixture in
 * all three; a tool annotated `readOnlyHint: true` raised NO request at all.
 *
 * ## The verdict this file pins — a READING, not a fix
 *
 * - `bypassPermissions`, attended: accepted synchronously, no card
 *   (`handleServerRequest`'s P6.61 branch — no floor matches an elicitation,
 *   `codexApprovalFloorSubjects` returns `[]` for the kind).
 * - `dontAsk`, attended: declined, no card (R13).
 * - every other mode, attended: ONE card through the host's permission channel,
 *   answered by `respondToPermission` into the frame codex parses.
 * - UNATTENDED (no `onPermissionRequest`), every mode: refused by P6.531's
 *   fallback before the bypass answer is reached, and accepted only when the
 *   operator opens `unattendedApprovalFallback`. It never hangs. Production has
 *   no such codex session — `SessionManager` assigns `onPermissionRequest` on
 *   the line after `createAgent()` — so this is stated, not changed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';
import type { PermissionMode } from '../mode-types.ts';

const WORKSPACE_ROOT = '/tmp/nessy-codex-f1218-ws';

/** The frame the shipped binary sent (ids trimmed), byte-for-byte in every other field. */
const MEASURED_FRAME = {
  threadId: 'thread-f1218',
  turnId: 'turn-f1218',
  serverName: 'sources',
  mode: 'form',
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    persist: ['session', 'always'],
    tool_description: 'Answers who it is.',
    tool_params: {},
    tool_params_display: [],
  },
  message: 'Allow the sources MCP server to run tool "plugin_cdp-echo-probe_echo__whoami"?',
  requestedSchema: { type: 'object', properties: {} },
} as const;

/** The transcript row's name for the same call — codex's raw `(server, tool)` pair. */
const HOST_ROW_NAME = 'mcp__sources__plugin_cdp-echo-probe_echo__whoami';

/** The two answers codex parses: accept → Approved, decline → "user rejected MCP tool call". */
const ACCEPT = { action: 'accept', content: {} };
const DECLINE = { action: 'decline', content: null };

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1218',
      name: 'F1.218 Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: '/tmp/nessy-codex-f1218-sessions/ws-f1218',
    } as any,
    session: {
      id: 'session-f1218',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/nessy-codex-f1218-project',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** A session in `mode`; attended means a host permission channel is wired, as `SessionManager` wires it. */
function session(mode: PermissionMode, attended: boolean) {
  const agent = new CodexAgent(createConfig());
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = () => {};
  if (attended) agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode(mode);
  agent.getPermissionManager().setCapabilityPermissionLayers([], 'generation-f1218', true);
  const answer = (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, structuredClone(MEASURED_FRAME)) as
    Record<string, unknown> | Promise<Record<string, unknown>>;
  return { agent, surfaced, answer };
}

/**
 * P6.1073's rule for every suite that drives the unattended path: the shipped
 * default is restored before each case, never inherited — and after each, so
 * the one case that opens the hatch cannot leak it into a later file of the
 * same process (CI runs a directory per process).
 */
beforeEach(() => {
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});
afterEach(() => {
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});

describe('F1.218 — the codex MCP tool-call approval, answered per mode (attended)', () => {
  it('bypassPermissions accepts it synchronously and shows no card', async () => {
    const { surfaced, answer } = session('bypassPermissions', true);
    // Synchronous: nothing waits, so a bypass turn cannot stall on this request.
    expect(answer).not.toBeInstanceOf(Promise);
    expect(await answer).toEqual(ACCEPT);
    expect(surfaced).toEqual([]);
  });

  it('dontAsk declines it and shows no card', async () => {
    const { surfaced, answer } = session('dontAsk', true);
    expect(await answer).toEqual(DECLINE);
    expect(surfaced).toEqual([]);
  });

  // `plan` and `explore` left this loop with F1.374: a pool WRITE tool is now
  // REFUSED there, with Pi's own "MCP write operations are blocked" sentence
  // (`codex-read-only-mode-session-tool.test.ts` pins it, and pins that a pool
  // tool the workspace marks read-only keeps this card).
  for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
    it(`${mode} puts ONE card on the host's permission channel and waits for the person`, async () => {
      const { agent, surfaced, answer } = session(mode, true);
      expect(answer).toBeInstanceOf(Promise);
      expect(surfaced).toHaveLength(1);
      // The host's way: the card is filed under the name the transcript row
      // gives the same call (codex's raw pair), not under the bridge. At
      // rust-v0.154.0 the frame carries no `tool_title` and an ARRAY
      // `tool_params_display`, and until the F1.218 follow-up the card read
      // `sources` with only its sentence naming the tool.
      expect(surfaced[0]).toMatchObject({
        toolName: HOST_ROW_NAME,
        command: HOST_ROW_NAME,
        description: MEASURED_FRAME.message,
        origin: 'codex_approval',
        noAlwaysAllow: false, // F1.372 — Always Allow, on the host's remember record (codex-mcp-card-always-allow.test.ts)
      });
      agent.respondToPermission(surfaced[0]!.requestId, true);
      expect(await answer).toEqual(ACCEPT);
    });
  }

  it('the card shows what the tool was called WITH, from the 0.154 display ARRAY', () => {
    const agent = new CodexAgent(createConfig());
    const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
    agent.onDebug = () => {};
    agent.onPermissionRequest = (request) => { surfaced.push(request); };
    // `default`, named: a fresh agent's mode is a read-only one, where F1.374
    // refuses this write tool before any card is built.
    agent.setPermissionMode('default');
    agent.getPermissionManager().setCapabilityPermissionLayers([], 'generation-f1218', true);
    const frame = structuredClone(MEASURED_FRAME) as unknown as { _meta: Record<string, unknown> };
    frame._meta.tool_params = { nonce: '3838e8c49e87', count: 2 };
    frame._meta.tool_params_display = [
      { name: 'nonce', value: '3838e8c49e87', display_name: 'nonce' },
      { name: 'count', value: 2, display_name: 'count' },
    ];
    void (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, frame);
    expect(surfaced[0]).toMatchObject({ toolName: HOST_ROW_NAME, command: 'nonce: 3838e8c49e87, count: 2' });
  });

  it('a person\'s refusal in default becomes the decline codex reads as a rejection', async () => {
    const { agent, surfaced, answer } = session('default', true);
    agent.respondToPermission(surfaced[0]!.requestId, false);
    expect(await answer).toEqual(DECLINE);
  });
});

describe('F1.218 — unattended (no permission channel): refused, never hung', () => {
  for (const mode of ['bypassPermissions', 'default', 'dontAsk'] as const) {
    it(`${mode} refuses it synchronously under the shipped fallback`, async () => {
      const { surfaced, answer } = session(mode, false);
      expect(answer).not.toBeInstanceOf(Promise);
      expect(await answer).toEqual(DECLINE);
      expect(surfaced).toEqual([]);
    });
  }

  /** CONTROL: the refusal above is the fallback's, not the frame's — opening the hatch accepts the same frame. */
  it('bypassPermissions accepts it once the operator opens unattendedApprovalFallback', async () => {
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    const { answer } = session('bypassPermissions', false);
    expect(await answer).toEqual(ACCEPT);
  });
});
