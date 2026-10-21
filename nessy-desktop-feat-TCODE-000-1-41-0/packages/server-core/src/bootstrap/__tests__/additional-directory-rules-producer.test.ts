/**
 * P3.339 — `additionalRuleDirectories` finally HAS a producer, and it is the
 * persisted `additionalDirectories` setting.
 *
 * Owner sitting §1.4 = (A): *"wire the Pi arm behind the existing off-by-default
 * opt-in so the setting means one thing"*. Before it, `toWorkspacePolicyContext`
 * — the ONE production producer of a `WorkspacePolicyContext` — set nothing, so
 * `NESSY_ADDITIONAL_DIRECTORIES_MEMORY` was a documented opt-in that could not
 * take effect on any runtime.
 *
 * ## What each half of this file can and cannot prove, stated rather than implied
 *
 * `toWorkspacePolicyContext` is module-private and its caller needs the whole
 * v2 capability-resolution dependency graph, so this suite does NOT stand that
 * up. It pins the two things that can go wrong independently:
 *
 *  1. **the READER** — the validation `getConfiguredAdditionalDirectories()`
 *     applies to a persisted entry before the producer forwards it, driven
 *     against real directories. A behavioural arm.
 *  2. **the JOIN** — the producer really calls that reader and really assigns
 *     the field. A SOURCE pin, in the shape `codex-usage-limit-reset.test.ts`
 *     uses for its emit site: a value computed and not forwarded is the defect
 *     wearing a fix, and a source read is the only instrument that reaches a
 *     private function.
 *
 * The consumer half — that a supplied root loads `.claude/rules/*` only behind
 * the env opt-in — is already pinned, behaviourally, by
 * `packages/shared/src/capabilities/__tests__/rules-scope-gating.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveAdditionalDirectories } from '@nessy-agent/shared/agent'

const PRODUCER_SOURCE = readFileSync(join(import.meta.dir, '..', 'storage-runtime.ts'), 'utf8')

describe('P3.339 · the producer forwards the reader\'s answer into the context', () => {
  it('imports the ONE reader of the setting rather than re-reading config.json', () => {
    // A second reader here would drift from `SessionManager.sessionAdditionalDirectories`,
    // which is the whole reason `additional-directories.ts` exists as one module.
    expect(PRODUCER_SOURCE).toContain(
      "import { getConfiguredAdditionalDirectories } from '@nessy-agent/shared/agent'",
    )
  })

  it('assigns the field from it inside toWorkspacePolicyContext', () => {
    const body = PRODUCER_SOURCE.slice(PRODUCER_SOURCE.indexOf('function toWorkspacePolicyContext'))
    const fn = body.slice(0, body.indexOf('\n}\n') + 3)
    expect(fn).toContain('const roots = getConfiguredAdditionalDirectories()')
    expect(fn).toContain('additionalRuleDirectories: roots')
    // Positive control: the slice really is the function and not an empty string
    // that would make both assertions above vacuous.
    expect(fn).toContain('projectTrustRevision: context.projectTrustRevision')
  })

  it('does NOT read the opt-in env var here — one gate, at the consumer', () => {
    // Duplicating `NESSY_ADDITIONAL_DIRECTORIES_MEMORY` at the producer would be
    // a second gate on one switch, which is the drift shape this plan keeps
    // finding. `native-sources.ts` owns the gate.
    // Both names appear in the producer's own comment explaining why the gate
    // lives elsewhere, so the assertion has to be about a READ and not a
    // mention: `process.env` next to the name, and an import of the consumer's
    // predicate. A `toContain` on either name alone fails on the comment.
    expect(PRODUCER_SOURCE).not.toMatch(/process\.env\W{0,3}NESSY_ADDITIONAL_DIRECTORIES_MEMORY/)
    expect(PRODUCER_SOURCE).not.toMatch(/import[^;]*additionalDirectoryRulesEnabled/)
    // Positive control: the same regex shape DOES fire on a read, so a green
    // result here is the absence of one rather than a regex that matches nothing.
    expect("process.env['NESSY_ADDITIONAL_DIRECTORIES_MEMORY']")
      .toMatch(/process\.env\W{0,3}NESSY_ADDITIONAL_DIRECTORIES_MEMORY/)
  })
})

describe('P3.339 · the roots the producer forwards are validated, not raw entries', () => {
  // `getConfiguredAdditionalDirectories` is `loadStoredConfig().additionalDirectories`
  // handed to this function, so this is the behaviour the producer forwards.
  // Driven against the pure resolver rather than a temp config directory: the
  // isolate preload freezes `CONFIG_DIR` for the whole runner, so a config-dir
  // arm has to be a subprocess, and a subprocess buys nothing here — the
  // storage read itself is already covered by the config suite.
  it('canonicalizes a real directory and grants it', () => {
    const extra = mkdtempSync(join(tmpdir(), 'nessy-p3339-root-'))
    mkdirSync(join(extra, '.claude', 'rules'), { recursive: true })
    const { roots, diagnostics } = resolveAdditionalDirectories([extra], { settingsFileDirectory: tmpdir() })
    expect(roots).toHaveLength(1)
    expect(roots[0]!.endsWith(extra.split('/').at(-1)!)).toBe(true)
    expect(diagnostics).toEqual([])
  })

  it('fails closed on an entry that names no directory, and SAYS so', () => {
    // A bad entry is reported, never dropped silently — otherwise an operator
    // who set the opt-in and mistyped a path gets the inert notice and no clue.
    const { roots, diagnostics } = resolveAdditionalDirectories(
      ['/definitely/not/a/real/directory/p3339'],
      { settingsFileDirectory: tmpdir() },
    )
    expect(roots).toEqual([])
    expect(diagnostics.length).toBeGreaterThan(0)
  })

  it('grants nothing for an empty list — the producer then assigns no field at all', () => {
    expect(resolveAdditionalDirectories([], { settingsFileDirectory: tmpdir() }).roots).toEqual([])
  })
})
