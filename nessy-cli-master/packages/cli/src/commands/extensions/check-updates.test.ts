import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtensionUpdateState } from '../../ui/state/extensions.js';
import { handleCheckUpdates } from './check-updates.js';

const mockGetLoadedExtensions = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockCheckForExtensionUpdate = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    getLoadedExtensions: mockGetLoadedExtensions,
  }),
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

vi.mock('@nestor/nessy-cli-core', () => ({
  checkForExtensionUpdate: mockCheckForExtensionUpdate,
}));

vi.mock('../../i18n/index.js', () => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
}));

const buildExtension = (overrides: Record<string, unknown> = {}) => ({
  name: 'autodoc-extensions',
  version: '3.0.0',
  path: '/Users/u/.nessy/extensions/autodoc-extensions',
  installMetadata: {
    source: '@ai-office/nessy-extension-autodoc',
    type: 'npm',
  },
  ...overrides,
});

describe('handleCheckUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits JSON with an updateState per extension', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([
      buildExtension(),
      buildExtension({ name: 'other' }),
    ]);
    mockCheckForExtensionUpdate
      .mockResolvedValueOnce(ExtensionUpdateState.UPDATE_AVAILABLE)
      .mockResolvedValueOnce(ExtensionUpdateState.UP_TO_DATE);

    await handleCheckUpdates({ json: true });

    const written = mockWriteStdoutLine.mock.calls[0][0] as string;
    const parsed = JSON.parse(written) as Array<{
      name: string;
      updateState: string;
    }>;
    expect(parsed).toEqual([
      { name: 'autodoc-extensions', updateState: 'update available' },
      { name: 'other', updateState: 'up to date' },
    ]);
  });

  it('reports NOT_UPDATABLE when install metadata is missing', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([
      buildExtension({ installMetadata: undefined }),
    ]);

    await handleCheckUpdates({ json: true });

    const parsed = JSON.parse(
      mockWriteStdoutLine.mock.calls[0][0] as string,
    ) as Array<{ updateState: string }>;
    expect(parsed[0].updateState).toBe('not updatable');
    expect(mockCheckForExtensionUpdate).not.toHaveBeenCalled();
  });

  it('reports ERROR when a single check throws, without aborting the batch', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([
      buildExtension(),
      buildExtension({ name: 'other' }),
    ]);
    mockCheckForExtensionUpdate
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(ExtensionUpdateState.UP_TO_DATE);

    await handleCheckUpdates({ json: true });

    const parsed = JSON.parse(
      mockWriteStdoutLine.mock.calls[0][0] as string,
    ) as Array<{ name: string; updateState: string }>;
    expect(parsed).toEqual([
      { name: 'autodoc-extensions', updateState: 'error' },
      { name: 'other', updateState: 'up to date' },
    ]);
  });

  it('checks only the named extension', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([
      buildExtension(),
      buildExtension({ name: 'other' }),
    ]);
    mockCheckForExtensionUpdate.mockResolvedValueOnce(
      ExtensionUpdateState.UPDATE_AVAILABLE,
    );

    await handleCheckUpdates({ name: 'other', json: true });

    expect(mockCheckForExtensionUpdate).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(
      mockWriteStdoutLine.mock.calls[0][0] as string,
    ) as Array<{ name: string }>;
    expect(parsed).toEqual([
      { name: 'other', updateState: 'update available' },
    ]);
  });

  it('errors and exits when the named extension is not installed', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    mockGetLoadedExtensions.mockReturnValueOnce([buildExtension()]);

    await handleCheckUpdates({ name: 'missing', json: true });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
    processExitSpy.mockRestore();
  });
});
