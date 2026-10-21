/**
 * Source: v0.15.1:apps/electron/src/renderer/pages/settings/PermissionsSettingsPage.tsx (UB15.7; per-hunk merge —
 * upstream's `SettingsPage` column with the settings.permissions.description lede, the `Spinner` while loading, the
 * About card on `settingsUI.prose` / `settingsUI.link`, and the tables' empty states on the label roles; ours
 * re-applied: the localized doc link, the managed edit configs (no raw default.json / permissions.json path), the
 * primary folder (C3.178), MCP channel push (P6.510), built-in browser sites (P6.536), process isolation with its two
 * switches and the network posture (P6.327, P2.365), no "Write to:" rows (F1.1052), the blocked-tools annotation
 * (P3.351), the cross-scope "already granted" annotation (P6.209), and the auto-mode judge rules and denials (P6.209)).
 */
/**
 * PermissionsSettingsPage
 *
 * Displays permissions configuration, led by the read-only allowlist Plan and Don't ask use.
 * Shows both default patterns (from ~/.nessy-agent/permissions/default.json)
 * and custom workspace additions (from workspace permissions.json).
 *
 * Default patterns can be edited by the user in ~/.nessy-agent/permissions/default.json.
 * Custom patterns can be edited via workspace permissions.json file.
 */

import * as React from 'react'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Spinner } from '@nessy-agent/ui'
import { useAppShellContext } from '@/context/AppShellContext'
import { type PermissionsConfigFile } from '@nessy-agent/shared/agent/modes'
import { ALWAYS_ALLOWED_TOOL_NAMES } from '@nessy-agent/shared/agent/always-allowed-tools'
import {
  classifyBlockedToolDeclaration,
  type BlockedToolPreemption,
} from '@nessy-agent/shared/agent/blocked-tools-enforcement'
import type { IsolationCapabilityReportV1 } from '@nessy-agent/core/types'
import {
  PermissionsDataTable,
  type PermissionRow,
} from '@/components/info'
import { annotateRowsAlreadyGrantedByDefaults } from './permissions-cross-scope'
import AutoModeJudgeRulesSection from './AutoModeJudgeRulesSection'
import AutoModeDenialsSection from './AutoModeDenialsSection'
import { BrowserOriginTrustSection } from './BrowserOriginTrustSection'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsToggle,
  SettingsSelect,
  IsolationNetworkPosture,
} from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { EditPopover, EditButton, getManagedEditConfig } from '@/components/ui/EditPopover'
import { getDocUrl } from '@nessy-agent/shared/docs/doc-links'
import { routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'permissions',
}

/**
 * Build default permissions data from ~/.nessy-agent/permissions/default.json.
 * These are the read-only allowlist's patterns (Plan, Don't ask) that the user can customize.
 * Patterns can include comments which are displayed in the table.
 *
 * Note: We only show allowed patterns here. Anything not on this list is implicitly denied.
 */
function buildDefaultPermissionsData(config: PermissionsConfigFile | null): PermissionRow[] {
  if (!config) return []

  const rows: PermissionRow[] = []

  // Helper to extract pattern and comment from string or object format
  const extractPatternInfo = (item: string | { pattern: string; comment?: string }): { pattern: string; comment: string | null } => {
    if (typeof item === 'string') {
      return { pattern: item, comment: null }
    }
    return { pattern: item.pattern, comment: item.comment || null }
  }

  // Note: We don't show blockedTools here - anything not on the allowed list is implicitly denied

  // Allowed bash patterns
  config.allowedBashPatterns?.forEach((item) => {
    const { pattern, comment } = extractPatternInfo(item)
    rows.push({ access: 'allowed', type: 'bash', pattern, comment })
  })

  // Allowed MCP patterns
  config.allowedMcpPatterns?.forEach((item) => {
    const { pattern, comment } = extractPatternInfo(item)
    rows.push({ access: 'allowed', type: 'mcp', pattern, comment })
  })

  // API endpoints
  config.allowedApiEndpoints?.forEach((item) => {
    const pattern = `${item.method} ${item.path}`
    rows.push({ access: 'allowed', type: 'api', pattern, comment: item.comment || null })
  })

  // F1.1052 — no "Write to:" rows for `allowedWritePaths`. Since F1.1050 retired Explore no permission
  // mode reads the field (Plan writes only its plan file and the session data folder), so a row here
  // would advertise a write the gate refuses. The schema still PARSES it, so a stored permissions.json
  // keeps loading; Claude Code's permission settings have no such field. The same holds for the custom
  // rows below.

  return rows
}

/**
 * One sentence per branch of `shouldAllowToolInMode` that pre-empts the
 * `blockedTools` list. Same four keys the playground draft reads, so the shipped
 * page and the draft cannot say different things about the same branch.
 */
const BLOCKED_TOOL_PREEMPTION_KEYS: Record<BlockedToolPreemption['kind'], string> = {
  'always-allowed': 'settings.permissions.blockedToolsUnenforcedAlwaysAllowed',
  'always-allowed-suffix': 'settings.permissions.blockedToolsUnenforcedSuffix',
  'browser-tool': 'settings.permissions.blockedToolsUnenforcedBrowser',
  'bash-classifier': 'settings.permissions.blockedToolsUnenforcedBash',
}

/**
 * Build custom permissions data from workspace permissions.json.
 * These are user-added patterns that extend the defaults.
 */
function buildCustomPermissionsData(config: PermissionsConfigFile, fallbackLabels: { blockedTool: string; bashPattern: string; mcpPattern: string; apiEndpoint: string }, t: TFunction): PermissionRow[] {
  const rows: PermissionRow[] = []

  // Additional blocked tools.
  //
  // P3.351 — EVERY declared name is pushed as `access: 'blocked'`, and for most
  // of them that is a safety claim the runtime does not honour. `blockedTools`
  // is the LAST branch of `shouldAllowToolInMode`, and four earlier returns
  // pre-empt it: the always-allowed read-only tools, any name ending
  // `__<one of them>`, every browser-tool spelling, and `Bash`. Driven through
  // the real gate with two workspaces — one declaring the name, one not — in
  // explore AND plan, ten of eleven sample entries produced an identical
  // verdict either way and the call RAN. `blockedTools: ["Bash"]` leaves a
  // read-only shell command running while this table says BLOCKED.
  //
  // WIRED 2026-09-04 as `annotate` (P3.351, close-out C-2, under the delegated
  // transparent-and-simple rule). Of the four candidates drawn in the playground
  // draft — warn, grey, annotate, filter — `annotate` is the one that changes no
  // access claim and hides nothing: the name the user wrote stays where they
  // wrote it, keeps its badge, and gains the sentence saying which branch
  // decides instead. `grey` and `filter` withdraw or remove a row the user
  // authored, which is a stronger product statement than a defect report
  // warrants; `warn` puts the count in a banner and leaves each row unexplained.
  // The other three stay live as knobs on the draft
  // (`playground/registry/settings-blocked-tools.tsx`, plan row P4.10) so the
  // owner can still pick one — this is a default, not a closed question.
  //
  // The classification is the shared predicate over the REAL always-allowed set,
  // never a copy: `ALWAYS_ALLOWED_TOOL_NAMES` is the same array
  // `mode-manager.ts` builds `ALWAYS_ALLOWED_TOOLS` from, lifted into a leaf so
  // the renderer can reach it without `mode-manager.ts`'s 193 node-builtin
  // import edges. The sentence is rendered VERBATIM by the table, the rule
  // `IsolationNetworkPosture` already follows: the classification is made where
  // the decision is made, and a table that re-worded it would be stating a
  // second truth about what binds.
  config.blockedTools?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? fallbackLabels.blockedTool : (item.comment || fallbackLabels.blockedTool)
    const preemption = classifyBlockedToolDeclaration(pattern, ALWAYS_ALLOWED_TOOL_NAMES)
    rows.push({
      access: 'blocked',
      type: 'tool',
      pattern,
      comment,
      unenforceable: preemption
        ? t(BLOCKED_TOOL_PREEMPTION_KEYS[preemption.kind], {
            tool: pattern,
            matched: 'matched' in preemption ? preemption.matched : '',
          })
        : null,
    })
  })

  // Additional bash patterns
  config.allowedBashPatterns?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? fallbackLabels.bashPattern : (item.comment || fallbackLabels.bashPattern)
    rows.push({ access: 'allowed', type: 'bash', pattern, comment })
  })

  // Additional MCP patterns
  config.allowedMcpPatterns?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? fallbackLabels.mcpPattern : (item.comment || fallbackLabels.mcpPattern)
    rows.push({ access: 'allowed', type: 'mcp', pattern, comment })
  })

  // API endpoints
  config.allowedApiEndpoints?.forEach((item) => {
    const pattern = `${item.method} ${item.path}`
    rows.push({ access: 'allowed', type: 'api', pattern, comment: item.comment || fallbackLabels.apiEndpoint })
  })

  // F1.1052 — `allowedWritePaths` gets no row here either: no mode reads it (see
  // `buildDefaultPermissionsData`). It used to be listed as "Write to: <pattern>",
  // ALLOWED, beside the rules that really do decide — a grant the table claimed
  // and the gate never honoured. Kept parseable, not kept visible.
  //
  // (Removed with it: the `writePath` fallback label and its locale key.)
  //

  return rows
}

/**
 * C3.178 — the sentinel the primary-folder select uses for "no choice stored".
 *
 * An empty string cannot be used: Radix's `SelectItem` reserves `""` to mean
 * "clear the selection", so an option with that value renders and then refuses
 * to be selected. The sentinel is spelled with a character no absolute path can
 * start with, so it can never collide with a candidate.
 *
 * MODULE SCOPE rather than the component body, deliberately: a `const` declared
 * inside the component is a reactive value to `react-hooks/exhaustive-deps`, and
 * the handler below closes over it with an empty dependency array.
 */
const PRIMARY_DIRECTORY_DERIVED = '@derived'

/**
 * UB15.7 — the scope notes under a control (primary folder, MCP channel push, the sandbox switches) as their own
 * hairline-separated block of the card, in the in-card padding and the fine-print role. They were `text-xs` muted
 * lines inside a hand-padded card; upstream's settings material spells that tier `settingsUI.descriptionSmall`.
 */
const CARD_NOTE_CLASS = cn(settingsUI.cardPadding, settingsUI.descriptionSmall)

export default function PermissionsSettingsPage() {
  const { t, i18n } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()

  // Loading and data state
  const [isLoading, setIsLoading] = useState(true)
  const [defaultConfig, setDefaultConfig] = useState<PermissionsConfigFile | null>(null)
  const [customConfig, setCustomConfig] = useState<PermissionsConfigFile | null>(null)

  // Whether a connected MCP server may push text into a running turn. Off by
  // default; while off, no pooled connection is given a channel dispatcher.
  const [mcpChannelPush, setMcpChannelPush] = useState(false)

  // Which sandbox profiles this host can actually run. Diagnosis only — an
  // unavailable backend still fails closed at run time.
  const [isolation, setIsolation] = useState<IsolationCapabilityReportV1 | null>(null)

  // P6.327 — the two switches the panel above describes, as they RESOLVE
  // (managed floor included), plus whether an administrator has already decided
  // either one. Before this row the panel could show `sandbox.enabled` and not
  // change it, and the switch ships OFF: a control nobody can reach is a
  // control that does not control.
  const [sandboxSwitches, setSandboxSwitches] = useState<{
    enabled: boolean
    allowUnsandboxedCommands: boolean
    enabledManaged: boolean
    allowUnsandboxedCommandsManaged: boolean
  } | null>(null)

  // C3.178 — which attached folder is primary, and the set the choice is made
  // from, read together so the control can never show a folder that is no longer
  // attached. `choice: null` is "use the derivation", which is what every
  // install reports until someone opens this control.
  const [primaryDirectory, setPrimaryDirectoryState] = useState<{
    choice: string | null
    candidates: string[]
  } | null>(null)

  const handlePrimaryDirectoryChange = useCallback(async (value: string) => {
    const next = value === PRIMARY_DIRECTORY_DERIVED ? null : value
    // Optimistic, then RE-READ, for `handleSandboxSwitchChange`'s reason: the
    // stored choice is refused at resolution time when it names a folder that is
    // not attached, and the panel has to stay a report of what runs.
    setPrimaryDirectoryState(current => (current ? { ...current, choice: next } : current))
    await window.electronAPI?.setPrimaryDirectory(next)
    const resolved = await window.electronAPI?.getPrimaryDirectory()
    if (resolved) setPrimaryDirectoryState(resolved)
  }, [])

  const handleMcpChannelPushChange = useCallback(async (enabled: boolean) => {
    setMcpChannelPush(enabled)
    await window.electronAPI?.setMcpChannelPushEnabled(enabled)
  }, [])

  // P6.327 — optimistic locally, then RE-READ: the value that matters is the
  // resolved one, and a managed floor can answer something other than what was
  // written. Re-reading is how the panel stays a report of what runs.
  const handleSandboxSwitchChange = useCallback(
    async (next: { enabled?: boolean; allowUnsandboxedCommands?: boolean }) => {
      setSandboxSwitches(current => (current ? { ...current, ...next } : current))
      await window.electronAPI?.setSandboxSwitches(next)
      const resolved = await window.electronAPI?.getSandboxSwitches()
      if (resolved) setSandboxSwitches(resolved)
      // The isolation report carries the master switch too; a stale copy of it
      // would leave the "isolation is off" notice contradicting the toggle
      // directly above it.
      const report = await window.electronAPI?.getIsolationCapabilities()
      if (report) setIsolation(report)
    },
    [],
  )

  // Build default permissions data from ~/.nessy-agent/permissions/default.json
  const defaultPermissionsData = useMemo(() => buildDefaultPermissionsData(defaultConfig), [defaultConfig])

  // Fallback labels for custom permissions (translated)
  const permissionFallbackLabels = useMemo(() => ({
    blockedTool: t("settings.permissions.customBlockedTool"),
    bashPattern: t("settings.permissions.customBashPattern"),
    mcpPattern: t("settings.permissions.customMcpPattern"),
    apiEndpoint: t("settings.permissions.customApiEndpoint"),
    // F1.1052: no `writePath` — `allowedWritePaths` is no longer listed (see buildDefaultPermissionsData)
  }), [t])

  // Build custom permissions data from workspace permissions.json, then mark the
  // rows the app defaults already grant (P6.209 — see
  // `annotateRowsAlreadyGrantedByDefaults` for the resolver order this reads).
  const customPermissionsData = useMemo(() => {
    if (!customConfig) return []
    return annotateRowsAlreadyGrantedByDefaults(
      buildCustomPermissionsData(customConfig, permissionFallbackLabels, t),
      defaultPermissionsData,
      t("settings.permissions.rowAlreadyGranted"),
    )
  }, [customConfig, defaultPermissionsData, permissionFallbackLabels, t])

  // Load both default and workspace permissions configs
  useEffect(() => {
    const loadPermissions = async () => {
      if (!window.electronAPI) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        const { config: defaults } = await window.electronAPI.getDefaultPermissionsConfig()
        setDefaultConfig(defaults)
        setMcpChannelPush(await window.electronAPI.getMcpChannelPushEnabled())
        setPrimaryDirectoryState(await window.electronAPI.getPrimaryDirectory().catch(() => null))
        setIsolation(await window.electronAPI.getIsolationCapabilities().catch(() => null))
        setSandboxSwitches(await window.electronAPI.getSandboxSwitches().catch(() => null))

        // Load workspace permissions if we have an active workspace
        if (activeWorkspaceId) {
          const workspace = await window.electronAPI.getWorkspacePermissionsConfig(activeWorkspaceId)
          setCustomConfig(workspace)
        }
      } catch (error) {
        console.error('Failed to load permissions:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadPermissions()
  }, [activeWorkspaceId])

  // Listen for default permissions changes (file watcher)
  useEffect(() => {
    if (!window.electronAPI?.onDefaultPermissionsChanged) return

    const unsubscribe = window.electronAPI.onDefaultPermissionsChanged(async () => {
      // Reload default permissions when the file changes
      const { config: defaults } = await window.electronAPI.getDefaultPermissionsConfig()
      setDefaultConfig(defaults)
    })

    return unsubscribe
  }, [])

  return (
    <SettingsPage
      title={t("settings.permissions.title")}
      description={t("settings.permissions.description")}
      actions={<HeaderMenu route={routes.view.settings('permissions')} helpFeature="permissions" />}
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner className="text-lg text-tertiary" />
        </div>
      ) : (
        <>
          {/* About Section */}
          <SettingsSection title={t("settings.permissions.aboutPermissions")}>
            <SettingsCard className="px-3.5 py-3">
              <div className={settingsUI.prose}>
                <p>
                  {t("settings.permissions.aboutText1")}
                </p>
                <p>
                  {t("settings.permissions.aboutText2")}
                </p>
                <p>
                  <button
                    type="button"
                    onClick={() => window.electronAPI?.openUrl(getDocUrl('permissions', i18n.resolvedLanguage))}
                    className={settingsUI.link}
                  >
                    {t("common.learnMore")}
                  </button>
                </p>
              </div>
            </SettingsCard>
          </SettingsSection>

          {/* C3.178 — WHICH attached folder is primary, as a choice.
              The surface the row asks for, and the reason it has to
              exist: the wire block that carries `primaryRoot`
              (`PiHarnessFilesystemScopeSummaryV1`) is display-dead
              (P2.364), so without a control here the choice would have
              no reader a person can meet.

              The scope note is not decoration. P6.929 closed by record
              2026-09-10 with option (b) — the primary folder is a
              DISPLAY and ORDERING choice and discovery stays on the
              project root — and a folder picker that did not say so
              would be read as "point the agent at this instead". */}
          {primaryDirectory && primaryDirectory.candidates.length > 0 && (
            <SettingsSection title={t("settings.permissions.primaryFolderSection")}>
              <SettingsCard>
                <SettingsSelect
                  label={t("settings.permissions.primaryFolder")}
                  description={t("settings.permissions.primaryFolderDesc")}
                  value={primaryDirectory.choice ?? PRIMARY_DIRECTORY_DERIVED}
                  onValueChange={handlePrimaryDirectoryChange}
                  options={[
                    {
                      value: PRIMARY_DIRECTORY_DERIVED,
                      label: t("settings.permissions.primaryFolderDerived"),
                    },
                    ...primaryDirectory.candidates.map(root => ({ value: root, label: root })),
                  ]}
                  inCard
                />
                <p className={CARD_NOTE_CLASS}>
                  {t("settings.permissions.primaryFolderScopeNote")}
                </p>
              </SettingsCard>
            </SettingsSection>
          )}

          {/* MCP Channel Push Section */}
          <SettingsSection title={t("settings.permissions.mcpChannelPushSection")}>
            <SettingsCard>
              <SettingsToggle
                label={t("settings.permissions.mcpChannelPush")}
                description={t("settings.permissions.mcpChannelPushDesc")}
                checked={mcpChannelPush}
                onCheckedChange={handleMcpChannelPushChange}
              />
              {/* P6.510 — the two scopes, said in one place. The toggle
                  above is the app-wide grant; a session may arm servers
                  for itself while it is off, and the delegated decision
                  (Q-den 37, option 2) deliberately SEEDS the session set
                  from this preference — a softer boundary than the
                  page's, which is exactly why it has to be stated rather
                  than left to be discovered. */}
              <p className={CARD_NOTE_CLASS}>
                {t("settings.permissions.mcpChannelPushScopeNote")}
              </p>
            </SettingsCard>
          </SettingsSection>

          {/* P6.536 — the built-in browser's per-origin trust store:
              read and revoke, never grant. A grant is made on the card,
              in the window the page is in. */}
          <BrowserOriginTrustSection />

          {/* Process Isolation Section */}
          <SettingsSection
            title={t("settings.permissions.isolationSection")}
            description={t("settings.permissions.isolationSectionDesc")}
          >
            {/* P6.327 — the two switches, above the diagnosis they
                decide. A switch an administrator has pinned is SHOWN
                and not offered: writing a value the managed floor will
                overrule is the surface lying about who is in control. */}
            {sandboxSwitches && (
              <SettingsCard>
                <SettingsToggle
                  label={t("settings.permissions.sandboxSwitchLabel")}
                  description={
                    sandboxSwitches.enabledManaged
                      ? t("settings.permissions.sandboxManagedPinned")
                      : t("settings.permissions.sandboxSwitchDesc")
                  }
                  checked={sandboxSwitches.enabled}
                  disabled={sandboxSwitches.enabledManaged}
                  onCheckedChange={enabled => { void handleSandboxSwitchChange({ enabled }) }}
                />
                <SettingsToggle
                  label={t("settings.permissions.sandboxEscapeHatchLabel")}
                  description={
                    sandboxSwitches.allowUnsandboxedCommandsManaged
                      ? t("settings.permissions.sandboxManagedPinned")
                      : t("settings.permissions.sandboxEscapeHatchDesc")
                  }
                  checked={sandboxSwitches.allowUnsandboxedCommands}
                  disabled={sandboxSwitches.allowUnsandboxedCommandsManaged}
                  onCheckedChange={allowUnsandboxedCommands => {
                    void handleSandboxSwitchChange({ allowUnsandboxedCommands })
                  }}
                />
                {/* P6.327's second half: what the boundary does NOT
                    cover, in a line the user can read rather than a
                    code comment. Unconditional — it is as true with the
                    switch off as on, and a user turning it ON is
                    exactly who needs to know its reach. */}
                <p className={CARD_NOTE_CLASS}>
                  {t("settings.permissions.sandboxScopeNotice")}
                </p>
              </SettingsCard>
            )}
            {/* The master switch first: everything below answers "what
                COULD this host run", and with the switch off none of it
                is applied. Listing profiles without saying so
                advertises isolation the user does not have. */}
            {isolation ? (
              <SettingsCard>
                {isolation.sandboxEnabled === false && (
                  <p className={cn(settingsUI.cardPadding, 'text-label-sm leading-4.5 text-destructive')}>
                    {t("settings.permissions.isolationDisabled")}
                  </p>
                )}
                <dl className="divide-y divide-separator">
                  {Object.entries(isolation.profiles).map(([profile, entry]) => (
                    <div key={profile} className={cn(settingsUI.cardPadding, 'space-y-1')}>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="font-mono text-mono-ui text-foreground">{profile}</dt>
                        <dd className={cn('text-label', entry.available ? 'text-secondary' : 'text-destructive')}>
                          {entry.available
                            ? t("settings.permissions.isolationAvailable")
                            : t("settings.permissions.isolationUnavailable")}
                        </dd>
                      </div>
                      <p className={cn(settingsUI.description, '[overflow-wrap:anywhere]')}>
                        {entry.available ? entry.backend : entry.remediation}
                      </p>
                    </div>
                  ))}
                  {/* `networked: available` says the profile works, not what
                      it grants. The egress posture belongs on the same list. */}
                  <IsolationNetworkPosture
                    posture={isolation.network}
                    sandboxEnabled={isolation.sandboxEnabled}
                  />
                </dl>
              </SettingsCard>
            ) : (
              <SettingsCard className="px-3.5 py-3">
                <p className="text-label text-tertiary">
                  {t("settings.permissions.isolationUnknown")}
                </p>
              </SettingsCard>
            )}
          </SettingsSection>

          {/* Default Permissions Section */}
          <SettingsSection
            title={t("settings.permissions.defaultPermissions")}
            description={t("settings.permissions.defaultPermissionsDesc")}
            action={
              <EditPopover
                trigger={<EditButton />}
                {...getManagedEditConfig('default-permissions', { scope: 'global', kind: 'default-permissions' })}
              />
            }
          >
            <SettingsCard className="p-0">
              {defaultPermissionsData.length > 0 ? (
                <PermissionsDataTable
                  data={defaultPermissionsData}
                  searchable
                  maxHeight={350}
                  fullscreen
                  fullscreenTitle={t("settings.permissions.defaultPermissions")}
                />
              ) : (
                <div className="px-6 py-8 text-center">
                  <p className="text-label text-secondary">{t("settings.permissions.noDefaultPermissions")}</p>
                  <p className="mt-1 text-label-sm text-tertiary">
                    {t("settings.permissions.noDefaultPermissionsDesc")}
                  </p>
                </div>
              )}
            </SettingsCard>
          </SettingsSection>

          {/* Custom Permissions Section */}
          <SettingsSection
            title={t("settings.permissions.workspaceCustomizations")}
            description={`${t("settings.permissions.workspaceCustomizationsDesc")} ${t("settings.permissions.crossScopeNote")}`}
            action={
              activeWorkspaceId ? (
                  <EditPopover
                    trigger={<EditButton />}
                    {...getManagedEditConfig('workspace-permissions', {
                      scope: 'workspace', workspaceId: activeWorkspaceId, kind: 'permissions',
                    })}
                  />
              ) : null
            }
          >
            <SettingsCard className="p-0">
              {customPermissionsData.length > 0 ? (
                <PermissionsDataTable
                  data={customPermissionsData}
                  unenforceableStyle="annotate"
                  searchable
                  maxHeight={350}
                  fullscreen
                  fullscreenTitle={t("settings.permissions.workspaceCustomizations")}
                />
              ) : (
                <div className="px-6 py-8 text-center">
                  <p className="text-label text-secondary">{t("settings.permissions.noCustomPermissions")}</p>
                  <p className="mt-1 text-label-sm text-tertiary">
                    {t("settings.permissions.noCustomPermissionsDesc")}
                  </p>
                </div>
              )}
            </SettingsCard>
          </SettingsSection>

          {/* P6.209 (A44, A45) — the auto-mode judge's own rules, last
              because they are a different KIND of thing from the two
              tables above: those are rules this app enforces itself, and
              these are the instructions it hands a second model that
              only runs when this app has already declined to decide. */}
          <AutoModeJudgeRulesSection />

          {/* P6.209 (A42) — and after the rules on purpose: the rules are
              what the judge was TOLD, and these are what it then did. A
              list of refusals above the rules that produced them reads as
              a fault log rather than as the consequence of a policy. */}
          <AutoModeDenialsSection workspaceId={activeWorkspaceId ?? null} />
        </>
      )}
    </SettingsPage>
  )
}
