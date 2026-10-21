/**
 * C3.18 · a repository cannot widen the permission posture from a file in the
 * checkout, and when one tries it hears about it by name and by scope.
 *
 * The row's `done_means` asks for three things and this suite pins exactly
 * those: a project or local `defaultMode` of `auto` or `bypassPermissions` is
 * refused with a diagnostic NAMING THE SCOPE; a USER-scope `bypassPermissions`
 * is still honoured — the control without which a scope restriction cannot be
 * told apart from a dead reader; and the wiring is on the ONE host seam all
 * three runtimes already share, rather than in the claude arm alone.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_DEFAULT_MODE_SETTING_PATH,
  CLAUDE_WIDENING_DEFAULT_MODES,
  claudeDefaultModeTakesEffect,
  formatClaudeWideningDefaultModeRefusal,
  readClaudeWideningDefaultModeScopes,
} from '../claude-default-mode-scope.ts';
import { readClaudeProjectSettingsKeys } from '../claude-shell-command-settings.ts';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'w17h-default-mode-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, '.claude', name), body, 'utf-8');
  }
  return root;
}

describe('C3.18 · permissions.defaultMode is refused by SCOPE, not by value', () => {
  it('the predicate refuses both widening values at project and local, and neither at user', () => {
    // THE CONTROL, first and by itself: the same two values in the user's own
    // file are honoured. `settings-reference.md#permissions-defaultmode` —
    // "set them in `~/.claude/settings.json` instead".
    for (const value of CLAUDE_WIDENING_DEFAULT_MODES) {
      expect(claudeDefaultModeTakesEffect(value, 'user')).toBe(true);
      expect(claudeDefaultModeTakesEffect(value, 'project')).toBe(false);
      expect(claudeDefaultModeTakesEffect(value, 'local')).toBe(false);
    }
    // And it is a SCOPE restriction, not a value allowlist: every narrowing or
    // holding mode still takes effect from a repository file. A refusal wider
    // than the page would break a repository that starts its sessions in `plan`.
    for (const value of ['default', 'acceptEdits', 'plan', 'dontAsk', 'manual']) {
      expect(claudeDefaultModeTakesEffect(value, 'project')).toBe(true);
      expect(claudeDefaultModeTakesEffect(value, 'local')).toBe(true);
    }
  });

  it('positive — a project file naming bypassPermissions is refused, scope named', () => {
    const root = project({
      'settings.json': JSON.stringify({
        permissions: { defaultMode: 'bypassPermissions', deny: ['Bash(rm:*)'] },
      }),
    });
    try {
      expect(readClaudeWideningDefaultModeScopes(root))
        .toEqual([{ scope: 'project', value: 'bypassPermissions' }]);

      const [line] = formatClaudeWideningDefaultModeRefusal(
        readClaudeWideningDefaultModeScopes(root),
      );
      expect(line).toContain(CLAUDE_DEFAULT_MODE_SETTING_PATH);
      expect(line).toContain('bypassPermissions');
      // The SCOPE, as the file the operator would edit — "which file" is their
      // next question — and the file the value WOULD be honoured in.
      expect(line).toContain('.claude/settings.json');
      expect(line).toContain('~/.claude/settings.json');

      // POSITIVE CONTROL — the refusal is of ONE key, not of the file. The
      // reader every other consumer of these files uses still sees `permissions`,
      // so the `deny` rule beside it is still applied.
      expect(readClaudeProjectSettingsKeys(root)).toContain('permissions');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('positive — the local scope and `auto` are named too, in project-then-local order', () => {
    const root = project({
      'settings.json': JSON.stringify({ permissions: { defaultMode: 'auto' } }),
      'settings.local.json': JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }),
    });
    try {
      expect(readClaudeWideningDefaultModeScopes(root)).toEqual([
        { scope: 'project', value: 'auto' },
        { scope: 'local', value: 'bypassPermissions' },
      ]);
      const lines = formatClaudeWideningDefaultModeRefusal(
        readClaudeWideningDefaultModeScopes(root),
      );
      // ONE line however many scopes are involved — a diagnostic that repeats
      // itself per file is one nobody reads.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('.claude/settings.local.json');
      expect(lines[0]).toContain('auto');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('negative — a narrowing mode, no permissions block, and no file say nothing', () => {
    const root = project({
      'settings.json': JSON.stringify({ permissions: { defaultMode: 'plan' } }),
      'settings.local.json': JSON.stringify({ permissions: { deny: [] } }),
    });
    try {
      expect(readClaudeWideningDefaultModeScopes(root)).toEqual([]);
      expect(formatClaudeWideningDefaultModeRefusal([])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(readClaudeWideningDefaultModeScopes(undefined)).toEqual([]);
    expect(readClaudeWideningDefaultModeScopes(join(tmpdir(), 'w17h-nonexistent-dir'))).toEqual([]);
  });

  it('an unparseable or non-object settings file is a SKIP, never a throw', () => {
    const root = project({
      'settings.json': '{ not json at all',
      'settings.local.json': JSON.stringify(['an array is not a settings file']),
    });
    try {
      expect(readClaudeWideningDefaultModeScopes(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the refusal is wired on the HOST seam all three runtimes share, not in one arm', async () => {
    // The row's own words: "the predicate is one and shared, so it belongs in
    // the host rather than in the claude arm alone". The seam is
    // `sendEvent({ type: 'info', level: 'warning' })` in `SessionManager`, the
    // same one `announceModelDefaultSubstitution` uses precisely because Pi,
    // Claude and Codex all reach it without being taught to.
    const manager = await Bun.file(
      new URL('../../../../server-core/src/sessions/SessionManager.ts', import.meta.url).pathname,
    ).text();
    expect(manager).toContain('readClaudeWideningDefaultModeScopes(managed.workingDirectory)');
    expect(manager).toContain('this.warnIfProjectSettingsWidenDefaultMode(managed)');
    // NEGATIVE, and the point of the row: it is NOT a line in the claude arm.
    // Guard the CALL, not the identifier (AGENTS.md, the stale-name-guard trap):
    // C3.331's docblock in claude-agent.ts names the function as prose while
    // calling nothing, and a bare-identifier guard read that mention as a call
    // from 2026-09-12 until CI's test job surfaced it on 2026-09-20 (D1.433).
    // The positive arm above keeps this from being satisfiable by deletion.
    const claudeAgent = await Bun.file(
      new URL('../claude-agent.ts', import.meta.url).pathname,
    ).text();
    expect(claudeAgent).not.toContain('formatClaudeWideningDefaultModeRefusal(');
  });
});
