/**
 * UA1.14 — Send to Workspace between two local workspaces.
 *
 * The first two describes are copied from
 * v0.13.4:apps/electron/src/renderer/components/app-shell/__tests__/transfer-targets.test.ts
 * (craft-agents-oss, Apache-2.0); the fixture builds `WorkspaceInfo` (our renderer
 * record, which carries `hasCredential` instead of a renderer-side token).
 *
 * The third describe pins the CALLERS: every session-menu surface and the dialog
 * take their target rule from `transfer-targets.ts`, so no surface can keep the
 * pre-UA1.14 "remote workspaces only" gate (`workspaces.some(w => w.remoteServer)`)
 * while the helper says otherwise.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceInfo } from '../../../../shared/types'
import { getTransferTargets, hasTransferTargets } from '../transfer-targets'

function ws(id: string, remote = false): WorkspaceInfo {
  return {
    id,
    name: id,
    ...(remote ? { remoteServer: { url: 'wss://example.test:9100', remoteWorkspaceId: `${id}-remote` }, hasCredential: true } : {}),
  } as unknown as WorkspaceInfo
}

describe('getTransferTargets', () => {
  it('offers every workspace except the active one, local and remote alike', () => {
    const all = [ws('local-a'), ws('local-b'), ws('remote-a', true)]

    const targets = getTransferTargets(all, 'local-a')

    expect(targets.map(w => w.id)).toEqual(['local-b', 'remote-a'])
  })

  it('includes local workspaces when the active workspace is remote (remote → local send)', () => {
    const all = [ws('local-a'), ws('remote-a', true)]

    const targets = getTransferTargets(all, 'remote-a')

    expect(targets.map(w => w.id)).toEqual(['local-a'])
  })

  it('never offers the source workspace, even when it is the only local one', () => {
    const all = [ws('local-a'), ws('remote-a', true)]

    expect(getTransferTargets(all, 'local-a').map(w => w.id)).not.toContain('local-a')
    expect(getTransferTargets([ws('local-a')], 'local-a')).toEqual([])
  })

  it('offers everything when no active workspace is known', () => {
    const all = [ws('local-a'), ws('remote-a', true)]

    expect(getTransferTargets(all, null)).toHaveLength(2)
  })
})

describe('hasTransferTargets', () => {
  it('is false with a single (active-only) workspace', () => {
    expect(hasTransferTargets([ws('local-a')])).toBe(false)
  })

  it('is true with two local workspaces — no remote required', () => {
    expect(hasTransferTargets([ws('local-a'), ws('local-b')])).toBe(true)
  })

  it('handles missing workspace lists', () => {
    expect(hasTransferTargets(undefined)).toBe(false)
    expect(hasTransferTargets(null)).toBe(false)
    expect(hasTransferTargets([])).toBe(false)
  })
})

describe('the Send to Workspace surfaces take their rule from transfer-targets.ts', () => {
  const APP_SHELL = join(import.meta.dir, '..')
  const read = (file: string) => readFileSync(join(APP_SHELL, file), 'utf8')
  const REMOTE_ONLY_GATE = /\.some\(\s*\w+\s*=>\s*\w+\.remoteServer\s*\)/

  it('the row menus gate the item on hasTransferTargets, never on a remote workspace', () => {
    for (const file of ['BatchSessionMenu.tsx', 'SessionItem.tsx']) {
      const code = read(file)
      expect(code).toMatch(/import \{ hasTransferTargets \} from ['"]\.\/transfer-targets['"]/)
      expect(code).toContain('hasTransferTargets(workspaces)')
      expect(code).not.toMatch(REMOTE_ONLY_GATE)
      expect(code).not.toContain('hasRemoteWorkspaces')
    }
    for (const file of ['SessionMenu.tsx', 'CompactSessionMenu.tsx']) {
      const code = read(file)
      expect(code).toContain('hasTransferTargets && onSendToWorkspace && (')
      expect(code).not.toContain('hasRemoteWorkspaces')
    }
  })

  it('the dialog lists getTransferTargets and imports into a local target too', () => {
    const code = read('SendToWorkspaceDialog.tsx')
    expect(code).toContain('getTransferTargets(workspaces, activeWorkspaceId)')
    // The picker renders the helper's list; the pre-UA1.14 remote-only filter of the full list is gone.
    // UB14.61: the rows moved into the shared `WorkspaceTargetList` (v0.15.1), which draws exactly the
    // list it is handed and filters nothing of its own.
    expect(code).toContain('<WorkspaceTargetList')
    expect(code).toContain('workspaces={targetWorkspaces}')
    expect(code).not.toMatch(/\bworkspaces\.filter\(/)
    const list = read('WorkspaceTargetList.tsx')
    expect(list).toContain('workspaces.map((workspace) => {')
    expect(list).not.toMatch(/\.filter\(/)
    expect(code).not.toContain('if (!targetWorkspace?.remoteServer) return')
  })
})
