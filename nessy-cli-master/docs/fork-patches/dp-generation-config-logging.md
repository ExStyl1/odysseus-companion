# dp-generation-config-logging

## AIDT

AIDT-7604

## Зачем

Для внутренних dp-auth-моделей применённый `generationConfig` (context window,
sampling params, reasoning, extra_body) никак не логировался, что усложняло
отладку, какие per-model настройки генерации реально доходят до модели.
Патч добавляет debug-логирование применённых полей генерации для dp-auth
моделей в `DP:Models` логгере.

## Файлы

- `packages/core/src/models/content-generator-config.ts` — в
  `applyResolvedModelConfig` debug-лог `Applied generation config for ...`
  для `resolvedModel.authType === 'dp-auth'`.

Кодовая точка помечена `// [nessy-fork] dp-generation-config-logging`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать `[nessy-fork]`-комментарий из `content-generator-config.ts`.
2. Удалить или адаптировать блок логирования и импорт `createDebugLogger`.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.