/**
 * Environment the Pi SDK reads a tenant-specific endpoint from, derived from the
 * connection's base URL (UB3.12; upstream v0.15.0
 * `pi-agent-server/src/provider-endpoint-env.ts`).
 *
 * Azure arm only (our provider id — the upstream `azure` spelling is the Pi
 * 1.0.3 rename and is UB8.2's): AZURE_OPENAI_BASE_URL. Upstream's
 * `cloudflare-ai-gateway` arm is deliberately NOT taken (DROP-a, the owner's
 * 2026-10-14 decision — no third-party gateway preset ships).
 *
 * Called from BOTH doors that learn a base URL: `init` (first set) and
 * `update_runtime_config` (re-applied in place — Pi re-points the session on
 * an endpoint edit without a respawn, so the disclosed endpoint and the used
 * endpoint must not diverge until restart; owner rule F1.966). Empty for
 * other providers or an unusable URL — a non-Azure connection never has its
 * environment touched.
 */
export function providerEndpointEnv(provider: string | undefined, baseUrl: string | undefined): Record<string, string> {
  const url = baseUrl?.trim();
  if (!provider || !url) return {};
  if (provider === 'azure-openai-responses') return { AZURE_OPENAI_BASE_URL: url };
  return {};
}
