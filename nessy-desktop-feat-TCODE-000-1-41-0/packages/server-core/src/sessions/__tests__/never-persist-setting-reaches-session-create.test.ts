/**
 * P6.502 — the never-persist SETTING reaches the session-create choke point,
 * and the session says so on the wire.
 *
 * `d340b2f25` + `7d776ddb7` landed the setting's four sites and the badge; the
 * READER was missing, so `neverPersistSessions` was a switch a user could turn
 * on and nothing at all would happen — the exact "stated but not enforced" shape
 * this row exists to remove. The badge was equally unreachable: `Session`
 * carried no `ephemeral`, so the renderer could not know.
 *
 * The detector for the first half is the FILE, on
 * `skip-prompt-history-and-persist-failure.test.ts`'s reasoning: the row's own
 * sentence is "never on disk", and asserting on a flag alone would measure the
 * option's plumbing while the record was written anyway. The second half is the
 * DTO field, which is what the badge reads.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { saveConfig, setNeverPersistSessions } from '@nessy-agent/shared/config/storage'
import { getSessionFilePath } from '@nessy-agent/shared/sessions'
import { createTestSessionManager } from './test-session-manager'

const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-never-persist-setting-'))
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

/** The isolated config directory has no `config.json`; the setter refuses to invent one. */
function seedEmptyConfig(): void {
  saveConfig({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as never)
}

afterEach(() => {
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE)
})

afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true })
})

const wroteRecord = (workspaceId: string, sessionId: string): boolean =>
  existsSync(getSessionFilePath(workspaceId, sessionId))

describe('the neverPersistSessions setting reaches the session-create path (P6.502)', () => {
  it('with the setting OFF a session is written and the DTO says nothing', async () => {
    // The CONTROL first: without it, "no file on disk" would also pass on a rig
    // where the store never writes at all.
    seedEmptyConfig()
    const manager = createTestSessionManager()
    const session = await manager.createSession('ws-never-persist-off', {})
    expect(wroteRecord('ws-never-persist-off', session.id)).toBe(true)
    // Absent, not `false`: "saved normally" is what an older server means too.
    expect(session.ephemeral).toBeUndefined()
    await manager.cleanup()
  })

  it('with the setting ON nothing is written and the session carries `ephemeral` to the badge', async () => {
    // POSITIVE. One OR at the one place both `ephemeral` consumers are fed from,
    // so every `!managed.ephemeral` gate inherits it unchanged.
    seedEmptyConfig()
    expect(setNeverPersistSessions(true)).toBe(true)
    const manager = createTestSessionManager()
    const session = await manager.createSession('ws-never-persist-on', {})
    expect(wroteRecord('ws-never-persist-on', session.id)).toBe(false)
    // The wire half: the badge is a PROP, because the fact is fixed for the life
    // of the session and a read per render would be an RPC for a constant.
    expect(session.ephemeral).toBe(true)
    await manager.cleanup()
  })
})
