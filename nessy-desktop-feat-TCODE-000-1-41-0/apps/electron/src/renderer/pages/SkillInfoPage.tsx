import { skillRussianDescription } from '@/lib/odysseus-skills'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import {
  CapabilityDetailTemplate,
  CapabilityPermissionModesSection,
  CapabilityResources,
  Info_Section,
  useCapabilityPrimaryContent,
} from '@/components/info'
import { buildSkillMetadata } from './capability-info-metadata'
import { SkillDetailMenu } from '@/components/app-shell/SkillDetailActions'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { useSkillActions } from '@/hooks/useSkillActions'
import { capabilityContext, capabilityDisplayName, capabilityKeyFromRoute, isSafeSkillRow } from '@/lib/capability-catalog'
import type { SafeCapabilityDetail } from '@nessy-agent/shared/protocol/capabilities'

interface SkillInfoPageProps {
  skillSlug: string
  workspaceId: string
  workingDirectory?: string
}

export default function SkillInfoPage({ skillSlug, workspaceId }: SkillInfoPageProps) {
  const { t } = useTranslation()
  const app = useOptionalAppShellContext()
  const context = React.useMemo(
    () => app?.capabilityContext ?? capabilityContext(workspaceId),
    [app?.capabilityContext, workspaceId],
  )
  const capabilityKey = capabilityKeyFromRoute(skillSlug)
  const [detail, setDetail] = React.useState<SafeCapabilityDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      setError(null)
      setDetail(await window.electronAPI.capabilities.getDetail(context, capabilityKey))
    } catch {
      setDetail(null)
      setError(t('skillInfo.failedToLoad'))
    }
  }, [capabilityKey, context, t])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => window.electronAPI.capabilities.onChanged((event) => {
    if (event.workspaceId === workspaceId) void load()
  }), [load, workspaceId])

  const summary = detail?.summary
  const skillRow = summary && isSafeSkillRow(summary) ? summary : null
  const skillActions = useSkillActions()
  const displayName = summary ? capabilityDisplayName(summary) : capabilityKey
  const content = useCapabilityPrimaryContent(context, detail)

  const metadata = React.useMemo(
    () => (detail ? buildSkillMetadata(detail, t) : []),
    [detail, t],
  )

  return (
    <CapabilityDetailTemplate
      loading={!detail && !error}
      error={error ?? undefined}
      summary={summary ?? EMPTY_SUMMARY}
      displayName={displayName}
      tagline={summary ? skillRussianDescription(summary) : undefined}
      avatar={summary ? <SkillAvatar skill={summary} fluid workspaceId={workspaceId} /> : null}
      // UB12.80 — v0.15.1's header "⋯" (`SkillInfoPage.tsx` L153-168): the list row's own items,
      // decided and acted on by the same `skillMenuProps` / `useSkillActions`. Mounted only inside
      // the app shell (the actions are `null` outside it), so the header grows no dead "⋯".
      headerActions={skillActions && skillRow ? <SkillDetailMenu skill={skillRow} /> : undefined}
      content={{
        status: content.status,
        markdown: content.markdown,
        errorMessage: content.errorMessage,
        fileRefs: content.fileRefs,
        onOpenFileRef: content.onOpenFileRef,
        onRetry: content.retry,
      }}
      metadata={metadata}
      diagnostics={detail?.diagnostics}
      kindSections={
        detail ? (
          <>
            {/* Permission modes apply to the skill kind: always render, with a
                placeholder inside when the skill declares no always-allowed tools. */}
            <CapabilityPermissionModesSection modes={detail.permissionModes} />
            {detail.resources.length > 0 && (
              <Info_Section
                title={t('skillInfo.instructions')}
                description={summary?.readOnly ? t('skillInfo.managedByPlugin') : undefined}
              >
                <CapabilityResources context={context} detail={detail} />
              </Info_Section>
            )}
          </>
        ) : undefined
      }
    />
  )
}

// CapabilityDetailTemplate requires a summary; during the initial load/error
// states it is gated behind `loading`/`error` and never rendered, so a minimal
// placeholder satisfies the type without ever reaching the DOM.
const EMPTY_SUMMARY = {} as SafeCapabilityDetail['summary']
