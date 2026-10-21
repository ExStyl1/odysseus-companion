/**
 * P6.307 — the review effort level that survives a session.
 *
 * `code-review.md` § *Tune effort and arguments*: the review *"reuses the last
 * level from `low` through `max` you typed, **even in an earlier session**"*.
 * The bundled skill already reused it INSIDE one conversation; the crossing had
 * no store, and three lanes measured where the store should live before this
 * one built it. The answer that survived: a `StoredConfig` key the HOST owns,
 * because `review-tool.ts` runs inside the Pi subprocess and a second process
 * must not write the user's `config.json`.
 *
 * ## Why a subprocess per case
 *
 * `storage.ts` caches, and `NESSY_CONFIG_DIR` must be set before the module
 * loads — the same recipe `default-thinking-level.test.ts` uses next door, and
 * for the same reason: a test that mutates the real config directory is a test
 * that eventually eats a developer's settings.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { bracedRegion } from '../../testing/source-regions.ts'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

/**
 * The budget belongs to the FILE, not to a case. Each `runEval` pays for a cold
 * bun process importing `storage.ts`'s whole module graph, which is tens of
 * seconds under load and nothing to do with what is being asserted — the
 * default 5 s timed out on the very first read. Sized against the sibling
 * `default-thinking-level.test.ts`, which pays the same cost, and every case
 * batches its statements into as few processes as the claim allows.
 */
setDefaultTimeout(300_000)

function configDirWith(config: Record<string, unknown>): { configDir: string; configPath: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-review-effort-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    llmConnections: [],
    ...config,
  }, null, 2), 'utf-8')
  return { configDir, configPath }
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getLastReviewEffortLevel, setLastReviewEffortLevel } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }
  return run.stdout.toString().trim()
}

describe('P6.307 — the review effort level that crosses a session', () => {
  it('remembers a typed level and hands it back to a later session', () => {
    const { configDir, configPath } = configDirWith({})
    // Nothing typed yet is `undefined`, NOT a level of our own: `code-review.md`
    // makes the never-typed case "the review uses the session's current effort",
    // which an absent `effort` already produces.
    expect(runEval(configDir, [
      'console.log(String(getLastReviewEffortLevel()));',
      'console.log(String(setLastReviewEffortLevel("high")));',
    ].join(' '))).toBe('undefined\ntrue')

    // A DIFFERENT process reads it back — the whole claim of the row, and the
    // reason these two are not one call.
    expect(runEval(configDir, 'console.log(String(getLastReviewEffortLevel()))')).toBe('high')
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).lastReviewEffortLevel).toBe('high')
  })

  it('never remembers `off`, and never lets one already written disable a review', () => {
    // The page's own range is `low` through `max`. A remembered `off` would
    // silently turn every later review into no review at all, so it is refused
    // on the way in AND ignored on the way out — a hand-edited config.json can
    // carry one that no writer of ours produced.
    const { configDir, configPath } = configDirWith({ lastReviewEffortLevel: 'off' })
    expect(runEval(configDir, [
      'console.log(String(getLastReviewEffortLevel()));',
      'console.log(String(setLastReviewEffortLevel("off")));',
    ].join(' '))).toBe('undefined\nfalse')
    // Refused on the way in, so the file is untouched rather than rewritten.
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).lastReviewEffortLevel).toBe('off')
  })

  it('refuses a value it does not recognise rather than storing it', () => {
    const { configDir } = configDirWith({})
    expect(runEval(configDir, [
      'console.log(String(setLastReviewEffortLevel("enormous")));',
      'console.log(String(setLastReviewEffortLevel(7)));',
      'console.log(String(getLastReviewEffortLevel()));',
    ].join(' '))).toBe('false\nfalse\nundefined')
  })

  it('is declared in BOTH halves of the strict envelope', () => {
    // Rule 19, and the reason it is a rule: four documented keys missing from
    // `StoredConfigKnownFields` once wiped a user's whole config.json, because
    // the envelope is strict and our own writer produced an undeclared key.
    // The two halves live in two FILES since `1e5a03748` (DA1.72) moved
    // `StoredConfigKnownFields` into its own leaf: the strict envelope's
    // declaration is in `stored-config-load.ts` and the validating schema stays
    // in `validators.ts`. Both assertions read `validators.ts` until 2026-09-19,
    // so the envelope half had been asserting the absence of a line that file
    // has not carried since the refactor, and it was red alone at HEAD and on
    // CI job 630520568. The CLAIM is unchanged; only the file each half is read
    // from moved.
    const envelope = readFileSync(new URL('../stored-config-load.ts', import.meta.url), 'utf8')
    expect(envelope).toContain('lastReviewEffortLevel: z.unknown().optional(),')
    const validators = readFileSync(new URL('../validators.ts', import.meta.url), 'utf8')
    expect(validators).toContain('lastReviewEffortLevel: z.enum(')
  })

  it('the Pi gate is the seam for BOTH halves, and it only ever fills an allowed call', () => {
    // The seam is `handlePreToolUseRequest`: every Pi tool call arrives there
    // with its input (orchestrator tools included — `adaptTools` wraps the whole
    // projected set), and the gate can answer `modify` with a rewritten one. So
    // the WRITE needs no `review-tool.ts` change at all, and the READ is a fill.
    //
    // Asserted on the source because the alternative instrument is the whole
    // manifest/permission-service rig for a nine-line branch; what must not
    // silently change is the ORDER and the GUARD, and both are visible here.
    const gate = readFileSync(new URL('../../agent/pi-agent.ts', import.meta.url), 'utf8')
    const start = gate.indexOf("if (toolName === 'review') {")
    expect(start).toBeGreaterThan(-1)
    // D1.111 — the block's own braces rather than 2 000 characters of the file.
    const block = bracedRegion(gate, start)
    // BOUNDARY CONTROL: a brace scan that ran away would satisfy every line
    // below for anything anywhere in `pi-agent.ts`. The needle is the NEXT
    // declaration below the block — UA12.74's ternary re-spelled the one the
    // old needle named, stranding it where no runaway could ever reach.
    expect(block).not.toContain('const automationResult = req.sourceActivationRerun')
    expect(block).toContain('setLastReviewEffortLevel(typed)')
    expect(block).toContain('getLastReviewEffortLevel()')
    // Only over an allow (or an existing modify): a fill must never resurrect a
    // call the gate blocked.
    expect(block).toContain("checkResult.type === 'allow' || checkResult.type === 'modify'")
    // And only when the model named nothing — a typed level is never overwritten.
    expect(block).toContain('input.effort === undefined')
    // The gate runs first; the fill reads its verdict.
    expect(gate.indexOf('runPreToolUseChecks(checkArgs)')).toBeLessThan(start)
  })

  it('the reused level is announced to the model, not to a second UI', () => {
    // done_means (2)'s "and SAYS so in its first line". `additionalContext` is
    // the one channel that reaches the Pi model with hidden context, and the
    // bundled skill is already told to say which level it reused — so the
    // sentence lands in the review's own first line rather than in a badge that
    // would describe the same fact twice.
    const gate = readFileSync(new URL('../../agent/pi-agent.ts', import.meta.url), 'utf8')
    expect(gate).toContain('reviewEffortContext')
    expect(gate).toContain('carried over from an earlier session')
    // It rides the EXISTING assembly rather than a new channel.
    expect(gate).toContain('pathScopedRuleContext, reviewEffortContext]')
  })
})
