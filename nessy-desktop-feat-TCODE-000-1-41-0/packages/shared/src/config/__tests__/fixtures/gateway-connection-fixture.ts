/**
 * P6.669 — one builder for a test fixture that stands for the shipped Nessy
 * Gateway card, DERIVED from the card rather than restated beside it.
 *
 * ## The defect this exists to make impossible
 *
 * P3.179 swept the 34 test files that stand for the shipped card and build model
 * definitions: **32 never write a tri-state field the card declares.** For
 * `supportsImages` that is under-specification — the field has no default, so an
 * omission means *undeclared*, which is a real third state (and the one that
 * manufactured P3.152's false positive). For `supportsThinking` it is a WRONG
 * VALUE: `ModelDefinition` documents it *"Defaults to true when undefined"*
 * while both shipped rows declare `false`, so an omission does not leave the
 * field unset, it flips it.
 *
 * The instrument that found this also recorded its own blind spot, which is why
 * the fix is derivation rather than 32 edits: a literal-level sweep finds four
 * candidates and all four are legitimate, because it cannot see fixture
 * FACTORIES — and a factory is exactly where P3.152's defect lived.
 *
 * ## Why it lives in `packages/shared`
 *
 * Both sides need it. `packages/server-core`'s switch suites and
 * `apps/electron`'s apisetup suites both build gateway connections, and
 * server-core has no path to `apps/electron` — which is the mechanical reason
 * the catalogue was restated by hand in the first place. The catalogue moved to
 * `config/nessy-gateway-models.ts` with this row; `nessy-gateway.ts` re-exports
 * every name, so no renderer import changed.
 *
 * ## What it does NOT do
 *
 * It does not choose ids, windows or providers. A suite's ids are its own
 * business — `runtime-switch-session.test.ts` deliberately gives its two gateway
 * cards DISJOINT catalogues so a model-reset case has a negative control, and a
 * builder that imposed the real ids would silently destroy that. What it
 * imposes is only the part a fixture has no business deciding: every tri-state
 * the card declares, at the value the card declares — and where the card's two
 * rows disagree (D1.322), at the value its DEFAULT row declares, which is the
 * one thing a fixture standing for "the card" can honestly mean. See
 * {@link NESSY_GATEWAY_DEFAULT_ROW_TRI_STATES}.
 */

import type { ModelDefinition } from '../../models.ts'
import {
  NESSY_GATEWAY_DECLARED_TRI_STATES,
  NESSY_GATEWAY_DEFAULT_MODEL,
  NESSY_GATEWAY_MODELS,
  gatewaySeedWindow,
} from '../../nessy-gateway-models.ts'

/**
 * D1.322 — the tri-states the card's two rows no longer AGREE on, taken from the
 * row the card itself defaults to.
 *
 * `NESSY_GATEWAY_DECLARED_TRI_STATES` includes a field only while every row
 * carries the same value, and its own docblock says why: two rows disagreeing is
 * a property of the model rather than of the card, and a fixture cannot copy the
 * value from there — it would have to say which model it stands for. RS-57
 * measured the catalogue publishing a reasoning block for `coder` and none for
 * `fast`, so `supportsThinking` left that map and ~30 fixtures would have
 * stopped declaring it — which is not under-specification but a WRONG VALUE, the
 * exact defect this file exists to make impossible: `ModelDefinition` documents
 * `supportsThinking` as *"Defaults to true when undefined"*.
 *
 * So the fixture says which row it stands for, ONCE, here: the card's own
 * default model. Still derived — a future third row, or a future disagreement on
 * `supportsImages`, is picked up on the next run without this file being edited
 * — and a suite whose SUBJECT is the other row passes `overrides`, which is the
 * same say-it-out-loud rule the builder already has.
 */
const NESSY_GATEWAY_DEFAULT_ROW_TRI_STATES: Readonly<Record<string, boolean>> = Object.freeze(
  Object.fromEntries(
    (['supportsThinking', 'supportsImages'] as const)
      .filter(field => !(field in NESSY_GATEWAY_DECLARED_TRI_STATES))
      .map(field => [
        field as string,
        NESSY_GATEWAY_MODELS.find(model => model.id === NESSY_GATEWAY_DEFAULT_MODEL)?.[field],
      ] as const)
      .filter((entry): entry is readonly [string, boolean] => typeof entry[1] === 'boolean'),
  ),
)

/** What a caller may choose. Everything else comes from the card. */
export interface GatewayModelFixtureOptions {
  id: string
  /** Defaults to the card's own seed window for this id. */
  contextWindow?: number
  /** Defaults to `'pi'`, the provider both shipped rows carry. */
  provider?: string
  /**
   * Deliberate divergence from the card, for a case whose SUBJECT is the
   * divergence. Every key given here overrides the declared value, and a test
   * that passes one is saying so out loud rather than by omission.
   */
  overrides?: Partial<Pick<ModelDefinition, 'supportsThinking' | 'supportsImages'>>
  /**
   * P6.784 — leave `supportsImages` ABSENT, for a case whose subject is the
   * third state: after `ebbfca53d` an undeclared model is deliberately un-gated
   * (*carry the modality faithfully and let the endpoint refuse*), so *"nobody
   * said"* is a different fixture from *"said no"* and no value can express it.
   * The key is DELETED, never set to `undefined`: `toEqual` and `in` read the
   * two differently, and it is `in` that a gate keyed on "was this declared"
   * would ask.
   *
   * There is deliberately NO twin for `supportsThinking`, and the asymmetry is
   * the whole point of this builder: that field is documented *"Defaults to
   * true when undefined"*, so omitting it does not leave it undeclared — it
   * declares the opposite of what the card says. A caller who wants it `true`
   * says so through {@link GatewayModelFixtureOptions.overrides}.
   */
  imagesUndeclared?: boolean
}

/**
 * One model row shaped like the shipped card's.
 *
 * Returned as a plain object rather than `ModelDefinition` so a suite whose
 * connection type is its own local shape can still use it.
 */
export function gatewayModelFixture(options: GatewayModelFixtureOptions): Record<string, unknown> {
  const { id, contextWindow, provider = 'pi', overrides = {}, imagesUndeclared = false } = options
  const model: Record<string, unknown> = {
    id,
    name: id,
    shortName: id,
    description: '',
    provider,
    contextWindow: contextWindow ?? gatewaySeedWindow(id),
    ...NESSY_GATEWAY_DEFAULT_ROW_TRI_STATES,
    ...NESSY_GATEWAY_DECLARED_TRI_STATES,
    ...overrides,
  }
  if (imagesUndeclared) delete model.supportsImages
  return model
}

export interface GatewayConnectionFixtureOptions {
  slug: string
  name?: string
  /** `pi_compat` | `codex-runtime` | `claude-runtime` — the card's three. */
  providerType: string
  authType?: string
  /** The ids this suite needs. The first is the default model unless one is given. */
  modelIds: readonly string[]
  contextWindow?: number
  provider?: string
  defaultModel?: string
  overrides?: GatewayModelFixtureOptions['overrides']
}

/** A whole connection whose every model row is {@link gatewayModelFixture}'s. */
export function gatewayConnectionFixture(
  options: GatewayConnectionFixtureOptions,
): Record<string, unknown> {
  const {
    slug,
    name = slug,
    providerType,
    authType = 'bearer_token',
    modelIds,
    contextWindow,
    provider,
    defaultModel,
    overrides,
  } = options
  return {
    slug,
    name,
    providerType,
    authType,
    models: modelIds.map(id => gatewayModelFixture({ id, contextWindow, provider, overrides })),
    defaultModel: defaultModel ?? modelIds[0],
    createdAt: Date.now(),
  }
}
