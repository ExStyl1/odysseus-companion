/**
 * P6.312 — the host key that names the agent a session runs AS.
 *
 * Two properties are asserted here and neither is cosmetic:
 *
 * 1. **The key survives the strict envelope.** `StoredConfigTopLevelSchema` is
 *    `.strict()` and `loadStoredConfig()` throws `UnsupportedStorageLayoutError`
 *    when the parse fails, so a key a reader names but the envelope does not
 *    declare does not read as unset — it REFUSES the whole `config.json` and
 *    costs the user every other setting in it. The positive case below writes
 *    the key into a real file and reads a real value back, which is the only
 *    shape that can see that failure. (The structural half — that every reader's
 *    key is declared — is `stored-config-envelope-guard.test.ts`'s.)
 * 2. **Every malformed shape reads as "no pinned agent"**, i.e. exactly the
 *    behaviour of a build from before the row. The load path is deliberately
 *    unknown-tolerant, and `validateConfig()` is where a user learns their
 *    array or object never took effect.
 *
 * Driven through a subprocess with its own `NESSY_CONFIG_DIR`, like every other
 * storage suite here: `CONFIG_DIR` is frozen at module load, so an in-process
 * test would read the developer's real configuration.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

function readWith(sessionAgent: unknown): string {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-session-agent-'))
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      ...(sessionAgent === undefined ? {} : { sessionAgent }),
    }, null, 2),
    'utf-8',
  )
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import * as S from '${STORAGE_MODULE_PATH}';`
    + ' process.stdout.write(JSON.stringify(S.getSessionAgentName() ?? null))',
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`subprocess failed:\n${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

describe('the session-agent host key', () => {
  it('reads a declared name back, so the strict envelope really carries the key', () => {
    // The whole point of the positive case: if `sessionAgent` were missing from
    // `StoredConfigKnownFields`, this file would not read `null` — the load
    // would throw and the user would lose every other setting.
    expect(readWith('reviewer')).toBe('"reviewer"')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('trims, and reads blank as unpinned rather than as an agent named nothing', () => {
    expect(readWith('  reviewer  ')).toBe('"reviewer"')
    expect(readWith('   ')).toBe('null')
    expect(readWith('')).toBe('null')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('reads every non-string as unpinned instead of refusing the file', () => {
    // Unknown-tolerant like every neighbour on this envelope. A user whose
    // value is an array gets today's behaviour and a `validateConfig()` finding,
    // not a session that will not start.
    expect(readWith(['reviewer'])).toBe('null')
    expect(readWith({ name: 'reviewer' })).toBe('null')
    expect(readWith(7)).toBe('null')
    expect(readWith(null)).toBe('null')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('is absent by default — THE BASELINE', () => {
    // Every install that has not set the key must behave as it did before the
    // row, which on the claude side is what keeps the option set byte-identical.
    expect(readWith(undefined)).toBe('null')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
