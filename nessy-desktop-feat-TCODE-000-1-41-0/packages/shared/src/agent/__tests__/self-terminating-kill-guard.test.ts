import { describe, it, expect } from 'bun:test';
import { getSelfTerminatingKillPattern, shouldAllowToolInMode } from '../mode-manager.ts';

/**
 * P6.212 — a `pkill` whose pattern matches the agent's own process ends the
 * session mid-turn. The guard is mode-INDEPENDENT (it sits above the
 * `bypassPermissions` early return), so both the positive case and the control
 * are asserted in `bypassPermissions`, the mode that allows everything else.
 */
describe('self-terminating pkill guard', () => {
  const ownName = process.execPath.split(/[\\/]/).pop() ?? '';

  it('matches a pattern that names our own executable', () => {
    const hit = getSelfTerminatingKillPattern(`pkill ${ownName}`);
    expect(hit?.pattern).toBe(ownName);
  });

  it('leaves an unrelated pattern alone (the control)', () => {
    expect(getSelfTerminatingKillPattern('pkill some-unrelated-daemon-xyz')).toBeNull();
  });

  it('matches the full argv only under -f', () => {
    // D1.440 — this case OWNS the argv it is asserting about, and the sentence
    // it replaces is why. It read:
    //
    //   "`process.argv` carries this test file's path; the bare name form must
    //    not see it, and the -f form must"
    //
    // …and pinned its own basename, `self-terminating-kill-guard`. What a bun
    // test worker puts in `process.argv` is the RUNNER's business, not ours:
    // measured 2026-09-20, a worker on this machine carries
    // `[execPath, <this file's path>]` — so the old form passed here — while the
    // CI runner's carried nothing of the sort and the `-f` arm returned null.
    // Same bytes, opposite verdicts, and the red read as a broken guard.
    //
    // `getSelfTerminatingKillPattern` reads `process.argv.join(' ')` for the
    // `-f` form and `[basename(execPath), process.argv0]` for the bare one, so
    // planting a marker in argv tests exactly the documented difference and
    // nothing about the machine. Restored in `finally`, in this same
    // synchronous body, so no other case can see it.
    const marker = 'nessy-argv-marker-d1440';
    const originalArgv = process.argv;
    try {
      process.argv = [process.execPath, `/nonexistent/${marker}.ts`];
      // The marker is in the full argv and in NEITHER bare subject, which is
      // what makes the pair discriminate rather than agree.
      expect(process.execPath).not.toContain(marker);
      expect(process.argv0 ?? '').not.toContain(marker);
      expect(getSelfTerminatingKillPattern(`pkill ${marker}`)).toBeNull();
      expect(getSelfTerminatingKillPattern(`pkill -f ${marker}`)?.pattern).toBe(marker);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('does not read a value-taking option’s value as the pattern', () => {
    // `pkill -u <name>` selects by USER. Reading `ownName` here as a pattern is
    // the false positive PKILL_VALUE_OPTIONS exists to prevent.
    expect(getSelfTerminatingKillPattern(`pkill -u ${ownName}`)).toBeNull();
    // ...while an attached signal flag still leaves the pattern readable.
    expect(getSelfTerminatingKillPattern(`pkill -9 ${ownName}`)?.pattern).toBe(ownName);
  });

  it('sees a pkill hidden behind a shell separator', () => {
    expect(getSelfTerminatingKillPattern(`echo hi && pkill ${ownName}`)?.pattern).toBe(ownName);
  });

  it('fails OPEN on an unparseable ERE rather than refusing on a guess', () => {
    expect(getSelfTerminatingKillPattern('pkill "["')).toBeNull();
  });

  it('refuses the call in bypassPermissions, and lets the unrelated one through', () => {
    const blocked = shouldAllowToolInMode('Bash', { command: `pkill ${ownName}` }, 'bypassPermissions');
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed === false && blocked.reason).toContain('Self-terminating command blocked');

    const allowed = shouldAllowToolInMode(
      'Bash',
      { command: 'pkill some-unrelated-daemon-xyz' },
      'bypassPermissions'
    );
    expect(allowed.allowed).toBe(true);
  });
});
