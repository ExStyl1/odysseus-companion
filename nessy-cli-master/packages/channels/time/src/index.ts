export { ChannelTimeAdapter } from './ChannelTimeAdapter.js';

import { ChannelTimeAdapter } from './ChannelTimeAdapter.js';
import type { ChannelPlugin } from '@nestor/nessy-cli-channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'time',
  displayName: 'Channel Time',
  requiredConfigFields: ['token', 'serverUrl'],
  createChannel: (name, config, bridge, options) =>
    new ChannelTimeAdapter(name, config, bridge, options),
};
