/**
 * C3.256 — the host's memory-LOCATION setting is not projected into the claude
 * child, and this file is the reason written where a future projection lands.
 *
 * The row's two arms were "project it, or say it is not projected". It is not,
 * and the decision rests on a reading rather than a preference — the whole of it
 * is on `applyAutoMemoryOffSwitch` (`agent/options.ts`), the seam every claude
 * spawn passes through. Three grounds, one of which this file pins mechanically:
 *
 *  1. the two stores would become ONE PATH with two independent writers;
 *  2. a projection lands in the flag-settings layer, which outranks the
 *     `user`/`project`/`local` tiers the child reads for itself, so it would
 *     silently override a value the user set in their own Claude settings;
 *  3. the two stores are different things — ours is the index this app writes
 *     and composes into the prompt on all three runtimes, the child's is a tree
 *     nothing in this app reads.
 *
 * Ground 1 is the one a future reader is most likely to doubt, so it is measured
 * here rather than asserted: the binary's own schema sentence says a set value
 * replaces the WHOLE default path (project leaf included), and the host index is
 * a `MEMORY.md` at the root of the very directory that value names.
 *
 * The user-visible half is a switch-cost row, because the sentence this fork
 * already has for the non-projection (`describeClaudeAutoMemory`) reaches only
 * `this.debug`, and a packaged build logs nothing outside debug mode.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MEMORY_FILE_NAME, getUserMemoryFilePath } from '../memory/memory-store.ts'

const NATIVE_BINARY = (() => {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir)
  const nodeModules = sdkEntry.slice(0, sdkEntry.lastIndexOf('/@anthropic-ai/'))
  return `${nodeModules}/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
})()

/** One `grep -a -q -F` pass; `-q` stops at the first hit. */
const inBinary = (marker: string): boolean =>
  Bun.spawnSync(['grep', '-a', '-q', '-F', '-e', marker, NATIVE_BINARY]).exitCode === 0

const haveBinary = (): boolean => {
  try {
    return Bun.file(NATIVE_BINARY).size > 0
  } catch {
    return false
  }
}

describe('C3.256 — ground 1: the projected directory IS the host index directory', () => {
  it("the host's user-scope index is MEMORY.md at the root of the chosen directory", () => {
    const chosen = '/srv/nessy/memories'

    // `getUserMemoryFilePath` takes the root the operator's setting resolves to
    // (`getUserMemoryRoot` returns `getAutoMemoryDirectory() ?? CONFIG_DIR`), so
    // this is the file the app maintains when the setting is set.
    expect(getUserMemoryFilePath(chosen)).toBe(join(chosen, MEMORY_FILE_NAME))
    expect(MEMORY_FILE_NAME).toBe('MEMORY.md')
  })

  it("the vendor key replaces the WHOLE default path, project leaf included", () => {
    if (!haveBinary()) return // darwin-arm64 artefact; absent on other hosts.

    // The binary's own schema description. Quoted as a STRING LITERAL a minifier
    // cannot rename, in two halves so a reworded middle does not read as the
    // semantics having changed.
    expect(inBinary('Custom directory path for auto-memory storage.')).toBe(true)
    expect(inBinary('When unset, defaults to ~/.claude/projects/<sanitized-cwd>/memory/.')).toBe(true)
    // Ground 2's own evidence, from the same source: the vendor itself declines
    // this key at project scope, which is a statement about how much a settings
    // layer is trusted to move a filesystem root.
    expect(inBinary('Ignored if set in projectSettings (checked-in .claude/settings.json) for security.')).toBe(true)

    // Zero control on the identical instrument.
    expect(inBinary('Custom directory path for zzNotARealStoreC3256')).toBe(false)
  }, 120_000)
})

describe('C3.256 — the tripwire: no claude settings contributor writes the key', () => {
  const sources: ReadonlyArray<readonly [string, string]> = [
    ['options.ts', readFileSync(join(import.meta.dir, '..', 'options.ts'), 'utf8')],
    ['claude-agent.ts', readFileSync(join(import.meta.dir, '..', 'claude-agent.ts'), 'utf8')],
  ]

  /**
   * The KEY form, never the bare identifier. A guard on the name alone would
   * fire on the very comment that explains the refusal — AGENTS.md §Traps, the
   * stale-NAME guard that goes red on the commit making the code correct.
   */
  const SETTINGS_KEY_FORM = /\bautoMemoryDirectory\s*:/

  for (const [name, source] of sources) {
    it(`${name} composes no auto-memory location into the child's settings`, () => {
      expect(SETTINGS_KEY_FORM.test(source)).toBe(false)
    })
  }

  it('positive control: the probe does see a settings key this file DOES write', () => {
    const claudeAgent = sources[1]![1]

    // `skipWebFetchPreflight` is composed into the same layer by
    // `buildClaudeWebFetchPreflightSettings`, so a regex that found nothing
    // anywhere would fail here instead of passing the two assertions above.
    expect(/\bskipWebFetchPreflight\s*:/.test(claudeAgent)).toBe(true)
  })
})
