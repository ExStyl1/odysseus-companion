/**
 * F1.366 — the NARROW fallback onto dp's own stored session.
 *
 * OWNER 2026-09-23 ("как запасной вариант можно использовать?" on option 2 of
 * `docs/superpowers/specs/2026-09-23-dp-auth-approach.md`), adopted as a
 * fallback and nothing more: `dp auth print-token` stays the primary path, as
 * in nessy-cli, and this amends the 2026-09-12 target-scheme clause that read
 * the key ONLY through `print-token`. Why it helps: other dp processes (the
 * owner's machine ran 34 `dp ai mcp` servers) keep dp's session fresh while
 * OUR spawn of dp can fail, and the gateway JWT one exchange mints lives two
 * years, so one success lasts. It does NOT help a never-logged-in or expired
 * session — `dp auth login` still covers that.
 *
 * THE RULES, each pinned by `__tests__/dp-session-file.test.ts`:
 *
 * 1. Only after the print-token path failed with a NON-login code —
 *    {@link STORED_SESSION_FALLBACK_CODES}. Needs-login, a refused login, a
 *    cancel and a failed exchange never reach this module.
 * 2. READ-ONLY. One `readFileSync`: never a refresh, never a write, never a
 *    lock file. Hydra-style refresh-token rotation (not measured on this IAM)
 *    would log dp out and break every `dp ai mcp` server if we ever refreshed.
 * 3. Only the access token of an entry whose `subject.type` is `user`; service
 *    accounts are skipped. The refresh token and every other field are dropped
 *    as soon as the file is validated — the result carries the access token and
 *    its expiry, nothing else. `subject.type` and not the entry's own `type`:
 *    the only writer of this file outside dp we can read, nessy-cli's container
 *    script (`deploy/async/entrypoint.sh` at `11b095a7d`, which writes it "for
 *    DP CLI compatibility"), puts `"type": "bearer"` on the entry and
 *    `"type": "user"` on its `subject`.
 * 4. STRICT shape: `{ tokens: [...] }` and nothing else at the top; every entry
 *    carries exactly the seven keys the research measured stable from 13.27.0
 *    to 13.60.0, with string values, RFC 3339 timestamps (the entrypoint's
 *    format) and a `subject` of exactly `id`/`type`/`name`. There is no schema
 *    version, so any drift declines the file — the ordinary error stands and the
 *    diagnostic names the reason, never a value.
 * 5. The access token must be valid for at least five more minutes
 *    ({@link STORED_SESSION_MIN_VALIDITY_MS}); a torn read (a JSON parse failure
 *    — whether dp writes the file atomically is unmeasured) retries ONCE.
 * 6. The user SEES it: the facade emits `dp-session-file` before the one
 *    exchange, and no token value is ever logged.
 *
 * Entry choice when several `user` entries exist: the most recently created one
 * — the research inferred dp's own `LoadLatestToken` from its name only, so
 * this is a read of the name, stated as such.
 */

import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { latchedHomeDir } from '../../config/home-latch.ts';
import { createLogger } from '../../utils/debug.ts';
import { DpAuthError, DpAuthServiceError } from './errors.ts';
import { exchangeDpToken } from './exchange.ts';

const log = createLogger('dp-auth');

export const DP_SESSION_FILE_NAME = 'access_token.json';

/** Rule 5 — how long the stored access token must still be valid. */
export const STORED_SESSION_MIN_VALIDITY_MS = 5 * 60_000;

/** Rule 1 — the print-token failures that open the fallback, and no others. */
export const STORED_SESSION_FALLBACK_CODES: ReadonlySet<DpAuthError> = new Set([
  DpAuthError.DpNotFound,
  DpAuthError.ExecFailed,
  DpAuthError.Timeout,
]);

/** Why a stored session was not used. Value-free by construction. */
export type StoredDpSessionUnusable = 'absent' | 'unreadable' | 'shape' | 'no-user-entry' | 'expiring';

export type StoredDpSessionRead =
  | { ok: true; token: string; expiresAtMs: number }
  | { ok: false; reason: StoredDpSessionUnusable };

export interface ReadStoredDpSessionOptions {
  now?: () => number;
  /** Test seam: the one read. Production reads the file with `readFileSync`. */
  readFile?: (path: string) => string;
  /** Test seam: the pause before the one retry of a torn read. */
  retryDelayMs?: number;
}

/**
 * The facade's test seam: where the file is and how it is read. Production
 * passes nothing and reads {@link defaultDpSessionFilePath}.
 */
export interface StoredDpSessionSeam {
  path?: string;
  readFile?: (path: string) => string;
}

/**
 * dp's session file: `$DP_WORKDIR/access_token.json` when `DP_WORKDIR` is set,
 * else `~/.dp/access_token.json` under the LATCHED home — the same rule the
 * resolver uses for dp's state root since F1.363 (`dp-binary.ts` symbol
 * `resolveManagedWorkdir`), so the file read is the file dp itself keeps fresh.
 */
export function defaultDpSessionFilePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = latchedHomeDir(),
): string {
  const configured = env.DP_WORKDIR?.trim();
  return join(configured ? resolvePath(configured) : join(homeDir, '.dp'), DP_SESSION_FILE_NAME);
}

const ENTRY_KEYS = ['created_at', 'expires_at', 'refresh_expires_at', 'refresh_token', 'subject', 'token', 'type'];
const SUBJECT_KEYS = ['id', 'name', 'type'];

function hasExactlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

interface ValidEntry {
  token: string;
  subjectType: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/** Rule 4. `null` for any drift at all — the whole file is declined. */
function validateSession(parsed: unknown): ValidEntry[] | null {
  if (!hasExactlyKeys(parsed, ['tokens']) || !Array.isArray(parsed.tokens)) return null;
  const entries: ValidEntry[] = [];
  for (const raw of parsed.tokens) {
    if (!hasExactlyKeys(raw, ENTRY_KEYS)) return null;
    const { token, refresh_token: refreshToken, type, subject } = raw;
    if (typeof token !== 'string' || token.length === 0) return null;
    if (typeof refreshToken !== 'string' || typeof type !== 'string') return null;
    if (!hasExactlyKeys(subject, SUBJECT_KEYS)) return null;
    if (typeof subject.id !== 'string' || typeof subject.type !== 'string' || typeof subject.name !== 'string') {
      return null;
    }
    const createdAtMs = timestampMs(raw.created_at);
    const expiresAtMs = timestampMs(raw.expires_at);
    if (createdAtMs === undefined || expiresAtMs === undefined || timestampMs(raw.refresh_expires_at) === undefined) {
      return null;
    }
    entries.push({ token, subjectType: subject.type, createdAtMs, expiresAtMs });
  }
  return entries;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Rules 2–5: read dp's session file once (twice on a torn read), validate it
 * strictly, and return the freshest `user` entry's access token when it has at
 * least five minutes left. Never writes, never locks, never refreshes; the
 * parsed document — refresh token included — is not retained past this call.
 */
export async function readStoredDpAccessToken(
  path: string,
  opts: ReadStoredDpSessionOptions = {},
): Promise<StoredDpSessionRead> {
  const readFile = opts.readFile ?? ((file: string) => readFileSync(file, 'utf-8'));
  const now = opts.now ?? Date.now;
  let entries: ValidEntry[] | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFile(path));
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return { ok: false, reason: 'absent' };
      if (attempt === 0 && error instanceof SyntaxError) {
        await sleep(opts.retryDelayMs ?? 50);
        continue;
      }
      return { ok: false, reason: 'unreadable' };
    }
    entries = validateSession(parsed);
    // Rule 3: nothing of the parsed document survives this line except the
    // validated access tokens and their timestamps.
    parsed = undefined;
    break;
  }
  if (entries === null) return { ok: false, reason: 'shape' };
  const users = entries.filter((entry) => entry.subjectType === 'user');
  if (users.length === 0) return { ok: false, reason: 'no-user-entry' };
  const latest = users.reduce((best, entry) => (entry.createdAtMs > best.createdAtMs ? entry : best));
  if (latest.expiresAtMs - now() < STORED_SESSION_MIN_VALIDITY_MS) return { ok: false, reason: 'expiring' };
  return { ok: true, token: latest.token, expiresAtMs: latest.expiresAtMs };
}

/**
 * The facade's half: given the error the print-token path threw, either mint
 * a gateway JWT from dp's stored session with ONE exchange, or answer `null`
 * and let the caller rethrow its own error (rules 1 and 6).
 *
 * `null` in every declined case — a login-shaped failure, an unusable file, or
 * an exchange of the stored token that failed — because the ORIGINAL failure is
 * the one the user's action produced and the more actionable of the two. What
 * was declined and why is logged as a reason code, never a value.
 */
export async function exchangeStoredDpSession(
  printTokenFailure: unknown,
  opts: {
    signal?: AbortSignal;
    exchangeUrl?: string;
    seam?: StoredDpSessionSeam;
    onUsed: () => void;
  },
): Promise<string | null> {
  if (
    !(printTokenFailure instanceof DpAuthServiceError)
    || !STORED_SESSION_FALLBACK_CODES.has(printTokenFailure.code)
  ) {
    return null;
  }
  const read = await readStoredDpAccessToken(opts.seam?.path ?? defaultDpSessionFilePath(), {
    readFile: opts.seam?.readFile,
  });
  if (!read.ok) {
    log.info('stored dp session not used', { after: printTokenFailure.code, reason: read.reason });
    return null;
  }
  opts.onUsed();
  try {
    const { jwt } = await exchangeDpToken(read.token, { signal: opts.signal, url: opts.exchangeUrl });
    log.info('stored dp session exchanged', { after: printTokenFailure.code });
    return jwt;
  } catch (error) {
    log.info('stored dp session exchange failed', {
      after: printTokenFailure.code,
      code: error instanceof DpAuthServiceError ? error.code : 'unknown',
    });
    return null;
  }
}
