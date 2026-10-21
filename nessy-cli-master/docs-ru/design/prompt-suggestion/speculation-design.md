---
title: "Дизайн движка спекуляции"
---

# Дизайн движка спекуляции

> Спекулятивно выполняет принятую подсказку до подтверждения пользователя, используя copy-on-write изоляцию файлов. Результаты появляются мгновенно, когда пользователь нажимает Tab.

## Обзор

Когда показана подсказка промпта, **движок спекуляции** немедленно начинает выполнять её в фоне, используя forked GeminiChat. Запись файлов идёт во временную overlay директорию. Если пользователь принимает подсказку, файлы overlay копируются в реальную файловую систему, а спекулированная конверсация инжектируется в основную историю чата. Если пользователь вводит что-то другое, спекуляция прерывается и overlay очищается.

## Архитектура

```
User sees suggestion "commit this"
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│  startSpeculation()                                             │
│                                                                 │
│  ┌───────────────────┐    ┌──────────────────────┐              │
│  │ Forked GeminiChat │    │  OverlayFs           │              │
│  │ (cache-shared)    │    │  /tmp/nessy-         │              │
│  │                   │    │   speculation/       │              │
│  │  systemInstruction│    │   {pid}/{id}/        │              │
│  │  + tools          │    │                      │              │
│  │  + history prefix │    │  COW: first write    │              │
│  │                   │    │  copies original     │              │
│  └────────┬──────────┘    └──────────┬───────────┘              │
│           │                          │                          │
│           ▼                          │                          │
│  ┌───────────────────────────────────┴───────────────────────┐  │
│  │  Speculative Loop (max 20 turns, 100 messages)            │  │
│  │                                                           │  │
│  │  Model response                                           │  │
│  │       │                                                   │  │
│  │       ▼                                                   │  │
│  │  ┌────────────────────────────────────────────────────┐   │  │
│  │  │  speculationToolGate                               │   │  │
│  │  │                                                    │   │  │
│  │  │  Read/Grep/Glob/LS/LSP → allow (+ overlay read)    │   │  │
│  │  │  Edit/WriteFile → redirect to overlay              │   │  │
│  │  │    (only in auto-edit mode)                   │   │  │
│  │  │  Shell → AST check read-only? allow : boundary     │   │  │
│  │  │  WebFetch/WebSearch → boundary                     │   │  │
│  │  │  Agent/Skill/Memory/Ask → boundary                 │   │  │
│  │  │  Unknown/MCP → boundary                            │   │  │
│  │  └────────────────────────────────────────────────────┘   │  │
│  │       │                                                   │  │
│  │       ▼                                                   │  │
│  │  Tool execution: toolRegistry.getTool → build → execute   │  │
│  │  (bypasses CoreToolScheduler — gated by toolGate)         │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  On completion → generatePipelinedSuggestion()                  │
└─────────────────────────────────────────────────────────────────┘
           │
           │  User presses Tab / Enter
           ▼
     ┌─── status === 'completed'? ────────────┐
     │ YES                      NO (boundary) │
     ▼                                        ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│  acceptSpeculation()    │  │  Discard speculation    │
│                         │  │  abort + cleanup        │
│  1. applyToReal()       │  │  Submit query normally  │
│  2. ensureToolPairing() │  │  (addMessage)           │
│  3. addHistory()        │  └─────────────────────────┘
│  4. render tool_group   │
│  5. cleanup overlay     │
│  6. pipelined suggest   │
└─────────────────────────┘
           │
           │  User types instead
           ▼
┌──────────────────────────────────────────────────────────────┐
│  abortSpeculation()                                          │
│                                                              │
│  1. abortController.abort() — cancel LLM call                │
│  2. overlayFs.cleanup() — delete temp directory              │
│  3. Update speculation state (no telemetry on abort)         │
└──────────────────────────────────────────────────────────────┘
```

## Copy-on-Write Overlay

```
Real CWD: /home/user/project/
Overlay:  /tmp/nessy-speculation/12345/a1b2c3d4/

Write to src/app.ts:
  1. Copy /home/user/project/src/app.ts → overlay/src/app.ts (first time only)
  2. Tool writes to overlay/src/app.ts

Read from src/app.ts:
  - If in writtenFiles → read from overlay/src/app.ts
  - Otherwise → read from /home/user/project/src/app.ts

New file (src/new.ts):
  - Create overlay/src/new.ts directly (no original to copy)

Accept:
  - copyFile(overlay/src/app.ts → /home/user/project/src/app.ts)
  - copyFile(overlay/src/new.ts → /home/user/project/src/new.ts)
  - rm -rf overlay/

Abort:
  - rm -rf overlay/
```

## Безопасность Tool Gate

| Инструмент                                                 | Действие | Условие                                                      |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| read_file, grep, glob, ls, lsp                             | allow    | Read paths resolved through overlay                          |
| edit, write_file                                           | redirect | Только в auto-edit                                           |
| edit, write_file                                           | boundary | В default / plan approval mode                               |
| shell                                                      | allow    | `isShellCommandReadOnlyAST()` возвращает true                |
| shell                                                      | boundary | Non-read-only команды                                        |
| web_fetch, web_search                                      | boundary | Сетевые запросы требуют согласия пользователя                |
| agent, skill, memory, ask_user, todo_write, exit_plan_mode | boundary | Нельзя взаимодействовать с пользователем во время спекуляции |
| Unknown / MCP tools                                        | boundary | Safe default                                                 |

### Переписывание пути

- **Write tools**: `rewritePathArgs()` перенаправляет `file_path` в overlay через `overlayFs.redirectWrite()`
- **Read tools**: `resolveReadPaths()` перенаправляет `file_path` в overlay через `overlayFs.resolveReadPath()`, если было записано ранее
- **Сбой переписывания**: Обрабатывается как boundary (например, абсолютный путь вне cwd выбрасывает в `redirectWrite`)

## Обработка Boundary

Когда boundary достигается mid-turn:

1. Уже выполненные вызовы инструментов сохраняются (отслеживание по индексу, не по имени)
2. Невыполненные function calls удаляются из сообщения модели
3. Частичные ответы инструментов добавляются в историю
4. `ensureToolResultPairing()` проверяет полноту перед инъекцией

## Pipelined подсказка

После завершения спекуляции (без boundary), второй LLM вызов генерирует **следующую** подсказку:

```
Context: original conversation + "commit this" + speculated messages
→ LLM predicts: "push it"
→ Stored in state.pipelinedSuggestion
→ On accept: setPromptSuggestion("push it") — appears instantly
```

Это позволяет Tab-Tab-Tab workflow, где каждое принятие немедленно показывает следующий шаг.

Pipelined подсказка переиспользует экспортированную константу `SUGGESTION_PROMPT` из `suggestionGenerator.ts` (не локальную копию) для обеспечения согласованного качества с начальными подсказками.

## Fast модель

`startSpeculation` принимает опциональный параметр `options.model`, передаваемый через `runSpeculativeLoop` и `generatePipelinedSuggestion` в `runForkedQuery`. Настраивается через top-level настройку `fastModel` (пусто = использовать основную модель). Та же `fastModel` используется для всех фоновых задач: генерация подсказки, спекуляция и pipelined подсказки. Установка через `/model --fast <name>` или `settings.json`.

## UI рендеринг

Когда спекуляция завершается, `acceptSpeculation` рендерит результаты через `historyManager.addItem()`:

- **Сообщения пользователя**: рендерятся как `type: 'user'` items
- **Текст модели**: рендерится как `type: 'gemini'` items
- **Вызовы инструментов**: рендерятся как `type: 'tool_group'` items со структурированными `IndividualToolCallDisplay` записями (имя инструмента, описание аргумента, результат текста, статус)

Это показывает пользователю полный вывод спекуляции, включая детали вызова инструментов, не только plain text.

## Forked Query (разделение кэша)

### CacheSafeParams

```typescript
interface CacheSafeParams {
  generationConfig: GenerateContentConfig; // systemInstruction + tools
  history: Content[]; // curated, max 40 entries
  model: string;
  version: number; // increments on config changes
}
```

- Сохраняется после каждого успешного основного turn в `GeminiClient.sendMessageStream()`
- Очищается при `startChat()` / `resetChat()` для предотвращения cross-session leakage
- History обрезано до 40 записей; `createForkedChat` использует shallow copies (параметры уже deep-cloned snapshots)
- Thinking mode явно отключён (`thinkingConfig: { includeThoughts: false }`) — reasoning токены не нужны для спекуляции и wasted бы cost/latency. Это не влияет на matching cache prefix (определяется systemInstruction + tools + history только)
- Определение версии через `JSON.stringify` сравнение systemInstruction + tools

### Механизм кэширования

DashScope уже включает prefix caching через:

- `X-DashScope-CacheControl: enable` header
- `cache_control: { type: 'ephemeral' }` annotations на сообщениях и инструментах

Forked `GeminiChat` использует идентичный `generationConfig` (включая инструменты) и history prefix, поэтому существующий механизм кэширования DashScope автоматически производит cache hits.

## Константы

| Константа                | Значение | Описание                                      |
| ------------------------ | -------- | --------------------------------------------- |
| MAX_SPECULATION_TURNS    | 20       | Максимум API round-trips                      |
| MAX_SPECULATION_MESSAGES | 100      | Максимум сообщений в speculated history       |
| SUGGESTION_DELAY_MS      | 300      | Задержка перед показом подсказки              |
| ACCEPT_DEBOUNCE_MS       | 100      | Debounce lock для быстрых принятий            |
| MAX_HISTORY_FOR_CACHE    | 40       | Записи history, сохраняемые в CacheSafeParams |

## Структура файлов

```
packages/core/src/followup/
├── followupState.ts          # Фреймворк-агностичный контроллер состояния
├── suggestionGenerator.ts    # Генерация подсказок на LLM + 12 правил фильтрации
├── forkedQuery.ts            # Cache-aware forked query инфраструктура
├── overlayFs.ts              # Copy-on-write overlay файловая система
├── speculationToolGate.ts    # Принудительное соблюдение границ инструментов
├── speculation.ts            # Движок спекуляции (start/accept/abort)
└── index.ts                  # Экспорт модуля
```
