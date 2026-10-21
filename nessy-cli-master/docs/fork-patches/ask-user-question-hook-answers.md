# ask-user-question-hook-answers

## AIDT

INSSRE-3029

## Зачем

`ask_user_question` читал ответы только из нативного confirmation UI (`payload.answers`
в `onConfirm`). Permission-хук (например, рендерящий вопросы во внешнем desktop-диалоге —
kdialog/yad) не мог передать ответ: подмена аргументов через `updatedInput` игнорировалась,
и нативный UI всё равно требовал ответа в консоли.

Этот fork-патч добавляет опциональный параметр `answers`
(`Record<0-based question index, answer text>`). Когда хук возвращает
`updatedInput = { questions, answers }`, планировщик пересоздаёт invocation, инструмент
видит `answers` в параметрах и возвращает готовые ответы, минуя нативный UI.

Без хуков поток не меняется: `answers` опционален, `required: ['questions']` не тронут,
нативный UI работает как раньше.

## Файлы

- `packages/core/src/tools/askUserQuestion.ts` — поле `answers` в `AskUserQuestionParams`
  и JSON Schema, обработка pre-supplied answers в `execute()`, валидация объекта в
  `validateToolParams()`
- `packages/core/src/tools/askUserQuestion.test.ts` — тесты приёма валидных `answers`,
  отклонения не-объекта и возврата pre-supplied answers (в т.ч. multiSelect) без `onConfirm`

Кодовые точки помечены `// [nessy-fork] ask-user-question-hook-answers`.

## Откат

1. Убрать блок pre-supplied answers в `execute()` (проверку `this.params.answers`).
2. Удалить поле `answers` из `AskUserQuestionParams` и JSON Schema.
3. Удалить валидацию `answers` в `validateToolParams()`.
4. Удалить тесты pre-supplied answers.
5. Удалить маркеры `[nessy-fork] ask-user-question-hook-answers`, строку из реестра и этот файл.

## Upstream

Не отправлен.