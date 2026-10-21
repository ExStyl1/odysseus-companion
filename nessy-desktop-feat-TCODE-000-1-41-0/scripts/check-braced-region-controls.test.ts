/**
 * Tests for `check-braced-region-controls.ts` — D1.243.
 *
 * Every arm that carries a NUMBER runs over a SCRATCH pair — a planted source
 * module and a planted test file that reads it — rather than over the repo. The
 * reason is the one AGENTS.md gives about mutation harnesses: a control that
 * mutates the real tree owes an exact restore, and a restore that misses
 * silently invalidates every verdict after it. Here the mutation is the whole
 * point (a control anchored ABOVE its region), so it is planted where nothing
 * has to be put back.
 *
 * The real-tree arm is the WEAK one and carries no declared count, for the
 * reason the sibling gates' suites give: a number there is a second ratchet that
 * reddens on a sibling lane's commit.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  audit,
  auditFile,
  callSiteFiles,
  candidateSources,
  firstLiteral,
  resolveNeedle,
  unescapeLiteral,
} from './check-braced-region-controls'

/**
 * A module with two declarations, `alpha` ABOVE `beta`. A region anchored on
 * `beta` can never reach `alpha`, which is the defect this gate is about.
 */
const MODULE_SOURCE = [
  'export function alpha(): void {',
  '  doSomething()',
  '}',
  '',
  'export function beta(): void {',
  '  theClaim()',
  '}',
  '',
  'export function gamma(): void {',
  '  unrelated()',
  '}',
  '',
].join('\n')

function scratch(testBody: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'braced-region-controls-'))
  writeFileSync(join(root, 'mod.ts'), MODULE_SOURCE, 'utf-8')
  writeFileSync(join(root, 'subject.test.ts'), testBody, 'utf-8')
  return { root, file: 'subject.test.ts' }
}

function run(testBody: string): ReturnType<typeof auditFile> {
  const { root, file } = scratch(testBody)
  try {
    return auditFile(file, testBody, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const READ = "const src = readFileSync(new URL('./mod.ts', import.meta.url), 'utf8')"

describe('check-braced-region-controls', () => {
  test('a control naming a declaration BELOW the region is accepted', () => {
    const result = run([
      READ,
      "const body = bracedRegion(src, src.indexOf('export function beta(): void {'))",
      "expect(body).toContain('theClaim()')",
      "expect(body).not.toContain('export function gamma(): void {')",
    ].join('\n'))
    expect(result.sites).toBe(1)
    expect(result.resolved).toBe(1)
    expect(result.findings).toEqual([])
  })

  test('a control naming a declaration ABOVE the region is a finding — the same file, one needle changed', () => {
    // The mutation, and it is the only difference from the arm above: `alpha` is
    // declared before `beta`, so a brace scan starting at `beta` cannot reach it
    // however far it runs away. The assertion passes either way, which is why
    // re-running the test can never find this.
    const result = run([
      READ,
      "const body = bracedRegion(src, src.indexOf('export function beta(): void {'))",
      "expect(body).toContain('theClaim()')",
      "expect(body).not.toContain('export function alpha(): void {')",
    ].join('\n'))
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.kind).toBe('above-region')
    expect(result.findings[0]?.needle).toBe('export function alpha(): void {')
    expect(result.findings[0]?.line).toBe(4)
  })

  test('a needle that also occurs BELOW the anchor is accepted — the last occurrence decides', () => {
    // A needle can legitimately appear above AND below; the region can contain
    // the lower one, so the control CAN fail and is not vacuous. Using
    // `indexOf` here instead of `lastIndexOf` would report this correct control.
    const result = run([
      READ,
      "const body = bracedRegion(src, src.indexOf('export function beta(): void {'))",
      "expect(body).not.toContain('unrelated()')",
      // `unrelated()` is below; `doSomething()` is only above.
      "expect(body).toContain('theClaim()')",
    ].join('\n'))
    expect(result.findings).toEqual([])
  })

  test('a call site with NO not.toContain at all is a finding', () => {
    const result = run([
      READ,
      "const body = bracedRegion(src, src.indexOf('export function beta(): void {'))",
      "expect(body).toContain('theClaim()')",
    ].join('\n'))
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.kind).toBe('no-control')
  })

  test('the anchor may sit on an earlier line, as `const start = src.indexOf(...)`', () => {
    const result = run([
      READ,
      "const start = src.indexOf('export function beta(): void {')",
      'expect(start).toBeGreaterThan(0)',
      'const body = bracedRegion(src, start)',
      "expect(body).not.toContain('export function alpha(): void {')",
    ].join('\n'))
    expect(result.resolved).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.kind).toBe('above-region')
  })

  test('the region variable\'s scope ends where it is reassigned, so two cases are two sites', () => {
    const result = run([
      READ,
      "const start = src.indexOf('export function beta(): void {')",
      'const body = bracedRegion(src, start)',
      "expect(body).not.toContain('export function gamma(): void {')",
      'const body = bracedRegion(src, start)',
      "expect(body).not.toContain('export function alpha(): void {')",
    ].join('\n'))
    expect(result.sites).toBe(2)
    // The first site's control is fine; only the second is reported — which is
    // the proof the scope really ends at the reassignment rather than every
    // control in the file being read against every site.
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.line).toBe(6)
  })

  test('an anchor no candidate source contains is UNRESOLVED, never a finding', () => {
    const result = run([
      'const src = await fetchSourceFromSomewhereElse()',
      "const body = bracedRegion(src, src.indexOf('a declaration nothing here spells'))",
      "expect(body).toContain('x')",
    ].join('\n'))
    expect(result.findings).toEqual([])
    expect(result.unresolved).toHaveLength(1)
    // The boundary against the fixture class below: `src` is assigned from a
    // CALL, not from a literal, so the site stays UNRESOLVED and the gate's one
    // meaningful line survives D1.294's repair.
    expect(result.fixtures).toEqual([])
    expect(result.resolved).toBe(0)
  })

  test('a region over an IN-FILE fixture is counted apart, not as unresolved and not as a finding (D1.294)', () => {
    // The brace matcher's own unit test shape: the source is text the test
    // wrote, so there is no file to resolve it in. Before D1.294 each such site
    // printed an UNRESOLVED line on every clean run.
    const result = run([
      'const SOURCE = [',
      "  'class Example {',",
      "  '  private first(a: string): void {',",
      "  '    this.tail()',",
      "  '  }',",
      "  '}',",
      "].join('\\n')",
      "const region = bracedRegion(SOURCE, SOURCE.indexOf('private first('))",
      "expect(region).toContain('this.tail()')",
    ].join('\n'))
    expect(result.sites).toBe(1)
    expect(result.unresolved).toEqual([])
    expect(result.findings).toEqual([])
    expect(result.fixtures).toHaveLength(1)
    expect(result.fixtures[0]?.name).toBe('SOURCE')
    expect(result.fixtures[0]?.anchor).toBe('private first(')
  })

  test('a fixture classification cannot hide a site a REAL source resolves', () => {
    // The hazard the split's ordering exists for: a file where the same name is
    // both a literal constant and the source read from disk. The candidate
    // lookup runs first, so the site resolves and its missing control is still
    // a finding — the classification only ever refines what was unresolved.
    const result = run([
      "const src = 'a decoy literal'",
      READ,
      "const body = bracedRegion(src, src.indexOf('export function beta(): void {'))",
      "expect(body).toContain('theClaim()')",
    ].join('\n'))
    expect(result.resolved).toBe(1)
    expect(result.fixtures).toEqual([])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.kind).toBe('no-control')
  })

  test('a path spelled across arguments resolves against an ancestor directory', () => {
    // The `read('agent', 'codex-agent.ts')` shape. Teaching the scanner about
    // that one helper would report the NEXT shape as a missing control, which is
    // the false finding this gate exists not to produce.
    const root = mkdtempSync(join(tmpdir(), 'braced-region-controls-'))
    try {
      writeFileSync(join(root, 'mod.ts'), MODULE_SOURCE, 'utf-8')
      const body = "const source = read('mod.ts')\nconst x = 1"
      const found = candidateSources(body, join(root, 'nested', 'deep', 'subject.test.ts'), root)
      expect(found.some(path => path.endsWith('mod.ts'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a BACKTICKED anchor resolves the backticked text, never its inner literal (D1.290)', () => {
    // The defect: `permission_denied` occurs in two candidate sources, so
    // reading the inner literal resolved the anchor in the WRONG file and
    // refused a control that is correct in the file the test reads.
    const backticked = "const region = bracedRegion(adapter, adapter.indexOf(`msg.subtype === 'permission_denied'`))"
    expect(firstLiteral(backticked.slice(backticked.indexOf('adapter.indexOf')))).toBe("msg.subtype === 'permission_denied'")
    // The workaround the call sites took must keep working — the two spellings
    // are the same anchor, and a lane converting one back must not have to.
    expect(firstLiteral('adapter.indexOf("msg.subtype === \'permission_denied\'")')).toBe("msg.subtype === 'permission_denied'")
    // A `$` that is not an interpolation is ordinary text.
    expect(firstLiteral('src.indexOf(`cost in $ per turn`)')).toBe('cost in $ per turn')
  })

  test('an INTERPOLATING template stays unreadable rather than degrading to its inner literal', () => {
    // The boundary, and the reason the decision is made at the first quote
    // character: a template the scanner cannot read must produce an UNRESOLVED
    // site — a reported absence — and never the prefix `private `, which would
    // match half the tree and resolve some arbitrary source.
    expect(firstLiteral('src.indexOf(`private ${name}(`)')).toBeNull()
    const result = run([
      READ,
      'const body = bracedRegion(src, src.indexOf(`export function ${which}(): void {`))',
      "expect(body).toContain('theClaim()')",
    ].join('\n'))
    expect(result.resolved).toBe(0)
    expect(result.unresolved).toHaveLength(1)
    expect(result.findings).toEqual([])
  })

  test('literals are read with their escapes, and a needle may name a constant', () => {
    expect(unescapeLiteral('\\nexport function x(')).toBe('\nexport function x(')
    expect(firstLiteral("src.indexOf('private first(')")).toBe('private first(')
    expect(firstLiteral('src.indexOf("double")')).toBe('double')
    const constants = new Map([['CALL', 'applyWorktreeSymlinks(']])
    expect(resolveNeedle('CALL)', constants)).toBe('applyWorktreeSymlinks(')
    expect(resolveNeedle("'literal wins')", constants)).toBe('literal wins')
    expect(resolveNeedle('someRuntimeExpression())', constants)).toBeNull()
  })

  test('the real tree is scanned, the call sites are found, and none of them is vacuous', () => {
    // No declared count — see this file's docblock. What this DOES pin is the
    // verdict: the tree's boundary controls all pass the rule today, which is
    // the state D1.111 left it in and the state this gate keeps.
    const files = callSiteFiles()
    expect(files.length).toBeGreaterThan(0)
    const report = audit()
    expect(report.resolved).toBeGreaterThan(0)
    expect(report.findings).toEqual([])
  }, 90_000) // the scan opens every call-site file: 13.63 s real / 0.14 s user on 2026-09-24 (I/O, not CPU)

  test('the brace matcher\'s own fixture prints no UNRESOLVED line (D1.294)', () => {
    // Named rather than counted, and asserted about that ONE file rather than
    // about the tree: a global zero-unresolved assertion would redden on a
    // neighbour's new computed-anchor site, which the gate deliberately only
    // REPORTS. The whole-tree reading on 2026-09-18 was 25 resolved,
    // 3 fixture, 0 unresolved across 28 files.
    const fixture = 'packages/shared/src/testing/__tests__/source-regions.test.ts'
    const report = audit()
    expect(report.unresolved.filter(site => site.file === fixture)).toEqual([])
    expect(report.fixtures.filter(site => site.file === fixture)).toHaveLength(3)
  })
})
