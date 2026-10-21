# statist-trusted-ca

## AIDT

AIDT-7426

## Зачем

Statist использует TLS-цепочку с `Russian Trusted Root CA`, которой может не
быть в системном хранилище пользователя и нет в основном корпоративном
`tinkoff-bundle.crt`. Без неё отправка событий завершается ошибкой
`SELF_SIGNED_CERT_IN_CHAIN`.

Сборка скачивает отдельный `russian-root-ca.crt` с внутреннего сервиса
`ca-certs.tcsbank.ru`, проверяет его fingerprint и поставляет рядом с основным
bundle. CLI и Desktop загружают оба файла программно. Внешний
`NODE_EXTRA_CA_CERTS` сохраняется, но не отключает встроенные CA. Statist
использует общий Undici transport, чтобы bundled CA и proxy применялись к его
запросам.

## Файлы

- `packages/core/src/telemetry/statistClient.ts`
- `packages/core/src/telemetry/statistClient.test.ts`
- `packages/cli/src/bootstrap.ts`
- `packages/cli/src/bootstrap.test.ts`
- `packages/desktop/apps/electron/src/main/desktop-ca.ts`
- `packages/desktop/apps/electron/src/main/network-proxy.ts`
- `packages/desktop/apps/electron/src/main/__tests__/desktop-ca.test.ts`
- `scripts/download-certs.js`
- `scripts/create-standalone-package.js`
- `.gitlab-ci.yml`

## Откат

1. Вернуть Statist на стандартный `fetch` без runtime dispatcher.
2. Удалить загрузку, проверку и упаковку `russian-root-ca.crt`.
3. Вернуть CLI и Desktop к загрузке только `tinkoff-bundle.crt`.
4. Удалить тесты двух CA-файлов, маркеры, строку реестра и этот файл.

## Upstream

Не отправлен. Исправление зависит от внутреннего центра сертификации и
endpoint Statist.
