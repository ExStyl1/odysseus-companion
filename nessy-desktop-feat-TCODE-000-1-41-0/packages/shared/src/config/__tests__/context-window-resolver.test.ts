import { describe, expect, it } from 'bun:test';
import { contextWindowDriftDiagnostic, resolveContextWindow } from '../context-window-resolver.ts';
import type { LlmConnection } from '../llm-connections.ts';
import type { ModelDefinition } from '../models.ts';

function connection(partial: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'pi',
    authType: 'api_key',
    createdAt: 1,
    ...partial,
  };
}

function model(id: string, contextWindow: number): ModelDefinition {
  return {
    id,
    name: id,
    shortName: id,
    description: id,
    provider: 'pi',
    contextWindow,
  };
}

describe('resolveContextWindow', () => {
  it('resolves static Nestor Cloud from the static registry', () => {
    expect(resolveContextWindow({ modelId: 'nestor-cloud-code-agent' })).toEqual({
      modelId: 'nestor-cloud-code-agent',
      contextWindow: 200_000,
      source: 'static_registry',
    });
  });

  it('resolves a Pi provider catalog object', () => {
    expect(resolveContextWindow({
      modelId: 'pi/fable',
      providerCatalog: [model('pi/fable', 1_000_000)],
    })).toEqual({
      modelId: 'pi/fable',
      contextWindow: 1_000_000,
      source: 'provider_catalog',
    });
  });

  it('uses a custom endpoint object override from the connection', () => {
    expect(resolveContextWindow({
      modelId: 'local-model',
      connection: connection({
        providerType: 'pi_compat',
        authType: 'none',
        models: [{ ...model('local-model', 131_072), provider: 'pi' }],
      }),
    })).toEqual({
      modelId: 'local-model',
      contextWindow: 131_072,
      source: 'connection_override',
    });
  });

  it('does not invent a context window for string-only custom models', () => {
    expect(resolveContextWindow({
      modelId: 'unknown-local',
      connection: connection({
        providerType: 'pi_compat',
        authType: 'none',
        models: ['unknown-local'],
      }),
      providerCatalog: ['unknown-local'],
    })).toEqual({
      modelId: 'unknown-local',
      contextWindow: null,
      source: 'unavailable',
    });
  });

  it('reads a thin runtime catalogue entry, not just a full ModelDefinition', () => {
    // `BackendRuntimePayload.customModels` carries `{ id, contextWindow? }` and
    // nothing else. Before P3.43 the parameter demanded a `ModelDefinition`, so
    // no caller holding only the runtime payload could reach this tier at all.
    expect(resolveContextWindow({
      modelId: 'tgpt/qwen35-397b-a17b-fp8',
      providerCatalog: [{ id: 'tgpt/qwen35-397b-a17b-fp8', contextWindow: 262_000 }],
    })).toEqual({
      modelId: 'tgpt/qwen35-397b-a17b-fp8',
      contextWindow: 262_000,
      source: 'provider_catalog',
    });
  });

  it('uses the gateway preset only below the catalogue and above the static registry', () => {
    // `'preset'` was a union member no code path could produce (P3.32). It is
    // reachable now, and it must stay BELOW the live catalogue.
    expect(resolveContextWindow({
      modelId: 'tgpt/qwen35-397b-a17b-fp8',
      providerCatalog: ['tgpt/qwen35-397b-a17b-fp8'],
      gatewayPresetWindow: 262_000,
    })).toEqual({
      modelId: 'tgpt/qwen35-397b-a17b-fp8',
      contextWindow: 262_000,
      source: 'preset',
    });

    expect(resolveContextWindow({
      modelId: 'tgpt/qwen35-397b-a17b-fp8',
      providerCatalog: [{ id: 'tgpt/qwen35-397b-a17b-fp8', contextWindow: 200_000 }],
      gatewayPresetWindow: 262_000,
    }).source).toBe('provider_catalog');

    // A caller that did not decide the connection is the gateway passes nothing,
    // and nothing is what it gets — no window is invented for an unknown id.
    expect(resolveContextWindow({
      modelId: 'tgpt/qwen35-397b-a17b-fp8',
      providerCatalog: ['tgpt/qwen35-397b-a17b-fp8'],
    })).toEqual({
      modelId: 'tgpt/qwen35-397b-a17b-fp8',
      contextWindow: null,
      source: 'unavailable',
    });
  });

  it('never lets a placeholder preset through as a window', () => {
    // `1` means "not filled in" in both catalogues this repo reads. It is not a
    // positive finite window here either.
    expect(resolveContextWindow({
      modelId: 'unknown-gateway-model',
      gatewayPresetWindow: 0,
    }).source).toBe('unavailable');
  });

  it('lets runtime values win over stale catalog metadata', () => {
    expect(resolveContextWindow({
      modelId: 'pi/fable',
      runtimeContextWindow: 2_000_000,
      providerCatalog: [model('pi/fable', 1_000_000)],
    })).toEqual({
      modelId: 'pi/fable',
      contextWindow: 2_000_000,
      source: 'runtime',
    });
  });

  it('reports drift only when catalog and runtime windows are both known and different', () => {
    expect(contextWindowDriftDiagnostic({
      provider: 'pi',
      connectionSlug: 'pi-main',
      modelId: 'pi/fable',
      catalogContextWindow: 1_000_000,
      runtimeContextWindow: 2_000_000,
      catalogSource: 'provider_catalog',
    })).toContain('catalog=1000000 runtime=2000000');

    expect(contextWindowDriftDiagnostic({
      provider: 'pi',
      modelId: 'pi/fable',
      catalogContextWindow: 1_000_000,
      runtimeContextWindow: 1_000_000,
    })).toBeNull();
  });
});
