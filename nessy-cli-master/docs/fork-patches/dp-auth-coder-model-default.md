# dp-auth-coder-model-default

## AIDT

- AIDT-7009
- AIDT-7044

## Зачем

При старте CLI и повторной авторизации выбранная пользователем основная модель
сбрасывалась на первую или default-модель сервера.

Fast модели предназначены только для быстрых операций (через `getFastModel()`),
а не для основного чата. Поэтому выбранная пользователем основная модель
сохраняется. Некоторые доступные для основного чата модели приходят от DP Auth
без alias, поэтому явный выбор такой модели тоже сохраняется. Модели с alias
`fast`, `visual` либо `voice`, а также с соответствующим флагом основными быть
не могут. Если выбранная модель больше недоступна, выбирается default
coder-модель, затем любая coder-модель. Если backend не вернул ни одной
доступной основной модели, refresh завершается ошибкой вместо установки
несуществующей заглушки.

До загрузки серверного списка стартовый resolver сохраняет модель из `--model`
или `settings.json` без проверки alias. Та же логика применяется при `/auth`,
чтобы install plan не подменял текущую модель первой моделью сервера.
Если серверная валидация при старте заменяет недоступную модель на coder
fallback, выбранный fallback сохраняется обратно в scope активного model
provider. Сам каталог моделей остаётся runtime-only и описан отдельным патчем
`dp-auth-runtime-model-catalog`.

**Связь с model-alias-fast:** Этот фикс обеспечивает корректную работу
существующего патча `model-alias-fast` (AIDT-6471, AIDT-6543) — гарантирует,
что coder модель действительно используется как основная по умолчанию, а fast
модели не подменяют её при обновлении каталога.

## Файлы

- `packages/cli/src/core/initializer.ts` — сохранение startup fallback в
  настройки.
- `packages/cli/src/core/initializer.test.ts` — тест сохранения startup
  fallback.
- `packages/cli/src/ui/auth/useAuth.test.ts` — тест сохранения модели при
  `/auth`.
- `packages/core/src/config/config.ts` — приоритеты выбора основной модели
  после DP Auth refresh.
- `packages/core/src/config/config.test.ts` — тесты сохранения и fallback
  основной модели.
- `packages/core/src/dp/dp-models-client.ts` — перенос серверного признака
  `default`.
- `packages/core/src/dp/dp-models-client.test.ts` — тест переноса `default`.
- `packages/core/src/models/modelConfigResolver.ts` — сохранение CLI/settings
  модели до серверной валидации.
- `packages/core/src/models/modelConfigResolver.test.ts` — тесты отложенной
  валидации.
- `packages/core/src/models/modelRegistry.ts` — сохранение `default` в
  доступных моделях.
- `packages/core/src/models/modelRegistry.test.ts` — тест переноса `default` и
  выбора coder-модели.
- `packages/core/src/models/modelsConfig.ts` — временная startup-заглушка
  до серверной валидации.
- `packages/core/src/models/types.ts` — серверный признак `default` в типах
  моделей.

Кодовые точки помечены `// [nessy-fork] dp-auth-coder-model-default`.

## Откат

Если upstream примет эквивалентный фикс:

1. Убрать `[nessy-fork] dp-auth-coder-model-default` комментарии.
2. Удалить fork-логику сохранения модели и выбора coder fallback, если её
   полностью заменяет upstream.
3. Удалить или адаптировать регрессионные тесты.
4. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
