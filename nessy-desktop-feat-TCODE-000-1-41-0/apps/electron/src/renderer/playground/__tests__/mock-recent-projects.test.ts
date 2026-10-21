/**
 * F1.470 (2) (origin WJ-tail P-WJ-ll-2) — the playground's mock bridge answers `listRecentProjects`.
 *
 * `use-working-directory-state.ts` calls `window.electronAPI.listRecentProjects(workspaceId).then(…)` on mount
 * and on every picker open, so every playground entry that renders the composer's working-directory picker
 * reaches it. Only the `input-container` entry overrode it (`overrideElectronApiMethod('listRecentProjects', …)`);
 * every other entry met `undefined(…)` — a `TypeError` inside an effect, which takes the entry down. The fixture
 * now answers an empty list, the honest "no recent projects" of a design surface, and the override still shadows
 * it where a scenario seeds some.
 *
 * SAFETY: a minimal fake `window` installed and removed around each case, as `bridge-refusal.test.ts` does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

let nonce = 0
async function loadMockUtils() {
  return await import(`../mock-utils.ts?f1470=${++nonce}`) as {
    mockElectronAPI: Record<string, unknown>
    overrideElectronApiMethod: (name: string, implementation: unknown) => () => void
  }
}

beforeEach(() => {
  ;(globalThis as any).window = { electronAPI: undefined }
})

afterEach(() => {
  delete (globalThis as any).window
})

describe('playground mock bridge — recent projects (F1.470 (2))', () => {
  it('answers listRecentProjects with an empty list', async () => {
    const mod = await loadMockUtils()
    const listRecentProjects = mod.mockElectronAPI.listRecentProjects as ((workspaceId: string) => Promise<unknown>) | undefined
    expect(typeof listRecentProjects).toBe('function')
    expect(await listRecentProjects!('playground-workspace')).toEqual([])
  })

  it('a scenario override still shadows it, and its disposer puts the fixture back', async () => {
    const mod = await loadMockUtils()
    const bridge = (globalThis as any).window.electronAPI as Record<string, unknown>
    const fixture = bridge.listRecentProjects
    const seeded = [{ handleId: 'h', name: 'seeded' }]
    const dispose = mod.overrideElectronApiMethod('listRecentProjects', async () => seeded)
    expect(await (bridge.listRecentProjects as () => Promise<unknown>)()).toBe(seeded)
    dispose()
    expect(bridge.listRecentProjects).toBe(fixture)
  })
})
