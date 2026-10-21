/**
 * P3.351 — the Permissions page must not render a BLOCKED claim the runtime
 * never consults without saying so.
 *
 * ## Why this asserts against SOURCE text and not a render
 *
 * `PermissionsSettingsPage.tsx`'s graph reaches `PermissionsDataTable`, whose
 * graph reaches `pdfjs-dist/build/pdf.worker.min.mjs?url` — a Vite-only
 * specifier that fails to import under bun (P3.316, contained by ruling rather
 * than by a sixth bare `mock.module`). So the wiring is pinned the way
 * `runtime-switch-costs-registry.test.ts` and the blocked-tools playground test
 * already pin theirs: the VALUES a test can hold as values are re-derived
 * through the real predicate, and the page's use of them is asserted against its
 * own source.
 *
 * The re-derivation is the part that matters. A source assertion alone would
 * pass on a page that called the predicate with a hand-written list; running the
 * predicate here over the REAL `ALWAYS_ALLOWED_TOOL_NAMES` is what makes the
 * sentence the page shows a fact about the gate.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALWAYS_ALLOWED_TOOL_NAMES } from '@nessy-agent/shared/agent/always-allowed-tools'
import { ALWAYS_ALLOWED_TOOLS } from '@nessy-agent/shared/agent/mode-manager'
import {
  BLOCKED_TOOL_PREEMPTION_KINDS,
  classifyBlockedToolDeclaration,
  type BlockedToolPreemption,
} from '@nessy-agent/shared/agent/blocked-tools-enforcement'

const PAGE = readFileSync(
  join(import.meta.dir, '..', 'PermissionsSettingsPage.tsx'),
  'utf8',
)

describe('the always-allowed names have exactly one copy', () => {
  it('mode-manager builds its Set from the leaf array', () => {
    // If someone re-lists the names in `mode-manager.ts`, this diverges. The
    // Set is what every gate consults; the array is what the renderer can
    // import. They must be the same list.
    expect([...ALWAYS_ALLOWED_TOOLS].sort()).toEqual([...ALWAYS_ALLOWED_TOOL_NAMES].sort())
  })

  it('the leaf list is not empty — the positive control', () => {
    // An empty array would make every classification below return null and the
    // page would annotate nothing, silently.
    expect(ALWAYS_ALLOWED_TOOL_NAMES.length).toBeGreaterThan(5)
  })
})

describe('the page annotates every declaration the runtime pre-empts', () => {
  it('classifies through the shared predicate over the real names', () => {
    // Re-derived, not asserted from a table: these are the four branches, each
    // reached by a name whose classification comes from the gate's own list.
    const cases: Array<[string, BlockedToolPreemption['kind']]> = [
      ['WebFetch', 'always-allowed'],
      ['anything__Read', 'always-allowed-suffix'],
      ['browser_tool', 'browser-tool'],
      ['Bash', 'bash-classifier'],
    ]
    for (const [tool, kind] of cases) {
      expect(classifyBlockedToolDeclaration(tool, ALWAYS_ALLOWED_TOOL_NAMES)?.kind, tool).toBe(kind)
    }
    // The negative control: a name the runtime really does block classifies as
    // null, so the page leaves its BLOCKED claim unannotated.
    expect(classifyBlockedToolDeclaration('mcp__acme__deploy', ALWAYS_ALLOWED_TOOL_NAMES)).toBeNull()
  })

  it('calls the predicate with the real list, never a literal', () => {
    expect(PAGE).toContain("from '@nessy-agent/shared/agent/always-allowed-tools'")
    expect(PAGE).toContain('classifyBlockedToolDeclaration(pattern, ALWAYS_ALLOWED_TOOL_NAMES)')
  })

  it('has a sentence for every branch the predicate can report', () => {
    // Exhaustive by construction: a fifth branch added to the predicate fails
    // here rather than rendering an empty annotation.
    for (const kind of BLOCKED_TOOL_PREEMPTION_KINDS) {
      expect(PAGE, kind).toContain(`'${kind}': 'settings.permissions.blockedToolsUnenforced`)
    }
  })

  it('renders the workspace table with the chosen treatment', () => {
    expect(PAGE).toContain('unenforceableStyle="annotate"')
  })
})
