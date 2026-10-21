/**
 * Source: v0.15.1:apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage.tsx (UB15.6; per-hunk merge —
 * upstream's `SettingsPage` column and `SettingsPageState` with one shared `headerActions`, `Button`/`buttonVariants`
 * secondary/ghost md, the upload label's focus outline, the mode-cycling error in place via
 * `AnimatedCollapsibleContent` with `role="status"`; ours re-applied: the six-mode default selector and its managed
 * tier (F1.1052, P4.8, P2.489), the default-sources picker over the composer catalog (R3-C), the default project
 * folder by handle with its trust dialog, local MCP servers, the budget-ceilings disclosure (P6.821), the saved-setting
 * reload (F1.1191) and Published pages (UA1.19)).
 */
/**
 * WorkspaceSettingsPage
 *
 * Workspace-level settings for the active workspace.
 *
 * Settings:
 * - Identity (Name, Icon)
 * - Permissions (Default mode, Mode cycling)
 * - Advanced (Working directory, Local MCP servers)
 *
 * Note: AI settings (model, thinking, connection) have been moved to AiSettingsPage.
 */

import * as React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatedCollapsibleContent } from '@nessy-agent/ui'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button, buttonVariants } from '@/components/ui/button'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import { routes } from '@/lib/navigate'
import { PERMISSION_MODE_PICKER_ORDER, describePermissionModeLine, resolveWorkspaceDefaultModeDisplay } from '@/lib/composer-permission-modes'
import { Spinner } from '@nessy-agent/ui'
import { RenameDialog } from '@/components/ui/rename-dialog'
import type { PermissionMode, WorkspaceSettings } from '../../../shared/types'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { DEFAULT_CYCLABLE_PERMISSION_MODES } from '@nessy-agent/shared/agent/mode-types'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { toast } from 'sonner'
import { isComposerSelectableSourceRow } from '@/lib/capability-catalog'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import { ProjectTrustDialog } from '@/components/workspace/ProjectTrustDialog'
import { PublishedPagesSection } from '@/components/artifacts/PublishedPagesSection'

import {
  SettingsPage,
  SettingsPageState,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsMenuSelectRow,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'workspace',
}

// ============================================
// Main Component
// ============================================

export default function WorkspaceSettingsPage() {
  const { t } = useTranslation()

  // Get active workspace from context
  const appShellContext = useAppShellContext()
  const activeWorkspaceId = appShellContext.activeWorkspaceId
  const { onRefreshWorkspaces, onWorkspaceSettingsChanged } = appShellContext // F1.1191: the second re-reads AppShell's copy

  // Workspace settings state
  const [wsName, setWsName] = useState('')
  const [wsNameEditing, setWsNameEditing] = useState('')
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [wsIconUrl, setWsIconUrl] = useState<string | null>(null)
  const [isUploadingIcon, setIsUploadingIcon] = useState(false)
  /**
   * The workspace's OWN mode, `undefined` until the load says otherwise — and
   * `undefined` is the honest value for a workspace that has never set one.
   * P4.8: this used to seed `'default'`, so an unconfigured workspace DISPLAYED
   * Manual while its sessions started in Auto. Since P0.2 flipped the shipped
   * default that understated the autonomy the user was granting; before the
   * flip it overstated it, which was the safe side of the same bug.
   */
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(undefined)
  /** What a new session here gets when the above is absent — see `WorkspaceSettings`. */
  const [effectiveDefaultMode, setEffectiveDefaultMode] = useState<PermissionMode | undefined>(undefined)
  // P2.489 — the administrator's `defaultMode`, absent on every unmanaged
  // install. Absent means unmanaged, never unknown; see the DTO field.
  const [managedDefaultMode, setManagedDefaultMode] = useState<PermissionMode | undefined>(undefined)
  /**
   * P6.821 — the two budget ceilings a session is actually stopped at, and the
   * only pair on this page no tier of this product can set. `undefined` is NOT
   * "no ceiling": it is a host too old to say, and the row renders nothing then
   * rather than claiming the limits are off.
   */
  const [budgetCeilings, setBudgetCeilings] = useState<WorkspaceSettings['budgetCeilings']>(undefined)
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [pendingProjectTrust, setPendingProjectTrust] = useState<IssuedProjectHandle | null>(null)
  const [localMcpEnabled, setLocalMcpEnabled] = useState(true)
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(true)

  // Workspace default composer source selection: folder/API sources only
  // (R3-C). MCP is activation-governed and never a per-session composer toggle,
  // so it is excluded from this selection picker.
  const availableSources = React.useMemo(
    () => appShellContext.composerCatalog?.items.filter(isComposerSelectableSourceRow) ?? [],
    [appShellContext.composerCatalog],
  )
  const [enabledSourceSlugs, setEnabledSourceSlugs] = useState<string[]>([])

  // Mode cycling state
  const [enabledModes, setEnabledModes] = useState<PermissionMode[]>(DEFAULT_CYCLABLE_PERMISSION_MODES) // F1.1052: never the hidden dontAsk
  const [modeCyclingError, setModeCyclingError] = useState<string | null>(null)

  // Load workspace settings when active workspace changes
  useEffect(() => {
    const loadWorkspaceSettings = async () => {
      if (!window.electronAPI || !activeWorkspaceId) {
        setIsLoadingWorkspace(false)
        return
      }

      setIsLoadingWorkspace(true)
      try {
        const settings = await window.electronAPI.getWorkspaceSettings(activeWorkspaceId)
        if (settings) {
          setWsName(settings.name || '')
          setWsNameEditing(settings.name || '')
          setPermissionMode(settings.permissionMode)
          setEffectiveDefaultMode(settings.effectiveDefaultPermissionMode)
          setManagedDefaultMode(settings.managedDefaultPermissionMode)
          setBudgetCeilings(settings.budgetCeilings)
          setWorkingDirectory(settings.workingDirectory || '')
          setLocalMcpEnabled(settings.localMcpEnabled ?? true)
          // Load cyclable permission modes from workspace settings
          if (settings.cyclablePermissionModes && settings.cyclablePermissionModes.length >= 2) {
            setEnabledModes(settings.cyclablePermissionModes)
          }

          setEnabledSourceSlugs(settings.enabledSourceSlugs ?? [])
        }

        // Try to load workspace icon (check common extensions)
        const ICON_EXTENSIONS = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif']
        let iconFound = false
        for (const ext of ICON_EXTENSIONS) {
          try {
            const iconData = await window.electronAPI.readWorkspaceImage(activeWorkspaceId, `./icon.${ext}`)
            // IPC returns null for missing files - continue to next extension
            if (!iconData) {
              continue
            }
            // For SVG, wrap in data URL
            if (ext === 'svg' && !iconData.startsWith('data:')) {
              setWsIconUrl(`data:image/svg+xml;base64,${btoa(iconData)}`)
            } else {
              setWsIconUrl(iconData)
            }
            iconFound = true
            break
          } catch {
            // Icon not found with this extension, try next
          }
        }
        if (!iconFound) {
          setWsIconUrl(null)
        }
      } catch (error) {
        console.error('Failed to load workspace settings:', error)
      } finally {
        setIsLoadingWorkspace(false)
      }
    }

    loadWorkspaceSettings()
  }, [activeWorkspaceId])

  useEffect(() => {
    if (!activeWorkspaceId || availableSources.length === 0) return
    const validIds = new Set(availableSources.map(source => source.mention?.id ?? source.logicalName))
    setEnabledSourceSlugs(previous => {
      const healed = previous.filter(id => validIds.has(id))
      if (healed.length !== previous.length) {
        void window.electronAPI.updateWorkspaceSetting(activeWorkspaceId, 'enabledSourceSlugs', healed)
      }
      return healed
    })
  }, [activeWorkspaceId, availableSources])

  // Save workspace setting
  const updateWorkspaceSetting = useCallback(
    async <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
      if (!window.electronAPI || !activeWorkspaceId) return false

      try {
        await window.electronAPI.updateWorkspaceSetting(activeWorkspaceId, key, value)
        onWorkspaceSettingsChanged?.(); return true // F1.1191 — saved: AppShell re-reads what it holds (the picker's "Default" badge)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error(`Failed to save ${String(key)}:`, error)
        toast.error(t("settings.workspace.failedToSave", { setting: String(key) }), {
          description: message,
        })
        return false
      }
    },
    [activeWorkspaceId, t, onWorkspaceSettingsChanged]
  )

  // Workspace icon upload handler
  const handleIconUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !activeWorkspaceId || !window.electronAPI) return

    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/gif']
    if (!validTypes.includes(file.type)) {
      console.error('Invalid file type:', file.type)
      return
    }

    setIsUploadingIcon(true)
    try {
      // Read file as base64
      const buffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )

      // Determine extension from mime type
      const extMap: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/svg+xml': 'svg',
        'image/webp': 'webp',
        'image/gif': 'gif',
      }
      const ext = extMap[file.type] || 'png'

      // Upload to workspace
      await window.electronAPI.writeWorkspaceImage(activeWorkspaceId, `./icon.${ext}`, base64, file.type)

      // Reload the icon locally for settings display
      const iconData = await window.electronAPI.readWorkspaceImage(activeWorkspaceId, `./icon.${ext}`)
      if (iconData) {
        if (ext === 'svg' && !iconData.startsWith('data:')) {
          setWsIconUrl(`data:image/svg+xml;base64,${btoa(iconData)}`)
        } else {
          setWsIconUrl(iconData)
        }
      }

      // Refresh workspaces to update sidebar icon
      onRefreshWorkspaces?.()
    } catch (error) {
      console.error('Failed to upload icon:', error)
    } finally {
      setIsUploadingIcon(false)
      // Reset the input so the same file can be selected again
      e.target.value = ''
    }
  }, [activeWorkspaceId, onRefreshWorkspaces])

  // Workspace settings handlers
  /**
   * What the control SHOWS, and whether it still decides anything.
   *
   * A managed policy's `defaultMode` outranks every other tier, so when one is
   * deployed the control is INERT — P2.489. The workspace's own value wins next;
   * the host-supplied effective default answers for a workspace that has never
   * set one; and `'default'` survives only as the terminal fallback for the case
   * where the settings load itself failed or returned null, where the page knows
   * nothing at all. The WRITE path below is untouched — it still sends exactly
   * what the user picked, and is simply unreachable while the row is disabled.
   */
  const defaultModeDisplay = resolveWorkspaceDefaultModeDisplay(
    permissionMode,
    effectiveDefaultMode,
    managedDefaultMode,
  )
  const displayedPermissionMode = defaultModeDisplay.mode

  const handlePermissionModeChange = useCallback(
    async (newMode: PermissionMode) => {
      setPermissionMode(newMode)
      await updateWorkspaceSetting('permissionMode', newMode)
    },
    [updateWorkspaceSetting]
  )

  const handleWorkingDirectorySelected = useCallback(async (project: IssuedProjectHandle) => {
    if (!activeWorkspaceId) return
    try {
      await window.electronAPI.setWorkspaceDefaultProject({
        workspaceId: activeWorkspaceId,
        projectHandleId: project.id,
      })
      setWorkingDirectory(project.displayPath)
      setPendingProjectTrust(project.trustState === 'unknown' ? project : null)
      onRefreshWorkspaces?.()
    } catch {
      toast.error(t('settings.workspace.failedToSave', { setting: 'projectFolder' }))
    }
  }, [activeWorkspaceId, onRefreshWorkspaces, t])

  const {
    pickDirectory: handleChangeWorkingDirectory,
    showServerBrowser: showWdBrowser,
    serverBrowserMode: wdBrowserMode,
    cancelServerBrowser: cancelWdBrowser,
    confirmServerBrowser: confirmWdBrowser,
  } = useDirectoryPicker(activeWorkspaceId, handleWorkingDirectorySelected)

  const handleClearWorkingDirectory = useCallback(async () => {
    if (!window.electronAPI || !activeWorkspaceId) return

    try {
      await window.electronAPI.setWorkspaceDefaultProject({
        workspaceId: activeWorkspaceId,
        projectHandleId: null,
      })
      setWorkingDirectory('')
      setPendingProjectTrust(null)
      onRefreshWorkspaces?.()
    } catch {
      toast.error(t('settings.workspace.failedToSave', { setting: 'projectFolder' }))
    }
  }, [activeWorkspaceId, onRefreshWorkspaces, t])

  const handleLocalMcpEnabledChange = useCallback(
    async (enabled: boolean) => {
      setLocalMcpEnabled(enabled)
      await updateWorkspaceSetting('localMcpEnabled', enabled)
    },
    [updateWorkspaceSetting]
  )

  const handleSourceToggle = useCallback(
    async (slug: string, checked: boolean) => {
      const newSlugs = checked
        ? [...enabledSourceSlugs, slug]
        : enabledSourceSlugs.filter(s => s !== slug)
      setEnabledSourceSlugs(newSlugs)
      await updateWorkspaceSetting('enabledSourceSlugs', newSlugs)
    },
    [enabledSourceSlugs, updateWorkspaceSetting]
  )

  const handleModeToggle = useCallback(
    async (mode: PermissionMode, checked: boolean) => {
      if (!window.electronAPI) return

      // Calculate what the new modes would be
      const newModes = checked
        ? [...enabledModes, mode]
        : enabledModes.filter((m) => m !== mode)

      // Validate: at least 2 modes required
      if (newModes.length < 2) {
        setModeCyclingError(t('settings.workspace.atLeast2Modes'))
        // Auto-dismiss after 2 seconds
        setTimeout(() => {
          setModeCyclingError(null)
        }, 2000)
        return
      }

      // Update state and persist
      setEnabledModes(newModes)
      setModeCyclingError(null)
      try {
        await updateWorkspaceSetting('cyclablePermissionModes', newModes)
      } catch (error) {
        console.error('Failed to save mode cycling settings:', error)
      }
    },
    [enabledModes, updateWorkspaceSetting, t]
  )

  const headerActions = <HeaderMenu route={routes.view.settings('workspace')} helpFeature="workspaces" />

  // Show empty state if no workspace is active
  if (!activeWorkspaceId) {
    return (
      <SettingsPageState actions={headerActions}>
        <p>{t("settings.workspace.noWorkspaceSelected")}</p>
      </SettingsPageState>
    )
  }

  // Show loading state
  if (isLoadingWorkspace) {
    return (
      <SettingsPageState actions={headerActions}>
        <Spinner className="text-tertiary" />
      </SettingsPageState>
    )
  }

  return (
    <SettingsPage
      title={t("settings.workspace.workspaceSettings")}
      description={t("settings.workspace.description")}
      actions={headerActions}
    >
      {/* Workspace Info */}
      <SettingsSection title={t("settings.workspace.workspaceInfo")}>
        <SettingsCard>
          <SettingsRow
            label={t("common.name")}
            description={wsName || t("settings.workspace.untitled")}
            action={
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setWsNameEditing(wsName)
                  setRenameDialogOpen(true)
                }}
              >
                {t("common.edit")}
              </Button>
            }
          />
          <SettingsRow
            label={t("settings.workspace.icon")}
            action={
              <label className="cursor-pointer rounded-md has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                  onChange={handleIconUpload}
                  className="sr-only"
                  disabled={isUploadingIcon}
                />
                <span className={buttonVariants({ variant: 'secondary', size: 'md' })}>
                  {isUploadingIcon ? t("common.uploading") : t("common.change")}
                </span>
              </label>
            }
          >
            <div
              className={cn(
                'size-6 rounded-full overflow-hidden bg-fill-hover flex items-center justify-center',
                'ring-1 ring-border'
              )}
            >
              {isUploadingIcon ? (
                <Spinner className="text-caption text-tertiary" />
              ) : wsIconUrl ? (
                <img src={wsIconUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-caption text-secondary">
                  {wsName?.charAt(0)?.toUpperCase() || 'W'}
                </span>
              )}
            </div>
          </SettingsRow>
        </SettingsCard>

        <RenameDialog
          open={renameDialogOpen}
          onOpenChange={setRenameDialogOpen}
          title={t("settings.workspace.renameWorkspace")}
          value={wsNameEditing}
          onValueChange={setWsNameEditing}
          onSubmit={() => {
            const newName = wsNameEditing.trim()
            if (newName && newName !== wsName) {
              setWsName(newName)
              updateWorkspaceSetting('name', newName)
              onRefreshWorkspaces?.()
            }
            setRenameDialogOpen(false)
          }}
          placeholder={t("settings.workspace.enterWorkspaceName")}
        />
      </SettingsSection>

      {/* Permissions */}
      {/*
        R15 — the RUNTIME-LESS surface, and the reason the general mode
        strings state intent rather than enforcement.

        This section configures a WORKSPACE: a default mode for sessions
        that have not started, and which modes SHIFT+TAB may cycle. A
        workspace has no runtime — its sessions run on whichever
        integration they pick and can switch mid-session — so
        `describePermissionModeLine` is deliberately called with no
        runtime here. It returns the general string, which the composer
        then EXTENDS with the active runtime's short clause; that keeps
        this page and the picker from disagreeing about the same mode,
        since one is always a prefix of the other. The composer's shared
        runtime caveat is a footer of its own menu and has no counterpart
        here — there is no runtime to caveat.
      */}
      <SettingsSection title={t("settings.workspace.permissionsSection")}>
        <SettingsCard>
          {/*
            P2.489 — a managed `defaultMode` outranks the workspace value
            entirely, so on a managed install this row is disabled and says
            so, the way retention's window already does. It reports the
            precedence rather than changing it: the value shown is the mode
            sessions will actually start in.
          */}
          <SettingsMenuSelectRow
            label={t("settings.workspace.defaultMode")}
            description={defaultModeDisplay.managed
              ? `${t("settings.workspace.defaultModeDesc")} ${t("settings.workspace.defaultModeManaged")}`
              : t("settings.workspace.defaultModeDesc")}
            disabled={defaultModeDisplay.managed}
            value={displayedPermissionMode}
            onValueChange={(v) => handlePermissionModeChange(v as PermissionMode)}
            options={[...PERMISSION_MODE_PICKER_ORDER, ...(PERMISSION_MODE_PICKER_ORDER.includes(displayedPermissionMode) ? [] : [displayedPermissionMode])].map((mode) => ({
              value: mode,
              label: t(`mode.${mode}`),
              description: describePermissionModeLine(mode, t),
            }))}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Mode Cycling */}
      <SettingsSection
        title={t("settings.workspace.modeCycling")}
        description={t("settings.workspace.modeCyclingDesc")}
      >
        <SettingsCard>
          {PERMISSION_MODE_PICKER_ORDER.map((m) => {
            const isEnabled = enabledModes.includes(m)
            return (
              <SettingsToggle
                key={m}
                label={t(`mode.${m}`)}
                description={describePermissionModeLine(m, t)}
                checked={isEnabled}
                onCheckedChange={(checked) => handleModeToggle(m, checked)}
              />
            )
          })}
        </SettingsCard>
        {/* Appears in place (fade + 4px drop, no height animation) */}
        <AnimatedCollapsibleContent isOpen={!!modeCyclingError}>
          <p role="status" className="mt-1 text-label-sm text-destructive">
            {modeCyclingError}
          </p>
        </AnimatedCollapsibleContent>
      </SettingsSection>

      {/* Default Sources */}
      <SettingsSection
        title={t("settings.workspace.defaultSources")}
        description={t("settings.workspace.defaultSourcesDesc")}
      >
        {availableSources.length > 0 ? (
          <SettingsCard>
            {availableSources.map((source) => (
              <SettingsToggle
                key={source.key}
                label={
                  <span className="inline-flex items-center gap-2">
                    <SourceAvatar source={source} size="xs" />
                    {source.logicalName}
                  </span>
                }
                description={source.description}
                checked={enabledSourceSlugs.includes(source.mention?.id ?? source.logicalName)}
                onCheckedChange={(checked) => handleSourceToggle(source.mention?.id ?? source.logicalName, checked)}
              />
            ))}
          </SettingsCard>
        ) : (
          <p className="text-label text-tertiary">{t("settings.workspace.noSourcesConfigured")}</p>
        )}
      </SettingsSection>

      {/* Advanced */}
      <SettingsSection title={t("settings.workspace.advanced")}>
        <SettingsCard>
          <SettingsRow
            label={t('settings.workspace.defaultProjectFolder', { defaultValue: 'Default working folder' })}
            description={workingDirectory || t('settings.workspace.defaultProjectFolderDesc', {
              defaultValue: 'Used for new sessions in this workspace.',
            })}
            action={
              <div className="flex items-center gap-2">
                {workingDirectory && (
                  <Button variant="ghost" size="md" onClick={handleClearWorkingDirectory}>
                    {t("common.clear")}
                  </Button>
                )}
                <Button variant="secondary" size="md" onClick={handleChangeWorkingDirectory}>
                  {t("common.change")}
                </Button>
              </div>
            }
          />
          <SettingsToggle
            label={t("settings.workspace.localMcpServers")}
            description={t("settings.workspace.localMcpServersDesc")}
            checked={localMcpEnabled}
            onCheckedChange={handleLocalMcpEnabledChange}
          />
          {/*
            P6.821 — THE DISCLOSURE, and it is deliberately a row with no
            control on it.

            Both ceilings live in `workspaceDefaults` of
            `config-defaults.json`, which `syncConfigDefaults` rewrites
            from the bundle on every launch, so neither can be set from
            this app — and until this row existed nothing said so, while
            two chat notices told the user to "set a token limit
            (`maxBudgetTokens`)" and the USD cap's exhausted-notice rested
            on "ask the user to raise the limit" being followable. The
            owner's answer (2026-09-10) was to DISCLOSE the ceilings and
            name their tier, not to invent a control for them.

            `0` is the documented "no ceiling" on both (see
            `config-defaults-schema.ts`), so it is shown as words rather
            than as a zero a reader would take for a real limit — while an
            ABSENT `budgetCeilings` hides the row entirely, because a host
            that cannot answer must not be rendered as one answering "off".
            The description is the whole row and wraps in full (SettingsRow
            wraps every description since UB15.1), so 2,000,000 and 2,000
            never read the same.
          */}
          {budgetCeilings && (
            <SettingsRow
              label={t("settings.workspace.budgetCeilings")}
              description={t("settings.workspace.budgetCeilingsDesc", {
                tokens: budgetCeilings.maxBudgetTokens > 0
                  ? budgetCeilings.maxBudgetTokens.toLocaleString()
                  : t("settings.workspace.budgetCeilingsNone"),
                usd: budgetCeilings.maxBudgetUsd > 0
                  ? `$${budgetCeilings.maxBudgetUsd}`
                  : t("settings.workspace.budgetCeilingsNone"),
              })}
            />
          )}
        </SettingsCard>
      </SettingsSection>

      {/* UA1.19 — the pages published to t-artifacts with this dp identity, joined to this workspace's registry. */}
      {activeWorkspaceId && <PublishedPagesSection workspaceId={activeWorkspaceId} />}

      <ServerDirectoryBrowser
        open={showWdBrowser}
        mode={wdBrowserMode}
        workspaceId={activeWorkspaceId}
        onSelect={confirmWdBrowser}
        onCancel={cancelWdBrowser}
        initialPath={workingDirectory || undefined}
      />
      <ProjectTrustDialog
        open={!!pendingProjectTrust}
        project={pendingProjectTrust}
        onClose={() => setPendingProjectTrust(null)}
        onDecision={setPendingProjectTrust}
      />
    </SettingsPage>
  )
}
