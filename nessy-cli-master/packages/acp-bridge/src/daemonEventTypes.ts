/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon SSE event-`type` wire literals shared across the daemon publisher
 * (`acp-bridge`), the SDK validator/reducer, and the browser consumer.
 *
 * Kept in this DEPENDENCY-FREE module (no `import type` from core, unlike
 * `bridgeTypes.ts`) so the SDK can re-export these from `@nestor/nessy-cli-sdk/daemon`
 * via its build-time devDep on acp-bridge WITHOUT pulling acp-bridge's type
 * graph into the SDK's bundled `.d.ts` — the same lightweight pattern as
 * `mcpTimeouts.ts`.
 */

/**
 * Published when the daemon drains queued mid-turn messages into the running
 * turn. The browser consumes it to move those messages out of its pending queue
 * so they aren't resent as the next turn (a transient dedupe signal). Single
 * source of truth: a rename here propagates to every importer, so it can't
 * silently break browser-side dedup. `data: { sessionId, messages: string[] }`.
 */
export const MID_TURN_MESSAGE_INJECTED_EVENT = 'mid_turn_message_injected';

/**
 * Published when the agent issues an ACP `elicitation/create` (form mode)
 * request for a session. HTTP/SSE clients render a form from
 * `data.requestedSchema` and answer via `POST /session/:id/elicitation/:requestId`.
 * `data: { requestId, sessionId, message, mode, requestedSchema, toolCallId? }`.
 */
// [nessy-fork] acp-elicitation-ask-user-question
export const ELICITATION_REQUEST_EVENT = 'elicitation_request';

/**
 * Published when an HTTP/SSE client answers a pending elicitation. Consumers
 * (e.g. the web-shell transcript) use it to mark the elicitation block
 * resolved. `data: { requestId, sessionId, outcome }`.
 */
// [nessy-fork] acp-elicitation-ask-user-question
export const ELICITATION_RESOLVED_EVENT = 'elicitation_resolved';
