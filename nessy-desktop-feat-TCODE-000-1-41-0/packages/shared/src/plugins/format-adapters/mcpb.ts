import { constants } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  createPluginCapabilityId,
  isRecord,
  normalizeNessyPluginManifest,
  pluginDiagnostic,
  validatePluginRelativePath,
} from '../schema.ts';
import { UNDECLARED_PLUGIN_VERSION } from '../types.ts';
import type {
  NessyPluginManifest,
  PluginCapability,
  PluginCompatibilityReport,
  PluginDiagnostic,
  PluginNormalizationResult,
  PluginOrigin,
  PluginSettingDescriptor,
  PluginUserConfigurationDescriptor,
} from '../types.ts';

export const MCPB_ADAPTER_ID = 'mcpb-v1';
export const MCPB_ADAPTER_VERSION = '1';
export const MCPB_MANIFEST_PATH = 'manifest.json';

const SUPPORTED_MANIFEST_VERSIONS = new Set(['0.1', '0.2', '0.3']);
const USER_CONFIG_REFERENCE = /\$\{user_config\.([A-Za-z0-9._-]+)\}/g;
const FORBIDDEN_USER_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

interface McpbUserConfig {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  sensitive: boolean;
  required: boolean;
  defaultValue?: string | number | boolean;
}

export async function detectMcpbBundle(rootDirectory: string): Promise<boolean> {
  try {
    const input = JSON.parse(await readFile(join(rootDirectory, MCPB_MANIFEST_PATH), 'utf8')) as unknown;
    return isRecord(input)
      && (typeof input.manifest_version === 'string' || typeof input.dxt_version === 'string')
      && isRecord(input.server);
  } catch {
    return false;
  }
}

export async function normalizeMcpbBundle(
  rootDirectory: string,
  origin: PluginOrigin,
): Promise<PluginNormalizationResult> {
  let input: Record<string, unknown>;
  try {
    const raw = JSON.parse(await readFile(join(rootDirectory, MCPB_MANIFEST_PATH), 'utf8')) as unknown;
    if (!isRecord(raw)) throw new Error('manifest must be an object');
    input = raw;
  } catch (error) {
    return failure('plugin.format.mcpb_manifest_unreadable', `MCPB manifest could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  const diagnostics: PluginDiagnostic[] = [];
  const manifestVersion = stringValue(input.manifest_version) ?? stringValue(input.dxt_version);
  const alternateVersion = stringValue(input.manifest_version) && stringValue(input.dxt_version);
  if (!manifestVersion || !SUPPORTED_MANIFEST_VERSIONS.has(manifestVersion) || (alternateVersion && alternateVersion !== manifestVersion)) {
    diagnostics.push(pluginDiagnostic(
      'error',
      'plugin.format.mcpb_version_unsupported',
      `Unsupported MCPB manifest version "${manifestVersion ?? 'missing'}".`,
      'manifest_version',
    ));
  }

  const compatibility = isRecord(input.compatibility) ? input.compatibility : undefined;
  const platforms = compatibility?.platforms;
  if (platforms !== undefined && (!Array.isArray(platforms) || !platforms.every(value => typeof value === 'string'))) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_platforms_invalid', 'MCPB compatibility.platforms must be an array of platform names.', 'compatibility.platforms'));
  } else if (Array.isArray(platforms) && !platforms.includes(process.platform)) {
    diagnostics.push(pluginDiagnostic(
      'error',
      'plugin.format.mcpb_platform_unsupported',
      `MCPB extension does not support ${process.platform}.`,
      'compatibility.platforms',
      { platform: process.platform },
    ));
  }

  const server = isRecord(input.server) ? input.server : undefined;
  const serverType = stringValue(server?.type);
  const supportedServerType = serverType === 'node' || serverType === 'python' || serverType === 'binary'
    ? serverType
    : undefined;
  if (!supportedServerType) {
    diagnostics.push(pluginDiagnostic(
      'error',
      'plugin.format.mcpb_server_type_unsupported',
      `Unsupported MCPB server type "${serverType ?? 'missing'}".`,
      'server.type',
    ));
  }
  const entryPoint = stringValue(server?.entry_point);
  const entryPointError = entryPoint ? validatePluginRelativePath(entryPoint) : 'MCPB server entry_point is required.';
  if (entryPointError) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_entry_point_invalid', entryPointError, 'server.entry_point'));
  } else {
    try {
      const stats = await lstat(join(rootDirectory, ...entryPoint!.split('/')));
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('entry point must be a regular file');
      if (supportedServerType === 'binary') await access(join(rootDirectory, ...entryPoint!.split('/')), constants.X_OK);
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'error',
        'plugin.format.mcpb_entry_point_unavailable',
        `MCPB entry point is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'server.entry_point',
      ));
    }
  }

  const userConfig = normalizeUserConfig(input.user_config, diagnostics);
  const mcpConfig = resolveMcpConfig(server?.mcp_config, diagnostics);
  const normalizedMcp = supportedServerType && entryPoint && mcpConfig
    ? normalizeMcpConfig(supportedServerType, entryPoint, mcpConfig, userConfig, diagnostics)
    : undefined;
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error') || !normalizedMcp || !supportedServerType || !entryPoint) {
    return { ok: false, diagnostics };
  }

  const settings = [...userConfig.entries()]
    .filter(([, config]) => !config.sensitive)
    .map(([key, config]): PluginSettingDescriptor => ({
      key,
      valueType: settingValueType(config),
      ...(config.defaultValue !== undefined ? { defaultValue: config.defaultValue } : {}),
      ...(config.required ? { required: true } : {}),
    }));
  const userConfiguration = [...userConfig.entries()].map(([key, config]): PluginUserConfigurationDescriptor => ({
    key,
    valueType: config.sensitive ? 'secret-ref' : config.type,
    ...(config.required ? { required: true } : {}),
    ...(config.defaultValue !== undefined ? { defaultValue: config.defaultValue as string | number | boolean } : {}),
  }));
  const settingCapabilities: PluginCapability[] = settings.map(setting => ({
    id: createPluginCapabilityId('setting', safeId(setting.key)),
    kind: 'setting',
    setting,
  }));
  const mcpCapability: PluginCapability = {
    id: createPluginCapabilityId('mcp', 'server'),
    kind: 'mcp',
    displayName: stringValue(input.display_name) ?? stringValue(input.name),
    description: stringValue(input.description),
    trust: { required: true, reason: 'Imported MCPB extension executes a local MCP server.' },
    mcp: {
      serverName: safeId(stringValue(input.name) ?? basename(rootDirectory)),
      transport: 'stdio',
      command: normalizedMcp.command,
      args: normalizedMcp.args,
      cwd: '${NESSY_PLUGIN_ROOT}',
      ...(Object.keys(normalizedMcp.env).length ? { env: normalizedMcp.env } : {}),
      ...(Object.keys(normalizedMcp.environmentDefaults).length ? { environmentDefaults: normalizedMcp.environmentDefaults } : {}),
      ...(normalizedMcp.requiredEnvironmentNames.length ? { requiredEnvironmentNames: normalizedMcp.requiredEnvironmentNames } : {}),
      ...(Object.keys(normalizedMcp.credentialEnvironment).length ? { credentialEnvironment: normalizedMcp.credentialEnvironment } : {}),
      ...(userConfiguration.length ? { userConfiguration } : {}),
    },
  };
  const id = safeId(stringValue(input.name) ?? basename(rootDirectory));
  const nativeCandidate = {
    schemaVersion: 1,
    kind: 'plugin',
    id,
    name: stringValue(input.display_name) ?? stringValue(input.name) ?? id,
    // Same placeholder, same rule: absent means absent, never "0.0.0" (Q10-4).
    version: stringValue(input.version) ?? UNDECLARED_PLUGIN_VERSION,
    description: stringValue(input.description) ?? 'Imported MCPB extension',
    ...(isRecord(input.author) && stringValue(input.author.name) ? { publisher: stringValue(input.author.name) } : {}),
    ...(stringValue(input.homepage) ? { homepageUrl: stringValue(input.homepage) } : {}),
    capabilities: [mcpCapability, ...settingCapabilities],
    ...(settings.length ? { nessyExtensions: { settings } } : {}),
    runtimeCompatibility: { profiles: ['generic-plugin-env-v1'] },
  };
  const normalized = normalizeNessyPluginManifest(nativeCandidate, {
    origin: { ...origin, adapterId: MCPB_ADAPTER_ID, adapterVersion: MCPB_ADAPTER_VERSION },
  });
  if (!normalized.value) return { ok: false, diagnostics: [...diagnostics, ...normalized.diagnostics] };

  const manifest: NessyPluginManifest = {
    ...normalized.value,
    compatibility: {
      rawExternalKind: 'mcpb',
      adapter: {
        adapterId: MCPB_ADAPTER_ID,
        adapterVersion: MCPB_ADAPTER_VERSION,
        rawKind: 'mcpb',
        rawManifestPath: MCPB_MANIFEST_PATH,
      },
    },
  };
  const report: PluginCompatibilityReport = {
    format: 'claude',
    state: 'supported',
    supportedKinds: settings.length ? ['mcp', 'setting'] : ['mcp'],
    deferred: [],
    blocked: [],
  };
  return { ok: true, value: manifest, compatibility: report, diagnostics: [...diagnostics, ...normalized.diagnostics] };
}

function normalizeUserConfig(input: unknown, diagnostics: PluginDiagnostic[]): Map<string, McpbUserConfig> {
  const result = new Map<string, McpbUserConfig>();
  if (input === undefined) return result;
  if (!isRecord(input)) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_user_config_invalid', 'MCPB user_config must be an object.', 'user_config'));
    return result;
  }
  for (const [key, raw] of Object.entries(input)) {
    if (!/^[A-Za-z0-9._-]+$/.test(key) || FORBIDDEN_USER_CONFIG_KEYS.has(key) || !isRecord(raw)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_user_config_invalid', `MCPB user configuration "${key}" is invalid.`, `user_config.${key}`));
      continue;
    }
    const type = stringValue(raw.type);
    if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'directory' && type !== 'file') {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_user_config_type_unsupported', `Unsupported MCPB user configuration type "${type ?? 'missing'}".`, `user_config.${key}.type`));
      continue;
    }
    if (raw.multiple === true) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_multiple_config_unsupported', `MCPB multiple-value configuration "${key}" is not supported.`, `user_config.${key}.multiple`));
      continue;
    }
    const sensitive = raw.sensitive === true;
    if (sensitive && (type !== 'string' || raw.default !== undefined)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_sensitive_config_invalid', `Sensitive MCPB configuration "${key}" must be a string without a default value.`, `user_config.${key}`));
      continue;
    }
    if (raw.default !== undefined && !isValidDefault(type, raw.default)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_user_config_default_invalid', `MCPB configuration "${key}" default does not match its declared type.`, `user_config.${key}.default`));
      continue;
    }
    result.set(key, {
      type,
      sensitive,
      required: raw.required === true,
      ...(raw.default !== undefined ? { defaultValue: raw.default as string | number | boolean } : {}),
    });
  }
  return result;
}

function resolveMcpConfig(input: unknown, diagnostics: PluginDiagnostic[]): Record<string, unknown> | undefined {
  if (!isRecord(input)) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_mcp_config_missing', 'MCPB server.mcp_config is required.', 'server.mcp_config'));
    return undefined;
  }
  const overrides = isRecord(input.platform_overrides) ? input.platform_overrides : undefined;
  const override: Record<string, unknown> | undefined = overrides && isRecord(overrides[process.platform])
    ? overrides[process.platform] as Record<string, unknown>
    : undefined;
  return {
    ...input,
    ...override,
    ...(isRecord(input.env) || isRecord(override?.env)
      ? { env: { ...(isRecord(input.env) ? input.env : {}), ...(isRecord(override?.env) ? override.env : {}) } }
      : {}),
  };
}

function normalizeMcpConfig(
  serverType: 'node' | 'python' | 'binary',
  entryPoint: string,
  input: Record<string, unknown>,
  userConfig: Map<string, McpbUserConfig>,
  diagnostics: PluginDiagnostic[],
): {
  command: string;
  args: string[];
  env: Record<string, string>;
  environmentDefaults: Record<string, string>;
  requiredEnvironmentNames: string[];
  credentialEnvironment: Record<string, string>;
} | undefined {
  const rawCommand = stringValue(input.command);
  const allowedCommands = serverType === 'node'
    ? new Set(['node', 'node.exe'])
    : serverType === 'python'
      ? new Set(['python', 'python.exe', 'python3', 'python3.exe'])
      : undefined;
  let command: string;
  if (allowedCommands) {
    if (rawCommand && !allowedCommands.has(rawCommand)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_executable_mismatch', `MCPB ${serverType} server declared unsupported executable "${rawCommand}".`, 'server.mcp_config.command'));
      return undefined;
    }
    command = serverType === 'node' ? 'node' : 'python3';
  } else {
    const declared = rawCommand ? normalizeBundleReference(rawCommand) : entryPoint;
    if (declared !== entryPoint) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_executable_mismatch', 'MCPB binary command must match server.entry_point.', 'server.mcp_config.command'));
      return undefined;
    }
    command = `\${NESSY_PLUGIN_ROOT}/${entryPoint}`;
  }

  const rawArgs = input.args === undefined ? [] : input.args;
  if (!Array.isArray(rawArgs) || !rawArgs.every(value => typeof value === 'string')) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_args_invalid', 'MCPB server.mcp_config.args must be an array of strings.', 'server.mcp_config.args'));
    return undefined;
  }
  const aliases = new Map([...userConfig].filter(([, config]) => !config.sensitive).map(([key]) => [key, `MCPB_CONFIG_${safeEnvName(key)}`]));
  const args = rawArgs.length
    ? rawArgs.map(value => rewriteConfigReferences(value, userConfig, aliases, false, diagnostics, 'server.mcp_config.args'))
    : serverType === 'binary' ? [] : [`\${NESSY_PLUGIN_ROOT}/${entryPoint}`];
  if (serverType !== 'binary' && !args.some(value => normalizeBundleReference(value) === entryPoint)) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_entry_point_undeclared', 'MCPB runtime arguments must reference server.entry_point.', 'server.mcp_config.args'));
  }

  const rawEnv = input.env === undefined ? {} : input.env;
  if (!isRecord(rawEnv) || !Object.values(rawEnv).every(value => typeof value === 'string')) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_env_invalid', 'MCPB server.mcp_config.env must be a string map.', 'server.mcp_config.env'));
    return undefined;
  }
  const env: Record<string, string> = {};
  const credentialEnvironment: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(rawEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_env_name_invalid', `Invalid MCPB environment name "${name}".`, `server.mcp_config.env.${name}`));
      continue;
    }
    const sensitiveMatch = /^\$\{user_config\.([A-Za-z0-9._-]+)\}$/.exec(rawValue as string);
    if (sensitiveMatch && userConfig.get(sensitiveMatch[1]!)?.sensitive) {
      credentialEnvironment[name] = sensitiveMatch[1]!;
      continue;
    }
    env[name] = rewriteConfigReferences(rawValue as string, userConfig, aliases, false, diagnostics, `server.mcp_config.env.${name}`);
  }

  const environmentDefaults: Record<string, string> = {};
  const requiredEnvironmentNames: string[] = [];
  for (const [key, alias] of aliases) {
    const config = userConfig.get(key)!;
    credentialEnvironment[alias] = key;
    if (config.defaultValue !== undefined) environmentDefaults[alias] = String(config.defaultValue);
    else if (config.required) requiredEnvironmentNames.push(alias);
  }
  return {
    command,
    args,
    env,
    environmentDefaults,
    requiredEnvironmentNames: [...new Set(requiredEnvironmentNames)].sort(),
    credentialEnvironment,
  };
}

function isValidDefault(type: McpbUserConfig['type'], value: unknown): boolean {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string';
}

function rewriteConfigReferences(
  input: string,
  userConfig: Map<string, McpbUserConfig>,
  aliases: Map<string, string>,
  allowSensitive: boolean,
  diagnostics: PluginDiagnostic[],
  path: string,
): string {
  const withRoot = input.replaceAll('${__dirname}', '${NESSY_PLUGIN_ROOT}');
  return withRoot.replace(USER_CONFIG_REFERENCE, (match, key: string) => {
    const config = userConfig.get(key);
    if (!config) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_user_config_unknown', `MCPB configuration reference "${key}" is not declared.`, path));
      return match;
    }
    if (config.sensitive && !allowSensitive) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.mcpb_sensitive_config_exposed', `Sensitive MCPB configuration "${key}" may only bind to a dedicated environment variable.`, path));
      return match;
    }
    return `\${${aliases.get(key) ?? safeEnvName(key)}}`;
  });
}

function normalizeBundleReference(input: string): string {
  return input
    .replace(/^\$\{(?:__dirname|NESSY_PLUGIN_ROOT)\}\//, '')
    .replace(/^\.\//, '');
}

function settingValueType(config: McpbUserConfig): PluginSettingDescriptor['valueType'] {
  return config.type === 'number' || config.type === 'boolean' ? config.type : 'string';
}

function safeId(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'mcpb-extension';
}

function safeEnvName(input: string): string {
  return input.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^([^A-Za-z_])/, '_$1').toUpperCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function failure(code: string, message: string): PluginNormalizationResult {
  return { ok: false, diagnostics: [pluginDiagnostic('error', code, message, MCPB_MANIFEST_PATH)] };
}
