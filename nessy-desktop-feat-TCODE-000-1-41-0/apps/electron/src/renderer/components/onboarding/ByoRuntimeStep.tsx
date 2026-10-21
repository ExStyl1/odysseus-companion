/**
 * ByoRuntimeStep — the ONE personal-key form (E4, presentation v2 in G2).
 *
 * It began as the BYO endpoint form for the two adapter runtimes (C3) and now
 * carries the Pi arm as well, replacing the separate api_key card. Three arms,
 * one form: Pi, Claude Code, Codex.
 *
 * V2 IS A PRESENTATION CHANGE, NOT A PROTOCOL ONE (owner review 2026-08-14).
 * The runtime radio chooses the HARNESS and nothing else; every other control
 * that used to restructure the form is gone from the UI while its state, its
 * submit shape and its tests survive untouched:
 *
 * - the endpoint is hardcoded and hidden (see `resolveEndpointField` — the one
 *   place that decides, including the disabled-on-foreign-URL edit case);
 * - the preset radio is gone, `preset` stays as state: 'custom' on create,
 *   whatever the connection is on edit. The official Anthropic/OpenAI paths
 *   become unreachable from CREATE and keep working on EDIT;
 * - the protocol radio is gone, pinned `openai-completions` on create —
 *   llm-proxy serves every entitled model over chat-completions and translates
 *   no protocols, so an Anthropic-protocol choice against it could only break
 *   (G3 makes the Anthropic wire a per-MODEL fact instead of a per-connection
 *   one, which is where it belonged);
 * - the dialect radio is gone; `initialValues.dialect` still threads through
 *   the submit, so a connection someone forced to 'qwen' survives a re-save;
 * - the sync toggle is gone: create always stamps, edit never withdraws.
 *
 * The catalog is now PROBED rather than guessed at: after Fetch the whole
 * catalog is probed in chunks and the list regroups into available / unavailable
 * as verdicts arrive. Nothing about that blocks the form.
 *
 * Reached from the "Use your own key or endpoint" provider card (creation) and
 * from the settings Edit button (`resolveConnectionEditTarget`). The Edit path
 * locks the arm — changing a live connection's providerType is a different
 * operation than editing it, and the SETUP handler has no path for it.
 *
 * THE LANDMINE THIS FORM SITS ON: the SETUP handler rewrites any payload
 * carrying `customEndpoint` to providerType `pi_compat`
 * (`handlers/rpc/llm-connections.ts`). That is CORRECT for the Pi/Custom arm and
 * FATAL for the runtime arms, whose local adapters would go unused. So the
 * protocol control exists only on Pi/Custom, and the two submit shapes are
 * assembled by two different builders — never one spread with a conditional
 * field.
 *
 * Every decision lives in `apisetup/byo-runtime.ts`; this file is fields,
 * labels and the submit call.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, X } from "lucide-react"
import type { ModelDefinition, CustomEndpointApi } from "@nessy-agent/shared/config"
import type { ModelProbeResult } from "@nessy-agent/shared/protocol"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import { ModelCatalogPicker } from "@/components/apisetup/ModelCatalogPicker"
import {
  BYO_RUNTIME_ERROR_KEY,
  isGatewayHostNonGatewayEndpoint,
  isLoopbackBaseUrl,
  isMaskedCredential,
  isTranslatedWireModel,
  parseModelList,
  resolveArmVerdicts,
  resolveEndpointField,
  usesOfficialPiEndpoint,
  validateMergedEndpointForm,
  type ArmProbe,
  type ByoRuntimeProviderType,
  type MergedEndpointArm,
  type PiEndpointPreset,
} from "@/components/apisetup/byo-runtime"

/**
 * What the form hands its host, discriminated by arm.
 *
 * A union rather than one object with optional fields, because the Pi arm and
 * the runtime arms produce genuinely different payloads downstream — the Pi arm
 * goes through the existing `pi_api_key` pipeline (which may emit a
 * `customEndpoint`), the runtime arms through `buildByoRuntimeSetup` (which
 * never may). Collapsing them into one shape is how the two get spread together
 * by accident.
 */
export type ByoRuntimeSubmitData =
  | {
      arm: ByoRuntimeProviderType
      providerType: ByoRuntimeProviderType
      baseUrl: string
      apiKey: string
      models: string[]
      miniModel?: string
      modelsSyncedAt?: number | null
      /** What the form already knows about the picked models — see byo-runtime. */
      modelMeta?: Record<string, { contextWindow?: number; wire?: 'anthropic-messages' }>
    }
  | {
      arm: 'pi'
      preset: PiEndpointPreset
      /** Pi/Custom only — the field that makes the server pick `pi_compat`. */
      customApi?: CustomEndpointApi
      /** Forced dialect (E6). Omitted when Auto. */
      dialect?: 'qwen'
      baseUrl: string
      apiKey: string
      models: string[]
      miniModel?: string
      modelsSyncedAt?: number | null
      /** Same map as the runtime arm's — the Pi delegation promotes with it. */
      modelMeta?: Record<string, { contextWindow?: number; wire?: 'anthropic-messages' }>
    }

export interface ByoRuntimeInitialValues {
  baseUrl?: string
  apiKey?: string
  /** Comma-separated model ids, already joined. */
  models?: string
  preset?: PiEndpointPreset
  customApi?: CustomEndpointApi
  dialect?: 'qwen'
  miniModel?: string
  /**
   * Enrollment prefill (E2). No longer read: the sync toggle is gone and create
   * always stamps. Kept on the interface because the callers still derive and
   * pass it, and because reopening the control is a UI change if the value is
   * still here — deleting it would make that a plumbing change again.
   */
  syncModelsFromEndpoint?: boolean
}

interface ByoRuntimeStepProps {
  /** Fixed arm (Edit path). When set, the arm selector is not offered. */
  lockedArm?: MergedEndpointArm
  initialValues?: ByoRuntimeInitialValues
  /** Editing an existing connection — a blank key keeps the stored one. */
  isEditing?: boolean
  /**
   * Slug of the connection being edited. Sent to the catalog RPC so the STORED
   * credential can be resolved server-side: the key field holds the mask on this
   * path, and the mask is not a credential. Absent on create.
   */
  editingSlug?: string | null
  onSubmit: (data: ByoRuntimeSubmitData) => void
  onBack: () => void
  status?: 'idle' | 'validating' | 'success' | 'error'
  errorMessage?: string
}


/**
 * Radix Select has no empty-string value — `''` is how it spells "nothing
 * selected", so an option carrying it never renders. The blank slot needs a
 * sentinel, mapped back to `''` at the boundary.
 */
const MINI_MODEL_AUTO = '__auto__'

const ARM_LABEL: Record<MergedEndpointArm, string> = {
  'pi': 'onboarding.byoRuntime.armPi',
  'claude-runtime': 'onboarding.byoRuntime.runtimeClaude',
  'codex-runtime': 'onboarding.byoRuntime.runtimeCodex',
}

export function ByoRuntimeStep({
  lockedArm,
  initialValues,
  isEditing = false,
  editingSlug,
  onSubmit,
  onBack,
  status = 'idle',
  errorMessage,
}: ByoRuntimeStepProps) {
  const { t } = useTranslation()

  // Which arms this build ships. Same source as the provider cards (build-time
  // flags, read from main) so the form never offers an arm whose backend was
  // not bundled. Optimistic default: the card that leads here is gated on these
  // same flags through the same IPC, so a failure here means the IPC is
  // unavailable (playground / stale preload) rather than that everything is
  // off — narrowing to nothing would render a form that cannot be submitted.
  const [flags, setFlags] = useState({ pi: true, codex: true, claude: true })
  useEffect(() => {
    let cancelled = false
    window.electronAPI?.getProviderFlags?.()
      ?.then((resolved) => {
        if (cancelled || !resolved) return
        setFlags({
          pi: !!resolved.api_key,
          codex: !!resolved.nessy_codex,
          claude: !!resolved.nessy_claude,
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const availableArms = useMemo<MergedEndpointArm[]>(() => {
    if (lockedArm) return [lockedArm]
    const enabled: MergedEndpointArm[] = [
      ...(flags.pi ? (['pi'] as const) : []),
      ...(flags.claude ? (['claude-runtime'] as const) : []),
      ...(flags.codex ? (['codex-runtime'] as const) : []),
    ]
    // Unreachable in a real build (the card sits behind the same flags); if it
    // happens, offer everything rather than a dead form.
    return enabled.length > 0 ? enabled : ['pi', 'claude-runtime', 'codex-runtime']
  }, [lockedArm, flags])

  const [arm, setArm] = useState<MergedEndpointArm>(lockedArm ?? 'pi')
  // Settle on an arm this build actually offers once the flags land.
  useEffect(() => {
    if (lockedArm) return
    if (!availableArms.includes(arm)) setArm(availableArms[0]!)
  }, [availableArms, lockedArm, arm])

  // CREATE pins both; EDIT round-trips whatever the connection already is. No
  // control writes either one in v2, so they are plain derived values — a
  // useState with an unused setter would only invite one back in by accident.
  const preset: PiEndpointPreset = initialValues?.preset ?? 'custom'
  const customApi: CustomEndpointApi = initialValues?.customApi ?? 'openai-completions'
  const [apiKey, setApiKey] = useState(initialValues?.apiKey ?? '')
  const [models, setModels] = useState(initialValues?.models ?? '')
  // Both are hidden state in v2: no control writes them, and both still decide
  // what the submit looks like. `dialect` in particular is why the E6 escape
  // hatch survives a re-save.
  const dialect: 'auto' | 'qwen' = initialValues?.dialect ?? 'auto'
  const [miniModel, setMiniModel] = useState(initialValues?.miniModel ?? '')
  /**
   * Which model is the default — held as an ID, not as a POSITION.
   *
   * The first version moved the clicked chip to the front, because the front is
   * what the wire reads. The owner rejected that on sight: «выбраная дефолтная
   * модель визуально скачет на первое место что сбивает с толку». So the chips
   * keep their selection order on screen and the badge moves instead; the lift
   * to `models[0]` happens once, at submit.
   *
   * Falls back to the first selected model whenever the marked one is not in
   * the list — which is what happens the moment its chip is removed.
   */
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null)
  /**
   * Where the utility-model select renders its list.
   *
   * Radix portals `SelectContent` to `document.body` by default, and this form
   * lives inside the fullscreen overlay — which is exactly the shape
   * `AddWorkspaceStep_ConnectRemote` already solved with a container ref. In
   * the playground, with no overlay, the select opens fine with 17 options; in
   * the app the owner could not open it at all. Rendering the list INSIDE the
   * form removes the question entirely rather than reasoning about z-index and
   * focus scopes.
   */
  const selectPortalRef = useRef<HTMLDivElement>(null)
  const [fieldError, setFieldError] = useState<{ field: string; key: string } | null>(null)

  const [catalog, setCatalog] = useState<ModelDefinition[] | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  // Keyed by id, verdict AND wire — the wire is what G3 persists and routes on,
  // and it is also what makes availability arm-dependent.
  const [probes, setProbes] = useState<Record<string, ArmProbe>>({})
  const [probeProgress, setProbeProgress] = useState<{ done: number; total: number } | null>(null)

  const isDisabled = status === 'validating'
  const official = usesOfficialPiEndpoint({ arm, preset })
  // The endpoint is a DERIVED value in v2, never form state — there is no
  // control that writes it, and the one edit case that shows it shows it
  // disabled. Deriving it means the submit and the field can never disagree.
  const endpoint = resolveEndpointField({ arm, preset, isEditing, storedBaseUrl: initialValues?.baseUrl })
  const baseUrl = endpoint.value
  /**
   * The protocol this connection actually speaks. Only the Pi/Custom arm may
   * choose: `UpstreamTarget` is `{nestor, openai-compatible}` and nothing else,
   * so the runtime arms are pinned — that is an adapter fact, not a UX choice.
   */
  const effectiveApi: CustomEndpointApi = arm === 'pi' && preset === 'custom'
    ? customApi
    : 'openai-completions'
  // The catalog RPC needs only a base URL and a key, so every arm that speaks
  // openai-completions gets it — including the runtime arms.
  const catalogAvailable = !official && effectiveApi === 'openai-completions'
  /**
   * The key the CATALOG RPC can actually use, which is not the same as "the key
   * field is non-empty".
   *
   * On the Edit path the field holds the MASK — `GET_API_KEY` masks for every
   * caller — and that mask is not a credential: it is a statement that one is
   * stored. This RPC takes an explicit key and has no slug, so there is no
   * stored-credential path for it to fall back on.
   *
   * Sending the mask anyway is not merely useless, it is a crash: the bullet
   * character is U+2022 and the request dies at header encoding with
   * `Cannot convert argument to a ByteString because the character at index 14
   * has a value of 8226` — measured live 2026-08-14 against the operator's own
   * llm-proxy connection. So the buttons are disabled with a reason instead.
   */
  const catalogKey = isMaskedCredential(apiKey) ? '' : apiKey.trim()
  // On EDIT the slug stands in for the key: the server resolves the stored
  // credential itself, so the mask never has to travel and the user never has
  // to retype a key they already gave us.
  const catalogKeyMissing = !catalogKey && !editingSlug && !isLoopbackBaseUrl(baseUrl)
  const selectedModelIds = useMemo(() => parseModelList(models), [models])
  // Availability is per ARM once two wires exist: an anthropic-wire model is
  // reachable from the Claude runtime and from nowhere else here.
  const armVerdicts = useMemo(() => resolveArmVerdicts(probes, arm), [probes, arm])
  const effectiveDefaultModel = defaultModelId && selectedModelIds.includes(defaultModelId)
    ? defaultModelId
    : selectedModelIds[0]
  // P6.454 — the cost sentence appears only once something carries it. A note
  // about a wire nobody in this selection is on would be advice, not a label.
  const hasTranslatedWireModel = useMemo(
    () => selectedModelIds.some(id => isTranslatedWireModel(probes[id], arm)),
    [selectedModelIds, probes, arm],
  )

  /**
   * Probe generation. Every fetch starts a new one and unmount ends the current
   * one; a chunk whose generation is stale drops its results on the floor
   * instead of writing them into a list they no longer describe.
   */
  const probeRun = useRef(0)
  useEffect(() => () => { probeRun.current += 1 }, [])

  /**
   * Probe the WHOLE catalog, in chunks, without blocking anything.
   *
   * CHUNKED BECAUSE THE HANDLER'S `Promise.all` IS UNBOUNDED: handing it 386
   * ids opens 386 sockets at once and the endpoint throttles itself into a wall
   * of 429s, which the probe would then report as "unavailable". Chunks are
   * sequential; each one publishes its verdicts as it lands, so the list fills
   * in progressively and the user can select an already-verified model while
   * the rest is still going.
   */
  const probeCatalog = useCallback(async (ids: string[]) => {
    const generation = ++probeRun.current
    setProbes({})
    setProbeProgress({ done: 0, total: ids.length })
    const CHUNK = 8
    for (let offset = 0; offset < ids.length; offset += CHUNK) {
      if (probeRun.current !== generation) return
      const chunk = ids.slice(offset, offset + CHUNK)
      try {
        const result = await window.electronAPI.testLlmConnectionSetup({
          provider: 'anthropic',
          apiKey: catalogKey,
          ...(editingSlug ? { slug: editingSlug } : {}),
          baseUrl: baseUrl.trim(),
          customEndpoint: { api: 'openai-completions' },
          validateModels: chunk,
        })
        if (probeRun.current !== generation) return
        const landed: Record<string, ArmProbe> = {}
        for (const probe of result.modelProbes ?? []) {
          landed[probe.id] = { verdict: probe.verdict, ...(probe.wire ? { wire: probe.wire } : {}) }
        }
        setProbes(current => ({ ...current, ...landed }))
      } catch {
        // A failed chunk leaves its ids unprobed rather than marking them
        // unavailable — the probe failing says nothing about the models.
      }
      setProbeProgress({ done: Math.min(offset + CHUNK, ids.length), total: ids.length })
    }
  }, [catalogKey, editingSlug, baseUrl])

  const handleFetchCatalog = useCallback(async () => {
    setCatalogLoading(true)
    setCatalogError(null)
    try {
      const result = await window.electronAPI.testLlmConnectionSetup({
        provider: 'anthropic',
        apiKey: catalogKey,
        ...(editingSlug ? { slug: editingSlug } : {}),
        baseUrl: baseUrl.trim(),
        customEndpoint: { api: 'openai-completions' },
        fetchModels: true,
      })
      if (!result.success) {
        setCatalogError(result.error ?? t('apiSetup.modelCatalog.fetchFailed'))
        return
      }
      const fetched = result.models ?? []
      // The catalog is on screen BEFORE the first probe request goes out.
      setCatalog(fetched)
      setCatalogLoading(false)
      void probeCatalog(fetched.map(model => model.id))
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : String(error))
    } finally {
      setCatalogLoading(false)
    }
  }, [catalogKey, editingSlug, baseUrl, t, probeCatalog])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const result = validateMergedEndpointForm(
      { arm, preset, baseUrl, apiKey, models, miniModel },
      { isEditing },
    )
    if (!result.valid) {
      setFieldError({ field: result.field, key: BYO_RUNTIME_ERROR_KEY[result.error] })
      return
    }
    setFieldError(null)
    // THE LIFT, and the only place it happens: the marked default becomes
    // `models[0]`, which is what the server turns into `defaultModel`. Doing it
    // here rather than on every click is what lets the chips stay still.
    const orderedModels = effectiveDefaultModel
      ? [effectiveDefaultModel, ...result.models.filter(id => id !== effectiveDefaultModel)]
      : result.models
    const shared = {
      baseUrl: result.baseUrl,
      apiKey: result.apiKey,
      models: orderedModels,
      ...(result.miniModel !== undefined || miniModel.trim() === '' ? { miniModel: result.miniModel ?? '' } : {}),
      // WHAT THE FORM ALREADY KNOWS, carried into the payload rather than
      // re-fetched later: the window it displayed for each picked model, plus
      // the probe's wire on the claude arm. See `modelMeta` for the race this
      // closes.
      ...(catalog
        ? {
            modelMeta: Object.fromEntries(
              result.models
                .map(id => {
                  const row = catalog.find(model => model.id === id)
                  const known = {
                    ...(row?.contextWindow ? { contextWindow: row.contextWindow } : {}),
                    ...(arm === 'claude-runtime' && probes[id]?.wire === 'anthropic-messages'
                      ? { wire: 'anthropic-messages' as const }
                      : {}),
                  }
                  return [id, known] as const
                })
                .filter(([, known]) => Object.keys(known).length > 0),
            ),
          }
        : {}),
      // ALWAYS-ON SYNC (owner: «это не нужно юзеру мы это должны и так делать»).
      // Create stamps; edit omits, which under the tristate means "leave what is
      // persisted". Stated because it is a real consequence, not an oversight:
      // an existing UNSTAMPED connection is never enrolled by editing it.
      ...(isEditing ? {} : { modelsSyncedAt: Date.now() }),
    }
    // TWO SHAPES, ASSEMBLED SEPARATELY — never one spread with a conditional
    // `customEndpoint`. That field is what makes the server rewrite the
    // connection to `pi_compat`: required on Pi/Custom, fatal on a runtime arm.
    if (arm === 'pi') {
      onSubmit({
        arm: 'pi',
        preset,
        ...(preset === 'custom' ? { customApi } : {}),
        // Omitted on Auto, so an existing connection's payload is unchanged and
        // the per-model detection keeps deciding.
        ...(preset === 'custom' && dialect === 'qwen' ? { dialect: 'qwen' as const } : {}),
        ...shared,
      })
      return
    }
    onSubmit({ arm, providerType: arm, ...shared })
  }

  const title = lockedArm === 'claude-runtime'
    ? t("onboarding.byoRuntime.titleClaude")
    : lockedArm === 'codex-runtime'
      ? t("onboarding.byoRuntime.titleCodex")
      : t("onboarding.byoRuntime.title")

  // UB14.40 (R6-11) — the fields are the v0.15.1 `Input` itself (`field-surface`: the sunken well, the
  // hairline, the focus tint), no longer wrapped in v0.14's tinted, shadowed box. A field the
  // validator refused says so through `aria-invalid`, which `.field-surface[aria-invalid="true"]` draws as
  // the destructive hairline — the same attribute a screen reader announces.
  //
  // The runtime radio is v0.15.1 APISetupStep's `ProviderSegmentedControl` segment, taken 1:1 (track
  // `bg-fill-hover p-0.5`, the selected segment floating on `shadow-elev-1`); our `role="radio"` /
  // `aria-checked` stay (upstream's segments carry neither).
  const segmented = (active: boolean) => cn(
    "flex-1 h-control px-3 text-label font-medium rounded-sm transition-[background-color,color,box-shadow] duration-micro ease-out-subtle",
    active ? "bg-floating shadow-elev-1 text-foreground" : "text-secondary hover:text-foreground",
  )

  return (
    <StepFormLayout
      title={title}
      description={t("onboarding.byoRuntime.description")}
      // NO className, DELIBERATELY: the form keeps `StepFormLayout`'s own
      // max width at all times (`max-w-[440px]` since UB14.37, v0.15.1's
      // paper card; `max-w-[28rem]` before).
      //
      // E4 grew the dialog to `max-w-3xl` when the catalog arrived and measured
      // that growth as the feature. The owner REVERSED it — «ширину формы нужно
      // оставить изначальную как была, что бы она не расширялась» — so the
      // original width is the constant and the form never expands. The catalog
      // lives inside it: its length is carried by the picker's own scroller
      // (the viewport cap fixed in G1(b)), not by making the dialog wider.
      actions={
        <>
          <BackButton onClick={onBack} disabled={isDisabled} />
          <ContinueButton
            type="submit"
            form="byo-runtime-form"
            loading={status === 'validating'}
            loadingText={t("onboarding.byoRuntime.connecting")}
          />
        </>
      }
    >
      <form id="byo-runtime-form" onSubmit={handleSubmit} className="space-y-6">
        {/* Arm — only when this build offers a choice and the Edit path has not
            locked one. */}
        {availableArms.length > 1 && (
          <div className="space-y-2">
            <Label>{t("onboarding.byoRuntime.runtime")}</Label>
            <div className="flex rounded-md bg-fill-hover p-0.5" role="radiogroup" aria-label={t("onboarding.byoRuntime.runtime")}>
              {availableArms.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={arm === candidate}
                  disabled={isDisabled}
                  onClick={() => { setArm(candidate); setFieldError(null) }}
                  className={segmented(arm === candidate)}
                >
                  {t(ARM_LABEL[candidate])}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Endpoint — v2 hides it. It appears only for an EDIT of a connection
            that points somewhere other than the hardcoded URL, and there it is
            read-only: visible so the user knows where this connection goes,
            disabled because this form cannot express a change to it. */}
        {endpoint.visible && (
          <div className="space-y-2">
            <Label htmlFor="byo-base-url">{t("onboarding.byoRuntime.endpoint")}</Label>
            <Input
              id="byo-base-url"
              type="text"
              value={baseUrl}
              readOnly
              disabled
            />
            <p className="text-label-sm text-tertiary">{t("onboarding.byoRuntime.endpointLocked")}</p>
            {/* DA1.28 — a stored endpoint on the GATEWAY HOST that is not a
                gateway endpoint gets DA1.11's sentence here too. Since DA1.10
                the interceptor rewrites the Bearer to `Nestor-Token` only on
                the two NAMED endpoints, so such a connection is a plain BYO one
                carrying the user's own key — and this form shows the URL
                read-only with no way to ask why. Same detector and same key as
                the API-key form (`components/apisetup/ApiKeyInput.tsx`), so the
                two surfaces cannot say different things about one URL. */}
            {isGatewayHostNonGatewayEndpoint(baseUrl) && (
              <p className="text-label-sm text-tertiary">{t('apiSetup.gatewayHostNotGatewayUrl')}</p>
            )}
          </div>
        )}

        {/* API key */}
        <div className="space-y-2">
          <Label htmlFor="byo-api-key">{t("onboarding.byoRuntime.apiKey")}</Label>
          <Input
            id="byo-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setFieldError(null) }}
            placeholder={t("onboarding.byoRuntime.apiKeyPlaceholder")}
            aria-invalid={fieldError?.field === 'apiKey' || undefined}
            disabled={isDisabled}
          />
          {fieldError?.field === 'apiKey' && (
            <p className="text-label-sm text-destructive">{t(fieldError.key)}</p>
          )}
          <p className="text-label-sm text-tertiary">
            {isEditing
              ? t("onboarding.byoRuntime.apiKeyHelperEditing")
              : t("onboarding.byoRuntime.apiKeyHelper")}
          </p>
        </div>

        {/* Models — THE TYPED FIELD, now the FALLBACK and nothing else.
            It shows only where no catalog can ever be fetched — an
            anthropic-messages endpoint publishes no usable `/models` — because
            there, typing is the only way to change the list at all. Everywhere
            else, on create AND on edit, the chips and the picker are the route
            («модели там не кнопками а в инпуте» — the edit path used to show
            this input even when the catalog was one click away).
            Still hidden entirely on the official presets, where the server
            installs the provider catalog itself. */}
        {!official && !catalogAvailable && (
          <div className="space-y-2">
            <Label htmlFor="byo-models">
              {t("onboarding.byoRuntime.models")}{' '}
              <span className="text-tertiary">· {t("onboarding.byoRuntime.required")}</span>
            </Label>
            <Input
              id="byo-models"
              type="text"
              value={models}
              onChange={(e) => { setModels(e.target.value); setFieldError(null) }}
              placeholder={t("onboarding.byoRuntime.modelsPlaceholder")}
              aria-invalid={fieldError?.field === 'models' || undefined}
              disabled={isDisabled}
            />
            {fieldError?.field === 'models' && (
              <p className="text-label-sm text-destructive">{t(fieldError.key)}</p>
            )}
            <p className="text-label-sm text-tertiary">{t("onboarding.byoRuntime.modelsHelper")}</p>
          </div>
        )}

        {/* The selection, as chips. Shown on CREATE and on any EDIT whose
            connection could have a catalog — and on edit they render the STORED
            models from mount, before any fetch, because seeing what a
            connection carries should not require re-fetching it.
            The ORDER is the selection order and the FIRST one is the default —
            `models[0]` at the wire, which is why the first chip is marked
            rather than merely listed first. */}
        {!official && catalogAvailable && (
          <div className="space-y-2">
            <Label>
              {t("onboarding.byoRuntime.models")}{' '}
              <span className="text-tertiary">· {t("onboarding.byoRuntime.required")}</span>
            </Label>
            {selectedModelIds.length === 0 ? (
              <p className="text-label-sm text-tertiary">{t("onboarding.byoRuntime.modelsNoneSelected")}</p>
            ) : (
              // ONE ROW THAT SCROLLS, never a wrapping block: seventeen picked
              // models wrapped to ten rows and moved every control below them.
              // The row owns its overflow so the page never gains a horizontal
              // scrollbar, and the trailing mask says it can be scrolled.
              <div className="mask-fade-right -mx-0.5 overflow-x-auto px-0.5 pb-1">
                <div className="flex w-max flex-nowrap gap-1.5">
                  {selectedModelIds.map((id) => (
                    // A chip is a PAIR of buttons, not a button containing one:
                    // nesting them is invalid HTML and the inner one stops
                    // being reachable. The label sets the default, the × drops
                    // the model — and the × matters most on the edit path,
                    // where a stored selection has to be editable before any
                    // catalog has been fetched.
                    <span
                      key={id}
                      // UB14.40 — v0.15.1's segment vocabulary: the default
                      // chip is the raised one (`bg-raised shadow-elev-1`, the
                      // selected segment's lift), the rest sit on the neutral
                      // fill with secondary ink (SessionItem's neutral badge).
                      className={cn(
                        "inline-flex shrink-0 items-center rounded-md text-label-sm transition-colors duration-micro ease-out-subtle",
                        id === effectiveDefaultModel ? "bg-raised text-foreground shadow-elev-1" : "bg-fill-hover text-secondary",
                      )}
                    >
                      <button
                        type="button"
                        // CLICK MARKS THE DEFAULT, IN PLACE. Nothing moves on
                        // screen — the lift to `models[0]` happens at submit,
                        // so the wire contract is unchanged and the row does
                        // not reshuffle under the cursor.
                        onClick={() => { setDefaultModelId(id); setFieldError(null) }}
                        disabled={isDisabled}
                        aria-label={id === effectiveDefaultModel
                          ? t("onboarding.byoRuntime.modelsChipDefaultAria", { model: id })
                          : t("onboarding.byoRuntime.modelsChipAria", { model: id })}
                        // The app-wide focus ring, drawn INSIDE the chip
                        // (`-outline-offset-2`, EntityRow's own) so the row's
                        // overflow scroller cannot clip it.
                        className={cn(
                          "rounded-l-md py-1 pl-2 pr-1 -outline-offset-2",
                          id === effectiveDefaultModel ? "" : "hover:bg-fill-pressed hover:text-foreground",
                        )}
                      >
                        {id}
                        {/* Text, not colour alone — the marker has to survive a
                            monochrome or high-contrast rendering. */}
                        {id === effectiveDefaultModel && (
                          <span className="ml-1 text-secondary">· {t("onboarding.byoRuntime.modelsDefaultMark")}</span>
                        )}
                      </button>
                      {/* P6.454 — the wire, marked where the model is CHOSEN.
                          Outside the label button rather than inside it: that
                          button carries an explicit `aria-label`, which would
                          override any text added within, so a mark placed there
                          would be visible and unspoken. As its own element it is
                          read as part of the chip and needs no fourth aria
                          string. Text, not colour, for the same reason the
                          default mark is. */}
                      {isTranslatedWireModel(probes[id], arm) && (
                        <span className="py-1 pr-1 text-caption text-tertiary">
                          · {t("onboarding.byoRuntime.modelsTranslatedMark")}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setModels(selectedModelIds.filter(entry => entry !== id).join(', '))
                          setFieldError(null)
                        }}
                        disabled={isDisabled}
                        aria-label={t("onboarding.byoRuntime.modelsChipRemoveAria", { model: id })}
                        className="rounded-r-md py-1 pl-0.5 pr-1.5 -outline-offset-2 text-tertiary transition-colors duration-micro ease-out-subtle hover:duration-instant hover:text-foreground"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {fieldError?.field === 'models' && (
              <p className="text-label-sm text-destructive">{t(fieldError.key)}</p>
            )}
            <p className="text-label-sm text-tertiary">{t("onboarding.byoRuntime.modelsSummaryHelper")}</p>
            {/* What the mark COSTS, named rather than implied — a user who sees
                no cache counter on one model of this connection and a full one
                on its neighbour is looking at the wire, not at a bug. */}
            {hasTranslatedWireModel && (
              <p className="text-label-sm text-tertiary">{t("onboarding.byoRuntime.modelsTranslatedNote")}</p>
            )}
          </div>
        )}

        {/* Catalog — every arm whose effective protocol is openai-completions. */}
        {catalogAvailable && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={isDisabled || catalogLoading || !baseUrl.trim() || catalogKeyMissing}
                onClick={handleFetchCatalog}
              >
                {catalogLoading && <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />}
                {t('apiSetup.modelCatalog.fetch')}
              </Button>
              {catalog && (
                <span className="text-label-sm text-tertiary">
                  {t('apiSetup.modelCatalog.publishedCount', { count: catalog.length })}
                </span>
              )}
            </div>

            {catalogKeyMissing && (
              <p className="text-label-sm text-tertiary">{t("onboarding.byoRuntime.catalogNeedsKey")}</p>
            )}

            {catalogError && <p className="text-label-sm text-destructive">{catalogError}</p>}

            {(
              // RENDERED FROM MOUNT, with an empty catalog before Fetch. The
              // placeholder, the streaming rows and the grouped list are the
              // SAME component, so the region reserves its space once and
              // neither its width nor its height moves at any transition —
              // «интерфейс не скакал и юзер понимал что тут появятся модели».
              //
              // OWNER POINT 3, second half: the list scrolls in ITS OWN
              // container. Without the cap a large catalog grows the dialog past
              // the viewport and the submit button becomes unreachable.
              //
              // That cap is the picker's own ScrollArea viewport. This used to
              // add a SECOND scroller here, which is what made the list feel
              // stuck: the inner cap sat on a Radix Root and only clipped, so
              // the ~60px this wrapper could travel was the entire scroll range
              // for a 300-row catalog.
              <ModelCatalogPicker
                catalog={catalog ?? []}
                selectedIds={selectedModelIds}
                onSelectionChange={(ids) => { setModels(ids.join(', ')); setFieldError(null) }}
                probes={armVerdicts}
                probeProgress={probeProgress ?? undefined}
              />
            )}

            {/* The toggle is gone — keeping model metadata fresh is not a
                decision to hand the user (owner: «это не нужно юзеру мы это
                должны и так делать»). It still happens; it is now stated
                rather than asked. */}
            {!isEditing && (
              <p className="text-label-sm text-tertiary">{t('apiSetup.modelCatalog.autoRefreshHint')}</p>
            )}
          </div>
        )}

        {/* No catalog RPC exists for an Anthropic-protocol endpoint — its
            `/v1/models` carries no context length, so there is nothing to show.
            Say so rather than offering a button that returns nothing. */}
        {arm === 'pi' && preset === 'custom' && effectiveApi === 'anthropic-messages' && (
          <p className="text-label-sm text-tertiary">{t("onboarding.byoRuntime.catalogUnavailable")}</p>
        )}

        {/* Utility model — the project's Select over what is SELECTED. A free
            id is no longer typeable, and does not need to be: the server-side
            allowlist check (E1) rejects anything outside the list anyway, so
            the old free-text field could only produce a value that would be
            thrown away. */}
        {!official && selectedModelIds.length > 0 && (
          <div className="space-y-2">
            <Label htmlFor="byo-mini-model">{t("onboarding.byoRuntime.miniModel")}</Label>
            <Select
              value={miniModel || MINI_MODEL_AUTO}
              onValueChange={(next) => {
                setMiniModel(next === MINI_MODEL_AUTO ? '' : next)
                setFieldError(null)
              }}
              disabled={isDisabled}
            >
              <SelectTrigger id="byo-mini-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent container={selectPortalRef.current}>
                <SelectItem value={MINI_MODEL_AUTO}>{t("onboarding.byoRuntime.miniModelAuto")}</SelectItem>
                {selectedModelIds.map(id => <SelectItem key={id} value={id}>{id}</SelectItem>)}
              </SelectContent>
            </Select>
            {fieldError?.field === 'miniModel' && (
              <p className="text-label-sm text-destructive">{t(fieldError.key)}</p>
            )}
            <p className="text-label-sm text-tertiary">{t("onboarding.byoRuntime.miniModelHelper")}</p>
            {/* The list mounts here, inside the form. */}
            <div ref={selectPortalRef} />
          </div>
        )}

        {status === 'error' && errorMessage && (
          <p className="text-label text-destructive">{errorMessage}</p>
        )}
      </form>
    </StepFormLayout>
  )
}
