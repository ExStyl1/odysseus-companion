/**
 * UB12.43 — ImageCardStack is no longer exempt from `nessy-styles/no-nonstandard-shadows`.
 *
 * v0.15.1's ImageCardStack draws the allow-listed `shadow-elev-2`, yet v0.15.1's
 * `packages/ui/eslint.config.mjs` still turns the rule off for it ("Temporary exceptions for
 * unresolved shadow migrations"). We dropped that entry, so the rule guards the file again.
 *
 * Arms (both lint through THIS package's real flat config, loaded from `packages/ui`):
 * - positive: the file as it stands lints with no `no-nonstandard-shadows` problem.
 * - control: the same source with `shadow-elev-2` swapped for the old arbitrary
 *   `shadow-[1px_3px_8px_rgba(0,0,0,0.28)]`, linted AT THE FILE'S OWN PATH, errors once. With the
 *   exemption back in the config this arm finds nothing and fails.
 */
import { describe, expect, it } from 'bun:test'
import { ESLint } from 'eslint'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PKG_DIR = join(import.meta.dir, '..', '..')
const FILE = join(PKG_DIR, 'src/components/markdown/ImageCardStack.tsx')
const RULE = 'nessy-styles/no-nonstandard-shadows'

function shadowProblems(results: ESLint.LintResult[]) {
  return results.flatMap((r) => r.messages).filter((m) => m.ruleId === RULE)
}

describe('ImageCardStack shadow exemption (UB12.43)', () => {
  const eslint = new ESLint({ cwd: PKG_DIR })
  const source = readFileSync(FILE, 'utf8')

  it('positive: ImageCardStack lints clean under the rule with no exemption', async () => {
    expect(source.split("'shadow-elev-2'").length - 1).toBe(1)
    const results = await eslint.lintFiles([FILE])
    expect(shadowProblems(results)).toEqual([])
  })

  it('control: an arbitrary shadow planted at the same path is reported', async () => {
    const planted = source.replace("'shadow-elev-2'", "'shadow-[1px_3px_8px_rgba(0,0,0,0.28)]'")
    expect(planted).not.toBe(source)
    const results = await eslint.lintText(planted, { filePath: FILE })
    const problems = shadowProblems(results)
    expect(problems).toHaveLength(1)
    expect(problems[0]!.severity).toBe(2)
    expect(problems[0]!.message).toContain('shadow-[1px_3px_8px_rgba(0,0,0,0.28)]')
  })
})
