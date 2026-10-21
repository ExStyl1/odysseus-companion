import { useTranslation } from 'react-i18next'
import type {
  ProjectContributionItemType,
  ProjectContributionReport,
} from '@nessy-agent/shared/protocol/capabilities'

/** itemType → pluralized i18n label key (count interpolated via i18next). */
const LABEL_KEY: Record<ProjectContributionItemType, string> = {
  AGENTS_MD: 'projectTrust.provides.instructions',
  MCP_SERVER_CONFIG: 'projectTrust.provides.mcpServers',
  SKILLS: 'projectTrust.provides.skills',
  SUBAGENTS: 'projectTrust.provides.subagents',
  COMMANDS: 'projectTrust.provides.commands',
  HOOKS: 'projectTrust.provides.hooks',
  CONFIG: 'projectTrust.provides.config',
  LANGUAGE_SERVERS: 'projectTrust.provides.languageServers', // F1.809
}

export interface ProjectContributionsListProps {
  report: ProjectContributionReport | null | undefined
  className?: string
}

/**
 * Presentational per-item rows for a project-contribution report. Renders
 * nothing when the report is absent or empty, so a fail-soft/empty report
 * leaves its host surface exactly as it was before detection existed.
 *
 * UB14.39 (R6-10) — on v0.15.1's text roles, as the trust dialog that hosts it: the heading is upstream's quiet
 * section label (`text-label-sm font-medium text-tertiary`, no capitals), rows `text-label`, names secondary, the
 * source path tertiary mono.
 */
export function ProjectContributionsList({ report, className }: ProjectContributionsListProps) {
  const { t } = useTranslation()
  if (!report || report.items.length === 0) return null

  return (
    <div className={className} data-testid="project-contributions">
      <p className="mb-1.5 text-label-sm font-medium text-tertiary">
        {t('projectTrust.provides.title', { defaultValue: 'This folder provides' })}
      </p>
      <ul className="flex flex-col gap-1.5">
        {report.items.map((item, index) => {
          const remainder = item.count - item.names.length
          return (
            <li
              key={`${item.itemType}-${index}`}
              className="text-label leading-snug"
              data-testid={`contribution-${item.itemType}`}
            >
              <span className="font-medium text-foreground">
                {t(LABEL_KEY[item.itemType], { count: item.count })}
              </span>
              {item.names.length > 0 && (
                <span className="text-secondary">
                  {' — '}
                  {item.names.join(', ')}
                  {item.truncated && remainder > 0 && (
                    <> {t('projectTrust.provides.more', { n: remainder })}</>
                  )}
                </span>
              )}
              <span className="block font-mono text-mono-ui text-tertiary">
                {item.sourceLabel}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
