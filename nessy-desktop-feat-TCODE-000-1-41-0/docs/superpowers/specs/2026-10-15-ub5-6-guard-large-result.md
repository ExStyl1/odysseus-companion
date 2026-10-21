# UB5.6 result (PARTIAL — the frequency/latency reading is the END-sitting's) — the guardLargeResult counter/timer instrument is built, its control PASSED, and the decision rule for UB6.16 is written

Row: `UB5.6 `[pi]` `[claude]` `[measure]`` of `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`
(DEC-12; amended 2026-10-14 (B1-01): also record the share of summarised results carrying an `_intent`,
per runtime). Prepared 2026-10-15 by lane L-P57a. The instrument's control half was run headlessly; the
FREQUENCY and REAL-LATENCY reading needs a representative sitting of real turns on the `fast` alias —
the sitting ASK below.

## The decision rule, stated BEFORE the reading

**UB6.16 (the v0.15.1 relevance filter) is taken only if BOTH:**
1. **summaries exceed 2 % of tool calls** in the sitting (below that the filter is dead code carrying
   egress — the agent's stated purpose and up to 100k tokens in up to 8 question-calls per summarised
   result — for almost nothing); **AND**
2. **the median summarization latency exceeds 2 s** on the `fast` alias (at or under 2 s the summary is
   not a felt delay and a smarter excerpt buys nothing the user can perceive).

The thresholds are this row's stated rule (the row delegates "a stated share … AND a stated median
latency" to the measuring row); the controller may re-state them before the sitting — but not after
seeing its numbers. The result decides UB6.16 only.

## Premise read (at HEAD)

- The guard: `packages/shared/src/utils/large-response.ts:631` (`guardLargeResult`) → binary/secret-scan/
  structured-JSON/base64 branches → the ONE predicate `exceedsResultSizeLimit` (:748) →
  `handleLargeResponse` (:778): save to `long_responses/`, then **the one summarize seam**
  (:811-823: `if (summarize && estimatedTokens <= MAX_SUMMARIZATION_INPUT)` → `buildSummarizationPrompt`
  → `summarize(prompt)`) — "Callers orchestrate via their agent's runMiniCompletion()" (:7).
- Thresholds: `TOKEN_LIMIT = 12000` (≈48 KB, :43), `MAX_SUMMARIZATION_INPUT = 100000` tokens (:46, beyond
  it save+preview only), model-aware scaling `tokenLimitFor` (:142), the MCP 25k limit via `tokenLimit`
  (:648-652), declared per-tool allowances (:654-663).
- `_intent` is ALREADY threaded to the seam: `opts.intent` (:637) → `context.intent` (:758) →
  `buildSummarizationPrompt` — the B1-01 share is recordable at the seam without new plumbing.
- Five call sites (`git grep guardLargeResult(`): Pi `pi-agent-server/src/local-tools/tool-wrapper.ts:114`,
  Claude `claude-agent.ts:11648` (the `tool_result` interception), `agent/local-tools/runtime.ts:695`,
  `mcp/mcp-pool.ts:4236`, `sources/api-tools.ts:229`. NO counter exists (`setLargeResultSummaryGate`
  and any metrics: 0 hits — and that gate is gone upstream too at v0.14.1, per UB6.16's amendment).

## The instrument, built and proven

- **The sitting scratch patch** (`work/l-p57a/ub5-6/metrics-scratch.patch`, 35 lines, NEVER committed):
  one env-gated wrap (`NESSY_LARGE_RESULT_METRICS=<runtime-label>`) around the summarize seam emitting a
  JSONL line per attempt — `{label, toolName, chars, estimatedTokens, summarized, hadIntent, latencyMs,
  at}` — to `NESSY_LARGE_RESULT_METRICS_DIR/ub5-6-large-result-metrics.jsonl`. Proven in sequence:
  `git apply --check` clean; applied + smoke (`NESSY_LARGE_RESULT_METRICS=claude`, planted 64,400-char
  result) emitted exactly `{"label":"claude","toolName":"Read","chars":64400,"estimatedTokens":16100,
  "summarized":true,"hadIntent":true,"latencyMs":123,…}`; reverted, tree clean. The sitting applies it
  per runtime (label `pi` in the subprocess, `claude` in the host) and reverts after.
- **Control harness** (`work/l-p57a/ub5-6/metrics-harness.ts`, headless against the HEAD module; the
  summarize callback stands in for `runMiniCompletion` on the fast alias with a 250 ms latency):
  - **A. the row's control (can fail): PASSED** — one planted oversized tool result (64,400 chars,
    ~16,100 estimated tokens) was counted ONCE with latency 253 ms > 0 and `wasSummarized` true.
  - B. zero arm: a small result → no metrics line, `guardLargeResult` returned null. PASSED.
  - C. boundary: an over-`MAX_SUMMARIZATION_INPUT` result (~226,100 estimated tokens) → saved + preview,
    NOT summarized, NOT counted (the counter does not mistake a preview for a summary). PASSED.
  - D. intent shape (B1-01): the same oversized result with `opts.intent` set → the line carries
    `hadIntent: true`. PASSED.
  - A first smoke with a too-small plant (32,200 chars ≈ 8,050 tokens — under `TOKEN_LIMIT`) correctly did
    NOT summarize, which is also a passive confirmation of the predicate's threshold.

## The sitting ASK

1. Apply `metrics-scratch.patch` (it applies clean at HEAD); set
   `NESSY_LARGE_RESULT_METRICS=pi` in the Pi subprocess and `=claude` in the host;
   run the sitting's representative case list ON THE `fast` ALIAS and NAME the case list in this file's
   closing update (the row requires the list named with the reading).
2. Read the JSONL: summaries per tool call (the denominator is every `guardLargeResult` call — the patch
   as written counts only summarize ATTEMPTS; a second line at the :748 predicate exit, guarded by the
   same env, records the calls — add it at the sitting if the exact share is wanted, or take the attempt
   count as the numerator and the sitting's tool-call total as the denominator), median `latencyMs` for
   `summarized: true`, and the `hadIntent` share per runtime.
3. Close on the decision rule above → UB6.16 `taken` or `not taken (UB5.6)`.

## Residues

- The control's latency is the stand-in's (250 ms), not the gateway's — the real median is the sitting's.
- The fast-alias egress for the sitting's summaries is the product's own normal behaviour (summaries run
  on the session's own connection); the loopback stub was used only in the harness, not needed there.
- The counter wraps `handleLargeResponse`'s seam — the subagent-output spill
  (`orchestrator/subagent-tool.ts` calling `saveLargeResponse` directly, per the :706-708 note) bypasses
  it by design and is out of the metric's population.
