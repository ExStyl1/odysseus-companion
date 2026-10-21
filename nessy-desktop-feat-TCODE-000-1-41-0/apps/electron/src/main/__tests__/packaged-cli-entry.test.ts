/**
 * DA1.61 — a packaged build does not point at a CLI it does not ship.
 *
 * Lane SIT read three things off the packaged 1.39.0 in one sitting: `apps/cli`
 * is absent from `Contents/Resources/app` and `electron-builder.yml`'s `files`
 * list never names it; the shim that reads the two entry variables
 * (`resources/bin/nessy-general-agent`) is not in the directory prepended to the
 * agent's PATH either, existing only under `app/dist/resources/bin/`; and
 * `grep -aoF runDoctor` over `dist/main.cjs` answers 0 against
 * `collectGatewayAuthInput` 6. The owner decided the agent-facing CLI is not part
 * of the artefact, so the pointers go rather than the CLI shipping.
 *
 * ## Why this is a SOURCE assertion
 *
 * `main/index.ts` imports `electron` at module scope and cannot be loaded in a
 * test process, so its invariants are asserted against its own text — the shape
 * `packaged-env-spelling.test.ts`, `managed-update-registration.test.ts` and
 * `storage-readiness-order.test.ts` established for this same file, and for the
 * same reason each of them gives: there is nothing at runtime to catch the edit.
 *
 * It guards the CALL and never a bare identifier. A guard spelled
 * `not.toContain('NESSY_CLI_ENTRY')` would fail on the commit that removed the
 * pointer, because the comment explaining the removal names the variable — the
 * inversion AGENTS.md §Traps records twice. What must not come back is the
 * packaged PATH EXPRESSION, and the dev assignment must stay, so both directions
 * are asserted.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const lines = source.split('\n')

/** The line range of the block opened by `line`, by brace depth. */
function blockRange(openLine: number): { start: number; end: number } {
  let depth = 0
  for (let i = openLine; i < lines.length; i += 1) {
    for (const ch of lines[i]!) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (i > openLine || depth > 0) {
      if (depth === 0) return { start: openLine, end: i }
    }
  }
  throw new Error('unterminated block')
}

function lineIndexOf(pattern: RegExp): number {
  const index = lines.findIndex(line => pattern.test(line))
  expect(index).toBeGreaterThan(-1)
  return index
}

describe('DA1.61 · the CLI entry variables are a dev-only affordance', () => {
  it('POSITIVE CONTROL: this probe can see the file, and the packaged app root is still resolved', () => {
    // Without this, every absence below is equally true of an empty read.
    expect(source.length).toBeGreaterThan(1000)
    expect(source).toContain("process.env.NESSY_APP_ROOT = app.isPackaged ? app.getAppPath() : process.cwd()")
  })

  it('never resolves a CLI entry inside the app bundle again', () => {
    // The dead pointer itself, as a call and not as a name: the bundle has no
    // `apps/cli` directory for this to reach.
    expect(source).not.toContain("join(app.getAppPath(), 'apps', 'cli'")
  })

  it('still sets both entry variables, and only inside the not-packaged branch', () => {
    const guard = lineIndexOf(/^\s*if \(!app\.isPackaged\) \{\s*$/)
    const { start, end } = blockRange(guard)

    for (const pattern of [
      /^\s*process\.env\.NESSY_COMMANDS_ENTRY\s*=/,
      /^\s*process\.env\.NESSY_CLI_ENTRY\s*=/,
    ]) {
      const assignments = lines
        .map((line, index) => ({ line, index }))
        .filter(entry => pattern.test(entry.line))
      // Exactly one writer each: a second one outside the branch would restore
      // the packaged claim without touching the line this test reads.
      expect(assignments.length).toBe(1)
      expect(assignments[0]!.index).toBeGreaterThan(start)
      expect(assignments[0]!.index).toBeLessThan(end)
    }
  })

  it('BOUNDARY: the dev entry is resolved from the working directory, not from the app path', () => {
    const guard = lineIndexOf(/^\s*if \(!app\.isPackaged\) \{\s*$/)
    const { start, end } = blockRange(guard)
    const body = lines.slice(start, end + 1).join('\n')
    expect(body).toContain("join(process.cwd(), 'apps', 'cli', 'src', 'index.ts')")
  })
})

/**
 * DA1.63 — the sibling pointer, found while DA1.61 was removing the dead ones.
 *
 * The two doc variables named `app/resources/docs`, which the bundle does not
 * have: `Contents/Resources/app/resources` lists `bin`, `bridge-mcp-server`,
 * `pi-agent-server`, `scripts` and `session-mcp-server` and no `docs`, while
 * `app/dist/resources/docs` carries the docs directory in full (read off the
 * packaged 1.39.0, 2026-09-17; the shipped file set itself is derived with
 * readdirSync and censused in packages/shared/src/prompts/__tests__/docs-table-census.test.ts,
 * so no count is pinned here to rot). The control that `resourcesBase` is not simply wrong:
 * `NESSY_SCRIPTS` uses the same base and `app/resources/scripts` does exist.
 *
 * "A test that the path exists in a built tree" is asserted WITHOUT requiring
 * one, because `apps/electron/dist/` is absent from a fresh checkout and a gate
 * that is green only after a build is a gate that is skipped in CI. What is
 * asserted instead is the whole chain that makes the path true: the source file
 * this variable ultimately names really is in the repo, the copy step really
 * lands it under `dist/resources`, and the packaged branch really points there.
 * Break any one link and one of these three fails.
 */
describe('DA1.63 · the packaged doc path points where the docs actually ship', () => {
  const docsSource = new URL('../../../resources/docs/nessy-general-agent.md', import.meta.url)
  const copyStep = readFileSync(
    new URL('../../../../../scripts/electron-build-resources.ts', import.meta.url),
    'utf8',
  )

  it('LINK 1: the file the variable names exists in the repo, where build:copy reads it', () => {
    // The positive control for the two source assertions below: if this file
    // were gone, pointing at it correctly would still be pointing at nothing.
    expect(existsSync(docsSource)).toBe(true)
  })

  it('LINK 2: build:copy really lands the bundled assets under dist/resources', () => {
    // `electron-builder.yml`'s own `files` comment says the assets arrive
    // through `dist/**/*` for this reason; this is that sentence, machine-read.
    expect(copyStep).toContain('dist/resources')
  })

  it('LINK 3: the packaged branch joins dist, and never the directory the bundle lacks', () => {
    expect(source).toContain("join(resourcesBase, 'dist', 'resources', 'docs', 'nessy-general-agent.md')")
    // The call, not the identifier — a bare-name guard would fail on the very
    // commit that fixes this, because the comment explaining the fix spells the
    // old path (AGENTS.md §Traps records that inversion twice).
    expect(source).not.toContain("join(resourcesBase, 'resources', 'docs'")
  })

  it('BOUNDARY: the dev branch still resolves from the working directory, and the alias still mirrors', () => {
    expect(source).toContain(
      "join(process.cwd(), 'apps', 'electron', 'resources', 'docs', 'nessy-general-agent.md')",
    )
    // One writer, one mirror: if the two variables ever diverged, a fix applied
    // to the first would leave the second naming the directory that is not there.
    expect(source).toContain('process.env.NESSY_CLI_DOC_PATH = process.env.NESSY_COMMANDS_DOC_PATH')
  })
})
