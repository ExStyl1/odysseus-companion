# session-status

## AIDT

-

## Зачем

Внешние потребители (Swift-нотификатор, Desktop Pet) читают runtime.json
сессий целиком, чтобы показывать карточку состояния. TUI-сессии уже пишут
свой state-блок (MR1/MR2, коммит 96b8010c1 — вне рамок этого патча), а
ACP-сессии (IDE-плагины, Desktop, `nessy --acp`) ничего не сообщали —
карточка для них не появлялась.

Патч подключает тот же SessionStatusReporter к ACP-режиму. Репортёр
per-Session, не per-соединение: у каждой ACP-сессии свой Config и sessionId,
общий на соединение репортёр метался бы между путями параллельных сессий.
Каждая ACP-сессия пишет state-блок в свой runtime.json:

- `idle` — при создании сессии (конструктор Session);
- `working` — на старте хода (prompt);
- `waiting_input` + `pending_request` — на время session/request_permission
  (request_id синтезируется через randomUUID: ACP SDK не раскрывает JSON-RPC
  id, внешним потребителям он нужен только для дедупликации карточки;
  tool_name берётся из `_meta`, summary из title, options из optionId/name);
- `done` — в finally метода prompt (cancel/error тоже завершают ход),
  обязательно до resolveCompletion(), чтобы следующий ход не перетёр фазу
  обратно.

Гейт тот же, что в TUI — `getAutoSessionControl()` (настройка
`dualOutput.enabled`). `setControl` не вызывается: у ACP нет ctl-каналов
(events/input.jsonl), ответы идут по ACP-протоколу от владельца сессии,
поэтому внешняя карточка показывается без кнопок ответа. Оба чекпойнта
permission обёрнуты: публичный `requestPermission()` (SubAgentTracker) и
прямой вызов `client.requestPermission` в runTool-пути, а также
elicitation-ветка `unstable_createElicitation` (AIDT-8203: ask_user_question
у клиентов с form-capability) — карточка вопроса не зависит от транспорта. `source='acp'`
штампуется в state-блок — внешние наблюдатели классифицируют сессию без ps
(которого нет на Windows).

## Файлы

- `packages/cli/src/acp-integration/session/Session.ts`
- `packages/cli/src/acp-integration/session/Session.test.ts` — тест elicitation-пути
  (форма открыта → waiting_input, принята → working).
- `packages/cli/src/acp-integration/session/SubAgentTracker.ts` — вопросы сабагентов
  идут через bracketed-метод (ctx.requestPermission), warn при отсутствии.
- `packages/cli/src/acp-integration/session/types.ts` — опциональный
  `requestPermission` в SessionContext (bracketed-контракт).
- `packages/cli/src/sessionStatus/session-status-reporter.acp.test.ts`

Кодовые точки помечены `// [nessy-fork] session-status MR3`.

## Откат

При появлении эквивалентного механизма upstream:

1. Убрать поле `statusReporter` и запись `idle` из конструктора Session.
2. Убрать записи `working`/`done` из метода prompt.
3. Убрать обёртку `#requestPermissionWithStatus` и вернуть прямые вызовы
   `client.requestPermission` / `unstable_createElicitation`.
4. Удалить тест `session-status-reporter.acp.test.ts`, маркеры, строку
   реестра и этот файл. TUI-часть (MR1/MR2) — отдельный патч, не откатывать.

## Upstream

Не отправлен. Зависит от внутреннего SessionStatusReporter и runtime.json.
