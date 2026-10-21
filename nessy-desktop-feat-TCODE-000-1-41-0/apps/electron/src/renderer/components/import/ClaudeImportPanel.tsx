/**
 * ClaudeImportPanel — the presentational surface for importing a Claude Code
 * setup (`~/.claude`) into the active workspace (P2.9).
 *
 * Fully driven by props so the SAME component renders in three places — the
 * Settings → Import page, the optional onboarding step, and the playground —
 * and so its every state is asserted by a static-render renderer test. It holds
 * no data of its own: the caller owns the scan/import lifecycle and passes the
 * dry-run plan and the apply result down.
 *
 * The flow it renders: scan → dry-run PREVIEW (grouped by kind, with a
 * create/merge/conflict badge per change) → confirm → done. Cancelling from the
 * preview writes nothing, because the caller simply never invokes the import.
 *
 * UB15.3 — ours (upstream v0.15.1 has no import page), on the v0.15.1 settings
 * material: ONE `SettingsSection` inside the page's `SettingsPage` column (the
 * page owns the h2 title and lede, so the panel's own heading is the quiet group
 * label); each kind group is a raised `SettingsCard` with hairline rows; the
 * actions are the shared `Button` (primary / secondary, md); the badges are
 * v0.15.1 chips on the solved role tints; the notices follow v0.15.1's banner
 * anatomy. No raw palette class remains (the seven `amber-` / `blue-` /
 * `emerald-` lines moved to roles).
 */

import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  Check,
  Download,
  FileText,
  Info,
  KeyRound,
  RefreshCw,
  Server,
  Shield,
  Slash,
  SlidersHorizontal,
  Sparkles,
  Webhook,
} from 'lucide-react'
import type {
  ClaudeImportChange,
  ClaudeImportKind,
  ClaudeSetupImportPlan,
  ClaudeSetupImportResult,
} from '@nessy-agent/shared/capabilities/claude-setup-import'
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
// The primitives' own modules, not the barrel: the barrel's SettingsPage pulls in the app shell (PanelHeader),
// which this presentational panel and its static-render test have no use for.
import { SettingsCard } from '@/components/settings/SettingsCard'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { SourceStatusIndicator } from '@/components/ui/source-status-indicator'

export type ClaudeImportStatus = 'idle' | 'scanning' | 'preview' | 'importing' | 'done' | 'error'

export interface ClaudeImportPanelProps {
  status: ClaudeImportStatus
  /** The dry-run plan, once scanned. */
  plan?: ClaudeSetupImportPlan | null
  /** The apply result, once imported. */
  result?: ClaudeSetupImportResult | null
  /** Message shown in the error state. */
  errorMessage?: string
  onScan: () => void
  onImport: () => void
  onCancel: () => void
}

const KIND_ICON: Record<ClaudeImportKind, React.ComponentType<{ className?: string }>> = {
  instruction: FileText,
  permission: Shield,
  skill: Sparkles,
  mcp: Server,
  hook: Webhook,
  // P6.442. Both maps are TOTAL over `ClaudeImportKind` by type, which is why a
  // new kind cannot reach the store without reaching this panel: the record is
  // a compile error until it is listed, and the order array is what decides
  // whether a listed kind is ever RENDERED.
  agent: Bot,
  command: Slash,
  // P6.521 — listed per FILE, so this icon repeats down the group on purpose.
  memory: BrainCircuit,
  // P6.520 — the only kind whose target is not a workspace path, which is why
  // its label reads "App settings" rather than "Settings".
  setting: SlidersHorizontal,
}

const KIND_ORDER: ClaudeImportKind[] = [
  'instruction', 'memory', 'permission', 'skill', 'mcp', 'hook', 'agent', 'command', 'setting',
]

/**
 * The badge per change: v0.15.1's chip anatomy (`Info_Badge`: 20px, radius 4, 12px label) on the
 * solved role tints, so the label keeps its contrast on its own tint in both themes. A conflict takes
 * upstream's amber "needs you" role (info), a merge the accent, a new target success.
 */
const ACTION_CHIP_CLASS: Record<ClaudeImportChange['action'], string> = {
  conflict: 'bg-info-tint text-info',
  merge: 'bg-accent-tint text-accent',
  create: 'bg-success-tint text-success',
}

function ActionBadge({ action }: { action: ClaudeImportChange['action'] }) {
  const { t } = useTranslation()
  return (
    <span
      data-action={action}
      className={cn(
        'inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-xs px-1.5 text-label-sm font-medium',
        ACTION_CHIP_CLASS[action],
      )}
    >
      {t(`claudeImport.action.${action}`)}
    </span>
  )
}

type NoticeRole = 'neutral' | 'error' | 'info' | 'success'

/**
 * v0.15.1's banner anatomy (`Info_Alert` at v0.15.1: a role tint with its matching inset hairline,
 * the icon in the role's text colour, a semibold title over secondary text), drawn here until our
 * `Info_Alert` takes that material.
 */
const NOTICE_CLASS: Record<NoticeRole, string> = {
  neutral: 'bg-fill-hover inset-ring inset-ring-border',
  error: 'bg-destructive-tint inset-ring inset-ring-[var(--destructive-border)]',
  info: 'bg-info-tint inset-ring inset-ring-[var(--info-border)]',
  success: 'bg-success-tint inset-ring inset-ring-[var(--success-border)]',
}

const NOTICE_ICON_CLASS: Record<NoticeRole, string> = {
  neutral: 'text-secondary',
  error: 'text-destructive',
  info: 'text-info',
  success: 'text-success',
}

function Notice({
  role,
  icon,
  title,
  children,
  testId,
}: {
  role: NoticeRole
  icon: React.ReactNode
  title: React.ReactNode
  children?: React.ReactNode
  testId?: string
}) {
  return (
    <div data-notice={role} data-testid={testId} className={cn('rounded-lg px-3.5 py-3', NOTICE_CLASS[role])}>
      <div className="flex items-start gap-2.5 text-label">
        <span aria-hidden className={cn('mt-px shrink-0 [&_svg]:size-4', NOTICE_ICON_CLASS[role])}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground">{title}</div>
          {children ? <div className="mt-0.5 leading-5 text-secondary">{children}</div> : null}
        </div>
      </div>
    </div>
  )
}

/** The spinner line of the two in-flight states. */
function ProgressLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-label text-secondary">
      <Spinner className="text-tertiary" />
      {children}
    </div>
  )
}

export function ClaudeImportPanel({
  status,
  plan,
  result,
  errorMessage,
  onScan,
  onImport,
  onCancel,
}: ClaudeImportPanelProps) {
  const { t } = useTranslation()

  return (
    <SettingsSection title={t('claudeImport.title')} description={t('claudeImport.subtitle')}>
      <div className="flex flex-col gap-4">
        {status === 'idle' && (
          <div>
            <Button variant="primary" size="md" onClick={onScan}>
              <Download />
              {t('claudeImport.scan')}
            </Button>
          </div>
        )}

        {status === 'scanning' && <ProgressLine>{t('claudeImport.scanning')}</ProgressLine>}

        {status === 'error' && (
          <div className="flex flex-col gap-3">
            <Notice role="error" icon={<AlertTriangle />} title={t('claudeImport.error.title')}>
              {errorMessage || null}
            </Notice>
            <div>
              <Button variant="secondary" size="md" onClick={onScan}>
                <RefreshCw />
                {t('claudeImport.rescan')}
              </Button>
            </div>
          </div>
        )}

        {status === 'preview' && plan && (plan.empty ? (
          <div className="flex flex-col gap-3">
            <Notice role="neutral" icon={<Info />} title={t('claudeImport.empty.title')}>
              {t('claudeImport.empty.body')}
            </Notice>
            <div>
              <Button variant="secondary" size="md" onClick={onScan}>
                <RefreshCw />
                {t('claudeImport.rescan')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className={settingsUI.label}>{t('claudeImport.previewTitle')}</p>
            <ChangeList changes={plan.changes} />
            {plan.warnings.length > 0 && <WarningList warnings={plan.warnings} />}
            <div className="flex items-center gap-2">
              <Button variant="primary" size="md" onClick={onImport}>
                <Download />
                {t('claudeImport.import')}
              </Button>
              <Button variant="secondary" size="md" onClick={onCancel}>{t('claudeImport.cancel')}</Button>
            </div>
          </div>
        ))}

        {status === 'importing' && <ProgressLine>{t('claudeImport.importing')}</ProgressLine>}

        {status === 'done' && result && (
          <div className="flex flex-col gap-3">
            <Notice role="success" icon={<Check />} title={t('claudeImport.done.title')}>
              {t('claudeImport.done.applied', { count: result.applied.length })}
              {result.skipped.length > 0
                ? ` · ${t('claudeImport.done.skipped', { count: result.skipped.length })}`
                : ''}
            </Notice>
            <NeedsAuthCard changes={result.applied} />
            {result.errors.length > 0 && <WarningList warnings={result.errors} titleKey="claudeImport.done.errors" />}
          </div>
        )}
      </div>
    </SettingsSection>
  )
}

function ChangeList({ changes }: { changes: ClaudeImportChange[] }) {
  const { t } = useTranslation()
  const byKind = KIND_ORDER.map(kind => ({ kind, items: changes.filter(c => c.kind === kind) })).filter(
    g => g.items.length > 0,
  )
  return (
    <div className="flex flex-col gap-4">
      {byKind.map(group => {
        const Icon = KIND_ICON[group.kind]
        return (
          <div key={group.kind} className="space-y-2">
            {/* SettingsSection's quiet group label, with the kind's icon (ours, P6.442). */}
            <h4 className="flex items-center gap-1.5 text-label-sm font-semibold text-secondary">
              <Icon className="size-3.5 text-tertiary" />
              {t(`claudeImport.kind.${group.kind}`)}
            </h4>
            <SettingsCard>
              {group.items.map(change => (
                <div
                  key={`${change.kind}:${change.name}`}
                  className="flex items-center justify-between gap-4 px-3.5 py-2.5"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-label font-medium text-foreground">{change.name}</span>
                    {/*
                      P3.242 (z10's orthogonal half) — the panel used to render
                      `name` and `detail` and NEVER the target, so a user was
                      told "Imported: 1" without ever learning WHICH file the
                      import landed in. The plan has carried `target` per change
                      since P2.9; only the line was missing.
                    */}
                    <span className="truncate text-label-sm text-tertiary">
                      {t('claudeImport.target', { target: change.target })}
                    </span>
                    {change.detail ? (
                      <span className="truncate text-label-sm text-tertiary">{change.detail}</span>
                    ) : null}
                  </div>
                  <ActionBadge action={change.action} />
                </div>
              ))}
            </SettingsCard>
          </div>
        )
      })}
    </div>
  )
}

/**
 * P6.654 — the servers this import wrote in a SWITCHED-OFF state, named where the
 * user lands after importing rather than only inside the preview they have just
 * left. Read from `needsAuth` on the applied changes, which is set beside the
 * preview's prose from one predicate in `claude-setup-import.ts`.
 *
 * Renders NOTHING when no applied change carries the flag, so an import with
 * nothing to review looks exactly as it did before.
 *
 * P6.681 — and it now DOES use `SourceStatusIndicator`, which is the row that
 * paragraph asked for. The refusal recorded here was two measured defects, both
 * since fixed: the labels were hardcoded English (they are `sourceStatus.*` keys
 * now) and the Radix tooltip threw without a `TooltipProvider` ancestor (the
 * component carries its own). This card is the component's FIRST production
 * caller — every server it lists is in exactly one of the five states, and it is
 * `needs_auth` by construction, since that is the predicate the list filters on.
 */
function NeedsAuthCard({ changes }: { changes: ClaudeImportChange[] }) {
  const { t } = useTranslation()
  const pending = changes.filter(change => change.needsAuth)
  if (pending.length === 0) return null
  return (
    <Notice
      role="info"
      icon={<KeyRound />}
      title={t('claudeImport.needsAuth.title')}
      testId="claude-import-needs-auth"
    >
      {t('claudeImport.needsAuth.body')}
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
        {pending.map(change => (
          <li key={`${change.kind}:${change.name}`}>
            <SourceStatusIndicator status="needs_auth" size="xs" className="mr-1.5 align-middle" />
            <span className="text-foreground">{change.name}</span>
            <span className="text-tertiary">{` · ${t('claudeImport.target', { target: change.target })}`}</span>
          </li>
        ))}
      </ul>
    </Notice>
  )
}

function WarningList({ warnings, titleKey = 'claudeImport.warnings.title' }: { warnings: string[]; titleKey?: string }) {
  const { t } = useTranslation()
  return (
    <Notice role="info" icon={<AlertTriangle />} title={t(titleKey)}>
      <ul className="list-disc space-y-0.5 pl-5">
        {warnings.map((warning, index) => (
          <li key={index}>{warning}</li>
        ))}
      </ul>
    </Notice>
  )
}
