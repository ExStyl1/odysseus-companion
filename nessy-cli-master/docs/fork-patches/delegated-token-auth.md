# delegated-token-auth

## AIDT

- AIDT-5793; доработки: AIDT-7209, AIDT-8228.

## Зачем

Классический вход через `dp auth login` требует браузера и интерактивного
пользователя. Для CI, агентных запусков, sandbox-окружений и вообще любого
сценария, где браузер недоступен, нужен способ отдать CLI уже готовый токен.

`NESSY_CLI_DP_AUTH_TOKEN` — переменная окружения с делегированным JWT,
выпущенным Spirit IAM по схеме OAuth 2.0 Token Exchange. При её наличии CLI:

1. `tryAuthFromEnv()` (`dp-delegated-token.ts`) читает env. Нет переменной —
   возвращает `null`, и `performNessyAuth` идёт классическим путём.
2. Декодирует JWT (`decodeJwt`) и валидирует его: неразбираемый токен →
   `NESSY_CLI_DP_AUTH_TOKEN is invalid: <reason>`, `exp` в прошлом →
   `NESSY_CLI_DP_AUTH_TOKEN is expired`. Обе ошибки фатальны.
3. Собирает `DpCredentials` из `exp`, `sub` и `preferred_username`. В
   делегированных токенах Spirit IAM claim `preferred_username` не приходит,
   поэтому username может оказаться пустой строкой — это нормально, не ошибка.
4. Кладёт креды в in-memory кэш через `setTransientCredentialsInMemory` —
   в отличие от `saveCredentials`, запись на диск не делается. Сессия обязана
   жить ровно столько, сколько живёт токен.
5. Каталог моделей запрашивается из `performNessyAuth` (шаг 0), не отсюда:
   с `c1239f61b` `tryAuthFromEnv` не тянет `fetchModels` сам и не принимает
   `config`. Ошибка загрузки каталога не фатальна — авторизация остаётся.

**Ключевое отличие от классического потока — заголовок.** Nestor принимает две
схемы: `Nestor-Token: <jwt>` (oathkeeper `oauth2_introspection` против
`/api/v2/token/introspect`, работает только для токенов, выпущенных самим
Nestor через обмен) и `Authorization: Bearer <jwt>` (authenticator
`spirit_iam`, проверяет подпись по JWKS Spirit IAM, то есть для делегированных
токенов). `buildNestorAuthHeaders(jwt)` выбирает схему сравнением JWT с
`process.env['NESSY_CLI_DP_AUTH_TOKEN']`: Bearer уходит только если токен
буквально равен значению env. Сравнение, а не факт наличия переменной, —
иначе классический DP-JWT получил бы Bearer просто потому, что переменная
случайно осталась в окружении.

`buildNestorAuthHeaders` вызывают:
`openaiContentGenerator/provider/nestor.ts` (default headers),
`dp-models-client.ts` (каталог), `user-quota-client.ts` (квоты),
`error-client.ts` (репорт ошибок), `telemetry/nessy-dlh/dlh-client.ts`
(DLH) и `ui/commands/bugCommand.ts` (bug-report).

Автовыбор auth type делает `getAuthTypeFromEnv()` в
`packages/cli/src/utils/modelConfigUtils.ts`: `NESSY_CLI_DP_AUTH_TOKEN` даёт
`AuthType.DP_AUTH` раньше всех остальных env-признаков, так что диалог выбора
не показывается. Явный `--auth-type` и `security.auth.selectedType` из
settings по-прежнему приоритетнее env.

Пользовательская инструкция: [`docs-ru/users/work/features/delegated-token-auth.md`](../../docs-ru/users/work/features/delegated-token-auth.md).

## История

| Коммит      | Дата       | AIDT      | Что                                                                  |
| ----------- | ---------- | --------- | -------------------------------------------------------------------- |
| `21d51f444` | 2026-05-05 | AIDT-5793 | Env-байпас: `dpDelegatedToken.ts`, `nestorAuthHeader.ts`, wiring     |
| `0a33987bd` | 2026-07-30 | AIDT-7209 | `Config` в auth-функциях, версия CLI в `User-Agent`                  |
| `c1239f61b` | 2026-08-10 | AIDT-7392 | `tryAuthFromEnv` больше не тянет каталог моделей и не берёт `Config` |
| `251d2467c` | 2026-10-04 | AIDT-8228 | Переименование `dp/*` в kebab-case                                   |

## Файлы

- `packages/core/src/dp/dp-delegated-token.ts` — `tryAuthFromEnv`: чтение
  env, декодирование, валидация `exp`, сборка кредов.
- `packages/core/src/dp/nestor-auth-header.ts` — `buildNestorAuthHeaders`
  (Bearer против `Nestor-Token`). `wrapFetchWithNestorAuth` в том же файле
  принадлежит `dp-auth-anthropic-generator`.
- `packages/core/src/dp/dp-token-manager.ts` —
  `setTransientCredentialsInMemory`.
- `packages/core/src/dp/dp-auth-service.ts` — шаг 0 в `performNessyAuth`.
- `packages/core/src/dp/index.ts` — экспорт `buildNestorAuthHeaders`.
- `packages/cli/src/utils/modelConfigUtils.ts` — ветка env в
  `getAuthTypeFromEnv`.
- `packages/core/src/core/openaiContentGenerator/provider/nestor.ts`,
  `packages/core/src/dp/dp-models-client.ts`,
  `packages/core/src/dp/user-quota-client.ts`,
  `packages/core/src/dp/error-client.ts`,
  `packages/core/src/telemetry/nessy-dlh/dlh-client.ts`,
  `packages/cli/src/ui/commands/bugCommand.ts` — потребители
  `buildNestorAuthHeaders`.
- `docs-ru/users/work/features/delegated-token-auth.md` — пользовательская
  инструкция (добавлена тем же коммитом `21d51f444`).

Кодовые точки помечены `// [nessy-fork] delegated-token-auth` — один маркер на
файл, у первого fork-специфичного объявления.

## Откат

1. Удалить `dp-delegated-token.ts` и его тест, убрать шаг 0 из
   `performNessyAuth` и `tryAuthFromEnv` из barrel `dp/index.ts`.
2. Убрать `setTransientCredentialsInMemory` из `dp-token-manager.ts`.
3. Вернуть `Nestor-Token: <jwt>` во всех потребителях `buildNestorAuthHeaders`
   и удалить сам хелпер (учтя, что `wrapFetchWithNestorAuth` из
   `dp-auth-anthropic-generator` его использует).
4. Убрать ветку `NESSY_CLI_DP_AUTH_TOKEN` из `getAuthTypeFromEnv`.
5. Удалить `docs-ru/users/work/features/delegated-token-auth.md`, строку из
   `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен. Схема делегированного токена — внутренняя, требует Spirit IAM.
