import type { CredentialId, StoredCredential } from '../credentials/types.ts';
import type { PluginInstalledEntryV2 } from './store-v2.ts';
import type {
  PluginMcpCapability,
  PluginUserConfigurationDescriptor,
} from './types.ts';

export type PluginConfigurationValue = string | number | boolean | string[];
const FORBIDDEN_CONFIGURATION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * `plugins/manifest-reference.md#where-values-are-stored` — "Claude Code reads all `pluginConfigs` values from
 * only three settings sources": user settings (`:595`), `--settings`/SDK inline
 * settings (`:596`) and managed policy (`:597`), in the precedence `:599` gives
 * ("managed settings take precedence, then `--settings`, then user settings").
 *
 * `:601` is the reason this list is a list and not a comment: "Entries in a
 * project's `.claude/settings.json` or `.claude/settings.local.json` are
 * ignored. Both files live in the workspace, so a cloned repository could supply
 * values there, and those values would flow into plugin hook commands, MCP
 * server configs, LSP commands, and monitor commands."
 *
 * The restriction is specific to plugin option values. `:601`'s own closing
 * sentence keeps `enabledPlugins` honouring project and local settings, which is
 * what the trusted-project activation overlay
 * (`buildTrustedProjectPolicyOverlay` in
 * `packages/server-core/src/bootstrap/storage-runtime.ts`, gated on
 * `projectTrustState === 'trusted'` plus a `projectRoot`) already does — do NOT
 * reuse that pattern here. (It used to name `resolveRuntimeHookSources` too;
 * that was the V1 projection's half and was deleted with it.)
 */
export const PLUGIN_CONFIGURATION_SETTINGS_SOURCES = ['user', 'inline', 'managed'] as const;

export type TrustedPluginConfigurationSource = typeof PLUGIN_CONFIGURATION_SETTINGS_SOURCES[number];

/** Every settings source a configured value could conceivably arrive from. */
export type PluginConfigurationSource = TrustedPluginConfigurationSource | 'project' | 'local';

export interface PluginConfigurationLayer {
  source: PluginConfigurationSource;
  values: Record<string, unknown>;
}

export function isTrustedPluginConfigurationSource(
  source: PluginConfigurationSource,
): source is TrustedPluginConfigurationSource {
  return (PLUGIN_CONFIGURATION_SETTINGS_SOURCES as readonly string[]).includes(source);
}

/**
 * Throwing form of the source gate, for a caller that believes it already holds
 * a trusted layer. `resolvePluginConfigurationLayers` is the non-throwing one:
 * `:601` says a workspace-resident entry is IGNORED, not that it is an error.
 */
export function assertTrustedPluginConfigurationSource(source: PluginConfigurationSource): void {
  if (!isTrustedPluginConfigurationSource(source)) {
    throw new Error('plugin.configuration.untrusted-settings-source');
  }
}

/**
 * Merge configuration layers into the values a plugin may see.
 *
 * Workspace-resident layers are dropped whole — not filtered key by key, not
 * merged at lower precedence. A value from a cloned repository reaches hook
 * commands, MCP configs, LSP commands and monitor commands, so the only safe
 * handling is to never let it into the merge at all.
 */
export function resolvePluginConfigurationLayers(
  layers: readonly PluginConfigurationLayer[],
  fields: readonly PluginUserConfigurationDescriptor[],
): Record<string, PluginConfigurationValue> {
  const byKey = new Map(fields.map(field => [field.key, field]));
  const merged: Record<string, PluginConfigurationValue> = {};
  for (const source of PLUGIN_CONFIGURATION_SETTINGS_SOURCES) {
    for (const layer of layers) {
      if (layer.source !== source) continue;
      for (const [key, value] of Object.entries(layer.values)) {
        const field = byKey.get(key);
        if (FORBIDDEN_CONFIGURATION_KEYS.has(key) || !field || !isConfigurationValue(field, value)) continue;
        merged[key] = value as PluginConfigurationValue;
      }
    }
  }
  return merged;
}

/**
 * `plugins/manifest-reference.md#user-configuration` — a `sensitive` option "stores the value in secure
 * storage instead of `settings.json`". MCPB spells the same thing as the
 * `secret-ref` value type, so both spellings are answered here and nowhere else.
 */
export function isSensitivePluginConfigurationField(
  field: PluginUserConfigurationDescriptor,
): boolean {
  return field.valueType === 'secret-ref' || field.sensitive === true;
}

export interface PluginConfigurationFieldStatus {
  key: string;
  valueType: PluginUserConfigurationDescriptor['valueType'];
  required: boolean;
  hasDefault: boolean;
  configured: boolean;
  missing: boolean;
  /** `:571` — the caller masks the input for these. Never carries a value. */
  sensitive: boolean;
  /**
   * `plugins/manifest-reference.md#user-configuration` — "Label shown in the configuration dialog", and
   * `:570` — "Help text shown beneath the field". Both are REQUIRED fields of an
   * option declaration, and both were imported and then never rendered, so every
   * field was labelled with its raw key. A dialog that says `api_token` where
   * the author wrote "API token — API authentication token" is why a user does
   * not know what is being asked of them.
   *
   * Optional here because a bundle can omit them (the adapter records a
   * `claude_user_config_incomplete` warning and imports the option anyway); the
   * caller falls back to the key.
   */
  title?: string;
  description?: string;
}

export interface PluginConfigurationStatus {
  state: 'not-required' | 'needs_configuration' | 'ready';
  fields: PluginConfigurationFieldStatus[];
}

export interface PluginConfigurationCapability {
  capability: PluginMcpCapability;
  fields: PluginUserConfigurationDescriptor[];
  credentialId: CredentialId;
}

export function resolvePluginConfigurationCapability(
  installed: PluginInstalledEntryV2,
  workspaceId: string,
): PluginConfigurationCapability | undefined {
  const capability = installed.manifest.capabilities.find((candidate): candidate is PluginMcpCapability => (
    candidate.kind === 'mcp' && (candidate.mcp.userConfiguration?.length ?? 0) > 0
  ));
  if (!capability?.mcp.userConfiguration?.length) return undefined;
  return {
    capability,
    fields: capability.mcp.userConfiguration,
    credentialId: {
      type: 'source_apikey',
      workspaceId,
      sourceId: `mcpb:${installed.pluginKey}:${capability.id}`,
    },
  };
}

/**
 * Plugin-LEVEL user options (`plugins/manifest-reference.md#user-configuration`'s `userConfig`), split by
 * the storage rule the contract states:
 *
 * - `:591` — sensitive values go to secure storage. Here that is the credential
 *   manager, the same store MCPB's configuration already uses.
 * - `:589` — everything else is "stored under the `pluginConfigs` key in your
 *   user `settings.json`". Here that is `PluginUserConfigStore`, a user-scoped
 *   file under the plugin's managed data root. Nothing in the workspace.
 *
 * MCPB keeps its stricter behaviour: every one of its `user_config` values,
 * sensitive or not, stays in the credential manager. That is not the documented
 * split, but loosening it would migrate values that are already stored and would
 * move existing secrets to a less protected file — a regression dressed as
 * conformance.
 */
export interface PluginUserConfiguration {
  fields: PluginUserConfigurationDescriptor[];
  sensitiveFields: PluginUserConfigurationDescriptor[];
  plainFields: PluginUserConfigurationDescriptor[];
  credentialId: CredentialId;
}

export function resolvePluginUserConfiguration(
  installed: PluginInstalledEntryV2,
  workspaceId: string,
): PluginUserConfiguration | undefined {
  const fields = installed.manifest.nessyExtensions?.userConfiguration ?? [];
  if (fields.length === 0) return undefined;
  return {
    fields,
    sensitiveFields: fields.filter(field => isSensitivePluginConfigurationField(field)),
    plainFields: fields.filter(field => !isSensitivePluginConfigurationField(field)),
    credentialId: {
      type: 'source_apikey',
      workspaceId,
      sourceId: `plugin-config:${installed.pluginKey}`,
    },
  };
}

/**
 * Configured values with `:573`'s declared defaults filled in for anything the
 * user has not set — the "value used when the user provides nothing".
 */
function pluginConfigurationEffectiveValues(
  fields: readonly PluginUserConfigurationDescriptor[],
  values: Record<string, PluginConfigurationValue>,
): Record<string, PluginConfigurationValue> {
  const effective: Record<string, PluginConfigurationValue> = {};
  for (const field of fields) {
    if (Object.hasOwn(values, field.key)) effective[field.key] = values[field.key]!;
    else if (field.defaultValue !== undefined) effective[field.key] = field.defaultValue;
  }
  return effective;
}

/**
 * `plugins/manifest-reference.md#environment-variables` — "All values are exported to hook processes as
 * `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables, where `<KEY>` is the
 * option key uppercased."
 *
 * ALL values, including sensitive ones: `:583` names this environment variable
 * as the documented alternative for exactly the shell-form case where
 * substitution is refused, and a plugin that cannot read its own token from the
 * environment has no other way to receive it. Hook processes are already trusted
 * with the plugin's bundle and its data directory. `:334` is the counterpart —
 * monitor processes do NOT receive these, so nothing here may be reused for a
 * monitor.
 *
 * A `multiple` option is JSON-encoded: an environment variable is one string,
 * and JSON is the only encoding of a string array that survives a value
 * containing the separator.
 */
export function pluginOptionEnvironment(
  fields: readonly PluginUserConfigurationDescriptor[],
  values: Record<string, PluginConfigurationValue>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(pluginConfigurationEffectiveValues(fields, values))) {
    environment[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] = Array.isArray(value)
      ? JSON.stringify(value)
      : String(value);
  }
  return environment;
}

export function readPluginConfiguration(
  credential: StoredCredential | null | undefined,
  fields: readonly PluginUserConfigurationDescriptor[],
): Record<string, PluginConfigurationValue> {
  if (!credential?.value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential.value) as unknown;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const input = parsed as Record<string, unknown>;
  return Object.fromEntries(fields.flatMap(field => (
    isConfigurationValue(field, input[field.key]) ? [[field.key, input[field.key] as PluginConfigurationValue]] : []
  )));
}

export function mergePluginConfiguration(
  fields: readonly PluginUserConfigurationDescriptor[],
  current: Record<string, PluginConfigurationValue>,
  input: Record<string, unknown>,
): Record<string, PluginConfigurationValue> {
  if (Object.keys(input).length > 128) throw new Error('plugin.configuration.invalid-values');
  const byKey = new Map(fields.map(field => [field.key, field]));
  const merged: Record<string, PluginConfigurationValue> = Object.assign(Object.create(null), current);
  for (const [key, value] of Object.entries(input)) {
    const field = byKey.get(key);
    if (FORBIDDEN_CONFIGURATION_KEYS.has(key) || !field || !isConfigurationValue(field, value)) {
      throw new Error('plugin.configuration.invalid-values');
    }
    merged[key] = value as PluginConfigurationValue;
  }
  if (missingPluginConfigurationKeys(fields, merged).length > 0) {
    throw new Error('plugin.configuration.required-missing');
  }
  return Object.fromEntries(Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)));
}

export function pluginConfigurationStatus(
  fields: readonly PluginUserConfigurationDescriptor[],
  values: Record<string, PluginConfigurationValue>,
): PluginConfigurationStatus {
  const missing = new Set(missingPluginConfigurationKeys(fields, values));
  const safeFields = fields.map(field => ({
    key: field.key,
    valueType: field.valueType,
    required: field.required === true,
    hasDefault: field.defaultValue !== undefined,
    configured: Object.hasOwn(values, field.key),
    missing: missing.has(field.key),
    sensitive: isSensitivePluginConfigurationField(field),
    ...(field.title ? { title: field.title } : {}),
    ...(field.description ? { description: field.description } : {}),
  }));
  return {
    state: safeFields.length === 0 ? 'not-required' : missing.size > 0 ? 'needs_configuration' : 'ready',
    fields: safeFields,
  };
}

export function missingPluginConfigurationKeys(
  fields: readonly PluginUserConfigurationDescriptor[],
  values: Record<string, PluginConfigurationValue>,
): string[] {
  return fields
    .filter(field => field.required === true
      && field.defaultValue === undefined
      && !Object.hasOwn(values, field.key))
    .map(field => field.key)
    .sort();
}

function isConfigurationValue(field: PluginUserConfigurationDescriptor, value: unknown): boolean {
  // `:574` — `multiple` makes the value an array of strings, so the scalar
  // checks below would silently reject every conforming value.
  if (field.multiple === true) {
    return Array.isArray(value)
      && value.length <= 1_024
      && value.every(item => isConfigurationText(item));
  }
  if (field.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    // `:575` — declared bounds are part of the contract, not a display hint.
    if (typeof field.min === 'number' && value < field.min) return false;
    if (typeof field.max === 'number' && value > field.max) return false;
    return true;
  }
  if (field.valueType === 'boolean') return typeof value === 'boolean';
  return isConfigurationText(value);
}

function isConfigurationText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 65_536;
}
