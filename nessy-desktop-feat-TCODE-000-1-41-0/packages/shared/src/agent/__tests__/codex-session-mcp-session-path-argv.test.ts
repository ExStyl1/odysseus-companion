/**
 * F1.765 — the host names the codex session-MCP child's session folder, so the
 * session tools write where pi and claude write.
 *
 * The child derived that folder as `join(workspaceRootPath, 'sessions', id)` —
 * the layout before storage v2 — so on codex `remember` (scope session),
 * `transform_data`, `render_template`, `script_sandbox` and `todo_write` wrote
 * into `<config>/workspaces/<ws>/sessions/<sid>/`, a tree no host reader opens,
 * while every host reader (`getSessionDataPath`: the session-memory loader, the
 * prompt's data-folder line, the memory cleanup pass) resolves
 * `getSessionDirPath(workspaceId, sessionId)` = `<config>/sessions/<ws>/<sid>/`.
 * Measured by the release sitting SIT-b (RS-105 A4, codex 22/23).
 *
 * The child cannot derive the storage-v2 folder itself: it has no workspace ID
 * on its argv, and its own `CONFIG_DIR` can differ from the host's (codex's MCP
 * env allowlist does not carry `NESSY_CONFIG_DIR`). The host knows it, so the
 * host says it — a FIXED-class flag, since a session's id and workspace never
 * move. `remember-session-path.test.ts` (session-mcp-server) is the child half.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAgent } from '../codex-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { getSessionDirPath } from '../../sessions/storage.ts';

const WORKSPACE_ID = 'ws-f1765';
const SESSION_ID = 'session-f1765';
const WORKSPACE_ROOT = '/tmp/ws-f1765-root';

function createAgent(workspaceRoot: string = WORKSPACE_ROOT): any {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'F1.765 Workspace',
      rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot,
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-f1765',
    } as any,
    session: { id: SESSION_ID, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: '/tmp/session-mcp-server.js', node: '/tmp/node' } },
  } as any;
  return new CodexAgent(config);
}

function valueAfter(args: string[] | undefined, flag: string): string | undefined {
  if (!args) return undefined;
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('F1.765 — the codex session-MCP argv names the session storage-v2 folder', () => {
  it('--session-path is getSessionDirPath(workspaceId, sessionId): absolute, outside the workspace root', () => {
    const args: string[] | undefined = createAgent().buildSessionMcpSpec(undefined)?.args;
    const sessionPath = valueAfter(args, '--session-path');
    expect(sessionPath).toBe(getSessionDirPath(WORKSPACE_ID, SESSION_ID));
    expect(isAbsolute(sessionPath ?? '')).toBe(true);
    // The stray tree the sitting found sat UNDER the workspace root; the real
    // folder does not, which is also why the host's display pass leaves the
    // `remember` answer absolute.
    expect((sessionPath ?? '').startsWith(`${WORKSPACE_ROOT}/`)).toBe(false);
    // One derivation with the plans folder the same argv already carried from
    // the storage-v2 helper (no `plansDirectory` is configured on this rig).
    expect(valueAfter(args, '--plans-folder')).toBe(join(sessionPath ?? '', 'plans'));
    // Positive control: this is the session argv, not an empty array.
    expect(valueAfter(args, '--session-id')).toBe(SESSION_ID);
  });

  it('the child parses the same spelling, absolute-only', () => {
    // The flag crosses a process boundary as a literal, so a rename on one side
    // is silent (`runtime-capability-drift.test.ts`'s rule for its two flags).
    const child = readFileSync(
      fileURLToPath(new URL('../../../../session-mcp-server/src/index.ts', import.meta.url)),
      'utf-8',
    );
    expect(child).toContain("args[i] === '--session-path'");
    expect(child).toContain('if (isAbsolute(args[i + 1]!)) sessionPath = args[i + 1];');
    // Positive control on the same instrument: the sibling FIXED flag.
    expect(child).toContain("args[i] === '--session-id'");
  });

  it('CONTROL — a codex session with no workspace root still starts: no spec, no throw', () => {
    // `buildSessionMcpSpec`'s own contract: a session whose workspace is not
    // resolvable spawns no session server rather than a half-configured one —
    // and the new `getSessionDirPath` call sits AFTER that guard, so it cannot
    // throw for such a session. (An EMPTY workspace ID cannot reach here at
    // all: `BaseAgent`'s constructor already derives the plans folder from it
    // and refuses it — measured on this file's first draft.)
    expect(createAgent('').buildSessionMcpSpec(undefined)).toBeUndefined();
  });
});
