# UB5.3 result — pi-ai honours `retry-after` under the provider block; with the block absent (HEAD) the 429 reaches the agent ladder and the header is ignored

Row: `UB5.3 `[pi]` `[measure]`` of `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`
(H7). Measured 2026-10-15. Lane L-P57a.

## Question (row verbatim)

"Does pi-ai honour the gateway's `retry-after` under `{maxRetries:2, maxRetryDelayMs:60000}` stacked under
our 15 s × 5 ladder? Instrument: a loopback stub that answers 429 with `retry-after: 7` twice, then 200,
driven through the Pi subprocess with the settings block, timestamps of each request recorded. Control
(can fail): the same stub without `retry-after` must show pi-ai's own backoff, and with the block absent
the first 429 must reach our ladder. Decide for BYO and gateway separately; the gateway default stays as is
unless measured better."

## Versions and provenance

- Pi runtime self-report: `@earendil-works/pi-coding-agent` `0.87.1` (= `SUPPORTED_PI_RUNTIME_VERSION`,
  `packages/pi-agent-server/src/compat/pi-runtime-adapter.ts:122`; package.json `0.87.1`); pi-ai
  `@earendil-works/pi-ai` `0.87.1`. Claude SDK self-reports for context: `0.3.280`/`2.1.280` (unchanged
  from UB5.1's recording an hour earlier).
- Harness: `work/l-p57a/ub5-3/drive.ts` (+ `drive-d.ts`, `drive-c.ts`, `drive-e.ts` isolations), scratch
  dirs only, loopback stub (no egress, fixture keys). The vendored runtime ran IN-PROCESS for arms A/B/D/E
  (the same code the subprocess runs — `SettingsManager` → `core/sdk.js buildRequestOptions` → pi-ai
  `retryProviderRequest`; the subprocess boundary adds only RPC serialization) and through the REAL
  SUBPROCESS (`packages/pi-agent-server/src/index.ts` over its stdio RPC, the
  `context-usage-real-server.test.ts` pattern) for arm C.

## The static read (premise, at HEAD)

- Our ladder: `GATEWAY_RETRY_SETTINGS` 5 × 15 s on the gateway, `PI_DEFAULT_RETRY_SETTINGS` 3 × 2 s off it,
  utility 2 × 15 s / 2 × 2 s (`packages/pi-agent-server/src/gateway-retry-settings.ts:19,26,129,132`),
  applied by `applyRetryPolicy` → `settingsManager.applyOverrides({ retry: { maxRetries, baseDelayMs } })`
  (`gateway-retry-settings.ts:98-106`; call sites `index.ts:1010/2642/3156/3852`). NO `provider` key is
  ever set — `git grep maxRetryDelayMs` over our tree: **0 hits**.
- pi-ai `0.87.1` has the provider-level pre-stream retry: `utils/provider-retry.js:75-93`
  (`retryProviderRequest`) — `options.maxRetries ?? 0` (default OFF), honours `retry-after-ms` then
  `retry-after` (seconds or HTTP-date) validated against `maxRetryDelayMs` (default cap 60 s; a longer
  server delay THROWS "Server requested Xs retry delay (max: Ys)" rather than sleeping past it,
  `provider-retry.js:22-28`), own backoff otherwise: `min(0.5·2^retryIndex, 8) s` with −0…25 % jitter
  (`provider-retry.js:42-43`). Wired per request by the adapters (`api/openai-completions.js:197` — the
  wire the Nestor gateway and BYO OpenAI-compatible connections speak) from the session's
  `getProviderRetrySettings()` (`core/settings-manager.js:634-639`, `retry.provider.{maxRetries,
  maxRetryDelayMs}`) via `buildRequestOptions` (`core/sdk.js:178-193`).
- Agent-level ladder: `AgentSession._prepareRetry` (`core/agent-session.js:2684-2714`) with
  `isRetryableAssistantError` (`pi-ai utils/retry.js:175-181`, patterns at :4-35 — "rate.?limit"/"429"
  retryable; quota/billing non-retryable), fed by `getRetrySettings()`.
- Upstream v0.15.1 ships exactly the row's block:
  `v0.15.1:packages/pi-agent-server/src/session-settings.ts` — `CRAFT_PI_RETRY_SETTINGS.provider =
  {maxRetries: 2, maxRetryDelayMs: 60_000}` (main) and `{2, 10_000}` (ephemeral), with the comment
  "Provider-level (`retryProviderRequest` in pi-ai): pre-stream retries for 408/409/429/5xx honoring
  `retry-after` up to `maxRetryDelayMs`, mirroring the OpenAI/Anthropic SDK default of 2. (Pi SDK
  default: 0.)" The file is in our plan's Session-tools-free zone (no overlap); history v0.13.5→v0.15.1
  shows it predates the delta (3 commits, none after v0.15.0).

## Readings (2026-10-15; stub: 429 twice then 200; every request timestamped)

- **Arm A — the question (block ACTIVE, `retry-after: 7`):** 3 requests, gaps **[7003, 7006] ms**, wall
  14.1 s. pi-ai honoured the header at the PROVIDER level, twice, inside ONE agent attempt — the stacked
  agent ladder (5 × 15 s) never fired. **The block works as upstream's comment claims.**
- **Arm B — control (can fail): block ACTIVE, NO `retry-after`:** gaps **[474, 888] ms** — pi-ai's own
  provider backoff (0.5 s / 1 s, jittered), still provider-level. **Control PASSED** (the instrument
  distinguishes header-directed sleeps from own backoff).
- **Arm D — control (can fail): block ABSENT (HEAD wiring), `retry-after: 7` present, in-process:** 3
  requests, gaps **[2025, 4009] ms**, `auto_retry_start(attempt 1, delayMs 2000)` / `(attempt 2, 4000)` in
  the session events. The 429 reached the AGENT ladder (the off-gateway profile 3 × 2 s; the gateway's
  5 × 15 s numbers are the same code path pinned by `gateway-retry-settings.test.ts`), and the header was
  IGNORED — the ladder's exponential backoff does not read `retry-after`. **Control PASSED.**
- **Arm C — through the REAL subprocess (block ABSENT):** anomaly, recorded honestly: the turn ended after
  ONE 429 — the assistant error message was correct (`stopReason:'error'`, `"429: {…rate limit…}"`), the
  session emitted `agent_end {willRetry: true}` (its own `_willRetryAfterAgentEnd` classified retryable,
  and `getRetrySettings()` verified green in isolation: `{enabled:true, maxRetries:3, baseDelayMs:2000}`),
  but no second attempt ran (no `auto_retry_start`, the prompt resolved). Ruled out in isolation:
  the classifier (unit-tested true on the exact message), the settings merge, `streamingBehavior:
  'followUp'` and `steeringMode: 'all'` (arm E: retries fine with both, gaps [2012, 4012] ms). NOT
  resolved within this row: something in the subprocess's reduced harness (minimal init, no extensions)
  or in its prompt belt stopped the loop after `willRetry: true`. Production evidence (the renderer's
  retry field, P6.916) says auto-retries DO surface in the real app, so this is recorded as an instrument
  anomaly, not a defect verdict — a packaged-sitting drive is the honest confirmation path.

## Decision (per the row's rule)

- **The mechanism is measured: pi-ai honours `retry-after` under the block (A), shows its own backoff
  without it (B), and with the block absent — our shipped wiring — the 429 reaches the agent ladder and
  the header is discarded (D).**
- **Gateway:** the default stays as is UNLESS measured better — the measurement says the block IS better
  for the gateway: a limiter 429 with `retry-after: 7` costs two header-directed 7 s provider-level sleeps
  (~14 s) instead of re-rolling whole assistant turns on the 15 s × 5 ladder (15 s to the first re-roll,
  each re-roll replaying tool state). Upstream ships the block as its default; our standing rule is
  upstream parity unless measured worse — it measured better.
- **BYO:** same verdict, same block (the block is endpoint-agnostic in our wiring: `applyRetryPolicy`
  would carry it for every Pi session; BYO endpoints that send no `retry-after` keep pi-ai's own ≤8 s
  provider backoff before the ladder).
- **This is a take decision, not this row's:** UB5.3 closes as a recorded result and spawns
  **`UB2.14`** (born ⬜, S, not CRITICAL): port upstream's provider block onto our
  `resolveRetrySettings` profiles (gateway and non-gateway, main and utility), with its tests. The
  gateway ladder numbers themselves stay as measured (P6.273) — the block is stacked ON them, the same
  shape the row's question asked about.

## Residues

- The `retry-after` payload is the stub's; whether the Nestor limiter always sends the header on 429 was
  not driven live (no credentials in the lane — the same endpoint residue as UB5.2). If the gateway omits
  the header, the block degrades to pi-ai's own ≤8 s backoff — still cheaper than a 15 s re-roll.
- The arm C subprocess anomaly (above) — one packaged-sitting drive would settle it; not this row's
  decision input.
- Header values above the cap (e.g. `retry-after: 120`) fail the request immediately
  (`provider-retry.js:24-25`) → the agent ladder takes over. Bounded, by design.
