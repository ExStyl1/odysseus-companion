/**
 * @license
 * Copyright 2025 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../../keyMatchers.js';
import { t } from '../../../../i18n/index.js';
import { MCPServerStatus } from '@nestor/nessy-cli-core';
import type { ServerListStepProps, MCPServerDisplayInfo } from '../types.js';
import {
  groupServersBySource,
  getStatusIcon,
  getStatusColor,
} from '../utils.js';

// [nessy-fork] mcp-serverlist-scrolling
const WINDOW_SIZE = 8;

export const ServerListStep: React.FC<ServerListStepProps> = ({
  servers,
  onSelect,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const groupedServers = useMemo(
    () =>
      groupServersBySource(servers).filter((group) => group.servers.length > 0),
    [servers],
  );

  const serverNameWidth = useMemo(() => {
    if (servers.length === 0) return 20;
    const maxLength = Math.max(...servers.map((s) => s.name.length));
    return Math.min(Math.max(maxLength + 2, 20), 35);
  }, [servers]);

  const flatServers = useMemo(() => {
    const result: Array<{
      server: MCPServerDisplayInfo;
      groupIndex: number;
    }> = [];
    groupedServers.forEach((group, groupIndex) => {
      for (const server of group.servers) {
        result.push({ server, groupIndex });
      }
    });
    return result;
  }, [groupedServers]);

  const total = flatServers.length;
  const safeIndex = Math.min(selectedIndex, Math.max(0, total - 1));

  useKeypress(
    (key) => {
      if (keyMatchers[Command.SELECTION_UP](key)) {
        setSelectedIndex(Math.max(0, safeIndex - 1));
      } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
        setSelectedIndex(Math.min(total - 1, safeIndex + 1));
      } else if (key.name === 'return') {
        onSelect(safeIndex);
      }
    },
    { isActive: true },
  );

  if (servers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('No MCP servers configured.')}
        </Text>
        <Text color={theme.text.secondary}>
          {t('Add MCP servers to your settings to get started.')}
        </Text>
      </Box>
    );
  }

  let start = safeIndex - Math.floor(WINDOW_SIZE / 2);
  start = Math.max(0, Math.min(start, Math.max(0, total - WINDOW_SIZE)));

  const end = Math.min(total, start + WINDOW_SIZE);

  const hasMoreAbove = start > 0;
  const hasMoreBelow = end < total;

  type VisibleGroup = {
    key: string;
    displayName: string;
    configPath?: string;
    items: Array<{ server: MCPServerDisplayInfo; globalIndex: number }>;
  };

  const visibleGroups: VisibleGroup[] = [];
  for (let i = start; i < end; i++) {
    const { server, groupIndex } = flatServers[i];
    const group = groupedServers[groupIndex];
    const last = visibleGroups[visibleGroups.length - 1];

    if (!last || last.key !== group.source) {
      visibleGroups.push({
        key: group.source,
        displayName: group.displayName,
        configPath: group.servers[0]?.configPath,
        items: [{ server, globalIndex: i }],
      });
    } else {
      last.items.push({ server, globalIndex: i });
    }
  }

  return (
    <Box flexDirection="column">
      <Box flexShrink={0}>
        <Text color={theme.text.secondary}>
          {hasMoreAbove
            ? `  ▲ ${t('{{count}} more above', { count: String(start) })}`
            : ' '}
        </Text>
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {visibleGroups.map((group, vgIndex) => (
          <Box key={group.key} flexDirection="column" flexShrink={0}>
            {vgIndex > 0 && (
              <Box flexShrink={0}>
                <Text> </Text>
              </Box>
            )}

            <Box flexShrink={0}>
              <Text bold color={theme.text.primary}>
                {`  ${group.displayName}`}
                {group.configPath && (
                  <Text color={theme.text.secondary}>
                    {' '}
                    ({group.configPath})
                  </Text>
                )}
              </Text>
            </Box>

            {group.items.map(({ server, globalIndex }) => {
              const isSelected = globalIndex === safeIndex;
              const needsAuth =
                !server.isDisabled &&
                !!server.requiresAuth &&
                server.status !== MCPServerStatus.CONNECTED;
              const statusColor =
                server.isDisabled || needsAuth
                  ? 'yellow'
                  : getStatusColor(server.status);

              return (
                <Box key={server.name} flexShrink={0}>
                  <Box minWidth={2}>
                    <Text
                      color={
                        isSelected ? theme.text.accent : theme.text.primary
                      }
                    >
                      {isSelected ? '❯' : ' '}
                    </Text>
                  </Box>
                  {/* 服务器名称 - 固定宽度 */}
                  <Box width={serverNameWidth}>
                    <Text
                      color={
                        isSelected ? theme.text.accent : theme.text.primary
                      }
                      wrap="truncate"
                    >
                      {server.name}
                    </Text>
                  </Box>
                  <Text color={theme.text.secondary}> · </Text>
                  {/* 状态图标和文本 */}
                  <Text
                    color={
                      statusColor === 'green'
                        ? theme.status.success
                        : statusColor === 'yellow'
                          ? theme.status.warning
                          : theme.status.error
                    }
                  >
                    {getStatusIcon(server.status)}{' '}
                    {server.isDisabled
                      ? t('disabled')
                      : needsAuth
                        ? t('needs authentication')
                        : t(server.status)}
                  </Text>
                  {!!server.invalidToolCount && server.invalidToolCount > 0 && (
                    <Text color={theme.status.warning}>
                      {' '}
                      {t('{{count}} invalid tools', {
                        count: String(server.invalidToolCount),
                      })}
                    </Text>
                  )}
                  {server.isBlocked && (
                    <Text color={theme.text.secondary}>
                      {' '}
                      🔒 {t('for external models')}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>

      <Box flexShrink={0}>
        <Text color={theme.text.secondary}>
          {hasMoreBelow
            ? `  ▼ ${t('{{count}} more below', {
                count: String(total - end),
              })}`
            : ' '}
        </Text>
      </Box>

      {servers.some((s) => s.status === 'disconnected' && !s.isDisabled) && (
        <Box marginTop={1} flexShrink={0}>
          <Text color={theme.status.warning}>
            ※ {t('Run nessy --debug to see error logs')}
          </Text>
        </Box>
      )}
    </Box>
  );
};
