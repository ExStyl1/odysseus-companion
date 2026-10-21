# streaming-mode-passthrough

## AIDT

-

## Зачем

`streamingMode` может задаваться из CLI или settings, а `GeminiChat`
передает выбранный режим в `ContentGenerator.generateContentStream()`.
Для OpenAI-compatible генераторов финальная развилка находится в
`ContentGenerationPipeline.executeAuto()`: `sync` вызывает обычный completion
и оборачивает ответ в async generator, `stream` использует streaming endpoint.

Локальные обертки `ContentGenerator` должны быть прозрачными для третьего
аргумента `mode`. Если wrapper принимает `mode`, но не передает его дальше,
`executeAuto()` получает `undefined` и использует default `stream`, даже когда
пользователь выбрал `sync`.

## Файлы

- `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts`
  — логирующая обертка сохраняет `mode` при вызове wrapped generator.
- `packages/core/src/nessy/nessyContentGenerator.ts` — Nessy override сохраняет
  `mode` при вызове `OpenAIContentGenerator`.
- `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.test.ts`,
  `packages/core/src/nessy/nessyContentGenerator.test.ts`,
  `packages/cli/src/config/config.test.ts` — focused-регрессии на passthrough и
  CLI/settings wiring.

Кодовые точки помечены `// [nessy-fork] streaming-mode-passthrough`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать `[nessy-fork]`-комментарии из generator wrappers.
2. Удалить или адаптировать focused-тесты на passthrough.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
