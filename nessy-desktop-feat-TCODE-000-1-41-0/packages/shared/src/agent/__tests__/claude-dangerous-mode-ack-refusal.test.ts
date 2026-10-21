/**
 * P6.495 · a repository cannot suppress the dangerous-mode confirmation, and
 * when one tries it hears about it by name.
 *
 * Q-den 4 = option B. The suite pins the three things the row's `done_means`
 * asks for and nothing more: the refusal names the key and the scope; the same
 * file's other keys still apply (the positive control, so this is a NAMED
 * refusal and not a file being thrown away); and the confirmation itself is not
 * removable, which is the host's own gate and not the vendor's.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_DANGEROUS_MODE_ACK_SETTING_KEY,
  formatClaudeDangerousModeAckRefusal,
  readClaudeDangerousModeAckScopes,
} from '../claude-dangerous-mode-settings.ts';
import { readClaudeProjectSettingsKeys } from '../claude-shell-command-settings.ts';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'w8e-dangerous-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, '.claude', name), body, 'utf-8');
  }
  return root;
}

describe('P6.495 · skipDangerousModePermissionPrompt is refused by name', () => {
  it('positive — names the local scope, and the same file\'s other keys still apply', () => {
    const root = project({
      'settings.local.json': JSON.stringify({
        [CLAUDE_DANGEROUS_MODE_ACK_SETTING_KEY]: true,
        permissions: { deny: ['Bash(rm:*)'] },
      }),
    });
    try {
      const scopes = readClaudeDangerousModeAckScopes(root);
      expect(scopes).toEqual(['local']);

      const [line] = formatClaudeDangerousModeAckRefusal(scopes);
      expect(line).toContain(CLAUDE_DANGEROUS_MODE_ACK_SETTING_KEY);
      expect(line).toContain('.claude/settings.local.json');
      // The scope is not just named, it is characterised: this is the tier the
      // vendored child actually reads the key from.
      expect(line).toContain('does read the local file');

      // POSITIVE CONTROL — the refusal is of ONE key, not of the file. The
      // reader every other consumer of these files uses still sees `permissions`.
      expect(readClaudeProjectSettingsKeys(root)).toContain('permissions');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('project scope is named as INERT, because the child does not read it there', () => {
    // Measured against the shipped 2.1.247 binary (re-read 2026-09-12, C3.252;
    // first taken at 2.1.233 and unchanged in substance): the reader is an OR
    // over userSettings / localSettings / flagSettings / policySettings, and
    // `projectSettings` is not among them — which corrects the row's headline.
    // The body is transcribed in `claude-dangerous-mode-settings.ts`.
    const root = project({
      'settings.json': JSON.stringify({ [CLAUDE_DANGEROUS_MODE_ACK_SETTING_KEY]: true }),
    });
    try {
      expect(readClaudeDangerousModeAckScopes(root)).toEqual(['project']);
      const [line] = formatClaudeDangerousModeAckRefusal(readClaudeDangerousModeAckScopes(root));
      expect(line).toContain('does not read the project file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('negative — a settings file without the key, and a false value, say nothing', () => {
    const root = project({
      'settings.json': JSON.stringify({ permissions: { deny: [] } }),
      'settings.local.json': JSON.stringify({ [CLAUDE_DANGEROUS_MODE_ACK_SETTING_KEY]: false }),
    });
    try {
      expect(readClaudeDangerousModeAckScopes(root)).toEqual([]);
      expect(formatClaudeDangerousModeAckRefusal([])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an unreadable or absent project contributes nothing, and never throws', () => {
    expect(readClaudeDangerousModeAckScopes(undefined)).toEqual([]);
    expect(readClaudeDangerousModeAckScopes(join(tmpdir(), 'w8e-nonexistent-dir'))).toEqual([]);
  });

  it('the confirmation the key would remove is the HOST\'s, and reads no .claude file', async () => {
    // The block, pinned where it lives. `getBypassPermissionsAcknowledged` reads
    // `bypassPermissionsAcknowledged` from config.json and nothing else; if a
    // later change taught it to consult a settings file, this dies.
    const storage = await Bun.file(
      new URL('../../config/storage.ts', import.meta.url).pathname,
    ).text();
    expect(storage).toContain('bypassPermissionsAcknowledged');
    expect(storage).not.toContain(CLAUDE_DANGEROUS_MODE_ACK_SETTING_KEY);

    // And the refusal is WIRED, not merely exported — C3.304 moved that wiring
    // from the claude spawn path to the host seam, because the block it
    // discloses is the host's on all three runtimes and a line only claude
    // queued reached one of them. Both halves are asserted together so the pair
    // cannot be satisfied by deleting both (AGENTS.md §Traps, the stale-NAME
    // guard class).
    const manager = await Bun.file(
      new URL('../../../../server-core/src/sessions/SessionManager.ts', import.meta.url).pathname,
    ).text();
    expect(manager).toContain('formatClaudeDangerousModeAckRefusal(ackScopes)');
    expect(manager).toContain('this.warnIfClaudeSettingsCarryRefusedKeys(managed)');
    const agent = await Bun.file(
      new URL('../claude-agent.ts', import.meta.url).pathname,
    ).text();
    expect(agent).not.toContain('formatClaudeDangerousModeAckRefusal(');
  });
});
