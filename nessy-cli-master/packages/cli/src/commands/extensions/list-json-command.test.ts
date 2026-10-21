import { describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { listCommand } from './list.js';

const mockHandleListJson = vi.hoisted(() => vi.fn());
const mockGetExtensionManager = vi.hoisted(() => vi.fn());

vi.mock('./list-json.js', () => ({
  handleListJson: mockHandleListJson,
}));

vi.mock('./utils.js', () => ({
  getExtensionManager: mockGetExtensionManager,
  extensionToOutputString: vi.fn(),
}));

describe('extensions list --json command', () => {
  it('routes to the JSON handler', async () => {
    const parser = yargs([]).command(listCommand).fail(false).locale('en');

    await parser.parseAsync('list --json');

    expect(mockHandleListJson).toHaveBeenCalledTimes(1);
    expect(mockGetExtensionManager).not.toHaveBeenCalled();
  });
});
