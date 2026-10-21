/*
 * Source: v0.15.1:apps/electron/src/renderer/lib/__tests__/run-command-message.test.ts (craft-agents-oss,
 * Apache-2.0), taken 1:1 by UB14.16. Positive: a bash fence plus the background instruction. Boundary: a
 * command holding a triple backtick gets a four-backtick fence.
 */
import { describe, expect, it } from 'bun:test'
import { runCommandMessage } from '../run-command-message'

describe('runCommandMessage', () => {
  it('asks for a background Bash run of the command in a bash fence', () => {
    expect(runCommandMessage('bun test')).toBe(
      'Run this in the background (Bash with run_in_background: true), then continue without waiting for it:\n\n```bash\nbun test\n```',
    )
  })

  it('uses a fence longer than any backtick run in the command', () => {
    const message = runCommandMessage('echo "```done```"')
    expect(message).toContain('````bash\necho "```done```"\n````')
  })
})
