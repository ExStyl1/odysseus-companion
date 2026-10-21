# dlh-acp-agent-request

## AIDT
AIDT-8378

## Зачем
ACP-путь (Desktop, `nessy serve` → `Session.prompt`) вызывает
`GeminiChat.sendMessageStream()` напрямую, минуя обёртку
`GeminiClient.sendMessageStream()` (client.ts), где для TUI устанавливается
DLH-контекст корреляции (`runWithDlhCorrelation`) и эмитится событие
`agent_request` для main-агента. Из-за этого Desktop-запуски:
- не попадают в `nessy_cli_agent_request_log` (нет request-событий main-агента);
- их inference/tool_call события не коррелируют по session_id/prompt_id.

Фикс: в `Session.#executePrompt` выставляем DLH-контекст через
`captureDlhCorrelation` + `runWithDlhCorrelation` (promptId выводится из
sessionId и turn), а в `#executePromptInner` эмитим `logDlhAgentRequest`
для main-агента — симметрично TUI-пути. Retry-запросы (как и
`SendMessageType.Retry` в TUI) agent_request не создают.

## Файлы
- `packages/cli/src/acp-integration/session/Session.ts` — DLH-контекст + эмит agent_request
- `packages/cli/src/acp-integration/session/Session.test.ts` — тесты эмита (user query / retry)

## Откат
1. Убрать `runWithDlhCorrelation`-обёртку и `logDlhAgentRequest`-эмит из `Session.ts`
2. Вернуть вычисление promptId внутрь `#executePromptInner`
3. Удалить тесты и этот файл fork-patch

## Upstream
Не отправлен. Внутренняя фича наблюдаемости DLH (см. dlh-telemetry, dlh-launch-metadata).
