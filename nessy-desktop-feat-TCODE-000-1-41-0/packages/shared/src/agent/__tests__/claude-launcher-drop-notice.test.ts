/**
 * P6.79 — the launcher-drop announcement, on a surface a person reads.
 *
 * P3.300 scrubs `CLAUDE_CODE_SHELL_PREFIX` / `CLAUDE_CODE_PROCESS_WRAPPER` from
 * the claude child env deliberately and ALOUD, but the sentence went through
 * `debug(...)`, whose `debugEnabled` is computed once at module load from
 * `NESSY_DEBUG === '1'`. A packaged build sets no such variable, so the
 * announcement reached nobody and the drop was silent on the shipped product —
 * the exact state P3.300 refused. Third instance of the class P3.120 fixed for
 * codex and P3.267 / P3.310 fixed twice for claude.
 *
 * Native mechanism, asked and answered: none. The SDK cannot announce a
 * variable the host removed before the child ever saw it, and the host already
 * owns this channel twice (`pendingDegradationNotices` here,
 * `surfaceCodexOperatorNotice` on codex). Step 3 with the reason recorded.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeLauncherDropNotices } from '../claude-agent.ts';
import { CLAUDE_LAUNCHER_ENV_KEYS } from '../../config/claude-provider-routing-env.ts';

describe('buildClaudeLauncherDropNotices', () => {
  it('queues one notice per launcher name that is present', () => {
    const env = { CLAUDE_CODE_SHELL_PREFIX: '/opt/corp/launcher --' } as NodeJS.ProcessEnv;
    const notices = buildClaudeLauncherDropNotices(env);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('CLAUDE_CODE_SHELL_PREFIX');
  });

  it('queues nothing when no launcher name is set — the ordinary session', () => {
    // The negative arm, and the one that decides whether this is a notice or a
    // nag: a session on a machine with no corporate launcher must say nothing.
    expect(buildClaudeLauncherDropNotices({} as NodeJS.ProcessEnv)).toEqual([]);
    // An empty STRING is a set variable, and the scrub in `options.ts` drops it
    // on the same `!== undefined` test — so the two sites agree about what
    // "present" means. Asserted rather than assumed, because disagreeing here
    // would announce a drop that did not happen or hide one that did.
    expect(buildClaudeLauncherDropNotices({ CLAUDE_CODE_PROCESS_WRAPPER: '' } as NodeJS.ProcessEnv))
      .toHaveLength(1);
  });

  it('covers every name in the scrub constant, so a third name cannot go unannounced', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of CLAUDE_LAUNCHER_ENV_KEYS) env[key] = '/opt/corp/launcher';
    const notices = buildClaudeLauncherDropNotices(env);
    expect(notices).toHaveLength(CLAUDE_LAUNCHER_ENV_KEYS.length);
    for (const key of CLAUDE_LAUNCHER_ENV_KEYS) {
      expect(notices.some((n) => n.includes(key))).toBe(true);
    }
  });

  it('says the variable is honoured on NO runtime and names the seam', () => {
    // The row's wording requirement, and it is not decoration. `options.ts`
    // says the binary "would honour it" — true before the scrub, the wrong
    // tense after it. What the reader needs to know is that setting the
    // variable achieves nothing anywhere, and which row would change that.
    const [notice] = buildClaudeLauncherDropNotices(
      { CLAUDE_CODE_SHELL_PREFIX: '/opt/corp/launcher' } as NodeJS.ProcessEnv,
    );
    expect(notice).toContain('no runtime');
    expect(notice).toContain('P6.9');
    // And it must not claim the child honours it, which is what the debug line
    // it replaces as the user-facing copy says.
    expect(notice).not.toContain('would honour');
  });

  it('is queued from postInit before the provider branch, and latched', () => {
    // A source probe: the row requires the detection to sit in `ClaudeAgent`
    // rather than in the pure `buildClaudeSubprocessEnv`, and to reach the
    // LATCHED channel. Neither is visible from the builder's return value.
    const src = readFileSync(join(import.meta.dir, '..', 'claude-agent.ts'), 'utf8');
    const callSite = src.indexOf('buildClaudeLauncherDropNotices(process.env)');
    const earlyReturn = src.indexOf('return await this.startLocalAdapterRuntime(');
    expect(callSite).toBeGreaterThan(0);
    expect(earlyReturn).toBeGreaterThan(callSite);
    // The queue helper latches on the shared set, so a session says it once.
    const helper = src.slice(src.indexOf('private queueDegradationNotice('));
    expect(helper.slice(0, 600)).toContain('this.announcedDegradationLines.has(message)');
    expect(helper.slice(0, 600)).toContain('this.pendingDegradationNotices.push(message)');
    // Positive control on the same probe, so a mis-sliced or empty read cannot
    // pass: the sibling notice path is spelled the same way and is present.
    expect(src).toContain('private surfaceForcedDefaultModeNotice(');
  });
});
