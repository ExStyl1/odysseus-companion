import { describe, expect, it } from 'bun:test';
import {
  createDesktopTool,
  type DesktopAction,
} from '../desktop-tool.ts';

describe('desktop_tool', () => {
  it('forwards interface actions to the active desktop session', async () => {
    const actions: DesktopAction[] = [];
    const tool = createDesktopTool({
      getDesktopActionFn: () => async action => {
        actions.push(action);
      },
    });

    await tool.handler({ action: 'open_file', path: 'README.md' });
    await tool.handler({ action: 'open_url', url: 'https://example.com' });
    await tool.handler({ action: 'show_workspace' });

    expect(actions).toEqual([
      { action: 'open_file', path: 'README.md' },
      { action: 'open_url', url: 'https://example.com' },
      { action: 'show_workspace' },
    ]);
  });

  it('requires the action-specific argument', async () => {
    const tool = createDesktopTool({
      getDesktopActionFn: () => async () => {},
    });

    const fileResult = await tool.handler({ action: 'open_file' });
    const urlResult = await tool.handler({ action: 'open_url' });

    expect(fileResult.isError).toBe(true);
    expect(fileResult.content[0]).toEqual({
      type: 'text',
      text: 'Error: path is required for open_file',
    });
    expect(urlResult.isError).toBe(true);
    expect(urlResult.content[0]).toEqual({
      type: 'text',
      text: 'Error: url is required for open_url',
    });
  });
});
