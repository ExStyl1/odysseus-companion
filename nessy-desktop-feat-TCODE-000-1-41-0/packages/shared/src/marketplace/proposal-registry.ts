/**
 * Server-only opaque marketplace install-proposal registry (W8 Step 6).
 *
 * The renderer/remote caller never round-trips a raw `PluginInstallSource`,
 * repository URL, temp path or command. It sends an explicit URL to PROPOSE and
 * receives a `SafeMarketplacePluginInstallProposal` carrying only an opaque
 * `proposalId`, a normalized display source, a detected format and an expiry.
 * INSTALL then references that `proposalId`; this registry maps it back to the
 * pinned server-only source.
 *
 * Guarantees:
 * - content-pinned: each proposal is bound to one exact source + its content
 *   hash; a different url/ref/subdirectory issues a distinct id and hash;
 * - single-use: the second consume of the same id is rejected as `reused`;
 * - expiring: a proposal past its TTL is rejected as `expired`;
 * - client-bound: only the issuing client may consume it (`wrong-client`);
 * - tamper-evident: a caller may pass an `expectedContentHash`; a mismatch is
 *   rejected as `content-changed` before the source is ever returned.
 */

import { createHash } from 'node:crypto';
import type { PluginInstallSource } from '../plugins/types.ts';
import type { PluginConnectorAuthTiming } from '../plugins/types.ts';
import type {
  SafeMarketplacePluginDetectedFormat,
  SafeMarketplacePluginInstallProposal,
} from '../protocol/capabilities.ts';

export type MarketplaceProposalRejectionCode =
  | 'not-found'
  | 'wrong-client'
  | 'reused'
  | 'expired'
  | 'content-changed';

export class MarketplaceProposalError extends Error {
  override readonly name = 'MarketplaceProposalError';
  constructor(readonly code: MarketplaceProposalRejectionCode, message?: string) {
    super(message ?? code);
  }
}

export interface IssueProposalInput {
  /** Authenticated client/backend the proposal is bound to. */
  clientId: string;
  /** Server-only install source; never serialized into the returned DTO. */
  source: PluginInstallSource;
  /** Normalized host/repository label (no userinfo/query/secret). */
  displaySource: string;
  detectedFormat: SafeMarketplacePluginDetectedFormat;
  diagnosticCodes?: string[];
  /**
   * Catalog-derived install hints, carried so the agent path can hand
   * `MarketplaceService.install` the same two fields the UI path reads off the
   * catalog item. The proposal is the ONLY channel between plan and install, so
   * anything the install needs has to survive the round trip here.
   */
  connectorAuthTiming?: PluginConnectorAuthTiming;
  catalogAuthenticationPolicy?: string;
}

/** What a consumed proposal yields: the server-only source plus its catalog hints. */
export interface ConsumedProposal {
  source: PluginInstallSource;
  connectorAuthTiming?: PluginConnectorAuthTiming;
  catalogAuthenticationPolicy?: string;
}

export interface ConsumeProposalOptions {
  /** When provided, the pinned content hash must match or the consume fails. */
  expectedContentHash?: string;
}

export interface MarketplaceProposalRegistryOptions {
  now?: () => number;
  /** Proposal time-to-live (ms). */
  ttlMs?: number;
  newId?: () => string;
}

interface ProposalRecord {
  proposalId: string;
  clientId: string;
  source: PluginInstallSource;
  contentHash: string;
  expiresAt: number;
  consumed: boolean;
  connectorAuthTiming?: PluginConnectorAuthTiming;
  catalogAuthenticationPolicy?: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

let proposalCounter = 0;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function computeSourceContentHash(source: PluginInstallSource): string {
  return createHash('sha256').update(stableStringify(source)).digest('hex');
}

export class MarketplaceProposalRegistry {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly newId: () => string;
  private readonly proposals = new Map<string, ProposalRecord>();

  constructor(options: MarketplaceProposalRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.newId = options.newId ?? (() => `mkt-proposal-${Date.now()}-${(proposalCounter += 1)}`);
  }

  /** Register a pinned source and return the safe, opaque installable proposal. */
  issue(input: IssueProposalInput): Extract<SafeMarketplacePluginInstallProposal, { status: 'installable' }> {
    const proposalId = this.newId();
    const expiresAt = this.now() + this.ttlMs;
    this.proposals.set(proposalId, {
      proposalId,
      clientId: input.clientId,
      source: input.source,
      contentHash: computeSourceContentHash(input.source),
      expiresAt,
      consumed: false,
      ...(input.connectorAuthTiming ? { connectorAuthTiming: input.connectorAuthTiming } : {}),
      ...(input.catalogAuthenticationPolicy ? { catalogAuthenticationPolicy: input.catalogAuthenticationPolicy } : {}),
    });
    return {
      status: 'installable',
      proposalId,
      displaySource: input.displaySource,
      detectedFormat: input.detectedFormat,
      expiresAt,
      diagnosticCodes: input.diagnosticCodes ?? [],
    };
  }

  /**
   * Resolve a proposal id back to its pinned server-only source. Single-use:
   * marks the proposal consumed. Throws a typed `MarketplaceProposalError` on
   * any unknown/wrong-client/reused/expired/content-changed condition.
   */
  consume(clientId: string, proposalId: string, options: ConsumeProposalOptions = {}): ConsumedProposal {
    const record = this.proposals.get(proposalId);
    if (!record) throw new MarketplaceProposalError('not-found');
    if (record.clientId !== clientId) throw new MarketplaceProposalError('wrong-client');
    if (record.consumed) throw new MarketplaceProposalError('reused');
    if (record.expiresAt <= this.now()) {
      this.proposals.delete(proposalId);
      throw new MarketplaceProposalError('expired');
    }
    if (options.expectedContentHash !== undefined && options.expectedContentHash !== record.contentHash) {
      throw new MarketplaceProposalError('content-changed');
    }
    record.consumed = true;
    return {
      source: record.source,
      ...(record.connectorAuthTiming ? { connectorAuthTiming: record.connectorAuthTiming } : {}),
      ...(record.catalogAuthenticationPolicy ? { catalogAuthenticationPolicy: record.catalogAuthenticationPolicy } : {}),
    };
  }

  /** The pinned content hash for a proposal (server-side/testing use only). */
  contentHashFor(proposalId: string): string | undefined {
    return this.proposals.get(proposalId)?.contentHash;
  }
}
