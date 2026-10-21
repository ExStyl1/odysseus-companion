/**
 * AiSettingsPage
 *
 * Unified AI settings page that consolidates all LLM-related configuration:
 * - Default connection, model, and thinking level
 * - Per-workspace overrides
 * - Connection management (add/edit/delete)
 *
 * Follows the Appearance settings pattern: app-level defaults + workspace overrides.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Skeleton } from '@/components/ui/skeleton'
import { loadAiSettings } from './ai-settings-loader'
import { Button, IconButton } from '@/components/ui/button'
import { RtkUpdateDialog } from "@/components/RtkUpdateDialog"
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { navigate, routes } from '@/lib/navigate'
import { describeConnectionInUseHolders } from '@/lib/connection-in-use-holders'
import { X, MoreHorizontal, Pencil, Trash2, Star, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, RefreshCcw, Settings2, MessageSquareMore, Zap, Clock, Check } from 'lucide-react'
import type { CredentialHealthStatus, CredentialHealthIssue } from '../../../shared/types'
import { Spinner, FullscreenOverlayBase, Tooltip, TooltipTrigger, TooltipContent, AnimatedCollapsibleContent } from '@nessy-agent/ui'
import { useSetAtom } from 'jotai'
import { useActionLabel } from '@/actions'
import { fullscreenOverlayOpenAtom } from '@/atoms/overlay'
import type { LlmConnectionWithStatus, OutputStyleOption, ThinkingLevel, WorkspaceSettings, WorkspaceInfo } from '../../../shared/types'
import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from '@nessy-agent/shared/agent/thinking-levels'
import { codexBedrockRegionMessage } from '@nessy-agent/shared/agent/bedrock-region'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
// TYPE-only, so the cycle this would otherwise form with `settings-pages.ts`
// (which imports this component) never exists at runtime.
import type { SettingsRouteProps } from './settings-pages'
import { resolveRouteConnectionAction } from './ai-settings-route-connection'
import {
  DropdownMenu, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  DropdownMenuSub,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'

import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsMenuSelectRow,
  SettingsToggle,
  SettingsTextarea,
} from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
// UB6.5 — the Decision model card (presentational; this page wires window.electronAPI into it).
// UB15.11 — v0.15.1's EXPANDER_ROW_CLASS lives beside the card, the one module both expanders read without a cycle.
import { DecisionModelCard, EXPANDER_ROW_CLASS } from './DecisionModelCard'
import type { DecisionLayerSettingsPatch } from '@nessy-agent/shared/decisions/settings'
import type { DecisionProviderId } from '@nessy-agent/shared/decisions/types'
import type { DecisionServerProbe, DecisionTestResult, DecisionToggleUsage } from '@nessy-agent/shared/decisions'
import { useOnboarding } from '@/hooks/useOnboarding'
import { useWorkspaceIcon } from '@/hooks/useWorkspaceIcon'
import { OnboardingWizard } from '@/components/onboarding'
import { canEditLlmConnection, isNessyGatewayConnection, type ApiKeyInitialValues } from '@/components/apisetup'
// Direct module import, not the `@/components/apisetup` barrel: the barrel does
// not re-export this one, and `byo-runtime.ts` already reaches for it the same
// way. **This is no longer a renderer twin of anything (DA1.31, 2026-09-14):**
// `components/apisetup/nessy-gateway.ts` re-binds the backend's own
// `isNessyGatewayBaseUrl` and `isGatewayBackedConnection`, taken from the DEEP
// path `…/agent/backend/internal/drivers/upstream-target` — never the
// `agent/backend` barrel, which also re-exports `createAgent` / `ClaudeAgent` /
// `PiAgent`, node-only subprocess and fs code no renderer module may pull in.
// So the rule that decides whether a session carries `Nestor-Token` and the rule
// that locks this page's Edit button are now one function.
//
// The history, because this comment has been wrong in both directions: DA1.11
// (2026-09-13) found it claiming the twin was "kept in sync by the shared
// `NESSY_GATEWAY_BASE_URL` literal" when no shared literal existed — the
// renderer hand-wrote the string the backend derives. DA1.28 (2026-09-14) made
// the string shared and DA1.31 the rule, so the original sentence is finally
// true, of a different mechanism than the one it described.
import { isNessyGatewayBaseUrl } from '@/components/apisetup/nessy-gateway'
import { byoRuntimeInitialValues, resolveConnectionEditTarget } from '@/components/apisetup/byo-runtime'
import { gatewayReconnectFailureNotice, useNessyGatewayAuth, type GatewayAuthPhase } from '@/hooks/useNessyGatewayAuth'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { getModelShortName, type ModelDefinition } from '@config/models'
import { getModelsForProviderType, resolveMidStreamBehavior, type CustomEndpointApi, type MidStreamBehavior } from '@config/llm-connections'
import { toast } from 'sonner'
import { describeManagedModelRefusal } from './managed-model-refusal'

/**
 * Compact token count: 1234 → "1.2K", 1234567 → "1.2M". Used by the RTK
 * efficiency meter. Locale-agnostic — the suffix is universal across the
 * 7 supported locales.
 */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * Derive model dropdown options from a connection's models array,
 * falling back to registry models for the connection's provider type.
 */
function getModelOptionsForConnection(
  connection: LlmConnectionWithStatus | undefined,
): Array<{ value: string; label: string; description: string; descriptionKey?: string }> {
  if (!connection) return []

  // If connection has explicit models, use those
  if (connection.models && connection.models.length > 0) {
    return connection.models.map((m) => {
      if (typeof m === 'string') {
        return { value: m, label: getModelShortName(m), description: '' }
      }
      // ModelDefinition object
      const def = m as ModelDefinition
      return { value: def.id, label: def.name, description: def.description, descriptionKey: def.descriptionKey }
    })
  }

  // Fall back to registry models for this provider type
  const registryModels = getModelsForProviderType(connection.providerType, connection.piAuthProvider)
  return registryModels.map((m) => ({
    value: m.id,
    label: m.name,
    description: m.description,
    descriptionKey: m.descriptionKey,
  }))
}

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'ai',
}

// ============================================
// Credential Health Warning Banner
// ============================================

/** Get user-friendly message for credential health issue */
function getHealthIssueMessage(issue: CredentialHealthIssue, t: (key: string) => string): string {
  switch (issue.type) {
    case 'file_corrupted':
      return t("settings.ai.credentialCorrupted")
    case 'decryption_failed':
      return t("settings.ai.credentialOtherMachine")
    case 'no_default_credentials':
      return t("settings.ai.credentialNotFound")
    default:
      return issue.message || 'Credential issue detected.'
  }
}

interface CredentialHealthBannerProps {
  issues: CredentialHealthIssue[]
  onReauthenticate: () => void
}

function CredentialHealthBanner({ issues, onReauthenticate }: CredentialHealthBannerProps) {
  const { t } = useTranslation()
  if (issues.length === 0) return null

  return (
    <div className="rounded-lg bg-info-tint px-3.5 py-3 inset-ring inset-ring-[var(--info-border)]">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-px size-4 shrink-0 text-info" aria-hidden />
        {/* The action wraps under the text when the panel is narrow */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
          <div className="min-w-[min(100%,14rem)] flex-1">
            <h4 className="text-label font-semibold text-foreground">
              {t("settings.ai.credentialIssue")}
            </h4>
            <p className="mt-0.5 text-label leading-5 text-secondary">
              {getHealthIssueMessage(issues[0], t)}
            </p>
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={onReauthenticate}
          >
            {t("settings.ai.reAuthenticate")}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================
// Pi Auth Provider Display Names
// ============================================

const PI_AUTH_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
  'openai-codex': 'OpenAI API',
  google: 'Google AI Studio',
  openrouter: 'OpenRouter',
  'azure-openai-responses': 'Azure OpenAI',
  'amazon-bedrock': 'Amazon Bedrock',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  cerebras: 'Cerebras',
  zai: 'z.ai',
  huggingface: 'Hugging Face',
  'vercel-ai-gateway': 'Vercel AI Gateway',
}

// ============================================
// Connection Row Component
// ============================================

type ValidationState = 'idle' | 'validating' | 'success' | 'error'

export interface GatewayReconnectItemView {
  /** i18n key for the menu item's label. */
  labelKey: string
  /** The flow is mid-run for THIS row — the item is disabled. */
  busy: boolean
}

/**
 * Whether a connection row offers **Reconnect**, and what the item says.
 * `null` = the row shows no such item. Pure so the rule is unit-tested without a
 * DOM, the way `computeGatewayBannerView` is; the phase → label mapping reuses
 * that banner's own keys so the two surfaces cannot word the same flow
 * differently.
 *
 * Membership is the URL rule the dp flow itself serves — `isNessyGatewayBaseUrl`,
 * a whole-URL match. A BYO connection cannot hold that URL: `byo-runtime.ts`
 * rejects it at validation (`endpointIsGateway`), so the URL alone identifies a
 * managed gateway card and no `canEditLlmConnection` test is needed on top.
 *
 * OAuth rows return `null` unconditionally. Gateway cards are
 * `api_key_with_endpoint`, so this cannot fire in practice — it is here to make
 * "Reconnect never replaces the OAuth row's own Re-authenticate item" a property
 * of this function rather than of the JSX ternary beside it.
 *
 * `reconnectPhase` is `null` for every row except the one whose flow is running:
 * the auth hook is driven by a GLOBAL `nessy:gatewayAuthStatus` event stream, so
 * a hook per row would light every gateway row up at once (and would also react
 * to the chat banner's flow). The page owns the single hook and names the slug.
 */
export function computeGatewayReconnectItem(
  connection: { authType?: string; baseUrl?: string },
  reconnectPhase: GatewayAuthPhase | null,
): GatewayReconnectItemView | null {
  if (connection.authType === 'oauth') return null
  if (!isNessyGatewayBaseUrl(connection.baseUrl)) return null
  switch (reconnectPhase) {
    case 'checking':
    case 'exchanging':
      return { labelKey: 'onboarding.gatewayConnect.connecting', busy: true }
    case 'waiting-browser':
      return { labelKey: 'onboarding.gatewayConnect.waitingBrowser', busy: true }
    default:
      return { labelKey: 'settings.ai.reconnect', busy: false }
  }
}

interface ConnectionRowProps {
  connection: LlmConnectionWithStatus
  isLastConnection: boolean
  onRenameClick: () => void
  onDelete: () => void
  onSetDefault: () => void
  onValidate: () => void
  onReauthenticate: () => void
  /** Run the one-click gateway auth flow for this connection (no form, no re-creation). */
  onReconnect: () => void
  onEdit: () => void
  onSetMidStreamBehavior: (behavior: MidStreamBehavior) => void
  validationState: ValidationState
  validationError?: string
  /**
   * The live phase of the gateway auth flow when THIS row started it, else null.
   * See {@link computeGatewayReconnectItem} for why the page owns the hook.
   */
  reconnectPhase: GatewayAuthPhase | null
  /** True when another OAuth connection resolves to the same Anthropic account (issue #838) */
  isDuplicateAccount?: boolean
}

/**
 * P6.480 — the one-message shortcut, shown beside the setting it overrides.
 *
 * `learn.chatgpt.com/docs/prompting.md`, verbatim (weak tier — a page, not the
 * codex source): *"The setting also shows the shortcut for using the other
 * behavior for one message without changing your default"*. So the hint belongs
 * HERE rather than in the composer: this is where a user meets the default and
 * learns it has an escape.
 *
 * Read from the registry, never written out, for two reasons. A user who
 * rebinds `chat.sendWithOtherFollowUp` must see what they bound; and one who
 * UNBINDS it sees nothing at all, because a shortcut nobody can press is worse
 * than no shortcut.
 */
function MidStreamOneMessageHint() {
  const { t } = useTranslation()
  const { hotkey } = useActionLabel('chat.sendWithOtherFollowUp')
  if (!hotkey) return null
  return (
    <div className="px-2 py-1.5 text-label-sm leading-snug text-tertiary">
      {t('settings.ai.midStream.oneMessageHint', { shortcut: hotkey })}
    </div>
  )
}

function ConnectionRow({ connection, isLastConnection, onRenameClick, onDelete, onSetDefault, onValidate, onReauthenticate, onReconnect, onEdit, onSetMidStreamBehavior, validationState, validationError, reconnectPhase, isDuplicateAccount }: ConnectionRowProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [piBaseUrl, setPiBaseUrl] = useState<string | undefined>(undefined)

  // Opening dialog/overlay flows directly from a dropdown item can race with
  // menu teardown and leave a transient interaction lock behind on some systems.
  // Force menu close first, then trigger action on next frame.
  const runAfterMenuClose = useCallback((action: () => void) => {
    setMenuOpen(false)
    requestAnimationFrame(() => {
      action()
    })
  }, [])

  // Load Pi provider base URL via IPC (Pi SDK can't run in renderer)
  useEffect(() => {
    const provider = connection.providerType
    if (provider === 'pi' && connection.piAuthProvider && !connection.baseUrl) {
      window.electronAPI.getPiProviderBaseUrl(connection.piAuthProvider).then(url => setPiBaseUrl(url))
    }
  }, [connection.providerType, connection.piAuthProvider, connection.baseUrl])

  // Build description with provider, default indicator, auth status, and validation state
  const getDescription = () => {
    // Show validation state if not idle
    if (validationState === 'validating') return t("settings.ai.validating")
    if (validationState === 'success') return t("settings.ai.connectionValid")
    if (validationState === 'error') return validationError || t("settings.ai.validationFailed")

    const parts: string[] = []

    // OAuth = subscription (Pro/Plus/Max), API key = API
    const provider = connection.providerType
    const isSubscription = connection.authType === 'oauth'
    switch (provider) {
      case 'anthropic': parts.push(isSubscription ? 'Anthropic Subscription' : 'Anthropic API'); break
      case 'pi': {
        // Show upstream provider name for API key connections (e.g. "Google AI Studio")
        const piLabel = !isSubscription && connection.piAuthProvider
          ? PI_AUTH_PROVIDER_LABELS[connection.piAuthProvider]
          : null
        parts.push(piLabel ?? 'Nessy Backend')
        break
      }
      case 'pi_compat':
        parts.push(connection.baseUrl?.toLowerCase().includes('manifest.build')
          ? 'Manifest'
          : 'Nessy Backend (Compatible)')
        break
      default: parts.push(provider || 'Unknown'); if (connection.codexBedrockRegion) { const region = codexBedrockRegionMessage(connection.codexBedrockRegion); parts.push(t(region.key, region.params)) } // F1.979 — the region codex's own Bedrock provider picks (owner 2026-09-26)
    }

    // Base URL for API key connections (show custom endpoint or default for provider)
    if (connection.authType !== 'oauth') {
      let endpoint = connection.baseUrl
      // Use default endpoints for standard providers if no custom baseUrl
      if (!endpoint) {
        if (provider === 'anthropic') endpoint = 'https://api.anthropic.com'
        else if (provider === 'pi' && connection.piAuthProvider) {
          endpoint = piBaseUrl
        }
      }
      if (endpoint) {
        // Extract hostname from URL for cleaner display
        try {
          const url = new URL(endpoint)
          parts.push(url.host)
        } catch {
          parts.push(endpoint)
        }
      }
    }

    // Auth status
    if (!connection.isAuthenticated) parts.push(t("settings.ai.notAuthenticated"))

    return parts.join(' · ')
  }

  // Resolved Anthropic identity (issue #838): render `email · org` independently of
  // validation state. It cannot live in getDescription() — that short-circuits for
  // validating/success/error and would hide the identity during those states.
  const oauthIdentityLine = connection.authType === 'oauth' && connection.oauthAccountEmail
    ? [connection.oauthAccountEmail, connection.oauthOrganizationName].filter(Boolean).join(' · ')
    : null

  const reconnectItem = computeGatewayReconnectItem(connection, reconnectPhase)

  return (
    <SettingsRow
      label={(
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-1">
            <ConnectionIcon connection={connection} size={14} />
            <span>{connection.name}</span>
            {connection.isDefault && (
              <span className="inline-flex h-5 items-center rounded-xs bg-fill-hover px-1.5 text-label-sm font-medium text-secondary">
                {t("common.default")}
              </span>
            )}
            {isDuplicateAccount && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center" aria-label={t("settings.ai.duplicateAccount")}>
                    <AlertTriangle className="size-3.5 text-info" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t("settings.ai.duplicateAccount")}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {oauthIdentityLine && (
            <span className="truncate text-label-sm font-normal text-tertiary">{oauthIdentityLine}</span>
          )}
        </div>
      )}
      description={getDescription()}
    >
      <DropdownMenu modal={false} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <IconButton
            aria-label={t("common.more")}
            data-state={menuOpen ? 'open' : 'closed'}
            icon={<MoreHorizontal className="size-4" />}
          />
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="end">
          <StyledDropdownMenuItem onClick={() => runAfterMenuClose(onRenameClick)}>
            <Pencil className="h-3.5 w-3.5" />
            <span>{t("common.rename")}</span>
          </StyledDropdownMenuItem>
          {!connection.isDefault && (
            <StyledDropdownMenuItem onClick={onSetDefault}>
              <Star className="h-3.5 w-3.5" />
              <span>{t("settings.ai.setAsDefault")}</span>
            </StyledDropdownMenuItem>
          )}
          {connection.authType === 'oauth' ? (
            <StyledDropdownMenuItem onClick={() => runAfterMenuClose(onReauthenticate)}>
              <RefreshCcw className="h-3.5 w-3.5" />
              <span>{t("settings.ai.reAuthenticate")}</span>
            </StyledDropdownMenuItem>
          ) : !canEditLlmConnection(connection) ? (
            // Managed cloud/gateway connections get no Edit: their endpoint and
            // credentials are owned by the built-in setup flow, not this form.
            null
          ) : (
            <StyledDropdownMenuItem onClick={() => runAfterMenuClose(onEdit)}>
              <Settings2 className="h-3.5 w-3.5" />
              <span>{t("common.edit")}</span>
            </StyledDropdownMenuItem>
          )}
          {/*
            Reconnect — a SIBLING of the branch above, never a replacement for it.
            Managed gateway cards are `api_key_with_endpoint` with
            `canEditLlmConnection === false`, so they reached neither arm of that
            ternary and their menu offered no way back from «Not authenticated».
            This runs the same one-click dp flow the chat banner runs; it does not
            open the API-setup form, because nothing here needs re-creating.
          */}
          {reconnectItem && (
            <StyledDropdownMenuItem
              onClick={() => runAfterMenuClose(onReconnect)}
              disabled={reconnectItem.busy}
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              <span>{t(reconnectItem.labelKey)}</span>
            </StyledDropdownMenuItem>
          )}
          <StyledDropdownMenuItem
            onClick={onValidate}
            disabled={validationState === 'validating'}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>{t("settings.ai.validateConnection")}</span>
          </StyledDropdownMenuItem>
          {(() => {
            const currentBehavior = resolveMidStreamBehavior(connection)
            return (
              <DropdownMenuSub>
                <StyledDropdownMenuSubTrigger>
                  <MessageSquareMore className="h-3.5 w-3.5" />
                  <span>{t("settings.ai.midStream.title")}</span>
                </StyledDropdownMenuSubTrigger>
                <StyledDropdownMenuSubContent>
                  <StyledDropdownMenuItem onClick={() => onSetMidStreamBehavior('steer')}>
                    <Zap className="h-3.5 w-3.5" />
                    <span className="flex-1">{t("settings.ai.midStream.steer")}</span>
                    {currentBehavior === 'steer' && <Check className="h-3.5 w-3.5" />}
                  </StyledDropdownMenuItem>
                  <StyledDropdownMenuItem onClick={() => onSetMidStreamBehavior('queue')}>
                    <Clock className="h-3.5 w-3.5" />
                    <span className="flex-1">{t("settings.ai.midStream.queue")}</span>
                    {currentBehavior === 'queue' && <Check className="h-3.5 w-3.5" />}
                  </StyledDropdownMenuItem>
                  {/*
                    P6.480 — the affordance the page describes BESIDE the
                    setting: *"The setting also shows the shortcut for using the
                    other behavior for one message without changing your
                    default"*. The chord is read from the registry rather than
                    written out, so a user who rebinds it sees what they bound;
                    absent when they have UNBOUND it, because printing a
                    shortcut nobody can press is worse than printing none.
                  */}
                  <MidStreamOneMessageHint />
                </StyledDropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })()}
          <StyledDropdownMenuSeparator />
          <StyledDropdownMenuItem
            onClick={onDelete}
            variant="destructive"
            disabled={isLastConnection}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t("common.delete")}</span>
          </StyledDropdownMenuItem>
        </StyledDropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  )
}

// ============================================
// Workspace Override Card Component
// ============================================

interface WorkspaceOverrideCardProps {
  workspace: WorkspaceInfo
  llmConnections: LlmConnectionWithStatus[]
  onSettingsChange: () => void
}

const WORKSPACE_SETTING_LABELS: Partial<Record<keyof WorkspaceSettings, string>> = {
  defaultLlmConnection: 'workspace connection override',
  model: 'workspace model override',
  thinkingLevel: 'workspace thinking override',
}

function WorkspaceOverrideCard({ workspace, llmConnections, onSettingsChange }: WorkspaceOverrideCardProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Fetch workspace icon as data URL (file:// URLs don't work in renderer)
  const iconUrl = useWorkspaceIcon(workspace)

  // Load workspace settings
  useEffect(() => {
    const loadSettings = async () => {
      if (!window.electronAPI) return
      setIsLoading(true)
      try {
        const ws = await window.electronAPI.getWorkspaceSettings(workspace.id)
        setSettings(ws)
      } catch (error) {
        console.error('Failed to load workspace settings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    loadSettings()
  }, [workspace.id])

  // Save workspace setting helper (optimistic update with rollback)
  const updateSetting = useCallback(async <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
    if (!window.electronAPI) return

    const previousValue = settings?.[key]

    // Optimistic UI update for immediate feedback
    setSettings(prev => prev ? { ...prev, [key]: value } : prev)

    try {
      await window.electronAPI.updateWorkspaceSetting(workspace.id, key, value)
      onSettingsChange()
    } catch (error) {
      // Roll back only the changed key
      setSettings(prev => prev ? { ...prev, [key]: previousValue } : prev)

      const message = error instanceof Error ? error.message : 'Unknown error'
      const settingLabel = WORKSPACE_SETTING_LABELS[key] ?? String(key)
      console.error(`Failed to save ${String(key)}:`, error)
      toast.error(t("toast.failedToSaveSetting", { setting: settingLabel }), {
        description: message,
      })
    }
  }, [workspace.id, onSettingsChange, settings])

  const handleConnectionChange = useCallback((slug: string) => {
    // 'global' means use app default (clear workspace override)
    updateSetting('defaultLlmConnection', slug === 'global' ? undefined : slug)
  }, [updateSetting])

  const handleModelChange = useCallback((model: string) => {
    // 'global' means use app default (clear workspace override)
    updateSetting('model', model === 'global' ? undefined : model)
  }, [updateSetting])

  const handleThinkingChange = useCallback((level: string) => {
    // 'global' means use app default (clear workspace override)
    updateSetting('thinkingLevel', level === 'global' ? undefined : level as ThinkingLevel)
  }, [updateSetting])

  // Determine if workspace has any overrides
  const hasOverrides = settings && (
    settings.defaultLlmConnection ||
    settings.model ||
    settings.thinkingLevel
  )

  // Get display values
  const currentConnection = settings?.defaultLlmConnection || 'global'
  const currentModel = settings?.model || 'global'
  const currentThinking = settings?.thinkingLevel || 'global'

  // Derive workspace's effective connection (override or default)
  const workspaceEffectiveConnection = useMemo(() => {
    const connSlug = settings?.defaultLlmConnection
    return connSlug ? llmConnections.find(c => c.slug === connSlug) : llmConnections.find(c => c.isDefault)
  }, [settings?.defaultLlmConnection, llmConnections])

  // Get summary text for collapsed state
  const getSummary = () => {
    if (!hasOverrides) return t("settings.ai.usingDefaults")
    const parts: string[] = []
    if (settings?.defaultLlmConnection) {
      const conn = llmConnections.find(c => c.slug === settings.defaultLlmConnection)
      parts.push(conn?.name || settings.defaultLlmConnection)
    }
    if (settings?.model) {
      parts.push(getModelShortName(settings.model))
    }
    if (settings?.thinkingLevel) {
      const level = THINKING_LEVELS.find(l => l.id === settings.thinkingLevel)
      parts.push(level ? t(level.nameKey) : settings.thinkingLevel)
    }
    return parts.join(' · ')
  }

  // One row of the shared overrides card (the parent's SettingsCard draws the hairlines between
  // workspaces); the collapsible body is always mounted and draws its own top hairline when open.
  return (
    <div>
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded(!isExpanded)}
        className={EXPANDER_ROW_CLASS}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              'size-6 shrink-0 rounded-full overflow-hidden bg-fill-hover flex items-center justify-center',
              'ring-1 ring-border'
            )}
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-caption text-secondary">
                {workspace.name?.charAt(0)?.toUpperCase() || 'W'}
              </span>
            )}
          </div>
          <div className="min-w-0 text-left">
            <div className={settingsUI.label}>{workspace.name}</div>
            <div className={cn(settingsUI.description, '[overflow-wrap:anywhere]')}>
              {isLoading ? t("common.loading") : getSummary()}
            </div>
          </div>
        </div>
        {isExpanded ? (
          <ChevronDown className="size-4 shrink-0 text-tertiary" aria-hidden />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-tertiary" aria-hidden />
        )}
      </button>

      {/* Expands in place: content swaps once, fades with a 4px drop (no height animation) */}
      <AnimatedCollapsibleContent isOpen={isExpanded}>
            <div className="border-t border-subtle py-1 pl-9">
              <SettingsMenuSelectRow
                label={t("settings.ai.connection")}
                description={t("settings.ai.connectionDesc")}
                value={currentConnection}
                onValueChange={handleConnectionChange}
                options={[
                  { value: 'global', label: t("settings.ai.useDefault"), description: t("settings.ai.inheritFromApp") },
                  ...llmConnections.map((conn) => ({
                    value: conn.slug,
                    label: conn.name,
                    description: conn.providerType === 'anthropic' ? 'Anthropic' :
                                 conn.providerType === 'pi' ? 'Nessy Backend' :
                                 conn.providerType === 'codex-runtime' || conn.providerType === 'claude-runtime'
                                   ? runtimeConnectionLabel(conn) :
                                 conn.providerType || 'Unknown',
                  })),
                ]}
              />
              <SettingsMenuSelectRow
                label={t("settings.ai.model")}
                description={t("settings.ai.modelDesc")}
                value={currentModel}
                onValueChange={handleModelChange}
                options={[
                  { value: 'global', label: t("settings.ai.useDefault"), description: t("settings.ai.inheritFromApp") },
                  ...getModelOptionsForConnection(workspaceEffectiveConnection).map(o => ({
                    ...o, description: o.descriptionKey ? t(o.descriptionKey) : o.description,
                  })),
                ]}
              />
              <SettingsMenuSelectRow
                label={t("settings.ai.thinking")}
                description={t("settings.ai.thinkingDesc")}
                value={currentThinking}
                onValueChange={handleThinkingChange}
                options={[
                  { value: 'global', label: t("settings.ai.useDefault"), description: t("settings.ai.inheritFromApp") },
                  ...THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => ({
                    value: id,
                    label: t(nameKey),
                    description: t(descriptionKey),
                  })),
                ]}
              />
            </div>
      </AnimatedCollapsibleContent>
    </div>
  )
}

// ============================================
// Helpers
// ============================================

/**
 * Row subtitle for a `codex-runtime` / `claude-runtime` connection.
 *
 * One providerType now covers two products: the one-click gateway card and a
 * BYO custom endpoint (C3). The label reads the endpoint rather than the
 * providerType, so a user's own proxy is not announced as the corp gateway.
 */
function runtimeConnectionLabel(conn: { providerType?: string; baseUrl?: string }): string {
  const harness = conn.providerType === 'claude-runtime' ? 'Claude Code' : 'Codex'
  return isNessyGatewayConnection(conn) ? `${harness} (Nessy Gateway)` : `${harness} (Custom Endpoint)`
}

// ============================================
// Main Component
// ============================================

export default function AiSettingsPage({ connectionSlug }: SettingsRouteProps) {
  const { t } = useTranslation()
  const { llmConnections, refreshLlmConnections, activeWorkspaceId } = useAppShellContext()

  // API Setup overlay state
  const [showApiSetup, setShowApiSetup] = useState(false)
  const [editingConnectionSlug, setEditingConnectionSlug] = useState<string | null>(null)
  const [isDirectEdit, setIsDirectEdit] = useState(false)
  const [editInitialValues, setEditInitialValues] = useState<ApiKeyInitialValues | undefined>(undefined)
  const setFullscreenOverlayOpen = useSetAtom(fullscreenOverlayOpenAtom)

  // Workspaces for override cards
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])

  // Default settings state (app-level)
  const [defaultThinking, setDefaultThinking] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL)
  const [outputStyle, setOutputStyle] = useState('default')
  const [outputStyleOptions, setOutputStyleOptions] = useState<OutputStyleOption[]>([])
  const [extendedPromptCache, setExtendedPromptCache] = useState(false)
  const [rtkEnabled, setRtkEnabled] = useState(false)
  // UB7.4 — the detector's shape grew: `outdated` (older than the safe minimum), `minSafeVersion`, `foundPath`.
  const [rtkStatus, setRtkStatus] = useState<{ installed: boolean; path: string | null; version: string | null; outdated: boolean; minSafeVersion: string; foundPath: string | null } | null>(null)
  const [rtkRechecking, setRtkRechecking] = useState(false)
  const [rtkDialogOpen, setRtkDialogOpen] = useState(false)
  const [rtkGain, setRtkGain] = useState<{ totalCommands: number; totalInput: number; totalOutput: number; totalSaved: number; avgSavingsPct: number; totalTimeMs: number; avgTimeMs: number } | null>(null)
  // ---- UB6.5 Decision model (Jev) state ----
  const [decisionStatus, setDecisionStatus] = useState<Awaited<ReturnType<NonNullable<typeof window.electronAPI>['getDecisionLayerStatus']>> | null>(null)
  const [decisionUsage, setDecisionUsage] = useState<Partial<Record<string, DecisionToggleUsage>>>({})
  const [decisionTestResult, setDecisionTestResult] = useState<DecisionTestResult | null>(null)
  const [decisionTesting, setDecisionTesting] = useState(false)
  const [decisionProbe, setDecisionProbe] = useState<DecisionServerProbe | null>(null)
  const [decisionProbing, setDecisionProbing] = useState(false)
  const [decisionAdvancedOpen, setDecisionAdvancedOpen] = useState(false)
  const [decisionModelDraft, setDecisionModelDraft] = useState('')
  const [decisionBaseUrlDraft, setDecisionBaseUrlDraft] = useState('')
  const [decisionKeyDraft, setDecisionKeyDraft] = useState('')
  const decisionDraftsSeededRef = useRef(false)
  const [guardianEnabled, setGuardianEnabled] = useState(true)
  // '' = the gateway `fast` alias default; any other value = an explicit model id.
  const [guardianModel, setGuardianModel] = useState('')
  /**
   * The judge model PER INTEGRATION (H1) — one global id could not serve every
   * connection, because entitlement varies per key and a model that judges fine
   * on one 403s on another.
   */
  const [guardianModels, setGuardianModels] = useState<Record<string, string>>({})
  const [guardianConnection, setGuardianConnection] = useState('')

  /**
   * P6.122 — the advisor ran on a model the user could neither choose nor
   * switch off: all four channels (`getAdvisorEnabled`/`setAdvisorEnabled`,
   * `getAdvisorModel`/`setAdvisorModel`) had no consumer in the renderer, while
   * `AdvisorConsultationCard` was already naming the advising model in the chat.
   *
   * ONE global id, not a per-connection map like guardian's: the advisor
   * consults on the SESSION's own connection, so the id is a preference the
   * per-session resolver then has to clear. `''` is the documented default —
   * the session's own model advises — and it is also the always-reachable way
   * out, since no allowlist can forbid the model the session is already using.
   */
  const [advisorEnabled, setAdvisorEnabled] = useState(false)
  const [advisorModel, setAdvisorModel] = useState('')

  /**
   * Codex's own approval reviewer (P6.225).
   *
   * The policy is free TEXT, not a model id, so there is no picker and no
   * managed refusal to roll back from — the only two states are "codex's own
   * policy unchanged" (`''`, the documented default) and whatever the operator
   * appends to it.
   */
  const [codexAutoReviewEnabled, setCodexAutoReviewEnabled] = useState(false)
  const [codexAutoReviewPolicy, setCodexAutoReviewPolicy] = useState('')
  // C3.286 — codex's own delegation off-switch. Seeded `true`, which is codex's
  // own default, so the toggle never flickers off before the read lands.
  const [codexSubagentsEnabled, setCodexSubagentsEnabled] = useState(true)

  // Validation state per connection
  const [validationStates, setValidationStates] = useState<Record<string, {
    state: ValidationState
    error?: string
  }>>({})

  // Reveal the initial settings and health banner together; never insert sections above controls.
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [credentialHealthIssues, setCredentialHealthIssues] = useState<CredentialHealthIssue[]>([])

  /**
   * ONE gateway-auth hook for the whole page, plus the slug that started the run.
   *
   * The hook subscribes to the global `nessy:gatewayAuthStatus` stream, so an
   * instance per `ConnectionRow` would put every gateway row into the same
   * in-progress state at once — and would light them up for a flow the chat
   * banner started, too. Owning it here and naming the slug keeps the
   * in-progress label on the row the user actually clicked.
   */
  const { phase: gatewayAuthPhase, ensure: ensureGatewayAuth, authUrl: gatewayAuthUrl } = useNessyGatewayAuth()
  const [reconnectingSlug, setReconnectingSlug] = useState<string | null>(null)
  useGatewayAuthUrlToast(gatewayAuthUrl, reconnectingSlug !== null, t)
  // Rename dialog state
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renamingConnection, setRenamingConnection] = useState<{ slug: string; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Load workspaces, default settings, and credential health as ONE snapshot (v0.15.1 `loadAiSettings`; our pick
  // is in `ai-settings-loader.ts`). Until it lands the page shows its skeleton, so no section is inserted above a
  // control the user can already see.
  useEffect(() => {
    let cancelled = false
    setSettingsLoading(true)
    loadAiSettings(window.electronAPI, refreshLlmConnections, activeWorkspaceId ?? undefined).then((settings) => {
      if (cancelled) return
      setWorkspaces(settings.workspaces)
      setDefaultThinking(settings.thinking)
      setOutputStyle(settings.outputStyle)
      setOutputStyleOptions(settings.outputStyles)
      setExtendedPromptCache(settings.extendedCache)
      setRtkEnabled(settings.rtkEnabled)
      setRtkStatus(settings.rtkStatus)
      setGuardianEnabled(settings.guardianEnabled)
      setGuardianModel(settings.guardianModel)
      setGuardianModels(settings.guardianModels)
      setAdvisorEnabled(settings.advisorEnabled)
      setAdvisorModel(settings.advisorModel)
      setCodexAutoReviewEnabled(settings.codexAutoReviewEnabled)
      setCodexAutoReviewPolicy(settings.codexAutoReviewPolicy)
      setCodexSubagentsEnabled(settings.codexSubagentsEnabled)
      setCredentialHealthIssues(settings.health.healthy ? [] : settings.health.issues)
    }).catch((error) => {
      if (!cancelled) console.error('Failed to load settings:', error)
    }).finally(() => {
      if (!cancelled) setSettingsLoading(false)
    })
    return () => { cancelled = true }
  }, [activeWorkspaceId, refreshLlmConnections])

  // Helpers to open/close the fullscreen API setup overlay
  const openApiSetup = useCallback((connectionSlug?: string) => {
    setEditingConnectionSlug(connectionSlug || null)
    setShowApiSetup(true)
    setFullscreenOverlayOpen(true)
  }, [setFullscreenOverlayOpen])

  const closeApiSetup = useCallback(() => {
    setShowApiSetup(false)
    setFullscreenOverlayOpen(false)
    setEditingConnectionSlug(null)
  }, [setFullscreenOverlayOpen])

  // Derive existing slugs for unique slug generation
  const existingSlugs = useMemo(
    () => new Set(llmConnections.map(c => c.slug)),
    [llmConnections],
  )

  // OnboardingWizard hook for editing API connection
  const apiSetupOnboarding = useOnboarding({
    initialStep: 'provider-select',
    onConfigSaved: refreshLlmConnections,
    onComplete: () => {
      closeApiSetup()
      refreshLlmConnections?.()
      apiSetupOnboarding.reset()
    },
    onDismiss: () => {
      closeApiSetup()
      apiSetupOnboarding.reset()
    },
    editingSlug: editingConnectionSlug,
    existingSlugs,
  })

  const handleApiSetupFinish = useCallback(() => {
    closeApiSetup()
    refreshLlmConnections?.()
    apiSetupOnboarding.reset()
    // Clear any credential health issues after successful re-authentication
    setCredentialHealthIssues([])
    setIsDirectEdit(false)
    setEditInitialValues(undefined)
  }, [closeApiSetup, refreshLlmConnections, apiSetupOnboarding])

  // Handler for closing the modal via X button or Escape - resets state and cancels OAuth
  const handleCloseApiSetup = useCallback(() => {
    closeApiSetup()
    apiSetupOnboarding.reset()
    setIsDirectEdit(false)
    setEditInitialValues(undefined)
  }, [closeApiSetup, apiSetupOnboarding])

  /**
   * The one-click gateway re-auth, shared by the row menu's Reconnect item and
   * the credential-health banner. Never opens the API-setup form: the dp flow
   * rewrites the shared credential file and the connection itself is untouched.
   */
  const handleReconnectGateway = useCallback(async (slug: string) => {
    setReconnectingSlug(slug)
    try {
      const result = await ensureGatewayAuth()
      if (!result?.ok) { toastGatewayReconnectFailure(result, t); return }
      // Clear «Not authenticated» in place — no navigation, no re-creation.
      await refreshLlmConnections?.()
      // Re-READ health rather than assuming the banner's issue is gone: the dp
      // flow writes ~/.nessy/dp_auth_creds.json, which is not the encrypted
      // credential store `file_corrupted` / `decryption_failed` report on.
      try {
        const health = await window.electronAPI.getCredentialHealth()
        setCredentialHealthIssues(health.healthy ? [] : health.issues)
      } catch {
        // Leave the banner as it was; the connection list already refreshed.
      }
    } finally {
      setReconnectingSlug(null)
    }
  }, [ensureGatewayAuth, refreshLlmConnections, t])

  // Handler for re-authenticate button in credential health banner
  const handleReauthenticate = useCallback(() => {
    // Open API setup for the default connection (or first connection if available)
    const defaultConn = llmConnections.find(c => c.isDefault) || llmConnections[0]
    // A gateway-backed connection has no form to fill in — same one-click path as
    // the row menu. `openApiSetup` stays for connections that genuinely need it.
    if (defaultConn && computeGatewayReconnectItem(defaultConn, null)) {
      void handleReconnectGateway(defaultConn.slug)
      return
    }
    if (defaultConn) {
      openApiSetup(defaultConn.slug)
    } else {
      openApiSetup()
    }
  }, [llmConnections, openApiSetup, handleReconnectGateway])

  // Connection action handlers
  const handleRenameClick = useCallback((connection: LlmConnectionWithStatus) => {
    setRenamingConnection({ slug: connection.slug, name: connection.name })
    setRenameValue(connection.name)
    // Defer dialog open to next frame to let dropdown fully unmount first
    requestAnimationFrame(() => {
      setRenameDialogOpen(true)
    })
  }, [])

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingConnection || !window.electronAPI) return
    const trimmedName = renameValue.trim()
    if (!trimmedName || trimmedName === renamingConnection.name) {
      setRenameDialogOpen(false)
      return
    }
    try {
      // Get the full connection, update name, and save
      const connection = await window.electronAPI.getLlmConnection(renamingConnection.slug)
      if (connection) {
        const result = await window.electronAPI.saveLlmConnection({ ...connection, name: trimmedName })
        if (result.success) {
          refreshLlmConnections?.()
        } else {
          console.error('Failed to rename connection:', result.error)
        }
      }
    } catch (error) {
      console.error('Failed to rename connection:', error)
    }
    setRenameDialogOpen(false)
    setRenamingConnection(null)
    setRenameValue('')
  }, [renamingConnection, renameValue, refreshLlmConnections])

  const handleReauthenticateConnection = useCallback((connection: LlmConnectionWithStatus) => {
    openApiSetup(connection.slug)
    apiSetupOnboarding.reset()

    if (connection.authType === 'oauth') {
      const method = connection.providerType === 'pi' ? 'pi_chatgpt_oauth'
                   : connection.providerType === 'codex-runtime' ? 'codex_chatgpt_oauth' // F1.202 — the codex ChatGPT card
                   : 'claude_oauth'
      apiSetupOnboarding.handleStartOAuth(method, connection.slug)
    }
  }, [apiSetupOnboarding, openApiSetup])

  const handleEditConnection = useCallback(async (connection: LlmConnectionWithStatus) => {
    if (!canEditLlmConnection(connection)) return

    // Fetch stored API key (best-effort — if IPC not available yet, skip pre-fill)
    let apiKey: string | undefined
    try {
      apiKey = (await window.electronAPI.getLlmConnectionApiKey(connection.slug)) ?? undefined
    } catch {
      // IPC method may not exist if app wasn't restarted after code change
    }

    // Which setup surface to open. Getting this wrong is a data bug, not a
    // navigation one: every non-Pi connection used to go to the
    // `anthropic_api_key` form, whose submit attaches a `customEndpoint`, and
    // the SETUP handler rewrites `providerType` to `pi_compat` whenever one is
    // present — so editing a `codex-runtime`/`claude-runtime` connection
    // silently converted it off its runtime and the local adapter stopped
    // starting (C3). The mapping lives in `apisetup/byo-runtime.ts`, tested.
    const editTarget = resolveConnectionEditTarget(connection)
    if (editTarget.form === 'byo-runtime' || editTarget.form === 'merged') {
      setEditInitialValues(undefined)
      openApiSetup(connection.slug)
      setIsDirectEdit(true)
      apiSetupOnboarding.jumpToByoRuntime({
        providerType: editTarget.form === 'merged' ? 'pi' : editTarget.providerType,
        // Explicit: `openApiSetup` above only SCHEDULES the hook's own
        // editingSlug, so it is not readable from inside this tick.
        editingSlug: connection.slug,
        initialValues: {
          ...byoRuntimeInitialValues(connection, apiKey),
          ...(editTarget.form === 'merged' ? { preset: editTarget.preset } : {}),
          ...(connection.customEndpoint?.api ? { customApi: connection.customEndpoint.api } : {}),
          ...(connection.miniModel ? { miniModel: connection.miniModel } : {}),
          // The sync-toggle prefill (E2/E4). Derived from the STAMP's presence,
          // which is the enrollment marker — this is the AiSettingsPage gap the
          // plan names: the toggle previously came up off on every edit, so a
          // save of any other field silently withdrew the enrollment.
          syncModelsFromEndpoint: connection.modelsSyncedAt != null,
        },
      })
      return
    }

    // Build model string from connection's models array
    const modelStr = connection.models
      ?.map((m: string | ModelDefinition) => typeof m === 'string' ? m : m.id)
      .join(', ') || connection.defaultModel || ''

    // Set initial values before opening overlay so ApiKeyInput mounts with them
    const modelIds = connection.models
      ?.map((m: string | ModelDefinition) => typeof m === 'string' ? m : m.id)
      .filter(Boolean)

    const isCustomEndpointConnection = !!connection.customEndpoint && !!connection.baseUrl?.trim()

    setEditInitialValues({
      apiKey,
      baseUrl: connection.baseUrl,
      connectionDefaultModel: modelStr,
      activePreset: isCustomEndpointConnection ? 'custom' : (connection.piAuthProvider || undefined),
      models: modelIds,
      customApi: connection.customEndpoint?.api,
    })

    // Open overlay and jump directly to credentials step (no reset — jumpToCredentials sets state)
    openApiSetup(connection.slug)
    setIsDirectEdit(true)
    // Only the legacy surface reaches here now — `merged` and `byo-runtime`
    // both returned above. This is the exotic-connection fallback: an arm the
    // merged form cannot express (Bedrock IAM, the 3-tier openrouter shape).
    apiSetupOnboarding.jumpToCredentials(editTarget.method)
  }, [apiSetupOnboarding, openApiSetup])

  /**
   * D1.254 — THE CONNECTION THE ROUTE NAMES, RE-AUTHENTICATED ONCE.
   *
   * Until this effect existed, `settings/ai` was the most precise thing any
   * other surface could ask for: the setup overlay is local state here
   * (`showApiSetup` + `editingConnectionSlug`), so a chat card offering *Update
   * credentials* could only land the user on this page and leave them to find
   * the row. `routes.view.settings('ai', slug)` is the segment; this is the
   * whole of its consumer.
   *
   * IT DISPATCHES THE SAME TWO HANDLERS THE PAGE'S OWN BUTTONS DO, and picks
   * between them the way the credential-health banner does: a gateway-backed
   * connection has no form to fill in and takes the one-click dp flow, and
   * everything else opens the setup (which starts the OAuth flow by itself for
   * an OAuth row). Inventing a third path here would be a second opinion about a
   * decision the page already has one of.
   *
   * THEN IT DROPS THE SEGMENT, which is what makes the route a request rather
   * than a place: without this the second press of the same button would be a
   * navigation to the route the panel is already on, no state would change, and
   * nothing would happen. The write goes to the focused panel — the panel the
   * gesture that produced this route was made in, in every case that can reach
   * here — and a panel that is not focused would keep the segment and simply not
   * re-fire, which is the same behaviour as before the segment existed.
   *
   * AN UNKNOWN SLUG DOES NOTHING AT ALL, deliberately: `llmConnections` arrives
   * asynchronously, so a missing entry means "not loaded yet" as often as it
   * means "deleted", and the effect re-runs when the list lands.
   */
  const consumedRouteConnectionRef = useRef<string | null>(null)
  useEffect(() => {
    const action = resolveRouteConnectionAction(
      connectionSlug,
      consumedRouteConnectionRef.current,
      llmConnections,
    )
    if (action.kind === 'forget') {
      consumedRouteConnectionRef.current = null
      return
    }
    if (action.kind === 'idle') return
    consumedRouteConnectionRef.current = action.connection.slug
    if (action.kind === 'gateway') {
      void handleReconnectGateway(action.connection.slug)
    } else {
      handleReauthenticateConnection(action.connection)
    }
    navigate(routes.view.settings('ai'))
  }, [connectionSlug, llmConnections, handleReauthenticateConnection, handleReconnectGateway])

  const handleDeleteConnection = useCallback(async (slug: string) => {
    if (!window.electronAPI) return
    try {
      const result = await window.electronAPI.deleteLlmConnection(slug)
      if (result.success) {
        refreshLlmConnections?.()
      } else {
        console.error('Failed to delete connection:', result.error)
      }
    } catch (error) {
      // The server refuses while a live session or an automation still names
      // this connection — otherwise the delete would move them onto the
      // workspace default, on a different runtime, in silence. A refusal the
      // user cannot see is a Delete button that does nothing, so branch on the
      // wire CODE (the transport rebuilds a plain Error on this side, so the
      // class is gone) exactly as the model picker does.
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'CONNECTION_IN_USE') {
        // D1.150 — and the names beside the sentence, when the wire carried
        // them. The refusal's own English message is NOT used here and never
        // was: the sentence is built from locale keys, so C3.368's holder names
        // reached nobody on this surface. They arrive as `error.data` now, and
        // `describeConnectionInUseHolders` renders the labels in the user's
        // language while printing the user's own chat and task names verbatim.
        //
        // ADDED to the existing copy rather than replacing it: one sending hop
        // still drops the field (see that module's header), so a `null` here is
        // the ordinary case today and the toast must read exactly as it did.
        const holders = describeConnectionInUseHolders((error as { data?: unknown } | null)?.data, t)
        toast.warning(t('settings.ai.connectionInUse'), {
          description: holders
            ? `${t('settings.ai.connectionInUseDesc')}\n${holders}`
            : t('settings.ai.connectionInUseDesc'),
        })
        return
      }
      console.error('Failed to delete connection:', error)
    }
  }, [refreshLlmConnections, t])

  const handleValidateConnection = useCallback(async (slug: string) => {
    if (!window.electronAPI) return

    // Set validating state
    setValidationStates(prev => ({ ...prev, [slug]: { state: 'validating' } }))

    try {
      const result = await window.electronAPI.testLlmConnection(slug)

      if (result.success) {
        setValidationStates(prev => ({ ...prev, [slug]: { state: 'success' } }))
        // Auto-clear success state after 3 seconds
        setTimeout(() => {
          setValidationStates(prev => ({ ...prev, [slug]: { state: 'idle' } }))
        }, 3000)
      } else {
        setValidationStates(prev => ({
          ...prev,
          [slug]: { state: 'error', error: result.error }
        }))
        // Auto-clear error state after 5 seconds
        setTimeout(() => {
          setValidationStates(prev => ({ ...prev, [slug]: { state: 'idle' } }))
        }, 5000)
      }
    } catch (error) {
      setValidationStates(prev => ({
        ...prev,
        [slug]: { state: 'error', error: t("settings.ai.validationFailed") }
      }))
      setTimeout(() => {
        setValidationStates(prev => ({ ...prev, [slug]: { state: 'idle' } }))
      }, 5000)
    }
  }, [t])

  const handleSetDefaultConnection = useCallback(async (slug: string) => {
    if (!window.electronAPI) return
    try {
      const result = await window.electronAPI.setDefaultLlmConnection(slug)
      if (result.success) {
        refreshLlmConnections?.()
      } else {
        console.error('Failed to set default connection:', result.error)
      }
    } catch (error) {
      console.error('Failed to set default connection:', error)
    }
  }, [refreshLlmConnections])

  // Update a connection's mid-stream send behavior (steer vs queue).
  // Uses the same saveLlmConnection RPC as other connection edits.
  const handleSetMidStreamBehavior = useCallback(async (
    connection: LlmConnectionWithStatus,
    behavior: MidStreamBehavior,
  ) => {
    if (!window.electronAPI) return
    if (resolveMidStreamBehavior(connection) === behavior) return
    try {
      const updated = { ...connection, midStreamBehavior: behavior }
      const { isAuthenticated: _a, authError: _b, isDefault: _c, ...connectionData } = updated
      const result = await window.electronAPI.saveLlmConnection(connectionData as import('../../../shared/types').LlmConnection)
      if (result.success) {
        refreshLlmConnections?.()
      } else {
        console.error('Failed to update mid-stream behavior:', result.error)
        toast.error(t('settings.ai.midStream.updateFailed'))
      }
    } catch (error) {
      console.error('Failed to update mid-stream behavior:', error)
      toast.error(t('settings.ai.midStream.updateFailed'))
    }
  }, [refreshLlmConnections, t])

  // Get the default connection for display
  const defaultConnection = useMemo(() => {
    return llmConnections.find(c => c.isDefault)
  }, [llmConnections])

  // Anthropic account UUIDs that resolve from 2+ connections (issue #838).
  // Surfaces a warning when several Claude connections share one account/quota.
  const duplicateAccountUuids = useMemo(() => {
    const counts = new Map<string, number>()
    for (const conn of llmConnections) {
      const uuid = conn.oauthAccountUuid
      if (uuid) counts.set(uuid, (counts.get(uuid) ?? 0) + 1)
    }
    return new Set([...counts].filter(([, n]) => n > 1).map(([uuid]) => uuid))
  }, [llmConnections])

  const defaultModel = defaultConnection?.defaultModel ?? ''

  // App-level default handlers
  const handleDefaultModelChange = useCallback(async (model: string) => {
    if (!window.electronAPI || !defaultConnection) return
    // Update defaultModel on the connection, then save the full connection
    const updated = { ...defaultConnection, defaultModel: model }
    // Remove status fields that aren't part of LlmConnection
    const { isAuthenticated: _a, authError: _b, isDefault: _c, ...connectionData } = updated
    await window.electronAPI.saveLlmConnection(connectionData as import('../../../shared/types').LlmConnection)
    await refreshLlmConnections()
  }, [defaultConnection, refreshLlmConnections])

  const handleDefaultThinkingChange = useCallback(async (level: ThinkingLevel) => {
    if (!window.electronAPI) return

    const previous = defaultThinking
    setDefaultThinking(level)

    try {
      const result = await window.electronAPI.setDefaultThinkingLevel(level)
      if (!result.success) {
        console.error('Failed to set default thinking level:', result.error)
        setDefaultThinking(previous)
      }
    } catch (error) {
      console.error('Failed to set default thinking level:', error)
      setDefaultThinking(previous)
    }
  }, [defaultThinking])

  const outputStyleSelectOptions = useMemo(() => (
    outputStyleOptions.map((style) => {
      if (style.kind !== 'builtin') {
        // A plugin-shipped style names its owner, so two plugins offering
        // "Diagrams first" stay tellable apart in the list.
        return {
          value: style.id,
          label: style.label,
          description: [style.pluginName, style.description].filter(Boolean).join(' · ') || undefined,
        }
      }

      return {
        value: style.id,
        label: t(`outputStyles.${style.id}.label`, style.label),
        description: t(`outputStyles.${style.id}.description`, style.description ?? ''),
      }
    })
  ), [outputStyleOptions, t])

  // Guardian judge model options: the default (gateway `fast` alias, value '')
  // plus every model from the default connection's catalog. Any model may be
  // chosen; the empty value keeps the runtime default resolution.
  const guardianIntegrationOptions = useMemo(() => (
    llmConnections.map(c => ({ value: c.slug, label: c.name || c.slug }))
  ), [llmConnections])

  /** The integration whose models the picker is showing — defaults to the session default. */
  const guardianActiveConnection = useMemo(() => (
    llmConnections.find(c => c.slug === guardianConnection) ?? defaultConnection
  ), [llmConnections, guardianConnection, defaultConnection])

  // Models of the SELECTED integration only. Offering another connection's
  // catalog is exactly how the old global picker produced 403s at consult time.
  //
  // P2.502 — the list is NOT narrowed by the managed allowlist, deliberately.
  // The posture and its four reasons are at `describeManagedModelRefusal`; the
  // short form is that the host refuses at write and the renderer cannot
  // compute the allowlist without answering `true` for everything.
  const guardianModelSelectOptions = useMemo(() => ([
    { value: '', label: t('settings.ai.guardian.modelDefault'), description: t('settings.ai.guardian.modelDefaultDesc') },
    ...getModelOptionsForConnection(guardianActiveConnection).map(o => ({
      value: o.value,
      label: o.label,
      description: o.descriptionKey ? t(o.descriptionKey) : o.description,
    })),
  ]), [guardianActiveConnection, t])

  const handleOutputStyleChange = useCallback(async (styleId: string) => {
    if (!window.electronAPI) return

    const previous = outputStyle
    setOutputStyle(styleId)

    try {
      const result = await window.electronAPI.setOutputStyle(styleId)
      if (!result.success) {
        console.error('Failed to set output style:', result.error)
        toast.error(t('settings.ai.outputStyleUpdateFailed'))
        setOutputStyle(previous)
      }
    } catch (error) {
      console.error('Failed to set output style:', error)
      toast.error(t('settings.ai.outputStyleUpdateFailed'))
      setOutputStyle(previous)
    }
  }, [outputStyle, t])

  const handleExtendedPromptCacheChange = useCallback(async (enabled: boolean) => {
    setExtendedPromptCache(enabled)
    await window.electronAPI?.setExtendedPromptCache(enabled)
  }, [])

  const handleRtkToggle = useCallback(async (enabled: boolean) => {
    setRtkEnabled(enabled)
    await window.electronAPI?.setRtkEnabled(enabled)
  }, [])

  const handleGuardianToggle = useCallback(async (enabled: boolean) => {
    setGuardianEnabled(enabled)
    await window.electronAPI?.setGuardianEnabled(enabled)
  }, [])

  /**
   * P2.502 — the judge-model write, under the posture stated at
   * {@link describeManagedModelRefusal}.
   *
   * This used to set local state optimistically and then `await` the write with
   * NO catch at all, so any refusal or transport failure left the row showing a
   * judge the host does not have — the "optimistic lie" the built-in MCP panel
   * closed for its own switches. The rollback follows
   * `handleOutputStyleChange`, this page's existing pattern.
   *
   * The `MODEL_RESTRICTED_BY_POLICY` arm is the renderer half of the posture,
   * and it is honest about its own reach: **the guardian channel does not throw
   * that code today.** `RPC_CHANNELS.guardian.SET_MODEL_FOR_CONNECTION` writes
   * through `setGuardianJudgeModelForConnection` without consulting the
   * allowlist, and `resolveGuardianModelId` then drops a forbidden id and falls
   * back — so a user can pick a judge that will never run and be told nothing.
   * Closing that is a HOST change (the allowlist gate belongs beside the write,
   * as it is for the session model), and it changes the guardian's behaviour
   * from substitute-silently to refuse; this arm is what makes that refusal
   * visible the moment it lands, rather than a second trip through this file.
   */
  const handleGuardianModelChange = useCallback(async (modelId: string) => {
    const slug = guardianActiveConnection?.slug
    if (!slug) return
    const previous = guardianModels
    setGuardianModels(current => {
      const next = { ...current }
      if (modelId) next[slug] = modelId
      else delete next[slug]
      return next
    })
    try {
      await window.electronAPI?.setGuardianModelForConnection(slug, modelId)
    } catch (error) {
      setGuardianModels(previous)
      const refusal = describeManagedModelRefusal(error, modelId)
      if (refusal) {
        toast.warning(t(refusal.titleKey), { description: refusal.description })
        return
      }
      console.error('Failed to save guardian judge model:', error)
      toast.error(t('toast.failedToSaveSetting', { setting: t('settings.ai.guardian.modelLabel') }))
    }
  }, [guardianActiveConnection, guardianModels, t])

  const handleGuardianConnectionChange = useCallback((slug: string) => {
    setGuardianConnection(slug)
  }, [])

  /**
   * The advising-model list, from the DEFAULT connection's catalogue, with the
   * documented default first.
   *
   * Why no integration select beside it, unlike guardian: the advisor consults
   * on whatever connection the session is running, which this page does not
   * know. Offering a per-connection choice would imply a per-connection
   * preference that the storage key does not have. The catalogue shown is
   * therefore an OFFER, not a promise — `resolveAdvisorModel` still has to clear
   * entitlement on the session's own connection, and `settings.ai.advisor.
   * modelDesc` says so rather than letting a silent substitution happen.
   *
   * An empty catalogue is not an empty list: the default row is always present,
   * so the honest empty state reads "This session's own model" — the resolver's
   * own reading of an unset id — never a blank picker.
   */
  const advisorModelSelectOptions = useMemo(() => ([
    { value: '', label: t('settings.ai.advisor.modelDefault'), description: t('settings.ai.advisor.modelDefaultDesc') },
    ...getModelOptionsForConnection(defaultConnection).map(o => ({
      value: o.value,
      label: o.label,
      description: o.descriptionKey ? t(o.descriptionKey) : o.description,
    })),
  ]), [defaultConnection, t])

  const handleAdvisorToggle = useCallback(async (enabled: boolean) => {
    setAdvisorEnabled(enabled)
    await window.electronAPI?.setAdvisorEnabled(enabled)
  }, [])

  /**
   * Unlike `handleGuardianModelChange`, whose `MODEL_RESTRICTED_BY_POLICY` arm
   * is written for a refusal its channel does not yet throw, the advisor channel
   * DOES throw it: `RPC_CHANNELS.advisor.SET_MODEL` gates the write on
   * `isManagedModelSelectable` and refuses rather than storing an id the
   * resolver would later drop. So this rollback is on a live path, and the
   * optimistic value is put back when the host says no.
   */
  const handleAdvisorModelChange = useCallback(async (modelId: string) => {
    const previous = advisorModel
    setAdvisorModel(modelId)
    try {
      await window.electronAPI?.setAdvisorModel(modelId)
    } catch (error) {
      setAdvisorModel(previous)
      const refusal = describeManagedModelRefusal(error, modelId)
      if (refusal) {
        toast.warning(t(refusal.titleKey), { description: refusal.description })
        return
      }
      console.error('Failed to save advising model:', error)
      toast.error(t('toast.failedToSaveSetting', { setting: t('settings.ai.advisor.modelLabel') }))
    }
  }, [advisorModel, t])

  const handleCodexAutoReviewToggle = useCallback(async (enabled: boolean) => {
    setCodexAutoReviewEnabled(enabled)
    try {
      await window.electronAPI?.setCodexAutoReviewEnabled(enabled)
    } catch (error) {
      setCodexAutoReviewEnabled(!enabled)
      console.error('Failed to save the codex auto-review setting:', error)
      toast.error(t('toast.failedToSaveSetting', { setting: t('settings.ai.codexAutoReview.enabledLabel') }))
    }
  }, [t])

  /**
   * C3.286 — the in-app half of C3.109.
   *
   * Optimistic with a rollback, exactly like the auto-review toggle above: both
   * write one boolean through one IPC call, and a failed write that left the
   * switch showing the value it did not save is the one outcome worse than the
   * error toast.
   */
  const handleCodexSubagentsToggle = useCallback(async (enabled: boolean) => {
    setCodexSubagentsEnabled(enabled)
    try {
      await window.electronAPI?.setCodexSubagentsEnabled(enabled)
    } catch (error) {
      setCodexSubagentsEnabled(!enabled)
      console.error('Failed to save the codex subagents setting:', error)
      toast.error(t('toast.failedToSaveSetting', { setting: t('settings.ai.codexSubagentsLabel') }))
    }
  }, [t])

  /**
   * Committed on BLUR rather than per keystroke: every write is a whole-config
   * `saveConfig`, and a policy is a paragraph. There is no optimistic rollback
   * because there is nothing to roll back to — the field already holds what the
   * operator typed, and a failed write is reported rather than silently undone
   * under the cursor.
   */
  const handleCodexAutoReviewPolicyCommit = useCallback(async () => {
    try {
      await window.electronAPI?.setCodexAutoReviewPolicy(codexAutoReviewPolicy)
    } catch (error) {
      console.error('Failed to save the codex auto-review policy:', error)
      toast.error(t('toast.failedToSaveSetting', { setting: t('settings.ai.codexAutoReview.policyLabel') }))
    }
  }, [codexAutoReviewPolicy, t])

  const handleRecheckRtk = useCallback(async () => {
    setRtkRechecking(true)
    try {
      const status = await window.electronAPI?.getRtkStatus({ forceRecheck: true })
      if (status) setRtkStatus(status)
    } finally {
      setRtkRechecking(false)
    }
  }, [])

  const handleGetRtk = useCallback(() => {
    window.electronAPI?.openUrl('https://github.com/rtk-ai/rtk')
  }, [])

  const refreshRtkGain = useCallback(async () => {
    const gain = await window.electronAPI?.getRtkGain()
    setRtkGain(gain ?? null)
  }, [])

  // ---- UB6.5 Decision model (Jev) ----
  const refreshDecisionStatus = useCallback(async (seedDrafts: boolean) => {
    if (typeof window.electronAPI?.getDecisionLayerStatus !== 'function') return
    try {
      const status = await window.electronAPI.getDecisionLayerStatus()
      setDecisionStatus(status)
      if (seedDrafts) {
        setDecisionModelDraft(status.settings.model ?? '')
        setDecisionBaseUrlDraft(status.settings.baseUrl ?? '')
        decisionDraftsSeededRef.current = true
      }
    } catch (error) {
      console.error('Failed to load decision model settings:', error)
    }
  }, [])

  // Reusable connections come from the LLM connection list, so refresh with it
  // (background model fetches re-emit that list; only the first load seeds drafts).
  useEffect(() => {
    void refreshDecisionStatus(!decisionDraftsSeededRef.current)
  }, [refreshDecisionStatus, llmConnections])

  const updateDecisionSettings = useCallback(async (patch: DecisionLayerSettingsPatch) => {
    try {
      const next = await window.electronAPI.setDecisionLayerSettings(patch)
      setDecisionStatus(prev => (prev ? { ...prev, settings: next } : prev))
      setDecisionTestResult(null)
      // A provider/connection switch drops the model + base URL overrides server-side
      // (they belonged to the previous provider) — mirror that in the inputs.
      if ('provider' in patch || 'connectionSlug' in patch) {
        setDecisionModelDraft(next.model ?? '')
        setDecisionBaseUrlDraft(next.baseUrl ?? '')
      }
    } catch (error) {
      console.error('Failed to update decision model settings:', error)
      toast.error(t('settings.ai.decisions.saveFailed'))
    }
  }, [t])

  // What each feature did over the last 7 days, loaded when Advanced settings opens.
  useEffect(() => {
    if (!decisionAdvancedOpen || typeof window.electronAPI?.getDecisionUsage !== 'function') return
    window.electronAPI.getDecisionUsage().then(setDecisionUsage).catch((error) => console.error('Failed to load decision usage:', error))
  }, [decisionAdvancedOpen])

  const decisionPreset = useMemo(
    () => decisionStatus?.presets.find(preset => preset.id === decisionStatus.settings.provider),
    [decisionStatus],
  )
  const decisionUsesLocalProvider = !!decisionPreset?.local && !decisionStatus?.settings.connectionSlug

  const probeDecisionServer = useCallback(async (baseUrl?: string) => {
    if (typeof window.electronAPI?.probeDecisionServer !== 'function') return
    setDecisionProbing(true)
    try {
      setDecisionProbe(await window.electronAPI.probeDecisionServer(baseUrl ? { baseUrl } : undefined))
    } catch (error) {
      console.error('Failed to probe decision server:', error)
      setDecisionProbe(null)
    } finally {
      setDecisionProbing(false)
    }
  }, [])

  // Probe whenever a local provider is selected or its base URL changes on disk.
  useEffect(() => {
    if (!decisionUsesLocalProvider) { setDecisionProbe(null); return }
    void probeDecisionServer()
  }, [decisionUsesLocalProvider, decisionStatus?.settings.provider, decisionStatus?.settings.baseUrl, probeDecisionServer])

  const handleDecisionKeySourceChange = useCallback((value: string) => {
    setDecisionKeyDraft('')
    if (value.startsWith('connection:')) {
      const slug = value.slice('connection:'.length)
      const provider = decisionStatus?.reusableConnections.find(c => c.slug === slug)?.provider
      void updateDecisionSettings({ connectionSlug: slug, ...(provider ? { provider } : {}) })
    } else if (value.startsWith('provider:')) {
      void updateDecisionSettings({ connectionSlug: null, provider: value.slice('provider:'.length) as DecisionProviderId })
    }
  }, [decisionStatus, updateDecisionSettings])

  const commitDecisionField = useCallback((field: 'model' | 'baseUrl', value: string) => {
    const current = decisionStatus?.settings[field] ?? ''
    if (value.trim() === current) return
    void updateDecisionSettings({ [field]: value.trim() || null })
  }, [decisionStatus, updateDecisionSettings])

  const handleSaveDecisionKey = useCallback(async () => {
    if (!decisionStatus || !decisionKeyDraft.trim()) return
    try {
      await window.electronAPI.setDecisionApiKey(decisionStatus.settings.provider, decisionKeyDraft.trim())
      setDecisionKeyDraft('')
      toast.success(t('settings.ai.decisions.keySaved'))
      await refreshDecisionStatus(false)
    } catch (error) {
      console.error('Failed to save decision model key:', error)
      toast.error(t('settings.ai.decisions.saveFailed'))
    }
  }, [decisionStatus, decisionKeyDraft, refreshDecisionStatus, t])

  const handleRemoveDecisionKey = useCallback(async () => {
    if (!decisionStatus) return
    try {
      await window.electronAPI.deleteDecisionApiKey(decisionStatus.settings.provider)
      toast.success(t('settings.ai.decisions.keyRemoved'))
      await refreshDecisionStatus(false)
    } catch (error) {
      console.error('Failed to remove decision model key:', error)
      toast.error(t('settings.ai.decisions.saveFailed'))
    }
  }, [decisionStatus, refreshDecisionStatus, t])

  const handleTestDecision = useCallback(async () => {
    setDecisionTesting(true)
    setDecisionTestResult(null)
    try {
      const result = await window.electronAPI.testDecisionConnection({
        settings: { model: decisionModelDraft.trim() || null, baseUrl: decisionBaseUrlDraft.trim() || null },
        apiKey: decisionKeyDraft.trim() || undefined,
      })
      setDecisionTestResult(result)
    } catch (error) {
      setDecisionTestResult({ ok: false, failure: { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) } })
    } finally {
      setDecisionTesting(false)
    }
  }, [decisionModelDraft, decisionBaseUrlDraft, decisionKeyDraft])

  // Refresh gain stats whenever rtk transitions to installed-and-enabled
  useEffect(() => {
    if (rtkStatus?.installed && rtkEnabled) {
      refreshRtkGain()
    } else {
      setRtkGain(null)
    }
  }, [rtkStatus?.installed, rtkEnabled, refreshRtkGain])

  // Refresh callback for workspace cards
  const handleWorkspaceSettingsChange = useCallback(() => {
    // Refresh context so changes propagate immediately
    refreshLlmConnections?.()
  }, [refreshLlmConnections])

  if (settingsLoading) {
    return (
      <SettingsPage
        title={t("settings.ai.title")}
        description={t("settings.ai.description")}
        actions={<HeaderMenu route={routes.view.settings('ai')} />}
      >
        <div role="status" aria-label={t('common.loading')} className="space-y-6">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-32 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      </SettingsPage>
    )
  }

  return (
    <SettingsPage
      title={t("settings.ai.title")}
      description={t("settings.ai.description")}
      actions={<HeaderMenu route={routes.view.settings('ai')} />}
    >
      {/* Credential Health Warning Banner */}
      <CredentialHealthBanner
        issues={credentialHealthIssues}
        onReauthenticate={handleReauthenticate}
      />

      {/* Default Settings - only show if connections exist */}
      {llmConnections.length > 0 && (
      <SettingsSection title={t("settings.ai.defaultSection")} description={t("settings.ai.defaultSectionDesc")}>
        <SettingsCard>
          <SettingsMenuSelectRow
            label={t("settings.ai.connection")}
            description={t("settings.ai.connectionDesc")}
            value={defaultConnection?.slug || ''}
            onValueChange={handleSetDefaultConnection}
            options={llmConnections.map((conn) => ({
              value: conn.slug,
              label: conn.name,
              description: conn.providerType === 'anthropic' ? 'Anthropic API' :
                           conn.providerType === 'pi' ? 'Nessy Backend' :
                           conn.providerType === 'codex-runtime' || conn.providerType === 'claude-runtime'
                             ? runtimeConnectionLabel(conn) :
                           conn.providerType === 'pi_compat' ? (conn.baseUrl?.toLowerCase().includes('manifest.build') ? 'Manifest' : 'Nessy Backend (Compatible)') :
                           conn.providerType || 'Unknown',
            }))}
          />
          <SettingsMenuSelectRow
            label={t("settings.ai.model")}
            description={t("settings.ai.modelDesc")}
            value={defaultModel}
            onValueChange={handleDefaultModelChange}
            options={getModelOptionsForConnection(defaultConnection).map(o => ({
              ...o, description: o.descriptionKey ? t(o.descriptionKey) : o.description,
            }))}
          />
          <SettingsMenuSelectRow
            label={t("settings.ai.thinking")}
            description={t("settings.ai.thinkingDesc")}
            value={defaultThinking}
            onValueChange={(v) => handleDefaultThinkingChange(v as ThinkingLevel)}
            options={THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => ({
              value: id,
              label: t(nameKey),
              description: t(descriptionKey),
            }))}
          />
          <SettingsMenuSelectRow
            label={t("settings.ai.outputStyle")}
            description={t("settings.ai.outputStyleDesc")}
            value={outputStyle}
            onValueChange={handleOutputStyleChange}
            options={outputStyleSelectOptions}
            menuWidth={340}
            searchable={outputStyleSelectOptions.length > 8}
          />
        </SettingsCard>
      </SettingsSection>
      )}

      {/* Workspace Overrides - only show if connections exist */}
      {workspaces.length > 0 && llmConnections.length > 0 && (
        <SettingsSection title={t("settings.ai.workspaceOverrides")} description={t("settings.ai.workspaceOverridesDesc")}>
          {/* One card for all workspaces, like the Default group: a card per row read as clutter */}
          <SettingsCard>
            {workspaces.map((workspace) => (
              <WorkspaceOverrideCard
                key={workspace.id}
                workspace={workspace}
                llmConnections={llmConnections}
                onSettingsChange={handleWorkspaceSettingsChange}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      )}

      {/* Connections Management */}
      <SettingsSection title={t("settings.ai.connections")} description={t("settings.ai.connectionsDesc")}>
        <SettingsCard>
          {llmConnections.length === 0 ? (
            <div className="px-3.5 py-6 text-center text-label text-tertiary">
              {t("settings.ai.noConnections")}
            </div>
          ) : (
            [...llmConnections]
              .sort((a, b) => {
                if (a.isDefault && !b.isDefault) return -1
                if (!a.isDefault && b.isDefault) return 1
                return a.name.localeCompare(b.name)
              })
              .map((conn) => (
              <ConnectionRow
                key={conn.slug}
                connection={conn}
                isLastConnection={false}
                onRenameClick={() => handleRenameClick(conn)}
                onDelete={() => handleDeleteConnection(conn.slug)}
                onSetDefault={() => handleSetDefaultConnection(conn.slug)}
                onValidate={() => handleValidateConnection(conn.slug)}
                onReauthenticate={() => handleReauthenticateConnection(conn)}
                onReconnect={() => { void handleReconnectGateway(conn.slug) }}
                onEdit={() => handleEditConnection(conn)}
                onSetMidStreamBehavior={(behavior) => handleSetMidStreamBehavior(conn, behavior)}
                validationState={validationStates[conn.slug]?.state || 'idle'}
                validationError={validationStates[conn.slug]?.error}
                reconnectPhase={reconnectingSlug === conn.slug ? gatewayAuthPhase : null}
                isDuplicateAccount={!!conn.oauthAccountUuid && duplicateAccountUuids.has(conn.oauthAccountUuid)}
              />
            ))
          )}
        </SettingsCard>
        <div className="pt-0">
          <Button variant="secondary" size="md" onClick={() => openApiSetup()}>
            {t("settings.ai.addConnection")}
          </Button>
        </div>
      </SettingsSection>

      {/* Performance */}
      <SettingsSection title={t("settings.ai.performance")} description={t("settings.ai.performanceDesc")}>
        <SettingsCard>
          <SettingsToggle
            label={t("settings.ai.extendedPromptCache")}
            description={t("settings.ai.extendedPromptCacheDesc")}
            checked={extendedPromptCache}
            onCheckedChange={handleExtendedPromptCacheChange}
          />
          {rtkStatus?.outdated ? (
            <SettingsRow
              label={t("settings.ai.rtk.outdated", { version: rtkStatus.version ?? '' })}
              description={t("settings.ai.rtk.outdatedDesc", { min: rtkStatus.minSafeVersion ?? '' })}
            >
              <Button
                size="md"
                onClick={() => setRtkDialogOpen(true)}
                variant="secondary"
              >
                {t("settings.ai.rtk.update")}
              </Button>
            </SettingsRow>
          ) : rtkStatus?.installed ? (
            <>
              <SettingsToggle
                label={t("settings.ai.rtk.title")}
                description={t("settings.ai.rtk.description")}
                checked={rtkEnabled}
                onCheckedChange={handleRtkToggle}
              />
              {rtkEnabled && rtkGain && rtkGain.totalCommands > 0 && (
                <div className="px-3.5 pb-3.5 -mt-1">
                  <div className="flex items-center justify-between gap-2 text-label-sm text-tertiary">
                    <span className="tabular-nums">
                      {t("settings.ai.rtk.gainSummary", {
                        saved: formatTokenCount(rtkGain.totalSaved),
                        count: rtkGain.totalCommands,
                        pct: rtkGain.avgSavingsPct.toFixed(1),
                      })}
                    </span>
                    <IconButton
                      size="sm"
                      onClick={refreshRtkGain}
                      aria-label={t("settings.ai.rtk.gainRefresh")}
                      icon={<RefreshCcw className="size-3.5" />}
                    />
                  </div>
                  {/* Meter: the fill scales on X (transform only, instant under reduced motion); --border-control keeps it ≥ 3:1 */}
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-fill-pressed">
                    <div
                      className="h-full w-full origin-left bg-[var(--border-control)] transition-transform duration-[calc(var(--dur-base)*var(--motion-scale))] ease-out"
                      style={{ transform: `scaleX(${Math.min(100, Math.max(0, rtkGain.avgSavingsPct)) / 100})` }}
                    />
                  </div>
                </div>
              )}
            </>
          ) : (
            <SettingsRow
              label={t("settings.ai.rtk.title")}
              description={rtkStatus === null ? t("common.checking") : t("settings.ai.rtk.notInstalledDesc")}
            >
              <Button
                size="md"
                onClick={handleGetRtk}
                variant="secondary"
              >
                {t("settings.ai.rtk.getRtk")}
              </Button>
              <Button
                size="md"
                onClick={handleRecheckRtk}
                disabled={rtkRechecking || rtkStatus === null}
                variant="secondary"
              >
                {rtkRechecking ? t("common.checking") : t("settings.ai.rtk.recheck")}
              </Button>
            </SettingsRow>
          )}
          {rtkDialogOpen && rtkStatus && (
            <RtkUpdateDialog
              open={rtkDialogOpen}
              onOpenChange={setRtkDialogOpen}
              status={rtkStatus}
              onStatusChange={setRtkStatus}
            />
          )}
        </SettingsCard>
      </SettingsSection>

      {/* UB6.5 — Decision model (Jev): opt-in decision layer, off by default */}
      {decisionStatus && (
        <SettingsSection title={t("settings.ai.decisions.title")} description={t("settings.ai.decisions.sectionDesc")}>
          <DecisionModelCard
            status={decisionStatus}
            usage={decisionUsage}
            testResult={decisionTestResult}
            testing={decisionTesting}
            probe={decisionProbe}
            probing={decisionProbing}
            advancedOpen={decisionAdvancedOpen}
            onAdvancedOpenChange={setDecisionAdvancedOpen}
            modelDraft={decisionModelDraft}
            baseUrlDraft={decisionBaseUrlDraft}
            keyDraft={decisionKeyDraft}
            onModelDraftChange={setDecisionModelDraft}
            onBaseUrlDraftChange={setDecisionBaseUrlDraft}
            onKeyDraftChange={setDecisionKeyDraft}
            onUpdate={(patch) => { void updateDecisionSettings(patch) }}
            onCommitField={commitDecisionField}
            onKeySourceChange={handleDecisionKeySourceChange}
            onSaveKey={() => { void handleSaveDecisionKey() }}
            onRemoveKey={() => { void handleRemoveDecisionKey() }}
            onTest={() => { void handleTestDecision() }}
            onProbe={(baseUrl) => { void probeDecisionServer(baseUrl) }}
          />
        </SettingsSection>
      )}

      {/* Guardian safety judge */}
      {/* The description states the SCOPE: the judge is wired for the Pi
          runtime only, and a section that promised the deny-net without
          saying so was a silent whole-runtime fail-open. */}
      <SettingsSection
        title={t("settings.ai.guardian.title")}
        description={`${t("settings.ai.guardian.description")} ${t("settings.ai.guardian.scopeNote")}`}
      >
        <SettingsCard>
          <SettingsToggle
            label={t("settings.ai.guardian.enabledLabel")}
            description={t("settings.ai.guardian.enabledDesc")}
            checked={guardianEnabled}
            onCheckedChange={handleGuardianToggle}
          />
          {guardianEnabled && llmConnections.length > 0 && (
            <>
              {/* TWO DEPENDENT SELECTS: the integration chooses whose
                  catalog the model list shows. One model cannot judge
                  for every integration — entitlement is per key. Hidden
                  when there is only one connection, since there is
                  nothing to choose between. */}
              {guardianIntegrationOptions.length > 1 && (
                <SettingsMenuSelectRow
                  label={t("settings.ai.guardian.integrationLabel")}
                  description={t("settings.ai.guardian.integrationDesc")}
                  value={guardianActiveConnection?.slug ?? ''}
                  onValueChange={handleGuardianConnectionChange}
                  options={guardianIntegrationOptions}
                  searchable={guardianIntegrationOptions.length > 8}
                />
              )}
              <SettingsMenuSelectRow
                label={t("settings.ai.guardian.modelLabel")}
                description={t("settings.ai.guardian.modelDesc")}
                value={guardianActiveConnection ? (guardianModels[guardianActiveConnection.slug] ?? '') : guardianModel}
                onValueChange={handleGuardianModelChange}
                options={guardianModelSelectOptions}
                searchable={guardianModelSelectOptions.length > 8}
              />
            </>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Advisor — the second opinion the session can ask for */}
      {/* The scope note says all three runtimes, and that is a fact
          about the HOST: `resolveAdvisorModel` is called from
          `base-agent.ts` on both the tool path and the command path, so
          Pi, Claude Code and Codex sessions get the same behaviour. It
          is the opposite of the guardian note directly above, which has
          to admit a one-runtime scope, and stating both keeps the
          difference visible instead of leaving the reader to assume. */}
      <SettingsSection
        title={t("settings.ai.advisor.title")}
        description={`${t("settings.ai.advisor.description")} ${t("settings.ai.advisor.scopeNote")}`}
      >
        <SettingsCard>
          <SettingsToggle
            label={t("settings.ai.advisor.enabledLabel")}
            description={t("settings.ai.advisor.enabledDesc")}
            checked={advisorEnabled}
            onCheckedChange={handleAdvisorToggle}
          />
          {advisorEnabled && (
            <SettingsMenuSelectRow
              label={t("settings.ai.advisor.modelLabel")}
              description={t("settings.ai.advisor.modelDesc")}
              value={advisorModel}
              onValueChange={handleAdvisorModelChange}
              options={advisorModelSelectOptions}
              searchable={advisorModelSelectOptions.length > 8}
            />
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Codex's own approval reviewer — P6.225 */}
      {/* Native-first: this is codex's mechanism, not a port of ours.
          `config-writer.ts` emits `approvals_reviewer = "auto_review"`
          and `[auto_review].policy`; the host supplies only the two
          controls that were missing, which is why the reviewer was
          reachable exclusively by hand-editing a config file.

          The scope note is the counterpart of the guardian one above —
          that judge is Pi's alone, this reviewer is codex's alone, and
          Claude Code sessions have neither. Stating both keeps the
          difference visible instead of leaving the reader to assume one
          covers the others. */}
      <SettingsSection
        title={t("settings.ai.codexAutoReview.title")}
        description={`${t("settings.ai.codexAutoReview.description")} ${t("settings.ai.codexAutoReview.scopeNote")}`}
      >
        <SettingsCard>
          <SettingsToggle
            label={t("settings.ai.codexAutoReview.enabledLabel")}
            description={t("settings.ai.codexAutoReview.enabledDesc")}
            checked={codexAutoReviewEnabled}
            onCheckedChange={handleCodexAutoReviewToggle}
          />
          {codexAutoReviewEnabled && (
            <SettingsTextarea
              label={t("settings.ai.codexAutoReview.policyLabel")}
              description={t("settings.ai.codexAutoReview.policyDesc")}
              value={codexAutoReviewPolicy}
              onChange={setCodexAutoReviewPolicy}
              onBlur={handleCodexAutoReviewPolicyCommit}
              placeholder={t("settings.ai.codexAutoReview.policyPlaceholder")}
              rows={4}
              inCard
            />
          )}
        </SettingsCard>
        {/* C3.286 · codex's OWN delegation off-switch, the in-app half of
            C3.109. It sits in the same section because both settings are
            codex's alone and neither exists on Pi or Claude Code, and in
            its own card because it is unrelated to the reviewer above:
            one routes approvals, this one decides whether codex may spawn
            agents at all. The description carries the conditionality the
            schema states — `features.multi_agent_v2` takes precedence —
            rather than promising an unconditional switch. */}
        <SettingsCard>
          <SettingsToggle
            label={t("settings.ai.codexSubagentsLabel")}
            description={t("settings.ai.codexSubagentsDesc")}
            checked={codexSubagentsEnabled}
            onCheckedChange={handleCodexSubagentsToggle}
          />
        </SettingsCard>
      </SettingsSection>

      {/* API Setup Fullscreen Overlay */}
      <FullscreenOverlayBase
        isOpen={showApiSetup}
        onClose={handleCloseApiSetup}
        className="z-splash flex flex-col bg-navigator"
      >
        <OnboardingWizard
          state={apiSetupOnboarding.state}
          onContinue={apiSetupOnboarding.handleContinue}
          onBack={isDirectEdit ? handleCloseApiSetup : apiSetupOnboarding.handleBack}
          onSelectProvider={apiSetupOnboarding.handleSelectProvider}
          onSelectApiSetupMethod={apiSetupOnboarding.handleSelectApiSetupMethod}
          onSubmitCredential={apiSetupOnboarding.handleSubmitCredential}
          onSubmitLocalModel={apiSetupOnboarding.handleSubmitLocalModel}
          onSubmitByoRuntime={apiSetupOnboarding.handleSubmitByoRuntime}
          onStartOAuth={apiSetupOnboarding.handleStartOAuth}
          onFinish={handleApiSetupFinish}
          isWaitingForCode={apiSetupOnboarding.isWaitingForCode}
          onSubmitAuthCode={apiSetupOnboarding.handleSubmitAuthCode}
          onCancelOAuth={apiSetupOnboarding.handleCancelOAuth}
          editInitialValues={editInitialValues}
          className="h-full"
        />
        <div
          className="fixed top-0 right-0 h-[50px] flex items-center pr-5 [-webkit-app-region:no-drag]"
          style={{ zIndex: 'var(--z-fullscreen, 350)' }}
        >
          <Button
            variant="secondary"
            size="icon"
            onClick={handleCloseApiSetup}
            title={t("common.closeEsc")}
            aria-label={t("common.closeEsc")}
            className="text-secondary hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>
      </FullscreenOverlayBase>

      {/* Rename Connection Dialog */}
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t("settings.ai.renameConnection")}
        value={renameValue}
        onValueChange={setRenameValue}
        onSubmit={handleRenameSubmit}
        placeholder={t("settings.ai.enterConnectionName")}
      />
    </SettingsPage>
  )
}

/**
 * F1.361 — Settings → Reconnect used to return SILENTLY on a failed sign-in:
 * the row's spinner stopped and nothing said why. The reason and next step are
 * the ones the banner and the onboarding step show (`gatewaySignInFailureView`);
 * a success or the user's own cancel says nothing. Declared at the END of the
 * file on purpose: the docs cite this page by line up to 1505, and the handler's
 * own edit is one line for one.
 */
function toastGatewayReconnectFailure(
  result: Parameters<typeof gatewayReconnectFailureNotice>[0],
  t: (key: string) => string,
): void {
  const notice = gatewayReconnectFailureNotice(result)
  if (!notice) return
  toast.error(t(notice.reasonKey), notice.nextStepKey ? { description: t(notice.nextStepKey) } : undefined)
}

/**
 * F1.2 — while a Reconnect this page started waits for the browser, offer the
 * link dp handed that browser: a toast that stays until the run moves on, with
 * a Copy action (the sign-in has to finish in a browser on THIS machine, which
 * the hint says). Copy rather than open: opening through the app's URL bridge
 * would log the whole URL, query included, and the browser dp already asked to
 * open is the one the user could not see. Appended here for the reason
 * `toastGatewayReconnectFailure` gives; the call site took a blank line.
 */
function useGatewayAuthUrlToast(
  authUrl: string | undefined,
  reconnecting: boolean,
  t: (key: string) => string,
): void {
  useEffect(() => {
    if (!reconnecting || !authUrl) return
    const id = toast(t('onboarding.gatewayConnect.authUrlHint'), {
      duration: Infinity,
      action: {
        label: t('onboarding.gatewayConnect.copyAuthUrl'),
        onClick: () => { void navigator.clipboard.writeText(authUrl) },
      },
    })
    return () => { toast.dismiss(id) }
  }, [authUrl, reconnecting, t])
}
