/**
 * F1.254 (c) — `atomicWriteFileSync` writes through a temp name of its OWN.
 *
 * It wrote every file through the fixed `<file>.tmp`. Within one process the sync write and
 * rename cannot interleave, but `automations.json` is written by more than one process — the
 * host (`automations/management.ts`) and each per-session `session-mcp-server` subprocess
 * (`automation-management.ts` through `ctx.fs.atomicWriteFile`) — so two writes of the same
 * file at the same moment shared one temp path: the second truncated the first's temp, one
 * rename moved the other's content, and the other rename failed with ENOENT. Upstream
 * (craft-agents-oss v0.13.4, `packages/shared/src/utils/files.ts`, Apache-2.0) names the same
 * collision and builds the temp name from the pid plus random bytes; this takes that fix.
 *
 * The other writer is modelled by what it leaves at the moment of collision: its own temp
 * file sitting at `<file>.tmp`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../files.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'))
  dirs.push(dir)
  return dir
}

describe('atomicWriteFileSync temp names (F1.254 c)', () => {
  it('leaves another writer\'s in-flight temp at the fixed name untouched', () => {
    const dir = scratch()
    const target = join(dir, 'automations.json')
    writeFileSync(`${target}.tmp`, 'THE OTHER WRITER')
    atomicWriteFileSync(target, '{"mine":true}')
    expect(readFileSync(target, 'utf8')).toBe('{"mine":true}')
    expect(readFileSync(`${target}.tmp`, 'utf8')).toBe('THE OTHER WRITER')
  })

  it('leaves no temp of its own behind, and two writes use two temp names', () => {
    const dir = scratch()
    const target = join(dir, 'config.json')
    atomicWriteFileSync(target, 'one')
    atomicWriteFileSync(target, 'two')
    expect(readFileSync(target, 'utf8')).toBe('two')
    expect(readdirSync(dir)).toEqual(['config.json'])
  })
})
