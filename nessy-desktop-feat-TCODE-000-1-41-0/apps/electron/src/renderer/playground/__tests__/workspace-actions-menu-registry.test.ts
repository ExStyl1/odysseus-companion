/**
 * P6.361 — the saved-action launcher's design surface.
 *
 * The menu renders NOTHING on every install that declared no action, and
 * nothing again when an operator set `disableSkillShellExecution` — the host
 * answers `[]` for both. So in the app there is no state a reviewer can open to
 * look at it, which is exactly what a playground entry is for, and why the
 * assertions below are that both the empty and the refused states have variants.
 *
 * ## Why this reads SOURCE TEXT and imports nothing
 *
 * Measured, not assumed: importing `../registry/workspace-actions-menu` inside a
 * `beforeAll` hook TIMED OUT at 120 s (`152.78 s` wall, 0 pass / 1 fail, at load
 * 10.06) — the entry pulls the menu component, which pulls the dropdown-menu,
 * styled-dropdown and header-button graph. Its sibling
 * `plugin-suggestion-tip-registry.test.ts` imports its registry module happily in
 * 25 s, so this is that graph and not contention. `registry/index` is already
 * asserted textually for exactly this family of reasons (see
 * `settings-browser-download-registry.test.ts`, which records the barrel cost);
 * this file extends the same instrument one file further rather than paying two
 * minutes on every run to construct four variant objects.
 *
 * What that costs: a syntactically valid entry with a wrong SHAPE would pass
 * here. What it keeps: the two states nobody can otherwise see cannot be dropped
 * without this going red, which is the thing worth guarding.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const REGISTRY_DIR = join(import.meta.dir, '..', 'registry')
const entrySource = readFileSync(join(REGISTRY_DIR, 'workspace-actions-menu.tsx'), 'utf-8')
const indexSource = readFileSync(join(REGISTRY_DIR, 'index.ts'), 'utf-8')

describe('saved actions menu playground entry', () => {
  it('declares one entry, under the Chat category', () => {
    expect(entrySource).toContain("id: 'workspace-actions-menu'")
    expect(entrySource).toContain("category: 'Chat'")
    // One entry, not a list that grew a second id nobody registered.
    expect(entrySource.match(/^\s+id: '/gm) ?? []).toHaveLength(1)
  })

  it('wires the module into registry/index so it renders', () => {
    expect(indexSource).toContain("import { workspaceActionsMenuComponents } from './workspace-actions-menu'")
    expect(indexSource).toContain('...workspaceActionsMenuComponents,')
  })

  it('keeps a variant for the two states the app can never show a reviewer', () => {
    // Nothing declared — the shipped default, and what the kill switch produces.
    expect(entrySource).toContain('count: 0')
    // A refusal — the only case with no transcript message behind it, so the
    // toast is the whole of what the user is told.
    expect(entrySource).toContain("outcome: 'refused'")
  })

  it('never lets the playground execute anything', () => {
    // Both seams are injected and resolve canned values; a playground that
    // reached the real bridge would be a playground that starts your dev server.
    expect(entrySource).toContain('list={')
    expect(entrySource).toContain('run={')
    // No CALL through the bridge. The prose above names `window.electronAPI`
    // without a trailing dot on purpose, so this matches invocation and not
    // documentation.
    expect(entrySource).not.toContain('window.electronAPI.')
  })
})
