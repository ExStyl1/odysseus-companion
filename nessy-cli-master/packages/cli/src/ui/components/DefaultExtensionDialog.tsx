/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import { useKeypress } from '../hooks/useKeypress.js';
import type { RadioSelectItem } from './shared/RadioButtonSelect.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';

interface DefaultExtensionDialogProps {
  onInstall: () => void;
  onSkip: () => void;
}

const DEFAULT_EXTENSION_NAME = '@nestor/nessy-cli-extensions';

type DialogChoice = 'install' | 'skip';

export const DefaultExtensionDialog = ({
  onInstall,
  onSkip,
}: DefaultExtensionDialogProps) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onSkip();
      }
    },
    { isActive: true },
  );

  const OPTIONS: Array<RadioSelectItem<DialogChoice>> = [
    {
      label: t('Yes'),
      value: 'install',
      key: 'Yes',
    },
    {
      label: t('No (esc)'),
      value: 'skip',
      key: 'No',
    },
  ];

  const handleSelect = (choice: DialogChoice) => {
    if (choice === 'install') {
      onInstall();
    } else {
      onSkip();
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      padding={1}
      width="100%"
      marginLeft={1}
    >
      <Box marginBottom={1} flexDirection="column">
        <Text>
          <Text color={theme.status.warning}>{'> '}</Text>
          {t('Would you like to install the default extension "{{name}}"?', {
            name: DEFAULT_EXTENSION_NAME,
          })}
        </Text>
        <Text color={theme.text.secondary}>
          {t(
            'If you select Yes, the extension will be downloaded and installed automatically.',
          )}
        </Text>
      </Box>
      <RadioButtonSelect items={OPTIONS} onSelect={handleSelect} />
    </Box>
  );
};
