# mcp-tilde-expansion

## AIDT

AIDT-6172

## Зачем

Мы автообновляем CLI `dp` в `~/.nessy/dp_latest/dp` (или `dp.exe` на
Windows), чтобы пользователи могли привязывать MCP-серверы к bundled-
бинарю независимо от того, что у них в `PATH`. Тогда расширения и
`settings.json` могут ссылаться на бинарь как `~/.nessy/dp_latest/dp`, и
это работает одинаково на macOS, Linux и Windows.

Upstream gemini-cli передаёт `command` напрямую в `StdioClientTransport`,
который использует `child_process.spawn` с `shell: false`. `spawn` **не**
раскрывает `~` — это конструкция шелла — поэтому буквальный `~/.nessy/...`
падает с `ENOENT` на любой платформе, не только на Windows.

Раскрываем ведущий `~/` или `~\` в stdio MCP `command`, `args` и `cwd`
прямо перед созданием транспорта. Это самая низкая точка в пайплайне,
поэтому работает одинаково для серверов из user settings, project
settings, расширений и CLI-флага `--mcp-config`.

## Файлы

- `packages/core/src/tools/mcp-stdio-paths.ts` — новая утилита,
  экспортирует `expandHome()` и `expandHomeInStdioConfig()`.
- `packages/core/src/tools/mcp-stdio-paths.test.ts` — тесты обеих
  функций (без `~`, голый `~`, `~/`, `~\`, тильда в середине пути,
  формы конфига с command/args/cwd, проброс http/sse, иммутабельность).
- `packages/core/src/tools/mcp-client.ts` — три точечные правки в
  stdio-ветке `createTransport()`:
  - импорт `expandHomeInStdioConfig`,
  - одна строка `mcpServerConfig = expandHomeInStdioConfig(...)` в начале
    блока `if (mcpServerConfig.command)`,
  - non-null assertion `mcpServerConfig.command!` на вызове
    `StdioClientTransport` (TS теряет narrowing после reassign, поэтому `!`).

Все три точки помечены комментарием `// [nessy-fork] mcp-tilde-expansion`
для grep-доступности.

## Откат

Если upstream примет эквивалентный фикс:

1. Удалить оба файла `packages/core/src/tools/mcp-stdio-paths*.ts`.
2. В `packages/core/src/tools/mcp-client.ts`:
   - убрать import-строку с `[nessy-fork] mcp-tilde-expansion`,
   - убрать строку `mcpServerConfig = expandHomeInStdioConfig(...)` и её
     `[nessy-fork]`-комментарий,
   - вернуть `command: mcpServerConfig.command!` обратно к
     `command: mcpServerConfig.command`.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
