import { describe, expect, it } from 'bun:test';
import type { PluginInstallSource } from '../../plugins/types.ts';
import {
  MarketplaceProposalError,
  MarketplaceProposalRegistry,
} from '../proposal-registry.ts';

function repoSource(overrides: Partial<Extract<PluginInstallSource, { kind: 'repository' }>> = {}): PluginInstallSource {
  return {
    kind: 'repository',
    repositoryUrl: 'https://github.com/Green-PT/honey-for-devs',
    ref: 'main',
    ...overrides,
  };
}

describe('MarketplaceProposalRegistry', () => {
  it('issues a safe installable proposal with an opaque id and no server-only source fields', () => {
    let id = 0;
    const registry = new MarketplaceProposalRegistry({ now: () => 1_000, ttlMs: 60_000, newId: () => `p-${++id}` });
    const proposal = registry.issue({
      clientId: 'client-1',
      source: repoSource(),
      displaySource: 'github.com/Green-PT/honey-for-devs',
      detectedFormat: 'codex-plugin',
      diagnosticCodes: ['marketplace.repository.detected'],
    });

    expect(proposal.status).toBe('installable');
    expect(proposal.proposalId).toBe('p-1');
    expect(proposal.displaySource).toBe('github.com/Green-PT/honey-for-devs');
    expect(proposal.detectedFormat).toBe('codex-plugin');
    expect(proposal.expiresAt).toBe(61_000);
    expect(proposal.diagnosticCodes).toEqual(['marketplace.repository.detected']);
    // The serialized DTO must not carry the raw install source, url, ref, command or hash.
    expect(JSON.stringify(proposal)).not.toContain('repositoryUrl');
    expect(JSON.stringify(proposal)).not.toContain('kind');
    expect(Object.keys(proposal)).not.toContain('source');
  });

  it('consumes a proposal exactly once, returning the pinned server-only source', () => {
    const registry = new MarketplaceProposalRegistry({ now: () => 0, ttlMs: 10, newId: () => 'p-x' });
    const source = repoSource();
    const proposal = registry.issue({ clientId: 'c', source, displaySource: 'd', detectedFormat: 'unknown' });

    const resolved = registry.consume('c', proposal.proposalId);
    expect(resolved.source).toEqual(source);
  });

  it('rejects an unknown proposal id', () => {
    const registry = new MarketplaceProposalRegistry();
    expect(() => registry.consume('c', 'nope')).toThrow(MarketplaceProposalError);
    try {
      registry.consume('c', 'nope');
    } catch (error) {
      expect((error as MarketplaceProposalError).code).toBe('not-found');
    }
  });

  it('rejects a proposal consumed by a different client (wrong-client)', () => {
    const registry = new MarketplaceProposalRegistry({ newId: () => 'p-1' });
    const proposal = registry.issue({ clientId: 'owner', source: repoSource(), displaySource: 'd', detectedFormat: 'unknown' });
    try {
      registry.consume('attacker', proposal.proposalId);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MarketplaceProposalError);
      expect((error as MarketplaceProposalError).code).toBe('wrong-client');
    }
    // The legitimate client can still consume it afterwards.
    expect(registry.consume('owner', proposal.proposalId).source).toEqual(repoSource());
  });

  it('rejects a reused (already consumed) proposal', () => {
    const registry = new MarketplaceProposalRegistry({ now: () => 0, ttlMs: 1_000, newId: () => 'p-1' });
    const proposal = registry.issue({ clientId: 'c', source: repoSource(), displaySource: 'd', detectedFormat: 'unknown' });
    registry.consume('c', proposal.proposalId);
    try {
      registry.consume('c', proposal.proposalId);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as MarketplaceProposalError).code).toBe('reused');
    }
  });

  it('rejects an expired proposal', () => {
    let clock = 0;
    const registry = new MarketplaceProposalRegistry({ now: () => clock, ttlMs: 100, newId: () => 'p-1' });
    const proposal = registry.issue({ clientId: 'c', source: repoSource(), displaySource: 'd', detectedFormat: 'unknown' });
    clock = 101;
    try {
      registry.consume('c', proposal.proposalId);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as MarketplaceProposalError).code).toBe('expired');
    }
  });

  it('rejects a content-changed proposal when an expected pin no longer matches', () => {
    const registry = new MarketplaceProposalRegistry({ now: () => 0, ttlMs: 1_000, newId: () => 'p-1' });
    const proposal = registry.issue({ clientId: 'c', source: repoSource(), displaySource: 'd', detectedFormat: 'unknown' });
    try {
      registry.consume('c', proposal.proposalId, { expectedContentHash: 'stale-hash' });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as MarketplaceProposalError).code).toBe('content-changed');
    }
    // The correct pinned hash still consumes.
    const hash = registry.contentHashFor(proposal.proposalId);
    expect(hash).toBeTruthy();
    expect(registry.consume('c', proposal.proposalId, { expectedContentHash: hash }).source).toEqual(repoSource());
  });

  it('pins content per proposal so two urls get distinct ids and hashes', () => {
    let id = 0;
    const registry = new MarketplaceProposalRegistry({ newId: () => `p-${++id}` });
    const a = registry.issue({ clientId: 'c', source: repoSource({ ref: 'main' }), displaySource: 'a', detectedFormat: 'unknown' });
    const b = registry.issue({ clientId: 'c', source: repoSource({ ref: 'dev' }), displaySource: 'b', detectedFormat: 'unknown' });
    expect(a.proposalId).not.toBe(b.proposalId);
    expect(registry.contentHashFor(a.proposalId)).not.toBe(registry.contentHashFor(b.proposalId));
  });
});

describe('catalog install hints survive the plan → install round trip (D1)', () => {
  it('carries connectorAuthTiming and catalogAuthenticationPolicy through consume', () => {
    const registry = new MarketplaceProposalRegistry({ now: () => 0, ttlMs: 1_000, newId: () => 'p-hints' });
    const proposal = registry.issue({
      clientId: 'c',
      source: repoSource(),
      displaySource: 'd',
      detectedFormat: 'unknown',
      connectorAuthTiming: 'ON_INSTALL',
      catalogAuthenticationPolicy: 'tenant-managed',
    });

    const consumed = registry.consume('c', proposal.proposalId);
    expect(consumed.connectorAuthTiming).toBe('ON_INSTALL');
    expect(consumed.catalogAuthenticationPolicy).toBe('tenant-managed');
    // The proposal DTO stays free of them — it is the client-visible half.
    expect(JSON.stringify(proposal)).not.toContain('tenant-managed');
  });

  it('omits both when the catalog item carried neither', () => {
    const registry = new MarketplaceProposalRegistry({ now: () => 0, ttlMs: 1_000, newId: () => 'p-plain' });
    const proposal = registry.issue({ clientId: 'c', source: repoSource(), displaySource: 'd', detectedFormat: 'unknown' });

    const consumed = registry.consume('c', proposal.proposalId);
    expect(consumed).toEqual({ source: repoSource() });
  });
})
