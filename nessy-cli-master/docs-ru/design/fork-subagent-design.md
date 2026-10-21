---
title: "Fork Subagent Design (Дизайн форк-субагента)"
---

# Fork Subagent Design (Дизайн форк-субагента)

> Неявный форк-субагент, который наследует полный контекст разговора родителя и разделяет кэш промптов для экономичного выполнения параллельных задач.

## Обзор

Когда вызывается инструмент Agent без `subagent_type`, это запускает неявный **fork** — фоновый субагент, который наследует историю разговора родителя, системный промпт и определения инструментов. Fork использует `CacheSafeParams` для обеспечения, что его API-запросы разделяют тот же префикс, что и у родителя, обеспечивая попадания кэша промптов DashScope.

## Архитектура

```
Разговор родителя: [SystemPrompt | Tools | Msg1 | Msg2 | ... | MsgN (model)]
                              ↑ идентичный префикс для всех forks ↑

Fork A: [...MsgN | placeholder results | "Research A"]  ← общий кэш
Fork B: [...MsgN | placeholder results | "Modify B"]    ← общий кэш
Fork C: [...MsgN | placeholder results | "Test C"]      ← общий кэш
```

## Ключевые компоненты

### 1. FORK_AGENT (`forkSubagent.ts`)

Конфигурация синтетического агента, не зарегистрирована в `builtInAgents`. Имеет резервный `systemPrompt`, но на практике использует рендеренный системный промпт родителя через `generationConfigOverride`.

### 2. Интеграция CacheSafeParams (`agent.ts` + `forkedQuery.ts`)

```
agent.ts (путь fork)
  │
  ├── getCacheSafeParams()          ← снимок generationConfig родителя
  │     ├── generationConfig        ← systemInstruction + tools + temp/topP
  │     └── history                 ← (не используется — мы строим extraHistory вместо этого)
  │
  ├── forkGenerationConfig          ← передаётся как generationConfigOverride
  └── forkToolsOverride             ← FunctionDeclaration[] извлечены из tools
        │
        ▼
  AgentHeadless.execute(context, signal, {
    extraHistory,                   ← история разговора родителя
    generationConfigOverride,       ← точный systemInstruction + tools родителя
    toolsOverride,                  ← точные объявления инструментов родителя
  })
        │
        ▼
  AgentCore.createChat(context, {
    extraHistory,
    generationConfigOverride,       ← обходит buildChatSystemPrompt()
  })                                   И пропускает getInitialChatHistory()
        │                              (extraHistory уже имеет контекст окружения)
        ▼
  new GeminiChat(config, generationConfig, startHistory)
                          ↑ байт-идентично config родителя
```

### 3. Построение истории (`agent.ts` + `forkSubagent.ts`)

`extraHistory` форка должен заканчиваться сообщением модели для поддержания чередования user/model API Gemini, когда `agent-headless` отправляет `task_prompt`.

Три случая:

| Родительская история заканчивается | Построение extraHistory                                                | task_prompt                    |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| `model` (без вызовов функций)      | `[...rawHistory]` (без изменений)                                      | `buildChildMessage(directive)` |
| `model` (с вызовами функций)       | `[...rawHistory, model(clone), user(responses+directive), model(ack)]` | `'Begin.'`                     |
| `user` (необычно)                  | `rawHistory.slice(0, -1)` (отбросить завершающий user)                 | `buildChildMessage(directive)` |

### 4. Предотвращение рекурсивного форка (`forkSubagent.ts`)

`isInForkChild()` сканирует историю разговора на наличие тега `<fork-boilerplate>`. Если найден, попытка форка отклоняется с сообщением об ошибке.

### 5. Фоновое выполнение (`agent.ts`)

Fork использует `void executeSubagent()` (fire-and-forget) и немедленно возвращает `FORK_PLACEHOLDER_RESULT` родителю. Ошибки в фоновой задаче перехватываются, логируются и отражаются в состоянии отображения.

## Поток данных

```
1. Модель вызывает инструмент Agent (без subagent_type)
2. agent.ts: import forkSubagent.js
3. agent.ts: getCacheSafeParams() → forkGenerationConfig + forkToolsOverride
4. agent.ts: построить extraHistory из getHistory(true) родителя
5. agent.ts: построить forkTaskPrompt (directive или 'Begin.')
6. agent.ts: createAgentHeadless(FORK_AGENT, ...)
7. agent.ts: void executeSubagent() — фон
8. agent.ts: вернуть FORK_PLACEHOLDER_RESULT родителю немедленно
9. Фон:
   a. AgentHeadless.execute(context, signal, {extraHistory, generationConfigOverride, toolsOverride})
   b. AgentCore.createChat() — использует generationConfig родителя (разделение кэша)
   c. runReasoningLoop() — использует объявления инструментов родителя
   d. Fork выполняет инструменты, производит результат
   e. updateDisplay() с финальным статусом
```

## Graceful Degradation (Плавная деградация)

Если `getCacheSafeParams()` возвращает null (первый ход, ещё нет истории), fork откатывается к:

- `FORK_AGENT.systemPrompt` для системной инструкции
- `prepareTools()` для объявлений инструментов

Это обеспечивает работу fork всегда, даже без разделения кэша.

## Файлы

| Файл                                                 | Роль                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/core/src/agents/runtime/forkSubagent.ts`   | Конфигурация FORK_AGENT, buildForkedMessages(), isInForkChild(), buildChildMessage() |
| `packages/core/src/tools/agent.ts`                   | Путь fork: получение CacheSafeParams, построение extraHistory, фоновое выполнение    |
| `packages/core/src/agents/runtime/agent-headless.ts` | Опции execute(): generationConfigOverride, toolsOverride                             |
| `packages/core/src/agents/runtime/agent-core.ts`     | CreateChatOptions.generationConfigOverride                                           |
| `packages/core/src/followup/forkedQuery.ts`          | Инфраструктура CacheSafeParams (существующая, без изменений)                         |
