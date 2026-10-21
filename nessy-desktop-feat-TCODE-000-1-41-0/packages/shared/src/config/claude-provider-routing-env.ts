/**
 * Cloud-provider routing env vars for the Claude SDK subprocess — the single
 * source of truth for every strip site. Nessy's invariant is that no ambient
 * cloud-provider tier may be reachable from the Claude SDK path: the
 * connection card in Settings decides where a turn goes, never the host shell.
 *
 * ## Membership rule: every TOGGLE, no COMPANION
 *
 * The shipped SDK carries its own enumeration of this exact set — a 14-name
 * array, identified by its CONTENT rather than by a minified name: the longest
 * literal opening `["CLAUDE_CODE_USE_BEDROCK",…`, present in both `sdk.mjs`
 * and the native `claude` binary the SDK spawns. It splits cleanly in two:
 *
 * (These lines cited `Fk` and `HTe` while we were on `0.3.223`. The
 * `0.3.223 → 0.3.233` bump reassigned every one of those identifiers — `Fk`,
 * `zk`, `Bk` and `jNe` now name unrelated OpenTelemetry and AJV internals —
 * and NOTHING failed, because a minified name in prose is checked by nobody.
 * The guard beside this file matches the literal, so it survived the bump;
 * write citations the same way.)
 *
 * - **Seven TOGGLES** — each one, on its own, SELECTS a provider. Measured in
 *   the native binary's provider selector: `function Mn(){ if($y())
 *   return"gateway"; return te.CLAUDE_CODE_USE_BEDROCK?"bedrock":
 *   te.CLAUDE_CODE_USE_FOUNDRY?"foundry":te.CLAUDE_CODE_USE_ANTHROPIC_AWS?
 *   "anthropicAws":te.CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD?
 *   "anthropicGoogleCloud":te.CLAUDE_CODE_USE_MANTLE?"mantle":
 *   te.CLAUDE_CODE_USE_VERTEX?"vertex":"firstParty" }`. Six of the seven sit
 *   in that one ternary chain; the seventh, `CLAUDE_CODE_USE_GATEWAY`, is the
 *   `$y()` arm AHEAD of all of them. Its startup reader — located by the error
 *   string it throws, `"CLAUDE_CODE_USE_GATEWAY is set but ANTHROPIC_BASE_URL
 *   is invalid"` (**1** occurrence in the shipped binary; control
 *   `CLAUDE_CODE_NOT_A_REAL_ANCHOR` **0**) — installs a session with
 *   `unpinned:!0` given ambient `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`,
 *   i.e. exempt from the TLS-fingerprint pin (`!!e&&!e.unpinned`) every other
 *   gateway restore enforces. All seven are stripped.
 * - **Seven COMPANIONS** (`ANTHROPIC_FOUNDRY_RESOURCE`,
 *   `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_AWS_WORKSPACE_ID`,
 *   `ANTHROPIC_GOOGLE_CLOUD_PROJECT` / `_LOCATION` / `_WORKSPACE_ID`,
 *   `CLOUD_ML_REGION`) — inputs a provider consumes only ONCE a toggle has
 *   selected it. With every toggle stripped they are unreachable by
 *   construction, so they stay, and the subprocess keeps the user's shell
 *   intact. Generic `AWS_*` (AWS_REGION, AWS_ACCESS_KEY_ID, …) is excluded for
 *   the same reason.
 *
 * That is R40's rule (`plans/2026-08-04-doc-sweep-parity-wave.md`, `688a4c37a`)
 * restated, not overturned: R40 excluded variables that "only route Claude when
 * one of the toggles above is set". It admitted nine names because it built the
 * list from the documentation, and the documentation cannot see two of the
 * seven toggles — see below. A toggle was never in scope for that exclusion.
 *
 * ## Which names the docs can and cannot justify
 *
 * - authentication.md § "Authentication precedence" tier 1: "Cloud provider
 *   credentials, when `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or
 *   `CLAUDE_CODE_USE_FOUNDRY` is set" — the top tier, above any key we write.
 * - amazon-bedrock.md § "Mantle environment variables": `CLAUDE_CODE_USE_MANTLE`
 *   (enable), `ANTHROPIC_BEDROCK_MANTLE_BASE_URL` (endpoint override),
 *   `CLAUDE_CODE_SKIP_MANTLE_AUTH` ("Skip client-side authentication for proxy
 *   setups" — an auth switch, stripped for the same reason).
 * - `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `AWS_BEARER_TOKEN_BEDROCK` and
 *   `ANTHROPIC_BEDROCK_BASE_URL`: env-vars.md / claude-platform-on-aws.md.
 * - **`CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` and `CLAUDE_CODE_USE_GATEWAY`
 *   appear in ZERO of the 191 pages of Claude Code's published documentation**
 *   (measured 2026-08-28 over the full corpus in `scripts/claude-doc-pages.tsv`;
 *   positive control on the same rig: `CLAUDE_CODE_USE_BEDROCK` 18 pages,
 *   `_VERTEX` 14, `_FOUNDRY` 10, `_ANTHROPIC_AWS` 7, `_MANTLE` 6 — and the
 *   three `ANTHROPIC_GOOGLE_CLOUD_*` companions are likewise 0). For these two
 *   the vendored SDK IS the only contract, and a doc-derived membership list is
 *   structurally blind to them. That blindness is why they were missing here
 *   for a month, and why the guard beside this file reads the SDK's own array
 *   rather than a page.
 *
 * ## Why the endpoint/credential four stay, and the other ten do not join them
 *
 * R40 also admitted four names from OUTSIDE the SDK's routing array —
 * `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`,
 * `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`, `CLAUDE_CODE_SKIP_MANTLE_AUTH` — and
 * they are the documented three-plus-one: the pages above name them, and the
 * pages name none of their siblings. That is the whole reason the set is
 * partial, and until now it was the ONLY reason, written down nowhere.
 *
 * The shipped binary has six of each family, not two and one:
 * `ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY,AWS,GOOGLE_CLOUD,BEDROCK_MANTLE}_BASE_URL`
 * and `CLAUDE_CODE_SKIP_{BEDROCK,VERTEX,FOUNDRY,ANTHROPIC_AWS,
 * ANTHROPIC_GOOGLE_CLOUD,MANTLE}_AUTH` (the latter read verbatim off the
 * bundle's own skip-auth array — again by content, not by the minified name
 * this line used to give). **Measured in the native binary 2026-08-28, every one of
 * the twelve is read only after a toggle has already selected its provider**,
 * so all twelve — the four we strip included — are COMPANIONS, not the
 * "route or authenticate on their own" that the comment here used to claim:
 *
 * - `if(y==="vertex"){let A=tr(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH) …}`
 *   and `if(tr(process.env.CLAUDE_CODE_USE_MANTLE)&&
 *   !tr(process.env.CLAUDE_CODE_SKIP_MANTLE_AUTH))pRn();` — every skip-auth
 *   read is paired with its own toggle, `_MANTLE` exactly like the five we do
 *   not strip.
 * - Every base URL is read inside its provider's client constructor
 *   (`constructor({baseURL:e=g3o("ANTHROPIC_VERTEX_BASE_URL") …})`,
 *   `{…te.ANTHROPIC_BEDROCK_BASE_URL&&{endpoint:te.ANTHROPIC_BEDROCK_BASE_URL}}`),
 *   and `AWS_BEARER_TOKEN_BEDROCK` inside the Bedrock and Mantle ones.
 *
 * With all seven toggles stripped, `Mn()` can only return `"firstParty"`, so
 * no provider client is ever constructed and none of the twelve is reachable.
 * **The decision (P3.112) is therefore: the ten stay OUT and the four stay IN.**
 * Adding the ten buys no measurable containment and would delete names from a
 * user's shell inside the subprocess for nothing, which is precisely what
 * R40's companion exclusion exists to prevent; removing the four would be a
 * live behaviour change, also for nothing, and they cost the same shell
 * tooling only in the one provider family the pages actually document. The set
 * is asymmetric because its two halves have different membership rules — every
 * toggle, plus the documented companions R40 already shipped — and that is now
 * a recorded reason instead of an unexplained residue.
 *
 * A leaf module with no imports, so all three consumers (`agent/options.ts`
 * subprocess-env builder, `config/llm-connections.ts` host-env clearing, and
 * `config/managed-env.ts`, which DERIVES its `routing` classification for the
 * seven toggles from the array below) can import it without cycles, and it
 * stays renderer-safe by construction. Extend THIS file — not a call site, and
 * never a second hand-kept copy — when the SDK grows a new provider toggle;
 * `__tests__/claude-provider-routing-env.test.ts` fails on an SDK bump that
 * adds one, and `__tests__/managed-env.test.ts` fails if a name in this file
 * is left applicable at startup by the managed classifier.
 *
 * **The file exports THREE lists and the strip sites read the union, not the
 * cloud-provider array.** `CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS` is the
 * cloud-provider half, pinned name-by-name against the SDK's own 14-name array;
 * `CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS` is P3.113's single non-provider name,
 * which that array does not contain and which its guard must therefore not
 * expect; `CLAUDE_SDK_STRIPPED_ENV_KEYS` is what `agent/options.ts` and
 * `config/llm-connections.ts` actually iterate. Adding a non-provider name to
 * the first array would break the SDK-derived guard, which is why it has its
 * own constant rather than a widened one.
 */

/**
 * The seven provider TOGGLES, in the shipped SDK array's own order.
 *
 * Exported on its own because `config/managed-env.ts` needs exactly this
 * subset: a toggle is a provider SELECTION, which is the managed classifier's
 * `routing` category, while the four names below it are an endpoint and three
 * credentials that already carry their own categories there. Deriving that
 * table from this array is what keeps the two from drifting — a second
 * hand-maintained list is the defect this file was written to fix, not a fix.
 */
export const CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
] as const

/**
 * The documented endpoint/credential companions R40 admitted, kept for the
 * reason recorded above — not because they route on their own, which the
 * binary says they do not.
 */
export const CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS = [
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
] as const

/** Every CLOUD-PROVIDER name stripped from the Claude SDK subprocess and the host env. */
export const CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS = [
  ...CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS,
  ...CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS,
] as const

/**
 * The FIRST-PARTY ASSUMPTION flag — its own constant, because it is not a
 * cloud-provider name and must not be filed under one (P3.113).
 *
 * ## What it is, measured — not what its name says
 *
 * Despite the `_BASE_URL` suffix it is a **boolean**, not a URL: it is declared
 * through the bundles' own boolean accessor idiom — spelled `Z_y=qe.bool()` in
 * the native `claude` binary and `Dke=d.bool()` in `sdk.mjs` at the vendored
 * `0.3.233` / `claudeCodeVersion 2.1.233` (`GIT_SHA
 * f8d57569aaf350fe25dc4dfa10cad59db8ea4d45`). **Re-read at the vendored
 * `0.3.247` / `claudeCodeVersion 2.1.247` (C3.252, 2026-09-12): still a boolean,
 * and every letter in that sentence moved** — the sdk.mjs idiom is now
 * `<name>=d.bool()` under different names, so read the accessor by its SHAPE and
 * not by those bindings. The 2.1.247 bytes carry their own build constants:
 * `VERSION:"2.1.247"`, `GIT_SHA:"89c726188daf6407b6b57bf67d312f2958e5b9f2"`,
 * `BUILD_TIME:"2026-08-26T05:55:19Z"`. The name appears in **zero
 * of the 191 published documentation pages** (P3.84's census), so the shipped
 * artefact is the only contract — the same shape as
 * `CLAUDE_CODE_USE_GATEWAY` above.
 *
 * It widens exactly one predicate, verbatim from the binary:
 *
 *   `function Mf(){if(V._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return Mit()}`
 *   `function Mit(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return Vxe(e)}`
 *
 * Transcribed at `2.1.233`. Re-read at `2.1.247` (2026-09-12) the first
 * predicate is byte-identical in substance and every letter moved again —
 * `function O(){if(s._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return J()}`
 * — which is why the name inside it, and not the minified wrapper, is the
 * anchor. The name itself scores 9 lines / 12 occurrences in that binary and
 * 2/3 in `sdk.mjs`, both instruments named because they disagree on a minified
 * artefact (C3.294).
 *   `function Vxe(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}`
 *
 * `Mf()` is "the endpoint this session talks to is Anthropic's own". Setting
 * the flag makes it answer yes for ANY host. It does not change the provider
 * kind — that stays `firstParty` while no toggle above is set — which is
 * precisely why the P3.112 argument for the ten companions does not carry
 * here: they are unreachable once every toggle is stripped, and this one is
 * reachable **by construction in our deployment**, where a `claude-runtime`
 * session always runs `firstParty` against
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` — the per-session gateway
 * adapter in front of the Nestor gateway.
 *
 * ## Why an ambient value is stripped rather than honoured
 *
 * `Mf()` has 39 call sites in the shipped binary. Against a foreign endpoint
 * the flag turns on, among others:
 *
 * - **Error reporting to Anthropic**: `aqu(){…if(Jn()!=="firstParty"||!Mf())return!1;…}`
 *   gates the crash/`logError` reporter. Off for us today; the flag turns it on.
 * - **First-party request correlation**: the `x-anthropic-billing-header` gains
 *   `cch=00000;`, `cc_prev_req=<request id>` and `cc_prompt_id=<uuid>`, each
 *   guarded by `i==="firstParty"&&Mf()` — identifiers minted for Anthropic's
 *   own endpoint, emitted at the bank's gateway instead.
 * - **W3C trace propagation**: `Z9t(){return Mf()||V.CLAUDE_CODE_PROPAGATE_TRACEPARENT}`.
 * - **Org / multi-store memory sync eligibility** — the two predicates guarding
 *   it both open `if(!Mf())return!1`; find the cluster by the gate string
 *   `"allow_memory_sync"` (**4**) or the export `isMultiStoreSyncAvailable`
 *   (**2**), never by their minified names.
 * - **Capability assumptions the gateway cannot honour**: 1M context (`Z2`),
 *   optimistic tool search (`iB`), fine-grained tool streaming, the
 *   `anthropic-usage-limit: extended` header, and the model rows
 *   `VZs` otherwise suppresses with `suppressed_rows_foreign_base_url`.
 *
 * That is the same posture the toggles above are stripped under — *the
 * connection card in Settings decides where a turn goes and what the client
 * believes about it, never the host shell* — and unlike a companion, stripping
 * costs a user nothing: the name is vendor-internal, underscore-prefixed, and
 * carries no meaning to any other tool on the machine.
 *
 * One measured NON-consequence, kept so nobody re-derives it: the binary
 * states in its own operator text that the flag
 * *"does not apply to Remote Control"*, and the gateway model-discovery gate —
 * located by `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` (**6**) or the cache
 * file `"gateway-models.json"` (**2**) — requires `!Mf()`, so setting the flag
 * would DISABLE gateway model discovery rather than enable it.
 */
export const CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS = [
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
] as const

/**
 * The CORPORATE-LAUNCHER names — scrubbed from the Claude child env ONLY, and
 * ANNOUNCED rather than silently dropped (P3.300, extended by P6.587).
 *
 * The membership rule is one question: **does this name decide WHICH PROCESS
 * actually runs the agent's shell command, on claude and on claude alone?** A
 * prefix, a wrapper argv and a shell binary are three spellings of the same
 * decision, and all three are honoured by exactly one of our three runtimes.
 *
 * Measured in the shipped binary (`claudeCodeVersion 2.1.247`; re-measured
 * 2026-09-12, C3.252, each count as lines/occurrences because the two
 * instruments disagree on a minified artefact — C3.294), with a
 * positive control on the same rig (`CLAUDE_CODE_NOT_A_REAL_NAME` → 0/0):
 * `CLAUDE_CODE_SHELL_PREFIX` → 12 lines / 23 occurrences (it read 10 at
 * 2.1.233), read on the Bash path
 * (`if(V.CLAUDE_CODE_SHELL_PREFIX)return"{ shopt -u extglob || setopt …"`);
 * `CLAUDE_CODE_PROCESS_WRAPPER` → 14 lines / 20 occurrences (it read 13 at
 * 2.1.233), and the binary's own settings schema
 * describes its `processWrapper` twin as the *"Corporate launcher argv prefix
 * for the background-agent supervisor, the sessions and workers it hosts…
 * Equivalent to the CLAUDE_CODE_PROCESS_WRAPPER environment variable, which
 * takes precedence when set."*
 *
 * `CLAUDE_CODE_SHELL` → **7** standalone occurrences, and that figure is
 * UNCHANGED across the lift although both of its operands moved: 30 occurrences
 * for the substring at 2.1.247 minus the 23 that are its `_PREFIX` twin, where
 * at 2.1.233 it was 17 minus 10. It is a subtraction and not a grep, because the
 * short name is contained in the long one — a probe handing both needles to one
 * `grep -f` reports the standalone figure for the short one and silently
 * attributes the overlap to the long one (C3.294). It is a shell OVERRIDE, verbatim:
 *
 *   async function l5b(){ let e=V.CLAUDE_CODE_SHELL; if(e) if((e.includes("bash")
 *   ||e.includes("zsh")) && await eya(e)) return w("Using shell override: "+e),e;
 *   else w('CLAUDE_CODE_SHELL="'+e+'" is not a valid bash/zsh path, falling back
 *   to detection') … }
 *
 * — and the Bash tool's own telemetry records the fact under
 * `executor_shell_overridden:Boolean(process.env.CLAUDE_CODE_SHELL)`. So the
 * binary picks the interpreter the agent's commands run in from the host shell.
 * `env-vars.md#variables` says the same in the published contract, verbatim:
 * *"Set the shell Claude Code uses to run Bash tool commands. Accepts a path to
 * a `bash` or `zsh` binary, for example `/opt/homebrew/bin/bash`."*
 *
 * **Why they are not in the silent union above.** The provider names are
 * stripped because an ambient value would OVERRIDE the connection the user
 * chose. These are different: an administrator who sets a launcher prefix or a
 * shell means it, and on Claude the binary would honour it — while Pi and codex
 * have no counterpart and our own three host spawn sites consult none of them.
 * Honouring it would therefore be a launcher policy that applies on ONE runtime
 * of three, silently, which is the divergence class this fork is closing.
 * Dropping it without saying so would be the same defect wearing the opposite
 * sign, so the scrub carries a diagnostic naming the variable and the reason.
 *
 * The no-counterpart half is measured, not assumed (P6.587, 2026-09-06):
 * `CODEX_SHELL` scores **0** in the shipped codex binary — the only hit for
 * that prefix is `CODEX_SHELL_SNAPSHOT_STATE_`, which snapshots the env rather
 * than selecting an interpreter — against controls `CODEX_HOME` 73 and
 * `OPENAI_API_KEY` 23 on the same rig; and across the seven vendored
 * `@earendil-works/*` packages `env.SHELL` and `PI_SHELL` score **0 files**
 * against controls `process.env` 68 files and `bash` 36 files.
 *
 * Scrubbed from the CHILD env only, never from the host `process.env`: the Pi
 * subprocess is spawned from the same host environment and clearing it there
 * would silently change a runtime this row is not about.
 *
 * The real seam — one launcher honoured by all three — is P6.9 and is owner
 * DEFERRED-LAST; when it lands, this list and its diagnostic go away together.
 *
 * One consequence for anyone writing a test against this list: with both
 * `CLAUDE_CODE_SHELL*` names scrubbed there is no surviving member of that
 * prefix, so a control proving "the deletion is by NAME and not by prefix" has
 * to be the binary's own alphabetical neighbour instead —
 * `CLAUDE_CODE_SESSION_NAME` (8 occurrences), which sits immediately before
 * `CLAUDE_CODE_SHELL` in the bundle's env enumeration and is in no strip list.
 */
export const CLAUDE_LAUNCHER_ENV_KEYS = [
  'CLAUDE_CODE_SHELL',
  'CLAUDE_CODE_SHELL_PREFIX',
  'CLAUDE_CODE_PROCESS_WRAPPER',
] as const

/**
 * F1.825 — the SESSION MARKERS of whatever Claude Code session launched this
 * process, scrubbed from the Claude child env ONLY (owner decision 2026-09-26,
 * option `strip-child`). An app started from a Claude Code terminal
 * (`electron:dev`, a headless `nessy-server`, the CDP launcher) inherits them,
 * and `buildClaudeSubprocessEnv` spreads `process.env`, so our SDK child would
 * believe it is nested inside — or IS — that foreign session.
 *
 * The membership rule: **the vendored binary reads the name, and it describes the
 * session or the host that launched us rather than a setting.** Measured in the
 * shipped binary (`claudeCodeVersion 2.1.267`, 2026-09-26, `grep -aoF … | wc -l`
 * occurrences; control `ZZQQNOTAREALNAME` 0). Two families:
 *
 * - The five markers the binary stamps on every subprocess it spawns, from its
 *   own literal `{CLAUDECODE:"1",CLAUDE_CODE_SESSION_ID:e.sessionId,CLAUDE_CODE_CHILD_SESSION:"1",
 *   CLAUDE_CODE_SESSION_ATTENDED:<"1" or "0">,CLAUDE_PID:String(process.pid)}` — the guard in
 *   `agent/__tests__/claude-inherited-session-markers.test.ts` parses that literal,
 *   and it caught the fifth, `_SESSION_ATTENDED`, at 2.1.274 (F1.1213; 8 hits, on no page). The
 *   first four are on `env-vars.md#variables`, e.g. `CLAUDE_PID`: *"Claude Code sets this to its
 *   own process ID in the subprocesses it spawns"*. Counts 18, 13, 21, 10
 *   (`CLAUDE_PID` is read by the `pkill` guard its Bash integration installs).
 * - The host-integration names a launching host (Claude Desktop, an IDE) sets and
 *   the binary reads, on no page: `CLAUDE_CODE_ENTRYPOINT` 91, `_SDK_HAS_HOST_AUTH_REFRESH`
 *   5, `_TERMINAL_MCP_TOOLS` 4, `_REPORT_FINDINGS`, `_EMIT_TOOL_USE_SUMMARIES`,
 *   `_EAGER_FLUSH` and `_DESKTOP_APP_VERSION` 3 each. The measured consequence:
 *   an inherited `claude-desktop` entrypoint plus `_DESKTOP_APP_VERSION` makes the
 *   child stamp `anthropic-client-platform: desktop_app` on its requests to OUR
 *   endpoint, and `_SDK_HAS_HOST_AUTH_REFRESH` claims a host auth callback we
 *   never registered.
 *
 * Nothing the SDK owns is lost: its `env` option *"REPLACES the subprocess
 * environment entirely"* (`sdk.d.ts`), and it then re-stamps its own values —
 * `if(!sn.CLAUDE_CODE_ENTRYPOINT)sn.CLAUDE_CODE_ENTRYPOINT="sdk-ts"`, and
 * `_SDK_HAS_HOST_AUTH_REFRESH="1"` only when a host callback IS registered. The
 * binary does the same for a process of its own that must not look nested (the
 * env builder opening `{...process.env,INVOCATION_ID:""}`): it deletes `CLAUDECODE`,
 * `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION` and an inherited
 * `claude-desktop` / `claude-vscode` entrypoint (reference, not authority).
 *
 * Deliberately OUT: `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` and
 * `MCP_SERVER_CONNECTION_BATCH_SIZE`, documented USER settings such a shell also
 * exports; names the binary does not contain; `AI_AGENT` (the binary re-stamps an
 * inherited `claude-code…` value itself) and `CLAUDE_EFFORT` (written for Bash and
 * hooks, never read). Child env only, never the host `process.env` (the P3.300 rule
 * above), so a `claude` run from Bash in a Pi or codex session still sees them — the
 * declined `strip-host-start` option; Pi and codex themselves read none of them.
 * Announced by `debug()` only: a marker is not an administrator's choice, so there is
 * no policy to tell a person about. Kept out of {@link CLAUDE_SDK_STRIPPED_ENV_KEYS},
 * which `config/llm-connections.ts` also clears from the HOST env.
 */
export const CLAUDE_INHERITED_SESSION_MARKER_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_REPORT_FINDINGS',
  'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
] as const

/**
 * C3.160 — the six ambient prompt-caching OFF switches, DECLARED rather than
 * stripped. Owner answer QK4 = A (2026-09-11); the direction is this row's, with
 * the reason stated here because the answer fixed the order and not the choice.
 *
 * **What they are.** `prompt-caching.md#disable-prompt-caching`, verbatim:
 * *"Disabling caching is occasionally useful when debugging caching behavior
 * with a specific model or provider. To turn it off, set one of these
 * environment variables to `1`"* — and the page's table carries FIVE
 * (`DISABLE_PROMPT_CACHING` plus `_HAIKU`, `_SONNET`, `_OPUS`, `_FABLE`). The
 * shipped bundle carries SIX: `_MYTHOS` sits in the binary's own env-accessor
 * registry beside the other five (`…DISABLE_PROMPT_CACHING_MYTHOS:()=>hs,…`,
 * read out of the vendored `claude` at `claudeCodeVersion 2.1.247`) and in no
 * page table. This list is therefore derived from the BUNDLE, which is the
 * denominator for what the runtime can already do, and the page is the subset.
 * Occurrence counts on that binary, 2026-09-11, `grep -ao … | wc -l` — the bare
 * name 29 (which the five suffixed names' prefixes inflate: 5, 5, 5, 5 and 3
 * of those hits are theirs), against `ZZZ_FAKE_CONTROL_NAME` 0 as the negative
 * control on the same rig.
 *
 * **They are NOT stripped, deliberately, and that is native-first step 1.** The
 * binary reads them, so on the claude runtime an operator's control already
 * works: `buildClaudeSubprocessEnv` spreads `process.env`, the names are in no
 * strip list, and the page's own organisation route — *"put any of these or the
 * TTL variables in the `env` block of managed settings"* — reaches the child by
 * the same spread through `config/managed-env.ts`. Deleting a working vendor
 * control to make three runtimes agree is the P2.306 lesson written backwards.
 *
 * **The switch verdict, which is the half an adopted native mechanism owes.**
 * The control binds on CLAUDE ONLY. codex speaks Responses and sends no
 * `cache_control` at all; Pi has no counterpart — this fork's own cache writer
 * for the Pi arm is `unified-network-interceptor.ts` symbol
 * `upgradePromptCacheTtl`, which resolves a TTL and never an on/off, and no
 * `DISABLE_PROMPT_CACHING*` name is read anywhere in this tree (`git grep -a`
 * over `packages apps` -> 0 before this constant). So a session that switches
 * from claude to Pi or codex silently keeps caching on, and an operator
 * debugging a caching question on one runtime is not debugging it on the other
 * two. `agent/options.ts` symbol `applyPromptCachingOffSwitchNotice` announces
 * that at the one seam every claude spawn passes through, the P3.300 pattern
 * with the sign flipped: honoured and named, rather than dropped and named.
 *
 * Kept OUT of {@link CLAUDE_SDK_STRIPPED_ENV_KEYS} by that decision. A future
 * host setting that offers the same switch on all three would be a BUILD with
 * nothing to build against on two of them; it is recorded as the alternative
 * this row declined, not as work left undone.
 */
export const CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS = [
  'DISABLE_PROMPT_CACHING',
  'DISABLE_PROMPT_CACHING_HAIKU',
  'DISABLE_PROMPT_CACHING_SONNET',
  'DISABLE_PROMPT_CACHING_OPUS',
  'DISABLE_PROMPT_CACHING_FABLE',
  'DISABLE_PROMPT_CACHING_MYTHOS',
] as const

/**
 * Every name stripped from the Claude SDK subprocess and the host env.
 *
 * Both strip sites (`agent/options.ts`'s subprocess-env builder and
 * `config/llm-connections.ts`'s host-env clear) iterate THIS union, so the two
 * cannot diverge; the two halves keep separate constants because they have
 * different membership rules and different guards.
 */
export const CLAUDE_SDK_STRIPPED_ENV_KEYS = [
  ...CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS,
  ...CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS,
] as const
