import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { parseClaudeRuleString } from './claude-permission-rules.ts'
import { compilePermissionDslV1, evaluateCdPermissionDslV1 } from './permission-dsl.ts'

/**
 * `Cd` rule enforcement (permissions.md § Cd, re-fetched 2026-07-29).
 *
 * The documented matching table is transcribed verbatim below; the mode rules
 * ("A bare `Cd` deny rule disables `/cd` entirely", "Adding any `Cd` allow rule
 * switches `/cd` to allowlist mode", "With no `Cd` rules configured, `/cd`
 * keeps its default behavior") are their own cases.
 */

const GENERATION = 'cd-test'
const HOME = homedir()
const CWD = join(sep, 'work', 'repo')

function program(rules: ReadonlyArray<[string, 'allow' | 'ask' | 'deny']>) {
  return compilePermissionDslV1({
    generation: GENERATION,
    projectTrusted: true,
    layers: [{
      scope: 'workspace',
      sourceDigest: GENERATION,
      sourceRoot: CWD,
      document: {
        version: 1,
        rules: rules.map(([raw, action], index) => {
          const parsed = parseClaudeRuleString(raw, action)
          if (!parsed.rule) throw new Error(`rule did not compile: ${raw}`)
          return { id: `cd-${index}`, action, match: parsed.rule.match }
        }),
      },
    }],
  })
}

function decide(
  rules: ReadonlyArray<[string, 'allow' | 'ask' | 'deny']>,
  path: string,
  alternatePaths: string[] = [],
) {
  return evaluateCdPermissionDslV1(program(rules), { path, alternatePaths, cwd: CWD }).decision
}

describe('Cd permission rules', () => {
  test('the documented matching table', () => {
    // | `Cd(~/code/*)` | `~/code/app` | `~/code/app/src`, `~/code` |
    expect(decide([['Cd(~/code/*)', 'deny']], join(HOME, 'code', 'app'))).toBe('deny')
    expect(decide([['Cd(~/code/*)', 'deny']], join(HOME, 'code', 'app', 'src'))).toBe('prompt')
    expect(decide([['Cd(~/code/*)', 'deny']], join(HOME, 'code'))).toBe('prompt')

    // | `Cd(~/code/**)` | `~/code` and any directory under it | outside `~/code` |
    expect(decide([['Cd(~/code/**)', 'deny']], join(HOME, 'code'))).toBe('deny')
    expect(decide([['Cd(~/code/**)', 'deny']], join(HOME, 'code', 'app', 'src'))).toBe('deny')
    expect(decide([['Cd(~/code/**)', 'deny']], join(HOME, 'other'))).toBe('prompt')

    // | `Cd(**/node_modules)` | any `node_modules` at any depth | `node_modules/pkg` |
    expect(decide([['Cd(**/node_modules)', 'deny']], join(CWD, 'a', 'b', 'node_modules'))).toBe('deny')
    expect(decide([['Cd(**/node_modules)', 'deny']], join(CWD, 'node_modules'))).toBe('deny')
    expect(decide([['Cd(**/node_modules)', 'deny']], join(CWD, 'node_modules', 'pkg'))).toBe('prompt')
  })

  test('a bare literal does NOT float to any depth (Cd is not gitignore-style)', () => {
    // The one row the shared gitignore matcher got wrong before this unit:
    // `Read(node_modules)` floats, `Cd(node_modules)` names one directory.
    expect(decide([['Cd(node_modules)', 'deny']], join(CWD, 'node_modules'))).toBe('deny')
    expect(decide([['Cd(node_modules)', 'deny']], join(CWD, 'a', 'node_modules'))).toBe('prompt')
  })

  test('no Cd rules keeps the default prompt-to-trust behaviour', () => {
    expect(decide([], join(HOME, 'anywhere'))).toBe('prompt')
    expect(decide([['Bash(git *)', 'allow']], join(HOME, 'anywhere'))).toBe('prompt')
  })

  test('a bare Cd deny rule disables /cd entirely', () => {
    expect(decide([['Cd', 'deny']], join(HOME, 'code'))).toBe('deny')
    expect(decide([['Cd', 'deny']], CWD)).toBe('deny')
  })

  test('any Cd allow rule switches /cd to allowlist mode', () => {
    const rules: Array<[string, 'allow' | 'ask' | 'deny']> = [['Cd(~/code/**)', 'allow']]
    expect(decide(rules, join(HOME, 'code', 'app'))).toBe('allow')
    expect(decide(rules, join(HOME, 'elsewhere'))).toBe('deny')
  })

  test('deny outranks allow, and ask prompts even when an allow matches', () => {
    expect(decide([
      ['Cd(~/code/**)', 'allow'],
      ['Cd(~/code/secret)', 'deny'],
    ], join(HOME, 'code', 'secret'))).toBe('deny')
    expect(decide([
      ['Cd(~/code/**)', 'allow'],
      ['Cd(~/code/app)', 'ask'],
    ], join(HOME, 'code', 'app'))).toBe('prompt')
    // An ask rule alone never enables allowlist mode.
    expect(decide([['Cd(~/code/**)', 'ask']], join(HOME, 'elsewhere'))).toBe('prompt')
  })

  test('a deny rule checks every spelling of the target', () => {
    // "Deny rules check every spelling of the target, including each symlink
    // hop it resolves through, so a rule written for one path also blocks
    // targets that resolve to it."
    expect(decide(
      [['Cd(//private/tmp/**)', 'deny']],
      join(sep, 'private', 'tmp', 'build'),
      [join(sep, 'tmp', 'build')],
    )).toBe('deny')
    expect(decide(
      [['Cd(//tmp/**)', 'deny']],
      join(sep, 'private', 'tmp', 'build'),
      [join(sep, 'tmp', 'build')],
    )).toBe('deny')
  })

  test('a Cd rule never judges an ordinary tool call', () => {
    const compiled = program([['Cd(~/code/**)', 'deny']])
    // The ordinary evaluator sees no matching rule at all.
    expect(compiled.rules).toHaveLength(1)
    expect(compiled.rules[0]!.matcher.kind).toBe('cdPath')
  })
})
