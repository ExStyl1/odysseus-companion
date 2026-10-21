/**
 * RS-128 (UB6.17) — the Phase 6 core live case: the Laya-less decision-model card
 * reports "not configured" honestly, and every feature stays at today's behaviour.
 *
 * ## The row
 *
 * UB6.17 names one always-drivable case (the core unit's) — the Laya-backed
 * feature cases need a provider the owner may install (OQ-43.13 default (d): none
 * — so they stay unshipped rows' cases per the "One rule for Phase 6 feature
 * rows"). The id is lane-picked (next free after RS-127; the dispatch allocated
 * none), NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the
 * rs-121 rule), and the controller confirms it at the pin. The DRIVE is the
 * END-sitting wave's (the owner's sitting policy); this file is the recipe.
 *
 * ## What the case proves (UB6.1–UB6.5 at their shipped state)
 *
 * With the master switch OFF (its default) the app behaves exactly as without
 * the decision layer; turning it ON with no reachable provider yields an honest
 * "not configured" — the Settings test reports the failure, `resolveDecisionClient`
 * returns `{ ok: false }`, every caller gets null, and no decision record lies
 * about a call that never happened. Invariant: zero authority — nothing in the
 * app grants or refuses anything because the layer is off or failing.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-128'
const TITLE =
  'the Phase 6 core drive: the decisions card with no provider reports "not configured" honestly (test fails, status stays readable), the master switch is off by default, and every feature behaves as without the layer'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB6.17',
  runtimes: ['pi'],
  credentials:
    'none: the case runs with NO decision provider configured — no key, no Laya install (OQ-43.13 (d)). The Settings key field, if exercised, takes a fixture string that is never a real key and is deleted in the same sitting.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the build carries UB6.1a/6.1b (6ca4e5e43 / 9f68581fa or later) and, when the card half is pinned, UB6.5. The unit evidence this drive sits on: decisions suites 54 pass / 0 fail across 6 files (resolve negatives off / no-key / Bearer-only; records no-state arms; the decisionLayer envelope fixture).',
    '1. Launch the PACKAGED build by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, dark theme (owner rule).',
    '2. OFF-BY-DEFAULT: open Settings > AI. EXPECT: the Decision model card shows the master switch OFF with nothing enabled — no decision record file exists yet (`<config dir>/logs/decisions.jsonl` absent), and a chat turn on any runtime behaves exactly as before (no latency added, no card changed).',
    '3. ENABLE WITH NO PROVIDER: switch the master ON with the default TypeSafe preset and NO key stored. Run the card\'s Test button. EXPECT: an HONEST failure — the card reports the call failed because no API key is stored (the `unconfigured` failure kind, never a silent OK, never a fabricated probability), and the failure message names where the key goes (Settings > AI > Decision model). POSITIVE CONTROL: paste the fixture key `sk-fixture-not-a-real-key` and re-run the Test — EXPECT an auth-flavoured failure FROM THE PROVIDER (the request now reaches the wire and is rejected), which proves the test button drives the real path and the step-3 failure was the honest unconfigured one.',
    '4. RECORDS HONESTY: after steps 2–3 open `<config dir>/logs/decisions.jsonl`. EXPECT one line per Test press (`feature: "settings_test"`), each carrying ok:false with a failure kind and NO state text — only the sha256 and byte count of the canned state (and no API key anywhere in the file — grep it for the fixture string; the scrub must have redacted it from any provider detail).',
    '5. CALLERS FAIL CLOSED: with the layer still ON but unconfigured, run one normal chat turn. EXPECT: the turn behaves exactly as with the layer off — no wait at turn start beyond the ordinary, no badge or status move, and decisions.jsonl gains NO per-message lines (activation re-sends and hidden messages must run no per-message decision point, B1-08). Delete the fixture key in Settings (the card\'s key control) and switch the master OFF, restoring step 2\'s state.',
    '6. Verdict, for the checklist row the controller writes: PASS when the off default holds, the no-key test reports the honest unconfigured failure, the fixture-key control reaches the provider and reports its rejection, the record file carries failures only with digests and no state text, and a normal turn with the layer unconfigured is indistinguishable from the layer off.',
  ],
  expected:
    'The Decision model card ships OFF by default; with no provider the Test button reports the honest "not configured" failure (kind unconfigured, message naming the key control), a fixture key moves the failure to the provider (auth), decisions.jsonl records each failed Test with digests only and no state text or key material, and a chat turn with the layer unconfigured behaves exactly as without the layer (no per-message decision records, no behaviour change).',
  detector:
    'Product-written records only: the Settings card\'s own test result (the rendered failure, never a screenshot of prose), the `decisions.jsonl` lines read from disk (ok flag, failure kind, state digest fields present, state text absent), and the config dir listing (no decisions.jsonl while off). The unit suites (54 pass / 0 fail) are the offline arm of the same invariants.',
  positiveControl:
    'The fixture-key Test press: it must FAIL DIFFERENTLY (an auth/provider rejection rather than the unconfigured message), which proves the test path reaches the real wire — so step 3\'s failure is the product\'s honest not-configured answer, not a dead button. The file-absence check at step 2 is the control for step 4\'s file-presence.',
  runOnlyIf:
    'The packaged build carries the decisions core (6ca4e5e43+) and, for the card arms, the UB6.5 card (when pinned). Without the card in the build, steps 3–4 can still run through the RPC surface (`decisions:test`) — record which surface drove the arm.',
  doneMeans:
    'UB6.17\'s checklist row (the controller\'s) carries the verdict: off default confirmed, honest not-configured failure with the fixture-key control reaching the provider, records carry failures with digests only, and the unconfigured layer leaves a normal turn byte-equal to the layer off. The Laya-backed feature cases stay out: OQ-43.13 default (d) names no install source.',
  doNotConflate:
    'The fixture key `sk-fixture-not-a-real-key` proves the wire path, NOT that the provider works; its rejection is the expected outcome. "Not configured" is the unconfigured FAILURE KIND, not a timeout — a timeout reading means the Test reached some other endpoint, which is a finding, not a pass. And the master switch\'s off state is a USER SETTING (spec §3.4), not a feature gate: nothing in the build may hide the card.',
  safety:
    'No real credentials anywhere: the fixture key is typed into the user\'s own fresh config dir and deleted in step 5. No provider is installed (OQ-43.13 (d)); the only network is the two Test presses to the preset endpoint, sending the canned one-line state. No state text beyond that canned line is ever sent.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
