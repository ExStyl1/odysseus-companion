/**
 * P6.503 — one vocabulary for "did the SERVER publish a reset time?", shared by
 * every arm that can hit a usage limit.
 *
 * ## The row, and the decision it rests on
 *
 * A reset timestamp exists on two of the three arms and neither drives a wait,
 * so an unattended session dies at a usage limit with the work lost. Q-den 20
 * chose **option A**: *wait only where a reset timestamp is published, and say
 * plainly where it is not*. B — a fixed-interval retry everywhere — was refused
 * because it invents a reset the server never promised, which is precisely the
 * failure the read-don't-invent rule exists for.
 *
 * So this module has exactly two jobs and deliberately not a third:
 *
 *  1. Read a published reset, or answer that none was published. It NEVER
 *     synthesizes one, and there is no default, fallback or estimate anywhere in
 *     it — the whole point of option A is that the absence stays an absence.
 *  2. Give the absence a SENTENCE. Today the absence is spelled as an empty
 *     string on every arm, which reads as a formatting choice rather than as the
 *     reason the turn stopped — the half-true-disclosure shape that is this
 *     fork's largest defect class.
 *
 * ## Where each arm stands (measured at HEAD, 2026-09-07)
 *
 *  - **claude** publishes one: `SDKRateLimitInfo.resetsAt` on `rate_limit_event`,
 *    normalized and printed as *" Resets <date>."* by the claude event adapter.
 *    When it is absent the adapter SAYS SO, through this module, on the
 *    `rejected` status; on `allowed_warning` it stays silent, because nothing
 *    has stopped. (P6.503: this bullet said the adapter *"appends `''`"* until
 *    P6.373's claude arm landed, which was already false of `624b84782` — the
 *    absence had had a sentence for two commits while the header still described
 *    the silence it replaced.) Since P6.373 the `rejected` arm routes through
 *    {@link decideUsageLimitContinuation} instead, so the stopping sentence also
 *    names the setting that decided resume-vs-stop.
 *  - **codex** publishes one, but NOT on the signal that stops the turn. A turn
 *    dies with `CodexErrorInfo` `"usageLimitExceeded"` — a BARE STRING in
 *    `packages/codex-protocol/generated/v2/CodexErrorInfo.ts` at `rust-v0.148.0`,
 *    carrying no timestamp of any kind. The reset lives on
 *    `RateLimitWindow.resetsAt`, which F1.7 holds for a session codex signed in
 *    to an account; since F1.569 the codex emit site pairs the FULL window's
 *    reset with the stop (`codexUsageLimitWindowReset`, the D1.189 bullet below).
 *  - **the Nessy gateway (Pi)** — this bullet said *"not verified to publish one
 *    at all"* until the Pi read (2026-09-07, W7-s2b), and it is wrong in the
 *    direction that matters. Two separate facts, and conflating them is what
 *    produced the wrong sentence:
 *
 *      · **Pi's RUNTIME publishes nothing.** The only rate-limit surface on the
 *        Pi path is `auto_retry_start`
 *        (`backend/pi/event-adapter.ts`, `RATE_LIMIT_ERROR_PATTERN`), whose
 *        payload is `delayMs` / `attempt` / `maxAttempts` / `errorMessage`. That
 *        `delayMs` is a CLIENT-chosen backoff computed by
 *        `pi-ai/dist/utils/retry.js`, not an instant a server named — and the
 *        same event fires for timeouts, 5xx and socket drops, which is why the
 *        adapter classifies off the message rather than calling every retry a
 *        rate limit. **Waiting on it would BE option B**, the arm Q-den 20
 *        refused: a reset invented on the client's own timer.
 *      · **The gateway DOES publish one, on a different path.**
 *        `GET /api/v1/quota` returns `reset_at` per limit —
 *        `backend/internal/nestor-quota.ts`, whose `NestorQuotaLimit` mirrors
 *        `QuotaLimit` (`httpserver/api.go:1406-1443`) and whose own comment
 *        records it as *authoritative*, present only when the concrete
 *        token-usage storage is behind the interface (`userlimit.go:72`). It is
 *        already read and rendered by `/quota`.
 *
 *    So the Pi/gateway arm has the same SHAPE as codex's, not the shape this
 *    bullet claimed: a reset exists and does not arrive on the signal that stops
 *    the turn. Reaching it needs a poll at the moment of the limit, which is a
 *    request this module must not make on its own — P6.373's gate decides
 *    whether a session waits at all.
 *
 *    **And the 429's own words are NOT a substitute, which is the trap here.**
 *    `nestor-quota.ts` records the measurement verbatim: `reset_at` is
 *    ~11:00 Europe/Moscow, *"NOT the 00:00 the 429 string promises
 *    (`tokenusage.go:22`)"*. A wait derived from the error text would be both
 *    invented and wrong, and it would look exactly like a reading.
 *
 * ## P6.373 landed here, and this paragraph used to say it had not
 *
 * This section read *"It does not resume … when P6.373 lands,
 * {@link readPublishedUsageLimitReset} is the input its gate reads"*. That is
 * now the second half of this file: the gate is
 * {@link decideUsageLimitContinuation}, its one setting is
 * {@link AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}, its sentence is
 * {@link describeUsageLimitContinuation} and the wait itself is
 * {@link awaitUsageLimitReset}. The sequencing P6.503's note demanded is
 * honoured by that ORDER rather than by absence — the gate is downstream of the
 * reader and can only ever wait for an instant the reader was handed, so
 * option B stays refused BY TYPE even now that a wait exists.
 *
 * P6.444 (`D1.77`) is still open, and D1.189 corrected WHOSE blocker it is: a
 * codex usage limit still reaches the gate with `{ published: false }` and still
 * stops, but not because `account/rateLimits/updated` is on
 * `CODEX_UNREAD_NOTIFICATION_METHODS` — it is because that notification cannot
 * arrive on a session of this fork at all. The measurement and what would reopen
 * it are on {@link awaitUsageLimitReset}'s codex bullet; `D1.77` survives as the
 * PI arm's question.
 */

import { parseBooleanEnv } from '../feature-flags.ts';

/** Either the server named a reset instant, or it did not. There is no third state. */
export type UsageLimitReset =
  | { published: true; resetsAtMs: number }
  | { published: false };

/**
 * Read a reset instant off a payload field, in epoch ms.
 *
 * The seconds-or-milliseconds normalization is not a nicety: `SDKRateLimitInfo.resetsAt`
 * carries no unit in the typings — every OTHER timestamp in `sdk.d.ts` says
 * "integer milliseconds since epoch" explicitly and this one says nothing, while
 * Anthropic's own rate-limit headers are Unix SECONDS. Guessing wrong prints
 * either 1970 or the year 56000 to the user. Any plausible date expressed in
 * seconds is below 1e12 and any expressed in milliseconds (after 2001) is above
 * it, so the value decides its own unit.
 *
 * Anything not a finite positive number — absent, `null`, a string, `0`, NaN —
 * is `{ published: false }`. That is the whole guard: this function has no way
 * to produce a timestamp the caller did not receive.
 */
export function readPublishedUsageLimitReset(value: unknown): UsageLimitReset {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { published: false };
  return { published: true, resetsAtMs: value < 1e12 ? value * 1000 : value };
}

/**
 * The clause appended to a usage-limit message, in ONE wording for all arms.
 *
 * Shared rather than written per adapter because three arms saying the same
 * thing three ways is a divergence the switch report has to carry. The
 * `published: false` sentence names the consequence (the turn stops) and its
 * cause (the server named no time) without implying anyone could have waited —
 * "unknown" would read as a gap in OUR reading rather than in the server's
 * answer.
 */
export function describeUsageLimitReset(
  reset: UsageLimitReset,
  formatInstant: (ms: number) => string = ms => new Date(ms).toLocaleString(),
): string {
  return reset.published
    ? ` Resets ${formatInstant(reset.resetsAtMs)}.`
    : ' No reset time was published with this limit, so the turn stops here rather than waiting.';
}

/**
 * P6.503 · the codex arm's clause, exported so the pin exercises the REAL
 * function rather than a copy of it living in a test.
 *
 * Takes the already-read `CodexErrorInfo` code rather than the raw union,
 * because reading that union is `codex-agent.ts`'s
 * `readCodexErrorInfoCode` — a string for the plain variants and a single-key
 * object for the ones carrying an HTTP status — and a second copy of that reader
 * here is exactly the drift this module exists to prevent.
 *
 * Empty for every code but `usageLimitExceeded`, so an unrelated failure gains
 * no sentence. `resetsAt` is the error's own instant when a codex release stamps
 * one (none does at the pinned tag), else — F1.569 — the reset of the window the
 * session holds as full (`codexUsageLimitWindowReset`, the ChatGPT (Codex) card).
 *
 * F1.569 · `waitIsWired: false`, always: codex performs NO wait — the turn has
 * ended when this error arrives and nothing re-drives it — so the clause names
 * the reset and says the turn stops, and never "waiting until … then continuing
 * automatically". Before F1.569 no instant ever reached this clause, so the false
 * promise was latent; the first instant would have printed it.
 */
export function codexUsageLimitResetClause(
  code: string | undefined,
  resetsAt: unknown,
  formatInstant?: (ms: number) => string,
): string {
  if (code !== 'usageLimitExceeded') return '';
  // P6.373 · the clause runs through the ONE resume-vs-stop gate rather than
  // straight to the reset sentence. With no instant the verdict is
  // `no-reset-published`, byte-identical to what this printed before. With one
  // (F1.569), the setting still decides the WORDING — off names the setting —
  // and `waitIsWired: false` keeps it honest: codex does not wait.
  return describeUsageLimitContinuation(
    decideUsageLimitContinuation(readPublishedUsageLimitReset(resetsAt)),
    formatInstant,
    { waitIsWired: false },
  );
}

/**
 * P6.373 · denominator K22 — the ONE setting that decides resume-vs-stop when a
 * usage limit is hit, on all three runtimes.
 *
 * ## Why a Nessy env var BESIDE — not instead of — the documented claude key
 *
 * The nearest documented solution is claude's `autoContinueAtUsageLimit`, and it
 * was read before anything was written here. `settings-reference.md#autocontinueatusagelimit`,
 * verbatim: *"After a claude.ai usage limit stops your session, wait in the open
 * session and continue the task automatically after the reset."* — Scope *"User
 * or managed"*, Type Boolean, **Default `true`**, and *"Requires Claude Code
 * v2.1.234 or later."*
 *
 * **C3.323 (2026-09-12) re-argued this section, and BOTH halves of the refusal it
 * used to carry are dead. It opened "Two measured reasons it cannot simply be
 * forwarded"; it IS forwarded, and has been since P7.13.**
 *
 *  - The VERSION clause died first. The bullet asserted "It is not in the runtime
 *    we ship. The vendored SDK self-reports `2.1.233` …, five patch versions
 *    short of the `v2.1.234` the page names, and a bundle probe scores
 *    `autoContinueAtUsageLimit` → 0 in `sdk.mjs`, `bridge.mjs` and `sdk.d.ts`."
 *    C3.252 corrected it once the bundle passed that floor. Re-measured for this
 *    row at the vendored 2.1.247 — both instruments named, because they disagree
 *    on a minified artefact (C3.294): **8 lines / 18 occurrences** in the native
 *    binary, **2/2** in `sdk.mjs`, **1/1** in `sdk.d.ts`, against this repo's
 *    standing fabricated control `nessyNotARealSdkKey` → 0/0 in all three.
 *  - The BEHAVIOURAL clause died second, and it SURVIVED the first correction:
 *    *"Nothing native honours it today, so forwarding it would be a setting that
 *    silently does nothing on the very runtime it is named for."* P7.13 forwards
 *    it — {@link buildClaudeAutoContinueAtUsageLimitSettings} on
 *    `buildClaudeFlagSettingsOptions`' flag tier — and the child consumes it
 *    through the eligibility predicate quoted on
 *    {@link AUTO_CONTINUE_AT_USAGE_LIMIT_SETTING_KEY} below. That sentence sat
 *    twenty lines above a sibling docblock stating the opposite, for two waves;
 *    a comment asserting what a different contributor does not do has no guard,
 *    which is why the pair is now stated in one place.
 *
 * **The tier is the page's, not a guess.** Scope reads *"Read from user settings,
 * `--settings`, and managed settings only"*, and the vendored `sdk.d.ts` declares
 * `Options.settings` *"Equivalent to the `--settings` CLI flag"* — so the host's
 * projection lands in a tier the page names. The same bullet also supplies the
 * reason P7.13's ALWAYS-SEND is the SAFE direction and not merely the definite
 * one: *"When none of those sets the key, a project or local settings file that
 * sets it turns the feature off rather than being ignored"* — a
 * `.claude/settings.json` in the user's own repository would otherwise silently
 * cancel a wait this host has already printed a promise about.
 *
 * **What survives, and it is the only reason this env var exists.** Its subject is
 * a different limit. The page scopes the claude key to a *claude.ai* usage limit;
 * the per-minute gateway 429 is a second signal, and Pi answers it itself
 * (`pi-agent-server/src/gateway-retry-settings.ts`): first the provider block
 * `PI_PROVIDER_RETRY_SETTINGS`, which sleeps a `retry-after` of 60 s or less,
 * then the 5 x 15 s agent ladder `GATEWAY_RETRY_SETTINGS`. Codex's
 * `usageLimitExceeded` is a third. One OPERATOR control has to cover all three, so
 * the host owns the ANSWER — rule 2 of native-first, the host as the seam — and
 * hands it to the runtime's own switch wherever one exists. On claude that is
 * configuration and not construction: nothing is built beside the vendor's
 * mechanism, and {@link awaitUsageLimitReset} stays for the runtimes that have no
 * such switch.
 *
 * The DEFAULT is taken from the page rather than chosen: `true`. Note what that
 * means here and does not: waiting happens only where the SERVER named an
 * instant, so the wait is bounded by a time we were given and never by one we
 * estimated. Where no reset was published the answer is stop, whatever the
 * setting says — the setting cannot conjure a deadline, and that ordering is
 * what keeps this module free of the fallback Q-den 20 refused.
 */
export const AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR = 'NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT';

/**
 * The claude settings key this host setting mirrors — and since P7.13 it is a key
 * we actually SEND, not merely a greppable correspondence.
 *
 * This docblock said *"NOT read from anywhere … the vendored bundle does not
 * carry it"*, and that was true of `0.3.233`. At the vendored `0.3.247` the key
 * is declared on `Settings` with the behaviour written out — *"When a claude.ai
 * usage limit stops your session, wait for the limit to reset and continue the
 * task automatically. When off, the limit dialog offers the wait as a choice
 * instead."* — and it scores 18 occurrences in the native binary against this
 * repo's standing control `nessyNotARealSdkKey` -> 0.
 *
 * Read from the binary rather than from the page, because the page describes a
 * TUI and we drive a headless child. The runtime's own eligibility predicate is
 * `e.status==="rejected"&&e.resetsAt!==void 0&&Number.isFinite(e.resetsAt)&&
 * e.isUsingOverage!==!0&&e.overageInUse!==!0`, which is
 * {@link decideUsageLimitContinuation}'s gate plus an overage clause we cannot
 * see — i.e. the runtime is STRICTER than the host, never looser, so projecting
 * our answer can only ever be honoured on a subset of the cases we would have
 * waited for. And the resolution order is `if(t!==void 0)return t`: a key we
 * send WINS outright, ahead of the presence heuristic the child otherwise falls
 * back to (`autoContinueKeyPresence === "absent"`). Sending a definite answer
 * therefore removes a branch rather than adding one.
 */
export const AUTO_CONTINUE_AT_USAGE_LIMIT_SETTING_KEY = 'autoContinueAtUsageLimit';

/**
 * P7.13 — the host's answer, shaped for `Options.settings`.
 *
 * Native-first step 1: the runtime has the mechanism, so we configure it and
 * build nothing beside it. `awaitUsageLimitReset` stays in this module for the
 * runtimes that have no such switch (P6.373's Pi residue), and gains no claude
 * caller — two implementations of one contract is exactly what the tripwire in
 * `interceptor-prompt-cache-ttl.test.ts` warns against on the neighbouring key.
 *
 * The value is ALWAYS sent, never omitted-when-default, and that is the one
 * place this differs from `buildClaudeWorkflowSettings`'s "only what the host
 * actually decided travels". The reason is that the alternative is not the
 * vendor's documented default: with the key absent the child takes
 * `autoContinueKeyPresence === "absent"`, a heuristic over stored state that
 * this host cannot observe or reproduce. `resolveAutoContinueAtUsageLimit`
 * always has a definite answer (the vendor's own documented default when
 * nothing is set), so sending it makes the child agree with the sentence the
 * user is shown instead of leaving the two free to disagree.
 */
export function buildClaudeAutoContinueAtUsageLimitSettings(
  env: Record<string, string | undefined> = process.env,
): { autoContinueAtUsageLimit: boolean } {
  return { autoContinueAtUsageLimit: resolveAutoContinueAtUsageLimit(env) };
}

/** `settings-reference.md#autocontinueatusagelimit`, "**Default**: `true`". */
export const AUTO_CONTINUE_AT_USAGE_LIMIT_DEFAULT = true;

/**
 * Read the operator's resume-vs-stop answer. Unset, or set to anything
 * {@link parseBooleanEnv} does not recognise, is the documented default.
 */
export function resolveAutoContinueAtUsageLimit(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseBooleanEnv(env[AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]) ?? AUTO_CONTINUE_AT_USAGE_LIMIT_DEFAULT;
}

/**
 * What happens next after a usage limit — resume at the instant the server
 * named, or stop, with the reason the caller can print.
 *
 * `resumeAtMs` rides the `setting-off` arm too, so the disclosure can name the
 * time the session is declining to wait for; that is the difference between
 * "we stopped" and "we stopped although we knew when it would clear".
 */
export type UsageLimitContinuation =
  | { resume: true; resumeAtMs: number; waitMs: number }
  | { resume: false; reason: 'no-reset-published' }
  | { resume: false; reason: 'setting-off'; resumeAtMs: number };

/**
 * The gate. **Order matters and is the whole safety property:** an unpublished
 * reset stops the turn whatever the setting says, because there is no instant to
 * wait for and inventing one is option B. Only a published instant reaches the
 * setting at all.
 */
export function decideUsageLimitContinuation(
  reset: UsageLimitReset,
  options: { env?: Record<string, string | undefined>; nowMs?: number } = {},
): UsageLimitContinuation {
  if (!reset.published) return { resume: false, reason: 'no-reset-published' };
  if (!resolveAutoContinueAtUsageLimit(options.env)) {
    return { resume: false, reason: 'setting-off', resumeAtMs: reset.resetsAtMs };
  }
  const nowMs = options.nowMs ?? Date.now();
  return { resume: true, resumeAtMs: reset.resetsAtMs, waitMs: Math.max(0, reset.resetsAtMs - nowMs) };
}

/**
 * The sentence, in ONE wording for all three arms — the same reason
 * {@link describeUsageLimitReset} is shared.
 *
 * The `no-reset-published` sentence is BYTE-IDENTICAL to
 * {@link describeUsageLimitReset}'s absent case, deliberately: that clause was
 * already the honest answer for a turn with nothing to wait for, and the gate
 * landing must not reword a sentence two arms already print. The two other
 * sentences NAME THE SETTING, which is P6.373's done_means — an operator reading
 * "the turn stops here" has to be able to find the switch that decided it.
 */
export function describeUsageLimitContinuation(
  continuation: UsageLimitContinuation,
  formatInstant: (ms: number) => string = ms => new Date(ms).toLocaleString(),
  options: {
    /**
     * P6.373 · does the CALLER'S runtime actually perform the wait?
     *
     * Defaults to `true`, which is what the sentence has always meant.
     *
     * **The codex clause passes `false` (F1.569, 2026-09-24); the claude adapter
     * stopped passing it at P7.13 (2026-09-10).** The claude adapter
     * passed it, because `awaitUsageLimitReset` had no in-tree caller and
     * printing *"then continuing automatically"* would have promised something
     * no code performed. That is no longer the claude arm's situation: the
     * vendored `0.3.247` runtime carries the wait itself, the host projects its
     * answer onto {@link AUTO_CONTINUE_AT_USAGE_LIMIT_SETTING_KEY}, and the
     * adapter drops the argument.
     *
     * It remains a parameter rather than a lookup because only the caller can
     * know: the wait belongs to whatever re-drives a turn, and that is a
     * different site on each runtime. Codex re-drives nothing after a usage
     * limit, so `codexUsageLimitResetClause` says "this runtime does not wait";
     * P6.373's Pi residue is open and Pi has no such switch either. F1.600
     * DECIDED the codex half (see {@link awaitUsageLimitReset}): the sentence
     * states the stop and how to continue, and promises no later build.
     */
    readonly waitIsWired?: boolean;
    /**
     * F1.602 · the environment the verdict was decided against (default
     * `process.env`, which is what {@link decideUsageLimitContinuation} reads).
     * Read only to NAME the switch: the resume verdict is reached both when the
     * operator set the variable and when it is unset (the default is on), and
     * the sentence printed `…=1` in both — an unconfigured install read as if
     * someone had set it. Now `=1` is printed only when it was set, and the
     * default is named otherwise; the two sentences differ only there.
     */
    readonly env?: Record<string, string | undefined>;
  } = {},
): string {
  if (continuation.resume) {
    const setting = parseBooleanEnv((options.env ?? process.env)[AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR]) === true
      ? `${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=1`
      : `the default; ${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=0 turns it off`;
    if (options.waitIsWired === false) {
      const at = formatInstant(continuation.resumeAtMs);
      return ` The limit resets ${at}.`
        + ` Automatic continuation is on (${setting}), but this runtime does not perform it,`
        + ` so the turn stops here. Send a message after ${at} to continue.`;
    }
    return ` Waiting until ${formatInstant(continuation.resumeAtMs)}, when the limit resets, then continuing`
      + ` automatically (${setting}).`;
  }
  if (continuation.reason === 'setting-off') {
    return ` The limit resets ${formatInstant(continuation.resumeAtMs)}, but ${AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_VAR}=0,`
      + ' so the turn stops here rather than waiting.';
  }
  return describeUsageLimitReset({ published: false });
}

/**
 * P6.373 · the WAIT itself, so the decision and the sleep cannot drift apart.
 *
 * Returns the same verdict {@link decideUsageLimitContinuation} produced, AFTER
 * sleeping when that verdict is `resume` — the caller prints the sentence
 * before awaiting and resumes the turn when this resolves. `sleep` is injected
 * so a test drives a real wait without one.
 *
 * There is no ceiling on `waitMs` and that is a decision, not an omission: the
 * instant came from the server, so a cap would be us overruling a deadline we
 * were given with one we estimated. The operator's ceiling is the setting.
 *
 * READERS: still none in-tree, and D1.59 re-took all three verdicts on
 * 2026-09-17 because the paragraph that stood here had gone false in the
 * direction that matters — it said the claude arm was a hand-off hunk waiting
 * to be applied, and the claude arm has since been applied AND retired.
 *
 *  - **claude — CLOSED, and deliberately not through this function.** P7.13
 *    handed resume-vs-stop to the runtime's own `autoContinueAtUsageLimit`:
 *    {@link buildClaudeAutoContinueAtUsageLimitSettings} rides
 *    `buildClaudeFlagSettingsOptions`, so the child performs the wait and the
 *    adapter's sentence is true for the first time. The `waitIsWired` third
 *    argument `adaptRateLimit` used to pass is GONE at HEAD, which is the
 *    visible half of that change. Two implementations of one contract is the
 *    thing native-first refuses, so this function gains no claude caller.
 *  - **Pi — still blocked, on a measurement rather than on a build.** Nothing
 *    here decides resume-vs-stop on Pi because nothing has established that the
 *    gateway publishes a reset instant at all: that is the carried `measure:`
 *    row (P6.444, now `D1.77`), which demoted the Pi verdict from `n/a` to
 *    `unknown` for want of a positive control and is still unstarted. The
 *    signal Pi DOES have is a different one: the per-minute 429. Pi's own two
 *    layers answer it (`pi-agent-server/src/gateway-retry-settings.ts`): the
 *    provider block `PI_PROVIDER_RETRY_SETTINGS` sleeps a `retry-after` of 60 s
 *    or less, then the agent ladder `GATEWAY_RETRY_SETTINGS` re-runs the turn.
 *    Neither hands the host a server-published instant: pi-ai consumes the
 *    header and emits no event for a provider sleep, and the ladder's
 *    `auto_retry_start` carries its own computed delay. A retry is not a deadline.
 *  - **codex — HALF of the carried sentence is wrong, and the correction is
 *    the reason its arm is blocked rather than impossible.** Re-read at the
 *    pinned `rust-v0.154.0` protocol: `CodexErrorInfo` really does type
 *    `usageLimitExceeded` and `rateLimitExceeded` as bare string members with
 *    no timestamp (only the `http…` variants carry an object, and it carries
 *    `httpStatusCode`), so the ERROR path alone can only ever produce
 *    `no-reset-published`. But the instant is not absent from the protocol:
 *    `RateLimitWindow` publishes `resetsAt`, delivered by
 *    `account/rateLimits/updated`, which this host lists in
 *    `CODEX_UNREAD_NOTIFICATION_METHODS` — deliberately unread, and the subject
 *    of the same `D1.77`. So codex's arm would be a PAIRING of two signals (the
 *    last window's instant with the error that stopped the turn), not an
 *    absence; recorded here rather than left as an `n/a` nobody would question.
 *  - **D1.189 went to build that pairing and it is UNBUILDABLE, for a reason
 *    one layer earlier than the one above.** The bullet treats
 *    `account/rateLimits/updated` as a signal this host DECLINES to read. It is
 *    not: on a session of this fork it never arrives at all, so there is no
 *    window to keep per thread and no `resetsAt` to hand
 *    {@link decideUsageLimitContinuation}. C4.28 measured this from the other
 *    side — `CodexAgent.describeQuota`, gated by
 *    `agent/__tests__/codex-quota-window.test.ts` — on the shipped app-server
 *    with a `CODEX_HOME` this fork's own writer produced: both
 *    `account/rateLimits/read` and `account/usage/read` answer
 *    `-32600 "codex account authentication required …"`, no window notification
 *    arrives in the same boot, and the proxy sink recorded zero network
 *    attempts, so the refusal is local and structural. The cause is not
 *    configurable: the whole `account/*` family wants a codex ACCOUNT (a ChatGPT
 *    login) and `writeCodexConfig` writes no `auth.json` into the per-session
 *    `CODEX_HOME`. Re-verified 2026-09-17 at the shipped `rust-v0.154.0`
 *    binary — both refusal strings occur once (`grep -aoF … | wc -l`; positive
 *    control `thread/start` 18, negative control 0) and `auth.json` occurs in
 *    **0** files under `packages/codex-responses-adapter/src`.
 *
 *    So the codex arm is **`absent — the carrier cannot fire here, and it is not
 *    configurable`**, which is a closable verdict rather than a queued one, and
 *    **`D1.77` stops being its blocker**: that row asks whether the GATEWAY
 *    publishes a reset instant, which is a question about the PI arm, where the
 *    host reads the gateway's own responses. What would reopen codex's arm is a
 *    codex session holding a real codex account — which this product does not
 *    build — or codex publishing a window for a declared `model_providers.*`
 *    entry, which at this tag it does not.
 *  - **F1.569 (2026-09-24): the first reopening condition above is met.** F1.202
 *    built the ChatGPT (Codex) card, whose codex IS signed in to an account, so
 *    the carrier fires there and the codex emit site pairs the full window's
 *    reset with the stop (`codexUsageLimitWindowReset`). The WAIT is still not
 *    built — this function still has no codex caller — so the codex clause says
 *    the reset and that the turn stops (`waitIsWired: false`). Every other codex
 *    card keeps the verdict above.
 *  - **F1.600 (2026-09-24, DECIDED): not built, because codex's own posture at a
 *    usage limit is to stop.** Read at `rust-v0.156.1`: `core/src/session/turn.rs`
 *    returns `CodexErrorDetails::UsageLimitReached` straight out of the sampling
 *    loop (every other stream error goes through the retry ladder); the goal
 *    extension (`ext/goal/src/runtime.rs`, `usage_limit_active_goal_for_turn`)
 *    marks an active goal `usage_limited`, which resumes only on `/goal resume`;
 *    and the TUI (`tui/src/chatwidget/turn_runtime.rs`, `on_rate_limit_error`)
 *    holds QUEUED input only until an `account/rateLimits/read` answers, bounded
 *    by a timeout — it never waits for the reset and never re-drives the turn.
 *    Native-first step 1 finds no mechanism to enable; step 2 is not uniform
 *    (claude waits natively, Pi and codex do not); step 3 would be a host timer
 *    holding a session across a window that can be a week long. So the host
 *    follows codex: the clause states the stop, drops the "yet" it carried, and
 *    tells the user to send a message after the reset. The operator setting
 *    therefore changes only the WORDING on codex, and the sentence says so.
 */
export async function awaitUsageLimitReset(
  reset: UsageLimitReset,
  options: {
    env?: Record<string, string | undefined>;
    nowMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<UsageLimitContinuation> {
  const continuation = decideUsageLimitContinuation(reset, options);
  if (!continuation.resume) return continuation;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  await sleep(continuation.waitMs);
  return continuation;
}
