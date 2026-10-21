# deferred-tools-reminder-enhance

## AIDT

AIDT-6402 (напоминание в системном промпте)

## Зачем

Базовый AIDT-6402 добавлял краткое напоминание о deferred tools в системный промпт.
Эта доработка усиливает напоминание — явно требует вызывать `tool_search` **первым**
перед использованием любого deferred tool, и предупреждает не вызывать инструменты
напрямую пока их схема не загружена.

В отличие от автоматического редиректа (deferred-tool-call-redirect), это только
текстовое напоминание агенту, а не runtime-подмена вызовов.

## Файлы

- `packages/core/src/utils/environmentContext.ts` — усиленный текст напоминания
- `packages/core/src/utils/environmentContext.test.ts` — тесты на наличие ключевых фраз

## Откат

1. Вернуть текст в `buildDeferredToolsReminderForSummary` к исходному варианту
   без требования обязательного `tool_search` первым
2. Удалить добавленные проверки из `environmentContext.test.ts`

## Upstream

Не отправлен. Upstream использует более мягкое напоминание без императивного
требования.
