# desktop-extension-auto-update

## AIDT

AIDT-7769

## Зачем

Desktop-пользователи не получали обновления установленных расширений, которые мы
распространяем вместе с Nessy CLI: пока новые версии доставлялись только в TUI
(автоматически на каждом старте сессии), в Desktop расширения оставались на
старой версии и могли ломаться.

Фича добавляет в Desktop автоматическое обновление **всех** установленных
расширений, повторяя поведение `nessy extensions update --all` из TUI:

- проверка и обновление выполняются при каждом старте приложения;
- дополнительно фоновая периодическая проверка (раз в 6 часов), потому что
  Desktop-сессии живут долго без перезапуска и расширение может быть опубликовано
  уже после запуска приложения;
- авто-апдейт запускается fire-and-forget через vendored CLI (`CRAFT_CLI_ENTRY` +
  `CRAFT_BUN`), как и first-run установка default extension; ошибки только
  логируются и никогда не блокируют старт приложения.

## Файлы

- `packages/desktop/apps/electron/src/main/extension-auto-update.ts` — функции
  `autoUpdateExtensions` / `scheduleExtensionAutoUpdate` (shell-out в vendored CLI
  `nessy extensions update --all` + фоновый таймер).
- `packages/desktop/apps/electron/src/main/index.ts` — импорт
  `scheduleExtensionAutoUpdate` и вызов в `whenReady` при старте приложения
  (guard `!isClientOnly`), с передачей ожидания first-run установки.

## Откат

1. Удалить `packages/desktop/apps/electron/src/main/extension-auto-update.ts`.
2. Удалить из `packages/desktop/apps/electron/src/main/index.ts`:
   - импорт `scheduleExtensionAutoUpdate`;
   - вызов `scheduleExtensionAutoUpdate(...)` в `whenReady`.
3. Убрать `// [nessy-fork] desktop-extension-auto-update` маркеры.
4. Удалить строку из `docs/fork-patches/README.md` и файл
   `docs/fork-patches/desktop-extension-auto-update.md`.

## Upstream

Не отправлен. Автообновление расширений через vendored CLI — fork-only поведение
корпоративной инсталляции Desktop.
