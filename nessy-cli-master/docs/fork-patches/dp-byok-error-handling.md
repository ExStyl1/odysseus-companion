# dp-byok-error-handling

## AIDT

AIDT-8042

## Зачем

Использовать каталог `/api/v2/cli/models` и показывать сообщения ошибок бэка.
Обновлять токен только при ошибке авторизации Nestor, включая
`401 EUNAUTHORIZED` от шлюза; ошибки с
`X-Nestor-Error-Source: upstream` не запускают DP-login.

Если выбранная BYOK-модель исчезла из успешно загруженного каталога,
применяется штатный выбор дефолтной модели. При `X-Byok-Status: unavailable`
выбор сохраняется, генерация сообщает о временной недоступности до следующего `/auth`.
`/model` по-прежнему использует загруженный каталог.

Ошибки генерации не меняют модель. Для BYOK действуют стандартные правила
повторов SDK и CLI. При отображении сообщения бэка сохраняются данные ошибки,
нужные для повторов.

## Файлы

- `packages/core/src/dp/byok-policy.ts` — разбор ошибки авторизации и сообщения бэка.
- `packages/core/src/dp/dp-content-generator.ts` — SDK, авторизация и ошибки потока.
- `packages/core/src/dp/dp-models-client.ts` и `packages/core/src/core/openaiContentGenerator/constants.ts` — каталог v2 и его статус.
- `packages/core/src/config/config.ts` и `packages/core/src/models/modelsConfig.ts` — сохранение выбора при сбое каталога.
- `packages/core/src/core/baseLlmClient.ts` — запрет подмены вспомогательной BYOK-модели при ошибке.
- Соседние тесты `dp-anthropic-generator`, `dp-models-client`, `modelsConfig.dpauth`, `config`, `baseLlmClient` проверяют эти сценарии.

## Откат

Удалить точки с маркером `dp-byok-error-handling`, helper и проверки BYOK,
вернуть прежний endpoint каталога. Удалить запись реестра и этот документ.
При замене upstream-механизмом сохранить различение Nestor/upstream-ошибок
и тесты на число запросов.

## Upstream

Не отправлен. Контракт и авторизация относятся к Nestor.
Политика остаётся в `dp/`; общий механизм повторов не меняется.
