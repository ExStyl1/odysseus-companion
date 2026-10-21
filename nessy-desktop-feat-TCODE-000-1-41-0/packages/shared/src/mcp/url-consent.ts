import type { AskUserUrlConsent, AskUserUrlConsentWarning } from '@nessy-agent/core/types';

/**
 * The display half of URL-mode elicitation consent.
 *
 * `elicitation.md:726` is the MUST this module never touches: "**MUST** show the
 * full URL to the user for examination before consent." The two SHOULDs beside
 * it are what this module computes:
 *
 * - `:729` "**SHOULD** highlight the domain of the URL to mitigate subdomain
 *   spoofing."
 * - `:730` "**SHOULD** have warnings for ambiguous/suspicious URIs (i.e.,
 *   containing Punycode)."
 *
 * The URL comes from the MCP server and the user is being asked to visit it and
 * probably authenticate, so a plain full-URL display makes a homograph domain
 * and a `legit.example.com.attacker.net` subdomain suffix indistinguishable from
 * the real thing. The highlight names the party the browser will actually talk
 * to; the warnings name the three ways that party can be disguised.
 *
 * NONE of this is an authorization decision. Nothing here blocks, and nothing
 * here is an allowlist — the user still decides, with the full URL in front of
 * them. That is deliberate: a heuristic that silently refused would be wrong on
 * legitimate internationalized domains, and a heuristic that silently allowed
 * would be a rule the user never got to see.
 */

/**
 * Two-level public suffixes common enough that treating the last two labels as
 * the registrable domain would highlight the wrong thing (`co.uk` rather than
 * `example.co.uk`).
 *
 * Deliberately a SHORT bounded list and not the Public Suffix List: this value
 * is a display emphasis, never an authorization input, so being wrong on an
 * exotic suffix costs a less-useful highlight and nothing else. The full URL is
 * always shown beside it.
 */
const TWO_LEVEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'org.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.ar', 'com.sg', 'com.hk',
  'co.in', 'co.kr', 'co.nz', 'co.za', 'co.il',
]);

/**
 * Labels that spell a whole domain when they appear INSIDE a host rather than
 * at its end. `legit.example.com.attacker.net` carries `com` in an interior
 * position, which is the shape of a suffix lookalike: everything the user
 * recognises is a label the attacker chose, and the party actually contacted is
 * the registrable domain at the end.
 *
 * A token list rather than a brand list on purpose — a brand list only ever
 * catches the brands somebody remembered to add, and this shape is what makes
 * the attack work regardless of which brand is being imitated.
 */
const INTERIOR_DOMAIN_TOKENS: ReadonlySet<string> = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'ru', 'de', 'uk',
]);

/** Scripts a single label may not mix; the classic homograph construction. */
const SCRIPT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'Latin', pattern: /[A-Za-zÀ-ɏ]/ },
  { name: 'Cyrillic', pattern: /[Ѐ-ӿ]/ },
  { name: 'Greek', pattern: /[Ͱ-Ͽ]/ },
];

const PUNYCODE_LABEL_PREFIX = 'xn--';

/**
 * A dotted-quad or a bracketed IPv6 literal, as `URL.hostname` spells them. An
 * address has no registrable domain to highlight, and it is already the least
 * ambiguous thing a URL can name, so the card falls back to showing the host.
 */
const IP_LITERAL_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\])$/;

/**
 * The registrable domain — the last label plus the label that owns it, with the
 * short two-level-suffix list applied. `undefined` for an IP literal, which has
 * no registrable domain and is already unambiguous.
 */
export function registrableDomain(host: string): string | undefined {
  if (IP_LITERAL_HOST.test(host)) return undefined;
  const labels = host.split('.').filter(label => label.length > 0);
  if (labels.length < 2) return host || undefined;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LEVEL_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Decode the Punycode labels of a host back to the characters they render as.
 *
 * `URL` already holds the ASCII (`xn--`) form; `Intl` is not a decoder, so this
 * is the standard RFC 3492 decode over each `xn--` label. A label that does not
 * decode is left as-is — a warning with a partially decoded host still tells
 * the user more than no warning at all.
 */
export function decodePunycodeHost(host: string): string {
  return host
    .split('.')
    .map(label => (label.toLowerCase().startsWith(PUNYCODE_LABEL_PREFIX)
      ? decodePunycodeLabel(label.slice(PUNYCODE_LABEL_PREFIX.length)) ?? label
      : label))
    .join('.');
}

/** RFC 3492 decode of one label body (everything after `xn--`). */
function decodePunycodeLabel(encoded: string): string | null {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const skew = 38;
  const damp = 700;
  const initialBias = 72;
  const initialN = 128;

  const delimiter = encoded.lastIndexOf('-');
  const output: number[] = [];
  for (let index = 0; index < delimiter; index += 1) {
    const code = encoded.charCodeAt(index);
    if (code >= 0x80) return null;
    output.push(code);
  }

  let n = initialN;
  let bias = initialBias;
  let i = 0;
  let index = delimiter < 0 ? 0 : delimiter + 1;

  while (index < encoded.length) {
    const previousI = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (index >= encoded.length) return null;
      const digit = punycodeDigit(encoded.charCodeAt(index));
      index += 1;
      if (digit === null || digit > (Number.MAX_SAFE_INTEGER - i) / w) return null;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const outputLength = output.length + 1;
    bias = adaptBias(i - previousI, outputLength, previousI === 0, { base, tMin, tMax, skew, damp });
    n += Math.floor(i / outputLength);
    i %= outputLength;
    if (n > 0x10ffff) return null;
    output.splice(i, 0, n);
    i += 1;
  }

  try {
    return String.fromCodePoint(...output);
  } catch {
    return null;
  }
}

function punycodeDigit(code: number): number | null {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  return null;
}

function adaptBias(
  delta: number,
  numPoints: number,
  firstTime: boolean,
  constants: { base: number; tMin: number; tMax: number; skew: number; damp: number },
): number {
  const { base, tMin, tMax, skew, damp } = constants;
  let scaled = firstTime ? Math.floor(delta / damp) : delta >> 1;
  scaled += Math.floor(scaled / numPoints);
  let k = 0;
  while (scaled > ((base - tMin) * tMax) >> 1) {
    scaled = Math.floor(scaled / (base - tMin));
    k += base;
  }
  return k + Math.floor(((base - tMin + 1) * scaled) / (scaled + skew));
}

/** Every script from {@link SCRIPT_PATTERNS} present in one label. */
function scriptsInLabel(label: string): string[] {
  return SCRIPT_PATTERNS.filter(script => script.pattern.test(label)).map(script => script.name);
}

/**
 * The deceptive-host rule set. FOUR rules, each of which can be explained to a
 * user in one sentence, because a warning nobody understands is dismissed:
 *
 * 1. `punycode` — a label is stored as `xn--…`, so what the user reads is not
 *    what the address says. The decoded host is shown beside the warning.
 * 2. `mixed-script` — one label mixes Latin with Cyrillic or Greek letters,
 *    which is how `аpple.com` is written with a Cyrillic `а`.
 * 3. `lookalike-suffix` — the host carries a whole domain name as an interior
 *    label, so the familiar part is decoration and the real site is the tail.
 * 4. `embedded-credentials` — a `user@` before the host pushes the real host
 *    off the start of the address, where a reader stops looking.
 */
function hostWarnings(host: string, hasCredentials: boolean): AskUserUrlConsentWarning[] {
  const warnings: AskUserUrlConsentWarning[] = [];
  const labels = host.split('.').filter(label => label.length > 0);

  if (labels.some(label => label.toLowerCase().startsWith(PUNYCODE_LABEL_PREFIX))) {
    warnings.push({ kind: 'punycode' });
  }

  const decoded = decodePunycodeHost(host);
  const mixed = decoded
    .split('.')
    .map(label => scriptsInLabel(label))
    .find(scripts => scripts.length > 1);
  if (mixed) {
    warnings.push({ kind: 'mixed-script', detail: mixed.join(' + ') });
  }

  // Interior label only: the LAST label is the real TLD and the one before it is
  // the registrable name, so neither can be "a whole domain hiding inside".
  const interior = labels.slice(0, -2).find(label => INTERIOR_DOMAIN_TOKENS.has(label.toLowerCase()));
  if (interior) {
    warnings.push({ kind: 'lookalike-suffix' });
  }

  if (hasCredentials) {
    warnings.push({ kind: 'embedded-credentials' });
  }

  return warnings;
}

/**
 * Build the consent panel for one URL-mode elicitation.
 *
 * `url` is expected to already have passed the module's http(s) gate; a value
 * this cannot parse returns `undefined` and the caller keeps its plain-text
 * presentation, which still satisfies the full-URL MUST.
 */
export function analyzeConsentUrl(url: string): AskUserUrlConsent | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname;
  const hasCredentials = parsed.username !== '' || parsed.password !== '';
  const decodedHost = decodePunycodeHost(host);
  const domain = registrableDomain(host);
  return {
    url: parsed.href,
    host,
    ...(domain ? { registrableDomain: domain } : {}),
    ...(decodedHost !== host ? { decodedHost } : {}),
    warnings: hostWarnings(host, hasCredentials),
  };
}
