# tool-search-first-schema

## AIDT

- AIDT-6402
- AIDT-6473

## Зачем

Deferred tools показываются модели только именем и кратким описанием, без
JSON Schema параметров. Из-за этого модель может угадать неправильные имена
или типы аргументов и сразу вызвать инструмент некорректно.

Перед вызовом любого инструмента из списка `Deferred Tools` модель должна
сначала вызвать `tool_search`, лучше через `select:<tool_name>`, получить
полную function declaration и только на следующем ходе вызвать целевой
инструмент. Возвращенная схема объявляется source of truth для имен
параметров, required-полей, enum и типов.

Prompt-only защита недостаточна: модель может сгенерировать прямой вызов
deferred-инструмента, которого нет в активном `tools` payload. Поэтому
execution path перехватывает такие вызовы до исполнения, подменяет их на
`tool_search` с `select:<tool_name>` и возвращает в историю уже подмененный
корректный вызов.

Subagent runtime отключает принудительную подмену: у subagent может не быть
загруженного `tool_search`, при этом MCP-инструменты должны продолжать
исполняться в его собственном контексте.

## Файлы

- `packages/core/src/core/deferredToolCallRedirect.ts` — общий helper для
  execution-level подмены unrevealed deferred-вызова на `tool_search`.
- `packages/core/src/core/coreToolScheduler.ts` — подмена прямого
  deferred-вызова перед `buildInvocation()`.
- `packages/cli/src/acp-integration/session/Session.ts` — такая же подмена в
  ACP-режиме.
- `packages/core/src/agents/runtime/agent-core.ts` — subagent opt-out, чтобы
  не требовать `tool_search` в subagent runtime.
- `packages/core/src/core/nonInteractiveToolExecutor.test.ts`,
  `packages/core/src/core/coreToolScheduler.test.ts`,
  `packages/core/src/core/deferredToolCallRedirect.test.ts` и
  `packages/cli/src/acp-integration/session/Session.test.ts` — регрессии для
  helper, TUI/scheduler, noninteractive, ACP и subagent opt-out.

Кодовые точки помечены `// [nessy-fork] tool-search-first-schema`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать `[nessy-fork]`-комментарии из execution-level call sites.
2. Удалить runtime-helper и его подключения в `coreToolScheduler.ts`,
   `Session.ts` и core export, если upstream даст эквивалентный механизм.
3. Удалить subagent opt-out в `agent-core.ts`, если upstream будет корректно
   различать agent runtime.
4. Удалить или адаптировать focused-тесты в
   `deferredToolCallRedirect.test.ts`, `coreToolScheduler.test.ts`,
   `nonInteractiveToolExecutor.test.ts` и `Session.test.ts`.
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
