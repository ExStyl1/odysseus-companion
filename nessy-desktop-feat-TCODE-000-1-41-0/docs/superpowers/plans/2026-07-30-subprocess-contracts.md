# The subprocess honors its contracts — R18, R24 remainder

Two refuted/partial rows, both inside `packages/pi-agent-server`: **a schema
the model is judged against but never shown, and an elicitation lifecycle
declared per-session but reset by nobody.**

## 0. Method rules

1. `curl -s https://code.claude.com/docs/en/structured-outputs.md` and the MCP
   elicitation section of `mcp.md` (plus `errors.md` where cited); quote whole
   lines.
2. **Declared ≠ enforced.** Prove on Pi — spawn the real subprocess against an
   HTTP stub where the claim is about the wire.
3. **NUL bytes**: always `grep -a` for absence claims.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** Check no other `bun test` is
   running before recording a new failure.
6. CDP instance may be on 9223 — do not kill or drive it. Do NOT run
   `electron:build:servers` (it overwrites the live instance's bundles).

## 1. Task 1 — the model sees the schema it must match (R18)

**Commit:** `fix(agents): structured output shows the model the schema`

Challenger, probe-proven (real subprocess, HTTP stub, request bodies read):
the schema's property names appear NOWHERE in the first model call — not in
the system prompt, not in the user message, not in `tools`, no
`response_format`/`json_schema` on the request. The reprompt carries only ajv
error strings — "Return only valid JSON matching the schema" for a schema the
model has never been shown. Verified by the planner: `compiledOutputSchema`
(`index.ts:3262`) reaches only `runTurnStructuredOutputValidation` (`:3340`).

- Decide the channel from what the Pi wire supports: if the pi-ai OpenAI-like
  path can carry `response_format`/`json_schema`, prefer it for gateways that
  accept it — but the Nessy Gateway is OpenAI-like with fragile tool shapes
  (see AGENTS.md), so the SAFE floor is prompt injection: render the schema
  into the turn (the same technique `buildCallLlmRequest` already uses for
  `outputSchema` — read it and reuse, don't invent a second renderer).
- The reprompt must include the schema too, not only the ajv errors.
- **The manifest hash pins tool shapes** — do not touch tool definitions; a
  schema block in prompt text is composition-safe, but say explicitly in the
  report that no `PI_STATIC_MODEL_CONTRACT_HASHES` pin changed.
- Prove at the same seam the challenger used: subprocess against an HTTP stub,
  assert the schema's property names appear in the first request of a
  schema-bearing turn, and in the reprompt after an invalid answer.

**Gate:** stub-read request bodies contain the schema (first call and
reprompt); validation behavior unchanged (the existing structured-output
suites stay green). **Mutation:** drop the injection → the request-body test
goes red.

## 2. Task 2 — the elicitation lifecycle resets, completes, and retries (R24)

**Commit:** `fix(mcp): the elicitation gate resets per session and URL mode completes`

Three named absences, from the re-verification:

1. **`gate.reset()` has no production caller** — verified first-hand:
   `elicitation-dialog-gate.test.ts:113` is the only call; the singleton lives
   at `index.ts:919` and the subprocess demonstrably re-inits sessions in
   place, so stale dialog ids survive across session re-init. Wire `reset()`
   into the actual session re-init path (find where a new session replaces the
   old one in `index.ts` — prove the call fires by test).
2. **The URL-completion notification path is absent.** In URL mode the server
   is told the user finished via the documented completion notification;
   nothing sends it. Read the doc section fresh and implement the notification
   at the point the dialog resolves.
3. **The `-32042` failure-driven retry flow is absent.** The documented retry
   semantics on that error code have no implementation. Same: read the page,
   implement at the response path, one representative test each way.

If any of the three turns out to exist under another name, that is a finding —
say so with the evidence instead of building a duplicate (`grep -a` the
concept first: reset, elicitation complete, -32042, retry).

**Gate:** a re-inited session starts with an empty dialog-id set (probe with a
stale id); URL-mode completion sends the documented notification; a `-32042`
response triggers the documented retry once. **Mutation:** unwire `reset()` →
the stale-id test goes red.

## 3. Task 3 — category strings

**Commit:** `docs(audit): the subprocess contract surfaces left open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 chars.

## 4. Gate

Focused suites per changed file; the pi-agent-server aggregate and the
harness-contract pins once on the final diff (wire/schema is a named risk
trigger — and `SafeInstalledPluginSummary`-style pins live in
`__tests__/harness-contract/fixtures/runtime-behavior.json`, which B1e learned
the hard way); `bun run typecheck:all`; `bun run lint`; `git diff --check`.

## 5. Constraints

- You own `packages/pi-agent-server/src/**` and its tests. Two sibling
  executors run elsewhere: (pi-agent.ts / pre-tool-use.ts / SessionManager.ts /
  permission-service.ts) and (plugins/format-adapters + claude-agent.ts) —
  STAY OUT. If a fix needs a host-side change, report it as a residual.
- One commit per task, subjects exactly as given. No `Co-Authored-By`. No
  push/MR/tags/reset/rebase/--amend/`checkout --`/stash of edited files.
  Mutations restored by re-edit or `.orig`, never git.
- No `docs/superpowers/specs/` or checklist edits; no version bumps; never
  write `~/.nessy/dp_auth_creds.json`; loopback stubs only.
- Code, comments and commits in English.

## 6. Report

Commit shas; the stub-read request bodies before/after; where `reset()` is now
called from and the proof; the notification and retry doc lines quoted whole;
whether any of the three existed under another name; no-pin-changed statement;
corrections; mutation probes with sides.

## 7. Open deviations (Task 3, recorded 2026-07-30)

Both are host-side surfaces of the R24 remainder: the MCP client lives in
`packages/shared/src/mcp/`, which this subprocess unit does not own. One
direction correction to §2: per the MCP 2025-11-25 elicitation spec the
completion notification travels server → client, so the client's missing piece
is a HANDLER, not a sender.

- URL-mode completion notification (MCP spec 2025-11-25, Completion Notifications for URL Mode Elicitation) — `documented, not implemented — clients MUST ignore notifications referencing unknown or already-completed IDs and MAY use them to auto-retry, but NessyMcpClient in packages/shared/src/mcp/client.ts registers no notifications/elicitation/complete handler; the vendored MCP SDK 1.29.0 ships ElicitationCompleteNotificationSchema with no Nessy consumer. Host-side, outside this subprocess unit.`
- -32042 failure-driven retry (MCP spec 2025-11-25, URL Elicitation Required Error) — `documented, not implemented — a URLElicitationRequiredError names the elicitations to complete before the original request can be retried, but no Nessy code catches code -32042 or retries the original request; the catch belongs at the host MCP response path in packages/shared/src/mcp/client.ts and elicitation.ts, and SDK 1.29.0 already defines ErrorCode.UrlElicitationRequired unconsumed.`
