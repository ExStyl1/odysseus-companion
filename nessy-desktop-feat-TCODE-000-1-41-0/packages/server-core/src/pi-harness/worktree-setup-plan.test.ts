import { describe, expect, it } from 'bun:test'

import {
  WORKTREE_SETUP_TIMEOUT_MS,
  describeWorktreeSetupOutcome,
  worktreeSetupCommand,
} from './worktree-setup-plan.ts'

describe('worktreeSetupCommand', () => {
  it('runs in the WORKTREE, never the repository', () => {
    const command = worktreeSetupCommand({
      worktreePath: '/parent/.nessy-worktrees/repo/lease-1',
      script: 'bun install',
      platform: 'darwin',
    })
    expect(command.cwd).toBe('/parent/.nessy-worktrees/repo/lease-1')
    expect(command.operation).toBe('setup-script')
    expect(command.timeoutMs).toBe(WORKTREE_SETUP_TIMEOUT_MS)
    // Far above the 60s worktree-git budget: installing dependencies is the
    // reason the key exists.
    expect(WORKTREE_SETUP_TIMEOUT_MS).toBeGreaterThan(60_000)
  })

  it('passes the script as ONE argv element to a host-selected interpreter', () => {
    // Nothing around the script is built from the script, so there is no
    // quoting rule to get wrong: a setting full of quotes and semicolons is
    // still exactly one argument.
    const nasty = `echo "a b"; rm -rf $HOME && echo 'done'`
    const posix = worktreeSetupCommand({ worktreePath: '/w', script: nasty, platform: 'linux' })
    expect(posix.program).toBe('/bin/sh')
    expect(posix.args).toEqual(['-c', nasty])
    const windows = worktreeSetupCommand({ worktreePath: 'C:\\w', script: nasty, platform: 'win32' })
    expect(windows.args).toEqual(['/d', '/s', '/c', nasty])
    expect(windows.program.toLowerCase()).toContain('cmd')
  })

  it('trims the script so the executed string matches the consented one', () => {
    expect(worktreeSetupCommand({ worktreePath: '/w', script: '  bun install\n', platform: 'linux' }).args)
      .toEqual(['-c', 'bun install'])
  })
})

describe('describeWorktreeSetupOutcome', () => {
  it('says the script ran, with its exit status and output', () => {
    const text = describeWorktreeSetupOutcome({
      worktreePath: '/w',
      script: 'bun install',
      outcome: { kind: 'ran', output: 'installed 42 packages\n', exitCode: 0 },
    })
    expect(text).toContain('/w')
    expect(text).toContain('exit 0')
    expect(text).toContain('$ bun install')
    expect(text).toContain('installed 42 packages')
  })

  it('never stays silent about a refusal or a failure', () => {
    // A silent refusal reads as a script that ran and did nothing; a silent
    // failure reads as one that succeeded. The session's next act is to assume
    // its dependencies are installed.
    const refused = describeWorktreeSetupOutcome({
      worktreePath: '/w', script: 'bun install', outcome: { kind: 'refused' },
    })
    expect(refused).toContain('you declined')
    expect(refused).toContain('The worktree was created without it.')
    const failed = describeWorktreeSetupOutcome({
      worktreePath: '/w', script: 'bun install', outcome: { kind: 'failed', reason: 'no repository root' },
    })
    expect(failed).toContain('no repository root')
    expect(failed).toContain('The worktree was created without it.')
  })

  it('reports a non-zero exit and a kill without dressing either up', () => {
    expect(describeWorktreeSetupOutcome({
      worktreePath: '/w', script: 's', outcome: { kind: 'ran', output: 'boom', exitCode: 127 },
    })).toContain('exit 127')
    expect(describeWorktreeSetupOutcome({
      worktreePath: '/w', script: 's', outcome: { kind: 'ran', output: '', exitCode: null },
    })).toContain('killed before it exited')
    expect(describeWorktreeSetupOutcome({
      worktreePath: '/w', script: 's', outcome: { kind: 'ran', output: '   ', exitCode: 0 },
    })).toContain('(no output)')
  })

  it('keeps the TAIL of a huge log, where the failure is', () => {
    const output = `${'a'.repeat(20_000)}ERROR: the last line`
    const text = describeWorktreeSetupOutcome({
      worktreePath: '/w', script: 'bun install', outcome: { kind: 'ran', output, exitCode: 1 },
    })
    expect(text).toContain('ERROR: the last line')
    expect(text).toContain('earlier characters omitted')
    expect(text.length).toBeLessThan(9_000)
  })
})
