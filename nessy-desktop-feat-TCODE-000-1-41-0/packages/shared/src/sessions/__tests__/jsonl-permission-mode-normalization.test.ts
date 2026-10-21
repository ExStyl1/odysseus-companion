import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSessionHeader, readSessionHeaderAsync, readSessionJsonl, writeSessionJsonl } from '../jsonl.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('session jsonl: permission mode normalization', () => {
  it('normalizes canonical permissionMode and previousPermissionMode in header reads', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-mode-header-'));
    tempDirs.push(sessionDir);

    const sessionFile = join(sessionDir, 'session.jsonl');
    const header = {
      id: 's1',
      workspaceRootPath: '/tmp/ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
      permissionMode: 'execute',
      previousPermissionMode: 'explore',
    };

    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf-8');

    const loadedHeader = readSessionHeader(sessionFile);
    expect(loadedHeader?.permissionMode).toBe('bypassPermissions');
    expect(loadedHeader?.previousPermissionMode).toBe('plan'); // F1.1050: a stored explore is read as plan
  });

  it('normalizes canonical mode values when loading full session', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-mode-full-'));
    tempDirs.push(sessionDir);

    const sessionFile = join(sessionDir, 'session.jsonl');
    const header = {
      id: 's2',
      workspaceRootPath: '/tmp/ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 1,
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        contextTokens: 0,
        costUsd: 0,
      },
      permissionMode: 'explore',
      previousPermissionMode: 'execute',
    };

    const message = {
      id: 'm1',
      type: 'user',
      content: 'hello',
      timestamp: Date.now(),
    };

    writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, 'utf-8');

    const loaded = readSessionJsonl(sessionFile);
    expect(loaded?.permissionMode).toBe('plan'); // F1.1050: a stored explore is read as plan
    expect(loaded?.previousPermissionMode).toBe('bypassPermissions');
  });

  it('resolves the pre-migration internal spellings — the common on-disk values', () => {
    // THE release-blocker fixture: every session written before the vocabulary
    // flip carries these spellings, and losing them silently resets the mode.
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-mode-legacy-'));
    tempDirs.push(sessionDir);

    const sessionFile = join(sessionDir, 'session.jsonl');
    const base = {
      id: 's-legacy',
      workspaceRootPath: '/tmp/ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    };
    for (const [persisted, resolved] of [
      ['safe', 'plan'],
      ['ask', 'default'],
      ['allow-all', 'bypassPermissions'],
    ] as const) {
      writeFileSync(sessionFile, `${JSON.stringify({ ...base, permissionMode: persisted })}\n`, 'utf-8');
      expect(readSessionHeader(sessionFile)?.permissionMode, persisted).toBe(resolved);
    }
  });

  it("resolves Claude's vocabulary in the header and deletes an unknown mode exactly as before", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-mode-claude-'));
    tempDirs.push(sessionDir);

    const sessionFile = join(sessionDir, 'session.jsonl');
    const base = {
      id: 's3',
      workspaceRootPath: '/tmp/ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    };

    writeFileSync(
      sessionFile,
      `${JSON.stringify({ ...base, permissionMode: 'default', previousPermissionMode: 'bypassPermissions' })}\n`,
      'utf-8',
    );
    let header = readSessionHeader(sessionFile);
    expect(header?.permissionMode).toBe('default');
    expect(header?.previousPermissionMode).toBe('bypassPermissions');

    writeFileSync(
      sessionFile,
      `${JSON.stringify({ ...base, permissionMode: 'sudo', previousPermissionMode: 'manual' })}\n`,
      'utf-8',
    );
    header = readSessionHeader(sessionFile);
    expect(header?.permissionMode).toBeUndefined();
    expect(header?.previousPermissionMode).toBe('default');
  });

  it('normalizes the four nested mode fields on load and leaves unknown nested spellings as-is', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-mode-nested-'));
    tempDirs.push(sessionDir);

    const sessionFile = join(sessionDir, 'session.jsonl');
    const header = {
      id: 's4',
      workspaceRootPath: '/tmp/ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      permissionMode: 'acceptEdits',
      planModeState: { schemaVersion: 1, kind: 'planning', revision: 1, previousMode: 'execute' },
      piChildRestrictions: {
        prompt: 'p', model: 'm', tools: [], thinkingLevel: 'think',
        worktreePolicy: 'shared', permissionMode: 'default',
      },
      deferredToolCall: {
        schemaVersion: 1, toolUseId: 't1', toolName: 'bash', input: {},
        permissionMode: 'bypassPermissions', deferredAt: Date.now(),
      },
      childSessionState: {
        schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [],
        children: [{
          schemaVersion: 1, agentId: 'a1',
          parentSessionKey: { workspaceId: 'w', sessionId: 's4' },
          childSessionKey: { workspaceId: 'w', sessionId: 'c1' },
          agent: 'child', task: 't', background: false,
          restrictions: {
            prompt: 'p', model: 'm', tools: [], thinkingLevel: 'think',
            worktreePolicy: 'shared', permissionMode: 'unrecognized-mode',
          },
          budgets: {
            depth: 1, maxDepth: 2, fanout: 1, concurrency: 1,
            tokenLimit: 1, costLimitUsd: 1, deadlineAt: 1, ancestry: [],
          },
          status: 'completed', output: '', createdAt: 1, updatedAt: 1,
        }],
      },
    };

    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf-8');

    const loaded = readSessionHeader(sessionFile);
    expect(loaded?.planModeState).toMatchObject({ kind: 'planning', previousMode: 'bypassPermissions' });
    expect(loaded?.piChildRestrictions?.permissionMode).toBe('default');
    expect(loaded?.deferredToolCall?.permissionMode).toBe('bypassPermissions');
    // An unknown nested spelling stays raw (never deleted): downstream
    // consumers already treat it defensively, and that behavior is pinned.
    expect(loaded?.childSessionState?.children[0]?.restrictions.permissionMode).toBe(
      'unrecognized-mode' as never,
    );
  });
});

describe('session jsonl: bounded header reads', () => {
  it('reads a valid header larger than 8 KiB through sync and async APIs', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-large-header-'));
    tempDirs.push(sessionDir);

    const sessionFile = join(sessionDir, 'session.jsonl');
    const header = {
      id: 'large-header',
      workspaceRootPath: '/tmp/ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
      name: 'x'.repeat(96 * 1024),
    };

    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf-8');

    expect(readSessionHeader(sessionFile)?.name).toBe(header.name);
    expect((await readSessionHeaderAsync(sessionFile))?.name).toBe(header.name);
  });

  it('fails closed for over-cap and invalid headers', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-invalid-header-'));
    tempDirs.push(sessionDir);

    const sessionFile = join(sessionDir, 'session.jsonl');
    const overCapHeader = {
      id: 'over-cap',
      name: 'x'.repeat(1024 * 1024),
    };
    writeFileSync(sessionFile, `${JSON.stringify(overCapHeader)}\n`, 'utf-8');

    expect(readSessionHeader(sessionFile)).toBeNull();
    expect(await readSessionHeaderAsync(sessionFile)).toBeNull();

    writeFileSync(sessionFile, '{"id":\n', 'utf-8');
    expect(readSessionHeader(sessionFile)).toBeNull();
    expect(await readSessionHeaderAsync(sessionFile)).toBeNull();
  });
});

describe('session jsonl: F1.1053 — a stored explore round-trips as plan', () => {
  it('reads explore as plan in the header and in the subagent records it carries, and the rewrite never says explore', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-mode-retired-'));
    tempDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'session.jsonl');
    const restrictions = { prompt: 'p', model: 'm', tools: [], thinkingLevel: 'think', worktreePolicy: 'shared', permissionMode: 'explore' };
    writeFileSync(sessionFile, `${JSON.stringify({
      id: 's-f1053',
      workspaceRootPath: '/tmp/ws',
      createdAt: 1,
      lastUsedAt: 1,
      messageCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      permissionMode: 'explore',
      previousPermissionMode: 'explore',
      planModeState: { schemaVersion: 1, kind: 'planning', revision: 1, previousMode: 'explore' },
      piChildRestrictions: restrictions,
      childSessionState: {
        schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [],
        children: [{
          schemaVersion: 1, agentId: 'a1',
          parentSessionKey: { workspaceId: 'w', sessionId: 's-f1053' },
          childSessionKey: { workspaceId: 'w', sessionId: 'c1' },
          agent: 'child', task: 't', background: false, restrictions,
          budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 1, costLimitUsd: 1, deadlineAt: 1, ancestry: [] },
          status: 'completed', output: '', createdAt: 1, updatedAt: 1,
        }],
      },
    })}\n`, 'utf-8');
    expect(readFileSync(sessionFile, 'utf-8')).toContain('"explore"'); // the needle below is spellable in this file

    const loaded = readSessionJsonl(sessionFile);
    expect([
      loaded?.permissionMode,
      loaded?.previousPermissionMode,
      loaded?.planModeState?.kind === 'planning' ? loaded.planModeState.previousMode : undefined,
      loaded?.piChildRestrictions?.permissionMode,
      loaded?.childSessionState?.children[0]?.restrictions.permissionMode,
    ]).toEqual(['plan', 'plan', 'plan', 'plan', 'plan']);

    writeSessionJsonl(sessionFile, loaded!);
    const rewritten = readFileSync(sessionFile, 'utf-8');
    expect(rewritten).toContain('"permissionMode":"plan"');
    expect(rewritten).not.toContain('"explore"');
  });
});
