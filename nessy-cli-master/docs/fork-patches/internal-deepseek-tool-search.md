# internal-deepseek-tool-search

## AIDT

AIDT-7824

## Зачем

Общее правило автоматически отключает ToolSearch для моделей DeepSeek ради
стабильного префикса и эффективного KV-кэширования. Для внутренней модели
`tgpt/deepseek-v4-flash-0731` ToolSearch критичен: модель должна находить и
подключать необходимые инструменты по запросу, не получая полный набор схем
инструментов заранее.

Явная настройка `tools.toolSearch.enabled: false` сохраняет приоритет и
отключает ToolSearch в том числе для этой модели.

## Файлы

- `packages/cli/src/config/config.ts`
- `packages/cli/src/config/config.test.ts`
- `docs/fork-patches/README.md`
- `docs/fork-patches/internal-deepseek-tool-search.md`

## Откат

1. Удалить исключение для `tgpt/deepseek-v4-flash-0731` и маркер
   `[nessy-fork] internal-deepseek-tool-search` из `config.ts`.
2. Удалить регрессионный тест исключения из `config.test.ts`.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
