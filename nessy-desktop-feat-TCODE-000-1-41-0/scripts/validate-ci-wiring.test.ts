/**
 * Tests for the WIRING of the root gate chains — P2.431.
 *
 * These assert about `package.json`, not about any scanner's output. The defect
 * they pin is the one P2.416 shipped and P2.431 closed: two scanners existed,
 * both had tests, both were steps of `lint:chain`, CI walked that chain — and
 * `validate:ci`, the command AGENTS.md tells people to run before claiming
 * completion, called `lint:coverage` directly and reached neither.
 *
 * A guard nothing invokes has already stopped working, so "is it invoked from
 * the developer's entry point" is itself an invariant, and it is exactly the
 * kind that decays silently: nothing fails, the gate is simply absent.
 *
 * Two shapes are pinned, because the wiring can rot in two different ways:
 *
 *  1. REACH — `validate:ci` must transitively reach every step of `lint:chain`.
 *     Delegating to `bun run lint` satisfies this for every step at once; a
 *     hand-copied subset satisfies it until someone adds one more step, which is
 *     the failure this test exists to catch. The step COUNT is deliberately not
 *     written here — this line said "nineteen" until 2026-09-12, when
 *     `bun scripts/run-gates.ts lint:chain --list` ended in `31 steps`; read it
 *     from that command, which is the only place that cannot go stale.
 *  2. ARMING — each scanner step must still carry `--check`. Both scanners exit
 *     0 by default on purpose (they are instruments as well as gates), so
 *     dropping the flag disarms the gate while leaving every step green and the
 *     chain visibly unchanged. That is a disarm no other test in this repo would
 *     notice.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function rootScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }
  return manifest.scripts ?? {}
}

/**
 * Every script name transitively reachable from `name`.
 *
 * Two edge kinds, and the second is why this walker exists here rather than
 * being borrowed from `gate-projects.ts`: that module follows `bun run <name>`
 * only, so it stops dead at `bun scripts/run-gates.ts lint:chain` and reports
 * `scripts/run-gates.ts` as the whole of what `bun run lint` does. Reading THAT
 * as the answer is how a chain looks reachable while its steps are not.
 */
export function reachableScripts(
  scripts: Readonly<Record<string, string>>,
  name: string,
  seen: Set<string> = new Set(),
): Set<string> {
  if (seen.has(name)) return seen
  seen.add(name)

  const body = scripts[name]
  if (body === undefined) return seen

  for (const rawSegment of body.split('&&')) {
    const segment = rawSegment.trim()

    const run = /^bun run ([A-Za-z0-9:._-]+)(?:\s|$)/.exec(segment)?.[1]
    if (run !== undefined && scripts[run] !== undefined) {
      reachableScripts(scripts, run, seen)
      continue
    }

    const chain = /^bun (?:run )?scripts\/run-gates\.ts ([A-Za-z0-9:._-]+)/.exec(segment)?.[1]
    if (chain !== undefined) reachableScripts(scripts, chain, seen)
  }

  return seen
}

function chainSteps(scripts: Readonly<Record<string, string>>, chain: string): string[] {
  const body = scripts[chain]
  if (body === undefined) throw new Error(`no "${chain}" script in the root package.json`)
  return body
    .split('&&')
    .map((segment) => /^bun run ([A-Za-z0-9:._-]+)$/.exec(segment.trim())?.[1])
    .filter((step): step is string => step !== undefined)
}

describe('validate:ci reaches the gates it is supposed to run', () => {
  test('both scanners are reachable from validate:ci', () => {
    const reached = reachableScripts(rootScripts(), 'validate:ci')

    expect([...reached].includes('lint:nul-bytes')).toBe(true)
    expect([...reached].includes('lint:conditional-expect')).toBe(true)
    expect([...reached].includes('lint:coverage')).toBe(true)
  })

  test('EVERY step of lint:chain is reachable from validate:ci, not a copied subset', () => {
    const scripts = rootScripts()
    const reached = reachableScripts(scripts, 'validate:ci')
    const steps = chainSteps(scripts, 'lint:chain')

    expect(steps.length).toBeGreaterThan(10)
    expect(steps.filter((step) => !reached.has(step))).toEqual([])
  })

  test('the walker can see the narrowing it exists to catch', () => {
    // The pre-P2.431 body, verbatim. Without this control the two tests above
    // would also pass against a walker that returned every script in the file.
    const narrowed = {
      ...rootScripts(),
      'validate:ci':
        'bun run lint:i18n:parity && bun run lint:i18n:sorted && bun run lint:coverage && ' +
        'bun run ipc:inventory:check && bun run check:coverage-map && bun run validate:dev',
    }
    const reached = reachableScripts(narrowed, 'validate:ci')

    expect(reached.has('lint:coverage')).toBe(true)
    expect(reached.has('lint:nul-bytes')).toBe(false)
    expect(reached.has('lint:conditional-expect')).toBe(false)
  })
})

describe('the scanner steps are armed', () => {
  // Both scripts exit 0 without `--check`: `check-nul-bytes` because two files
  // legitimately carried NULs while other lanes held them, `check-conditional-
  // expect` because its population is a floor to read rather than a defect list.
  // So a step that lost the flag would be a green, present, useless gate.
  test.each([
    ['lint:nul-bytes', 'scripts/check-nul-bytes.ts', '--check'],
    ['lint:conditional-expect', 'scripts/check-conditional-expect.ts', '--check'],
    // P2.433's second selector shares the script and NOT the flag, which is the
    // point of it being its own step: a red names which of the two classes it is.
    ['lint:matcher-mutation', 'scripts/check-conditional-expect.ts', '--check-matchers'],
    // P6.926: the two generators are the same shape as the two scanners above,
    // and worse when disarmed. Bare — no flag at all — each one PRINTS ITS
    // ARTEFACT to stdout and exits 0, so a step that lost `--self-test` would
    // dump the whole regenerated document into the lint output and stay green,
    // while the harvester it exists to pin went unasserted. One chain step runs
    // both, so both scripts are named here rather than one row per step.
    ['lint:generator-self-test', 'scripts/build-parity-report.py', '--self-test'],
    ['lint:generator-self-test', 'scripts/regenerate-deviation-register.py', '--self-test'],
    // P6.987, and this one is worse disarmed than any scanner above: bare —
    // no flag at all — `sort-plan-tracker.py <plan>` SORTS AND WRITES the plan
    // it is handed. A step that lost `--shas` would rewrite the controller's
    // tracker on every lint run and report nothing about a phantom sha. The
    // same step carries `--self-test`, whose loss is the P6.926 shape: the
    // extractor it pins would go unasserted while the step stayed green.
    ['lint:plan-shas', 'scripts/sort-plan-tracker.py', '--shas'],
    ['lint:plan-shas', 'scripts/sort-plan-tracker.py', '--self-test'],
  ])('%s runs %s with %s', (step, script, flag) => {
    const body = rootScripts()[step]

    expect(body).toContain(script)
    expect(body).toContain(flag)
  })

  /**
   * C3.315 — the same disarm shape, one hop further out, and the worst of the
   * set for two reasons.
   *
   * First, the flag that arms it is not in the step's own body: the root step
   * delegates to `packages/pi-agent-server`'s `check:surface:live`, and
   * `--live-json-schema` lives there. A `test.each` row over the root body alone
   * would pass against a step wired to the DEFAULT arm.
   *
   * Second, a disarm here does not even leave a visibly empty step. Dropping the
   * flag leaves a real gate that really passes — `check:surface`, seven
   * source-text digests — while the 61 model-facing `live-json-schema` pins go
   * unread. That is not hypothetical: `437e0b18b` widened `ReviewDiffSchema`
   * (`packages/session-tools-core`) without re-pinning, and the drift survived a
   * whole wave because nothing short of root `bun test` recomputed those digests
   * and the default `check:surface` exits 0 on them by design (P6.818).
   *
   * The negative arm is the other half of that design: `check:surface` must stay
   * flagless, or the opt-in decision would be gone by accident and every lane's
   * `typecheck:pi-agent-server` would grow the live arm's cost (measured
   * 2026-09-12, paired A/B/A/B at load 8.9 → 7.9: default 9.24 s / 10.08 s, live
   * 40.41 s / 47.29 s, `user` 0.28 `sys` 0.15 — per-file-open I/O, not compute).
   */
  test('lint:surface:live reaches the pi-agent-server arm that carries --live-json-schema', () => {
    const body = rootScripts()['lint:surface:live']

    expect(body).toContain('packages/pi-agent-server')
    expect(body).toContain('check:surface:live')

    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', 'pi-agent-server', 'package.json'), 'utf-8'),
    ) as { scripts?: Record<string, string> }
    const scripts = manifest.scripts ?? {}

    expect(scripts['check:surface:live']).toContain('src/harness/source-state-contract.ts')
    expect(scripts['check:surface:live']).toContain('--live-json-schema')
    expect(scripts['check:surface']).not.toContain('--live-json-schema')
  })

  test('lint:surface:live is a step of lint:chain, not merely a script that exists', () => {
    const scripts = rootScripts()

    expect(chainSteps(scripts, 'lint:chain')).toContain('lint:surface:live')
    expect(reachableScripts(scripts, 'validate:ci').has('lint:surface:live')).toBe(true)
  })

  /**
   * D1.173 — REACH, which is a different invariant from ARMING and from being a
   * chain step, and the one the two measurements below went through.
   *
   * The gate above is armed and chained. Neither fact reaches the lane that
   * breaks the pins, because that lane edits
   * `packages/session-tools-core/src/tool-defs.ts` and runs
   * `typecheck:session-tools-core`, not `lint:chain`. The class has landed
   * TWICE and both times on the same pin, `session.review_diff`:
   *
   *  - `437e0b18b` (2026-09-11 23:44) widened `ReviewDiffSchema`; `091c62ea7`
   *    re-pinned the digest 2 h 05 m later.
   *  - `4b155cbfe` (2026-09-13 14:29) flipped its description with the default;
   *    `bb8f6606f` re-pinned 7 minutes later, its own subject recording that
   *    the digests "could not have repaired with `--pin`".
   *
   * Both repairs are separate commits after the fact. So the root script now
   * routes through the package's OWN `typecheck` — the shape
   * `typecheck:pi-agent-server` has always had — and that script runs the live
   * arm. The cost is one run of a gate measured green at 61/61, and it lands on
   * the lane that can actually move a pin.
   */
  test('a lane running typecheck:session-tools-core reaches the live surface gate', () => {
    const rootBody = rootScripts()['typecheck:session-tools-core']
    expect(rootBody).toBeDefined()
    // Through the package's own script, not a bare compiler call: that is what
    // gives the package somewhere to hang the gate.
    expect(rootBody).toContain('bun run typecheck')
    expect(rootBody).not.toContain('bun run tsc')

    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', 'session-tools-core', 'package.json'), 'utf-8'),
    ) as { scripts?: Record<string, string> }
    const packageTypecheck = manifest.scripts?.typecheck ?? ''

    expect(packageTypecheck).toContain('tsc --noEmit')
    expect(packageTypecheck).toContain('check:surface:live')
    expect(packageTypecheck).toContain('pi-agent-server')

    // The negative arm, and it is the whole point: the body this replaced —
    // verbatim — names neither the package script nor the gate, so a revert
    // fails here rather than silently restoring the gap.
    const previous = 'cd packages/session-tools-core && bun run tsc --noEmit'
    expect(previous).not.toContain('bun run typecheck')
    expect(rootBody).not.toBe(previous)
  })
})
