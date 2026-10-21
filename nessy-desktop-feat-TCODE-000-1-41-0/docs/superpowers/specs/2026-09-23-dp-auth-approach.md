# Nessy Desktop sign-in after F1.1–F1.3/F1.5 — how nessy-cli does it, how we do it, what dp stores (2026-09-23)

Read-only research workflow `dp-auth-approach-research` (run wf_af1a8e67-d7d, controller session 19f4e787): three readers — nessy-cli at local HEAD `11b095a7d`, this repo's `packages/shared/src/auth/dp/`, and the `dp` CLI (13.60.0 installed; RQ-dp-device's reading of 13.50.0) — then one synthesis. No credential value was printed or recorded: key names, token shapes and lifetimes only. Owner question (2026-09-23): *the platform team cannot be contacted — do it the way nessy-cli does, or rely on the key `dp auth login` stores on the user's machine; find the best way.* Controller decision below the synthesis.


## A. Summary of the facts

**The owner's two options already describe the same mechanism.** nessy-cli signs users in with the key that `dp auth login` stores. The only difference between the two products is which dp working directory each one uses. Nessy Desktop already relies on that key today.

**How nessy-cli logs users in** (HEAD `11b095a7d`)
- Every startup, every `/auth`, and every ACP `authenticate`, `newSession` or `loadSession` call runs `Config.refreshAuth(DP_AUTH)` → `performNessyAuth` (`core/src/dp/dpAuthService.ts`).
- The order inside that call:
  1. `tryAuthFromEnv`: the `NESSY_CLI_DP_AUTH_TOKEN` env token.
  2. `ensureDpPresence`: downloads dp 13.14.1 with an md5 check if it is missing, then always runs `dp update`.
  3. `dp auth print-token` (30 s).
  4. If there is no token, `dp auth login` runs automatically, with a hard 60 s limit. It requires stdout to match `user ".*" successfully authorized` and sets `BROWSER=wslview` under WSL (`dpApi.dpLogin`).
  5. `print-token` again.
  6. `POST /api/v2/token` with `Bearer <dp token>` and body `{}` (`dpTokenExchangeClient.exchangeToken`).
- Every dp spawn uses a private `DP_WORKDIR=~/.nessy/dp_latest` (`dpApi.buildEnv`).
- The JWT is written to `oauth_creds.json` (`cacheNessyCredentials`) and never read back, so it is re-minted on every run.
- On a 401 or 403 it re-mints once and retries (`DpContentGenerator.isAuthError`).
- nessy-cli never shows a URL or code. dp opens the browser itself, and the UI shows only a spinner (`DpAuthProgress`).
- The only headless route is `NESSY_CLI_DP_AUTH_TOKEN`: a Spirit-IAM delegated JWT, sent as Bearer, kept in memory only (`buildNestorAuthHeaders`).
- The device-flow client in `qwen/qwenOAuth2.ts` is dead code. It is a renamed Qwen client whose host is the placeholder `DP_AUTH_BASE_URL='https://----'`, and nothing wires it to DP_AUTH.

**How Nessy Desktop does it today**
- Sign-in happens only on a click. The onboarding step, the banner, Settings → Reconnect and the in-chat card all lead to `nessy-auth.ts` `runForcedThenFallback` or `SessionManager.runDpAuthEnsure`, and then to `session-broker.ts` `startRun`.
- `startRun` runs `dp version` and `print-token`. If a login is needed it runs `dp auth login` with a 5 min limit, then `print-token` again, then the same `/api/v2/token` exchange (`exchange.ts` `exchangeDpToken`).
- The dp binary comes from a ladder (`dp-binary.ts` `resolveDpRuntime`): `NESSY_DP`, then the system dp, then our own copy (inert), then nessy-cli's `dp_latest` copy used read-only.
- The workdir comes from `resolveManagedWorkdir`: an explicit `DP_WORKDIR`, otherwise the user's own `~/.dp` if it exists, otherwise `<CONFIG_DIR>/dp/state`.
- The JWT is cached in `~/.nessy/dp_auth_creds.json` (`creds-store.ts` `saveCreds`). It lives about 2 years, so dp is only needed for the first sign-in and after a 401.
- Other routes: we seed from nessy-cli's `oauth_creds.json` (`readCliOauthJwt`), and the env token `NESSY_DP_AUTH_TOKEN` is exchanged (`env-token.ts` `tryEnvToken`).
- We never set `BROWSER`, and non-interactive callers are refused (`InteractiveLoginUnavailable`).

**Gaps in Nessy Desktop today**
- The banner (`computeGatewayBannerView`) and onboarding (`GatewayConnectStep`) show a specific message only for `DpNotFound`. Every other failure becomes "Sign-in failed. Please try again."
- Settings → Reconnect gives no feedback when it fails.
- `dp-api.ts` recognises only one of dp 13.60.0's two needs-login messages ("no access token found…"). The other, "access token not found. you should relogin", is not matched.

**What dp stores on the machine**
- `$DP_WORKDIR` or `~/.dp/access_token.json`: plaintext JSON at mode 0600. Shape: `{tokens:[{token, refresh_token, created_at, expires_at, refresh_expires_at, subject{id,type,name}, type}]}`.
- Two opaque Ory tokens: the access token (`ory_at_`) lives 1 h; the refresh token (`ory_rt_`) lives 30 days, restamped by dp itself.
- There is no keychain. Lock files (`refresh.lock`, `lock`, `dp.lock`) coordinate through gofrs/flock. There is no schema version marker.
- A logged-out file looks like `{"tokens":[]}`.
- dp 13.60.0 (installed today by device management) adds `dp auth ensure`, which does "reuse or refresh, else open the browser, one login across processes". Versions 13.27.0 and 13.4.2 do not have it; whether 13.50.0 does is **unknown**.
- On this machine, 34 `dp ai mcp` processes keep `~/.dp` fresh. nessy-cli's private session in `~/.nessy/dp_latest` is **expired** (last written Jul 12), so nessy-cli's next run will open a browser.

**Unknown, not established by any report:**
- whether `print-token` refreshes silently (very likely, but not proven);
- which needs-login message dp prints once the refresh token has expired;
- whether dp writes `access_token.json` atomically;
- whether `/api/v2/token` accepts a service-account dp token;
- whether the gateway accepts `NESSY_CLI_DP_AUTH_TOKEN` as Bearer (the reason is stated only in a nessy-cli code comment);
- the output, exit and timeout behaviour of `dp auth ensure`.

## B. Options matrix

**Constraint on every option:** nessy-cli's telemetry (`ErrorClient`, `dpModelsClient`, `dlh-client`, `statistClient`) reads our `dp_auth_creds.json`, and nessy-cli never writes that file. Keep its shape and keep writing it.

### 1. Mirror nessy-cli exactly
Own dp download, private workdir, automatic login at start and on 401, 60 s limit, `dp update` on every auth.
- **User, desktop:** a second browser login separate from the user's `~/.dp`, and a browser opens without a click. That reverses target-scheme clause 2 (owner, 2026-09-12). A slow SSO fails after 60 s. The session goes stale when nothing else uses it (measured: nessy-cli's copy has expired on this machine).
- **User, no visible browser:** no improvement. The login fails after 60 s.
- **Code:** L. It needs `ensureManagedDp` wired plus a pin, a private workdir, auto-login triggers, and `dp update` in the auth path. It also means removing today's cached-JWT start.
- **What can break:** the download host and pin, the x86_64-only binary running under Rosetta on arm64, `dp update` taking up to 2 × 5 min inside auth, and md5-only verification.
- **Parity:** full.
- **Security:** a second dp session means a second refresh token on disk. It downloads and runs a binary at runtime, against the owner's "no CLI in the dmg" decision (2026-09-17).
- **Plan rows:** F1.5 becomes a build row; F1.2 and F1.3 are unchanged.

### 2. Read `~/.dp/access_token.json` directly and exchange it, without spawning dp
- **User:** mostly the same as today, about 0.4 s faster, and it still works when our dp cannot run but another dp process keeps the token fresh. The access token lives only 1 h, so dp is still needed for refresh and login. This is a fast path, not a replacement.
- **Code:** M. It needs entry selection copied from dp's `LoadLatestToken` (inferred from the name), a 5 min expiry margin, a retry for torn reads, and a fallback to dp.
- **What can break:** there is no schema version. The 7 keys have been stable from 13.27.0 to 13.60.0, but nothing promises that, and other dp state files have changed shape. It could also pick a service-account entry.
- **Parity:** none. nessy-cli always spawns `print-token`, and only its container script (`deploy/async/entrypoint.sh`) reads the file.
- **Security:** the process loads the 30-day refresh token, which covers the user's whole Developer Platform identity, into memory. It must **never** refresh or write the file, because Hydra's default rotation (not measured on this IAM) would log dp out and break every `dp ai mcp` server.
- **Owner decision:** this changes target-scheme clause 3 ("read the key only through `print-token`").
- **Plan rows:** none closed; it would be a new row.

### 2b. Read only the metadata of that file, to explain *why* a login is needed
Check whether `tokens` is empty and whether `refresh_expires_at` has passed.
- **Benefit:** transparency only.
- **Code:** S.
- **Security:** the same concern as option 2, because reading the file still loads the refresh token.
- **Better route:** the same distinction may come from `print-token`'s two messages; see question D1. Hold this option until D1 is answered.

### 3. Keep spawning dp against the user's `~/.dp`, and align the cheap parts with nessy-cli
- **What it adds:**
  - the second needs-login message;
  - `BROWSER` capture of the authorization URL (F1.2), following nessy-cli's `wslview` precedent;
  - per-code reasons in the banner, onboarding and Settings;
  - optionally, dp's own workdir default when `~/.dp` does not exist yet (row F1.new-d).
- **User, desktop:** the same one click as today, plus the reason and the next step shown on every surface. The URL appears in the app, so a browser tab that never showed up can be opened by hand.
- **User, no visible browser:** they see the URL instead of waiting 5 minutes. The OAuth callback still lands on `localhost:25565` of the machine running dp, so true headless still needs the env token.
- **Code:** about M in total, split into XS + S + S rows.
- **What can break:** `dp auth login`'s `BROWSER` contract (measured in 13.50.0 source; 13.60.0 checked only by strings) and dp's message texts.
- **Parity:** same exchange, same `print-token` contract, same `BROWSER` lever, same 401 re-mint.
- **Deliberate differences, each with a reason:**
  - no auto-login (clause 2);
  - shared `~/.dp` instead of a private workdir (no second session);
  - cached JWT (it lives 2 years).
- **Security:** unchanged. We never open dp's store.
- **Plan rows:** closes F1.1 and F1.3, un-gates F1.2, and turns F1.5 into "record inert".

### 4. `dp auth ensure` on the Sign-in path (an add-on to option 3)
Version-gated; falls back to `dp auth login` where the command is absent.
- **User:** dp's own cross-process single-flight, so no collision on port 25565 with other dp logins, and the saved token is reused or refreshed before any browser opens.
- **Code:** S.
- **What can break:** it exists only from some version at or before 13.60.0 and is absent on nessy-cli's 13.27.0 copy (ladder rung 4). Its output, exit codes and timeout behaviour are **unknown** (D3).
- **Parity:** goes beyond nessy-cli, which does not use it.
- **Native-first:** yes; it is dp's own mechanism.
- **Plan rows:** a new row, gated on D3.

### 5. Service account (`dp auth service-acc --key-file`) for headless machines
- **Status:** unverified that `/api/v2/token` accepts a service-account token. **Unknown**, so this stays a measurement (D6), not a row.

## C. Recommendation

**Option 3, with option 4 added once D3 is measured.** Close F1.1 and F1.3, and keep F1.5 inert.

**Why**
- **Native-first:** it keeps using dp's own session in dp's own default location, which is literally "the key `dp auth login` stores". nessy-cli reads the same key, just from a private copy.
- **Least code:** every piece is XS or S, and nothing is downloaded.
- **Parity:** every contract nessy-cli has that fits a desktop app is kept or adopted. We decline only the pieces measured to cost the user: the second login, the expired private session, the 60 s limit and `dp update` in the auth path.
- **Transparent:** the reason and the next step reach every surface, not just the in-chat card.
- **Read-don't-invent:**
  - the device flow is closed by evidence, not by preference: dp exposes no device flag, and nessy-cli's client points at a placeholder host;
  - the `BROWSER` hook is backed by nessy-cli's own use of it.

**Rows to paste** (numbering and sorted position are the controller's; `F1.new-*` are placeholders):

- **F1.1 | XS | Close as impossible (owner 2026-09-23: the platform team cannot be reached).**
  Note: this records a null. The device-flow host is unknown and no other source has it:
  - nessy-cli `qwen/qwenOAuth2.ts` `DP_AUTH_BASE_URL` is a placeholder at `11b095a7d`;
  - its callers `getNessyAuthClient` and `authWithNessyDeviceFlow` have no users outside that file;
  - `nessy serve`'s `NessyOAuthDeviceFlowProvider` posts to the placeholder;
  - the device path `/api/v1/oauth2/device` occurs 0 times in dp 13.60.0, against 1 for the auth path (the control), and `dp auth login --help` lists no options.

  No code change.

- **F1.3 | XS | Close as blocked for good; the residue is recorded.**
  Note: there is no base URL and no client id of our own, and dp's RFC 8628 strings are dead library code (`DeviceAuthURL` is never set). The headless route stays `NESSY_DP_AUTH_TOKEN` (`env-token.ts` `tryEnvToken`). Reopen only if a device-flow host appears in dp or nessy-cli source.

- **F1.2 | S | Un-gate. Capture dp's authorization URL through `BROWSER` and show it in the Sign-in UI.**
  Note: question 4 is answered by precedent (nessy-cli `dpApi.ts` `dpLogin` sets `BROWSER=wslview`).
  - `dpExecEnv` points `BROWSER` at a temporary helper for `login` only.
  - The helper writes argv[1] to a 0600 file, then forwards the URL to the user's original `$BROWSER`, or to `/usr/bin/open` on macOS, so the tab still opens. It exits 0 inside dp's 3 s window.
  - A new broker status carries the URL. `ensure`'s contention branch hands the running login's URL to a waiting caller.
  - Scope limit, stated in the UI: the callback returns to `localhost:25565` on the machine running dp.
  - Controls:
    - (+) a fake dp that invokes `$BROWSER <url>`: the status carries the URL and the forwarder is called once;
    - (−) a fake dp that never invokes `$BROWSER`: no URL status, and the existing timeout path is unchanged;
    - (boundary) a user-set `BROWSER` is the forward target, not overwritten.
  - Logs must never contain the URL's query string.

- **F1.5 | XS | Record that it stays inert; no download.**
  Note: `ensureManagedDp` stays uncalled.
  - The system dp is managed by corporate device management (replaced 13.50.0 → 13.60.0 on 2026-09-23), and nessy-cli's copy is already rung 4.
  - nessy-cli's download model is x86_64-only, md5-pinned and runs `dp update` in the auth path, which conflicts with the owner's "no CLI in the dmg" (2026-09-17).
  - Reopen trigger: `DpNotFound` observed at a live sitting on a fresh corporate machine.

- **F1.new-a | XS | Treat dp 13.60.0's second needs-login message as needs-login.**
  Note: `dp-api.ts` matches only "no access token found, you need to authorize…". Add "access token not found. you should relogin". Both strings are measured in the 13.60.0 binary with `grep -aoF`.
  - Controls:
    - (+) a fake dp printing each message → `NeedsLogin`;
    - (−) an unrelated stderr line with a non-zero exit → `ExecFailed`, not a login.
  - Update the row note once D1 settles which message dp prints when.

- **F1.new-b | S | Show the per-code sign-in reason on every surface.**
  Note:
  - Route the `chat.dpAuth.errors.<code>` sentences through `computeGatewayBannerView`, `GatewayConnectStep` `errorMessage`, and `AiSettingsPage` `handleReconnectGateway`, which must stop returning silently.
  - Add a next-step line where one exists: `DpNotFound` → corp IT; `NeedsLogin`/`LoginBrowserTimeout` → the Sign-in button plus the F1.2 URL.
  - Put keys in all locales; parity and sorted checks must stay green.
  - Controls:
    - (+) `LoginBrowserTimeout` renders its own sentence in the banner and onboarding;
    - (control) the `DpNotFound` text is unchanged;
    - (−) an unmapped code falls back to the generic sentence.

- **F1.new-c | S | Use `dp auth ensure` on the interactive Sign-in path when dp supports it; otherwise `dp auth login`. Gated on D3.**
  Note:
  - Detect support by probing `dp auth ensure --help` rather than by version, because 13.50.0 is unknown and rung 4 (13.27.0) does not have it.
  - Never use it on non-interactive paths, because it opens a browser.
  - Keep the current 5 min budget unless D3 shows dp has its own.
  - Controls:
    - (+) a fake dp with `ensure` → `ensure` is called and `login` is not;
    - (−) a fake dp without it → `login` is called;
    - (boundary) a non-interactive caller → neither is called.
  - Cite dp 13.60.0's `dp auth ensure --help` text in the note.

- **F1.new-d | XS→S | Workdir fallback when neither `DP_WORKDIR` nor `~/.dp` exists.**
  Note: `resolveManagedWorkdir` then uses `<CONFIG_DIR>/dp/state`, so a login we trigger is invisible to the user's terminal `dp` and to the `dp ai mcp` servers, which use dp's default `~/.dp`.
  - First read that function's docblock for the reason the fallback was chosen; none of the reports establishes one.
  - If there is no recorded reason, let dp use its own default.
  - Controls:
    - (+) a temporary HOME without `.dp` → the dp env carries no `DP_WORKDIR`;
    - (control) an explicit `DP_WORKDIR` is still honoured;
    - (control) an existing `~/.dp` is unchanged.

Options 1 and 2 are **not** recommended. Option 1 reverses clause 2 and doubles sessions without fixing the invisible-browser case. Option 2 reverses clause 3 and puts the refresh token into our process for about 0.4 s of saving.

## D. Questions for the next live sitting

For every probe, send stdout to `/dev/null` and record exit codes, stderr text, file timestamps, key names and statuses only, never token values.

1. **Which needs-login message dp prints, and when.**
   - Run `DP_WORKDIR=<fresh empty dir> dp auth print-token` and `DP_WORKDIR=~/.nessy/dp_latest dp auth print-token` (both tokens measured as expired there).
   - Observe: the exit code and the exact stderr sentence for "never logged in" versus "refresh token expired".
   - This decides F1.new-a's note and whether option 2b is needed at all.
2. **Does `print-token` refresh silently?**
   - Observe: `stat -f %m ~/.dp/access_token.json` and the `created_at` / `expires_at` of the `user` entry (timestamps only) before and after one `print-token`, run when `expires_at` is less than 5 min away.
   - If the timestamps move, it refreshes.
3. **`dp auth ensure` contract on 13.60.0.**
   - (a) With a valid session: exit code, stdout lines, stderr lines, and whether a browser opens (it should not).
   - (b) In an empty `DP_WORKDIR`: does a browser open, is `$BROWSER` honoured, does dp enforce its own timeout, and how does it exit on cancel?
   - (c) Two `ensure` runs at once in the same empty workdir: how many browser tabs open, and do both exit 0?
   - (d) If a 13.50.0 binary is available, does `dp auth ensure --help` exist?
4. **`BROWSER` hook on 13.60.0** (precondition for F1.2).
   - Set `BROWSER` to a helper that records only argv count and the URL's scheme, host and path.
   - Observe: is it called with the URL as argv[1], how long does dp wait before falling through, and does the login complete when the helper forwards to `/usr/bin/open`?
5. **What the user sees today with an invisible browser, in the packaged app.**
   - Case: a first login with the browser window hidden or in another Space.
   - Observe: the time until the message, and the exact text on the banner, the onboarding step and the card. This is the baseline for F1.new-b.
6. **Headless routes.** Owner-run, because they use the owner's own credentials.
   - (a) Service account: in a scratch `DP_WORKDIR`, run `dp auth service-acc --key-file …`, then `print-token`, then the `/api/v2/token` exchange. Record the HTTP status only.
   - (b) If a delegated token is obtainable: does the gateway accept `NESSY_CLI_DP_AUTH_TOKEN` as `Authorization: Bearer`? Record the status on `/cli/models`.
7. **Is dp always present?** On a freshly provisioned corporate machine: is there a `/usr/local/bin/dp`, and does our ladder report `DpNotFound`? This is F1.5's reopen trigger.
8. **Does the gateway ever answer 403 for a bad or revoked JWT?** nessy-cli re-mints on 403 and we do not. Observe the status for a syntactically valid but rejected JWT in a scratch creds file (no real value).

## Controller decision (2026-09-23, under delegation)

**Option 3** — keep spawning dp against the user's own `~/.dp` (which IS "the key `dp auth login` stores", read the way nessy-cli reads it: `dp auth print-token` → `/api/v2/token`), close the gaps in rows F1.360–F1.363 and F1.2, add option 4 (`dp auth ensure`, F1.362) once the sitting measures D3; close F1.1 and F1.3 as impossible, keep F1.5 inert. It keeps both earlier owner decisions (target scheme 2026-09-12: no auto-browser, the key read only through `print-token`) and the 2026-09-17 'no CLI in the dmg'. Options 1 and 2 declined for the reasons in §C.
