/**
 * Tests for `read-changed-files.ts` — F1.622.
 *
 * Four gates hand this reader the files they cannot take from git and then
 * decide, per file, what a failed read means. So the two things pinned are the
 * ones those decisions rest on: the result lines up with the input whatever
 * order the reads finish in, and a failed read comes back as that file's
 * result — with the `code` `readFileSync` gave — instead of throwing and taking
 * its siblings' reads with it. Throwaway files under the OS temp dir only.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readFilesConcurrently } from './read-changed-files'

const root = mkdtempSync(join(tmpdir(), 'read-changed-files-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('readFilesConcurrently (F1.622)', () => {
  test('more files than readers in flight: every result is its own file\'s bytes, in input order', async () => {
    // Seven files through two readers, so the pool loop hands out work more
    // than once; a NUL and a multi-byte character, because one caller's
    // subject is a byte and the others decode after.
    const bodies = Array.from({ length: 7 }, (_, index) => Buffer.from(`file ${index} \u0000 déjà ✓\n`))
    const paths = bodies.map((body, index) => {
      const path = join(root, `f${index}.ts`)
      writeFileSync(path, body)
      return path
    })

    const reads = await readFilesConcurrently(paths, 2)
    expect(reads).toHaveLength(7)
    expect(reads).toEqual(bodies.map((bytes) => ({ ok: true, bytes })))
    expect(await readFilesConcurrently([])).toEqual([])
  })

  test('a failed read is that file\'s result, with readFileSync\'s code, and its neighbours are still read', async () => {
    const present = join(root, 'present.ts')
    writeFileSync(present, 'export const a = 1\n')
    const directory = join(root, 'a-directory')
    mkdirSync(directory)

    const reads = await readFilesConcurrently([join(root, 'no-such.ts'), present, directory])
    const codeOf = (index: number): string | undefined => {
      const read = reads[index]!
      return read.ok ? undefined : read.error.code
    }
    expect(reads.map((read) => read.ok)).toEqual([false, true, false])
    expect(codeOf(0)).toBe('ENOENT')
    // The positive control beside the failures: the file between them was read.
    expect(reads[1]).toEqual({ ok: true, bytes: Buffer.from('export const a = 1\n') })
    // EISDIR is not a vanished file: the caller that forgives only ENOENT must be able to tell.
    expect(codeOf(2)).toBe('EISDIR')
  })
})
