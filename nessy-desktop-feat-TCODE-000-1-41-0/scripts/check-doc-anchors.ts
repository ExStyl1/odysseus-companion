#!/usr/bin/env bun
/**
 * check-doc-anchors.ts — a snapshot guard for the SECTION-ANCHOR half of our
 * Claude-docs citations.
 *
 * WHY A SECTION-ANCHOR GUARD AND NOT THE OBVIOUS ONE. The measured inventory
 * (2026-08-25, `P2.69`) is 8 573 `page.md:<line>` anchors over 257 pages plus
 * 14 202 in-repo `file.ts:<line>` anchors, of which 12 983 resolve and **1 882
 * are provably dead — 14.5%** (674 land on a blank line, 249 past EOF, 959 on a
 * bare `}` or a comment terminator); the other 10 791 are UNVERIFIED, not
 * verified — a distinction three "all citations measured" claims elided. A blank-line
 * checker over that population would catch the 14.5%, miss every phantom quote
 * and all 26 wrong-layer copies, and need an 1 882-entry baseline just to ship
 * green — it would institutionalise the backlog instead of stopping its growth.
 * So this guard covers the anchors that do NOT decay: a page's section anchors
 * are part of its published link contract, while a line number has a measured
 * half-life of about two days (`permission-modes.md` moved its whole "Protected
 * paths" section up 14 lines between two fetches two days apart).
 *
 * ==========================================================================
 * WHAT THIS GUARD CANNOT CATCH — read this before quoting it as assurance.
 * A live anchor is NOT a verified citation: this guard cannot tell whether the
 * section still SAYS what the citing text claims, it cannot see a phantom quote
 * (six were measured, then four more on 2026-08-25 in one file — quoted strings
 * on no fetchable revision of the page), it cannot see an anchor that RESOLVES
 * AND LANDS ON NOTHING (`settings.md` keeps about forty `<span id>` redirect
 * stubs in one block above its prose, each a perfectly live anchor pointing at
 * material that moved to another page), it cannot see any line-numbered anchor at
 * all (all 8 573 of them), it cannot
 * notice an upstream rename until someone runs `--refresh`, and it does not
 * cover in-repo or third-party anchors (those are counted and reported, never
 * checked). It answers exactly one question: is this `page.md#section` a section
 * of that page in the corpus, as published on the snapshot date.
 * ==========================================================================
 *
 * That paragraph is here because its absence is a measured failure mode: three
 * separate "all citations measured" claims were made in one week on rigs blind
 * to a third of the anchors, and a guard whose limits are unwritten gets read as
 * a guarantee.
 *
 * ==========================================================================
 * THE QUOTE LIMIT IS DELIBERATE, DECIDED 2026-08-29 (`P2.191`), NOT PENDING.
 * The obvious next step is to grow a quote check into this guard. Measured, that
 * would break the one property that makes this guard runnable: it is OFFLINE
 * against a snapshot, and a quote snapshot cannot hold.
 *
 * The measurement, on `managed-policy.ts`, the file with the densest citations
 * in this tree: 63 distinct quoted strings of 30+ characters sit in its comments,
 * every one beside a live section anchor. Re-fetching the eighteen pages it cites
 * on 2026-08-29 — four days after the pass that verified them — found **19 live
 * and 44 not**, of which roughly two dozen are page text that was simply
 * reworded; `settings-reference.md` had grown 5 474 → 5 669 lines and rewritten
 * most of its per-key opening sentences in those four days. A section anchor from
 * the same file's 2026-08-25 pass, re-probed the same day, was still live.
 *
 * So the two populations decay at different orders of magnitude, and a snapshot
 * that is right about anchors would be wrong about quotes within the week —
 * shipping red on drift nobody caused, which is how a guard gets muted. A quote
 * check has to be ONLINE, which is `--refresh`'s posture and not the audit's.
 * It is therefore a SEPARATE instrument if anyone builds one, and until then the
 * class is caught at citation time by fetching the page and matching the sentence
 * with a positive control. This paragraph is the decision; the limit above is
 * not an admission of an unfinished job.
 * ==========================================================================
 *
 * WHAT IT CHECKS, offline, against `scripts/claude-doc-anchors.tsv`:
 *
 *   1. `anchor-not-a-section` — the page is snapshotted and the anchor is not
 *      one of its sections. This is the typo/rename class, and the trap inside
 *      it was pointing the wrong way until 2026-08-25: the rule recorded three
 *      times in this tree — "`#permissionsdefaultmode`, not
 *      `#permissions-defaultmode`" — is INVERTED. A dotted key slugifies with
 *      its dots turned into hyphens, measured against the rendered HTML rather
 *      than against a snapshot this file generated (see `slugifyHeading`). The
 *      old rule mis-slugged 59 of `settings-reference.md`'s 255 headings, so it
 *      pinned a CORRECT citation (`#sandbox-filesystem-allowwrite`) as dead
 *      while blessing two genuinely dead ones in `managed-policy.ts`.
 *   2. `page-not-in-corpus` — a bare `<name>.md#…` that is neither a page in
 *      `scripts/claude-doc-pages.tsv` nor a file in this repo. A page can LEAVE
 *      the corpus (`agent-sdk/slash-commands` did, on 2026-08-09) and a page can
 *      SPLIT, which no page count can see.
 *   3. `page-not-snapshotted` — a corpus page cited with an anchor whose
 *      sections were never snapshotted. This is the completeness half, the thing
 *      that makes this a guard rather than a fix for seven pages: a newly cited
 *      page cannot slip in unchecked.
 *   4. `pinned-anchor-now-live` / `pinned-dead-anchor-gone` — the pinned list
 *      below cannot outlive the defect it records.
 *
 * Usage:  bun scripts/check-doc-anchors.ts                        # offline audit, whole tree
 *         bun scripts/check-doc-anchors.ts --paths <glob…>       # scoped audit (see below)
 *         bun scripts/check-doc-anchors.ts --refresh             # re-fetch, rewrite the snapshot
 *
 * THREE REPORT-SIDE PROPERTIES ADDED 2026-09-07 (`P6.680`), each from a measured
 * failure of the previous shape. None of them changes what is checked.
 *
 *   a. **Every citer of a defect is listed, not one.** The old code kept a
 *      `reported` set and emitted the FIRST citation of each dead anchor, so the
 *      finding list was a floor on sites and read like a census. W7-ah enumerated
 *      six sites from it and they were EIGHT: fixing the named site did not clear
 *      the finding, it revealed the next citer, and the count barely moved.
 *      `Finding.sites` now carries all of them and the message prints them, with
 *      `… and N more` past `MAX_LISTED_SITES` so one anchor cited 200 times does
 *      not bury the other findings.
 *   b. **`--paths <glob…>` scopes the scan.** Three concurrent whole-tree runs
 *      took 5–18 minutes of WALL for 1–2 s of CPU at load 11–15 — the cost is
 *      reading ~4 100 files, and it is I/O, so it collapses under fleet load
 *      exactly when a lane is checking its own edit. A scoped run over 2 504
 *      files finished in under two minutes and caught all three sprung traps.
 *      SCOPING SUPPRESSES THE TWO TOTALITY FINDINGS (`pinned-dead-anchor-gone`,
 *      `known-live-anchor-uncited`): both mean "nothing in the tree cites this
 *      any more", and a subset cannot say that — reporting them would train
 *      readers to ignore the guard's two self-cleaning checks.
 *   c. **A marked placeholder is skipped and COUNTED.** A file that discusses a
 *      dead anchor has to write it somehow, and writing it contiguously CITES it:
 *      the known-failing register scored its own eighth finding that way, and two
 *      of W7-ah's fixes came back red because the comment explaining the fix
 *      re-created the finding. The register's answer is to split the token
 *      (`page.md` then `#anchor`), which works and is unreadable. The escape here
 *      is per-OCCURRENCE, not a wider `SELF`: a line carrying the marker
 *      `PLACEHOLDER_MARKER` has its references skipped, and the run prints how
 *      many were skipped, so an escape cannot become a silent suppression the way
 *      a file-level exclusion would. Widening `SELF` was rejected for the reason
 *      the register gives: it would blind the guard to the REAL citations in the
 *      same file.
 *
 * Its enforcing reader is `scripts/check-doc-anchors.test.ts`, because CI runs
 * `bun test` and does NOT run `validate:ci` (measured from `.gitlab-ci.yml`,
 * then verified by running the aggregates; `test:doc-tools` is commented out).
 * A guard wired only into a script nobody invokes is the defect class this file
 * belongs to.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'

const HERE = import.meta.dir ?? new URL('.', import.meta.url).pathname
export const REPO = resolve(HERE, '..')
export const PAGES_TSV = resolve(HERE, 'claude-doc-pages.tsv')
export const ANCHORS_TSV = resolve(HERE, 'claude-doc-anchors.tsv')

/** Where a page is fetched from. `--refresh` is the only thing that goes online. */
export const PAGE_URL = (slug: string): string => `https://code.claude.com/docs/en/${slug}.md`

/**
 * Files this guard does not scan, and why: both name anchors as EXAMPLES,
 * including deliberately wrong ones for the positive control and the dead pairs
 * recorded in `PINNED_DEAD`. Scanning them would make the guard report itself.
 */
export const SELF = ['scripts/check-doc-anchors.ts', 'scripts/check-doc-anchors.test.ts']

/**
 * The per-occurrence placeholder escape (`P6.680`, item c above).
 *
 * A line carrying this marker has its citation-shaped references SKIPPED and
 * COUNTED. It exists because there is a second, legitimate reason to write a
 * dead anchor in citation form — naming the defect you are fixing, or writing an
 * example of the shape — and the only previously available answer was to split
 * the token apart, which the known-failing register does throughout and which
 * makes the prose it appears in unreadable.
 *
 * WHY A MARKER AND NOT A WIDER `SELF`. A file-level exclusion blinds the guard to
 * every REAL citation in that file, and the files that discuss dead anchors are
 * exactly the files that also cite live ones. This is one line, and the run
 * prints the skip count, so an escape that starts covering real citations is
 * visible in the ordinary output rather than buried in a list nobody reads.
 *
 * The marker deliberately contains no `.md#`, so writing it can never create the
 * finding it suppresses.
 */
export const PLACEHOLDER_MARKER = 'doc-anchor:example'

/** Extensions measured to carry `page.md#section` citations, plus the obvious neighbours. */
const SCANNED = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.py', '.swift', '.yml', '.yaml', '.sh']

/**
 * A `page.md#section` reference. The optional prefixes matter: `./statuses.md`
 * is a repo-relative link and `repo://docs/…` is an evidence URI in a test
 * fixture — losing the prefix would misfile both as corpus pages.
 *
 * THE ANCHOR CLASS ADMITS `/`, `’` AND `+` (the `+` since C3.330, 2026-09-12: a citation
 * of `reverse-search-with-ctrl+r` was being READ as `…-ctrl`, so the guard reported a
 * live anchor dead from its own truncation), AND MUST, because `slugifyHeading` EMITS
 * them (2026-08-31, `P2.376`). This was a silent truncation, not a cosmetic gap:
 * `[A-Za-z0-9_-]+` stops dead at the first `/` or typographic apostrophe, so a
 * citation of one of those anchors was read as a DIFFERENT, shorter anchor that no
 * page carries — and the guard then reported the citer's correct anchor as dead.
 * Measured over the tree, six distinct references in twelve places were being
 * truncated this way:
 *
 *   `advisor.md#use-the-/advisor-command`      → read as `#use-the-`
 *   `statusline.md#use-the-/statusline-command`→ read as `#use-the-`
 *   `interactive-mode.md#side-questions-with-/btw`
 *   `hooks.md#the-/hooks-menu`                 → read as `#the-`
 *   `settings.md#troubleshoot-a-setting-that-doesn’t-apply` → read as `…doesn`
 *   `agent-sdk/migration-guide.md#what’s-changed`          → read as `#what`
 *
 * All six are ids the rendered pages actually carry, and seven such slugs were
 * already sitting in the snapshot (`the-/hooks-menu`, `use-the-/config-menu`,
 * `read-the-source-in-/status`, `what’s-next`, …) — reachable by `sectionSlugs`
 * and unreachable by this regex, which is a guard guaranteed to be wrong about
 * every citation of them. The `/` is allowed only BETWEEN anchor segments
 * (`(?:\/[…]+)*`), never trailing, so a `hooks.md#setup` that merely happens to be
 * followed by a slash is not extended; measured across the tree, the widened class
 * changes those twelve references and nothing else.
 */
const REFERENCE =
  /(?:https?:\/\/|repo:\/\/|\.{1,2}\/)?[A-Za-z0-9][A-Za-z0-9./_-]*\.md#[A-Za-z0-9_\u2019+-]+(?:\/[A-Za-z0-9_\u2019+-]+)*/g

/** `https://code.claude.com/docs/en/hooks.md#…` and the bare-host form of it. */
const CORPUS_URL = /^(?:https?:\/\/)?(?:www\.)?code\.claude\.com\/docs\/(?:en\/)?/

/** `github.com/…`, `www.rubydoc.info/…` — a host we neither snapshot nor own. */
const THIRD_PARTY_HOST = /^(?:https?:\/\/)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\//

// ---------------------------------------------------------------------------
// Anchors that are dead RIGHT NOW, pinned so the guard is green while the fix
// lands in files this lane does not own.
// ---------------------------------------------------------------------------

/**
 * Each entry is a measured defect with a named owner, not a suppression.
 *
 * **EMPTY, as of 2026-08-25 (P2.183), and that is the point of the mechanism.**
 * The list held six entries for one commit. Four of them were the guard's own
 * bugs and two were real; all six are gone, the two real ones because the
 * citation was fixed. The four false ones are the more useful history:
 *
 *  - `managed-settings.md#invalid-entries-in-managed-settings` (18 citations),
 *    `settings.md#hook-configuration` and `permissions.md#managed-only-settings`
 *    are all live `<span id>` anchors, and `sectionSlugs` only read headings.
 *  - `settings-reference.md#sandbox-filesystem-allowwrite` was correct all along;
 *    `slugifyHeading` deleted the dots instead of hyphenating them.
 *
 * So a pin is where a WRONG GUARD goes to be believed, not only a held file. The
 * rules that follow from that, for whoever adds the seventh entry:
 *
 *  1. Before pinning, check the anchor against the RENDERED page — `curl` the
 *     URL without `.md` and grep for `id="…"`. Four of six pins would have died
 *     on that one command.
 *  2. A pin is dropped in the SAME commit as the fix. The count is printed on
 *     every successful run, and the reader below asserts this list's exact
 *     length, so a pin cannot quietly become the backlog this guard exists to
 *     stop growing.
 *  3. Pin only what another lane holds, and name the file in the note.
 */
export interface PinnedDead {
  page: string
  anchor: string
  /** The live section that replaces it, as far as the snapshot can tell. */
  liveInstead: string
  /** Who carries it, and anything that makes the fix a judgement call. */
  note: string
}

export const PINNED_DEAD: PinnedDead[] = []

/**
 * The MIRROR of `PINNED_DEAD`: anchors that are LIVE on the rendered page and
 * that `sectionSlugs` cannot derive from the markdown.
 *
 * `PINNED_DEAD` is where a dead anchor waits for its citation to be fixed. This
 * is the opposite error, and the guard has been making it continuously: a
 * `<Tab title="…">` gets a rendered id, `sectionSlugs` deliberately does not
 * slugify tab titles (a tab title is DERIVED text and titles repeat heavily, so
 * minting slugs for them would let the guard BLESS a dead citation), and the
 * one anchor in this repo that turns on one has therefore been reported dead
 * since the guard was written. It is the suite's only remaining finding, and it
 * is the guard being wrong rather than the tree.
 *
 * THE ENTRY BAR IS THE SAME AS A PIN'S, AND IT IS THE `--refresh`-PROOF ONE:
 * verified against the RENDERED page, not against a slug rule. A `--refresh`
 * cannot fix these, because refreshing re-derives from the same markdown and
 * changes nothing — which is exactly what `changelog.md#2-1-248` did until
 * `<Update label>` was admitted. So each entry records the probe that settled it.
 *
 * Adding one without that probe would be the failure this guard exists for,
 * inverted: four of `PINNED_DEAD`'s six historical entries died on one `curl`.
 */
export interface KnownLiveAnchor {
  page: string
  anchor: string
  /** Why `sectionSlugs` cannot see it. */
  underivable: string
  /** The measurement, dated, against the rendered page. */
  verified: string
}

export const KNOWN_LIVE_UNDERIVABLE: KnownLiveAnchor[] = [
  {
    page: 'hooks.md',
    anchor: 'top-level-decision',
    underivable:
      'the id comes from `<Tab title="Top-level decision">`; `sectionSlugs` declines tab titles '
      + 'because they repeat across and within pages and a duplicate takes a numeric suffix no slug '
      + 'rule predicts, so slugifying them would mint plausible WRONG ids.',
    verified:
      'GET https://code.claude.com/docs/en/hooks (rendered, no `.md`) on 2026-09-03: 200, '
      + '2 824 283 bytes, 752 distinct `id="…"` values, of which `top-level-decision` is one '
      + '(`panel-top-level-decision-0` is its panel sibling). P2.376.',
  },
]

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/**
 * A heading's anchor, by the rule the published pages actually use.
 *
 * DERIVED FROM THE RENDERED PAGES, NOT FROM THE MARKDOWN. This is the correction
 * that matters: the first version of this function was validated against a
 * snapshot IT had generated, so a wrong rule verified its own citations. The rule
 * below was measured the only way that is not circular — by fetching the rendered
 * HTML of nine pages on 2026-08-25 (the seven this repo cites with an anchor, plus
 * `plugins-reference` and `plugin-marketplaces`) and asking whether each heading's
 * computed slug is an `id` the page actually carries. Result: **666 of 666** for
 * every `##`, `###` and `####` heading, and **780 of 780** for the snapshot this
 * function and `sectionSlugs` produce together.
 *
 * What that measurement overturned: **a dot becomes a HYPHEN.** The previous rule
 * deleted it, and the "measured trap" recorded three times in this tree —
 * "`#permissionsdefaultmode`, not `#permissions-defaultmode`: a dotted key drops
 * its dots" — is INVERTED. `settings-reference` renders
 * `id="permissions-defaultmode"` and `id="sandbox-filesystem-allowwrite"`, and
 * links to both forms from its own index; there is no dot-stripped id anywhere on
 * the page. The old rule mis-slugged 59 of that page's 255 headings, which is how
 * a CORRECT citation (`settings-reference.md#sandbox-filesystem-allowwrite`) came
 * to be pinned as dead.
 *
 * The rest of the rule, each clause with its measured witness:
 *   - spaces hyphenate — `## What runs under allowManagedHooksOnly` →
 *     `#what-runs-under-allowmanagedhooksonly`
 *   - a dot hyphenates — `### Node.js package dependencies` →
 *     `#node-js-package-dependencies`
 *   - `,` `:` `(` `)` are DROPPED, and the space beside them still hyphenates —
 *     `## Agents, sessions, and worktrees` → `#agents-sessions-and-worktrees`,
 *     `### Host on GitHub (recommended)` → `#host-on-github-recommended`
 *   - `/` SURVIVES — `### Use the /config menu` → `#use-the-/config-menu`
 *   - an apostrophe survives as the TYPOGRAPHIC one the renderer substitutes —
 *     `### Troubleshoot a setting that doesn't apply` →
 *     `#troubleshoot-a-setting-that-doesn’t-apply`
 *
 * KNOWN UNEXERCISED: no heading on any snapshotted page contains `_`, so the
 * treatment of underscores is unverified — it is kept rather than deleted, on the
 * reasoning that deletion is what just cost a measurement. If a cited anchor ever
 * turns on one, read the rendered page's `id`, not this function.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/'/g, '\u2019')
    .replace(/[\s.]+/g, '-')
    // `+` SURVIVES on the rendered page (measured 2026-09-12, C3.330:
    // `interactive-mode` publishes `id="reverse-search-with-ctrl+r"`), so it is
    // kept beside `/` and the apostrophe; the snapshot this function generated
    // had dropped it for one heading and the guard called a live anchor dead.
    .replace(/[^\p{L}\p{N}\-/\u2019_+]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** An explicit compatibility anchor: `<span id="invalid-entries-in-managed-settings" />`. */
const SPAN_ANCHOR = /<span\s+id="([^"]+)"\s*\/?>/g

/**
 * A RAW HTML HEADING that declares its own id: `<h4 id="process-wrappers">`.
 *
 * The third kind, added 2026-08-31 (`P2.376`) after it cost three false findings on
 * anchors that are live — the same failure the `<span id>` clause above was added to
 * stop, in a shape nobody had looked for. The pages mix markdown headings with raw
 * HTML ones, and a raw one is an id DECLARATION, not a slug derived from text:
 *
 *   `permissions.md`      `<h4 id="process-wrappers">`
 *   `permission-modes.md` `<h2 id="eliminate-prompts-with-auto-mode">`
 *   `interactive-mode.md` `<h3 id="make-ctrl-w-delete-back-to-whitespace">`
 *
 * All three verified as ids on the rendered pages; none is a markdown heading, so
 * `sectionSlugs` saw none of them and reported all three citations dead. 64 such
 * declarations sit across the 97 pages this repo cites.
 *
 * ANY level is accepted, unlike markdown headings. `ANCHORED_LEVELS` narrows those
 * because the RENDERER decides whether to mint an id from heading text (`#` 0/9,
 * `#####` 3/24) — a guess this guard must not make. Here there is nothing to guess:
 * the page states the id, and the three witnesses above are h4, h2 and h3.
 *
 * WHAT IS STILL MISSED, measured and deliberately left: `<Tab title="…">` also gets
 * a rendered id (`hooks.md`'s `<Tab title="Top-level decision">` is `#top-level-decision`),
 * and there are 111 of them across the same pages. They are NOT added, because a tab
 * title is DERIVED text, not a declared id, and tab titles repeat heavily within and
 * across pages (`CLI`, `Desktop`, `macOS/Linux`) — and a duplicate heading takes a
 * numeric suffix that no slug rule predicts (`plugin-marketplaces.md` publishes both
 * `#required-fields` and `#required-fields-2`). Slugifying them would mint plausible
 * wrong slugs, which is worse than missing them: a wrong slug in the snapshot lets the
 * guard BLESS a dead citation, while a missing one only over-reports.
 */
const HTML_HEADING_ANCHOR = /<h[1-6][^>]*\sid="([^"]+)"/g

/**
 * A `<Update label="2.1.248">` entry, whose slugified label the renderer publishes as an id.
 *
 * ADMITTED, unlike `<Tab title>`, and the difference is measured rather than aesthetic.
 * `changelog.md` has exactly ONE markdown heading — an `h1`, which gets no id — and no
 * declared `id` at all, so `sectionSlugs` returned an EMPTY list for it. An empty list
 * writes no rows, and a page with no rows is indistinguishable from a page that was never
 * snapshotted: the citation `changelog.md#2-1-248` was reported `page-not-snapshotted`
 * forever, and `--refresh` could not fix it because refreshing changed nothing.
 *
 * The rendered page carries 385 ids, 380 of them from these labels. Validated the only
 * non-circular way — slugify every label in the twin, then ask the rendered page whether it
 * carries that id: **380 of 380, and all 380 distinct.** Distinctness is the clause that
 * makes this safe where a tab title is not: a duplicate takes a numeric suffix no slug rule
 * predicts, and version labels cannot collide by construction. `<Update label>` also appears
 * on exactly ONE of the 97 pages this repo cites, so the blast radius is that page.
 *
 * The label is DERIVED text, so it goes through `slugifyHeading` — which is why the dotted
 * form works at all: `2.1.248` hyphenates to `2-1-248`, the rule this guard once had backwards.
 */
const UPDATE_LABEL = /<Update[^>]*\slabel="([^"]+)"/g

/**
 * Levels the renderer gives an `id`. Measured on the same nine pages: `##` 89/89,
 * `###` 427/427, `####` 150/150 — and `#` 0/9, `#####` 3/24. So an `h1` or an
 * `h5` heading is NOT a reachable anchor, and putting its slug in the snapshot
 * would let the guard bless a citation that resolves to nothing. Narrower is
 * correct here, not merely stricter.
 */
const ANCHORED_LEVELS = new Set([2, 3, 4])

/**
 * Section anchors of a markdown page, in document order.
 *
 * TWO KINDS, and missing the second one cost three false pins. Besides its
 * headings, a page publishes explicit `<span id="…" />` anchors, and those are
 * the MOST load-bearing anchors it has: they are what a rename leaves behind for
 * everyone already linking to the old name. `managed-settings.md` carries
 * `<span id="invalid-entries-in-managed-settings" />` above its renamed "Find
 * entries Claude Code dropped" section, and both `settings.md` and
 * `settings-reference.md` link to it by that name in their own prose ("[Invalid
 * entries in managed settings] says what it drops and which keys fall back to a
 * stricter value until you fix them") — so a guard that saw only headings
 * reported 18 citations of a live, upstream-maintained anchor as dead.
 * `settings.md#hook-configuration` is the same shape.
 *
 * Lines inside a fenced block are skipped for both kinds: a `# comment` in a
 * shell example is not a heading, and counting it would put a slug in the
 * snapshot that no anchor can ever reach.
 */
export function sectionSlugs(markdown: string): string[] {
  const slugs: string[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const declared of [...line.matchAll(SPAN_ANCHOR), ...line.matchAll(HTML_HEADING_ANCHOR)]) {
      const id = declared[1] ?? ''
      if (id.length > 0) slugs.push(id)
    }
    for (const update of line.matchAll(UPDATE_LABEL)) {
      const slug = slugifyHeading(update[1] ?? '')
      if (slug.length > 0) slugs.push(slug)
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!heading) continue
    if (!ANCHORED_LEVELS.has(heading[1]?.length ?? 0)) continue
    const slug = slugifyHeading(heading[2] ?? '')
    if (slug.length > 0) slugs.push(slug)
  }
  return slugs
}

// ---------------------------------------------------------------------------
// Reading the two snapshots
// ---------------------------------------------------------------------------

/** Page slugs in `scripts/claude-doc-pages.tsv` — the corpus, per AGENTS.md. */
export function readCorpus(tsvText: string): Set<string> {
  return new Set(
    tsvText
      .split('\n')
      .filter(line => line.trim().length > 0 && !line.startsWith('#'))
      .map(line => line.split('\t')[0] ?? '')
      .filter(slug => slug.length > 0),
  )
}

export interface AnchorSnapshot {
  /** page slug (`hooks`, `agent-sdk/skills`) → its section slugs. */
  sections: Map<string, Set<string>>
  /** The `Snapshot:` date from the header, reported in every message. */
  fetched: string
}

export function readAnchorSnapshot(tsvText: string): AnchorSnapshot {
  const sections = new Map<string, Set<string>>()
  let fetched = 'unknown'
  for (const line of tsvText.split('\n')) {
    const stamp = /^#\s*Snapshot:\s*(\S+)/.exec(line)
    if (stamp) fetched = stamp[1]!
    if (line.startsWith('#') || line.trim().length === 0) continue
    const [page, slug] = line.split('\t')
    if (!page || !slug) continue
    const set = sections.get(page) ?? new Set<string>()
    set.add(slug)
    sections.set(page, set)
  }
  return { sections, fetched }
}

// ---------------------------------------------------------------------------
// Collecting citations
// ---------------------------------------------------------------------------

export type Bucket = 'corpus' | 'in-repo' | 'third-party' | 'unresolved'

export interface Citation {
  /** Citing file, repo-relative. */
  file: string
  line: number
  /** As written. */
  raw: string
  /** Corpus page slug without `.md`, or the reference's path for other buckets. */
  page: string
  anchor: string
  bucket: Bucket
  /**
   * Set ONLY when the citing line carries `PLACEHOLDER_MARKER`. Absent otherwise,
   * rather than `false`, so a citation object keeps the exact shape every existing
   * reader asserts against.
   */
  placeholder?: true
}

export interface ClassifyDeps {
  corpus: Set<string>
  /** Repo-relative existence test, injected so the classifier stays pure in tests. */
  fileExists: (repoRelative: string) => boolean
}

/**
 * Which of the four worlds a reference belongs to.
 *
 * Only `corpus` is checked. `in-repo` and `third-party` are counted and
 * reported: this guard has no snapshot of a GitHub README's headings, and our
 * own docs are a different problem with a different answer — measured while
 * writing this, `docs/testing/cdp-live-checklist.md` has exactly ONE heading
 * because the checklist is a single case table now, so the six
 * `#p13-desktop-*` anchors cited from a plugins test fixture point at table rows
 * that GitHub generates no anchor for, and two `repo://` evidence URIs in
 * `packages/pi-agent-server/.../behavior-corpus.json` name a file
 * (`docs/current-plans/nessy-agent-harness-parity.md`) that no longer exists.
 * Both belong to whoever owns those fixtures; folding them in here would make
 * this guard red on defects it cannot fix and that is how a guard gets disabled.
 */
export function classify(
  reference: string,
  citingFile: string,
  deps: ClassifyDeps,
): { page: string; anchor: string; bucket: Bucket } {
  const hash = reference.indexOf('#')
  const rawPath = reference.slice(0, hash)
  const anchor = reference.slice(hash + 1)

  const corpusPath = rawPath.replace(CORPUS_URL, '')
  const slug = corpusPath.replace(/\.md$/, '')
  if (deps.corpus.has(slug)) return { page: slug, anchor, bucket: 'corpus' }

  // A repo path, relative or root-anchored, resolvable or not — someone else's
  // problem either way, but the RESOLVABLE ones are not even a problem.
  const relative = rawPath.replace(/^repo:\/\//, '')
  const beside = join(dirname(citingFile), relative.replace(/^\.\//, ''))
  if (deps.fileExists(relative) || deps.fileExists(beside)) {
    return { page: relative, anchor, bucket: 'in-repo' }
  }
  if (CORPUS_URL.test(rawPath)) return { page: slug, anchor, bucket: 'unresolved' }
  if (THIRD_PARTY_HOST.test(rawPath)) return { page: rawPath, anchor, bucket: 'third-party' }
  // A path-shaped reference that does not resolve is an in-repo link rot, not a
  // corpus question. Reported in the bucket counts, and named above.
  if (relative.includes('/')) return { page: relative, anchor, bucket: 'in-repo' }
  return { page: slug, anchor, bucket: 'unresolved' }
}

/**
 * Every reference in one file's text. Pure: the caller supplies the text.
 *
 * A reference on a line carrying `PLACEHOLDER_MARKER` is still RETURNED — marked,
 * never dropped — so the audit can count what it skipped. Dropping it here would
 * make the escape invisible, which is the property that separates it from a
 * suppression.
 */
export function scanText(file: string, text: string, deps: ClassifyDeps): Citation[] {
  const found: Citation[] = []
  const lines = text.split('\n')
  let line = 1
  let index = 0
  for (const match of text.matchAll(REFERENCE)) {
    const at = match.index ?? 0
    for (; index < at; index += 1) if (text[index] === '\n') line += 1
    const { page, anchor, bucket } = classify(match[0], file, deps)
    const marked = (lines[line - 1] ?? '').includes(PLACEHOLDER_MARKER)
    found.push({ file, line, raw: match[0], page, anchor, bucket, ...(marked ? { placeholder: true as const } : {}) })
  }
  return found
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export type FindingKind =
  | 'anchor-not-a-section'
  | 'known-live-anchor-now-derivable'
  | 'known-live-anchor-uncited'
  | 'page-not-in-corpus'
  | 'page-not-snapshotted'
  | 'pinned-anchor-now-live'
  | 'pinned-dead-anchor-gone'

export interface Finding {
  kind: FindingKind
  subject: string
  detail: string
  /**
   * EVERY citing site, `file:line`, in scan order — the P6.680 half. Empty for
   * the findings that come from the pinned/known-live lists rather than from a
   * citation, because those have no site to walk to.
   */
  sites: string[]
}

/**
 * How many sites the MESSAGE prints before it summarises the rest. `Finding.sites`
 * always carries all of them; this only bounds the text, because one anchor cited
 * two hundred times would otherwise bury every other finding in the output.
 */
export const MAX_LISTED_SITES = 12

function sitesText(sites: readonly string[]): string {
  if (sites.length <= MAX_LISTED_SITES) return sites.join(', ')
  return `${sites.slice(0, MAX_LISTED_SITES).join(', ')} … and ${sites.length - MAX_LISTED_SITES} more`
}

/**
 * The bucket for a finding with no citing site: the pinned-dead and known-live
 * list entries, which come from a LIST in this file rather than from a citation.
 * Naming it is the point — an empty-string key would read as a bug in the
 * grouping, and dropping those findings would hide two whole kinds.
 */
export const NO_CITING_SITE = '(no citing site — a pinned/known-live list entry, not a citation)'

/**
 * The findings re-indexed BY CITING FILE — C3.338, born from W18-d's proposed
 * row 4 (2026-09-12).
 *
 * The audit's own shape is per ANCHOR, and that is the right shape for repairing
 * one: `Finding.sites` carries every site, so fixing one site does not clear it.
 * It is the wrong shape for the other question a lane asks, which is *"what is
 * left in MY file, and which of these are mine?"* — two lanes in a row read that
 * out of a raw array diff by eye, and the whole-tree assertion prints `kind` and
 * `subject` with no file in them at all.
 *
 * So this is a VIEW, not a second audit: same findings, re-keyed, nothing
 * filtered. Values read `<line>  [kind] subject`, line-sorted numerically, so an
 * `toEqual({})` diff names the file and the line to walk to.
 */
export function findingsByCitingFile(findings: readonly Finding[]): Record<string, string[]> {
  const byFile = new Map<string, { line: number, text: string }[]>()
  for (const finding of findings) {
    const label = `[${finding.kind}] ${finding.subject}`
    if (finding.sites.length === 0) {
      const rows = byFile.get(NO_CITING_SITE) ?? []
      rows.push({ line: 0, text: label })
      byFile.set(NO_CITING_SITE, rows)
      continue
    }
    for (const site of finding.sites) {
      const at = site.lastIndexOf(':')
      const file = at === -1 ? site : site.slice(0, at)
      const line = at === -1 ? 0 : Number.parseInt(site.slice(at + 1), 10)
      const rows = byFile.get(file) ?? []
      rows.push({ line: Number.isNaN(line) ? 0 : line, text: `${site.slice(at + 1)}  ${label}` })
      byFile.set(file, rows)
    }
  }

  const out: Record<string, string[]> = {}
  for (const file of [...byFile.keys()].sort()) {
    const rows = (byFile.get(file) ?? []).slice().sort((a, b) => a.line - b.line || a.text.localeCompare(b.text))
    out[file] = rows.map(row => row.text)
  }
  return out
}

export interface AnchorAudit {
  findings: Finding[]
  /** Corpus citations whose anchor is a section in the snapshot. */
  verified: number
  /** Citations of a pinned-dead pair. */
  pinned: number
  /** References skipped because their line carried `PLACEHOLDER_MARKER`. */
  placeholders: number
  perBucket: Record<Bucket, number>
}

export function auditAnchors(
  citations: readonly Citation[],
  snapshot: AnchorSnapshot,
  pinned: readonly PinnedDead[] = PINNED_DEAD,
  // Defaults to EMPTY, unlike `pinned`, and the asymmetry is deliberate: a caller
  // that forgets the list over-reports a live anchor, where a caller that
  // inherited it would silently accept one. `runAudit` passes it explicitly.
  knownLive: readonly KnownLiveAnchor[] = [],
  /**
   * True when `citations` is a SUBSET of the tree (`--paths`). It suppresses the
   * two totality findings only — both of them mean *nothing in the tree cites
   * this any more*, which a subset cannot establish. Everything else is a
   * property of the citations in hand and is checked identically.
   */
  scoped = false,
): AnchorAudit {
  const findings: Finding[] = []
  const perBucket: Record<Bucket, number> = { corpus: 0, 'in-repo': 0, 'third-party': 0, unresolved: 0 }
  const pinnedKeys = new Map(pinned.map(entry => [`${entry.page}#${entry.anchor}`, entry]))
  const pinnedSeen = new Set<string>()
  const knownLiveSeen = new Set<string>()
  let verified = 0
  let pinnedCount = 0
  let placeholders = 0
  /**
   * One finding per distinct defect, not per citation: 18 copies of one dead
   * anchor are one thing to fix. The value carries EVERY citer (P6.680) — the
   * previous shape kept only a `reported` set of keys, so a finding named its
   * first site and read like a census of them; W7-ah enumerated six sites that
   * way and they were eight.
   */
  const defects = new Map<string, { kind: FindingKind; subject: string; sites: string[]; detail: () => string }>()
  const record = (
    key: string,
    kind: FindingKind,
    subject: string,
    citation: Citation,
    detail: (sites: readonly string[]) => string,
  ): void => {
    const site = `${citation.file}:${citation.line}`
    const existing = defects.get(key)
    if (existing) {
      existing.sites.push(site)
      return
    }
    const sites = [site]
    defects.set(key, { kind, subject, sites, detail: () => detail(sites) })
  }

  for (const citation of citations) {
    // A marked placeholder is not a citation of anything: counted, never bucketed,
    // never audited. Counting it out loud is what keeps the escape from becoming a
    // suppression.
    if (citation.placeholder) {
      placeholders += 1
      continue
    }
    perBucket[citation.bucket] += 1
    const key = `${citation.page}.md#${citation.anchor}`
    if (citation.bucket === 'unresolved') {
      record(key, 'page-not-in-corpus', key, citation, sites =>
        `cited at ${sitesText(sites)} (${sites.length} site(s)) — a page that is not in `
        + 'scripts/claude-doc-pages.tsv and is not a file in this repo. A page can leave the index '
        + '(agent-sdk/slash-commands did) and a page can split — refresh the corpus snapshot, or '
        + 're-point the citation at the page that carries the section now.')
      continue
    }
    if (citation.bucket !== 'corpus') continue

    if (pinnedKeys.has(key)) {
      pinnedCount += 1
      pinnedSeen.add(key)
      continue
    }
    const sections = snapshot.sections.get(citation.page)
    if (!sections) {
      record(`page-not-snapshotted:${citation.page}`, 'page-not-snapshotted', `${citation.page}.md`, citation, sites =>
        `cited at ${sitesText(sites)} (${sites.length} site(s)) — a corpus page whose sections were `
        + 'never snapshotted, so the anchor is unchecked. Run `bun scripts/check-doc-anchors.ts '
        + '--refresh` (online) in a deliberate commit — a newly cited page must not slip in unchecked.')
      continue
    }
    if (sections.has(citation.anchor)) {
      verified += 1
      continue
    }
    // P2.376 — an anchor this guard cannot DERIVE but has verified against the
    // rendered page. Counted as verified, because it is: the evidence is the
    // page's own `id`, which is stronger than the snapshot it is missing from.
    if (knownLive.some(entry => `${entry.page}#${entry.anchor}` === key)) {
      verified += 1
      knownLiveSeen.add(key)
      continue
    }
    record(key, 'anchor-not-a-section', key, citation, sites =>
      `cited at ${sitesText(sites)} (${sites.length} site(s)) — not a section of ${citation.page}.md in `
      + `the ${snapshot.fetched} snapshot (${sections.size} sections). FIXING ONE SITE DOES NOT CLEAR `
      + 'THIS FINDING: every site above cites the same anchor. Either the anchor is wrong '
      + '(#permissions-defaultmode, not #permissionsdefaultmode: a dotted key hyphenates its dots) '
      + 'or the page has renamed the section since the snapshot — read the RENDERED page\'s `id`, '
      + 'never a slug rule, before editing either side, then `--refresh` or fix the citation.')
  }

  for (const defect of defects.values()) {
    findings.push({ kind: defect.kind, subject: defect.subject, detail: defect.detail(), sites: defect.sites })
  }

  for (const entry of knownLive) {
    const key = `${entry.page}#${entry.anchor}`
    const page = entry.page.replace(/\.md$/, '')
    if (snapshot.sections.get(page)?.has(entry.anchor)) {
      findings.push({
        kind: 'known-live-anchor-now-derivable',
        subject: key,
        detail:
          'allowed as underivable, but the snapshot now carries this section, so `sectionSlugs` can '
          + 'see it. Drop the entry — an allowance the guard no longer needs is an allowance that '
          + 'will one day cover a real defect.',
        sites: [],
      })
    }
    // TOTALITY, so a scoped run must not report it: "cited by nothing" is a
    // statement about the whole tree, and `--paths` read a subset of it.
    if (!scoped && !knownLiveSeen.has(key)) {
      findings.push({
        kind: 'known-live-anchor-uncited',
        subject: key,
        detail:
          'allowed as a live-but-underivable anchor and cited by nothing in this tree. The list is '
          + 'not a corpus index; drop the entry with the citation it was added for.',
        sites: [],
      })
    }
  }

  for (const entry of pinned) {
    const key = `${entry.page}#${entry.anchor}`
    const page = entry.page.replace(/\.md$/, '')
    if (snapshot.sections.get(page)?.has(entry.anchor)) {
      findings.push({
        kind: 'pinned-anchor-now-live',
        subject: key,
        detail: 'pinned as dead, but the snapshot says it IS a section now. Unpin it.',
        sites: [],
      })
    }
    // The other totality finding, suppressed under `--paths` for the same reason.
    if (!scoped && !pinnedSeen.has(`${page}.md#${entry.anchor}`)) {
      findings.push({
        kind: 'pinned-dead-anchor-gone',
        subject: key,
        detail:
          'pinned as dead and nothing cites it any more — the defect is fixed, so delete the entry. '
          + 'A pinned list that outlives its defect is a suppression.',
        sites: [],
      })
    }
  }

  return { findings, verified, pinned: pinnedCount, placeholders, perBucket }
}

// ---------------------------------------------------------------------------
// The repo side
// ---------------------------------------------------------------------------

/**
 * A `--paths` argument as a matcher.
 *
 * A bare directory is the shape a lane actually types (`--paths packages/shared`),
 * so it is widened to everything under it. Anything containing a glob character is
 * handed to `Bun.Glob` unchanged, which is why `--paths 'docs/**' 'scripts/*.ts'`
 * works. Quote your globs: an unquoted one is expanded by the shell against the
 * CWD before this ever sees it, which silently narrows the scan.
 */
export function pathMatcher(globs: readonly string[]): (path: string) => boolean {
  const matchers = globs.map(raw => {
    const pattern = /[*?[\]{}]/.test(raw) ? raw : `${raw.replace(/\/+$/, '')}/**`
    const glob = new Bun.Glob(pattern)
    // A bare directory also names itself and its direct children on some spellings,
    // so the prefix test runs beside the glob rather than instead of it.
    const prefix = /[*?[\]{}]/.test(raw) ? undefined : `${raw.replace(/\/+$/, '')}/`
    return (path: string): boolean =>
      glob.match(path) || (prefix !== undefined && (path === raw || path.startsWith(prefix)))
  })
  return path => matchers.some(match => match(path))
}

/**
 * Files to scan: tracked plus not-yet-ignored new ones, so a citation is caught
 * in the commit that writes it rather than one commit later. `.references/` is
 * vendored upstream and is not ours to cite from.
 *
 * `globs` is `--paths` (P6.680). It narrows WHICH files are read and nothing else:
 * the corpus, the snapshot and every check are identical, which is what makes a
 * scoped run's findings a subset of the full run's rather than a different answer.
 */
export function repoFiles(globs: readonly string[] = []): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO })
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`)
  const inScope = globs.length === 0 ? () => true : pathMatcher(globs)
  return listed.stdout
    .toString()
    .split('\0')
    .filter(path => path.length > 0)
    .filter(path => SCANNED.some(extension => path.endsWith(extension)))
    .filter(path => !path.startsWith('.references/'))
    .filter(path => !SELF.includes(path))
    .filter(inScope)
}

/**
 * The files that contain the substring `.md#` at all, straight from git.
 *
 * WHY: the scan's whole cost is READING ~4 100 files, and it is I/O, so it
 * collapses under fleet load exactly when a lane is checking its own edit —
 * measured 2026-09-07 at load 12–16, ALL of these at under 1 % cpu:
 *
 *   whole tree, inside `bun test`   157.9 s
 *   --paths apps/electron           62.2 s, then 81.0 s on the repeat (1 056 files)
 *   --paths scripts                 40.3 s for **223** files
 *   --paths packages/shared          0.7 s for 1 771 files, page cache warm
 *
 * So the wall time does not follow the file count, `--paths` alone cannot promise
 * a bound, and the only real lever is reading fewer bytes. `git grep -l` over the
 * whole tree costs **1.8 s** and returns **536** candidates, because git is C,
 * threaded, and stops at the first hit per file.
 *
 * WHY IT CANNOT CHANGE THE ANSWER: the scanner already discards any file whose
 * text lacks `.md#` (the `includes` guard below, unchanged and still the authority).
 * This only avoids READING files that guard would discard. `--untracked` matches
 * `git ls-files --cached --others --exclude-standard` exactly, and `-a` forces text
 * treatment so a NUL-carrying file is searched rather than skipped — the trap
 * AGENTS.md records for the wrapped `grep`, which cost four false absence findings
 * here. NO PATHSPEC is passed: a quoted glob pathspec silently matches nothing
 * (measured 2026-08-28), so the scope filter stays in TypeScript where it is
 * testable.
 *
 * FAIL-OPEN, deliberately: if git errors, every file is read, because a prefilter
 * that half-answers would produce a confident green over an unscanned tree — the
 * defect class this guard belongs to.
 */
function candidateFiles(): Set<string> | undefined {
  const listed = Bun.spawnSync(['git', 'grep', '-l', '-a', '--untracked', '-F', '.md#'], { cwd: REPO })
  // 0 = matches, 1 = no matches (still a valid answer), anything else = broken.
  if (listed.exitCode > 1) return undefined
  return new Set(listed.stdout.toString().split('\n').filter(path => path.length > 0))
}

/**
 * THE PREFILTER IS A SNAPSHOT, AND IN A SHARED TREE THAT IS A RACE — MEASURED,
 * NOT REASONED (2026-09-07, `P6.680`).
 *
 * An equivalence probe read every one of 6 051 listed files and compared "really
 * contains `.md#`" against the prefilter's answer: **534 hits, 0 spurious, and 2
 * MISSED** — `usage-limit-reset.ts` and its test. Neither is a git-grep defect:
 * both were still being written when the prefilter ran, and the commit that
 * created their citations (`3c72cf2df`) landed **at 14:42:26**, seven minutes
 * INTO a run that had taken its candidate list at 14:35. A candidate list fixed at
 * t0 can never see a citation written at t1, and the guard would then be green
 * over a citation it never read — a confident empty, which is the defect class
 * this guard belongs to.
 *
 * So the list is taken TWICE and unioned: anything that has become a candidate
 * since the scan started is scanned in a second pass. That is strictly safer than
 * the whole-file scan it replaces, which reads each file once at an arbitrary
 * moment and cannot see a write that lands after its own read either. The second
 * `git grep` costs 1.8 s against the 5–18 minutes the prefilter saves, and the
 * pass over the delta reads a handful of files.
 *
 * It does NOT make the guard atomic — nothing here can — and the honest statement
 * is the narrower one: the window shrinks from *the whole run* to *between the
 * second git grep and the delta read*.
 */
function scanFiles(files: readonly string[]): Citation[] {
  const deps: ClassifyDeps = {
    corpus: readCorpus(readFileSync(PAGES_TSV, 'utf-8')),
    fileExists: relative => relative.length > 0 && !relative.startsWith('..') && existsSync(resolve(REPO, relative)),
  }
  const candidates = candidateFiles()
  const citations: Citation[] = []
  const scanned = new Set<string>()
  const scan = (file: string): void => {
    if (scanned.has(file)) return
    scanned.add(file)
    let text: string
    try {
      text = readFileSync(resolve(REPO, file), 'utf-8')
    } catch {
      return // deleted between `git ls-files` and here, or unreadable
    }
    // Still the authority on what counts, prefilter or no prefilter.
    if (!text.includes('.md#')) return
    citations.push(...scanText(file, text, deps))
  }

  for (const file of files) {
    if (candidates !== undefined && !candidates.has(file)) continue
    scan(file)
  }
  if (candidates === undefined) return citations

  // Second pass over whatever became a candidate while the first one ran.
  const now = candidateFiles()
  if (now === undefined) return citations
  const inScope = new Set(files)
  for (const file of now) {
    if (candidates.has(file) || !inScope.has(file)) continue
    scan(file)
  }
  return citations
}

let repoScanCache: Citation[] | undefined

/**
 * The whole-repo scan, memoised for the process (P3.318).
 *
 * A `git ls-files` plus a full read of every one of the ~4 100 scanned files is
 * this guard's entire cost. The CLI pays it once. `bun test` paid it THREE
 * times — `runAudit()` twice and `collectCitations()` once — and the three
 * live-tree tests then reported 139 523 ms, 139 802 ms and 142 883 ms against
 * bun's 5 000 ms default, so all three read as timeouts in the gate while
 * asserting nothing about a timer. Sharing one scan is the fix that does not
 * cost coverage; the explicit per-test budgets in the test file are the other
 * half, set against a measured floor rather than at zero.
 *
 * Memoised only for the DEFAULT argument. An explicit file list is always
 * rescanned, because that is the fixture path and a cache there would make one
 * test's input decide another's. The cached array is copied out so a caller
 * that sorts or splices its result cannot corrupt the next reader.
 */
export function collectCitations(files?: readonly string[]): Citation[] {
  if (files !== undefined) return scanFiles(files)
  repoScanCache ??= scanFiles(repoFiles())
  return [...repoScanCache]
}

// ---------------------------------------------------------------------------
// --refresh
// ---------------------------------------------------------------------------

/**
 * Re-fetch every page cited with an anchor and rewrite the snapshot.
 *
 * REFUSES TO WRITE if any fetch fails. The rigs that landed this week all refuse
 * on a mismatch for the same reason: four candidate slugs missed P2.69's probe,
 * and a probe that half-succeeds and writes anyway produces a snapshot nobody
 * can trust — which is worse than no snapshot.
 */
export async function refresh(): Promise<number> {
  const citations = collectCitations().filter(citation => citation.bucket === 'corpus')
  const pages = [...new Set(citations.map(citation => citation.page))].sort()
  const before = readAnchorSnapshot(existsSync(ANCHORS_TSV) ? readFileSync(ANCHORS_TSV, 'utf-8') : '')
  const fetched = new Map<string, string[]>()

  for (const page of pages) {
    const response = await fetch(PAGE_URL(page))
    if (!response.ok) {
      console.error(`refresh: ${PAGE_URL(page)} → HTTP ${response.status}. Nothing written.`)
      return 1
    }
    fetched.set(page, sectionSlugs(await response.text()))
  }

  const today = new Date().toISOString().slice(0, 10)
  const rows: string[] = []
  for (const page of pages) {
    for (const slug of [...new Set(fetched.get(page))].sort()) rows.push(`${page}\t${slug}`)
  }
  writeFileSync(ANCHORS_TSV, `${header(today, pages)}\n${rows.join('\n')}\n`)

  for (const line of refreshReport(before.sections, fetched)) console.log(line)
  console.log(`refresh: ${ANCHORS_TSV} rewritten from ${pages.length} live pages on ${today}`)
  return 0
}

/**
 * What a `--refresh` changed, page by page: each fetched page's sections against
 * the snapshot it replaces, then every page the old snapshot held that this one
 * does not (F1.1223). A page leaves silently otherwise: the refresh fetches only
 * pages still cited with an anchor, so when the last anchored citer goes
 * (agent-sdk/hooks on 2026-10-01) the page's sections vanish from the snapshot
 * with nothing printed. Pure, so it is testable offline.
 */
export function refreshReport(
  before: ReadonlyMap<string, ReadonlySet<string>>,
  fetched: ReadonlyMap<string, readonly string[]>,
): string[] {
  const lines: string[] = []
  for (const [page, slugs] of [...fetched].sort(([left], [right]) => left.localeCompare(right))) {
    const now = new Set(slugs)
    const then = before.get(page) ?? new Set<string>()
    const added = [...now].filter(slug => !then.has(slug))
    const removed = [...then].filter(slug => !now.has(slug))
    if (added.length === 0 && removed.length === 0) {
      lines.push(`  ${page}.md — ${now.size} sections, unchanged`)
      continue
    }
    lines.push(`  ${page}.md — ${now.size} sections, +${added.length} −${removed.length}`)
    for (const slug of removed) lines.push(`      GONE  #${slug}`)
    for (const slug of added) lines.push(`      new   #${slug}`)
  }
  for (const [page, slugs] of [...before].sort(([left], [right]) => left.localeCompare(right))) {
    if (fetched.has(page)) continue
    lines.push(`  ${page}.md — DROPPED from the snapshot (no anchored citation left), ${slugs.size} sections`)
  }
  return lines
}

function header(today: string, pages: readonly string[]): string {
  return [
    '# Section anchors of every Claude Code doc page this repo cites with a `#anchor`.',
    '#',
    `# Snapshot: ${today}`,
    `# Pages: ${pages.length}`,
    '#',
    '# Two columns: page slug (as in claude-doc-pages.tsv), section slug (no `#`).',
    '# Generated — regenerate, never hand-edit:',
    '#',
    '#     bun scripts/check-doc-anchors.ts --refresh',
    '#',
    '# WHY IT EXISTS. A section anchor is part of a page\'s published link contract; a',
    '# line number has a measured half-life of about two days. So citations are hung on',
    '# sections, and this is what makes that checkable offline — including in CI, which',
    '# runs `bun test` and has no network.',
    '#',
    '# WHAT IT DOES NOT SAY. That a section still says what a citer claims, that a quoted',
    '# sentence exists at all, or anything whatsoever about the 8 573 line-numbered',
    '# anchors. See scripts/check-doc-anchors.ts.',
  ].join('\n')
}

// ---------------------------------------------------------------------------

/**
 * The audit, whole-tree by default.
 *
 * `globs` is `--paths`: it narrows the FILES READ and marks the audit `scoped`, so
 * the two totality findings stand down (see `auditAnchors`). Passing globs also
 * bypasses the process-wide scan cache, because a cached whole-tree result is not
 * the answer to a scoped question — and a scoped result must never become the
 * cached answer to the whole-tree one.
 */
export function runAudit(globs: readonly string[] = []): AnchorAudit {
  const scoped = globs.length > 0
  return auditAnchors(
    scoped ? collectCitations(repoFiles(globs)) : collectCitations(),
    readAnchorSnapshot(readFileSync(ANCHORS_TSV, 'utf-8')),
    PINNED_DEAD,
    KNOWN_LIVE_UNDERIVABLE,
    scoped,
  )
}

/** `--paths a b c` → `['a','b','c']`; every later flag ends the list. */
export function parsePaths(argv: readonly string[]): string[] {
  const at = argv.indexOf('--paths')
  if (at === -1) return []
  const globs: string[] = []
  for (const argument of argv.slice(at + 1)) {
    if (argument.startsWith('--')) break
    globs.push(argument)
  }
  return globs
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--refresh')) return refresh()

  const globs = parsePaths(argv)
  if (argv.includes('--paths') && globs.length === 0) {
    console.error('--paths needs at least one glob, e.g. --paths packages/shared docs. Nothing scanned.')
    return 2
  }
  const started = Date.now()
  const audit = runAudit(globs)
  for (const finding of audit.findings) console.error(`[${finding.kind}] ${finding.subject}\n    ${finding.detail}`)
  const snapshot = readAnchorSnapshot(readFileSync(ANCHORS_TSV, 'utf-8'))
  const scope = globs.length === 0
    ? 'whole tree'
    : `SCOPED to ${globs.join(' ')} — ${repoFiles(globs).length} file(s); the two totality findings `
      + '(pinned-dead-anchor-gone, known-live-anchor-uncited) stand down, because a subset cannot say '
      + 'nothing cites a thing. Re-run without --paths before calling either list clean'
  console.log(
    `doc anchors [${scope}]: ${audit.verified} corpus citations verified against ${snapshot.sections.size} pages `
    + `snapshotted ${snapshot.fetched}; ${audit.pinned} citations of ${PINNED_DEAD.length} PINNED DEAD anchors `
    + `awaiting an owner fix; ${audit.placeholders} marked placeholder(s) skipped (${PLACEHOLDER_MARKER}); `
    + `${audit.perBucket['in-repo']} in-repo and ${audit.perBucket['third-party']} `
    + 'third-party references NOT checked. This says nothing about whether any section still says what its '
    + `citer claims, and nothing at all about line-numbered anchors. ${((Date.now() - started) / 1000).toFixed(1)} s.`,
  )
  if (audit.findings.length === 0) return 0
  console.error(
    `\n${audit.findings.length} finding(s), covering `
    + `${audit.findings.reduce((sum, finding) => sum + finding.sites.length, 0)} citing site(s) — `
    + 'EVERY site of a finding is listed above; fixing one does not clear it.',
  )
  // The same findings BY CITING FILE (C3.338). The block above answers "what is
  // wrong with this anchor"; this one answers "what is left in my file", which is
  // the question a lane repairing one of three findings actually has.
  const byFile = findingsByCitingFile(audit.findings)
  console.error(`\nBy citing file — ${Object.keys(byFile).length} file(s):`)
  for (const [file, rows] of Object.entries(byFile)) {
    console.error(`  ${file}`)
    for (const row of rows) console.error(`      ${row}`)
  }
  return 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
