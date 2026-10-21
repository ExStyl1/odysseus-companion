# dp-auth

## AIDT

- Базовый слой без отдельного тикета; доработки: AIDT-5319, AIDT-5427, AIDT-5529, AIDT-5956, AIDT-6172, AIDT-7209, AIDT-7428, AIDT-8228.

## Зачем

Upstream nessy-cli не умеет корпоративную авторизацию через внутренний `dp`
CLI (Spirit CLI). Для работы с внутренними моделями Nestor нужен вход через
`dp`, обмен полученного DP-токена на JWT Nestor и передача этого JWT в запросы
к бэку `code-completion-nestor.tcsbank.ru`.

Поток `performNessyAuth` (`dp-auth-service.ts`):

1. `dp auth print-token` из управляемого бинарника в `~/.nessy/dp_latest`.
2. Если токена нет — `dp auth login` (браузер; в WSL `BROWSER=wslview`), затем
   повторный `print-token`. Вызовы single-flight (`tokenRequest`,
   `performDpAuthRequest` в `dp-auth-manager.ts`).
3. Обмен DP-токена на JWT: `POST /api/v2/token` с `Authorization: Bearer
<dp-token>`, `X-Request-Id`, `User-Agent: NessyCLI/<version>`.
4. Декодирование JWT (`preferred_username`, `sub`, `exp`) без `jsonwebtoken`.
5. JWT сохраняется в общий OAuth-стор `~/.nessy/oauth_creds.json` через
   `cacheNessyCredentials` (ошибка записи фатальна).
6. Каталог моделей `/api/v1/cli/models` (не фатально на этом шаге).

`Config.refreshAuth(DP_AUTH)` кладёт JWT в `generationConfig.apiKey`, username
— в `generationConfig.username`, и создаёт content generator.

`dp_auth_creds.json` в рантайме CLI больше не пишется: `saveCredentials`,
`saveDpModelsCache`, `getCachedModels` из `dp-token-manager.ts` не имеют
продакшн-вызовов. Читается только in-memory/файловый кэш через
`getValidCredentials()` (`dp-models-client`, `error-client`). Файл по-прежнему
готовят CI и деплой: `.ci/bootstrap_nestor_openai_env.sh`,
`deploy/async/entrypoint.sh`, `deploy/async/.nessy/dp_auth_creds.json`,
`integration-tests/test-helper.ts`, `integration-tests/cli/acp-integration.test.ts`.

### Провайдеры в `/auth`

Upstream-диалог `AuthDialog.tsx` предлагает три группы: Alibaba ModelStudio
(`coding-plan`, `token-plan`, `alibaba-standard`), Third-party Providers
(`deepseek`, `minimax`, `zai`, `idealab`, `modelscope`, `openrouter`,
`requesty`) и Custom Provider. В форке главное меню сведено к двум пунктам
(`MainOption = 'DP_AUTH' | 'API_KEY'`):

- «DP Authentication» — `handleProviderSubmit(dpAuthProvider, …)`, без шагов
  настройки.
- «API Key» — только `customProvider` (OpenAI-совместимый endpoint), и он
  скрыт по умолчанию: показывается при `security.auth.showApiKeyOption: true`
  или флаге `--show-api-key-option` (`ModelsConfig.getShowApiKeyOption()`,
  default `false`, AIDT-5319).

Подменю `alibaba-select` / `thirdparty-select`, `providerToItem` и
`handleProviderSelect` удалены. Дефолтная базовая ссылка для OpenAI-протокола
(`getDefaultBaseUrlForProtocolInternal`, placeholder в `ProviderSetupSteps.tsx`)
заменена с `api.openai.com` на внутренний `llm-proxy.t-tech.team/v1`.

Пресеты при этом не удалены физически: файлы `providers/presets/*` и
`ALL_PROVIDERS` в `core/providers/all-providers.ts` совпадают с upstream.
Поэтому Alibaba и third-party провайдеры по-прежнему видны вне TUI:

- ACP `nessy/providers/list` и `nessy/providers/connect`
  (`acp-integration/acpAgent.ts`) отдают весь `ALL_PROVIDERS`;
- каталог `serve/server.ts` (`buildAuthProviderCatalog`) и
  `run-nessy-serve.ts` (`findProviderById`);
- `useProviderUpdates.ts` проверяет обновления по всем провайдерам.

VS Code companion фильтрует список до `dp-auth` и `custom` сам (патч
`vscode-internal-companion`). Desktop onboarding (`ProviderSelectStep.tsx`)
убрал только группу Alibaba (`7a995da8e`), third-party и custom там остались.

Верхние слои (каталог моделей, Anthropic/OpenAI генератор, алиасы, квоты,
бинарный lifecycle, delegated env-токен, ErrorClient) описаны отдельными
патчами.

## История

Базовый слой вошёл в текущую линию одним коммитом `ef84dadd4` (2026-03-13,
«merge original 0.12.1», фактически не merge — один родитель). Он добавил
`packages/core/src/dp/*` (в camelCase: `dpApi.ts`, `dpAuthManager.ts`,
`dpAuthService.ts`, `dpConfig.ts`, `dpDownloader.ts`, `dpErrors.ts`,
`dpTokenExchangeClient.ts`, `dpTokenManager.ts`, `jwtDecoder.ts`,
`wslDetection.ts`, `index.ts`, `dpModelsClient.ts`, `dpContentGenerator.ts`),
провайдер `nestor.ts`, `DpAuthProgress.tsx`, пункт «DP Authentication» в
`AuthDialog.tsx`, ветки в `useAuth.ts`, `config/auth.ts`, `authMethods.ts`.
Ранняя миграционная ветка (`90ec1c2f7`, `01144da3b`, `54dde4a37` и др.) не
является предком HEAD — это предыстория.

| Коммит      | Дата       | AIDT      | Что                                                                      |
| ----------- | ---------- | --------- | ------------------------------------------------------------------------ |
| `ef84dadd4` | 2026-03-13 | —         | Базовый слой `dp/`, Nestor-провайдер, UI DP Authentication               |
| `247891ca3` | 2026-03-22 | AIDT-5319 | `showApiKeyOption`: пункт API Key в `/auth` скрыт по умолчанию           |
| `3fda24fce` | 2026-03-26 | AIDT-5427 | Модель по умолчанию из ответа бэка                                       |
| `9a2885523` | 2026-03-31 | AIDT-5529 | Фикс первого запуска и первого логина                                    |
| `cec8e3656` | 2026-04-28 | AIDT-5956 | Удалён устаревший вариант DP Auth из `auth` handler и `ModelDialog`      |
| `f3c96e7e1` | 2026-05-24 | AIDT-6172 | Автообновление `dp`, MCP-команды `dp` на bundled-бинарник                |
| `7a995da8e` | 2026-07-11 | —         | Группа Alibaba убрана из Desktop onboarding, дефолт OpenAI → `llm-proxy` |
| `0a33987bd` | 2026-07-30 | AIDT-7209 | `Config` в auth-функциях, версия CLI в `User-Agent`                      |
| `85420903e` | 2026-08-11 | AIDT-7428 | Удалён `forcedAuth`, статистика авторизации в `core/auth.ts`             |
| `251d2467c` | 2026-10-04 | AIDT-8228 | Переименование `dp/*` в kebab-case                                       |

Пришло с upstream-синками, а не из этого патча: `core/authType.ts` и
device-flow `dp-auth` в `serve/` (`8c13a1afd`, upstream 0.19.1),
`providers/presets/dp-auth.ts` и регистрация `dpAuthProvider`
(`2f32d5d46`, AIDT-6255, upstream 0.16), legacy-субкоманда `dp-auth` в
`commands/auth.ts` (`5125ac2f5`, AIDT-5305; `439066c86`, AIDT-6166).

## Файлы

Маркер `// [nessy-fork] dp-auth` стоит один раз на файл — у первого
fork-специфичного объявления (в CLI — у ветки `DP_AUTH`). Файлы `dp/`
целиком принадлежат патчу, поэтому строки внутри не размечаются.

Собственные файлы механизма:

- `packages/core/src/dp/dp-auth-service.ts` — оркестрация `performNessyAuth`.
- `packages/core/src/dp/dp-auth-manager.ts` — `prepareAuth` с ретраем через
  `removeDp`, `getToken`/`login`, single-flight `performDpAuth`.
- `packages/core/src/dp/dp-token-exchange-client.ts` — `exchangeToken`,
  `POST /api/v2/token`, таймаут 30 с, 401 → `TokenExchangeFailed`.
- `packages/core/src/dp/jwt-decoder.ts` — base64url-декодирование пейлоада.
- `packages/core/src/dp/dp-token-manager.ts` — `DpCredentials`, in-memory кэш,
  `getValidCredentials`; запись `dp_auth_creds.json` осталась только как API.
- `packages/core/src/dp/wsl-detection.ts` — `WSL_DISTRO_NAME`/`WSLENV`,
  наличие `wslview`.
- `packages/core/src/dp/dp-errors.ts` — `DpAuthError`, `DpAuthServiceError`.
- `packages/core/src/dp/dp-config.ts` — `DP_CONFIG` (версия, аргументы `dp`,
  таймауты, URL скачивания, md5), пути в `~/.nessy`.
- `packages/core/src/dp/index.ts` — barrel; `DpContentGenerator` намеренно не
  экспортируется (циклический импорт).

Точки интеграции в CLI:

- `packages/cli/src/config/auth.ts` — `validateAuthMethod(DP_AUTH)` не
  требует env-переменных.
- `packages/cli/src/acp-integration/authMethods.ts` — ACP-метод
  `--auth-type=dp-auth`.
- `packages/cli/src/ui/auth/AuthDialog.tsx`, `useAuth.ts` — меню
  `DP_AUTH | API_KEY` вместо групп Alibaba/Third-party/Custom, отмена через
  `cancelNessyAuth`.
- `showApiKeyOption`: `cli/src/config/settingsSchema.ts`
  (`security.auth.showApiKeyOption`), `cli/src/config/config.ts`
  (`--show-api-key-option`), `cli/src/utils/modelConfigUtils.ts`,
  `core/src/core/contentGenerator.ts`, `core/src/config/config.ts`,
  `core/src/models/modelsConfig.ts`.
- `packages/core/src/providers/provider-config.ts`,
  `packages/cli/src/ui/auth/ProviderSetupSteps.tsx` — дефолтный OpenAI
  base URL `llm-proxy.t-tech.team/v1`.
- `packages/desktop/apps/electron/src/renderer/components/onboarding/ProviderSelectStep.tsx`
  — без группы Alibaba.
- `packages/cli/src/ui/components/DpAuthProgress.tsx`, `DialogManager.tsx` —
  спиннер вместо device-flow: браузерный флоу принадлежит `dp`.
- `packages/cli/src/ui/hooks/useNessyAuth.ts` — гейт по `AuthType.DP_AUTH`.
- `packages/cli/src/core/auth.ts` — `performInitialAuth`, статистика
  (`dp-auth-single-startup-auth`).
- `packages/cli/src/core/initializer.ts` — принудительная авторизация на старте
  (`performInitialAuth`, маркер `dp-auth-single-startup-auth`).
- `packages/cli/src/utils/modelConfigUtils.ts` — `getAuthTypeFromEnv`: `DP_AUTH`
  при `DP_AUTH` или `NESSY_CLI_DP_AUTH_TOKEN`.

Разделяемые файлы, где код помечен маркерами других патчей:

- `packages/core/src/dp/dp-api.ts`, `dp-downloader.ts`, `dp-updater.ts`,
  `packages/cli/src/core/initializer.ts` (`ensureDpBinary`) →
  `dp-binary-lifecycle`.
- `packages/core/src/dp/dp-models-client.ts`, `providers/presets/dp-auth.ts`,
  `dp-errors.ts` (`ModelsUnavailable`) → `dp-auth-runtime-model-catalog`.
- `packages/core/src/dp/dp-delegated-token.ts`, `buildNestorAuthHeaders` в
  `nestor-auth-header.ts` → `delegated-token-auth`;
  `wrapFetchWithNestorAuth` там же → `dp-auth-anthropic-generator`.
- `packages/vscode-ide-companion/src/webview/handlers/AuthMessageHandler.ts`
  (фильтр `dp-auth` + `custom`) → `vscode-internal-companion`.
- `packages/core/src/config/config.ts` (`refreshAuth(DP_AUTH)`) →
  `dp-auth-runtime-model-catalog`, `dp-auth-coder-model-default`,
  `model-alias-fast`, `model-alias-visual`, `dlh-non-dp-auth-telemetry`.

## Откат

1. Удалить ветку `refreshAuth(DP_AUTH)` из `config.ts` и `performNessyAuth`
   вместе с модулем `packages/core/src/dp/` (после отката зависящих патчей).
2. Убрать `DP_AUTH` из `config/auth.ts`, `authMethods.ts`, `AuthDialog.tsx`,
   `useAuth.ts`, `useNessyAuth.ts`, `modelConfigUtils.ts`, удалить
   `DpAuthProgress.tsx` и ветку в `DialogManager.tsx`.
3. Вернуть upstream-меню `AuthDialog.tsx` (Alibaba ModelStudio /
   Third-party / Custom), удалить `showApiKeyOption` из settings, CLI-флага,
   `modelConfigUtils.ts`, `ContentGeneratorConfig` и `ModelsConfig`; вернуть
   группу Alibaba в Desktop onboarding и `api.openai.com` как дефолтный
   base URL.
4. Upstream-части (`AuthType.DP_AUTH`, `dpAuthProvider`, device-flow в
   `serve/`, legacy-notice) откатывать вместе с соответствующим синком.
5. Убрать подготовку `dp_auth_creds.json` из `.ci/` и `deploy/async/`.

## Upstream

Не отправлен. Интеграция с внутренней корпоративной авторизацией `dp`.
