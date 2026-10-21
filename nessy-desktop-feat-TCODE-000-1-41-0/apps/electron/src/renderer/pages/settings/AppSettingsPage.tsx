/**
 * Source: v0.15.1:apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx (UB15.5; per-hunk merge: the
 * SettingsPage column with the settings.app.description lede, the proxy footer's ghost Reset / primary Save at md,
 * the About row's tabular-nums version and secondary / primary md buttons. Not taken: the one headless
 * Notifications · Power · Tools card — ours are not one-row groups, so every group keeps its heading (R5-04)).
 */
/**
 * AppSettingsPage
 *
 * Global app-level settings that apply across all workspaces.
 *
 * Settings:
 * - Notifications (timing, permission and question alerts)
 * - Power (keep the screen awake)
 * - Workflows (the size guideline)
 * - Data retention (the destructive age-based cleanup window and its off switch)
 * - Messages from your other sessions (the `crossSessionInbound` user rung)
 * - Tools (the built-in browser, its download folder and ask-each-time)
 * - Network (proxy, bundled and custom CA)
 * - About (version, updates)
 * - Provenance, Config Doctor and Safe Mode (the three troubleshooting sections)
 *
 * Note: AI settings (connections, model, thinking) have been moved to AiSettingsPage.
 * Note: Appearance settings (theme, font) have been moved to AppearanceSettingsPage.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { Spinner } from '@nessy-agent/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type {
  BrowserDownloadSettingsView,
  CrossSessionInboundSetting,
  CrossSessionInboundSettingsV1,
  NetworkProxySettings,
  RetentionSettingsV1,
  UpdateInfo,
} from '../../../shared/types'
import type {
  SafeWorkflowSettingsView,
  SafeWorkflowSizeGuideline,
} from '@nessy-agent/shared/protocol/capabilities'
import { WORKFLOW_SIZE_GUIDELINES } from '@nessy-agent/shared/config/workflow-settings'
// P6.971 — the vocabulary module, NOT `config/storage`: that import edge was
// the whole second chain of the release blocker. `storage.ts` reads `fs`,
// `path` and `crypto`, and through this one line the renderer bundle reached
// 175 modules importing a node builtin by NAME (sources, sessions, automations,
// session-tools-core, the Agent SDK), each a hard rollup error against Vite's
// `export default {}` stub for a browser-externalized builtin. Measured:
// 1026 modules / 175 offenders with this edge, 830 / 0 without it. Import the
// pure vocabulary here; anything else this page comes to need from `storage.ts`
// belongs beside those constants, not behind `storage.ts`.
import {
  CROSS_SESSION_INBOUND_ENV_NAME,
  CROSS_SESSION_INBOUND_SETTINGS,
} from '@nessy-agent/shared/config/cross-session-inbound-vocabulary'

import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsSelectRow,
  SettingsToggle,
  SettingsInput,
} from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_TIMINGS,
  isNotificationTiming,
  type NotificationSettings,
} from '@nessy-agent/shared/config/notification-timing'
import { useUpdateChecker } from '@/hooks/useUpdateChecker'
import { useAppShellContext } from '@/context/AppShellContext'
import SettingsProvenanceSection from './SettingsProvenanceSection'
import SettingsConfigDoctorSection from './SettingsConfigDoctorSection'
import SettingsSafeModeSection from './SettingsSafeModeSection'

/**
 * P6.868 — the picker's spelling of the fourth state.
 *
 * `SettingsSelect` is typed `string` and an empty option value is not
 * selectable, so unset needs a token. It lives ONLY between the dropdown and the
 * change handler that maps it back to `null`: the store's three values are the
 * vendor's exact spellings, and a fourth reaching `config.json` would be the
 * sentinel this key's own writer refuses on purpose.
 */
const UNSET_CROSS_SESSION_INBOUND = '__unset__'

/**
 * UB15.5 — the free-form lines inside a card (the workflow, retention, cross-session, download and managed-updates
 * notes) on v0.15.1's in-card padding and prose material, the shape its Labels and Permissions pages give their
 * notes. Until UB15.5 each block spelled its own padding and muted ink. A line that reports a refusal or a problem
 * keeps `text-destructive` on itself.
 */
const CARD_NOTE_CLASS = cn(settingsUI.cardPadding, settingsUI.prose)

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'app',
}

/**
 * Whether a managed policy has taken in-app updates off (P2.10).
 *
 * Named and exported rather than inlined for the reason
 * `computeGatewayReconnectItem` in `AiSettingsPage` is: `bun test` has no DOM
 * here, so a rule that decides what the page shows is tested as a function and
 * its wiring pinned by source match.
 *
 * The flag comes from the main process (`auto-update.ts`), never from a local
 * guess: under the policy the payload also reports `available: false`, which is
 * indistinguishable from an up-to-date app, so this ONE field is what separates
 * "nothing to install" from "not allowed to install".
 */
export function isUpdatesManagedOff(info: UpdateInfo | null | undefined): boolean {
  return info?.managedDisabled === true
}

/**
 * WHICH administrator's document turned updates off — P3.240, the i18n key or
 * `undefined` when the payload does not say.
 *
 * The indicator P2.10 built says the policy exists; it could not say whose it
 * was, and two documents can set it: the host's composed `managed-policy.json`
 * and a codex deployment's `requirements.toml`. Those live in different places
 * and are changed by different people, so "your organization's policy" alone is
 * not something an operator can act on.
 *
 * Gated on {@link isUpdatesManagedOff} rather than on the source field alone: a
 * line naming a managed document under a card that is not managed would be
 * worse than the missing line. `undefined` for a payload from a main process
 * older than P3.240 — the existing sentence stands on its own, which is why this
 * is an EXTRA line rather than a parameter on that one.
 */
export function updatesManagedSourceKey(info: UpdateInfo | null | undefined): string | undefined {
  if (!isUpdatesManagedOff(info)) return undefined
  switch (info?.managedSource) {
    case 'host': return 'settings.about.updatesManagedByHost'
    case 'codex': return 'settings.about.updatesManagedByCodex'
    case 'both': return 'settings.about.updatesManagedByBoth'
    default: return undefined
  }
}

// ============================================
// Proxy form helpers
// ============================================

interface ProxyFormState {
  enabled: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
  tlsCaPath: string
  useBundledCa: boolean
}

const EMPTY_PROXY_FORM: ProxyFormState = {
  enabled: false,
  httpProxy: '',
  httpsProxy: '',
  noProxy: '',
  tlsCaPath: '',
  useBundledCa: true,
}

function toProxyFormState(settings?: NetworkProxySettings): ProxyFormState {
  if (!settings) return EMPTY_PROXY_FORM
  return {
    enabled: settings.enabled,
    httpProxy: settings.httpProxy ?? '',
    httpsProxy: settings.httpsProxy ?? '',
    noProxy: settings.noProxy ?? '',
    tlsCaPath: settings.tlsCaPath ?? '',
    useBundledCa: settings.useBundledCa !== false,
  }
}

function toNetworkProxySettings(form: ProxyFormState): NetworkProxySettings {
  // Storage merge-preserves fields a save does not carry (`undefined` means
  // "not my field", so the admin-configured TLS client identity survives this
  // form's saves). The six fields the form OWNS are therefore always carried
  // explicitly: a blank input as '' (an explicit clear), the CA checkbox as a
  // literal boolean — emitting `undefined` for either would stop a user's
  // clear from clearing.
  return {
    enabled: form.enabled,
    httpProxy: form.httpProxy.trim(),
    httpsProxy: form.httpsProxy.trim(),
    noProxy: form.noProxy.trim(),
    tlsCaPath: form.tlsCaPath.trim(),
    useBundledCa: form.useBundledCa,
  }
}

function validateProxyUrl(url: string): string | undefined {
  if (!url.trim()) return undefined
  try {
    const parsed = new URL(url.trim())
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
      return 'proxyErrorProtocol'
    }
    return undefined
  } catch {
    return 'proxyErrorFormat'
  }
}

// ============================================
// Main Component
// ============================================

export default function AppSettingsPage() {
  const { t } = useTranslation()
  // The provenance checkup is per workspace: two of its four scopes are project
  // files, and the server resolves them under this workspace's root.
  const activeWorkspaceId = useAppShellContext().activeWorkspaceId

  // Notifications state — the whole policy, not one switch.
  // `learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications`: "Open **Settings** to
  // choose whether turn-completion alerts appear never, only while ChatGPT is
  // in the background, or always. Separate controls let you turn permission and
  // question notifications on or off."
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS)

  // Power state
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false)

  // Tools state
  const [browserToolEnabled, setBrowserToolEnabled] = useState(true)

  // P6.564 — where a browser-pane download lands. `downloadRootInput` is the raw
  // text so a half-typed path never round-trips to the writer; the view beside it
  // carries what is actually IN FORCE, which is not always what this field holds:
  // an operator's environment outranks config.json, and a refused value has to
  // reach the user as a sentence rather than as a silently saved field.
  const [downloadPolicy, setDownloadPolicy] = useState<BrowserDownloadSettingsView | null>(null)
  const [downloadRootInput, setDownloadRootInput] = useState('')

  // Retention state — the destructive cleanup window. `retentionDaysInput` is
  // the raw text so a half-typed number never round-trips to a writer that
  // deletes transcripts; the write happens on blur, and only for a value the
  // documented minimum accepts.
  const [retention, setRetention] = useState<RetentionSettingsV1 | null>(null)
  const [retentionDaysInput, setRetentionDaysInput] = useState('')
  const [retentionError, setRetentionError] = useState<string | undefined>()

  // P6.868 — the four states of `crossSessionInbound`, RESOLVED host-side. Null
  // until the first read lands; the section is hidden until then rather than
  // rendering a guess, because a control showing the wrong precedence is worse
  // than one that is not there yet.
  const [inbound, setInbound] = useState<CrossSessionInboundSettingsV1 | null>(null)

  // P6.319 — workflow governance, RESOLVED host-side across the user, managed
  // and env layers. Null until the first read lands; the section is hidden until
  // then rather than rendering a guess, because the value it shows is the one
  // the model is actually given.
  const [workflowSettings, setWorkflowSettings] = useState<SafeWorkflowSettingsView | null>(null)

  // Proxy state
  const [proxyForm, setProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [savedProxyForm, setSavedProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [proxyError, setProxyError] = useState<string | undefined>()
  const [isSavingProxy, setIsSavingProxy] = useState(false)

  // Auto-update state (Check Now / Update Ready only shown in Electron, not WebUI)
  const isElectron = window.electronAPI.getRuntimeEnvironment() === 'electron'
  const updateChecker = useUpdateChecker()
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false)
  const updatesManagedOff = isUpdatesManagedOff(updateChecker.updateInfo)
  const updatesManagedSource = updatesManagedSourceKey(updateChecker.updateInfo)

  const handleCheckForUpdates = useCallback(async () => {
    setIsCheckingForUpdates(true)
    try {
      await updateChecker.checkForUpdates()
    } finally {
      setIsCheckingForUpdates(false)
    }
  }, [updateChecker])

  // Load settings on mount
  const loadSettings = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const [
        notifications,
        keepAwakeOn,
        browserToolOn,
        proxySettings,
        retentionSettings,
        downloadSettings,
        workflow,
        crossSessionInbound,
      ] = await Promise.all([
        window.electronAPI.getNotificationSettings(),
        window.electronAPI.getKeepAwakeWhileRunning(),
        window.electronAPI.getBrowserToolEnabled(),
        window.electronAPI.getNetworkProxySettings(),
        window.electronAPI.getRetentionSettings(),
        window.electronAPI.getBrowserDownloadSettings(),
        window.electronAPI.getWorkflowSettings(),
        window.electronAPI.getCrossSessionInboundSettings(),
      ])
      setNotificationSettings(notifications)
      setKeepAwakeEnabled(keepAwakeOn)
      setBrowserToolEnabled(browserToolOn)
      setDownloadPolicy(downloadSettings)
      setDownloadRootInput(downloadSettings.root)
      setRetention(retentionSettings)
      setRetentionDaysInput(String(retentionSettings.days))
      setWorkflowSettings(workflow)
      setInbound(crossSessionInbound)
      const form = toProxyFormState(proxySettings)
      setProxyForm(form)
      setSavedProxyForm(form)
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [])

  /**
   * One writer for all three controls.
   *
   * The optimistic local update comes first so a dropdown does not snap back
   * while the write is in flight; a rejected write is re-read rather than
   * guessed at, because the store is allowed to normalise what it was given.
   */
  const handleNotificationSettingsChange = useCallback(async (next: NotificationSettings) => {
    setNotificationSettings(next)
    try {
      await window.electronAPI.setNotificationSettings(next)
    } catch (error) {
      console.error('Failed to save notification settings:', error)
      await window.electronAPI.getNotificationSettings().then(setNotificationSettings).catch(() => {})
    }
  }, [])

  const handleKeepAwakeEnabledChange = useCallback(async (enabled: boolean) => {
    setKeepAwakeEnabled(enabled)
    await window.electronAPI.setKeepAwakeWhileRunning(enabled)
  }, [])

  const handleBrowserToolEnabledChange = useCallback(async (enabled: boolean) => {
    setBrowserToolEnabled(enabled)
    await window.electronAPI.setBrowserToolEnabled(enabled)
  }, [])

  /**
   * P6.564 — both download controls write and then take the RESOLVED view back,
   * never their own optimistic guess. The write can be accepted and still not be
   * in force (an environment variable outranks it) or be refused outright (a
   * relative path), and both of those are things the user has to be told.
   */
  const commitDownloadSettings = useCallback(async (next: { root?: string; ask?: boolean }) => {
    try {
      const view = await window.electronAPI.setBrowserDownloadSettings(next)
      setDownloadPolicy(view)
      setDownloadRootInput(view.root)
    } catch (error) {
      console.error('Failed to save browser download settings:', error)
    }
  }, [])

  const handleDownloadRootCommit = useCallback(async () => {
    await commitDownloadSettings({
      root: downloadRootInput.trim(),
      ask: downloadPolicy?.ask === true,
    })
  }, [commitDownloadSettings, downloadRootInput, downloadPolicy?.ask])

  const handleDownloadAskChange = useCallback(async (ask: boolean) => {
    await commitDownloadSettings({ root: downloadRootInput.trim(), ask })
  }, [commitDownloadSettings, downloadRootInput])

  /**
   * P6.623 — the folder picker, so an absolute path does not have to be typed
   * from memory and learned to be wrong from the card's problem line.
   *
   * Native mechanism, and it was already here: `dialog:openFolder` routes to
   * Electron's own `showOpenDialog({ properties: ['openDirectory', …] })`
   * through the existing client capability. Nothing new is built; the channel
   * only learned to carry a title, so this picker does not say *Select Working
   * Directory*.
   *
   * A cancel returns null and writes nothing. A pick commits immediately, the
   * same way a blur does, so the resolved view (and any problem line) comes back
   * from the writer rather than from an optimistic guess here.
   */
  const handleBrowseDownloadRoot = useCallback(async () => {
    const picked = await window.electronAPI.openFolderDialog({
      title: t('settings.tools.downloadRootPickerTitle'),
    })
    if (!picked) return
    setDownloadRootInput(picked)
    await commitDownloadSettings({ root: picked, ask: downloadPolicy?.ask === true })
  }, [commitDownloadSettings, downloadPolicy?.ask, t])

  // Retention handlers. Both re-read the persisted policy afterwards, because
  // the effective window and its warning can come from a managed policy this
  // control cannot change.
  const refreshRetention = useCallback(async () => {
    const persisted = await window.electronAPI.getRetentionSettings()
    setRetention(persisted)
    setRetentionDaysInput(String(persisted.days))
  }, [])

  const handleRetentionSweepEnabledChange = useCallback(async (enabled: boolean) => {
    setRetention(prev => (prev ? { ...prev, sweepEnabled: enabled } : prev))
    await window.electronAPI.setRetentionSweepEnabled(enabled)
    await refreshRetention()
  }, [refreshRetention])

  const handleRetentionDaysCommit = useCallback(async () => {
    const minDays = retention?.minDays ?? 1
    const parsed = Number(retentionDaysInput.trim())
    if (!/^\d+$/.test(retentionDaysInput.trim()) || !Number.isInteger(parsed) || parsed < minDays) {
      setRetentionError(t('settings.retention.invalid', { min: minDays }))
      return
    }
    setRetentionError(undefined)
    if (parsed === retention?.days) return
    try {
      await window.electronAPI.setRetentionDays(parsed)
      await refreshRetention()
    } catch (error) {
      setRetentionError(error instanceof Error ? error.message : String(error))
    }
  }, [refreshRetention, retention?.days, retention?.minDays, retentionDaysInput, t])

  /**
   * P6.868 — write the user rung, then read all four states back.
   *
   * The read-back is not a formality: the operator control outranks whatever was
   * just written, and an unreadable stored value the write has just replaced must
   * stop being reported. Both are host-side facts a local guess cannot produce.
   *
   * `null` is the fourth state, and it CLEARS the key — the handler routes it to
   * `clearCrossSessionInbound`, because storing a sentinel for "unset" would make
   * the app's unset and a hand-edited file's unset two different states.
   */
  const handleCrossSessionInboundChange = useCallback(
    async (mode: CrossSessionInboundSetting | null) => {
      await window.electronAPI.setCrossSessionInbound(mode)
      setInbound(await window.electronAPI.getCrossSessionInboundSettings())
    },
    [],
  )

  /**
   * P6.319 — write the size guideline, then read the RESOLVED value back.
   *
   * The read-back is not a formality: the value the user picked is one layer of
   * three, so an install whose managed policy pins the guideline must show the
   * pinned value rather than the click. Optimistically setting local state would
   * be the same lie the row exists to remove.
   */
  const handleWorkflowSizeGuidelineChange = useCallback(async (guideline: SafeWorkflowSizeGuideline) => {
    try {
      await window.electronAPI.setWorkflowSizeGuideline(guideline)
    } catch (error) {
      console.error('Failed to set workflow size guideline:', error)
    }
    try {
      setWorkflowSettings(await window.electronAPI.getWorkflowSettings())
    } catch (error) {
      console.error('Failed to re-read workflow settings:', error)
    }
  }, [])

  // Proxy handlers
  const isProxyDirty = useMemo(() => {
    return JSON.stringify(proxyForm) !== JSON.stringify(savedProxyForm)
  }, [proxyForm, savedProxyForm])

  const handleSaveProxy = useCallback(async () => {
    // Validate URLs
    const httpErr = validateProxyUrl(proxyForm.httpProxy)
    const httpsErr = validateProxyUrl(proxyForm.httpsProxy)
    if (httpErr || httpsErr) {
      setProxyError(httpErr || httpsErr)
      return
    }
    setProxyError(undefined)
    setIsSavingProxy(true)
    try {
      const settings = toNetworkProxySettings(proxyForm)
      await window.electronAPI.setNetworkProxySettings(settings)
      // Re-read persisted state to confirm
      const persisted = await window.electronAPI.getNetworkProxySettings()
      const form = toProxyFormState(persisted)
      setProxyForm(form)
      setSavedProxyForm(form)
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : 'Failed to save')
    } finally {
      setIsSavingProxy(false)
    }
  }, [proxyForm])

  const handleResetProxy = useCallback(() => {
    setProxyForm(savedProxyForm)
    setProxyError(undefined)
  }, [savedProxyForm])

  return (
    <SettingsPage
      title={t("settings.app.title")}
      description={t("settings.app.description")}
      actions={<HeaderMenu route={routes.view.settings('app')} helpFeature="app-settings" />}
    >
      {/* UB15.5 — every group keeps its heading. v0.15.1 merges Notifications · Power · Tools into ONE headless
          card because each was a single toggle there; ours are not one-row groups (Notifications has three rows
          and the P6.467 scope note, Tools has three rows), and a lone headless card would read as unlabelled. */}
      {/* Notifications */}
      {/*
        * P6.467 — the row asked for four claude notification categories
        * and a channel selector, "identical on all three runtimes". The
        * native clause it carried is REFUTED, measured by W7-t against
        * the shipped `claude-agent-sdk-darwin-arm64/claude` and the
        * vendored `sdk.d.ts`, and the honest outcome is a SENTENCE here
        * rather than three settings that do nothing:
        *
        * - `preferredNotifChannel` (binary 24, in the settings schema)
        *   is a TERMINAL selector — `auto | iterm2 | terminal_bell |
        *   iterm2_with_bell | kitty | ghostty | notifications_disabled`
        *   — and our SDK child is spawned headless inside Electron with
        *   no terminal to ring.
        * - `agentPushNotifEnabled` (44) and `inputNeededNotifEnabled`
        *   (38) are mobile push through Anthropic's own infrastructure,
        *   unreachable from the gateway card.
        * - `awaySummaryEnabled` (21) is in the BINARY only and in no
        *   settings schema, so it is not a key we could write at all —
        *   which is why the row's "four categories" is really two and a
        *   channel even before the inertness is counted.
        *
        * Writing those keys would be a no-op at best and a promise we
        * cannot keep at worst. What IS uniform is this surface: the
        * notification port is ours and runtime-agnostic, so "identical
        * on all three runtimes" is free here rather than earned — and
        * the description now says so to the user who would otherwise go
        * looking for a runtime notification setting that does nothing.
        */}
      <SettingsSection
        title={t("settings.notifications.title")}
        description={t("settings.notifications.scopeNote")}
      >
        <SettingsCard>
          <SettingsSelectRow
            label={t("settings.notifications.turnCompletion")}
            description={t("settings.notifications.turnCompletionDesc")}
            value={notificationSettings.timing}
            onValueChange={(value) => {
              // The select is typed `string`; an unknown value must not
              // reach the store, where it would silently read back as
              // the default on every later load.
              if (!isNotificationTiming(value)) return
              void handleNotificationSettingsChange({ ...notificationSettings, timing: value })
            }}
            options={NOTIFICATION_TIMINGS.map(timing => ({
              value: timing,
              label: t(`settings.notifications.timing.${timing}`),
            }))}
          />
          <SettingsToggle
            label={t("settings.notifications.permissionAlerts")}
            description={t("settings.notifications.permissionAlertsDesc")}
            checked={notificationSettings.permissionAlerts}
            onCheckedChange={(checked) => {
              void handleNotificationSettingsChange({ ...notificationSettings, permissionAlerts: checked })
            }}
          />
          <SettingsToggle
            label={t("settings.notifications.questionAlerts")}
            description={t("settings.notifications.questionAlertsDesc")}
            checked={notificationSettings.questionAlerts}
            onCheckedChange={(checked) => {
              void handleNotificationSettingsChange({ ...notificationSettings, questionAlerts: checked })
            }}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Power */}
      <SettingsSection title={t("settings.power.title")}>
        <SettingsCard>
          <SettingsToggle
            label={t("settings.power.keepScreenAwake")}
            description={t("settings.power.keepScreenAwakeDesc")}
            checked={keepAwakeEnabled}
            onCheckedChange={handleKeepAwakeEnabledChange}
          />
        </SettingsCard>
      </SettingsSection>

      {/*
        P6.319 — the workflow size guideline (`workflows.md` §Set a size
        guideline). ADVICE, never a cap, and the page says so: it moves
        the advisory large-run warning threshold and reaches the model as
        one sentence, and it blocks nothing.

        Only the guideline is writable. `disableWorkflows` and the keyword
        trigger are tighter-wins in the resolver, so a control here that
        appeared to turn workflows back on would write a value the
        resolver then ignores — instead the section says, in one line,
        when workflows are off and the guideline is therefore inert.
      */}
      {workflowSettings && (
        <SettingsSection title={t("settings.workflows.title")}>
          <SettingsCard>
            <SettingsSelectRow
              label={t("settings.workflows.sizeGuideline")}
              description={t("settings.workflows.sizeGuidelineDesc", {
                // The live threshold, read back from the host — this is
                // the readback the row asks for: `large` moves it 25 → 50.
                threshold: workflowSettings.agentThreshold,
              })}
              value={workflowSettings.sizeGuideline}
              onValueChange={(value) => {
                // The select is typed `string`; enumerate the union so an
                // unknown value cannot reach the writer.
                if (!WORKFLOW_SIZE_GUIDELINES.includes(value as SafeWorkflowSizeGuideline)) return
                void handleWorkflowSizeGuidelineChange(value as SafeWorkflowSizeGuideline)
              }}
              options={WORKFLOW_SIZE_GUIDELINES.map(guideline => ({
                value: guideline,
                label: t(`settings.workflows.sizeGuideline.${guideline}`),
              }))}
            />
            {(workflowSettings.disableWorkflows
              || workflowSettings.userSizeGuideline !== workflowSettings.sizeGuideline) && (
              <div className={CARD_NOTE_CLASS}>
                {workflowSettings.disableWorkflows && (
                  <div>{t("settings.workflows.disabledNote")}</div>
                )}
                {/*
                  The resolved value is not the one this user set, and
                  they did set one — so a layer above them decided. Said
                  rather than shown silently, which is the difference
                  between a control showing your choice and one showing
                  somebody else's.
                */}
                {workflowSettings.userSizeGuideline !== undefined
                  && workflowSettings.userSizeGuideline !== workflowSettings.sizeGuideline && (
                  <div>{t("settings.workflows.managedNote")}</div>
                )}
              </div>
            )}
          </SettingsCard>
        </SettingsSection>
      )}

      {/* Data retention — the sweep that deletes old sessions at startup */}
      <SettingsSection title={t("settings.retention.title")}>
        <SettingsCard>
          <SettingsToggle
            label={t("settings.retention.autoDelete")}
            description={t("settings.retention.autoDeleteDesc")}
            checked={retention?.sweepEnabled !== false}
            onCheckedChange={handleRetentionSweepEnabledChange}
          />
          {retention?.sweepEnabled !== false && (
            <SettingsInput
              label={t("settings.retention.days")}
              value={retentionDaysInput}
              onChange={setRetentionDaysInput}
              onBlur={handleRetentionDaysCommit}
              placeholder={t("settings.retention.daysPlaceholder")}
              disabled={retention?.managed === true}
              error={retentionError}
              inCard
            />
          )}
          <div className={CARD_NOTE_CLASS}>
            <div>
              {retention && retention.effectiveDays > 0
                ? t("settings.retention.effective", { days: retention.effectiveDays })
                : t("settings.retention.off")}
            </div>
            {retention?.managed && <div>{t("settings.retention.managed")}</div>}
            {/* The fail-safe's other half.
                `settings-reference.md#cleanupperioddays` makes the sweep
                conditional — "Claude Code runs the deletion as a
                background sweep after a session starts, as long as it
                can safely determine the retention period" — but states
                no display requirement, so showing a paused sweep rather
                than only logging it is OUR call. The sentence is the
                backend's own diagnostic. */}
            {retention?.warning && (
              <div className="text-destructive">{retention.warning}</div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      {/*
        P6.868 — messages from the user's own other sessions
        (`cross-session-messaging.md#control-inbound-messages`). The page's
        own `/config` row is READ-ONLY from the prompt and says the value
        is chosen here, so this is the only writer a user has.

        Four states, not three: unset is the documented default — "the two
        sessions' permission modes decide per message" — and it is a
        distinct behaviour rather than a synonym for `accept`, so it has
        its own option and its own write (`null`, which clears the key).

        The selector is HIDDEN, not disabled, while the operator control
        holds the key, for the page's own reason: it hides the row while
        managed settings or `--settings` set the value, "since a
        user-settings value wouldn't apply then". A disabled control would
        still invite the user to argue with it; the sentence beside it
        names the environment variable and its value instead, which is
        where the answer actually is.

        Only an operator value this host can READ locks, and since P6.872
        that is a DELIBERATE narrowing rather than a report of the
        enforcement module: an unreadable value there REFUSES
        (`explicit: true`), so the selector below cannot change the
        outcome while the typo stands. The lock stays false for it
        because the sentence beside it quotes the variable's value back
        to the user, and a typo has no readable value to quote.

        P6.1015 closes that case with a SECOND flag and a second
        sentence rather than by widening the first. `operatorUnreadable`
        (`storage.ts`) is set when the variable is present, non-empty and
        none of the three — the enforcement module's own condition — and
        it hides the selector for the same reason `operatorLocked` does:
        the user's choice cannot reach the outcome, so offering it is the
        lie. It gets no Clear button, unlike the stored-value banner
        below, because nothing in this app can clear an environment
        variable; the sentence says where it is changed instead. Two host
        surfaces had disagreed about one key — `/config`'s `unavailable`
        gate has fired on any non-empty value all along.
      */}
      {inbound && (
        <SettingsSection title={t("settings.crossSessionInbound.title")}>
          <SettingsCard>
            {!inbound.operatorLocked && !inbound.operatorUnreadable && (
              <SettingsSelectRow
                label={t("settings.crossSessionInbound.label")}
                description={t("settings.crossSessionInbound.desc")}
                value={inbound.mode ?? UNSET_CROSS_SESSION_INBOUND}
                onValueChange={(value) => {
                  // The select is typed `string`. The sentinel exists only
                  // between this dropdown and this line — it is mapped to
                  // `null` here and never reaches the store, so nothing
                  // outside the picker can mistake it for a stored value.
                  if (value === UNSET_CROSS_SESSION_INBOUND) {
                    void handleCrossSessionInboundChange(null)
                    return
                  }
                  if (!CROSS_SESSION_INBOUND_SETTINGS.includes(value as CrossSessionInboundSetting)) return
                  void handleCrossSessionInboundChange(value as CrossSessionInboundSetting)
                }}
                options={[
                  {
                    value: UNSET_CROSS_SESSION_INBOUND,
                    label: t("settings.crossSessionInbound.mode.unset"),
                  },
                  ...CROSS_SESSION_INBOUND_SETTINGS.map(mode => ({
                    value: mode,
                    label: t(`settings.crossSessionInbound.mode.${mode}`),
                  })),
                ]}
              />
            )}
            <div className={CARD_NOTE_CLASS}>
              {inbound.operatorLocked && (
                <div>{t("settings.crossSessionInbound.operatorLocked", {
                  env: CROSS_SESSION_INBOUND_ENV_NAME,
                  mode: inbound.operatorMode,
                })}</div>
              )}
              {/*
                P6.1015 — the operator's value is present and unreadable.
                Destructive, like the stored-value banner below and unlike
                the lock sentence above, because the outcome is a REFUSAL
                the user did not choose and cannot override: every message
                from their other sessions is dropped until an
                administrator fixes the variable. No Clear button — an
                environment variable is not this app's to clear.
              */}
              {inbound.operatorUnreadable && (
                <div className="text-destructive">
                  {t("settings.crossSessionInbound.operatorUnreadable", {
                    env: CROSS_SESSION_INBOUND_ENV_NAME,
                    value: inbound.operatorUnreadable,
                  })}
                </div>
              )}
              {/*
                The one thing the value alone cannot tell the user, and the
                reason this view deliberately does not read the two project
                files: they are per-project, they can only TIGHTEN, and a
                number true for one open workspace would be false for the
                next.
              */}
              <div>{t("settings.crossSessionInbound.scopeNote")}</div>
              {/*
                P6.866 — a stored value this host cannot read WARNS AND
                HOLDS. Said here with the offer to clear it, because the
                hold lasts until someone fixes the value and nothing else
                on this machine names it.

                P6.952 — and it is NOT
                `crossSessionInboundUnrecognizedSentence`
                (`@nessy-agent/shared/config/storage`), which is what the
                two diagnostic surfaces say. Measured: the third wording
                the row went looking for is this one and only this one —
                `SettingsConfigDoctorSection` re-words nothing, it renders
                `buildConfigDoctorReport`'s text, so it inherits the
                sentence through `validateConfig()` (P6.878/P6.939).

                Two reasons the constant does not move here, and both are
                properties of the MEDIUM rather than of the sentence. It
                is English-only, quoted verbatim from the vendor page, and
                this is a localized control. And its last clause — *"Set
                it to one of the values above"* — is advice for someone
                editing `config.json`; above this banner there is a
                dropdown, and below it a button that writes the fix.

                What the row's concern really is, and what IS closed: the
                doctor section renders on THIS page (mounted below About), so with
                a bad value both sentences are visible at once. They now
                agree on every fact they share — the same three accepted
                values by name, the same *held for your approval*, and the
                same quoted value, which was already shared through
                `describeUnrecognizedCrossSessionInbound` under the P6.868
                one-renderer rule (`inbound.unrecognized` is its output,
                `storage.ts`). `cross-session-inbound-selector.test.ts`
                pins that agreement in both directions.
              */}
              {inbound.unrecognized && (
                <div className="space-y-2 text-destructive">
                  <div>{t("settings.crossSessionInbound.unrecognized", {
                    value: inbound.unrecognized,
                  })}</div>
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => { void handleCrossSessionInboundChange(null) }}
                  >
                    {t("settings.crossSessionInbound.clear")}
                  </Button>
                </div>
              )}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* Tools */}
      <SettingsSection title={t("settings.tools.title")}>
        <SettingsCard>
          <SettingsToggle
            label={t("settings.tools.builtInBrowser")}
            description={t("settings.tools.builtInBrowserDesc")}
            checked={browserToolEnabled}
            onCheckedChange={handleBrowserToolEnabledChange}
          />
          {/* P6.564 — the download destination. Disabled while the
              environment holds the field, because a control that accepts
              a value it cannot apply is worse than an absent one. */}
          <SettingsInput
            label={t("settings.tools.downloadRoot")}
            description={t("settings.tools.downloadRootDesc")}
            value={downloadRootInput}
            onChange={setDownloadRootInput}
            onBlur={handleDownloadRootCommit}
            placeholder={t("settings.tools.downloadRootPlaceholder")}
            disabled={downloadPolicy?.rootFromEnv === true}
            action={(
              <Button
                variant="secondary"
                size="md"
                onClick={handleBrowseDownloadRoot}
                disabled={downloadPolicy?.rootFromEnv === true}
              >
                {t("settings.tools.downloadRootBrowse")}
              </Button>
            )}
            inCard
          />
          <SettingsToggle
            label={t("settings.tools.downloadAsk")}
            description={t("settings.tools.downloadAskDesc")}
            checked={downloadPolicy?.effectiveAsk === true}
            onCheckedChange={handleDownloadAskChange}
            disabled={downloadPolicy?.askFromEnv === true}
          />
          {(downloadPolicy?.rootFromEnv || downloadPolicy?.askFromEnv
            || (downloadPolicy?.problems.length ?? 0) > 0) && (
            <div className={CARD_NOTE_CLASS}>
              {downloadPolicy?.rootFromEnv && (
                <div>{t("settings.tools.downloadRootFromEnv", {
                  value: downloadPolicy.effectiveRoot || t("settings.tools.downloadRootDefault"),
                })}</div>
              )}
              {downloadPolicy?.askFromEnv && (
                <div>{t("settings.tools.downloadAskFromEnv")}</div>
              )}
              {downloadPolicy?.problems.map(problem => (
                <div key={problem} className="text-destructive">{problem}</div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Network */}
      <SettingsSection title={t("settings.network.title")}>
        <SettingsCard>
          <SettingsToggle
            label={t("settings.network.httpProxy")}
            description={t("settings.network.httpProxyDesc")}
            checked={proxyForm.enabled}
            onCheckedChange={(enabled) => setProxyForm(prev => ({ ...prev, enabled }))}
          />
          <SettingsToggle
            label={t("settings.network.useBundledCa")}
            description={t("settings.network.useBundledCaDesc")}
            checked={proxyForm.useBundledCa}
            onCheckedChange={(useBundledCa) => setProxyForm(prev => ({ ...prev, useBundledCa }))}
          />
          <SettingsInput
            label={t("settings.network.customCaPath")}
            value={proxyForm.tlsCaPath}
            onChange={(value) => setProxyForm(prev => ({ ...prev, tlsCaPath: value }))}
            placeholder={t("settings.network.customCaPathPlaceholder")}
            inCard
          />
          {proxyForm.enabled && (
            <>
              <SettingsInput
                label={t("settings.network.httpProxyLabel")}
                value={proxyForm.httpProxy}
                onChange={(value) => setProxyForm(prev => ({ ...prev, httpProxy: value }))}
                placeholder={t("settings.network.proxyPlaceholder")}
                inCard
              />
              <SettingsInput
                label={t("settings.network.httpsProxyLabel")}
                value={proxyForm.httpsProxy}
                onChange={(value) => setProxyForm(prev => ({ ...prev, httpsProxy: value }))}
                placeholder={t("settings.network.proxyPlaceholder")}
                inCard
              />
              <SettingsInput
                label={t("settings.network.bypassRules")}
                value={proxyForm.noProxy}
                onChange={(value) => setProxyForm(prev => ({ ...prev, noProxy: value }))}
                placeholder={t("settings.network.bypassPlaceholder")}
                inCard
              />
            </>
          )}
          {(isProxyDirty || proxyError) && (
            <SettingsCardFooter>
              {proxyError && (
                <span className="mr-auto text-label-sm text-destructive">{proxyError === 'proxyErrorProtocol' ? t("settings.network.proxyErrorProtocol") : proxyError === 'proxyErrorFormat' ? t("settings.network.proxyErrorFormat") : proxyError}</span>
              )}
              <Button
                variant="ghost"
                size="md"
                onClick={handleResetProxy}
                disabled={!isProxyDirty || isSavingProxy}
              >
                {t("common.reset")}
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={handleSaveProxy}
                disabled={!isProxyDirty || isSavingProxy}
              >
                {isSavingProxy ? (
                  <>
                    <Spinner />
                    {t("common.saving")}
                  </>
                ) : (
                  t("common.save")
                )}
              </Button>
            </SettingsCardFooter>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* About */}
      <SettingsSection title={t("settings.about.title")}>
        <SettingsCard>
          <SettingsRow label={t("settings.about.version")}>
            <div className="flex items-center gap-2">
              <span className="text-label text-secondary tabular-nums">
                {updateChecker.updateInfo?.currentVersion ?? t("common.loading")}
              </span>
              {isElectron && updateChecker.isDownloading && updateChecker.updateInfo?.latestVersion && (
                <div className="flex items-center gap-2 text-label-sm text-tertiary">
                  <Spinner />
                  <span>{t("settings.about.downloading", { version: updateChecker.updateInfo.latestVersion, percent: updateChecker.downloadProgress })}</span>
                </div>
              )}
            </div>
          </SettingsRow>
          {isElectron && (
            <SettingsRow label={t("settings.about.checkForUpdates")}>
              <Button
                variant="secondary"
                size="md"
                onClick={handleCheckForUpdates}
                disabled={isCheckingForUpdates || updatesManagedOff}
              >
                {isCheckingForUpdates ? (
                  <>
                    <Spinner />
                    {t("common.checking")}
                  </>
                ) : (
                  t("settings.about.checkNow")
                )}
              </Button>
            </SettingsRow>
          )}
          {/* The "Managed" indicator, in the shape the retention card
              already uses: the control is disabled and one note line
              says whose decision it was. */}
          {isElectron && updatesManagedOff && (
            <div className={CARD_NOTE_CLASS}>
              <div>{t("settings.about.updatesManaged")}</div>
              {updatesManagedSource && <div>{t(updatesManagedSource)}</div>}
            </div>
          )}
          {isElectron && !updatesManagedOff && updateChecker.isReadyToInstall && updateChecker.updateInfo?.latestVersion && (
            <SettingsRow label={t("settings.about.updateReady")}>
              <Button
                variant="primary"
                size="md"
                onClick={updateChecker.installUpdate}
              >
                {t("settings.about.restartToUpdate", { version: updateChecker.updateInfo.latestVersion })}
              </Button>
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* P6.168 — mounted here rather than as its own settings page.
          It is a read-only checkup about this installation, which is
          what this page already is, and a new page would cost a
          registry entry, an icon and a nav label for one section. */}
      <SettingsProvenanceSection workspaceId={activeWorkspaceId ?? undefined} />

      {/* P6.576 — the settings-file TIERS, directly under the per-family
          provenance above. The two answer different questions about the
          same files: provenance says which file supplied a family,
          this says whether the managed tiers are healthy at all. Both
          are read-only checkups about this installation (D12), which is
          why neither gets a page of its own. */}
      <SettingsConfigDoctorSection />

      {/* P6.451 — the third troubleshooting surface on this page, and
          the only one that acts. It sits last because it is what a user
          reaches for AFTER the two read-only checkups above have not
          explained the problem: unload every third-party thing and see
          whether the symptom survives. */}
      <SettingsSafeModeSection />
    </SettingsPage>
  )
}
