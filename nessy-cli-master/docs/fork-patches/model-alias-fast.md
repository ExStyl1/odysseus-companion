# model-alias-fast

## AIDT

- AIDT-6471
- AIDT-6543

## Зачем

Поддержка семантических алиасов и отдельного fast-селектора моделей (`coder`,
`fast`) вместо жесткой привязки к конкретным ID. Пользователь или
backend задает семантическую роль модели, а CLI выбирает актуальную модель из
доступных для текущего типа авторизации.

Для DP_AUTH модели загружаются в runtime с сервера и могут меняться со
временем. Алиасы позволяют сохранять стабильные роли независимо от конкретных
model id.

Ключевые правила:
- Алиас `coder` → кандидат основной модели DP_AUTH
- Алиас `fast` → быстрая модель для генерации кода
- Для не-DP_AUTH авторизаций fast модель не устанавливается автоматически
- При переключении с DP_AUTH на другой тип, fast модель очищается, если она была из DP_AUTH
- При обновлении списка моделей, старая fast модель заменяется на новую с алиасом `fast`
- **В TUI модели с алиасом `fast` скрыты из основного списка выбора (`/model`)**
- **В режиме `/model --fast` показываются только модели с алиасом `fast`**
- **В ACP режиме fast-модели скрыты из списка доступных моделей**

## Файлы

- `packages/cli/src/acp-integration/acpAgent.ts` — скрытие fast-only моделей из ACP списка
- `packages/cli/src/core/initializer.ts` — синхронизация fast модели в settings
  после startup DP_AUTH
- `packages/cli/src/ui/auth/useAuth.ts` — синхронизация fast модели после runtime refresh
- `packages/cli/src/ui/commands/modelCommand.ts` — `/model --fast` и фильтрация fast-only моделей
- `packages/cli/src/ui/commands/modelCommand.test.ts` — тесты model command для fast-only моделей
- `packages/cli/src/ui/components/ModelDialog.tsx` — fast selector
- `packages/cli/src/ui/components/ModelDialog.test.tsx` — тесты fast selector
- `packages/core/src/config/config.ts` — авто-выбор fast/coder по alias и `fastModel`
- `packages/core/src/config/config.test.ts` — тесты DP_AUTH fast alias
- `packages/core/src/dp/dp-auth-service.ts` — загрузка моделей DP_AUTH при аутентификации
- `packages/core/src/dp/dp-models-client.ts` — alias/fastOnly из backend
- `packages/core/src/dp/dp-models-client.test.ts` — тесты alias fast
- `packages/core/src/models/modelRegistry.ts` — propagation `fastOnly`, проверка only-флагов
- `packages/core/src/models/modelRegistry.test.ts` — тесты `fastOnly`
- `packages/core/src/models/types.ts` — `alias` и `fastOnly` в model types

Кодовые точки помечены `// [nessy-fork] model-alias-fast`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать `[nessy-fork]`-комментарии из типов и логики выбора моделей.
2. Удалить или адаптировать тесты на fast/coder алиасы и fast selector.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
