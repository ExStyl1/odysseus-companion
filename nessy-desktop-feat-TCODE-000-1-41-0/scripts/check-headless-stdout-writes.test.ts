/**
 * Tests for `check-headless-stdout-writes.ts` — D1.257.
 *
 * Every arm carrying a NUMBER runs over a SCRATCH directory, for the reason
 * AGENTS.md gives about mutation harnesses: a control that plants a call in the
 * real tree owes an exact restore, and a restore that misses silently
 * invalidates every verdict after it.
 *
 * The real-tree arm is the WEAK one and carries no declared count — a number
 * there is a second ratchet beside `PINNED_CENSUS` and would redden on a
 * sibling lane's commit, which is the cry-wolf control AGENTS.md records wave 17
 * paying for six times.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  census,
  PINNED_CENSUS,
  SLACK_ALLOWANCE,
  slackExceeded,
  STDOUT_WRITE_PATTERN,
  verdict,
} from './check-headless-stdout-writes'

function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'headless-stdout-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body, 'utf-8')
  return root
}

describe('check-headless-stdout-writes', () => {
  test('counts every stdout write, not every line', () => {
    const root = scratch({
      'server.ts': [
        'console.log(`NESSY_SERVER_URL=${url}`)',
        'if (bad) { console.log(a); console.info(b) }',
      ].join('\n'),
    })
    try {
      const result = census({ noIndex: true, root })
      // Three calls over two lines — the whole reason the instrument counts
      // OCCURRENCES: a line count would have answered 2.
      expect(result.occurrences).toBe(3)
      expect(result.files).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('`console.info` and `console.debug` count, because they ARE `console.log`', () => {
    // The measured half of this gate. In Node and Bun both are aliases of
    // `console.log` and write the same fd 1, which is how a DEBUG line reached
    // a stdout capture in D1.232. A census of the one spelling the row names
    // would have reported a clean stream while four such calls wrote to it.
    const root = scratch({
      'aliases.ts': [
        "console.info('[plugin-stage-sweep] removed 3 staging directories')",
        'debug: (...args: unknown[]) => console.debug(...args),',
      ].join('\n'),
    })
    try {
      expect(census({ noIndex: true, root }).occurrences).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('`console.warn` and `console.error` do NOT count — stderr is the right destination', () => {
    const root = scratch({
      'diagnostics.ts': [
        // NEGATIVE: these are the CORRECT destination for a diagnostic, and a
        // gate that counted them would cry wolf on every one of them.
        "console.warn('a config key was ignored')",
        "console.error('the upgrade failed')",
        'warn: (...args: unknown[]) => console.warn(fmt(args)),',
        // POSITIVE on the same instrument in the same file, so the zero above
        // is the pattern discriminating and not the probe failing to read.
        "console.log('on the handshake stream')",
      ].join('\n'),
    })
    try {
      expect(census({ noIndex: true, root }).occurrences).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a platform-logger call does not count, which is the conversion the message asks for', () => {
    const root = scratch({
      'handler.ts': [
        "deps.platform.logger.info('Started transfer')",
        "process.stderr.write('a line\\n')",
      ].join('\n'),
    })
    try {
      expect(census({ noIndex: true, root }).occurrences).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the pattern names the three stdout methods rather than matching any member', () => {
    // Load-bearing: a `console\.\w+` form would swallow `warn` and `error` and
    // the gate would be reporting correct diagnostics forever.
    expect(STDOUT_WRITE_PATTERN).toContain('log|info|debug')
    expect(STDOUT_WRITE_PATTERN).not.toContain('\\w+')
  })

  test('the ratchet fails on a RISE and asks for a lower pin on a FALL', () => {
    expect(verdict(18, 17)).toBe('rose')
    expect(verdict(17, 17)).toBe('unchanged')
    expect(verdict(16, 17)).toBe('fell')
    expect(verdict(PINNED_CENSUS)).toBe('unchanged')
    expect(verdict(PINNED_CENSUS + 1)).toBe('rose')
  })

test('D1.275 — a pin the tree left behind is a FAILURE past the stated allowance', () => {
    // A ratchet only stops a rise, so a pin nobody lowers drifts upward in
    // silence and then tolerates that many new sites. Same shape as `verdict`
    // above: driven on numbers, never on the live census, so a sibling lane's
    // commit cannot make this case red for the wrong reason.
    expect(slackExceeded(35, 35)).toBe(false)
    expect(slackExceeded(34, 35)).toBe(false)
    // At the allowance it is still a reminder, not a red.
    expect(slackExceeded(33, 35)).toBe(false)
    expect(slackExceeded(32, 35)).toBe(true)
    // A RISE is the other gate's business and must not read as slack.
    expect(slackExceeded(36, 35)).toBe(false)
    // The default arguments really are the pin and the allowance, so the helper
    // and the gate cannot drift apart.
    expect(SLACK_ALLOWANCE).toBeGreaterThan(0)
    expect(slackExceeded(PINNED_CENSUS - SLACK_ALLOWANCE)).toBe(false)
    expect(slackExceeded(PINNED_CENSUS - SLACK_ALLOWANCE - 1)).toBe(true)
  })

  test('the real tree is scanned and the probe can see it', () => {
    // No number, on purpose — see this file's docblock. The handshake lines
    // themselves guarantee a non-zero answer, which is what makes the script's
    // own zero-refusal meaningful.
    expect(census().occurrences).toBeGreaterThan(0)
    expect(PINNED_CENSUS).toBeGreaterThan(0)
  })
})
