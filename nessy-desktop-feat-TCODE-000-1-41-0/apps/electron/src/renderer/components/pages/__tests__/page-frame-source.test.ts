/**
 * UA7.3 — PageFrame acts only on its OWN frame's messages (spec §14 "Messages": `event.source`
 * is this iframe's contentWindow AND `event.origin === 'null'`), and the 6+7 staged copies show
 * no entry whose owning row is absent (plan Review Focus 13). The thumbnail entries are UA7.4's, the refresh entries
 * UA8.3's, the grant entries UA9.3's, the share entries UA6.7's and the project entries UA5.9's, which have all
 * landed: the poster, "Refresh preview", the refresh alert/bar, the grants menu, `PageGrantsDialog`,
 * `PageSourceAuthBanner`, the frame's action/grant handlers, the share entry, `SharePageDialog`, the share badge, the
 * delete dialog's published note, the "public copy may remain" warning, the "Move to project" submenu and the
 * library's project filter are pinned PRESENT.
 *
 * The staged-copy arm reads the component sources (this repo's `bun test` has no DOM, and a
 * Radix menu renders its items only when open); each forbidden needle has a planted positive
 * control on the same scanner.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isFromPageFrame } from '../page-frame-gates'

/** Stand-ins for two distinct `WindowProxy` objects. */
const frameWindow = { name: 'page-frame' }
const otherFrameWindow = { name: 'second-sandboxed-iframe' }

describe('isFromPageFrame — the message source check', () => {
  it('POSITIVE: this frame\'s window with the opaque origin is accepted', () => {
    expect(isFromPageFrame({ source: frameWindow, origin: 'null' }, frameWindow)).toBe(true)
  })

  it('NEGATIVE: a message from a second sandboxed iframe (also origin "null") is ignored', () => {
    expect(isFromPageFrame({ source: otherFrameWindow, origin: 'null' }, frameWindow)).toBe(false)
  })

  it('NEGATIVE: this frame\'s window with a non-opaque origin is ignored', () => {
    for (const origin of ['file://', 'http://localhost:5173', 'https://example.com', '']) {
      expect(isFromPageFrame({ source: frameWindow, origin }, frameWindow)).toBe(false)
    }
  })

  it('NEGATIVE: no frame window yet (not mounted / torn down) accepts nothing', () => {
    expect(isFromPageFrame({ source: null, origin: 'null' }, null)).toBe(false)
    expect(isFromPageFrame({ source: undefined, origin: 'null' }, undefined)).toBe(false)
  })
})

describe('wiring: PageFrame\'s message handler runs the source check before it parses', () => {
  // The check must precede the parse in the handler, or the helper above guards nothing.
  const SOURCE_CHECK_FIRST =
    /const handler = \(event: MessageEvent\) => \{[\s\S]*?if \(!isFromPageFrame\(event, frame\?\.contentWindow\)\) return[\s\S]*?parsePageBridgeMessage\(event\.data\)/

  it('POSITIVE: the handler returns on a foreign source before parsePageBridgeMessage', () => {
    expect(code('PageFrame.tsx')).toMatch(SOURCE_CHECK_FIRST)
  })

  it('NEGATIVE (control): the same pattern fails on the source with the check removed', () => {
    const src = code('PageFrame.tsx')
    const removed = src.replace(/\n\s*if \(!isFromPageFrame\(event, frame\?\.contentWindow\)\) return/, '')
    expect(removed).not.toBe(src)
    expect(removed).not.toMatch(SOURCE_CHECK_FIRST)
  })
})

const PAGES_DIR = join(import.meta.dir, '..')

function code(file: string): string {
  return readFileSync(join(PAGES_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
}

/** Needles naming an entry whose owner has not landed, with that owner. Empty since UA5.9 (2026-10-02): every owner
 * has landed; the scanner stays so a future staged range has a home. */
const ABSENT_OWNERS: ReadonlyArray<readonly [RegExp, string]> = []

/**
 * UA6.7 — what the share entries must NEVER read: upstream's Craft publication pointer in page.json (`config.share`,
 * an agent can write that file), its feature flag and its passwords (reason (a)). Ours is `page.publication`.
 */
const CRAFT_SHARE_NEEDLE = /config\.share|usePageShareCapabilities|getPageShareCapabilities|setPagePublicationPassword|passwordProtected/

function absentOwnerEntries(source: string): string[] {
  return ABSENT_OWNERS.filter(([needle]) => needle.test(source)).map(([, owner]) => owner)
}

describe('staged copies: no entry leads to an absent owner', () => {
  it('positive control: each needle is found when planted', () => {
    // UA9.3 has landed too: its entries are no longer an absent owner's.
    expect(absentOwnerEntries('<PageGrantsDialog open />')).toEqual([])
    // UA6.7 has landed too: the share dialog is no longer an absent owner's.
    expect(absentOwnerEntries('<SharePageDialog page={page} />')).toEqual([])
    // UA5.9 has landed too: the project entries are no longer an absent owner's.
    expect(absentOwnerEntries('void moveToProject(null)')).toEqual([])
    // UA7.4 and UA8.3 have landed: their entries are no longer an absent owner's.
    expect(absentOwnerEntries('window.electronAPI.regeneratePageThumbnail(ws, slug)')).toEqual([])
    expect(absentOwnerEntries('{refreshFailed && (')).toEqual([])
  })

  for (const file of ['PageView.tsx', 'PageFrame.tsx', 'PagesHome.tsx', 'PageTile.tsx', 'DeletePageDialog.tsx']) {
    it(`NEGATIVE: ${file} carries no grants, refresh, share, project or thumbnail entry`, () => {
      expect(absentOwnerEntries(code(file))).toEqual([])
    })
  }

  it('the PageView menu keeps exactly upstream\'s owned items: rename, move to project (UA5.9: "No project" + one per project), open folder, refresh preview (UA7.4), approved actions (UA9.3), delete', () => {
    const view = code('PageView.tsx')
    const items = view.match(/<StyledDropdownMenuItem\b/g) ?? []
    expect(items.length).toBe(7)
    for (const key of ['pages.renamePage', 'pages.openFolder', 'pages.refreshPreview', 'pages.grants.manage', 'pages.deletePage']) {
      expect(view).toContain(`t('${key}')`)
    }
  })

  it('UA8.3 (presence): PageView restores upstream\'s refresh-failed alert and mounts the refresh bar, whose approval names the reviewed digest', () => {
    const view = code('PageView.tsx')
    expect(view).toContain('const refreshFailed = config.lastRefresh && !config.lastRefresh.ok')
    expect(view).toMatch(/\{refreshFailed && \(/)
    expect(view).toContain("<Info_Alert.Title>{t('pages.refreshFailed')}</Info_Alert.Title>")
    expect(view).toContain('<PageRefreshBar workspaceId={activeWorkspaceId} config={config} />')
    const bar = code('PageRefreshBar.tsx')
    expect(bar).toContain(".approvePageRefresh(workspaceId, config.slug, status.sha256, { args: status.args ?? [], runtime: status.runtime ?? 'bun' })")
    expect(bar).toContain('.runPageRefreshNow(workspaceId, config.slug)')
    const header = readFileSync(join(PAGES_DIR, 'PageView.tsx'), 'utf8').split('*/')[0]!
    expect(header).not.toMatch(/→ UA8\.3/)
  })

  it('UA7.4: the tile fetches its poster only while fresh, and both menus offer "Refresh preview"', () => {
    const tile = code('PageTile.tsx')
    expect(tile).toContain('config.thumbnail.digest === config.contentDigest')
    expect(tile).toContain('.getPageThumbnail(page.workspaceId, config.slug)')
    expect(tile).toContain('result.digest === posterDigest')
    expect(tile).toContain('.regeneratePageThumbnail(page.workspaceId, config.slug)')
    expect(tile).toContain("t('pages.refreshPreview')")
    expect(code('PageView.tsx')).toContain('.regeneratePageThumbnail(activeWorkspaceId, page.config.slug)')
    // No stale UA7.4 range is left in either header.
    for (const file of ['PageTile.tsx', 'PageView.tsx']) {
      const header = readFileSync(join(PAGES_DIR, file), 'utf8').split('*/')[0]!
      expect(header).not.toMatch(/→ UA7\.4/)
    }
  })

  it('each staged copy records its withheld ranges in its header', () => {
    const header = (file: string) => readFileSync(join(PAGES_DIR, file), 'utf8').split('*/')[0]
    expect(header('PageView.tsx')).not.toMatch(/→ UA8\.3/) // UA8.3 landed: its ranges are restored
    expect(header('PageView.tsx')).not.toMatch(/→ UA9\.3/) // UA9.3 landed: its ranges are restored
    expect(header('PageFrame.tsx')).not.toMatch(/→ UA9\.3/)
    expect(header('PageView.tsx')).not.toMatch(/→ UA6\.7/) // UA6.7 landed: its ranges are restored
    expect(header('PageView.tsx')).not.toMatch(/→ UA5\.9/) // UA5.9 landed: its ranges are restored
    expect(header('PagesHome.tsx')).not.toMatch(/→ UA5\.9/)
  })

  it('UA9.3 (presence): PageView reads the ledger grants and mounts the grants menu, the auth banner and the dialog; PageFrame handles actions and grant requests', () => {
    const view = code('PageView.tsx')
    expect(view).toContain('.listPageGrants(activeWorkspaceId, pageSlug)')
    expect(view).toMatch(/\{grants\.length > 0 && \(\s*<StyledDropdownMenuItem onClick=\{\(\) => setGrantsOpen\(true\)\}>/)
    expect(view).toContain('<PageSourceAuthBanner')
    expect(view).toContain('<PageGrantsDialog')
    expect(view).toContain('grants={grants}')
    expect(view).not.toContain('config.grants')
    const frame = code('PageFrame.tsx')
    for (const needle of ["case 'action':", "case 'action-cancel':", "case 'grant-request':", '<PageGrantRequestDialog', '.executePageAction(', '.cancelPageAction(']) {
      expect(frame).toContain(needle)
    }
  })
})

describe('UA6.7 (presence): the share entries are restored, reading the publication, never config.share', () => {
  it('PageView: the header share entry opens SharePageDialog with the ledger grants; deletion warns when a copy may remain', () => {
    const view = code('PageView.tsx')
    expect(view).toContain('onClick={() => setShareOpen(true)}')
    expect(view).toContain("aria-label={t('pages.share.title')}")
    expect(view).toContain('<SharePageDialog')
    expect(view).toContain('grants={grants}')
    expect(view).toContain('const published = Boolean(page.publication && !page.publication.pendingDelete)')
    expect(view).toContain('shared={published}')
    expect(view).toContain('result?.publicCopyMayRemain')
    expect(view).toContain("t('toast.pagePublicCopyMayRemain')")
    const header = readFileSync(join(PAGES_DIR, 'PageView.tsx'), 'utf8').split('*/')[0]!
    expect(header).not.toMatch(/→ UA6\.7/)
  })

  it('PagesHome warns when a copy may remain; the tile badges a live publication; the delete dialog adds its note', () => {
    const home = code('PagesHome.tsx')
    expect(home).toContain('result?.publicCopyMayRemain')
    expect(home).toContain('shared={Boolean(pendingDelete?.publication && !pendingDelete.publication.pendingDelete)}')
    expect(code('PageTile.tsx')).toContain('{page.publication && !page.publication.pendingDelete && (')
    // UB14.53: v0.15.1's badge names itself in text ("Shared") with the same word as its title.
    expect(code('PageTile.tsx')).toContain("title={t('pages.shared')}")
    expect(code('DeletePageDialog.tsx')).toContain("{shared ? ` ${t('pages.deleteSharedNote')}` : ''}")
    for (const file of ['PagesHome.tsx', 'PageTile.tsx', 'DeletePageDialog.tsx']) {
      const header = readFileSync(join(PAGES_DIR, file), 'utf8').split('*/')[0]!
      expect(header).not.toMatch(/→ UA6\.7/)
    }
  })

  it('SharePageDialog publishes only the reviewed card (its sha256), and shows the review with the session card\'s component', () => {
    const dialog = code('SharePageDialog.tsx')
    expect(dialog).toContain('.getPageShareDataScan(workspaceId, config.slug, { includeData: includeDataSent, viewOnlyAcknowledged: ackViewOnly })')
    expect(dialog).toContain('reviewedSha256: card.sha256')
    expect(dialog).toContain('<ArtifactPublishDetails card={review.review.card} />')
    expect(dialog).toContain('.unpublishPage(workspaceId, config.slug)')
  })

  it('NEGATIVE: no file reads Craft\'s publication pointer, its flag or its passwords (positive control planted)', () => {
    expect(CRAFT_SHARE_NEEDLE.test('if (config.share) {')).toBe(true)
    for (const file of ['PageView.tsx', 'PageFrame.tsx', 'PagesHome.tsx', 'PageTile.tsx', 'DeletePageDialog.tsx', 'SharePageDialog.tsx', 'share-page-state.ts']) {
      expect(CRAFT_SHARE_NEEDLE.test(code(file))).toBe(false)
    }
  })
})

describe('UA5.9 (presence): the Pages project ranges are restored', () => {
  it('PageView: "Move to project" lists the workspace projects plus "No project", and binds through updatePage', () => {
    const view = code('PageView.tsx')
    expect(view).toContain('const { projects } = useProjects(activeWorkspaceId)')
    expect(view).toContain('await window.electronAPI.updatePage(activeWorkspaceId, page.config.slug, { projectId })')
    expect(view).toMatch(/\{projects\.length > 0 && \(\s*<DropdownMenuSub>/)
    expect(view).toContain("t('pages.moveToProject')")
    expect(view).toContain('onClick={() => void moveToProject(null)}')
    expect(view).toContain("t('sessionMenu.noProject')")
  })

  it('PagesHome: the project filter (with the "No project" sentinel), the filter over pages, the bound new page, the tile accent', () => {
    const home = code('PagesHome.tsx')
    expect(home).toContain('const [projectFilter, setProjectFilter] = useAtom(pagesProjectFilterAtom)')
    expect(home).toContain('unassignedId={PAGES_UNASSIGNED_PROJECT}')
    expect(home).toContain('if (projectId === undefined) return allow.has(PAGES_UNASSIGNED_PROJECT)')
    expect(home).toContain('...(boundProjectId ? { projectId: boundProjectId } : {})')
    expect(home).toContain('project={page.config.projectId ? projectsById.get(page.config.projectId) : undefined}')
  })

  it('NEGATIVE (control): the presence needles fail on a source with the submenu and the filter removed', () => {
    const view = code('PageView.tsx').replace(/\{projects\.length > 0 && \(\s*<DropdownMenuSub>[\s\S]*?<\/DropdownMenuSub>\s*\)\}/, '')
    expect(view).not.toMatch(/\{projects\.length > 0 && \(\s*<DropdownMenuSub>/)
    expect(view).not.toContain('onClick={() => void moveToProject(null)}')
    const home = code('PagesHome.tsx').replace(/unassignedId=\{PAGES_UNASSIGNED_PROJECT\}/, '')
    expect(home).not.toContain('unassignedId={PAGES_UNASSIGNED_PROJECT}')
  })
})
