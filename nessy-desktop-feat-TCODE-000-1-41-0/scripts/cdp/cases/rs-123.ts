/**
 * RS-123 (UB3.8 arm B) — a source test with a removed credential reads
 * FAILING, not reachable. Drives UB3.2 (R14-17).
 *
 * ## The row
 *
 * UB3.8 names two Phase 3 live cases; this file is the second. UB3.2's fix —
 * `source_test` refreshing, or failing with "Stored credential missing or
 * expired" and showing the API error body on 400/401/403 — is not landed as of
 * the premise reading below, so this case is a recipe: it scores the FIX on
 * the sitting build, exactly as its sibling RS-122 does for UB3.4.
 *
 * ## The premise, read at HEAD `64b944e8a` (2026-10-15)
 *
 * - `source-test.ts:492-498`: a source marked authenticated goes through
 *   `testApiConnectionWithAuth`; when it returns `attempted: false` the handler
 *   FALLS THROUGH to the unauthenticated `testApiConnectionBasic` — the
 *   comment names the fall-through itself.
 * - `source-test.ts:528-535`: the API-source arm takes one `getToken` and, on
 *   a null (the credential store has no entry), returns `attempted: false` —
 *   no refresh is attempted on this path (the refresh that exists at :1006
 *   serves the OAuth-token arm, a different class).
 * - `source-test.ts:716-725`: the unauthenticated probe reads a 401 with
 *   `success = true` — "Auth required - endpoint is reachable but needs
 *   credentials". So at HEAD a REMOVED credential reads REACHABLE: the defect
 *   R14-17 names, measured in the code that produces it.
 *
 * ## Why a recipe and not a drive
 *
 * The drive needs UB3.2 landed (it scores the fix), a source bound in a real
 * workspace, a credential physically removed, and the sitting lane; `run.ts`'s
 * `SITTING` needs the checklist row a lane must not write (the rs-121 rule).
 * The id is lane-picked (next free after RS-121; the dispatch allocated none)
 * and the controller confirms it at the pin.
 *
 * ## The instrument
 *
 * `scripts/cdp/fixtures/source-test-endpoint.ts` — the credential-aware
 * loopback REST endpoint stub-upstream deliberately is not: it ANSWERS 200
 * with a catalog body only to the fixture bearer and 401 with a JSON error
 * body to everything else, and logs each request's auth SHAPE (presence and
 * length, never a value). Both 401 arms of the row need a real refusing
 * endpoint: the fall-through arm needs a 401 for the unauthenticated probe to
 * misread as "reachable", and the error-body arm needs a real body to show.
 * Its own test (`source-test-endpoint.test.ts`) pins the 200/401 pair, the
 * stale-credential refusal and the body shape before any runtime points at it.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-123'
const TITLE =
  'a source test with a removed credential reads failing with the credential sentence, never the unauthenticated reachable verdict'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB3.8',
  runtimes: ['pi'],
  credentials:
    'owner: none. The source\'s credential is the PUBLIC fixture key of '
    + '`scripts/cdp/fixtures/source-test-endpoint.ts` (FIXTURE_KEY), entered through the product\'s own credential '
    + 'card into the rig\'s fresh NESSY_CONFIG_DIR; removal is a byte-swap of that disposable dir\'s encrypted '
    + 'credentials file, moved as opaque bytes — never decrypted, never a real credential in any arm.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Land-check first: UB3.2 must be in the build (git log names it; bundles rebuilt after the lane lands, then relaunch — scripts/cdp/README.md\'s stale-bundle rule). Driving on a build without UB3.2 measures the defect; record that reading as the BEFORE, never as the row.',
    '2. Start the instrument: `bun run scripts/cdp/fixtures/source-test-endpoint.ts --port 9341 --log <rig>/endpoint-log.jsonl` (read its line for the URL). Rig check OUTSIDE the app: `curl -s -o /dev/null -w "%{http_code}" <url>/v1/models` must print 401, and the same with `-H "Authorization: Bearer <FIXTURE_KEY>"` must print 200 — the endpoint can both refuse and answer, or no verdict below means anything.',
    '3. Launch the PACKAGED build by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, dark theme — and create the API source through the product: write `<workspace>/sources/<slug>/config.json` in the product\'s own format (storage.ts loadSourceConfig reads it; auth bearer, baseUrl = the endpoint URL, the endpoint as test path), then drive one session turn whose agent runs `source_test` for it — the tool raises the credential card; answer it with the FIXTURE key. Positive control: source_test now reads success from the authenticated 200 (the rig sees a passing source), and the endpoint log\'s record shows the bearer present.',
    '4. SNAPSHOT the rig\'s `<NESSY_CONFIG_DIR>/credentials.enc` (opaque bytes — the rig never decrypts it), then REMOVE the credential: quit the app, restore the snapshot OVER the current file (the credential entered in step 3 is gone; the source config still reads authenticated), relaunch.',
    '5. THE ARM: run `source_test` for the same source again. EXPECTED on a build carrying UB3.2: FAILING, with the stored-credential sentence ("Stored credential missing or expired"), and NO "reachable" verdict. At HEAD this arm reads `⚠ API returned 401 (authentication required)` with success TRUE — the recorded BEFORE (source-test.ts:716-725).',
    '6. THE STALE ARM (the error-body half): repeat steps 3–4 but enter a WRONG fixture value ("rs123-stale") in step 3\'s card, keep the credential in place, and run source_test. EXPECTED after UB3.2: failing, and the endpoint\'s REAL 401 JSON body is shown (the tool output carries the body text the fixture pins). At HEAD: `✗ API returned 401 (credentials invalid or expired)` with the generic re-authenticate line and NO body (source-test.ts:643-644) — the BEFORE.',
    '7. Verdict: UB3.8 arm B PASSES when step 5 reads failing with the credential sentence and the fall-through probe is gone, AND step 6 shows the provider\'s error body — every reading taken from source_test\'s own tool output and the endpoint log, never from the transcript\'s prose about it.',
  ],
  expected:
    'On the packaged build carrying UB3.2: a source whose credential was removed reads FAILING with the stored-'
    + 'credential sentence (no unauthenticated fall-through, no success on 401), and a source holding a stale '
    + 'credential reads failing with the endpoint\'s real 401 body shown.',
  detector:
    'source_test\'s own tool output (the verdict lines are the tool\'s contract) plus the endpoint fixture\'s own '
    + 'JSONL log, which records each request\'s auth shape: after UB3.2 a removed-credential arm makes NO '
    + 'unauthenticated request at all, and the stale arm\'s single request carries the stale bearer\'s shape.',
  positiveControl:
    'Step 3: the same source with its credential present reads success from the authenticated 200, and the curl '
    + 'pair in step 2 proves the endpoint can refuse and answer on the same port. Without both, "failing" in steps '
    + '5–6 is the rig refusing everything, not the product reporting a credential.',
  runOnlyIf:
    'UB3.2 is landed in the build under test (its commit in git log AND the bundles rebuilt after it — the '
    + 'README\'s stale-bundle rule). On a build without it the expected readings are the recorded BEFOREs: the '
    + 'removed-credential arm reads 401 with success true, the stale arm prints no body.',
  doneMeans:
    'UB3.8\'s second arm carries a checklist verdict (the controller\'s row): removed credential fails with the '
    + 'credential sentence, stale credential fails with the provider body shown, both against the refusing '
    + 'loopback endpoint whose own test pins the 200/401 pair.',
  doNotConflate:
    '"Reachable" is a verdict about the ENDPOINT (a network fact) and "missing or expired" about the CREDENTIAL '
    + '(a store fact); the defect is the first answering for the second. And the OAuth-token refresh arm '
    + '(source-test.ts:1006) is a different class — a green token-refresh source says nothing about the API-'
    + 'credential path this row fixes.',
  safety:
    'The fixture key is public by design and only ever guards the loopback endpoint; the credentials file is moved '
    + 'as opaque bytes inside the rig\'s own disposable NESSY_CONFIG_DIR — never decrypted, never copied outside it, '
    + 'and the real user credentials store is never touched.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
