import { isIP } from 'node:net';

/**
 * Address guard for outbound watch targets (Monitor's ws source today).
 *
 * Pure except for the INJECTED resolver, so the interesting half — "including
 * hostnames that resolve to one" — is testable without DNS. The four documented
 * clauses, in evaluation order:
 *
 * 1. a literal private/link-local/cloud-metadata address is denied;
 * 2. a host in `sandbox.network.deniedDomains` is denied;
 * 3. under `allowManagedDomainsOnly`, a host outside the managed allowlist is
 *    denied;
 * 4. a hostname is RESOLVED and every resolved address is re-checked against
 *    clause 1 — the clause a naive implementation skips, and the one that turns
 *    an attacker-controlled DNS record into an SSRF.
 *
 * A literal IP is a HOST (`tools-reference.md:303` binds all three deny rules
 * to the URL's host), so clauses 2 and 3 apply to it exactly as to a name; only
 * clause 4 is skipped, there being nothing to resolve. The guard used to return
 * early for any literal IP that was not blocked outright, which let a caller
 * walk around a managed allowlist — a documented DENY — by writing the address
 * instead of the name. An allowlist of NAMES cannot admit a raw IP, so under
 * `allowManagedDomainsOnly` a literal public IP is denied unless the allowlist
 * names that exact address.
 *
 * Everything fails CLOSED: no resolved addresses, a failed lookup, an
 * unparseable host, or an empty managed allowlist all deny.
 */

export interface NetworkAddressGuardOptions {
  /**
   * Resolve a hostname to its addresses. Injected so the guard stays pure and
   * so the caller decides the DNS policy (family, timeout, cache).
   */
  resolve: (host: string) => Promise<string[]>;
  /** `sandbox.network.deniedDomains`, already composed across settings layers. */
  deniedDomains: readonly string[];
  /**
   * The managed allowlist, passed ONLY when `allowManagedDomainsOnly` resolves
   * true. Presence IS the flag: that way a caller cannot set the flag and
   * forget the list, and an empty list denies everything instead of silently
   * meaning "no restriction".
   */
  managedAllowlist?: readonly string[];
}

export interface NetworkAddressGuardResult {
  denied: boolean;
  reason?: string;
}

const ALLOWED: NetworkAddressGuardResult = Object.freeze({ denied: false });

/** Well-known metadata endpoints that are not already inside a blocked range. */
const CLOUD_METADATA_ADDRESSES = new Set([
  '169.254.169.254',   // AWS / Azure / GCP / OpenStack (also link-local)
  '100.100.100.200',   // Alibaba Cloud
  '192.0.0.192',       // Oracle Cloud
  'fd00:ec2::254',     // AWS IPv6 (also unique-local)
]);

/** Strip brackets, lowercase, drop a single trailing dot. */
function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/^\[|\]$/g, '');
  return trimmed.toLowerCase().replace(/\.$/, '');
}

/**
 * `host` equals `domain` or is a subdomain of it. Never a bare suffix match.
 *
 * `settings.md`'s `network.allowedDomains` row: "Array of domains to allow for
 * outbound network traffic. Supports wildcards (e.g., `*.example.com`)", and
 * `deniedDomains` "Supports the same wildcard syntax".
 *
 * The wildcard form used to match NOTHING here: `*.example.com` was compared
 * literally, so no host ever equalled it and none ended with `.*.example.com`.
 * An administrator writing the documented spelling got an entry that silently
 * did not apply — and on the DENY list that is under-enforcement, which is the
 * direction that matters. Found by S12 while wiring the sandbox network
 * settings, in the one consumer that does enforce them.
 *
 * A leading `*.` is stripped and the remainder matched as a subdomain rule, so
 * `*.example.com` and `example.com` behave alike. That is deliberately the wider
 * of the two readings: `settings.md`'s own example pairs `"github.com"` with
 * `"*.npmjs.org"` as if they were the same kind of entry, and on the deny side
 * the wider reading is the safer one. A bare `*` matches nothing rather than
 * everything — an allowlist that silently became "allow all" from one typo is
 * the failure this comment exists to prevent.
 */
export function matchesDomain(host: string, domain: string): boolean {
  const withoutWildcard = domain.trim().startsWith('*.') ? domain.trim().slice(2) : domain;
  const normalized = normalizeHost(withoutWildcard);
  if (normalized.length === 0 || normalized === '*') return false;
  return host === normalized || host.endsWith(`.${normalized}`);
}

function expandIpv6(value: string): string[] | null {
  const zoneless = value.split('%')[0]!;
  const [head, tail] = zoneless.split('::') as [string, string | undefined];
  const headGroups = head.length > 0 ? head.split(':') : [];
  const tailGroups = tail !== undefined && tail.length > 0 ? tail.split(':') : [];
  if (tail === undefined) {
    return headGroups.length === 8 ? headGroups : null;
  }
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 0) return null;
  return [...headGroups, ...Array.from({ length: fill }, () => '0'), ...tailGroups];
}

/**
 * Why this address must not be connected to, or `null` when it is fine.
 * An address the guard cannot parse is denied — a guard that shrugs is not one.
 */
function blockedAddressReason(address: string): string | null {
  const host = normalizeHost(address);
  const family = isIP(host);

  if (family === 4) {
    if (CLOUD_METADATA_ADDRESSES.has(host)) return `${host} is a cloud-metadata address`;
    const octets = host.split('.').map(Number);
    const [a, b] = octets as [number, number, number, number];
    if (a === 0) return `${host} is an unspecified address`;
    if (a === 127) return `${host} is a loopback address`;
    if (a === 10) return `${host} is a private address`;
    if (a === 172 && b >= 16 && b <= 31) return `${host} is a private address`;
    if (a === 192 && b === 168) return `${host} is a private address`;
    if (a === 169 && b === 254) return `${host} is a link-local address`;
    if (a === 100 && b >= 64 && b <= 127) return `${host} is a carrier-grade NAT address`;
    if (a >= 224) return `${host} is a multicast or reserved address`;
    return null;
  }

  if (family === 6) {
    if (CLOUD_METADATA_ADDRESSES.has(host)) return `${host} is a cloud-metadata address`;
    const groups = expandIpv6(host);
    if (!groups) return `${host} is not a parseable address`;
    // An IPv4-mapped/-embedded address must be judged as the IPv4 address it
    // carries, or ::ffff:169.254.169.254 walks straight past every IPv6 range.
    const embedded = groups.at(-1)!;
    if (embedded.includes('.')) {
      const prefix = groups.slice(0, -1).map(group => parseInt(group || '0', 16));
      if (prefix.every(group => group === 0 || group === 0xffff)) return blockedAddressReason(embedded);
    }
    const values = groups.map(group => parseInt(group || '0', 16));
    if (values.every(group => group === 0)) return `${host} is an unspecified address`;
    if (values.slice(0, 7).every(group => group === 0) && values[7] === 1) return `${host} is a loopback address`;
    const first = values[0]!;
    if ((first & 0xfe00) === 0xfc00) return `${host} is a unique local address`;
    if ((first & 0xffc0) === 0xfe80) return `${host} is a link-local address`;
    if ((first & 0xff00) === 0xff00) return `${host} is a multicast address`;
    return null;
  }

  return `${address} is not a usable address`;
}

/**
 * The `ws` field rules of `tools-reference.md:296`-`:297`, as one PURE check:
 *
 * - `url` — "Must be a `ws://` or `wss://` URL with no embedded credentials or
 *   whitespace, using ASCII characters only";
 * - `protocols` — "Each entry must be a valid subprotocol token, and the list
 *   can't contain duplicates".
 *
 * Enforced at the last gate before the network (`SessionMonitorService.start`),
 * so no caller can route around it. Reasons NEVER quote the URL: the rule this
 * validator enforces is that a URL may carry credentials, and a refused secret
 * must not leak into an error message, log line, or thrown string.
 */
export interface WsWatchInputVerdict {
  ok: boolean;
  reason?: string;
}

/** RFC 6455 subprotocol token — an HTTP token: 1+ tchar, no separators, no CTLs. */
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Printable ASCII only — rejects whitespace, control characters and non-ASCII. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

export function validateWsWatchInput(input: {
  url: string;
  protocols?: readonly string[];
}): WsWatchInputVerdict {
  if (!PRINTABLE_ASCII.test(input.url)) {
    return { ok: false, reason: 'the ws url must be ASCII with no whitespace or control characters' };
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, reason: 'the ws url is not a valid URL' };
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { ok: false, reason: `the ws url must use ws: or wss:, got ${parsed.protocol}` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'the ws url must not embed credentials' };
  }
  const protocols = input.protocols ?? [];
  const seen = new Set<string>();
  for (const [index, entry] of protocols.entries()) {
    if (typeof entry !== 'string' || !SUBPROTOCOL_TOKEN.test(entry)) {
      return { ok: false, reason: `ws protocols[${index}] is not a valid subprotocol token` };
    }
    if (seen.has(entry)) {
      return { ok: false, reason: `ws protocols[${index}] duplicates an earlier entry` };
    }
    seen.add(entry);
  }
  return { ok: true };
}

export async function isDeniedNetworkTarget(
  host: string,
  options: NetworkAddressGuardOptions,
): Promise<NetworkAddressGuardResult> {
  const normalized = normalizeHost(host);
  if (normalized.length === 0) return { denied: true, reason: 'the target host is empty' };

  // Clause 1 for a literal address. NOT an early allow: a literal IP that is
  // not blocked outright still falls through to `deniedDomains` and the managed
  // allowlist below — spelling the host as an address must not downgrade a
  // documented deny to a prompt.
  const literal = isIP(normalized) !== 0;
  if (literal) {
    const reason = blockedAddressReason(normalized);
    if (reason) return { denied: true, reason };
  }

  const deniedDomain = options.deniedDomains.find(domain => matchesDomain(normalized, domain));
  if (deniedDomain) {
    return { denied: true, reason: `${normalized} is denied by sandbox.network.deniedDomains (${deniedDomain})` };
  }

  if (options.managedAllowlist !== undefined
    && !options.managedAllowlist.some(domain => matchesDomain(normalized, domain))) {
    return { denied: true, reason: `${normalized} is outside the managed domain allowlist` };
  }

  // Nothing to resolve for a literal address; clause 4 is for names.
  if (literal) return ALLOWED;

  let addresses: string[];
  try {
    addresses = await options.resolve(normalized);
  } catch (error) {
    return {
      denied: true,
      reason: `${normalized} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (addresses.length === 0) {
    return { denied: true, reason: `${normalized} resolved to no addresses` };
  }
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) return { denied: true, reason: `${normalized} resolves to a blocked address: ${reason}` };
  }
  return ALLOWED;
}
