# subagent-deferred-tools

## AIDT

AIDT-8415

## Зачем

Главный агент не получает схемы deferred-тулов (все MCP плюс `web_fetch`,
`monitor`, `lsp`, `cron_*`, `computer_use__*` и прочие). Он видит только имена
в стартовом `<system-reminder>` и достаёт схему по требованию через
`tool_search`.

Сабагенты работали наоборот: `AgentCore.prepareTools()` звал
`getFunctionDeclarations({ includeDeferred: true })` и выдавал все
deferred-схемы сразу, а напоминание им было выключено. Цена этого измерена
апстримом в комментарии к его агенту `review-agent`: сабагент без собственного
списка `tools` получает 51 схему, 21 178 промпт-токенов на каждом ходу, из них
11 011 — 35 схем `computer_use__*`.

Патч переводит встроенный `general-purpose` на ту же схему, что у главного
агента. Остальные сабагенты не затронуты.

Включение режима потребовало починить два места, из-за которых `tool_search`
внутри сабагента не работал вовсе:

1. Список деклараций снимался один раз до цикла рассуждений, поэтому
   раскрытый тул в него уже не попадал.
2. `ToolSearchInvocation` звал `this.config.getGeminiClient()`. У сабагента
   `Config` создан через `Object.create(parentConfig)`, поэтому возвращался
   клиент **родителя** с другим `ToolRegistry`: раскрытие ложилось в реестр
   сабагента, а `setTools()` и `refreshStartupContextReminder()` переписывали
   список тулов и `history[0]` родительской сессии посреди её работы.

## Как устроено

`AgentCore.usesDeferredTools()` — режим включён, когда имя агента совпадает с
`DEFAULT_BUILTIN_SUBAGENT_TYPE`, у агента нет `toolConfig` и он не тиммейт.
Каждое условие закрывает живой путь:

- имя отсекает остальных встроенных агентов, `fork` и внутренние
  планировщики из `forkedAgent.ts`;
- `!toolConfig` даёт пользователю выключить режим файлом
  `.nessy/agents/general-purpose.md` со своим `tools` и служит вторым рубежом
  для форков, которые всегда несут `toolConfig`;
- `!isTeammate()` сохраняет `send_message` (он deferred) объявленным для
  участников команды. Тиммейт с `agentType: 'general-purpose'` приходит сюда
  без `toolConfig`, потому что `TeamManager` дописывает team-тулы только к уже
  существующему списку.

Следствие: в этом режиме множество исключений всегда
`EXCLUDED_TOOLS_FOR_SUBAGENTS`, что используется и в фильтре напоминания, и в
проверке скрытого вызова.

Возобновлённые фоновые агенты поддержаны: `createChat` сканирует
`initialMessages` и заранее раскрывает те deferred-тулы, которые уже вызывались
в сохранённой истории. Иначе восстановленная переписка ссылалась бы на
необъявленные тулы, и строгие провайдеры отвечали бы ошибкой. Это зеркало
`GeminiClient.startChat`.

## Файлы

- `packages/core/src/agents/runtime/agent-core.ts` — предикат
  `usesDeferredTools()`, `isHiddenDeferredCall()`, флаг `includeDeferred` в
  ветке наследования `prepareTools()`, напоминание и предварительное раскрытие
  в `createChat()`, пересчёт деклараций каждый ход в
  `_runReasoningLoopInner`, смягчённый гейт в `processFunctionCalls`.
- `packages/core/src/tools/tool-search.ts` — не синхронизировать клиента
  родителя, когда вызов идёт внутри agent runtime (`subagentNameContext`).
  Единственная правка, действующая шире `general-purpose`: это баг-фикс, и он
  применяется к любому сабагенту. Для остальных поведение не меняется —
  раскрытие по-прежнему происходит, а их схемы и так объявлены, — исчезает
  только порча родительской сессии.
- `packages/core/src/utils/environmentContext.ts` — необязательный
  `deferredToolFilter` в `InitialChatHistoryOptions` и
  `buildDeferredToolsReminder`; новая чистая функция
  `deferredToolNamesInHistory`.
- `packages/core/src/agents/background-agent-resume.ts` —
  `subagentUsesDeferredTools()` по образцу соседней
  `subagentWillHaveSkillTool()`, включение напоминания и фильтр для
  возобновлённого агента.
- Тесты: `agent-core.test.ts`, `agent-headless.test.ts`,
  `tool-search.test.ts`, `environmentContext.test.ts`,
  `builtin-agents.test.ts`.

Кодовые точки помечены `// [nessy-fork] subagent-deferred-tools`.

## Известные ограничения

- Напоминание строится один раз при создании чата. MCP-серверы, найденные
  позже в ходе работы, сабагенту не анонсируются: у родителя для этого есть
  `queueAddedMcpToolsReminder`, у сабагента аналога нет. Поведение
  предсуществующее.
- Каждое раскрытие меняет массив тулов между ходами и обесценивает префиксный
  кэш провайдера с этого момента. Тот же размен, на который уже идёт главный
  агент.
- Выигрыш зависит от профиля работы. Агент, трогающий один-два MCP-тула,
  выигрывает много; агент, трогающий по разу десяток разных, может выйти в
  ноль, потому что схема каждого осядет в истории навсегда.

## Смежные баги (вне патча)

Описаны в `.nessy/issues/deferred-tools-known-bugs.md`: утечка схем MCP мимо
белого списка через `tool_search`, и потерянный при мердже 0.19.1 opt-out
AIDT-6473. Когда второй будут чинить, флаг
`redirectDeferredToolsToToolSearch` должен быть не плоским `false`, а
`this.usesDeferredTools()` — иначе он сломает этот патч.

## Откат

1. Удалить `usesDeferredTools()` и `isHiddenDeferredCall()` в `agent-core.ts`,
   вернуть `includeDeferred: true` в ветке наследования `prepareTools()`,
   `includeDeferredToolsReminder: false` без фильтра в `createChat()`, убрать
   предварительное раскрытие, вернуть `toolsList` вместо `activeTools` в
   цикле и исходное условие гейта.
2. Снять охрану `subagentNameContext` в `tool-search.ts`.
3. Удалить `deferredToolFilter` и `deferredToolNamesInHistory` в
   `environmentContext.ts`.
4. Удалить `subagentUsesDeferredTools()` и его использование в
   `background-agent-resume.ts`.
5. Удалить помеченные тесты, строку в `docs/fork-patches/README.md` и этот
   файл.

## Upstream

Не отправлен и в апстриме не реализован: в 0.19.1, 0.25.1 и 0.25.2 сабагенты
по-прежнему получают `getFunctionDeclarations({ includeDeferred: true })` и
`includeDeferredToolsReminder: false`. Ту же проблему токенов апстрим решил
иначе — закрытым списком `tools` у отдельного встроенного агента
(`review-agent`, 0.25.1), а не переводом на `tool_search`. Ближайший
родственник, настройка `tools.eager`, по дизайну не трогает MCP-тулы.

При будущем мердже версии, где `tool_search` перестанет менять список
деклараций (мост ToolSearch + ToolCall, PR #10410, v0.24.2): пересчёт
деклараций каждый ход и охрану в `tool-search.ts` удалить, смягчение гейта
перевыразить через `tool_call`, предикат и флаги оставить.
