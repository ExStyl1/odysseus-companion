# Дизайн: Резюме использования инструментов

> Быстрые метки модели для параллельных пакетов инструментов — мотивация, конкурентный анализ с Claude Code, архитектура и обоснование append-only Static которое привело к текущему рендерингу full-mode.
>
> Документация пользователя: [Резюме использования инструментов](../users/work/features/tool-use-summaries.md).

## 1. Краткое резюме

После завершения каждого пакета инструментов Nessy CLI запускает короткий вызов быстрой модели который возвращает git-commit-subject-style метку суммаризирующую пакет. Метка показывается как inline dim `● <label>` строка в full mode и заменяет заголовок `Tool × N` в compact mode. Генерация работает fire-and-forget параллельно со стримом следующего хода API, поэтому её ~1с задержка скрыта за стримингом основной модели.

| Измерение             | Claude Code                                                           | Nessy CLI                                                                                  |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Точка триггера        | `query.ts` — после завершения пакета инструментов                      | `useGeminiStream.ts` → `handleCompletedTools` — та же точка жизненного цикла                |
| Модель генерации      | Haiku через `queryHaiku`                                                | Настроенная `fastModel` через `GeminiClient.generateContent`                               |
| Поведение subagent    | `!toolUseContext.agentId` — только главная сессия                      | Неявно — subagents запускаются через `agents/runtime/`, не `useGeminiStream`               |
| Планирование          | Fire-and-forget, awaited прямо перед эмиссией стрима следующего хода   | Fire-and-forget, добавлено в историю при разрешении                                        |
| Форма вывода          | `ToolUseSummaryMessage` выдаётся в SDK стрим                           | `HistoryItemToolUseSummary` добавлено в UI историю + factory экспортирован для будущего SDK |
| Gate                  | `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` env, по умолчанию **off**        | `experimental.emitToolUseSummaries` setting (по умолчанию **on**) + env override           |
| Основной потребитель  | Mobile / SDK клиенты                                                   | CLI compact mode + full mode, будущее SDK                                                  |
| Prompt                | Git-commit-subject, past tense, most distinctive noun (verbatim port)  | Идентичный системный prompt                                                                |
| Усечение ввода        | 300 символов на поле инструмента через `truncateJson`                  | Идентично                                                                                  |
| Префикс намерения     | Первые 200 символов последнего сообщения ассистента                    | Идентично                                                                                  |
| Кэширование prompt    | `enablePromptCaching: true` на вызове Haiku                            | Ещё не подключено (forked-agent route доступен; помечено как future optimization)          |
| Постобработка метки   | Сырой текст модели                                                     | `cleanSummary` (strips markdown, quotes, error-prefixes; caps at 100 chars, ReDoS-bounded) |
| Персистентность сессии | Только стрим; каждая сессия регенерирует                              | UI история только; `ChatRecordingService` не персистирует `tool_use_summary` записи        |

## 2. Анализ реализации Claude Code

### 2.1 Поток

Claude Code запускает цикл инструментов в `query.ts`. После выполнения пакета инструментов и нормализации результатов, функция-генератор ответвляет вызов Haiku, держит pending promise на `nextPendingToolUseSummary`, и продолжает с вызовом API следующего хода. Задержка Haiku (~1с) перекрывается со стримингом основной модели (5-30с), поэтому пользователь видит нулевую добавленную задержку. Прямо перед эмиссией контента следующего хода, генератор awaits pending summary и выдаёт `tool_use_summary` сообщение в стрим.

```
tool_batch_complete → fork queryHaiku (fire-and-forget)
                          ↓
               next_turn_stream_starts
                          ↓
       ← summary Promise resolves during streaming →
                          ↓
       await pendingToolUseSummary → yield ToolUseSummaryMessage
                          ↓
                continue with next turn
```

### 2.2 Ключевые файлы исходного кода

| Компонент       | Файл                                                       | Ключевая логика                                                                               |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Генератор       | `services/toolUseSummary/toolUseSummaryGenerator.ts:45-97` | `generateToolUseSummary({ tools, signal, isNonInteractiveSession, lastAssistantText })`       |
| Триггер         | `query.ts:1411-1482`                                       | Guard по `emitToolUseSummaries` gate + no-subagent; fork Haiku; carry promise                 |
| Await + emit    | `query.ts:1055-1060`                                       | Await `pendingToolUseSummary` на границе next-turn, yield message                             |
| Message factory | `utils/messages.ts:5105-5116`                              | `createToolUseSummaryMessage(summary, precedingToolUseIds)`                                   |
| Feature gate    | `query/config.ts:23,36-38`                                 | `emitToolUseSummaries: isEnvTruthy(CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES)`                      |

### 2.3 Решения дизайна

1. **Всегда генерировать когда gate включён, независимо от состояния compact/detail.** Summary — артефакт уровня стрима; UI решает рендерить ли его.
2. **Emit как first-class тип сообщения.** `tool_use_summary` сидит наряду с `user`, `assistant`, `tool_result` в SDK стриме с полем `precedingToolUseIds` для корреляции потребителей с пакетом.
3. **Subagents исключены.** `!toolUseContext.agentId` — вывод subagent агрегируется upstream; отдельные пакеты subagent производили бы шумные метки которые никогда не surfaced в primary UI.
4. **По умолчанию off.** Env-only gate держит стоимость на нуле если только downstream SDK потребитель не opt-in. Сам терминал CC не рендерит сообщение.
5. **Усечение ввода на 300 символов на поле.** Покрывает доминирующий риск стоимости — один большой результат инструмента раздувающий prompt — сохраняя достаточно сигнала для метки.

## 3. Реализация Nessy CLI

### 3.1 Поток

Nessy CLI хукает ту же точку жизненного цикла (`useGeminiStream.handleCompletedTools`) но рендерит на обеих сторонах `ui.compactMode` поэтому функция полезна пользователям CLI без любой SDK plumbing.

```
tool_batch_complete (handleCompletedTools)
           ↓
  config.getEmitToolUseSummaries()?
           ↓
   fork generateToolUseSummary (fire-and-forget)
           ↓
  submitQuery() для следующего хода (стриминг начинается)
           ↓
   ← summary Promise resolves during streaming →
           ↓
  addItem({type:'tool_use_summary', summary, precedingToolUseIds})
           ↓
  HistoryItemDisplay рендерит:
    compactMode=false → ● <label> standalone строка
    compactMode=true  → hidden; MainContent lookup инжектирует в CompactToolGroupDisplay header
```

### 3.2 Ключевые файлы исходного кода

| Компонент           | Файл                                                                  | Ключевая логика                                                                 |
| ------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Service             | `packages/core/src/services/toolUseSummary.ts`                        | `generateToolUseSummary`, `truncateJson`, `cleanSummary`, message factory     |
| Config gate         | `packages/core/src/config/config.ts:getEmitToolUseSummaries`          | Env override → settings → default (true)                                      |
| Trigger             | `packages/cli/src/ui/hooks/useGeminiStream.ts:handleCompletedTools`   | Fires fast-model call, addItem on resolve                                     |
| Full-mode render    | `packages/cli/src/ui/components/HistoryItemDisplay.tsx`               | Рендерит `● <label>` строку когда `!compactMode`                              |
| Compact-mode lookup | `packages/cli/src/ui/components/MainContent.tsx`                      | `summaryByCallId` map → `compactLabel` prop для каждого tool_group            |
| Compact header      | `packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx` | Заменяет default `Tool × N` на `<Summary> · N tools` когда метка присутствует |
| Merge handling      | `packages/cli/src/ui/utils/mergeCompactToolGroups.ts`                 | Treats `tool_use_summary` как hidden-in-compact для adjacency                 |
| UI type             | `packages/cli/src/ui/types.ts:HistoryItemToolUseSummary`              | `{ type: 'tool_use_summary', summary, precedingToolUseIds }`                  |

### 3.3 Ограничение append-only `<Static>`

Центральное архитектурное решение в этом MR — **почему full-mode метка — отдельный элемент истории не decoration на самом tool_group**.

Nessy CLI рендерит transcript через Ink's `<Static>`. Static append-only: как только элемент закоммичен в terminal buffer, Ink не будет перерисовывать эту область если только не вызван `refreshStatic()` для очистки и перерисовки всего transcript. Это performance модель на которую полагается CLI — static элементы не перерисовываются на каждом нажатии клавиши.

Теперь рассмотрим тайминг вызова fast-model:

```
T0   tool batch завершается, tool_group pushed в историю
T0+ε tool_group рендерится через <Static> и коммитится в buffer
T0+1s fast-model call разрешается с меткой
```

В T0+1s, мы не можем ретроактивно добавить метку к уже закоммиченному tool_group. Два варианта:

1. **Обновить props tool_group + вызвать `refreshStatic()`.** Работает, но вызывает full transcript repaint на каждом пакете — одна из самых дорогих UI операций в приложении. Видимый flash. Неприемлемо для cosmetic метки.
2. **Рендерить summary как свой собственный новый элемент истории добавленный _после_ tool_group.** Static handles this naturally — новые элементы добавляются cleanly, нет repaint.

Этот MR берёт вариант 2 в full mode. Запись `tool_use_summary` — реальный элемент истории, рендерится как single dim `● <label>` строка через `HistoryItemDisplay`. Не нужно `refreshStatic`.

Compact mode отличается из-за `mergeCompactToolGroups`. Когда consecutive tool_groups сливаются, `MainContent` уже вызывает `refreshStatic()` — это существующий codepath, и он перерисовывает merged group с меткой lookup из истории. Поэтому compact mode _получает_ метку как replacement header. Чтобы избежать рендеринга той же метки дважды (однажды как compact header, однажды как trailing `● <label>` строка), `HistoryItemDisplay` скрывает standalone строку когда `compactMode` true.

```
Full mode              Compact mode (с merge)
───────────            ─────────────────────────
[tool_group]           [merged tool_group — header заменён через lookup]
● <label>              (● <label> строка скрыта)
```

### 3.4 Семантика gate

Три слоя, разрешены по приоритету:

1. `NESSY_CLI_EMIT_TOOL_USE_SUMMARIES=0|1|true|false` — env override, наивысший приоритет.
2. `experimental.emitToolUseSummaries` в `settings.json` — default `true`.
3. Implicit skip — если `config.getFastModel()` возвращает `undefined`, генерация пропускается независимо от gate. Нет ошибки, нет user-visible изменения.

### 3.5 Очистка вывода

`cleanSummary` запускается на каждом ответе модели перед добавлением в историю:

1. Взять только первую строку (отбрасывает model reasoning preambles).
2. Strip bullet префиксов (`-`, `*`, `•`) — модели иногда возвращают метку как list item.
3. Strip surrounding quotes/backticks через bounded `{1,10}` regex (CodeQL-safe; ни одна реальная метка не имеет больше чем несколько wrapping quotes).
4. Strip prefix labels (`Label:`, `Summary:`, `Result:`, `Output:`) которые некоторые модели препендят.
5. Reject error-message shapes (`API error: ...`, `Error: ...`, `I cannot ...`, `I can't ...`, `Unable to ...`) — возвращает empty string поэтому нет элемента истории добавлено.
6. Hard-cap длина на 100 символов (mobile UI truncates around 30; slack покрывает CJK phrases).

### 3.6 Телеметрия
