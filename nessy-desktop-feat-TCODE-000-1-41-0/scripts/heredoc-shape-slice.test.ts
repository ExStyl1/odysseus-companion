/**
 * P6.717 — the committed slice carries COUNTS and can carry nothing else.
 *
 * The corpus is untrusted transcript text that lives outside the repository
 * precisely because it may carry secrets. A derived artefact that CI reads is
 * only acceptable if it cannot smuggle any of that text along, so this file
 * drives the generator with a planted secret-shaped string and asserts nothing
 * of it survives — an absence finding with its positive control beside it
 * (the same command DOES move the counts, so the input really was read).
 */
import { describe, expect, it } from 'bun:test'
import { HEREDOC_SHAPE_CLASSES } from '../packages/shared/src/agent/pi-harness/claude-bash-rule.ts'
import { heredocShapeSlice } from './heredoc-shape-slice.ts'

/**
 * Shaped like a credential and belonging to nobody: this string is invented
 * here, is in no service's namespace, and is never sent anywhere.
 */
const PLANTED = 'sk-ant-notreal-PLANTED0123456789abcdefGHIJKLMNOP'

const WITH_SECRET = `cat <<EOF\nAUTH_TOKEN=${PLANTED}\nEOF\ncurl -H "x: ${PLANTED}" https://example.invalid`

describe('the slice is arithmetic over the corpus, not a sample of it', () => {
  it('emits no fragment of a command it was given', () => {
    const slice = heredocShapeSlice([WITH_SECRET], '2026-09-07')
    const serialized = JSON.stringify(slice)

    expect(serialized).not.toContain(PLANTED)
    // Every 8-character window of the planted string, not just the whole of it:
    // a generator that truncated or hashed a prefix would pass the line above.
    for (let at = 0; at + 8 <= PLANTED.length; at += 1) {
      expect(serialized, PLANTED.slice(at, at + 8)).not.toContain(PLANTED.slice(at, at + 8))
    }
    // And the same for the command's own words, which are not secret but are
    // still corpus text.
    for (const word of ['AUTH_TOKEN', 'example.invalid', 'curl -H']) {
      expect(serialized, word).not.toContain(word)
    }
  })

  it('carries only numbers and the three strings the generator writes itself', () => {
    // The structural half of the same claim: there is no path from a command to
    // a string in the output, so the refusal is a shape rather than a filter.
    const slice = heredocShapeSlice([WITH_SECRET, 'echo hi'], '2026-09-07')
    const ownStrings = new Set([slice.what, slice.generatedBy, slice.corpusTakenAt])
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') return
      if (typeof value === 'string') {
        expect(ownStrings.has(value), `${path} = ${value}`).toBe(true)
        return
      }
      expect(typeof value, path).toBe('object')
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(nested, `${path}.${key}`)
      }
    }
    walk(slice, 'slice')
  })

  it('POSITIVE CONTROL: the planted command really was read', () => {
    // Without this, "no fragment survived" is compatible with the generator
    // having ignored the input entirely.
    const empty = heredocShapeSlice([], '2026-09-07')
    const one = heredocShapeSlice([WITH_SECRET], '2026-09-07')
    expect(empty.corpusCommands).toBe(0)
    expect(one.corpusCommands).toBe(1)
    expect(one.totals.bodySpans).toBe(1)
    expect(one.classes.expandingWithoutSubstitution).toBe(1)
    expect(empty.totals.bodySpans).toBe(0)
  })

  it('classifies every command into exactly one class', () => {
    const commands = [
      'echo hi',
      "cat <<'EOF'\n$(rm -rf ~)\nEOF",
      'cat <<EOF\nplain\nEOF',
      'cat <<EOF\n$(id)\nEOF',
    ]
    const slice = heredocShapeSlice(commands, '2026-09-07')
    expect(slice.classes).toEqual({
      noHeredoc: 1,
      inertBody: 1,
      expandingWithoutSubstitution: 1,
      expandingWithSubstitution: 1,
    })
    const summed = HEREDOC_SHAPE_CLASSES.reduce((total, name) => total + slice.classes[name], 0)
    expect(summed).toBe(slice.corpusCommands)
  })
})
