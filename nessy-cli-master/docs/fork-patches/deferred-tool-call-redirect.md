# deferred-tool-call-redirect

## AIDT

AIDT-6402 (усиление: автоматический редирект unrevealed deferred tools)

## Зачем

При работе с deferred tools (MCP и другие инструменты, загружаемые по требованию)
пользователь или агент могут попытаться вызвать инструмент до того, как его схема
была загружена через `tool_search`. Без этого патча такой вызов завершится ошибкой
или будет отправлен провайдеру с неполной информацией.

Этот патч автоматически перехватывает вызовы unrevealed deferred tools и подменяет
их на `tool_search select:<tool_name>`, после чего инструмент раскрывается и
последующие вызовы работают напрямую.

Отличие от базового AIDT-6402: базовая версия только добавляет напоминание в
системный промпт о необходимости вызывать `tool_search` первым. Этот патч идёт
дальше — автоматически исправляет неправильные вызовы на лету.

## Файлы

- `packages/core/src/core/deferredToolCallRedirect.ts` — новая логика редиректа
- `packages/core/src/core/deferredToolCallRedirect.test.ts` — тесты
- `packages/core/src/core/coreToolScheduler.ts` — интеграция в основной цикл обработки tool calls
- `packages/cli/src/acp-integration/session/Session.ts` — интеграция в ACP-сессию
- `packages/core/src/index.ts` — экспорт новых функций
- `packages/core/src/utils/environmentContext.ts` — усиленное напоминание в системном промпте
- `packages/core/src/utils/environmentContext.test.ts` — тесты на наличие напоминания

## Откат

1. Удалить файлы `deferredToolCallRedirect.ts` и `deferredToolCallRedirect.test.ts`
2. Удалить импорты и вызовы `redirectDeferredToolCallRequest` / `redirectDeferredFunctionCall` из:
   - `packages/core/src/core/coreToolScheduler.ts`
   - `packages/cli/src/acp-integration/session/Session.ts`
3. Удалить экспорт из `packages/core/src/index.ts`
4. Вернуть текст напоминания в `environmentContext.ts` к версии без требования
   обязательного `tool_search` первым
5. Обновить тесты в `environmentContext.test.ts`

## Upstream

Не отправлен. Upstream ожидает, что агент сам вызывает `tool_search` перед
использованием deferred tools. Этот патч делает процесс автоматическим для
улучшения UX.
