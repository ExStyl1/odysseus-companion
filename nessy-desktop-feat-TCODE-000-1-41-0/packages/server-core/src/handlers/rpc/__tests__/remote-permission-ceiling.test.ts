import { describe, expect, test } from 'bun:test'
import {
  REMOTE_CLIENT_PERMISSION_MODE_CEILING,
  isPermissionModeAllowedForRemoteClient,
  PERMISSION_MODE_ORDER,
} from '@nessy-agent/shared/agent/mode-types'
import { isLocalClient, CLIENT_SHOW_IN_FOLDER } from '../../../transport/capabilities.ts'

/**
 * F8 — a phone must not be able to un-gate a workstation.
 *
 * The point of these is that the rule lives on the SERVER. Hiding
 * `bypassPermissions` in the device's picker is a suggestion; the client is the
 * one piece of this system that can be replaced with a hand-written websocket.
 */
describe('remote permission-mode ceiling (F8)', () => {
  test('bypassPermissions is refused for a remote client', () => {
    expect(isPermissionModeAllowedForRemoteClient('bypassPermissions')).toBe(false)
  })

  test('every mode at or below the ceiling stays available', () => {
    const ceilingRank = PERMISSION_MODE_ORDER.indexOf(REMOTE_CLIENT_PERMISSION_MODE_CEILING)
    const allowed = PERMISSION_MODE_ORDER.slice(0, ceilingRank + 1)

    for (const mode of allowed) {
      expect(isPermissionModeAllowedForRemoteClient(mode)).toBe(true)
    }
    // A phone that cannot pick `plan` or `default` is not safer, just useless.
    expect(allowed).toContain('plan')
    expect(allowed).toContain('default')
  })

  test('the ceiling sits below bypassPermissions in the shared order', () => {
    // Guards against someone raising the ceiling to the top by accident.
    expect(PERMISSION_MODE_ORDER.indexOf(REMOTE_CLIENT_PERMISSION_MODE_CEILING))
      .toBeLessThan(PERMISSION_MODE_ORDER.indexOf('bypassPermissions'))
  })
})

describe('client locality (F8)', () => {
  const server = (capabilities: string[]) => ({
    hasClientCapability: (_id: string, capability: string) => capabilities.includes(capability),
  }) as any

  test('a client that can reveal a file in Finder is local', () => {
    expect(isLocalClient(server([CLIENT_SHOW_IN_FOLDER]), 'c1')).toBe(true)
  })

  test('a phone advertising no OS capabilities is remote', () => {
    expect(isLocalClient(server([]), 'c1')).toBe(false)
  })

  test('a client advertising unrelated capabilities is still remote', () => {
    // Fail CLOSED here: an unknown capability set must not read as local, or
    // the ceiling evaporates for anything we did not anticipate.
    expect(isLocalClient(server(['client:somethingElse']), 'c1')).toBe(false)
  })
})
