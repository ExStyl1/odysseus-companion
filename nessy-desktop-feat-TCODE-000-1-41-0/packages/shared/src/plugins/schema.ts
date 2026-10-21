import {
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  type NessyPluginManifest,
  type PluginAgentCapability,
  type PluginAppDescriptor,
  type PluginConnectorAuthDescriptor,
  type PluginConnectorAuthTiming,
  type PluginConnectorDescriptor,
  type PluginConnectorMcpServerDescriptor,
  type PluginAssetCapability,
  type PluginAssetDescriptor,
  type PluginCapability,
  type PluginCapabilityKind,
  type PluginCommandCapability,
  type PluginCommandDescriptor,
  type PluginDefaultSettingsDescriptor,
  type PluginDependencyDescriptor,
  type PluginDiagnostic,
  type PluginHookCapability,
  type PluginLspCapability,
  type PluginCommandMonitorDescriptor,
  type PluginMonitorCapability,
  type PluginMcpCapability,
  type PluginNessyExtensions,
  type PluginOrigin,
  type PluginOutputStyleCapability,
  type PluginPromptCommandCapability,
  type PluginWorkflowCapability,
  type PluginRuntimeCompatibility,
  type PluginRuntimeCompatibilityProfile,
  type PluginSettingCapability,
  type PluginSettingDescriptor,
  type PluginSkillCapability,
  type PluginUnsupportedCapability,
  type PluginUserConfigurationDescriptor,
  type PluginValidationResult,
} from './types.ts';
import { Cron } from 'croner';
import { validRange } from 'semver';
import { normalizeMcpTransportAlias } from '../mcp/server-config-values.ts';
// The SAME parser the `if` filter is evaluated with — imported, not
// re-implemented, so registration and evaluation cannot disagree about which
// rule strings are unparseable. It never throws and never enforces (its own
// header); the posture is the caller's, and this caller's is warn-and-register.
import { parseClaudeRuleString } from '../agent/pi-harness/claude-permission-rules.ts';

const PLUGIN_RUNTIME_COMPATIBILITY_PROFILES: readonly PluginRuntimeCompatibilityProfile[] = [
  'generic-plugin-env-v1',
  'codex-plugin-env-v1',
  'claude-plugin-env-v1',
] as const;

type UnknownRecord = Record<string, unknown>;

export function pluginDiagnostic(
  severity: PluginDiagnostic['severity'],
  code: string,
  message: string,
  path?: string,
  details?: Record<string, unknown>,
): PluginDiagnostic {
  return {
    severity,
    code,
    message,
    ...(path ? { path } : {}),
    ...(details ? { details } : {}),
  };
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(record: UnknownRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

/**
 * A command hook's `args` vector (hooks.md § Exec form and shell form).
 *
 * NOT `readStringArray`: there, an empty array collapses to `undefined`, and
 * for hooks that silently turns exec form back into shell form — `"args": []`
 * is the page's own spelling for "spawn this executable directly with no
 * arguments" and it appears in six of its examples. Presence selects the form,
 * so an empty vector has to survive. A non-string element invalidates the whole
 * vector rather than being filtered out of it: dropping one element of an
 * argument vector changes what runs.
 */
export function readHookArgsVector(value: unknown): { args?: string[]; invalid?: boolean } {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) return { invalid: true };
  if (value.some(entry => typeof entry !== 'string')) return { invalid: true };
  return { args: value as string[] };
}

function readRequiredUniqueStringArray(
  value: unknown,
  path: string,
  diagnostics: PluginDiagnostic[],
): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.lsp.languages_required', 'LSP server languages must be a non-empty array of exact language IDs.', path));
    return undefined;
  }
  const languages = value.map(entry => typeof entry === 'string' ? entry.trim() : '');
  if (languages.some(language => !language) || new Set(languages).size !== languages.length) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.lsp.languages_invalid', 'LSP server languages must contain unique non-empty exact language IDs.', path));
    return undefined;
  }
  return languages;
}

function settingDefaultMatches(valueType: PluginSettingDescriptor['valueType'], value: unknown): value is string | number | boolean {
  return (valueType === 'string' && typeof value === 'string')
    || (valueType === 'number' && typeof value === 'number' && Number.isFinite(value))
    || (valueType === 'boolean' && typeof value === 'boolean');
}

export function isValidPluginMonitorCron(cron: string): boolean {
  if (cron.trim().split(/\s+/).length !== 5) return false;
  try {
    new Cron(cron);
    return true;
  } catch {
    return false;
  }
}

export function isValidPluginMonitorTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizeUserConfiguration(
  value: unknown,
  path: string,
  diagnostics: PluginDiagnostic[],
): PluginUserConfigurationDescriptor[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.user_configuration_invalid', 'MCP user configuration must be an array of at most 128 fields.', path));
    return undefined;
  }
  const result: PluginUserConfigurationDescriptor[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const fieldPath = `${path}.${index}`;
    if (!isRecord(raw)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.user_configuration_invalid', 'MCP user configuration field must be an object.', fieldPath));
      continue;
    }
    const key = readString(raw, 'key');
    const valueType = readString(raw, 'valueType');
    if (!key || !/^[A-Za-z0-9._-]+$/.test(key)
      || key === '__proto__' || key === 'constructor' || key === 'prototype' || keys.has(key)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.user_configuration_invalid', 'MCP user configuration keys must be unique safe identifiers.', `${fieldPath}.key`));
      continue;
    }
    if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean'
      && valueType !== 'file' && valueType !== 'directory' && valueType !== 'secret-ref') {
      diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.user_configuration_invalid', 'MCP user configuration has an unsupported value type.', `${fieldPath}.valueType`));
      continue;
    }
    if ((raw.required !== undefined && typeof raw.required !== 'boolean')
      || (raw.sensitive !== undefined && typeof raw.sensitive !== 'boolean')
      || (raw.multiple !== undefined && typeof raw.multiple !== 'boolean')) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.user_configuration_invalid', 'MCP user configuration required must be a boolean.', `${fieldPath}.required`));
      continue;
    }
    // `plugins/manifest-reference.md#user-configuration` scopes `multiple` to `string` and `:575` scopes
    // `min`/`max` to `number`. Accepting either elsewhere would carry a flag no
    // storage path can honour.
    if (raw.multiple === true && valueType !== 'string') {
      diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.user_configuration_invalid', 'MCP user configuration multiple applies to string fields only.', `${fieldPath}.multiple`));
      continue;
    }
    const min = raw.min;
    const max = raw.max;
    const boundsValid = (min === undefined || (typeof min === 'number' && Number.isFinite(min)))
      && (max === undefined || (typeof max === 'number' && Number.isFinite(max)))
      && ((min === undefined && max === undefined) || valueType === 'number')
      && (typeof min !== 'number' || typeof max !== 'number' || min <= max);
    if (!boundsValid) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.user_configuration_invalid', 'MCP user configuration min/max bounds are invalid.', `${fieldPath}.min`));
      continue;
    }
    const multiple = raw.multiple === true;
    const sensitive = raw.sensitive === true;
    const defaultValue = raw.defaultValue;
    const validDefault = defaultValue === undefined
      || (multiple
        ? Array.isArray(defaultValue) && defaultValue.every(item => typeof item === 'string')
        : (valueType === 'number' && typeof defaultValue === 'number' && Number.isFinite(defaultValue))
          || (valueType === 'boolean' && typeof defaultValue === 'boolean')
          || ((valueType === 'string' || valueType === 'file' || valueType === 'directory') && typeof defaultValue === 'string'));
    // `:571` puts a sensitive value in secure storage; a manifest-declared
    // default would put the same value in a plaintext manifest instead.
    if (!validDefault || ((valueType === 'secret-ref' || sensitive) && defaultValue !== undefined)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.user_configuration_invalid', 'MCP user configuration default does not match its value type.', `${fieldPath}.defaultValue`));
      continue;
    }
    const title = readString(raw, 'title');
    const description = readString(raw, 'description');
    keys.add(key);
    result.push({
      key,
      valueType,
      ...(raw.required === true ? { required: true } : {}),
      ...(defaultValue !== undefined ? { defaultValue: defaultValue as string | number | boolean | string[] } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(sensitive ? { sensitive: true } : {}),
      ...(multiple ? { multiple: true } : {}),
      ...(typeof min === 'number' ? { min } : {}),
      ...(typeof max === 'number' ? { max } : {}),
    });
  }
  return result;
}

/**
 * The charset a plugin id must satisfy here, and the ONE place the divergence
 * from upstream is stated to the author who trips over it.
 *
 * ## P2.468 — the stricter rule stays; the refusal now names the divergence
 *
 * Measured (P2.443, pinned in `plugins/__tests__/bundle-validation.test.ts`):
 * `-my-plugin` draws a **non-blocking kebab-case warning** from the shipped
 * Claude binary and passes validation there, while this fork refuses it with a
 * hard `plugin.manifest.invalid_id`. Owner-delegated controller decision,
 * 2026-09-02 (§F3): **keep the stricter rule, and make the refusal say why.**
 *
 * Why stricter is right here rather than an alignment bug: upstream's id reaches
 * a manifest, ours reaches **filesystem paths and store keys** — a leading `-`
 * is an option introducer to every POSIX tool that will ever be handed one of
 * those paths, and a store key is a name we index by. So the rule is a product
 * posture, and under the standing rule a posture is said out loud rather than
 * decided quietly inside a validator.
 *
 * Why the MESSAGE had to change and not just this comment: an author whose
 * plugin validates clean upstream and is refused here learns nothing from a
 * charset error — it reads as a defect in us, which is the *refusal
 * indistinguishable from a failure* shape (P2.429, P2.464). The two failures are
 * therefore told apart:
 *
 * - the id contains a character we do not accept **anywhere** (`my$plugin`) —
 *   upstream's own name check rejects that class too, so there is no divergence
 *   to name and the message stays the plain charset one;
 * - every character is one we accept, and only the FIRST is misplaced
 *   (`-my-plugin`, `.hidden`, `_x`) — this is exactly the band where upstream
 *   warns and we refuse, so the message names the divergence and the reason.
 *
 * Shared with capability ids (`plugin.capability.invalid_id`), where the same
 * sentence still holds: a capability id is composed into the same store keys.
 */
const PLUGIN_ID_CHARSET = /^[A-Za-z0-9._-]*$/;
const PLUGIN_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validatePluginId(id: string): string | null {
  if (!id.trim()) return 'Plugin id is required';
  if (PLUGIN_ID_SHAPE.test(id)) return null;
  if (PLUGIN_ID_CHARSET.test(id)) {
    return `Plugin id must start with a letter or number, and "${id}" starts with "${id[0]}". `
      + 'Claude Code accepts this id with a non-blocking kebab-case warning; Nessy refuses it, '
      + 'because a plugin id here becomes a filesystem path and a store key.';
  }
  return 'Plugin id may only contain letters, numbers, dot, underscore, and dash';
}

export function validatePluginVersion(version: string): string | null {
  if (!version.trim()) return 'Plugin version is required';
  if (version.includes('/') || version.includes('\\') || version.includes('\0')) {
    return 'Plugin version must not contain path separators';
  }
  return null;
}

export function validatePluginRelativePath(path: string): string | null {
  if (!path.trim()) return 'Path is required';
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:\//.test(path)) return `Absolute path not allowed: ${path}`;
  if (path.includes('\\')) return `Backslash path separator not allowed: ${path}`;
  if (path.includes('\0')) return `NUL byte not allowed: ${path}`;
  const parts = path.split('/');
  if (parts.some(part => part === '..')) return `Path traversal detected: ${path}`;
  if (parts.some(part => part.length === 0)) return `Empty path segment not allowed: ${path}`;
  return null;
}

const PLUGIN_RUNTIME_ROOT = '${NESSY_PLUGIN_ROOT}';

/** MCP cwd is bundle-relative, with the canonical plugin-root token as the only root alias. */
export function validatePluginMcpCwd(path: string): string | null {
  if (path === PLUGIN_RUNTIME_ROOT) return null;
  if (path.startsWith(`${PLUGIN_RUNTIME_ROOT}/`)) {
    return validatePluginRelativePath(path.slice(PLUGIN_RUNTIME_ROOT.length + 1));
  }
  if (path.includes('${') || /\$[A-Za-z_]/.test(path)) {
    return `Unsupported runtime path variable: ${path}`;
  }
  return validatePluginRelativePath(path);
}

/**
 * Every canonical runtime path root a plugin declaration may be rooted at.
 * `plugins-reference.md` § Environment variables: "Claude Code provides three
 * variables for referencing paths" — the plugin directory, its persistent data
 * directory, and the project root — all three rewritten to their Nessy
 * spellings at import.
 */
const PLUGIN_RUNTIME_PATH_ROOTS = [
  PLUGIN_RUNTIME_ROOT,
  '${NESSY_PLUGIN_DATA}',
  '${NESSY_PROJECT_DIR}',
];

/**
 * An LSP server's `workspaceFolder`, which unlike an MCP `cwd` may legitimately
 * be rooted at the PROJECT: the same § Environment variables section names
 * `workspaceFolder` as one of the four LSP fields those placeholders resolve in.
 * Past the root the shape is the bundle-relative one — no absolute path, no
 * traversal, no other shell variable.
 */
export function validatePluginLspWorkspaceFolder(path: string): string | null {
  for (const root of PLUGIN_RUNTIME_PATH_ROOTS) {
    if (path === root) return null;
    if (path.startsWith(`${root}/`)) return validatePluginRelativePath(path.slice(root.length + 1));
  }
  if (path.includes('${') || /\$[A-Za-z_]/.test(path)) {
    return `Unsupported runtime path variable: ${path}`;
  }
  return validatePluginRelativePath(path);
}

/**
 * Collision-safe capability id (A2). Always includes `kind`, so a skill and an
 * MCP server sharing the same provider-local name never collide on id. The
 * provider-facing name stays available separately as `logicalName` on
 * capabilities/projection candidates — this helper never replaces it.
 *
 * Joins with `.` (not `:`): every capability id is validated through
 * `validatePluginId` (`normalizePluginCapability`), whose accepted charset is
 * `[A-Za-z0-9._-]` — `:` is outside it, so a `:`-joined id always failed as
 * `plugin.capability.invalid_id`. `.` keeps the same collision-safety
 * guarantee while staying validator-legal.
 */
export function createPluginCapabilityId(kind: PluginCapabilityKind, providerLocalId: string): string {
  return `${kind}.${providerLocalId}`;
}

/**
 * Validates a runtime-compatibility profile set (A2). Rejects unknown profile
 * values and duplicates. The profile is semantic only — this validator never
 * reads or produces adapterId/origin/format, and the returned value carries
 * none.
 */
export function validatePluginRuntimeCompatibility(
  input: unknown,
): PluginValidationResult<PluginRuntimeCompatibility> {
  const diagnostics: PluginDiagnostic[] = [];
  if (!isRecord(input) || !Array.isArray(input.profiles)) {
    return {
      ok: false,
      diagnostics: [pluginDiagnostic('error', 'plugin.runtime_compatibility.not_object', 'Runtime compatibility must be an object with a profiles array', 'runtimeCompatibility')],
    };
  }

  const seen = new Set<string>();
  const profiles: PluginRuntimeCompatibilityProfile[] = [];
  input.profiles.forEach((raw, index) => {
    if (typeof raw !== 'string' || !PLUGIN_RUNTIME_COMPATIBILITY_PROFILES.includes(raw as PluginRuntimeCompatibilityProfile)) {
      diagnostics.push(pluginDiagnostic(
        'error',
        'plugin.runtime_compatibility.unknown_profile',
        `Unknown runtime compatibility profile "${String(raw)}"`,
        `runtimeCompatibility.profiles.${index}`,
      ));
      return;
    }
    if (seen.has(raw)) {
      diagnostics.push(pluginDiagnostic(
        'error',
        'plugin.runtime_compatibility.duplicate_profile',
        `Duplicate runtime compatibility profile "${raw}"`,
        `runtimeCompatibility.profiles.${index}`,
      ));
      return;
    }
    seen.add(raw);
    profiles.push(raw as PluginRuntimeCompatibilityProfile);
  });

  if (input.profiles.length === 0) {
    diagnostics.push(pluginDiagnostic(
      'error',
      'plugin.runtime_compatibility.missing_profile',
      'Runtime compatibility must declare exactly one profile',
      'runtimeCompatibility.profiles',
    ));
  }

  if (profiles.length > 1) {
    diagnostics.push(pluginDiagnostic(
      'error',
      'plugin.runtime_compatibility.profile_conflict',
      'A plugin bundle may declare only one runtime compatibility profile',
      'runtimeCompatibility.profiles',
    ));
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: { profiles }, diagnostics };
}

export interface NormalizeManifestOptions {
  origin?: PluginOrigin;
  allowLegacyExtensionKind?: boolean;
  /**
   * W7 Step 5: Nessy-owned formats declare setting/command/asset capabilities
   * first-class, so THEIR adapters may populate the namespaced `nessyExtensions`
   * provenance explicitly by deriving it from the declared capabilities.
   * External-format adapters (e.g. Codex) MUST NOT set this — a generic
   * external manifest never gains those capabilities accidentally.
   */
  deriveNessyExtensionsFromCapabilities?: boolean;
}

export function normalizeNessyPluginManifest(
  input: unknown,
  options: NormalizeManifestOptions = {},
): PluginValidationResult<NessyPluginManifest> {
  const diagnostics: PluginDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      diagnostics: [pluginDiagnostic('error', 'plugin.manifest.not_object', 'Plugin manifest must be an object')],
    };
  }

  const rawKind = readString(input, 'kind');
  if (rawKind && rawKind !== 'plugin') {
    const isLegacyExtension = rawKind.toLowerCase().includes('extension');
    if (!options.allowLegacyExtensionKind || !isLegacyExtension) {
      diagnostics.push(pluginDiagnostic(
        'error',
        'plugin.manifest.invalid_kind',
        `Unsupported manifest kind "${rawKind}". Nessy manifests use "plugin".`,
        'kind',
      ));
    } else {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.manifest.legacy_extension_kind',
        `Legacy external kind "${rawKind}" was normalized to plugin.`,
        'kind',
      ));
    }
  }

  const id = readString(input, 'id') ?? readString(input, 'pluginId');
  const name = readString(input, 'name') ?? id;
  const version = readString(input, 'version');

  if (!id) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.manifest.missing_id', 'Plugin id is required', 'id'));
  } else {
    const idError = validatePluginId(id);
    if (idError) diagnostics.push(pluginDiagnostic('error', 'plugin.manifest.invalid_id', idError, 'id'));
  }

  if (!name) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.manifest.missing_name', 'Plugin name is required', 'name'));
  }

  if (!version) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.manifest.missing_version', 'Plugin version is required', 'version'));
  } else {
    const versionError = validatePluginVersion(version);
    if (versionError) diagnostics.push(pluginDiagnostic('error', 'plugin.manifest.invalid_version', versionError, 'version'));
  }

  const rawCapabilities = input.capabilities;
  if (!Array.isArray(rawCapabilities)) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.manifest.capabilities_not_array', 'Plugin capabilities must be an array', 'capabilities'));
  }

  const capabilities: PluginCapability[] = [];
  if (Array.isArray(rawCapabilities)) {
    const seen = new Set<string>();
    rawCapabilities.forEach((entry, index) => {
      const result = normalizePluginCapability(entry, `capabilities.${index}`);
      diagnostics.push(...result.diagnostics);
      if (!result.ok || !result.value) return;
      if (seen.has(result.value.id)) {
        diagnostics.push(pluginDiagnostic(
          'error',
          'plugin.capability.duplicate_id',
          `Duplicate capability id "${result.value.id}"`,
          `capabilities.${index}.id`,
        ));
        return;
      }
      seen.add(result.value.id);
      capabilities.push(result.value);
    });
  }

  const runtimeCompatibility = input.runtimeCompatibility === undefined
    ? undefined
    : validatePluginRuntimeCompatibility(input.runtimeCompatibility);
  if (runtimeCompatibility) diagnostics.push(...runtimeCompatibility.diagnostics);

  const dependencies = normalizePluginDependencies(input.dependencies, diagnostics);

  if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !id || !name || !version) {
    return { ok: false, diagnostics };
  }

  const nessyExtensions = resolveNessyExtensions(input, capabilities, options, diagnostics);
  const apps = readAppDescriptors(input);
  // T9 (plugin-install plan § 0b-3) + C3 (capability-path plan): EVERY
  // connector server rides the capability path — stdio since T9, remote since
  // C3 (as an auth-carrying `kind:'mcp'` capability). Only app-REFERENCED
  // connectors survive normalization, as declarative routing metadata (apps
  // route by `connectorId` + `serverName`); their servers still get capability
  // twins, and the twin is what excludes them from Source materialization.
  const connectors = rerouteConnectorServers(
    readConnectorDescriptors(input),
    capabilities,
    diagnostics,
    new Set(apps.map(app => app.connectorId)),
  );
  const manifest: NessyPluginManifest = {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    kind: 'plugin',
    id,
    name,
    version,
    ...(readString(input, 'description') ? { description: readString(input, 'description') } : {}),
    ...(readString(input, 'publisher') ? { publisher: readString(input, 'publisher') } : {}),
    ...(readString(input, 'homepageUrl') ?? readString(input, 'homepage') ? {
      homepageUrl: readString(input, 'homepageUrl') ?? readString(input, 'homepage'),
    } : {}),
    capabilities,
    // `plugins-reference.md` § Default enablement. Adapters emit this, and it
    // used to die here: this function rebuilds the manifest field by field and
    // never copied it, so an author's `defaultEnabled: false` was destroyed
    // before the store write and the plugin installed ENABLED — the opposite of
    // what shipping it disabled is for.
    ...(readBoolean(input, 'defaultEnabled') !== undefined
      ? { defaultEnabled: readBoolean(input, 'defaultEnabled') }
      : {}),
    // `plugins/manifest-reference.md#dependencies`. Copied here explicitly for the reason the
    // comment above records: this rebuild is where a field silently dies, and a
    // bundle-only plugin (`name` + `dependencies`, blessed by `:52`) has nothing
    // else in it — losing the array leaves a plugin that does nothing at all.
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(apps.length > 0 ? { apps } : {}),
    ...(connectors.length > 0 ? { connectors } : {}),
    ...(nessyExtensions ? { nessyExtensions } : {}),
    ...(runtimeCompatibility?.value ? { runtimeCompatibility: runtimeCompatibility.value } : {}),
    ...(rawKind && rawKind !== 'plugin' ? {
      compatibility: {
        rawExternalKind: rawKind,
        ...(options.origin?.adapterId ? {
          adapter: {
            adapterId: options.origin.adapterId,
            ...(options.origin.adapterVersion ? { adapterVersion: options.origin.adapterVersion } : {}),
            rawKind,
            warnings: diagnostics.filter((diagnostic): diagnostic is PluginDiagnostic & { severity: 'warning' } => diagnostic.severity === 'warning'),
          },
        } : {}),
      },
    } : {}),
  };

  return { ok: true, value: manifest, diagnostics };
}

export function normalizePluginCapability(input: unknown, path = 'capability'): PluginValidationResult<PluginCapability> {
  const diagnostics: PluginDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      diagnostics: [pluginDiagnostic('error', 'plugin.capability.not_object', 'Capability must be an object', path)],
    };
  }

  const id = readString(input, 'id');
  const kind = readString(input, 'kind');
  if (!id) diagnostics.push(pluginDiagnostic('error', 'plugin.capability.missing_id', 'Capability id is required', `${path}.id`));
  if (!kind) diagnostics.push(pluginDiagnostic('error', 'plugin.capability.missing_kind', 'Capability kind is required', `${path}.kind`));
  if (id) {
    const idError = validatePluginId(id);
    if (idError) diagnostics.push(pluginDiagnostic('error', 'plugin.capability.invalid_id', idError, `${path}.id`));
  }

  if (!id || !kind || diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    return { ok: false, diagnostics };
  }

  const base = {
    id,
    displayName: readString(input, 'displayName') ?? readString(input, 'name'),
    description: readString(input, 'description'),
    enabledByDefault: readBoolean(input, 'enabledByDefault'),
    trust: normalizeTrustRequirement(input.trust),
  };

  switch (kind) {
    case 'skill': {
      const skillRecord = isRecord(input.skill) ? input.skill : input;
      const slug = readString(skillRecord, 'slug') ?? id;
      const skillPath = readString(skillRecord, 'path') ?? `${slug}/SKILL.md`;
      const pathError = validatePluginRelativePath(skillPath);
      if (pathError) diagnostics.push(pluginDiagnostic('error', 'plugin.skill.invalid_path', pathError, `${path}.skill.path`));
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) return { ok: false, diagnostics };
      // A manifest may state the author's invocation restrictions directly; keep
      // them rather than dropping them and relying on the SKILL.md frontmatter
      // pass, so an explicit declaration is never silently lost. Both documented
      // spellings parse, matching `readSkillInvocationControls`.
      const disableModelInvocation = readBoolean(skillRecord, 'disableModelInvocation')
        ?? readBoolean(skillRecord, 'disable-model-invocation');
      const userInvocable = readBoolean(skillRecord, 'userInvocable')
        ?? readBoolean(skillRecord, 'user-invocable');
      // `allowedTools` and `paths` complete the same set. They are copied here
      // for one blunt reason: normalization runs a SECOND time on install
      // (`management-service-v2.ts:857`), so a field this branch rebuilds
      // without is stripped from the stored record even though
      // `applyPluginSkillFrontmatter` decoded it from SKILL.md. That drop made
      // `pluginSkillInvocationControls` produce no `skillAllowedTools` for any
      // installed plugin, which in turn left F2's inert-component list and T3's
      // bare→wire translation dead on the only road a real user drives — found
      // by the G6 live gate, 2026-08-11. Both documented spellings parse, as
      // above.
      const allowedTools = readStringArray(skillRecord.allowedTools)
        ?? readStringArray(skillRecord['allowed-tools']);
      const paths = readStringArray(skillRecord.paths);
      const capability: PluginSkillCapability = {
        ...base,
        kind: 'skill',
        skill: {
          slug,
          path: skillPath,
          ...(readString(skillRecord, 'entrypoint') ? { entrypoint: readString(skillRecord, 'entrypoint') } : {}),
          ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
          ...(userInvocable === undefined ? {} : { userInvocable }),
          ...(allowedTools ? { allowedTools } : {}),
          ...(paths ? { paths } : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'mcp': {
      const mcpRecord = isRecord(input.mcp) ? input.mcp : input;
      const serverName = readString(mcpRecord, 'serverName') ?? readString(mcpRecord, 'name') ?? id;
      // `mcp.md:83` names `streamable-http` as an alias for `http`; folded
      // before the gate so a native manifest whose `mcp.transport` was copied
      // from an MCP server's own docs is not rejected. `PluginMcpDescriptor.transport`
      // stays `'stdio' | 'http' | 'sse' | 'ws'` — this is a fold, not a widening.
      const transport = normalizeMcpTransportAlias(readString(mcpRecord, 'transport') ?? (readString(mcpRecord, 'command') ? 'stdio' : 'http'));
      // `ws` joins the remote transports here, not just in the adapter: the
      // schema is the last gate before a capability id exists, so a transport
      // the schema refuses cannot be imported however far the adapter carries it.
      if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse' && transport !== 'ws') {
        diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.invalid_transport', `Unsupported MCP transport "${transport}"`, `${path}.mcp.transport`));
        return { ok: false, diagnostics };
      }
      const command = readString(mcpRecord, 'command');
      const url = readString(mcpRecord, 'url');
      const cwd = readString(mcpRecord, 'cwd');
      if (transport === 'stdio' && !command) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.missing_command', 'Stdio MCP capability requires command', `${path}.mcp.command`));
      }
      const isRemote = transport === 'http' || transport === 'sse' || transport === 'ws';
      if (isRemote && !url) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.missing_url', `${transport} MCP capability requires url`, `${path}.mcp.url`));
      }
      // A ws capability must carry a ws scheme and an http one an http scheme —
      // accepting either for both would let a bundle declare a transport it does
      // not have, and the pool would then build the wrong client.
      if (isRemote && url && !isValidMcpRemoteUrl(url, transport)) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.invalid_url', `Invalid MCP ${transport} URL: ${url}`, `${path}.mcp.url`));
      }
      if (cwd) {
        const cwdError = validatePluginMcpCwd(cwd);
        if (cwdError) diagnostics.push(pluginDiagnostic('error', 'plugin.mcp.invalid_cwd', cwdError, `${path}.mcp.cwd`));
      }
      const userConfiguration = normalizeUserConfiguration(
        mcpRecord.userConfiguration,
        `${path}.mcp.userConfiguration`,
        diagnostics,
      );
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) return { ok: false, diagnostics };
      const capability: PluginMcpCapability = {
        ...base,
        kind: 'mcp',
        mcp: {
          serverName,
          transport,
          ...(command ? { command } : {}),
          ...(readStringArray(mcpRecord.args) ? { args: readStringArray(mcpRecord.args) } : {}),
          ...(cwd ? { cwd } : {}),
          ...(url ? { url } : {}),
          ...(isStringRecord(mcpRecord.env) ? { env: mcpRecord.env } : {}),
          ...(isStringRecord(mcpRecord.environmentDefaults)
            ? { environmentDefaults: mcpRecord.environmentDefaults }
            : {}),
          ...(isStringRecord(mcpRecord.environmentSources)
            ? { environmentSources: mcpRecord.environmentSources }
            : {}),
          ...(isStringRecord(mcpRecord.credentialEnvironment)
            ? { credentialEnvironment: mcpRecord.credentialEnvironment }
            : {}),
          ...(userConfiguration?.length ? { userConfiguration } : {}),
          ...(readStringArray(mcpRecord.requiredEnvironmentNames)
            ? { requiredEnvironmentNames: readStringArray(mcpRecord.requiredEnvironmentNames) }
            : {}),
          ...(typeof mcpRecord.toolTimeoutMs === 'number'
            && Number.isSafeInteger(mcpRecord.toolTimeoutMs)
            && mcpRecord.toolTimeoutMs > 0
            ? { toolTimeoutMs: mcpRecord.toolTimeoutMs }
            : {}),
          ...(typeof mcpRecord.required === 'boolean' ? { required: mcpRecord.required } : {}),
          ...(mcpRecord.alwaysLoad === true ? { alwaysLoad: true } : {}),
          ...(isStringRecord(mcpRecord.headers) ? { headers: mcpRecord.headers } : {}),
          // `mcp.md:768`: dynamic-header shell command, remote transports only
          // (`mcp.md:765-785` http/sse, `:147` ws). Must be carried here or the
          // persisted-manifest re-parse strips what the adapter imported.
          ...(isRemote && readString(mcpRecord, 'headersHelper')
            ? { headersHelper: readString(mcpRecord, 'headersHelper') }
            : {}),
          // C3 (capability-path): declared endpoint auth for a remote server —
          // binds the server to its global plugin credential slot at runtime.
          ...(isRemote && (mcpRecord.authType === 'oauth' || mcpRecord.authType === 'bearer')
            ? { authType: mcpRecord.authType }
            : {}),
          ...(isRemote && readString(mcpRecord, 'oauthResource')
            ? { oauthResource: readString(mcpRecord, 'oauthResource') }
            : {}),
          ...(isRemote && readString(mcpRecord, 'clientId')
            ? { clientId: readString(mcpRecord, 'clientId') }
            : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'hook': {
      const hookRecord = isRecord(input.hook) ? input.hook : input;
      const hookId = readString(hookRecord, 'id') ?? id;
      const event = readString(hookRecord, 'event');
      const rawType = readString(hookRecord, 'type') ?? (readString(hookRecord, 'command') ? 'command' : undefined);
      const hookType = rawType === 'command' || rawType === 'http' || rawType === 'mcp' || rawType === 'prompt' || rawType === 'agent'
        ? rawType
        : undefined;
      if (!event) diagnostics.push(pluginDiagnostic('error', 'plugin.hook.missing_event', 'Hook event is required', `${path}.hook.event`));
      if (!hookType) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.hook.invalid_type', 'Hook type is required and must be supported', `${path}.hook.type`));
      }
      const command = readString(hookRecord, 'command');
      const cwd = readString(hookRecord, 'cwd');
      const prompt = readString(hookRecord, 'prompt');
      const agentName = readString(hookRecord, 'agentName') ?? readString(hookRecord, 'agent');
      const mcpTool = readString(hookRecord, 'mcpTool');
      const mcpArgs = isRecord(hookRecord.mcpArgs) ? hookRecord.mcpArgs : undefined;
      const httpDescriptor = normalizeHookHttpDescriptor(hookRecord.http, `${path}.hook.http`, diagnostics);
      if (hookType === 'command' && !command) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.hook.missing_command', 'Command hook requires command text', `${path}.hook.command`));
      }
      // B1: prompt/agent hooks are executable runtimes. A prompt hook requires
      // its literal one-shot body; an agent hook requires the sub-agent name.
      if (hookType === 'prompt' && !prompt) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.hook.missing_prompt', 'Prompt hook requires prompt text', `${path}.hook.prompt`));
      }
      if (hookType === 'agent' && !agentName) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.hook.missing_agent', 'Agent hook requires an agent name', `${path}.hook.agentName`));
      }
      // B2: mcp/http hooks are executable runtimes. An mcp hook requires a
      // fully-qualified proxy tool name; an http hook requires a valid URL.
      if (hookType === 'mcp' && !mcpTool) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.hook.missing_mcp_tool', 'MCP hook requires a fully-qualified mcpTool name (mcp__<server>__<tool>)', `${path}.hook.mcpTool`));
      }
      // Qualified proxy form: `mcp__<server>__<tool>`. Server and tool segments
      // may themselves contain underscores, so require the `mcp__` prefix plus a
      // later `__` separator with a non-empty tool tail after the first split.
      if (hookType === 'mcp' && mcpTool && !isQualifiedMcpProxyName(mcpTool)) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.hook.invalid_mcp_tool', 'MCP hook mcpTool must be the qualified proxy name mcp__<server>__<tool>', `${path}.hook.mcpTool`));
      }
      if (hookType === 'http' && !httpDescriptor) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.hook.missing_http_url', 'HTTP hook requires an http.url (http/https)', `${path}.hook.http`));
      }
      if (cwd) {
        const cwdError = validatePluginRelativePath(cwd);
        if (cwdError) diagnostics.push(pluginDiagnostic('error', 'plugin.hook.invalid_cwd', cwdError, `${path}.hook.cwd`));
      }
      const hookArgs = readHookArgsVector(hookRecord.args);
      if (hookArgs.invalid) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.hook.invalid_args', 'Hook args must be a list of strings', `${path}.hook.args`));
      }
      // UB12.67 — hooks.md `onFailure`: "`"continue"`, the default, or `"block"`", on `command` and `http` hooks.
      // Another value is an error rather than the default: a typo must not turn a fail-closed hook into a fail-open one.
      if (hookRecord.onFailure !== undefined && hookRecord.onFailure !== 'continue' && hookRecord.onFailure !== 'block') {
        diagnostics.push(pluginDiagnostic('error', 'plugin.hook.invalid_on_failure', 'Hook onFailure must be "continue" or "block"', `${path}.hook.onFailure`));
      }
      // hooks.md#common-fields, `if`: "Permission rule syntax to filter when
      // this hook runs, such as `"Bash(git *)"` or `"Edit(*.ts)"`. The hook
      // command only runs if the tool call matches the pattern."
      //
      // P2.288, and it is the complement of P2.277 rather than a repeat of it.
      // A rule string the parser cannot turn INTO a rule filters nothing:
      // `evaluateClaudeHookIfFilter` answers `{ run: true, unparseableRule:
      // true }` for it, on every tool call, for the life of the plugin. That
      // fail-open is deliberate and STAYS — hooks.md#bash-if-matching, "Because
      // the `if` filter is best-effort, use the permission system rather than a
      // hook to enforce a hard allow or deny" — and P2.270 measured one file
      // over what closing it would cost. P2.277 made the runtime say so; this
      // says it EARLIER, at the one moment where saying it costs nothing: the
      // author is present, the hook is not yet running, nothing is mid-flight.
      //
      // Therefore a WARNING and never an error. `normalizePluginCapability`
      // refuses a capability on `severity === 'error'`, so promoting this would
      // turn registration into a second enforcement point and refuse hooks the
      // runtime deliberately runs — the shape the row explicitly forbids.
      //
      // One site, not four: the Claude, Codex and MCPB adapters all round-trip
      // their manifests through `normalizeNessyPluginManifest` into this reader,
      // so every format's hooks pass here exactly once.
      //
      // Only the STRING-level failure is decidable here, and only that is
      // reported. The filter's second unparseable cause — a source-anchored
      // rule reaching the DSL's `invalid-policy` branch with no root — depends
      // on the `ifSourceRoot` a plugin hook is given later in
      // `capabilities/runtime-automations.ts`, so raising it now would warn
      // about every ordinary source-anchored rule. That one stays where P2.277
      // put it, at evaluation.
      const ifRule = readString(hookRecord, 'ifRule') ?? readString(hookRecord, 'if');
      if (ifRule !== undefined) {
        const parsedIfRule = parseClaudeRuleString(ifRule, 'allow');
        if (!parsedIfRule.rule) {
          diagnostics.push(pluginDiagnostic(
            'warning',
            'plugin.hook.if_unparseable_fail_open',
            // The parser's own message carries the remedy for the inert forms
            // (`Write(x)` → "Use Edit(x) instead"), which is the part an author
            // can act on. Quoting the rule is not decoration: a plugin may
            // declare many hooks and the diagnostic path names the capability,
            // not the condition.
            `Hook if rule ${JSON.stringify(ifRule)} does not parse, so it filters nothing and the hook runs on every matching tool call. ${parsedIfRule.warning?.message ?? ''}`.trim(),
            `${path}.hook.if`,
            { ifRule, ...(parsedIfRule.warning ? { parserCode: parsedIfRule.warning.code } : {}) },
          ));
        }
      }
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !event || !hookType) return { ok: false, diagnostics };
      const timeoutValue = hookRecord.timeoutMs;
      const capability: PluginHookCapability = {
        ...base,
        kind: 'hook',
        hook: {
          id: hookId,
          event,
          type: hookType,
          ...(readString(hookRecord, 'matcher') ? { matcher: readString(hookRecord, 'matcher') } : {}),
          ...(command ? { command } : {}),
          // The Claude/Codex adapters round-trip through this reader, so the
          // exec-form vector has to survive here verbatim — including the empty
          // one, which is exec form with no arguments and NOT shell form.
          ...(hookArgs.args ? { args: hookArgs.args } : {}),
          ...(typeof timeoutValue === 'number' && Number.isFinite(timeoutValue) ? { timeoutMs: timeoutValue } : {}),
          ...(readString(hookRecord, 'statusMessage') ? { statusMessage: readString(hookRecord, 'statusMessage') } : {}),
          ...(cwd ? { cwd } : {}),
          // R22 common fields. `asyncRewake` implies `async`; both are stored
          // booleans here — runtime semantics live in the automation bridge.
          ...(hookRecord.async === true || hookRecord.asyncRewake === true ? { async: true } : {}),
          ...(hookRecord.asyncRewake === true ? { asyncRewake: true } : {}),
          // Format identity for the exit-code contract. The Claude adapter
          // round-trips its capabilities through this reader, so the field has
          // to survive here or every imported hook silently falls back to the
          // native any-non-zero contract. Absent — the default for a native
          // manifest — IS the native contract.
          ...(hookRecord.exitCodeContract === 'claude-three-way' ? { exitCodeContract: 'claude-three-way' as const } : {}),
          // hooks.md `shell`: the two documented values round-trip; anything
          // else was already refused at import and must not resurrect here.
          ...(hookRecord.shell === 'bash' || hookRecord.shell === 'powershell' ? { shell: hookRecord.shell } : {}),
          // UB12.67 — round-trips the Claude adapter's `onFailure`; the page gives it to command and http hooks only.
          ...(hookRecord.onFailure === 'block' && (hookType === 'command' || hookType === 'http') ? { onFailure: 'block' as const } : {}),
          ...(hookRecord.once === true ? { once: true } : {}),
          // Stored whether or not it parses: the fail-open above means an
          // unparseable rule still reaches the runtime, and dropping it here
          // would silently change WHICH of the two documented fail-opens the
          // hook is in.
          ...(ifRule ? { ifRule } : {}),
          ...(readString(hookRecord, 'model') ? { model: readString(hookRecord, 'model') } : {}),
          ...(hookRecord.continueOnBlock === true ? { continueOnBlock: true } : {}),
          ...(prompt ? { prompt } : {}),
          ...(agentName ? { agentName } : {}),
          ...(mcpTool ? { mcpTool } : {}),
          ...(mcpArgs ? { mcpArgs } : {}),
          ...(httpDescriptor ? { http: httpDescriptor } : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'agent': {
      const agentRecord = isRecord(input.agent) ? input.agent : input;
      const name = readString(agentRecord, 'name') ?? id;
      const agentPath = readString(agentRecord, 'path');
      if (!agentPath) diagnostics.push(pluginDiagnostic('error', 'plugin.agent.missing_path', 'Agent path is required', `${path}.agent.path`));
      if (agentPath) {
        const pathError = validatePluginRelativePath(agentPath);
        if (pathError) diagnostics.push(pluginDiagnostic('error', 'plugin.agent.invalid_path', pathError, `${path}.agent.path`));
      }
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !agentPath) return { ok: false, diagnostics };
      const capability: PluginAgentCapability = {
        ...base,
        kind: 'agent',
        agent: {
          name,
          path: agentPath,
          ...(readString(agentRecord, 'model') ? { model: readString(agentRecord, 'model') } : {}),
          ...(readStringArray(agentRecord.tools) ? { tools: readStringArray(agentRecord.tools) } : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'prompt-command': {
      const promptCommandRecord = isRecord(input.promptCommand) ? input.promptCommand : input;
      const name = readString(promptCommandRecord, 'name') ?? id;
      const promptCommandPath = readString(promptCommandRecord, 'path');
      if (!promptCommandPath) diagnostics.push(pluginDiagnostic('error', 'plugin.prompt_command.missing_path', 'Prompt command path is required', `${path}.promptCommand.path`));
      if (promptCommandPath) {
        const pathError = validatePluginRelativePath(promptCommandPath);
        if (pathError) diagnostics.push(pluginDiagnostic('error', 'plugin.prompt_command.invalid_path', pathError, `${path}.promptCommand.path`));
      }
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !promptCommandPath) return { ok: false, diagnostics };
      const capability: PluginPromptCommandCapability = {
        ...base,
        kind: 'prompt-command',
        promptCommand: {
          name,
          path: promptCommandPath,
          ...(readString(promptCommandRecord, 'argumentHint') ? { argumentHint: readString(promptCommandRecord, 'argumentHint') } : {}),
          ...(readString(promptCommandRecord, 'model') ? { model: readString(promptCommandRecord, 'model') } : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'workflow': {
      // plugins-reference.md §Workflows. The identity is `meta.name` (that is
      // what makes `/​<plugin>:<meta.name>`), so `name` has no file-name
      // fallback here — an adapter that could not parse the metadata must emit
      // a diagnostic instead of guessing a name from the path.
      const workflowRecord = isRecord(input.workflow) ? input.workflow : input;
      const workflowName = readString(workflowRecord, 'name');
      const workflowPath = readString(workflowRecord, 'path');
      if (!workflowName) diagnostics.push(pluginDiagnostic('error', 'plugin.workflow.missing_name', 'Workflow name is required', `${path}.workflow.name`));
      if (!workflowPath) diagnostics.push(pluginDiagnostic('error', 'plugin.workflow.missing_path', 'Workflow path is required', `${path}.workflow.path`));
      if (workflowPath) {
        const pathError = validatePluginRelativePath(workflowPath);
        if (pathError) diagnostics.push(pluginDiagnostic('error', 'plugin.workflow.invalid_path', pathError, `${path}.workflow.path`));
      }
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !workflowName || !workflowPath) {
        return { ok: false, diagnostics };
      }
      const capability: PluginWorkflowCapability = {
        ...base,
        kind: 'workflow',
        workflow: { name: workflowName, path: workflowPath },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'output-style': {
      // `output-styles.md:49` — "The file name becomes the style name unless you
      // set `name` in the frontmatter", so `name` falls back to the capability id
      // rather than being required. The selectable id is composed at projection
      // from the installed plugin key; see `PluginOutputStyleDescriptor`.
      const styleRecord = isRecord(input.outputStyle) ? input.outputStyle : input;
      const stylePath = readString(styleRecord, 'path');
      if (!stylePath) diagnostics.push(pluginDiagnostic('error', 'plugin.output_style.missing_path', 'Output style path is required', `${path}.outputStyle.path`));
      if (stylePath) {
        const pathError = validatePluginRelativePath(stylePath);
        if (pathError) diagnostics.push(pluginDiagnostic('error', 'plugin.output_style.invalid_path', pathError, `${path}.outputStyle.path`));
      }
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !stylePath) {
        return { ok: false, diagnostics };
      }
      const capability: PluginOutputStyleCapability = {
        ...base,
        kind: 'output-style',
        outputStyle: {
          name: readString(styleRecord, 'name') ?? id,
          path: stylePath,
          ...(readBoolean(styleRecord, 'keepCodingInstructions') !== undefined
            ? { keepCodingInstructions: readBoolean(styleRecord, 'keepCodingInstructions') }
            : {}),
          ...(readBoolean(styleRecord, 'forceForPlugin') !== undefined
            ? { forceForPlugin: readBoolean(styleRecord, 'forceForPlugin') }
            : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'unsupported': {
      // Preserve safe provider metadata (externalKind/reasonCode/executable/
      // sourcePath) for a capability kind this runtime cannot execute yet.
      // Never drop it — retained for catalog/provenance only.
      const unsupportedRecord = isRecord(input.unsupported) ? input.unsupported : input;
      const externalKind = readString(unsupportedRecord, 'externalKind');
      const reasonCode = readString(unsupportedRecord, 'reasonCode');
      if (!externalKind) diagnostics.push(pluginDiagnostic('error', 'plugin.unsupported.missing_external_kind', 'Unsupported capability requires externalKind', `${path}.unsupported.externalKind`));
      if (!reasonCode) diagnostics.push(pluginDiagnostic('error', 'plugin.unsupported.missing_reason_code', 'Unsupported capability requires reasonCode', `${path}.unsupported.reasonCode`));
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !externalKind || !reasonCode) return { ok: false, diagnostics };
      const capability: PluginUnsupportedCapability = {
        ...base,
        kind: 'unsupported',
        unsupported: {
          externalKind,
          reasonCode,
          executable: readBoolean(unsupportedRecord, 'executable') ?? false,
          ...(readString(unsupportedRecord, 'sourcePath') ? { sourcePath: readString(unsupportedRecord, 'sourcePath') } : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'setting': {
      const settingRecord = isRecord(input.setting) ? input.setting : input;
      const key = readString(settingRecord, 'key') ?? id;
      const valueType = readString(settingRecord, 'valueType') ?? 'string';
      if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
        diagnostics.push(pluginDiagnostic('error', 'plugin.setting.invalid_value_type', `Unsupported setting value type "${valueType}"`, `${path}.setting.valueType`));
        return { ok: false, diagnostics };
      }
      // B5: a plugin setting may only carry safe presentation/preference
      // defaults — never grant trust, credentials, env injection or filesystem
      // roots. A forbidden key or the credential-carrying `secret-ref` value
      // type is rejected (never applied), mirroring the project-config overlay.
      if (isForbiddenSettingKey(key)) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.setting.forbidden_key', `Setting key "${key}" is not allowed — it could grant trust, credentials, environment or filesystem roots.`, `${path}.setting.key`));
        return { ok: false, diagnostics };
      }
      if (settingRecord.defaultValue !== undefined && !settingDefaultMatches(valueType, settingRecord.defaultValue)) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.setting.default_value_invalid', 'Setting defaultValue must match its primitive valueType.', `${path}.setting.defaultValue`));
        return { ok: false, diagnostics };
      }
      const capability: PluginSettingCapability = {
        ...base,
        kind: 'setting',
        setting: {
          key,
          valueType,
          ...(settingRecord.defaultValue !== undefined ? { defaultValue: settingRecord.defaultValue as string | number | boolean } : {}),
          ...(readBoolean(settingRecord, 'required') !== undefined ? { required: readBoolean(settingRecord, 'required') } : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'command': {
      const commandRecord = isRecord(input.command) ? input.command : input;
      const command = readString(commandRecord, 'command');
      if (!command) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.command.missing_command', 'Command capability requires command text', `${path}.command.command`));
        return { ok: false, diagnostics };
      }
      const capability: PluginCommandCapability = {
        ...base,
        kind: 'command',
        command: {
          command,
          ...(readStringArray(commandRecord.args) ? { args: readStringArray(commandRecord.args) } : {}),
          ...(readString(commandRecord, 'cwd') ? { cwd: readString(commandRecord, 'cwd') } : {}),
          ...(isStringRecord(commandRecord.env) ? { env: commandRecord.env } : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'asset': {
      const assetRecord = isRecord(input.asset) ? input.asset : input;
      const assetPath = readString(assetRecord, 'path');
      if (!assetPath) diagnostics.push(pluginDiagnostic('error', 'plugin.asset.missing_path', 'Asset path is required', `${path}.asset.path`));
      if (assetPath) {
        const pathError = validatePluginRelativePath(assetPath);
        if (pathError) diagnostics.push(pluginDiagnostic('error', 'plugin.asset.invalid_path', pathError, `${path}.asset.path`));
      }
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !assetPath) return { ok: false, diagnostics };
      const role = readString(assetRecord, 'role');
      const capability: PluginAssetCapability = {
        ...base,
        kind: 'asset',
        asset: {
          path: assetPath,
          ...(readString(assetRecord, 'mediaType') ? { mediaType: readString(assetRecord, 'mediaType') } : {}),
          ...(role === 'icon' || role === 'image' || role === 'template' || role === 'data' || role === 'other' ? { role } : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'lsp': {
      const lspRecord = isRecord(input.lsp) ? input.lsp : input;
      const lspId = readString(lspRecord, 'id') ?? id;
      const command = readString(lspRecord, 'command');
      if (!command) diagnostics.push(pluginDiagnostic('error', 'plugin.lsp.missing_command', 'LSP server requires a command', `${path}.lsp.command`));
      const languages = readRequiredUniqueStringArray(lspRecord.languages, `${path}.lsp.languages`, diagnostics);
      const workingDirectory = readString(lspRecord, 'workingDirectory');
      if (workingDirectory) {
        const wdError = validatePluginRelativePath(workingDirectory);
        if (wdError) diagnostics.push(pluginDiagnostic('error', 'plugin.lsp.invalid_working_directory', wdError, `${path}.lsp.workingDirectory`));
      }
      const workspaceFolder = readString(lspRecord, 'workspaceFolder');
      if (workspaceFolder) {
        const wfError = validatePluginLspWorkspaceFolder(workspaceFolder);
        if (wfError) diagnostics.push(pluginDiagnostic('error', 'plugin.lsp.invalid_workspace_folder', wfError, `${path}.lsp.workspaceFolder`));
      }
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !command || !languages) return { ok: false, diagnostics };
      const capability: PluginLspCapability = {
        ...base,
        kind: 'lsp',
        lsp: {
          id: lspId,
          command,
          ...(readStringArray(lspRecord.args) ? { args: readStringArray(lspRecord.args) } : {}),
          languages, ...(isStringRecord(lspRecord.extensionToLanguage) ? { extensionToLanguage: lspRecord.extensionToLanguage } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
          // Same treatment the MCP branch gives its own `env`: carried as a
          // string record, never expanded or validated as a path here.
          ...(isStringRecord(lspRecord.env) ? { env: lspRecord.env } : {}),
          ...(workspaceFolder ? { workspaceFolder } : {}),
          // P6.417 (and F1.1025's map, on the `languages` line) — carried, not re-validated. The FORMAT ADAPTER is where a
          // malformed knob is refused by name (`readClaudeLspSupervision`, `claudeLspExtensionMapField`), and
          // this builder rebuilds the descriptor field by field — which is
          // exactly how the seven supervision fields reached the capability and
          // then vanished before the resolver saw them. Measured while landing
          // the row: the adapter carried them and this line was missing, so
          // `supervision` was `undefined` on every parsed capability.
          ...(isRecord(lspRecord.supervision) ? { supervision: lspRecord.supervision } : {}),
        },
      };
      return { ok: true, value: capability, diagnostics };
    }
    case 'monitor': {
      const monitorRecord = isRecord(input.monitor) ? input.monitor : input;
      const monitorId = readString(monitorRecord, 'id') ?? id;
      // Claude's command form (`plugins/components.md#monitors`). Selected by `form`
      // rather than by "has a command": a native scheduled monitor that grew a
      // stray `command` key must stay a scheduled monitor, and a command monitor
      // whose `command` failed to parse must be REFUSED rather than silently
      // re-read as a schedule with no cron.
      if (readString(monitorRecord, 'form') === 'command') {
        const command = readString(monitorRecord, 'command');
        const description = readString(monitorRecord, 'description');
        const rawWhen = readString(monitorRecord, 'when');
        if (!command) {
          diagnostics.push(pluginDiagnostic('error', 'plugin.monitor.missing_command', 'Monitor command is required.', `${path}.monitor.command`));
        }
        // `:330` gives exactly two forms; anything else is not a trigger we can
        // honour, and defaulting an unknown value to `always` would START a
        // monitor its author asked to hold back.
        if (rawWhen !== undefined && rawWhen !== 'always' && !/^on-skill-invoke:.+$/.test(rawWhen)) {
          diagnostics.push(pluginDiagnostic('error', 'plugin.monitor.invalid_when', 'Monitor when must be "always" or "on-skill-invoke:<skill-name>".', `${path}.monitor.when`));
        }
        if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !command) return { ok: false, diagnostics };
        const capability: PluginMonitorCapability = {
          ...base,
          kind: 'monitor',
          monitor: {
            form: 'command',
            id: monitorId,
            command,
            // `:324`'s description is label text (task panel + notification
            // summary), so an absent one costs a caption, not the monitor —
            // the same call B1b made for `userConfig`'s `title`/`description`.
            description: description ?? monitorId,
            when: (rawWhen ?? 'always') as PluginCommandMonitorDescriptor['when'],
          },
        };
        return { ok: true, value: capability, diagnostics };
      }
      const monitorPath = readString(monitorRecord, 'path');
      const cron = readString(monitorRecord, 'cron');
      const timezone = readString(monitorRecord, 'timezone');
      if (!monitorPath) diagnostics.push(pluginDiagnostic('error', 'plugin.monitor.missing_path', 'Monitor path is required', `${path}.monitor.path`));
      if (monitorPath) {
        const pathError = validatePluginRelativePath(monitorPath);
        if (pathError) diagnostics.push(pluginDiagnostic('error', 'plugin.monitor.invalid_path', pathError, `${path}.monitor.path`));
      }
      if (!cron || !isValidPluginMonitorCron(cron)) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.monitor.invalid_cron', 'Monitor cron must be a valid five-field cron expression.', `${path}.monitor.cron`));
      }
      if (timezone && !isValidPluginMonitorTimezone(timezone)) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.monitor.invalid_timezone', 'Monitor timezone must be a valid IANA timezone.', `${path}.monitor.timezone`));
      }
      if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !monitorPath || !cron) return { ok: false, diagnostics };
      const capability: PluginMonitorCapability = {
        ...base,
        kind: 'monitor',
        monitor: { id: monitorId, path: monitorPath, cron, ...(timezone ? { timezone } : {}) },
      };
      return { ok: true, value: capability, diagnostics };
    }
    default:
      return {
        ok: false,
        diagnostics: [pluginDiagnostic('error', 'plugin.capability.unsupported_kind', `Unsupported capability kind "${kind}"`, `${path}.kind`)],
      };
  }
}

function normalizeTrustRequirement(input: unknown): PluginCapability['trust'] {
  if (!isRecord(input)) return undefined;
  const required = readBoolean(input, 'required') ?? false;
  return {
    required,
    ...(readString(input, 'reason') ? { reason: readString(input, 'reason') } : {}),
    ...(readString(input, 'executablePath') ? { executablePath: readString(input, 'executablePath') } : {}),
    ...(readString(input, 'executableHash') ? { executableHash: readString(input, 'executableHash') } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(entry => typeof entry === 'string');
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The scheme a remote MCP transport requires (`mcp.md:147` for `ws`). */
function isValidMcpRemoteUrl(value: string, transport: 'http' | 'sse' | 'ws'): boolean {
  if (transport !== 'ws') return isValidHttpUrl(value);
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

/**
 * A fully-qualified MCP proxy tool name is `mcp__<server>__<tool>` where both
 * the server and tool segments are non-empty and may contain underscores. We
 * strip the `mcp__` prefix and require at least one further `__` with a
 * non-empty tail, so `mcp__linear_app__create_issue` is accepted while a bare
 * `lint_file` (no prefix) is rejected.
 */
function isQualifiedMcpProxyName(value: string): boolean {
  if (!value.startsWith('mcp__')) return false;
  const rest = value.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  return separator > 0 && rest.length > separator + 2;
}

/**
 * B5 forbidden-setting-key guard. A plugin `setting` (or `nessyExtensions`
 * setting) default maps into the preferences overlay, so it must NEVER be able
 * to grant trust, credentials, environment injection, provider/gateway
 * endpoints or filesystem roots — the same posture the project-config overlay
 * enforces (`project-config.ts` FORBIDDEN_SECTIONS/FORBIDDEN_DEFAULTS_KEYS).
 * Matching is case-insensitive and token-boundary aware so `verbosity` is safe
 * while `auth_token`, `apiKey`, `base_url`, `roots`, `trusted` are rejected.
 */
const FORBIDDEN_SETTING_KEY_TOKENS = new Set([
  'auth', 'credential', 'credentials', 'token', 'secret', 'password', 'passwd',
  'apikey', 'api_key', 'key', 'env', 'environment', 'endpoint', 'endpoints',
  'baseurl', 'base_url', 'url', 'gateway', 'provider', 'root', 'roots',
  'storage', 'storagedir', 'storage_dir', 'trust', 'trusted', 'install',
]);

function isForbiddenSettingKey(key: string): boolean {
  if (FORBIDDEN_SETTING_KEY_TOKENS.has(key.toLowerCase())) return true;
  // Insert boundaries at camelCase transitions on the ORIGINAL-cased key FIRST
  // (before lowercasing, or the `[a-z][A-Z]` split never matches), then split on
  // non-alphanumeric boundaries and lowercase, so `authToken`, `apiKey`,
  // `secretKey`, `endpointUrl`, `base_url`, `ANTHROPIC_API_KEY` all surface a
  // forbidden token.
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  return tokens.some(token => FORBIDDEN_SETTING_KEY_TOKENS.has(token));
}

const HOOK_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Normalizes an `http` hook descriptor (B2). Returns undefined (never a
 * partial/invalid shape) when the URL is missing or not http/https; the caller
 * turns that into a `missing_http_url` diagnostic for `type: 'http'` hooks.
 * Headers are copied verbatim as strings; the body is retained as-is.
 */
function normalizeHookHttpDescriptor(
  value: unknown,
  path: string,
  diagnostics: PluginDiagnostic[],
): NonNullable<PluginHookCapability['hook']['http']> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.hook.invalid_http', 'HTTP hook descriptor must be an object', path));
    return undefined;
  }
  const url = readString(value, 'url');
  if (!url || !isValidHttpUrl(url)) return undefined;
  const rawMethod = readString(value, 'method')?.toUpperCase();
  const method = rawMethod && HOOK_HTTP_METHODS.has(rawMethod)
    ? rawMethod as NonNullable<PluginHookCapability['hook']['http']>['method']
    : undefined;
  const headers = isRecord(value.headers)
    ? Object.fromEntries(Object.entries(value.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined;
  const allowedEnvVars = readStringArray(value.allowedEnvVars);
  return {
    url,
    ...(method ? { method } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(value.body !== undefined ? { body: value.body } : {}),
    ...(allowedEnvVars && allowedEnvVars.length > 0 ? { allowedEnvVars } : {}),
  };
}

// --- plugin dependencies (B1e) ----------------------------------------------

/** `plugins/loading.md#limits-on-the-dependency-install` — the documented cap on how many we will read. */
const MAX_PLUGIN_DEPENDENCIES = 128;

/**
 * `plugins/manifest-reference.md#dependencies` — "Each entry is either a plugin name or an object
 * with a version constraint."
 *
 * A malformed entry is refused with a diagnostic and dropped; the rest of the
 * array still imports, which is how every other repeated manifest field behaves
 * here. An unparseable `version` is NOT dropped: `:213` makes invalid semver
 * syntax a `range-conflict` that disables the plugin, so the range is carried
 * with `versionRangeValid: false` and the load-time gate refuses it. Dropping it
 * would turn an authoring error into a silently unconstrained dependency.
 */
export function normalizePluginDependencies(
  input: unknown,
  diagnostics: PluginDiagnostic[],
  path = 'dependencies',
): PluginDependencyDescriptor[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.dependencies.invalid', 'Plugin dependencies must be an array.', path));
    return [];
  }
  if (input.length > MAX_PLUGIN_DEPENDENCIES) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.dependencies.invalid', `Plugin dependencies must list at most ${MAX_PLUGIN_DEPENDENCIES} plugins.`, path));
    return [];
  }
  const dependencies: PluginDependencyDescriptor[] = [];
  const seen = new Set<string>();
  input.forEach((raw, index) => {
    const entryPath = `${path}.${index}`;
    const record = typeof raw === 'string' ? { name: raw } : raw;
    if (!isRecord(record)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.dependencies.invalid', 'Plugin dependency must be a plugin name or an object.', entryPath));
      return;
    }
    const name = readString(record, 'name');
    if (!name) {
      // `:44` — "Plugin name. … Required."
      diagnostics.push(pluginDiagnostic('error', 'plugin.dependencies.invalid', 'Plugin dependency requires a name.', `${entryPath}.name`));
      return;
    }
    if (seen.has(name)) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.dependencies.duplicate',
        `Plugin dependency "${name}" is declared more than once; the first declaration wins.`,
        entryPath,
        { pluginName: name },
      ));
      return;
    }
    seen.add(name);
    const version = readString(record, 'version');
    const marketplace = readString(record, 'marketplace');
    const versionRangeValid = version === undefined ? undefined : validRange(version) !== null;
    if (versionRangeValid === false) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.dependencies.invalid_version_range',
        `Plugin dependency "${name}" declares "${version}", which is not a valid semver range.`,
        `${entryPath}.version`,
        { pluginName: name, range: version },
      ));
    }
    dependencies.push({
      name,
      ...(version === undefined ? {} : { version }),
      ...(versionRangeValid === undefined ? {} : { versionRangeValid }),
      ...(marketplace ? { marketplace } : {}),
    });
  });
  return dependencies;
}

// --- W7 Step 5: first-class app descriptors + namespaced Nessy extensions ---

function readAppDescriptors(input: UnknownRecord): PluginAppDescriptor[] {
  const value = input.apps;
  if (!Array.isArray(value)) return [];
  const apps: PluginAppDescriptor[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = readString(raw, 'id');
    const connectorId = readString(raw, 'connectorId');
    if (!id || !connectorId) continue;
    apps.push({
      id,
      connectorId,
      ...(readString(raw, 'displayName') ? { displayName: readString(raw, 'displayName') } : {}),
      ...(isStringRecord(raw.routing) ? { routing: raw.routing } : {}),
    });
  }
  return apps;
}

const CONNECTOR_AUTH_TYPES = new Set(['oauth', 'bearer', 'none']);
const CONNECTOR_AUTH_TIMINGS = new Set<PluginConnectorAuthTiming>(['ON_INSTALL', 'ON_FIRST_USE']);
const CONNECTOR_TRANSPORTS = new Set(['http', 'sse', 'stdio']);

function readConnectorMcpServer(raw: unknown): PluginConnectorMcpServerDescriptor | undefined {
  if (!isRecord(raw)) return undefined;
  const serverName = readString(raw, 'serverName');
  const transport = readString(raw, 'transport');
  if (!serverName || !transport || !CONNECTOR_TRANSPORTS.has(transport)) return undefined;
  const args = readStringArray(raw.args);
  return {
    serverName,
    transport: transport as PluginConnectorMcpServerDescriptor['transport'],
    ...(readString(raw, 'url') ? { url: readString(raw, 'url') } : {}),
    ...(readString(raw, 'oauthResource') ? { oauthResource: readString(raw, 'oauthResource') } : {}),
    ...(readString(raw, 'clientId') ? { clientId: readString(raw, 'clientId') } : {}),
    ...(readString(raw, 'command') ? { command: readString(raw, 'command') } : {}),
    ...(args ? { args } : {}),
    ...(typeof raw.toolTimeoutMs === 'number'
      && Number.isSafeInteger(raw.toolTimeoutMs)
      && raw.toolTimeoutMs > 0
      ? { toolTimeoutMs: raw.toolTimeoutMs }
      : {}),
  };
}

function readConnectorAuth(raw: unknown): PluginConnectorAuthDescriptor | undefined {
  if (!isRecord(raw)) return undefined;
  const type = readString(raw, 'type');
  if (!type || !CONNECTOR_AUTH_TYPES.has(type)) return undefined;
  const timing = readString(raw, 'timing');
  return {
    type: type as PluginConnectorAuthDescriptor['type'],
    ...(timing && CONNECTOR_AUTH_TIMINGS.has(timing as PluginConnectorAuthTiming)
      ? { timing: timing as PluginConnectorAuthTiming }
      : {}),
  };
}

function readConnectorDescriptors(input: UnknownRecord): PluginConnectorDescriptor[] {
  const value = input.connectors;
  if (!Array.isArray(value)) return [];
  const connectors: PluginConnectorDescriptor[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = readString(raw, 'id');
    if (!id) continue;
    const mcpServers = Array.isArray(raw.mcpServers)
      ? raw.mcpServers.map(readConnectorMcpServer).filter((server): server is PluginConnectorMcpServerDescriptor => server !== undefined)
      : [];
    if (mcpServers.length === 0) continue;
    const auth = readConnectorAuth(raw.auth);
    connectors.push({
      id,
      mcpServers,
      ...(readString(raw, 'displayName') ? { displayName: readString(raw, 'displayName') } : {}),
      ...(readString(raw, 'description') ? { description: readString(raw, 'description') } : {}),
      ...(auth ? { auth } : {}),
    });
  }
  return connectors;
}

/**
 * T9 (plugin-install plan, owner § 0b-3): a connector's stdio server never
 * materializes as a Source — `isMaterializableServer` refuses stdio by design,
 * because a Source config cannot retain plugin bundle/hash/data-root authority
 * — so before T9 such a server parked forever as `connector-stdio-deferred`, a
 * class with no exit. Claude-adapter stdio entries already ride the pinned
 * capability snapshot and WORK; T9 rerouted the remaining stdio class onto
 * that same supervised path at NORMALIZATION, covering every route into the
 * native manifest at once (native manifests and the Codex
 * declarative-`connectors` passthrough). Install-time npx vendoring and stdio
 * command qualification apply to a rerouted capability exactly as to any
 * other, because both walk `manifest.capabilities`.
 *
 * C3 (capability-path plan, ADR § 3): the REMOTE half follows through the SAME
 * funnel. An http/sse connector server becomes an auth-carrying `kind:'mcp'`
 * capability — `authType` from the connector's declared auth plus the
 * `oauthResource`/`clientId` it already carried — bound at runtime to the
 * server's GLOBAL plugin credential slot instead of a materialized Source.
 * The funnel covers what the ADR's three named adapter branches (claude
 * promotion, codex `oauth_resource`, legacy `httpUrl`) would cover AND the two
 * routes they would miss: Codex declarative `connectors` and native-manifest
 * connectors.
 *
 * Only an app-REFERENCED connector survives normalization — apps route by
 * `connectorId` + `serverName`, so that descriptor is routing metadata, not a
 * server authority; its remote servers keep the T9 stdio-stripped shape AND
 * get capability twins. Since C5 the Source projection is deleted outright;
 * the twin set still gates the manifest-derived auth report
 * (`auth-requirements.ts`) so pre-C3 persisted entries report shape-stably.
 *
 * The synthesized capability id is sanitized into `validatePluginId`'s
 * alphabet and de-collided; the descriptor keeps the RAW `serverName` (the
 * pool's wire name) untouched.
 */
function rerouteConnectorServers(
  connectors: PluginConnectorDescriptor[],
  capabilities: PluginCapability[],
  diagnostics: PluginDiagnostic[],
  appConnectorIds: ReadonlySet<string>,
): PluginConnectorDescriptor[] {
  const idSegment = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '-');
  const usedIds = new Set(capabilities.map(capability => capability.id));
  // Idempotence: normalization runs more than once on an install (bundle
  // normalize + staged-manifest validation), and a RETAINED app-routing
  // connector would otherwise mint a second twin on every pass.
  const twinnedServerNames = new Set(capabilities.flatMap(capability => (
    capability.kind === 'mcp' ? [capability.mcp.serverName] : []
  )));
  const remaining: PluginConnectorDescriptor[] = [];
  for (const connector of connectors) {
    const authType = connector.auth?.type ?? 'none';
    for (const server of connector.mcpServers) {
      // Accepted by `readConnectorMcpServer` but with nothing to run or reach;
      // the terminal state is unchanged, minus a dead connector slot.
      if (server.transport === 'stdio' ? !server.command : !server.url) continue;
      if (twinnedServerNames.has(server.serverName)) continue;
      twinnedServerNames.add(server.serverName);
      let id = `mcp.${idSegment(connector.id)}.${idSegment(server.serverName)}`;
      for (let suffix = 2; usedIds.has(id); suffix += 1) {
        id = `mcp.${idSegment(connector.id)}.${idSegment(server.serverName)}.${suffix}`;
      }
      usedIds.add(id);
      capabilities.push({
        kind: 'mcp',
        id,
        ...(connector.displayName ? { displayName: connector.displayName } : {}),
        ...(connector.description ? { description: connector.description } : {}),
        mcp: server.transport === 'stdio'
          ? {
              serverName: server.serverName,
              transport: 'stdio',
              command: server.command!,
              ...(server.args ? { args: server.args } : {}),
              ...(server.toolTimeoutMs !== undefined ? { toolTimeoutMs: server.toolTimeoutMs } : {}),
            }
          : {
              serverName: server.serverName,
              transport: server.transport,
              url: server.url!,
              ...(authType !== 'none' ? { authType } : {}),
              ...(server.oauthResource ? { oauthResource: server.oauthResource } : {}),
              ...(server.clientId ? { clientId: server.clientId } : {}),
              ...(server.toolTimeoutMs !== undefined ? { toolTimeoutMs: server.toolTimeoutMs } : {}),
            },
      });
      diagnostics.push(pluginDiagnostic(
        'info',
        server.transport === 'stdio'
          ? 'plugin.install.connector_stdio_rerouted'
          : 'plugin.install.connector_remote_rerouted',
        server.transport === 'stdio'
          ? `Connector "${connector.id}" stdio server "${server.serverName}" runs as a supervised plugin MCP capability.`
          : `Connector "${connector.id}" server "${server.serverName}" runs as a plugin MCP capability with its own credential slot.`,
        undefined,
        { connectorId: connector.id, serverName: server.serverName },
      ));
    }
    // App routing metadata only; stdio servers stay stripped (T9 shape).
    if (!appConnectorIds.has(connector.id)) continue;
    const remote = connector.mcpServers.filter(server => server.transport !== 'stdio');
    if (remote.length === 0) continue;
    remaining.push(remote.length === connector.mcpServers.length
      ? connector
      : { ...connector, mcpServers: remote });
  }
  return remaining;
}

/**
 * Explicit `nessyExtensions` wins; when absent, a Nessy-owned adapter may opt in
 * to deriving it from the manifest's first-class setting/command/asset
 * capabilities (explicit-by-definition in the native format).
 */
function resolveNessyExtensions(
  input: UnknownRecord,
  capabilities: PluginCapability[],
  options: NormalizeManifestOptions,
  diagnostics: PluginDiagnostic[],
): PluginNessyExtensions | undefined {
  const declared = readNessyExtensions(input, diagnostics);
  if (declared) return declared;
  if (!options.deriveNessyExtensionsFromCapabilities) return undefined;

  const settings = capabilities
    .filter((capability): capability is PluginSettingCapability => capability.kind === 'setting')
    .map(capability => capability.setting);
  const commands = capabilities
    .filter((capability): capability is PluginCommandCapability => capability.kind === 'command')
    .map(capability => capability.command);
  const assets = capabilities
    .filter((capability): capability is PluginAssetCapability => capability.kind === 'asset')
    .map(capability => capability.asset);
  if (settings.length === 0 && commands.length === 0 && assets.length === 0) return undefined;
  return {
    ...(settings.length > 0 ? { settings } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    ...(assets.length > 0 ? { assets } : {}),
  };
}

function readNessyExtensions(input: UnknownRecord, diagnostics: PluginDiagnostic[] = []): PluginNessyExtensions | undefined {
  const value = input.nessyExtensions;
  if (!isRecord(value)) return undefined;
  const settings: PluginSettingDescriptor[] = [];
  const commands: PluginCommandDescriptor[] = [];
  const assets: PluginAssetDescriptor[] = [];
  if (Array.isArray(value.settings)) {
    for (const raw of value.settings) {
      if (!isRecord(raw)) continue;
      const key = readString(raw, 'key');
      const valueType = raw.valueType;
      if (!key || typeof valueType !== 'string') continue;
      // Extension settings share the same primitive-only durable contract as
      // first-class setting capabilities.
      if (isForbiddenSettingKey(key)) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.setting.forbidden_key', `Setting key "${key}" is not allowed — it could grant trust, credentials, environment or filesystem roots.`, 'nessyExtensions.settings'));
        continue;
      }
      if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
        diagnostics.push(pluginDiagnostic('error', 'plugin.setting.invalid_value_type', `Setting "${key}" must use string, number, or boolean.`, 'nessyExtensions.settings'));
        continue;
      }
      if (raw.defaultValue !== undefined && !settingDefaultMatches(valueType, raw.defaultValue)) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.setting.default_value_invalid', `Setting "${key}" defaultValue must match its primitive valueType.`, 'nessyExtensions.settings'));
        continue;
      }
      settings.push({ key, valueType, ...(raw.defaultValue !== undefined ? { defaultValue: raw.defaultValue } : {}), ...(typeof raw.required === 'boolean' ? { required: raw.required } : {}) });
    }
  }
  if (Array.isArray(value.commands)) {
    for (const raw of value.commands) {
      if (!isRecord(raw)) continue;
      const command = readString(raw, 'command');
      if (!command) continue;
      commands.push({ command, ...(Array.isArray(raw.args) && raw.args.every(a => typeof a === 'string') ? { args: raw.args as string[] } : {}), ...(readString(raw, 'cwd') ? { cwd: readString(raw, 'cwd') } : {}), ...(isStringRecord(raw.env) ? { env: raw.env } : {}) });
    }
  }
  if (Array.isArray(value.assets)) {
    for (const raw of value.assets) {
      if (!isRecord(raw)) continue;
      const path = readString(raw, 'path');
      if (!path) continue;
      assets.push({ path, ...(readString(raw, 'mediaType') ? { mediaType: readString(raw, 'mediaType') } : {}), ...(readString(raw, 'role') ? { role: readString(raw, 'role') as PluginAssetDescriptor['role'] } : {}) });
    }
  }
  const userConfiguration = normalizeUserConfiguration(
    value.userConfiguration,
    'nessyExtensions.userConfiguration',
    diagnostics,
  );
  const defaultSettings = readPluginDefaultSettings(value.defaultSettings);
  if (settings.length === 0 && commands.length === 0 && assets.length === 0
    && (userConfiguration?.length ?? 0) === 0 && defaultSettings === undefined) {
    return undefined;
  }
  return {
    ...(settings.length > 0 ? { settings } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    ...(assets.length > 0 ? { assets } : {}),
    ...(userConfiguration?.length ? { userConfiguration } : {}),
    ...(defaultSettings ? { defaultSettings } : {}),
  };
}

/**
 * `plugins.md` § Ship default settings with your plugin. Only `agent` is
 * carried, and only as a non-empty string — see
 * `PluginDefaultSettingsDescriptor` for why the other supported key is not
 * stored and why this one is recorded rather than applied. The value is checked
 * against the bundle's own agents by the adapter that produced it, which is the
 * only place that has them.
 */
function readPluginDefaultSettings(value: unknown): PluginDefaultSettingsDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const agent = readString(value, 'agent');
  return agent ? { agent } : undefined;
}
