/**
 * P6.584 — the composer wiring, which is the half `learn-image-refusal.test.ts`
 * cannot see.
 *
 * That suite proves the decision: the seam anchors the endpoint's sentence, the
 * resolver writes the LEARNED flag once, a generic 400 learns nothing, and
 * `resolveStagedImagePolicy` hands the stored sentence back. All of it passes
 * with the two renderer call sites REMOVED, because none of it is reached from
 * the running app until something calls it.
 *
 * So this suite asserts the call sites themselves, at source level. That is the
 * same instrument `BranchSwitcher.test.tsx` uses and for the same reason: `bun
 * test` has no DOM, and importing either component pulls a UI barrel bun cannot
 * resolve. The assertions are deliberately about the ARGUMENTS, not about a
 * line: passing `connection` without `modelId` (or the other way round) yields
 * `undefined` from the policy and the banner silently stops quoting anything,
 * which is precisely the failure this row was reopened for.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const composerSource = readFileSync(
  fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)),
  'utf8',
)
const chatDisplaySource = readFileSync(
  fileURLToPath(new URL('../../ChatDisplay.tsx', import.meta.url)),
  'utf8',
)

describe('P6.584 — the composer asks for the learned sentence and quotes it', () => {
  it('hands BOTH the connection and the model into the staged-image policy', () => {
    const call = composerSource.slice(
      composerSource.indexOf('resolveStagedImagePolicy({'),
    ).slice(0, 600)
    expect(call).toContain('connection: effectiveConnectionDetails')
    expect(call).toContain('modelId: currentModel')
  })

  it('spreads the sentence into the warning banner', () => {
    const banner = composerSource.slice(
      composerSource.indexOf('<ImageSupportWarningBanner'),
    ).slice(0, 600)
    expect(banner).toContain('stagedImagePolicy.refusalSentence')
    expect(banner).toContain('refusalSentence: stagedImagePolicy.refusalSentence')
  })
})

describe('P6.584 — the writer has exactly one call site, on a turn error', () => {
  it('calls the hook and feeds it the last message\'s error details', () => {
    expect(chatDisplaySource).toContain('useLearnImageRefusal')
    expect(chatDisplaySource).toContain(
      'void learnImageRefusalFromTurn(sessionConnectionSlug, currentModel, lastMessageErrorDetails)',
    )
  })

  it('negative — the call is guarded by the error role, so an ordinary turn writes nothing', () => {
    const effect = chatDisplaySource.slice(
      chatDisplaySource.indexOf('const learnImageRefusalFromTurn'),
    ).slice(0, 900)
    expect(effect).toContain("if (lastMessageRole !== 'error') return")
    // and the guard precedes the call, rather than sitting after it
    expect(effect.indexOf("if (lastMessageRole !== 'error') return"))
      .toBeLessThan(effect.indexOf('void learnImageRefusalFromTurn('))
  })

  it('is the ONLY call site — a second one would be a second way to write one field', () => {
    const callSites = [composerSource, chatDisplaySource]
      .join('\n')
      .match(/learnImageRefusalFromTurn\(/g) ?? []
    expect(callSites).toHaveLength(1)
  })
})
