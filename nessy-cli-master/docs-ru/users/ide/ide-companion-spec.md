---
title: Спецификация IDE Companion
---

# Спецификация интерфейса Nessy CLI Companion

Документ определяет контракт плагинов для IDE, отличных от VS Code.

## Соединение и обнаружение

Плагин обязан поднять MCP over HTTP на динамическом порту (`0`) с единым endpoint вроде `/mcp`. Он создаёт `~/.nessy/ide/<PORT>.lock` и выставляет `NESSY_CLI_IDE_SERVER_PORT` во встроенном терминале.

```json
{
  "port": 12345,
  "workspacePath": "/path/to/project1:/path/to/project2",
  "authToken": "a-very-secret-token",
  "ppid": 1234,
  "ideName": "VS Code"
}
```

`workspacePath` содержит абсолютные корни через системный разделитель путей. CLI отклоняет соединение вне этих корней. Уникальный `authToken` проверяется в каждом `Authorization: Bearer <token>`, `ppid` содержит PID родительского IDE-процесса. Старые файлы `nessy-cli-ide-server-<PID|PORT>.json` поддерживаются только как fallback и не должны использоваться новыми плагинами.

## Контекст IDE

Плагин может с debounce около 50 мс отправлять notification `ide/contextUpdate` при открытии, закрытии или фокусе файла, изменении курсора или выделения.

```typescript
interface IdeContext {
  workspaceState?: { openFiles?: File[]; isTrusted?: boolean };
}
interface File {
  path: string;
  timestamp: number;
  isActive?: boolean;
  cursor?: { line: number; character: number };
  selectedText?: string;
}
```

Виртуальные/несохранённые файлы исключаются. `timestamp` — время последнего фокуса Unix; курсор и выделение нужны только активному файлу. CLI сортирует список, оставляет десять файлов и ограничивает `selectedText` 16 КБ.

## Diff-интерфейс

MCP-сервер регистрирует `openDiff` с `{ filePath, newContent }`. Успех немедленно возвращает `content: []`, ошибка — `isError: true` и `TextContent`. Итог приходит асинхронно.

`closeDiff` принимает `{ filePath }`; при успехе возвращает один `TextContent` с финальным содержимым, при ошибке — `isError: true`.

При принятии плагин отправляет `ide/diffAccepted` с `{ filePath, content }`, включая ручные правки пользователя. При отклонении отправляет `ide/diffRejected` с `{ filePath }`.

## Жизненный цикл

При активации плагин запускает MCP-сервер и создаёт discovery-файл. При деактивации останавливает сервер и удаляет файл.
