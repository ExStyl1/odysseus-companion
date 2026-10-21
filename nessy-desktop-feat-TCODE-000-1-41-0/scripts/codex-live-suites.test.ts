/**
 * D1.123 — the codex live-boot family is DERIVED, and the derivation has to be
 * narrow enough to mean something.
 *
 * Two failure modes, opposite to each other, and a list-based script would hide
 * both: a classifier that misses a member (the family silently shrinks, and the
 * suites that stop running are exactly the expensive ones nobody notices), and a
 * classifier that sweeps in every file naming the word codex (the count stops
 * being a fact about booting the binary at all).
 *
 * The NEGATIVE control is therefore a file that names the staged binary's path
 * and never spawns it — `agent/backend/__tests__/runtime-resolver.test.ts`,
 * which resolves the path as its subject. Without it this file passes against a
 * classifier that answers "member" for everything.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyCodexLiveSuite,
  discoverCodexLiveSuites,
  stagedCodexAppServer,
} from './codex-live-suites.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('D1.123 — the codex live-boot family names itself', () => {
  it('discovers members across all three gates, and every member is a real file', () => {
    const suites = discoverCodexLiveSuites(REPO_ROOT)

    // Not a pinned COUNT: the family grows, and a count here would be the
    // hand-written list this script exists to replace. What is pinned is that
    // each gate is represented, because a gate that loses its last member is a
    // classifier arm nothing exercises.
    const gates = new Set(suites.map(suite => suite.gate))
    expect(gates.has('have-bin')).toBe(true)
    expect(gates.has('runtime-manager')).toBe(true)
    expect(gates.has('env-opt-in')).toBe(true)

    // TOTALITY: a member whose gate could not be identified is the state the
    // classifier must never reach quietly — it would be run by the script and
    // skipped by itself, for a reason nobody recorded.
    expect(suites.filter(suite => suite.gate === 'none')).toEqual([])

    for (const suite of suites) {
      expect(suite.path.startsWith('./'), `${suite.path} must be a PATH, not a bun test FILTER`)
        .toBe(true)
      expect(existsSync(join(REPO_ROOT, suite.path.slice(2))), `${suite.path} is not on disk`)
        .toBe(true)
    }
  })

  it('NEGATIVE — a file that names the staged path without spawning it is not a member', () => {
    const suites = discoverCodexLiveSuites(REPO_ROOT).map(suite => suite.path)
    // The control: it builds the same `'bin', 'codex'` path and never boots it.
    expect(suites).not.toContain('./packages/shared/src/agent/backend/__tests__/runtime-resolver.test.ts')
    // The positive half on the same instrument, so the assertion above cannot
    // pass by the discovery having found nothing at all.
    expect(suites).toContain('./packages/codex-responses-adapter/src/__tests__/sandbox-enforcement.test.ts')
  })

  it('classifies the three gates from source, and declines a non-booting file', () => {
    expect(classifyCodexLiveSuite(
      "const BIN = join(root, 'bin', 'codex');\nconst HAVE_BIN = true;\nspawn(BIN, []);",
    )).toBe('have-bin')
    expect(classifyCodexLiveSuite(
      "const BIN = join(root, 'bin', 'codex');\nmanager.spawn({});",
    )).toBe('runtime-manager')
    expect(classifyCodexLiveSuite(
      "const BIN = join(root, 'bin', 'codex');\nif (process.env.NESSY_CODEX_E2E === '1') manager.spawn({});",
    )).toBe('env-opt-in')
    // Names the path, boots nothing.
    expect(classifyCodexLiveSuite(
      "const BIN = join(root, 'bin', 'codex');\nexpect(existsSync(BIN)).toBe(true);",
    )).toBeUndefined()
    // Names nothing.
    expect(classifyCodexLiveSuite('spawn(BIN, []);')).toBeUndefined()
  })

  it('resolves the staged binary the same way the suites do', () => {
    const binary = stagedCodexAppServer(REPO_ROOT)
    expect(binary).toContain(join('apps', 'electron', 'resources', 'bin', 'codex'))
    expect(binary).toContain(`${process.platform}-${process.arch}`)
  })
})
