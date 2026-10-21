# qwen-oauth-discontinued-removal

## AIDT

- AIDT-8380; предыстория: AIDT-5956.

## Зачем

Upstream блокирует новые входы через Qwen OAuth и выбор его моделей сообщением
`Qwen OAuth free tier was discontinued`. В Nessy этот механизм заменён
корпоративным DP Auth: ограничения бесплатного сервиса Qwen не должны
применяться к внутреннему провайдеру.

Предварительные проверки убраны из CLI и VS Code companion:

- `validateAuthMethod(DP_AUTH)` возвращает `null`, не требуя env-переменных
  и не выдавая ошибку о прекращении free tier. Проверки остальных методов
  авторизации сохранены.
- `main()` в `gemini.tsx` не добавляет discontinued-предупреждение в
  `startupWarnings`.
- `ModelDialog` не скрывает модели по признаку discontinued, не подменяет
  описание подсказкой миграции и не блокирует выбор до `config.switchModel`.
  Проверка сохранённых credentials при смене провайдера остаётся.
- `ModelSelector` в Companion показывает описание от агента и передаёт выбор
  мышью или Enter в `onSelectModel` без проверки OAuth-суффикса model ID.
- `SessionMessageHandler.handleSetModel` вызывает
  `agentManager.setModelFromUi`, не отклоняя выбор локально. Ошибки ACP
  по-прежнему показываются пользователю.

Обработка реального серверного отказа об исчерпании квоты в
`packages/core/src/utils/retry.ts`, соответствующий разбор в
`utils/errorParsing.ts` и строки переводов сохранены. Авторизация через DP,
каталог моделей и ограничения ролей описаны отдельными патчами: `dp-auth`,
`dp-auth-runtime-model-catalog`, `model-alias-fast`, `model-alias-visual`.

## История

| Коммит      | Дата       | AIDT      | Что                                                                                  |
| ----------- | ---------- | --------- | ------------------------------------------------------------------------------------ |
| `cec8e3656` | 2026-04-28 | AIDT-5956 | Удалены discontinued-метки и блокировка выбора в `ModelDialog`, обновлены auth-тесты |
| `8c13a1afd` | 2026-07-10 | —         | Удалена блокировка в `SessionMessageHandler` и хелпер `discontinuedModel` с тестами  |

К моменту синка `8c13a1afd` (upstream 0.19.1) в `config/auth.ts`, `gemini.tsx`
и `ModelSelector.tsx` этих ограничений также нет.

## Файлы

- `packages/cli/src/config/auth.ts` — `validateAuthMethod`: DP Auth проходит
  валидацию без free-tier ограничения.
- `packages/cli/src/gemini.tsx` — сборка `startupWarnings` без предупреждения
  о прекращении OAuth.
- `packages/cli/src/ui/components/ModelDialog.tsx` — список, подписи и
  `handleSelect` без discontinued-фильтра и запрета выбора.
- `packages/vscode-ide-companion/src/webview/components/layout/ModelSelector.tsx`
  — `handleModelSelect`, обработчик Enter и отображение моделей.
- `packages/vscode-ide-companion/src/webview/handlers/SessionMessageHandler.ts`
  — `handleSetModel`, передача выбора агенту без локального запрета.

Кодовые точки помечены `// [nessy-fork] qwen-oauth-discontinued-removal` — один
маркер на файл, у соответствующей точки интеграции.

## Откат

При появлении эквивалентного поведения в upstream:

1. Принять upstream-валидацию в `config/auth.ts` и сборку предупреждений в
   `gemini.tsx`, если они допускают корпоративный DP Auth.
2. Снять форк-отличия в списке и выборе моделей: `ModelDialog`,
   `ModelSelector`, `SessionMessageHandler.handleSetModel`. Не возвращать
   запрет по OAuth-типу, если upstream уже перестал его применять.
3. Сохранить регрессионные тесты, проверяющие доступность DP Auth и передачу
   выбранной модели агенту; адаптировать их к интерфейсам upstream.
4. Удалить маркеры, строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен. Адаптация ограничений публичного Qwen OAuth к корпоративному
DP Auth.
