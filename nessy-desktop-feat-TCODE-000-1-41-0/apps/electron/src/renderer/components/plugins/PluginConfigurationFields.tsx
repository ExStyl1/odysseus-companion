/**
 * The plugin option form — one component, two surfaces (D15).
 *
 * `plugins/manifest-reference.md#user-configuration`/`:570` make `title` ("Label shown in the
 * configuration dialog") and `description` ("Help text shown beneath the field")
 * REQUIRED fields of an option declaration. Both were imported by the adapter
 * and rendered nowhere: every field was labelled with its raw key, so a user
 * looking at `api_token` had no way to know what was being asked of them.
 *
 * `:571` — a sensitive option "masks input and stores the value in secure
 * storage". Masking used to key off `valueType === 'secret-ref'`, which is only
 * MCPB's spelling; a Claude `{"type": "string", "sensitive": true}` token
 * rendered as a plain text input. It now keys off the `sensitive` flag, which
 * `isSensitivePluginConfigurationField` answers for BOTH spellings.
 *
 * No configured value ever comes back across the boundary
 * (`SafePluginConfigurationFieldStatus` is value-free), so the draft this form
 * holds is only ever what the user typed in this sitting. A masked field's draft
 * is never echoed into an attribute, a title, or a data-* hook.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SafePluginConfigurationFieldStatus } from '@nessy-agent/shared/protocol/capabilities'

export type PluginConfigurationDraft = Record<string, string | boolean>

export interface PluginConfigurationFieldsProps {
  fields: readonly SafePluginConfigurationFieldStatus[]
  draft: PluginConfigurationDraft
  onDraftChange: (next: PluginConfigurationDraft) => void
  idPrefix?: string
}

function textDraft(value: string | boolean | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** `:571` — masked whichever spelling the bundle used to declare secrecy. */
export function isSensitiveConfigurationField(field: SafePluginConfigurationFieldStatus): boolean {
  return field.sensitive || field.valueType === 'secret-ref'
}

/** The label a field is asked for by. Falls back to the key only if unimported. */
export function configurationFieldLabel(field: SafePluginConfigurationFieldStatus): string {
  return field.title?.trim() || field.key
}

/**
 * Turn a draft into the one-way `configure` payload: blanks are dropped, so
 * leaving a masked field empty keeps the stored value rather than clearing it.
 */
export function pluginConfigurationValues(
  fields: readonly SafePluginConfigurationFieldStatus[],
  draft: PluginConfigurationDraft,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {}
  for (const field of fields) {
    const entry = draft[field.key]
    if (entry === undefined || entry === '') continue
    values[field.key] = field.valueType === 'number' && typeof entry === 'string' ? Number(entry) : entry
  }
  return values
}

/** UB14.39 (R6-10): hints and states on v0.15.1's text roles (`text-label-sm text-tertiary`), the toggle row `text-label`. */
export function PluginConfigurationFields({
  fields,
  draft,
  onDraftChange,
  idPrefix = 'plugin-config',
}: PluginConfigurationFieldsProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      {fields.map(field => {
        const id = `${idPrefix}-${field.key}`
        const sensitive = isSensitiveConfigurationField(field)
        return (
          <div key={field.key} className="space-y-1.5">
            <Label htmlFor={id}>
              {configurationFieldLabel(field)}
              {field.required ? ` ${t('pluginDetail.configurationRequiredMark')}` : ''}
            </Label>
            {field.description && (
              <p className="text-label-sm text-tertiary">{field.description}</p>
            )}
            {field.valueType === 'boolean' ? (
              <label className="flex items-center gap-2 text-label">
                <input
                  id={id}
                  type="checkbox"
                  checked={draft[field.key] === true}
                  onChange={event => onDraftChange({ ...draft, [field.key]: event.target.checked })}
                />
                {field.configured
                  ? t('pluginDetail.configurationConfigured')
                  : t('pluginDetail.configurationSetBoolean')}
              </label>
            ) : (
              <Input
                id={id}
                type={sensitive ? 'password' : field.valueType === 'number' ? 'number' : 'text'}
                value={textDraft(draft[field.key])}
                placeholder={field.configured
                  ? t('pluginDetail.configurationConfiguredPlaceholder')
                  : field.hasDefault ? t('pluginDetail.configurationDefaultPlaceholder') : ''}
                onChange={event => onDraftChange({ ...draft, [field.key]: event.target.value })}
                autoComplete={sensitive ? 'new-password' : 'off'}
              />
            )}
            <p className="text-label-sm text-tertiary">
              {field.missing
                ? t('pluginDetail.configurationMissing')
                : field.configured
                  ? t('pluginDetail.configurationConfigured')
                  : t('pluginDetail.configurationOptional')}
            </p>
          </div>
        )
      })}
    </div>
  )
}
