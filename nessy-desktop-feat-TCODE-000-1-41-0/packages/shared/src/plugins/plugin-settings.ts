import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialId, StoredCredential } from '../credentials/types.ts';
import { resolvePluginDataPath } from './data-paths.ts';
import {
  isSensitivePluginConfigurationField,
  pluginOptionEnvironment,
  readPluginConfiguration,
  resolvePluginConfigurationLayers,
  resolvePluginUserConfiguration,
  type PluginConfigurationValue,
} from './mcpb-configuration.ts';
import { writeJsonAtomic } from './marketplace-registry-store.ts';
import type { PluginInstalledEntryV2 } from './store-v2.ts';
import type { PluginSettingDescriptor, PluginUserConfigurationDescriptor } from './types.ts';

export type PluginSettingValue = string | number | boolean;

export interface PluginSettingsOptions {
  dataPath: string;
  pluginInstanceId: string;
  descriptors: readonly PluginSettingDescriptor[];
}

type PluginSettingValueType = 'string' | 'number' | 'boolean';
type SettingDescriptor = {
  valueType: PluginSettingValueType;
  defaultValue?: PluginSettingValue;
};

export class PluginSettings {
  readonly path: string;
  private readonly descriptors = new Map<string, SettingDescriptor>();

  constructor(options: PluginSettingsOptions) {
    if (typeof options.dataPath !== 'string' || options.dataPath.length === 0
      || typeof options.pluginInstanceId !== 'string' || options.pluginInstanceId.length === 0) {
      throw invalidSettings();
    }
    this.path = join(options.dataPath, Buffer.from(options.pluginInstanceId).toString('base64url'), 'settings.json');
    for (const descriptor of options.descriptors) {
      if (!descriptor || typeof descriptor.key !== 'string' || descriptor.key.length === 0
        || forbiddenKeys.has(descriptor.key) || this.descriptors.has(descriptor.key)
        || !isValueType(descriptor.valueType)) {
        throw invalidSettings();
      }
      const hasDefault = Object.hasOwn(descriptor, 'defaultValue');
      if (hasDefault && !isValue(descriptor.valueType, descriptor.defaultValue)) throw invalidSettings();
      this.descriptors.set(descriptor.key, {
        valueType: descriptor.valueType,
        ...(hasDefault ? { defaultValue: descriptor.defaultValue } : {}),
      });
    }
  }

  async read(): Promise<Record<string, PluginSettingValue>> {
    return this.withDefaults(await this.readOverrides());
  }

  async readOverrides(): Promise<Record<string, PluginSettingValue>> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw invalidSettings();
    }
    return this.validateOverrides(parsed);
  }

  async write(overrides: Record<string, unknown>): Promise<void> {
    await writeJsonAtomic(this.path, this.validateOverrides(overrides));
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  private validateOverrides(input: unknown): Record<string, PluginSettingValue> {
    if (!isFlatObject(input)) throw invalidSettings();
    const overrides: Record<string, PluginSettingValue> = {};
    for (const [key, value] of Object.entries(input)) {
      const descriptor = this.descriptors.get(key);
      if (!descriptor || forbiddenKeys.has(key) || !isValue(descriptor.valueType, value)) {
        throw invalidSettings();
      }
      overrides[key] = value;
    }
    return overrides;
  }

  private withDefaults(overrides: Record<string, PluginSettingValue>): Record<string, PluginSettingValue> {
    const values: Record<string, PluginSettingValue> = {};
    for (const [key, descriptor] of this.descriptors) {
      if (Object.hasOwn(descriptor, 'defaultValue')) {
        values[key] = descriptor.defaultValue as PluginSettingValue;
      }
    }
    return { ...values, ...overrides };
  }
}

/**
 * Non-sensitive plugin option values (`plugins/manifest-reference.md#where-values-are-stored` — "stored under
 * the `pluginConfigs` key in your user `settings.json` as
 * `pluginConfigs[<plugin-id>].options`").
 *
 * Nessy's equivalent of "your user `settings.json`" is this file, under the
 * host-owned plugin data root that `resolvePluginDataPath` derives. The
 * constructor takes a `dataPath` and a plugin instance id and nothing else: there
 * is deliberately NO project root, no workspace file and no overlay parameter, so
 * `:601`'s workspace-resident sources cannot be admitted by passing an argument.
 * Adding one would be the change that reintroduces the vulnerability.
 *
 * Sensitive fields are refused outright rather than skipped — a sensitive value
 * belongs in the credential manager, and a descriptor list that contains one
 * means the caller split the fields wrongly.
 */
export class PluginUserConfigStore {
  readonly path: string;
  private readonly descriptors: PluginUserConfigurationDescriptor[] = [];

  constructor(options: {
    dataPath: string;
    pluginInstanceId: string;
    descriptors: readonly PluginUserConfigurationDescriptor[];
  }) {
    if (typeof options.dataPath !== 'string' || options.dataPath.length === 0
      || typeof options.pluginInstanceId !== 'string' || options.pluginInstanceId.length === 0) {
      throw invalidSettings();
    }
    this.path = join(
      options.dataPath,
      Buffer.from(options.pluginInstanceId).toString('base64url'),
      'user-config.json',
    );
    const seen = new Set<string>();
    for (const descriptor of options.descriptors) {
      if (!descriptor || typeof descriptor.key !== 'string' || descriptor.key.length === 0
        || forbiddenKeys.has(descriptor.key) || seen.has(descriptor.key)
        || isSensitivePluginConfigurationField(descriptor)) {
        throw invalidSettings();
      }
      seen.add(descriptor.key);
      this.descriptors.push(descriptor);
    }
  }

  async read(): Promise<Record<string, PluginConfigurationValue>> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw invalidSettings();
    }
    if (!isFlatObject(parsed)) throw invalidSettings();
    // The stored file is a `user` layer by construction, and it is the only
    // layer this store can produce. Routing it through the shared resolver keeps
    // the source gate on the one path that reads values off disk.
    return resolvePluginConfigurationLayers([{ source: 'user', values: parsed }], this.descriptors);
  }

  async write(values: Record<string, PluginConfigurationValue>): Promise<void> {
    const accepted = resolvePluginConfigurationLayers([{ source: 'user', values }], this.descriptors);
    if (Object.keys(accepted).length !== Object.keys(values).length) throw invalidSettings();
    await writeJsonAtomic(this.path, accepted);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/**
 * The `CLAUDE_PLUGIN_OPTION_<KEY>` environment one plugin's HOOK processes
 * receive (`plugins/manifest-reference.md#environment-variables`), read from the two stores the documented
 * split writes to.
 *
 * The host calls this once per active plugin instance while assembling
 * capability-resolution inputs. It is the single reader of configured option
 * values outside the management service, and it takes no project or workspace
 * path — `:601`'s settings sources have no way in here either.
 *
 * Values are never logged, returned in a diagnostic, or folded into a hash.
 */
export async function readPluginOptionEnvironment(options: {
  installed: PluginInstalledEntryV2;
  workspaceId: string;
  dataDir?: string;
  readCredential: (id: CredentialId) => Promise<StoredCredential | null | undefined>;
}): Promise<Record<string, string> | undefined> {
  const configuration = resolvePluginUserConfiguration(options.installed, options.workspaceId);
  if (!configuration) return undefined;
  const sensitive = configuration.sensitiveFields.length > 0
    ? readPluginConfiguration(
        await options.readCredential(configuration.credentialId),
        configuration.sensitiveFields,
      )
    : {};
  const plain = configuration.plainFields.length > 0
    ? await new PluginUserConfigStore({
        dataPath: resolvePluginDataPath(
          options.installed.pluginKey,
          { workspaceId: options.workspaceId },
          options.dataDir,
        ),
        pluginInstanceId: options.installed.pluginInstanceId,
        descriptors: configuration.plainFields,
      }).read()
    : {};
  const environment = pluginOptionEnvironment(configuration.fields, { ...sensitive, ...plain });
  return Object.keys(environment).length > 0 ? environment : undefined;
}

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

function isValueType(value: unknown): value is PluginSettingValueType {
  return value === 'string' || value === 'number' || value === 'boolean';
}

function isValue(valueType: PluginSettingValueType, value: unknown): value is PluginSettingValue {
  if (valueType === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === valueType;
}

function isFlatObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function invalidSettings(): Error {
  return new Error('plugin.settings.invalid');
}
