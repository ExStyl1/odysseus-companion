import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Key, Monitor, Server } from "lucide-react"
import { NessySymbol } from "@/components/icons/NessySymbol"
import { ClaudeIcon, OpenAiIcon } from "@/components/icons/runtime"
import { StepFormLayout } from "./primitives"
import { isProviderCardOffered, type ProviderCardFlags, type ProviderChoice } from "./provider-card-flags"

/**
 * The high-level provider choice the user makes on first launch.
 * This maps to one or more ApiSetupMethods downstream. `nessy` is the Pi-agent
 * gateway card; `nessy_cloud` is the native Nestor A2A cloud-agent card;
 * `nessy_codex` is the Codex-agent gateway card and `nessy_claude` the Claude
 * Code one (each rendered only when its runtime feature flag is on).
 *
 * `nessy_claude` and `claude` are different products: `claude` is the Pro/Max
 * SUBSCRIPTION card (api.anthropic.com, browser OAuth), `nessy_claude` is the
 * Claude Agent SDK pointed at the internal gateway.
 *
 * `custom_runtime` is the BYO endpoint form for those same two runtimes (C3):
 * the Codex or Claude Code harness pointed at the user's own OpenAI-compatible
 * endpoint and key instead of the gateway. It has no flag of its own — it is
 * offered whenever at least one runtime is in the build, and the form itself
 * offers only the runtimes that are.
 *
 * `chatgpt` and `chatgpt_codex` are the two ChatGPT-subscription cards: the
 * first runs on Pi (`openai-codex`), the second (F1.202) on the codex runtime
 * itself, signed in through codex's own external-auth login. Both ride the
 * one `chatgpt` flag — see `provider-card-flags.ts`, which owns the union and
 * the rule.
 */
export type { ProviderChoice }

interface ProviderOption {
  id: ProviderChoice
  name: string
  description: string
  icon: React.ReactNode
}

/**
 * Runtime identity beats uniform branding: the two gateway cards that run a
 * foreign harness wear that harness's mark, so a glance tells them apart from
 * the Pi-agent and cloud-agent cards, which stay Nessy.
 *
 * UB14.37 (v0.15.1 sizes): marks at 24 px, line icons at 24 px with a 2 px inset
 * and a 1.75 stroke. v0.15.1 draws its marks through `ProviderMark` (a CSS mask in
 * `currentColor`, so a black logo cannot vanish on a dark surface); ours are
 * already `currentColor` SVG components (`icons/runtime/*Icon.tsx`), which give
 * the same guarantee, so `ProviderMark.tsx` is not added (R6-08, HAVE). The
 * Nessy cards keep the accent.
 */
const PROVIDER_ICONS: Record<ProviderChoice, React.ReactNode> = {
  nessy: <NessySymbol className="size-6 text-accent" />,
  nessy_cloud: <NessySymbol className="size-6 text-accent" />,
  nessy_codex: <OpenAiIcon className="size-6" />,
  nessy_claude: <ClaudeIcon className="size-6" />,
  claude: <ClaudeIcon className="size-6" />,
  chatgpt: <OpenAiIcon className="size-6" />,
  chatgpt_codex: <OpenAiIcon className="size-6" />,
  api_key: <Key className="size-6 p-0.5" strokeWidth={1.75} />,
  local: <Monitor className="size-6 p-0.5" strokeWidth={1.75} />,
  custom_runtime: <Server className="size-6 p-0.5" strokeWidth={1.75} />,
}

/**
 * Which cards to show before the main-process provider flags resolve. Mirrors
 * PROVIDER_FLAG_DEFAULTS in packages/shared/src/feature-flags.ts (default build:
 * Nestor-via-Pi, native Nestor cloud agent + custom endpoint). Seeding the
 * default-on set avoids a flash of opt-in cards that then disappear once
 * getProviderFlags() returns. Keyed by FLAG id, not by card: the two derived
 * cards (`custom_runtime`, `chatgpt_codex`) are answered by the rule.
 */
const DEFAULT_PROVIDER_FLAGS: ProviderCardFlags = {
  nessy: true,
  nessy_cloud: true,
  api_key: true,
  local: false,
  claude: false,
  chatgpt: false,
  nessy_codex: false,
  nessy_claude: false,
}

interface ProviderSelectStepProps {
  /** Called when the user selects a provider */
  onSelect: (choice: ProviderChoice) => void
  /** Called when the user chooses to skip setup */
  onSkip?: () => void
}

/**
 * ProviderSelectStep — First screen after install.
 *
 * Welcomes the user and asks them to pick their subscription / auth method.
 * Selecting a card immediately advances to the next step.
 */
export function ProviderSelectStep({ onSelect, onSkip }: ProviderSelectStepProps) {
  const { t } = useTranslation()

  // Provider cards are gated by build-time provider flags, read from the main
  // process (dev: NESSY_FEATURE_PROVIDER_* / NESSY_FEATURE_CODEX_RUNTIME).
  const [flags, setFlags] = useState<ProviderCardFlags>(DEFAULT_PROVIDER_FLAGS)
  useEffect(() => {
    let cancelled = false
    window.electronAPI.getProviderFlags?.()
      .then((resolved) => { if (!cancelled && resolved) setFlags((prev) => ({ ...prev, ...resolved })) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const PROVIDER_OPTIONS: ProviderOption[] = ([
    {
      id: 'nessy',
      name: t("onboarding.providerSelect.nessyPi"),
      description: t("onboarding.providerSelect.nessyPiDesc"),
      icon: PROVIDER_ICONS.nessy,
    },
    {
      id: 'nessy_cloud',
      name: t("onboarding.providerSelect.nessyCloud"),
      description: t("onboarding.providerSelect.nessyCloudDesc"),
      icon: PROVIDER_ICONS.nessy_cloud,
    },
    {
      id: 'nessy_codex',
      name: t("onboarding.providerSelect.nessyCodex"),
      description: t("onboarding.providerSelect.nessyCodexDesc"),
      icon: PROVIDER_ICONS.nessy_codex,
    },
    {
      id: 'nessy_claude',
      name: t("onboarding.providerSelect.nessyClaude"),
      description: t("onboarding.providerSelect.nessyClaudeDesc"),
      icon: PROVIDER_ICONS.nessy_claude,
    },
    {
      id: 'claude',
      name: t("onboarding.providerSelect.claudeProMax"),
      description: t("onboarding.providerSelect.claudeProMaxDesc"),
      icon: PROVIDER_ICONS.claude,
    },
    {
      id: 'chatgpt',
      name: t("onboarding.providerSelect.codexChatGPT"),
      description: t("onboarding.providerSelect.codexChatGPTDesc"),
      icon: PROVIDER_ICONS.chatgpt,
    },
    {
      id: 'chatgpt_codex',
      name: t("onboarding.providerSelect.codexRuntimeChatGPT"),
      description: t("onboarding.providerSelect.codexRuntimeChatGPTDesc"),
      icon: PROVIDER_ICONS.chatgpt_codex,
    },
    // ONE card where there were two. The `api_key` card ("I use other
    // provider") is gone: its form and this one merged, so offering both would
    // be two doors onto the same room — and the one it led to could not express
    // the runtime arms at all.
    {
      id: 'custom_runtime',
      name: t("onboarding.providerSelect.customRuntime"),
      description: t("onboarding.providerSelect.customRuntimeDesc"),
      icon: PROVIDER_ICONS.custom_runtime,
    },
    {
      id: 'local',
      name: t("onboarding.providerSelect.localModel"),
      description: t("onboarding.providerSelect.localModelDesc"),
      icon: PROVIDER_ICONS.local,
    },
    // `custom_runtime` has no flag of its own: it is the merged personal-key
    // form, so it appears iff ANY of its three arms shipped. The formula gained
    // `api_key` when the Pi arm moved in — without it, a build with the two
    // runtime flags off would hide the only remaining way to enter a personal
    // key, which is the shape that used to be the `api_key` card's whole job.
    // That formula and F1.202's `chatgpt_codex` live in ONE rule now.
  ] satisfies ProviderOption[]).filter((option) => isProviderCardOffered(option.id, flags))

  return (
    <StepFormLayout
      iconElement={<NessySymbol className="h-7 text-accent" />}
      title={t("onboarding.providerSelect.title")}
      description={t("onboarding.providerSelect.description")}
    >
      {/* Provider tiles (v0.15.1, mockup .prov-opt): hairline ring, mark in the text color, name + one-line
          description. Choosing one still advances immediately. */}
      <div className="flex flex-col gap-1.5">
        {PROVIDER_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onSelect(option.id)}
            className={cn(
              "motion-press flex w-full min-h-[52px] items-center gap-3 rounded-md px-3 py-2 text-left",
              "ring-1 ring-inset ring-border hover:bg-fill-hover active:bg-fill-pressed",
            )}
          >
            <span className="flex size-6 shrink-0 items-center justify-center text-foreground">
              {option.icon}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-label font-medium text-foreground">{option.name}</span>
              {/* ONE LINE, GUARANTEED. The copy is written to fit, but a
                  translation is not something this component can control — and
                  a card that wraps to two lines breaks the column's rhythm
                  against its neighbours. `truncate` makes the guarantee
                  structural; `title` keeps the full text reachable, including
                  for a screen reader. UB14.37: shown at every width now, as
                  v0.15.1 does (it was `hidden sm:block`). */}
              <span
                className="block truncate text-label-sm text-secondary"
                title={option.description}
              >
                {option.description}
              </span>
            </span>
          </button>
        ))}
      </div>

      {onSkip && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={onSkip}
            className="min-h-6 text-label text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent"
          >
            {t("onboarding.providerSelect.setupLater")}
          </button>
        </div>
      )}
    </StepFormLayout>
  )
}
