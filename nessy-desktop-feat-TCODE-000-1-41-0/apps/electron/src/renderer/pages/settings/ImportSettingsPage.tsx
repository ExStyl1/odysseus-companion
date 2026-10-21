/**
 * ImportSettingsPage — Settings → Import (P2.9).
 *
 * Imports a Claude Code setup (`~/.claude`) into the active workspace:
 * instruction files, settings.json permissions, skills, MCP servers and hooks.
 * The heavy lifting lives in the shared converter; this page only hosts the
 * scan → dry-run preview → confirm flow via {@link ClaudeImportContainer}.
 *
 * UB15.3 — ours (upstream v0.15.1 has no import page): the page renders through
 * v0.15.1's `SettingsPage` column like every other settings page (title + the
 * `settings.import.description` lede in the column, the header carrying the
 * actions only); the panel inside is one `SettingsSection`.
 */

import { useTranslation } from 'react-i18next'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { useAppShellContext } from '@/context/AppShellContext'
import { ClaudeImportContainer } from '@/components/import/ClaudeImportContainer'
import { SettingsPage } from '@/components/settings'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'import',
}

export default function ImportSettingsPage() {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()

  return (
    <SettingsPage
      title={t('settings.import.title')}
      description={t('settings.import.description')}
      actions={<HeaderMenu route={routes.view.settings('import')} />}
    >
      <ClaudeImportContainer workspaceId={activeWorkspaceId ?? undefined} />
    </SettingsPage>
  )
}
