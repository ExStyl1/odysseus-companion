# model-switch-generation-fields

## AIDT

AIDT-7604

## Зачем

При переключении модели через dp-auth hot-update-путь (`handleModelChange`)
копировались только часть полей генерации (`model`, `samplingParams`,
`contextWindowSize`, `enableCacheControl`, `splitToolMedia`,
`toolResultContentFormat`). Остальные `MODEL_GENERATION_CONFIG_FIELDS`
(`reasoning`, `timeout`, `maxRetries`, `retryErrorCodes`, `schemaCompliance`,
`customHeaders`, `modalities`, `extra_body`) оставались устаревшими, из-за чего
per-model backend-настройки (например `reasoning.effort` для Nestor) молча
отбрасывались при переключении модели.

Патч копирует эти поля и их sources в hot-update-пути, чтобы генерация
следовала за выбранной моделью.

## Файлы

- `packages/core/src/config/config.ts` — в `handleModelChange` (hot-update)
  копирование оставшихся `MODEL_GENERATION_CONFIG_FIELDS` и их
  `contentGeneratorConfigSources`.
- `packages/core/src/config/config.test.ts` — тест на обновление `reasoning` и
  `extra_body` при переключении модели.

Кодовая точка помечена `// [nessy-fork] model-switch-generation-fields`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать `[nessy-fork]`-комментарий из `config.ts`.
2. Удалить копирование полей из hot-update блока или адаптировать тест.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.