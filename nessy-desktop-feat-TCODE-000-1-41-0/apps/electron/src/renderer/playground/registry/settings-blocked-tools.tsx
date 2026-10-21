import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry } from './types'
import {
  BLOCKED_TOOL_TREATMENTS,
  PREEMPTION_KEYS,
  SAMPLE_BLOCKED_TOOLS,
  type BlockedToolTreatment,
  type SampleDeclaration,
} from './settings-blocked-tools-data'
import {
  PermissionsDataTable,
  type PermissionRow,
  type UnenforceableStyle,
} from '@/components/info/PermissionsDataTable'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { cn } from '@/lib/utils'

// =============================================================================
// Unenforceable blockedTools (Settings → Permissions → Workspace customizations)
//
// P3.351 / P4.10 — the draft the owner picks from. `annotate` is now the
// SHIPPED default; the other four states stay drawn.
//
// `none` is what shipped until 2026-09-04: every name a user writes in
// `permissions.json`'s `blockedTools` rendered with the destructive BLOCKED
// badge, including the ones the runtime never consults. Driven through the real
// gate with two workspaces — one declaring the name, one not — in explore AND
// plan, nine of the eleven sample entries produce an IDENTICAL verdict either
// way and the call RUNS (the measurement is in
// `packages/shared/src/agent/blocked-tools-enforcement.ts`). So `none` is a
// safety claim the product does not honour, and it is kept here as the CONTROL
// the other four states are read against — not as a live option.
//
// **`annotate` was wired at the close-out** (C-2, under the delegated
// transparent-and-simple rule) as `PermissionsSettingsPage.tsx`'s
// `unenforceableStyle`, because it is the only candidate that changes no access
// claim and hides nothing: the user's own name stays where they wrote it, keeps
// its badge, and gains the sentence naming the branch that decides instead.
// That is a DEFAULT, not a closed question — the owner may still pick another
// from this draft, which is why all five states remain.
//
// The four candidates, and what each costs:
//
//   warn     — rows untouched, one disclosure block above the table. Reuses the
//              shape `IsolationNetworkPosture` already uses on this same page
//              for its own `unenforceable` lines, so the page states an
//              unenforceable setting one way rather than two.
//   grey     — the false badge is withdrawn per row and nothing explains why.
//   annotate — the badge stands and each row carries the reason.
//   filter   — the entries are removed, with a count so nothing vanishes
//              silently. The strongest and the most opinionated: it edits the
//              user's own file back at them.
//
// HOW THE WIRED VERSION GETS ITS DATA, as landed. `classifyBlockedToolDeclaration`
// over the REAL always-allowed set, called in the page's own row builder. The
// import problem that made this look like it needed a host round trip —
// `ALWAYS_ALLOWED_TOOLS` living in `mode-manager.ts`, which reaches 193
// node-builtin import edges over 274 files — was solved by lifting the NAMES
// into `agent/always-allowed-tools.ts`, a leaf with no imports at all, and
// building the Set from it. One copy, no new IPC channel, and the predicate's
// always-allowed parameter still has nowhere for a second copy to hide.
// The sample lives in `settings-blocked-tools-data.ts`, which a test CAN load;
// this file's graph reaches pdfjs and cannot be imported under bun (P3.316).
// =============================================================================

function BlockedToolsPreview({ treatment = 'none' }: { treatment?: BlockedToolTreatment }) {
  const { t } = useTranslation()

  const sentence = (entry: SampleDeclaration): string => {
    if (!entry.preemption) return ''
    return t(PREEMPTION_KEYS[entry.preemption.kind], {
      tool: entry.tool,
      matched: 'matched' in entry.preemption ? entry.preemption.matched : '',
    })
  }

  const unenforceable = SAMPLE_BLOCKED_TOOLS.filter(entry => entry.preemption !== null)

  const rows: PermissionRow[] = SAMPLE_BLOCKED_TOOLS
    .filter(entry => treatment !== 'filter' || entry.preemption === null)
    .map(entry => ({
      access: 'blocked' as const,
      type: 'tool' as const,
      pattern: entry.tool,
      comment: t('settings.permissions.customBlockedTool'),
      // `none` and `warn` leave the rows exactly as they ship today; the two
      // per-row treatments are the only ones that hand the table a sentence.
      unenforceable:
        (treatment === 'grey' || treatment === 'annotate') && entry.preemption
          ? sentence(entry)
          : null,
    }))

  const style: UnenforceableStyle = treatment === 'annotate' ? 'annotate' : 'grey'

  return (
    <div className="w-[720px] max-w-full space-y-3">
      {/* UB15.7 — the draft wears the page's material: the disclosure is a card block in the shape
          IsolationNetworkPosture now draws (in-card padding, fine print), the table a padless SettingsCard. */}
      {treatment === 'warn' && (
        <SettingsCard>
          <div className={cn(settingsUI.cardPadding, 'space-y-1')}>
            <p className={settingsUI.descriptionSmall}>
              {t('settings.permissions.blockedToolsUnenforcedTitle')}
            </p>
            <ul className="space-y-1">
              {unenforceable.map(entry => (
                <li key={entry.tool} className={settingsUI.descriptionSmall}>
                  {sentence(entry)}
                </li>
              ))}
            </ul>
            <p className={settingsUI.descriptionSmall}>
              {t('settings.permissions.blockedToolsUnenforcedHint')}
            </p>
          </div>
        </SettingsCard>
      )}

      <SettingsCard className="p-0">
        <PermissionsDataTable data={rows} unenforceableStyle={style} maxHeight={340} />
      </SettingsCard>

      {treatment === 'filter' && (
        <p className={cn(settingsUI.descriptionSmall, 'px-1')}>
          {t('settings.permissions.blockedToolsFilteredNote', { count: unenforceable.length })}
          {' '}
          {t('settings.permissions.blockedToolsUnenforcedHint')}
        </p>
      )}
    </div>
  )
}

export const settingsBlockedToolsComponents: ComponentEntry[] = [
  {
    id: 'settings-blocked-tools-unenforceable',
    name: 'Unenforceable blockedTools',
    category: 'Settings',
    description:
      'Draft (P4.10): how the Permissions table should state a blockedTools entry the runtime never consults — shipped behaviour plus four candidate treatments',
    component: BlockedToolsPreview,
    layout: 'top',
    props: [
      {
        name: 'treatment',
        description: 'Which treatment to render; `none` is what ships today',
        control: {
          type: 'select',
          options: BLOCKED_TOOL_TREATMENTS.map(value => ({
            label: {
              none: 'None — shipped today (every entry reads BLOCKED)',
              warn: 'Warn — one disclosure block above the table',
              grey: 'Grey — withdraw the badge per row',
              annotate: 'Annotate — keep the badge, give the reason',
              filter: 'Filter — remove the entries, state the count',
            }[value],
            value,
          })),
        },
        defaultValue: 'none',
      },
    ],
    variants: BLOCKED_TOOL_TREATMENTS.map(treatment => ({
      name: treatment,
      props: { treatment },
    })),
  },
]
