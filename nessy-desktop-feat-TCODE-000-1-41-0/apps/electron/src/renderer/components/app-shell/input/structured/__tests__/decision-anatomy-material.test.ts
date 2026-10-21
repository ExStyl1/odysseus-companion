/**
 * UB14.25 — no structured card keeps the pre-redesign material (the row's `rg 'bg-info/5' structured/` → 0,
 * widened to the whole old card recipe). Every card source in `structured/` (the `.ts`/`.tsx` files beside this
 * folder — tests excluded, since their negative assertions spell the needles) is read and scanned.
 *
 * Positive: the scan reads the five card sources and finds none of the needles. Negative (planted control): the
 * same scanner, run over a temporary folder holding one planted card line, reports that file and that needle —
 * so an empty result above is the scanner finding nothing, not the scanner reading nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The old card material: the tinted fill and border, the 8px radius, the literal shadow, the dashed refusal. */
const OLD_MATERIAL = ['bg-info/5', 'border-info/30', 'bg-destructive/5', 'rounded-[8px]', 'shadow-middle', 'border-dashed'] as const

function scan(dir: string): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const name of readdirSync(dir).filter(file => /\.tsx?$/.test(file)).sort()) {
    const source = readFileSync(join(dir, name), 'utf8')
    const hits = OLD_MATERIAL.filter(needle => source.includes(needle))
    if (hits.length > 0) found[name] = hits
  }
  return found
}

const STRUCTURED = new URL('..', import.meta.url).pathname
const planted = mkdtempSync(join(tmpdir(), 'ub14-25-planted-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))

describe('UB14.25 · the structured cards carry no pre-redesign material', () => {
  test('POSITIVE — every card source in structured/ is read, and none keeps the old material', () => {
    const sources = readdirSync(STRUCTURED).filter(file => /\.tsx?$/.test(file))
    for (const card of ['AskUserRequest.tsx', 'WorkflowLaunchRequest.tsx', 'ArtifactPublishDetails.tsx', 'PermissionRequest.tsx', 'AdminApprovalRequest.tsx', 'CredentialRequest.tsx']) {
      expect(sources).toContain(card)
    }
    // The reader reads: the anatomy's own file carries the new material it is checked against.
    expect(readFileSync(join(STRUCTURED, 'DecisionCard.tsx'), 'utf8')).toContain('bg-raised shadow-elev-2')
    expect(scan(STRUCTURED)).toEqual({})
  })

  test('NEGATIVE (planted control) — the same scanner reports a planted old card line', () => {
    writeFileSync(join(planted, 'Planted.tsx'), "export const card = 'overflow-hidden h-full flex flex-col bg-info/5'\n")
    writeFileSync(join(planted, 'Clean.tsx'), "export const card = 'rounded-xl bg-raised shadow-elev-2'\n")
    expect(scan(planted)).toEqual({ 'Planted.tsx': ['bg-info/5'] })
  })
})
