/**
 * Pins for `check-dp-auth-codes-table.ts`'s enum reader.
 *
 * Born 2026-09-19 from a red `lint:chain`: the reader ended the enum body at
 * the first `}` ANYWHERE, so a member docblock carrying `{@link X}` closed it
 * early, six of eleven members were read, and the three documented codes after
 * that docblock were reported as invented — a correct page, a broken reader,
 * and nothing that said which. The first arm below is that exact shape; the
 * second is the plain enum, so the repair cannot pass by reading nothing.
 */
import { describe, expect, test } from 'bun:test'
import { enumMembers } from './check-dp-auth-codes-table'

const PLAIN = `
export enum DpAuthError {
  DpNotFound = 'DpNotFound',
  NeedsLogin = 'NeedsLogin',
  Timeout = 'Timeout',
}
export class Other { toString() { return '{}' } }
`

const WITH_BRACES_IN_DOCBLOCKS = `
export enum DpAuthError {
  DpNotFound = 'DpNotFound',
  /**
   * A docblock whose text carries braces: ({@link DpSpawnFailedError} exists
   * for the opposite case) and an inline \`{ cause }\` too.
   */
  ExecFailed = 'ExecFailed',
  // a line comment with a brace } in it
  Cancelled = 'Cancelled',
  InteractiveLoginUnavailable = 'InteractiveLoginUnavailable',
  CliEnvTokenOnly = 'CliEnvTokenOnly',
}
export class DpAuthServiceError extends Error {
  constructor(options?: { cause?: unknown }) { super(); void options }
}
`

describe('enumMembers', () => {
  test('reads every member of a plain enum, in declaration order, and stops at the enum', () => {
    expect(enumMembers(PLAIN)).toEqual(['DpNotFound', 'NeedsLogin', 'Timeout'])
  })

  test('a brace inside a member docblock or a line comment does not end the enum early', () => {
    // The regression: with the old reader this answered ['DpNotFound'] and the
    // gate then called Cancelled/InteractiveLoginUnavailable/CliEnvTokenOnly invented.
    expect(enumMembers(WITH_BRACES_IN_DOCBLOCKS)).toEqual([
      'DpNotFound',
      'ExecFailed',
      'Cancelled',
      'InteractiveLoginUnavailable',
      'CliEnvTokenOnly',
    ])
  })

  test('the shipped enum reads more members than the six the broken reader saw', () => {
    const source = require('node:fs').readFileSync('packages/shared/src/auth/dp/errors.ts', 'utf8') as string
    const members = enumMembers(source)
    expect(members.length).toBeGreaterThan(6)
    expect(members).toContain('Cancelled')
    expect(members).toContain('InteractiveLoginUnavailable')
    expect(members).toContain('CliEnvTokenOnly')
  })
})
