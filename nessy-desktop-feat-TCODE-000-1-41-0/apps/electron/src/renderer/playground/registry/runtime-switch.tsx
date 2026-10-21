/**
 * Runtime / integration switching — design draft.
 *
 * A COPY, not the composer. Nothing here is imported by the app; the real
 * `CompactModelSelector` and `FreeFormInput` are untouched. This exists so the
 * shape can be looked at and argued with before any of it is built.
 *
 * The proposal it draws: the picker carries TWO controls instead of one tree.
 * Today a tap on a model nested under another integration changes the
 * integration AND the model in one gesture, which is why "did you mean to
 * change runtime?" had to be inferred from where the tap landed. Here the
 * integration is its own row above the model list, the model list only ever
 * shows the ACTIVE integration's models, and the confirmation belongs to one
 * control.
 *
 * Plan: docs/superpowers/plans/2026-08-14-session-runtime-switching.md
 */

import * as React from 'react'
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  DatabaseZap,
  FolderOpen,
  Lock,
  Paperclip,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import type { LlmProviderType } from '@config/llm-connections'
import { InputContainer } from '@/components/app-shell/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ModalProvider, useRegisterModal } from '@/context/ModalContext'
import { ensureMockElectronAPI, mockInputCallbacks, mockSources } from '../mock-utils'
import type { ComponentEntry } from './types'

// =============================================================================
// Fixtures — shaped like real LlmConnectionWithStatus rows, one per runtime.
// =============================================================================

type Runtime = 'Pi' | 'Claude' | 'Codex'

interface DraftConnection {
  slug: string
  name: string
  providerType: LlmProviderType
  baseUrl?: string
  runtime: Runtime
  isAuthenticated: boolean
  models: Array<{ id: string; name: string; context?: string }>
  /**
   * What this runtime actually offers, from `composer-capabilities.ts`:
   * `pi` and `anthropic` carry all six, while `codex-runtime` and
   * `claude-runtime` stop at `high` — the adapter's effort ladder maps every
   * budget above 16 384 onto "high", so three of the six would reach the
   * upstream as one. Showing the full six there would be a lie the user pays
   * for in reasoning they think they bought.
   */
  reasoningLevels: ThinkingLevel[]
}

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Verbatim from `packages/shared/src/i18n/locales/ru.json`, `thinking.*`. */
const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: 'Без рассуждения',
  low: 'Низкая',
  medium: 'Средняя',
  high: 'Высокая',
  xhigh: 'Очень высокая',
  max: 'Макс.',
}

/** Verbatim from `ru.json`, `thinking.*Desc`. */
const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: 'Самые быстрые ответы, без рассуждения',
  low: 'Легкое рассуждение, более быстрые ответы',
  medium: 'Баланс скорости и рассуждения',
  high: 'Глубокое рассуждение для сложных задач',
  xhigh: 'Более глубокое рассуждение для долгих агентных задач',
  max: 'Максимальное усилие рассуждения',
}

const ALL_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
const CAPPED_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high']

const CONNECTIONS: DraftConnection[] = [
  {
    slug: 'nessy-gateway',
    name: 'Nessy Gateway',
    providerType: 'pi',
    baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
    runtime: 'Pi',
    isAuthenticated: true,
    models: [
      { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'Qwen 3.5 397B', context: '262K' },
      { id: 'tgpt/qwen36-35b-a3b-fp8', name: 'Qwen 3.6 35B', context: '262K' },
    ],
    reasoningLevels: ALL_LEVELS,
  },
  {
    slug: 'claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
    runtime: 'Claude',
    isAuthenticated: true,
    models: [{ id: 'tgpt/qwen35-397b-a17b-fp8', name: 'Qwen 3.5 397B', context: '262K' }],
    reasoningLevels: CAPPED_LEVELS,
  },
  {
    slug: 'codex-gateway',
    name: 'Codex (Nessy Gateway)',
    providerType: 'codex-runtime',
    baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
    runtime: 'Codex',
    isAuthenticated: true,
    models: [{ id: 'tgpt/qwen35-397b-a17b-fp8', name: 'Qwen 3.5 397B', context: '262K' }],
    reasoningLevels: CAPPED_LEVELS,
  },
  {
    slug: 'ollama-local',
    name: 'Ollama (локальная)',
    providerType: 'pi_compat',
    baseUrl: 'http://localhost:11434/v1',
    runtime: 'Pi',
    isAuthenticated: true,
    models: [{ id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B', context: '128K' }],
    reasoningLevels: ALL_LEVELS,
  },
  {
    slug: 'anthropic-api',
    name: 'Anthropic API',
    providerType: 'anthropic',
    runtime: 'Claude',
    isAuthenticated: false,
    models: [{ id: 'claude-opus-4-5', name: 'Opus 4.8', context: '200K' }],
    reasoningLevels: ALL_LEVELS,
  },
]

/**
 * Above this many models the list stops being a list.
 *
 * Ten is where scanning turns into hunting: the panel is already carrying an
 * integration row and a reasoning row, and a third scroll region between them
 * makes the whole thing a scrollport with no shape. A real catalog is not a
 * near-miss either — the internal llm-proxy answers with ~383 rows — so the
 * question is not "how tall do we let it grow" but "when does it become its own
 * screen".
 */
const MODEL_LIST_INLINE_MAX = 10

/** A catalog-sized connection, so the >10 branch is looked at with real numbers. */
const LLM_PROXY_MODELS = Array.from({ length: 388 }, (_, i) => {
  const families = ['qwen', 'llama', 'mistral', 'gemma', 'deepseek', 'phi', 'yi', 'command-r']
  const family = families[i % families.length]!
  const size = [7, 8, 13, 32, 34, 70, 141, 397][i % 8]
  return {
    id: `${family}/${family}-${size}b-v${(i % 5) + 1}`,
    name: `${family.charAt(0).toUpperCase()}${family.slice(1)} ${size}B v${(i % 5) + 1}`,
    context: ['32K', '128K', '262K'][i % 3],
  }
})

/** The threshold pair, so the flip at MODEL_LIST_INLINE_MAX is visible side by side. */
function syntheticModels(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}/model-${i + 1}`,
    name: `${prefix.toUpperCase()} Model ${i + 1}`,
    context: ['32K', '128K', '262K'][i % 3],
  }))
}

CONNECTIONS.push({
  slug: 'gateway-10',
  name: 'Nessy Gateway (10 моделей)',
  providerType: 'pi',
  baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
  runtime: 'Pi',
  isAuthenticated: true,
  models: syntheticModels(10, 'tgpt'),
  reasoningLevels: ALL_LEVELS,
})

CONNECTIONS.push({
  slug: 'gateway-11',
  name: 'Nessy Gateway (11 моделей)',
  providerType: 'pi',
  baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
  runtime: 'Pi',
  isAuthenticated: true,
  models: syntheticModels(11, 'tgpt'),
  reasoningLevels: ALL_LEVELS,
})

CONNECTIONS.push({
  slug: 'llm-proxy',
  name: 'LLM Proxy (внутренний)',
  providerType: 'pi_compat',
  baseUrl: 'https://llm-proxy.internal/v1',
  runtime: 'Pi',
  isAuthenticated: true,
  models: LLM_PROXY_MODELS,
  reasoningLevels: ALL_LEVELS,
})

const byslug = (slug: string) => CONNECTIONS.find(c => c.slug === slug)!

/**
 * `useRegisterModal` throws without a provider, and the playground shell does
 * not mount one globally — the InputContainer entry brings its own. Every entry
 * here shows a confirmation, so every entry needs it.
 */
function WithModalProvider({ children }: { children: React.ReactNode }) {
  return <ModalProvider>{children}</ModalProvider>
}

// =============================================================================
// Shared bits
// =============================================================================

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1 text-xs font-medium text-foreground/60 uppercase tracking-wide select-none">
      {children}
    </div>
  )
}

/**
 * The runtime is named on every integration row, always.
 *
 * Two integrations can look identical (same vendor, same models) and answer
 * through completely different agents; without the mark the user has no way to
 * know that one of these switches costs them the runtime's memory and the
 * other does not.
 */
function RuntimeBadge({ runtime, className }: { runtime: Runtime; className?: string }) {
  return (
    <span
      className={cn(
        'text-[10px] leading-none font-medium px-1.5 py-1 rounded-md',
        'bg-foreground/[0.07] text-foreground/60 select-none shrink-0',
        className,
      )}
    >
      {runtime}
    </span>
  )
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'w-full min-w-[340px] rounded-xl border border-border bg-popover shadow-lg overflow-hidden',
        'flex flex-col pb-2',
        className,
      )}
    >
      {children}
    </div>
  )
}

// =============================================================================
// Level 1 — the picker as the user first sees it
// =============================================================================

function PickerLevel1({
  connectionSlug,
  modelId,
  busy,
  singleModel,
  thinkingLevel = 'medium',
  onOpenReasoning,
  onOpenModels,
  onOpenIntegrations,
}: {
  connectionSlug: string
  modelId: string
  busy?: boolean
  singleModel?: boolean
  thinkingLevel?: ThinkingLevel
  onOpenReasoning?: () => void
  onOpenModels?: () => void
  onOpenIntegrations?: () => void
}) {
  const conn = byslug(connectionSlug)
  const models = singleModel ? conn.models.slice(0, 1) : conn.models
  const selectedModel = conn.models.find(m => m.id === modelId)

  return (
    <Panel>
      <SectionLabel>Интеграция</SectionLabel>
      <div className="px-2">
        <button
          type="button"
          disabled={busy}
          onClick={onOpenIntegrations}
          className={cn(
            'flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-left transition-colors',
            busy ? 'opacity-50 cursor-not-allowed' : 'hover:bg-foreground/5',
          )}
        >
          <ConnectionIcon connection={conn} size={16} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{conn.name}</div>
            {busy && (
              <div className="text-xs text-muted-foreground">
                Дождитесь завершения ответа, чтобы переключить
              </div>
            )}
          </div>
          <RuntimeBadge runtime={conn.runtime} />
          {!busy && <ChevronRight className="h-3.5 w-3.5 opacity-50 shrink-0" />}
        </button>
      </div>

      <div className="h-px bg-border mx-3 my-1.5" />

      <SectionLabel>Модель</SectionLabel>
      {conn.models.length > MODEL_LIST_INLINE_MAX ? (
        // Same row shape as Интеграция and Рассуждения. Past the threshold the
        // panel is three rows and nothing else — one grammar, three uses — and
        // the catalog gets a screen of its own where a search box is affordable.
        <div className="px-2">
          <button
            type="button"
            onClick={onOpenModels}
            className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-left hover:bg-foreground/5 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{selectedModel?.name ?? modelId}</div>
              <div className="text-xs text-muted-foreground truncate">
                {conn.models.length} моделей
              </div>
            </div>
            {selectedModel?.context && (
              <span className="text-xs text-muted-foreground shrink-0">{selectedModel.context}</span>
            )}
            <ChevronRight className="h-3.5 w-3.5 opacity-50 shrink-0" />
          </button>
        </div>
      ) : (
      <div className="px-2 flex flex-col gap-0.5">
        {singleModel ? (
          <div className="flex items-center justify-between px-3 py-2 rounded-lg">
            <span className="text-sm font-medium truncate">{models[0]!.name}</span>
            <span className="text-xs text-muted-foreground ml-3 shrink-0">{models[0]!.context}</span>
          </div>
        ) : (
          models.map(model => {
            const selected = model.id === modelId
            return (
              <button
                key={model.id}
                type="button"
                className={cn(
                  'flex items-center justify-between w-full px-3 py-2 rounded-lg text-left transition-colors',
                  selected ? 'bg-foreground/5' : 'hover:bg-foreground/5',
                )}
              >
                <span className="text-sm font-medium truncate">{model.name}</span>
                <div className="flex items-center gap-2 ml-3 shrink-0">
                  <span className="text-xs text-muted-foreground">{model.context}</span>
                  {selected && <Check className="h-3.5 w-3.5 text-foreground/60" />}
                </div>
              </button>
            )
          })
        )}
      </div>
      )}

      <div className="h-px bg-border mx-3 my-1.5" />

      {/* A ROW, the same shape as the integration row above — not a strip of
          chips. The panel now has exactly two "go deeper" rows framing one
          list, so the grammar is learned once and used twice. Chips read as a
          different kind of control and made the third section look like a
          settings widget bolted under a menu. */}
      <SectionLabel>Рассуждения</SectionLabel>
      <div className="px-2">
        <button
          type="button"
          onClick={onOpenReasoning}
          className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-left hover:bg-foreground/5 transition-colors"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{THINKING_LABELS[thinkingLevel]}</div>
            {conn.reasoningLevels.length < ALL_LEVELS.length && (
              <div className="text-xs text-muted-foreground truncate">
                {conn.runtime}: до «{THINKING_LABELS.high}»
              </div>
            )}
          </div>
          <ChevronRight className="h-3.5 w-3.5 opacity-50 shrink-0" />
        </button>
      </div>
    </Panel>
  )
}

// =============================================================================
// Level — the model catalog, for connections past MODEL_LIST_INLINE_MAX
// =============================================================================

function PickerLevelModels({
  connectionSlug,
  modelId,
  onBack,
  onPick,
}: {
  connectionSlug: string
  modelId: string
  onBack: () => void
  onPick: (id: string) => void
}) {
  const conn = byslug(connectionSlug)
  const [query, setQuery] = React.useState('')

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conn.models
    return conn.models.filter(m => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
  }, [conn.models, query])

  return (
    <Panel>
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-foreground/60 uppercase tracking-wide hover:text-foreground/80 transition-colors"
      >
        <ChevronLeft className="h-3 w-3" />
        Модель
      </button>

      {/* Search is not decoration at this size: 388 rows is a scroll of about
          forty screens, and the id carries the family the name alone does not. */}
      <div className="px-3 pt-1 pb-2">
        <div className="flex items-center gap-2 h-8 px-2.5 rounded-lg bg-foreground/[0.05]">
          <Search className="h-3.5 w-3.5 opacity-50 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Поиск по названию или id"
            className="flex-1 min-w-0 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="text-xs text-muted-foreground shrink-0">
              Сброс
            </button>
          )}
        </div>
      </div>

      <div className="px-2 flex flex-col gap-0.5 max-h-[320px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">Ничего не найдено</div>
        ) : (
          filtered.map(model => {
            const selected = model.id === modelId
            return (
              <button
                key={model.id}
                type="button"
                onClick={() => onPick(model.id)}
                className={cn(
                  'flex items-center justify-between w-full px-3 py-2 rounded-lg text-left transition-colors',
                  selected ? 'bg-foreground/5' : 'hover:bg-foreground/5',
                )}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{model.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate font-mono">{model.id}</div>
                </div>
                <div className="flex items-center gap-2 ml-3 shrink-0">
                  <span className="text-xs text-muted-foreground">{model.context}</span>
                  {selected && <Check className="h-3.5 w-3.5 text-foreground/60" />}
                </div>
              </button>
            )
          })
        )}
      </div>

      <p className="px-3 pt-2 text-[11px] text-muted-foreground">
        {filtered.length} из {conn.models.length}
      </p>
    </Panel>
  )
}

// =============================================================================
// Level 3 — the reasoning list (same shape as level 2)
// =============================================================================

function PickerLevelReasoning({
  connectionSlug,
  thinkingLevel,
  onBack,
  onPick,
}: {
  connectionSlug: string
  thinkingLevel: ThinkingLevel
  onBack: () => void
  onPick: (level: ThinkingLevel) => void
}) {
  const conn = byslug(connectionSlug)
  return (
    <Panel>
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-foreground/60 uppercase tracking-wide hover:text-foreground/80 transition-colors"
      >
        <ChevronLeft className="h-3 w-3" />
        Рассуждения
      </button>
      <div className="px-2 pt-1 flex flex-col gap-0.5">
        {conn.reasoningLevels.map(levelId => (
          <button
            key={levelId}
            type="button"
            onClick={() => onPick(levelId)}
            className={cn(
              'flex items-center justify-between w-full px-3 py-2 rounded-lg text-left transition-colors',
              levelId === thinkingLevel ? 'bg-foreground/5' : 'hover:bg-foreground/5',
            )}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{THINKING_LABELS[levelId]}</div>
              <div className="text-xs text-muted-foreground truncate">{THINKING_DESCRIPTIONS[levelId]}</div>
            </div>
            {levelId === thinkingLevel && <Check className="h-3.5 w-3.5 text-foreground/60 shrink-0 ml-3" />}
          </button>
        ))}
      </div>
      {conn.reasoningLevels.length < ALL_LEVELS.length && (
        <p className="px-3 pt-2 text-[11px] leading-snug text-muted-foreground">
          {conn.runtime} не различает уровни выше «{THINKING_LABELS.high}» — они доходят до модели как один,
          поэтому здесь их нет.
        </p>
      )}
    </Panel>
  )
}

// =============================================================================
// Level 2 — the integration list
// =============================================================================

function PickerLevel2({ connectionSlug, onBack }: { connectionSlug: string; onBack?: () => void }) {
  const current = byslug(connectionSlug)

  return (
    <Panel>
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-foreground/60 uppercase tracking-wide hover:text-foreground/80 transition-colors"
      >
        <ChevronLeft className="h-3 w-3" />
        Интеграция
      </button>

      <div className="px-2 pt-1 flex flex-col gap-0.5">
        {CONNECTIONS.map(conn => {
          const isCurrent = conn.slug === connectionSlug
          const sameRuntime = conn.runtime === current.runtime
          return (
            <button
              key={conn.slug}
              type="button"
              disabled={!conn.isAuthenticated}
              className={cn(
                'flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-left transition-colors',
                !conn.isAuthenticated && 'opacity-50 cursor-not-allowed',
                conn.isAuthenticated && 'hover:bg-foreground/5',
                isCurrent && 'bg-foreground/5',
              )}
            >
              <ConnectionIcon connection={conn} size={16} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{conn.name}</div>
                {!conn.isAuthenticated ? (
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Lock className="h-2.5 w-2.5" />
                    Требуется вход
                  </div>
                ) : isCurrent ? (
                  <div className="text-xs text-muted-foreground">Текущая</div>
                ) : sameRuntime ? (
                  <div className="text-xs text-muted-foreground">Тот же рантайм — контекст сохранится</div>
                ) : (
                  <div className="text-xs text-muted-foreground">Другой рантайм — контекст передастся кратко</div>
                )}
              </div>
              <RuntimeBadge runtime={conn.runtime} />
              {isCurrent && <Check className="h-3.5 w-3.5 text-foreground/60 shrink-0" />}
            </button>
          )
        })}
      </div>
    </Panel>
  )
}

// =============================================================================
// Level 3 — confirmation, one copy per tier
// =============================================================================

/**
 * Confirmation, in the project's own modal.
 *
 * Not a popover: the consequence list is the point of this element, and inside
 * the 380px picker panel every line truncated — plus a popover anchored to a
 * toolbar button is not centred, so the one moment the user is asked to decide
 * something arrived off to one side of the screen. `Dialog` portals, centres,
 * traps focus and registers with `ModalContext` so Cmd+W closes it first, all
 * of which this had to reinvent badly.
 */
function RuntimeSwitchConfirmDialog({
  open,
  from,
  to,
  onCancel,
  onConfirm,
}: {
  open: boolean
  from: DraftConnection
  to: DraftConnection
  onCancel: () => void
  onConfirm: () => void
}) {
  const crossRuntime = from.runtime !== to.runtime
  useRegisterModal(open, onCancel)

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {crossRuntime
              ? <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500 shrink-0" />
              : <ArrowLeftRight className="h-5 w-5 text-foreground/60 shrink-0" />}
            {crossRuntime ? 'Переключить рантайм?' : 'Переключить интеграцию?'}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="text-left pt-1 flex flex-col gap-3">
              <div className="flex items-center gap-1.5 text-xs min-w-0">
                <ConnectionIcon connection={from} size={12} />
                <span className="truncate">{from.name}</span>
                <RuntimeBadge runtime={from.runtime} />
                <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />
                <ConnectionIcon connection={to} size={12} />
                <span className="truncate">{to.name}</span>
                <RuntimeBadge runtime={to.runtime} />
              </div>

              {crossRuntime ? (
                <ul className="text-sm text-foreground/80 leading-relaxed flex flex-col gap-1.5">
                  <li className="flex gap-2">
                    <span className="text-foreground/40 select-none">•</span>
                    <span>Переписка на экране останется целиком.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 select-none">•</span>
                    <span>Рабочая память {from.runtime} не переносится — новый рантайм получит последние сообщения диалога текстом.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 select-none">•</span>
                    <span>Уровень рассуждений сбросится до значения по умолчанию нового рантайма.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 select-none">•</span>
                    <span>Фоновые задачи, запущенные {from.runtime}, будут остановлены.</span>
                  </li>
                </ul>
              ) : (
                <p className="text-sm text-foreground/80 leading-relaxed">
                  Сессия перезапустится на «{to.name}». Диалог сохранится, но следующий ответ перечитает
                  историю заново без кэша — он может прийти медленнее обычного.
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Отмена</Button>
          <Button onClick={onConfirm}>Переключить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// The in-transcript marker
// =============================================================================

function SwitchNotice({ from = 'Pi', to = 'Claude' }: { from?: string; to?: string }) {
  return (
    <div className="w-[560px] max-w-full flex items-center gap-2.5 py-2">
      <div className="h-px flex-1 bg-border" />
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
        <ArrowLeftRight className="h-3 w-3" />
        <span>
          Рантайм переключён: {from} → {to}. Контекст передан кратко.
        </span>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

// =============================================================================
// One entry, all states behind a knob
// =============================================================================

type DraftState =
  | 'level1'
  | 'level1-many-models'
  | 'level-models'
  | 'level1-busy'
  | 'level1-single-model'
  | 'level1-unavailable'
  | 'level2'
  | 'confirm-same-runtime'
  | 'confirm-cross-runtime'
  | 'flow'

function UnavailablePanel() {
  return (
    <Panel>
      <SectionLabel>Интеграция</SectionLabel>
      <div className="px-2">
        <button
          type="button"
          className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-left hover:bg-foreground/5 transition-colors"
        >
          <div className="h-4 w-4 rounded-[3px] bg-destructive/10 flex items-center justify-center shrink-0">
            <AlertTriangle className="h-2.5 w-2.5 text-destructive" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate text-destructive">Интеграция недоступна</div>
            <div className="text-xs text-muted-foreground">
              Она была удалена. Выберите другую, чтобы продолжить диалог.
            </div>
          </div>
          <ChevronRight className="h-3.5 w-3.5 opacity-50 shrink-0" />
        </button>
      </div>
    </Panel>
  )
}

/** Click-through of the whole gesture, for judging the number of taps. */
function InteractiveFlow() {
  const [level, setLevel] = React.useState<'1' | '2' | 'confirm'>('1')
  const [target, setTarget] = React.useState<string>('claude-gateway')
  const [slug, setSlug] = React.useState('nessy-gateway')

  if (level === 'confirm') {
    const from = byslug(slug)
    const to = byslug(target)
    return (
      <div className="flex flex-col items-center gap-3">
        <RuntimeSwitchConfirmDialog
          open
          from={from}
          to={to}
          onCancel={() => setLevel('2')}
          onConfirm={() => {
            setSlug(target)
            setLevel('1')
          }}
        />
        <p className="text-xs text-muted-foreground">Шаг 3 из 3 — подтверждение</p>
      </div>
    )
  }

  if (level === '2') {
    return (
      <div className="flex flex-col items-center gap-3">
        <PickerLevel2Interactive
          connectionSlug={slug}
          onBack={() => setLevel('1')}
          onPick={next => {
            if (next === slug) { setLevel('1'); return }
            setTarget(next)
            setLevel('confirm')
          }}
        />
        <p className="text-xs text-muted-foreground">Шаг 2 из 3 — выбор интеграции</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <PickerLevel1
        connectionSlug={slug}
        modelId={byslug(slug).models[0]!.id}
        onOpenIntegrations={() => setLevel('2')}
      />
      <p className="text-xs text-muted-foreground">
        Шаг 1 из 3 — тык по модели ничего не переключает; интеграция открывается своей строкой
      </p>
    </div>
  )
}

function PickerLevel2Interactive({
  connectionSlug,
  onBack,
  onPick,
}: {
  connectionSlug: string
  onBack: () => void
  onPick: (slug: string) => void
}) {
  const current = byslug(connectionSlug)
  return (
    <Panel>
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-foreground/60 uppercase tracking-wide hover:text-foreground/80 transition-colors"
      >
        <ChevronLeft className="h-3 w-3" />
        Интеграция
      </button>
      <div className="px-2 pt-1 flex flex-col gap-0.5">
        {CONNECTIONS.map(conn => {
          const isCurrent = conn.slug === connectionSlug
          const sameRuntime = conn.runtime === current.runtime
          return (
            <button
              key={conn.slug}
              type="button"
              disabled={!conn.isAuthenticated}
              onClick={() => onPick(conn.slug)}
              className={cn(
                'flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-left transition-colors',
                !conn.isAuthenticated && 'opacity-50 cursor-not-allowed',
                conn.isAuthenticated && 'hover:bg-foreground/5',
                isCurrent && 'bg-foreground/5',
              )}
            >
              <ConnectionIcon connection={conn} size={16} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{conn.name}</div>
                {!conn.isAuthenticated ? (
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Lock className="h-2.5 w-2.5" />
                    Требуется вход
                  </div>
                ) : isCurrent ? (
                  <div className="text-xs text-muted-foreground">Текущая</div>
                ) : sameRuntime ? (
                  <div className="text-xs text-muted-foreground">Тот же рантайм — контекст сохранится</div>
                ) : (
                  <div className="text-xs text-muted-foreground">Другой рантайм — контекст передастся кратко</div>
                )}
              </div>
              <RuntimeBadge runtime={conn.runtime} />
              {isCurrent && <Check className="h-3.5 w-3.5 text-foreground/60 shrink-0" />}
            </button>
          )
        })}
      </div>
    </Panel>
  )
}


function RuntimeSwitchDraft({ state = 'level1' }: { state?: DraftState }) {
  switch (state) {
    case 'level1-busy':
      return <PickerLevel1 connectionSlug="nessy-gateway" modelId="tgpt/qwen35-397b-a17b-fp8" busy />
    case 'level1-single-model':
      return <PickerLevel1 connectionSlug="ollama-local" modelId="qwen2.5-coder:32b" singleModel />
    case 'level1-many-models':
      return (
        <PickerLevel1
          connectionSlug="llm-proxy"
          modelId={byslug('llm-proxy').models[0]!.id}
          thinkingLevel="medium"
        />
      )
    case 'level-models':
      return (
        <PickerLevelModels
          connectionSlug="llm-proxy"
          modelId={byslug('llm-proxy').models[3]!.id}
          onBack={() => {}}
          onPick={() => {}}
        />
      )
    case 'level1-unavailable':
      return <UnavailablePanel />
    case 'level2':
      return <PickerLevel2 connectionSlug="nessy-gateway" />
    case 'confirm-same-runtime':
      return <RuntimeSwitchConfirmDialog open from={byslug('nessy-gateway')} to={byslug('ollama-local')} onCancel={() => {}} onConfirm={() => {}} />
    case 'confirm-cross-runtime':
      return <RuntimeSwitchConfirmDialog open from={byslug('nessy-gateway')} to={byslug('claude-gateway')} onCancel={() => {}} onConfirm={() => {}} />
    case 'flow':
      return <InteractiveFlow />
    case 'level1':
    default:
      return <PickerLevel1 connectionSlug="nessy-gateway" modelId="tgpt/qwen35-397b-a17b-fp8" />
  }
}

// =============================================================================
// The same draft, mounted in the composer where the model pill lives today.
//
// A shell, not the real `InputContainer`: the point of this entry is to judge
// the picker in its actual context — width, anchoring, how far the panel rises
// over the transcript, whether the integration row reads at pill scale — and
// the real composer is not touched to get it. The chrome below copies
// `FreeFormInput`'s footer row verbatim in class terms, including the pill's
// `h-7 rounded-[6px] shadow-tinted bg-foreground/5` shape.
// =============================================================================

function ComposerPill({
  icon,
  label,
  active,
  chevron,
  onClick,
}: {
  icon?: React.ReactNode
  label: string
  active?: boolean
  chevron?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 px-2 text-xs font-medium rounded-[6px] flex items-center gap-1.5 shadow-tinted',
        'outline-none select-none shrink min-w-0 transition-colors',
        active ? 'bg-foreground/10 text-foreground/90' : 'bg-foreground/5 text-foreground/70 hover:bg-foreground/[0.08]',
      )}
      style={{ '--shadow-color': 'var(--fg-base)' } as React.CSSProperties}
    >
      {icon}
      <span className="truncate min-w-0">{label}</span>
      {chevron && <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />}
    </button>
  )
}

type ComposerState = 'closed' | 'level1' | 'level2' | 'confirm-same' | 'confirm-cross'

function RuntimeSwitchInComposer({ state = 'level1' }: { state?: ComposerState }) {
  const [open, setOpen] = React.useState<ComposerState>(state)
  React.useEffect(() => setOpen(state), [state])

  const conn = byslug('nessy-gateway')
  const showConfirm = open === 'confirm-same' || open === 'confirm-cross'
  const confirmTo = byslug(open === 'confirm-cross' ? 'claude-gateway' : 'ollama-local')

  return (
    // Bottom-anchored like the real chat: the panel opens UPWARD, so a
    // centered preview clips it and hides exactly the part being judged.
    <div className="w-[760px] max-w-full h-full flex flex-col justify-end gap-3 pb-2">
      <div className="flex-1 min-h-0" />

      {/* A slice of transcript, so the panel's rise over the conversation is visible. */}
      <div className="flex flex-col gap-2 opacity-40 select-none px-1">
        <div className="text-sm">Добавь ретраи в fetch-хелпер, три попытки с бэкоффом.</div>
        <div className="text-sm text-muted-foreground">
          Готово — `fetchWithRetry` теперь делает три попытки с экспоненциальной задержкой, тесты зелёные.
        </div>
      </div>

      <RuntimeSwitchConfirmDialog
        open={showConfirm}
        from={conn}
        to={confirmTo}
        onCancel={() => {}}
        onConfirm={() => {}}
      />

      <div className="rounded-2xl border border-border bg-background shadow-lg overflow-visible">
        <div className="px-3 pt-3 pb-1 min-h-[52px] text-sm text-muted-foreground select-none">
          Message Nessy...
        </div>

        <div className="px-2 pb-2 pt-1 flex items-center gap-[5px]">
          {/* Desktop arrangement, copied from the running composer: context
              pills left, MODEL pill right against the send button. The compact
              (mobile) layout puts the model second from the left instead — if
              this design is adopted, the integration row has to be checked in
              both, because the panel's anchor edge flips with it. */}
          <div className="flex items-center gap-1 min-w-0 shrink">
            <ComposerPill icon={<ShieldCheck className="h-3.5 w-3.5" />} label="По умолчанию" chevron />
            <ComposerPill icon={<Paperclip className="h-3.5 w-3.5" />} label="Прикрепить" />
            <ComposerPill icon={<DatabaseZap className="h-3.5 w-3.5" />} label="Источники" />
            <ComposerPill icon={<FolderOpen className="h-3.5 w-3.5" />} label="nessy-desktop" />
          </div>

          <div className="flex-1" />

          {/* The panel hangs off the MODEL pill, the way a popover anchors to
              its trigger — and right-aligned, because the trigger sits at the
              right edge. Anchoring it to the footer row instead parked the
              integration row under the permission pill, which is the one place
              it must never look attached to. */}
          <div className="relative shrink-0">
            {(open === 'level1' || open === 'level2') && (
              <div className="absolute bottom-full right-0 mb-2 z-10">
                {open === 'level1' ? (
                  <PickerLevel1
                    connectionSlug="nessy-gateway"
                    modelId="tgpt/qwen35-397b-a17b-fp8"
                    onOpenIntegrations={() => setOpen('level2')}
                  />
                ) : (
                  <PickerLevel2 connectionSlug="nessy-gateway" onBack={() => setOpen('level1')} />
                )}
              </div>
            )}
            <ComposerPill
              icon={<ConnectionIcon connection={conn} size={14} />}
              label="Qwen 3.5 397B"
              chevron
              active={open === 'level1' || open === 'level2'}
              onClick={() => setOpen(open === 'closed' ? 'level1' : 'closed')}
            />
          </div>

          <button
            type="button"
            className="h-7 w-7 rounded-full bg-foreground text-background flex items-center justify-center shrink-0 opacity-40"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground text-center">
        {open === 'level2'
          ? 'Шаг 2 — рантайм назван на каждой строке, последствие подписано до тапа'
          : open === 'confirm-cross'
            ? 'Шаг 3 — единственный переход, который реально что-то теряет'
            : open === 'confirm-same'
              ? 'Шаг 3 — тот же рантайм: диалог цел, платим только перезапуском'
              : 'Тык по модели ничего не переключает — интеграция открывается своей строкой'}
      </p>
    </div>
  )
}

// The `runtime-switch-in-real-composer` entry and its `DraftModelPickerSlot`
// lived here. Both are gone with T5: `InputContainer`'s `modelPickerSlot`
// design seam was deleted when the new picker became THE picker, so there is
// no slot left to mount a draft into. The four draft entries below stay —
// they are the accepted visual spec and the record of what was decided.

export const runtimeSwitchComponents: ComponentEntry[] = [
  {
    id: 'runtime-switch-in-composer-draft',
    name: 'Runtime Switch — in composer (draft)',
    category: 'Chat Inputs',
    description:
      'DRAFT in place: the picker mounted in a composer shell where the model pill sits today. The real InputContainer is untouched — this shell copies its footer classes so the panel can be judged at true width and anchoring.',
    component: RuntimeSwitchInComposer,
    wrapper: WithModalProvider,
    layout: 'full',
    previewOverflow: 'visible',
    props: [
      {
        name: 'state',
        description: 'Which step of the gesture is on screen',
        control: {
          type: 'select',
          options: [
            { label: 'Closed — composer only', value: 'closed' },
            { label: 'Open — integration row + models', value: 'level1' },
            { label: 'Open — integration list', value: 'level2' },
            { label: 'Confirm — same runtime', value: 'confirm-same' },
            { label: 'Confirm — different runtime', value: 'confirm-cross' },
          ],
        },
        defaultValue: 'level1',
      },
    ],
    variants: [
      { name: 'Closed', description: 'The footer row as it reads with no panel open.', props: { state: 'closed' } },
      { name: 'Open — models', description: 'Step 1. The model list is the active integration\'s only.', props: { state: 'level1' } },
      { name: 'Open — integrations', description: 'Step 2. Runtime on every row, consequence before the tap.', props: { state: 'level2' } },
      { name: 'Confirm — same runtime', description: 'Nessy Gateway → Ollama. Both Pi.', props: { state: 'confirm-same' } },
      { name: 'Confirm — different runtime', description: 'Nessy Gateway (Pi) → Claude Code.', props: { state: 'confirm-cross' } },
    ],
  },
  {
    id: 'runtime-switch-picker-draft',
    name: 'Runtime Switch — Picker (draft)',
    category: 'Chat Inputs',
    description:
      'DRAFT, not wired to the app. Two controls instead of one tree: the integration is its own row above the model list, so a model tap can never move the session between runtimes. Every state behind the knob; pick "flow" to click the whole gesture through.',
    component: RuntimeSwitchDraft,
    wrapper: WithModalProvider,
    layout: 'centered',
    previewOverflow: 'visible',
    props: [
      {
        name: 'state',
        description: 'Which state of the draft to render',
        control: {
          type: 'select',
          options: [
            { label: 'Level 1 — integration row + models', value: 'level1' },
            { label: 'Level 1 — catalog connection (388 models)', value: 'level1-many-models' },
            { label: 'Model catalog — searchable list', value: 'level-models' },
            { label: 'Level 1 — turn in progress (locked)', value: 'level1-busy' },
            { label: 'Level 1 — single-model integration', value: 'level1-single-model' },
            { label: 'Level 1 — integration deleted', value: 'level1-unavailable' },
            { label: 'Level 2 — integration list', value: 'level2' },
            { label: 'Confirm — same runtime', value: 'confirm-same-runtime' },
            { label: 'Confirm — different runtime', value: 'confirm-cross-runtime' },
            { label: 'Flow — click through all three steps', value: 'flow' },
          ],
        },
        defaultValue: 'level1',
      },
    ],
    variants: [
      { name: 'Level 1 — default', description: 'What the user opens into. The model list is the active integration\'s only.', props: { state: 'level1' } },
      { name: 'Catalog connection', description: 'Past ten models the list collapses into a row — the panel becomes three rows and nothing else.', props: { state: 'level1-many-models' } },
      { name: 'Model catalog', description: '388 models on their own screen, with search over name and id.', props: { state: 'level-models' } },
      { name: 'Level 2 — integrations', description: 'Runtime named on every row; the consequence stated per row before the tap.', props: { state: 'level2' } },
      { name: 'Confirm — same runtime', description: 'Nessy Gateway → Ollama. Both Pi: the conversation survives, only the restart costs.', props: { state: 'confirm-same-runtime' } },
      { name: 'Confirm — cross runtime', description: 'Nessy Gateway (Pi) → Claude Code. The tier that actually loses something.', props: { state: 'confirm-cross-runtime' } },
      { name: 'Turn in progress', description: 'The integration row is the only thing locked; the model list stays usable.', props: { state: 'level1-busy' } },
      { name: 'Integration deleted', description: 'Today this state resolves silently in the log; here it is a row the user can act on.', props: { state: 'level1-unavailable' } },
      { name: 'Full flow', description: 'Three taps end to end — for judging whether the extra tap is worth the safety.', props: { state: 'flow' } },
    ],
  },
  {
    id: 'runtime-switch-notice-draft',
    name: 'Runtime Switch — transcript marker (draft)',
    category: 'Chat Messages',
    description:
      'DRAFT. The marker written into the transcript at the point the runtime changed. Without it a mixed transcript — one runtime\'s tool cards above, another\'s below — reads as a rendering bug, and a user scrolling up has nothing explaining why the assistant "forgot" what is two screens above.',
    component: SwitchNotice,
    layout: 'centered',
    props: [
      { name: 'from', description: 'Runtime left', control: { type: 'string' }, defaultValue: 'Pi' },
      { name: 'to', description: 'Runtime taken over', control: { type: 'string' }, defaultValue: 'Claude' },
    ],
    variants: [
      { name: 'Pi → Claude', props: { from: 'Pi', to: 'Claude' } },
      { name: 'Pi → Codex', props: { from: 'Pi', to: 'Codex' } },
      { name: 'Codex → Pi', props: { from: 'Codex', to: 'Pi' } },
    ],
  },
]
