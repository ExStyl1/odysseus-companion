/**
 * UB14.61 — `WorkspaceTargetList`, the list both "Send to workspace" dialogs share since
 * v0.15.1 (upstream ships no test for it). Rendered with `renderToStaticMarkup`, like the
 * sibling `WorkspaceAvatar` tests: the list is presentational, so its markup is the contract.
 *
 * - POSITIVE: a remote whose health is `error` (ours: no saved credential, the dialogs'
 *   preflight) renders the CloudOff glyph and cannot be picked; a reachable remote renders
 *   Cloud and a local one Laptop, both pickable.
 * - BOUNDARY: an empty list renders the empty label the dialog passed and no row at all.
 * - The dialogs mount it with their own target list and their own translated empty label,
 *   so the UA1.14 rule and the F1.606 / F1.627 keys reach the shared list.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkspaceInfo } from '../../../../shared/types'
import { WorkspaceTargetList, type RemoteHealth } from '../WorkspaceTargetList'

function ws(id: string, remote = false): WorkspaceInfo {
  return {
    id,
    name: id,
    ...(remote ? { remoteServer: { url: 'wss://example.test:9100', remoteWorkspaceId: `${id}-remote` }, hasCredential: remote } : {}),
  } as unknown as WorkspaceInfo
}

function render(
  workspaces: WorkspaceInfo[],
  health: Array<[string, RemoteHealth]> = [],
  extra: { selectedId?: string | null; disabled?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <WorkspaceTargetList
      workspaces={workspaces}
      selectedId={extra.selectedId ?? null}
      onSelect={() => {}}
      disabled={extra.disabled}
      remoteHealth={new Map(health)}
      iconById={new Map()}
      emptyLabel="EMPTY-LABEL"
    />,
  )
}

/** One `<button>…</button>` per row, in order. */
function rows(html: string): string[] {
  return html.match(/<button[\s\S]*?<\/button>/g) ?? []
}

const isDisabled = (row: string) => /<button[^>]*\sdisabled=""/.test(row)

describe('WorkspaceTargetList (UB14.61)', () => {
  it('POSITIVE: an unreachable remote renders CloudOff and is disabled; a reachable remote and a local stay pickable', () => {
    const html = render(
      [ws('local-b'), ws('remote-ok', true), ws('remote-down', true)],
      [['remote-ok', 'ok'], ['remote-down', 'error']],
    )
    const [local, remoteOk, remoteDown] = rows(html)
    expect(rows(html)).toHaveLength(3)

    expect(remoteDown).toContain('lucide-cloud-off')
    expect(isDisabled(remoteDown!)).toBe(true)
    expect(remoteDown).toContain('cursor-not-allowed')

    expect(remoteOk).toContain('lucide-cloud ')
    expect(remoteOk).not.toContain('lucide-cloud-off')
    expect(isDisabled(remoteOk!)).toBe(false)

    expect(local).toContain('lucide-laptop')
    expect(isDisabled(local!)).toBe(false)
  })

  it('a remote still being checked pulses its Cloud and stays pickable; the selected row is pressed', () => {
    const html = render([ws('local-b'), ws('remote-wait', true)], [['remote-wait', 'checking']], { selectedId: 'local-b' })
    const [local, remoteWait] = rows(html)
    expect(remoteWait).toContain('animate-pulse')
    expect(isDisabled(remoteWait!)).toBe(false)
    expect(local).toContain('aria-pressed="true"')
    expect(local).toContain('bg-fill-selected')
    expect(remoteWait).toContain('aria-pressed="false"')
  })

  it('CONTROL: health is read for remotes only — an `error` entry for a LOCAL id never disables it', () => {
    const [local] = rows(render([ws('local-b')], [['local-b', 'error']]))
    expect(isDisabled(local!)).toBe(false)
    expect(local).toContain('lucide-laptop')
    expect(local).not.toContain('lucide-cloud-off')
  })

  it('`disabled` (a transfer in flight) disables every row, local ones included', () => {
    const html = render([ws('local-b'), ws('remote-ok', true)], [['remote-ok', 'ok']], { disabled: true })
    expect(rows(html).map(isDisabled)).toEqual([true, true])
  })

  it('BOUNDARY: an empty list renders the empty label and no row', () => {
    const html = render([])
    expect(html).toContain('EMPTY-LABEL')
    expect(html).toMatch(/^<p [^>]*>EMPTY-LABEL<\/p>$/)
    expect(rows(html)).toEqual([])
  })
})

describe('both Send to workspace dialogs mount the shared list (UB14.61)', () => {
  const APP_SHELL = join(import.meta.dir, '..')
  const code = (file: string) => readFileSync(join(APP_SHELL, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')

  it('the session dialog passes the UA1.14 targets and its own translated empty label', () => {
    const dialog = code('SendToWorkspaceDialog.tsx')
    expect(dialog).toContain("import { WorkspaceTargetList, type RemoteHealth } from './WorkspaceTargetList'")
    expect(dialog).toContain('workspaces={targetWorkspaces}')
    expect(dialog).toContain('emptyLabel={t("sendToWorkspace.noRemoteWorkspaces")}')
    expect(dialog).toContain('disabled={isTransferring}')
  })

  it('the resource dialog passes its targets and the F1.606 key, never upstream\'s English literal', () => {
    const dialog = code('SendResourceToWorkspaceDialog.tsx')
    expect(dialog).toContain("import { WorkspaceTargetList, type RemoteHealth } from './WorkspaceTargetList'")
    expect(dialog).toContain('workspaces={targetWorkspaces}')
    expect(dialog).toContain("emptyLabel={t('sendToWorkspace.noOtherWorkspaces')}")
    expect(dialog).not.toContain('No other workspaces available.')
    expect(dialog).toContain('disabled={isSending}')
  })

  it('CONTROL: neither dialog keeps a row loop of its own (the list is the one place rows are drawn)', () => {
    for (const file of ['SendToWorkspaceDialog.tsx', 'SendResourceToWorkspaceDialog.tsx']) {
      const dialog = code(file)
      // A row of its own is a keyed element per workspace with an avatar in it — the pre-UB14.61 shape.
      expect({ file, rows: dialog.includes('key={workspace.id}') }).toEqual({ file, rows: false })
      expect({ file, avatar: /\b(Crossfade|Workspace)Avatar\b/.test(dialog) }).toEqual({ file, avatar: false })
      expect({ file, glyphs: /\b(CloudOff|Laptop|Monitor)\b/.test(dialog) }).toEqual({ file, glyphs: false })
    }
  })
})
