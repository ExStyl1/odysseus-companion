# extensions-install-options

## AIDT

-

## Зачем

Установка расширений из внутреннего npm-реестра требует передачи `--registry`
и опциональных флагов `--auto-update`, `--pre-release`, `--ref`. Upstream-код
принимает только строку с именем пакета, без опций.

Также добавлена поддержка relative redirects от npm registry endpoint —
артефактор может редиректить на `/artifactory/api/npm/...` относительно
текущего URL.

## Файлы

- `packages/cli/src/ui/commands/extensionsCommand.ts` — парсинг аргументов
  команды install, валидация опций.
- `packages/cli/src/ui/commands/extensionsCommand.test.ts` — тесты на парсинг
  опций и redact URL.
- `packages/core/src/extension/npm.ts` — функции `isRedirect`,
  `resolveRedirectUrl`, обработка relative redirects в `fetchNpmJson` и
  `downloadNpmFile`.
- `packages/core/src/extension/npm.test.ts` — тест на relative redirect.

Кодовые точки помечены `// [nessy-fork] extensions-install-options`.

## Откат

Если upstream примет эквивалентную функциональность:

1. Убрать `[nessy-fork]`-комментарии из `extensionsCommand.ts` и `npm.ts`.
2. Удалить или адаптировать `parseInstallArgs`, если upstream предоставит
   собственный парсер.
3. Удалить focused-тесты на локальный shape опций и redirect handling.
4. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
