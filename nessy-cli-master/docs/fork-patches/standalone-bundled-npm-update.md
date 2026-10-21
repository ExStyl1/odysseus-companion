# standalone-bundled-npm-update

## AIDT

AIDT-6479

## Зачем

Standalone установка запускается через Node, который лежит внутри bundle. При
автообновлении нельзя брать глобальный `npm` из `PATH`: он может поставить
`@nestor/nessy-cli` в prefix пользовательского или системного Node, а не в
standalone bundle.

Патч распознает standalone по текущему `process.execPath`, CLI path внутри того
же root и `manifest.json`, после чего обновляет только npm-пакет внутри
bundled Node prefix. Инсталятор с S3 и переустановка Node runtime не
используются.

## Файлы

- `packages/cli/src/utils/installationInfo.ts` — детект standalone layout и
  команда обновления через bundled Node/npm с `--prefix <installRoot>/node`.
- `packages/cli/src/utils/installationInfo.test.ts` — регрессии на первичный
  standalone bundle, повторный запуск после обновления и fallback при чужом
  Node.
- `packages/cli/src/utils/handleAutoUpdate.test.ts` — регрессия, что
  `@latest` в standalone-команде заменяется на найденную версию.

Кодовые точки помечены `// [nessy-fork] standalone-bundled-npm-update`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать standalone-specific детект и команду обновления или заменить их на
   upstream-реализацию.
2. Убрать `[nessy-fork]`-комментарии.
3. Удалить или адаптировать focused-тесты на standalone update.
4. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
