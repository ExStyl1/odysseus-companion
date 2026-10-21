/**
 * Tests for `check-docs-site-build.ts` — D1.297.
 *
 * Three kinds of arm, and they cost very different things.
 *
 * The PARITY arms (D1.301) are pure: a list of page/heading-count triples in,
 * a verdict out, so a sibling lane's commit cannot make them red. That
 * separation is not decoration — the three real gaps this file was first written
 * against were all closed by another lane inside the hour, and an arm naming
 * them would have been red on arrival.
 *
 * The SKIP arm runs over a SCRATCH tree with no vitepress in it and is free; its
 * positive control is a scratch tree carrying a planted executable at exactly
 * the path the gate looks for, so a `null` there proves the check reads that
 * path rather than always answering "skip". Both directions matter: a gate that
 * always skips is a gate that has silently stopped gating, and it is the failure
 * mode of every "SKIP with exit 0" step in this repo.
 *
 * The RUN arm drives the real script as a CHILD and is gated on the binary being
 * present, which is what the gate's own contract says. It is a real vitepress
 * build of the real content tree — `real 7.18 / user 8.95 / sys 0.84` measured
 * standalone at load ~9 on 2026-09-18 — so this file carries a FILE-level
 * timeout sized against that run and not against bun's 5 s default. AGENTS.md:
 * the budget belongs to the file, sized against the largest observed run total.
 */

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildArgv,
  CONTENT_ROOT,
  contentPages,
  deadAnchors,
  DOCS_SITE_DIR,
  headingCount,
  headingParity,
  INSTALL_COMMAND,
  pageHeadings,
  REPO_ROOT,
  skipReason,
  VITEPRESS_BIN,
  vitepressSlug,
} from './check-docs-site-build'

// The child build is the slow half; see this file's docblock for the reading it
// is sized against.
setDefaultTimeout(300_000)

/**
 * Whether the RUN arm can run at all, decided ONCE and outside any test.
 *
 * `test.skipIf` rather than an `if` + `return` inside the body: an `expect`
 * reached only on one branch is what `lint:conditional-expect` refuses, and it
 * is right to — a conditional assertion is a test that can report a pass it
 * never took. Deciding here also means the reason is printed once, loudly,
 * rather than being a silent skip.
 */
const RUN_ARM_SKIP = skipReason()
if (RUN_ARM_SKIP !== null) console.log(`check-docs-site-build.test: RUN ARM SKIPPED — ${RUN_ARM_SKIP}`)

function scratchSite(options: { vitepress: boolean; content: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'docs-site-build-'))
  mkdirSync(join(root, DOCS_SITE_DIR), { recursive: true })
  if (options.content) mkdirSync(join(root, DOCS_SITE_DIR, CONTENT_ROOT), { recursive: true })
  if (options.vitepress) {
    const bin = join(root, DOCS_SITE_DIR, VITEPRESS_BIN)
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(bin, 0o755)
  }
  return root
}

describe('check-docs-site-build', () => {
  test('an absent vitepress is a SKIP that names the path and the command that fixes it', () => {
    const root = scratchSite({ vitepress: false, content: true })
    try {
      const reason = skipReason(root)
      expect(reason).not.toBeNull()
      expect(reason).toContain(VITEPRESS_BIN)
      expect(reason).toContain(INSTALL_COMMAND)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the POSITIVE control: with the binary planted at that exact path, there is no skip', () => {
    // Without this arm the one above passes on a gate that returns a skip
    // unconditionally — which is the shape of every step that quietly stops
    // running. The planted file is a two-line `sh` script; nothing executes it.
    const root = scratchSite({ vitepress: true, content: true })
    try {
      expect(skipReason(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a missing content root is its own skip, not a build that fails confusingly', () => {
    const root = scratchSite({ vitepress: true, content: false })
    try {
      expect(skipReason(root)).toContain(CONTENT_ROOT)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the argv is the documented invocation and its out directory is RELATIVE', () => {
    // Relative because `assertNoHomeOrRootPath` refuses to execute an argv that
    // names an absolute path or a home directory, and because the `--outDir`
    // vitepress takes resolves against the CWD (measured, not assumed).
    const argv = buildArgv('../node_modules/.cache/nessy-gates/x')
    expect(argv).toEqual(['build', CONTENT_ROOT, '--outDir', '../node_modules/.cache/nessy-gates/x'])
    expect(argv.some(argument => argument.startsWith('/'))).toBe(false)
    // And the default output location is never named — a developer's own
    // `content/.vitepress/dist` must survive a gate run.
    expect(argv.join(' ')).not.toContain('dist')
  })

  test('D1.301 — headings are counted at `##`/`###`, and a fenced or inline `#` is not one', () => {
    expect(headingCount('# Title\n\n## A\n\ntext\n\n### B\n\n#### C\n')).toBe(2)
    // The page title is excluded on purpose: every page has exactly one, so it
    // would add a constant to both sides of every comparison.
    expect(headingCount('# Only a title\n')).toBe(0)
    // A `#` that is not at the start of a line is not a heading, and neither is
    // a `#comment` inside prose.
    expect(headingCount('see ## not a heading\n')).toBe(0)
  })

  test('D1.301 — a mismatch and a missing twin are both findings, and equality is not', () => {
    const report = headingParity([
      { page: 'equal.md', en: 7, ru: 7 },
      { page: 'also-equal.md', en: 0, ru: 0 },
      // The two findings, one of each kind.
      { page: 'gap.md', en: 9, ru: 8 },
      { page: 'untranslated.md', en: 3, ru: null },
    ])
    expect(report.pairs).toBe(4)
    expect(report.mismatched.map(entry => entry.page)).toEqual(['gap.md'])
    expect(report.missing.map(entry => entry.page)).toEqual(['untranslated.md'])
  })

  test('D1.301 — the gap is a DIFFERENCE, so a ru twin with MORE sections is a finding too', () => {
    // The boundary, and it is not symmetric with the i18n locale rule: `ru.json`
    // legitimately carries more KEYS than `en.json`, but a ru page carrying a
    // section en does not have means one of the two is out of date either way.
    const report = headingParity([{ page: 'extra.md', en: 8, ru: 9 }])
    expect(report.mismatched.map(entry => entry.page)).toEqual(['extra.md'])
    expect(report.missing).toEqual([])
  })

  test('D1.301 — the real content tree is read, and it is clean with a control that can fail', () => {
    // The whole-tree arm. Its numbers are NOT declared (a count here would
    // redden on a sibling lane's new page — measured, twice, in the hour this
    // was written); what is pinned is the VERDICT, which the controller's
    // ruling makes a hard zero with no exemption list. Reading at `e3c6343af`:
    // 48 en pages, 48 with a ru twin, 0 mismatches.
    const pages = pageHeadings()
    expect(pages.length).toBeGreaterThan(0)
    const report = headingParity(pages)
    expect(report.mismatched).toEqual([])
    expect(report.missing).toEqual([])
    // THE CONTROL, and it mutates nothing: a real page's real counts, perturbed
    // by one, must be reported. Without it, "clean" above is equally consistent
    // with a walk that read no headings at all — which is how a gate goes quiet.
    const agreeing = pages.find(page => page.ru !== null && page.en > 0)
    if (agreeing === undefined) throw new Error('no en/ru page pair with headings — the walk read nothing')
    const perturbed = headingParity([{ page: agreeing.page, en: agreeing.en + 1, ru: agreeing.ru }])
    expect(perturbed.mismatched.map(entry => entry.page)).toEqual([agreeing.page])
  })

  test('F1.1171 — an anchor is checked against the id vitepress RENDERS: NFKD drops ё and й to е and и', () => {
    // vitepress 1.6.4 renders `## Защищённые пути` as `id="защищенные-пути"` (read from a built page).
    expect(vitepressSlug('Защищённые пути')).toBe('защищенные-пути')
    expect(vitepressSlug('Основная подключённая папка')).toBe('основная-подключенная-папка')
    expect(vitepressSlug('Режим Explore упразднён')).toBe('режим-explore-упразднен')
    expect(vitepressSlug('Image input для custom endpoints')).toBe('image-input-для-custom-endpoints')
    const pages = new Map([
      ['ru/core-concepts/permissions.md', '# Разрешения\n\n## Защищённые пути\n\n[spelled](#защищённые-пути) [rendered](#защищенные-пути)\n'],
      ['ru/core-concepts/working-directory.md', '# Папка\n\n[spelled](permissions#защищённые-пути) [rendered](./permissions.md#защищенные-пути)\n'],
    ])
    const { links, dead } = deadAnchors(pages)
    expect(links).toBe(4)
    expect(dead).toEqual([
      { page: 'ru/core-concepts/permissions.md', link: '#защищённые-пути', target: 'ru/core-concepts/permissions.md' },
      { page: 'ru/core-concepts/working-directory.md', link: 'permissions#защищённые-пути', target: 'ru/core-concepts/permissions.md' },
    ])
  })

  test('F1.1171 — the real content tree has no dead in-site anchor, with a control that can fail', () => {
    const pages = contentPages()
    const { links, dead } = deadAnchors(pages)
    expect(links).toBeGreaterThan(0)
    expect(dead).toEqual([])
    // THE CONTROL: the same tree with one real link's anchor re-spelled with ё must be reported.
    const [page, markdown] = [...pages].find(([, text]) => text.includes('](#защищенные-пути)')) ?? []
    if (page === undefined || markdown === undefined) throw new Error('no page links #защищенные-пути — the walk read nothing')
    const perturbed = new Map(pages).set(page, markdown.replace('](#защищенные-пути)', '](#защищённые-пути)'))
    expect(deadAnchors(perturbed).dead.map(entry => `${entry.page} ${entry.link}`)).toEqual([`${page} #защищённые-пути`])
  })

  test.skipIf(RUN_ARM_SKIP !== null)('the RUN arm: the real script builds the real content tree and exits 0', () => {
    // The child is spawned as the CI invocation really is — not as a test
    // process. Inheriting `NODE_ENV=test` makes the root `bunfig.toml` preload
    // refuse to start at all (`CONFIG_DIR isolation missing in a test process`,
    // `packages/shared/src/config/paths.ts`), which is that guard working
    // correctly and has nothing to do with this gate. `NESSY_CONFIG_DIR` is set
    // beside it so the refusal cannot be reached even if the name comes back:
    // the two remedies the guard's own message names, both taken.
    //
    // The env is built by deleting from a SPREAD copy rather than by mutating
    // `process.env` — AGENTS.md §Traps: an assignment there is invisible to
    // `{...process.env}` for some names, so the child would receive nothing.
    const childEnv: Record<string, string | undefined> = { ...process.env }
    delete childEnv.NODE_ENV
    childEnv.NESSY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'docs-site-build-cfg-'))
    const result = Bun.spawnSync(['bun', 'scripts/check-docs-site-build.ts'], {
      cwd: REPO_ROOT,
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    rmSync(childEnv.NESSY_CONFIG_DIR, { recursive: true, force: true })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    expect(output).toContain('check-docs-site-build:')
    expect(output).not.toContain('SKIP:')
    expect(result.exitCode).toBe(0)
    // The out directory is removed on the way out, so a gate run leaves nothing
    // behind for the next one to trip over.
    expect(output).not.toContain('REFUSED')
  })
})
