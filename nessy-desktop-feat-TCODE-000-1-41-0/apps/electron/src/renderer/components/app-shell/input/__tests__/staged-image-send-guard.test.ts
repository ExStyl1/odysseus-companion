/**
 * F1.983 — the composer's non-vision block holds on EVERY send path, not only
 * on the Send button.
 *
 * `StagedImagePolicy.blocked` promises "the send is refused until they go".
 * The composer used to keep that promise in exactly one place: the Send
 * button's `disabled` (`submitDisabled`). Enter, Cmd/Ctrl+Enter, the Alt+Enter
 * one-message override and the `nessy:submit-input` event all call
 * `submitMessage` directly, and `submitMessage` never read the policy, so each
 * of them sent the staged image to a model whose capability is `images: 'no'`
 * (the server's `filterAttachmentsForModelInput` then stripped it with a
 * notice). F1.733 closed the other route, the attachment X acting as a submit
 * button.
 *
 * `bun test` has no DOM here and importing the composer pulls a UI barrel bun
 * cannot resolve (see `learn-image-refusal-wiring.test.ts`), so the guard is
 * pinned at source level. The decision itself (`images === 'no'` blocks, every
 * other value fails open) is `attachment-capability.test.ts`'s subject.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const source = readFileSync(
  fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)),
  'utf8',
)

const CALLBACK_START = 'const submitMessage = React.useCallback('
const start = source.indexOf(CALLBACK_START)
// The callback's closing line is `  }, [<deps>])` at the component's indent.
const bodyEnd = source.indexOf('\n  }, [', start)
const body = source.slice(start, bodyEnd)
const deps = source.slice(bodyEnd, source.indexOf('])', bodyEnd) + 2)
const GUARD = /if \([^)]*\bshowVisionWarning\b[^)]*\) return false/

/** The argument list of the call that opens at `openParen`, split at depth-0 commas. */
function callArguments(text: string, openParen: number): string[] {
  const args: string[] = []
  let depth = 0
  let current = ''
  for (let i = openParen; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      if (depth === 1) continue
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) {
        if (current.trim()) args.push(current.trim())
        return args
      }
    } else if (ch === ',' && depth === 1) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  throw new Error(`unbalanced call at ${openParen}`)
}

describe('F1.983 — submitMessage refuses while a staged image is blocked', () => {
  it('reads the same predicate as the Send button, declared before the callback', () => {
    expect(start).toBeGreaterThan(-1)
    expect(bodyEnd).toBeGreaterThan(start)
    expect(body).toMatch(GUARD)
    // A stale closure would keep refusing (or keep sending) after the images or
    // the model change, so the predicate must be a dependency of the callback.
    expect(deps).toMatch(/\bshowVisionWarning\b/)
    // Read in the deps array during render, so it must be initialised before
    // `useCallback` runs (a later `const` would throw in its temporal dead zone).
    const declaration = source.indexOf('const showVisionWarning = stagedImagePolicy.blocked')
    expect(declaration).toBeGreaterThan(-1)
    expect(declaration).toBeLessThan(start)
    // And the button still reads it: one predicate, two readers.
    const button = source.slice(source.indexOf('const submitDisabled ='))
    expect(button.slice(0, button.indexOf('\n  const '))).toMatch(/\bshowVisionWarning\b/)
  })

  it('boundary — the guard precedes every branch that sends or clears the draft', () => {
    const guardAt = body.search(GUARD)
    expect(guardAt).toBeGreaterThan(-1)
    for (const branch of [
      "if (trimmedInput.startsWith('!'))",
      'typedOutOfBandCommandSubmission(trimmedInput)',
      'customSlashCommandInputSubmission(',
      'onSubmit(',
      'return true',
    ]) {
      const at = body.indexOf(branch)
      expect({ branch, found: at > -1 }).toEqual({ branch, found: true })
      expect({ branch, guardFirst: guardAt < at }).toEqual({ branch, guardFirst: true })
    }
  })

  it('negative — no call outside submitMessage hands staged attachments to onSubmit', () => {
    const outside: { at: number; args: string[] }[] = []
    for (const match of source.matchAll(/\bonSubmit\(/g)) {
      const at = match.index!
      if (at > start && at < bodyEnd) continue
      outside.push({ at, args: callArguments(source, at + 'onSubmit'.length) })
    }
    // Positive control on the instrument: the component has such calls
    // (`/compact`, `/rewind`, the plan approval, …), so an empty list would mean
    // the scan found nothing rather than that nothing is there.
    expect(outside.length).toBeGreaterThan(0)
    const carryingAttachments = outside.filter(({ args }) =>
      args.length >= 2 && args[1] !== 'undefined' && args[1] !== '[]')
    expect(carryingAttachments).toEqual([])
  })
})
