/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAgentLaunchMode,
  StatistClient,
  STATIST_MARKETPLACE_PROJECT,
  STATIST_AIDT_PROJECT,
} from './statistClient.js';
import type { Config } from '../config/config.js';
import {
  StatistEventName,
  CounterGroup,
  type StatistEvent,
} from './statistEvents.js';

const { debugLogger, fetchMock, dispatcher, buildRuntimeFetchOptionsMock } =
  vi.hoisted(() => ({
    debugLogger: {
      isEnabled: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    fetchMock: vi.fn(),
    dispatcher: {},
    buildRuntimeFetchOptionsMock: vi.fn(),
  }));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => debugLogger,
}));

vi.mock('../utils/runtimeFetchOptions.js', () => ({
  buildRuntimeFetchOptions: buildRuntimeFetchOptionsMock.mockReturnValue({
    fetch: fetchMock,
    fetchOptions: { dispatcher },
  }),
}));

describe('getAgentLaunchMode', () => {
  function config(channel: string | undefined, interactive = false): Config {
    return {
      getChannel: () => channel,
      isInteractive: () => interactive,
    } as Config;
  }

  it.each([
    ['VSCode', 'vscode'],
    ['ACP', 'acp'],
    ['SDK', 'sdk'],
    ['CI', 'ci'],
    ['JetBrains', 'jetbrains'],
    ['NessyCoWork', 'nessycowork'],
    ['desktop', 'desktop'],
  ])('maps the %s channel to %s', (channel, launchMode) => {
    expect(getAgentLaunchMode(config(channel))).toBe(launchMode);
  });

  it('uses the execution mode when no channel is provided', () => {
    expect(getAgentLaunchMode(config(undefined, true))).toBe('tui');
    expect(getAgentLaunchMode(config(undefined))).toBe('nonInteractive');
  });
});

describe('StatistClient — plugin.install (Marketplace) event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentEvents(): StatistEvent[] {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as { body: string };
    return JSON.parse(init.body) as StatistEvent[];
  }

  it('sends to the Marketplace project under the plugin.install name', async () => {
    const client = new StatistClient(STATIST_AIDT_PROJECT, 'device-123');

    client.sendPluginInstallEvent({
      packageName: '@ai-office/nessy-extension-foo',
      installStatus: 'success',
      pluginKind: 'nessy-extension',
      userId: 'user-1',
    });
    await client.flush();

    const [event] = sentEvents();
    expect(event.name).toBe(StatistEventName.PluginInstall);
    expect(event.name).toBe('plugin.install');
    expect(event.project).toBe(STATIST_MARKETPLACE_PROJECT);
    expect(event.project).toBe('coretech.skills.marketplace');
  });

  it('uses the shared runtime dispatcher', async () => {
    const client = new StatistClient(
      STATIST_AIDT_PROJECT,
      'device-123',
      'http://proxy.local',
    );

    client.sendCounterEvent({
      userId: 'user-1',
      group: CounterGroup.Chat,
      name: 'something',
    });
    await client.flush();

    expect(buildRuntimeFetchOptionsMock).toHaveBeenCalledWith(
      'openai',
      'http://proxy.local',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-statist.tinkoff.ru/gateway/v1/events',
      expect.objectContaining({ dispatcher }),
    );
  });

  it('logs successful delivery with the event count', async () => {
    const client = new StatistClient(STATIST_AIDT_PROJECT, 'device-123');

    client.sendCounterEvent({
      userId: 'user-1',
      group: CounterGroup.Chat,
      name: 'something',
    });
    await client.flush();

    expect(debugLogger.debug).toHaveBeenCalledWith(
      'Statist events sent successfully: count=1, status=200 OK',
    );
  });

  it('keeps marketplace params first (string_0/1/2), then common params', async () => {
    const client = new StatistClient(STATIST_AIDT_PROJECT, 'device-123');

    client.sendPluginInstallEvent({
      packageName: '@ai-office/nessy-extension-foo',
      installStatus: 'error',
      pluginKind: 'nessy-extension',
      userId: 'user-1',
    });
    await client.flush();

    const [event] = sentEvents();
    // The first 3 keys are significant: they map to parameters_string_0/1/2.
    // Common params (userId, pluginType) follow and must not shift them.
    expect(Object.keys(event.parameters).slice(0, 3)).toEqual([
      'packageName',
      'installStatus',
      'pluginKind',
    ]);
    expect(event.parameters).toMatchObject({
      packageName: '@ai-office/nessy-extension-foo',
      installStatus: 'error',
      pluginKind: 'nessy-extension',
      userId: 'user-1',
    });
    // Common pluginType IS applied, like on every other event.
    expect((event.parameters as { pluginType?: string }).pluginType).toBe(
      'nessy-cli',
    );
  });

  it('does not affect other events: they keep their project and pluginType', async () => {
    const client = new StatistClient(STATIST_AIDT_PROJECT, 'device-123');

    client.sendCounterEvent({
      userId: 'user-1',
      group: CounterGroup.Chat,
      name: 'something',
    });
    await client.flush();

    const [event] = sentEvents();
    expect(event.project).toBe(STATIST_AIDT_PROJECT);
    expect((event.parameters as { pluginType?: string }).pluginType).toBe(
      'nessy-cli',
    );
  });

  it('flush() is a no-op (no request) when nothing is queued', async () => {
    const client = new StatistClient(STATIST_AIDT_PROJECT, 'device-123');
    await client.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flush() drains the queue so a second flush sends nothing', async () => {
    const client = new StatistClient(STATIST_AIDT_PROJECT, 'device-123');
    client.sendPluginInstallEvent({
      packageName: 'pkg',
      installStatus: 'success',
      pluginKind: 'nessy-extension',
      userId: 'user-1',
    });

    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs the underlying network error code and cause', async () => {
    const cause = Object.assign(
      new Error('getaddrinfo ENOTFOUND api-statist.tinkoff.ru'),
      { code: 'ENOTFOUND' },
    );
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause }));
    const client = new StatistClient(STATIST_AIDT_PROJECT, 'device-123');

    client.sendCounterEvent({
      userId: 'user-1',
      group: CounterGroup.Chat,
      name: 'something',
    });
    await client.flush();

    expect(debugLogger.error).toHaveBeenCalledWith(
      'Statist request failed [TypeError:ENOTFOUND]: fetch failed ' +
        '(cause: getaddrinfo ENOTFOUND api-statist.tinkoff.ru)',
    );
    expect(debugLogger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('Statist events sent successfully'),
    );
  });
});
