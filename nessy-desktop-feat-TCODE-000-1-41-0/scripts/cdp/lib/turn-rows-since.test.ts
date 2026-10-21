import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TranscriptMessage } from './state.ts'
import { turnReply, turnRowsSince } from './turn-evidence.ts'

/**
 * F1.521 (origin WJ-al P-WJ-al-1) — the whole-transcript reads F1.503's ratchet
 * did not count, held against scripted rows (no app), and a ratchet of their own.
 *
 * The counted form (`lastAssistantText(<turn>.messages)`) is `turn-evidence.test.ts`'s.
 * The two here are the ones that rebuilt the same read by another road: a send that
 * THREW widened to the whole transcript, and `lastAssistantText(await transcript(…))`.
 */

let seq = 0
function row(role: string, content: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage {
  seq += 1
  return { id: `r-${seq}`, role, content, timestamp: seq, ...extra }
}

describe('turnRowsSince — a send that threw reads its OWN rows, never an earlier turn\'s (F1.521)', () => {
  const earlier = [
    row('user', 'Find the echo tool.'),
    row('tool', '', { toolName: 'mcp__tool_search', toolResult: 'mcp__echo__whoami', toolStatus: 'completed' }),
    row('assistant', 'EARLIER-REPLY'),
  ]

  it('a completed send is its own added rows, and the transcript is never read', async () => {
    const added = [row('user', 'Call it.'), row('assistant', 'OWN-REPLY')]
    let reads = 0
    const rows = await turnRowsSince(async () => { reads += 1; return [...earlier, ...added] }, added, earlier.length)
    expect(rows).toEqual(added)
    expect(reads).toBe(0)
  })

  it('a send that THREW reads the rows past the baseline — its own prompt and partial rows, not the earlier reply', async () => {
    const failed = [row('user', 'Call it.'), row('tool', '', { toolName: 'mcp__echo__whoami', toolStatus: 'error' }), row('error', 'timed out')]
    const rows = await turnRowsSince(async () => [...earlier, ...failed], [], earlier.length)
    expect(rows).toEqual(failed)
    expect(turnReply(rows)).toBe('')
    expect(rows.some(r => r.toolName === 'mcp__tool_search')).toBe(false)
    // CONTROL — the fallback this replaces: the whole transcript answers with the
    // EARLIER turn's reply and its search row, which is what a check read.
    const widened = [...earlier, ...failed]
    expect(turnReply(widened)).toBe('EARLIER-REPLY')
    expect(widened.some(r => r.toolName === 'mcp__tool_search')).toBe(true)
  })

  it('a transcript that cannot be read after a failed send is no rows, not a throw', async () => {
    expect(await turnRowsSince(async () => { throw new Error('renderer gone') }, [], 3)).toEqual([])
  })
})

/**
 * A BAN, counted with `git grep -o` over the tracked case and lib sources (the
 * instrument `turn-evidence.test.ts`'s ratchet uses, for the reason given there).
 * A pin above 0 names the file still carrying the form and why; it may only fall.
 * The same read made through a VARIABLE takes two statements, so no `git grep -o`
 * pattern can see it; the ban below (F1.551) reads it file by file.
 */
describe('RATCHET — the whole-transcript forms F1.503\'s ratchet did not count (F1.521)', () => {
  const REPO = join(import.meta.dir, '..', '..', '..')
  const CASES = [':(glob)scripts/cdp/cases/*.ts', ':(glob)scripts/cdp/lib/*.ts', ':(exclude,glob)scripts/cdp/**/*.test.ts']
  const SELF = ['scripts/cdp/lib/turn-rows-since.test.ts']
  const occurrences = (pattern: string, paths: readonly string[]): number => {
    // `--untracked` only for SELF: this file's own control must read before its first commit too.
    const out = Bun.spawnSync(['git', 'grep', ...(paths === SELF ? ['--untracked'] : []), '-ohE', pattern, '--', ...paths], { cwd: REPO })
    // git grep exits 1 on no match; anything else is the instrument failing.
    expect(out.exitCode === 0 || out.exitCode === 1, out.stderr.toString()).toBe(true)
    return out.stdout.toString().split('\n').filter(Boolean).length
  }
  // POSIX classes, not `\s`: `git grep -E` does not promise them.
  const FORMS = [
    {
      name: 'a send that threw widened to the whole transcript',
      pattern: '\\.added\\.length[[:space:]]*>[[:space:]]*0[[:space:]]*\\?[^:]*:[[:space:]]*await[[:space:]]+transcript\\(',
      pin: 0,
    },
    {
      name: 'lastAssistantText of an awaited whole transcript',
      pattern: 'lastAssistantText\\([[:space:]]*await[[:space:]]+transcript\\(',
      pin: 0,
    },
  ] as const
  // The CONTROL, on the same instrument: this file spells each form once — here —
  // and the count above excludes it.
  //   const scanned = turn.added.length > 0 ? turn.added : await transcript(session, key)
  //   const answer = lastAssistantText(await transcript(session, key))

  for (const form of FORMS) {
    it(`${form.name} — pinned at ${form.pin}`, () => {
      expect(occurrences(form.pattern, SELF), 'the instrument sees the planted form').toBeGreaterThan(0)
      const count = occurrences(form.pattern, CASES)
      expect(count, `${form.name}: ${count} call sites, pin ${form.pin} — read the turn's own rows (turnRowsSince), or LOWER the pin after a conversion`).toBeLessThanOrEqual(form.pin)
      expect(count, `the count fell to ${count}: lower the pin to it`).toBe(form.pin)
    })
  }
})

/**
 * F1.551 (origin WJ-aw proposed row 2) — the through-a-variable form the ratchet
 * above cannot see: a WHOLE transcript bound to a variable (`const rows = await
 * transcript(…)`, nothing chained on it) and that variable then handed to a reader
 * whose contract is ONE turn's rows or its last reply — `lastAssistantText` and
 * the `turn-evidence.ts` helpers. The READER's contract is what makes the form
 * decidable with no judgement about the session: handed a whole transcript, any
 * of them can answer with an earlier turn.
 *
 * What it still cannot see, and says so rather than guessing: a whole-bound
 * variable read by an array method or by a case-local helper. By this scanner's
 * own binding rule the tracked case and lib sources held 54 whole bindings on
 * 2026-09-24 and 52 after this row; F1.562 read all 52 the same day, converted 38
 * and NAMED the other 14 in the census below, which is where that reading now
 * lives. Nothing in the text tells a whole-session audit from a turn read, so the
 * census is a list a human keeps, not a rule. The two this row was born
 * for (`reach()` in plugin-install-runtimes and rs-106's invocation rows, read by
 * `readReach` and `toolNames`) now read the rows since their own send. A name bound
 * whole in one function and reused in another is matched by NAME within the file,
 * so a hit can be a false one; it names the file and the variable, so it can be read.
 */
const TURN_READERS = ['lastAssistantText', 'turnReply', 'turnOwnText', 'turnOwnRows', 'turnAnswered', 'turnCalledTool', 'turnRoles'] as const

/** The index just past the parenthesis that closes the one opening at `open`. */
function closeParen(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    else if (text[index] === ')' && --depth === 0) return index + 1
  }
  return text.length
}

/**
 * Every name bound to a WHOLE transcript — `NAME = await transcript(…)`, optionally
 * parenthesised or followed by a `.catch(…)`, with nothing chained after it. The
 * binding rule the ban below and the F1.562 census share, in file order.
 */
function wholeTranscriptBindings(text: string): string[] {
  const names: string[] = []
  const binding = /(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*:\s*[^=\n]+?)?\s*=\s*(\(\s*)?await\s+transcript\(/g
  for (const match of text.matchAll(binding)) {
    let at = closeParen(text, match.index! + match[0].length - 1)
    if (match[2] !== undefined) {
      // `(await transcript(…))` — whole only if the wrapping parenthesis closes next.
      const rest = /^\s*\)/.exec(text.slice(at))
      if (rest === null) continue
      at += rest[0].length
    }
    const catchCall = /^\s*\.catch\(/.exec(text.slice(at))
    if (catchCall !== null) at = closeParen(text, at + catchCall[0].length - 1)
    if (/^\s*[.[]/.test(text.slice(at))) continue // chained (`.slice`, `.length`, …): not the whole transcript
    names.push(match[1]!)
  }
  return names
}

/** `<reader>(<name>)` for every whole-transcript variable a turn reader is handed. */
function wholeTranscriptVariableReads(text: string): string[] {
  const hits: string[] = []
  for (const name of wholeTranscriptBindings(text)) {
    for (const reader of TURN_READERS) {
      if (new RegExp(`(?<![\\w$])${reader}\\(\\s*${name.replace(/\$/g, '\\$')}\\s*[,)]`).test(text)) hits.push(`${reader}(${name})`)
    }
  }
  return hits
}

describe('BAN — a whole transcript read through a VARIABLE by a turn reader (F1.551)', () => {
  const REPO = join(import.meta.dir, '..', '..', '..')

  it('CONTROL: the planted form is seen, on every spelling of the binding', () => {
    // The first is rs-71's own two lines before F1.521 converted them (`caffcc4b8`);
    // on 2026-09-24 this scanner reported rs-71 and rs-72 at that commit's parent.
    // History is not re-read here: a squash merge orphans the sha.
    expect(wholeTranscriptVariableReads([
      'const messages = await transcript(session, key)',
      'const answer = lastAssistantText(messages)',
    ].join('\n'))).toEqual(['lastAssistantText(messages)'])
    expect(wholeTranscriptVariableReads('let rows: TranscriptMessage[] = (await transcript(session, key))\nturnReply(rows)')).toEqual(['turnReply(rows)'])
    expect(wholeTranscriptVariableReads('rows = await transcript(session, key).catch(() => [])\nturnAnswered(rows, 3)')).toEqual(['turnAnswered(rows)'])
  })

  it('CONTROL: the converted forms are not — a slice, a count, a turn\'s own rows', () => {
    expect(wholeTranscriptVariableReads('const rows = (await transcript(session, key)).slice(before)\nturnReply(rows)')).toEqual([])
    expect(wholeTranscriptVariableReads('const rows = (await transcript(session, key))\n  .slice(before)\nturnReply(rows)')).toEqual([])
    expect(wholeTranscriptVariableReads('const before = (await transcript(session, key)).length\nturnReply(turn.added)')).toEqual([])
    expect(wholeTranscriptVariableReads('const all = await transcript(session, key)\nconst n = all.filter(isTool).length')).toEqual([])
  })

  // The budget is the FILE READS, measured: opening all 193 sources cold took 17.9 s on
  // 2026-09-24 against the 5 s default, so only the files `git grep` finds spelling
  // BOTH halves are opened (22 that day), and the case carries its own budget.
  it('no case or lib source carries it — pinned at 0', () => {
    const PATHS = [':(glob)scripts/cdp/cases/*.ts', ':(glob)scripts/cdp/lib/*.ts', ':(exclude,glob)scripts/cdp/**/*.test.ts']
    const files = Bun.spawnSync(['git', 'ls-files', '--', ...PATHS], { cwd: REPO })
    expect(files.exitCode, files.stderr.toString()).toBe(0)
    // The denominator, so a pathspec that silently matched nothing cannot read as a pass.
    expect(files.stdout.toString().split('\n').filter(Boolean).length).toBeGreaterThan(100)
    const both = Bun.spawnSync(['git', 'grep', '-l', '--all-match', '-E',
      '-e', 'await[[:space:]]+transcript\\(', '-e', `(${TURN_READERS.join('|')})\\(`, '--', ...PATHS], { cwd: REPO })
    // git grep exits 1 on no match; anything else is the instrument failing.
    expect(both.exitCode === 0 || both.exitCode === 1, both.stderr.toString()).toBe(true)
    const candidates = both.stdout.toString().split('\n').filter(Boolean)
    // A positive control on the same instrument: rs-106, one of the two reads this row
    // converted, still spells both halves (`transcript(` and `turnAnswered(`), so it is opened.
    expect(candidates).toContain('scripts/cdp/cases/rs-106.ts')
    const hits = candidates.flatMap(path => wholeTranscriptVariableReads(readFileSync(join(REPO, path), 'utf8')).map(hit => `${path}: ${hit}`))
    expect(hits, 'read the turn\'s own rows (`turn.added`, or `turnRowsSince` when the send can throw)').toEqual([])
  }, 60_000)
})

/**
 * F1.562 (origin WJ-bg proposed row 2, 2026-09-24) — the whole-transcript bindings
 * the ban above cannot judge, each READ and then either converted or named here.
 *
 * The ban sees a whole transcript only when a turn reader is handed it. The other
 * bindings (`const all = await transcript(…)` read by `.filter`, `.some`, a count or
 * a case-local helper) were 52 on 2026-09-24. Read one by one, 38 were converted:
 * - nine whose check was about ONE turn in a session where an earlier turn, or an
 *   inherited session nothing checks, could have answered for it (agent-install,
 *   agt-6's compaction, cru-1's card-watched turns, rs-16, rs-17's decline notice,
 *   rs-20, rs-80's trigger turn, rs-81, rs-98) now read the rows since a count taken
 *   before the step, or the send's own `added`;
 * - 29 that were already a count or a slice at the use site now say so at the
 *   binding (`(await transcript(…)).length` / `.slice(n)`), with no change in what
 *   they read.
 * The 14 below stay whole, each for the reason beside it. A NEW whole binding fails
 * here until someone reads it and either converts it or names it; a named one that
 * disappears fails too, so the list cannot go stale. Keys are `<path> <name>`, one
 * per binding, repeats included.
 */
const WHOLE_BY_DESIGN: Record<string, string> = {
  'scripts/cdp/cases/agt-10.ts all': 'a session the case created (checked) and its only turn: the whole transcript is that turn',
  'scripts/cdp/cases/agt-4.ts beforeWrites': 'the rewind anchor is the latest user message of the whole session, and the rewound check compares whole-session lengths',
  'scripts/cdp/cases/agt-6.ts finalMessages': 'counts the reminder marker across BOTH compactions, which is a whole-session question; the second compaction\'s own rows are sliced beside it',
  'scripts/cdp/cases/cru-2.ts all': 'a session the case created (required) with one compaction: the banner can only be that compaction\'s',
  'scripts/cdp/cases/cru-7.ts all': 'a session the case created (checked) and its only turn; infoTexts also reads a notice the host may write at the runtime switch, BEFORE the turn, which a slice from the send would drop',
  'scripts/cdp/cases/rs-11.ts messages': 'a session per arm the case created (checked) and its only turn',
  'scripts/cdp/cases/rs-33.ts messages': 'a session per runtime the case created (checked) and its only turn',
  'scripts/cdp/cases/rs-35.ts messages': 'observation only: the info lines the transcript kept are recorded, never asserted',
  'scripts/cdp/cases/rs-36.ts parentMessages': 'the branch point is the LAST message of the whole session',
  'scripts/cdp/cases/rs-36.ts flightMessages': 'the branch point is the LAST message of the whole session',
  'scripts/cdp/cases/rs-63.ts messages': 'the whole session\'s serialized size is the measurement',
  'scripts/cdp/cases/rs-79.ts messages': 'a session the case created (the arm is skipped otherwise) and its only turn',
  'scripts/cdp/cases/session-tool-wire-parity.ts messages': 'a session the case created (the arm is skipped otherwise) and its only turn; the catch path mirrors the success path, whose sendPrompt(…).messages is whole too',
  'scripts/cdp/lib/state.ts messages': 'the turn-completion poll needs the session\'s total count beside the roles added since its baseline',
}

describe('CENSUS — every whole-transcript binding is converted or NAMED with a reason (F1.562)', () => {
  const REPO = join(import.meta.dir, '..', '..', '..')

  it('CONTROL: the binding rule sees a whole binding and not a count, a slice or a send\'s rows', () => {
    expect(wholeTranscriptBindings([
      'const all = await transcript(session, key)',
      'const n = (await transcript(session, key)).length',
      'const rows = (await transcript(session, key)).slice(before)',
      'const left = (await transcript(session, key).catch(() => [])).length',
      'let messages: TranscriptMessage[] = []',
      'messages = await transcript(session, key).catch(() => [])',
    ].join('\n'))).toEqual(['all', 'messages'])
  })

  it('the bindings found are exactly the named ones', () => {
    const PATHS = [':(glob)scripts/cdp/cases/*.ts', ':(glob)scripts/cdp/lib/*.ts', ':(exclude,glob)scripts/cdp/**/*.test.ts']
    const listed = Bun.spawnSync(['git', 'grep', '-l', '-E', 'await[[:space:]]+transcript\\(', '--', ...PATHS], { cwd: REPO })
    expect(listed.exitCode, listed.stderr.toString()).toBe(0)
    const files = listed.stdout.toString().split('\n').filter(Boolean)
    // The denominator, so a pathspec that silently matched nothing cannot read as a pass.
    expect(files.length).toBeGreaterThan(40)
    const found = files.flatMap(path => wholeTranscriptBindings(readFileSync(join(REPO, path), 'utf8')).map(name => `${path} ${name}`))
    expect(found.sort(), 'read the new binding: convert it to the turn\'s own rows, or name it in WHOLE_BY_DESIGN with the reason')
      .toEqual(Object.keys(WHOLE_BY_DESIGN).sort())
  }, 60_000)
})
