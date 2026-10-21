/**
 * @license
 * Copyright 2025 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared utilities for building per-agent ContentGeneratorConfig.
 *
 * Used by both InProcessBackend (Arena agents) and SubagentManager (regular
 * subagents) to create dedicated ContentGenerators when an agent targets a
 * different model or provider than the parent process.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type { Config } from '../config/config.js';
import { isInternalModel } from '../utils/configResolver.js';
import {
  createContentGenerator,
  type AuthType,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { RuntimeContentGeneratorView } from '../agents/runtime/agent-context.js';
import {
  AUTH_ENV_MAPPINGS,
  MODEL_GENERATION_CONFIG_FIELDS,
} from './constants.js';
import type { ResolvedModelConfig } from './types.js';

const logger = createDebugLogger('DP:Models');

export interface AuthOverrides {
  authType: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Build a ContentGeneratorConfig for a per-agent ContentGenerator.
 * Inherits operational settings (timeout, retries, proxy, sampling, etc.)
 * from the parent's config and overlays the agent-specific auth fields.
 *
 * For cross-provider agents the parent's API key / base URL are invalid,
 * so we resolve credentials from the provider-specific environment
 * variables (e.g. ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL). This mirrors
 * what a PTY subprocess does during its own initialization.
 */
export function buildAgentContentGeneratorConfig(
  base: Config,
  modelId: string | undefined,
  authOverrides: AuthOverrides,
): ContentGeneratorConfig {
  const parentConfig = base.getContentGeneratorConfig();
  const sameProvider = authOverrides.authType === parentConfig.authType;
  const modelsConfig = base.getModelsConfig();
  const resolvedModel = modelId
    ? modelsConfig.getResolvedModel(authOverrides.authType as AuthType, modelId)
    : undefined;

  const nextConfig: ContentGeneratorConfig = {
    ...parentConfig,
    model: modelId ?? parentConfig.model,
    authType: authOverrides.authType as AuthType,
  };
  // [nessy-fork] external-model-mcp-whitelist
  // Internal-ness is derived from the model id prefix, not inherited from the
  // parent (which may be a different provider/auth path). Ensures a tgpt/
  // model keeps full MCP access even when the parent used openai auth.
  nextConfig.internal = isInternalModel(nextConfig.model);

  // When switching providers, clear generation config fields so parent
  // settings (samplingParams, reasoning, extra_body, etc.) don't leak.
  if (!sameProvider) {
    for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (nextConfig as any)[field] = undefined;
    }
  }

  if (resolvedModel) {
    applyResolvedModelConfig(
      nextConfig,
      resolvedModel,
      parentConfig,
      authOverrides,
    );
    return nextConfig;
  }

  nextConfig.apiKey = resolveCredentialField(
    authOverrides.apiKey,
    sameProvider ? parentConfig.apiKey : undefined,
    authOverrides.authType,
    'apiKey',
  );
  nextConfig.baseUrl =
    authOverrides.baseUrl ??
    resolveCredentialField(
      undefined,
      sameProvider ? parentConfig.baseUrl : undefined,
      authOverrides.authType,
      'baseUrl',
    );
  nextConfig.apiKeyEnvKey = sameProvider
    ? parentConfig.apiKeyEnvKey
    : undefined;

  return nextConfig;
}

/**
 * Compose `buildAgentContentGeneratorConfig` + `createContentGenerator` into
 * a single {@link RuntimeContentGeneratorView}. Both InProcessBackend and
 * SubagentManager need the same three-step recipe; this helper centralizes
 * it so the two paths can't drift.
 *
 * `contentGeneratorOwner` is the Config instance the new ContentGenerator
 * should bind to for cwd / workspace / telemetry purposes — typically the
 * per-agent override Config when one exists, or the parent Config otherwise.
 */
export async function createRuntimeContentGeneratorView(
  base: Config,
  contentGeneratorOwner: Config,
  modelId: string | undefined,
  authOverrides: AuthOverrides,
): Promise<RuntimeContentGeneratorView> {
  const contentGeneratorConfig = buildAgentContentGeneratorConfig(
    base,
    modelId,
    authOverrides,
  );
  const contentGenerator = await createContentGenerator(
    contentGeneratorConfig,
    contentGeneratorOwner,
  );
  return { contentGenerator, contentGeneratorConfig };
}

function applyResolvedModelConfig(
  targetConfig: ContentGeneratorConfig,
  resolvedModel: ResolvedModelConfig,
  parentConfig: ContentGeneratorConfig,
  authOverrides: AuthOverrides,
): void {
  const sameProvider = authOverrides.authType === parentConfig.authType;
  targetConfig.model = resolvedModel.id;
  targetConfig.authType = resolvedModel.authType;
  targetConfig.baseUrl =
    authOverrides.baseUrl ??
    resolvedModel.baseUrl ??
    (sameProvider ? parentConfig.baseUrl : undefined);

  if (resolvedModel.envKey) {
    targetConfig.apiKey =
      authOverrides.apiKey ??
      process.env[resolvedModel.envKey] ??
      (sameProvider ? parentConfig.apiKey : undefined);
    targetConfig.apiKeyEnvKey = resolvedModel.envKey;
  } else {
    targetConfig.apiKey = resolveCredentialField(
      authOverrides.apiKey,
      sameProvider ? parentConfig.apiKey : undefined,
      authOverrides.authType,
      'apiKey',
    );
    targetConfig.apiKeyEnvKey = sameProvider
      ? parentConfig.apiKeyEnvKey
      : undefined;
  }

  // Apply registry-defined generation config fields. Cross-provider
  // clearing is already handled by buildAgentContentGeneratorConfig,
  // so here we only overwrite when the registry provides a value.
  for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
    const registryValue = resolvedModel.generationConfig[field];
    if (registryValue !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (targetConfig as any)[field] = registryValue;
    }
  }

  // Log applied generation config for dp-auth models
  // [nessy-fork] dp-generation-config-logging
  if (resolvedModel.authType === 'dp-auth') {
    const genConfig = resolvedModel.generationConfig;
    const appliedFields: string[] = [];
    if (genConfig.contextWindowSize) {
      appliedFields.push(`contextWindowSize: ${genConfig.contextWindowSize}`);
    }
    if (genConfig.samplingParams) {
      const params = genConfig.samplingParams;
      if (params.temperature) appliedFields.push(`temperature: ${params.temperature}`);
      if (params.top_k) appliedFields.push(`top_k: ${params.top_k}`);
      if (params.top_p) appliedFields.push(`top_p: ${params.top_p}`);
      if (params.max_tokens) appliedFields.push(`max_tokens: ${params.max_tokens}`);
    }
    if (genConfig.reasoning) {
      const reasoning = genConfig.reasoning;
      if (reasoning.effort) appliedFields.push(`reasoning.effort: ${reasoning.effort}`);
      if (reasoning.budget_tokens) appliedFields.push(`reasoning.budget_tokens: ${reasoning.budget_tokens}`);
    }
    if (genConfig.extra_body) {
      appliedFields.push(`extra_body: ${JSON.stringify(genConfig.extra_body)}`);
    }

    if (appliedFields.length > 0) {
      logger.info(`Applied generation config for ${resolvedModel.id}: ${appliedFields.join(', ')}`);
    }
  }
}

/**
 * Resolve a credential field (apiKey or baseUrl) with the following
 * priority: explicit override → same-provider parent value → env var.
 */
export function resolveCredentialField(
  explicitValue: string | undefined,
  inheritedValue: string | undefined,
  authType: string,
  field: 'apiKey' | 'baseUrl',
): string | undefined {
  if (explicitValue) return explicitValue;
  if (inheritedValue) return inheritedValue;

  const envMapping =
    AUTH_ENV_MAPPINGS[authType as keyof typeof AUTH_ENV_MAPPINGS];
  if (!envMapping) return undefined;

  for (const envKey of envMapping[field]) {
    const value = process.env[envKey];
    if (value) return value;
  }
  return undefined;
}
