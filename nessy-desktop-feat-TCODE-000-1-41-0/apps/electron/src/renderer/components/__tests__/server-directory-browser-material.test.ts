/**
 * UB14.46 — ServerDirectoryBrowser re-applies v0.15.1's restyle (the new material: type roles,
 * text-secondary/-tertiary, border-subtle, fill-hover/-selected rows at row-menu height, and the
 * primary/secondary/ghost button variants) on OUR file, whose Nessy specifics stay:
 * `validateProjectDirectory` → `IssuedProjectHandle`, the `getServerHomeDir()` start-path cascade,
 * the `projects.*` keys (upstream still ships "Go", "Loading..." and the notices as English
 * literals) and C3.58's standing local-only note, restyled by the same mapping.
 *
 * Instrument: the dialog mounts through a Radix portal, which needs a DOM the repo does not have,
 * so the class contract is read from the source with comments stripped (the pattern of
 * `project-handle-flow.test.tsx`, which reads this same file).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('../ServerDirectoryBrowser.tsx', import.meta.url), 'utf8')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('ServerDirectoryBrowser — v0.15.1 material', () => {
  it('positive: rows, notices and buttons use the v0.15.1 roles, and our specifics stay', () => {
    // Folder rows: row-menu height, selected fill vs hover fill.
    expect(code).toContain('min-h-row-menu text-label text-left -outline-offset-2')
    expect(code).toContain("selectedEntry === entry.path ? 'bg-fill-selected' : 'hover:bg-fill-hover'")
    // Breadcrumbs, the truncation notice and the listing frame.
    expect(code).toContain('text-label-sm text-tertiary overflow-x-auto py-1 min-h-6')
    expect(code).toContain('border-b border-subtle px-3 py-2 text-label-sm text-tertiary')
    expect(code).toContain('border border-subtle rounded-md overflow-hidden')
    // Buttons: Go is secondary/lg, Cancel ghost, Select primary.
    expect(code).toContain('<Button variant="secondary" size="lg" onClick={handlePathSubmit}')
    expect(code).toContain('<Button variant="ghost" onClick={onCancel}>')
    expect(code).toMatch(/<Button\s+variant="primary"\s+onClick=\{\(\) => void handleSelect\(\)\}/)
    // Path inputs on the mono UI role, both modes.
    expect(code.match(/font-mono md:text-mono-ui/g)?.length).toBe(2)
    // Nessy specifics kept.
    expect(code).toContain('window.electronAPI.validateProjectDirectory({')
    expect(code).toContain('window.electronAPI.getServerHomeDir()')
    expect(code).toContain("{t('projects.serverBrowserGo')}")
    expect(code).toContain('<p className="text-label-sm text-tertiary">\n            {t(\'projects.localOnlyNote\')}')
  })

  it('negative: no pre-redesign class, legacy variant or upstream English literal survives', () => {
    for (const legacy of [
      'text-muted-foreground',
      'border-foreground/10',
      'bg-foreground/5',
      'hover:bg-foreground/5',
      'transition-colors',
      'variant="outline"',
      'font-mono text-xs',
      'min-h-[24px]',
    ]) {
      expect({ legacy, present: code.includes(legacy) }).toEqual({ legacy, present: false })
    }
    // Upstream's literals are not taken over our keys.
    expect(code).not.toMatch(/>\s*Go\s*</)
    expect(code).not.toContain('Loading...')
    expect(code).not.toContain('No subdirectories.')
  })
})
