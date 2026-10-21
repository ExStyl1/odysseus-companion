/**
 * DP Models API client.
 * Fetches available models from ${NESTOR_SERVER_URL}/api/v2/cli/models.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { DpAuthError, DpAuthServiceError } from './dp-errors.js';
import {
  DEFAULT_NESTOR_BASE_URL,
  DEFAULT_NESTOR_ANTHROPIC_BASE_URL,
  DEFAULT_NESTOR_MODEL_URL,
} from '../core/openaiContentGenerator/constants.js';
import type {
  ContentGeneratorConfig,
  InputModalities,
} from '../core/contentGenerator.js';
import type { ModelConfig } from '../models/types.js';
import type { Config } from '../config/config.js';
import { getValidCredentials } from './dp-token-manager.js';
import { buildNestorAuthHeaders } from './nestor-auth-header.js';

const logger = createDebugLogger('DP:Models');

const DEFAULT_TIMEOUT = 30_000;
// [nessy-fork] model-alias-visual
const TEMP_VISUAL_MODEL_ID = 'tgpt/qwen35-397b-a17b-fp8-vl';

/**
 * Raw model info from the backend API (httpserver.CLIModelInfo)
 */
interface BackendModelInfo {
  protocol?: ContentGeneratorConfig['protocol'];
  // [nessy-fork] dp-byok-model-picker
  id?: string;
  /** Legacy technical ID, used when id is absent. */
  name?: string;
  display_name?: string;
  access_source?: string;
  /** Model description */
  desc?: string;
  /** Indicates if the model is internal */
  is_internal?: boolean;
  /** Model alias for semantic selection (e.g., "fast", "coder") */
  alias?: string;
  // [nessy-fork] dp-auth-coder-model-default
  /** Indicates if the model is the server default */
  default?: boolean;
  /** Supported input modalities (e.g., { image: true }) */
  modalities?: InputModalities;
  /** Context window size in tokens */
  context_window_size?: number;
  /** Sampling parameters for generation */
  sampling_params?: {
    temperature?: number;
    top_k?: number;
    top_p?: number;
    max_tokens?: number;
    repetition_penalty?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
  };
  /** Reasoning configuration for reasoning models (e.g., DeepSeek) */
  reasoning?: {
    effort?: 'low' | 'medium' | 'high' | 'max';
    budget_tokens?: number;
  };
  /** Extra body parameters to pass through verbatim */
  extra_body?: Record<string, unknown>;
}

/**
 * Response from the models API endpoint
 * Can be either an array of models or an object with models property
 */
export type ModelsApiResponse =
  | BackendModelInfo[]
  | { models: BackendModelInfo[] };

/**
 * Fetch available models from the DP models API.
 *
 * @param jwt - JWT token for authentication
 * @param serverUrl - Optional custom server URL (defaults to NESTOR_SERVER_URL)
 * @returns Array of model configurations
 * @throws {DpAuthServiceError} If the request fails
 */
export async function fetchModels(
  jwt: string,
  serverUrl?: string,
  config?: Config,
): Promise<ModelConfig[]> {
  const url = serverUrl || DEFAULT_NESTOR_MODEL_URL;
  const version = config?.getCliVersion() || 'unknown';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  logger.info('Fetching models from:', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `NessyCLI/${version} (${process.platform}; ${process.arch})`,
        ...buildNestorAuthHeaders(jwt),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        // ignore
      }
      logger.error(
        `Models fetch failed: ${response.status} ${response.statusText}`,
        body,
      );

      throw new Error(`Models endpoint returned HTTP ${response.status}`);
    }

    const data: unknown = await response.json();

    // [nessy-fork] dp-byok-model-picker
    const modelsArray = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && 'models' in data
        ? data.models
        : undefined;
    if (!Array.isArray(modelsArray)) {
      throw new Error('Invalid models response');
    }

    logger.info(`Raw API response:`, modelsArray);
    logger.info(`Fetched ${modelsArray.length} models from API`);

    // Convert backend API response to ModelConfig format
    // Backend format: { name, desc, is_internal, alias?, modalities?, context_window_size?, sampling_params?, reasoning?, extra_body? }
    // Convert alias string to array for ModelConfig compatibility
    // If alias is 'fast' or 'visual', hide the model from the main selector
    // and reserve it for the matching selector.
    const convertedModels = modelsArray.map((model) => {
      if (!model || typeof model !== 'object') {
        throw new Error('Invalid model entry');
      }
      const backendModel = model as BackendModelInfo;
      const id = backendModel.id ?? backendModel.name;
      const displayName = backendModel.display_name ?? backendModel.name ?? id;
      if (
        typeof id !== 'string' ||
        !id.trim() ||
        typeof displayName !== 'string' ||
        !displayName.trim()
      ) {
        throw new Error('Model ID and display name must be non-empty strings');
      }
      const name =
        backendModel.access_source === 'byok' &&
        !/\(byok\)$/i.test(displayName.trimEnd())
          ? `${displayName} (byok)`
          : displayName;
      const alias =
        backendModel.alias ??
        (id === TEMP_VISUAL_MODEL_ID ? 'visual' : undefined);

      // [nessy-fork] model-alias-fast
      // [nessy-fork] model-alias-visual
      // Set mode-only flags for backend aliases reserved for scoped selectors.
      // Set default baseUrl and envKey for all models
      // [nessy-fork] dp-models-backend-generation-config
      // Build generationConfig from backend fields
      const generationConfig: ModelConfig['generationConfig'] = {
        // [nessy-fork] dp-auth-anthropic-generator
        protocol: backendModel.protocol ?? 'openai_chat_completions',
      };

      if (backendModel.modalities) {
        generationConfig.modalities = backendModel.modalities;
      }
      if (backendModel.context_window_size) {
        generationConfig.contextWindowSize = backendModel.context_window_size;
      }
      if (backendModel.sampling_params) {
        generationConfig.samplingParams = {
          temperature: backendModel.sampling_params.temperature,
          top_k: backendModel.sampling_params.top_k,
          top_p: backendModel.sampling_params.top_p,
          max_tokens: backendModel.sampling_params.max_tokens,
          repetition_penalty: backendModel.sampling_params.repetition_penalty,
          presence_penalty: backendModel.sampling_params.presence_penalty,
          frequency_penalty: backendModel.sampling_params.frequency_penalty,
        };
      }
      if (backendModel.reasoning) {
        // Build the object with only the fields the backend actually sent —
        // otherwise a missing `budget_tokens` would create a `budget_tokens:
        // undefined` key that survives translateReasoningEffort (non-effort
        // keys are preserved) and shows up as a stray `reasoning: {}` in logs.
        generationConfig.reasoning = {
          ...(backendModel.reasoning.effort
            ? { effort: backendModel.reasoning.effort }
            : {}),
          ...(backendModel.reasoning.budget_tokens !== undefined
            ? { budget_tokens: backendModel.reasoning.budget_tokens }
            : {}),
        };
      }
      if (backendModel.extra_body) {
        generationConfig.extra_body = backendModel.extra_body;
      }

      return {
        id,
        name,
        description: backendModel.desc,
        internal: backendModel.is_internal,
        alias,
        default: backendModel.default,
        fastOnly: alias?.toLowerCase() === 'fast',
        visualOnly: alias?.toLowerCase() === 'visual',
        baseUrl:
          backendModel.protocol === 'anthropic_messages'
            ? DEFAULT_NESTOR_ANTHROPIC_BASE_URL
            : DEFAULT_NESTOR_BASE_URL,
        envKey: 'DP_AUTH_MODEL_KEY',
        generationConfig,
      };
    });
    logger.info(`Converted models:`, convertedModels);
    // [nessy-fork] dp-byok-error-handling
    if (config) {
      config.dpByokCatalogUnavailable =
        response.headers.get('X-Byok-Status') === 'unavailable';
    }
    return convertedModels;
  } catch (error) {
    if (error instanceof DpAuthServiceError) throw error;

    throw new DpAuthServiceError(DpAuthError.ModelsUnavailable, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load DP models from the server using cached credentials.
 * Returns models array or empty array if failed.
 *
 * @returns Array of model configurations, or empty array if credentials not found or request failed
 */
export async function loadDpModelsFromServer(
  config?: Config,
): Promise<ModelConfig[]> {
  const credentials = getValidCredentials();
  if (!credentials || !credentials.jwt) {
    logger.warn('No valid DP credentials for loading models');
    return [];
  }

  try {
    logger.info('Loading DP models from server...');
    const models = await fetchModels(credentials.jwt, undefined, config);
    logger.info(`Loaded ${models.length} DP models from server`);
    return models;
  } catch (error) {
    logger.error('Failed to load DP models:', error);
    return [];
  }
}

/**
 * @returns Array of model configurations, or empty array if failed
 */
export async function refreshDpModelsCache(): Promise<ModelConfig[]> {
  // [nessy-fork] dp-auth-runtime-model-catalog
  logger.warn('refreshDpModelsCache is deprecated — models are runtime-only');
  return [];
}
