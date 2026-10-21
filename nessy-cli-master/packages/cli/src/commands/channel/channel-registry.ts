import type { ChannelPlugin } from '@nestor/nessy-cli-channel-base';

const registry = new Map<string, ChannelPlugin>();
let builtinsPromise: Promise<void> | null = null;

function ensureBuiltins(): Promise<void> {
  if (!builtinsPromise) {
    builtinsPromise = (async () => {
      const labelled = [
        { name: 'telegram', promise: import('@nestor/nessy-cli-channel-telegram') },
        { name: 'weixin', promise: import('@nestor/nessy-cli-channel-weixin') },
        { name: 'dingtalk', promise: import('@nestor/nessy-cli-channel-dingtalk') },
        { name: 'feishu', promise: import('@nestor/nessy-cli-channel-feishu') },
        { name: 'qqbot', promise: import('@nestor/nessy-cli-channel-qqbot') },
      ];

      const results = await Promise.allSettled(labelled.map((l) => l.promise));

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status === 'fulfilled') {
          registry.set(result.value.plugin.channelType, result.value.plugin);
        } else {
          process.stderr.write(
            `[channel-registry] Failed to load "${labelled[i]!.name}" channel: ${result.reason}\n`,
          );
        }
      }
    })();
  }
  return builtinsPromise;
}

export function registerPlugin(plugin: ChannelPlugin): void {
  if (registry.has(plugin.channelType)) {
    throw new Error(
      `Channel type "${plugin.channelType}" is already registered.`,
    );
  }
  registry.set(plugin.channelType, plugin);
}

export async function getPlugin(
  channelType: string,
): Promise<ChannelPlugin | undefined> {
  await ensureBuiltins();
  return registry.get(channelType);
}

export async function supportedTypes(): Promise<string[]> {
  await ensureBuiltins();
  return [...registry.keys()];
}
