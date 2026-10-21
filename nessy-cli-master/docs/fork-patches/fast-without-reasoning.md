# fast-without-reasoning

## AIDT

-

## Зачем

Фоновые операции и fast-модель используют `thinkingConfig.includeThoughts:
false`, чтобы не тратить время и стоимость на reasoning. Для
OpenAI-compatible body одного удаления `reasoning_effort` недостаточно:
некоторые модели могут включать reasoning по умолчанию или принимать явное
отключение только через top-level `reasoning_effort`.

Локальный патч сохраняет существующую механику disabled thinking в
`ContentGenerationPipeline`, но вместо удаления top-level `reasoning_effort`
проставляет `reasoning_effort: "none"`.

## Файлы

- `packages/core/src/core/openaiContentGenerator/pipeline.ts` — при
  `thinkingConfig.includeThoughts: false` или `reasoning: false` явно
  выставляет `reasoning_effort: "none"`.
- `packages/core/src/core/openaiContentGenerator/pipeline.test.ts` —
  focused-регрессия на disabled thinking body shape.

Кодовая точка помечена `// [nessy-fork] fast-without-reasoning`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать `[nessy-fork]`-комментарий из pipeline.
2. Удалить или адаптировать focused-тест на `reasoning_effort: "none"`.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
