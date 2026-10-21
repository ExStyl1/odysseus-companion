/**
 * The archive-download URL safety guard, shared by the marketplace catalog
 * classifier (`marketplace/external-catalog-adapters.ts`) and the downloader
 * (`plugins/acquisition.ts`) so the `url` field, a bare string source, and every
 * redirect hop are all held to ONE rule.
 *
 * `plugin-marketplaces.md` § Zip archives, `url` field (fetched 2026-08-24,
 * `https://code.claude.com/docs/en/plugin-marketplaces.md`, page 150 of
 * `scripts/claude-doc-pages.tsv`):
 *
 *   "Required. HTTPS URL of the zip archive. Claude Code rejects `http://` URLs,
 *    along with loopback, link-local, and cloud-metadata hosts. Every redirect
 *    hop must satisfy the same rules, or Claude Code refuses the download"
 *
 * RFC1918 ranges are deliberately NOT refused: the same section names "an
 * Artifactory generic repository" as a host to publish on, which is an intranet
 * address for most of the people who would run one.
 */
export function archiveUrlRefusalReason(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'the URL is unparseable';
  }
  if (parsed.protocol !== 'https:') {
    return `the scheme "${parsed.protocol.replace(/:$/, '')}" is not https`;
  }
  // An IPv6 literal arrives bracketed from `URL.hostname`.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'the host is loopback';
  if (CLOUD_METADATA_HOSTS.has(host)) return 'the host is a cloud metadata endpoint';
  if (isLoopbackOrLinkLocalAddress(host)) return 'the host is a loopback or link-local address';
  return undefined;
}

/** Hostname forms of the cloud metadata endpoints; their IP forms are link-local. */
const CLOUD_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
]);

function isLoopbackOrLinkLocalAddress(host: string): boolean {
  const octets = ipv4OctetsOf(host);
  if (octets) {
    // 127.0.0.0/8 loopback, 0.0.0.0/8 "this host", 169.254.0.0/16 link-local
    // (which is where 169.254.169.254, the AWS/Azure/GCP metadata IP, lives).
    return octets[0] === 127 || octets[0] === 0 || (octets[0] === 169 && octets[1] === 254);
  }
  if (host === '::1' || host === '::') return true;
  // fe80::/10 link-local spans fe80: through febf:.
  return /^fe[89ab][0-9a-f]*:/.test(host);
}

/**
 * The four octets of a dotted quad, INCLUDING the IPv4-mapped IPv6 spelling
 * `URL.hostname` actually hands back: it rewrites `::ffff:169.254.169.254` to
 * the hex `::ffff:a9fe:a9fe`, so a check that only read the dotted form would
 * miss every mapped literal. The obfuscated dotted forms need no handling here
 * — WHATWG parsing already normalizes `0x7f.0.0.1` and `2130706433` to
 * `127.0.0.1` before this sees them.
 */
function ipv4OctetsOf(host: string): [number, number, number, number] | undefined {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    return octets.every(octet => octet <= 255)
      ? [octets[0]!, octets[1]!, octets[2]!, octets[3]!]
      : undefined;
  }
  const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return undefined;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}
