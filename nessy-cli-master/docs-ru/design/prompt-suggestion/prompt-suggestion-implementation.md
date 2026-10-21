# Статус реализации подсказок промптов (NES)

> Отслеживает статус реализации функции подсказки промптов (NES) во всех пакетах.

## Core модуль (`packages/core/src/followup/`)

| Компонент                | Статус  | Строки | Описание                                                           |
| ------------------------ | ------- | ------ | ------------------------------------------------------------------ |
| `followupState.ts`       | ✅ Done | ~230   | Фреймворк-агностичный контроллер с таймером/debounce               |
| `suggestionGenerator.ts` | ✅ Done | ~260   | Генерация LLM + 12 правил фильтрации + поддержка forked query      |
| `forkedQuery.ts`         | ✅ Done | ~240   | CacheSafeParams + createForkedChat + runForkedQuery                |
| `overlayFs.ts`           | ✅ Done | ~140   | Copy-on-write overlay файловая система                             |
| `speculationToolGate.ts` | ✅ Done | ~150   | Принудительное соблюдение границ инструментов с AST shell парсером |
| `speculation.ts`         | ✅ Done | ~540   | Движок спекуляции с pipelined подсказкой + override модели         |

## CLI интеграция (`packages/cli/`)

| Компонент                    | Статус  | Описание                                                     |
| ---------------------------- | ------- | ------------------------------------------------------------ |
| `AppContainer.tsx`           | ✅ Done | Генерация подсказок, жизненный цикл спекуляции, UI рендеринг |
| `InputPrompt.tsx`            | ✅ Done | Принятие Tab/Enter/Right Arrow, отклонение + прерывание      |
| `Composer.tsx`               | ✅ Done | Передача props                                               |
| `UIStateContext.tsx`         | ✅ Done | promptSuggestion + dismissPromptSuggestion                   |
| `useFollowupSuggestions.tsx` | ✅ Done | React hook с телеметрией + отслеживанием нажатий             |
| `settingsSchema.ts`          | ✅ Done | 3 feature flag + настройка fastModel                         |
| `settings.schema.json`       | ✅ Done | VSCode settings schema                                       |

## WebUI интеграция (`packages/webui/`)

| Компонент                   | Статус  | Описание                                    |
| --------------------------- | ------- | ------------------------------------------- |
| `InputForm.tsx`             | ✅ Done | Tab/Enter/Right Arrow + explicitText submit |
| `useFollowupSuggestions.ts` | ✅ Done | React hook с поддержкой onOutcome           |
| `followup.ts`               | ✅ Done | Subpath entry                               |
| `components.css`            | ✅ Done | Стилизация ghost text                       |
| `vite.config.followup.ts`   | ✅ Done | Отдельная конфигурация сборки               |

## Телеметрия (`packages/core/src/telemetry/`)

| Компонент               | Статус  | Описание             |
| ----------------------- | ------- | -------------------- |
| `PromptSuggestionEvent` | ✅ Done | 10 полей             |
| `SpeculationEvent`      | ✅ Done | 7 полей              |
| `logPromptSuggestion()` | ✅ Done | OpenTelemetry logger |
| `logSpeculation()`      | ✅ Done | OpenTelemetry logger |

## Покрытие тестами

| Тестовый файл                 | Тесты | Описание                                                                                |
| ----------------------------- | ----- | --------------------------------------------------------------------------------------- |
| `followupState.test.ts`       | 14    | Таймер контроллера, debounce, callback принятия, onOutcome, очистка                     |
| `suggestionGenerator.test.ts` | 16    | Все 12 правил фильтрации + граничные случаи + false positives                           |
| `overlayFs.test.ts`           | 15    | COW запись, разрешение чтения, применение, очистка, path traversal                      |
| `speculationToolGate.test.ts` | 27    | Категории инструментов, approval mode, shell AST, переписывание пути                    |
| `forkedQuery.test.ts`         | 6     | Сохранение/получение/очистка параметров кэша, глубокое клонирование, определение версии |
| `speculation.test.ts`         | 7     | Граничные случаи ensureToolResultPairing                                                |
| `smoke.test.ts`               | 21    | Cross-module E2E: фильтр + overlay + toolGate + кэш + pairing                           |
| `InputPrompt.test.tsx`        | 4     | Tab, Enter+submit, Right Arrow, guard completion                                        |

## История аудита

| Раунд           | Найдено проблем | Исправлено проблем                                            |
| --------------- | --------------- | ------------------------------------------------------------- |
| R1-R4           | 10              | 10 (rule engine → LLM, упрощение состояния)                   |
| R5-R6           | 2               | 2 (конфликт keybinding Enter, телеметрия Right Arrow)         |
| R7-R8           | 3               | 3 (телеметрия WebUI, мёртвый тип, покрытие тестами)           |
| R9              | 0               | — (схождение)                                                 |
| R10-R11         | 1               | 1 (зависимость historyManager)                                |
| R12-R13         | 1               | 1 (границы слов evaluative regex)                             |
| Phase 1+2 R1-R4 | 20+             | 20+ (обход разрешений, безопасность overlay, race conditions) |
| **Всего**       | **37+**         | **37+**                                                       |

## Выравнивание Claude Code

| Функция                             | Выравнивание | Примечания                               |
| ----------------------------------- | ------------ | ---------------------------------------- |
| Текст подсказки                     | 100%         | Идентично (только бренд нейм)            |
| 12 правил фильтрации                | 100%+        | Улучшение границ слов \b                 |
| UI взаимодействие (Tab/Enter/Right) | 100%         |                                          |
| Guard условия                       | 100%         | 13 проверок                              |
| Телеметрия                          | 100%         | 10+7 полей                               |
| Разделение кэша                     | ✅           | DashScope cache_control                  |
| Спекуляция                          | ✅           | COW overlay + tool gating                |
| Pipelined подсказка                 | ✅           | Генерируется после завершения спекуляции |
| Управление состоянием               | 100%+        | Паттерн Controller, Object.freeze        |
