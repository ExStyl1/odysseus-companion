/**
 * F1.1003 (F1.787's remainder, owner decision 2026-09-26 option B) — in `plan` and `explore`
 * the session's plans and data folders are `write` keys on codex's `:read-only` profile, so a
 * plan file lands there without a card while the project stays read-only.
 *
 * Measured first on the shipped codex-app-server 0.156.1 through the product's own
 * `writeCodexConfig` (`work/DN-121/f1003-probe.ts`, switch off and on, plan and explore): with
 * both folders under `<config>/sessions/<ws>/<sid>/` codex resolves `workspaceWrite` with those
 * two as its only writable roots; a `printf` and an `apply_patch` into the plans folder land with
 * 0 approval requests; a `printf` into the project is "operation not permitted". A plans folder
 * that does not exist yet is accepted too (the patch creates it).
 *
 * Pinned here: the helper's mode split and its refusals ({@link codexModeWritablePaths}), and the
 * wiring — the thread security layer a codex thread opens with carries the grant in plan and not
 * in default.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent, codexModeWritablePaths } from '../codex-agent.ts';
import type { PermissionMode } from '../mode-types.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { getSessionDataPath, getSessionPlansDir } from '../../sessions/storage.ts';

const WORKSPACE_ID = 'ws-f1003';
const SESSION_ID = 'session-f1003';
const WORKSPACE_ROOT = join(CONFIG_DIR, 'workspaces', WORKSPACE_ID);
const PROJECT_CWD = '/tmp/nessy-f1003-project';
const PLANS = getSessionPlansDir(WORKSPACE_ID, SESSION_ID);
const DATA = getSessionDataPath(WORKSPACE_ID, SESSION_ID);
const ADDED = '/tmp/nessy-f1003-added';

function sessionFor(cwd: string, overrides: { denied?: string[]; protectedSubpaths?: string[] } = {}) {
  return {
    cwd,
    workspace: { id: WORKSPACE_ID, workspaceRootPath: WORKSPACE_ROOT },
    sessionId: SESSION_ID,
    denied: () => overrides.denied ?? [join(CONFIG_DIR, 'credentials.enc')],
    floor: () => [],
    protectedSubpaths: () => overrides.protectedSubpaths ?? ['.git'],
  };
}

describe('F1.1003 · codexModeWritablePaths', () => {
  it('plan adds the session plans and data folders after the added roots', () => {
    for (const mode of ['plan'] as const) {
      expect(codexModeWritablePaths(mode, [ADDED], sessionFor(PROJECT_CWD)), mode).toEqual([ADDED, PLANS, DATA]);
    }
  });

  it('every other mode keeps the added roots alone — the decision names plan only', () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const) {
      expect(codexModeWritablePaths(mode, [ADDED], sessionFor(PROJECT_CWD)), mode).toEqual([ADDED]);
    }
  });

  it('refuses a folder that would conflict, open what it contains, or undercut a protected folder — and says so', () => {
    const debug: string[] = [];
    // An exact denied-read path: the writer would throw codex-runtime-path-policy-conflict.
    expect(codexModeWritablePaths('plan', [], sessionFor(PROJECT_CWD, { denied: [DATA] }), m => debug.push(m)))
      .toEqual([PLANS]);
    // A folder that CONTAINS the project (here the cwd is inside the plans folder).
    expect(codexModeWritablePaths('plan', [], sessionFor(join(PLANS, 'nested')), m => debug.push(m)))
      .toEqual([DATA]);
    // A folder inside a protected project folder: the `read` entry must not be undercut.
    const sessionDir = join(PLANS, '..');
    expect(codexModeWritablePaths('plan', [], sessionFor(sessionDir, { protectedSubpaths: ['data'] }), m => debug.push(m)))
      .toEqual([PLANS]);
    expect(debug).toHaveLength(3);
    expect(debug[0]).toContain('denied-read path');
    expect(debug[1]).toContain('contains the project');
    expect(debug[2]).toContain('inside a protected project folder');
  });
});

function agentIn(mode: PermissionMode): CodexAgent {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'F1.1003 Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: PROJECT_CWD,
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
  const agent = new CodexAgent(config);
  agent.setPermissionMode(mode);
  return agent;
}

describe('F1.1003 · the thread a codex session opens carries the grant', () => {
  it('plan: the security layer grants the plans and data folders over a :read-only parent', () => {
    const layer = JSON.stringify((agentIn('plan') as any).codexThreadSecurityLayer());
    expect(layer).toContain('":read-only"');
    expect(layer).toContain(`${JSON.stringify(PLANS)}:"write"`);
    expect(layer).toContain(`${JSON.stringify(DATA)}:"write"`);
  });

  it('default: neither folder is granted (CONTROL)', () => {
    const layer = JSON.stringify((agentIn('default') as any).codexThreadSecurityLayer());
    expect(layer).not.toContain(JSON.stringify(PLANS));
    expect(layer).not.toContain(JSON.stringify(DATA));
  });
});
