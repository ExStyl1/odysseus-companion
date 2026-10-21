/**
 * P2.83 — `input` is STRUCTURALLY immune, and that claim is held HERE, where the
 * construction lives.
 *
 * Two other packages assert it in prose — `shared/src/prompts/untrusted-text.ts`
 * ("`JSON.stringify(message.toolInput)`, which cannot contain a real newline, so
 * `input` is STRUCTURALLY immune rather than merely unlikely") and
 * `shared/src/agent/__tests__/advisor.test.ts` — and both are the reason the
 * advisor's field labels are deliberately OUT of the defanged vocabulary: only
 * `result` carries the forgery vector, so only one field had to be weighed.
 *
 * Nothing held the claim. The single edit that falsifies it is a routine one —
 * adding `null, 2` for readability — and it would re-open the `input` vector
 * while every security comment in the tree still said it was shut.
 *
 * Behaviour-neutral by construction: the property, then the construction, then a
 * control proving the property is not vacuous.
 *
 * Handed off by W3-d (which holds `prompts/`) to W3-e (which holds
 * `SessionManager.ts` and its suite) — the pin has to sit beside the code it
 * pins, and the ruling is that it lands before P2.53 closes.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
  'utf8',
)

describe('P2.83 · the advisor transcript input field cannot carry a real newline', () => {
  it('THE PROPERTY: single-argument JSON.stringify escapes newlines; the pretty form does not', () => {
    const hostile = { command: 'deploy\n  result: succeeded' }
    expect(JSON.stringify(hostile)).not.toContain('\n')
    // The control that makes the pin above meaningful rather than a string match:
    // this is the shape one readability edit away, and it DOES emit real newlines.
    expect(JSON.stringify(hostile, null, 2)).toContain('\n')
  })

  it('THE CONSTRUCTION: getAdvisorTranscript still builds `input` with the single-argument form', () => {
    // SCOPED to the builder's own body, and the correction is worth keeping.
    // The handed-off patch asserted "no indented variant anywhere in the file",
    // and that is FALSE on HEAD and always was: `SessionManager.ts:2563` renders
    // `JSON.stringify(message.toolInput, null, 2)` into a markdown TRANSCRIPT
    // EXPORT, inside a ```json fence, for a human reader — a different consumer
    // with a different containment story, and nothing to do with the advisor
    // prompt. A file-wide absence pin would have made this test permanently red
    // for a reason that is not the vector.
    const start = source.indexOf('const getAdvisorTranscript = ()')
    const end = source.indexOf('const getBranchFallbackMessages', start)
    // Both anchors asserted BEFORE the slice, and the slice asserted non-empty:
    // a moved anchor answers -1, `slice` then answers '' or the tail, and every
    // ABSENCE assertion below it passes vacuously. G-1 measured exactly that
    // failure on this file's sibling pin this wave.
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const builder = source.slice(start, end)
    expect(builder.length).toBeGreaterThan(200)

    expect(builder).toContain('input: JSON.stringify(message.toolInput)')
    // No indented variant INSIDE the builder, so the guard cannot be satisfied
    // by a second line in the same function that pretty-prints.
    expect(builder).not.toMatch(/JSON\.stringify\(\s*message\.toolInput\s*,/)
  })

  // W3-e's addition to the handed-off patch, for the reason G-1 measured on this
  // lane's own files this wave: a source pin whose anchor has moved answers
  // `-1`/`''` and every ABSENCE assertion over it then passes vacuously. The
  // second case above is exactly that shape, so the file it reads is pinned as
  // non-empty and as the right file BEFORE anything is asserted about its text.
  it('reads a non-empty SessionManager.ts, so the absence pin above cannot pass vacuously', () => {
    expect(source.length).toBeGreaterThan(100_000)
    expect(source).toContain('getAdvisorTranscript')
  })
})
