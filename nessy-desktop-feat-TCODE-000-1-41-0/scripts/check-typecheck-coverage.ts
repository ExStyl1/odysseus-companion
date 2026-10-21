/**
 * check-typecheck-coverage — every workspace package must be typechecked, and
 * the ones deliberately left out must say so HERE, with a reason that can go
 * stale out loud.
 *
 * P3.131, and the twin of `check-eslint-coverage.ts`. That script exists
 * because a package with no lint config and a package that lints clean are
 * indistinguishable from the outside. This one exists because the same is true
 * of typechecking, and it has now cost four measurements:
 *
 *   - `packages/pi-agent-server` — in the chain, but its config excluded
 *     `**\/*.test.ts`, all 85 of them, in one line. Re-measured 2026-08-28: the
 *     glob was hiding 423 errors, of which 206 were `server-core`'s and were an
 *     artefact of a missing path mapping. 53 test files are in the program now;
 *     the residue is 32 files named individually in that config (P3.132).
 *   - `packages/codex-agent-server` — no tsconfig, outside the chain; its
 *     source was covered transitively through `shared` while its SEVEN test
 *     files were covered by nothing (P3.117). One real error, found the day it
 *     was wired in.
 *   - `packages/session-mcp-server` — had a tsconfig, WAS linted, and SHIPS as
 *     a bundled subprocess; four real errors on the day it was wired in
 *     (P3.130).
 *   - `apps/ios` — a 116-file, 97-Swift client that is not a workspace PACKAGE
 *     at all (no package.json), so every check above was blind to it: when
 *     P2.352 named it, it was in neither `typecheck:all` nor AGENTS.md's
 *     Monorepo Map, which meant any sweep scoped by that map had never seen it.
 *     It cannot be typechecked — there is no TypeScript in it — but "cannot be
 *     typechecked" and "nobody has looked" are the two states this script exists
 *     to tell apart, so it is named below rather than left invisible. P2.370
 *     closed the map half and, on measuring rather than assuming, found the
 *     client already HAS a static gate — `.gitlab-ci.yml`'s `build-ios` — so the
 *     entry below now asserts both instead of describing an absence.
 *
 * Each was found by someone noticing, and the answer to "someone noticing"
 * four times is a derived list, not a fifth hand-maintained one.
 *
 * ## Why this is not a copy of the lint twin
 *
 * `check-eslint-coverage.ts` regexes each `lint:*` script for `cd <dir>`,
 * because the lint scripts are independent and each names its package from the
 * repo root. `typecheck:all` is the opposite shape: ONE chain of RELATIVE cds
 * (`cd packages/core && … && cd ../shared && …`), so `packages/shared` never
 * appears as a string anywhere and a regex would report every package missing.
 *
 * So the chain is SIMULATED — cwd walked segment by segment. That is strictly
 * stronger than matching text, and it automates the check P3.117 and P3.130
 * both had to do by hand: a `cd` that does not resolve, or that lands one
 * directory off, fails here instead of silently typechecking the wrong package
 * (or nothing) in CI.
 *
 * Usage:
 *   bun scripts/check-typecheck-coverage.ts           # check, exit 1 on a gap
 *   bun scripts/check-typecheck-coverage.ts --list    # print the coverage table, unmapped surfaces included
 *   bun scripts/check-typecheck-coverage.ts --tests   # P3.156 — NOT in the chain, see below
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The root script whose chain defines "typechecked in CI". */
const CHAIN_SCRIPT = 'typecheck:all'

interface RootPackageJson {
  workspaces?: string[]
  scripts?: Record<string, string>
}

/**
 * A package the chain deliberately does not reach.
 *
 * `reason` is prose for a human; `stale` is the machine-checked half, and the
 * pair is the whole point. A comment saying "dormant, checked elsewhere" keeps
 * reading true forever — including after the elsewhere is deleted. When `stale`
 * returns a string, the exclusion has stopped being true and this script fails
 * with that string, which is how a derived check differs from a fourth list.
 *
 * ## A reason rots in TWO directions, and `stale` has to cover both — P3.253
 *
 * `codex-protocol`'s reason carried the clause "every reference to them in this
 * tree is a comment" for long enough to be measured false at 25 non-comment
 * references, and its `stale` guard could not notice, because all three of its
 * checks asked about the excluded PACKAGE — a tsconfig, a `typecheck` script,
 * test files inside it. **An exclusion whose justification rots is exactly the
 * case this file exists to catch, and that guard was blind to it.**
 *
 * So write both classes:
 *
 *  1. **Claims about the package.** Has it acquired a program of its own? A
 *     tsconfig, a `typecheck` script, tests, a `src/`. Cheap, and the P3.117
 *     shape.
 *  2. **Claims about the rest of the tree.** Anything of the form "checked by X
 *     instead" or "consumed only by Y" — the substitutes and the consumers. Those
 *     are what actually make the exclusion safe, they live in files this entry
 *     does not own, and they are the half that goes stale in silence.
 *     {@link staleWhenLintChainEntryGone} and {@link staleWhenDriftTieGone} are
 *     that idiom: point the guard at the thing the reason NAMES. A third one,
 *     `staleWhenScriptGone`, checked only that a substitute script EXISTED and
 *     was deleted with its two callers in P6.738 — existence is not the claim,
 *     and it read healthy while `apps/webui` was red (see the note where those
 *     two exclusions used to be).
 *
 * A claim you cannot check mechanically should not be in the reason as an
 * absolute. Say what was measured and when, or drop it — an unguarded absolute
 * is the clause that will be false next.
 */
interface Exclusion {
  dir: string
  reason: string
  stale: (root: RootPackageJson) => string | null
}

const EXCLUSIONS: Exclusion[] = [
  {
    dir: 'packages/codex-protocol',
    reason:
      'Generated upstream bindings that nothing imports as a TypeScript MODULE, so no program ' +
      'pulls them in and none of the 655 `generated/*.ts` is typechecked. It has no src/, no ' +
      'tests and no tsconfig; the files come from `codex app-server generate-ts` and ' +
      'hand-editing them is forbidden. What checks them INSTEAD, which is what this exclusion ' +
      'rests on and what the guard below reads: `lint:codex-protocol` inside `lint:chain` lints ' +
      'every one of the 655 with no rule switched off (the package eslint config records 0 ' +
      'errors), and two drift ties parse two of them as SOURCE TEXT — ' +
      '`automations/runtime-hook-events.test.ts` reads `generated/v2/HookEventName.ts` and ' +
      '`agent/__tests__/codex-config-requirements.test.ts` reads ' +
      '`generated/v2/ConfigRequirements.ts`, each asserting a hand-restated table is total over ' +
      "codex's own type. P3.155 measured that a typecheck would gate ONE shape here (a dangling " +
      'cross-file reference) and be blind to the semantic drift those ties catch. What does NOT ' +
      'run, said out loud because it is the check a reader assumes exists: ' +
      '`check:codex:schema` regenerates from the pinned binary and diffs the whole of ' +
      '`generated/` and `schema/`, and it is networked and COMMENTED OUT in `.gitlab-ci.yml` ' +
      '(the runner cannot fetch the tarball), so it is a manual tool. Measured 2026-08-31, ' +
      'because a count beside a tree that moves is a reading with a date: 25 non-comment ' +
      'references to this package outside it, so the clause this reason used to carry — "every ' +
      'reference to them in this tree is a comment" — is false. `manifest.json` is imported as a ' +
      "JSON module through this package's own exports map by two production files and read by " +
      'path by four scripts; `schema/config-schema.json` is read by path nine times.',
    stale: (root) => {
      // F1.564 — the tsconfig, test-file and `src/` checks below read the
      // working-tree listing (`workingTreeFilesUnder`), not the disk: an IGNORED
      // tsconfig, test file or `src/` in a checkout is not part of this package.
      const files = workingTreeFilesUnder('packages/codex-protocol')
      const configs = files
        .map((file) => file.slice('packages/codex-protocol/'.length))
        .filter((file) => !file.includes('/') && /^tsconfig.*\.json$/.test(file))
      if (configs.length > 0) {
        return `packages/codex-protocol now has ${configs.join(', ')} — it has a program of its own, and nothing runs it. Add it to \`${CHAIN_SCRIPT}\` and delete this exclusion.`
      }

      const manifest = readPackageJson('packages/codex-protocol')
      if (manifest?.scripts?.typecheck !== undefined) {
        return `packages/codex-protocol now defines a \`typecheck\` script that \`${CHAIN_SCRIPT}\` never calls. Chain it and delete this exclusion.`
      }

      const tests = files.filter((file) => /\.test\.tsx?$/.test(file)).slice(0, 9)
      if (tests.length > 0) {
        return `packages/codex-protocol now has test files (${tests[0]}${tests.length > 1 ? `, +${tests.length - 1} more` : ''}) that no program contains — the exact shape of P3.117. Give it a tsconfig, chain it, and delete this exclusion.`
      }

      // P3.253 — the fourth structural sibling of the three above. A `src/`
      // appearing is hand-written TypeScript in a package the reason describes
      // as generated-only, and it is the P3.117/P3.130 shape exactly: source
      // covered transitively through an importer, or by nothing at all.
      if (files.some((file) => file.startsWith('packages/codex-protocol/src/'))) {
        return 'packages/codex-protocol now has a src/ directory, and this reason says it has none — hand-written TypeScript here is in no program. Give it a tsconfig, chain it, and rewrite this reason.'
      }

      // ---------------------------------------------------------------------
      // P3.253 — the half the four checks above structurally CANNOT do, and the
      // reason this exclusion's justification was allowed to rot.
      //
      // All four ask one question in different words: has this PACKAGE acquired
      // a program of its own? That is the P3.117 shape and worth catching. But
      // the reason does not rest on the package's shape. It rests on two claims
      // about the REST of the tree — that lint reads all 655 files, and that two
      // suites elsewhere parse two of them as source text. Those are the
      // SUBSTITUTES for the typecheck. Delete either and this entry goes on
      // reading true while 655 generated files fall back to nothing, which is
      // "a comment cannot notice a deletion" — the sentence this whole file is
      // built around — applied one level further out.
      //
      // So the two guards below point at the named SUBSTITUTE instead of at the
      // excluded directory, and each reads whether that substitute still runs
      // rather than whether it still exists. That is the
      // general lesson and the one to copy into the next exclusion: a reason
      // that names something OUTSIDE the package needs a guard that READS that
      // something.
      //
      // What this still cannot notice, stated rather than implied: it checks
      // that the substitutes EXIST, not that they still cover what they used to.
      // A tie could keep reading its generated file and stop asserting anything
      // over it, and `lint:codex-protocol` could keep its chain entry while a
      // rule is switched off in the package's own eslint config. Those are
      // claims about a file's MEANING, and the honest boundary of a text guard
      // is existence.
      //
      // Deliberately NOT guarded: "nothing imports them as a module". If a
      // consumer starts importing `@nessy-agent/codex-protocol` (whose `.` export
      // is `generated/index.ts`), `tsc` follows the import and checks the file
      // inside that consumer's own program — coverage goes UP, not down. A guard
      // that fires on an improvement is one the next lane switches off, so the
      // fact lives in the reason, where a reader who needs it will meet it.
      // ---------------------------------------------------------------------
      const lintGone = staleWhenLintChainEntryGone(root, 'packages/codex-protocol', 'lint:codex-protocol')
      if (lintGone !== null) return lintGone

      for (const tie of CODEX_PROTOCOL_DRIFT_TIES) {
        const tieGone = staleWhenDriftTieGone('packages/codex-protocol', tie)
        if (tieGone !== null) return tieGone
      }

      return null
    },
  },
]

/**
 * P6.738 — the two dormant Vite apps are IN the chain, and this is where their
 * exclusion used to be.
 *
 * `apps/viewer` and `apps/webui` were excluded with a `staleWhenScriptGone`
 * guard that checked the substitute script EXISTED. P6.722 measured what that
 * missed: `viewer:typecheck` and `webui:typecheck` each occurred exactly once in
 * package.json — their own definition — and in no chain and no CI job, so the
 * guard read healthy while `apps/webui` sat RED for an unknown length of time
 * with every gate in the repo green (three dead `ElectronAPI` members the
 * adapter kept re-declaring). "Checked by a named script instead" is only ever
 * as strong as something running that script.
 *
 * Controller decision 2026-09-07: chain both and delete the exclusions —
 * typecheck coverage is the standing rule (P3.131) and a dormant app that goes
 * red is a finding, not a nuisance. The scripts were renamed to
 * `typecheck:viewer`/`typecheck:webui` so they read as part of the family the
 * chain is built from. Nothing stands in for a chain entry any more, so
 * `staleWhenScriptGone` has no callers and is gone with them; the guard that
 * replaces it is the reachability check every other package already gets —
 * remove either entry from the chain and this script reports the app
 * unreachable, which `check-typecheck-coverage.test.ts` plants and asserts.
 *
 * The ops residue, recorded rather than hidden: both apps are downstream of
 * every wire change by construction (`apps/webui` imports
 * `apps/electron/src/transport` and `shared/types` directly), so a wire change
 * can now redden a lane's gate on an app nobody is working in. If that blocks a
 * lane more than once, THAT measurement reopens the question — the decision is
 * an ops posture, not a fact about the code.
 */

/** The chain that decides "linted in CI", the way {@link CHAIN_SCRIPT} decides typechecked. */
const LINT_CHAIN_SCRIPT = 'lint:chain'

/**
 * P3.253 — the guard for an exclusion whose substitute is a LINT script rather
 * than a typecheck one.
 *
 * Two failure modes, not one, and the second is the quiet one: the script can be
 * deleted, or it can survive while being dropped out of `lint:chain`, at which
 * point it still exists, still passes when run by hand, and runs nowhere in CI.
 *
 * This docblock used to justify a weaker sibling, `staleWhenScriptGone`, on the
 * grounds that "both its callers name a script the root invokes directly". That
 * premise was measured FALSE (P6.722): neither caller's script ran anywhere. Both
 * of those exclusions are gone — the apps are in the chain (P6.738) — and so is
 * the sibling. Any future exclusion resting on a substitute script wants BOTH
 * halves, which is what this function does.
 */
function staleWhenLintChainEntryGone(
  root: RootPackageJson,
  dir: string,
  scriptName: string,
): string | null {
  if (root.scripts?.[scriptName] === undefined) {
    return `${dir} is excluded from \`${CHAIN_SCRIPT}\` because the root \`${scriptName}\` script lints it instead — and that script is gone, so nothing checks its generated files at all. Restore it, or put ${dir} in the chain and rewrite this reason.`
  }
  const chain = root.scripts?.[LINT_CHAIN_SCRIPT]
  if (chain === undefined) {
    return `${dir}'s exclusion rests on \`${scriptName}\` running inside \`${LINT_CHAIN_SCRIPT}\`, and \`${LINT_CHAIN_SCRIPT}\` no longer exists. Rewrite this reason against whatever runs lint now.`
  }
  if (!chain.includes(scriptName)) {
    return `${dir} is excluded from \`${CHAIN_SCRIPT}\` because \`${scriptName}\` lints it inside \`${LINT_CHAIN_SCRIPT}\` — and \`${LINT_CHAIN_SCRIPT}\` no longer calls it, so the script survives and runs nowhere. Put it back in the chain, or put ${dir} in \`${CHAIN_SCRIPT}\`.`
  }
  return null
}

/**
 * P3.253 — the DRIFT TIES that stand in for a typecheck of
 * `packages/codex-protocol/generated`, as `[suite, generated file it parses]`.
 *
 * Each pair is measured, not assumed: the suite reads that generated file as
 * source text and asserts a hand-restated table is total over codex's own type.
 * P3.155 killed a mutant against each — dropping `"subagentStart"` from
 * `HookEventName` leaves `tsc` at exit 0 and reddens the first tie on two
 * assertions — which is why they, and not a typecheck, are what this exclusion
 * leans on.
 */
interface DriftTie {
  /** The suite that parses the generated file. */
  suite: string
  /** The generated file, from the repo root. */
  generated: string
  /**
   * The substring the suite must still contain to be reading that file. Spelled
   * separately because the two suites resolve the path differently — one from the
   * repo root, one relative through `../../../../` — and deriving it from
   * `generated` would make this guard depend on a spelling either suite is free
   * to change.
   */
  spelling: string
}

const CODEX_PROTOCOL_DRIFT_TIES: readonly DriftTie[] = [
  {
    suite: 'packages/shared/src/automations/runtime-hook-events.test.ts',
    generated: 'packages/codex-protocol/generated/v2/HookEventName.ts',
    spelling: 'packages/codex-protocol/generated/v2/HookEventName.ts',
  },
  {
    suite: 'packages/shared/src/agent/__tests__/codex-config-requirements.test.ts',
    generated: 'packages/codex-protocol/generated/v2/ConfigRequirements.ts',
    spelling: 'codex-protocol/generated/v2/ConfigRequirements.ts',
  },
]

/**
 * P3.253 — fail when a named drift tie has stopped reading the generated file it
 * was named for.
 *
 * Three distinguishable states, because "the tie is gone" and "the tie moved"
 * want different repairs: the generated file gone, the suite gone, or the suite
 * present and no longer naming the file. The last is the one a rename produces
 * and the one no structural check on the excluded package could ever see.
 *
 * The honest limit, stated because a guard that oversells itself is worse than
 * none: this proves the tie still READS the file, never that it still asserts
 * anything useful over it. Existence is where a text guard's authority ends.
 */
function staleWhenDriftTieGone(dir: string, tie: DriftTie): string | null {
  if (!existsSync(join(REPO_ROOT, tie.generated))) {
    return `${dir}'s exclusion names ${tie.generated} as one of the two files a drift tie parses, and that file is gone. Re-point the tie in ${tie.suite}, or rewrite this reason.`
  }
  const suitePath = join(REPO_ROOT, tie.suite)
  if (!existsSync(suitePath)) {
    return `${dir} is excluded from \`${CHAIN_SCRIPT}\` partly because ${tie.suite} parses ${tie.generated} as source text — and that suite is gone, so nothing catches a bad regeneration of it. Restore the tie, or chain the package and rewrite this reason.`
  }
  if (!readFileSync(suitePath, 'utf-8').includes(tie.spelling)) {
    return `${tie.suite} no longer reads ${tie.generated}, and ${dir}'s exclusion rests on it doing so. Re-point the tie, update CODEX_PROTOCOL_DRIFT_TIES to whatever replaced it, or chain the package.`
  }
  return null
}

/**
 * A directory a `workspaces` glob matches that is NOT a workspace package.
 *
 * Everything above answers "is this package typechecked?", and its universe is
 * the set of directories holding a `package.json`. `apps/ios` holds none, so it
 * is not in that universe — and neither is it in AGENTS.md's Monorepo Map, the
 * other list sweeps are scoped by. A surface in neither is not merely unchecked;
 * it is unLOOKED-at, and nothing in the repo said so out loud.
 *
 * `reason` and `stale` carry the same contract as `Exclusion` above: the prose
 * is for a human and the guard is the half a machine can falsify.
 */
interface UnmappedSurface {
  dir: string
  reason: string
  stale: () => string | null
}

const UNMAPPED_SURFACES: UnmappedSurface[] = [
  {
    dir: 'apps/ios',
    reason:
      'A Swift/Xcode client — 116 tracked files, 97 of them .swift — with no package.json, no ' +
      'TypeScript and therefore no program `tsc` could compile. It is excluded from the chain ' +
      'because there is nothing here for the chain to run, NOT because it is ungated: its static ' +
      "gate is `.gitlab-ci.yml`'s `build-ios` job (swift build + swift test, then xcodebuild " +
      'build/test against a simulator xcodebuild itself names), and this script cannot run one. ' +
      'What it CAN assert is that the premise has not changed — including that the job is still ' +
      'there, which is the half nothing else in this repo checks. P2.370 closed the two things ' +
      "that were open here: AGENTS.md's Monorepo Map now names apps/ios, and it is asserted " +
      'below rather than merely hoped for. What stays open is the SHAPE of that job: it runs only ' +
      'on `apps/ios/**` changes plus a manual trigger, so a change outside apps/ios that breaks ' +
      'the client is not caught by any pipeline. Making it unconditional is an owner call about ' +
      'runner minutes on a `macos` tag, not a lane call.',
    stale: () => {
      const dir = join(REPO_ROOT, 'apps/ios')
      if (!existsSync(dir)) return 'apps/ios no longer exists — delete this entry.'

      if (isWorkingTreeFile('apps/ios/package.json')) {
        return 'apps/ios now has a package.json, so it IS a workspace package and the checks above apply to it. Delete this entry and let it be checked (or excluded) like every other package.'
      }

      const typescript = findTypeScriptFiles('apps/ios')
      if (typescript.length > 0) {
        return `apps/ios now holds TypeScript (${typescript[0]}${typescript.length > 1 ? `, +${typescript.length - 1} more` : ''}), and this entry says it holds none. Give it a program and chain it, or rewrite this reason.`
      }

      // P2.370's two halves, both asserted rather than described. The map entry
      // could be dropped by anyone tidying AGENTS.md, and the CI job could be
      // dropped by anyone tidying a pipeline; either would silently restore the
      // unLOOKED-at state this entry exists to name, and neither would fail any
      // other check in the repo. The P2.352 guard deliberately did NOT assert
      // the map entry, because at that time asserting it would have shipped the
      // gate red — the entry exists now, so the assertion is finally available.
      const map = join(REPO_ROOT, 'AGENTS.md')
      if (!existsSync(map)) return 'AGENTS.md is gone, and this entry rests on its Monorepo Map naming apps/ios.'
      const mapText = readFileSync(map, 'utf-8')
      const mapSection = mapText.split('## Monorepo Map')[1]?.split('\n## ')[0] ?? ''
      if (!mapSection.includes('apps/ios')) {
        return "AGENTS.md's Monorepo Map no longer names apps/ios (P2.370). A surface in neither the map nor a package list is unLOOKED-at, not merely unchecked — restore the bullet, or rewrite this reason to say why the map need not name a whole client."
      }

      const ci = join(REPO_ROOT, '.gitlab-ci.yml')
      if (!existsSync(ci)) return '.gitlab-ci.yml is gone, and this entry rests on its `build-ios` job being apps/ios\'s static gate.'
      const ciText = readFileSync(ci, 'utf-8')
      if (!/^build-ios:/m.test(ciText)) {
        return 'The `build-ios` job is no longer in .gitlab-ci.yml, so apps/ios now has NO static gate at all — not a TypeScript one (it holds none) and not a Swift one. Restore the job, or rewrite this reason to say what replaced it.'
      }
      if (!ciText.includes('swift test')) {
        return 'The `build-ios` job no longer runs `swift test`, and this entry names it as the gate. Restore it, or rewrite this reason to name whatever the job asserts now.'
      }

      return null
    },
  },
]

/**
 * Any `.ts`/`.tsx`/`tsconfig*.json` under `dir` (repo-relative) — the trigger that
 * turns a non-TypeScript surface into one the chain must reach. F1.564: read from
 * the working-tree listing, so a dependency checkout inside an IGNORED SwiftPM
 * `.build/` does not read as TypeScript the client holds.
 */
function findTypeScriptFiles(dir: string, limit = 9): string[] {
  return workingTreeFilesUnder(dir)
    .filter((file) => {
      const name = basename(file)
      return (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) || /^tsconfig.*\.json$/.test(name)
    })
    .slice(0, limit)
}

/** The shape of what is in there, so the failure line says what was found rather than only where. */
function describeContents(dir: string): { files: number; extensions: string } {
  const counts = new Map<string, number>()
  // F1.564 — the working-tree listing, not a walk. The walk skipped every
  // dot-DIRECTORY as tooling (`.build`, `.swiftpm`) while counting dot-FILES,
  // because skipping those made it report 114 where `git ls-files` said 116 — a
  // count that disagrees with git is a count nobody trusts. Reading git's own
  // listing makes the count git's by construction, and an ignored tooling
  // directory is out by the repository's ignore rules instead of by a guess.
  const listed = workingTreeFilesUnder(dir)
  const files = listed.length
  for (const file of listed) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(basename(file))?.[1] ?? '(no extension)'
    counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }

  // A tie sorts by name: git's order is not a walk's, and the line should read
  // the same on every machine.
  const extensions = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([ext, n]) => `${n} .${ext}`)
    .join(', ')
  return { files, extensions }
}

/**
 * Directories under the workspace globs that hold files but no `package.json`.
 *
 * Derived, not listed, and for the reason the rest of this script is: a
 * hand-kept list of "surfaces we know about" is exactly the artefact that let a
 * 116-file client sit in none of them. A directory whose only contents are
 * build leftovers is not a surface — `packages/messaging-gateway` and
 * `packages/messaging-whatsapp-worker` each hold nothing but `node_modules/`
 * and `dist/`, and both are silent here because git lists no file in either
 * (F1.564: this reads the working-tree listing; SKIPPED_DIRS is the belt).
 */
function findUnmappedSurfaces(root: RootPackageJson): string[] {
  return expandWorkspaceGlobs(root.workspaces ?? [])
    .filter((dir) => !isWorkingTreeFile(`${dir}/package.json`))
    .filter((dir) => describeContents(dir).files > 0)
}

function readPackageJson(dir: string): { name?: string; scripts?: Record<string, string> } | null {
  const path = join(REPO_ROOT, dir, 'package.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8')) as { name?: string; scripts?: Record<string, string> }
}

/**
 * `.references` is here for the repo-wide sweep at the bottom of this file and
 * for nothing else — it is UNTRACKED vendored reading material (0 files in
 * `git ls-files`) holding **1 081** `*.test.ts` outside its own `node_modules`,
 * measured 2026-09-03. Every one of them would land in that sweep's orphan list,
 * which is how a repo-wide assertion turns into 1 081 false positives on its
 * first run and gets switched off. No existing caller reaches it: the
 * codex-protocol guard walks one package and `--tests` walks workspace
 * packages, neither of which contains this directory.
 */
export const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', 'release', 'out', 'coverage', '.vite', '.references'])

/**
 * `limit` exists because the codex-protocol staleness guard only needed to know
 * whether ANY test file exists (and names one). `--tests` used to be this
 * walker's second caller, wanting every file — which is why `release` and `out`
 * are skipped — and since F1.519 it enumerates through `listWorkingTreeFiles`
 * instead, because a walk also finds files inside an IGNORED directory. Since
 * F1.564 the guard reads that listing too, so this walker has no caller in this
 * file: it stays exported as the filesystem side of the F1.519 comparison in
 * `check-typecheck-coverage.test.ts`.
 *
 * F1.971 — each entry's type comes from the directory listing itself, which
 * does not follow a symlink. `statSync` did, so a dangling link (a finished
 * live sitting's Chromium `SingletonCookie` under the ignored `work/`) threw
 * ENOENT, and a link to a directory walked its target a second time. A link is
 * now a leaf, as `git ls-files` records it. Residue: a directory deleted
 * between its parent's listing and its own still throws.
 */
export function findTestFiles(dir: string, found: string[] = [], limit = 9): string[] {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const entry = dirent.name
    if (SKIPPED_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (dirent.isDirectory()) {
      findTestFiles(full, found, limit)
      continue
    }
    if (/\.test\.tsx?$/.test(entry)) found.push(relative(REPO_ROOT, full))
    if (found.length >= limit) return found
  }
  return found
}

/**
 * F1.519 item 5 (P-WJai-5, 2026-09-24) — what `--tests` may enumerate: the files
 * `git ls-files --cached --others --exclude-standard` names under `dir` — every
 * TRACKED file plus every UNTRACKED file no ignore rule covers — minus anything
 * under a `SKIPPED_DIRS` segment, which stays as the belt for a dependency tree
 * a clone's own ignore rules do not name. Paths come back relative to `root`.
 *
 * Why not the filesystem walk `findTestFiles` still is: `--tests` hands every
 * tsconfig it finds to `tsc --showConfig`, and a walk finds the ones inside an
 * IGNORED scratch copy of the tree too. A lane's `work/wj-jj-verify/at-parent`
 * carried a `scripts/tsconfig.json` whose base that copy did not hold, and the
 * whole run died on it with TS5083 (measured 2026-09-24 at `d5ec9426a`). The
 * discriminator is IGNORED, not untracked — AGENTS.md's gate-that-walks-the-
 * filesystem trap — because a lane's brand-new `foo.test.ts` is exactly the
 * file this sweep exists to see. A tracked file deleted from disk is still
 * listed by `--cached`; the two callers below drop it with an `existsSync`
 * on the few paths they keep, never on the whole listing.
 *
 * It needs a git work tree and throws outside one. Since F1.564 the DEFAULT
 * check reads it too (`repoWorkingTreeFiles`), and since F1.584 the lint twin
 * imports it, so every rig either twin's test file builds is `git init`ed.
 */
export function listWorkingTreeFiles(dir: string, root: string = REPO_ROOT): string[] {
  const scope = relative(root, dir) || '.'
  const proc = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', `:(literal)${scope}`],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  )
  if (proc.exitCode !== 0) {
    throw new Error(`\`git ls-files\` failed in ${root} for ${scope}: ${proc.stderr.toString().trim()}`)
  }
  const files = new Set<string>()
  for (const file of proc.stdout.toString().split('\0')) {
    if (file === '' || file.split('/').some((segment) => SKIPPED_DIRS.has(segment))) continue
    files.add(file)
  }
  return [...files]
}

/** `--tests`' test-file enumeration: `listWorkingTreeFiles`, test files that exist on disk. */
export function findWorkingTreeTestFiles(dir: string, root: string = REPO_ROOT): string[] {
  return listWorkingTreeFiles(dir, root).filter((file) => /\.test\.tsx?$/.test(file) && existsSync(join(root, file)))
}

/**
 * F1.564 (P-WJax-2, 2026-09-24) — the DEFAULT check's enumeration: the same
 * `listWorkingTreeFiles` listing `--tests` has read since F1.519 item 5, taken
 * once per run over the whole repo. The workspace globs, `package.json`
 * presence, an unmapped surface's contents and the codex-protocol / apps/ios
 * structural guards all read it, so an IGNORED directory under a `workspaces`
 * glob — a scratch copy, a SwiftPM `.build` — is no longer part of what this
 * gate judges. Until this row it walked the filesystem, and an ignored
 * `apps/zz-scratch/package.json` was reported as a package outside the chain on
 * the one machine that held it and nowhere else (AGENTS.md's gate-that-walks-
 * the-filesystem trap, one mode over from `--tests`). The discriminator is
 * IGNORED, not untracked: a lane's new package is judged before its first
 * commit. A tracked file deleted from disk is still listed by `--cached`, so
 * every reader below also asks the disk about the paths it keeps.
 */
let workingTreeListing: Set<string> | undefined

function repoWorkingTreeFiles(): Set<string> {
  workingTreeListing ??= new Set(listWorkingTreeFiles(REPO_ROOT))
  return workingTreeListing
}

/** Whether repo-relative `path` is a working-tree file: listed by git and present on disk. */
function isWorkingTreeFile(path: string): boolean {
  return repoWorkingTreeFiles().has(path) && existsSync(join(REPO_ROOT, path))
}

/** The working-tree files under repo-relative `dir`, present on disk, in git's order. */
function workingTreeFilesUnder(dir: string): string[] {
  const prefix = `${dir}/`
  return [...repoWorkingTreeFiles()].filter((file) => file.startsWith(prefix) && existsSync(join(REPO_ROOT, file)))
}

/**
 * Expand the `workspaces` globs. Only the `<dir>/*` shape this repo uses is
 * supported, and an unrecognised pattern is a hard failure rather than a silent
 * skip — a glob this script cannot expand is a set of packages it cannot check,
 * which is the failure mode it exists to prevent. (Same rule, same wording, as
 * the lint twin: the two must agree on what "a workspace package" is, or one of
 * them is checking a different repo.)
 *
 * F1.564 — a child directory is one holding at least one working-tree file
 * (`repoWorkingTreeFiles`), so a directory whose every file is ignored is not
 * expanded at all. Since F1.584 the lint twin expands the same way, from the
 * same `listWorkingTreeFiles`, so the two agree on an ignored directory too.
 */
function expandWorkspaceGlobs(patterns: string[]): string[] {
  const dirs: string[] = []

  for (const pattern of patterns) {
    const parentName = /^([A-Za-z0-9._-]+)\/\*$/.exec(pattern)?.[1]
    if (parentName === undefined) {
      throw new Error(
        `Unsupported workspaces pattern ${JSON.stringify(pattern)} in the root package.json. ` +
        'check-typecheck-coverage.ts only expands "<dir>/*". Teach it the new shape rather than ' +
        'leaving the packages it matches unchecked.',
      )
    }

    const children = new Set<string>()
    for (const file of repoWorkingTreeFiles()) {
      if (!file.startsWith(`${parentName}/`)) continue
      const child = file.slice(parentName.length + 1).split('/')[0]
      // A file directly under the parent is not a package directory.
      if (child === undefined || file === `${parentName}/${child}`) continue
      if (existsSync(join(REPO_ROOT, parentName, child))) children.add(child)
    }

    for (const child of [...children].sort()) dirs.push(`${parentName}/${child}`)
  }

  return dirs
}

/** A `tsc` invocation the chain performs, and the directory it runs in. */
interface Invocation {
  /** Repo-relative directory, POSIX separators, `''` for the repo root. */
  dir: string
  /** The command as written in the script. */
  command: string
}

/**
 * Walk the chain, tracking cwd, and return where a compiler actually runs.
 *
 * Every problem found along the way is a hard error rather than a skip: a
 * segment this walker cannot classify is a segment whose effect on cwd is
 * unknown, and from there every later `cd` is a guess.
 */
function walkChain(scripts: Record<string, string>, scriptName: string, startDir: string, errors: string[]): Invocation[] {
  const body = scripts[scriptName]
  if (body === undefined) {
    errors.push(`Root package.json has no \`${scriptName}\` script — this checker has nothing to walk.`)
    return []
  }

  const invocations: Invocation[] = []
  let cwd = startDir

  for (const raw of body.split('&&')) {
    const segment = raw.trim()
    if (segment === '') continue

    const cdTarget = /^cd\s+(\S+)$/.exec(segment)?.[1]
    if (cdTarget !== undefined) {
      const next = relative(REPO_ROOT, resolve(REPO_ROOT, cwd, cdTarget))
      if (!existsSync(join(REPO_ROOT, next)) || !statSync(join(REPO_ROOT, next)).isDirectory()) {
        errors.push(
          `\`${scriptName}\` does \`${segment}\` from ${cwd || '<repo root>'}, which resolves to ` +
          `${next || '<repo root>'} — that directory does not exist. The chain is relative, so every ` +
          'later step in it lands somewhere else too.',
        )
        return invocations
      }
      cwd = next
      continue
    }

    // `bun run <name>` from the repo root is another root script: recurse, but
    // in a child cwd. A nested script runs in its own process, so whatever it
    // `cd`s into cannot move the caller — treating it otherwise would place
    // every later package one directory off.
    const nestedRootScript = cwd === '' ? /^bun run ([A-Za-z0-9:_-]+)$/.exec(segment)?.[1] : undefined
    if (nestedRootScript !== undefined && scripts[nestedRootScript] !== undefined) {
      invocations.push(...walkChain(scripts, nestedRootScript, '', errors))
      continue
    }

    // `bun scripts/run-gates.ts <chain>` is the same indirection one step
    // further out: P2.222 moved `typecheck:all` off its `&&` chain, because an
    // `&&` chain stops gating at its first red — measured at this branch's tip,
    // a red third link left ten packages unchecked with nothing saying so. The
    // chain body still lives in package.json, under the name that segment
    // carries. Follow it, or every package in it reads as unreachable and this
    // checker cries wolf fifteen times.
    const gateChain = cwd === ''
      ? /^bun scripts\/run-gates\.ts ([A-Za-z0-9:._-]+)$/.exec(segment)?.[1]
      : undefined
    if (gateChain !== undefined && scripts[gateChain] !== undefined) {
      invocations.push(...walkChain(scripts, gateChain, '', errors))
      continue
    }

    if (!isCompilerInvocation(segment)) continue

    // `bun run <name>` inside a package runs THAT package's script. A chain
    // entry naming a script the package does not define fails at runtime; it
    // should fail here, in a line that says which package.
    const packageScript = /^bun run ([A-Za-z0-9:_-]+)/.exec(segment)?.[1]
    if (packageScript !== undefined && packageScript !== 'tsc') {
      const manifest = readPackageJson(cwd)
      if (manifest?.scripts?.[packageScript] === undefined) {
        errors.push(
          `\`${scriptName}\` runs \`${segment}\` in ${cwd || '<repo root>'}, which defines no ` +
          `\`${packageScript}\` script.`,
        )
      }
    }

    // A bare `tsc --noEmit` with no tsconfig in cwd is this script's version of
    // the empty-lint-report the twin documents: it type-checks nothing and can
    // still exit 0.
    if (/\btsc\b/.test(segment) && !/-p\s|--project\s/.test(segment) && cwd !== '') {
      if (!existsSync(join(REPO_ROOT, cwd, 'tsconfig.json'))) {
        errors.push(
          `\`${scriptName}\` runs \`${segment}\` in ${cwd}, which has no tsconfig.json. ` +
          'A bare `tsc` with no config compiles no inputs — nothing is checked and nothing complains.',
        )
      }
    }

    invocations.push({ dir: cwd, command: segment })
  }

  return invocations
}

function isCompilerInvocation(segment: string): boolean {
  return /\btsc\b/.test(segment) || /^bun run typecheck/.test(segment) || /^bun scripts\//.test(segment)
}

interface WorkspacePackage {
  dir: string
  name: string
  /** The chain command that typechecks it, or null. */
  checkedBy: string | null
  exclusion: Exclusion | null
}

function collect(root: RootPackageJson, errors: string[]): WorkspacePackage[] {
  const invocations = walkChain(root.scripts ?? {}, CHAIN_SCRIPT, '', errors)

  return expandWorkspaceGlobs(root.workspaces ?? [])
    .filter((dir) => isWorkingTreeFile(`${dir}/package.json`))
    .map((dir) => ({
      dir,
      name: readPackageJson(dir)?.name ?? '(unnamed)',
      checkedBy: invocations.find((invocation) => invocation.dir === dir)?.command ?? null,
      exclusion: EXCLUSIONS.find((exclusion) => exclusion.dir === dir) ?? null,
    }))
}

/* ────────────────────────────────────────────────────────────────────────────
 * P3.156 — reachability is a floor, not the guarantee.
 *
 * Everything above proves each workspace package is REACHED by the chain. It
 * does not prove the package's TESTS are in the program, which is the half
 * P3.117 was actually about: `codex-agent-server`'s source was covered
 * transitively through `shared` the whole time, and its seven test files were
 * covered by nothing.
 *
 * `--tests` is that assertion. It is deliberately NOT wired into
 * `typecheck:coverage`, and this is the reason, measured 2026-08-28:
 *
 * FIRST RUN, 2026-08-28 — five packages, 106 test files:
 *
 *   package                   unchecked  why                            errors
 *   packages/ui                      39  exclude glob `src/**\/__tests__`     4
 *   packages/shared                  33  exclude glob `automations/**`       51
 *   packages/pi-agent-server         32  32 files named in its config       217
 *   packages/core                     1  `__tests__/` outside `include`       1
 *   apps/electron                     1  `eslint-rules/` outside `include`   n/m
 *
 * AFTER P3.164, SAME DAY — one package, 32 test files:
 *
 *   package                   unchecked  why                            errors
 *   packages/pi-agent-server         32  32 files named in its config       217
 *
 * RE-READ 2026-09-08 (P6.738, when `apps/viewer` and `apps/webui` joined the
 * chain and therefore this table's denominator) — still one package, and the
 * count has moved twice since the row above:
 *
 *   package                   unchecked  why                            errors
 *   packages/pi-agent-server         13  files named in its config          n/m
 *   apps/viewer                       0  no test files on disk at all       n/m
 *   apps/webui                        0  no test files on disk at all       n/m
 *
 * The two new packages cost this sweep nothing: neither ships a test file, so
 * chaining them widened the SOURCE denominator and left this one where it was.
 * That is a reading with a date like every row above it — 32, then 14, then 13.
 *
 * All three tables are DATED rather than rewritten, because a bare count beside a
 * live report reads as a standing fact and this file has now watched three of
 * them go stale. Only the `unchecked` column was ever a claim; the on-disk
 * totals move between runs, so the report prints them live.
 *
 * Two corrections the first table earned, and neither is cosmetic:
 *
 *   - `packages/ui`'s three `Cannot find module 'vitest'` were called a missing
 *     type dependency. They are not. `vitest` is in no package.json and no
 *     node_modules here; those files ran because BUN SHIPS A BUILT-IN `vitest`
 *     ALIAS onto `bun:test`. The fix was to spell the import the way the other
 *     34 files in the package do — installing a test runner we do not use would
 *     have been the wrong answer to a correctly-observed symptom.
 *
 *   - `packages/shared`'s 33 were attributed to ONE hole, the `automations`
 *     exclude. There were TWO. The exclude held 24; the other 9 sat in a
 *     top-level `tests/` directory that was outside `include` rather than
 *     inside `exclude` — so it appeared in no exclusion list to read, which is
 *     why the first pass named only the glob. Those 9 carried 54 further
 *     errors nobody had measured, and two of them are named in the root
 *     package.json's own `test:shared:*` gate scripts.
 *
 * `apps/electron`'s `n/m` resolved to ZERO: that directory was never excluded,
 * only never named, and it cost no errors at all.
 *
 * STILL NOT WIRED, and still not softened. `pi-agent-server` is P3.165 and its
 * 217 are deliberately unrushed — 92 arity errors that would be trivial to
 * batch away, which is exactly how an assertion gets satisfied vacuously. An
 * assertion tuned to accept what it exists to catch is worse than none, so
 * there is no per-package budget here: `--tests` exits 1 until pi is green,
 * and then it goes into `typecheck:coverage` and this comment becomes history.
 * ──────────────────────────────────────────────────────────────────────────── */

interface TestCoverage {
  dir: string
  config: string
  onDisk: string[]
  inProgram: Set<string>
  missing: string[]
}

/**
 * Which tsconfig the chain's own command compiles this package with.
 *
 * Guessing `tsconfig.json` would be wrong for exactly the package this row was
 * opened over: `pi-agent-server`'s chain entry is `bun run typecheck`, whose
 * script is `bun run check:surface && tsc --noEmit -p tsconfig.typecheck.json`,
 * and `tsconfig.json` there has no exclusions at all — so the guess would
 * report a package with a 32-file hole as fully covered.
 */
function resolveCheckedConfig(dir: string, chainCommand: string): string {
  const commands = [chainCommand]

  const packageScript = /^bun run ([A-Za-z0-9:_-]+)/.exec(chainCommand)?.[1]
  if (packageScript !== undefined && packageScript !== 'tsc') {
    const body = readPackageJson(dir)?.scripts?.[packageScript]
    if (body !== undefined) commands.push(...body.split('&&').map((part) => part.trim()))
  }

  for (const command of commands) {
    const project = /(?:-p|--project)\s+(\S+)/.exec(command)?.[1]
    if (project !== undefined) return project
  }

  return 'tsconfig.json'
}

/**
 * The program's root files, straight from the compiler.
 *
 * `--showConfig` prints the config with `include`/`exclude` already expanded,
 * so this is TypeScript's own answer rather than a re-implementation of its
 * glob semantics — and it costs no type checking, which `--listFiles` would.
 * Reimplementing those globs is how you get a checker that disagrees with the
 * compiler it is supposed to be checking.
 */
interface ProgramClaim {
  /** Repo-relative root files, `include`/`exclude` expanded by the compiler. */
  files: string[]
  /**
   * Whether the RESOLVED config (after `extends`) declares an `include`.
   *
   * A config that declares none takes tsc's default — every `.ts` under the
   * config's own directory — so a config at the repo ROOT claims the entire
   * repository. `--showConfig` echoes the `include` key when there is one and
   * omits it when there is not, and it resolves `extends` first, which is why
   * this is read off the compiler rather than off the file's own JSON.
   */
  declaresInclude: boolean
}

async function readProgramRootFiles(dir: string, config: string): Promise<string[]> {
  return (await readProgramClaim(dir, config)).files
}

async function readProgramClaim(dir: string, config: string): Promise<ProgramClaim> {
  const proc = Bun.spawn(['bun', 'run', 'tsc', '-p', config, '--showConfig'], {
    cwd: join(REPO_ROOT, dir),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    // TS18003 is "no inputs were found", and it is a legitimate answer here
    // rather than a failure: the repo-root `tsconfig.json` includes `src/**/*`
    // and this repo has no root `src/`, so it is a settings carrier that
    // `scripts/cdp/tsconfig.json` extends and contributes zero root files. The
    // sweep below reads every tsconfig in the tree, so it meets this one; a
    // thrown error there would have been "read fewer configs and report more
    // orphans", which is the wrong direction for an assertion about coverage.
    //
    // It is matched on STDOUT, and that is not an oversight to tidy later:
    // `tsc` writes its diagnostics to stdout, and the only thing on stderr here
    // is `bun run`'s own `error: "tsc" exited with code 1`, which names no
    // diagnostic at all. Reading stderr — the obvious choice, and the one this
    // line held for one run — matches nothing and turns a config with zero
    // inputs into a thrown sweep.
    if (stdout.includes('TS18003')) return { files: [], declaresInclude: true }
    throw new Error(
      `\`tsc -p ${config} --showConfig\` failed in ${dir}: `
      + `${[stdout, stderr].map((stream) => stream.trim()).filter(Boolean).join(' / ').slice(0, 400)}`,
    )
  }
  const parsed = JSON.parse(stdout) as { files?: string[]; include?: string[] }
  return {
    files: (parsed.files ?? []).map((file) => relative(REPO_ROOT, resolve(REPO_ROOT, dir, file))),
    declaresInclude: parsed.include !== undefined,
  }
}

/**
 * Every tsconfig in the tree, derived rather than listed — same reason as
 * everything else in this file. Enumerated through `listWorkingTreeFiles`
 * since F1.519: a config inside an ignored directory is not this repository's
 * and handing it to `tsc` crashed the sweep. Paths are relative to `root`.
 */
export function findTsconfigs(root: string = REPO_ROOT): string[] {
  return listWorkingTreeFiles(root, root)
    .filter((file) => /^tsconfig(\..+)?\.json$/.test(basename(file)) && existsSync(join(root, file)))
    .sort()
}

/* ────────────────────────────────────────────────────────────────────────────
 * P3.190 — a directory that appears in no `include` at all is invisible to an
 * audit of `exclude` globs, and it was invisible to `--tests` above too.
 *
 * The two halves are different failures and only the first was named. An
 * exclude audit reads the exclusions, so a directory nobody ever included
 * appears in no list to read: that is how nine files and 54 errors sat in
 * `shared`'s top-level `tests/` and how two `eslint-rules/__tests__` trees sat
 * in no config anywhere. The second half is this script's own: `--tests`
 * iterates WORKSPACE PACKAGES, so a test file on a non-package surface is
 * outside its denominator entirely, not merely unchecked. `scripts/` alone
 * carries 33 of them across four tsconfigs the chain really runs
 * (`typecheck:scripts` + `typecheck:build-scripts`), and the per-package table
 * has never mentioned one.
 *
 * So the sweep below is repo-wide on BOTH sides: every tsconfig in the tree
 * against every `*.test.ts(x)` in the tree. A file in no program is named.
 *
 * MEASURED 2026-09-03, and dated for the reason the two tables above are:
 * **0 orphan test files**, over ~1 580 test files and ~23 tsconfigs. Read both
 * numbers off the report, never off this sentence — they moved three times in
 * the hour this comment was written, because eleven other lanes were adding
 * files.
 *
 * RE-READ 2026-09-08 (P6.738): **1 orphan**, over 1 937 test files and the same
 * 23 tsconfigs — `scripts/platform-rig/run-linux-removal-probe.test.ts`, landed
 * the same day the zero above was taken (`4e0efbdb6`). `scripts/tsconfig.json`
 * includes the TOP level of `scripts/` only, and the rig sits one directory
 * down, so the file is in no program and no exclusion list names it. It was left
 * standing rather than swept in by that row: widening that `include` also pulls
 * `run-linux-removal-probe.ts` and `removal-corpus.ts` into `typecheck:scripts`,
 * which is the first link of the chain every lane runs, and an unmeasured
 * widening there reddens every lane at once. So the sweep reported it, this note
 * dated it, and closing it became its own row. The shape the 2026-09-03 note
 * called CLOSED was therefore open again — which is exactly what a dated reading
 * is for.
 *
 * CLOSED 2026-09-08 (P6.781): **0 orphans**, over 1 958 test files and the same
 * 23 tsconfigs. The widening the note above declined to do unmeasured was
 * measured first — a throwaway config over `platform-rig/*.ts` alone reported
 * **0 errors** across all three files, with a planted `const x: number = "s"`
 * returned as TS2322 to prove the probe was reading them — and only then landed,
 * as `"include": ["*.ts", "platform-rig/*.ts"]`. `typecheck:scripts` stays green
 * and no file was excluded to make it fit. The two counts moved 1 937 → 1 958 in
 * five days for the usual reason: read them off the report, never off a sentence.
 * Cross-checked against `git ls-files` on the day of that 2026-09-08 re-read:
 * of 4 064 tracked `.ts`/`.tsx`, 663 are in no program's root set, 655 of them
 * `packages/codex-protocol/generated` (the documented exclusion at the top of
 * this file) and the other 8 build/vite/copy scripts — not a test among them.
 * All three `eslint-rules/__tests__` files P3.190 named are in a program today.
 * So the shape it was opened over is CLOSED, and this is the assertion that
 * keeps it closed rather than a claim that it is.
 *
 * THE FIRST VERSION OF THIS SWEEP COULD NOT FAIL, and that is the part worth
 * reading before touching it. `tsconfig.base.json` declares no `include`, so it
 * takes tsc's default — every `.ts` under its own directory — and its directory
 * is the REPOSITORY ROOT: 4 477 files, effectively everything. Unioned in, it
 * made the orphan set permanently empty, and the "0 orphans" above was an
 * artefact rather than a measurement. It was caught by planting a real test file
 * in `docs-site/` (a surface no config includes) and finding the sweep still
 * reported zero — the re-break that a green assertion always deserves and this
 * one nearly did not get.
 *
 * Two things came out of it, and both are load-bearing:
 *
 *   - A config that declares no `include` is SKIPPED and named in the output.
 *     `--showConfig` resolves `extends` and echoes `include` only when there is
 *     one, so this reads the compiler's answer rather than the file's own JSON —
 *     a config inheriting its `include` from a base is correctly kept. The rule
 *     is structural, not a name: today `tsconfig.base.json` is the only one, and
 *     because the skip is printed, a second one cannot appear silently.
 *   - The sweep carries its own POSITIVE CONTROL and refuses rather than
 *     reporting. `packages/codex-protocol/generated/index.ts` is documented at
 *     the top of this file as sitting in no program at all; if the union
 *     contains it, the union is over-claiming and every "0 orphans" it could
 *     print is worthless. An absence finding needs a positive control on the
 *     same rig, and this is that rule applied to a checker instead of to a
 *     capability.
 *
 * WHY IT LIVES IN `--tests` AND NOT IN THE DEFAULT CHECK, said out loud because
 * a green assertion nobody runs is the defect this whole file is about. It
 * costs one `tsc --showConfig` spawn per config: **21 s wall** for 22 of them
 * with the `tsc` binary invoked directly, 41 s through `bun run tsc`, measured
 * at load ~10 on 2026-09-03. `typecheck:coverage` is the first link of
 * `typecheck:chain` and is otherwise near-instant, so paying that on every
 * lane's scope check would buy a guard by making the cheap gate expensive. It
 * rides `--tests` instead, where the same spawns are already being paid — and
 * `--tests` is itself unwired until `pi-agent-server` is green (see the block
 * above). That residue is real and is stated rather than papered over: until
 * then this sweep runs when someone runs it, which is exactly the P2.255 seam
 * one file over.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A file the documented `packages/codex-protocol` exclusion says is in NO
 * program. It is the sweep's positive control: if the union of every config's
 * root files contains it, the union claims more than any program really does.
 */
const SWEEP_CONTROL_FILE = 'packages/codex-protocol/generated/index.ts'

interface SweepResult {
  orphans: string[]
  onDisk: number
  configs: number
  /** Configs skipped because they claim their whole subtree by default. */
  defaultClaimants: string[]
}

async function sweepTestFileReach(): Promise<SweepResult> {
  const configs = findTsconfigs()
  const claims = await Promise.all(
    configs.map(async (config) => {
      const dir = config.includes('/') ? config.slice(0, config.lastIndexOf('/')) : '.'
      const base = config.slice(config.lastIndexOf('/') + 1)
      return { config, claim: await readProgramClaim(dir, base) }
    }),
  )

  const defaultClaimants = claims.filter((row) => !row.claim.declaresInclude).map((row) => row.config)
  const rootFiles = new Set<string>()
  for (const row of claims) {
    if (!row.claim.declaresInclude) continue
    for (const file of row.claim.files) rootFiles.add(file)
  }
  const onDisk = findWorkingTreeTestFiles(REPO_ROOT)

  if (rootFiles.size === 0 || onDisk.length === 0) {
    throw new Error(
      `check-typecheck-coverage --tests: the repo-wide sweep read ${configs.length} tsconfigs into ` +
      `${rootFiles.size} root files and found ${onDisk.length} test files on disk. One of those is zero, ` +
      'so the sweep is measuring nothing and its verdict — whatever it is — would be an artefact.',
    )
  }
  if (!existsSync(join(REPO_ROOT, SWEEP_CONTROL_FILE))) {
    throw new Error(
      `check-typecheck-coverage --tests: the sweep's control file ${SWEEP_CONTROL_FILE} is gone, so the ` +
      'check that this sweep can report anything at all is vacuous. Pick another file the exclusions ' +
      'at the top of this script say is in no program, and name it in SWEEP_CONTROL_FILE.',
    )
  }
  if (rootFiles.has(SWEEP_CONTROL_FILE)) {
    const claiming = claims.filter((row) => row.claim.declaresInclude && row.claim.files.includes(SWEEP_CONTROL_FILE))
    throw new Error(
      `check-typecheck-coverage --tests: ${SWEEP_CONTROL_FILE} is documented as being in no program, and ` +
      `${claiming.map((row) => row.config).join(', ') || 'some config'} claims it. Either that exclusion ` +
      'is stale (fix it at the top of this script) or a config over-claims — and while it does, this ' +
      'sweep cannot report an orphan and its green is meaningless.',
    )
  }

  return {
    orphans: onDisk.filter((file) => !rootFiles.has(file)).sort(),
    onDisk: onDisk.length,
    configs: configs.length,
    defaultClaimants,
  }
}

async function mainTests(): Promise<void> {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as RootPackageJson
  const errors: string[] = []
  const chained = collect(root, errors).filter((pkg) => pkg.checkedBy !== null)

  const rows = await Promise.all(
    chained.map(async (pkg): Promise<TestCoverage> => {
      const config = resolveCheckedConfig(pkg.dir, pkg.checkedBy as string)
      const inProgram = new Set(await readProgramRootFiles(pkg.dir, config))
      const onDisk = findWorkingTreeTestFiles(join(REPO_ROOT, pkg.dir))
      return { dir: pkg.dir, config, onDisk, inProgram, missing: onDisk.filter((file) => !inProgram.has(file)).sort() }
    }),
  )

  let unchecked = 0
  for (const row of rows.sort((a, b) => b.missing.length - a.missing.length || a.dir.localeCompare(b.dir))) {
    const inProgram = row.onDisk.length - row.missing.length
    console.log(`${row.dir.padEnd(34)} ${String(row.onDisk.length).padStart(4)} on disk  ${String(inProgram).padStart(4)} in program  ${String(row.missing.length).padStart(4)} unchecked  (${row.config})`)
    unchecked += row.missing.length
    for (const file of row.missing.slice(0, 6)) console.log(`      - ${file}`)
    if (row.missing.length > 6) console.log(`      … and ${row.missing.length - 6} more`)
  }

  // P3.190 — the half the table above structurally cannot see. Printed on both
  // paths, because a coverage report that states its own denominator only when
  // green is the shape P2.116's coverage line was fixed for one file over.
  const sweep = await sweepTestFileReach()
  console.log(
    `\nrepo-wide (P3.190): ${sweep.onDisk} test files on disk, ` +
    `${sweep.orphans.length} in no program of any of the ${sweep.configs} tsconfigs in this tree.`,
  )
  for (const config of sweep.defaultClaimants) {
    console.log(`      (skipped ${config} — it declares no \`include\`, so it claims its whole subtree by default)`)
  }
  for (const file of sweep.orphans) console.log(`      - ${file}`)
  const orphans = sweep.orphans

  for (const error of errors) console.error(`check-typecheck-coverage --tests: ${error}`)

  if (unchecked === 0 && errors.length === 0 && orphans.length === 0) {
    console.log('\ncheck-typecheck-coverage --tests: every test file in every chained package is in its program,')
    console.log('and no test file anywhere in the tree sits outside every tsconfig.')
    console.log(`Wire this into \`typecheck:coverage\` — it is green, and the comment above it is now history.`)
    return
  }

  if (unchecked > 0) {
    console.error(
      `\ncheck-typecheck-coverage --tests: ${unchecked} test files in chained packages are in no typecheck program.\n` +
      '  Each one is a file where `bun test` runs code the compiler never saw. Read the P3.156\n' +
      '  block in this script before treating any of them as new — five were measured 2026-08-28.',
    )
  }
  if (orphans.length > 0) {
    console.error(
      `\ncheck-typecheck-coverage --tests: ${orphans.length} test files are in NO tsconfig in this repository.\n` +
      '  This is P3.190 and it is a different failure from the line above: those files are excluded\n' +
      '  from a program, these are in no program to be excluded from, so no exclusion list names them\n' +
      '  and no per-package table counts them. Add each to an existing config\'s `include`, or give\n' +
      '  its surface a tsconfig and chain it.',
    )
  }
  process.exit(1)
}

function main(): void {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as RootPackageJson
  const errors: string[] = []
  const packages = collect(root, errors)

  if (process.argv.includes('--list')) {
    for (const pkg of packages) {
      const status = pkg.checkedBy !== null
        ? `in ${CHAIN_SCRIPT} (${pkg.checkedBy})`
        : pkg.exclusion !== null ? 'EXCLUDED (see script)' : 'NOT TYPECHECKED'
      console.log(`${pkg.dir.padEnd(34)} ${status}`)
    }
    for (const dir of findUnmappedSurfaces(root)) {
      const { files, extensions } = describeContents(dir)
      const named = UNMAPPED_SURFACES.some((surface) => surface.dir === dir)
      console.log(`${dir.padEnd(34)} NOT A WORKSPACE PACKAGE — ${files} files (${extensions})${named ? ', named in this script' : ''}`)
    }
    console.log(`\n${packages.length} workspace packages, ${EXCLUSIONS.length} named exclusions, ${UNMAPPED_SURFACES.length} unmapped surfaces.`)
    return
  }

  for (const pkg of packages) {
    if (pkg.checkedBy !== null) {
      if (pkg.exclusion !== null) {
        errors.push(
          `${pkg.dir} is BOTH in \`${CHAIN_SCRIPT}\` and listed as an exclusion in this script. ` +
          'Delete the exclusion — an exemption nobody needs is one nobody re-reads.',
        )
      }
      continue
    }

    if (pkg.exclusion === null) {
      errors.push(
        `${pkg.dir} (${pkg.name}) is not reachable from \`${CHAIN_SCRIPT}\`.\n` +
        '  A package outside the chain is not "probably fine": its source may be covered\n' +
        '  transitively through an importer while its TESTS are covered by nothing, and that\n' +
        '  gap is invisible — every typecheck in CI passes. It cost four shipped errors in\n' +
        `  packages/session-mcp-server (P3.130).\n` +
        `  Either chain it into \`${CHAIN_SCRIPT}\`, or add it to EXCLUSIONS in\n` +
        '  scripts/check-typecheck-coverage.ts with a reason AND a staleness guard.',
      )
      continue
    }

    const stale = pkg.exclusion.stale(root)
    if (stale !== null) errors.push(`Stale exclusion — ${stale}`)
  }

  for (const exclusion of EXCLUSIONS) {
    if (!packages.some((pkg) => pkg.dir === exclusion.dir)) {
      errors.push(
        `EXCLUSIONS names ${exclusion.dir}, which is not a workspace package (no package.json, ` +
        'or no longer matched by a `workspaces` glob). Remove the entry.',
      )
    }
  }

  for (const dir of findUnmappedSurfaces(root)) {
    const surface = UNMAPPED_SURFACES.find((entry) => entry.dir === dir)
    if (surface === undefined) {
      const { files, extensions } = describeContents(dir)
      errors.push(
        `${dir} is matched by a \`workspaces\` glob, holds ${files} files (${extensions}), and has no ` +
        'package.json — so it is not a workspace package and every check in this script is blind to it.\n' +
        '  That is a worse state than "unchecked": a surface in neither the workspace list nor\n' +
        "  AGENTS.md's Monorepo Map has never been SEEN by any sweep scoped to either. It cost a\n" +
        '  116-file iOS client (P2.352).\n' +
        '  Give it a package.json and chain it, or add it to UNMAPPED_SURFACES in\n' +
        '  scripts/check-typecheck-coverage.ts with a reason AND a staleness guard.',
      )
      continue
    }

    const stale = surface.stale()
    if (stale !== null) errors.push(`Stale unmapped surface — ${stale}`)
  }

  for (const surface of UNMAPPED_SURFACES) {
    if (!existsSync(join(REPO_ROOT, surface.dir))) {
      errors.push(`UNMAPPED_SURFACES names ${surface.dir}, which does not exist. Remove the entry.`)
      continue
    }
    if (isWorkingTreeFile(`${surface.dir}/package.json`)) {
      errors.push(
        `UNMAPPED_SURFACES names ${surface.dir}, which now HAS a package.json — it is a workspace ` +
        'package, so the checks above own it. Remove the entry.',
      )
    }
  }

  if (errors.length === 0) {
    const covered = packages.length - EXCLUSIONS.length
    console.log(
      `check-typecheck-coverage: ${packages.length} workspace packages, ` +
      `${covered} reachable from \`${CHAIN_SCRIPT}\`, ${EXCLUSIONS.length} excluded by name with a live reason, ` +
      `${UNMAPPED_SURFACES.length} unmapped surface(s) named with one.`,
    )
    return
  }

  for (const error of errors) console.error(`check-typecheck-coverage: ${error}`)
  process.exit(1)
}

// P2.403. Until this guard existed the two calls below sat at module top level,
// so ANY `import` of this file RAN the coverage gate — including its
// `process.exit(1)`. That is not hypothetical: it is the recorded reason
// `gate-projects.ts` re-derives the same tsconfig walk instead of reusing this
// one (see that file's header, "Why this is not check-typecheck-coverage.ts's
// walker"). The merge direction is recorded there; this guard is what makes it
// possible at all.
//
// The constraint that made this awkward: this file is invoked AS A SCRIPT by
// `typecheck:coverage`, which is the first step of `typecheck:chain`, so the
// guard must not change what running it as a script does. `import.meta.main` is
// true exactly when Bun ran this file as the entry point, which is that case and
// only that case — `bun scripts/check-typecheck-coverage.ts [--list|--tests]`
// behaves identically, and an import now produces no output and no exit.
if (import.meta.main) {
  if (process.argv.includes('--tests')) {
    await mainTests()
  } else {
    main()
  }
}
