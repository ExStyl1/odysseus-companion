/**
 * F1.105 (origin `D1.428`) — the home directory the request-side credential
 * floor anchors on, and the one reason it is not `os.homedir()`.
 *
 * ## The drift this closes
 *
 * `SAFE_MODE_CONFIG.deniedPaths` (`mode-types.ts`) is a list of `~`-anchored
 * globs — `~/.nessy/**`, `~/.ssh/**`, `~/.aws/**`, `~/.config/gh/**` — and
 * `mode-manager.ts` expanded that `~` with the LIVE `os.homedir()`, on the
 * pattern side and on the candidate side both. Every credential those globs
 * protect is resolved under the LATCH instead: `auth/dp/creds-store.ts` symbol
 * `getCredsPath` for the gateway JWT, `credentials/backends/secure-storage.ts`
 * for the encrypted store's key derivation, `auth/dp/dp-runtime.ts` for dp's
 * state root, `config/sandbox-settings.ts` for the sandbox profile's own `~`
 * anchor, and the Pi floor's four anchors (P3.143 / P3.167 / P3.168).
 *
 * `config/managed-env.ts` classifies `HOME` as a `selector`, and on a CONFIRMED
 * managed block `applyManagedEnv` writes the administrator's value into
 * `process.env` — deliberately, because a subprocess inheriting it is the
 * operator control the documentation points admins at. On Node and Electron
 * `os.homedir()` then FOLLOWS it for the rest of the session
 * (`config/home-latch.ts` carries the three-runtime measurement, and the process
 * that does BOTH things is the Electron main). From that moment the floor named
 * the new home while every credential stayed at the old one, so a read of the
 * real `~/.nessy/dp_auth_creds.json` matched no denied pattern and the raw
 * `Nestor-Token` JWT was handed to the model — and the same drift un-denied
 * `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**` and the forge token stores at the
 * user's real home. With isolation OFF by standing owner decision
 * (2026-08-12/13) this array is the only read-side credential protection a
 * default install has, which is what makes a silent drift in it worth a row.
 *
 * ## Why this one is NOT split by direction, where its two neighbours are
 *
 * `mode-manager.ts` splits deny from grant three times — `normalizeDeniedPathPattern`
 * against `normalizeAllowedWritePattern`, the `'cross'`/`'stop'` terminator
 * policy, and `expandDenyCandidateHome`'s `$HOME` step — and every one of those
 * splits exists because the change would have WIDENED a grant in the same diff
 * as it tightened a floor. A latched `~` widens nothing: it changes which
 * directory `~` names, identically on the pattern side and the candidate side,
 * so a grant written `~/x` still matches a request for `~/x`. Splitting it would
 * instead CREATE the defect this row closes, one layer over — the floor anchored
 * on one home and `matchesAllowedWritePath` on another, inside one process.
 *
 * ## Its own boundary, and the residue stated rather than left to be found
 *
 * `config/home-latch.ts` names the latch's boundary: the session's credential
 * source, the key that store is encrypted under, and the in-process floor around
 * both — nothing wider. This is that floor; every other `os.homedir()` caller in
 * the tree still follows a confirmed `HOME`, and that is correct.
 *
 * RESIDUE: after a managed `HOME` lands, a command the shell will expand against
 * the NEW home is still judged against the latched one. That direction is safe
 * — it can only refuse more, never less, which is the posture
 * `unreadableTokenReachesPattern` beside it already takes — and whether the
 * NEW home's own credential files deserve a floor of their own is a different
 * and narrower question than this row's: nothing has written a credential there.
 *
 * A separate module rather than two more lines in `mode-manager.ts`: that file
 * is cited by line in 125 places across `docs/**`, and a docblock of this size
 * at line 147 would blank 123 of them for a one-word change.
 */

import { latchedHomeDir } from '../config/home-latch.ts';

/**
 * The home the credential floor anchors `~` and `$HOME` on — the one the session
 * was LAUNCHED with, never the one a confirmed managed block may have installed
 * since.
 */
export function floorHomeDir(): string {
  return latchedHomeDir();
}
