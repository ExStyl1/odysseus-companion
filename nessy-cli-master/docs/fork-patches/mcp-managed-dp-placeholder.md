# mcp-managed-dp-placeholder

## AIDT

AIDT-7054

## Зачем

MCP-конфиги могут указывать `${NESSY_DP}` в поле `command`, чтобы запускать
бинарь `dp`, которым управляет Nessy CLI, независимо от пользовательского
`PATH`.

Переменная добавляется как значение по умолчанию в существующий `${VAR}`
resolver для расширений и settings. Если пользователь задал
`process.env.NESSY_DP`, используется его значение. Иначе `${NESSY_DP}`
резолвится через `getDpFilePath()` в `dp` на macOS/Linux или `dp.exe` на
Windows.

DP-бинарь и credentials используют `Storage.getGlobalNessyDir()`, поэтому
следуют за `NESSY_HOME` вместе с остальным глобальным состоянием Nessy.

## Файлы

- `eslint.legacy-filenames.mjs` — сохранение upstream-имени `dpConfig.ts` при
  проверке затронутого файла.
- `packages/core/src/dp/dp-config.ts` — DP-пути через `NESSY_HOME`.
- `packages/core/src/dp/dp-config.test.ts` — платформенные имена и
  `NESSY_HOME`.
- `packages/core/src/extension/extensionManager.ts` — default `NESSY_DP` для
  extension config.
- `packages/core/src/extension/extensionManager.test.ts` — подстановка и
  приоритет пользовательского env в расширениях.
- `packages/cli/src/config/settings.ts` — default `NESSY_DP` для settings.
- `packages/cli/src/config/settings.test.ts` — подстановка и приоритет
  пользовательского env в settings.
- `docs/users/configuration/settings.md` — документация и пример.
- `docs-ru/users/work/configuration/settings.md` — русская документация и
  пример.
- `docs/fork-patches/README.md` — запись в реестре fork-патчей.
- `docs/fork-patches/mcp-managed-dp-placeholder.md` — это описание.

## Откат

Если upstream примет эквивалентное решение, убрать defaults из
`extensionManager.ts` и `settings.ts`, вернуть DP-пути к upstream-реализации,
удалить специфичные тесты и документацию, строку из реестра и это описание.

## Upstream

Не отправлен.
