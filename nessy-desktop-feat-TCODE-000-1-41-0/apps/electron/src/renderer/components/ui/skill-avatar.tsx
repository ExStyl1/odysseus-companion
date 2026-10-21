import { Zap } from 'lucide-react'
import { EntityIcon } from '@/components/ui/entity-icon'
import type { IconSize, ResolvedEntityIcon } from '@nessy-agent/shared/icons'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

interface SkillAvatarProps {
  skill: SafeCapabilitySummary
  size?: IconSize
  fluid?: boolean
  className?: string
  workspaceId?: string
}

export function SkillAvatar({ skill, size = 'md', fluid, className }: SkillAvatarProps) {
  const icon: ResolvedEntityIcon = skill.iconUrl
    ? { kind: 'file', value: skill.iconUrl, colorable: false }
    : { kind: 'fallback', colorable: false }

  return (
    <EntityIcon
      icon={icon}
      size={size}
      fallbackIcon={Zap}
      alt={skill.logicalName}
      className={className}
      containerClassName={fluid ? 'h-full w-full' : undefined}
    />
  )
}
