# dp auth research — user 401 diagnosis + nessy-cli key flow, their desktop, MCP transport pool

Date: 2026-08-22. Research only — no code changed. Produced by a 5-agent workflow
(4 researchers + 1 adversarial verifier, all on Opus); full agent reports are
Appendices A–E below. Verification score on the diagnosis: 30/33 claims
CONFIRMED, 1 REFUTED (C19, incorporated below), 2 confirmed-with-caveats.

## 1. Executive summary

1. **The user's 401 is the known "garbage non-JWT in `~/.nessy/dp_auth_creds.json`" class** we fixed in 1.30.1. The fix is present and byte-identical at HEAD, in `master` (1.31.0), and the **published mac dev feed already serves 1.31.0** (`dev-mac.yml` verified 200, releaseDate 2026-08-21). Windows/Linux dev channels appear unpublished (403 on every known metadata name — consistent with absence, not proof).
2. **The banner in the screenshot ("Your Nessy Gateway sign-in is missing or expired…") only exists ≥1.30.1**, so the user is (or recently was) on a fixed build — and the loop they see is the *post-fix honest* shape: the 401-path re-mint runs `interactive: false`, best-effort; if `dp` itself cannot mint (signed out / missing / too old), the turn fails again with the banner, once per message. Remediation is operational, not code: §2.4.
3. **The "Nessy Backend (API Key)" card has no API key** — its stored credential is a snapshot of the dp JWT taken at sign-in (`gateway-one-click.ts` → `setLlmApiKey`). Both of the user's connections authenticate with the same dp JWT.
4. **Two real code gaps survive 1.30.1 at HEAD** (§2.5): the Pi card's fallback to the *stored* JWT snapshot is unguarded and never refreshed, and `fetchNestorModels` sends the stored key with `?? ''`. Plus one new mechanism found by the verifier (N1): the ensure single-flight can swallow `forceRefresh`, converting one forced re-mint per message into a warm replay.
5. **nessy-cli has NO "dp mcp remote" flow — the premise was false.** Every dp MCP server there is plain stdio `dp ai mcp <sub>`; `Nestor-Token` is never attached to any MCP transport. What they *do* have is the F2 **McpTransportPool** (general MCP sharing/lifecycle). Our own pool is ahead of it overall; three hardening mechanisms are worth porting (§5). `dp ai mcp remote --url` is a concept only *our* repo has ever named — building on it is ours to design and is blocked on a real endpoint list from the dp/Spirit owners.
6. **nessy-cli's `packages/desktop` is not their code — it is a vendored sibling fork of openwork** (same craft-agents-oss lineage as us, ~40% of our LOC). It handles **zero** Nestor/dp credentials: all auth is delegated to the CLI over ACP (`lease.authenticate('dp-auth')`). Their fork discipline (`// [nessy-fork] <topic>` markers + sync script + version-check CI gate) is the single most copyable practice.

## 2. User 401 — diagnosis

### 2.1 Root cause chain (each link verified)

1. A non-JWT value (opaque Ory token — 1 segment — or a torn/legacy write) lands in `~/.nessy/dp_auth_creds.json`. Our writer cannot produce it (`saveCreds` gated by `decodeJwtClaims`); the concrete external candidate is now **named**: nessy-cli's `dpTokenManager.ts:46-58` still contains a non-atomic whole-file writer of the shared path — callerless on their current master, but live in older cli versions and their async container (`deploy/async/entrypoint.sh`).
2. Pre-1.30.1, all three of our readers forwarded it verbatim; the gateway rejects a 1-segment token with `token contains an invalid number of segments`; the warm path (`expiresAt`-only check) kept returning the same garbage → unfixable loop.
3. ≥1.30.1: shape guards stop the token locally, 401 and Sign-in force a re-mint through dp, a valid JWT is seeded read-only from nessy-cli's `oauth_creds.json`, and the error card honestly points at the gateway Sign-in.

### 2.2 What build is the user on

Most likely **1.31.0** (published mac feed) or 1.30.1. The banner string did not exist before 1.30.1 (`git log -S` returns only the fix commits; 1.30.0 shows the old "API key may be invalid" wording instead). The loop persisting on a fixed build means the silent-forced-re-mint is failing: broken/absent/old `dp` (most likely), or N1 (§2.5), or the Pi-card snapshot hole (§2.5) if the failing card is the API-key one.

### 2.3 One unresolved sub-question

The raw rows `Failed to authenticate. API Error: 401 {"error":"fail parse token claims…"}` carry the **gateway's body verbatim**. `Failed to authenticate.` is a Claude Agent SDK CLI string (binary grep: present ×8 in the SDK binary, absent from the Pi bundle), but the claude-runtime gateway adapter has wrapped upstream bodies with `upstream error 401: ` (Anthropic envelope) **since the route was born** (83607504e), and the nestor model fetcher never stamps `wire: 'anthropic-messages'`, so the gateway card cannot reach the verbatim passthrough route. So the exact surface that rendered those rows is unproven. They are plausibly **persisted history** from an earlier build (error rows are persisted; the info line is not). The discriminator below settles it live; remediation is unchanged either way. When triaging with the user, also just ask the app version (Settings → Application).

### 2.4 Remediation for the user (ordered)

0. *Discriminator (10 s):* fresh session on **Claude Code (Nessy Gateway)**, send one message. New row says `Nessy Gateway credentials not found (~/.nessy/dp_auth_creds.json)` → build ≥1.30.1, old rows were history. Still verbatim `fail parse token claims…` → build is pre-1.30.1 → step 1 first.
1. **Update to ≥1.31.0** (mac dev feed serves it; `scripts/install-app.sh`). If the user is on Windows/Linux — publish state must be confirmed first; possibly no fixed build is published for them (blocking item).
2. **Settings → AI → gateway connection row menu → Reconnect** (or the banner's Settings button → Sign in). Runs forced re-mint + seed fallback. This is the whole fix when `dp` is healthy.
3. If Reconnect fails — check `dp` (the app cannot repair it): `dp version` (≥13), `dp auth print-token | wc -l` (=1), `dp ai mcp jira` (stays running). Update dp / `dp auth login`, then repeat 2.
4. Last resort: delete `~/.nessy/dp_auth_creds.json`, Reconnect again. (A valid nessy-cli login also self-heals us via the read-only seed.)
5. Only if the **Pi ("Nessy Backend (API Key)") card** still fails after 2–4: delete that connection and re-add from the gateway card — Reconnect deliberately does not rewrite the stored per-connection credential snapshot (§2.5.1).

No API key exists to re-enter anywhere.

### 2.5 Our-side follow-ups (candidate plan rows)

1. **`pi-agent.ts:2339-2345`** — when `getValidCreds()` returns `null` (exactly the post-1.30.1 "creds are garbage" case) the Pi card falls back to the stored sign-in-time JWT snapshot: unguarded by `isJwtShaped`, never refreshed by any re-mint or Reconnect. The pre-1.30.1 loop survives, narrowed to the Pi card. Guard it (fail closed) or refresh it.
2. **`model-fetchers/nestor.ts:46`** — `'Nestor-Token': credentials.apiKey ?? ''`: stored key again, never the live creds; a stale key 401s the model refresh forever (warn-only), an empty token reproduces the same "invalid number of segments".
3. **N1 (verifier's find): `auth/dp/index.ts:91`** — `if (inflight) return inflight` runs before `forceRefresh` is honored; a forced caller joining a warm ensure gets the just-rejected token, and `attemptAuthRetry` fires once per message, so the "retry re-fires" mitigation never happens within the turn. Make forceRefresh bypass or invalidate the in-flight join.
4. **`server.ts:123` `opts.jwt` seam** bypasses the shape guard; safe only because no production caller passes it. Pin with a test.
5. **Doc bug**: `docs-site/content/reference/config/credentials.md` "never deletes or rewrites that file" — the *rewrite* half is false (`saveCreds` merge-rewrites on every mint).
6. **Raise with nessy-cli owners**: their `dpTokenManager.saveCredentials`/`saveDpModelsCache` are non-atomic whole-file writers of the SHARED creds file (torn reads, drops `cachedModels`, can clobber our keys). Callerless today; delete or harden.

## 3. nessy-cli auth-key flow (Task A synthesis)

Flow (unchanged since the 2026-08-18 audit): managed dp binary (pinned 13.14.1, MD5-pinned atomic install into `~/.nessy/dp_latest`, `DP_WORKDIR`-isolated, `dp update` best-effort on every start) → `dp auth print-token` (strict: exactly 1 stdout line, 0 stderr lines) → `POST /api/v2/token` `Authorization: Bearer <dpToken>` → JWT → written to `oauth_creds.json` `{access_token, expiry_date, token_type}` — **and never read back by anything** (the only reader, SharedTokenManager, requires `refresh_token`, which the dp writer never emits; the whole exchange re-runs on every startup). `dp_auth_creds.json`: dead writer, three live readers (telemetry/crash-reports degrade silently on a clean machine). Request auth: single `buildNestorAuthHeaders(jwt)` helper everywhere; `Bearer` only when the JWT is byte-equal to `NESSY_CLI_DP_AUTH_TOKEN` (spirit_iam/JWKS path), else `Nestor-Token`. 401/403: unconditional single re-mint + one retry — **but the retry only updates `client.apiKey` (Bearer), not the `Nestor-Token` default header computed once at client build, so on the classic dp path the retry replays the stale JWT** (their live bug, new find). Models: 401 swallowed into `[]` → surfaces as "model list unavailable", not an auth error; `is_default` vs `default` mismatch still dead.

**Adopt** (full list in Appendix A): value-equality (not presence) env-token discrimination if we ever add delegated tokens; one exported header-builder used by every caller; exported creds file-mode constant + refuse-on-chmod-failure; cache invalidation inside the writer; single-flight every dp side effect (we have ensure-level; they also single-flight download/update/login); atomic binary install with a run-`--version` liveness gate; install-binary-independent-of-auth; `DP_WORKDIR` isolation; `[nessy-fork]` markers + `docs/fork-patches/<slug>.md`; typed errors over substring matching.

## 4. Their desktop = vendored openwork sibling fork (Task B synthesis)

`packages/desktop` = `openwork` by Model Studio AI — same `@craft-agent/*` internals and `CRAFT_*` env vars as us; ~311k LOC vs our ~788k; excluded from their npm workspaces with a CI isolation check; synced to upstream via `desktop-openwork-sync.ts`.

**Auth**: the desktop holds zero Nestor/dp credentials — `LlmProviderType = 'nessy'`, `LlmAuthType = 'none'`, `resolveAuthEnvVars() → {}`; everything delegates to the CLI over ACP: `lease.authenticate('dp-auth')` (blocking first-run + lazy on `authMethods`-carrying errors, single-flight, 310 s budget). Their `attemptAuthRetry` is the ancestor of ours (info event, once-per-session guard, null the agent, replay).

**Copy**: fork markers + sync script; version bump + `check-release-version` as separate write/verify CI steps; `sync()` returning per-source failures; reconnect-on-`Authorization`-diff for token propagation; the marketing-version vs bundled-runtime-version split (`nessyCodeRuntime.version`).
**Avoid / audit ourselves**: (a) secrets typed into their MCP-headers UI land in CLI `settings.json` at ~0644 **plus** a `settings.json.orig` copy — if we add MCP header fields, write 0600, no `.orig`; (b) **their `McpPoolServer`/`LocalMcpHttpServer` bind 127.0.0.1 with no token/Origin/DNS-rebinding guard — same upstream as ours: audit our copies** (candidate row); (c) `NESSY_CLI_DP_AUTH_TOKEN` missing from their stdio-MCP env denylist; (d) their non-atomic shared-creds writers (§2.5.6); (e) stubbed-to-constant auth predicates orphaning four helpers.

## 5. "dp mcp remote" / F2 transport pool (Task C synthesis)

**No dp-backed remote MCP exists in nessy-cli.** `dp ai mcp` appears in exactly one docs table + the async-image settings JSON; the gateway JWT is never attached to an MCP transport; their MCP-OAuth story is explicitly deferred (F3). `dp ai mcp remote --url <URL>` exists only in OUR repo, as a documented exclusion (`builtin-dp-servers.ts:150-162`).

Their F2 `McpTransportPool` (ACP-child-scoped, fingerprint-keyed, refcount + 30 s drain + never-reset 5 min idle cap) vs our `McpClientPool` + `WorkspaceMcpPoolRegistry` (workspace-scoped leaser union, sessions **and** browse): ours is broader and ~2.8k lines ahead of the openwork copy they vendored. Worth porting from F2:
- **C — descendant-pid sweep** (one `ps -A` snapshot + tree walk, caps 256/depth 8): our supervisor covers direct children only; we do run `npx`-launched plugin MCP servers, so the grandchild leak is real. Self-contained; do first; validate on a packaged build (ulimit trap).
- **B — HTTP/SSE pool-sharing gate** (their default: HTTP/SSE unshared because some servers bind auth/conversation state to the stream; our sharing is wider than theirs). Needs a measurement before defaulting.
- **A — `dp ai mcp remote --url` support**: stays a stdio config from the pool's view (dp is the HTTP client) — zero pool changes — but `dpAiMcpSubcommandOf` must be fixed first (it would return the URL as the "subcommand", breaking dedup), and it must be a user-entered field, not a builtin, until the dp/Spirit owners publish an endpoint list. Also audit our `stableJson(config)` pool key against their `canonicalOAuth` credential-leak correction (assert with a test).
Also worth copying: their `NESSY_SERVE_NO_MCP_POOL=1` kill switch and per-transport reconnect backoff table.

## 6. Consolidated candidate plan rows

| # | What | Where | Severity |
|---|---|---|---|
| 1 | Pi-card stored-JWT-snapshot fallback unguarded/never refreshed | `pi-agent.ts:2339-2345` | High — surviving 401 loop |
| 2 | Model refresh sends stored key, `?? ''` | `model-fetchers/nestor.ts:46` | Med |
| 3 | Single-flight swallows `forceRefresh` | `auth/dp/index.ts:91` | Med |
| 4 | Pin `opts.jwt` guard-bypass seam with a test | `codex-responses-adapter/src/server.ts:123` | Low |
| 5 | credentials.md "never rewrites" doc bug | docs-site | Low |
| 6 | Audit OUR loopback MCP servers for missing auth/Origin guard | `McpPoolServer` / `LocalMcpHttpServer` | High — same upstream as their confirmed gap |
| 7 | Descendant-pid sweep on pool teardown | supervisor stop path | Med |
| 8 | HTTP/SSE share gate (measure first) | `mcp-pool.ts` | Med |
| 9 | Pool-key credential-fields test (canonicalOAuth lesson) | `mcp-pool.ts:196-199` | Low |
| 10 | Win/Linux publish state of ≥1.30.1 — confirm against the publish job | release infra | High for non-mac users |
| 11 | Raise non-atomic shared-creds writers with nessy-cli owners | their `dpTokenManager.ts` | External |

## 7. Follow-up (2026-08-22): where does `dp auth login` actually put the key, and do we need to widen the search?

Live-verified on this machine (dp 13.39.0 at `/usr/local/bin/dp`) + code read.

**`dp auth login` writes no gateway JWT anywhere.** It persists dp's own
Ory/Spirit session into dp's state root — `~/.dp/` by default
(`access_token.json` ~1 h token, `config.json`, `sa_cred.json`, `refresh.lock`),
or `$DP_WORKDIR` when set. The gateway JWT only comes into existence when
someone exchanges the dp token at `POST /api/v2/token` — dp itself never does
this. So there is no "key left by dp login" to search for; the only sources of
a JWT on disk are our own writer and nessy-cli's `oauth_creds.json`.

**A user without nessy-cli is fine by construction.** `ensureNessyGatewayAuth`
is self-sufficient: `resolveDpBinary()` (PATH → `/usr/local/bin/dp`) →
`dp auth print-token`/`login` → exchange → `saveCreds` — which itself
`mkdir -p ~/.nessy` (0700) and writes the file (`creds-store.ts:84-96`). The
nessy-cli seed is an optional extra source, not a dependency. Our auth execs
inherit `process.env` + `DP_NO_WARNINGS` only (`dp-api.ts:40-43`) — no
`DP_WORKDIR` injected — so we consume the user's *system* dp session in
`~/.dp`, the same one their terminal `dp auth login` fills. Copying anything
out of `~/.dp` would be wrong: its token is the opaque (1-segment) dp token —
putting that into the jwt field is exactly the "invalid number of segments" bug.

**The dangerous profile is the inverse: a nessy-cli-ONLY user.** nessy-cli
does NOT use the system dp — it downloads its own managed binary to
`~/.nessy/dp_latest/dp` and runs it with `DP_WORKDIR=~/.nessy/dp_latest`
(verified live: that dir holds its own `access_token.json`). Such a user can
be fully working in nessy-cli while having **no system dp at all** → our card
throws `DpNotFound`, and the silent 401 re-mint fails with no hint. Today the
seed covers them *if* their cli has minted a valid JWT into
`oauth_creds.json` (JWTs live ~2 years, so usually yes); the uncovered case is
cli-installed-but-never/expired-logged-in.

Candidate extensions (owner calls, add to §6):

| # | What | Note |
|---|---|---|
| 12 | Honor `NESSY_HOME` in `getCredsPath()`/`getCliOauthPath()` (`creds-store.ts:37,106`) | nessy-cli resolves `~/.nessy` via `NESSY_HOME`; we hardcode. With it set, seed misses their file and they never see ours. Cheap parity fix. |
| 13 | Binary fallback: when system dp is absent, use `~/.nessy/dp_latest/dp` **with `DP_WORKDIR=~/.nessy/dp_latest`** | Not a download — reusing what nessy-cli already installed; converts `DpNotFound` into working auth for cli-only users. MUST pass its workdir or we read the empty `~/.dp` session. Touches the frozen "system dp only" decision → explicit owner ack needed. |
| 14 | Make the silent re-mint failure diagnosable | Banner today doesn't say *why* the re-mint failed (dp missing vs signed out vs old). Thread the `DpAuthError` code into the gateway 401 card / boot status. |

**Verdict on "перекладывать ключ к нам после авторизации":** already exists in
the only valid direction — the read-only validated seed (cli → us) plus our own
mint. There is nowhere else a key lives to copy from.

---

*Appendices: full agent reports, verbatim.*

# Appendix A — Task A: nessy-cli auth-key flow (full report)

# TASK A — nessy-cli auth-key flow (master HEAD `1f9e807cb`, 2026-08-22, v0.13.11-beta.0)

## 0. Headline: nothing in this area changed since the 2026-08-18 audit

`git log --since=2026-08-10 -- packages/core/src/dp/ packages/core/src/qwen/qwenOAuth2.ts packages/core/src/qwen/sharedTokenManager.ts packages/cli/src/core/` returns exactly three commits, all older than the prior audit:

- `8360cb4b4` 2026-08-17 `fix(AIDT-7488): retry dp update without reinstalling binary`
- `85420903e` 2026-08-11 `feat(AIDT-7428): remove forcedAuth flow, record auth statistics`
- `e8b3b3708` 2026-08-11 `feat(AIDT-6860): implement dp binary lifecycle with atomic install, version…`

Every prior finding still holds verbatim (details per item below). What follows is the current map plus three findings the prior audit did not record.

---

## 1. dp binary invocation

**Config** — `/Users/i.i.gavrikov/Desktop/work/nessy-cli/packages/core/src/dp/dpConfig.ts`:
- pinned `version: '13.14.1'` (line 18); workdir env var `DP_WORKDIR` (line 20) pointing at `<NESSY_HOME>/dp_latest` (lines 76–79); binary at `<NESSY_HOME>/dp_latest/dp[.exe]` (lines 82–84).
- commands: `['auth','print-token']` (line 23), `['version']` (line 24), `['--version']` (line 25), `['auth','login']` (line 28), `['update']` (line 29).
- download prefix `https://code-completion-nestor.tcsbank.ru/api/v2/download/dp` (lines 33–34), per-platform MD5 pins (lines 35–39), binary mode `0o700` (line 32).

**Every exec passes `DP_WORKDIR`** via `buildEnv()` — `packages/core/src/dp/dpApi.ts:18-24` — so the CLI's `dp` never touches the user's own `dp` state dir.

**stdout parsing is strict to the point of fragility** — `dpApi.ts:59-71`: `print-token` is only accepted when `stdoutLines.length === 1 && stderrLines.length === 0`. Any single stderr line (an update notice, a TLS warning) makes `getDpToken()` return `undefined`, which `dpAuthManager.ts:129-138` interprets as "not logged in" and escalates to a full browser `dp auth login`. The one recognized failure string is matched by substring: `'no access token found, you need to authorize user or service account first'` (`dpApi.ts:73-83`).

**Timeouts**: `print-token` 5s (`dpApi.ts:55`), `auth login` 60s (`dpApi.ts:104`), `version` none (`dpApi.ts:34-36`), `--version` liveness check 15s (`dpConfig.ts:27`, used at `dpDownloader.ts:147`), `dp update` 300s (`dpConfig.ts:30`, `dpUpdater.ts:60`), download 300s (`dpConfig.ts:22`).

**Login success is regex-detected on stdout**: `/user ".*" successfully authorized/` — `dpApi.ts:107-110`; a mismatch throws `DpAuthError.CantLogin` carrying stderr.

**Version checks / lifecycle** — `packages/core/src/dp/dpDownloader.ts`:
- `ensureDpPresence()` is single-flight (lines 48-58) — concurrent callers share one inflight promise so parallel entry points cannot download over each other.
- missing binary → `installFreshBinary`; present-but-not-runnable → reinstall (lines 69-77). "Runnable" = `dp --version` stdout matches `/Spirit CLI Version: (\d+\.\d+\.\d+)/` (lines 31, 137-156); EACCES/ENOEXEC/ETXTBSY/timeout all collapse to "not usable".
- install is atomic: download to `${filePath}.download-${pid}` → MD5 verify against the pin → chmod → run-check → `rename` (lines 108-129). Checksum applies only to the freshly downloaded pinned binary, deliberately not after `dp update` (lines 100-103).
- `dp update` runs on **every startup**, best-effort, retried once, never replacing a runnable binary on failure (lines 79-84; `dpUpdater.ts:34-68`, also single-flight).
- `prepareAuth()` adds one more layer: on any failure it `removeDp()` and retries once (`dpAuthManager.ts:20-36`).

**The binary is installed independently of auth**, on every CLI start, because the bundled dp MCP servers spawn it: `packages/cli/src/core/dpBinary.ts:26-31` (`ensureDpBinary`, never throws) called from `packages/cli/src/core/initializer.ts:51`.

**Whole dp-token acquisition is single-flight**: `performDpAuth()` — `dpAuthManager.ts:102-112` — explicitly to stop "startup auth + gitlab extension fetch" from racing two browser logins.

## 2. Token exchange: opaque dp token → JWT

`packages/core/src/dp/dpTokenExchangeClient.ts`:
- `POST ${NESTOR_SERVER_URL}/api/v2/token` (line 14; origin `https://code-completion-nestor.tcsbank.ru` at `packages/core/src/core/openaiContentGenerator/constants.ts:11`).
- headers: `Content-Type`, `User-Agent: NessyCLI/<version> (<platform>; <arch>)`, `X-Request-Id: <uuid v4>`, `Authorization: Bearer <dpToken>` (lines 44-51); body `{}`; 30s abort (lines 36-37).
- response typed `{ token: { created_at, id, expires_at }, jwt }` (lines 17-24) and **cast without runtime validation** (line 79).
- 401 gets its own message but the same error type `DpAuthError.TokenExchangeFailed` (lines 65-76) — no retry, no re-login.

**Orchestration** — `packages/core/src/dp/dpAuthService.ts:33-107`:
1. env bypass first (`tryAuthFromEnv`, line 37) — if `NESSY_CLI_DP_AUTH_TOKEN` is set, the dp binary is never invoked and no exchange happens (lines 37-49).
2. `performDpAuthInternal()` → dp token (line 53).
3. `exchangeToken(requestId, dpToken)` (lines 56-62).
4. `decodeJwt(tokenResponse.jwt)` for `preferred_username` / `sub` / `exp` (lines 65-67).
5. persist to `oauth_creds.json` (lines 80-92) — throws on failure, "Fatal - cannot proceed without credentials" (line 91).
6. `fetchModels(jwt)` — non-fatal (lines 94-104).

**There is no cache short-circuit in this function.** `performNessyAuth` runs the full dp-token → exchange path on every call, and it is called on every startup via `Config.refreshAuth` (`packages/core/src/config/config.ts:2471`) ← `performInitialAuth` (`packages/cli/src/core/auth.ts:62`) ← `initializeApp` (`packages/cli/src/core/initializer.ts:76`). The cheap part is that `dp auth print-token` returns a cached dp token, so the browser usually doesn't open — but a fresh `/api/v2/token` exchange happens each run. `/bug` triggers another full `performNessyAuth` (`packages/cli/src/ui/commands/bugCommand.ts:84`).

## 3. Creds persistence

### `~/.nessy/oauth_creds.json` — the writer
`dpAuthService.ts:82-87` writes exactly three fields:

```ts
const nessyCreds: NessyCredentials = {
  access_token: tokenResponse.jwt,
  expiry_date: jwt.exp * 1000,
  token_type: 'Bearer',
};
```

Note the missing `refresh_token`. The comment at `dpAuthService.ts:69` — `// 10. Build credentials (do NOT save to dp_auth_creds.json - use shared oauth_creds.json instead)` — is unchanged from the prior audit.

The write goes through `cacheNessyCredentials` — `packages/core/src/qwen/qwenOAuth2.ts:1060-1186`, path `<NESSY_HOME>/oauth_creds.json` (lines 39, 1219-1221). It is well-hardened: temp file `${filePath}.tmp.${pid}.${uuid}` created with `mode 0o600` (lines 1093-1098), explicit `chmod` that is a **hard error on POSIX** rather than a warning (lines 1105-1114), atomic `rename` (line 1128), temp cleanup on failure (lines 1135-1139), `SharedTokenManager.clearCache()` after (lines 1149-1150), EACCES surfaced with an actionable message (lines 1175-1179). `NESSY_CREDENTIAL_FILE_MODE = 0o600` is exported specifically so auditors can assert intent (lines 1053-1058).

### `~/.nessy/oauth_creds.json` — the readers, and why the DP JWT is write-only
The only reader is `SharedTokenManager` (`packages/core/src/qwen/sharedTokenManager.ts:26`, `reloadCredentialsFromFile` lines 418-424), and it validates through `validateCredentials` — `sharedTokenManager.ts:90-115` — which **requires `access_token`, `refresh_token`, and `token_type` to be non-empty strings** (lines 96-107) plus a numeric `expiry_date` (lines 109-112). The DP writer never emits `refresh_token`, so a DP-written file fails validation and is swallowed into `this.memoryCache.credentials = null` with a debug warning (lines 442-453).

It doesn't matter in practice, because `SharedTokenManager` is only reachable from `QwenContentGenerator` and the qwen device flow, and **neither has a production constructor**: `AuthType` has no qwen/oauth member (`packages/core/src/core/authType.ts:16-22` — `openai | dp-auth | gemini | vertex-ai | anthropic`), `createContentGenerator` never instantiates `QwenContentGenerator` (only `DpContentGenerator` at `packages/core/src/core/contentGenerator.ts:353`), and the device-flow base URL is a placeholder: `const DP_AUTH_BASE_URL = 'https://----'` (`qwenOAuth2.ts:27`). The one live `cacheNessyCredentials` peer is the `nessy serve` device-flow provider (`packages/cli/src/serve/auth/nessy-device-flow-provider.ts:8,226-252`), which *does* write `refresh_token` (line 227).

**Net: the DP JWT is written to `oauth_creds.json` and never read back by anything.** No code path consults it to skip the `/api/v2/token` exchange. `Storage.getOAuthCredsPath()` (`packages/core/src/config/storage.ts:337-339`) has no non-test callers.

### `~/.nessy/dp_auth_creds.json` — dead writer, live readers
`packages/core/src/dp/dpTokenManager.ts` still owns the file (`dpConfig.ts:41,87-90`). Shape: `{ jwt, expiresAt, username, userId, cachedModels? }` (lines 15-22).

- **`saveCredentials()` (line 46) has zero production callers.** Repo-wide grep for `saveCredentials`/`getDpCredentialsPath` finds only `dpTokenManager.ts` itself, the barrel re-export (`packages/core/src/dp/index.ts:14,24`), tests, and an unrelated QQ-bot helper. Same for `saveDpModelsCache` (line 65) and `clearCredentials`/`clearCredentialsFile` (lines 103,116).
- **Readers are live**: `getValidCredentials()` (line 26) → `getCachedOrLoadCredentials()` → `loadCredentials()` (line 83, reads the file) is called by
  - `packages/core/src/dp/dpModelsClient.ts:170` (`loadDpModelsFromServer` — itself unreferenced in production),
  - `packages/core/src/dp/ErrorClient.ts:181` — crash reports to `/api/v1/cli/errors` attach `Nestor-Token` only if creds are found,
  - `packages/core/src/telemetry/statistClient.ts:170` — `getStatistUserId()` returns `creds?.username || creds?.userId || 'unknown-user'`.

  In the classic dp flow the in-memory cache is never populated (nothing calls `saveCredentials`/`setTransientCredentialsInMemory`), so these three read whatever legacy `dp_auth_creds.json` a previous CLI version left on disk — otherwise `null`. **Telemetry user id silently degrades to `'unknown-user'` and error reports go out unauthenticated on a clean machine.** The env-token path is the exception: `dpDelegatedToken.ts:52` calls `setTransientCredentialsInMemory`, so those two consumers work there.
- The doc comment at `packages/core/src/providers/presets/dp-auth.ts:17` ("credentials are JWT-cached in ~/.nessy by `dpTokenManager` after performNessyAuth") is stale w.r.t. this.
- The design intent is recorded: `docs/fork-patches/dp-auth-runtime-model-catalog.md` — "Каталог не читается из `dp_auth_creds.json` и не пишется обратно в `settings.json`".

### JWT shape validation — refined from the prior audit
- **Validated**: `decodeJwt` (`packages/core/src/dp/jwtDecoder.ts:16-28`) enforces 3 dot-separated parts and a base64url payload that parses as JSON. It runs on the exchange response (`dpAuthService.ts:65`), on the env token (`dpDelegatedToken.ts:28-33`), and for auth telemetry (`packages/cli/src/core/auth.ts:34`). The env path additionally rejects an expired token (`dpDelegatedToken.ts:35-38`).
- **Not validated**: anything loaded from disk. `dpTokenManager.loadCredentials` checks only `data.jwt` truthy + `typeof data.expiresAt === 'number'` (line 92); `getValidCredentials` checks only `expiresAt > Date.now()` (line 28). `oauth_creds.json` validation (`sharedTokenManager.ts:90-115`) checks field presence and types, never JWT form. The prior audit's finding stands for the disk paths.

## 4. Request auth

**Header discrimination** — `packages/core/src/dp/nestorAuthHeader.ts:24-30`:

```ts
const envToken = process.env['NESSY_CLI_DP_AUTH_TOKEN'];
if (envToken && envToken === jwt) return { Authorization: `Bearer ${jwt}` };
return { 'Nestor-Token': jwt };
```

The doc block above it (lines 1-23) states the reason precisely: `Nestor-Token` goes to oathkeeper's `oauth2_introspection` against `/api/v2/token/introspect` and only works for Nestor-issued tokens; `Authorization: Bearer` goes to the `spirit_iam` authenticator which verifies against Spirit IAM JWKS and is what delegated env tokens need. Discrimination is by **value equality with the env var**, not by "env is set" — so a DP-issued JWT is never mislabeled while the env var happens to be present. Four cases are pinned in `packages/core/src/dp/nestorAuthHeader.test.ts` including empty-string env.

**Call sites**: LLM traffic `packages/core/src/core/openaiContentGenerator/provider/nestor.ts:60-62`; models fetch `packages/core/src/dp/dpModelsClient.ts:78`; crash reports `packages/core/src/dp/ErrorClient.ts:186`; DLH telemetry `packages/core/src/telemetry/nessy-dlh/dlh-client.ts:42`.

**Provider scoping** — `nestor.ts:34-46`: `isNestorProvider` is true when `authType === DP_AUTH`, or `baseUrl` is empty, or the URL contains `code-completion-nestor.tcsbank.ru` or `llm-proxy`. Header injection itself is additionally gated on `authType === AuthType.DP_AUTH && apiKey` (line 60). Custom headers override defaults (lines 64-66).

**Non-auth headers worth noting**: W3C `traceparent` injected at the fetch boundary (`nestor.ts:354-370`) and `X-Serving-Platform-Client-Session-ID` read through a getter per request, because `/clear` and `/resume` rotate the session id while the client is reused (`nestor.ts:23-24, 384-399`).

**401/403 re-auth** — `packages/core/src/dp/dpContentGenerator.ts:50-64`:

```ts
try { return await operation(); }
catch (error) {
  if (this.isAuthError(error)) {
    const newCredentials = await performNessyAuth(this.cliConfig);
    this.pipeline.client.apiKey = newCredentials.jwt;
    return await operation();          // exactly one retry
  }
  throw error;
}
```

- **Re-mint is unconditional** on a matching error: no check of the current JWT's `exp`, no backoff, no distinction between 401 and 403. `isAuthError` (lines 93-118) fires on status/code `401|403` (number *or* string) **or on substring matches in the message**: `unauthorized`, `forbidden`, `invalid api key`, `token expired`, `authentication` — broad enough that a model's own prose containing "authentication" in an error string triggers a re-auth.
- Exactly **one** retry; a second failure propagates. Wrapped around `generateContent`, `generateContentStream`, `embedContent` (lines 66-91). `shouldSuppressErrorLogging` suppresses logging for auth errors (lines 43-48).
- **Finding (new): the retry does not update the `Nestor-Token` header.** `buildClient()` computes `defaultHeaders` once (`nestor.ts:76`) and hands them to `new OpenAI({..., defaultHeaders})` (lines 101-109); the pipeline builds that client exactly once, in its constructor (`packages/core/src/core/openaiContentGenerator/pipeline.ts:46`). Assigning `pipeline.client.apiKey` only changes what the SDK puts in `Authorization: Bearer`. On the classic dp path — where auth rides on `Nestor-Token` — the retry therefore replays the **stale** JWT. The full `Config.refreshAuth` path is fine because it rebuilds the generator (`packages/core/src/config/config.ts:2557` sets the apiKey, `:2577` re-creates the ContentGenerator).
- **Finding (new): for the env-token path the retry is a guaranteed-identical replay.** `performNessyAuth` short-circuits on `tryAuthFromEnv` (`dpAuthService.ts:37-49`) and returns the same `NESSY_CLI_DP_AUTH_TOKEN` value, so a 401 costs one extra failing round-trip and nothing else.

**Env-token path activation**: `getAuthTypeFromEnv()` returns `DP_AUTH` when `NESSY_CLI_DP_AUTH_TOKEN` (or bare `DP_AUTH`) is set — `packages/cli/src/utils/modelConfigUtils.ts:100-107`. Documented in `docs-ru/users/work/features/delegated-token-auth.md`.

**Placeholder token**: before auth resolves, `generationConfig.apiKey` is the sentinel `'DP_AUTH_DYNAMIC_TOKEN'` (`packages/core/src/models/modelsConfig.ts:870,1184`; `packages/core/src/models/modelConfigResolver.ts:363`); DLH telemetry explicitly refuses to send with it (`dlh-client.ts:33`).

## 5. Models fetch

`packages/core/src/dp/dpModelsClient.ts`, `GET https://code-completion-nestor.tcsbank.ru/api/v1/cli/models` (`constants.ts:13`):
- headers `Content-Type`, `User-Agent: NessyCLI/<version> (…)`, plus `buildNestorAuthHeaders(jwt)` (lines 74-79); 30s abort (lines 67-68).
- **any non-OK, including 401, returns `[]`** rather than throwing (lines 83-100); network/timeout errors likewise (lines 150-155). The log line still says "using hardcoded models" although there are none any more.
- accepts both `BackendModelInfo[]` and `{ models: [...] }` (lines 47-49, 105).
- mapping (lines 115-147): `id`/`name` ← `name`, `description` ← `desc`, `internal` ← **`is_internal`** (line 136), `alias` ← `alias`, `default` ← **`default`** (line 138), `fastOnly`/`visualOnly` derived from the alias, `baseUrl` ← `DEFAULT_NESTOR_BASE_URL`, `envKey: 'DP_AUTH_MODEL_KEY'`, `generationConfig.modalities` ← `modalities`.

**`is_default` vs `default` — unchanged, still dead.** `grep -ran "is_default"` over the whole repo (excluding `node_modules`) returns **zero hits**. The declared backend field is `default?: boolean` (`dpModelsClient.ts:38`, restated at line 121) and it is read as `backendModel.default` (line 138). The neighbouring `is_internal` (line 136) shows the backend does use snake_case for boolean flags, which is what makes the mismatch plausible; the server-side fact is from the 2026-08-18 audit and cannot be re-confirmed from this repo. `dpModelsClient.test.ts:191-206` pins the *client* contract on `default: true`, so the test passes regardless.

**Consumer of the flag** — `packages/core/src/config/config.ts:2496-2527`: primary models are those with no alias or alias `coder` and not fast/visual/voice-only; when the current model isn't among them the selection falls to `primaryModels.find((model) => model.default === true)` (line 2510) **then** `alias === 'coder'` **then** `primaryModels[0]`. So a dead `default` degrades silently to the coder-alias fallback — exactly the "dead server default" of the prior audit.

**Empty catalog is fatal for auth**: `updateDpAuthModels` then `if (dpAuthResult.models.length === 0) throw new DpAuthServiceError(DpAuthError.ModelsUnavailable)` (`config.ts:2483-2485`, again at 2525). Combined with the swallow-401-into-`[]` above, an auth failure at the models endpoint surfaces to the user as "DP model list is unavailable" (`packages/core/src/dp/dpErrors.ts:12`), not as an auth error.

---

## Practices worth adopting in nessy-desktop

1. **Value-equality header discrimination, not presence-checks.** `nestorAuthHeader.ts:24-30` decides `Nestor-Token` vs `Authorization: Bearer` by comparing the JWT to the env var's *value*, so a DP-issued token is never mislabeled just because the env var is set. Our `packages/shared/src/auth/dp` scoping should carry the same rule (and the same four test cases from `nestorAuthHeader.test.ts`) if we ever add a delegated-token path.
2. **A single `buildXAuthHeaders(jwt)` helper, used by every outbound caller.** Four unrelated subsystems in nessy-cli (LLM provider, models client, crash reporter, DLH telemetry) all funnel through one function; there is no second place where a header name is spelled. Worth mirroring so a scheme change is a one-file edit.
3. **Publish the credential file mode as an exported constant and make the POSIX `chmod` a hard error.** `NESSY_CREDENTIAL_FILE_MODE = 0o600` (`qwenOAuth2.ts:1058`) plus "refuse to publish credentials" on chmod failure (lines 1105-1114) is stricter than write-then-chmod. Our dp writer is already atomic + 0600; adopting the refuse-on-chmod-failure branch and the exported constant closes the last gap.
4. **Invalidate the in-memory cache inside the writer, not at each call site.** `cacheNessyCredentials` calls `SharedTokenManager.clearCache()` itself (lines 1142-1150) with a comment explaining that the alternative re-triggers device auth. Any nessy-desktop creds cache should do the same rather than relying on callers to pair write+invalidate.
5. **Single-flight every external side effect.** `ensureDpPresence` (`dpDownloader.ts:48-58`), `tryAsyncDpUpdate` (`dpUpdater.ts:34-44`), `performDpAuth` (`dpAuthManager.ts:102-112`), and the token request (`dpAuthManager.ts:42-60`) each share one inflight promise, with the concrete race named in the comment ("startup auth + gitlab extension fetch"). Our multi-window/multi-session Electron shell has strictly more concurrent entry points into the same dp binary.
6. **Atomic binary install with a liveness gate.** `installFreshBinary` (`dpDownloader.ts:108-129`): temp path → MD5 against a pin → chmod → *actually run `--version`* → rename. Plus treating an unrunnable existing binary as corrupt and reinstalling (lines 72-74). This is the shape our bundled-subprocess staging should use.
7. **Install the binary independently of auth.** `initializer.ts:51` + `dpBinary.ts:26-31` install `dp` on every startup, never throwing, because MCP servers spawn it before any login. The comment names the trap: "cached credentials live in `oauth_creds.json`, outside `dp_latest`, so auth cannot be relied on to put the binary in place." Directly relevant to our dp-MCP wiring.
8. **`DP_WORKDIR` isolation on every exec.** `dpApi.ts:18-24` points the managed `dp` at a private state dir on every invocation, so the app never mutates the user's own `dp` session. Cheap and worth copying verbatim.
9. **A `[nessy-fork] <slug>` marker on every fork-specific code point, with a `docs/fork-patches/<slug>.md` carrying purpose, exhaustive file list, and a numbered rollback procedure.** See `dp-auth-runtime-model-catalog.md` / `dp-binary-lifecycle.md`. This is a better fork-provenance mechanism than our per-plan trackers for changes that span many files.
10. **Structured error types over message substring matching.** `NessyOAuthPollError` (`qwenOAuth2.ts:112-148`) exists precisely because a downstream consumer had been substring-matching the message; the class keeps the old message shape for compatibility while exposing typed fields. Contrast `dpApi.ts:73-83`, which still substring-matches dp's stderr — the anti-pattern the same repo elsewhere fixed.
11. **Anti-patterns to avoid, all live in this code:** re-auth that mutates a token the transport no longer reads (§4); a persistence writer with zero callers while three readers still consult the file (§3); swallowing 401 into an empty list so an auth failure surfaces as a catalog error (§5); auth-error detection by message substring (`dpContentGenerator.ts:107-117`); and one field name typo (`default` vs `is_default`) whose only test pins the client's own assumption instead of the server contract.
# Appendix B — Task B: nessy-cli's packages/desktop (full report)

I have everything needed. Producing the report.

# TASK B — nessy-cli's `packages/desktop`

## 1. What it is

**It is not nessy-cli code. It is a vendored fork of `openwork` — the same upstream family that nessy-desktop forked from.**

`/Users/i.i.gavrikov/Desktop/work/nessy-cli/packages/desktop/package.json:2-13`:
```json
"name": "openwork",
"version": "0.13.11-beta.0",
"description": "OpenWork desktop and headless agent workspace from Model Studio AI",
"author": { "name": "Model Studio AI", "url": "https://github.com/modelstudioai" },
"repository": { "url": "https://github.com/modelstudioai/openwork.git" },
"nessyCodeRuntime": { "version": "0.15.11" }
```

The internal package names are still `@craft-agent/*`, identical to ours:
- `packages/desktop/packages/shared/package.json:2` — `"@craft-agent/shared"`
- `packages/desktop/packages/core/package.json:2` — `"@craft-agent/core"`
- `packages/desktop/apps/electron/package.json:2-9` — `"@craft-agent/electron"`, author `Craft Docs Ltd. <support@craft.do>`, homepage `https://agents.craft.do`

**Structure is 1:1 with ours.** `packages/desktop/{apps,packages}`: `apps/{cli,electron,viewer,webui}`, `packages/{core,server,server-core,session-mcp-server,session-tools-core,shared,ui}` — plus two we don't have: `messaging-gateway`, `messaging-whatsapp-worker`. Env vars are still `CRAFT_*` (`CRAFT_IS_PACKAGED`, `CRAFT_WORKSPACE_PATH`, `CRAFT_SESSION_DIR`, `CRAFT_SERVER_URL`).

**Size:** theirs 310,983 LOC of `.ts/.tsx` under `packages/`+`apps/`; ours 787,993. They took a much thinner slice — ~40% of our surface.

### Nesting and workspace isolation

`packages/desktop` is deliberately **excluded** from the CLI's npm workspaces — `/Users/i.i.gavrikov/Desktop/work/nessy-cli/package.json:9-19` ends its `workspaces` array with `"!packages/desktop"`. It has its own `bun.lock`, its own `bunfig.toml` (registry pinned to `https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/`), its own `.github/workflows/desktop-release.yml`, its own LICENSE/NOTICE/TRADEMARK.

A CI script enforces the split: `/Users/i.i.gavrikov/Desktop/work/nessy-cli/scripts/check-desktop-isolation.js:14-21` forbids `electron`, `electron-builder`, `@sentry/cli`, `@sentry/electron`, `@sentry/vite-plugin` at the CLI root, and lines 57-78 fail the build if any `packages/desktop*` location appears in `npm query .workspace` or in the root `package-lock.json`. It is **not** a separate git repo — it lives inside the nessy-cli repo.

### The fork-discipline mechanism worth stealing

Every divergence from openwork upstream carries an inline marker comment `// [nessy-fork] <topic>`. Distribution:

| Marker | Count |
| --- | --- |
| `desktop-first-run-setup` | 36 |
| `desktop-skill-scope-management` | 19 |
| `desktop-clipboard-path-paste` | 14 |
| `desktop-extension-management` | 13 |
| `desktop-permission-request-ui` | 12 |
| `desktop-workspace-file-control` | 11 |
| `desktop-mcp-management` | 10 |

`/Users/i.i.gavrikov/Desktop/work/nessy-cli/scripts/desktop-openwork-sync.ts` (run via `bun run desktop-openwork-sync`) does bidirectional git-subtree-style export/import between `packages/desktop` and an openwork checkout, with `--overlay-path` exclusions (`scripts/desktop-openwork-sync.ts:377-427`) for files that must never round-trip. Modes are `auto | export | import`.

---

## 2. Auth key handling

### The headline: the desktop handles **zero** Nestor/dp credentials

Grep over the entire `packages/desktop` tree returns **no hits** for `dp_auth_creds`, `Nestor-Token`, or `oauth_creds`. All of it lives in the CLI (`/Users/i.i.gavrikov/Desktop/work/nessy-cli/packages/core/src/dp/`).

The type system enforces it. `packages/desktop/packages/shared/src/config/llm-connections.ts:7-10`:
```ts
export type LlmProviderType = 'nessy';
export const NESSY_CLI_CONNECTION_SLUG = 'nessy-cli';
export type LlmAuthType = 'none';
```
Compare ours: `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/config/llm-connections.ts:63-99` — 6 provider types, 8 auth types.

Every auth-shaped function in that file is stubbed to a constant:
- `authTypeToCredentialStorageType()` → `null` (line 63-65)
- `authTypeRequiresEndpoint()` → `false` (line 71-73)
- `authTypeIsOAuth()` → `false` (line 113-115)
- `resolveAuthEnvVars()` → `{ envVars: {}, success: true }` (line 130-132) — **the desktop injects no auth env var into the CLI subprocess at all**

And the credential check is short-circuited — `packages/desktop/packages/shared/src/credentials/manager.ts:399-405`:
```ts
async hasLlmCredentials(connectionSlug, authType, providerType): Promise<boolean> {
  return authType === 'none';
}
```
Since `LlmAuthType` is only `'none'`, this is always `true`. The four private helpers below it (`hasLlmApiKeyCredential`, `hasLlmOAuthCredential`, `hasLlmIamCredential`, `hasLlmServiceAccountCredential`, lines 411-450) are now dead code — `hasLlmCredentials` never calls them. The RPC layer hardcodes the same: `packages/desktop/packages/server-core/src/handlers/rpc/llm-connections.ts:289` — `isAuthenticated: true`.

The README states it explicitly (`packages/desktop/README.md`, "Backend" section): the fork is Nessy-only, sessions run through the CLI over ACP, the app does not store third-party LLM API keys.

### The residual credential store (openwork inheritance, now near-empty)

`packages/desktop/packages/shared/src/credentials/backends/secure-storage.ts` still ships: AES-256-GCM at `~/.craft-agent/credentials.enc` (line 44-45), magic `CRAFT01\0` (line 48), key = PBKDF2-SHA256, 100k iterations (line 58) over a hardware machine ID — macOS `IOPlatformUUID`, Windows registry `MachineGuid`, Linux `/var/lib/dbus/machine-id` (lines 65-99) — salted with `'craft-agent-v2'` (line 314), with a v1-hostname legacy key for one-shot migration (lines 327-335). Written `mode: 0o600` (line 303), dir `0o700` (line 272). On any decrypt failure it **deletes the file** (`handleCorruptedFile`, lines 338-350).

Ours is the same code with `NESSY01\0` and `CONFIG_DIR` — `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/credentials/backends/secure-storage.ts:63-75`. **The two magic values are incompatible**, so the stores cannot be shared or migrated between the apps.

In their fork this store now only ever holds *source* credentials (MCP/API OAuth), never LLM keys. `EnvironmentBackend` is hard-disabled — `packages/desktop/packages/shared/src/credentials/backends/env.ts:15-18` returns `false` from `isAvailable()` with the comment "Disabled by user request to force manual API keys".

### Where keys actually come from: ACP `authenticate` delegation

`packages/desktop/packages/shared/src/agent/nessy-agent.ts:209-210`:
```ts
const NESSY_DESKTOP_AUTH_METHOD_ID = 'dp-auth';
const NESSY_AUTH_TIMEOUT_MS = 310_000;
```

Two entry points:

**(a) First-run, blocking.** `packages/desktop/apps/electron/src/main/index.ts:325-352` — `prepareNessyFirstRun()` runs `ensureDefaultExtensionInstalled()`, then `authenticateNessyViaSharedAcp(...)`, then a model refresh, then clears the pending flag. `authenticateNessyViaSharedAcp` (`nessy-agent.ts:730-771`) spawns a shared ACP process and calls `lease.authenticate(NESSY_DESKTOP_AUTH_METHOD_ID)`. The flag is set on fresh-profile boot (`main/index.ts:483-485`) and surfaced over IPC as `app:needsNessyFirstRunPreparation` / `app:prepareNessyFirstRun` (`main/index.ts:696-703`). The renderer blocks the whole app on it — `apps/electron/src/renderer/App.tsx:880-893`, showing `startup.preparingNessy` / `startup.preparingNessyFailed` with a retry (`App.tsx:2463-2465`). The normal provider-setup onboarding screen is skipped entirely (`App.tsx:905-909`, "Skip the first-run provider setup screen").

**(b) Lazy, on demand.** `nessy-agent.ts:342-373` — `callAcp()` wraps every ACP call; on error it inspects `error.data.authMethods` for an entry with `id === 'dp-auth'` (`offersNessyAuthMethod`, `nessy-agent.ts:152-167`) and, **only for `session/*` methods**, runs `lease.authenticate('dp-auth')` and replays the call once. `authenticate()` itself is single-flight via `this.authPromise` (`nessy-agent.ts:344-359`), with the 310s timeout — the browser device flow's budget.

The subprocess env carries no secrets by design — `nessy-agent.ts:435-457` builds `{...process.env, ...getProxyEnvVars(), ...envOverrides}`, deletes `CRAFT_SESSION_DIR`, and deletes `DEV` when packaged (with a good comment about Ink's `react-devtools-core` resolve hanging behind a corporate proxy). The only per-session override is `CRAFT_WORKSPACE_PATH` (`packages/server-core/src/sessions/SessionManager.ts:4955-4957`).

### What the CLI does with it (the other half of the chain)

- `packages/core/src/dp/dpConfig.ts:41,86-90` — creds at `<NESSY_HOME>/dp_auth_creds.json`; managed `dp` binary at `<NESSY_HOME>/dp_latest/dp`, version `13.14.1`, downloaded from `https://code-completion-nestor.tcsbank.ru/api/v2/download/dp` with per-platform MD5 pins (lines 33-39), mode `0o700` (line 32).
- `packages/core/src/dp/dpAuthManager.ts:102-141` — `performDpAuth()`: ensure binary → WSL detect → `dp auth print-token`; only if that yields nothing, `dp auth login` (browser) then re-read. Single-flight via `performDpAuthRequest`. `prepareAuth()` (lines 20-36) retries once after `removeDp()`.
- `packages/core/src/dp/dpTokenManager.ts:26-32` — `getValidCredentials()` returns creds only while `expiresAt > Date.now()`, **no clock-skew buffer**.
- `packages/core/src/dp/nestorAuthHeader.ts:24-29` — header selection: `Authorization: Bearer <jwt>` **only** when the JWT is byte-identical to `NESSY_CLI_DP_AUTH_TOKEN`, else `Nestor-Token: <jwt>`. The docstring (lines 5-22) explains why: oathkeeper runs two authenticators — `oauth2_introspection` against `/api/v2/token/introspect` for Nestor-issued tokens, `spirit_iam` JWKS verification for delegated Spirit IAM tokens.

### On 401

Three layers, all in the desktop:

1. **ACP-level** (`nessy-agent.ts:352-372`) — `authMethods`-carrying errors on `session/*` trigger `authenticate('dp-auth')` + one replay.
2. **Text-sniffing fallback** (`packages/server-core/src/sessions/SessionManager.ts:11396-11409`) — matches `'token is expired'`, `'authentication token is expired'`, `'please try signing in again'`, or `401` co-occurring with `unauthorized`/`auth`, then calls `attemptAuthRetry`.
3. **`attemptAuthRetry`** (`SessionManager.ts:9023-9080`) — gated by `managed.authRetryAttempted` so it fires **at most once per session**; emits an `info` event `'Token expired, refreshing session…'` instead of a red error, calls `resetSummarizationClient()`, sets `managed.agent = null` (forcing a fresh agent whose `postInit()` re-auths), removes the failed user message, and replays `lastSentMessage`.

Separately, title-generation failures containing `quota|429|401|insufficient` are surfaced as a retryable `typed_error` (`SessionManager.ts:10920-10940`) — a cheap early-warning that the main chat call will fail too.

There is an `appState === 'reauth'` branch in `App.tsx:2473-2486`, but `App.tsx:863` labels the login handler a "placeholder (reauth is not currently used)" — dead upstream path.

---

## 3. The MCP layer

### `client.ts` (152 lines)

`CraftMcpClient` wraps `@modelcontextprotocol/sdk`, both transports (`client.ts:71-108`). Stdio spawns inherit `process.env` **minus a hardcoded denylist** — `client.ts:43-59`:
```ts
const BLOCKED_ENV_VARS = [
  'LLM_API_KEY', 'NESSY_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN', 'GH_TOKEN', 'GOOGLE_API_KEY', 'STRIPE_SECRET_KEY', 'NPM_TOKEN',
];
```
The comment at `client.ts:40-41` flags that this list is duplicated in `packages/session-tools-core/src/handlers/transform-data.ts` (`BLOCKED_ENV_VARS`) and must be kept in sync — a documented footgun. **Note the gap: `NESSY_CLI_DP_AUTH_TOKEN` is not on this list**, so a delegated Spirit IAM token in the environment reaches every stdio MCP subprocess.

`connect()` (lines 110-126) does a `listTools()` health check and closes on failure. The `PoolClient` interface (lines 65-69) is the shared contract.

### `api-source-pool-client.ts` (52 lines)

`ApiSourcePoolClient` adapts an in-process `McpServer` (from `createSdkMcpServer`) to `PoolClient` via `InMemoryTransport.createLinkedPair()` (line 26). No process, no socket — REST "API sources" get exposed as MCP tools with zero IPC cost.

### `mcp-pool.ts` (459 lines)

`McpClientPool` owns every source connection in the main process. Its own docstring (lines 9-13) names the wins: one code path for all backends, clients shared across sessions, **"No credential cache files — main process has direct access"**, and runtime source switching without a session restart.

State: `clients`, `activeConfigs`, `toolCache`, `proxyTools` (lines 102-112). Naming convention is `mcp__{slug}__{toolName}` (line 111).

`sync()` (lines 236-306) is the reconciler:
- stdio sources are dropped when `isLocalMcpEnabled(workspaceRootPath)` is false (lines 241-250) — a per-workspace kill switch for local MCP;
- disconnect anything no longer desired; connect anything new;
- for already-connected sources, `mcpConfigChanged()` (lines 85-99) compares `type`, `url`, and **`headers['Authorization']`**, and disconnect+reconnects on a diff. That is how a refreshed OAuth token propagates — there is no in-place header update.
- returns a `failures: string[]` of slugs rather than throwing.

### Where headers come from

`packages/desktop/packages/shared/src/sources/server-builder.ts:119-148` layers three tiers in increasing precedence: static config headers → credential-store multi-headers → `Authorization: Bearer <token>`. If `authType !== 'none'`, there is no token, but `source.config.isAuthenticated` is true, it returns `null` (needs re-auth) rather than connecting unauthenticated (lines 140-144). Refresh + rate-limiting is `TokenRefreshManager` (`packages/shared/src/sources/token-refresh-manager.ts`), 5-minute cooldown after a failed refresh (line 19), instance-scoped so it's testable and session-isolated.

### How the CLI subprocess reaches the pool — two unauthenticated loopback servers

`packages/server-core/src/sessions/SessionManager.ts:4924-4949`: when `backendContext.capabilities.needsHttpPoolServer`, the host starts `McpPoolServer` (pool proxy) and `LocalMcpHttpServer` (session-scoped tools), syncs the pool *before* the SDK connects, and hands both URLs to the agent.

`nessy-agent.ts:3710-3728` turns them into the ACP `mcpServers` array:
```ts
if (this.config.poolServerUrl)    hostedServers.push({ type:'http', name:'craft_sources', url: this.config.poolServerUrl, headers: [] });
if (this.config.sessionServerUrl) hostedServers.push({ type:'http', name:'session',       url: this.config.sessionServerUrl, headers: [] });
if (hostedServers.length > 0) return hostedServers;   // hosted mode fully replaces direct sources
```

Both servers: `listen(0, '127.0.0.1')` on a random port, path `/mcp`, stateless `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` — `pool-server.ts:66-95`, `local-http-server.ts:20-49`. **No bearer token, no `Origin` check, no `enableDnsRebindingProtection`** (grep for those symbols across `packages/shared/src/mcp/` and `packages/server-core/src/` returns nothing relevant). `headers: []` confirms nothing is sent. Any local process that finds the port owns every source tool.

`pool-server.ts:106-125` strips the `mcp__` prefix outbound and re-adds it on `callTool`, so a Codex-style client that prefixes its own namespace ends up with `mcp__sources__craft__search_spaces` — a leftover of upstream's multi-backend design, still carried in this Nessy-only fork. `notifyToolsChanged()` is a no-op in stateless mode (lines 148-152).

### dp-backed remote MCP: **none in the desktop**

No `Nestor-Token`, no dp module, no `tcsbank` string anywhere in `packages/desktop`. The dp-backed MCP servers (dpGitlab, dpJira) come from the CLI extension `@nestor/nessy-cli-extensions`, installed at first run from Artifactory — `apps/electron/src/main/index.ts:256, 286-300`:
```
nessy extensions install @nestor/nessy-cli-extensions \
  --registry=https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all --auto-update --consent
```
(`'already installed'` in stderr is treated as success, lines 310-313.) They run *inside* the CLI and inherit dp auth there.

The desktop only **edits** CLI-side MCP config, over ACP ext-methods — `nessy-agent.ts:897-923`: `nessy/settings/setMcpServer`, `nessy/settings/removeMcpServer`, each scoped (`NessySettingsScope`) and cwd-qualified. The DTO (`packages/shared/src/protocol/dto.ts:586-601`) carries `command/args/cwd/env/httpUrl/url/headers/timeout/trust/includeTools/excludeTools/extensionName`, and the settings UI exposes a free-text headers box (`apps/electron/src/renderer/pages/settings/NessySettingsPage.tsx:1329-1335, 1691-1697`, parsed by `parseKeyValueLines`).

**That is the leak.** Those headers land in the CLI's `settings.json` via `saveSettings` → `updateSettingsFilePreservingFormat` → `writeWithBackupSync` (`/Users/i.i.gavrikov/Desktop/work/nessy-cli/packages/cli/src/utils/writeWithBackup.ts:64-84`), which passes **no `mode`** to `fs.writeFileSync` — default `0o666 & ~umask`, i.e. typically 0644 — and additionally renames the previous file to `settings.json.orig`, leaving a second world-readable copy of the old secrets. Its temp path is a fixed `${targetPath}.tmp` (line 69), collision-prone under concurrency. So a secret typed into the desktop's MCP UI ends up in **plaintext, 0644, in two files** — while an unrelated MCP OAuth token in the same app sits in AES-256-GCM at 0600.

One dead upstream artifact remains: `packages/shared/src/sources/builtin-sources.ts:36-64` still defines a `craft-agents-docs` source pointing at `https://agents.craft.do/docs/mcp`, but it is `enabled: false`, marked `@deprecated`, and `isBuiltinSource()` returns `false` unconditionally (lines 75-77). No live reference to that host survives.

---

## 4. Version / release coupling

**The 0.13.11-beta.0 lockstep is real but shallow — and it is *not* the CLI-runtime pin.**

Three separate version axes:

**(a) Marketing version — lockstep, one-way (CLI → desktop).** `/Users/i.i.gavrikov/Desktop/work/nessy-cli/scripts/version.js:129-140` is step 8 of the CLI's own bump:
```js
execSync(`cd packages/desktop && bun run bump-desktop-version ${newVersion}`, { stdio: 'inherit' });
```
wrapped in try/catch that only warns on failure — the CLI release proceeds with a stale desktop version if the bump breaks. `bump-desktop-version` (`packages/desktop/scripts/bump-desktop-version.ts`) writes exactly three files, listed at `packages/desktop/scripts/desktop-release-version.ts:19-23`:

| Label | Path |
| --- | --- |
| root package | `packages/desktop/package.json` |
| Electron app package | `packages/desktop/apps/electron/package.json` |
| shared package | `packages/desktop/packages/shared/package.json` |

`normalizeReleaseVersion` (same file, lines 25-54) strips `refs/tags/` and a leading `v`, requires valid SemVer, and **rejects `+build` metadata** for desktop releases. `check-release-version.ts` re-reads all three and fails with a markdown table of mismatches (lines 68-136). Note `packages/desktop/packages/core/package.json:3` stays at `0.0.1` — it is not in the bump set.

**(b) Bundled CLI runtime — decoupled.** `packages/desktop/package.json:12-14` pins `nessyCodeRuntime.version: "0.15.11"` while the repo sits at `0.13.11-beta.0`. This is the CLI build the packaged app actually ships. Resolution order is documented in `packages/desktop/README.md` and implemented in `scripts/vendor-nessy-cli.ts:60-140` / `scripts/electron-dev.ts:62-121`:

- *dev:* `NESSY_CLI` / `NESSY_CLI_ROOT` / `NESSY_CLI_PATH` → `NESSY_CLI_TARBALL` → `NESSY_CLI_VERSION` → local monorepo checkout → existing vendored CLI → `nessyCodeRuntime.version`
- *dist:* `NESSY_CLI_TARBALL` → `NESSY_CLI_VERSION` → `NESSY_CLI_ROOT`/`PATH` → local checkout → `nessyCodeRuntime.version`

Local-checkout vendoring runs the CLI's real publish pipeline (`npm run build -- --cli-only --web-shell`, `bundle`, `prepare:package`) and copies `dist/` into the vendor dir, verifying `cli.js` or `dist/cli.js` exists (`vendor-nessy-cli.ts:94-123`).

**(c) Release triggers — two independent CI systems.**
- GitHub: `packages/desktop/.github/workflows/desktop-release.yml` — `workflow_dispatch` with inputs for version, `nessy_cli_source` (npm dist-tag `latest` / exact npm version / `source_branch` from `NessyLM/nessy-cli`), running `bump-desktop-version` then `check-release-version` then the electron-builder matrix (lines 118-124, 239-270).
- GitLab: `/Users/i.i.gavrikov/Desktop/work/nessy-cli/.gitlab-ci.yml` — tag pattern `^release-desktop-\d+\.\d+\.\d+(-beta\.\d+)?$` (lines 108, 117), `COMPONENT_TYPE == 'desktop'` (line 66), bundle id `ru.tfinance.nessy-cli.desktop` (line 52), and `build_desktop_linux/windows` jobs (lines 545-610) that derive `DESKTOP_VERSION` from the tag or fall back to `require('./packages/desktop/package.json').version`, then run `bump-desktop-version` before building. So the desktop can ship on its own `release-desktop-*` tag without a CLI release.

---

## Hints for nessy-desktop

### Copy

1. **The `// [nessy-fork] <topic>` marker + a sync script.** 36 markers for one feature (`desktop-first-run-setup`) means an upstream rebase is a mechanical filter, not an archaeology dig. We fork the same upstream and have no equivalent. `scripts/desktop-openwork-sync.ts` with `--overlay-path` exclusions is the working model.

2. **Delegate the device flow instead of re-implementing it.** Their entire dp story is one constant and one call: `NESSY_DESKTOP_AUTH_METHOD_ID = 'dp-auth'` (`nessy-agent.ts:209`) + `lease.authenticate(methodId)`. We own `packages/shared/src/auth/dp` — 11 modules including `dp-binary.ts`, `dp-runtime.ts`, `exchange.ts`, `session-broker.ts` — duplicating logic that already exists and is maintained in `packages/core/src/dp/`. For the Pi/CLI path specifically, ACP `authenticate` would let us delete our copy of the binary-download/MD5-pin/WSL-detect ladder. (Our own copy stays necessary for `claude-runtime` and `codex-runtime`, which never touch the CLI.)

3. **Single-flight the auth promise.** `nessy-agent.ts:344-359` holds one `this.authPromise`; the CLI does the same at two levels (`dpAuthManager.ts:14-15, 102-112`). This directly addresses the "warm-path залипает" symptom in our `dp auth user failures` note — concurrent callers racing `dp` invocations is exactly what produces duplicate browser logins.

4. **Once-per-session auth retry with an `info` event, not an error.** `SessionManager.attemptAuthRetry` (`SessionManager.ts:9023-9080`): `authRetryAttempted` guard, `'Token expired, refreshing session…'` as info, null the agent so `postInit()` re-auths, pop the failed user message, replay. The guard is what makes it safe — no retry storm on a genuinely revoked token.

5. **Reconnect-on-`Authorization`-diff as the token-refresh propagation path.** `mcpConfigChanged` (`mcp-pool.ts:85-99`) compares exactly `type`, `url`, `headers['Authorization']` and forces disconnect+connect. Simple, and it can't leave a client wedged on a stale header.

6. **`sync()` returning `failures: string[]` instead of throwing** (`mcp-pool.ts:236-306`) — one bad source degrades to a per-source badge instead of killing session startup.

7. **`bump-desktop-version` + `check-release-version` as separate write and verify steps.** Our close-out rule ("bump the version in BOTH root and electron `package.json` (lockstep)") is prose enforced by discipline; theirs is `desktopReleasePackageSources` (a 3-element array, `desktop-release-version.ts:19-23`) plus a CI gate that prints a mismatch table. Same rule, mechanized. Their rejection of `+build` metadata (line 44-48) is a nice guard too.

8. **The workspace-isolation CI check.** `check-desktop-isolation.js` proving `electron`/`electron-builder`/Sentry never leak into the host repo's lockfile — the same shape would let us assert our own package-boundary rules.

### Avoid

1. **Their plaintext MCP-header path is a real leak — do not replicate it, and check we don't already have it.** Secrets typed into the desktop MCP UI (`NessySettingsPage.tsx:1329-1335`) travel over ACP into the CLI's `settings.json`, written by `writeWithBackupSync` with **no `mode` argument** (`writeWithBackup.ts:64-84`) → ~0644, **plus** a `settings.json.orig` copy of the previous contents at the same permissions. Meanwhile an MCP OAuth token in the same app is AES-256-GCM at 0600. If we add a headers field to any MCP UI, the writer must be mode-0600 and must not leave a `.orig`.

2. **Unauthenticated loopback MCP servers.** `McpPoolServer` and `LocalMcpHttpServer` bind `127.0.0.1:0` with no token, no `Origin` validation, no DNS-rebinding protection, and are handed to the agent with `headers: []` (`nessy-agent.ts:3712-3726`). Any local process that scans the port gets every connected source tool plus session-scoped tools. **We should audit our own `McpPoolServer`/`LocalMcpHttpServer` for the same gap** — same upstream, likely the same code. A per-session random bearer in the `headers` array is a two-line fix on both sides.

3. **`NESSY_CLI_DP_AUTH_TOKEN` missing from the stdio denylist.** `BLOCKED_ENV_VARS` (`client.ts:43-59`) blocks `LLM_API_KEY`, `NESSY_API_KEY`, AWS, GitHub, Google, Stripe, npm — but not the delegated Spirit IAM token that `nestorAuthHeader.ts:25` reads. Any stdio MCP server inherits it. If we maintain a copy of that list, add the dp/Nestor vars. And note their own comment (`client.ts:40-41`) that the list is duplicated in `session-tools-core` — a denylist that must be manually mirrored will drift; make it one exported constant.

4. **Non-atomic, non-merging creds writes.** `dpTokenManager.saveCredentials` (`dpTokenManager.ts:46-58`) is a bare `fs.writeFileSync` of the whole object: a concurrent reader can see a torn file, and a save from the auth flow **drops `cachedModels`** because the new `DpCredentials` doesn't carry it (only `saveDpModelsCache`, lines 65-81, does a read-modify-write). Our `packages/shared/src/auth/dp/creds-store.ts:90-96` is strictly better — `{...existing, ...next}`, unique tmp `${credsPath}.${pid}.${uuid}.tmp`, `chmodSync` 0600 regardless of umask, then `renameSync`. **Keep ours; do not "align with the CLI" here.** Worth raising with the nessy-cli owners, since we share that file and their writer can clobber keys we wrote.

5. **Stubbing auth functions to constants rather than deleting them.** `hasLlmCredentials` returning `authType === 'none'` (`manager.ts:399-405`) silently orphaned four private helpers (lines 411-450) that still look live. This is exactly the failure mode our AGENTS.md warns about ("enforcement one layer up" — an unused-identifier sweep won't catch these). If we ever narrow provider types, delete the branches instead of short-circuiting the predicate above them.

6. **A blocking, all-or-nothing first-run.** `prepareNessyFirstRun` chains extension-install → dp-auth → model-refresh (`main/index.ts:330-339`) behind a full-screen gate, and any failure leaves the app at `startup.preparingNessyFailed` with only a retry. A registry hiccup on `@nestor/nessy-cli-extensions` blocks sign-in entirely. Our one-click `dp` sign-in should keep the extension install optional/deferred.

7. **Don't read their `nessyCodeRuntime.version` as the release version.** `0.15.11` (the bundled CLI) vs `0.13.11-beta.0` (the app) are different axes. If we ever pin a nessy-cli build, mirror that split rather than assuming the lockstep bump covers it — and note their CLI-side bump is a warn-only try/catch (`version.js:136-140`), so the "both bumped together" invariant is best-effort, not enforced, on the CLI side. Only `check-release-version` in the desktop's own pipeline actually enforces it.
# Appendix C — Task C: dp mcp remote / F2 transport pool (full report)

# TASK C — "dp mcp remote" / MCP transport pool in nessy-cli

## 0. Headline finding (read this first)

**There is no "dp mcp remote" flow in nessy-cli.** The premise does not hold in that repo:

- Every dp-backed MCP server in nessy-cli is a **plain stdio subprocess** `dp ai mcp <subcommand>`. No HTTP, no SSE, no gateway proxy, no token injection.
- The string `dp ai mcp` appears in nessy-cli in **exactly one file** — a docs table (`/Users/i.i.gavrikov/Desktop/work/nessy-cli/deploy/async/README.md:67-69`) — plus the backing settings file. `rg -an "mcp remote|remote --url|ai mcp"` over the whole repo (node_modules excluded) returns only those docs hits and two unrelated `@google/genai mcpToTool` comments.
- The gateway JWT (`Nestor-Token`) is **never** attached to an MCP transport in nessy-cli. `buildNestorAuthHeaders` (`/Users/i.i.gavrikov/Desktop/work/nessy-cli/packages/core/src/dp/nestorAuthHeader.ts:24-30`) has exactly two consumers: the LLM provider (`packages/core/src/core/openaiContentGenerator/provider/nestor.ts:57-61`) and telemetry/error clients (`packages/core/src/telemetry/nessy-dlh/dlh-client.ts:42`). MCP headers come only from the user's own `mcpServers.<name>.headers` / OAuth token store (`packages/core/src/tools/mcp-client.ts:845-846`, `:2094-2127`).
- The concept `dp ai mcp remote --url <URL>` exists **only in OUR repo**, as a documented *exclusion*: `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/mcp/builtin-dp-servers.ts:150-158`. We are the side that discovered and named it; nessy-cli has never touched it.

So the honest comparison is: **nessy-cli's F2 transport pool** (a general MCP sharing/lifecycle layer) vs **our built-in dp set + workspace pool registry**. dp enters nessy-cli only as a *binary lifecycle* concern, not as a transport concern.

---

## 1. The design doc: `docs/design/f2-mcp-transport-pool.md`

96 KB, v2.2, 25 sections. `docs-ru/design/f2-mcp-transport-pool.md` is a **straight translation** — both files have exactly 103 headings and identical section titles/numbering (`docs-ru/.../f2-mcp-transport-pool.md:139` "Цели / Не-цели" ↔ `docs/.../f2-mcp-transport-pool.md:135` "Goals / Non-goals"). No extra detail in RU; ignore it.

### Goals / non-goals (`:135-155`)

Goals: N sessions in 1 workspace share 1 process per unique-server-config, fingerprint-keyed; per-session `ToolRegistry`/`PromptRegistry` views preserved; refcount + grace-drain resilient to reattach; cross-platform descendant-pid cleanup; budget guardrails graduate from per-session to per-workspace; backward-compat with non-daemon standalone nessy (pool simply not constructed).

Explicit non-goals: cross-workspace pooling ("1 daemon = 1 workspace" stands), cross-daemon pooling, OAuth rework (deferred to F3), pool persistence across daemon restart (in-memory only), auto-detection of "pool-safe" HTTP servers (opt-in flag only), live config diff/in-place mutation (config change → new entry, old one drains).

### Replacement target and coupling map (`:157-192`)

Pre-F2, `acpAgent.newSession` → `newSessionConfig` → `new Config` → `ToolRegistry` ctor → `new McpClientManager` → one `McpClient` per server **per session**. The doc tabulates eight couplings to break (`McpClient` ctor binding one ToolRegistry, `discover()` registering inline, the `ListRootsRequestSchema` closure, per-connect `onDirectoriesChanged` listener, `McpClientManager` new'd inside ToolRegistry, per-session budget, `serverDiscoveryPromises`, `setMcpBudgetEventCallback`), and three pieces of already-shared module-level state the pool inherits rather than introduces (`serverStatuses`, `mcpServerRequiresOAuth`, on-disk `~/.nessy/mcp-oauth/<name>.json`).

### Reference findings (`:192-202`)

Prior art table: claude-code (no pool, `name + JSON.stringify(cfg)` memoize, sorted-key SHA-256 `hashMcpConfig`), opencode (pool per workspace keyed on **server name only**, no refcount/eviction/restart, `pgrep -P` recursive SIGTERM). F2 takes config-hash keying from the former, descendant-pid sweep from the latter, and adds refcount+drain, auto-restart, prompt fan-out, generation guard.

### Architecture (`:205-276`)

The pool lives in the **ACP child** (`nessy --acp`), not the HTTP daemon; the daemon queries it over the existing bridge extMethod surface (`getMcpPoolAccounting`, `restartMcpServer`). Four classes: `McpTransportPool` (acquire/release/releaseSession/restartByName/getAccounting/drainAll), `PoolEntry` (refs Set, client, tools/prompts snapshots, generation counter, state machine, drain timer, health monitor, subscribers), `PooledConnection` (the handle: events + `callTool`/`readResource`/`release`), and `SessionMcpView` (per session × server: filters by include/exclude, decorates trust, registers into the session's own registries).

### Transports and pool key (`:279-347`)

`ConnectionId = ${serverName}::${sha256(canonical).slice(0,16)}`. Canonical fields are transport-defining only: transport, command, args, cwd, env, url, httpUrl, tcp, headers, timeout, oauth, authProviderType, targetAudience, targetServiceAccount. Excluded: includeTools/excludeTools/trust/description/extensionName.

`POOLED_TRANSPORTS_DEFAULT = {stdio, websocket}` (`:321-339`). HTTP/SSE are **excluded from sharing by default** with a stated reason: some MCP HTTP implementations bind state (auth context, conversation memory) to the TCP/SSE stream, so multiple ACP sessions sharing it would bleed state. Operators opt in via `--mcp-pool-transports=` / `NESSY_SERVE_MCP_POOL_TRANSPORTS=`. SDK MCP servers **always** bypass (`:340-347`) via `createUnpooledConnection` — `sendSdkMcpMessage` routes through the ACP control plane back to the originating session, so it is per-session by design.

### Lifecycle (`:350-537`)

- acquire/release/releaseSession with a `sessionToEntries` reverse index for O(refs) bulk release (`:350-437`); `spawnInFlight` dedupes concurrent acquires (`:439-442`) — without it, 5 sessions at boot race to spawn 5 children.
- `DRAIN_DELAY_MS_DEFAULT = 30_000`, `MAX_IDLE_MS_DEFAULT = 5 * 60_000` (`:443-462`). The state machine is `spawning → active → draining → closed`, with `draining --attach--> active` cancelling the timer; MAX_IDLE is a separate timer started at first idle and **never reset**, so acquire/release thrash cannot keep a zombie alive.
- Descendant-pid sweep (`:463-513`), rewritten 2026-05-22 from per-pid BFS to **one process-table snapshot** (`ps -A -o pid=,ppid=` / `Get-CimInstance Win32_Process | ConvertTo-Csv`) plus an in-memory tree walk — one fork instead of B^D, and snapshot consistency (BFS could miss processes forked between levels). Per-pid path kept as fallback for BusyBox `ps` <1.28 and distroless. Caps MAX_DESCENDANTS=256 / MAX_DEPTH=8. Handles `npx`/`uvx`/`pnpm dlx` wrapper leaks.
- Reconnect backoff per transport family (`:523-537`): stdio/websocket fixed 5s × 3; http/sse exponential 1/2/4/8/16s × 5 ("remote endpoints flap on transient network issues").

### Auth (`:879-896`) — the section closest to the task's premise

**OAuth is explicitly deferred to F3.** Mode-B daemon must not spawn a browser (a static grep test fails the build on `open`/`xdg-open`/`shell.openExternal`). F2's behaviour on an OAuth-requiring server: 401 → entry marked `failed_auth_required` → status route surfaces `errorKind: 'auth_env_error'` → **no automatic retry** → operator runs `/mcp auth <name>` or the PR-21 device-flow route to put a token on disk → next acquire succeeds. Token storage is the shared on-disk `MCPOAuthTokenStorage` at `~/.nessy/mcp-oauth/<name>.json` (`:696-701`). There is **no dp involvement and no gateway involvement anywhere in the auth story**.

### Rest

Discovery/`SessionMcpView` dual tools+prompts fan-out with snapshot replay on attach and a generation counter as stale-handler guard (`:538-661`); workspace budget graduation (`:795-878`); restart/status route semantics (`:899-1012`); shutdown ordering (`:1078-1113`); file layout (`:1114-1152`); capability tags `mcp_workspace_pool` / `mcp_pool_restart` advertised atomically (`:1182-1226`); 16-case test matrix (`:1227-1322`).

---

## 2. The implementation

### `packages/core/src/tools/mcp-pool-key.ts` (181 lines)

- `PoolKey` = truncated SHA-256, 16 hex chars (`:16-22`).
- `POOLED_TRANSPORTS_DEFAULT = new Set(['stdio','websocket'])` (`:38-40`) — matches the doc.
- `isPoolable` (`:47-53`): SDK MCP always false, everything else gated on the operator's set.
- `canonicalOAuth` (`:74-90`) carries a **security correction the doc's v2 sketch lacked**: the pre-fix version hashed only `clientId`/`scopes`/`authorizationUrl`/`tokenUrl`, so "two configs differing ONLY in `clientSecret` / `audiences` / `redirectUri` / `tokenParamName` / `registrationUrl` collapsed to the same fingerprint and shared a pool entry, leaking the first config's effective credentials/audience/redirect into the second session's transport" (`:64-72`). All ten fields are hashed now.
- `fingerprint` (`:127-148`) hashes four more fields than the doc's sketch (`tcp`, `authProviderType`, `targetAudience`, `targetServiceAccount`). Known gap recorded inline: `discoveryTimeoutMs` is honoured from the first acquire but not keyed — first-writer-wins on a race (`:122-125`).
- `connectionIdOf` / `parseConnectionId` (`:157-181`).

`mcpTransportOf` (`packages/core/src/tools/mcp-client-manager.ts:257-264`) is the transport discriminator: `sdk` → `http` (httpUrl) → `sse` (url) → `websocket` (tcp) → `stdio` (command) → `unknown`.

### `packages/core/src/tools/mcp-transport-pool.ts` (1426 lines)

Options interface at `:55-79` (workspaceContext, debugMode, sendSdkMcpMessage, pooledTransports, drainDelayMs, entryOptions, budget). Class at `:105` with `entries` / `unpooledIds` / `spawnInFlight` / `sessionToEntries` / `draining` mutex / `nextIndexByName`. Public surface: `acquire` (`:210`), `release` (`:505`), `releaseSession` (`:524`), `restartByName` (`:554`), `getSnapshot` (`:635`), `aggregateStatusByName` (`:689`), `drainAll` (`:710`), plus privates `spawnEntry` (`:943`) and `createUnpooledConnection` (`:1147`).

`acquire` is noticeably more defensive than the design sketch — roughly half its body is race commentary for terminal-state attach (`:225-300`): a pre-check `isTerminated()`, a post-attach `try/catch` that self-heals by evicting and re-spawning, and `indexAttach` moved to **after** a successful attach (pre-fix ordering left a stale `sessionToEntries` mapping with no matching `entry.refs`, so a later `releaseSession` detached a session that was never attached). Eviction routes through `evictEntry` so the budget slot is released; a bare `entries.delete(id)` leaked the slot permanently.

Per-session credential isolation is asserted at `packages/core/src/tools/mcp-pool-entry.ts:236` and `:509` — env API keys, header auth tokens and OAuth fields are all in the fingerprint, so divergent credentials produce **distinct entries** rather than a shared one.

### Wiring — `packages/cli/src/acp-integration/acpAgent.ts`

`new McpTransportPool(this.config, {...})` at `:2686`, inside a constructor guarded by the `NESSY_SERVE_NO_MCP_POOL === '1'` kill switch (`:2676`). `pooledTransports` from `parsePooledTransports(process.env['NESSY_SERVE_MCP_POOL_TRANSPORTS'])` (`:2696`, parser at `:2465-2485` — an all-unknown value falls back to defaults so an operator typo cannot silently disable pooling). `drainDelayMs` from `NESSY_SERVE_MCP_POOL_DRAIN_MS` (`:2699`). `sendSdkMcpMessage` deliberately left undefined. Session teardown calls `this.mcpPool?.releaseSession(sessionId)` at `:2630` and `:2655`.

### `packages/desktop/packages/shared/src/mcp/*` — **not what the task assumed**

`packages/desktop` in nessy-cli is a vendored copy of **openwork** (`packages/desktop/package.json:2` `"name": "openwork"`, Model Studio AI), i.e. the same craft-agents-oss lineage OUR nessy-desktop forked from — a *sibling* fork, not nessy-cli's own MCP path and not connected to `McpTransportPool` at all.

- `packages/desktop/packages/shared/src/mcp/mcp-pool.ts` is 459 lines: `McpClientPool` with `clients`/`activeConfigs`/`toolCache`/`proxyTools` keyed by **bare slug**, `connect`/`disconnect`/`sync`, and `mcpConfigChanged` (`:79-96`) comparing only `url` + `headers['Authorization']` to detect token refresh. No fingerprint, no refcount, no leaser, no drain.
- `api-source-pool-client.ts` (52 lines) wraps an in-process `McpServer` over `InMemoryTransport.createLinkedPair()` so API sources present the same `PoolClient` interface as remote MCP (`:15-51`).
- For scale: `diff` against our `packages/shared/src/mcp/mcp-pool.ts` (2817 lines) is 3266 lines. Ours is far ahead of the copy nessy-cli vendored.

---

## 3. Every place dp touches MCP in nessy-cli

| Site | What it is |
| --- | --- |
| `deploy/async/.nessy/settings.json` | The only real dp MCP config in the repo: `dpWiki` → `{"command":"dp","args":["ai","mcp","wixie"]}`, plus `jira`, `mr`, `gitlab` (with an `autoApprove` list), alongside npx `context7`/`docforge`. Baked into the Docker image at `/root/.nessy/`. |
| `deploy/async/README.md:65-71` | The docs table — the only `dp ai mcp` prose in the repo. |
| `deploy/async/entrypoint.sh:5-27, :92` | `DP_TOKEN` env → written into creds. This is **LLM/gateway auth**, not MCP auth. |
| `packages/cli/src/core/dpBinary.ts:25-32` | `ensureDpBinary()`. Doc comment states the contract exactly: "the bundled dp MCP servers (dpWiki, codeSearch, dpJira, …) spawn the binary directly from `config.initialize()`, so it has to exist by then even when DP auth is not in use… Never throws: a missing binary degrades the dp MCP servers, but must not block CLI startup." |
| `packages/cli/src/core/initializer.ts:47` | The same note at the call site. |
| `packages/core/src/dp/dpConfig.ts:17-42` | Managed-binary constants: pinned version `13.14.1`, `dp_latest` workdir, per-platform md5, download prefix `https://code-completion-nestor.tcsbank.ru/api/v2/download/dp`, `binaryMode: 0o700`. Paths at `:76-84` route through `Storage.getGlobalNessyDir()` so they follow `NESSY_HOME`. |
| `docs/fork-patches/dp-binary-lifecycle.md` | Fork-patch rationale: atomic download (tmpfile + md5 + chmod + `rename`), fitness judged by **running** `dp --version` rather than checksum (because `dp update` self-updates and a pinned md5 is inapplicable by construction), blocking `dp update` on every start because "an outdated binary breaks MCP connections", install hoisted to the top of `initializeApp` independent of auth type, and `exec` → `execFile` (an unescaped `NESSY_HOME` with a space broke the command). |
| `docs/fork-patches/mcp-managed-dp-placeholder.md:9-20` + `packages/cli/src/config/settings.ts:1408-1410` + `packages/core/src/extension/extensionManager.ts:841-849` | `${NESSY_DP}` placeholder → `getDpFilePath()` when `process.env.NESSY_DP` is unset, resolved through the same `${VAR}` resolver used for settings and extensions. |
| `docs/users/configuration/settings.md:627-640` | The documented shape: `"dpGitlab": { "command": "${NESSY_DP}", "args": ["ai","mcp","gitlab"] }`. |
| `packages/core/src/core/openaiContentGenerator/constants.ts:17-27` | `EXTERNAL_MODEL_MCP_WHITELIST` — `dpJira`, `dpGitlab`, `dpWiki`, `t-tracker`, `dpFinedog`, `dpSage`, `dpAllure`, `context7`. A fork patch gating which MCP servers external models may see. |

**Net**: dp in nessy-cli = "make sure an up-to-date binary exists at a stable path, and let user config point at it". Nothing in nessy-cli ships a dp server set, and nothing routes dp over a network transport.

---

## 4. Delta vs nessy-desktop

### 4a. dp MCP servers — we are far ahead

nessy-cli has **no compiled-in dp MCP set**; ours is a first-class subsystem. `packages/shared/src/mcp/builtin-dp-servers.ts:1-9` says this explicitly: "`nessy-cli` does not compile a base MCP set into the binary — it ships `deploy/async/.nessy/settings.json`… This module is the desktop equivalent of that file."

| Dimension | nessy-cli | nessy-desktop |
| --- | --- | --- |
| Server set | User-authored JSON, 5 servers in the async image | 28 compiled definitions, `builtin-dp-servers.ts:113-142`, derived from `dp ai mcp --help` on Spirit CLI 13.32.4 (`DP_AI_MCP_SUBCOMMANDS`, `:63-69`) ∪ four published `nessy-default-extension` marketplace rows (`:22-38`) |
| Binary | **Downloaded + self-updated**, pinned md5, `<NESSY_HOME>/dp_latest/` (`dpConfig.ts:17-42`) | **System dp only, never downloaded** — `resolveDpBinary()` PATH scan → `/usr/local/bin/dp` → typed `DpNotFound` (`packages/shared/src/auth/dp/dp-binary.ts:56-68`), by owner decision recorded at `:1-8` |
| Is dp ever executed to build the set? | Yes, `dp --version` + `dp update` on every start | **Never** — resolution is a filesystem lookup by contract (`builtin-dp-servers.ts:13-16`, `:232-239`); versions are probed only by the session broker, advisory-only |
| Spawn env | Whatever the user's config carries | `dpRuntimeEnvironment()` (`packages/shared/src/auth/dp/dp-runtime.ts:58-67`): `HOME`, `DP_NO_WARNINGS=true` (a dp update banner on stdout breaks MCP stdio framing), `DP_AI_MCP_SKIP_LOGIN=true` (fail fast, never open a browser), `DP_WORKDIR` when the state root resolves (`:28-49`, refusing `/` and `$HOME` because the root becomes a sandbox write grant) |
| Command written | Bare `dp` or `${NESSY_DP}` | **Resolved absolute path** — "an agent subprocess does not necessarily inherit the PATH that found it" (`builtin-dp-servers.ts:252-258`) |
| Credentials | None passed; dp self-authenticates | Same contract, stated as an invariant: "It never touches `~/.nessy/dp_auth_creds.json`… passes no token, header, or credential of any kind" (`:17-20`) |
| Per-server on/off | Hand-edit JSON | Persisted `builtinDpMcpServers.enabled` in `config.json` + RPC + Settings card (`packages/shared/src/config/builtin-dp-mcp-preferences.ts:96-120`); tolerant read / strict write asymmetry documented at `:12-24`. All 28 default **off** by owner decision 2026-08-01 (`builtin-dp-servers.ts:82-98`) |
| Collision handling | None | `mergeBuiltinDpMcpServers` (`:331-377`) yields twice — on a taken wire name, and on a taken `dp ai mcp <sub>` under another name — matched on the **argv tail**, never `command === 'dp'`, because a plugin-declared dp server arrives with its command rewritten to the supervised host executable (`:295-310`) |
| dp login | `dp auth login` via the managed binary | `DpSessionBroker` (`packages/shared/src/auth/dp/session-broker.ts:29-41`) — probe/ensure/withAccessToken/subscribe, 5s positive-probe cache (`:44-51`), surfaced as `RuntimeExternalAuthRequirement.provider: 'dp'` (`runtime-pool-servers.ts:70-90`) |
| `dp ai mcp remote` | Absent | Present as a **named exclusion with a reason** (`builtin-dp-servers.ts:150-162`) |

### 4b. Pooling — different shape, comparable strength, three concrete gaps

Ours pools per **workspace** across sessions and browse, via `WorkspaceMcpPoolRegistry` (`packages/server-core/src/mcp/workspace-mcp-pool-registry.ts:1-32`) leasing one `McpClientPool` (`:203-207`). Sessions take a session lease (`SessionManager.ts:14355`); browse takes a leaser-less one. Reconciliation is a **union across leasers** (`packages/shared/src/mcp/mcp-pool.ts:776-788`) — functionally equivalent to F2's refcount, and strictly more general than F2 because a workspace-level browse consumer participates too.

| Mechanism | nessy-cli F2 | nessy-desktop |
| --- | --- | --- |
| Key | `${name}::${sha256(canonical).slice(0,16)}` (`mcp-pool-key.ts:127-162`) | `JSON.stringify(['mcp', slug, sha256(stableJson(config))])` (`mcp-pool.ts:196-199`); `api`/`unbound` variants at `:204-215` — same idea, full-length hash |
| Sharing scope | Sessions in one ACP child (1 daemon = 1 workspace) | Sessions **and** the Sources-tab browse pool, one workspace | 
| Refcount | `refs: Set<sessionId>` + `sessionToEntries` reverse index | Per-leaser desired maps, union-reconciled, `syncChain` serializing concurrent syncs (`:790-794`) |
| Transport gating | HTTP/SSE **excluded from sharing by default**, opt-in via env (`mcp-pool-key.ts:32-40`) | **No equivalent.** All four transports of `SdkMcpServerConfig` (`packages/shared/src/agent/backend/types.ts:933-957`) are shared identically |
| Drain | 30s grace timer + never-reset 5min `MAX_IDLE` hard cap | Drain grace with in-flight call wait then abort (`mcp-pool.ts:1688-1700`), but **no idle timer and no idle cap** — keep-alive is the policy (`workspace-mcp-pool-registry.ts:13-23`) |
| Descendant-pid sweep | `listDescendantPids` snapshot+walk with `pgrep`/CIM fallback | **No sweep.** We rely on `ProcessSupervisorPort` (`packages/shared/src/mcp/client.ts:125`, `:478`, `:922`) — "a supervised stdio close resolves only after ProcessSupervisor has observed process termination" (`mcp-pool.ts:1699-1700`). Different guarantee: supervised direct children, not `npx`/`uvx` grandchildren |
| Reconnect backoff | Per-transport-family table (stdio 5s×3, http/sse exponential ×5) | Capability-discovery retry only (`mcp-pool.ts:87-88`, 3 attempts / 200ms base) |
| Budget guardrails | Workspace-scoped `WorkspaceMcpBudget` + SSE fan-out | No equivalent MCP-client budget |
| Kill switch | `NESSY_SERVE_NO_MCP_POOL=1` | None |

Where we are ahead of F2 inside the pool: elicitation routing attributed per leaser (`mcp-pool.ts:905-960`), channel push policy fail-closed (`:802-803`, `:1087`), MCP output token limits (`:44-50`), network address guard for `ws` targets (`:36-42`), a tool descriptor store, and large-response guarding.

### 4c. Auth delta

nessy-cli's MCP auth story is entirely `headers` + on-disk OAuth token store, with the whole flow deferred to F3 (`f2-mcp-transport-pool.md:879-896`). Ours already routes OAuth/bearer through plugin credential slots and dp through a broker, with all three unified into one `RuntimeExternalAuthRequirement` feed (`runtime-pool-servers.ts:70-90`), and it distinguishes builtin-set names — which gate on `needs-login` only — from plugin-bound ones (`:83-89`).

---

## 5. Adoption plan sketch

Three separable candidates. Only (A) is genuinely novel; (B) and (C) are hardening of what we already have.

### A. `dp ai mcp remote --url <URL>` as a supported transport

The only real "remote dp MCP" idea, and it is **ours to invent** — nessy-cli has nothing to port.

What it is, from what we already recorded: `remote` is a real `dp ai mcp` subcommand (`builtin-dp-servers.ts:64`), and it is a **proxy over a Streamable HTTP endpoint** (`:153`). The value is that dp handles corp auth for the endpoint, so the app never holds the token — same property that makes the 28 stdio builtins sign-in-free.

Components:
1. A new definition shape beside `BuiltinDpMcpServerDefinition` (`builtin-dp-servers.ts:71-100`) carrying a `url` and a display label — or, cleaner, a **user-configured** "dp remote MCP" source kind, since we cannot ship a URL we do not know.
2. `materializeBuiltinDpMcpServers` (`:260-293`) emits `{ type: 'stdio', command: dpPath, args: ['ai','mcp','remote','--url', url], env: runtimeEnv }`. Note this stays a **stdio** config from the pool's point of view — dp is the HTTP client, we are not. That is what keeps it inside our existing transport union with zero pool changes.
3. `dpAiMcpSubcommandOf` (`:304-310`) must change: it matches the argv tail `[..., 'ai','mcp','<sub>']` and a `remote --url X` server ends in `X`, so today it returns the URL as the "subcommand". Fix before shipping — otherwise the dedup in `mergeBuiltinDpMcpServers` (`:336-340`) treats two different remote URLs as the same server, or collides a URL with a real subcommand name.
4. Settings surface: `BuiltinDpMcpServerViewV1.subcommand` (`builtin-dp-mcp-preferences.ts:47-57`) needs a URL-bearing variant, and the write-side name validation (`isKnownBuiltinDpMcpServer`, `:84-86`) has to admit user-defined remote entries — which argues for keeping them out of the *builtin* set entirely and modelling them as a source/plugin kind instead.

Contracts to honour: no credential ever enters the config (`:17-20`); never execute dp to resolve availability (`:13-16`); URL must go through `url-consent.ts` / the network address guard the pool already applies to `ws` targets (`mcp-pool.ts:36-42`).

Risks: **the URLs are unknown and unpublished** — that is exactly why we excluded `whiteboard`/`meetings` (`builtin-dp-servers.ts:155-162`). Shipping a guessed URL fabricates a contract. This is blocked on a real endpoint list from the dp/Spirit owners, and until then it should stay a user-entered field, not a builtin. Second risk: a `remote` proxy's failure mode is a network failure wearing a subprocess costume — a hung TCP connect surfaces as a stdio server that connects but never lists tools, which our current diagnostics would report as a generic connect failure.

### B. HTTP/SSE pool-sharing gate (port F2 §5.2)

nessy-cli's stated reason is concrete and applies to us verbatim: some MCP HTTP servers bind auth context or conversation memory to the request stream, and our pool shares a single connection between every session **and** the browse pool in a workspace — a strictly wider blast radius than F2's session-only sharing.

- Component: a `pooledTransports`-equivalent predicate consulted in `McpClientPool.connect`, with non-poolable configs getting a per-leaser connection instead of a shared one. Keying already supports it — append the leaser id to `mcpConnectionKey` (`mcp-pool.ts:196-199`) for the unpooled case, exactly as F2's `createUnpooledConnection` does.
- Contract change: `activeLeasersForConnection` (`:1101-1106`) and the elicitation attribution logic (`:926-960`) assume one connection may have several leasers; an unpooled connection makes attribution trivially exact, so this *simplifies* that path.
- Risk: connection count multiplies for HTTP sources in multi-session workspaces. F2 handles that with a workspace budget; we have none, so measure before defaulting HTTP to unpooled.

### C. Descendant-pid sweep (port F2 §6.4)

Our `ProcessSupervisorPort` covers the direct child. It does not cover `npx`/`uvx`/`pnpm dlx` grandchildren, which is precisely the leak opencode hit and F2 ported a fix for (`f2-mcp-transport-pool.md:463-513`). We *do* run npx-launched plugin MCP servers (`packages/shared/src/plugins/stdio-command.ts` — `pluginNpxRuntimeRoot`, `parsePluginPackageRunnerArgs`), so the exposure is real.

- Component: a `listDescendantPids(rootPid)` helper called from the supervisor's stop path, using the snapshot form (`ps -A -o pid=,ppid=`, single fork) with the caps F2 settled on (256 descendants, depth 8, 2s timeout, 8MB buffer).
- Risk, and it is our own recorded one: `AGENTS.md` — "Electron does not inherit the shell's `ulimit -n` (floor 256 here): fd-hungry paths fail in the app while every shell probe succeeds." A `ps` fork per pool teardown is cheap, but validate on a **packaged** build, not `electron:dev`, since the main process runs from built bundles.

### Sequencing

C first (self-contained, no contract change, closes a real leak). B second (needs a measurement, then a default). A last, and **only after the endpoint list exists** — otherwise it repeats the exact mistake `BUILTIN_DP_MCP_EXCLUSIONS` was written to prevent.

### What is explicitly not worth porting

`McpTransportPool` itself. Our `McpClientPool` + `WorkspaceMcpPoolRegistry` already deliver F2's goals (fingerprint keying, refcount, drain, cross-session sharing) through a leaser union that is broader than F2's session-only refcount, and 2817 lines of it are ahead of the openwork copy nessy-cli vendored. F2 is worth reading for its **three hardening mechanisms** above and for `canonicalOAuth`'s credential-leak correction (`mcp-pool-key.ts:64-72`) — worth auditing our `stableJson(config)` hash against, since ours hashes the whole config object and should therefore already be safe, but that is an assertion worth a test rather than an assumption.
# Appendix D — Task D: user 401 diagnosis (full report)

# TASK D — Auth failure diagnosis, nessy-desktop @ HEAD (`feat/TCODE-000`, v1.32.0)

*(Line numbers are from the working tree. `packages/server-core/src/sessions/SessionManager.ts` is dirty vs. HEAD per `git status`; the auth-relevant regions cited below are unmodified — `git diff bbd48f967 HEAD` for the dp/auth files is empty, see §2.)*

---

## 1. The 1.30.1 fixes ARE present at HEAD — all five, verbatim

| Fix | File:line | Evidence |
|---|---|---|
| JWT shape predicate | `packages/shared/src/auth/dp/jwt.ts:15-18` | `isJwtShaped` = exactly 3 non-empty dot-separated parts. Its docstring names this exact bug: *"an unfixable 401 'token contains an invalid number of segments' loop"* (`jwt.ts:12-13`) |
| Reader 1 — shared warm path | `packages/shared/src/auth/dp/creds-store.ts:63-67` | `getValidCreds` now returns `isJwtShaped(creds.jwt) ? creds : null` — no longer `expiresAt`-only |
| Reader 2 — adapter | `packages/codex-responses-adapter/src/nestor-auth.ts:18-21, 24-31` | local copy of `isJwtShaped` (cycle-avoidance comment at `:16-17`); `readNestorJwt` returns `null` for a non-JWT |
| Reader 3 — electron prefill/IPC | `apps/electron/src/main/handlers/nessy-auth.ts:31-41` | `readNessyGatewayJwt` guarded by `isJwtShaped` |
| `forceRefresh` (re-mint, not replay) | `packages/shared/src/auth/dp/index.ts:61-69` (contract), `:148` (`if (!forceRefresh)` gates BOTH the warm cache `:149` and the nessy-cli seed `:162`) | Comment at `:63-66`: *"the cached JWT was just REJECTED — returning it again loops forever"* |
| 401 → forced re-mint | `SessionManager.ts:9798-9812`, call at `:21079` | `gatewayBacked` covers `claude-runtime` \| `pi_compat` \| `codex-runtime` at the gateway base URL (`:9802-9807`); then `ensureNessyGatewayAuthForRetry({ interactive: false, forceRefresh: true })` (`:9808`) |
| Sign-in → forced re-mint + seed fallback | `apps/electron/src/main/handlers/nessy-auth.ts:90-113` | forced first (`:93`), then ONE non-forced non-interactive fallback (`:97-102`); cancellation never masked (`:95`, `:110`) |
| read-only nessy-cli seed | `packages/shared/src/auth/dp/creds-store.ts:117-131` | `readCliOauthJwt` — rejects `resource_url` (qwen device-flow), non-JWT, expired, claim-less; never writes |
| Gateway-aware 401 wording | `packages/shared/src/agent/claude-sdk-error-mapper.ts:312-333` | the exact banner string at `:320` |
| dp under `DP_NO_WARNINGS` | `packages/shared/src/auth/dp/dp-api.ts` (T4, commit `854ebdbe5`) | tracker row in `docs/superpowers/plans/2026-08-18-dp-auth-resilience.md` |

The plan's own research base states the pre-fix root cause with citations, at `docs/superpowers/plans/2026-08-18-dp-auth-resilience.md:12-14`:
> "Garbage + future `expiresAt` passes `getValidCreds`, so `ensureNessyGatewayAuth` warm-path returns 'done' without ever consulting dp — the state never self-heals, auth-retry loops on the same 401."

---

## 2. Which versions contain them

- **Landed in `1.30.1`.** `git show bbd48f967:package.json` → `1.30.1`; that commit adds `apps/electron/resources/release-notes/1.30.1.md` (19 lines, all five fixes described at `1.30.1.md:11-19`).
- **`bbd48f967` ("Fix/auth", 2026-08-20 09:08 +0000) is an ancestor of HEAD** (`git merge-base --is-ancestor bbd48f967 HEAD` → true) **and is the parent of `origin/master`'s tip**.
- **HEAD's auth files are byte-identical to the fix commit**: `git diff --stat bbd48f967 HEAD -- packages/shared/src/auth/dp apps/electron/src/main/handlers/nessy-auth.ts packages/codex-responses-adapter/src/nestor-auth.ts` → empty.
- All 12 `origin/fix/auth` commits (incl. the last one, `bf8b28ebc` "the gateway seed reaches every gateway card, and Sign in falls back to it") are folded into the squash: `git show bbd48f967:apps/electron/src/main/handlers/nessy-auth.ts | grep -c runForcedThenFallback` → 2.
- **Versions containing the fix: 1.30.1, 1.31.0, 1.32.0.** Verified on the released tree: `git show 0a4a5d8b8:packages/shared/src/auth/dp/jwt.ts | grep -c isJwtShaped` → 1; same commit's `nestor-auth.ts` → 2, `nessy-auth.ts` → 2, `SessionManager.ts` `refreshGatewayAuthForRetry` → 4.
- **`package.json` versions**: `origin/master` = **1.31.0** (commit `0a4a5d8b8`, 2026-08-21 21:01 +0000); HEAD (`feat/TCODE-000`) = **1.32.0** (root + `apps/electron` in lockstep). `master` is **not** an ancestor of HEAD (`git merge-base --is-ancestor master HEAD` → false; 166 commits on HEAD since master) — 1.31.0/1.32.0 were built on the branch and 1.31.0 was squash-merged separately.
- **Tags**: `git tag -l` → `pre-final-squash-p25-p26`, `pre-squash-p18-p24`, `v0.13.0`, `v1.16.0`, `v1.17.0`. **No `v1.30.1` / `v1.31.0` / `v1.32.0` tag exists locally.**
- Release-notes files present: `…/release-notes/1.30.1.md`, `1.31.0.md`, `1.32.0.md`.

### Publish state (read-only GET, succeeded)

`scripts/verify-update-feed.mjs` takes the feed base as `--base-url` and `apps/electron/electron-builder.yml:78-80` reads it from `${env.NESSY_DESKTOP_UPDATE_URL}` — no literal in the repo. The literal base **is** in the installers: `scripts/install-app.sh:4` → `https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac`, `scripts/install-app.ps1:9` → `…/dev/win`. Metadata names from `scripts/publish-dev.sh:90,94,98`.

```
GET https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac/dev-mac.yml  → 200
version: 1.31.0
path: NessyDesktop-1.31.0-mac-arm64.zip
releaseDate: '2026-08-21T21:28:21.937Z'
```
`dev-arm64-mac.yml`, `latest-mac.yml`, `latest-arm64-mac.yml` → 403 (absent). `dev/win/{dev,latest}.yml` and `dev/linux/{dev-linux,latest}.yml` → 403 (absent — the bucket denies listing, so 403 ≡ "no such key"). **The published mac dev channel is 1.31.0 and therefore already carries every 1.30.1 fix.** Windows/Linux appear unpublished on this channel, or under names not in `publish-dev.sh`'s list.

---

## 3. Exact source of each screenshot string

| String | Source | Trigger |
|---|---|---|
| `Token expired, refreshing session…` | `packages/server-core/src/sessions/SessionManager.ts:21070` (`sendEvent({type:'info'})` inside `attemptAuthRetry`) | Fired **once per user message** by `attemptAuthRetry` (`:21037`), reached from two places: a typed error with `code === 'invalid_api_key' \| 'expired_oauth_token'` (`:22796-22801`), or a plain error whose text matches `401` + `auth`/`unauthorized` (`:22752-22758`). **Not persisted** — it is a live event, so its presence proves the retry ran in the build the user is running now. `managed.authRetryAttempted` is reset on every new send (`:19216`), which is why it re-appears turn after turn. |
| `Authentication Failed: Your Nessy Gateway sign-in is missing or expired. Open Settings → AI and click Sign in on the gateway card.` | Title + message from `packages/shared/src/agent/claude-sdk-error-mapper.ts:319-320`, rendered as one row by `SessionManager.ts:22808` (`[title, message].join(': ')`); the Settings/Retry buttons are the `actions` array at `claude-sdk-error-mapper.ts:325-328` | SDK error code `authentication_failed`, **only** when `context.providerType === 'claude-runtime'` and the resolved upstream is not BYO (`:312-316`). `providerType` + `claudeRuntimeUpstreamKind` are threaded from `ClaudeAgent` at `packages/shared/src/agent/claude-agent.ts:4965` (`claudeRuntimeUpstreamKind` is set at `:1904` from the adapter's resolved upstream). `mapClaudeSdkAssistantError` has exactly one production call site — inside `ClaudeAgent` — so **this string can only come from a `claude-runtime` connection**, i.e. the **Claude Code (Nessy Gateway)** card. |
| `Failed to authenticate. API Error: 401 {"error":"fail parse token claims: …"}` | **`Failed to authenticate. `** is a string in the Claude Agent SDK CLI binary, not in our source. `rg -a --no-ignore "Failed to authenticate"` over the whole tree hits only `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (and `apps/electron/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude`); `strings` around that offset shows the template `Failed to authenticate. ` / `Please run /login `. The Pi bundle does **not** contain it (`grep -c` on the 27 MB `packages/pi-agent-server/dist/index.js` → 0 for both `Failed to authenticate` and `API Error`). The JSON is the **gateway's own body**, relayed: `packages/codex-responses-adapter/src/server.ts:557-563` passes the upstream status through and embeds `text.slice(0,500)`. | The `claude-runtime` session's loopback adapter posted to the gateway with a `Nestor-Token` the gateway could not parse. Our own recorded run shows the identical rendering shape for the 403 twin: `docs/testing/cdp-runs/2026-08-21-t23-lane-g.md:256` — `Failed to authenticate. API Error: 403 {"error":"failed to detect critical data…"}`, followed at `:280` by the very same "Your Nessy Gateway sign-in is missing or expired" row. **The user's screenshot pair is structurally that pair.** |

### The "Nessy Backend (API Key)" card *is* dp-JWT-backed — there is no API key

This is the part that makes the gateway error legitimate on a card labelled "API Key":

1. The one-click **Pi** gateway card is built by `apps/electron/src/renderer/components/apisetup/gateway-one-click.ts:98-111`, which passes **`credential: jwt`** — the dp JWT read through `readNessyGatewayJwt` — into the `pi_api_key` setup path. (The Codex/Claude arms do the same at `:67`.)
2. `packages/server-core/src/handlers/rpc/llm-connections.ts:302` stores that credential with `manager.setLlmApiKey(setup.slug, setup.credential)`. **The connection's "API key" is a snapshot of the JWT.**
3. Because the payload carries `customEndpoint`, the handler forces `updates.providerType = 'pi_compat'` (`llm-connections.ts:119-124`) and **skips** the `Nessy Backend (<Provider>)` rename (`:160-167` is gated on `!isCustomEndpointCompat`), so the name stays the template default **`Nessy Backend (API Key)`** (`packages/server-core/src/domain/connection-setup-logic.ts:209-214`). That is exactly the screenshot: name "Nessy Backend (API Key)", type *compatible*, host `code-completion-nestor.tcsbank.ru`.
4. At runtime the Pi backend prefers the **live** creds file over the stored key: `packages/shared/src/agent/pi-agent.ts:264-271` (`resolveNestorGatewayJwtForPi` → `getValidCreds`) is consulted first at `:2326-2332`, and only falls through to `credentialManager.getLlmApiKey(slug)` at `:2335-2341`. Whatever value wins is sent as `Authorization: Bearer …` and rewritten to `Nestor-Token` by `packages/shared/src/unified-network-interceptor.ts:627-636`.

So both of the user's connections authenticate with the same dp JWT from `~/.nessy/dp_auth_creds.json`. A "Nessy Gateway sign-in" error on a machine whose default connection is the API-key card is not a mismatch — it is the same credential, and the message came from the *other* card (`claude-gateway`), which is the one whose session was running.

---

## 4. Which build the user most likely runs

**Most likely: 1.31.0 (the published mac dev build), possibly 1.30.1. Not pre-1.30.1.**

Evidence, in order of strength:

1. **The banner string did not exist before 1.30.1.** `git log --all -S"Your Nessy Gateway sign-in is missing or expired" -- packages/shared/src/agent/claude-sdk-error-mapper.ts` returns exactly `bbd48f967` and `a9fc5cdf0`; `git show 764ee8662:…/claude-sdk-error-mapper.ts | grep -c` (pre-fix master) → **0**. A pre-1.30.1 build shows *"Unable to authenticate. Your API key may be invalid or expired."* (`claude-sdk-error-mapper.ts:337`). The user is not seeing that.
2. **The "Token expired, refreshing session…" line is transient, not persisted** (`SessionManager.ts:21065-21071` calls `sendEvent` only — no `appendManagedMessage`). Its presence means the retry path is running **now**, in the installed build.
3. **The published mac feed is 1.31.0** (§2), and 1.31.0 is what an auto-updating install lands on.

**Does the retry loop in the screenshot match pre- or post-1.30.1 behaviour?** It is the **post-1.30.1** shape, with the re-mint failing silently:

- Pre-1.30.1, `attemptAuthRetry` had no step 0 — `refreshGatewayAuthForRetry` simply did not exist (`git show 764ee8662:…/SessionManager.ts | grep -c refreshGatewayAuthForRetry` → 0). The retry disposed the agent and resent; the new agent re-read the same garbage creds and got the same 401. Classic replay loop.
- Post-1.30.1 the retry re-mints first (`:21079`), **but non-interactively** (`interactive: false`, `SessionManager.ts:9808`) and wrapped in a swallowing `catch` (`:9809-9811`, *"best-effort — the retry itself reports the real failure"*). **If `dp` itself cannot mint — signed out, missing, or below `DP_MIN_VERSION = '13.0.0'` (`packages/shared/src/auth/dp/dp-binary.ts:25`) — the re-mint fails silently, the creds file is left untouched, and the turn fails again.** The user then gets the honest banner instead of the old misleading API-key advice. That is precisely the observed sequence: info line → failure → banner, repeating once per message because `authRetryAttempted` resets per send (`:19216`).

**Would 1.30.1+ self-heal?** Yes, but only if `dp` can mint. With a non-JWT in the creds file and a healthy `dp`, `getValidCreds` returns `null` → the forced ensure runs the dp exchange → `saveCreds` overwrites the garbage → the retry succeeds. With a broken `dp`, the shape guards convert an *unfixable* loop into an *actionable* one: the `claude-runtime` adapter now refuses the bad token locally (`packages/codex-responses-adapter/src/server.ts:122-126`, `:131-134`, `:481-486`, message `NO_CREDENTIALS` at `:111`) and never reaches the gateway at all.

**One consequence worth stating plainly:** on a ≥1.30.1 build the `claude-runtime` gateway path can no longer produce the *gateway's* `fail parse token claims` body — a bad creds file is stopped at the local adapter, whose body is a nested `{"error":{"message":"Nessy Gateway credentials not found (~/.nessy/dp_auth_creds.json)"…}}`. So the raw-gateway-401 rows in the screenshot are almost certainly **persisted history** from the pre-update failures (error rows *are* appended and persisted — `SessionManager.ts:22806-22815`), scrolled above the current banner. If the user reports those rows are *newly appearing after the update*, that changes the diagnosis to the residual Pi hole in §7.1 and should be checked with the discriminator in §6.

---

## 5. Root-cause chain (each link with evidence)

1. **A non-JWT value lands in `~/.nessy/dp_auth_creds.json`.** The file is shared with nessy-cli and Nessy Desktop is only one of its readers; `creds-store.ts:4-7` records that its shape is nessy-cli's contract. Our writer cannot produce garbage (`saveCreds` is gated by `decodeJwtClaims`, `index.ts:207-216`), so the source is external — an interrupted login, a hand edit, or an opaque Ory token written by another tool (`dp print-token` yields an Ory opaque token per prior measurement).
2. **Pre-1.30.1, every reader forwarded it verbatim.** `getValidCreds` checked only `expiresAt`; `readNestorJwt` checked only `typeof === 'string'`; `readNessyGatewayJwt` likewise — all three named with line numbers in `docs/superpowers/plans/2026-08-18-dp-auth-resilience.md:12`.
3. **It reached the wire as `Nestor-Token`.** `packages/codex-responses-adapter/src/nestor-client.ts:80-86` — `headers: { …, 'Nestor-Token': jwt ?? '' }`. (On the Pi path the equivalent is `unified-network-interceptor.ts:627-636`, which converts the Bearer into `Nestor-Token`.)
4. **The gateway rejected it with a parse error, not an expiry error.** `token contains an invalid number of segments` is the JWT library's "not 3 dot-separated parts" message — the token was never a JWT.
5. **The adapter relayed the gateway's body upward** (`server.ts:557-563`), the Claude SDK CLI prefixed it with its own `Failed to authenticate. ` template, and `SessionManager` wrote it as an error row (`:22760-22770`).
6. **The warm path guaranteed the loop.** `ensureNessyGatewayAuth` returned the cached garbage as "done" and never consulted `dp`; the auth-retry then destroyed the agent and replayed the identical token. Nothing in the loop could ever change the credential — the plan calls it "unfixable" (`…dp-auth-resilience.md:5`).
7. **1.30.1 broke the loop at three points** (shape guards, `forceRefresh` on 401 and on Sign in, nessy-cli seed) and **made the failure honest** (the gateway-aware error card). What 1.30.1 deliberately does **not** do is repair a broken `dp`: the 401-path re-mint is `interactive: false` and best-effort (`SessionManager.ts:9808-9811`), so a signed-out/outdated `dp` still ends in a failed turn — now with a banner pointing at the one control that can fix it.

---

## 6. Exact remediation for the user, now (ordered, minimal)

**Discriminator first (10 seconds, tells you whether steps 2-4 are needed):**

0. Open a fresh session on the **Claude Code (Nessy Gateway)** connection and send one message. If the red row now reads *"…Nessy Gateway credentials not found (~/.nessy/dp_auth_creds.json)"* the install is ≥1.30.1 and the old raw-gateway rows were history. If it still reads *"fail parse token claims…"*, the install is pre-1.30.1 — do step 1 first and re-test.

Then:

1. **Update the app to ≥1.31.0.** Published mac dev build is `NessyDesktop-1.31.0-mac-arm64.dmg` at `https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac/` (feed `dev-mac.yml`, verified 200). Installer helper: `scripts/install-app.sh`.
2. **Settings → AI → the gateway connection's row menu → `Reconnect`** (label `settings.ai.reconnect`, `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx:227-241`; handler `:891-910`). This runs the forced re-mint + seed fallback (`nessy-auth.ts:90-113`). The equivalent from the chat banner is its **Settings** button. This is the whole fix if `dp` is healthy.
3. **If Reconnect fails, check `dp` itself** — the app cannot repair it. From `docs-site/content/reference/config/credentials.md:200-206`:
   ```bash
   dp version                    # must be >= 13.x   (floor: dp-binary.ts:25 DP_MIN_VERSION = '13.0.0')
   dp auth print-token | wc -l   # must print exactly 1
   dp ai mcp jira                # must stay running (Ctrl-C), not error out
   ```
   Update `dp` if any of those is off, then repeat step 2.
4. **Last resort, done by hand:** delete `~/.nessy/dp_auth_creds.json`, then click Reconnect again. Per `credentials.md:208-211`: *"Nessy Desktop never deletes or rewrites that file on its own — clearing it is the one step you do by hand."* Note the app will also silently adopt a valid token from nessy-cli's `~/.nessy/oauth_creds.json` if one is there (`creds-store.ts:117-131`), so a working `nessy-cli` login is itself a repair path.
5. **Only if the Pi card ("Nessy Backend (API Key)") is still failing after 2-4 succeeded:** delete that connection and re-add it from the gateway card. Reconnect deliberately does *not* re-create the connection (`AiSettingsPage.tsx:896` — *"no navigation, no re-creation"*), so the stale stored credential from the original sign-in is never overwritten; re-adding it runs `createGatewayConnection` (`gateway-one-click.ts:119-142`) which re-stores a fresh, shape-validated JWT.

**Not required:** re-entering an API key. Neither card has one.

---

## 7. What remains on our side

### 7.1 Two real code gaps still live at HEAD (the 1.30.1 sweep missed both readers)

The plan's stated goal was "JWT shape validation in **every** gateway-creds reader". Two paths read a **stored connection credential** rather than the creds file, and neither is shape-checked nor refreshed by any re-mint:

- **`packages/shared/src/agent/pi-agent.ts:2335-2341`** — when `getValidCreds()` returns `null` (i.e. exactly the "creds are broken/expired" case the 1.30.1 guard creates), the Pi gateway card falls back to `credentialManager.getLlmApiKey(slug)`, which for the one-click card is the **JWT snapshot taken at sign-in time** (`gateway-one-click.ts:100-108` → `llm-connections.ts:302`). If that snapshot predates 1.30.1 it can itself be the opaque garbage — and it goes to the gateway unchecked. This is the pre-1.30.1 loop surviving, narrowed to the Pi card. It should either be `isJwtShaped`-guarded (fail closed → honest sign-in prompt) or refreshed by `refreshGatewayAuthForRetry`.
- **`packages/server-core/src/model-fetchers/nestor.ts:46`** — `headers: { 'Nestor-Token': credentials.apiKey ?? '' }`, from `this.getCredentials(slug)` (`model-fetchers/index.ts:219-220`), i.e. the stored key again, never the live creds. A stale stored key means the gateway model refresh 401s forever (warn-only, `index.ts:224-228`), so a user's model catalog quietly stops updating. Note also the `?? ''` — an empty `Nestor-Token` reproduces the same "invalid number of segments" 401.

Per the owner rule in `AGENTS.md` ("findings become plan rows"), these belong as rows in the active plan.

### 7.2 Publish / backport status

- **Nothing to backport.** The fix is on `origin/master` (1.31.0) and on `feat/TCODE-000` (1.32.0), byte-identical to the fix commit.
- **The mac dev channel is already serving 1.31.0** (feed verified 200, `releaseDate: 2026-08-21T21:28:21.937Z`). No publish action is needed to get the fix to mac users — only getting them to update.
- **Windows and Linux appear unpublished on the dev channel**: every metadata name `scripts/publish-dev.sh:94,98` knows about returned 403 under `/dev/win/` and `/dev/linux/`. If the affected user is on Windows, **they have no published build carrying the fix** and that is the blocking item. Worth confirming their platform before anything else.
- **No release tags exist** for 1.30.1 / 1.31.0 / 1.32.0 (`git tag -l`). Per `MEMORY.md`, tagging/MR/publish are user-owned steps.
- **1.32.0 is unmerged and unpublished** — 166 commits ahead of `master`, on `feat/TCODE-000`. It adds nothing to this failure class beyond 1.31.0.
# Appendix E — Adversarial verification of Task D (full report)

# Adversarial verification — TASK D auth diagnosis

Verified independently against `/Users/i.i.gavrikov/Desktop/work/nessy-desktop` (HEAD `a3e8c7a52`, v1.32.0) and `/Users/i.i.gavrikov/Desktop/work/nessy-cli` (master). I re-derived every fact rather than re-reading the report's citations. Note the tree has advanced 2 commits since the report was written (`576b89f39`, `a3e8c7a52`), and `pi-agent.ts` is now dirty for unrelated quota work, so some line numbers drift by 1–5.

---

## §1 — The five 1.30.1 fixes are present at HEAD

**C1. `isJwtShaped` = exactly 3 non-empty dot-separated parts, docstring names this bug.** **CONFIRMED.** `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/auth/dp/jwt.ts:15-18`; docstring at `jwt.ts:11-13` reads "instead of being sent upstream, where it produces an unfixable 401 'token contains an invalid number of segments' loop".

**C2. `getValidCreds` is shape-guarded, not `expiresAt`-only.** **CONFIRMED.** `packages/shared/src/auth/dp/creds-store.ts:63-67` — `return isJwtShaped(creds.jwt) ? creds : null`.

**C3. Adapter reader guarded with a local copy (cycle avoidance).** **CONFIRMED.** `packages/codex-responses-adapter/src/nestor-auth.ts:18-21` (local `isJwtShaped`), `:16-17` cycle comment, `:27` `typeof raw.jwt === 'string' && isJwtShaped(raw.jwt) ? raw.jwt : null`.

**C4. Electron prefill/IPC reader guarded.** **CONFIRMED.** `apps/electron/src/main/handlers/nessy-auth.ts:31-41`, guard at `:35`.

**C5. `forceRefresh` gates BOTH the warm cache and the nessy-cli seed.** **CONFIRMED, exact.** `packages/shared/src/auth/dp/index.ts:148` (`if (!forceRefresh) {`) encloses the warm path at `:149-154` and the seed at `:162-176`; contract comment at `:61-69` including "the cached JWT was just REJECTED — returning it again loops forever".

**C6. 401 → forced non-interactive re-mint; `gatewayBacked` covers all three cards.** **CONFIRMED.** `packages/server-core/src/sessions/SessionManager.ts:9798-9812`; the three provider types at `:9803-9805`; base-url test at `:9806` is `(!connection.baseUrl || isNessyGatewayBaseUrl(connection.baseUrl))`; the forced call at `:9808`; swallowing catch at `:9809-9811`. Called from `attemptAuthRetry` at `:21079`.

**C7. Sign-in = forced first, then ONE non-forced non-interactive fallback; cancellation never masked.** **CONFIRMED.** `apps/electron/src/main/handlers/nessy-auth.ts:90-113`; forced at `:93`, fallback at `:97-102`, cancel guards at `:95` and `:110`.

**C8. `readCliOauthJwt` is read-only and rejects `resource_url` / non-JWT / expired / claim-less.** **CONFIRMED.** `creds-store.ts:117-131` — `resource_url` at `:120`, `isJwtShaped` at `:122`, expiry at `:124`, `decodeJwtClaims(jwt).username` at `:126`. No write in the function.

**C9. Gateway-aware 401 wording exists at the cited line.** **CONFIRMED.** `packages/shared/src/agent/claude-sdk-error-mapper.ts:320`.

**C10. `DP_NO_WARNINGS` / `DP_MIN_VERSION = '13.0.0'`.** **CONFIRMED.** `packages/shared/src/auth/dp/dp-api.ts:42` and `:88`; `dp-runtime.ts:63`; `packages/shared/src/auth/dp/dp-binary.ts:25`.

---

## §2 — Versions and publish state

**C11. `bbd48f967` is v1.30.1, is an ancestor of HEAD, and HEAD's auth files are byte-identical to it.** **CONFIRMED.** `git show bbd48f967:package.json` → `"version": "1.30.1"`; `git merge-base --is-ancestor bbd48f967 HEAD` → true; `git diff --stat bbd48f967 HEAD -- packages/shared/src/auth/dp apps/electron/src/main/handlers/nessy-auth.ts packages/codex-responses-adapter/src/nestor-auth.ts` → empty. `bbd48f967` adds `apps/electron/resources/release-notes/1.30.1.md` (19 insertions).

**C12. 1.31.0 (`0a4a5d8b8`, = `origin/master` = local `master`) carries every fix.** **CONFIRMED.** `git show 0a4a5d8b8:…/jwt.ts | grep -c isJwtShaped` → 1; `nestor-auth.ts` → 2; `nessy-auth.ts` → 2; `SessionManager.ts | grep -c refreshGatewayAuthForRetry` → 4.

**C13. `master` is not an ancestor of HEAD; ~166 commits ahead; no 1.30.1/1.31.0/1.32.0 tags.** **CONFIRMED with drift.** `git merge-base --is-ancestor master HEAD` → false; `git rev-list --count master..HEAD` → **168** (was 166 at report time; two commits landed since). `git tag -l` → `pre-final-squash-p25-p26`, `pre-squash-p18-p24`, `v0.13.0`, `v1.16.0`, `v1.17.0` — no release tags. Release notes `1.30.0.md`, `1.30.1.md`, `1.31.0.md`, `1.32.0.md` all present.

**C14. Published mac dev channel is 1.31.0; win/linux 403.** **CONFIRMED by my own GETs.** `https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac/dev-mac.yml` → **200**, `version: 1.31.0`, `files[0].url: NessyDesktop-1.31.0-mac-arm64.zip`, sha512 `G5rlcTzIdYb0…`, size 356672453. `dev/mac/latest-mac.yml`, `dev/win/dev.yml`, `dev/linux/dev-linux.yml` → **403 AccessDenied** (bucket denies listing). Base URLs match `scripts/install-app.sh:4` and `scripts/install-app.ps1:9`; `apps/electron/electron-builder.yml:79` is `${env.NESSY_DESKTOP_UPDATE_URL}` with no literal. Metadata names at `scripts/publish-dev.sh:90,94,98`.
*Caveat the report should have stated:* 403-on-a-private-listing is consistent with "absent" but does not **prove** absence — a present-but-non-public key returns the same code. The inference is sound, not proven.

**C15. The `.dmg` named in remediation step 1 actually exists.** **CONFIRMED** (report did not verify this; I did). `curl -r 0-0 …/dev/mac/NessyDesktop-1.31.0-mac-arm64.dmg` → **206 Partial Content**. Filename matches the pattern built at `scripts/install-app.sh:52`.

---

## §3 — Provenance of the three screenshot strings

**C16. `Token expired, refreshing session…` is a transient `info` event, once per user message.** **CONFIRMED.** `SessionManager.ts:21067-21072` — `this.sendEvent({ type: 'info', … message: 'Token expired, refreshing session…' })`, with **no** `appendManagedMessage` anywhere in that block, so it is not persisted. Guard `if (managed.authRetryAttempted || …) return false` at `:21046`; flag set at `:21063`; reset per send at `:19216` (`managed.authRetryAttempted = false`, inside `if (!_isAuthRetry)`). Two reach-points: plain-text match at `:22751-22756` → `attemptAuthRetry` at `:22758`; typed codes `invalid_api_key | expired_oauth_token` at `:22796-22797` → `attemptAuthRetry` at `:22799`. The report's reasoning that its presence proves the retry runs in the *installed* build is sound.

**C17. The gateway banner can only come from a `claude-runtime` connection (the Claude Code (Nessy Gateway) card).** **CONFIRMED — and I found stronger evidence than the report used.**
- The string exists in exactly one source file: `claude-sdk-error-mapper.ts:320` (the other hits are docs/plans/release-notes).
- `mapClaudeSdkAssistantError` has exactly one production call site: `packages/shared/src/agent/claude-agent.ts:4961` (all other hits are its own definition at `claude-sdk-error-mapper.ts:218` and `__tests__/claude-sdk-error-mapper.test.ts`). `providerType`/`claudeRuntimeUpstreamKind` threaded at `:4963-4965`; kind assigned at `:1904`.
- **Independent corroboration the report missed:** the Pi card *cannot* emit it. A Pi 401 is classified by `packages/shared/src/agent/errors.ts:420` (`'401' || 'unauthorized' || …`) and, because the gateway's body contains "token", falls to `code = 'expired_oauth_token'` at `:422`; the user-facing wording comes from `pi-agent.ts:8699-8702` ("Invalid API Key / Your API key was rejected. Check your credentials in Settings.") or the `errors.ts:64` catalog — never from the Claude mapper. So the two cards produce visibly different banners, and the screenshot's banner is the Claude one.

**C17a. Precision correction on the gate condition.** The report says "only when `providerType === 'claude-runtime'` and the resolved upstream is not BYO". The literal condition at `claude-sdk-error-mapper.ts:312-316` is `providerType === 'claude-runtime' && claudeRuntimeUpstreamKind !== 'openai-compatible' && !== 'anthropic-messages'` — an **unresolved/undefined** kind also gets the gateway wording, which the in-file comment at `:310-311` states deliberately. Practically equivalent; worth stating exactly, because "unresolved" is a third state, not a synonym for gateway.

**C18. `Failed to authenticate. ` is the Claude Agent SDK CLI's own template, absent from the Pi bundle.** **CONFIRMED by direct binary grep.** `grep -ac "Failed to authenticate"` → **8** on `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` and **8** on `apps/electron/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude` (both 272,553,824 bytes); `"API Error"` → **9** on each. `packages/pi-agent-server/dist/index.js` (27 MB) → **0** for both strings. (A tree-wide `grep -arl` under-reported these; the per-file grep is the reliable measurement — an instance of the AGENTS.md "absence claim needs `grep -a`" trap.)

**C19. The gateway's raw JSON body is relayed upward by `server.ts:557-563`, making the screenshot pair "structurally" the recorded `cdp-runs` pair.** **REFUTED as stated — the mechanism named does not produce a verbatim body.**
On the gateway (`kind: 'nestor'`) the `/v1/messages` route runs the **chat-completions translation** path, whose upstream-error relay is `packages/codex-responses-adapter/src/server.ts:563`:
```
sendJson(res, status, anthropicErrorBody(status, `upstream error ${upstream.status}: ${text.slice(0, 500)}`));
```
and `anthropicErrorBody` (`packages/codex-responses-adapter/src/anthropic/outbound.ts:51-53`) returns `{ type: "error", error: { type, message } }`. So the SDK would render an **Anthropic envelope containing the literal prefix `upstream error 401: `**, not `API Error: 401 {"error":"fail parse token claims: …"}`.
The recorded twin the report leans on — `docs/testing/cdp-runs/2026-08-21-t23-lane-g.md:250-258` — is `claude-custom-2`, a **BYO connection on `llm-proxy.t-tech.team` using the `anthropic-messages` PASSTHROUGH**, where "the inbound body goes up untranslated and the upstream's own response comes straight back" (`server.ts:56-58`). That is why *that* body appears verbatim. It is a different route from the gateway, so it is not evidence for the gateway's rendering shape.
**Consequence:** if the user's screenshot really shows an unwrapped `{"error":"fail parse token claims…"}` with no `upstream error 401:` prefix, that body did **not** come through the claude-runtime gateway adapter — which reopens the question of which surface produced it. This is the single weakest link in the report and it is load-bearing for §4's "those rows are persisted history" conclusion.

**C20. The "Nessy Backend (API Key)" card is dp-JWT-backed and has no API key.** **CONFIRMED, every link.**
- `apps/electron/src/renderer/components/apisetup/gateway-one-click.ts:98-111` passes `credential: jwt` into `apiSetupMethodToConnectionSetup('pi_api_key', …)`; Codex/Claude arms do the same at `:67`.
- `packages/server-core/src/handlers/rpc/llm-connections.ts:302` — `await manager.setLlmApiKey(setup.slug, setup.credential)`. Exact line as cited.
- `customEndpoint` forces `updates.providerType = 'pi_compat'` at `llm-connections.ts:123` (`isCustomEndpointCompat` set at `:120`), and the `Nessy Backend (<Provider>)` rename at `:162-168` is gated on `!isCustomEndpointCompat`, so the name stays the template default `'Nessy Backend (API Key)'` from `packages/server-core/src/domain/connection-setup-logic.ts:209-213`. Matches the screenshot exactly.
- Runtime preference: `packages/shared/src/agent/pi-agent.ts:2329-2336` consults `this.getNestorGatewayJwt()` (→ `:2357-2359` → `resolveNestorGatewayJwtForPi`, `:265-273`, default reader `getValidCreds` at `:267`) **before** `credentialManager.getLlmApiKey(slug)` at `:2339-2345`. Bearer→`Nestor-Token` rewrite at `packages/shared/src/unified-network-interceptor.ts:627-636`.

---

## §4 — Which build the user runs

**C21. The banner string did not exist before 1.30.1.** **CONFIRMED.** `git log --all -S"Your Nessy Gateway sign-in is missing or expired" -- …/claude-sdk-error-mapper.ts` → exactly `bbd48f967` and `a9fc5cdf0`. `git show 764ee8662:…/claude-sdk-error-mapper.ts | grep -c "Nessy Gateway sign-in"` → **0**, and `grep -c "Unable to authenticate. Your API key may be invalid or expired."` → **1**. `764ee8662` is `package.json` version **1.30.0** — a genuine pre-fix point.

**C22. Pre-1.30.1 `attemptAuthRetry` had no re-mint step.** **CONFIRMED.** `git show 764ee8662:…/SessionManager.ts | grep -c refreshGatewayAuthForRetry` → **0**.

**C23. On ≥1.30.1 the claude-runtime gateway path can no longer send a non-JWT to the gateway — a bad creds file is stopped at the local adapter.** **CONFIRMED, and I closed the injection hole the report never checked.**
The adapter gate is `resolveGatewayJwt` (`server.ts:122-126`): `const gatewayJwt = opts.jwt !== undefined ? opts.jwt : readNestorJwt();` — an injected `opts.jwt` would **bypass** the shape guard. I traced every production caller: `claude-agent.ts:1910` calls `startAdapter({ upstream, ...(upstreamForModel ? { upstreamForModel } : {}) })` and `codex-agent.ts:509-516` calls `startAdapter({ upstream, onUpstreamAuth })` — **neither passes `jwt`**, so `readNestorJwt()` (shape-guarded, C3) is authoritative on both runtimes. `AdapterOptions.jwt` is documented as "tests / non-default creds" at `server.ts:36-40`. Gate refusals at `server.ts:131-134` (`/responses`) and `:481-486` (`/v1/messages`), message `NO_CREDENTIALS` at `:111`.
Also confirmed: gateway mode never reads the stored connection credential — `packages/shared/src/agent/backend/internal/drivers/upstream-target.ts:43-47` ("The gateway mode never reads it… and this path must not acquire a second reader of that file"), and `attachUpstreamCredential` returns early for non-`openai-compatible` targets at `:68`. And `resolveGatewayJwt` runs **per request**, so a successful re-mint is picked up without an agent restart.

**C24. "Would 1.30.1+ self-heal? Yes, but only if `dp` can mint."** **CONFIRMED but INCOMPLETE — there is a second failure mode the report missed.** See N1 below.

---

## §5 — Root-cause chain

**C25. Our writer cannot produce garbage; the source is external.** **CONFIRMED, and I can now name the mechanism the report only speculated about.** `saveCreds` is reached only after `decodeJwtClaims` succeeds (`packages/shared/src/auth/dp/index.ts:207-216`; seed path likewise at `:165-169`), and `saveCreds` itself is atomic tmp+rename at 0600 (`creds-store.ts:93-96`).
On the nessy-cli side: `packages/core/src/dp/dpTokenManager.ts:46-58` (`saveCredentials`) **still writes `~/.nessy/dp_auth_creds.json` with a bare non-atomic `fs.writeFileSync` onto the real path** (`:56`), as does `saveDpModelsCache` at `:73-77`. But on current master **neither has a production caller** — the only references are the re-exports at `packages/core/src/dp/index.ts:24,29` — because the live login flow deliberately routes elsewhere: `packages/core/src/dp/dpAuthService.ts:69` comments "do NOT save to dp_auth_creds.json - use shared oauth_creds.json instead" and writes `access_token` via `cacheNessyCredentials` at `:82-88`. So *today's* nessy-cli is not a writer; an **older** nessy-cli (or its non-atomic writer racing ours) is the credible external source. This strengthens the report's link 1 rather than refuting it.

**C26. The token reaches the wire as `Nestor-Token`.** **CONFIRMED.** `packages/codex-responses-adapter/src/nestor-client.ts:82-86` — `case 'nestor': return { url: NESTOR_CHAT_URL, headers: { 'content-type': 'application/json', 'Nestor-Token': jwt ?? '' } }`. Pi equivalent at `unified-network-interceptor.ts:627-636`.

**C27. Links 2, 4, 6, 7 (pre-fix readers forwarded verbatim; parse-error not expiry; warm path guaranteed the loop; 1.30.1 broke it at three points without repairing `dp`).** **CONFIRMED** — links 2 and 6 are the inverse of C2/C3/C4/C5 verified above; link 7's "interactive: false and best-effort" is `SessionManager.ts:9808-9811`.

---

## §6 — Remediation

**C28. Reconnect exists on the gateway rows, runs the forced flow, and does not re-create the connection.** **CONFIRMED.** `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx:227-241` (`computeGatewayReconnectItem`; label `'settings.ai.reconnect'` at `:240`; gated on `authType !== 'oauth'` at `:231` and `isNessyGatewayBaseUrl(connection.baseUrl)` at `:232` — so the Pi API-key card **does** get the item); handler at `:891-909`, with `// Clear «Not authenticated» in place — no navigation, no re-creation.` at `:896` and the header comment "the dp flow rewrites the shared credential file and the connection itself is untouched" at `:888-889`.

**C29. The `dp` triage commands are quoted from the docs.** **CONFIRMED.** `docs-site/content/reference/config/credentials.md:200-211`, verbatim: `dp version # must be >= 13.x`, `dp auth print-token | wc -l # must print exactly 1`, `dp ai mcp jira`. The closing sentence at `:209-211` is quoted correctly.
*Minor correction the report propagated:* that doc says Nessy Desktop "never deletes or **rewrites** that file on its own" — the *rewrite* half is wrong in code; `saveCreds` (`creds-store.ts:75-97`) rewrites it (merge-preserving) on every successful mint. Only the *delete* half holds. Harmless for the user instruction, but it is a doc bug worth a row.

**C30. "Not required: re-entering an API key. Neither card has one."** **CONFIRMED** — follows from C20 and C23.

---

## §7 — Residual gaps

**C31. Pi falls back to an unguarded, never-refreshed stored JWT snapshot.** **CONFIRMED — this is a real, live gap and the report states it correctly.** `pi-agent.ts:2329-2336` tries the live shape-guarded creds first; when `getValidCreds()` returns `null` — *which after 1.30.1 includes the "creds file holds garbage" case* — it falls to `credentialManager.getLlmApiKey(slug)` at `:2339-2345` with no `isJwtShaped` check, and that value goes out as `Nestor-Token` via `unified-network-interceptor.ts:627-636`. Nothing refreshes it: `refreshGatewayAuthForRetry` writes only the creds file, and Reconnect explicitly leaves the connection untouched (`AiSettingsPage.tsx:888-889`). **This is the direct answer to "could a post-1.30.1 build still show this loop": yes — on the Pi/API-Key card only, and only from the stored snapshot, never from the creds file.**

**C32. `fetchNestorModels` sends the stored key with a `?? ''` fallback.** **CONFIRMED.** `packages/server-core/src/model-fetchers/nestor.ts:46` — `headers: { 'Nestor-Token': credentials.apiKey ?? '' }`; source is `this.getCredentials(slug)` at `packages/server-core/src/model-fetchers/index.ts:219`; failure is warn-only and returns early at `:224-228`.

**C33. Publish/backport status.** **CONFIRMED** — see C11–C14.

---

## New finding the report missed

**N1. The forced re-mint can be silently downgraded to the warm (garbage) path by the single-flight — a second post-1.30.1 loop mechanism, independent of `dp` health.**
`ensureNessyGatewayAuth` short-circuits on `if (inflight) return inflight` at `packages/shared/src/auth/dp/index.ts:91`, **before** `runEnsure` ever sees `forceRefresh`. So a `forceRefresh: true` caller that arrives while a non-forced ensure is running receives that run's result — the cached, just-rejected token. The module admits this at `index.ts:66-68`: "a forceRefresh caller that joins an already-running warm ensure gets that run's result — acceptable, the retry re-fires."
**The stated mitigation does not hold inside a turn.** `attemptAuthRetry` permits exactly one retry per message (`SessionManager.ts:21046`, flag set at `:21063`, reset only on a new non-retry send at `:19216`), so the retry does *not* re-fire — the turn fails and the honest banner appears. The re-fire only happens on the user's *next* message, which is precisely the once-per-message loop shape the report attributes solely to a broken `dp`. Both `SessionManager.ts:9808` and the Sign-in controller (`nessy-auth.ts:93`) route through this same facade, so both are exposed. Concurrency is plausible (renderer `ensure` IPC at `nessy-auth.ts:222`, launch check at `:173`) though not routine. Worth a plan row: make `forceRefresh` either bypass or invalidate the in-flight join.

**N2. On the seed question specifically ("could the seed pick up a garbage token?") — no, not for this 401.** `readCliOauthJwt` applies `isJwtShaped` at `creds-store.ts:122` before anything is adopted, and `decodeJwtClaims(...).username` at `:126`. A non-JWT (Ory opaque, qwen device token) is rejected at `:120` or `:122`. The seed could in principle adopt a *JWT-shaped but wrong-issuer* token, which would produce a different 401 — never "invalid number of segments".

---

## Net verdict

**The diagnosis is substantially correct and unusually well-evidenced. 30 of 33 checkable claims CONFIRMED, 1 REFUTED, 2 confirmed-with-material-caveats. The two load-bearing conclusions both survive independent attack:**

1. **The gateway sign-in banner comes from the Claude Code (Nessy Gateway) card, not the API-Key card.** Confirmed three ways — single string source (`claude-sdk-error-mapper.ts:320`), single production call site (`claude-agent.ts:4961`), and the Pi card's demonstrably different error wording (`errors.ts:420-422` → `pi-agent.ts:8699-8702`). The report used only the first two; the third is stronger.
2. **The "API Key" card carries no API key — it carries a dp-JWT snapshot.** Every link verified at the exact cited lines, including `llm-connections.ts:302`.

**Corrections to carry forward:**

- **C19 is refuted and matters.** The gateway route wraps upstream bodies (`server.ts:563` + `outbound.ts:51-53`) with a literal `upstream error 401: ` prefix inside an Anthropic envelope. The `cdp-runs` "twin" at `2026-08-21-t23-lane-g.md:250-258` is a BYO **anthropic-messages passthrough**, a structurally different route that returns bodies verbatim. So "the user's screenshot pair is structurally that pair" is not supported. §6's step-0 discriminator is still the right first move, but the operator should also check whether the raw row carries the `upstream error 401:` prefix — **if it does not, the body did not come through the claude-runtime gateway adapter at all**, and §4's "persisted history" conclusion needs revisiting.
- **N1 adds a second post-1.30.1 loop mechanism** the report attributes entirely to a broken `dp`. Its own remediation ordering is unaffected (Reconnect is still step 2), but "Would 1.30.1+ self-heal? Yes, but only if `dp` can mint" should read "…only if `dp` can mint **and** no concurrent warm ensure swallows the forced call".
- **C17a**: the mapper gate is `!== 'openai-compatible' && !== 'anthropic-messages'`, so an *unresolved* upstream kind also gets the gateway wording — three states, not two.
- **C23 needed one more check the report skipped**: `opts.jwt !== undefined` at `server.ts:123` is a real shape-guard bypass seam. It is safe today only because no production caller passes it (`claude-agent.ts:1910`, `codex-agent.ts:509-516`). That is a fact worth pinning with a test, not an accident to rely on.
- **C25 upgrade**: the "external source" is now named — nessy-cli's `dpTokenManager.ts:46-58` / `:65-80` still contain non-atomic full-file writers of the shared creds path, callerless on current master (`dpAuthService.ts:69` routes to `oauth_creds.json` instead). An older cli, or a race with those writers, is the concrete candidate.
- **Minor drift, benign**: 168 not 166 commits ahead; `claude-agent.ts:4961` not `:4965` for the call; `SessionManager.ts:22809` and the join includes `.filter(Boolean)`; `credentials.md`'s "never … rewrites that file" is contradicted by `creds-store.ts:75-97`.
- **C14 caveat**: 403 on a listing-denied bucket is consistent with absence, not proof of it. Before telling a Windows user "no published build carries the fix", confirm against the publish job rather than the 403.
# Appendix F — external-model MCP whitelist: nessy-cli mechanism (full report)

I have everything. Writing the report.

# TASK A — nessy-cli external-model MCP whitelist

Repo: `/Users/i.i.gavrikov/Desktop/work/nessy-cli` @ `1f9e807cb` (0.13.11-beta.0). All paths below are relative to that root.

---

## 1. The constant and every usage

### The constant

`packages/core/src/core/openaiContentGenerator/constants.ts:17-27`

```ts
// [nessy-fork] external-model-mcp-whitelist
export const EXTERNAL_MODEL_MCP_WHITELIST: ReadonlySet<string> = new Set([
  'dpJira', 'dpGitlab', 'dpWiki', 't-tracker',
  'dpFinedog', 'dpSage', 'dpAllure', 'context7',
]);
```

It is a `Set` of **MCP server names**, not tool names. Prior fact confirmed, with one correction: the fork-patch doc claims it is an *empty* array (`docs/fork-patches/external-model-mcp-whitelist.md:26`, "иммутабельный пустой массив") and that "Пустой список = ни одного MCP-инструмента" (line 11). That was never true — `git show dc9122c7a -- .../constants.ts` shows all 8 entries landed in the introducing commit. **The doc is wrong about the shipped default.**

### Every usage

Exactly one read site: `packages/core/src/config/config.ts:3814`, inside `isMcpServerAllowedForModel()`.

Three predicates in `config.ts` compose it:

| Predicate | Lines | Meaning |
| --- | --- | --- |
| `isMcpServerInAllowList(name)` (private) | `config.ts:3786-3790` | Session allow list (`--allowed-mcp-server-names` / `mcp.allowed`). Model-independent. |
| `isMcpServerAllowedForModel(name)` (private) | `config.ts:3806-3816` | The trust boundary. `!contentGeneratorConfig → true`; else `internal === true \|\| WHITELIST.has(name)`. |
| `isMcpServerAllowed(name)` (public) | `config.ts:3819-3824` | AND of the two. |

Consumers of `isMcpServerAllowed`:

- `config.ts:3828` — `isMcpServerDisabled()` returns `true` for a blocked server.
- `tools/tool-registry.ts:687` — `getFunctionDeclarations()` skips `DiscoveredMCPTool`s of blocked servers.
- `tools/tool-registry.ts:752` — `getDeferredToolSummary()` (the startup reminder listing).
- `tools/tool-registry.ts:849` — `getTool()` returns `undefined`. `getFunctionDeclarationsFiltered()` inherits this via `this.getTool(name)` at `:793`.
- `tools/mcp-client-manager.ts:2733` — `addRuntimeMcpServer()` throws `InvalidMcpConfigError("server '<name>' is not allowed for the active model")`.

Plus the server-enumeration split, `getAllMcpServers()` at `config.ts:3711-3761`: step 1 filters by allow list into `all`, step 2 partitions into `allowed` / `blocked`. `getMcpServers()` (`config.ts:3763-3771`) returns **only `allowed`**; `getBlockedMcpServers()` (`config.ts:4850-4870`) feeds the UI, which renders blocked entries as disabled (`packages/cli/src/ui/components/mcp/MCPManagementDialog.tsx:73-76`, i18n strings `blocked` / `for external models` added in the same commit).

### Which layer does it actually bite at?

**Two layers, and the answer depends on session timing.**

`getMcpServers()` is what MCP discovery reads (`mcp-client-manager.ts:1502` inside `discoverAllMcpTools`), so *in principle* it is connection-time. But the fork's own design note (`config.ts:3798-3804`) says the model is unknown during `config.initialize()`, so `isMcpServerAllowedForModel` returns `true` there and **every configured server connects and registers its tools** at boot.

The registry is only purged of them if `refreshTools()` runs — `client.ts:625-631` → `restartMcpServers()` → `discoverMcpTools()` (`tool-registry.ts:498-507`) which calls `removeDiscoveredTools()` then re-discovers from the `allowed` set only. And `refreshTools()` has exactly two callers: `config.ts:3162` and `config.ts:3171`, both inside `handleModelChange()`, both gated on `prevInternal !== contentGeneratorConfig.internal`. **`refreshAuth()` never calls it** (see `config.ts:2561-2588`).

So on a session that *boots* on an external model, the blocked servers are connected, their processes are running, and their tools are live in `this.tools`. The whitelist bites purely as a **per-request tool-list filter**: `client.setTools()` at `client.ts:602-612` calls `toolRegistry.getFunctionDeclarations()` (`:610`), which drops them.

**What an excluded tool looks like to the model: absent from `tools[]`.** Not present-and-refused. It is also absent from the deferred-tools startup reminder (`getDeferredToolSummary`).

### Gap: the guard is missing from four accessors

The fork-patch doc claims (`external-model-mcp-whitelist.md:22`) that "`tool-registry` перепроверяет предикат на каждой декларации". It re-checks on *declaration* accessors. It does **not** re-check on:

| Accessor | Lines | Model-facing? |
| --- | --- | --- |
| `ensureTool(name)` | `tool-registry.ts:303-332` | **Yes — this is the dispatch path.** `coreToolScheduler.ts:1804` resolves the tool for execution via `ensureTool`, not `getTool`. A blocked-server tool still in `this.tools` would be found and executed. |
| `getAllTools()` | `tool-registry.ts:816-826` | **Yes** — `ToolSearch.collectCandidates()` (`tools/tool-search.ts:191-201`) scores over it, so a keyword search can surface a blocked MCP tool's name + description. |
| `getAllToolNames()` | `tool-registry.ts:805-808` | **Yes** — `ToolSearch.loadAndReturnSchemas()` (`tool-search.ts:223`) builds its lookup index from it, so `select:mcp__dpX__…` can load a blocked tool's full schema. |
| `getMcpServerInstructions()` | `tool-registry.ts:771-773` | **Yes** — `buildMcpServerInstructionsReminder()` (`utils/environmentContext.ts:231-252`) injects every connected server's instruction text into the system prompt, blocked or not. |

Sub-agents are handled correctly: `agent-core.ts:496/521` use `getFunctionDeclarations({includeDeferred: true})`, which is guarded, and `getContentGeneratorConfig()` resolves through the per-run AsyncLocalStorage view (pinned by `config.test.ts:5303-5366`), so an agent on an external model gets external treatment inside its frame.

---

## 2. How a model is classified internal vs external

The predicate is a **model-id prefix**, not a catalog flag, not a baseUrl, not an authType.

`packages/core/src/utils/configResolver.ts:232-234`:
```ts
export function isInternalModel(modelId: string | undefined): boolean {
  return !!modelId && modelId.startsWith(INTERNAL_MODEL_PREFIX);
}
```
`packages/core/src/models/constants.ts:103` — `export const INTERNAL_MODEL_PREFIX = 'tgpt/';`

The flow into `contentGeneratorConfig.internal`:

1. `models/modelRegistry.ts:322` — `resolveModelConfig()` returns `{ ...config, …, internal: isInternalModel(config.id) }`. Note the spread is at `:316` and `internal:` at `:322`, so **the prefix rule overrides whatever `internal` the config carried**.
2. `models/modelsConfig.ts:952` — `this._generationConfig.internal = model.internal` (the only writer of that field anywhere).
3. `core/contentGenerator.ts:200-204` — `resolveContentGeneratorConfigWithSources` spreads `generationConfig` into the new config.
4. `config.ts:2583` (initial auth) / `config.ts:3123` (hot model switch) — assigned onto `contentGeneratorConfig`.

The type comment agrees: `core/contentGenerator.ts:123` — `// Whether this model is internal (determined by model id prefix)`.

**The gateway's own flag is read but then discarded.** `packages/core/src/dp/dpModelsClient.ts:136` maps `internal: backendModel.is_internal` off the `/api/v1/cli/models` response (backend shape documented at `:111` as `{ name, desc, is_internal, alias?, modalities? }`), but step 1 above overwrites it with the prefix test. So a gateway model with `is_internal: true` whose id does not start with `tgpt/` is treated as **external** by the whitelist.

### Custom / user-added models

`modelProviders` entries go through the same `resolveModelConfig`, so `internal` is decided solely by whether the user's chosen model id starts with `tgpt/`. There is no baseUrl or authType constraint in `isMcpServerAllowedForModel` (`config.ts:3806-3816`). Consequence: a BYO OpenAI-compatible model declared as `{ id: "tgpt/anything", baseUrl: "https://<arbitrary>" }` is classified **internal** and gets the full MCP set.

Contrast with the sibling seatbelt guard, which *does* require both: `config.ts:218` — `authType === AuthType.DP_AUTH && modelInternal === true`. The MCP whitelist omits the `authType` half. That divergence is the bypass.

Two more edge behaviors:
- `internal` is never reset to `undefined` — `modelsConfig.ts:952` is the sole writer and only runs inside `applyResolvedModelDefaults` (`:847`), reached from `switchModel` (`:554`) and `syncAfterAuthRefresh` (`:1112`). A path that doesn't reach it leaves the previous value standing.
- Before `refreshAuth()`, `contentGeneratorConfig` is undefined and `isMcpServerAllowedForModel` returns `true` — fail-**open**, by explicit design (`config.ts:3798-3810`).

---

## 3. History, ticket, docs, tests, knobs

**Introducing commit** — `dc9122c7a`, `feat(AIDT-7489): fail-closed MCP whitelist для внешних моделей`, Гусев Виктор Николаевич <v.n.gusev@tinkoff.ru>, 2026-08-17. 14 files, +469/−96. Landed between the 0.13.9-beta.1 and 0.13.10-beta.0 bumps, i.e. it is the 0.13.10 "external models no longer get access to all tools" note.

**Follow-up** — `0be66e22c`, 2026-08-21 (in the 0.13.10-beta.1 window). Subject is a truncated body: *"В коммите dc9122c7a8 (AIDT-7489) getAllMcpServers() строил словарь allowed,…"*. It rewrote `getAllMcpServers` into the two-step filter/block shape and added the doc's "Порядок: сначала фильтрация, потом блокировка" section (`external-model-mcp-whitelist.md:13-22`).

**Fork-patch doc** — `docs/fork-patches/external-model-mcp-whitelist.md`, 60 lines: AIDT ref, rationale, the two-step ordering, file list, a 5-step rollback recipe, and `## Upstream — Не отправлен. Корпоративное требование безопасности`. Code marker is `// [nessy-fork] external-model-mcp-whitelist`. **Caveat: line 26 misstates the default as an empty array.**

**Tests** — `packages/core/src/config/config.test.ts:5399-5461`, `describe('external-model MCP whitelist')`, three cases: fails closed for external (`:5405`), preserves all for internal (`:5425`), still intersects with the general allow list (`:5442`). Plus `tool-registry.test.ts:416` (`isMcpServerAllowed → false` hides declarations) and `mcp-client-manager.test.ts:3502` (runtime add rejected).

**Test gap:** all three config tests use servers named `first` / `second`. **No test anywhere asserts that a whitelisted name (`dpJira`, `context7`, …) is actually reachable from an external model** — `rg` for those names across `packages/core/src` + `packages/cli/src` returns only the constant itself and an unrelated `dpAllure` fixture in `environmentContext.test.ts`. The list's contents are unpinned; a typo in an entry would be silent.

**Knobs to extend or disable it: none.** The list is a module-level `const` with no env read, no settings key, no CLI flag (`rg "MCP_WHITELIST|EXTERNAL_MODEL"` finds only the definition and the one consumer). The two adjacent knobs — `--allowed-mcp-server-names` / `settings.mcp.allowed` (`packages/cli/src/config/config.ts:745`, `:1730`) and `excludedMcpServers` — can only **narrow** further; they are ANDed (`config.ts:3821-3823`), never ORed. Changing the policy requires a code edit and a release.

---

## 4. The key side: which endpoint and which auth for an external model

**Short answer: the same gateway, with the same dp JWT.** An "external" model in nessy-cli's sense is not reached directly — it is a model the Nestor gateway proxies onward. That is precisely why the whitelist exists.

`packages/core/src/dp/dpModelsClient.ts:132-146` stamps **every** model returned by `/api/v1/cli/models` with:
```ts
baseUrl: DEFAULT_NESTOR_BASE_URL,   // :141
envKey: 'DP_AUTH_MODEL_KEY',        // :142
```
regardless of `is_internal`. `DEFAULT_NESTOR_BASE_URL` = `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1` (`constants.ts:11-12`) — identical to ours.

### Provider scoping

`packages/core/src/core/openaiContentGenerator/provider/nestor.ts:34-46`:
```ts
static isNestorProvider(contentGeneratorConfig: ContentGeneratorConfig): boolean {
  const { authType, baseUrl } = contentGeneratorConfig;
  if (authType === AuthType.DP_AUTH) return true;
  if (!baseUrl) return true;
  return (
    baseUrl.includes('code-completion-nestor.tcsbank.ru') ||
    baseUrl.includes('llm-proxy')
  );
}
```
Selected at `openaiContentGenerator/index.ts:65-67`. Two things worth flagging: `authType === DP_AUTH` short-circuits **before any baseUrl check**, and both host tests are `String.includes`, not host parsing — `https://evil.example/llm-proxy` matches.

### Can the dp JWT reach a non-Nestor host?

The JWT is attached in `nestor.ts:60-62`:
```ts
if (authType === AuthType.DP_AUTH && apiKey) {
  Object.assign(defaultHeaders, buildNestorAuthHeaders(apiKey));
}
```
**There is no baseUrl check on this branch** — the condition is authType-only. So the safety rests entirely on DP_AUTH's baseUrl being unforgeable. It effectively is, via three independent pins:

1. `models/modelRegistry.ts:92-95` — user `modelProviders` entries keyed `dp-auth` are explicitly **skipped** ("Skip dp-auth as it uses hard-coded models"); `:77-78` registers DP_AUTH from `DP_AUTH_MODELS` only, which is `[]` (`models/constants.ts:112`) and filled at runtime from the server.
2. `models/modelConfigResolver.ts:314-368` — `resolveNessyOAuthConfig()` never reads `cli.baseUrl` or `env` baseUrl; the returned config (`:360-366`) has no `baseUrl` key at all.
3. `baseUrl` is in `CREDENTIAL_FIELDS` (`models/constants.ts:41-46`), **not** in `MODEL_GENERATION_CONFIG_FIELDS` (`:21-35`), so `settings.model.generationConfig.baseUrl` cannot reach it either.

Net: under DP_AUTH the baseUrl always comes from `dpModelsClient.ts:141`. The pin is structural rather than asserted — there is no `assert(baseUrl is nestor)` before the header goes on, which is weaker than our rule of attaching `Nestor-Token` only on the verified gateway URL.

Header name is chosen at `packages/core/src/dp/nestorAuthHeader.ts:24-30`: `Nestor-Token: <jwt>` normally; `Authorization: Bearer <jwt>` **only** when the JWT is byte-identical to `process.env.NESSY_CLI_DP_AUTH_TOKEN` (the delegated Spirit IAM env-bypass path, documented `:5-22`).

### The other proxy

`constants.ts:4-5` — `LLM_PROXY_BASE_URL = 'https://llm-proxy.t-tech.team/v1'`, and `DEFAULT_OPENAI_BASE_URL = LLM_PROXY_BASE_URL`. `modelRegistry.ts:67-68` makes it the default baseUrl for `AuthType.USE_OPENAI`. That path uses a **separate Bearer API key** read from the provider's `envKey` (`modelsConfig.ts:883-887`) — the OpenAI SDK's own `Authorization` header, never the dp JWT (`nestor.ts:60` does not fire for non-DP_AUTH). This is the ~27-entitled-models surface. It routes through `NestorOpenAICompatibleProvider` because of the `includes('llm-proxy')` test, but that only affects User-Agent, trace, and session-id headers.

### Guardrail / tool-refusal handling: none

No special handling exists. `rg -i guardrail` across `packages` matches only the **MCP client budget** guardrails (`mcp-workspace-budget.ts`, the `mcp_guardrails` daemon capability tag) — entirely unrelated to the proxy's tool-bearing-request refusal. In the OpenAI pipeline the only adjacent code is a generic finish-reason map, `openaiContentGenerator/converter.ts:1743` — `content_filter: FinishReason.SAFETY`. There is **no tool-stripping retry, no downgrade-and-resend, no anthropic-specific tool suppression**. A proxy refusal surfaces as a raw provider error.

---

## 5. The 0.13.10 "service signature" note

**Commit:** `7dce5a012`, `fix(AIDT-7499): ignore MCP attestation in deferred tool search descriptions`, same author, 2026-08-17 (one day before the whitelist, same 0.13.10 window). 3 files, +96/−7 — test-heavy; the entire production change is 15 lines in one file.

**What the "service signature" is:** a delimited banner the dp MCP servers prepend to each tool's `description`, of the form

```
|mcp-tool-attestation|<payload>|/mcp-tool-attestation|
```

Constants at `packages/core/src/utils/environmentContext.ts:28-29`. Real-world payloads seen in the tests are single tokens like `signed` / `first` / `second`; the banner may be its own line (CRLF-separated, and there may be several stacked) or sit inline ahead of the real prose. It is an integrity/provenance marker emitted by the dp binary that spawns those servers (`packages/cli/src/core/dpBinary.ts:17` lists dpWiki, codeSearch, dpJira as direct spawns).

**What changed:** `truncateDeferredToolDescription()` (`environmentContext.ts:120-136`) used to take `description.split('\n')[0].trim()` — so for a dp tool the model's one-line summary in the deferred-tools startup reminder *was the attestation banner*, and the actual description never appeared. Now it splits on `/\r?\n/`, strips a leading `PREFIX…SUFFIX` span from each line, and takes the first non-empty result. An unclosed prefix (no suffix on the line) is deliberately left verbatim — pinned by `environmentContext.test.ts:517-532`.

**Scope of the fix — narrower than the release note implies:**
- It affects **only the reminder listing** rendered by `formatDeferredToolLine` (`environmentContext.ts:147-154`), used by `buildDeferredToolsReminder` and `buildAddedMcpToolsReminder` (`:221-229`).
- The banner is deliberately **preserved** in the schema `tool_search` returns — `tool-search.test.ts:172-190`, "preserves an MCP attestation in the loaded tool schema".
- It is **not** stripped from the ranking haystack: `scoreTool()` reads `tool.description` raw (`tools/tool-search.ts:498`, `descLower.includes(term)` at `:518`). So "не попадает в поисковый индекс" is accurate about the *listing the model reads*, not about the fuzzy-match corpus, which still contains the banner text.

---

## Mechanism summary

The whitelist bites at **per-request tool-list construction**, not at MCP connection time and not at call time. `EXTERNAL_MODEL_MCP_WHITELIST` (`constants.ts:18-27`) is read from exactly one place, `Config.isMcpServerAllowedForModel()` (`config.ts:3806-3816`), which answers "internal, or whitelisted" for the active model — where "internal" means nothing more than the model id starting with `tgpt/` (`configResolver.ts:232-234`), the gateway's own `is_internal` flag having been overwritten en route (`modelRegistry.ts:322`). Because `config.initialize()` runs MCP discovery before any auth exists, the predicate returns `true` during boot and **every** configured server connects and registers its tools; the ban is then applied downstream by `ToolRegistry.getFunctionDeclarations()` (`tool-registry.ts:684-690`), which is what `client.setTools()` feeds to the model (`client.ts:610`). So an excluded tool is **absent from `tools[]` and absent from the deferred-tools reminder** — never present-and-refused. The registry is only physically purged of it when a model switch crosses the trust boundary and triggers `refreshTools()` (`config.ts:3162/3171`), which never happens on a session that boots external; until then the tool object is live and reachable through the four accessors that were not given the guard — most importantly `ensureTool()` (`tool-registry.ts:303`), the scheduler's actual dispatch lookup (`coreToolScheduler.ts:1804`).

| Property | Value |
| --- | --- |
| **Layer** | Per-request tool-declaration filter (`getFunctionDeclarations` → `setTools`), plus server enumeration (`getMcpServers` → `allowed`) and a runtime-add guard (`mcp-client-manager.ts:2733`). Not connection-time in practice; not call-time at all. |
| **Default** | 8 servers: dpJira, dpGitlab, dpWiki, t-tracker, dpFinedog, dpSage, dpAllure, context7. (Fork-patch doc wrongly documents "empty".) |
| **Classification** | `modelId.startsWith('tgpt/')` → internal → unrestricted. Everything else → external → whitelist only. No authType or baseUrl component. |
| **Extensibility** | None at runtime — hard-coded `const`, no env var, no setting, no flag. `--allowed-mcp-server-names` / `mcp.allowed` can only narrow further (ANDed at `config.ts:3821`). Policy change = code change + release. |
| **Fail mode** | Fail-**closed** once a model is known (unknown server → blocked). Fail-**open** while `contentGeneratorConfig` is unset, by design (`config.ts:3798-3810`). |
| **Known gaps** | (a) `ensureTool` / `getAllTools` / `getAllToolNames` / `getMcpServerInstructions` are unguarded → dispatch, both `tool_search` modes, and the system-prompt instruction block can still reach a blocked server before any `refreshTools()`. (b) A BYO model id prefixed `tgpt/` on an arbitrary baseUrl is classified internal — the sibling seatbelt check requires `authType === DP_AUTH` too (`config.ts:218`), this one does not. (c) No test pins any actual whitelist entry. |

### Cross-repo notes for OURS

1. **Their "external" model still talks to the Nestor gateway with the dp JWT** (`dpModelsClient.ts:141-142`) — the whitelist is a data-egress control on a proxied provider, not a different-endpoint problem. If we ever add an equivalent, the classifier should be the *upstream provider*, not a model-id prefix.
2. **Their JWT attachment is authType-gated, not URL-gated** (`nestor.ts:60`), safe only because DP_AUTH's baseUrl is unforgeable through three separate pins. Our rule (attach `Nestor-Token` only on the verified gateway URL) is the stronger invariant; worth keeping as-is.
3. `isNestorProvider` uses `baseUrl.includes('llm-proxy')` (`nestor.ts:44`) — substring, not host match. If we mirror any of this scoping, parse the host.
4. The `|mcp-tool-attestation|…|/mcp-tool-attestation|` banner is a real wire artifact of the dp MCP servers. Any surface of ours that renders dp tool descriptions (deferred-tool reminders, tool pickers, Sources UI) will show it unless stripped the same way (`environmentContext.ts:120-136`).
# Appendix G — our llm-proxy exposure and whitelist hook options (full report)

# TASK B — nessy-desktop: exposure via llm-proxy external models, and where a whitelist would hook

All claims below are from source read on `feat/TCODE-000` @ `6c056870f`. Paths are repo-relative to `/Users/i.i.gavrikov/Desktop/work/nessy-desktop`.

---

## 1. How a BYO llm-proxy connection works today, per runtime

### 1a. The three transports

| Runtime | `providerType` | Path to upstream | Wire | Credential |
|---|---|---|---|---|
| Pi | `pi_compat` (BYO) / `pi` | Pi subprocess `fetch`, patched by the interceptor preload | `customEndpoint.api`: `'openai-completions'` → `{base}/chat/completions`; `'anthropic-messages'` → `{base}/v1/messages` | `Bearer` from `credentialManager.getLlmApiKey(slug)` |
| claude-runtime | `claude-runtime` | Claude SDK child → `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` → local `codex-responses-adapter` → upstream | per-request: `openai-compatible` (translated) **or** `anthropic-messages` (passthrough) | `Bearer` from `getLlmApiKey(slug)` |
| codex-runtime | `codex-runtime` | codex app-server → `base_url = http://127.0.0.1:<port>/v1`, `wire_api = "responses"` → same adapter → upstream | `openai-compatible` only | `Bearer` from `getLlmApiKey(slug)` |

**Pi.** `packages/shared/src/config/llm-connections.ts:112` — `export type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';`. The credential is resolved in `PiAgent.getPiAuth` and forwarded to the subprocess as `piAuth` (`packages/shared/src/agent/pi-agent.ts:2338-2345`, sent at `:1709`). The interceptor picks its adapter from the URL (`shouldIntercept`, `packages/shared/src/unified-network-interceptor.ts:912`, `:1368`, `:1606`) or the `NESSY_PI_MODEL_API` hint (`:2015`).

**claude-runtime.** `ClaudeAgent.startLocalAdapterRuntime` starts a per-session loopback adapter and writes `ANTHROPIC_BASE_URL: \`http://127.0.0.1:${handle.port}\`` (`packages/shared/src/agent/claude-agent.ts:1920`) plus `ANTHROPIC_API_KEY: 'not-needed'` — the SDK child never sees a real credential. The upstream is classified by `buildClaudeRuntimeUpstream` (`packages/shared/src/agent/backend/internal/drivers/anthropic.ts:23-32`): gateway iff `isNessyGatewayBaseUrl(baseUrl)`, otherwise `{ kind: 'openai-compatible', baseUrl }`, and it **throws** rather than defaulting to `api.anthropic.com`.

Per-request wire routing is `buildClaudeRuntimeWireRouter` (`drivers/anthropic.ts:67-85`): models on the connection stamped `wire === 'anthropic-messages'` get a `{ kind: 'anthropic-messages' }` passthrough target on the *same* base URL and key; every other model uses the session upstream. It returns `undefined` unless the session upstream is `openai-compatible` (`:71`) — "GATEWAY MODE ROUTES NOTHING".

**codex-runtime.** `buildCodexRuntimeUpstream` (`drivers/codex.ts:32-38`) — blank or gateway URL → `{kind:'nestor'}`, everything else → `openai-compatible`. codex is pointed at the adapter in `packages/codex-responses-adapter/src/config-writer.ts:799-800`.

**Credential attach** is one shared function: `attachUpstreamCredential` (`drivers/upstream-target.ts:58-76`) — `if (args.target.kind !== 'openai-compatible') return args.target;` then `getLlmApiKey(args.slug)`. Gateway mode never reads a connection credential; a BYO target with no slug throws instead of sending an unauthenticated request.

### 1b. Nestor-Token is scoped to the verified gateway URL — CONFIRMED

**Adapter side (claude-runtime + codex-runtime).** One function decides the auth header for all three modes:

`packages/codex-responses-adapter/src/nestor-client.ts:80-108` — `resolveUpstreamRequest`:
- `case 'nestor'` → url `NESTOR_CHAT_URL` (a hardcoded constant, `:22`), headers `{'content-type', 'Nestor-Token': jwt ?? ''}`
- `case 'openai-compatible'` → `${baseUrl}/chat/completions`, `Authorization: Bearer` only
- `case 'anthropic-messages'` → `${baseUrl}/v1/messages`, `Authorization: Bearer` only

The gateway JWT is structurally unreachable for the other two arms: it is only read in the `'nestor'` branch, documented at `:52-58` — "Read ONLY in `kind: 'nestor'` mode; never forwarded to any other upstream." The passthrough (`postAnthropicMessages`, `:184-208`) calls the same resolver with no jwt argument at all.

The gateway URL predicate is a **whole-URL** match: `drivers/upstream-target.ts:26` derives `NESSY_GATEWAY_CHAT_BASE_URL` from `NESTOR_CHAT_URL`, and `:34-37` `isNessyGatewayBaseUrl` compares normalized equality. Its comment quotes the rule: "Custom endpoints, even on the same host with a different path, must retain normal provider auth semantics" (`:21-24`), and explicitly declines to reuse `isNestorCliBaseUrl` because "it accepts every path under the CLI prefix".

**Pi side (interceptor).** `packages/shared/src/unified-network-interceptor.ts:627-628`:

```ts
export function rewriteNestorAuthHeaders(urlStr: string, headers: HeadersLike): HeadersLike {
  if (!urlStr.startsWith(NESTOR_CLI_BASE_PREFIX)) return headers;
```

with `NESTOR_CLI_BASE_PREFIX = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/'` (`packages/shared/src/auth/nestor.ts:1`). Correlation headers use the same guard and are documented as "Empty for every URL outside the verified gateway prefix — including another path on the gateway's own host" (`packages/shared/src/telemetry/gateway-headers.ts:63`, guard at `:68`). Operator `NESSY_CUSTOM_HEADERS` are scoped to `isProviderApiUrl` (`unified-network-interceptor.ts:651-654`).

The Pi gateway JWT itself is double-gated: `packages/shared/src/agent/pi-agent.ts:265-272`

```ts
if (config.providerType !== 'pi_compat') return null;
if (!isNestorCliBaseUrl(config.runtime?.baseUrl)) return null;
return readCreds()?.jwt ?? null;
```

**Verdict for llm-proxy specifically:** `llm-proxy.t-tech.team` is a different host, so every one of these guards fails closed. An llm-proxy connection carries only its own `Authorization: Bearer <key>`; the dp JWT is never sent, and dp creds are never even read. Pinned by tests: `packages/shared/src/__tests__/unified-network-interceptor.nestor-auth.test.ts:38` ("leaves non-gateway hosts untouched") and `:47` ("leaves same-host non-CLI paths untouched"); `packages/shared/src/agent/__tests__/codex-byo-upstream.test.ts:353` ("posts to the BYO endpoint with Bearer auth and NEVER Nestor-Token") and `:380` ("never reads dp creds for a BYO endpoint — POSITIVE CONTROL for the row above").

**One asymmetry worth flagging (not an llm-proxy exposure, but a real inconsistency).** The adapter uses a whole-URL gateway match; the Pi interceptor (`rewriteNestorAuthHeaders`, `:628`) and the Pi JWT resolver (`isNestorCliBaseUrl`, `auth/nestor.ts:4-6`) use a **prefix** match on `…/api/v1/cli/`. A BYO `pi_compat` connection pointed at any other path under that prefix would have its user-supplied `Bearer` silently rewritten into `Nestor-Token` — which is exactly what the adapter-side comment says must not happen. Test `unified-network-interceptor.nestor-auth.test.ts:29` encodes this as intended behaviour ("rewrites Bearer auth for the CLI-scoped models URL"), so it is a deliberate divergence rather than a bug, but the two halves of the repo state different rules.

---

## 2. What tools reach an external model today

### 2a. Where the tool set is built, per runtime

**Pi** — `PiAgent.buildCurrentProxyToolDefinitions`, `packages/shared/src/agent/pi-agent.ts:1785-1836`:
- all session tools from `getSessionToolProxyDefs()` (`:1787`), minus `browser_tool` when globally off (`:1789-1791`) and minus the two MCP-resource tools when no connected source advertises resources (`:1796-1800`)
- `+ this.mcpPool.getProxyToolDefs(slugsForLeaser(leaserId), leaserId)` (`:1818-1821`) — every MCP/API source leased by this session
- `+` LSP tool, `+` format tool

The **only** filter applied is `this.config.piAllowedTools` (`:1825-1836`). That field is set in exactly one place: `packages/server-core/src/sessions/SessionManager.ts:14846` — `piAllowedTools: provider === 'pi' ? managed.piChildRestrictions?.tools : undefined`. It is a child/subagent restriction. **Nothing about the model, the connection, or the endpoint host feeds it.**

**claude-runtime** — `packages/shared/src/agent/claude-agent.ts:2447-2460`:

```ts
const fullMcpServers: Options['mcpServers'] = {
  session: getSessionScopedTools(sessionId, …),   // :2449
  ...sourceProxies,                                // :2453
};
const mcpServers = miniConfig.enabled ? this.filterMcpServersForMiniAgent(…) : fullMcpServers;
```

`sourceProxies` comes from `createSourceProxyServers(this.config.mcpPool, …)` (`:2436`, defined `:1322-1375`), which iterates `pool.slugsForLeaser(leaserId)` and registers every tool of every leased source as `mcp__{slug}__{tool}`. The only narrowing is the mini-agent branch. Native tools are narrowed only by the static `CLAUDE_SESSION_DISALLOWED_TOOLS` (`:350-…`, four entries: `EnterPlanMode`, `ExitPlanMode`, `Skill`, `Monitor`) applied at `:2429`. No connection or model input anywhere.

**codex-runtime** — `packages/codex-responses-adapter/src/config-writer.ts:820` (`[mcp_servers.session]`) and `:833-835` (`[mcp_servers.sources]` pointing at the session's `McpPoolServer` HTTP URL with a bearer env var). Both blocks are written whenever the corresponding option is present; there is no per-connection or per-model condition.

**Pool membership** is set by `McpClientPool.sync` per leaser (`packages/shared/src/mcp/mcp-pool.ts:1783`), called from `SessionManager.ts:14381` and `packages/shared/src/agent/base-agent.ts:2456`. The desired set is the capability view. The **only** admission filter in that chain is the managed policy at `packages/server-core/src/bootstrap/storage-runtime.ts:809-818` (`isManagedMcpServerAllowed`) — and it is gated by `if (!isPiCapabilityTurn) return true` at `:804`, where `const isPiCapabilityTurn = context.provider === 'pi'` (`:673`). **On a claude-runtime or codex-runtime turn the managed MCP allow/deny lists do not apply at all.** The file itself flags this shape as the recurring defect class ("an ORIGIN lock that silently lapses per provider is the 'declared on one path, enforced on another' defect this policy keeps guarding against", `:786-788`).

The bundled dp MCP servers are additionally exempt by design: `builtinDpMcpCapabilityRecords` is appended after the filter (`storage-runtime.ts:881`) and its doc-comment states "**It is NOT filtered by the managed MCP policy**, unlike the discovered records above" (`:617`).

### 2b. Is the "strip tools / skip on guardrail refusal" workaround implemented?

**No. It is an operator recipe only — there is no code.**

- `grep -ra "Guardrail" packages/*/src` outside tests returns 3 hits, all comments/unrelated: `claude-sdk-error-mapper.ts:265`, `pi-agent.ts:1174`, `session-scoped-tools.ts:80`.
- `grep -ra "EXTERNAL_MODEL" packages apps` → 0 hits. There is no counterpart to nessy-cli's `EXTERNAL_MODEL_MCP_WHITELIST`.
- The only guardrail-aware code is presentational: `packages/shared/src/agent/claude-sdk-error-mapper.ts:277-292` turns a 403 into `provider_error` / "Request Refused" instead of "your key is wrong". It rewrites the message; it does not retry or alter the request.
- The passthrough's field-removal machinery explicitly refuses to touch tools: `packages/codex-responses-adapter/src/anthropic/passthrough-negotiation.ts:52-56` — "`messages`, `system`, `tools`, `model`, `max_tokens`, `thinking`, `metadata`, `stream` and friends are NOT candidates and never will be" — and it only fires on **400**, never 403 (`:31-38`, `findRefusedRemovableFields`).
- The retry ladder (`packages/codex-responses-adapter/src/retry.ts:75-88`) retries only on `status === 400` matching `/model is required/`. A 403 returns immediately.

### 2c. Plain answer

**Yes. Today, dp MCP tools (`mcp__dpJira__*`, `mcp__dpGitlab__*`, …) are sent to an Anthropic model reached through llm-proxy, along with our own `mcp__session__*` tools and any plugin's.**

Evidence — the recorded 403 body *is* our tool array read back to us (`docs/testing/cdp-runs/2026-08-21-t23-lane-g.md:254-260`):

```
{"error":"Security Guardrail Triggered: Malicious MCP detected. Invalid tools:
mcp__plugin_figma_figma__download_assets, … mcp__session__BashOutput,
mcp__session__ProcessStop, mcp__session__ReportFindings, …
mcp__session__spawn_session, mcp__session__transform_data,
mcp__session__update_user_preferences","operation":"forbidden"}
```

The same run's narrative: "it refuses our own bundled `mcp__session__*` tools too, so it is not a plugin-specific problem" (`:265-267`). The proxy sees the names because we send them.

And where the guardrail does *not* fire, the same tool array goes out and is accepted: `docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md:1291` records `CODEX-TURN` **PASS 6/6** against llm-proxy through the Responses adapter, and `:1315` states "**The guardrail polices `/v1/messages` only.** Pi and Codex" get a clean answer. So on 2 of 3 runtimes the exposure is real, unpoliced, and invisible.

---

## 3. Where an external-model MCP whitelist could hook

### Option (a) — session-level: filter the MCP set handed to the agent, by connection classification

Anchors:
- `packages/server-core/src/bootstrap/storage-runtime.ts:800-820` — the existing capability-record filter that already runs `isManagedMcpServerAllowed` per record. The natural insertion point; it already has the shape (deny-first, allowlist-second) and an admin-policy source.
- `packages/server-core/src/sessions/SessionManager.ts:14381` (`setupMcpPool.sync(mcpServers, …)`) and `packages/shared/src/agent/base-agent.ts:2452-2460` (`this.config.mcpPool.sync(mergedMcpServers, …)`) — the two sites that publish a session's desired set into the shared pool.

Covers: **all three runtimes at once**, because all three read the pool through `slugsForLeaser` (Pi `pi-agent.ts:1818`; Claude `claude-agent.ts:1322-1336`; codex via `McpPoolServer` at `SessionManager.ts:14368-14376`).

Gaps and costs:
1. **`CapabilityContext` has no connection.** `packages/shared/src/capabilities/resolver.ts:99-124` carries `workspaceId`, `sessionId`, `provider`, project trust — no slug, no baseUrl, no model. A new context input is required, and it must be threaded from `SessionManager` where the connection is known.
2. **It does not cover `mcp__session__*`.** Session tools do not come from the pool: Pi builds them from `getSessionToolProxyDefs()` (`pi-agent.ts:1787`), Claude from `getSessionScopedTools(...)` (`claude-agent.ts:2449`), codex from the `[mcp_servers.session]` stdio block (`config-writer.ts:820`). The recorded guardrail body names those too, so a pool-only filter would not have cleared the measured 403. A second, per-runtime filter is needed. Precedent exists for exactly that shape: `pi-agent.ts:1789-1791` already drops `mcp__session__browser_tool` from the list on a global preference.
3. Cutting a source out of the *pool* also cuts it out of the UI's connected set and the session's own tool routing — i.e. it is a real capability removal, not a wire-level mask. That may be desirable (it is honest) or not (the same session may want the tool for a Pi turn and not for an anthropic-wire turn).

### Option (b) — Pi path: strip non-whitelisted tools from the outbound body per host, in the interceptor

Anchor: `packages/shared/src/unified-network-interceptor.ts:2376-2427` — `interceptedFetch` already has `url` in scope, parses the body (`JSON.parse(bodyStr)`, `:2384`), rewrites the tool array (`parsed = adapter.addMetadataToTools(parsed)`, `:2387`), validates it (`:2398`) and re-serializes (`:2419`). A host-scoped `body.tools` filter is a few lines at `:2388`, alongside the existing `isProviderApiUrl` host classification at `:651-654`.

Covers: **Pi only** (plus the headless `nessy-server` process, which `--preload`s the same bundle). `packages/shared/AGENTS.md` states the constraint directly: "The network interceptor (`unified-network-interceptor.ts`) is currently **Pi-only**: it preloads into the Pi subprocess via Bun `--preload`. The Claude SDK no longer runs under Bun … so `--preload` is not available there."

Gaps: leaves claude-runtime and codex-runtime completely uncovered — which is precisely the arm where the pain is. Also, a wire-level strip that leaves the tool *registered* means the model can still be told about it in history and a stale `tool_call` can come back for a tool we masked; `sanitizeOpenAiHistoryInPlace` (`packages/codex-responses-adapter/src/sanitize.ts:15`) exists because history/tool mismatches are already a live failure mode here.

### Option (c) — claude-runtime: the SDK `mcpServers` name-set

Anchors: `packages/shared/src/agent/claude-agent.ts:2447-2460` (construction) and `:4052-4054` (`applyLiveSettings` → `Query.setMcpServers`, with the documented rule that its **result** must be checked, not merely that it did not throw — `:3999`, `:4100`). Native tool names go through `disallowedTools` (`:2429`).

Covers: claude-runtime only. Cheapest per-runtime option and the only one with a *live* setter (no respawn). Gap: Pi and codex untouched; and `mcpServers` is a server-level switch, so it cannot express "this server but only these tools".

### Option (d) — the local adapter (`codex-responses-adapter`)

Anchors:
- `packages/codex-responses-adapter/src/server.ts:476-560` — `handleMessages`, which holds `opts.upstream` (the `UpstreamTarget`, i.e. the host and its kind), reads `raw.model` at `:503-506`, and branches to passthrough at `:508`.
- `packages/codex-responses-adapter/src/anthropic/inbound.ts:270-291` — `toolsToResponses`, which *already* drops tool kinds it cannot route ("Other server tools (bash_*, text_editor_*, ...) have no routed equivalent: drop.", `:289`).
- The `/v1/responses` route serves codex from the same process.

Covers: **claude-runtime AND codex-runtime in one place** — the only single hook that covers two runtimes — and it is the only layer that sees *both* the resolved upstream host and the per-request model id. Gaps: Pi does not pass through it. And filtering inside `pipeAnthropicPassthrough` contradicts that module's own stated doctrine — `packages/codex-responses-adapter/src/anthropic/passthrough-negotiation.ts:24-25`: "every byte we reshape is a byte we can get wrong" — and `:52-56` names `tools` as a field the passthrough must never silently rewrite. Doing it there is a deliberate policy exception that has to be written down, not a quiet edit.

### What no whitelist can honestly promise

An MCP-name whitelist bounds **which corporate systems the model can drive**. It does not bound **what data leaves**.

- Native tools carry no `mcp__` prefix and are not in the pool: `Bash`, `Read`, `Write`, `Glob`, `Grep` (see `packages/shared/src/agent/base-agent.ts:295`, `packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts:483`, `packages/shared/src/agent/mode-manager.ts:2271`). Every one of them can read a file and put its contents in the next request body.
- Isolation is off by default (standing owner decision, `AGENTS.md` "Sandbox off"), so those tools reach the whole filesystem.
- Three session tools are backend-executed and route outward by design: `call_llm`, `spawn_session`, `browser_tool` (`packages/shared/src/agent/pi-agent.ts:275-279`; defs at `packages/session-tools-core/src/tool-defs.ts:1077-1081`).
- The *conversation itself* — file contents, ticket text, credentials pasted by the user — is already in the request body before any tool is offered.

So the honest claim is: "an external model cannot be handed the ability to *act on* dpJira/dpGitlab/dpWiki". Not "an external model cannot see internal data".

---

## 4. How we would classify internal vs external

### Fields already on the connection

`packages/shared/src/config/llm-connections.ts:159-256` (`interface LlmConnection`):
- `slug`, `name`
- `providerType: LlmProviderType` (`:168`)
- `baseUrl?: string` (`:171`)
- `authType: LlmAuthType` (`:174`)
- `models?: Array<ModelDefinition | string>` (`:177`)
- `customEndpoint?: CustomEndpointConfig` (`:229`) — `{ api: 'openai-completions' | 'anthropic-messages', supportsImages?, dialect? }` (`:112`, `:120-137`)

Per-model provenance: `packages/shared/src/config/models.ts:119-131` — `wire?: 'anthropic-messages'`, documented as "Written only by a probe that actually got an answer on that wire — never [guessed]" (`:127`). The probe is `packages/server-core/src/model-fetchers/openai-compat.ts:197-226`; `:218` `return { verdict: 'ok', wire: 'anthropic-messages' }`. Model ids on llm-proxy are namespaced (`anthropic/claude-fable-5`, per the run log), which is a second, weaker signal.

### Existing host predicates

| Predicate | File:line | Semantics |
|---|---|---|
| `isNessyGatewayBaseUrl` | `packages/shared/src/agent/backend/internal/drivers/upstream-target.ts:34-37` | whole-URL equality with the derived gateway chat base — the strictest, and the governance boundary for `Nestor-Token` |
| `isNestorCliBaseUrl` | `packages/shared/src/auth/nestor.ts:4-6` | prefix `…/api/v1/cli/` — used by the interceptor rewrite and the Pi JWT gate |
| `isLocalConnection` | `packages/shared/src/config/llm-connections.ts:566-577` | loopback host (`localhost`/`127.0.0.1`/`::1`) |
| `isAdapterRuntimeProvider` | `packages/shared/src/config/llm-connections.ts:549-551` | `codex-runtime \|\| claude-runtime` |
| `isPiProvider` / `isCompatProvider` | `:582-584` / `:531-533` | Pi family |
| `evaluateManagedMcpServer` / `isManagedMcpServerAllowed` | `packages/shared/src/agent/pi-harness/managed-mcp-entries.ts:489-511`, `packages/shared/src/agent/pi-harness/managed-policy.ts:1770` | deny-first then allowlist, by `serverName` / `serverUrl` / `serverCommand` |

**There is no "trusted host list" for model endpoints today** — the only whole-URL trusted endpoint is the gateway itself. But the closest existing primitive is an admin-supplied *domain* allowlist for network egress: `packages/shared/src/config/network-address-guard.ts:37-45` (`managedAllowlist`, used only when `allowManagedDomainsOnly` resolves) and its enforcement at `:237-239`. That file already handles the raw-IP-bypass case (`:22-28`) and the empty-allowlist fail-closed case (`:88`). If "internal hosts" is going to become a concept, that is where the list belongs, and the model-endpoint classifier should read the same list rather than growing a second one.

**Recommended classifier shape** (derivable today, no new storage except the host list):

```
internal(connection) :=
     isNessyGatewayBaseUrl(connection.baseUrl)          // the corp gateway
  || isLocalConnection(connection)                       // Ollama/vLLM on this machine
  || managedInternalHosts.matches(host(connection.baseUrl))  // admin list, network-address-guard shape
external(connection) := !internal(connection)
```

Per-*model* refinement (`wire === 'anthropic-messages'`, or an `anthropic/` id prefix) should be treated as a **narrower** signal layered on top, not as the classifier: llm-proxy serves Qwen and Anthropic from one base URL and one key, which is exactly why `buildClaudeRuntimeWireRouter` (`drivers/anthropic.ts:56-58`) had to become per-request in the first place. A connection-level classifier that ignores the model would over-restrict the Qwen half of the same card.

---

## 5. What concretely goes wrong today on "we go to llm-proxy with a key that has Anthropic models"

**All three of the following, simultaneously.**

### (i) The turn is refused outright — on the only route to an Anthropic model we have

Anthropic models on llm-proxy answer only on `/v1/messages` (measured; `nestor-client.ts:30-33`). The only runtime that can reach that wire is `claude-runtime` with per-model passthrough (`drivers/anthropic.ts:67-85`). And the guardrail refuses every tool-carrying request on that wire:

`docs/testing/cdp-live-checklist.md` (case `G3-WIRE`): "FAIL — server-side, wire still PROVEN … The control passed (`verdict=ok wire=anthropic-messages`), so the passthrough reaches `/v1/messages`; the live turn was refused by the llm-proxy guardrail — `403 … Security Guardrail Triggered: Malicious MCP detected. Invalid tools: …` listing plugin AND our own `mcp__session__*` tools, i.e. any tool-carrying turn on the anthropic wire."

So: **the tool-free probe succeeds, every real session turn fails.** This is not a wire bug and not a credential bug — it is our tool array meeting their policy.

### (ii) Silent tool exposure everywhere the guardrail does not fire

The guardrail is scoped to `/v1/messages` (`run-narratives.md:1315`). Pi and codex reach llm-proxy over chat-completions/Responses and succeed (`:1291`, `CODEX-TURN` PASS 6/6). Those turns carry the full `mcp__dpJira__*` / `mcp__dpGitlab__*` / `mcp__session__*` array to an external proxy with no filter of any kind (§2a). **Nothing in the product logs, warns about, or narrows this.** It is only visible today because a *different* endpoint happens to reject it and echo the list back.

### (iii) Our own error surface misdiagnoses the refusal as a credential problem

Three separate places:

1. **claude-runtime, missing status.** `packages/shared/src/agent/claude-sdk-error-mapper.ts:277` fires the honest "Request Refused" wording only when `context.capturedApiError?.status === 403`. The measured BYO case arrived with **no captured status** — comment at `:306-311`, test at `packages/shared/src/agent/__tests__/claude-sdk-error-mapper.test.ts:364-381`. It used to say "Your Nessy Gateway sign-in is missing or expired" on a connection with no gateway sign-in; T28 narrowed that to the gateway upstream, so today the same case says **"Unable to authenticate. Your API key may be invalid or expired."** (`claude-sdk-error-mapper.ts:334-337`). Still a credential story for a policy refusal. The measured cost of the earlier version of this same mistake is recorded at `:266-270`: "a planner spent an hour hunting a credential bug that did not exist."
2. **codex-runtime.** The adapter's own classifier collapses 403 into auth: `packages/codex-responses-adapter/src/errors.ts:94-105` — `status === 401 || status === 403 || …` → `{ type: 'authentication_error', code: 'invalid_api_key' }`. codex is told the key is bad.
3. **No retry, no fallback.** `packages/codex-responses-adapter/src/retry.ts:75-88` retries only a 400 matching `/model is required/`. A 403 ends the turn.

**Also recorded as unproven, and it bounds the fix:** the plan note at `docs/superpowers/plans/2026-08-17-claude-live-session.md` (row L6) states that "let a connection opt out of the bundled session MCP server" is **NOT proven** to clear the guardrail, "because the recorded 403 body names `mcp__dpGitlab__*` and `mcp__plugin_figma_figma__*` alongside `mcp__session__*`". Anything short of an actual allowlist — i.e. dropping the dp and plugin servers too — is not demonstrated to unblock that path. Release note `apps/electron/resources/release-notes/1.30.0.md:53` says the same thing to users and calls it "a platform-policy question rather than an app fix".

---

## Options table

| # | Option | Anchor | Pi | claude-rt | codex-rt | Effort | Gaps |
|---|---|---|---|---|---|---|---|
| a | Filter the MCP set by connection classification at the capability/pool layer | `storage-runtime.ts:800-820`; `SessionManager.ts:14381`; `base-agent.ts:2452-2460` | ✅ | ✅ | ✅ | **L** — needs a connection field on `CapabilityContext` (`resolver.ts:99-124`), plus a second filter for session tools | Does **not** cover `mcp__session__*` (built by each runtime separately); removes the capability from the UI too, not just the wire; the managed-policy precedent it extends is itself Pi-gated at `:804` and that gate must be removed in the same change |
| b | Strip non-whitelisted tools from the outbound body per host in the Pi interceptor | `unified-network-interceptor.ts:2384-2419`, next to `addMetadataToTools` | ✅ | ❌ | ❌ | **S** — ~20 lines, the body is already parsed and rewritten here | Pi-only by construction (`packages/shared/AGENTS.md`: the interceptor is a Bun `--preload`, unavailable to the Claude SDK's native binary); wire-level masking desynchronizes from history, which is a known live failure mode (`sanitize.ts:15`) |
| c | Narrow the SDK `mcpServers` name-set / `disallowedTools` | `claude-agent.ts:2447-2460`, `:2429`, `:4052-4054` | ❌ | ✅ | ❌ | **S** — a live setter exists, no respawn | claude-runtime only; server-granularity only (cannot express "this server, these tools"); `setMcpServers`'s *result* must be checked, per `:3999` |
| d | Filter tools in the local adapter, scoped by resolved upstream + per-request model | `server.ts:476-560`; `anthropic/inbound.ts:270-291` | ❌ | ✅ | ✅ | **M** — the classification data is already in hand (`opts.upstream`, `raw.model`) | Pi untouched; contradicts `passthrough-negotiation.ts:52-56`, which names `tools` as never-rewritable — needs an explicit, written policy exception |
| b+d | Transport-layer pair | above | ✅ | ✅ | ✅ | **M** | Two implementations of one rule in two languages of the same idea — the exact drift shape `upstream-target.ts:6-9` was created to prevent |

---

## Recommendation

**Do (a) as the policy layer and (d) as the enforcement layer — not (b).**

1. **Land the classifier first, as one shared module, next to `isNessyGatewayBaseUrl`.** `packages/shared/src/agent/backend/internal/drivers/upstream-target.ts` already exists for exactly this reason and says so at `:6-9`: "it lives in one module because the rule it encodes is a governance boundary … and two drivers each carrying their own copy of 'which URL is the gateway' is precisely how such a boundary drifts." Add `isExternalModelEndpoint(connection)` there, reading the admin host list through `network-address-guard.ts`'s existing `managedAllowlist` shape rather than inventing a second list. One predicate, three call sites.

2. **Enforce in the adapter (option d).** It covers the two runtimes where the pain actually is, it is the only layer that sees both the resolved upstream host and the per-request model id, and it is the same choke point that already routes wires per model. Write the policy exception into `passthrough-negotiation.ts`'s doctrine explicitly — this is a filter applied *because* a named policy demands it, not a speculative reshape, and the removal must be observable (that module's own rule at `:341-345`: "a byte we reshape with no record is one nobody can debug").

3. **Add (a) as the source-level narrowing, thread the connection into `CapabilityContext`, and remove the `isPiCapabilityTurn` gate at `storage-runtime.ts:804` in the same change.** That gate is already a latent hole for the managed MCP lists on two runtimes; fixing it is owed regardless, and it is the same edit.

4. **Skip (b) unless Pi→llm-proxy is separately in scope.** It buys the one runtime that is currently *working*, and it duplicates the rule in a second place. If Pi coverage is needed, do it by narrowing the pool (option a) so Pi's `buildCurrentProxyToolDefinitions` (`pi-agent.ts:1818`) sees fewer sources, rather than by masking the wire underneath it.

5. **Independently of the whitelist, fix the two misdiagnoses**, because they are cheap and they are actively costing debugging time: make the adapter classify a 403 as a policy refusal rather than `invalid_api_key` (`errors.ts:94-105`), and make the guardrail body reach `capturedApiError.status` so `claude-sdk-error-mapper.ts:277` actually fires on the BYO path.

6. **State the promise honestly in whatever ships.** With the whitelist in place, the claim is "an external model is not handed tools that act on internal systems". It is not "internal data cannot reach an external model" — `Bash` and the conversation body both defeat that, and isolation is off by default.
# Appendix H — adversarial verification of F and G (full report)

Verified independently against both repos. `nessy-cli` @ `1f9e807cb` (0.13.11-beta.0); `nessy-desktop` @ **`5bd0e0204`**, not the `6c056870f` Report B names — HEAD moved during the session (`docs(plan): T5 closes reviewed — codex bridge security closed at both belts`). I re-derived every B line number at current HEAD; they still land.

# TASK V — adversarial verification

## Part 1 — nessy-cli whitelist: which layer, which predicate

**A1. The constant is 8 MCP *server* names at `packages/core/src/core/openaiContentGenerator/constants.ts:18-27`.** **CONFIRMED.** Read verbatim; `dpJira, dpGitlab, dpWiki, t-tracker, dpFinedog, dpSage, dpAllure, context7`.

**A2. Exactly one read site: `config.ts:3814` inside `isMcpServerAllowedForModel()`.** **CONFIRMED.** `grep -a "EXTERNAL_MODEL_MCP_WHITELIST"` across the repo returns 5 hits: the definition (`constants.ts:18`), the import (`config/config.ts:26`), the use (`config/config.ts:3814`), and two doc lines.

**A3. Three composed predicates at `config.ts:3786-3790 / 3806-3816 / 3819-3824`.** **CONFIRMED**, line-exact. `isMcpServerAllowedForModel` reads:
```ts
const contentGeneratorConfig = this.getContentGeneratorConfig();
if (!contentGeneratorConfig) { return true; }
return (contentGeneratorConfig.internal === true || EXTERNAL_MODEL_MCP_WHITELIST.has(serverName));
```

**A4. Consumers of `isMcpServerAllowed`: `tool-registry.ts:687, 752, 849`, `mcp-client-manager.ts:2733`, `config.ts:3828`.** **CONFIRMED** and complete — those are the only five.

**A5. "It bites at per-request tool-list construction, not connection time."** **CONFIRMED with a correction of emphasis.** The boot fail-open is real and the ordering is verifiable outside the fork author's own comment: non-interactive startup runs `await config.initialize()` at `packages/cli/src/gemini.tsx:1144` and `validateNonInteractiveAuth(...)` only at `:1207`; interactive runs `config.initialize()` from mount at `packages/cli/src/ui/AppContainer.tsx:596` with auth on a separate hook. Discovery starts inside `initialize()` (`config.ts:2194 → discoverAllMcpToolsIncremental`).

**But Report A under-reports the reach.** `isMcpServerDisabled()` (`config.ts:3826-3828`) *includes* the whitelist and is consulted at **connection time** in the discovery loops (`tools/mcp-client-manager.ts:1527, 1548, 1058, 2109`) and on **every resource read** (`:2457`, `:2608` — "Re-check disabled state on every readResource"). So once a model *is* known, the whitelist does gate connection and resource reads, not only declarations. There is also an unmentioned race: `discoverAllMcpToolsIncremental` is still in flight when auth lands, so servers discovered after `refreshAuth` are blocked at connect while servers discovered before are not.

**A6. "`refreshTools()` has exactly two callers, both gated on `prevInternal !== internal`."** **REFUTED in part.** `geminiClient.refreshTools()` is called only at `config.ts:3162` and `:3171` — correct — but `:3162` is **not** gated on the trust boundary:
```ts
const isDpAuthToDpAuth = previousAuthType === AuthType.DP_AUTH && authType === AuthType.DP_AUTH;
const trustBoundaryChanged = prevInternal !== this.contentGeneratorConfig.internal;
if (this.geminiClient?.isInitialized() && (!isDpAuthToDpAuth || trustBoundaryChanged)) {
  await this.geminiClient.refreshTools();
}
```
Any DP_AUTH→USE_OPENAI switch refreshes regardless of `internal`. There is also a *third* `refreshTools` — `extensionManager.refreshTools()` (`packages/core/src/extension/extensionManager.ts:1632`, callers at `:462, :492, :1306, :1440`, `acpAgent.ts:6518`) — which Report A does not mention. The load-bearing half survives: a session that **boots** external is never purged, because `refreshAuth()` calls neither.

**A7. Four unguarded accessors — `ensureTool`, `getAllTools`, `getAllToolNames`, `getMcpServerInstructions`.** **CONFIRMED**, all four read verbatim (`tool-registry.ts:303-332`, `:816-826`, `:805-808`, `:771-773`) with no `isMcpServerAllowed` check, against the three that do have it (`:687`, `:752`, `:849`). The dispatch claim holds: `coreToolScheduler.ts:1804` is `await this.toolRegistry.ensureTool(canonicalName)`, and `mcp-tool.ts` contains no `isMcpServerAllowed`/`isMcpServerDisabled` call anywhere — so an MCP **tool call** has no whitelist gate at any layer, unlike a **resource read**, which has two. `tool-search.ts:194` (`registry.getAllTools()`) and `:223-244` (`getAllToolNames()` → `ensureTool`) confirm both ToolSearch modes reach blocked tools. `scoreTool` reads `tool.description` raw at `tool-search.ts:518`.

**A8. Subagents are handled correctly.** **CONFIRMED** — path is `packages/core/src/agents/runtime/agent-core.ts` (Report A omits `runtime/`), and `:496` / `:521` are `getFunctionDeclarations({ includeDeferred: true })` as claimed; `getContentGeneratorConfig()` resolves through `getRuntimeContentGenerator()?.contentGeneratorConfig ?? this.contentGeneratorConfig` (`config.ts:2797-2802`).

**A9. External = `!modelId.startsWith('tgpt/')`; no authType, no baseUrl.** **CONFIRMED.** `configResolver.ts:231-233`, `models/constants.ts:103`. The override is real: `modelRegistry.ts` returns `{ ...config, …, internal: isInternalModel(config.id), … }` at `:322`, after the spread — so `dpModelsClient.ts:136`'s `internal: backendModel.is_internal` is discarded. The seatbelt asymmetry is real: `config.ts:218` is `authType === AuthType.DP_AUTH && modelInternal === true`; the MCP predicate has no authType leg.

**A10. The "BYO `tgpt/`-prefixed id on an arbitrary baseUrl is internal" bypass.** **CONFIRMED as written, with the pin that limits it also confirmed** — `modelRegistry.ts:92-95` skips user `modelProviders` keyed `dp-auth` ("Skip dp-auth as it uses hard-coded models"), so the bypass yields a model that is `internal` for MCP purposes but reaches its own endpoint on its own Bearer, not the gateway with the dp JWT. It is a **tool-access** bypass, not a credential bypass.

**A11. Doc says "empty array" but 8 entries shipped in the introducing commit.** **CONFIRMED.** `git show dc9122c7a -- .../constants.ts` shows all 8 added in that commit; `docs/fork-patches/external-model-mcp-whitelist.md:26` still reads `(иммутабельный пустой массив)`. Minor over-read: line 11 ("Пустой список = ни одного MCP-инструмента") is a conditional, not a claim about the default — the `:26` correction is the real one.

**A12. Commits `dc9122c7a` / `0be66e22c` / `7dce5a012`.** **CONFIRMED** — all three, with authors, dates (2026-08-17, 2026-08-21, 2026-08-17), and diffstats (14 files +469/−96; 5 files; 3 files +96/−7) matching exactly.

**A13. No test pins any actual whitelist entry.** **CONFIRMED.** `config.test.ts:5399-5461` uses only `first`/`second`; `grep -a` for the eight names across `packages/core/src` + `packages/cli/src` returns the constant, an unrelated `dpAllure` attestation fixture at `environmentContext.test.ts:482-512`, and two comments in `dpBinary.ts:17` / `initializer.ts:47`.

**A14. No knobs.** **CONFIRMED** — module-level `const`, no env read, no setting; `allowedMcpServers` is ANDed at `config.ts:3821-3823`, narrowing only.

**A15. External models still hit the Nestor gateway with the dp JWT; JWT attach is authType-gated not URL-gated.** **CONFIRMED.** `dpModelsClient.ts:141-142` stamps `baseUrl: DEFAULT_NESTOR_BASE_URL` + `envKey: 'DP_AUTH_MODEL_KEY'` on every model regardless of `is_internal`; `provider/nestor.ts:60-62` is `if (authType === AuthType.DP_AUTH && apiKey)` with no baseUrl test; `isNestorProvider` at `:34-46` short-circuits on DP_AUTH and uses `baseUrl.includes('llm-proxy')` — substring, not host. `nestorAuthHeader.ts:24-30` confirmed.

**A16. `LLM_PROXY_BASE_URL` is the `USE_OPENAI` default and uses a separate Bearer.** **CONFIRMED** (`constants.ts:4-5`, `modelRegistry.ts:67-68`).

**A17. No guardrail/tool-stripping handling anywhere in nessy-cli.** **CONFIRMED** — no retry, no downgrade, no anthropic tool suppression.

**A18. The attestation banner and the `7dce5a012` fix scope.** **CONFIRMED.** `environmentContext.ts:28-29` define the delimiters; `truncateDeferredToolDescription` (`:120-136`) splits on `/\r?\n/`, strips a closed prefix span per line, `.find(Boolean)`. It is used only by `formatDeferredToolLine` (`:147-154`) → the two reminders (`:215-229`). `getMcpServerInstructions()` → `buildMcpServerInstructionsReminder` (`:231-252`) injects **every connected server's** instructions with no whitelist check — confirmed unguarded.

---

## Part 2 — do OUR runtimes expose dp MCP tools to llm-proxy models? (the security question)

**B1. Nestor-Token is scoped to the verified gateway URL on the adapter path.** **CONFIRMED, strongly.** `packages/codex-responses-adapter/src/nestor-client.ts:80-108` — `resolveUpstreamRequest` is a three-arm switch; the JWT literally appears only in `case 'nestor'`, whose URL is the compile-time constant `NESTOR_CHAT_URL` (`:22`). `PostChatOptions.jwt` is documented at `:52-58` as "Read ONLY in `kind: 'nestor'` mode; never forwarded to any other upstream." `drivers/upstream-target.ts:34-37` `isNessyGatewayBaseUrl` is normalized **whole-URL equality** with `NESSY_GATEWAY_CHAT_BASE_URL` derived from `NESTOR_CHAT_URL` at `:26`. `attachUpstreamCredential` (`:58-76`) returns early for any non-`openai-compatible` target and throws on a slugless BYO target. `buildClaudeRuntimeUpstream` (`drivers/anthropic.ts:23-31`) throws rather than defaulting to `api.anthropic.com`; `buildCodexRuntimeUpstream` (`drivers/codex.ts:32-37`) falls back to the gateway. Wire router at `drivers/anthropic.ts:67-85`, `if (upstream.kind !== 'openai-compatible') return undefined;` confirmed.

**B2. Nestor-Token scoping on the Pi path, and the prefix-vs-whole-URL asymmetry.** **CONFIRMED, including the asymmetry — and I rate it more serious than "a deliberate divergence".** `unified-network-interceptor.ts:627-628` guards on `urlStr.startsWith(NESTOR_CLI_BASE_PREFIX)` where the constant is `https://code-completion-nestor.tcsbank.ru/api/v1/cli/` (`auth/nestor.ts:1`), and `resolveNestorGatewayJwtForPi` (`pi-agent.ts:265-271`) gates on the same prefix predicate. So a BYO `pi_compat` connection pointed at *any* path under `…/api/v1/cli/` gets (a) the **dp JWT supplied as its apiKey** and (b) its Bearer rewritten to `Nestor-Token`. That contradicts the rule the adapter side quotes from AGENTS.md at `upstream-target.ts:21-24` — "Custom endpoints, even on the same host with a different path, must retain normal provider auth semantics" — and which it explicitly refuses to reuse `isNestorCliBaseUrl` for ("it accepts every path under the CLI prefix"). The cited tests exist and say what Report B says (`unified-network-interceptor.nestor-auth.test.ts:18, 29, 38, 47`; `codex-byo-upstream.test.ts:353, 380`).

**Verdict on the llm-proxy half specifically: CONFIRMED.** `llm-proxy.t-tech.team` fails every guard; only its own `Authorization: Bearer` goes out and dp creds are never read.

**B3. The tool set reaching the model has no connection/model/host input, on all three runtimes.** **CONFIRMED, each independently.**
- Pi: `pi-agent.ts:1785-1836`. Sources come from `this.mcpPool.getProxyToolDefs(slugsForLeaser(...))` at `:1818-1821`; the **only** filter is `piAllowedTools` at `:1825`. `grep -a piAllowedTools` across `packages/` + `apps/` gives exactly one writer: `SessionManager.ts:14846`, `piAllowedTools: provider === 'pi' ? managed.piChildRestrictions?.tools : undefined` — a child/subagent restriction.
- claude-runtime: `claude-agent.ts:2447-2460`, `{ session: getSessionScopedTools(...), ...sourceProxies }`, `sourceProxies` from `createSourceProxyServers` (`:1322-1375`) which iterates `pool.slugsForLeaser` and registers every tool. Native narrowing is the static 4-entry `CLAUDE_SESSION_DISALLOWED_TOOLS` (`:350`).
- codex-runtime: `config-writer.ts:820` and `:833` write `[mcp_servers.session]` / `[mcp_servers.sources]` gated only on `opts.sessionMcp` / `opts.poolMcpUrl`.
- Pool membership: `base-agent.ts:2456-2457` syncs `materialized.mergedMcpServers`; `SessionManager.ts:14381` syncs `mcpServers`. Neither takes a connection.

**B4. The managed MCP policy lapses on Claude/Codex turns.** **CONFIRMED, and the codebase says so in its own words.** `storage-runtime.ts:673` `const isPiCapabilityTurn = context.provider === 'pi'`; `:804` `if (!isPiCapabilityTurn) return true` before the `isManagedMcpServerAllowed` checks; `:785-788` comments *"That gate is why the managed MCP lists lapse on a Claude or Codex turn, and an ORIGIN lock that silently lapses per provider is the 'declared on one path, enforced on another' defect this policy keeps guarding against."* **Report B under-states it**: the *plugin* allowlist lapses identically — `pluginCandidates` filter is `!isPiCapabilityTurn || (isManagedPluginAllowed(...) && …)`. `builtinDpMcpCapabilityRecords` appended after the filter at `:881`, doc at `:617`, confirmed.

**B5. `CapabilityContext` has no connection.** **CONFIRMED** — `capabilities/resolver.ts:99-124` carries `workspaceId, sessionId, memorySessionId, provider, enabledSourceNames, workingDirectory, projectRoot, projectKey, projectTrustState, projectTrustRevision`. No slug, baseUrl, or model.

**B6. No guardrail workaround exists in code.** **CONFIRMED.** `grep -a EXTERNAL_MODEL packages apps` → **0 hits**. Guardrail hits outside tests are 5, all comments or unrelated. `errors.ts:94-105` collapses 401/403 into `{type:'authentication_error', code:'invalid_api_key'}` — confirmed verbatim. `retry.ts:73-91` — the ladder advances only on `response.status === 400` matching `MODEL_REQUIRED`; note the second and third rungs strip `required` and blank tool **descriptions** but keep tool **names**, so the ladder could never clear a name-based guardrail even if it fired. `claude-sdk-error-mapper.ts:261-292` (403 → "Request Refused") and `:306-311` (the T28 narrowing) confirmed exactly.

### B7 — the headline claim: "**Yes.** dp MCP tools are sent to an Anthropic model reached through llm-proxy"

**Mechanism: CONFIRMED. Evidence as cited: REFUTED. Claim as worded: needs three corrections.**

1. **The cited evidence does not contain a single dp tool.** `docs/testing/cdp-runs/2026-08-21-t23-lane-g.md:254-260` — which I read in full — names only `mcp__plugin_figma_figma__*` and `mcp__session__*`, and the document itself says "(2 076 chars, **truncated here at the tool list**)". Report B presents that block as evidence for `mcp__dpJira__*` / `mcp__dpGitlab__*`. It is not.
2. **The correct citation exists elsewhere and it does prove it.** `docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md:1296-1302` records the 403 body as `Invalid tools: mcp__dpGitlab__dp_gitlab_create-merge-request, …, mcp__plugin_figma_figma__download_assets, …, mcp__session__BashOutput, mcp__session__TodoWrite, mcp__session__call_llm, …`. That is a dp tool name echoed back by llm-proxy — proof our array carried it. Report B reached this only second-hand through the L6 plan note.
3. **dp servers are opt-in, and every measured Anthropic-wire turn was refused before inference.** `packages/shared/src/mcp/builtin-dp-servers.ts:113-142` — all 29 entries carry `defaultEnabled: false`, `dpGitlab`/`dpJira`/`dpWiki` included. And every `anthropic/*` turn 403s: `docs/testing/cdp-live-checklist.md`, row `G3-WIRE … FAIL`, `apps/electron/resources/release-notes/1.30.0.md:53` says the guardrail is untouched. The same narrative at `:1310-1315` states *"The guardrail polices `/v1/messages` only"* and that `BYO-QWEN` sent "the SAME full tool surface … over chat-completions to the SAME host with the same key and gets a clean answer"; `CODEX-TURN` PASS 6/6 at `:1291`.

**So the precise, defensible statement is:** with dp servers enabled, our full tool array — dp, plugin, and `mcp__session__*` names, descriptions and JSON schemas — leaves the machine to `llm-proxy.t-tech.team` on all three runtimes, with no filter of any kind, unlogged and unwarned. On the two arms where it is **accepted** (Pi chat-completions, codex Responses) the measured models were `tgpt/qwen…` and codex models. On the one arm that addresses a genuinely third-party model (`anthropic/*` via `/v1/messages`) the proxy refuses before forwarding. **There is no measured case in which our tool array reached a third-party model.** The confirmed egress is to an internal corporate proxy; whether it would leave T-Bank is the platform-policy question the release note names, not a measured fact. Report B's framing ("sent to an Anthropic model") overstates by one hop, and that hop is the whole point of the security decision.

---

## Part 3 — the recommendation's coverage gaps

**B8. Option anchors.** **CONFIRMED**, all of them: `storage-runtime.ts:800-820`; `SessionManager.ts:14381`; `base-agent.ts:2452-2460`; `unified-network-interceptor.ts:2384-2419` (body is parsed at `:2385`, tools rewritten at `:2388` `adapter.addMetadataToTools`, re-serialized at `:2418`); `claude-agent.ts:2447-2460, :2429`; `server.ts` routes `/v1/responses` at `:639` and `/v1/messages` at `:646`, `handleResponses` at `:128`, `handleMessages` at `:474`; `anthropic/inbound.ts:270-291` `toolsToResponses` with the "have no routed equivalent: drop." comment at `:289`. `packages/shared/AGENTS.md:148` confirms the interceptor is Pi-only via Bun `--preload`.

**B9. `passthrough-negotiation.ts:341-345` — "a byte we reshape with no record is one nobody can debug".** **REFUTED as a citation.** The file is **187 lines**. That sentence does not appear in the module at all; `grep -a` finds it only in `docs/superpowers/plans/2026-08-17-claude-live-session.md:165`. The two other citations to that file are right (`:24` "every byte we reshape is a byte we can get wrong"; `:55` "`tools` … are NOT candidates and never will be", with `REMOVABLE_BETA_FIELDS` at `:58`). `:31-38` points at prose, not `findRefusedRemovableFields` (which is at `:123`); the 400-only gate is real but lives at `server.ts:404`.

**B10. Gaps the recommendation does not close.**

- **The classifier is wrong for the case that motivated the work.** Recommendation item 1 proposes `isExternalModelEndpoint(connection)` = gateway ∨ loopback ∨ *admin internal-host list*. `llm-proxy.t-tech.team` **is** an internal T-Bank host; any honest internal-host list admits it, the connection classifies as internal, and the whitelist never fires on the one endpoint every recorded incident involves. §4 hedges ("per-model refinement … layered on top, not the classifier") but the recommendation's own summary keeps it connection-level. nessy-cli got this structurally right and Report A drew the right lesson from it (`Cross-repo note 1`); Report B then proposes the opposite shape. **This is the single most consequential gap.** The classifier has to be per-*model*, and the repo already has the honest signal: `config/models.ts:119-131` `wire?: 'anthropic-messages'`, written only by a probe that got an answer (`model-fetchers/openai-compat.ts:197-226`, `return { verdict: 'ok', wire: 'anthropic-messages' }` at `:218`) — plus the namespaced ids llm-proxy serves.
- **(a)+(d) leaves Pi's `mcp__session__*` unfiltered.** Report B names this inside option (a)'s gap list ("does not cover `mcp__session__*`… a second, per-runtime filter is needed") and then never closes it: item 4 routes Pi coverage through option (a) only, and (d) does not see Pi. Since the recorded 403 names `mcp__session__BashOutput`, `mcp__session__call_llm`, `mcp__session__TodoWrite`, the recommendation as written would not have cleared the measured refusal on the Pi arm.
- **Removing `isPiCapabilityTurn` (item 3) is a larger change than presented.** It would apply `DEFAULT_MANAGED_PI_POLICY` to Claude and Codex turns — MCP *and* plugin *and* hook allowlists (`storage-runtime.ts:886`+) — on a code path that has never run them. Report B mentions only the MCP half.
- **Two Pi-path holes are named but not scheduled.** The prefix-vs-whole-URL divergence (B2) is filed as "worth flagging"; it is the one place a dp JWT can leave the verified URL, and it belongs in the same change as a governance-boundary module, not in a footnote.
- **Correctly identified and correctly qualified:** the "what no whitelist can promise" section (native `Bash`/`Read` unprefixed and out of the pool, isolation off by default, `call_llm`/`spawn_session`/`browser_tool` as outward routes at `pi-agent.ts:275-279`, and the conversation body itself). I found nothing to add and nothing to subtract there — it is the most reliable section of Report B.

---

## Net verdict

**Report A: sound.** Every load-bearing claim confirmed against source, including the four unguarded accessors, the dispatch-path gap at `coreToolScheduler.ts:1804`, the `tgpt/` prefix classifier, the `is_internal` override at `modelRegistry.ts:322`, the doc's wrong "empty array", all three commits, and the no-test-pins-a-real-name gap. Two defects: the `refreshTools` gating description is wrong for `config.ts:3162` (`!isDpAuthToDpAuth || trustBoundaryChanged`, not the trust boundary alone), and it misses `extensionManager.refreshTools()` entirely. One under-report: the whitelist reaches connection time and resource reads through `isMcpServerDisabled`, which is broader than "a per-request tool-list filter" — though tool *calls* remain ungated, which is the finding that matters.

**Report B: mechanism sound, evidence mis-sourced, recommendation partly misaimed.** Every code claim I re-derived holds at current HEAD, line-exact, including the ones that would be easiest to get wrong (`storage-runtime.ts:673/804`, `nestor-client.ts:80-108`, `upstream-target.ts:34-37`, `claude-agent.ts:1920/2447-2460`, `errors.ts:94-105`, `claude-sdk-error-mapper.ts:277`). But the security headline is supported by a quotation that does not contain the thing it is quoted for; the real proof is one file over; the dp servers are opt-in; and no measured turn has put our tool array in front of a third-party model.

### Corrections to carry forward

1. **Cite `docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md:1296-1302`, not `2026-08-21-t23-lane-g.md:254-260`,** for dp-tool exposure. The latter's tool list is explicitly truncated and names no dp tool.
2. **Reword the finding:** "our full tool array reaches `llm-proxy.t-tech.team` unfiltered on all three runtimes when dp servers are enabled (`builtin-dp-servers.ts:113-142`, all `defaultEnabled: false`); the one arm that addresses a third-party model is refused by the proxy before forwarding." Not "sent to an Anthropic model".
3. **`packages/codex-responses-adapter/src/anthropic/passthrough-negotiation.ts:341-345` does not exist** (187-line file). The quoted sentence is from the plan doc, `2026-08-17-claude-live-session.md:165`.
4. **Make the classifier per-model, not per-connection.** An internal-host allowlist admits llm-proxy and nullifies the whole control. Use `ModelDefinition.wire` (`config/models.ts:127-131`) plus the probe verdict, with the connection host as a coarse second signal — the inverse of Report B's §4 ordering, and the shape nessy-cli got right.
5. **Name Pi's `mcp__session__*` as an explicit open item** in the (a)+(d) plan; as written the recommendation would not have cleared the measured 403 on Pi.
6. **Fix `config.ts:3162`'s description** in Report A: not gated on the trust boundary; add `extensionManager.refreshTools()` (`extensionManager.ts:1632`) to the caller list.
7. **Promote the Pi prefix-match divergence** (`unified-network-interceptor.ts:628`, `auth/nestor.ts:4-6`, `pi-agent.ts:265-271`) from a flag to a scheduled row — it is the only path on which a dp JWT can leave the whole-URL boundary that `upstream-target.ts:21-24` declares governing.
8. **Note that the *plugin* managed allowlist lapses on Claude/Codex identically** to the MCP one (`storage-runtime.ts:804` gates both), and that removing that gate applies the full Pi managed policy to two runtimes that have never run it.
9. **Report B's HEAD is stale** — `6c056870f` vs actual `5bd0e0204`; re-anchor before quoting.
# Appendix I — 401-on-latest-release diagnosis (2026-08-23, full report)

## TASK D2 — diagnosis

### 0. What is proven vs. inferred

| Claim | Status |
| --- | --- |
| Both UI strings are emitted by the **Claude runtime**, not Pi | **PROVEN** (§1) |
| The user's `~/.nessy/dp_auth_creds.json` (450 B) holds a healthy 3-segment JWT | **PROVEN by byte arithmetic** (§4) |
| At 1.31.0 a `claude-runtime` session **in gateway mode** cannot put a non-3-segment/empty `Nestor-Token` on the wire | **PROVEN** (§2) |
| Therefore the failing request was **not** a gateway-mode claude-runtime turn | **follows** (§2, §5) |
| The installed binary contains all three 1.30.1 guards + the format strings | **PROVEN on the packaged app** (§3) |

---

### 1. Which runtime emits `Provider error — retry 3/3 in 2s`

Both adapters can render that shape, so the format string alone does **not** pin it. Reproducing each literally:

- Pi — `packages/shared/src/agent/backend/pi/event-adapter.ts:930-939` (released):
  ```
  const attempts = `retry ${retryEvent.attempt}/${retryEvent.maxAttempts} in ${seconds}s`;
  … : `Provider error — ${attempts}`,
  ```
- Claude — `packages/shared/src/agent/backend/claude/event-adapter.ts:236-252`: `parts = ["retry 3/3", "in 2s"]` → `suffix = " — retry 3/3 in 2s"` → `Provider error — retry 3/3 in 2s`.

**The ladders discriminate them, and only Claude can produce `3/3 … 2s`:**

- Pi's delay is `policy.baseDelayMs * 2 ** (attempt - 1)` (`node_modules/@earendil-works/pi-ai/dist/utils/retry.js:139`), and `packages/pi-agent-server/src/gateway-retry-settings.ts:14,20` fixes the two policies:
  - gateway session → `{maxRetries: 5, baseDelayMs: 15_000}` → `retry N/5 in 15s|30s|60s|120s|240s`
  - non-gateway → `{maxRetries: 3, baseDelayMs: 2_000}` → `retry 1/3 in 2s`, `2/3 in 4s`, **`3/3 in 8s`**

  Pi can print `… in 2s` only at **attempt 1**. `3/3 in 2s` is unreachable for Pi.
- Claude: `packages/shared/src/agent/options.ts:336,344` sets `CLAUDE_CODE_MAX_RETRIES = String(INTERACTIVE_MAX_RETRIES)` with `INTERACTIVE_MAX_RETRIES = 3` ("Three, not the SDK's ten"). The SDK's own backoff, read out of the shipped binary, is
  `calculateDefaultRetryTimeoutMillis(e,t){let o=t-e,i=Math.min(0.5*Math.pow(2,o),8),s=1-Math.random()*0.25;return i*s*1000}`
  → attempt 1 = 0.5 s, attempt 2 = 1 s, **attempt 3 = 2 s × (0.75–1.0) → `Math.round(…/1000) = 2`**.

  `retry 3/3 in 2s` is the **exact, and only, terminal rung of the Claude runtime's ladder.**

**The red row confirms it independently.** `Failed to authenticate.` and `API Error` exist nowhere in our TypeScript, nowhere in `@earendil-works/*`, and nowhere in the SDK's JS — only in the Claude native binary:

```
…return ed({error:"authentication_failed",content: bn() ? `Failed to authenticate. ${Uv}: ${i}` : `Please run /login \xB7 ${Uv}: ${i}`})
Uv="API Error"
```
(`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, also present at `Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude`, 8 hits.)

**Runtime pinned: `claude-runtime`.** The spinner is *not* the 401 — the Anthropic SDK's `shouldRetry` retries 401 only for its OAuth token-cache; the 3 retries are a retryable error (adapter 502 / connection error), and the 401 lands afterwards.

---

### 2. Every path that can put a non-3-segment or empty `Nestor-Token` on the wire, at 1.31.0

**`claude-runtime`, gateway mode — none. Proven closed:**

- `packages/shared/src/agent/claude-agent.ts:1886` — `handle = await startAdapter({ upstream, ...(upstreamForModel ? { upstreamForModel } : {}) })`. **No `jwt` key is passed.**
- `packages/codex-responses-adapter/src/server.ts:122-125` — `resolveGatewayJwt` runs **per request** (called from `handleResponses:130` and `handleMessages:480`): `const gatewayJwt = opts.jwt !== undefined ? opts.jwt : readNestorJwt();` — with `opts.jwt === undefined` this always re-reads the file.
- `packages/codex-responses-adapter/src/nestor-auth.ts:24-31` — `readNestorJwt` returns the value **only if `isJwtShaped`**, else `null`.
- `null` → `{ok:false}` → the adapter answers its **own** 401 with `NO_CREDENTIALS = 'Nessy Gateway credentials not found (~/.nessy/dp_auth_creds.json)'` (`server.ts:110,484`).

So `'Nestor-Token': jwt ?? ''` (`nestor-client.ts:85`) is unreachable with an empty value on this path. There is **no per-turn caching and no stored-snapshot fallback** in the Claude gateway path.

**`claude-runtime`, non-gateway classification — this *is* the hole.** `buildClaudeRuntimeUpstream` (`internal/drivers/anthropic.ts:23-31`) uses `isNessyGatewayBaseUrl`, a **whole-URL** match (`internal/drivers/upstream-target.ts:34-37`) against `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1`. Any other URL — **including one on the same gateway host with a different path** — becomes `{kind:'openai-compatible'}`, and `attachUpstreamCredential` (`upstream-target.ts:62-78`) attaches `Authorization: Bearer <getLlmApiKey(slug)>`. The gateway ignores `Authorization`, sees **no `Nestor-Token` at all**, and answers exactly `fail parse token claims: … invalid number of segments`. Note the deliberate asymmetry: Pi's `isNestorCliBaseUrl` is a **prefix** match (`packages/shared/src/auth/nestor.ts:4-6`), so the same URL variant keeps working on the Pi card and silently loses the token on the Claude card.

**Direct `anthropic` provider at the gateway URL.** `postInit` (`claude-agent.ts:1826-1831`) only takes the adapter branch for `providerType === 'claude-runtime'`; anything `isAnthropicProvider` goes through `resolveAuthEnvVars`, which sets `envVars.ANTHROPIC_BASE_URL = connection.baseUrl` (`packages/shared/src/config/llm-connections.ts:1189`). A hand-made "Anthropic + custom endpoint" connection pointing at the gateway makes the SDK talk to the gateway **directly** — no `Nestor-Token`, same 401.

**Pi (for completeness, ruled out as the emitter).** `getPiAuth` (`pi-agent.ts:2320-2342`) tries `getNestorGatewayJwt()` → `resolveNestorGatewayJwtForPi` → `getValidCreds()` (shape+expiry guarded, `auth/dp/creds-store.ts:62-66`), and **falls through UNGUARDED to `credentialManager.getLlmApiKey(slug)`**. It is resolved **once**, at spawn (`pi-agent.ts:1597`), and shipped in the init `piAuth` field; `refreshAndPushTokens` only re-pushes for `authType === 'oauth'`, so a gateway Pi session never gets a mid-life token update.
**`attemptAuthRetry` DOES dispose the agent** — `strictDrainPiSession` / `disposeManagedAgentRuntime`, then `if (managed.agent) throw new Error('auth-retry-agent-disposal-incomplete')` (`SessionManager.ts:20541-20551`) — so the replacement agent's `postInit` re-resolves `piAuth`. **"auth-retry must re-resolve piAuth into the live subprocess" is NOT a real gap**; the real residues are that it fires once per message (`authRetryAttempted`, `:20506`) and that its `forceRefresh` can be swallowed by the single-flight.

**Raw vs. wrapped — the surface discriminator.** Three different bodies reach the SDK, and they are textually distinct:

| Path | What the Claude CLI renders after `Failed to authenticate. API Error: 401 ` |
| --- | --- |
| gateway-mode creds gate | `{"type":"error","error":{…"message":"Nessy Gateway credentials not found (~/.nessy/dp_auth_creds.json)"}}` |
| adapter translation path (`handleMessages`, `server.ts:558-562`) | `{"type":"error","error":{…"message":"upstream error 401: {\"error\":\"fail parse token claims…\"}"}}` |
| `pipeAnthropicPassthrough` (`server.ts:428-437`) **or a direct `anthropic` connection** | `{"error":"fail parse token claims: …"}` — **raw gateway bytes, unwrapped** |

The reporter's transcription is the **raw** form. `readNestorJwt` therefore does **not** identify the Pi path (Pi never produces `Failed to authenticate.`); the raw body identifies a request that **bypassed the translating adapter**.

---

### 3. The installed release build

`/Applications/Nessy Desktop.app` — inspected read-only; `Contents/Resources/app` is unpacked (no asar).

- **(a) version** — `Contents/Info.plist` `CFBundleShortVersionString = 1.31.0`; `Contents/Resources/app/package.json` `"version": "1.31.0"`; feed `channel: dev`, `nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac`.
- **(b) guards present** — in `dist/main.cjs`:
  ```js
  function isJwtShaped(value) { const parts = value.split("."); return parts.length === 3 && parts.every((part) => part.length > 0); }
  function getValidCreds(credsPath = getCredsPath()) { const creds = loadCreds(credsPath); if (!creds || creds.expiresAt <= Date.now()) return null; return isJwtShaped(creds.jwt) ? creds : null; }
  function readNestorJwt(credsPath = defaultCredsPath()) { … return typeof raw.jwt === "string" && isJwtShaped2(raw.jwt) ? raw.jwt : null; … }
  ```
  (`isJwtShaped` 436 occurrences of the identifier; the cycle-avoiding duplicate ships as `isJwtShaped2`.)
- **(c) format strings present** — `` `Provider error \u2014 ${attempts}` ``, `` `Provider error${suffix}` ``, and the SessionManager sniffer `startsWith("Rate limited") || startsWith("Provider error") || startsWith("Retry succeeded") ? "retrying"`. Also `INTERACTIVE_MAX_RETRIES = 3` and `applyInteractiveRetryCeiling` are in the bundle — **the user's binary really does cap Claude at 3 retries**.
- **(d) Pi snapshot fallback shipped verbatim** — `dist/main.cjs:401792-401808`: `const gatewayJwt = this.getNestorGatewayJwt(); if (gatewayJwt) {…} const apiKey = await credentialManager.getLlmApiKey(slug); if (apiKey) { … credential: { type: "api_key", key: apiKey } }` — unguarded, exactly as at HEAD.
- Pi retry policy shipped in `Contents/Resources/app/resources/pi-agent-server/index.js`: `baseDelayMs * 2 ** (attempt - 1)`, `maxRetries: 5, baseDelayMs` and `maxRetries: 3, baseDelayMs` — confirming §1's ladders on the user's binary.

*Caveat:* this is the install on **this** machine. Its version string and content match `0a4a5d8b8`; it is not proof the reporter runs the same build (see R5).

---

### 4. Byte-size discriminator — the user's files are healthy

Calibrated against this machine's own files (values never read; lengths/segment counts only):

| File | this machine | jwt/access_token | segments | username |
| --- | --- | --- | --- | --- |
| `dp_auth_creds.json` | **452 B**, 0600 | len 325 | 3 `[36,244,43]` | 12 (`i.i.gavrikov`) |
| `oauth_creds.json` | **407 B**, 0600 | len 325 | 3 `[36,244,43]` | — (`token_type` len 6) |

Structural overhead of our writer (`JSON.stringify(merged, null, 2)`, 13-digit `expiresAt`, 36-char uuid `userId`) = **115 B**; nessy-cli's `{access_token, expiry_date, token_type:"Bearer"}` at 2-space = **76 B + 6**.

Applied to the reporter's machine (`username = "ki.nikolaev"`, 11 chars):

- `dp_auth_creds.json`: `115 + jwt + 11 = 450` → **jwt = 324 chars**
- `oauth_creds.json`: `76 + 6 + access_token = 406` → **access_token = 324 chars**

Both numbers close **exactly**, on the same 324-char token, one char shorter than ours precisely because `ki.nikolaev` is one char shorter than `i.i.gavrikov` inside the `preferred_username` claim. Conclusion:

- **450 B is a valid-shaped `dp_auth_creds.json`** carrying a full 3-segment Nestor JWT. An Ory-opaque garbage file would be ≈ **176 B** (115 + ~50 + 11) — not remotely 450.
- **406 B is exactly consistent** with nessy-cli's oauth shape holding the *same* JWT.

**The creds file is not the problem.** It was also written by a validating writer: both `saveCreds` call sites run `decodeJwtClaims` first (`auth/dp/index.ts:157-163` seed path, `:206-215` exchange path), so a file written at Aug 21 10:02 provably held a decodable 3-segment JWT.

---

### 5. Ranked root causes, with one discriminator each

**R1 — The failing Claude session is not on the gateway card's exact URL (BYO-classified, or a direct `anthropic` custom-endpoint connection at the gateway host). No `Nestor-Token` ever rides the request.**
*Evidence:* the only 1.31.0 paths that produce this gateway string with a healthy creds file (§2); the **raw, unwrapped** body in the screenshot is producible only outside the translating adapter; permanent, and immune to any key the user supplies — which is exactly "401 loop **with keys present**". Note `canEditLlmConnection` hides the edit form for exact-gateway connections, so this requires a **hand-made** connection (the BYO endpoint form shipped in C3) — that is the prior that keeps this from being a certainty.
*Discriminator (UI):* open Settings → Connections, select the Claude connection that fails, and read **providerType + Base URL**. Anything other than `providerType: claude-runtime` **and** base URL exactly `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1` (trailing slash ok, nothing else) confirms R1. Secondary: whether the error text contains `upstream error 401:` (BYO claude-runtime) or not (direct `anthropic`).

**R2 — Stale in-process state on an app never restarted since the Aug 21 10:02 heal.**
*Evidence:* reconciles the timeline. `attemptAuthRetry` fires **once per message** (`SessionManager.ts:20506`); its forced re-mint goes through `ensureNessyGatewayAuth`, whose single-flight `if (inflight) return inflight` (`auth/dp/index.ts:88-93`) hands a `forceRefresh:true` caller the **warm** result — the option's own comment concedes this. A Pi session additionally freezes `piAuth` at spawn. All of this dissolves on restart.
*Discriminator (UI):* fully quit and relaunch Nessy Desktop, start a **brand-new** session on the Claude Code (Nessy Gateway) card, send one message. If it succeeds, the residue was in-process.

**R3 — The red row is scrollback from before the heal; the live spinner is a different, retryable failure.**
*Evidence:* `Provider error — retry 3/3 in 2s` is **not** a 401 status line (§1) — the Anthropic SDK does not retry a plain 401. Error messages are persisted into the transcript (`SessionManager.ts:22225-22232`).
*Discriminator (UI):* check the timestamp on the red row. If it predates Aug 21 10:02, it is history, and the live problem is a 502/connection failure, not auth.

**R4 — The stored connection-key snapshot is stale/garbage and is still used on gateway-host requests.** `credentialManager.getLlmApiKey(slug)` is the snapshot written at sign-in and never rewritten on re-mint. It reaches the wire through Pi's unguarded fallback (`pi-agent.ts:2335-2341`), through `attachUpstreamCredential` on a BYO-classified gateway-host connection, and — as a literal `Nestor-Token` — through `model-fetchers/nestor.ts:46` (`'Nestor-Token': credentials.apiKey ?? ''`, which reproduces "invalid number of segments" verbatim when empty).
*Not the red row:* that fetcher throws `Nestor models fetch failed: ${res.status}` (`nestor.ts:50`) and never surfaces the gateway body.
*Discriminator (command, no values printed):*
`security find-generic-password -s "<nessy service>" -a "<slug>" -w | awk '{print length($0), gsub(/\./,".")}'` — or simply: click **Sign in** on the card and see whether the models list refreshes. A models list that refuses to refresh while turns work (or vice versa) isolates the snapshot.

**R5 — The reporter is not actually on 1.31.0.** Every guard in §3 arrived in 1.30.1/1.31.0. On an older build the classic garbage-token loop is live and `dp_latest` seeding is absent.
*Discriminator (UI):* About / title bar version, and `ls -la "/Applications/Nessy Desktop.app/Contents/Resources/app/package.json"` mtime.

**R6 — `dp` is stuck at an old version and cannot self-update.** The reported `dp update` failure is an EACCES on `/usr/local/bin/dp` — the corp binary is root-owned. The *version floor is warn-only* (`dp-binary.ts:24` "Minimum dp version we warn below (warn-only per 00-context decision 5)"; `getDpVersion` "never throws; the version check is advisory only"), so this does **not** block the token exchange — but it does break the dp MCP servers, and every failure of the forced re-mint is swallowed at `SessionManager.ts:9349-9351` (`// best-effort — the retry itself reports the real failure`), so the user sees a 401 and never a reason.
*Discriminator (command):* `dp version` and `~/.nessy/dp_latest/dp version` side by side; then `ls -l $(command -v dp)` to confirm the owner. Also `dp print-token >/dev/null; echo $?`.

---

### 6. Immediate user remediation, in order

1. **Read the connection.** Settings → Connections → the failing Claude entry. Confirm `providerType = claude-runtime` and base URL exactly `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1`. If it is anything else, **delete it and re-create it from the one-click "Claude Code (Nessy Gateway)" card** — a hand-made connection on that host cannot carry the corp token by design. *(fixes R1)*
2. **Quit the app completely and relaunch**, then start a **new** session (not a resumed one) and send one message. *(fixes R2; also clears a Pi session's frozen `piAuth`)*
3. **Check the red row's timestamp** before treating it as current. *(rules out R3)*
4. **Click Sign in** on the gateway card once, even though creds look fine — it forces a re-mint and rewrites the stored snapshot. *(mitigates R4)*
5. **Confirm the app version is 1.31.0.** If not, update first; nothing below 1.31.0 has the shape guards. *(rules out R5)*
6. **Do not fight `dp update`.** It fails because `/usr/local/bin/dp` is root-owned; that is corp-IT's to fix and it does not block the token exchange. If the dp **MCP** servers are also failing, that is the symptom it does explain. *(R6)*
7. **Do not hand-edit or delete `~/.nessy/dp_auth_creds.json`** — §4 shows it is healthy, and deleting it forces an interactive re-login for no benefit.

---

### 7. Plan-row mapping — `docs/superpowers/plans/2026-08-22-dp-auth-wave2-and-mcp-exposure.md`

| Cause | Existing row | Verdict |
| --- | --- | --- |
| R2 single-flight swallows `forceRefresh` | **T1** | covers it exactly; the row already calls the current comment "measured false within a turn" |
| R4 Pi unguarded stored-snapshot fallback | **T2** | covers `pi-agent.ts:2335-2341`; fails closed rather than refreshing |
| R4 model fetcher's `?? ''` | **T3** | covers `model-fetchers/nestor.ts:46` verbatim |
| R6 silent re-mint failure | **T4** | covers the swallowing catch at `SessionManager.ts:9349` |
| R6 unusable system dp | **T6** | **partial** — DP-1 restricts the managed-dp fallback to `DpNotFound` only |
| §2 `opts.jwt` guard bypass | **T7** | covers the seam; the two production call sites indeed pass no `jwt` (verified) |
| R1 gateway-host BYO misclassification | — | **NOT COVERED** |
| `readNestorJwt` ignores expiry | — | **NOT COVERED** |

**New rows the plan lacks:**

- **N1 — "A gateway-host endpoint that is not the gateway URL must say so."** A `claude-runtime` / `codex-runtime` / `pi_compat` connection whose `baseUrl` is on `code-completion-nestor.tcsbank.ru` but fails `isNessyGatewayBaseUrl`'s whole-URL match silently drops `Nestor-Token` and reports the gateway's parse error as the user's credential problem. The whole-URL scope is a deliberate governance boundary (`upstream-target.ts:13-25`) and must **not** be widened — the row is a **detector + honest UI line** at connection-setup and at the 401 card ("this endpoint is on the corp gateway host but is not the gateway URL; corp tokens are not attached to it"). Also worth pinning the Pi-prefix vs adapter-whole-URL asymmetry (`auth/nestor.ts:4-6` vs `upstream-target.ts:34-37`) in a test so it stays intentional. *Related to but distinct from T10.*
- **N2 — `readNestorJwt` must honor `expiresAt`.** `packages/codex-responses-adapter/src/nestor-auth.ts:24-31` checks shape only, while `getValidCreds` checks shape **and** expiry (`creds-store.ts:62-66`). The Claude/Codex adapters will therefore post an expired-but-shaped JWT indefinitely; only the one-shot `attemptAuthRetry` ever re-mints. Add the expiry check plus a gate 401 distinct from `NO_CREDENTIALS` ("gateway credentials expired") so T4 has a code to render. (Package must stay dependency-free — duplicate the check with the existing cycle-avoidance comment.)
- **N3 — managed-dp fallback on an *unusable* system dp, not only an absent one** (owner amendment to DP-1). The reported machine is exactly this shape: a system dp that exists, cannot self-update (root-owned `/usr/local/bin/dp`), and a newer `~/.nessy/dp_latest/` sitting unused. T6 as written will not fire.
- **N4 — stop shipping a stale credential snapshot, or refresh it.** `getLlmApiKey(slug)` on a gateway connection is a sign-in-time snapshot that no re-mint rewrites. T2 and T3 remove two consumers; `attachUpstreamCredential` (`upstream-target.ts:62-78`) remains. Either rewrite the connection credential inside the `saveCreds` success path, or stop storing a JWT under the connection at all.

**Explicitly not a new row:** "auth-retry must re-resolve `piAuth` into the live subprocess." `attemptAuthRetry` already disposes the agent and asserts disposal before resending (`SessionManager.ts:20541-20551`), so the replacement `postInit` re-reads creds. The real defects there are T1 (swallowed `forceRefresh`) and the once-per-message `authRetryAttempted` cap.
# Appendix J — managed dp binary design (2026-08-23, full report)

I have everything. Here is the deliverable.

---

# TASK M — Managed dp binary: design

## 1. Live facts measured on this machine (2026-08-23)

**System dp and why it cannot self-update**

| Fact | Value |
| --- | --- |
| `/usr/local/bin/dp` | `-rwxrwxrwx@ 1 root wheel 23946864 Aug 22 20:25` (regular file, not a symlink) |
| `dp version` | `Spirit CLI Version: 13.39.0 prod (darwin_amd64) Build: 7ebb1dd (2026-08-21T12:47:46Z)` |
| `/usr/local/bin` | `drwxr-xr-x 61 root wheel`, no ACLs (`ls -lde`) |
| `test -w /usr/local/bin` | **false** (user `i.i.gavrikov`) |
| `test -w /usr/local/bin/dp` | true (file is 0777) |

**Mechanism confirmed** (I did not run `dp update`, per instructions): replacing a binary by `rename()` requires write on the **directory**, not the file. The file's 0777 mode is irrelevant. `/usr/local/bin` is root-owned and not group/other-writable, so `dp update` can never replace the system copy for a non-root user — and no `chmod` on the file fixes it. This is **structural and permanent** on an MDM-managed machine, not a transient failure. The mtime (Aug 22 20:25, owner root, size exactly equal to the 13.39.0 S3 asset — see below) shows the corp channel replaces it out from under the user.

**What a dp workdir holds** — `~/.dp` (`drwxr--r--`), names/sizes/mtimes only:

```
access_token.json       488B   Aug 23 01:46   keys: ['tokens']
artifactory_token.json  601B   Aug  1 12:39
cache_version.json    29887B   Aug 23 01:46   keys: ['core','plugins','timestamp']
config.json            2318B   Aug 17 20:49   keys: ['plugins']  → 14 entries
dp.lock / lock / refresh.lock   0B
sa_cred.json           2027B   Jun  8 14:38
plugins/               14 binaries (gitlab 11 MB, jira 8.9 MB, …)
tmp/
version.json            293B   Feb 17 2025
```

- `config.json.plugins` is the **plugin registry**: `{version, file_path, installed}` per plugin, `file_path` **absolute** → `/Users/…/.dp/plugins/<name>`.
- `version.json` is the only version-stamped file: `{version: '12.6.2', timestamp: '2025-02-17', files: {darwin|linux|windows → https://devplatform.tcsbank.ru/cli/prod/dp/12.6.2/<plat>/dp}}`. It is dp's **own update-manifest cache**, on a *different host* from nessy-cli's pin prefix — and it is 18 months stale while the binary is at 13.39.0, consistent with `dp update` never having succeeded here. It is **not** a state-format stamp.
- Measured negative: `dp version` did **not** mutate the state root (before/after mtimes identical on `access_token.json`, `cache_version.json`, `version.json`). The 01:46:53 refresh came from the running `dp ai mcp` servers. So token refresh writes the state root; a version probe does not.

**nessy-cli's isolated workdir** — `~/.nessy/dp_latest` (`drwx------`):

```
dp                  23352224B  Jul 12 11:23  mode 0777  md5 fd0b7b37e20cdec94d2168ae7c6b2aff
access_token.json         488B  Jul 12 11:22
cache_version.json      26223B  Jul 12 11:22
.last_update_check         13B  Jul 12 11:23  ("1783844599839" ≈ 2026-07-12)
lock                        0B
plugins/                 EMPTY
(no config.json)
```

Two consequences, both measured:
1. **`DP_WORKDIR` relocates the entire state root** — token, cache, plugin registry **and** plugin binaries. An isolated workdir starts with **zero plugins installed**. nessy-cli's own `dp_latest/plugins` is empty and it has no `config.json` at all.
2. Its md5 `fd0b7b37…` ≠ the pinned darwin md5 `f1ec83b38b77dc43d2cccfcda0e6215c` (`nessy-cli/packages/core/src/dp/dpConfig.ts:38`) → it self-updated past the pin, exactly as their doc predicts.

**Download endpoint** (`buildDpDownloadUrl`, `dpConfig.ts:61-73`, prefix `dpConfig.ts:33-34`):

- **`HEAD` → 404 on every version tried** (13.14.1, 13.39.0, 99.99.99; `content-type: application/json`, 144 B, `server: istio-envoy`). The route serves **GET only**. A liveness probe must be a ranged GET.
- `GET .../api/v2/download/dp/13.14.1/darwin/dp` with `Range: bytes=0-511` → **`206`**, `content-range: bytes 0-511/22314736`, `host: spirit-core-cli-releases.s3-msk.tinkoff.ru`, `accept-ranges: bytes`, `etag: "f1ec83b38b77dc43d2cccfcda0e6215c"`, `x-amz-meta-s3cmd-attrs: md5:f1ec83b38b77dc43d2cccfcda0e6215c`. First bytes: `Mach-O 64-bit executable x86_64`. **Their pinned md5 is literally the S3 object's md5, advertised in the ETag.**
- `GET .../13.39.0/darwin/dp` → `206`, `content-range: bytes 0-63/23946864` (**= the system dp's exact size**), `etag: "6a3cafa6c90b78ae6d27c9639dd0b24d-5"` — a **multipart** ETag, which is *not* any file hash — and **no** `x-amz-meta-s3cmd-attrs`. So the ETag-as-pin shortcut works for some objects and not others.
- **Arbitrary versions are served**, including the newest. We are not stuck pinning 13.14.1.
- **No arm64 asset**: `darwin-arm64`, `darwin_arm64`, `darwin/arm64` all 404 (xml). Only `darwin` = x86_64. This machine is `arm64` → every dp here runs under Rosetta 2.
- Rate-limit headers present: `x-ratelimit-limit: 500`, `x-rate-key: spirit-core-cli-releases`.

**macOS execution surface**: `xattr -l ~/.nessy/dp_latest/dp` → only `com.apple.provenance`, **no `com.apple.quarantine`** (same for the system copy). `codesign -dv` → *"code object is not signed at all"*. An unsigned, unquarantined, runtime-written binary executes fine — field-proven by nessy-cli's copy.

## 2. nessy-cli's portable lifecycle contract (extracted)

| Element | Where | Contract |
| --- | --- | --- |
| URL pattern | `dpConfig.ts:61-73` | `<prefix>/<version>/{windows,linux,darwin}/{dp,dp.exe}`; prefix `dpConfig.ts:33-34` |
| Pin scheme | `dpConfig.ts:35-39` | one hardcoded **md5 per platform**, valid only for `DP_CONFIG.version` (`:18`) |
| Atomic install | `dpDownloader.ts:108-129` | download → `<target>.download-<pid>` beside target → `verifyChecksum` → `chmod 0o700` → **run `--version`** → `rename`. Any failure `rm -f`s the temp. Order is load-bearing: exec bit before the run, else EACCES (`:105-107`) |
| Mode | `dpConfig.ts:31-32` | `binaryMode: 0o700`; folder `mkdirSync({recursive, mode: 0o700})` (`dpDownloader.ts:66`) |
| Liveness | `dpDownloader.ts:137-156` | `execFile(bin, ['--version'])` matched against `/Spirit CLI Version: (\d+\.\d+\.\d+)/`, 15 s timeout; EACCES/ENOEXEC/ETXTBSY/timeout all ⇒ "not usable". **Deliberately not the checksum** — see below |
| Checksum scope | `dpDownloader.ts:99-103` + `docs/fork-patches/dp-binary-lifecycle.md:20-24` | the pin applies **only to a freshly downloaded file**; after `dp update` the binary self-updates and the pinned md5 is inapplicable *by construction* |
| Single-flight | `dpDownloader.ts:33,48-58`; `dpUpdater.ts:17,34-44` | one module-scope inflight promise each, cleared in `finally`. Explicitly **per-process** ("running two `dp update` processes over the same file would race for the binary being replaced", `dpUpdater.ts:29-31`) |
| Update-on-start | `dpUpdater.ts:46-67` | `dp update` with `DP_WORKDIR=<folder>`, 5 min timeout, **never throws**, returns a boolean |
| AIDT-7488 fix | `8360cb4b4` "retry dp update without reinstalling binary" | **before**: a failed `dp update` was treated as corruption → `installFreshBinary()` → retry. **after**: `if (!(await tryAsyncDpUpdate())) await tryAsyncDpUpdate();` (`dpDownloader.ts:79-84`) — retry once, **never replace a runnable binary with the older pinned version**, because an update failure is usually transient network |
| removeDp + retry | `dpDownloader.ts:87-95`, `dpAuthManager.ts:20-36` | `prepareAuth()` = `ensureDpPresence()`, on throw `removeDp()` then one retry, then rethrow |
| `DP_WORKDIR` isolation | `dpConfig.ts:19-20,76-79`; env built in `dpApi.ts:18-24`, `dpUpdater.ts:57-59`, `dpDownloader.ts:143-146` | every dp exec carries `DP_WORKDIR=<NESSY_HOME>/dp_latest` |
| Startup binding | `packages/cli/src/core/dpBinary.ts:25-32` | `ensureDpBinary()` runs on **every** startup regardless of auth type, because bundled dp MCP servers spawn the binary from `config.initialize()`; **never throws** |
| Why not auth-bound | `dpBinary.ts:16-20`, fork doc `:32-36` | forced auth returns early on cached creds, which live outside `dp_latest/` — a machine with saved auth and no binary had MCP servers dying on `ENOENT` |
| `execFile` not `exec` | fork doc `:38-40` | the path was unescaped; a `NESSY_HOME` with a space broke the command |

**No recorded rationale for the workdir isolation.** `dp-binary-lifecycle.md` never mentions `DP_WORKDIR`; the workdir predates that patch (`f3c96e7e1 feat[AIDT-6172]: auto-update dp CLI and route MCP dp commands to bundled binary`) and `dpConfig.ts:19-20` merely names it. The structural reason is visible: they put the **binary inside the workdir**, and `DP_WORKDIR` makes a self-updating copy self-contained. The session isolation is a **side effect** — and a costly one: a second, separately-expiring session plus an empty `plugins/`.

## 3. Recommended design

### a. Seam — confirmed, but it must widen

`packages/shared/src/auth/dp/dp-binary.ts:46-68` carries the comment verbatim at `:54-55`:

> `ponytail: single seam — a managed download can replace this body later; callers never change.`

The premise is **half true**. Four production callers take the path — `session-broker.ts:66`, `runtime-resolver.ts:282`, `builtin-dp-servers.ts:235`, re-export `index.ts:25` — but the *workdir* is resolved independently by `resolveDpStateRoot()` (`dp-runtime.ts:28-49`), which reads `process.env.DP_WORKDIR` and otherwise returns `~/.dp`. A managed binary that needs a different workdir cannot be expressed through a `string` return, and two callers deriving the pair separately is exactly how they drift.

Worse, `dp-api.ts:41-45` (`printToken`) passes `env: { ...process.env, DP_NO_WARNINGS: 'true' }` — **no `DP_WORKDIR` at all**. Fine today (system dp + inherited env), wrong the moment the binary changes.

**Design:** widen to one record, keep the seam count at one.

```ts
export interface DpRuntime {
  dpPath: string;
  /** DP_WORKDIR for every exec and every MCP spawn; undefined ⇒ dp's default ~/.dp */
  workdir?: string;
  source: 'env' | 'system' | 'managed' | 'nessy-cli';
}
export function resolveDpRuntime(opts?): DpRuntime   // sync, filesystem-only, NEVER execs
export function resolveDpBinary(opts?): string       // kept as a thin wrapper (test callers)
```

**Two invariants to preserve loudly:**
1. `resolveDpRuntime()` **must stay synchronous and must never exec** — `builtin-dp-servers.ts:14-19` states it as a module contract ("It never runs `dp`… a machine without dp degrades to a named diagnostic instead of a crash or a hang"), and three test files depend on it (`builtin-dp-servers.test.ts:223-227`, `runtime-pool-servers.test.ts:2224`, `workspace-mcp-pool-registry.test.ts:1120`). The download therefore lives in a **separate async provisioner**, never inside the resolver.
2. `resolveDpStateRoot()` keeps its job (host env → `~/.dp`, refusing `/` and HOME), but the *callers that spawn dp* must take the workdir from `resolveDpRuntime()`, not call it independently.

### b. Storage dir — **ours**: `<CONFIG_DIR>/dp/`, and the current T6 is unsafe

Our config dir is `~/.nessy-agent`, `NESSY_CONFIG_DIR`-overridable, frozen at import (`packages/shared/src/config/paths.ts:18-21`).

**The decisive finding — the current T6 breaks the sandbox.** `host-sandbox-settings.ts:64` seeds the deny floor from `credentialDenyRoots(homedir(), CONFIG_DIR)`, and `packages/session-tools-core/src/runtime/credential-deny-roots.ts:102-119` includes **`home('.nessy')`** — the *entire* `~/.nessy` tree — as a denied **read** root, while `configDir` contributes only the single file `join(configDir, 'credentials.enc')` (`:103`).

`withDpStateRootWriteGrant` (`host-sandbox-settings.ts:90-101`) then does:

```ts
const denied = [...resolved.deniedReadRoots, ...resolved.deniedWriteRoots]
  .find(deny => root === deny || root.startsWith(`${deny}/`))
if (denied) { onDiagnostic?.(`dp state root ${root} lies inside the denied root ${denied}; …`); return resolved }
```

`~/.nessy/dp_latest`.startsWith(`~/.nessy/`) → **true**. So T6 as currently written (`workdir = ~/.nessy/dp_latest`) yields a state root that is **denied for read and refused for write** — the fallback would be self-defeating under the sandbox, silently, with only a diagnostic. `~/.nessy-agent/dp/` is inside no deny root and is grantable.

**Recommendation: `<CONFIG_DIR>/dp/`, split into two subdirectories.**

```
<CONFIG_DIR>/dp/bin/dp      0700   the binary — ours, never in a sandbox write grant
<CONFIG_DIR>/dp/state/      0700   fallback DP_WORKDIR (only for machines with no ~/.dp)
```

Reasons beyond the deny floor:
1. **Racing updaters.** Their `dp update` single-flight is per-process (`dpUpdater.ts:29-31`); their CLI and our app share no lock. Two `dp update`s over one file = `ETXTBSY` or a half-replaced binary.
2. **`removeDp()`.** `dpAuthManager.ts:30` deletes `dp_latest/dp` on *any* `prepareAuth` failure — a nessy-cli auth hiccup would delete a binary we are mid-`execFile` on.
3. **Their pin, their floor, their `NESSY_HOME`/`Storage.setRuntimeBaseDir` can move the dir at runtime.**
4. Splitting `bin/` from `state/` is a free hardening win over their layout: the sandbox write grant covers only `state/`, so a sandboxed agent cannot overwrite the dp binary it then executes. (`dp update`, if ever enabled, writes the binary's own directory — which our *host* process can write and a sandboxed shell cannot. That is the desired asymmetry.)

Name it `dp/`, not `dp_latest/` — a distinct name keeps "whose copy is this" answerable at a glance.

### c. **THE critical question — workdir strategy: share `~/.dp` (option ii)**

**Recommendation: the managed binary runs against the *system* state root — `DP_WORKDIR` unset ⇒ `~/.dp` — and only falls back to `<CONFIG_DIR>/dp/state` when `~/.dp` does not exist.**

Four measured reasons:

1. **The primary use case is a user who is already logged in.** "System dp present but stale / cannot self-update, session live in `~/.dp`" is exactly the owner's scenario. An own workdir throws that session away and forces a re-login through our app for a user who is *already authenticated*. That is a regression in the very case that motivates the feature.
2. **Plugins.** Our whole builtin dp MCP set spawns `dp ai mcp <subcommand>` (`builtin-dp-servers.ts:281-287`), and those subcommands are **plugin-backed**: the registry is `<workdir>/config.json` and the binaries are `<workdir>/plugins/*` (measured: 14 entries, absolute `file_path` under `~/.dp/plugins`, gitlab 11 MB + jira 8.9 MB). An isolated workdir has **neither** — measured directly on nessy-cli's `dp_latest`, whose `plugins/` is empty and which has no `config.json` at all. Isolating would ship a dp that cannot serve `dpJira`/`dpGitlab`/`codeSearch` until every plugin is re-downloaded into a second tree.
3. **dp's state is not schema-version-gated.** `config.json` = `{plugins}`, `access_token.json` = `{tokens}`, `cache_version.json` = `{core, plugins, timestamp}`. The only version-stamped file, `version.json`, is an update-manifest cache. A newer binary reading older state is *already the shipped situation*: the 13.39.0 system dp reads a `version.json` written by 12.6.2 (Feb 2025) every day without trouble.
4. **It is what we ship today.** `resolveDpStateRoot()` returns `~/.dp` when `DP_WORKDIR` is unset, and the dp MCP env (`builtin-dp-servers.ts:280`), the plugin binding (`runtime-resolver.ts:283-291`) and the Bash sandbox grant (`host-sandbox-settings.ts:72`) are all built on that one root. Sharing keeps **one** state root across all five paths; isolating creates a second and forces each to learn which.

**Skew hazard and why it is bounded:** a newer managed dp and an older system dp taking turns on `~/.dp`. The resolution ladder below makes this mostly vanish — the managed copy is adopted **only when the system dp is absent, unrunnable, or below the floor**, so the shared state is never written by a binary older than the one already using it. dp itself arbitrates concurrency (`dp.lock`, `refresh.lock`, `lock` all present in `~/.dp`). We never write `~/.dp` ourselves — only dp does.

**Answer to "browser SSO through our app — acceptable?"** With this recommendation the question mostly disappears: the already-logged-in user never re-authenticates. The *first-run* user with no `~/.dp` at all gets `<CONFIG_DIR>/dp/state` and one interactive login through the existing Sign-in flow (`dp auth login`, `dp-api.ts` `LOGIN_TIMEOUT_MS = 5 * 60_000`) — which is what that user faces with a system dp anyway.

### d. Lifecycle

**Download: lazy, on demand, never at startup.** nessy-cli downloads at startup because its dp MCP servers spawn from `config.initialize()` before auth (`dpBinary.ts:16-20`). We do not have that constraint: our builtin dp servers are **all `defaultEnabled: false`** (`builtin-dp-servers.ts` — owner decision 2026-08-01) and materialize per pool sync, degrading to a named diagnostic. So a 22 MB fetch at every app launch would be pure cost.

Trigger: the first dp *need* on a machine where the ladder found nothing usable — the session broker's `ensure`/`probe`, or a pool sync where materialize returns `available: false`. Surface it through the existing `onStatus` channel (`session-broker.ts:27,95-98`; vocabulary `auth/dp/index.ts:38-45`) with a new `'installing-dp'` status, and gate the first fetch behind the user action that already means "I want dp" (pressing Sign in, or enabling a dp MCP server) rather than firing silently.

**Self-update: do not run `dp update`. Pin-only.** This is a deliberate divergence from nessy-cli and I recommend it firmly:

- We measured that the endpoint serves **arbitrary versions including the current one** (13.39.0, 206). Their `dp update` exists because their pin (13.14.1) lags; ours does not have to.
- `dp update` hands trust to dp's *own* update channel — `~/.dp/version.json` points at `devplatform.tcsbank.ru`, a **different host we do not pin and cannot verify**. Their fork doc states the consequence plainly (`dp-binary-lifecycle.md:20-24`): after `dp update` the pinned md5 is inapplicable **by construction**. Pin-only keeps the pin permanently meaningful.
- It deletes an entire failure class: no rename race, no `ETXTBSY`, no AIDT-7488 retry logic, no update timeout, no "runnable binary replaced by an older pinned one".
- Cost: our copy is only as fresh as our last release. Mitigated by (i) bumping the pinned version at close-out like any other constant, and (ii) the ladder preferring the *system* dp whenever it is runnable and ≥ floor — the corp channel keeps it fresh (measured: root replaced it Aug 22).
- `dp` does not silently self-update: it warns, and `DP_NO_WARNINGS: 'true'` (`dp-runtime.ts:62`) already suppresses the nag. Confirmed by state: the system copy is 13.39.0 while its own `version.json` still says 12.6.2.

**Version floor.** `DP_MIN_VERSION = '13.0.0'` (`dp-binary.ts:25`) stays **warn-only for usability** — we never refuse to run a below-floor dp. It becomes an input to *preference*: a below-floor system dp lets the ladder descend. `isDpVersionSupported(null) === true` (`dp-binary.ts:98`) keeps a parse failure from manufacturing a false "outdated".

**Failure modes — all degrade to today's behavior:**

| Condition | Outcome |
| --- | --- |
| Offline / endpoint blocked / 404 / rate-limited (`x-ratelimit-limit: 500`) | no download; ladder yields whatever exists; `DpNotFound` if nothing — **identical to today** |
| Checksum mismatch | temp file removed, live binary untouched, `DpNotFound` + a named diagnostic |
| Downloaded binary does not run (**arm64 without Rosetta — the only asset is x86_64**) | install fails **and the version is negative-cached for the process lifetime.** Without this, their "unrunnable ⇒ reinstall" rule (`dpDownloader.ts:72-74`) becomes an infinite re-download loop, and on arm64-without-Rosetta that is the *guaranteed* outcome |
| Managed copy present but unrunnable | one `removeDp`-style delete + one re-provision, then give up for the process (their `dpAuthManager.ts:20-36` shape) |

### e. Packaging / infra

**No electron-builder, fastlane, or CI change is needed.** Nothing new is bundled; the file arrives at runtime into the user's config dir. This is deliberately *not* the Claude SDK native-binary pattern (bundled, mirrored across `build-dmg.sh`, `build-win.ps1`, `build-linux.sh`, `ensure-claude-sdk-binary-dir.cjs`, `fastlane/Fastfile` — change one, change all five). No `extraResources`, no signing surface, no notarization surface.

macOS execution is field-proven: the runtime-written dp carries **no `com.apple.quarantine`** (only `com.apple.provenance`) and is **unsigned** (`codesign -dv` → "code object is not signed at all"), and it executes — the same as the corp-installed copy, which is also unsigned.

**Sandbox.** `resolveDpStateRoot` refuses `/` and HOME (`dp-runtime.ts:36-45`); our workdir must be grantable. `~/.dp` already is (it is what ships). `<CONFIG_DIR>/dp/state` is inside no deny root — only `credentials.enc` is denied from CONFIG_DIR (`credential-deny-roots.ts:103`). `~/.nessy/dp_latest` is **not** grantable (§b). One further fix falls out: `runtime-resolver.ts:283-291` sets `writableRoots: [stateRoot]` with **no deny check**, unlike `withDpStateRootWriteGrant` — both must consume the same `resolveDpRuntime()` workdir and the same deny check.

**MCP spawn path.** `builtin-dp-servers.ts:280` already builds env from `dpRuntimeEnvironment(resolveDpStateRoot())` and uses the resolved absolute path as `command` (`:281-287`, with the reason stated at `:255-258`: an agent subprocess does not inherit the PATH that found dp). Both become `dpRuntimeEnvironment(runtime.workdir)` from the same record. The two module contracts hold unchanged: never runs dp, never touches `dp_auth_creds.json`.

### f. Multi-copy coexistence — hazards

1. **`dp update` on a binary we do not own** — never do it. Their single-flight is per-process (`dpUpdater.ts:29-31`). The nessy-cli rung is **read-only reuse**: never updated, never deleted. (Moot under pin-only, but the rule must be written down.)
2. **`removeDp()` under our feet** — `dpAuthManager.ts:30` deletes their copy on any auth failure. Executing their copy must tolerate `ENOENT`/`ETXTBSY` mid-flight with a re-resolve, not a hard error.
3. **Token-refresh races on a shared `~/.dp`** — three copies refreshing one `access_token.json`. dp arbitrates (`refresh.lock`, `dp.lock`, `lock` all present); our own single-flight (`auth/dp/index.ts:91`) plus the broker's probe cache (`session-broker.ts:50`, 5 s TTL) keeps our concurrency near 1. Residual blast radius: one redundant refresh. Accept.
4. **Corp MDM replacing the system dp** — measured here (root, Aug 22 20:25, size == the 13.39.0 asset). A resolved path can silently become a different binary. `session-broker.ts:69-80` already re-probes when the *path* changes; recommend keying the probe on `path + mtimeMs + size` so an in-place replacement also invalidates.
5. **Version skew in the shared state root** — bounded, and the ladder's "system first unless below floor" ordering means the shared state is never written by an older binary than the one already using it.
6. **Arch** — only an x86_64 asset exists; on arm64 everything runs under Rosetta. Without Rosetta, *all three* copies are unrunnable; only the negative cache (§d) prevents a download loop.
7. **Disk** — 22–24 MB per copy; three copies ≈ 70 MB, plus a duplicated `plugins/` tree (~20 MB+) if any workdir is isolated. Another reason to share `~/.dp`.

### g. Supply chain

- **What we pin:** `{version, platform → {sha256, byteLength}}` in one constant beside the version. **sha256, not md5** — md5 is their legacy choice; we are writing this fresh.
- **Where the pin comes from:** computed once at pin-bump time by fetching the exact asset over TLS from the exact host and running `shasum -a 256`, recorded in the commit that bumps the version. The **ETag is a cross-check, never the source** — measured: 13.14.1's ETag equals its md5 and carries `x-amz-meta-s3cmd-attrs`, while 13.39.0's is a multipart `…-5` ETag that is not any file hash and carries no md5 metadata. A server-supplied hash is not an independent pin in any case.
- **Floor:** HTTPS only, exact host `code-completion-nestor.tcsbank.ru`, **no redirects followed** (`redirect: 'error'`) — note the S3 origin is reached *through* istio (visible only in a `host:` response header), so a legitimate response is not a 3xx; honor the repo's existing TLS/CA plumbing (`config/network-tls-ca.ts`, `network-mtls.ts`) and never bypass a proxy CA.
- **Verify-then-rename**, exactly their atomic shape (`dpDownloader.ts:108-129`): temp file beside the target → hash → `chmod 0o700` → `--version` liveness → `rename`; any failure `rm -f`s the temp and leaves the live binary untouched. `mkdir` with `mode: 0o700`.
- **The honest limit, stated in the plan:** under pin-only the pin covers every byte we ever execute. That is *why* pin-only is the recommendation — under their `dp update` model the pin covers only the first fetch and trust then passes to an unpinned second host.

---

## 4. Proposed T6 replacement text (do not edit the file — this is the proposal)

> Tracker row to change at the same time:
> `| T6 managed-dp fallback (DP-1) | ⏳ | | |` → `| T6 managed dp: resolution ladder + provisioner (DP-1 amended) | ⏳ | | own dir; shared ~/.dp session; pin-only, no dp update |`
>
> Ledger row **DP-1** must be restated (it currently says "never download… we fetch nothing"). Proposed amendment, to sit under the ledger:
>
> **DP-1 (amended 2026-08-23, owner):** the managed-dp fallback becomes a *managed copy we own*. Measured cause: a system dp installed at `/usr/local/bin/dp` (root:wheel, dir `drwxr-xr-x`, not user-writable) can never `rename()` itself during `dp update`, so a stale corp dp is permanently stale for a non-root user. We therefore (i) keep the system dp first, (ii) add our own copy under `<CONFIG_DIR>/dp/`, (iii) reuse nessy-cli's copy read-only when it is already there, and (iv) download a **pinned** version only when nothing usable exists. "Never download" is withdrawn; "never bundle" and "never write another product's directory" stand.

### T6: Managed dp — resolution ladder + lazy provisioner (DP-1, amended)

**Files:** `packages/shared/src/auth/dp/dp-binary.ts` (the seam), `dp-runtime.ts`, `dp-api.ts` (execs), `session-broker.ts`, new `dp-provision.ts`, `index.ts` (exports); `packages/shared/src/mcp/builtin-dp-servers.ts` (materialize env), `packages/shared/src/agent/backend/internal/runtime-resolver.ts` (`resolvePluginDpRuntime`), `packages/server-core/src/bootstrap/host-sandbox-settings.ts` (`withDpStateRootWriteGrant` caller); tests.

**Measured basis (2026-08-23, this machine — re-verify only if contradicted):**
- `/usr/local/bin` is `drwxr-xr-x root:wheel`, `test -w` false for the user; the dp file itself is 0777. `rename()` needs the *directory*, so `dp update` on a corp-installed dp is structurally impossible for a non-root user. `dp version` = 13.39.0, file mtime Aug 22 20:25, owner root — the corp channel replaces it out from under the user.
- `DP_WORKDIR` relocates the **whole** state root. `~/.dp` holds `config.json` = the plugin registry (14 entries, absolute `file_path` into `~/.dp/plugins/`) plus `plugins/` (gitlab 11 MB, jira 8.9 MB), `access_token.json`, `cache_version.json`, three lock files. nessy-cli's isolated `~/.nessy/dp_latest` has an **empty** `plugins/` and **no** `config.json` — an isolated workdir has zero plugins, and `dp ai mcp jira|gitlab|…` is plugin-backed.
- Download endpoint: **`HEAD` 404s on every version — GET only.** Ranged GET `…/api/v2/download/dp/13.14.1/darwin/dp` → 206, `content-range: …/22314736`, `etag: "f1ec83b38b77dc43d2cccfcda0e6215c"` (= nessy-cli's pinned md5), `x-amz-meta-s3cmd-attrs: md5:…`, body `Mach-O 64-bit executable x86_64`. `…/13.39.0/darwin/dp` → 206, `…/23946864` (= the system dp's exact size), `etag: "6a3cafa6c90b78ae6d27c9639dd0b24d-5"` (**multipart — not a file hash**, no md5 metadata). Arbitrary versions are served. **No arm64 asset** (`darwin-arm64`/`darwin_arm64`/`darwin/arm64` all 404) — every dp on Apple Silicon runs under Rosetta.
- A runtime-written dp carries no `com.apple.quarantine` and is unsigned, and executes — nessy-cli's copy is the field proof.

**Behavior:**

1. **Seam widens, stays sync.** `resolveDpRuntime(): { dpPath: string; workdir?: string; source: 'env'|'system'|'managed'|'nessy-cli' }` replaces the `string` return; `resolveDpBinary()` stays as a thin wrapper. It **must remain synchronous and must never exec** — `builtin-dp-servers.ts:14-19` states that as a module contract and three test files depend on it. The download lives in a separate async `ensureManagedDp()`, never inside the resolver.

2. **Resolution ladder** (first runnable wins; each rung is an `accessSync(X_OK)` check, no exec):
   1. `NESSY_DP_PATH` — absolute, executable. Explicit operator/dev override, ahead of everything.
   2. **System dp** — `PATH` → `/usr/local/bin/dp` (today's body, unchanged), **unless** a cached version probe says it is below `DP_MIN_VERSION` or unrunnable.
   3. **Our managed copy** — `<CONFIG_DIR>/dp/bin/dp`.
   4. **nessy-cli's copy** — `$NESSY_HOME/dp_latest/dp` else `~/.nessy/dp_latest/dp` (T5's base rule). **Read-only reuse: never updated, never deleted, tolerant of `ENOENT`/`ETXTBSY` mid-exec** — `nessy-cli/packages/core/src/dp/dpAuthManager.ts:30` deletes it on any of their auth failures.
   5. **Provision** — `ensureManagedDp()` downloads the pinned version into rung 3 (see 5 below).
   6. `DpNotFound` — today's error, unchanged.

   The system dp keeps priority; a *needs-login* system dp does **not** descend the ladder (original DP-1 holds). Only *absent*, *unrunnable*, or *below-floor* descends.

3. **Workdir: share the system session.** `workdir` is `undefined` (⇒ dp's own `~/.dp`) whenever `~/.dp` exists, for **every** rung. Only when `~/.dp` is absent do we create and use `<CONFIG_DIR>/dp/state` (0700). Rationale: the state root holds the login **and** the plugin registry + plugin binaries; isolating it re-logs-in a user who is already logged in and leaves `dp ai mcp <plugin>` with nothing to run. **Never** use `~/.nessy/dp_latest` as a workdir — see 6.

4. **Every exec and every spawn carries the pair.** `dp-api.ts:41-45` (`printToken`) today passes `env: { ...process.env, DP_NO_WARNINGS: 'true' }` with no `DP_WORKDIR`; `login` and `version` likewise. All become `dpRuntimeEnvironment(runtime.workdir)`-derived. `builtin-dp-servers.ts:235,280` and `runtime-resolver.ts:282-291` both consume the **one** `resolveDpRuntime()` record instead of pairing `resolveDpBinary()` with an independent `resolveDpStateRoot()`.

5. **Provisioner** (`dp-provision.ts`) — nessy-cli's atomic shape, our supply chain:
   - Lazy: fired only at a real dp need (broker `ensure`/`probe`, or a pool sync where materialize is `available:false`), **never at startup**, and gated behind the user action that already means "I want dp". Reports through the existing `onStatus` channel (`session-broker.ts:27`; vocabulary `auth/dp/index.ts:38-45`) with a new `'installing-dp'` code.
   - Atomic install: `<target>.download-<pid>` beside the target → sha256 + byte-length verify → `chmod 0o700` → run `--version` against `/Spirit CLI Version: (\d+\.\d+\.\d+)/` → `rename`. Any failure `rm -f`s the temp and leaves any existing binary untouched. Folder `mkdir` with `mode: 0o700`.
   - Module-scope single-flight promise cleared in `finally` (their `dpDownloader.ts:48-58` shape).
   - **Negative cache**: a version that downloads but does not run is not retried for the process lifetime. Without it, "unrunnable ⇒ reinstall" is an infinite download loop, and on arm64 without Rosetta that is the guaranteed outcome.
   - **No `dp update`, ever** — not on the system copy (it cannot rename), not on nessy-cli's (not ours), not on ours (pin-only). Freshness comes from bumping the pinned version at close-out, and from the ladder preferring the corp-maintained system dp. This diverges from nessy-cli deliberately: their `dpDownloader.ts:79-84` retry-without-reinstall (AIDT-7488) and their whole updater exist to manage a self-update we are not performing.
   - Supply chain: pin `{version, platform → {sha256, byteLength}}` in one constant; sha256 computed at pin-bump time from the asset itself and recorded in the bump commit; the ETag is a cross-check only (13.14.1's equals its md5, 13.39.0's is a multipart ETag that is not a file hash). HTTPS + exact host `code-completion-nestor.tcsbank.ru`, `redirect: 'error'`, repo TLS/CA plumbing honored, no proxy-CA bypass. Liveness probes use a **ranged GET**, never `HEAD` (HEAD 404s).

6. **Sandbox correctness (this is why the previous T6 text had to change).** `credential-deny-roots.ts:102-119` puts the whole of `home('.nessy')` in `deniedReadRoots`, seeded into the floor at `host-sandbox-settings.ts:64`. `withDpStateRootWriteGrant` (`:90-101`) refuses any state root inside a denied root and emits a diagnostic — so `workdir = ~/.nessy/dp_latest` would be **denied for read and refused for write**, silently defeating the fallback under the sandbox. `~/.dp` and `<CONFIG_DIR>/dp/state` are both grantable (CONFIG_DIR contributes only `credentials.enc` to the floor, `:103`). Additionally, `runtime-resolver.ts:283-291` sets `writableRoots: [stateRoot]` with **no** deny check — align it with `withDpStateRootWriteGrant` and feed both from the same record. Keep `bin/` out of every write grant so a sandboxed agent cannot rewrite the binary it then executes.

7. **Version floor.** `DP_MIN_VERSION` (`dp-binary.ts:25`) stays warn-only for *usability* — we never refuse to run a below-floor dp — and becomes an input to ladder *preference* only. `isDpVersionSupported(null) === true` (`:98`) is preserved so a parse failure cannot manufacture a false "outdated". The probe is cached and keyed on `path + mtimeMs + size` (the corp channel replaces the system binary in place — measured — so a path-only key, as in `session-broker.ts:73-80`, misses it).

8. **T4 vocabulary.** The provisioner's failure codes join T4's reason line on the gateway 401 card: download blocked / checksum mismatch / downloaded dp will not run on this machine (Rosetta). Codes only, never token values, never a URL with a query string.

**Tests** (focused; per the plan's verification budget):
- Ladder, table-driven: env override wins; system present+runnable → managed ignored (`source: 'system'`); system absent → managed (`'managed'`); system below floor → managed; managed absent → nessy-cli copy (`'nessy-cli'`); none → `DpNotFound`. All via injected fs predicates — **no exec, no network**.
- Workdir: `~/.dp` exists → `workdir === undefined` on every rung; `~/.dp` absent → `<CONFIG_DIR>/dp/state`; **never** `~/.nessy/dp_latest` (explicit negative).
- Sandbox: a state root at `~/.nessy/dp_latest` is refused by `withDpStateRootWriteGrant` with the diagnostic (pins the reason this design exists); `<CONFIG_DIR>/dp/state` is granted.
- Exec env: `printToken`/`login`/`version` each carry `DP_WORKDIR` exactly when `runtime.workdir` is set, and `DP_NO_WARNINGS`/`DP_AI_MCP_SKIP_LOGIN` unchanged.
- MCP materialize + plugin binding both receive the same `{command, workdir}` from one resolver call (one assertion over both, so they cannot drift).
- Provisioner: checksum mismatch → temp removed, live binary untouched, no rename; downloaded-but-unrunnable → install fails **and a second call does not re-download** (negative cache); concurrent callers share one inflight; a `<CONFIG_DIR>` containing a space works (their `execFile` lesson, fork doc `:38-40`); no `dp update` is ever spawned (assert on the exec spy's argv).
- Static: the seam has exactly one production body; `resolveDpRuntime` is not `async` (guards the "never runs dp" module contract).

**Commit:** `feat(auth): managed dp copy with a resolution ladder and pinned provisioner`

---

## 5. Residual owner decisions

Zero blocking. Three recommendations that are decisions in substance — flagging them so the owner can veto rather than discover:

1. **DP-1's "never download" is withdrawn** (that is the whole point of the revisit), but **"never bundle"** and **"never write another product's directory"** are kept. If the owner wants "no download" preserved in any form, the ladder still delivers most of the value at rungs 1–4 and rung 5 can be feature-flagged off — say so and I will write it as a flag.
2. **No `dp update`, ever (pin-only).** This is my recommendation over copying nessy-cli's model, because their own doc admits the pin is inapplicable after a self-update and the update channel is a *second, unpinned host* (`devplatform.tcsbank.ru`, per `~/.dp/version.json`). Consequence to accept knowingly: our copy is as fresh as our last release. The ladder mitigates it by preferring the corp-maintained system dp whenever it is runnable and ≥ floor.
3. **Shared `~/.dp` session for the managed copy.** The alternative (isolated workdir) costs a re-login for an already-logged-in user *and* an empty plugin tree, which breaks `dp ai mcp <plugin>` — both measured. If the owner prefers isolation anyway, the design still works, but the plugin cost must be planned for (a first-run plugin install of tens of MB) and the workdir must be `<CONFIG_DIR>/dp/state`, never `~/.nessy/dp_latest`.

**One correction the owner should know regardless of which way these go:** T6 as currently written in `docs/superpowers/plans/2026-08-22-dp-auth-wave2-and-mcp-exposure.md:124-131` specifies `workdir = ~/.nessy/dp_latest`. That directory is inside `~/.nessy`, which our own sandbox floor lists as a denied **read** root (`packages/session-tools-core/src/runtime/credential-deny-roots.ts:106`), so `withDpStateRootWriteGrant` (`packages/server-core/src/bootstrap/host-sandbox-settings.ts:90-101`) would refuse the write grant and dp could not read its own token there. That line has to change whichever design is chosen.
# Appendix K — adversarial verification of I and J (full report)

All checks complete. Here is the verification.

---

# TASK V2 — adversarial verification of Report D2 (and spot-check of Report M)

Baseline established first: `0a4a5d8b8` = `feat(sessions): 1.31.0 …`, and both root and `apps/electron` `package.json` read `1.31.0` at that commit. All code claims below were re-derived with `git show 0a4a5d8b8:<path>` / `git grep -a … 0a4a5d8b8`, not from the working tree.

## (a) Which adapter's format string matches `Provider error — retry 3/3 in 2s` — **CONFIRMED**

**Emitter census.** `git grep -a -n "Provider error" 0a4a5d8b8` (with `-a`, per the NUL-byte trap) returns exactly two producers plus one consumer, no codex emitter:

- `packages/shared/src/agent/backend/pi/event-adapter.ts:929` `` const attempts = `retry ${retryEvent.attempt}/${retryEvent.maxAttempts} in ${seconds}s`; `` → `:938` `` : `Provider error — ${attempts}`, ``
- `packages/shared/src/agent/backend/claude/event-adapter.ts:228-249` `buildRetryStatusMessage`, `:237` `` parts.push(`retry ${input.attempt}/${input.maxRetries}`) ``, `:242` `` parts.push(`in ${Math.max(1, Math.round(input.retryDelayMs / 1000))}s`) ``, `:244` suffix, `:248` `` : `Provider error${suffix}` ``
- consumer: `packages/server-core/src/sessions/SessionManager.ts:22123`

Both render the shape, so D2 is right that the string alone does not pin it. *(Line drift: D2 cited Pi `930-939` and Claude `236-252`; exact are `929/938` and `228-249`. Substance identical.)*

**Pi ladder — re-derived from the shipped SDK, not from D2.**
- `node_modules/@earendil-works/pi-ai/dist/utils/retry.js:114` — `let maxAttempts = policy?.enabled ? policy.maxRetries : 0;` → the denominator **is** `maxRetries`, not `maxRetries+1`.
- `:139` — `const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);` — and I confirmed there is **no jitter** in the implementation (the `.d.ts` says "before jitter"; the body applies none). Pi delays are exact.
- `packages/pi-agent-server/src/gateway-retry-settings.ts:13` `{maxRetries: 5, baseDelayMs: 15_000}`; `:20` `{maxRetries: 3, baseDelayMs: 2_000}`. *(D2 cited `:14,:20`; the gateway constant is `:13`.)*

So Pi's total reachable output is `retry N/5 in 15|30|60|120|240s` or `retry N/3 in 2|4|8s`. **`3/3 in 2s` is unreachable for Pi** — at `3/3` the delay is `2000 × 2² = 8000` → `8s`.

**Claude ladder.** `packages/shared/src/agent/options.ts:344` `export const INTERACTIVE_MAX_RETRIES = 3;`, set at `:336` guarded by `:334` (`if (env.CLAUDE_CODE_MAX_RETRIES !== undefined) return;`). `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:103` carries the formula verbatim as D2 quoted it. With `numRetries = maxRetries − retriesRemaining ∈ {0,1,2}` the seconds are `0.5 / 1.0 / 2.0` × jitter `(0.75–1.0)`, and the adapter's `Math.max(1, Math.round(…))` at `event-adapter.ts:242` renders them **`1s / 1s / 2s`**. `3/3 in 2s` is Claude's terminal rung, deterministically.

**One step D2 did not take, which closes a hole in its own argument.** D2 proves the attribution *positively* (Claude's rung 3 = 2s), which depends on the native binary actually honoring `CLAUDE_CODE_MAX_RETRIES`. I checked that directly in `claude-agent-sdk-darwin-arm64/claude`:

```
function NSs(){let e=ZUe();if(process.env.CLAUDE_CODE_MAX_RETRIES){let t=Rp(process.env.CLAUDE_CODE_MAX_RETRIES);if(Number.isFinite(t)&&t>=0){if(t>HSs&&!e){…`CLAUDE_CODE_MAX_RETRIES=${t} clamped to ${HSs}`…}return t}}return e?PO_:IO_}
```

It does — `3` is below the clamp and returned as-is. But the **stronger** proof is by *elimination from Pi*, which needs neither the jitter arithmetic nor this binary fact: Pi cannot emit `3/3 in 2s` under either shipped policy, and only two emitters exist, therefore it is Claude. Same verdict, fewer dependencies.

**Red row — CONFIRMED, and the hit count matches exactly.** `"Failed to authenticate"`: **0** hits in our TS at `0a4a5d8b8`, **0** in `@earendil-works/*`, **0** in `sdk.mjs`, **8** in `claude-agent-sdk-darwin-arm64/claude` — D2 said 8.

**`shouldRetry` — CONFIRMED verbatim** in `sdk.mjs`: 401 is retried only when `this._authState.tokenCache && r.usedTokenCache && !r.didRefreshFor401`, then `408/409/429/≥500`, else `false`.

**An independent corroboration D2 missed, which makes its R3 stronger than D2 claimed.** A gateway-mode `claude-runtime` session drives the SDK against our loopback adapter with no OAuth token cache. So a creds-gate 401 satisfies none of the `shouldRetry` 401 conditions and produces **no retry line at all**. A transcript containing both a `retry 3/3` ladder *and* a 401 therefore necessarily contains **two distinct failures** — which is precisely R3's hypothesis, arrived at from the code rather than from the timeline.

**Two caveats D2 does not state (neither refutes it):**
1. `sdk.mjs` `retryRequest` reads `retry-after-ms` then `retry-after` **before** falling back to the formula, and this build applies **no sanity clamp** to the header value. A server-supplied `Retry-After` sets the delay directly. Runtime attribution is unaffected; "2s is the only possible terminal rung" is not.
2. `gateway-retry-settings.ts` (the `applyRetryPolicy` docblock — the line range first cited here had drifted by 2026-09-23) documents that `applyOverrides` "is wiped by a later compaction toggle". The fallback is Pi's merged settings, whose defaults are the same `3 / 2000` — so the conclusion survives; only a hand-edited Pi `settings.retry.baseDelayMs ≈ 500` would put `3/3 in 2s` in Pi's reach.

## (b) piAuth timing and what `attemptAuthRetry` does — **CONFIRMED**

At `packages/shared/src/agent/pi-agent.ts` (note: `agent/pi-agent.ts`, not `agent/backend/pi/`):

- `:1597` `const piAuth = await this.getPiAuth();` — resolved **once**, at spawn; shipped in the init payload at `:1705`. CONFIRMED.
- `:2326-2333` gateway JWT first; `:2335-2342` **unguarded** fallback `const apiKey = await credentialManager.getLlmApiKey(slug);` → `credential: { type: 'api_key', key: apiKey }`. CONFIRMED. *(Exact range is `2335-2342`; D2 said `2335-2341`, the prompt said `~2329-2345`.)*
- `:2398` `if (this.config.authType !== 'oauth') return;` — `refreshAndPushTokens` never pushes a `token_update` to a gateway (api-key) Pi session. CONFIRMED.

At `packages/server-core/src/sessions/SessionManager.ts`:

- `:20506` `if (managed.authRetryAttempted || …) return false`; `:20523` sets it; `:18746` resets it only `if (!_isAuthRetry)` → **one retry per message**. CONFIRMED.
- `:20539` `await this.refreshGatewayAuthForRetry(managed)` runs **before** disposal; `:20547-20551` `strictDrainPiSession` (pi) / `disposeManagedAgentRuntime` (else); `:20552` `if (managed.agent) throw new Error('auth-retry-agent-disposal-incomplete')`. CONFIRMED. *(D2 cited `20541-20551`; exact `20545-20552`.)*

**D2's headline correction is CORRECT**: the agent is disposed and asserted disposed before the resend, so the replacement's `postInit` re-runs `getPiAuth()` at `:1597`. "Auth-retry must re-resolve `piAuth` into the live subprocess" is **not** a real gap.

Supporting claims also CONFIRMED: `refreshGatewayAuthForRetry`'s swallow at `SessionManager.ts:9346-9348` (`// best-effort — the retry itself reports the real failure`; D2 cited `9349-9351`), and the single-flight at `packages/shared/src/auth/dp/index.ts:91` `if (inflight) return inflight;`. The `forceRefresh` option's **own doc comment concedes it verbatim** at `index.ts:66-67`:

> `Single-flight caveat: a forceRefresh caller that joins an already-running warm ensure gets that run's result — acceptable, the retry re-fires.`

**Two things I found that D2 did not, both reinforcing its case:**

1. `SessionManager.ts:9339-9343` gates the forced re-mint on `isNessyGatewayBaseUrl(connection.baseUrl)`. So a **BYO-classified gateway-host connection never gets the forced re-mint either** — R1 and T1 compound rather than being independent.
2. The comment's justification "acceptable, the retry re-fires" is **undercut by `authRetryAttempted`**: within a message the retry does *not* re-fire (`:20506`/`:20523`). D2 lists both defects but never connects them; connecting them is what makes T1 a real user-visible failure rather than a latency wart.

## (c) Does the packaged installed app contain the guards — **CONFIRMED (contains all of them)**

`/Applications/Nessy Desktop.app`, read-only, unpacked (no asar). `Contents/Info.plist` `CFBundleShortVersionString = 1.31.0`; `Contents/Resources/app/package.json` `"version": "1.31.0"`; `app-update.yml` → `channel: dev`, `url: https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac`. All CONFIRMED.

I re-grepped the same binaries myself. In `Contents/Resources/app/dist/main.cjs`:

| Item | Lines | Verdict |
| --- | --- | --- |
| `isJwtShaped` (3-part, all non-empty) | 352918-352921 | CONFIRMED |
| `getValidCreds` — shape **and** `expiresAt <= Date.now()` | 352969-352973 | CONFIRMED |
| `isJwtShaped2` (cycle-avoiding duplicate) | 388399-388402 | CONFIRMED |
| `readNestorJwt` — shape only, **no expiry** | 388403-388410 | CONFIRMED (and confirms N2) |
| Claude format string | 392252 | CONFIRMED |
| Pi format string (`\u2014`) | 399237 | CONFIRMED |
| SessionManager `retrying` sniffer | 934506 | CONFIRMED |
| `INTERACTIVE_MAX_RETRIES = 3` / `applyInteractiveRetryCeiling` | 183109 / 183062-183065 | CONFIRMED |
| Pi unguarded snapshot fallback | 401793-401807 | CONFIRMED verbatim |

And `app/resources/pi-agent-server/index.js` ships `maxRetries: 5, baseDelayMs: 15000`, `maxRetries: 3, baseDelayMs: 2000`, `baseDelayMs * 2 ** (attempt - 1)` — so §(a)'s Pi ladders hold **on the shipped artifact**, not just in source. `app/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude` is present with the same 8 `Failed to authenticate` hits.

**Nothing D2 claims is present is absent.** D2's own caveat — that this is *this* machine's install and not proof of the reporter's build — is correct and should stay.

**One REFUTED sub-claim (decorative, not load-bearing):** D2 says "`isJwtShaped` 436 occurrences of the identifier". Actual is **6** occurrences on 6 lines: two definitions (352918, 388399) and four call sites (352972, 352994, 388406, 954245). Incidentally that is **four** guarded readers, not three.

## (d) The byte-size reasoning — **arithmetic CONFIRMED, conclusion OVERSTATED, one sub-claim REFUTED**

My own measurements (lengths and counts only):

| File | bytes | mode | token len | segments | seglens | other |
| --- | --- | --- | --- | --- | --- | --- |
| `~/.nessy/dp_auth_creds.json` | 452 | 0600 | 325 | 3 | [36,244,43] | username 12, expiresAt 13 digits, userId 36, no trailing `\n` |
| `~/.nessy/oauth_creds.json` | 407 | 0600 | 325 | 3 | [36,244,43] | token_type 6, expiry_date 13 digits |

**Overhead constants — derived independently, both ways.** Hand-counting `JSON.stringify({jwt,expiresAt,username,userId}, null, 2)` gives `2 + 13 + 30 + 18 + 51 + 1 = 115`, and by subtraction `452 − 325 − 12 = 115`. For nessy-cli's shape: hand-count `76`, subtraction `407 − 325 − 6 = 76`. Both **CONFIRMED**. `saveCreds` writes `JSON.stringify(merged, null, 2)` with no trailing newline (`packages/shared/src/auth/dp/creds-store.ts:94`) — CONFIRMED.

**Reporter arithmetic CONFIRMED as arithmetic:** `450 − 115 − 11 = 324` and `406 − 76 − 6 = 324`. The 244→243 base64url step also checks out: `ceil(4·183/3) = 244`, `ceil(4·182/3) = 243`, so a one-byte-shorter payload does yield a one-char-shorter segment.

**But four problems:**

1. **The status-table label credits the wrong evidence.** "holds a healthy 3-segment JWT — **PROVEN by byte arithmetic**" does not follow. File size constrains total **string length** only. A 324-character *opaque* blob in the `jwt` field produces the identical 450 bytes. Byte arithmetic proves "≈324 characters", nothing about segment count.
2. **REFUTED sub-claim: "An Ory-opaque garbage file would be ≈ 176 B (115 + ~50 + 11)."** I measured the real article rather than estimating it: `~/.dp/access_token.json` → `tokens[0].token` is **94 characters** (`ory_at_…`, one dot), `refresh_token` likewise 94. The correct figure is `115 + 94 + 11 = **220 B**`, not 176 B — off by 25%. D2's *conclusion* survives (450 ≫ 220), but the discriminating margin is smaller than advertised.
3. **Unstated assumptions.** `saveCreds` does `merged = { ...existing, ...next }` (`creds-store.ts:90`) and the file contract is *merge-preserves unknown keys*. The 115-byte constant assumes **exactly four keys**, a 13-digit `expiresAt`, and a 36-char UUID `userId`. Any preserved extra key, or a non-UUID `userId`, inflates the overhead and shrinks the implied token. "Both numbers close **exactly**" is a conditional derivation presented as a measurement.
4. **The real proof is version-conditional, and D2 asserts it unconditionally.** What actually establishes 3 segments is §4's last paragraph — both `saveCreds` call sites run `decodeJwtClaims` first, CONFIRMED at `packages/shared/src/auth/dp/index.ts:165-169` (seed) and `:207-216` (exchange), with `decodeJwtClaims` throwing on `parts.length !== 3`. But that binds only if the file's **last writer** was a build carrying that validation. D2 simultaneously entertains R5 ("the reporter is not on 1.31.0"). Under R5, §4's proof does not bind. The two sections are in tension and §4 should be scoped accordingly.

## D2 §2 / R1 — spot-checked, code CONFIRMED, premise UNVERIFIABLE

Every link in the §2 chain checks out at `0a4a5d8b8`:

- `packages/shared/src/agent/claude-agent.ts:1886` — `handle = await startAdapter({ upstream, ...(upstreamForModel ? { upstreamForModel } : {}) })`, **no `jwt` key**. CONFIRMED.
- `packages/codex-responses-adapter/src/server.ts:122-126` — `const gatewayJwt = opts.jwt !== undefined ? opts.jwt : readNestorJwt();`, called per request from `handleResponses:130`. CONFIRMED — no per-turn cache, no stored-snapshot fallback on the Claude gateway path.
- `packages/codex-responses-adapter/src/nestor-client.ts:85` — `'Nestor-Token': jwt ?? ''`. CONFIRMED.
- `packages/shared/src/agent/backend/internal/drivers/upstream-target.ts:34-37` — whole-URL match. CONFIRMED, and the module comment at `:21-24` states the asymmetry is **deliberate and documented**: *"`isNestorCliBaseUrl` (auth/nestor.ts) is deliberately NOT reused here: it accepts every path under the CLI prefix."* D2's "must not be widened" is right, and better-supported than D2 shows.
- `packages/shared/src/auth/nestor.ts:4-6` — prefix match for Pi. CONFIRMED.
- `packages/shared/src/agent/backend/internal/drivers/anthropic.ts:23-32` — `isNessyGatewayBaseUrl` → `{kind:'nestor'}`, else `{kind:'openai-compatible', baseUrl}`. CONFIRMED.
- `packages/server-core/src/model-fetchers/nestor.ts:46` `'Nestor-Token': credentials.apiKey ?? ''`, throwing `Nestor models fetch failed: ${res.status}` at `:52`. CONFIRMED, including D2's "not the red row".

**Minor mechanism error:** D2 says `attachUpstreamCredential` "attaches `Authorization: Bearer <getLlmApiKey(slug)>`". It actually returns `apiKey ? { ...args.target, apiKey } : args.target` (`upstream-target.ts:58-76`); the header is set a layer down in the transport. Functionally the same, described one layer off.

**UNVERIFIABLE — and it is the load-bearing input.** R1's rank rests entirely on the reporter's transcription being the **raw, unwrapped** gateway body rather than one of the two wrapped forms. I was not given that screenshot or transcription, and I have no access to the reporter's machine, files, connection list, or app version. The code that makes the raw/wrapped discriminator *valid* is confirmed; whether the observation satisfies it is not something I can check. Everything in §4 about the reporter's 450 B / 406 B / `ki.nikolaev` is likewise second-hand.

## Report M spot-checks — all four **CONFIRMED**, unusually exact

- **Download URL / pin scheme** — `nessy-cli/packages/core/src/dp/dpConfig.ts:18` `version: '13.14.1'`; `:19-20` `workDirName: 'dp_latest'`, `workDirEnv: 'DP_WORKDIR'`; `:32` `binaryMode: 0o700`; `:33-34` `downloadUrlPrefix: 'https://code-completion-nestor.tcsbank.ru/api/v2/download/dp'`; `:35-39` one md5 per platform with Darwin `f1ec83b38b77dc43d2cccfcda0e6215c`; `:61-73` `buildDpDownloadUrl` → `${prefix}/${version}/${platformDir}/${dpBaseName}`. All CONFIRMED verbatim. I also independently ran `md5 -q ~/.nessy/dp_latest/dp` → `fd0b7b37e20cdec94d2168ae7c6b2aff`, matching M exactly and ≠ the pin — their copy has self-updated past it, as M says.
- **`dp-binary.ts` seam comment** — CONFIRMED verbatim at `packages/shared/src/auth/dp/dp-binary.ts:53-54` (M cited `:54-55`): *"ponytail: single seam — a managed download can replace this body later; callers never change."* Also CONFIRMED: `:24-25` `DP_MIN_VERSION = '13.0.0'` with "warn-only per 00-context decision 5", `:71-72` "never throws; the version check is advisory only", `:1-8` the never-download decision.
- **`~/.dp` state facts** — every size, mode and mtime I re-measured matches M: `access_token.json` 488 B, `artifactory_token.json` 601 B, `cache_version.json` 29887 B, `config.json` 2318 B with **14** plugin entries each `{version, file_path, installed}` and absolute `file_path`, `sa_cred.json` 2027 B, `version.json` 293 B / `12.6.2` / `2025-02-17`, three 0-byte locks, `plugins/` with 14 binaries, `tmp/`. M's supply-chain point holds: `version.json`'s `files` all point at **`devplatform.tcsbank.ru`**, a different host from the pinned download prefix. `~/.nessy/dp_latest` is `drwx------` with `dp` 23352224 B mode 0777, **empty `plugins/`**, and **no `config.json`** — CONFIRMED, so M's "an isolated workdir has zero plugins" is measured, not inferred. `/usr/local/bin/dp` = `-rwxrwxrwx@ 1 root wheel 23946864 Aug 22 20:25`; `/usr/local/bin` = `drwxr-xr-x 61 root wheel`; `test -w` on the **directory** false, on the **file** true — CONFIRMED, and the `rename()`-needs-directory-write mechanism is correct POSIX.
- **Config-dir path** — `packages/shared/src/config/paths.ts:18-21`: `DEFAULT_CONFIG_DIR = resolve(join(homedir(), '.nessy-agent'))`, `NESSY_CONFIG_DIR` override, `CONFIG_DIR` frozen at import. CONFIRMED exactly.

**M's decisive T6 correction — independently CONFIRMED, and it is the strongest claim in either report.** `packages/session-tools-core/src/runtime/credential-deny-roots.ts:106` puts `home('.nessy')` in the denied **read** roots (with `join(configDir, 'credentials.enc')` at `:103` as CONFIG_DIR's only contribution); `packages/server-core/src/bootstrap/host-sandbox-settings.ts:64` seeds the floor from it; `:94-95` rejects any state root where `root === deny || root.startsWith(`${deny}/`)`; `:99` emits the diagnostic and `:100` returns ungranted. So `workdir = ~/.nessy/dp_latest` is denied for read and refused for write. The file even carries an explicit comment at `credential-deny-roots.ts:76-78` — *"The WHOLE DIRECTORY is denied, not …"*. The current T6 text does have to change.

**NOT re-measured (UNVERIFIABLE here):** M's live HTTP results — `HEAD` 404 on every version, ranged `GET` → 206, `content-range` totals, `etag` values, the absent arm64 asset, the rate-limit headers. I made no network requests to the corp endpoint (read-only mandate; fetching a binary is a download). Two are *indirectly* corroborated but not independently: the pinned Darwin md5 at `dpConfig.ts:38` is character-identical to the ETag M reports for 13.14.1, and the system dp's size `23946864` is exactly the `content-range` total M reports for 13.39.0. Consistent; not proof. If the owner intends to act on the "GET-only, no arm64 asset, pin-from-sha256" design, those four measurements should be re-run by someone with network permission before they become a plan row.

---

## Net verdict

**Report D2's diagnosis is sound and its central load-bearing claims hold under independent re-derivation.** Runtime attribution to `claude-runtime` (a) is CONFIRMED and is in fact provable more cheaply than D2 proves it. The `attemptAuthRetry`/`piAuth` reading (b) is CONFIRMED, including D2's most useful contribution — the explicit **rejection** of a plausible-sounding gap ("auth-retry must re-resolve `piAuth`") that a less careful report would have filed as a plan row. The packaged-app evidence (c) is CONFIRMED on the actual installed binaries. The §2 code chain behind R1 is CONFIRMED line by line.

**Report M is the more accurate of the two on measured facts** — every one of the ~30 local values I re-measured matched, several to the byte and one to the full md5 — and its decisive sandbox finding is confirmed with exact citations.

The defects are concentrated in D2 §4 and in one item of user-facing advice.

### Corrections

1. **REFUTED — D2 §6 step 4.** *"Click **Sign in** … it forces a re-mint and rewrites the stored snapshot. *(mitigates R4)*"* — the second half is false and **contradicts D2's own N4**. The only production writers of the connection key are `packages/server-core/src/handlers/rpc/llm-connections.ts:302` (the connection **setup/save** form, gated on `setup.credential`) and `packages/shared/src/agent/backend/factory.ts:855` (a temp slug). The gateway sign-in flow writes only `~/.nessy/dp_auth_creds.json` via `saveCreds`. **Clicking Sign in does not mitigate R4.** Under R4 the fix is to re-save the connection through the setup form, or to clear the stored key. N4 is the correct half; step 4 should be rewritten.
2. **REFUTED — D2 §4.** "An Ory-opaque garbage file would be ≈ 176 B (115 + ~50 + 11)." Real Ory tokens on this machine are **94 chars** (`~/.dp/access_token.json`), so the figure is **220 B**. Conclusion unchanged, margin smaller.
3. **REFUTED — D2 §3(b).** "`isJwtShaped` 436 occurrences" → **6** occurrences, 2 definitions + 4 call sites. Also four guarded readers, not three. Decorative.
4. **OVERSTATED — D2 §0 status table.** "holds a healthy 3-segment JWT — PROVEN by byte arithmetic" should read *proven by the validating writer (`decodeJwtClaims` before `saveCreds`, `auth/dp/index.ts:165-169, 207-216`), corroborated by byte arithmetic.* Size proves length, not segment count. And that proof is **version-conditional**, so §4 must be scoped — it does not bind under R5.
5. **UNSTATED ASSUMPTIONS — D2 §4.** The 115-byte constant assumes exactly four keys, a 13-digit `expiresAt` and a 36-char UUID `userId`, while `saveCreds` merge-preserves unknown keys (`creds-store.ts:90`). "Closes exactly" is conditional.
6. **MECHANISM OFF BY ONE LAYER — D2 §2.** `attachUpstreamCredential` (`upstream-target.ts:58-76`) returns `{...target, apiKey}`; the `Authorization` header is set by the transport.
7. **REMEDIATION ORDERING.** D2's step 1 (delete and re-create the connection) is the destructive one and rests on the single unverifiable premise; step 2 (quit, relaunch, new session) is free, non-destructive, and covers R2 plus a frozen `piAuth`. Read the connection (step 1's non-destructive half) and restart **before** deleting anything.
8. **LINE DRIFT** — none material, all substance-preserving: Pi emitter `929/938` (not 930-939); Claude `228-249` (not 236-252); Pi fallback `2335-2342`; disposal `20545-20552`; swallow `9346-9348`; `saveCreds` sites `165-169`/`207-216`; gateway retry constant `:13`; packaged Pi fallback `401793-401807`; seam comment `dp-binary.ts:53-54`; `withDpStateRootWriteGrant` `:87-101`; models-fetch throw `nestor.ts:52`.

### Two additions worth folding into the plan

- **T1 is more severe than written.** The `forceRefresh` doc's justification — *"acceptable, the retry re-fires"* (`auth/dp/index.ts:66-67`) — is void inside a message, because `authRetryAttempted` (`SessionManager.ts:20506`/`:20523`) permits exactly one retry per message. The comment's own escape hatch does not exist. That connection is what turns T1 from latency into a user-visible 401.
- **R1 and T1 compound.** `SessionManager.ts:9339-9343` gates the forced re-mint on `isNessyGatewayBaseUrl`, so a gateway-**host**-but-not-gateway-**URL** connection gets neither the `Nestor-Token` nor the forced re-mint. N1 should say so — it is one detector covering both.