# UB4.4 measurement — web_search/web_fetch schemas through pi-ai's TypeBox (typebox coercion)

Date: 2026-10-15. Lane L-P4a. Row: UB4.4 `[pi]` `[measure]` (1.43.0 plan, H26; RT
amendment: instrument runs on HEAD's Pi 0.87.1, re-run on 1.1.0 is UB8.2's).

## Instrument

`work/l-p4a/ub4-4-driver.ts` (git-excluded workspace; shape below). It imports the
SHIPPED tool factories — `createSearchTool` (`tools/search/create-search-tool.ts`) and
`createWebFetchTool` (`tools/web-fetch.ts`) — and drives them through the Pi SDK's own
argument validation, `validateToolArguments` (exported from `@earendil-works/pi-ai`,
implemented in `pi-ai/dist/utils/validation.js`: `normalizeOptionalNulls` →
`Value.Convert` → a hand-rolled `coerceWithJsonSchema` ONLY when the schema lacks the
registered `TypeBox.Kind` symbol → `Compile` + `Check`).

- Pi at HEAD: `@earendil-works/pi-ai` 0.87.1, `@earendil-works/pi-coding-agent` 0.87.1
  (the RT amendment's UA12.211 version — confirmed from `node_modules`).
- Schema builders present: `@sinclair/typebox` 0.34.49 (what our two web tools imported)
  and `typebox` 1.3.27 (what pi-ai's validator and its `Type` re-export use).

Note on the row's wording: `web_fetch`'s schema has NO numeric field (only `url` and
`prompt`, both strings); the numeric field of the pair is `web_search`'s `count`
(`Type.Number`, 1–10). The '5' arms therefore drive `web_search`'s shipped schema;
`web_fetch` is driven with its real shape as the named file's arm.

## Readings (bun work/l-p4a/ub4-4-driver.ts, BEFORE the port)

| Arm | Schema builder | Arguments | Verdict |
| --- | --- | --- | --- |
| A | shipped (`@sinclair/typebox` 0.34.49) | `count: '5'` | **REFUSED** — `count: must be number` |
| B (CONTROL) | shipped | `count: 5` | VALIDATED |
| C | shipped | `count: 'five'` | REFUSED (as the control requires) |
| D | shipped | `count` omitted | VALIDATED |
| E | shipped (`web_fetch`) | `{url, prompt}` strings | VALIDATED |

The control's reading: VALIDATED, so the instrument works and the refusal in arm A is
the schema/validation behaviour, not a broken driver.

Mechanism (measured, not inferred): our `@sinclair/typebox`-built schemas carry the
registered `TypeBox.Kind` symbol, so the validator skips its hand-rolled coercion and
trusts `Value.Convert` — which comes from pi-ai's `typebox` 1.3.27 and does NOT coerce a
0.34.49-built schema. Counterfactual arms F–H: the SAME object shape built with pi-ai's
`Type` (1.3.27, carries no `TypeBox.Kind` symbol) — `'5'` is COERCED to 5 and VALIDATES,
`'five'` is still refused, the numeric control validates. The mixed-builder skew is the
whole story.

## Decision

The decision rule: take upstream's TypeBox import only if `'5'` is refused today.
`'5'` IS refused today (arm A). **Decision: take upstream's import** — both web tools'
schemas now build with `Type` re-exported from `@earendil-works/pi-ai`, exactly as
upstream v0.15.1 ships them. Ported in the same commit as this file.

## Readings AFTER the port (same driver, shipped tools)

| Arm | Schema builder | Arguments | Verdict |
| --- | --- | --- | --- |
| A | shipped (`typebox` 1.3.27 via pi-ai) | `count: '5'` | **VALIDATED** — coerced to `5` |
| B (CONTROL) | shipped | `count: 5` | VALIDATED |
| C | shipped | `count: 'five'` | REFUSED (still refused — the guard the control pins holds) |
| D | shipped | `count` omitted | VALIDATED |
| E | shipped (`web_fetch`) | `{url, prompt}` strings | VALIDATED |

The shipped schemas now carry no `TypeBox.Kind` symbol, so the validator's own coercion
applies: numeric strings convert, non-numeric strings refuse, numbers pass through.

## Follow-ups

- UB8.2 re-runs this instrument on Pi 1.1.0 when the mirror serves it (RT amendment).
- The other `@sinclair/typebox` uses in `packages/pi-agent-server/src/tools/` are none —
  the two web tools were the only importers, so the skew cannot recur on this package's
  tool surface.
- Contract pins after the port: `check:surface -- --live-json-schema` → 71/71 match;
  `live-manifest-contract.test.ts` (the model-contract projection) green. The ONE red
  block in `check:surface`'s default run (mcp.dynamic, digest 5ba219… vs stored e47e6bf…)
  names `shared/src/mcp/mcp-pool.ts` — a sibling lane's uncommitted edit this row never
  touches; re-read from a quiet tree before re-pinning anything.
