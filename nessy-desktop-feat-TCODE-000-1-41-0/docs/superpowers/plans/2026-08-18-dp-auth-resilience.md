# DP Auth Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A corrupted/foreign `~/.nessy/dp_auth_creds.json`, a chatty `dp` binary, or an outdated `dp` must degrade to an actionable sign-in/update path instead of today's unfixable 401 loop ("token contains an invalid number of segments") and a 24-name "Failed to connect" banner.

**Architecture:** Three read-side hardenings (JWT shape validation in every gateway-creds reader), one exec hardening (`dp auth print-token` under `DP_NO_WARNINGS` with stderr-tolerant parsing), one retry-semantics fix (a gateway 401 forces a JWT re-mint through dp instead of replaying the cached token — nessy-cli parity, see `dpContentGenerator.executeWithCredentialManagement`), and two UX truths (gateway-aware auth error text; outdated-dp hint on the failed-servers banner). No new writer of the creds file beyond the existing dp module; no change to the exchange protocol.

**Tech Stack:** TypeScript, Bun test, existing packages: `@nessy-agent/shared` (auth/dp, agent), `@nessy-agent/codex-responses-adapter`, `@nessy-agent/server-core`, Electron main handlers, renderer i18n (en+ru).

**Research base (2026-08-18, this repo @ 1.30.0):**
- Gateway 401 `token is malformed: token contains an invalid number of segments` = a non-JWT string reached `Nestor-Token`. Readers that forward it verbatim: `packages/codex-responses-adapter/src/nestor-auth.ts:17` (`readNestorJwt`, string-only check) → `nestor-client.ts:85` (`jwt ?? ''`); `packages/shared/src/auth/dp/creds-store.ts:62` (`getValidCreds`, checks ONLY `expiresAt > now`); `apps/electron/src/main/handlers/nessy-auth.ts:30` (`readNessyGatewayJwt`, prefill/IPC).
- The desktop writer cannot produce garbage (`decodeJwtClaims` gates `saveCreds`), but the file is SHARED with nessy-cli and hand-edits happen. Garbage + future `expiresAt` passes `getValidCreds`, so `ensureNessyGatewayAuth` warm-path returns "done" without ever consulting dp — the state never self-heals, auth-retry loops on the same 401.
- `printToken` (`packages/shared/src/auth/dp/dp-api.ts:33`) requires EXACTLY one stdout line AND empty stderr, and execs without `DP_NO_WARNINGS` — any dp banner/warning turns a logged-in user into perpetual `needs-login`.
- Measured live (dp 13.37.2): a fully UNAUTHENTICATED dp still serves `dp ai mcp jira` (initialize/tools-list/call all answer). Mass "Failed to connect" therefore means the dp subprocess doesn't start — an outdated dp lacking `dp ai mcp` — not a missing login. The version floor `DP_MIN_VERSION = '13.0.0'` (`dp-binary.ts:25`) is warn-only and surfaces nowhere near the banner.
- The error card users see comes from `packages/shared/src/agent/claude-sdk-error-mapper.ts:288` (`authentication_failed` → "Your API key may be invalid or expired") — misleading on gateway cards, which have no API key (auth = one-click dp sign-in). The call site `claude-agent.ts:4903` passes no `providerType` at all.

## Global Constraints

- Bun for everything (`bun test`, `bun run typecheck:*`); no npm/yarn.
- Branch: `bugfix/TCODE-000`; ONE commit per task, message given in the task; NO `Co-Authored-By` trailers; no MRs/tags.
- Token values NEVER appear in logs, error messages, or test names — log lengths/booleans only (existing dp-auth contract).
- `~/.nessy/dp_auth_creds.json` stays read-only for everyone except `packages/shared/src/auth/dp/` (this plan adds no writer).
- `packages/codex-responses-adapter` must NOT import from `@nessy-agent/shared` (shared depends on the adapter; the reverse import is a cycle). Duplicate the 3-line shape predicate there with a comment saying why.
- i18n: every new key lands in BOTH `en.json` and `ru.json`, alphabetically sorted; gate with `bun run lint:i18n:parity && bun run lint:i18n:sorted`.
- Tests: if you `mock.module`, spread the real module AND restore in `afterAll` (repo trap — a bare mock amputates the package for every later test file).
- Verification budget: per-task focused tests + affected-package typecheck only; the full repo regression runs once, in T7.
- Do not modify `.references/`, CI, or fastlane.

---

## Tracker

| Task | Status | Commit | Note |
| --- | --- | --- | --- |
| T1 shared JWT shape guard (`isJwtShaped` + `getValidCreds`) | ✅ | `7f2f2dcd6` | `isJwtShaped` + narrowed `getValidCreds`; fixed 4 pre-existing tests whose "valid jwt" fixtures were non-JWT-shaped placeholders |
| T2 adapter `readNestorJwt` shape guard | ✅ | `bf2eb7077` | Duplicated `isJwtShaped` locally (no shared import); fixed 1 pre-existing units.test.ts fixture using a non-JWT-shaped placeholder |
| T3 electron `readNessyGatewayJwt` shape guard | ✅ | `1354a382f` | Guarded `readNessyGatewayJwt` with `isJwtShaped`; fixed 2 pre-existing tests (`nessy-auth.test.ts`, the `gateway-login-check.test.ts` re-auth-propagation case) whose "valid jwt" fixtures were non-JWT-shaped placeholders |
| T4 `dp auth print-token` env + tolerant parse | ✅ | `854ebdbe5` | DP_NO_WARNINGS env on print-token+login; success path now checks NEEDS_LOGIN_MARKER against stderr instead of requiring it empty; catch-path marker check unchanged; fake-dp.ts extended with two config seams instead of the brief's raw-shell-script helper. (Corrected from the pre-amend `2b6f71f9f` originally recorded here — verified against `git log`.) |
| T5 force re-mint on gateway 401 retry + explicit Sign in | ✅ | `7843103a3`, `90bc40486` | Added `EnsureGatewayAuthOptions.forceRefresh` (skips step-2 warm-creds path only; env bypass unaffected); `attemptAuthRetry`'s `setImmediate` block gained step 0, `refreshGatewayAuthForRetry(managed)`, which best-effort re-mints via `ensureNessyGatewayAuth({interactive:false, forceRefresh:true})` for `claude-runtime`/`pi_compat` gateway-baseUrl connections; connection lookup reuses the existing `resolveSessionConnection` (same accessor `sendMessage`'s `resolveBackendContext` and `createCapabilityTurn` already resolve `managed.llmConnection` through), not a new lookup; explicit Sign-in (`createGatewayAuthController.ensure()`) now passes `forceRefresh: true`; silent launch (`ensureGatewayAuthForLaunch`) unchanged. (Corrected from the pre-amend `8239544aa` originally recorded here — verified against `git log`/`git reflog`.) Review raised two Important findings on this task: (1) `gatewayBacked` omitted `codex-runtime`, so a codex-gateway 401 (same dp flow, same `Nestor-Token` JWT) would have replayed the rejected token; (2) the `gatewayBacked` branch and the `ensureNessyGatewayAuth` call had no regression coverage — `authRetryFixture()` never set `managed.llmConnection`. A follow-up commit (`90bc40486`) added `codex-runtime` to the classification and a positive/negative pair in `SessionManager.auth-retry-lifecycle.test.ts` (codex-runtime gateway-backed vs. a BYO endpoint) exercised through two new injectable seams, `resolveGatewayAuthRetryConnection` and `ensureNessyGatewayAuthForRetry`, added to avoid mocking the `@nessy-agent/shared/auth/dp` module or touching real config storage. |
| T6 seed gateway creds from nessy-cli's oauth_creds.json | ✅ | `dea9e1e98` | `readCliOauthJwt` (creds-store.ts) + `runEnsure` step 2b (index.ts), inside the same `if (!forceRefresh)` block T5 introduced; seeded jwt persisted only via the existing `saveCreds` (never writes `oauth_creds.json` itself). Surfaced a real hermeticity gap: every pre-existing test in this suite that didn't pass the new `oauthCredsPath` was silently reading the developer's REAL `~/.nessy/oauth_creds.json` once step 2b existed (confirmed live — this machine's file holds the signed-in user's actual Nestor JWT), breaking 12 pre-existing tests across `index.test.ts`/`e2e.test.ts`/`error-paths.test.ts`; fixed by adding an explicit, guaranteed-absent `oauthCredsPath` to each affected call site, the same DI pattern already used for `credsPath` (collateral fix, outside this task's nominal file list, precedented by T1/T3's pre-existing-test fixes). (Corrected from the pre-amend `d85ad7535` originally recorded here — verified against `git log`.) |
| T7 gateway-aware auth error card | ✅ | `a9fc5cdf0` | Added a `context.providerType === 'claude-runtime'` branch inside the existing `authentication_failed` case in `claude-sdk-error-mapper.ts` (placed after the pre-existing 403 early-return, which stays untouched), naming the one-click Nessy Gateway sign-in instead of a nonexistent API key; threaded `providerType: this.config.providerType` into the `mapClaudeSdkAssistantError` call inside `claude-agent.ts`'s `mapSDKErrorToTypedError` (previously omitted entirely). Judgment call (brief flagged this as open): did NOT extend the branch to `codex-runtime`. Evidence — `backend/factory.ts`'s `createBackend` dispatches on `config.provider` (the AgentProvider), and provider `'codex-runtime'` instantiates `CodexAgent`, never `ClaudeAgent`; `mapClaudeSdkAssistantError` has exactly one production call site, inside `ClaudeAgent` (`claude-agent.ts:4903`); `codex-agent.ts` never imports `claude-sdk-error-mapper.ts` and has no `AgentError`/`authentication_failed` handling of its own. A codex-runtime 401 therefore cannot reach this mapper through any production path, so adding the condition would be dead code — kept the brief's literal `claude-runtime`-only condition. (Corrected from the pre-amend `d5e4989ef` originally recorded here — verified against `git log`.) |
| T8 outdated-dp hint on failed-servers banner | ✅ | `d5ac44bab`, `81ea7af42` | `SafeWorkspacePendingAuth.dpOutdated?`/`PendingAuthSummaryInput.dpOutdated?` (both default-absent, field omitted unless true); `resolveWorkspacePendingAuth` probes `this.dpSessionBroker.probe()` advisory-only (try/catch, degrades to `false`) and threads `dpOutdated` into `buildPendingAuthSummary`; `PendingAuthNotice.tsx` renders a second `<li data-testid="pending-auth-dp-outdated">` only when `failedServers.length > 0 && dpOutdated`; new `pendingAuth.dpOutdated` key in en/ru (alphabetically right after `dismiss`, before `dpRow_one` — NOT between `dpSigningIn`/`error` as this task's own draft guessed; `lint:i18n:sorted` confirmed). Sha is pre-amend (a commit cannot embed its own final hash, same self-reference T1-T7 hit) — verify against `git log` if this drifts. Review raised an Important finding: the SessionManager-level probe→summary wiring in `resolveWorkspacePendingAuth` had no test exercising it (both this task's tests bypassed SessionManager entirely). A follow-up commit (`81ea7af42`, "test(sources): cover the SessionManager probe that feeds the outdated-dp hint") added the missing coverage: it injects an `outdated: true` probe via `fixture()`'s `dpSessionBroker` seam and asserts `getWorkspacePendingAuth(...).dpOutdated === true`, verified RED (fails when the `dpOutdated` argument is dropped from the `buildPendingAuthSummary` call) before GREEN. |
| T9 close-out: regression, 1.30.1 bump, release notes, docs-site | ✅ | *(this commit — see note)* | Full regression run (`typecheck:all`, `lint`, `lint:i18n:parity`, `lint:i18n:sorted`, `test:shared:all`, `bun test`); see `.superpowers/sdd/task-9-report.md` for gate output. `typecheck:all`/`lint`/`lint:i18n:parity`/`lint:i18n:sorted`/`test:shared:all` all exit 0. The first full `bun test` pass surfaced 12 failures, none on `master` or in `known-failing-tests.md`, traced to this task's own process rather than to T1-T8: (1) `version.test.ts`'s root-vs-electron version-alignment check read the two `package.json` files while this task's own version-bump edits were landing between them — a self-inflicted torn read, gone on a clean re-run; (2) 11 tests across `nestor-cloud/__tests__/client.test.ts` and `local-tool-adapter.test.ts` used non-JWT-shaped placeholder creds (`'jwt-token'`, `'test-only-not-a-real-jwt'`, etc.) that T1's `isJwtShaped` guard now correctly rejects — the same fixture class T1/T2/T3/T6 already fixed elsewhere, just not in this directory (outside T1's original file list; `test:shared:all` and T1-T8's own verification never exercise `nestor-cloud`, only a full `bun test` does). Fixed by re-punctuating the placeholders to be JWT-shaped (`'header.jwt-token.signature'` etc.) with matching assertion updates; behavior unchanged, still obviously-fake test values. The clean re-run (no concurrent edits) dropped to 1 fail, 14394/14414: `conformance — live gateway > streaming text...` (`codex-responses-adapter`), timed out at 60002ms — this IS the known-failing register's documented row ("needs live gateway credentials"; gated `describe.if(!!jwt)`, and this machine has a real one), reproduced by its own documented mechanism, nothing this plan touched is in its path. Left as-is per the task's instruction not to chase a pre-existing, documented, unrelated failure. `package.json`+`apps/electron/package.json` → `1.30.1`; added `apps/electron/resources/release-notes/1.30.1.md`; added a "Gateway sign-in troubleshooting" subsection to `docs-site/content/reference/config/credentials.md`'s existing Troubleshooting section (closest existing page — it already documents `~/.nessy/dp_auth_creds.json` and has the matching heading); backfilled T5's and T8's Commit column with their follow-up-commit shas (`90bc40486`, `81ea7af42`) verified against `git log`. Self-reference: like T1-T8, this row lands in the commit it describes, so no sha typed here could survive being written — unlike them, no later task exists in this plan to backfill it once the real hash is known. Identify the commit by its subject, `chore(release): 1.30.1 — dp auth resilience close-out`, on `fix/auth`. |
| T10 final-review fix wave: gateway seed reachable from every gateway card + Sign-in fallback + probe gating | ✅ | *(this commit — see note)* | The 1.30.1 close-out's FINAL whole-branch review raised three more Important findings, fixed together here. (1) `isNessyGatewayConnection` (`nessy-auth.ts`) checked `providerType === 'pi_compat'` only, so `ensureGatewayAuthForLaunch`/`shouldPromptGatewayLogin` — the ONLY non-`forceRefresh` callers of `ensureNessyGatewayAuth`, i.e. the T6 nessy-cli seed's entry points — never ran for a `claude-gateway`/`codex-gateway`-only user. Widened to the same three types `SessionManager.refreshGatewayAuthForRetry`'s `gatewayBacked` already covers (`pi_compat`/`claude-runtime`/`codex-runtime`); that check is a private method, not exported, so it cannot be imported across the server-core/electron package boundary — mirrored by hand with a comment naming the other, base-url equality left untouched (a BYO endpoint still excluded). (2) `createGatewayAuthController.ensure()` (explicit Sign-in) always passed `forceRefresh: true`, which by contract (T5/T6) skips BOTH the warm cached-creds path and the nessy-cli seed — a user whose only working creds came from nessy-cli, with dp missing/outdated, would click the Sign-in the T7 error card points them at and get a failure where the cache would have worked. Design: keep the forced attempt FIRST (T5's whole point — a rejected token must not be replayed); on a non-cancel failure, fall back to ONE additional `deps.ensure({ forceRefresh: false, interactive: false })` call, which reaches the warm path and the seed without re-running the interactive dp login the forced attempt already tried; a cancellation (`DpAuthError.Cancelled`) from the forced attempt is rethrown immediately without any fallback attempt (never masked as a fallback success); if the fallback also fails (non-cancel), the ORIGINAL forced-attempt error is reported, not the fallback's — never a false success. (3) `resolveWorkspacePendingAuth` (`SessionManager.ts`) awaited `this.dpSessionBroker.probe()` unconditionally, but `PendingAuthNotice.tsx` renders the hint only when `failedServers.length > 0`; a probe is two dp execs (5s timeouts) and a non-`'ready'` result is deliberately never cached (`session-broker.ts`), so a signed-out user re-executed dp on every banner refresh for a result the UI could never show. Restructured minimally: `failedSlugs` is now computed once before the probe decision, the probe runs only when `failedSlugs.length > 0`, and the same `failedSlugs` value feeds `buildPendingAuthSummary` — advisory try/catch and the "field omitted when absent" contract both unchanged. The pre-existing T8 integration test (`SessionManager.dp-auth.test.ts`, asserting `dpOutdated === true`) passed a workspace with `failed: []`, which the new gate would now skip-probe; fixed the fixture to `failed: ['broken-server']` per the brief's own instruction (adjust the fixture, not the assertion's intent) — the assertion is unchanged and still holds. New tests: `gateway-login-check.test.ts` (predicate now matches `claude-runtime`/`codex-runtime` at the gateway URL and still rejects a BYO endpoint on either, plus an `ensureGatewayAuthForLaunch` case for a codex-gateway launch; the old `codex-runtime` "no gateway" fixture in that describe block was retargeted to `anthropic`, since codex-runtime is now correctly gateway-backed); `gateway-auth-controller.test.ts` (fallback recovers to `{ok:true}` from a seed/warm-path stand-in when the forced call fails, asserting the exact two calls' `forceRefresh`/`interactive` values; a `Cancelled` forced failure short-circuits with no second call; a non-cancel double failure reports the forced error, not the fallback's); `SessionManager.dp-auth.test.ts` (new describe block: zero failed servers never calls `probe()` and omits `dpOutdated`; one failed server calls `probe()` once and threads `dpOutdated` through). All new tests verified RED against the pre-fix code (temporarily reverted to HEAD) before GREEN against the fix. Gate: `bun test packages/shared/src/auth/dp/` (90 pass), `bun test apps/electron/src/main/handlers/__tests__/` (50 pass), `bun test packages/server-core/src/sessions/SessionManager.dp-auth.test.ts packages/server-core/src/sessions/SessionManager.auth-retry-lifecycle.test.ts` (36 pass), `bun run typecheck:all` (exit 0) — all clean. Full report: `.superpowers/sdd/final-review-fix-report.md`. Self-reference: like T9, this row lands in the commit it describes — identify it by subject, `fix(auth): the gateway seed reaches every gateway card, and Sign in falls back to it`, on `fix/auth`. |

Update the row (glyph `🔄`/`✅`, commit sha, one-line note) IN THE SAME COMMIT that lands the task.

---

### Task 1: Shared JWT shape guard — `isJwtShaped` + `getValidCreds`

**Files:**
- Modify: `packages/shared/src/auth/dp/jwt.ts` (add predicate)
- Modify: `packages/shared/src/auth/dp/creds-store.ts:61-65` (`getValidCreds`)
- Test: `packages/shared/src/auth/dp/__tests__/creds-store.test.ts` (extend)

**Interfaces:**
- Produces: `export function isJwtShaped(value: string): boolean` from `packages/shared/src/auth/dp/jwt.ts` — T3 imports it via the `auth/dp` module.
- `getValidCreds` signature unchanged; behavior narrowed: non-JWT-shaped `jwt` ⇒ `null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/auth/dp/__tests__/creds-store.test.ts` (follow the file's existing tmp-path pattern for `credsPath`):

```ts
describe('getValidCreds jwt shape', () => {
  test('non-JWT jwt with a future expiresAt reads as signed out', () => {
    const credsPath = join(tmpDir, 'garbage-creds.json');
    writeFileSync(credsPath, JSON.stringify({
      jwt: 'sk-not-a-jwt-token',
      expiresAt: Date.now() + 86_400_000,
      username: 'u', userId: '1',
    }));
    expect(getValidCreds(credsPath)).toBeNull();
  });

  test('three-segment jwt with a future expiresAt still reads as valid', () => {
    const credsPath = join(tmpDir, 'ok-creds.json');
    writeFileSync(credsPath, JSON.stringify({
      jwt: 'aGVhZA.cGF5bG9hZA.c2ln',
      expiresAt: Date.now() + 86_400_000,
      username: 'u', userId: '1',
    }));
    expect(getValidCreds(credsPath)?.username).toBe('u');
  });
});
```

Reuse the suite's existing `tmpDir` fixture and imports (`join`, `writeFileSync`, `getValidCreds`); add any of them that the file does not already import.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/auth/dp/__tests__/creds-store.test.ts`
Expected: the first new test FAILS (garbage creds currently returned as valid); the second PASSES.

- [ ] **Step 3: Implement**

In `packages/shared/src/auth/dp/jwt.ts`, add below the imports:

```ts
/**
 * Cheap shape check for values about to be sent as `Nestor-Token`. The creds
 * file is shared with nessy-cli and hand-edits happen; a non-JWT value there
 * must read as "signed out" (so the dp exchange re-mints and overwrites)
 * instead of being sent upstream, where it produces an unfixable
 * 401 "token contains an invalid number of segments" loop.
 */
export function isJwtShaped(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}
```

In `packages/shared/src/auth/dp/creds-store.ts`, import it and narrow `getValidCreds`:

```ts
import { isJwtShaped } from './jwt.ts';

/** Load creds only if still valid (not expired) and the jwt is JWT-shaped. */
export function getValidCreds(credsPath: string = getCredsPath()): DpCredentials | null {
  const creds = loadCreds(credsPath);
  if (!creds || creds.expiresAt <= Date.now()) return null;
  return isJwtShaped(creds.jwt) ? creds : null;
}
```

Re-export `isJwtShaped` from `packages/shared/src/auth/dp/index.ts` (alongside the existing `decodeJwtClaims`-adjacent exports) so T3 can import it from the module root.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/shared/src/auth/dp/`
Expected: ALL PASS — including the existing `index.test.ts` warm-path suites, which prove `ensureNessyGatewayAuth` now falls through to the dp/exchange path on garbage creds (self-heal) instead of returning them.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck:shared`
Expected: exit 0.

```bash
git add packages/shared/src/auth/dp/jwt.ts packages/shared/src/auth/dp/creds-store.ts packages/shared/src/auth/dp/index.ts packages/shared/src/auth/dp/__tests__/creds-store.test.ts docs/superpowers/plans/2026-08-18-dp-auth-resilience.md
git commit -m "fix(auth): treat a non-JWT jwt in dp_auth_creds.json as signed out"
```

(Include the tracker row update for T1 in this commit.)

---

### Task 2: Adapter `readNestorJwt` shape guard

**Files:**
- Modify: `packages/codex-responses-adapter/src/nestor-auth.ts`
- Create: `packages/codex-responses-adapter/src/__tests__/nestor-auth.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (the predicate is DUPLICATED here — the adapter must not import `@nessy-agent/shared`, see Global Constraints).
- Produces: `readNestorJwt` signature unchanged; a non-JWT-shaped file value now returns `null`, so the existing gate in `server.ts:122-126` answers the local 401 `"Nessy Gateway credentials not found (~/.nessy/dp_auth_creds.json)"` instead of forwarding garbage upstream.

- [ ] **Step 1: Write the failing test**

Create `packages/codex-responses-adapter/src/__tests__/nestor-auth.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNestorJwt } from '../nestor-auth.ts';

const dir = mkdtempSync(join(tmpdir(), 'nestor-auth-'));
const write = (name: string, body: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};

describe('readNestorJwt', () => {
  test('returns a three-segment jwt verbatim', () => {
    const path = write('ok.json', { jwt: 'aGVhZA.cGF5bG9hZA.c2ln' });
    expect(readNestorJwt(path)).toBe('aGVhZA.cGF5bG9hZA.c2ln');
  });

  test('returns null for a non-JWT jwt value', () => {
    const path = write('garbage.json', { jwt: 'sk-not-a-jwt-token' });
    expect(readNestorJwt(path)).toBeNull();
  });

  test('returns null for a missing file', () => {
    expect(readNestorJwt(join(dir, 'absent.json'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/codex-responses-adapter/src/__tests__/nestor-auth.test.ts`
Expected: 'returns null for a non-JWT jwt value' FAILS; the other two PASS.

- [ ] **Step 3: Implement**

In `packages/codex-responses-adapter/src/nestor-auth.ts`, replace the return line of `readNestorJwt`:

```ts
// Duplicated from @nessy-agent/shared auth/dp jwt.ts on purpose: shared
// depends on this package, so importing shared here would be a cycle.
function isJwtShaped(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/** Returns the JWT string, or `null` if the file is missing/unreadable/absent/non-JWT. */
export function readNestorJwt(credsPath: string = defaultCredsPath()): string | null {
  try {
    const raw = JSON.parse(readFileSync(credsPath, 'utf8')) as { jwt?: unknown };
    return typeof raw.jwt === 'string' && isJwtShaped(raw.jwt) ? raw.jwt : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/codex-responses-adapter/src/__tests__/nestor-auth.test.ts packages/codex-responses-adapter/src/__tests__/units.test.ts`
Expected: ALL PASS (units.test.ts guards the adapter's existing contract).

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc -p packages/codex-responses-adapter/tsconfig.json --noEmit` (or `bun run typecheck:all` if the package has no standalone script — it is covered by the chain since 2026-08-13).
Expected: exit 0.

```bash
git add packages/codex-responses-adapter/src/nestor-auth.ts packages/codex-responses-adapter/src/__tests__/nestor-auth.test.ts docs/superpowers/plans/2026-08-18-dp-auth-resilience.md
git commit -m "fix(adapter): refuse non-JWT creds so the local 401 gate fires instead of the gateway"
```

---

### Task 3: Electron `readNessyGatewayJwt` shape guard

**Files:**
- Modify: `apps/electron/src/main/handlers/nessy-auth.ts:30` (`readNessyGatewayJwt`)
- Test: `apps/electron/src/main/handlers/__tests__/gateway-login-check.test.ts` (extend)

**Interfaces:**
- Consumes: `isJwtShaped` from `@nessy-agent/shared` `auth/dp` (T1).
- Produces: `readNessyGatewayJwt` unchanged signature; garbage file ⇒ `null` (IPC `nessy:getGatewayJwt` prefill and `shouldPromptGatewayLogin` now see "signed out").

- [ ] **Step 1: Write the failing test**

In `apps/electron/src/main/handlers/__tests__/gateway-login-check.test.ts`, add (reusing the file's temp-file helpers if present, else `mkdtempSync` as in T2):

```ts
test('readNessyGatewayJwt: non-JWT jwt value reads as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-jwt-'));
  const path = join(dir, 'dp_auth_creds.json');
  writeFileSync(path, JSON.stringify({ jwt: 'sk-not-a-jwt-token', expiresAt: Date.now() + 86_400_000 }));
  expect(readNessyGatewayJwt(path)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/handlers/__tests__/gateway-login-check.test.ts`
Expected: new test FAILS (currently returns the garbage string), existing tests PASS.

- [ ] **Step 3: Implement**

In `apps/electron/src/main/handlers/nessy-auth.ts`, import `isJwtShaped` from the shared dp-auth module (same import path style the file already uses for `ensureNessyGatewayAuth`) and guard the return of `readNessyGatewayJwt`: where it currently returns `{ jwt }` for any non-empty string, return `null` unless `isJwtShaped(jwt)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/electron/src/main/handlers/__tests__/gateway-login-check.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck:all`
Expected: exit 0.

```bash
git add apps/electron/src/main/handlers/nessy-auth.ts apps/electron/src/main/handlers/__tests__/gateway-login-check.test.ts docs/superpowers/plans/2026-08-18-dp-auth-resilience.md
git commit -m "fix(electron): gateway JWT prefill ignores non-JWT creds values"
```

---

### Task 4: `dp auth print-token` — DP_NO_WARNINGS env + stderr-tolerant parse

**Files:**
- Modify: `packages/shared/src/auth/dp/dp-api.ts:33-64` (`printToken`), `:71-85` (`login`)
- Test: `packages/shared/src/auth/dp/__tests__/dp-api.test.ts` (extend; a `fake-dp.ts` helper already exists in that directory — follow its pattern for fabricating a dp executable)

**Interfaces:**
- `printToken`/`login` signatures unchanged. New semantics: (a) both execs run with `env: { ...process.env, DP_NO_WARNINGS: 'true' }`; (b) a clean exit with EXACTLY one non-empty stdout line is a token **even when stderr carries text** — stderr is consulted only for the `NEEDS_LOGIN_MARKER` (which today arrives via the non-zero-exit catch path and keeps working).

**Why:** dp prints update banners/warnings; the current "empty stderr" requirement turns a logged-in user into perpetual `needs-login`, which blocks the JWT re-mint that T1 just made reachable again.

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/auth/dp/__tests__/dp-api.test.ts`, add a fake dp that prints a token on stdout AND a warning on stderr (mirror the file's existing fake-dp fixture; if it builds shell scripts, the body is):

```bash
#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "print-token" ]; then
  echo "warning: a new Spirit CLI version is available" >&2
  echo "dp-access-token-value"
  exit 0
fi
exit 1
```

```ts
test('printToken: one stdout line + stderr warning still yields the token', async () => {
  const dpPath = writeFakeDp(warningFakeDpBody); // per the file's existing helper
  expect(await printToken(dpPath)).toBe('dp-access-token-value');
});

test('printToken: passes DP_NO_WARNINGS to dp', async () => {
  const dpPath = writeFakeDp(`#!/bin/sh
if [ "$DP_NO_WARNINGS" = "true" ]; then echo "dp-access-token-value"; exit 0; fi
echo "banner" ; echo "dp-access-token-value"; exit 0`);
  expect(await printToken(dpPath)).toBe('dp-access-token-value');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/auth/dp/__tests__/dp-api.test.ts`
Expected: both new tests FAIL (first: stderr disqualifies; second: env not passed so two stdout lines → undefined).

- [ ] **Step 3: Implement**

In `printToken`:

```ts
const { stdout, stderr } = await execFileAsync(dpPath, ['auth', 'print-token'], {
  signal,
  env: { ...process.env, DP_NO_WARNINGS: 'true' },
});
const stdoutLines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
if (stderr.includes(NEEDS_LOGIN_MARKER)) {
  log.info('print-token: needs login');
  return undefined;
}
if (stdoutLines.length === 1) {
  log.info('print-token succeeded', { tokenLength: stdoutLines[0]!.length, hadStderr: stderr.trim().length > 0 });
  return stdoutLines[0];
}
log.info('print-token returned no clean token; treating as needs-login');
return undefined;
```

In `login`, add the same `env: { ...process.env, DP_NO_WARNINGS: 'true' }` to its `execFileAsync` options. Keep the catch blocks exactly as they are (marker check, abort mapping, no-cause rule).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/shared/src/auth/dp/`
Expected: ALL PASS (including `session-broker.test.ts` and `e2e.test.ts`, which exercise printToken through the broker).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck:shared`
Expected: exit 0.

```bash
git add packages/shared/src/auth/dp/dp-api.ts packages/shared/src/auth/dp/__tests__/dp-api.test.ts docs/superpowers/plans/2026-08-18-dp-auth-resilience.md
git commit -m "fix(auth): dp print-token survives dp banners (DP_NO_WARNINGS + stderr-tolerant parse)"
```

---

### Task 5: Force re-mint on gateway 401 retry + explicit Sign in

**Files:**
- Modify: `packages/shared/src/auth/dp/index.ts` (`EnsureGatewayAuthOptions` + `runEnsure`)
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (`attemptAuthRetry` pre-step + helper)
- Modify: `apps/electron/src/main/handlers/nessy-auth.ts` (explicit Sign-in channel passes the flag)
- Test: `packages/shared/src/auth/dp/__tests__/index.test.ts` (extend)

**Interfaces:**
- Produces: `EnsureGatewayAuthOptions.forceRefresh?: boolean` — when true, the cached-creds warm path is SKIPPED (env bypass unaffected); default absent keeps today's behavior byte-for-byte.
- Consumes: `isNessyGatewayBaseUrl` (already exported from `@nessy-agent/shared` agent backend, see `packages/shared/src/agent/backend/index.ts:95`), `ensureNessyGatewayAuth`.

**Why:** nessy-cli has no stuck-auth problem because on every 401/403 it re-runs the FULL dp flow unconditionally (`dpContentGenerator.executeWithCredentialManagement` → `performNessyAuth`, which never consults the cache). Our `attemptAuthRetry` destroys the agent, but the new agent re-reads the SAME cached file: a server-side-revoked (or rotated) JWT that is well-formed and unexpired replays forever — across restarts too, since the launch refresh also takes the warm path. T1 heals malformed values; this task heals REJECTED ones.

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/auth/dp/__tests__/index.test.ts` (reuse the suite's existing fake broker/exchange fixtures — `stub-exchange-server.ts`, `test-jwt.ts`):

```ts
test('forceRefresh skips warm cached creds and re-mints through dp', async () => {
  // Arrange: creds file containing a VALID (well-formed, unexpired) jwt,
  // plus a broker/exchange stub that yields a DIFFERENT jwt.
  const credsPath = writeValidCredsFixture(); // suite helper; jwt = OLD_JWT
  const result = await ensureNessyGatewayAuth({
    credsPath,
    exchangeUrl: stubExchangeUrl, // yields NEW_JWT
    sessionBroker: fakeReadyBroker,
    forceRefresh: true,
  });
  expect(result.jwt).toBe(NEW_JWT);
  expect(JSON.parse(readFileSync(credsPath, 'utf8')).jwt).toBe(NEW_JWT);
});

test('without forceRefresh warm creds still win (no dp exec)', async () => {
  const credsPath = writeValidCredsFixture();
  const result = await ensureNessyGatewayAuth({ credsPath, sessionBroker: throwingBroker });
  expect(result.jwt).toBe(OLD_JWT);
});
```

(Adapt fixture names to the file's existing helpers; the second test likely already exists — keep, don't duplicate.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/auth/dp/__tests__/index.test.ts`
Expected: first new test FAILS (warm path returns OLD_JWT despite the flag).

- [ ] **Step 3: Implement**

`packages/shared/src/auth/dp/index.ts` — add to `EnsureGatewayAuthOptions`:

```ts
  /**
   * Skip the cached-creds warm path and re-mint through dp. Set by the
   * gateway 401 auth-retry (the cached JWT was just REJECTED — returning it
   * again loops forever; nessy-cli re-mints unconditionally on 401 for the
   * same reason) and by the explicit Sign-in click. Env bypass is unaffected.
   * Single-flight caveat: a forceRefresh caller that joins an already-running
   * warm ensure gets that run's result — acceptable, the retry re-fires.
   */
  forceRefresh?: boolean;
```

In `runEnsure`, destructure `forceRefresh = false` and guard step (2):

```ts
    // (2) cached valid creds — warm path, no dp exec (skipped under forceRefresh)
    if (!forceRefresh) {
      const valid = getValidCreds(credsPath);
      if (valid) {
        deliver(valid.jwt);
        emit('done');
        return { jwt: valid.jwt, username: valid.username };
      }
    }
```

`packages/server-core/src/sessions/SessionManager.ts` — in `attemptAuthRetry`'s `setImmediate` block, BEFORE step "1. Reset summarization client" (line ~19883), insert:

```ts
        // 0. A gateway 401 means the cached JWT was rejected server-side —
        // re-mint through dp before the new agent re-reads the creds file,
        // or the retry replays the exact token that just failed.
        await this.refreshGatewayAuthForRetry(managed)
```

and add the helper (near the other dp members, e.g. below `probeDpSessionState`):

```ts
  /**
   * Best-effort, non-interactive JWT re-mint for gateway-backed connections.
   * Never throws: a signed-out dp fails silently and the retry then surfaces
   * the honest auth card instead of hanging the flow.
   */
  private async refreshGatewayAuthForRetry(managed: ManagedSession): Promise<void> {
    try {
      const connection = this.resolveManagedLlmConnection(managed)
      if (!connection) return
      const gatewayBacked =
        (connection.providerType === 'claude-runtime' || connection.providerType === 'pi_compat')
        && (!connection.baseUrl || isNessyGatewayBaseUrl(connection.baseUrl))
      if (!gatewayBacked) return
      await ensureNessyGatewayAuth({ interactive: false, forceRefresh: true })
    } catch {
      // best-effort — the retry itself reports the real failure
    }
  }
```

`resolveManagedLlmConnection` stands for however SessionManager already resolves the connection record behind `managed.llmConnection` (the slug lives at `ManagedSession.llmConnection`, `SessionManager.ts:1625`; find the existing accessor with `rg -n "llmConnection" packages/server-core/src/sessions/SessionManager.ts` — do NOT invent a second lookup; reuse the one `sendMessage`/agent-construction uses). Import `ensureNessyGatewayAuth` from the shared dp module and `isNessyGatewayBaseUrl` from the shared agent backend export.

`apps/electron/src/main/handlers/nessy-auth.ts` — the explicit Sign-in path (`createGatewayAuthController`'s `ensure()` invoked by `NESSY_GATEWAY_ENSURE_AUTH_CHANNEL`) passes `forceRefresh: true`; the silent launch path `ensureGatewayAuthForLaunch` keeps the warm path (startup must stay cheap).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/shared/src/auth/dp/ apps/electron/src/main/handlers/__tests__/gateway-login-check.test.ts`
Expected: ALL PASS (broker/e2e suites prove the default path is untouched).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck:all`
Expected: exit 0.

```bash
git add packages/shared/src/auth/dp/index.ts packages/server-core/src/sessions/SessionManager.ts apps/electron/src/main/handlers/nessy-auth.ts packages/shared/src/auth/dp/__tests__/index.test.ts docs/superpowers/plans/2026-08-18-dp-auth-resilience.md
git commit -m "fix(auth): gateway 401 retry and explicit Sign in re-mint the JWT instead of replaying the cache"
```

---

### Task 6: Seed gateway creds from nessy-cli's `oauth_creds.json`

**Files:**
- Modify: `packages/shared/src/auth/dp/creds-store.ts` (new read-only reader)
- Modify: `packages/shared/src/auth/dp/index.ts` (`runEnsure` step 2b + test seam option)
- Test: `packages/shared/src/auth/dp/__tests__/creds-store.test.ts`, `packages/shared/src/auth/dp/__tests__/index.test.ts` (extend both)

**Interfaces:**
- Consumes: `isJwtShaped` (T1), `decodeJwtClaims`, `saveCreds`, `EnsureGatewayAuthOptions.forceRefresh` (T5).
- Produces: `readCliOauthJwt(oauthPath?): { jwt: string } | null` exported from creds-store; `EnsureGatewayAuthOptions.oauthCredsPath?: string` (test seam, like `credsPath`).

**Why:** the current nessy-cli saves its Nestor JWT to `~/.nessy/oauth_creds.json` (`{access_token, expiry_date, token_type}`) and no longer maintains `dp_auth_creds.json` — so a cli-authenticated user often has a FRESH valid token in the cli's file while ours is stale/absent. Reading it as a seed makes such users work with zero clicks and zero dp execs.

**Hard rules — this is a SEED, not a second source of truth:**
1. **Never write `oauth_creds.json`** — it is the cli's file with its own multi-process locking (qwen sharedTokenManager); we only read.
2. The seeded JWT is **persisted into OUR `dp_auth_creds.json` via the existing `saveCreds`** (the dp module is the allowed writer), so the adapter/electron/Pi readers keep exactly one file to read — no second lookup anywhere else.
3. The seed is consulted ONLY in `runEnsure`, after our own warm path misses, and **never under `forceRefresh`** (a just-rejected token means "mint fresh through dp", not "try another cache").
4. A token is accepted only if it looks like a NESTOR JWT: 3-segment shape, unexpired, decodable claims with a non-empty `preferred_username`, and the file carries **no `resource_url`** — `resource_url` marks a qwen-device-flow token from the same shared store, which our gateway would reject.

- [ ] **Step 1: Write the failing tests**

`creds-store.test.ts`:

```ts
describe('readCliOauthJwt', () => {
  const writeOauth = (name: string, body: unknown): string => {
    const p = join(tmpDir, name);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };
  // NESTOR_LIKE_JWT: build with the suite's jwt helper (test-jwt.ts) so the
  // payload carries preferred_username/sub/exp — a bare 'a.b.c' won't decode.

  test('accepts an unexpired nestor-like access_token', () => {
    const p = writeOauth('ok.json', { access_token: NESTOR_LIKE_JWT, expiry_date: Date.now() + 86_400_000, token_type: 'Bearer' });
    expect(readCliOauthJwt(p)?.jwt).toBe(NESTOR_LIKE_JWT);
  });

  test('rejects a qwen token (resource_url present)', () => {
    const p = writeOauth('qwen.json', { access_token: NESTOR_LIKE_JWT, expiry_date: Date.now() + 86_400_000, resource_url: 'portal.qwen.ai' });
    expect(readCliOauthJwt(p)).toBeNull();
  });

  test('rejects expired / non-JWT / missing file', () => {
    expect(readCliOauthJwt(writeOauth('exp.json', { access_token: NESTOR_LIKE_JWT, expiry_date: Date.now() - 1 }))).toBeNull();
    expect(readCliOauthJwt(writeOauth('junk.json', { access_token: 'ory-opaque-token', expiry_date: Date.now() + 86_400_000 }))).toBeNull();
    expect(readCliOauthJwt(join(tmpDir, 'absent.json'))).toBeNull();
  });
});
```

`index.test.ts`:

```ts
test('warm miss + valid cli oauth seed: returns seeded jwt and persists it to our creds file', async () => {
  const credsPath = join(tmpDir, 'empty-dp-creds.json'); // absent file
  const oauthCredsPath = writeOauthFixture(NESTOR_LIKE_JWT); // as above
  const result = await ensureNessyGatewayAuth({ credsPath, oauthCredsPath, sessionBroker: throwingBroker });
  expect(result.jwt).toBe(NESTOR_LIKE_JWT);
  expect(JSON.parse(readFileSync(credsPath, 'utf8')).jwt).toBe(NESTOR_LIKE_JWT); // seeded into OUR file
});

test('forceRefresh skips the oauth seed and goes to dp', async () => {
  const credsPath = join(tmpDir, 'empty-dp-creds2.json');
  const oauthCredsPath = writeOauthFixture(NESTOR_LIKE_JWT);
  const result = await ensureNessyGatewayAuth({
    credsPath, oauthCredsPath, forceRefresh: true,
    exchangeUrl: stubExchangeUrl, sessionBroker: fakeReadyBroker, // yields NEW_JWT
  });
  expect(result.jwt).toBe(NEW_JWT);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/shared/src/auth/dp/__tests__/creds-store.test.ts packages/shared/src/auth/dp/__tests__/index.test.ts`
Expected: FAIL — `readCliOauthJwt` does not exist; seed test falls through to the throwing broker.

- [ ] **Step 3: Implement**

`creds-store.ts` (imports: add `decodeJwtClaims` alongside T1's `isJwtShaped` from `./jwt.ts`):

```ts
/** nessy-cli's OAuth store, same directory as our creds file. READ-ONLY for us. */
export function getOauthCredsPath(): string {
  return join(homedir(), '.nessy', 'oauth_creds.json');
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
  if (typeof jwt !== 'string' || !isJwtShaped(jwt)) return null;
  const expiryDate = data.expiry_date;
  if (typeof expiryDate !== 'number' || expiryDate <= Date.now()) return null;
  try {
    if (!decodeJwtClaims(jwt).username) return null;
  } catch {
    return null;
  }
  return { jwt };
}
```

`index.ts` — add `oauthCredsPath?: string` to `EnsureGatewayAuthOptions` (doc: "Seed-file path override — dependency-injection seam for tests only."), destructure it in `runEnsure`, and insert AFTER the warm path (2), inside the same `if (!forceRefresh)` umbrella that T5 introduced:

```ts
      // (2b) seed from nessy-cli's oauth_creds.json: the current cli keeps its
      // Nestor JWT there and no longer maintains dp_auth_creds.json. Adopted
      // tokens are persisted into OUR file so every other reader (adapter,
      // electron prefill, Pi env) keeps a single file to read. The cli's file
      // itself is never written. Skipped under forceRefresh — a just-rejected
      // token calls for a fresh dp mint, not another cache.
      const seeded = readCliOauthJwt(oauthCredsPath);
      if (seeded) {
        try {
          const claims = decodeJwtClaims(seeded.jwt);
          saveCreds(
            { jwt: seeded.jwt, expiresAt: claims.expiresAtMs, username: claims.username, userId: claims.userId },
            credsPath,
          );
          deliver(seeded.jwt);
          emit('done');
          return { jwt: seeded.jwt, username: claims.username };
        } catch {
          // fall through to the dp flow
        }
      }
```

(`decodeJwtClaims` and `saveCreds` are already imported by `index.ts`; add `readCliOauthJwt` to the creds-store import.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/shared/src/auth/dp/`
Expected: ALL PASS, including the T5 forceRefresh suites and the untouched broker/e2e suites.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck:shared`
Expected: exit 0.

```bash
git add packages/shared/src/auth/dp/creds-store.ts packages/shared/src/auth/dp/index.ts packages/shared/src/auth/dp/__tests__/creds-store.test.ts packages/shared/src/auth/dp/__tests__/index.test.ts docs/superpowers/plans/2026-08-18-dp-auth-resilience.md
git commit -m "feat(auth): seed gateway creds from nessy-cli's oauth_creds.json (read-only, validated)"
```

---

### Task 7: Gateway-aware auth error card

**Files:**
- Modify: `packages/shared/src/agent/claude-sdk-error-mapper.ts:287-301` (the `authentication_failed` 401 branch)
- Modify: `packages/shared/src/agent/claude-agent.ts:4903-4907` (thread `providerType`)
- Test: `packages/shared/src/agent/__tests__/claude-sdk-error-mapper.test.ts` (extend)

**Interfaces:**
- Consumes: `ClaudeSdkErrorContext.providerType` (field already exists at `claude-sdk-error-mapper.ts:15`; the call site simply never passes it).
- Produces: on `providerType === 'claude-runtime'`, the 401 card explains the gateway sign-in instead of "API key". All other providerTypes keep today's wording byte-for-byte.

**Scope note:** a `claude-runtime` connection with a custom (BYO) endpoint would also get the gateway wording; the details line below covers that case explicitly, and distinguishing them for real would need the driver's upstream classification threaded through the agent — out of scope here (record as deviation category `ux-copy-approximation` if a reviewer asks).

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/agent/__tests__/claude-sdk-error-mapper.test.ts`, add (mirroring the file's existing invocation fixtures):

```ts
test('authentication_failed on claude-runtime names the gateway sign-in, not an API key', () => {
  const error = mapClaudeSdkAssistantError('authentication_failed', {
    actualError: null,
    capturedApiError: { status: 401, message: 'fail parse token claims', timestamp: 0 } as LastApiError,
    providerType: 'claude-runtime',
  });
  expect(error.code).toBe('invalid_api_key');
  expect(error.message).toContain('Nessy Gateway');
  expect(error.message).not.toContain('API key');
});

test('authentication_failed elsewhere keeps the API-key wording', () => {
  const error = mapClaudeSdkAssistantError('authentication_failed', {
    actualError: null,
    capturedApiError: null,
  });
  expect(error.message).toContain('API key');
});
```

(Adjust the `LastApiError` literal to the fields the existing tests in this file use — copy their fixture shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/agent/__tests__/claude-sdk-error-mapper.test.ts`
Expected: first new test FAILS on the message assertion.

- [ ] **Step 3: Implement**

In the `case 'authentication_failed':` branch (AFTER the existing 403 early-return, which must stay untouched):

```ts
    case 'authentication_failed':
      if (context.providerType === 'claude-runtime') {
        return {
          code: 'invalid_api_key',
          title: 'Authentication Failed',
          message: 'Your Nessy Gateway sign-in is missing or expired. Open Settings → AI and click Sign in on the gateway card.',
          details: [
            'This connection authenticates through the one-click Nessy Gateway sign-in — it has no API key.',
            'Using a custom endpoint on this card? Check that endpoint\'s own credentials instead.',
          ],
          actions: [
            { key: 's', label: 'Settings', action: 'settings' },
            { key: 'r', label: 'Retry', action: 'retry' },
          ],
          canRetry: true,
          retryDelayMs: 1000,
          providerInfo,
        };
      }
      return {
        // ... existing object, byte-for-byte unchanged ...
      };
```

In `claude-agent.ts:4903`, add the field to the context object:

```ts
    const error = mapClaudeSdkAssistantError(errorCode, {
      actualError,
      capturedApiError,
      providerType: this.config.providerType,
      userTurnHadAttachments: this.lastTurnHadAttachments,
    });
```

(If `this.config.providerType` is not the field's exact name in `BackendConfig`, find it with `codegraph explore "BackendConfig providerType claude-agent"` — the invariant: the same value `getBackendRuntime(this.config)` sees. Do not invent a new plumb.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/shared/src/agent/__tests__/claude-sdk-error-mapper.test.ts`
Expected: ALL PASS, including all pre-existing mapper cases (403 guardrail case in particular).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck:shared`
Expected: exit 0.

```bash
git add packages/shared/src/agent/claude-sdk-error-mapper.ts packages/shared/src/agent/claude-agent.ts packages/shared/src/agent/__tests__/claude-sdk-error-mapper.test.ts docs/superpowers/plans/2026-08-18-dp-auth-resilience.md
git commit -m "fix(errors): gateway-card 401s point at the one-click sign-in, not a nonexistent API key"
```

---

### Task 8: Outdated-dp hint on the failed-servers banner

**Files:**
- Modify: `packages/shared/src/protocol/dto.ts:1067-1090` (`SafeWorkspacePendingAuth`: add optional field)
- Modify: `packages/server-core/src/sessions/pending-auth-summary.ts` (input + output)
- Modify: `packages/server-core/src/sessions/SessionManager.ts:4532` (`getWorkspacePendingAuth`: supply the flag)
- Modify: `apps/electron/src/renderer/components/app-shell/PendingAuthNotice.tsx` (render the hint)
- Modify: `packages/shared/src/i18n/locales/en.json`, `packages/shared/src/i18n/locales/ru.json`
- Test: the existing pending-auth summary test file (`rg -l "buildPendingAuthSummary" packages/server-core --glob '*.test.ts'` names it) and `apps/electron/src/renderer/components/app-shell/__tests__/PendingAuthNotice.test.tsx`

**Interfaces:**
- Produces: `SafeWorkspacePendingAuth.dpOutdated?: boolean`; `PendingAuthSummaryInput.dpOutdated?: boolean` (default absent → field omitted, so every existing caller/test keeps exact behavior).
- Consumes: `dpSessionBroker.probe()` state (`DpSessionState` already carries `version` + `outdated` — `packages/shared/src/auth/dp/session-broker.ts:10-14`); `SessionManager` already owns `this.dpSessionBroker`.

**Why:** measured — an unauthenticated CURRENT dp connects fine, so a mass "Failed to connect" over dp servers means an outdated/broken dp binary; the banner must say so instead of listing 24 opaque names. The broker's probe is cached (5s TTL) and value-only.

- [ ] **Step 1: Write the failing tests**

Summary test (in the existing `buildPendingAuthSummary` suite):

```ts
test('dpOutdated rides through when set and failed servers exist', () => {
  const summary = buildPendingAuthSummary({
    workspaceId: 'w', snapshotEntries: [], materializedSources: [],
    externalAuthRequirements: [], failedSlugs: ['dpJira'], dpOutdated: true,
  });
  expect(summary.dpOutdated).toBe(true);
  expect(summary.failedServers).toEqual(['dpJira']);
});

test('dpOutdated stays absent by default', () => {
  const summary = buildPendingAuthSummary({
    workspaceId: 'w', snapshotEntries: [], materializedSources: [],
    externalAuthRequirements: [], failedSlugs: [],
  });
  expect(summary.dpOutdated).toBeUndefined();
});
```

Renderer test (in `PendingAuthNotice.test.tsx`, mirroring its existing render fixtures): a summary with `failedServers: ['dpJira']` and `dpOutdated: true` renders the text of `pendingAuth.dpOutdated`; with `dpOutdated` absent it does not.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/server-core/src/sessions/ apps/electron/src/renderer/components/app-shell/__tests__/PendingAuthNotice.test.tsx`
Expected: new tests FAIL (unknown field / missing text).

- [ ] **Step 3: Implement**

`dto.ts` — inside `SafeWorkspacePendingAuth`, after the `dp?` member:

```ts
  /**
   * True when the resolved dp binary reports a version below DP_MIN_VERSION.
   * Rendered as an update hint next to failedServers: an outdated dp lacks
   * `dp ai mcp`, so every builtin dp server fails connect regardless of login.
   */
  dpOutdated?: boolean
```

`pending-auth-summary.ts` — add `dpOutdated?: boolean` to `PendingAuthSummaryInput`; in the return object add:

```ts
    ...(input.dpOutdated ? { dpOutdated: true } : {}),
```

`SessionManager.getWorkspacePendingAuth` — where the method assembles `buildPendingAuthSummary` input, add:

```ts
    let dpOutdated = false
    try {
      const dpState = await this.dpSessionBroker.probe()
      dpOutdated = 'outdated' in dpState && dpState.outdated === true
    } catch {
      // advisory only — the banner must render without dp
    }
```

and pass `dpOutdated` into the input object. (`probe()` is cached 5s and never throws by contract, the try is belt-and-suspenders.)

`PendingAuthNotice.tsx` — inside the existing `failedServers.length > 0` list item block, append a second line:

```tsx
        {summary.failedServers.length > 0 && summary.dpOutdated && (
          <li data-testid="pending-auth-dp-outdated">
            {t('pendingAuth.dpOutdated')}
          </li>
        )}
```

i18n — `en.json` (alphabetical, between `pendingAuth.dpSigningIn` and `pendingAuth.error`… verify order with the sorted linter):

```json
  "pendingAuth.dpOutdated": "Spirit CLI (dp) is outdated and cannot run these servers — update dp, then reopen the workspace.",
```

`ru.json`:

```json
  "pendingAuth.dpOutdated": "Spirit CLI (dp) устарел и не может запустить эти серверы — обновите dp и переоткройте воркспейс.",
```

- [ ] **Step 4: Run tests + i18n gates**

Run: `bun test packages/server-core/src/sessions/ apps/electron/src/renderer/components/app-shell/__tests__/PendingAuthNotice.test.tsx && bun run lint:i18n:parity && bun run lint:i18n:sorted`
Expected: ALL PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck:all`
Expected: exit 0.

```bash
git add packages/shared/src/protocol/dto.ts packages/server-core/src/sessions/pending-auth-summary.ts packages/server-core/src/sessions/SessionManager.ts apps/electron/src/renderer/components/app-shell/PendingAuthNotice.tsx packages/shared/src/i18n/locales/en.json packages/shared/src/i18n/locales/ru.json apps/electron/src/renderer/components/app-shell/__tests__/PendingAuthNotice.test.tsx docs/superpowers/plans/2026-08-18-dp-auth-resilience.md
git commit -m "feat(sources): failed-servers banner names an outdated dp as the cause"
```

(Also add the server-core summary test file to the `git add` list — its path is discovered in Step 1.)

---

### Task 9: Close-out — regression, version bump, release notes, docs-site

**Files:**
- Modify: `package.json:3` and `apps/electron/package.json` (version `1.30.0` → `1.30.1`, lockstep)
- Create: `apps/electron/resources/release-notes/1.30.1.md`
- Modify: the `docs-site/` page covering gateway sign-in / troubleshooting (locate with `rg -il "dp auth|gateway" docs-site/` and update the closest page; if none covers troubleshooting, add a section to the gateway/auth page)
- Modify: this plan's Tracker (final sweep)

- [ ] **Step 1: Full regression (risk trigger: auth boundary touched)**

```bash
rm -rf release
bun run typecheck:all && bun run lint && bun run lint:i18n:parity && bun run lint:i18n:sorted && bun run test:shared:all && bun test
```

Expected: exit 0 on each; compare any failure against `docs/superpowers/specs/2026-07-29-known-failing-tests.md` AND against `master`'s latest pipeline before recording it as new. No concurrent `bun test` processes.

- [ ] **Step 2: Version bump + release notes**

Bump BOTH `package.json` files to `1.30.1`. Create `apps/electron/resources/release-notes/1.30.1.md` in the house style (`# Nessy Desktop 1.30.1`, date line, sections):

```markdown
# Nessy Desktop 1.30.1

*2026-08-XX*

## FIXED

- Gateway sign-in recovers by itself when `~/.nessy/dp_auth_creds.json` contains a broken token (previously an endless 401 "token is malformed" loop).
- After a gateway 401, the retry re-issues the token through Spirit CLI (dp) instead of replaying the rejected one; the Sign in button now always issues a fresh token.
- Users signed in through nessy-cli are picked up automatically: a valid token from the cli's `oauth_creds.json` seeds the desktop sign-in.
- Signing in no longer fails when the Spirit CLI (dp) prints an update warning.
- The 401 error card on the Nessy Gateway Claude card now points at the one-click Sign in instead of a nonexistent API key.

## IMPROVED

- When built-in dp servers fail to connect because Spirit CLI (dp) is outdated, the notice now says so and suggests updating dp.
```

(Fill the real date; never edit older release-notes files.)

- [ ] **Step 3: docs-site**

Add a short "Gateway sign-in troubleshooting" subsection to the located page with the four diagnostic commands and expected outputs:

```bash
dp version                      # must be >= 13.x
dp auth print-token | wc -l     # must print exactly 1
dp ai mcp jira                  # must stay running (Ctrl-C to exit), not error out
```

plus "if broken: update dp → delete `~/.nessy/dp_auth_creds.json` → click Sign in on the gateway card".

- [ ] **Step 4: Tracker sweep + final commit**

Mark every tracker row `✅` with its commit sha. Then:

```bash
git add package.json apps/electron/package.json apps/electron/resources/release-notes/1.30.1.md docs-site docs/superpowers/plans/2026-08-18-dp-auth-resilience.md
git commit -m "chore(release): 1.30.1 — dp auth resilience close-out"
```

---

## Self-review notes (written at planning time)

- Spec coverage: symptom 1 (401 loop) → T1+T2+T3 (malformed cache self-heals) + T5 (rejected cache re-mints on 401 — nessy-cli parity) + T4 (re-mint survives dp banners) + T6 (cli-authenticated users seed from `oauth_creds.json`, read-only) + T7 (honest card); symptom 2 (mass MCP failure) → T8 (named cause). The wiki instruction itself is outside this repo — flagged separately to the owner.
- Deliberately NOT copied from nessy-cli: its managed dp binary (the cli downloads a pinned dp 13.14.1 to `~/.nessy/dp_latest` with its OWN `DP_WORKDIR` and re-downloads on failure — `dpDownloader.ts`/`dpConfig.ts`). Our frozen owner decision is system-dp-only (`dp-binary.ts`: "NO downloader"); copying the cli would also give users a SECOND dp session (separate browser login) while our dp-MCP servers run on the system dp's session. `resolveDpBinary` remains the single seam if the owner ever revisits this.
- Type consistency: `isJwtShaped(value: string): boolean` is the single shared name (T1 producer; T3 consumer; T2 duplicates by constraint). `SafeWorkspacePendingAuth.dpOutdated` matches `PendingAuthSummaryInput.dpOutdated`.
- Deliberately NOT done: no new writer/deleter of the creds file (an auto-delete of garbage would race nessy-cli); no `Nestor-Token` skip in `nestor-client.ts:85` (unreachable once T2 lands — the gate answers first); no in-chat dp AuthRequest for the LLM path (the mid-turn dp card exists only for MCP requirements; extending it to LLM auth is a product decision, not a fix).
