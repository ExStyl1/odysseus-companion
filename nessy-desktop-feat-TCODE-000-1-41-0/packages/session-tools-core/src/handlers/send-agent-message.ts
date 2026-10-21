import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SendAgentMessageArgs {
  sessionId: string;
  message?: string;
  /**
   * P6.465 (N6). Snake_case because it is the model-facing input name the page
   * gives it — "Claude subscribes with the `SendMessage` tool's
   * `notify_when_idle` input" — and this interface is the shape the schema
   * validates, not a host-internal record.
   */
  notify_when_idle?: boolean;
}

/**
 * P6.465 (N8) — "**Same-machine message size is capped**: Claude Code refuses a
 * message to a session on this machine once its serialized form passes about a
 * million characters."
 * (`cross-session-messaging.md#limitations`)
 *
 * The number is the one the documented refusal prints:
 * `errors.md#message-too-large-for-cross-session-delivery` shows
 * "the serialized message is 1,203,844 characters and the limit is 1,048,576",
 * so the cap is 1 MiB of characters rather than "about a million".
 */
export const CROSS_SESSION_MESSAGE_CHAR_LIMIT = 1_048_576;

/**
 * C3.224 — how many sessions the NAME lookup reads before it stops.
 *
 * `list_sessions`'s own default is 20, which is a listing for a model to read;
 * this is a lookup nobody reads, so it takes a bound large enough that a
 * truncation is a real machine rather than a small default. When the listing IS
 * truncated the refusal says so, because
 * `cross-session-messaging.md#see-which-sessions-claude-can-reach` has that arm
 * by name — *"Several sessions share the name, or Claude Code couldn't check
 * everywhere your sessions run"* — and a lookup that answers "no such session"
 * from a page it did not finish reading is the silent wrong answer this row
 * exists to remove.
 */
const SESSION_NAME_LOOKUP_LIMIT = 500;

type CrossSessionTargetV1 =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly message: string };

/**
 * C3.224 (= row D1.80 of the integrations plan, carried from P6.464) — address a
 * session by NAME, on one unambiguous match, with no confirmation step and
 * without the model listing anything first.
 *
 * `cross-session-messaging.md#message-another-session`, verbatim (the anchor this
 * citation used to carry was minted from the paragraph lead-in *"To name the
 * target yourself"*, which is not a heading and gets no id — the page publishes
 * the sentence inside this section instead; re-measured 2026-09-12 by W18-e, and
 * the dead spelling is named in words here on purpose, because writing it as a
 * page name followed by a hash and the anchor would keep the guard firing on its
 * own repair -- and so is THIS sentence, because the placeholder that named that
 * form was itself read as a citation to a page called `page` and re-created the
 * finding one line further on): *"Claude Code
 * inserts the mention, such as `@api-worker`, and tells Claude which session it
 * names, so Claude can message that session without listing your sessions
 * first."* And
 * `cross-session-messaging.md#see-which-sessions-claude-can-reach`: *"One
 * session answers to the name: Claude Code delivers the message on the name
 * alone."*
 *
 * **"Without listing first" is about the MODEL, not about the host.** This
 * function calls `ctx.listSessions` — the same host port the `list_sessions`
 * TOOL is bound to — precisely so the model does not have to: the round trip
 * that disappears is the tool call and the turn it costs, not the lookup.
 *
 * **The ladder is untouched.** This resolves WHO the message is for and nothing
 * else; whether it is accepted, held or refused is still decided on the
 * receiving side (`server-core/sessions/cross-session-inbound.ts`, P6.182). The
 * row's own ordering clause requires exactly that — a fast path that dropped a
 * human step must not also drop the gate.
 *
 * **The order of the two questions matters.** An ID is tried first, because a
 * session id is what every existing caller passes and what `spawn_session`
 * returns; a NAME lookup is reached only when the string is not a live id. And
 * when `getSessionInfo` is not bound at all, this passes the string through
 * unchanged rather than guessing — a host that cannot answer "is this an id"
 * must not have a name refusal invented on its behalf.
 */
async function resolveCrossSessionTarget(
  ctx: SessionToolContext,
  requested: string,
): Promise<CrossSessionTargetV1> {
  if (!ctx.listSessions || !ctx.getSessionInfo) return { ok: true, sessionId: requested };

  try {
    if (await ctx.getSessionInfo(requested)) return { ok: true, sessionId: requested };
  } catch {
    // An unreadable session record is not evidence that the string is a name.
    return { ok: true, sessionId: requested };
  }

  let listing;
  try {
    listing = await ctx.listSessions({ limit: SESSION_NAME_LOOKUP_LIMIT });
  } catch {
    return { ok: true, sessionId: requested };
  }

  const matches = listing.sessions.filter((session) => session.name === requested);
  const truncated = listing.total > listing.returned;
  const truncationNote = truncated
    ? ` Only ${listing.returned} of ${listing.total} sessions were checked, so a session beyond that page could also answer to this name.`
    : '';

  if (matches.length === 1 && !truncated) {
    return { ok: true, sessionId: matches[0]!.id };
  }

  // Ambiguity and truncation take the same arm, and deliberately: the page puts
  // them together — "Several sessions share the name, or Claude Code couldn't
  // check everywhere your sessions run" — because both mean the same thing to a
  // sender, that the name alone does not identify one session.
  //
  // C3.316 — the refusal tells the model to ASK THE USER, and that verb is the
  // row. The page assigns this decision to nobody else, verbatim (line 63 of
  // `cross-session-messaging.md`, inside `#message-another-session`): *"You can
  // also type the mention without the picker. When more than one live session
  // answers to the mentioned name, Claude asks you which one you mean before
  // sending."* This sentence used to end *"Send again with the sessionId of the
  // one you mean"*, which is an instruction the model cannot follow: it does not
  // know which one the user meant, so it picks — and delivering to the wrong
  // session is the single outcome C3.224's own docblock says the name-addressing
  // half exists to prevent. The candidates and their ids stay, because a model
  // that must ask needs something to ask WITH.
  if (matches.length > 1 || (matches.length === 1 && truncated)) {
    const rows = matches.map((session) => `${session.id} (${session.status})`).join(', ');
    return {
      ok: false,
      message: `"${requested}" is not one session: ${matches.length} live sessions answer to that name — ${rows}.`
        + ' Nothing was sent. Ask the user which one they mean before sending, then send again with'
        + ` that sessionId — do not choose one yourself.${truncationNote}`,
    };
  }

  return {
    ok: false,
    message: `No live session on this machine is named "${requested}", and it is not a session ID either.`
      + ` Nothing was sent. Use list_sessions to see the sessions reachable from here.${truncationNote}`,
  };
}

/**
 * `send_agent_message` — one session's model writing to another, plus the
 * one-shot idle subscription that rides the same call.
 *
 * Two of the page's three caps already live on the RECEIVING side
 * (`server-core/sessions/cross-session-inbound.ts`: the per-sender rate limit
 * and the identical-repeat window, with the queue cap beside them). The size cap
 * is the one that cannot: the page requires it to fire "in the sending session,
 * before it leaves", and the failure it replaces is silent loss — "Before
 * v2.1.235, Claude Code reported an oversized message as sent. The receiving
 * session dropped it unread."
 */
export async function handleSendAgentMessage(
  ctx: SessionToolContext,
  args: SendAgentMessageArgs
): Promise<ToolResult> {
  if (!ctx.sendAgentMessage) {
    return errorResponse('send_agent_message is not available in this context.');
  }

  if (!args.sessionId?.trim()) {
    return errorResponse('sessionId is required.');
  }

  // C3.224 — `sessionId` accepts a session NAME as well as an id, and one
  // unambiguous live match sends with no confirmation step. An ambiguous or dead
  // name refuses BY NAME rather than resolving to the wrong session.
  const target = await resolveCrossSessionTarget(ctx, args.sessionId.trim());
  if (!target.ok) return errorResponse(target.message);
  const targetSessionId = target.sessionId;

  const notifyWhenIdle = args.notify_when_idle === true;
  const body = args.message?.trim() ?? '';
  if (!body && !notifyWhenIdle) {
    // Still required for an ordinary send. It stops being required only for the
    // page's subscribe-on-its-own case, where there is deliberately nothing to
    // deliver: "On its own, Claude Code subscribes without starting a turn or
    // spending tokens in the watched session".
    return errorResponse('message is required.');
  }

  // Prevent self-send (would create a recursive loop)
  if (targetSessionId === ctx.sessionId) {
    return errorResponse('Cannot send a message to your own session. Use a different sessionId.');
  }

  try {
    // The sender envelope is the reply address, and it rides the TEXT: the
    // delivery is one string on the between-turns notification path, which
    // carries no structured sender field for the receiver to read.
    const senderName = (await ctx.getSessionInfo?.())?.name ?? ctx.sessionId;
    const wrappedMessage = body
      ? [
        `[Message from session "${ctx.sessionId}" (${senderName})]`,
        `Use send_agent_message with sessionId "${ctx.sessionId}" to reply.`,
        '',
        '---',
        '',
        body,
      ].join('\n')
      : '';

    // N8 · BEFORE dispatch, and measured on what actually crosses — the wrapped
    // envelope, not the caller's `message`, because the envelope is the
    // "serialized form" the receiving side would have to hold. Both numbers are
    // named, per the documented refusal text, so the model can tell how much to
    // cut rather than guessing.
    if (wrappedMessage.length > CROSS_SESSION_MESSAGE_CHAR_LIMIT) {
      return errorResponse(
        `Failed to send to ${targetSessionId}: Message too large for cross-session delivery: `
        + `the serialized message is ${wrappedMessage.length.toLocaleString('en-US')} characters `
        + `and the limit is ${CROSS_SESSION_MESSAGE_CHAR_LIMIT.toLocaleString('en-US')}. `
        + 'Shorten the message text — put bulk content in a file the recipient can read rather '
        + 'than in the message — or split it into smaller messages.'
      );
    }

    const verdict = notifyWhenIdle
      ? await ctx.sendAgentMessage(targetSessionId, wrappedMessage, { notifyWhenIdle: true })
      : await ctx.sendAgentMessage(targetSessionId, wrappedMessage);

    // A subscription-only call has no message to report on, so the subscription
    // IS the result. The host still answers with a delivery verdict, because a
    // refusal of the whole call ("Claude Code refuses the whole call, including
    // any message attached to it") has to be reportable through one channel.
    if (!wrappedMessage) {
      if (verdict.status !== 'delivered' || verdict.subscription?.status === 'refused') {
        return errorResponse(
          `No idle notice was set up for session ${targetSessionId}.`
          + (verdict.subscription?.note ? ` ${verdict.subscription.note}` : verdict.note ? ` ${verdict.note}` : '')
        );
      }
      return successResponse(
        verdict.subscription?.note
          ?? `Session ${targetSessionId} will send one notice when it next goes idle or exits.`
      );
    }

    // `cross-session-messaging.md` §Limitations: "When the rate limit, repeat
    // check, or queue cap drops a message from an interactive session on this
    // machine, Claude Code tells that session which one dropped it and tells its
    // Claude not to resend right away." The same page names the failure this
    // guards against: "Before v2.1.236, Claude Code reported those sends as sent
    // while the receiving session dropped them." So anything other than
    // `delivered` reports as a FAILED send carrying the receiver's own note —
    // never as a success the model would then wait on a reply for.
    if (verdict.status !== 'delivered') {
      return errorResponse(
        `Message to session ${targetSessionId} was not delivered (${verdict.status}).`
        + (verdict.note ? ` ${verdict.note}` : '')
        + (verdict.subscription?.note ? ` ${verdict.subscription.note}` : '')
      );
    }

    return successResponse(
      `Message sent to session ${targetSessionId}. It arrives as a task notification between that session's turns, so a reply is not immediate.`
      // The subscription's own outcome rides the SUCCESS text when the message
      // itself landed: a refused subscription must not turn a delivered message
      // into a reported failure, which is the same silent-loss shape inverted.
      + (verdict.subscription ? ` ${verdict.subscription.note}` : '')
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send message: ${message}`);
  }
}
