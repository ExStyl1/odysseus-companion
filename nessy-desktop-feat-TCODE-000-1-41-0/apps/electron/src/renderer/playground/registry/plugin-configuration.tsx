/**
 * Playground registry for the PLUGIN CONFIGURATION surfaces (D15).
 *
 * Two components, one form: the enable-time prompt
 * (`plugins/components.md#when-the-configuration-dialog-appears` — "the values that Claude Code prompts the user
 * for when the plugin is enabled") and the same field list as it renders inside
 * the plugin detail page.
 *
 * The knobs are the states the row introduced, because each one is a distinct
 * design problem and three of them were previously indistinguishable:
 *
 * * a REQUIRED key that is unset (the state the prompt exists for)
 * * an OPTIONAL key that is unset
 * * a SECRET field (masked — `:571`)
 * * an imported `title`/`description` PRESENT vs ABSENT (`:569`/`:570`), which
 *   is the difference between a field labelled "API token — API authentication
 *   token" and one labelled `api_token`
 *
 * IPC-free: the prompt's submit is a resolved promise and nothing here touches
 * `window.electronAPI`. No value in this file is a credential; the secret field
 * is exercised with a typed placeholder only.
 */

import * as React from 'react'
import { PluginConfigurationFields } from '@/components/plugins/PluginConfigurationFields'
import { PluginConfigurationPrompt } from '@/components/plugins/PluginConfigurationPrompt'
import type {
  SafePluginConfigurationFieldStatus,
  SafePluginConfigurationStatus,
} from '@nessy-agent/shared/protocol/capabilities'
import type { ComponentEntry } from './types'

interface ConfigurationKnobs {
  requiredUnset: boolean
  optionalUnset: boolean
  secretField: boolean
  importedText: boolean
  configured: boolean
}

function buildFields(knobs: ConfigurationKnobs): SafePluginConfigurationFieldStatus[] {
  const described = (title: string, description: string) =>
    (knobs.importedText ? { title, description } : {})
  const fields: SafePluginConfigurationFieldStatus[] = []
  if (knobs.secretField) {
    fields.push({
      key: 'api_token',
      valueType: 'string',
      required: true,
      hasDefault: false,
      configured: knobs.configured,
      missing: knobs.requiredUnset && !knobs.configured,
      sensitive: true,
      ...described('API token', 'API authentication token for the internal service'),
    })
  }
  if (knobs.requiredUnset) {
    fields.push({
      key: 'api_endpoint',
      valueType: 'string',
      required: true,
      hasDefault: false,
      configured: knobs.configured,
      missing: !knobs.configured,
      sensitive: false,
      ...described('API endpoint', "Your team's API endpoint"),
    })
  }
  if (knobs.optionalUnset) {
    fields.push({
      key: 'request_timeout',
      valueType: 'number',
      required: false,
      hasDefault: true,
      configured: false,
      missing: false,
      sensitive: false,
      ...described('Request timeout', 'Seconds to wait before giving up on a call'),
    })
  }
  return fields
}

function status(knobs: ConfigurationKnobs): SafePluginConfigurationStatus {
  const fields = buildFields(knobs)
  return {
    state: fields.length === 0
      ? 'not-required'
      : fields.some(field => field.missing) ? 'needs_configuration' : 'ready',
    fields,
  }
}

/**
 * The harness owns the dismissal, because the component does not.
 *
 * `PluginConfigurationPrompt` renders `<Dialog open onOpenChange={…}>` with
 * `open` UNCONDITIONAL — in the product that is correct, because `dismiss()`
 * clears the state that mounts the component at all. A preview that passes a
 * no-op `onDismiss` therefore renders a dialog nothing can close, and its
 * portal overlay swallows every click on the page INCLUDING the playground
 * sidebar, so the entry cannot even be navigated away from.
 *
 * Pre-existing (this entry ships with the plugin-configuration feature, not
 * with any later lane) and fixed here because the fix belongs to the harness:
 * mirror what the product does by unmounting on dismiss, with a way back.
 */
function PromptPreview(knobs: ConfigurationKnobs) {
  const [open, setOpen] = React.useState(true)
  if (!open) {
    return (
      <button
        type="button"
        className="rounded-md border px-3 py-2 text-sm"
        onClick={() => setOpen(true)}
      >
        Dismissed — show the prompt again
      </button>
    )
  }
  return (
    <PluginConfigurationPrompt
      state={{
        pluginKey: 'corp.toolkit',
        workspaceId: 'ws-preview',
        displayName: 'Corp Toolkit',
        configuration: status(knobs),
      }}
      onDismiss={() => setOpen(false)}
      onSubmit={async () => setOpen(false)}
    />
  )
}

function FieldsPreview(knobs: ConfigurationKnobs) {
  const [draft, setDraft] = React.useState<Record<string, string | boolean>>({})
  return (
    <div className="w-[420px] space-y-4 rounded-lg border p-4">
      <PluginConfigurationFields
        fields={buildFields(knobs)}
        draft={draft}
        onDraftChange={setDraft}
        idPrefix="playground-plugin-config"
      />
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  { name: 'requiredUnset', description: 'A REQUIRED key with no value — the state the prompt exists for', control: { type: 'boolean' }, defaultValue: true },
  { name: 'optionalUnset', description: 'An OPTIONAL key with a declared default and no value', control: { type: 'boolean' }, defaultValue: true },
  { name: 'secretField', description: 'A sensitive field (`:571`) — masked input, never recoverable from the DOM', control: { type: 'boolean' }, defaultValue: true },
  { name: 'importedText', description: 'Imported title/description present (`:569`/`:570`) vs absent → falls back to the raw key', control: { type: 'boolean' }, defaultValue: true },
  { name: 'configured', description: 'The values are already stored — the form shows "Configured", never the value', control: { type: 'boolean' }, defaultValue: false },
]

export const pluginConfigurationComponents: ComponentEntry[] = [
  {
    id: 'plugin-configuration-prompt',
    name: 'Plugin Configuration Prompt',
    category: 'Marketplace',
    description:
      'The enable-time prompt (plugins/components.md#when-the-configuration-dialog-appears). Asks for a plugin\'s declared options at the moment it is turned on, labelled by imported title with the imported description beneath, secrets masked, dismissable with Later.',
    component: PromptPreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      { name: 'Required key unset', description: 'The defect state: a token is needed and nothing asked for it', props: { requiredUnset: true, optionalUnset: false, secretField: true, importedText: true, configured: false } },
      { name: 'Optional key unset', description: 'Nothing is blocking — the prompt offers rather than demands', props: { requiredUnset: false, optionalUnset: true, secretField: false, importedText: true, configured: false } },
      { name: 'No imported title/description', description: 'A bundle that omitted them: the field falls back to its raw key and no help text renders', props: { requiredUnset: true, optionalUnset: false, secretField: true, importedText: false, configured: false } },
      { name: 'Already configured', description: 'Stored values are never displayed — the field says Configured and the input stays empty', props: { requiredUnset: true, optionalUnset: true, secretField: true, importedText: true, configured: true } },
    ],
  },
  {
    id: 'plugin-configuration-fields',
    name: 'Plugin Configuration Fields',
    category: 'Marketplace',
    description:
      'The same field list as rendered inside the plugin detail page — one component, so the prompt and the page can never disagree about how a field is labelled or whether it is masked.',
    component: FieldsPreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      { name: 'Secret + required + optional', description: 'All three field shapes together', props: { requiredUnset: true, optionalUnset: true, secretField: true, importedText: true, configured: false } },
      { name: 'Raw keys (no imported text)', description: 'What every field looked like before D15', props: { requiredUnset: true, optionalUnset: true, secretField: true, importedText: false, configured: false } },
    ],
  },
]
