import * as React from 'react'
import type { ComponentEntry } from './types'
import { BrowserOriginTrustSection } from '@/pages/settings/BrowserOriginTrustSection'

// =============================================================================
// P6.536 — the built-in browser's per-origin trust store, in Settings.
//
// The states here are the ones nobody can reach on a developer machine without
// actually approving and denying sites, which is exactly the kind of state that
// ships wrong. Three matter:
//
// EMPTY is the state every install starts in, and it is the one that has to
// explain itself: a list with nothing in it must say what will put something in
// it, or it reads as a broken panel.
//
// MIXED is where the two gates earn their separation — a site that may be
// browsed but not debugged, beside one denied outright. If those two ever render
// the same way, the row's "browsable is not debuggable" is invisible.
//
// SESSION-ONLY is the pair the row is most easily got wrong: origins visited
// this session with NO stored verdict. Nothing is listed above and the footer is
// the only thing on screen — which is correct, because allow-once is deliberately
// not persisted, and a durable version of that footer would be a browsing
// history on disk.
//
// The real component is previewed with `electronAPI.browserPane` stubbed, so
// Revoke exercises the real refresh path without touching anything.
// =============================================================================

type TrustFixtureId = 'empty' | 'mixed' | 'session-only'

interface StubEntry {
  origin: string
  navigation?: 'always-allow' | 'deny'
  cdp?: 'always-allow' | 'deny'
  decidedAt?: number
}

const FIXTURES: Record<TrustFixtureId, { origins: StubEntry[]; seenThisSession: string[] }> = {
  empty: { origins: [], seenThisSession: [] },
  mixed: {
    origins: [
      { origin: 'https://docs.example.com', navigation: 'always-allow', cdp: 'always-allow', decidedAt: 300 },
      { origin: 'https://example.com', navigation: 'always-allow', decidedAt: 200 },
      { origin: 'https://tracker.ads.example', navigation: 'deny', cdp: 'deny', decidedAt: 100 },
    ],
    seenThisSession: ['https://docs.example.com', 'https://example.com'],
  },
  'session-only': {
    origins: [],
    seenThisSession: ['https://one-off.example', 'https://another.example'],
  },
}

function BrowserOriginTrustPreview({ fixture = 'mixed' }: { fixture?: TrustFixtureId }) {
  const [origins, setOrigins] = React.useState<StubEntry[]>(FIXTURES[fixture].origins)
  const originsRef = React.useRef(origins)
  originsRef.current = origins

  React.useEffect(() => { setOrigins(FIXTURES[fixture].origins) }, [fixture])

  React.useEffect(() => {
    const win = window as unknown as { electronAPI?: Record<string, unknown> }
    const previous = win.electronAPI
    win.electronAPI = {
      ...(previous ?? {}),
      browserPane: {
        trustList: async () => ({
          origins: originsRef.current,
          seenThisSession: FIXTURES[fixture].seenThisSession,
        }),
        trustRevoke: async (origin: string) => {
          setOrigins(current => current.filter(e => e.origin !== origin))
        },
      },
    }
    return () => { win.electronAPI = previous }
  }, [fixture])

  return (
    <div className="w-full max-w-[720px] mx-auto p-6">
      <BrowserOriginTrustSection key={fixture} />
    </div>
  )
}

export const browserOriginTrustComponents: ComponentEntry[] = [
  {
    id: 'settings-browser-origin-trust',
    name: 'Built-in Browser Sites',
    category: 'Settings',
    description:
      'P6.536 · the per-origin trust store on the Permissions page. Read and revoke only — a grant is made on the card in the browser window, where the user can see the page they are approving. Revoking returns a site to asking, which is not the same as denying it.',
    component: BrowserOriginTrustPreview,
    layout: 'top',
    props: [
      {
        name: 'fixture',
        description: 'Which state of the store to draw',
        control: {
          type: 'select',
          options: [
            { label: 'Empty', value: 'empty' },
            { label: 'Mixed verdicts', value: 'mixed' },
            { label: 'Session visits only', value: 'session-only' },
          ],
        },
        defaultValue: 'mixed',
      },
    ],
    variants: [
      {
        name: 'Empty — every install starts here',
        description: 'A list with nothing in it has to say what will put something in it, or it reads as a broken panel.',
        props: { fixture: 'empty' },
      },
      {
        name: 'Mixed — where the two gates earn their separation',
        description: 'A site that may be browsed but not debugged, beside one denied outright. If those render the same way, "browsable is not debuggable" is invisible.',
        props: { fixture: 'mixed' },
      },
      {
        name: 'Session visits only — nothing stored',
        description: 'Origins touched this run with no stored verdict: the footer is the whole of what is on screen, which is correct — allow-once is deliberately not persisted, and a durable version of this footer would be a browsing history on disk.',
        props: { fixture: 'session-only' },
      },
    ],
    mockData: () => ({}),
  },
]
