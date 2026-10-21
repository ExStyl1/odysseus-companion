/**
 * Settings Page Components Registry
 *
 * Maps settings subpage IDs to their React components.
 * TypeScript enforces that all pages defined in settings-registry have a component here.
 *
 * To add a new settings page:
 * 1. Add to SETTINGS_PAGES in shared/settings-registry.ts
 * 2. Create the page component (e.g., NewSettingsPage.tsx)
 * 3. Add to SETTINGS_PAGE_COMPONENTS below
 * 4. Add icon to SETTINGS_ICONS in components/icons/SettingsIcons.tsx
 */

import type { ComponentType } from 'react'
import type { SettingsSubpage } from '../../../shared/settings-registry'

import AppSettingsPage from './AppSettingsPage'
import AiSettingsPage from './AiSettingsPage'
import AppearanceSettingsPage from './AppearanceSettingsPage'
import InputSettingsPage from './InputSettingsPage'
import WorkspaceSettingsPage from './WorkspaceSettingsPage'
import ImportSettingsPage from './ImportSettingsPage'
import PermissionsSettingsPage from './PermissionsSettingsPage'
import LabelsSettingsPage from './LabelsSettingsPage'
import ServerSettingsPage from './ServerSettingsPage'
import ShortcutsPage from './ShortcutsPage'
import PreferencesPage from './PreferencesPage'

/**
 * What a settings page may be handed by the panel that renders it.
 *
 * D1.254 — one optional field, and every page but `ai` ignores it. A component
 * declared `ComponentType<SettingsRouteProps>` accepts one that takes no props at
 * all, so the ten pages that do not read it are untouched by this type.
 *
 * UB15.10 — named `SettingsRouteProps` (it was `SettingsPageProps`) because v0.15.0's
 * layout component `components/settings/SettingsPage.tsx` exports that name for its
 * own props, and the AI page imports both.
 */
export interface SettingsRouteProps {
  /**
   * The connection this route names (`settings/ai/connection/<slug>`), so a
   * surface outside the page can open ONE connection's setup — the overlay is
   * local state inside `AiSettingsPage`, which is why no chat card could do it
   * before.
   */
  connectionSlug?: string
}

/**
 * Map of settings subpage IDs to their page components.
 * TypeScript will error if a page from SETTINGS_PAGES is missing here.
 */
export const SETTINGS_PAGE_COMPONENTS: Record<SettingsSubpage, ComponentType<SettingsRouteProps>> = {
  app: AppSettingsPage,
  ai: AiSettingsPage,
  appearance: AppearanceSettingsPage,
  input: InputSettingsPage,
  workspace: WorkspaceSettingsPage,
  import: ImportSettingsPage,
  permissions: PermissionsSettingsPage,
  labels: LabelsSettingsPage,
  server: ServerSettingsPage,
  shortcuts: ShortcutsPage,
  preferences: PreferencesPage,
}

/**
 * Get the component for a settings subpage
 */
export function getSettingsPageComponent(subpage: SettingsSubpage): ComponentType<SettingsRouteProps> {
  return SETTINGS_PAGE_COMPONENTS[subpage]
}
