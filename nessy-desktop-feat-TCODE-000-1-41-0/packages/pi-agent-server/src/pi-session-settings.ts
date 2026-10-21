/**
 * Pi session settings by purpose (UB7.16, upstream v0.15.1
 * `pi-agent-server/src/session-settings.ts` — the cacheWarming half; our retry
 * and compaction equivalents live in `gateway-retry-settings.ts` and
 * `auto-compaction-settings.ts`).
 *
 * Pi 0.87.1 ships cache warming ON by default: `SettingsManager`'s
 * `getCacheWarmingMode()` answers `"streaming"` for any manager that does not
 * name `cacheWarming` (dist/core/settings-manager.js:637-640), and a
 * `CacheWarmer` per session then replays the last request with a one-token
 * output cap shortly before the prompt-cache entry expires — only when the
 * model declares a `promptCache` tier and the expected saving is at least $0.05
 * (dist/core/cache-warmer.js:27-35, CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS).
 * Our in-memory settings never named the key, so main AND ephemeral sessions
 * warmed: a native mechanism on without a verdict — the AGENTS.md silent
 * divergence this pin closes. The verdict: keep Pi's own default for main
 * chats (stated, and pinned against the installed SDK in
 * `pi-session-settings.test.ts`); turn it OFF for utility sessions — a
 * `call_llm`/title/summary session is one-shot and disposed right after its
 * prompt, so there is no follow-up request to save, only the warm request to
 * pay for.
 */
import type { CacheWarmingMode } from '@earendil-works/pi-coding-agent';

export type PiSessionPurpose = 'main' | 'ephemeral';

export function cacheWarmingForSession(purpose: PiSessionPurpose): CacheWarmingMode {
  return purpose === 'ephemeral' ? 'off' : 'streaming';
}
