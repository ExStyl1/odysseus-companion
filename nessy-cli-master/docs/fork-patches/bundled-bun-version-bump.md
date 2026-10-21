# bundled-bun-version-bump

## AIDT

AIDT-7248

## Зачем

Bun `1.3.9` стабильно падает с segfault на macOS 26 (Tahoe):
`panic(main thread): Segmentation fault at address 0x13`. В десктопе это ломает
установку расширений — команда `cli.js extensions list --json` крашится,
маркетплейс расширений не грузится, плюс на том же рантайме ловятся таймауты
ACP (`initialize`) и refresh моделей.

Версия Bun была захардкожена в нескольких местах и разошлась: сборка сервера
(`packages/desktop/scripts/build/common.ts`) уже использовала `1.3.14`, а
electron-скрипты сборки дистрибутивов — DMG, Linux и Windows — оставались на
падающем `1.3.9`. Fork-patch поднимает пин в этих трёх скриптах до `1.3.14`,
выравнивая версию Bun на всех платформах.

Checksum-верификация не ломается: каждый скрипт тянет `SHASUMS256.txt` из
релиза той же версии (`${BUN_VERSION}` / `$BunVersion`).

Известный класс багов Bun на macOS 26:
https://github.com/oven-sh/bun/issues/24675

## Файлы

- `packages/desktop/apps/electron/scripts/build-dmg.sh`
- `packages/desktop/apps/electron/scripts/build-linux.sh`
- `packages/desktop/apps/electron/scripts/build-win.ps1`

## Откат

1. Убрать `[nessy-fork] bundled-bun-version-bump` маркеры из трёх скриптов.
2. Идеально — вынести версию Bun в единый источник истины (общий с
   `common.ts`), тогда этот патч становится не нужен: расхождения пинов между
   путями сборки больше не будет.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен (конфиг сборки форка).
