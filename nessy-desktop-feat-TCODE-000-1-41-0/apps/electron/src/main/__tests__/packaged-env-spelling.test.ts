/**
 * `NESSY_IS_PACKAGED` has exactly one spelling: `'true'` / `'false'`.
 *
 * This file used to write it twice with two different vocabularies — `'1'`/`'0'`
 * at module scope and `'true'`/`'false'` inside the ready handler. The cost was
 * not the disagreement between the two writes but the disagreement with the
 * readers: `session-tools-core`'s `inferPackagedMode()` compared against `'1'`,
 * so from the ready handler onward — which is before any tool handler can run —
 * it answered "not packaged" in a packaged app, and all three
 * `validatePackagedEnvRuntime` guards were dead in exactly the builds they exist
 * for. Nothing failed; the app simply stopped refusing PATH-based runtimes.
 *
 * The canonical spelling was established from the packaging scripts, not from
 * the code's expectations: `scripts/build-server.ts` writes
 * `export NESSY_IS_PACKAGED=true` into the generated `bin/nessy-server` launcher
 * and `ENV NESSY_IS_PACKAGED=true` into the generated Dockerfile, and
 * `docs-site/content/server/headless.md` documents `true` as the packaged value.
 * The Electron packaging scripts never set the variable at all — this file is
 * their only source for it.
 *
 * Asserted against this file's SOURCE, in the shape
 * `managed-update-registration.test.ts` and `storage-readiness-order.test.ts`
 * established for the same file, because there is nothing at runtime to catch a
 * future edit that reintroduces a second vocabulary: both spellings assign
 * successfully, and only a guard three packages away notices the difference.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

const ASSIGNMENTS = [...source.matchAll(/process\.env\.NESSY_IS_PACKAGED\s*=\s*([^\n]*)/g)].map(
  match => match[1].trim()
)

describe('main/index.ts writes NESSY_IS_PACKAGED in one vocabulary', () => {
  it('still writes the variable, in both known places', () => {
    // A positive control for the assertions below: an empty match list would let
    // every "no bad spelling found" check pass while proving nothing.
    expect(ASSIGNMENTS.length).toBe(2)
  })

  it('never writes the numeric spelling that the runtime resolver cannot read', () => {
    for (const assignment of ASSIGNMENTS) {
      expect(assignment).not.toContain("'1'")
      expect(assignment).not.toContain("'0'")
    }
  })

  it('writes the canonical true/false spelling every reader agrees on', () => {
    for (const assignment of ASSIGNMENTS) {
      expect(assignment).toBe("app.isPackaged ? 'true' : 'false'")
    }
  })
})

// ---------------------------------------------------------------------------
// P2.349 — no SIXTH file may roll its own parse of this variable.
// ---------------------------------------------------------------------------

/**
 * One environment variable, five files, four hand-rolled parses, no shared
 * definition anywhere. That structure is what let a writer emitting `'true'`
 * coexist with a reader comparing `=== '1'` for as long as it did — the defect
 * the block above is the record of. The instance is fixed; this is what stops
 * the structure producing a second one.
 *
 * **The obvious remedy is BLOCKED, measured 2026-09-03, which is why this is a
 * guard and not a shared module.** The canonical reader `isPackagedEnvValue`
 * lives in `packages/session-tools-core`, whose `package.json` declares **no
 * `@nessy-agent/*` dependency at all** — deliberately, because that package is
 * bundled whole into the session-mcp-server subprocess. So the other readers
 * cannot import it, and moving it into `@nessy-agent/shared` would make
 * `session-tools-core` depend on shared, which is the one thing that boundary
 * exists to prevent. *Put the definition where every reader already imports
 * from* has no answer here; there is no such place. The row's own alternative
 * is what landed instead: **add the check that a new reader cannot roll its own.**
 *
 * The four parses stay DIFFERENT on purpose:
 *
 *  - `logger.ts` is TRI-STATE — `'true'` and `'false'` decide, anything else
 *    (absent included) falls through to the Electron runtime heuristic. A
 *    boolean reader cannot express that third state.
 *  - `platform-headless.ts` compares `=== 'true'` / `!== 'true'`.
 *  - `server/src/index.ts` only DEFAULTS the variable (`??= 'false'`) and never
 *    reads a value.
 *  - `resolve-script-runtime.ts` trims, lower-cases and also accepts `'1'`,
 *    because shipped builds predating the fix wrote that form and their staged
 *    subprocess bundles inherit it.
 *
 * Widening the three narrow readers to the fourth's vocabulary would be a
 * behaviour change on a packaging seam made for tidiness. Not done, and not
 * pending: this comment is the decision.
 *
 * So the assertion is only that the SET of files naming
 * `process.env.NESSY_IS_PACKAGED` is the five below. A sixth fails here with the
 * four spellings in front of it, which is the point — the failure is a prompt to
 * reuse one, or to say why a fifth vocabulary is right.
 *
 * **Instrument, and why it is `git grep` rather than a tree walk.** A readdir
 * walk that reads every `.ts`/`.tsx` was written first and is the wrong tool:
 * `git grep` answers in **0.32 s** where the walk did not finish inside a 120 s
 * budget at load average 12. `-a` is not optional — this tree has carried NUL
 * bytes in tracked sources, and a plain grep skips such a file SILENTLY, which
 * here would read as "no sixth reader". The pathspecs are plain `*.ts`/`*.tsx`
 * and deliberately not `**` globs: git reads a `**` pathspec without glob magic
 * and silently drops files.
 *
 * **Stated limit:** `git grep` searches the working tree's TRACKED files, so a
 * brand-new UNTRACKED reader is invisible until it is added. That is the state
 * this guard cannot see; every committed state it can.
 */
// `fileURLToPath`, not `new URL(...).pathname`: the latter leaves percent
// escapes in place, so a checkout under a path with a space would silently give
// git a directory that does not exist.
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

function gitGrepFiles(pattern: string): string[] {
  const result = Bun.spawnSync(
    ['git', 'grep', '-l', '-a', '--fixed-strings', pattern, '--', '*.ts', '*.tsx'],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  // git grep exits 1 for "no matches", which is a legitimate empty answer; any
  // other non-zero is a broken instrument and must not read as "nothing found".
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git grep failed (${result.exitCode}): ${new TextDecoder().decode(result.stderr)}`)
  }
  return new TextDecoder().decode(result.stdout).split('\n').filter(Boolean).sort()
}


/** Every file allowed to name the variable, and what it does with it. */
const SANCTIONED = new Map<string, string>([
  ['apps/electron/src/main/index.ts', "WRITER: app.isPackaged ? 'true' : 'false', twice"],
  ['apps/electron/src/main/logger.ts', "READER, tri-state: 'true' / 'false' / fall through"],
  ['packages/server-core/src/runtime/platform-headless.ts', "READER: === 'true' / !== 'true'"],
  ['packages/server/src/index.ts', "WRITER (default only): ??= 'false'"],
  [
    'packages/session-tools-core/src/runtime/resolve-script-runtime.ts',
    'READER, canonical: isPackagedEnvValue — trims, lower-cases, also accepts 1',
  ],
  // TEST RIGs (sanctioned 2026-10-10): four suites force dev-mode runtime resolution by
  // WRITING the canonical 'false' over the inherited packaged value (delete-then-assign,
  // the Bun 1.3.14 process.env rule, AGENTS.md) and restoring it in afterAll. None of them
  // PARSES the variable — no fifth vocabulary, no reader to fold into isPackagedEnvValue —
  // and a rig helper cannot serve across the session-tools-core boundary the docblock
  // above records, so each is allowed here by name.
  [
    'packages/server-core/src/pages/tool-callbacks.test.ts',
    "TEST RIG: writes 'false' to force dev-mode for the suite; not a parse",
  ],
  [
    'packages/session-tools-core/src/handlers/script-sandbox.test.ts',
    "TEST RIG: writes 'false' to force dev-mode for the suite; not a parse",
  ],
  [
    'packages/session-tools-core/src/handlers/transform-data.test.ts',
    "TEST RIG: writes 'false' to force dev-mode for the suite; not a parse",
  ],
  [
    'packages/shared/src/pages/data-write.test.ts',
    "TEST RIG: writes 'false' to force dev-mode for the suite; not a parse",
  ],
])

/**
 * This file. It names the variable only inside its own detector strings, so it
 * matches its own search and is neither a reader nor a writer. Listing it in
 * `SANCTIONED` would have said it parses the variable, which is the one thing
 * this guard exists to keep honest.
 */
const THIS_GUARD = 'apps/electron/src/main/__tests__/packaged-env-spelling.test.ts'

const NAMING_FILES = gitGrepFiles('process.env.NESSY_IS_PACKAGED').filter(file => file !== THIS_GUARD)

describe('NESSY_IS_PACKAGED is parsed in five known places and nowhere else', () => {
  it('the instrument works — positive control', () => {
    // A broken cwd, a wrong pathspec or a git that is not there all produce an
    // empty list, and every assertion below would pass over it. The broad search
    // must find strictly more than the narrow one, because the packaging
    // scripts, the CDP fixtures and several docblocks name the variable as text.
    const broad = gitGrepFiles('NESSY_IS_PACKAGED')
    expect(broad.length).toBeGreaterThan(NAMING_FILES.length)
    expect(broad).toContain(THIS_GUARD)
  })

  it('no sixth file rolls its own parse', () => {
    const unsanctioned = NAMING_FILES.filter(file => !SANCTIONED.has(file))
    // Reuse one of the four spellings listed in SANCTIONED (the docblock above
    // says why they differ) rather than adding a fifth — or add the file here
    // with a one-line reason naming which of the four it is.
    expect(unsanctioned).toEqual([])
  })

  it('every sanctioned file still names it — a stale allowlist is the other failure', () => {
    const missing = [...SANCTIONED.keys()].filter(file => !NAMING_FILES.includes(file))
    expect(missing).toEqual([])
  })
})
