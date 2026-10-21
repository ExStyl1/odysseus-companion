/**
 * The withheld-variable rule — `server-managed-settings.md#fetch-and-caching-behavior`.
 *
 * Every citation in this file is a `page.md#<section>` anchor plus the verbatim
 * sentence. It carried ELEVEN distinct `server-managed-settings.md:<line>`
 * anchors until 2026-08-28, and re-checked individually that day, exactly ONE
 * still landed on the sentence it claimed (`:167`). A line number in this
 * corpus has a measured half-life of about two days; the quoted sentence does
 * not decay, and where the page's own wording moved under a citation that is
 * recorded below rather than silently rewritten.
 *
 * ## Why this exists
 *
 * A startup served from the cache applies the cached `env` block immediately —
 * "Cached settings apply immediately at startup, except for the withheld
 * environment variables described below". If that block set `HTTPS_PROXY` or
 * `NODE_EXTRA_CA_CERTS` BEFORE the
 * confirming fetch ran, the fetch that is supposed to validate the payload
 * would itself travel through the proxy, or trust the certificate authority,
 * that the payload named. The attacker's endpoint returns the same payload, the
 * payload "confirms" itself, and one poisoned cache stays authoritative
 * forever with no server ever involved. The same closed loop exists for a
 * cached credential: our `NESSY_DP_AUTH_TOKEN` is consumed by
 * `auth/dp/env-token.ts` BEFORE the cached creds are read, so a cached value
 * re-authenticates the session as somebody else and the confirming fetch
 * carries that account's JWT.
 *
 * `#fetch-and-caching-behavior` states the property directly, in the paragraph
 * that opens the withholding rule: the withholding "keeps a cached proxy,
 * certificate authority, endpoint, or credential value from redirecting,
 * intercepting, or re-authenticating the settings fetch that confirms the
 * payload".
 *
 * ## Why it is scoped to the server-fetched cache
 *
 * The same paragraph says "The hardening applies only to the server-fetched
 * settings cache: endpoint-managed settings deployed through MDM or
 * `managed-settings.json` are unaffected." That is not an inconsistency — the
 * two sources have different threat models. Our file-based managed policy is
 * protected PHYSICALLY: `managed-policy-loader.ts` requires a root-owned,
 * non-group/other-writable, non-symlinked file inside a root-owned directory. A
 * user who can poison it already owns the machine, so withholding buys nothing.
 *
 * That premise was FALSE ON WINDOWS until P3.331 (2026-09-04) and this comment
 * did not know it: every one of those checks was a no-op on win32, so any
 * account able to create `%ProgramData%\Nessy` could author the `env` block
 * this file then applied without withholding a single category. The premise is
 * restored rather than patched here — the loader now refuses the win32 tier
 * whole and records a drop, so on every platform this file reads, `managed-file`
 * really is the physically-protected source it claims. If that refusal is ever
 * lifted (a real ACL or `HKLM\SOFTWARE\Policies\…` check, the native-first
 * candidate), this paragraph is what has to be re-argued, not just the loader.
 * The server cache is written by the app into the user's own config directory
 * and the user can edit it — `#security-considerations` carries that threat as a
 * table row of its own, "User edits the cached settings file", answered with
 * "Tampered file applies at startup, and the next server fetch restores the
 * correct settings". The withholding is what makes that edit survivable.
 *
 * ## The classification rule
 *
 * A cached variable is WITHHELD when applying it before the confirming fetch
 * could change:
 *
 * 1. who that fetch trusts, or who can read it   → `transport`
 * 2. where that fetch goes                       → `routing`
 * 3. what identity that fetch presents           → `credential`
 * 4. which binary answers when we shell out      → `execution`
 * 5. which file, directory or environment variable
 *    a secret or an administrator policy is read from → `selector`
 *
 * Rules 1-3 and 5 are the doc's own, rule 4 is ours.
 *
 * **This comment said "the first three are the doc's own three categories"
 * until 2026-08-28, and by then the page carried FIVE bullets, not three.**
 * `server-managed-settings.md#fetch-and-caching-behavior` opens "The withheld
 * categories include:" and its fourth and fifth bullets are, verbatim:
 *
 *   "The configuration-directory selector `CLAUDE_CONFIG_DIR`"
 *
 *   "Credential-source and configuration-directory selectors, in Claude Code
 *   v2.1.223 or later: the Workload Identity Federation variables such as
 *   `ANTHROPIC_FEDERATION_RULE_ID` and `ANTHROPIC_IDENTITY_TOKEN`, the profile
 *   and configuration-directory selectors `ANTHROPIC_PROFILE` and
 *   `ANTHROPIC_CONFIG_DIR`, and the operating-system directory variables
 *   `HOME`, `XDG_CONFIG_HOME`, `APPDATA`, and `USERPROFILE`"
 *
 * A stale enumeration of somebody else's list is the failure mode this file
 * already has a row for (P3.84), and it recurred here in the same shape: the
 * missing bullets were the two that name `HOME`, and an unlisted key falls
 * through to `immediate`, so the omission was FAIL-OPEN.
 *
 * Rule 4 is OURS and has no counterpart in the Anthropic client:
 * `auth/dp/dp-binary.ts:resolveDpBinary` finds the `dp` binary by walking
 * `PATH`, so a cached `PATH` plants a fake `dp`, which mints an attacker token,
 * which authenticates the confirming fetch. That is precisely the effect
 * `#fetch-and-caching-behavior`'s opening paragraph names
 * ("re-authenticating the settings fetch"), reached through a mechanism
 * Claude Code does not have. Leaving it out would have left the loop open.
 *
 * ## Rule 5, and why `HOME` is the sharpest name in this file
 *
 * The `selector` category is the doc's "Credential-source and
 * configuration-directory selectors". These variables neither route traffic nor
 * carry a credential: they RELOCATE the file a secret or a policy is read from,
 * which closes the same loop rule 2 closes, by moving the file instead of the
 * endpoint. The boundary is deliberately narrow — a variable qualifies only when
 * the relocated thing is a credential store or an administrator policy. A log
 * directory or a scratch path is `immediate`.
 *
 * `HOME` is the one that reaches OUR credentials, not just Claude's. Measured
 * 2026-08-28: Node's `os.homedir()` returns `$HOME` on POSIX (positive control
 * on the same rig — unset, it returns the passwd entry), 43 source files under
 * `packages/`/`apps/` call it, and `auth/dp/creds-store.ts:getCredsPath` was an
 * UNCACHED call, so a delivered `HOME` moved `~/.nessy/dp_auth_creds.json` for
 * every read AND every write, moved `~/.nessy/oauth_creds.json` beside it,
 * moved the `~` expansion that `config/sandbox-settings.ts` applies to
 * `deniedPaths` (P3.76's read-side floor), and was handed on verbatim to the
 * `dp` subprocess that MINTS the token (`auth/dp/dp-runtime.ts` set
 * `HOME: homedir()`). `config/paths.ts` is the exception that proves the rule:
 * `CONFIG_DIR` freezes at first import, so it never moved and still does not.
 *
 * **Those four are past tense as of P3.143: they now read `latchedHomeDir()`
 * (`config/home-latch.ts`), which freezes the same way `CONFIG_DIR` does.**
 * The withhold here and the latch there are the two halves of one defence, and
 * neither replaces the other: the withhold keeps an UNCONFIRMED value out of
 * the environment, the latch keeps a CONFIRMED one from switching the running
 * session's credential source. Everything else `os.homedir()` still moves on
 * confirmation, deliberately — the promise is about the credential source, not
 * about every path a session touches.
 *
 * One premise correction rides with it, because the sentence is easy to
 * over-cite. `#fetch-and-caching-behavior` does say "the startup-only selectors
 * covered above reach the environment but don't switch the running session's
 * credential source" — but "covered above" is defined one paragraph earlier as
 * the Workload Identity Federation variables plus `ANTHROPIC_PROFILE` and
 * `ANTHROPIC_CONFIG_DIR`. `HOME` is in the OTHER group, and that group's
 * sentence is "For `CLAUDE_CONFIG_DIR` and the operating-system directory
 * variables, the withholding itself is the protection". So the page does NOT
 * promise a `HOME` latch; ours is ours, for the same reason rule 4 is ours.
 *
 * ## Withhold, not refuse — and the operational control survives
 *
 * `HOME` is a legitimate operator control, so the choice mattered. Withholding
 * costs an administrator nothing, because it is scoped to the server cache:
 * `managed-file` origin is never withheld, and the doc says to use exactly that
 * route — "To deliver those selectors on Claude Code v2.1.223 or later, use
 * endpoint-managed settings such as MDM or `managed-settings.json`". For the
 * server route the doc prescribes the withhold in as many words: "For
 * `CLAUDE_CONFIG_DIR` and the operating-system directory variables, the
 * withholding itself is the protection: the cached value stays out of the
 * environment until the server confirms the payload." So `selector` is a
 * withheld category like the other four, not a refusal.
 *
 * One name IS refused rather than withheld — see
 * {@link isRefusedManagedEnvVar}.
 *
 * Everything else applies at startup as before — `#fetch-and-caching-behavior`'s
 * closing paragraph: "Every other key in the cached `env` block, such as
 * telemetry and OpenTelemetry configuration, applies at startup as before." The
 * doc names those as the remainder, so they are classified `immediate` here
 * rather than left to a default.
 *
 * The same sentence gives the release condition, and it has GROWN a clause
 * since this file quoted it. It said "Once the fetch succeeds, the withheld
 * variables apply for the rest of the session"; re-read 2026-08-28 it reads
 * "Once the server confirms the payload, **and you approve it if it needs
 * security approval**, the withheld variables apply for the rest of the
 * session; the startup-only selectors covered above reach the environment but
 * don't switch the running session's credential source." The approval gate is
 * the added half, and it is the reason the old quote is recorded here rather
 * than overwritten: our release path has no counterpart to it — see
 * {@link resolveManagedEnv}'s `confirmed` flag, which is the fetch alone.
 */

import { CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS } from './claude-provider-routing-env.ts'

export type ManagedEnvCategoryV1 =
  /**
   * "Proxy and TLS configuration" — `#fetch-and-caching-behavior`'s first
   * withheld bullet.
   */
  | 'transport'
  /**
   * "API routing and provider selection" — the second withheld bullet.
   */
  | 'routing'
  /**
   * "Authentication credentials" — the third withheld bullet.
   */
  | 'credential'
  /** Ours: variables that decide which binary a shell-out resolves to. */
  | 'execution'
  /**
   * "Credential-source and configuration-directory selectors"
   * (`server-managed-settings.md#fetch-and-caching-behavior`, bullets 4 and 5)
   * — variables that relocate the file, directory or environment variable a
   * secret or an administrator policy is read from.
   */
  | 'selector'
  /**
   * The named remainder — `#fetch-and-caching-behavior`: "Every other key in
   * the cached `env` block, such as telemetry and OpenTelemetry configuration,
   * applies at startup as before."
   */
  | 'immediate'

export const MANAGED_ENV_WITHHELD_CATEGORIES = [
  'transport',
  'routing',
  'credential',
  'execution',
  'selector',
] as const satisfies readonly ManagedEnvCategoryV1[]

/**
 * The seven provider toggles, mapped to `routing` in one expression.
 *
 * Written as a derivation and not a literal so there is exactly ONE place a
 * provider toggle is ever named in this repo. `Object.fromEntries` widens the
 * key type to `string`, which is what {@link MANAGED_ENV_CLASSIFICATION}'s own
 * index signature already is, so nothing is lost by spreading it in.
 */
const PROVIDER_TOGGLE_ROUTING_ENTRIES: Readonly<Record<string, ManagedEnvCategoryV1>> =
  Object.freeze(
    Object.fromEntries(
      CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS.map(
        name => [name, 'routing'] as const,
      ),
    ),
  )

/**
 * The classification table. Adding a variable here forces a category — that is
 * the type system doing the pinning. `managed-env.test.ts` freezes the exact
 * membership of each withheld category and cross-checks `transport` against
 * what `buildNetworkEnvVars` actually emits, so a new network variable added
 * by the proxy/TLS layer fails this suite until it is classified.
 *
 * Lower-case proxy spellings are listed alongside the upper-case ones because
 * `buildNetworkEnvVars` emits BOTH, and honouring only half of a proxy
 * configuration is its own bug.
 */
export const MANAGED_ENV_CLASSIFICATION: Readonly<Record<string, ManagedEnvCategoryV1>> =
  Object.freeze({
    // ---- transport: "Proxy and TLS configuration" ---------------------------
    // `server-managed-settings.md#fetch-and-caching-behavior`, first withheld bullet.
    HTTP_PROXY: 'transport',
    http_proxy: 'transport',
    HTTPS_PROXY: 'transport',
    https_proxy: 'transport',
    ALL_PROXY: 'transport',
    all_proxy: 'transport',
    // NO_PROXY is withheld with the rest of the triple rather than judged on
    // its own: applying half a proxy configuration produces a state no admin
    // wrote, and a bypass list is part of deciding where a request goes.
    NO_PROXY: 'transport',
    no_proxy: 'transport',
    NODE_EXTRA_CA_CERTS: 'transport',
    // Not in the doc's example list, which is prefixed "such as". A cached
    // NODE_TLS_REJECT_UNAUTHORIZED=0 disables validation on the confirming
    // fetch itself — `#security-considerations` names exactly that, as the
    // answer to its "Network traffic is intercepted or redirected" row
    // ("Disabled TLS validation or
    // intercepted traffic can alter the settings the client receives").
    NODE_TLS_REJECT_UNAUTHORIZED: 'transport',
    SSL_CERT_FILE: 'transport',
    SSL_CERT_DIR: 'transport',
    CLAUDE_CODE_CERT_STORE: 'transport',
    NESSY_DISABLE_BUNDLED_CA: 'transport',
    CLAUDE_CODE_CLIENT_CERT: 'transport',
    CLAUDE_CODE_CLIENT_KEY: 'transport',
    CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'transport',
    // P6.259 — the OFF SWITCH for the client-certificate reload, and the
    // fourth member of the mTLS family rather than a fifth category. The three
    // names above decide WHICH identity a connection presents; this one decides
    // whether a ROTATED identity is ever picked up, so an administrator who
    // delivers it silences the rotation the other three configure. Under the
    // `?? 'immediate'` fallthrough it applied before confirmation, which is the
    // one direction that cannot be undone by a later dialog.
    //
    // READ FROM THE SHIPPED BINARY, not from a page (`network-config` names the
    // reload, not the switch): `node_modules/@anthropic-ai/claude-agent-sdk-
    // darwin-arm64/claude` (`claudeCodeVersion 2.1.247`) carries the literal
    // `CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION` **3 lines / 3
    // occurrences** beside its own log lines `Cleared mTLS configuration cache`
    // (2/2), `mTLS: Loaded ` (2/3) and `mTLS: Failed to load ` (2/3) —
    // re-measured 2026-09-12 (C3.252), both instruments named because they
    // disagree on a minified artefact (C3.294); at `2.1.233` the four read
    // 3 / 2 / 3 / 3 with no instrument stated. Positive control on the same rig:
    // `CLAUDE_CODE_CLIENT_CERT` **14**. Dead control:
    // `zzz_not_a_real_feature_key` **0**.
    //
    // Pi needs no such switch and gets none: `unified-network-interceptor.ts`
    // re-reads the identity on mtime change per request, which is strictly
    // stronger than a stale-connection reload. codex has no client-certificate
    // subject at all. So this is a claude-only name, withheld on all three
    // because a managed block is delivered before the runtime is known.
    CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION: 'transport',
    // The proxy bullet is prefixed "such as", and these four are the rest of
    // the SDK's own proxy surface — the vendored bundle's one `Set` whose
    // literal opens `"HTTPS_PROXY","HTTP_PROXY","NO_PROXY",…`. This comment
    // named it `jNe` while we were on `0.3.223`; on `0.3.233` that identifier
    // is an AJV data-type helper, so cite the array's CONTENT, never a
    // minified name — the bump renames them and nothing fails. A unix socket
    // REPLACES the transport wholesale, which is strictly more than redirecting
    // it; the proxy-auth helper decides what credential the proxy is handed and
    // for how long it is reused; host resolution decides who resolves the name.
    ANTHROPIC_UNIX_SOCKET: 'transport',
    CLAUDE_CODE_PROXY_RESOLVES_HOSTS: 'transport',
    CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER: 'transport',
    CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS: 'transport',

    // ---- routing: "API routing and provider selection" ---------------------
    // `#fetch-and-caching-behavior`, second withheld bullet.
    ANTHROPIC_BASE_URL: 'routing',
    ANTHROPIC_BEDROCK_BASE_URL: 'routing',
    // `amazon-bedrock.md#use-the-mantle-endpoint`: overrides where a Mantle
    // session's requests go — a provider endpoint selection like its Invoke-API
    // sibling above it.
    ANTHROPIC_BEDROCK_MANTLE_BASE_URL: 'routing',
    AZURE_OPENAI_BASE_URL: 'routing',
    // Every provider TOGGLE the shipped SDK selects on, DERIVED from
    // `claude-provider-routing-env.ts` rather than restated. This spread is
    // the whole point of P3.111: the five names that used to be typed out here
    // were a second hand-maintained copy of that list, it had drifted by two
    // (`CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`, `CLAUDE_CODE_USE_GATEWAY`),
    // and because an unlisted key falls through to `immediate`, the drift was
    // FAIL-OPEN — a server-cached managed `env` block carrying either name was
    // applied at startup, on the one path an administrator uses, with nothing
    // failing to say so. A toggle is a provider SELECTION, which is exactly
    // the routing bullet's category, so the mapping is total and needs no per-name
    // judgement; the four endpoint/credential names in that same strip list
    // are NOT toggles and keep their own categories below.
    ...PROVIDER_TOGGLE_ROUTING_ENTRIES,
    // The Bedrock endpoint host is derived from the region, so the region IS a
    // provider endpoint selection here.
    AWS_REGION: 'routing',
    NESSY_PI_MODEL_PROVIDER: 'routing',
    NESSY_PI_MODEL_API: 'routing',
    NESSY_PI_MODEL_BASE_URL: 'routing',
    NESSY_PI_SUBPROCESS: 'routing', // F1.535 — F1.531's Pi-process marker selects Pi routing like the three hints above
    // Where the client connects at all. Strictly worse than redirecting one fetch: it redirects every request the session makes.
    NESSY_SERVER_URL: 'routing',
    NESSY_RPC_HOST: 'routing',
    NESSY_RPC_PORT: 'routing',
    // The rest of the SDK's base-URL array — `RR` in the vendored `0.3.233`
    // bundle, which this comment called `zk` while we were on `0.3.223`; the
    // minified name moved on the bump and `zk` is now an OpenTelemetry noop
    // class, so read the array by its CONTENT (the one opening
    // `"ANTHROPIC_BASE_URL","_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"`), never
    // by a minified identifier written down here. The routing bullet names "the
    // provider endpoint URLs such as `ANTHROPIC_BEDROCK_BASE_URL`" — "such as",
    // and we already withhold two of the six, so the other four are symmetry,
    // not a widening. This is the WITHHOLD question only: whether an ambient
    // value of any of them should also be STRIPPED from the subprocess is
    // P3.112's decided-no for the ten companions. Withholding costs an admin a
    // delay; the strip would cost a user their shell.
    ANTHROPIC_VERTEX_BASE_URL: 'routing',
    ANTHROPIC_FOUNDRY_BASE_URL: 'routing',
    ANTHROPIC_AWS_BASE_URL: 'routing',
    ANTHROPIC_GOOGLE_CLOUD_BASE_URL: 'routing',
    // Makes a foreign host be treated as FIRST-PARTY, i.e. decides what the
    // client believes about the endpoint the connection card chose. Zero hits
    // in the 191-page corpus (P3.84's census), so the shipped artefact is the
    // only contract. **P3.113 is now DECIDED: withheld here AND stripped from
    // the subprocess** — it is the one name in this block that is reachable
    // with every provider toggle already gone, because our `claude-runtime`
    // sessions run `firstParty` against a loopback `ANTHROPIC_BASE_URL`, which
    // is exactly the arm the flag widens. The measurement and the 39 binary
    // call sites live on `CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS` in
    // `claude-provider-routing-env.ts`; do not restate them here.
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: 'routing',
    CLAUDE_CODE_API_BASE_URL: 'routing',
    // The OAuth AUTHORITY: where a token is obtained and against whom it is
    // validated. Redirecting it is redirecting the credential exchange.
    CLAUDE_CODE_CUSTOM_OAUTH_URL: 'routing',
    CLAUDE_LOCAL_OAUTH_API_BASE: 'routing',
    CLAUDE_LOCAL_OAUTH_APPS_BASE: 'routing',
    CLAUDE_LOCAL_OAUTH_CONSOLE_BASE: 'routing',
    USE_LOCAL_OAUTH: 'routing',
    USE_STAGING_OAUTH: 'routing',
    CLAUDE_BRIDGE_BASE_URL: 'routing',
    CLAUDE_BRIDGE_SESSION_INGRESS_URL: 'routing',
    // Not the confirming fetch, but session traffic — the same reason
    // `NESSY_SERVER_URL` above is withheld rather than judged against the fetch
    // alone: redirecting every request the session makes is strictly worse than
    // redirecting one.
    CLAUDE_CODE_ARTIFACTS_API_BASE_URL: 'routing',
    CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL: 'routing',
    CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL: 'routing',
    // Four names the SDK's own withhold set gained between `0.3.223` and the
    // vendored `0.3.233`, all four of them ENDPOINTS and all four previously
    // falling through this table's `immediate` default — i.e. applied at startup
    // from an unconfirmed cache. That is P3.84/P3.111's fail-open shape for the
    // third time, and it was invisible for the usual reason: the guard that
    // reads the SDK's set (`__tests__/managed-env-sdk-withhold-set.test.ts`)
    // located it by a MINIFIED NAME the bump reassigned, so it read an empty set
    // and passed. The three below are exact siblings of names already on this
    // list; `CLAUDE_REMOTE_TOOLS_BRIDGE_URL` sits with the bridge URLs above.
    CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL: 'routing',
    CLAUDE_CODE_MEMORY_API_BASE_URL: 'routing',
    CLAUDE_REMOTE_TOOLS_BRIDGE_URL: 'routing',
    // P7.12 — the endpoint half of the THIRTY names the SDK's withhold set
    // gained between the vendored `0.3.233` and `0.3.247` (93 -> 123), every one
    // of which fell through this table's `immediate` default until this commit.
    // That is P3.84/P3.111/P3.134's fail-open shape for the FOURTH time, and it
    // is the largest instance yet: the set went from an Anthropic-shaped list to
    // one that carries the whole AWS and Google credential-resolution surface.
    // The membership is read from the bundle's own array, never from a page —
    // `__tests__/managed-env-sdk-withhold-set.test.ts` is the denominator, and
    // AGENTS.md §"docs are the contract for BEHAVIOUR, not for MEMBERSHIP" is
    // why. Counted in the native binary on the same rig (2026-09-10), with
    // `zzz_not_a_real_env_name` -> 0 as the control: `AWS_SECRET_ACCESS_KEY` 26,
    // `GOOGLE_CLOUD_PROJECT` 24, `METADATA_SERVER_DETECTION` 10,
    // `CLOUDSDK_CONFIG` 6, `CLAUDE_CODE_FEDERATION_CACHE_DIR` 6,
    // `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES` 5, `AWS_ENDPOINT_URL_STS` 4,
    // `GCE_METADATA_HOST` 4.
    //
    // An exact sibling of the three artifact base URLs above it.
    CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL: 'routing',
    // The AWS endpoint overrides. The routing bullet names "the provider
    // endpoint URLs such as `ANTHROPIC_BEDROCK_BASE_URL`" — "such as" — and the
    // first three are literally that URL under the AWS SDK's own spelling, so
    // they are the same decision `ANTHROPIC_BEDROCK_BASE_URL` and `AWS_REGION`
    // already carry here.
    AWS_ENDPOINT_URL: 'routing',
    AWS_ENDPOINT_URL_BEDROCK: 'routing',
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'routing',
    // STS and SSO are credential-EXCHANGE authorities rather than model
    // endpoints, and this table already has the precedent for that:
    // `CLAUDE_CODE_CUSTOM_OAUTH_URL` above is `routing` because "redirecting it
    // is redirecting the credential exchange". Same sentence, same category.
    AWS_ENDPOINT_URL_STS: 'routing',
    AWS_ENDPOINT_URL_SSO: 'routing',
    AWS_ENDPOINT_URL_SSO_OIDC: 'routing',

    // ---- credential: "Authentication credentials" ---------------------------
    // `#fetch-and-caching-behavior`, third withheld bullet.
    ANTHROPIC_API_KEY: 'credential',
    ANTHROPIC_AUTH_TOKEN: 'credential',
    CLAUDE_CODE_OAUTH_TOKEN: 'credential',
    AWS_BEARER_TOKEN_BEDROCK: 'credential',
    // `amazon-bedrock.md#mantle-environment-variables`: "Skip client-side
    // authentication for proxy setups" — it turns client auth OFF, so it is an
    // authentication decision, not an endpoint selection.
    CLAUDE_CODE_SKIP_MANTLE_AUTH: 'credential',
    // Ours, and the sharpest one: `tryEnvToken` consumes this BEFORE the
    // cached creds, so a cached value re-authenticates the whole session.
    NESSY_DP_AUTH_TOKEN: 'credential',
    NESSY_SERVER_TOKEN: 'credential',
    NESSY_SANDBOX_SECRET: 'credential',
    GOOGLE_OAUTH_CLIENT_ID: 'credential',
    GOOGLE_OAUTH_CLIENT_SECRET: 'credential',
    GH_TOKEN: 'credential',
    GITLAB_TOKEN: 'credential',
    // P3.310 — a hardening MASTER SWITCH that was falling through to
    // `immediate`, i.e. applied at startup from an unconfirmed cache and
    // indistinguishable from a name nobody had heard of (measured: it and a
    // fabricated control both classified `immediate`, against
    // `CLAUDE_CODE_SKIP_MANTLE_AUTH` -> `credential`/withheld on the same rig).
    //
    // `credential` for the reason `CLAUDE_CODE_SKIP_MANTLE_AUTH` above is: it
    // decides what identity the child's own subprocesses carry. The shipped
    // binary's bundled prose says it in one sentence — "`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
    // strips Anthropic and cloud provider credentials from subprocess
    // environments and forces permission mode to `default`. It does not scrub
    // arbitrary secrets such as `GITHUB_TOKEN` or `NPM_TOKEN`." — and a second
    // passage adds the operational consequence: "Under
    // `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (and inside the GitHub Action) API
    // keys and cloud credentials are stripped from the child too, so a
    // credentials file must be present."
    //
    // It is far more than those two effects: the latching accessor (`qL()` as
    // it minified at 2.1.233, which LATCHES the parsed value for the life of the
    // process) had 21 call sites in the 2.1.233
    // binary — a count of a MINIFIED symbol, so it is dated rather than
    // refreshed: at 2.1.247 that letter names something else. What is re-measured
    // is the env NAME, 6 lines / 11 occurrences (2026-09-12, C3.252) — — it also pins the filesystem policy to `"strict"`, makes the Bash
    // command parser bail conservatively on `for`/`while`/expansion command
    // names, and arms per-script call caps. `Ln()` accepts `1|true|yes|on`.
    //
    // Withheld, not stripped. The ambient case is deliberately HONOURED — see
    // `agent/options.ts`, and P3.310's note for why deleting an administrator's
    // hardening to close a documentation gap is the wrong move here.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: 'credential',
    // The rest of the SDK's credential array — the literal opening
    // `"ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN",…`
    // (this comment said `Bk`, which on `0.3.233` is a noop OTel histogram) —
    // and its OAuth/bridge/artifact tokens. That bullet is prefixed "such as", so the three names it
    // gives are examples, not the set.
    ANTHROPIC_FOUNDRY_API_KEY: 'credential',
    ANTHROPIC_FOUNDRY_AUTH_TOKEN: 'credential',
    ANTHROPIC_AWS_API_KEY: 'credential',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'credential',
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'credential',
    CLAUDE_CODE_ARTIFACTS_API_TOKEN: 'credential',
    // The fourth of the `0.3.233` arrivals described above, and the one that is
    // a credential rather than an endpoint: its `_BASE_URL` twin is in the
    // routing block, and the SDK ships the pair together.
    CLAUDE_CODE_MEMORY_API_TOKEN: 'credential',
    CLAUDE_BRIDGE_OAUTH_TOKEN: 'credential',
    // Arbitrary headers on every request, `Authorization` included — the one
    // name in the SDK's set that can present an identity without being one.
    ANTHROPIC_CUSTOM_HEADERS: 'credential',
    // The Workload Identity Federation set, named by the doc's fifth bullet.
    // These are `credential` rather than `selector` because they decide WHAT
    // identity is presented, not WHERE it is read from; the two `*_FILE`
    // siblings that decide the where are in `selector` below.
    ANTHROPIC_IDENTITY_TOKEN: 'credential',
    ANTHROPIC_FEDERATION_RULE_ID: 'credential',
    ANTHROPIC_ORGANIZATION_ID: 'credential',
    ANTHROPIC_WORKSPACE_ID: 'credential',
    ANTHROPIC_SERVICE_ACCOUNT_ID: 'credential',
    ANTHROPIC_SCOPE: 'credential',
    // Switches the client onto the HOST's identity wholesale. The variable that
    // names WHICH host variable holds it is a `selector`; this one is the
    // decision to present that identity at all.
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: 'credential',
    CLAUDE_CODE_OAUTH_CLIENT_ID: 'credential',
    CLAUDE_CODE_OAUTH_SCOPES: 'credential',
    // P7.12 — the credential half of the thirty. The first three are the AWS
    // static-credential triple and need no argument; the fourth is the token a
    // container credential provider presents, and its `_FILE` twin sits in
    // `selector` below for the reason the two WIF halves already do — the token
    // is WHAT identity is presented, the file is WHERE it is read from.
    AWS_ACCESS_KEY_ID: 'credential',
    AWS_SECRET_ACCESS_KEY: 'credential',
    AWS_SESSION_TOKEN: 'credential',
    AWS_CONTAINER_AUTHORIZATION_TOKEN: 'credential',
    // Which ROLE is assumed — the AWS spelling of `ANTHROPIC_SERVICE_ACCOUNT_ID`
    // and `ANTHROPIC_FEDERATION_RULE_ID` above: what identity the session ends
    // up holding, not where its token is read from.
    AWS_ROLE_ARN: 'credential',

    // ---- execution: which binary answers a shell-out (ours) ----------------
    PATH: 'execution',
    NODE_OPTIONS: 'execution',
    LD_PRELOAD: 'execution',
    DYLD_INSERT_LIBRARIES: 'execution',
    // P7.12 — the one name of the thirty that decides whether a BINARY RUNS AT
    // ALL. Google's external-account (workload-identity-federation) credential
    // config can name an `executable` whose stdout is the subject token, and the
    // google-auth libraries refuse to run it unless this variable is set: it is
    // the master switch for executable-sourced credentials. Paired with a
    // credential path an administrator also controls (`GOOGLE_APPLICATION_-
    // CREDENTIALS`, `CLOUDSDK_CONFIG`, both `selector` below), an unconfirmed
    // cached value carrying this name is arbitrary code execution at startup —
    // which is exactly what `execution` is for here. No Claude page documents
    // it; the bundle is the only contract, and it scores 5 in the native binary
    // against `zzz_not_a_real_env_name` -> 0 on the same rig (2026-09-10).
    GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: 'execution',

    // ---- selector: where a secret or a policy is READ FROM -----------------
    // The doc's bullets 4 and 5. Each entry carries what it relocates, measured
    // 2026-08-28 against the vendored `sdk.mjs` (their side) and this repo
    // (ours); seventeen names, fifteen theirs and two ours.
    //
    // The operating-system directory variables — `uS()` in the bundle resolves
    // the Anthropic config directory (whose `credentials/<profile>.json` holds
    // the key) as ANTHROPIC_CONFIG_DIR, else APPDATA/USERPROFILE on Windows,
    // else XDG_CONFIG_HOME, else `join(HOME, ".config", "anthropic")`.
    HOME: 'selector',
    USERPROFILE: 'selector',
    APPDATA: 'selector',
    XDG_CONFIG_HOME: 'selector',
    ANTHROPIC_CONFIG_DIR: 'selector',
    // UA12.211 at 0.3.280: HOME's Windows spellings and the machine-wide
    // Git-config root — same WHERE a policy or a credential is read from; the
    // binary resolves homedir as HOME else `HOMEDRIVE+HOMEPATH` on Windows.
    HOMEDRIVE: 'selector',
    HOMEPATH: 'selector',
    PROGRAMDATA: 'selector',
    // WHICH credential file inside that directory:
    // `join(<configDir>, "credentials", `${ANTHROPIC_PROFILE}.json`)`.
    ANTHROPIC_PROFILE: 'selector',
    // The file the OIDC federation identity token is read from — the bundle
    // builds `{ source: "file", path: <this> }` from it.
    ANTHROPIC_IDENTITY_TOKEN_FILE: 'selector',
    // Claude Code's own config directory, and note what else lives under it: the cached
    // remote-settings file is `join(<claudeConfigDir>, "remote-settings.json")`, so
    // this variable relocates the very cache this module withholds from.
    CLAUDE_CONFIG_DIR: 'selector',
    // WHICH OS-keychain entry the credentials are read from and written to:
    // the account name is `Claude Code<suffix>-<sha256(<dir>).slice(0,8)>`.
    CLAUDE_SECURESTORAGE_CONFIG_DIR: 'selector',
    CLAUDE_CODE_HOST_CREDS_FILE: 'selector',
    // Names the ENVIRONMENT VARIABLE the host credential is read from — a
    // credential-source selector that happens not to be a path.
    CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'selector',
    CLAUDE_SESSION_INGRESS_TOKEN_FILE: 'selector',
    // Administrator POLICY rather than a secret: these two relocate the files
    // the policy itself is read from.
    CLAUDE_CODE_REMOTE_SETTINGS_PATH: 'selector',
    CLAUDE_CODE_MANAGED_SETTINGS_PATH: 'selector',
    // P3.145 — READ IN THE NATIVE BINARY, and the classification stands on
    // three measurements instead of on its name.
    //
    // 1. It is a BOOLEAN, not a path: the env registry declares it `sXh=Ne.bool()` and
    //    exports it as `CLAUDE_CODE_MOCK_REMOTE_SETTINGS:()=>sXh`. So it is a switch
    //    that substitutes the remote-settings SOURCE, which is the `selector`
    //    boundary — "which file, directory or environment variable a secret or an
    //    administrator policy is read from" — not a variable that carries a payload.
    // 2. It has ZERO readers in the shipped `claude` binary. The name occurs
    //    exactly twice in the bundle: that registry entry, and the withhold
    //    array. Its accessor occurs three times — declaration, assignment,
    //    export — and is never read. Positive controls for the same instrument
    //    on the same rig: `CLAUDE_CONFIG_DIR` 23 property reads,
    //    `CLAUDE_CODE_HOST_CREDS_FILE` 11, `CLAUDE_CODE_PLUGIN_CACHE_DIR` 3.
    //    (Both counts were taken on the vendored `2.1.233`; the accessor's
    //    minified NAME moved, which is why it is no longer written down.
    //    Re-measured 2026-09-12 on the vendored `2.1.247` as lines/occurrences,
    //    C3.252/C3.294: `CLAUDE_CONFIG_DIR` 35/56, `CLAUDE_CODE_HOST_CREDS_FILE`
    //    12/27, `CLAUDE_CODE_PLUGIN_CACHE_DIR` 6/6 — the 2.1.233 figures were 23,
    //    11 and 3, counted as PROPERTY READS, which is a third instrument again
    //    and not comparable with either of these.)
    //
    //    P6.418 — and a note for the next reader who meets
    //    `CLAUDE_CODE_PLUGIN_CACHE_DIR` here and wonders why this fork does not
    //    USE it (nor its sibling `CLAUDE_CODE_PLUGIN_SEED_DIR`, which scores 0
    //    first-party): both are real and both point at the vendored runtime's
    //    OWN plugin tree, which we bypass entirely — the child is launched with
    //    `plugins: []`. Setting either would seed a store nothing here reads: a
    //    no-op that LOOKS like a working control, which is worse than an absent
    //    one, and worse still because an administrator can already deliver those
    //    names to the child. Our seeding is host-side and reads the store that
    //    is actually read — `plugins/store-v2.ts` `seedFromDirectory`, whose
    //    variable is `NESSY_PLUGIN_SEED_DIR`.
    //
    // 3. P3.134's instrument caveat DOES NOT APPLY HERE, and that is the useful
    //    half. It said `sdk.mjs`'s cached-settings reader is stubbed, so their
    //    name-set was membership evidence only. In the native binary the filter
    //    is a real body: `(e){if(!e?.env)return e;let t=<omitBy>(e.env,(r,n)=>
    //    <set>.has(n.toUpperCase()));return{...e,env:t}}`, where `<set>` IS the
    //    withhold set — and the cached read calls it on every read that is not
    //    the already-verified payload. So membership in the native binary is
    //    proof the filter runs, and this name is in it.
    //
    //    LOCATE THIS CLUSTER BY CONTENT, never by symbol (P3.309). Every minified
    //    name this paragraph used to give — the filter, the omitBy, the set, the
    //    cached reader, the path reader — was reassigned by the `0.3.223 -> 0.3.233`
    //    bump, and worse than vanishing, four of them STILL RESOLVE while naming
    //    unrelated code (measured: the old filter, omitBy and set names score 4
    //    identifier occurrences each and none of them is a `function <name>(` any
    //    more). Two durable anchors, re-measured on the vendored `2.1.247` on
    //    2026-09-12 (C3.252) as lines/occurrences, because the two instruments
    //    disagree on a minified artefact (C3.294): the filter's own opening
    //    `if(!e?.env)return e;` is still **1/1**, so it is still a UNIQUE anchor; the
    //    filename constant `"remote-settings.json"` has moved to **4/4** and is no
    //    longer unique, so it locates the region and the `if(!e?.env)` line is the
    //    one to land on. (Both read **1** at `2.1.233`.) Control on the same rig:
    //    `CLAUDE_CODE_NOT_A_REAL_ANCHOR` **0/0**.
    //
    // Verdict: `selector` CONFIRMED, on a corrected reason. A name with no
    // reader costs an administrator nothing to withhold, the vendor's own
    // fail-closed filter strips it, and if a later build wires the switch up it
    // substitutes the policy source — the one direction where guessing wrong is
    // expensive. (Noted for whoever reads this next: the reader for
    // `CLAUDE_CODE_REMOTE_SETTINGS_PATH` is a bare `(){return}` stub in the
    // shipped binary too — re-verified on `2.1.233`; NOT re-verified at the
    // vendored `2.1.247`, and recorded as such rather than carried forward as if
    // it had been (C3.252, 2026-09-12). It sat three
    // functions above the filter at the `"remote-settings.json"` anchor — which
    // is why the cached read there always takes the stripping branch. Our own
    // withhold of that name is unaffected — it is about what a FUTURE build
    // reads, and about our own tree.)
    CLAUDE_CODE_MOCK_REMOTE_SETTINGS: 'selector',
    // P7.12 — the selector half of the thirty, and the largest of the four:
    // every name here relocates the file, directory, environment variable or
    // metadata service a CREDENTIAL is read from, which is bullets 4 and 5 of
    // `server-managed-settings.md#fetch-and-caching-behavior` word for word.
    //
    // WHICH profile inside the shared credentials file, and which files those
    // are — the AWS spelling of `ANTHROPIC_PROFILE` and `ANTHROPIC_CONFIG_DIR`.
    AWS_PROFILE: 'selector',
    AWS_CONFIG_FILE: 'selector',
    AWS_SHARED_CREDENTIALS_FILE: 'selector',
    // The two `*_FILE` halves: the file a federation/container token is read
    // from, exactly as `ANTHROPIC_IDENTITY_TOKEN_FILE` above.
    AWS_WEB_IDENTITY_TOKEN_FILE: 'selector',
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: 'selector',
    // Credential-source selectors that happen not to be paths — the precedent is
    // `CLAUDE_CODE_HOST_AUTH_ENV_VAR` above, which is `selector` for being "a
    // credential-source selector that happens not to be a path". These name an
    // HTTP endpoint the SDK FETCHES A CREDENTIAL FROM, so pointing one at a host
    // an administrator did not choose is a credential-source substitution, not a
    // request redirect. `_RELATIVE_URI` is resolved against the ECS task
    // metadata host and `_FULL_URI` is unrestricted, which is why both are here
    // rather than only the second.
    AWS_CONTAINER_CREDENTIALS_FULL_URI: 'selector',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: 'selector',
    // The instance/VM metadata services, which mint credentials on request. The
    // `_MODE` and `METADATA_SERVER_DETECTION` names are the same family's
    // switches: they decide whether and how that source is reached at all, so
    // they move with it rather than being judged as flags.
    AWS_EC2_METADATA_SERVICE_ENDPOINT: 'selector',
    AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: 'selector',
    GCE_METADATA_HOST: 'selector',
    GCE_METADATA_IP: 'selector',
    // C3.380 (2026-09-13): `GCE_METADATA_ROOT` arrived in the SDK's withhold set
    // on the `0.3.247` -> `0.3.251` lift and fell through this table's
    // `immediate` default — the SAME fail-open shape the P7.12 block above names,
    // for the FIFTH time, and found by the bundle-derived denominator test rather
    // than by inspection. It is the third spelling of the same GCE metadata
    // location its two neighbours carry (the google-auth library reads HOST, IP
    // and ROOT for one endpoint), so it takes their verdict rather than a new
    // rule. Counted in the native binary on the same rig, both instruments
    // (`grep -acF` lines / `grep -aoF … | wc -l` occurrences), with
    // `zzz_not_a_real_env_name` -> 0/0 as the control: `GCE_METADATA_ROOT` 2/2,
    // against `GCE_METADATA_HOST` 3/4 and `GCE_METADATA_IP` 3/4.
    GCE_METADATA_ROOT: 'selector',
    METADATA_SERVER_DETECTION: 'selector',
    // The Google pair: the path to the ADC credential file, and the gcloud
    // configuration directory that file is discovered under when the first is absent.
    GOOGLE_APPLICATION_CREDENTIALS: 'selector',
    CLOUDSDK_CONFIG: 'selector',
    // Claude Code's own federation cache directory — a configuration-directory
    // selector on the same footing as `CLAUDE_CONFIG_DIR` above, and it holds
    // exchanged federation material.
    CLAUDE_CODE_FEDERATION_CACHE_DIR: 'selector',
    // Ours. `config/paths.ts` reads this at MODULE SCOPE, so it never moves
    // `CONFIG_DIR` in a process that has already imported it — but every
    // subprocess we spawn inherits `process.env` and imports it fresh, so a
    // managed value moves sessions, `config.json` and the credential store
    // there. `DP_WORKDIR` relocates dp's state root, which `resolveDpStateRoot`
    // additionally turns into a sandbox WRITE grant.
    NESSY_CONFIG_DIR: 'selector',
    DP_WORKDIR: 'selector',

    // ---- immediate: the named remainder ------------------------------------
    // "Every other key in the cached `env` block, such as telemetry and
    // OpenTelemetry configuration, applies at startup as before." Listed rather
    // than defaulted so the doc's own example is visibly honoured.
    OTEL_EXPORTER_OTLP_ENDPOINT: 'immediate',
    OTEL_EXPORTER_OTLP_HEADERS: 'immediate',
    OTEL_EXPORTER_OTLP_TIMEOUT: 'immediate',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'immediate',
    OTEL_METRIC_EXPORT_INTERVAL: 'immediate',
    // C3.291 — listed beside its metrics sibling for the same reason the four
    // above are listed rather than defaulted: the doc's own example is visibly
    // honoured. `monitoring-usage.md#traces-beta` — "Span batch export interval
    // in milliseconds (default: 5000)".
    OTEL_TRACES_EXPORT_INTERVAL: 'immediate',
  })

/** Every variable in one withheld category, sorted. Derived, never hand-kept. */
export function managedEnvCategoryMembers(
  category: ManagedEnvCategoryV1,
): readonly string[] {
  return Object.freeze(
    Object.entries(MANAGED_ENV_CLASSIFICATION)
      .filter(([, value]) => value === category)
      .map(([name]) => name)
      .sort(),
  )
}

/**
 * An unlisted variable applies immediately. That is the remainder sentence's rule, not
 * an oversight: the cached block must stay forward-compatible with a payload authored
 * for a newer client. The control on an unlisted variable is the security approval
 * dialog, which is a stronger gate than a delay.
 *
 * **That citation was FALSE, not merely moved (re-read 2026-08-28).** It quoted
 * the page as saying the dialog fires for "variables not in the known safe
 * allowlist", and the page says no such thing anywhere — the phrase does not
 * occur. `#environment-variables-and-the-approval-dialog` is framed the other
 * way round, as an explicit SKIP list: "Claude Code applies some delivered
 * `env` variables without showing the user the approval dialog, including:"
 * (feature and command toggles, model selection, context-window settings,
 * terminal UI, numeric limits), and then "Other delivered variables can require
 * the user's approval before they take effect; a non-empty proxy, base-URL, or
 * `OTEL_EXPORTER_OTLP_ENDPOINT` value always does."
 *
 * The consequence for the sentence above is real and worth stating rather than
 * papering over: "can require" is weaker than the allowlist framing implied. An
 * unlisted variable is not GUARANTEED a dialog — only the proxy, base-URL and
 * OTLP-endpoint values always get one. The delay this function grants is
 * therefore the floor, and the dialog is a gate that may or may not sit above
 * it, which is an argument for classifying rather than defaulting.
 */
export function classifyManagedEnvVar(name: string): ManagedEnvCategoryV1 {
  return MANAGED_ENV_CLASSIFICATION[name] ?? 'immediate'
}

export function isWithheldManagedEnvVar(name: string): boolean {
  return classifyManagedEnvVar(name) !== 'immediate'
}

/**
 * The one name a managed `env` block may not carry AT ALL — refused, not
 * withheld, whatever its origin and whether or not the fetch has confirmed.
 *
 * `CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION` turns OFF the per-variable merge across
 * admin sources — the merge {@link composeManagedEnv} implements and that
 * `managed-settings.md#keys-read-from-every-admin-source` specifies. Honouring
 * it from inside an `env` block is self-referential: the block would be
 * disabling the composition that produced it, which is a lower source silently
 * evicting a higher one.
 *
 * Measured in the vendored bundle 2026-08-28, this is exactly what Claude Code
 * does, and it is the only name in its 89-name withhold set given this
 * treatment: `let u = Pr.CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION === !0` reads it
 * from the PROCESS environment, and the merged admin block is then passed
 * through `tW`, which copies every entry whose upper-cased key is not that
 * name. A withhold would have been weaker — it releases on confirmation, and
 * this must never apply from this source at all.
 *
 * We have no reader of our own for it (`git grep -a` → 0 files under
 * `packages/`/`apps/`; control on the same rig: `CLAUDE_CONFIG_DIR` → 18), so
 * it cannot disable OUR union today. It still matters, because every managed
 * value we write lands in `process.env` and is spread into the Claude SDK
 * subprocess, where `Pr` is exactly that environment.
 */
export function isRefusedManagedEnvVar(name: string): boolean {
  return name.toUpperCase() === 'CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION'
}

/**
 * The values the SHIPPED binary accepts for `CLAUDE_CODE_RESTRICTED`, read off
 * its own bytes rather than guessed.
 *
 * At the vendored `2.1.251` the entry point is
 * `d.config.restricted ||= ["1","true","yes","on"].includes((process.env.CLAUDE_CODE_RESTRICTED??"").toLowerCase().trim())`
 * — located with `grep -aobF 'CLAUDE_CODE_RESTRICTED'` over
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` and read from the bytes
 * around the hit (9 occurrences by `grep -aoF … | wc -l`, 9 lines by `grep -ac`;
 * control `ZZZ_NO_SUCH_NAME_ZZZ` 0/0/0, positive control `CLAUDE_CONFIG_DIR` 58
 * in the binary and 22 in `sdk.mjs`). Note the `||=`: the variable can only turn
 * restricted mode ON, and `CLAUDE_CODE_RESTRICTED=0` cannot turn OFF a
 * `--restricted` that was passed some other way.
 *
 * A SECOND reader exists in the same binary — `function Hj(){return
 * Me(process.env.CLAUDE_CODE_RESTRICTED)}` — whose truthiness helper this lane
 * could not resolve (`function Me(` occurs 57 times in the minified artefact, so
 * the name is reused across chunks). That is recorded rather than assumed: if
 * `Me` accepts a wider set, this predicate is NARROWER than the binary on some
 * path, which is the direction that under-reports rather than the one that
 * invents a warning.
 */
const CLAUDE_RESTRICTED_MODE_TRUTHY_VALUES: ReadonlySet<string> = Object.freeze(
  new Set(['1', 'true', 'yes', 'on']),
)

/**
 * D1.164 — the DECISION on `CLAUDE_CODE_RESTRICTED`, and the sentence that
 * makes it visible.
 *
 * **The decision: it stays `immediate`, and it is honoured.** An administrator
 * setting it IS the "explicit operator switch" that
 * `agent/__tests__/claude-restricted-mode-collision.test.ts` says restricted
 * mode may only be adopted behind; withholding or refusing it would be this
 * host second-guessing the operator on the runtime's own mechanism, which
 * native-first forbids. What was missing was never the classification — it was
 * that nobody could SEE it happen. Restricted mode "ignores user, project and
 * local settings files", so the `project` setting source this fork passes stops
 * loading (P6.34's `--add-dir` skills, commands and subagents) and the user's
 * own `.claude/settings.json` rules stop applying — three user-visible losses
 * with no message.
 *
 * **Why the name is deliberately NOT added to {@link MANAGED_ENV_CLASSIFICATION}**,
 * although every other decided `immediate` name is listed there: that list is
 * consumed by `immediateEnvSnapshot` (`server-core/src/bootstrap/otlp-rearm.ts`)
 * as the key set whose change RE-ARMS the OTLP exporters. Listing a non-telemetry
 * name there would silently widen a different module's trigger. The entry would
 * change nothing here — `classifyManagedEnvVar` already answers `immediate` for
 * it by the documented remainder rule — so the decision is recorded in prose and
 * pinned by test instead of bought at that price.
 *
 * **The other half of the disclosure, which already existed and is not enough on
 * its own:** a DELIVERED policy carrying this name is outside
 * `MANAGED_ENV_SAFE_ALLOWLIST` (`config/managed-approval.ts`), so it raises the
 * approval dialog with the item `sets CLAUDE_CODE_RESTRICTED (immediate)`. That
 * covers the server-cache tier and says nothing about what restricted mode
 * costs, and it does not fire at all for the host-owned managed FILE tier, which
 * is applied without an approval dialog by design. This notice covers both, on
 * the surface the user is actually reading.
 *
 * Returns `null` when the child will not be restricted, so the caller is one
 * `if`. The sentence relays the runtime's own changelog wording rather than
 * paraphrasing it (the P3.267 precedent): a paraphrase of a runtime message is a
 * chance to be wrong about someone else's behaviour.
 */
export function claudeRestrictedModeNotice(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.CLAUDE_CODE_RESTRICTED
  if (typeof raw !== 'string') return null
  if (!CLAUDE_RESTRICTED_MODE_TRUTHY_VALUES.has(raw.toLowerCase().trim())) return null
  const origin = isManagedOriginEnvVar('CLAUDE_CODE_RESTRICTED')
    ? "Your administrator's managed settings turn on Claude Code restricted mode for this session"
    : 'This session runs Claude Code in restricted mode, because CLAUDE_CODE_RESTRICTED is set in its environment'
  return `${origin}. The runtime's own description: it "removes the built-in tools that run `
    + `commands or code and WebFetch (unless named in --tools), keeps file tools inside the working `
    + `directory, refuses bypassPermissions, and ignores user, project and local settings files". `
    + `Your project's skills, commands and subagents and your own .claude/settings.json rules do not `
    + `apply to this session.`
}

/**
 * Where a managed `env` block came from.
 *
 * `server-cache` is the ONLY value that withholds anything — the hardening
 * "applies only to the server-fetched settings cache"
 * (`#fetch-and-caching-behavior`).
 * `managed-file` is the host-owned policy file and its drop-in fragments —
 * physically protected, so unaffected. "Physically protected" is load-bearing:
 * see the header for why it is true on every platform the loader actually reads
 * from, and what P3.331 had to refuse for that to be so.
 */
export type ManagedEnvSourceV1 = 'server-cache' | 'managed-file'

export interface ManagedEnvResolutionV1 {
  /** Variables to set now. */
  readonly applied: Readonly<Record<string, string>>
  /** Variable NAMES held back, by category. Values are never carried here. */
  readonly withheld: Readonly<Record<ManagedEnvCategoryV1, readonly string[]>>
  /** Whether anything at all is being held back. */
  readonly withholding: boolean
}

const NO_WITHHELD: Readonly<Record<ManagedEnvCategoryV1, readonly string[]>> = Object.freeze({
  transport: Object.freeze([] as string[]),
  routing: Object.freeze([] as string[]),
  credential: Object.freeze([] as string[]),
  execution: Object.freeze([] as string[]),
  selector: Object.freeze([] as string[]),
  immediate: Object.freeze([] as string[]),
})

function emptyWithheldBuckets(): Record<ManagedEnvCategoryV1, string[]> {
  return { transport: [], routing: [], credential: [], execution: [], selector: [], immediate: [] }
}

function freezeWithheld(
  withheld: Record<ManagedEnvCategoryV1, string[]>,
): Readonly<Record<ManagedEnvCategoryV1, readonly string[]>> {
  return Object.freeze({
    transport: Object.freeze(withheld.transport.sort()),
    routing: Object.freeze(withheld.routing.sort()),
    credential: Object.freeze(withheld.credential.sort()),
    execution: Object.freeze(withheld.execution.sort()),
    selector: Object.freeze(withheld.selector.sort()),
    immediate: NO_WITHHELD.immediate,
  })
}

/**
 * Split a managed `env` block into what applies now and what waits.
 *
 * `confirmed` is the session flag `#fetch-and-caching-behavior` releases on:
 * "Once the server confirms the payload, and you approve it if it needs
 * security approval, the withheld variables apply for the rest of the session".
 * A cache that is never confirmed keeps withholding for the whole session,
 * which is the same section's "Cached settings persist through network
 * failures. Until a fetch succeeds, the withheld environment variables remain
 * withheld and cost figures stay at list price".
 *
 * Both quotes MOVED under the line numbers this comment used to carry, and both
 * moved in substance: the release condition grew the approval clause we have no
 * counterpart to, and the persistence sentence grew the `modelPricing` half. The
 * superseded readings were "Once the fetch succeeds, the withheld variables
 * apply for the rest of the session" and "The withheld environment variables
 * remain withheld until a fetch succeeds"; recorded, not overwritten.
 *
 * The returned `withheld` record carries NAMES only. The values are the whole
 * reason this module exists — a withheld list that leaked them into a log
 * would hand over the credential it was protecting.
 */
export function resolveManagedEnv(
  env: Readonly<Record<string, string>> | undefined,
  options: { source: ManagedEnvSourceV1; confirmed: boolean },
): ManagedEnvResolutionV1 {
  if (!env || Object.keys(env).length === 0) {
    return Object.freeze({ applied: Object.freeze({}), withheld: NO_WITHHELD, withholding: false })
  }
  if (options.source === 'managed-file' || options.confirmed) {
    const passthrough: Record<string, string> = {}
    for (const [name, value] of Object.entries(env)) {
      if (isRefusedManagedEnvVar(name)) continue
      passthrough[name] = value
    }
    return Object.freeze({
      applied: Object.freeze(passthrough),
      withheld: NO_WITHHELD,
      withholding: false,
    })
  }

  const applied: Record<string, string> = {}
  const withheld = emptyWithheldBuckets()
  for (const [name, value] of Object.entries(env)) {
    if (isRefusedManagedEnvVar(name)) continue
    const category = classifyManagedEnvVar(name)
    if (category === 'immediate') applied[name] = value
    else withheld[category].push(name)
  }
  const frozenWithheld = freezeWithheld(withheld)
  return Object.freeze({
    applied: Object.freeze(applied),
    withheld: frozenWithheld,
    withholding: MANAGED_ENV_WITHHELD_CATEGORIES.some(key => frozenWithheld[key].length > 0),
  })
}

export interface ManagedEnvApplicationV1 extends ManagedEnvResolutionV1 {
  /** Names actually written to the target environment by this call. */
  readonly set: readonly string[]
}

/* ------------------------------------------------------------------------- *
 * Composing `env` across the two admin sources
 * ------------------------------------------------------------------------- */

/**
 * `env` is the ONE key that merges across admin sources.
 *
 * Every other key follows the winner-takes-all rule `managed-composition.ts`
 * documents. `env` is the documented exception, and the exception is recent —
 * `managed-settings.md#keys-read-from-every-admin-source`:
 *
 *   "`env`, merged per variable across the admin sources: each variable comes
 *   from the highest-priority source that defines it, so lower sources fill in
 *   variables the higher ones leave unset. A few variables follow their own
 *   rules; Per-key exceptions across managed sources names each one. Requires
 *   Claude Code v2.1.223 or later. Before v2.1.223, Claude Code applied the
 *   selected source's whole `env` block only."
 *
 * `server-managed-settings.md#per-key-exceptions-across-managed-sources` states
 * the same rule from the delivery side and adds the third clause, the one that
 * is easy to miss:
 *
 *   "An endpoint-managed `env` entry therefore applies whenever the
 *   server-managed configuration leaves that variable unset, or while a cached
 *   server value for it is withheld pending server confirmation."
 *
 * So the merge is not static. A delivered variable that is currently WITHHELD
 * does not occupy its slot, and the file's value stands in until the fetch
 * confirms. {@link ManagedEnvCompositionV1.standby} carries exactly that.
 *
 * ## Why this cannot weaken the higher source
 *
 * The direction is fill-in only: the delivered payload wins every variable it
 * defines, and the file supplies only variables the delivered payload left
 * unset. Both of our sources are admin-controlled — the delivered payload comes
 * from the gateway, and the file is the root-owned `managed-policy.json` whose
 * loader refuses a non-root, group-writable or symlinked path — so there is no
 * user-writable tier here to widen anything. The HKCU tier the documentation
 * excludes from this scan has no counterpart in this fork.
 *
 * The residual hazard is real and worth naming: a stale `env` left on a disk
 * image now outlives the payload that replaced it, for the variables that
 * payload does not set. That is the same objection `managed-composition.ts`
 * raises against unioning deny lists, and the reason it does not apply here is
 * that a variable, unlike a deny rule, is RECLAIMABLE — an administrator takes
 * a variable back by setting it in the higher source, which is precisely what
 * the per-variable rule guarantees.
 */
export type ManagedEnvOriginV1 = 'delivered' | 'file'

/**
 * The telemetry unit — `server-managed-settings.md#per-key-exceptions-across-managed-sources`:
 *
 *   "Telemetry unit: the `OTEL_EXPORTER_OTLP_*` exporter keys, the `OTEL_LOG_*`
 *   content-capture toggles, `OTEL_LOGS_EXPORTER`, and the beta tracing
 *   variables `ENABLE_BETA_TRACING_DETAILED` and `BETA_TRACING_ENDPOINT` follow
 *   the highest source that sets any of them as a unit."
 *
 * With the reason spelled out in the same paragraph: "an exporter endpoint from
 * one source can never pair with credentials from another."
 *
 * This is not decoration on the merge — it is what keeps the merge from being a
 * REGRESSION. `OTEL_EXPORTER_OTLP_HEADERS` is classified `immediate` above,
 * because the remainder sentence says telemetry applies at startup, so it is
 * never withheld. A
 * per-variable merge without this rule would let a file-supplied
 * `OTEL_EXPORTER_OTLP_HEADERS` pair with a delivered
 * `OTEL_EXPORTER_OTLP_ENDPOINT` immediately, shipping one administrator's
 * credentials to the other's endpoint. The whole-block behaviour we are
 * replacing could not do that.
 *
 * ## The credential-paired routing exception: unreachable BY DECISION (P3.67)
 *
 * The same list carries a second exception —
 * `#per-key-exceptions-across-managed-sources`, verbatim: "**Credential-paired
 * routing**: a source that pairs routing variables with a selected-source-only
 * credential key, such as `apiKeyHelper` or `otelHeadersHelper`, contributes
 * those routing variables only when it wins the slot."
 *
 * It is INERT here, and this comment used to stop at the observation — which
 * is the shape that reads as coverage: an implemented safety exception nobody
 * can reach looks identical to one nobody wrote. **Neither is true. Nothing
 * implements it, and nothing is meant to**, because both of its keys are
 * *shell command settings* (`#settings-that-require-approval`: "settings that
 * execute shell commands, such as `apiKeyHelper`, `statusLine`, and
 * `otelHeadersHelper`"), and this product does not accept an admin-supplied
 * executable as a settings source. That is the same owner decision of
 * 2026-08-08 that dropped `policyHelper` (R50 `managed-policy-sources`,
 * verbatim: "Not deferred — out of scope for this product"), reached
 * independently in P3.63 on containment grounds; the two helper keys here
 * differ from `policyHelper` only in what the executable's output is used for.
 *
 * So the exception is not built, not deferred, and not a gap: it is
 * unreachable because `ManagedPiPolicyV1` accepts neither key (measured — 0
 * occurrences of either name in `agent/pi-harness/managed-policy.ts`, positive
 * control on the same file: `'env'` 3). What must not happen is the HALF
 * state — a future schema admitting `apiKeyHelper` without the exception
 * beside it, which would let one administrator's routing variables ride in on
 * another administrator's credential, the exact pairing the telemetry rule
 * above exists to forbid. `__tests__/managed-env-credential-paired-routing.test.ts`
 * fails on exactly that, so the decision cannot decay into a defect quietly.
 */
const TELEMETRY_UNIT_PREFIXES = ['OTEL_EXPORTER_OTLP_', 'OTEL_LOG_'] as const

const TELEMETRY_UNIT_NAMES: ReadonlySet<string> = new Set([
  'OTEL_LOGS_EXPORTER',
  'ENABLE_BETA_TRACING_DETAILED',
  'BETA_TRACING_ENDPOINT',
])

/** Whether `name` belongs to the telemetry unit above. */
export function isTelemetryUnitEnvVar(name: string): boolean {
  return TELEMETRY_UNIT_NAMES.has(name)
    || TELEMETRY_UNIT_PREFIXES.some(prefix => name.startsWith(prefix))
}

export interface ManagedEnvCompositionV1 {
  /** The merged block: every variable an admin source supplies, once confirmed. */
  readonly env: Readonly<Record<string, string>>
  /** Which admin source each variable in {@link env} came from. */
  readonly origins: Readonly<Record<string, ManagedEnvOriginV1>>
  /**
   * Endpoint-managed values that stand in while the delivered value for the
   * same variable is withheld pending server confirmation.
   *
   * Never populated for a telemetry-unit variable: standing in for a withheld
   * delivered value there would pair the two sources, which is the one thing
   * the unit rule exists to forbid.
   */
  readonly standby: Readonly<Record<string, string>>
}

export const EMPTY_MANAGED_ENV_COMPOSITION: ManagedEnvCompositionV1 = Object.freeze({
  env: Object.freeze({}),
  origins: Object.freeze({}),
  standby: Object.freeze({}),
})

/**
 * Merge the two admin sources' `env` blocks per variable.
 *
 * `delivered` is the higher-priority source (`managed-settings.md#how-claude-code-combines-managed-sources`
 * ranks remote settings above managed settings files).
 */
export function composeManagedEnv(
  delivered: Readonly<Record<string, string>> | undefined,
  file: Readonly<Record<string, string>> | undefined,
): ManagedEnvCompositionV1 {
  const deliveredEntries = delivered ?? {}
  const fileEntries = file ?? {}
  const names = [...new Set([...Object.keys(deliveredEntries), ...Object.keys(fileEntries)])].sort()
  if (names.length === 0) return EMPTY_MANAGED_ENV_COMPOSITION

  // The unit is claimed BEFORE any variable is placed: "the highest source that
  // sets any of them" owns all of them, so one member in the delivered payload
  // excludes the file's whole telemetry configuration, not just that member.
  const unitOwner: ManagedEnvOriginV1 | undefined =
    Object.keys(deliveredEntries).some(isTelemetryUnitEnvVar) ? 'delivered'
      : Object.keys(fileEntries).some(isTelemetryUnitEnvVar) ? 'file'
        : undefined

  const env: Record<string, string> = {}
  const origins: Record<string, ManagedEnvOriginV1> = {}
  const standby: Record<string, string> = {}
  for (const name of names) {
    // Dropped from the composition itself, not just from what gets applied, so
    // no consumer of `env`/`origins`/`standby` can re-introduce it downstream.
    // See {@link isRefusedManagedEnvVar} for why this one is refused.
    if (isRefusedManagedEnvVar(name)) continue
    const fromDelivered = deliveredEntries[name]
    const fromFile = fileEntries[name]
    if (isTelemetryUnitEnvVar(name)) {
      const value = unitOwner === 'delivered' ? fromDelivered : fromFile
      if (value === undefined || unitOwner === undefined) continue
      env[name] = value
      origins[name] = unitOwner
      continue
    }
    if (fromDelivered !== undefined) {
      env[name] = fromDelivered
      origins[name] = 'delivered'
      if (fromFile !== undefined) standby[name] = fromFile
      continue
    }
    if (fromFile === undefined) continue
    env[name] = fromFile
    origins[name] = 'file'
  }
  return Object.freeze({
    env: Object.freeze(env),
    origins: Object.freeze(origins),
    standby: Object.freeze(standby),
  })
}

/**
 * Split a COMPOSED block into what applies now and what waits, per variable.
 *
 * {@link resolveManagedEnv} answers the same question for a block that came
 * from one source; this one answers it when the block came from both, which is
 * the state the per-variable merge creates. The withhold decision is made
 * against each variable's OWN origin, because the hardening is scoped to the
 * server-fetched cache and "endpoint-managed settings deployed through MDM or
 * `managed-settings.json` are unaffected" — a file-origin variable is never
 * withheld, whatever category it falls in.
 *
 * A withheld delivered variable is still REPORTED as withheld even when the
 * file's standby value is applied in its place: the server's value genuinely is
 * being held back, and the diagnostics surface exists to say so.
 */
export function resolveComposedManagedEnv(
  composition: ManagedEnvCompositionV1 | undefined,
  options: { confirmed: boolean },
): ManagedEnvResolutionV1 {
  if (!composition || Object.keys(composition.env).length === 0) {
    return Object.freeze({ applied: Object.freeze({}), withheld: NO_WITHHELD, withholding: false })
  }

  const applied: Record<string, string> = {}
  const withheld = emptyWithheldBuckets()
  for (const [name, value] of Object.entries(composition.env)) {
    if (isRefusedManagedEnvVar(name)) continue
    const origin = composition.origins[name] ?? 'delivered'
    const category = classifyManagedEnvVar(name)
    if (origin === 'file' || options.confirmed || category === 'immediate') {
      applied[name] = value
      continue
    }
    withheld[category].push(name)
    const standIn = composition.standby[name]
    if (standIn !== undefined) applied[name] = standIn
  }
  const frozenWithheld = freezeWithheld(withheld)
  return Object.freeze({
    applied: Object.freeze(applied),
    withheld: frozenWithheld,
    withholding: MANAGED_ENV_WITHHELD_CATEGORIES.some(key => frozenWithheld[key].length > 0),
  })
}

/* ------------------------------------------------------------------------- *
 * Managed origin
 * ------------------------------------------------------------------------- */

/**
 * Which variables in THIS process's environment were put there by a managed
 * source.
 *
 * `server-managed-settings.md#settings-precedence` — "Server-managed settings
 * and endpoint-managed settings both occupy the highest tier in the Claude Code
 * settings hierarchy. No other settings level can override them, including
 * command line arguments, apart from the exceptions to managed settings
 * precedence." That trailing clause is NEW since this file quoted the sentence,
 * and it is the half a truncated quote loses: the tier is highest with
 * documented exceptions, not absolutely. Once a managed `env` block lands in `process.env`,
 * that fact is indistinguishable from an operator's shell export unless
 * somebody records it, and a lower tier that cannot tell the two apart will
 * happily overwrite the admin's value. `proxy-env.ts` did exactly that with
 * `NODE_EXTRA_CA_CERTS`.
 *
 * Recorded per NAME only. A value is never held here; the classification table
 * above exists precisely because these values are proxies, certificate paths
 * and credentials.
 */
const managedOriginNames = new Set<string>()

/** Whether this process's `name` came from a managed source. */
export function isManagedOriginEnvVar(name: string): boolean {
  return managedOriginNames.has(name)
}

export function managedOriginEnvVars(): readonly string[] {
  return Object.freeze([...managedOriginNames].sort())
}

/** Test/process seam. */
export function clearManagedOriginEnvVars(): void {
  managedOriginNames.clear()
}

/**
 * Apply the resolved block to a process environment.
 *
 * Managed settings are the highest tier (`#settings-precedence` — "No other
 * settings level can override them, including command line arguments, apart
 * from the exceptions to managed settings precedence"), so a managed value
 * overwrites the ambient one. Every spawn site in this repo spreads
 * `process.env`, so writing here is what carries the block into the Pi
 * subprocess, the Claude subprocess and stdio MCP servers without a second
 * projection to keep in step.
 *
 * Re-running after the fetch confirms is how the remainder sentence releases
 * the withheld variables:
 * the same call with `confirmed: true` writes the variables the first call held
 * back.
 */
export function applyManagedEnv(
  env: Readonly<Record<string, string>> | undefined,
  options: {
    source: ManagedEnvSourceV1
    confirmed: boolean
    target?: Record<string, string | undefined>
  },
): ManagedEnvApplicationV1 {
  return writeResolution(resolveManagedEnv(env, options), options.target)
}

/**
 * Apply a COMPOSED block — the merge of both admin sources — to a process
 * environment.
 *
 * Same write semantics as {@link applyManagedEnv}; the difference is upstream,
 * in {@link resolveComposedManagedEnv} deciding the withhold per variable
 * against that variable's own origin.
 */
export function applyComposedManagedEnv(
  composition: ManagedEnvCompositionV1 | undefined,
  options: { confirmed: boolean; target?: Record<string, string | undefined> },
): ManagedEnvApplicationV1 {
  return writeResolution(resolveComposedManagedEnv(composition, options), options.target)
}

/* ------------------------------------------------------------------------- *
 * The composed-env reader for this process
 * ------------------------------------------------------------------------- */

/**
 * The composition is computed in `server-core`
 * (`bootstrap/managed-policy-resolution.ts`), which `packages/shared` cannot
 * import — the same wall `registerManagedPiPolicyProvider` and its three
 * single-key siblings already climb with a registered reader.
 *
 * Unregistered means "no file source to compose with", and
 * {@link applyManagedDeliveryEnv} then behaves exactly as it did before the
 * merge existed: the delivered payload alone, under `source: 'server-cache'`.
 * That is the whole fallback — every host that does not register, and every
 * test that never calls this, keeps the old behaviour byte for byte.
 *
 * Re-resolved on every read, like its siblings: a delivered payload that lands
 * after registration is seen by the next application, which is what makes
 * `startManagedDeliveryEnvApplication`'s re-run on confirmation carry the
 * composed block rather than a snapshot of it.
 */
let composedManagedEnvProvider: (() => ManagedEnvCompositionV1 | undefined) | undefined

/** Register the composed-`env` reader for this process. */
export function registerComposedManagedEnvProvider(
  provider: (() => ManagedEnvCompositionV1 | undefined) | undefined,
): void {
  composedManagedEnvProvider = provider
}

/**
 * The composed `env` for this process, or `undefined` when nothing registered
 * one. Never throws — a provider that does yields no composition rather than
 * taking the boot path down with it.
 */
export function resolveComposedManagedEnvSources(): ManagedEnvCompositionV1 | undefined {
  try {
    return composedManagedEnvProvider?.()
  } catch {
    return undefined
  }
}

function writeResolution(
  resolution: ManagedEnvResolutionV1,
  explicitTarget: Record<string, string | undefined> | undefined,
): ManagedEnvApplicationV1 {
  const target = explicitTarget ?? process.env
  // The origin registry describes THIS PROCESS's environment, so it is only
  // written when the real one is. A caller passing its own target is projecting
  // an environment for something else and must not claim managed origin here.
  const real = explicitTarget === undefined
  const set: string[] = []
  for (const [name, value] of Object.entries(resolution.applied)) {
    // Recorded even when the value is unchanged: a managed block that happens to
    // repeat the ambient value is still the managed tier speaking, and the
    // precedence question `isManagedOriginEnvVar` answers does not depend on
    // whether a write was needed.
    if (real) managedOriginNames.add(name)
    if (target[name] === value) continue
    // DELETE BEFORE ASSIGN — P2.487, and it is the reason this whole docblock's
    // "every spawn site spreads `process.env`" claim was TRUE of the host and
    // FALSE of the children. Measured on Bun 1.3.14 in a fresh child, with an
    // arbitrary name assigned the same way as the positive control:
    //
    // | what                             | property read | `Object.keys` | `{...env}` |
    // | -------------------------------- | ------------- | ------------- | ---------- |
    // | `env.HTTPS_PROXY = …` (unset)    | the value     | **absent**    | **absent** |
    // | same, after `delete` first       | the value     | present       | present    |
    // | an ARBITRARY name, same shape    | the value     | present       | present    |
    //
    // Two conditions, and BOTH are needed — which is why the bug looks
    // machine-dependent rather than universal:
    //  - the name is one Bun special-cases. Of this module's 111 classified
    //    names, SEVEN are: the six proxy spellings and
    //    `NODE_TLS_REJECT_UNAUTHORIZED`. `ALL_PROXY`/`all_proxy` are NOT, so
    //    "the proxy names" is the wrong generalisation. Nothing constrains the
    //    set to the classification table — an admin `env` block carries
    //    arbitrary names, and `TZ` and `BUN_CONFIG_VERBOSE_FETCH` measured
    //    affected too — so the delete is UNCONDITIONAL rather than gated on a
    //    list that cannot be complete.
    //  - the name is ABSENT from the launch environment. Overwriting an
    //    inherited `HTTPS_PROXY` was always visible; INTRODUCING one — the
    //    ordinary case for an administrator mandating a proxy — was not.
    //
    // The failure direction is a pass: the host reads the managed value back
    // correctly while `buildPiSubprocessEnv`, `buildClaudeSubprocessEnv` and
    // `CodexRuntimeManager.spawn` — all three `{ ...process.env }` — carry
    // nothing. Uniform across the runtimes, so nothing looks asymmetric.
    // `config/network-runtime.ts:projectProxyEnv` carries the same rule for the
    // proxy projection (P2.261).
    //
    // Residue, stated rather than defended against: the `continue` above skips
    // a name whose value already matches, so a FOREIGN naive writer that left
    // the name invisible with this exact value would not be repaired here. No
    // such writer exists in `packages/`/`apps/` today (`git grep -a` for a
    // direct assignment to any of the seven → 0 outside comments; control on
    // the same rig: `process.env.<UPPER> = ` → 5+ files).
    delete target[name]
    target[name] = value
    set.push(name)
  }
  return Object.freeze({ ...resolution, set: Object.freeze(set.sort()) })
}
