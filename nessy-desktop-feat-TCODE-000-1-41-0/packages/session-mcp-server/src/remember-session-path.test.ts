/**
 * F1.765 — the codex session tools write into the session's OWN storage-v2
 * folder, the one pi and claude write into, driven through the REAL stdio child.
 *
 * ## What the sitting measured
 *
 * SIT-b (packaged `5896a66d2`, 2026-09-25, RS-105 A4 on `codex-gateway`): a
 * session-scope `remember` answered `Saved memory to ./sessions/<sid>/data/MEMORY.md`
 * and the file landed in `<config>/workspaces/<ws>/sessions/<sid>/data/`, a tree
 * created for that one write. pi and claude, same profile and same call, wrote
 * `<config>/sessions/<ws>/<sid>/data/MEMORY.md` and answered that absolute path.
 * The child derived its session folder as `join(workspaceRootPath, 'sessions',
 * sessionId)` — the layout before storage v2 — while every host reader
 * (`getSessionDataPath`: the session-memory loader, the prompt's data-folder
 * line, the cleanup pass) resolves `getSessionDirPath(workspaceId, sessionId)`.
 * The `./` in the answer is the host's display pass (`formatPathsToRelative`
 * against the workspace root), which shortened the stray path because it sat
 * UNDER the workspace root; the session's real folder does not, so its answer
 * stays absolute.
 *
 * ## What this file drives
 *
 * The argv a fixed host now spawns: `--session-path <storage-v2 folder>` beside
 * `--session-id`. The rig mirrors the real layout — the workspace root is
 * `<config>/workspaces/<ws>` and the session folder is `<config>/sessions/<ws>/<sid>`
 * — so a write that still followed the old derivation lands in a different,
 * observable place and the two cannot be confused.
 *
 * CONTROLS in the same exchange: `scope: "user"` still writes the config-root
 * index (the fix moves the session folder and nothing else), and a read-only
 * tool answers, so "remember answered" is not a child that says yes to anything.
 * The OLDER-host arm — no `--session-path`, so the legacy derivation — is
 * `remember-scopes.test.ts`'s D1.359 case, which asserts exactly that path and
 * is left untouched on purpose.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createChildPool, type PooledRpcResponse } from './__tests__/child-pool.ts';

interface ToolReply {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
type RpcResponse = PooledRpcResponse<ToolReply | undefined>;

/** ONE child for the file: one argv, one exchange (P6.901's rule). */
const pool = createChildPool<ToolReply | undefined>();

const WORKSPACE_ID = 'ws-f1765';
const SESSION_ID = 'sess-f1765';

let configRoot: string;
let workspaceRoot: string;
let sessionPath: string;

beforeAll(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'smcp-f1765-cfg-'));
  workspaceRoot = join(configRoot, 'workspaces', WORKSPACE_ID);
  sessionPath = join(configRoot, 'sessions', WORKSPACE_ID, SESSION_ID);
  mkdirSync(workspaceRoot, { recursive: true });
});

afterAll(async () => {
  await pool.killAll();
  rmSync(configRoot, { recursive: true, force: true });
});

function textOf(response: RpcResponse | undefined): string {
  return (response?.result?.content ?? []).map((part) => part.text ?? '').join('\n');
}

describe('F1.765 — codex session tools use the session storage-v2 folder the host names', () => {
  test('session-scope remember lands in <config>/sessions/<ws>/<sid>/data and answers the absolute path', async () => {
    const responses = await pool.runMcpSession(
      [
        '--session-id', SESSION_ID,
        '--session-path', sessionPath,
        '--workspace-root', workspaceRoot,
        '--plans-folder', join(sessionPath, 'plans'),
        '--config-root', configRoot,
        '--external-standalone-only',
      ],
      [
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'F1765-SESSION', scope: 'session' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'F1765-USER', scope: 'user' } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'config_validate', arguments: { target: 'config' } } },
      ],
    );

    // THE CONTROL: this child is alive and answers a read-only tool in the same
    // exchange.
    const control = responses.get(4);
    expect(control).toBeDefined();
    expect(textOf(control).length).toBeGreaterThan(0);

    // (1) The arm that is RED before the fix: the file lands under the session's
    // own folder and the answer names that ABSOLUTE path.
    const session = responses.get(2);
    expect(session).toBeDefined();
    expect(session?.result?.isError).toBe(false);
    const sessionIndex = join(sessionPath, 'data', 'MEMORY.md');
    const said = /Saved memory to (\S+)/.exec(textOf(session))?.[1];
    expect(said).toBe(sessionIndex);
    expect(isAbsolute(said ?? '')).toBe(true);
    expect(existsSync(sessionIndex)).toBe(true);
    expect(readFileSync(sessionIndex, 'utf-8')).toContain('F1765-SESSION');

    // (2) And NOT in the stray pre-storage-v2 tree the sitting found — the
    // directory is never created.
    expect(existsSync(join(workspaceRoot, 'sessions', SESSION_ID))).toBe(false);

    // (3) CONTROL — `scope: "user"` is unchanged: the config-root index.
    const user = responses.get(3);
    expect(user).toBeDefined();
    expect(user?.result?.isError).toBe(false);
    const userIndex = join(configRoot, 'MEMORY.md');
    expect(textOf(user)).toContain(`Saved memory to ${userIndex}`);
    expect(readFileSync(userIndex, 'utf-8')).toContain('F1765-USER');
  }, 330_000);
});
