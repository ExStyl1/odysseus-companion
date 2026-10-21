import type {
  AgentProvider,
  BackendConfig,
  BackendHostRuntimeContext,
  CoreBackendConfig,
  LlmAuthType,
  LlmProviderType,
} from '../types.ts';
import type { LlmConnection } from '../../../config/storage.ts';
import type { ModelFetchResult } from '../../../config/model-fetcher.ts';
import type { CredentialManager } from '../../../credentials/manager.ts';
import type { ResolvedBackendRuntimePaths } from './runtime-resolver.ts';
import type { UpstreamTarget } from '@nessy-agent/codex-responses-adapter/nestor-client';

export interface BackendRuntimePaths {
  copilotCli?: string;
  interceptor?: string;
  sessionServer?: string;
  node?: string;
  bridgeServer?: string;
  piServer?: string; ripgrep?: string; // F1.727 · `ripgrep`: the vendored rg every Pi-requested child start reaches (`piChildStartPath`)
  /** Absolute path to the bundled codex-app-server binary (addendum 7). */
  codexBinary?: string;
}

export interface BackendRuntimePayload extends Record<string, unknown> {
  paths?: BackendRuntimePaths;
  piAuthProvider?: string;
  /** Custom base URL from the LLM connection (e.g. Azure OpenAI endpoint). */
  baseUrl?: string;
  /**
   * Endpoint + auth mode for a runtime that speaks to its upstream through the
   * local `codex-responses-adapter` (`codex-runtime`, C1). Secret-free: the
   * connection credential is attached per session by the agent.
   */
  upstream?: UpstreamTarget;
  /** Custom endpoint protocol config (api type for routing). */
  customEndpoint?: { api: string; supportsImages?: boolean };
  /**
   * Models registered for a custom endpoint. Strings default to 128K context;
   * objects allow overrides.
   *
   * P6.367 — `supportsThinking` is the operator's declaration that the id
   * reasons, and it must travel HERE as well as in the two sibling copies of
   * this element type: the mappers that fill it whitelist fields by NAME, so a
   * field this type does not carry is dropped between the connection and the
   * subprocess without anything failing.
   */
  customModels?: Array<string | {
    id: string;
    contextWindow?: number;
    supportsImages?: boolean;
    supportsThinking?: boolean;
    /**
     * DA1.22 — the catalogue's published sampling parameters, on their way to
     * Pi's own `Model.samplingParams`. Here for the reason the field above is
     * here: the mappers whitelist by NAME, so a field this type does not carry
     * is dropped between the connection and the subprocess in silence.
     */
    samplingParams?: Record<string, unknown>;
  }>;
}

export interface BackendResolutionContext {
  connection: LlmConnection | null;
  provider: AgentProvider;
  authType?: LlmAuthType;
  resolvedModel: string;
  capabilities: {
    needsHttpPoolServer: boolean;
  };
}

export interface BackendProviderOptions {
  piAuthProvider?: string;
}

export interface BackendModelFetchCredentials {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthIdToken?: string;
}

export interface DriverHostRuntimeArgs {
  hostRuntime: BackendHostRuntimeContext;
  resolvedPaths: ResolvedBackendRuntimePaths;
}

export interface DriverBuildArgs {
  context: BackendResolutionContext;
  coreConfig: CoreBackendConfig;
  hostRuntime: BackendHostRuntimeContext;
  resolvedPaths: ResolvedBackendRuntimePaths;
  providerOptions?: BackendProviderOptions;
}

export interface DriverFetchModelsArgs extends DriverHostRuntimeArgs {
  connection: LlmConnection;
  credentials: BackendModelFetchCredentials;
  timeoutMs: number;
}

export interface StoredConnectionValidationResult {
  success: boolean;
  error?: string;
  shouldRefreshModels?: boolean;
}

export interface DriverValidateStoredConnectionArgs extends DriverHostRuntimeArgs {
  slug: string;
  connection: LlmConnection;
  credentialManager: CredentialManager;
}

export interface DriverTestConnectionArgs extends DriverHostRuntimeArgs {
  provider: AgentProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  connection?: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'>;
  timeoutMs: number;
}

export interface ProviderDriver {
  provider: AgentProvider;
  initializeHostRuntime?: (args: DriverHostRuntimeArgs) => void;
  fetchModels?: (args: DriverFetchModelsArgs) => Promise<ModelFetchResult>;
  validateStoredConnection?: (args: DriverValidateStoredConnectionArgs) => Promise<StoredConnectionValidationResult>;
  testConnection?: (args: DriverTestConnectionArgs) => Promise<{ success: boolean; error?: string } | null>;
  prepareRuntime?: (args: DriverBuildArgs) => void;
  buildRuntime: (args: DriverBuildArgs) => BackendRuntimePayload;
}

/**
 * Internal resolved config consumed by concrete backend implementations.
 */
export interface ResolvedBackendConfig extends BackendConfig {
  runtime?: BackendRuntimePayload;
}

export function getBackendRuntime(config: BackendConfig): BackendRuntimePayload {
  return (config.runtime ?? {}) as BackendRuntimePayload;
}

export function getDefaultProviderType(provider: AgentProvider): LlmProviderType {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'pi':
      return 'pi';
    case 'codex-runtime':
      return 'codex-runtime';
    case 'nestor-cloud-agent':
      return 'nestor-cloud-agent';
  }
}
