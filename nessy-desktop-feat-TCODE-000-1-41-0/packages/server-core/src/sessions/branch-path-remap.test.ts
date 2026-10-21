/**
 * P2.204 — the branch path remap is a per-item loop, and one item used to cost
 * the whole branch.
 *
 * MEASURED before the fix, with the shipped expression
 * (`sourceMessages.map(m => JSON.parse(JSON.stringify(m).replaceAll(...)))`) and
 * the pair below: it threw `SyntaxError: JSON Parse error: Expected '}'` out of
 * `Array.map`, out of `createSession`, and the user's branch was not created —
 * with a parser message as the reason.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { remapBranchedMessagePaths } from './SessionManager.ts'
import type { StoredMessage } from '@nessy-agent/shared/sessions/types'

function message(id: string, content: string): StoredMessage {
  return { id, type: 'user', content, timestamp: 1 } as StoredMessage
}

const SOURCE = '/tmp/ws/sessions/s-source'
/** A branch dir whose replacement text needs JSON escaping the raw splice omits. */
const BRANCH_WITH_QUOTE = '/tmp/ws/sessions/s-"branch"'
const BRANCH = '/tmp/ws/sessions/s-branch'

describe('P2.204 · remapBranchedMessagePaths', () => {
  it('remaps every message whose paths point at the source session', () => {
    const result = remapBranchedMessagePaths([
      message('m-1', `see ${SOURCE}/attachments/a.png`),
      message('m-2', 'nothing embedded here'),
    ], SOURCE, BRANCH)

    expect(result.unmapped).toEqual([])
    expect(result.messages[0]!.content).toBe(`see ${BRANCH}/attachments/a.png`)
    expect(result.messages[1]!.content).toBe('nothing embedded here')
  })

  it('keeps the batch when one message cannot be re-serialized, and names that one', () => {
    const result = remapBranchedMessagePaths([
      message('m-1', `see ${SOURCE}/a.png`),
      message('m-2', `also ${SOURCE}/b.png`),
      message('m-3', 'untouched'),
    ], SOURCE, BRANCH_WITH_QUOTE)

    // Every message survives — the branch is created.
    expect(result.messages).toHaveLength(3)
    // Both remappable-but-unserializable messages are named, by ID, not counted.
    expect(result.unmapped).toEqual(['m-1', 'm-2'])
    // The ones it could not remap keep the SOURCE paths verbatim, which is what
    // the caller's `sourceDir === branchDir` arm gives every message.
    expect(result.messages[0]!.content).toBe(`see ${SOURCE}/a.png`)
    expect(result.messages[2]!.content).toBe('untouched')
  })

  it('names an id-less message by position rather than dropping it from the report', () => {
    const result = remapBranchedMessagePaths(
      [{ ...message('', `see ${SOURCE}/a.png`) }],
      SOURCE,
      BRANCH_WITH_QUOTE,
    )

    expect(result.unmapped).toEqual(['#0'])
    expect(result.messages).toHaveLength(1)
  })

  it('is what the branch path calls: the loop is not inlined again beside it', () => {
    // The call itself runs only inside `createSession`'s branch validation, which
    // needs a live workspace, a source session and a project handle. This pins
    // the wire by source — the same instrument this file's siblings use for a
    // seam a unit test cannot enter — and it fails against a re-inlined loop.
    const source = readFileSync(new URL('./SessionManager.ts', import.meta.url), 'utf-8')
    expect(source).toContain('const remap = remapBranchedMessagePaths(sourceMessages, sourceDir, branchDir)')
    expect(source).toContain('Branch path remap failed for some messages')
    // The shipped shape must be gone from the CALL SITE, not merely shadowed:
    // the expression itself still exists, inside the helper's try.
    expect(source).not.toContain('branchedStored.messages = sourceMessages.map(')
  })
})
