/**
 * Credential Manager
 *
 * Main interface for credential storage. Uses encrypted file storage
 * for cross-platform compatibility without OS keychain prompts.
 */

import type { CredentialBackend } from './backends/types.ts';
import type {
  CredentialId,
  CredentialType,
  StoredCredential,
  CredentialHealthStatus,
  CredentialHealthIssue,
  RuntimeCredentialBinding,
  ResolvedRuntimeCredential,
} from './types.ts';
import type { LlmAuthType, LlmProviderType } from '../config/llm-connections.ts';
import {
  SecureStorageBackend,
  createSecureStorageBackendV2,
} from './backends/secure-storage.ts';
import type { VerifiedStorageLayoutV2 } from '../workspaces/storage-readiness.ts';
import { debug } from '../utils/debug.ts';
// DA1.13 — the one exported spelling of "this card's credential is the shared dp
// JWT, not anything in this store". Statically imported rather than lazily: that
// module's only edge back here is `import type { CredentialManager }`, which is
// erased, and its other import (`@nessy-agent/codex-responses-adapter`) is a
// package `shared` already depends on — so there is no cycle to avoid.
import { isGatewayBackedConnection } from '../agent/backend/internal/drivers/upstream-target.ts';

/**
 * True only for "this is a credential store, keyed to another machine".
 *
 * Structural rather than `instanceof`: `CredentialStoreCorruptError` is defined
 * in the backend module, and importing it here for a type test would couple the
 * manager to a backend it otherwise reaches only through the interface.
 */
function isForeignIdentityStoreError(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { kind?: unknown }).kind === 'foreign-identity';
}

export class CredentialManager {
  private backends: CredentialBackend[] = [];
  private writeBackend: CredentialBackend | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(backend?: CredentialBackend) {
    if (backend) {
      this.backends = [backend];
      this.writeBackend = backend;
      this.initialized = true;
    }
  }

  /**
   * Explicitly initialize the credential manager.
   * This is optional - methods auto-initialize via ensureInitialized().
   * Use this for eager initialization at app startup if desired.
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Internal: ensure initialization has completed.
   * Called automatically by all public methods.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // Prevent race condition with concurrent initialization
    if (this.initPromise) {
      return this.initPromise;
    }

    // Clear promise on failure so initialization can be retried
    this.initPromise = this._doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
  }

  private ensureInitializedSync(): void {
    if (this.initialized) {
      return;
    }

    // SecureStorageBackend is always available and is currently the only
    // credential backend. This sync path exists for sync callers such as
    // saveSourceConfig(), where fire-and-forget cleanup can race immediate reloads.
    const backend = new SecureStorageBackend();
    this.backends = [backend];
    this.writeBackend = backend;
    this.initialized = true;
    this.initPromise = null;
    debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
    debug(`[CredentialManager] Using backend: ${backend.name}`);
  }

  private async _doInitialize(): Promise<void> {
    const potentialBackends: CredentialBackend[] = [
      new SecureStorageBackend(),
    ];
    const availableBackends: CredentialBackend[] = [];

    // Check which backends are available
    for (const backend of potentialBackends) {
      if (await backend.isAvailable()) {
        availableBackends.push(backend);
        debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
      }
    }

    // A synchronous caller may have initialized the singleton while the async
    // availability checks above were in flight. In that case, keep the sync state
    // instead of appending duplicate backends.
    if (this.initialized) return;

    // Sort by priority (highest first)
    availableBackends.sort((a, b) => b.priority - a.priority);
    this.backends = availableBackends;

    // Use the first available backend for writing
    this.writeBackend = this.backends[0] || null;

    if (this.writeBackend) {
      debug(`[CredentialManager] Using backend: ${this.writeBackend.name}`);
    } else {
      debug(`[CredentialManager] WARNING: No backend available.`);
    }

    this.initialized = true;
  }

  /** Get the name of the active write backend */
  getActiveBackendName(): string | null {
    return this.writeBackend?.name || null;
  }

  /** Pre-W10 compatibility: bind through the same existing backend that writes. */
  bind(id: CredentialId): RuntimeCredentialBinding {
    this.ensureInitializedSync();
    return (this.writeBackend as SecureStorageBackend).bind(id);
  }

  getRuntimeCredentialStatus(id: CredentialId): {
    state: 'ready' | 'missing' | 'expired';
    revision: number;
  } {
    this.ensureInitializedSync();
    return (this.writeBackend as SecureStorageBackend).getRuntimeCredentialStatus(id);
  }

  resolveRuntimeCredential(binding: RuntimeCredentialBinding): ResolvedRuntimeCredential {
    this.ensureInitializedSync();
    return (this.writeBackend as SecureStorageBackend).resolveRuntimeCredential(binding);
  }

  /**
   * Get a credential by ID, trying all backends.
   * Automatically initializes if needed.
   */
  async get(id: CredentialId): Promise<StoredCredential | null> {
    await this.ensureInitialized();

    for (const backend of this.backends) {
      try {
        const cred = await backend.get(id);
        if (cred) {
          debug(`[CredentialManager] Found ${id.type} in ${backend.name}`);
          return cred;
        }
      } catch (err) {
        // ONE failure propagates: a valid store this machine identity cannot
        // open. Everything else keeps today's silence.
        //
        // The swallow is why the packaged build showed empty connections
        // instead of a reason — "the store could not be opened" and "no
        // credential is stored" arrived at all nine typed accessors as the same
        // `null`. But un-swallowing everything trades one false answer for a
        // worse one: a brand-new user with no store yet would meet errors where
        // "you have not added a key" is the honest reply.
        //
        // Branching on the ERROR'S OWN discriminant, never on its message: that
        // text is user-facing and will be reworded, and a match on it is a
        // defect scheduled for the first copy change.
        if (isForeignIdentityStoreError(err)) throw err;
        debug(`[CredentialManager] Error reading from ${backend.name}:`, err);
      }
    }

    return null;
  }

  /**
   * Set a credential using the write backend.
   * Automatically initializes if needed.
   */
  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    await this.ensureInitialized();

    if (!this.writeBackend) {
      throw new Error('No writable credential backend available');
    }

    await this.writeBackend.set(id, credential);
    debug(`[CredentialManager] Saved ${id.type} to ${this.writeBackend.name}`);
  }

  /**
   * Delete a credential from all backends.
   * Automatically initializes if needed.
   */
  async delete(id: CredentialId): Promise<boolean> {
    await this.ensureInitialized();

    let deleted = false;
    const failures: unknown[] = [];
    for (const backend of this.backends) {
      try {
        if (await backend.delete(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
        failures.push(err);
      }
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'credential-delete-failed');

    return deleted;
  }

  deleteSync(id: CredentialId): boolean {
    this.ensureInitializedSync();

    let deleted = false;
    const failures: unknown[] = [];
    for (const backend of this.backends) {
      if (!backend.deleteSync) {
        debug(`[CredentialManager] Backend ${backend.name} does not support synchronous delete`);
        failures.push(new Error(`Credential backend ${backend.name} does not support synchronous delete`));
        continue;
      }

      try {
        if (backend.deleteSync(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
        failures.push(err);
      }
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'credential-delete-failed');

    return deleted;
  }

  /**
   * List credentials matching a filter.
   * Automatically initializes if needed.
   */
  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    await this.ensureInitialized();

    const seen = new Set<string>();
    const results: CredentialId[] = [];

    for (const backend of this.backends) {
      try {
        const ids = await backend.list(filter);
        for (const id of ids) {
          const key = JSON.stringify(id);
          if (!seen.has(key)) {
            seen.add(key);
            results.push(id);
          }
        }
      } catch (err) {
        debug(`[CredentialManager] Error listing from ${backend.name}:`, err);
      }
    }

    return results;
  }

  // ============================================================
  // Convenience Methods
  // ============================================================

  /** Get Anthropic API key */
  async getApiKey(): Promise<string | null> {
    const cred = await this.get({ type: 'anthropic_api_key' });
    return cred?.value || null;
  }

  /** Set Anthropic API key */
  async setApiKey(key: string): Promise<void> {
    await this.set({ type: 'anthropic_api_key' }, { value: key });
  }

  /** Get Claude OAuth token */
  async getClaudeOAuth(): Promise<string | null> {
    const cred = await this.get({ type: 'claude_oauth' });
    return cred?.value || null;
  }

  /** Set Claude OAuth token */
  async setClaudeOAuth(token: string): Promise<void> {
    await this.set({ type: 'claude_oauth' }, { value: token });
  }

  /** Get Claude OAuth credentials (with refresh token, expiry, and source) */
  async getClaudeOAuthCredentials(): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import), or undefined (unknown) */
    source?: 'native' | 'cli';
  } | null> {
    const cred = await this.get({ type: 'claude_oauth' });
    if (!cred) return null;

    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      source: cred.source as 'native' | 'cli' | undefined,
    };
  }

  /** Set Claude OAuth credentials (with refresh token, expiry, and source) */
  async setClaudeOAuthCredentials(credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import) */
    source?: 'native' | 'cli';
  }): Promise<void> {
    await this.set({ type: 'claude_oauth' }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      source: credentials.source,
    });
  }

  /** Get workspace MCP OAuth credentials */
  async getWorkspaceOAuth(workspaceId: string): Promise<{
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  } | null> {
    const cred = await this.get({ type: 'workspace_oauth', workspaceId });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      tokenType: cred.tokenType,
      clientId: cred.clientId,
    };
  }

  /** Set workspace MCP OAuth credentials */
  async setWorkspaceOAuth(workspaceId: string, credentials: {
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  }): Promise<void> {
    await this.set(
      { type: 'workspace_oauth', workspaceId },
      {
        value: credentials.accessToken,
        tokenType: credentials.tokenType,
        clientId: credentials.clientId,
      }
    );
  }

  async getRemoteServerToken(workspaceId: string): Promise<string | null> {
    await this.ensureInitialized();
    if (!this.writeBackend) throw new Error('No readable credential backend available');
    const credential = await this.writeBackend.get({ type: 'remote_server_token', workspaceId });
    return credential?.value ?? null;
  }

  async setRemoteServerToken(workspaceId: string, token: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.writeBackend) throw new Error('No writable credential backend available');
    await this.writeBackend.set({ type: 'remote_server_token', workspaceId }, { value: token });
  }

  async deleteRemoteServerToken(workspaceId: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.writeBackend) throw new Error('No writable credential backend available');
    return this.writeBackend.delete({ type: 'remote_server_token', workspaceId });
  }

  /** Delete all credentials for a workspace (source credentials) */
  async deleteWorkspaceCredentials(workspaceId: string): Promise<void> {
    const allCreds = await this.list({ workspaceId });
    for (const cred of allCreds) {
      await this.delete(cred);
    }
  }

  // Note: OpenAI API key methods removed - Codex uses native ChatGPT OAuth flow

  // ============================================================
  // Decision Layer Credentials (UB6.1)
  // ============================================================

  /**
   * UB6.1 — Get the API key stored for a decision provider (`decision_api_key::{provider}`).
   * @param provider - The decision provider id
   * @returns API key or null if not found
   */
  async getDecisionApiKey(provider: string): Promise<string | null> {
    const cred = await this.get({ type: 'decision_api_key', name: provider });
    return cred?.value || null;
  }

  /** UB6.1 — Store the API key for a decision provider. */
  async setDecisionApiKey(provider: string, apiKey: string): Promise<void> {
    await this.set({ type: 'decision_api_key', name: provider }, { value: apiKey });
  }

  /** UB6.1 — Delete the API key of a decision provider. */
  async deleteDecisionApiKey(provider: string): Promise<boolean> {
    return this.delete({ type: 'decision_api_key', name: provider });
  }

  // ============================================================
  // LLM Connection Credentials
  // ============================================================

  /**
   * Get API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns API key or null if not found
   */
  async getLlmApiKey(connectionSlug: string): Promise<string | null> {
    const cred = await this.get({ type: 'llm_api_key', connectionSlug });
    return cred?.value || null;
  }

  /**
   * Set API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param apiKey - The API key to store
   */
  async setLlmApiKey(connectionSlug: string, apiKey: string): Promise<void> {
    await this.set({ type: 'llm_api_key', connectionSlug }, { value: apiKey });
  }

  /**
   * Delete API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns true if deleted, false if not found
   */
  async deleteLlmApiKey(connectionSlug: string): Promise<boolean> {
    return this.delete({ type: 'llm_api_key', connectionSlug });
  }

  /**
   * Get OAuth token for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns OAuth credentials or null if not found
   */
  async getLlmOAuth(connectionSlug: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_oauth', connectionSlug });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      idToken: cred.idToken,
    };
  }

  /**
   * Set OAuth token for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - OAuth credentials to store
   */
  async setLlmOAuth(connectionSlug: string, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_oauth', connectionSlug }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      idToken: credentials.idToken,
    });
  }

  /**
   * Delete all credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   */
  async deleteLlmCredentials(connectionSlug: string): Promise<void> {
    await this.delete({ type: 'llm_api_key', connectionSlug });
    await this.delete({ type: 'llm_oauth', connectionSlug });
    await this.delete({ type: 'llm_iam', connectionSlug });
    await this.delete({ type: 'llm_service_account', connectionSlug });
  }

  // ============================================================
  // IAM Credentials (AWS Bedrock)
  // ============================================================

  /**
   * Get IAM credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns IAM credentials or null if not found
   */
  async getLlmIamCredentials(connectionSlug: string): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_iam', connectionSlug });
    if (!cred || !cred.awsAccessKeyId) return null;
    return {
      accessKeyId: cred.awsAccessKeyId,
      secretAccessKey: cred.value, // Secret key stored in value field
      region: cred.awsRegion,
      sessionToken: cred.awsSessionToken,
    };
  }

  /**
   * Set IAM credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - IAM credentials to store
   */
  async setLlmIamCredentials(connectionSlug: string, credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_iam', connectionSlug }, {
      value: credentials.secretAccessKey, // Primary secret in value field
      awsAccessKeyId: credentials.accessKeyId,
      awsRegion: credentials.region,
      awsSessionToken: credentials.sessionToken,
    });
  }

  // ============================================================
  // Service Account Credentials (GCP Vertex)
  // ============================================================

  /**
   * Get service account credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns Service account JSON and metadata or null if not found
   */
  async getLlmServiceAccount(connectionSlug: string): Promise<{
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_service_account', connectionSlug });
    if (!cred) return null;
    return {
      serviceAccountJson: cred.value, // Full JSON stored in value field
      projectId: cred.gcpProjectId,
      region: cred.gcpRegion,
      email: cred.serviceAccountEmail,
    };
  }

  /**
   * Set service account credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - Service account credentials to store
   */
  async setLlmServiceAccount(connectionSlug: string, credentials: {
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_service_account', connectionSlug }, {
      value: credentials.serviceAccountJson, // Full JSON in value field
      gcpProjectId: credentials.projectId,
      gcpRegion: credentials.region,
      serviceAccountEmail: credentials.email,
    });
  }

  // ============================================================
  // Unified Credential Checking
  // ============================================================

  /**
   * Check if an LLM connection has valid credentials — does it have what it
   * needs to authenticate? Routes by auth mechanism (`LlmAuthType`).
   *
   * DA1.13 — a one-click Nessy Gateway card answers YES without this store being
   * consulted at all: its credential of record is the shared dp JWT
   * (`isGatewayBackedConnection`), which no per-connection entry mirrors any
   * more. Callers that have the connection therefore pass `baseUrl` too; a
   * caller that passes only the slug and the auth type gets the old, store-only
   * answer, which is still right for every other card.
   *
   * There is exactly ONE three-argument caller left, and it is correct by a
   * different route rather than by luck: `packages/shared/src/auth/state.ts`
   * follows this call with `if (!apiKey && connection.baseUrl) hasCredentials =
   * true` — the keyless-provider (Ollama) arm — and a gateway card always has a
   * base URL, so it reaches the same verdict. Measured 2026-09-13; if that arm
   * is ever narrowed, this call needs the fourth argument.
   *
   * **The posture, stated rather than implied.** This answers "does this card
   * need a stored credential", NOT "is the user signed in to dp right now". It
   * is deliberately not wired to `getValidCreds()`: the one thing every reader
   * of this predicate does with a `false` is take the card away —
   * `LIST_WITH_STATUS` reports `isAuthenticated: false`, which DISABLES the row
   * in the model switcher (`ConnectionRow.tsx`), and `checkHealth` raises a
   * standing `no_default_credentials` banner. A signed-out user would then be
   * unable to select the connection whose selection is what triggers the
   * re-mint, which is the blocked turn Target scheme clause 2 exists to forbid.
   * Being signed out is surfaced where it can be acted on instead: the
   * full-screen dp card with its reason (DA1.4), the row menu's Reconnect item
   * and the credential-health banner.
   *
   * @param connectionSlug - The connection slug
   * @param authType - The auth type to check
   * @param providerType - Optional provider type for OAuth routing
   * @param baseUrl - Optional connection endpoint; what identifies a gateway card
   * @returns true if credentials exist and are valid
   */
  async hasLlmCredentials(
    connectionSlug: string,
    authType: LlmAuthType,
    providerType?: LlmProviderType,
    baseUrl?: string
  ): Promise<boolean> {
    if (isGatewayBackedConnection({ providerType, baseUrl })) return true;
    switch (authType) {
      // No credentials needed
      case 'none':
      case 'environment':
        return true;

      // API key variants - all use the same storage
      case 'api_key':
      case 'api_key_with_endpoint':
      case 'bearer_token':
        return this.hasLlmApiKeyCredential(connectionSlug);

      // OAuth - browser flow
      case 'oauth':
        return this.hasLlmOAuthCredential(connectionSlug, providerType);

      // AWS IAM credentials
      case 'iam_credentials':
        return this.hasLlmIamCredential(connectionSlug);

      // GCP service account
      case 'service_account_file':
        return this.hasLlmServiceAccountCredential(connectionSlug);

      default:
        // Exhaustive check - TypeScript will error if we miss a case
        const _exhaustive: never = authType;
        return false;
    }
  }

  /**
   * Check if connection has valid API key credential.
   * @internal
   */
  private async hasLlmApiKeyCredential(connectionSlug: string): Promise<boolean> {
    const apiKey = await this.getLlmApiKey(connectionSlug);
    return !!apiKey;
  }

  /**
   * Check if connection has valid OAuth credential.
   * @internal
   */
  private async hasLlmOAuthCredential(
    connectionSlug: string,
    providerType?: LlmProviderType
  ): Promise<boolean> {
    const oauth = await this.getLlmOAuth(connectionSlug);
    if (!oauth) return false;

    // Check if expired
    if (oauth.expiresAt && this.isExpired({ value: oauth.accessToken, expiresAt: oauth.expiresAt })) {
      return !!oauth.refreshToken; // Can refresh
    }
    return true;
  }

  /**
   * Check if connection has valid IAM credential.
   * @internal
   */
  private async hasLlmIamCredential(connectionSlug: string): Promise<boolean> {
    const cred = await this.getLlmIamCredentials(connectionSlug);
    return !!cred?.accessKeyId && !!cred?.secretAccessKey;
  }

  /**
   * Check if connection has valid service account credential.
   * @internal
   */
  private async hasLlmServiceAccountCredential(connectionSlug: string): Promise<boolean> {
    const cred = await this.getLlmServiceAccount(connectionSlug);
    return !!cred?.serviceAccountJson;
  }

  /**
   * Check if a credential is expired (with 5-minute buffer).
   *
   * If expiresAt is not set:
   * - OAuth tokens (have refreshToken): treated as expired to force refresh attempt
   * - API keys (no refreshToken): treated as never expiring
   *
   * This prevents OAuth tokens from being treated as valid forever when
   * the provider doesn't return expires_in in the token response.
   */
  isExpired(credential: StoredCredential): boolean {
    if (credential.expiresAt) {
      // Consider expired if within 5 minutes of expiry
      return Date.now() > credential.expiresAt - 5 * 60 * 1000;
    }

    // No expiresAt set - behavior depends on credential type
    if (credential.refreshToken) {
      // OAuth token without expiry - treat as expired to force refresh
      // This is safer than assuming it's valid forever
      debug('[CredentialManager] OAuth token missing expiresAt - treating as expired');
      return true;
    }

    // API key without expiry - these typically don't expire
    return false;
  }

  // ============================================================
  // Health Check
  // ============================================================

  /**
   * Check the health of the credential store.
   *
   * This validates:
   * 1. The credential file can be read and decrypted (if it exists)
   * 2. The default LLM connection has valid credentials
   *
   * Use this on app startup to detect issues before users hit cryptic errors.
   *
   * @returns Health status with any issues found
   */
  async checkHealth(): Promise<CredentialHealthStatus> {
    const issues: CredentialHealthIssue[] = [];

    try {
      await this.ensureInitialized();

      // 1. Try to list credentials - this triggers decryption
      // If file is corrupted or can't be decrypted, this will throw
      await this.list({});

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const lowerMsg = errorMsg.toLowerCase();

      // Detect decryption failures (usually means machine migration)
      if (lowerMsg.includes('decrypt') || lowerMsg.includes('cipher') || lowerMsg.includes('authentication tag')) {
        issues.push({
          type: 'decryption_failed',
          message: 'Credentials from another machine detected. Please re-authenticate.',
          error: errorMsg,
        });
      } else if (lowerMsg.includes('json') || lowerMsg.includes('parse') || lowerMsg.includes('unexpected')) {
        issues.push({
          type: 'file_corrupted',
          message: 'Credential file is corrupted. Please re-authenticate.',
          error: errorMsg,
        });
      } else {
        // Unknown error - treat as corruption
        issues.push({
          type: 'file_corrupted',
          message: 'Failed to read credentials. Please re-authenticate.',
          error: errorMsg,
        });
      }

      return { healthy: false, issues };
    }

    // 2. Check if default connection has credentials
    // Import lazily to avoid circular dependency
    try {
      const { getDefaultLlmConnection, getLlmConnection } = await import('../config/storage.ts');
      const defaultSlug = getDefaultLlmConnection();

      if (defaultSlug) {
        const connection = getLlmConnection(defaultSlug);
        if (connection && connection.authType !== 'none' && connection.authType !== 'environment') {
          const hasCredentials = await this.hasLlmCredentials(
            defaultSlug,
            connection.authType,
            connection.providerType,
            // DA1.13 — a gateway card keeps no stored credential, so without the
            // endpoint this check would raise a standing "re-authenticate"
            // banner on the default connection of every gateway install.
            connection.baseUrl
          );
          if (!hasCredentials) {
            issues.push({
              type: 'no_default_credentials',
              message: `No credentials found for default connection "${connection.name}".`,
            });
          }
        }
      }
    } catch (configError) {
      // Config not yet initialized - skip this check
      debug('[CredentialManager] Skipping default connection check - config not available');
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }
}

// Singleton instance
let manager: CredentialManager | null = null;
let managerVerificationId: string | null = null;

/** Initialize the process credential singleton from verified v2 storage only. */
export function initializeCredentialManagerV2(layout: VerifiedStorageLayoutV2): CredentialManager {
  if (managerVerificationId) {
    if (managerVerificationId !== layout.verificationId) {
      throw new Error('Credential manager is already bound to another verified storage layout');
    }
    return manager!;
  }

  const activeBackend = manager?.getActiveBackendName();
  if (activeBackend && activeBackend !== 'secure-storage-v2') {
    throw new Error('Credential manager was initialized before storage readiness');
  }

  manager = new CredentialManager(createSecureStorageBackendV2(layout));
  managerVerificationId = layout.verificationId;
  return manager;
}

export function getCredentialManager(): CredentialManager {
  if (!manager) {
    throw new Error('Credential manager requires verified storage layout v2 initialization');
  }
  return manager;
}
