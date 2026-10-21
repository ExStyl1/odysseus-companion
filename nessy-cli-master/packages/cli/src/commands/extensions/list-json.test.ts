import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extensionToJsonEntry, handleListJson } from './list-json.js';

const mockGetLoadedExtensions = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockIsEnabled = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    getLoadedExtensions: mockGetLoadedExtensions,
    isEnabled: mockIsEnabled,
  }),
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

const buildExtension = (overrides: Record<string, unknown> = {}) => ({
  id: 'autodoc-extensions',
  name: 'autodoc-extensions',
  version: '3.0.0',
  isActive: true,
  path: '/Users/u/.nessy/extensions/autodoc-extensions',
  config: {
    name: 'autodoc-extensions',
    version: '3.0.0',
    mcpServers: {
      'srv-1': { command: 'dp', args: ['autodoc'], trust: true },
    },
  },
  installMetadata: {
    source: '@ai-office/nessy-extension-autodoc',
    type: 'npm',
    releaseTag: '3.0.0-nessy.2',
  },
  contextFiles: [],
  commands: [],
  skills: [{ name: 'autodoc-migrator' }, { name: 'autodoc-setup' }],
  mcpServers: { 'srv-1': { command: 'dp', args: ['autodoc'] } },
  ...overrides,
});

describe('extensionToJsonEntry', () => {
  it('maps Extension to JSON entry shape', () => {
    const isEnabled = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const manager = { isEnabled };

    const result = extensionToJsonEntry(
      buildExtension() as never,
      manager as never,
      '/workspace',
    );

    expect(result.name).toBe('autodoc-extensions');
    expect(result.version).toBe('3.0.0');
    expect(result.path).toBe('/Users/u/.nessy/extensions/autodoc-extensions');
    expect(result.source).toBe('@ai-office/nessy-extension-autodoc');
    expect(result.type).toBe('npm');
    expect(result.releaseTag).toBe('3.0.0-nessy.2');
    expect(result.skills).toEqual(['autodoc-migrator', 'autodoc-setup']);
    expect(result.mcpServers).toEqual({
      'srv-1': { command: 'dp', args: ['autodoc'] },
    });
    expect(result.enabledUser).toBe(true);
    expect(result.enabledWorkspace).toBe(false);
    expect(isEnabled).toHaveBeenNthCalledWith(
      1,
      'autodoc-extensions',
      os.homedir(),
    );
    expect(isEnabled).toHaveBeenNthCalledWith(
      2,
      'autodoc-extensions',
      '/workspace',
    );
  });

  it('uses the normalized extension version', () => {
    const manager = { isEnabled: () => false };
    const result = extensionToJsonEntry(
      buildExtension({
        version: '3.0.0-normalized',
        config: { name: 'autodoc-extensions' },
      }) as never,
      manager as never,
      '/w',
    );

    expect(result.version).toBe('3.0.0-normalized');
  });

  it('defaults skills to empty array and mcpServers to empty object', () => {
    const manager = { isEnabled: () => false };
    const result = extensionToJsonEntry(
      buildExtension({
        skills: undefined,
        mcpServers: undefined,
        config: { name: 'x', version: '1' },
      }) as never,
      manager as never,
      '/w',
    );

    expect(result.skills).toEqual([]);
    expect(result.mcpServers).toEqual({});
  });

  it('omits source/type/releaseTag when installMetadata is missing', () => {
    const manager = { isEnabled: () => false };
    const result = extensionToJsonEntry(
      buildExtension({ installMetadata: undefined }) as never,
      manager as never,
      '/w',
    );

    expect(result.source).toBeUndefined();
    expect(result.type).toBeUndefined();
    expect(result.releaseTag).toBeUndefined();
  });
});

describe('handleListJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
  });

  it('emits JSON array when extensions are present', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([buildExtension()]);

    await handleListJson();

    expect(mockWriteStdoutLine).toHaveBeenCalledTimes(1);
    const written = mockWriteStdoutLine.mock.calls[0][0] as string;
    const parsed = JSON.parse(written) as Array<{ name: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('autodoc-extensions');
  });

  it('emits empty array when no extensions are installed', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([]);

    await handleListJson();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith('[]');
  });

  it('writes error to stderr and exits on failure', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    mockGetLoadedExtensions.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await handleListJson();

    expect(mockWriteStderrLine).toHaveBeenCalledWith('boom');
    expect(processExitSpy).toHaveBeenCalledWith(1);
    processExitSpy.mockRestore();
  });
});
