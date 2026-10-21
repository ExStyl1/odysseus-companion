/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptContentBlock } from '@nestor/nessy-cli-sdk/daemon';
import type { DaemonPromptImage } from './types.js';

export function toDaemonPromptContent(
  text: string,
  images: readonly DaemonPromptImage[] = [],
): PromptContentBlock[] {
  const prompt: PromptContentBlock[] = [{ type: 'text', text }];

  for (const image of images) {
    const mimeType = image.mimeType ?? image.mediaType ?? image.media_type;
    // Omit 'image/*' (unknown type) to preserve legacy behavior where
    // untyped images are sent without mimeType to the daemon.
    if (mimeType && mimeType !== 'image/*') {
      prompt.push({
        type: 'image',
        data: image.data,
        mimeType,
      });
    } else {
      prompt.push({
        type: 'image',
        data: image.data,
      });
    }
  }

  return prompt;
}
