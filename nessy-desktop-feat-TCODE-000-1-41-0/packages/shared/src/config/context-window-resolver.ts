import type { LlmConnection } from './llm-connections.ts';
import { getDefaultModelsForConnection } from './llm-connections.ts';
import { getModelById, type ModelDefinition } from './models.ts';

/**
 * The only two fields this module reads off a catalogue entry.
 *
 * `ModelDefinition` satisfies it, and so does the far thinner
 * `BackendRuntimePayload.customModels` shape
 * (`{ id, contextWindow?, supportsImages? }`) that a Pi or BYO connection
 * actually carries. Widening to this (P3.43) is what lets the resolution below
 * see a gateway model at all: those entries are not `ModelDefinition`s and were
 * therefore unreachable from every caller that had only the runtime payload.
 */
export interface ContextWindowCatalogEntry {
  id: string;
  contextWindow?: number;
}

export interface ResolvedContextWindow {
  modelId: string;
  contextWindow: number | null;
  source:
    | 'runtime'
    | 'remote_reported'
    | 'connection_override'
    | 'provider_catalog'
    | 'static_registry'
    | 'preset'
    | 'unavailable';
  stale?: boolean;
}

export interface ResolveContextWindowInput {
  modelId: string;
  connection?: LlmConnection;
  runtimeContextWindow?: number | null;
  remoteReportedContextWindow?: number | null;
  providerCatalog?: ReadonlyArray<ContextWindowCatalogEntry | string>;
  /**
   * The gateway-confirmed window for this id, when — and only when — the caller
   * has already decided this connection IS the Nessy Gateway.
   *
   * Passed in rather than looked up here on purpose. "Which base URL is the
   * gateway" is a governance boundary owned by `isNessyGatewayBaseUrl`
   * (whole-URL match, never a prefix), and a config module that reached for it
   * would either duplicate that rule or drag the credential/adapter graph into
   * every importer of this file. The caller answers the boundary question; this
   * module only ranks the answer.
   *
   * It sits BELOW the connection's own catalogue because the catalogue is the
   * live value and this table is the shipped fallback, and ABOVE the static
   * registry because the static registry has never heard of a gateway id.
   */
  gatewayPresetWindow?: number | null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function findModelObject(
  models: ReadonlyArray<ContextWindowCatalogEntry | string> | undefined,
  modelId: string,
): ContextWindowCatalogEntry | null {
  const found = models?.find(model => typeof model !== 'string' && model.id === modelId);
  return found && typeof found !== 'string' ? found : null;
}

export function resolveContextWindow(input: ResolveContextWindowInput): ResolvedContextWindow {
  const runtime = finitePositive(input.runtimeContextWindow);
  if (runtime !== null) {
    return { modelId: input.modelId, contextWindow: runtime, source: 'runtime' };
  }

  const remote = finitePositive(input.remoteReportedContextWindow);
  if (remote !== null) {
    return { modelId: input.modelId, contextWindow: remote, source: 'remote_reported' };
  }

  const connectionModel = findModelObject(input.connection?.models, input.modelId);
  const connectionWindow = finitePositive(connectionModel?.contextWindow);
  if (connectionWindow !== null) {
    return { modelId: input.modelId, contextWindow: connectionWindow, source: 'connection_override' };
  }

  const providerCatalog = input.providerCatalog
    ?? (input.connection
      ? getDefaultModelsForConnection(input.connection.providerType, input.connection.piAuthProvider)
      : undefined);
  const catalogModel = findModelObject(providerCatalog, input.modelId);
  const catalogWindow = finitePositive(catalogModel?.contextWindow);
  if (catalogWindow !== null) {
    return { modelId: input.modelId, contextWindow: catalogWindow, source: 'provider_catalog' };
  }

  const preset = finitePositive(input.gatewayPresetWindow);
  if (preset !== null) {
    return { modelId: input.modelId, contextWindow: preset, source: 'preset' };
  }

  const staticWindow = finitePositive(getModelById(input.modelId)?.contextWindow);
  if (staticWindow !== null) {
    return { modelId: input.modelId, contextWindow: staticWindow, source: 'static_registry' };
  }

  return { modelId: input.modelId, contextWindow: null, source: 'unavailable' };
}

export function contextWindowDriftDiagnostic(input: {
  provider: string;
  connectionSlug?: string;
  modelId: string;
  catalogContextWindow?: number | null;
  runtimeContextWindow?: number | null;
  catalogSource?: ResolvedContextWindow['source'];
}): string | null {
  const catalog = finitePositive(input.catalogContextWindow);
  const runtime = finitePositive(input.runtimeContextWindow);
  if (catalog === null || runtime === null || catalog === runtime) {
    return null;
  }

  return [
    `Context window drift for ${input.provider}`,
    `connection=${input.connectionSlug ?? 'none'}`,
    `model=${input.modelId}`,
    `catalog=${catalog}`,
    `runtime=${runtime}`,
    `source=${input.catalogSource ?? 'unavailable'}`,
  ].join(' ');
}
