/**
 * Tests for `check-shape-pointer-reasons.ts` — D1.303.
 *
 * Every positive control runs over an IN-MEMORY tree rather than over the repo,
 * for the reason AGENTS.md gives about mutation harnesses: a control that plants
 * a pointer in the real tree has to restore it exactly, and a restore that
 * misses silently invalidates every later verdict. `memoryTree` exists for that
 * and for nothing else — it also keeps the fixtures readable, which matters
 * here, because what is under test is a rule about PROSE.
 *
 * The real-tree arm is deliberately the WEAK one — "the probe can see something"
 * — and carries NO number. A declared count here would be a second ratchet
 * beside `PINNED_POINTERS` and it would go red the day a lane writes or rewords
 * a pointer, which is the cry-wolf shape this repo has paid for six times.
 */

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  blankNonCode,
  census,
  constructionsIn,
  CONSTRUCTIONS,
  EXPLAINED_MENTIONS,
  EXPLAINED_PAIRS,
  failures,
  memoryTree,
  PINNED_POINTERS,
  repoTree,
  SLACK_ALLOWANCE,
  slackExceeded,
  SOURCE_FILE_RE,
  SOURCE_ROOTS,
  splitSentences,
  TEST_FILE_RE,
  verdictFor,
} from './check-shape-pointer-reasons'

/**
 * The file's budget, not a test's — AGENTS.md's rule for a suite whose wall time
 * is its I/O rather than its assertions.
 *
 * The three git-backed arms read a revision's 860 candidate files. D1.318 made
 * that one `git cat-file --batch` instead of 860 `git show` spawns — 3.0 s and
 * 5.1 s per revision measured, against the minutes the per-file form cost the
 * moment the universe widened, and 19.8 s / 16.5 s / 18.7 s at D1.303's narrower
 * one. Still far past bun's 5 s default, and the in-memory arms are ~1 ms. Sized
 * against the largest observed run, not against the mean.
 */
setDefaultTimeout(180_000)

const HARNESS = 'const manager = createTestSessionManager() as any'
const DOUBLE = 'const manager = Object.create(SessionManager.prototype) as any'

/** Two arms read the same past trees; reading them twice doubles ~360 git spawns. */
const historical = new Map<string, ReturnType<typeof census>>()
async function historicalCensus(rev: string): Promise<ReturnType<typeof census>> {
  const cached = historical.get(rev)
  if (cached !== undefined) return cached
  const computed = census(await repoTree({ rev }))
  historical.set(rev, computed)
  return computed
}

/** A file whose docblock points at `sibling`, over whichever construction it is given. */
function pointerFile(sibling: string, construction: string): string {
  return [
    '/**',
    ' * P0 — the subject of this suite, in its own paragraph.',
    ' *',
    ' * A real manager reduced to what the method reads — the same shape as',
    ` * \`${sibling}\`.`,
    ' */',
    construction,
  ].join('\n')
}

describe('check-shape-pointer-reasons', () => {
  test('a pointer whose sibling still carries the construction HOLDS', () => {
    const result = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', HARNESS),
      'a/sibling.test.ts': HARNESS,
    }))

    expect(result.pointers).toHaveLength(1)
    const [pointer] = result.pointers
    expect(pointer?.verdict).toBe('holds')
    expect(pointer?.sibling).toBe('sibling.test.ts')
    expect(pointer?.claim).toEqual(['sm-harness'])
    // Line 4 is where the pointer SENTENCE reads, not line 1 where the docblock
    // opened: a report that named the docblock would send the next reader to the
    // wrong paragraph of a header that is routinely thirty lines long.
    expect(pointer?.line).toBe(4)
    expect(result.broken).toHaveLength(0)
  })

  test('the sibling converting BREAKS it — the decay the row was born for', () => {
    // The pointing file stays on the harness; the sibling moves to the
    // hand-built double. Nothing in the pointing file changed, which is the
    // whole point: the falsifying commit is in the OTHER file.
    const result = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', HARNESS),
      'a/sibling.test.ts': DOUBLE,
    }))

    expect(result.broken).toHaveLength(1)
    expect(result.broken[0]?.verdict).toBe('broken')
    expect(result.broken[0]?.siblingCarries).toEqual([['sm-double']])
  })

  test('it breaks in the OTHER direction too — the pointer converting, the sibling not', () => {
    const result = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', DOUBLE),
      'a/sibling.test.ts': HARNESS,
    }))

    expect(result.broken).toHaveLength(1)
    expect(result.broken[0]?.claim).toEqual(['sm-double'])
  })

  test('a sibling that no longer exists is MISSING, not silently fine', () => {
    const result = census(memoryTree({
      'a/pointer.test.ts': pointerFile('renamed-away.test.ts', HARNESS),
      'a/sibling.test.ts': HARNESS,
    }))

    expect(result.broken).toHaveLength(1)
    expect(result.broken[0]?.verdict).toBe('missing')
    expect(result.broken[0]?.siblingPaths).toEqual([])
  })

  test('two files of that basename that DISAGREE are unresolved, never broken', () => {
    const result = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', HARNESS),
      'a/sibling.test.ts': HARNESS,
      'b/sibling.test.ts': DOUBLE,
    }))

    // Reported and not failed: the check could not be made, and a red nobody
    // can act on teaches the next reader that the gate cries wolf.
    expect(result.pointers[0]?.verdict).toBe('unresolved')
    expect(result.broken).toHaveLength(0)
    expect(result.gated).toHaveLength(1)
  })

  test('two of that basename that AGREE still answer — ambiguity only matters when they differ', () => {
    const result = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', HARNESS),
      'a/sibling.test.ts': HARNESS,
      'b/sibling.test.ts': HARNESS,
    }))

    expect(result.pointers[0]?.verdict).toBe('holds')
  })

  test('NARROWING 1 picks the CLAIM: outside the family the claim is existence — D1.318', () => {
    // Byte-for-byte the sentence of the first case, in a file that builds no
    // manager. Until D1.318 this was dropped entirely, which is what hid the
    // five production pointers.
    const outside = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', 'const manager = {}'),
      'a/sibling.test.ts': HARNESS,
    }))
    expect(outside.pointers).toHaveLength(1)
    expect(outside.pointers[0]?.claimKind).toBe('exists')
    // The sibling builds its manager the OTHER way and the verdict still holds:
    // the weak claim is weak on purpose, and saying so in an assertion is the
    // only way the next reader can tell it from a bug.
    expect(outside.pointers[0]?.verdict).toBe('holds')

    // POSITIVE CONTROL on the same instrument: the identical fixture with the
    // construction present makes the STRONGER claim over the same two files, and
    // that one is broken.
    const inside = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', DOUBLE),
      'a/sibling.test.ts': HARNESS,
    }))
    expect(inside.pointers[0]?.claimKind).toBe('carries')
    expect(inside.pointers[0]?.verdict).toBe('broken')
  })

  test('a pointer in PRODUCTION prose is read, and its dead sibling is MISSING — D1.318', () => {
    // The row's own population: a `.ts` module that is not a test, naming a test
    // file in a shape sentence. `bypass-permissions-gate.ts` is the live one.
    const result = census(memoryTree({
      'a/gate.ts': pointerFile('renamed-away.test.ts', 'export const gate = () => true'),
      'a/sibling.test.ts': HARNESS,
    }))

    expect(result.pointers).toHaveLength(1)
    expect(result.pointers[0]?.claimKind).toBe('exists')
    expect(result.pointers[0]?.verdict).toBe('missing')
    expect(result.broken).toHaveLength(1)
  })

  test('NARROWING 3: a paragraph break ends the sentence, so prose is not paired across subjects', () => {
    const result = census(memoryTree({
      'a/pointer.test.ts': [
        '/**',
        ' * The harness here is the same shape the rest of this suite uses.',
        ' *',
        ' * Unrelated paragraph, and it happens to mention `sibling.test.ts`.',
        ' */',
        HARNESS,
      ].join('\n'),
      'a/sibling.test.ts': DOUBLE,
    }))

    expect(result.pointers).toHaveLength(0)
  })

  test('a comment naming ITSELF is not a pointer', () => {
    const result = census(memoryTree({
      'a/pointer.test.ts': [
        '/** This file (`pointer.test.ts`) keeps the shape it was born with. */',
        HARNESS,
      ].join('\n'),
      'a/sibling.test.ts': HARNESS,
    }))

    expect(result.pointers).toHaveLength(0)
  })

  test('only COMMENTS are read — the same sentence in a string literal is code', () => {
    const asString = census(memoryTree({
      'a/pointer.test.ts': [
        "const label = 'the same shape as `sibling.test.ts`'",
        HARNESS,
      ].join('\n'),
      'a/sibling.test.ts': DOUBLE,
    }))
    expect(asString.pointers).toHaveLength(0)

    // The control: the identical characters as a line comment ARE read, and the
    // verdict is the BROKEN one, so the zero above is the span scanner and not
    // a sentence the rule cannot match.
    const asComment = census(memoryTree({
      'a/pointer.test.ts': [
        '// the same shape as `sibling.test.ts`',
        HARNESS,
      ].join('\n'),
      'a/sibling.test.ts': DOUBLE,
    }))
    expect(asComment.broken).toHaveLength(1)
  })

  test("D1.274's lesson: a construction spelled in the sibling's COMMENT does not count", () => {
    // The sibling was converted and its commit comment says what it replaced —
    // exactly the shape that moved the naive census the wrong way (50 -> 51)
    // while the population fell.
    const result = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', HARNESS),
      'a/sibling.test.ts': [
        '// Converted: this used to call createTestSessionManager( before D1.242.',
        DOUBLE,
      ].join('\n'),
    }))

    expect(result.broken).toHaveLength(1)
    expect(result.broken[0]?.siblingCarries).toEqual([['sm-double']])
  })

  test('an EXPLAINED pair is excluded from the gated set and keeps its reason', () => {
    const [explained] = EXPLAINED_PAIRS
    const result = census(memoryTree({
      [explained?.file ?? '']: pointerFile(explained?.sibling ?? '', HARNESS),
      [`x/${explained?.sibling ?? ''}`]: DOUBLE,
    }))

    // Without the table this fixture is a BROKEN pointer: the sibling carries
    // the other construction. That is the control for the exclusion.
    expect(result.broken).toHaveLength(0)
    expect(result.explained).toHaveLength(1)
    expect(result.explained[0]?.reason).toBe(explained?.reason)
    expect(result.staleExplanations.map(pair => pair.file))
      .not.toContain(explained?.file)
  })

  test('an EXPLAINED entry the census cannot see is reported as stale', () => {
    const result = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', HARNESS),
      'a/sibling.test.ts': HARNESS,
    }))

    expect(result.staleExplanations).toHaveLength(EXPLAINED_PAIRS.length)
  })

  test('verdictFor: a MIXED pointing file makes the strongest claim', () => {
    expect(verdictFor(['sm-double', 'sm-harness'], ['a/s.test.ts'], [['sm-harness']])).toBe('broken')
    expect(verdictFor(['sm-double', 'sm-harness'], ['a/s.test.ts'], [['sm-double', 'sm-harness']])).toBe('holds')
    expect(verdictFor(['sm-harness'], [], [])).toBe('missing')
  })

  test('verdictFor: the EXISTS claim is existence and nothing more — D1.318', () => {
    // An empty claim is a pointing file with no construction. It must not read
    // as "carries everything in the empty set" by accident, and it must still
    // fail on a sibling that is not there: both arms, one line apart.
    expect(verdictFor([], ['a/s.test.ts'], [[]])).toBe('holds')
    expect(verdictFor([], ['a/s.test.ts'], [['sm-double']])).toBe('holds')
    expect(verdictFor([], [], [])).toBe('missing')
  })

  test('splitSentences keeps a filename whole — no dot inside one ends a sentence', () => {
    const sentences = splitSentences('`a.test.ts` shares this shape. And then a new one.')
    expect(sentences[0]?.text).toContain('`a.test.ts` shares this shape.')
    expect(sentences).toHaveLength(2)
  })

  test('the pin is a drift alarm in BOTH directions, past a stated allowance', () => {
    expect(slackExceeded(PINNED_POINTERS)).toBe(false)
    expect(slackExceeded(PINNED_POINTERS - SLACK_ALLOWANCE)).toBe(false)
    expect(slackExceeded(PINNED_POINTERS + SLACK_ALLOWANCE)).toBe(false)
    expect(slackExceeded(PINNED_POINTERS - SLACK_ALLOWANCE - 1)).toBe(true)
    expect(slackExceeded(PINNED_POINTERS + SLACK_ALLOWANCE + 1)).toBe(true)
  })

  test('the real tree: the probe sees pointers, and every explained file still exists', async () => {
    const result = census(await repoTree())
    // No number: see this file's header. The weak claim is the honest one.
    expect(result.pointers.length).toBeGreaterThan(0)
    expect(result.filesScanned).toBeGreaterThan(result.pointers.length)

    // A typo in EXPLAINED_PAIRS is otherwise invisible — the entry would simply
    // never match and the pair would be gated as if it had no reason. This can
    // only fail when a file is renamed or deleted, which is a real reason.
    const tracked = new Set(
      execFileSync('git', ['ls-files', '-z', '--', ...EXPLAINED_PAIRS.map(pair => pair.file)], {
        cwd: new URL('..', import.meta.url).pathname,
        encoding: 'utf8',
      }).split('\0').filter(line => line !== ''),
    )
    expect([...tracked].sort()).toEqual(EXPLAINED_PAIRS.map(pair => pair.file).sort())
  })

  test('THE HISTORICAL CONTROL: 2 broken at `4f1a6a451`, 0 at the commit before', async () => {
    // The strongest evidence this gate can produce, and the one arm a fixture
    // cannot give: the two pointers WI-ah found by hand were false on a real
    // tree on 2026-09-18, and the gate finds exactly those two there. History is
    // immutable, so this pin cannot drift under a sibling lane — unlike any
    // assertion about HEAD.
    const before = await historicalCensus('b377320e6')
    expect(before.pointers.length).toBe(103)
    expect(before.broken).toHaveLength(0)

    const after = await historicalCensus('4f1a6a451')
    expect(after.pointers.length).toBe(104)
    expect(after.broken.map(pointer => `${pointer.file} -> ${pointer.sibling}`)).toEqual([
      'packages/server-core/src/sessions/__tests__/strict-drain-coalescing.test.ts'
      + ' -> SessionManager.agent-view.test.ts',
      'packages/server-core/src/sessions/__tests__/user-prompt-expansion.test.ts'
      + ' -> SessionManager.hook-effort-input.test.ts',
    ])
  })

  test('a revision is a READING and never a verdict — the pin is a claim about HEAD', async () => {
    // 100 against a pin of 99, so the slack arm is silent here for the
    // uninteresting reason; what this pins is that a REVISION never reaches the
    // pin at all, whatever its count.
    // Both halves fire on that tree: two false shape pointers AND the fifteen
    // dead mentions D1.321 later repaired. The arm that matters is that neither
    // reaches the PIN, which is a claim about HEAD alone.
    expect(failures(await historicalCensus('4f1a6a451'), '4f1a6a451')).toEqual(['broken', 'dead-mention'])
    expect(failures(await historicalCensus('b377320e6'), 'b377320e6')).toEqual(['dead-mention'])
  })

  test('`--check` fails on a BROKEN pointer and on sustained pin drift, and on nothing else', () => {
    const clean = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', HARNESS),
      'a/sibling.test.ts': HARNESS,
    }))
    // One pointer against a pin of nine is drift far past the allowance, which
    // is the second failure and is what a fixture census always looks like.
    expect(failures(clean)).toEqual(['slack'])

    const broken = census(memoryTree({
      'a/pointer.test.ts': pointerFile('sibling.test.ts', HARNESS),
      'a/sibling.test.ts': DOUBLE,
    }))
    expect(failures(broken)).toEqual(['broken', 'slack'])
  })

  test('the two spellings of the file universe select the same files', async () => {
    // `SOURCE_FILE_RE` exists only because `git ls-tree` refuses `:(glob)` magic,
    // and two spellings of one universe drift. Both sides here read the INDEX,
    // deliberately: comparing the pathspec against the HEAD TREE would go red
    // for the milliseconds a neighbour lane's new file is staged and not yet
    // committed, which is a control that cries wolf about another lane.
    const repoRoot = new URL('..', import.meta.url).pathname
    const byPathspec = [...(await repoTree()).files].sort()
    const byExtension = execFileSync('git', ['ls-files', '-z', '--', ...SOURCE_ROOTS], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(line => SOURCE_FILE_RE.test(line)).sort()

    expect(byExtension).toEqual(byPathspec)
    expect(byPathspec.every(path => SOURCE_FILE_RE.test(path))).toBe(true)
    // And the universe really is wider than the tests now — D1.318's whole point.
    expect(byPathspec.some(path => !TEST_FILE_RE.test(path))).toBe(true)
  })

  test('reading a blob is reading the working tree — the fidelity the speed rests on', async () => {
    // D1.318 made every mode read through `git cat-file --batch`, because on this
    // rig `readFileSync` over the 860 candidate files costs 155 s against 2 s for
    // the batch (one `cat` process over the same list: 138.81 s, `user 0.00` —
    // the filesystem, not the runtime). That is only sound if a blob read equals
    // a disk read, which is what this asserts over a sample rather than assumes.
    const repoRoot = new URL('..', import.meta.url).pathname
    const tree = await repoTree()
    const sample = [...tree.files].filter((_, index) => index % 200 === 0).slice(0, 25)
    const mismatched = sample.filter(path =>
      tree.read(path) !== readFileSync(join(repoRoot, path), 'utf8'))

    expect(sample.length).toBeGreaterThan(5)
    expect(mismatched).toEqual([])
  })

  test('D1.329 — a comment naming a test file that does not exist is a DEAD MENTION', () => {
    const result = census(memoryTree({
      'a/reader.ts': '// The proof is in `renamed-away.test.ts`, which nothing renamed with it.\n',
      'a/sibling.test.ts': HARNESS,
    }))

    expect(result.deadMentions).toHaveLength(1)
    expect(result.deadMentions[0]?.claimKind).toBe('mentioned')
    expect(result.deadMentions[0]?.sibling).toBe('renamed-away.test.ts')

    // The control on the same instrument: the same sentence naming a file that
    // IS there reports nothing, so the one above is the resolution failing and
    // not the scanner firing at every name it sees.
    const alive = census(memoryTree({
      'a/reader.ts': '// The proof is in `sibling.test.ts`, which nothing renamed with it.\n',
      'a/sibling.test.ts': HARNESS,
    }))
    expect(alive.deadMentions).toHaveLength(0)
    expect(alive.mentions).toHaveLength(0)
  })

  test('D1.329 — a GLOB names a family, not a file', () => {
    // `*-real-server.test.ts` and `*-e2e.test.ts` are the two live ones. The row
    // called them line-wrap artefacts; read at HEAD they are patterns whose star
    // sits outside the name character class.
    const glob = census(memoryTree({
      'a/reader.ts': '// the slow `*-real-server.test.ts` family is skipped here\n',
      'a/sibling.test.ts': HARNESS,
    }))
    expect(glob.deadMentions).toHaveLength(0)

    // Without the star the very same tail IS a name, so the zero above is the
    // glob rule and not the regex failing to match.
    const bare = census(memoryTree({
      'a/reader.ts': '// the slow `-real-server.test.ts` family is skipped here\n',
      'a/sibling.test.ts': HARNESS,
    }))
    expect(bare.deadMentions).toHaveLength(1)
  })

  test('D1.329 — an EXPLAINED mention is reported with its reason, never failed', () => {
    const [explained] = EXPLAINED_MENTIONS
    const result = census(memoryTree({
      [explained?.file ?? '']: `// adapted from \`${explained?.sibling ?? ''}\` upstream\n`,
      'a/sibling.test.ts': HARNESS,
    }))

    expect(result.deadMentions).toHaveLength(0)
    expect(result.explainedMentions).toHaveLength(1)
    expect(result.explainedMentions[0]?.reason).toBe(explained?.reason)
  })

  test('D1.329 — a needle inside a STRING is not a construction site', () => {
    // This file's own `CONSTRUCTIONS` table holds both needles as string
    // literals. With comments alone blanked, the gate read ITSELF as a member of
    // the family it gates and four of its docblock examples became `carries`
    // claims. Both arms, one line apart.
    expect(constructionsIn(HARNESS)).toEqual(['sm-harness'])
    expect(constructionsIn("const needle = 'createTestSessionManager('")).toEqual([])
    expect(blankNonCode("const needle = 'createTestSessionManager('")).not.toContain('createTest')
  })

  test('D1.329 — THE HISTORICAL CONTROL: 15 dead mentions before the repairs, 0 after', async () => {
    // `e03ba84b9` is the parent of `c46244e3a`, the first of D1.321's three
    // repair commits. FIFTEEN mentions over THIRTEEN files — the row says
    // thirteen, which was the FILE count; `module-graph-budgets.ts` alone
    // carries three of them. History is immutable, so this pin cannot drift.
    expect((await historicalCensus('e03ba84b9')).deadMentions).toHaveLength(15)
    expect(census(await repoTree()).deadMentions).toHaveLength(0)
  })

  test('the construction table is the extension point, and its ids are distinct', () => {
    expect(CONSTRUCTIONS.length).toBeGreaterThan(1)
    expect(new Set(CONSTRUCTIONS.map(entry => entry.id)).size).toBe(CONSTRUCTIONS.length)
    expect(new Set(CONSTRUCTIONS.map(entry => entry.needle)).size).toBe(CONSTRUCTIONS.length)
  })
})

describe('a path git QUOTES is listed, found and read from the tree it is in (F1.452)', () => {
  // Without `-z`, `git status --porcelain`, `ls-files`, `ls-tree` and `grep -l`
  // all print a path carrying a space, a double quote, a backslash or a
  // non-ASCII byte C-quoted. This gate sliced those lines, so such a file was
  // listed under a name that is not its own and read as its STALE blob —
  // F1.271's defect in a third gate (WJ-ii's verifier, 2026-09-23). The repo is
  // a throwaway one, reached through `TreeOptions.root`, never this tree.
  const NAMES = [
    'packages/x/plain.ts',
    'packages/x/with space.ts',
    'packages/x/тест.ts',
    'packages/x/q"uote.ts',
    'packages/x/back\\slash.ts',
  ].sort()

  function quotedRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'shape-pointer-quoted-'))
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    }
    run('init', '-q')
    run('config', 'user.email', 'lane@example.invalid')
    run('config', 'user.name', 'lane')
    mkdirSync(join(root, 'packages', 'x'), { recursive: true })
    for (const name of NAMES) writeFileSync(join(root, name), '// STALE-BLOB mentions foo.test.ts\n')
    run('add', '-A')
    run('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
    // Every file is now DIRTY: its working tree differs from its blob.
    for (const name of NAMES) writeFileSync(join(root, name), '// WORKING-TREE mentions foo.test.ts\n')
    return root
  }

  test('the working tree: every name is listed, tracked, a candidate, and read from disk', async () => {
    const root = quotedRepo()
    try {
      const tree = await repoTree({ root })
      expect([...tree.files].sort()).toEqual(NAMES)
      expect([...(tree.tracked ?? [])].sort()).toEqual(NAMES)
      expect([...(tree.candidates?.() ?? [])].sort()).toEqual(NAMES)
      // `plain.ts` is the control on the same instrument: the old parser already
      // read it from disk, so a red on it alone would be a broken rig.
      for (const name of NAMES) expect(tree.read(name).trim(), name).toBe('// WORKING-TREE mentions foo.test.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a revision: every name is listed, tracked, a candidate, and read as that revision\'s blob (F1.453)', async () => {
    // `ls-tree` without `-z` quotes the same names, and a quoted name fails the
    // extension filter on its closing quote, so `--rev` scanned a narrower tree
    // than the one it named.
    const root = quotedRepo()
    try {
      const tree = await repoTree({ root, rev: 'HEAD' })
      expect([...tree.files].sort()).toEqual(NAMES)
      expect([...(tree.tracked ?? [])].sort()).toEqual(NAMES)
      expect([...(tree.candidates?.() ?? [])].sort()).toEqual(NAMES)
      for (const name of NAMES) expect(tree.read(name).trim(), name).toBe('// STALE-BLOB mentions foo.test.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
