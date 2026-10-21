/**
 * P2.441 — one shortcuts surface, and it is the one that can rebind.
 *
 * Static markup, read from source, because there is no React DOM harness in
 * this tree (no testing-library, no happy-dom) and the bun runner cannot load
 * the renderer component graph — the same measured trade `SessionStatusIcon.test.tsx`
 * and `actions/__tests__/hotkey-overrides.test.ts` both document.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER = join(import.meta.dir, '..', '..')
const SETTINGS_PAGE = join(RENDERER, 'pages', 'settings', 'ShortcutsPage.tsx')
const REPO_ROOT = join(RENDERER, '..', '..', '..', '..')

/**
 * The three surfaces retired by P2.441. Each rendered the same action registry
 * read-only, each had zero importers, and each dropped an unbound action with
 * `if (!hotkey) return null` — the hole P6.49 closed on the surviving page.
 */
const RETIRED = [
  join(RENDERER, 'components', 'KeyboardShortcuts.tsx'),
  join(RENDERER, 'components', 'KeyboardShortcutsDialog.tsx'),
  join(RENDERER, 'pages', 'ShortcutsPage.tsx'),
]

/**
 * Files matching `pattern` under the renderer, via `git grep -l`.
 *
 * One process rather than a readdir walk with a readFileSync per file: the walk
 * version ran ~1100 assertions over ~560 files, which took 1.3s on an idle
 * machine and 55s on a loaded one — long past bun's 5s default timeout, failing
 * for a reason unrelated to the claim. `git grep` is also this repo's stated
 * measurement tool.
 */
function rendererFilesMatching(pattern: string): string[] {
  const result = Bun.spawnSync(
    ['git', 'grep', '-lE', pattern, '--', 'apps/electron/src/renderer'],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  // git grep exits 1 with no output when nothing matches; anything else is a
  // broken probe and must not be read as an absence.
  if (result.exitCode > 1) {
    throw new Error(`git grep failed (${result.exitCode}): ${result.stderr.toString()}`)
  }
  return result.stdout.toString().split('\n').filter(Boolean)
}

describe('the retired read-only shortcut surfaces stay retired', () => {
  it('none of the three files is back', () => {
    for (const path of RETIRED) {
      expect(existsSync(path), `${path} was reintroduced`).toBe(false)
    }
  })

  it('nothing imports them, and the one that survives is the settings page', () => {
    const offenders = [
      ...rendererFilesMatching(`from ['"][^'"]*KeyboardShortcutsDialog['"]`),
      ...rendererFilesMatching(`from ['"][^'"]*components/KeyboardShortcuts['"]`),
    ]
    expect(offenders).toEqual([])
    // Positive control on the same probe: the settings page IS imported, so the
    // empty list above is not `git grep` silently matching nothing.
    expect(rendererFilesMatching(`from ['"]\\./ShortcutsPage['"]`).filter(f => f.includes('settings')).length)
      .toBeGreaterThan(0)
  })

  it('the strings only those surfaces used are gone from BOTH locales', () => {
    const locales = join(RENDERER, '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
    for (const name of ['en.json', 'ru.json']) {
      const table = JSON.parse(readFileSync(join(locales, name), 'utf8')) as Record<string, string>
      for (const key of [
        'shortcuts.agentTree',
        'shortcuts.collapseFolder',
        'shortcuts.expandFolder',
        // `R` to rename and `Delete` to delete a session: documented by the
        // retired dialog, implemented by no handler in the renderer.
        'shortcuts.deleteSession',
        'shortcuts.renameSession',
        'shortcuts.title',
      ]) {
        expect(table[key], `${name} still carries the orphaned ${key}`).toBeUndefined()
      }
      // Positive control: the surviving page's own title key is untouched.
      expect(table['settings.shortcuts.title']).toBeTruthy()
    }
  })
})

/** Comments quote the shapes these assertions forbid; assert against CODE. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('the surviving surface is the editor, and it says what it cannot do', () => {
  const page = readFileSync(SETTINGS_PAGE, 'utf8')
  const code = codeOf(page)

  it('renders an unbound action instead of dropping it', () => {
    // The defect all three retired surfaces shipped.
    expect(code).not.toContain('if (!hotkey) return null')
    expect(code).toContain("t('shortcuts.rebind.notBound')")
  })

  it('the collision warning reaches a screen reader', () => {
    // The point of a rebind surface is moving a chord that collides with
    // assistive technology; the collision message is the one that must be heard.
    expect(code).toContain('role="status"')
    expect(code).toContain('aria-live="polite"')
    // Not assertive: it must not interrupt the rebind it is describing.
    expect(code).not.toContain('aria-live="assertive"')
  })

  it('the live region pre-exists its own first message', () => {
    // `{notice && <span …>}` mounts the region together with its first update,
    // which is not reliably announced — the lesson `ReplyAnnouncer` records.
    expect(code).not.toContain('{notice && <span')
  })

  /**
   * C3.230 — the page can be asked a question, in both directions.
   *
   * Source match, like every other assertion in this describe; the ANSWERS the
   * two verbs give are driven directly in
   * `pages/settings/__tests__/shortcuts-search.test.ts`. What is pinned here is
   * that the page is WIRED to them — a correct helper nothing calls is the
   * shape P6.49 found on `userOverrides` and this file exists to prevent.
   */
  it('carries a command-name filter and a reverse lookup by keystroke', () => {
    expect(code).toContain('filterShortcutEntries(')
    expect(code).toContain('actionsOwningHotkey(')
    expect(code).toContain("t('shortcuts.search.placeholder')")
    // The reverse lookup records a real keystroke through the same inverse of
    // `matchesHotkey` the rebind recorder uses, and suspends the global handler
    // while it listens — without that, the chord being looked up FIRES.
    expect(code).toContain('hotkeyFromKeyboardEvent(event, isMac)')
    expect(code.match(/suspendHotkeys\(\)/g) ?? []).toHaveLength(2)
    // The honest half: a chord bound to nothing is an answer, and the rebind
    // path has no reason to ever say it.
    expect(code).toContain("t('shortcuts.search.unbound'")
    expect(code).toContain("t('shortcuts.search.owners'")
  })

  it('the filter compares the string the user READS, not the English label', () => {
    // `ACTION_LABEL_KEYS` is what a row renders; a filter over
    // `definitions.ts`'s `label` would answer in English on a Russian UI. One
    // resolver, used by the row and by the filter, is what makes that
    // impossible rather than merely unlikely.
    expect(code).toContain('rowLabelFor(actionId, t)')
    expect(code).toContain('label: rowLabelFor(action.id as ActionId, t)')
  })

  it('both new copy keys are in BOTH locales', () => {
    const locales = join(RENDERER, '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
    for (const name of ['en.json', 'ru.json']) {
      const table = JSON.parse(readFileSync(join(locales, name), 'utf8')) as Record<string, string>
      for (const key of [
        'shortcuts.search.placeholder', 'shortcuts.search.noMatches',
        'shortcuts.search.byKeystroke', 'shortcuts.search.listening',
        'shortcuts.search.owners', 'shortcuts.search.unbound',
      ]) {
        expect(table[key], `${name} is missing ${key}`).toBeTruthy()
      }
      // The interpolations, which no type checks: a lookup answer that lost
      // `{{keys}}` would name a chord it never prints.
      expect(table['shortcuts.search.owners']).toContain('{{keys}}')
      expect(table['shortcuts.search.owners']).toContain('{{actions}}')
      expect(table['shortcuts.search.unbound']).toContain('{{keys}}')
      expect(table['shortcuts.search.noMatches']).toContain('{{query}}')
    }
  })

  /**
   * C3.317 — the component sections are SEARCHED, not hidden.
   *
   * The failing shape this pins is a regression to `!filtering &&`, which is
   * what the page did until this row: three sections of real answers vanished
   * the moment a user typed, and `Enter sends the message` — a row this page
   * holds — was unreachable by typing `enter`.
   */
  it('renders the component sections from the FILTERED list, in both states', () => {
    expect(code).toContain('filterShortcutSections(componentSpecificSections, query)')
    expect(code).toContain('{visibleSections.map((section) => (')
    // The regression, named: a query must not empty them again.
    expect(code).not.toContain('{!filtering && componentSpecificSections.map(')
    // "nothing matched" is only true when NEITHER table has a row left.
    expect(code).toContain('filtering && visible.size === 0 && visibleSections.length === 0')
  })

  it('says on the page that those rows cannot be rebound or looked up', () => {
    // The two residues are user-facing, so they are a sentence in the UI and not
    // only a comment: the by-keystroke box answers "nothing is bound to Enter"
    // while the chat input's Enter sends the message.
    expect(code).toContain("t('shortcuts.componentSectionsNote')")
    const locales = join(RENDERER, '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
    for (const name of ['en.json', 'ru.json']) {
      const table = JSON.parse(readFileSync(join(locales, name), 'utf8')) as Record<string, string>
      expect(table['shortcuts.componentSectionsNote'], `${name} is missing it`).toBeTruthy()
    }
  })

  it('both known behaviours are recorded in the file, not left to be rediscovered', () => {
    expect(page).toContain('`Escape` cancels recording')
    expect(page).toContain('ASYNC read')
  })
})
