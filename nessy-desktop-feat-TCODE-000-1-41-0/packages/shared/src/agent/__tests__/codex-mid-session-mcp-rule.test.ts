/**
 * F1.937 (origin WJ-crit-iii P-1) — does a codex MCP deny/ask rule added MID-SESSION hold on the
 * live session?
 *
 * Two reaches, and they answer differently.
 *
 * 1. A tool codex ASKS about (every pool/session tool without `readOnlyHint`, in every mode —
 *    F1.218 measured the `mcpServer/elicitation/request` frame on the shipped binary). The host's
 *    answer reads the merged policy per request (`consultPermissionRules` →
 *    `permissionsConfigCache.getMergedConfig`), and the config watcher drops the workspace entry when
 *    `permissions.json` changes (`config/watcher.ts`, `invalidateWorkspace`). So a rule written
 *    after the session started answers the NEXT asked call: pinned below through the REAL
 *    `handleServerRequest` with the measured frame, starting from no rule.
 * 2. A tool codex never asks about (`readOnlyHint: true`), or any MCP call while codex's
 *    auto-review reviewer answers first. Only codex's own levers hold there (F1.378:
 *    `disabled_tools`, `tools.<name>.approval_mode = "prompt"`), and `config.toml` is read when the
 *    app-server starts, and the turn-head re-fork (F1.928, `applySelectedPluginSkillRuntimePolicy`)
 *    carries the permission layer and the execpolicy rules but no MCP lever. So there a rule added
 *    mid-session holds from the next runtime build, not the next turn — the residue F1.378's writer
 *    docblock (`CodexConfigOptions.mcpToolLevers`) already states, left open as a proposed row.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'f1937-codex-mid-session-'));
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });
beforeEach(() => { permissionsConfigCache.clear(); delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]; });

let n = 0;
function rig(mode: PermissionMode) {
  n += 1;
  const ws = join(ROOT, `ws-${n}`);
  mkdirSync(ws, { recursive: true });
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: { id: `ws-f1937-${n}`, name: 'F1.937', rootPath: ws, workspaceRootPath: ws, sessionRootPath: join(ws, 'sessions') } as never,
    session: { id: `session-f1937-${n}`, workspaceRootPath: ws, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: ws } as never,
    model: 'codex/test-model',
    isHeadless: true,
  };
  const agent = new CodexAgent(config);
  // F1.1057 — a default session denies nothing; the stub only undoes this suite's `$TMPDIR` config dir (F1.664).
  (agent as never as { codexDeniedReadPaths: () => string[] }).codexDeniedReadPaths = () => [];
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = () => {};
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode(mode);
  // The frame the shipped binary sends for a pool tool (codex-mcp-tool-approval-modes.test.ts).
  const frame = {
    threadId: 'thread-f1937', turnId: 'turn-f1937', serverName: 'sources', mode: 'form',
    message: 'Allow the sources MCP server to run tool "linear__save_issue"?',
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: { title: 'x' }, tool_params_display: [] },
    requestedSchema: { type: 'object', properties: {} },
  };
  const ask = () => (agent as never as { handleServerRequest(m: string, p: unknown): unknown })
    .handleServerRequest(MCP_ELICITATION_METHOD, frame) as Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Write the workspace store mid-session, then do what the config watcher does on that change. */
  const setRules = (rules: Array<{ id: string; action: 'deny' | 'ask'; tool: string }>) => {
    writeFileSync(join(ws, 'permissions.json'), JSON.stringify({
      permissionDsl: { version: 1, rules: rules.map(r => ({ id: r.id, action: r.action, match: { kind: 'mcp', server: 'linear', tool: r.tool } })) },
    }));
    permissionsConfigCache.invalidateWorkspace(ws);
  };
  return { agent, surfaced, ask, setRules };
}

describe('F1.937 · an MCP rule added mid-session answers the next call codex asks about', () => {
  for (const mode of ['default', 'bypassPermissions'] as const) {
    it(`${mode}: no rule at start → the usual answer; a deny written mid-session → refused with no card`, async () => {
      const { agent, surfaced, ask, setRules } = rig(mode);
      try {
        const first = ask();
        // The discriminator is asserted unconditionally: only default parks the first call on a card.
        expect(mode === 'default').toBe(first instanceof Promise && surfaced.length === 1);
        if (mode === 'default') {
          expect(first).toBeInstanceOf(Promise);
          expect(surfaced).toHaveLength(1);
          agent.respondToPermission(surfaced[0]!.requestId, true, false);
          expect(await first).toEqual({ action: 'accept', content: {} });
        } else {
          expect(await first).toEqual({ action: 'accept', content: {} });
          expect(surfaced).toEqual([]);
        }
        surfaced.length = 0;
        setRules([{ id: 'deny-linear-save', action: 'deny', tool: 'save_issue' }]);
        expect(await ask()).toEqual({ action: 'decline', content: null });
        expect(surfaced).toEqual([]);
      } finally { agent.destroy(); }
    });
  }

  it('bypassPermissions: an ask written mid-session → the next call is carded naming the rule, with no Always Allow', () => {
    const { agent, surfaced, ask, setRules } = rig('bypassPermissions');
    try {
      expect(ask()).not.toBeInstanceOf(Promise);
      setRules([{ id: 'ask-linear-save', action: 'ask', tool: 'save_issue' }]);
      expect(ask()).toBeInstanceOf(Promise);
      expect(surfaced).toHaveLength(1);
      const shown = surfaced[0] as unknown as Record<string, unknown>;
      expect(String(shown.description)).toContain('ask-linear-save');
      expect(shown.noAlwaysAllow).toBe(true);
    } finally { agent.destroy(); }
  });

  it('BOUNDARY: a deny removed mid-session stops refusing, and a deny on ANOTHER tool refuses nothing here', async () => {
    const { agent, surfaced, ask, setRules } = rig('bypassPermissions');
    try {
      setRules([{ id: 'deny-linear-save', action: 'deny', tool: 'save_issue' }]);
      expect(await ask()).toEqual({ action: 'decline', content: null });
      setRules([{ id: 'deny-linear-delete', action: 'deny', tool: 'delete_issue' }]);
      expect(await ask()).toEqual({ action: 'accept', content: {} });
      expect(surfaced).toEqual([]);
    } finally { agent.destroy(); }
  });
});
