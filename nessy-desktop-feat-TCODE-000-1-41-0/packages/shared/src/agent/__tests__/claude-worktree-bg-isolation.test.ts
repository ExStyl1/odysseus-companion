/**
 * P6.134 — the user's `worktree.bgIsolation` choice, forwarded to the runtime
 * that would enforce it, and PINNED so a lane that deletes the forwarding goes
 * red.
 *
 * The pre-fix direction was INVERTED, which is why this is not cosmetic. We set
 * no SDK worktree option at all; the SDK's unset default is `'worktree'`
 * (`sdk.d.ts`, and `settings-reference.md#worktree-bgisolation` in the same
 * words) while our resolved default is `'none'` — with a recorded reason:
 * `EnterWorktree` is pi-only in this fork, so on a claude session the block has
 * no release valve and an unliftable write block reads as a bug. A user who
 * chose `'none'` therefore ran a child with the isolation ON.
 *
 * Native-first, and tier 1 is NOT empty here: the runtime owns the key and we
 * simply never wrote it. Only `bgIsolation` is forwarded — its three siblings
 * govern worktree CREATION, which our lease service does on all three runtimes.
 *
 * The doc row alone cannot hold this: `runtime-capability-gaps-doc.test.ts`
 * checks only the codex row's backticked TOOL NAMES either side of its crossed
 * sentinel, and its own docblock says "prose is not checkable". So this file is
 * the source-probe pin, on the `claude-agent-guardian-free.test.ts` precedent,
 * with a positive control on the same read.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildClaudeWorktreeSettings,
  composeClaudeSpawnSettings,
} from '../claude-agent.ts';
import { resolveWorktreeSettings } from '../../config/worktree-settings.ts';

const AGENT_SOURCE = readFileSync(join(import.meta.dir, '..', 'claude-agent.ts'), 'utf8');
const GAPS_DOC = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'docs', 'architecture', 'runtime-capability-gaps.md'),
  'utf8',
);

describe('buildClaudeWorktreeSettings', () => {
  it('carries both values through unchanged', () => {
    expect(buildClaudeWorktreeSettings('none')).toEqual({ worktree: { bgIsolation: 'none' } });
    expect(buildClaudeWorktreeSettings('worktree')).toEqual({ worktree: { bgIsolation: 'worktree' } });
  });

  it('is fed the HOST resolver, whose default is the opposite of the SDK unset default', () => {
    // The whole reason the option is written unconditionally. Our resolver
    // answers 'none' for an empty layer stack; the SDK's docblock says its
    // unset default is 'worktree'. Omitting the option did not leave the choice
    // unenforced, it inverted it.
    expect(resolveWorktreeSettings([]).bgIsolation).toBe('none');
    expect(resolveWorktreeSettings([{ bgIsolation: 'worktree' }]).bgIsolation).toBe('worktree');
  });
});

describe('composeClaudeSpawnSettings', () => {
  it('merges the contributors by key so the one settings option carries both', () => {
    const merged = composeClaudeSpawnSettings({
      flags: { permissions: { deny: ['Read(//etc/**)'] } } as never,
      worktree: buildClaudeWorktreeSettings('none'),
    });
    expect(merged.settings).toEqual({
      permissions: { deny: ['Read(//etc/**)'] },
      worktree: { bgIsolation: 'none' },
    } as never);
  });

  it('REFUSES a key collision out loud, keeping the first writer', () => {
    // The near miss this seam exists for: `settings` is ONE option, so a silent
    // last-writer-wins would delete P3.147's credential floor from a spawn with
    // no error and no log line.
    const heard: string[] = [];
    const merged = composeClaudeSpawnSettings({
      first: { worktree: { bgIsolation: 'none' } } as never,
      second: { worktree: { bgIsolation: 'worktree' } } as never,
    }, (message) => heard.push(message));
    expect(merged.settings).toEqual({ worktree: { bgIsolation: 'none' } } as never);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('worktree');
    expect(heard[0]).toContain('first');
    expect(heard[0]).toContain('second');
  });

  it('refuses a settings FILE PATH whole, and says so', () => {
    const heard: string[] = [];
    const merged = composeClaudeSpawnSettings({
      path: '/etc/claude/settings.json',
      worktree: buildClaudeWorktreeSettings('none'),
    }, (message) => heard.push(message));
    expect(merged.settings).toEqual({ worktree: { bgIsolation: 'none' } } as never);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('path');
  });

  it('is absent with nothing to say, so a spawn without it is byte-identical', () => {
    expect(composeClaudeSpawnSettings({})).toEqual({});
    expect(composeClaudeSpawnSettings({ a: undefined })).toEqual({});
  });
});

describe('the pin — the forwarding is wired, and the doc row exists', () => {
  it('resolves the setting and hands it to the settings seam at the spawn', () => {
    // A lane that deletes the forwarding makes this red, which is the whole
    // point: the doc row below cannot hold it, and the behaviour is a closed
    // binary's refusal that no unit test can observe directly.
    expect(AGENT_SOURCE).toContain('buildClaudeWorktreeSettings(');
    expect(AGENT_SOURCE).toContain('resolveWorktreeSettings([getUserWorktreeSettings()]).bgIsolation');
    // Exactly one `settings` key in the options literal, produced by one merge.
    expect(AGENT_SOURCE.split('composeClaudeSpawnSettings(').length - 1).toBe(2);
    // Positive control on the same read: a name that is certainly in this file.
    expect(AGENT_SOURCE).toContain('buildClaudeFlagSettingsOptions(');
    // Negative control, so a probe that matches everything cannot pass.
    expect(AGENT_SOURCE).not.toContain('ZZQQ_NOT_A_REAL_SYMBOL');
  });

  it('states the codex residual in the gaps doc, where the disclosure belongs', () => {
    expect(GAPS_DOC).toContain('`worktree.bgIsolation` has nothing to enforce it');
    expect(GAPS_DOC).toContain('P6.134');
    // The row must keep naming the runtime it is about; the positive control is
    // the section heading it sits under.
    expect(GAPS_DOC).toContain('## Codex — the app-server runtime');
  });
});
