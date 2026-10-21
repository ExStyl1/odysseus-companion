/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../../config/config.js';
import {
  captureDlhCorrelation,
  createDlhContext,
  getDlhOptionalPromptId,
  getDlhParentPromptId,
  getDlhParentToolCallId,
  getDlhSessionId,
  runInDlhContext,
  runWithDlhCorrelation,
} from './dlh-context.js';

describe('DLH correlation context', () => {
  const config = {
    getSessionId: () => 'config-session',
  } as unknown as Config;

  it('captures explicit ids over ambient context and config fallbacks', () => {
    const context = createDlhContext('ambient-session', 0, null, config);
    context.promptId = 'ambient-prompt';
    context.parentPromptId = 'ambient-parent';
    context.parentToolCallId = 'ambient-tool-call';

    const captured = runInDlhContext(context, () =>
      captureDlhCorrelation({
        sessionId: 'explicit-session',
        promptId: 'explicit-prompt',
        parentPromptId: 'explicit-parent',
        parentToolCallId: 'explicit-tool-call',
      }),
    );

    expect(captured).toMatchObject({
      sessionId: 'explicit-session',
      promptId: 'explicit-prompt',
      parentPromptId: 'explicit-parent',
      parentToolCallId: 'explicit-tool-call',
      config,
    });
  });

  it('restores captured ids around delayed work', async () => {
    const captured = captureDlhCorrelation({
      config,
      promptId: 'queued-prompt',
      parentPromptId: 'parent-prompt',
      parentToolCallId: 'parent-tool-call',
    });

    await runWithDlhCorrelation(captured, async () => {
      await Promise.resolve();
      expect(getDlhSessionId()).toBe('config-session');
      expect(getDlhOptionalPromptId()).toBe('queued-prompt');
      expect(getDlhParentPromptId()).toBe('parent-prompt');
      expect(getDlhParentToolCallId()).toBe('parent-tool-call');
    });
  });
});
