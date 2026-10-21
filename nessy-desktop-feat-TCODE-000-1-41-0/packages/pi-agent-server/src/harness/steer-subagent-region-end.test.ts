/**
 * F1.469 — `agent.steer_subagent`'s hashed region ENDS at its factory.
 *
 * Every other `SOURCE_STATE_FACTORIES` row in `subagent-tool.ts` names an `end` (the next
 * factory's first line); `steer_subagent` is the file's last factory and had none, so its
 * region ran to the end of the file and took in `turnLimitNotice` / `turnLimitPrefix`
 * (F1.225) — code the model never sees as this tool's schema. Any edit below the factory
 * moved the pin, and the gate reported a schema drift that was positional, not real
 * (WJ-mm met it on F1.286).
 */
import { describe, expect, it } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { SOURCE_STATE_FACTORIES, sourceStateDigest, sourceStateFactoryBlock } from './source-state-contract.ts'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const STEER = SOURCE_STATE_FACTORIES.steer_subagent!

/** A synthetic repo holding one copy of the factory's file, edited by `edit`. */
function digestWith(edit: (source: string) => string): string {
  const root = mkdtempSync(join(tmpdir(), 'f1469-'))
  try {
    const target = join(root, STEER.path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(REPO_ROOT, STEER.path), target)
    writeFileSync(target, edit(readFileSync(target, 'utf8')))
    return sourceStateDigest(root, STEER)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('F1.469 · steer_subagent\'s region has an end', () => {
  it('the region is the factory and nothing after it', () => {
    const block = sourceStateFactoryBlock(REPO_ROOT, STEER)
    expect(block.startsWith('export function createSteerSubagentTool')).toBe(true)
    expect(block).toContain("name: 'steer_subagent'")
    expect(block).not.toContain('turnLimitNotice')
  })

  it('an edit just past the factory does not move its digest; an edit inside it does', () => {
    const baseline = digestWith(source => source)
    expect(digestWith(source => `${source}\n// one more line below every factory\n`)).toBe(baseline)
    expect(digestWith(source => source.replace('[partial]', '[partial!]'))).toBe(baseline)
    // Negative control on the same instrument: the tool's own label is inside the region.
    expect(digestWith(source => source.replace("label: 'Steer Subagent'", "label: 'Steer Subagents'"))).not.toBe(baseline)
  })
})
