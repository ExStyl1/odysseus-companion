# reasoning-effort-wire-translation

## AIDT

AIDT-7604

## Зачем

Часть reasoning-capable моделей через Nestor (DeepSeek V4+, qwen3 hybrid)
принимает плоский top-level `reasoning_effort`, а не стандартную для nessy-cli
вложенную форму `reasoning: { effort, ... }`, которую OpenAI pipeline передаёт
вербатим. Без перевода вложенный `reasoning` игнорируется и сервер молча
использует `high` по умолчанию.

Патч переводит вложенный `reasoning.effort` в плоский `reasoning_effort` на
финальном объекте запроса (покрывает и `reasoning`, инжектированный через
`extra_body`), прокидывая настроенный effort без нормализации. Дополнительно,
при наличии `samplingParams`, reasoning всё равно мёрджится в запрос, чтобы
effort-уровни доходили до провайдера.

## Файлы

- `packages/core/src/core/openaiContentGenerator/provider/utils.ts` — новая
  функция `translateReasoningEffort` (вложенный `reasoning.effort` → плоский
  `reasoning_effort`, удаление продублированного `effort`-ключа и пустого
  `reasoning: {}`).
- `packages/core/src/core/openaiContentGenerator/provider/nestor.ts` —
  применение `translateReasoningEffort` к финальному объекту запроса в
  `buildRequest`.
- `packages/core/src/core/openaiContentGenerator/pipeline.ts` — мёредж
  `buildReasoningConfig(request)` в запрос даже при заданных `samplingParams`.
- `packages/core/src/core/openaiContentGenerator/provider/nestor.test.ts` и
  `pipeline.test.ts` — focused-регрессия на перевод effort и merge при
  `samplingParams`.

Кодовые точки помечены `// [nessy-fork] reasoning-effort-wire-translation`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать `[nessy-fork]`-комментарии из `utils.ts`, `nestor.ts`, `pipeline.ts`.
2. Удалить `translateReasoningEffort` и её вызов в `buildRequest`.
3. Вернуть в `pipeline.ts` поведение `return { ...configSamplingParams }` без
   merge reasoning.
4. Удалить или адаптировать focused-тесты на перевод effort.
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.