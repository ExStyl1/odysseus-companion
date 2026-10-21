/**
 * The post-install setup checklist (T3, plugin-install plan § 4).
 *
 * Install used to end in silence: `installUnlocked` activates immediately and
 * returned `ok:true` with nothing else, while most of a connector-heavy
 * plugin's servers were not usable. The install RPC now reports the whole
 * truth (T2: `pendingAuth` + `authRequirements` + `configuration`), and this
 * dialog renders it as a skippable checklist.
 *
 * Per the owner's § 0b-2 decision (Claude's no-chaining-at-install model):
 *
 * - the Developer Platform sign-in is ACTIONABLE — dp is our system login,
 *   one sign-in unblocks every dp-backed server at once;
 * - the userConfig row is ACTIONABLE — it opens the same enable-time
 *   configuration prompt Claude's contract names (`plugins/components.md#when-the-configuration-dialog-appears`);
 * - connector rows are INFORMATIONAL — they name the server and point at the
 *   session-start notice, with no per-connector OAuth buttons.
 *
 * Nothing blocks: skipping leaves every entry reachable later (the session
 * notice, the plugin detail page).
 *
 * UB14.39 (R6-10) — on v0.15.1's dialog vocabulary (recipe: v0.15.1
 * `ui/rename-dialog.tsx`): Skip is the ghost and Done the forward primary; in
 * the rows the dp sign-in stays the primary action, Configure the secondary, the
 * glyphs and hints the tertiary role, the signed-in check the success role. The
 * rows, their order and what is actionable are unchanged.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleAlert, Info, KeyRound, Settings2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type {
  SafeMarketplacePluginInstallResult,
  SafePluginConfigurationStatus,
} from '@nessy-agent/shared/protocol/capabilities'

/** The derived, render-ready shape of one install result's outstanding setup. */
export interface PluginSetupChecklist {
  /** One Developer Platform sign-in unblocks all of these servers. */
  dp?: { serverNames: string[] }
  /** Declared configuration keys still missing a value. */
  userConfig?: { missingCount: number; configuration: SafePluginConfigurationStatus }
  /** Connector servers still needing a sign-in, either timing (informational). */
  connectors: Array<{ serverName: string; sourceSlug?: string }>
  /** Servers needing environment/credential values before they can start. */
  environment?: { serverNames: string[]; requiredNames: string[] }
  /** Distinct servers named by any row above — the checklist's honest count. */
  serversNeedingSetup: number
}

type ChecklistInstallResult = Pick<
  SafeMarketplacePluginInstallResult,
  'ok' | 'pendingAuth' | 'authRequirements' | 'configuration'
>

/**
 * Derive the checklist from the install RPC result. Returns `null` when there
 * is nothing to finish — that install stays exactly as silent as before.
 *
 * Both timings are listed. ON_INSTALL entries used to be excluded here on the
 * grounds that `consumeConnectorAuthRequests` had already run their OAuth by
 * the time a successful result arrived — that chain has never run: nothing
 * service-side assigns `PluginManagementResult.authRequests`, so it never
 * crosses the wire (control: `authRequirements` IS assigned, at
 * `management-service-v2.ts:1159`). An ON_INSTALL connector therefore reaches
 * this dialog just as unauthenticated as an ON_FIRST_USE one, and excluding it
 * meant the plugin the timing exists for — figma — was the one the checklist
 * stayed silent about. Where the user signs in is the same for both (the
 * session notice, the MCP list, the plugin page), which is what the hint says.
 */
export function derivePluginSetupChecklist(
  result: ChecklistInstallResult,
): PluginSetupChecklist | null {
  if (!result.ok) return null

  const dpServerNames = new Set<string>()
  let environment: PluginSetupChecklist['environment']
  const firstUseServerNames = new Set<string>()
  for (const requirement of result.authRequirements ?? []) {
    if (requirement.kind === 'dp') {
      for (const name of requirement.serverNames) dpServerNames.add(name)
    } else if (requirement.kind === 'environment') {
      environment = {
        serverNames: [...requirement.serverNames].sort(),
        requiredNames: [...requirement.requiredNames].sort(),
      }
    } else if (requirement.kind === 'oauth' || requirement.kind === 'bearer') {
      for (const name of requirement.serverNames) firstUseServerNames.add(name)
    }
  }

  // Prefer the pendingAuth report (it carries the materialized source slug and
  // reflects what is actually still unauthenticated); fall back to the
  // manifest-derived requirement names when the install carried none.
  const connectors = new Map<string, { serverName: string; sourceSlug?: string }>()
  const pending = result.pendingAuth ?? []
  if (pending.length > 0) {
    for (const entry of pending) {
      const serverName = entry.serverName ?? entry.sourceSlug
      connectors.set(serverName, { serverName, sourceSlug: entry.sourceSlug })
    }
  } else {
    for (const serverName of firstUseServerNames) {
      connectors.set(serverName, { serverName })
    }
  }

  const configuration = result.configuration
  const missingCount = configuration?.state === 'needs_configuration'
    ? configuration.fields.filter(field => field.missing).length
    : 0

  const namedServers = new Set<string>([
    ...dpServerNames,
    ...connectors.keys(),
    ...(environment?.serverNames ?? []),
  ])
  if (namedServers.size === 0 && missingCount === 0) return null

  return {
    ...(dpServerNames.size > 0 ? { dp: { serverNames: [...dpServerNames].sort() } } : {}),
    ...(missingCount > 0 && configuration
      ? { userConfig: { missingCount, configuration } }
      : {}),
    connectors: [...connectors.values()].sort((a, b) => a.serverName.localeCompare(b.serverName)),
    ...(environment ? { environment } : {}),
    serversNeedingSetup: namedServers.size,
  }
}

export type ChecklistDpState = 'pending' | 'busy' | 'done' | 'error'

export interface PluginInstallChecklistState {
  pluginKey: string
  workspaceId: string
  displayName?: string
  checklist: PluginSetupChecklist
}

export interface PluginInstallChecklistProps {
  state: PluginInstallChecklistState | null
  dpState: ChecklistDpState
  onDismiss: () => void
  /** Run the system Developer Platform sign-in (never interrupts a turn). */
  onDpSignIn: () => void
  /** Open the enable-time configuration prompt for this plugin. */
  onConfigure: (state: PluginInstallChecklistState) => void
}

/**
 * The dialog's content, exported separately: the Radix dialog mounts through a
 * portal, so this body is what a static render (tests, docs) can see.
 */
export function PluginInstallChecklistBody({
  state,
  dpState,
  onDpSignIn,
  onConfigure,
}: Omit<PluginInstallChecklistProps, 'onDismiss'> & { state: PluginInstallChecklistState }) {
  const { t } = useTranslation()
  const { checklist } = state

  const dpLabel = dpState === 'busy'
    ? t('pluginChecklist.dpSigningIn')
    : dpState === 'done'
      ? t('pluginChecklist.dpSignedIn')
      : t('pluginChecklist.dpSignIn')

  return (
    <ul className="space-y-3 text-label">
      {checklist.dp && (
        <li className="flex items-start gap-2" data-testid="checklist-dp-row">
          {dpState === 'done'
            ? <CheckCircle2 className="mt-px size-4 shrink-0 text-success" aria-hidden />
            : <KeyRound className="mt-px size-4 shrink-0 text-tertiary" aria-hidden />}
          <div className="flex-1 space-y-1">
            <p>{t('pluginChecklist.dpRow', { count: checklist.dp.serverNames.length })}</p>
            {dpState === 'error' && (
              <p className="text-destructive">{t('pluginChecklist.dpError')}</p>
            )}
          </div>
          {dpState === 'done'
            ? <span className="text-label-sm text-tertiary">{dpLabel}</span>
            : (
              <Button variant="primary" size="sm" onClick={onDpSignIn} disabled={dpState === 'busy'}>
                {dpLabel}
              </Button>
            )}
        </li>
      )}

      {checklist.userConfig && (
        <li className="flex items-start gap-2" data-testid="checklist-config-row">
          <Settings2 className="mt-px size-4 shrink-0 text-tertiary" aria-hidden />
          <p className="flex-1">
            {t('pluginChecklist.userConfigRow', { count: checklist.userConfig.missingCount })}
          </p>
          <Button size="sm" variant="secondary" onClick={() => onConfigure(state)}>
            {t('pluginChecklist.configure')}
          </Button>
        </li>
      )}

      {checklist.environment && (
        <li className="flex items-start gap-2" data-testid="checklist-environment-row">
          <CircleAlert className="mt-px size-4 shrink-0 text-tertiary" aria-hidden />
          <p className="flex-1">
            {t('pluginChecklist.environmentRow', {
              count: checklist.environment.serverNames.length,
              names: checklist.environment.requiredNames.join(', '),
            })}
          </p>
        </li>
      )}

      {checklist.connectors.length > 0 && (
        <li className="space-y-1" data-testid="checklist-connector-rows">
          {/* Informational by owner decision (§ 0b-2): no OAuth buttons here —
              sign-in happens on demand from the session-start notice. */}
          {checklist.connectors.map(connector => (
            <p key={connector.serverName} className="flex items-start gap-2">
              <Info className="mt-px size-4 shrink-0 text-tertiary" aria-hidden />
              <span className="flex-1">
                {t('pluginChecklist.connectorRow', { server: connector.serverName })}
              </span>
            </p>
          ))}
          <p className="pl-6 text-label-sm text-tertiary">
            {t('pluginChecklist.connectorHint')}
          </p>
        </li>
      )}
    </ul>
  )
}

export function PluginInstallChecklist({
  state,
  dpState,
  onDismiss,
  onDpSignIn,
  onConfigure,
}: PluginInstallChecklistProps) {
  const { t } = useTranslation()
  if (!state) return null
  const { checklist } = state

  return (
    <Dialog open onOpenChange={open => { if (!open) onDismiss() }}>
      <DialogContent className="sm:max-w-md" data-testid="plugin-install-checklist">
        <DialogHeader>
          <DialogTitle>
            {t('pluginChecklist.title', { plugin: state.displayName ?? state.pluginKey })}
          </DialogTitle>
          <DialogDescription className="text-left pt-2">
            {t('pluginChecklist.summary', {
              count: Math.max(checklist.serversNeedingSetup, checklist.userConfig ? 1 : 0),
            })}
          </DialogDescription>
        </DialogHeader>

        <PluginInstallChecklistBody
          state={state}
          dpState={dpState}
          onDpSignIn={onDpSignIn}
          onConfigure={onConfigure}
        />

        <DialogFooter>
          <Button variant="ghost" onClick={onDismiss}>
            {t('pluginChecklist.skip')}
          </Button>
          <Button variant="primary" onClick={onDismiss}>
            {t('pluginChecklist.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
