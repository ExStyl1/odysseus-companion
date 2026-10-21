/**
 * Tests for `gate-projects.ts` — P2.390.
 *
 * The claim under test is narrow and the whole row: given a gate step's NAME,
 * name the tsconfig it will actually compile. Every case is a synthetic scripts
 * map, so the assertions are about the resolver and not about this repo's own
 * manifest — which changes under it.
 *
 * The negative cases carry as much of the row as the positive ones. A resolver
 * that guesses a label is the defect being fixed, one step further along: two
 * lanes guessed and both were wrong.
 */

import { describe, expect, test } from 'bun:test'

import {
  ownershipNote,
  resolveStepProjects,
  resolveStepScripts,
  stepOwnerLabels,
  stepProjectPaths,
} from './gate-projects.ts'
import { GateSafetyRefusal } from './gate-safety.ts'

/** No disk: a package script map keyed by repo-relative directory. */
function packageScripts(byDir: Record<string, Record<string, string>>) {
  return (dir: string) => byDir[dir]
}

describe('resolveStepProjects', () => {
  test('a bare `tsc` after a `cd` is that directory\'s tsconfig.json', () => {
    const scripts = { 'typecheck:shared': 'cd packages/shared && bun run tsc --noEmit' }
    expect(stepProjectPaths(scripts, 'typecheck:shared', packageScripts({}))).toEqual([
      'packages/shared/tsconfig.json',
    ])
  })

  test('an explicit `-p` wins over the directory default', () => {
    // The case that makes guessing wrong rather than merely imprecise:
    // `pi-agent-server`'s chain entry compiles `tsconfig.typecheck.json`, and
    // its `tsconfig.json` has no exclusions at all — so the default guess would
    // name a program with a 32-file hole as the one that ran.
    const scripts = { 'typecheck:pi': 'cd packages/pi-agent-server && bun run typecheck' }
    const dirs = packageScripts({
      'packages/pi-agent-server': {
        typecheck: 'bun run check:surface && tsc --noEmit -p tsconfig.typecheck.json',
        'check:surface': 'bun scripts/check-surface.ts',
      },
    })
    expect(stepProjectPaths(scripts, 'typecheck:pi', dirs)).toEqual([
      'packages/pi-agent-server/tsconfig.typecheck.json',
    ])
  })

  test('one step can compile several programs, in execution order', () => {
    const scripts = {
      'typecheck:scripts':
        'bun run tsc -p scripts/tsconfig.json && bun run tsc -p scripts/tsconfig.ipc-inventory.json',
      'typecheck:core': 'cd packages/core && bun run typecheck',
    }
    const dirs = packageScripts({
      'packages/core': { typecheck: 'tsc --noEmit && tsc --noEmit -p tsconfig.tests.json' },
    })

    expect(stepProjectPaths(scripts, 'typecheck:scripts', dirs)).toEqual([
      'scripts/tsconfig.json',
      'scripts/tsconfig.ipc-inventory.json',
    ])
    expect(stepProjectPaths(scripts, 'typecheck:core', dirs)).toEqual([
      'packages/core/tsconfig.json',
      'packages/core/tsconfig.tests.json',
    ])
  })

  test('the cwd survives a relative climb between segments', () => {
    const scripts = { step: 'cd packages/core && cd ../shared && bun run tsc --noEmit' }
    expect(stepProjectPaths(scripts, 'step', packageScripts({}))).toEqual([
      'packages/shared/tsconfig.json',
    ])
  })

  test('a step that runs no compiler resolves to nothing at all', () => {
    // `typecheck:coverage` and every lint step. No label beats a guessed one.
    const scripts = { 'typecheck:coverage': 'bun scripts/check-typecheck-coverage.ts' }
    expect(resolveStepProjects(scripts, 'typecheck:coverage', packageScripts({}))).toEqual([])
  })

  test('a step name the manifest does not define resolves to nothing', () => {
    expect(stepProjectPaths({}, 'no-such-step', packageScripts({}))).toEqual([])
  })

  test('a `cd` that climbs out of the repo stops the walk instead of labelling', () => {
    const scripts = { step: 'cd .. && bun run tsc --noEmit' }
    expect(stepProjectPaths(scripts, 'step', packageScripts({}))).toEqual([])
  })

  test('a self-referential script terminates instead of recursing forever', () => {
    const scripts = { a: 'bun run b', b: 'bun run a && cd packages/core && bun run tsc --noEmit' }
    expect(stepProjectPaths(scripts, 'a', packageScripts({}))).toEqual([
      'packages/core/tsconfig.json',
    ])
  })

  test('refuses a `cd` naming a home directory rather than labelling it', () => {
    const scripts = { step: 'cd ~/elsewhere && bun run tsc --noEmit' }
    expect(() => stepProjectPaths(scripts, 'step', packageScripts({}))).toThrow(GateSafetyRefusal)
  })

  test('refuses a tsconfig named by an absolute path', () => {
    const scripts = { step: 'bun run tsc -p /etc/tsconfig.json' }
    expect(() => stepProjectPaths(scripts, 'step', packageScripts({}))).toThrow(GateSafetyRefusal)
  })
})

describe('stepOwnerLabels — P2.416: a scanning step names the script it ran', () => {
  test('a compiling step is still labelled by its TSCONFIG, not by the script that ran tsc', () => {
    // The precedence that matters: for a red typecheck the tsconfig is the owner
    // (P2.390) and the invoking script is noise.
    const scripts = { step: 'cd packages/core && bun run tsc --noEmit' }
    expect(stepOwnerLabels(scripts, 'step', packageScripts({}))).toEqual([
      'packages/core/tsconfig.json',
    ])
  })

  test('a step that compiles nothing is labelled by its SCRIPT instead of going unlabelled', () => {
    const scripts = { 'lint:nul-bytes': 'bun scripts/check-nul-bytes.ts --check' }
    expect(stepOwnerLabels(scripts, 'lint:nul-bytes', packageScripts({}))).toEqual([
      'scripts/check-nul-bytes.ts',
    ])
    // and it still resolves to no tsconfig, so `ownershipNote` stays silent about it
    expect(resolveStepProjects(scripts, 'lint:nul-bytes', packageScripts({}))).toEqual([])
  })

  test('the script path is resolved against the step\'s cwd', () => {
    const scripts = { step: 'cd packages/shared && bun tools/scan.ts' }
    expect(resolveStepScripts(scripts, 'step', packageScripts({}))).toEqual([
      'packages/shared/tools/scan.ts',
    ])
  })

  test('a step naming no script file and no tsconfig stays unlabelled rather than guessing', () => {
    const scripts = { step: 'echo hello' }
    expect(stepOwnerLabels(scripts, 'step', packageScripts({}))).toEqual([])
  })

  test('refuses a script named by an absolute path rather than labelling it', () => {
    const scripts = { step: 'bun /etc/evil.ts' }
    expect(() => stepOwnerLabels(scripts, 'step', packageScripts({}))).toThrow(GateSafetyRefusal)
  })
})

describe('ownershipNote', () => {
  test('names every red step\'s program once, with the paragraph once', () => {
    const note = ownershipNote([
      { name: 'typecheck:shared', projects: ['packages/shared/tsconfig.json'] },
      { name: 'typecheck:scripts', projects: ['scripts/tsconfig.json', 'scripts/cdp/tsconfig.json'] },
    ])

    expect(note).toContain('typecheck:shared failed under: packages/shared/tsconfig.json')
    expect(note).toContain(
      'typecheck:scripts failed under: scripts/tsconfig.json, scripts/cdp/tsconfig.json',
    )
    // Once, not once per step — three copies under three reds is what made the
    // general claim read as a claim about one of them.
    expect(note.match(/is not its owner/g)).toHaveLength(1)
  })

  test('says nothing when no red step compiled anything', () => {
    expect(ownershipNote([{ name: 'lint:ui', projects: [] }])).toBe('')
    expect(ownershipNote([])).toBe('')
  })
})
