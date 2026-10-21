import { describe, expect, it } from 'bun:test'
import { rebuildDevRestoreUrl } from '../window-state'

/**
 * T27 (plan 2026-08-20): a dev restore used to replay the SAVED pathname onto
 * the dev-server origin. After a packaged run the saved URL is the packaged
 * `index.html` path; Vite answers 200 for it with a page that has no
 * `window.electronAPI` and `did-fail-load` never fires — a silently broken
 * window. The rebuild keeps only the query, mirroring the prod branch.
 */
describe('rebuildDevRestoreUrl', () => {
  const DEV = 'http://localhost:5173/'

  it('drops a packaged pathname and keeps the query', () => {
    const saved = 'file:///Users/op/repo/release/mac-arm64/Nessy%20Desktop.app/Contents/Resources/app/dist/renderer/index.html?workspaceId=w1&route=chat'
    expect(rebuildDevRestoreUrl(saved, DEV)).toBe('http://localhost:5173/?workspaceId=w1&route=chat')
  })

  it('keeps a dev URL pointed at the dev root, query intact', () => {
    expect(rebuildDevRestoreUrl('http://localhost:5173/?workspaceId=w2&focused=true', DEV))
      .toBe('http://localhost:5173/?workspaceId=w2&focused=true')
  })

  it('returns null for an unparseable saved URL so the caller falls back', () => {
    expect(rebuildDevRestoreUrl('not a url', DEV)).toBeNull()
  })
})
