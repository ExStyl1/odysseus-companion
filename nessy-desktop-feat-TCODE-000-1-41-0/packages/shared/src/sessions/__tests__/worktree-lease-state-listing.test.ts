import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SESSION_PERSISTENT_FIELDS } from '../types.ts';

/**
 * P3.312 — the worktree ledger has to survive the LISTING path.
 *
 * `worktreeLeaseState` is a persisted session-header field, but the live reader
 * (`store-v2`'s `headerToMetadata`) hand-copies its fields, and it did not copy
 * this one. SessionManager hydrates its in-memory sessions from that listing at
 * startup, so every session that had not been OPENED this run carried an EMPTY
 * ledger — and the session nobody reopens is exactly the one whose worktree
 * leaks (P3.288: a scheduled task makes a new session per run, so run 2's sweep
 * opened an empty ledger and run 1's directory was unreachable from it).
 *
 * The run happens in a CHILD with `NESSY_CONFIG_DIR` exported before bun
 * starts, which is the only form that actually isolates the config dir — the
 * root `bunfig.toml`'s own preload otherwise freezes it at the real one.
 */
const STORE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'store-v2.ts')).href;

const LEASE_STATE = {
  schemaVersion: 1,
  revision: 3,
  leases: [{
    schemaVersion: 1,
    worktreeLeaseId: 'lease-unopened',
    workspaceId: 'ws-listing',
    ownerAgentId: 'agent-1',
    path: '/projects/demo/.nessy-worktrees/demo/lease-unopened',
    branch: 'nessy/agent-1/lease-unopened',
    baseSha: 'a'.repeat(40),
    status: 'active',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
  }],
};

function listInChild(configRoot: string, header: Record<string, unknown>): any {
  const sessionDir = join(configRoot, 'sessions', 'ws-listing', 'sess-unopened');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.jsonl'), `${JSON.stringify(header)}\n`);
  const result = Bun.spawnSync([process.execPath, '--eval', `
    import { createSessionStore } from ${JSON.stringify(STORE_MODULE)};
    const store = createSessionStore({ storageLayoutVersion: 2, verificationId: 'test-verification-id' });
    console.log(JSON.stringify(store.list('ws-listing')));
  `], {
    env: { ...process.env, NESSY_CONFIG_DIR: configRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stderr?.toString() ?? '').toBe(0);
  return JSON.parse(result.stdout?.toString() ?? 'null');
}

function withConfigRoot(fn: (configRoot: string) => void): void {
  const configRoot = mkdtempSync(join(tmpdir(), 'nessy-worktree-listing-'));
  try {
    fn(configRoot);
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
}

describe('worktreeLeaseState through the session listing (P3.312)', () => {
  it('is a persisted header field, so the listing is the only place it can be lost', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('worktreeLeaseState');
  });

  it('reaches SessionMetadata for a session that is never opened', () => {
    withConfigRoot(configRoot => {
      const listed = listInChild(configRoot, {
        id: 'sess-unopened',
        workspaceId: 'ws-listing',
        name: 'unopened',
        createdAt: 1_700_000_000_000,
        lastUsedAt: 1_700_000_000_000,
        messageCount: 0,
        worktreeLeaseState: LEASE_STATE,
      });

      expect(listed).toHaveLength(1);
      // The whole ledger, not a truthy flag: a sweep needs the lease ids and
      // the paths, and a boolean would have passed a weaker assertion.
      expect(listed[0].worktreeLeaseState).toEqual(LEASE_STATE);
    });
  });

  it('leaves the field absent when the header has none, rather than inventing an empty ledger', () => {
    // An empty ledger and a missing one are the two states the leak was
    // confused between; `{ leases: [] }` here would read as "swept clean".
    withConfigRoot(configRoot => {
      const listed = listInChild(configRoot, {
        id: 'sess-unopened',
        workspaceId: 'ws-listing',
        name: 'no-worktree',
        createdAt: 1_700_000_000_000,
        lastUsedAt: 1_700_000_000_000,
        messageCount: 0,
      });

      expect(listed).toHaveLength(1);
      expect('worktreeLeaseState' in listed[0]).toBe(false);
    });
  });
});
