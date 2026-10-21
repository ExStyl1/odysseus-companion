# dp-auth-anthropic-generator

## AIDT

AIDT-8040

## Зачем

DP Auth раньше отправлял все модели через OpenAI Chat Completions. Модели с
`protocol: anthropic_messages` из каталога бэка должны использовать Anthropic
Messages с той же DP-авторизацией и стандартным переключением модели.

Патч передаёт `protocol` через настройки модели и scoped-агентов. По протоколу
выбирается генератор и маршрут бэка: `/api/v1/cli/anthropic/v1/messages` либо
существующий OpenAI endpoint. Отсутствующий протокол означает OpenAI;
неизвестный протокол отклоняется. При смене модели обновляются генератор и URL,
история сохраняется в общем внутреннем формате.

Оба транспорта берут актуальный DP-токен перед запросом: `Nestor-Token` либо
delegated Bearer. Заголовки `X-Api-Key` и `X-Byok-Key` из конфигурации удаляются;
личный ключ провайдера должен добавлять бэк. Anthropic использует существующие
конвертеры ответов, SSE и инструментов. Прямой режим Anthropic сохраняется.

## Файлы

- `packages/core/src/core/contentGenerator.ts` — тип протокола.
- `packages/core/src/models/types.ts` — протокол в настройках модели.
- `packages/core/src/models/constants.ts` — перенос протокола при разрешении настроек.
- `packages/core/src/dp/dp-models-client.ts` — протокол и URL из каталога бэка.
- `packages/core/src/core/openaiContentGenerator/constants.ts` — Anthropic URL бэка.
- `packages/core/src/dp/dp-content-generator.ts` — выбор генератора и общая DP-авторизация.
- `packages/core/src/dp/nestor-auth-header.ts` — актуальные заголовки DP для обоих SDK.
- `packages/core/src/core/openaiContentGenerator/provider/nestor.ts` — подключение общей обёртки авторизации.
- `packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts` — передача настроенного DP SDK-клиента.
- `packages/core/src/config/config.ts` — обновление протокола, URL и их sources без потери JWT.
- `packages/core/src/models/modelsConfig.ts` — выбор протокола зарегистрированной модели и сброс для OpenAI fallback.
- `packages/core/src/dp/dp-anthropic-generator.test.ts` — транспорт, авторизация, SSE, tools, отмена и смена протоколов.
- `packages/core/src/dp/dp-content-generator.test.ts` — прежний тест удалён и заменён транспортными проверками выше.
- `packages/core/src/dp/dp-models-client.test.ts` — каталог и маршруты.
- `packages/core/src/config/config.test.ts` — переключение протокола с сохранением JWT.
- `packages/core/src/models/modelsConfig.test.ts` — возврат к зарегистрированной DP-модели.
- `packages/core/src/models/content-generator-config.test.ts` — протокол scoped-модели.

Кодовые точки помечены `// [nessy-fork] dp-auth-anthropic-generator`.
Локальный стенд в `.nessy/scripts/` — вспомогательная утилита, в патч не входит.

## Откат

При появлении эквивалентного механизма upstream:

1. Заменить DP-делегирование, передачу протокола и выбор URL механизмом upstream,
   сохранив маршруты нашего бэка и DP-авторизацию.
2. Удалить ставшие ненужными внедрение Anthropic SDK-клиента и обёртку fetch,
   если upstream обеспечивает актуальные DP-заголовки и исключает ключи провайдера.
3. Адаптировать транспортные тесты; сохранить проверки OpenAI, Anthropic,
   переключения модели и scoped-агентов.
4. Удалить маркеры, строку реестра и этот файл. Соседние патчи каталога моделей,
   model-switch-generation-fields не откатывать.

## Upstream

Не отправлен. Интеграция с внутренней DP-авторизацией и бэком Nessy.
