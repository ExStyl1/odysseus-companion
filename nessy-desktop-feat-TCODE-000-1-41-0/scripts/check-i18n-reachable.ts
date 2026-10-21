/**
 * check-i18n-reachable — which locale keys no reader in this tree can reach.
 *
 * P2.490.
 *
 * ## The hole this fills
 *
 * Two i18n gates already run on every commit and neither can see a dead key:
 *
 *   - `lint:i18n:parity` compares each locale to `en.json`. Two files that are
 *     equally wrong are in perfect parity.
 *   - `lint:i18n:sorted` compares each locale to itself sorted. A dead key in
 *     alphabetical position is exactly as sorted as a live one.
 *
 * So a key that is present in BOTH locales and correctly sorted passes both
 * gates with exit 0 from each. That is not a hypothetical: 48 keys labelling
 * `PiRuntimeControlCenter` outlived the component by a month, translated,
 * parity-checked and SHIPPED in the renderer bundle to every user, and the only
 * thing that ever caught them was a hand-written orphan test (P2.364,
 * `ec8d267aa`). The two gates guard symmetry and ordering. Nothing guarded
 * reachability. This does.
 *
 * ## Why it is a ledger and not a red light
 *
 * On the tree where it landed this gate finds 189 unreachable keys — roughly
 * four times the defect that motivated it, and about 8% of the 2,375 keys in
 * `en.json`. Failing on all of them would ship a gate nobody could turn green,
 * which is how a gate becomes a thing people delete. So the reading is RECORDED
 * (see the ledger named in `UNREACHABLE_LEDGER`) and the gate fails on DRIFT in
 * either direction: a key that becomes unreachable is new rot and fails; a
 * ledger entry that becomes reachable again is a stale record and fails. The
 * 48-key defect would have failed this gate at the commit that deleted the
 * component, which is the whole point.
 *
 * `P2.88` is the precedent that a recorded waiver can be load-bearing rather
 * than decorative — the same shape, one gate over.
 *
 * ## How a key is reached, and the one that cries wolf
 *
 * Three forms count as a reader, and they are not equally safe:
 *
 *   1. EXACT — the key appears as a quoted literal in tracked source.
 *   2. PLURAL — `X_one` / `X_other` and their siblings are reached through the
 *      base `X`, because i18next appends the suffix at call time. Without this
 *      rule the scan reports every plural family in the tree as dead.
 *   3. PREFIX — a literal ending in a dot, either a template head or a plain
 *      string, that product code completes at runtime.
 *
 * Form 3 is the one that decides whether this gate is useful or blind, and it
 * is why the prefixes are CLASSIFIED BY HAND in `PREFIX_VERDICTS` instead of
 * being trusted as they are found. Measured on the tree where this landed:
 * several of the dotted prefixes the scan derives compose no key at all — some
 * are diagnostic paths that merely look like keys, others are a test's own
 * `not.toContain` or `startsWith` guard. Accepting the derived set as found
 * would let a single line of a test mark an entire namespace reachable.
 *
 * TESTS ARE NOT SCANNED EITHER, and that is the same rule one layer out — see
 * `isTestFile`. A stub translation map answers every key its component might ask
 * for, so it made a key the product had stopped asking for read as EXACT-matched.
 * Eight keys were hidden that way on the tree where the rule landed, three of them
 * with production reading a differently spelled key. Any number written in this
 * file is a reading with a date; run the gate for the live one.
 *
 * COMMENTS ARE NOT SCANNED, for the same reason. Before that was true, one
 * backtick in one PROSE SENTENCE — inside the docblock of
 * `pi-runtime-control-center-keys.test.ts`, the very test written to keep dead
 * keys out — derived the prefix `chat.` and would have marked the whole `chat.`
 * namespace reachable, including the 15 `chat.piAgentView.*` keys P2.364
 * recorded as dead. Worse, the same docblock quotes `chat.piRuntime.title`
 * verbatim as its own mutation recipe, which made that key read as EXACT-matched:
 * planting it back into both locales was the row's headline mutant and it came
 * back a dead control. This tree quotes exact tokens verbatim as a matter of
 * house style, so prose-as-reader was never going to be a rare collision.
 *
 * ## The enumeration ages, so it fails LOUDLY
 *
 * A hand-classified list is a list that goes stale. The gate therefore derives
 * the prefix set on every run and compares it to `PREFIX_VERDICTS`:
 *
 *   - a derived prefix with no verdict is REFUSED, with the source site printed,
 *     so a new dynamic prefix costs a review rather than silently exempting a
 *     namespace;
 *   - a verdict for a prefix no longer derived is REFUSED as stale.
 *
 * A new dynamic prefix cannot pass silently in either direction. That is the
 * property the row asked for, and it is the only reason a hand-maintained list
 * is defensible here.
 *
 * ## What this gate does NOT claim
 *
 * "Unreachable" means no reader in tracked source, not "dead". A key reached
 * only by a test that enumerates the locale by prefix is unreachable by this
 * definition and that is deliberate: the 48 keys were parity-checked too.
 * Deciding that an unreachable key should be deleted, or wired up, is a product
 * call — see `ec8d267aa` for how much history that call can need.
 *
 * Usage:
 *   bun scripts/check-i18n-reachable.ts            # report
 *   bun scripts/check-i18n-reachable.ts --check    # exit 1 on drift (the gate)
 *   bun scripts/check-i18n-reachable.ts --update   # rewrite the ledger
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'
import { blankComments } from './ts-comment-scan'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The reference locale. Parity to it is `lint:i18n:parity`'s job, not this one. */
const EN_LOCALE = 'packages/shared/src/i18n/locales/en.json'

/** Where the recorded reading lives. Regenerate with `--update`, never by hand. */
export const UNREACHABLE_LEDGER = 'scripts/i18n-unreachable-keys.txt'

/**
 * i18next appends these at call time, so `X_one` is reached through `X`.
 * Same set `check-i18n-parity.ts` uses, for the same reason.
 */
const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/

/**
 * Does a dotted literal ending in a dot COMPOSE a locale key at runtime?
 *
 * `composes-keys` exempts every key under it — product code completes it with a
 * runtime value. `not-a-key` exempts nothing: the literal is a diagnostic path,
 * a test's own guard, or prose. Every entry was traced to its source site; run
 * this gate with no arguments to print those sites.
 */
export const PREFIX_VERDICTS: Readonly<Record<string, 'composes-keys' | 'not-a-key'>> = {
  // Completed with a runtime value by product code.
  'apiSetup.modelCatalog.verdict.': 'composes-keys',
  'chat.askUser.urlConsent.warning.': 'composes-keys',
  // F1.1238 (2026-10-01): completed with a PermissionDslScope token by translatePermissionScopes,
  // the `permissionScopes` formatter in packages/shared/src/i18n/setupI18n.ts.
  'chat.permissionPolicy.scopeName.': 'composes-keys',
  // P6.695 (2026-09-08): three prefixes the wave-9 regeneration met — completed at runtime from a
  // verbosity level (ChatDisplay.tsx) and from a trust entry's navigation/cdp verdict
  // (BrowserOriginTrustSection.tsx). Read at the sites, not assumed.
  'chat.transcriptVerbosity.': 'composes-keys',
  'settings.crossSessionInbound.mode.': 'composes-keys',
  'settings.permissions.browserTrustCdp.': 'composes-keys',
  'settings.permissions.browserTrustNavigation.': 'composes-keys',
  'chat.dpAuth.errors.': 'composes-keys',
  'chat.submit.': 'composes-keys',
  'claudeImport.action.': 'composes-keys',
  'claudeImport.kind.': 'composes-keys',
  'commands.': 'composes-keys',
  'context.loadedFileKind.': 'composes-keys',
  'mode.': 'composes-keys',
  'multiSelect.selected.': 'composes-keys',
  'outputStyles.': 'composes-keys',
  // UA7.3 (2026-10-02): completed with the page's PageKind ('static' | 'interactive' | 'live') by
  // PageKindBadge in apps/electron/src/renderer/components/pages/page-visuals.tsx (v0.13.4 verbatim).
  'pages.kind.': 'composes-keys',
  'pluginDetail.activation.': 'composes-keys',
  'pluginDetail.authentication.': 'composes-keys',
  'plugins.kind.': 'composes-keys',
  'plugins.sourceConfidence.': 'composes-keys',
  'settings.notifications.timing.': 'composes-keys',
  'settings.workflows.sizeGuideline.': 'composes-keys',
  'shortcuts.category.': 'composes-keys',
  'sidebar.labelValueType.': 'composes-keys',
  'status.': 'composes-keys',
  'thinking.': 'composes-keys',
  'turnCard.subagent.status.': 'composes-keys',
  'turnCard.workflow.status.': 'composes-keys',

  // Looks like a key prefix and is not one. There were NINE of these while tests
  // were still scanned; seven of the nine were a test's own `not.toContain` or
  // `startsWith` guard and vanished with `isTestFile` (P2.520), leaving the two
  // that a PRODUCTION file derives. (A tenth, `chat.`, came from a prose backtick
  // and disappeared earlier, once comments stopped being scanned.) Two more
  // production-derived ones arrived with P6.637 and one with P6.317 (2). No count
  // is written here on purpose: it would be a reading with a date, and this
  // comment has already carried a stale one — run the gate for the live list.
  //
  // Every entry below is a real namespace in someone's vocabulary and NONE of
  // them is exempted by this verdict: `not-a-key` says the derived prefix
  // composes no locale key, so the seven live `agents.*` keys still need readers
  // of their own.
  'agents.': 'not-a-key',                  // the `--agents` JSON path in a definition diagnostic
  'automations.': 'not-a-key',             // a validation diagnostic path
  'capability.': 'not-a-key',              // a cache-invalidation reason string
  'filter.': 'not-a-key',                  // a git config namespace
  'mcpServers.': 'not-a-key',              // a format-adapter diagnostic path
  // 2026-09-19 (WI-br's P-WI-br-1): two prefixes a CDP CASE derives — `scripts/cdp/cases/rs-100.ts`
  // asserts the /btw panel's placeholder is one of ITS OWN keys and NOT a main-composer tip, so it
  // spells both namespaces as string guards. The product writes every key under them in full
  // (`chat.sideQuestion.placeholder1`, `chatInput.placeholder.sidebar`), so neither prefix composes.
  // `scripts/cdp` is not a test directory by `isTestFile`'s rule, which is why they reached here.
  'chat.sideQuestion.': 'not-a-key',       // a cdp case's DOM guard, not a composed key
  'chatInput.placeholder.': 'not-a-key',   // the same guard's negative half
}

export interface Reference {
  /** Every quoted dotted literal that is not a prefix. */
  readonly exact: ReadonlySet<string>
  /** Dotted literals ending in a dot, mapped to the first site that produced one. */
  readonly prefixSites: ReadonlyMap<string, string>
}

/**
 * A TEST is not a reader — P2.520(a), and it is the difference between a floor
 * and a total.
 *
 * The reading this gate landed with was 189 unreachable keys and it was quoted
 * everywhere as the count. It was a FLOOR. A test's stub translation map states
 * every key its component might ask for as a literal — `'mcpServers.originUser':
 * 'User'` — and that literal read as an EXACT match, so a key the product no
 * longer asks for anywhere scored *reachable* on the strength of a fixture that
 * exists only to answer it. Measured on the tree where this rule landed: eight
 * such keys, and every one of the eight is dead by inspection, with production
 * reading a DIFFERENTLY SPELLED key in three of them (`plugins.scopeProject` for
 * `sourcesManagement.scopeProject`, `sourcesList.pluginBadge` for
 * `skillsList.pluginBadge`) — which is exactly the shape a stub map hides,
 * because the stub is written from the key list rather than from the caller.
 *
 * The rule is deliberately about the FILE KIND rather than about a list of file
 * names: `NOT_A_READER` had two entries and every new fixture would have needed
 * a third. It is also deliberately not narrower than that — "an object literal
 * mapping dotted keys to strings" would have caught the stub maps and missed the
 * two cases here that are a bare array of key names in an assertion.
 *
 * ## The direction this could have been wrong in, and the control that says it is not
 *
 * If production composed a key at runtime in a way the scan cannot see, and a
 * test were the only place it appeared literally, this rule would condemn a LIVE
 * key. `mcp-servers-panel-keys.test.ts` asserts precisely that in prose — *"the
 * built-in badge keys are built dynamically, so a test's stub translation map is
 * the only place they appear literally at all"*. Driven rather than read, that
 * claim is FALSE at HEAD: nothing composes `mcpServers.origin*` any more; the
 * origin badges left the row (`McpServersPanel.tsx`'s own docblock records where
 * each went) and never arrived anywhere else.
 *
 * The general control is the one that matters, because the prose was only ever
 * one instance: the scan sees a runtime composition through `TEMPLATE_PREFIX`,
 * which requires the head to end in a dot, so the blind spot is a template head
 * that does NOT — `` `mcpServers.origin${kind}` ``. Swept over every tracked
 * `.ts`/`.tsx`, the tree holds five such heads and all five are `plugin.deferred.*`
 * diagnostic paths plus one test string; `plugin.` is not a locale namespace at
 * all (the locale spells it `plugins.`). So no locale key in this tree is composed
 * by a head this scan cannot derive, and the rule cannot condemn one.
 *
 * A key that a test legitimately covers is unaffected: its production reader is
 * still a reader, and the test was never what made it reachable.
 */
export function isTestFile(file: string): boolean {
  return /(?:^|\/)(?:__tests__|__mocks__)\//.test(file) || /[.](?:test|spec)[.][cm]?[jt]sx?$/.test(file)
}

/**
 * Files whose quoted keys are NOT readers, on top of the locale files and every
 * test.
 *
 * This gate's own test states its cases as literal keys — `automations.editFile`
 * to show that a `not-a-key` prefix exempts nothing, `time.daysAgo_one` to show a
 * plural whose base has no reader. The moment that file was committed those three
 * keys read as EXACT-matched and the ledger went stale, turning `bun run lint` red
 * for every lane over three keys nothing in the product reads. (The first was
 * `plugins.installedCount` until P2.519 deleted that key, which is the same trap
 * arriving from the other side: a docblock naming a fixture outlives the fixture.) A gate must not be
 * its own witness, and the mistake is invisible until the file stops being
 * untracked — which is after the commit that adds it. `isTestFile` now covers that
 * file for the general reason; it stays named here because the reason it must be
 * excluded is stronger than "it is a test" and outlives any rename.
 *
 * THIS FILE is on the list for the stronger half of the same reason, and NOTHING
 * else covers it — it is not a test. Every entry of `PREFIX_VERDICTS` is a quoted
 * literal ending in a dot, so once tracked it derives every prefix it classifies —
 * and the staleness check, the one that makes a hand-kept enumeration defensible,
 * could then never fire at all. It was measured firing correctly on `chat.` only
 * because this file was still untracked at the time.
 */
const NOT_A_READER: readonly string[] = [
  'scripts/check-i18n-reachable.ts',
  'scripts/check-i18n-reachable.test.ts',
]

/**
 * Tracked source, minus the vendored references, the locale files themselves, and
 * every test (`isTestFile` — P2.520(a)).
 *
 * The playground is NOT excluded and must not be: it ships in the renderer bundle,
 * so a key only the playground reads is reachable by a user. Only `playground/__tests__/`
 * drops out, through the general rule.
 */
export function scannedFiles(): string[] {
  return gitSourceFiles(['ls-files', '-z', '--', '*.ts', '*.tsx', '*.mjs', '*.cjs', '*.js'])
}

/**
 * The filter both enumerations apply, named so the two cannot drift and so a
 * test can state each exclusion as a value rather than by fishing in a tree.
 */
export function isScannableSource(file: string): boolean {
  if (file === '') return false
  if (file.startsWith('.references/')) return false
  if (file.startsWith('packages/shared/src/i18n/locales/')) return false
  if (isTestFile(file)) return false
  return !NOT_A_READER.includes(file)
}

function gitSourceFiles(args: readonly string[]): string[] {
  const out = execFileSync('git', [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter(isScannableSource)
}

/**
 * DA1.62 — sources the WORKING TREE has and the index does not.
 *
 * `scannedFiles` enumerates with `git ls-files`, which is the right denominator
 * for the gate itself: the ledger, the prefix verdicts and the unreachable set
 * must describe what is COMMITTED, or a neighbour's half-finished file in a
 * shared tree would derive prefixes and revive keys for everyone (the
 * tree-scanning-generator trap in AGENTS.md, measured on this repo's other
 * ledgers).
 *
 * But it has a second, worse edge, measured 2026-09-17 by lane WC-d: a key whose
 * ONLY reader is a file not yet committed reads as rot, and this gate's own
 * advice then says to delete the key. Five `chat.modelPicker.provenance*` keys
 * were reported *"became unreachable"* while the new `ModelListDisclosures.tsx`
 * that reads them sat untracked, and went green with no drift the moment it was
 * committed — the sibling key stayed silent throughout because a tracked file
 * also reads it, which is the control that the probe could see.
 *
 * So the untracked list is used for exactly ONE thing: to ANNOTATE a failure
 * that has already been decided, naming the file that would have answered it.
 * It never feeds `analyse`, never derives a prefix, never revives a ledger
 * entry. That keeps the neighbour-coupling at zero and turns "delete this key"
 * into "commit that file first", which is the whole defect.
 */
export function untrackedSourceFiles(): string[] {
  return gitSourceFiles([
    'ls-files', '-z', '--others', '--exclude-standard',
    '--', '*.ts', '*.tsx', '*.mjs', '*.cjs', '*.js',
  ])
}

/**
 * Which of `keys` an untracked file reads, and the first file that reads it.
 *
 * The two seams are for the test, which states a case as a value instead of
 * planting a real untracked file in a tree six other lanes are editing — a
 * fixture that, being untracked, this very function would then have found.
 */
export function untrackedReaders(
  keys: readonly string[],
  files: readonly string[] = untrackedSourceFiles(),
  readText: (file: string) => string = (file) => readFileSync(join(REPO_ROOT, file), 'utf-8'),
): Map<string, string> {
  const found = new Map<string, string>()
  if (keys.length === 0) return found

  for (const file of files) {
    let references: Reference
    try {
      // Same rule as the tracked scan, comments blanked and all: a key quoted in
      // an untracked file's PROSE is no more a reader than in a tracked one's.
      references = collectReferencesFromText(readText(file), file)
    } catch {
      continue
    }
    const composing = [...references.prefixSites.keys()]
      .filter((prefix) => PREFIX_VERDICTS[prefix] === 'composes-keys')
    for (const key of keys) {
      if (found.has(key)) continue
      if (references.exact.has(key) || composing.some((prefix) => key.startsWith(prefix))) {
        found.set(key, file)
      }
    }
  }
  return found
}

/**
 * One quoted literal, one match. The character class is FLAT — no nested
 * quantifier — because the obvious `(\.[A-Za-z0-9_]+)+` form backtracks
 * catastrophically on a long dotted run with no closing quote, and hung this
 * scan for minutes on this repo's generated protocol files before it was
 * flattened.
 */
const QUOTED_LITERAL = /['"`]([A-Za-z][A-Za-z0-9_.]*)['"`]/g

/** A template head: a backtick, a dotted prefix, then an interpolation. */
const TEMPLATE_PREFIX = /[`]([A-Za-z][A-Za-z0-9_.]*\.)\$\{/g

/**
 * Record every dotted literal in one already-blanked source text.
 *
 * The recorded site is the FIRST file that produced the prefix, and first is now
 * good enough: this used to prefer a non-test file over a test one, because a
 * test that guards a prefix and the product code that composes it both held the
 * literal and the reviewer needed the second. Since `isTestFile` no reader is a
 * test, so that preference could never fire again — an inert instrument, removed
 * rather than left to read as a live rule (P2.520).
 */
function absorb(
  text: string,
  file: string,
  exact: Set<string>,
  prefixSites: Map<string, string>,
): void {
  const recordSite = (literal: string): void => {
    if (!prefixSites.has(literal)) prefixSites.set(literal, file)
  }

  let match: RegExpExecArray | null
  QUOTED_LITERAL.lastIndex = 0
  while ((match = QUOTED_LITERAL.exec(text)) !== null) {
    const literal = match[1] as string
    if (!literal.includes('.')) continue
    if (literal.endsWith('.')) recordSite(literal)
    else exact.add(literal)
  }

  TEMPLATE_PREFIX.lastIndex = 0
  while ((match = TEMPLATE_PREFIX.exec(text)) !== null) recordSite(match[1] as string)
}

/**
 * The scan of a single source text, exposed so a test can state a case in three
 * lines instead of writing a fixture file.
 */
export function collectReferencesFromText(text: string, file = '<inline>'): Reference {
  const exact = new Set<string>()
  const prefixSites = new Map<string, string>()
  absorb(blankComments(text), file, exact, prefixSites)
  return { exact, prefixSites }
}

export function collectReferences(files: readonly string[]): Reference {
  const exact = new Set<string>()
  const prefixSites = new Map<string, string>()

  for (const file of files) {
    let text: string
    try {
      // Comments are blanked, not scanned. A key QUOTED IN PROSE is not a reader,
      // and this tree quotes exact tokens verbatim as a matter of house style —
      // measured, the whole `chat.` namespace hung on one backtick in one docblock
      // sentence, in the very test written to keep dead keys out.
      text = blankComments(readFileSync(join(REPO_ROOT, file), 'utf-8'))
    } catch {
      continue
    }
    absorb(text, file, exact, prefixSites)
  }

  return { exact, prefixSites }
}

export interface Analysis {
  readonly keys: readonly string[]
  /** Prefixes that match at least one key — the set `PREFIX_VERDICTS` must cover. */
  readonly derivedPrefixes: readonly string[]
  readonly unclassified: readonly string[]
  readonly staleVerdicts: readonly string[]
  readonly unreachable: readonly string[]
}

export function analyse(keys: readonly string[], references: Reference): Analysis {
  // A prefix matching no key cannot exempt anything, so it is not worth a
  // verdict — `Body.`, `icon.` and friends never reach the classification.
  const derivedPrefixes = [...references.prefixSites.keys()]
    .filter((prefix) => keys.some((key) => key.startsWith(prefix)))
    .sort()

  const unclassified = derivedPrefixes.filter((p) => PREFIX_VERDICTS[p] === undefined)
  const staleVerdicts = Object.keys(PREFIX_VERDICTS)
    .filter((p) => !derivedPrefixes.includes(p))
    .sort()

  const composing = derivedPrefixes.filter((p) => PREFIX_VERDICTS[p] === 'composes-keys')
  const reachable = (key: string): boolean =>
    references.exact.has(key) || composing.some((prefix) => key.startsWith(prefix))

  const unreachable = keys
    .filter((key) => {
      if (reachable(key)) return false
      if (!PLURAL_SUFFIX.test(key)) return true
      return !reachable(key.replace(PLURAL_SUFFIX, ''))
    })
    .sort()

  return { keys, derivedPrefixes, unclassified, staleVerdicts, unreachable }
}

export interface Drift {
  /** Rot: a key nothing reads any more, and the ledger has never seen it. */
  readonly newlyUnreachable: readonly string[]
  /** A recorded key that is still a key and now HAS a reader — someone wired it. */
  readonly revived: readonly string[]
  /** A recorded key that is no longer a key at all — someone DELETED it. */
  readonly deleted: readonly string[]
}

/**
 * How the ledger disagrees with the tree, split three ways rather than two.
 *
 * P2.520(b). `revived` used to be *everything recorded that is no longer in the
 * unreachable set*, and a key leaves that set two OPPOSITE ways: it gained a
 * reader, or it was deleted from the locales. Collapsing them printed
 * *"now have a reader — good news"* at a lane that had just performed the
 * deletion this ledger exists to enable. Telling someone the inverse of what
 * they did is how a correct change gets reverted by the person who made it.
 *
 * Exported as a pure function so the three cases can be stated as values instead
 * of asserted against console output.
 */
export function classifyDrift(
  recorded: readonly string[],
  keys: readonly string[],
  unreachable: readonly string[],
): Drift {
  const recordedSet = new Set(recorded)
  const liveKeys = new Set(keys)
  const unreachableSet = new Set(unreachable)
  return {
    newlyUnreachable: unreachable.filter((k) => !recordedSet.has(k)),
    revived: recorded.filter((k) => liveKeys.has(k) && !unreachableSet.has(k)),
    deleted: recorded.filter((k) => !liveKeys.has(k)),
  }
}

const LEDGER_HEADER = [
  '# Locale keys no reader in this tree can reach — the recorded reading.',
  '#',
  '# Generated by `bun scripts/check-i18n-reachable.ts --update`. Do not hand-edit:',
  '# the gate fails on drift in BOTH directions, so an entry added by hand that the',
  '# scan does not agree with fails as a stale record on the very next run.',
  '#',
  '# An entry here is NOT a verdict that the key is dead. It says the scan found no',
  '# reader. Deleting one is a product call — `ec8d267aa` is the worked example.',
  '',
]

export function renderLedger(unreachable: readonly string[]): string {
  return `${[...LEDGER_HEADER, ...unreachable].join('\n')}\n`
}

export function parseLedger(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const update = argv.includes('--update')

  const enPath = join(REPO_ROOT, EN_LOCALE)
  const en = JSON.parse(readFileSync(enPath, 'utf-8')) as Record<string, string>
  const keys = Object.keys(en)
  if (keys.length === 0) {
    throw new GateSafetyRefusal(`REFUSED: ${EN_LOCALE} carries no keys — the scan would be vacuous.`)
  }

  const files = scannedFiles()
  const references = collectReferences(files)
  const analysis = analyse(keys, references)

  const ledgerPath = join(REPO_ROOT, UNREACHABLE_LEDGER)
  if (update) {
    writeFileSync(ledgerPath, renderLedger(analysis.unreachable), 'utf-8')
    console.log(
      `check-i18n-reachable: wrote ${analysis.unreachable.length} key(s) to ${UNREACHABLE_LEDGER}.`,
    )
    return 0
  }

  const recorded = parseLedger(readFileSync(ledgerPath, 'utf-8'))
  const { newlyUnreachable, revived, deleted } = classifyDrift(recorded, keys, analysis.unreachable)

  console.log(
    `check-i18n-reachable: ${keys.length} keys in ${EN_LOCALE}, ` +
    `${analysis.unreachable.length} with no reader across ${files.length} tracked source file(s); ` +
    `${analysis.derivedPrefixes.length} dotted prefix(es) derived, ` +
    `${analysis.derivedPrefixes.filter((p) => PREFIX_VERDICTS[p] === 'composes-keys').length} of them compose keys.`,
  )

  let failed = false

  if (analysis.unclassified.length > 0) {
    failed = true
    console.log('')
    console.log(
      'REFUSED: a dotted prefix matches locale keys and has no verdict in PREFIX_VERDICTS.',
    )
    console.log(
      '  Left unclassified it would exempt every key under it, or none, by accident rather',
      '\n  than by decision. Read the site, then record it as `composes-keys` (product code',
      '\n  completes it at runtime) or `not-a-key` (a diagnostic path, a test guard, prose):',
    )
    for (const prefix of analysis.unclassified) {
      console.log(`    ${prefix}  first seen in ${references.prefixSites.get(prefix) ?? '?'}`)
    }
  }

  if (analysis.staleVerdicts.length > 0) {
    failed = true
    console.log('')
    console.log('REFUSED: PREFIX_VERDICTS carries a verdict for a prefix no longer in the tree:')
    for (const prefix of analysis.staleVerdicts) console.log(`    ${prefix}`)
    console.log('  Delete the entry. A verdict nobody can reach is the enumeration going stale.')
  }

  if (newlyUnreachable.length > 0) {
    failed = true
    // DA1.62 — the verdict is already decided from the TRACKED tree above; this
    // only says which of those keys a file you have not committed would have
    // answered. See {@link untrackedSourceFiles} for why it is an annotation
    // and not an input.
    const untracked = untrackedReaders(newlyUnreachable)
    console.log('')
    console.log(`${newlyUnreachable.length} locale key(s) became unreachable:`)
    for (const key of newlyUnreachable) {
      const site = untracked.get(key)
      console.log(site ? `    ${key}  ← read by UNTRACKED ${site}` : `    ${key}`)
    }
    if (untracked.size > 0) {
      console.log(
        `  ${untracked.size} of them ARE read — by a file this scan cannot see. It enumerates`,
        '\n  with `git ls-files`, so a reader that is not committed yet is invisible and its',
        '\n  key reads as rot. Commit those files and run this again BEFORE deleting a key;',
        '\n  the advice below is for the keys with no arrow beside them.',
      )
    }
    console.log(
      '  Either wire the key to a reader, or delete it from every locale — and if it is',
      '\n  genuinely unreachable on purpose, record it with `--update` and say why in the',
      '\n  commit. This is the check the 48 shipped `chat.piRuntime.*` keys never met.',
    )
  }

  if (revived.length > 0) {
    failed = true
    console.log('')
    console.log(`${revived.length} recorded key(s) now have a reader:`)
    for (const key of revived) console.log(`    ${key}`)
    console.log(`  Good news, and the ledger has to say so: rerun with --update.`)
  }

  if (deleted.length > 0) {
    failed = true
    console.log('')
    console.log(`${deleted.length} recorded key(s) are gone from ${EN_LOCALE} — deleted, not wired:`)
    for (const key of deleted) console.log(`    ${key}`)
    console.log(
      '  That is the disposal this ledger exists to enable, so nothing is wrong with',
      '\n  the change — the ledger simply still lists them. Rerun with --update, in the',
      '\n  SAME commit as the deletion, and check the other locales dropped them too',
      '\n  (`lint:i18n:parity` is what proves that, not this gate).',
    )
  }

  if (!failed) {
    console.log(`  ledger ${UNREACHABLE_LEDGER} agrees exactly; no drift.`)
  }

  if (analysis.unclassified.length === 0 && analysis.staleVerdicts.length === 0 && !check) {
    console.log('')
    console.log('Dotted prefixes and where each was first seen:')
    for (const prefix of analysis.derivedPrefixes) {
      console.log(
        `  ${PREFIX_VERDICTS[prefix] === 'composes-keys' ? 'composes ' : 'not-a-key'} ` +
        `${prefix.padEnd(34)} ${references.prefixSites.get(prefix) ?? '?'}`,
      )
    }
  }

  return check && failed ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}
