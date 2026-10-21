import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigDefaultsSchema, StoredConfigSchema } from '../validators.ts';

// Guards the stored-config zod schema against providerType drift: adding a
// value to LlmProviderType without updating LlmProviderTypeSchema makes the
// config watcher reject config.json wholesale (watcher.ts early-returns before
// loadStoredConfig), silently killing hot-reload for ALL connections.
function configWith(providerType: string, authType = 'api_key') {
  return {
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    llmConnections: [
      {
        slug: `${providerType}-conn`,
        name: 'Test connection',
        providerType,
        authType,
        createdAt: 1,
      },
    ],
  };
}

describe('StoredConfigSchema llmConnections providerType', () => {
  it('requires storage layout v2', () => {
    expect(StoredConfigSchema.safeParse({
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
    }).success).toBe(false);
    expect(StoredConfigSchema.safeParse({
      storageLayoutVersion: 1,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
    }).success).toBe(false);
  });

  it('requires refs-only Workspace registry records', () => {
    expect(StoredConfigSchema.safeParse({
      storageLayoutVersion: 2,
      workspaces: [],
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
    }).success).toBe(false);
    expect(StoredConfigSchema.safeParse({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: 1, rootPath: '/tmp/ws-1' }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
    }).success).toBe(false);
  });

  it.each([
    ['anthropic', 'api_key'],
    ['pi', 'api_key'],
    ['pi_compat', 'api_key_with_endpoint'],
    ['codex-runtime', 'api_key_with_endpoint'],
    ['claude-runtime', 'api_key_with_endpoint'],
    ['nestor-cloud-agent', 'none'],
  ])('accepts a %s connection', (providerType, authType) => {
    const result = StoredConfigSchema.safeParse(configWith(providerType, authType));
    expect(result.success).toBe(true);
  });

  it('rejects an unknown providerType', () => {
    const result = StoredConfigSchema.safeParse(configWith('not-a-provider'));
    expect(result.success).toBe(false);
  });

  it('accepts the retentionDays preference', () => {
    const result = StoredConfigSchema.safeParse({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      retentionDays: 30,
    });

    expect(result.success).toBe(true);
  });

  it('accepts the memoryEnabled preference', () => {
    const result = StoredConfigSchema.safeParse({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      memoryEnabled: true,
    });

    expect(result.success).toBe(true);
  });

  it('accepts the macosSeatbeltBashSandboxEnabled preference', () => {
    const result = StoredConfigSchema.safeParse({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      macosSeatbeltBashSandboxEnabled: false,
    });

    expect(result.success).toBe(true);
  });

  it('accepts only a boolean autoCompactEnabled setting and stays strict', () => {
    const base = {
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
    };

    expect(StoredConfigSchema.safeParse({ ...base, autoCompactEnabled: false }).success).toBe(true);
    expect(StoredConfigSchema.safeParse({ ...base, autoCompactEnabled: 'false' }).success).toBe(false);
    expect(StoredConfigSchema.safeParse({ ...base, unknownCompactionSetting: true }).success).toBe(false);
  });
});

describe('ConfigDefaultsSchema', () => {
  // P6.972 — the base fixture is the SHIPPED asset, read the way
  // `advisor-defaults.test.ts` reads it, rather than a hand-listed copy of it.
  // A hand-list falls behind every key added to the schema and takes every
  // positive case in this block with it: `neverPersistSessions` (P6.502,
  // `7d776ddb7`) reached `config-defaults.json`, `FALLBACK_CONFIG_DEFAULTS` and
  // the schema in one commit and not this fixture, and the three
  // `expect(success).toBe(true)` cases below then failed on a key none of them
  // is about, while every `toBe(false)` case kept passing for the wrong reason.
  // Reading the asset costs no module graph — `storage.ts` would have brought
  // one — and cannot fall behind, because it IS the shape the app ships.
  const shipped = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../../../apps/electron/resources/config-defaults.json', import.meta.url)),
      'utf8',
    ),
  ) as { defaults: Record<string, unknown>; workspaceDefaults: Record<string, unknown> };

  /** The keys each positive/negative pair below supplies itself; stripped from the base. */
  const CONTROLLED_KEYS = [
    'maxAgentTurns',
    'maxBudgetUsd',
    'maxBudgetTokens',
    'fallbackModel',
    'deferredMcpToolLoading',
  ] as const;

  function defaultsWith(options: {
    maxAgentTurns?: number;
    maxBudgetUsd?: number;
    maxBudgetTokens?: number;
    // `model-config.md:364` widened this to a chain; the legacy scalar and any
    // shape a user can type must both reach the schema.
    fallbackModel?: unknown;
    deferredMcpToolLoading?: boolean;
  } = {}) {
    const workspaceDefaults: Record<string, unknown> = {
      ...shipped.workspaceDefaults,
      // Present in the base so every case but the last exercises the
      // key-present path; the shipped asset omits it on purpose (R52).
      thinkingLevel: 'think',
    };
    for (const key of CONTROLLED_KEYS) delete workspaceDefaults[key];

    const configDefaults = {
      version: '1.0',
      description: 'Default configuration values for Nessy',
      defaults: { ...shipped.defaults },
      workspaceDefaults,
    };

    if (options.maxAgentTurns !== undefined) {
      configDefaults.workspaceDefaults.maxAgentTurns = options.maxAgentTurns;
    }
    if (options.maxBudgetUsd !== undefined) {
      configDefaults.workspaceDefaults.maxBudgetUsd = options.maxBudgetUsd;
    }
    if (options.maxBudgetTokens !== undefined) {
      configDefaults.workspaceDefaults.maxBudgetTokens = options.maxBudgetTokens;
    }
    if (options.fallbackModel !== undefined) {
      configDefaults.workspaceDefaults.fallbackModel = options.fallbackModel;
    }
    if (options.deferredMcpToolLoading !== undefined) {
      configDefaults.workspaceDefaults.deferredMcpToolLoading = options.deferredMcpToolLoading;
    }

    return configDefaults;
  }

  it('accepts maxAgentTurns in workspace defaults', () => {
    const result = ConfigDefaultsSchema.safeParse(defaultsWith({
      maxAgentTurns: 0,
      maxBudgetUsd: 0,
      maxBudgetTokens: 0,
      fallbackModel: '',
      deferredMcpToolLoading: false,
    }));

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(result.data.defaults.autoCompactEnabled).toBe(true);
  });

  it('requires maxAgentTurns in workspace defaults', () => {
    const result = ConfigDefaultsSchema.safeParse(defaultsWith({ maxBudgetUsd: 0,
      maxBudgetTokens: 0, fallbackModel: '', deferredMcpToolLoading: false }));

    expect(result.success).toBe(false);
  });

  it('requires maxBudgetUsd in workspace defaults', () => {
    const result = ConfigDefaultsSchema.safeParse(defaultsWith({ maxAgentTurns: 0,
      maxBudgetTokens: 0, fallbackModel: '', deferredMcpToolLoading: false }));

    expect(result.success).toBe(false);
  });

  it('requires maxBudgetTokens in workspace defaults (P6.645)', () => {
    // The declaration half of the token ceiling. `resolveMaxBudgetTokens()`
    // reads an absent field as 0 = no cap on purpose, so an UNDECLARED key is
    // silently inert rather than loud; this schema is the loud half.
    const result = ConfigDefaultsSchema.safeParse(defaultsWith({ maxAgentTurns: 0,
      maxBudgetUsd: 0, fallbackModel: '', deferredMcpToolLoading: false }));

    expect(result.success).toBe(false);
  });

  it('rejects a fractional maxBudgetTokens (P6.645)', () => {
    // A token ceiling is a COUNT: `loadConfigDefaults` floors it, and the
    // schema refuses to call a fractional value well-formed.
    const result = ConfigDefaultsSchema.safeParse(defaultsWith({ maxAgentTurns: 0,
      maxBudgetUsd: 0, maxBudgetTokens: 1.5, fallbackModel: '', deferredMcpToolLoading: false }));

    expect(result.success).toBe(false);
  });

  it('requires fallbackModel in workspace defaults', () => {
    const result = ConfigDefaultsSchema.safeParse(defaultsWith({ maxAgentTurns: 0, maxBudgetUsd: 0,
      maxBudgetTokens: 0, deferredMcpToolLoading: false }));

    expect(result.success).toBe(false);
  });

  it('requires deferredMcpToolLoading in workspace defaults', () => {
    const result = ConfigDefaultsSchema.safeParse(defaultsWith({ maxAgentTurns: 0, maxBudgetUsd: 0,
      maxBudgetTokens: 0, fallbackModel: '' }));

    expect(result.success).toBe(false);
  });

  it('accepts a fallbackModel chain as an array', () => {
    // `model-config.md:373` — "set `fallbackModel` in settings as an array".
    const result = ConfigDefaultsSchema.safeParse(defaultsWith({
      maxAgentTurns: 0,
      maxBudgetUsd: 0,
      maxBudgetTokens: 0,
      fallbackModel: ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8'],
      deferredMcpToolLoading: false,
    }));

    expect(result.success).toBe(true);
  });

  it('rejects a fallbackModel that is neither a string nor an array', () => {
    const result = ConfigDefaultsSchema.safeParse(defaultsWith({
      maxAgentTurns: 0,
      maxBudgetUsd: 0,
      maxBudgetTokens: 0,
      fallbackModel: 42,
      deferredMcpToolLoading: false,
    }));

    expect(result.success).toBe(false);
  });

  it('accepts workspace defaults with no thinkingLevel — the shipped shape', () => {
    // R52: the bundled asset ships the key ABSENT so the per-model default from
    // `model-config.md:453` is reachable at all.
    const shipped = defaultsWith({
      maxAgentTurns: 0,
      maxBudgetUsd: 0,
      maxBudgetTokens: 0,
      fallbackModel: [],
      deferredMcpToolLoading: false,
    });
    delete (shipped.workspaceDefaults as Record<string, unknown>).thinkingLevel;

    const result = ConfigDefaultsSchema.safeParse(shipped);

    expect(result.success).toBe(true);
  });
});
