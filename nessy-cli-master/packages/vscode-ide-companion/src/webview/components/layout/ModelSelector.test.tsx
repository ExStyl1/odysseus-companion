/**
 * @license
 * Copyright 2026 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelInfo } from '@agentclientprotocol/sdk';
import { ModelSelector } from './ModelSelector.js';

vi.mock('@nestor/nessy-cli-webui', () => ({
  PlanCompletedIcon: () => null,
}));

interface RenderHandle {
  container: HTMLDivElement;
  root: Root;
  onSelectModel: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
}

const handles: RenderHandle[] = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

function renderModelSelector(props: {
  models: ModelInfo[];
  currentModelId?: string | null;
  visible?: boolean;
}): RenderHandle {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSelectModel = vi.fn();
  const onClose = vi.fn();

  act(() => {
    root.render(
      <ModelSelector
        visible={props.visible ?? true}
        models={props.models}
        currentModelId={props.currentModelId ?? null}
        onSelectModel={onSelectModel}
        onClose={onClose}
      />,
    );
  });

  const handle: RenderHandle = { container, root, onSelectModel, onClose };
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) {
    const handle = handles.pop()!;
    act(() => {
      handle.root.unmount();
    });
    handle.container.remove();
  }
});

const runtimeOAuthModel: ModelInfo = {
  modelId: '$runtime|dp-auth|qwen3-coder-plus(dp-auth)',
  name: 'qwen3 Coder Plus (Runtime)',
};

const otherProviderModel: ModelInfo = {
  modelId: 'gpt-4(openai)',
  name: 'GPT-4',
  description: 'OpenAI flagship',
};

describe('ModelSelector', () => {
  it('keeps a runtime DP Auth snapshot selectable', () => {
    const { container, onSelectModel } = renderModelSelector({
      models: [runtimeOAuthModel],
    });
    const row = container.querySelector('[data-index="0"]') as HTMLElement;
    act(() => {
      row.click();
    });
    expect(onSelectModel).toHaveBeenCalledWith(runtimeOAuthModel.modelId);
  });
});
