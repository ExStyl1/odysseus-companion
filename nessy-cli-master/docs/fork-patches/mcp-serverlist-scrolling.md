# mcp-serverlist-scrolling

## AIDT

AIDT-7100

## Зачем

В MCP ServerListStep при большом количестве серверов (>10) список занимает весь терминал,
пользователь теряет контекст — не видно, сколько ещё серверов выше/ниже.

Upstream использует простой `selectedIndex` без ограничения видимой области.
Добавлено windowed scrolling с фиксированным окном (8 строк) и индикаторами
"▲ X more above" / "▼ X more below" для сохранения контекста.

## Файлы

- `packages/cli/src/ui/components/mcp/steps/ServerListStep.tsx`

## Откат

1. Удалить константу `WINDOW_SIZE = 8`.
2. Вернуть `flatServers` к простому массиву `MCPServerDisplayInfo[]`.
3. Удалить `total`, `safeIndex`, логику windowed scrolling (`start`, `end`, `hasMoreAbove`, `hasMoreBelow`).
4. Удалить `visibleGroups` и вернуть исходный `groupedServers.map()` рендеринг.
5. Удалить индикаторы "more above/below" (Box с `▲` / `▼`).
6. Вернуть `getSelectionPosition()` и `currentPosition` для определения выбранной строки.
7. В `useKeypress` вернуть `selectedIndex` вместо `safeIndex`.
8. Запустить `npm run build && npm run typecheck`.
9. Проверить ручное тестирование: `nessy mcp` с >10 серверами.

## Upstream

Не отправлен.
