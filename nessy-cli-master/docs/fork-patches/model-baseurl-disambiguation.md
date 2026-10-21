# model-baseurl-disambiguation

## AIDT

-

## Зачем

`settings.model.name` недостаточно, когда в `settings.modelProviders` есть
несколько providers с одинаковым `id`, но разными `baseUrl`. Нужно сохранять
`model.baseUrl` как парный disambiguator для `model.name`, а при id-only
выборе очищать его empty-string tombstone-значением, чтобы stale значение из
нижележащего scope не выбирало другой endpoint при следующем запуске.

Auth pre-flight и runtime model resolution также должны искать provider по
паре `(modelId, baseUrl)`, чтобы проверять credentials/baseUrl именно для
выбранного endpoint.

DP Auth является исключением: его endpoint приходит вместе с runtime-каталогом
backend и не сохраняется в `settings.model.baseUrl`. При старте и `/auth`
устаревшее значение DP Auth удаляется из writable scopes, тогда как настройки
остальных providers не меняются.

## Файлы

- `packages/cli/src/config/auth.ts` — pre-flight auth lookup по
  `(model.name, model.baseUrl)`.
- `packages/cli/src/config/auth.test.ts` — regression на duplicate-id
  providers с разными `baseUrl`.
- `packages/cli/src/acp-integration/acpAgent.ts` — ACP `setCoreValue` очищает
  stale `model.baseUrl` при id-only записи `model.name`, не сохраняя
  endpoint DP Auth.
- `packages/cli/src/acp-integration/acpAgent.test.ts` — regression на очистку
  `model.baseUrl` из ACP settings API.
- `packages/cli/src/acp-integration/session/Session.ts` — session model switch
  очищает stale `model.baseUrl`, не сохраняя endpoint DP Auth.
- `packages/cli/src/acp-integration/session/Session.test.ts` — regression на
  session persistence.
- `packages/cli/src/ui/commands/modelCommand.ts` — `/model <id>` очищает
  stale `model.baseUrl`, а для DP Auth не записывает endpoint.
- `packages/cli/src/ui/commands/modelCommand.test.ts` — regression на
  slash-command persistence.
- `packages/cli/src/ui/components/ModelDialog.tsx` — picker сохраняет парный
  `model.baseUrl` для пользовательского provider, но не для DP Auth.
- `packages/core/src/providers/install.ts` — provider install сохраняет
  выбранный endpoint baseUrl или tombstone для id-only выбора.
- `packages/core/src/providers/__tests__/install.test.ts` — regressions на
  install-time запись `model.baseUrl`.
- `packages/core/src/models/modelsConfig.ts` — runtime switch/restore
  разрешает duplicate-id providers с учетом `baseUrl`.
- `packages/core/src/models/modelsConfig.test.ts` — regression на display name
  выбранного duplicate-id provider.

Кодовые точки помечены `// [nessy-fork] model-baseurl-disambiguation`.

## Откат

1. Убрать маркеры `model-baseurl-disambiguation`.
2. Удалить парную запись/очистку `model.baseUrl`, если upstream даст
   эквивалентный механизм provider identity.
3. Упростить auth/model lookup обратно до поиска только по model id, если
   duplicate-id providers больше не поддерживаются.

## Upstream

Не отправлен.
