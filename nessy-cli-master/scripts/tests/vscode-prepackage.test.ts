/**
 * @license
 * Copyright 2026 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const prepackagePath = path.resolve(
  'packages/vscode-ide-companion/scripts/prepackage.js',
);

describe('VS Code prepackage', () => {
  it('builds CLI bundle dependencies in dependency order', () => {
    const source = readFileSync(prepackagePath, 'utf8');
    const dependencies = [
      'packages/core',
      'packages/web-templates',
      'packages/channels/base',
      'packages/channels/telegram',
      'packages/channels/weixin',
      'packages/channels/dingtalk',
      'packages/channels/feishu',
      'packages/channels/qqbot',
      'packages/acp-bridge',
      'packages/webui',
      'packages/sdk-typescript',
      'packages/web-shell',
    ];

    let previousIndex = -1;
    for (const dependency of dependencies) {
      const dependencyIndex = source.indexOf(`'${dependency}'`);
      expect(dependencyIndex).toBeGreaterThan(previousIndex);
      previousIndex = dependencyIndex;
    }

    expect(source.indexOf("'bundle'")).toBeGreaterThan(previousIndex);
  });
});
