/**
 * UB12.55 — the server folder browser (`ServerDirectoryBrowser`), every state on v0.15.1's restyle (UB14.46), swept in
 * DARK by `../__tests__/server-directory-browser-registry.test.ts`. Ours: v0.15.1 ships no playground entry for the
 * dialog. The app opens it only for a remote workspace (`useDirectoryPicker`), so these are states nobody reaches on
 * a developer machine.
 *
 * The entry mounts the SHIPPED markup, `ServerDirectoryBrowserView`, forced open, with the browser's state passed
 * in. A stub bridge behind the container would not do: the container loads its listing in an effect, and the static
 * sweep never runs one (UB15.8 met the same), so every state would render as the first paint. Rows select and
 * deselect and the path field types, as in the app; Go, a breadcrumb, a double-click, Select and Cancel only log,
 * because no server is behind this page.
 *
 * Manual mode draws the container's error under the path field (UB12.115; v0.15.1 draws none there): 'Manual ·
 * rejected path' is the folder `validateProjectDirectory` refused, worded by the container's own key
 * (`projects.invalidFolder`).
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { DirectoryListingResult } from '../../../shared/types'
import { ServerDirectoryBrowserView } from '@/components/ServerDirectoryBrowser'
import type { ComponentEntry } from './types'

type BrowserState = 'loading' | 'listing' | 'truncated' | 'empty' | 'error' | 'confirming' | 'manual' | 'manual-typed' | 'manual-rejected'

const WORK = '/home/alex/work'

/** The breadcrumbs the server computes (`rpc/files.ts`, `fs:listDirectory`): root first, the listed folder last. */
function crumbs(path: string): DirectoryListingResult['breadcrumbs'] {
  const parts = path.split('/').filter(Boolean)
  return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))]
}

function listingOf(path: string, names: ReadonlyArray<string | { name: string; symlink: true }>, totalEntries = names.length): DirectoryListingResult {
  return {
    currentPath: path,
    parentPath: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
    breadcrumbs: crumbs(path),
    platform: 'linux',
    truncated: totalEntries > names.length,
    totalEntries,
    entries: names.map(entry => typeof entry === 'string'
      ? { name: entry, path: `${path}/${entry}`, isSymlink: false }
      : { name: entry.name, path: `${path}/${entry.name}`, isSymlink: true }),
  }
}

const WORK_LISTING = listingOf(WORK, [
  'api-gateway',
  'mobile-app',
  'nessy-desktop',
  'payments-service',
  { name: 'shared-configs', symlink: true },
  'customer-onboarding-flow-experiments-2026-q3-with-a-folder-name-longer-than-the-row',
])

/** The server's cap is 500 folders (`rpc/files.ts`); the notice counts what was sent against what exists. */
const CAPPED = '/home/alex/node_modules'
const TRUNCATED_LISTING = listingOf(CAPPED, Array.from({ length: 500 }, (_, i) => `package-${String(i + 1).padStart(3, '0')}`), 1240)

interface Fixture {
  mode: 'browse' | 'manual'
  listing: DirectoryListingResult | null
  loading?: boolean
  confirming?: boolean
  error?: string
  /** An error the container words itself (`confirmCandidate`'s refusal), resolved through the page's i18n. */
  errorKey?: 'projects.invalidFolder'
  pathInput: string
  selectedEntry?: string
}

const FIXTURES: Record<BrowserState, Fixture> = {
  // The first paint: the start-path cascade has not answered, so there is no listing and no breadcrumb yet.
  loading: { mode: 'browse', listing: null, loading: true, pathInput: '' },
  listing: { mode: 'browse', listing: WORK_LISTING, pathInput: WORK, selectedEntry: `${WORK}/payments-service` },
  truncated: { mode: 'browse', listing: TRUNCATED_LISTING, pathInput: CAPPED },
  empty: { mode: 'browse', listing: listingOf(`${WORK}/payments-service`, []), pathInput: `${WORK}/payments-service` },
  // A failed navigation keeps the last listing (its breadcrumbs stay) and the typed path; the rows give way to the error.
  error: { mode: 'browse', listing: WORK_LISTING, pathInput: '/root', error: 'EACCES: permission denied, scandir \'/root\'' },
  // Select pressed: the folder is being validated, so the button reads Loading and is disabled.
  confirming: { mode: 'browse', listing: WORK_LISTING, pathInput: WORK, selectedEntry: `${WORK}/nessy-desktop`, confirming: true },
  manual: { mode: 'manual', listing: null, pathInput: '' },
  'manual-typed': { mode: 'manual', listing: null, pathInput: `${WORK}/payments-service` },
  // Select pressed on a typed path the server refused: the typed path stays and the refusal shows under the field.
  'manual-rejected': { mode: 'manual', listing: null, pathInput: '/home/alex/.ssh', errorKey: 'projects.invalidFolder' },
}

const log = (what: string) => (...args: unknown[]) => console.log(`[Playground] ServerDirectoryBrowser ${what}`, ...args)

function ServerDirectoryBrowserPreview({ state = 'listing', open = true }: { state?: BrowserState; open?: boolean }) {
  const { t } = useTranslation()
  const fixture = FIXTURES[state]
  // The two things the dialog itself changes without a server: the highlighted row and the typed path.
  const [selectedEntry, setSelectedEntry] = React.useState<string | null>(fixture.selectedEntry ?? null)
  const [pathInput, setPathInput] = React.useState(fixture.pathInput)
  React.useEffect(() => {
    setSelectedEntry(fixture.selectedEntry ?? null)
    setPathInput(fixture.pathInput)
  }, [fixture])

  return (
    <ServerDirectoryBrowserView
      open={open}
      mode={fixture.mode}
      listing={fixture.listing}
      loading={fixture.loading ?? false}
      confirming={fixture.confirming ?? false}
      error={fixture.errorKey ? t(fixture.errorKey) : fixture.error ?? null}
      pathInput={pathInput}
      selectedEntry={selectedEntry}
      setPathInput={setPathInput}
      navigateTo={log('navigate')}
      handlePathSubmit={log('go')}
      handleEntryClick={entryPath => setSelectedEntry(prev => prev === entryPath ? null : entryPath)}
      handleEntryDoubleClick={log('open folder')}
      handleSelect={log('select')}
      onCancel={log('cancel')}
    />
  )
}

const STATE_OPTIONS: Array<{ label: string; value: BrowserState }> = [
  { label: 'Browse · loading', value: 'loading' },
  { label: 'Browse · listing (selected row, symlink)', value: 'listing' },
  { label: 'Browse · truncated', value: 'truncated' },
  { label: 'Browse · empty folder', value: 'empty' },
  { label: 'Browse · error', value: 'error' },
  { label: 'Browse · confirming', value: 'confirming' },
  { label: 'Manual · empty', value: 'manual' },
  { label: 'Manual · typed path', value: 'manual-typed' },
  { label: 'Manual · rejected path', value: 'manual-rejected' },
]

export const serverDirectoryBrowserComponents: ComponentEntry[] = [
  {
    id: 'server-directory-browser',
    name: 'Server Folder Browser',
    category: 'Chat Inputs',
    description:
      'UB12.55 · the folder picker a remote workspace opens from the composer\'s folder chip and Settings → Workspace: browse mode lists the server\'s folders (breadcrumbs, a selected row, a symlink, the 500-folder cap, an empty folder, a failed listing, a folder being validated); manual mode asks for a typed path when the server cannot list, and says so when the server refuses it.',
    component: ServerDirectoryBrowserPreview,
    props: [
      {
        name: 'state',
        description: 'Which state of the browser to draw',
        control: { type: 'select', options: STATE_OPTIONS },
        defaultValue: 'listing',
      },
      { name: 'open', description: 'Force open', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: STATE_OPTIONS.filter(option => option.value !== 'listing').map(option => ({
      name: option.label,
      props: { state: option.value },
    })),
  },
]
