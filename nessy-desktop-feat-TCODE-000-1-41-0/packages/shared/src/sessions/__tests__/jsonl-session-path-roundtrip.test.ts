/**
 * P3.324 — the session-path token round trip, on OLD and NEW records.
 *
 * P2.217 measured the defect: a message whose text literally contains
 * `{{SESSION_PATH}}` was written untouched and EXPANDED into an absolute
 * filesystem path on read, with no session move involved. The fix is an escape
 * on write plus its inverse on read (`jsonl.ts`), which changes the on-disk
 * format of new writes — so this file pins BOTH sides of that boundary:
 *
 *  - a record written by the new writer round-trips to identity;
 *  - a record written by the OLD writer still reads exactly as it did, so no
 *    migration is owed and none is possible.
 *
 * The old writer is reproduced here verbatim rather than imported, because the
 * thing under test is that its output is still readable after the reader
 * changed. If it were imported it could not stay old.
 */

import { describe, expect, it } from 'bun:test'
import {
  escapeLiteralSessionPathTokens,
  expandSessionPath,
  makeSessionPathPortable,
  tokenizeSessionDir,
} from '../jsonl.ts'

const DIR = '/Users/alice/.nessy-agent/sessions/ws-1/s-1'
const MOVED_DIR = '/Users/bob/.nessy-agent/sessions/ws-2/s-2'

/** The write transform exactly as it stood before P3.324 (no escape pass). */
function legacyMakeSessionPathPortable(jsonLine: string, sessionDir: string): string {
  if (!sessionDir) return jsonLine
  return jsonLine.replaceAll(sessionDir, '{{SESSION_PATH}}')
}

function line(text: string): string {
  return JSON.stringify({ id: 'm1', role: 'user', content: text })
}

describe('P3.324 · new records round-trip to identity', () => {
  const cases: Array<[name: string, text: string]> = [
    ['prose with no token and no path', 'nothing interesting here'],
    ['a literal bare token — the P2.217 shape 1 defect', 'see {{SESSION_PATH}}/notes.md'],
    ['a literal token twice in one message', '{{SESSION_PATH}} and {{SESSION_PATH}}'],
    ['a literal already-escaped token', 'the marker is {{SESSION_PATH~ESC}} in the source'],
    ['a literal doubly-escaped token', 'and {{SESSION_PATH~ESC~ESC}} one level deeper'],
    ['a near-miss that is not in the family', '{{SESSION_PATHX}} and {{SESSION_PATH_OTHER}}'],
    ['a real session path, which is what the token exists for', `saved to ${DIR}/out.txt`],
    ['a real path AND a literal token in one message', `${DIR}/a.txt beside {{SESSION_PATH}}/b.txt`],
  ]

  for (const [name, text] of cases) {
    it(`round-trips ${name}`, () => {
      const original = line(text)
      const written = makeSessionPathPortable(original, DIR)
      expect(expandSessionPath(written, DIR)).toBe(original)
    })
  }

  it('still tokenizes the real path — the portability the function exists for', () => {
    const written = makeSessionPathPortable(line(`saved to ${DIR}/out.txt`), DIR)
    expect(written).toContain('{{SESSION_PATH}}/out.txt')
    expect(written).not.toContain(DIR)
  })

  it('a literal token survives a MOVE as itself, while the real path follows the session', () => {
    const written = makeSessionPathPortable(line(`${DIR}/a.txt and {{SESSION_PATH}}/b.txt`), DIR)
    const moved = JSON.parse(expandSessionPath(written, MOVED_DIR)) as { content: string }
    expect(moved.content).toBe(`${MOVED_DIR}/a.txt and {{SESSION_PATH}}/b.txt`)
  })

  it('is the negative control for the pre-fix behaviour: the old writer loses it', () => {
    const original = line('see {{SESSION_PATH}}/notes.md')
    const writtenTheOldWay = legacyMakeSessionPathPortable(original, DIR)
    expect(expandSessionPath(writtenTheOldWay, DIR)).not.toBe(original)
    expect(expandSessionPath(writtenTheOldWay, DIR)).toContain(`${DIR}/notes.md`)
  })
})

describe('P3.324 · old records read exactly as they did', () => {
  it('expands a token the OLD writer wrote for a real path', () => {
    const stored = legacyMakeSessionPathPortable(line(`saved to ${DIR}/out.txt`), DIR)
    expect(expandSessionPath(stored, DIR)).toBe(line(`saved to ${DIR}/out.txt`))
  })

  it('re-points an old record at a new directory on a move', () => {
    const stored = legacyMakeSessionPathPortable(line(`saved to ${DIR}/out.txt`), DIR)
    expect(expandSessionPath(stored, MOVED_DIR)).toBe(line(`saved to ${MOVED_DIR}/out.txt`))
  })

  it('leaves an old record with no token untouched', () => {
    const stored = legacyMakeSessionPathPortable(line('no paths at all'), DIR)
    expect(expandSessionPath(stored, DIR)).toBe(stored)
  })

  it('cannot recover a user-typed token from an old record — the stated, unrecoverable loss', () => {
    // Written before the escape existed, so on disk it is byte-identical to a
    // token this module wrote for a real path. No reader can separate them.
    const stored = legacyMakeSessionPathPortable(line('see {{SESSION_PATH}}/notes.md'), DIR)
    expect(expandSessionPath(stored, DIR)).toBe(line(`see ${DIR}/notes.md`))
  })
})

describe('P3.324 · the two halves of the write transform', () => {
  it('escape is not idempotent, which is why bundle.ts uses the other half', () => {
    const once = escapeLiteralSessionPathTokens('{{SESSION_PATH}}')
    expect(once).toBe('{{SESSION_PATH~ESC}}')
    expect(escapeLiteralSessionPathTokens(once)).toBe('{{SESSION_PATH~ESC~ESC}}')
  })

  it('tokenizeSessionDir IS idempotent, so a re-tokenized stored line still reads back', () => {
    const stored = makeSessionPathPortable(line(`${DIR}/a.txt and {{SESSION_PATH}}/b.txt`), DIR)
    const reTokenized = tokenizeSessionDir(tokenizeSessionDir(stored, DIR), DIR)
    expect(reTokenized).toBe(stored)
    expect(expandSessionPath(reTokenized, DIR)).toBe(line(`${DIR}/a.txt and {{SESSION_PATH}}/b.txt`))
  })

  it('escapes even with no session directory — the reader always unescapes', () => {
    const original = line('see {{SESSION_PATH}} here')
    const written = makeSessionPathPortable(original, '')
    expect(written).toContain('{{SESSION_PATH~ESC}}')
    expect(expandSessionPath(written, DIR)).toBe(original)
  })

  it('a `$` in the session directory is not read as a replacement pattern', () => {
    const dollarDir = '/tmp/$&weird/s-1'
    const original = line(`saved to ${dollarDir}/out.txt`)
    const written = makeSessionPathPortable(original, dollarDir)
    expect(expandSessionPath(written, dollarDir)).toBe(original)
  })
})
