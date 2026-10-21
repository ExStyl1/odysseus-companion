/**
 * Ours (no upstream counterpart: v0.15.1's `structured/` has no workflow-launch card). UB14.25 restyles it onto
 * v0.15.1's decision anatomy (`./DecisionCard`, UB14.20; spec §7.6): the info tile and title, the consent text
 * in the indented details, Once primary · Always for this project secondary · spacer · Deny ghost. Restyle
 * only: the three answers and what each sends (`onRespond(true,false)` / `(true,true)` / `(false)`) are
 * unchanged, and a workflow that declares no phases still renders all three.
 */
import { useTranslation } from 'react-i18next'
import { Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PermissionRequest } from '../../../../../shared/types'
import {
  DECISION_ACTION,
  DecisionActions,
  DecisionBody,
  DecisionCard,
  DecisionDetails,
  DecisionHeader,
  DecisionSpacer,
} from './DecisionCard'

interface WorkflowLaunchRequestProps {
  request: PermissionRequest
  /** `always` records the durable per-workflow-per-project consent host-side. */
  onRespond: (approved: boolean, always?: boolean) => void
  /** When true, the composer slot (InputContainer) draws the card material and ring */
  unstyled?: boolean
}

/**
 * WorkflowLaunchRequest - Launch consent for a workflow run.
 *
 * The documented card (`workflows.md` §Approve the plan before it runs): the
 * workflow name, the phase list, and a token-usage caution, with Once, Always,
 * and Deny actions. The Always scope is the workflow AND the project — it is a
 * durable record, not a timed remember window. Deliberately NOT the
 * admin-elevation template: no macOS prompt is involved in launching a workflow.
 */
export function WorkflowLaunchRequest({
  request,
  onRespond,
  unstyled = false,
}: WorkflowLaunchRequestProps) {
  const { t } = useTranslation()
  const workflowName = request.command || request.toolName

  return (
    <DecisionCard tone="info" standalone={!unstyled}>
      <DecisionBody>
        <DecisionHeader tone="info" icon={<Workflow />} title={t('chat.workflowLaunch.title', { name: workflowName })} />
        <DecisionDetails>
          <p className="whitespace-pre-wrap text-label text-secondary">
            {request.description}
          </p>
        </DecisionDetails>
      </DecisionBody>

      <DecisionActions>
        <Button
          variant="primary"
          size="lg"
          className={`${DECISION_ACTION} cursor-pointer`}
          onClick={() => onRespond(true, false)}
        >
          {t('chat.workflowLaunch.approveOnce')}
        </Button>

        <Button
          variant="secondary"
          size="lg"
          className={`${DECISION_ACTION} cursor-pointer`}
          onClick={() => onRespond(true, true)}
        >
          {t('chat.workflowLaunch.approveAlways')}
        </Button>

        <DecisionSpacer />

        <Button
          variant="ghost"
          size="lg"
          className={DECISION_ACTION}
          onClick={() => onRespond(false)}
        >
          {t('chat.workflowLaunch.deny')}
        </Button>
      </DecisionActions>
    </DecisionCard>
  )
}
