#!/usr/bin/env bun
/**
 * check-ledger-citations — a ledger cell can cite a repo file that no longer
 * exists, and nothing notices.
 *
 * P6.856. The capability ledger's cells carry EVIDENCE: a path, often a path
 * and a line, beside a sentence about behaviour. Two of `H12`'s admitted
 * evidence sentences were false at HEAD and one of them had been falsified by a
 * commit that had no reason to look at a ledger cell — which is the shape of the
 * whole class. A cell is written once, read months later, and the citation keeps
 * reading fluently while pointing at nothing.
 *
 * ==========================================================================
 * WHAT THIS GUARD CANNOT CATCH — read this before quoting it as assurance.
 *
 * It BEGAN with two questions, and neither is the valuable one — the arms added
 * since are described further down, and the run prints one summary line each, so
 * count them there rather than trusting a number in this paragraph. Is the file
 * this cell names still a file in this repository; and, if the citation carries a
 * `:line`, does that line still EXIST and hold anything at all. It cannot tell
 * whether the file — or the line — still SAYS what the cell says, which is the
 * half that made P6.856's own finding: a live path beside a false sentence
 * passes here, silently. It cannot see a phantom quote.
 *
 * P6.887 added the second question and it is deliberately the weakest form of a
 * line check. The first version of this header refused line numbers outright —
 * "a line number has a half-life of about two days, so a line check would ship
 * red on drift nobody caused, which is how a gate gets muted" — and that refusal
 * was right about CONTENT and wrong about EXISTENCE. A citation that drifted
 * onto some other real line still reads as evidence and passes here; one that
 * landed on a BLANK line or past EOF cannot be evidence of anything, whoever
 * caused it. So this is a SAMPLE of the drift population, not a measure of it:
 * of 1 696 line-tailed citations in the three documents, 91 were dead this way
 * over 49 distinct citations — 89 blank, 2 a range ending past EOF, 0 a start
 * past EOF (2026-09-08) — and the rest are unaudited rather than verified. The
 * same run against the WORKING TREE instead of the index returned 88, three
 * fewer, because sibling lanes held uncommitted edits that shifted three cited
 * files; the index number is the one this guard reports, and the gap is why it
 * reads the index rather than the tree it happens to be run in. The residue is
 * the mute risk the old paragraph named, one size smaller: a commit that shifts
 * a cited source file can turn someone else's anchor blank, and the gate will
 * say so. Repair it or baseline it with a reason — do not delete the check.
 * `check-doc-anchors.ts` carries the same limits paragraph for the same reason:
 * a guard whose limits are unwritten gets read as a guarantee.
 *
 * A THIRD question was MEASURED AND DELIBERATELY NOT ADDED (P6.898, 2026-09-08):
 * the prose COUNT beside a probe. Cells routinely carry their own re-runnable
 * command and its answer — a grep with a pathspec, an arrow, a number — and that
 * number decays exactly like a line anchor, with a worse failure mode: when the
 * decayed number is a NEGATIVE CONTROL, a capability that has since shipped is
 * recorded as an absence. Three were found that way in one pass (the operator's
 * append-to-all subagent prompt, the flagged-request model-switch control, and
 * `autoMemoryDirectory`), each recorded `absent` while its production reader sat
 * in the tree.
 *
 * The population is 135 such probes across the three documents, not the ~30 the
 * row estimated. 94 are runnable as written; 41 are not (a command truncated by
 * the sentence around it, a pipe, or no pattern at all). Of the 94, re-running
 * them mechanically gives 29 agreeing, 26 disagreeing and 39 answering non-zero
 * where zero was recorded — and that verdict is NOT trustworthy, which is the
 * whole reason there is no check here. Eleven of the 39 were read by hand: two
 * were real refutations, one was a dead positive control (a control answering
 * zero, which proves nothing), five were the probe counting the fork's OWN PROSE
 * — docblocks quoting the page, sometimes the very note that records the null —
 * and three were artefacts of extracting a command out of a sentence.
 *
 * Three reasons a machine check cannot do better without inventing an answer:
 * the UNIT is not in the command (a bare number may be files, lines, or the sum
 * of a `-c` run, and the sentence carries that, not the syntax); a probe cannot
 * tell a reader from a comment, so it answers a different question from the one
 * its sentence asks; and some probes depend on the SHELL rather than on git —
 * a pathspec written as the electron source root, a double-star, a slash and a
 * dot-tsx glob (not spelled here: such a glob's star-slash would CLOSE this
 * comment — the trap AGENTS.md names, and writing it out cost this very block
 * one compile) means one thing after shell expansion and another to git, which
 * reads a double-star without glob magic. Even the tightest
 * mechanically unambiguous slice — 19 probes using `-l`/`-il` with a pathspec,
 * where the number can only be a file count — mismatches on 13. A gate firing
 * 13 times where 3 are defects is the cry-wolf shape AGENTS.md warns about, so
 * this is recorded rather than built. If it is ever built, the honest form is a
 * check on probes that OPT IN by declaring their unit, not one that guesses.
 *
 * P6.906 asked for exactly that opt-in count check and made it conditional on the
 * population being non-empty. W9-bi measured it at **zero** on 2026-09-08 and
 * left the row open with the number. P6.905's own re-runs then converted probes
 * as it checked them — stating the unit in the DECLARED form (`**files=N**`)
 * rather than in prose — and the population was 62 declarations at the time the
 * check landed and **71** two commits later, in the same session. Count it, do
 * not quote it: the count arm's own summary line prints it on every run, and this
 * file has already watched the number move twice in an afternoon. **It is built:
 * see {@link collectCountProbes}, {@link checkCountProbe} and the LAST summary
 * line — named rather than numbered, because it was written as "the fourth" and
 * two arms have been added below it since.** It found four wrong declarations on its first run, two of them written
 * by the very pass that had converted them, and one of those is the lesson worth
 * carrying: a declaration is read as a claim about TODAY, so a sentence quoting a
 * HISTORICAL count must not spell it in the declared form.
 *
 * It is deliberately narrower than the population it reads. It runs only a bare
 * `git grep` with no shell metacharacter and no pipe, because `git grep` needs no
 * shell and the command in the prose is then the command that ran; everything
 * else is reported as declared-but-not-runnable and only its UNIT is checked. The
 * unit check needs no child process and is the P6.920 defect itself: `files=`
 * beside a command with no `-l` is claiming one thing and measuring another.
 * See {@link findDriftedIdentifierCitations} for the sibling opt-in, whose
 * population was large enough on the day it landed and whose design decision went
 * the other way.
 *
 * TWO POPULATIONS THIS GATE CANNOT SEE AT ALL, both measured 2026-09-09 (P6.955).
 * Neither is a bug in an arm; both are consequences of what makes a token a
 * citation here — a first segment that is a top-level directory of this repo.
 *
 * **(1) The bare line shorthand.** These documents write a second anchor into the
 * same file as a colon and a number with no path in front of it, usually inside
 * backticks. It carries no path, so nothing opts it in: its number is unchecked
 * whatever it says, and one such anchor was measured drifted about 260 lines onto
 * an unrelated block while the gate stayed green. The census, over the four
 * documents (a colon-plus-digits token whose preceding character is not a path
 * character — re-derive it, do not quote it): **3 375** of them, 875 / 836 / 151 /
 * 1 513 by document, 2 160 backticked, and **3 321 sitting on a markdown table
 * row**.
 *
 * **P6.998 ratchets the POPULATION** — {@link PINNED_SHORTHAND}, red on a rise —
 * because that is the direction a deleted path arrives from. Every sentence above
 * about the NUMBER a shorthand states still holds: nothing checks it, on any of
 * them. {@link countLineShorthands} is the rule, and its own header carries the
 * reading with its date; this paragraph's is 2026-09-09's and is kept because the
 * two disagree by six over the same bytes.
 *
 * The rule that would make them checkable is inheritance from the nearest
 * preceding path, and the census refuses it. Four windows were measured, and
 * because they are NESTED they never disagree about WHICH file — 0 disagreements
 * — only about whether there is one at all: the sentence resolves 1 555 (46.1 %),
 * the table cell 1 979 (58.6 %), the whole line 2 075 (61.5 %), the paragraph
 * 3 312 (98.1 %). Only the paragraph clears a 90 % bar and it is degenerate: a
 * markdown table is one unbroken block, so a row's "paragraph" is the whole
 * table, and for the 1 237 shorthands the line window misses it reaches back a
 * median of 2 lines (p90 9, max 62) — into a DIFFERENT ledger row, about a
 * different capability.
 *
 * And inheritance is provably wrong for a large share even inside one line,
 * because of population (2). For **1 795 of the 3 375** the nearest file-shaped
 * token before the shorthand is NOT repo-rooted, so the nearest repo path is not
 * the file the sentence is about; restricted to the 2 075 the line window
 * resolves, such a token sits BETWEEN the inherited path and the shorthand in
 * **614** of them (29.6 %). The clean slice — line window resolves, nothing
 * bare in between — is **1 461**, 43.3 % of the population, and checking it would
 * add 101 findings (67 blank, 34 past EOF) plus 4 inheriting a dead path. So the
 * honest form is not a guessing rule: it is the citation being given its path,
 * one cell at a time, which is P6.953's work.
 *
 * **(2) The bare FILENAME citation, which is the bigger of the two.** A citation
 * written with no directory segment — a basename and an extension, with or
 * without a line tail — is not a citation of this repo under the first-segment
 * rule, and the documents are full of them: **10 282** such tokens, **3 852**
 * carrying a line tail, against the 2 625 line-tailed citations this gate does
 * check. Of 2 106 distinct names, 1 167 resolve to exactly ONE tracked file
 * (6 110 occurrences), 61 are ambiguous (706), and 878 match no tracked file at
 * all (3 466) — the last group being mostly another repository's source, a
 * documentation page, or a report outside this tree, which is precisely why the
 * first-segment rule refuses to guess. Sized: of the 3 852 line-tailed ones,
 * 3 132 have a unique tracked basename, and checking those would add **146**
 * findings (139 blank, 7 past EOF) while roughly doubling the line-tailed
 * population this gate reads.
 *
 * **P6.956 BUILT the uniqueness half of (2), so this paragraph is now a
 * description of what it replaced** — see {@link collectBareNameCitations} for
 * the rule, the markdown carve-out and the measurement behind each. Re-measured
 * the day it landed: 3 233 bare line-tailed tokens, 2 551 uniquely resolving,
 * 161 ambiguous, 149 unmatched, 372 markdown; admitting the three specs added
 * **1 153** checked citations and 40 baselined findings. What remains unchecked
 * of (2) is named on the summary line, every run, rather than in this sentence:
 * the ambiguous, the unmatched, the markdown, and the whole PLAN. Admitting the
 * plan would have added **73** findings no lane may repair.
 * ==========================================================================
 *
 * ## Why it is precise enough to be a gate
 *
 * A path-shaped token in prose is not automatically a citation of THIS repo. So
 * a token is only considered when its FIRST SEGMENT is a real top-level
 * directory of this repository, derived from `git ls-files` rather than listed
 * here — which drops every `github.com/openai/codex/...` source path, every doc
 * page name (no slash), and every URL, because a URL's first segment is its
 * host. Measured on the ledger at the time this landed: 1 421 path-shaped
 * tokens, 944 of them citations of this repo over 370 distinct paths, and every
 * unresolved one outside `.claude/` was a REAL defect — five of them a file that
 * exists under a different directory, one a plan file that never carried that
 * name.
 *
 * ## The two exclusions, and why each is not a hole being hidden
 *
 *  - `.claude/` is the Claude RUNTIME's own configuration directory. The ledger
 *    names `.claude/settings.json` and its siblings as files the runtime reads
 *    on a user's machine; that this repo happens to have a `.claude/` of its own
 *    is a coincidence of naming, and checking those 17 mentions against our tree
 *    would report the runtime's contract as our defect. The cost is stated: a
 *    genuine citation of one of OUR files under `.claude/` is not checked.
 *  - A segment of `..` or `...` is an ELLIPSIS in prose, not a path segment —
 *    the ledger elides long paths that way. Such a token is not a citation and
 *    is not reported as a dead one.
 *
 * ## Resolution is against the INDEX, not the filesystem
 *
 * `git ls-files`, never `existsSync`. Six lanes write this tree at once, and an
 * untracked file in a neighbour's working copy would make a dead citation look
 * live for exactly as long as that lane runs.
 *
 * The line check reads the same way and for the same reason — `git cat-file
 * --batch` against the index (`:<path>`), never `readFileSync` — so a
 * neighbour's half-written file cannot blank an anchor that is fine at the
 * index. It is also the only form that fits the budget: measured 2026-09-08 on
 * this box, `readFileSync` costs ~33 ms per FIRST open of a distinct file (and
 * 288 ms each under load 11), so 342 cited files ran 11–60 s, while one
 * `cat-file --batch` child streamed all 342 blobs — 26.8 MB — in 426 ms. The
 * cost is per-OPEN, not per-byte: reading fewer lines of each file would not
 * have helped, and the whole gate stays near a second.
 *
 * ### TWO reads, and the rule that generalises — P6.936, measured 2026-09-09
 *
 * This gate has two kinds of read and they deliberately disagree about which
 * tree they see. The ARTIFACT — the three documents it is checking — comes from
 * the working tree with `readFileSync`, because that is the change in front of
 * you and a gate that cannot see it is useless. The SUBJECT — the files those
 * documents make claims ABOUT — comes from the index, because a neighbour's
 * mid-edit is not your finding. P6.933 measured that half live: a declared 39
 * answered 41 and then 42 within two minutes, all three extra files another
 * lane's uncommitted work.
 *
 * P6.936 proposed sweeping that index default across every tree-scanning census
 * script, and the sweep REFUTED it. Sixteen scripts under `scripts/` enumerate
 * the tree with `git ls-files` or `git grep`, and all but one then open the file
 * itself (`check-settings-line-citations.ts` counts inside `git grep` and never
 * opens anything); **this is the only one with two kinds of read.** In the other
 * fifteen the artifact and the
 * subject are the same file — `check-comment-globs.ts` reports the comment it is
 * reading, `check-nul-bytes.ts` the byte, `check-conditional-expect.ts` the
 * assertion — so an index default would blind each of them to the defect the
 * runner just wrote, which is the defect they exist to catch. Two apparent
 * counter-examples are not: `check-doc-anchors.ts`'s `--cached` is an `ls-files`
 * LISTING flag (tracked plus untracked), not an index read, and
 * `check-settings-line-citations.ts` keeps the working tree deliberately because
 * its pin is lowered in the same commit that converts the citations it counts.
 *
 * So the rule is not "gates read the index". It is: **read the artifact from the
 * working tree and the subject of its claims from the index** — and it only
 * applies where those are different files.
 *
 * ## The baseline exists so the gate can land green
 *
 * The findings already in the tree are recorded in
 * `scripts/ledger-citation-baseline.txt` with a reason each, and the gate is red
 * only on a NEW one. Fixing the recorded ones is a plan row, not this guard's
 * job — a sweep folded into the guard that catches sweeps is how a baseline
 * becomes a backlog nobody can read.
 *
 * One file, several key forms, which is why an entry is matched literally rather
 * than parsed: a dead PATH is keyed by the path, a dead LINE by the whole
 * citation as written (`path:line`, `path:line-line`), and every opt-in arm by
 * the citation plus a `::`-separated suffix naming its own subject. Read
 * {@link PlanCensusInput} for the live list — this sentence said "two key forms"
 * while there were five, which is the drift it now declines to repeat. None of
 * them can collide: a path never contains a `:line` tail and a citation never
 * contains `::`, so a baselined path does not silence that file's line anchors,
 * and repairing one anchor removes exactly one line from this file.
 *
 * `--update-baseline` PRESERVES the file: every comment line and every inline
 * reason survives, entries that are no longer findings are dropped with their
 * reason, and new ones are appended under a dated heading. It used to rewrite
 * the file from the finding list alone, which silently discarded every reason
 * in it — the register's whole value — the first time anyone ran the usage line
 * below (fixed with P6.887, in zone).
 *
 * Usage:
 *   bun scripts/check-ledger-citations.ts                    # report
 *   bun scripts/check-ledger-citations.ts --check            # exit 1 on a NEW dead path OR dead line
 *   bun scripts/check-ledger-citations.ts --update-baseline  # preserves comments and reasons
 *   bun scripts/check-ledger-citations.ts --pin              # rewrite the four pins from the census (P6.999)
 *   bun scripts/check-ledger-citations.ts --pin --allow-raise  # ONLY from the commit admitting a document
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The tracker, named once so {@link LEDGERS} and {@link planFindingCensus} cannot
 * drift apart: the ratchet's whole subject is "findings in THIS document", and a
 * second spelling of the path would make the census silently measure nothing the
 * day either copy is renamed.
 */
export const PLAN_DOC = 'docs/superpowers/plans/2026-08-22-runtime-parity-closure.md'

/**
 * The documents whose repo-file citations are checked.
 *
 * P6.861 took this from one to three, and the reason is that the one-element
 * list made the guard look complete while missing the same defect five more
 * times. The ledger's G14 cell cited a plan that never existed; the identical
 * clause sat word-for-word in the denominator-gaps spec, which is the ledger's
 * own SOURCE document, and the codex coverage map carried the same dead pointer
 * FOUR times — one of them a QUOTE attributed to it. A guard over the derived
 * document only cannot see the document it was derived from.
 *
 * The rule for adding one: a document whose cells carry repo-file paths as
 * EVIDENCE, where a reader is expected to open the path. A document that merely
 * mentions files in passing would fill the baseline with noise, which is how a
 * gate stops being read.
 *
 * **The baseline is keyed by PATH, not by (document, path), and with four
 * documents that is a real limit rather than a theoretical one:** a path
 * baselined because one document's cell deliberately cites a file that does not
 * exist is silenced in ALL of them. It is left that way deliberately — the
 * alternative is a second key in a file whose whole value is that a human can
 * read it — and the cost is written here instead of hidden. The count moved when
 * the plan joined: THREE paths are now cited by more than one document
 * (`config/managed-policy.ts`, the packaged Pi bundle and the electron main
 * bundle), all three already baselined for the same reason in each, and
 * seventeen more the plan alone cites are now silenced in the three specs
 * prospectively.
 *
 * ## P6.948 — the PLAN, and why its membership is different in kind
 *
 * The plan is admitted on the same rule as the other three: its rows carry
 * repo-file paths as evidence and a reader is expected to open them. Everything
 * else about it is different, and a reader must know which before quoting a
 * green run.
 *
 * **A lane cannot repair a plan finding.** The plan is the controller's file and
 * is read-only for every lane, so a plan citation that goes dead has no owner in
 * the wave that broke it — where a spec citation is repairable by whichever
 * ledger lane meets it. This gate is a step of `lint:chain`, so such a finding
 * blocks the chain for everyone until the controller repairs it or baselines it
 * with a reason. That is the cost of admitting the file, it is paid knowingly,
 * and the alternative — the most-edited document in the tree citing 1 619 repo
 * paths with nothing reading any of them — is the hole this closes.
 *
 * **What it lit up, measured 2026-09-09 (a reading with a date; run `--check`,
 * do not quote this):** 1 619 repo-file citations, of which 34 findings over 20
 * distinct dead paths, 41 dead lines (40 blank, one range ending past EOF), 63
 * drifted identifiers over 62 distinct, and 0 count declarations. None was
 * repairable by the lane that admitted the file, so all of them are recorded in
 * the baseline, grouped by kind and by cause. The three ratios stayed far from
 * every refusal threshold, which is the evidence that the extractor reads this
 * document as well as it reads the other three.
 *
 * **One precision limit the plan makes visible and the other three did not:** a
 * doc path of ANOTHER repository, written without its host prefix, is
 * indistinguishable from ours when its first segment happens to be one of our
 * top-level directories. The plan cites codex's own `docs/skills.md` and
 * `docs/slash_commands.md` at a codex tag; the first-segment rule this file
 * leans on drops `github.com/openai/codex/...` and cannot drop these. They are
 * baselined by name with that reason rather than guessed at from the sentence.
 */
export const LEDGERS: readonly string[] = [
  'docs/superpowers/specs/2026-08-28-capability-ledger.md',
  'docs/superpowers/specs/2026-09-05-denominator-gaps.md',
  'docs/superpowers/specs/2026-08-22-codex-coverage-map.md',
  'docs/superpowers/specs/2026-09-05-denominator-owner-questions.md',
  PLAN_DOC,
]

/**
 * ## P6.989 — the owner-questions spec, admitted 2026-09-10 with an EMPTY baseline
 *
 * It qualifies on the same rule as the other three: its rows carry repo-file
 * paths as evidence and a reader is expected to open them. It was the UNGATED
 * TWIN — the document that stitches the owner sitting's slices — and the cost of
 * that is measured rather than argued: its two copies of the F31 `--bg` sentence
 * (the file carries the stitched view and the 19 raw slices, so almost every
 * sentence exists twice) said `--bg` scored ONE file while its two gated twins
 * had already been corrected to five. Nothing read it, so nothing said so.
 *
 * **What admitting it cost, measured before and after (2026-09-10):** 294
 * full-path citations and 127 bare-name ones yielded 4 dead paths over 2
 * distinct, 9 dead lines over 5, and 17 drifted identifiers over 9 — 16 distinct
 * baseline keys. All 16 were REPAIRED instead, because this document is the
 * ledger lane's zone and a finding here has an owner: the two dead paths were a
 * wrong directory (`config/` for `agent/claude-managed-settings.ts`) and a file
 * that lives in `shared/src/workflows/`, not in the pi-agent-server orchestrator;
 * the five blank anchors and the nine drifted identifiers took the symbol form.
 * **So the admission adds ZERO baseline entries** — the number to re-derive on
 * the next run is the pins below, not this paragraph.
 *
 * One reading worth keeping: of the 19 identifier subjects it carried, 17 were
 * drifted (89 %), against 33 % over the four documents already gated. An ungated
 * corpus decays at the rate its citations were never checked at.
 */
export const BASELINE_FILE = 'scripts/ledger-citation-baseline.txt'

/** See the header: the runtime's own config directory, not ours. */
export const EXCLUDED_ROOTS: readonly string[] = ['.claude']

/**
 * A path-shaped token: two or more segments and an extension, with an optional
 * `:line` or `:line-line` tail. The precision comes from the caller's top-level
 * filter, not from this pattern.
 */
const CITATION = /[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/g

/** Characters that mean the match started mid-token (a URL, a longer path). */
const CONTINUES_A_TOKEN = /[A-Za-z0-9_./-]/

export interface Citation {
  /** The document the citation was read from. */
  readonly doc: string
  /** 1-based line in that document. */
  readonly line: number
  /** The citation exactly as written, `:line` tail included. */
  readonly text: string
  /** The path half, with any `:line` tail removed. */
  readonly path: string
  /**
   * The rest of the document line after the citation — the "sentence" the
   * identifier opt-in reads. Kept as raw text rather than parsed here so the
   * opt-in rule lives in one place ({@link attachedIdentifier}).
   */
  readonly after: string
  /**
   * The document line BEFORE the citation, same rule and same reason: the
   * row-id opt-in ({@link attachedRowId}) reads this side, because that is the
   * side the documents write a row id on — *the `K5` row of `path`*.
   */
  readonly before: string
  /**
   * P6.956 — for a citation written as a BARE FILENAME, the token as the cell
   * spells it; {@link text} and {@link path} carry the resolved file. Absent on
   * every citation that named its own path.
   */
  readonly written?: string
}

/**
 * P6.1061 — a citation pair WRAPPED across a line break is still a pair, and
 * until this existed it was not a citation at all.
 *
 * ## The defect
 *
 * Every opt-in rule here ({@link attachedIdentifier}, {@link attachedRowId},
 * {@link attachedSymbol}) reads the text beside the citation, and that text used
 * to be ONE DOCUMENT LINE. So a cell that wrapped — the path ending a line and
 * `` symbol `Name` `` opening the next, or the reverse — opted into nothing, and
 * the gate reported a SMALLER NUMBER rather than a finding. Measured by W11-w
 * (2026-09-11) on its own four pairs: the symbol census stayed at 1 849 and rose
 * to 1 853 the moment the four were re-wrapped onto single lines. Nothing went
 * red, which is the whole hazard: the failure is a census that quietly stops
 * counting, and AGENTS.md §Traps records the same shape one layer up for a
 * grepped CLAIM that a line break hid from its own sweep.
 *
 * ## The rule, and why it is ONE break and not a paragraph
 *
 * The context spans exactly one line break, and only into a NON-BLANK neighbour.
 * `\s` matches a newline, so widening without that condition would let a citation
 * at the end of a paragraph pair with a backticked identifier opening the NEXT
 * paragraph — an attachment no author wrote. A blank line is where prose stops
 * wrapping, so it is where this stops looking.
 *
 * Markdown tables need no special case and get none: a row begins with `|`,
 * which is not whitespace, so neither {@link ATTACHED_IDENTIFIER}'s `^[\s(,:;…-]*`
 * nor {@link PRECEDING_SYMBOL}'s `\s*$` can reach across a row boundary. That is
 * measured rather than assumed — see this function's cases in
 * `scripts/__tests__/check-ledger-citations.test.ts`.
 *
 * ## D1.120 — and the paragraph window is REFUTED, not merely declined
 *
 * The paragraph above is an a-priori reason, and a reader meeting it will
 * reasonably ask why the window is not simply widened to the paragraph, since
 * that is where prose demonstrably stops. It was measured, on the same corpus,
 * before this function existed: P6.955's inheritance census over the 3 375 bare
 * `:line` shorthands ({@link countLineShorthands} carries the reading and its
 * date) priced FOUR nested windows by how many of them a preceding path could be
 * found for — the sentence 1 555 (46.1 %), the table cell 1 979 (58.6 %), the
 * whole line 2 075 (61.5 %), the paragraph 3 312 (98.1 %).
 *
 * Only the paragraph clears a 90 % bar, **and its 98 % is the artefact rather
 * than the result.** A markdown table is one unbroken block, so a row's
 * "paragraph" is the WHOLE TABLE — and for the 1 237 shorthands the line window
 * misses, the paragraph window reaches back a median of 2 lines, p90 9, max 62,
 * into a DIFFERENT ledger row about a different capability. A window that
 * attaches one row's citation to another row's identifier does not find more
 * pairs; it manufactures them, and every one it manufactures becomes a finding
 * against a cell whose author wrote nothing of the kind.
 *
 * So the choice here is not "one break is cautious". It is: in these documents
 * the paragraph is not a unit of meaning at all, and the ONE unit that is — the
 * table row, which a blank line and a leading `|` both delimit — is exactly what
 * stopping at one non-blank neighbour buys. The census's own conclusion is the
 * same one, one layer down: the honest form is a citation being GIVEN its path,
 * not a rule that guesses which path was meant.
 */
export function wrappedContext(
  lines: readonly string[],
  index: number,
  prefix: string,
  suffix: string,
): { before: string; after: string } {
  const previous = index > 0 ? lines[index - 1] ?? '' : ''
  const next = lines[index + 1] ?? ''
  return {
    before: previous.trim() === '' ? prefix : `${previous}\n${prefix}`,
    after: next.trim() === '' ? suffix : `${suffix}\n${next}`,
  }
}

export function collectCitations(doc: string, text: string, roots: ReadonlySet<string>): Citation[] {
  const out: Citation[] = []
  const lines = text.split('\n')
  for (const raw of lines.map((value, index) => ({ value, line: index + 1 }))) {
    CITATION.lastIndex = 0
    for (let match = CITATION.exec(raw.value); match !== null; match = CITATION.exec(raw.value)) {
      const before = match.index > 0 ? raw.value[match.index - 1] : undefined
      if (before !== undefined && CONTINUES_A_TOKEN.test(before)) continue
      const token = match[0]
      const path = token.split(':')[0] ?? token
      const segments = path.split('/')
      const root = segments[0] ?? ''
      if (!roots.has(root)) continue
      if (EXCLUDED_ROOTS.includes(root)) continue
      if (segments.some(segment => segment === '..' || segment === '...')) continue
      out.push({
        doc,
        line: raw.line,
        text: token,
        path,
        // P6.1061 — one line break each way; see {@link wrappedContext}.
        ...wrappedContext(
          lines,
          raw.line - 1,
          raw.value.slice(0, match.index),
          raw.value.slice(match.index + token.length),
        ),
      })
    }
  }
  return out
}


/**
 * D1.159 — THE PATHS THIS GATE DROPS THAT ARE REAL FILES ON THIS DISK.
 *
 * {@link collectCitations} keeps a token only when its FIRST SEGMENT is a
 * tracked top-level directory, and the header calls that the precision rule: it
 * is what drops `github.com/openai/codex/...`, every doc page name and every
 * URL. It also drops, silently and with nothing counting them, every citation of
 * a file that IS on this disk and is not in the index — and those are not prose,
 * they are evidence a reader is expected to open.
 *
 * ## Measured 2026-09-17 over the five documents
 *
 * **110 occurrences over 15 distinct paths, 32 of them carrying a `:line` tail.**
 * The dominant family is the vendored Claude bundle — `sdk.d.ts` 40,
 * `package.json` 17, `sdk.mjs` 14, `bridge.mjs` 10, `sdk-tools.d.ts` 8 — then the
 * vendored Pi packages (15 across five files), `pdfjs-dist` (3) and two citations
 * of a runtime config directory.
 *
 * Two spelling facts are why nothing saw them, and both refine the row that asked
 * for this rather than confirming it:
 *
 *  - **A SCOPED package loses its `@` to the token rule.** {@link CITATION}'s
 *    character class has no `@`, so `@anthropic-ai/claude-agent-sdk/sdk.d.ts`
 *    matches from `anthropic-ai` — a first segment that is not a tracked root and
 *    never will be. The cells write the scoped spelling far more often than the
 *    `node_modules/`-prefixed one, so this is the whole population, not an edge.
 *  - **The shipped BINARY is not path-shaped at all.** The vendored
 *    `claude-agent-sdk-darwin-arm64/claude` has no extension, so
 *    {@link CITATION} never matches it. Every AGENTS.md probe of that binary is
 *    invisible to this gate by construction, and no census here can change that.
 *
 * ## The decision: REPORT, never VERIFY — and the reason is the gate's own verdict
 *
 * The row offered both. Reading them was declined, on three measurements:
 *
 *  1. **A build artefact's presence is machine-dependent.** Three of the paths
 *     the sibling population carries — `apps/electron/dist/main.cjs`, the
 *     packaged Pi bundle and `packages/pi-agent-server/dist/index.js` — exist
 *     here because a build ran, and do not exist on a fresh CI checkout. A gate
 *     that read them would return a different verdict on CI than on a
 *     developer's box, which is the worst property a gate can have.
 *  2. **`node_modules/` is absent before `bun install`**, and on this rig a
 *     trusted postinstall is not even run by `--frozen-lockfile` (AGENTS.md
 *     §Traps, the vendored ripgrep). Same non-determinism, one layer down.
 *  3. **The bundle moves under a lift nobody in the wave caused.** This very plan
 *     lifted the SDK 0.3.247 → 0.3.251; a line anchor into `sdk.d.ts` would have
 *     gone red for forty citations on that commit, and a gate that reddens on
 *     other people's upgrades is a gate that gets muted.
 *
 * So the population is NAMED on its own summary line and never counted as
 * verified — the whole of what the row asked for, in the words it asked for. It
 * is deliberately NOT ratcheted: a new cell citing the SDK is ordinary evidence,
 * not debt, and a pin here would fire on the documents doing their job.
 *
 * **The sibling that made the OTHER choice, named so this paragraph cannot be
 * read as "the bundle is unreadable":** `scripts/check-minified-citations.ts`
 * DOES open the vendored bundle from disk, and refuses loudly (printing the
 * reason, exiting 0) when it is absent. That is consistent rather than
 * contradictory, and the difference is the corpus: it checks SOURCE COMMENTS,
 * where a minified symbol name is worthless the moment it rots and a refusal on
 * a bundle-less checkout costs nothing. Here the subject is a ledger CELL whose
 * verdict a coverage table is derived from, and a gate that answered one way on
 * CI and another on a developer's box would move that table. If reading these
 * citations is ever wanted, that script — not this one — is where it belongs,
 * with the instrument named beside the count (`grep -ao … | wc -l` on a minified
 * file, never `grep -ac`, AGENTS.md §Traps).
 *
 * The three artefacts in the SIBLING population (a tracked root, an untracked
 * file) are already visible — they resolve to dead-path findings and sit in the
 * baseline with `MISFIRE` and the reason. What was invisible is only this half.
 */
export interface UnreachableCitations {
  /** Every dropped token that names a real file on this disk. */
  readonly occurrences: number
  /** Of those, the ones carrying a `:line` tail — the ones that look strongest. */
  readonly withLineTail: number
  /** The distinct on-disk paths, sorted, as this census resolved them. */
  readonly paths: readonly string[]
}

/**
 * The three spellings tried for a dropped token, in order.
 *
 * The bare path first (a runtime config directory, a build output); then the
 * scoped and unscoped `node_modules/` forms, which is where the `@` the token
 * rule ate is put back. Nothing else is guessed: a token that resolves under
 * none of the three is prose, another repository, or a doc page, and this census
 * says nothing about it.
 */
export function onDiskSpellings(path: string): string[] {
  return [path, `node_modules/@${path}`, `node_modules/${path}`]
}

/** See {@link UnreachableCitations} for the measurement and the decision. */
export function unreachableCitations(text: string, roots: ReadonlySet<string>): UnreachableCitations {
  const paths = new Set<string>()
  let occurrences = 0
  let withLineTail = 0
  for (const line of text.split('\n')) {
    CITATION.lastIndex = 0
    for (let match = CITATION.exec(line); match !== null; match = CITATION.exec(line)) {
      const previous = match.index > 0 ? line[match.index - 1] : undefined
      if (previous !== undefined && CONTINUES_A_TOKEN.test(previous)) continue
      const token = match[0]
      const path = token.split(':')[0] ?? token
      const segments = path.split('/')
      const root = segments[0] ?? ''
      // Only the tokens collectCitations DROPS, and never the ellipsis form.
      if (roots.has(root)) continue
      if (segments.some(segment => segment === '..' || segment === '...')) continue
      const found = onDiskSpellings(path).find(candidate => existsSync(join(REPO_ROOT, candidate)))
      if (found === undefined) continue
      paths.add(found)
      occurrences += 1
      if (LINE_TAIL.test(token)) withLineTail += 1
    }
  }
  return { occurrences, withLineTail, paths: [...paths].sort() }
}

export interface Finding {
  readonly citation: Citation
  /** Tracked files with the same basename — the relocation, when there is one. */
  readonly elsewhere: readonly string[]
}

export function findDeadCitations(
  citations: readonly Citation[],
  tracked: ReadonlySet<string>,
): Finding[] {
  const byBasename = new Map<string, string[]>()
  for (const file of tracked) {
    const name = basename(file)
    const bucket = byBasename.get(name)
    if (bucket) bucket.push(file)
    else byBasename.set(name, [file])
  }
  return citations
    .filter(citation => !tracked.has(citation.path))
    .map(citation => ({
      citation,
      elsewhere: (byBasename.get(basename(citation.path)) ?? []).slice(0, 3),
    }))
}

/**
 * P6.956 — THE BARE FILENAME, opted in BY UNIQUENESS.
 *
 * ## The hole, measured before it was closed
 *
 * {@link CITATION} requires two segments, so `storage.ts:602` — a filename with
 * no directory — is not a citation of this repo at all, and the guard reads
 * nothing about it. P6.955's census (2026-09-09) sized that blindness: **10 282**
 * directory-less file tokens across the four documents, **3 852** of them
 * carrying a line tail, against the 2 629 line-tailed citations the gate checked
 * — **the unchecked population was larger than the checked one.**
 *
 * ## The rule, and why it is uniqueness rather than a guess
 *
 * A bare name is admitted only when `git ls-files` holds EXACTLY ONE file with
 * that basename. Then the file it names is not a guess, and the citation enters
 * the same line and identifier checks a full path does. Everything else is
 * REPORTED AS UNCHECKED rather than resolved:
 *
 *  - **ambiguous** (`index.ts`, `storage.ts`, `types.ts`, `event-adapter.ts`, …):
 *    two or more tracked files share the name, and picking one would attach a
 *    plausible wrong file to a true sentence. Counted in the summary line, and
 *    since P6.969 NAMED there too — with every citing `document:line` and the
 *    tracked candidates under `--verbose`, because the count alone cannot tell a
 *    converting lane which of its own cells stopped being checked.
 *  - **unmatched**: no tracked file of that name. Mostly another repository's
 *    source or a documentation page written without its host prefix, which is
 *    exactly why the first-segment rule refuses to guess. Left alone.
 *
 * ## MARKDOWN is excluded, and the reason is a measurement, not caution
 *
 * These documents cite the Claude and codex documentation by bare page name with
 * a line number, in the same sentence shape as a source citation. Hand-read
 * 2026-09-09: `skills.md:122`, `:490`, `:638` and `:667` are all the **vendor
 * page** — `skills` and `agent-sdk/skills` are both in `scripts/claude-doc-pages.tsv`
 * — while this tree also tracks exactly one `apps/electron/resources/docs/skills.md`.
 * Admitting them would have checked a vendor page's line numbers against an
 * unrelated file of ours and reported the mismatch with total confidence. The
 * 372 markdown tokens are therefore skipped and counted, and our own `.md`
 * anchors keep the instruments built for them: `check-doc-anchors.ts`, and the
 * row-id arm above.
 *
 * ## Admitted only where a finding has an OWNER
 *
 * The three specs are the ledger lane's zone: a finding in them is repaired by
 * whoever meets it. The PLAN is the controller's file, read-only for every lane,
 * so a new citation POPULATION there is a permanent red rather than a repair
 * queue — {@link PINNED_PLAN_FINDINGS}'s header records what the last admission
 * cost. Measured today, admitting the plan would add **73** findings to its
 * census of 119 against a pin of 118. So the plan is not admitted here, its
 * number is written down instead, and turning it on is one controller commit:
 * this predicate, the baseline entries, and the pin, together.
 *
 * ## What it does not promise
 *
 * A unique basename is not proof the sentence meant OUR file — a bare
 * `retry.ts:88` could still be another repository's, and it would resolve here
 * if we happened to track exactly one `retry.ts`. The check is the same
 * containment-grade evidence the rest of this gate offers: the line exists and
 * is not blank, and any identifier attached to it is near it.
 */
const BARE_NAME = /[A-Za-z0-9_.\-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/g

/**
 * P6.953 — the intersection of the two forms above, which was a HOLE.
 *
 * P6.956 admits a bare filename **that carries a line tail**; P6.957 admits a
 * tail-less citation **whose sentence names a symbol**. A converting lane writes
 * their intersection — *`SessionManager.ts` symbol `budgetExhausted`* — and until
 * this branch existed that sentence was collected by NEITHER: the bare pass
 * required the tail, so dropping the tail dropped the citation out of the gate
 * altogether. Measured 2026-09-09 over the three specs: **1 082 of the 2 486
 * identifier-less line-tailed citations are bare-name**, so converting the
 * majority of P6.953's remaining population would have SILENTLY REDUCED what the
 * gate reads, one honest-looking cell at a time.
 *
 * The widening is opt-in by the same connective word and for the same reason it
 * was chosen in {@link attachedSymbol}: a tail-less bare name that does NOT claim
 * a symbol is never even counted here — not as unmatched, not as ambiguous —
 * because with the tail optional the pattern also matches every version number,
 * `config.toml` and `node.js` in the prose, and a census fed by those would say
 * nothing. The word is what makes the population start at the cells a lane has
 * deliberately converted.
 *
 * ## P6.947's remainder, re-censused 2026-09-10 once the ten-path sweep closed
 *
 * The shape CHANGED, which is why the census is worth taking again rather than
 * carrying a number forward. The per-path instrument ranks the FULL-PATH arm
 * only, and over the three specs that arm now holds 1 478 line-tailed citations
 * with **1 264 still unattached over 331 paths** — but its head is spent: the
 * top ten paths hold only **186 of the 1 264 (15 %)**, leaving 1 078 spread over
 * 321 paths at about three each, where a per-path sitting buys almost nothing.
 *
 * The head went to the BARE-NAME arm, which no ranking had ever read. It holds
 * 1 125 line-tailed citations, **1 070 of them unattached (95.1 %)** over 183
 * paths, and its top ten hold **459 (43 %)** — in the SAME files the ten-path
 * sweep recorded as finished: `codex-agent.ts` 105, `claude-agent.ts` 84,
 * `config-writer.ts` 53, `SessionManager.ts` 49, `pi-agent.ts` 45. So *"path N is
 * done"* has only ever meant done for the arm the ranking was taken with, and
 * each of those files still carries 45–105 anchors written as a bare name with a
 * line number. Every count in this paragraph is a reading with a date: re-run the
 * ranking, never quote one of these.
 *
 * ## And re-censused again 2026-09-10 (P6.967, W9-cd) — BOTH heads are now spent
 *
 * Fourteen paths were converted in one sitting (**520 citations**, the five the
 * paragraph above names plus `base-agent.ts`, `tool-defs.ts`, `mcp-pool.ts`,
 * `claude-managed-settings.ts`, `core/pre-tool-use.ts`, `managed-composition.ts`,
 * `slash-commands/help.ts`, `agent/options.ts`, `pi-harness/permission-dsl.ts`),
 * and the bare-name arm's shape changed the same way the full-path arm's did:
 * unattached **1 070 → 550** over 169 paths, its head **105 → 12**, and its
 * top-ten share **43 % → 18 %**. The full-path arm reads 1 240 unattached over
 * 331 paths with a top-ten share of 14 %.
 *
 * So the per-path instrument is spent on BOTH arms, and that is the finding: the
 * remaining 1 790 sit at about two per path (152 paths carry exactly two on the
 * full-path arm, 86 on the bare-name arm), where a sitting pays the same
 * per-cell reading cost for a tenth of the yield. Continuing is a decision about
 * a different instrument, not a queue to work down. Re-run the ranking; never
 * quote a number from this paragraph either.
 */
/** The tail {@link BARE_NAME} now makes optional — see the block above. */
const BARE_NAME_TAIL = /:\d+(?:-\d+)?$/

/** A basename with more than one tracked file: admitted by nobody, counted by name. */
export type BasenameIndex = ReadonlyMap<string, string | null>

/** `null` marks an ambiguous name, so the two cases stay distinguishable. */
export function buildBasenameIndex(tracked: Iterable<string>): BasenameIndex {
  const index = new Map<string, string | null>()
  for (const file of tracked) {
    const name = basename(file)
    // P6.996 — a ROOT-LEVEL file's bare name IS its full tracked path: `package.json`
    // cannot be written any wider, while each of its 17 siblings can (and must) carry
    // its directory to be a citation of itself at all. So the root file wins the
    // bucket instead of turning it ambiguous — measured on the plan, where the only
    // two `package.json` citations both said "root" in their own words.
    if (file === name) {
      index.set(name, file)
      continue
    }
    if (index.has(name)) {
      if (index.get(name) !== name) index.set(name, null)
    } else index.set(name, file)
  }
  return index
}

/** One citation left unchecked because its basename is ambiguous (P6.969). */
export interface AmbiguousBareName {
  readonly name: string
  readonly doc: string
  readonly line: number
}

export interface BareNameCensus {
  readonly citations: Citation[]
  /** Two or more tracked files carry the name — unchecked, and said so. */
  readonly ambiguous: number
  /**
   * P6.969 — the same population as {@link BareNameCensus.ambiguous}, by NAME
   * and by citing line. The count alone told a converting lane that something
   * had gone unchecked and nothing about WHICH cell: W9-bz wrote a second
   * mention as `event-adapter.ts` (three tracked files), watched the number go
   * 68 → 70, and had to bisect its own commit to find the two citations. The
   * index already holds the answer — a `null` value IS the ambiguity — so this
   * is the count kept instead of thrown away.
   */
  readonly ambiguousSites: readonly AmbiguousBareName[]
  /** No tracked file carries it — another repo's, or a page. Left alone. */
  readonly unmatched: number
  /** A markdown page name, skipped for the reason in the header. */
  readonly markdown: number
}

/**
 * The tracked files behind each of `names` — the candidates a lane has to choose
 * between when it writes the full path. One pass over the tracked set, filtered
 * to the names actually cited, so the run pays for the ambiguity it met and not
 * for every duplicated basename in the tree (there are hundreds).
 */
export function candidatesForBasenames(
  tracked: Iterable<string>,
  names: Iterable<string>,
): ReadonlyMap<string, readonly string[]> {
  const wanted = new Set(names)
  const found = new Map<string, string[]>()
  for (const name of wanted) found.set(name, [])
  for (const file of tracked) {
    const bucket = found.get(basename(file))
    if (bucket !== undefined) bucket.push(file)
  }
  for (const bucket of found.values()) bucket.sort()
  return found
}

/**
 * The bare-name pass. Separate from {@link collectCitations} on purpose: it
 * needs the tracked index, it reports a census the other one has no member for,
 * and keeping them apart means this widening cannot change what the four older
 * arms see.
 */
export function collectBareNameCitations(
  doc: string,
  text: string,
  index: BasenameIndex,
): BareNameCensus {
  const citations: Citation[] = []
  const ambiguousSites: AmbiguousBareName[] = []
  let unmatched = 0
  let markdown = 0
  const lines = text.split('\n')
  for (const raw of lines.map((value, line) => ({ value, line: line + 1 }))) {
    BARE_NAME.lastIndex = 0
    for (let match = BARE_NAME.exec(raw.value); match !== null; match = BARE_NAME.exec(raw.value)) {
      const before = match.index > 0 ? raw.value[match.index - 1] : undefined
      // The same guard the path form uses, and here it is what keeps the tail of
      // a full path — or of a URL — from being read as a bare name of its own.
      if (before !== undefined && CONTINUES_A_TOKEN.test(before)) continue
      const token = match[0]
      const tailed = BARE_NAME_TAIL.test(token)
      const cut = tailed ? token.lastIndexOf(':') : token.length
      const name = token.slice(0, cut)
      // P6.1061 — one line break each way, the same context the path form gets.
      // This pass needs it TWICE: the symbol sentence is also this arm's
      // ADMISSION rule, so a wrapped pair did not merely lose its opt-in here —
      // the citation was never collected at all.
      const { before: wrappedBefore, after } = wrappedContext(
        lines,
        raw.line - 1,
        raw.value.slice(0, match.index),
        raw.value.slice(match.index + token.length),
      )
      // See the block above: without a tail this pass admits only the
      // sentence that names a symbol, and counts nothing otherwise.
      if (!tailed && attachedSymbol(wrappedBefore, after) === undefined) continue
      if (name.endsWith('.md')) {
        markdown += 1
        continue
      }
      const resolved = index.get(name)
      if (resolved === undefined) {
        unmatched += 1
        continue
      }
      if (resolved === null) {
        ambiguousSites.push({ name, doc, line: raw.line })
        continue
      }
      if (EXCLUDED_ROOTS.includes(resolved.split('/')[0] as string)) continue
      citations.push({
        doc,
        line: raw.line,
        // The RESOLVED citation, so a baseline key names the file rather than a
        // basename two documents could spell the same way; `written` keeps what
        // the cell actually says, for the message.
        text: `${resolved}${token.slice(cut)}`,
        path: resolved,
        after,
        before: wrappedBefore,
        written: token,
      })
    }
  }
  // The count STAYS a member and stays derived from the sites, so the summary
  // line and the named list can never disagree about how many there were.
  return { citations, ambiguous: ambiguousSites.length, ambiguousSites, unmatched, markdown }
}

/**
 * Every document, the plan included (P6.964, 2026-09-10). The plan was excluded
 * while its findings had no repairer; since P6.954 the controller repairs them
 * at pin time and {@link PINNED_PLAN_FINDINGS} ratchets the count, so a bare
 * name in the plan is now checked like one in a ledger.
 */
export function admitsBareNames(_doc: string): boolean {
  return true
}

/** The `:12` or `:12-20` tail of a citation, if it carries one. */
const LINE_TAIL = /:(\d+)(?:-(\d+))?$/

export type DeadLineReason = 'blank' | 'past-eof' | 'range-end-past-eof'

export interface LineFinding {
  readonly citation: Citation
  readonly reason: DeadLineReason
  /** Lines in the cited file as this guard counted them (a final newline is not a line). */
  readonly lineCount: number
}

export function countLines(content: string): number {
  const lines = content.split('\n')
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/**
 * A citation whose line cannot be evidence: it is past the end of the file, it
 * is blank, or its range ends past the end.
 *
 * WHITESPACE-ONLY counts as blank. A reader following `foo.ts:120` to a line of
 * three spaces has landed on nothing, and the distinction between an empty line
 * and an indented empty line is invisible to them.
 *
 * The three reasons are separate because they fail differently: `past-eof` and
 * `range-end-past-eof` are arithmetic — the file cannot have shrunk that far and
 * still say what the cell claims — while `blank` is the P2.69 class, an anchor
 * that drifted into the gap between two things.
 *
 * A citation whose PATH is missing from `contents` is skipped, not reported: it
 * is either already reported as a dead path or was never eligible.
 */
export function findDeadLineCitations(
  citations: readonly Citation[],
  contents: ReadonlyMap<string, string>,
): LineFinding[] {
  const counted = new Map<string, { readonly lines: readonly string[]; readonly count: number }>()
  const out: LineFinding[] = []
  for (const citation of citations) {
    const tail = LINE_TAIL.exec(citation.text)
    if (tail === null) continue
    const content = contents.get(citation.path)
    if (content === undefined) continue
    let file = counted.get(citation.path)
    if (file === undefined) {
      const lines = content.split('\n')
      file = { lines, count: countLines(content) }
      counted.set(citation.path, file)
    }
    const start = Number(tail[1])
    const end = tail[2] === undefined ? undefined : Number(tail[2])
    if (start < 1 || start > file.count) {
      out.push({ citation, reason: 'past-eof', lineCount: file.count })
      continue
    }
    if ((file.lines[start - 1] ?? '').trim() === '') {
      out.push({ citation, reason: 'blank', lineCount: file.count })
      continue
    }
    if (end !== undefined && end > file.count) {
      out.push({ citation, reason: 'range-end-past-eof', lineCount: file.count })
    }
  }
  return out
}

/**
 * P6.891 — THE OPT-IN IDENTIFIER CHECK, and why it is opt-in rather than general.
 *
 * The blank-line check above is a SAMPLE of drift, not a measure of it: at HEAD
 * 1 760 line-tailed citations resolve and 1 759 of them land on some non-blank
 * line, which the guard reports as nothing at all. A citation that drifted onto
 * a different real line still reads as evidence and still passes.
 *
 * The obvious widening — "does the identifier named beside the citation appear
 * near the cited line" — was MEASURED before it was written, four ways, because
 * the same widening is what P6.898 refused for prose counts on cry-wolf grounds
 * (2026-09-08, a reading with a date; re-run it rather than quoting it):
 *
 * | how the "sentence" is read | subjects | within +-5 | miss |
 * | --- | ---: | ---: | ---: |
 * | first backticked span ATTACHED to the citation | 24 | 10 | 14 |
 * | any backticked span in the next 40 chars | 290 | 118 | 172 |
 * | any backticked span in the next 80 chars | 422 | 164 | 258 |
 * | any backticked span in the next 200 chars | 706 | 207 | 499 |
 *
 * The window forms are the cry-wolf shape: at 40 chars the miss rate is 59 %,
 * and widening the radius to 80 lines only takes it to 34 % — because the
 * identifier a window catches is routinely the one belonging to the NEXT clause,
 * which is about a different file. The ATTACHED form is different in kind, and
 * the difference was hand-checked rather than assumed: all seven distinct misses
 * it produced were REAL drift (the identifier had moved 11, 391, 449, 665 and
 * 3 014 lines away, or was absent from the cited file entirely), and the one
 * false positive among them was a full stop being treated as a separator — a new
 * sentence starting with a backticked word. That is why {@link SENTENCE_BREAK}
 * exists and why the separator set is spelled out rather than left to a dot-star.
 *
 * So: a citation whose sentence ATTACHES an identifier opts in and is checked; a
 * citation that does not is not checked, and is not silently reported as passing
 * either — the summary line names how many opted in.
 *
 * ## What it still cannot catch, stated for the same reason the header above is
 *
 * A cell that names no identifier is unchecked, which is most of them. An
 * identifier that legitimately sits far from the line it is cited beside reads
 * as a miss — repair it or baseline it with a reason, exactly as with a blank
 * anchor. And an identifier PRESENT within the window does not mean the cell's
 * SENTENCE is true; this is a containment check, not a comprehension one.
 */
export const IDENTIFIER_RADIUS = 5

/**
 * A sentence boundary: a full stop (or `?`/`!`) and whitespace. An identifier
 * after one of these belongs to the next sentence and is about something else.
 * Measured: without this, `nestor-cloud-agent.ts:293` was charged with an
 * identifier that opens the sentence after it.
 */
const SENTENCE_BREAK = /[.?!]\s/

/**
 * Separators that may sit between a citation and the identifier it names, and
 * nothing else. Spelled out because the cost of getting it wrong is a finding
 * against a cell that is correct.
 */
const ATTACHED_IDENTIFIER = /^[\s(,:;\u2014\u2013-]*`([A-Za-z_$][A-Za-z0-9_$.]{2,})`/

/** Tokens that look like identifiers and are not: a path, a filename, a literal. */
function isIdentifierLike(token: string): boolean {
  if (token.includes('/')) return false
  if (/\.(ts|tsx|js|mjs|cjs|json|md|toml|ya?ml|ps1|sh)$/.test(token)) return false
  return !['true', 'false', 'null', 'undefined'].includes(token.toLowerCase())
}

/** The identifier a citation's own sentence attaches to it, if any. */
export function attachedIdentifier(after: string): string | undefined {
  // A citation is usually written INSIDE backticks, so the first character after
  // it is its own closing delimiter, not the opening one of an identifier. Both
  // forms occur in these documents and both must opt in the same way.
  const head = (after.startsWith('`') ? after.slice(1) : after).slice(0, 80)
  const backtick = head.indexOf('`')
  if (backtick < 0) return undefined
  // The gap between the citation and the identifier decides whether they are one
  // sentence. A full stop in it means they are not.
  if (SENTENCE_BREAK.test(head.slice(0, backtick + 1))) return undefined
  const match = ATTACHED_IDENTIFIER.exec(head)
  if (match === null) return undefined
  const token = match[1] as string
  return isIdentifierLike(token) ? token : undefined
}

export interface IdentifierFinding {
  readonly citation: Citation
  readonly identifier: string
  /** Lines in the cited file as this guard counted them. */
  readonly lineCount: number
  /** The window that was searched, for the message. */
  readonly from: number
  readonly to: number
}

/**
 * A citation whose attached identifier is nowhere near the line it cites.
 *
 * Skips anything the blank/EOF check already reports: a dead anchor must produce
 * ONE finding, not two saying the same thing in different words.
 */
export function findDriftedIdentifierCitations(
  citations: readonly Citation[],
  contents: ReadonlyMap<string, string>,
): IdentifierFinding[] {
  const out: IdentifierFinding[] = []
  for (const citation of citations) {
    const tail = LINE_TAIL.exec(citation.text)
    if (tail === null) continue
    const identifier = attachedIdentifier(citation.after)
    if (identifier === undefined) continue
    const content = contents.get(citation.path)
    if (content === undefined) continue
    const lines = content.split('\n')
    const count = countLines(content)
    const start = Number(tail[1])
    const end = tail[2] === undefined ? start : Number(tail[2])
    if (start < 1 || start > count || end > count) continue
    if ((lines[start - 1] ?? '').trim() === '') continue
    const from = Math.max(1, start - IDENTIFIER_RADIUS)
    const to = Math.min(count, end + IDENTIFIER_RADIUS)
    const window = lines.slice(from - 1, to).join('\n')
    if (window.includes(identifier)) continue
    if (dottedMemberIsInWindow(identifier, content, window)) continue
    out.push({ citation, identifier, lineCount: count, from, to })
  }
  return out
}

/**
 * `A.b` beside a citation names MEMBER `b` OF `A`, and a member is not spelled
 * with its owner in the source. Measured 2026-09-08 (W9-bn, P6.919) on the first
 * of the 36 baselined citations read by hand:
 * `packages/core/src/types/pi-harness-runtime.ts:158-203` carries the identifier
 * `PiHarnessChildSummaryV1.effort`, the interface opens at `:159` and its
 * `effort?: PiHarnessChildEffortV1` member sits at `:201` — INSIDE the cited
 * range. The citation is correct and this check called it drift, because it
 * searched for a string that appears nowhere in any TypeScript file.
 *
 * The fallback is deliberately narrow, and the narrowing is what keeps it from
 * hiding real drift: it applies ONLY when the dotted form is absent from the
 * WHOLE cited file. A dotted token that does exist literally somewhere — every
 * key of `packages/shared/src/i18n/locales/en.json` is one, and
 * `onboarding.reauth.expired` was among the 36 — keeps being measured against
 * its real location rather than being rescued by a common last segment
 * (`expired`, `model`, `text`). Two of the three dotted citations among the 36
 * stayed findings under this rule and both were real: that one, 77 lines away,
 * and `TurnSteerParams.expectedTurnId`, whose nearest hit is 1 800 lines from
 * the line cited beside it.
 */
function dottedMemberIsInWindow(identifier: string, content: string, window: string): boolean {
  if (!identifier.includes('.')) return false
  if (content.includes(identifier)) return false
  const member = identifier.slice(identifier.lastIndexOf('.') + 1)
  if (member.length < 3) return false
  return window.includes(member)
}

/**
 * The baseline key for a dead-PATH finding: the cited path, with no `:line` tail
 * and nothing about where the citation was written.
 *
 * A function rather than an inline `finding.citation.path`, for the same reason
 * {@link deadLineBaselineKey} is one — see its header for the measurement. The
 * five key forms are five functions so the invariant they share can be asserted
 * in one place instead of being re-derived from five call sites.
 */
export function deadPathBaselineKey(finding: Finding): string {
  return finding.citation.path
}

/**
 * The baseline key for a dead-LINE finding: the citation exactly as written,
 * `:line` tail included — the CITED file and the CITED line.
 *
 * ## C3.297 — the premise this function exists to settle, MEASURED 2026-09-12
 *
 * The row that sent this lane here says the baseline comparison is *"keyed on
 * `<file>:<line>` of the CITING line, so an insertion above a citation reports
 * it as a NEW finding"*. **It is not, and it does not.** Every one of the five
 * baseline keys is built from the CITED side alone — {@link Citation.path} and
 * {@link Citation.text}, plus an identifier / row / symbol suffix.
 * {@link Citation.doc} and {@link Citation.line}, which are where the citation
 * was WRITTEN, reach the printed prefix of a finding and nothing else.
 *
 * Measured rather than reasoned: five lines inserted at the top of the
 * capability ledger, the gate re-run on the same index, and the two runs
 * compared. The gate's own numbers were **byte-identical** — `0 / 15 / 6 / 0 / 0`
 * NOT-in-the-baseline on the five arms, before and after — while the raw OUTPUT
 * differed on **78 lines**, every one of them a finding whose `doc:line` prefix
 * had moved by exactly five.
 *
 * So the trap W16-k recorded is real and belongs one layer up: it bites a LANE
 * that compares two runs by diffing their output, never the baseline. The
 * technique is to normalise the prefix away before diffing —
 * `sed 's/^\([^ ]*\):[0-9]*  /\1:  /'` — or simply to read the five counts,
 * which cannot move for that reason at all.
 */
export function deadLineBaselineKey(finding: LineFinding): string {
  return finding.citation.text
}

/**
 * The baseline key for an identifier finding.
 *
 * `::` and NOT `#`, which was the obvious choice and is wrong: {@link readBaseline}
 * strips everything from a `#` onward as an inline comment, so a `#`-separated key
 * read back as the bare `path:line` — silently colliding with the dead-LINE key
 * form and silencing an entry that was never baselined. Measured the first time
 * this file was regenerated: 36 entries written, 0 matched on the next run. A
 * path never contains `::`, so the three forms stay distinguishable.
 */
export function identifierBaselineKey(finding: IdentifierFinding): string {
  return `${finding.citation.text}::${finding.identifier}`
}

/**
 * P6.943 — THE ROW-ID ARM: a citation into a MARKDOWN document whose sentence
 * names a ledger row.
 *
 * ## The hole it closes, stated as it was measured
 *
 * A line-tailed citation is checked for BLANKNESS, never for content — the
 * header above says so twice — and P6.938 measured what that costs on this
 * repo's most-moved documents: the capability ledger admitted 525 rows in one
 * day, every line number below the insertion point moved, and all four distinct
 * line numbers citing the ledger from outside now resolve to a non-blank line
 * about a different subject. Four citations that are simply wrong, and a green
 * gate over every one of them.
 *
 * The repair W9-bs made to the two such citations inside these documents was to
 * stop citing a line at all and cite the ROW — *the `K5` row of `<path>`* —
 * because a row id cannot rot when the file grows. That repair had a cost
 * nobody stated: it removed the citation from the only check that could see it.
 * The blank-line check needs a `:line` tail, and {@link attachedIdentifier}'s
 * opt-in needs three characters, so `K5`, `F5` and `O5` — the exact spellings a
 * ledger row uses — opt out by being two characters long. This arm is what makes
 * the durable form checkable.
 *
 * ## It reads BOTH sides, and the reason the after-side was once refused is gone
 *
 * The first version of this arm read only the text BEFORE the citation, on a
 * measurement over the three documents 2026-09-09: a row id attached AFTER a
 * citation occurred **0** times and BEFORE it **2**. P6.948 admitted the PLAN to
 * {@link LEDGERS} the same day and refuted both halves of that reasoning at once
 * — the plan writes the durable form the other way round, *`<path>` row `H9`*,
 * twice — so the after-side is now read as well.
 *
 * The overlap that was the second reason for refusing it does not exist, and the
 * reason is worth stating because it is what keeps one defect one finding: the
 * connective REQUIRES the bare word `row` / `entry` / `section`, and
 * {@link attachedIdentifier} refuses anything that is not a backticked span
 * immediately after its separators. A bare word in the gap therefore blocks the
 * identifier arm outright, on both sides and at every id length — so the two
 * arms cannot both fire on one citation, by construction rather than by a length
 * coincidence.
 *
 * ## Why the connective is a WORD and not a wildcard
 *
 * The original rule accepted any short gap and leaned on a narrow {@link ROW_ID}
 * to keep a hex byte or a version string from being read as a row. That pairing
 * could not survive the plan, whose ids are `P2.263` and `Dev-13` and `OQ-11`:
 * widening the shape without widening the gate would have made every `v1.2` in
 * these documents a candidate. Requiring the word instead makes the opt-in
 * EXPLICIT — the same design this file's count check settled on — and lets the
 * id shape be as wide as the two documents' real vocabulary.
 *
 * ## What it resolves, and the two reasons
 *
 * The row is resolved in the target as the line that DEFINES the id — a table
 * row `| K5 |`, a list item `- **DR-2 —`, or a heading `## OQ-11 —`
 * ({@link rowAnchorLine}) — never as a bare `K5`, which matches a hex byte, a
 * cell reference and a version string. The three shapes are one union because
 * the plan's decision entries are not tables: `DR-2`, `Dev-13` and `OQ-11` are
 * the ids seven of the converted citations name, and a table-only anchor would
 * have reported every one of them `missing`. Then:
 *
 *  - **`missing`** — no such row in the cited document. This is the whole check
 *    for a citation with no `:line` tail, and it is the one the converted form
 *    needs: a renamed or deleted row makes the sentence false, and nothing else
 *    in this gate would notice.
 *  - **`far`** — the row exists and the cited LINE is more than
 *    {@link IDENTIFIER_RADIUS} away from it. That is P6.943's own finding shape:
 *    the number drifted while the row stayed.
 *
 * A citation the blank/EOF check already reports is skipped here, for the reason
 * {@link findDriftedIdentifierCitations} gives: one defect must be one finding.
 *
 * ## What it still cannot catch
 *
 * A row id PRESENT in the cited document does not mean the cell's sentence about
 * that row is true; this is a containment check, like its two siblings. And a
 * citation that names no row at all is not checked here and is not reported as
 * passing either — the summary line prints how many opted in.
 */
const ROW_ID = /^[A-Z][A-Za-z]{0,3}[.-]?\d{1,3}(?:[.-]\d{1,3})?$/

/**
 * A backticked span, the CONNECTIVE WORD, then the citation — *the `K5` row of
 * `path`*. The word is required rather than a capped wildcard: see the header's
 * §"Why the connective is a WORD and not a wildcard". A full stop cannot appear
 * inside it, so the sentence rule the identifier arm needs is structural here.
 */
const PRECEDING_ROW_ID = /`([A-Za-z][A-Za-z0-9.-]{1,7})`\s+(?:row|entry|section)s?\s+(?:of|in)?\s*$/

/**
 * The mirror the plan writes — *`path` row `H9`*. Same required word, so the
 * two forms opt in the same way and neither can reach {@link attachedIdentifier}.
 */
const FOLLOWING_ROW_ID = /^`?\s*(?:row|entry|section)s?\s+`([A-Za-z][A-Za-z0-9.-]{1,7})`/

/**
 * The row id a citation's own sentence attaches to it, on either side.
 *
 * `after` is optional so the before-side rule stays callable on its own; every
 * caller inside this file passes both, because a document may write either form
 * and reading one side only is how the arm missed the plan's two for a day.
 */
export function attachedRowId(before: string, after = ''): string | undefined {
  // A citation is usually written INSIDE backticks, so the character just before
  // it is its own OPENING delimiter, not the row id's closing one — and the one
  // just after it is its own CLOSING delimiter, which is why FOLLOWING_ROW_ID
  // tolerates a leading backtick.
  const tail = (before.endsWith('`') ? before.slice(0, -1) : before).slice(-100)
  const preceding = PRECEDING_ROW_ID.exec(tail)
  if (preceding !== null) {
    const token = preceding[1] as string
    if (ROW_ID.test(token)) return token
  }
  const following = FOLLOWING_ROW_ID.exec(after.slice(0, 60))
  if (following === null) return undefined
  const token = following[1] as string
  return ROW_ID.test(token) ? token : undefined
}

/**
 * The 1-based line that DEFINES this id, or `undefined`.
 *
 * Three shapes, because the two kinds of document this guard reads write their
 * ids three ways and a table-only anchor reported seven of the plan's converted
 * citations `missing`: a table row (`| K5 |`), a list item (`- **DR-2 —`), and a
 * heading (`## OQ-11 —`). The id must end at a non-alphanumeric, which is what
 * keeps `K5` from resolving to a `K50` row — the case the original form got
 * right by requiring the closing pipe, and the one a looser rewrite loses.
 *
 * The id is ESCAPED, which the first version did not need and this one does:
 * {@link ROW_ID} now admits `.` and `-`, and an unescaped `P2.263` would match a
 * `P2X263` row that is a different row.
 */
export function rowAnchorLine(lines: readonly string[], rowId: string): number | undefined {
  const id = rowId.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  const anchor = new RegExp(`^\\s*(?:\\|\\s*|[-*+]\\s+|#{1,6}\\s+)(?:\\*\\*)?${id}(?![A-Za-z0-9])`)
  for (let index = 0; index < lines.length; index += 1) {
    if (anchor.test(lines[index] as string)) return index + 1
  }
  return undefined
}

export type RowFindingReason = 'missing' | 'far'

export interface RowFinding {
  readonly citation: Citation
  readonly rowId: string
  readonly reason: RowFindingReason
  /** Where the row actually is, when it exists at all. */
  readonly rowLine?: number
  /** Lines in the cited file as this guard counted them. */
  readonly lineCount: number
  /** The window the line-tailed form was checked against, when there was one. */
  readonly from?: number
  readonly to?: number
}

/** See {@link ROW_ID}'s header for what this checks and what it deliberately does not. */
export function findRowIdCitations(
  citations: readonly Citation[],
  contents: ReadonlyMap<string, string>,
): RowFinding[] {
  const out: RowFinding[] = []
  for (const citation of citations) {
    if (!citation.path.endsWith('.md')) continue
    const rowId = attachedRowId(citation.before, citation.after)
    if (rowId === undefined) continue
    const content = contents.get(citation.path)
    if (content === undefined) continue
    const lines = content.split('\n')
    const count = countLines(content)
    const rowLine = rowAnchorLine(lines, rowId)
    if (rowLine === undefined) {
      out.push({ citation, rowId, reason: 'missing', lineCount: count })
      continue
    }
    const tail = LINE_TAIL.exec(citation.text)
    if (tail === null) continue
    const start = Number(tail[1])
    const end = tail[2] === undefined ? start : Number(tail[2])
    // Both belong to the blank/EOF check, which reports them in its own words.
    if (start < 1 || start > count || end > count) continue
    if ((lines[start - 1] ?? '').trim() === '') continue
    const from = Math.max(1, start - IDENTIFIER_RADIUS)
    const to = Math.min(count, end + IDENTIFIER_RADIUS)
    if (rowLine >= from && rowLine <= to) continue
    out.push({ citation, rowId, reason: 'far', rowLine, lineCount: count, from, to })
  }
  return out
}

/**
 * The baseline key for a row-id finding.
 *
 * `::row=` rather than `::`, so it cannot collide with an identifier key for a
 * citation that carries both — an identifier never contains `=`, and the
 * dead-LINE key form is a bare `path:line` with no `::` at all. The same
 * three-forms-stay-distinguishable reasoning as {@link identifierBaselineKey},
 * whose header records what the obvious `#` separator cost.
 */
export function rowBaselineKey(finding: RowFinding): string {
  return `${finding.citation.text}::row=${finding.rowId}`
}

/**
 * D1.114 — A RE-STAMP CAN LAND INSIDE THE ROW ID IT QUALIFIES, and every arm
 * above it reads straight past the wreckage.
 *
 * ## The defect, measured
 *
 * The capability ledger's J5 cell cited two plan rows as `P3.237 (...) + P3.247
 * (...)`. A later pass re-stamped the first claim at a newer codex tag and wrote
 * the qualifier into the MIDDLE of the id — the text at `830b2f19c~1` reads
 * `P3 (still true about the REASON at ... ).237`, a hundred and eighty characters
 * of correct, freshly measured prose sitting between `P3` and `.237`. The
 * sentence still reads fluently. The id does not exist any more.
 *
 * Nothing saw it, and the reason is structural rather than an oversight:
 * {@link findRowIdCitations} needs a repo-file CITATION to attach a row id to,
 * {@link attachedRowId} needs a backticked span followed by the word `row`, and
 * a plan-row reference in prose is neither. So the row-id arm reported 0 — not
 * because the id resolved, but because the text had stopped spelling one.
 *
 * ## The rule
 *
 * A row id head (`P3`, `D1`, `DA1`, `Dev`-style, up to four letters and three
 * digits), a space, a PARENTHETICAL, then a bare `.<digits>` tail. The two
 * halves spell an id when the parenthetical is lifted out, which is both the
 * detection and the repair.
 *
 * ## The narrowing that makes it landable, and it is AGENTS.md's own trap
 *
 * §Traps records that a CORRECTION which spells the dead anchor re-creates the
 * finding it is repairing. This arm is that trap in its sharpest form: the
 * defect shape occurs THREE times in the gated corpus today (2026-09-17) and all
 * three are the PROSE DESCRIBING IT — the source row and its carried copy in the
 * two plans, plus the closing row of the pass that repaired J5. {@link LEDGERS}
 * admits both plans, a lane may not repair a plan, and this gate is a step of
 * `lint:chain`, so the obvious spelling of this rule would have blocked the chain
 * for every lane on the day it landed, over three sentences that are correct.
 *
 * So the parenthetical must carry at least one ALPHANUMERIC character: an
 * ELISION is prose, a re-stamp is not. It is the same distinction this file
 * already draws for a `..` path segment (see the header's §"The two exclusions")
 * and the same remedy AGENTS.md prescribes — name the broken form in words, or
 * elide its middle, and the guard reading for the real thing stays quiet.
 *
 * Controls, both on the same instrument (`grep -aoP` — `git grep -E` does not
 * honour `\b` on this rig, §Traps): the pre-repair J5 blob at `830b2f19c~1`
 * answers **1**; the five gated documents plus the integrations plan at HEAD
 * answer **0**, the three descriptive spellings included.
 *
 * ## What it cannot catch
 *
 * A qualifier written with no brackets at all (`P3 still true .237`) is not
 * matched, deliberately: without a delimiter the rule would have to guess where
 * the prose ends, and a guess there is how a gate starts crying wolf. A
 * parenthetical that lands beside an id rather than inside it (`P3.237 (...)`)
 * is the CORRECT form and is why the tail is required to follow the bracket.
 */
const SPLIT_ROW_ID = /([A-Z][A-Za-z]{0,3}\d{1,3}) (\([^)\n]*[A-Za-z0-9][^)\n]*\))(\.\d{1,4})(?![A-Za-z0-9.])/g

export interface SplitRowIdFinding {
  /** The document the broken id was read from. */
  readonly doc: string
  /** 1-based line in that document. */
  readonly line: number
  /** The whole span exactly as written, qualifier included. */
  readonly text: string
  /** The id the two halves spell once the qualifier is lifted out — the repair. */
  readonly rowId: string
  /** The parenthetical that landed between them, for the operator's message. */
  readonly qualifier: string
}

/**
 * Every split row id in one document. See {@link SPLIT_ROW_ID} for the rule, the
 * narrowing and both controls.
 *
 * It reads the DOCUMENT rather than the citation list, because the subject is
 * not a repo file: a plan-row reference cites a row in another markdown file and
 * usually carries no path at all. That also means it is the one arm here with no
 * index read of any kind.
 */
export function findSplitRowIds(doc: string, text: string): SplitRowIdFinding[] {
  const out: SplitRowIdFinding[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index] as string
    SPLIT_ROW_ID.lastIndex = 0
    for (let match = SPLIT_ROW_ID.exec(value); match !== null; match = SPLIT_ROW_ID.exec(value)) {
      out.push({
        doc,
        line: index + 1,
        text: match[0] as string,
        rowId: `${match[1] as string}${match[3] as string}`,
        qualifier: match[2] as string,
      })
    }
  }
  return out
}

/**
 * The baseline key for a split row id.
 *
 * `::split-row=` for {@link rowBaselineKey}'s reason — the forms must stay
 * distinguishable in one flat file — and the DOCUMENT rather than a citation on
 * the left, because there is no citation: the broken id is the subject, and the
 * document it sits in is what makes it one finding rather than five.
 *
 * The repaired ID, never the span as written: the C3.297 invariant every other
 * key here obeys is that a key does not carry the citing LINE, so an insertion
 * above a finding cannot report it as new — and a key built from a hundred and
 * eighty characters of qualifier would break the same invariant one word at a
 * time, changing the moment anyone edits the prose inside the brackets.
 */
export function splitRowIdBaselineKey(finding: SplitRowIdFinding): string {
  return `${finding.doc}::split-row=${finding.rowId}`
}

/**
 * P6.957 — THE IDENTIFIER-ONLY CITATION FORM: a path, a connective WORD, and a
 * backticked identifier, with no `:line` tail at all.
 *
 * ## Why the form exists — a line anchor into a file another lane is rewriting
 * cannot be kept green
 *
 * Measured over one afternoon (2026-09-09, W9-bv): `SessionManager.ts` went
 * 34 477 → 34 548 → 34 585 lines under three sibling commits, this gate went red
 * on 48 findings the ledger lane had not written, and four anchors repaired at
 * one point were blank again an hour later. One of them repaired ITSELF when a
 * later commit moved the file back over a non-blank line. A citation into a hot
 * file is therefore not evidence that survives the week, however carefully it is
 * re-derived — and the repair cost falls on whoever runs the gate next.
 *
 * P6.943 solved exactly this for markdown by citing a ROW id rather than a line
 * ({@link ROW_ID}). This is its source-file twin: *`path` symbol `name`* cannot
 * rot when the file grows, because nothing about it is positional.
 *
 * ## What it promises, and what it does NOT
 *
 * It promises ONE thing: that identifier occurs in that file, as a whole token.
 * It does not say WHERE, it does not say the token is a DEFINITION rather than a
 * mention in a comment, a string or an import, and — like both of its siblings —
 * it does not say the cell's sentence about it is true. It is a containment
 * check, not a comprehension one. What it buys for that narrowness is a citation
 * that no other lane's commit can falsify.
 *
 * ## Why a whole-token match and not `includes`
 *
 * {@link findDriftedIdentifierCitations} matches with plain containment because
 * its window is eleven lines. Over a WHOLE file that is close to vacuous: a
 * three-character identifier occurs inside some longer name in a 34 000-line
 * source file with near-certainty, so `join` would be "found" in `joinPath` and
 * the check would pass on a symbol that no longer exists. The boundary is what
 * makes the weaker window honest rather than decorative.
 *
 * ## Why the opt-in is a WORD, and what the alternative measured
 *
 * The accidental population — every tail-less citation followed by a backticked
 * span, i.e. {@link attachedIdentifier}'s rule with the tail requirement dropped
 * — is 33 subjects and 15 misses (2026-09-09, a reading with a date). Hand-read,
 * the misses are dominated by the two shapes this file has refused twice before:
 * the identifier of the NEXT clause (`…, `fastMode` → 13` is a different grep
 * count, not a claim about the path before it) and a token that is not an
 * identifier at all (`(`bc7c684a8`)`, a commit sha). The parenthesised form
 * `path` (`name`) is narrower — 8 subjects, 4 misses — and still admits the sha.
 *
 * So the opt-in is the same design the count arm and the row-id arm both settled
 * on: an EXPLICIT connective word. It was measured at **0** existing subjects
 * across all four documents before it was written, which is the point — the arm
 * starts empty and grows only as cells are deliberately converted, so it can
 * never manufacture a finding in the PLAN, which no lane may repair.
 *
 * ## The three arms cannot both fire on one citation, by construction
 *
 * {@link attachedIdentifier} refuses anything that is not a backticked span
 * immediately after its separator set, so a bare word in the gap blocks it
 * outright; `symbol`/`identifier` is disjoint from the row arm's
 * `row`/`entry`/`section`. One defect stays one finding without a length
 * coincidence doing the work.
 *
 * ## The residue, stated rather than hidden
 *
 * A citation written in this form that ALSO carries a `:line` tail is checked
 * for containment over the whole file — the weaker of the two — because the
 * connective word blocks the ±5 window arm. The blank/EOF arm still reads its
 * line, so the anchor cannot be silently dead; but the form is meant for
 * citations that name no line, and writing both gets the union of a strong
 * existence check and a weak location one.
 */
const SYMBOL_WORD = '(?:symbol|identifier)'

/** *the `createSummaryAgent` symbol of `path`* — the mirror of {@link PRECEDING_ROW_ID}. */
const PRECEDING_SYMBOL = new RegExp(
  '`([A-Za-z_$][A-Za-z0-9_$.]{2,})`\\s+' + SYMBOL_WORD + '\\s+(?:of|in)?\\s*$',
)

/** *`path` symbol `createSummaryAgent`* — the form a converted cell writes. */
const FOLLOWING_SYMBOL = new RegExp(
  '^`?\\s*' + SYMBOL_WORD + '\\s+`([A-Za-z_$][A-Za-z0-9_$.]{2,})`',
)

/**
 * The identifier a citation's own sentence names as a SYMBOL, on either side.
 *
 * Both sides for {@link attachedRowId}'s measured reason: reading one side only
 * is how that arm missed the plan's two citations for a day.
 */
export function attachedSymbol(before: string, after = ''): string | undefined {
  // A citation is usually written INSIDE backticks, so the character just before
  // it is its own opening delimiter and the one just after it its own closing
  // one — the same tolerance {@link attachedRowId} needs, for the same reason.
  const tail = (before.endsWith('`') ? before.slice(0, -1) : before).slice(-100)
  const preceding = PRECEDING_SYMBOL.exec(tail)
  if (preceding !== null) {
    const token = preceding[1] as string
    if (isIdentifierLike(token)) return token
  }
  const following = FOLLOWING_SYMBOL.exec(after.slice(0, 80))
  if (following === null) return undefined
  const token = following[1] as string
  return isIdentifierLike(token) ? token : undefined
}

export interface SymbolFinding {
  readonly citation: Citation
  readonly symbol: string
  /** Lines in the cited file as this guard counted them. */
  readonly lineCount: number
}

/**
 * Whether the identifier occurs in the file as a WHOLE token.
 *
 * The dotted fallback is {@link dottedMemberIsInWindow}, called with the whole
 * file as its own window: `A.b` beside a citation names member `b` of `A`, and a
 * member is not spelled with its owner in the source. It is deliberately looser
 * than the boundary rule above (plain containment of the member) because it is
 * the same rescue the ±5 arm applies, and one rule in one place is worth more
 * than a second spelling of it here.
 */
export function symbolOccurs(identifier: string, content: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(content)) return true
  return dottedMemberIsInWindow(identifier, content, content)
}

/** See {@link SYMBOL_WORD}'s header for what this checks and what it does not. */
export function findAbsentSymbolCitations(
  citations: readonly Citation[],
  contents: ReadonlyMap<string, string>,
): SymbolFinding[] {
  const out: SymbolFinding[] = []
  for (const citation of citations) {
    const symbol = attachedSymbol(citation.before, citation.after)
    if (symbol === undefined) continue
    const content = contents.get(citation.path)
    if (content === undefined) continue
    if (symbolOccurs(symbol, content)) continue
    out.push({ citation, symbol, lineCount: countLines(content) })
  }
  return out
}

/**
 * The baseline key for an absent-symbol finding.
 *
 * `::symbol=` for {@link rowBaselineKey}'s reason: a citation could carry both
 * forms, and an identifier never contains `=`, so the five key forms stay
 * distinguishable in one flat file.
 */
export function symbolBaselineKey(finding: SymbolFinding): string {
  return `${finding.citation.text}::symbol=${finding.symbol}`
}

/**
 * C3.325 — THE ANCHOR ARM: a citation whose sentence names a VERBATIM STRING
 * that is supposed to LOCATE something inside the cited file.
 *
 * ## The defect, and it is not the one the sibling arms catch
 *
 * {@link findAbsentSymbolCitations} asks whether a name still OCCURS. For a
 * symbol that is the whole question — a function called twenty times is not a
 * defect. An ANCHOR is the other shape: a string whose entire job is to say
 * *land here*, so it is evidence only while it occurs EXACTLY ONCE. Zero means
 * it is gone; two means the instruction beside it now names two places and the
 * reader cannot tell which, while the sentence keeps reading as verified.
 *
 * W17-z met that live (2026-09-12, PR-4): the filename constant
 * `"remote-settings.json"`, used as the anchor for a cluster of minified
 * functions, went **1 → 4 occurrences across one lift** while the comment
 * holding it stayed green. Nothing in this repo could see it, and the whole
 * repair was a hand reading.
 *
 * ## What it promises, and what it does not
 *
 * Exactly one thing: that literal occurs exactly once in that file, in the
 * index. It does not say the sentence about it is true, it does not say the
 * occurrence is the one the author meant, and it cannot see an anchor in a file
 * this repository does not track — see the residue at the end of this block,
 * which is where the case that bore the row actually lives.
 *
 * ## Why the opt-in is a WORD, with the number that refuses the alternative
 *
 * The accidental form — any backticked PHRASE (a span carrying a space)
 * immediately after a citation — was measured over the five documents on
 * 2026-09-12: **5 584 subjects, of which 201 occur exactly once** in the cited
 * file, 3 559 not at all and 1 824 more than once. A rule on that population
 * would open with 5 383 findings, which is the cry-wolf shape AGENTS.md names
 * and the reason {@link SYMBOL_WORD} and {@link collectCountProbes} both settled
 * on an explicit connective word. The `anchor` word's own subject population is
 * **0** at HEAD, all five documents — the same empty start the symbol arm had,
 * and for the same reason: an arm that can only grow by a deliberate conversion
 * can never manufacture a finding in the PLAN, which no lane may repair.
 *
 * ## The one refusal: a literal containing `#`
 *
 * Two independent reasons, each measured rather than assumed.
 *
 *  - {@link readBaseline} strips everything from a `#` onward as an inline
 *    comment, so such a key would be read back TRUNCATED and could collide with
 *    the dead-LINE key form — the defect {@link identifierBaselineKey}'s header
 *    records costing 36 entries that matched nothing on the next run.
 *  - A `#section` is a DOC-PAGE anchor, whose gate is `check-doc-anchors.ts`;
 *    admitting one here would report the vendor's section id as absent from one
 *    of our files. The risk is real rather than theoretical: the five documents
 *    already spell `anchor` immediately before a backticked `#…` **16** times
 *    (2026-09-12), and none of those sits beside a repo-file citation today.
 *
 * ## THE RESIDUE, stated because the row's own example is inside it
 *
 * The subject of every arm in this file is a TRACKED file read from the index,
 * so an anchor into the vendored minified bundle or the native `claude` binary
 * is out of reach here BY CONSTRUCTION — `node_modules` is not tracked. That is
 * exactly where `"remote-settings.json"` lives, cited from
 * `packages/shared/src/config/managed-env.ts`. The script that already resolves
 * both artefacts is `scripts/check-minified-citations.ts`, and its `NAMES` arm
 * checks resolution rather than uniqueness; the uniqueness half over the binary
 * is a proposed row and deliberately not built here, because this gate would
 * have to learn to read an untracked file to host it.
 */
const ANCHOR_WORD = '(?:anchor)'

/** *the `if(!e?.env)return e;` anchor of `path`* — the mirror of {@link PRECEDING_SYMBOL}. */
const PRECEDING_ANCHOR = new RegExp('`([^`\\n]{3,})`\\s+' + ANCHOR_WORD + '\\s+(?:of|in)?\\s*$')

/** *`path` anchor `if(!e?.env)return e;`* — the form a converted cell writes. */
const FOLLOWING_ANCHOR = new RegExp('^`?\\s*' + ANCHOR_WORD + '\\s+`([^`\\n]{3,})`')

/** See the `#` refusal in {@link attachedAnchor}'s block: one rule, two reasons. */
function isAnchorLike(token: string): boolean {
  return !token.includes('#')
}

/**
 * The literal a citation's own sentence names as an ANCHOR, on either side.
 *
 * Both sides for {@link attachedRowId}'s measured reason: reading one side only
 * is how that arm missed the plan's two citations for a day.
 */
export function attachedAnchor(before: string, after = ''): string | undefined {
  // A citation is usually written INSIDE backticks, so the character just before
  // it is its own opening delimiter — the same tolerance {@link attachedSymbol}
  // needs, for the same reason.
  const tail = (before.endsWith('`') ? before.slice(0, -1) : before).slice(-160)
  const preceding = PRECEDING_ANCHOR.exec(tail)
  if (preceding !== null) {
    const token = preceding[1] as string
    if (isAnchorLike(token)) return token
  }
  const following = FOLLOWING_ANCHOR.exec(after.slice(0, 160))
  if (following === null) return undefined
  const token = following[1] as string
  return isAnchorLike(token) ? token : undefined
}

export interface AnchorFinding {
  readonly citation: Citation
  readonly anchor: string
  /** Occurrences in the cited file's indexed content — a finding is anything but 1. */
  readonly occurrences: number
  /** Lines in the cited file as this guard counted them. */
  readonly lineCount: number
}

/**
 * Occurrences of a literal, OVERLAPPING ones included.
 *
 * `indexOf` from `at + 1` rather than from `at + anchor.length`: an anchor that
 * overlaps itself is ambiguous for exactly the reason this arm exists, so the
 * looser count is the one that answers the question being asked.
 */
export function countOccurrences(anchor: string, content: string): number {
  let count = 0
  for (let at = content.indexOf(anchor); at !== -1; at = content.indexOf(anchor, at + 1)) count += 1
  return count
}

/** See {@link ANCHOR_WORD}'s header for what this checks and what it does not. */
export function findAmbiguousAnchorCitations(
  citations: readonly Citation[],
  contents: ReadonlyMap<string, string>,
): AnchorFinding[] {
  const out: AnchorFinding[] = []
  for (const citation of citations) {
    const anchor = attachedAnchor(citation.before, citation.after)
    if (anchor === undefined) continue
    const content = contents.get(citation.path)
    if (content === undefined) continue
    const occurrences = countOccurrences(anchor, content)
    if (occurrences === 1) continue
    out.push({ citation, anchor, occurrences, lineCount: countLines(content) })
  }
  return out
}

/**
 * The baseline key for an anchor finding.
 *
 * `::anchor=` for {@link rowBaselineKey}'s reason, and the `#` refusal above is
 * what keeps this form readable back out of a flat file whose reader treats a
 * `#` as a comment.
 */
export function anchorBaselineKey(finding: AnchorFinding): string {
  return `${finding.citation.text}::anchor=${finding.anchor}`
}

/**
 * D1.317 — a POSITIVE CONTROL taken over a DIFFERENT scope than the probe it
 * vouches for. Such a control cannot fail, and nothing else in this file looks
 * for it.
 *
 * ## The one measured instance, in words
 *
 * Born 2026-09-18 from WI-am's re-run of D1.160. The `A43` cell of both ledgers
 * carries an absence probe — a counting `git grep` for three rule-resolution
 * names over two named source directories, answering 0 files — and beside it a
 * positive control on `unmatched_form` answering 3 files. Re-measured from the
 * index that day: the CONTROL answers **0** in the two directories the sentence
 * names and **3** over `packages apps`, because the file it points at lives
 * under the Pi harness, outside the pathspec the probe ran over. So the pair
 * READS like a zero with a working control and is a zero whose control is itself
 * zero. Positive control for that reading, prose and dated as a control must be
 * (AGENTS.md §Traps, W18-a): `SessionId` answers 4 files over the same two
 * directories on the same instrument, 2026-09-18 — the instrument reads there,
 * and the control's zero is the control's.
 *
 * ## Why it is worse than a wrong probe, and why no other arm can see it
 *
 * A wrong probe makes a number meaningless; a dead control makes a meaningless
 * number look VERIFIED, because the reader's whole reason to believe an absence
 * is the control beside it. {@link checkCountProbe} re-runs a DECLARED probe and
 * never the prose beside it, so the count arm is green on this cell today and
 * would be green on it whatever the control said.
 *
 * ## What is a subject, and what is declined
 *
 * A subject is one sentence carrying BOTH a backticked `git grep`/`grep` probe
 * whose pathspec is readable — from a `--` in the command, or from the prose
 * `over <paths>` that follows it, which is the form `A43` uses — AND, after it,
 * the words *positive control*. The control's own clause runs to the next `;`,
 * em dash, `‖` or bold marker OUTSIDE backticks; a terminator inside backticks
 * is part of a command, and reading one as the end of the clause is what hid the
 * `CODEX_HOME` control from the first draft of this arm (a pathspec's own double
 * star looked like a bold marker).
 *
 * Inside that clause exactly two shapes are DECIDED:
 *  - the control names a command of its own with a readable pathspec — then every
 *    one of its pathspecs must sit under one of the probe's. A control taken over
 *    a WIDER tree does not prove the probe's own scope was readable, which is the
 *    defect, so containment is one-sided on purpose.
 *  - the control declares a NON-ZERO count (an arrow and a number) and then names
 *    a file — then that file must sit under the probe's pathspec. The count is
 *    required because a file named with no count is prose about a file rather
 *    than the evidence of a reading, and the first draft without it charged a
 *    sentence saying which file a function WRITES. Zero is excluded because a
 *    control answering zero is a dead control for a different reason this tree
 *    already records by hand, and containment says nothing about it.
 *
 * Everything else is DECLINED and counted on the summary line, never a finding:
 * a control whose file is named before its count, a partial path the index
 * cannot resolve, an ambiguous basename, a control that is dated prose with no
 * count at all. The declined population is larger than the decided one and that
 * is the honest shape — this arm reads the two forms where the sentence itself
 * says enough to be wrong, and says so about the rest.
 *
 * ## The measurement, 2026-09-18 at HEAD `63717745f`
 *
 * 780 *positive control* spans across the five documents; 45 of them sit in a
 * sentence whose probe carries a readable pathspec; 19 of those are decided and
 * 26 declined; TWO are findings — the `A43` cell and its twin, one instance in
 * two documents — and 17 are controls correctly inside their probe's scope, which
 * is the negative arm existing in the tree rather than only in a test. A reading
 * with a date: the summary line prints all five numbers on every run, so re-run
 * it rather than quoting this paragraph. No refusal threshold, for the row and
 * symbol arms' reason: a rate over a population this size would be a rate over a
 * handful.
 */
export interface ProbeScope {
  /** The pathspec as the sentence spells it, quotes and magic included. */
  readonly pathspec: readonly string[]
  /** Where it was read from: the command's own `--`, or the prose after it. */
  readonly source: 'argv' | 'prose'
}

/**
 * The directory a pathspec roots, with git's magic and the shell's quoting off.
 *
 * Deliberately coarse: a `*.ts` restriction is dropped, so a control narrowed to
 * one extension inside the probe's tree reads as contained. That direction
 * under-reports and never invents a finding, which is the only safe way for a
 * guard whose subject is prose.
 */
export function pathspecRoot(pathspec: string): string {
  return pathspec
    .replace(/['"]/g, '')
    .replace(/^:\([^)]*\)/, '')
    .replace(/\*.*$/, '')
    .replace(/\/+$/, '')
}

/** Does `path` sit under any of these pathspecs? */
export function pathUnderPathspec(path: string, pathspec: readonly string[]): boolean {
  return pathspec.some(one => {
    const root = pathspecRoot(one)
    if (root === '' || root === '.') return true
    return path === root || path.startsWith(`${root}/`)
  })
}

/**
 * The scope a probe ran over: its own `--`, else the prose `over <paths>` that
 * follows the closing backtick.
 *
 * The prose form is not a convenience — it is the form the one measured instance
 * uses, and a rule reading only `--` would have found nothing at all.
 */
export function probeScope(
  command: string,
  after: string,
  roots: ReadonlySet<string>,
): ProbeScope | undefined {
  const separator = command.indexOf(' -- ')
  if (separator >= 0) {
    const pathspec = command.slice(separator + 4).trim().split(/\s+/).filter(part => part !== '')
    if (pathspec.length > 0) return { pathspec, source: 'argv' }
  }
  const prose = /^\s*(?:over|in|across|under)\s+(.*)$/.exec(after)
  if (prose === null) return undefined
  const pathspec: string[] = []
  // The LEADING run of path-shaped words only. The first word that is not one
  // ends the pathspec — `over packages apps for <pattern>` stops at `for`.
  for (const word of (prose[1] as string).split(/[\s,]+|\band\b|\+/)) {
    const token = word.replace(/['"`]/g, '').trim()
    if (token === '') continue
    const root = pathspecRoot(token)
    const head = root.includes('/') ? root.split('/')[0] as string : root
    if (head === '' || !roots.has(head)) break
    pathspec.push(token)
  }
  return pathspec.length > 0 ? { pathspec, source: 'prose' } : undefined
}

/** The control's own clause: to the next terminator OUTSIDE a backticked span. */
export function controlClause(sentence: string, from: number): string {
  let inBackticks = false
  for (let index = from; index < sentence.length; index += 1) {
    const character = sentence[index]
    if (character === '`') {
      inBackticks = !inBackticks
      continue
    }
    if (inBackticks) continue
    if (character === ';' || character === '\u2014' || character === '\u2016') {
      return sentence.slice(from, index)
    }
    if (character === '*' && sentence[index + 1] === '*') return sentence.slice(from, index)
  }
  return sentence.slice(from)
}

/** A control taken over a scope the probe beside it never ran over. */
export interface ControlScopeFinding {
  readonly doc: string
  readonly line: number
  readonly probe: string
  readonly probePathspec: readonly string[]
  readonly probeSource: 'argv' | 'prose'
  /** What the control names, as the sentence writes it. */
  readonly control: string
  /** `file` — a path it named; `command` — a pathspec of its own. */
  readonly kind: 'file' | 'command'
  /** The tracked path, or the control's own pathspec, that sits outside. */
  readonly outside: string
}

/** The population, so a run can say what it declined as well as what it found. */
export interface ControlScopeCensus {
  readonly findings: readonly ControlScopeFinding[]
  readonly subjects: number
  readonly contained: number
  readonly declined: number
}

const POSITIVE_CONTROL = /positive controls?\b/gi
/** An arrow and a number: the control stating what it read. */
const CONTROL_COUNT = /(?:\u2192|->)\s*(\d+)/
/** A path-shaped token, with the `:line` or `:line,line` tail these cells write. */
const CONTROL_FILE =
  /(?:[A-Za-z0-9_.\-]+\/)+[A-Za-z0-9_.\-]+(?::\d+(?:[-,]\d+)*)?|[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,5}(?::\d+(?:[-,]\d+)*)?/
const GREP_COMMAND = /^(?:git )?grep\s/

/** Every backticked span of a line, with the offsets its neighbours need. */
function backtickedSpans(line: string): { text: string; end: number }[] {
  const out: { text: string; end: number }[] = []
  for (const match of line.matchAll(/`([^`\n]{2,400})`/g)) {
    out.push({ text: match[1] as string, end: (match.index as number) + (match[0] as string).length })
  }
  return out
}

/** The sentence around an offset, by {@link SENTENCE_BREAK}. */
function sentenceAround(line: string, at: number): { from: number; to: number } {
  let from = 0
  for (let index = at - 1; index > 0; index -= 1) {
    if (SENTENCE_BREAK.test(line.slice(index - 1, index + 1))) {
      from = index + 1
      break
    }
  }
  let to = line.length
  for (let index = at; index < line.length - 1; index += 1) {
    if (SENTENCE_BREAK.test(line.slice(index, index + 2))) {
      to = index + 1
      break
    }
  }
  return { from, to }
}

/** What the index has to say about a name: the three lookups this arm needs. */
export interface RepoIndex {
  readonly tracked: ReadonlySet<string>
  readonly roots: ReadonlySet<string>
  readonly basenames: BasenameIndex
}

/** See this section's header for the rule, the two decided shapes and the rest. */
export function findControlScopeMismatches(
  doc: string,
  text: string,
  index: RepoIndex,
): ControlScopeCensus {
  const findings: ControlScopeFinding[] = []
  let subjects = 0
  let contained = 0
  let declined = 0
  for (const [offset, line] of text.split('\n').entries()) {
    for (const mention of line.matchAll(POSITIVE_CONTROL)) {
      const at = mention.index as number
      const { from, to } = sentenceAround(line, at)
      const sentence = line.slice(from, to)
      const relative = at - from
      const probes = backtickedSpans(sentence)
        .filter(span => span.end <= relative && GREP_COMMAND.test(span.text))
      const probe = probes[probes.length - 1]
      if (probe === undefined) continue
      const scope = probeScope(probe.text, sentence.slice(probe.end), index.roots)
      if (scope === undefined) continue
      subjects += 1
      const clause = controlClause(sentence, relative + (mention[0] as string).length)
      const record = (kind: 'file' | 'command', control: string, outside: string): void => {
        findings.push({
          doc,
          line: offset + 1,
          probe: probe.text,
          probePathspec: scope.pathspec,
          probeSource: scope.source,
          control,
          kind,
          outside,
        })
      }

      const own = backtickedSpans(clause).find(span => GREP_COMMAND.test(span.text))
      if (own !== undefined) {
        const ownScope = probeScope(own.text, clause.slice(own.end), index.roots)
        if (ownScope === undefined) {
          declined += 1
          continue
        }
        const outside = ownScope.pathspec.find(
          one => !pathUnderPathspec(pathspecRoot(one), scope.pathspec),
        )
        if (outside === undefined) contained += 1
        else record('command', own.text, outside)
        continue
      }

      const count = CONTROL_COUNT.exec(clause)
      if (count === null || Number(count[1]) === 0) {
        declined += 1
        continue
      }
      const named = CONTROL_FILE.exec(clause.slice((count.index as number) + (count[0] as string).length))
      if (named === null) {
        declined += 1
        continue
      }
      const token = named[0] as string
      const bare = token.replace(/:\d+(?:[-,]\d+)*$/, '')
      // A full path decides only when the INDEX has it; a bare name only when its
      // basename is unique, which the index marks `null` when it is not. Neither
      // is guessed at: an unresolvable name is declined, never charged.
      const resolved = bare.includes('/')
        ? (index.tracked.has(bare) ? bare : undefined)
        : (index.basenames.get(bare) ?? undefined)
      if (resolved === undefined) {
        declined += 1
        continue
      }
      if (pathUnderPathspec(resolved, scope.pathspec)) contained += 1
      else record('file', token, resolved)
    }
  }
  return { findings, subjects, contained, declined }
}

/**
 * The baseline key for a control-scope finding.
 *
 * `::control-scope=` for {@link rowBaselineKey}'s reason. Keyed by DOCUMENT
 * rather than by citation because the subject is a sentence, not a citation —
 * the cost is that two controls naming the same file in one document collapse to
 * one entry, which is the same collapse {@link splitRowIdBaselineKey} carries and
 * is written here rather than discovered later.
 */
export function controlScopeBaselineKey(finding: ControlScopeFinding): string {
  return `${finding.doc}::control-scope=${finding.outside}`
}

/**
 * P6.906 — the OPT-IN count check, built once its population stopped being zero.
 *
 * ## Why opt-in, and why it was not built when it was first asked for
 *
 * P6.898 measured the whole probe population and refused to build a general
 * check on it, for three reasons written into this file's header: the UNIT is in
 * the sentence and not in the command (a bare number may be files, lines, or the
 * sum of a `-c` run); a probe cannot tell a reader from a comment; and some
 * probes depend on the SHELL rather than on git. Its tightest mechanically
 * unambiguous slice mismatched on 13 of 19, three of them defects — the cry-wolf
 * shape AGENTS.md warns about.
 *
 * The honest form it named was a check on probes that OPT IN by DECLARING their
 * unit. P6.906 made that conditional on the population being non-empty, and
 * W9-bi measured it at **zero** on 2026-09-08. P6.905's own re-runs then
 * converted probes as they were checked, and the population is **62 declarations
 * at the time this landed** (a reading with a date — count it, do not quote it).
 *
 * ## What is checked, and what is deliberately not
 *
 * A declaration is `**files=N**` or `**lines=N**` within 40 characters after a
 * backticked span. It is RUN only when that span is a bare `git grep` with no
 * shell metacharacter and no pipe — `git grep` reads the working tree's tracked
 * files and needs no shell, so the command in the prose and the command that
 * runs are the same string. Everything else is counted and reported as DECLARED
 * BUT NOT RUNNABLE rather than guessed at: a plain `grep` with a `*.ts` glob
 * means one thing after shell expansion and another without it (AGENTS.md's own
 * trap), and a positive control written as a bare identifier is not a command at
 * all.
 *
 * The UNIT is checked even when the command is not run, because it needs no
 * child process and it is the failure P6.920 was born for: `files=` requires a
 * file-listing flag (`-l` in the bundle) and `lines=` forbids one. A `-c` probe
 * declaring `files=` is the exact defect that made several stated and re-run
 * numbers incomparable. D1.348 added the third arm, for the flag `-l` is not:
 * `lines=` also forbids a COUNTING flag wherever that flag prints one
 * `path:count` line per file — see {@link countsPerFile} for the one form it
 * does not, and for the population that made the narrowing necessary.
 *
 * ## The FLOOR form, added 2026-09-09 by P6.937
 *
 * `**lines>=N**` declares *at least N*, and only a reading BELOW N is a finding.
 * It exists because a `lines=` probe counts matches inside a LIVE source file:
 * that number moves with every commit to the file, while the sentence around it
 * almost never claims the exact value — it claims *non-zero, and here is what the
 * hits are*. One drifted 26 to 28 in a day (the case-insensitive `network` count
 * over the codex config writer, W9-br) and went red on a correct sentence, which
 * is the cry-wolf shape AGENTS.md warns about.
 *
 * Two carve-outs, both deliberate:
 *  - a declaration of ZERO keeps the equality. A floor of zero can never fail, so
 *    converting an ABSENCE claim to a floor deletes the check rather than
 *    softening it — and absence is the claim where the exact value IS the point.
 *    **This was PROSE ONLY until C4.51, and prose is not a carve-out**: `**files>=0**`
 *    parsed, produced a probe that could never be a finding, and nothing said so.
 *    {@link checkCountProbe} now REFUSES a zero floor by name.
 *  - `files=` was left alone. That carve-out read: *"A file count over a named
 *    pathspec is the shape this gate was built to hold: it moves when the SURFACE
 *    moves, which is the signal rather than the noise. The grammar accepts
 *    `files>=` because the operator is orthogonal to the unit; no document uses
 *    it, and P6.937 converted none."*
 *
 * ## C4.51 — `files>=N` is admitted for a PRESENCE claim (owner, 2026-09-13)
 *
 * The `files=` carve-out above is now NARROWED rather than removed, and the
 * narrowing is one sentence: a **presence** claim — *this key has a reader; here
 * is where* — may declare a floor; an **absence** claim keeps the equality, and
 * so does any claim whose sentence ENUMERATES the files it found, because there
 * the exact value is part of what is being said.
 *
 * What a floor buys that dated prose cannot: a presence claim written as prose is
 * never re-run, so the day the reader disappears the sentence silently becomes
 * false — the "assertion about another module with no guard" class this tree has
 * already paid a size-M plan row for (AGENTS.md §Traps, 2026-09-08, P6.551). A
 * floor keeps the re-run and fires on exactly the direction that falsifies the
 * claim. What it must NOT become is a softer default: W18-a's rule stands
 * unchanged for a CONTROL, whose job is to prove the probe can see rather than to
 * hold a value — a control written as `**files=401**` was answered 402 within
 * minutes by a sibling lane's commit (AGENTS.md §Traps, 2026-09-12). A control
 * stays dated prose. A claim may be declared.
 *
 * The floor is set to TODAY'S reading rather than to one: it absorbs growth, the
 * direction that made these declarations fragile, and still fires on
 * disappearance, the direction that falsifies the sentence.
 */
const COUNT_DECLARATION = /`([^`]{3,300})`[^`\n]{0,40}?\*\*(files|lines)(>?=)(\d+)\*\*/g

/**
 * A shell metacharacter makes the prose command and the run command different
 * things — **where the shell would act on it.**
 *
 * P6.933 made this quote-aware, and the reason is that the un-aware version was
 * refusing the wrong 26. Measured at HEAD before the change: of 26 declarations
 * carried as "unit-checked only", **sixteen distinct commands, and twelve of the
 * sixteen were refused for a character INSIDE single quotes** — eleven of them a
 * `:(glob)` pathspec, whose parentheses are literal to every shell, and one an
 * escaped dot in a pattern. The row that asked for this widening named the
 * ALTERNATION pattern (`\|`) as the class; the alternation and the glob pathspec
 * are the same defect seen twice, because both are quoted.
 *
 * The rule is the shell's own, and no wider: inside a SINGLE-quoted span nothing
 * is special; inside a DOUBLE-quoted span `$`, a backtick and a backslash still
 * are; outside quotes everything in the set is. See {@link unquotedShellMetachar}.
 */
const SHELL_METACHAR = /[;&|<>$(){}\\]/

/**
 * Characters the SHELL expands that `git` does not — the pathspec trap in
 * AGENTS.md §Traps, where a double-star path pattern under `packages/shared/src`
 * handed to `git grep` matched 24 files where the same pattern with a `:(glob)`
 * prefix matched 25, with no error and no warning. (The pattern is written out
 * in words rather than quoted: a star followed by a slash inside a block comment
 * CLOSES it — AGENTS.md §Traps, paid three times in this tree already.)
 *
 * Added by the same pass that widened the quoting rule, because a widening that
 * lets more commands run must not let a command run whose prose form and run
 * form differ. Measured over all 73 declarations at HEAD: exactly ONE carries an
 * unquoted glob, and it is refused for other reasons too, so this tightening
 * costs nothing today and closes the hole prospectively.
 */
const SHELL_GLOB = /[*?[]/

/**
 * Is there a metacharacter the SHELL would act on, outside quotes?
 *
 * Returns `true` for a command whose prose form and run form could differ.
 * Unbalanced quoting is NOT decided here — {@link splitProbeArgv} reports it by
 * name a moment later, and returning `true` for it would replace a precise
 * message with a vague one.
 */
export function unquotedShellMetachar(command: string): boolean {
  let quote: "'" | '"' | undefined
  for (const character of command) {
    if (quote === undefined) {
      if (character === "'" || character === '"') {
        quote = character
        continue
      }
      if (SHELL_METACHAR.test(character) || SHELL_GLOB.test(character)) return true
      continue
    }
    if (character === quote) {
      quote = undefined
      continue
    }
    // Inside single quotes nothing is special. Inside double quotes three
    // characters still are, and a probe has no business carrying any of them.
    if (quote === '"' && (character === '$' || character === '`' || character === '\\')) return true
  }
  return false
}

export interface CountProbe {
  readonly doc: string
  readonly line: number
  readonly command: string
  readonly unit: 'files' | 'lines'
  /** A `>=` declaration: `declared` is a FLOOR, not an equality. */
  readonly floor: boolean
  readonly declared: number
}

export type CountVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unit-mismatch'; readonly why: string }
  /**
   * C4.51 — a `>=0` declaration, which is a check that can never fail.
   *
   * Its own kind rather than a `unit-mismatch`: the unit is fine, the
   * DECLARATION is the defect, and a reader told "unit mismatch" would go
   * looking for a missing `-l`. It is a finding rather than a `not-runnable`
   * because nothing about it depends on running.
   */
  | { readonly kind: 'zero-floor'; readonly why: string }
  | { readonly kind: 'not-runnable'; readonly why: string }
  | { readonly kind: 'count'; readonly actual: number }

/** Every `**files=N**` / `**lines=N**` / `**lines>=N**` declaration, with its command. */
export function collectCountProbes(doc: string, text: string): CountProbe[] {
  const out: CountProbe[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(COUNT_DECLARATION)) {
      out.push({
        doc,
        line: index + 1,
        command: (match[1] as string).trim(),
        unit: match[2] as 'files' | 'lines',
        floor: match[3] === '>=',
        declared: Number(match[4]),
      })
    }
  }
  return out
}

/**
 * Is a re-run reading a FINDING for this declaration?
 *
 * Exact for `=`, one-sided for `>=`. Its own function so the rule is testable
 * without a child process, and so the two callers — the filter that makes a
 * finding and the message that explains it — cannot drift apart.
 */
export function countIsWrong(probe: CountProbe, actual: number): boolean {
  return probe.floor ? actual < probe.declared : actual !== probe.declared
}

/**
 * Does the command's flag bundle ask git for FILE NAMES?
 *
 * Only the short-flag forms occur in these documents and only they are accepted:
 * a long `--files-with-matches` would read as no `-l` here, which is why this
 * returns the reason rather than a boolean the caller can misread.
 */
export function listsFileNames(command: string): boolean {
  return /(^|\s)-[A-Za-z]*l[A-Za-z]*(\s|$)/.test(command) || command.includes('--files-with-matches')
}

/**
 * Does the command COUNT — and if it does, does it print one `path:count` line
 * per FILE rather than one bare number?
 *
 * D1.348, and it is the other half of {@link listsFileNames}. `-l` is not the
 * only flag that changes what an output LINE means: `-c` does too, and it does it
 * in the opposite direction. Measured 2026-09-18 on one needle, same tree, same
 * minute — `git grep -ain -e inlineComment -e lineComment -e diffComment --
 * packages apps` prints **71** lines, `-acin` prints **7**, and `-alin` prints
 * the same **7**, because the counting form emits one `path:count` line per file
 * and the runner below counts the lines it printed. So a `lines=` declaration
 * beside a counting `git grep` states matches and measures files, which is
 * P6.920's defect with the flags swapped.
 *
 * BUT NOT EVERY `-c` PRINTS PER FILE, and this is why the row's rule ("treat a
 * counting flag as a unit mismatch for `lines=`") is NARROWED here rather than
 * taken verbatim. A plain `grep -c <pattern> <one literal path>` prints a bare
 * number, which IS the line count, and {@link parseGrepCountProbe} is exactly
 * that form — `checkCountProbe` reads the number it prints instead of counting
 * lines. THE POPULATION SAYS SO: of the 94 declarations in the five documents on
 * 2026-09-18, THREE carry a counting flag, all three sit on one line of
 * `2026-08-22-codex-coverage-map.md`, and all three are that single-path form
 * (`grep -ac 'network_access =' …`, `grep -ac 'sandbox_mode = ' …`,
 * `grep -a -c -i network …`, answering 0, 3 and 30 — bare numbers, no `path:`
 * prefix). The verbatim rule would therefore have produced THREE false findings
 * and ZERO true ones on the day it landed, which is AGENTS.md's own "a rule that
 * cries wolf is a rule people stop running".
 *
 * The instance that BORE the row is already repaired: H14's probe was re-spelled
 * by D1.337 to `git grep -ain -e … -- packages apps` **lines=71**, dropping the
 * `-c`. So this arm ships with an empty population on purpose — it is a ratchet
 * against the next `git grep -c … **lines=N**`, not a sweep.
 *
 * NOT EXTENDED to `files=` beside a counting flag, deliberately and with the
 * same reasoning: such a probe would be numerically RIGHT (its output lines are
 * files) and the existing `files=`-without-`-l` arm calls it a mismatch with a
 * message that says "its output is lines". Population today: ZERO. A rule with
 * no population can only misfire, so the message is left as it is and this
 * sentence is the record of the measurement.
 */
export function countsPerFile(command: string): boolean {
  if (!/(^|\s)-[A-Za-z]*c[A-Za-z]*(\s|$)/.test(command) && !command.includes('--count')) return false
  // A metacharacter means the prose command is not the run command, which the
  // `not-runnable` arm below already says; claiming a unit for it would be
  // guessing at a command nobody runs.
  if (unquotedShellMetachar(command)) return false
  // `git grep -c` ALWAYS prefixes the path — there is no single-file form of it
  // that prints a bare number, because a pathspec is not a file argument.
  if (command.startsWith('git grep ')) return true
  if (!command.startsWith('grep ')) return false
  const argv = splitProbeArgv(command)
  // Unparseable is not evidence of a unit. Leave it to `not-runnable`.
  if (argv === undefined) return false
  return parseGrepCountProbe(argv) === undefined
}

/**
 * A plain `grep -c <pattern> <one literal path>`, split into its parts.
 *
 * The SECOND widening of P6.933, and the narrow shape is the point. Only a
 * counting grep over exactly ONE literal path is accepted: no `-r`, no glob, no
 * second file, no `-l`. Everything else stays unit-checked, because the moment a
 * probe names more than one file its printed output stops being a bare number
 * and starts being `path:count` lines — which is the very unit confusion P6.920
 * was born for.
 */
export interface GrepFileProbe {
  readonly flags: readonly string[]
  readonly pattern: string
  readonly path: string
}

/**
 * The flag bundles accepted for a counting grep.
 *
 * `a` (read a NUL-carrying file as text — AGENTS.md §Traps), `c` (count) and `i`
 * (case-insensitive) only, in any order and in any number of bundles. `-l` is
 * excluded here as well as by {@link listsFileNames}: a `-lc` bundle prints file
 * names, not a count.
 */
const GREP_COUNT_FLAG_BUNDLE = /^-[aci]+$/

export function parseGrepCountProbe(argv: readonly string[]): GrepFileProbe | undefined {
  const flags: string[] = []
  let index = 0
  while (index < argv.length && (argv[index] as string).startsWith('-')) {
    const bundle = argv[index] as string
    if (!GREP_COUNT_FLAG_BUNDLE.test(bundle)) return undefined
    flags.push(bundle)
    index += 1
  }
  if (!flags.some(bundle => bundle.includes('c'))) return undefined
  if (argv.length - index !== 2) return undefined
  const pattern = argv[index] as string
  const path = argv[index + 1] as string
  if (path === '' || path.startsWith('-') || !path.includes('/')) return undefined
  return { flags, pattern, path }
}

/** Run one declared probe, or say why it was not run. */
export function checkCountProbe(
  probe: CountProbe,
  run: (argv: readonly string[]) => string,
  /**
   * Count matching lines of ONE indexed file with the same `grep` the prose
   * names, or `undefined` when the path is not in the index.
   *
   * REQUIRED rather than optional on purpose: an optional runner that a caller
   * forgets is a dead control — every `grep` probe would quietly fall back to
   * "unit-checked only" and the summary line would still read as a full pass.
   */
  runGrepOnIndex: (probe: GrepFileProbe) => number | undefined,
): CountVerdict {
  // C4.51 — the zero-floor refusal, and it is checked FIRST because it needs
  // nothing: no flags, no argv, no child process. `**files>=0**` / `**lines>=0**`
  // parses under the same grammar as every other declaration and produces a
  // probe `countIsWrong` can never call wrong (`actual < 0` is unreachable for a
  // count), so it reads as a check and is not one. The docblock above has said
  // since P6.937 that a zero keeps the equality; until this line that was PROSE,
  // enforced by nobody, and the shape it was written against would have silently
  // deleted an absence check.
  if (probe.floor && probe.declared === 0) {
    return {
      kind: 'zero-floor',
      why: 'declares a floor of ZERO, which no reading can fall below — an absence claim must be declared as'
        + ' an equality (`' + probe.unit + '=0`), which is the direction that can actually fire',
    }
  }
  const lists = listsFileNames(probe.command)
  if (probe.unit === 'files' && !lists) {
    return {
      kind: 'unit-mismatch',
      why: 'declares `files=` but the command carries no file-listing flag, so its output is lines (P6.920)',
    }
  }
  if (probe.unit === 'lines' && lists) {
    return {
      kind: 'unit-mismatch',
      why: 'declares `lines=` but the command carries `-l`, so its output is one line per FILE (P6.920)',
    }
  }
  // D1.348 — the same confusion with the flags swapped. `-c` also makes an
  // output line a FILE, everywhere except the one form that prints a bare
  // number, and {@link countsPerFile} is where that narrowing and its measured
  // population live. The message names BOTH repairs because neither is obviously
  // the right one: the probe's author knows whether they wanted matches or files.
  if (probe.unit === 'lines' && countsPerFile(probe.command)) {
    return {
      kind: 'unit-mismatch',
      why: 'declares `lines=` but the command COUNTS, so it prints one `path:count` line per FILE and not'
        + ' one per match (D1.348) — drop the `-c` to keep `lines=`, or swap it for `-l` and declare `files=`',
    }
  }
  const isGitGrep = probe.command.startsWith('git grep ')
  const isGrep = !isGitGrep && probe.command.startsWith('grep ')
  if (!isGitGrep && !isGrep) {
    return { kind: 'not-runnable', why: 'neither `git grep` nor `grep` — the unit is checked, the count is not' }
  }
  if (unquotedShellMetachar(probe.command)) {
    return { kind: 'not-runnable', why: 'carries a shell metacharacter outside quotes, so the prose command is not the run command' }
  }
  const argv = splitProbeArgv(probe.command)
  if (argv === undefined) return { kind: 'not-runnable', why: 'unbalanced quoting' }
  if (isGrep) {
    const parsed = parseGrepCountProbe(argv)
    if (parsed === undefined) {
      return { kind: 'not-runnable', why: 'not a `grep -c <pattern> <one literal path>` — the unit is checked, the count is not' }
    }
    const actual = runGrepOnIndex(parsed)
    if (actual === undefined) {
      return { kind: 'not-runnable', why: `\`${parsed.path}\` is not in the index, so there is nothing to count` }
    }
    // The number `grep -c` PRINTS, never the number of lines it printed. A
    // counting grep emits exactly one line whichever way it ends, so a runner
    // that measures output lines answers 1 for every such probe and never the
    // count — four of one sweep's forty-five "stated 0, now non-zero"
    // refutations were that artefact (AGENTS.md §Traps, 2026-09-08).
    return { kind: 'count', actual }
  }
  const output = run(argv)
  return { kind: 'count', actual: output.split('\n').filter(part => part !== '').length }
}

/**
 * D1.337 — a DECLARED probe whose `-E`/`-P` command spells its alternation
 * `\|`, which under those engines matches a LITERAL pipe.
 *
 * ## The defect
 *
 * `\|` is an alternation in git grep's DEFAULT basic regex and an escaped —
 * that is, literal — pipe under `-E` (POSIX extended) and `-P` (PCRE). So
 * `git grep -aiE 'a\|b'` searches for the one string with a pipe in the middle
 * of it, which nothing spells, and answers 0. The zero is real, it reproduces,
 * and it says nothing whatever about `a` or about `b` — which is the opposite of
 * what the sentence beside it claims.
 *
 * ## Why it belongs HERE and not to the next reader's eye
 *
 * Every probe this arm reads is one {@link checkCountProbe} RE-RUNS. The gate
 * therefore runs the impossible command, agrees with the declared zero and
 * prints the declaration as checked: a wrong number that a green gate vouches
 * for, which is the shape this whole file exists to end. No other arm can see
 * it — the count arm compares a reading against a declaration, and here both are
 * the same wrong number.
 *
 * ## The population, measured when the arm landed (2026-09-18, a reading with a
 * date — the summary line prints today's)
 *
 * ELEVEN declared spans over SIX distinct commands, every one declaring ZERO,
 * all of them in the two twin specs and none in the plan. Four of the six answer
 * 28 files / 3 lines / 6 lines / 71 lines once the alternation is real; two
 * answer zero either way, so those two cells' verdicts stand while their
 * commands still cannot fail. D1.337 was born expecting ONE instance — the
 * instrument found the other ten, which is why this is an arm and not a sentence
 * in a report.
 *
 * ## What it deliberately does NOT decide
 *
 * A pattern that really means a literal pipe is spelled exactly this way under
 * `-E`, and nothing in the argv tells the two apart. Such a probe is baselined
 * with the reason beside the entry, like every other arm's deliberate case.
 * `-F`/`--fixed-strings`, where the same two characters are a backslash AND a
 * pipe, is a different defect and is out of scope — measured rather than
 * assumed, because the first draft of this sentence asserted the population
 * without reading it and was wrong: SEVEN declarations carry `-F` today, and
 * NONE of the seven carries these two characters (2026-09-18, over 107
 * declarations; every one of the seven searches a single identifier or env
 * name). A rule with no population can only misfire, so the day one of them
 * grows an escaped pipe is the day to widen this.
 *
 * It is also NOT gated on {@link unquotedShellMetachar} or on the unit checks,
 * unlike the re-run itself. A probe refused for a pipe or a glob is only
 * unit-checked, and letting one defect hide behind another is how a class
 * survives a gate.
 */
export interface EscapedAlternationFinding {
  readonly doc: string
  readonly line: number
  readonly command: string
  /** The argv element carrying the escaped pipe, as the command spells it. */
  readonly pattern: string
  /** The flag that selected the engine, as written: `-aiE`, `-E`, `--perl-regexp`. */
  readonly flag: string
}

/** The two characters, written once so no caller spells them a second time. */
const ESCAPED_PIPE = '\\|'

/**
 * Which regex engine a flag selects, or `undefined` when it selects none.
 *
 * `plain` is every engine this arm does NOT charge — `-G`/`--basic-regexp`,
 * where the escaped pipe IS the alternation and the command is correct, and
 * `-F`/`--fixed-strings`, where it is two literal characters and the defect is a
 * different one (see the header). Returning a value for them rather than
 * `undefined` is what makes LAST-WINS work: git and grep both take the last
 * engine flag on the line, so `-E … -G` is a basic-regex command and charging it
 * would be a misfire nobody could explain.
 */
function regexEngineOf(token: string): 'extended' | 'plain' | undefined {
  if (token === '--extended-regexp' || token === '--perl-regexp') return 'extended'
  if (token === '--basic-regexp' || token === '--fixed-strings') return 'plain'
  if (!/^-[A-Za-z]+$/.test(token)) return undefined
  if (token.includes('E') || token.includes('P')) return 'extended'
  if (token.includes('G') || token.includes('F')) return 'plain'
  return undefined
}

/**
 * The predicate, over the command STRING so it is testable without a probe.
 *
 * It reuses {@link splitProbeArgv} rather than reading the string, for the
 * reason that function exists: the pattern is what survives quoting, and a
 * regex over the prose would charge a pathspec, a comment, or the sentence
 * around the command. Unbalanced quoting returns `undefined` here and is
 * reported by name by the count arm a moment later.
 *
 * Only operands BEFORE `--` are considered: after the separator every token is
 * a pathspec, and a pathspec carrying these two characters is not this defect.
 */
export function escapedAlternationInCommand(
  command: string,
): { readonly pattern: string; readonly flag: string } | undefined {
  const isGitGrep = command.startsWith('git grep ')
  if (!isGitGrep && !command.startsWith('grep ')) return undefined
  const argv = splitProbeArgv(command)
  if (argv === undefined) return undefined
  // `splitProbeArgv` drops the FIRST word, so a `git grep` command still carries
  // its own `grep` in front of the flags and a plain `grep` does not.
  const tokens = isGitGrep ? argv.slice(1) : argv
  let engine: 'extended' | 'plain' | undefined
  let flag: string | undefined
  const operands: string[] = []
  for (const token of tokens) {
    if (token === '--') break
    if (token.startsWith('-') && token.length > 1) {
      const selected = regexEngineOf(token)
      if (selected !== undefined) {
        engine = selected
        flag = token
      }
      continue
    }
    operands.push(token)
  }
  if (engine !== 'extended' || flag === undefined) return undefined
  const pattern = operands.find(operand => operand.includes(ESCAPED_PIPE))
  return pattern === undefined ? undefined : { pattern, flag }
}

/** Every declared probe whose command carries the defect above. */
export function findEscapedAlternationProbes(
  probes: readonly CountProbe[],
): EscapedAlternationFinding[] {
  const out: EscapedAlternationFinding[] = []
  for (const probe of probes) {
    const found = escapedAlternationInCommand(probe.command)
    if (found === undefined) continue
    out.push({
      doc: probe.doc,
      line: probe.line,
      command: probe.command,
      pattern: found.pattern,
      flag: found.flag,
    })
  }
  return out
}

/**
 * Keyed by DOCUMENT and COMMAND, never by line.
 *
 * `::escaped-alternation=` for {@link rowBaselineKey}'s reason. The subject is a
 * command, not a citation, so there is nothing cited to key it on — and the line
 * is the one part that moves on every pinning commit while the command is
 * exactly what a repair changes. The twin documents therefore contribute one
 * entry each for the same command, which is the collapse
 * {@link controlScopeBaselineKey} carries in the other direction and is written
 * here rather than discovered later. One limit of the register's own format: a
 * command containing `#` would have its key truncated by the comment rule in
 * {@link readBaseline} and could not be baselined at all (0 of 107 declarations
 * carry one today).
 */
export function escapedAlternationBaselineKey(finding: EscapedAlternationFinding): string {
  return `${finding.doc}::escaped-alternation=${finding.command}`
}

/**
 * Split a probe into argv the way a shell would for the SUBSET this accepts —
 * quotes only, no escapes, no metacharacters (all refused above).
 *
 * Written rather than shelled out on purpose: handing the string to `sh -c`
 * would re-introduce the shell whose absence is what makes the prose command and
 * the run command the same thing.
 *
 * BOTH quote characters, and the first version handled only the single one. That
 * was not a hypothetical: a real declaration writes its pattern as a
 * single-quoted string inside a double-quoted one, and stripping only the inner
 * pair left the OUTER quotes in the pattern — so the probe searched for a token
 * with quote marks in it, answered 0, and the gate reported a correct sentence as
 * wrong on the day it landed. The two are handled the same way because inside a
 * backticked span there is nothing for a double quote to expand: `$`, a
 * backslash and every other metacharacter are refused before this runs.
 */
export function splitProbeArgv(command: string): string[] | undefined {
  const argv: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let started = false
  for (const character of command) {
    if (quote === undefined && (character === "'" || character === '\"')) {
      quote = character
      started = true
      continue
    }
    if (character === quote) {
      quote = undefined
      started = true
      continue
    }
    if (character === ' ' && quote === undefined) {
      if (started) argv.push(current)
      current = ''
      started = false
      continue
    }
    current += character
    started = true
  }
  if (quote !== undefined) return undefined
  if (started) argv.push(current)
  return argv.slice(1)
}

/**
 * Run one probe's `git grep` AGAINST THE INDEX, treating NO MATCH as the answer
 * it is.
 *
 * **`--cached`, and it was not there until P6.933 measured what its absence
 * costs.** `git grep` with no commit reads the WORKING TREE, so in a tree six
 * lanes are writing, a declaration is measured against whatever a neighbour has
 * half-finished. Caught live 2026-09-09 while this widening was being built:
 * `git grep -ail RRULE -- packages apps` was declared **39**, and the gate
 * answered **41**, then **42** two minutes later, red on a sentence that is
 * correct — the three extra files were a sibling lane's uncommitted edits to
 * `SessionManager.ts` and two of its neighbours. Against the index and against
 * HEAD the same command answers 39. It is the trap AGENTS.md §Traps records for
 * derived ledgers ("`--update` reads the sibling lanes' uncommitted edits"),
 * arriving on the count check, and the line check above had already avoided it
 * by reading blobs from the index. Adding it flipped **no** declaration: with
 * the tree clean the two readings are the same, and the difference is entirely
 * the neighbours. Measured over all 73 declarations on the same tree: it flipped
 * **no** declaration from right to wrong, and turned the RRULE pair from wrong
 * back to right. A declaration that already writes `--cached` in its prose is
 * unaffected — git accepts the flag twice (measured: the same command with one
 * and with two answers 31 either way).
 *
 * `git grep` exits **1** when nothing matched, and `execFileSync` throws on any
 * non-zero status — so the first version of this check died on the very first
 * probe declaring `files=0`, which is the most common shape in these documents
 * (a negative control with a live positive control beside it). Exit 1 with empty
 * stdout is a measurement, not a failure. Anything else — a bad pathspec, a
 * broken regex, git not being there — is left to throw, because a probe that
 * cannot run must not be silently counted as zero: that is the dead-control
 * shape this whole gate exists to catch.
 */
export function withCachedFlag(argv: readonly string[]): string[] {
  return [argv[0] as string, '--cached', ...argv.slice(1)]
}

function runGitGrep(argv: readonly string[]): string {
  try {
    return execFileSync('git', withCachedFlag(argv), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString()
  } catch (error) {
    const status = (error as { status?: number }).status
    const stdout = String((error as { stdout?: unknown }).stdout ?? '')
    if (status === 1 && stdout === '') return ''
    throw error
  }
}

/**
 * Count matching lines of ONE indexed file, with the same `grep` the prose names.
 *
 * The FIRST widening of P6.933, and the two choices in it are the row's own.
 *
 * **From the INDEX, not the working tree** — exactly as the line check above
 * already does, and for the same measured reason: sibling lanes hold uncommitted
 * edits to cited files all day, and a count read from the tree measures the
 * neighbours (AGENTS.md §Traps). The blob is fed to `grep` on **stdin**, which
 * also settles the hang: a `-c` with no file argument reads stdin and never
 * returns, so here stdin is always closed by being written and ended.
 *
 * **The real `grep`, not a re-implementation.** Translating the prose command's
 * BRE dialect into a JavaScript `RegExp` would mean deciding by hand that `\|`
 * is alternation while a bare `|` is a literal — and getting that wrong yields a
 * plausible wrong number, which is the failure mode this whole gate exists to
 * end. Shelling out to `grep` with the pattern as a single argv element runs the
 * same program the sentence names, with no shell between.
 */
function runGrepOnIndexBlob(probe: GrepFileProbe, content: string): number {
  let printed: string
  try {
    printed = execFileSync('grep', [...probe.flags, probe.pattern], {
      cwd: REPO_ROOT,
      input: content,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).toString()
  } catch (error) {
    const status = (error as { status?: number }).status
    const stdout = String((error as { stdout?: unknown }).stdout ?? '')
    // Exit 1 is "no match", and it prints `0`. Anything else — a bad regex, no
    // grep — is left to throw, because a probe that cannot run must not be
    // silently counted as zero.
    if (status !== 1) throw error
    printed = stdout
  }
  const value = Number(printed.trim())
  if (!Number.isInteger(value)) {
    throw new GateSafetyRefusal(
      `REFUSED: \`grep ${probe.flags.join(' ')}\` printed ${JSON.stringify(printed.slice(0, 40))} rather than a `
      + 'count — the counting path is broken, so every such probe would read as checked and none would be.',
    )
  }
  return value
}

/**
 * The content of each path AS THE INDEX HOLDS IT, in one child process.
 *
 * `git cat-file --batch` does not echo a request that resolves — only a missing
 * one does — so records are matched to requests BY ORDER, which is the order
 * git emits them in. A missing entry is skipped rather than reported: its path
 * is `git ls-files`-tracked by the time we ask, so a miss here is a race with a
 * neighbour's commit, not a finding.
 */
export function readIndexBlobs(paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (paths.length === 0) return out
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd: REPO_ROOT,
    input: `${paths.map(path => `:${path}`).join('\n')}\n`,
    maxBuffer: 512 * 1024 * 1024,
  })
  let cursor = 0
  let request = 0
  while (cursor < batch.length && request < paths.length) {
    const newline = batch.indexOf(10, cursor)
    if (newline < 0) break
    const header = batch.toString('utf-8', cursor, newline)
    const path = paths[request] as string
    request += 1
    if (header.endsWith(' missing')) {
      cursor = newline + 1
      continue
    }
    const size = Number(header.slice(header.lastIndexOf(' ') + 1))
    if (!Number.isFinite(size)) break
    out.set(path, batch.toString('utf-8', newline + 1, newline + 1 + size))
    cursor = newline + 1 + size + 1
  }
  return out
}

export function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  return out.split('\0').filter(file => file !== '')
}

export function readBaseline(): Set<string> {
  const file = join(REPO_ROOT, BASELINE_FILE)
  if (!existsSync(file)) return new Set()
  return new Set(
    readFileSync(file, 'utf-8')
      .split('\n')
      .map(line => line.replace(/#.*$/, '').trim())
      .filter(line => line !== ''),
  )
}

/**
 * Rewrite the baseline WITHOUT losing what a human wrote in it.
 *
 * Every comment line and every blank line survives verbatim, and an entry keeps
 * its inline `# reason`. Entries that are no longer findings are dropped, which
 * is the point of regenerating; new ones are appended under a dated heading so
 * the next reader can see which pass added them. The previous version composed
 * the whole file from the finding list, so the first `--update-baseline` after
 * a reason was written would have deleted every reason in the register.
 */
export function writeBaseline(entries: readonly string[]): { added: number; dropped: number } {
  const file = join(REPO_ROOT, BASELINE_FILE)
  const existing = existsSync(file) ? readFileSync(file, 'utf-8').split('\n') : []
  const wanted = new Set(entries)
  const kept: string[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const line of existing) {
    const entry = line.replace(/#.*$/, '').trim()
    if (entry === '') {
      kept.push(line)
      continue
    }
    if (!wanted.has(entry)) {
      dropped += 1
      continue
    }
    kept.push(line)
    seen.add(entry)
  }
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop()
  const added = entries.filter(entry => !seen.has(entry))
  if (added.length > 0) {
    kept.push('', `# recorded ${new Date().toISOString().slice(0, 10)}`, ...added)
  }
  writeFileSync(file, `${kept.join('\n')}\n`, 'utf-8')
  return { added: added.length, dropped }
}

/**
 * P6.954 — THE PLAN RATCHET, and the one thing the baseline cannot say by itself.
 *
 * ## Why this member needs a number and the other three do not
 *
 * A finding in one of the three specs has an owner: whichever ledger lane meets
 * it repairs it, in zone, and three sittings in a row have opened by doing
 * exactly that. A finding in the PLAN has none — the plan is the controller's
 * file and read-only for every lane — so the class only accumulates, in the
 * document edited more than any other in this tree and swept by nobody.
 * {@link LEDGERS}'s own header records what admitting it cost; this is the
 * instrument that keeps the cost visible afterwards.
 *
 * ## What it catches that `--check` cannot
 *
 * `--check` goes red on a FRESH finding only, so the debt becomes invisible the
 * moment it is written down: `--update-baseline` absorbs every new plan finding
 * at once, and the next run is green with more debt than the run before it.
 * Nothing else in this file can see that happen. This is also the only part of
 * the gate whose subject is a NUMBER rather than an anchor, which is why it is a
 * pinned constant and not another finding kind.
 *
 * ## What is counted
 *
 * DISTINCT BASELINE KEYS whose citation was read from {@link PLAN_DOC} — the
 * same strings {@link writeBaseline} records, in the same four forms (a path, a
 * whole `path:line` citation, `citation::identifier`, `citation::row=id`), so
 * the pin and the register move together and a repaired anchor takes one off
 * both. Occurrences are printed beside the keys and deliberately NOT ratcheted,
 * with the residue stated rather than hidden: a second cell citing an
 * ALREADY-dead path adds an occurrence and no key, and this pin cannot see it.
 * Ratcheting both would make a duplicated citation a second red for one defect.
 *
 * The count-declaration arm is outside the census on purpose: a wrong declared
 * count has no baseline key at all and is red on every run, so it can never be
 * absorbed and needs no ratchet.
 *
 * ## The direction
 *
 * A FALL is the intended direction — the run prints the new number and asks for
 * {@link PINNED_PLAN_FINDINGS} to be lowered in the same commit that repaired
 * the citations.
 *
 * **But a fall is not always a repair, and lowering the pin on the wrong one
 * manufactures a future red.** This census moves in BOTH directions with any
 * commit to a cited FILE, because a source commit can blank one anchor while
 * un-blanking another. Measured the day this landed (2026-09-09): a sibling
 * lane's `296de50a9` moved two heavily-cited files and the plan census fell
 * 126 → 123 while gaining FOUR new findings — a fall that was not a repair and
 * carried more defects than the number before it. So lower the pin only for
 * citations the commit in front of you actually repaired; a fall you did not
 * cause is a reading, not an instruction. A RISE is a failure, and raising the pin to make a red run
 * green is the one move this constant exists to prevent. The exception belongs
 * to the controller rather than to a lane: a plan finding that is deliberately
 * NOT a defect — the baseline's own kinds are a cell whose FINDING is that the
 * path does not exist, a generated build artefact, and another repository's doc
 * path written without its host prefix — is baselined with the reason beside the
 * entry, and the pin rises in the same commit that writes that reason.
 *
 * The constant below is the only place the number lives. The sixth summary line
 * prints today's on every run, so re-derive it rather than quoting a sentence
 * about it — this tree has watched every other census number in it move twice in
 * an afternoon.
 *
 * Lowered 124 → 121 by UB12.76 (2026-10-17), from a key-by-key diff rather than from
 * the FELL line. The census was re-run at `8fdf0dd19`, the commit that set 124, and
 * compared with HEAD before this repair (121). Six keys had left since then, for two
 * different reasons:
 * - UB12.16 (`cade3e4f4`) repaired three of them: the two options.ts keys now cited as
 *   `applySubagentSpawnDepth`, and the unified-network-interceptor.ts key now cited as
 *   `getClientTlsIdentity`. UB12.16 did not lower the pin for them, so this commit takes
 *   those three off.
 * - Line shifts made the other three non-blank again: the line keys for
 *   CapabilityDetailTemplate.tsx (183), resolver.ts (741) and interceptor-common.ts (153
 *   to 155). Their cells still cite the old line, so each one can go blank again. They
 *   are the three of headroom this pin keeps.
 *
 * Three keys had also arrived: preload bootstrap.ts (138), InputSettingsPage.tsx (44 to
 * 56) and the claude event-adapter.ts (652 to 653). This commit cites each of them by
 * symbol. They were never part of the 124 that was pinned, so repairing them does not
 * lower the pin. The live census now reads 118.
 *
 * Lowered 121 → 118 by UB12.109 (2026-10-17), which takes off the three of headroom
 * above. Each cell now names what its sentence meant, and the three baseline entries
 * left in the same commit: P3.218 cites the template's `unavailableReasonText`, and
 * P6.513 cites resolver.ts's `RuntimeOutputStyleDefinition`. P6.162 names
 * `is1MContextEnabled` in words, because F1.1241 (`b35591a2e`) removed that function,
 * so the symbol form would be an absent-symbol finding.
 *
 * The live census reads 118 before and after this commit, so it equals the new pin. That
 * is a coincidence of two moves. A key diff against UB12.76's `9c101e50f`, where the
 * census also read 118, shows one key left and one arrived:
 * - Left: line shifts in format-adapters/claude.ts made its 415 to 420 key non-blank
 *   again. The plan and both specs still cite it by line, so it is the one key of
 *   headroom inside this pin. A commit that re-cites it may lower the pin by one.
 * - Arrived: the claude coverage map's line 378 key, blanked when UB12.95
 *   (`ef204812c`) inserted rows into that map. It came after the pin was set, so
 *   repairing it does not lower the pin.
 */
export const PINNED_PLAN_FINDINGS = 118

export interface PlanCensus {
  /** Distinct baseline keys, sorted — the number {@link ratchetVerdict} compares. */
  readonly keys: readonly string[]
  /** Findings before de-duplication. Printed, never ratcheted; see the header. */
  readonly occurrences: number
}

/**
 * The finding kinds that have a baseline key, as {@link main} computes them.
 *
 * Deliberately NOT numbered in this sentence: it said "the four" while carrying
 * five members, and C3.325 made it six — a count beside a list the compiler
 * already keeps true is a second source of truth that only ever goes stale.
 */
export interface PlanCensusInput {
  readonly dead: readonly Finding[]
  readonly lines: readonly LineFinding[]
  readonly identifiers: readonly IdentifierFinding[]
  readonly rows: readonly RowFinding[]
  readonly symbols: readonly SymbolFinding[]
  readonly anchors: readonly AnchorFinding[]
  /**
   * D1.114 — the first member whose findings carry no citation: a split row id is
   * keyed by the DOCUMENT it sits in, so {@link planFindingCensus} filters it on
   * `finding.doc` rather than on `finding.citation.doc`.
   */
  readonly splitRows: readonly SplitRowIdFinding[]
  /**
   * D1.317 — the second such member, filtered on `finding.doc` for the same
   * reason. REQUIRED rather than optional, like {@link checkCountProbe}'s runner
   * and for its reason: a member a caller may forget is a member the plan
   * ratchet silently stops counting, and the ratchet is the only instrument that
   * sees debt arriving in the one document no lane may repair.
   */
  readonly controls: readonly ControlScopeFinding[]
  /**
   * D1.337 — the THIRD member filtered on `finding.doc`, and the first whose
   * subject is a COMMAND rather than a sentence or a citation. REQUIRED for the
   * member above's reason. Its population in the plan is ZERO today, so
   * admitting it moves no pin — which is the only condition under which a lane
   * may add a member at all: a pin rises in the controller's commit, never in a
   * lane's.
   */
  readonly dialects: readonly EscapedAlternationFinding[]
}

/**
 * The census, over ONE document — baselined and fresh findings alike.
 *
 * Fresh ones are included deliberately: they are what a `--update-baseline` is
 * about to absorb, so a census that skipped them would report the debt only
 * after it had been made invisible.
 */
export function planFindingCensus(findings: PlanCensusInput, doc: string = PLAN_DOC): PlanCensus {
  const keys: string[] = []
  for (const finding of findings.dead) {
    if (finding.citation.doc === doc) keys.push(deadPathBaselineKey(finding))
  }
  for (const finding of findings.lines) {
    if (finding.citation.doc === doc) keys.push(deadLineBaselineKey(finding))
  }
  for (const finding of findings.identifiers) {
    if (finding.citation.doc === doc) keys.push(identifierBaselineKey(finding))
  }
  for (const finding of findings.rows) {
    if (finding.citation.doc === doc) keys.push(rowBaselineKey(finding))
  }
  for (const finding of findings.symbols) {
    if (finding.citation.doc === doc) keys.push(symbolBaselineKey(finding))
  }
  for (const finding of findings.anchors) {
    if (finding.citation.doc === doc) keys.push(anchorBaselineKey(finding))
  }
  for (const finding of findings.splitRows) {
    if (finding.doc === doc) keys.push(splitRowIdBaselineKey(finding))
  }
  for (const finding of findings.controls) {
    if (finding.doc === doc) keys.push(controlScopeBaselineKey(finding))
  }
  for (const finding of findings.dialects) {
    if (finding.doc === doc) keys.push(escapedAlternationBaselineKey(finding))
  }
  return { keys: [...new Set(keys)].sort(), occurrences: keys.length }
}

export type RatchetVerdict = 'unchanged' | 'fell' | 'rose'

/**
 * The ratchet itself: only a RISE is a failure.
 *
 * It was `planVerdict` until P6.993 gave this file two more pins
 * ({@link PINNED_UNATTACHED_PATH}, {@link PINNED_UNATTACHED_BARE}); the rule is
 * the same for all three, so the name says what it does rather than which pin
 * happened to be first. The default argument keeps the plan's call site short
 * and is not a claim that the plan is the only subject.
 */
export function ratchetVerdict(count: number, pinned: number = PINNED_PLAN_FINDINGS): RatchetVerdict {
  if (count > pinned) return 'rose'
  if (count < pinned) return 'fell'
  return 'unchanged'
}


/** The sixth summary line, plus the instruction each direction earns. */
function reportPlanCensus(census: PlanCensus, outcome: RatchetVerdict): void {
  console.log(
    `check-ledger-citations: ${census.keys.length} distinct finding(s) in ${PLAN_DOC} `
    + `(${census.occurrences} occurrence(s)); pin is ${PINNED_PLAN_FINDINGS}.`,
  )
  if (outcome === 'fell') {
    console.log(
      `  It FELL by ${PINNED_PLAN_FINDINGS - census.keys.length}. If THIS commit repaired those `
      + `citations, lower PINNED_PLAN_FINDINGS to ${census.keys.length} in `
      + 'scripts/check-ledger-citations.ts, in the same commit. If the fall came from someone '
      + 'else moving a cited file, leave the pin alone — this census moves in both directions.',
    )
  }
  if (outcome === 'rose') {
    console.error(
      `  It ROSE by ${census.keys.length - PINNED_PLAN_FINDINGS}. A plan citation has gone dead and no lane `
      + 'may repair it: the plan is the controller\'s file. Repair it there, or — only when the finding is '
      + 'deliberately not a defect — baseline it with the reason beside the entry and raise the pin in the '
      + 'same commit.',
    )
  }
}

/**
 * P6.993 — THE UNATTACHED RATCHET, and why the sweep stops here rather than
 * carrying on.
 *
 * ## What it counts
 *
 * A citation that carries a `:line` tail and whose sentence attaches NOTHING —
 * no identifier ({@link attachedIdentifier}), no symbol ({@link attachedSymbol}),
 * no row id ({@link attachedRowId}). Such a cell opts into exactly one arm of
 * this gate, the blank/EOF one, which the header above calls what it is: a
 * SAMPLE of the drift population, not a measure of it. A citation that drifted
 * onto some other real line still reads as evidence and still passes. It is the
 * form that decays unread, and the only one this file cannot check.
 *
 * ## Why a ratchet and not another sweep
 *
 * P6.947 and P6.967 converted 520 such citations over fourteen paths in one
 * sitting and MEASURED the result: both per-path heads are spent. The bare-name
 * arm went 1 070 unattached over 183 paths with a head of 105 to 550 over 169
 * with a head of 12, its top-ten share 43 % → 18 %; the full-path arm reads
 * 1 240 over 331 with a top-ten share of 14 %. The remainder sits at about two
 * per path, where a sitting pays the same per-cell reading cost for a tenth of
 * the yield. So the decision recorded on the row is **(b) then (a)**: ratchet the
 * number so it can only fall, and stop sweeping. The precedent is
 * `scripts/check-settings-line-citations.ts`, which does the same for the
 * `settings.md:<line>` population AGENTS.md could not keep true in prose.
 *
 * ## The two pins are a READING WITH A DATE, taken by this code
 *
 * W9-cd's closing census (2026-09-10) read 550 over 169 and 1 240 over 331 with
 * an ad-hoc ranking. This function re-read the same bytes and agrees on the
 * bare-name arm exactly; on the full-path arm it saw 1 241 over 332, and the
 * one extra is `apps/electron/resources/pi-agent-server/index.js:584336` in the
 * coverage map — a generated build artefact, already a baselined DEAD PATH. So
 * the census counts only citations whose path RESOLVES in the index: a dead path
 * is a finding of its own above, and ratcheting it here would make one defect
 * two reds. With that exclusion the two instruments agree, and the pins below
 * are the number THIS code computes rather than a number copied from a report.
 *
 * ## The three specs, not the plan
 *
 * Measured 2026-09-10: plan-inclusive the arms read 1 865 over 446 (full path)
 * and 1 405 over 336 (bare name). They are excluded anyway, for
 * {@link PINNED_PLAN_FINDINGS}'s reason one layer up: the plan is the
 * controller's file and read-only for every lane, and its rows are written by
 * pinning commits that paste evidence with line anchors — so a plan-inclusive
 * pin would go red on the one file whose owner is the only person who could
 * lower it, and would block `lint:chain` for every lane while it did. The plan's
 * own debt is ratcheted by {@link PINNED_PLAN_FINDINGS}, which counts FINDINGS
 * rather than form.
 *
 * ## What it cannot see, and the one way it can be gamed
 *
 * Deleting the PATH lowers this number and gains nothing: `SessionManager.ts:812`
 * becomes `:812`, the bare line shorthand the header above describes, whose
 * NUMBER no arm of this gate reads. The honest repair is the other direction —
 * give the citation the symbol its sentence already names, in the
 * ``path` symbol `name`` form, and the symbol arm checks it on every run.
 *
 * **Nothing HERE can tell the two apart, and since P6.998 nothing here has to:**
 * {@link PINNED_SHORTHAND} ratchets the population a deletion lands in, so a
 * deletion moves this pin down and that one UP in the same commit while a
 * conversion moves this one down and leaves that one alone. The sentence that
 * used to stand at the end of this paragraph — that it is written down instead
 * of guarded — was true for one day.
 *
 * PATH COUNTS are printed and deliberately NOT ratcheted, the same residue
 * {@link PINNED_PLAN_FINDINGS} states for occurrences: a conversion empties a
 * path and moves both numbers, and two pins for one defect is two reds for one
 * cause.
 *
 * ## The one legitimate RISE, and it is not a lane writing a cell
 *
 * ADMITTING a document raises both pins by that document's own population, and
 * the population is not new — the readership is. P6.989 did exactly that on the
 * day after these pins were set: the owner-questions spec joined {@link LEDGERS}
 * carrying **184 unattached over 71 paths** on the full-path arm and **113 over
 * 42** on the bare-name arm, measured before the commit, so the pins went
 * 1238 → 1422 and 550 → 663 in the same commit that admitted it. That is the
 * ONLY reason to raise one, it belongs in the commit that changes the document
 * list, and the numbers go here rather than into prose that would age.
 *
 * ## Lowered 2026-09-13 (W19-f), and the reading that proves it was a conversion
 *
 * The wave-19 hand-back pass converted the two ledgers' last SEVEN dead line
 * anchors, each given the identifier its own sentence names. Five of the seven
 * were unattached and are this census's own population: the full-path arm fell
 * 1357 -> 1354 and the bare-name arm 625 -> 623, lowered in that commit. The
 * other two already carried an identifier and sat in the drifted-identifier arm
 * instead, which is why the fall is five and not seven. {@link PINNED_SHORTHAND}
 * read 1829 before and after — the one reading that separates a conversion from
 * a path DELETION, which would have moved it up by the same five.
 *
 * Lowered 578 → 572 by UA12.126 (2026-10-04), the gate's own FELL instruction: the six
 * citations that had gone UNCHECKED on basename collisions (`permission-remember.test.ts`
 * ×4, `schema.ts` ×2 — UA12.70 and UA3.2 each added a second file of that basename) are
 * repaired to full paths with attached symbols, so they leave this arm for the symbol arm
 * rather than returning to it. The full-path arm did not move: the six cite with a symbol
 * now, so they never enter the unattached census at all.
 *
 * Lowered 1309 → 1303 and 560 → 558 by UB15.5 (2026-10-16), the gate's own FELL instruction: the App settings page
 * moved onto the SettingsPage column, so its eight unattached line anchors (six full-path, two bare-name, in the
 * ledger, the denominator-gaps spec and the owner-questions spec) are re-anchored to the symbols their sentences
 * name. {@link PINNED_SHORTHAND} read 1787 before and after, which is what separates a conversion from a deletion.
 *
 * Lowered 1303 → 1299 and 558 → 556 by UB15.7 (2026-10-16), the gate's own FELL instruction: the Permissions page
 * moved onto the SettingsPage column and its sections onto the v0.15.1 material, so the page's and the isolation
 * posture's unattached line anchors in the ledger and the denominator-gaps spec (A43 and the egress-posture cell
 * full-path, I13 bare-name, each twice) are re-anchored to the symbols their sentences name. The plan's twins of
 * A43 and I13, its MCP channel-push toggle cell and its browser-sites cell are re-anchored too (the plan is
 * ratcheted by findings, which did not move). {@link PINNED_SHORTHAND} read 1787 before and after.
 *
 * Lowered 1299 → 1292 and 556 → 554 by UB12.76 (2026-10-17), following the gate's own FELL instruction.
 * Each anchor below now cites the symbol its sentence names:
 * - L126's InputSettingsPage.tsx anchor (44 to 56), blanked by UB15.3, now cites `handleSpellCheckChange`. That is
 *   two full-path citations (ledger and gaps) and two bare ones (owner questions).
 * - The status-line quote's format-adapters/claude.ts anchors now cite `normalizeClaudePluginDefaultSettings`. The
 *   gaps spec's 2628-2647 range was blanked by UB12.67. O21's 2643-2644 had drifted, in the ledger, the gaps spec
 *   and the owner questions.
 * - The gaps spec's drifted resolver.ts anchor (2214 to 2232) now cites `isTrustGatedPluginCapabilityKind`.
 * {@link PINNED_SHORTHAND} read 1779 before and after.
 */
export const PINNED_UNATTACHED_PATH = 1292

/** The bare-filename arm's half of the pin above; see its header for both. */
export const PINNED_UNATTACHED_BARE = 554

export interface UnattachedCensus {
  /** Citations written as a full path, over {@link UnattachedCensus.pathPaths} files. */
  readonly path: number
  readonly pathPaths: number
  /** Citations written as a bare filename and resolved by uniqueness (P6.956). */
  readonly bare: number
  readonly barePaths: number
}

/** A line-tailed citation whose sentence opts into none of the three checkable forms. */
export function isUnattachedLineCitation(citation: Citation): boolean {
  if (!LINE_TAIL.test(citation.text)) return false
  if (attachedIdentifier(citation.after) !== undefined) return false
  if (attachedSymbol(citation.before, citation.after) !== undefined) return false
  return attachedRowId(citation.before, citation.after) === undefined
}

/**
 * The census the two pins compare against.
 *
 * The arms are split by {@link Citation.written}, which is present on exactly the
 * citations {@link collectBareNameCitations} resolved from a basename and absent
 * on every citation that named its own path — so the split needs no second pass
 * over the documents and cannot disagree with what the bare-name arm admitted.
 */
export function unattachedCensus(
  citations: readonly Citation[],
  tracked: ReadonlySet<string>,
): UnattachedCensus {
  const path = new Map<string, number>()
  const bare = new Map<string, number>()
  for (const citation of citations) {
    if (citation.doc === PLAN_DOC) continue
    if (!tracked.has(citation.path)) continue
    if (!isUnattachedLineCitation(citation)) continue
    const arm = citation.written === undefined ? path : bare
    arm.set(citation.path, (arm.get(citation.path) ?? 0) + 1)
  }
  const total = (arm: ReadonlyMap<string, number>) =>
    [...arm.values()].reduce((sum, count) => sum + count, 0)
  return { path: total(path), pathPaths: path.size, bare: total(bare), barePaths: bare.size }
}

/** One arm's direction, in the words each earns. */
function reportUnattachedArm(
  label: string,
  constant: string,
  count: number,
  pinned: number,
  outcome: RatchetVerdict,
): void {
  if (outcome === 'fell') {
    console.log(
      `  The ${label} arm FELL by ${pinned - count}. If THIS commit converted those citations, lower `
      + `${constant} to ${count} in scripts/check-ledger-citations.ts, in the same commit. A fall you `
      + 'did not cause is a reading, not an instruction — and a fall from a DELETED path is not a repair '
      + 'at all: it becomes a bare `:line` shorthand nothing reads, which is what PINNED_SHORTHAND below '
      + 'is watching rise.',
    )
  }
  if (outcome === 'rose') {
    console.error(
      `  The ${label} arm ROSE by ${count - pinned}. A cell was written with a line number and nothing `
      + 'else, so only its blankness is checked. Give the citation the symbol its sentence already names '
      + '(`path` symbol `name`) and the symbol arm reads it on every run. Raising this pin is not the repair.',
    )
  }
}

/** The seventh summary line: the population that decays unread, on both arms. */
function reportUnattachedCensus(
  census: UnattachedCensus,
  pathOutcome: RatchetVerdict,
  bareOutcome: RatchetVerdict,
): void {
  console.log(
    `check-ledger-citations: ${census.path} unattached line-tailed citation(s) over ${census.pathPaths} `
    + `path(s) written as a full path (pin ${PINNED_UNATTACHED_PATH}), ${census.bare} over `
    + `${census.barePaths} path(s) written as a bare filename (pin ${PINNED_UNATTACHED_BARE}), in the `
    + `${LEDGERS.length - 1} spec(s) — the plan is ratcheted by findings instead.`,
  )
  reportUnattachedArm('full-path', 'PINNED_UNATTACHED_PATH', census.path, PINNED_UNATTACHED_PATH, pathOutcome)
  reportUnattachedArm('bare-name', 'PINNED_UNATTACHED_BARE', census.bare, PINNED_UNATTACHED_BARE, bareOutcome)
}

/**
 * ## P6.998 — the OTHER end of the ratchet above, so the cheap exit is closed
 *
 * The two pins above can be satisfied by DELETING a path: `SessionManager.ts:812`
 * becomes `:812`, the citation leaves both arms, and the number falls with
 * nothing repaired. That was written down in the header rather than guarded,
 * because a fall from a conversion and a fall from a deletion look identical
 * from one arm. **From two they do not** — a deletion moves the unattached arm
 * DOWN and this count UP in the same commit, a conversion to the symbol form
 * moves the unattached arm down and leaves this one unchanged or lower. Neither
 * pin can tell the two apart alone and neither has to.
 *
 * ## The rule, and it is the complement of {@link CITATION}'s tail
 *
 * A colon, digits, optionally a hyphen and more digits, whose neighbouring
 * character on EITHER side is not a path character ({@link CONTINUES_A_TOKEN}).
 * The left side is what makes it a shorthand rather than a citation — a real
 * citation has its path immediately before the colon; the right side is what
 * makes it a complete token rather than the head of something longer.
 *
 * ## The reading, 2026-09-10, over the four specs of {@link LEDGERS}
 *
 * **1 851**: 774 in the capability ledger, 742 in the denominator gaps, 143 in
 * the codex coverage map, 192 in the owner-questions spec. The plan carries
 * another 1 285 and is excluded, for {@link PINNED_UNATTACHED_PATH}'s reason
 * exactly: it is the controller's file, read-only for every lane, and its rows
 * are written by pinning commits that paste evidence with line anchors — a
 * plan-inclusive pin would go red on the one file whose owner is the only person
 * who could lower it, and would block `lint:chain` for every lane while it did.
 * Excluding it also keeps the two ends of the ratchet over the same corpus,
 * which is the whole reason this pin exists.
 *
 * Re-broken to prove it bites: with the pin one below the reading the run exits
 * **1** and prints the ROSE arm; restored, it exits 0 and the file hashes back to
 * baseline (2026-09-10).
 *
 * ## Where the docblock's 3 375 went, stated rather than reconciled away
 *
 * P6.955's header sizes this population at **3 375** over the four documents it
 * then had (875 / 836 / 151 / 1 513, 2026-09-09). Over the SAME bytes this
 * code reads **3 381** (878 / 836 / 151 / 1 516) — the two middle documents agree
 * exactly and the other two differ by three each. That census was ad-hoc and is
 * not recoverable; this one is the code, so the pin is the number THIS function
 * computes, which is the same standing rule the unattached pins were set under.
 * The population has since FALLEN: 3 136 across all five documents under this
 * rule, which is what AGENTS.md rule 29 does when a lane converts a cell it was
 * already reading.
 *
 * ## What it still cannot see
 *
 * Everything the header says: the NUMBER a shorthand states is unchecked
 * whatever it says, on every one of these 1 851. This pin guards the POPULATION,
 * not a single anchor in it. The one honest way down is the citation being given
 * its path or its symbol, one cell at a time.
 *
 * Lowered 1787 → 1779 by UB12.34 (2026-10-17), the gate's own FELL instruction: the
 * shorthands that followed two citations UB12.16 had re-anchored by symbol (A53's three
 * into `pre-tool-use.ts`, B20's two into `native-sources.ts`) are given the full path and
 * the symbol their sentences name, in the capability ledger and the denominator-gaps spec.
 * That is ten conversions but a fall of eight: B20's second was spelled `:a/:b/:c`, whose
 * every token touches a `/`, so {@link CONTINUES_A_TOKEN} never let this rule count it.
 * The symbol arm rose by the ten; {@link PINNED_UNATTACHED_PATH} and
 * {@link PINNED_UNATTACHED_BARE} read 1299 and 556 before and after, so this is a
 * conversion and not a deletion.
 */
export const PINNED_SHORTHAND = 1779

/** A bare `:line` or `:line-line`, wherever it sits on the line. */
const LINE_SHORTHAND = /:\d+(?:-\d+)?/g

/**
 * The census {@link PINNED_SHORTHAND} compares against, over one document's raw
 * text — this reads the DOCUMENT rather than the citation array, because a
 * shorthand carries no path and so never became a {@link Citation} at all.
 */
export function countLineShorthands(text: string): number {
  let found = 0
  for (const line of text.split('\n')) {
    LINE_SHORTHAND.lastIndex = 0
    for (let match = LINE_SHORTHAND.exec(line); match !== null; match = LINE_SHORTHAND.exec(line)) {
      const before = match.index > 0 ? line[match.index - 1] : undefined
      if (before !== undefined && CONTINUES_A_TOKEN.test(before)) continue
      const after = line[match.index + match[0].length]
      if (after !== undefined && CONTINUES_A_TOKEN.test(after)) continue
      found += 1
    }
  }
  return found
}

/** The eighth summary line, and the direction each verdict earns. */
function reportShorthandCensus(count: number, outcome: RatchetVerdict): void {
  console.log(
    `check-ledger-citations: ${count} bare \`:line\` shorthand(s) in the ${LEDGERS.length - 1} spec(s) `
    + `(pin ${PINNED_SHORTHAND}) — carrying no path, their numbers are unread whatever they say.`,
  )
  if (outcome === 'fell') {
    console.log(
      `  It FELL by ${PINNED_SHORTHAND - count}. If THIS commit gave those anchors a path or a symbol, `
      + `lower PINNED_SHORTHAND to ${count} in scripts/check-ledger-citations.ts, in the same commit.`,
    )
  }
  if (outcome === 'rose') {
    console.error(
      `  It ROSE by ${count - PINNED_SHORTHAND}. A cell gained an anchor with no path in front of it, so `
      + 'nothing reads its number. If the unattached arms fell in the same commit, that is a PATH being '
      + 'deleted rather than a citation being repaired — give the anchor its path back, or the symbol its '
      + 'sentence already names. Raising this pin is not the repair.',
    )
  }
}

/**
 * ## P6.999 — `--pin`, because four numbers lowered BY HAND is four chances to
 * lower the wrong one
 *
 * This file carries four ratchets — {@link PINNED_PLAN_FINDINGS},
 * {@link PINNED_UNATTACHED_PATH}, {@link PINNED_UNATTACHED_BARE} and
 * {@link PINNED_SHORTHAND} — and every one of them ends its report line with the
 * same instruction: *lower the constant in `scripts/check-ledger-citations.ts`,
 * in the same commit*. Until now that was carried out by hand-editing a digit,
 * which is a transcription step with nothing checking it, in a file where the
 * four numbers are also SPELLED IN PROSE inside their own docblocks and inside
 * each other's — so the hand edit's near-miss is editing a sentence about a pin
 * instead of the pin. `--update-baseline` rewrites the register and touches none
 * of the four. The precedent is `check:surface -- --pin`, which exists for the
 * identical shape: the run already knows the new number.
 *
 * ## What it does
 *
 * Computes the same census `--check` does, prints one delta line per pin, and
 * rewrites the four constants in THIS file in place. A pin whose live number
 * already equals it is left byte-identical.
 *
 * ## A RISE needs a second flag, and that is the whole point
 *
 * `--pin` alone REFUSES when any of the four would go up, because raising a pin
 * to make a red run green is the one move all four exist to prevent. The
 * legitimate raise is not a lane writing a cell: it is a DOCUMENT joining
 * {@link LEDGERS}, whose population is not new — the readership is. P6.989 is
 * the measured case: the owner-questions spec joined carrying 184 unattached
 * citations over 71 paths and 113 over 42, and both pins rose in the commit that
 * admitted it. `--pin --allow-raise` is that commit's flag.
 * {@link PINNED_PLAN_FINDINGS} has one more legitimate raise and it belongs to
 * the controller rather than to a lane: a plan finding that is deliberately not
 * a defect, baselined with the reason beside the entry.
 *
 * ## Why it runs BEFORE the count arm
 *
 * The count check is the only part of this gate that spawns a child process per
 * subject, and no pin reads it. Every number here comes from the finding arrays
 * and the document text, both already computed by the time `--pin` is reached,
 * so it costs the census and nothing more.
 *
 * ## What it deliberately does NOT decide
 *
 * Whether a fall is a REPAIR. All four headers say the census moves in both
 * directions with any commit to a cited file, and a fall a lane did not cause is
 * a reading rather than an instruction. This writes what the run measured and
 * prints every delta first, so the lane reads them before committing them. A
 * flag that pretended to judge that would be worse than the hand edit it
 * replaces.
 *
 * The path is DERIVED from the running file rather than written down, so a
 * rename cannot leave `--pin` writing a file that is no longer this one; the
 * four report messages spell it as a literal, and a test pins the two together.
 */
export const PIN_FILE = relative(REPO_ROOT, fileURLToPath(import.meta.url))

/** One pin, its constant and the two numbers `--pin` compares. */
export interface PinReading {
  readonly constant: string
  readonly pinned: number
  readonly live: number
}

export interface PinPlan {
  /** The pins whose live number differs from the constant — what gets rewritten. */
  readonly updates: readonly PinReading[]
  /** Those that would go UP. Non-empty means `--allow-raise` is required. */
  readonly raises: readonly PinReading[]
  /** One line per pin, printed on every `--pin` run whichever way it ends. */
  readonly lines: readonly string[]
}

/**
 * The deltas, in the order the summary prints the censuses.
 *
 * Every pin gets a line, unchanged ones included: a run that printed only what
 * moved would leave a reader unable to tell "this pin is current" from "this pin
 * was not looked at", which is the state the hand edit was already in.
 */
export function planPins(readings: readonly PinReading[]): PinPlan {
  const lines = readings.map(reading => {
    if (reading.live === reading.pinned) return `  ${reading.constant} unchanged at ${reading.pinned}.`
    const direction = reading.live < reading.pinned ? 'FELL' : 'ROSE'
    return `  ${reading.constant} ${direction} by ${Math.abs(reading.live - reading.pinned)}: `
      + `${reading.pinned} -> ${reading.live}.`
  })
  return {
    updates: readings.filter(reading => reading.live !== reading.pinned),
    raises: readings.filter(reading => reading.live > reading.pinned),
    lines,
  }
}

/** `export const NAME = 1234` (or `1_234`) — the DECLARATION, never the prose about it. */
function pinDeclaration(constant: string): RegExp {
  return new RegExp(`(export const ${constant} = )[0-9_]+`, 'g')
}

/**
 * The rewrite, pure, so the shape can be pinned without writing anything.
 *
 * Exactly one declaration per constant is ASSERTED rather than assumed. These
 * four names occur a dozen times each in this file — in their own headers, in
 * each other's, and in the four report strings — so a replace that took the
 * first match would be one docblock edit away from rewriting a sentence and
 * leaving the pin at yesterday's number, silently.
 */
export function rewritePinnedConstants(source: string, updates: readonly PinReading[]): string {
  let out = source
  for (const update of updates) {
    const found = out.match(pinDeclaration(update.constant)) ?? []
    if (found.length !== 1) {
      throw new GateSafetyRefusal(
        `REFUSED: ${found.length} declaration(s) of ${update.constant} in ${PIN_FILE} — --pin rewrites the one `
        + 'that exists and nothing else, so a missing or duplicated pin is a hand edit to make first.',
      )
    }
    out = out.replace(pinDeclaration(update.constant), `$1${update.live}`)
  }
  return out
}

/**
 * The same rewrite against a real file.
 *
 * Split from the pure function above for one reason: a test that exercised this
 * end of it against the tracked script would rewrite the gate it is checking,
 * and a test that leaves the tree different from how it found it is a test
 * nobody can run twice. The path is a parameter, so the test runs it on a COPY
 * under a temp dir.
 */
export function rewritePinsInFile(file: string, updates: readonly PinReading[]): void {
  const source = readFileSync(file, 'utf-8')
  const next = rewritePinnedConstants(source, updates)
  if (next !== source) writeFileSync(file, next, 'utf-8')
}

/** The refusal a raise earns, naming the one thing that makes a raise legitimate. */
export function pinRaiseRefusal(raises: readonly PinReading[]): GateSafetyRefusal {
  return new GateSafetyRefusal(
    `REFUSED: --pin would RAISE ${raises.length} pin(s) — `
    + `${raises.map(raise => `${raise.constant} ${raise.pinned} -> ${raise.live}`).join(', ')}. `
    + 'Raising a pin to make a red run green is the move all four exist to prevent, so --pin will not do it '
    + 'on its own. A raise is legitimate when a DOCUMENT JOINS LEDGERS: that document\'s population is not '
    + 'new, the readership is, and the pins rise in the same commit that admits it (P6.989 raised two by 184 '
    + 'and 113 exactly that way). PINNED_PLAN_FINDINGS has one more, and it is the controller\'s rather than '
    + 'a lane\'s: a plan finding that is deliberately not a defect, baselined with its reason beside the '
    + 'entry. Either way it belongs to the commit that MAKES the change, never to the commit that met the '
    + 'red — run `--pin --allow-raise` from there.',
  )
}

/** The bare form a cell actually spells, when the citation was resolved from one. */
function writtenAs(citation: Citation): string {
  return citation.written === undefined ? '' : ` (written as \`${citation.written}\`)`
}

/** Enough candidates to choose from; a basename shared by forty files needs a grep, not a list. */
const AMBIGUOUS_CANDIDATES_SHOWN = 10

/**
 * P6.969 — the ambiguous bucket, by name rather than as a number.
 *
 * The count answers *"did something go unchecked?"* and nothing else, and the
 * measured cost of that (W9-bz, 2026-09-10) was a lane writing a second mention
 * as `event-adapter.ts`, seeing `ambiguous` move 68 → 70, and having no way from
 * the run to learn which two cells had stopped being checked. Names go on the
 * summary line in every run; the citing `document:line` and the tracked
 * candidates are one flag away, because 150-odd sites is a page of output a
 * `lint:chain` member should not print unasked.
 *
 * Not a finding and not an exit code: an ambiguous basename is a citation the
 * gate declines to guess about, not a citation known to be wrong.
 */
function reportAmbiguousBareNames(
  sites: readonly AmbiguousBareName[],
  tracked: Iterable<string>,
  verbose: boolean,
): void {
  if (sites.length === 0) return
  const byName = new Map<string, AmbiguousBareName[]>()
  for (const site of sites) {
    const bucket = byName.get(site.name)
    if (bucket === undefined) byName.set(site.name, [site])
    else bucket.push(site)
  }
  const candidates = candidatesForBasenames(tracked, byName.keys())
  const ranked = [...byName.entries()].sort(
    (left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]),
  )

  console.log(
    `check-ledger-citations: ${sites.length} ambiguous citation(s) over ${ranked.length} basename(s), each `
    + 'UNCHECKED — write the FULL path in the cell (the symbol form takes one too).'
    + (verbose ? '' : ' `--verbose` lists the citing lines and the tracked candidates.'),
  )
  // Compact, and EVERY name: a converting lane is looking for its own basename,
  // which is as likely to be the one cited once as the one cited nineteen times.
  console.log(
    '  by name: '
    + ranked.map(([name, cited]) =>
      `\`${name}\` ×${cited.length} (${candidates.get(name)?.length ?? 0} tracked)`).join(', '),
  )
  if (!verbose) return
  for (const [name, cited] of ranked) {
    const files = candidates.get(name) ?? []
    console.log(`  \`${name}\` — ${cited.length} citation(s) unchecked, ${files.length} tracked candidate(s):`)
    for (const site of cited) console.log(`      cited at ${site.doc}:${site.line}`)
    for (const file of files.slice(0, AMBIGUOUS_CANDIDATES_SHOWN)) console.log(`      candidate ${file}`)
    if (files.length > AMBIGUOUS_CANDIDATES_SHOWN) {
      console.log(`      … and ${files.length - AMBIGUOUS_CANDIDATES_SHOWN} more candidate(s)`)
    }
  }
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const update = argv.includes('--update-baseline')
  // P6.999 — the pin rewriter and its raise flag; see PIN_FILE's header.
  const pin = argv.includes('--pin')
  const allowRaise = argv.includes('--allow-raise')
  if (allowRaise && !pin) {
    throw new GateSafetyRefusal(
      'REFUSED: --allow-raise without --pin does nothing, and a flag that silently does nothing reads as a '
      + 'run that permitted something. Pass both, or neither.',
    )
  }
  if (pin && update) {
    throw new GateSafetyRefusal(
      'REFUSED: --pin and --update-baseline in one run — --pin returns before the baseline is written, so one '
      + 'of the two would silently not happen. Run them as two commands in either order: the census counts '
      + 'FRESH findings too, so neither changes what the other reads.',
    )
  }
  // P6.969 — the names always; the citing lines and the candidates on request,
  // because 150-odd sites is a page of output nobody asked a gate run for.
  const verbose = argv.includes('--verbose')

  const tracked = new Set(trackedFiles())
  if (tracked.size === 0) {
    throw new GateSafetyRefusal('REFUSED: `git ls-files` returned nothing — the run would be vacuous.')
  }
  const roots = new Set(
    [...tracked].filter(file => file.includes('/')).map(file => file.split('/')[0] as string),
  )

  const citations: Citation[] = []
  const countProbes: CountProbe[] = []
  // P6.956 — one basename index for the whole run; `null` marks an ambiguous name.
  const basenames = buildBasenameIndex(tracked)
  let bareAdmitted = 0
  const bareAmbiguousSites: AmbiguousBareName[] = []
  let bareUnmatched = 0
  let bareMarkdown = 0
  let bareDocs = 0
  // P6.998 — the shorthand population, counted from the DOCUMENT text because a
  // bare `:812` carries no path and so never becomes a `Citation`.
  let shorthands = 0
  // D1.114 — read from the DOCUMENT text like the shorthand census above, and
  // unlike it NOT skipping the plan: a broken row id in the plan is precisely
  // the class the plan ratchet exists to keep visible.
  const splitRows: SplitRowIdFinding[] = []
  // D1.317 — the control-scope arm, read from the DOCUMENT text for the same
  // reason and over every document for the same reason.
  const controlFindings: ControlScopeFinding[] = []
  let controlSubjects = 0
  let controlContained = 0
  let controlDeclined = 0
  // D1.159 — the tokens this gate DROPS that are real files on this disk. Named,
  // never verified; see {@link UnreachableCitations} for the three reasons.
  const unreachablePaths = new Set<string>()
  let unreachable = 0
  let unreachableTailed = 0
  for (const doc of LEDGERS) {
    const file = join(REPO_ROOT, doc)
    if (!existsSync(file)) {
      throw new GateSafetyRefusal(`REFUSED: ${doc} is missing — a pass here would mean nothing was read.`)
    }
    const text = readFileSync(file, 'utf-8')
    if (doc !== PLAN_DOC) shorthands += countLineShorthands(text)
    const found = collectCitations(doc, text, roots)
    // PER DOCUMENT, not on the total. With one member the aggregate check below
    // said the same thing; with three it does not, and the difference is a
    // silent hole: a document that stops yielding citations — renamed away from
    // the citation form, or rewritten — would be carried by its siblings' 2 000
    // and report a green gate over a document nobody is reading any more.
    if (found.length === 0) {
      throw new GateSafetyRefusal(
        `REFUSED: ${doc} yielded no repo-file citations — it is listed but unread, so its cells are ungated.`,
      )
    }
    citations.push(...found)
    if (admitsBareNames(doc)) {
      const bare = collectBareNameCitations(doc, text, basenames)
      citations.push(...bare.citations)
      bareAdmitted += bare.citations.length
      bareAmbiguousSites.push(...bare.ambiguousSites)
      bareUnmatched += bare.unmatched
      bareMarkdown += bare.markdown
      bareDocs += 1
    }
    countProbes.push(...collectCountProbes(doc, text))
    splitRows.push(...findSplitRowIds(doc, text))
    const controls = findControlScopeMismatches(doc, text, { tracked, roots, basenames })
    controlFindings.push(...controls.findings)
    controlSubjects += controls.subjects
    controlContained += controls.contained
    controlDeclined += controls.declined
    const offIndex = unreachableCitations(text, roots)
    unreachable += offIndex.occurrences
    unreachableTailed += offIndex.withLineTail
    for (const found of offIndex.paths) unreachablePaths.add(found)
  }
  if (citations.length === 0) {
    throw new GateSafetyRefusal(
      'REFUSED: no repo-file citations found in the ledger(s) — the matcher is broken, not the tree.',
    )
  }

  const findings = findDeadCitations(citations, tracked)
  if (findings.length * 2 > citations.length) {
    throw new GateSafetyRefusal(
      `REFUSED: ${findings.length} of ${citations.length} citations unresolved — that is a broken matcher, `
      + 'not a tree in that state. Fix the extractor before trusting a number from it.',
    )
  }

  const deadPaths = [...new Set(findings.map(deadPathBaselineKey))].sort()

  // Only a citation whose path RESOLVES is eligible for the line check: a dead
  // path is already reported above, and asking the index for its content would
  // add a second finding saying the same thing in a worse way.
  const linePaths = [...new Set(
    citations.filter(citation => LINE_TAIL.test(citation.text) && tracked.has(citation.path))
      .map(citation => citation.path),
  )].sort()
  // P6.943 — a row-id citation usually carries NO line tail (that is the point
  // of the form), so its target has to be added to the blob read or the arm
  // would silently check nothing. Same read, one merged list, no extra child.
  const rowPaths = citations
    .filter(citation => citation.path.endsWith('.md')
      && tracked.has(citation.path)
      && attachedRowId(citation.before, citation.after) !== undefined)
    .map(citation => citation.path)
  // P6.957 — the identifier-only form carries no line tail either, and its
  // subject is any tracked file rather than a markdown one. Same merged read.
  const symbolPaths = citations
    .filter(citation => tracked.has(citation.path)
      && attachedSymbol(citation.before, citation.after) !== undefined)
    .map(citation => citation.path)
  // C3.325 — the anchor form carries no line tail either, same merged read.
  const anchorPaths = citations
    .filter(citation => tracked.has(citation.path)
      && attachedAnchor(citation.before, citation.after) !== undefined)
    .map(citation => citation.path)
  const contents = readIndexBlobs(
    [...new Set([...linePaths, ...rowPaths, ...symbolPaths, ...anchorPaths])].sort(),
  )
  if (linePaths.length > 0 && contents.size === 0) {
    throw new GateSafetyRefusal(
      `REFUSED: \`git cat-file --batch\` returned nothing for ${linePaths.length} cited path(s) — `
      + 'the blob reader is broken, so every line would read as checked and none would be.',
    )
  }
  const lineFindings = findDeadLineCitations(citations, contents)
  const lineCitations = citations.filter(
    citation => LINE_TAIL.test(citation.text) && contents.has(citation.path),
  ).length
  if (lineFindings.length * 2 > lineCitations) {
    throw new GateSafetyRefusal(
      `REFUSED: ${lineFindings.length} of ${lineCitations} line citations dead — that is a broken reader, `
      + 'not a tree in that state.',
    )
  }
  const deadLines = [...new Set(lineFindings.map(deadLineBaselineKey))].sort()

  // P6.891 — the opt-in identifier check. Same contents map, same index read, so
  // it costs one more pass over an array rather than another child process.
  const identifierFindings = findDriftedIdentifierCitations(citations, contents)
  const identifierSubjects = citations.filter(
    citation => LINE_TAIL.test(citation.text)
      && contents.has(citation.path)
      && attachedIdentifier(citation.after) !== undefined,
  ).length
  // The two checks above refuse at HALF, because a tree in that state would mean
  // a broken matcher. This one deliberately does not, and the difference is
  // measured rather than a matter of taste: it lands on a population NOTHING has
  // ever checked, so a high rate is the finding rather than a symptom. At HEAD it
  // is 70 of 151, and the first seven were hand-checked one by one — every one a
  // real drift, the identifier having moved 23, 72, 162, 391, 665, 1 119 and
  // 3 014 lines away from the line cited beside it. A half threshold here would
  // have converted that result into a refusal to report it. Nine tenths still
  // catches the thing a threshold is for: an extractor that has stopped reading
  // identifiers and is matching punctuation.
  if (identifierFindings.length * 10 > identifierSubjects * 9) {
    throw new GateSafetyRefusal(
      `REFUSED: ${identifierFindings.length} of ${identifierSubjects} attached identifiers missing from their `
      + 'cited window — at that rate the opt-in rule is matching something other than an identifier. Fix the '
      + 'extractor before trusting a number from it.',
    )
  }
  const driftedIdentifiers = [...new Set(identifierFindings.map(identifierBaselineKey))].sort()

  // P6.943 — the row-id arm. Same contents map again, so it is another pass over
  // an array. No refusal threshold: the population is two subjects today, and a
  // ratio over two is noise rather than a safety net — the three checks above
  // each guard a population in the hundreds or thousands, which is what makes a
  // rate meaningful there.
  const rowFindings = findRowIdCitations(citations, contents)
  const rowSubjects = citations.filter(
    citation => citation.path.endsWith('.md')
      && contents.has(citation.path)
      && attachedRowId(citation.before, citation.after) !== undefined,
  ).length
  const driftedRows = [...new Set(rowFindings.map(rowBaselineKey))].sort()

  // P6.957 — the identifier-only arm. Same contents map, one more array pass.
  // No refusal threshold, for the row arm's reason: its population is what this
  // lane converts, so a rate over it would be a rate over a handful.
  const symbolFindings = findAbsentSymbolCitations(citations, contents)
  const symbolSubjects = citations.filter(
    citation => contents.has(citation.path)
      && attachedSymbol(citation.before, citation.after) !== undefined,
  ).length
  const absentSymbols = [...new Set(symbolFindings.map(symbolBaselineKey))].sort()

  // C3.325 — the anchor arm. Same contents map, one more array pass. No refusal
  // threshold, for the row and symbol arms' reason: its population is what a
  // lane converts, so a rate over it would be a rate over a handful.
  const anchorFindings = findAmbiguousAnchorCitations(citations, contents)
  const anchorSubjects = citations.filter(
    citation => contents.has(citation.path)
      && attachedAnchor(citation.before, citation.after) !== undefined,
  ).length
  const ambiguousAnchors = [...new Set(anchorFindings.map(anchorBaselineKey))].sort()

  // D1.317 — the control-scope arm needs no contents map and no refusal
  // threshold either: it reads no file, and its decided population is a handful,
  // which is a size no rate is meaningful over (the row and symbol arms' reason).
  const mismatchedControls = [...new Set(controlFindings.map(controlScopeBaselineKey))].sort()

  // D1.114 — the split-row arm needs no contents map and no refusal threshold:
  // it reads no file, and its population is zero in every gated document today,
  // which is a rate nothing can be computed over.
  const brokenRowIds = [...new Set(splitRows.map(splitRowIdBaselineKey))].sort()

  // D1.337 — the regex-dialect arm. One pass over the declarations already
  // collected: no file is read, no child process is spawned, and it runs here
  // rather than beside the count re-run below so the plan census and `--pin` can
  // both see it.
  const dialectFindings = findEscapedAlternationProbes(countProbes)
  const escapedAlternations = [...new Set(dialectFindings.map(escapedAlternationBaselineKey))].sort()

  // P6.954 — the plan ratchet. Computed from the same four finding arrays, so it
  // costs four array passes and no read of any kind.
  const planCensus = planFindingCensus({
    dead: findings,
    lines: lineFindings,
    identifiers: identifierFindings,
    rows: rowFindings,
    symbols: symbolFindings,
    anchors: anchorFindings,
    splitRows,
    controls: controlFindings,
    dialects: dialectFindings,
  })
  const planOutcome = ratchetVerdict(planCensus.keys.length)

  // P6.993 — the unattached ratchet. Another pass over the same array, no read:
  // it is a census of FORM (a line number and nothing else) rather than of
  // findings, which is why it is beside the plan pin and not inside it.
  const unattached = unattachedCensus(citations, tracked)
  const unattachedPath = ratchetVerdict(unattached.path, PINNED_UNATTACHED_PATH)
  const unattachedBare = ratchetVerdict(unattached.bare, PINNED_UNATTACHED_BARE)
  // P6.998 — the deletion end of the same ratchet; see PINNED_SHORTHAND.
  const shorthandOutcome = ratchetVerdict(shorthands, PINNED_SHORTHAND)

  // P6.999 — `--pin` runs HERE, ahead of the count arm: that arm is the only
  // part of this gate that spawns a child process per subject and no pin reads
  // it, so pinning costs the census and nothing more.
  if (pin) {
    const plan = planPins([
      { constant: 'PINNED_PLAN_FINDINGS', pinned: PINNED_PLAN_FINDINGS, live: planCensus.keys.length },
      { constant: 'PINNED_UNATTACHED_PATH', pinned: PINNED_UNATTACHED_PATH, live: unattached.path },
      { constant: 'PINNED_UNATTACHED_BARE', pinned: PINNED_UNATTACHED_BARE, live: unattached.bare },
      { constant: 'PINNED_SHORTHAND', pinned: PINNED_SHORTHAND, live: shorthands },
    ])
    console.log(
      `check-ledger-citations: --pin — ${plan.updates.length} of 4 pin(s) differ from the live census in `
      + `${PIN_FILE}.`,
    )
    // Every delta BEFORE the refusal, so a run that will not write still tells
    // the operator all four numbers rather than only the one that stopped it.
    for (const line of plan.lines) console.log(line)
    if (plan.raises.length > 0 && !allowRaise) throw pinRaiseRefusal(plan.raises)
    rewritePinsInFile(join(REPO_ROOT, PIN_FILE), plan.updates)
    console.log(
      plan.updates.length === 0
        ? '  Nothing written — every pin already equals its census.'
        : '  Written. Read the deltas before you commit them: this census moves in both directions with any '
          + 'commit to a cited file, so a fall THIS commit did not cause is a reading, not a repair.',
    )
    return 0
  }

  // P6.906 — the opt-in count check. Runs LAST because it is the only part of
  // this gate that spawns a child process per subject; everything above reads
  // the index once. P6.933 widened what it can run from 45 of 71 declarations to
  // 71 of 73, and the residue is ONE command: a `grep -rna` whose unquoted glob
  // means one thing after shell expansion and another without it.
  const countFindings: { probe: CountProbe; verdict: CountVerdict }[] = []
  let countsRun = 0
  let countsUnitOnly = 0
  // The two documents carry a TWIN of almost every cell, so the same command is
  // declared twice; caching by argv halves the child processes and is why this
  // costs seconds rather than tens of them.
  const grepCache = new Map<string, string>()
  const blobCache = new Map<string, string | null>()
  for (const probe of countProbes) {
    const verdict = checkCountProbe(probe, argv => {
      const key = argv.join('\u0000')
      const hit = grepCache.get(key)
      if (hit !== undefined) return hit
      const out = runGitGrep(argv)
      grepCache.set(key, out)
      return out
    }, grepProbe => {
      // One `git cat-file --batch` per distinct cited path, cached for the twin
      // in the second document — the same reason the argv cache above exists.
      let content = blobCache.get(grepProbe.path)
      if (content === undefined) {
        content = readIndexBlobs([grepProbe.path]).get(grepProbe.path) ?? null
        blobCache.set(grepProbe.path, content)
      }
      return content === null ? undefined : runGrepOnIndexBlob(grepProbe, content)
    })
    if (verdict.kind === 'not-runnable') countsUnitOnly += 1
    else if (verdict.kind === 'count') countsRun += 1
    if (verdict.kind === 'unit-mismatch'
      || verdict.kind === 'zero-floor'
      || (verdict.kind === 'count' && countIsWrong(probe, verdict.actual))) {
      countFindings.push({ probe, verdict })
    }
  }

  if (update) {
    const written = writeBaseline([
      ...deadPaths, ...deadLines, ...driftedIdentifiers, ...driftedRows, ...absentSymbols,
      ...ambiguousAnchors, ...brokenRowIds, ...mismatchedControls, ...escapedAlternations,
    ])
    console.log(
      `check-ledger-citations: baseline written with ${deadPaths.length} path(s), ${deadLines.length} line(s), `
      + `${driftedIdentifiers.length} identifier(s), ${driftedRows.length} row id(s), `
      + `${absentSymbols.length} symbol(s), ${ambiguousAnchors.length} anchor(s) and `
      + `${brokenRowIds.length} split row id(s), ${mismatchedControls.length} out-of-scope control(s) and `
      + `${escapedAlternations.length} escaped-alternation probe(s); `
      + `${written.added} added, ${written.dropped} no longer found.`,
    )
    // The census is printed HERE as well, because this is the command that makes
    // a rise invisible: after an update every finding is baselined and `--check`
    // is green whatever the number did.
    reportPlanCensus(planCensus, planOutcome)
    // Printed here too: a lane running this command is the lane whose conversions
    // just moved these two numbers, and lowering the pins belongs in that commit.
    reportUnattachedCensus(unattached, unattachedPath, unattachedBare)
    reportShorthandCensus(shorthands, shorthandOutcome)
    return 0
  }

  const baseline = readBaseline()
  const fresh = findings.filter(finding => !baseline.has(deadPathBaselineKey(finding)))
  const freshLines = lineFindings.filter(finding => !baseline.has(deadLineBaselineKey(finding)))
  const freshIdentifiers = identifierFindings.filter(finding => !baseline.has(identifierBaselineKey(finding)))
  const freshRows = rowFindings.filter(finding => !baseline.has(rowBaselineKey(finding)))
  const freshSymbols = symbolFindings.filter(finding => !baseline.has(symbolBaselineKey(finding)))
  const freshAnchors = anchorFindings.filter(finding => !baseline.has(anchorBaselineKey(finding)))
  const freshSplitRows = splitRows.filter(finding => !baseline.has(splitRowIdBaselineKey(finding)))
  const freshControls = controlFindings.filter(finding => !baseline.has(controlScopeBaselineKey(finding)))
  const freshDialects = dialectFindings.filter(
    finding => !baseline.has(escapedAlternationBaselineKey(finding)),
  )

  for (const finding of findings) {
    const known = baseline.has(deadPathBaselineKey(finding)) ? ' (in the baseline)' : ''
    const hint = finding.elsewhere.length > 0
      ? `\n    the same basename is tracked at: ${finding.elsewhere.join(', ')}`
      : '\n    no tracked file of that name anywhere — the citation may never have been true'
    console.log(`${finding.citation.doc}:${finding.citation.line}  ${finding.citation.text}${known}${hint}`)
  }

  for (const finding of lineFindings) {
    const known = baseline.has(deadLineBaselineKey(finding)) ? ' (in the baseline)' : ''
    const why = finding.reason === 'blank'
      ? 'that line is blank'
      : finding.reason === 'past-eof'
        ? 'that line is past the end of the file'
        : 'the range ends past the end of the file'
    console.log(
      `${finding.citation.doc}:${finding.citation.line}  ${finding.citation.text}${known}`
      + `${writtenAs(finding.citation)}`
      + `\n    ${why} — the file has ${finding.lineCount} line(s) in the index`,
    )
  }

  for (const finding of identifierFindings) {
    const known = baseline.has(identifierBaselineKey(finding)) ? ' (in the baseline)' : ''
    console.log(
      `${finding.citation.doc}:${finding.citation.line}  ${finding.citation.text}${known}`
      + `${writtenAs(finding.citation)}`
      + `\n    the sentence names \`${finding.identifier}\`, which is not in lines ${finding.from}-${finding.to}`
      + ` of that file (${finding.lineCount} line(s) in the index) — the anchor drifted, or the identifier did`,
    )
  }

  for (const finding of rowFindings) {
    const known = baseline.has(rowBaselineKey(finding)) ? ' (in the baseline)' : ''
    const why = finding.reason === 'missing'
      ? `that document has no \`| ${finding.rowId} |\` row at all — it was renamed or removed`
      : `the \`${finding.rowId}\` row is at line ${finding.rowLine}, not in lines ${finding.from}-${finding.to}`
        + ' — the anchor drifted, or the row did'
    console.log(
      `${finding.citation.doc}:${finding.citation.line}  ${finding.citation.text}${known}`
      + `\n    the sentence names the \`${finding.rowId}\` row and ${why}`
      + ` (${finding.lineCount} line(s) in the index)`,
    )
  }

  for (const finding of symbolFindings) {
    const known = baseline.has(symbolBaselineKey(finding)) ? ' (in the baseline)' : ''
    console.log(
      `${finding.citation.doc}:${finding.citation.line}  ${finding.citation.text}${known}`
      + `\n    the sentence names the symbol \`${finding.symbol}\`, which does not occur anywhere in that file`
      + ` (${finding.lineCount} line(s) in the index) — it was renamed, removed, or never lived there`,
    )
  }

  for (const finding of anchorFindings) {
    const known = baseline.has(anchorBaselineKey(finding)) ? ' (in the baseline)' : ''
    const why = finding.occurrences === 0
      ? 'which does not occur in that file at all — it was rewritten, or never lived there'
      : `which occurs ${finding.occurrences} times in that file — it no longer locates ONE place`
    console.log(
      `${finding.citation.doc}:${finding.citation.line}  ${finding.citation.text}${known}`
      + `\n    the sentence names the anchor \`${finding.anchor}\`, ${why}`
      + ` (${finding.lineCount} line(s) in the index)`,
    )
  }

  for (const finding of splitRows) {
    const known = baseline.has(splitRowIdBaselineKey(finding)) ? ' (in the baseline)' : ''
    console.log(
      `${finding.doc}:${finding.line}  ${finding.text}${known}`
      + `\n    a qualifier landed INSIDE the row id \`${finding.rowId}\` — lift `
      + `\`${finding.qualifier}\` out onto the sentence it qualifies and the id reads again`,
    )
  }

  for (const finding of controlFindings) {
    const known = baseline.has(controlScopeBaselineKey(finding)) ? ' (in the baseline)' : ''
    const what = finding.kind === 'file'
      ? `names \`${finding.control}\`, which the index resolves to \`${finding.outside}\``
      : `runs \`${finding.control}\`, whose pathspec \`${finding.outside}\``
    console.log(
      `${finding.doc}:${finding.line}  positive control out of scope${known}`
      + `\n    the probe \`${finding.probe}\` ran over ${finding.probePathspec.join(' ')}`
      + ` (from the ${finding.probeSource === 'argv' ? 'command' : 'prose beside it'})`
      + `\n    the control ${what} — outside that pathspec, so the control could not have failed`
      + ' where the probe ran. Re-take it in the probe\'s own scope, or say which scope it was taken in.',
    )
  }

  for (const finding of dialectFindings) {
    const known = baseline.has(escapedAlternationBaselineKey(finding)) ? ' (in the baseline)' : ''
    console.log(
      `${finding.doc}:${finding.line}  escaped alternation under \`${finding.flag}\`${known}`
      + `\n    \`${finding.command}\``
      + `\n    the pattern \`${finding.pattern}\` spells its alternation with a BACKSLASH, which is an`
      + ' alternation only in the default basic regex — under `-E`/`-P` it matches one literal pipe, so this'
      + ' probe searches for a string nothing spells and its reading cannot answer what the sentence asks.'
      + ' Drop the backslash (or drop the engine flag), re-run, and write the number it answers then. If a'
      + ' literal pipe really is the subject, baseline this with that reason: nothing in the argv can tell.',
    )
  }

  for (const { probe, verdict } of countFindings) {
    const actual = verdict.kind === 'count' ? verdict.actual : 0
    const why = verdict.kind === 'unit-mismatch' || verdict.kind === 'zero-floor'
      ? verdict.why
      : probe.floor
        ? `answers ${actual} today, BELOW the declared floor of ${probe.declared}`
        : `answers ${actual} today against the declared ${probe.declared}`
    console.log(
      `${probe.doc}:${probe.line}  ${probe.unit}${probe.floor ? '>=' : '='}${probe.declared}  \`${probe.command}\``
      + `\n    ${why}`,
    )
  }

  // One summary line per arm and never a merged one: the first is quoted verbatim in
  // several lane reports and in the baseline's own header, and a reader
  // comparing today's run against one of those must be able to see the same
  // sentence rather than a reworded one that happens to carry the same numbers.
  console.log(
    `check-ledger-citations: ${findings.length} dead citation(s) over ${deadPaths.length} distinct path(s), `
    + `out of ${citations.length} repo-file citation(s) in ${LEDGERS.length} document(s); ${fresh.length} NOT in the baseline.`,
  )
  console.log(
    `check-ledger-citations: ${lineFindings.length} dead line citation(s) over ${deadLines.length} distinct `
    + `citation(s), out of ${lineCitations} line-tailed citation(s) checked; ${freshLines.length} NOT in the baseline.`,
  )

  console.log(
    `check-ledger-citations: ${identifierFindings.length} drifted identifier citation(s) over `
    + `${driftedIdentifiers.length} distinct citation(s), out of ${identifierSubjects} citation(s) whose sentence `
    + `attaches an identifier; ${freshIdentifiers.length} NOT in the baseline.`,
  )

  console.log(
    `check-ledger-citations: ${rowFindings.length} unresolved row-id citation(s) over ${driftedRows.length} `
    + `distinct citation(s), out of ${rowSubjects} citation(s) whose sentence names a ledger row; `
    + `${freshRows.length} NOT in the baseline.`,
  )

  console.log(
    `check-ledger-citations: ${symbolFindings.length} absent symbol citation(s) over ${absentSymbols.length} `
    + `distinct citation(s), out of ${symbolSubjects} citation(s) whose sentence names a symbol; `
    + `${freshSymbols.length} NOT in the baseline.`,
  )

  console.log(
    `check-ledger-citations: ${anchorFindings.length} anchor citation(s) that do not occur EXACTLY once over `
    + `${ambiguousAnchors.length} distinct citation(s), out of ${anchorSubjects} citation(s) whose sentence `
    + `names an anchor; ${freshAnchors.length} NOT in the baseline.`,
  )

  console.log(
    `check-ledger-citations: ${splitRows.length} split row id(s) over ${brokenRowIds.length} distinct id(s) in `
    + `${LEDGERS.length} document(s); ${freshSplitRows.length} NOT in the baseline.`,
  )

  console.log(
    `check-ledger-citations: ${unreachable} citation(s) of a file that is on this disk and NOT in the index `
    + `(${unreachablePaths.size} distinct path(s), ${unreachableTailed} with a :line tail) — the vendored `
    + 'bundles and the build outputs. UNCHECKED, never verified: their presence is machine-dependent and they '
    + 'move under lifts no lane caused.',
  )
  if (verbose) {
    for (const found of [...unreachablePaths].sort()) console.log(`    unchecked: ${found}`)
  }

  console.log(
    `check-ledger-citations: ${bareAdmitted} bare-filename citation(s) admitted by unique basename over `
    + `${bareDocs} of ${LEDGERS.length} document(s); ${bareAmbiguousSites.length} ambiguous and `
    + `${bareUnmatched} unmatched left UNCHECKED, ${bareMarkdown} markdown page name(s) skipped.`,
  )

  reportAmbiguousBareNames(bareAmbiguousSites, tracked, verbose)

  console.log(
    `check-ledger-citations: ${countFindings.length} declared count(s) wrong, out of ${countProbes.length} `
    + `probe(s) declaring a unit — ${countsRun} re-run, ${countsUnitOnly} unit-checked only `
    + '(neither a `git grep` nor a counting `grep` over one literal path, or shell-dependent).',
  )

  console.log(
    `check-ledger-citations: ${controlFindings.length} positive control(s) taken OUTSIDE their probe's own `
    + `pathspec over ${mismatchedControls.length} distinct key(s), out of ${controlSubjects} control(s) beside a `
    + `probe whose pathspec is readable — ${controlContained} of those sit inside it and ${controlDeclined} are `
    + 'DECLINED (the control names neither a command with a pathspec nor a resolvable file after a non-zero '
    + `count); ${freshControls.length} NOT in the baseline.`,
  )

  console.log(
    `check-ledger-citations: ${dialectFindings.length} declared probe(s) whose \`-E\`/\`-P\` command spells an `
    + `alternation as a BACKSLASH and a pipe over ${escapedAlternations.length} distinct key(s), out of `
    + `${countProbes.length} probe(s) declaring a unit — each is re-run above, so its reading is a literal-pipe `
    + `search the gate would otherwise confirm forever; ${freshDialects.length} NOT in the baseline.`,
  )

  reportPlanCensus(planCensus, planOutcome)
  reportUnattachedCensus(unattached, unattachedPath, unattachedBare)
  reportShorthandCensus(shorthands, shorthandOutcome)

  const red = fresh.length + freshLines.length + freshIdentifiers.length + freshRows.length
    + freshSymbols.length + freshAnchors.length + freshSplitRows.length + freshControls.length
    + freshDialects.length
    + countFindings.length
    + (planOutcome === 'rose' ? 1 : 0)
    + (unattachedPath === 'rose' ? 1 : 0) + (unattachedBare === 'rose' ? 1 : 0)
    + (shorthandOutcome === 'rose' ? 1 : 0)
  return check && red > 0 ? 1 : 0
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
