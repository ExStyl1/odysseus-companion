/**
 * Tests for `check-dropped-log-sink.ts` — DA1.65.
 *
 * The positive control runs over a SCRATCH directory rather than over the repo,
 * for the reason AGENTS.md gives about mutation harnesses: a control that plants
 * a call in the real tree has to restore it exactly, and a restore that misses
 * silently invalidates every later verdict. `census({ noIndex, root })` exists
 * for this and for nothing else.
 *
 * The real-tree arm is deliberately the WEAK one — "the probe can see something"
 * — and carries no number. A declared count here would be a second ratchet
 * beside `PINNED_CENSUS`, and it would go red on a sibling lane's commit that
 * happens to add a log line, which is the class of cry-wolf control AGENTS.md
 * records wave 17 paying for six times.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  aliasCensus,
  census,
  DROPPED_SINK_PATTERN,
  PINNED_ALIAS_CENSUS,
  PINNED_CENSUS,
  SCOPED_ALIAS_BINDING_PATTERN,
} from './check-dropped-log-sink'

function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dropped-sink-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body, 'utf-8')
  return root
}

describe('check-dropped-log-sink', () => {
  test('counts every dropped-sink call, not every line', () => {
    const root = scratch({
      'handler.ts': [
        "deps.platform.logger.info('Saved credential for ' + slug)",
        "if (bad) { deps.platform.logger.warn('a'); deps.platform.logger.error('b') }",
      ].join('\n'),
    })
    try {
      const result = census({ noIndex: true, root })
      // Three calls over two lines — the whole reason the instrument counts
      // occurrences: a line count would have answered 2.
      expect(result.occurrences).toBe(3)
      expect(result.files).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('does NOT match the sink that survives a packaged build, nor a bare logger', () => {
    const root = scratch({
      'safe.ts': [
        "const log = createLogger('llm-connections')",
        "log.info('Saved credential for ' + slug)",
        // A logger that is not `platform.logger` is not this gate's subject:
        // widening the pattern to `logger\\.` would count every module's own.
        "this.logger.info('unrelated')",
        "platformLogger.info('also unrelated')",
      ].join('\n'),
    })
    try {
      expect(census({ noIndex: true, root }).occurrences).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the pattern names the four levels rather than matching any member', () => {
    // Load-bearing: a rename of the interface should make the gate REFUSE
    // (vacuous census) instead of quietly matching nothing new. A `\\w+` form
    // would keep matching `platform.logger.anything` forever.
    expect(DROPPED_SINK_PATTERN).toContain('debug|info|warn|error')
    expect(DROPPED_SINK_PATTERN).not.toContain('\\w+')
  })

  test('the real tree is scanned and the probe can see it', () => {
    // No number, on purpose — see this file's docblock. The pin is the ratchet;
    // this is only the control that the census is not vacuous, which is what
    // makes the script's own zero-refusal meaningful.
    expect(census().occurrences).toBeGreaterThan(0)
    expect(PINNED_CENSUS).toBeGreaterThan(0)
  })
})

/**
 * F1.177 — the scoped-alias half. The defect it exists for is the one this gate
 * watched happen: `sessionLog.warn` is `platform.logger` one name along, and the
 * direct pattern scores it as zero.
 *
 * These arms run over a SCRATCH directory for the same reason the ones above do,
 * and they carry no number from the real tree — the pins are the ratchet.
 */
describe('check-dropped-log-sink · the scoped alias', () => {
  test('derives the alias NAME from the binding and counts calls through it', () => {
    const root = scratch({
      'wire.ts': "  sessionLog = createScopedLogger(platform.logger, 'session')",
      'use.ts': [
        "sessionLog.warn('a')",
        "if (bad) { sessionLog.info('b'); sessionLog.error('c') }",
        // Not a call on the alias — the census is about calls, not about the
        // name appearing.
        'const other = sessionLog',
      ].join('\n'),
    })
    try {
      const result = aliasCensus({ noIndex: true, root })
      expect(result.names).toEqual(['sessionLog'])
      expect(result.occurrences).toBe(3)
      expect(result.files).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the BASE decides, not the name: a console-backed scoped logger is not counted', () => {
    // The load-bearing distinction. Every one of these aliases is INITIALISED
    // with `createScopedLogger(CONSOLE_LOGGER, …)`, which always writes; only the
    // re-binding to `platform.logger` is dropped. A name list would have had to
    // keep the two apart by hand, and would have counted a tree that only ever
    // had the fallback.
    const root = scratch({
      'fallback.ts': [
        "let consoleOnlyLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'session')",
        "consoleOnlyLog.warn('this one really is written')",
      ].join('\n'),
    })
    try {
      const result = aliasCensus({ noIndex: true, root })
      expect(result.names).toEqual([])
      expect(result.occurrences).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('with no binding at all it returns zero rather than searching for an empty alternation', () => {
    // A `()` alternation matches the empty string, so a pattern built from an
    // empty name list would match every `.warn(` in the scope and report a
    // catastrophic false rise. The early return is what stops that.
    const root = scratch({ 'nothing.ts': "log.warn('unrelated')" })
    try {
      expect(aliasCensus({ noIndex: true, root }).occurrences).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the binding pattern names the BASE, so a rename empties the list and the script REFUSES', () => {
    // Paired with the zero-refusal in `main()`: an empty name list is the probe
    // failing, and this is the assertion that the emptiness is reachable only
    // that way rather than through a hard-coded list that cannot empty.
    expect(SCOPED_ALIAS_BINDING_PATTERN).toContain('createScopedLogger')
    expect(SCOPED_ALIAS_BINDING_PATTERN).toContain('platform\\.logger')
    expect(SCOPED_ALIAS_BINDING_PATTERN).not.toContain('sessionLog')
  })

  test('the real tree carries at least one alias and the probe can see it', () => {
    // No number, on purpose — this file's docblock. The alias pin is the ratchet.
    const result = aliasCensus()
    expect(result.names.length).toBeGreaterThan(0)
    expect(result.occurrences).toBeGreaterThan(0)
    expect(PINNED_ALIAS_CENSUS).toBeGreaterThan(0)
  })
})
