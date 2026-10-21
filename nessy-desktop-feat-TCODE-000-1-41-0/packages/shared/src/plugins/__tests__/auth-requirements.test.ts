import { describe, expect, it } from 'bun:test';
import { derivePluginMcpAuthRequirements } from '../auth-requirements.ts';
import type { NessyPluginManifest } from '../types.ts';

function manifest(overrides: Partial<NessyPluginManifest>): NessyPluginManifest {
  return {
    schemaVersion: 1,
    kind: 'plugin',
    id: 'auth-shapes',
    name: 'Auth shapes',
    version: '1.0.0',
    capabilities: [],
    ...overrides,
  };
}

describe('derivePluginMcpAuthRequirements', () => {
  it('classifies DP by its exact command prefix, not its server name', () => {
    expect(derivePluginMcpAuthRequirements(manifest({
      capabilities: [
        { id: 'z-gitlab', kind: 'mcp', mcp: { serverName: 'dpGitlab', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'gitlab'] } },
        { id: 'a-search', kind: 'mcp', mcp: { serverName: 'codeSearch', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'search'] } },
        { id: 'fake', kind: 'mcp', mcp: { serverName: 'dpFake', transport: 'stdio', command: 'bin/dpFake', args: ['ai', 'mcp', 'fake'] } },
      ],
    }))).toEqual([{
      kind: 'dp',
      capabilityIds: ['a-search', 'z-gitlab'],
      serverNames: ['codeSearch', 'dpGitlab'],
      sharedProvider: 'dp',
      timing: 'ON_FIRST_USE',
    }]);
  });

  it('classifies normalized remote, environment, and app-only requirements', () => {
    expect(derivePluginMcpAuthRequirements(manifest({
      capabilities: [
        { id: 'github', kind: 'mcp', mcp: { serverName: 'github', transport: 'http', requiredEnvironmentNames: ['GITHUB_TOKEN'], credentialEnvironment: { GH_TOKEN: 'token' } } },
        { id: 'local', kind: 'mcp', mcp: { serverName: 'local', transport: 'stdio', command: 'node' } },
      ],
      connectors: [
        { id: 'figma', auth: { type: 'oauth', timing: 'ON_FIRST_USE' }, mcpServers: [{ serverName: 'figma', transport: 'http', url: 'https://example.test/mcp', oauthResource: 'https://example.test' }] },
        { id: 'remote', auth: { type: 'bearer', timing: 'ON_INSTALL' }, mcpServers: [{ serverName: 'remote', transport: 'sse', url: 'https://example.test/sse' }] },
        { id: 'none', auth: { type: 'none' }, mcpServers: [{ serverName: 'time', transport: 'http', url: 'https://example.test/time' }] },
      ],
      apps: [
        { id: 'gmail', connectorId: 'gmail' },
        { id: 'figma-app', connectorId: 'figma' },
      ],
    }))).toEqual([
      { kind: 'oauth', connectorIds: ['figma'], serverNames: ['figma'], timing: 'ON_FIRST_USE' },
      { kind: 'bearer', connectorIds: ['remote'], serverNames: ['remote'], timing: 'ON_INSTALL' },
      { kind: 'environment', capabilityIds: ['github'], serverNames: ['github'], requiredNames: ['GH_TOKEN', 'GITHUB_TOKEN'] },
      { kind: 'unsupported-app', appIds: ['gmail'], connectorIds: ['gmail'] },
    ]);
  });

  it('reads a twinned capability timing off the connector the twin gate drops (B6)', () => {
    // figma's exact shape: an `mcp` capability plus the connector twin that a
    // catalog authentication policy stamped ON_INSTALL. `twinLessConnectors`
    // discards that connector, and the capability has no timing field of its
    // own, so hardcoding ON_FIRST_USE here silently downgraded every
    // catalog-policy connector. Second server is the control: no timing on its
    // twin, so it keeps the adapters' declared default.
    expect(derivePluginMcpAuthRequirements(manifest({
      capabilities: [
        { id: 'cap-figma', kind: 'mcp', mcp: { serverName: 'figma', transport: 'http', url: 'https://example.test/mcp', authType: 'oauth' } },
        { id: 'cap-notion', kind: 'mcp', mcp: { serverName: 'notion', transport: 'http', url: 'https://example.test/notion', authType: 'oauth' } },
      ],
      connectors: [
        { id: 'figma', auth: { type: 'oauth', timing: 'ON_INSTALL' }, mcpServers: [{ serverName: 'figma', transport: 'http', url: 'https://example.test/mcp' }] },
        { id: 'notion', auth: { type: 'oauth' }, mcpServers: [{ serverName: 'notion', transport: 'http', url: 'https://example.test/notion' }] },
      ],
    }))).toEqual([
      { kind: 'oauth', connectorIds: ['cap-notion'], serverNames: ['notion'], timing: 'ON_FIRST_USE' },
      { kind: 'oauth', connectorIds: ['cap-figma'], serverNames: ['figma'], timing: 'ON_INSTALL' },
    ]);
  });

  it('does not report an app connector with a declared stdio transport as unsupported', () => {
    expect(derivePluginMcpAuthRequirements(manifest({
      apps: [{ id: 'local-app', connectorId: 'local' }],
      connectors: [{
        id: 'local',
        mcpServers: [{ serverName: 'local', transport: 'stdio', command: 'node' }],
      }],
    }))).toEqual([]);
  });
});
