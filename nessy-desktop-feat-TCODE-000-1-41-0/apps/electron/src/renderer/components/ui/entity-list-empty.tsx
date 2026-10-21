/**
 * Source: v0.15.1:apps/electron/src/renderer/components/ui/entity-list-empty.tsx (UB13.13) + our
 * Keeps: type="button" (the personal-key form) and getDocUrl(docKey, i18n.resolvedLanguage).
 */
/**
 * EntityListEmptyScreen — Unified empty state for entity lists.
 *
 * Wraps the Empty primitives into a single configurable component
 * used by SessionList, SourcesListPanel, and SkillsListPanel.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from './empty'
import { Button } from './button'
import { getDocUrl, type DocFeature } from '@nessy-agent/shared/docs/doc-links'

export interface EntityListEmptyScreenProps {
  icon: React.ReactNode
  title: string
  description: string
  /** Auto-renders a "Learn more" button linking to this doc key */
  docKey?: DocFeature
  /** Extra action buttons rendered after "Learn more" */
  children?: React.ReactNode
  className?: string
}

export function EntityListEmptyScreen({
  icon,
  title,
  description,
  docKey,
  children,
  className = 'flex-1',
}: EntityListEmptyScreenProps) {
  const { t, i18n } = useTranslation()
  const hasActions = docKey || children

  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {icon}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {hasActions && (
        <EmptyContent>
          {docKey && (
            <Button
              // Same reason as the group header: this empty state renders
              // inside the personal-key form's model list. (UB13.13 Keep.)
              type="button"
              variant="secondary"
              onClick={() => window.electronAPI.openUrl(getDocUrl(docKey, i18n.resolvedLanguage))}
            >
              {t("common.learnMore")}
            </Button>
          )}
          {children}
        </EmptyContent>
      )}
    </Empty>
  )
}
