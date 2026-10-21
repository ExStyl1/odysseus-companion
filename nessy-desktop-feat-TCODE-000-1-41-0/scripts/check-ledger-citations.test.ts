import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import {
  admitsBareNames,
  anchorBaselineKey,
  attachedAnchor,
  attachedIdentifier,
  attachedRowId,
  attachedSymbol,
  buildBasenameIndex,
  candidatesForBasenames,
  checkCountProbe,
  collectBareNameCitations,
  collectCitations,
  collectCountProbes,
  countIsWrong,
  countsPerFile,
  controlScopeBaselineKey,
  countLines,
  countOccurrences,
  countLineShorthands,
  deadLineBaselineKey,
  deadPathBaselineKey,
  escapedAlternationBaselineKey,
  findAmbiguousAnchorCitations,
  findDeadCitations,
  findControlScopeMismatches,
  findDeadLineCitations,
  findEscapedAlternationProbes,
  findAbsentSymbolCitations,
  findDriftedIdentifierCitations,
  findRowIdCitations,
  findSplitRowIds,
  identifierBaselineKey,
  isUnattachedLineCitation,
  planFindingCensus,
  ratchetVerdict,
  rowAnchorLine,
  rowBaselineKey,
  splitRowIdBaselineKey,
  symbolBaselineKey,
  symbolOccurs,
  listsFileNames,
  parseGrepCountProbe,
  pathUnderPathspec,
  pathspecRoot,
  probeScope,
  readBaseline,
  readIndexBlobs,
  splitProbeArgv,
  unquotedShellMetachar,
  withCachedFlag,
  wrappedContext,
  EXCLUDED_ROOTS,
  LEDGERS,
  PINNED_PLAN_FINDINGS,
  PLAN_DOC,
  REPO_ROOT,
  onDiskSpellings,
  trackedFiles,
  unattachedCensus,
  unreachableCitations,
  PINNED_SHORTHAND,
  PINNED_UNATTACHED_BARE,
  PINNED_UNATTACHED_PATH,
  PIN_FILE,
  pinRaiseRefusal,
  planPins,
  rewritePinnedConstants,
  rewritePinsInFile,
} from './check-ledger-citations'
import { GateSafetyRefusal } from './gate-safety'
import type { Citation, CountProbe } from './check-ledger-citations'

const ROOTS = new Set(['packages', 'apps', 'docs', 'scripts', '.claude'])

describe('collectCitations', () => {
  it('takes a repo-file citation with and without a line tail, and keeps the path half', () => {
    const found = collectCitations('l.md', [
      'the reader is `packages/shared/src/mcp/server-status.ts:132` and the panel',
      'is apps/electron/src/renderer/components/app-shell/McpServersPanel.tsx today.',
    ].join('\n'), ROOTS)

    expect(found.map(c => c.text)).toEqual([
      'packages/shared/src/mcp/server-status.ts:132',
      'apps/electron/src/renderer/components/app-shell/McpServersPanel.tsx',
    ])
    expect(found[0]?.path).toBe('packages/shared/src/mcp/server-status.ts')
    expect(found[0]?.line).toBe(1)
    expect(found[1]?.line).toBe(2)
  })

  it('leaves alone everything that is path-shaped and is not a citation of this repo', () => {
    // The four ways a token can look like one and not be one. Each is a
    // measured source of noise, and a guard that cries wolf stops being run.
    const found = collectCitations('l.md', [
      'source: https://github.com/openai/codex/blob/main/codex-rs/core/src/lib.rs',
      'the page is settings-reference.md and the manifest is codex-rs/mcp/Cargo.toml',
      'elided as apps/electron/src/renderer/.../SessionGoalBadge.tsx in prose',
      'the runtime reads .claude/settings.json on the user machine',
    ].join('\n'), ROOTS)

    expect(found).toEqual([])
    expect(EXCLUDED_ROOTS).toContain('.claude')
  })
})

/**
 * P6.1061 — a citation pair wrapped across a line break used to be no citation
 * at all, and the gate reported a SMALLER NUMBER instead of a finding.
 *
 * Measured by W11-w (2026-09-11): four pairs it had written across line breaks
 * left the symbol census at 1 849, and re-wrapping them onto single lines moved
 * it to 1 853. Nothing went red — which is the hazard, because a census that
 * quietly stops counting looks exactly like a corpus that has no such cells.
 */
describe('a citation pair wrapped across one line break (P6.1061)', () => {
  const symbolOf = (doc: string) => {
    const [citation] = collectCitations('l.md', doc, ROOTS)
    expect(citation, 'the fixture itself yielded no citation').toBeDefined()
    return attachedSymbol(citation!.before, citation!.after)
  }

  it('reads the symbol when the PATH ends a line and `symbol `Name`` opens the next', () => {
    expect(symbolOf([
      'the host switch lives in `packages/shared/src/config/bundled-skills-settings.ts`',
      'symbol `disableBundledSkills`, and codex projects none of it.',
    ].join('\n'))).toBe('disableBundledSkills')
  })

  it('reads it in the other direction too — the `Name` symbol of ends a line, the path opens the next', () => {
    expect(symbolOf([
      'the projection is the `buildClaudeSubprocessEnv` symbol of',
      '`packages/shared/src/agent/options.ts`, which the host owns directly.',
    ].join('\n'))).toBe('buildClaudeSubprocessEnv')
  })

  it('reads a wrapped identifier, which is the form measured in the committed docs', () => {
    const [citation] = collectCitations('l.md', [
      'the host switch exists with no codex projection: `packages/shared/src/config/bundled-skills-settings.ts`',
      '(`disableBundledSkills` / `NESSY_DISABLE_BUNDLED_SKILLS`). Codex keys are elsewhere.',
    ].join('\n'), ROOTS)
    expect(attachedIdentifier(citation!.after)).toBe('disableBundledSkills')
  })

  it('BOUNDARY — a BLANK line is where prose stops wrapping, so it is where this stops looking', () => {
    // `\s` matches a newline, so a widening with no blank-line condition would
    // pair a citation ending one paragraph with the identifier opening the next
    // — an attachment no author wrote.
    expect(symbolOf([
      'the host switch lives in `packages/shared/src/config/bundled-skills-settings.ts`',
      '',
      'symbol `disableBundledSkills`, and codex projects none of it.',
    ].join('\n'))).toBeUndefined()
  })

  it('BOUNDARY — a markdown table row does not pair with the next row', () => {
    // No special case is needed and none is written: a row begins with `|`,
    // which is not whitespace, so neither anchor can reach across it. This is
    // the case that says so rather than leaving it assumed.
    expect(symbolOf([
      '| the switch | `packages/shared/src/config/bundled-skills-settings.ts` |',
      '| symbol `disableBundledSkills` | absent |',
    ].join('\n'))).toBeUndefined()
  })

  it('the bare-name arm needs it TWICE, because there the symbol sentence is the ADMISSION rule', () => {
    const index = buildBasenameIndex(['packages/shared/src/config/bundled-skills-settings.ts'])
    const wrapped = collectBareNameCitations('l.md', [
      'the host switch lives in `bundled-skills-settings.ts`',
      'symbol `disableBundledSkills`, and codex projects none of it.',
    ].join('\n'), index)
    expect(wrapped.citations.map(citation => citation.path))
      .toEqual(['packages/shared/src/config/bundled-skills-settings.ts'])
    expect(attachedSymbol(wrapped.citations[0]!.before, wrapped.citations[0]!.after))
      .toBe('disableBundledSkills')

    // The control on the same rig: with a blank line between them the untailed
    // bare name opts into nothing and is not collected at all.
    const broken = collectBareNameCitations('l.md', [
      'the host switch lives in `bundled-skills-settings.ts`',
      '',
      'symbol `disableBundledSkills`, and codex projects none of it.',
    ].join('\n'), index)
    expect(broken.citations).toEqual([])
  })

  it('wrappedContext joins ONE neighbour each way, and neither when they are blank', () => {
    const lines = ['above', 'the `x` line', 'below']
    expect(wrappedContext(lines, 1, 'the ', ' line')).toEqual({
      before: 'above\nthe ',
      after: ' line\nbelow',
    })
    expect(wrappedContext(['', 'the `x` line', '   '], 1, 'the ', ' line')).toEqual({
      before: 'the ',
      after: ' line',
    })
    // First and last line: there is no neighbour to join, and asking for one
    // must not produce an `undefined` that reads as text.
    expect(wrappedContext(['only'], 0, 'a', 'b')).toEqual({ before: 'a', after: 'b' })
  })
})

describe('findDeadCitations', () => {
  const tracked = new Set([
    'packages/shared/src/agent/pi-harness/managed-policy.ts',
    'packages/shared/src/mcp/server-status.ts',
  ])

  it('reports a citation whose file moved, and names where the basename is tracked now', () => {
    const citations = collectCitations('l.md', 'see `packages/shared/src/config/managed-policy.ts:503` for it', ROOTS)
    const findings = findDeadCitations(citations, tracked)

    expect(findings).toHaveLength(1)
    const finding = findings[0]!
    expect(finding.citation.path).toBe('packages/shared/src/config/managed-policy.ts')
    expect(finding.elsewhere).toEqual(['packages/shared/src/agent/pi-harness/managed-policy.ts'])
  })

  it('says nothing about a citation that still resolves — the control for the case above', () => {
    const citations = collectCitations('l.md', 'see `packages/shared/src/mcp/server-status.ts:132` for it', ROOTS)
    expect(citations).toHaveLength(1)
    expect(findDeadCitations(citations, tracked)).toEqual([])
  })
})

describe('collectBareNameCitations (P6.956)', () => {
  // One tracked file per unique name, two sharing `index.ts`, and a markdown
  // page whose basename this tree also tracks — the `skills.md` shape that made
  // the markdown rule a measurement rather than a caution.
  const index = buildBasenameIndex([
    'packages/shared/src/sole.ts',
    'packages/a/index.ts',
    'packages/b/index.ts',
    'apps/electron/resources/docs/skills.md',
    '.claude/settings.json',
  ])

  it('admits a name exactly one tracked file carries, and keeps what the cell wrote', () => {
    const found = collectBareNameCitations('l.md', 'the guard at sole.ts:12 does it', index)

    expect(found.citations).toHaveLength(1)
    expect(found.citations[0]?.path).toBe('packages/shared/src/sole.ts')
    // The resolved citation is what a baseline key and every later check read;
    // `written` is what the reader will actually find in the cell.
    expect(found.citations[0]?.text).toBe('packages/shared/src/sole.ts:12')
    expect(found.citations[0]?.written).toBe('sole.ts:12')
    expect(found.citations[0]?.after).toBe(' does it')
  })

  it('reports the ambiguous and the unmatched as UNCHECKED rather than guessing', () => {
    const found = collectBareNameCitations('l.md', 'see index.ts:4 and gone-P6956.ts:9 for it', index)

    expect(found.citations).toEqual([])
    expect(found.ambiguous).toBe(1)
    expect(found.unmatched).toBe(1)
  })

  it('skips a markdown page name even when this tree tracks one — the measured case', () => {
    // `skills.md:122` in these documents is the VENDOR page (`skills` and
    // `agent-sdk/skills` are both in scripts/claude-doc-pages.tsv); resolving it
    // to our own tracked `skills.md` would check a vendor line number against an
    // unrelated file and report the mismatch with total confidence.
    const found = collectBareNameCitations('l.md', 'the page at skills.md:122 says so', index)

    expect(found.citations).toEqual([])
    expect(found.markdown).toBe(1)
  })

  it('never reads the tail of a longer path — or of a URL — as a bare name', () => {
    // The same guard the path form uses. Without it every full-path citation
    // would be collected a second time under its own basename.
    expect(collectBareNameCitations('l.md', 'see packages/shared/src/sole.ts:12 for it', index).citations)
      .toEqual([])
    expect(collectBareNameCitations('l.md', 'https://example.test/docs/sole.ts:12', index).citations)
      .toEqual([])
  })

  it('keeps the excluded roots excluded, whichever form names them', () => {
    expect(collectBareNameCitations('l.md', 'see settings.json:3 for it', index).citations).toEqual([])
  })

  it('needs a line tail OR a symbol word: a bare name claiming neither is not a citation', () => {
    expect(collectBareNameCitations('l.md', 'see sole.ts for it', index).citations).toEqual([])
    // And it is not counted as unmatched or ambiguous either. With the tail
    // optional the pattern also matches every version number and `node.js` in
    // the prose, so a census fed by them would say nothing.
    const noisy = collectBareNameCitations('l.md', 'codex 0.148.0 on node.js, see index.ts and sole.ts', index)
    expect(noisy.citations).toEqual([])
    expect(noisy.unmatched).toBe(0)
    expect(noisy.ambiguous).toBe(0)
  })

  it('admits the TAIL-LESS bare name whose sentence names a symbol — P6.953', () => {
    // The intersection of P6.956 and P6.957, and the form a converting lane
    // writes. Before this branch it was collected by neither pass, so dropping a
    // line tail dropped the citation out of the gate altogether.
    const found = collectBareNameCitations('l.md', 'wired at `sole.ts` symbol `budgetExhausted` today', index)

    expect(found.citations).toHaveLength(1)
    expect(found.citations[0]?.path).toBe('packages/shared/src/sole.ts')
    // No tail, so the resolved citation is the bare path — nothing for the
    // line/EOF arm to read, and the symbol arm reads the whole file.
    expect(found.citations[0]?.text).toBe('packages/shared/src/sole.ts')
    expect(found.citations[0]?.written).toBe('sole.ts')
    expect(attachedSymbol(found.citations[0]?.before ?? '', found.citations[0]?.after ?? ''))
      .toBe('budgetExhausted')
  })

  it('applies the SAME markdown and ambiguity rules to the tail-less form', () => {
    // A widening that skipped them would resolve a vendor page name against one
    // of our own files — the measured `skills.md` trap, one form over.
    const md = collectBareNameCitations('l.md', 'the page `skills.md` symbol `frontmatter` says so', index)
    expect(md.citations).toEqual([])
    expect(md.markdown).toBe(1)

    const amb = collectBareNameCitations('l.md', 'see `index.ts` symbol `start` for it', index)
    expect(amb.citations).toEqual([])
    expect(amb.ambiguous).toBe(1)
  })

  it('is admitted everywhere now that every finding has an owner (P6.964)', () => {
    // The plan was excluded while its findings had no repairer (measured
    // 2026-09-09: 73 findings over a census of 119). Since P6.954 the controller
    // repairs plan findings at pin time and PINNED_PLAN_FINDINGS ratchets the
    // count, so the admission was widened on 2026-09-10 — the census rose
    // 107 -> 177 with the pin raised in the same commit, the one legitimate raise.
    expect(admitsBareNames(PLAN_DOC)).toBe(true)
    for (const doc of LEDGERS) expect(admitsBareNames(doc)).toBe(true)
  })

  it('marks an ambiguous basename with null rather than dropping it', () => {
    const built = buildBasenameIndex(['a/x.ts', 'b/x.ts', 'c/y.ts'])
    expect(built.get('x.ts')).toBeNull()
    expect(built.get('y.ts')).toBe('c/y.ts')
    expect(built.has('z.ts')).toBe(false)
  })

  it('lets a ROOT-LEVEL file win its basename bucket, in either order — P6.996', () => {
    // `package.json` is 18 tracked files; the root one cannot be written any wider
    // than its bare name, so a bare `package.json` resolves to it rather than to null.
    expect(buildBasenameIndex(['apps/cli/package.json', 'package.json', 'apps/electron/package.json']).get('package.json'))
      .toBe('package.json')
    expect(buildBasenameIndex(['package.json', 'apps/cli/package.json']).get('package.json')).toBe('package.json')
    // A bucket with no root member stays ambiguous, as before.
    expect(buildBasenameIndex(['a/x.ts', 'b/x.ts']).get('x.ts')).toBeNull()
  })

  it('NAMES each ambiguous citation by basename and citing line — P6.969', () => {
    // The measured case: a second mention written as a shared basename moved the
    // count and named nothing, so the lane that wrote it had to bisect its own
    // commit to find the two cells that had stopped being checked.
    const found = collectBareNameCitations(
      'l.md',
      'see index.ts:4 for it\nand `index.ts` symbol `start`, plus sole.ts:9',
      index,
    )

    expect(found.citations).toHaveLength(1)
    expect(found.ambiguousSites).toEqual([
      { name: 'index.ts', doc: 'l.md', line: 1 },
      { name: 'index.ts', doc: 'l.md', line: 2 },
    ])
    // The count is DERIVED from the sites, so the summary line and the named
    // list cannot disagree about how many there were.
    expect(found.ambiguous).toBe(found.ambiguousSites.length)
  })

  it('leaves the sites empty when nothing was ambiguous — the negative arm', () => {
    const found = collectBareNameCitations('l.md', 'the guard at sole.ts:12 does it', index)
    expect(found.ambiguousSites).toEqual([])
    expect(found.ambiguous).toBe(0)
  })
})

describe('candidatesForBasenames (P6.969)', () => {
  it('returns the tracked files behind each cited name, sorted, and only those names', () => {
    const found = candidatesForBasenames(
      ['b/x.ts', 'a/x.ts', 'c/y.ts', 'd/unasked.ts'],
      ['x.ts', 'y.ts'],
    )

    expect(found.get('x.ts')).toEqual(['a/x.ts', 'b/x.ts'])
    expect(found.get('y.ts')).toEqual(['c/y.ts'])
    // The tree holds hundreds of duplicated basenames; a run pays only for the
    // ones a document actually cited.
    expect(found.has('unasked.ts')).toBe(false)
  })

  it('answers with an empty list for a name no tracked file carries', () => {
    // The guard never asks this — an unmatched name is a different bucket — but
    // an absent key would make the summary line print `undefined` candidates.
    expect(candidatesForBasenames(['a/x.ts'], ['gone.ts']).get('gone.ts')).toEqual([])
  })
})

describe('findDeadLineCitations', () => {
  // Four lines, and line 3 is the blank one. The file deliberately ends with a
  // newline, because a trailing newline is not a fifth line and an off-by-one
  // there would make every last-line citation read as past EOF.
  const file = 'const a = 1\nconst b = 2\n\nconst c = 3\n'
  const contents = new Map([['packages/shared/src/x.ts', file]])
  const ROOTS_X = new Set(['packages'])

  const findOne = (text: string) =>
    findDeadLineCitations(collectCitations('l.md', `see \`${text}\` for it`, ROOTS_X), contents)

  it('reports a citation that lands on a blank line — the positive control', () => {
    // P6.887's own subject in miniature: `2026-08-28-codex-sweep-triage.md:2033`
    // was cited as a verdict by two documents and a lane brief, and the line is
    // empty. Nothing in the citation reads as wrong; only opening it does.
    const found = findOne('packages/shared/src/x.ts:3')

    expect(found).toHaveLength(1)
    expect(found[0]?.reason).toBe('blank')
    expect(found[0]?.lineCount).toBe(4)
    expect(found[0]?.citation.text).toBe('packages/shared/src/x.ts:3')
  })

  it('says nothing about a citation on a line that holds something — the negative control', () => {
    // Both edges, because an off-by-one at either end would pass the case above
    // and still make the guard useless: line 1 is the first line, line 4 the last.
    expect(findOne('packages/shared/src/x.ts:1')).toEqual([])
    expect(findOne('packages/shared/src/x.ts:4')).toEqual([])
    expect(findOne('packages/shared/src/x.ts:1-4')).toEqual([])
  })

  it('reports a line past the end of the file, and a range that ends past it', () => {
    expect(findOne('packages/shared/src/x.ts:5')[0]?.reason).toBe('past-eof')
    expect(findOne('packages/shared/src/x.ts:1-46')[0]?.reason).toBe('range-end-past-eof')
  })

  it('treats a whitespace-only line as blank — a reader lands on nothing either way', () => {
    const indented = new Map([['packages/shared/src/x.ts', 'a\n   \nb\n']])
    const citations = collectCitations('l.md', 'see `packages/shared/src/x.ts:2` for it', ROOTS_X)
    expect(findDeadLineCitations(citations, indented)[0]?.reason).toBe('blank')
  })

  it('skips a citation with no line tail, and one whose file was never read', () => {
    // The second is the anti-double-report rule: a dead PATH is already reported
    // by findDeadCitations, and its content is deliberately never fetched.
    expect(findOne('packages/shared/src/x.ts')).toEqual([])
    expect(findOne('packages/shared/src/gone.ts:9')).toEqual([])
  })

  it('counts lines with and without a trailing newline the same way', () => {
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('')).toBe(0)
  })
})

describe('findDriftedIdentifierCitations (P6.891)', () => {
  // Twelve lines. `wanted` is on line 2 and nowhere else, so a citation of any
  // line from 1 to 7 finds it within the +-5 radius and one of line 8 does not.
  const file = ['zero', 'const wanted = 1', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
  const contents = new Map([['packages/shared/src/x.ts', file]])
  const ROOTS_X = new Set(['packages'])

  const findOne = (sentence: string) =>
    findDriftedIdentifierCitations(collectCitations('l.md', sentence, ROOTS_X), contents)

  it('reports an anchor whose named identifier is nowhere near it — the positive control', () => {
    // The shape all seven of this check's first findings had: the citation reads
    // fluently, the line is not blank, and the thing it names moved.
    const found = findOne('see `packages/shared/src/x.ts:9` `wanted` for it')

    expect(found).toHaveLength(1)
    expect(found[0]?.identifier).toBe('wanted')
    expect(found[0]?.from).toBe(4)
    expect(found[0]?.to).toBe(12)
    expect(found[0]?.citation.text).toBe('packages/shared/src/x.ts:9')
  })

  it('says nothing when the identifier is inside the window — the negative control', () => {
    // Both edges of the radius: line 7 is exactly five below `wanted`, and a
    // range whose START is far away but whose END reaches back is also fine.
    expect(findOne('see `packages/shared/src/x.ts:7` `wanted` for it')).toEqual([])
    expect(findOne('see `packages/shared/src/x.ts:2` `wanted` for it')).toEqual([])
  })

  it('does not read the next SENTENCE as this citation’s identifier', () => {
    // The one false positive the hand-check found: a full stop between the two
    // means the identifier belongs to something else. Without this rule the
    // guard charges a correct cell with a defect.
    expect(findOne('see `packages/shared/src/x.ts:9`. `wanted` renders the row')).toEqual([])
  })

  it('opts out of every citation that names no identifier, rather than passing it', () => {
    // The whole design: silence here is "not checked", and the summary line says
    // how many opted in so that silence cannot be read as assurance.
    expect(findOne('see `packages/shared/src/x.ts:9` for it')).toEqual([])
    expect(findOne('see `packages/shared/src/x.ts:9` `packages/shared/src/y.ts`')).toEqual([])
    expect(findOne('see `packages/shared/src/x.ts:9` `true`')).toEqual([])
  })

  it('skips what the blank/EOF check already reports, so one defect is one finding', () => {
    const blank = new Map([['packages/shared/src/x.ts', 'a\n\nb\n']])
    const citations = collectCitations('l.md', 'see `packages/shared/src/x.ts:2` `wanted` for it', ROOTS_X)
    expect(findDriftedIdentifierCitations(citations, blank)).toEqual([])
    expect(findOne('see `packages/shared/src/x.ts:99` `wanted` for it')).toEqual([])
  })

  it('reads the opt-in rule the way the header describes it', () => {
    expect(attachedIdentifier(' `wanted` for it')).toBe('wanted')
    expect(attachedIdentifier(' — `wanted`')).toBe('wanted')
    expect(attachedIdentifier('. `wanted` renders the row')).toBeUndefined()
    expect(attachedIdentifier(' for it, and `wanted` too')).toBeUndefined()
    expect(attachedIdentifier(' `x`')).toBeUndefined()
    expect(attachedIdentifier(' no identifier here')).toBeUndefined()
  })

  it('keys the baseline so an identifier finding cannot silence a dead-line one', () => {
    const found = findOne('see `packages/shared/src/x.ts:9` `wanted` for it')
    // `::` and not `#`: readBaseline strips a `#` and everything after it as a
    // comment, so a `#` key would read back as the bare `path:line` and silence
    // the dead-line entry form instead of recording this one.
    expect(identifierBaselineKey(found[0]!)).toBe('packages/shared/src/x.ts:9::wanted')
  })
})

describe('findRowIdCitations (P6.943)', () => {
  // The same geometry as the identifier fixture above, so the two arms can be
  // compared: twelve lines, and the subject — here the `K5` table row rather
  // than an identifier — on line 2.
  const ledger = [
    '# ledger',
    "| K5 | Watch a tool call's input arrive live | `absent` | `partial` |",
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
  ].join('\n')
  const contents = new Map([['docs/specs/ledger.md', ledger]])
  const ROOTS_D = new Set(['docs', 'packages'])

  const findOne = (sentence: string) =>
    findRowIdCitations(collectCitations('l.md', sentence, ROOTS_D), contents)

  it('reports a citation naming a row the cited document does not have — the positive control', () => {
    // The failure the durable form can still have: the row was renamed or
    // removed, so the sentence is false and no other arm of this gate looks.
    const found = findOne('Ledger context: the `F5` row of `docs/specs/ledger.md`.')

    expect(found).toHaveLength(1)
    expect(found[0]?.reason).toBe('missing')
    expect(found[0]?.rowId).toBe('F5')
    expect(found[0]?.rowLine).toBeUndefined()
  })

  it('reports a line-tailed citation whose row sits far from the line it cites', () => {
    // P6.943's own shape: the ledger grew, the number moved, the row did not.
    const found = findOne('Ledger context: the `K5` row of `docs/specs/ledger.md:9`.')

    expect(found).toHaveLength(1)
    expect(found[0]?.reason).toBe('far')
    expect(found[0]?.rowLine).toBe(2)
    expect(found[0]?.from).toBe(4)
    expect(found[0]?.to).toBe(12)
  })

  it('says nothing when the row is there — the negative control, both forms', () => {
    // No line tail at all is the form W9-bs converted two citations to, and it
    // must be silent whenever the row exists; and a cited line within the radius
    // of the row is the line-tailed negative.
    expect(findOne('Ledger context: the `K5` row of `docs/specs/ledger.md`.')).toEqual([])
    expect(findOne('Ledger context: the `K5` row of `docs/specs/ledger.md:7`.')).toEqual([])
  })

  it('opts out of everything that does not name a row, rather than passing it', () => {
    // Silence here is "not checked", exactly as with the identifier arm, and the
    // summary line prints how many opted in so it cannot be read as assurance.
    expect(findOne('see `docs/specs/ledger.md:9` for it')).toEqual([])
    expect(findOne('the `wanted` row of `docs/specs/ledger.md:9`')).toEqual([])
    expect(findOne('the `k5` row of `docs/specs/ledger.md:9`')).toEqual([])
    // A row id beside a SOURCE file is not a row id: only a markdown target has
    // table rows, and a `.ts` file full of hex would match a bare one.
    expect(findRowIdCitations(
      collectCitations('l.md', 'the `K5` row of `packages/shared/src/x.ts:9`', ROOTS_D),
      new Map([['packages/shared/src/x.ts', ledger]]),
    )).toEqual([])
  })

  it('skips what the blank/EOF check already reports, so one defect is one finding', () => {
    const blank = new Map([['docs/specs/ledger.md', ledger.replace('\nj', '\n   ')]])
    const citations = collectCitations('l.md', 'the `K5` row of `docs/specs/ledger.md:12`', ROOTS_D)
    expect(findRowIdCitations(citations, blank)).toEqual([])
    expect(findOne('the `K5` row of `docs/specs/ledger.md:99`')).toEqual([])
  })

  it('reads the opt-in rule off the text BEFORE the citation, the side the documents use', () => {
    expect(attachedRowId('Ledger context: the `K5` row of `')).toBe('K5')
    expect(attachedRowId('the `O5` row of ')).toBe('O5')
    expect(attachedRowId('the `P12` row of `')).toBe('P12')
    // A full stop in the gap means the row id belongs to the clause before.
    expect(attachedRowId('the `K5` row. See `')).toBeUndefined()
    // Too far away to be one sentence about one thing.
    expect(attachedRowId('the `K5` row, which is the one about live tool input, of `')).toBeUndefined()
    expect(attachedRowId('the `wanted` row of `')).toBeUndefined()
    expect(attachedRowId('the `k5` row of `')).toBeUndefined()
    expect(attachedRowId('no row id here at all `')).toBeUndefined()
  })

  it('resolves a row as the table row the ledgers write, not as a bare token', () => {
    // `K5` alone matches a hex byte, a spreadsheet cell and a version string;
    // the anchor is the row form, and it tolerates the leading whitespace and
    // padding a hand-edited table picks up.
    expect(rowAnchorLine(ledger.split('\n'), 'K5')).toBe(2)
    expect(rowAnchorLine(['  |K5| a |'], 'K5')).toBe(1)
    expect(rowAnchorLine(['the K5 row is elsewhere', '| K50 | a |'], 'K5')).toBeUndefined()
  })

  it('keys the baseline so a row finding cannot silence an identifier or a line one', () => {
    const found = findOne('the `K5` row of `docs/specs/ledger.md:9`')
    expect(rowBaselineKey(found[0]!)).toBe('docs/specs/ledger.md:9::row=K5')
  })

  // P6.948 — the plan writes the durable form the other way round and its ids
  // are neither two characters nor bare letters-and-digits. Each case below is a
  // shape this arm could not read on the day the plan was admitted to LEDGERS.
  it('reads the row id AFTER the citation, the side the plan writes', () => {
    expect(attachedRowId('done_means: `', '` row `H9` no longer states')).toBe('H9')
    expect(attachedRowId('Ledger context `', '` row `K5` (K5), whose residue')).toBe('K5')
    // The before side still wins when both could match, so a citation with a row
    // id on each side yields ONE id and therefore one finding.
    expect(attachedRowId('the `F5` row of `', '` row `K5` too')).toBe('F5')
  })

  it('requires the connective WORD, so a version string beside a path is not a row', () => {
    // The gate that lets ROW_ID be as wide as the plan's real vocabulary.
    expect(attachedRowId('shipped on `v1.2` against `')).toBeUndefined()
    expect(attachedRowId('the `P2.263` and `')).toBeUndefined()
    expect(attachedRowId('see `', '` v1.2 of the adapter')).toBeUndefined()
  })

  it('accepts the plan\'s dotted, hyphenated and heading-shaped ids', () => {
    expect(attachedRowId('the `P2.263` row of `')).toBe('P2.263')
    expect(attachedRowId('the `Dev-13` row of ')).toBe('Dev-13')
    expect(attachedRowId('the `OQ-11` section of `')).toBe('OQ-11')
    expect(attachedRowId('the `DR-2` entry of `')).toBe('DR-2')
    // Still not a row id: the lowercase and word forms the first version refused.
    expect(attachedRowId('the `k5` row of `')).toBeUndefined()
    expect(attachedRowId('the `wanted` row of `')).toBeUndefined()
  })

  it('neither arm can steal the other\'s citation, because the connective is a bare word', () => {
    // The one-defect-one-finding rule, held by construction rather than by a
    // length coincidence: `attachedIdentifier` needs a backticked span right
    // after its separators, and the word `row` is not one.
    expect(attachedIdentifier('` row `P6.947` is the one')).toBeUndefined()
    expect(attachedIdentifier('` row `H9` no longer states')).toBeUndefined()
    // And the identifier form is not read as a row id either.
    expect(attachedRowId('see `', '` `getBrowserToolEnabled` reads it')).toBeUndefined()
  })

  it('resolves an id defined by a list item or a heading, not only by a table row', () => {
    // Seven of the plan's converted citations name a decision entry, which is a
    // bullet, or an open question, which is a heading.
    const plan = [
      '# plan',
      '- **DR-2 — background auto-commit: RESOLVED.**',
      '- Dev-13 Import sources beyond Claude Code: later.',
      '## OQ-11 — OPEN: "sandbox off" changes nothing',
      '### P3.7 WSL spike (evidence only)',
      '| P2.263 | the host loopback is proxied too | done |',
    ]
    expect(rowAnchorLine(plan, 'DR-2')).toBe(2)
    expect(rowAnchorLine(plan, 'Dev-13')).toBe(3)
    expect(rowAnchorLine(plan, 'OQ-11')).toBe(4)
    expect(rowAnchorLine(plan, 'P3.7')).toBe(5)
    expect(rowAnchorLine(plan, 'P2.263')).toBe(6)
    // A prefix is not the id: `Dev-1` must not resolve to the `Dev-13` bullet,
    // which is the failure the original form avoided by requiring a closing pipe.
    expect(rowAnchorLine(plan, 'Dev-1')).toBeUndefined()
    // And the id is escaped, so a dot cannot act as a wildcard.
    expect(rowAnchorLine(['| P2X263 | a |'], 'P2.263')).toBeUndefined()
  })

  it('reports a missing decision entry the same way as a missing table row', () => {
    const plan = new Map([['docs/specs/plan.md', ['# plan', '- Dev-1 agent-teams: not taken.'].join('\n')]])
    const found = findRowIdCitations(
      collectCitations('l.md', 'already_ruled: the `Dev-9` row of `docs/specs/plan.md`.', ROOTS_D),
      plan,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.reason).toBe('missing')
    expect(found[0]?.rowId).toBe('Dev-9')
    // The negative on the same fixture, so the pair cannot pass by both failing.
    expect(findRowIdCitations(
      collectCitations('l.md', 'already_ruled: the `Dev-1` row of `docs/specs/plan.md`.', ROOTS_D),
      plan,
    )).toEqual([])
  })
})

describe('findSplitRowIds (D1.114)', () => {
  // The defect VERBATIM, shortened only in the middle of the qualifier: the
  // capability ledger's J5 cell at `830b2f19c~1` carried a 180-character
  // re-stamp between `P3` and `.237`, and the row-id arm answered 0 because the
  // text had stopped spelling an id at all.
  const J5 = 'BOTH HALVES MOVED — P3 (still true about the REASON at `rust-v0.150.1`, 2026-09-11;'
    + ' the STATE is now supplied thread-scoped).237 (`80c469bc1`) + P3.247 (`3e349771f`), 2026-09-03.'

  it('finds the split id, names the repair, and leaves the intact sibling alone', () => {
    const found = findSplitRowIds('docs/specs/ledger.md', `| J5 | a |\n${J5}\n`)
    expect(found).toHaveLength(1)
    expect(found[0]?.line).toBe(2)
    expect(found[0]?.rowId).toBe('P3.237')
    expect(found[0]?.qualifier.startsWith('(still true about the REASON')).toBe(true)
    // The negative control on the same fixture: `P3.247` two clauses later is
    // the CORRECT form, and a rule that fired on it would report one defect
    // twice. The finding's own text proves which of the two was matched.
    expect(found[0]?.text.includes('.247')).toBe(false)
  })

  it('is SILENT on the elided form, which is how this defect is written about', () => {
    // AGENTS.md §Traps: a correction that spells the dead anchor re-creates the
    // finding it repairs. Three sentences in the gated corpus describe this very
    // defect, all three in a plan no lane may repair, and all three elide the
    // qualifier. The parenthetical must therefore carry an alphanumeric.
    expect(findSplitRowIds('docs/plan.md', 'J5 read `P3 (…).237`, the id unreadable')).toEqual([])
    // The positive twin of that negative, one character apart: put ANY content
    // in the brackets and it is a re-stamp again.
    expect(findSplitRowIds('docs/plan.md', 'J5 read `P3 (x…).237`, the id unreadable')).toHaveLength(1)
  })

  it('does not fire on the two shapes that are not the defect', () => {
    // A parenthetical BESIDE the id is the correct form, and a version string
    // has no space before its bracket — both would be false positives that make
    // a lane stop reading this gate.
    expect(findSplitRowIds('docs/plan.md', 'P3.237 (`80c469bc1`) landed it')).toEqual([])
    expect(findSplitRowIds('docs/plan.md', 'rust-v0.150.1 (a tag).1 of the binary')).toEqual([])
  })

  it('keys on the DOCUMENT and the repaired id, never on the qualifier or the line', () => {
    // The C3.297 invariant: a key must not move when text above it moves, and a
    // key built from the qualifier would move when anyone edits the prose.
    const here = findSplitRowIds('docs/plan.md', J5)[0]!
    const moved = findSplitRowIds('docs/plan.md', `${'\n'.repeat(899)}${J5}`)[0]!
    expect(moved.line).toBe(900)
    expect(splitRowIdBaselineKey(here)).toBe('docs/plan.md::split-row=P3.237')
    expect(splitRowIdBaselineKey(here)).toBe(splitRowIdBaselineKey(moved))
    // And the document is part of the key, so the same broken id in two
    // documents is two findings — one of them may have an owner, the other not.
    expect(splitRowIdBaselineKey(findSplitRowIds('docs/other.md', J5)[0]!))
      .not.toBe(splitRowIdBaselineKey(here))
  })

  it('answers ZERO over every gated document at HEAD — the arm lands green', () => {
    // The negative control of the whole row, run against the real corpus: if
    // this ever answers non-zero on landing day, the narrowing is wrong and the
    // chain is red for every lane. Read from the working tree, as `main` does.
    const total = LEDGERS.reduce((sum, doc) => {
      const text = readFileSync(join(REPO_ROOT, doc), 'utf-8')
      return sum + findSplitRowIds(doc, text).length
    }, 0)
    expect(total).toBe(0)
  })
})

describe('findControlScopeMismatches (D1.317)', () => {
  // A tiny index rather than the real one: the arm's decision is about SCOPE, and
  // a fixture tree makes the containment arithmetic readable. `dup.ts` is tracked
  // twice on purpose — an ambiguous basename is the one lookup that must decline.
  const CONTROL_FILES = [
    'packages/shared/src/agent/pi-harness/claude-permission-rules.ts',
    'packages/core/src/types/message.ts',
    'apps/cli/src/index.ts',
    'packages/a/dup.ts',
    'apps/b/dup.ts',
  ]
  const INDEX = {
    tracked: new Set(CONTROL_FILES),
    roots: ROOTS,
    basenames: buildBasenameIndex(CONTROL_FILES),
  }

  // The defect VERBATIM in shape, shortened only in its tail: the `A43` cell of
  // both ledgers, whose probe states its pathspec in PROSE and whose control
  // names a file outside it.
  const A43 = '‖ [debug-your-config] Reproduced at HEAD:'
    + ' `git grep -ac \'resolvedRules\\|effectiveRules\\|permissionRules\'`'
    + ' over packages/core/src and packages/shared/src/protocol → 0 files;'
    + ' positive control on the same rig `unmatched_form` → 3 files'
    + ' (claude-permission-rules.ts:410,457 among them). No `permissions` id among the 21.'

  it('finds the A43 shape: a control whose file is outside the probe\'s own pathspec', () => {
    const census = findControlScopeMismatches('docs/specs/ledger.md', A43, INDEX)
    expect(census.subjects).toBe(1)
    expect(census.declined).toBe(0)
    expect(census.findings).toHaveLength(1)
    const finding = census.findings[0]!
    expect(finding.line).toBe(1)
    expect(finding.kind).toBe('file')
    expect(finding.probeSource).toBe('prose')
    expect(finding.probePathspec).toEqual(['packages/core/src', 'packages/shared/src/protocol'])
    expect(finding.control).toBe('claude-permission-rules.ts:410,457')
    expect(finding.outside).toBe('packages/shared/src/agent/pi-harness/claude-permission-rules.ts')
  })

  it('is SILENT on the same sentence when the control\'s file sits under the pathspec', () => {
    // One clause changed and nothing else. `contained` rather than `declined` is
    // the assertion that matters: a rule that had stopped DECIDING would also
    // report zero findings, and the two are indistinguishable from the count
    // alone — which is the dead-control shape this whole arm is about.
    const inScope = A43.replace(
      'over packages/core/src and packages/shared/src/protocol',
      'over packages/shared/src and packages/core/src',
    )
    expect(inScope).not.toBe(A43)
    const census = findControlScopeMismatches('docs/specs/ledger.md', inScope, INDEX)
    expect(census.subjects).toBe(1)
    expect(census.contained).toBe(1)
    expect(census.declined).toBe(0)
    expect(census.findings).toEqual([])
  })

  it('is SILENT on a probe with no control beside it, and on a control with no probe', () => {
    const probeOnly = '`git grep -al resolvedRules -- packages/core/src` → 0 files, so nothing reads it.'
    expect(findControlScopeMismatches('docs/specs/ledger.md', probeOnly, INDEX))
      .toEqual({ findings: [], subjects: 0, contained: 0, declined: 0 })
    // The mirror: the words with no command at all in front of them. The arm
    // needs a probe to compare a scope AGAINST, so this is not a subject either.
    const controlOnly = 'The positive control `unmatched_form` → 3 files (claude-permission-rules.ts:410).'
    expect(findControlScopeMismatches('docs/specs/ledger.md', controlOnly, INDEX).subjects).toBe(0)
    // And a probe whose pathspec cannot be read is not a subject: there is no
    // scope to be outside of. Same sentence, the `over …` clause removed.
    const noScope = '`git grep -ac resolvedRules` → 0 files; positive control `unmatched_form`'
      + ' → 3 files (claude-permission-rules.ts:410).'
    expect(findControlScopeMismatches('docs/specs/ledger.md', noScope, INDEX).subjects).toBe(0)
  })

  it('DECIDES a control that names a command of its own, both ways', () => {
    // The second decided shape, and it is decided rather than declined: a
    // pathspec is a scope written out, so containment needs no resolution at all.
    const inside = '`git grep -ail worktree -- packages apps` → 0;'
      + ' POSITIVE CONTROL `git grep -ail worktree -- apps/cli/src` → 2 files.'
    const good = findControlScopeMismatches('docs/specs/ledger.md', inside, INDEX)
    expect(good.contained).toBe(1)
    expect(good.findings).toEqual([])

    const outside = '`git grep -ail worktree -- packages/core/src` → 0;'
      + ' POSITIVE CONTROL `git grep -ail worktree -- apps/cli/src` → 2 files.'
    const bad = findControlScopeMismatches('docs/specs/ledger.md', outside, INDEX)
    expect(bad.findings).toHaveLength(1)
    expect(bad.findings[0]?.kind).toBe('command')
    expect(bad.findings[0]?.outside).toBe('apps/cli/src')
  })

  it('reads a clause terminator INSIDE backticks as part of the command', () => {
    // The first draft ended the clause at the bold marker and a `:(glob)`
    // pathspec's own double star is one, so the `CODEX_HOME` control below was
    // invisible: the clause stopped mid-command, the command branch found
    // nothing, and a decided subject read as declined.
    const glob = '`git grep -al MTLS_RELOAD -- packages apps` → 0 files;'
      + ' positive controls `git grep -al CODEX_HOME -- \':(glob)packages/**/*.ts\'` → 84 files.'
    const census = findControlScopeMismatches('docs/specs/ledger.md', glob, INDEX)
    expect(census.contained).toBe(1)
    expect(census.declined).toBe(0)

    // The twin one character apart: the SAME terminator outside backticks really
    // does end the clause, so the command after it is not this control's.
    const cut = glob.replace('positive controls `git grep', 'positive controls **and** `git grep')
    expect(cut).not.toBe(glob)
    const after = findControlScopeMismatches('docs/specs/ledger.md', cut, INDEX)
    expect(after.subjects).toBe(1)
    expect(after.contained).toBe(0)
    expect(after.declined).toBe(1)
  })

  it('DECLINES the four shapes whose sentence does not say enough to be wrong', () => {
    const probe = '`git grep -al X -- packages/core/src` → 0 files; positive control '
    // (1) no count at all — a file named in prose is not the evidence of a
    // reading, and the first draft charged exactly this sentence.
    const noCount = probe + 'on the same rig: `writeInstruction` writes `apps/cli/src/index.ts`.'
    // (2) a count of ZERO — a dead control for a different reason, and
    // containment says nothing about it.
    const zero = probe + '`zzznonsense` → 0, `apps/cli/src/index.ts`.'
    // (3) a partial path the index cannot resolve.
    const partial = probe + '`getEnable1MContext` → 2 hits in `config/storage.ts`.'
    // (4) an ambiguous basename — two tracked files answer to it.
    const ambiguous = probe + '`someNeedle` → 2 files (dup.ts among them).'
    for (const sentence of [noCount, zero, partial, ambiguous]) {
      const census = findControlScopeMismatches('docs/specs/ledger.md', sentence, INDEX)
      expect(census.subjects).toBe(1)
      expect(census.declined).toBe(1)
      expect(census.contained).toBe(0)
      expect(census.findings).toEqual([])
    }
    // The positive twin of (4), one file apart: a UNIQUE basename in the same
    // position IS resolved, so the decline above is the ambiguity and not the
    // shape of the sentence.
    const unique = probe + '`someNeedle` → 2 files (index.ts among them).'
    const decided = findControlScopeMismatches('docs/specs/ledger.md', unique, INDEX)
    expect(decided.declined).toBe(0)
    expect(decided.findings).toHaveLength(1)
    expect(decided.findings[0]?.outside).toBe('apps/cli/src/index.ts')
  })

  it('reads a prose pathspec as its LEADING run of paths and no further', () => {
    expect(probeScope('git grep -ail worktree', ' over packages apps for `worktree`', ROOTS))
      .toEqual({ pathspec: ['packages', 'apps'], source: 'prose' })
    // The command's own `--` wins, because that is the pathspec git was given.
    expect(probeScope('git grep -ail w -- packages/core/src', ' over the whole tree', ROOTS))
      .toEqual({ pathspec: ['packages/core/src'], source: 'argv' })
    // A word that is not a path ends it immediately, so a sentence that merely
    // says "over the tree" yields no scope rather than a wrong one.
    expect(probeScope('git grep -ail w', ' over the whole tree', ROOTS)).toBeUndefined()
  })

  it('strips git magic and shell quoting from a pathspec, and never widens a file', () => {
    expect(pathspecRoot('\':(glob)packages/**/*.ts\'')).toBe('packages')
    expect(pathspecRoot('packages/')).toBe('packages')
    expect(pathspecRoot('packages/core/src')).toBe('packages/core/src')
    expect(pathUnderPathspec('packages/core/src/types/message.ts', ['packages/core/src'])).toBe(true)
    // The prefix that is NOT a directory boundary: a rule written with a bare
    // `startsWith` would call this contained.
    expect(pathUnderPathspec('packages/core-extra/x.ts', ['packages/core'])).toBe(false)
    expect(pathUnderPathspec('apps/cli/src/index.ts', ['packages', 'apps'])).toBe(true)
  })

  it('keys on the DOCUMENT and the out-of-scope path, never on the line', () => {
    // The C3.297 invariant this file states for every other arm: a key must not
    // move when text above it moves.
    const here = findControlScopeMismatches('docs/specs/ledger.md', A43, INDEX).findings[0]!
    const moved = findControlScopeMismatches(
      'docs/specs/ledger.md', `${'\n'.repeat(899)}${A43}`, INDEX,
    ).findings[0]!
    expect(moved.line).toBe(900)
    expect(controlScopeBaselineKey(here))
      .toBe('docs/specs/ledger.md::control-scope=packages/shared/src/agent/pi-harness/claude-permission-rules.ts')
    expect(controlScopeBaselineKey(here)).toBe(controlScopeBaselineKey(moved))
    // The twin documents carry the same sentence, so the document must be part
    // of the key: one repair, two entries, and each visible on its own.
    expect(controlScopeBaselineKey(findControlScopeMismatches('docs/specs/gaps.md', A43, INDEX).findings[0]!))
      .not.toBe(controlScopeBaselineKey(here))
  })

  it('leaves every gated document with its findings BASELINED at HEAD', () => {
    // Not a declared count: the one instance is the controller's to repair, and a
    // number here would go red on the repair itself (AGENTS.md §Traps, W18-a — a
    // control is dated prose, a claim may be declared). What is invariant is that
    // nothing is FRESH. The positive control for this instrument is the fixture
    // above: the same function finds the A43 shape when it is handed one.
    const baseline = readBaseline()
    const tracked = trackedFiles()
    const roots = new Set(
      tracked.filter(file => file.includes('/')).map(file => file.split('/')[0] as string),
    )
    const index = { tracked: new Set(tracked), roots, basenames: buildBasenameIndex(tracked) }
    const fresh: string[] = []
    for (const doc of LEDGERS) {
      const text = readFileSync(join(REPO_ROOT, doc), 'utf-8')
      for (const finding of findControlScopeMismatches(doc, text, index).findings) {
        if (!baseline.has(controlScopeBaselineKey(finding))) fresh.push(`${finding.doc}:${finding.line}`)
      }
    }
    expect(fresh).toEqual([])
  })
})

describe('unreachableCitations (D1.159)', () => {
  // The rule's whole subject is a token collectCitations DROPS. `packages` is a
  // tracked root here and `anthropic-ai` is not, which is the real asymmetry:
  // the token rule has no `@`, so a scoped package matches from its scope name.
  const ROOTS_U = new Set(['packages', 'docs'])

  it('names the vendored bundle a cell cites with its scope spelling', () => {
    const found = unreachableCitations(
      'the SDK declares it at `@anthropic-ai/claude-agent-sdk/sdk.d.ts:1200`',
      ROOTS_U,
    )
    expect(found.occurrences).toBe(1)
    expect(found.withLineTail).toBe(1)
    expect(found.paths).toEqual(['node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'])
  })

  it('says nothing about prose, another repository, or an ellipsis', () => {
    // The negative control, and it is what keeps this line from being noise: of
    // 2 276 dropped tokens in the real corpus only ~110 are on disk, and none of
    // these three shapes is.
    const found = unreachableCitations(
      'codex-rs/otel/src/provider.rs at the tag, and `agent-sdk/mcp.md#connection-timing`,'
      + ' and an elided `packages/.../gone.ts`',
      ROOTS_U,
    )
    expect(found.occurrences).toBe(0)
    expect(found.paths).toEqual([])
  })

  it('leaves a TRACKED root alone — that citation is the checked population', () => {
    // The positive control for the drop rule itself: a `packages/...` token is a
    // real Citation and is checked by six arms, so counting it here as
    // "unchecked" would be a second, wrong story about the same token.
    expect(unreachableCitations('see `packages/shared/src/agent/claude-agent.ts:10`', ROOTS_U).occurrences)
      .toBe(0)
  })

  it('tries the bare path, then the scoped and unscoped node_modules spellings, in that order', () => {
    expect(onDiskSpellings('release/mac-arm64/app.js')).toEqual([
      'release/mac-arm64/app.js',
      'node_modules/@release/mac-arm64/app.js',
      'node_modules/release/mac-arm64/app.js',
    ])
  })
})

describe('findAbsentSymbolCitations (P6.957)', () => {
  // A file with ONE token that matters and one near-miss: `joinPath` exists,
  // `join` does not exist as a token of its own. That pair is the whole reason
  // this arm matches a WHOLE token rather than a substring — over a 34 000-line
  // file, `includes` would call `join` present and the check would be decorative.
  const file = ['export function joinPath(a: string) {', '  return a', '}', 'const kept = 1'].join('\n')
  const contents = new Map([['packages/shared/src/x.ts', file]])
  const ROOTS_X = new Set(['packages'])

  const findOne = (sentence: string) =>
    findAbsentSymbolCitations(collectCitations('l.md', sentence, ROOTS_X), contents)

  it('reports a symbol that does not occur in the cited file — the positive control', () => {
    const found = findOne('see `packages/shared/src/x.ts` symbol `renamedAway` for it')

    expect(found).toHaveLength(1)
    expect(found[0]?.symbol).toBe('renamedAway')
    expect(found[0]?.citation.text).toBe('packages/shared/src/x.ts')
    // No line tail anywhere in the key: that is the point of the form.
    expect(symbolBaselineKey(found[0]!)).toBe('packages/shared/src/x.ts::symbol=renamedAway')
  })

  it('says nothing when the symbol is there, on either side of the citation', () => {
    expect(findOne('see `packages/shared/src/x.ts` symbol `joinPath` for it')).toEqual([])
    expect(findOne('the `joinPath` symbol of `packages/shared/src/x.ts` does it')).toEqual([])
    // The word is the opt-in, and `identifier` is its accepted synonym.
    expect(findOne('see `packages/shared/src/x.ts` identifier `kept` for it')).toEqual([])
  })

  it('a substring of a longer name is NOT the symbol — the ambiguous case', () => {
    // `join` appears in this file only inside `joinPath`. A containment check
    // over a whole file would pass on a symbol that no longer exists, which is
    // exactly the failure the boundary rule exists to prevent — so this is a
    // finding, and its converse below is not.
    expect(findOne('see `packages/shared/src/x.ts` symbol `join` for it')).toHaveLength(1)
    expect(symbolOccurs('join', file)).toBe(false)
    expect(symbolOccurs('joinPath', file)).toBe(true)
    // `A.b` names MEMBER `b` of `A` and is not spelled that way in the source:
    // the same rescue the +-5 arm applies, so one rule lives in one place.
    expect(symbolOccurs('Helper.joinPath', file)).toBe(true)
    expect(symbolOccurs('Helper.absentMember', file)).toBe(false)
  })

  it('opts in on the WORD and on nothing else', () => {
    // Every shape the accidental population is made of, measured 2026-09-09:
    // a bare backticked span after the citation (the next clause's identifier),
    // a parenthesised one, and a commit sha. None of them is this form.
    expect(findOne('see `packages/shared/src/x.ts` `renamedAway` for it')).toEqual([])
    expect(findOne('see `packages/shared/src/x.ts` (`renamedAway`)')).toEqual([])
    expect(findOne('recorded at `packages/shared/src/x.ts` (`bc7c684a8`)')).toEqual([])
    expect(attachedSymbol('', '` symbol `renamedAway`')).toBe('renamedAway')
    expect(attachedSymbol('the `renamedAway` symbol of `', '`')).toBe('renamedAway')
    expect(attachedSymbol('', '` symbol `packages/shared/src/y.ts`')).toBeUndefined()
    expect(attachedSymbol('', '` symbol `x`')).toBeUndefined()
    expect(attachedSymbol('', '` `renamedAway`')).toBeUndefined()
  })

  it('cannot fire on the same citation as either sibling arm', () => {
    // By construction, not by a length coincidence: `attachedIdentifier` refuses
    // anything that is not a backticked span after its separator set, so the
    // connective word blocks it; and `symbol` is disjoint from `row`/`entry`.
    expect(attachedIdentifier('` symbol `renamedAway`')).toBeUndefined()
    expect(attachedRowId('', '` symbol `renamedAway`')).toBeUndefined()
    expect(attachedSymbol('', '` row `K5`')).toBeUndefined()
  })

  it('is silent about a file it could not read, rather than reporting it absent', () => {
    // A dead path is already reported by its own arm; asking this one to speak
    // would make one defect two findings in different words.
    expect(findAbsentSymbolCitations(
      collectCitations('l.md', 'see `packages/shared/src/gone.ts` symbol `whatever` for it', ROOTS_X),
      contents,
    )).toEqual([])
  })
})

describe('findAmbiguousAnchorCitations (C3.325)', () => {
  // One literal that occurs ONCE, one that occurs TWICE, and one that is gone.
  // The pair is the whole point of the arm: the symbol arm would call `land here`
  // present in both cases, because occurring is all it asks.
  const file = [
    'const unique = "if(!e?.env)return e;"',
    'const twice = "remote-settings.json"',
    'const alsoTwice = "remote-settings.json"',
    'const overlapping = "aaaa"',
  ].join('\n')
  const contents = new Map([['packages/shared/src/x.ts', file]])
  const ROOTS_A = new Set(['packages'])

  const findOne = (sentence: string) =>
    findAmbiguousAnchorCitations(collectCitations('l.md', sentence, ROOTS_A), contents)

  it('reports an anchor that is no longer UNIQUE — the positive control, and the row itself', () => {
    // W17-z's PR-4 in miniature: the string went 1 -> 4 across one lift and the
    // sentence beside it kept reading as verified.
    const found = findOne('see `packages/shared/src/x.ts` anchor `remote-settings.json` for it')

    expect(found).toHaveLength(1)
    expect(found[0]?.anchor).toBe('remote-settings.json')
    expect(found[0]?.occurrences).toBe(2)
    expect(anchorBaselineKey(found[0]!))
      .toBe('packages/shared/src/x.ts::anchor=remote-settings.json')
  })

  it('reports an anchor that is GONE, and stays silent on one that occurs exactly once', () => {
    // Zero is a finding of its own kind rather than a second dead-line report:
    // a citation with no line tail is invisible to the blank/EOF arm.
    const gone = findOne('see `packages/shared/src/x.ts` anchor `was-rewritten-away` for it')
    expect(gone).toHaveLength(1)
    expect(gone[0]?.occurrences).toBe(0)

    expect(findOne('see `packages/shared/src/x.ts` anchor `if(!e?.env)return e;` for it')).toEqual([])
    expect(findOne('the `if(!e?.env)return e;` anchor of `packages/shared/src/x.ts` holds')).toEqual([])
  })

  it('counts OVERLAPPING occurrences, because an anchor that overlaps itself is ambiguous too', () => {
    expect(countOccurrences('aa', 'aaaa')).toBe(3)
    expect(countOccurrences('aaaa', file)).toBe(1)
    expect(countOccurrences('nothing-like-this', file)).toBe(0)
  })

  it('opts in on the WORD and on nothing else — the refused alternative, with its number', () => {
    // The accidental form is any backticked PHRASE after a citation: 5 584
    // subjects over the five documents on 2026-09-12, 201 of them unique. This
    // arm sees none of them.
    expect(findOne('see `packages/shared/src/x.ts` `remote-settings.json` for it')).toEqual([])
    expect(findOne('see `packages/shared/src/x.ts` (`remote-settings.json`)')).toEqual([])
    expect(attachedAnchor('', '` anchor `remote-settings.json`')).toBe('remote-settings.json')
    expect(attachedAnchor('the `remote-settings.json` anchor of `', '`')).toBe('remote-settings.json')
    // Under three characters is not a locator, whatever the sentence calls it.
    expect(attachedAnchor('', '` anchor `ab`')).toBeUndefined()
  })

  it('REFUSES a literal containing `#`, and the refusal has two independent reasons', () => {
    // (1) `readBaseline` strips from a `#` onward, so the key would be read back
    // truncated; (2) a `#section` is a DOC-PAGE anchor, gated by
    // `check-doc-anchors.ts`, and the five documents already spell that form 16
    // times.
    expect(attachedAnchor('', '` anchor `#work-across-sessions`')).toBeUndefined()
    expect(attachedAnchor('the `#work-across-sessions` anchor of `', '`')).toBeUndefined()
    expect(findOne('see `packages/shared/src/x.ts` anchor `#work-across-sessions` here')).toEqual([])
  })

  it('cannot fire on the same citation as any sibling arm, by construction', () => {
    expect(attachedIdentifier('` anchor `remote-settings.json`')).toBeUndefined()
    expect(attachedRowId('', '` anchor `remote-settings.json`')).toBeUndefined()
    expect(attachedSymbol('', '` anchor `remote-settings.json`')).toBeUndefined()
    expect(attachedAnchor('', '` symbol `renamedAway`')).toBeUndefined()
    expect(attachedAnchor('', '` row `K5`')).toBeUndefined()
  })

  it('is silent about a file it could not read, rather than reporting the anchor gone', () => {
    expect(findAmbiguousAnchorCitations(
      collectCitations('l.md', 'see `packages/shared/src/gone.ts` anchor `whatever-string` for it', ROOTS_A),
      contents,
    )).toEqual([])
  })
})

describe('readIndexBlobs', () => {
  it('reads real content out of the index, in request order — the reader is not vacuous', () => {
    // Without this the unit tests above run on hand-made maps and would pass
    // with the reader returning nothing, which is the shape of a green gate
    // over an unread tree. Two paths, so the by-ORDER matching is exercised:
    // `git cat-file --batch` does not echo a request that resolves.
    //
    // Assert only on strings that are in the COMMITTED copy. The first version
    // of this test asserted on a symbol added in the same working-tree edit and
    // failed — which is the reader doing exactly what the header promises, and
    // the reason to state it here: a working-tree assertion would have passed
    // for the wrong reason on every later run.
    const blobs = readIndexBlobs(['package.json', 'scripts/check-ledger-citations.ts'])

    expect(blobs.size).toBe(2)
    expect(blobs.get('package.json')).toContain('"lint:ledger-citations"')
    expect(blobs.get('scripts/check-ledger-citations.ts')?.startsWith('#!/usr/bin/env bun')).toBe(true)
    expect(blobs.get('scripts/check-ledger-citations.ts')).toContain('export const LEDGERS')
  })

  it('returns nothing for a path the index does not hold, and never throws for it', () => {
    expect(readIndexBlobs(['packages/shared/src/no-such-file-P6887.ts']).size).toBe(0)
    expect(readIndexBlobs([]).size).toBe(0)
  })
})

describe('the subject exists', () => {
  it('every document the guard reads is a tracked file — a missing one makes the gate vacuous', () => {
    const tracked = new Set(trackedFiles())
    for (const doc of LEDGERS) expect(tracked.has(doc)).toBe(true)
  })

  it('reads the ledger AND the two documents it was derived from or feeds — a one-element list missed the same defect six times', () => {
    // P6.861. Named individually rather than by count: the row exists because
    // `LEDGERS` held only the derived document, so the phantom-plan citation in
    // its SOURCE and its four copies in the codex map were invisible to a green
    // gate. A count would pass again the day one of these is dropped.
    expect(LEDGERS).toContain('docs/superpowers/specs/2026-08-28-capability-ledger.md')
    expect(LEDGERS).toContain('docs/superpowers/specs/2026-09-05-denominator-gaps.md')
    expect(LEDGERS).toContain('docs/superpowers/specs/2026-08-22-codex-coverage-map.md')
    // P6.948. Named for the same reason and with a stronger one: this member is
    // the only one no lane may edit, so a silent removal would be nobody's to
    // notice — and removing it is the one repair that makes 126 baselined
    // findings disappear without a single citation being corrected.
    expect(LEDGERS).toContain('docs/superpowers/plans/2026-08-22-runtime-parity-closure.md')
  })

  it('the plan\'s own row-form citations of the ledger resolve, on the real documents', () => {
    // P6.948's acceptance, asserted against the tree rather than a fixture: the
    // plan writes `<path>` row `H9`, the mirror of the form the specs write, and
    // both sides opting in is what admitting the plan was for. A drop to zero
    // subjects here means the arm stopped reading one side, which is exactly how
    // this hole existed for a day without anything going red.
    const roots = new Set(
      [...trackedFiles()].filter(file => file.includes('/')).map(file => file.split('/')[0] as string),
    )
    const plan = 'docs/superpowers/plans/2026-08-22-runtime-parity-closure.md'
    const citations = collectCitations(plan, readFileSync(join(REPO_ROOT, plan), 'utf-8'), roots)
    const subjects = citations.filter(citation => attachedRowId(citation.before, citation.after) !== undefined)
    expect(subjects.length).toBeGreaterThanOrEqual(2)
    expect(subjects.every(citation => citation.path.endsWith('.md'))).toBe(true)

    const contents = readIndexBlobs([...new Set(subjects.map(citation => citation.path))].sort())
    const unresolved = findRowIdCitations(citations, contents)
      .map(finding => `${finding.citation.line}: ${finding.rowId} ${finding.reason}`)
    expect(unresolved).toEqual([])
  })

  it('every listed document really yields citations — being listed is not being read', () => {
    // The negative this pairs with is the script's own per-document refusal: a
    // member contributing zero used to be masked by its siblings' totals.
    const roots = new Set(
      [...trackedFiles()].filter(file => file.includes('/')).map(file => file.split('/')[0] as string),
    )
    for (const doc of LEDGERS) {
      const found = collectCitations(doc, readFileSync(join(REPO_ROOT, doc), 'utf-8'), roots)
      // The doc name rides in the assertion so a failure names WHICH member went silent.
      expect(found.length > 0 ? doc : `${doc} yielded no citations`).toBe(doc)
    }
  })
})



describe('every baseline key is CITED-side only (C3.297)', () => {
  // C3.297 said the baseline comparison is keyed on `<file>:<line>` of the
  // CITING line, so an insertion above a citation would report it as new. It is
  // not, and this block is the pin that keeps it that way.
  //
  // Measured before the pin was written (2026-09-12): five lines inserted at the
  // top of the capability ledger and the gate re-run on the same index gave
  // BYTE-IDENTICAL numbers — 0 / 15 / 6 / 0 / 0 NOT-in-the-baseline on the five
  // arms — while the raw output differed on 78 lines, every one of them a
  // `doc:line` prefix moved by exactly five. The trap is in diffing the OUTPUT,
  // which is a lane's method, and never in the key.
  const ROOTS_X = new Set(['docs', 'packages'])
  const contents = new Map([['packages/shared/src/x.ts', 'const kept = 1\n\nconst c = 3\n']])
  // The `K5` row on line 1 and twenty filler lines, so a citation of line 20 is
  // outside the +-5 window and the row arm has something to report.
  const docs = new Map([
    ['docs/specs/ledger.md', ['| K5 | a |', ...Array.from({ length: 20 }, () => 'x')].join('\n')],
  ])

  // The SAME sentence read from two places: line 1 of one document and line 900
  // of another. Nothing about the citation itself changes.
  const twice = (sentence: string): readonly [Citation, Citation] => {
    const here = collectCitations('docs/a.md', sentence, ROOTS_X)[0]!
    const moved = collectCitations('docs/b.md', `${'\n'.repeat(899)}${sentence}`, ROOTS_X)[0]!
    expect(here.line).toBe(1)
    expect(moved.line).toBe(900)
    return [here, moved]
  }

  it('gives a dead PATH and a dead LINE the same key from either position', () => {
    const [here, moved] = twice('see `packages/shared/src/gone.ts:9` for it')
    const dead = findDeadCitations([here, moved], new Set(['packages/shared/src/x.ts']))
    expect(dead).toHaveLength(2)
    expect(deadPathBaselineKey(dead[0]!)).toBe('packages/shared/src/gone.ts')
    expect(deadPathBaselineKey(dead[0]!)).toBe(deadPathBaselineKey(dead[1]!))

    const [liveHere, liveMoved] = twice('see `packages/shared/src/x.ts:2` for it')
    const lines = findDeadLineCitations([liveHere, liveMoved], contents)
    expect(lines).toHaveLength(2)
    expect(deadLineBaselineKey(lines[0]!)).toBe('packages/shared/src/x.ts:2')
    expect(deadLineBaselineKey(lines[0]!)).toBe(deadLineBaselineKey(lines[1]!))
  })

  it('gives an identifier, a row and a symbol finding the same key from either position', () => {
    const [idHere, idMoved] = twice('see `packages/shared/src/x.ts:1` `renamedAway` for it')
    const ids = findDriftedIdentifierCitations([idHere, idMoved], contents)
    expect(ids).toHaveLength(2)
    expect(identifierBaselineKey(ids[0]!)).toBe(identifierBaselineKey(ids[1]!))

    const [rowHere, rowMoved] = twice('the `K5` row of `docs/specs/ledger.md:20`')
    const rows = findRowIdCitations([rowHere, rowMoved], docs)
    expect(rows).toHaveLength(2)
    expect(rowBaselineKey(rows[0]!)).toBe(rowBaselineKey(rows[1]!))

    const [symHere, symMoved] = twice('see `packages/shared/src/x.ts` symbol `renamedAway`')
    const syms = findAbsentSymbolCitations([symHere, symMoved], contents)
    expect(syms).toHaveLength(2)
    expect(symbolBaselineKey(syms[0]!)).toBe(symbolBaselineKey(syms[1]!))
  })

  it('counts the two positions as ONE key in the plan census — the ratchet cannot move on a shift', () => {
    // The negative control of the block: if any key carried the citing line, the
    // census would read 2 distinct keys here instead of 1, and the plan ratchet
    // would rise on an edit that changed nothing.
    const sentence = 'see `packages/shared/src/x.ts:2` for it'
    const here = collectCitations(PLAN_DOC, sentence, ROOTS_X)[0]!
    const moved = collectCitations(PLAN_DOC, `${'\n'.repeat(899)}${sentence}`, ROOTS_X)[0]!
    const lines = findDeadLineCitations([here, moved], contents)

    const census = planFindingCensus({
      dead: [], lines, identifiers: [], rows: [], symbols: [], anchors: [], splitRows: [], controls: [],
      dialects: [],
    })
    expect(census.keys).toEqual(['packages/shared/src/x.ts:2'])
    expect(census.occurrences).toBe(2)
  })
})

describe('the plan ratchet (P6.954)', () => {
  // The plan is the one LEDGERS member no lane may repair, so its findings only
  // accumulate — and `--update-baseline` absorbs them all at once, after which
  // `--check` is green with more debt than before. These pin the two halves that
  // makes visible: what the census counts, and which direction is a failure.
  //
  // Deliberately NOT asserted here: that the real tree's census equals the pin.
  // The gate already fails on that, and a test saying the same thing would make
  // one controller commit produce two reds for one cause.
  const citation = (doc: string, text: string) => ({
    doc,
    line: 1,
    text,
    path: text.split(':')[0] as string,
    after: '',
    before: '',
  })
  const SPEC = 'docs/superpowers/specs/2026-08-28-capability-ledger.md'

  it('counts only the plan, de-duplicates into baseline keys, and keeps occurrences beside them', () => {
    const gone = 'packages/shared/src/gone-P6954.ts'
    const census = planFindingCensus({
      // Two cells citing the SAME dead path: one key, two occurrences. That gap
      // is the stated residue — the pin cannot see the second one.
      dead: [
        { citation: citation(PLAN_DOC, `${gone}:12`), elsewhere: [] },
        { citation: citation(PLAN_DOC, gone), elsewhere: [] },
        // A spec finding, which has an owner and is not this pin's subject.
        { citation: citation(SPEC, 'packages/shared/src/other-P6954.ts'), elsewhere: [] },
      ],
      lines: [{ citation: citation(PLAN_DOC, 'scripts/x-P6954.ts:900'), reason: 'blank', lineCount: 1000 }],
      identifiers: [
        { citation: citation(PLAN_DOC, 'scripts/x-P6954.ts:900'), identifier: 'someName', lineCount: 1000, from: 895, to: 905 },
      ],
      rows: [
        { citation: citation(PLAN_DOC, 'docs/superpowers/specs/y-P6954.md:3'), rowId: 'K5', reason: 'missing', lineCount: 10 },
      ],
      // P6.957 — the fifth form. A tail-less citation, so its key is the bare
      // path plus the symbol, which is why the separator must not be `::` alone.
      symbols: [
        { citation: citation(PLAN_DOC, 'scripts/x-P6954.ts'), symbol: 'goneName', lineCount: 1000 },
      ],
      // C3.325 — the sixth form, and the one whose key carries a literal rather
      // than an identifier.
      anchors: [
        {
          citation: citation(PLAN_DOC, 'scripts/x-P6954.ts'),
          anchor: 'land here',
          occurrences: 3,
          lineCount: 1000,
        },
      ],
      // D1.114 — the seventh form, and the only one keyed by the DOCUMENT: a
      // split row id cites no repo file, so there is no citation to key it on.
      // The spec-side one is dropped for the same reason the spec dead path is.
      splitRows: [
        { doc: PLAN_DOC, line: 41, text: 'P3 (re-stamped).237', rowId: 'P3.237', qualifier: '(re-stamped)' },
        { doc: SPEC, line: 7, text: 'J5 (re-stamped).1', rowId: 'J5.1', qualifier: '(re-stamped)' },
      ],
      // D1.317 — the eighth form and the SECOND keyed by the document, for the
      // same reason: a control's scope is a sentence's property, not a citation's.
      controls: [
        {
          doc: PLAN_DOC,
          line: 58,
          probe: 'git grep -al X -- packages/core/src',
          probePathspec: ['packages/core/src'],
          probeSource: 'argv',
          control: 'far-P6954.ts',
          kind: 'file',
          outside: 'apps/electron/src/far-P6954.ts',
        },
        {
          doc: SPEC,
          line: 9,
          probe: 'git grep -al Y -- packages/core/src',
          probePathspec: ['packages/core/src'],
          probeSource: 'argv',
          control: 'other-P6954.ts',
          kind: 'file',
          outside: 'apps/electron/src/other-P6954.ts',
        },
      ],
      // D1.337 — the ninth form and the THIRD keyed by the document: the subject
      // is a command, so there is no citation and no sentence to key it on.
      dialects: [
        {
          doc: PLAN_DOC,
          line: 63,
          command: 'git grep -aiE \'aP6954\\|bP6954\' -- packages',
          pattern: 'aP6954\\|bP6954',
          flag: '-aiE',
        },
        {
          doc: SPEC,
          line: 11,
          command: 'git grep -aiE \'cP6954\\|dP6954\' -- packages',
          pattern: 'cP6954\\|dP6954',
          flag: '-aiE',
        },
      ],
    })

    expect(census.occurrences).toBe(10)
    // Every key FORM, exactly as `writeBaseline` records them — a path for a
    // dead path, the whole citation for a dead line, and the `::` forms. NOT
    // numbered in this sentence: it said "the six" while listing eight, which is
    // the stale-count shape `PlanCensusInput`'s own header records one file over.
    expect(census.keys).toEqual([
      'docs/superpowers/specs/y-P6954.md:3::row=K5',
      gone,
      'scripts/x-P6954.ts:900',
      'scripts/x-P6954.ts:900::someName',
      'scripts/x-P6954.ts::anchor=land here',
      'scripts/x-P6954.ts::symbol=goneName',
      `${PLAN_DOC}::split-row=P3.237`,
      `${PLAN_DOC}::control-scope=apps/electron/src/far-P6954.ts`,
      `${PLAN_DOC}::escaped-alternation=git grep -aiE 'aP6954\\|bP6954' -- packages`,
    ].sort())
    expect(census.keys).not.toContain(`${SPEC}::split-row=J5.1`)
    expect(census.keys).not.toContain(`${SPEC}::control-scope=apps/electron/src/other-P6954.ts`)
    expect(census.keys).not.toContain(`${SPEC}::escaped-alternation=git grep -aiE 'cP6954\\|dP6954' -- packages`)
    expect(census.keys).not.toContain('packages/shared/src/other-P6954.ts')
  })

  it('a synthetic RISE fails and a FALL only asks for the pin to be lowered', () => {
    const risen = planFindingCensus({
      dead: [{ citation: citation(PLAN_DOC, 'packages/shared/src/gone-P6954.ts'), elsewhere: [] }],
      lines: [],
      identifiers: [],
      rows: [],
      symbols: [],
      anchors: [],
      splitRows: [],
      controls: [],
      dialects: [],
    })

    expect(ratchetVerdict(risen.keys.length, 0)).toBe('rose')
    expect(ratchetVerdict(PINNED_PLAN_FINDINGS + 1)).toBe('rose')
    expect(ratchetVerdict(PINNED_PLAN_FINDINGS)).toBe('unchanged')
    expect(ratchetVerdict(PINNED_PLAN_FINDINGS - 1)).toBe('fell')
  })

  it('the ratchet and the document list cannot drift apart — one spelling of the path', () => {
    // A second literal would let LEDGERS keep the plan while the census measured
    // a document that is no longer there, and the pin would read 0 forever.
    expect(LEDGERS).toContain(PLAN_DOC)
    expect(planFindingCensus({
      dead: [], lines: [], identifiers: [], rows: [], symbols: [], anchors: [], splitRows: [], controls: [], dialects: [],
    }).keys).toEqual([])
  })
})

describe('the unattached ratchet (P6.993)', () => {
  // The population this gate cannot check: a `:line` and nothing else. The pins
  // exist so it can only fall, now that both per-path heads are measured spent.
  //
  // Deliberately NOT asserted here, for the plan ratchet's reason one block up:
  // that the real tree's census equals the pins. The gate fails on that itself,
  // and a test saying the same thing turns one conversion into two reds.
  const cite = (over: Partial<Citation> & { text: string }): Citation => ({
    doc: 'docs/superpowers/specs/2026-08-28-capability-ledger.md',
    line: 1,
    path: over.text.split(':')[0] as string,
    after: '',
    before: '',
    ...over,
  })
  const TRACKED = new Set([
    'packages/shared/src/agent/base-agent.ts',
    'packages/shared/src/config/storage.ts',
  ])

  it('counts a line-tailed citation that attaches nothing, and none of the three that do', () => {
    expect(isUnattachedLineCitation(cite({ text: 'packages/shared/src/agent/base-agent.ts:1316' }))).toBe(true)
    // The identifier arm's opt-in.
    expect(isUnattachedLineCitation(cite({
      text: 'packages/shared/src/agent/base-agent.ts:1316',
      after: '` `sessionCostUsdHydrated` reads it',
    }))).toBe(false)
    // The symbol arm's, on the side a converted cell writes it.
    expect(isUnattachedLineCitation(cite({
      text: 'packages/shared/src/agent/base-agent.ts:1316',
      after: '` symbol `sessionCostUsdHydrated`',
    }))).toBe(false)
    // The row-id arm's, which reads the side BEFORE the citation.
    expect(isUnattachedLineCitation(cite({
      text: 'docs/superpowers/specs/2026-08-28-capability-ledger.md:12',
      before: 'the `K5` row of `',
    }))).toBe(false)
    // No tail at all: nothing decays, so nothing is counted.
    expect(isUnattachedLineCitation(cite({ text: 'packages/shared/src/agent/base-agent.ts' }))).toBe(false)
  })

  it('splits the arms by `written`, skips the plan, and skips a path that does not resolve', () => {
    const census = unattachedCensus([
      cite({ text: 'packages/shared/src/agent/base-agent.ts:1316' }),
      cite({ text: 'packages/shared/src/agent/base-agent.ts:1366', line: 2 }),
      // The bare-name arm: `written` is what `collectBareNameCitations` leaves
      // behind, and it is the only thing separating the two populations.
      cite({ text: 'packages/shared/src/config/storage.ts:602', written: 'storage.ts:602' }),
      // The plan is ratcheted by FINDINGS (PINNED_PLAN_FINDINGS), not by form.
      cite({ text: 'packages/shared/src/agent/base-agent.ts:1424', doc: PLAN_DOC }),
      // A dead path is a finding of its own above; counting it here would make
      // one defect two reds.
      cite({ text: 'apps/electron/resources/pi-agent-server/index.js:584336' }),
    ], TRACKED)

    expect(census).toEqual({ path: 2, pathPaths: 1, bare: 1, barePaths: 1 })
  })

  it('a synthetic RISE fails and a FALL only asks for the pin to be lowered', () => {
    const risen = unattachedCensus([
      cite({ text: 'packages/shared/src/agent/base-agent.ts:1316' }),
      cite({ text: 'packages/shared/src/config/storage.ts:602', written: 'storage.ts:602' }),
    ], TRACKED)

    expect(ratchetVerdict(risen.path, 0)).toBe('rose')
    expect(ratchetVerdict(risen.bare, 0)).toBe('rose')
    expect(ratchetVerdict(PINNED_UNATTACHED_PATH + 1, PINNED_UNATTACHED_PATH)).toBe('rose')
    expect(ratchetVerdict(PINNED_UNATTACHED_PATH, PINNED_UNATTACHED_PATH)).toBe('unchanged')
    expect(ratchetVerdict(PINNED_UNATTACHED_PATH - 1, PINNED_UNATTACHED_PATH)).toBe('fell')
    expect(ratchetVerdict(PINNED_UNATTACHED_BARE - 1, PINNED_UNATTACHED_BARE)).toBe('fell')
    // A citation converted to the symbol form leaves the census entirely, which
    // is the direction the fall is supposed to come from.
    expect(unattachedCensus([
      cite({ text: 'packages/shared/src/agent/base-agent.ts:1316', after: '` symbol `hydrateSessionCostUsdOnce`' }),
    ], TRACKED)).toEqual({ path: 0, pathPaths: 0, bare: 0, barePaths: 0 })
  })
})

describe('the bare `:line` shorthand ratchet (P6.998)', () => {
  const TRACKED = new Set(['packages/shared/src/agent/base-agent.ts'])
  const cited = (line: string) => unattachedCensus(collectCitations('l.md', line, ROOTS), TRACKED)

  it('takes a colon-and-digits no path precedes, and refuses a tail and a longer token', () => {
    // The shorthand itself, backticked and bare, and the range form.
    expect(countLineShorthands('the same file at `:812` and again at :1316, plus `:812-820`')).toBe(3)
    // A real citation's own tail: a path character sits immediately before the colon.
    expect(countLineShorthands('`packages/shared/src/agent/base-agent.ts:1316` reads it')).toBe(0)
    // A clock, a port and a version are all preceded or followed by a path character.
    expect(countLineShorthands('measured 17:13 on :8080/api at v:1.2')).toBe(0)
    // Line start counts: there is no preceding character to disqualify it.
    expect(countLineShorthands(':1316 is the anchor')).toBe(1)
  })

  it('a synthetic RISE fails and a FALL only asks for the pin to be lowered', () => {
    expect(ratchetVerdict(countLineShorthands('`:812` and `:813`'), 0)).toBe('rose')
    expect(ratchetVerdict(PINNED_SHORTHAND + 1, PINNED_SHORTHAND)).toBe('rose')
    expect(ratchetVerdict(PINNED_SHORTHAND, PINNED_SHORTHAND)).toBe('unchanged')
    expect(ratchetVerdict(PINNED_SHORTHAND - 1, PINNED_SHORTHAND)).toBe('fell')
  })

  it('moves OPPOSITE the unattached arm on a deleted path, and not at all on a conversion', () => {
    // The cell as written: one unattached full-path citation, no shorthand.
    const written = '`packages/shared/src/agent/base-agent.ts:1316` is where it lands'
    expect(cited(written).path).toBe(1)
    expect(countLineShorthands(written)).toBe(0)

    // The cheap exit the unattached ratchet cannot see alone: delete the PATH and
    // its arm falls to zero — while this count rises by the same cell.
    const deleted = '`:1316` is where it lands'
    expect(cited(deleted).path).toBe(0)
    expect(countLineShorthands(deleted)).toBe(1)

    // The honest repair: the unattached arm falls and this one does not move.
    const converted = '`packages/shared/src/agent/base-agent.ts:1316` symbol `hydrateSessionCostUsdOnce`'
    expect(cited(converted).path).toBe(0)
    expect(countLineShorthands(converted)).toBe(0)
  })
})

describe('the opt-in count check (P6.906)', () => {
  const probe = (command: string, unit: 'files' | 'lines', declared: number, floor = false) =>
    ({ doc: 'l.md', line: 1, command, unit, floor, declared }) as const
  /** The index-grep runner for a case that must never reach one. */
  const neverGrep = (): number => {
    throw new Error('must not run the index grep')
  }

  it('takes only a declaration written in the machine-readable form, and keeps its command', () => {
    const found = collectCountProbes('l.md', [
      'the reader is `git grep -al foo -- packages apps` → **files=3** today, and',
      'a prose count like `git grep -al bar -- packages` → 3 files opts OUT.',
    ].join('\n'))

    expect(found).toEqual([
      { doc: 'l.md', line: 1, command: 'git grep -al foo -- packages apps', unit: 'files', floor: false, declared: 3 },
    ])
  })

  it('reads the FLOOR form, and only a reading below it is a finding (P6.937)', () => {
    const found = collectCountProbes(
      'l.md',
      'the ceiling is spelled `grep -ac network packages/x/config-writer.ts` → **lines>=28** today.',
    )

    expect(found).toEqual([
      {
        doc: 'l.md',
        line: 1,
        command: 'grep -ac network packages/x/config-writer.ts',
        unit: 'lines',
        floor: true,
        declared: 28,
      },
    ])
    // The whole point: the file grows and the sentence stays true. A count of 28
    // drifting to 29 is the shape that went red on a correct sentence (W9-br).
    expect(countIsWrong(found[0] as CountProbe, 29)).toBe(false)
    expect(countIsWrong(found[0] as CountProbe, 28)).toBe(false)
    expect(countIsWrong(found[0] as CountProbe, 27)).toBe(true)
  })

  /**
   * C4.51 (owner, 2026-09-13) — `files>=N` is admitted for a PRESENCE claim.
   *
   * The grammar already accepted the operator on both units — `(files|lines)(>?=)`
   * — and `countIsWrong` was already unit-agnostic, so the parse cost zero. What
   * this arm pins is the ROUND TRIP, which the sheet's own "what would change the
   * letter" named as read-but-not-measured: a `files>=` declaration must reach
   * `CountProbe` with `floor: true` and get the one-sided verdict, not the
   * equality.
   */
  it('C4.51 · reads a files>= FLOOR, so a presence claim can be declared instead of left as prose', () => {
    const found = collectCountProbes(
      'l.md',
      'the reader exists: `git grep -al provenanceGateway -- packages apps` → **files>=3** today.',
    )

    expect(found).toEqual([
      {
        doc: 'l.md',
        line: 1,
        command: 'git grep -al provenanceGateway -- packages apps',
        unit: 'files',
        floor: true,
        declared: 3,
      },
    ])
    // A fourth file naming the key is GROWTH, which is what made the equality
    // ratchet on every sibling commit; a fall to two is the direction that
    // falsifies "this key has a reader".
    expect(countIsWrong(found[0] as CountProbe, 4)).toBe(false)
    expect(countIsWrong(found[0] as CountProbe, 3)).toBe(false)
    expect(countIsWrong(found[0] as CountProbe, 2)).toBe(true)
    // And it still runs: the unit check is the half that needs no child process,
    // and `-l` is present, so a `files>=` probe is not refused for its unit.
    expect(checkCountProbe(found[0] as CountProbe, () => 'a\nb\nc\n', neverGrep))
      .toEqual({ kind: 'count', actual: 3 })
  })

  it('C4.51 · REFUSES a floor of ZERO, which is a check that can never fail', () => {
    // The one line of real code C4.51 ships. The zero carve-out was PROSE ONLY
    // in the docblock: `**files>=0**` parsed, produced a probe `countIsWrong`
    // can never call wrong, and nothing said so — so converting an ABSENCE claim
    // to a floor would have silently deleted the check.
    const zeroFiles = probe('git grep -al zzzNoSuchKey -- packages apps', 'files', 0, true)
    const verdict = checkCountProbe(zeroFiles, () => '', neverGrep)
    expect(verdict.kind).toBe('zero-floor')
    expect((verdict as { why: string }).why).toContain('files=0')

    // Both units, because the defect is in the DECLARATION and not in the unit.
    expect(checkCountProbe(probe('grep -ac zzz packages/x/a.ts', 'lines', 0, true), () => '', neverGrep).kind)
      .toBe('zero-floor')

    // CONTROL — the equality form of the same absence claim is untouched and
    // still runs, which is the arm that proves this is a refusal of the FLOOR
    // and not of the zero.
    expect(checkCountProbe(probe('git grep -al zzzNoSuchKey -- packages apps', 'files', 0), () => '', neverGrep))
      .toEqual({ kind: 'count', actual: 0 })
    // CONTROL — a non-zero floor is not refused.
    expect(checkCountProbe(probe('git grep -al foo -- packages', 'files', 1, true), () => 'a\n', neverGrep))
      .toEqual({ kind: 'count', actual: 1 })
  })

  it('keeps the equality exact, so a floor cannot be read into a plain declaration', () => {
    const exact = probe('grep -ac network packages/x/config-writer.ts', 'lines', 28)

    expect(countIsWrong(exact, 29)).toBe(true)
    expect(countIsWrong(exact, 27)).toBe(true)
    expect(countIsWrong(exact, 28)).toBe(false)
  })

  it('reports a `-c` probe that declares FILES, which is the defect P6.920 was born for', () => {
    // The whole population's original sin: `-c` prints `file:count` per file, so
    // counting its OUTPUT LINES answers *files* and reading its numbers answers
    // *matches*. A sentence saying `files=` beside a command with no `-l` is
    // claiming one and measuring the other, and no child process is needed to
    // see it.
    const verdict = checkCountProbe(probe('git grep -ac foo -- packages', 'files', 3), () => {
      throw new Error('must not run: the unit is wrong before the count matters')
    }, neverGrep)

    expect(verdict.kind).toBe('unit-mismatch')
  })

  it('reports the inverse too — `lines=` beside a `-l` command', () => {
    const verdict = checkCountProbe(probe('git grep -al foo -- packages', 'lines', 3), () => {
      throw new Error('must not run')
    }, neverGrep)

    expect(verdict.kind).toBe('unit-mismatch')
  })

  it('D1.348 · reports `lines=` beside a COUNTING `git grep`, and names both repairs', () => {
    // The third way a declaration can state one unit and measure another, and
    // the one the unit arm passed until now. Measured on the needle that bore
    // the row (2026-09-18, same tree, same minute): `git grep -ain -e
    // inlineComment -e lineComment -e diffComment -- packages apps` prints 71
    // lines, `-acin` prints 7 and `-alin` prints the same 7 — so the counting
    // form's output line is a FILE, exactly as `-l`'s is.
    const verdict = checkCountProbe(probe('git grep -acin foo -- packages apps', 'lines', 7), () => {
      throw new Error('must not run: the unit is wrong before the count matters')
    }, neverGrep)

    expect(verdict.kind).toBe('unit-mismatch')
    // Both spellings, because the gate cannot know which one the author wanted:
    // dropping the `-c` makes the declared 71 right, swapping it for `-l` makes
    // a declared 7 right, and the two are different claims about the tree.
    expect((verdict as { why: string }).why).toContain('lines=')
    expect((verdict as { why: string }).why).toContain('files=')

    // CONTROL — the `files=` direction is UNCHANGED by this arm. The same
    // command declaring `files=` still gets P6.920's own message, so a reader
    // meeting it cannot mistake which rule fired.
    const asFiles = checkCountProbe(probe('git grep -acin foo -- packages apps', 'files', 7), () => {
      throw new Error('must not run')
    }, neverGrep)
    expect(asFiles.kind).toBe('unit-mismatch')
    expect((asFiles as { why: string }).why).toContain('P6.920')
    expect((asFiles as { why: string }).why).not.toContain('D1.348')
  })

  it('D1.348 · does NOT report the one counting form that prints a bare number', () => {
    // The whole population on the day the arm landed: THREE declarations in the
    // five documents carry a counting flag, all three on one line of
    // `2026-08-22-codex-coverage-map.md`, and all three are `grep -c <pattern>
    // <one literal path>` — which prints `30`, not `path:30`. The row's rule as
    // written ("treat a counting flag as a unit mismatch for `lines=`") would
    // have made three false findings and no true ones, so this case is the arm's
    // reason for being narrow and not a nicety.
    const verdict = checkCountProbe(
      probe('grep -a -c -i network packages/codex-responses-adapter/src/config-writer.ts', 'lines', 30),
      () => {
        throw new Error('must not run: a plain grep goes through the index runner')
      },
      () => 30,
    )

    expect(verdict).toEqual({ kind: 'count', actual: 30 })
  })

  it('D1.348 · countsPerFile separates the two counting shapes', () => {
    // Per file: git grep always prefixes the path (a pathspec is not a file
    // argument, so there is no single-file form of it), and a plain grep that
    // names more than one path, or recurses, does the same.
    expect(countsPerFile('git grep -ac foo -- packages')).toBe(true)
    expect(countsPerFile('git grep -acniE foo -- packages apps')).toBe(true)
    expect(countsPerFile('grep -c foo packages/a.ts packages/b.ts')).toBe(true)
    expect(countsPerFile('grep -rc foo packages')).toBe(true)

    // Bare number: exactly `parseGrepCountProbe`'s shape, which is the form
    // `checkCountProbe` reads the printed NUMBER of instead of counting lines.
    expect(countsPerFile('grep -ac foo packages/a.ts')).toBe(false)
    expect(countsPerFile('grep -a -c -i network packages/x/config-writer.ts')).toBe(false)

    // Not counting at all — the arm must be silent on every declaration that
    // does not carry the flag, which is 91 of the 94 today.
    expect(countsPerFile('git grep -al foo -- packages')).toBe(false)
    expect(countsPerFile('git grep -ain -e a -e b -- packages apps')).toBe(false)

    // A metacharacter makes the prose command and the run command different
    // strings; `not-runnable` owns that case and this predicate declines it
    // rather than claiming a unit for a command nobody runs.
    expect(countsPerFile('git grep -ac foo -- packages | wc -l')).toBe(false)
    expect(countsPerFile("grep -ac 'un balanced packages/a.ts")).toBe(false)
  })

  it('refuses a shell-expanded glob and a pipe, rather than guessing', () => {
    // A plain `grep` with a `*.ts` glob means one thing after shell expansion and
    // another without it — AGENTS.md's own trap, and the reason this check is
    // deliberately narrower than the population it reads. P6.933 widened the
    // check to a counting `grep` over one LITERAL path; this one is neither.
    const shellGlob = checkCountProbe(probe('grep -rna 4096 packages/x/*.ts', 'lines', 8), () => {
      throw new Error('must not run')
    }, neverGrep)
    const piped = checkCountProbe(probe('git grep -al foo -- packages | wc -l', 'files', 3), () => {
      throw new Error('must not run')
    }, neverGrep)

    expect(shellGlob.kind).toBe('not-runnable')
    expect(piped.kind).toBe('not-runnable')
  })

  it('counts the output lines of a probe it does run', () => {
    const verdict = checkCountProbe(probe('git grep -al foo -- packages', 'files', 2), () => 'a\nb\n', neverGrep)

    expect(verdict).toEqual({ kind: 'count', actual: 2 })
  })

  it('splits a quoted pathspec into ONE argv element — the `:(glob)` forms depend on it', () => {
    expect(splitProbeArgv("git grep -al x -- ':(glob)packages/**/*.ts' apps"))
      .toEqual(['grep', '-al', 'x', '--', ':(glob)packages/**/*.ts', 'apps'])
    expect(splitProbeArgv("git grep -al 'un balanced")).toBeUndefined()
  })

  it('handles a NESTED quote the way a shell does — the outer pair is the quoting one', () => {
    // Not hypothetical, and the direction is the point. A real declaration
    // writes its pattern as `"'/init'"`, and `sh` strips the OUTER double pair
    // and leaves the inner single quotes IN the pattern. The first version of
    // this splitter knew only single quotes, so it did the reverse — kept the
    // outer, stripped the inner — and searched for a token no file contains. It
    // answered 0 against a declared 1 and the gate reported a correct sentence
    // as wrong on the day it landed. Reproducing the shell is the whole
    // requirement, because the string in the prose is what a reader will paste.
    expect(splitProbeArgv('git grep -alin "\'/init\'" -- packages apps'))
      .toEqual(['grep', '-alin', "'/init'", '--', 'packages', 'apps'])
  })

  it('reads the file-listing flag out of a BUNDLE, not just a bare `-l`', () => {
    // Every real declaration in these documents writes it bundled — `-al`,
    // `-ail`, `-alin` — so a check keyed on a standalone `-l` would call every
    // one of them a unit mismatch and be deleted within a day.
    expect(listsFileNames('git grep -al x -- packages')).toBe(true)
    expect(listsFileNames('git grep -ail x -- packages')).toBe(true)
    expect(listsFileNames('git grep -alin x -- packages')).toBe(true)
    expect(listsFileNames('git grep -ac x -- packages')).toBe(false)
    expect(listsFileNames('git grep -a x -- packages')).toBe(false)
  })

  it('reads a metacharacter INSIDE single quotes as literal, the way every shell does (P6.933)', () => {
    // The widening's whole population. Measured before the change: of sixteen
    // distinct commands carried as unit-checked-only, TWELVE were refused for a
    // character inside single quotes — eleven a `:(glob)` pathspec, one an
    // escaped dot. The row named the ALTERNATION pattern; alternation and the
    // glob pathspec are one defect seen twice, because both are quoted.
    expect(unquotedShellMetachar("git grep -al x -- ':(glob)packages/**'")).toBe(false)
    expect(unquotedShellMetachar("git grep -ac 'a\\|b' -- packages")).toBe(false)
    expect(unquotedShellMetachar("git grep -al 'openai\\.yaml' -- packages apps")).toBe(false)

    // And the negatives, which are what keep the widening from being a hole: a
    // real pipe, a real substitution, and a glob the SHELL would expand before
    // git ever saw it (AGENTS.md's pathspec trap).
    expect(unquotedShellMetachar('git grep -al foo -- packages | wc -l')).toBe(true)
    expect(unquotedShellMetachar('git grep -al $(cat x) -- packages')).toBe(true)
    expect(unquotedShellMetachar('grep -rna 4096 packages/x/*.ts')).toBe(true)
    expect(unquotedShellMetachar('git grep -al "$HOME" -- packages')).toBe(true)
  })

  it('accepts a counting `grep` over ONE literal path, and refuses every wider shape (P6.933)', () => {
    expect(parseGrepCountProbe(['-ac', 'network_access =', 'packages/x/config-writer.ts']))
      .toEqual({ flags: ['-ac'], pattern: 'network_access =', path: 'packages/x/config-writer.ts' })
    // Split flags are the form one real declaration uses.
    expect(parseGrepCountProbe(['-a', '-c', '-i', 'network', 'packages/x/config-writer.ts']))
      .toEqual({ flags: ['-a', '-c', '-i'], pattern: 'network', path: 'packages/x/config-writer.ts' })

    // No `-c` at all: its output is matching LINES, not a count, so the runner
    // that parses a number would parse the first line of the file.
    expect(parseGrepCountProbe(['-a', 'x', 'packages/x/a.ts'])).toBeUndefined()
    // `-r` and a second file both make the output `path:count` lines rather than
    // a bare number — the exact unit confusion P6.920 was born for.
    expect(parseGrepCountProbe(['-rc', 'x', 'packages/x'])).toBeUndefined()
    expect(parseGrepCountProbe(['-ac', 'x', 'packages/x/a.ts', 'packages/x/b.ts'])).toBeUndefined()
    // A bare word is not a path, and a listing flag is refused here as well as
    // by `listsFileNames`.
    expect(parseGrepCountProbe(['-ac', 'x', 'packages'])).toBeUndefined()
    expect(parseGrepCountProbe(['-alc', 'x', 'packages/x/a.ts'])).toBeUndefined()
  })

  it('counts a `grep -c` probe by PARSING its number, never by counting its output lines (P6.933)', () => {
    // The trap this widening had to avoid: a counting grep prints exactly ONE
    // line whichever way it ends, so a line-counting runner answers 1 for a
    // declared 0 and for a declared 400 alike. Four of one sweep's forty-five
    // "stated 0, now non-zero" refutations were that artefact.
    const verdict = checkCountProbe(
      probe("grep -ac 'x' packages/x/a.ts", 'lines', 7),
      () => {
        throw new Error('must not reach the git-grep runner')
      },
      grepProbe => {
        expect(grepProbe.path).toBe('packages/x/a.ts')
        return 7
      },
    )

    expect(verdict).toEqual({ kind: 'count', actual: 7 })
  })

  it('says so when a `grep` probe names a path the index does not hold (P6.933)', () => {
    // Not counted as zero. A probe that cannot run must never be silently
    // counted as a match of nothing — that is the dead-control shape.
    const verdict = checkCountProbe(
      probe("grep -ac 'x' packages/gone/a.ts", 'lines', 0),
      () => {
        throw new Error('must not reach the git-grep runner')
      },
      () => undefined,
    )

    expect(verdict.kind).toBe('not-runnable')
  })

  it('runs every `git grep` probe against the INDEX, not the working tree (P6.933)', () => {
    // Caught live while this widening was being built: `git grep -ail RRULE --
    // packages apps` was declared 39 and the gate answered 41, then 42 two
    // minutes later — red on a correct sentence, because `git grep` with no
    // commit reads the WORKING TREE and a sibling lane had three uncommitted
    // files carrying the word. Against the index the same command answers 39.
    // The flag goes after the subcommand, which is the only position git takes.
    expect(withCachedFlag(['grep', '-al', 'x', '--', 'packages'])).toEqual(
      ['grep', '--cached', '-al', 'x', '--', 'packages'],
    )
  })

  it('has a NON-EMPTY population in the real documents — the condition P6.906 was held on', () => {
    // W9-bi measured this at ZERO on 2026-09-08 and left the row open with the
    // number; P6.905's re-runs converted probes as it checked them. A count here
    // rather than a name, because the subjects are prose and will move — but a
    // gate with no subjects is the thing this assertion exists to catch.
    const declared = LEDGERS.flatMap(
      doc => collectCountProbes(doc, readFileSync(join(REPO_ROOT, doc), 'utf-8')),
    )

    expect(declared.length).toBeGreaterThan(20)
    expect(declared.some(found => found.command.startsWith('git grep '))).toBe(true)
  })
})

describe('the escaped-alternation arm (D1.337)', () => {
  const probe = (command: string, doc = 'docs/specs/gaps.md', line = 1): CountProbe =>
    ({ doc, line, command, unit: 'lines', floor: false, declared: 0 })

  it('finds the shape that is already DECLARED and re-run — P6.306\'s sibling', () => {
    // The instance the row was born for, verbatim from `denominator-gaps:310`.
    // It declares `lines=0`, the count arm re-runs it, git answers 0, and the
    // declaration reads as checked — while the same needles under a real
    // alternation answer 7 files on the same pathspec the same minute.
    const found = findEscapedAlternationProbes([
      probe('git grep -acniE \'inlineComment\\|lineComment\\|diffComment\' -- packages apps'),
    ])

    expect(found).toHaveLength(1)
    expect(found[0]?.flag).toBe('-acniE')
    expect(found[0]?.pattern).toBe('inlineComment\\|lineComment\\|diffComment')
  })

  it('leaves the SAME pattern alone under the default engine, where it really is an alternation', () => {
    // The negative that makes the finding mean something: drop the `-E` and the
    // command is correct, so a rule that charged the two characters alone would
    // fire on every correct basic-regex probe in these documents — and there are
    // more of those than there are defects.
    expect(findEscapedAlternationProbes([
      probe('git grep -acni \'inlineComment\\|lineComment\\|diffComment\' -- packages apps'),
    ])).toEqual([])
    // `-G` spells the same engine explicitly.
    expect(findEscapedAlternationProbes([
      probe('git grep -acniG \'inlineComment\\|lineComment\' -- packages apps'),
    ])).toEqual([])
  })

  it('leaves an `-E` command whose alternation is a REAL pipe alone', () => {
    // The repair itself must not be a finding, or the gate would refuse the only
    // spelling that works.
    expect(findEscapedAlternationProbes([
      probe('git grep -acniE \'inlineComment|lineComment|diffComment\' -- packages apps'),
    ])).toEqual([])
  })

  it('reads `-E`/`-P` inside a flag CLUSTER and in the long spelling, not only as a bare flag', () => {
    // Every real instance in these documents hides the engine in a cluster
    // (`-aEil`, `-aiE`, `-acniE`), so a rule matching a bare `-E` would have
    // found ZERO of the eleven.
    expect(findEscapedAlternationProbes([probe('git grep -aciE \'a\\|b\' -- packages')])).toHaveLength(1)
    expect(findEscapedAlternationProbes([probe('git grep -aEil \'a\\|b\' -- packages')])).toHaveLength(1)
    expect(findEscapedAlternationProbes([probe('git grep -aln -E \'a\\|b\' -- packages')])[0]?.flag).toBe('-E')
    expect(findEscapedAlternationProbes([probe('git grep -al --perl-regexp \'a\\|b\' -- packages')]))
      .toHaveLength(1)
    // A plain `grep` over one file is the count arm's other runnable shape and
    // carries the identical defect.
    expect(findEscapedAlternationProbes([probe('grep -acE \'a\\|b\' packages/shared/src/x.ts')]))
      .toHaveLength(1)
  })

  it('takes the LAST engine flag, and never reads a pathspec as a pattern', () => {
    // Both directions of the scan, each of which would be a misfire nobody could
    // explain from the message: git takes the last engine flag on the line, so
    // `-E … -G` is a basic-regex command and correct; and after `--` every token
    // is a pathspec, where these two characters are not this defect.
    expect(findEscapedAlternationProbes([probe('git grep -aE -G \'a\\|b\' -- packages')])).toEqual([])
    expect(findEscapedAlternationProbes([probe('git grep -aiE zzz -- \'packages/a\\|b\'')])).toEqual([])
    // CONTROL for the pair above, on the same instrument: the same two commands
    // with the engine last and the pattern before the separator ARE findings.
    expect(findEscapedAlternationProbes([probe('git grep -aG -E \'a\\|b\' -- packages')])).toHaveLength(1)
    expect(findEscapedAlternationProbes([probe('git grep -aiE \'a\\|b\' -- packages/a')])).toHaveLength(1)
  })

  it('keys on the DOCUMENT and the COMMAND, never on the line', () => {
    // The C3.297 invariant this file states for every other arm, plus the reason
    // the line is the wrong half here: these documents move a cell's line on
    // every pinning commit, while the command is exactly what a repair changes.
    const command = 'git grep -aiE \'a\\|b\' -- packages'
    const here = findEscapedAlternationProbes([probe(command, 'docs/specs/gaps.md', 1)])[0]!
    const moved = findEscapedAlternationProbes([probe(command, 'docs/specs/gaps.md', 900)])[0]!
    expect(escapedAlternationBaselineKey(here))
      .toBe(`docs/specs/gaps.md::escaped-alternation=${command}`)
    expect(escapedAlternationBaselineKey(here)).toBe(escapedAlternationBaselineKey(moved))
    // The twin documents carry the same command, so the document is part of the
    // key: one repair, two entries, each visible on its own.
    expect(escapedAlternationBaselineKey(findEscapedAlternationProbes([
      probe(command, 'docs/specs/ledger.md', 1),
    ])[0]!)).not.toBe(escapedAlternationBaselineKey(here))
  })

  it('reaches the plan census, so this class cannot accumulate unseen in the plan', () => {
    // The member is REQUIRED on `PlanCensusInput` for the reason D1.317's is: a
    // member a caller may forget is one the ratchet silently stops counting.
    const command = 'git grep -aiE \'a\\|b\' -- packages'
    const census = planFindingCensus({
      dead: [], lines: [], identifiers: [], rows: [], symbols: [], anchors: [], splitRows: [], controls: [],
      dialects: findEscapedAlternationProbes([
        probe(command, PLAN_DOC, 12),
        // The spec-side one is dropped, like every other arm's: it has an owner.
        probe(command, 'docs/superpowers/specs/2026-09-05-denominator-gaps.md', 9),
      ]),
    })

    expect(census.keys).toEqual([`${PLAN_DOC}::escaped-alternation=${command}`])
  })

  it('leaves every gated document with its findings BASELINED at HEAD', () => {
    // Not a declared count, for the reason D1.317's sibling case gives: the
    // instances are the controller's to re-spell and a number here would go red
    // on the repair itself (AGENTS.md §Traps, W18-a). What is invariant is that
    // nothing is FRESH. The positive control for this instrument is the fixture
    // above — the same function finds the P6.306 shape when handed one.
    const baseline = readBaseline()
    const fresh: string[] = []
    for (const doc of LEDGERS) {
      const declared = collectCountProbes(doc, readFileSync(join(REPO_ROOT, doc), 'utf-8'))
      for (const finding of findEscapedAlternationProbes(declared)) {
        if (!baseline.has(escapedAlternationBaselineKey(finding))) fresh.push(`${finding.doc}:${finding.line}`)
      }
    }
    expect(fresh).toEqual([])
  })
})

describe('the pin rewriter (P6.999)', () => {
  // Four numbers that were lowered by HAND until this row, in a file where each
  // of the four is also spelled in prose a dozen times. These pin the three
  // things the flag has to get right: the deltas it prints, the raise it
  // refuses, and the bytes it writes.
  //
  // Deliberately NOT asserted here: that the live census equals the pins. The
  // gate itself fails on that, and a test repeating it turns one controller
  // commit into two reds — the same reason the three ratchet blocks above give.
  const reading = (constant: string, pinned: number, live: number) => ({ constant, pinned, live })

  it('prints a line per pin — unchanged included — and splits the updates from the raises', () => {
    const plan = planPins([
      reading('PINNED_PLAN_FINDINGS', 176, 173),
      reading('PINNED_UNATTACHED_PATH', 1422, 1422),
      reading('PINNED_SHORTHAND', 1851, 1860),
    ])

    // Every pin gets a line: "current" and "not looked at" must not read alike.
    expect(plan.lines).toEqual([
      '  PINNED_PLAN_FINDINGS FELL by 3: 176 -> 173.',
      '  PINNED_UNATTACHED_PATH unchanged at 1422.',
      '  PINNED_SHORTHAND ROSE by 9: 1851 -> 1860.',
    ])
    expect(plan.updates.map(update => update.constant))
      .toEqual(['PINNED_PLAN_FINDINGS', 'PINNED_SHORTHAND'])
    expect(plan.raises.map(raise => raise.constant)).toEqual(['PINNED_SHORTHAND'])
  })

  it('the raise refusal names both numbers and the one thing that makes a raise legitimate', () => {
    const refusal = pinRaiseRefusal([reading('PINNED_UNATTACHED_BARE', 663, 776)])

    expect(refusal).toBeInstanceOf(GateSafetyRefusal)
    expect(refusal.message).toContain('PINNED_UNATTACHED_BARE 663 -> 776')
    // The legitimate raise, in the words the header uses: a DOCUMENT joining
    // LEDGERS. Without this sentence the refusal is a wall, and a lane meeting a
    // wall re-types the digit, which is what this row exists to stop.
    expect(refusal.message).toContain('DOCUMENT JOINS LEDGERS')
    expect(refusal.message).toContain('--pin --allow-raise')
  })

  it('rewrites the DECLARATION and leaves prose naming the same constant alone', () => {
    const source = [
      ' * P6.989 raised it: the pins went 1238 -> 1422 in the same commit.',
      ' * See {@link PINNED_UNATTACHED_PATH} for both arms.',
      'export const PINNED_UNATTACHED_PATH = 1422',
      'export const PINNED_SHORTHAND = 1_851',
      'const other = PINNED_UNATTACHED_PATH + 1',
    ].join('\n')

    const out = rewritePinnedConstants(source, [
      { constant: 'PINNED_UNATTACHED_PATH', pinned: 1422, live: 1400 },
      { constant: 'PINNED_SHORTHAND', pinned: 1851, live: 1840 },
    ])

    expect(out).toContain('export const PINNED_UNATTACHED_PATH = 1400')
    // The underscored literal is a declaration too, and its replacement is plain.
    expect(out).toContain('export const PINNED_SHORTHAND = 1840')
    // The two sentences and the reader are byte-identical: a `1238 -> 1422` in a
    // docblock is the near-miss a hand edit actually makes.
    expect(out).toContain('the pins went 1238 -> 1422 in the same commit')
    expect(out).toContain('const other = PINNED_UNATTACHED_PATH + 1')
  })

  it('refuses when the declaration is absent or duplicated, rather than rewriting the first thing', () => {
    expect(() => rewritePinnedConstants('export const OTHER = 1', [
      { constant: 'PINNED_SHORTHAND', pinned: 1851, live: 1840 },
    ])).toThrow(GateSafetyRefusal)
    expect(() => rewritePinnedConstants(
      'export const PINNED_SHORTHAND = 1851\nexport const PINNED_SHORTHAND = 1851\n',
      [{ constant: 'PINNED_SHORTHAND', pinned: 1851, live: 1840 }],
    )).toThrow(GateSafetyRefusal)
  })

  it('lowers all four on a COPY of the real script, and touches nothing else in it', () => {
    // A copy under a temp dir, never the tracked file: pinning the gate from a
    // test would rewrite the thing under test and leave the tree different from
    // how it found it.
    const source = join(REPO_ROOT, PIN_FILE)
    const before = readFileSync(source, 'utf-8')
    const dir = mkdtempSync(join(tmpdir(), 'ledger-citation-pin-'))
    const copy = join(dir, 'check-ledger-citations.ts')
    try {
      writeFileSync(copy, before, 'utf-8')
      rewritePinsInFile(copy, [
        { constant: 'PINNED_PLAN_FINDINGS', pinned: PINNED_PLAN_FINDINGS, live: PINNED_PLAN_FINDINGS - 1 },
        { constant: 'PINNED_UNATTACHED_PATH', pinned: PINNED_UNATTACHED_PATH, live: PINNED_UNATTACHED_PATH - 1 },
        { constant: 'PINNED_UNATTACHED_BARE', pinned: PINNED_UNATTACHED_BARE, live: PINNED_UNATTACHED_BARE - 1 },
        { constant: 'PINNED_SHORTHAND', pinned: PINNED_SHORTHAND, live: PINNED_SHORTHAND - 1 },
      ])
      const after = readFileSync(copy, 'utf-8')

      expect(after).toContain(`export const PINNED_PLAN_FINDINGS = ${PINNED_PLAN_FINDINGS - 1}`)
      expect(after).toContain(`export const PINNED_UNATTACHED_PATH = ${PINNED_UNATTACHED_PATH - 1}`)
      expect(after).toContain(`export const PINNED_UNATTACHED_BARE = ${PINNED_UNATTACHED_BARE - 1}`)
      expect(after).toContain(`export const PINNED_SHORTHAND = ${PINNED_SHORTHAND - 1}`)
      // FOUR lines moved and no more — the guard against a replace that also
      // caught a sentence, which no `toContain` above could see.
      const beforeLines = before.split('\n')
      const changed = after.split('\n').filter((line, at) => line !== beforeLines[at])
      expect(changed).toHaveLength(4)
      // And the tracked file is exactly where it was.
      expect(readFileSync(source, 'utf-8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('PIN_FILE is the path the four report messages spell, and it is this file', () => {
    // The path is derived from `import.meta.url` so a rename cannot leave --pin
    // writing something else; the four "lower X in <path>" strings are literals.
    // This is the only thing tying the two spellings together.
    expect(PIN_FILE).toBe('scripts/check-ledger-citations.ts')
    const source = readFileSync(join(REPO_ROOT, PIN_FILE), 'utf-8')
    expect(source).toContain(`lower PINNED_SHORTHAND to \${count} in ${PIN_FILE}`)
    for (const constant of [
      'PINNED_PLAN_FINDINGS', 'PINNED_UNATTACHED_PATH', 'PINNED_UNATTACHED_BARE', 'PINNED_SHORTHAND',
    ]) {
      expect(source.match(new RegExp(`export const ${constant} = [0-9_]+`, 'g'))).toHaveLength(1)
    }
  })
})
