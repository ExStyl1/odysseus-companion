# tool-arg-simple-type-coercion

## AIDT

-

## Зачем

Модели иногда передают простые аргументы инструментов строками, хотя схема
инструмента ожидает число, целое число или boolean. Например, MCP-инструмент
может объявить `{ "type": "number" }`, а модель вызвать его с `"0.7"`.
Без локальной нормализации такой вызов падает на валидации, хотя значение
однозначно приводится по схеме.

Нормализуем только простые скалярные значения по JSON Schema инструмента:
`"123"` → `123`, `"0.7"` → `0.7`, `"true"` → `true`. Исправленные значения
попадают не только в фактический вызов инструмента, но и в историю assistant
turn, чтобы следующие модельные шаги видели корректные типы.

## Файлы

- `packages/core/src/utils/toolArgCoercion.ts` — изолированная fork-утилита
  для schema-directed нормализации и `structuredCloneWithToolArgCoercion()`.
- `packages/core/src/core/functionCallArgCoercion.ts` — изолированная
  нормализация `functionCall.args` перед записью assistant turn в историю.
- `packages/core/src/utils/schemaValidator.ts`,
  `packages/core/src/core/geminiChat.ts`,
  `packages/core/src/core/coreToolScheduler.ts` — только короткие точки
  подключения fork-утилит.

Кодовые точки помечены `// [nessy-fork] tool-arg-simple-type-coercion`.

## Откат

Если upstream примет эквивалентный фикс:

1. Удалить `packages/core/src/utils/toolArgCoercion.ts` и
   `packages/core/src/core/functionCallArgCoercion.ts`.
2. Убрать короткие `[nessy-fork]` call sites из `SchemaValidator`,
   `GeminiChat` и `CoreToolScheduler`.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
