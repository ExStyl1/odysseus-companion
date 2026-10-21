# desktop-terminal-command-preview

## AIDT

AIDT-7460

## Зачем

Длинные и многострочные терминальные команды перегружали карточку запроса разрешения и требовали прокрутки перед принятием решения.

Этот fork-патч оставляет в карточке однострочное превью с многоточием и открывает полную команду в штатной боковой preview-панели Desktop. В панели сохраняются исходные пробелы и переносы строк, а её закрытие не подтверждает и не отклоняет запрос.

## Файлы

- `packages/desktop/apps/electron/src/renderer/App.tsx` — рендеринг полной команды в общей preview-панели
- `packages/desktop/apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx` — компактное превью и действие открытия панели
- `packages/desktop/apps/electron/src/renderer/context/AppShellContext.tsx` — callbacks открытия и адресного закрытия панели
- `packages/desktop/apps/electron/src/renderer/hooks/useLinkInterceptor.ts` — состояние команды в общей preview-панели

Кодовые точки помечены `// [nessy-fork] desktop-terminal-command-preview`.

## Откат

1. Удалить command-вариант, callbacks и рендеринг команды из общей preview-панели.

2. Вернуть терминальной permission-карточке полное inline-отображение команды.

3. Удалить маркеры `[nessy-fork] desktop-terminal-command-preview`, строку из реестра и этот файл.

## Upstream

Не отправлен.
