# desktop-clipboard-path-paste

## AIDT

AIDT-7116

## Зачем

Desktop обрабатывал вставку файлов из Finder и Explorer как вложение: создавал копию в сессии вместо ссылки на оригинал, а папки не удавалось вставить вовсе. Патч вставляет абсолютные пути файлов и папок как обычный текст в локальном workspace, включая несколько путей и пути с пробелами, кириллицей или Windows-разделителями.

Явное перетаскивание и кнопка прикрепления остаются attachment-flow. Скриншоты, clipboard-данные без файлового пути, смешанное содержимое и локальные файлы в remote workspace также остаются вложениями.

## Файлы

- `packages/desktop/apps/electron/src/preload/bootstrap.ts` — preload API чтения путей из системного clipboard
- `packages/desktop/apps/electron/src/renderer/components/app-shell/AppShell.tsx` — глобальная обработка вставки файлов и папок, включая пустой браузерный `FileList`
- `packages/desktop/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` — выбор между вставкой пути и attachment-flow для local/remote workspace
- `packages/desktop/apps/electron/src/renderer/components/app-shell/input/clipboard-path-paste.test.ts` — тесты macOS/Windows-путей, папок и attachment fallback
- `packages/desktop/apps/electron/src/renderer/components/app-shell/input/clipboard-path-paste.ts` — определение безопасной вставки абсолютных путей
- `packages/desktop/apps/electron/src/renderer/components/ui/rich-text-input.tsx` — вставка текста в позицию курсора с поддержкой undo
- `packages/desktop/apps/electron/src/shared/types.ts` — контракт preload API для путей из clipboard
- `packages/desktop/apps/electron/src/transport/__tests__/channel-map-parity.test.ts` — исключение локального preload API из проверки транспортных каналов
- `packages/desktop/packages/shared/src/utils/files.ts` — чтение путей Finder и Explorer без чтения содержимого файлов

## Откат

1. Удалить чтение путей Finder/Explorer из shared utilities и preload API.
2. Вернуть paste handlers к безусловному attachment-flow для clipboard-файлов.
3. Удалить текстовую вставку путей и связанный helper с тестами.
4. Удалить маркеры `[nessy-fork] desktop-clipboard-path-paste`, строку из реестра и этот файл.

## Upstream

Не отправлен.
