# UB5.2 result — `/compact` on a too-small conversation compacts anyway (manual boundary); no success-without-boundary exists on 2.1.280

Row: `UB5.2 `[claude]` `[measure]`` of `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`
(H5; closes the F1.879 pointer from the 1.41.0 plan). Measured 2026-10-15. Lane L-P57a.

## Question (row verbatim)

"On 2.1.274, `/compact` on a too-small conversation: does it answer `result(success)` with no manual
boundary, leaving an Accept & Compact plan pending? … Decision rule: success with no boundary → port
upstream's correlation (v0.13.4 `claude-compaction-events.test.ts`); a boundary or an error → treat it like
F1.856 (nothing to compact) and record."

## Versions and provenance

- Both self-reports recorded 2026-10-15: `grep -o '"claudeCodeVersion"[^,]*'
  node_modules/@anthropic-ai/claude-agent-sdk/package.json` → `"claudeCodeVersion": "2.1.280"`;
  `claude-agent-sdk-darwin-arm64/claude --version` → `2.1.280 (Claude Code)`. The row's "2.1.274" is stale
  at HEAD (same drift the RT pass amended onto UB5.1); the measurement is on the shipped 2.1.280.
- Harness: `work/l-p57a/ub5-2/drive.ts` + `drive-c.ts` (scratch, under the excluded `/work/`). The vendored
  SDK ran in-process against a loopback Anthropic stub (no egress; the only probes were two `HEAD /api/hello`,
  answered 404). Scratch `CLAUDE_CONFIG_DIR`/`NESSY_CONFIG_DIR` via `mkdtemp`; allowlisted child env; no real
  credentials. Our events were produced by OUR `ClaudeEventAdapter` from the same `git archive HEAD` snapshot
  UB5.1 used (`f6026e90e`), fed the raw stream message by message — the "our event-adapter" view the row's
  instrument names, stronger than the debug log (the same messages the adapter would consume).
- The compact turn is OUR product's exact shape: a bare resumed `query({ prompt: '/compact' })`
  (`packages/shared/src/agent/claude-agent.ts:7037`, the `drainPendingModelCompaction` comment; user-typed
  `/compact` rides the same `SDK_SLASH_COMMANDS` branch).

## What our pipeline does today (premise read, at HEAD)

- `compact_boundary` → `info 'Compacted Conversation'` + `compactionTrigger` from `compact_metadata.trigger`
  (`event-adapter.ts:1779-1783`, `compactBoundaryTrigger` at 2942).
- `status.compact_result === 'failed'` → `info 'Compaction failed: …'` warning; `'success'` is deliberately
  silent (`event-adapter.ts:2258-2271`).
- Host: an info starting with "Compacted" and a non-auto trigger marks the Accept & Compact plan ready
  (`SessionManager.ts:37321-37352`, `markStoredCompactionComplete`); a `Compaction failed` warning (or an
  error/typed_error) clears a still-awaiting plan (F1.881, `SessionManager.ts:41673-41677`).
- We have NO `expectManualCompaction` terminal-result correlation — upstream's defence against a bare
  `result(success)` is absent, which is exactly what this row measured the need of.

## Upstream

- `v0.13.4:packages/shared/src/agent/__tests__/claude-compaction-events.test.ts`, byte-identical at v0.15.1
  (`git diff v0.13.4 v0.15.1 -- <path>` empty): with `expectManualCompaction()`, a terminal `result(success)`
  is correlated — boundary seen → `info 'Compacted Conversation', compactionTrigger:'manual'` AT THE TERMINAL;
  `compact_result: 'success'` WITHOUT a boundary → `compaction_failed` ("does not mistake compact_result
  success without a boundary for successful compaction"); an auto boundary does not satisfy a manual request.
- Their event-adapter states the reason (v0.15.1 `event-adapter.ts:569-570`, verbatim): "The installed CLI
  returns result(success, is_error:false) even for too-small/API-failed /compact commands. Only a correlated
  boundary proves success."

## Readings (2026-10-15, SDK 2.1.280 / CLI 2.1.280)

- **Scenario A — `/compact` on a TOO-SMALL conversation (one 12-token exchange):** the CLI did NOT refuse and
  did NOT answer a bare success. Stream: `status(compacting)` → `status(compact_result:'success')` → `init` →
  **`compact_boundary {trigger:'manual', pre_tokens:14, post_tokens:744}`** → `result(success, is_error:false)`.
  Our adapter emitted `Compacting conversation…` → **`info 'Compacted Conversation', compactionTrigger:'manual'`**
  → `complete`. The plan-ready path fires through the ordinary arm.
- **Scenario B — control (can fail): `/compact` on a compactable conversation** (three exchanges, ~308k
  reported input tokens): the compact turn made three model calls (the third is the summarizer: "CRITICAL:
  Respond with TEXT ONLY…") and emitted **`compact_boundary {trigger:'manual', pre_tokens:307796,
  post_tokens:71603, cumulative_dropped_tokens:236193}`**. The boundary is shown; the instrument sees
  boundaries. **Control PASSED.**
- **Scenario C — sharpening (upstream's correlation also covers "API-failed"): `/compact` with the model API
  failing (stub 500) during the compact turn:** repeated `status(compacting)` (the CLI retried), then
  **`status(compact_result:'failed', compact_error:'Error during compaction: API Error: 500 …')`** →
  `result(success, is_error:false)` whose `result` TEXT carries the error sentence. Our adapter emitted the
  **`info 'Compaction failed: …'` warning** → `complete`, which F1.881's host arm consumes to clear a
  still-awaiting plan. No bare success-without-boundary here either — but note the CLI's terminal result on
  this arm is `subtype:'success', is_error:false` with the error in the text: upstream's "returns
  result(success) even for API-failed /compact" is confirmed VERBATIM at 2.1.280; what changed is that the
  CLI now ALWAYS pairs it with an explicit `compact_boundary` (healthy path) or `compact_result:'failed'`
  (failure path).

## Decision (per the row's rule, written before the reading)

**The too-small case shows a boundary; the API-failed case shows `compact_result:'failed'`. Both arms of the
rule's "a boundary or an error" are measured → treat it like F1.856 and record: the upstream correlation port
is NOT taken.** Our existing pipeline handles every observed shape: manual boundary → plan made ready
(`SessionManager.ts:37349`); failed → plan cleared (F1.881, `SessionManager.ts:41677`). Upstream's correlation
defended against an older CLI that answered a bare `result(success)`; our shipped 2.1.280 no longer does.
H5's dead end (an Accept & Compact plan pending forever) does not exist on the shipped pair. If a future SDK
lift (UB8.1 re-reads 0.3.296) regresses the CLI to bare successes, the signal to watch is a `/compact` turn
ending `result(success)` with neither `compact_boundary` nor `compact_result` — at which point upstream's
correlation (above) is the port, onto our `info 'Compaction failed…'` shape so F1.881's host arm consumes it.

## Residues

- **Endpoint:** the row names `claude-gateway`; the reading is on the vendored CLI's own stream vocabulary
  against a loopback Anthropic-wire endpoint. The measured facts (which `system` subtypes a `/compact` turn
  emits) are CLI-level and endpoint-independent; the gateway's translated route changes the model traffic,
  not the stream. The real-gateway drive belongs to the packaged sitting wave (owner policy) if a re-verify
  is wanted; the decision above does not hinge on it.
- The retry storm on the failed arm (six `status(compacting)` events) renders six "Compacting…" status lines
  in our UI today — cosmetic, pre-existing, not this row's scope; recorded here because the instrument saw it.
