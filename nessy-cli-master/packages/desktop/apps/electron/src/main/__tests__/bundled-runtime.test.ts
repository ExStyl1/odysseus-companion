import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { resolveBundledBunPath } from '../bundled-runtime'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createRuntime(relativePath: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'bundled-runtime-'))
  const path = join(root, relativePath)
  tempDirs.push(root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  return { root, path }
}

describe('resolveBundledBunPath', () => {
  it('resolves the Bun binary for the current packaged architecture', () => {
    const runtime = createRuntime('vendor/bun/darwin-arm64/bun')

    expect(resolveBundledBunPath(runtime.root, 'darwin', 'arm64')).toBe(runtime.path)
  })

  it('does not fall back to Bun on PATH when the bundle is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-runtime-'))
    tempDirs.push(root)

    expect(resolveBundledBunPath(root, 'darwin', 'arm64')).toBeUndefined()
  })
})
