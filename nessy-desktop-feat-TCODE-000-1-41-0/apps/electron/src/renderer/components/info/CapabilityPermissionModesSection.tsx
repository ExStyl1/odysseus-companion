/**
 * CapabilityPermissionModesSection (U2)
 *
 * Skill kind-specific section: explains how a skill's "always allowed" tools
 * behave under each picker mode (Auto / Manual / Accept edits / Plan / Bypass
 * permissions — F1.1052: the real mode ids, named by the same `mode.*` keys the
 * composer uses). Reference-style rows with a per-behavior icon (blocked = X,
 * allowed = Check, neutral = Minus); the sentence is keyed by the BEHAVIOR.
 *
 * Placeholder-not-hidden (U1 principle): the section ALWAYS renders for a skill.
 * When the skill declares no always-allowed tools (`modes` absent/empty) it
 * shows a quiet in-section placeholder instead of disappearing.
 *
 * IPC-free: consumes the already-fetched SafeCapabilityDetail projection.
 *
 * UB14.59 — v0.15.1 `pages/SkillInfoPage.tsx`'s permission-mode table look: the glyphs
 * at `size-3.5`, decorative (`aria-hidden`: the sentence beside each names the
 * behaviour), the neutral one on the tertiary role, the mode on the secondary role
 * and the sentence on the foreground, rows split by the subtle hairline.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Minus, X } from 'lucide-react'
import { Info_Section } from './Info_Section'
import type { SafeCapabilityDetail } from '@nessy-agent/shared/protocol/capabilities'
import { PERMISSION_MODE_ORDER } from '@nessy-agent/shared/agent/modes'

type PermissionMode = NonNullable<SafeCapabilityDetail['permissionModes']>[number]

/** The one-line sentence per behavior; three prompting modes share "allowed". */
const BEHAVIOR_I18N: Record<PermissionMode['behavior'], string> = {
  blocked: 'skillInfo.behaviorBlocked',
  allowed: 'skillInfo.behaviorAllowed',
  neutral: 'skillInfo.behaviorNeutral',
}

/** A row id this client knows is a mode, so `mode.<id>` names it; anything else shows raw. */
const KNOWN_MODES: ReadonlySet<string> = new Set(PERMISSION_MODE_ORDER)

function BehaviorIcon({ behavior }: { behavior: PermissionMode['behavior'] }) {
  if (behavior === 'blocked') return <X className="size-3.5 shrink-0 text-destructive" aria-hidden />
  if (behavior === 'allowed') return <Check className="size-3.5 shrink-0 text-success" aria-hidden />
  return <Minus className="size-3.5 shrink-0 text-tertiary" aria-hidden />
}

export interface CapabilityPermissionModesSectionProps {
  /** Projected permission-mode rows; empty/undefined → placeholder. */
  modes?: PermissionMode[]
}

export function CapabilityPermissionModesSection({ modes }: CapabilityPermissionModesSectionProps) {
  const { t } = useTranslation()
  const hasModes = modes && modes.length > 0

  return (
    <Info_Section title={t('skillInfo.permissionModes')}>
      {hasModes ? (
        <div className="py-1">
          <p className="px-3.5 pb-1 pt-2 text-label-sm text-tertiary">{t('skillInfo.permissionModesDesc')}</p>
          {/* No inner frame: Info_Section provides the single surface layer
              (reviewer feedback 2026-07-19, same as the About panel). */}
          <div className="overflow-hidden">
            <table className="w-full text-label">
              <tbody>
                {modes.map((row, index) => {
                  const known = KNOWN_MODES.has(row.mode)
                  return (
                    <tr
                      key={row.mode}
                      className={index < modes.length - 1 ? 'border-b border-subtle' : undefined}
                      data-testid={`permission-mode-${row.mode}`}
                    >
                      <td className="w-[140px] px-3.5 py-2.5 font-medium text-secondary">
                        {known ? t(`mode.${row.mode}`) : row.mode}
                      </td>
                      <td className="px-3.5 py-2.5">
                        <span className="flex items-center gap-2">
                          <BehaviorIcon behavior={row.behavior} />
                          <span className="text-foreground">{BEHAVIOR_I18N[row.behavior] ? t(BEHAVIOR_I18N[row.behavior]) : row.behavior}</span>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="px-3.5 py-3 text-label text-tertiary" data-testid="permission-modes-empty">
          {t('capabilityDetail.noPermissionModes')}
        </p>
      )}
    </Info_Section>
  )
}
