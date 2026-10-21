# desktop-mcp-permission-args-preview

## AIDT

AIDT-7544

## Зачем

ACP передаёт вызов MCP-инструмента как `toolName = mcp__<server>__<tool>`, а в описании запроса приходит весь объект аргументов, сериализованный в JSON одной строкой. Permission-карточка Desktop показывала этот JSON целиком, из-за чего разрасталась и не помещалась на экране — суть запроса не считывалась.

Этот fork-патч оставляет в карточке нормализованное имя инструмента (`dpWiki/get_page`) и однострочное превью аргументов с многоточием, а полные аргументы открывает по кнопке в штатной боковой preview-панели: pretty-print с отступом в 2 пробела, подсветка синтаксиса, перенос длинных строк и только вертикальная прокрутка. Используется тот же механизм `onOpenPermissionCommand` / `onClosePermissionCommand`, что и у [desktop-terminal-command-preview](./desktop-terminal-command-preview.md), поэтому закрытие панели не подтверждает и не отклоняет запрос.

## Файлы

- `packages/desktop/apps/electron/src/renderer/lib/mcp-permission.ts` — нормализация имени MCP-инструмента и разбор аргументов на compact/pretty формы
- `packages/desktop/apps/electron/src/renderer/lib/__tests__/mcp-permission.test.ts` — тесты разбора
- `packages/desktop/apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx` — компактная строка аргументов и действие открытия панели
- `packages/desktop/apps/electron/src/renderer/App.tsx` — mcp-вариант command-превью с JSON-подсветкой
- `packages/desktop/apps/electron/src/renderer/hooks/useLinkInterceptor.ts` — вариант превью в состоянии панели
- `packages/desktop/apps/electron/src/renderer/context/AppShellContext.tsx` — вариант превью в типе callback

Кодовые точки помечены `// [nessy-fork] desktop-mcp-permission-args-preview`.

## Откат

1. Удалить mcp-вариант из command-превью и вернуть MCP-карточке inline-отображение описания и аргументов.

2. Удалить поле `variant` из состояния панели и типа callback.

3. Удалить модуль `mcp-permission.ts` с тестами.

4. Удалить маркеры `[nessy-fork] desktop-mcp-permission-args-preview`, строку из реестра и этот файл.

## Upstream

Не отправлен.
