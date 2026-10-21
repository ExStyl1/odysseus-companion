# model-alias-visual

## AIDT

- AIDT-6997

## Зачем

Visual модель должна настраиваться отдельно от основной и fast модели. Vision
bridge сначала использует явно настроенную `visualModel`, затем fallback-поиск
image-capable модели на подходящем provider/endpoint. Для DP_AUTH backend может
передавать `alias: visual`; до этого временно hardcoded модель
`tgpt/qwen35-397b-a17b-fp8-vl` получает visual alias на клиенте.

Ключевые правила:

- `visualModel` хранится в settings и пробрасывается в core `Config`.
- `/model --visual` открывает отдельный selector и пишет `visualModel`, не
  меняя основную модель.
- `visualOnly` модели скрыты из main/fast/voice списков, но доступны в visual
  selector и vision bridge.
- Vision bridge предпочитает configured visual model перед fallback-поиском.
- Scoped visual запросы передают `authType` и `baseUrl`, чтобы не уйти в
  endpoint текущего auth type при одинаковом model id.
- Модели с суффиксом `-vl` считаются image-capable.

## Файлы

- `packages/cli/src/acp-integration/acpAgent.ts` — скрытие visual-only моделей
  из ACP списка.
- `packages/cli/src/config/config.ts` — проброс `visualModel` из settings.
- `packages/cli/src/config/settingsSchema.ts` — настройка `visualModel`.
- `packages/cli/src/config/settingsSchema.test.ts` — тест настройки
  `visualModel`.
- `packages/cli/src/core/initializer.ts` — синхронизация auto-selected
  `visualModel` после DP_AUTH.
- `packages/cli/src/ui/AppContainer.tsx` — состояние visual model dialog.
- `packages/cli/src/ui/auth/useAuth.ts` — синхронизация visual модели после
  auth.
- `packages/cli/src/ui/commands/modelCommand.ts` — `/model --visual` и
  фильтрация `visualOnly`.
- `packages/cli/src/ui/commands/modelCommand.test.ts` — тесты visual selector и
  `visualOnly`.
- `packages/cli/src/ui/commands/types.ts` — dialog action `visual-model`.
- `packages/cli/src/ui/components/DialogManager.tsx` — открытие visual model
  dialog из settings.
- `packages/cli/src/ui/components/ModelDialog.tsx` — visual selector и scoped
  сохранение модели.
- `packages/cli/src/ui/components/ModelDialog.test.tsx` — тесты visual selector.
- `packages/cli/src/ui/contexts/UIActionsContext.tsx` — флаг открытия visual
  selector.
- `packages/cli/src/ui/contexts/UIStateContext.tsx` — состояние visual selector.
- `packages/cli/src/ui/hooks/slashCommandProcessor.ts` — обработка
  `dialog: visual-model`.
- `packages/cli/src/ui/hooks/slashCommandProcessor.test.ts` — тест
  `dialog: visual-model`.
- `packages/cli/src/ui/hooks/useModelCommand.ts` — режим visual selector.
- `packages/cli/src/ui/hooks/useModelCommand.test.ts` — тест режима visual
  selector.
- `packages/core/src/config/config.ts` — `visualModel`, auto-select by alias,
  configured vision bridge model.
- `packages/core/src/config/config.test.ts` — тесты DP_AUTH visual alias и
  configured vision bridge model.
- `packages/core/src/core/baseLlmClient.ts` — scoped side queries с
  `authType`/`baseUrl`.
- `packages/core/src/core/modalityDefaults.ts` — распознавание `-vl` моделей
  как image-capable.
- `packages/core/src/core/openaiContentGenerator/provider/dashscope.ts` —
  `-vl` как vision-capable модель.
- `packages/core/src/core/openaiContentGenerator/provider/nestor.ts` — `-vl`
  как vision-capable модель.
- `packages/core/src/dp/dp-models-client.ts` — `visualOnly` из backend alias и
  временный visual alias для qwen35-vl.
- `packages/core/src/dp/dp-models-client.test.ts` — тесты `alias: visual` и
  временного qwen35-vl fallback.
- `packages/core/src/models/modelRegistry.ts` — propagation `visualOnly` и
  проверка only-флагов.
- `packages/core/src/models/modelRegistry.test.ts` — тесты `visualOnly`.
- `packages/core/src/models/modelsConfig.ts` — lookup resolved model с учетом
  `baseUrl` для scoped visual side queries.
- `packages/core/src/models/types.ts` — `visualOnly` в model types.
- `packages/core/src/services/visionBridge/vision-bridge-service.ts` —
  configured visual model, `visualOnly`, scoped side query.
- `packages/core/src/services/visionBridge/vision-bridge-service.test.ts` —
  тесты configured visual model и scoped bridge query.
- `packages/core/src/utils/sideQuery.ts` — проброс `authType`/`baseUrl` в side
  query.

Кодовые точки помечены `// [nessy-fork] model-alias-visual`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать `[nessy-fork] model-alias-visual` комментарии.
2. Удалить временный client-side fallback для
   `tgpt/qwen35-397b-a17b-fp8-vl`, когда backend начнет передавать
   `alias: visual`.
3. Удалить или адаптировать тесты на visual selector, `visualOnly` и scoped
   vision bridge.
4. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
