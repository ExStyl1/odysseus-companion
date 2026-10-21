/**
 * AppearanceSettingsPage — theme mode, color theme, font, workspace theme overrides, CLI tool icon mappings, and the task board's column colours and status on move (UA2.3).
 *
 * UB15.9 — v0.15.1's page per hunk (the SettingsPage column, Mode, the ThemeGrid, Font / Motion / Language in Interface, the avatar ColorPicker).
 * Ours kept: the managed tool-icons edit config, the board's colours and status on move (UA2.3), the UA1.15 chip, rich tool descriptions, UA5.9.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { LANGUAGES, type LanguageCode } from '@nessy-agent/shared/i18n'
import type { ColumnDef } from '@tanstack/react-table'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { EditPopover, EditButton, getManagedEditConfig } from '@/components/ui/EditPopover'
import { useTheme } from '@/context/ThemeContext'
import { useAppShellContext } from '@/context/AppShellContext'
import { routes } from '@/lib/navigate'
import { Monitor, Sun, Moon } from 'lucide-react'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { ToolIconMapping } from '../../../shared/types'
import { useBackgroundFinishedChipPreference } from '@/atoms/background-finished'
import { SettingsPage, SettingsSection, SettingsCard, SettingsRow, SettingsSegmentedControl, SettingsMenuSelect, SettingsToggle } from '@/components/settings'
import { ThemeGrid } from '@/components/settings/ThemeGrid'
import * as storage from '@/lib/local-storage'
import { setProjectColorTreatment, useProjectColorTreatment } from '@/hooks/useProjectColorTreatment'
import type { ProjectColorTreatment } from '@/utils/project-colors'
import { useAtom } from 'jotai'
import { WorkspaceAvatar } from '@/components/ui/workspace-avatar'
import { ColorPicker } from '@/components/ui/color-picker'
import { workspaceAvatarColorOf, workspaceAvatarColorsAtom } from '@/atoms/workspace-avatar-colors'
import { kanbanColumnColorsAtom, kanbanColumnStatusAtom, kanbanLivePulseAtom, withColumnDropStatus } from '@/atoms/kanban'
import { KANBAN_COLUMNS } from '@/components/app-shell/kanban/status-column'
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon'
import { useKanbanColumnColors } from '@/hooks/useKanbanColumnColors'
import type { KanbanColumnId } from '@/components/app-shell/kanban/types'
import { PROJECT_COLOR_PALETTE } from '@/utils/project-colors'
import { Info_DataTable, SortableHeader, INFO_TABLE_HEADER_CLASS, INFO_TABLE_SORTABLE_HEADER_CLASS } from '@/components/info/Info_DataTable'
import { Info_Badge } from '@/components/info/Info_Badge'
import type { PresetTheme } from '@config/theme'
import { appThemeGridOptions, presetIdFromPath, presetTileCount } from './appearance-theme-grid'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'appearance',
}

// ============================================
// Tool Icons Table
// ============================================

/**
 * Column definitions for the tool icon mappings table.
 * Shows a preview icon, tool name, and the CLI commands that trigger it.
 */
const getToolIconColumns = (t: (key: string) => string): ColumnDef<ToolIconMapping>[] => [
  {
    accessorKey: 'iconDataUrl',
    header: () => <span className={cn("p-1.5 pl-2.5", INFO_TABLE_HEADER_CLASS)}>{t("settings.appearance.iconHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5">
        <img
          src={row.original.iconDataUrl}
          alt={row.original.displayName}
          className="w-5 h-5 object-contain"
        />
      </div>
    ),
    size: 60,
    enableSorting: false,
  },
  {
    accessorKey: 'displayName',
    header: ({ column }) => <SortableHeader column={column} title={t("settings.appearance.toolHeader")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 text-label font-medium text-foreground">
        {row.original.displayName}
      </div>
    ),
    size: 150,
  },
  {
    accessorKey: 'commands',
    header: () => <span className={cn("p-1.5 pl-2.5", INFO_TABLE_HEADER_CLASS)}>{t("settings.appearance.commandsHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 flex flex-wrap gap-1">
        {row.original.commands.map(cmd => (
          <Info_Badge key={cmd} color="muted" className="font-mono font-normal">
            {cmd}
          </Info_Badge>
        ))}
      </div>
    ),
    meta: { fillWidth: true },
    enableSorting: false,
  },
]

/**
 * Preset tiles the theme grid reserves while presets load: the bundled presets on the first visit,
 * then the last count seen — so the grid keeps its rows and nothing below it shifts.
 * Ours (UB15.9): the first visit counts OUR bundled set, `resources/themes` as Vite lists it at build
 * time (the same glob ThemeContext's BUNDLED_THEMES reads), never upstream's hard-coded 16.
 */
let lastPresetTileCount = bundledPresetTileCount()

/**
 * Vite replaces the glob below with the file list at build time. Bun (the tests and the playground's static
 * sweep, which import this module but never render it) has no `import.meta.glob`, so there the call throws
 * and the seed is 0 tiles; an app build never takes that branch.
 */
function bundledPresetTileCount(): number {
  try {
    return presetTileCount(Object.keys(import.meta.glob('../../../../resources/themes/*.json', { eager: true, import: 'default' })).map(presetIdFromPath))
  } catch {
    return 0
  }
}

// ============================================
// Main Component
// ============================================

export default function AppearanceSettingsPage() {
  const { t, i18n } = useTranslation()
  const toolIconColumns = useMemo(() => getToolIconColumns(t), [t])

  const {
    mode,
    setMode,
    resolvedMode,
    colorTheme,
    setColorTheme,
    font,
    setFont,
    motion,
    setMotion,
    activeWorkspaceId,
    setWorkspaceColorTheme,
    themeLoadError,
    themeResolvedFrom,
    appThemeOverrides,
  } = useTheme()
  const { workspaces, sessionStatuses } = useAppShellContext()

  // Fetch workspace icons as data URLs (file:// URLs don't work in renderer)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // Preset themes for the theme grid and the workspace dropdowns
  const [presetThemes, setPresetThemes] = useState<PresetTheme[]>([])
  const [presetsLoaded, setPresetsLoaded] = useState(false)

  // Per-workspace theme overrides (workspaceId -> themeId or undefined)
  const [workspaceThemes, setWorkspaceThemes] = useState<Record<string, string | undefined>>({})

  // Tool icon mappings loaded from main process
  const [toolIcons, setToolIcons] = useState<ToolIconMapping[]>([])

  // Connection icon visibility toggle
  const [showConnectionIcons, setShowConnectionIcons] = useState(() =>
    storage.get(storage.KEYS.showConnectionIcons, true)
  )
  const handleConnectionIconsChange = useCallback((checked: boolean) => {
    setShowConnectionIcons(checked)
    storage.set(storage.KEYS.showConnectionIcons, checked)
  }, [])

  // UA5.9 (v0.13.4) — Project color treatment in the SessionList
  const projectColorTreatment = useProjectColorTreatment()
  const handleProjectColorTreatmentChange = useCallback((value: string) => {
    setProjectColorTreatment(value as ProjectColorTreatment)
  }, [])

  // Per-workspace avatar color overrides (persisted in localStorage; read through `workspaceAvatarColorOf`)
  const [workspaceAvatarColors, setWorkspaceAvatarColors] = useAtom(workspaceAvatarColorsAtom)
  const setWorkspaceAvatarColor = useCallback((workspaceId: string, hex: string) => {
    setWorkspaceAvatarColors(prev => ({ ...prev, [workspaceId]: hex }))
  }, [setWorkspaceAvatarColors])
  const clearWorkspaceAvatarColor = useCallback((workspaceId: string) => {
    setWorkspaceAvatarColors(prev => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
  }, [setWorkspaceAvatarColors])

  // Kanban board appearance (persisted in localStorage via atomWithStorage).
  // UA2.3 (v0.13.4 hunk): the merged colour comes from the board's own hook, and
  // the stored maps are read through `readColumnMap`/`withColumnDropStatus`, so a
  // corrupt localStorage value shows the defaults instead of breaking the page.
  const [kanbanColumnColors, setKanbanColumnColors] = useAtom(kanbanColumnColorsAtom)
  const resolvedKanbanColumnColors = useKanbanColumnColors()
  const setKanbanColumnColor = useCallback((column: KanbanColumnId, hex: string) => {
    setKanbanColumnColors(prev => ({ ...prev, [column]: hex }))
  }, [setKanbanColumnColors])
  const resetKanbanColumnColor = useCallback((column: KanbanColumnId) => {
    setKanbanColumnColors(prev => {
      const next = { ...prev }
      delete next[column]
      return next
    })
  }, [setKanbanColumnColors])
  const [kanbanLivePulse, setKanbanLivePulse] = useAtom(kanbanLivePulseAtom)

  // Per-column status applied when a task is dragged into that column. Empty
  // selection ('') removes the mapping → status left unchanged on move.
  const [kanbanColumnStatus, setKanbanColumnStatus] = useAtom(kanbanColumnStatusAtom)
  const setColumnStatus = useCallback((column: KanbanColumnId, statusId: string) => {
    setKanbanColumnStatus(prev => withColumnDropStatus(prev, column, statusId))
  }, [setKanbanColumnStatus])
  const columnStatusOptions = useMemo(
    () => [
      { value: '', label: t("settings.appearance.kanbanColumnStatusNone") },
      ...(sessionStatuses ?? []).map(s => ({ value: s.id, label: s.label })),
    ],
    [sessionStatuses, t]
  )

  // Rich tool descriptions toggle (persisted in config.json, read by SDK subprocess)
  const [richToolDescriptions, setRichToolDescriptions] = useState(true)
  useEffect(() => {
    window.electronAPI?.getRichToolDescriptions?.().then(setRichToolDescriptions)
  }, [])
  const handleRichToolDescriptionsChange = useCallback(async (checked: boolean) => {
    setRichToolDescriptions(checked)
    await window.electronAPI?.setRichToolDescriptions?.(checked)
  }, [])

  // UA1.15 — the in-app "background session finished" chip: a per-user
  // preference in localStorage (`atomWithStorage`), default OFF; not a feature gate.
  const [showBackgroundFinishedChip, setShowBackgroundFinishedChip] = useBackgroundFinishedChipPreference()

  // Load preset themes on mount
  useEffect(() => {
    const loadThemes = async () => {
      if (!window.electronAPI) {
        setPresetThemes([])
        setPresetsLoaded(true)
        return
      }
      try {
        const themes = await window.electronAPI.loadPresetThemes()
        setPresetThemes(themes)
        lastPresetTileCount = presetTileCount(themes.map(p => p.id))
      } catch (error) {
        console.error('Failed to load preset themes:', error)
        setPresetThemes([])
      } finally {
        setPresetsLoaded(true)
      }
    }
    loadThemes()
  }, [])

  // Load workspace themes on mount
  useEffect(() => {
    const loadWorkspaceThemes = async () => {
      if (!window.electronAPI?.getAllWorkspaceThemes) return
      try {
        const themes = await window.electronAPI.getAllWorkspaceThemes()
        setWorkspaceThemes(themes)
      } catch (error) {
        console.error('Failed to load workspace themes:', error)
      }
    }
    loadWorkspaceThemes()
  }, [])

  // Load tool icon mappings on mount
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const mappings = await window.electronAPI.getToolIconMappings()
        setToolIcons(mappings)
      } catch (error) {
        console.error('Failed to load tool icon mappings:', error)
      }
    }
    load()
  }, [])

  // Handler for workspace theme change
  // Uses ThemeContext for the active workspace (immediate visual update) and IPC for other workspaces
  const handleWorkspaceThemeChange = useCallback(
    async (workspaceId: string, value: string) => {
      // 'default' means inherit from app default (null in storage)
      const themeId = value === 'default' ? null : value

      // If changing the current workspace, use context for immediate update
      if (workspaceId === activeWorkspaceId) {
        setWorkspaceColorTheme(themeId)
      } else {
        // For other workspaces, just persist via IPC
        await window.electronAPI?.setWorkspaceColorTheme?.(workspaceId, themeId)
      }

      // Update local state for UI
      setWorkspaceThemes(prev => ({
        ...prev,
        [workspaceId]: themeId ?? undefined
      }))
    },
    [activeWorkspaceId, setWorkspaceColorTheme]
  )

  // Theme grid tiles: the built-in default plus every preset (same values as the old dropdown)
  const themeGridOptions = useMemo(
    () => appThemeGridOptions(presetThemes, t("common.default")),
    [presetThemes, t]
  )

  // Get current app default theme label for display (null when using 'default' to avoid redundant "Use Default (Default)")
  const appDefaultLabel = useMemo(() => {
    if (colorTheme === 'default') return null
    const preset = presetThemes.find(t => t.id === colorTheme)
    return preset?.theme.name || colorTheme
  }, [colorTheme, presetThemes])

  return (
    <SettingsPage
      title={t("settings.appearance.title")}
      description={t("settings.appearance.description")}
      actions={<HeaderMenu route={routes.view.settings('appearance')} helpFeature="themes" />}
    >
      {/* Mode */}
      <SettingsSection title={t("settings.appearance.mode")}>
        <SettingsSegmentedControl
          value={mode}
          onValueChange={setMode}
          aria-label={t("settings.appearance.mode")}
          options={[
            { value: 'light', label: t("settings.appearance.light"), icon: <Sun /> },
            { value: 'dark', label: t("settings.appearance.dark"), icon: <Moon /> },
            { value: 'system', label: t("settings.appearance.system"), icon: <Monitor /> },
          ]}
        />
      </SettingsSection>

      {/* Color theme: tiles with live swatches in the active mode */}
      <SettingsSection title={t("settings.appearance.colorTheme")}>
        <ThemeGrid
          value={colorTheme}
          onValueChange={setColorTheme}
          options={themeGridOptions}
          mode={resolvedMode}
          overrides={appThemeOverrides}
          darkOnlyLabel={t("settings.appearance.dark")}
          aria-label={t("settings.appearance.colorTheme")}
          placeholderCount={presetsLoaded ? 0 : lastPresetTileCount}
        />
        {themeLoadError && (
          <p className="text-label-sm text-info">
            {t("settings.appearance.themeWarning")} {themeLoadError} ({themeResolvedFrom === 'fallback' ? t("settings.appearance.usingBundledFallback") : t("settings.appearance.usingDefaultTheme")})
          </p>
        )}
      </SettingsSection>

      {/* Workspace Themes */}
      {workspaces.length > 0 && (
        <SettingsSection
          title={t("settings.appearance.workspaceThemes")}
          description={t("settings.appearance.workspaceThemesDesc")}
        >
          <SettingsCard>
            {workspaces.map((workspace) => {
              const wsTheme = workspaceThemes[workspace.id]
              const hasCustomTheme = wsTheme !== undefined
              return (
                <SettingsRow
                  key={workspace.id}
                  label={
                    <div className="flex items-center gap-2">
                      <ColorPicker
                        value={workspaceAvatarColorOf(workspaceAvatarColors, workspace.id) || ''}
                        onChange={(hex) => setWorkspaceAvatarColor(workspace.id, hex)}
                        onClear={() => clearWorkspaceAvatarColor(workspace.id)}
                        clearLabel={t("settings.appearance.workspaceAvatarReset")}
                        presets={PROJECT_COLOR_PALETTE}
                        ariaLabel={t("settings.appearance.workspaceAvatarColor")}
                        trigger={
                          <button
                            type="button"
                            className="-m-1 inline-grid shrink-0 cursor-pointer place-items-center rounded-sm p-1 transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant"
                            aria-label={t("settings.appearance.workspaceAvatarColor")}
                          >
                            <WorkspaceAvatar
                              workspaceId={workspace.id}
                              workspaceName={workspace.name}
                              src={workspaceIconMap.get(workspace.id)}
                              className="size-4 rounded-xs"
                            />
                          </button>
                        }
                      />
                      <span>{workspace.name}</span>
                    </div>
                  }
                >
                  <SettingsMenuSelect
                    value={hasCustomTheme ? wsTheme : 'default'}
                    onValueChange={(value) => handleWorkspaceThemeChange(workspace.id, value)}
                    options={[
                      { value: 'default', label: appDefaultLabel ? t("settings.appearance.useDefaultWithTheme", { theme: appDefaultLabel }) : t("settings.appearance.useDefault") },
                      ...presetThemes
                        .filter(t => t.id !== 'default')
                        .map(t => ({
                          value: t.id,
                          label: t.theme.name || t.id,
                        })),
                    ]}
                  />
                </SettingsRow>
              )
            })}
          </SettingsCard>
        </SettingsSection>
      )}

      {/* Interface */}
      <SettingsSection title={t("settings.appearance.interface")}>
        <SettingsCard>
          <SettingsRow label={t("settings.appearance.font")}>
            <SettingsSegmentedControl
              value={font}
              onValueChange={setFont}
              aria-label={t("settings.appearance.font")}
              options={[
                { value: 'system', label: t("settings.appearance.fontSystem") },
                { value: 'inter', label: t("settings.appearance.fontInter") },
              ]}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.appearance.motion")} description={t("settings.appearance.motionDesc")}>
            <SettingsSegmentedControl
              value={motion}
              onValueChange={setMotion}
              aria-label={t("settings.appearance.motion")}
              options={[
                { value: 'system', label: t("settings.appearance.system") },
                { value: 'reduced', label: t("settings.appearance.motionReduced") },
                { value: 'full', label: t("settings.appearance.motionFull") },
              ]}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.appearance.language")}>
            <SettingsMenuSelect
              value={(i18n.resolvedLanguage ?? i18n.language) as LanguageCode}
              onValueChange={(value) => {
                console.info('[i18n] Appearance dropdown change', {
                  from: i18n.resolvedLanguage ?? null,
                  to: value,
                })
                i18n.changeLanguage(value)
                window.electronAPI?.changeLanguage?.(value)
              }}
              options={Object.entries(LANGUAGES).map(([code, config]) => ({
                value: code,
                label: config.nativeName,
              }))}
            />
          </SettingsRow>
          <SettingsToggle
            label={t("settings.appearance.connectionIcons")}
            description={t("settings.appearance.connectionIconsDesc")}
            checked={showConnectionIcons}
            onCheckedChange={handleConnectionIconsChange}
          />
          <SettingsToggle
            label={t("settings.appearance.richToolDescriptions")}
            description={t("settings.appearance.richToolDescriptionsDesc")}
            checked={richToolDescriptions}
            onCheckedChange={handleRichToolDescriptionsChange}
          />
          <SettingsToggle
            label={t("settings.appearance.backgroundFinishedChip")}
            description={t("settings.appearance.backgroundFinishedChipDesc")}
            checked={showBackgroundFinishedChip}
            onCheckedChange={setShowBackgroundFinishedChip}
          />
          {/* UA5.9 (v0.13.4) — how sessions bound to a project are highlighted in the session list */}
          <SettingsRow
            label={t("settings.appearance.projectColorTreatment")}
            description={t("settings.appearance.projectColorTreatmentDesc")}
          >
            <SettingsMenuSelect
              value={projectColorTreatment}
              onValueChange={handleProjectColorTreatmentChange}
              options={[
                { value: 'stripe', label: t("settings.appearance.projectColorStripe") },
                { value: 'stripe-tint', label: t("settings.appearance.projectColorStripeTint") },
              ]}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {/* Kanban board — column colors + live-pulse toggle */}
      <SettingsSection
        title={t("settings.appearance.kanbanBoard")}
        description={t("settings.appearance.kanbanBoardDesc")}
      >
        <SettingsCard>
          {KANBAN_COLUMNS.map(column => {
            const merged = resolvedKanbanColumnColors.get(column.id)?.solid ?? ''
            return (
              <SettingsRow key={column.id} label={t(column.labelKey)}>
                <ColorPicker
                  value={merged}
                  onChange={(hex) => setKanbanColumnColor(column.id, hex)}
                  onClear={kanbanColumnColors?.[column.id] ? () => resetKanbanColumnColor(column.id) : undefined}
                  clearLabel={t("settings.appearance.kanbanColumnColorReset")}
                  presets={PROJECT_COLOR_PALETTE}
                  ariaLabel={t("settings.appearance.kanbanColumnColor", { column: t(column.labelKey) })}
                  align="end"
                />
              </SettingsRow>
            )
          })}
          <SettingsToggle
            label={t("settings.appearance.kanbanLivePulse")}
            description={t("settings.appearance.kanbanLivePulseDesc")}
            checked={kanbanLivePulse}
            onCheckedChange={setKanbanLivePulse}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Kanban status automation — status applied on drag into a column */}
      <SettingsSection
        title={t("settings.appearance.kanbanColumnStatus")}
        description={t("settings.appearance.kanbanColumnStatusDesc")}
      >
        <SettingsCard>
          {KANBAN_COLUMNS.map(column => (
            <SettingsRow key={column.id} label={t(column.labelKey)}>
              <SettingsMenuSelect
                value={kanbanColumnStatus?.[column.id] ?? ''}
                onValueChange={(value) => setColumnStatus(column.id, value)}
                options={columnStatusOptions}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>

      {/* Tool Icons — shows the command → icon mapping used in turn cards */}
      <SettingsSection
        title={t("settings.appearance.toolIcons")}
        description={t("settings.appearance.toolIconsDesc")}
        action={
          <EditPopover
            trigger={<EditButton />}
            {...getManagedEditConfig('edit-tool-icons', { scope: 'global', kind: 'tool-icons' })}
          />
        }
      >
        <SettingsCard>
          <Info_DataTable
            columns={toolIconColumns}
            data={toolIcons}
            searchable={{ placeholder: t("settings.appearance.searchTools") }}
            maxHeight={480}
            emptyContent={t("settings.appearance.noToolIcons")}
          />
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  )
}
