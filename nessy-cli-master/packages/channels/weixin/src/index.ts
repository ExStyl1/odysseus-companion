export { WeixinChannel } from './WeixinAdapter.js';

import { WeixinChannel } from './WeixinAdapter.js';
import type { ChannelPlugin } from '@nestor/nessy-cli-channel-base';

export const plugin: ChannelPlugin = {
  channelType: 'weixin',
  displayName: 'WeChat',
  createChannel: (name, config, bridge, options) =>
    new WeixinChannel(name, config, bridge, options),
};
