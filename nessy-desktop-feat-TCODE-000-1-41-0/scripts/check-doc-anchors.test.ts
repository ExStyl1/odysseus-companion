/**
 * The enforcing reader for `check-doc-anchors.ts`.
 *
 * CI runs `bun test`. It does not run `validate:ci` and its Python job is
 * commented out, so a citation guard that lived only in a CLI would have no
 * reader at all — the same class of defect the guard exists to catch.
 *
 * Two jobs here. It asserts the live tree is clean, and it asserts the guard
 * FIRES on each defect class, because an absence check that matches nothing is
 * the failure this plan keeps meeting: one lane's destructive-operand guard was
 * inert on first write because it matched a single call spelling. Every finding
 * kind below is asserted by IDENTITY — kind and subject — and not by "some
 * message mentions something", which is the assertion shape that passes against
 * the very substitution it claims to catch.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ANCHORS_TSV,
  KNOWN_LIVE_UNDERIVABLE,
  MAX_LISTED_SITES,
  NO_CITING_SITE,
  PINNED_DEAD,
  PLACEHOLDER_MARKER,
  auditAnchors,
  classify,
  collectCitations,
  findingsByCitingFile,
  parsePaths,
  pathMatcher,
  readAnchorSnapshot,
  readCorpus,
  refreshReport,
  repoFiles,
  runAudit,
  scanText,
  sectionSlugs,
  slugifyHeading,
  type ClassifyDeps,
  type PinnedDead,
} from './check-doc-anchors.ts'

const SNAPSHOT = readAnchorSnapshot(readFileSync(ANCHORS_TSV, 'utf-8'))

/**
 * The page count the snapshot's own `# Pages:` header CLAIMS.
 *
 * A separate reading from `SNAPSHOT.sections.size`, which counts rows: the
 * header is prose a `--refresh` writes beside the data, and prose beside data
 * is the thing that ages silently in this tree. `-1` when the header is absent
 * or unreadable, so a missing header fails rather than passing as zero.
 */
function snapshotHeaderPageCount(): number {
  const header = /^#\s*Pages:\s*(\d+)\s*$/m.exec(readFileSync(ANCHORS_TSV, 'utf-8'))
  return header ? Number(header[1]) : -1
}

const DEPS: ClassifyDeps = {
  corpus: new Set(['hooks', 'sandboxing', 'agent-sdk/skills', 'gone-from-the-index']),
  fileExists: relative => relative === 'docs/real.md' || relative === 'docs/sub/beside.md',
}

/** A snapshot with one page and two sections, for the fires-on-defect cases. */
const TINY = readAnchorSnapshot(['# Snapshot: 2026-01-01', 'hooks\tsetup', 'hooks\tprecompact'].join('\n'))

const cite = (text: string, file = 'docs/x.md'): ReturnType<typeof scanText> => scanText(file, text, DEPS)

/**
 * P3.318 — the budget for the three tests that scan the whole repo.
 *
 * PREMISE CORRECTION FIRST, because the row this closes was written against a
 * false one. The attribution lane recorded this suite as "the only
 * network-dependent suite of the 1 603", costing ~420 s of the gate and
 * judging documentation rather than this tree. It is none of those things:
 * there is no `fetch` and no `await` anywhere in this file, `--refresh` is the
 * only online path in the guard and no test calls it, and what the audit
 * judges is THIS REPO's citations against a committed snapshot. Moving it out
 * of `bun test` for "egress" would have removed the reader the guard's own
 * header exists to guarantee — CI runs `bun test` and does not run
 * `validate:ci`.
 *
 * WHAT THE 420 s ACTUALLY WAS: three full-repo scans, one per test, each
 * reading every scanned tracked file. `collectCitations` now memoises the
 * default scan for the process (see its docblock), so the three share one.
 * Proof that the sharing works, from the alone run below: 206 992 ms in the
 * first test and 18.7 s across the OTHER 24, where before every one of the
 * three bore the whole scan.
 *
 * THE BUDGET, and both readings, because they disagree by 100x and the
 * disagreement is not explained. Measured 2026-09-03 on the same tree:
 *
 *   1 990 ms   as one of 27 files, load 16.1
 * 206 992 ms   alone, load 9.8  — so it is not load
 *
 * The likeliest reading is the OS file cache: the 27-file run had just walked
 * most of the tree, and this scan reads every one of ~4 100 files. That is a
 * hypothesis, not a measurement, and it is written as one. The budget is set
 * above the SLOWER of the two with headroom, per the rule that a knob below
 * the resting state manufactures its own failure — never against the 1 990 ms
 * figure, which is the flattering one.
 *
 * One honest limit on what this number does: these test bodies are
 * SYNCHRONOUS, and bun cannot preempt a synchronous body. The budget's job is
 * therefore to stop the spurious `timed out after 5000ms` line that made all
 * three read as timeouts in the gate, not to bound anything — a scan that runs
 * away still runs away, and the wall clock is what says so.
 *
 * RAISED 300 000 → 600 000 on 2026-09-12 (W19-f, in-zone residue of C3.338),
 * against a MEASURED floor rather than a guess. Two runs of this file minutes
 * apart, on the same bytes of the scan, under wave-19 load:
 *
 *   409 590 ms   whole file, this test PASSED inside it, load ~10
 *   432 703 ms   this test alone — timed out against the 300 000 budget
 *
 * So the budget had fallen BELOW the resting state, which is the rule this
 * header already states in the other direction. Nothing about the scan changed
 * that day: what moved is the tree it walks and the eight sibling lanes
 * committing to it. The number is the slower reading with headroom, and it is
 * the wall clock — not this budget — that says when a scan has run away.
 */
const REPO_SCAN_TIMEOUT_MS = 600_000

describe('check-doc-anchors — the live tree', () => {
  it('has no dead section anchor, and nothing pinned', () => {
    const audit = runAudit()
    // BY CITING FILE (C3.338), because this diff is what a repairing lane reads:
    // the flat `[kind] subject` list it used to print carries no file at all, so
    // a lane fixing one of three findings could not tell which two remained or
    // which were theirs. Same findings, re-keyed — `findingsByCitingFile` is a
    // view and filters nothing.
    expect(findingsByCitingFile(audit.findings)).toEqual({})
  }, REPO_SCAN_TIMEOUT_MS)

  it('checked something — an empty scan would also report no findings', () => {
    // The one failure a "no findings" assertion cannot tell from success. Floors,
    // not exact numbers: citations churn, and a knob set below the resting state
    // manufactures its own failure.
    const audit = runAudit()
    expect(audit.verified).toBeGreaterThan(1400)
    expect(audit.pinned).toBe(0)
    // 7 → 98 pages on 2026-08-31 (`P2.376`): every page this repo cites with an
    // anchor is now snapshotted, so 88 `page-not-snapshotted` findings became
    // CHECKED citations rather than unchecked ones. Exact, so a page cannot
    // silently leave the snapshot; `--refresh` moves it deliberately.
    //
    // 98 → 102, read from the snapshot's own `# Pages:` header on 2026-09-07. The
    // refreshes that moved it (`2ab52a56f` last, "the snapshot gains the three
    // pages it never held") did not move this pin, so the suite carried a SECOND
    // red with nothing to do with the tree's citations. Fixed here (`P6.680`,
    // in-zone residue) rather than left: a stale exact pin standing beside a live
    // finding teaches a reader to skim both.
    //
    // 102 → 104 on 2026-09-07 (`P6.718`), from the online `--refresh` that row
    // owed: `desktop.md` and `agent-sdk/permissions.md` were cited correctly and
    // had never been snapshotted, so seven citations across seven sites were
    // UNCHECKED rather than wrong. Moving the pin in the same commit as the
    // snapshot is the point of it being exact — a page cannot enter or leave the
    // snapshot without a deliberate edit here.
    //
    // 104 → 106 on 2026-09-11, from `b77747528`'s online `--refresh`, which
    // moved the file and not this pin — the THIRD refresh to do that. The number
    // stays typed, because deriving it from the TSV would make the guard
    // vacuous: both sides would then come from the file a refresh rewrites. The
    // two pages that joined are named instead, read off that commit's own diff,
    // so a later silent departure is visible as more than a count:
    // `agent-sdk/hooks` and `large-codebases`. Nothing left the snapshot.
    //
    // 106 → 114 on 2026-10-01 (F1.1033), two refreshes in one row: the plugin
    // docs moved under `plugins/`, so `plugins-reference`, `plugin-marketplaces`,
    // `plugins` and `discover-plugins` LEFT (out of the corpus, their citations
    // re-pointed), `agent-sdk/hooks` left because nothing cites it with an anchor
    // any more, and thirteen `plugins/*` pages JOINED as their successors.
    // 114 → 115 on 2026-10-10 (the gate-fix wave's e919e3c6f): `--refresh`
    // snapshotted `setup.md`, the one page cited with an anchor and never
    // snapshotted, closing the gate's single [page-not-snapshotted] finding.
    expect(SNAPSHOT.sections.size).toBe(115)
    expect([...SNAPSHOT.sections.keys()]).toContain('plugins/manifest-reference')
    expect([...SNAPSHOT.sections.keys()]).toContain('plugins/marketplace-reference')
    expect([...SNAPSHOT.sections.keys()]).not.toContain('plugins-reference')
    expect([...SNAPSHOT.sections.keys()]).toContain('large-codebases')
    // Not vacuous and not the same reading twice: the `# Pages:` header is PROSE
    // a refresh writes beside the rows, and the rows are the data. They have
    // disagreed in this tree's other snapshots, and a header nobody checks is
    // the thing a reader quotes.
    expect(snapshotHeaderPageCount()).toBe(SNAPSHOT.sections.size)
    // 574 → 666 slugs over the same 7 pages on 2026-08-25, from two guard fixes
    // rather than upstream churn: dotted headings stopped losing their dots, and
    // `<span id>` anchors started being read at all. 666 → 3 025 on 2026-08-31,
    // from the 91 newly snapshotted pages plus two more anchor kinds — raw
    // `<hN id>` headings and `<Update label>` entries, both validated against the
    // RENDERED pages (380/380 for the labels). A floor, because upstream adds
    // sections, and set just under the resting value rather than at zero: a knob
    // below the resting state manufactures its own pass.
    expect([...SNAPSHOT.sections.values()].reduce((sum, set) => sum + set.size, 0)).toBeGreaterThan(2900)
  }, REPO_SCAN_TIMEOUT_MS)

  it('scans the repo through git, and finds citations in it', () => {
    const citations = collectCitations()
    // A floor, not an exact count: the plan tracker that records this work cites
    // these pages too, so an exact number fails on the commit that describes it.
    expect(citations.filter(citation => citation.bucket === 'corpus').length).toBeGreaterThan(1400)
    // The guard's own two files are excluded — they name dead anchors on purpose.
    expect(citations.some(citation => citation.file.startsWith('scripts/check-doc-anchors'))).toBe(false)
  }, REPO_SCAN_TIMEOUT_MS)

  it('reads the corpus snapshot AGENTS.md points at, including its subpath pages', () => {
    const corpus = readCorpus(readFileSync(resolve(import.meta.dir, 'claude-doc-pages.tsv'), 'utf-8'))
    expect(corpus.size).toBeGreaterThan(150)
    expect(corpus.has('hooks')).toBe(true)
    expect(corpus.has('agent-sdk/skills')).toBe(true)
  })

  it('states what it cannot catch, in the guard itself', () => {
    // Not decoration. The limits are the deliverable: three "all citations
    // measured" claims were made in one week on rigs blind to a third of the
    // anchors, so this paragraph is asserted the way a contract is.
    const source = readFileSync(resolve(import.meta.dir, 'check-doc-anchors.ts'), 'utf-8')
    expect(source).toContain('WHAT THIS GUARD CANNOT CATCH')
    expect(source).toContain('phantom quote')
    expect(source).toContain('line-numbered anchor')
    // Phrases short enough to survive a rewrap: an assertion that breaks on a
    // reflowed comment gets deleted, and the paragraph goes with it.
    expect(source).toContain('in-repo or third-party anchors')
    expect(source).toContain('is NOT a verified citation')
  })
})

describe('check-doc-anchors — slugs', () => {
  it('hyphenates spaces AND dots — the rule this file asserted backwards', () => {
    // Every case measured against the RENDERED pages (2026-08-25), which is the
    // only non-circular source: the previous rule was validated against a
    // snapshot it had itself generated, and so certified its own error. It
    // asserted `#permissionsdefaultmode`; the page carries
    // `id="permissions-defaultmode"` and no dot-stripped id at all.
    expect(slugifyHeading('What runs under allowManagedHooksOnly')).toBe('what-runs-under-allowmanagedhooksonly')
    expect(slugifyHeading('permissions.defaultMode')).toBe('permissions-defaultmode')
    expect(slugifyHeading('`sandbox.filesystem.allowWrite`')).toBe('sandbox-filesystem-allowwrite')
    expect(slugifyHeading('Node.js package dependencies')).toBe('node-js-package-dependencies')
    expect(slugifyHeading('Invalid entries in managed settings')).toBe('invalid-entries-in-managed-settings')
    // Punctuation splits three ways, and each way has a witness on a live page.
    expect(slugifyHeading('Agents, sessions, and worktrees')).toBe('agents-sessions-and-worktrees')
    expect(slugifyHeading('Host on GitHub (recommended)')).toBe('host-on-github-recommended')
    expect(slugifyHeading('Walkthrough: create a local marketplace')).toBe('walkthrough-create-a-local-marketplace')
    expect(slugifyHeading('Use the /config menu')).toBe('use-the-/config-menu')
    expect(slugifyHeading("Troubleshoot a setting that doesn't apply"))
      .toBe('troubleshoot-a-setting-that-doesn\u2019t-apply')
  })

  it('reads a `<span id>` anchor, which is where a rename leaves its old name', () => {
    // Missing these reported 27 citations of three LIVE anchors as dead — three
    // of the six pins this list ever held. The slug bug accounted for 3 more, so
    // 30 of the 32 pinned citations were the guard's own two defects.
    const page = ['## Real', '', '<span id="old-name" />', '', '### Renamed section'].join('\n')
    expect(sectionSlugs(page)).toEqual(['real', 'old-name', 'renamed-section'])
  })

  it('reads a RAW HTML heading that declares its own id, at ANY level', () => {
    // The third anchor kind, and the third time missing a declared id reported a
    // LIVE anchor as dead. Witnesses on the pages this repo cites:
    // `permissions.md` `<h4 id="process-wrappers">`, `permission-modes.md`
    // `<h2 id="eliminate-prompts-with-auto-mode">`, `interactive-mode.md`
    // `<h3 id="make-ctrl-w-delete-back-to-whitespace">` — 64 across 97 pages.
    // Level is NOT filtered here: the page states the id rather than the renderer
    // deriving one from text, so there is nothing to guess.
    const page = [
      '## Markdown heading',
      '<h4 id="process-wrappers">',
      '  Wrappers',
      '</h4>',
      '<h1 id="declared-h1" class="x">One</h1>',
      '<h5 id="declared-h5">Five</h5>',
    ].join('\n')
    expect(sectionSlugs(page)).toEqual([
      'markdown-heading', 'process-wrappers', 'declared-h1', 'declared-h5',
    ])
  })

  it('does not mint an anchor from a `<Tab title>` — derived text, and they repeat', () => {
    // Measured: `<Tab title="Top-level decision">` IS a rendered id on `hooks.md`,
    // and 111 tab titles sit across these pages. Left out on purpose — a wrong slug
    // in the snapshot lets the guard bless a dead citation, and duplicate titles take
    // a numeric suffix no slug rule predicts. Missing one only over-reports.
    expect(sectionSlugs('<Tab title="Top-level decision">')).toEqual([])
  })

  it('slugifies an `<Update label>`, the only anchor `changelog.md` has', () => {
    // That page has one markdown heading (an h1, which gets no id) and no declared
    // id, so `sectionSlugs` returned NOTHING for it — and a page with no rows is
    // indistinguishable from one never snapshotted, which is why one citation was
    // reported `page-not-snapshotted` in perpetuity. 380 labels, 380 rendered ids,
    // 380 distinct; admitted where `<Tab title>` is not precisely because they
    // cannot collide. Dotted labels hyphenate, the rule this guard once inverted.
    expect(sectionSlugs('<Update label="2.1.248" description="August 25, 2026">')).toEqual(['2-1-248'])
  })

  it('ignores a `#` inside a fenced block — a shell comment is not a section', () => {
    // `# Real` is absent for a second reason as well: an h1 gets no id (0/9
    // measured), so its slug is not a reachable anchor.
    const page = ['# Real', '', '```bash', '# not a heading', '```', '', '## Also real'].join('\n')
    expect(sectionSlugs(page)).toEqual(['also-real'])
  })

  it('snapshots only the heading levels the renderer gives an id', () => {
    // h2/h3/h4 → 666/666 present as a rendered id; h1 → 0/9; h5 → 3/24. A slug
    // in the snapshot that resolves to nothing would let the guard bless a dead
    // citation, so narrower is correct here rather than merely stricter.
    const page = ['# One', '## Two', '### Three', '#### Four', '##### Five', '###### Six'].join('\n')
    expect(sectionSlugs(page)).toEqual(['two', 'three', 'four'])
  })
})

describe('check-doc-anchors — the reference regex', () => {
  it('reads an anchor containing `/`, which `slugifyHeading` emits and the pages carry', () => {
    // The old class `[A-Za-z0-9_-]+` stopped at the slash and yielded `the-`, an
    // anchor no page carries — so the guard called a CORRECT citation dead. Six
    // distinct references in twelve places were being truncated this way, and
    // seven such slugs were already in the snapshot, reachable by `sectionSlugs`
    // and unreachable by this regex. `hooks.md` renders `id="the-/hooks-menu"`.
    const found = scanText('docs/x.md', 'see `hooks.md#the-/hooks-menu` for that', DEPS)
    expect(found.map(citation => citation.anchor)).toEqual(['the-/hooks-menu'])
  })

  it('reads the TYPOGRAPHIC apostrophe the renderer substitutes', () => {
    // `settings.md` renders `id="troubleshoot-a-setting-that-doesn’t-apply"`; the
    // old class truncated the citation to `…doesn`.
    const found = scanText('docs/x.md', '`settings.md#troubleshoot-a-setting-that-doesn\u2019t-apply`', DEPS)
    expect(found.map(citation => citation.anchor)).toEqual(['troubleshoot-a-setting-that-doesn\u2019t-apply'])
  })

  it('does not absorb a TRAILING slash — the boundary the widened class must hold', () => {
    // A `/` is allowed only BETWEEN segments. Without that, a plain citation
    // followed by a path separator would silently grow an anchor no page carries,
    // which is the same defect in the other direction.
    const found = scanText('docs/x.md', 'hooks.md#setup/ and hooks.md#setup)', DEPS)
    expect(found.map(citation => citation.anchor)).toEqual(['setup', 'setup'])
  })
})

describe('check-doc-anchors — classification', () => {
  it('sorts each reference into the world it belongs to', () => {
    const deps = DEPS
    expect(classify('hooks.md#setup', 'docs/x.md', deps).bucket).toBe('corpus')
    // The full-URL form of a corpus page, which this repo also uses.
    expect(classify('https://code.claude.com/docs/en/hooks.md#setup', 'docs/x.md', deps)).toEqual({
      page: 'hooks', anchor: 'setup', bucket: 'corpus',
    })
    // A repo-relative link resolved against the CITING file's directory.
    expect(classify('./beside.md#color-format', 'docs/sub/x.md', deps).bucket).toBe('in-repo')
    expect(classify('repo://docs/real.md#p13', 'packages/y.json', deps).bucket).toBe('in-repo')
    expect(classify('github.com/openai/plugins/README.md#logging', 'docs/x.md', deps).bucket).toBe('third-party')
    // Neither a corpus page nor a file here: the "left the index" shape.
    expect(classify('slash-commands.md#builtin', 'docs/x.md', deps).bucket).toBe('unresolved')
  })
})

describe('check-doc-anchors — it fires', () => {
  it('reports an anchor that is not a section of the page', () => {
    const audit = auditAnchors(cite('see `hooks.md#setpu` for that'), TINY, [])
    expect(audit.findings.map(finding => [finding.kind, finding.subject])).toEqual([
      ['anchor-not-a-section', 'hooks.md#setpu'],
    ])
    expect(audit.verified).toBe(0)
  })

  it('accepts the same citation once the anchor is a real section', () => {
    const audit = auditAnchors(cite('see `hooks.md#setup` for that'), TINY, [])
    expect(audit.findings).toEqual([])
    expect(audit.verified).toBe(1)
  })

  it('reports 18 copies of one dead anchor as ONE thing to fix', () => {
    const audit = auditAnchors(cite(Array.from({ length: 18 }, () => 'hooks.md#setpu').join(' ')), TINY, [])
    expect(audit.findings.length).toBe(1)
  })

  it('reports a page that is in no corpus and is no file here', () => {
    const audit = auditAnchors(cite('`slash-commands.md#builtin`'), TINY, [])
    expect(audit.findings.map(finding => [finding.kind, finding.subject])).toEqual([
      ['page-not-in-corpus', 'slash-commands.md#builtin'],
    ])
  })

  it('reports a corpus page whose sections were never snapshotted', () => {
    const audit = auditAnchors(cite('`sandboxing.md#protected-paths`'), TINY, [])
    expect(audit.findings.map(finding => [finding.kind, finding.subject])).toEqual([
      ['page-not-snapshotted', 'sandboxing.md'],
    ])
  })

  it('leaves a pinned-dead pair quiet, and counts it out loud', () => {
    const pinned = [{ page: 'hooks.md', anchor: 'setpu', liveInstead: 'hooks.md#setup', note: 'held elsewhere' }]
    const audit = auditAnchors(cite('`hooks.md#setpu`'), TINY, pinned)
    expect(audit.findings).toEqual([])
    expect(audit.pinned).toBe(1)
    expect(audit.verified).toBe(0)
  })

  it('reports a pin the snapshot has outlived — in both directions', () => {
    const nowLive = auditAnchors(
      cite('`hooks.md#setup`'),
      TINY,
      [{ page: 'hooks.md', anchor: 'setup', liveInstead: 'itself', note: 'stale pin' }],
    )
    expect(nowLive.findings.map(finding => finding.kind)).toEqual(['pinned-anchor-now-live'])

    const uncited = auditAnchors(
      cite('`hooks.md#setup`'),
      TINY,
      [{ page: 'hooks.md', anchor: 'setpu', liveInstead: 'hooks.md#setup', note: 'fixed already' }],
    )
    expect(uncited.findings.map(finding => finding.kind)).toEqual(['pinned-dead-anchor-gone'])
  })

  it('pins nothing, and still enforces the shape of a pin', () => {
    // The list is EMPTY as of P2.183 and the exact length is asserted so it
    // cannot grow quietly: four of the six it once held were this guard's own
    // bugs, and the other two were one-token citation fixes.
    expect(PINNED_DEAD).toEqual([])
    for (const entry of PINNED_DEAD as PinnedDead[]) {
      expect(entry.liveInstead.length).toBeGreaterThan(10)
      // A pin without the file that carries it is a suppression, not a handover.
      expect(entry.note.length).toBeGreaterThan(60)
    }
  })

  it('counts the line and the file, so a finding can be walked to', () => {
    const citations = scanText('docs/x.md', ['one', 'two', '`hooks.md#setup`'].join('\n'), DEPS)
    expect(citations).toEqual([
      { file: 'docs/x.md', line: 3, raw: 'hooks.md#setup', page: 'hooks', anchor: 'setup', bucket: 'corpus' },
    ])
  })
})

/**
 * P2.376 — the mirror of the pinned-dead list: anchors that are LIVE on the
 * rendered page and that `sectionSlugs` cannot derive from the markdown.
 */
describe('known-live underivable anchors', () => {
  const entry = {
    page: 'hooks.md',
    anchor: 'top-level-decision',
    underivable: 'from a <Tab title>, which sectionSlugs declines',
    verified: 'rendered page, 2026-09-03',
  }

  it('a listed anchor counts as VERIFIED instead of being reported dead', () => {
    const without = auditAnchors(cite('`hooks.md#top-level-decision`'), TINY, [], [])
    expect(without.findings.map(finding => finding.kind)).toEqual(['anchor-not-a-section'])
    const withList = auditAnchors(cite('`hooks.md#top-level-decision`'), TINY, [], [entry])
    expect(withList.findings).toEqual([])
    expect(withList.verified).toBe(without.verified + 1)
  })

  it('an entry the snapshot can now derive, and one nothing cites, are both findings', () => {
    const derivable = auditAnchors(cite('`hooks.md#setup`'), TINY, [], [
      { ...entry, anchor: 'setup' },
    ])
    expect(derivable.findings.map(finding => finding.kind)).toContain('known-live-anchor-now-derivable')
    const uncited = auditAnchors(cite('`hooks.md#setup`'), TINY, [], [entry])
    expect(uncited.findings.map(finding => finding.kind)).toEqual(['known-live-anchor-uncited'])
  })

  it('the shipped list is short, and every entry records its rendered-page probe', () => {
    // The bar `PINNED_DEAD` sets, in the other direction: four of its six
    // historical entries would have died on one `curl`.
    expect(KNOWN_LIVE_UNDERIVABLE.length).toBeLessThanOrEqual(3)
    for (const listed of KNOWN_LIVE_UNDERIVABLE) {
      expect(listed.verified).toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(listed.verified.length).toBeGreaterThan(40)
      expect(listed.underivable.length).toBeGreaterThan(40)
    }
  })
})

/**
 * P6.680 — the three REPORT-SIDE properties. None of them changes what is checked,
 * so each is asserted against a synthetic file rather than against the tree: a
 * whole-tree run costs 5–18 minutes of wall for 1–2 s of CPU under fleet load,
 * which is the reason `--paths` exists at all.
 */
describe('check-doc-anchors — every citer, not the first (P6.680)', () => {
  /** The row's own acceptance case: one dead anchor, cited three times. */
  const THREE = ['`hooks.md#setpu` here', 'nothing', 'and `hooks.md#setpu` again', '`hooks.md#setpu`'].join('\n')

  it('names ALL THREE citers of one dead anchor, in scan order', () => {
    const audit = auditAnchors(scanText('docs/three.md', THREE, DEPS), TINY, [])
    expect(audit.findings.length).toBe(1)
    // By identity, not by "the message mentions something": the previous shape
    // named the FIRST site and read like a census of them — W7-ah enumerated six
    // sites from it and there were eight.
    expect(audit.findings[0]?.sites).toEqual(['docs/three.md:1', 'docs/three.md:3', 'docs/three.md:4'])
    for (const site of ['docs/three.md:1', 'docs/three.md:3', 'docs/three.md:4']) {
      expect(audit.findings[0]?.detail).toContain(site)
    }
    // The sentence that stops the next lane fixing one site and expecting green.
    expect(audit.findings[0]?.detail).toContain('FIXING ONE SITE DOES NOT CLEAR')
  })

  it('summarises past MAX_LISTED_SITES instead of burying the other findings', () => {
    const many = Array.from({ length: MAX_LISTED_SITES + 5 }, () => '`hooks.md#setpu`').join('\n')
    const audit = auditAnchors(scanText('docs/many.md', many, DEPS), TINY, [])
    expect(audit.findings[0]?.sites.length).toBe(MAX_LISTED_SITES + 5)
    expect(audit.findings[0]?.detail).toContain('… and 5 more')
  })

  it('lists every citer of a page-not-in-corpus and of a page-not-snapshotted too', () => {
    const corpusless = auditAnchors(
      scanText('docs/a.md', '`slash-commands.md#builtin`\n`slash-commands.md#builtin`', DEPS),
      TINY,
      [],
    )
    expect(corpusless.findings.map(finding => [finding.kind, finding.sites])).toEqual([
      ['page-not-in-corpus', ['docs/a.md:1', 'docs/a.md:2']],
    ])
    // Keyed on the PAGE, so two different anchors of one unsnapshotted page stay
    // one finding — and both sites are still named.
    const unsnapshotted = auditAnchors(
      scanText('docs/b.md', '`sandboxing.md#one`\n`sandboxing.md#two`', DEPS),
      TINY,
      [],
    )
    expect(unsnapshotted.findings.map(finding => [finding.kind, finding.subject, finding.sites])).toEqual([
      ['page-not-snapshotted', 'sandboxing.md', ['docs/b.md:1', 'docs/b.md:2']],
    ])
  })

  it('gives the list-shaped findings an empty site list rather than a fake one', () => {
    const uncited = auditAnchors(cite('`hooks.md#setup`'), TINY, [], [
      { page: 'hooks.md', anchor: 'top-level-decision', underivable: 'x', verified: 'y' },
    ])
    expect(uncited.findings.map(finding => [finding.kind, finding.sites])).toEqual([
      ['known-live-anchor-uncited', []],
    ])
  })
})

describe('check-doc-anchors — findings by citing file (C3.338)', () => {
  it('re-keys the same findings by file, with the line to walk to', () => {
    // Two anchors, three sites, two files — the shape a lane repairing one of
    // them has: the per-anchor block cannot say what is left in ONE file.
    const audit = auditAnchors([
      ...scanText('docs/a.md', '`hooks.md#setpu`\n`hooks.md#setpu`', DEPS),
      ...scanText('docs/b.md', '`slash-commands.md#builtin`', DEPS),
    ], TINY, [])

    expect(findingsByCitingFile(audit.findings)).toEqual({
      'docs/a.md': ['1  [anchor-not-a-section] hooks.md#setpu', '2  [anchor-not-a-section] hooks.md#setpu'],
      'docs/b.md': ['1  [page-not-in-corpus] slash-commands.md#builtin'],
    })
  })

  it('sorts a file\'s rows by LINE NUMBER, not by the string that spells it', () => {
    // The bug a string sort gives for free: `'10' < '2'`, so a reader walking the
    // file top to bottom would be sent backwards. Lines 2 and 10 are the cheapest
    // pair where the two orders disagree.
    const lines = Array.from({ length: 10 }, (_, index) => (index === 1 || index === 9 ? '`hooks.md#setpu`' : 'x'))
    const audit = auditAnchors(scanText('docs/n.md', lines.join('\n'), DEPS), TINY, [])

    expect(findingsByCitingFile(audit.findings)['docs/n.md']?.map(row => row.split(' ')[0]))
      .toEqual(['2', '10'])
  })

  it('gives a finding with no citing site a NAMED bucket rather than dropping it', () => {
    // The pinned/known-live list entries have no site to walk to. An empty-string
    // key would read as a bug in the grouping, and dropping them would hide two
    // whole finding kinds from the assertion the live tree runs.
    const uncited = auditAnchors(cite('`hooks.md#setup`'), TINY, [], [
      { page: 'hooks.md', anchor: 'top-level-decision', underivable: 'x', verified: 'y' },
    ])

    expect(findingsByCitingFile(uncited.findings)).toEqual({
      [NO_CITING_SITE]: ['[known-live-anchor-uncited] hooks.md#top-level-decision'],
    })
  })

  it('is a VIEW: no finding is filtered out of it', () => {
    const audit = auditAnchors([
      ...scanText('docs/a.md', '`hooks.md#setpu`\n`hooks.md#setpu`', DEPS),
      ...scanText('docs/b.md', '`slash-commands.md#builtin`', DEPS),
    ], TINY, [])
    const rows = Object.values(findingsByCitingFile(audit.findings)).flat()

    // One row per SITE, and every finding named at least once.
    expect(rows).toHaveLength(audit.findings.reduce((sum, finding) => sum + Math.max(finding.sites.length, 1), 0))
    for (const finding of audit.findings) {
      expect(rows.some(row => row.includes(`[${finding.kind}] ${finding.subject}`))).toBe(true)
    }
  })

  it('is empty for an empty audit — the shape the live-tree assertion compares against', () => {
    expect(findingsByCitingFile([])).toEqual({})
  })
})

describe('check-doc-anchors — --paths scopes the scan (P6.680)', () => {
  it('reads a bare directory as everything under it, and a glob as itself', () => {
    const scripts = pathMatcher(['scripts'])
    expect(scripts('scripts/check-doc-anchors.ts')).toBe(true)
    expect(scripts('scripts/cdp/driver.ts')).toBe(true)
    expect(scripts('packages/shared/src/index.ts')).toBe(false)
    // A trailing slash is the other spelling a lane types.
    expect(pathMatcher(['scripts/'])('scripts/a.ts')).toBe(true)
    const globbed = pathMatcher(['docs/**/*.md'])
    expect(globbed('docs/a/b.md')).toBe(true)
    expect(globbed('docs/a/b.ts')).toBe(false)
    // Several globs are a union, not an intersection.
    const both = pathMatcher(['scripts', 'docs/**'])
    expect(both('scripts/x.ts')).toBe(true)
    expect(both('docs/y.md')).toBe(true)
    expect(both('apps/z.ts')).toBe(false)
  })

  it('parses the flag, and every later flag ends the list', () => {
    expect(parsePaths(['--paths', 'a', 'b'])).toEqual(['a', 'b'])
    expect(parsePaths(['--paths', 'a', '--refresh', 'b'])).toEqual(['a'])
    expect(parsePaths(['--refresh'])).toEqual([])
  })

  it('a scoped file list is a SUBSET of the whole-tree list, and non-empty', () => {
    // `repoFiles` is a `git ls-files` plus filters — it reads no file content, so
    // this costs nothing. The expensive part is the scan, which is what scoping
    // narrows: three concurrent whole-tree runs took 5–18 min of WALL for 1–2 s of
    // CPU at load 11–15.
    const all = repoFiles()
    const scoped = repoFiles(['scripts'])
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.length).toBeLessThan(all.length)
    expect(scoped.every(path => path.startsWith('scripts/'))).toBe(true)
    expect(new Set(all)).toEqual(new Set([...all, ...scoped]))
  })

  it('stands the two TOTALITY findings down when scoped, and nothing else', () => {
    // The false positives W7-ah named: both of these mean "nothing in the tree
    // cites this any more", which a subset cannot establish. Reporting them under
    // --paths would train readers to ignore the guard's two self-cleaning checks.
    const pinned = [{ page: 'hooks.md', anchor: 'setpu', liveInstead: 'hooks.md#setup', note: 'held elsewhere' }]
    const knownLive = [{ page: 'hooks.md', anchor: 'top-level-decision', underivable: 'x', verified: 'y' }]
    const citations = cite('`hooks.md#setup`')
    const whole = auditAnchors(citations, TINY, pinned, knownLive, false)
    expect(whole.findings.map(finding => finding.kind).sort()).toEqual([
      'known-live-anchor-uncited',
      'pinned-dead-anchor-gone',
    ])
    const scoped = auditAnchors(citations, TINY, pinned, knownLive, true)
    expect(scoped.findings).toEqual([])
    // A real defect is reported identically in both modes — scoping narrows the
    // input, never the checks.
    const dead = cite('`hooks.md#setpu`')
    expect(auditAnchors(dead, TINY, [], [], true).findings.map(finding => finding.kind)).toEqual([
      'anchor-not-a-section',
    ])
  })
})

describe('check-doc-anchors — the marked-placeholder escape (P6.680)', () => {
  it('skips a citation-shaped placeholder on a marked line, and COUNTS it', () => {
    const text = [
      `an example of the shape: \`hooks.md#setpu\`  ${PLACEHOLDER_MARKER}`,
      'a real one: `hooks.md#setpu`',
    ].join('\n')
    const audit = auditAnchors(scanText('docs/p.md', text, DEPS), TINY, [])
    expect(audit.placeholders).toBe(1)
    // The unmarked citation on the next line is still a finding, and its site list
    // names ONLY the real one — the whole point of a per-occurrence escape rather
    // than a wider SELF, which would have blinded the guard to this line too.
    expect(audit.findings.map(finding => [finding.kind, finding.sites])).toEqual([
      ['anchor-not-a-section', ['docs/p.md:2']],
    ])
  })

  it('marks the citation rather than dropping it, so the count cannot be silent', () => {
    const [marked] = scanText('docs/p.md', `\`hooks.md#setpu\` ${PLACEHOLDER_MARKER}`, DEPS)
    expect(marked?.placeholder).toBe(true)
    const [plain] = scanText('docs/p.md', '`hooks.md#setpu`', DEPS)
    expect(plain?.placeholder).toBeUndefined()
  })

  it('a LIVE anchor on a marked line is not counted as verified either', () => {
    // It is not a citation at all. Counting it would let a placeholder inflate the
    // "verified" floor the live-tree test asserts against.
    const audit = auditAnchors(scanText('docs/p.md', `\`hooks.md#setup\` ${PLACEHOLDER_MARKER}`, DEPS), TINY, [])
    expect(audit.verified).toBe(0)
    expect(audit.placeholders).toBe(1)
    expect(audit.perBucket.corpus).toBe(0)
  })

  it('the marker cannot create the finding it suppresses', () => {
    // It carries no `.md#`, so writing it is never itself a citation.
    expect(PLACEHOLDER_MARKER).not.toContain('.md#')
  })
})

/**
 * The git-grep prefilter (`P6.680`). It is an OPTIMISATION and must be provably
 * incapable of changing an answer, so what is asserted here is the property, not
 * the mechanism: a file the `includes('.md#')` guard would keep is scanned, and a
 * file it would discard produces nothing either way.
 *
 * The race the prefilter introduces — a citation written after the candidate list
 * was taken — is closed by a second `git grep` over the delta and is documented at
 * `scanFiles`. It cannot be asserted here without a concurrent writer, and a test
 * that pretends to prove it would be worse than this comment.
 */
describe('check-doc-anchors — the prefilter cannot change an answer (P6.680)', () => {
  it('scans a real file that contains a citation, and nothing for one that does not', () => {
    // This test file is excluded from the repo scan (`SELF`) but not from an
    // explicit list, so it doubles as a fixture that certainly contains `.md#`.
    const withCitations = collectCitations(['scripts/check-doc-anchors.test.ts'])
    expect(withCitations.length).toBeGreaterThan(0)
    // `.gitignore` is tracked, is in the scan's extension set for neither reason
    // nor accident, and carries no citation: the prefilter and the `includes`
    // guard must agree on it.
    expect(collectCitations(['package.json']).length).toBe(0)
  })

  it('agrees with the includes() guard file by file, over a real directory', () => {
    // The property in full, on a bounded scope so it costs seconds rather than
    // minutes: for every file listed, having a citation and being scanned are the
    // same thing. A prefilter that dropped one would show up here as a file with
    // citations in the text and none in the result.
    const files = repoFiles(['scripts'])
    expect(files.length).toBeGreaterThan(0)
    const scanned = new Set(collectCitations(files).map(citation => citation.file))
    // The control that keeps the oracle below from agreeing with an empty scan.
    expect(scanned.size).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(resolve(import.meta.dir, '..', file), 'utf-8')
      // The oracle is the scan's own path with the prefilter taken out — the
      // includes() guard, then `scanText` — not `includes('.md#')` alone: a `.md#`
      // the reference regex does not read passes the guard and yields no citation.
      // F1.1171's `./permissions.md#…` fixture in check-docs-site-build.test.ts is
      // one (a Cyrillic in-site anchor, outside this guard's corpus), and calling
      // it "dropped" sent the scripts chunk red over a file the prefilter KEPT.
      const unfiltered = text.includes('.md#') && scanText(file, text, DEPS).length > 0
      expect(scanned.has(file), `${file}: text and scan disagree`).toBe(unfiltered)
    }
    // Sized against the measured floor, not zero: reading `scripts/` alone cost
    // 40.3 s at load 12 on 2026-09-07 and this body reads it twice.
  }, REPO_SCAN_TIMEOUT_MS)
})

describe('check-doc-anchors — --refresh names what it DROPPED (F1.1223)', () => {
  // A page leaves the snapshot when its last anchored citer goes (agent-sdk/hooks
  // on 2026-10-01), and the rewrite used to say nothing about it: the report only
  // walked the pages it fetched. Pure input, so this needs no network.
  const before = new Map([
    ['hooks', new Set(['setup', 'precompact'])],
    ['agent-sdk/hooks', new Set(['hook-events', 'matchers'])],
  ])

  it('lists a page in the old snapshot that the refresh no longer fetches, with its section count', () => {
    const lines = refreshReport(before, new Map([['hooks', ['setup', 'precompact']]]))
    expect(lines).toContain('  agent-sdk/hooks.md — DROPPED from the snapshot (no anchored citation left), 2 sections')
  })

  it('CONTROL: a refresh that fetches every page drops nothing, and an unchanged page still reads unchanged', () => {
    const lines = refreshReport(before, new Map([
      ['hooks', ['setup', 'precompact']],
      ['agent-sdk/hooks', ['hook-events', 'matchers']],
    ]))
    expect(lines.some(line => line.includes('DROPPED'))).toBe(false)
    expect(lines).toContain('  hooks.md — 2 sections, unchanged')
  })
})
