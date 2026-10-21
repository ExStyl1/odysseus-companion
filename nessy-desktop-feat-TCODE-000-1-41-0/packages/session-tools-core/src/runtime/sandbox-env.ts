/**
 * Shared environment sanitization for script-execution tools.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ScriptRuntimeLanguage } from './resolve-script-runtime.ts';

/**
 * Env vars stripped from subprocesses to prevent credential leakage — the ONE
 * list, read by both readers that strip an env.
 *
 * `DA2.22`: there used to be two copies of these names, here and in
 * `packages/shared/src/mcp/client.ts`, kept in step by a comment in each file
 * pointing at the other. They agreed (11 names each, measured 2026-09-17), which
 * is the good outcome of a mechanism that has no way to enforce itself — and one
 * of the two pointers had already gone stale and named a file that only imports
 * the helper. The list lives HERE and not in `shared` because the dependency runs
 * one way: `@nessy-agent/shared` depends on `@nessy-agent/session-tools-core`,
 * and this package depends on no workspace package at all, so the reverse import
 * would be a cycle. `shared`'s MCP stdio path imports it through this package's
 * root export, which its module graph already loads (measured: importing
 * `mcp/client.ts` costs ~18 s cold and the session-tools-core import that follows
 * it costs 0 ms, against ~7.7 s when it is imported alone).
 *
 * Adding a name here strips it from BOTH a script-runtime subprocess and an
 * inherited-env MCP stdio server. That is the intended blast radius: the question
 * the list answers — *is this a credential an untrusted child has no business
 * seeing?* — has one answer, not one per caller.
 */
export const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
] as const;

/**
 * Return a shallow-copied environment with sensitive variables removed.
 */
export function createSanitizedEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of BLOCKED_ENV_VARS) {
    delete env[key];
  }
  return env;
}

export interface ScriptRuntimeEnvOptions {
  language: ScriptRuntimeLanguage;
  dataDir: string;
}

/**
 * Build a sanitized subprocess env with runtime-local cache/temp paths.
 *
 * For Python/uv, redirect caches away from home-directory defaults (e.g. ~/.cache/uv)
 * into the writable session data directory so sandboxed execution remains reliable.
 */
export function createScriptRuntimeEnv(
  options: ScriptRuntimeEnvOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = createSanitizedEnv(baseEnv);
  const dataDir = resolve(options.dataDir);

  const tmpDir = join(dataDir, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  // Shared temp override (helps avoid host temp paths that may be blocked by FS isolation)
  env.TMPDIR = tmpDir;
  env.TMP = tmpDir;
  env.TEMP = tmpDir;

  if (options.language === 'python3') {
    const uvCacheDir = join(dataDir, '.uv-cache');
    const xdgCacheHome = join(dataDir, '.cache');
    const pythonPyCachePrefix = join(dataDir, '.pycache');

    mkdirSync(uvCacheDir, { recursive: true });
    mkdirSync(xdgCacheHome, { recursive: true });
    mkdirSync(pythonPyCachePrefix, { recursive: true });

    env.UV_CACHE_DIR = uvCacheDir;
    env.XDG_CACHE_HOME = xdgCacheHome;
    env.PYTHONPYCACHEPREFIX = pythonPyCachePrefix;

    // Verify TLS against the PLATFORM certificate store, not uv's bundled
    // Mozilla roots. `uv run` resolves PyPI live, so on a corporate network
    // with a TLS-intercepting proxy it fails with
    // `invalid peer certificate: UnknownIssuer` — measured 2026-09-11 on a
    // T-Bank laptop (P6.1107): `bun run test:doc-tools` 14 of 19 red without
    // it, 19 of 19 green with it.
    //
    // It REPLACES the bundled roots rather than adding to them: uv's reference
    // says the variable loads certificates from the native store "instead of
    // the bundled Mozilla root certificates"
    // (https://docs.astral.sh/uv/reference/environment/, entry
    // `UV_NATIVE_TLS`). Kept on unconditionally because the corporate store is
    // the shipped case, and a system store missing a public root has a remedy
    // the proxy case does not.
    //
    // Not the documented successor `UV_SYSTEM_CERTS`: that was added in uv
    // 0.11.0 and the app stages uv 0.10.6 (`UV_VERSION`,
    // `scripts/build/common.ts`), whose binary spells `UV_SYSTEM_CERTS` zero
    // times.
    env.UV_NATIVE_TLS = '1';
  }

  return env;
}
