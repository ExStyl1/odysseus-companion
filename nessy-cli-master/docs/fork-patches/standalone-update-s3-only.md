# standalone-update-s3-only

## AIDT

-

## Зачем

Внутренний release pipeline публикует standalone-архивы, контрольные суммы и
подписи только в S3 по пути `nessy-cli/standalone/<version>/`, где версия
записывается без префикса `v`.

Upstream updater искал артефакты в Aliyun OSS и GitHub по пути с префиксом
`v`, поэтому автоматическое обновление завершалось ошибкой, хотя релиз был
успешно опубликован.

Патч использует только внутренний S3 для загрузки архива, `SHA256SUMS` и
опционального `SHA256SUMS.sig`.

## Файлы

- `packages/cli/src/utils/standalone-update.ts` — S3 URL и загрузка без fallback на GitHub или Aliyun OSS
- `packages/cli/src/utils/standalone-update.test.ts` — регрессионная проверка URL beta-релиза без префикса `v`

## Откат

1. Убедиться, что upstream updater поддерживает внутренний S3 release layout.
2. Удалить локальный S3 resolver и восстановить upstream-механизм загрузки.
3. Удалить регрессионный тест, маркеры `[nessy-fork] standalone-update-s3-only`, строку из реестра и этот файл.

## Upstream

Не отправлен.
