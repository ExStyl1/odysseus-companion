/**
 * R22: pure helpers for http-hook containment
 * (`settings-reference.md#hook-configuration`, fetched 2026-08-25 — `settings.md`
 * keeps that anchor only as a redirect stub at the top of the page; the two keys
 * below are documented under `## Hooks and automation` on the reference page).
 *
 * `interpolateHttpHookHeaders` resolves `$VAR`/`${VAR}` references in http hook
 * headers for allowed names only; every unlisted reference is replaced with the
 * empty string, matching Claude's documented `allowedEnvVars` behaviour. The
 * caller owns computing the effective allowlist (the intersection of the hook's
 * own list and the managed `httpHookAllowedEnvVars` policy key).
 *
 * `matchesHttpHookUrlPattern` implements the managed `allowedHttpHookUrls`
 * wildcard matcher: hostname compared case-insensitively, a trailing FQDN dot
 * ignored, `*` matching exactly one hostname segment, and `*` in the path
 * matching any remainder.
 */

const ENV_REFERENCE = /\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g;

export function interpolateHttpHookHeaders(
  headers: Record<string, string>,
  allowedEnvVars: readonly string[],
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const allowed = new Set(allowedEnvVars);
  const interpolated: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    interpolated[name] = value.replace(ENV_REFERENCE, (_match, braced: string | undefined, plain: string | undefined) => {
      const reference = braced ?? plain ?? '';
      // Unlisted (or listed-but-unset) references resolve to the empty string
      // rather than leaking the literal `$NAME` text downstream.
      return allowed.has(reference) ? env[reference] ?? '' : '';
    });
  }
  return interpolated;
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

function hostnameMatches(hostname: string, pattern: string): boolean {
  const hostSegments = stripTrailingDot(hostname.toLowerCase()).split('.');
  const patternSegments = stripTrailingDot(pattern.toLowerCase()).split('.');
  if (hostSegments.length !== patternSegments.length) return false;
  return patternSegments.every((segment, index) => segment === '*' || segment === hostSegments[index]);
}

/**
 * GRANT-GLOB-NEWLINE. No `s` flag, deliberately — and here it is also inert:
 * `new URL` strips a raw line terminator before `matchesHttpHookUrlPattern`
 * calls this, so none ever reaches the regex. Measured with a positive control
 * in `config/__tests__/grant-glob-newline-policy.test.ts`.
 */
function pathMatches(path: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(path);
}

export function matchesHttpHookUrlPattern(url: string, pattern: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const schemeSplit = pattern.indexOf('://');
  if (schemeSplit === -1) return false;
  if (`${pattern.slice(0, schemeSplit).toLowerCase()}:` !== target.protocol) return false;
  const remainder = pattern.slice(schemeSplit + 3);
  const pathStart = remainder.indexOf('/');
  const hostPort = pathStart === -1 ? remainder : remainder.slice(0, pathStart);
  // A pattern without a path constrains the origin only.
  const pathPattern = pathStart === -1 ? '*' : remainder.slice(pathStart);
  const portSplit = hostPort.lastIndexOf(':');
  const patternHost = portSplit === -1 ? hostPort : hostPort.slice(0, portSplit);
  const patternPort = portSplit === -1 ? '' : hostPort.slice(portSplit + 1);
  if (!patternHost || !hostnameMatches(target.hostname, patternHost)) return false;
  // An explicit pattern port must match; an absent one requires the scheme's
  // default port (URL normalizes a default port to the empty string).
  if (patternPort !== target.port) return false;
  return pathMatches(target.pathname, pathPattern);
}
