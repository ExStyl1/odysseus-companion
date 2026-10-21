/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/ComposerModelMenu.tsx (UB14.30; ADDED in
 * v0.15.0). Merged (Apache-2.0) into our own extraction of the same menu (D1.214's desktop picker menu, whose file
 * this is under upstream's name since UB14.30). Taken: the trigger (`COMPOSER_CHIP` + `shrink gap-1 pl-2.5 pr-2`,
 * the open fill, the destructive unavailable state, the truncating name), the row vocabulary (`MENU_GROUP_LABEL`,
 * `ITEM_NAME`, `ITEM_DESCRIPTION`, `size-4 text-secondary` checks, `text-disabled`), the shared `VisionToggle`, the
 * footer's `text-label-sm text-tertiary tabular-nums`. Ours re-applied, each named where it renders: `ConnectionRow`
 * (the three-runtime switch with its preview and `RuntimeSwitchDialog`, `switchable`, `onPreviewConnectionChange`)
 * in place of upstream's provider → connection → model switcher; `ModelListDisclosures` (RS-44/DA2.23); the per-row
 * translated-wire and catalogue-unlisted marks (DA2.25, D1.162); the effort pill on the trigger (codex wave 3.2,
 * F1.1266); the effort levels THIS runtime honours (`reasoningLevels`, not the global `THINKING_LEVELS`); the 380px
 * description bound; our context line (`chat.context`/`chat.tokensUsed`; `context-display.ts` is absent in ours,
 * UB14.28).
 *
 * **D1.214 — the DESKTOP model picker, as a component with a harness.**
 *
 * ## Why this file exists
 *
 * `CompactModelSelector` — the narrow-window picker — has had a playground entry since P6.600. The DESKTOP picker
 * had none: it was 270 lines of JSX inside `FreeFormInput`, which is the whole composer, so the only way to look at
 * it was to run the app. Two rows in one week were found the hard way because of that, and both were regressions of
 * the same kind — a line the compact picker rendered and this one did not:
 *
 *  - **RS-44 / DA2.23**: on the packaged 1.39.0, at 1400 px BOTH disclosure lines were absent while at 700 px the
 *    compact picker showed both, for the same card, in the same minute.
 *  - **DA2.25**: the per-row translated-wire mark, and the note under the list.
 *
 * Neither is exotic. Both are "the two pickers disagree", which is exactly what a playground entry makes visible in
 * a second and source-reading makes invisible.
 *
 * ## What it owns
 *
 * D1.214 moved the menu CONTENT here and left the trigger in `FreeFormInput` ("a harness for the composer itself is
 * its own piece of work"). UB14.30 takes v0.15.1's boundary instead: the trigger, the tooltip and the
 * `DropdownMenu` root live here too, so the playground harness now covers the trigger as well. The composer keeps
 * the open state and passes it in (`open`/`onOpenChange`), because the compact picker shares it.
 *
 * Every value the menu reads is still a prop of its own name — `switchable` (the composer reads
 * `composerCapabilities.connection.switchable`), `reasoningLevels` (`composerCapabilities.reasoning.levels`) — so a
 * harness needs neither the capability context nor the composer.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, ChevronDown, Image as ImageIcon } from 'lucide-react'
// Subpaths, never the `@nessy-agent/ui` barrel: the barrel reaches pdfjs-dist's `?url` worker, which bun's test
// runner cannot load (`styled-dropdown.tsx` records the measurement), and this menu has a render test.
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@nessy-agent/ui/ui/tooltip'
import * as storage from '@/lib/local-storage'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuSub, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import { getModelShortName, type ModelDefinition } from '@config/models'
import {
  isCompatProvider,
  modelSupportsImages,
  type LlmConnectionWithStatus,
} from '@config/llm-connections'
import { type ThinkingLevel, getThinkingLevelNameKey } from '@nessy-agent/shared/agent/thinking-levels'
import { ModelListDisclosures } from './ModelListDisclosures'
import { ConnectionRow, type RuntimeSwitchPreviewAnswer } from './ConnectionRow'
import type { PickerMode } from './picker-mode'
import {
  formatTokenCount,
  isTranslatedWireSessionModel,
  modelCatalogueMark,
  offeredThinkingLevels,
  stripPiPrefixForDisplay,
} from './model-picker-helpers'
import { COMPOSER_CHIP } from './composer-styles'

const MENU_GROUP_LABEL = 'px-2 pt-2 pb-1 text-label-sm font-medium text-tertiary select-none'
const ITEM_NAME = 'text-label font-medium'
const ITEM_DESCRIPTION = 'text-label-sm text-tertiary'
/**
 * Bounded and wrapping: the menu is `w-fit whitespace-nowrap` (`StyledDropdownMenuContent`) and `white-space`
 * INHERITS, so one long catalogue description sets the width of the whole menu — a two-sentence Russian model blurb
 * stretched it past half the window (measured before D1.214; upstream's descriptions are short English and carry no
 * bound).
 */
const DESCRIPTION_BOUND = 'max-w-[380px] whitespace-normal'
/** Our per-row marks (DA2.25, D1.162): text, not colour, on the caption role. */
const ROW_MARK = 'text-caption font-normal text-tertiary'

export interface ComposerModelMenuProps {
  /** The composer owns the open state (the compact picker shares it). */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every configured connection, for the integration row above the list. */
  llmConnections: LlmConnectionWithStatus[]
  /** The connection this session resolved to, and whose models the list shows. */
  effectiveConnectionDetails: LlmConnectionWithStatus | null
  /** That connection's slug, passed back out on a model change. */
  effectiveConnection: string | undefined
  /** `ComposerCapabilities.connection.switchable` — the SERVER's answer. */
  switchable: boolean
  /**
   * `ComposerCapabilities.reasoning.levels` — the effort levels this session's runtime honours. Empty draws no
   * effort pill on the trigger and no effort sub-menu.
   */
  reasoningLevels: readonly ThinkingLevel[]
  /** The session has a transcript, so a switch is confirmed rather than silent. */
  isEmptySession: boolean
  /** A turn is in flight: the backend cannot be replaced under a running stream. */
  isProcessing: boolean
  /** The session's connection has been deleted. */
  connectionUnavailable: boolean
  /** How the MODEL list renders; `ModelListDisclosures` suppresses itself outside `flat`. */
  pickerMode: PickerMode
  /** Non-null only for a single-model compat connection the session is locked to. */
  connectionDefaultModel: string | null
  /** The list on screen — the SAME array the disclosure note reads. */
  availableModels: Array<ModelDefinition | string>
  currentModel: string
  /** The trigger's label: the full model name (gateway aliases resolved through the catalogue). */
  currentModelDisplayName: string
  thinkingLevel: ThinkingLevel
  thinkingDisabled: boolean
  contextStatus?: {
    isCompacting?: boolean
    inputTokens?: number
  }
  onModelChange: (model: string, connection?: string) => void
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  onConnectionChange?: (connectionSlug: string) => void
  onPreviewConnectionChange?: (connectionSlug: string) => Promise<RuntimeSwitchPreviewAnswer | null>
  /** The per-model image toggle, which is a host write and stays the composer's. */
  onToggleVision: (connectionSlug: string, modelId: string, enabled: boolean) => void
  /**
   * Open the integration row's target list on mount — the playground's "integration open" state (as
   * `ComposerModeChip.defaultOpen` is the mode menu's). The composer never passes it.
   */
  defaultIntegrationExpanded?: boolean
}

/** Per-model image-input toggle (pi_compat connections only). v0.15.1's, shared by both row kinds. */
function VisionToggle({ visionOn, onToggle }: { visionOn: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  const label = visionOn ? t('chat.modelPicker.supportsImagesOn') : t('chat.modelPicker.supportsImagesOff')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label={label}
          className="pointer-events-auto inline-flex cursor-pointer items-center justify-center rounded-sm p-1 opacity-100 hover:bg-fill-hover"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggle()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onToggle()
            }
          }}
        >
          <ImageIcon className={cn('size-3.5', visionOn ? 'text-foreground' : 'text-tertiary')} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ComposerModelMenu({
  open,
  onOpenChange,
  llmConnections,
  effectiveConnectionDetails,
  effectiveConnection,
  switchable,
  reasoningLevels,
  isEmptySession,
  isProcessing,
  connectionUnavailable,
  pickerMode,
  connectionDefaultModel,
  availableModels,
  currentModel,
  currentModelDisplayName,
  thinkingLevel,
  thinkingDisabled,
  contextStatus,
  onModelChange,
  onThinkingLevelChange,
  onConnectionChange,
  onPreviewConnectionChange,
  onToggleVision,
  defaultIntegrationExpanded,
}: ComposerModelMenuProps) {
  const { t } = useTranslation()
  const offeredLevels = offeredThinkingLevels(reasoningLevels)

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                COMPOSER_CHIP,
                // Truncates first when the toolbar runs out of room (the composer's right group)
                'shrink gap-1 pl-2.5 pr-2',
                // Tooltip and menu triggers share this node, so its data-state is the tooltip's
                open && 'bg-fill-hover text-foreground',
                connectionUnavailable && 'text-destructive hover:text-destructive',
              )}
            >
              {connectionUnavailable ? (
                <>
                  <AlertCircle className="size-3.5 shrink-0 text-destructive" />
                  {t('common.unavailable')}
                </>
              ) : (
                <>
                  {effectiveConnectionDetails && llmConnections.length > 1 && storage.get(storage.KEYS.showConnectionIcons, true) && <ConnectionIcon connection={effectiveConnectionDetails} size={14} showTooltip />}
                  <span className="min-w-0 truncate">{currentModelDisplayName}</span>
                  {/* The effort pill (codex wave 3.2): the level's own name (F1.1266), only where the runtime
                      offers effort levels at all, never for `off`. A quiet inner pill on the chip. */}
                  {offeredLevels.length > 0 && thinkingLevel && thinkingLevel !== 'off' && (
                    <span data-effort-pill className="shrink-0 rounded-xs bg-fill-hover px-1 text-caption text-secondary">
                      {t(getThinkingLevelNameKey(thinkingLevel))}
                    </span>
                  )}
                  {pickerMode !== 'locked-single' && <ChevronDown className="size-3.5 shrink-0" />}
                </>
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {t('common.model')}
        </TooltipContent>
      </Tooltip>
      <StyledDropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[260px]">
        {/* Integration — its own control, above the model list and never interleaved with it. The list below shows
            only the ACTIVE integration's models, so a model tap can no longer move the session and the
            confirmation attaches to this row alone. Upstream's provider → connection → model switcher (empty
            sessions only, no runtime switch) is NOT taken: this row is how a session moves between Pi, Claude and
            Codex. */}
        {onConnectionChange && (
          <ConnectionRow
            connections={llmConnections}
            activeConnection={effectiveConnectionDetails}
            switchable={switchable}
            hasHistory={!isEmptySession}
            busy={isProcessing}
            unavailable={connectionUnavailable}
            onSwitch={slug => {
              onConnectionChange(slug)
              onOpenChange(false)
            }}
            {...(onPreviewConnectionChange ? { onPreviewSwitch: onPreviewConnectionChange } : {})}
            {...(defaultIntegrationExpanded ? { defaultExpanded: true } : {})}
          />
        )}
        {/* Connection unavailable message */}
        {pickerMode === 'unavailable' ? (
          <div className="flex flex-col items-center justify-center px-4 py-6 text-center whitespace-normal">
            <AlertCircle className="mb-2 size-8 text-destructive" />
            <div className="mb-1 text-label font-medium">{t('chat.connectionUnavailable')}</div>
            <div className={ITEM_DESCRIPTION}>
              {t('chat.connectionUnavailableDescription')}
            </div>
          </div>
        ) : pickerMode === 'locked-single' && connectionDefaultModel ? (
          (() => {
            // Single-model pi_compat connection on a non-empty session (or
            // when there's only one connection, so no switcher to show).
            // Model row is disabled (locked to this session); vision toggle
            // remains interactive.
            const showVisionToggle =
              !!effectiveConnectionDetails && isCompatProvider(effectiveConnectionDetails.providerType)
            const visionOn = showVisionToggle && modelSupportsImages(effectiveConnectionDetails!, connectionDefaultModel)
            return (
              <StyledDropdownMenuItem
                disabled
                className="flex items-center justify-between py-1.5"
              >
                <div className="text-left">
                  <div className={ITEM_NAME}>{stripPiPrefixForDisplay(connectionDefaultModel)}</div>
                  <div className={ITEM_DESCRIPTION}>{t('chat.connectionDefault')}</div>
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-1">
                  {showVisionToggle && effectiveConnectionDetails && (
                    <VisionToggle
                      visionOn={visionOn}
                      onToggle={() => onToggleVision(effectiveConnectionDetails.slug, connectionDefaultModel, !visionOn)}
                    />
                  )}
                  <Check className="size-4 text-secondary" />
                </div>
              </StyledDropdownMenuItem>
            )
          })()
        ) : (
          /* Flat model list — the ACTIVE integration's models only. Upstream's "using <connection>" line above it
             is not drawn: the integration row says the same thing, in the same panel, and also names the runtime. */
          <>
            {availableModels.map((model) => {
              const modelId = typeof model === 'string' ? model : model.id
              const modelName = typeof model === 'string'
                ? stripPiPrefixForDisplay(getModelShortName(model))
                : (model.name ?? stripPiPrefixForDisplay(model.id))
              const isSelected = currentModel === modelId
              const descriptionKey = typeof model !== 'string' && 'descriptionKey' in model ? (model.descriptionKey as string) : undefined
              const description = descriptionKey ? t(descriptionKey) : (typeof model !== 'string' && 'description' in model ? (model.description as string) : '')
              const showVisionToggle =
                !!effectiveConnectionDetails && isCompatProvider(effectiveConnectionDetails.providerType)
              const visionOn = showVisionToggle && modelSupportsImages(effectiveConnectionDetails!, modelId)
              // DA2.25 — the per-row half of the translated-wire disclosure. It cannot move into
              // `ModelListDisclosures` with the note below: the mark belongs INSIDE the model row, one per row, and
              // that component renders once under the whole list. Read off the model entry itself, because one
              // `claude-runtime` connection holds both wires and the router decides per REQUEST from the model's
              // own `wire`.
              const translatedWire = isTranslatedWireSessionModel(effectiveConnectionDetails, model)
              const catalogueMark = modelCatalogueMark(model)
              return (
                <StyledDropdownMenuItem
                  key={modelId}
                  onSelect={() => onModelChange(modelId, effectiveConnection)}
                  className="flex cursor-pointer items-center justify-between py-1.5"
                >
                  <div className="text-left">
                    <div className={ITEM_NAME}>{modelName}</div>
                    {description && (
                      <div className={cn(DESCRIPTION_BOUND, ITEM_DESCRIPTION)}>{description}</div>
                    )}
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-1">
                    {/* Text, not colour, and the same shape the compact picker and the BYO form's model chip use —
                        the three surfaces state one fact and should read as one system (P6.454). D1.162 — the
                        provenance label PER ENTRY, beside the per-list sentence under the list. `null` for a model
                        the catalogue listed AND for one nobody asked about, which are different facts and neither
                        is "missing". */}
                    {catalogueMark === 'unlisted' && (
                      <span
                        data-testid="model-catalogue-unlisted"
                        className={ROW_MARK}
                        title={t('chat.modelPicker.catalogueUnlistedTitle')}
                      >
                        {t('chat.modelPicker.catalogueUnlistedMark')}
                      </span>
                    )}
                    {translatedWire && (
                      <span
                        data-testid="model-translated-mark"
                        className={ROW_MARK}
                      >
                        {t('onboarding.byoRuntime.modelsTranslatedMark')}
                      </span>
                    )}
                    {showVisionToggle && effectiveConnectionDetails && (
                      <VisionToggle
                        visionOn={visionOn}
                        onToggle={() => onToggleVision(effectiveConnectionDetails.slug, modelId, !visionOn)}
                      />
                    )}
                    {isSelected && (
                      <Check className="size-4 text-secondary" />
                    )}
                  </div>
                </StyledDropdownMenuItem>
              )
            })}
          </>
        )}

        {/* C3.346's provenance line and DA2.6's disclosure line, under the list and above the effort control — the
            same block the compact picker renders, from the same module.

            DA2.23: this picker rendered NEITHER until 2026-09-17, and RS-44 measured it on the packaged 1.39.0 — at
            1400 px both lines were absent while at 700 px the compact picker showed both for the same card in the
            same minute. Shared rather than copied: see `ModelListDisclosures`, which also owns the `flat`-only
            suppression, which is why nothing here repeats it. */}
        <ModelListDisclosures
          pickerMode={pickerMode}
          connection={effectiveConnectionDetails}
          currentModel={currentModel}
          models={availableModels}
          variant="menu"
        />

        {/* Effort — only the levels this runtime honours (`reasoningLevels`); none offered, no sub-menu. */}
        {offeredLevels.length > 0 && (
          <>
            <StyledDropdownMenuSeparator className="my-1" />

            <DropdownMenuSub>
              <StyledDropdownMenuSubTrigger disabled={thinkingDisabled} className={cn('flex items-center justify-between py-1.5', thinkingDisabled && 'cursor-not-allowed')}>
                <div className="flex-1 text-left">
                  <div className={cn(ITEM_NAME, thinkingDisabled && 'text-disabled')}>{t(getThinkingLevelNameKey(thinkingLevel))}</div>
                  <div className={cn(ITEM_DESCRIPTION, thinkingDisabled && 'text-disabled')}>{thinkingDisabled ? t('thinking.notSupported') : t('thinking.extendedDesc')}</div>
                </div>
              </StyledDropdownMenuSubTrigger>
              <StyledDropdownMenuSubContent className="min-w-[220px]">
                {offeredLevels.map(({ id, nameKey, descriptionKey }) => {
                  const isSelected = thinkingLevel === id
                  return (
                    <StyledDropdownMenuItem
                      key={id}
                      onSelect={() => onThinkingLevelChange?.(id)}
                      className="flex cursor-pointer items-center justify-between py-1.5"
                    >
                      <div className="text-left">
                        <div className={ITEM_NAME}>{t(nameKey)}</div>
                        {/* Same bound as the model row above — see DESCRIPTION_BOUND. */}
                        <div className={cn(DESCRIPTION_BOUND, ITEM_DESCRIPTION)}>{t(descriptionKey)}</div>
                      </div>
                      {isSelected && (
                        <Check className="ml-3 size-4 shrink-0 text-secondary" />
                      )}
                    </StyledDropdownMenuItem>
                  )
                })}
              </StyledDropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        {/* Context usage footer - only when we have token data */}
        {contextStatus?.inputTokens != null && contextStatus.inputTokens > 0 && (
          <>
            <StyledDropdownMenuSeparator className="my-1" />
            <div className="px-2 py-1.5 select-none">
              <div className="flex items-center justify-between gap-3 text-label-sm text-tertiary">
                <span>{t('chat.context')}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-right tabular-nums">
                  {contextStatus.isCompacting && (
                    <Spinner className="h-3 w-3 shrink-0" />
                  )}
                  <span>{t('chat.tokensUsed', { displayCount: formatTokenCount(contextStatus.inputTokens) })}</span>
                </span>
              </div>
            </div>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
