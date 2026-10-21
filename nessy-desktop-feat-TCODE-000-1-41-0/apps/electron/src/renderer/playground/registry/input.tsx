/**
 * Input playground samples.
 *
 * The composer itself lives in the canonical Chat Inputs entries (InputContainer and Slash Command
 * Demo) to avoid duplicate maintenance — upstream v0.15.1 keeps this list empty for that reason.
 *
 * UB14.22 adds ONE entry upstream has no counterpart for: the composer's leaf states that the
 * InputContainer knobs cannot reach — the context chip in each of its states, the toolbar status
 * slot's escape and browser overlays (driven by a double Escape and by a browser window the agent
 * controls, not by props), and the composer's own crash fallback (a render error, which no knob
 * should raise). The image-support banner already has its entry (`image-support.tsx`).
 *
 * UB14.31 adds a second: the toolbar's sources chip and our branch chip in the states a whole composer cannot
 * reach in a static render — the stale slug (never "0 sources"), the compact count, and every branch state (a
 * static render runs no fetch, so the InputContainer entry draws no branch chip at all).
 */
import * as React from 'react'
import { Provider as JotaiProvider, createStore } from 'jotai'
import { DatabaseZap, Folder, Paperclip } from 'lucide-react'
import type { BrowserInstanceInfo } from '../../../shared/types'
import { browserInstancesMapAtom } from '@/atoms/browser-pane'
import type { GitBranchesResult } from '@nessy-agent/shared/protocol'
import { FreeFormInputContextBadge } from '@/components/app-shell/input/FreeFormInputContextBadge'
import { InputErrorBoundary } from '@/components/app-shell/input/InputErrorBoundary'
import { ToolbarStatusSlot } from '@/components/app-shell/input/ToolbarStatusSlot'
import { ComposerSourcesChip } from '@/components/app-shell/input/ComposerSourcesChip'
import { BranchSwitcher } from '@/components/app-shell/input/BranchSwitcher'
import { sourceSelectionId } from '@/lib/capability-catalog'
import { mockSources, overrideElectronApiMethod } from '../mock-utils'
import type { ComponentEntry } from './types'

type LeafPart = 'context-chips' | 'escape-overlay' | 'browser-status' | 'error-fallback'
type SiteTheme = 'none' | 'light' | 'dark'

const LEAF_SESSION = 'playground-leaf-session'
const SITE_THEME_COLOR: Record<SiteTheme, string | null> = { none: null, light: '#f5f1e8', dark: '#0d1117' }

/** The boundary in its caught state: a render error is the only way in, and no knob should raise one. */
class CrashedInputErrorBoundary extends InputErrorBoundary {
  state = { hasError: true }
}

function ContextChips() {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-xl bg-raised p-2 shadow-elev-2">
      <FreeFormInputContextBadge icon={<Paperclip className="h-4 w-4" />} label="Attach" />
      <FreeFormInputContextBadge icon={<Paperclip className="h-4 w-4" />} label="2 files" hasSelection />
      <FreeFormInputContextBadge icon={<DatabaseZap className="h-4 w-4" />} label="Sources" isExpanded showChevron />
      <FreeFormInputContextBadge icon={<DatabaseZap className="h-4 w-4" />} label="Linear, GitHub" isExpanded hasSelection showChevron isOpen />
      <FreeFormInputContextBadge icon={<Folder className="h-4 w-4" />} label="nessy-desktop/apps/electron/src/renderer" hasSelection />
      <FreeFormInputContextBadge icon={<Folder className="h-4 w-4" />} label="Working directory" disabled />
    </div>
  )
}

function StatusSlotToolbar({ part, siteTheme, browserLoading }: { part: LeafPart; siteTheme: SiteTheme; browserLoading: boolean }) {
  const store = React.useMemo(() => {
    const s = createStore()
    if (part === 'browser-status') {
      const instance: BrowserInstanceInfo = {
        id: 'playground-browser',
        url: 'https://docs.example.com/guide/getting-started',
        title: 'Getting started',
        favicon: null,
        isLoading: browserLoading,
        canGoBack: true,
        canGoForward: false,
        boundSessionId: LEAF_SESSION,
        ownerType: 'session',
        ownerSessionId: LEAF_SESSION,
        isVisible: true,
        agentControlActive: true,
        themeColor: SITE_THEME_COLOR[siteTheme],
        workspaceId: null,
      }
      s.set(browserInstancesMapAtom, new Map([[instance.id, instance]]))
    }
    return s
  }, [part, siteTheme, browserLoading])

  return (
    <JotaiProvider store={store}>
      <div className="w-[560px] rounded-xl bg-raised shadow-elev-2">
        <div className="min-h-[64px] px-5 pt-4 pb-3 text-label text-tertiary">Message Nessy...</div>
        <div className="relative">
          <ToolbarStatusSlot showEscapeOverlay={part === 'escape-overlay'} sessionId={LEAF_SESSION} />
          <div className="flex items-center gap-1 px-2 pb-2 pt-1 text-label text-secondary">
            <FreeFormInputContextBadge icon={<Paperclip className="h-4 w-4" />} label="Attach" />
            <FreeFormInputContextBadge icon={<DatabaseZap className="h-4 w-4" />} label="Sources" />
          </div>
        </div>
      </div>
    </JotaiProvider>
  )
}

function ComposerLeafStates({
  part = 'context-chips',
  siteTheme = 'none',
  browserLoading = false,
}: {
  part?: LeafPart
  siteTheme?: SiteTheme
  browserLoading?: boolean
}) {
  if (part === 'context-chips') return <ContextChips />
  if (part === 'error-fallback') {
    return (
      <div className="w-[560px]">
        <CrashedInputErrorBoundary resetKey="playground">{null}</CrashedInputErrorBoundary>
      </div>
    )
  }
  return <StatusSlotToolbar part={part} siteTheme={siteTheme} browserLoading={browserLoading} />
}

type SourcesSelection = 'none' | 'one' | 'two' | 'all' | 'stale'
type BranchState = 'ok' | 'not-a-repo' | 'no-cwd' | 'error'

/** The picked slugs for each selection (the selectors store `sourceSelectionId`: here the mention ids). */
function selectionSlugs(selection: SourcesSelection): string[] {
  const ids = mockSources.map(sourceSelectionId)
  switch (selection) {
    case 'none': return []
    case 'one': return ids.slice(0, 1)
    case 'two': return ids.slice(0, 2)
    case 'all': return ids
    // A slug no offered source carries (a retired or no longer pickable one): the empty affordance.
    case 'stale': return ['retired-mcp-server']
  }
}

const BRANCH_STATES: Record<BranchState, GitBranchesResult> = {
  ok: { status: 'ok', current: 'feat/TCODE-000-composer', branches: ['main', 'feat/TCODE-000-composer', 'bugfix/TCODE-000-toolbar'] },
  'not-a-repo': { status: 'not-a-repo' },
  'no-cwd': { status: 'no-cwd' },
  error: { status: 'error', error: 'fatal: bad object HEAD' },
}

/** Install the live mock before the chip's own (passive) fetch effect runs; a static render runs neither. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

function ComposerToolbarChips({
  layout = 'desktop',
  selection = 'two',
  expanded = false,
  branchState = 'ok',
}: {
  layout?: 'desktop' | 'compact'
  selection?: SourcesSelection
  expanded?: boolean
  branchState?: BranchState
}) {
  const [open, setOpen] = React.useState(false)
  const [selectedSlugs, setSelectedSlugs] = React.useState(() => selectionSlugs(selection))
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => setSelectedSlugs(selectionSlugs(selection)), [selection])
  useIsomorphicLayoutEffect(
    () => overrideElectronApiMethod('gitBranches', async () => BRANCH_STATES[branchState]),
    [branchState],
  )
  const compact = layout === 'compact'
  return (
    <div className={compact ? 'w-[340px]' : 'w-[560px]'}>
      <div className="flex items-center gap-1 rounded-xl bg-raised px-2 pb-2 pt-2 shadow-elev-2">
        <FreeFormInputContextBadge icon={<Paperclip className="h-4 w-4" />} label="Attach" />
        <ComposerSourcesChip
          compact={compact}
          sources={mockSources}
          selectedSlugs={selectedSlugs}
          onToggleSlug={(slug) => setSelectedSlugs(prev => prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug])}
          open={open}
          setOpen={setOpen}
          isEmptySession={expanded}
          disabled={false}
          buttonRef={buttonRef}
        />
        {/* Desktop only, as in the composer (the compact toolbar mounts no branch chip). */}
        {!compact && (
          <BranchSwitcher key={branchState} sessionId={`playground-branch-${branchState}`} initialBranches={BRANCH_STATES[branchState]} />
        )}
      </div>
    </div>
  )
}

export const inputComponents: ComponentEntry[] = [
  {
    id: 'composer-leaf-states',
    name: 'Composer Leaf States',
    category: 'Chat Inputs',
    description:
      'UB14.22 — the composer leaf files on v0.15.1\'s materials, in the states the InputContainer knobs cannot reach: the context chip (icon-only, selected, expanded placeholder, open, a long path, disabled), the toolbar status slot\'s escape overlay and browser banner (no site color, a light and a dark site color, loading), and the composer crash fallback.',
    component: ComposerLeafStates,
    layout: 'centered',
    props: [
      {
        name: 'part',
        description: 'Which leaf to show',
        control: {
          type: 'select',
          options: [
            { label: 'Context chips', value: 'context-chips' },
            { label: 'Escape overlay', value: 'escape-overlay' },
            { label: 'Browser status', value: 'browser-status' },
            { label: 'Crash fallback', value: 'error-fallback' },
          ],
        },
        defaultValue: 'context-chips',
      },
      {
        name: 'siteTheme',
        description: 'Browser status: the site\'s own theme color (none = the raised card under the accent tint)',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: 'none' },
            { label: 'Light site color', value: 'light' },
            { label: 'Dark site color', value: 'dark' },
          ],
        },
        defaultValue: 'none',
      },
      {
        name: 'browserLoading',
        description: 'Browser status: the page is still loading (spinner instead of the favicon)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Context chips', props: { part: 'context-chips' } },
      { name: 'Escape overlay', description: 'Press Esc again to interrupt — the info tint over the raised fill', props: { part: 'escape-overlay' } },
      { name: 'Browser status — no site color', props: { part: 'browser-status', siteTheme: 'none' } },
      { name: 'Browser status — light site color', props: { part: 'browser-status', siteTheme: 'light' } },
      { name: 'Browser status — dark site color, loading', props: { part: 'browser-status', siteTheme: 'dark', browserLoading: true } },
      { name: 'Crash fallback', description: 'InputErrorBoundary caught a composer render error: Retry, Clear draft, Reload', props: { part: 'error-fallback' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'composer-toolbar-chips',
    name: 'Composer Toolbar Chips',
    category: 'Chat Inputs',
    description:
      'UB14.31 — v0.15.1\'s sources chip (desktop popover / compact drawer) and our git-branch chip, now in the composer toolbar after the folder chip, in every state: no source, one, two ("A, B" on desktop), all (a count), a stale slug (the empty affordance, never "0 sources"), the compact count; and the branch chip on a branch, outside a repo, without a working directory, and on a git error (disabled, the tooltip says why).',
    component: ComposerToolbarChips,
    layout: 'centered',
    props: [
      {
        name: 'layout',
        description: 'Desktop toolbar (popover, labels, branch chip) or compact (drawer, icon chips, no branch chip)',
        control: { type: 'select', options: [{ label: 'Desktop', value: 'desktop' }, { label: 'Compact', value: 'compact' }] },
        defaultValue: 'desktop',
      },
      {
        name: 'selection',
        description: 'Which sources are picked (stale = a slug no offered source carries)',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: 'none' },
            { label: 'One', value: 'one' },
            { label: 'Two', value: 'two' },
            { label: 'All three', value: 'all' },
            { label: 'Stale slug', value: 'stale' },
          ],
        },
        defaultValue: 'two',
      },
      {
        name: 'expanded',
        description: 'Empty session: the desktop chip shows its label even with nothing picked',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'branchState',
        description: 'What the session\'s git listing answers',
        control: {
          type: 'select',
          options: [
            { label: 'On a branch', value: 'ok' },
            { label: 'Not a repo', value: 'not-a-repo' },
            { label: 'No working directory', value: 'no-cwd' },
            { label: 'Git error', value: 'error' },
          ],
        },
        defaultValue: 'ok',
      },
    ],
    variants: [
      { name: 'Sources — none (empty session)', props: { selection: 'none', expanded: true } },
      { name: 'Sources — one', props: { selection: 'one' } },
      { name: 'Sources — two', description: 'Desktop names two sources: "A, B"', props: { selection: 'two' } },
      { name: 'Sources — all three', description: 'Three or more: the count', props: { selection: 'all' } },
      { name: 'Sources — stale slug', description: 'A picked slug no offered source carries: the empty affordance, never "0 sources"', props: { selection: 'stale', expanded: true } },
      { name: 'Compact — two', description: 'The compact chip counts from two', props: { layout: 'compact', selection: 'two' } },
      { name: 'Compact — stale slug', props: { layout: 'compact', selection: 'stale' } },
      { name: 'Branch — not a repo', description: 'Disabled and explained, never hidden', props: { branchState: 'not-a-repo' } },
      { name: 'Branch — no working directory', props: { branchState: 'no-cwd' } },
      { name: 'Branch — git error', props: { branchState: 'error' } },
    ],
    mockData: () => ({}),
  },
]
