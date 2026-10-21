/**
 * UA1.17 — the publish guard: which file may leave this machine as a
 * t-artifacts page, read exactly ONCE, scanned before any card is raised.
 *
 * Every caller of the publishing chain (UA1.18 `publish_artifact`, UA1.23 the
 * preview's Publish, UA6.7 Pages, and — through {@link scanArtifactText} —
 * UA1.24's chat snapshot) goes through here. The order is the contract; every
 * step answers BEFORE the file's bytes are read:
 *
 * 1. **Always refused — the credential read floor, derived, never hand-listed.**
 *    The path as given (`~` expanded on the floor's own latched home), then
 *    every symlink hop, then the `realpath`, are matched through
 *    `agent/mode-manager.ts` symbol `getAttachmentReadFloorViolation` — the
 *    exported face of the same `getDeniedPathViolation` matcher `Read` meets —
 *    against the SHIPPED `SAFE_MODE_CONFIG.deniedPaths` (so a user who edits
 *    `**\/.env` out of their own `default.json` cannot open it here) and, when
 *    a permissions context is given, the merged workspace config as well. That
 *    list already carries `**\/.env`, `**\/.env.*` and the artifacts registry
 *    (UA1.16); `publish-guard.test.ts` asserts the derivation by planting a
 *    pattern in the constant.
 * 2. **The read floor:** the realpath must sit inside the session cwd, an
 *    accepted added root or the session directory. Containment is
 *    `workspaces/paths.ts` symbol `isPathWithin` (lexical, then realpath on both
 *    sides) — the same contract as `session-tools-core`'s
 *    `runtime/path-security.ts` `isPathWithinDirectory` the plan cites, which
 *    that package does not export (its `exports` map is `"."` alone).
 * 3. `.html`, `.htm` or `.md` only (`normalize.ts` `artifactContentTypeOf`), a
 *    regular file (opened `O_NONBLOCK | O_NOFOLLOW`, so a FIFO cannot hang the
 *    host and a swapped-in link cannot be followed), at most
 *    {@link GUARD_READ_CAP_BYTES}.
 *
 * Then the single read: ONE buffer, decoded as strict UTF-8 once, hashed once
 * (sha256). Normalise, scan, preview and send all use that buffer; UA1.18
 * re-hashes the file after the card and sends nothing when it changed.
 *
 * ## The scan (O6, waves.md 2026-10-02)
 *
 * `jwt`, `ory-token` and `bearer` — the three rules the plan once wrote LOCAL
 * here — have lived in the SHARED table since F1.365 (`2a5f5833e`,
 * `agent/tool-result-secret-scan.ts` symbol `credentialTransportRules`,
 * byte-identical regexes). So the guard calls `scanToolResultForSecrets` for the
 * whole shared table and keeps two blocking rules local: `pan` — 13–19 digits
 * with optional single space/dash separators, Luhn-valid, and (DECIDED here,
 * transparent and simple) a first digit of 2–6: ISO/IEC 7812's banking and
 * financial ranges (Mir 220x, Mastercard 2/5, Amex/JCB 3, Visa 4, Maestro and
 * UnionPay 6). Without that filter one Luhn-valid 13-digit epoch-milliseconds
 * timestamp in ten would refuse a dashboard page. Every window of a digit run
 * that starts and ends on a group boundary (a separator or the run's edge) AND
 * whose groups have a card layout — one contiguous 13–19 group, fours with a
 * last group of 1–4, or Amex/Diners 4-6-5 / 4-6-4 — is tried, so a card followed
 * by its expiry or CVV (`<pan> 12/28`, `<pan> 123`) or preceded by a row number
 * is found (UA1.17 follow-ups). The layout filter is the trade: without it a
 * comma-less SVG `points` list or a row of 3-digit figures formed Luhn-valid
 * windows (about 4 polylines in 5 refused, measured 2026-10-02). Residue,
 * stated: an airline (UATP, first digit 1) card is not recognised; a card
 * written in another grouping (e.g. 6-13, or 4-digit groups split unevenly) is
 * not recognised; a run of 4-digit numbers starting with 2–6 (years 20xx) can
 * still form a 4-4-4-4 window — six years in a sentence are refused about one
 * time in five (measured 2026-10-02); and a card number glued to further
 * digits with NO separator is not split out of its contiguous group — trying
 * every prefix of a long id would refuse about one such id in two.
 * {@link PUBLISH_GUARD_BLOCKING_RULES} is the composition, and a test pins it
 * as "shared rules + pan + sensitive-key" so the two tables cannot drift.
 *
 * E-mail addresses and phone numbers are COUNTED for the card, never blocking.
 * The key-name scan (UA12.9, narrowed by UA12.175) refuses a VALUE assigned
 * to a KEY whose head noun is a credential word ({@link isCredentialKeyName} —
 * guard-local on purpose: `utils/redaction.ts` `isSensitiveKeyName` is the
 * redactors' deliberately-broad substring heuristic, right for scrubbing a
 * diagnostic and wrong for a hard refusal, since it refused `Author:`,
 * `"key"`, `dataKey` and `- Tokens: 12000`), read at KEY POSITIONS only (a
 * line start after an optional list marker, or right after `{`/`,`/`>`),
 * never over bare prose. It applies to pages and files ONLY: chat share calls
 * {@link scanArtifactText} with `sensitiveKeys: false`, because a chat's
 * secrets are MASKED, never refused (OQ-22(e), `share-snapshot.ts` header)
 * and the mask has no key-name pass. Residue, stated: a chat that carries
 * `DB_PASSWORD=…` sends that value (as it did before UA12.9) unless its shape
 * is in the shared token table. The rule's own residues are stated at
 * {@link SENSITIVE_KEY_VALUE}.
 *
 * A refusal names the rule and the LINE, never the value. The card's sentence
 * is fixed ({@link PUBLISH_SCAN_SENTENCE}) — never "0 findings": a clean scan
 * proves only that no KNOWN token format was seen.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { getAttachmentReadFloorViolation } from '../agent/mode-manager.ts';
import { floorHomeDir } from '../agent/mode-manager-home.ts';
import type { PermissionsContext } from '../agent/permissions-config.ts';
import { TOOL_RESULT_SECRET_RULE_NAMES, scanToolResultForSecrets } from '../agent/tool-result-secret-scan.ts';
import { isPathWithin } from '../workspaces/paths.ts';
import { artifactContentTypeOf } from './normalize.ts';
import { MAX_ARTIFACT_CONTENT_BYTES, type ArtifactContentType } from './t-artifacts-client.ts';

/** The card's fixed sentence after a clean scan (plan UA1.17). Never "0 findings". */
export const PUBLISH_SCAN_SENTENCE =
  'Automatic check found no known token formats; it does not detect encoded or free-form secrets or client data.';

/** The blocking rules that are local to this guard, in reporting order. */
export const PUBLISH_GUARD_LOCAL_RULES: readonly string[] = Object.freeze(['pan', 'sensitive-key']);

/** Every blocking rule, in reporting order: the shared tool-result table, then the local ones. */
export const PUBLISH_GUARD_BLOCKING_RULES: readonly string[] =
  Object.freeze([...TOOL_RESULT_SECRET_RULE_NAMES, ...PUBLISH_GUARD_LOCAL_RULES]);

/**
 * The most the guard reads. Normalisation only REMOVES bytes (frame tags, the
 * lifted title), so a raw file over twice the service's 16 MiB cap can never
 * fit; reading it would only cost memory.
 */
export const GUARD_READ_CAP_BYTES = 2 * MAX_ARTIFACT_CONTENT_BYTES;

const MAX_SYMLINK_HOPS = 40;

export type PublishGuardRefusalKind =
  | 'denied-path'
  | 'outside-roots'
  | 'not-found'
  | 'not-a-file'
  | 'unsupported-type'
  | 'too-large'
  | 'not-text'
  | 'secret';

export interface PublishGuardRefusal {
  ok: false;
  kind: PublishGuardRefusalKind;
  /** A sentence the model can act on. Never quotes file content. */
  message: string;
  /** `secret` only: the rule that fired first (by position). */
  rule?: string;
  /** `secret` only: 1-based line of that first finding. */
  line?: number;
  /** `denied-path` only: the deniedPaths pattern that matched. */
  pattern?: string;
}

export interface PublishGuardPass {
  ok: true;
  /** The realpath that was read. */
  realPath: string;
  contentType: ArtifactContentType;
  /** THE buffer — the only read of the file. */
  buffer: Buffer;
  /** `buffer` decoded once as strict UTF-8. */
  text: string;
  /** sha256 hex of `buffer`. */
  sha256: string;
  byteLength: number;
  /** Non-blocking counts for the card. */
  counts: { emails: number; phones: number };
  scanSentence: typeof PUBLISH_SCAN_SENTENCE;
}

export type PublishGuardResult = PublishGuardPass | PublishGuardRefusal;

export interface PublishGuardInput {
  /** As the caller named it: absolute, `~/…`, or relative to `sessionCwd`. */
  filePath: string;
  sessionCwd: string;
  /** The session's own directory (attachments, plans, generated pages). */
  sessionDir?: string;
  /** Directories the user accepted for this session. */
  addedRoots?: readonly string[];
  /** The workspace's permissions; its merged `deniedPaths` apply on top of the shipped floor. */
  permissionsContext?: PermissionsContext | null;
}

export function sha256Hex(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// The scan — exported for the guard and for UA1.24's snapshot masking
// ---------------------------------------------------------------------------

export interface PanFinding {
  index: number;
  length: number;
}

/** A maximal run of digits joined by single space/dash separators. */
const DIGIT_RUN = /(?<!\d)\d(?:[ -]?\d)*(?!\d)/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * A window's group lengths form a card layout: one contiguous group of 13–19,
 * fours with a last group of 1–4 (4-4-4-4, 4-4-4-4-3, …), or the Amex/Diners
 * 4-6-5 / 4-6-4. A separated run of short numbers (chart data) never does.
 */
function isCardLayout(lengths: number[]): boolean {
  if (lengths.length === 1) return true; // the 13–19 total is checked by the caller
  const last = lengths[lengths.length - 1]!;
  if (lengths.slice(0, -1).every((length) => length === 4) && last >= 1 && last <= 4) return true;
  return lengths.length === 3 && lengths[0] === 4 && lengths[1] === 6 && (last === 5 || last === 4);
}

/**
 * Luhn-valid 13–19 digit windows whose first digit is 2–6 (see the header for
 * why). Inside each digit run every window starting and ending on a group
 * boundary AND in a card layout ({@link isCardLayout}) is tried, shortest
 * first; a hit consumes its groups, so findings do not overlap.
 */
export function findLuhnPans(text: string): PanFinding[] {
  const findings: PanFinding[] = [];
  for (const match of text.matchAll(DIGIT_RUN)) {
    const groups: Array<{ offset: number; digits: string }> = [];
    let offset = 0;
    for (const digits of match[0].split(/[ -]/)) {
      groups.push({ offset, digits });
      offset += digits.length + 1;
    }
    let start = 0;
    while (start < groups.length) {
      const first = groups[start]!;
      let end = -1;
      if (first.digits[0]! >= '2' && first.digits[0]! <= '6') {
        let digits = '';
        const lengths: number[] = [];
        for (let e = start; e < groups.length; e += 1) {
          digits += groups[e]!.digits;
          lengths.push(groups[e]!.digits.length);
          if (digits.length > 19) break;
          if (digits.length >= 13 && isCardLayout(lengths) && luhnValid(digits)) { end = e; break; }
        }
      }
      if (end < 0) { start += 1; continue; }
      const last = groups[end]!;
      findings.push({ index: match.index! + first.offset, length: last.offset + last.digits.length - first.offset });
      start = end + 1;
    }
  }
  return findings;
}

/**
 * The local part is bounded at RFC 5321's 64 octets: unbounded (`+@`) it re-scanned a whole unbroken run from every
 * start position, so a long base64url/hex run scanned in quadratic time on the host's event loop (UA1.17 follow-up).
 * Only the COUNT is read, and an over-long local part still counts once (the match starts 64 characters before `@`).
 */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** International `+` form (10–15 digits), or the Russian domestic `8 (xxx) xxx-xx-xx` with separators. */
const PHONE = /(?<![\w+])(?:\+\d[\d\s().-]{8,20}\d|8[\s(-]+\d{3}[\s)-]+\d{3}[\s-]?\d{2}[\s-]?\d{2})(?![\w])/g;

function countPhones(text: string): number {
  let count = 0;
  for (const match of text.matchAll(PHONE)) {
    const digits = match[0].replace(/\D/g, '').length;
    if (digits >= 10 && digits <= 15) count += 1;
  }
  return count;
}

/**
 * UA12.9 — a VALUE assigned to a credential-shaped KEY: the key must satisfy
 * {@link isCredentialKeyName} (UA12.175: a credential WORD as the key's head
 * noun, never a substring) and a key position must precede it — the start
 * of a line (after a `- `/`* `/`+ ` list marker), or right after `{`/`,`/`>`
 * (a JSON mapping member, and text just inside an HTML tag). The separator is
 * `:` or `=`; the value is an explicit quoted string (one character or more)
 * or a bare token of four or more characters that is not a container — the
 * length floor is the same four `tool-result-secret-scan.ts` symbol
 * `KNOWN_VALUE_MIN_LENGTH` takes (one to three characters identify nothing);
 * the container exclusion keeps a JSON array or object value
 * (`"passwords": [3, 1, 4]`) out. Stated
 * residue: a pipe-table row (`| password | hunter2 |`), an HTML attribute
 * (`<input type="password" value="…">`), a markdown-emphasised key
 * (`**password:** …`), a pair preceded by plain text on the same line, and a
 * 1–3 character value are not found; a key with a URL or other prose-shaped
 * value IS refused (rename the key or drop the value). A value that is an
 * environment or template REFERENCE (`process.env.X`, `import.meta.env.X`,
 * `os.environ…`, `os.getenv(…)`, `${…}`, `$VAR`, `{{…}}`) names where a secret
 * lives, not the secret, and passes. A value that is never a secret passes too
 * ({@link isNonSecretValue}, UA12.175 follow-up): a bare literal or type name
 * (`true`, `false`, `null`, `undefined`, `None`, `nil`, `string`, `number`,
 * `boolean`, `str`, with trailing `,;)}]` dropped), a whole `<…>` placeholder
 * (read to the line's end, since a bare value stops at a space),
 * a run of only `*` or `•`, a `YOUR_…`/`your-…` placeholder, and a `Bearer` or
 * `Basic` scheme word whose credential is one of those, a reference, or absent.
 * Residue, stated: a bare code identifier as the value (`token: sessionToken`,
 * `{ Authorization: authHeader }`) and a prose word of four or more characters
 * (`- Token: required`) are still refused. The shared token table still refuses
 * a value with a known token shape regardless of its key.
 */
const SENSITIVE_KEY_VALUE =
  /(?:^|(?<=[{,>]))[ \t]*(?:[-*+] )?(?:"([^"\n]{1,128})"|'([^'\n]{1,128})'|([A-Za-z0-9_.@-]{1,128}))[ \t]*[:=][ \t]*(?:"([^"\n]+)"|'([^'\n]+)'|(?![{[(])([^\s"']{4,}))/gm;

/** The credential words a key may END in (its head noun), lower case. */
const CREDENTIAL_HEAD_WORDS: ReadonlySet<string> = new Set([
  'password', 'passwd', 'passphrase', 'secret', 'token', 'cookie', 'credential', 'credentials',
  'authorization', 'bearer', 'apikey',
]);

/** Two-word credential heads (the key's last two segments), joined by a space. */
const CREDENTIAL_HEAD_PAIRS: ReadonlySet<string> = new Set([
  'api key', 'access key', 'private key', 'secret key',
]);

/**
 * UA12.175 — DECIDED here (transparent and simple): a key is credential-shaped
 * when its LAST segment (the head noun of the compound) is a credential word,
 * or its last two segments are a two-word credential head. Segments split on
 * camelCase, `_`, `-`, `.`, `@` and spaces. So `password`, `DB_PASSWORD`,
 * `access_token`, `apiKey`, `x-api-key`, `AWS_SECRET_ACCESS_KEY`,
 * `clientSecret`, `Authorization`, `Cookie` are; `key`, `auth`, `author`,
 * `Authentication`, `Keywords`, `dataKey`, `Tokens`, `max_tokens`,
 * `tokenCount`, `Tokenizer`, `auth.login`, `monkey` and `passwordHint` are not.
 * Residue, stated: a plural head (`passwords`, `tokens`, `secrets`) is not
 * a credential word — it names a collection or a count far more often; `pwd`
 * is left out (it is the working-directory variable `PWD` far more often);
 * a credential word that is not the head (`password_hash`) is not found.
 */
export function isCredentialKeyName(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.@-]+/)
    .filter(segment => segment.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined) return false;
  if (CREDENTIAL_HEAD_WORDS.has(last)) return true;
  return segments.length >= 2 && CREDENTIAL_HEAD_PAIRS.has(`${segments[segments.length - 2]} ${last}`);
}

/** A value that REFERENCES where a secret lives (an env or template lookup) rather than holding one. */
const SECRET_REFERENCE_VALUE = /^(?:process\.env\.|import\.meta\.env\.|os\.environ\b|os\.getenv\(|\$\{|\$[A-Za-z_]|\{\{)/;

/** A bare value that is a literal or a type name, never a secret (UA12.175 follow-up). */
const NON_SECRET_BARE_VALUE = /^(?:true|false|null|undefined|none|nil|string|number|boolean|str)$/i;
/** A whole placeholder or mask: `<…>`, a run of only `*`/`•`, `YOUR_…`/`your-…`. */
const PLACEHOLDER_VALUE = /^(?:<[^<>\n]*>|[*•]+|your[_-]\S*)$/i;
/** An HTTP auth scheme word; the credential is what follows it. */
const AUTH_SCHEME_WORD = /^(?:bearer|basic)$/i;

/** UA12.175 follow-up — a value that names no secret: a reference, a placeholder, a mask, or (bare) a literal or type name. */
function isNonSecretValue(raw: string, bare: boolean): boolean {
  const value = bare ? raw.replace(/[\s,;)}\]]+$/, '') : raw;
  if (SECRET_REFERENCE_VALUE.test(value) || PLACEHOLDER_VALUE.test(value)) return true;
  return bare && NON_SECRET_BARE_VALUE.test(value);
}

function findSensitiveKeyValues(text: string): Array<{ index: number }> {
  const findings: Array<{ index: number }> = [];
  for (const match of text.matchAll(SENSITIVE_KEY_VALUE)) {
    if (!isCredentialKeyName(match[1] ?? match[2] ?? match[3] ?? '')) continue;
    const quoted = match[4] ?? match[5];
    // A bare value stops at a space; one that opens a `<…>` placeholder runs to the line's end (`<your password>`).
    const end = match.index! + match[0].length;
    const newline = text.indexOf('\n', end);
    const rest = text.slice(end, newline === -1 ? text.length : newline);
    const bare = match[6]?.startsWith('<') ? `${match[6]}${rest}`.trimEnd() : match[6];
    if (bare !== undefined && AUTH_SCHEME_WORD.test(bare)) {
      // `Authorization: Bearer <cred>` — the credential is the rest of the line after the scheme word.
      const credential = rest.trim();
      if (credential === '' || isNonSecretValue(credential, true)) continue;
    } else if (quoted !== undefined) {
      const credential = /^(?:bearer|basic)\s+(.+)$/i.exec(quoted)?.[1] ?? quoted;
      if (isNonSecretValue(credential, false)) continue;
    } else if (isNonSecretValue(bare ?? '', true)) {
      continue;
    }
    findings.push({ index: match.index! });
  }
  return findings;
}

/** Options of {@link scanArtifactText}. */
export interface ArtifactTextScanOptions {
  /**
   * The key-name rule (`sensitive-key`, UA12.9/UA12.175); default on. Chat
   * share passes `false` (its secrets are masked, never refused). It is left
   * out INSIDE the scan, never filtered afterwards: the blocking finding is
   * the first by position, so dropping a `sensitive-key` result after the
   * fact would hide a later jwt/bearer/pan finding.
   */
  sensitiveKeys?: boolean;
}

export interface ArtifactTextScan {
  /** The first blocking finding by position, or `null`. Carries no matched bytes. */
  blocking: { rule: string; line: number; total: number } | null;
  emails: number;
  phones: number;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * The shared table (via `scanToolResultForSecrets`) plus `pan` and (unless
 * `options.sensitiveKeys` is `false`) the key-name scan. The first shared finding is located WITHOUT re-matching: the
 * scanner replaces each match with a marker, so the scanned text equals the
 * input up to the first match and diverges there.
 */
export function scanArtifactText(text: string, options: ArtifactTextScanOptions = {}): ArtifactTextScan {
  const shared = scanToolResultForSecrets(text);
  const candidates: Array<{ rule: string; index: number }> = [];
  let total = 0;
  if (shared.counts.length > 0) {
    let index = 0;
    while (index < text.length && index < shared.text.length && text.charCodeAt(index) === shared.text.charCodeAt(index)) index += 1;
    const marker = /^\[REDACTED:([^\]]+)\]/.exec(shared.text.slice(index));
    candidates.push({ rule: marker?.[1] ?? shared.counts[0]!.rule, index });
    total += shared.counts.reduce((sum, entry) => sum + entry.count, 0);
  }
  const pans = findLuhnPans(text);
  if (pans.length > 0) {
    candidates.push({ rule: 'pan', index: pans[0]!.index });
    total += pans.length;
  }
  const keys = options.sensitiveKeys === false ? [] : findSensitiveKeyValues(text);
  if (keys.length > 0) {
    candidates.push({ rule: 'sensitive-key', index: keys[0]!.index });
    total += keys.length;
  }
  candidates.sort((a, b) => a.index - b.index);
  const first = candidates[0];
  return {
    blocking: first ? { rule: first.rule, line: lineAt(text, first.index), total } : null,
    emails: (text.match(EMAIL) ?? []).length,
    phones: countPhones(text),
  };
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

function expandTilde(path: string): string {
  if (path === '~') return floorHomeDir();
  if (path.startsWith('~/')) return resolve(floorHomeDir(), path.slice(2));
  return path;
}

/** The floor's verdict for one candidate: the shipped constant first, then the merged workspace config. */
function floorViolation(path: string, context: PermissionsContext | null | undefined): { path: string; pattern: string } | null {
  return getAttachmentReadFloorViolation(path, null)
    ?? (context ? getAttachmentReadFloorViolation(path, context) : null);
}

/** Every hop of a symlink chain, dangling or not — so a link to a missing credential file is judged by its target too. */
function symlinkHops(path: string): string[] {
  const hops: string[] = [];
  let current = path;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return hops;
    }
    if (!isLink) return hops;
    const target = readlinkSync(current);
    current = isAbsolute(target) ? target : resolve(dirname(current), target);
    hops.push(current);
  }
  return hops;
}

function refuse(kind: PublishGuardRefusalKind, message: string, extra: Partial<PublishGuardRefusal> = {}): PublishGuardRefusal {
  return { ok: false, kind, message, ...extra };
}

function deniedRefusal(path: string, pattern: string): PublishGuardRefusal {
  return refuse('denied-path',
    `${path} is on the credential read floor (deniedPaths pattern ${pattern}), so it is never published and was not read. Publish a page written for the purpose instead.`,
    { pattern });
}

/**
 * The guard. Never throws for a refusal — every refusal is a value with a
 * sentence; an unexpected I/O error after the floor checks surfaces as
 * `not-found` / `not-a-file` with the errno, never with content.
 */
export function guardArtifactFile(input: PublishGuardInput): PublishGuardResult {
  const given = expandTilde(input.filePath.trim());
  const lexical = isAbsolute(given) ? resolve(given) : resolve(input.sessionCwd, given);

  // 1. The floor, on the path as given and on every symlink hop — before any realpath.
  const hops = symlinkHops(lexical);
  for (const candidate of [lexical, ...hops]) {
    const denied = floorViolation(candidate, input.permissionsContext);
    if (denied) return deniedRefusal(input.filePath, denied.pattern);
  }

  // The realpath WITHOUT opening the file: the final component's links are
  // already followed by `symlinkHops` (lstat/readlink only), so only its PARENT
  // is realpathed — macOS realpath(3) opens its argument, and an open of a file
  // that may be outside the roots is exactly what step 2 must precede.
  const final = hops.at(-1) ?? lexical;
  let realPath: string;
  try {
    realPath = resolve(realpathSync.native(dirname(final)), basename(final));
  } catch {
    return refuse('not-found', `${input.filePath} does not exist (resolved against ${input.sessionCwd}). Write the page first, then publish that file.`);
  }
  const deniedReal = floorViolation(realPath, input.permissionsContext);
  if (deniedReal) return deniedRefusal(input.filePath, deniedReal.pattern);

  // 2. The read floor. The FILE is compared by its realpath, so each ROOT is too (UA1.18, found while composing the
  // chain): compared as given, a session folder reached through a symlink (macOS `/tmp`, a linked projects folder)
  // refused every file in it. A root that cannot be resolved is compared as given.
  const roots = [input.sessionCwd, input.sessionDir, ...(input.addedRoots ?? [])]
    .filter((root): root is string => typeof root === 'string' && root.trim() !== '')
    .map(root => {
      try {
        return realpathSync.native(resolve(root));
      } catch {
        return root;
      }
    });
  if (!roots.some(root => isPathWithin(root, realPath))) {
    return refuse('outside-roots',
      `${input.filePath} is outside the session's working folder, its added folders and the session folder, so it was not read. Copy or write the page inside the working folder and publish that file.`);
  }

  // 3. Type, kind of file, size — still before the read.
  const contentType = artifactContentTypeOf(realPath);
  if (!contentType) {
    return refuse('unsupported-type', `Only .html, .htm and .md files can be published; ${input.filePath} is not one. Write the page as HTML or Markdown and publish that file.`);
  }
  let descriptor: number;
  try {
    descriptor = openSync(realPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'EIO';
    if (code === 'ENOENT') {
      return refuse('not-found', `${input.filePath} does not exist (resolved against ${input.sessionCwd}). Write the page first, then publish that file.`);
    }
    return refuse('not-found', `${input.filePath} could not be opened (${code}). Check the file and publish again.`);
  }
  let buffer: Buffer;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      return refuse('not-a-file', `${input.filePath} is not a regular file. Publish an .html or .md file.`);
    }
    if (stat.size > GUARD_READ_CAP_BYTES) {
      return refuse('too-large', `${input.filePath} is ${stat.size} bytes; a page can be at most 16 MiB. Make it smaller and publish again.`);
    }
    // THE read: one buffer, bounded by the cap even if the file grows meanwhile.
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > GUARD_READ_CAP_BYTES) {
        return refuse('too-large', `${input.filePath} grew past 32 MiB while it was being read; a page can be at most 16 MiB.`);
      }
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    buffer = Buffer.concat(chunks, total);
  } finally {
    closeSync(descriptor);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return refuse('not-text', `${input.filePath} is not UTF-8 text, so it cannot be published as a page. Save it as UTF-8 and publish again.`);
  }

  const scan = scanArtifactText(text);
  if (scan.blocking) {
    const others = scan.blocking.total > 1 ? ` (${scan.blocking.total} findings in all)` : '';
    return refuse('secret',
      `${input.filePath} line ${scan.blocking.line} contains what looks like a ${scan.blocking.rule} value${others}, so nothing was published. Remove it or replace it with a placeholder, then publish again.`,
      { rule: scan.blocking.rule, line: scan.blocking.line });
  }

  return {
    ok: true,
    realPath,
    contentType,
    buffer,
    text,
    sha256: sha256Hex(buffer),
    byteLength: buffer.length,
    counts: { emails: scan.emails, phones: scan.phones },
    scanSentence: PUBLISH_SCAN_SENTENCE,
  };
}
