/**
 * Tests for `check-conditional-expect.ts` — P2.405.
 *
 * The instrument's value is entirely in its DISCRIMINATION: reporting every
 * `if`-wrapped `expect` would be useless, and reporting none of them would be
 * indistinguishable from a clean tree. So both directions are pinned here
 * against a fixture tree rather than against this repo, whose candidate count
 * moved twice in one afternoon while four lanes edited test files.
 *
 * These cases import `scan()` directly, which is only possible because the
 * script carries an `import.meta.main` guard — the same defect P2.403 fixed in
 * `check-typecheck-coverage.ts`, avoided here from the start.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  baselineKey,
  diffBaseline,
  listTestFiles,
  matchedKeyPaths,
  matcherBaselineKey,
  readTestSources,
  scan,
  scanMatcherMutation,
  untrackedAmong,
  vanishedNotice,
} from './check-conditional-expect'

const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/** Run git in `root`, throwing with git's own words on a non-zero exit. */
function git(root: string, ...args: string[]): void {
  const proc = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
}

/** `body` wrapped in a test module with one `describe`. */
function testModule(body: string): string {
  return `import { describe, expect, it } from 'bun:test'\n\ndescribe('probe', () => {\n${body}\n})\n`
}

/**
 * A fixture repo containing one test file with `body` inside a `describe`.
 *
 * A git repository since F1.608, because the scanner enumerates through
 * `git ls-files`. Nothing is added: the probe is UNTRACKED and no ignore rule
 * covers it, which is exactly what a lane's new test file is before its first
 * commit — so every case below is also a case about that file.
 */
function fixture(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'conditional-expect-'))
  created.push(root)
  git(root, 'init', '-q')
  mkdirSync(join(root, 'pkg', '__tests__'), { recursive: true })
  writeFileSync(join(root, 'pkg', '__tests__', 'probe.test.ts'), testModule(body))
  return root
}

const UNDISCRIMINATED = `  it('undiscriminated', () => {
    const verdict = classify()
    if (verdict.kind === 'denied') {
      expect(verdict.reason).toContain('policy')
    }
  })`

const DISCRIMINATED = `  it('discriminated', () => {
    const verdict = classify()
    expect(verdict.kind).toBe('denied')
    if (verdict.kind === 'denied') {
      expect(verdict.reason).toContain('policy')
    }
  })`

describe('check-conditional-expect', () => {
  test('reports an `if`-wrapped expect whose discriminator is never asserted', async () => {
    const { files, candidates } = await scan(fixture(UNDISCRIMINATED))

    expect(files).toBe(1)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.discriminated).toBe(false)
    expect(candidates[0]!.disc).toBe('verdict.kind')
    expect(candidates[0]!.test).toBe('undiscriminated')
  })

  test('does NOT report it once the discriminator is asserted unconditionally', async () => {
    const { candidates } = await scan(fixture(DISCRIMINATED))

    // Still a candidate BLOCK — the population figure counts it — but marked
    // discriminated, so the default report leaves it alone. This is the half
    // that makes the tool worth running: without it the queue is every `if`.
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.discriminated).toBe(true)
  })

  test('separates the two when both are present in one file', async () => {
    const { candidates } = await scan(fixture(`${UNDISCRIMINATED}\n\n${DISCRIMINATED}`))

    expect(candidates.map((c) => [c.test, c.discriminated])).toEqual([
      ['undiscriminated', false],
      ['discriminated', true],
    ])
  })

  test('an `if` with no expect in its body is not a candidate at all', async () => {
    const { candidates } = await scan(fixture(`  it('no expect inside', () => {
    const verdict = classify()
    if (verdict.kind === 'denied') {
      log(verdict.reason)
    }
    expect(verdict.kind).toBe('denied')
  })`))

    expect(candidates).toHaveLength(0)
  })

  test('a non-test file is not scanned, so a fixture with none scans zero files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conditional-expect-'))
    created.push(root)
    git(root, 'init', '-q')
    mkdirSync(join(root, 'pkg'), { recursive: true })
    writeFileSync(join(root, 'pkg', 'source.ts'), `if (x === 1) { expect(y).toBe(2) }\n`)

    const { files, candidates } = await scan(root)
    expect(files).toBe(0)
    expect(candidates).toHaveLength(0)
  })
})

describe('the --check baseline — P2.416: gate on NEW hits, never on the total', () => {
  test('a hit already in the baseline is not a failure', () => {
    const baseline = new Set(['a.test.ts :: keeps working :: verdict.kind'])
    expect(diffBaseline(['a.test.ts :: keeps working :: verdict.kind'], baseline).added).toEqual([])
  })

  test('a hit absent from the baseline IS a failure', () => {
    const baseline = new Set(['a.test.ts :: keeps working :: verdict.kind'])
    expect(diffBaseline(['b.test.ts :: brand new :: result.ok'], baseline).added).toEqual([
      'b.test.ts :: brand new :: result.ok',
    ])
  })

  test('a baseline line nothing matches any more is reported as STALE, not as a failure', () => {
    const { added, stale } = diffBaseline([], new Set(['a.test.ts :: fixed since :: v.kind']))
    expect(added).toEqual([])
    expect(stale).toEqual(['a.test.ts :: fixed since :: v.kind'])
  })

  test('the key carries no line number, so a hit surviving a shifted file stays baselined', () => {
    // The whole reason for this keying: sibling lanes move test-file line numbers
    // constantly, and a line-keyed baseline would fire on every unrelated commit.
    const at10 = { file: 'a.test.ts', line: 10, test: 'same test', disc: 'verdict.kind' }
    const at400 = { file: 'a.test.ts', line: 400, test: 'same test', disc: 'verdict.kind' }
    expect(baselineKey(at400)).toBe(baselineKey(at10))
    expect(diffBaseline([baselineKey(at400)], new Set([baselineKey(at10)])).added).toEqual([])
  })

  test('D1.312 — HITS and KEYS are different units, which is why the report line names both', () => {
    // The defect the reporting line carried: `71 undiscriminated (baseline holds
    // 67)` put a HIT count beside a KEY count with nothing saying so, and it
    // reads exactly like four unbaselined hits. It was read that way twice on
    // 2026-09-18. This pins the mechanism the line now has to describe — two
    // hits in one test collapse to ONE key, so the two numbers can never be
    // compared by subtraction.
    const twoLinesOneTest = [
      { file: 'a.test.ts', line: 10, test: 'same test', disc: 'verdict.kind' },
      { file: 'a.test.ts', line: 42, test: 'same test', disc: 'verdict.kind' },
    ]
    const keys = twoLinesOneTest.map(baselineKey)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
    // And a baseline holding that one key accepts BOTH hits, so a gate that
    // subtracted would report a phantom.
    expect(diffBaseline(keys, new Set([keys[0] as string])).added).toEqual([])
  })
})

/**
 * Selector 2 — P2.433.
 *
 * The predicate is worth nothing unless it separates the two real defects from
 * the 26 harmless sites, so every case here lands on one of those two verdicts,
 * and each of the three harmless SHAPES gets its own case. All three are shapes
 * the lane actually met in this tree, not invented ones.
 *
 * Every fixture body is a MODULE-SCOPE constant, and that is load-bearing rather
 * than stylistic. Written inline inside the `test()` calls, these bodies sit
 * inside a real `it()`/`test()` block of THIS file, so the scanner reads its own
 * fixtures as live sites and reports four defects against itself — measured, the
 * gate was red on arrival because of the tests that prove it works. At module
 * scope the same text belongs to no test block, and "read again later in the
 * same `it()`" is unanswerable, which is the predicate declining rather than a
 * special case. Selector 1's fixtures are hoisted for the same reason.
 */

const HOLLOWED_AND_REREAD = `  it('leak guard', () => {
    const descriptor = build()
    expect(descriptor).toMatchObject({
      command: 'node',
      env: expect.objectContaining({ TOKEN: 'mapped' }),
    })
    expect(JSON.stringify(descriptor.env)).not.toContain('secret')
  })`

const TO_EQUAL_INSTEAD = `  it('equal', () => {
    const descriptor = build()
    expect(descriptor).toEqual({ env: expect.objectContaining({ TOKEN: 'mapped' }) })
    expect(descriptor.env).toBeDefined()
  })`

const UNBOUND_TEMPORARY = `  it('temporary', async () => {
    const other = 1
    expect(await build()).toMatchObject({ env: expect.objectContaining({ TOKEN: 'x' }) })
    expect(other).toBe(1)
  })`

const LAST_ASSERTION = `  it('last', () => {
    const descriptor = build()
    expect(descriptor).toMatchObject({ env: expect.objectContaining({ TOKEN: 'x' }) })
  })`

const UNMATCHED_SIBLING = `  it('sibling', () => {
    const resolved = build()
    expect(resolved).toMatchObject({ path: expect.stringContaining('audit.js') })
    expect(resolved?.body).toContain('[workflow]')
  })`

const WHOLESALE_LATER_READ = `  it('wholesale', () => {
    const descriptor = build()
    expect(descriptor).toMatchObject({ env: expect.objectContaining({ TOKEN: 'x' }) })
    expect(Object.keys(descriptor)).toContain('env')
  })`

const ROOT_LEVEL_MATCHER = `  it('root', () => {
    const descriptor = build()
    expect(descriptor).toMatchObject(expect.objectContaining({ command: 'node' }))
    expect(descriptor.env).toBeDefined()
  })`

const URL_IN_A_STRING_LITERAL = `  it('url', () => {
    const cfg = { url: 'https://example.com/a' }
    expect(cfg).toMatchObject({ url: expect.stringContaining('example') })
    expect(cfg.url).toContain('example')
  })`

describe('scanMatcherMutation', () => {
  async function sitesOf(body: string): Promise<Awaited<ReturnType<typeof scanMatcherMutation>>['sites']> {
    return (await scanMatcherMutation(fixture(body))).sites
  }

  test('flags a hollowed key that is read again later in the same it()', async () => {
    // The `runtime-pool-servers.test.ts` shape: the leak guard below searches an
    // `env` that the assertion above has already replaced with the matcher. Two
    // mutants survived there — a forwarded `CODEX_HOME` and an injected host
    // secret — while both assertions reported green.
    const sites = await sitesOf(HOLLOWED_AND_REREAD)

    expect(sites).toHaveLength(1)
    expect(sites[0]?.received).toBe('descriptor')
    expect(sites[0]?.paths).toEqual(['env'])
    expect(sites[0]?.laterRead).toBe('env')
  })

  test('never flags toEqual, which does not mutate', async () => {
    // P2.413 retired one of its eight original sites on exactly this fact.
    expect(await sitesOf(TO_EQUAL_INSTEAD)).toEqual([])
  })

  test('shape (a): an unbound temporary is a site but not a defect', async () => {
    const sites = await sitesOf(UNBOUND_TEMPORARY)

    expect(sites).toHaveLength(1)
    expect(sites[0]?.laterRead).toBeNull()
  })

  test('shape (b): the last assertion in the block is a site but not a defect', async () => {
    const sites = await sitesOf(LAST_ASSERTION)

    expect(sites).toHaveLength(1)
    expect(sites[0]?.laterRead).toBeNull()
  })

  test('shape (c): a later read of an UNMATCHED sibling key, spelled with ?.', async () => {
    // `custom-slash-command-boundary.test.ts:100` in shape. Only the matched leaf
    // is overwritten, so `body` is intact — and the `?.` is the half a first cut
    // got wrong, which turned this harmless site into the run's only false hit.
    const sites = await sitesOf(UNMATCHED_SIBLING)

    expect(sites).toHaveLength(1)
    expect(sites[0]?.paths).toEqual(['path'])
    expect(sites[0]?.laterRead).toBeNull()
  })

  test('a later read that passes the object on WHOLESALE is a defect', async () => {
    expect((await sitesOf(WHOLESALE_LATER_READ))[0]?.laterRead).toBe('wholesale')
  })

  test('a matcher at the TOP level marks the whole object, so any later read counts', async () => {
    const sites = await sitesOf(ROOT_LEVEL_MATCHER)

    expect(sites[0]?.paths).toEqual([''])
    expect(sites[0]?.laterRead).toBe('env')
  })

  test('a `https://` inside a string literal does not hide the site', async () => {
    // The trap that cost the lane two real sites: a naive comment stripper reads
    // the `//` in a URL as the start of a line comment. Nothing is stripped
    // here, and this case fails the moment someone adds a stripper.
    const sites = await sitesOf(URL_IN_A_STRING_LITERAL)

    expect(sites).toHaveLength(1)
    expect(sites[0]?.laterRead).toBe('url')
  })

  test('the baseline key carries no line number', () => {
    // Its sibling's key drops the line number because concurrent lanes move
    // them; this one must not reintroduce the problem.
    const key = matcherBaselineKey({
      file: 'pkg/__tests__/probe.test.ts',
      test: 'leak guard',
      received: 'descriptor',
      paths: ['env'],
    })

    expect(key).toBe('pkg/__tests__/probe.test.ts :: leak guard :: descriptor :: env')
    expect(/:\d+/.test(key)).toBe(false)
  })
})

describe('matchedKeyPaths', () => {
  test('reports the nested path and ignores keys inside the matcher itself', () => {
    expect(matchedKeyPaths("{ runtime: { model: expect.objectContaining({ id: 'x' }) } }"))
      .toEqual(['runtime.model'])
  })

  test('reports every matched leaf, and nothing for a literal-only object', () => {
    expect(matchedKeyPaths('{ a: expect.any(String), b: 1, c: expect.anything() }'))
      .toEqual(['a', 'c'])
    expect(matchedKeyPaths("{ a: 1, b: 'two' }")).toEqual([])
  })
})

/**
 * P3.305 — the label that keeps another lane's in-flight file from being read
 * as this tree's pre-existing red.
 *
 * Driven against the REAL repository rather than a fixture, because the thing
 * under test is git's answer about this working tree and a fixture directory is
 * not a git repository. Both directions on the same call, so a version that
 * always returns the empty set — the failure mode that silently removes the
 * label — cannot pass.
 */
describe('P3.305 · untrackedAmong labels the files git has never seen', () => {
  test('a tracked path is not labelled and an unknown one is, in the same call', () => {
    const tracked = 'scripts/check-conditional-expect.ts'
    const unknown = 'scripts/__p3305_no_such_file__.test.ts'
    const result = untrackedAmong([tracked, unknown])
    expect(result.has(unknown)).toBe(true)
    expect(result.has(tracked)).toBe(false)
    // The positive control the shape needs: an implementation that answered
    // "everything is untracked" would satisfy the first assertion alone, and one
    // that answered "nothing is" would satisfy the second alone.
    expect(result.size).toBe(1)
  })

  test('an empty input costs no subprocess and yields no labels', () => {
    expect(untrackedAmong([])).toEqual(new Set())
  })
})

/**
 * F1.210 — a test file a neighbour deletes between the walk and the read.
 *
 * Measured 2026-09-23 twice in one wave: a sibling lane removed its untracked
 * probe `*.test.ts` after the walk listed it, and `lint:conditional-expect`
 * died with an uncaught ENOENT — exit 1 in `lint:chain`, green on the re-run.
 * The enumeration is handed in here so the window between the two steps can be
 * reproduced exactly instead of raced: the list names a file that is not there.
 */
describe('F1.210 · a test file that vanished mid-scan is skipped and named, never a crash', () => {
  test('both selectors skip the vanished path, name it, and still scan the rest', async () => {
    const root = fixture(UNDISCRIMINATED)
    const present = join(root, 'pkg', '__tests__', 'probe.test.ts')
    const gone = join(root, 'pkg', '__tests__', 'deleted-by-a-neighbour.test.ts')

    const conditional = await scan(root, [present, gone])
    expect(conditional.vanished).toEqual([join('pkg', '__tests__', 'deleted-by-a-neighbour.test.ts')])
    expect(conditional.files).toBe(1)
    // The positive control: the file that IS there was really scanned.
    expect(conditional.candidates).toHaveLength(1)

    const matchers = await scanMatcherMutation(root, [present, gone])
    expect(matchers.vanished).toEqual(conditional.vanished)
    expect(matchers.files).toBe(1)

    // The walk's own answer on the same tree names nothing, so the default path is unchanged.
    expect((await scan(root)).vanished).toEqual([])
  })

  test('only ENOENT is forgiven — any other read failure still throws', async () => {
    const root = fixture(DISCRIMINATED)
    const probe = join(root, 'pkg', '__tests__', 'probe.test.ts')
    const [missing, present] = await readTestSources([join(root, 'pkg', '__tests__', 'no-such.test.ts'), probe])
    expect(missing).toBeUndefined()
    expect(present).toContain("describe('probe'")
    // A directory where a file was expected is EISDIR, a real error: it must not be skipped quietly —
    // not even when it arrives beside a file that reads fine (F1.622 reads them all at once).
    await expect(readTestSources([probe, join(root, 'pkg', '__tests__')])).rejects.toThrow()
  })

  test('the notice names every skipped path, and says nothing when nothing vanished', () => {
    expect(vanishedNotice([])).toBeUndefined()
    const notice = vanishedNotice(['a/x.test.ts', 'b/y.test.ts'])
    expect(notice).toContain('2 test file(s) VANISHED')
    expect(notice).toContain('a/x.test.ts, b/y.test.ts')
  })
})

/**
 * F1.608 — the scan enumerates through git and reads a clean file as its blob.
 *
 * `lint:conditional-expect` (a `lint:chain` step) walked the disk and opened
 * every test file: `real 338.14 user 1.38 sys 1.04` over ~2 612 files on
 * 2026-09-24, 0.7 % CPU — AGENTS.md's gate-that-OPENS-its-corpus trap. The fix
 * is `check-nul-bytes`' shape, and this rig holds every kind of file that shape
 * has to tell apart, in one real repository:
 *
 *  - `clean` is tracked and marked `assume-unchanged`, and its DISK copy is then
 *    replaced by one with no candidate at all. Git therefore calls it clean, so
 *    the only way the scan can report the index copy's hit is by reading the
 *    BLOB rather than opening the file. This is the arm that separates the two
 *    readers — the residue `git-status-z.ts` states for every caller, used here
 *    on purpose because nothing else makes a clean file's bytes differ from its
 *    blob without git noticing.
 *  - `changed` is tracked, then rewritten on disk with a candidate: the change is
 *    what must be judged, so it is read from DISK.
 *  - `fresh/…/new` is UNTRACKED and no ignore rule covers it — a lane's new file,
 *    which must still fail the gate before its first commit (P3.305).
 *  - `gone` is tracked and deleted from disk: a pending deletion carries no
 *    `expect`, so it is neither scanned nor reported as vanished.
 *  - an IGNORED copy, a `node_modules` copy this rig's `.gitignore` does not name
 *    (the `SKIP` belt), and two symlinks (one tracked, one not) — none of them is
 *    part of the scan, as none of them was part of the walk.
 */
describe('F1.608 · the scan enumerates through git and reads a clean file as its blob', () => {
  const NO_CANDIDATE = testModule(`  it('nothing conditional', () => {
    expect(1).toBe(1)
  })`)
  let root = ''
  let result: Awaited<ReturnType<typeof scan>> = { files: 0, candidates: [], vanished: [] }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'conditional-expect-git-'))
    created.push(root)
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    git(root, 'init', '-q')
    write('.gitignore', 'ignored/\n')
    write('pkg/__tests__/clean.test.ts', testModule(UNDISCRIMINATED))
    write('pkg/__tests__/changed.test.ts', NO_CANDIDATE)
    write('pkg/__tests__/gone.test.ts', testModule(UNDISCRIMINATED))
    symlinkSync('clean.test.ts', join(root, 'pkg', '__tests__', 'link.test.ts'))
    // An hour in the past, so no entry is racily clean against the index git
    // writes next — git would re-read its content, and the arms must not depend
    // on the clock.
    const past = new Date(Date.now() - 3_600_000)
    for (const path of ['clean', 'changed', 'gone']) utimesSync(join(root, 'pkg', '__tests__', `${path}.test.ts`), past, past)
    git(root, 'add', '--', '.gitignore', 'pkg/__tests__/clean.test.ts', 'pkg/__tests__/changed.test.ts',
      'pkg/__tests__/gone.test.ts', 'pkg/__tests__/link.test.ts')
    // Committed, because a file only STAGED is a porcelain entry (`A `) and the
    // scan reads every porcelain entry from disk — the safe direction.
    git(root, 'config', 'user.email', 'lane@example.invalid')
    git(root, 'config', 'user.name', 'lane')
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
    git(root, 'update-index', '--assume-unchanged', '--', 'pkg/__tests__/clean.test.ts')

    write('pkg/__tests__/clean.test.ts', NO_CANDIDATE)
    write('pkg/__tests__/changed.test.ts', testModule(UNDISCRIMINATED))
    rmSync(join(root, 'pkg', '__tests__', 'gone.test.ts'))
    write('fresh/__tests__/new.test.ts', testModule(UNDISCRIMINATED))
    symlinkSync('new.test.ts', join(root, 'fresh', '__tests__', 'alias.test.ts'))
    write('ignored/scratch/copy.test.ts', testModule(UNDISCRIMINATED))
    write('node_modules/dep/__tests__/dep.test.ts', testModule(UNDISCRIMINATED))
    write('src/source.ts', 'if (x === 1) { expect(y).toBe(2) }\n')

    result = await scan(root)
  }, 60_000)

  const hitFiles = (): string[] => result.candidates.filter((c) => !c.discriminated).map((c) => c.file)

  test('a clean tracked file is read as its index BLOB, never opened', () => {
    // The disk copy carries no candidate; only the blob does.
    expect(hitFiles()).toContain(join('pkg', '__tests__', 'clean.test.ts'))
  })

  test('a tracked file changed on disk is judged as it is on disk', () => {
    expect(hitFiles()).toContain(join('pkg', '__tests__', 'changed.test.ts'))
  })

  test('an untracked test file no ignore rule covers is scanned, and its hit is NEW to the gate', () => {
    const fresh = result.candidates.filter((c) => c.file === join('fresh', '__tests__', 'new.test.ts'))
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.discriminated).toBe(false)
    // What `--check` does with it: against a baseline that has never seen it, it is ADDED — red.
    expect(diffBaseline(fresh.map(baselineKey), new Set()).added).toEqual([baselineKey(fresh[0]!)])
  })

  test('an ignored copy, a node_modules copy, a pending deletion and a symlink are not scanned', () => {
    expect(hitFiles()).toEqual([
      join('fresh', '__tests__', 'new.test.ts'),
      join('pkg', '__tests__', 'changed.test.ts'),
      join('pkg', '__tests__', 'clean.test.ts'),
    ])
    // Three files — clean, changed, new — and nothing vanished: a pending
    // deletion is not a neighbour's mid-scan delete.
    expect(result.files).toBe(3)
    expect(result.vanished).toEqual([])
  })

  test('only the porcelain exceptions and the untracked file are opened; the clean one is a blob', () => {
    const listing = listTestFiles(root)
    expect([...listing.files].sort()).toEqual([
      'fresh/__tests__/new.test.ts',
      'pkg/__tests__/changed.test.ts',
      'pkg/__tests__/clean.test.ts',
    ])
    expect([...listing.blobs.keys()]).toEqual(['pkg/__tests__/clean.test.ts'])
  })

  test('outside a git work tree the scan refuses rather than reporting an empty tree as clean', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'conditional-expect-nogit-'))
    created.push(bare)
    mkdirSync(join(bare, 'pkg', '__tests__'), { recursive: true })
    writeFileSync(join(bare, 'pkg', '__tests__', 'probe.test.ts'), testModule(UNDISCRIMINATED))
    // Not a clean `0 candidates`: the one reading that looks exactly like a passing gate.
    await expect(scan(bare)).rejects.toThrow(/^check-conditional-expect: /)
    await expect(scanMatcherMutation(bare)).rejects.toThrow(/^check-conditional-expect: /)
  })
})
