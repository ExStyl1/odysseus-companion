/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import { defaultModalities } from '../core/modalityDefaults.js';
import { tokenLimit } from '../core/tokenLimits.js';
import {
  DEFAULT_NESTOR_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
} from '../core/openaiContentGenerator/constants.js';
import {
  type ModelConfig,
  type ModelProvidersConfig,
  type ResolvedModelConfig,
  type AvailableModel,
} from './types.js';
import { DP_AUTH_MODELS } from './constants.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isInternalModel } from '../utils/configResolver.js';

const debugLogger = createDebugLogger('MODEL_REGISTRY');

export { DP_AUTH_MODELS } from './constants.js';

/**
 * Validates if a string key is a valid AuthType enum value.
 * @param key - The key to validate
 * @returns The validated AuthType or undefined if invalid
 */
function validateAuthTypeKey(key: string): AuthType | undefined {
  // Check if the key is a valid AuthType enum value
  if (Object.values(AuthType).includes(key as AuthType)) {
    return key as AuthType;
  }

  // Invalid key
  return undefined;
}

function shouldUseCanonicalModalities(modelId: string): boolean {
  return /^minimax-m3/i.test(modelId.trim().toLowerCase());
}

/**
 * Build a composite registry key from model id and optional baseUrl.
 * Two models with the same id but different baseUrls are distinct entries.
 * When baseUrl is omitted/empty the key is just the id (backward compatible).
 */
export function modelRegistryKey(id: string, baseUrl?: string): string {
  return baseUrl ? `${id}\0${baseUrl}` : id;
}

/**
 * Central registry for managing model configurations.
 * Models are organized by authType.
 */
export class ModelRegistry {
  private modelsByAuthType: Map<AuthType, Map<string, ResolvedModelConfig>>;

  private getDefaultBaseUrl(authType: AuthType): string {
    switch (authType) {
      case AuthType.DP_AUTH:
        return DEFAULT_NESTOR_BASE_URL;
      case AuthType.USE_OPENAI:
        return DEFAULT_OPENAI_BASE_URL;
      default:
        return '';
    }
  }

  constructor(modelProvidersConfig?: ModelProvidersConfig) {
    this.modelsByAuthType = new Map();

    // Always register dp-auth models (hard-coded, cannot be overridden)
    this.registerAuthTypeModels(AuthType.DP_AUTH, DP_AUTH_MODELS);

    // Register user-configured models for other authTypes
    if (modelProvidersConfig) {
      for (const [rawKey, models] of Object.entries(modelProvidersConfig)) {
        const authType = validateAuthTypeKey(rawKey);

        if (!authType) {
          debugLogger.warn(
            `Invalid authType key "${rawKey}" in modelProviders config. Expected one of: ${Object.values(AuthType).join(', ')}. Skipping.`,
          );
          continue;
        }

        // Skip dp-auth as it uses hard-coded models
        if (authType === AuthType.DP_AUTH) {
          continue;
        }

        this.registerAuthTypeModels(authType, models);
      }
    }
  }

  /**
   * Register models for an authType.
   * Uniqueness is determined by the composite key (id + baseUrl).
   * Two models with the same id but different baseUrls are treated as distinct.
   * If multiple models share both id and baseUrl, the first one takes precedence.
   */
  private registerAuthTypeModels(
    authType: AuthType,
    models: ModelConfig[],
  ): void {
    // Defensive: runtime data from settings.json can violate the static type —
    // e.g. a hand-edited file, or one still in the reverted #5089 V5 shape
    // ({ protocol, models }) that the CLI v5->v4 migration has not yet
    // rewritten. Skip such entries with a clear warning instead of throwing an
    // opaque "models is not iterable" from the loop below.
    if (!Array.isArray(models)) {
      debugLogger.warn(
        `modelProviders for authType "${authType}" is not an array; skipping. ` +
          `Expected ModelConfig[]; legacy { protocol, models } entries are ` +
          `normally rewritten by the v5->v4 settings migration.`,
      );
      return;
    }

    const modelMap = new Map<string, ResolvedModelConfig>();

    for (const config of models) {
      // Resolve the model first to get the final baseUrl
      const resolved = this.resolveModelConfig(config, authType);

      // Use the resolved baseUrl for the key, not the original config.baseUrl
      const key = modelRegistryKey(resolved.id, resolved.baseUrl);
      if (modelMap.has(key)) {
        debugLogger.warn(
          `Duplicate model id "${resolved.id}"${resolved.baseUrl ? ` with baseUrl "${resolved.baseUrl}"` : ''} for authType "${authType}". Using the first registered config.`,
        );
        continue;
      }
      modelMap.set(key, resolved);
    }

    this.modelsByAuthType.set(authType, modelMap);
  }

  /** Replace the runtime DP_AUTH catalog with the latest server response. */
  updateDpAuthModels(models: ModelConfig[]): void {
    // [nessy-fork] dp-auth-runtime-model-catalog
    this.registerAuthTypeModels(AuthType.DP_AUTH, models);
    debugLogger.info(`Updated DP_AUTH registry with ${models.length} models`);
  }

  /**
   * Get all models for a specific authType.
   * This is used by /model command to show only relevant models.
   */
  getModelsForAuthType(authType: AuthType): AvailableModel[] {
    const models = this.modelsByAuthType.get(authType);
    if (!models) return [];

    return Array.from(models.values()).map((model) => ({
      id: model.id,
      label: model.name,
      description: model.description,
      capabilities: model.capabilities,
      authType: model.authType,
      isVision: model.capabilities?.vision ?? false,
      contextWindowSize:
        model.generationConfig.contextWindowSize ?? tokenLimit(model.id),
      // `modalities` is auto-filled in `resolveModelConfig`, so it is
      // always defined on `ResolvedModelConfig` — no fallback needed here.
      modalities: model.generationConfig.modalities,
      baseUrl: model.baseUrl,
      envKey: model.envKey,
      internal: model.internal,
      sync: model.sync,
      alias: model.alias,
      // [nessy-fork] dp-auth-coder-model-default
      default: model.default,
      fastOnly: model.fastOnly,
      voiceOnly: model.voiceOnly,
      // [nessy-fork] model-alias-visual
      visualOnly: model.visualOnly,
    }));
  }

  /**
   * Get model configuration by authType and modelId.
   * When baseUrl is provided, looks up by the exact composite key (id+baseUrl).
   * When baseUrl is omitted, tries the plain id first (backward compatible),
   * then scans all entries for the first match by model id.
   */
  getModel(
    authType: AuthType,
    modelId: string,
    baseUrl?: string,
  ): ResolvedModelConfig | undefined {
    const models = this.modelsByAuthType.get(authType);
    if (!models) return undefined;

    if (baseUrl) {
      return models.get(modelRegistryKey(modelId, baseUrl));
    }

    // Try plain id key first (models registered without explicit baseUrl)
    const plain = models.get(modelId);
    if (plain) return plain;

    // Scan for the first entry with matching model id
    for (const model of models.values()) {
      if (model.id === modelId) return model;
    }

    // Try alias lookup
    const byAlias = this.getModelByAlias(authType, modelId);
    if (byAlias) return byAlias;

    return undefined;
  }

  /**
   * Get model by alias (e.g., "fast", "coder").
   * Returns the first model with matching alias.
   */
  private getModelByAlias(
    authType: AuthType,
    alias: string,
  ): ResolvedModelConfig | undefined {
    const models = this.modelsByAuthType.get(authType);
    if (!models) return undefined;

    const normalizedAlias = alias.toLowerCase();
    for (const model of models.values()) {
      if (model.alias?.toLowerCase() === normalizedAlias) {
        return model;
      }
    }
    return undefined;
  }

  /**
   * Check if model exists for given authType.
   * When baseUrl is provided, checks the exact composite key.
   * When baseUrl is omitted, checks plain id and scans by model id.
   */
  hasModel(authType: AuthType, modelId: string, baseUrl?: string): boolean {
    return this.getModel(authType, modelId, baseUrl) !== undefined;
  }

  /**
   * Get default model for an authType.
   *
   * For dp-auth, returns ONLY the model with alias="coder".
   * No fallback to other models — fast models and other non-coder models
   * are explicitly excluded from being selected as the default to prevent
   * them from being used as the primary model during auth errors or fallback.
   *
   * For other auth types, returns the first configured model that is not
   * a fast-only model (alias="fast" or fastOnly=true).
   *
   * [nessy-fork] dp-auth-coder-model-default
   */
  getDefaultModelForAuthType(
    authType: AuthType,
  ): ResolvedModelConfig | undefined {
    const models = this.modelsByAuthType.get(authType);
    if (!models || models.size === 0) return undefined;

    // For DP_AUTH, return ONLY models with alias="coder"
    // No fallback to other models — this prevents fast models from being
    // selected as the default during auth errors
    if (authType === AuthType.DP_AUTH) {
      for (const model of models.values()) {
        if (model.alias?.toLowerCase() === 'coder') {
          return model;
        }
      }
      // No coder model available — return undefined to trigger fallback logic
      return undefined;
    }

    // For all other auth types, find the first model that is not a fast-only model
    // Models with alias="fast" or fastOnly=true should not be used as defaults
    for (const model of models.values()) {
      if (model.alias?.toLowerCase() !== 'fast' && !model.fastOnly) {
        return model;
      }
    }

    // If all models are fast-only, return undefined to trigger fallback logic
    return undefined;
  }

  /**
   * Resolve model config by applying defaults
   */
  private resolveModelConfig(
    config: ModelConfig,
    authType: AuthType,
  ): ResolvedModelConfig {
    this.validateModelConfig(config, authType);

    const generationConfig = { ...(config.generationConfig ?? {}) };
    // Auto-fill modalities from the model name when the provider didn't set
    // them explicitly. Without this, downstream consumers that read straight
    // from the registry (e.g. sub-agents via getResolvedModel) would inherit
    // the parent session's modalities instead of the agent's own.
    if (
      generationConfig.modalities === undefined ||
      shouldUseCanonicalModalities(config.id)
    ) {
      generationConfig.modalities = defaultModalities(config.id);
    }

    return {
      ...config,
      authType,
      name: config.name || config.id,
      baseUrl: config.baseUrl || this.getDefaultBaseUrl(authType),
      generationConfig,
      capabilities: config.capabilities || {},
      internal: isInternalModel(config.id),
      sync: config.sync,
      alias: config.alias,
    };
  }

  /**
   * Validate model configuration
   */
  private validateModelConfig(config: ModelConfig, authType: AuthType): void {
    if (!config.id) {
      throw new Error(
        `Model config in authType '${authType}' missing required field: id`,
      );
    }
    // [nessy-fork] model-alias-fast
    // [nessy-fork] model-alias-visual
    const modeOnlyFlags = [
      config.fastOnly,
      config.voiceOnly,
      config.visualOnly,
    ].filter(Boolean);
    if (modeOnlyFlags.length > 1) {
      debugLogger.warn(
        `Model "${config.id}" in authType "${authType}" has multiple only flags set. It may be unreachable in model selectors.`,
      );
    }
  }

  /**
   * Reload models from updated configuration.
   * Clears existing user-configured models and re-registers from new config.
   * Preserves the runtime dp-auth catalog.
   */
  reloadModels(modelProvidersConfig?: ModelProvidersConfig): void {
    // Clear existing user-configured models (preserve dp-auth)
    for (const authType of this.modelsByAuthType.keys()) {
      if (authType !== AuthType.DP_AUTH) {
        this.modelsByAuthType.delete(authType);
      }
    }

    // Re-register user-configured models for other authTypes
    if (modelProvidersConfig) {
      for (const [rawKey, models] of Object.entries(modelProvidersConfig)) {
        const authType = validateAuthTypeKey(rawKey);

        if (!authType) {
          debugLogger.warn(
            `Invalid authType key "${rawKey}" in modelProviders config. Expected one of: ${Object.values(AuthType).join(', ')}. Skipping.`,
          );
          continue;
        }

        // DP Auth is controlled by the runtime server catalog.
        if (authType === AuthType.DP_AUTH) {
          continue;
        }

        this.registerAuthTypeModels(authType, models);
      }
    }
  }
}
