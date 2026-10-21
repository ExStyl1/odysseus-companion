/**
 * F1.194 (F1.104's residue) — the host carries ITS user-memory root to the codex
 * session-MCP child, so `remember` with `scope: "user"` writes the index the host
 * loads.
 *
 * The child resolves `getUserMemoryFilePath()` itself only when its own
 * `CONFIG_DIR` equals `--config-root`; on a moved-config install the two differ
 * (codex's `create_env_for_mcp_server` allowlist does not carry
 * `NESSY_CONFIG_DIR`), so it kept `join(configRoot, MEMORY.md)` — and with
 * `autoMemoryDirectory` set that is a SECOND index nothing loads. The host knows
 * the answer (`getUserMemoryRoot()`), so it says it by argv, in F1.118's shape:
 * emitted only when it differs from `--config-root`, a SETTING-class flag the
 * turn-head comparison (F1.116) re-derives.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexAgent } from '../codex-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../../config/paths.ts';

function createAgent(): any {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1194',
      name: 'F1.194 Workspace',
      rootPath: '/tmp/ws-f1194-root',
      workspaceRootPath: '/tmp/ws-f1194-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-f1194',
    } as any,
    session: { id: 'session-f1194', createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: '/tmp/session-mcp-server.js', node: '/tmp/node' } },
  } as any;
  return new CodexAgent(config);
}

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** Plant `autoMemoryDirectory` through the production loader; restore the exact bytes after. */
function withAutoMemoryDirectory<T>(autoMemoryDirectory: string | undefined, body: () => T): T {
  const before = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({
      storageLayoutVersion: STORAGE_LAYOUT_VERSION,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      ...(autoMemoryDirectory === undefined ? {} : { autoMemoryDirectory }),
    }), 'utf-8');
    return body();
  } finally {
    if (before === null) rmSync(CONFIG_FILE, { force: true });
    else writeFileSync(CONFIG_FILE, before, 'utf-8');
  }
}

function valueAfter(args: string[] | undefined, flag: string): string | undefined {
  if (!args) return undefined;
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('F1.194 — the codex session-MCP argv carries the host user-memory root', () => {
  it('autoMemoryDirectory set: the root is stated, absolute, beside --config-root', () => {
    const moved = mkdtempSync(join(tmpdir(), 'f1194-moved-'));
    try {
      const args = withAutoMemoryDirectory(moved, () => createAgent().buildSessionMcpSpec(undefined)?.args);
      expect(valueAfter(args, '--user-memory-root')).toBe(moved);
      expect(valueAfter(args, '--config-root')).toBe(CONFIG_DIR);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it('CONTROL — unset: nothing is emitted, so every ordinary argv is byte-identical', () => {
    const args = withAutoMemoryDirectory(undefined, () => createAgent().buildSessionMcpSpec(undefined)?.args);
    expect(args).not.toContain('--user-memory-root');
    expect(args).toContain('--config-root');
  });
});
