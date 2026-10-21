import { Lightbulb } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import {
  describeAdvisorConsultation,
  type AdvisorMomentId,
} from './advisor-consultation'
import { CardWell, CHIP_NEUTRAL } from './transcript-card-chrome'

/**
 * P4.5 — the consultation card in the `renderActivity` slot.
 *
 * JSX only. Every decision — whether this row is a consultation, which model
 * advised, what the advice says, which moment it was — lives in
 * `advisor-consultation.ts`, which is assertable on values; see that module's
 * header for why the guidance is recovered by reading a string the host
 * composes, and why anything unrecognised renders NOTHING here so the ordinary
 * `ActivityRow` paints the row instead.
 *
 * Shaped after `TodoListCard`, its sibling in this slot: same container, same
 * header row, same type scale. A consultation is advice the user may want to
 * read but never has to act on, so the body is quiet — no accent, no border of
 * its own — and the model name sits in the header where the other cards put
 * their summary, because "which model said this" is the first thing that
 * qualifies the advice.
 *
 * UB14.18 — on v0.15.1's language the advice is a block to read, so the card is
 * a sunken well (`PreviewBlockFrame`'s anatomy, `transcript-card-chrome.tsx`):
 * the 32px header carries the icon, the title, the moment, and the model as a
 * neutral chip where a code well keeps its actions; the body is copy in the
 * foreground ink, the question above it in the tertiary one.
 */

type AdvisorConsultationCardProps = {
  activity: ActivityItem
}

const MOMENT_LABEL_KEYS: Record<AdvisorMomentId, string> = {
  'approach': 'chat.advisor.moment.approach',
  'recurring-error': 'chat.advisor.moment.recurringError',
  'before-done': 'chat.advisor.moment.beforeDone',
}

export function AdvisorConsultationCard({ activity }: AdvisorConsultationCardProps) {
  const { t } = useTranslation()
  const consultation = describeAdvisorConsultation(activity)
  if (!consultation) return null

  const momentLabel = consultation.moment ? t(MOMENT_LABEL_KEYS[consultation.moment]) : null

  return (
    <CardWell
      title={t('chat.advisor.title')}
      icon={<Lightbulb />}
      meta={momentLabel && (
        <span className="min-w-0 truncate">{momentLabel}</span>
      )}
      data-advisor-card=""
      actions={(
        <span
          title={consultation.modelId}
          className={CHIP_NEUTRAL}
        >
          {t('chat.advisor.advisedBy', { model: consultation.modelId })}
        </span>
      )}
    >
      <div className="px-3 py-2">
        {consultation.question && (
          <p className="mb-1 min-w-0 truncate text-label-sm text-tertiary">
            {consultation.question}
          </p>
        )}
        <p className="min-w-0 whitespace-pre-wrap text-label text-foreground">
          {consultation.guidance}
        </p>
      </div>
    </CardWell>
  )
}
