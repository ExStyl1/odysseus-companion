/**
 * The shipped Nessy Gateway card's model catalogue, in the one place both the
 * renderer and the backend can read it (P6.669).
 *
 * It lived in `apps/electron/src/renderer/components/apisetup/nessy-gateway.ts`
 * until P6.669, which is a renderer file: `packages/server-core` has no path to
 * `apps/electron`, so every backend test that stood for this card had to
 * RESTATE the catalogue by hand. P3.179 measured what that cost — of 34 test
 * files that stand for the shipped card and build model definitions, **32 never
 * write a tri-state field the card declares**, and `supportsThinking` is the one
 * that makes an omission WRONG rather than incomplete: `ModelDefinition`
 * documents it *"Defaults to true when undefined"* while both shipped rows
 * declare `false`, so leaving it out flips the value instead of clearing it.
 *
 * `nessy-gateway.ts` re-exports every name below, so nothing that imported them
 * from the renderer had to change. The windows table this reads
 * (`nestor-gateway-windows.ts`) was already here; this is its catalogue
 * catching up with it.
 */

import type { ModelDefinition } from './models.ts'
import { NESTOR_GATEWAY_MODEL_WINDOWS, nestorGatewayModelWindow } from './nestor-gateway-windows.ts'

/**
 * The two ids the one-click card SEEDS, coder first — re-measured 2026-09-11
 * (P6.1080), and the previous pair shipped a model the gateway had retired.
 *
 * **What was wrong, and why it was release-critical.** `NESSY_GATEWAY_MODEL_IDS[0]`
 * was `tgpt/qwen35-397b-a17b-fp8`, which is also {@link NESSY_GATEWAY_DEFAULT_MODEL}
 * — the `defaultModel` every one-click gateway connection is created with
 * (`gateway-one-click.ts`, and the codex/claude gateway defaults in
 * `nessy-gateway.ts`). Probed that day, `POST …/chat/completions` for that id
 * answers **404 `Модель tgpt/qwen35-397b-a17b-fp8 больше не поддерживается,
 * выполните /auth и выберете доступную модель /model`**, and `/cli/models`
 * lists it nowhere. So a fresh card click produced a connection whose FIRST TURN
 * failed — and the remedy the gateway's own message names (`/auth`, `/model`)
 * belongs to nessy-cli, not to this product.
 *
 * `ModelRefreshService._doRefresh` does repair a stale default, and this rig's
 * own three gateway connections were migrated by it between 2026-09-03 and
 * 2026-09-07 (config backups). But that repair is **fire-and-forget at startup
 * with a 3-second fetch timeout, and it runs only on a SUCCESSFUL fetch** — it
 * cannot cover the turn that races it, and it never covers an offline start. A
 * seed that is wrong on the day it ships is not made right by a refresh that
 * usually wins.
 *
 * **The live catalogue, 2026-09-11.** Two rows, and the aliases are the stable
 * half: `tgpt/deepseek-v4-flash-0731` (alias `coder`, `is_default: true`,
 * `context_window_size: 524000`) and `tgpt/qwen36-35b-a3b-fp8` (alias `fast`,
 * 262000). The ids rotate — this is the second rotation this constant has met —
 * so everything downstream that can resolve by ALIAS should
 * ({@link resolveGatewayFastModelId} says so in its own docblock), and this
 * constant exists only because a card has to seed something before any fetch
 * has happened.
 */
export const NESSY_GATEWAY_MODEL_IDS = ['tgpt/deepseek-v4-flash-0731', 'tgpt/qwen36-35b-a3b-fp8'] as const

/**
 * P3.79 — the seed window, READ from the shared table instead of typed here.
 *
 * This was a hand-typed `262_144` with a comment saying `/cli/models` does not
 * report a context window and this is therefore the source of truth. Both halves
 * went stale on 2026-08-28: the API DOES report `context_window_size` now, it
 * reports `262000`, and the constant was 144 tokens above it — the over-stating
 * direction, which is the one that runs a session past its real limit before
 * anything compacts.
 *
 * Per model rather than one number for both, so a future gateway model with a
 * different window is seeded correctly. An id the table does not cover falls
 * back to the SMALLEST window the table records — never a larger one, and never
 * a number invented here — and the hourly `/cli/models` refresh replaces the
 * seed with the live value regardless.
 */
const NESSY_GATEWAY_SMALLEST_KNOWN_WINDOW = Math.min(...Object.values(NESTOR_GATEWAY_MODEL_WINDOWS))

export function gatewaySeedWindow(modelId: string): number {
  return nestorGatewayModelWindow(modelId) ?? NESSY_GATEWAY_SMALLEST_KNOWN_WINDOW
}

export const NESSY_GATEWAY_CONTEXT_WINDOW = gatewaySeedWindow(NESSY_GATEWAY_MODEL_IDS[0])

/**
 * The two rows the one-click card writes into a new connection.
 *
 * BOTH tri-states are declared on BOTH rows, deliberately and not as
 * boilerplate: `supportsImages: false` because the endpoint refuses images and
 * `ebbfca53d` made an UNDECLARED model un-gated, and `supportsThinking` because
 * its documented default is `true` while a row that takes no reasoning effort is
 * `false`. A fixture that stands for this card and omits either is not
 * under-specified, it is wrong — which is what
 * {@link NESSY_GATEWAY_DECLARED_TRI_STATES} exists to let a test assert without
 * restating the values.
 *
 * **D1.322 — the two rows now DISAGREE on `supportsThinking`, and that is the
 * measurement rather than a drift.** The catalogue publishes a reasoning block
 * for `coder` and none for `fast` (RS-57, read off the file the refresh itself
 * writes on the packaged 1.40.0, 2026-09-18), so the field leaves that derived
 * map by the map's own rule and a fixture must say which row it stands for.
 */
export const NESSY_GATEWAY_MODELS: ModelDefinition[] = [
  {
    id: NESSY_GATEWAY_MODEL_IDS[0],
    name: 'DeepSeek V4 Flash',
    // The gateway's own ALIAS, verbatim and lower-case, and this is
    // load-bearing rather than cosmetic. `fetchNestorModels` writes
    // `shortName: model.alias`, so after the first refresh these rows read
    // `coder`/`fast` — while the seed said `Qwen Coder`/`Qwen Fast`, and
    // `resolveGatewayFastModelId` matches `shortName.toLowerCase() === 'fast'`
    // EXACTLY. So on a freshly seeded connection, before any refresh, the fast
    // tier resolved to `undefined`: the orchestrator `small` tier and the
    // guardian judge silently fell back to the session model. Seeding the alias
    // the fetcher itself writes removes the divergence instead of papering it.
    shortName: 'coder',
    description: 'Nessy Gateway coding model (alias `coder`). Replaced by the gateway\'s own description on the first catalogue refresh.',
    provider: 'pi',
    contextWindow: gatewaySeedWindow(NESSY_GATEWAY_MODEL_IDS[0]),
    // D1.322 — FLIPPED, and flipped as a PAIR. The controller decided it on
    // 2026-09-17 under the owner's delegation; RS-57 supplied the reading it was
    // waiting on, on the packaged 1.40.0 (2026-09-18), off `config.json` — the
    // file the catalogue refresh itself writes — with the app's live record
    // beside it:
    //
    //   | row     | reasoningEffort | samplingParams                         |
    //   | `coder` | **`low`**       | `{temperature: 1, top_p: 0.95}`        |
    //   | `fast`  | none            | `{temperature: 0.7, top_k: 20, top_p: 0.8}` |
    //
    // The control that makes `fast`'s absence mean something is that BOTH rows
    // carry `samplingParams` — the same commit and the same parser read
    // `sampling_params` and `reasoning` — so `fast` having no `reasoningEffort`
    // is the CATALOGUE being silent about that model, not the reader being
    // absent. That distinction is why sitting 4's NULL on the 1.39.0 artefact
    // was the right answer there.
    //
    // ## Why the boolean does not travel alone
    //
    // D1.116 measured that flipping it by itself would OVERRIDE the catalogue's
    // own recommendation rather than honour it: a gateway id is in no
    // `MODEL_DEFAULT_EFFORT` row, so a thinking-capable gateway session used to
    // fall through to `DEFAULT_THINKING_LEVEL`, which is `medium` — and the
    // owner accepted `low` at DA1.22, with its measured 0.9 s -> 12 s per turn.
    // Nobody has accepted `medium`.
    //
    // `ab7a45128` closed that for a REFRESHED card by adding
    // `publishedModelThinkingLevel` and the `SessionManager` tier that reads it.
    // It reads `connection.models[].reasoningEffort`, which the fetcher writes —
    // so it answers nothing between seeding a card and its first successful
    // refresh, and that window is exactly where a bare flip would send `medium`.
    // Seeding the catalogue's own `low` closes it. Like `description` and
    // `shortName` above, this is a SEED: the first refresh replaces it with
    // whatever the gateway publishes that day.
    //
    // `samplingParams` is deliberately NOT seeded beside it. An effort
    // recommendation the product may still outrank is a smaller claim than a
    // temperature; the refresh supplies both, and only one of them is required
    // for this flip to be honest rather than louder than the catalogue.
    //
    // The seam that consumes the boolean is the Pi driver's `customModels`
    // whitelist (`backend/internal/drivers/pi.ts`) -> `pi-agent-server`'s
    // `custom-endpoint-models.ts`, where `reasoning: overrides?.supportsThinking ?? false`
    // decides whether pi-ai sends an effort parameter at all — NOT
    // `activeEffortLevelForModel`, which searches a nine-row registry holding no
    // gateway id. D1.116 recorded that correction and it still stands.
    //
    // USER-VISIBLE CONSEQUENCE, stated rather than left to be met: the
    // composer's effort control is disabled by `supportsThinking === false`
    // (`FreeFormInput`/`CompactModelSelector`), so this row's effort selector
    // becomes live. `fast` keeps its own, and stays disabled.
    supportsThinking: true,
    reasoningEffort: 'low',
    supportsImages: false,
  },
  {
    id: NESSY_GATEWAY_MODEL_IDS[1],
    name: 'Qwen 3.6 35B',
    shortName: 'fast',
    description: 'Nessy Gateway fast model (alias `fast`). Replaced by the gateway\'s own description on the first catalogue refresh.',
    provider: 'pi',
    contextWindow: gatewaySeedWindow(NESSY_GATEWAY_MODEL_IDS[1]),
    // D1.322 — LEFT AT `false`, and now MEASURED rather than unmeasured.
    //
    // D1.244 waited on a build that could answer at all: the 1.39.0 artefact
    // predates DA1.22's reader (`git merge-base --is-ancestor 4e3b57caf b1f4f279c`
    // answered NOT AN ANCESTOR), so its empty catalogue said nothing about the
    // gateway. RS-57 asked the question on 1.40.0 and the answer is that the
    // catalogue publishes NO reasoning block for this id, while publishing
    // `samplingParams` for it in the same read — which is the control that
    // separates "the catalogue is silent" from "the reader is absent".
    //
    // A silence is not a licence. `false` is what this row has always declared
    // and what the measurement leaves it at; the day the gateway starts
    // publishing a reasoning block for it, the flip is the `coder` row's
    // two-line shape above and nothing more.
    //
    // The consequence the two rows disagreeing carries is priced on
    // {@link NESSY_GATEWAY_DECLARED_TRI_STATES} and taken rather than worked
    // around: `supportsThinking` leaves that derived map, and the fixture
    // builder that spreads it names the card's DEFAULT row instead.
    supportsThinking: false,
    supportsImages: false,
  },
]

export const NESSY_GATEWAY_DEFAULT_MODEL = NESSY_GATEWAY_MODEL_IDS[0]

/**
 * Every tri-state field the shipped card DECLARES, with the value it declares —
 * derived from the catalogue above rather than written twice.
 *
 * The derivation is what makes it useful: a third tri-state added to the rows
 * above appears here on the next run, so a fixture builder and a guard reading
 * this cannot fall behind the card the way 32 hand-written fixtures did.
 *
 * A field is included only when EVERY row agrees on it. Two rows disagreeing is
 * a property of the model, not of the card, and a fixture cannot copy it from
 * here — it would have to say which model it stands for.
 */
export const NESSY_GATEWAY_DECLARED_TRI_STATES: Readonly<Record<string, boolean>> = Object.freeze(
  Object.fromEntries(
    (['supportsThinking', 'supportsImages'] as const)
      .map(field => [field, NESSY_GATEWAY_MODELS.map(model => model[field])] as const)
      .filter(([, values]) => values.every(value => typeof value === 'boolean' && value === values[0]))
      .map(([field, values]) => [field, values[0] as boolean]),
  ),
)
