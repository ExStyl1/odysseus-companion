// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { WelcomeHeader } from './WelcomeHeader';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function renderWelcomeHeader(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WelcomeHeader
          version="0.0.0"
          cwd="/repo"
          currentModel="nessy-coder"
          currentMode="default"
          hideTips
        />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

describe('WelcomeHeader', () => {
  it('renders the Nessy ASCII logo instead of the old QWEN logo', () => {
    const container = renderWelcomeHeader();
    const logo = container.querySelector('pre');

    expect(logo?.textContent).toContain('███╗   ██╗ ███████╗');
    expect(logo?.textContent).not.toContain('▄▄▄▄▄▄  ▄▄');
  });
});
