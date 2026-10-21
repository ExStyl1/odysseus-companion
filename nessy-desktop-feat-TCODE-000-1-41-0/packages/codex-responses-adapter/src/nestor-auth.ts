/**
 * Reads the Nestor JWT from `~/.nessy/dp_auth_creds.json` (field `jwt`).
 *
 * The creds file is **read-only** (AGENTS.md) — we never write it. Fail-soft to
 * `null` so a missing/corrupt file surfaces as a clean OpenAI-style error
 * (server.ts) rather than a crash.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { latchedHomeDir } from './home-latch.ts';

/**
 * The THIRD hand-written resolution of `~/.nessy/dp_auth_creds.json` — P3.168.
 *
 * It stays hand-written because it has to: `@nessy-agent/shared` depends on this
 * package, so importing `getCredsPath()` here would be a cycle, which is the
 * same reason `isJwtShaped` below is duplicated. What it no longer duplicates
 * is the ANSWER for `~`.
 *
 * `latchedHomeDir()` and not `homedir()`: a confirmed managed `HOME` reaches
 * `process.env` mid-session and, on Node — which the Electron main process and
 * the headless server both are — `os.homedir()` then follows it. This function
 * is reachable in that process: `codex-agent.ts` calls `readNestorJwt()` with
 * no argument, and so does the adapter's own gateway credential gate in
 * `server.ts`. Un-latched, it would resolve a DIFFERENT file from the one
 * `getCredsPath()` resolves in the same process and the same second. Both now
 * read one latch — see `@nessy-agent/shared` `config/home-latch.ts` for why
 * that is one module and not two.
 *
 * `NESSY_HOME` — DA1.5. `~/.nessy` is nessy-cli's directory and nessy-cli
 * publishes the variable that relocates it; `@nessy-agent/shared`
 * `auth/dp/creds-store.ts` symbol `getNessyDir` honours the same name, so this
 * resolver must honour it too — otherwise the two read DIFFERENT files in the
 * same process and the same second, which is the failure the latch paragraph
 * above describes, arriving through a second door. Only an ABSOLUTE value
 * counts, which is the whole of `getNessyDir`'s rule: it is total on purpose,
 * so that the four copies of it this tree is forced to keep (this one, the
 * store's, and the two read-side deny floors') cannot drift apart. A relative
 * or tilde value falls back to the default rather than being expanded.
 */
export function defaultCredsPath(): string {
  const relocated = process.env.NESSY_HOME?.trim();
  if (relocated && isAbsolute(relocated)) return join(relocated, 'dp_auth_creds.json');
  return join(latchedHomeDir(), '.nessy', 'dp_auth_creds.json');
}

// Duplicated from @nessy-agent/shared auth/dp jwt.ts on purpose: shared
// depends on this package, so importing shared here would be a cycle.
function isJwtShaped(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * Why the gateway credential gate refused — DA1.12.
 *
 * Two values, because the two remedies are different: `no_credentials` sends the
 * user to sign in for the first time, `credentials_expired` is the RE-MINT
 * trigger the plan's Target scheme clause 1 names ("the gateway credential of
 * record is ONLY the Nestor JWT … dp is needed in exactly two cases: re-minting
 * the JWT (a 401, or expiry) and the dp MCP tools"). Until this row both wires
 * rendered one string, so an expired credential was reported as a missing one
 * and the user was told their API key might be wrong.
 */
export type NestorCredsRefusal = 'no_credentials' | 'credentials_expired';

export type NestorCredsResult =
  | { ok: true; jwt: string }
  | { ok: false; reason: NestorCredsRefusal };

/**
 * The gateway credential gate, with its REASON.
 *
 * The expiry rule is duplicated from `@nessy-agent/shared` `auth/dp/creds-store.ts`
 * symbol `getValidCreds` (`creds.expiresAt <= Date.now()`), under the same
 * cycle-avoidance rule that already forces `isJwtShaped` and the creds path to be
 * hand-written here: shared depends on THIS package, so importing it would be a
 * cycle. `expiresAt` is epoch ms — that is the field's owner's own documented
 * unit (`DpCredentials` declares it `epoch ms`), and nessy-cli, the other writer
 * of this shared file, derives it as the JWT `exp` claim times 1000. So this is
 * duplication of a known rule, not invention.
 *
 * ONE DELIBERATE DIVERGENCE from `getValidCreds`, stated rather than left silent.
 * `getValidCreds` refuses a file whose `expiresAt` is absent or not a number
 * (its `loadCreds` requires the number before it returns anything). This gate
 * does NOT: an absent `expiresAt` keeps today's behaviour and the jwt is
 * returned. The reason is the asymmetry of the two failures — a null from
 * `getValidCreds` merely triggers a re-mint, while a refusal HERE is a 401 that
 * ends the user's turn, so inferring "expired" from a field that is not there
 * would block a turn on a credential that may be perfectly valid. Both writers of
 * this file always write the field, so the divergence is reachable only by a
 * hand-edited or half-written file — which is exactly the case where failing
 * open is the smaller harm.
 */
export function readNestorCreds(credsPath: string = defaultCredsPath()): NestorCredsResult {
  let raw: { jwt?: unknown; expiresAt?: unknown };
  try {
    raw = JSON.parse(readFileSync(credsPath, 'utf8')) as { jwt?: unknown; expiresAt?: unknown };
  } catch {
    return { ok: false, reason: 'no_credentials' };
  }
  if (typeof raw.jwt !== 'string' || !isJwtShaped(raw.jwt)) return { ok: false, reason: 'no_credentials' };
  // Shape first, expiry second: a garbage `jwt` with a future `expiresAt` is not
  // an expired credential, it is not a credential at all.
  if (typeof raw.expiresAt === 'number' && raw.expiresAt <= Date.now()) {
    return { ok: false, reason: 'credentials_expired' };
  }
  return { ok: true, jwt: raw.jwt };
}

/**
 * Returns the JWT string, or `null` if the file is missing/unreadable/absent/
 * non-JWT — or, since DA1.12, EXPIRED.
 *
 * Kept as the thin wrapper it now is because a dozen callers and stubs read this
 * shape; `readNestorCreds` is what a caller uses when it needs to say WHY.
 */
export function readNestorJwt(credsPath: string = defaultCredsPath()): string | null {
  const result = readNestorCreds(credsPath);
  return result.ok ? result.jwt : null;
}
