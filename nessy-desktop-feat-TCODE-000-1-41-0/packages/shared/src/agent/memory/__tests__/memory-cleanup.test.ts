import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AUTO_MEMORY_CLEANUP_INTERVAL_MS,
  cleanupAutoMemoryContent,
  cleanupAutoMemoryFile,
  runScheduledAutoMemoryCleanup,
} from '../memory-cleanup.ts';
import { getSessionMemoryFilePath, getUserMemoryFilePath } from '../memory-store.ts';
import { SESSIONS_DIR } from '../../../workspaces/paths.ts';

const NOW = Date.parse('2026-07-18T12:00:00Z');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nessy-memory-cleanup-'));
}

describe('cleanupAutoMemoryContent', () => {
  it('collapses marked duplicates keeping the newest-dated entry', () => {
    const content = [
      '# Memory',
      '',
      '- Same fact. <!-- nessy:auto:2026-07-01 -->',
      '',
      '- Same fact. <!-- nessy:auto:2026-07-10 -->',
      '',
    ].join('\n');

    const result = cleanupAutoMemoryContent(content, { now: NOW });

    expect(result.changed).toBe(true);
    expect(result.removedDuplicates).toBe(1);
    expect(result.content.match(/Same fact/g)).toHaveLength(1);
    expect(result.content).toContain('<!-- nessy:auto:2026-07-10 -->');
    expect(result.content).not.toContain('2026-07-01');
  });

  it('drops a marked duplicate of an unmarked human line and keeps unmarked bytes identical', () => {
    const humanLines = ['# Memory', '', '- Same fact.', '', 'Loose  human note   with odd spacing.'];
    const content = [...humanLines, '', '- Same fact. <!-- nessy:auto:2026-07-10 -->', ''].join('\n');

    const result = cleanupAutoMemoryContent(content, { now: NOW });

    expect(result.changed).toBe(true);
    expect(result.removedDuplicates).toBe(1);
    expect(result.content).toBe(`${humanLines.join('\n')}\n`);
  });

  it('expires marked entries past the threshold, keeping fresh and unparseable-date entries', () => {
    const content = [
      '- Old note. <!-- nessy:auto:2026-05-01 -->',
      '',
      '- Fresh note. <!-- nessy:auto:2026-07-10 -->',
      '',
      '- Odd note. <!-- nessy:auto:2026-99-99 -->',
      '',
    ].join('\n');

    const result = cleanupAutoMemoryContent(content, { now: NOW, maxAgeDays: 30 });

    expect(result.changed).toBe(true);
    expect(result.removedExpired).toBe(1);
    expect(result.content).not.toContain('Old note.');
    expect(result.content).toContain('- Fresh note. <!-- nessy:auto:2026-07-10 -->');
    // Unparseable marker date is ambiguous — the entry stays.
    expect(result.content).toContain('- Odd note. <!-- nessy:auto:2026-99-99 -->');
  });

  it('is a no-op on unmarked-only content and is idempotent', () => {
    const unmarked = ['# Memory', '', '- Human line only.', ''].join('\n');
    const untouched = cleanupAutoMemoryContent(unmarked, { now: NOW });
    expect(untouched.changed).toBe(false);
    expect(untouched.content).toBe(unmarked);

    // CR line endings are ambiguous — left byte-identical.
    const crlf = '# Memory\r\n\r\n- Old note. <!-- nessy:auto:2020-01-01 -->\r\n';
    expect(cleanupAutoMemoryContent(crlf, { now: NOW }).changed).toBe(false);

    const mixed = [
      '# Memory',
      '',
      '- Human line only.',
      '',
      '- Dup. <!-- nessy:auto:2026-07-01 -->',
      '',
      '- Dup. <!-- nessy:auto:2026-07-10 -->',
      '',
      '- Old note. <!-- nessy:auto:2020-01-01 -->',
      '',
    ].join('\n');
    const first = cleanupAutoMemoryContent(mixed, { now: NOW });
    expect(first.changed).toBe(true);
    const second = cleanupAutoMemoryContent(first.content, { now: NOW });
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });
});

describe('runScheduledAutoMemoryCleanup', () => {
  it('sweeps user and session memory once per daily window (throttle across ticks)', () => {
    const dir = tempDir();
    const userConfigDir = join(dir, 'user');
    const stampFilePath = join(dir, 'memory-cleanup.json');
    const workspaceId = `memory-clean-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionMemoryPath = getSessionMemoryFilePath(workspaceId, 'session-1');
    try {
      mkdirSync(userConfigDir, { recursive: true });
      mkdirSync(dirname(sessionMemoryPath), { recursive: true });
      const stale = '# Memory\n\n- Human note stays.\n\n- Old agent note. <!-- nessy:auto:2020-01-01 -->\n';
      writeFileSync(getUserMemoryFilePath(userConfigDir), stale, 'utf-8');
      writeFileSync(sessionMemoryPath, stale, 'utf-8');

      const first = runScheduledAutoMemoryCleanup({ workspaceId, userConfigDir, stampFilePath, now: NOW });
      expect(first.ran).toBe(true);
      expect(first.filesChanged).toBe(2);
      const cleanedUser = readFileSync(getUserMemoryFilePath(userConfigDir), 'utf-8');
      expect(cleanedUser).toContain('- Human note stays.');
      expect(cleanedUser).not.toContain('Old agent note.');
      expect(readFileSync(sessionMemoryPath, 'utf-8')).not.toContain('Old agent note.');

      // Same day: throttled, even though stale content reappears.
      writeFileSync(getUserMemoryFilePath(userConfigDir), stale, 'utf-8');
      const second = runScheduledAutoMemoryCleanup({
        workspaceId,
        userConfigDir,
        stampFilePath,
        now: NOW + 60_000,
      });
      expect(second.ran).toBe(false);
      expect(readFileSync(getUserMemoryFilePath(userConfigDir), 'utf-8')).toContain('Old agent note.');

      // Next daily window: runs again.
      const third = runScheduledAutoMemoryCleanup({
        workspaceId,
        userConfigDir,
        stampFilePath,
        now: NOW + AUTO_MEMORY_CLEANUP_INTERVAL_MS,
      });
      expect(third.ran).toBe(true);
      expect(readFileSync(getUserMemoryFilePath(userConfigDir), 'utf-8')).not.toContain('Old agent note.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true });
    }
  });

  it('missing files and absent session roots are a clean no-op sweep', () => {
    const dir = tempDir();
    try {
      const result = runScheduledAutoMemoryCleanup({
        workspaceId: `memory-clean-empty-${Date.now()}`,
        userConfigDir: join(dir, 'nonexistent-user'),
        stampFilePath: join(dir, 'memory-cleanup.json'),
        now: NOW,
      });
      expect(result.ran).toBe(true);
      expect(result.filesChanged).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cleanupAutoMemoryFile', () => {
  it('no-ops on a missing file', () => {
    const dir = tempDir();
    try {
      const result = cleanupAutoMemoryFile(join(dir, 'MEMORY.md'), { now: NOW });
      expect(result.changed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
