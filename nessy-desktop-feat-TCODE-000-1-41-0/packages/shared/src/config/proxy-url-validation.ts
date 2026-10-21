/**
 * Proxy URL scheme validation (network-config.md:37: "Claude Code does not
 * support SOCKS proxies"). A SOCKS URL handed to undici's ProxyAgent would
 * be treated as an HTTP CONNECT proxy and fail in confusing ways — so it is
 * REFUSED with a clear message at the settings write path, and skipped with
 * a reported error at the apply/projection paths (hand-edited config).
 *
 * SECURITY: refusal messages name the FIELD and the scheme only — never the
 * URL itself, which may carry basic-auth credentials.
 */
import type { NetworkProxySettings } from './types.ts';

const REFUSED_PROXY_SCHEMES = ['socks', 'socks4', 'socks4a', 'socks5', 'socks5h'];

export type RefusedProxyUrl = {
  field: 'httpProxy' | 'httpsProxy';
  scheme: string;
  message: string;
};

/** Scheme of a proxy URL candidate, lowercase without the trailing colon. */
function schemeOf(value: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value.trim());
  return match ? match[1]!.toLowerCase() : undefined;
}

/**
 * Return the first refused (SOCKS-family) proxy URL among the configured
 * proxy fields, or undefined when every configured URL is acceptable.
 */
export function findRefusedProxyUrl(
  settings: Pick<NetworkProxySettings, 'httpProxy' | 'httpsProxy'> | undefined,
): RefusedProxyUrl | undefined {
  if (!settings) return undefined;
  for (const field of ['httpProxy', 'httpsProxy'] as const) {
    const value = settings[field];
    if (!value) continue;
    const scheme = schemeOf(value);
    if (scheme && REFUSED_PROXY_SCHEMES.includes(scheme)) {
      return {
        field,
        scheme,
        message: `SOCKS proxies are not supported: ${field} uses the '${scheme}' scheme. Use an HTTP or HTTPS proxy URL instead.`,
      };
    }
  }
  return undefined;
}
