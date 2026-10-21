/**
 * Feature flags for controlling experimental or in-development features.
 */

/** Safe accessor for process.env — returns undefined in browser/renderer contexts. */
function getEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) return process.env[key];
  return undefined;
}

export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Shared runtime detector for development/debug environments.
 *
 * Use this instead of app-specific debug flags (e.g., Electron main isDebugMode)
 * so behavior stays consistent across shared code and subprocess backends.
 */
export function isDevRuntime(): boolean {
  const nodeEnv = (getEnv('NODE_ENV') || '').toLowerCase();
  return nodeEnv === 'development' || nodeEnv === 'dev' || getEnv('NESSY_DEBUG') === '1';
}

/**
 * Runtime-evaluated check for developer feedback feature.
 * Explicit env override has precedence over dev-runtime defaults.
 */
export function isDeveloperFeedbackEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('NESSY_FEATURE_DEVELOPER_FEEDBACK'));
  if (override !== undefined) return override;
  return isDevRuntime();
}

/**
 * Runtime-evaluated check for the HOST's Anthropic-wire fast path.
 *
 * Defaults to disabled. Override with NESSY_FEATURE_FAST_MODE=1|0. See
 * {@link FEATURE_FLAGS.fastMode} for why this is not claude's `fastMode`
 * settings key and not codex's `features.fast_mode`.
 */
export function isFastModeEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('NESSY_FEATURE_FAST_MODE'));
  if (override !== undefined) return override;
  return false;
}

/**
 * Runtime-evaluated check for embedded server settings page.
 *
 * Defaults to disabled. Override with NESSY_FEATURE_EMBEDDED_SERVER=1|0.
 */
export function isEmbeddedServerEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('NESSY_FEATURE_EMBEDDED_SERVER'));
  if (override !== undefined) return override;
  return false;
}

/**
 * Runtime-evaluated check for the Codex coding runtime (providerType
 * `codex-runtime`). Gates `getAvailableProviders()` + the connection-setup UI.
 *
 * Defaults to ENABLED (owner decision 2026-08-06: the coding runtimes ship by
 * default; only the subscription cards — Claude Pro/Max, ChatGPT — stay
 * flag-gated). Override with NESSY_FEATURE_CODEX_RUNTIME=0 to build without it.
 */
export function isCodexRuntimeEnabled(): boolean {
  // STATIC process.env member access (not getEnv) so esbuild `--define`
  // (getBuildDefines in scripts/electron-build-main.ts) can bake the build-time
  // value into the packaged main bundle. getEnv's dynamic lookup would not be
  // rewritten, leaving packaged builds unable to flip the flag on.
  const raw =
    typeof process !== 'undefined' && process.env
      ? process.env.NESSY_FEATURE_CODEX_RUNTIME
      : undefined;
  const override = parseBooleanEnv(raw);
  if (override !== undefined) return override;
  return true;
}

/**
 * Runtime-evaluated check for the Claude SDK runtime: the `anthropic` agent
 * backend, the packaged native `claude` binary (~210MB), and the Nessy Gateway
 * Claude card (`claude-runtime` providerType).
 *
 * Split out of `NESSY_FEATURE_PROVIDER_CLAUDE`, which used to conflate three
 * separate decisions. That flag now gates ONLY the Claude Pro/Max subscription
 * card — but the card cannot work without the runtime, so it *implies* it:
 * backend availability and binary bundling read `isAnthropicBackendEnabled()`
 * (the OR of the two), while the `claude-runtime` providerType reads this flag
 * alone.
 *
 * Defaults to ENABLED (owner decision 2026-08-06: the coding runtimes ship by
 * default; only the subscription cards stay flag-gated). Override with
 * NESSY_FEATURE_CLAUDE_RUNTIME=0 to build without the runtime and its ~247MB
 * native binary.
 */
export function isClaudeRuntimeEnabled(): boolean {
  // STATIC process.env member access (not getEnv) so esbuild `--define`
  // (getBuildDefines in scripts/electron-build-main.ts) can bake the build-time
  // value into the packaged main bundle. getEnv's dynamic lookup would not be
  // rewritten, leaving packaged builds unable to flip the flag on.
  const raw =
    typeof process !== 'undefined' && process.env
      ? process.env.NESSY_FEATURE_CLAUDE_RUNTIME
      : undefined;
  const override = parseBooleanEnv(raw);
  if (override !== undefined) return override;
  return true;
}

/**
 * Whether the `anthropic` agent backend (ClaudeAgent + the bundled native
 * `claude` binary) is part of this build.
 *
 * EITHER flag turns it on: the subscription card implies the runtime it needs,
 * and the runtime flag ships the backend without offering that card. This is
 * the single source of the OR — build scripts mirror it in shell/PowerShell/Ruby
 * (`build-dmg.sh`, `build-win.ps1`, `Fastfile`, `ensure-claude-sdk-binary-dir.cjs`)
 * so the bundled binary and the code that looks for it agree.
 */
export function isAnthropicBackendEnabled(): boolean {
  return isProviderEnabled('claude') || isClaudeRuntimeEnabled();
}

/**
 * C4 (capability-path plan, ADR § 8): the kill-switch for serving PERSISTED
 * pre-C3 plugin connectors through the capability path.
 *
 * Default ON since C5, which deleted the Source projection: persisted pre-C3
 * connectors project as auth-carrying mcp capabilities reading the migrated
 * GLOBAL plugin slots. New installs ride the capability path regardless of
 * this flag (the C3 normalization funnel). Turning it OFF today is an
 * emergency "do not serve legacy connector servers" switch — it can no longer
 * restore the deleted Source projection; the copied credential rows stay
 * intact either way, so a build DOWNGRADE still finds them.
 *
 * STATIC process.env member access (not getEnv) so esbuild `--define` can bake
 * the build-time value into the packaged main bundle.
 */
export function isPluginMcpCapabilityPathEnabled(): boolean {
  const raw =
    typeof process !== 'undefined' && process.env
      ? process.env.NESSY_FEATURE_PLUGIN_MCP_CAPABILITY_PATH
      : undefined;
  const override = parseBooleanEnv(raw);
  if (override !== undefined) return override;
  return true;
}

/**
 * Build-time provider gating. Each onboarding / settings "add connection" card
 * is behind a flag so a single build can ship only a subset of integrations.
 * The default build enables Nestor-via-Pi, the native Nestor cloud A2A agent,
 * and custom endpoints; local models (Ollama), Claude, ChatGPT/Codex-subscription,
 * and the Codex/Claude runtimes are opt-in. The Pi-backed default cards AND the local card
 * run on the Pi backend — the local flow's `anthropic-api` template upgrades to
 * `pi_compat` once a custom endpoint is present (see server-core
 * connection-setup-logic). The native cloud agent (`nessy_cloud`) is the one
 * default-on card that runs on its own Nestor A2A backend, not Pi.
 *
 * Reads are STATIC `process.env.*` member access (not getEnv) so esbuild
 * `--define` bakes the value into the packaged main bundle — unset at build time
 * falls back to the default below. The renderer reads these via the
 * `nessy:getProviderFlags` IPC; main is the only context where process.env is
 * real.
 */
export type ProviderFlagId =
  | 'nessy'
  | 'nessy_cloud'
  | 'nessy_codex'
  | 'nessy_claude'
  | 'claude'
  | 'chatgpt'
  | 'api_key'
  | 'local';

const PROVIDER_FLAG_DEFAULTS: Record<ProviderFlagId, boolean> = {
  nessy: true, // Nestor gateway via Pi
  nessy_cloud: true, // Native Nestor cloud A2A agent (own A2A backend, default-on)
  api_key: true, // bring-your-own endpoint (Anthropic / OpenAI / OpenRouter / …)
  local: false, // local models (Ollama) — pi_compat custom endpoint, user decision to keep off
  claude: false, // Claude Pro/Max subscription
  chatgpt: false, // ChatGPT / Codex subscription
  nessy_codex: true, // Codex coding runtime (aliases isCodexRuntimeEnabled)
  nessy_claude: true, // Claude coding runtime (aliases isClaudeRuntimeEnabled)
};

function providerFlagOverride(id: ProviderFlagId): boolean | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  switch (id) {
    case 'nessy':
      return parseBooleanEnv(process.env.NESSY_FEATURE_PROVIDER_NESSY);
    case 'nessy_cloud':
      return parseBooleanEnv(process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD);
    case 'claude':
      return parseBooleanEnv(process.env.NESSY_FEATURE_PROVIDER_CLAUDE);
    case 'chatgpt':
      return parseBooleanEnv(process.env.NESSY_FEATURE_PROVIDER_CHATGPT);
    case 'api_key':
      return parseBooleanEnv(process.env.NESSY_FEATURE_PROVIDER_API_KEY);
    case 'local':
      return parseBooleanEnv(process.env.NESSY_FEATURE_PROVIDER_LOCAL);
    case 'nessy_codex':
      return undefined; // derived from isCodexRuntimeEnabled()
    case 'nessy_claude':
      return undefined; // derived from isClaudeRuntimeEnabled()
  }
}

/**
 * Whether a provider card is offered. `nessy_codex`/`nessy_claude` follow their
 * single runtime flag so the card and the backend stay in sync; the rest read
 * their own `NESSY_FEATURE_PROVIDER_*` env override and fall back to
 * PROVIDER_FLAG_DEFAULTS.
 *
 * `claude` is the Pro/Max SUBSCRIPTION card only — it does not answer "is the
 * Claude backend in this build?". Use `isAnthropicBackendEnabled()` for that.
 */
export function isProviderEnabled(id: ProviderFlagId): boolean {
  if (id === 'nessy_codex') return isCodexRuntimeEnabled();
  if (id === 'nessy_claude') return isClaudeRuntimeEnabled();
  const override = providerFlagOverride(id);
  if (override !== undefined) return override;
  return PROVIDER_FLAG_DEFAULTS[id];
}

/** Resolve every provider flag at once (main process → renderer IPC payload). */
export function resolveProviderFlags(): Record<ProviderFlagId, boolean> {
  return {
    nessy: isProviderEnabled('nessy'),
    nessy_cloud: isProviderEnabled('nessy_cloud'),
    nessy_codex: isProviderEnabled('nessy_codex'),
    nessy_claude: isProviderEnabled('nessy_claude'),
    claude: isProviderEnabled('claude'),
    chatgpt: isProviderEnabled('chatgpt'),
    api_key: isProviderEnabled('api_key'),
    local: isProviderEnabled('local'),
  };
}

export const FEATURE_FLAGS = {
  /**
   * Enable the HOST's own fast path — the one this fork applies on the
   * Anthropic wire (`speed: "fast"` plus the fast-mode beta header) in
   * {@link file://./unified-network-interceptor.ts}.
   *
   * **Two different things share the name `fastMode`, and conflating them is a
   * silent divergence (P6.244).** Claude's own `fastMode` is a SETTINGS KEY the
   * claude child reads for itself — `settings-reference.md#fastmode`, "Turn
   * fast mode on for sessions where it's available" — toggled by `/fast` and
   * overridable per session by `CLAUDE_CODE_DISABLE_FAST_MODE`. This flag does
   * NOT set that key and does not reach the claude child; it decorates
   * outbound Anthropic requests our interceptor sees. On codex the same idea is
   * `features.fast_mode`, enforced by codex itself.
   *
   * Defaults to disabled — the page's own default is "unset, so fast mode is
   * off". Override with NESSY_FEATURE_FAST_MODE=1|0. It used to be a hardcoded
   * `false` literal with no override at all, so no operator could reach it.
   */
  get fastMode(): boolean {
    return isFastModeEnabled();
  },
  /**
   * Enable agent developer feedback tool.
   *
   * Defaults to enabled in explicit development runtimes; disabled otherwise.
   * Override with NESSY_FEATURE_DEVELOPER_FEEDBACK=1|0.
   */
  get developerFeedback(): boolean {
    return isDeveloperFeedbackEnabled();
  },
  /**
   * Enable embedded server settings page.
   *
   * Defaults to disabled. Override with NESSY_FEATURE_EMBEDDED_SERVER=1|0.
   */
  get embeddedServer(): boolean {
    return isEmbeddedServerEnabled();
  },
  /**
   * Enable the Codex coding runtime (providerType `codex-runtime`).
   *
   * Defaults to enabled. Override with NESSY_FEATURE_CODEX_RUNTIME=1|0.
   */
  get codexRuntime(): boolean {
    return isCodexRuntimeEnabled();
  },
  // No `claudeRuntime` mirror here on purpose: `FEATURE_FLAGS.codexRuntime` has
  // no production caller, and every consumer of the Claude split reads
  // `isClaudeRuntimeEnabled()` / `isAnthropicBackendEnabled()` directly.
} as const;
