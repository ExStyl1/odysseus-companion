/**
 * F1.234 (origin WJ-l P-WJ-l-7) — in `plan` (a stored `explore` reads as it), a session-configuration
 * tool is REFUSED on codex, with the sentence claude and Pi refuse it with.
 *
 * ## The divergence
 *
 * On claude and Pi the pre-tool gate's first step is `shouldAllowToolInMode`
 * (`core/pre-tool-use.ts`), and for `mcp__session__automation_update` in a
 * read-only mode it answers `allowed: false` with *"Session configuration
 * changes are blocked in Plan. …"* — a refusal, no card. On codex the same
 * call reaches the host as codex's own MCP tool-call approval
 * (`mcpServer/elicitation/request`, `_meta.codex_approval_kind =
 * "mcp_tool_call"`; `core/src/mcp_tool_call.rs` at `rust-v0.154.0` asks for
 * every tool without `readOnlyHint`, and codex's plan config is
 * `on-request`), and until this row `handleServerRequest` put a card in front
 * of the person — so a read-only mode ASKED on one runtime and REFUSED on two.
 *
 * ## What reaches whom, stated
 *
 * The refusal is a `decline`, and codex tells its model the fixed
 * *"user rejected MCP tool call"* (`parse_mcp_tool_approval_elicitation_response`
 * — the elicitation response has no reason channel at the pinned tag); the
 * mode-block sentence goes to the debug log, which is what these arms read.
 * `PermissionDenied` is NOT minted: Pi mints it for the guardian and `dontAsk`
 * causes only, never for an ordinary gate block (`emitCodexPermissionDeniedHook`).
 *
 * The request is built in the shape the shipped binary sends
 * (`codex-mcp-tool-approval-modes.test.ts`'s measured frame, re-pointed at the
 * `session` server), and the arms drive the REAL `handleServerRequest`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { getSessionToolRegistry, getToolDefsAsJsonSchema } from '@nessy-agent/session-tools-core';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';
import type { PermissionMode } from '../mode-types.ts';

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'wjhh-f1234-'));
/**
 * F1.374 — a second workspace whose `permissions.json` marks the pool tool
 * read-only (`allowedMcpPatterns`), the one way a pool tool passes the mode
 * block on claude and Pi.
 */
const READ_ONLY_MARKED_ROOT = mkdtempSync(join(tmpdir(), 'wjrr-f1374-'));
writeFileSync(join(READ_ONLY_MARKED_ROOT, 'permissions.json'), JSON.stringify({ allowedMcpPatterns: ['whoami'] }));
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
  rmSync(READ_ONLY_MARKED_ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});
afterEach(() => {
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});

function createConfig(root: string = WORKSPACE_ROOT): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1234',
      name: 'F1.234 Workspace',
      rootPath: root,
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    } as any,
    session: {
      id: 'session-f1234',
      workspaceRootPath: root,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** codex's own approval request for one call of a `server` tool. */
function approvalFor(server: string, tool: string, toolParams: Record<string, unknown>) {
  return {
    threadId: 'thread-f1234',
    turnId: 'turn-f1234',
    serverName: server,
    mode: 'form',
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_params: toolParams,
      tool_params_display: [],
    },
    requestedSchema: { type: 'object', properties: {} },
  };
}

function session(mode: PermissionMode, attended: boolean, root: string = WORKSPACE_ROOT) {
  const agent = new CodexAgent(createConfig(root));
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  const debug: string[] = [];
  agent.onDebug = (line) => { debug.push(line); };
  if (attended) agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode(mode);
  const ask = (server: string, tool: string, toolParams: Record<string, unknown>) =>
    (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, approvalFor(server, tool, toolParams)) as
      Promise<Record<string, unknown>> | Record<string, unknown>;
  return { agent, surfaced, debug, ask };
}

const RENAME = { automationId: 'tidy', patch: { name: 'Tidier' } };
/** F1.227's floor subject — a person's call in `default`. */
const REENABLE = { automationId: 'dormant-bypass', patch: { enabled: true } };
const DECLINE = { action: 'decline', content: null };

/** The sentence claude and Pi refuse the same call with — their gate's own first step. */
function modeBlockSentence(mode: PermissionMode, toolParams: Record<string, unknown>): string {
  const verdict = shouldAllowToolInMode('mcp__session__automation_update', toolParams, mode, {
    permissionsContext: { workspaceRootPath: WORKSPACE_ROOT, activeSourceSlugs: [], projectTrusted: false },
  });
  expect(verdict.allowed).toBe(false);
  return verdict.allowed ? '' : verdict.reason ?? '';
}

describe('F1.234 · codex refuses a session-configuration tool in the read-only modes, as claude and Pi do', () => {
  for (const mode of ['plan'] as const) {
    it(`${mode}: automation_update is declined synchronously, with no card, naming the mode block`, async () => {
      const { surfaced, debug, ask } = session(mode, true);
      const answer = ask('session', 'automation_update', RENAME);
      expect(answer).not.toBeInstanceOf(Promise);
      expect(await answer).toEqual(DECLINE);
      expect(surfaced).toEqual([]);
      const sentence = modeBlockSentence(mode, RENAME);
      expect(sentence).toStartWith('Session configuration changes are blocked in ');
      expect(debug.some(line => line.includes(sentence))).toBe(true);
    });
  }

  it('plan: F1.227\'s floor subject is refused too — the mode block answers first, as on claude and Pi', async () => {
    const { surfaced, ask } = session('plan', true);
    expect(await ask('session', 'automation_update', REENABLE)).toEqual(DECLINE);
    expect(surfaced).toEqual([]);
  });

  it('plan, unattended: refused even with the operator escape hatch open', async () => {
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    const { debug, ask } = session('plan', false);
    expect(await ask('session', 'automation_update', RENAME)).toEqual(DECLINE);
    expect(debug.some(line => line.includes('Session configuration changes are blocked in Plan.'))).toBe(true);
  });

  it('CONTROL: default still raises F1.227\'s named card, and an ordinary edit the ordinary card', async () => {
    const floor = session('default', true);
    const pendingFloor = floor.ask('session', 'automation_update', REENABLE);
    expect(pendingFloor).toBeInstanceOf(Promise);
    expect(floor.surfaced).toHaveLength(1);
    expect(floor.surfaced[0]!.description).toContain('"Weekly purge" (dormant-bypass) runs (enabled)');
    floor.agent.respondToPermission(floor.surfaced[0]!.requestId, true);
    expect((await pendingFloor).action).toBe('accept');

    const plain = session('default', true);
    const pendingPlain = plain.ask('session', 'automation_update', RENAME);
    expect(plain.surfaced).toHaveLength(1);
    plain.agent.respondToPermission(plain.surfaced[0]!.requestId, false);
    expect(await pendingPlain).toEqual(DECLINE);
  });

  /**
   * F1.376 (origin the WJ-hh verifier on F1.234) — this CONTROL drove
   * `SubmitPlan`, which codex never offers: it is in
   * `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, codex's own guidance says "There is
   * no SubmitPlan tool here", and the filter below drops it. It proved the
   * verdict branch, not a reachable call. `transform_data` is one codex IS
   * handed, the mode allows (`safeMode: 'allow'`), and that carries no
   * `readOnlyHint` — so codex really asks for it (`core/src/mcp_tool_call.rs`
   * asks for every tool without one). `TodoWrite`, the row's other example, is
   * not handed to codex at all (it has its own plan tool), which the filter
   * below also shows.
   */
  it('CONTROL: a session tool codex is handed and the mode allows (transform_data) reaches the card in plan, while automation_update in the same session is declined synchronously', async () => {
    // The advertised set, through the filter the session server builds from
    // `CodexAgent.buildSessionMcpSpec`'s argv (`--external-standalone-only`
    // with the host-callback bridge), and the annotation it reads back.
    const codexFilter = {
      includeDeveloperFeedback: false, externalStandaloneOnly: true, hostCallbackBridge: true,
      advisorConsultBridge: true, notificationPort: true, worktreePort: true, reviewDiffPort: true,
    };
    const offered = getToolDefsAsJsonSchema(codexFilter).map(def => def.name);
    const registry = getSessionToolRegistry(codexFilter);
    expect(offered).toContain('transform_data');
    expect(offered).toContain('automation_update');
    expect(offered).not.toContain('SubmitPlan');
    expect(offered).not.toContain('TodoWrite');
    expect(registry.get('transform_data')?.readOnly === true).toBe(false);

    for (const mode of ['plan'] as const) {
      expect(shouldAllowToolInMode('mcp__session__transform_data', {}, mode, {
        permissionsContext: { workspaceRootPath: WORKSPACE_ROOT, activeSourceSlugs: [], projectTrusted: false },
      }).allowed).toBe(true);
      const { surfaced, ask } = session(mode, true);
      const pending = ask('session', 'transform_data', { language: 'python3', script: 'print(1)', outputPath: 'out.json' });
      expect(pending).toBeInstanceOf(Promise);
      expect(surfaced).toHaveLength(1);
      const refused = ask('session', 'automation_update', RENAME);
      expect(refused).not.toBeInstanceOf(Promise);
      expect(await refused).toEqual(DECLINE);
      expect(surfaced).toHaveLength(1);
    }
  });

});

/**
 * F1.374 (origin the WJ-hh verifier on F1.234) — a POOL (`sources`) tool the
 * mode does not mark read-only is refused in plan too, with the
 * sentence claude and Pi refuse it with ("MCP write operations are blocked in
 * …"). F1.234 left the pool tool its card because its verdict needs the
 * `sources` segment shifted out of codex's row name; F1.272 built that shift
 * (`hostMcpToolNameForCodexRow`), so the refusal reads the tool under the name
 * Pi records — `mcp__plugin_cdp-echo-probe_echo__whoami`, not codex's
 * `mcp__sources__plugin_cdp-echo-probe_echo__whoami`.
 */
const POOL_ROW_TOOL = 'plugin_cdp-echo-probe_echo__whoami';
const POOL_HOST_NAME = 'mcp__plugin_cdp-echo-probe_echo__whoami';

function poolModeBlockSentence(mode: PermissionMode, root: string): { allowed: boolean; reason: string } {
  const verdict = shouldAllowToolInMode(POOL_HOST_NAME, {}, mode, {
    permissionsContext: { workspaceRootPath: root, activeSourceSlugs: [], projectTrusted: false },
  });
  return { allowed: verdict.allowed, reason: verdict.allowed ? '' : verdict.reason ?? '' };
}

describe('F1.374 · codex refuses a pool write tool in the read-only modes, as claude and Pi do', () => {
  for (const mode of ['plan'] as const) {
    it(`${mode}: a pool tool the mode does not mark read-only is declined synchronously, with no card, naming the mode block`, async () => {
      const { surfaced, debug, ask } = session(mode, true);
      const answer = ask('sources', POOL_ROW_TOOL, {});
      expect(answer).not.toBeInstanceOf(Promise);
      expect(await answer).toEqual(DECLINE);
      expect(surfaced).toEqual([]);
      const { allowed, reason } = poolModeBlockSentence(mode, WORKSPACE_ROOT);
      expect(allowed).toBe(false);
      expect(reason).toStartWith('MCP write operations are blocked in ');
      expect(debug.some(line => line.includes(reason))).toBe(true);
    });
  }

  it('CONTROL: the same tool, marked read-only by the workspace (allowedMcpPatterns), keeps its card in plan', async () => {
    expect(poolModeBlockSentence('plan', READ_ONLY_MARKED_ROOT).allowed).toBe(true);
    const { surfaced, ask } = session('plan', true, READ_ONLY_MARKED_ROOT);
    const pending = ask('sources', POOL_ROW_TOOL, {});
    expect(pending).toBeInstanceOf(Promise);
    expect(surfaced).toHaveLength(1);
  });

  it('CONTROL: the same write tool keeps its card in default', async () => {
    const { surfaced, ask } = session('default', true);
    const pending = ask('sources', POOL_ROW_TOOL, {});
    expect(pending).toBeInstanceOf(Promise);
    expect(surfaced).toHaveLength(1);
  });
});
