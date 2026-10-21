/**
 * Tests for `check-claude-bash-split-fuzz.ts` — P2.100.
 *
 * The artifact this file guards exists because two closed rows cited a
 * "blast-radius sweep" that was not in the tree. So the thing worth pinning is
 * not "does the fuzz run" but **can it still fail** — a differential fuzz that
 * cannot report a violation is exactly the citation it replaced.
 *
 * Kept cheap on purpose: the self-test spawns four bashes, and the fuzz slice
 * below is a few hundred. The 3000-case run that produced
 * `scripts/claude-bash-split-fuzz.txt` is a manual `--write`.
 */

import { describe, expect, test } from 'bun:test'

import {
  assertInert,
  evaluate,
  generateCorpus,
  runFuzz,
  selfTest,
  shellSimpleCommands,
} from './check-claude-bash-split-fuzz'

describe('the rig can fail', () => {
  test('every self-test passes, and the rig cannot lose one silently', () => {
    const results = selfTest()
    // The COUNT is asserted so a self-test silently deleted from the rig is a
    // red rather than a shorter green. The NUMBER is deliberately not in the
    // test's name: this case said "there are four of them" while asserting six
    // (P2.187, W4-c) — a title that has to be maintained beside the assertion is
    // a second copy of the same fact, and it went stale the first time the rig
    // grew.
    expect(results).toHaveLength(6)
    expect(results.filter(result => !result.ok)).toEqual([])
  })

  test('the safety gate refuses, in both of its two independent conditions', () => {
    // A safety gate that has never refused anything is not known to work, and
    // this one stands between a generated string and a real shell.
    expect(() => assertInert('rm -rf /tmp/x')).toThrow(/forbidden construct/)
    expect(() => assertInert('nc example')).toThrow(/unknown word/)
    // …and does not refuse the vocabulary it exists to admit.
    expect(() => assertInert("echo a && printf b # don't")).not.toThrow()
  })
})

describe('the oracle reads the real shell', () => {
  test('a comment tail hides a command from a scanner, never from bash', () => {
    // F1's class. If this stops being 2, the oracle stopped working and every
    // green below means nothing.
    expect(shellSimpleCommands("echo x # don't\necho y #'")).toEqual(['echo x', 'echo y'])
    // Control: an ordinary list, so a hard-coded 2 would be visible.
    expect(shellSimpleCommands('echo a && echo b | echo c')).toEqual(['echo a', 'echo b', 'echo c'])
    // A command bash itself cannot parse is not a divergence.
    expect(shellSimpleCommands('echo a &&')).toBeNull()
  })
})

describe('the corpus and the invariant', () => {
  test('the corpus leads with the seeds this rig exists for', () => {
    const corpus = generateCorpus(10, 1)
    expect(corpus[0]).toBe("echo x # don't\necho y #'")
    expect(corpus[1]).toBe(String.raw`echo $'a'b # c`)
    expect(corpus).toHaveLength(10)
    // Deterministic: the same seed is the same corpus, which is what makes a
    // reported violation reproducible.
    expect(generateCorpus(10, 1)).toEqual(corpus)
    expect(generateCorpus(10, 2)).not.toEqual(corpus)
  })

  test('the F1 fixture is neutralised by the ALLOW corroboration, not by the splitter', () => {
    // The measured shape, and the reason it is recorded here rather than
    // assumed: the byte-level divergence F1 named is still intact — one
    // subcommand where bash runs two — and what makes it harmless is that the
    // allow verdict is `unparseable`, which prompts.
    const verdict = evaluate("printf a <<< 'x' # don't\necho y #'")
    expect(verdict.ourCount).toBe(1)
    expect(verdict.shellCount).toBe(2)
    expect(verdict.allowVerdict).toBe('unparseable')
    expect(verdict.violation).toBe(false)
  })

  test('a short run reaches the governed band and reports no violation', () => {
    const report = runFuzz(300, 20260903)
    expect(report.violations).toEqual([])
    // The band size is asserted because a fuzz that governs nothing is the
    // failure this row exists to correct — an unweighted generator parked all
    // but THREE of 181 executed cases outside it. If this floor stops being
    // met, the corpus stopped exercising the invariant and the green is empty.
    const governed = report.executed - report.unparseable - report.noMatch
    expect(governed).toBeGreaterThan(20)
    expect(report.executed).toBeGreaterThan(150)
  }, 300_000)
})
