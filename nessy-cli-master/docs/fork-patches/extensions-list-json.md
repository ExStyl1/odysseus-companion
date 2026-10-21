# extensions-list-json

## AIDT

AIDT-6548

## Зачем

ACP-agent и IDE-настройки marketplace должны получать установленные extension
в машинно-читаемом формате, включая enablement по user/workspace scopes,
install metadata, skills и полные MCP-конфиги. Обычный `nessy extensions list`
возвращает человекочитаемый текст, который не подходит как стабильный контракт
для UI и агентного слоя.

Локальный патч добавляет скрытый флаг `nessy extensions list --json` и
изолирует JSON-сериализацию в отдельном файле, чтобы минимизировать изменения в
upstream-файле команды.

## Файлы

- `packages/cli/src/commands/extensions/list.ts` — точка подключения скрытого
  `--json` режима.
- `packages/cli/src/commands/extensions/list-json.ts` — JSON-сериализация
  установленных extension.
- `packages/cli/src/commands/extensions/list-json.test.ts` — regression-тесты
  shape JSON entry.
- `packages/cli/src/commands/extensions/list-json-command.test.ts` —
  regression-тесты command wiring.

Кодовая точка помечена `// [nessy-fork] extensions-list-json`.

## Откат

Если upstream примет эквивалентный JSON output для `extensions list`:

1. Убрать `[nessy-fork]`-комментарий и локальное подключение `handleListJson`
   из `list.ts`, если upstream предоставляет собственный handler.
2. Удалить или адаптировать `list-json.ts` под upstream-контракт.
3. Удалить или адаптировать focused-тесты на локальный JSON shape.
4. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
