/**
 * F1.372 (origin WJ-hh P-WJ-hh-6) — codex's MCP tool-call card offers Always
 * Allow, and it is honoured by the SAME host record Pi's MCP card writes.
 *
 * ## What was measured first (read at HEAD 2026-09-24, every runtime)
 *
 * - **Pi**: the MCP card carries `commandHash = sha256(<host tool name>)` and
 *   `rememberForMinutes` (`core/pre-tool-use.ts` `shouldPromptInAskMode`'s MCP
 *   branch, `rememberablePrompt(toolName)`) and no `noAlwaysAllow`. An Always
 *   answer is stored host-side by `SessionManager.respondToPermission` →
 *   `storeAdminRememberApproval` — session-scoped, in memory, never on disk — and
 *   the next identical card is answered before it is shown by
 *   `handleAgentPermissionRequest` → `hasActiveAdminRememberApproval`.
 * - **Claude**: the same host record, plus the agent's session whitelist
 *   (`sessionWhitelistKeyForApproval` → the tool name). Nothing on disk.
 * - **Codex**: the card was `noAlwaysAllow: true`
 *   (`codex-agent-server/src/approval-bridge.ts` `mapElicitationApprovalToRequest`,
 *   whose docblock says the host remembers only a `commandHash`), so F1.273's
 *   premise "the host's own rule (written by Always Allow…) answers every later
 *   card on codex" had no Always to write anything.
 *
 * ## The decision (uniform, transparent, smallest)
 *
 * Codex's MCP tool-call card carries the SAME `commandHash` Pi's card carries
 * for the same call — the host tool name (`hostMcpToolNameForCodexRow`, F1.272),
 * hashed the way `rememberablePrompt` hashes it — so the host's existing
 * remember record answers the next identical codex card exactly as it answers
 * Pi's, and a session that switches runtime keeps one vocabulary. Nothing is
 * persisted and codex's own `persist` metadata is still not echoed (the bridge's
 * answer is unchanged). A FLOOR card keeps `noAlwaysAllow` and no hash (P2.140),
 * and every other elicitation (a server's own question, a url) is unchanged.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { shouldPromptInAskMode } from '../core/pre-tool-use.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'wjrr-f1372-'));
writeFileSync(join(WORKSPACE_ROOT, 'automations.json'), JSON.stringify({
  version: 2,
  automations: {
    SchedulerTick: [
      { id: 'dormant-bypass', name: 'Weekly purge', cron: '0 5 * * 0', permissionMode: 'bypassPermissions', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
    ],
  },
}));
afterAll(() => { rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); });
beforeEach(() => { permissionsConfigCache.clear(); });

const WIRE = 'linear';
const HOST_NAME = `mcp__${WIRE}__save_issue`;

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1372', name: 'F1.372', rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT, sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as any,
    session: { id: 'session-f1372', workspaceRootPath: WORKSPACE_ROOT, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

function frame(server: string, tool: string, toolParams: Record<string, unknown> = {}) {
  return {
    threadId: 'thread-f1372', turnId: 'turn-f1372', serverName: server, mode: 'form',
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: toolParams, tool_params_display: [] },
    requestedSchema: { type: 'object', properties: {} },
  };
}

function session(mode: PermissionMode = 'default') {
  const agent = new CodexAgent(createConfig());
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = () => {};
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode(mode);
  const ask = (params: unknown) => (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, params) as Promise<unknown>;
  return { agent, surfaced, ask };
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('F1.372 · codex\'s MCP card offers Always Allow on the host\'s own remember record', () => {
  it('a pool tool\'s card carries Pi\'s commandHash for the same call, and no noAlwaysAllow', () => {
    const { agent, surfaced, ask } = session();
    try {
      void ask(frame('sources', `${WIRE}__save_issue`, { title: 'x' }));
      expect(surfaced).toHaveLength(1);
      const card = surfaced[0]! as Record<string, unknown>;
      expect(card.noAlwaysAllow).toBeFalsy();
      expect(card.commandHash).toBe(sha256(HOST_NAME));
      expect(card.rememberForMinutes).toBe(10);
      // The pin that makes it ONE record: Pi's own card for the same call.
      const pi = shouldPromptInAskMode(HOST_NAME, { title: 'x' }, agent.getPermissionManager() as never, {
        workspaceRootPath: WORKSPACE_ROOT, activeSourceSlugs: [], projectTrusted: false,
      });
      expect(pi?.commandHash).toBe(card.commandHash as string);
      expect(pi?.rememberForMinutes).toBe(card.rememberForMinutes as number);
    } finally { agent.destroy(); }
  });

  it('a session tool\'s card is keyed the same way (its host name is its own)', () => {
    const { agent, surfaced, ask } = session();
    try {
      void ask(frame('session', 'config_validate', {}));
      expect(surfaced).toHaveLength(1);
      expect((surfaced[0]! as Record<string, unknown>).commandHash).toBe(sha256('mcp__session__config_validate'));
    } finally { agent.destroy(); }
  });

  it('CONTROL: F1.227\'s floor card keeps noAlwaysAllow and carries no hash (P2.140)', () => {
    const { agent, surfaced, ask } = session();
    try {
      void ask(frame('session', 'automation_update', { automationId: 'dormant-bypass', patch: { enabled: true } }));
      expect(surfaced).toHaveLength(1);
      const card = surfaced[0]! as Record<string, unknown>;
      expect(card.noAlwaysAllow).toBe(true);
      expect(card.commandHash).toBeUndefined();
    } finally { agent.destroy(); }
  });
});
