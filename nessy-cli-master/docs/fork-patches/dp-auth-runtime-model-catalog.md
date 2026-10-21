# dp-auth-runtime-model-catalog

## AIDT

- AIDT-7392

## Зачем

Backend должен быть единственным источником доступных моделей DP Auth и их
служебных признаков. При старте CLI и после `/auth` свежий ответ полностью
заменяет runtime-каталог: удалённые модели исчезают, изменённые metadata и роли
обновляются, а пустой список очищает старое состояние и завершает refresh
типизированной ошибкой.

`modelProviders.dp-auth` игнорируется при загрузке и удаляется из User и
Workspace settings. Каталог не читается из `dp_auth_creds.json` и не пишется
обратно в `settings.json`; пользователь не может переопределить `internal`,
`alias`, `fastOnly`, `visualOnly` и другие backend-controlled поля. В settings
сохраняются только выбранные `model.name`, `fastModel` и `visualModel`, причём
после refresh они проверяются по актуальным ролям и корректируются.

DP Auth `baseUrl` также остаётся runtime metadata и не сохраняется в
`model.baseUrl`. Глобальные пользовательские `samplingParams` продолжают
применяться поверх metadata модели. Модели и настройки остальных providers не
изменяются.

## Файлы

- `packages/cli/src/acp-integration/acpAgent.ts`
- `packages/cli/src/acp-integration/session/Session.ts`
- `packages/cli/src/auth/providerConfig.ts`
- `packages/cli/src/config/config.test.ts`
- `packages/cli/src/config/config.ts`
- `packages/cli/src/core/auth.test.ts`
- `packages/cli/src/core/initializer.test.ts`
- `packages/cli/src/core/initializer.ts`
- `packages/cli/src/serve/workspace-providers-status.ts`
- `packages/cli/src/ui/auth/useAuth.test.ts`
- `packages/cli/src/ui/auth/useAuth.ts`
- `packages/cli/src/ui/commands/modelCommand.test.ts`
- `packages/cli/src/ui/commands/modelCommand.ts`
- `packages/cli/src/ui/components/ModelDialog.test.tsx`
- `packages/cli/src/ui/components/ModelDialog.tsx`
- `packages/cli/src/ui/models/availableModels.test.ts`
- `packages/cli/src/ui/models/availableModels.ts`
- `packages/cli/src/utils/modelConfigUtils.test.ts`
- `packages/cli/src/utils/modelConfigUtils.ts`
- `packages/core/src/config/config.test.ts`
- `packages/core/src/config/config.ts`
- `packages/core/src/dp/dp-auth-service.ts`
- `packages/core/src/dp/dp-delegated-token.test.ts`
- `packages/core/src/dp/dp-delegated-token.ts`
- `packages/core/src/dp/dp-errors.ts`
- `packages/core/src/dp/dp-models-client.ts`
- `packages/core/src/models/modelRegistry.ts`
- `packages/core/src/models/modelsConfig.dpauth.test.ts`
- `packages/core/src/models/modelsConfig.ts`
- `packages/core/src/providers/__tests__/provider-config.test.ts`
- `packages/core/src/providers/presets/dp-auth.ts`
- `packages/core/src/providers/provider-config.ts`

Кодовые точки помечены
`// [nessy-fork] dp-auth-runtime-model-catalog`.

## Откат

1. Убрать маркеры `dp-auth-runtime-model-catalog`.
2. Вернуть upstream-механизм владения и хранения каталога DP Auth, если он
   обеспечивает точную синхронизацию с backend и защищает служебные metadata.
3. Удалить runtime-валидацию primary/fast/visual и исключение для `baseUrl`,
   если upstream предоставляет эквивалентное поведение.
4. Удалить или адаптировать регрессионные тесты.
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
