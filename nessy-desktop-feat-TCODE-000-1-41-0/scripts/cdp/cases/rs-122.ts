/**
 * RS-122 (UB3.8 arm A) — the BYO connection edit-and-test with the untouched
 * masked key: the stored credential resolves server-side and the mask never
 * travels. Drives UB3.4 (R14-20).
 *
 * ## The row
 *
 * UB3.8 names two Phase 3 live cases; this file is the first. UB3.4's fix —
 * the connection test resolving the STORED key from a connection slug when the
 * edit form's key field holds only the mask — is not landed as of the premise
 * reading below, so this case is a recipe: it scores the FIX on the sitting
 * build, and driving it before UB3.4 lands measures the defect and calls it
 * the row.
 *
 * ## The premise, read at HEAD `64b944e8a` (2026-10-15)
 *
 * - The edit form's key field holds the MASK — `GET_API_KEY` masks for every
 *   caller — and the mask is not a credential: `ByoRuntimeStep.tsx:292-303`
 *   records the live measurement (2026-08-14) that sending it dies at header
 *   encoding with the bullet character (U+2022, value 8226, "not a ByteString").
 * - The catalog RPC already resolves the stored key server-side:
 *   `TestLlmConnectionParams.slug` exists (`dto.ts:1529`) but is scoped "for
 *   `fetchModels` / `validateModels` only", and the handler reads it only in
 *   the catalog branch (`llm-connections.ts:663-666`).
 * - The FULL connection test — the agent-subprocess `runMiniCompletion` path
 *   the same handler runs otherwise — still requires a typed key: without one
 *   it answers `API key is required` (`llm-connections.ts:689`). UB3.4's named
 *   DTO field `connectionSlug` does not exist; the slug branch is the
 *   catalog-only predecessor.
 *
 * So the drive's discriminating arm is the untouched-mask TEST, and the
 * already-true catalog arm is its rig control on the same surface.
 *
 * ## Why a recipe and not a drive
 *
 * The drive needs a packaged build carrying UB3.4, a bound card and the
 * sitting lane; `run.ts`'s `SITTING` needs the checklist row a lane must not
 * write (the rs-121 rule). The id is lane-picked (next free after RS-121; the
 * dispatch allocated none) and the controller confirms it at the pin.
 *
 * ## The instrument
 *
 * `scripts/cdp/fixtures/stub-upstream.ts` (C3.356) — the credential-free
 * loopback OpenAI-compatible upstream, which records each request's
 * Authorization LENGTH only. That length is the detector: the operator knows
 * both candidate values (the fixture key it typed at creation, the mask it
 * sees in the edit field), so a logged length equal to the FIXTURE key's
 * length proves the stored credential travelled, and equality with the mask's
 * length would prove the defect. No value is ever recorded by either side.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-122'
const TITLE =
  'the BYO connection edit-and-test with the untouched masked key: the stored key resolves server-side and the mask never travels'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB3.8',
  runtimes: ['pi'],
  credentials:
    'owner: none. The connection is a Pi BYO card against the credential-free loopback stub '
    + '(`scripts/cdp/fixtures/stub-upstream.ts`, C3.356) and its key is a FIXTURE string typed by the '
    + 'operator into the rig\'s own fresh NESSY_CONFIG_DIR — never a real credential, never printed; '
    + 'the stub and its log record header LENGTHS only.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Land-check first: UB3.4 must be in the build (git log names it; and the bundles carry it — `bun run electron:build:servers` after the lane lands, then relaunch; scripts/cdp/README.md\'s stale-bundle rule). Driving on a build without UB3.4 measures the defect; record that reading as the BEFORE, never as the row.',
    '2. Launch the PACKAGED build by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, dark theme. Start the loopback upstream: `bun run scripts/cdp/fixtures/stub-upstream.ts --port 9331 --log <rig>/stub-log.jsonl` (port 0 gives the server\'s own; read its line).',
    '3. CREATE the BYO connection through the product: Settings → AI → add connection → the BYO runtime card; custom endpoint, api openai-completions, base URL = the stub URL from step 2, key = the FIXTURE string `rs122-fixture-key-24` (record its length once). Save; the card exists with a stored credential.',
    '4. POSITIVE CONTROL (the rig, on the same surface): reopen the card for EDIT — the key field shows the MASK; do not touch it — and run the model-catalog FETCH. It must return the stub\'s catalog, and the stub log\'s `/models` record must show authorizationLength equal to `Bearer rs122-fixture-key-24`\'s length (the server resolved the STORED key from the slug — the already-true half, llm-connections.ts:663-666). A catalog failure here means the rig is wrong: stop, do not score the row.',
    '5. THE ARM (what UB3.4 lands): on the SAME untouched edit form, run the connection TEST (the wizard\'s submit/test path, not the catalog). EXPECTED: success — the stored key resolved server-side from the slug; the completion request in the stub log carries authorizationLength equal to the fixture key\'s length. At HEAD this arm reads `API key is required` (llm-connections.ts:689) or dies on the mask\'s header encoding — the recorded BEFORE.',
    '6. NEGATIVE ARMS: (a) type a WRONG fixture value over the mask and test again — it must FAIL (the typed key wins over the stored one; the stub log\'s new record carries the wrong value\'s length); (b) clear the field back to the untouched mask and test once more — it must succeed again (the failed attempt overwrote nothing); (c) read the key field\'s value after the successful test — still the mask (or empty), never key material: the stored key must not surface into the renderer by the fix itself.',
    '7. Verdict: UB3.8 arm A PASSES when step 5 succeeds with every arm of step 6 holding, all four readings taken from the stub log and the app state — never from a model\'s prose and never from memory of the key.',
  ],
  expected:
    'On the packaged build carrying UB3.4: the untouched-mask edit form passes the connection test, the stub log\'s '
    + 'test record carries the stored key\'s LENGTH (not the mask\'s, not zero), the wrong-key and re-mask arms hold, '
    + 'and the renderer never holds key material.',
  detector:
    'The stub upstream\'s own JSONL log (header lengths only) plus the product\'s own test result in the app state. '
    + 'Length equality with the fixture key proves the stored credential travelled; the mask\'s length or a missing '
    + 'record is the defect. No screen reading and no model prose is evidence.',
  positiveControl:
    'Step 4, on the same surface before the arm: the catalog fetch with the untouched mask already resolves the '
    + 'stored key by slug at HEAD (dto.ts:1529, llm-connections.ts:663-666). If that arm cannot pass, the rig — the '
    + 'stored key, the URL, the build — is wrong and the arm below would read the rig, not UB3.4.',
  runOnlyIf:
    'UB3.4 is landed in the build under test (its commit in git log AND the bundles rebuilt after it — the '
    + 'README\'s stale-bundle rule). On a build without it, the expected reading is the recorded BEFORE: the test '
    + 'answers "API key is required" or dies on the mask\'s header encoding (measured live 2026-08-14).',
  doneMeans:
    'UB3.8\'s first arm carries a checklist verdict (the controller\'s row): the untouched-mask test succeeds on the '
    + 'sitting build with the negative arms and the no-material arm holding.',
  doNotConflate:
    'The catalog arm (fetchModels/validateModels — slug already resolves there) is NOT the row: it is the rig '
    + 'control. And the test arm\'s HEAD failure is the recorded BEFORE of a row whose fix is not yet in the build — '
    + 'a defect reading, not a rig error, and never a reason to score UB3.4 as present.',
  safety:
    'The fixture key is typed only into the rig\'s own fresh NESSY_CONFIG_DIR and only ever against the loopback '
    + 'stub; the stub and this recipe record header LENGTHS, never values. Never point the card at a real endpoint '
    + 'and never substitute a real key: the case\'s discriminating reading is a length comparison, which a fixture '
    + 'value serves as well as a secret would.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
