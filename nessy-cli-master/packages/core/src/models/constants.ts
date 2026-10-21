/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_NESSY_MODEL, MAINLINE_CODER_MODEL } from '../config/models.js';

import type { ModelConfig } from './types.js';

type AuthType = import('../core/contentGenerator.js').AuthType;
type ContentGeneratorConfig =
  import('../core/contentGenerator.js').ContentGeneratorConfig;

/**
 * Field keys for model-scoped generation config.
 *
 * Kept in a small standalone module to avoid circular deps. The `import('...')`
 * usage is type-only and does not emit runtime imports.
 */
export const MODEL_GENERATION_CONFIG_FIELDS = [
  // [nessy-fork] dp-auth-anthropic-generator
  'protocol',
  'samplingParams',
  'timeout',
  'maxRetries',
  'retryErrorCodes',
  'enableCacheControl',
  'schemaCompliance',
  'reasoning',
  'contextWindowSize',
  'customHeaders',
  'extra_body',
  'modalities',
  'splitToolMedia',
  'toolResultContentFormat',
] as const satisfies ReadonlyArray<keyof ContentGeneratorConfig>;

/**
 * Credential-related fields that are part of ContentGeneratorConfig
 * but not ModelGenerationConfig.
 */
export const CREDENTIAL_FIELDS = [
  'model',
  'apiKey',
  'apiKeyEnvKey',
  'baseUrl',
] as const satisfies ReadonlyArray<keyof ContentGeneratorConfig>;

/**
 * All provider-sourced fields that need to be tracked for source attribution
 * and cleared when switching from provider to manual credentials.
 */
export const PROVIDER_SOURCED_FIELDS = [
  ...CREDENTIAL_FIELDS,
  ...MODEL_GENERATION_CONFIG_FIELDS,
] as const;

/**
 * Environment variable mappings per authType.
 */
export interface AuthEnvMapping {
  apiKey: string[];
  baseUrl: string[];
  model: string[];
}

export const AUTH_ENV_MAPPINGS = {
  openai: {
    apiKey: ['OPENAI_API_KEY'],
    baseUrl: ['OPENAI_BASE_URL'],
    model: ['OPENAI_MODEL', 'NESSY_MODEL'],
  },
  anthropic: {
    apiKey: ['ANTHROPIC_API_KEY'],
    baseUrl: ['ANTHROPIC_BASE_URL'],
    model: ['ANTHROPIC_MODEL'],
  },
  gemini: {
    apiKey: ['GEMINI_API_KEY'],
    baseUrl: [],
    model: ['GEMINI_MODEL'],
  },
  'vertex-ai': {
    apiKey: ['GOOGLE_API_KEY'],
    baseUrl: [],
    model: ['GOOGLE_MODEL'],
  },
  'dp-auth': {
    apiKey: [],
    baseUrl: [],
    model: [],
  },
} as const satisfies Record<AuthType, AuthEnvMapping>;

export const DEFAULT_MODELS = {
  openai: MAINLINE_CODER_MODEL,
  'dp-auth': DEFAULT_NESSY_MODEL,
} as Partial<Record<AuthType, string>>;

/**
 * Prefix for internal (trusted) models.
 * Models whose id starts with this prefix are considered internal.
 */
export const INTERNAL_MODEL_PREFIX = 'tgpt/';

/**
 * Hard-coded DP Auth models that are always available.
 * These cannot be overridden by user configuration.
 *
 * Note: Models are loaded dynamically from the server during refreshAuth().
 * This list is intentionally empty — the DP Auth models come from the API.
 */
export const DP_AUTH_MODELS: ModelConfig[] = [];

/**
 * Derive allowed models from DP_AUTH_MODELS for authorization.
 * This ensures single source of truth (SSOT).
 *
 * Note: DEFAULT_NESSY_MODEL is always allowed as a fallback,
 * even before the DP models cache is loaded from the server.
 */
export const DP_AUTH_ALLOWED_MODELS = [
  DEFAULT_NESSY_MODEL,
  ...DP_AUTH_MODELS.map((model) => model.id),
] as readonly string[];
