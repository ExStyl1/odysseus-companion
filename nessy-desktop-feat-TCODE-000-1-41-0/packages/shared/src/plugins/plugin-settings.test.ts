import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginSettings } from './plugin-settings.ts';
import type { PluginSettingDescriptor } from './types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-settings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PluginSettings', () => {
  it('keeps defaults in memory and atomically persists only encoded explicit overrides', async () => {
    const dataPath = join(dir, 'data');
    const pluginInstanceId = 'plugin://local/toolkit@1.0.0';
    const settings = new PluginSettings({
      dataPath,
      pluginInstanceId,
      descriptors: [
        { key: 'enabled', valueType: 'boolean', defaultValue: true },
        { key: 'retries', valueType: 'number', defaultValue: 3 },
        { key: 'theme', valueType: 'string', defaultValue: 'system' },
      ],
    });

    expect(settings.path).toBe(join(
      dataPath,
      Buffer.from(pluginInstanceId).toString('base64url'),
      'settings.json',
    ));
    expect(await settings.read()).toEqual({ enabled: true, retries: 3, theme: 'system' });
    expect(existsSync(settings.path)).toBe(false);

    await settings.write({ theme: 'dark' });

    expect(JSON.parse(readFileSync(settings.path, 'utf8'))).toEqual({ theme: 'dark' });
    expect(readdirSync(dirname(settings.path))).toEqual(['settings.json']);
    expect(await settings.read()).toEqual({ enabled: true, retries: 3, theme: 'dark' });
  });

  it('isolates settings by runtime data path and plugin instance', async () => {
    const descriptors: PluginSettingDescriptor[] = [{ key: 'enabled', valueType: 'boolean' }];
    const first = new PluginSettings({
      dataPath: join(dir, 'workspace-a'),
      pluginInstanceId: 'plugin://local/toolkit@1.0.0',
      descriptors,
    });
    const second = new PluginSettings({
      dataPath: join(dir, 'workspace-a'),
      pluginInstanceId: 'plugin://local/toolkit@2.0.0',
      descriptors,
    });
    const third = new PluginSettings({
      dataPath: join(dir, 'workspace-b'),
      pluginInstanceId: 'plugin://local/toolkit@1.0.0',
      descriptors,
    });

    await first.write({ enabled: true });
    await second.write({ enabled: false });
    await third.write({ enabled: false });

    expect(first.path).not.toBe(second.path);
    expect(first.path).not.toBe(third.path);
    expect(await first.read()).toEqual({ enabled: true });
    expect(await second.read()).toEqual({ enabled: false });
    expect(await third.read()).toEqual({ enabled: false });
  });

  it('rejects invalid descriptors, overrides, and persisted data', async () => {
    const settings = new PluginSettings({
      dataPath: join(dir, 'data'),
      pluginInstanceId: 'plugin://local/toolkit@1.0.0',
      descriptors: [
        { key: 'enabled', valueType: 'boolean' },
        { key: 'retries', valueType: 'number' },
        { key: 'theme', valueType: 'string' },
      ],
    });

    for (const values of [
      { unknown: true },
      { enabled: 'true' },
      { retries: Number.POSITIVE_INFINITY },
      { theme: null },
      { theme: ['dark'] },
      { theme: { value: 'dark' } },
    ]) {
      await expect(settings.write(values)).rejects.toThrow('plugin.settings.invalid');
    }

    expect(() => new PluginSettings({
      dataPath: join(dir, 'data'),
      pluginInstanceId: 'plugin://local/toolkit@1.0.0',
      descriptors: [unsafeDescriptor('json')],
    })).toThrow('plugin.settings.invalid');
    expect(() => new PluginSettings({
      dataPath: join(dir, 'data'),
      pluginInstanceId: 'plugin://local/toolkit@1.0.0',
      descriptors: [unsafeDescriptor('number', Number.POSITIVE_INFINITY)],
    })).toThrow('plugin.settings.invalid');

    mkdirSync(dirname(settings.path), { recursive: true });
    writeFileSync(settings.path, '{"theme":{"value":"dark"}}\n');
    await expect(settings.read()).rejects.toThrow('plugin.settings.invalid');
    writeFileSync(settings.path, '{not-json}\n');
    await expect(settings.read()).rejects.toThrow('plugin.settings.invalid');
  });
});

function unsafeDescriptor(valueType: string, defaultValue?: unknown): PluginSettingDescriptor {
  return {
    key: 'unsafe',
    valueType,
    ...(defaultValue === undefined ? {} : { defaultValue }),
  } as unknown as PluginSettingDescriptor;
}
