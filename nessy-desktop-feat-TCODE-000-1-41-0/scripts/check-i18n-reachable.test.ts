/**
 * Tests for `check-i18n-reachable.ts` — P2.490.
 *
 * The interesting assertions are the two that decide whether this gate is worth
 * having, and they pull in opposite directions:
 *
 *   - it must catch the key that BOTH existing i18n gates pass — present in
 *     every locale, correctly sorted, and read by nobody;
 *   - it must not cry wolf on a key composed at runtime, which is the reason a
 *     reader-side scan was never written before.
 *
 * The third is the one that keeps it honest a year from now: a dotted prefix
 * nobody has classified must REFUSE, because a prefix silently trusted exempts
 * a whole namespace, and a prefix silently ignored condemns one.
 */

import { describe, expect, test } from 'bun:test'

import {
  analyse,
  classifyDrift,
  collectReferences,
  collectReferencesFromText,
  isScannableSource,
  isTestFile,
  parseLedger,
  PREFIX_VERDICTS,
  renderLedger,
  scannedFiles,
  UNREACHABLE_LEDGER,
  untrackedReaders,
} from './check-i18n-reachable'

/** A reference set built by hand, so a case states exactly what the tree holds. */
function references(exact: string[], prefixes: Record<string, string>) {
  return {
    exact: new Set(exact),
    prefixSites: new Map(Object.entries(prefixes)),
  }
}

describe('check-i18n-reachable', () => {
  test('a key in every locale, correctly sorted, and read by nobody is UNREACHABLE', () => {
    // The z-w14 defect in miniature: `lint:i18n:parity` and `lint:i18n:sorted`
    // both exit 0 on this input, because neither of them looks at a reader.
    const analysis = analyse(
      ['chat.attachFiles', 'chat.piRuntime.title'],
      references(['chat.attachFiles'], {}),
    )

    expect(analysis.unreachable).toEqual(['chat.piRuntime.title'])
  })

  test('a key composed at runtime is NOT reported — the false positive that blocked this gate', () => {
    const analysis = analyse(
      ['status.needs-review', 'status.done'],
      references([], { 'status.': 'renderer/ActiveOptionBadges.tsx' }),
    )

    expect(PREFIX_VERDICTS['status.']).toBe('composes-keys')
    expect(analysis.unreachable).toEqual([])
  })

  test('a prefix classified not-a-key exempts nothing', () => {
    // `automations.` is a VALIDATION DIAGNOSTIC PATH in `shared/automations/
    // validation.ts` that happens to spell a locale namespace. Trusting it would
    // mark every `automations.*` key reachable on the strength of an error
    // message that reads none of them.
    const analysis = analyse(
      ['automations.editFile'],
      references([], { 'automations.': 'packages/shared/src/automations/validation.ts' }),
    )

    expect(PREFIX_VERDICTS['automations.']).toBe('not-a-key')
    expect(analysis.unreachable).toEqual(['automations.editFile'])
  })

  test('the two prefixes that made this gate REFUSE are not-a-key, and their namespaces stay on their own readers — P6.637', () => {
    // Both landed as a committed red: `capability.` from
    // `server-core/src/bootstrap/storage-runtime.ts`, where
    // `` `capability.${event.kind}.changed` `` is the REASON string handed to
    // `capabilityResolver.invalidate(scope, reason, effect)` — a plain `string`
    // parameter, never translated. `filter.` from
    // `server-core/src/pi-harness/worktree-git-plan.ts`, where it is the git
    // CONFIG namespace whose smudge/clean/process drivers that file suppresses.
    // Each namespace does hold real locale keys (three `capability.instruction.*`
    // diagnostics, `filter.include`/`filter.exclude`), which is exactly why the
    // verdict must exempt nothing: all five are reached by their own exact
    // readers in `context-overlay.tsx`, `resolver.ts` and `AppShell.tsx`, and the
    // gate must keep checking that rather than waving the namespace through.
    expect(PREFIX_VERDICTS['capability.']).toBe('not-a-key')
    expect(PREFIX_VERDICTS['filter.']).toBe('not-a-key')

    const analysis = analyse(
      ['capability.instruction.overSizeLimit', 'filter.include', 'filter.exclude'],
      references(['capability.instruction.overSizeLimit', 'filter.include'], {
        'capability.': 'packages/server-core/src/bootstrap/storage-runtime.ts',
        'filter.': 'packages/server-core/src/pi-harness/worktree-git-plan.ts',
      }),
    )

    expect(analysis.unreachable).toEqual(['filter.exclude'])
  })

  test('a TEST is not a reader, whatever it quotes — P2.520(a)', () => {
    // The under-report the gate shipped with. A stub translation map answers
    // every key its component might ask for, so `'mcpServers.originUser': 'User'`
    // in a fixture made a key nothing in the product asks for score reachable.
    // Eight keys were hidden that way, three of them while production read a
    // DIFFERENTLY SPELLED key — the shape a stub map cannot help hiding, because
    // it is written from the key list rather than from the caller.
    expect(isTestFile('apps/electron/src/renderer/components/app-shell/__tests__/McpServersPanel.test.tsx')).toBe(true)
    expect(isTestFile('packages/shared/src/config/__tests__/fixtures/proxy-env-spread-probe.ts')).toBe(true)
    expect(isTestFile('apps/electron/src/renderer/playground/__tests__/session-goal-registry.test.tsx')).toBe(true)

    // And the direction that would have been a defect: the playground SHIPS in
    // the renderer bundle, so a key only it reads is reachable by a user. Only
    // its `__tests__` drop out.
    expect(isTestFile('apps/electron/src/renderer/playground/registry/automations.tsx')).toBe(false)
    expect(isTestFile('apps/electron/src/renderer/components/app-shell/McpServersPanel.tsx')).toBe(false)
    // A directory merely CONTAINING the word is not a test directory.
    expect(isTestFile('packages/shared/src/contests/entry.ts')).toBe(false)
    expect(isTestFile('scripts/latest.ts')).toBe(false)

    const files = scannedFiles()
    expect(files.some((f) => isTestFile(f))).toBe(false)
  })

  test('a key quoted only in PROSE is not a reader', () => {
    // The docblock of `pi-runtime-control-center-keys.test.ts` quotes
    // `chat.piRuntime.title` verbatim as its own mutation recipe. Scanning
    // comments made that quote an EXACT match, so planting the key back into both
    // locales came out green — a dead control produced by the tree's house style
    // of quoting exact tokens.
    const src = `/**\n * Mutation probe: put one "chat.piRuntime.title" back into en.json.\n */\n`
    const refs = collectReferencesFromText(src)

    expect(refs.exact.has('chat.piRuntime.title')).toBe(false)
  })

  test('an unclassified prefix REFUSES instead of silently exempting a namespace', () => {
    const analysis = analyse(
      ['brandNew.alpha', 'brandNew.beta'],
      references([], { 'brandNew.': 'renderer/SomeNewPanel.tsx' }),
    )

    expect(analysis.unclassified).toEqual(['brandNew.'])
    // And it exempts nothing while it is unclassified, so the refusal cannot be
    // ignored into a quiet pass.
    expect(analysis.unreachable).toEqual(['brandNew.alpha', 'brandNew.beta'])
  })

  test('a prefix that matches no key never reaches the classification', () => {
    // `Body.` and `icon.` are quoted dotted literals in this tree. Demanding a
    // verdict for every one of them would make the list unmaintainable, which is
    // how an enumeration stops being read.
    const analysis = analyse(['chat.attachFiles'], references(['chat.attachFiles'], { 'Body.': 'x.ts' }))

    expect(analysis.derivedPrefixes).toEqual([])
    expect(analysis.unclassified).toEqual([])
  })

  test('a plural variant is reached through its base key', () => {
    const analysis = analyse(
      ['chat.filesCount', 'chat.filesCount_one', 'chat.filesCount_other'],
      references(['chat.filesCount'], {}),
    )

    expect(analysis.unreachable).toEqual([])
  })

  test('a plural variant whose base has no reader is still unreachable', () => {
    const analysis = analyse(
      ['time.daysAgo_one', 'time.daysAgo_other'],
      references([], {}),
    )

    expect(analysis.unreachable).toEqual(['time.daysAgo_one', 'time.daysAgo_other'])
  })

  test('a stale verdict is refused, so the enumeration cannot rot quietly', () => {
    const analysis = analyse(['chat.attachFiles'], references(['chat.attachFiles'], {}))

    // Every recorded verdict has vanished from this synthetic tree, so all of
    // them read as stale — which is the direction that ages, and the direction
    // a gate normally forgets to check.
    expect(analysis.staleVerdicts).toEqual(Object.keys(PREFIX_VERDICTS).sort())
  })

  test('a DELETED ledger key is not reported as newly readable — P2.520(b)', () => {
    // The exact operation P2.519 performs: `plugins.unknown` was recorded as
    // unreachable and has now been removed from both locales. It is gone from
    // `keys`, so it is gone from `unreachable` — and the gate used to conclude
    // from that that someone had WIRED it. Told the inverse of what they did, the
    // lane doing the deleting reverts it.
    const drift = classifyDrift(
      ['plugins.unknown', 'plugins.version'],
      ['plugins.version', 'plugins.search'],
      ['plugins.version'],
    )

    expect(drift.deleted).toEqual(['plugins.unknown'])
    expect(drift.revived).toEqual([])
    expect(drift.newlyUnreachable).toEqual([])
  })

  test('a WIRED ledger key is still reported as newly readable', () => {
    // The other half, and the one the collapsed message got right by accident —
    // it has to keep working, or the separation traded one wrong answer for
    // another. `plugins.search` is still a key and now has a reader.
    const drift = classifyDrift(
      ['plugins.search'],
      ['plugins.search', 'plugins.version'],
      ['plugins.version'],
    )

    expect(drift.revived).toEqual(['plugins.search'])
    expect(drift.deleted).toEqual([])
    expect(drift.newlyUnreachable).toEqual(['plugins.version'])
  })

  test('the ledger round-trips, and its comment lines are not keys', () => {
    const rendered = renderLedger(['a.b', 'c.d'])

    expect(rendered.startsWith('#')).toBe(true)
    expect(parseLedger(rendered)).toEqual(['a.b', 'c.d'])
  })

  test('the gate is not its own witness', () => {
    // Both of this row's files state locale keys as literals — the fixtures in
    // this file, and every dotted entry of PREFIX_VERDICTS in the gate. Tracked
    // and scanned, the fixtures revived three recorded keys and turned
    // `bun run lint` red for the whole fleet, and the gate's own constant would
    // have derived every prefix it classifies, so the staleness check could never
    // fire. Neither mistake is visible until the file stops being untracked,
    // which is one commit too late.
    const files = scannedFiles()

    expect(files).not.toContain('scripts/check-i18n-reachable.ts')
    expect(files).not.toContain('scripts/check-i18n-reachable.test.ts')
    // The sibling gate is NOT excluded — only self-witness is, so the exclusion
    // cannot quietly widen into "skip the scripts directory".
    expect(files).toContain('scripts/check-exports-map.ts')
  })

  // An EXPLICIT budget, set against a measured floor rather than left at bun's
  // 5 s default — the trap AGENTS.md names as "a timeout with zero assertion
  // failures". This case shells out to `git ls-files` over the whole tree and
  // then reads every app-shell renderer file, so it is seconds of real work, not
  // a hung hook. Measured 2026-09-03 on this box: 11.8 s ALONE at load 15, 20.7 s
  // inside a six-file batch under eight concurrent lanes, and under 5 s once at
  // low load — which is how it ever passed. A default budget on a subject whose
  // floor is that high is a red light wired to the machine's mood; 60 s still
  // catches a threefold regression.
  test('the real tree is scanned, and a live key is found in it (not vacuous)', () => {
    const files = scannedFiles()
    // Positive control on the enumeration itself: an empty or tiny file list
    // would make every reachability claim in this suite true by knowing nothing.
    expect(files.length).toBeGreaterThan(1000)

    // Scanning all of them costs ~30s under load, and `lint:i18n:reachable`
    // already does exactly that on every run — so this asserts the SCANNER
    // works against real source, and the tree-wide ledger agreement stays the
    // gate's job rather than a duplicate that only makes the suite slow.
    const renderer = files.filter((f) => f.startsWith('apps/electron/src/renderer/components/app-shell/'))
    expect(renderer.length).toBeGreaterThan(20)

    const refs = collectReferences(renderer)
    expect(refs.exact.has('chat.attachFiles')).toBe(true)
    expect(refs.prefixSites.has('status.')).toBe(true)
    expect(refs.exact.has('status.')).toBe(false)
  }, 60_000)

  /**
   * DA1.62 — the gate enumerates with `git ls-files`, so a reader that is not
   * committed yet is invisible to it and its key reads as rot; measured
   * 2026-09-17, five `chat.modelPicker.provenance*` keys were reported "became
   * unreachable" while the only file reading them sat untracked, and the gate's
   * own advice at that moment was to delete them.
   *
   * The annotation is what these arms price. The list stays an ANNOTATION on a
   * verdict already taken from the tracked tree — never an input — so the seams
   * below are also the reason no fixture is planted in the working tree: an
   * untracked fixture is exactly what the real enumeration would pick up, in a
   * tree six other lanes are editing.
   */
  test('an untracked file is named as the reader of a key the tracked scan cannot see', () => {
    const sources: Record<string, string> = {
      'apps/electron/src/renderer/components/ModelListDisclosures.tsx':
        "export const label = t('chat.modelPicker.provenanceGateway')",
      'packages/shared/src/agent/composer.ts':
        'const key = `chat.submit.${id}`',
    }
    const files = Object.keys(sources)
    const read = (file: string): string => sources[file] ?? ''

    const found = untrackedReaders(
      ['chat.modelPicker.provenanceGateway', 'chat.submit.send', 'chat.attachFiles'],
      files,
      read,
    )

    expect(found.get('chat.modelPicker.provenanceGateway'))
      .toBe('apps/electron/src/renderer/components/ModelListDisclosures.tsx')
    // A `composes-keys` prefix answers for its namespace here exactly as it does
    // in the tracked scan — the two must not disagree about what a reader is.
    expect(found.get('chat.submit.send')).toBe('packages/shared/src/agent/composer.ts')
    // The negative in the same run: a key nothing untracked quotes gets no
    // arrow, so the annotation cannot excuse every failure at once.
    expect(found.has('chat.attachFiles')).toBe(false)
  })

  test('a key quoted only in an untracked file\'s PROSE is still not a reader', () => {
    const file = 'apps/electron/src/renderer/Draft.tsx'
    const found = untrackedReaders(
      ['chat.attachFiles'],
      [file],
      () => "// TODO: wire up 'chat.attachFiles' before shipping\nexport const x = 1",
    )

    // The boundary: comments are blanked before the scan, so the untracked
    // annotation cannot be kinder than the gate it annotates — otherwise a
    // half-written file would silence a real rot finding.
    expect(found.size).toBe(0)
  })

  test('both enumerations share one filter, so untracked cannot scan what tracked skips', () => {
    expect(isScannableSource('apps/electron/src/renderer/components/ModelListDisclosures.tsx')).toBe(true)
    expect(isScannableSource('packages/shared/src/agent/__tests__/anything.ts')).toBe(false)
    expect(isScannableSource('scripts/check-i18n-reachable.ts')).toBe(false)
    expect(isScannableSource('.references/vendor/thing.ts')).toBe(false)
    expect(isScannableSource('packages/shared/src/i18n/locales/en.json.ts')).toBe(false)
    expect(isScannableSource('')).toBe(false)
  })

  test('the ledger on disk is a list of keys, not a stale file nobody regenerated', async () => {
    const recorded = parseLedger(await Bun.file(UNREACHABLE_LEDGER).text())

    expect(recorded.length).toBeGreaterThan(0)
    expect([...recorded].sort()).toEqual(recorded)
    expect(recorded.every((key) => key.includes('.'))).toBe(true)
  })
})
