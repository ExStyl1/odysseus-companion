/**
 * The playground's entry frame supplies `PlaygroundChatProviders` to EVERY
 * entry, and no entry wraps its own — the fix for a design surface that
 * rendered BLANK, made structural (F1.281).
 *
 * Measured 2026-09-23 on the dev playground (WJ-t): `EditPopover` (inline, on
 * opening) and `Side Question Panel (/btw)` both died with `useNavigation must
 * be used within NavigationProvider`, and with navigation supplied, next with
 * `useActionRegistry must be used within ActionRegistryProvider`. The playground
 * root supplied neither; only the mobile demos wrap their own. `ae4ee7834`
 * wrapped those two entries and F1.216 (`7d4c8d4c8`) wrapped six more its render
 * test found throwing — nine per-entry wrappers, each one entry late. F1.281
 * mounts the providers once in `PlaygroundEntryFrame` (`../ComponentPreview.tsx`)
 * and removes the nine, so a new entry that reads either hook renders by
 * construction.
 *
 * Measured before moving them (WJ-ll, 2026-09-23, dev playground on :5199):
 * `NavigationProvider` does not navigate the playground. It rewrites the query
 * string with `replaceState` (`?ws=playground-workspace&route=allSessions`,
 * `history.length` unchanged), and the playground keeps its own selection in
 * `localStorage`, not in the URL — an already-wrapped entry did exactly this
 * before the move, and the selection survived a reload with the query present.
 *
 * Source-level on purpose: rendering the registry here would pull the renderer
 * graph into a bare bun process (AGENTS.md §Traps, the `pdfjs` / `DOMMatrix`
 * cost). `registry-render.test.ts` renders every entry through the frame in a
 * child; this file pins the RULE — the frame carries the providers, the
 * providers carry the two hooks' providers, and no registry file brings its own.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'

const registryDir = new URL('../registry/', import.meta.url)

function registrySource(name: string): string {
  return readFileSync(new URL(name, registryDir), 'utf8')
}

/** `PlaygroundEntryFrame`'s own body, from its declaration to the next top-level function. */
function entryFrameSource(): string {
  const source = readFileSync(new URL('../ComponentPreview.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('export function PlaygroundEntryFrame(')
  const end = source.indexOf('\nfunction loadSavedSize(', start)
  expect({ start: start >= 0, end: end > start }).toEqual({ start: true, end: true })
  return source.slice(start, end)
}

describe('the playground entry frame carries the chat providers (F1.281)', () => {
  const mounting = readdirSync(registryDir)
    .filter(name => name.endsWith('.tsx'))
    .filter(name => registrySource(name).includes('<ChatDisplay'))

  it('POSITIVE CONTROL — the census finds the two entries measured blank', () => {
    expect(mounting).toEqual(expect.arrayContaining(['edit-popover.tsx', 'side-question.tsx']))
  })

  it('PlaygroundEntryFrame renders every entry inside PlaygroundChatProviders, keyed per entry', () => {
    const frame = entryFrameSource()
    expect(frame).toContain('<PlaygroundChatProviders key={component.id}>')
    // Outside the entry's own wrapper, so a wrapper that reads either hook finds it.
    expect(frame.indexOf('<PlaygroundChatProviders')).toBeLessThan(frame.indexOf('<Wrapper>'))
  })

  it('no registry file brings its own copy', () => {
    const own = readdirSync(registryDir)
      .filter(name => name.endsWith('.tsx') && name !== 'playground-chat-providers.tsx')
      .filter(name => /PlaygroundChatProviders/.test(registrySource(name)))
    expect(own).toEqual([])
  })

  it('the providers supply the two whose hooks throw without one', () => {
    const providers = registrySource('playground-chat-providers.tsx')
    expect(providers).toContain('<NavigationProvider')
    expect(providers).toContain('<ActionRegistryProvider>')
  })
})
