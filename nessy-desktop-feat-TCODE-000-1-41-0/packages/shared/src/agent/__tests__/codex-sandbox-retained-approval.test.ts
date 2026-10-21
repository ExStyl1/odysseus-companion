/**
 * F1.780 (origin: release sitting SIT-l E21, packaged `5896a66d2`, codex-gateway) — an
 * APPROVED sandbox escalation still ran sandboxed on codex (`touch ~/x` → `Operation not
 * permitted` after Allow and after Always Allow), and Always Allow still wrote a durable
 * execpolicy allow rule for a command that could never succeed.
 *
 * Owner decision 2026-09-26, option A: accept codex's own, deliberate behaviour —
 * `core/src/tools/sandboxing.rs` at `rust-v0.156.1` keeps every command inside the sandbox
 * while the permission profile denies a read — and say so: the card names it, and Always
 * Allow stays codex's session grant with no durable rule. The frame carries no escalation
 * flag, so the gate keys on the profile.
 *
 * F1.1057 (owner decision 2026-09-28) — the host no longer denies its credential store or
 * its shipped `deniedPaths` to codex, so a default session's profile denies NOTHING and an
 * approved escalation runs outside codex's sandbox, as codex does on its own. The gate is
 * re-keyed on "any deny entry reaches codex" (`codexDenyReadEntryCount`): a user's own
 * `deniedPaths` pattern — not only an exact path — keeps the sentence and the session-only
 * Always Allow. Every arm stubs `codexDeniedReadPaths` to `[]` because this suite's config
 * dir lives under `$TMPDIR`, a codex writable root, which makes F1.664's projection deny it
 * (a test artefact: the real `~/.nessy-agent` is not under a writable root).
 *
 * Driven through the real `CodexAgent.handleServerRequest` → card → `respondToPermission`,
 * the seams the renderer and codex read. Nothing here spawns a process or writes outside a
 * temp workspace; the commands are strings handed to an in-memory approval bridge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import {
  collectExecpolicyAllowPrefixes,
  getWorkspacePermissionsPath,
  loadRawWorkspacePermissions,
  permissionsConfigCache,
} from '../permissions-config.ts';

const EXEC_METHOD = 'item/commandExecution/requestApproval';
const PATCH_METHOD = 'item/fileChange/requestApproval';
/** SIT-l E21's escalation, as codex frames it (a string, never run here). */
const ESCALATION = { command: 'touch ~/f1780-probe', proposedExecpolicyAmendment: ['touch', '~/f1780-probe'] };
const HOME_RM = ['rm', '-rf', '~'].join(' ');
const SANDBOX_SENTENCE = 'approving it does not lift the sandbox';
const SESSION_ONLY_SENTENCE = 'Always Allow applies to this session only';

let workspaceRoot = '';
beforeEach(() => {
  permissionsConfigCache.clear();
  workspaceRoot = mkdtempSync(join(tmpdir(), 'f1780-ws-'));
});
afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/** SHIPPED entries, spelled as `default.json` ships them. */
const SHIPPED = ['~/.ssh/**', '**/.env', '~/.nessy/**'];

/**
 * A session whose permission layers are `layers`: by default the user's workspace denies one
 * path of its own, so the profile denies a read (F1.1057: only a user or operator entry does).
 */
function sessionAgent(options: { layers?: Array<{ content: string; scope?: 'global' | 'workspace' }> } = {}) {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1780', name: 'F1.780', rootPath: workspaceRoot, workspaceRootPath: workspaceRoot,
      sessionRootPath: join(workspaceRoot, 'sessions'),
    } as never,
    session: {
      id: 'session-f1780', workspaceRootPath: workspaceRoot, createdAt: Date.now(), lastUsedAt: Date.now(),
      workingDirectory: workspaceRoot,
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  };
  const agent = new CodexAgent(config);
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  const debug: string[] = [];
  agent.onDebug = message => { debug.push(message); };
  agent.onPermissionRequest = request => { surfaced.push(request); };
  const layers = options.layers ?? [{ content: JSON.stringify({ deniedPaths: ['/srv/f1780-secrets/**'] }), scope: 'workspace' as const }];
  agent.getPermissionManager().setCapabilityPermissionLayers(layers, 'gen-f1780', true);
  agent.setPermissionMode('default');
  // No exact deny path: production's `codexDeniedReadPaths` is empty since F1.1057 (see the header).
  (agent as never as { codexDeniedReadPaths: () => string[] }).codexDeniedReadPaths = () => [];
  const ask = (method: string, params: Record<string, unknown>) =>
    (agent as never as { handleServerRequest(m: string, p: unknown): Promise<Record<string, unknown>> })
      .handleServerRequest(method, params);
  return { agent, surfaced, debug, ask };
}

describe('F1.780 · an approval cannot lift codex\'s sandbox while the profile denies a read', () => {
  it('SIT-l E21: the card says so, and Always Allow answers acceptForSession with NO durable rule', async () => {
    const { agent, surfaced, debug, ask } = sessionAgent();
    try {
      const answer = ask(EXEC_METHOD, ESCALATION);
      expect(surfaced).toHaveLength(1);
      const card = surfaced[0]!;
      expect(card.description.startsWith(`Run: ${ESCALATION.command}`)).toBe(true);
      expect(card.description).toContain(SANDBOX_SENTENCE);
      // The button stays, and the card says what it does instead of what it used to.
      expect(card.noAlwaysAllow).not.toBe(true);
      expect(card.description).toContain(SESSION_ONLY_SENTENCE);

      agent.respondToPermission(card.requestId, true, true);

      expect(await answer).toEqual({ decision: 'acceptForSession' });
      expect(existsSync(getWorkspacePermissionsPath(workspaceRoot))).toBe(false);
      expect(debug.some(line => line.includes('Always Allow not persisted') && line.includes('F1.780'))).toBe(true);
    } finally { agent.destroy(); }
  });

  it('CONTROL (F1.1057, the default now): only the shipped floor, so nothing is denied, the card is codex\'s own and Always Allow persists', async () => {
    // The app-default layer carries exactly the shipped entries: none of them reaches codex.
    const { agent, surfaced, ask } = sessionAgent({ layers: [{ content: JSON.stringify({ deniedPaths: SHIPPED }), scope: 'global' }] });
    try {
      const answer = ask(EXEC_METHOD, ESCALATION);
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]!.description).toBe(`Run: ${ESCALATION.command}`);

      agent.respondToPermission(surfaced[0]!.requestId, true, true);

      expect(await answer).toEqual({ decision: 'acceptForSession' });
      expect(collectExecpolicyAllowPrefixes(loadRawWorkspacePermissions(workspaceRoot))).toEqual([['touch', '~/f1780-probe']]);
    } finally { agent.destroy(); }
  });

  it('F1.1057 — a user entry spelled like a shipped one still counts: it is the workspace layer\'s own', async () => {
    const { agent, surfaced, ask } = sessionAgent({ layers: [
      { content: JSON.stringify({ deniedPaths: SHIPPED }), scope: 'global' },
      { content: JSON.stringify({ deniedPaths: ['~/.ssh/**'] }), scope: 'workspace' },
    ] });
    try {
      void ask(EXEC_METHOD, ESCALATION);
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]!.description).toContain(SANDBOX_SENTENCE);
      expect(surfaced[0]!.description).toContain(SESSION_ONLY_SENTENCE);
    } finally { agent.destroy(); }
  });

  it('BOUNDARY: a floor card carries the sentence without the Always Allow clause; a file change carries neither', () => {
    const { agent, surfaced, ask } = sessionAgent();
    try {
      void ask(EXEC_METHOD, { command: HOME_RM });
      void ask(PATCH_METHOD, { threadId: 't', turnId: 'u', itemId: 'i', grantRoot: join(workspaceRoot, 'out') });
      expect(surfaced).toHaveLength(2);
      const [floorCard, patchCard] = surfaced;
      expect(floorCard!.noAlwaysAllow).toBe(true);
      expect(floorCard!.description).toContain(SANDBOX_SENTENCE);
      expect(floorCard!.description).not.toContain(SESSION_ONLY_SENTENCE);
      // An out-of-workspace `apply_patch` lands once approved (WI-az, SIT-r): not this sandbox.
      expect(patchCard!.description).not.toContain(SANDBOX_SENTENCE);
    } finally { agent.destroy(); }
  });
});

/**
 * F1.1236 (final sitting SIT2-d, 2026-10-01) — the card said Always Allow "remembers this for the
 * session" while the press saved `codex-execpolicy-…` in the workspace permissions.json and a new
 * session ran the command with no card. The card now carries `alwaysAllowScope: 'workspace'` exactly
 * where the write will happen, and nowhere else.
 */
describe('F1.1236 · the codex card states where Always Allow is saved', () => {
  it('a durable press: the card says workspace, and the press writes the workspace rule', async () => {
    const { agent, surfaced, ask } = sessionAgent({ layers: [{ content: JSON.stringify({ deniedPaths: SHIPPED }), scope: 'global' }] });
    try {
      const answer = ask(EXEC_METHOD, ESCALATION);
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]!.alwaysAllowScope).toBe('workspace');
      agent.respondToPermission(surfaced[0]!.requestId, true, true);
      await answer;
      expect(collectExecpolicyAllowPrefixes(loadRawWorkspacePermissions(workspaceRoot))).toEqual([['touch', '~/f1780-probe']]);
    } finally { agent.destroy(); }
  });

  it('BOUNDARY: no statement where nothing is saved — no proposed prefix, a sandbox-retained command, a floor card, a file change', async () => {
    const plain = sessionAgent({ layers: [{ content: JSON.stringify({ deniedPaths: SHIPPED }), scope: 'global' }] });
    const retained = sessionAgent();
    try {
      void plain.ask(EXEC_METHOD, { command: 'touch ~/f1236-no-prefix' });
      void plain.ask(EXEC_METHOD, { command: HOME_RM, proposedExecpolicyAmendment: ['rm', '-rf', '~'] });
      void plain.ask(PATCH_METHOD, { threadId: 't', turnId: 'u', itemId: 'i', grantRoot: join(workspaceRoot, 'out') });
      void retained.ask(EXEC_METHOD, ESCALATION);
      expect(plain.surfaced).toHaveLength(3);
      expect(retained.surfaced).toHaveLength(1);
      for (const card of [...plain.surfaced, ...retained.surfaced]) expect(card.alwaysAllowScope).toBeUndefined();
    } finally { plain.agent.destroy(); retained.agent.destroy(); }
  });
});
