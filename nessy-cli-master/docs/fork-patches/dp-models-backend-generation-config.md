# dp-models-backend-generation-config

## AIDT

AIDT-7604

## Зачем

Backend DP Auth отдаёт модели с расширенным набором полей генерации
(`context_window_size`, `sampling_params`, `reasoning`, `extra_body`), которые
раньше не переносились в `ModelConfig.generationConfig` — учитывался только
`modalities`. Без маппинга per-model настройки генерации (включая
`reasoning.effort` для reasoning-моделей) терялись бы при загрузке каталога
моделей из backend.

Патч маппит новые backend-поля в `generationConfig`, строя `reasoning` только
из реально переданных backend полей (без лишнего `budget_tokens: undefined`).

## Файлы

- `packages/core/src/dp/dp-models-client.ts` — маппинг `context_window_size`,
  `sampling_params`, `reasoning`, `extra_body` в `generationConfig`;
  `generationConfig` опускается, если backend не передал ни одного поля.
- `packages/core/src/dp/dp-models-client.test.ts` — focused-тесты на маппинг
  каждого поля и на отсутствие `generationConfig` без полей.

Кодовая точка помечена `// [nessy-fork] dp-models-backend-generation-config`.

## Откат

Если upstream примет эквивалентный фикс (маппинг backend generation config):

1. Убрать `[nessy-fork]`-комментарий из `dpModelsClient.ts`.
2. Удалить или адаптировать тесты маппинга в `dpModelsClient.test.ts`.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.