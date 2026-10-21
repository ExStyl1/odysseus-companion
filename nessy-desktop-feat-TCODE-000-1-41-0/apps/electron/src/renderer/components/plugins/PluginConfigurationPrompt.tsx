/**
 * The enable-time configuration prompt (D15).
 *
 * `plugins/manifest-reference.md#user-configuration` — `userConfig` declares "User-configurable values
 * prompted at enable time", and `:543` — "The `userConfig` field declares values
 * that Claude Code prompts the user for when the plugin is enabled. Use this
 * instead of requiring users to hand-edit `settings.json`."
 *
 * Nothing prompted. A user turned on a plugin that needs a token, was told
 * nothing, and hit an auth failure at first use with no hint where to fix it.
 *
 * ## Dismissable without a state nobody can explain
 *
 * The activation is already written when this opens, and dismissing changes
 * nothing about it. What the user gets is exactly the state D14 defines: the
 * plugin is enabled, and the capabilities that reference an unset
 * `${user_config.KEY}` are refused with `user-config-missing` and a diagnostic
 * naming the field. The same form lives on the plugin's detail page, so
 * "Later" is a deferral to a place that exists rather than a dead end.
 *
 * A dismissal is NOT a disable: a managed policy can force-enable a plugin
 * (`settings-reference.md#enabledplugins` — "Plugins force-enabled by managed
 * settings can't be disabled this way, since managed settings override local
 * settings."), so a prompt that rolled the enable back on Escape would be
 * fighting the administrator.
 *
 * UB14.39 (R6-10) — on v0.15.1's dialog vocabulary (recipe: v0.15.1
 * `ui/rename-dialog.tsx`): Later, the deferral, is the ghost and Save the
 * forward primary; a refusal reads on the destructive text role.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  PluginConfigurationFields,
  pluginConfigurationValues,
  type PluginConfigurationDraft,
} from './PluginConfigurationFields'
import type { SafePluginConfigurationStatus } from '@nessy-agent/shared/protocol/capabilities'

export interface PluginConfigurationPromptState {
  pluginKey: string
  workspaceId: string
  displayName?: string
  configuration: SafePluginConfigurationStatus
}

export interface PluginConfigurationPromptProps {
  state: PluginConfigurationPromptState | null
  onDismiss: () => void
  /** Resolves when the values are stored. Rejects with a message to display. */
  onSubmit: (
    state: PluginConfigurationPromptState,
    values: Record<string, string | number | boolean>,
  ) => Promise<void>
}

export function PluginConfigurationPrompt({ state, onDismiss, onSubmit }: PluginConfigurationPromptProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState<PluginConfigurationDraft>({})
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  // A new prompt starts from an empty draft — a value typed for one plugin must
  // never be carried into another plugin's field.
  React.useEffect(() => {
    setDraft({})
    setError(null)
  }, [state?.pluginKey, state?.workspaceId])

  const dismiss = React.useCallback(() => {
    setDraft({})
    setError(null)
    onDismiss()
  }, [onDismiss])

  if (!state) return null
  const fields = state.configuration.fields
  const missing = fields.filter(field => field.missing)

  const submit = async () => {
    setPending(true)
    setError(null)
    try {
      await onSubmit(state, pluginConfigurationValues(fields, draft))
      setDraft({})
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('pluginDetail.configurationError'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) dismiss() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('pluginDetail.configurationPromptTitle')}</DialogTitle>
          <DialogDescription className="text-left pt-2">
            {missing.length > 0
              ? t('pluginDetail.configurationPromptRequired', {
                  plugin: state.displayName ?? state.pluginKey,
                  count: missing.length,
                })
              : t('pluginDetail.configurationPromptOptional', {
                  plugin: state.displayName ?? state.pluginKey,
                })}
          </DialogDescription>
        </DialogHeader>

        <PluginConfigurationFields
          fields={fields}
          draft={draft}
          onDraftChange={setDraft}
          idPrefix="plugin-config-prompt"
        />

        {error && <p className="text-label text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={dismiss} disabled={pending}>
            {t('pluginDetail.configurationPromptLater')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={pending}>
            {t('pluginDetail.configurationSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
