# Дизайн подсказок промптов (NES)

> Предсказывает, что пользователь естественно ввёл бы следующим после завершения ответа AI, показывая это как ghost text в поле ввода промпта.
>
> Статус реализации: `prompt-suggestion-implementation.md`. Движок спекуляции: `speculation-design.md`.

## Обзор

**Подсказка промпта** (Next-step Suggestion / NES) — это короткое предсказание (2-12 слов) следующего ввода пользователя, генерируемое LLM вызовом после каждого ответа AI. Появляется как ghost text в поле ввода промпта. Пользователь может принять её с помощью Tab/Enter/Right Arrow или отклонить набором текста.

## Архитектура

```
┌──────────────────────────────────────────────────────────────┐
│  AppContainer (CLI)                                          │
│                                                              │
│  Responding → Idle transition                                │
│       │                                                      │
│       ▼                                                      │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Guard Conditions (11 категорий)                     │    │
│  │  settings, interactive, sdk, plan mode, dialogs,     │    │
│  │  elicitation, API error                              │    │
│  └────────────────────┬─────────────────────────────────┘    │
│                       │                                      │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  generatePromptSuggestion()                          │    │
│  │                                                      │    │
│  │  ┌─── CacheSafeParams доступны? ────┐                │    │
│  │  │                                  │                │    │
│  │  ▼ YES                           NO ▼                │    │
│  │  runForkedQuery()      BaseLlmClient.generateJson()  │    │
│  │  (cache-aware)         (standalone fallback)         │    │
│  │                                                      │    │
│  │  ──── SUGGESTION_PROMPT ────                         │    │
│  │  ──── 12 filter rules ──────                         │    │
│  │  ──── getFilterReason() ────                         │    │
│  └────────────────────┬─────────────────────────────────┘    │
│                       │                                      │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  FollowupController (framework-agnostic)             │    │
│  │  300ms delay → show as ghost text                    │    │
│  │                                                      │    │
│  │  Tab    → accept (fill input)                        │    │
│  │  Enter  → accept + submit                            │    │
│  │  Right  → accept (fill input)                        │    │
│  │  Type   → dismiss + abort speculation                │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Telemetry (PromptSuggestionEvent)                   │    │
│  │  outcome, accept_method, timing, similarity,         │    │
│  │  keystroke, focus, suppression reason, prompt_id     │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

## Генерация подсказки

### LLM Prompt

```
[SUGGESTION MODE: Suggest what the user might naturally type next.]

FIRST: Read the LAST FEW LINES of the assistant's most recent message — that's where
next-step hints, tips, and actionable suggestions usually appear. Then check the user's
recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.
THE TEST: Would they think "I was just about to type that"?

PRIORITY: If the assistant's last message contains a tip or hint like "Tip: type X to ..."
or "type X to ...", extract X as the suggestion. These are explicit next-step hints.

EXAMPLES:
Assistant says "Tip: type post comments to publish findings" → "post comments"
Assistant says "type /review to start" → "/review"
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Task complete, obvious follow-up → "commit this" or "push it"

Format: 2-12 words, match the user's style. Or nothing.
Reply with ONLY the suggestion, no quotes or explanation.
```

### Правила фильтрации (12)

| Правило            | Пример блокировки                                   |
| ------------------ | --------------------------------------------------- |
| done               | "done"                                              |
| meta_text          | "nothing found", "no suggestion", "silence"         |
| meta_wrapped       | "(silence)", "[no suggestion]"                      |
| error_message      | "api error: 500"                                    |
| prefixed_label     | "Suggestion: commit"                                |
| too_few_words      | "hmm" (но позволяет "yes", "commit", "push" и т.д.) |
| too_many_words     | > 12 слов                                           |
| too_long           | >= 100 символов                                     |
| multiple_sentences | "Run tests. Then commit."                           |
| has_formatting     | newlines, markdown bold                             |
| evaluative         | "looks good", "thanks" (с границами слов \b)        |
| ai_voice           | "Let me...", "I'll...", "Here's..."                 |

### Guard условия

**AppContainer useEffect (13 проверок в коде):**

| Guard                | Проверка                                            |
| -------------------- | --------------------------------------------------- |
| Settings toggle      | `enableFollowupSuggestions`                         |
| Non-interactive      | `config.isInteractive()`                            |
| SDK mode             | `!config.getSdkMode()`                              |
| Streaming transition | `Responding → Idle` (2 проверки)                    |
| API error (history)  | `historyManager.history[last]?.type !== 'error'`    |
| API error (pending)  | `!pendingGeminiHistoryItems.some(type === 'error')` |
| Confirmation dialogs | shell + general + loop detection (3 проверки)       |
| Permission dialog    | `isPermissionsDialogOpen`                           |
| Elicitation          | `settingInputRequests.length === 0`                 |
| Plan mode            | `ApprovalMode.PLAN`                                 |

**Внутри generatePromptSuggestion():**

| Guard              | Проверка         |
| ------------------ | ---------------- |
| Early conversation | `modelTurns < 2` |

**Отдельные feature flags (не в guard блоке):**

| Flag                 | Контролирует                                           |
| -------------------- | ------------------------------------------------------ |
| `enableCacheSharing` | Использовать forked query или fallback на generateJson |
| `enableSpeculation`  | Начинать спекуляцию при отображении подсказки          |

## Управление состоянием

### FollowupState

```typescript
interface FollowupState {
  suggestion: string | null;
  isVisible: boolean;
  shownAt: number; // timestamp для телеметрии
}
```

### FollowupController

Фреймворк-агностичный контроллер, общий для CLI (Ink) и WebUI (React):

- `setSuggestion(text)` — 300ms отложенное отображение, null очищает немедленно
- `accept(method)` — очищает состояние, вызывает `onAccept` через microtask, 100ms debounce lock
- `dismiss()` — очищает состояние, логирует `ignored` телеметрию
- `clear()` — жёсткий сброс всего состояния + таймеров
- `Object.freeze(INITIAL_FOLLOWUP_STATE)` предотвращает случайную мутацию

## Взаимодействие с клавиатурой

| Клавиша     | CLI                         | WebUI                                |
| ----------- | --------------------------- | ------------------------------------ |
| Tab         | Fill input (no submit)      | Fill input (no submit)               |
| Enter       | Fill + submit               | Fill + submit (`explicitText` param) |
| Right Arrow | Fill input (no submit)      | Fill input (no submit)               |
| Typing      | Dismiss + abort speculation | Dismiss                              |
| Paste       | Dismiss + abort speculation | Dismiss                              |

### Примечание о key binding

Tab handler использует `key.name === 'tab'` явно (не `ACCEPT_SUGGESTION` matcher), потому что `ACCEPT_SUGGESTION` также соответствует Enter, который должен fall through к SUBMIT handler.

## Телеметрия

### PromptSuggestionEvent

| Поле                       | Тип                         | Описание                            |
| -------------------------- | --------------------------- | ----------------------------------- |
| outcome                    | accepted/ignored/suppressed | Финальный результат                 |
| prompt_id                  | string                      | По умолчанию: 'user_intent'         |
| accept_method              | tab/enter/right             | Как пользователь принял             |
| time_to_accept_ms          | number                      | Время от показа до принятия         |
| time_to_ignore_ms          | number                      | Время от показа до отклонения       |
| time_to_first_keystroke_ms | number                      | Время до первого нажатия при показе |
| suggestion_length          | number                      | Количество символов                 |
| similarity                 | number                      | 1.0 для accept, 0.0 для ignore      |
| was_focused_when_shown     | boolean                     | Терминал имел фокус                 |
| reason                     | string                      | Для suppressed: имя правила фильтра |

### SpeculationEvent

| Поле                     | Тип                     | Описание                          |
| ------------------------ | ----------------------- | --------------------------------- |
| outcome                  | accepted/aborted/failed | Результат спекуляции              |
| turns_used               | number                  | API round-trips                   |
| files_written            | number                  | Файлы в overlay                   |
| tool_use_count           | number                  | Выполненные инструменты           |
| duration_ms              | number                  | Wall-clock время                  |
| boundary_type            | string                  | Что остановило спекуляцию         |
| had_pipelined_suggestion | boolean                 | Сгенерирована следующая подсказка |

## Feature Flags и настройки

| Настройка                   | Тип     | По умолчанию | Описание                                                                                              |
| --------------------------- | ------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `enableFollowupSuggestions` | boolean | true         | Master toggle для подсказок промптов                                                                  |
| `enableCacheSharing`        | boolean | true         | Использовать cache-aware forked queries                                                               |
| `enableSpeculation`         | boolean | false        | Predictive execution engine                                                                           |
| `fastModel` (top-level)     | string  | ""           | Модель для всех фоновых задач (пусто = использовать основную модель). Установка через `/model --fast` |

### Фильтрация Internal Prompt ID

Фоновые операции используют dedicated prompt IDs (`INTERNAL_PROMPT_IDS` в `utils/internalPromptIds.ts`) для предотвращения появления их API трафика и вызовов инструментов в пользовательском UI:

| Prompt ID           | Используется               |
| ------------------- | -------------------------- |
| `prompt_suggestion` | Генерация подсказки        |
| `forked_query`      | Cache-aware forked queries |
| `speculation`       | Движок спекуляции          |

**Применяемая фильтрация:**

- `loggingContentGenerator` — пропускает `logApiRequest` и логирование взаимодействия OpenAI для internal IDs
- `logApiResponse` / `logApiError` — пропускает `chatRecordingService.recordUiTelemetryEvent`
- `logToolCall` — пропускает `chatRecordingService.recordUiTelemetryEvent`
- `uiTelemetryService.addEvent` — **не фильтруется** (обеспечивает работу отслеживания токенов `/stats`)

### Thinking Mode

Thinking/reasoning явно отключён (`thinkingConfig: { includeThoughts: false }`) для всех путей фоновых задач:

- **Forked query path** (`createForkedChat`) — переопределяет `thinkingConfig` в клонированном `generationConfig`, покрывая как генерацию подсказки, так и спекуляцию
- **BaseLlm fallback path** (`generateViaBaseLlm`) — per-request config переопределяет настройки thinking базового генератора контента

Это безопасно, потому что:

- Cache prefix определяется systemInstruction + tools + history, не `thinkingConfig` — cache hits не затронуты
- Все бэкенды (Gemini, OpenAI-compatible, Anthropic) обрабатывают `includeThoughts: false` опусканием поля thinking — никаких ошибок API на моделях без поддержки thinking
- Генерация подсказки и спекуляция не выигрывают от reasoning токенов
