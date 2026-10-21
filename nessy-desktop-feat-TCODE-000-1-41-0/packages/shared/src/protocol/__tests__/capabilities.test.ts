import { describe, expect, it } from 'bun:test';
import {
  isSafeCapabilityContextRef,
  isSafeGrantTrustRequest,
  isSafeMarketplaceListRequest,
  isSafeMarketplacePluginInstallRequest,
  isSafeMarketplacePluginProposalRequest,
  isSafePluginManagementActionRequest,
  isSafeRevokeTrustRequest,
} from '../capabilities.ts';

describe('protocol/capabilities validators', () => {
  it('accepts workspace-only, session and handle context refs', () => {
    expect(isSafeCapabilityContextRef({ workspaceId: 'ws-1' })).toBe(true);
    expect(isSafeCapabilityContextRef({ workspaceId: 'ws-1', sessionId: 's-1' })).toBe(true);
    expect(isSafeCapabilityContextRef({ workspaceId: 'ws-1', projectHandleId: 'h-1' })).toBe(true);
  });

  it('rejects a raw projectRoot / workspaceRoot smuggled through the ingress', () => {
    expect(isSafeCapabilityContextRef({ workspaceId: 'ws-1', projectRoot: '/home/x' })).toBe(false);
    expect(isSafeCapabilityContextRef({ workspaceId: 'ws-1', workspaceRoot: '/x' })).toBe(false);
    expect(isSafeCapabilityContextRef({ workspaceId: 'ws-1', sessionId: 's', projectHandleId: 'h' })).toBe(false);
    expect(isSafeCapabilityContextRef({})).toBe(false);
  });

  it('accepts ID/ref-based plugin management actions only', () => {
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'uninstall' })).toBe(true);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'enable', target: { kind: 'global' } })).toBe(true);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'enable', target: { kind: 'project', context: { workspaceId: 'ws', sessionId: 's' } } })).toBe(true);
    // enable without a target is invalid.
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'enable' })).toBe(false);
    // a raw projectRoot on the target is rejected.
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'enable', target: { kind: 'project', context: { workspaceId: 'ws', projectRoot: '/x' } } })).toBe(false);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'uninstall', executableHash: 'hash' })).toBe(false);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'enable', target: { kind: 'global', projectRoot: '/x' } })).toBe(false);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'configuration-status', workspaceId: 'ws' })).toBe(true);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'clear-configuration', workspaceId: 'ws' })).toBe(true);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'configure', workspaceId: 'ws', values: { token: 'secret', count: 2, enabled: false } })).toBe(true);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'configure', workspaceId: 'ws', values: { token: { value: 'secret' } } })).toBe(false);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'configure', workspaceId: 'ws', values: { token: '' } })).toBe(false);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'configure', workspaceId: 'ws', values: { constructor: 'pollute' } })).toBe(false);
  });

  it('accepts set-capability-enabled with a target, id and boolean only', () => {
    const base = { pluginKey: 'pk', action: 'set-capability-enabled', target: { kind: 'global' } };
    expect(isSafePluginManagementActionRequest({ ...base, capabilityId: 'mcp-one', enabled: false })).toBe(true);
    expect(isSafePluginManagementActionRequest({ ...base, capabilityId: 'mcp-one', enabled: true })).toBe(true);
    // Missing/empty id, non-boolean enabled, missing target, extra keys — all rejected.
    expect(isSafePluginManagementActionRequest({ ...base, enabled: true })).toBe(false);
    expect(isSafePluginManagementActionRequest({ ...base, capabilityId: '', enabled: true })).toBe(false);
    expect(isSafePluginManagementActionRequest({ ...base, capabilityId: 'mcp-one', enabled: 'yes' })).toBe(false);
    expect(isSafePluginManagementActionRequest({ pluginKey: 'pk', action: 'set-capability-enabled', capabilityId: 'mcp-one', enabled: true })).toBe(false);
    expect(isSafePluginManagementActionRequest({ ...base, capabilityId: 'mcp-one', enabled: true, projectRoot: '/x' })).toBe(false);
  });

  it('accepts filter-only marketplace list requests and rejects legacy context/raw fields', () => {
    expect(isSafeMarketplaceListRequest({ kind: 'skills', page: 1, pageSize: 100, sort: 'name' })).toBe(true);
    expect(isSafeMarketplaceListRequest({ kind: 'plugins', capabilities: ['mcp'] })).toBe(true);
    expect(isSafeMarketplaceListRequest({ kind: 'skills', workspaceRoot: '/x' })).toBe(false);
    expect(isSafeMarketplaceListRequest({ kind: 'skills', projectRoot: '/x' })).toBe(false);
    expect(isSafeMarketplaceListRequest({ kind: 'skills', workspaceId: 'ws-1' })).toBe(false);
    expect(isSafeMarketplaceListRequest({ kind: 'skills', raw: {} })).toBe(false);
    expect(isSafeMarketplaceListRequest({ kind: 'skills', pageSize: 101 })).toBe(false);
  });

  it('accepts install by listing or opaque proposalId, rejects raw sources', () => {
    expect(isSafeMarketplacePluginInstallRequest({ source: { kind: 'listing', marketplaceId: 'm', listingId: 'l', listingKind: 'plugins' } })).toBe(true);
    expect(isSafeMarketplacePluginInstallRequest({ source: { kind: 'proposal', proposalId: 'op-1' } })).toBe(true);
    expect(isSafeMarketplacePluginInstallRequest({ source: { kind: 'listing', marketplaceId: 'm', listingId: 'l' } })).toBe(false);
    expect(isSafeMarketplacePluginInstallRequest({ source: { kind: 'repository', repositoryUrl: 'https://x' } })).toBe(false);
    expect(isSafeMarketplacePluginInstallRequest({ proposal: { status: 'installable' } })).toBe(false);
    expect(isSafeMarketplacePluginInstallRequest({ source: { kind: 'proposal', proposalId: 'op-1', command: 'run me' } })).toBe(false);
    expect(isSafeMarketplacePluginInstallRequest({ source: { kind: 'proposal', proposalId: 'op-1' }, projectRoot: '/x' })).toBe(false);
  });

  it('rejects proposal URLs carrying embedded credentials', () => {
    expect(isSafeMarketplacePluginProposalRequest({ sourceUrl: 'https://github.com/a/b' })).toBe(true);
    expect(isSafeMarketplacePluginProposalRequest({ sourceUrl: 'https://user:pass@github.com/a/b' })).toBe(false);
    expect(isSafeMarketplacePluginProposalRequest({ sourceUrl: 'not a url' })).toBe(false);
    expect(isSafeMarketplacePluginProposalRequest({ sourceUrl: 'https://github.com/a/b', source: { kind: 'repository' } })).toBe(false);
  });

  it('accepts a path-free grant-trust request keyed by capabilityKey + context only', () => {
    expect(isSafeGrantTrustRequest({ capabilityKey: 'cap-1', context: { workspaceId: 'ws-1' } })).toBe(true);
    expect(isSafeGrantTrustRequest({
      capabilityKey: 'cap-1',
      context: { workspaceId: 'ws-1', sessionId: 's-1' },
    })).toBe(true);
    // The client never supplies the executable hash, instance id or scope directly.
    expect(isSafeGrantTrustRequest({
      capabilityKey: 'cap-1',
      context: { workspaceId: 'ws-1' },
      executableHash: 'deadbeef',
    })).toBe(false);
    expect(isSafeGrantTrustRequest({
      capabilityKey: 'cap-1',
      context: { workspaceId: 'ws-1' },
      pluginInstanceId: 'plugin://m/p@1.0.0#hash',
    })).toBe(false);
    expect(isSafeGrantTrustRequest({ capabilityKey: 'cap-1' })).toBe(false);
    expect(isSafeGrantTrustRequest({ context: { workspaceId: 'ws-1' } })).toBe(false);
    // A raw project root smuggled through the context is rejected.
    expect(isSafeGrantTrustRequest({
      capabilityKey: 'cap-1',
      context: { workspaceId: 'ws-1', projectRoot: '/evil' },
    })).toBe(false);
  });

  it('accepts a path-free revoke-trust request keyed by capabilityKey + context only', () => {
    expect(isSafeRevokeTrustRequest({ capabilityKey: 'cap-1', context: { workspaceId: 'ws-1' } })).toBe(true);
    expect(isSafeRevokeTrustRequest({
      capabilityKey: 'cap-1',
      context: { workspaceId: 'ws-1' },
      executableHash: 'deadbeef',
    })).toBe(false);
    expect(isSafeRevokeTrustRequest({ capabilityKey: 'cap-1' })).toBe(false);
  });
});
