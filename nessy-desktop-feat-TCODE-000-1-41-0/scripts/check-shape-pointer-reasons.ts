/**
 * check-shape-pointer-reasons — a stated reason that POINTS at a sibling test's
 * shape is a claim about a file the author does not own, and nothing looked.
 *
 * D1.303, widened by D1.318, and given its third claim by D1.329.
 *
 * ## The class, measured
 *
 * D1.242 asked, for each test that hand-builds a `SessionManager` double and
 * STATES why, either to leave the reason or to replace it with a measurement.
 * Reading the thirteen, WI-ah found that four of them state no argument at all:
 * they point at a sibling — *"the same shape as `X.test.ts`"* — which is an
 * assertion about ANOTHER FILE'S construction. **TWO of the seven pointers in
 * that family were already FALSE** when that lane started (2026-09-18): WI-y had
 * converted `SessionManager.agent-view.test.ts` and
 * `SessionManager.hook-effort-input.test.ts` hours earlier, and the converting
 * commit had no reason to open the two files whose docblocks named them. The
 * other five stayed true only because one lane happened to move both ends.
 *
 * That is AGENTS.md's own trap — *"a comment asserting what a DIFFERENT module
 * does has no guard, and the module that falsifies it has no reason to look"* —
 * one corpus over, in test prose instead of source prose. Three defences miss it
 * the same way they miss the original: it is not a decaying line anchor (there
 * is no line to re-resolve), it is not testable from where it lives (no case in
 * the pointing file can fail because a sibling was refactored), and the
 * falsifying commit is in the OTHER file.
 *
 * ## The definition of "the shape" is a DECISION, and here it is
 *
 * A sentence cannot be parsed for its meaning, so this gate does not try. It
 * makes three narrowings, each of which is a decision rather than a sweep:
 *
 *  0. **Every test-file name written in ANY comment must resolve to a tracked
 *     file** — the `mentioned` claim (D1.329), which needs no sentence rule and
 *     no pointer word at all. It is the widest population and the weakest claim,
 *     and it is what a rename actually breaks: D1.321 found FIFTEEN such names
 *     over thirteen files, four of them a spelling one character off and six
 *     naming a file that never existed. {@link EXPLAINED_MENTIONS} carries the
 *     six a reader is right to leave dead, with a reason each.
 *  1. **Whether the pointing file carries one of {@link CONSTRUCTIONS} picks the
 *     CLAIM, and no longer whether the sentence is read at all.** In the family
 *     the claim is that the sibling is built the same way; outside it — every
 *     production module and most test files — the claim is the weakest one the
 *     sentence supports, that the named file EXISTS. D1.303 dropped the second
 *     population entirely, which cost the five production pointers D1.318 was
 *     born for. {@link ClaimKind} carries the reason the stronger reading (match
 *     the sibling's `describe` titles) was refused.
 *  2. **The claim is the pointing file's OWN construction set.** *"The same
 *     shape as `X`"*, said by a file that hand-builds a double, claims `X`
 *     hand-builds one; said by a file on the real-constructor harness, it claims
 *     `X` is on the harness. So the table carries BOTH spellings of this family
 *     and the gate catches the decay in either direction — the sibling
 *     converting, and the pointer converting while the sibling did not.
 *  3. **The pointer and the sibling must be in ONE SENTENCE of ONE comment.**
 *     AGENTS.md records a guard that paired an identifier with the wrong
 *     citation by reading the first backticked token after an anchor; a docblock
 *     forty lines long would pair anything with anything. A blank comment line
 *     ends a sentence here, because a paragraph break is where prose changes
 *     subject.
 *
 * The trigger word is `shape` rather than a list of phrases. A phrase list
 * ("same shape", "this suite's established shape", "as X does") is what the row
 * was born describing, and over this tree it MISSES the real spellings: today's
 * nine include *"`X`'s shape"*, *"Harness shape follows `X`"*, *"the shape `X`
 * established"*, *"verbatim in shape"* and *"this suite's established shape
 * (`X` does the same)"*. A gate against silent decay must not itself decay the
 * day someone writes the sentence a different way.
 *
 * ## What it CANNOT see, stated rather than hidden
 *
 *  - A pointer at a shape that is not a construction — a stubbing style, an
 *    assertion table, a fixture layout. Nothing in the text says which, so those
 *    are the {@link EXPLAINED_PAIRS}, named with a reason each.
 *  - A pointer that names no file ("the sibling beside this one"). Deliberate:
 *    such a sentence has no resolvable claim, and `user-prompt-expansion.test.ts`
 *    is the live example — WI-ah rewrote its dead pointer into words on
 *    2026-09-18, and it correctly leaves this census.
 *  - A second family. Adding one is a row in {@link CONSTRUCTIONS}, which is why
 *    the table is a table.
 *
 * ## The reading this shipped with (2026-09-18, D1.329, at `5c02f2796`)
 *
 * **108 pointers over 5 096 source files; 104 gated, 4 explained, ZERO broken —
 * and ZERO dead mentions with 6 explained.** Ten pointers make the `carries`
 * claim, 98 the `exists` claim, and 28 are written in production prose. The
 * universe gained `scripts/` here, which is where D1.321's census found four of
 * its own false deads. At D1.318 it read 99 over 4 790; at D1.303, nine over
 * 2 183 test files. Run the script for today's; a number in prose is a reading
 * with a date, as this repo says of its own.
 *
 * Two things the sentence rule decided about D1.318's own five lines, and both
 * are the rule working rather than being worked around:
 *
 *  - `backend/claude/turn-slot.ts` is NOT a pointer. Its line reads
 *    *"(`live-stream-consumer-baseline.test.ts` pins that). Under the old shape
 *    that…"* — the filename and the word are in two different SENTENCES, and a
 *    line grep is what paired them. Narrowing 3, on a real line.
 *  - `agent/base-agent.ts` names TWO siblings in one sentence and both are
 *    checked, which is why the pointer count is not the line count.
 *
 * At D1.303 it also found one the hand-reading did not
 * (`cd-session-command.test.ts` → `cd-permission-gate.test.ts`, *"the harness is
 * `cd-permission-gate.test.ts`'s, verbatim in shape"*) and correctly lost the one
 * that was rewritten into words.
 *
 * ## The control, and it is historical rather than planted
 *
 * The same census run over past revisions, with `--rev` (re-measured 2026-09-18
 * over D1.318's widened universe; the D1.303 readings of the same trees were
 * 10 / 10 / 9, and the two BROKEN are the same two):
 *
 * | revision | pointers | BROKEN | dead mentions |
 * | --- | ---: | ---: | ---: |
 * | `b377320e6`, before WI-y's nine conversions | 103 | **0** | 15 |
 * | `4f1a6a451`, WI-ah's launch HEAD | 104 | **2** | 15 |
 * | `e03ba84b9`, before D1.321's three repairs | 107 | 0 | **15** |
 * | HEAD | 108 | 0 | **0** |
 *
 * The fifteen are D1.321's, over THIRTEEN files — the row that born this one
 * says thirteen, which was the file count, and `module-graph-budgets.ts` alone
 * carries three of them. The same instrument-dependence D1.274 recorded.
 *
 * The two at `4f1a6a451` are `strict-drain-coalescing.test.ts` ->
 * `SessionManager.agent-view.test.ts` and `user-prompt-expansion.test.ts` ->
 * `SessionManager.hook-effort-input.test.ts`: the pair WI-ah found by hand, on
 * the tree they were actually wrong on, and the commit before is the same
 * instrument answering zero. A fixture can only show the rule works; this shows
 * it would have fired on the day it mattered — and the test pins both numbers,
 * over history, which cannot drift under a sibling lane.
 *
 * Usage:
 *   bun scripts/check-shape-pointer-reasons.ts            # report, always exit 0
 *   bun scripts/check-shape-pointer-reasons.ts --check    # exit 1 on a BROKEN pointer
 *   bun scripts/check-shape-pointer-reasons.ts --cached   # read the index, not the worktree
 *   bun scripts/check-shape-pointer-reasons.ts --rev <sha> # read a past tree; a reading, never a verdict
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'
import { parsePorcelainZ } from './git-status-z'
import { readFilesConcurrently } from './read-changed-files'
import { scanSpans } from './ts-comment-scan'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A construction a "same shape" sentence can be about.
 *
 * One family today. A second is a row here plus its fixture in the test — not a
 * new scanner, which is the whole reason this is a table and not a constant.
 *
 * The needle is matched against the source with its COMMENTS BLANKED, because
 * D1.274 measured this exact family's census counting comments as sites: after
 * nine conversions the naive number moved the WRONG WAY (50 -> 51) while the
 * population fell, since each conversion comment spelled the phrase it replaced.
 */
export interface Construction {
  /** Printed in the `claim` column. */
  readonly id: string
  /** Literal substring, matched in code only. */
  readonly needle: string
  /** What a reader should understand the claim to be. */
  readonly what: string
}

export const CONSTRUCTIONS: readonly Construction[] = [
  {
    id: 'sm-double',
    needle: 'Object.create(SessionManager.prototype)',
    what: 'a hand-built `SessionManager` double (D1.109/D1.242\'s population)',
  },
  {
    id: 'sm-harness',
    needle: 'createTestSessionManager(',
    what: 'the real-constructor harness `createTestSessionManager`',
  },
]

/**
 * The scanned universe: every TypeScript source under `packages` and `apps`,
 * test and production alike (D1.318).
 *
 * It was test files only until D1.318 measured what that missed: **five**
 * non-test lines pair the pointer word with a named test file, one of them a
 * literal *"see `utils/__tests__/session-list-collapse.test.ts` for the same
 * shape"*, and under the sentence rule the production population is **23**
 * pointers — plus two more in `__tests__/` SUPPORT files that are not named
 * `*.test.ts` and so were invisible to both spellings.
 *
 * `:(glob)` on every one of them. A bare `**` pathspec is read WITHOUT glob
 * magic by git and silently drops files — AGENTS.md §Traps records it costing a
 * count of 24 where the answer was 25.
 */
export const SOURCE_PATHSPEC: readonly string[] = [
  ':(glob)packages/**/*.ts',
  ':(glob)packages/**/*.tsx',
  ':(glob)apps/**/*.ts',
  ':(glob)apps/**/*.tsx',
  ':(glob)scripts/**/*.ts',
]

/**
 * {@link SOURCE_PATHSPEC}'s extension half, for the one command that cannot read
 * a `:(glob)` pathspec: `git ls-tree` refuses glob magic outright
 * (`pathspec magic not supported by this command: 'glob'`, measured
 * 2026-09-18), and `git ls-files --with-tree=<rev>` answers the UNION of the
 * index and that tree rather than the tree — 1 836 either way at HEAD, which is
 * the reading that looks like agreement and is not. So a revision is listed with
 * `ls-tree -r -z --name-only <rev> -- packages apps` and filtered by this. The test
 * asserts the two spellings select the same files.
 */
export const SOURCE_FILE_RE = /\.tsx?$/

/** A file that is itself a test, for the report's own breakdown only. */
export const TEST_FILE_RE = /\.(?:test\.tsx?|isolated\.ts)$/

/**
 * {@link SOURCE_PATHSPEC}'s roots, for the commands that take a plain pathspec.
 *
 * Derived rather than written twice: D1.329 added `scripts` to the pathspec and
 * left the revision listing at `packages apps`, so `--rev` scanned a NARROWER
 * universe than `--check` and its counts were quietly four short. The test
 * compares the two spellings for this reason.
 */
export const SOURCE_ROOTS: readonly string[] = [
  ...new Set(SOURCE_PATHSPEC.map(spec => spec.replace(':(glob)', '').split('/')[0] as string)),
]

/** The word that makes a sentence a shape claim. See the header for why not a phrase list. */
export const POINTER_WORD = /\bshapes?\b/i

/** A sibling test file named in prose. Basename only: a path stops at the slash. */
export const SIBLING_FILE = /[A-Za-z0-9_.-]+\.(?:test\.tsx?|isolated\.ts)/g

/**
 * A `*`/`?` immediately before a name makes it a GLOB — a FAMILY, not a file.
 *
 * D1.329, and it is a premise correction: the row calls the two survivors
 * "line-wrap artefacts" and asks for a continuation-line join. Read at HEAD they
 * are `*-real-server.test.ts` and `*-e2e.test.ts`, family patterns whose leading
 * `*` simply sits outside {@link SIBLING_FILE}'s character class. A join has no
 * case to serve here and would MANUFACTURE names by concatenating ordinary prose
 * across a line break, which is the opposite of what a census is for.
 */
export const GLOB_CHARS = new Set(['*', '?'])

/** {@link SIBLING_FILE} without the `g`, for the candidate prefilter. See `census`. */
export const MENTIONS_TEST_FILE = /\.(?:test\.tsx?|isolated\.ts)/

/**
 * The same shape for `git grep -E`, which is POSIX EXTENDED and not PCRE: `(?:`
 * is not a non-capturing group there, it is a repetition operator with no
 * operand, and git refuses the whole command
 * (`repetition-operator operand invalid`). Plain groups only — the sibling gate
 * `check-source-text-windows` carries the same note for the same reason.
 */
export const MENTIONS_TEST_FILE_ERE = '\\.(test\\.tsx?|isolated\\.ts)'

/**
 * A pairing the rule catches that is NOT a claim about a construction.
 *
 * Keyed by FILE and by the sibling it names, never by line: a line number has a
 * measured half-life of about two days in this tree. Each entry carries the
 * sentence's actual subject, because "explained" with no reason is
 * indistinguishable from "silenced".
 *
 * An entry the census no longer sees is printed as a WARNING on stdout and never
 * as a failure — the comment was rewritten or the file moved, and the next
 * reader should re-read it rather than meet a red they did not cause. That is
 * `check-mock-module-spread`'s posture for its baseline, for the same reason.
 */
export interface ExplainedPair {
  readonly file: string
  readonly sibling: string
  readonly reason: string
}

export const EXPLAINED_PAIRS: readonly ExplainedPair[] = [
  {
    file: 'packages/server-core/src/sessions/__tests__/plugin-monitor-skill-trigger.test.ts',
    sibling: 'monitor-command-gate.test.ts',
    reason:
      'the sibling is named as the NEGATIVE example — it is the file whose `beforeAll` import of '
      + '`SessionManager.ts` blows bun\'s 5 s hook budget — and the word "shape" in that sentence is '
      + 'AGENTS.md\'s failure shape, not a harness this file copies.',
  },
  {
    file: 'packages/server-core/src/sessions/SessionManager.agent-view.test.ts',
    sibling: 'pi-agent-view.test.ts',
    reason:
      'the "shape" is the one the PARSER expects of its fixtures (D1.323, written by a sibling lane '
      + 'on 2026-09-18 and caught by this gate the same day), and the sibling is named for what it '
      + 'FEEDS, not for how it builds a manager.',
  },
  {
    file: 'packages/server-core/src/sessions/SessionManager.child-error-outcome.test.ts',
    sibling: 'SessionManager.child-partial-output.test.ts',
    reason:
      'the "shape" is the shape a TURN takes (resolving versus throwing) and the sibling is named for '
      + 'what it already COVERS, not for how it builds its manager. It holds today on the construction '
      + 'reading too, so this entry is a statement of subject rather than a suppressed finding.',
  },
]

/**
 * A comment that NAMES a test file which does not exist, and is right to — D1.329.
 *
 * Six of them, each a different reason, and the row exists because thirteen
 * others were NOT right: D1.321 repaired thirteen dead pointers over thirteen
 * files (four spellings one character off, six names with no history at all,
 * three at a file a commit deliberately deleted). The census that found them
 * lived in a scratch probe; this is its home, so the next rename does not have
 * to be discovered by hand.
 *
 * Keyed by FILE and by the NAME, never by line.
 */
export const EXPLAINED_MENTIONS: readonly ExplainedPair[] = [
  {
    file: 'packages/shared/src/prompts/__tests__/format-tolerant-tags.test.ts',
    sibling: 'untrusted-text.test.ts',
    reason:
      'a "this file is NOT named X" sentence, kept as history: F1.1016 (f2789f0aa) renamed the suite AWAY from `untrusted-text.test.ts` because the P2.87 Pi bundle ledger then counted every `untrusted-text*` file as a copy of the module; since F1.1139 that walk skips `.test.` names, so the dead name is no longer load-bearing — the sentence records why the suite has its name (controller, 2026-09-28; F1.1139, 2026-10-09).',
  },
  {
    file: 'apps/cli/src/text-discard.test.ts',
    sibling: 'retry-stream.test.ts',
    reason:
      'provenance in ANOTHER repository — craft-agents-oss v0.13.4\'s `apps/cli/src/retry-stream.test.ts` (Apache-2.0), the upstream test this behaviour is ported from (F1.472).',
  },
  {
    file: 'apps/electron/src/renderer/event-processor/handlers/__tests__/requeued-steer-row.test.ts',
    sibling: 'probe-1333-renderer.test.ts',
    reason:
      'a lane or verifier PROBE: the file lived under the untracked `work/` tree (never committed, by the lane rules) and is cited as the measurement\'s provenance — the name is right to be dead in the repo (controller, 2026-09-24).',
  },
  {
    file: 'packages/server-core/src/sessions/__tests__/monitor-steer-origin.test.ts',
    sibling: 'probe-host-doors.test.ts',
    reason:
      'a lane or verifier PROBE: the file lived under the untracked `work/` tree (never committed, by the lane rules) and is cited as the measurement\'s provenance — the name is right to be dead in the repo (controller, 2026-09-24).',
  },
  {
    file: 'packages/server-core/src/sessions/__tests__/send-now-idle-clears-queued.test.ts',
    sibling: 'send-now-idle-isqueued.probe.test.ts',
    reason:
      'a lane or verifier PROBE: the file lived under the untracked `work/` tree (never committed, by the lane rules) and is cited as the measurement\'s provenance — the name is right to be dead in the repo (controller, 2026-09-24).',
  },
  {
    file: 'packages/shared/src/agent/__tests__/adjacent-backend-frozen-contract.test.ts',
    sibling: 'real-server.test.ts',
    reason:
      'a LINE-WRAPPED name: the comment spells `ephemeral-query-routing-real-server.test.ts` across two lines, and the census reads the second half as a file of its own; the full file exists.',
  },
  {
    file: 'packages/shared/src/agent/__tests__/claude-steer-fifo.test.ts',
    sibling: 'probe-subagent-drain.test.ts',
    reason:
      'a lane or verifier PROBE: the file lived under the untracked `work/` tree (never committed, by the lane rules) and is cited as the measurement\'s provenance — the name is right to be dead in the repo (controller, 2026-09-24).',
  },
  {
    file: 'packages/shared/src/agent/__tests__/codex-permission-denied-mcp-name.test.ts',
    sibling: 'f1274-probe.test.ts',
    reason:
      'a lane or verifier PROBE: the file lived under the untracked `work/` tree (never committed, by the lane rules) and is cited as the measurement\'s provenance — the name is right to be dead in the repo (controller, 2026-09-24).',
  },
  {
    file: 'packages/shared/src/agent/__tests__/codex-restart-teardown-retry.test.ts',
    sibling: 'codex-dispose-memo.probe.test.ts',
    reason:
      'a lane or verifier PROBE: the file lived under the untracked `work/` tree (never committed, by the lane rules) and is cited as the measurement\'s provenance — the name is right to be dead in the repo (controller, 2026-09-24).',
  },
  {
    file: 'scripts/check-conditional-expect.ts',
    sibling: 'zz-wjl-probe.test.ts',
    reason:
      'HISTORY: the comment records the measured incident in which a sibling lane deleted this untracked probe mid-scan — the deletion IS the point of the sentence.',
  },
  {
    file: 'packages/codex-responses-adapter/src/__tests__/anthropic-inbound.test.ts',
    sibling: 'claude-inbound.test.ts',
    reason:
      'provenance in ANOTHER repository — opencodex @ 16bef04 (MIT), whose own test this one is '
      + 'adapted from. AGENTS.md requires that citation for adapted code; deleting it to satisfy a '
      + 'census would be the worst trade available here.',
  },
  {
    file: 'packages/codex-responses-adapter/src/__tests__/anthropic-outbound.test.ts',
    sibling: 'claude-outbound.test.ts',
    reason: 'the same opencodex @ 16bef04 (MIT) provenance, for the outbound half.',
  },
  {
    file: 'packages/shared/src/agent/__tests__/codex-fallback-chain-ladder.test.ts',
    sibling: 'codex-fallback-chain-inert.test.ts',
    reason:
      'HISTORY, stated where a reader meets the successor: this file opens "This file REPLACES …", '
      + 'naming the suite its own commit (`16b691036`) deliberately deleted. The sentence is true.',
  },
  {
    file: 'packages/shared/src/plugins/__tests__/async-hook-delivery.test.ts',
    sibling: 'async-rewake-not-executed.test.ts',
    reason:
      'the same REPLACES shape: `41a716876` deleted that suite once its refusal stopped being true, '
      + 'and this file says so in its first paragraph.',
  },
  {
    file: 'scripts/check-shape-pointer-reasons.ts',
    sibling: 'X.test.ts',
    reason: 'a PLACEHOLDER in this file\'s own docblock, where the rule is being explained.',
  },
  {
    file: 'scripts/check-shape-pointer-reasons.ts',
    sibling: 'foo.test.ts',
    reason: 'a PLACEHOLDER in this file\'s own prose about the sentence splitter.',
  },
  {
    file: 'packages/server-core/src/sessions/__tests__/queue-dto-steerable.test.ts',
    sibling: 'queue-dto-count.probe.test.ts',
    reason: 'a lane PROBE (WJ-qq-b, under the untracked work/ tree) named as the provenance of the end-to-end arm this file landed.',
  },
  {
    file: 'packages/shared/src/agent/__tests__/claude-runtime-own-turn-fold.test.ts',
    sibling: 'probe-f1528.test.ts',
    reason: 'a lane PROBE (WJ-ar, under the untracked work/ tree) named as the rig that measured the defect this file pins.',
  },
  {
    file: 'scripts/check-typecheck-coverage.test.ts',
    sibling: 'foo.test.ts',
    reason: 'a PLACEHOLDER for a lane\'s brand-new untracked test file, the case the git-listed sweep must keep seeing.',
  },
  {
    file: 'scripts/check-typecheck-coverage.ts',
    sibling: 'foo.test.ts',
    reason: 'a PLACEHOLDER for a lane\'s brand-new untracked test file, in the docblock explaining why untracked files stay in the sweep.',
  },
  {
    file: 'packages/server-core/src/sessions/__tests__/pending-plan-claim.test.ts',
    sibling: 'midstream-queue.test.ts',
    reason:
      'provenance in ANOTHER repository — craft-agents-oss v0.13.4\'s `server-core/src/sessions/midstream-queue.test.ts` '
      + '(Apache-2.0), the upstream claim case ("does not release pending plan execution for auto or failed compaction '
      + 'outcomes") whose assertion this suite\'s OWN describe below the comment now pins (UA4.9). The name is right to '
      + 'be dead in this repo, and the source+licence record is the plan\'s copying rule, not a stale pointer (UA12.130, 2026-10-03).',
  },
  {
    file: 'packages/server-core/src/tasks/__tests__/conductor-host.test.ts',
    sibling: 'session-created-notify.test.ts',
    reason:
      'a "this file REPLACES" sentence: the header names upstream craft-agents-oss v0.13.4\'s `sessions/session-created-notify.test.ts`, '
      + 'rewritten here as the `session_created` case — which lives in THIS file\'s own real-SessionManager describe (the '
      + 'announceSessionCreated arm), so there is no domestic sibling to repoint at and the upstream name is the provenance '
      + '(UA12.130, 2026-10-03).',
  },
  {
    file: 'packages/server-core/src/sessions/__tests__/pi-child-card-parent-count.test.ts',
    sibling: 'awaiting-approval-count.test.ts',
    reason:
      'a "this file REPLACES" sentence: F1.1096 (11a29253f) retired the named suite because it pinned the badge count and subject on '
      + 'its own COPY of the old per-session rule, and the properties only it held are read in THIS file\'s real-SessionManager '
      + 'describe below the comment — the dead name is the retirement\'s provenance, not a stale pointer (GF1, 2026-10-10).',
  },
  {
    file: 'packages/shared/src/agent/__tests__/f1906-first-turn-api-tool.test.ts',
    sibling: 'f1906-probe.test.ts',
    reason:
      'a lane or verifier PROBE: the file lived under the untracked `work/` tree (never committed, by the lane rules) and is cited '
      + 'as the measurement\'s provenance — the name is right to be dead in the repo (GF1, 2026-10-10).',
  },
]

/**
 * Dead mentions that are OURS. Zero, and it is a real zero rather than an empty
 * population: 1 616 names are checked to reach it, and D1.321 repaired thirteen
 * to get here.
 */
export const PINNED_DEAD_MENTIONS = 0

/**
 * The census size this shipped with — the probe alarm, not a quality bar.
 *
 * A new pointer is not a defect: it is one more claim that is now guarded. What
 * this number buys is that a census which suddenly answers 2 where it answered 9
 * is the SCANNER having broken (the `:(glob)` magic dropped, the comment scan
 * mis-parsing a file, the pathspec renamed) rather than the prose having
 * changed. Move it in the same commit that moves the population, and say which.
 */
export const PINNED_POINTERS = 142

/**
 * D1.275 — how far the pin may sit away from the tree before that is itself the
 * finding.
 *
 * Two rather than zero, in BOTH directions and deliberately: a lane that writes
 * or rewords one pointer should read a reminder, not a red. Sustained drift is
 * what a pin cannot see on its own, and it is what this refuses.
 */
export const SLACK_ALLOWANCE = 2

/** True when the pin is further from the tree than {@link SLACK_ALLOWANCE}. */
export function slackExceeded(
  found: number,
  pinned: number = PINNED_POINTERS,
  allowance: number = SLACK_ALLOWANCE,
): boolean {
  return Math.abs(pinned - found) > allowance
}

export type PointerVerdict = 'holds' | 'broken' | 'missing' | 'unresolved' | 'explained'

/**
 * Which of the two claims a pointer makes — D1.318.
 *
 * `carries` is the family claim of D1.303: the pointing file builds a
 * `SessionManager` one of two ways, so *"the same shape as `X`"* says `X` builds
 * it that way too.
 *
 * `exists` is what is left when the pointing file carries NO construction — every
 * production module, and most test files. **It is deliberately the weakest claim
 * the sentence supports, and the alternative was refused with a reason:** the
 * tempting second shape is *"the named test still tests the named subject"*,
 * matched against its `describe`/`it` titles. There is no way to derive the
 * subject FROM THE SENTENCE, so it would need a hand-written expectation for
 * each of the ninety — a claim a reader makes about a file they do not own,
 * which is the exact thing that decayed here. Read, do not invent: the strongest
 * mechanically checkable claim is that the file the sentence names exists.
 *
 * Weak is not worthless, and the number says so: **27 test files were renamed or
 * deleted in the last 400 commits** of this branch (measured 2026-09-18), and a
 * wider census of every test filename mentioned in any comment — 1 514 mentions
 * — found **21 that name no file that exists**. None of the 21 is inside a
 * pointer SENTENCE, which is why this gate ships green; they are a row of their
 * own rather than a baseline here.
 */
export type ClaimKind = 'carries' | 'exists' | 'mentioned'

export interface Pointer {
  /** Repo-relative path of the file whose comment makes the claim. */
  readonly file: string
  /** 1-based line the sentence starts on. */
  readonly line: number
  /** The sibling's basename, exactly as the sentence writes it. */
  readonly sibling: string
  /** Every file in the universe with that basename. */
  readonly siblingPaths: readonly string[]
  /** What each of those actually carries, in the same order — read once, so the report never re-reads disk. */
  readonly siblingCarries: readonly (readonly string[])[]
  /** The construction ids the POINTING file carries — what "the same shape" means here. */
  readonly claim: readonly string[]
  /** Which claim was checked: the family's construction, or mere existence. */
  readonly claimKind: ClaimKind
  readonly verdict: PointerVerdict
  /** The sentence, whitespace normalised, for the report line. */
  readonly sentence: string
  /** Present on an explained pair only. */
  readonly reason?: string
}

export interface CensusResult {
  /** Every pointer found, explained ones included. */
  readonly pointers: readonly Pointer[]
  /** The ones a verdict was computed for. */
  readonly gated: readonly Pointer[]
  /** `broken` + `missing` — the failures. */
  readonly broken: readonly Pointer[]
  readonly explained: readonly Pointer[]
  /** Entries of {@link EXPLAINED_PAIRS} this census did not see. */
  readonly staleExplanations: readonly ExplainedPair[]
  /** D1.329 — every `*.test.ts(x)` name written in a comment, pointer or not. */
  readonly mentions: readonly Pointer[]
  /** Mentions naming no tracked file and not in {@link EXPLAINED_MENTIONS}. */
  readonly deadMentions: readonly Pointer[]
  /** Mentions this tree is right to leave dead, with their reason. */
  readonly explainedMentions: readonly Pointer[]
  /** Entries of {@link EXPLAINED_MENTIONS} this census did not see. */
  readonly staleMentionExplanations: readonly ExplainedPair[]
  /** Files scanned — read the FILE COUNT before believing a zero. */
  readonly filesScanned: number
}

export interface SourceTree {
  /** Repo-relative paths of every SCANNED file. */
  readonly files: readonly string[]
  /**
   * Every tracked path, for RESOLVING a name — D1.321's correction.
   *
   * The two are not the same set and treating them as one cost four false deads:
   * a comment naming a `scripts/` test read as missing while the scanned universe
   * was `packages` + `apps`. Resolution is against the whole repository; scanning
   * is against source. Defaults to {@link files} for the in-memory fixtures.
   */
  readonly tracked?: readonly string[]
  read(path: string): string
  /**
   * The files that name a test file at all, if the tree can answer it cheaply —
   * a superset of every possible pointer, because a pointer must NAME one.
   * Optional: when absent the census reads every file instead, which is what the
   * in-memory fixtures do. Over the repo it is one `git grep` (0.17 s, 860 of
   * 4 790 files) against 4 790 reads, and the gate sits in `lint:chain`.
   */
  candidates?(): readonly string[]
}

export interface TreeOptions {
  /** Read the INDEX rather than the working tree — the neighbour-mid-edit control. */
  readonly cached?: boolean
  /**
   * Read a past REVISION instead — the historical control.
   *
   * It is what turns this gate's evidence from a fixture into a measurement:
   * *"was this pointer already false when it was written?"* is answerable, and
   * the answer at `4f1a6a451` was yes, twice. Takes precedence over `cached`.
   */
  readonly rev?: string
  /**
   * The repository to read: this one, unless a test hands it a throwaway repo —
   * the way `check-nul-bytes.ts`'s `SourceOptions.root` does (F1.452), so a path
   * git quotes can be planted without touching the shared tree.
   */
  readonly root?: string
}

function git(args: readonly string[], root: string = REPO_ROOT): string {
  try {
    return execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    // `git grep`/`ls-files` exit 1 with no output when nothing matches; that is
    // a reading, not a failure. Any other status must not read as empty.
    const status = (error as { status?: number }).status
    if (status === 1) return ''
    throw error
  }
}

/**
 * Read many blobs in ONE process — and on this rig that is not an optimisation,
 * it is the difference between a gate and an unusable one.
 *
 * Measured 2026-09-18 at load ~11, over the 860 candidate files (24.3 MB):
 *
 * | instrument | wall |
 * | --- | ---: |
 * | `git grep -al` over all 4 790 files (the prefilter) | **0.27 s** |
 * | `git cat-file --batch` over the 860 | **~2 s** |
 * | `readFileSync` over the same 860, from bun | **155 s** (`user 1.0 s`) |
 * | one `cat` process over the same 860 | **> 100 s** |
 *
 * 180 ms PER FILE OPEN at 1 s of CPU, and `cat` is as slow as bun, so it is the
 * filesystem and not the runtime — AGENTS.md §Traps records the same rig costing
 * 67 s to import one module and warning `Slow filesystem detected`. Git is fast
 * because it opens a handful of packfiles instead of 860 files.
 *
 * So EVERY mode reads through git. A clean file's working-tree bytes ARE its
 * index blob — that is what clean means — so the default reads `:<path>` for
 * every file `git status` does not report as modified, and opens only the
 * handful it does — all at once, up front, in {@link repoTree} (F1.622: one
 * after another they were this gate's remaining cost). No fidelity is traded
 * for the speed.
 *
 * The batch protocol: header line `<oid> <type> <size>`, then exactly that many
 * BYTES, then a newline. Parsed as a Buffer and sliced by the declared size,
 * never by searching for a separator: a source file may contain anything.
 */
function readBlobs(rev: string, paths: readonly string[], root: string = REPO_ROOT): Map<string, string> {
  const out = new Map<string, string>()
  if (paths.length === 0) return out
  const stdout = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: `${paths.map(path => `${rev}:${path}`).join('\n')}\n`,
    maxBuffer: 512 * 1024 * 1024,
  })
  let at = 0
  for (const path of paths) {
    const newline = stdout.indexOf(0x0a, at)
    if (newline < 0) break
    const header = stdout.toString('utf8', at, newline)
    const size = Number(header.split(' ')[2])
    // `<object> missing` has no size and no body — a path that is not in that
    // revision, which is a reading and not an error.
    if (!Number.isFinite(size)) { at = newline + 1; continue }
    out.set(path, stdout.toString('utf8', newline + 1, newline + 1 + size))
    at = newline + 1 + size + 1
  }
  return out
}

/** The repo's own sources, read from the working tree, the index or a revision. */
export async function repoTree(options: TreeOptions = {}): Promise<SourceTree> {
  const rev = options.rev
  const root = options.root ?? REPO_ROOT
  const blobs = new Map<string, string>()
  /**
   * Tracked files whose working tree differs from the index — the only ones the
   * default mode may not read as a blob. Empty in a quiet tree, and this lane
   * measured four (all another lane's).
   */
  // Every listing below is NUL-separated (F1.452): without `-z` git C-quotes a
  // path carrying a space, a quote, a backslash or a non-ASCII byte, a sliced
  // line keeps the quotes, and the file is read as its STALE blob — F1.271's
  // defect, which this gate carried verbatim. The porcelain goes through the one
  // parser every such gate shares.
  const dirty = rev !== undefined || options.cached === true
    ? new Set<string>()
    : parsePorcelainZ(git(['status', '--porcelain', '-z', '--', ...SOURCE_PATHSPEC], root))
  const files = rev === undefined
    ? git(['ls-files', '-z', '--', ...SOURCE_PATHSPEC], root).split('\0').filter(line => line !== '')
    : git(['ls-tree', '-r', '-z', '--name-only', rev, '--', ...SOURCE_ROOTS], root)
      .split('\0').filter(line => SOURCE_FILE_RE.test(line))
  /** `<rev>:` for a revision, `:` for the index — the same spelling either way. */
  const prefix = rev === undefined ? '' : rev
  const tracked = rev === undefined
    ? git(['ls-files', '-z'], root).split('\0').filter(line => line !== '')
    : git(['ls-tree', '-r', '-z', '--name-only', rev], root).split('\0').filter(line => line !== '')
  // F1.622 — every dirty TRACKED file (the only ones `read` can be asked for)
  // opened at once, here, instead of one by one as the census reaches them.
  const opened = tracked.filter(path => dirty.has(path))
  const reads = await readFilesConcurrently(opened.map(path => resolve(root, path)))
  const diskTexts = new Map<string, string>()
  opened.forEach((path, index) => {
    const read = reads[index]!
    if (read.ok) diskTexts.set(path, read.bytes.toString('utf8'))
  })
  const read = (path: string): string => {
    // A DELETED-but-still-indexed file is dirty and unopenable — ` D` is live in
    // this shared tree right now — so the fall-through is the blob, not a crash
    // of every lane's `lint:chain` because a neighbour is mid-delete. An
    // up-front read that failed is decided here exactly as before it existed.
    if (dirty.has(path)) {
      const text = diskTexts.get(path)
      if (text !== undefined) return text
      if (existsSync(resolve(root, path))) return readFileSync(resolve(root, path), 'utf8')
    }
    const cached = blobs.get(path)
    if (cached !== undefined) return cached
    const fetched = git(['show', `${prefix}:${path}`], root)
    blobs.set(path, fetched)
    return fetched
  }
  return {
    files,
    tracked,
    read,
    // `-a` and never `-I`: AGENTS.md §Traps records that the two are opposites
    // and the LAST one wins, so a command carrying both silently cancels the
    // `-a` an absence claim needs. `git grep <rev>` prefixes each name with
    // `<rev>:`, which is stripped here rather than left to bite the reader.
    candidates: (): readonly string[] => {
      const argv = [
        'grep', ...(rev === undefined && options.cached === true ? ['--cached'] : []),
        '-a', '-l', '-z', '-E', MENTIONS_TEST_FILE_ERE, ...(rev === undefined ? [] : [rev]),
        '--', ...SOURCE_PATHSPEC,
      ]
      const found = git(argv, root).split('\0')
        .filter(line => line !== '')
        .map(line => (rev === undefined ? line : line.slice(line.indexOf(':') + 1)))
      // One process for the whole candidate set — see `readBlobs`. The dirty
      // files are left out and opened individually by `read`.
      for (const [path, text] of readBlobs(prefix, found.filter(path => !dirty.has(path)), root)) {
        blobs.set(path, text)
      }
      return found
    },
  }
}

/** A tree over an in-memory map. The tests' fixtures are built with this. */
export function memoryTree(files: Readonly<Record<string, string>>): SourceTree {
  return {
    files: Object.keys(files),
    read: (path: string): string => files[path] ?? '',
  }
}

/**
 * Split comment text into sentences, keeping each one's offset.
 *
 * A terminator is `.!?:;` followed by whitespace (optionally through a closing
 * quote or bracket), or a blank comment line. A dot INSIDE a filename never
 * terminates: `foo.test.ts` ends in `s`, so the split cannot fall inside the one
 * token this gate has to read whole.
 *
 * The offset skips the sentence's own leading comment furniture (`/**`, `//`,
 * the `*` of a wrapped docblock line), so the line a report prints is the line
 * the sentence reads on rather than the line the comment opened on.
 */
export function splitSentences(body: string, base = 0): { text: string; at: number }[] {
  const breaks = /[.!?:;][`'")\]]*\s|\n[ \t]*\*?[ \t]*\n/g
  const furniture = /^\s*(?:\/\*+|\/\/)?[\s*]*/
  const out: { text: string; at: number }[] = []
  const push = (text: string, start: number): void => {
    out.push({ text, at: base + start + (furniture.exec(text)?.[0].length ?? 0) })
  }
  let start = 0
  let match: RegExpExecArray | null
  while ((match = breaks.exec(body)) !== null) {
    const end = match.index + match[0].length
    push(body.slice(start, end), start)
    start = end
  }
  if (start < body.length) push(body.slice(start), start)
  return out
}

/**
 * Which of {@link CONSTRUCTIONS} this source carries, comments blanked.
 *
 * The raw `includes` first is not a micro-optimisation: `blankComments` scans
 * every character of the file, and over the widened universe most candidates
 * mention no needle at all. Skipping the scan for those took the suite from
 * 188 s to seconds. The blanked check still decides, so D1.274's comment-counting
 * lesson is intact — a needle spelled in a comment answers `true` here and is
 * then dropped, exactly as before.
 */
export function constructionsIn(text: string): string[] {
  const possible = CONSTRUCTIONS.filter(construction => text.includes(construction.needle))
  if (possible.length === 0) return []
  const code = blankNonCode(text)
  return possible.filter(construction => code.includes(construction.needle)).map(c => c.id)
}

/**
 * `text` with every comment, string and template blanked — only CODE survives.
 *
 * Comments alone were not enough, and D1.329 measured why the day `scripts/`
 * entered the universe: THIS FILE holds both needles as string literals in
 * {@link CONSTRUCTIONS}, so a comment-only blanking read the gate itself as a
 * member of the family it gates, and four of its own docblock examples became
 * `carries` claims. A needle inside a string is never a call site. Same length
 * and same line numbers as the input, so an offset still means something.
 */
export function blankNonCode(text: string): string {
  const out = [...text]
  for (const span of scanSpans(text)) {
    if (span.kind === 'code') continue
    for (let i = span.start; i < span.end; i += 1) if (out[i] !== '\n') out[i] = ' '
  }
  return out.join('')
}

function normalise(sentence: string): string {
  return sentence.replace(/^[ \t]*\*[ \t]?/gm, ' ').replace(/\/\*+|\*+\/|\/\//g, ' ').replace(/\s+/g, ' ').trim()
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/**
 * The two tables are ONE lookup for a pointer: a name explained as a mention —
 * a placeholder, provenance in another repository — is explained for the same
 * reason when a sentence about shape happens to contain it.
 */
function explanationFor(file: string, sibling: string): ExplainedPair | undefined {
  return [...EXPLAINED_PAIRS, ...EXPLAINED_MENTIONS]
    .find(pair => pair.file === file && pair.sibling === sibling)
}

/**
 * Every shape pointer in `tree`, with its verdict.
 *
 * Two passes over the universe, because the second one has to resolve a sibling
 * by basename and cannot do that until the first has seen every file. The
 * expensive half — the comment scan — runs only on files that mention a
 * construction at all, which is 178 of 2 183 today.
 */
export function census(tree: SourceTree): CensusResult {
  const byBasename = new Map<string, string[]>()
  for (const path of tree.tracked ?? tree.files) {
    const list = byBasename.get(basename(path))
    if (list === undefined) byBasename.set(basename(path), [path])
    else list.push(path)
  }

  const constructionCache = new Map<string, string[]>()
  const constructionsOf = (path: string): string[] => {
    const cached = constructionCache.get(path)
    if (cached !== undefined) return cached
    const computed = constructionsIn(tree.read(path))
    constructionCache.set(path, computed)
    return computed
  }

  // `SIBLING_FILE` is global, and `.test()` on a global regex advances its
  // `lastIndex`, so alternate calls answer false on text that matches. The
  // prefilter gets its own non-global twin rather than a `lastIndex` reset.
  const candidates = tree.candidates?.() ?? tree.files.filter(path => MENTIONS_TEST_FILE.test(tree.read(path)))

  const pointers: Pointer[] = []
  const mentions: Pointer[] = []
  for (const path of candidates) {
    const text = tree.read(path)
    const spans = scanSpans(text).filter(
      span => span.kind === 'line-comment' || span.kind === 'block-comment',
    )
    const own = basename(path)

    // D1.329 — the MENTION half: every test-file name written in a comment, with
    // no sentence rule and no `shape` requirement, must resolve to a tracked
    // file. It is the weakest claim in the script and the widest population, and
    // it is what a rename actually breaks: 27 test files were renamed or deleted
    // in the last 400 commits of this branch.
    for (const span of spans) {
      const body = text.slice(span.start, span.end)
      for (const match of body.matchAll(SIBLING_FILE)) {
        const name = match[0]
        if (name === own) continue
        // `*-real-server.test.ts` names a FAMILY. The star sits outside the
        // character class, so without this the tail reads as a file.
        const before = body[(match.index ?? 0) - 1]
        if (before !== undefined && GLOB_CHARS.has(before)) continue
        const resolved = byBasename.get(name) ?? []
        const explanation = EXPLAINED_MENTIONS.find(
          pair => pair.file === path && pair.sibling === name,
        )
        if (resolved.length > 0 && explanation === undefined) continue
        mentions.push({
          file: path,
          line: lineOf(text, span.start + (match.index ?? 0)),
          sibling: name,
          siblingPaths: resolved,
          siblingCarries: [],
          claim: [],
          claimKind: 'mentioned',
          verdict: explanation !== undefined ? 'explained' : 'missing',
          sentence: normalise(body),
          ...(explanation === undefined ? {} : { reason: explanation.reason }),
        })
      }
    }

    // A pointer SENTENCE must contain the word, so a file without it anywhere
    // cannot hold one. `POINTER_WORD` is non-global, so `.test` here does not
    // advance a `lastIndex` the loop below would then inherit.
    if (!POINTER_WORD.test(text)) continue
    const claim = constructionsOf(path)
    const claimKind: ClaimKind = claim.length > 0 ? 'carries' : 'exists'

    for (const span of spans) {
      const body = text.slice(span.start, span.end)
      for (const sentence of splitSentences(body, span.start)) {
        if (!POINTER_WORD.test(sentence.text)) continue
        const named = new Set(
          [...sentence.text.matchAll(SIBLING_FILE)].map(match => match[0]).filter(name => name !== own),
        )
        for (const sibling of named) {
          const explained = explanationFor(path, sibling)
          const siblingPaths = byBasename.get(sibling) ?? []
          const siblingCarries = siblingPaths.map(constructionsOf)
          pointers.push({
            file: path,
            line: lineOf(text, sentence.at),
            sibling,
            siblingPaths,
            siblingCarries,
            claim,
            claimKind,
            verdict: explained !== undefined
              ? 'explained'
              : verdictFor(claim, siblingPaths, siblingCarries),
            sentence: normalise(sentence.text),
            ...(explained === undefined ? {} : { reason: explained.reason }),
          })
        }
      }
    }
  }

  const explained = pointers.filter(pointer => pointer.verdict === 'explained')
  const seen = new Set(explained.map(pointer => `${pointer.file}::${pointer.sibling}`))
  const mentionSeen = new Set(mentions.map(mention => `${mention.file}::${mention.sibling}`))
  return {
    pointers,
    gated: pointers.filter(pointer => pointer.verdict !== 'explained'),
    broken: pointers.filter(pointer => pointer.verdict === 'broken' || pointer.verdict === 'missing'),
    explained,
    staleExplanations: EXPLAINED_PAIRS.filter(pair => !seen.has(`${pair.file}::${pair.sibling}`)),
    mentions,
    deadMentions: mentions.filter(mention => mention.verdict === 'missing'),
    explainedMentions: mentions.filter(mention => mention.verdict === 'explained'),
    staleMentionExplanations: EXPLAINED_MENTIONS.filter(
      pair => !mentionSeen.has(`${pair.file}::${pair.sibling}`),
    ),
    filesScanned: tree.files.length,
  }
}

/**
 * The claim itself: the sibling carries every construction the pointing file
 * carries.
 *
 * A file carrying BOTH constructions makes the strongest claim, deliberately —
 * "the same shape" said by a mixed file is a sentence that has not said which,
 * and the right repair is to say which rather than to weaken the gate. Several
 * candidate siblings that DISAGREE are `unresolved` and never `broken`: the
 * check could not be made, and a red nobody can act on is the cry-wolf shape
 * this repo has paid for.
 */
export function verdictFor(
  claim: readonly string[],
  siblingPaths: readonly string[],
  siblingCarries: readonly (readonly string[])[],
): PointerVerdict {
  // Both claims fail the same way on a sibling that is not there, and that is
  // the half D1.318 measured as live: 27 test files were renamed or deleted in
  // the last 400 commits of this branch.
  if (siblingPaths.length === 0) return 'missing'
  // The `exists` claim is finished at that point — see {@link ClaimKind} for why
  // it is deliberately the weakest claim the sentence supports.
  if (claim.length === 0) return 'holds'
  const answers = siblingCarries.map(carried => claim.every(id => carried.includes(id)))
  if (answers.every(Boolean)) return 'holds'
  if (siblingCarries.length === 1) return 'broken'
  return 'unresolved'
}

export type Failure = 'broken' | 'dead-mention' | 'slack'

/**
 * What `--check` fails on, as a pure function of the census.
 *
 * Extracted so the exit-code decision has a test that does not need a broken
 * tree to exist: a suite that could only assert the exit code by planting a
 * false pointer in the real tree would have to restore it exactly, and AGENTS.md
 * records what a restore that misses costs every verdict after it.
 */
export function failures(result: CensusResult, rev?: string): Failure[] {
  const out: Failure[] = []
  if (result.broken.length > 0) out.push('broken')
  if (result.deadMentions.length > PINNED_DEAD_MENTIONS) out.push('dead-mention')
  if (rev === undefined && slackExceeded(result.pointers.length)) out.push('slack')
  return out
}

async function main(argv: readonly string[]): Promise<number> {
  const revAt = argv.indexOf('--rev')
  const rev = revAt < 0 ? undefined : argv[revAt + 1]
  // A historical read is a READING and never a verdict: the pin is a statement
  // about HEAD, and applying it to a past tree would report the past as broken.
  const check = argv.includes('--check') && rev === undefined
  const cached = argv.includes('--cached')

  const result = census(await repoTree({ cached, ...(rev === undefined ? {} : { rev }) }))
  const where = rev !== undefined ? `revision ${rev}` : cached ? 'index' : 'working tree'

  // A census that finds NOTHING while the pin expects a population is the probe
  // having broken, not the prose having changed. Refuse rather than print a
  // triumphant zero, which is the shape of a gate that has silently stopped
  // gating.
  if (result.pointers.length === 0 && PINNED_POINTERS > 0 && rev === undefined) {
    throw new GateSafetyRefusal(
      `REFUSED: the shape-pointer census found ZERO pointers in the ${where} where it expects `
      + `${PINNED_POINTERS}, over ${result.filesScanned} source file(s). That is the probe failing — check `
      + 'that the `:(glob)` magic is still on every pathspec (a bare `**` is read literally by git and '
      + 'silently drops files), that `CONSTRUCTIONS` still spells the needles the tree uses, and that '
      + '`ts-comment-scan` still reads these files (`unterminatedSpans` is its own alarm).',
    )
  }

  const carries = result.pointers.filter(pointer => pointer.claimKind === 'carries').length
  console.log(
    `check-shape-pointer-reasons: ${result.pointers.length} shape pointer(s) across `
    + `${result.filesScanned} source file(s) in the ${where} (pin ${PINNED_POINTERS}) — `
    + `${result.gated.length} gated, ${result.explained.length} explained, ${result.broken.length} BROKEN.`,
  )
  console.log(
    `  ${result.mentions.length - result.explainedMentions.length} dead mention(s) of a test file in a `
    + `comment, ${result.explainedMentions.length} explained (D1.329), over the same corpus.`,
  )
  console.log(
    `  ${carries} make the CARRIES claim (the pointing file is in a \`CONSTRUCTIONS\` family) and `
    + `${result.pointers.length - carries} make the weaker EXISTS claim; `
    + `${result.pointers.filter(pointer => !TEST_FILE_RE.test(pointer.file)).length} of them are written in `
    + 'production prose, which this gate could not see before D1.318.',
  )
  for (const pointer of result.pointers) {
    console.log(
      `  ${pointer.file}:${pointer.line} :: ${pointer.sibling} :: `
      + `${pointer.claimKind === 'carries' ? pointer.claim.join('+') : 'exists'} :: `
      + `${pointer.verdict === 'broken' || pointer.verdict === 'missing' ? pointer.verdict.toUpperCase() : pointer.verdict}`,
    )
  }

  for (const pair of [...result.staleExplanations, ...result.staleMentionExplanations]) {
    console.log('')
    console.log(
      `  WARNING (not a failure): the explained pair ${pair.file} -> ${pair.sibling} is not in this `
      + 'census any more. The comment was reworded or the file moved — re-read it and drop the entry '
      + 'from `EXPLAINED_PAIRS`, or correct the sibling name there.',
    )
  }

  const failing = failures(result, rev)

  if (failing.includes('broken')) {
    console.log('')
    console.log(`REFUSED: ${result.broken.length} shape pointer(s) claim something that is no longer true.`)
    for (const pointer of result.broken) {
      const carried = pointer.siblingPaths.length === 0
        ? 'no file of that name exists in packages/** or apps/**'
        : `${pointer.siblingPaths[0]} carries ${(pointer.siblingCarries[0] ?? []).join('+') || 'none of them'}`
      console.log(`  ${pointer.file}:${pointer.line}`)
      console.log(`    says: ${pointer.sentence}`)
      console.log(`    claims \`${pointer.sibling}\` carries ${pointer.claim.join('+')}, but ${carried}.`)
    }
    console.log(
      '  A pointer is a claim about a file you do not own, and the commit that falsifies it has no'
      + '\n  reason to open yours. Replace it with the ARGUMENT or the MEASUREMENT the reason actually is'
      + '\n  (D1.242 did exactly that for three of them), or name no sibling at all — a sentence with no'
      + '\n  resolvable claim leaves this census, which is the honest outcome when the shape is the'
      + '\n  point and the file is not.',
    )
    console.log(
      '  If the sentence is not about a CONSTRUCTION, add it to `EXPLAINED_PAIRS` in'
      + '\n  `scripts/check-shape-pointer-reasons.ts` WITH ITS REASON — the two entries there show the'
      + '\n  standard: say what the sentence is about, not that it is fine.',
    )
    if (!cached) {
      console.log(
        '  And before believing it at all: this read the WORKING TREE, so a sibling lane\'s uncommitted'
        + '\n  edit to a tracked file is in it. Re-run with `--cached` to read the index.',
      )
    }
  }

  if (result.gated.some(pointer => pointer.verdict === 'unresolved')) {
    console.log('')
    console.log(
      '  Some pointer names a basename that resolves to SEVERAL files which disagree about the'
      + '\n  construction. Reported and not failed: the check could not be made. Name the sibling'
      + '\n  unambiguously (the directory, or the fuller basename) and the verdict becomes real.',
    )
  }

  if (failing.includes('dead-mention')) {
    console.log('')
    console.log(
      `REFUSED: ${result.deadMentions.length} comment(s) name a test file that does not exist.`,
    )
    for (const mention of result.deadMentions) {
      console.log(`  ${mention.file}:${mention.line} -> ${mention.sibling}`)
    }
    console.log(
      '  A renamed or deleted test leaves the comment that named it behind, and the comment cannot'
      + '\n  fail on its own — 27 test files were renamed or deleted in the last 400 commits of this'
      + '\n  branch. Repoint it at the file that now holds the claim (read its ASSERTION, not its name),'
      + '\n  or say it in words. Keep the file\'s LINE COUNT: several of them are cited by line in docs.',
    )
    console.log(
      '  If the name is RIGHT to be dead — provenance in another repository, a "this file REPLACES"'
      + '\n  sentence, a placeholder — add it to `EXPLAINED_MENTIONS` in'
      + '\n  `scripts/check-shape-pointer-reasons.ts` WITH ITS REASON. The six there show the standard.',
    )
  }

  if (failing.includes('slack')) {
    console.log('')
    console.log(
      `  REFUSED: the census is ${Math.abs(PINNED_POINTERS - result.pointers.length)} away from the pin of `
      + `${PINNED_POINTERS}, more than the stated allowance of ${SLACK_ALLOWANCE}.`
      + `\n  Set PINNED_POINTERS to ${result.pointers.length} in the SAME commit that moved the population,`
      + '\n  and say in the message which way it moved and why. The pin is the probe alarm: a census that'
      + '\n  collapses is the scanner breaking, and a pin nobody maintains cannot tell you that.',
    )
  }

  return check && failing.length > 0 ? 1 : 0
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  })
}
