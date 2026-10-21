# headless-auto-classifier

## AIDT

AIDT-7563

## Зачем

В non-interactive режиме `--approval-mode=auto` write/execute-инструменты исключались синтетическим denylist ещё при создании registry. Из-за этого модель не могла вызвать их, runtime AUTO-классификатор не участвовал в решении, а внутренний отказ отображался как пользовательская отмена permission.

Патч оставляет инструменты доступными в headless AUTO и направляет все подходящие вызовы модели через runtime-классификатор без fast-path. Явный пользовательский `permissions.allow`, полностью покрывающий вызов, разрешает обычное действие без классификатора; записи в защищённые конфигурационные и instruction paths всегда проходят AUTO review. `permissions.deny` и `permissions.ask` сохраняют более высокий приоритет. Если классификатор запрещает действие или недоступен, вызов блокируется fail-closed с отдельным `auto_mode_blocked`, честным предупреждением в text mode и без записи в JSON `permission_denials` как пользовательского отказа. Client-initiated и управляющие вызовы сохраняют прежнее поведение.

## Файлы

- `packages/cli/src/config/config.ts` — не добавляет синтетический denylist для headless AUTO.
- `packages/cli/src/config/config.test.ts` — проверяет доступность classifier-gated tools и приоритет пользовательского deny.
- `packages/core/src/core/coreToolScheduler.ts` — направляет модельные вызовы headless AUTO в классификатор, кроме полностью совпавшего explicit allow для незащищённых действий, и блокирует fallback отдельным типом ошибки.
- `packages/core/src/core/coreToolScheduler.test.ts` — покрывает headless classifier flow, приоритет allow/deny, обязательный review защищённых записей, client-initiated исключение и ошибки блокировки.
- `packages/core/src/core/permissionFlow.ts` — передаёт совпадение explicit allow отдельно от итогового permission verdict.
- `packages/core/src/core/permissionFlow.test.ts` — проверяет передачу explicit allow.
- `packages/core/src/permissions/permission-manager.ts` — определяет полное совпадение active или AUTO-stashed allow-правила.
- `packages/core/src/permissions/permission-manager.test.ts` — проверяет stashed allow и полный охват compound shell-команд.
- `packages/core/src/permissions/autoMode.ts` — отключает fast-path при обязательной классификации.
- `packages/core/src/permissions/autoMode.test.ts` — проверяет обход fast-path для read/write tools.
- `packages/core/src/tools/tool-error.ts` — добавляет `AUTO_MODE_BLOCKED`.
- `packages/cli/src/utils/errors.ts` — выводит отдельное предупреждение AUTO без совета включить уже активный режим.
- `packages/cli/src/utils/errors.test.ts` — проверяет текст предупреждения.
- `packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.test.ts` — проверяет, что AUTO block не считается пользовательским permission denial.
- `docs/fork-patches/headless-auto-classifier.md` — описание патча.
- `docs/fork-patches/README.md` — запись в реестре.

## Откат

1. Вернуть синтетические deny для shell/monitor/edit/write в ветку `ApprovalMode.AUTO` non-interactive конфигурации.
2. Удалить обязательную headless-классификацию, explicit allow bypass и `requireClassifier`, вернув обычные AUTO fast-path.
3. Удалить `hasMatchingAllowRule` и `pmExplicitAllow` из permission flow.
4. Удалить `AUTO_MODE_BLOCKED` и отдельный CLI-рендеринг, снова используя общий `EXECUTION_DENIED`.
5. Удалить специфичные regression-тесты и маркеры `headless-auto-classifier`.
6. Удалить этот файл и строку из `docs/fork-patches/README.md`.

## Upstream

Не отправлен.
