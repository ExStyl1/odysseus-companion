/**
 * UB7.2 — the row's component tests (upstream v0.15.1 ships no component test;
 * the colour test is `workspace-avatar-color.test.ts`). Rendered with
 * `renderToStaticMarkup` like the sibling avatar tests.
 */
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import { WorkspaceAvatar } from '../workspace-avatar'
import { workspaceAvatarColorOf, workspaceAvatarColorsAtom } from '@/atoms/workspace-avatar-colors'

function markup(workspaceId?: string, workspaceName?: string): string {
  return renderToStaticMarkup(
    <WorkspaceAvatar workspaceId={workspaceId} workspaceName={workspaceName} />,
  )
}

function tileHue(html: string): number | null {
  const match = html.match(/background-color:hsl\((\d+),/)
  return match ? Number(match[1]) : null
}

describe('WorkspaceAvatar (UB7.2)', () => {
  it('yields the same hue and initial for the same id across renders and after a rename that keeps the id', () => {
    const first = markup('ws-alpha', 'Alpha')
    const second = markup('ws-alpha', 'Alpha')
    expect(tileHue(first)).toBe(tileHue(second))
    expect(first).toContain('>A<')

    // The id is the deterministic input: a rename that keeps the id keeps the hue.
    const renamed = markup('ws-alpha', 'Alpha Renamed')
    expect(tileHue(renamed)).toBe(tileHue(first))
    expect(renamed).toContain('>A<')
  })

  it('gives different hues to two ids that differ only in the last character (the hash is not a constant)', () => {
    const a = markup('ws-alpha', 'Alpha')
    const b = markup('ws-alphb', 'Alphb')
    const hueA = tileHue(a)
    const hueB = tileHue(b)
    expect(hueA).not.toBeNull()
    expect(hueB).not.toBeNull()
    expect(hueA).not.toBe(hueB)
  })

  it('renders a fallback initial, not a blank, for an empty name', () => {
    const empty = markup('ws-alpha', '')
    expect(empty).toContain('>W<')

    const whitespace = markup('ws-alpha', '   ')
    expect(whitespace).toContain('>W<')

    // No id at all: the neutral muted fallback with the same initial rule.
    const noId = markup(undefined, '')
    expect(noId).toContain('>W<')
    expect(noId).not.toContain('background-color:hsl(')
  })
})

/**
 * UB15.9 — the per-workspace colour OVERRIDE UB7.2 left out comes back with its setter (Settings → Appearance's avatar
 * ColorPicker). The atom is read from a jotai store, so each arm renders inside its own `Provider`.
 */
describe('WorkspaceAvatar colour override (UB15.9)', () => {
  function markupWith(colors: unknown, workspaceId = 'ws-alpha'): string {
    const store = createStore()
    store.set(workspaceAvatarColorsAtom, colors as Record<string, string>)
    return renderToStaticMarkup(
      <Provider store={store}>
        <WorkspaceAvatar workspaceId={workspaceId} workspaceName="Alpha" />
      </Provider>,
    )
  }

  it('positive: an override set for this workspace paints the tile, and only this workspace', () => {
    expect(markupWith({ 'ws-alpha': '#f97316' })).toContain('background-color:#f97316')
    // control: another workspace keeps its deterministic hue
    const other = markupWith({ 'ws-alpha': '#f97316' }, 'ws-beta')
    expect(other).not.toContain('#f97316')
    expect(tileHue(other)).toBe(tileHue(markup('ws-beta', 'Alpha')))
  })

  it('negative: no override, an empty one, or a corrupt stored value falls back to the deterministic hue without throwing', () => {
    const hue = tileHue(markup('ws-alpha', 'Alpha'))
    expect(hue).not.toBeNull()
    for (const colors of [{}, { 'ws-alpha': '' }, null, [], 42, { 'ws-alpha': 7 }]) {
      expect({ colors, hue: tileHue(markupWith(colors)) }).toEqual({ colors, hue })
    }
    expect(workspaceAvatarColorOf({ 'ws-alpha': '#123456' }, 'ws-alpha')).toBe('#123456')
    expect(workspaceAvatarColorOf(null, 'ws-alpha')).toBeUndefined()
  })
})
