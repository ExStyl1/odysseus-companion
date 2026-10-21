/**
 * P6.500 — the host key that decides when reopening a conversation asks
 * compact-or-keep.
 *
 * Two properties, and neither is cosmetic:
 *
 * 1. **The key survives the strict envelope.** `StoredConfigTopLevelSchema` is
 *    `.strict()` and `loadStoredConfig()` throws `UnsupportedStorageLayoutError`
 *    when the parse fails, so a key a reader names but the envelope does not
 *    declare does not read as unset — it REFUSES the whole `config.json` and
 *    costs the user every other setting in it. The positive case below writes a
 *    real file and reads a real value back, which is the only shape that can see
 *    that failure. (The structural half is `stored-config-envelope-guard.test.ts`'s.)
 * 2. **Every malformed shape reads as the DEFAULT**, i.e. exactly the behaviour
 *    of a build from before the row. The load path is deliberately
 *    unknown-tolerant, and `validateConfig()` is where a user learns their
 *    string or object never took effect.
 *
 * The default itself is the page's number, not ours —
 * `sessions.md#resume-from-a-summary`: *"…has been inactive for more than about
 * an hour and is over 100,000 tokens…"* — and it is asserted here so a silent
 * change to it fails rather than quietly moving when every install starts
 * asking.
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

function readWith(reopenCompactPromptTokens: unknown): string {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-reopen-compact-'))
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      ...(reopenCompactPromptTokens === undefined ? {} : { reopenCompactPromptTokens }),
    }, null, 2),
    'utf-8',
  )
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import * as S from '${STORAGE_MODULE_PATH}';`
    + ' process.stdout.write(JSON.stringify(S.getReopenCompactPromptTokens()))',
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`subprocess failed:\n${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

/**
 * P6.950 — the WRITE behind the dialog's third answer, through the same
 * subprocess and the same real file, because the property under test is that the
 * button and `config.json` move ONE field: a write that landed anywhere else
 * would still read back as the default here.
 */
function disableThenRead(seed: unknown): string {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-reopen-compact-off-'))
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      ...(seed === undefined ? {} : { reopenCompactPromptTokens: seed }),
    }, null, 2),
    'utf-8',
  )
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import * as S from '${STORAGE_MODULE_PATH}';`
    + ' const written = S.disableReopenCompactPrompt();'
    + " process.stdout.write(JSON.stringify([written, S.getReopenCompactPromptTokens()]))",
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`subprocess failed:\n${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

describe('the dialog’s third answer, as a write (P6.950)', () => {
  it('turns the trigger OFF through the same key the operator edits', () => {
    // POSITIVE. `sessions.md#resume-from-a-summary`: *"Don't ask me again:
    // resumes the full session and stops showing the dialog on all future
    // resumes."* The second half is this, and the round trip is what proves it
    // reached the strict envelope rather than a field nothing reads back.
    expect(disableThenRead(undefined)).toBe('[true,0]')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('overwrites an operator’s own threshold rather than deleting the key', () => {
    // The distinction that makes this the right write: DELETING the key would
    // restore the 100,000 default, i.e. resume asking — the opposite of what the
    // user clicked. Zero is the documented off value, so the answer lands on the
    // same switch `config.json` reaches.
    expect(disableThenRead(250_000)).toBe('[true,0]')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe('the reopen compact-or-keep threshold key', () => {
  it('reads a declared number back, so the strict envelope really carries the key', () => {
    // If `reopenCompactPromptTokens` were missing from `StoredConfigKnownFields`,
    // this would not read the default — the load would throw and the user would
    // lose every other setting in the file.
    expect(readWith(250_000)).toBe('250000')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('carries the OFF switch, which is the page’s third answer in one number', () => {
    // The page's third answer is a global off, and this value is how it is
    // spelled here — one number with a documented off value rather than a second
    // key. Since P6.950 the card's own button writes it too
    // (`disableReopenCompactPrompt`), so this case is the shape BOTH writers
    // have to produce.
    expect(readWith(0)).toBe('0')
    expect(readWith(-1)).toBe('-1')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('is the page’s 100,000 by default — THE BASELINE', () => {
    expect(readWith(undefined)).toBe('100000')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('reads every non-number as the default instead of refusing the file', () => {
    // Unknown-tolerant like every neighbour on this envelope. A user whose value
    // is the string "100000" gets today's behaviour and a `validateConfig()`
    // finding, not a config.json that will not load.
    expect(readWith('250000')).toBe('100000')
    expect(readWith(null)).toBe('100000')
    expect(readWith({ tokens: 250_000 })).toBe('100000')
    expect(readWith([250_000])).toBe('100000')
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
