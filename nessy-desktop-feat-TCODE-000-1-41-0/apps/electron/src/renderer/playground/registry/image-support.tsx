import * as React from 'react'
import { Check, Image as ImageIcon } from 'lucide-react'
import type { ComponentEntry } from './types'
import { ImageSupportWarningBanner } from '@/components/app-shell/input/ImageSupportWarningBanner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@nessy-agent/ui'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

// ============================================================================
// Pre-flight banner — pure visual demo of the warning shown above
// AttachmentPreview when the active model is text-only on a pi_compat
// connection. The banner is dumb: parent decides when to show it. These
// variants render it directly to verify copy and layout.
// ============================================================================

function BannerDemo({
  modelName,
  offerEnable = true,
  onClickEnable,
  refusalSentence,
}: {
  modelName: string
  /**
   * Whether the per-model override is on offer.
   *
   * The live rule is `resolveStagedImagePolicy`'s
   * `OVERRIDE_WRITING_PROVIDER_TYPES` — `pi_compat` AND `claude-runtime` — and
   * this comment does not restate it, because restating it is how the two
   * drifted. It said "false on the adapter runtimes: flipping `supportsImages`
   * there would clear the warning without changing what reaches the model",
   * which P3.136 measured false for `claude-runtime`: a vision-capable BYO
   * upstream could not turn image input on, on a reason that had stopped being
   * true. `codex-runtime` is the runtime the sentence is still right about, and
   * it is right for a different reason (its images ride codex's own path).
   */
  offerEnable?: boolean
  onClickEnable?: () => void
  /**
   * P6.584 — the endpoint's own refusal sentence, present only when the flag
   * was LEARNED. Empty renders the banner exactly as it was before the row.
   */
  refusalSentence?: string
}) {
  const [enabled, setEnabled] = React.useState(false)
  return (
    <div className="w-full max-w-[640px] mx-auto p-6">
      <div className="rounded-2xl border border-border/50 shadow-middle bg-background/40 backdrop-blur-sm">
        {!enabled && (
          <ImageSupportWarningBanner
            modelName={modelName}
            {...(offerEnable
              ? {
                  onEnable: () => {
                    setEnabled(true)
                    onClickEnable?.()
                  },
                }
              : {})}
            {...(refusalSentence ? { refusalSentence } : {})}
          />
        )}
        <div className="px-4 py-6 text-foreground/40 text-sm">
          {enabled
            ? 'Image support enabled — banner dismissed.'
            : 'Imagine the chat input here. Banner sits above any staged attachments.'}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Per-model picker row — renders the same JSX shape as the chat-input model
// picker uses. Variants cover the gate (pi_compat vs not), and the toggle
// states (vision-on, vision-off, currently selected).
// ============================================================================

interface PickerRowProps {
  modelName: string
  isSelected: boolean
  showVisionToggle: boolean
  visionOn: boolean
}

function PickerRow({
  modelName,
  isSelected,
  showVisionToggle,
  visionOn: initialVisionOn,
}: PickerRowProps) {
  const { t } = useTranslation()
  const [visionOn, setVisionOn] = React.useState(initialVisionOn)
  return (
    <div className="w-[260px] mx-auto rounded-md bg-background/80 border border-border/50 px-1 py-1">
      <div className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer hover:bg-foreground/5">
        <div className="text-left">
          <div className="font-medium text-sm">{modelName}</div>
        </div>
        <div className="flex items-center gap-1 ml-3 shrink-0">
          {showVisionToggle && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={visionOn
                    ? t('chat.modelPicker.supportsImagesOn')
                    : t('chat.modelPicker.supportsImagesOff')}
                  className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setVisionOn(v => !v)
                  }}
                >
                  <ImageIcon className={cn(
                    'h-3.5 w-3.5',
                    visionOn ? 'text-foreground/70' : 'text-foreground/30',
                  )} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {visionOn
                  ? t('chat.modelPicker.supportsImagesOn')
                  : t('chat.modelPicker.supportsImagesOff')}
              </TooltipContent>
            </Tooltip>
          )}
          {isSelected && (
            <Check className="h-3 w-3 text-foreground" />
          )}
        </div>
      </div>
    </div>
  )
}

export const imageSupportComponents: ComponentEntry[] = [
  {
    id: 'image-support-banner',
    name: 'Image Support — Pre-flight Banner',
    category: 'Chat Inputs',
    description:
      'Inline warning rendered above the chat input when the staged images cannot reach the active runtime (ComposerCapabilities.attachments.images === "no"). The one-click override rides along on the provider types whose catalog the user can write — pi_compat and claude-runtime (P3.136) — and the send is blocked either way.',
    component: BannerDemo,
    layout: 'centered',
    props: [
      {
        name: 'modelName',
        description: 'Display name of the active text-only model',
        control: { type: 'string' },
        defaultValue: 'qwen3-coder',
      },
      {
        name: 'offerEnable',
        description: 'true for pi_compat and claude-runtime; false where the per-model override cannot change what reaches the model (P3.136)',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'refusalSentence',
        description: 'P6.584: the endpoint\'s own sentence, quoted only when this model\'s "no images" was LEARNED from a refused turn rather than declared or defaulted',
        control: { type: 'string' },
        defaultValue: '',
      },
    ],
    variants: [
      {
        name: 'Default',
        description: 'Generic text-only custom-endpoint model with images staged',
        props: { modelName: 'qwen3-coder', offerEnable: true },
      },
      {
        name: 'Long model name',
        description: 'Verifies wrapping behaviour for long names',
        props: { modelName: 'minimax-text-01-very-long-id-no-images-here', offerEnable: true },
      },
      {
        name: 'Override on offer — claude-runtime',
        description: 'P3.136: a BYO claude-runtime model whose upstream can see images. The override writes the connection catalogue the same way pi_compat does, so the one-click fix is offered here too — this state was drawn as "no action" until the reason for withholding it was measured dead.',
        props: { modelName: 'claude-gw-model-a', offerEnable: true },
      },
      {
        name: 'Learned refusal — the endpoint\'s sentence quoted',
        description: 'P6.584: the model was never declared text-only; the flag was written from the gateway\'s own named 400 at the turn-error seam. The banner quotes the sentence it matched, so a wrong match is visible to the user rather than inferred from a silent boolean, and the same one-click override un-learns it.',
        props: {
          modelName: 'tgpt/qwen35-397b-a17b-fp8',
          offerEnable: true,
          refusalSentence: 'Invalid Chat Message Part: Model Does Not Support Image Inputs',
        },
      },
      {
        name: 'No override on offer',
        description: 'codex-runtime / nestor-cloud-agent — warning only, no action to fix it. codex is deliberately outside the override set: its images ride codex\'s own path, so writing supportsImages would clear the warning without changing what reaches the model.',
        props: { modelName: 'gpt-5.1-codex', offerEnable: false },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'image-support-picker-row',
    name: 'Image Support — Picker Row',
    category: 'Chat Inputs',
    description:
      'A single chat-input model picker row with the per-model image-support toggle. The icon is gated to pi_compat connections (`isCompatProvider`) — built-in providers (anthropic / pi) hide it because their catalogs are SDK-owned. NOTE, and it is a real asymmetry rather than a drafting choice: the BANNER above offers the same write on claude-runtime as well since P3.136, and this row does not. Two entry points to one override, on two different provider sets. Recorded here so the difference is visible on a screen rather than only in two predicates.',
    component: PickerRow,
    layout: 'centered',
    props: [
      {
        name: 'modelName',
        control: { type: 'string' },
        defaultValue: 'qwen3-coder',
      },
      {
        name: 'isSelected',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'showVisionToggle',
        description: 'true for pi_compat (custom endpoints), false for built-in providers',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'visionOn',
        description: 'Per-model supportsImages override resolution',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'pi_compat — text-only (default)',
        description: 'Toggle visible, dim icon — image support disabled',
        props: { modelName: 'qwen3-coder', isSelected: false, showVisionToggle: true, visionOn: false },
      },
      {
        name: 'pi_compat — vision-on',
        description: 'Toggle visible, bright icon — per-model override true',
        props: { modelName: 'minimax-vision', isSelected: false, showVisionToggle: true, visionOn: true },
      },
      {
        name: 'pi_compat — selected, vision-on',
        description: 'Both Check and bright icon visible',
        props: { modelName: 'minimax-vision', isSelected: true, showVisionToggle: true, visionOn: true },
      },
      {
        name: 'Built-in provider (no toggle)',
        description: 'Anthropic or pi — no toggle rendered',
        props: { modelName: 'claude-haiku-4-5', isSelected: true, showVisionToggle: false, visionOn: false },
      },
    ],
    mockData: () => ({}),
  },
]
