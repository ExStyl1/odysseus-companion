# desktop-stable-update-channel

## AIDT

- AIDT-7190

## Зачем

Установленная beta-сборка Desktop сохраняла канал `beta` из встроенного
`app-update.yml` и не находила опубликованный stable-релиз в `latest*.yml`.
Из-за этого версия `0.13.0-beta.15` сравнивалась с устаревшей
`0.13.0-beta.14`, а обновление до `0.13.0` не предлагалось.

Патч при запуске явно переводит updater на канал `latest`. При публикации
stable-релиза те же metadata дополнительно загружаются под legacy
`beta*.yml`-именами, чтобы уже установленные beta-сборки получили переход на
stable даже до обновления runtime-логики.

## Файлы

- `packages/desktop/apps/electron/src/main/auto-update.ts` — выбор stable-канала при запуске updater
- `packages/desktop/scripts/upload.ts` — публикация stable metadata под legacy beta-именами
- `packages/desktop/apps/electron/src/main/__tests__/auto-update-channel.isolated.ts` — регрессионная проверка конфигурации updater

## Откат

1. Убедиться, что upstream поддерживает переход установленной beta-сборки на stable feed.
2. Удалить принудительный выбор `latest` и публикацию legacy beta-алиасов.
3. Удалить регрессионный тест, маркеры `[nessy-fork] desktop-stable-update-channel`, строку из реестра и этот файл.

## Upstream

Не отправлен.
