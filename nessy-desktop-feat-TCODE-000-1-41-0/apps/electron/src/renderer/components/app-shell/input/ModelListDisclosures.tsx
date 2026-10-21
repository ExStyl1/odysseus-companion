/**
 * The lines that sit under a model LIST: whether any model on it is reached
 * through a translated wire, where the list came from, and where this session's
 * MCP tool schemas go — with what is withheld from them.
 *
 * ## Why this is a component and not blocks of JSX in each picker (DA2.23)
 *
 * It used to be two blocks of JSX, in `CompactModelSelector.tsx`, and nowhere
 * else. RS-44 measured what that cost on the packaged 1.39.0 — one card, one
 * session, one minute: at 1400 px `FreeFormInput`'s own `DropdownMenu` picker
 * listed both of the card's models (so `derivePickerMode` answered `flat`, the
 * only mode under which either line renders) and rendered NEITHER
 * `model-target-tool-egress` nor `model-list-provenance`; at 700 px
 * `CompactModelSelector` rendered both, and correctly rendered no disclosure for
 * the gateway card. The compact arm was the control: the testids worked, the
 * classifier answered and the copy existed, so the desktop absence was the
 * COMPONENT and not the mechanism. A desktop user got the connection-row badge
 * and the sentence only as its hover `title`.
 *
 * The obvious repair — paste the two blocks into the second picker — is the one
 * this file exists to refuse. Two copies of a disclosure drift, and a privacy
 * notice that says different things in two widths of the same window is worse
 * than one that is missing from both. So the classification, the copy, the
 * testids and the suppression rule live HERE, once, and each picker renders the
 * component with the styling its own container needs.
 *
 * ## The suppression rule, unchanged
 *
 * EVERY line here renders under `pickerMode === 'flat'` and nothing else —
 * including DA2.25's translated-wire note, which arrived carrying its own copy
 * of the rule and had it dropped rather than carried across. The two other
 * modes are not showing a list: `unavailable` has no connection to describe,
 * and `locked-single` is the one-model form. Keeping the rule inside the
 * component is what lets a picker render it unconditionally and still be
 * right — and it is what RS-44's discriminator reads, so the lines must stay in
 * the same mode as each other.
 *
 * ## Two variants, because two containers
 *
 * `drawer` is the compact picker's Radix drawer, whose panel is a fixed-width
 * sheet. `menu` is `StyledDropdownMenuContent`, which is `w-fit
 * whitespace-nowrap` — and `white-space` INHERITS, so an unwrapped sentence
 * would set the width of the whole menu. `FreeFormInput` already records that
 * trap twice (one long catalogue description stretched the menu past half the
 * window), and the permission menu's own runtime note is the house pattern this
 * variant copies: a plain `<p>`, bounded and wrapping, and deliberately NOT a
 * `StyledDropdownMenuItem`, because it is not selectable and Radix's keyboard
 * navigation skips a child that is not an item.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { isNessyGatewayConnection } from '@/components/apisetup/nessy-gateway'
import {
  modelListProvenance,
  type ModelListConnectionFacts,
} from '@/lib/model-list-provenance'
import { modelTargetDisclosure } from '@/lib/model-target-disclosure'
import { isTranslatedWireSessionModel } from './model-picker-helpers'
import { shortTimeLocale } from '@/utils/session'
import type { PickerMode } from './picker-mode'

/** Which container the lines are being rendered into; see the docblock above. */
export type ModelListDisclosureVariant = 'drawer' | 'menu'

// UB14.30 — on v0.15.1's caption role (the qualifier line under upstream's context footer:
// `text-caption font-normal text-tertiary`); the drawer line sits on the sheet's 16px edge like its rows.
const LINE_CLASS: Record<ModelListDisclosureVariant, string> = {
  drawer: 'px-2 pt-2 text-caption font-normal text-tertiary',
  menu: 'max-w-[380px] whitespace-normal px-2 pt-2 text-caption font-normal text-tertiary',
}

export interface ModelListDisclosuresProps {
  /** The picker's own mode; anything but `flat` renders nothing. */
  pickerMode: PickerMode
  /**
   * The connection whose list is on screen — the SAME object the list itself
   * came from, so the sentence and the list cannot disagree. `null` is the
   * built-in list, which is what `modelListProvenance` calls `builtIn`.
   */
  connection: ModelListConnectionFacts | null | undefined
  /** The model id the session is on; half of the disclosure's classification. */
  currentModel: string
  /**
   * DA2.25 — the list on screen: the SAME array the picker maps over.
   *
   * A LIST and not a `hasTranslatedWireModel` boolean, and that is the whole
   * choice this prop records. A boolean would put
   * `.some(isTranslatedWireSessionModel)` in both pickers, which is the
   * duplication DA2.23 removed for the two lines below — and the note reads the
   * same list the rows do, so the mark on a row and the sentence under the list
   * cannot disagree.
   *
   * It is also NOT the counter-example next door: DA1.69 refuses a COUNT of
   * withheld MCP servers because that number lives in the host's pool filter, a
   * source in NEITHER picker's scope, so it could only arrive as a prop that
   * might be wrong. This list is already in both pickers' hands — they render
   * it — and the derivation is a predicate over it, so nothing has to be
   * trusted from elsewhere.
   */
  models: readonly (string | { readonly wire?: 'anthropic-messages' })[]
  variant: ModelListDisclosureVariant
}

export function ModelListDisclosures({
  pickerMode,
  connection,
  currentModel,
  models,
  variant,
}: ModelListDisclosuresProps) {
  const { t } = useTranslation()

  /**
   * C3.346 — the sentence that says where this list came from.
   *
   * Read off the connection the list itself came from, so the two cannot
   * disagree: a picker falls back to the built-in catalogue exactly when there
   * is no connection, which is the `builtIn` case. See {@link modelListProvenance}
   * for why `modelsSyncedAt` is not borrowed for the gateway's clock (DA2.12
   * gave it `catalogueRefreshedAt`, a field of its own).
   */
  const provenance = React.useMemo(
    () => modelListProvenance(connection ?? undefined, isNessyGatewayConnection),
    [connection],
  )

  /**
   * DA2.6 — the disclosure, beside the provenance and for the same reason.
   *
   * The list says WHERE it came from; this says where the session's MCP tool
   * names and schemas GO. It is owed whenever `classifyModelTarget` marks the
   * endpoint+model pair restricted — an external vendor namespace, or a target
   * the host cannot place — and `null` for the verified gateway, a loopback
   * adapter, a perimeter-internal namespace and a provider default.
   *
   * **This sentence discloses a SEND and nothing else**, and the guard in
   * `lib/__tests__/model-target-disclosure.test.ts` holds it to that. What has
   * moved (2026-09-17) is the reason: DA2.14 answered the owner question and
   * DA2.2's POOL filter landed, so servers really are withheld now — see
   * `applyExternalModelMcpWhitelist` in
   * `packages/shared/src/mcp/runtime-pool-servers.ts`, gated on the same
   * `verdict.restricted` this component classifies on. The withholding is told
   * by the SECOND line below (DA1.69), count-free, because a count is not
   * available where this copy lives: the servers are dropped in the HOST's
   * pool, which neither picker can see, so an `N` could only arrive as a prop
   * that might be wrong.
   *
   * That reason used to be written as this component's whole PROP LIST, and
   * DA2.25 falsified the wording by adding `models`. The refusal is unchanged
   * and sharper for it: a prop is refused when its VALUE comes from somewhere
   * the pickers cannot see, not because a prop is refused — see
   * {@link ModelListDisclosuresProps.models}, which is the opposite case and
   * says so.
   *
   * The guard reads the LOCALE VALUES of the two SEND keys, not this file: the
   * claim is the copy and only the copy, a source guard would fire on this very
   * paragraph (the stale-NAME trap AGENTS.md records), and it loops a fixed
   * pair of keys — so DA1.69's key is outside it BY CONSTRUCTION and neither
   * line can start claiming the other's job.
   *
   * Classified HERE rather than subscribed to: `noteModelTargetToolEgress`
   * dedupes per PROCESS, so a surface fed by its emissions would go blank for
   * every session after the first. See `@/lib/model-target-disclosure`.
   */
  const toolEgress = React.useMemo(
    // D1.246 — the providerType is the third fact, and without it this line was
    // silent for exactly the connections the backend fails closed on.
    () => modelTargetDisclosure({
      baseUrl: connection?.baseUrl,
      model: currentModel,
      providerType: connection?.providerType,
      // F1.572 — a subscription card's endpoint, derived as the backend derives it.
      codexModelProvider: connection?.codexModelProvider,
      piAuthProvider: connection?.piAuthProvider,
    }),
    [connection, currentModel],
  )

  const provenanceLine = React.useMemo(() => {
    // Every key spelled as a LITERAL, never composed from the kind: a composed
    // key is invisible to `check-i18n-reachable`, which would report all six as
    // unreachable and send the next reader to delete them.
    const when = provenance.kind === 'builtIn' ? undefined : provenance.syncedAt
    const ago = when === undefined
      ? undefined
      : formatDistanceToNowStrict(new Date(when), {
        locale: shortTimeLocale as Locale,
        roundingMethod: 'floor',
      })
    if (provenance.kind === 'gateway') {
      return ago === undefined
        ? t('chat.modelPicker.provenanceGateway')
        : t('chat.modelPicker.provenanceGatewayRefreshed', { when: ago })
    }
    if (provenance.kind === 'endpoint') {
      return ago === undefined
        ? t('chat.modelPicker.provenanceEndpoint', { host: provenance.host })
        : t('chat.modelPicker.provenanceEndpointRefreshed', { host: provenance.host, when: ago })
    }
    return t('chat.modelPicker.provenanceBuiltIn')
  }, [provenance, t])

  /**
   * DA2.25 — does THIS list contain a model whose wire is translated.
   *
   * The mark's meaning, said once under the list rather than in every row. It
   * rode in `CompactModelSelector` only, which is the identical absence RS-44
   * measured for the two lines below: the desktop `DropdownMenu` picker showed
   * neither the mark nor this sentence, so a user at 1400 px was told nothing
   * about a translation a user at 700 px was told about twice.
   *
   * The per-row MARK cannot come here — it renders inside each model button, so
   * it stays an edit at each picker's row site — but its explanation is
   * list-level and belongs beside the other two list-level lines.
   */
  const hasTranslatedWireModel = React.useMemo(
    () => models.some(model => isTranslatedWireSessionModel(connection, model)),
    [connection, models],
  )

  // After the hooks, never before one: the mode decides what is DRAWN, and a
  // component that returned early would change the hook order the first time a
  // picker went from `flat` to `locked-single` without unmounting.
  if (pickerMode !== 'flat') return null

  const lineClass = LINE_CLASS[variant]

  return (
    <>
      {/* DA2.25 — the translated-wire note, FIRST, which is the order the
          compact picker already had: it explains a mark the reader has just
          seen in the rows above. The `flat`-only gate that used to sit on it
          there is dropped rather than carried across — this component owns that
          rule for every line in the block (see the header), and a second copy
          is what DA2.23 removed. */}
      {hasTranslatedWireModel && (
        <p data-testid="model-translated-note" className={lineClass}>
          {t('onboarding.byoRuntime.modelsTranslatedNote')}
        </p>
      )}
      {/* One line under the LIST, not a label on every row: the provenance is a
          property of the list. */}
      <p data-testid="model-list-provenance" className={lineClass}>
        {provenanceLine}
      </p>
      {/* Where the session's MCP tool schemas GO, under the line that says
          where the list came from. One line for the LIST's target, never a
          label per model: the target is a property of the connection plus the
          chosen model, and the picker is the one place the user changes
          either. */}
      {toolEgress && (
        <>
          <p data-testid="model-target-tool-egress" className={lineClass}>
            {/* An empty host is a connection with no endpoint of its own: the
                vendor default answers and there is nothing to name, so the
                host-free sentence is used rather than interpolating an empty
                string into the one that promises a name. Both keys are
                LITERALS, for the reason stated above the provenance block. */}
            {toolEgress.host
              ? t('chat.modelPicker.toolEgressDisclosure', { host: toolEgress.host })
              : t('chat.modelPicker.toolEgressProviderDefault')}
          </p>
          {/* DA1.69 — and it shares the condition above rather than testing
              again, which is measured rather than assumed: the host's own gate
              is `modelTargetWithholdsMcpServers(v)`, i.e. `v.restricted ===
              true`, and `modelTargetDisclosure()` returns `null` on exactly
              `!verdict.restricted`. Same predicate, same module, so the line
              that says what is withheld cannot appear where nothing is, nor
              disappear where something is.

              COUNT-FREE on purpose: the filtering happens in the HOST's
              pool, which neither picker can see, so an "N withheld" line could
              only arrive as a prop that might be wrong — and a number that can
              be wrong is worse here than no number, because the reader is
              deciding whether to trust the model with their tools. DA2.25's
              `models` prop is no precedent against this: that list is the one
              the pickers already render. */}
          <p data-testid="model-target-tool-withholding" className={lineClass}>
            {t('chat.modelPicker.toolEgressWithholding')}
          </p>
        </>
      )}
    </>
  )
}
