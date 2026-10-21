/**
 * The receiving side of `send_agent_message` — the loop stop and the inbound
 * control, in one place because they answer the same question about the same
 * message.
 *
 * Two documented contracts live here, both from
 * `cross-session-messaging.md`, and BOTH were unimplemented before this module:
 *
 * §Limitations — "**Message loops are throttled**: in the receiving session,
 * Claude Code rate-limits repeated messages per sender, drops identical repeats
 * arriving within a short window, and queues at most 50 accepted messages for
 * Claude to read. A message loop between two sessions therefore stops on its
 * own. When the rate limit, repeat check, or queue cap drops a message from an
 * interactive session on this machine, Claude Code tells that session which one
 * dropped it and tells its Claude not to resend right away."
 *
 * §Control inbound messages — "Set `crossSessionInbound` to choose what a
 * session does with messages arriving from your other sessions", with the three
 * values `accept` (deliver each message), `hold` (show a notice and do not
 * deliver; release when an `accept` later applies) and `refuse` (drop each
 * message without delivering it). The hold buffer's size is documented in the
 * same section — "Claude Code holds at most 100 messages, separately from the
 * delivery queue, and past that drops the oldest."
 *
 * **Native-first, asked and answered.** No runtime we ship has a mechanism here
 * we merely failed to enable. `send_agent_message` is OUR tool, served by the
 * host to all three runtimes through one path, so any cap is ours to write.
 *
 * **That reading has MOVED, and the direction matters (P2.460, 2026-09-03).**
 * Measured against the vendored bundle rather than the docs (the bundle is the
 * denominator for what the runtime can already do): `claude-agent-sdk` 0.3.223's
 * `sdk.mjs` and its native `claude` binary carried `SendMessage`/`ListAgents` as
 * names and `isolatePeerMachines` as a settings-schema field but scored ZERO for
 * `crossSessionInbound` — so the sentence that stood here, "the inbound-control
 * half of the upstream feature is not in the artifact we ship", was true when
 * written and is FALSE now. **0.3.233 declares the key**:
 * `crossSessionInbound?: 'accept' | 'hold' | 'refuse'` in `sdk.d.ts`, and
 * `z.enum(["accept","hold","refuse"]).optional().catch(void 0)` in `sdk.mjs` —
 * `grep -ac` 2 and 1, against 0 and 0 on 0.3.223, with `disableClaudeAiConnectors`
 * 1 and `disallowedTools` 4 unchanged on both bundles as the positive controls. So
 * the three values below are no longer only ours: they are the vendor's spelling,
 * and so is the ladder {@link CROSS_SESSION_INBOUND_LADDER} ranks them on.
 * `CLAUDE_CODE_MESSAGING_SOCKET` still scores zero on both. Codex has no
 * session-to-session tool at all. Pi's own `MailboxService` DOES carry
 * `maxMessages`/`maxBytes`, and is deliberately not reused: it is the inert
 * agent-teams mailbox (R23, declined by the owner), a different subsystem with
 * no production caller, and finishing it here would pre-empt that call.
 * The residual difference is therefore uniform by construction — one host
 * choke point, identical for Pi, claude-runtime and codex.
 *
 * **AND THAT LAST SOCKET SENTENCE IS NOW FALSE TOO — P7.17, re-measured
 * 2026-09-11 on the vendored `0.3.247` / `2.1.247`.** The direction of travel is
 * the same as P2.460's and it has gone further: what arrived is not one field
 * but a whole native subsystem, present in the BINARY and almost entirely absent
 * from the declared type surface. Counted with `grep -aoF`, control
 * `nessyNotARealSdkKey` → 0 on every artefact:
 *
 * | name | `sdk.d.ts` | `sdk.mjs` | native `claude` |
 * | --- | --- | --- | --- |
 * | `CLAUDE_CODE_MESSAGING_SOCKET` | 0 | 0 | **17** (was 0 on 0.3.223 AND 0.3.233) |
 * | `notify_when_idle` | 0 | 0 | **51** |
 * | `fromMode` | 1 | 0 | 48 |
 * | `projects-relay` | 1 | 0 | 9 |
 * | `crossSessionInbound` | 2 | 2 | 43 |
 *
 * The binary carries `CLAUDE_CODE_MESSAGING_SOCKET` + `CLAUDE_CODE_MESSAGING_TOKEN`
 * as a declared env pair, a session registry that keys on the socket path, a
 * `udsInboxShape`, and framed `[uds-messaging]` diagnostics for a
 * `notify_when_idle` frame — i.e. a real unix-domain-socket ingress with its own
 * protocol, whose own refusal text says it "is only supported for Claude sessions
 * on this machine in this release". `SDKMessageOrigin`'s peer member now declares
 * `fromMode?: 'bypass' | 'prompting'` — *"The SENDING session's permission class
 * as declared by the host that injects this message on local stdin"* — which is
 * exactly what {@link crossSessionPermissionClass} computes here, and the
 * task-notification member gained a third `subkind`, `'projects-relay'`.
 *
 * **Nothing to READ, and the reason is not a shortage of will.** This host is the
 * INJECTOR on every path: `send_agent_message` is our tool, both sessions are
 * ours, and the sender's permission mode is a fact we hold directly — so
 * `fromMode` is a channel for declaring what we already know, not a source of
 * anything we lack. Reading it would mean taking our own assertion back off the
 * wire. Two spellings to keep straight the day a stamp is written:
 * {@link CrossSessionPermissionClass} is `bypassing`/`prompting` and the
 * vendor's is `bypass`/`prompting` — one word apart, pinned by
 * `shared/src/config/__tests__/cross-session-inbound-user-setting.test.ts` so a
 * future stamp cannot send the wrong one.
 *
 * **And the SUBSYSTEM is not adopted, which is a posture rather than an
 * omission.** It is claude-only by its own words, while this rung is one choke
 * point for three runtimes; switching to it would split a uniform seam and leave
 * Pi and codex on the host rung anyway — the share-vs-split rule's "a split needs
 * a MEASURED native mechanism" is satisfied for the first time here, and the
 * split is REFUSED: **owner answer QX2 = B, 2026-09-11** — keep the one shared
 * host rung, because uniformity across the three runtimes is worth more today
 * than one native track, and this rung already carries the vendor's own field
 * names (P7.17). The measured table above stays exactly as measured and is not
 * the residue of an unanswered question: it is the evidence that the refusal is
 * a CHOICE rather than an absence, and it is what an owner reversal (answer A,
 * the split) would be re-read against.
 *
 * **Where the documentation is silent we decided rather than queued.** The page
 * names the queue cap (50) and the hold cap (100) but gives no number for the
 * rate limit or for "a short window". Both defaults below are stated in code,
 * overridable by the operator, and reported to the sender when they fire, so an
 * undecided value cannot masquerade as a defect. The residue is written down at
 * {@link CROSS_SESSION_INBOUND_ENV} rather than hidden.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parsePermissionJsonc } from '@nessy-agent/shared/agent/pi-harness/permission-dsl'
// P6.868 · ONE renderer for the quoted value this key's warnings print. It lives
// beside the user rung's reader in shared because both halves of the same
// warning family must spell a value the same way.
import {
  crossSessionInboundUnrecognizedSentence,
  describeUnrecognizedCrossSessionInbound,
} from '@nessy-agent/shared/config/storage'

/** `accept` | `hold` | `refuse`, per §Control inbound messages. */
export type CrossSessionInboundMode = 'accept' | 'hold' | 'refuse'

/**
 * P6.182 · the two classes the page's default rule sorts sessions into.
 *
 * §Control inbound messages, verbatim: "When no value applies, Claude Code
 * decides per message from the two sessions' permission modes. It groups
 * sessions that bypass permission prompts into one class, and every other
 * session into the other. Plan mode counts as bypassing in sessions with bypass
 * permissions available, and auto, `acceptEdits`, and `dontAsk` count as
 * prompting".
 */
export type CrossSessionPermissionClass = 'bypassing' | 'prompting'

/**
 * The class of ONE session, from its permission mode.
 *
 * `bypassAvailable` is the page's "in sessions with bypass permissions
 * available" qualifier and is the caller's to answer — on this host it is the
 * conjunction of the process-level refusal (`isBypassPermittedForProcess`, root
 * or sudo outside a container) and the administrator's `disabledPermissionModes`.
 * A `plan` session on a host where bypass is refused is therefore in the
 * PROMPTING class, which is the safe direction: the pair is more likely to
 * differ, and differing is what raises the approval dialog.
 *
 * Every mode this host has that the page does not name — `default` — falls to
 * `prompting` (the page's "every other session"); a retired `explore` is read as `plan` (F1.1050).
 */
export function crossSessionPermissionClass(
  mode: string | undefined,
  options: { readonly bypassAvailable: boolean },
): CrossSessionPermissionClass {
  if (mode === 'bypassPermissions') return 'bypassing'
  if (mode === 'plan' && options.bypassAvailable) return 'bypassing'
  return 'prompting'
}

/**
 * P6.182 · what a session does with an arriving message when NO
 * `crossSessionInbound` value applies.
 *
 * The page states it as two bullets rather than a table, and they are the two
 * halves of one exclusive-or:
 *
 * - "**The receiving session prompts for permissions**: Claude Code delivers
 *   each message. It holds one for your approval only when the sending session
 *   identifies itself as bypassing permission prompts."
 * - "**The receiving session bypasses permission prompts**: Claude Code holds
 *   each message for your approval. It delivers one only when the sending
 *   session identifies itself as also bypassing."
 *
 * So the two classes AGREEING delivers and the two classes DIFFERING holds, in
 * both directions. The asymmetric-looking wording is one rule seen from each
 * side.
 *
 * This is a DEFAULT, not a floor: an explicit `crossSessionInbound` value
 * replaces it outright (that is what "when no value applies" means), and the
 * project/local scopes then tighten the result exactly as they do today
 * ({@link resolveCrossSessionInboundWithScopes}). Making it a floor instead
 * would leave a user who wrote `accept` unable to turn the dialog off, which is
 * not a control.
 */
export function crossSessionInboundDefaultMode(input: {
  readonly senderClass: CrossSessionPermissionClass
  readonly receiverClass: CrossSessionPermissionClass
}): CrossSessionInboundMode {
  return input.senderClass === input.receiverClass ? 'accept' : 'hold'
}

/**
 * P6.182 · `dialogExpiry`, the deadline the default-hold approval dialog runs on.
 *
 * `settings-reference.md#dialogexpiry`, verbatim: "**Type**: string, one of
 * `"60s"`, `"5m"`, `"10m"`, or `"never"`, which disables the deadline" and
 * "**Default**: `"5m"`". `undefined` here IS `never` — it is also exactly what
 * the renderer's `useAskUserAutoContinue` treats as "arm nothing", so the two
 * spellings of "no deadline" are one value rather than two.
 */
export const DIALOG_EXPIRY_MS: Readonly<Record<string, number | undefined>> = Object.freeze({
  '60s': 60_000,
  '5m': 300_000,
  '10m': 600_000,
  never: undefined,
})

/** "**Default**: `"5m"`" — `settings-reference.md#dialogexpiry`. */
export const DEFAULT_DIALOG_EXPIRY = '5m'

/**
 * The documented PER-SESSION override, read under its own name because it is
 * the nearest documented solution and costs nothing to honour:
 * "**Per-session overrides**: `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` takes
 * precedence over this key for one session".
 */
export const DIALOG_TIMEOUT_MS_ENV = 'CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS'

/**
 * The operator control, beside {@link CROSS_SESSION_INBOUND_ENV} and for the
 * same reason: `dialogExpiry`'s documented scope is "User or managed", and this
 * host has no reader for a Claude USER settings document at this seam — only
 * the project/local pair the inbound key's exception table names, which is the
 * wrong scope for this key. Stating an env control rather than silently reading
 * the wrong file is the transparent half; the `/config` row that would write the
 * user-settings value is P6.182 clause (i), held by another lane.
 */
export const DIALOG_EXPIRY_ENV = 'NESSY_DIALOG_EXPIRY'

/**
 * Resolve the approval dialog's deadline in milliseconds; `undefined` is
 * `never`.
 *
 * Order is the page's: the per-session ms override first, then the named value,
 * then the documented default. An unusable value is a DIAGNOSTIC and falls to
 * the default rather than to `never` — silently disabling a deadline is the one
 * direction that turns a misspelling into an unbounded hold.
 */
export function resolveDialogExpiryMs(
  env: Readonly<Record<string, string | undefined>>,
): { ms: number | undefined; diagnostic?: string } {
  const rawMs = env[DIALOG_TIMEOUT_MS_ENV]?.trim()
  if (rawMs) {
    const parsed = Number(rawMs)
    if (Number.isFinite(parsed) && parsed > 0) return { ms: parsed }
    return {
      ms: DIALOG_EXPIRY_MS[DEFAULT_DIALOG_EXPIRY],
      diagnostic: `${DIALOG_TIMEOUT_MS_ENV}="${rawMs}" is not a positive number of milliseconds; the held-message dialog is using the ${DEFAULT_DIALOG_EXPIRY} default.`,
    }
  }
  const raw = env[DIALOG_EXPIRY_ENV]?.trim()
  if (!raw) return { ms: DIALOG_EXPIRY_MS[DEFAULT_DIALOG_EXPIRY] }
  if (raw in DIALOG_EXPIRY_MS) return { ms: DIALOG_EXPIRY_MS[raw] }
  return {
    ms: DIALOG_EXPIRY_MS[DEFAULT_DIALOG_EXPIRY],
    diagnostic: `${DIALOG_EXPIRY_ENV}="${raw}" is not one of ${Object.keys(DIALOG_EXPIRY_MS).join('|')}; the held-message dialog is using the ${DEFAULT_DIALOG_EXPIRY} default.`,
  }
}

/**
 * The operator control. Host-wide rather than per-session, and that IS the
 * residue, stated rather than papered over.
 *
 * The page's own primary use of `refuse` is the organization-wide managed
 * setting (§Turn off cross-session messaging pairs it with
 * `permissions.deny: ["SendMessage", "ListAgents"]`), and a host-wide switch
 * discharges exactly that. The two lower settings SCOPES the page's exceptions
 * table names are discharged beside it —
 * {@link resolveCrossSessionInboundWithScopes}, P2.460's `crossSessionInbound`
 * leg.
 *
 * STILL NOT discharged, and left for a row of its own: the `/config` row and the
 * permission-mode-class default — which holds a message for the user's approval
 * and therefore needs an approval card in the renderer plus `dialogExpiry`,
 * neither of which exists. Until that lands, no value means `accept`, which is
 * what the host did before this module and what the page's *prompting receiver
 * / prompting sender* case also does.
 */
export const CROSS_SESSION_INBOUND_ENV = 'NESSY_CROSS_SESSION_INBOUND'

/**
 * "queues at most 50 accepted messages for Claude to read" — the documented
 * number, and by coincidence the one this file already uses for every other
 * bounded runtime list (`PI_RUNTIME_MAX_ITEMS`).
 */
export const CROSS_SESSION_QUEUE_CAP = 50

/** "Claude Code holds at most 100 messages … and past that drops the oldest." */
export const CROSS_SESSION_HOLD_CAP = 100

/**
 * Undocumented, so chosen from the system's RESTING behaviour and not from
 * zero.
 *
 * Resting for this path is one message per sender per receiver TURN: a
 * coordinating session writes to a peer when it has something to hand over, and
 * the peer's reply costs a full model turn, which is seconds at best. Ten per
 * minute per sender is therefore roughly an order of magnitude above anything a
 * legitimate coordinator produces, while a runaway A→B→A exchange — bounded by
 * tool dispatch rather than by turns once one side stops waiting — crosses it
 * quickly. A limit set at or near the resting rate would manufacture its own
 * failure the first time two sessions genuinely coordinated.
 *
 * Only ADMITTED messages consume an allowance. Counting refused attempts too
 * would make a retrying sender extend its own block indefinitely, which turns a
 * throttle into a permanent mute.
 */
export const CROSS_SESSION_RATE_LIMIT = 10
export const CROSS_SESSION_RATE_WINDOW_MS = 60_000

/** "drops identical repeats arriving within a short window" — the short window. */
export const CROSS_SESSION_REPEAT_WINDOW_MS = 60_000

/**
 * Bounds on the GUARD's own memory. A loop stopper that grows without limit is
 * the bug it exists to prevent, one level up.
 */
const MAX_TRACKED_SENDERS = 64
const MAX_TRACKED_REPEATS_PER_SENDER = 32

interface SenderWindow {
  /** Admission timestamps inside the rate window, oldest first. */
  stamps: number[]
  /** `sha256(text)` → timestamp of the last ADMITTED copy. */
  repeats: Map<string, number>
}

export interface HeldCrossSessionMessage {
  senderId: string
  text: string
  at: number
  /**
   * P6.182 · which of the two holds this is, because the page gives them
   * different lifetimes out of one buffer.
   *
   * `explicit` — the operator (or a stricter scope) wrote `hold`. "A message
   * held by an explicit `hold` setting doesn't expire; Claude Code delivers it
   * only when an `accept` later applies."
   *
   * `default` — no value applied and the two permission classes differ, so the
   * receiver shows an approval dialog and the message expires with it.
   *
   * They share ONE buffer, and therefore one documented cap ("Claude Code holds
   * at most 100 messages, separately from the delivery queue, and past that
   * drops the oldest"), and one release rule.
   */
  via: 'explicit' | 'default'
  /** The approval dialog's request id, for a `default` hold only. */
  requestId?: string
  /** The workspace the SENDER lives in, so a follow-up notice can reach it. */
  senderWorkspaceId?: string
}

export interface CrossSessionInboundState {
  senders: Map<string, SenderWindow>
  held: HeldCrossSessionMessage[]
  /**
   * Accepted-but-undelivered agent messages, i.e. this sink's contribution to
   * the receiver's `pendingTaskNotifications`.
   *
   * Kept here rather than derived from the queue because the queue is a plain
   * `string[]` shared with four other producers, and it is CLAMPED by the
   * queue's length at every read ({@link admitCrossSessionMessage}'s
   * `queuedCount` argument) rather than decremented at every drain site. The
   * queue drains wholesale to `undefined`, so a clamp reaches 0 exactly when the
   * queue empties — and clamping can only ever under-count, which is the safe
   * direction for a cap: it can delay a drop, never invent one.
   */
  queued: number
}

export type CrossSessionDropGuard = 'rate-limit' | 'identical-repeat' | 'queue-cap'

/**
 * What the SENDER is told. The page requires this half explicitly — "Claude Code
 * tells that session which one dropped it and tells its Claude not to resend
 * right away" — so a verdict that does not name its guard is not the documented
 * behaviour, it is a silent drop.
 */
export type CrossSessionVerdict =
  | { status: 'delivered' }
  /**
   * `awaitingApproval` marks the DEFAULT hold — the receiver is showing an
   * approval dialog and the caller must raise it. An explicit `hold` leaves it
   * unset: no dialog, no deadline, released only when an `accept` later applies.
   */
  | { status: 'held'; note: string; awaitingApproval?: boolean; heldAt?: number }
  | { status: 'refused'; note: string }
  | { status: 'dropped'; guard: CrossSessionDropGuard; note: string }

export function createCrossSessionInboundState(): CrossSessionInboundState {
  return { senders: new Map(), held: [], queued: 0 }
}

/**
 * Read the operator's value. An unrecognized value is a DIAGNOSTIC, never a
 * silent fallback: a misspelt `refused` that quietly kept delivering would be
 * exactly the "control that stops controlling" class this work exists to close.
 *
 * ## P6.872 · this variable is read as MANAGED, so an unreadable value REFUSES
 *
 * `settings-reference.md#crosssessioninbound` gives ONE key TWO unrecognized-value
 * treatments, and {@link CROSS_SESSION_INBOUND_ENV} stands in for both halves of
 * the page's trusted pair (managed settings and the `--settings` flag), so it had
 * to be told which of the two it is. Both sentences, verbatim (anchor verified
 * 2026-09-10 by `curl`ing the page WITHOUT `.md` and grepping `id="…"`):
 *
 * - the softer, for files the session's own user owns — *"While that value is
 *   present in a user, project, local, or `--settings` file, Claude Code holds
 *   inbound messages, even when a source that takes precedence sets `accept`."*
 * - the stricter, for the administrator's — *"When the unrecognized value is in
 *   managed settings, Claude Code instead treats it as `refuse` until an
 *   administrator fixes it."*
 *
 * The owner's ruling of 2026-09-10 took the STRICTER one, and the page's own
 * reason for it is why: this variable is OPERATOR-authored — it is set where the
 * machine is provisioned, not in a file the session's user can open — so
 * *"until an administrator fixes it"* is precisely the case we are in. Until that
 * ruling this returned `accept` with `explicit: false` and fell through to the
 * permission-class default, which is NEITHER of the page's two treatments.
 *
 * `explicit` rides out TRUE for the refusal, and that is not a claim that the
 * operator chose `refuse`. It is the field the permission-class default hangs on,
 * and a managed value that cannot be read is still a value that applies; leaving
 * it false would let the default re-open what this refuses. The diagnostic
 * carries the provenance the flag cannot, which is the row's *"with the refusal
 * named"*.
 */
export function resolveCrossSessionInboundMode(
  raw: string | undefined,
): { mode: CrossSessionInboundMode; explicit: boolean; diagnostic?: string } {
  const value = raw?.trim().toLowerCase()
  // P6.182 · `explicit` is what separates "the operator chose accept" from "no
  // value applies", and the page hangs the whole permission-class default on
  // that distinction. Before this row the two were the same `accept` and the
  // default rule had nowhere to attach.
  if (!value) return { mode: 'accept', explicit: false }
  if (value === 'accept' || value === 'hold' || value === 'refuse') return { mode: value, explicit: true }
  // P6.872 · the managed treatment, per the docblock above: refuse until an
  // administrator fixes it, rather than falling to the permission-class default.
  return {
    mode: 'refuse',
    explicit: true,
    diagnostic: `${CROSS_SESSION_INBOUND_ENV}="${raw}" is not one of accept|hold|refuse. This host reads that variable as managed settings, so cross-session messages arriving here are REFUSED until it is fixed or removed.`,
  }
}

/**
 * P2.460 · the `accept` < `hold` < `refuse` ladder, spelled once.
 *
 * `settings.md#exceptions-to-managed-settings-precedence` is where the ORDER is
 * normative rather than merely suggestive — the `crossSessionInbound` row reads,
 * verbatim: "A stricter value from `.claude/settings.json` or
 * `.claude/settings.local.json`, on the `accept` \< `hold` \< `refuse` ladder"
 * (anchor verified 2026-09-03 by `curl`ing the page WITHOUT `.md` and grepping
 * `id="…"`; the same section also publishes the explicit span
 * `#security-keys-where-the-stricter-value-applies`).
 *
 * Array order IS the ranking: index ascending = stricter. Nothing else in this
 * module may re-derive it.
 */
export const CROSS_SESSION_INBOUND_LADDER = ['accept', 'hold', 'refuse'] as const satisfies readonly CrossSessionInboundMode[]

/** The stricter of two rungs. Undefined contributes nothing. */
export function strictestCrossSessionInboundMode(
  ...modes: readonly (CrossSessionInboundMode | undefined)[]
): CrossSessionInboundMode {
  let winner: CrossSessionInboundMode = 'accept'
  for (const mode of modes) {
    if (!mode) continue
    if (CROSS_SESSION_INBOUND_LADDER.indexOf(mode) > CROSS_SESSION_INBOUND_LADDER.indexOf(winner)) winner = mode
  }
  return winner
}

/**
 * One settings document's `crossSessionInbound`, and nothing else out of it.
 *
 * Spelled EXACTLY as the vendor spells it — the key is
 * `crossSessionInbound?: 'accept' | 'hold' | 'refuse'` in `claude-agent-sdk`
 * 0.3.233's `sdk.d.ts`, and its zod is `.catch(void 0)`, i.e. the vendor drops an
 * unrecognized value rather than failing the document.
 *
 * **The SILENCE around that drop is what P6.866 corrected; the drop itself
 * stands.** This function still yields no mode for an unrecognized value — see
 * {@link crossSessionInboundSettingOf}, which additionally reports the value so
 * the resolver can warn and hold.
 *
 * Case is NOT folded here, deliberately, and this diverges from
 * {@link resolveCrossSessionInboundMode}. That one reads an ENV var, where
 * shouting is idiomatic; this reads a JSON document whose schema is the vendor's
 * `z.enum`, which is exact. A `"REFUSE"` in a settings file is a value the vendor
 * would drop, so dropping it keeps the two hosts reading one file the same way —
 * and, since P6.866, warning about it keeps the user from never finding out.
 */
export function parseCrossSessionInboundSetting(config: unknown): CrossSessionInboundMode | undefined {
  return crossSessionInboundSettingOf(config).mode
}

/** What one settings document says about this key: a rung, a typo, or nothing. */
export interface CrossSessionInboundSettingRead {
  /** Set only for one of the three exact spellings. */
  readonly mode?: CrossSessionInboundMode
  /**
   * Set when the key is PRESENT and unreadable — already rendered for a warning
   * line. Distinct from an absent key, which is the documented "unset" state and
   * must stay silent.
   */
  readonly unrecognized?: string
}

/**
 * The same read as {@link parseCrossSessionInboundSetting}, keeping the one fact
 * that one throws away: whether the key was PRESENT and unreadable.
 *
 * That distinction is the whole of P6.866. Absent is the page's documented
 * default — *"Default: unset, so Claude Code decides per message"* — and must
 * stay silent; present-and-unreadable is a typo the user is entitled to hear
 * about.
 */
export function crossSessionInboundSettingOf(config: unknown): CrossSessionInboundSettingRead {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const value = (config as Record<string, unknown>)['crossSessionInbound']
  if (value === undefined) return {}
  if (value === 'accept' || value === 'hold' || value === 'refuse') return { mode: value }
  return { unrecognized: describeUnrecognizedCrossSessionInbound(value) }
}

/** The rungs the page's warn-and-hold sentence enumerates and this host has. */
export type CrossSessionInboundScope = 'user' | 'project' | 'local'

/**
 * Where the user goes to fix it. The `--settings` flag is absent by design — this
 * host has no such flag; its stand-in is {@link CROSS_SESSION_INBOUND_ENV}, whose
 * own unreadable value is reported by {@link resolveCrossSessionInboundMode}.
 */
const CROSS_SESSION_INBOUND_SCOPE_LABEL: Record<CrossSessionInboundScope, string> = {
  user: 'your user settings',
  // The same pair as CROSS_SESSION_INBOUND_SETTINGS_FILES below, written with a
  // forward slash the way the page writes it rather than `join`ed: this is a
  // sentence the user reads, not a path anything opens. `settings-files-drift`
  // in the test file asserts the two agree.
  project: '.claude/settings.json',
  local: '.claude/settings.local.json',
}

/**
 * The warning the page specifies, prefixed with the file that holds it.
 *
 * ## ONE VOICE, since P6.939
 *
 * The SENTENCE now lives in `shared/config/storage.ts` as
 * {@link crossSessionInboundUnrecognizedSentence}, and `StoredConfigSchema`'s
 * `crossSessionInbound` enum reads the same function for its error message. So
 * a bad value is explained identically wherever a user meets it: this resolver's
 * warning, `validateConfig()`, the `config_validate` session tool that formats
 * it, and — since P6.878 — the settings-doctor page and `apps/cli/src/doctor.ts`,
 * whose collector calls `validateConfig()` without anyone asking.
 *
 * WHY IT MOVED, and it is a measurement rather than tidiness. P6.874 recorded
 * two voices as the SMALLER answer, for two reasons and a cost: the two surfaces
 * covered different ground (the validator reads `<config dir>/config.json`, the
 * user rung only, while this module also reads `.claude/settings.json` and
 * `.claude/settings.local.json`), they said different things (zod's bare enum
 * list against the page's three clauses), and merging was bought with a package
 * move because `packages/shared` cannot import `packages/server-core`. That
 * paragraph named its own trigger — *"a doctor collector calling
 * `validateConfig()`"* — and P6.878 (`d402a36af` + `2e1fe2e8a`) shipped exactly
 * that. Once both surfaces speak unasked, two wordings for one typo is a defect
 * rather than a scope difference; the package move is paid by putting the
 * sentence in `shared` beside the value renderer it already shared.
 *
 * WHAT STAYS HERE is the half `shared` cannot know: the SCOPE PREFIX. Only this
 * module reads three files, and the page's own note is why it matters — *"The
 * warning's second sentence depends on which file holds the value"*. The
 * validator has one file and needs no prefix.
 */
export function crossSessionInboundUnrecognizedWarning(
  value: string,
  scope: CrossSessionInboundScope,
): string {
  return `${CROSS_SESSION_INBOUND_SCOPE_LABEL[scope]}: `
    + crossSessionInboundUnrecognizedSentence(value)
}

/**
 * P6.918 · how much of the held message a follow-up notice quotes.
 *
 * Short on purpose. The notice rides `deliverMonitorEvent` into the SENDER's
 * transcript, where it is context the sender did not ask for; the job is to
 * make two holds to one receiver tell each other apart, not to replay the
 * message. The sender wrote the text and recognises it from its opening.
 */
const HELD_MESSAGE_QUOTE_CHARS = 48

/**
 * P6.918 · the follow-up notices name the MESSAGE, not only the receiver.
 *
 * N7's `done_means` asks for a notice saying which message it was. Every text
 * below used to name `<receiverName> (session <id>)` and nothing else, so two
 * messages held for one receiver settled with byte-identical notices — and the
 * hold buffer takes up to {@link CROSS_SESSION_HOLD_CAP}, so "two" is the small
 * case. {@link HeldCrossSessionMessage} already carries `text` and `at`, which
 * is why this costs no new field.
 *
 * BOTH are quoted, and the timestamp is not decoration: two identical texts to
 * one receiver are exactly what the identical-repeat window admits once the
 * window has passed, and then the quote alone still does not separate them.
 *
 * Pure and exported so the four wordings can be asserted without a live
 * SessionManager; `SessionManager.notifyCrossSessionSender` supplies the
 * receiver and the delivery.
 */
export function crossSessionOutcomeNotice(
  held: Pick<HeldCrossSessionMessage, 'text' | 'at'>,
  outcome: 'approved' | 'denied' | 'expired' | 'refused',
  receiver: { name: string; sessionId: string },
): string {
  const subject = `Your message to ${receiver.name} (session ${receiver.sessionId})`
  // Newlines and runs of blank space collapse first: the notice is one line in
  // a transcript, and a multi-line quote would read as the notice ending.
  const flat = held.text.replace(/\s+/g, ' ').trim()
  const quote = flat.length > HELD_MESSAGE_QUOTE_CHARS
    ? `${flat.slice(0, HELD_MESSAGE_QUOTE_CHARS)}…`
    : flat
  const stamp = new Date(held.at).toISOString()
  const which = quote.length > 0
    ? ` — the one sent at ${stamp} beginning "${quote}"`
    : ` — the one sent at ${stamp}`
  switch (outcome) {
    case 'approved':
      return `${subject}${which} was approved and delivered.`
    case 'denied':
      return `${subject}${which} was declined by its user and was not delivered. Do not resend it.`
    case 'refused':
      return `${receiver.name} (session ${receiver.sessionId}) is no longer accepting cross-session `
        + `messages, so your held message${which.replace(' — the one sent', ' — sent')} was dropped. `
        + 'Do not wait for a reply and do not resend.'
    case 'expired':
      return `${subject}${which} expired without an answer and was not delivered. `
        + 'Do not resend it right away.'
  }
}

/** A settings file this size is not a settings file; refuse to read it. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024

/**
 * The two files the exceptions table names, relative to the project directory.
 * Same pair, same reader, as `config/skill-overrides.ts` and
 * `agent/memory/instruction-excludes.ts`.
 */
export const CROSS_SESSION_INBOUND_SETTINGS_FILES = {
  project: join('.claude', 'settings.json'),
  local: join('.claude', 'settings.local.json'),
} as const

/**
 * An UNREADABLE FILE is not an unrecognized VALUE, and the three `{}` returns
 * below are that distinction. The page's warning is about *"a value it doesn't
 * recognize"*; a missing file, an absurd one, and one that is not JSON at all set
 * no value, so they warn about nothing and hold nothing. Only a document that
 * parses and carries the key can reach {@link crossSessionInboundSettingOf}'s
 * `unrecognized` branch.
 */
function readCrossSessionInboundSetting(path: string): CrossSessionInboundSettingRead {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return {}
  }
  if (raw.length > MAX_SETTINGS_FILE_BYTES) return {}
  try {
    return crossSessionInboundSettingOf(parsePermissionJsonc(raw))
  } catch {
    return {}
  }
}

/** Which scope supplied a rung, for the one-line report the operator sees. */
export interface CrossSessionInboundScopeVerdict {
  readonly mode: CrossSessionInboundMode
  /**
   * Set only when a settings file was STRICTLY stricter than the operator's
   * value — the case worth a log line, because it is the one where the running
   * host is doing something the operator's own control does not say.
   */
  readonly tightenedBy?: 'project' | 'local'
  /**
   * P6.866 · one line per rung that carries a value this host cannot read.
   *
   * OMITTED, not empty, when there are none — every existing caller asserts the
   * verdict with `toEqual({ mode })`, and an always-present `warnings: []` would
   * change what "nothing happened" looks like for all of them.
   */
  readonly warnings?: readonly string[]
}

/**
 * P2.460 · the lower-scope exception for `crossSessionInbound`, applied at THIS
 * key's own resolution point.
 *
 * ## Why here and not in the managed composition
 *
 * `config/managed-composition.ts` merges SOURCES; this rule is about a SCOPE
 * beating a source, and the two are different axes. That module states the
 * boundary and leaves the seven exception keys refused at parse — which is
 * correct and stays correct, because adding a strict pole with no enforcement is
 * the stated-but-unenforced trap. This key is the one of the seven whose
 * enforcement ALREADY EXISTS (`admitCrossSessionMessage`, below), so wiring the
 * scopes here adds a control that actually controls rather than a field.
 *
 * ## What the page says, and what we implement
 *
 * The table's `crossSessionInbound` row, verbatim: "A stricter value from
 * `.claude/settings.json` or `.claude/settings.local.json`, on the `accept` \<
 * `hold` \< `refuse` ladder", honored "over managed, `--settings`, and user
 * values; a project or local value that isn't stricter is ignored".
 *
 * So the resolution is a MAXIMUM on the ladder, never a replacement: the two
 * files can only tighten. That is what makes the whole thing safe to ship —
 * every reachable outcome is at least as strict as the operator asked for, which
 * is the one property `managed-composition.ts` requires of anything that touches
 * these seven.
 *
 * ## Three decisions the page does not make, stated rather than hidden
 *
 * 1. **No project-trust gate**, unlike `config/skill-overrides.ts`, which reads
 *    the same two files only for a trusted project. Two reasons, and the second
 *    is the decisive one. The influence is monotone-restrictive, so the worst a
 *    hostile repository can do is make this session REFUSE peer messages —
 *    a denial of our own feature, not a widening of anything. And
 *    `.claude/settings.local.json` is the USER's own file, not shipped by the
 *    repository; gating it on folder trust would ignore the user's own stricter
 *    value, which is exactly the laxer-than-asked outcome this key exists to
 *    prevent. The page states no trust condition either.
 * 2. **Read per inbound message, not cached.** The module already re-reads the
 *    mode on every arrival by design ("an arriving message is the cheapest
 *    honest trigger"), and a cache would make a settings edit take effect at an
 *    unpredictable time. The cost is two `readFileSync`s on a path that the rate
 *    limit already caps at {@link CROSS_SESSION_RATE_LIMIT} admissions per
 *    sender per minute.
 * 3. **No `--settings` scope — and, until P6.182 clause (i), no user scope
 *    either.** The page lists both among the values the exception is honored
 *    OVER, i.e. they lose to a stricter project/local value but are not
 *    themselves exception sources for this key. Our operator control stands in
 *    for `--settings` and for managed settings, and calling it "operator" rather
 *    than "user" keeps that substitution visible.
 *
 *    **CORRECTED by clause (i):** the user scope is now real, because the page
 *    gives it a writer — the `/config` row **Messages from your other sessions**
 *    *"writes the value you select to your user settings"* — and a rung with a
 *    documented writer and no reader is a control that reports success and
 *    changes nothing. It enters through `userMode`/`operatorExplicit` above, at
 *    the rung the precedence sentence puts it in, and it can still only be
 *    tightened by the two files below it.
 */
export function resolveCrossSessionInboundWithScopes(scopes: {
  readonly operatorMode: CrossSessionInboundMode
  /**
   * P6.182 clause (i) — the USER-settings rung, and whether the operator claimed
   * the key before it.
   *
   * `settings-reference.md#crosssessioninbound`, verbatim: *"Claude Code reads
   * managed settings first, then the `--settings` flag, then user settings, and
   * applies the first value found."* So a user value loses to an explicit
   * operator value and beats the per-message default — which is exactly the
   * distinction `operatorMode` alone cannot make, because by the time it arrives
   * here an explicit operator value and a computed per-message default look the
   * same.
   *
   * BOTH OPTIONAL, and omitting them is today's behaviour byte for byte: a
   * caller that does not supply them gets the operator-or-default base it always
   * got. That is deliberate — the two arrive together from one call site, and a
   * `userMode` applied without `operatorExplicit` would let a user value
   * overwrite an operator's, which is the one direction this key must never
   * move.
   */
  readonly userMode?: CrossSessionInboundMode | undefined
  readonly operatorExplicit?: boolean
  /**
   * P6.866 · the user rung's value when it is PRESENT and unreadable, already
   * rendered by {@link describeUnrecognizedCrossSessionInbound}.
   *
   * Supplied by the caller for the same reason `userMode` is: the user rung is
   * read from this host's own config store, which lives in a package server-core
   * depends on rather than the other way round. Absent means "the caller did not
   * look", which is today's behaviour exactly.
   *
   * Note it applies with or without a `workingDirectory` — the page's hold is
   * about the FILE carrying the value, not about a project being open.
   */
  readonly userUnrecognized?: string | undefined
  /**
   * The project directory holding the two files. Absent — an unopened or
   * directory-less session — contributes neither scope, and the operator's value
   * stands.
   */
  readonly workingDirectory?: string | undefined
}): CrossSessionInboundScopeVerdict {
  const { operatorMode, userMode, operatorExplicit, userUnrecognized, workingDirectory } = scopes
  // "applies the first value found": the operator's value if it made one, else
  // the user's, else the per-message default already computed into operatorMode.
  //
  // The test `=== false` rather than `!== true` is the whole safety of this
  // line, and a unit caught the difference: an ABSENT `operatorExplicit` means
  // the caller did not answer the question, and treating "did not answer" as
  // "the operator claimed nothing" would let a user value overwrite an
  // operator's — the one direction this key must never move. Unanswered
  // therefore keeps today's behaviour exactly, whatever `userMode` says.
  const baseMode = operatorExplicit === false ? (userMode ?? operatorMode) : operatorMode
  // No working directory contributes neither file scope, exactly as before — but
  // it can no longer return early, because the USER rung's unreadable value
  // holds whether or not a project is open.
  const project: CrossSessionInboundSettingRead = workingDirectory
    ? readCrossSessionInboundSetting(join(workingDirectory, CROSS_SESSION_INBOUND_SETTINGS_FILES.project))
    : {}
  const local: CrossSessionInboundSettingRead = workingDirectory
    ? readCrossSessionInboundSetting(join(workingDirectory, CROSS_SESSION_INBOUND_SETTINGS_FILES.local))
    : {}

  // P6.866 · every rung carrying a value this host cannot read.
  //
  // `settings-reference.md#crosssessioninbound`, verbatim: "Claude Code warns
  // when you set a value it doesn't recognize. While that value is present in a
  // user, project, local, or `--settings` file, Claude Code holds inbound
  // messages, even when a source that takes precedence sets `accept`. A `refuse`
  // that another source sets still applies. Fix or remove the value to clear the
  // hold." (v2.1.248+; the vendored bundle self-reports 2.1.247 — it read
  // 2.1.233 until the P7.1 lift — and still carries none of this, so the PAGE
  // governs: the bundle-lags-the-docs direction, now by ONE patch version. Not
  // inferred from the version: re-measured 2026-09-12, C3.252, with the
  // instrument named as lines/occurrences (C3.294) — the page's own hold
  // sentence "Fix or remove the value to clear the hold" scores 0/0 in the
  // native binary while `crossSessionInbound` itself scores 16/43 as the
  // positive control, so the KEY is in there and the HOLD is not.)
  //
  // Both halves of that sentence fall out of the ladder rather than needing
  // logic of their own: a `hold` rung beats a preceding `accept` because
  // `strictest` is a maximum, and a `refuse` from anywhere still wins because
  // `refuse` outranks `hold`. That is the whole implementation.
  const unreadable: readonly { scope: CrossSessionInboundScope; value: string }[] = [
    ...(userUnrecognized === undefined ? [] : [{ scope: 'user' as const, value: userUnrecognized }]),
    ...(project.unrecognized === undefined ? [] : [{ scope: 'project' as const, value: project.unrecognized }]),
    ...(local.unrecognized === undefined ? [] : [{ scope: 'local' as const, value: local.unrecognized }]),
  ]
  const heldForRepair = unreadable.length > 0 ? ('hold' as const) : undefined
  const warnings = unreadable.map(({ scope, value }) => crossSessionInboundUnrecognizedWarning(value, scope))

  const mode = strictestCrossSessionInboundMode(baseMode, project.mode, local.mode, heldForRepair)
  // Both files may be stricter; name the one that actually reached the winning
  // rung, and prefer `local` when both did — it is the file a user edits. A rung
  // reached only by `heldForRepair` names NO file: it is not a stricter value,
  // and the warnings say where it came from with more precision than this field
  // could.
  const tightenedBy = mode === baseMode
    ? undefined
    : local.mode === mode ? 'local' as const
      : project.mode === mode ? 'project' as const
        : undefined
  return {
    mode,
    ...(tightenedBy ? { tightenedBy } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

function pruneWindow(window: SenderWindow, now: number): void {
  while (window.stamps.length > 0 && now - window.stamps[0]! >= CROSS_SESSION_RATE_WINDOW_MS) {
    window.stamps.shift()
  }
  for (const [hash, at] of window.repeats) {
    if (now - at >= CROSS_SESSION_REPEAT_WINDOW_MS) window.repeats.delete(hash)
  }
}

/** Drop sender windows that carry nothing live, then bound what is left. */
function pruneSenders(state: CrossSessionInboundState, now: number): void {
  for (const [senderId, window] of state.senders) {
    pruneWindow(window, now)
    if (window.stamps.length === 0 && window.repeats.size === 0) state.senders.delete(senderId)
  }
  while (state.senders.size > MAX_TRACKED_SENDERS) {
    const oldest = state.senders.keys().next()
    if (oldest.done) break
    state.senders.delete(oldest.value)
  }
}

/**
 * The one admission decision, in the page's own order: a refusing session never
 * accounts for anything; the loop guards run before the delivery/hold split so
 * a loop cannot fill the hold buffer either.
 *
 * Pure apart from the state it is handed, and it takes `now` rather than reading
 * the clock, so a test can pin a window boundary instead of sleeping through it.
 */
export function admitCrossSessionMessage(
  state: CrossSessionInboundState,
  input: {
    senderId: string
    text: string
    now: number
    queuedCount: number
    mode: CrossSessionInboundMode
    /**
     * P6.182 · `default` when the mode came from the two permission classes
     * rather than from a written value. Only that hold gets a dialog and a
     * deadline. Defaults to `explicit` so every existing caller keeps today's
     * behaviour.
     */
    heldVia?: 'explicit' | 'default'
    /** For a `default` hold: the dialog's request id and the sender's workspace. */
    requestId?: string
    senderWorkspaceId?: string
  },
): CrossSessionVerdict {
  const { senderId, text, now, queuedCount, mode } = input
  const heldVia = input.heldVia ?? 'explicit'
  state.queued = Math.max(0, Math.min(state.queued, queuedCount))

  if (mode === 'refuse') {
    return {
      status: 'refused',
      note: `That session is not accepting cross-session messages (${CROSS_SESSION_INBOUND_ENV}=refuse). Do not resend; route the work back to your user instead.`,
    }
  }

  pruneSenders(state, now)
  const window = state.senders.get(senderId) ?? { stamps: [], repeats: new Map<string, number>() }
  state.senders.set(senderId, window)
  pruneWindow(window, now)

  if (window.stamps.length >= CROSS_SESSION_RATE_LIMIT) {
    const retryInMs = CROSS_SESSION_RATE_WINDOW_MS - (now - window.stamps[0]!)
    return {
      status: 'dropped',
      guard: 'rate-limit',
      note: `The rate limit dropped it: that session accepts ${CROSS_SESSION_RATE_LIMIT} messages per sender per ${Math.round(CROSS_SESSION_RATE_WINDOW_MS / 1000)}s. Do not resend right away — wait about ${Math.max(1, Math.ceil(retryInMs / 1000))}s, or batch what is left into one message.`,
    }
  }

  const hash = hashText(text)
  const lastIdentical = window.repeats.get(hash)
  if (lastIdentical !== undefined && now - lastIdentical < CROSS_SESSION_REPEAT_WINDOW_MS) {
    return {
      status: 'dropped',
      guard: 'identical-repeat',
      note: `The repeat check dropped it: an identical message reached that session ${Math.max(0, Math.round((now - lastIdentical) / 1000))}s ago. Do not resend it — change what you are asking, or wait.`,
    }
  }

  if (mode === 'hold') {
    admitToWindow(window, hash, now)
    state.held.push({
      senderId,
      text,
      at: now,
      via: heldVia,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.senderWorkspaceId ? { senderWorkspaceId: input.senderWorkspaceId } : {}),
    })
    // "past that drops the oldest"
    while (state.held.length > CROSS_SESSION_HOLD_CAP) state.held.shift()
    // The page requires the sender be told which of the two holds this is —
    // "Claude Code shows a notice there when the receiver holds the message, and
    // a follow-up when the receiver later delivers, denies, or expires it" is
    // the DEFAULT hold's promise and an explicit `hold` makes no such promise.
    // A single note for both would tell one of them to expect a follow-up that
    // never comes.
    if (heldVia === 'default') {
      return {
        status: 'held',
        awaitingApproval: true,
        heldAt: now,
        note: 'That session is holding this message for its user to approve, because the two sessions are in different '
          + 'permission-prompt classes. Do not resend; you will be told when it is delivered, denied or expires.',
      }
    }
    return {
      status: 'held',
      note: `That session is holding messages (${CROSS_SESSION_INBOUND_ENV}=hold), so it has not read this one. Do not wait for a reply and do not resend.`,
    }
  }

  if (state.queued >= CROSS_SESSION_QUEUE_CAP) {
    return {
      status: 'dropped',
      guard: 'queue-cap',
      note: `The queue cap dropped it: that session already has ${CROSS_SESSION_QUEUE_CAP} unread messages waiting. Do not resend right away — wait for it to read them.`,
    }
  }

  admitToWindow(window, hash, now)
  state.queued += 1
  return { status: 'delivered' }
}

function admitToWindow(window: SenderWindow, hash: string, now: number): void {
  window.stamps.push(now)
  window.repeats.set(hash, now)
  while (window.repeats.size > MAX_TRACKED_REPEATS_PER_SENDER) {
    const oldest = window.repeats.keys().next()
    if (oldest.done) break
    window.repeats.delete(oldest.value)
  }
}

/**
 * "If an `accept` later applies … Claude Code releases the held messages."
 *
 * Returns them in arrival order and empties the buffer; the caller delivers.
 */
export function releaseHeldCrossSessionMessages(
  state: CrossSessionInboundState,
): readonly HeldCrossSessionMessage[] {
  const released = state.held
  state.held = []
  return released
}

/**
 * P6.182 · take ONE default-held message back out, by the id of the approval
 * dialog that was raised for it.
 *
 * Returns `undefined` for an id this buffer does not hold, which is the ordinary
 * case rather than an error: the hold cap may already have dropped the oldest,
 * a mode change may have released it, or the same answer may arrive twice. Every
 * caller therefore has to treat a miss as "already settled" and do nothing.
 */
export function takeHeldCrossSessionMessage(
  state: CrossSessionInboundState,
  requestId: string,
): HeldCrossSessionMessage | undefined {
  const index = state.held.findIndex(held => held.requestId === requestId)
  if (index < 0) return undefined
  const [taken] = state.held.splice(index, 1)
  return taken
}

/** True when nothing about this receiver is worth remembering any more. */
export function crossSessionInboundStateIsEmpty(state: CrossSessionInboundState): boolean {
  return state.senders.size === 0 && state.held.length === 0 && state.queued === 0
}
