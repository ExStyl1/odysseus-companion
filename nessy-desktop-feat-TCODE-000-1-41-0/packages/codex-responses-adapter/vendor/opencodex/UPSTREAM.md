# opencodex vendored source

- Upstream repo: `github.com/lidge-jun/opencodex`
- Package/version: `@bitkyc08/opencodex` v2.7.17
- Commit: `16bef043bb58a4a480e0a146370ec666a5d02eae` (short `16bef04`)
- License: MIT; preserved verbatim in `LICENSE`
- Captured: 2026-08-04

Unlike the `pi-subagents` controlled reference, this record covers **copied
executable source**: the Anthropic Messages <-> `/v1/responses` translation pair
that the local Codex Responses adapter serves on its `/v1/messages` route. The
MIT notice is reproduced in `LICENSE` and each copied file carries the upstream
copyright line in its header.

## What was vendored

| Upstream | Here |
| --- | --- |
| `src/claude/inbound.ts` | `../../src/anthropic/inbound.ts` |
| `src/claude/outbound.ts` | `../../src/anthropic/outbound.ts` |
| `tests/claude-inbound.test.ts` | `../../src/__tests__/anthropic-inbound.test.ts` (slice) |
| `tests/claude-outbound.test.ts` | `../../src/__tests__/anthropic-outbound.test.ts` (slice) |

The test files are **slices, not copies**: assertions covering behaviour stripped
from `inbound.ts` were dropped, the remaining ones were re-pointed at the
stripped contract, and a parallel-tool-call case was added on the outbound side.

## What was locally changed

**`inbound.ts` (T1 strip).** opencodex-specific config and routing removed: the
`OcxClaudeCodeConfig` (`cc?`) parameter with its alias / desktop-3p /
context-window imports, `resolveInboundModel` (the model now passes through
verbatim), `extractOcxRouteDirective`, `DEFAULT_BLOCKED_SKILLS`, and the
ChatGPT-oriented `prompt_cache_key` synthesis with its `cacheKeySource`
provenance. Everything else is byte-faithful, including the bundled-skill
elision helpers, which stay wired but start from an empty blocklist so a
Nessy-side config can re-enable them later. `ClaudeInboundTranslation` is
narrowed to `{ body }`.

**`outbound.ts` (T3 reader plumbing).** Four hunks against upstream, all inside
`responsesSseToAnthropicSse`:

1. the added provenance header (docs-level);
2. `let reader` re-typed from the global `ReadableStreamDefaultReader<Uint8Array>`
   to `ReturnType<ReadableStream<Uint8Array>['getReader']>`, because under this
   repo's `lib: ["ESNext"] + types: ["bun"]` the global reader interface is not
   the one `ReadableStream.getReader()` returns (type-level);
3. `const streamReader = upstream.getReader(); reader = streamReader;` in place
   of `reader = upstream.getReader()`, with the read loop calling
   `streamReader.read()` (value-level);
4. `streamReader.releaseLock()` in place of `reader.releaseLock()` in the
   `finally` block (value-level).

Hunks 3 and 4 exist because TypeScript discards the narrowing of a captured
`let` inside a function expression, so the loop read as possibly-undefined.

## Re-sync warning

`outbound.ts` differs from upstream in 4 hunks; two are VALUE-LEVEL (const alias
split around the reader assignment, verified behavior-preserving via
single-assignment aliasing) — do NOT re-sync assuming type-erasure-only
differences.

Concretely: `streamReader` is assigned exactly once, `reader` is assigned only
from it and is never reassigned afterwards, so both names denote the same reader
for the lifetime of the stream and `cancel()` (which still goes through `reader`)
observes the same object. That equivalence is the reason the change is safe, and
it is also the thing a careless re-sync would silently break — pulling a newer
upstream `outbound.ts` over this file must re-apply hunks 2-4 by hand and
re-check that no new code path reassigns `reader`.

Also re-read the stripped list above before re-syncing `inbound.ts`: a newer
upstream may reintroduce `cc?`-gated behaviour into functions that are otherwise
byte-faithful here, and the contract tests in `../../src/__tests__/` pin the
stripped surface, not the upstream one.

Plan of record:
`docs/superpowers/plans/2026-08-04-claude-sdk-runtime-on-nessy-integrations.md`
(tasks T1, T3).
