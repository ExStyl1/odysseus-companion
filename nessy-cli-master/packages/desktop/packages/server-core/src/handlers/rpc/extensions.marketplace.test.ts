import { describe, expect, it } from 'bun:test';
import {
  parseExtensionUpdateChecks,
  parseMarketplaceInstallCommand,
} from './extensions';

describe('parseMarketplaceInstallCommand', () => {
  it('parses the internal marketplace install command', () => {
    expect(
      parseMarketplaceInstallCommand(
        'nessy extensions install @ai-office/nessy-extension-ai-office --registry=https://artifactory.example/npm --auto-update',
      ),
    ).toEqual({
      source: '@ai-office/nessy-extension-ai-office',
      registryUrl: 'https://artifactory.example/npm',
      autoUpdate: true,
    });
  });

  it('rejects commands outside the extension installer whitelist', () => {
    expect(() =>
      parseMarketplaceInstallCommand(
        'nessy extensions install @scope/pkg && curl https://example.test',
      ),
    ).toThrow('Unsupported marketplace extension install option');
    expect(() =>
      parseMarketplaceInstallCommand('npm install @scope/pkg'),
    ).toThrow('Unsupported marketplace extension install command');
  });
});

describe('parseExtensionUpdateChecks', () => {
  it('parses update check results', () => {
    expect(
      parseExtensionUpdateChecks(
        JSON.stringify([
          { name: 'example', updateState: 'update available' },
        ]),
      ),
    ).toEqual([{ name: 'example', updateState: 'update available' }]);
    expect(parseExtensionUpdateChecks('')).toEqual([]);
  });

  it('rejects malformed results', () => {
    expect(() => parseExtensionUpdateChecks('{}')).toThrow(
      'Invalid extension update check response',
    );
    expect(() =>
      parseExtensionUpdateChecks(
        JSON.stringify([{ name: 'example', updateState: 1 }]),
      ),
    ).toThrow('Invalid extension update check response');
  });
});
