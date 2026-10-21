import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateAutomationsConfig } from '../automations/validation.ts';
import type { AutomationsConfig } from '../automations/types.ts';
import { mergeAutomationsConfigs } from '../automations/hooks-config.ts';
import { pluginDiagnostic } from './schema.ts';
import type { PluginDiagnostic } from './types.ts';

export { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';
export const NESSY_AGENT_PROJECT_CONFIG_FILE = 'config.toml';
export const NESSY_AGENT_PROJECT_HOOKS_FILE = 'hooks.json';

export interface ProjectNessyAgentPluginConfig {
  selector: string;
  pluginInstanceId?: string;
  pluginId?: string;
  enabled: boolean;
  capabilities?: Record<string, boolean>;
}

/**
 * Typed v1 `[defaults]` allowlist. Values are raw strings; consumers normalize
 * (`normalizeThinkingLevel`, fixed permission-mode set) and an explicit session
 * value always wins. A project file can never grant trust, credentials,
 * provider auth, environment, filesystem roots or shell commands.
 */
export interface ProjectNessyAgentDefaults {
  model?: string;
  thinkingLevel?: string;
  permissionMode?: string;
}

export interface ProjectNessyAgentConfig {
  projectRoot: string;
  configPath: string;
  hooksPath: string;
  defaults: ProjectNessyAgentDefaults;
  plugins: ProjectNessyAgentPluginConfig[];
  hooks: AutomationsConfig;
  diagnostics: PluginDiagnostic[];
  sources: string[];
}

interface TomlSection {
  name: string;
  selector?: string;
  values: Record<string, unknown>;
}

export interface LoadProjectNessyAgentConfigOptions {
  /**
   * Whether the active repository is trusted (W7 Step 4). An untrusted/unknown
   * repository contributes NO overlay: `.nessy-agent/config.toml` and `.nessy-agent/hooks.json`
   * are read only when this is explicitly `true`. Fail-closed by default — the
   * same posture W6 established for native project resources.
   */
  projectTrusted?: boolean;
}

export function loadProjectNessyAgentConfig(
  projectRoot: string | undefined,
  options: LoadProjectNessyAgentConfigOptions = {},
): ProjectNessyAgentConfig | undefined {
  if (!projectRoot) return undefined;
  // Trust gate: an untrusted/unknown repository is never read.
  if (options.projectTrusted !== true) return undefined;
  const configPath = join(projectRoot, NESSY_AGENT_PROJECT_DIR, NESSY_AGENT_PROJECT_CONFIG_FILE);
  const hooksPath = join(projectRoot, NESSY_AGENT_PROJECT_DIR, NESSY_AGENT_PROJECT_HOOKS_FILE);
  const diagnostics: PluginDiagnostic[] = [];
  const sources: string[] = [];
  const hasConfig = existsSync(configPath);
  const parsed = hasConfig
    ? parseProjectNessyAgentConfig(readFileSync(configPath, 'utf-8'), configPath, diagnostics)
    : { plugins: [], defaults: {} };
  if (hasConfig) sources.push(configPath);

  const hooks = existsSync(hooksPath)
    ? loadProjectNessyAgentHooks(hooksPath, diagnostics, sources)
    : { automations: {} };

  return {
    projectRoot,
    configPath,
    hooksPath,
    defaults: parsed.defaults,
    plugins: parsed.plugins,
    hooks,
    diagnostics,
    sources,
  };
}

// `applyProjectNessyAgentConfigToRegistry` lived here and overlaid this file's
// `[plugins]` toggles onto a V1 `PluginInstalledRegistry` in memory. F4 deleted
// it with the registry it wrote to: its only production caller was
// `projection.ts`'s `loadPluginProjectionPlan`. The toggles themselves are still
// read — `loadProjectNessyAgentConfig` is what server-core calls — and reaching
// activation is the capability policy store's job now.

export function parseProjectNessyAgentConfigToml(
  content: string,
  sourceName = `${NESSY_AGENT_PROJECT_DIR}/${NESSY_AGENT_PROJECT_CONFIG_FILE}`,
  diagnostics: PluginDiagnostic[] = [],
): ProjectNessyAgentPluginConfig[] {
  return parseProjectNessyAgentConfig(content, sourceName, diagnostics).plugins;
}

/**
 * Sections and keys a project file must never influence. Matching content is
 * diagnosed with severity `error` and NEVER applied or executed.
 */
const FORBIDDEN_SECTIONS = new Set([
  'auth', 'credentials', 'env', 'environment', 'endpoints', 'gateway',
  'install', 'notifications', 'notify', 'provider', 'roots', 'storage',
  'telemetry', 'trust',
]);
const FORBIDDEN_DEFAULTS_KEYS = new Set([
  'api_key', 'base_url', 'endpoint', 'env', 'install', 'notify_command',
  'roots', 'storage_dir', 'token', 'trusted',
  // settings.md scopes askUserQuestionTimeout to USER settings only — "Not
  // read from project or local settings". Forbidden (not merely unknown) so a
  // checked-in repo attempting to auto-answer questions is an error on
  // record, not a silently ignored key (R7 Task 3).
  'ask_user_question_timeout',
]);
const DEFAULTS_KEY_MAP: Record<string, keyof ProjectNessyAgentDefaults> = {
  model: 'model',
  thinking_level: 'thinkingLevel',
  permission_mode: 'permissionMode',
};

export function parseProjectNessyAgentConfig(
  content: string,
  sourceName = `${NESSY_AGENT_PROJECT_DIR}/${NESSY_AGENT_PROJECT_CONFIG_FILE}`,
  diagnostics: PluginDiagnostic[] = [],
): { plugins: ProjectNessyAgentPluginConfig[]; defaults: ProjectNessyAgentDefaults } {
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const table = line.match(/^\[plugins(?:\.("([^"]+)"|[A-Za-z0-9_.:/@-]+))?\]$/);
    if (table) {
      const rawSelector = table[2] ?? table[1];
      current = {
        name: rawSelector ? 'plugin' : 'plugins',
        ...(rawSelector ? { selector: rawSelector.replace(/^"|"$/g, '') } : {}),
        values: {},
      };
      sections.push(current);
      continue;
    }
    const otherTable = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (otherTable) {
      const name = otherTable[1]!;
      if (name === 'defaults') {
        current = { name: 'defaults', values: {} };
        sections.push(current);
      } else {
        current = null;
        const severity = FORBIDDEN_SECTIONS.has(name) ? 'error' : 'warning';
        const code = severity === 'error'
          ? 'plugin.project_config.forbidden_section'
          : 'plugin.project_config.unsupported_toml';
        diagnostics.push(configDiagnostic(severity, code, `${sourceName}:${index + 1}: [${name}] is not allowed in a project config and was ignored.`));
      }
      continue;
    }
    if (!current) {
      diagnostics.push(configDiagnostic('warning', 'plugin.project_config.unsupported_toml', `${sourceName}:${index + 1}: only [defaults], [plugins] and [plugins.<id>] sections are supported.`));
      continue;
    }

    const keyValue = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!keyValue) {
      diagnostics.push(configDiagnostic('warning', 'plugin.project_config.unsupported_toml', `${sourceName}:${index + 1}: unsupported TOML syntax.`));
      continue;
    }
    current.values[keyValue[1]!] = parseTomlValue(keyValue[2]!, sourceName, index + 1, diagnostics);
  }

  const defaults: ProjectNessyAgentDefaults = {};
  for (const section of sections) {
    if (section.name !== 'defaults') continue;
    for (const [key, value] of Object.entries(section.values)) {
      if (FORBIDDEN_DEFAULTS_KEYS.has(key)) {
        diagnostics.push(configDiagnostic('error', 'plugin.project_config.forbidden_key', `${sourceName}: [defaults] ${key} is not allowed in a project config and was ignored.`));
        continue;
      }
      const mapped = DEFAULTS_KEY_MAP[key];
      if (!mapped) {
        diagnostics.push(configDiagnostic('warning', 'plugin.project_config.unknown_keys', `${sourceName}: unknown [defaults] key ignored: ${key}`));
        continue;
      }
      if (typeof value !== 'string') {
        diagnostics.push(configDiagnostic('warning', 'plugin.project_config.unsupported_toml', `${sourceName}: [defaults] ${key} must be a string.`));
        continue;
      }
      defaults[mapped] = value;
    }
  }

  return {
    plugins: sections.flatMap(section => sectionToPluginConfigs(section, sourceName, diagnostics)),
    defaults,
  };
}

function loadProjectNessyAgentHooks(
  hooksPath: string,
  diagnostics: PluginDiagnostic[],
  sources: string[],
): AutomationsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(hooksPath, 'utf-8'));
  } catch (error) {
    diagnostics.push(configDiagnostic('error', 'plugin.project_hooks.invalid_json', `${hooksPath}: ${error instanceof Error ? error.message : String(error)}`));
    return { automations: {} };
  }

  const hooksMap = isRecord(raw) ? raw.hooks ?? raw.automations ?? raw : raw;
  const validation = validateAutomationsConfig({ automations: hooksMap });
  if (!validation.valid || !validation.config) {
    diagnostics.push(...validation.errors.map(error => configDiagnostic('error', 'plugin.project_hooks.invalid_config', `${hooksPath}: ${error}`)));
    return { automations: {} };
  }
  sources.push(hooksPath);
  return mergeAutomationsConfigs(validation.config);
}

function sectionToPluginConfigs(
  section: TomlSection,
  sourceName: string,
  diagnostics: PluginDiagnostic[],
): ProjectNessyAgentPluginConfig[] {
  if (section.name === 'defaults') return [];
  if (section.name === 'plugins' && !section.selector) {
    const enabled = readStringArray(section.values.enabled);
    const disabled = readStringArray(section.values.disabled);
    const configs: ProjectNessyAgentPluginConfig[] = [];
    for (const selector of enabled) configs.push(pluginConfig(selector, true));
    for (const selector of disabled) configs.push(pluginConfig(selector, false));
    return configs;
  }

  if (!section.selector) return [];
  const capabilities = capabilityMapFromSection(section.values);
  const enabled = typeof section.values.enabled === 'boolean' ? section.values.enabled : true;
  if (unknownPluginKeys(section.values).length > 0) {
    diagnostics.push(configDiagnostic(
      'warning',
      'plugin.project_config.unknown_keys',
      `${sourceName}: unknown plugin keys ignored: ${unknownPluginKeys(section.values).join(', ')}`,
    ));
  }
  return [{
    ...pluginConfig(section.selector, enabled),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  }];
}

function pluginConfig(selector: string, enabled: boolean): ProjectNessyAgentPluginConfig {
  return selector.startsWith('plugin://')
    ? { selector, pluginInstanceId: selector, enabled }
    : { selector, pluginId: selector, enabled };
}

function capabilityMapFromSection(values: Record<string, unknown>): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {};
  for (const capability of readStringArray(values.enabled_capabilities)) capabilities[capability] = true;
  for (const capability of readStringArray(values.disabled_capabilities)) capabilities[capability] = false;
  if (isRecord(values.capabilities)) {
    for (const [capability, enabled] of Object.entries(values.capabilities)) {
      if (typeof enabled === 'boolean') capabilities[capability] = enabled;
    }
  }
  return capabilities;
}

function parseTomlValue(
  value: string,
  sourceName: string,
  line: number,
  diagnostics: PluginDiagnostic[],
): unknown {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) return [];
    return body.split(',').map(part => part.trim()).map(part => {
      if (part.startsWith('"') && part.endsWith('"')) return part.slice(1, -1);
      diagnostics.push(configDiagnostic('warning', 'plugin.project_config.unsupported_toml', `${sourceName}:${line}: arrays must contain quoted strings.`));
      return undefined;
    }).filter((part): part is string => typeof part === 'string');
  }
  diagnostics.push(configDiagnostic('warning', 'plugin.project_config.unsupported_toml', `${sourceName}:${line}: unsupported TOML value.`));
  return undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function unknownPluginKeys(values: Record<string, unknown>): string[] {
  const known = new Set(['enabled', 'enabled_capabilities', 'disabled_capabilities', 'capabilities']);
  return Object.keys(values).filter(key => !known.has(key));
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== '\\') inString = !inString;
    if (char === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

function configDiagnostic(severity: PluginDiagnostic['severity'], code: string, message: string): PluginDiagnostic {
  return pluginDiagnostic(severity, code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
