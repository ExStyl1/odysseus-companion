/**
 * Tests for `check-minified-citations.ts` — P3.309.
 *
 * The guard exists because an instrument located its subject by a minified name
 * that a bump reassigned, read an empty list, and passed over nothing. So every
 * case here drives BOTH directions: a checker that always answers "resolves"
 * and one that always answers "stale" must each fail something below.
 */

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BASELINE_FILE,
  BASELINE_HEADER,
  BUNDLE,
  BUNDLE_TALK,
  CITATION,
  REPO_ROOT,
  bundleDiscussingFiles,
  buildReport,
  nativeBinaryPath,
  readBaseline,
  resolvesInBundle,
  resolvesInNativeBinary,
  writeBaseline,
  type Citation,
} from './check-minified-citations'

// The budget belongs to the FILE, sized against the largest observed run rather
// than a per-test guess (the `claude-setup-import.test.ts` entry in the
// known-failing register records why). One case below reads the whole native
// binary and turns it into a latin1 string; that read cost 15 015 ms against
// bun's 5 000 ms default at load ~10 on 2026-09-11, and 3.5 s warm. 60 s is
// ~4x the cold reading.
setDefaultTimeout(60_000)

const cite = (name: string, ...files: string[]): Citation => ({ name, files })

/**
 * The two live minified names behind `claude-managed-settings.ts`'s policy
 * filter, re-extracted from the shipped binary BY CONTENT.
 *
 * The anchors are the ones that module's own docblock prescribes for exactly
 * this re-extraction (§"HOW TO FIND IT AGAIN — by content, never by symbol"),
 * so this helper and the module stay one recipe rather than two.
 */
function derivedManagedSettingsNames(text: string): string[] {
  // The anchor is a LITERAL to find the site cheaply, and a REGEX to read the
  // declaration — and the literal may contain no minified name of its own.
  //
  // C3.380 (2026-09-13, the 0.3.247 -> 0.3.251 lift): the second literal used to
  // be `let n={};if(e.allowManagedHooksOnly===!0)`, and `n` is the FILTER'S OWN
  // ACCUMULATOR — a minified local. 2.1.251 spells it `r` (which is what it was
  // at 2.1.233, so it has now been both), the `indexOf` returned -1, and the
  // case reported one name where there are two. That is S0-3's `te` -> `V`
  // mistake committed inside the very helper written to survive it: an anchor is
  // only "by content" if every byte of it is content.
  const anchors: ReadonlyArray<{ readonly literal: string; readonly declaration: RegExp }> = [
    {
      literal: 'parentSettingsBehavior==="merge"',
      // F1.255 (0.3.251 -> 0.3.267): the predicate grew a defaulted second
      // parameter — `function <name>(e,n=!1){return!e||e.parentSettingsBehavior==="merge"||n}`
      // — so the parameter list admits one `name=<default>` after the first.
      declaration: /function ([\w$]+)\([\w$]+(?:,[\w$]+=[^,)]+)?\)\{return!/,
    },
    {
      literal: 'allowManagedHooksOnly===!0',
      // `let <acc>={};if(<param>.allowManagedHooksOnly===!0)` — the filter's own
      // first line, with both locals left free.
      declaration: /function ([\w$]+)\([\w$]+,[\w$]+\)\{let [\w$]+=\{\};if\([\w$]+\.$/,
    },
  ]
  const names: string[] = []
  for (const anchor of anchors) {
    // The filter's line occurs several times in the binary (5 lines / 9
    // occurrences at 2.1.251); only one of them is preceded by the declaration,
    // so every site is tried rather than only the first.
    for (let at = text.indexOf(anchor.literal); at !== -1; at = text.indexOf(anchor.literal, at + 1)) {
      // A small window, because `text` is the whole native binary (188 MB at
      // `0.3.251`, 2026-09-13) and a global scan of it is not something a test
      // should pay for.
      const declaration = anchor.declaration.exec(text.slice(Math.max(0, at - 64), at))
      if (declaration) { names.push(declaration[1] as string); break }
    }
  }
  return names
}

describe('P3.309 · resolvesInBundle', () => {
  // One synthetic bundle, so the cases do not depend on which SDK is installed.
  const bundle = 'var Mf=()=>1;function tQ(){}let $y=0;const xMfy=2;q(uS());'

  test('a declared or called symbol resolves, and an absent one does not', () => {
    expect(resolvesInBundle(bundle, 'Mf')).toBe(true)
    expect(resolvesInBundle(bundle, 'tQ')).toBe(true)
    expect(resolvesInBundle(bundle, 'uS')).toBe(true)
    expect(resolvesInBundle(bundle, 'zzq')).toBe(false)
  })

  test('a `$`-prefixed name is matched literally rather than as a regex anchor', () => {
    expect(resolvesInBundle(bundle, '$y')).toBe(true)
    expect(resolvesInBundle(bundle, '$q')).toBe(false)
  })

  test('every BINDING form counts, not just a function declaration', () => {
    // A probe shaped for `function X(` misses the form minifiers actually emit:
    // `XTr` is live in the native binary as a `var` binding and scores ZERO
    // against `function XTr(`. That narrowing is what made W2-x's first probe
    // report three live citations as dead, so both forms are pinned here.
    for (const haystack of ['var XTr=1;', 'let XTr = 2;', 'const XTr=3;', 'function XTr(a){}', 'q(XTr());']) {
      expect(resolvesInBundle(haystack, 'XTr'), haystack).toBe(true)
    }
    // Both directions on the same name, so this is not simply "always true".
    expect(resolvesInBundle('const xXTr=1;', 'XTr')).toBe(false)
    expect(resolvesInBundle('nothing here', 'XTr')).toBe(false)
  })

  test('a name inside a LONGER identifier does not count — the whole point of the boundary', () => {
    // `xMf` ENDS with `Mf`, and the `=` follows immediately. That spelling is
    // deliberate: with `xMfy=2` the assignment is separated from `Mf` by a `y`,
    // so a version with the boundary deleted still answers false and the case
    // passes over a broken checker. Measured — the first mutation run recorded a
    // survivor for exactly that reason. Here the boundary is the ONLY thing
    // standing between `Mf` and a match.
    expect(resolvesInBundle('const xMf=2;', 'Mf')).toBe(false)
    expect(resolvesInBundle('const yMf(1);', 'Mf')).toBe(false)
    // The other direction on the same pair, so this is not just "always false".
    expect(resolvesInBundle('const Mf=2;', 'Mf')).toBe(true)
  })
})

describe('P3.309 · buildReport separates known stale from new stale', () => {
  const bundle = 'var Mf=()=>1;'
  const citations = [cite('Mf', 'a.ts'), cite('gone', 'b.ts'), cite('fresh', 'c.ts')]

  test('the baseline suppresses what it names and nothing else', () => {
    const report = buildReport(bundle, citations, new Set(['gone']))
    expect(report.cited).toBe(3)
    expect(report.resolved).toBe(1)
    expect(report.stale.map((row) => row.name).sort()).toEqual(['fresh', 'gone'])
    expect(report.newStale.map((row) => row.name)).toEqual(['fresh'])
  })

  test('an empty baseline makes every stale citation new', () => {
    expect(buildReport(bundle, citations, new Set()).newStale).toHaveLength(2)
  })
})

describe('P3.309 · the file selector', () => {
  test('BUNDLE_TALK is accepted by `git grep -E`, whose engine is not JavaScript', () => {
    // The pattern is handed to git verbatim. Written with `(?:…)` it fails with
    // `repetition-operator operand invalid` and the whole checker throws — which
    // it did, once. This pins the one property that keeps one pattern serving
    // two engines.
    const proc = Bun.spawnSync(['git', 'grep', '-l', '-E', BUNDLE_TALK.source, '--', '*.ts'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(new TextDecoder().decode(proc.stderr)).not.toContain('invalid')
    expect(proc.exitCode === 0 || proc.exitCode === 1).toBe(true)
  })

  test('it finds real bundle-discussing files and excludes this checker and its test', () => {
    const files = bundleDiscussingFiles()
    // Positive control: an empty answer would satisfy both exclusions below
    // vacuously, and "no stale citations" would then be true of a selector that
    // looked at nothing — the exact shape this whole row is about.
    expect(files.length).toBeGreaterThan(5)
    expect(files).toContain('packages/shared/src/config/claude-provider-routing-env.ts')
    expect(files).not.toContain('scripts/check-minified-citations.ts')
    expect(files).not.toContain('scripts/check-minified-citations.test.ts')
    // SELF is two files, not a directory, and this is the assertion that keeps
    // it that way: eight files under `scripts/` discuss the bundle, and widening
    // the exclusion to the directory would blind the guard to every one of them
    // while every other assertion here stayed green. Measured — the first
    // mutation run recorded that widening as a SURVIVOR.
    expect(files).toContain('scripts/build-server.ts')
  })
})

describe('P3.309 · the shipped baseline', () => {
  test('every entry is a bare name, and the recorded misfires are pinned whole below', () => {
    const baseline = readBaseline()
    // It emptied on P3.309's second pass — consulting the NATIVE binary as well as
    // `sdk.mjs` cleared all sixteen — and an empty baseline is the strongest state
    // this gate can be in. It is no longer empty: three sentences written into
    // bundle-discussing files after that pass cite a TOOL or a MATCHER rather than
    // a symbol (`Grep(pattern, …)`, `toBe(false)`, `Write(...)`), and the gate was
    // measured RED at HEAD over them on 2026-09-08. They are recorded with reasons
    // rather than filtered out, because deciding mechanically what "looks minified"
    // is the guess this guard exists to catch. Pinned by NAME, so a new entry —
    // a real stale citation or another misfire needing its own reason — fails
    // here rather than joining a list nobody rereads.
    //
    // The membership moved once already and the list is asserted WHOLE so that it
    // has to: the SDK lift to `0.3.247` (`5b2fd0e25`, P7.1/R5) dropped `Write`,
    // which resolves in the new bundle, and recorded `exact` — a docblock in
    // `otlp-telemetry.ts` citing that file's OWN local helper, so the same misfire
    // class as the other two and not a stale bundle citation.
    for (const entry of baseline) expect(entry).toMatch(/^\$?[A-Za-z_][A-Za-z0-9_$]{0,4}$/)
    // `Host` joined on 2026-09-12 (`a88c5e7cd`, a permission-rule matcher kind of
    // ours) and this pin was not moved with it, so the case was RED at HEAD
    // before C3.380's lift touched anything — found by the lift's gate, fixed
    // here, and reported. A baseline entry and this list are one artefact.
    // 2026-09-24 (controller, `2ced34953`): `steer` joined — claude-agent.ts's F1.485
    // docblock cites Pi's `steer()`, prose about the Pi SDK — and `--update-baseline`
    // dropped `Grep` as no longer stale at 0.3.251 (the cause was not re-derived here).
    // 2026-10-10 (W2C, the 0.3.280 SDK lift, UA12.211): `Some` joined — the six
    // `Some(…)` citations in config-writer.ts, its auto-compaction test and
    // third-party-text.ts are Rust `Option::Some` quoting the CODEX binary, the
    // same misfire class as `exact`; the name left the held-back set because the
    // 0.3.280 native binary no longer resolves it (see the baseline's own reason).
    expect([...baseline].sort()).toEqual(['Host', 'Some', 'exact', 'steer', 'toBe'])
    expect(BASELINE_FILE).toBe('scripts/minified-citation-baseline.txt')
    expect(BUNDLE).toContain('claude-agent-sdk')
  })

  test('a CONTINUATION comment line under an entry is not itself read as an entry', () => {
    // The three reasons wrap onto a second line indented under their entry. A
    // reader that split on whitespace rather than on `#` would take `denied-path`
    // and `of` as entries and silently suppress two names nobody chose to suppress.
    expect(readBaseline().size).toBe(5)
  })
})

/**
 * P3.309, second pass (W2-x's measured blind spot): the JS bundle is not the only
 * artifact this tree cites, and `X()` is not the only way a citation is written.
 */
describe('P3.309 pass 2 · the native binary and the wider citation form', () => {
  test('the citation regex accepts a call WITH arguments and still rejects a bare name', () => {
    const scan = (text: string): string[] =>
      [...text.matchAll(new RegExp(CITATION.source, 'g'))].map((match) => match[1] as string)
    expect(scan('cites `vbg(d)` here')).toEqual(['vbg'])
    expect(scan('cites `Mf()` here')).toEqual(['Mf'])
    // The deliberate stop: a bare name would take the candidate set from 56 to
    // 432 over the same files, most of them not bundle symbols at all.
    expect(scan('cites `Ebg` here')).toEqual([])
  })

  test('the selector names the binary package, so a file citing only the binary is scanned', () => {
    expect(BUNDLE_TALK.test('node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')).toBe(true)
    expect(BUNDLE_TALK.test('the native binary reads it')).toBe(true)
    // Negative control on the same predicate: it is not matching everything.
    expect(BUNDLE_TALK.test('an ordinary sentence about permissions')).toBe(false)
  })

  test('the installed platform binary is found, and a name absent from its bytes does not resolve', () => {
    const path = nativeBinaryPath()
    if (path === null) return // a platform whose binary is not installed
    expect(path).toContain('claude-agent-sdk-')
    const binary = readFileSync(path)
    const text = binary.toString('latin1')
    // Both directions on the same rig, and the positive side is DERIVED rather
    // than pinned. This case used to name `Ebg`, `XTr` and `vbg` — the
    // spellings `claude-managed-settings.ts` carried at `0.3.233` — and the
    // lift to `0.3.247` reassigned two of the three (`Ebg` → `qo`,
    // `vbg` → `Un`), so the guard against name rot went red because its own
    // test had rotted. Re-extracting from the module's documented CONTENT
    // anchors is the only form of this case that survives a bump.
    const derived = derivedManagedSettingsNames(text)
    expect(derived).toHaveLength(2)
    for (const name of derived) {
      expect(resolvesInNativeBinary(binary, text, name), name).toBe(true)
    }
    // The negative, against a nonsense name long enough not to occur by chance.
    // See the header for why SHORT names prove nothing here.
    expect(resolvesInNativeBinary(binary, text, 'zzqzzq')).toBe(false)
  })

  test('a name the bundle lacks and the binary carries is held back from stale, and counted', () => {
    const citations = [{ name: 'Mf', files: ['a.ts'] }, { name: 'Ebg', files: ['b.ts'] }, { name: 'gone', files: ['c.ts'] }]
    const bundle = 'var Mf=()=>1;'
    const withoutBinary = buildReport(bundle, citations, new Set())
    expect(withoutBinary.stale.map((row) => row.name).sort()).toEqual(['Ebg', 'gone'])
    expect(withoutBinary.nativeConsulted).toBe(false)

    const withBinary = buildReport(bundle, citations, new Set(), (name) => name === 'Ebg')
    expect(withBinary.stale.map((row) => row.name)).toEqual(['gone'])
    expect(withBinary.resolvedOnlyNatively).toBe(1)
    expect(withBinary.nativeConsulted).toBe(true)
  })
})
/**
 * P6.892 — the guard writes a HUMAN-READABLE register, so its writer is itself a
 * thing that can destroy evidence.
 *
 * The previous writer composed the whole file from the finding list. Both cases
 * below fail against that writer: the first because every comment and reason in
 * the file is gone, the second because a re-emitted header could drift from the
 * one the shipped file carries with nothing noticing.
 */
describe('P6.892 · --update-baseline must not delete the register it writes', () => {
  const seed = (lines: readonly string[]): string => {
    const root = mkdtempSync(join(tmpdir(), 'minified-baseline-'))
    mkdirSync(join(root, 'scripts'), { recursive: true })
    if (lines.length > 0) writeFileSync(join(root, BASELINE_FILE), `${lines.join('\n')}\n`, 'utf8')
    return root
  }

  test('a human comment and a human reason survive a regeneration', () => {
    const root = seed([
      ...BASELINE_HEADER,
      '',
      '# MISFIRE: an ordinary word in a bundle-discussing file, not a minified symbol.',
      'Map  # not a bundle symbol at all — do not re-file this every quarter',
      'gone  # was stale on 0.3.223',
    ])
    try {
      const written = writeBaseline([cite('Map', 'x.ts'), cite('fresh', 'y.ts')], root)
      const after = readFileSync(join(root, BASELINE_FILE), 'utf8')
      // The reason, which is the only thing here a machine cannot re-derive.
      expect(after).toContain('# MISFIRE: an ordinary word in a bundle-discussing file')
      expect(after).toContain('Map  # not a bundle symbol at all — do not re-file this every quarter')
      // A surviving entry keeps its OWN line: the generated file list is NOT
      // written over a reason someone put there on purpose.
      expect(after).not.toContain('x.ts')
      // The list may only shrink, so an entry that no longer reads stale goes.
      expect(after).not.toContain('gone')
      // And a genuinely new finding is still recorded, with its files.
      expect(after).toContain('fresh  # y.ts')
      expect(written).toEqual({ added: 1, dropped: 1 })
      // `git diff --check` cleanliness: exactly one trailing newline, no blank run.
      expect(after.endsWith('\n')).toBe(true)
      expect(after.endsWith('\n\n')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a missing baseline is seeded with the header, and the shipped file carries the same one', () => {
    const root = mkdtempSync(join(tmpdir(), 'minified-baseline-seed-'))
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true })
      expect(writeBaseline([], root)).toEqual({ added: 0, dropped: 0 })
      expect(readFileSync(join(root, BASELINE_FILE), 'utf8')).toBe(`${BASELINE_HEADER.join('\n')}\n`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // The seed and the shipped file are two copies of one text, and only this
    // keeps them from drifting apart in a file nobody regenerates for months.
    const shipped = readFileSync(join(REPO_ROOT, BASELINE_FILE), 'utf8').split('\n')
    expect(shipped.slice(0, BASELINE_HEADER.length)).toEqual([...BASELINE_HEADER])
  })
})
