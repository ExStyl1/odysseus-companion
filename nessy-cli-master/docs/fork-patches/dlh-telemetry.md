# dlh-telemetry

## AIDT

AIDT-6082 (интеграция), AIDT-6261 (восстановление после upstream 0.16)

## Зачем

Nessy отливает события сессии в DLH (Data Logging Hub) — внутренний
телеметрический хаб. Отливаются события: `session_start`, `agent_request`
(пользовательский запрос), `inference` (один LLM-запрос), `tool_call`,
`slash_command`, `session_end`. Это позволяет анализировать качество модели
и поведение инструментов на реальных сессиях.

После мерджа upstream 0.16 несколько аспектов отливки сломались:

1. **Коллизия `prompt_id` при `--continue`/resume.** `promptCount` начинался
   с 0 заново, поэтому `prompt_id = sessionId########0` совпадал с первым
   запросом исходной сессии, ломая группировку событий в DLH.

2. **`model_response` содержал только видимый текст.** Размышления модели
   (✦-блоки) и function calls терялись. DLH-контракт предполагает сырой
   полный ответ в `model_response` и пользовательский текст отдельно.

3. **Тайминги аппрува tool call не передавались.** `client_approve_sent_at`
   и `client_approve_received_at` не были реализованы, хотя поле уже
   существовало в контракте.

4. **Ошибочная эвристика определения `inference_type`.** Тип `recall_memory`
   определялся по наличию активного DLH-контекста — это ломалось при
   вложенных инференсах после upstream-изменений.

5. **Внутренние side-query попадали в DLH как `base`-инференсы.** Запросы
   prompt-suggestion, next-speaker, chat-compression и другие внутренние
   side-query логировались наравне с пользовательскими запросами.

## Extension-атрибуция

Для событий, порождённых сущностью из расширения, отливаются два поля:
`extension_name` и `extension_source` (= `ExtensionInstallMetadata.source`).
Покрыты три контракта:

- `tool_call` — MCP-инструмент (`mcp_server_name`), скил (`args.skill`)
  или сабагент (`args.subagent_type` у инструмента `agent`);
- `agent_request` — сабагент по `agent_name`;
- `slash_command` — команда по `event.command` (поля внутри `payload_json`).

**Вся резолюция — в форк-модуле**, через скан `config.getActiveExtensions()`
по имени сущности (`extension-info.ts`). Это сознательно сделано так, чтобы
не править upstream-менеджеры (`SkillManager` / `SubagentManager`), их загрузчики,
`AgentCore`/`AgentHeadless`, `SlashCommandEvent` или `slashCommandProcessor`.
Единственная точка подключения — `loggers.ts`.

**Caveat (precedence).** Матч по имени не моделирует перекрытие уровней: если
project/user-скил (или сабагент/команда) назван так же, как extension-овый,
атрибуция может ошибочно указать на расширение. Коллизия редка и влияет только
на телеметрию, не на поведение.

## Файлы

### Форк-модуль

- `packages/core/src/telemetry/nessy-dlh/` — весь модуль DLH: клиент,
  контракты (`contracts/`), контекст (`dlh-context.ts`), типы
  (`dlh-types.ts`), публичный API (`index.ts`, `nessy-dlh.ts`).
- `packages/core/src/telemetry/nessy-dlh/inference-type-context.ts` —
  `AsyncLocalStorage`-маркер для разграничения `recall_memory` от `base`-
  инференсов; `runInRecallMemoryInference()` оборачивает recall side-query,
  `isRecallMemoryInference()` читает маркер.
- `packages/core/src/telemetry/nessy-dlh/response-extractors.ts` —
  `extractThoughtText()` и `extractFullModelResponseJson()`: извлечение
  thought-парт и полного JSON-ответа из `GenerateContentResponse`. Вынесено
  из `loggingContentGenerator.ts`, чтобы не добавлять приватные методы
  в upstream-класс.
- `packages/core/src/telemetry/nessy-dlh/tool-approval-timings.ts` —
  module-level Map `callId → {sentAt?, receivedAt?}` с функциями
  `trackApprovalSent`, `trackApprovalReceived`, `getAndClearApprovalTiming`.
  Вынесено из `CoreToolScheduler`, чтобы не добавлять приватное поле
  в upstream-класс.
- `packages/core/src/telemetry/nessy-dlh/extension-info.ts` — резолверы
  extension-атрибуции (`resolveMcpExtensionInfo`, `resolveSkillExtensionInfo`,
  `resolveSubagentExtensionInfo`, `resolveCommandExtensionInfo`) через скан
  `getActiveExtensions()`. Никаких правок upstream-менеджеров.
- `scripts/dlh/test-extension/` — одноразовое расширение (skill + subagent +
  command + zero-dep MCP-сервер) и `README.md` для ручной проверки
  extension-атрибуции во всех сценариях.

### Точки подключения (upstream-файлы, минимальный diff)

- `packages/core/src/telemetry/loggers.ts` — `logApiInference()`: переход
  с DLH-context-эвристики на `isRecallMemoryInference()`, фильтрация
  внутренних side-query (по `isInternalPromptId`), раздельная передача
  `model_response` / `user_visible_text` / `user_visible_thought_text`.
  Также extension-атрибуция: `logDlhToolCall` (switch по
  skill/agent/MCP), `logDlhAgentRequest` (по `agent_name`), `logSlashCommand`
  (по `event.command`) — все резолвят через форк-модуль `extension-info.ts`.
- `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts`
  — импорт `extractFullModelResponseJson` и `extractThoughtText` из форк-
  модуля; результаты пробрасываются в `InferenceLogEvent`.
- `packages/core/src/core/coreToolScheduler.ts` — импорт `trackApprovalSent`,
  `trackApprovalReceived`, `getAndClearApprovalTiming`; вызовы при смене
  статуса `awaiting_approval` и при эмите `logDlhToolCall`.
- `packages/core/src/memory/relevanceSelector.ts` — recall side-query
  обёрнут в `runInRecallMemoryInference()`.
- `packages/cli/src/gemini.tsx` — при resume считает количество
  user-messages в восстановленной истории и передаёт в `SessionStatsProvider`
  как `initialPromptCount`.
- `packages/cli/src/ui/contexts/SessionContext.tsx` — `SessionStatsProvider`
  принимает `initialPromptCount` и инициализирует `promptCount` из него.
- `scripts/dlh/proxy.py` — локальный отладочный proxy для перехвата DLH-трафика.

Кодовые точки помечены `// [nessy-fork] dlh-telemetry`.

## Откат

Если DLH-интеграция перестанет быть нужной:

1. Удалить `packages/core/src/telemetry/nessy-dlh/` целиком
   (включая `response-extractors.ts` и `tool-approval-timings.ts`).
2. Убрать импорты и вызовы `logDlhToolCall`, `trackApprovalSent`,
   `trackApprovalReceived`, `getAndClearApprovalTiming` из `coreToolScheduler.ts`.
3. Убрать импорты и вызовы `extractFullModelResponseJson`, `extractThoughtText`
   и поля `user_visible_text` / `user_visible_thought_text` из `loggingContentGenerator.ts`.
4. Убрать DLH-секцию из `loggers.ts` (`InferenceLogEvent`, `logApiInference`,
   `logMaxTurnsReached` и DLH-вызовы в upstream-функциях).
5. Убрать `initialPromptCount` из `gemini.tsx` и `SessionContext.tsx`.
6. Убрать `runInRecallMemoryInference` из `relevanceSelector.ts`.
7. Удалить `scripts/dlh/proxy.py` и `scripts/dlh/test-extension/`.
8. Для отката только extension-атрибуции: удалить `extension-info.ts`
   (+ тест), убрать `extension_name`/`extension_source` из контрактов
   `tool_call`/`agent_request` (`dlh-types.ts`, `nessy-dlh.ts`) и три
   резолв-блока в `loggers.ts` — больше нигде в upstream правок нет.
9. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен (внутренняя телеметрия Tinkoff/T-Bank).
