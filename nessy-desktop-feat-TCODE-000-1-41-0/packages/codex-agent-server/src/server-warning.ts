/**
 * P2.408 — codex's PLAIN `warning` notification, which reached this repo and was
 * handled in zero files.
 *
 * ## The hazard, and why it is not a nicety
 *
 * `ServerNotification` method `"warning"` (`WarningNotification =
 * { threadId: string | null, message: string }`) is the channel codex uses to
 * tell a client that **the session it just started is not the session the
 * configuration describes**. The instance that matters here is the one P2.384
 * ran into: turning on any feature codex stages as `underDevelopment` makes the
 * app-server announce, once per thread, that incomplete features are live — and
 * that announcement was the notice we dropped. So *any* future feature flip
 * would have run UNANNOUNCED, which is why P2.384 refused to flip
 * `request_permissions_tool` and routed this row ahead of it.
 *
 * `configWarning` (see `config-warning.ts`) is a different channel and stays
 * separate: that one reports the config LOAD going wrong, this one reports the
 * config being obeyed and the result being unstable.
 *
 * ## What the channel actually carries — MEASURED, not read
 *
 * Shipped `codex-app-server` (`apps/electron/resources/bin/codex/darwin-arm64`,
 * built from `openai/codex` `rust-v0.148.0`), driven over stdio with four arms
 * against scratch `CODEX_HOME`s, 2026-08-29. A real frame, verbatim off the
 * wire:
 *
 * ```json
 * {"threadId":"01a04ea4-95b8-7180-b5b9-cadd3924f7c8",
 *  "message":"Under-development features enabled: executed_tool_call_metadata. \
 * Under-development features are incomplete and may behave unpredictably. To \
 * suppress this warning, set `suppress_unstable_features_warning = true` in \
 * <CODEX_HOME>/config.toml."}
 * ```
 *
 * Four arms, and the last two are the controls that make the first two mean
 * something:
 *
 * | Arm | `config.toml` | `warning` frames |
 * | --- | --- | --- |
 * | A (negative control) | no `[features]` at all | **0** |
 * | B | `[features] executed_tool_call_metadata = true` | 1, naming that feature |
 * | C | B plus `code_mode = true` | 1, naming **both**, comma-joined, sorted |
 * | D (suppression control) | B plus `suppress_unstable_features_warning = true` | **0** |
 *
 * Binary string probe on the same artifact, same day: `"Under-development
 * features enabled"` 1, `suppress_unstable_features_warning` 12, positive
 * controls `thread/start` 3 and `guardianWarning` 3, negative control
 * `zzz_not_a_real_feature_key` **0**.
 *
 * ## The timing, which decides where this can be surfaced
 *
 * The frame arrives **in the same flush as `thread/started`, immediately after
 * `thread/start` resolves** — 2371 ms on a run whose `initialize` answered at
 * 184 ms — and **once per thread**: a second `thread/start` on the same
 * connection produced a second frame at 14663 ms. It never arrives at
 * `initialize`, and it does not repeat while the thread idles (12 s and 10 s
 * windows, both empty).
 *
 * That is load-bearing rather than trivia. `CodexAgent` opens its thread during
 * runtime creation, so this notification lands **before any turn exists** — and
 * `turnSink` is set by `chatImpl` only. A surfacing that just did
 * `turnSink?.push(...)` would therefore be INERT for the one class we know how
 * to name. The consumer defers instead; see `CodexAgent.noteCodexServerWarning`.
 *
 * ## What is NOT known, stated rather than papered over
 *
 * The set of things that can arrive on this channel is **not enumerated**. The
 * emitter was searched for at `rust-v0.150.1` in `app-server/src/lib.rs`,
 * `app-server/src/message_processor.rs` and `core/src/tools/registry.rs` and is
 * in none of the three; the file-path strings the shipped binary carries point
 * at `core/src/tools/registry.rs`, `core/src/config/managed_features.rs` and
 * `features/src/{lib,legacy}.rs`, which is a neighbourhood, not a list. So one
 * class is classified from a measured frame and **everything else is relayed
 * verbatim** — never dropped, never guessed at. Per AGENTS.md that makes the
 * unstable-features branch STRONG (shipped binary, live frame, with controls)
 * and the completeness of the enumeration an open null.
 */

/** The notification method the app-server uses. `ServerNotification` union, rust-v0.148.0. */
export const CODEX_WARNING_METHOD = 'warning';

/**
 * `WarningNotification` — `{ threadId: string | null, message: string }`
 * (`codex-protocol/generated/v2/WarningNotification.ts`).
 *
 * Read defensively: this runs inside the transport's line handler, where a throw
 * would take down notification dispatch for the whole connection. A version that
 * renames or drops `message` must degrade to a shorter line, never to a throw.
 */
interface WarningLike {
  message?: unknown;
  threadId?: unknown;
}

/**
 * The sentence opener codex writes when unstable features are live.
 *
 * Verbatim from the shipped binary (`grep -a -c -F` = 1) and from a captured
 * frame. Matched case-insensitively because the only cost of a reworded-but-
 * still-this-class match is one honest sentence, while a miss is the silence
 * this row exists to end.
 */
const UNSTABLE_FEATURES_MARKER = 'under-development features enabled:';

/** Most features anyone would name in one line; a longer list is truncated, not dropped. */
const MAX_NAMED_FEATURES = 24;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Collapse to one line and bound it, so a log line stays a log line. */
function bounded(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Does this warning mean codex is running features it calls incomplete?
 *
 * This is the class P2.384 was blocked on: it is the only signal that a feature
 * key someone wrote has put the session into `Stage::UnderDevelopment`
 * behaviour, and it is emitted whether or not that key was ours.
 */
export function isCodexUnstableFeaturesWarning(params: unknown): boolean {
  return text((params as WarningLike | null | undefined)?.message)
    .toLowerCase()
    .includes(UNSTABLE_FEATURES_MARKER);
}

/**
 * The feature keys codex named, in the order it named them (it sorts them).
 *
 * The list runs from the marker to the end of that sentence. A feature key is a
 * snake_case identifier — measured off `experimentalFeature/list` on the same
 * binary, where every name matches `[a-z0-9_]+` and none contains a `.` — so the
 * first `.` after the marker is the sentence end and cannot be inside a name.
 * Character-restricted and count-bounded on the way out, so a message that
 * changed shape cannot smuggle a paragraph into a log line or a transcript row.
 *
 * The COUNT this docblock used to carry — *"200-odd names"* — was a reading with
 * no date, and it was wrong: the pinned binary answered **114** (P6.455,
 * 2026-09-05) and answers **140** at `rust-v0.154.0` (2026-09-13, one page,
 * `nextCursor: null`). The count was never the load-bearing half; the CHARACTER
 * claim was, and it is now REFUTED — which is the whole reason this row asserted
 * it against the binary instead of describing it in prose.
 *
 * **A feature name CAN contain a dot, measured at `rust-v0.154.0`.**
 * `guardianv2.thread_context` arrived with that lift, the first of 140 names
 * outside `[a-z0-9_]+`, and it broke this parser in the direction that INVENTS a
 * name rather than dropping one. The sentence end was taken as the first `.`
 * anywhere in the tail; against codex's own template — read from the shipped
 * binary's format string, *"Under-development features enabled: <list>. …"* —
 * the first `.` in `guardianv2.thread_context` is INSIDE the name, so the slice
 * ended mid-name and the survivor `guardianv2` passed the identifier filter and
 * would have been reported to an operator as a live feature codex never named.
 * Both halves are fixed and both had to be: the sentence end is now a `.` that
 * ENDS a sentence (followed by whitespace or the string end, which the internal
 * dot never is), and the accepted shape is dot-separated identifier segments.
 * Neither widens what can be smuggled through — a space still disqualifies a
 * part, so prose cannot pass — and the live suite's discovery arm asserts the
 * shape against the binary, so the day a name takes a `-` or a `:` it reddens
 * there rather than silently re-truncating here.
 *
 * Returns `[]` for a warning of any other class, and for this class with an
 * unreadable list — the caller then still reports the class, just without names.
 */
export function codexUnstableFeatureNames(params: unknown): string[] {
  const message = text((params as WarningLike | null | undefined)?.message);
  const at = message.toLowerCase().indexOf(UNSTABLE_FEATURES_MARKER);
  if (at < 0) return [];
  const tail = message.slice(at + UNSTABLE_FEATURES_MARKER.length);
  const stop = tail.search(/\.(?:\s|$)/);
  return (stop >= 0 ? tail.slice(0, stop) : tail)
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length <= 64 && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(part))
    .slice(0, MAX_NAMED_FEATURES);
}

/**
 * One diagnostic line for one `warning` — the developer channel, full fidelity.
 *
 * The runtime's own sentence is kept WHOLE here (bounded only for length),
 * including its "set `suppress_unstable_features_warning = true`" advice, so the
 * record of what codex said is exactly what codex said. The operator-facing
 * sentence is the one that editorialises; see {@link codexServerWarningNotice}.
 */
export function describeCodexServerWarning(params: unknown): string {
  const message = bounded(text((params as WarningLike | null | undefined)?.message), 600)
    || 'no message on the notification';
  if (isCodexUnstableFeaturesWarning(params)) {
    const named = codexUnstableFeatureNames(params);
    return '[codex warning] UNDER-DEVELOPMENT FEATURES ARE LIVE IN THIS SESSION'
      + `${named.length ? ` (${named.join(', ')})` : ''} — codex stages these as incomplete, so `
      + 'behaviour here is not the behaviour of a released feature. '
      + `${message}`;
  }
  return `[codex warning] ${message}`;
}

/**
 * The operator-facing sentence, or `null` when there is nothing to say.
 *
 * `null` for a payload with no readable message — mirroring the event adapter's
 * `guardianWarning` branch, which drops an empty one rather than surfacing an
 * empty row.
 *
 * TWO deliberate departures from the runtime's own wording, both because this
 * string ends up in a transcript a human reads rather than in a log:
 *
 *  - It leads with the CONSEQUENCE ("features codex calls incomplete are live"),
 *    not the symptom. The symptom reads like a build note; the consequence is
 *    that the session's behaviour is not the released behaviour.
 *  - It does NOT relay codex's "set `suppress_unstable_features_warning = true`"
 *    advice as advice. That key is one of the four P2.384 pinned unwritten, and
 *    the tripwire cannot catch a slip because all four are schema-valid — so
 *    repeating the suggestion to an operator would invite precisely the edit the
 *    pin forbids, for the sole purpose of re-silencing this notice. The full
 *    sentence, suppression clause included, is still on the diagnostic channel
 *    ({@link describeCodexServerWarning}); nothing is hidden, only re-aimed.
 */
export function codexServerWarningNotice(params: unknown): string | null {
  const message = bounded(text((params as WarningLike | null | undefined)?.message), 400);
  if (!message) return null;
  if (isCodexUnstableFeaturesWarning(params)) {
    const named = codexUnstableFeatureNames(params);
    return 'Codex: this session is running features codex marks as under development'
      + `${named.length ? ` (${named.join(', ')})` : ''}. They are incomplete and may behave `
      + 'unpredictably, so what happens here is not what a released feature would do.';
  }
  return `Codex: ${message}`;
}
