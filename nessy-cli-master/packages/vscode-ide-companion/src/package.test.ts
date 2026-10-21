/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package.json command metadata', () => {
  function readManifest(): {
    contributes: {
      commands: Array<{ command: string; title: string }>;
      views: Record<string, Array<{ id: string; when?: string }>>;
      viewsContainers: {
        activitybar: Array<{ id: string; when?: string }>;
      };
    };
  } {
    return JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    );
  }

  it('describes focusChat as focusing the chat view', () => {
    const manifest = readManifest();

    const command = manifest.contributes.commands.find(
      (item) => item.command === 'nessy-cli.focusChat',
    );

    expect(command?.title).toBe('Nessy CLI: Focus Chat View');
  });

  it('keeps the Activity Bar chat entry visible without runtime context', () => {
    const manifest = readManifest();

    const sidebarContainer =
      manifest.contributes.viewsContainers.activitybar.find(
        (item) => item.id === 'nessy-cli-sidebar',
      );
    const sidebarView = manifest.contributes.views['nessy-cli-sidebar']?.find(
      (item) => item.id === 'nessy-cli.chatView.sidebar',
    );

    expect(sidebarContainer?.when).toBeUndefined();
    expect(sidebarView?.when).toBeUndefined();
  });
});
