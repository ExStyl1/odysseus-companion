/**
 * Shared credentials store for `~/.nessy/dp_auth_creds.json`.
 *
 * This file is SHARED with nessy-cli (00-context decision 2): the shape is
 * nessy-cli's contract. Writes merge-preserve unknown keys (`cachedModels` and
 * anything else nessy-cli adds), are atomic (tmp + rename), and land at mode
 * 0600. The dp-auth module is the ONLY writer in Nessy Desktop.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { latchedHomeDir } from '../../config/home-latch.ts';
import { isUsableJwt, decodeJwtClaims } from './jwt.ts';

export interface DpCredentials {
  jwt: string;
  /** epoch ms */
  expiresAt: number;
  username: string;
  userId: string;
  /** Preserved verbatim; owned by nessy-cli's model cache. */
  cachedModels?: unknown;
  [key: string]: unknown;
}

/** The env var nessy-cli publishes for the directory that replaces `~/.nessy`. */
export const NESSY_HOME_ENV = 'NESSY_HOME';

/**
 * The directory that holds the credential files this module owns — DA1.5.
 *
 * ## The name is the file owner's, not ours
 *
 * `~/.nessy` is SHARED with nessy-cli and its shape is nessy-cli's contract
 * (AGENTS.md § Gateway Facts), so the variable that moves it is theirs too:
 * their `Storage.getGlobalNessyDir()` (`packages/core/src/config/storage.ts`)
 * reads `NESSY_HOME` and falls back to home plus `.nessy`. Honouring the same
 * name is what lets a cli seed still be found when a user has relocated their
 * nessy directory; inventing a second name would split the shared file in two.
 *
 * ## Mirrored: ONE name, not two
 *
 * The same module of theirs publishes a SECOND name, `NESSY_RUNTIME_DIR`, with
 * its own precedence — but it governs runtime OUTPUT (temp files, debug logs,
 * session data, todos, insights) and no credential of theirs is resolved
 * through it: every credential-ish path they have (`getMcpOAuthTokensPath`,
 * `getGlobalSettingsPath`, `getGoogleAccountsPath`) goes through
 * `getGlobalNessyDir()`. Mirroring it here would move a credential file its
 * own owner does not move, so it is deliberately NOT read.
 *
 * ## Two DIVERGENCES from their resolver, both deliberate and both stated
 *
 * 1. **Only an ABSOLUTE value is honoured.** Theirs expands a leading `~` and
 *    resolves anything still relative against a cwd. `process.cwd()` in this
 *    package is the app's own directory, not the user's — the same reasoning
 *    `relocatedCredentialDenyRoots` (`packages/shared/src/agent/mode-manager.ts`)
 *    already writes down for every other relocation name — and, more
 *    importantly, this path has to be re-derived IDENTICALLY by three deny
 *    anchors in packages that cannot share code with this one (the isolation
 *    floor in `session-tools-core`, the request-side floor in
 *    `agent/mode-manager.ts`, and the adapter's own resolver). "Absolute or
 *    the default" is a total rule four copies cannot drift apart on; an
 *    expansion step is one each copy could get subtly wrong, and a credential
 *    store the floor resolves differently is exactly the switch this row
 *    exists to avoid shipping. A non-absolute value is therefore IGNORED —
 *    failing closed on the default path rather than opening an unfloored one.
 * 2. **No temp-dir branch.** Their third branch falls back to
 *    `<tmpdir>/.nessy` when there is no home directory; `latchedHomeDir()`
 *    always answers, and writing a shared credential into a world-readable
 *    temp directory is not a fallback we want.
 *
 * ## Read LIVE, and not latched — the opposite choice from `HOME`, on purpose
 *
 * `latchedHomeDir()` freezes `HOME` because a confirmed managed value would
 * otherwise move this file mid-session (P3.143). `NESSY_HOME` is deliberately
 * NOT frozen the same way: the three deny anchors that must cover whatever
 * this returns live in packages that cannot see a latch of ours, so a frozen
 * store with live floors (or the reverse) could leave the credential OUTSIDE
 * every floor for the rest of the session — the one outcome worth more than
 * the mid-session move. Reading live everywhere makes the floors follow the
 * store unconditionally. The residue, named rather than hidden: a managed
 * `NESSY_HOME` delivered mid-session points this at an empty directory, which
 * costs a re-mint, and the floors follow it in the same instant, so no
 * credential is ever left unprotected. The floors ADD the relocated root
 * rather than replacing `~/.nessy`, so the pre-move file stays covered too.
 */
export function getNessyDir(): string {
  const raw = process.env[NESSY_HOME_ENV]?.trim();
  if (raw && isAbsolute(raw)) return raw;
  return join(latchedHomeDir(), '.nessy');
}

/**
 * The single source of truth for the creds path — and `readNessyGatewayJwt` in
 * the Electron main process now CALLS this rather than matching it by hand.
 *
 * `latchedHomeDir()` and not `homedir()`: P3.143. A confirmed managed `HOME`
 * reaches `process.env`, and on Node — which the Electron main process is —
 * `os.homedir()` then answers the new value, moving this file mid-session for
 * reads AND writes. The file is shared with nessy-cli, so a moved path is not
 * only our own credential going missing; it is our writer landing somewhere
 * nessy-cli will never look. See `config/home-latch.ts` for the measurement
 * and for what the latch deliberately does not cover.
 *
 * The directory itself comes from {@link getNessyDir}, which is where
 * `NESSY_HOME` is honoured.
 */
export function getCredsPath(): string {
  return join(getNessyDir(), 'dp_auth_creds.json');
}

function readRaw(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Load creds if the file is present and structurally valid (jwt + expiresAt).
 * `credsPath` defaults to the shared path; tests pass an explicit temp path so
 * they never touch the real `~/.nessy/dp_auth_creds.json`.
 */
export function loadCreds(credsPath: string = getCredsPath()): DpCredentials | null {
  if (!existsSync(credsPath)) return null;
  const data = readRaw(credsPath);
  if (data && typeof data.jwt === 'string' && typeof data.expiresAt === 'number') {
    return data as DpCredentials;
  }
  return null;
}

/**
 * Load creds only if still valid (not expired) and the jwt is JWT-SHAPED.
 *
 * **DA1.50 deepened the gate to {@link isUsableJwt}, which is where DA1.26 said
 * it belonged.** This is the reader of the credential of record — the Electron
 * main process, the headless start, the model fetcher, the Pi and Nestor agents,
 * the runtime switch and the plugin marketplace all reach the session's
 * `Nestor-Token` through it — so `isJwtShaped` accepting `a.b.c` here was real:
 * such a value leaves the machine as a header and comes back as a 401 nothing
 * can fix. DA1.26 moved only the FACADE (`index.ts` symbol `runEnsure`
 * re-mints rather than returning a cached credential that cannot decode) and
 * recorded the direct-reader residue in this docblock; DA1.50 closes it.
 *
 * **Why it was a row rather than a one-line residue, and what the re-probe
 * found.** Deepening the gate invalidates every fixture whose three-segment
 * literal does not decode, and those live in other packages. The 2026-09-14
 * probe reported eight files; re-run from the INDEX on 2026-09-17 — never the
 * working tree, because a tree-scanning probe reads whichever neighbour is
 * mid-edit, which is the caveat the row itself carries — the set that flows
 * through THIS function is smaller and differently shaped, because three of the
 * suites on that list read a DIFFERENT credential reader:
 * `codex-responses-adapter` has `nestor-auth.ts` symbol `readNestorJwt` and the
 * Electron main handler has `readNessyGatewayJwt`, and neither calls this
 * function. The conversion is to `__tests__/test-jwt.ts` symbol `makeTestJwt`,
 * whose payload carries a numeric `exp`.
 *
 * **EXPIRY is still asked HERE, not inside the predicate.** {@link isUsableJwt}
 * deliberately answers only "is this a JWT at all"; whether a decodable token is
 * still in date is this function's question and is answered against the stored
 * `expiresAt` above, so a re-mintable credential stays distinguishable from a
 * malformed one. The two checks are in this order for that reason.
 */
export function getValidCreds(credsPath: string = getCredsPath()): DpCredentials | null {
  const creds = loadCreds(credsPath);
  if (!creds || creds.expiresAt <= Date.now()) return null;
  return isUsableJwt(creds.jwt) ? creds : null;
}

/**
 * Merge `next` over the existing file object (preserving cachedModels and any
 * unknown nessy-cli keys) and write atomically at mode 0600. Creates `~/.nessy`
 * 0700 only when absent — never chmods an existing dir (avoids clobbering
 * nessy-cli's permissions; 00-context contention risk).
 */
export function saveCreds(
  next: {
    jwt: string;
    expiresAt: number;
    username: string;
    userId: string;
  },
  credsPath: string = getCredsPath(),
): void {
  const dir = dirname(credsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const existing = readRaw(credsPath) ?? {};
  const merged = { ...existing, ...next };

  // Unique tmp name so a concurrent nessy-cli write can't collide with ours.
  const tmp = `${credsPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
  chmodSync(tmp, 0o600); // guarantee 0600 regardless of umask
  renameSync(tmp, credsPath); // atomic on the same filesystem
}

/** Remove the creds file (used by an explicit sign-out / re-login). */
export function clearCreds(credsPath: string = getCredsPath()): void {
  if (existsSync(credsPath)) unlinkSync(credsPath);
}

/**
 * nessy-cli's OAuth store, same directory as our creds file. READ-ONLY for us,
 * and latched for the same reason {@link getCredsPath} is: it is a seed source
 * for the session's JWT, so moving it moves who the session authenticates as.
 */
export function getOauthCredsPath(): string {
  return join(getNessyDir(), 'oauth_creds.json');
}

/**
 * Read a Nestor JWT from nessy-cli's `oauth_creds.json` as a SEED source.
 * The cli stores its dp-auth JWT as `access_token` there and has stopped
 * maintaining `dp_auth_creds.json`. Accept only what our gateway would:
 * unexpired, JWT-shaped, decodable Nestor claims, and no `resource_url`
 * (that field marks a qwen-device-flow token in the same shared store).
 * Never writes; the caller persists through `saveCreds` if it adopts the jwt.
 */
export function readCliOauthJwt(oauthPath: string = getOauthCredsPath()): { jwt: string } | null {
  const data = readRaw(oauthPath);
  if (!data) return null;
  if (typeof data.resource_url === 'string' && data.resource_url.length > 0) return null;
  const jwt = data.access_token;
  if (typeof jwt !== 'string' || !isUsableJwt(jwt)) return null;
  const expiryDate = data.expiry_date;
  if (typeof expiryDate !== 'number' || expiryDate <= Date.now()) return null;
  try {
    if (!decodeJwtClaims(jwt).username) return null;
  } catch {
    return null;
  }
  return { jwt };
}

/** The last known dp identity (cached credential), display fields only — the shape carries no token by construction. */
export interface DpIdentity {
  username: string;
  userId: string;
}

/**
 * UA12.27 — the LAST KNOWN dp identity, for DISPLAY (the publish card's owner
 * line names it, P-UA-n-4): the cached Nessy Gateway credential's login (minted
 * from a dp token or seeded from nessy-cli; it can outlive or differ from dp's
 * session — a publish is signed by a live `dp auth print-token`, never by this
 * file); expired or unusable answers `null`. The returned record is a NEW object
 * holding the two display fields and nothing else — the jwt never leaves this
 * module through it, so a consumer cannot log what it was never handed.
 */
export function readDpIdentity(credsPath: string = getCredsPath()): DpIdentity | null {
  const creds = getValidCreds(credsPath);
  if (!creds || typeof creds.username !== 'string' || creds.username.trim() === '') return null;
  return { username: creds.username, userId: creds.userId };
}
