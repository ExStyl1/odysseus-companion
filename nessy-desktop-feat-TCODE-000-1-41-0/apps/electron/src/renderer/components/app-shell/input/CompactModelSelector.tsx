/**
 * UB14.30 — v0.15.1's `CompactModelSelector` look over our content (merge; upstream
 * `v0.15.1:apps/electron/src/renderer/components/app-shell/input/CompactModelSelector.tsx`, Apache-2.0). Taken: the
 * `COMPOSER_CHIP` trigger with the `Cpu` glyph standing in for the name under a 26rem panel, the destructive tint
 * when unavailable, the 44px `SHEET_ROW` rows and `SHEET_SECTION` labels, `bg-fill-selected`/`hover`/`pressed`,
 * `size-4 text-secondary` checks, the `size-9` vision toggle. Ours kept: the integration row (`ConnectionRow`,
 * runtime switching), `ModelListDisclosures`, the per-row translated and catalogue marks, the ultracode toggle (QK5),
 * the effort levels THIS runtime honours (`offeredThinkingLevels`, the same answer the desktop `ComposerModelMenu`
 * reads), our context line.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Image as ImageIcon,
} from 'lucide-react'
// The subpath, not the `@nessy-agent/ui` barrel (pdfjs-dist's `?url` worker; see `styled-dropdown.tsx`).
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerClose,
} from '@/components/ui/drawer'
import { cn } from '@/lib/utils'
import * as storage from '@/lib/local-storage'
import { navigate, routes } from '@/lib/navigate'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import {
  ANTHROPIC_MODELS,
  getModelDisplayName,
  getModelShortName,
} from '@config/models'
import {
  isCompatProvider,
  modelSupportsImages,
  resolveEffectiveConnectionSlug,
  type LlmConnectionWithStatus,
} from '@config/llm-connections'
import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels'
import {
  ULTRACODE_UNAVAILABLE_REASON_KEYS,
  ultracodeControlAvailability,
} from '@nessy-agent/shared/agent/ultracode-mode'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import { derivePickerMode } from './picker-mode'
import { ModelListDisclosures } from './ModelListDisclosures'
import { isTranslatedWireSessionModel, modelCatalogueMark } from './model-picker-helpers'
import { ConnectionRow, type RuntimeSwitchPreviewAnswer } from './ConnectionRow'
import { useComposerCapabilities } from './composer-capabilities-context'
import {
  formatTokenCount,
  offeredThinkingLevels,
  stripPiPrefixForDisplay,
} from './model-picker-helpers'
import { useModelVisionToggle } from './useModelVisionToggle'
import { COMPOSER_CHIP } from './composer-styles'

// Bottom-sheet rows (spec §7.16): 44px touch rows, 15px names, tertiary details.
// shrink-0: the list is height-capped (scrolls), so rows must never compress below their content
// Rows and section labels sit on the sheet title's 16px edge: 8px container inset + 8px padding.
const SHEET_ROW = 'flex min-h-row-touch w-full shrink-0 items-center rounded-md px-2 py-2 text-left transition-colors hover:duration-instant'
const SHEET_SECTION = 'px-2 pt-4 pb-1 text-label-sm font-medium text-tertiary select-none'
/** Our per-row marks (DA2.25, D1.162): text, not colour, on the caption role — the desktop menu's recipe. */
const ROW_MARK = 'text-caption font-normal text-tertiary'

interface CompactModelSelectorProps {
  currentModel: string
  currentConnection?: string
  onModelChange: (model: string, connection?: string) => void
  onConnectionChange?: (connectionSlug: string) => void
  /**
   * Read-only pre-switch carry answer; see `ConnectionRow.onPreviewSwitch`.
   *
   * P3.266 widened this from the bare plan to the plan AND its reason. It is one
   * object rather than two values because `planHistoryCarry` decides them
   * together, and a prop that could carry one without the other is a prop in
   * which the modal can explain a promise it is not making.
   */
  onPreviewConnectionChange?: (connectionSlug: string) => Promise<RuntimeSwitchPreviewAnswer | null>
  thinkingLevel?: ThinkingLevel
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  /**
   * QK5 — the session's ultracode toggle.
   *
   * Beside the effort control because that is where the runtime puts it
   * (`model-config.md#adjust-effort-level`: "The `/effort` menu also offers
   * `ultracode`"), and NOT a sixth member of `THINKING_LEVELS` because the same
   * page says "Ultracode is a Claude Code setting rather than a model effort
   * level" — three recorded decisions in this fork say the same, and the level
   * vocabulary stays six.
   */
  ultracode?: boolean
  onUltracodeChange?: (enabled: boolean) => void
  isEmptySession?: boolean
  connectionUnavailable?: boolean
  /** A turn is in flight — the integration row explains why it cannot move. */
  isProcessing?: boolean
  contextStatus?: {
    isCompacting?: boolean
    inputTokens?: number
    contextWindow?: number
  }
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function CompactModelSelector({
  currentModel,
  currentConnection,
  onModelChange,
  onConnectionChange,
  onPreviewConnectionChange,
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  ultracode = false,
  onUltracodeChange,
  isEmptySession = false,
  connectionUnavailable = false,
  isProcessing = false,
  contextStatus,
  open: controlledOpen,
  onOpenChange,
}: CompactModelSelectorProps) {
  const { t } = useTranslation()
  const composerCapabilities = useComposerCapabilities()
  const [internalOpen, setInternalOpen] = React.useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = React.useCallback((nextOpen: boolean) => {
    if (onOpenChange) onOpenChange(nextOpen)
    else setInternalOpen(nextOpen)
  }, [onOpenChange])

  const appShellCtx = useOptionalAppShellContext()
  const llmConnections = appShellCtx?.llmConnections ?? []
  const workspaceDefaultConnection = appShellCtx?.workspaceDefaultLlmConnection

  const toggleVision = useModelVisionToggle()

  const effectiveConnection = resolveEffectiveConnectionSlug(
    currentConnection,
    workspaceDefaultConnection,
    llmConnections,
  )

  const effectiveConnectionDetails = React.useMemo(() => {
    if (!effectiveConnection) return null
    return llmConnections.find(c => c.slug === effectiveConnection) ?? null
  }, [llmConnections, effectiveConnection])

  const connectionDefaultModel = React.useMemo(() => {
    const conn = effectiveConnectionDetails
    if (!conn) return null
    if (!isCompatProvider(conn.providerType)) return null
    if (conn.models && conn.models.length > 1) return null
    return conn.defaultModel ?? null
  }, [effectiveConnectionDetails])

  const pickerMode = derivePickerMode({
    connectionUnavailable,
    connectionDefaultModel,
  })

  const availableModels = React.useMemo(() => {
    if (connectionUnavailable) return []
    if (!effectiveConnectionDetails) return ANTHROPIC_MODELS
    return effectiveConnectionDetails.models || ANTHROPIC_MODELS
  }, [effectiveConnectionDetails, connectionUnavailable])

  // C3.346's provenance line and DA2.6's disclosure line are rendered by
  // `ModelListDisclosures` below, which is where their classification, their
  // copy and their suppression rule now live — see that module for why they are
  // shared with the desktop picker rather than owned here (DA2.23).

  const currentModelDisplayName = React.useMemo(() => {
    const modelToDisplay = connectionDefaultModel ?? currentModel
    const model = availableModels.find(m =>
      typeof m === 'string' ? m === modelToDisplay : m.id === modelToDisplay,
    )
    if (!model) return stripPiPrefixForDisplay(getModelDisplayName(modelToDisplay))
    if (typeof model === 'string') return stripPiPrefixForDisplay(model)
    return model.name ?? stripPiPrefixForDisplay(model.id)
  }, [availableModels, currentModel, connectionDefaultModel])

  const thinkingDisabled = React.useMemo(() => {
    const model = availableModels.find(
      m => typeof m !== 'string' && m.id === currentModel,
    )
    return typeof model !== 'string' && model?.supportsThinking === false
  }, [availableModels, currentModel])

  // UB14.30 — the levels this runtime honours, from the capability answer (the desktop menu asks the same function).
  const offeredLevels = offeredThinkingLevels(composerCapabilities.reasoning.levels)

  /**
   * QK5 — what this session's runtime can do with the toggle.
   *
   * `undefined` means an older server that reports no answer, and then NO row is
   * drawn: absence must not be read as "unsupported", which is a real answer the
   * capability carries by name.
   *
   * The verdict itself comes from the shared resolver
   * (`agent/ultracode-mode.ts`), not from a copy of its ordering spelled here —
   * on codex the reason has to be the RUNTIME one, never "turn workflows on",
   * and that ordering is the thing worth having in exactly one place. The
   * workflows-off condition is the host's and arrives as a transcript notice
   * when the toggle is switched on, because it is resolved from three settings
   * layers the renderer cannot see.
   */
  const ultracodeState = React.useMemo(() => {
    const capability = composerCapabilities.ultracode
    if (!capability) return null
    return ultracodeControlAvailability(capability)
  }, [composerCapabilities.ultracode])

  const showConnectionIcon =
    !!effectiveConnectionDetails &&
    llmConnections.length > 1 &&
    storage.get(storage.KEYS.showConnectionIcons, true)

  const handlePickFlatModel = React.useCallback(
    (modelId: string) => {
      onModelChange(modelId, effectiveConnection)
      setOpen(false)
    },
    [onModelChange, effectiveConnection, setOpen],
  )

  // The integration row is the ONLY control that can move a session, so this
  // is the only place a connection change starts. The model list below never
  // carries a slug that is not the active one.
  const handleSwitchConnection = React.useCallback(
    (connectionSlug: string) => {
      onConnectionChange?.(connectionSlug)
      setOpen(false)
    },
    [onConnectionChange, setOpen],
  )

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          aria-label={connectionUnavailable
            ? t('common.unavailable')
            : `${t('common.model')}: ${currentModelDisplayName}`}
          className={cn(
            COMPOSER_CHIP,
            'min-w-7 shrink gap-1 pl-2.5 pr-2 @max-[26rem]/panel:px-2',
            connectionUnavailable && 'bg-destructive-tint text-destructive hover:bg-destructive-tint hover:text-destructive',
          )}
        >
          {connectionUnavailable ? (
            <>
              <AlertCircle className="size-3.5 shrink-0 text-destructive" />
              <span className="min-w-0 truncate">{t('common.unavailable')}</span>
            </>
          ) : (
            <>
              {showConnectionIcon && effectiveConnectionDetails && (
                <ConnectionIcon connection={effectiveConnectionDetails} size={14} />
              )}
              {/* A model glyph is clearer than an unreadable one-letter ellipsis. The full
                  model name remains the accessible name and the sheet's selected row. */}
              <Cpu className="size-4 shrink-0 @min-[26rem]/panel:hidden" aria-hidden />
              <span className="truncate min-w-0 @max-[26rem]/panel:hidden">{currentModelDisplayName}</span>
              {pickerMode !== 'locked-single' && (
                <ChevronDown className="size-3.5 shrink-0 @max-[26rem]/panel:hidden" />
              )}
            </>
          )}
        </button>
      </DrawerTrigger>

      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('common.model')}</DrawerTitle>
        </DrawerHeader>

        <div className="px-2 pb-4 flex flex-col gap-0.5 max-h-[55vh] overflow-y-auto">
          {/* === Integration section === */}
          {onConnectionChange && (
            <ConnectionRow
              connections={llmConnections}
              activeConnection={effectiveConnectionDetails}
              switchable={composerCapabilities.connection.switchable}
              hasHistory={!isEmptySession}
              busy={isProcessing}
              unavailable={connectionUnavailable}
              onSwitch={handleSwitchConnection}
              {...(onPreviewConnectionChange ? { onPreviewSwitch: onPreviewConnectionChange } : {})}
            />
          )}

          {/* === Models section — the ACTIVE integration's models, only === */}
          {pickerMode === 'unavailable' ? (
            <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
              <AlertCircle className="size-8 text-destructive mb-2" />
              <div className="text-copy font-medium mb-1">
                {t('chat.connectionUnavailable')}
              </div>
              <div className="text-label text-tertiary mb-3">
                {t('chat.connectionUnavailableDescription')}
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  navigate(routes.view.settings('ai'))
                }}
                className="min-h-control text-label text-accent underline underline-offset-2"
              >
                {t('chat.modelPicker.openAiSettings')}
              </button>
            </div>
          ) : pickerMode === 'locked-single' && connectionDefaultModel ? (
            <LockedSingleRow
              modelId={connectionDefaultModel}
              connection={effectiveConnectionDetails}
              onToggleVision={toggleVision}
            />
          ) : (
            // 'flat' — list models of the active connection
            availableModels.map(model => {
              const modelId = typeof model === 'string' ? model : model.id
              const modelName = typeof model === 'string'
                ? stripPiPrefixForDisplay(getModelShortName(model))
                : (model.name ?? stripPiPrefixForDisplay(model.id))
              const isSelected = currentModel === modelId
              const descriptionKey =
                typeof model !== 'string' && 'descriptionKey' in model
                  ? (model.descriptionKey as string)
                  : undefined
              const description = descriptionKey
                ? t(descriptionKey)
                : (typeof model !== 'string' && 'description' in model
                    ? (model.description as string)
                    : '')
              // P6.454 — one `claude-runtime` connection holds BOTH wires and the
              // router decides per request, so the cost of the translated one
              // belongs beside the model, not only on the setup form.
              const translatedWire = isTranslatedWireSessionModel(
                effectiveConnectionDetails,
                typeof model === 'string' ? model : model,
              )
              const catalogueMark = modelCatalogueMark(model)
              const showVision =
                !!effectiveConnectionDetails &&
                isCompatProvider(effectiveConnectionDetails.providerType)
              const visionOn =
                showVision && modelSupportsImages(effectiveConnectionDetails!, modelId)
              return (
                <DrawerClose asChild key={modelId}>
                  <button
                    type="button"
                    onClick={() => handlePickFlatModel(modelId)}
                    className={cn(
                      SHEET_ROW,
                      'justify-between',
                      isSelected ? 'bg-fill-selected' : 'hover:bg-fill-hover active:bg-fill-pressed',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="text-copy font-medium truncate">{modelName}</div>
                      {description && (
                        <div className="text-label text-tertiary truncate">
                          {description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 ml-3 shrink-0">
                      {/* Text, not colour, and the SAME shape the BYO form's
                          model chip uses — the two surfaces state one fact and
                          should read as one system. */}
                      {/* D1.162 — the provenance label PER ENTRY, beside the per-list
                          sentence under the list. `null` for a model the
                          catalogue listed AND for one nobody asked about, which
                          are different facts and neither is "missing". */}
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
                      {showVision && effectiveConnectionDetails && (
                        <VisionToggle
                          visionOn={visionOn}
                          onToggle={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            toggleVision(
                              effectiveConnectionDetails.slug,
                              modelId,
                              !visionOn,
                            )
                          }}
                        />
                      )}
                      {isSelected && (
                        <Check className="size-4 text-secondary" />
                      )}
                    </div>
                  </button>
                </DrawerClose>
              )
            })
          )}

          {/* C3.346's provenance line, DA2.6's disclosure line and — since
              DA2.25 — the translated-wire note that used to be written out
              here, one block rendered by the DESKTOP picker too. The note moved
              for the reason the other two did (DA2.23): it was list-level copy
              that only one of the two pickers had, so the same card said
              different things at two widths of the same window. The `flat`-only
              suppression is the component's own, which is why nothing here
              repeats it. */}
          <ModelListDisclosures
            pickerMode={pickerMode}
            connection={effectiveConnectionDetails}
            currentModel={currentModel}
            models={availableModels}
            variant="drawer"
          />

          {/* === Thinking section === — the levels this runtime honours (UB14.30), and the ultracode toggle, which
              is drawn on its own answer even where no level is offered. */}
          {(offeredLevels.length > 0 || ultracodeState) && pickerMode !== 'unavailable' && (
            <>
              <div className={SHEET_SECTION}>
                {t('chat.modelPicker.thinkingSection')}
              </div>
              {offeredLevels.map(({ id, nameKey, descriptionKey }) => {
                const isSelected = thinkingLevel === id
                return (
                  <DrawerClose asChild key={id}>
                    <button
                      type="button"
                      disabled={thinkingDisabled}
                      onClick={() => onThinkingLevelChange?.(id)}
                      className={cn(
                        SHEET_ROW,
                        'justify-between',
                        thinkingDisabled && 'cursor-not-allowed text-disabled',
                        !thinkingDisabled && isSelected && 'bg-fill-selected',
                        !thinkingDisabled && !isSelected && 'hover:bg-fill-hover active:bg-fill-pressed',
                      )}
                    >
                      <div className="min-w-0">
                        <div className="text-copy font-medium">{t(nameKey)}</div>
                        <div className={cn('text-label', thinkingDisabled ? 'text-disabled' : 'text-tertiary')}>
                          {t(descriptionKey)}
                        </div>
                      </div>
                      {isSelected && (
                        <Check className="size-4 text-secondary shrink-0 ml-3" />
                      )}
                    </button>
                  </DrawerClose>
                )
              })}
              {/*
                QK5 — the ultracode toggle, last in the effort section because it
                is a setting ON TOP of an effort level rather than one of them
                (`model-config.md#adjust-effort-level`: "Ultracode is a Claude
                Code setting rather than a model effort level"). It is drawn even
                where it cannot be used, with the reason: on codex the honest
                answer is "this runtime has no ultracode mode", and a withheld
                row says nothing at all — the SILENT-LOOSER shape the ledger
                names visible degradation as the cure for.
              */}
              {ultracodeState && (
                <button
                  type="button"
                  data-testid="ultracode-toggle"
                  role="switch"
                  aria-checked={ultracodeState.available && ultracode}
                  disabled={!ultracodeState.available}
                  onClick={() => {
                    if (!ultracodeState.available) return
                    onUltracodeChange?.(!ultracode)
                  }}
                  className={cn(
                    SHEET_ROW,
                    'justify-between',
                    !ultracodeState.available && 'cursor-not-allowed text-disabled',
                    ultracodeState.available && ultracode && 'bg-fill-selected',
                    ultracodeState.available && !ultracode && 'hover:bg-fill-hover active:bg-fill-pressed',
                  )}
                >
                  <div className="min-w-0">
                    <div className="text-copy font-medium">{t('chat.ultracode.label')}</div>
                    <div className={cn('text-label', ultracodeState.available ? 'text-tertiary' : 'text-disabled')}>
                      {ultracodeState.available
                        ? t('chat.ultracode.description')
                        : t(ULTRACODE_UNAVAILABLE_REASON_KEYS[ultracodeState.reason])}
                    </div>
                  </div>
                  {ultracodeState.available && ultracode && (
                    <Check className="size-4 text-secondary shrink-0 ml-3" />
                  )}
                </button>
              )}
            </>
          )}

          {/* === Context section === */}
          {contextStatus?.inputTokens != null && contextStatus.inputTokens > 0 && (
            <>
              <div className={SHEET_SECTION}>
                {t('chat.modelPicker.contextSection')}
              </div>
              <div className="flex items-center justify-between gap-3 px-2 py-2 text-label text-tertiary tabular-nums select-none">
                <span>{t('chat.context')}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-right">
                  {contextStatus.isCompacting && <Spinner className="h-3 w-3 shrink-0" />}
                  {t('chat.tokensUsed', {
                    displayCount: formatTokenCount(contextStatus.inputTokens),
                  })}
                </span>
              </div>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function LockedSingleRow({
  modelId,
  connection,
  onToggleVision,
}: {
  modelId: string
  connection: LlmConnectionWithStatus | null
  onToggleVision: (connectionSlug: string, modelId: string, enabled: boolean) => Promise<void>
}) {
  const { t } = useTranslation()
  const showVision = !!connection && isCompatProvider(connection.providerType)
  const visionOn = !!(showVision && connection && modelSupportsImages(connection, modelId))
  return (
    <div className={cn(SHEET_ROW, 'justify-between select-none')}>
      <div className="min-w-0">
        <div className="text-copy font-medium truncate">{stripPiPrefixForDisplay(modelId)}</div>
        <div className="text-label text-tertiary">{t('chat.connectionDefault')}</div>
      </div>
      <div className="flex items-center gap-1 ml-3 shrink-0">
        {showVision && connection && (
          <VisionToggle
            visionOn={visionOn}
            onToggle={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleVision(connection.slug, modelId, !visionOn)
            }}
          />
        )}
        <Check className="size-4 text-secondary" />
      </div>
    </div>
  )
}

function VisionToggle({
  visionOn,
  onToggle,
}: {
  visionOn: boolean
  onToggle: (e: React.MouseEvent | React.KeyboardEvent) => void
}) {
  const { t } = useTranslation()
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={visionOn
        ? t('chat.modelPicker.supportsImagesOn')
        : t('chat.modelPicker.supportsImagesOff')}
      className="inline-flex size-9 items-center justify-center rounded-md cursor-pointer hover:bg-fill-hover"
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onToggle(e)
      }}
    >
      <ImageIcon
        className={cn(
          'size-4',
          visionOn ? 'text-foreground' : 'text-tertiary',
        )}
      />
    </span>
  )
}
