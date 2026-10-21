/**
 * PhaseBadge
 *
 * Colored badge indicating the phase/timing of an automation trigger event.
 * Derives from getEventCategory() to avoid duplicating event classification.
 */

import { useTranslation } from 'react-i18next'
import { getEventCategory, type AutomationTrigger, type EventCategory } from './types'
import { Info_Badge, type BadgeColor } from '@/components/info'

/** `labelKey` resolves at render (UA12.214 — module scope would freeze the language). */
const CATEGORY_BADGE: Record<EventCategory, { labelKey: string; color: BadgeColor }> = {
  'scheduled':   { labelKey: 'automations.phaseBadgeScheduled', color: 'success' },
  'agent-pre':   { labelKey: 'automations.phaseBadgeBefore',    color: 'warning' },
  'agent-post':  { labelKey: 'automations.phaseBadgeAfter',     color: 'success' },
  'agent-error': { labelKey: 'automations.phaseBadgeOnError',   color: 'destructive' },
  'label':       { labelKey: 'automations.phaseBadgeEvent',     color: 'default' },
  'permission':  { labelKey: 'automations.phaseBadgeEvent',     color: 'default' },
  'flag':        { labelKey: 'automations.phaseBadgeEvent',     color: 'default' },
  'todo':        { labelKey: 'automations.phaseBadgeEvent',     color: 'default' },
  'session':     { labelKey: 'automations.phaseBadgeEvent',     color: 'default' },
  'other':       { labelKey: 'automations.phaseBadgeEvent',     color: 'default' },
}

export interface PhaseBadgeProps {
  event: AutomationTrigger
  className?: string
}

export function PhaseBadge({ event, className }: PhaseBadgeProps) {
  const { t } = useTranslation()
  const category = getEventCategory(event)
  const badge = CATEGORY_BADGE[category]

  return (
    <Info_Badge color={badge.color} className={className}>
      {t(badge.labelKey)}
    </Info_Badge>
  )
}
