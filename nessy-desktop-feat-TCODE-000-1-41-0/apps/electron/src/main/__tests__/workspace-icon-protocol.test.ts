import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceIconPath } from '../workspace-icon-protocol.ts';

describe('workspace icon protocol path resolution', () => {
  it('accepts only a contained icon filename', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-workspace-icon-'));
    try {
      expect(resolveWorkspaceIconPath(workspaceRoot, 'icon.svg')).toBe(join(workspaceRoot, 'icon.svg'));
      expect(() => resolveWorkspaceIconPath(workspaceRoot, '../icon.svg')).toThrow();
      expect(() => resolveWorkspaceIconPath(workspaceRoot, '/tmp/icon.svg')).toThrow();
      expect(() => resolveWorkspaceIconPath(workspaceRoot, 'icons/icon.svg')).toThrow();
      expect(() => resolveWorkspaceIconPath(workspaceRoot, 'icon.txt')).toThrow();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects an icon symlink that escapes the workspace root', () => {
    if (process.platform === 'win32') return;

    const base = mkdtempSync(join(tmpdir(), 'nessy-workspace-icon-'));
    const workspaceRoot = join(base, 'workspace');
    try {
      const outside = join(base, 'outside');
      mkdirSync(workspaceRoot, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(workspaceRoot, 'icon.svg'), 'dir');
      expect(() => resolveWorkspaceIconPath(workspaceRoot, 'icon.svg')).toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
