# streaming-dedup-and-parser-fixes

## AIDT

AIDT-6605

## Зачем

Некоторые OpenAI-совместимые провайдеры (Qwen35-class, MiniMax) отправляют потоковые ответы с особенностями:

1. **Половинные перекрытия чанков** — начало нового чанка дублирует конец уже отправленного текста, что вызывает видимое дублирование в выводе.
2. **Structured reasoning channel** — провайдер использует поле `reasoning_content` для мыслей, но tagged-thinking parser продолжал буферизовать видимый текст, ожидая теги.
3. **Backtick-quoted теги** — модели описывают теги ` `) в prose, что ложно триггерит thought-mode.
4. **Orphan thoughts с параграфами** — эвристика flush по `\n\n` преждевременно эмитила orphan thoughts, которые могут содержать параграфы перед закрывающим тегом `</think>`.

Эти fork-патчи обеспечивают корректную обработку потоковых ответов от таких провайдеров без дублирования текста и ложного срабатывания на теги в prose.

## Файлы

- `packages/core/src/core/openaiContentGenerator/converter.ts`
- `packages/core/src/core/openaiContentGenerator/converter.test.ts`
- `packages/core/src/core/openaiContentGenerator/taggedThinkingParser.ts`
- `packages/core/src/core/openaiContentGenerator/taggedThinkingParser.test.ts`
- `packages/core/src/core/openaiContentGenerator/types.ts`
- `packages/core/src/utils/thoughtStreamParser.ts`
- `packages/core/src/utils/thoughtStreamParser.test.ts`

## Откат

Удалить изменения, если upstream nessy-cli примет эквивалентные фиксы:

1. Удалить функции `longestSuffixPrefixOverlap()`, `pushToEmittedTail()`, `dedupChunkAgainstTail()` из `converter.ts`.
2. Удалить константы `CHUNK_OVERLAP_DEDUP_MIN`, `EMITTED_TAIL_LOOKBACK_BYTES`.
3. Удалить поле `emittedTail` из `StreamingTextDeltaState` в `types.ts`.
4. Удалить флаг `structuredReasoningSeen` из `RequestContext` в `types.ts`.
5. Вернуть эвристику flush по `\n\n` в `TaggedThinkingParser.parse()` и `ThoughtStreamParser.parseChunk()`.
6. Удалить функцию `isBacktickQuoted()` и её вызовы из `taggedThinkingParser.ts`.
7. Удалить тесты на дедупликацию перекрытий, backtick-quoted теги и orphan thoughts с `\n\n`.

После удаления убедиться, что тесты проходят с upstream-поведением.

## Upstream

Не отправлен.
