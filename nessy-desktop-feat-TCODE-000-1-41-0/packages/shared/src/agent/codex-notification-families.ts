/**
 * P3.270 — every server-notification family the codex app-server can send,
 * classified, so that none of them is SILENTLY dropped.
 *
 * ## What was wrong
 *
 * `codex-agent.ts` and `backend/codex/event-adapter.ts` between them read 17 of
 * the union's 72 methods, and the connection declared `optOutNotificationMethods`
 * nowhere. So 55 families were serialized by the binary, framed over stdio,
 * parsed by the transport, and discarded — every session, with no record that
 * they had arrived. That is two separate defects wearing one coat: traffic
 * nobody reads (cost), and facts codex states outright that this host currently
 * infers or never learns (silence).
 *
 * ## The denominator is a reading, not a fact
 *
 * The row that opened this said **74**; counted from the vendored union it was
 * **72**; the `rust-v0.150.1` lift took it to **79** and the guard fired exactly
 * as designed, on seven names (P6.1065, below). The denominator is
 * `ServerNotification.oneOf` in
 * `packages/codex-protocol/schema/codex_app_server_protocol.v2.schemas.json`,
 * read at TEST time rather than written down: {@link CODEX_NOTIFICATION_FAMILIES}
 * is derived from the three lists here, so a family added upstream fails the
 * build until it is classified. Every number in this paragraph is a reading with
 * a date, and none of them is asserted anywhere.
 *
 * ## The native mechanism, measured rather than assumed
 *
 * `InitializeCapabilities.optOutNotificationMethods` — *"Exact notification
 * method names that should be suppressed for this connection"*
 * (`packages/codex-protocol/generated/InitializeCapabilities.ts`, generated from
 * `rust-v0.148.0`). Native-first: nothing is filtered host-side.
 *
 * DRIVEN on the shipped `darwin-arm64/codex-app-server`, 2026-09-03, three arms
 * over one `initialize` → `thread/start` → `turn/start` session:
 *
 *  - baseline, bad rules file: 10 families arrive, `configWarning` among them;
 *  - the same run declaring `optOutNotificationMethods`
 *    `["remoteControl/status/changed","thread/status/changed","configWarning"]`:
 *    **7 families, exactly those three gone**, the other seven unchanged;
 *  - clean rules file: 9 families, no `configWarning` (the control that proves
 *    the bad-rules arm's warning came from the rules file).
 *
 * The middle arm carries the HAZARD as well as the capability: the suppression
 * is exact-name and unconditional, and `configWarning` is a family we DO read —
 * it is the channel that reports a lost security floor. So a name may only enter
 * {@link CODEX_OPTED_OUT_NOTIFICATION_METHODS} if it is in neither of the other
 * two lists, and {@link codexNotificationClassificationConflicts} refuses
 * overlap rather than trusting review to catch it.
 *
 * ## Conservative on purpose
 *
 * Only families this fork can never receive a fact on are opted out. Everything
 * else stays on the wire and is listed in {@link CODEX_UNREAD_NOTIFICATION_METHODS}
 * with the reason it is not read yet — because an over-broad opt-out is itself a
 * silent divergence, and the user cannot see one from the outside.
 */

/**
 * Families some part of this host actually reads.
 *
 * Where each is read, so the list can be re-derived rather than trusted:
 *  - `codex-agent.ts::handleNotification` — `error`, `warning`,
 *    `mcpServer/startupStatus/updated`, `turn/started`, `turn/completed`,
 *    `thread/tokenUsage/updated`, `item/completed`, `item/autoApprovalReview/completed`,
 *    `model/rerouted`, `deprecationNotice` and (F1.7) `account/rateLimits/updated`;
 *  - `codex-agent-server/src/app-server-client.ts` + `config-warning.ts` —
 *    `configWarning`, classified onto the diagnostic channel and raised to a
 *    durable operator notice by `noteCodexConfigWarningDiagnostic`;
 *  - `backend/codex/event-adapter.ts::adapt` — `thread/started`,
 *    `thread/status/changed`, `thread/compacted`, `item/started`,
 *    `item/agentMessage/delta`, `item/commandExecution/outputDelta`,
 *    `item/autoApprovalReview/started`, `guardianWarning`, (P3.295)
 *    `turn/plan/updated` + `item/plan/delta`, and (P6.1065, new here)
 *    `autoApprovalReview/strictReviewRequired`.
 *
 * `autoApprovalReview/strictReviewRequired` arrived with `rust-v0.150.1` and is
 * read as a DURABLE warning rather than a status line: it is not a verdict but
 * codex's own reviewer stating that its cached assessment cannot answer and a
 * strict review is required for the turn. The sentence and the source reading of
 * when the frame fires live in `approval-bridge.ts`'s
 * `describeStrictReviewRequired` — including the measured reason it cannot
 * arrive on a session yet (`guardianv2` self-reports `underDevelopment` and
 * `enabled: false` on the shipped binary), which is why it is classified as
 * handled-and-inert rather than as unread.
 */
export const CODEX_HANDLED_NOTIFICATION_METHODS = [
  'account/rateLimits/updated',
  'autoApprovalReview/strictReviewRequired',
  'configWarning',
  'deprecationNotice',
  'error',
  'guardianWarning',
  'item/agentMessage/delta',
  'item/autoApprovalReview/completed',
  'item/autoApprovalReview/started',
  'item/commandExecution/outputDelta',
  'item/completed',
  'item/plan/delta',
  'item/started',
  'mcpServer/startupStatus/updated',
  'hook/completed',
  'model/rerouted',
  'skills/changed',
  'thread/compacted',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/completed',
  'turn/plan/updated',
  'turn/started',
  'warning',
] as const;

/**
 * Families suppressed at `initialize`, because no code path in this fork can
 * ever receive a fact on them.
 *
 * Each entry names what makes it unreachable, and each claim is a call-site
 * absence that can be re-checked with one grep rather than a judgement:
 *
 *  - `thread/realtime/*` — the realtime voice session. This fork issues no
 *    `thread/realtime/*` request at all, so no session exists for these to
 *    describe. RE-CHECKED at `rust-v0.154.0` (I2.19, 2026-09-17), same
 *    instrument and same answer: `git grep -alF "thread/realtime"` over
 *    `packages apps scripts` hits the two generated bindings that spell the
 *    method strings, the three vendored schema files and this file — no call
 *    site anywhere, and nothing issues a `thread/realtime/start`. So the
 *    absence is *we never enabled what the runtime has*, not *the runtime
 *    cannot*: the honest half of the two-question rule, and it is a POSTURE
 *    (this fork ships no voice surface) rather than a gap. The bullet
 *    used to carry a parenthesised `(8)`, and the lift made it nine, ten and
 *    eleven in one step (`item/started`, `item/completed`,
 *    `item/transcript/delta` are new); the count is gone rather than bumped,
 *    because the list below is the only place it can be right.
 *  - `fuzzyFileSearch/*` (2) — the STREAMING half of a call this host makes
 *    synchronously: `CodexAgent.fuzzyFileSearch` awaits the `fuzzyFileSearch`
 *    RESPONSE and reads `files` off it. Measured end-to-end with the opt-out
 *    declared: the response still answers, so suppressing the progress frames
 *    costs nothing.
 *  - `app/list/updated` — the ChatGPT Apps catalogue. No `apps/list`,
 *    `apps/read` or `apps/installed` request is issued anywhere in this fork.
 *  - `externalAgentConfig/import/*` (2) — progress for an import this fork
 *    never starts.
 *
 * NOT opted out, deliberately, though nothing reads them either: the
 * `account/*` families. Provider auth and subscription surfaces are a GATED
 * area in this wave — not built, not deleted, not cleaned up — and suppressing
 * a channel is a change to it. They are listed as unread below instead.
 */
export const CODEX_OPTED_OUT_NOTIFICATION_METHODS = [
  'app/list/updated',
  'externalAgentConfig/import/completed',
  'externalAgentConfig/import/progress',
  'fuzzyFileSearch/sessionCompleted',
  'fuzzyFileSearch/sessionUpdated',
  'thread/realtime/closed',
  'thread/realtime/error',
  'thread/realtime/item/completed',
  'thread/realtime/item/started',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/itemAdded',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/started',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
] as const;

/**
 * Families that stay on the wire and are NOT read yet — each with the reason,
 * and each recorded on the diagnostic channel the first time it actually
 * arrives ({@link CodexAgent} `noteUnreadCodexNotification`). Listed rather than
 * suppressed because every one of them could carry a fact this host would
 * otherwise infer, and suppressing it would make that loss permanent and
 * invisible.
 *
 * Grouped by why they are still here:
 *
 * **Carries a switch-visible fact; a reader is owed** —
 *  - `turn/diff/updated`, `item/fileChange/patchUpdated`,
 *    `item/fileChange/outputDelta`: the edit in progress and the turn's
 *    aggregate diff.
 *  - `item/mcpToolCall/progress`: MCP progress notifications, which claude
 *    surfaces.
 *  - `mcpServer/oauthLogin/completed`: an MCP sign-in verdict (the codex twin
 *    of P3.246's claude-side notification).
 *  - `mcpServer/event/stream/notification`: new at `rust-v0.150.1`, and P6.1066
 *    REFUTED the reading that made it look like a gap. Re-read at
 *    `rust-v0.154.0` (I2.19's sibling row I2.17, 2026-09-17) and the refutation
 *    stands: `git grep -alF "mcpServer/event/stream/start"` over
 *    `packages apps scripts` still hits this file alone. It is not connection
 *    observability: it is the forwarded stream of a TOOL CALL the CLIENT starts
 *    with `mcpServer/event/stream/start`, and
 *    `app-server/src/request_processors/mcp_event_stream.rs` refuses that
 *    request for anything but the hosted-apps server — verbatim, *"MCP event
 *    subscriptions are only supported for hosted apps"*. This fork issues no
 *    `mcpServer/event/stream/start` and no `apps/*` request at all (the same
 *    absence that opts `app/list/updated` out), so the frame cannot arrive.
 *    Listed rather than suppressed anyway, because the reason is OUR absent
 *    request rather than the runtime's incapacity: the day a row starts a
 *    subscription, the notification must already be on the wire. The
 *    connection-state channel codex really publishes is
 *    `mcpServer/startupStatus/updated`, which is handled above, plus
 *    `McpServerStatus.runtimeStatus` on `mcpServerStatus/list` — both weighed in
 *    `base-agent.ts`'s `mcpServerStatuses`.
 *  - `item/commandExecution/terminalInteraction`, `process/outputDelta`,
 *    `process/exited`, `command/exec/outputDelta`: background process
 *    lifecycle.
 *  - `thread/reverted`: the thread's history changed under us.
 *  - `thread/settings/updated`: the runtime's own settings moved after we wrote
 *    them.
 *  - `windows/worldWritableWarning`: a security warning about the workspace.
 *    NOT given a reader here because it is win32-only and this lane's rig is
 *    darwin — an unmeasured reader on a security channel is worse than a named
 *    gap. `windowsSandbox/setupCompleted` sits beside it for the same reason.
 *  - `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`,
 *    `item/reasoning/summaryPartAdded`: the streaming halves of a reasoning
 *    item. MEASURED 2026-09-03 end-to-end (shipped binary → the real
 *    `codex-responses-adapter` → a stub upstream emitting `reasoning_content`):
 *    this binary delivers reasoning as an `item/started` / `item/completed`
 *    pair of `type: "reasoning"` and emits NONE of these three deltas, so the
 *    loss was in the event adapter's item switch, not here. **P3.294 closed that
 *    half** — the item pair now renders through the same thinking surface Pi and
 *    claude use — and these three stay unread deliberately: a binary that starts
 *    emitting them would be streaming a reasoning the completed item already
 *    delivers, and this host would then be choosing between two renderings
 *    rather than adding one. They are listed, not suppressed, so that day is
 *    visible on the diagnostic channel rather than silent.
 *
 * **codex's own PROJECT concept — RE-READ at `rust-v0.154.0`, and P6.929 STILL
 *  HOLDS** (I2.18, the row P6.1067 carried this to).
 *
 *  `project/changed` and `thread/project/updated` arrived at `rust-v0.150.1`.
 *  P6.929 settled that discovery stays on the project root and the primary
 *  folder is a display choice, and that decision was taken against a runtime
 *  that published no projects at all — which is why re-reading it was owed
 *  rather than assumed. Read from the generated bindings at `rust-v0.154.0`:
 *
 *   - a `Project` is `{ id, name, roots: Array<ProjectRoot>, metadata,
 *     position, createdAt, updatedAt, recencyAt }`, and `recencyAt`'s own doc
 *     says *"Newest non-archived member thread's recency"*. It is a
 *     THREAD-LIBRARY grouping — threads belong to a project — not a discovery
 *     scope. `ThreadProjectUpdatedNotification` is `{ threadId, projectId }`,
 *     i.e. which group a thread landed in, and `ProjectSortKey` is
 *     `"position" | "recencyAt"`, a list ordering.
 *   - **there is no client REQUEST for it.** Over the v2 schema the only
 *     `project`-shaped method string is the notification `project/changed`
 *     itself; NONE of the `ClientRequest` methods names a project, so this fork
 *     could not create, list or join one even if a row wanted to. The store is
 *     codex's own.
 *
 *     D1.105 re-took this on 2026-09-17 and the ABSENCE held while the
 *     DENOMINATOR did not, which is why the instrument is now named instead of
 *     the number being re-dated: extracting `"method": "…"` from
 *     `packages/codex-protocol/generated/ClientRequest.ts` answers **102**
 *     distinct methods, **0** naming a project, **28** naming a thread — the
 *     positive control that proves the probe reads the file. This line said 99,
 *     and a slash-shaped regex over the same bytes answers 96 because six
 *     methods (`initialize` among them) carry no slash. Three instruments, three
 *     numbers, one unchanged verdict: run the extraction rather than quote any
 *     of them.
 *
 *  So the one thing that could have bitten — a project carrying MULTIPLE
 *  `roots` where a host session has one working directory — is unreachable for
 *  the same reason the rest is: nothing of ours ever asks. The decision is
 *  re-affirmed on a runtime that does publish projects, which is a stronger
 *  standing than the one it had. Listed, never suppressed, so the day one
 *  arrives (a codex app on the same machine editing the shared store) it lands
 *  on the diagnostic channel rather than nowhere.
 *
 * **Thread-library bookkeeping this host does not mirror** —
 *  `thread/archived`, `thread/deleted`, `thread/unarchived`, `thread/closed`,
 *  `thread/name/updated`, `thread/goal/updated`, `thread/goal/cleared`,
 *  `thread/queue/changed` (this host owns its own queue),
 *  `thread/environment/connected`, `thread/environment/disconnected`, and
 *  `thread/attachment/updated` (new at `rust-v0.156.1`, F1.255): its only emitter
 *  is `app-server/src/request_processors/thread_attachments.rs`, answering a
 *  client's `thread/attachment/add` / `…/remove`, and this host sends neither.
 *
 * **Gated surfaces** — `account/updated`, `account/login/completed` (provider
 *  auth / subscription; `account/rateLimits/updated` LEFT this list in F1.7 and
 *  is merged into the `/quota` windows now),
 *  `remoteControl/status/changed` (the transport P2.381 disables; measured to
 *  arrive once per session on the shipped binary), and
 *  `account/gatewayOAuth/changed` (new at `rust-v0.159.3`, F1.1215): its only
 *  emitter, `gateway_oauth_notifications.rs`, forwards the sign-in status of a
 *  provider that declares `[model_providers.<id>.gateway_oauth]`, and this host
 *  writes no such table and sends none of the `account/gatewayOAuth/*` requests.
 *
 * **codex recovering its OWN provider auth mid-turn** —
 *  `modelProvider/authRecoveryStarted` and `modelProvider/authRecoveryCompleted`,
 *  both new at `rust-v0.154.0` (C3.380 lift 2). Read from the shipped binary
 *  rather than guessed at: both carry `AuthRecoveryNotification`
 *  (`{ threadId, turnId, provider, message }`), and the machinery behind them is
 *  codex refreshing its own authenticated session after a 401 — its strings are
 *  *"Cloud config bundle request was unauthorized; attempting auth recovery"*,
 *  *"Your authentication session could not be refreshed automatically. Please
 *  log out and sign in again."*, with telemetry fields `auth_recovery_mode`,
 *  `auth_recovery_phase`, `auth_recovery_outcome` and `auth_401_request_id`.
 *
 *  **D1.168's sibling row D1.169 read the EMITTER at the tag, and the reason
 *  recorded here was wrong in both halves — corrected, with the source.**
 *
 *  The old reason said `…Completed` carries no status field, so success and
 *  failure are the same notification. Refuted: `emit_auth_recovery_event`
 *  (`codex-rs/core/src/client.rs` at `rust-v0.154.0`) is called from exactly two
 *  places, both inside `handle_unauthorized`, and the `AuthRecoveryCompleted`
 *  call sits inside the `Ok(ProviderUnauthorizedRecovery::Recovered)` arm alone.
 *  The other two outcomes (`NotConfigured`, `Err`) emit nothing. **Its arrival IS
 *  the outcome**, so the payload needs no status field and a host that surfaced
 *  it could say exactly what happened.
 *
 *  The old reason also framed the open question as whether codex recovers for a
 *  DECLARED `model_providers.*` entry "rather than only for its own ChatGPT/cloud
 *  session". Read at the source, that framing is backwards: **these two
 *  notifications are PROVIDER-scoped and nothing else emits them.** The
 *  `handle_unauthorized` provider arm runs FIRST and is the only emitter; the
 *  `AuthManager` arm that follows it (`UnauthorizedRecovery::has_next`) emits no
 *  notification at all, only telemetry. That is why the method name begins
 *  `modelProvider/`, and the payload's `provider` field is
 *  `provider.info().name`.
 *
 *  **So the real reason they are unread is that this fork's sessions cannot
 *  produce them**, and it is a property of the provider rather than of the
 *  payload:
 *
 *   - the `ModelProvider` trait's DEFAULTS are `auth_recovery_messages() → None`
 *     and `recover_from_unauthorized() → NotConfigured`
 *     (`codex-rs/model-provider/src/provider.rs`), and the emitter is gated on
 *     `if let Some(messages) = provider.auth_recovery_messages()`;
 *   - at this tag exactly ONE provider overrides them —
 *     `model-provider/src/amazon_bedrock/mod.rs`, further gated on
 *     `uses_aws_auth_recovery()` — with the messages *"AWS session has expired.
 *     Reauthenticating..."* and *"Signed in with AWS."*. Both occur once in the
 *     shipped `codex-app-server` (`grep -aoF … | wc -l`), the control that the
 *     override really ships;
 *   - our sessions run on the declared loopback `[model_providers.<key>]` entry
 *     with `env_key = COMPANY_LLM_API_KEY`, a plain provider that takes both
 *     defaults. It declares no recovery, so no event is ever emitted.
 *
 *  Listed, never suppressed, so both still land on the diagnostic channel.
 *
 *  **What would reopen it, narrowed from a guess to one condition:** a codex
 *  session on the BYO Bedrock card — `resolveCodexModelProvider` answering
 *  `amazon-bedrock` — which is the one shape in which
 *  `uses_aws_auth_recovery()` can be true here. D1.172 measured that nothing in
 *  this product writes `codexModelProvider` today, so that condition is
 *  currently unreachable by construction; the day a surface writes it, these two
 *  become real, and the reader is worth building then because codex's own
 *  message is already the sentence a user needs.
 *
 * **Moderation and model-safety telemetry** — `model/verification`,
 *  `turn/moderationMetadata`, `model/safetyBuffering/updated`.
 *
 * **Other** — `fs/changed` (a file watcher we do not drive),
 *  `serverRequest/resolved` (an echo of a request the transport already tracks
 *  by id), and `hook/started`.
 *
 * `hook/completed` LEFT this list in P6.449 and is handled now: its
 * `run: HookRunSummary` is the same structured shape claude's
 * `SDKHookResponseMessage` carries, so `CodexEventAdapter.hookRunEvents` puts it
 * through the shared `reportHookRun` and a codex hook run is as legible as a
 * claude one. The reason recorded for both used to be *"this host dispatches
 * hooks itself and does not run codex's"* — true of the DISPATCH and irrelevant
 * to the REPORT: a hook codex ran is still a hook whose outcome the user is
 * entitled to see.
 *
 * `hook/started` stays unread, and its reason is now its own rather than
 * borrowed: `run.status` is `running` and it carries no outcome, so there is
 * nothing to report until the completion arrives. Pairing the two needs a
 * per-session run store, which is the host VIEW half of P6.449 and a row of its
 * own.
 *
 * `skills/changed` LEFT this list in P6.399 and is handled now. Its recorded
 * reason used to read *"skills are host-owned; codex reloading its own set
 * changes nothing we present"*, and the second clause was circular rather than
 * false: nothing changed in what we presented because we never READ what codex
 * would load. The pinned schema publishes `skills/list`, `skills/config/write`
 * and `skills/extraRoots/set` (`codex_app_server_protocol.schemas.json`) and
 * this fork sent NONE of them. `CodexAgent.syncCodexSkillsConfig` now sends the
 * first two — the third stays out of scope by P6.399's own text, sequenced with
 * P6.169 — so the notification is the moment the host re-reads codex's own skill
 * set instead of assuming a list it never fetched still matches.
 */
export const CODEX_UNREAD_NOTIFICATION_METHODS = [
  'account/gatewayOAuth/changed',
  'account/login/completed',
  'account/updated',
  'command/exec/outputDelta',
  'fs/changed',
  'hook/started',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'mcpServer/event/stream/notification',
  'mcpServer/oauthLogin/completed',
  'model/safetyBuffering/updated',
  'model/verification',
  'modelProvider/authRecoveryCompleted',
  'modelProvider/authRecoveryStarted',
  'process/exited',
  'process/outputDelta',
  'project/changed',
  'remoteControl/status/changed',
  'serverRequest/resolved',
  'thread/archived',
  'thread/attachment/updated',
  'thread/closed',
  'thread/deleted',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'thread/goal/cleared',
  'thread/goal/updated',
  'thread/name/updated',
  'thread/prediction/updated',
  'thread/project/updated',
  'thread/queue/changed',
  'thread/reverted',
  'thread/settings/updated',
  'thread/unarchived',
  'turn/diff/updated',
  'turn/moderationMetadata',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
] as const;

/** Every family this module classifies, in one set. */
export const CODEX_NOTIFICATION_FAMILIES: ReadonlySet<string> = new Set<string>([
  ...CODEX_HANDLED_NOTIFICATION_METHODS,
  ...CODEX_OPTED_OUT_NOTIFICATION_METHODS,
  ...CODEX_UNREAD_NOTIFICATION_METHODS,
]);

/**
 * The three lists must be DISJOINT, and the opt-out must not contain a name the
 * host reads.
 *
 * A function rather than a comment because the failure it guards is silent by
 * construction: `optOutNotificationMethods` is applied by the binary with no
 * acknowledgement, so a handled name that drifted into the opt-out list would
 * turn a read channel off and nothing would say so — measured above on
 * `configWarning`, which is the channel that reports a lost security floor.
 *
 * Returns the offending names; an empty array means the classification is
 * consistent.
 */
export function codexNotificationClassificationConflicts(): string[] {
  const seen = new Map<string, number>();
  for (const list of [
    CODEX_HANDLED_NOTIFICATION_METHODS,
    CODEX_OPTED_OUT_NOTIFICATION_METHODS,
    CODEX_UNREAD_NOTIFICATION_METHODS,
  ]) {
    for (const method of list) seen.set(method, (seen.get(method) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([method]) => method).sort();
}

/**
 * The three lists as sets, for the per-session record in
 * `CodexAgent.noteUnreadCodexNotification`.
 *
 * HANDLED is needed there and it is not obvious why: most handled families are
 * read by the EVENT ADAPTER, and the agent's dispatch falls through to it rather
 * than returning — so the record sits on a path every one of them crosses. Without
 * the handled set the very families this host reads best would be reported as
 * unclassified, once each, on every session.
 */
export const HANDLED_CODEX_NOTIFICATION_METHOD_SET: ReadonlySet<string> =
  new Set<string>(CODEX_HANDLED_NOTIFICATION_METHODS);
/** {@link CODEX_UNREAD_NOTIFICATION_METHODS} as a set, for the per-session record. */
export const UNREAD_CODEX_NOTIFICATION_METHOD_SET: ReadonlySet<string> =
  new Set<string>(CODEX_UNREAD_NOTIFICATION_METHODS);
/** {@link CODEX_OPTED_OUT_NOTIFICATION_METHODS} as a set — see the record's third branch. */
export const OPTED_OUT_CODEX_NOTIFICATION_METHOD_SET: ReadonlySet<string> =
  new Set<string>(CODEX_OPTED_OUT_NOTIFICATION_METHODS);

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Trim one field to something a transcript line can hold. */
function bounded(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * One operator sentence for `model/rerouted`.
 *
 * States the CONSEQUENCE first, because the symptom is the misleading half: a
 * user who is told only "the model was rerouted" has no reason to connect it to
 * the model name in their own picker, or to the bill.
 *
 * Read defensively — every field is optional at read time even though
 * `ModelReroutedNotification` declares all five as required, because a renamed
 * or absent field must degrade to a shorter sentence and never throw inside the
 * transport's notification dispatch.
 */
export function describeCodexModelReroute(params: unknown): string {
  const notification = (params ?? {}) as { fromModel?: unknown; toModel?: unknown; reason?: unknown };
  const from = bounded(text(notification.fromModel), 120);
  const to = bounded(text(notification.toModel), 120);
  const reason = bounded(text(notification.reason), 120);
  const models = from && to ? `${from} → ${to}` : to ? `→ ${to}` : from ? `away from ${from}` : 'the model was not named on the notification';
  return 'Codex REROUTED THIS TURN TO A DIFFERENT MODEL — the answer did not come from the model this '
    + `session is configured with. ${models}`
    + (reason ? ` (reason: ${reason})` : '');
}

/**
 * One operator sentence for `deprecationNotice` (`{ summary, details }`).
 *
 * Passed through rather than classified: unlike `configWarning`, this channel
 * carries no class this host can act on differently, and inventing categories
 * for it would be authoring a taxonomy upstream has not published.
 */
export function describeCodexDeprecationNotice(params: unknown): string {
  const notification = (params ?? {}) as { summary?: unknown; details?: unknown };
  const summary = bounded(text(notification.summary), 400);
  const details = bounded(text(notification.details), 500);
  const reported = [summary, details].filter(part => part.length > 0).join(' — ')
    || 'no summary or details on the notification';
  return `Codex DEPRECATION NOTICE — ${reported}`;
}
