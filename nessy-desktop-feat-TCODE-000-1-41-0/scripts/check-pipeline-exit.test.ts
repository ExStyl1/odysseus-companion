/**
 * The enforcing reader for `check-pipeline-exit.ts` — CI runs `bun test`, and it
 * does not run `validate:ci`. The scanner's own header carries the measurement
 * (including the zsh `PIPESTATUS` refutation); this file is what makes it fire.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { scanPackageScripts, scanShellScripts, tracked } from './check-pipeline-exit.ts'

describe('P2.275 — a gate definition may not discard its own exit status', () => {
  it('finds no lost-exit pipeline in any tracked shell script', () => {
    expect(scanShellScripts().map(finding => `${finding.file}:${finding.where}`)).toEqual([])
  })

  it('finds no gate piped into a text filter in any package.json script', () => {
    expect(scanPackageScripts().map(finding => `${finding.file}:${finding.where}`)).toEqual([])
  })

  it('reads a real population, so an empty verdict is a verdict', () => {
    // The positive control both assertions need: without it, a `git ls-files`
    // that matched nothing would make this file green forever — which is the
    // shape of the absence checks this plan keeps finding.
    expect(tracked('*.sh').length).toBeGreaterThan(5)
    expect(tracked('package.json', '*/package.json', '*/*/package.json').length).toBeGreaterThan(5)
  })

  it('goes RED on the two shapes it exists for', () => {
    // Planted reds, in temp files, because a guard that cannot be shown to fail
    // is indistinguishable from one whose branches were deleted.
    const dir = mkdtempSync(resolve(tmpdir(), 'p2275-'))
    try {
      const script = resolve(dir, 'planted.sh')
      writeFileSync(script, '#!/bin/bash\nset -e\nVERSION=$(cat pkg.json | grep version | head -1)\necho "$VERSION"\n')
      const shell = scanShellScripts([script])
      expect(shell.map(finding => finding.where)).toEqual(['line 3'])
      expect(shell[0]?.why).toContain('EMPTY value')

      // …and the same script with `pipefail` is accepted, so the rule is about
      // the missing option rather than about the presence of a pipe.
      writeFileSync(script, '#!/bin/bash\nset -e\nset -o pipefail\nVERSION=$(cat pkg.json | grep version | head -1)\n')
      expect(scanShellScripts([script])).toEqual([])

      const manifest = resolve(dir, 'package.json')
      writeFileSync(manifest, JSON.stringify({ scripts: { gate: 'bun run typecheck | tail -20', fine: 'bun test' } }))
      const scripts = scanPackageScripts([manifest])
      expect(scripts.map(finding => finding.where)).toEqual(['scripts.gate'])
      expect(scripts[0]?.why).toContain('exit 0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
