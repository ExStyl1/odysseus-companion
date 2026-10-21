/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';

// [nessy-fork] dp-auth
interface DpAuthProgressProps {
  onCancel: () => void;
}

export function DpAuthProgress({
  onCancel,
}: DpAuthProgressProps): React.JSX.Element {
  useKeypress(
    (key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        onCancel();
      }
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.AccentBlue}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Box>
        <Text>
          <Spinner type="dots" />{' '}
          {t(
            'DP Authentication: A browser window will open for you to authenticate.',
          )}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.AccentPurple}>
          {t('(Press ESC or CTRL+C to cancel)')}
        </Text>
      </Box>
    </Box>
  );
}
