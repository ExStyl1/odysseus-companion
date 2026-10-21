# error-client

## AIDT

- AIDT-5320, AIDT-5430, AIDT-5606; смежные правки: AIDT-5591, AIDT-5793, AIDT-7209, AIDT-8228.

## Зачем

Upstream CLI пишет ошибки только в отладочный лог на машине пользователя. При
падениях у сотрудников компании этот лог никто не забирает, и диагностировать
проблему по описанию в тикете невозможно. Нужен автоматический репорт в
`POST /api/v1/cli/errors` бэкенда Nestor
(`DEFAULT_NESTOR_ERROR_URL` в `core/openaiContentGenerator/constants.ts`).

`ErrorClient` (`packages/core/src/dp/error-client.ts`) — singleton с очередью:

- `reportError(error, cliVersion, model?, additionalInfo?)` кладёт элемент в
  очередь и сразу возвращает управление. Очередь ограничена `MAX_QUEUE_SIZE = 2`;
  при переполнении вытесняется самый старый элемент, а не самый новый, — при
  шторме ошибок важнее показать последнюю, то есть текущую, а не первую.
- `processQueue()` защищён флагом `isProcessing` и рассылает элементы без
  `await`. Отправка — fire-and-forget с `keepalive: true`, чтобы запрос успел
  уйти, даже если процесс CLI завершается; сетевые ошибки глушатся в
  `debugLogger`, никогда не всплывая в основной поток.
- Тело — `CLIErrorReport` с `message`, `stacktrace`, `cli_version`, `model` и
  `metadata`. `normalizeMetadata` приводит все значения метаданных к строкам
  (числа и булевы через `String()`, объекты через `JSON.stringify`, при
  исключении — `'[object]'`), потому что бэкенд объявляет поле как
  `map[string]string` и на нестроковых значениях отклоняет запрос целиком.
- Авторизация: `getValidCredentials()` даёт JWT, заголовок строится
  `buildNestorAuthHeaders(jwt)`. Плюс всегда `Content-Type` и
  `User-Agent: NessyCLI/<cliVersion> (<platform>; <arch>)`.
- Методы `getQueueSize`, `clearQueue`, `static resetInstance` существуют ради
  тестов.

Репорт включается только при явном разрешении: `reportError` из
`utils/errorReporting.ts` вызывает `ErrorClient` лишь если
`config.getTelemetryErrorReportEnabled()` истинно, а это
`telemetry.errorReportEnabled` из settings (по умолчанию `true`, при этом
независимо от основной телеметрии — как `dlhEnabled` и `statistEnabled`).

Два типа точек вызова:

- Общий путь — `utils/errorReporting.ts`; через него приходят `core/client.ts`,
  `core/baseLlmClient.ts`, `core/turn.ts`, `goals/goalJudge.ts`,
  `agents/runtime/agent-core.ts`.
- Прямой вызов — `utils/toolCallParser/jsonParser.ts`: ошибки разбора JSON
  вызова инструмента репортятся из парсера напрямую, чтобы метаданные содержали
  `context`/`parseStage` и усечённый `payloadPreview` (первые 200 символов).

## История

| Коммит      | Дата       | AIDT      | Что                                                                      |
| ----------- | ---------- | --------- | ------------------------------------------------------------------------ |
| `f6f60bc6d` | 2026-03-22 | AIDT-5320 | `services/ErrorClient.ts`: очередь, гейт, `telemetry.errorReportEnabled` |
| `8de3072bc` | 2026-03-26 | AIDT-5430 | Переезд в `dp/`, заголовок `Nestor-Token` из `getValidCredentials()`     |
| `3503e8c8a` | 2026-04-04 | AIDT-5591 | Косметика (пробелы)                                                      |
| `22474e970` | 2026-04-15 | AIDT-5606 | `normalizeMetadata`; `metadata` сужены до `Record<string, string>`       |
| `21d51f444` | 2026-05-05 | AIDT-5793 | Заголовок через `buildNestorAuthHeaders` (Bearer для env-токена)         |
| `0a33987bd` | 2026-07-30 | AIDT-7209 | `User-Agent: NessyCLI/<version> (<platform>; <arch>)`                    |
| `251d2467c` | 2026-10-04 | AIDT-8228 | Переименование `ErrorClient.ts` → `error-client.ts`                      |

Часть изначальных точек вызова отвалилась при upstream-синках
(`439066c86`, upstream 0.15.10; `2f32d5d46`, upstream 0.16): `tools/edit.ts`,
`tools/todoWrite.ts`, `core/geminiChat.ts` и `subagents/subagent.ts` больше
`ErrorClient` не вызывают. `utils/toolCallParser.ts` был разбит на пакет
`utils/toolCallParser/` — импорт переехал в `jsonParser.ts`.

## Файлы

- `packages/core/src/dp/error-client.ts` — сам клиент.
- `packages/core/src/utils/errorReporting.ts` — гейт
  `getTelemetryErrorReportEnabled()` и вызов из общего пути.
- `packages/core/src/utils/toolCallParser/jsonParser.ts` — прямой вызов из
  парсера.
- `packages/core/src/config/config.ts` — `errorReportEnabled` в
  `TelemetrySettings` и `getTelemetryErrorReportEnabled()`.
- `packages/cli/src/config/settingsSchema.ts` — `telemetry.errorReportEnabled`
  (`showInDialog: false`).
- `packages/vscode-ide-companion/schemas/settings.schema.json` — зеркальная
  схема для VS Code.
- `packages/core/src/core/openaiContentGenerator/constants.ts` —
  `DEFAULT_NESTOR_ERROR_URL`.

Кодовые точки помечены `// [nessy-fork] error-client` — один маркер на файл, у
первого fork-специфичного объявления.

## Откат

1. Удалить `packages/core/src/dp/error-client.ts` вместе с тестом.
2. Убрать вызов из `utils/errorReporting.ts` и оба вызова из
   `utils/toolCallParser/jsonParser.ts`.
3. Удалить `telemetry.errorReportEnabled` из `settingsSchema.ts`,
   `vscode-ide-companion/schemas/settings.schema.json`, `errorReportEnabled` и
   `getTelemetryErrorReportEnabled()` из `config.ts`.
4. Удалить `DEFAULT_NESTOR_ERROR_URL` из `constants.ts`, если он больше не
   используется (bug-report использует `DEFAULT_NESTOR_BUG_REPORT_URL`).
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен. Адресат репорта — внутренний Nestor.
