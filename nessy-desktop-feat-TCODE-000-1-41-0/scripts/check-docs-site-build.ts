/**
 * check-docs-site-build — the gate that reads `docs-site`, which nothing did.
 *
 * D1.297.
 *
 * ## What ships unread today
 *
 * `docs-site/` is outside every `typecheck:*` and every `lint:*` step: it is not
 * a workspace package, it has its own `package.json` and its own `node_modules`,
 * and no script in the root manifest names it. So a dead link or a broken anchor
 * in either locale ships silently, and a wave that writes eight documentation
 * pages in two locales — as one did on 2026-09-18 — has no instrument at all
 * beside a human reading them.
 *
 * VitePress already carries the instrument. `ignoreDeadLinks` is NOT set in
 * `docs-site/content/.vitepress/config.ts`, so `vitepress build` resolves every
 * internal link and FAILS the build on one it cannot. Measured 2026-09-18 on a
 * scratch site built by this repo's own vitepress: one `[dead link](/no/such/page)`
 * gives `(!) Found dead link /no/such/page in file index.md`,
 * `[vitepress] 1 dead link(s) found.` and **exit 1**; the real content tree
 * builds clean in `real 7.18 / user 8.95 / sys 0.84` at load ~9. That is the
 * native-first answer this repo's own rule asks for — the runtime already has
 * the mechanism, so this file enables it rather than re-implementing a link
 * checker beside it.
 *
 * ## Why it SKIPS rather than installs
 *
 * CI's lint jobs never install `docs-site/node_modules` — only the docs-site job
 * does — and `lint:chain` occurs zero times in `.gitlab-ci.yml`. A step that
 * failed where vitepress is absent would therefore be a step that fails on every
 * machine that has not run `npm install` in `docs-site`, which is most of them,
 * including a fresh checkout. So an absent
 * `docs-site/node_modules/.bin/vitepress` is a clean SKIP with a printed reason
 * and exit 0 — the same posture `scripts/command-corpus.ts` takes for its
 * out-of-tree corpus, and for the same reason: a gate that cannot run is not a
 * gate that failed, and pretending otherwise teaches people to ignore it.
 *
 * **The skip is the thing to watch.** A gate that skips silently is a gate that
 * has stopped gating, so the reason is always printed, it always names the path
 * it looked for, and it always names the command that makes it run.
 *
 * ## The second half: TRANSLATION PARITY, which the build is blind to
 *
 * D1.301. `vitepress build` is green on every one of the five en/ru gaps WI-af
 * measured on 2026-09-18, because a missing section is not a dead link. So the
 * gate carries a second assertion, and it reads markdown only — it runs on the
 * SKIP arm too, where vitepress is absent, which is the arm most machines take.
 *
 * **Headings, never body lines.** Measured by WI-af: the ru pages wrap
 * differently and a translated table row often occupies one line where en
 * occupies three, so a body-line comparison cries wolf — and a rule that cries
 * wolf is a rule people stop running. A heading count cannot move for wrapping
 * reasons. `##` and `###` are counted; including `####` gives the identical
 * verdict today (10 pages use one and none of their counts differ), which is
 * the control for the level choice rather than an argument about it.
 *
 * **A hard zero, with no exemption list.** The denominator is **48 page pairs**
 * (WI-af's first report said 33; 48 is the measured number, and it is every
 * `.md` under `content/` outside `ru/`). At `e3c6343af` there are no mismatches
 * and no en page without a ru twin — under `##`/`###`, under `##`/`###`/`####`,
 * and under `#` and below. This file's first draft carried a declared baseline
 * of the three gaps that existed that morning, in the shape every other census
 * here uses; D1.300 closed all three inside the hour, and an allowance list that
 * is empty at birth is a ratchet nobody will ever lower. So there is none.
 *
 * **What the assertion cannot see, and it is not a small thing.** A heading
 * count is blind to the BODY under matching headings. D1.299 was exactly that:
 * the ru `llm-connections` page documented two provider types where en
 * documented four, under identical headings, and this check is green on it. It
 * catches a missing or renamed SECTION, and nothing finer.
 *
 * ## The third half: IN-SITE ANCHORS (F1.1171)
 *
 * The build resolves a link's PAGE and never its `#anchor`, so a link to a
 * heading id the page does not render ships green. {@link deadAnchors} reads
 * every in-site `#anchor` link against the ids {@link vitepressSlug} derives,
 * markdown only, on the SKIP arm too; it caught seven ru links spelling ё where
 * the rendered id has е, and two ru links naming an en heading's id.
 *
 * ## Where the build output goes
 *
 * Into a scratch directory under `node_modules/.cache/nessy-gates`
 * ({@link createGateScratchDir}), removed afterwards — never
 * `content/.vitepress/dist`, which is a developer's own build output. The
 * `--outDir` vitepress takes is resolved against the CWD (measured, not assumed:
 * `--outDir ../node_modules/…` from `docs-site` landed at the REPO root's
 * `node_modules`, not at `docs-site/node_modules`), and it is passed as a
 * RELATIVE path because {@link assertNoHomeOrRootPath} refuses to execute an
 * argv naming an absolute path or a home directory.
 *
 * Usage:
 *   bun scripts/check-docs-site-build.ts          # skip-or-build, exit = the build's
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertNoHomeOrRootPath, createGateScratchDir, GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The docs site, repo-relative. Its own npm project, not a workspace package. */
export const DOCS_SITE_DIR = 'docs-site'

/** The content root `vitepress build` is pointed at, relative to {@link DOCS_SITE_DIR}. */
export const CONTENT_ROOT = 'content'

/** The binary whose ABSENCE is the skip, relative to {@link DOCS_SITE_DIR}. */
export const VITEPRESS_BIN = join('node_modules', '.bin', 'vitepress')

/** The command an operator runs to make the skip stop happening. */
export const INSTALL_COMMAND = `cd ${DOCS_SITE_DIR} && npm install`

/**
 * The reason this run cannot build, or `null` when it can.
 *
 * Returned as a STRING rather than a boolean so the printed line and the
 * decision are the same value — a gate whose message is built somewhere else
 * than its verdict is a gate whose message can be wrong.
 */
export function skipReason(root: string = REPO_ROOT): string | null {
  const site = join(root, DOCS_SITE_DIR)
  if (!existsSync(site)) {
    return `${DOCS_SITE_DIR}/ is not in this checkout — nothing to build.`
  }
  if (!existsSync(join(site, VITEPRESS_BIN))) {
    return `${DOCS_SITE_DIR}/${VITEPRESS_BIN} is absent — the docs site's own dependencies are not `
      + `installed here (CI's lint jobs never install them). Run \`${INSTALL_COMMAND}\` to make this gate run.`
  }
  if (!existsSync(join(site, CONTENT_ROOT))) {
    return `${DOCS_SITE_DIR}/${CONTENT_ROOT}/ is absent — there is no content root to build.`
  }
  return null
}

/**
 * The argv for the build, with the out directory already in it.
 *
 * Exported so the test can assert the shape without paying for a build, and so
 * the safety refusal below has one place to guard.
 */
export function buildArgv(outDirFromDocsSite: string): string[] {
  return ['build', CONTENT_ROOT, '--outDir', outDirFromDocsSite]
}

export interface BuildOutcome {
  readonly status: number
  /** Seconds, as `/usr/bin/time -p` reports them — printed, never asserted on. */
  readonly real: number
}

/**
 * Run the build in a scratch out directory and hand back its exit status.
 *
 * `stdio: 'inherit'` on purpose: vitepress names the file and the link of every
 * dead link it finds, and that naming IS the gate's value. Capturing it to
 * summarise would be this file deciding which half of the tool's own message
 * the reader is allowed to see.
 */
export function runBuild(root: string = REPO_ROOT): BuildOutcome {
  const scratch = createGateScratchDir(root, 'docs-site-build')
  // Relative to `docs-site`, because that is the child's CWD and because an
  // absolute path in an argv is what the gate-safety refusal exists to stop.
  const outDir = relative(join(root, DOCS_SITE_DIR), scratch.absolute)
  const argv = buildArgv(outDir)
  for (const argument of argv) assertNoHomeOrRootPath('a vitepress build argument', argument)

  const started = Date.now()
  try {
    const result = spawnSync(join('.', VITEPRESS_BIN), argv, {
      cwd: join(root, DOCS_SITE_DIR),
      encoding: 'utf8',
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    return { status: result.status ?? 1, real: (Date.now() - started) / 1000 }
  } finally {
    rmSync(scratch.absolute, { recursive: true, force: true })
  }
}

/** The locale directory inside {@link CONTENT_ROOT} whose pages are translations. */
export const RU_PREFIX = 'ru/'

/**
 * `##` and `###` — the level the row names, and the level WI-af measured.
 *
 * A `#` page title is excluded deliberately: every page has exactly one and it
 * would add a constant to both sides of every comparison. (The prose numbers in
 * WI-af's census are each one higher than this instrument's for that reason —
 * 27/26 and 12/11 there, 26/25 and 11/10 here. Same three findings.)
 */
export const HEADING_PATTERN = /^#{2,3} /gm

export function headingCount(markdown: string): number {
  return markdown.match(HEADING_PATTERN)?.length ?? 0
}

export interface PageHeadings {
  /** Page path relative to {@link CONTENT_ROOT}, e.g. `plugins/overview.md`. */
  readonly page: string
  readonly en: number
  /** `null` when the page has no ru twin at all. */
  readonly ru: number | null
}

/**
 * Every en page under {@link CONTENT_ROOT}, with its ru twin's heading count.
 *
 * The WORKING TREE is walked rather than `git ls-files` enumerated, on purpose:
 * a gate that lists from the index cannot see a translation that has been
 * written and not yet committed, and would report the gap it has just been
 * handed the fix for. AGENTS.md records that exact shape costing a lane an hour
 * on `lint:i18n:reachable`. Dot directories are skipped, which is what keeps
 * `.vitepress/cache` and a developer's own `dist` out of the census.
 */
export function pageHeadings(root: string = REPO_ROOT): PageHeadings[] {
  const contentDir = join(root, DOCS_SITE_DIR, CONTENT_ROOT)
  const pages: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      else if (entry.name.endsWith('.md')) pages.push(`${prefix}${entry.name}`)
    }
  }
  if (!existsSync(contentDir)) return []
  walk(contentDir, '')

  const read = (page: string): number => headingCount(readFileSync(join(contentDir, page), 'utf8'))
  return pages
    .filter(page => !page.startsWith(RU_PREFIX))
    .sort()
    .map(page => ({
      page,
      en: read(page),
      ru: pages.includes(`${RU_PREFIX}${page}`) ? read(`${RU_PREFIX}${page}`) : null,
    }))
}

export interface ParityReport {
  /** en pages walked — the denominator, 48 at the commit that added this. */
  readonly pairs: number
  /** en pages with no ru twin at all. */
  readonly missing: PageHeadings[]
  /** Page pairs whose heading counts differ. */
  readonly mismatched: PageHeadings[]
}

/**
 * The parity verdict. NO exemption list, on purpose.
 *
 * The first draft of this carried a declared baseline of the three gaps WI-af
 * measured that morning, with a reason each, in the shape every other ratchet in
 * this directory uses. D1.300 then closed all three inside the hour (`98ad419fa`,
 * `6b6e91fbd`, `e3c6343af`), and the controller's ruling is the right one: a
 * list that is EMPTY at birth is a ratchet nobody will ever lower, and an empty
 * allowance mechanism is a hole waiting for the first person in a hurry. A hard
 * zero needs no maintenance and cannot drift.
 */
export function headingParity(pages: readonly PageHeadings[] = pageHeadings()): ParityReport {
  return {
    pairs: pages.length,
    missing: pages.filter(page => page.ru === null),
    mismatched: pages.filter(page => page.ru !== null && page.ru !== page.en),
  }
}

function reportParity(): number {
  const pages = pageHeadings()

  // A census that finds no pages is the walk having broken — a moved content
  // root, a renamed locale directory — not the site having emptied. Refuse
  // rather than print a clean parity report over nothing, which is the shape of
  // a gate that has silently stopped gating.
  if (pages.length === 0) {
    throw new GateSafetyRefusal(
      `REFUSED: no markdown page found under ${DOCS_SITE_DIR}/${CONTENT_ROOT}. That is the walk failing, `
      + 'not the site emptying — check that the content root still carries that name.',
    )
  }

  const parity = headingParity(pages)
  console.log(
    `check-docs-site-build: ${parity.pairs} en page(s), ${parity.pairs - parity.missing.length} with a ru `
    + `twin; ${parity.mismatched.length} heading-count mismatch(es) (\`##\`/\`###\`).`,
  )

  if (parity.missing.length === 0 && parity.mismatched.length === 0) return 0

  console.log('')
  console.log(
    `REFUSED: ${parity.missing.length + parity.mismatched.length} page(s) whose ru twin does not carry the `
    + 'same sections.',
  )
  for (const entry of [...parity.missing, ...parity.mismatched]) {
    console.log(
      entry.ru === null
        ? `  ${entry.page} — ${entry.en} heading(s) in en and NO ru twin at all.`
        : `  ${entry.page} — ${entry.en} heading(s) in en against ${entry.ru} in ru.`,
    )
  }
  console.log(
    '  `vitepress build` cannot see this: a section missing from a translation is not a dead link, so'
    + '\n  the ru reader simply never learns it exists. Translate the missing section — there is no'
    + '\n  exemption list, deliberately, because the one this was born with was empty within the hour.'
    + '\n  Headings and not body lines, because the ru pages wrap differently and a line comparison cries'
    + '\n  wolf (measured 2026-09-18).',
  )
  return 1
}

// ============================================================
// The third half: IN-SITE ANCHORS, which the build is also blind to (F1.1171)
// ============================================================

/**
 * VitePress's own heading slug, copied from vitepress 1.6.4
 * (`docs-site/node_modules/vitepress/dist/node/chunk-*.js`, `const slugify`,
 * the `@mdit-vue/shared` rule; MIT). It applies NFKD and DROPS the combining
 * marks, so `## Защищённые пути` renders as `id="защищенные-пути"` — ё and й
 * lose their diacritic — while a link typed from the heading spells
 * `#защищённые-пути` and lands nowhere. `vitepress build`'s dead-link check
 * resolves the PAGE of a link, never its `#anchor`, so it stayed green on six
 * such links in `ru/core-concepts/permissions.md` (measured 2026-09-29 on the
 * rendered ids). Re-read this line against the installed vitepress when it is
 * bumped: the anchor half is only as right as this copy.
 */
export function vitepressSlug(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '').replace(/^(\d)/, '_$1').toLowerCase()
}

/** Fenced code blocks, whose `#` lines are not headings and whose `](#…)` are not links. */
const FENCED_BLOCK = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm

/**
 * Every heading id one page renders. markdown-it-anchor as vitepress configures
 * it: every level, the slug of the heading's TEXT (inline code kept, link
 * targets, `*`/`**` emphasis marks and inline HTML dropped; an intraword `_`
 * is not emphasis and is kept), a `{#custom}` id taken as
 * written, a repeat suffixed `-1`, `-2`, … (`uniqueSlugStartIndex: 1`).
 */
export function headingIds(markdown: string): Set<string> {
  const ids = new Set<string>()
  for (const match of markdown.replace(FENCED_BLOCK, '').matchAll(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm)) {
    const heading = match[1]!
    const custom = heading.match(/\{#([^}\s]+)\}\s*$/)
    const base = custom ? custom[1]! : vitepressSlug(heading
      .replace(/`([^`]*)`/g, '$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')
      .replace(/(\*\*|\*)(\S(?:.*?\S)?)\1/g, '$2').replace(/\\(.)/g, '$1'))
    let id = base
    for (let n = 1; ids.has(id); n++) id = `${base}-${n}`
    ids.add(id)
  }
  return ids
}

export interface DeadAnchor {
  /** The linking page, relative to {@link CONTENT_ROOT}. */
  readonly page: string
  /** The link as written, `target#anchor`. */
  readonly link: string
  /** The page the link resolves to, relative to {@link CONTENT_ROOT}. */
  readonly target: string
}

/**
 * Every in-site `[text](page#anchor)` or `[text](#anchor)` link whose anchor is
 * not an id its target page renders. An external link is not read, nor is a
 * reference-style definition (none in the tree at birth — the stated residue);
 * a target page that does not exist is the build's dead-link finding, not this.
 */
export function deadAnchors(pages: ReadonlyMap<string, string>): { links: number; dead: DeadAnchor[] } {
  const ids = new Map([...pages].map(([page, markdown]) => [page, headingIds(markdown)] as const))
  const dead: DeadAnchor[] = []
  let links = 0
  for (const [page, markdown] of pages) {
    for (const match of markdown.replace(FENCED_BLOCK, '').matchAll(/\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
      const [, href, anchor] = match as unknown as [string, string, string]
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue
      let target = page
      if (href !== '') {
        // `/x` is content-root relative (so a ru page's `/reference/…` is the en page); anything else is page relative.
        const parts = href.startsWith('/') ? href.slice(1).split('/') : [...page.split('/').slice(0, -1), ...href.split('/')]
        const resolved: string[] = []
        for (const part of parts) {
          if (part === '..') resolved.pop()
          else if (part !== '.' && part !== '') resolved.push(part)
        }
        const path = resolved.join('/').replace(/\.(md|html)$/, '')
        target = `${path === '' ? 'index' : href.endsWith('/') ? `${path}/index` : path}.md`
      }
      const targetIds = ids.get(target)
      if (targetIds === undefined) continue
      links++
      if (!targetIds.has(decodeURIComponent(anchor))) dead.push({ page, link: `${href}#${anchor}`, target })
    }
  }
  return { links, dead }
}

/** Every page under {@link CONTENT_ROOT} (both locales), keyed by its content-relative path. */
export function contentPages(root: string = REPO_ROOT): Map<string, string> {
  const contentDir = join(root, DOCS_SITE_DIR, CONTENT_ROOT)
  const pages = new Map<string, string>()
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      else if (entry.name.endsWith('.md')) pages.set(`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), 'utf8'))
    }
  }
  if (existsSync(contentDir)) walk(contentDir, '')
  return pages
}

function reportAnchors(): number {
  const { links, dead } = deadAnchors(contentPages())
  console.log(`check-docs-site-build: ${links} in-site \`#anchor\` link(s) read; ${dead.length} dead.`)
  if (dead.length === 0) return 0
  console.log('')
  console.log(`REFUSED: ${dead.length} link(s) name an anchor their page does not render.`)
  for (const entry of dead) console.log(`  ${entry.page} — (${entry.link}) → no id "${decodeURIComponent(entry.link.split('#')[1]!)}" on ${entry.target}.`)
  console.log(
    '  Spell the id vitepress RENDERS (vitepressSlug above): it drops diacritics after NFKD, so ё and й'
    + '\n  become е and и, and a ru page links to its own translated heading, not to the en one.',
  )
  return 1
}

function main(): number {
  // The parity half reads markdown only, so it runs on every machine — INCLUDING
  // the one that skips the build for want of vitepress, which is most of them.
  // The anchor half (F1.1171) is markdown only for the same reason; both run, so one cannot hide the other.
  const parityOnly = reportParity()
  const anchorStatus = reportAnchors()
  const markdownStatus = parityOnly !== 0 ? parityOnly : anchorStatus

  const reason = skipReason()
  if (reason !== null) {
    console.log(`SKIP (the build half only): ${reason}`)
    return markdownStatus
  }

  console.log(
    `check-docs-site-build: \`vitepress ${buildArgv('<scratch>').join(' ')}\` from ${DOCS_SITE_DIR}/ `
    + '— the dead-link check is on (`ignoreDeadLinks` is not set).',
  )
  const outcome = runBuild()
  const usage = process.cpuUsage()
  console.log(
    `check-docs-site-build: real ${outcome.real.toFixed(2)} / user ${(usage.user / 1e6).toFixed(2)} / `
    + `sys ${(usage.system / 1e6).toFixed(2)} (this process; the build is the child).`,
  )
  if (outcome.status !== 0) {
    console.log('')
    console.log(`REFUSED: the docs-site build exited ${outcome.status}.`)
    console.log(
      '  A dead internal link is the usual cause and vitepress names the file and the link above —'
      + '\n  `ignoreDeadLinks` is deliberately not set in `content/.vitepress/config.ts`, so a link that'
      + '\n  resolves to nothing fails the build rather than shipping as a 404 in one locale.',
    )
    console.log(
      '  BOTH locales are built by one run: `content/` and `content/ru/` are one site. What the build'
      + '\n  CANNOT see is a section missing from a translation — that is the parity half above, and it'
      + '\n  is why this gate has two.',
    )
  }
  // Either half failing fails the gate, and the build's own status is kept when
  // it is the one that failed: a reader's next question is which half.
  return outcome.status !== 0 ? outcome.status : markdownStatus
}

if (import.meta.main) {
  try {
    process.exit(main())
  } catch (error) {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}
